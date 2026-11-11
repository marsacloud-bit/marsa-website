/* ==========================================================================
   مرسى | MARSA — legacy step 9 «استيراد بيانات النظام القديم»  →  #legacy_import (MarsaOps.views.legacy_import)
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_IMPORT_AR.md (20261125000100: legacy_import_* RPCs, MarsaApi.legacyImport*).
   A ONE-OFF import run by the org OWNER (an admin membership without a branch, aal2 on the server) from the tenant's own
   export of the legacy Google Sheets (.xlsx / .csv). Nothing is fetched from Google.

   * The files are read in the browser (up to 20 files, each ≤ 10 MB): XlsxLite (assets/js/xlsx-lite.js) with read limits
     (64 MB inflated, 50 000 rows, 256 columns; cached cell values only — a formula is never evaluated), CSV / TSV through
     XlsxLite.decodeText + parseDelimited. The cells are untrusted text: every lookup keyed by file text uses
     Object.create(null) maps, only the dictionary's field keys are sent, data is shown with textContent only.
   * Each sheet's entity is detected by its name, then by the best overlap of its legacy Arabic headers with
     legacyImportDictionary() (folded the same way as the server's app.li_key); the owner can change the entity and any
     column mapping before staging. A local pre-check marks rows that cannot be sent (a value over 2000 characters, a row
     over 16 KB) and shows what the server will also check (required fields, container shape, dates in Asia/Riyadh).
   * Steps: create the run (reason, default branch, options) → stage in chunks (≤ 500 rows, ≤ ~1.8 MB per call; re-staging
     the same rows is a no-op on the server) → validate (loop until done) → review (counts per entity / status, messages,
     per-row list, skip rows, mapping of unknown ports / service items / clients / branches, XLSX / CSV error report) →
     commit (confirmation, chunked, resumable: a timeout halves the chunk and retries — committed rows are never written twice)
     → result + the RHK- step (queue the step-7 read-only invoice lookups; candidates open the transaction's existing step-7
     visual confirm / link flow — nothing is linked automatically) → void (dry run first: the blockers are listed).
   * Long work runs under MarsaShell.progress (the step-8 overlay); «إيقاف» stops after the current chunk.
   * Imports never approve or verify anything (payments land pending review, aliases suggested, no empty-return proof,
     no billing intent, no Daftra draft): the server enforces it, the page says it.
   * Pure helpers on MarsaOps.legacyImport (tests). Strings: 'limp' (assets/i18n/limp.js). ES5, textContent only.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var VERSION = 'limp-1';
  var ENTITIES = ['customers', 'aliases', 'drivers', 'transactions', 'containers', 'movements', 'payments', 'custody'];
  var ROW_STATUSES = ['pending', 'valid', 'warning', 'error', 'duplicate', 'committed', 'skipped'];
  var RUN_STATUSES = ['draft', 'staged', 'validated', 'committing', 'committed', 'voiding', 'voided'];
  var OPEN = { draft: 1, staged: 1, validated: 1, committing: 1, voiding: 1 };
  var REPORT_STATUSES = ['error', 'warning', 'duplicate', 'skipped'];
  var FUNDING = ['org_account', 'cash_box', 'fasah_wallet', 'dry_port_wallet_org', 'client_custody', 'client_custody_dry_port', 'personal_account'];
  var MOVEMENT_TYPES = ['org_paid', 'received_from_client', 'client_direct'];
  var MAP_KINDS = ['ports', 'service_items', 'clients', 'branches'];
  // the row message codes that a mapping entry resolves → [mapping kind, the data fields holding the legacy text]
  var MAP_HINTS = {
    port_unknown: ['ports', ['port']], service_item_unknown: ['service_items', ['service_item']],
    client_not_found: ['clients', ['importer', 'client_name', 'name_ar']], client_ambiguous: ['clients', ['importer', 'client_name', 'name_ar']],
    branch_unknown: ['branches', ['branch']]
  };
  var LIMITS = {
    files: 20, fileBytes: 10 * 1024 * 1024, inflateBytes: 64 * 1024 * 1024, rowsPerSheet: 50000, cols: 256, headerScan: 10, sheetsPerFile: 50,
    stageRows: 500, rowBytes: 16384, callBytes: 1800000, valueChars: 2000, runRows: 50000, previewRows: 8, listPage: 100, reportCap: 50000,
    validateLimit: 300, commitLimit: 100, voidLimit: 200, minLimit: 5, retries: 6, busyWaitMs: 1500, mapEntries: 500, mapKeyChars: 200, sheetChars: 120
  };
  var TONES = { pending: 'neutral', valid: 'success', warning: 'warning', error: 'danger', duplicate: 'info', committed: 'success', skipped: 'neutral',
    draft: 'neutral', staged: 'info', validated: 'info', committing: 'warning', voiding: 'warning', voided: 'neutral' };

  /* ------------------------------------------------------------------ strings */
  function lang() { var I = window.MarsaI18n; return I && typeof I.lang === 'function' ? I.lang() : 'ar'; }
  function isEn() { return lang() === 'en'; }
  function interp(s, vars) { return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s; }
  function lt(k, vars) {
    var I = window.MarsaI18n, key = 'limp.' + k;
    if (I && typeof I.t === 'function') { var s = I.t(key, vars); if (s != null && s !== key) return s; }
    var D = window.MarsaLimpDict || {}, d = (D[lang()] || {})[k];
    if (d == null) d = (D.ar || {})[k];
    return d == null ? k : interp(d, vars);
  }
  function own(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  // a server label {code: {ar, en}} (legacyImportDictionary().labels), else the page's own 'limp.<prefix><code>'
  function srvLabel(labels, domain, code, prefix) {
    var d = labels && own(labels, domain) ? labels[domain] : null, x = d && own(d, code) ? d[code] : null;
    if (x && (x.ar || x.en)) return (isEn() && x.en) || x.ar || x.en;
    var k = prefix + code, s = lt(k);
    return s === k ? String(code) : s;
  }

  /* ------------------------------------------------------------------ pure: text */
  function str(v) { return v == null ? '' : String(v).replace(/[ \s]+/g, ' ').trim(); }
  function western(v) {
    return String(v == null ? '' : v).replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
  }
  // a header / sheet name / legacy text folded like the server's app.li_key (app.legacy_search_key + '—–ـ%()' removed):
  // western digits, lower case, أ إ آ → ا, ة → ه, ى → ي, no spaces _ / \ . - — – ـ % ( ); harakat dropped too
  function fold(v) {
    return western(v).toLowerCase().replace(/[ً-ٰٟ​-‏‪-‮⁦-⁩﻿]/g, '')
      .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/[\s_\/\\.\-—–ـ%()]+/g, '');
  }
  function utf8Len(s) {
    s = String(s);
    if (typeof TextEncoder !== 'undefined') { try { return new TextEncoder().encode(s).length; } catch (e) { /* count below */ } }
    var n = 0;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xD800 && c <= 0xDBFF) ? (i++, 4) : 3; }
    return n;
  }
  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  /* ------------------------------------------------------------------ pure: dates (Asia/Riyadh wall time, never the device zone) */
  // a legacy date / time → 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM' (Riyadh wall time, as the server's app.li_ts / app.li_date read it)
  // accepted: an Excel serial (the fraction = the time), dd/mm/yyyy or d-m-yyyy or yyyy-mm-dd [hh:mm[:ss]] [ص|م|AM|PM], ISO with
  // Z / an offset (shown in Riyadh), Arabic-Indic digits; a year outside 1990–2100 (e.g. a Hijri year) → ''
  function normDate(v) {
    var s = str(western(v)).replace(/[‎‏؜]/g, '');
    if (!s) return '';
    var m, y, mo, d, hh = null, mi = null;
    var n = /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
    if (isFinite(n) && n > 20000 && n < 80000) {
      var ms = Math.round((n - 25569) * 86400000), dt = new Date(ms);   // the serial is wall time: read it as UTC, never shifted
      y = dt.getUTCFullYear(); mo = dt.getUTCMonth() + 1; d = dt.getUTCDate();
      if (n % 1) { hh = dt.getUTCHours(); mi = dt.getUTCMinutes(); }
    } else if ((m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(s))) {
      // an instant with a zone → the Riyadh wall time (UTC+3, no DST)
      var off = m[6].toUpperCase() === 'Z' ? 0 : (m[6][0] === '-' ? -1 : 1) * (Number(m[6].slice(1, 3)) * 60 + Number(m[6].replace(':', '').slice(3, 5)));
      var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - off * 60000 + 3 * 3600000, r = new Date(t);
      y = r.getUTCFullYear(); mo = r.getUTCMonth() + 1; d = r.getUTCDate(); hh = r.getUTCHours(); mi = r.getUTCMinutes();
    } else {
      var rest = '';
      if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(.*)$/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; rest = m[4]; }
      else if ((m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(.*)$/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; }
      else return '';
      rest = str(rest.replace(/^T/, ' '));
      if (/^(م|ad)$/i.test(rest)) rest = '';   // «07/11/2026 م» = ميلادي (app.li_date strips it too)
      if (rest) {
        var tm = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(ص|م|am|pm|a\.m\.|p\.m\.)?$/i.exec(rest);
        if (!tm) return '';
        hh = +tm[1]; mi = +tm[2];
        var ap = (tm[3] || '').toLowerCase().replace(/\./g, '');
        if (ap === 'م' || ap === 'pm') { if (hh < 12) hh += 12; } else if ((ap === 'ص' || ap === 'am') && hh === 12) hh = 0;
        if (hh > 23 || mi > 59) return '';
      }
    }
    if (!(y >= 1990 && y <= 2100) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return '';
    var chk = new Date(Date.UTC(y, mo - 1, d));
    if (chk.getUTCMonth() !== mo - 1) return '';   // 31/02 etc.
    var out = y + '-' + pad(mo) + '-' + pad(d);
    return hh == null ? out : out + ' ' + pad(hh) + ':' + pad(mi);
  }
  // today as YYYY-MM-DD in Asia/Riyadh
  function riyadhToday(now) {
    var dt = now == null ? new Date() : new Date(+now);
    return new Date(dt.getTime() + 3 * 3600000).toISOString().slice(0, 10);
  }

  /* ------------------------------------------------------------------ pure: containers (ISO 6346, as the server's warning) */
  function containerNo(v) { return western(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function iso6346Ok(c) {
    if (!/^[A-Z]{4}\d{7}$/.test(c)) return false;
    var vals = {}, n = 10;
    for (var i = 0; i < 26; i++) { if (n % 11 === 0) n++; vals[String.fromCharCode(65 + i)] = n; n++; }
    var sum = 0;
    for (var j = 0; j < 10; j++) { var ch = c.charAt(j); sum += (j < 4 ? vals[ch] : +ch) * Math.pow(2, j); }
    return (sum % 11) % 10 === +c.charAt(10);
  }
  // a cell may hold several numbers (comma, new line, Arabic comma, «و», spaces)
  function containerList(v) {
    return western(v).toUpperCase().split(/[,،;\n\r|\/]+|\s+و\s+/).map(function (x) { return x.replace(/[^A-Z0-9]/g, ''); }).filter(Boolean);
  }

  /* ------------------------------------------------------------------ pure: dictionary + detection */
  // legacyImportDictionary().entities → {list, byEntity}; folded headers → field key (first field wins), prototype-free maps
  function dictIndex(dict) {
    var src = dict && Array.isArray(dict.entities) ? dict.entities : (Array.isArray(dict) ? dict : []);
    var list = [], byEntity = Object.create(null);
    src.forEach(function (e) {
      if (!e || ENTITIES.indexOf(e.entity) === -1 || byEntity[e.entity]) return;
      var byHeader = Object.create(null), fields = [], keys = Object.create(null);
      (Array.isArray(e.fields) ? e.fields : []).forEach(function (f) {
        if (!f || typeof f.key !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(f.key) || keys[f.key]) return;
        keys[f.key] = 1;
        var heads = (Array.isArray(f.headers) ? f.headers : []).filter(function (h) { return typeof h === 'string' && h; });
        var alt = (Array.isArray(f.alt) ? f.alt : []).filter(function (a) { return typeof a === 'string' && /^[a-z][a-z0-9_]{0,40}$/.test(a); });
        fields.push({ key: f.key, required: f.required === true, alt: alt, headers: heads, label: heads[0] || f.key });
        heads.forEach(function (h) { var k = fold(h); if (k && !byHeader[k]) byHeader[k] = f.key; });
      });
      var ent = { entity: e.entity, order: +e.order || (ENTITIES.indexOf(e.entity) + 1), sheets: (Array.isArray(e.sheets) ? e.sheets : []).map(fold).filter(Boolean),
        fields: fields, byHeader: byHeader, keys: keys, required: fields.filter(function (f) { return f.required; }).map(function (f) { return f.key; }),
        alt: fields.reduce(function (a, f) { if (f.required && f.alt.length) a[f.key] = f.alt; return a; }, Object.create(null)) };
      byEntity[e.entity] = ent; list.push(ent);
    });
    list.sort(function (a, b) { return a.order - b.order; });
    return { list: list, byEntity: byEntity };
  }
  function fieldOf(ent, key) { for (var i = 0; ent && i < ent.fields.length; i++) if (ent.fields[i].key === key) return ent.fields[i]; return null; }
  // how well one row matches an entity's headers → {score (distinct keys), required (required keys found)}
  function scoreRow(row, ent) {
    var seen = Object.create(null), score = 0, req = 0;
    (row || []).forEach(function (cell) {
      var k = fold(cell), key = k ? ent.byHeader[k] : null;
      if (key && !seen[key]) { seen[key] = 1; score++; if (ent.required.indexOf(key) !== -1) req++; }
    });
    return { score: score, required: req };
  }
  function sheetEntity(name, idx) {
    var k = fold(name);
    if (!k) return null;
    for (var i = 0; i < idx.list.length; i++) {
      var e = idx.list[i];
      for (var j = 0; j < e.sheets.length; j++) if (k === e.sheets[j] || k.indexOf(e.sheets[j]) === 0) return e;
    }
    return null;
  }
  // one sheet → {entity, by: 'sheet' | 'headers' | null, headerRow (0-based, -1 = none), score}
  function detectSheet(name, rows, idx) {
    rows = Array.isArray(rows) ? rows : [];
    var byName = sheetEntity(name, idx), lim = Math.min(rows.length, LIMITS.headerScan), best = null;
    for (var i = 0; i < lim; i++) {
      var cands = byName ? [byName] : idx.list;
      for (var j = 0; j < cands.length; j++) {
        var s = scoreRow(rows[i], cands[j]);
        if (!s.score) continue;
        // more matched headers wins; then more required headers; then the earlier row; then the entity order
        if (!best || s.score > best.score || (s.score === best.score && s.required > best.required)) best = { entity: cands[j].entity, headerRow: i, score: s.score, required: s.required };
      }
    }
    if (byName) return { entity: byName.entity, by: 'sheet', headerRow: best ? best.headerRow : -1, score: best ? best.score : 0 };
    if (best && best.score >= 2 && best.required >= 1) return { entity: best.entity, by: 'headers', headerRow: best.headerRow, score: best.score };
    return { entity: null, by: null, headerRow: best ? best.headerRow : -1, score: best ? best.score : 0 };
  }
  // the header cells → [{index, header, key, auto, dup}] (first column per key wins; a later one is left unmapped)
  function mapColumns(headerCells, ent) {
    var used = Object.create(null);
    return (headerCells || []).map(function (h, i) {
      var key = ent ? ent.byHeader[fold(h)] || null : null, dup = false;
      if (key && used[key]) { dup = true; key = null; }
      if (key) used[key] = 1;
      return { index: i, header: str(h), key: key, auto: !!key, dup: dup };
    });
  }
  // a manual override: column i → key (or null); a key taken by another column moves here
  function setColumn(columns, i, key) {
    return columns.map(function (c) {
      if (c.index === i) return { index: c.index, header: c.header, key: key || null, auto: false, dup: false };
      if (key && c.key === key) return { index: c.index, header: c.header, key: null, auto: false, dup: c.dup };
      return c;
    });
  }
  function missingRequired(columns, ent) {
    if (!ent) return [];
    var have = Object.create(null);
    columns.forEach(function (c) { if (c.key) have[c.key] = 1; });
    // a required field is also satisfied by its server-side alternative («تسلسل المعاملة» for «رقم المعاملة», «كود العميل في دفترة»
    // for «المستورد» / «اسم العميل», the English name for the Arabic one)
    return ent.required.filter(function (k) { return !have[k] && !altOf(ent, k).some(function (a) { return have[a]; }); });
  }

  function altOf(ent, k) { return (ent && ent.alt && ent.alt[k]) || []; }

  /* ------------------------------------------------------------------ pure: rows */
  function cellText(v) {
    if (v == null) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v).replace(/^[\s ﻿]+|[\s ﻿]+$/g, '');
  }
  // the data rows under the header → {rows [{row_no, data}], rejected [{row_no, code, field?}], empty}
  // row_no = the sheet row number (1-based). data has the dictionary keys only (a prototype-free object).
  function buildRows(rows, headerRow, columns) {
    var out = [], rejected = [], empty = 0, mapped = columns.filter(function (c) { return c.key; });
    for (var i = headerRow + 1; i < (rows || []).length; i++) {
      var r = rows[i] || [], data = Object.create(null), n = 0, bad = null;
      for (var j = 0; j < mapped.length; j++) {
        var v = cellText(r[mapped[j].index]);
        if (v === '') continue;
        if (v.length > LIMITS.valueChars) { bad = { code: 'too_long', field: mapped[j].key }; break; }
        data[mapped[j].key] = v; n++;
      }
      if (bad) { rejected.push({ row_no: i + 1, code: bad.code, field: bad.field }); continue; }
      if (!n) { if (r.some(function (x) { return cellText(x) !== ''; })) empty++; continue; }
      if (utf8Len(JSON.stringify(data)) > LIMITS.rowBytes) { rejected.push({ row_no: i + 1, code: 'row_bytes' }); continue; }
      out.push({ row_no: i + 1, data: data });
    }
    return { rows: out, rejected: rejected, empty: empty };
  }
  // the date fields the server reports, with its level and code (app.li_check_*: declaration_date / created_at / return_deadline /
  // returned_at are warnings, appointment_at / paid_at errors); other date-like fields are read by the server without a message
  var DATE_RULES = { declaration_date: ['warning', 'invalid_date'], created_at: ['warning', 'invalid_datetime'], appointment_at: ['error', 'invalid_datetime'],
    return_deadline: ['warning', 'invalid_date'], returned_at: ['warning', 'invalid_date'], paid_at: ['error', 'invalid_date'] };
  // skipping a parent row makes its dependent rows fail at validation (the server looks the parent up in the run): entity → dependents
  var SKIP_DEPENDENTS = { customers: { ents: ['aliases', 'transactions', 'custody'], code: 'client_not_found' },
    transactions: { ents: ['containers', 'movements', 'payments'], code: 'transaction_not_found' } };
  function skipWarnings(entities) {
    var seen = Object.create(null), out = [];
    (entities || []).forEach(function (e) { if (SKIP_DEPENDENTS[e] && !seen[e]) { seen[e] = 1; out.push({ entity: e, dependents: SKIP_DEPENDENTS[e].ents, code: SKIP_DEPENDENTS[e].code }); } });
    return out;
  }
  // the files recorded on a new run: only those with at least one sheet that is staged (a file whose sheets are all «تجاهل» is not sent)
  function runFiles(parsed, sheets) {
    var used = Object.create(null);
    (sheets || []).forEach(function (s) { if (s && s.include && s.entity) used[s.fileIdx] = 1; });
    return (parsed || []).map(function (f, i) { return { f: f, i: i }; }).filter(function (x) { return x.f && !x.f.error && used[x.i]; })
      .map(function (x) { var f = x.f; return { name: f.name.slice(0, 255), sha256: f.sha256, size: f.size, sheets: f.sheets.map(function (s) { return s.name.slice(0, 120); }).slice(0, 50) }; });
  }
  // the stepper of a run status → {done: steps before it, current: the step index or -1}. Committed: everything through «الترحيل» is
  // done and «الربط بدفترة» is the optional next step (not current); voiding / voided: no current step
  function stepState(st) {
    if (!st) return { done: 0, current: 0 };
    var at = { draft: 1, staged: 2, validated: 3, committing: 4 }[st];
    if (at != null) return { done: at, current: at };
    return { done: 5, current: -1, ended: st === 'voiding' || st === 'voided' };
  }
  // what the server will also check, shown before staging (codes of the server's li_message dictionary)
  function localCheck(ent, data) {
    var m = [];
    if (!ent) return m;
    var has = function (k) { return own(data, k) && data[k] !== ''; };
    ent.required.forEach(function (k) { if (!has(k) && !altOf(ent, k).some(has)) m.push({ level: 'error', code: 'required', field: k }); });
    if (ent.entity === 'transactions' || ent.entity === 'containers' || ent.entity === 'movements') {
      containerList(own(data, 'container_no') ? data.container_no : '').forEach(function (c) {
        if (!/^[A-Z]{4}\d{7}$/.test(c)) m.push({ level: 'error', code: 'container_format', field: 'container_no', detail: c });
        else if (!iso6346Ok(c)) m.push({ level: 'warning', code: 'container_check_digit', field: 'container_no', detail: c });
      });
    }
    Object.keys(data).forEach(function (k) {
      var rule = DATE_RULES[k];
      if (!rule || data[k] === '') return;
      if (!normDate(data[k])) m.push({ level: rule[0], code: rule[1], field: k });
    });
    return m;
  }
  function levelOf(msgs) {
    if (msgs.some(function (x) { return x.level === 'error'; })) return 'error';
    return msgs.some(function (x) { return x.level === 'warning'; }) ? 'warning' : 'valid';
  }
  // rows → chunks of ≤ maxRows and ≤ maxBytes (JSON size of the call)
  function chunkRows(rows, maxRows, maxBytes) {
    maxRows = maxRows || LIMITS.stageRows; maxBytes = maxBytes || LIMITS.callBytes;
    var out = [], cur = [], bytes = 200;
    (rows || []).forEach(function (r) {
      var b = utf8Len(JSON.stringify(r)) + 1;
      if (cur.length && (cur.length >= maxRows || bytes + b > maxBytes)) { out.push(cur); cur = []; bytes = 200; }
      cur.push(r); bytes += b;
    });
    if (cur.length) out.push(cur);
    return out;
  }
  // the sheet name sent to the server: «sheet @ file», ≤ 120 characters, unique in the run (two files may share a sheet name)
  function sheetLabel(sheet, file, used) {
    var base = (str(sheet) || 'sheet') + ' @ ' + (str(file) || 'file');
    if (base.length > LIMITS.sheetChars) base = base.slice(0, LIMITS.sheetChars);
    var k = base, n = 2;
    while (used && used[k]) { var suf = ' #' + n++; k = base.slice(0, LIMITS.sheetChars - suf.length) + suf; }
    if (used) used[k] = 1;
    return k;
  }
  // the rows a sheet could not send (a value over 2000 characters, a row over 16 KB) → error-report rows
  function refusedOf(sheets) {
    var out = [];
    (sheets || []).forEach(function (s) {
      if (!s || !s.include || !s.built) return;
      s.built.rejected.forEach(function (x) {
        out.push({ source: 'local', entity: s.entity, sheet: s.label, row_no: x.row_no, status: 'error', data: {},
          messages: [{ level: 'error', code: x.code === 'too_long' ? 'too_long' : 'row_too_big', field: x.field || null }] });
      });
    });
    return out;
  }
  function entitiesOf(sheets) {
    var seen = Object.create(null);
    (sheets || []).forEach(function (s) { if (s.include && s.entity) seen[s.entity] = 1; });
    return ENTITIES.filter(function (e) { return seen[e]; });
  }

  /* ------------------------------------------------------------------ pure: server answers */
  function errCode(e) {
    if (!e) return null;
    if (e.code && /^MRS_/.test(e.code)) return e.code;
    var m = (e.raw && e.raw.message) || e.message || '';
    var mm = /^(MRS_[A-Z_]+)/.exec(m);
    return mm ? mm[1] : (e.code || null);
  }
  // a timeout / dropped connection / statement timeout: the call rolled back (or finished) — safe to retry with a smaller chunk
  function isRetryable(e) {
    var c = errCode(e), pg = e && e.raw && e.raw.code, m = String((e && (e.message || (e.raw && e.raw.message))) || '');
    return c === 'MRS_TIMEOUT' || c === 'MRS_NETWORK' || c === 'MRS_UNKNOWN_RESULT' || pg === '57014' || /statement timeout|timed out|timeout|canceling statement/i.test(m);
  }
  function isBusy(e) { return errCode(e) === 'MRS_LI_BUSY'; }
  // MRS_LI_VOID_BLOCKED carries {total, items} as JSON in its detail
  function blockersOf(e) {
    var cands = [e && e.field, e && e.detail, e && e.raw && e.raw.details, e && e.raw && e.raw.detail, e && e.raw && e.raw.message, e && e.message];
    for (var i = 0; i < cands.length; i++) {
      var s = cands[i];
      if (typeof s !== 'string') continue;
      var at = s.indexOf('{');
      if (at === -1) continue;
      try { var o = JSON.parse(s.slice(at)); if (o && Array.isArray(o.items)) return { total: +o.total || o.items.length, items: o.items }; } catch (x) { /* next */ }
    }
    return null;
  }
  // run.counts.by_entity → [{entity, total, by status}] in dependency order
  function entityCounts(run) {
    var be = run && run.counts && run.counts.by_entity ? run.counts.by_entity : {};
    return ENTITIES.filter(function (e) { return own(be, e); }).map(function (e) {
      var x = be[e] || {}, o = { entity: e, total: +x.total || 0 };
      ROW_STATUSES.forEach(function (s) { o[s] = +x[s] || 0; });
      return o;
    });
  }
  function statusCount(run, s) { var b = run && run.counts && run.counts.by_status; return b && own(b, s) ? +b[s] || 0 : 0; }
  // the unknown legacy values of the row messages → mapping suggestions {kind: [text…]} (folded unique, existing mapping left out)
  function mapSuggestions(items, mapping) {
    var out = {}, seen = Object.create(null);
    MAP_KINDS.forEach(function (k) { out[k] = []; });
    (items || []).forEach(function (r) {
      (Array.isArray(r.messages) ? r.messages : []).forEach(function (m) {
        var h = m && own(MAP_HINTS, m.code) ? MAP_HINTS[m.code] : null;
        if (!h) return;
        var fields = m.field ? [m.field].concat(h[1]) : h[1], text = '';
        for (var i = 0; i < fields.length && !text; i++) text = r.data && own(r.data, fields[i]) ? str(r.data[fields[i]]) : '';
        if (!text && m.detail) text = str(m.detail);
        var k = fold(text);
        if (!k || seen[h[0] + '|' + k]) return;
        var map = mapping && mapping[h[0]] ? mapping[h[0]] : {};
        if (Object.keys(map).some(function (x) { return fold(x) === k; })) return;
        seen[h[0] + '|' + k] = 1;
        if (out[h[0]].length < LIMITS.mapEntries) out[h[0]].push(text.slice(0, LIMITS.mapKeyChars));
      });
    });
    return out;
  }
  // a clean mapping {kind: {text: value}} (≤ 500 per kind, text ≤ 200, value ≤ 60; empty kinds dropped)
  function cleanMapping(m) {
    var out = {};
    MAP_KINDS.forEach(function (k) {
      var src = m && own(m, k) && m[k] && typeof m[k] === 'object' ? m[k] : null, o = {}, n = 0;
      if (!src) return;
      Object.keys(src).forEach(function (t) {
        var key = str(t).slice(0, LIMITS.mapKeyChars), v = str(src[t]).slice(0, 60);
        if (!key || !v || key === '__proto__' || n >= LIMITS.mapEntries) return;
        o[key] = v; n++;
      });
      if (n) out[k] = o;
    });
    return out;
  }
  function msgText(m, labels) {
    var t = srvLabel(labels, 'li_message', m.code, 'msg_');
    var extra = [m.field ? '«' + m.field + '»' : '', m.detail ? String(m.detail).slice(0, 80) : ''].filter(Boolean).join(' ');
    return extra ? t + ' (' + extra + ')' : t;
  }

  /* ------------------------------------------------------------------ pure: loops (validate / commit / stage) */
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // o = {step(limit) → Promise<{data, error}>, limit, min, retries, isDone(data), onData(data), stopped() → bool}
  // → Promise<{done, stopped, error, calls, limit}>. A timeout halves the limit (≥ min) and retries; MRS_LI_BUSY waits and retries.
  function loop(o) {
    var limit = o.limit, tries = 0, calls = 0, maxTries = o.retries == null ? LIMITS.retries : o.retries;
    function next() {
      if (o.stopped && o.stopped()) return Promise.resolve({ done: false, stopped: true, calls: calls, limit: limit });
      return Promise.resolve(o.step(limit)).then(function (r) {
        calls++;
        if (r && r.error) {
          if ((isRetryable(r.error) || isBusy(r.error)) && tries < maxTries) {
            tries++;
            if (isRetryable(r.error)) limit = Math.max(o.min || LIMITS.minLimit, Math.floor(limit / 2));
            return wait(isBusy(r.error) ? LIMITS.busyWaitMs : 0).then(next);
          }
          return { done: false, error: r.error, calls: calls, limit: limit };
        }
        tries = 0;
        var d = r ? r.data : null;
        if (o.onData) o.onData(d);
        if (o.isDone(d)) return { done: true, calls: calls, limit: limit, data: d };
        return next();
      });
    }
    return next();
  }

  /* ------------------------------------------------------------------ pure: sha-256 (file fingerprint; crypto.subtle when available) */
  var K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256Js(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length, total = ((len + 9 + 63) >> 6) << 6, buf = new Uint8Array(total), w = new Array(64), i, j;
    buf.set(bytes); buf[len] = 0x80;
    var bits = len * 8;
    for (i = 0; i < 8; i++) buf[total - 1 - i] = Math.floor(bits / Math.pow(2, 8 * i)) & 0xff;
    function rot(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = (buf[off + 4 * i] << 24) | (buf[off + 4 * i + 1] << 16) | (buf[off + 4 * i + 2] << 8) | buf[off + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
      for (j = 0; j < 64; j++) {
        var t1 = (k + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K256[j] + w[j]) | 0;
        var t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + k) | 0;
    }
    return h.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }
  function sha256Hex(buf) {
    var bytes = new Uint8Array(buf), C = window.crypto;
    if (C && C.subtle && typeof C.subtle.digest === 'function') {
      return Promise.resolve().then(function () { return C.subtle.digest('SHA-256', bytes); }).then(function (d) {
        return Array.prototype.map.call(new Uint8Array(d), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      }).then(null, function () { return sha256Js(bytes); });
    }
    return Promise.resolve(sha256Js(bytes));
  }

  /* ------------------------------------------------------------------ file reading (untrusted) */
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
  function kindOf(name) { var m = /\.(xlsx|csv|tsv|txt)$/i.exec(name || ''); return m ? (m[1].toLowerCase() === 'xlsx' ? 'xlsx' : 'csv') : null; }
  // file → {name, size, sha256, sheets [{name, rows}]} | {error, file}
  function parseFile(file) {
    var X = window.XlsxLite, name = str(file && file.name).slice(0, 200) || 'file', kind = kindOf(name);
    if (!kind) return Promise.resolve({ error: 'type', file: name });
    if (!(file.size > 0)) return Promise.resolve({ error: 'empty', file: name });
    if (file.size > LIMITS.fileBytes) return Promise.resolve({ error: 'too_big', file: name });
    if (!X || typeof X.read !== 'function') return Promise.resolve({ error: 'no_reader', file: name });
    return readFile(file).then(function (buf) {
      return sha256Hex(buf).then(function (hash) {
        var sn = X.sniff ? X.sniff(buf) : (kind === 'xlsx' ? 'xlsx' : 'text');
        var job;
        if (sn === 'xlsx') {
          if (typeof X.canRead === 'function' && !X.canRead()) return { error: 'no_reader', file: name };
          job = X.read(buf, { maxInflateBytes: LIMITS.inflateBytes, maxRows: LIMITS.rowsPerSheet + LIMITS.headerScan + 1, maxCols: LIMITS.cols }).then(function (wb) {
            return (wb && wb.sheets || []).filter(function (s) { return s && !s.hidden && !s.chart; }).map(function (s) { return { name: str(s.name).slice(0, 100), rows: s.rows || [] }; });
          });
        } else if (sn === 'xls') return { error: 'xls', file: name };
        else if (kind === 'xlsx' || sn === 'html') return { error: 'unreadable', file: name };
        else {
          var text = X.decodeText(buf), parsed = X.parseDelimited(text);
          var rows = parsed && parsed.rows || [];
          if (rows.length > LIMITS.rowsPerSheet + LIMITS.headerScan + 1) return { error: 'too_many_rows', file: name };
          if (rows.some(function (r) { return r && r.length > LIMITS.cols; })) return { error: 'too_wide', file: name };
          job = Promise.resolve([{ name: name.replace(/\.(csv|tsv|txt)$/i, '').slice(0, 100), rows: rows }]);
        }
        return job.then(function (sheets) {
          sheets = sheets.filter(function (s) { return s.rows.some(function (r) { return r && r.some(function (c) { return cellText(c) !== ''; }); }); });
          if (!sheets.length) return { error: 'empty', file: name };
          if (sheets.length > LIMITS.sheetsPerFile) sheets = sheets.slice(0, LIMITS.sheetsPerFile);
          return { name: name, size: file.size, sha256: hash, sheets: sheets };
        });
      });
    }).then(null, function (e) {
      var code = e && e.code;
      if (code === 'too_big') return { error: 'inflate_big', file: name };
      if (code === 'too_many_rows' || code === 'too_wide' || code === 'xls') return { error: code, file: name };
      return { error: 'unreadable', file: name };
    });
  }
  // one after another (never 20 workbooks inflated at once)
  function parseFiles(list, onEach) {
    var out = [];
    return (list || []).reduce(function (p, f, i) {
      return p.then(function () { return parseFile(f).then(function (r) { out.push(r); if (onEach) onEach(i, r); }); });
    }, Promise.resolve()).then(function () { return out; });
  }
  // parsed files → the sheets of the wizard (detected + mapped)
  function sheetsFrom(parsed, idx) {
    var out = [], used = Object.create(null);
    (parsed || []).forEach(function (f, fi) {
      if (!f || f.error) return;
      f.sheets.forEach(function (s, si) {
        var det = detectSheet(s.name, s.rows, idx), ent = det.entity ? idx.byEntity[det.entity] : null;
        var cols = det.headerRow >= 0 ? mapColumns(s.rows[det.headerRow], ent) : [];
        out.push({ id: 's' + fi + '_' + si, file: f.name, fileIdx: fi, name: s.name, label: sheetLabel(s.name, f.name, used), rows: s.rows,
          det: det, entity: det.entity || '', headerRow: det.headerRow, columns: cols, include: !!det.entity });
      });
    });
    return out;
  }

  var PURE = {
    VERSION: VERSION, ENTITIES: ENTITIES, ROW_STATUSES: ROW_STATUSES, RUN_STATUSES: RUN_STATUSES, LIMITS: LIMITS, FUNDING: FUNDING, MOVEMENT_TYPES: MOVEMENT_TYPES,
    MAP_KINDS: MAP_KINDS, MAP_HINTS: MAP_HINTS, fold: fold, western: western, normDate: normDate, riyadhToday: riyadhToday, iso6346Ok: iso6346Ok,
    containerList: containerList, containerNo: containerNo, dictIndex: dictIndex, scoreRow: scoreRow, detectSheet: detectSheet, mapColumns: mapColumns,
    setColumn: setColumn, missingRequired: missingRequired, buildRows: buildRows, localCheck: localCheck, levelOf: levelOf, chunkRows: chunkRows,
    sheetLabel: sheetLabel, entitiesOf: entitiesOf, refusedOf: refusedOf, errCode: errCode, isRetryable: isRetryable, isBusy: isBusy, blockersOf: blockersOf,
    entityCounts: entityCounts, mapSuggestions: mapSuggestions, cleanMapping: cleanMapping, loop: loop, sha256Js: sha256Js, sha256Hex: sha256Hex,
    parseFile: parseFile, parseFiles: parseFiles, sheetsFrom: sheetsFrom, utf8Len: utf8Len, cellText: cellText,
    DATE_RULES: DATE_RULES, skipWarnings: skipWarnings, runFiles: runFiles, stepState: stepState
  };
  Ops.legacyImport = PURE;

  /* ==================================================================
     the view
     ================================================================== */
  // in this tab only (never stored): the parsed files of the org being imported, the dictionary, the last run shown
  var ST = { org: null, dict: null, idx: null, files: [], parsed: [], sheets: [], rejectedFiles: [], runId: null, rejectedRows: null };
  function resetState(org) { ST = { org: org, dict: ST.org === org ? ST.dict : null, idx: ST.org === org ? ST.idx : null, files: [], parsed: [], sheets: [], rejectedFiles: [], runId: null, rejectedRows: null }; }

  function render(root, api, param) {
    var U = Ops.ui;
    if (!U) { while (root.firstChild) root.removeChild(root.firstChild); return; }
    var el = U.el, sc = U.scope(root), M = api && api.MarsaApi;
    U.clear(root);
    root.classList.add('ops-view', 'limp-view');
    if (ST.org !== (api && api.orgId)) resetState(api && api.orgId);
    root.appendChild(U.head(lt('title'), lt('sub')));
    if (!api || !api.orgOwner) { root.appendChild(U.alertBox('warning', lt('owner_only'))); return; }
    if (!M || typeof M.legacyImportDictionary !== 'function') { root.appendChild(U.alertBox('warning', lt('api_missing'))); return; }
    root.appendChild(U.alertBox('info', lt('privacy', { n: LIMITS.files, mb: LIMITS.fileBytes / 1048576 })));
    var body = el('div', { class: 'app-stack limp-body', 'aria-live': 'polite' });
    root.appendChild(body);
    var labels = null, runs = [], runsTotal = 0, run = null;

    function lab(domain, code, prefix) { return srvLabel(labels, domain, code, prefix); }
    function entLabel(e) { return lab('li_entity', e, 'ent_'); }
    function rowStLabel(s) { return lab('li_row_status', s, 'row_st_'); }
    function runStLabel(s) { return lab('li_run_status', s, 'run_st_'); }
    function errText(e) {
      if (api && typeof api.errText === 'function') { try { var s = api.errText(e); if (s) return s; } catch (x) { /* fall back */ } }
      return U.errMsg(e, api);
    }
    function call(name) { return U.call.apply(U, [api].concat(Array.prototype.slice.call(arguments))); }
    function num(n) { var K = window.MarsaExport && window.MarsaExport.kit ? window.MarsaExport.kit() : null; return K ? K.fmtNum(+n || 0, 0) : String(+n || 0); }
    function when(v) { var K = window.MarsaExport && window.MarsaExport.kit ? window.MarsaExport.kit() : null; return v ? (K ? K.riyadhDateTime(v) : String(v)) : '—'; }
    function bdi(text, dir) { return el('bdi', { dir: dir || 'auto', text: text == null || text === '' ? '—' : String(text) }); }
    function idem(scope, payload) { return U.idemKey(api, scope, payload); }
    function progress(op, job, label, cancellable) {
      var P = window.MarsaShell && window.MarsaShell.progress;
      return P && typeof P.track === 'function' ? P.track(op, job, { label: label, cancellable: cancellable !== false, delay: 400 }) : job;
    }
    function progressText(text) {
      var P = window.MarsaShell && window.MarsaShell.progress, a = P && typeof P.active === 'function' ? P.active() : null;
      var n = a && a.node && a.node.querySelector ? a.node.querySelector('.app-progress-label') : null;
      if (n) n.textContent = text;
      status.textContent = text;
    }
    var status = el('p', { class: 'limp-status text-sm', role: 'status', 'aria-live': 'polite' });

    /* -------------------------------------------------------------- load */
    function load() {
      U.loadingInto(body);
      var dictP = ST.dict ? Promise.resolve({ data: ST.dict }) : call('legacyImportDictionary');
      return Promise.all([dictP, call('legacyImportListRuns', { orgId: api.orgId, limit: 50 })]).then(function (res) {
        if (!sc.alive()) return null;
        if (res[0].error) { U.doneLoading(body); body.appendChild(U.errorState(api, res[0].error, load)); return null; }
        ST.dict = res[0].data || {}; ST.idx = dictIndex(ST.dict); labels = ST.dict.labels || null;
        if (res[1].error) { U.doneLoading(body); body.appendChild(U.errorState(api, res[1].error, load)); return null; }
        runs = (res[1].data && res[1].data.items) || []; runsTotal = (res[1].data && res[1].data.total) || runs.length;
        var want = param && /^[0-9a-f-]{36}$/i.test(param) ? param : (ST.runId || null);
        var open = runs.filter(function (r) { return OPEN[r.status]; })[0] || null;
        var id = want || (open && open.id) || null;
        if (!id) { run = null; U.doneLoading(body); draw(); return null; }
        return call('legacyImportGetRun', id).then(function (r) {
          if (!sc.alive()) return;
          U.doneLoading(body);
          run = r.error ? null : r.data;
          if (r.error && want) body.appendChild(U.alertBox('warning', errText(r.error)));
          ST.runId = run ? run.id : null;
          draw();
        });
      });
    }
    function reloadRun() {
      if (!run) return load();
      return call('legacyImportGetRun', run.id).then(function (r) { if (!r.error) run = r.data; if (sc.alive()) draw(); return r; });
    }

    /* -------------------------------------------------------------- draw */
    function draw() {
      U.clear(body);
      body.appendChild(status);
      if (run) body.appendChild(runPanel(run));
      var canStage = !run || run.status === 'draft' || run.status === 'staged' || run.status === 'validated';
      if (canStage && (!run || OPEN[run.status])) body.appendChild(filesPanel());
      body.appendChild(runsPanel());
    }
    function stepper(st) {
      var steps = [['files', lt('step_files')], ['stage', lt('step_stage')], ['validate', lt('step_validate')], ['review', lt('step_review')], ['commit', lt('step_commit')], ['link', lt('step_link')]];
      var ss = stepState(st);
      return el('ol', { class: 'limp-steps' + (ss.ended ? ' is-ended' : ''), 'aria-label': lt('steps_label') }, steps.map(function (s, i) {
        return el('li', { class: 'limp-step' + (i < ss.done ? ' is-done' : i === ss.current ? ' is-current' : ''), 'aria-current': i === ss.current ? 'step' : null, 'data-step': s[0] }, [
          el('span', { class: 'limp-step-n', text: String(i + 1) }), el('span', { class: 'limp-step-t', text: s[1] })]);
      }));
    }

    /* -------------------------------------------------------------- the run panel */
    function runPanel(r) {
      var kids = [stepper(r.status)];
      var meta = el('dl', { class: 'limp-meta' }, [
        el('dt', { text: lt('m_ref') }), el('dd', null, bdi(r.ref, 'ltr')),
        el('dt', { text: lt('m_status') }), el('dd', null, U.pill(TONES[r.status] || 'neutral', runStLabel(r.status))),
        el('dt', { text: lt('m_branch') }), el('dd', { text: r.branch_name || lt('branch_per_row') }),
        el('dt', { text: lt('m_entities') }), el('dd', { text: (r.entities || []).map(entLabel).join(lt('sep')) || '—' }),
        el('dt', { text: lt('m_reason') }), el('dd', null, bdi(r.reason)),
        el('dt', { text: lt('m_created') }), el('dd', { text: when(r.created_at) + (r.created_by_name ? ' · ' + r.created_by_name : '') }),
        el('dt', { text: lt('m_files') }), el('dd', { class: 'limp-files-dd' }, (r.files || []).length ? (r.files || []).reduce(function (a, f, i) { if (i) a.push(document.createTextNode(lt('sep'))); a.push(el('bdi', { dir: 'ltr', text: f.name })); return a; }, []) : [document.createTextNode('—')])
      ]);
      kids.push(meta);
      kids.push(tiles(r));
      var acts = [];
      if (r.status === 'staged' || r.status === 'validated') acts.push(U.btn(lt(r.status === 'validated' ? 'act_revalidate' : 'act_validate'), r.status === 'staged' ? 'btn-primary' : 'btn-secondary', function () { doValidate(); }, { 'data-act': 'li-validate' }));
      if (r.status === 'validated' && (+r.to_commit || 0) > 0) acts.push(U.btn(lt('act_commit', { n: num(r.to_commit) }), 'btn-primary', function () { doCommit(false); }, { 'data-act': 'li-commit' }));
      if (r.status === 'committing') acts.push(U.btn(lt('act_resume_commit'), 'btn-primary', function () { doCommit(true); }, { 'data-act': 'li-commit-resume' }));
      if (r.status === 'voiding') acts.push(U.btn(lt('act_resume_void'), 'btn-danger', function () { runVoid(r, r.void_reason || lt('void_dry_reason')); }, { 'data-act': 'li-void-resume' }));
      if (r.status !== 'voided' && r.status !== 'committing' && r.status !== 'voiding') acts.push(U.btn(lt('act_void'), 'btn-danger', function () { doVoid(r); }, { 'data-act': 'li-void' }));
      if (r.status === 'committed' || r.status === 'voided') acts.push(U.btn(lt('act_close_view'), 'btn-ghost', function () { ST.runId = null; run = null; if (param && api.go) api.go('#legacy_import'); else draw(); }, { 'data-act': 'li-close' }));
      kids.push(el('div', { class: 'rpt-form-actions limp-actions' }, acts));
      if (r.status === 'validated' && !(+r.to_commit > 0)) kids.push(U.alertBox('warning', lt('nothing_to_commit')));
      if (r.status === 'committing') kids.push(U.alertBox('warning', lt('committing_note')));
      if (r.status === 'voiding') kids.push(U.alertBox('warning', lt('voiding_note')));
      if (r.status === 'committed') kids.push(U.alertBox('success', lt('committed_note', { n: num(statusCount(r, 'committed')) })));
      if (r.status === 'voided') kids.push(U.alertBox('info', lt('voided_note', { d: when(r.voided_at), r: r.void_reason || '—' })));
      kids.push(U.alertBox('info', lt('safety')));
      var out = [U.card(lt('run_title', { ref: r.ref }), kids, null, { cls: 'limp-run' })];
      if (r.status !== 'draft') {
        out.push(byEntityCard(r));
        if (Array.isArray(r.messages) && r.messages.length) out.push(messagesCard(r));
        out.push(rowsCard(r));
      }
      if (r.status === 'staged' || r.status === 'validated') out.push(optionsCard(r));
      if (r.status === 'committed') out.push(daftraCard(r));
      return el('div', { class: 'app-stack limp-run-wrap' }, out);
    }
    function tiles(r) {
      var t = el('div', { class: 'adm-tiles ops-kpis limp-tiles' });
      [['k_total', r.counts ? r.counts.total : 0, 'neutral'], ['k_valid', statusCount(r, 'valid'), 'neutral'], ['k_warning', statusCount(r, 'warning'), 'warning'],
        ['k_error', statusCount(r, 'error'), 'danger'], ['k_duplicate', statusCount(r, 'duplicate'), 'neutral'], ['k_skipped', statusCount(r, 'skipped'), 'neutral'],
        ['k_pending', statusCount(r, 'pending'), 'neutral'], ['k_committed', statusCount(r, 'committed'), 'neutral']
      ].forEach(function (p) { t.appendChild(U.kpi(lt(p[0]), num(p[1]), p[2])); });
      return t;
    }
    function byEntityCard(r) {
      var rows = entityCounts(r).map(function (x) {
        return el('tr', { 'data-entity': x.entity }, [U.td(entLabel(x.entity))].concat(ROW_STATUSES.map(function (s) {
          return U.td(U.ltr(num(x[s])), 'num');
        }), [U.td(U.ltr(num(x.total)), 'num')]));
      });
      var heads = [lt('c_entity')].concat(ROW_STATUSES.map(function (s) { return { label: rowStLabel(s), num: true }; }), [{ label: lt('c_total'), num: true }]);
      return U.card(lt('by_entity'), rows.length ? U.table(heads, rows, { caption: lt('by_entity') }) : U.emptyState('inbox', null, lt('no_rows'), null, true), null, { flush: true, cls: 'limp-by-entity' });
    }
    function messagesCard(r) {
      var rows = r.messages.slice(0, 60).map(function (m) {
        return el('tr', { 'data-code': m.code }, [U.td(entLabel(m.entity)), U.td(U.pill(m.level === 'error' ? 'danger' : m.level === 'warning' ? 'warning' : 'info', lt('lvl_' + (m.level || 'info')))),
          U.td(lab('li_message', m.code, 'msg_')), U.td(U.ltr(num(m.n)), 'num')]);
      });
      return U.card(lt('messages'), U.table([lt('c_entity'), lt('c_level'), lt('c_message'), { label: lt('c_rows'), num: true }], rows, { caption: lt('messages') }), null, { flush: true, cls: 'limp-messages' });
    }

    /* -------------------------------------------------------------- rows (preview after the server check, skip, error report) */
    var RF = { entity: '', status: '', q: '', offset: 0 };
    function rowsCard(r) {
      var box = el('div', { class: 'limp-rows-box' });
      var editable = r.status === 'staged' || r.status === 'validated';
      var picked = Object.create(null);
      var entSel = U.select('entity', lt('f_entity'), [['', lt('f_entity_all')]].concat((r.entities || []).map(function (e) { return [e, entLabel(e)]; })), RF.entity, function (v) { RF.entity = v; RF.offset = 0; fetch(); });
      var stSel = U.select('status', lt('f_status'), [['', lt('f_status_all')], ['problems', lt('f_status_problems')]].concat(ROW_STATUSES.map(function (s) { return [s, rowStLabel(s)]; })), RF.status, function (v) { RF.status = v; RF.offset = 0; fetch(); });
      var search = U.searchBox(RF.q, lt('f_search'), function (v) { RF.q = v; RF.offset = 0; fetch(); });
      var skipB = editable ? U.btn(lt('act_skip'), 'btn-secondary', function () { skip(true); }, { 'data-act': 'li-skip', disabled: true }) : null;
      var unskipB = editable ? U.btn(lt('act_unskip'), 'btn-ghost', function () { skip(false); }, { 'data-act': 'li-unskip', disabled: true }) : null;
      var repX = U.btn(lt('act_report_xlsx'), 'btn-secondary', function (b) { report(r, 'xlsx', b); }, { 'data-act': 'li-report-xlsx' });
      var repC = U.btn(lt('act_report_csv'), 'btn-ghost', function (b) { report(r, 'csv', b); }, { 'data-act': 'li-report-csv' });
      var bar = U.toolbar(search, [entSel, stSel], [skipB, unskipB, repX, repC].filter(Boolean), null);
      function statusFilter() { return RF.status === 'problems' ? REPORT_STATUSES : RF.status || null; }
      function updateBtns() { var n = Object.keys(picked).length; if (skipB) skipB.disabled = !n; if (unskipB) unskipB.disabled = !n; }
      function fetch() {
        U.loadingInto(box);
        picked = Object.create(null); updateBtns();
        return call('legacyImportListRows', r.id, { entity: RF.entity || null, status: statusFilter(), q: RF.q || null, limit: LIMITS.listPage, offset: RF.offset }).then(function (res) {
          if (!sc.alive()) return;
          U.doneLoading(box);
          if (res.error) { box.appendChild(U.errorState(api, res.error, fetch)); return; }
          var d = res.data || {}, items = d.items || [], total = +d.total || 0;
          if (!items.length) { box.appendChild(U.emptyState('check', null, lt('no_rows_match'), null, true)); return; }
          var trs = items.map(function (x) {
            var cb = editable && x.status !== 'committed' ? el('input', { type: 'checkbox', 'aria-label': lt('pick_row', { n: x.row_no, s: x.sheet }), 'data-row': x.id }) : null;
            if (cb) cb.addEventListener('change', function () { if (cb.checked) picked[x.id] = x.entity || 1; else delete picked[x.id]; updateBtns(); });
            var msgs = Array.isArray(x.messages) ? x.messages : [];
            return el('tr', { 'data-row-id': x.id, 'data-status': x.status, class: 'limp-row limp-row-' + x.status }, [
              editable ? U.td(cb) : null,
              U.td(entLabel(x.entity)), U.td(bdi(x.sheet)), U.td(U.ltr(String(x.row_no)), 'num'),
              U.td(U.pill(TONES[x.status] || 'neutral', rowStLabel(x.status))),
              U.td(msgs.length ? el('ul', { class: 'limp-msgs' }, msgs.slice(0, 6).map(function (m) {
                return el('li', { class: 'limp-msg is-' + (m.level || 'info'), text: msgText(m, labels) });
              })) : '—'),
              U.td(el('span', { class: 'limp-data' }, dataSummary(x))),
              U.td(x.target_id && x.target_table === 'transactions' ? el('a', { class: 'ops-ref', href: '#tx/' + x.target_id }, bdi(x.target_label || lt('open_tx'), 'ltr'))
                : x.target_label ? bdi(x.target_label) : '—')
            ].filter(Boolean));
          });
          var heads = (editable ? [{ label: lt('c_pick') }] : []).concat([lt('c_entity'), lt('c_sheet'), { label: lt('c_row'), num: true }, lt('c_status'), lt('c_messages'), lt('c_data'), lt('c_target')]);
          box.appendChild(U.table(heads, trs, { caption: lt('rows_title') }));
          var pager = el('div', { class: 'limp-pager' }, [
            el('span', { class: 'text-xs text-muted', text: lt('shown', { a: num(RF.offset + 1), b: num(RF.offset + items.length), t: num(total) }) }),
            RF.offset > 0 ? U.btn(lt('prev'), 'btn-ghost btn-sm', function () { RF.offset = Math.max(0, RF.offset - LIMITS.listPage); fetch(); }, { 'data-act': 'li-prev' }) : null,
            RF.offset + items.length < total ? U.btn(lt('next'), 'btn-ghost btn-sm', function () { RF.offset += LIMITS.listPage; fetch(); }, { 'data-act': 'li-next' }) : null
          ]);
          box.appendChild(pager);
        });
      }
      function skip(on) {
        var ids = Object.keys(picked);
        if (!ids.length) return;
        var warn = on ? skipWarnings(ids.map(function (k) { return picked[k]; })) : [];
        if (!warn.length) { send(); return; }
        U.formModal({ title: lt('skip_warn_title'), size: 'md', submitText: lt('skip_warn_ok'),
          intro: el('div', { 'data-skip-warn': '1' }, [U.alertBox('warning', lt('skip_warn_text')), el('ul', { class: 'limp-commit-list' }, warn.map(function (w) {
            return el('li', { 'data-parent': w.entity, text: lt('skip_warn_li', { e: entLabel(w.entity), d: w.dependents.map(entLabel).join(lt('sep')), c: lab('li_message', w.code, 'msg_') }) });
          }))]),
          fields: [], submit: function () { return Promise.resolve({ data: true, error: null }); } }).then(function (okd) { if (okd) send(); });
        function send() {
        call('legacyImportSkipRows', r.id, ids, on).then(function (res) {
          if (res.error) { U.toast(api, errText(res.error), 'error'); return; }
          U.toast(api, lt(on ? 'skipped_n' : 'unskipped_n', { n: num((res.data && res.data.updated) || ids.length) }), 'success');
          if (res.data && res.data.run) run = res.data.run;
          reloadRun();
        });
        }
      }
      var card = U.card(lt('rows_title'), [bar, editable ? el('p', { class: 'text-xs text-muted', text: lt('skip_hint') }) : null, box], null, { cls: 'limp-rows' });
      fetch();
      return card;
    }
    function dataSummary(x) {
      var ent = ST.idx ? ST.idx.byEntity[x.entity] : null, d = x.data || {}, parts = [];
      (ent ? ent.fields : Object.keys(d).map(function (k) { return { key: k, label: k }; })).forEach(function (f) {
        if (parts.length < 4 && own(d, f.key) && str(d[f.key])) parts.push(f.label + ': ' + str(d[f.key]).slice(0, 60));
      });
      return parts.join(' · ') || '—';
    }

    // the error report: every problem row of the run (server rows, paged ≤ 500) + the rows refused in this browser
    function fetchProblems(r) {
      var all = [], offset = 0;
      function page() {
        return call('legacyImportListRows', r.id, { status: REPORT_STATUSES, limit: 500, offset: offset }).then(function (res) {
          if (res.error) return res;
          var items = (res.data && res.data.items) || [], total = +(res.data && res.data.total) || 0;
          all = all.concat(items); offset += items.length;
          if (items.length && offset < total && all.length < LIMITS.reportCap) return page();
          return { data: all };
        });
      }
      return page();
    }
    function report(r, format, btn) {
      btn.disabled = true;
      var job = fetchProblems(r);
      progress('limp_report', job, lt('report_running')).then(function (res) {
        btn.disabled = false;
        if (res.error) { U.toast(api, errText(res.error), 'error'); return; }
        var items = res.data || [], local = localRejected();
        if (!items.length && !local.length) { U.toast(api, lt('report_empty'), 'info'); return; }
        try { buildReport(r, items, local, format); U.toast(api, lt('report_done', { n: num(items.length + local.length) }), 'success'); }
        catch (e) { U.toast(api, lt('report_failed'), 'error'); }
      }, function () { btn.disabled = false; });
    }
    function localRejected() { return ST.rejectedRows && run && ST.rejectedRows.runId === run.id ? ST.rejectedRows.rows : []; }
    function buildReport(r, items, local, format) {
      var E = window.MarsaExport, X = window.MarsaXlsx, when0 = new Date();
      var all = items.concat(local);
      var base = [{ key: 'entity', label: lt('c_entity'), type: 'text' }, { key: 'sheet', label: lt('c_sheet'), type: 'text' }, { key: 'row_no', label: lt('c_row'), type: 'int' },
        { key: 'status', label: lt('c_status'), type: 'text' }, { key: 'messages', label: lt('c_messages'), type: 'text' }];
      function baseRow(x) {
        return { entity: entLabel(x.entity), sheet: x.sheet, row_no: x.row_no, status: x.source === 'local' ? lt('local_refused') : rowStLabel(x.status),
          messages: (x.messages || []).map(function (m) { return msgText(m, labels); }).join(' | ') };
      }
      var name = 'legacy_import_' + String(r.ref || '').replace(/[^A-Za-z0-9-]/g, '');
      if (format === 'csv') {
        var cols = base.concat([{ key: 'data', label: lt('c_data'), type: 'text' }]);
        var data = all.map(function (x) {
          var o = baseRow(x), d = x.data || {};
          o.data = Object.keys(d).map(function (k) { return k + ': ' + str(d[k]); }).join('; ');
          return o;
        });
        E.download(new Blob([E.toCsv(cols, data, [])], { type: 'text/csv;charset=utf-8' }), E.fileName(name, 'csv', when0));
        return;
      }
      // xlsx: one sheet per entity with its own field columns (the legacy header as the label) + the criteria sheet
      var sheets = [];
      ENTITIES.forEach(function (e) {
        var rows = all.filter(function (x) { return x.entity === e; });
        if (!rows.length) return;
        var ent = ST.idx ? ST.idx.byEntity[e] : null, fcols = (ent ? ent.fields : []).map(function (f) { return { key: 'f_' + f.key, label: f.label, type: 'text' }; });
        sheets.push({ name: entLabel(e), rtl: !isEn(), columns: base.slice(1).concat(fcols), rows: rows.map(function (x) {
          var o = baseRow(x), d = x.data || {};
          (ent ? ent.fields : []).forEach(function (f) { if (own(d, f.key)) o['f_' + f.key] = str(d[f.key]); });
          return o;
        }) });
      });
      var meta = [[lt('m_ref'), r.ref], [lt('m_status'), runStLabel(r.status)], [lt('m_reason'), r.reason || ''], [lt('c_rows'), String(all.length)],
        [lt('generated_at'), when(when0.toISOString()) + ' (' + lt('riyadh') + ')']];
      var blob = X.blob({ title: lt('report_title', { ref: r.ref }), generatedAt: when0.toISOString(), metaName: lt('report_meta'), metaLabels: [lt('meta_item'), lt('meta_value')], meta: meta, sheets: sheets });
      E.download(blob, E.fileName(name, 'xlsx', when0));
    }

    /* -------------------------------------------------------------- options + mapping (back to pending → validate again) */
    function optionsCard(r) {
      var opt = r.options || {}, mapping = cleanMapping(r.mapping || {});
      var form = el('div', { class: 'limp-options' });
      var branchSel = U.select('branch_id', lt('o_branch'), [['', lt('branch_per_row')]].concat((api.branches || []).map(function (b) { return [b.id, (isEn() && b.name_en) || b.name_ar || b.id]; })), r.branch_id || '');
      var fundSel = U.select('default_funding_source', lt('o_funding'), [['', lt('o_none')]].concat(FUNDING.map(function (f) { return [f, lt('fund_' + f)]; })), opt.default_funding_source || '');
      var mvSel = U.select('default_movement_type', lt('o_movement'), [['', lt('o_none')]].concat(MOVEMENT_TYPES.map(function (f) { return [f, lt('mt_' + f)]; })), opt.default_movement_type || '');
      var acct = el('input', { class: 'form-control is-sm', type: 'text', name: 'default_paying_account', maxlength: '120', value: opt.default_paying_account || '', 'aria-label': lt('o_account') });
      var prefix = el('input', { class: 'form-control is-sm', type: 'text', name: 'daftra_invoice_prefix', maxlength: '20', dir: 'ltr', value: opt.daftra_invoice_prefix || 'RHK-', 'aria-label': lt('o_prefix') });
      [[lt('o_branch'), branchSel], [lt('o_funding'), fundSel], [lt('o_movement'), mvSel], [lt('o_account'), acct], [lt('o_prefix'), prefix]].forEach(function (p) {
        form.appendChild(el('label', { class: 'limp-field' }, [el('span', { class: 'limp-field-label', text: p[0] }), p[1]]));
      });
      // mapping editor: one list per kind ({legacy text → code / id})
      var editors = {};
      var mapBox = el('div', { class: 'limp-map' });
      var portOpts = [['', lt('map_pick')]], itemOpts = [['', lt('map_pick')]];
      var clientCache = [];
      MAP_KINDS.forEach(function (k) {
        var list = el('div', { class: 'limp-map-list', 'data-kind': k });
        editors[k] = { list: list, rows: [] };
        Object.keys(mapping[k] || {}).forEach(function (t) { addMapRow(k, t, mapping[k][t]); });
        var addB = U.btn(lt('map_add'), 'btn-ghost btn-sm', function () { addMapRow(k, '', ''); }, { 'data-act': 'li-map-add-' + k });
        mapBox.appendChild(el('fieldset', { class: 'limp-map-kind' }, [el('legend', { text: lt('map_' + k) }), el('p', { class: 'text-xs text-muted', text: lt('map_hint_' + k) }), list, addB]));
      });
      function targetCtl(k, v) {
        if (k === 'branches') return U.select('v', lt('map_value'), [['', lt('map_pick')]].concat((api.branches || []).map(function (b) { return [b.id, (isEn() && b.name_en) || b.name_ar || b.id]; })), v);
        if (k === 'ports') return U.select('v', lt('map_value'), portOpts.concat(v && !portOpts.some(function (o) { return o[0] === v; }) ? [[v, v]] : []), v);
        if (k === 'service_items') return U.select('v', lt('map_value'), itemOpts.concat(v && !itemOpts.some(function (o) { return o[0] === v; }) ? [[v, v]] : []), v);
        return U.select('v', lt('map_value'), [['', lt('map_pick_client')]].concat(clientCache.map(function (c) { return [c.id, c.name_ar || c.name_en || c.id]; }), v && !clientCache.some(function (c) { return c.id === v; }) ? [[v, lt('map_client_saved')]] : []), v);
      }
      function addMapRow(k, text, value) {
        var ed = editors[k];
        var t = el('input', { class: 'form-control is-sm', type: 'text', maxlength: String(LIMITS.mapKeyChars), value: text || '', 'aria-label': lt('map_text') });
        var holder = el('span', { class: 'limp-map-target' }, targetCtl(k, value || ''));
        var row = { k: k, t: t, holder: holder, value: function () { var s = holder.querySelector('select'); return s ? s.value : ''; } };
        var rm = U.btn(lt('map_remove'), 'btn-ghost btn-sm', function () { ed.rows = ed.rows.filter(function (x) { return x !== row; }); if (row.node.parentNode) row.node.parentNode.removeChild(row.node); }, { 'aria-label': lt('map_remove') });
        var search = null;
        if (k === 'clients') {
          search = el('input', { class: 'form-control is-sm', type: 'search', maxlength: '80', placeholder: lt('map_client_search'), 'aria-label': lt('map_client_search') });
          var tm = null;
          search.addEventListener('input', function () {
            clearTimeout(tm);
            tm = setTimeout(function () {
              var q = str(search.value); if (q.length < 2) return;
              call('listClients', { orgId: api.orgId, search: q, limit: 20 }).then(function (res) {
                if (res.error) return;
                var got = U.rowsOf(res.data);
                got.forEach(function (c) { if (!clientCache.some(function (x) { return x.id === c.id; })) clientCache.push(c); });
                var cur = row.value(); U.clear(holder); holder.appendChild(U.select('v', lt('map_value'), [['', lt('map_pick_client')]].concat(got.map(function (c) { return [c.id, c.name_ar || c.name_en || c.id]; })), cur));
              });
            }, 300);
          });
        }
        row.node = el('div', { class: 'limp-map-row' }, [t, search, holder, rm].filter(Boolean));
        ed.rows.push(row); ed.list.appendChild(row.node);
        return row;
      }
      function collect() {
        var m = {};
        MAP_KINDS.forEach(function (k) {
          var o = Object.create(null), n = 0;
          editors[k].rows.forEach(function (row) { var t = str(row.t.value), v = row.value(); if (t && v && !o[t]) { o[t] = v; n++; } });
          if (n) { m[k] = {}; Object.keys(o).forEach(function (t) { m[k][t] = o[t]; }); }
        });
        return cleanMapping(m);
      }
      var suggest = U.btn(lt('map_suggest'), 'btn-secondary btn-sm', function (b) {
        b.disabled = true;
        fetchProblems(r).then(function (res) {
          b.disabled = false;
          if (res.error) { U.toast(api, errText(res.error), 'error'); return; }
          var s = mapSuggestions(res.data || [], collect()), added = 0;
          MAP_KINDS.forEach(function (k) { s[k].forEach(function (t) { addMapRow(k, t, ''); added++; }); });
          U.toast(api, added ? lt('map_suggested', { n: num(added) }) : lt('map_nothing'), added ? 'success' : 'info');
        });
      }, { 'data-act': 'li-map-suggest' });
      var err = el('p', { class: 'rpt-form-error', role: 'alert', hidden: true });
      var save = U.btn(lt('o_save'), 'btn-primary', function (b) {
        err.hidden = true;
        var p = { branch_id: branchSel.value || null, mapping: collect(), options: {} };
        if (fundSel.value) p.options.default_funding_source = fundSel.value;
        if (mvSel.value) p.options.default_movement_type = mvSel.value;
        if (str(acct.value)) p.options.default_paying_account = str(acct.value);
        if (str(prefix.value)) p.options.daftra_invoice_prefix = str(prefix.value);
        b.disabled = true;
        call('legacyImportSetOptions', r.id, p).then(function (res) {
          b.disabled = false;
          if (res.error) { err.hidden = false; err.textContent = errText(res.error); return; }
          run = res.data || run;
          U.toast(api, lt('o_saved'), 'success');
          doValidate();
        });
      }, { 'data-act': 'li-options-save' });
      // the port / service item choices (read-only lists)
      call('listCustomsPorts').then(function (res) {
        if (res.error) return;
        U.rowsOf(res.data).filter(function (p) { return p.is_active !== false; }).forEach(function (p) { portOpts.push([p.code, p.code + ' — ' + ((isEn() && p.name_en) || p.name_ar || p.code)]); });
        refreshTargets('ports');
      });
      call('listServiceItems', { orgId: api.orgId }).then(function (res) {
        if (res.error) return;
        U.rowsOf(res.data).forEach(function (s) { itemOpts.push([s.code || s.id, (s.code ? s.code + ' — ' : '') + ((isEn() && s.name_en) || s.name_ar || '')]); });
        refreshTargets('service_items');
      });
      function refreshTargets(k) {
        editors[k].rows.forEach(function (row) { var v = row.value(); U.clear(row.holder); row.holder.appendChild(targetCtl(k, v)); });
      }
      return U.card(lt('options_title'), [el('p', { class: 'text-xs text-muted', text: lt('options_hint') }), form, el('h4', { class: 'limp-sub', text: lt('map_title') }), suggest, mapBox, err,
        el('div', { class: 'rpt-form-actions' }, [save])], null, { cls: 'limp-options-card' });
    }

    /* -------------------------------------------------------------- validate / commit / void */
    var stopFlag = false;
    function doValidate() {
      if (!run) return Promise.resolve();
      stopFlag = false;
      var lim = (ST.dict && ST.dict.limits && +ST.dict.limits.validate_default) || LIMITS.validateLimit, done0 = 0;
      var job = loop({ limit: lim, min: LIMITS.minLimit, step: function (l) { return call('legacyImportValidate', run.id, { limit: l }); },
        isDone: function (d) { return !d || d.done === true; }, stopped: function () { return stopFlag; },
        onData: function (d) { if (d && d.run) run = d.run; done0 += (d && +d.processed) || 0; progressText(lt('validating_n', { n: num(done0), t: num(run && run.counts ? run.counts.total : 0) })); } });
      return progress('limp_validate', job, lt('validating'), true).then(function (res) { return afterLoop(res, 'validated_ok'); }, function (e) { stopFlag = true; return afterCancel(e); });
    }
    function doCommit(resume) {
      if (!run) return;
      var r = run;
      var go = function () {
        stopFlag = false;
        var first = !resume, lim = (ST.dict && ST.dict.limits && +ST.dict.limits.commit_default) || LIMITS.commitLimit, ok = 0, bad = 0;
        var job = loop({ limit: lim, min: 1, step: function (l) {
            var o = { limit: l }; if (first) o.confirm = true;
            return call('legacyImportCommit', r.id, o).then(function (res) { if (!res.error) first = false; return res; });
          },
          isDone: function (d) { return !d || d.done === true; }, stopped: function () { return stopFlag; },
          onData: function (d) { if (d && d.run) run = d.run; ok += (d && +d.committed) || 0; bad += (d && +d.failed) || 0; progressText(lt('committing_n', { n: num(ok), f: num(bad), t: num(r.to_commit || 0) })); } });
        progress('limp_commit', job, lt('committing'), true).then(function (res) { afterLoop(res, 'committed_ok'); }, function (e) { stopFlag = true; afterCancel(e); });
      };
      if (resume) { go(); return; }
      U.formModal({
        title: lt('commit_title', { ref: r.ref }), size: 'lg', danger: false, submitText: lt('commit_ok'),
        intro: el('div', { class: 'limp-commit-intro' }, [
          el('p', { text: lt('commit_text', { n: num(r.to_commit), e: num(statusCount(r, 'error')), d: num(statusCount(r, 'duplicate')), s: num(statusCount(r, 'skipped')) }) }),
          el('ul', { class: 'limp-commit-list' }, ['commit_li_1', 'commit_li_2', 'commit_li_3', 'commit_li_4', 'commit_li_5'].map(function (k) { return el('li', { text: lt(k) }); }))]),
        fields: [{ name: 'understood', label: lt('commit_understood'), type: 'checkbox', value: false, required: true, full: true }],
        validate: function (v) { return v.understood ? null : { understood: lt('commit_need') }; },
        submit: function () { return Promise.resolve({ data: true, error: null }); }
      }).then(function (okd) { if (okd) go(); });
    }
    function afterLoop(res, okKey) {
      if (!sc.alive()) return;
      if (res && res.error) { U.toast(api, errText(res.error), 'error'); status.textContent = errText(res.error); }
      else if (res && res.stopped) status.textContent = lt('stopped');
      else { status.textContent = lt(okKey); U.toast(api, lt(okKey), 'success'); }
      return reloadRun().then(function () { return refreshRuns(); });
    }
    function afterCancel() {
      if (!sc.alive()) return;
      status.textContent = lt('stopping');
      // the loop stops after the call in flight; read the state again shortly
      setTimeout(function () { if (sc.alive()) reloadRun(); }, 1500);
    }
    function refreshRuns() {
      return call('legacyImportListRuns', { orgId: api.orgId, limit: 50 }).then(function (res) {
        if (res.error || !sc.alive()) return;
        runs = (res.data && res.data.items) || []; runsTotal = (res.data && res.data.total) || runs.length;
        draw();
      });
    }
    function doVoid(r) {
      call('legacyImportVoid', r.id, lt('void_dry_reason'), { dryRun: true }).then(function (res) {
        if (!sc.alive()) return;
        var bl = res.error ? blockersOf(res.error) : (res.data && res.data.blockers);
        if (res.error && !bl) { U.toast(api, errText(res.error), 'error'); return; }
        if (bl && +bl.total > 0) { showBlockers(r, bl); return; }
        U.formModal({
          title: lt('void_title', { ref: r.ref }), size: 'sm', danger: true, submitText: lt('void_ok'), cancelText: lt('void_cancel'),
          intro: lt(r.status === 'committed' ? 'void_text_committed' : 'void_text_open'),
          fields: [{ name: 'reason', label: lt('void_reason'), type: 'textarea', required: true, max: 500, rows: 2 }],
          validate: function (v) { return str(v.reason).length < 3 ? { reason: lt('reason_short') } : null; },
          submit: function (v) { return Promise.resolve({ data: { reason: str(v.reason) }, error: null }); }
        }).then(function (d) {
          if (!d || !d.reason) return;
          runVoid(r, d.reason);
        }, function () { /* dismissed */ });
      });
    }
    // the void in chunks (the server keeps the run «voiding» until every row is undone; a stop / timeout resumes from the run panel)
    function runVoid(r, reason) {
      stopFlag = false;
      var n = 0, kept = 0, rowsDone = 0;
      var job = loop({ limit: LIMITS.voidLimit, min: 1, step: function (l) { return call('legacyImportVoid', r.id, reason, { limit: l }); },
        isDone: function (d) { return !d || d.done === true; }, stopped: function () { return stopFlag; },
        onData: function (d) {
          if (d && d.run) run = d.run;
          Object.keys((d && d.voided) || {}).forEach(function (k) { n += +d.voided[k] || 0; });
          kept += (d && +d.kept_containers) || 0; rowsDone += (d && +d.rows) || 0;
          progressText(lt('voiding_n', { n: num(rowsDone) }));
        } });
      progress('limp_void', job, lt('voiding'), true).then(function (res) {
        if (!sc.alive()) return;
        if (res && res.error) {
          var bl = blockersOf(res.error);
          if (bl && +bl.total > 0) { showBlockers(r, bl); return reloadRun().then(refreshRuns); }
          U.toast(api, errText(res.error), 'error'); status.textContent = errText(res.error);
        } else if (res && res.stopped) status.textContent = lt('stopped');
        else {
          U.toast(api, lt('voided_ok', { n: num(n) }), 'success');
          status.textContent = kept > 0 ? lt('voided_kept', { n: num(kept) }) : lt('voided_ok', { n: num(n) });
        }
        return reloadRun().then(refreshRuns);
      }, function () { stopFlag = true; afterCancel(); });
    }
    function showBlockers(r, bl) {
      var rows = (bl.items || []).slice(0, 200).map(function (b) {
        var reason = String(b.reason || ''), rk = /^payment_/.test(reason) ? 'payment' : reason;
        return el('tr', { 'data-table': b.table, 'data-reason': reason }, [U.td(lt('tbl_' + b.table) !== 'tbl_' + b.table ? lt('tbl_' + b.table) : String(b.table)), U.td(bdi(b.label || '—')),
          U.td(lt('bl_' + rk) !== 'bl_' + rk ? lt('bl_' + rk) : reason)]);
      });
      U.formModal({ title: lt('blocked_title', { ref: r.ref }), size: 'lg', submitText: lt('close'),
        intro: el('div', null, [U.alertBox('danger', lt('blocked_text', { n: num(bl.total) })), U.table([lt('c_table'), lt('c_record'), lt('c_reason')], rows, { caption: lt('blocked_title', { ref: r.ref }) })]),
        fields: [], submit: function () { return Promise.resolve({ data: true, error: null }); } });
    }

    /* -------------------------------------------------------------- RHK- invoices (step-7 lookups, human confirmation only) */
    function daftraCard(r) {
      var box = el('div', { class: 'limp-dft-box' });
      var info = r.daftra && r.daftra.queued_at ? lt('dft_queued', { d: when(r.daftra.queued_at), n: num(r.daftra.lookups || 0), p: r.daftra.prefix || 'RHK-' }) : lt('dft_not_queued', { p: (r.options && r.options.daftra_invoice_prefix) || 'RHK-' });
      var q = U.btn(lt(r.daftra && r.daftra.queued_at ? 'dft_requeue' : 'dft_queue'), 'btn-primary', function (b) {
        b.disabled = true;
        var key = idem('limp-dft-' + r.id, { run: r.id });
        call('legacyImportQueueDaftra', r.id, { idemKey: key }).then(function (res) {
          U.idemSettle('limp-dft-' + r.id, res.error);
          b.disabled = false;
          if (res.error) { U.toast(api, errText(res.error), 'error'); return; }
          var d = res.data || {};
          U.toast(api, lt('dft_queued_ok', { n: num(d.lookups_queued || 0), m: num(d.lookups_deduplicated || 0) }), 'success');
          if (d.run) run = d.run;
          reloadRun();
        });
      }, { 'data-act': 'li-dft-queue' });
      var refresh = U.btn(lt('dft_refresh'), 'btn-ghost', function () { fetchCands(); }, { 'data-act': 'li-dft-refresh' });
      function fetchCands() {
        U.loadingInto(box);
        call('legacyImportDaftraCandidates', r.id, {}).then(function (res) {
          if (!sc.alive()) return;
          U.doneLoading(box);
          if (res.error) { box.appendChild(U.errorState(api, res.error, fetchCands)); return; }
          var items = (res.data && res.data.items) || [];
          if (!items.length) { box.appendChild(U.emptyState('inbox', null, lt('dft_none'), null, true)); return; }
          box.appendChild(U.table([lt('c_tx'), lt('c_legacy_ref'), lt('c_legacy_invoice'), lt('c_candidate'), lt('c_state'), lt('c_date'), { label: lt('c_amount'), num: true }, lt('c_actions')],
            items.map(function (x) {
              var c = x.candidate || {}, tx = x.transaction || {};
              var tone = c.state === 'blocked' ? 'danger' : c.state === 'review' || c.state === 'partial' ? 'warning' : 'info';
              return el('tr', { 'data-cand': c.id, 'data-state': c.state }, [
                U.td(tx.id ? el('a', { class: 'ops-ref', href: '#tx/' + tx.id }, bdi(tx.ref, 'ltr')) : '—'),
                U.td(U.ltr(tx.legacy_ref || '—')), U.td(legacyInvoiceCell(tx, c)), U.td(U.ltr(c.daftra_number || c.external_invoice_id || '—')),
                U.td(U.pill(tone, lt('cand_' + (c.state || 'open')))), U.td(U.ltr(c.invoice_date ? String(c.invoice_date).slice(0, 10) : '—')),
                U.td(U.ltr(c.total != null ? String(c.total) + ' ' + (c.currency || 'SAR') : '—'), 'num'),
                U.td(tx.id ? el('a', { class: 'btn btn-sm btn-secondary', href: '#tx/' + tx.id, 'data-act': 'li-dft-review', text: lt('dft_review') }) : '—')
              ]);
            }), { caption: lt('dft_title') }));
          if ((+res.data.total || 0) > items.length) box.appendChild(el('p', { class: 'text-xs text-muted', text: lt('dft_more', { n: num(items.length), t: num(res.data.total) }) }));
        });
      }
      function legacyInvoiceCell(tx, c) {
        var parts = [];
        if (tx.legacy_invoice_no) parts.push(el('div', { 'data-li': 'no' }, U.ltr(tx.legacy_invoice_no)));
        else if (tx.legacy_invoice_id) parts.push(el('div', { 'data-li': 'id', class: 'text-xs' }, [lt('dft_legacy_id') + ' ', U.ltr(tx.legacy_invoice_id)]));
        if (tx.legacy_reference) parts.push(el('div', { 'data-li': 'ref', class: 'text-xs text-muted' }, [lt('dft_legacy_reference') + ' ', U.ltr(tx.legacy_reference)]));
        if (c.match && c.match.reference === true) parts.push(el('div', { 'data-li': 'by-ref' }, U.pill('info', lt('dft_by_reference'))));
        return parts.length ? el('div', { class: 'limp-legacy-inv' }, parts) : '—';
      }
      var card = U.card(lt('dft_title'), [el('p', { class: 'text-sm', text: info }), U.alertBox('info', lt('dft_never_auto')), el('div', { class: 'rpt-form-actions' }, [q, refresh]), box], null, { cls: 'limp-dft' });
      fetchCands();
      return card;
    }

    /* -------------------------------------------------------------- files → sheets → stage */
    function filesPanel() {
      var adding = !!run;
      var input = el('input', { type: 'file', id: 'limp-files', class: 'lrpt-file-input', accept: '.xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv', multiple: true });
      var list = el('ul', { class: 'lrpt-file-list limp-file-list', 'aria-live': 'polite' });
      var err = el('p', { class: 'rpt-form-error', role: 'alert', hidden: true });
      var readB = U.btn(lt('read_files'), 'btn-primary', function () { readAll(); }, { 'data-act': 'li-read' });
      var clearB = U.btn(lt('clear_files'), 'btn-ghost', function () { ST.files = []; ST.parsed = []; ST.sheets = []; ST.rejectedFiles = []; draw(); }, { 'data-act': 'li-clear' });
      function showErr(m) { err.hidden = !m; err.textContent = m || ''; }
      function paintFiles() {
        U.clear(list);
        ST.files.forEach(function (f, i) {
          var rm = U.btn(lt('remove'), 'btn-ghost btn-sm', function () { ST.files.splice(i, 1); ST.parsed = []; ST.sheets = []; paintFiles(); paintSheets(); }, { 'aria-label': lt('remove_file', { f: f.name }) });
          list.appendChild(el('li', null, [el('bdi', { dir: 'auto', class: 'lrpt-file-name', text: f.name }), el('span', { class: 'text-xs text-muted', text: ' · ' + lt('size_kb', { kb: Math.max(1, Math.round((f.size || 0) / 1024)) }) }), rm]));
        });
        readB.disabled = !ST.files.length;
      }
      function addFiles(fl) {
        var arr = Array.prototype.slice.call(fl || []), msg = null;
        arr.forEach(function (f) {
          if (!f) return;
          if (ST.files.length >= LIMITS.files) { msg = lt('err_files', { n: LIMITS.files }); return; }
          if (!kindOf(f.name)) { msg = lt('err_type', { f: str(f.name) }); return; }
          if (f.size > LIMITS.fileBytes) { msg = lt('err_too_big', { f: str(f.name), mb: LIMITS.fileBytes / 1048576 }); return; }
          if (ST.files.some(function (x) { return x.name === f.name && x.size === f.size; })) return;
          ST.files.push(f);
        });
        ST.parsed = []; ST.sheets = [];
        showErr(msg); paintFiles(); paintSheets();
      }
      input.addEventListener('change', function () { addFiles(input.files); try { input.value = ''; } catch (e) { /* ignore */ } });
      var drop = el('label', { class: 'lrpt-drop limp-drop', for: 'limp-files' }, [el('span', { class: 'lrpt-drop-title', text: lt('pick') }), el('span', { class: 'text-xs text-muted', text: lt('pick_hint', { n: LIMITS.files, mb: LIMITS.fileBytes / 1048576 }) })]);
      ['dragover', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { if (e && e.preventDefault) e.preventDefault(); if (ev === 'drop' && e.dataTransfer) addFiles(e.dataTransfer.files); }); });
      var sheetsBox = el('div', { class: 'app-stack limp-sheets' });
      function readAll() {
        if (!ST.files.length) return;
        showErr(null); readB.disabled = true;
        var job = parseFiles(ST.files, function (i) { progressText(lt('reading_n', { n: i + 1, t: ST.files.length })); });
        progress('limp_read', job, lt('reading'), true).then(function (parsed) {
          readB.disabled = false;
          if (!sc.alive()) return;
          ST.parsed = parsed;
          ST.rejectedFiles = parsed.filter(function (p) { return p.error; });
          ST.sheets = sheetsFrom(parsed, ST.idx);
          ST.sheets.forEach(rebuild);
          status.textContent = lt('read_done', { n: num(ST.sheets.length) });
          paintSheets();
        }, function () { readB.disabled = false; });
      }
      function paintSheets() {
        U.clear(sheetsBox);
        ST.rejectedFiles.forEach(function (b) { sheetsBox.appendChild(U.alertBox('warning', lt('file_err_' + b.error, { f: b.file, mb: LIMITS.fileBytes / 1048576, n: LIMITS.rowsPerSheet }))); });
        if (!ST.sheets.length) return;
        ST.sheets.forEach(function (s) { sheetsBox.appendChild(sheetCard(s, adding)); });
        createHost = el('div', { class: 'limp-create-host' }); createHost.__adding = adding;
        sheetsBox.appendChild(createHost); refreshCreate();
      }
      paintFiles();
      var card = U.card(adding ? lt('files_add_title') : lt('files_title'), [adding ? el('p', { class: 'text-xs text-muted', text: lt('files_add_hint') }) : stepper(null), drop, input, list, err,
        el('div', { class: 'rpt-form-actions' }, [readB, clearB]), sheetsBox], null, { cls: 'limp-files' });
      paintSheets();
      return card;
    }
    var createHost = null;
    function refreshCreate() { if (!createHost) return; U.clear(createHost); createHost.appendChild(createCard(createHost.__adding)); }
    function rebuild(s) {
      var ent = s.entity && ST.idx ? ST.idx.byEntity[s.entity] : null;
      s.built = ent && s.headerRow >= 0 ? buildRows(s.rows, s.headerRow, s.columns) : { rows: [], rejected: [], empty: 0 };
      s.missing = missingRequired(s.columns, ent);
    }
    function sheetCard(s, adding) {
      var idx = ST.idx, ent = s.entity ? idx.byEntity[s.entity] : null;
      var allowed = adding && run ? run.entities || [] : ENTITIES;
      // a sheet of an entity the open run does not carry is left out (the server would refuse it: MRS_INVALID entity)
      if (adding && s.entity && allowed.indexOf(s.entity) === -1) { s.entity = ''; s.include = false; s.columns = []; rebuild(s); ent = null; }
      var entSel = U.select('entity', lt('sheet_entity'), [['', lt('sheet_ignore')]].concat(idx.list.filter(function (e) { return allowed.indexOf(e.entity) !== -1; }).map(function (e) { return [e.entity, entLabel(e.entity)]; })), s.entity || '', function (v) {
        s.entity = v; s.include = !!v;
        var e2 = v ? idx.byEntity[v] : null;
        if (e2 && s.headerRow < 0) { var d2 = detectSheet('', s.rows, { list: [e2], byEntity: idx.byEntity }); s.headerRow = d2.headerRow >= 0 ? d2.headerRow : 0; }
        s.columns = s.headerRow >= 0 ? mapColumns(s.rows[s.headerRow] || [], e2) : [];
        rebuild(s); redraw();
      });
      var headSel = U.select('header_row', lt('sheet_header_row'), Array.apply(null, { length: Math.min(LIMITS.headerScan, s.rows.length) }).map(function (x, i) { return [String(i), lt('row_n', { n: i + 1 })]; }), String(Math.max(0, s.headerRow)), function (v) {
        s.headerRow = +v; s.columns = mapColumns(s.rows[s.headerRow] || [], ent); rebuild(s); redraw();
      });
      var node = el('div');
      function redraw() { var n = sheetCard(s, adding), par = node.parentNode; if (par) { par.insertBefore(n, node); par.removeChild(node); } node = n; refreshCreate(); }
      var by = s.det.by === 'sheet' ? lt('det_by_sheet') : s.det.by === 'headers' ? lt('det_by_headers', { n: s.det.score }) : lt('det_none');
      var kids = [el('p', { class: 'text-xs text-muted', text: by }), el('div', { class: 'limp-sheet-tools' }, [
        el('label', { class: 'limp-field' }, [el('span', { class: 'limp-field-label', text: lt('sheet_entity') }), entSel]),
        el('label', { class: 'limp-field' }, [el('span', { class: 'limp-field-label', text: lt('sheet_header_row') }), headSel])])];
      if (adding && s.det.entity && allowed.indexOf(s.det.entity) === -1) kids.push(U.alertBox('warning', lt('entity_not_in_run', { e: entLabel(s.det.entity) })));
      if (ent) {
        var b = s.built || { rows: [], rejected: [], empty: 0 };
        kids.push(el('p', { class: 'text-sm limp-sheet-count', text: lt('sheet_rows', { n: num(b.rows.length), r: num(b.rejected.length), e: num(b.empty) }) }));
        if (s.missing.length) kids.push(U.alertBox('danger', lt('missing_required', { f: s.missing.map(function (k) { var f = fieldOf(ent, k); return f ? f.label : k; }).join(lt('sep')) })));
        kids.push(mappingDetails(s, ent, redraw));
        kids.push(previewTable(s, ent));
      }
      node = U.card(lt('sheet_title', { s: s.name, f: s.file }), kids, null, { cls: 'limp-sheet' + (s.include ? '' : ' is-ignored') });
      node.setAttribute('data-sheet', s.id);
      return node;
    }
    function mappingDetails(s, ent, redraw) {
      var opts = [['', lt('col_unmapped')]].concat(ent.fields.map(function (f) { return [f.key, f.label + (f.required ? ' *' : '')]; }));
      var trs = s.columns.filter(function (c) { return c.header; }).map(function (c) {
        var sel = U.select('col_' + c.index, lt('col_map_for', { h: c.header }), opts, c.key || '', function (v) { s.columns = setColumn(s.columns, c.index, v || null); rebuild(s); redraw(); });
        return el('tr', { 'data-col': String(c.index), 'data-key': c.key || '' }, [U.td(bdi(c.header)), U.td(sel), U.td(c.key ? U.pill(c.auto ? 'success' : 'info', lt(c.auto ? 'col_auto' : 'col_manual')) : c.dup ? U.pill('warning', lt('col_dup')) : U.pill('neutral', lt('col_ignored')))]);
      });
      var mappedN = s.columns.filter(function (c) { return c.key; }).length;
      var det = el('details', { class: 'limp-mapping' }, [el('summary', { class: 'limp-mapping-sum', text: lt('mapping_sum', { n: mappedN, t: s.columns.filter(function (c) { return c.header; }).length }) }),
        U.table([lt('c_header'), lt('c_field'), lt('c_state')], trs, { caption: lt('mapping_sum', { n: mappedN, t: s.columns.length }) })]);
      if (s.missing && s.missing.length) det.open = true;
      return det;
    }
    function previewTable(s, ent) {
      var mapped = s.columns.filter(function (c) { return c.key; }), rows = (s.built ? s.built.rows : []).slice(0, LIMITS.previewRows);
      if (!rows.length) return U.emptyState('inbox', null, lt('preview_empty'), null, true);
      var trs = rows.map(function (r) {
        var m = localCheck(ent, r.data), lv = levelOf(m);
        return el('tr', { class: 'limp-row limp-row-' + lv, 'data-level': lv }, [U.td(U.ltr(String(r.row_no)), 'num'),
          U.td([U.pill(lv === 'error' ? 'danger' : lv === 'warning' ? 'warning' : 'success', lt('pre_' + lv)),
            m.length ? el('ul', { class: 'limp-msgs' }, m.slice(0, 4).map(function (x) { return el('li', { class: 'limp-msg is-' + x.level, text: msgText(x, labels) }); })) : null])]
          .concat(mapped.map(function (c) {
            var v = r.data[c.key] || '', d = /(^|_)(date|at|deadline)$|last_used/.test(c.key) && !/hijri/.test(c.key) && v ? normDate(v) : '';
            return U.td(v ? [bdi(v.length > 80 ? v.slice(0, 80) + '…' : v), d && d !== v ? el('span', { class: 'cell-sub', text: lt('as_riyadh', { d: d }) }) : null] : '—');
          })));
      });
      return el('div', { class: 'limp-preview' }, [el('h4', { class: 'limp-sub', text: lt('preview_title', { n: rows.length }) }),
        U.table([{ label: lt('c_row'), num: true }, lt('c_precheck')].concat(mapped.map(function (c) { var f = fieldOf(ent, c.key); return f ? f.label : c.key; })), trs, { caption: lt('preview_title', { n: rows.length }) }),
        el('p', { class: 'text-xs text-muted', text: lt('precheck_hint') })]);
    }
    function createCard(adding) {
      var inc = ST.sheets.filter(function (s) { return s.include && s.entity && s.built && s.built.rows.length && (!adding || !run || (run.entities || []).indexOf(s.entity) !== -1); });
      var blocked = inc.filter(function (s) { return s.missing.length; });
      var ents = entitiesOf(inc);
      var total = inc.reduce(function (n, s) { return n + s.built.rows.length; }, 0);
      var err = el('p', { class: 'rpt-form-error', role: 'alert', hidden: true });
      var kids = [el('p', { class: 'text-sm', text: lt('create_summary', { s: num(inc.length), n: num(total), e: ents.map(entLabel).join(lt('sep')) || '—' }) })];
      if (total > LIMITS.runRows) kids.push(U.alertBox('danger', lt('too_many_rows', { n: num(LIMITS.runRows) })));
      if (blocked.length) kids.push(U.alertBox('warning', lt('blocked_sheets', { s: blocked.map(function (s) { return s.name; }).join(lt('sep')) })));
      var reason = null, branchSel = null, fundSel = null;
      if (!adding) {
        reason = el('textarea', { class: 'form-control', name: 'reason', rows: '2', maxlength: '500', 'aria-label': lt('reason'), placeholder: lt('reason_ph') });
        branchSel = U.select('branch_id', lt('o_branch'), [['', lt('branch_per_row')]].concat((api.branches || []).map(function (b) { return [b.id, (isEn() && b.name_en) || b.name_ar || b.id]; })), (api.branches || []).length === 1 ? api.branches[0].id : '');
        fundSel = U.select('default_funding_source', lt('o_funding'), [['', lt('o_none')]].concat(FUNDING.map(function (f) { return [f, lt('fund_' + f)]; })), '');
        kids.push(el('label', { class: 'limp-field is-full' }, [el('span', { class: 'limp-field-label', text: lt('reason') + ' *' }), reason]));
        kids.push(el('div', { class: 'limp-options' }, [el('label', { class: 'limp-field' }, [el('span', { class: 'limp-field-label', text: lt('o_branch') }), branchSel]),
          el('label', { class: 'limp-field' }, [el('span', { class: 'limp-field-label', text: lt('o_funding') }), fundSel])]));
      }
      var go = U.btn(adding ? lt('stage_more') : lt('create_and_stage'), 'btn-primary', function () {
        err.hidden = true;
        if (!inc.length || total > LIMITS.runRows || blocked.length) return;
        if (!adding && str(reason.value).length < 3) { err.hidden = false; err.textContent = lt('reason_short'); return; }
        startStage(adding, adding ? null : { reason: str(reason.value), branch_id: branchSel.value || null, fund: fundSel.value || null }, inc, ents, err, go);
      }, { 'data-act': adding ? 'li-stage-more' : 'li-create' });
      go.disabled = !inc.length || total > LIMITS.runRows || !!blocked.length;
      kids.push(err, el('div', { class: 'rpt-form-actions' }, [go]));
      return U.card(adding ? lt('stage_title') : lt('create_title'), kids, null, { cls: 'limp-create' });
    }
    function startStage(adding, p, sheets, ents, err, btn) {
      btn.disabled = true;
      var runP;
      if (adding) runP = Promise.resolve({ data: run });
      else {
        var files = runFiles(ST.parsed, sheets);
        var payload = { entities: ents, files: files, reason: p.reason, mapping: {}, options: { daftra_invoice_prefix: 'RHK-' } };
        if (p.branch_id) payload.branch_id = p.branch_id;
        if (p.fund) payload.options.default_funding_source = p.fund;
        var key = idem('limp-create', payload);
        runP = call('legacyImportCreateRun', payload, { orgId: api.orgId, idemKey: key }).then(function (r) { U.idemSettle('limp-create', r.error); return r; });
      }
      runP.then(function (r) {
        if (r.error) { btn.disabled = false; err.hidden = false; err.textContent = errText(r.error); return; }
        run = r.data; ST.runId = run.id;
        stopFlag = false;
        var plan = [];
        // the first chunk of a sheet replaces what was staged before under that label (a corrected file: deleted / moved lines go)
        sheets.forEach(function (s) { chunkRows(s.built.rows).forEach(function (c, ci) { plan.push({ s: s, rows: c, first: ci === 0 }); }); });
        var sent = 0, totals = { inserted: 0, replaced: 0, unchanged: 0, removed: 0, dropped_keys: 0 }, i = 0;
        var all = plan.reduce(function (n, x) { return n + x.rows.length; }, 0);
        var job = (function next() {
          if (stopFlag || i >= plan.length) return Promise.resolve({ done: i >= plan.length, stopped: stopFlag && i < plan.length });
          var x = plan[i];
          var payloadRows = x.rows.map(function (rw) { var d = {}; Object.keys(rw.data).forEach(function (k) { d[k] = rw.data[k]; }); return { row_no: rw.row_no, data: d }; });
          return loop({ limit: 1, min: 1, step: function () { return call('legacyImportStage', run.id, x.s.entity, x.s.label, payloadRows, { replace: x.first }); }, isDone: function () { return true; },
            onData: function (d) { if (d && d.run) run = d.run; Object.keys(totals).forEach(function (k) { totals[k] += (d && +d[k]) || 0; }); } }).then(function (res) {
            if (res.error) return { error: res.error };
            sent += x.rows.length; i++;
            progressText(lt('staging_n', { n: num(sent), t: num(all) }));
            return next();
          });
        })();
        progress('limp_stage', job, lt('staging'), true).then(function (res) {
          btn.disabled = false;
          if (!sc.alive()) return;
          if (res.error) { err.hidden = false; err.textContent = errText(res.error); reloadRun(); return; }
          if (res.stopped) { status.textContent = lt('stopped'); reloadRun(); return; }
          status.textContent = lt('staged_ok', { i: num(totals.inserted), r: num(totals.replaced), u: num(totals.unchanged), x: num(totals.removed) });
          // the rows refused in this browser stay listed in this run's error report; the parsed files are let go
          ST.rejectedRows = { runId: run.id, rows: (ST.rejectedRows && ST.rejectedRows.runId === run.id ? ST.rejectedRows.rows : []).concat(refusedOf(sheets)) };
          ST.files = []; ST.parsed = []; ST.sheets = []; ST.rejectedFiles = [];
          // validation is a dry run (nothing is written outside the run): start it at once
          doValidate();
        }, function () { stopFlag = true; btn.disabled = false; afterCancel(); });
      });
    }

    /* -------------------------------------------------------------- past runs */
    function runsPanel() {
      if (!runs.length) return U.card(lt('runs_title'), U.emptyState('history', null, lt('runs_none'), null, true), null, { cls: 'limp-runs' });
      var trs = runs.map(function (x) {
        var view = el('a', { class: 'btn btn-sm btn-ghost', href: '#legacy_import/' + x.id, 'data-act': 'li-open-run', text: lt('open_run') });
        var acts = [view];
        if (x.status === 'committed' || x.status === 'draft' || x.status === 'staged' || x.status === 'validated') acts.push(U.btn(lt('act_void'), 'btn-ghost btn-sm', function () { doVoid(x); }, { 'data-act': 'li-void-run' }));
        if (x.status === 'voiding') acts.push(U.btn(lt('act_resume_void'), 'btn-ghost btn-sm', function () { runVoid(x, x.void_reason || lt('void_dry_reason')); }, { 'data-act': 'li-void-resume-run' }));
        return el('tr', { 'data-run': x.id, 'data-status': x.status }, [U.td(bdi(x.ref, 'ltr')), U.td(U.pill(TONES[x.status] || 'neutral', runStLabel(x.status))),
          U.td((x.entities || []).map(entLabel).join(lt('sep')) || '—'), U.td(U.ltr(num(x.counts ? x.counts.total : 0)), 'num'),
          U.td(U.ltr(num(statusCount(x, 'committed'))), 'num'), U.td(when(x.created_at)), U.td(x.created_by_name || '—'), U.td(el('span', { class: 'limp-row-acts' }, acts))]);
      });
      return U.card(lt('runs_title') + ' (' + num(runsTotal) + ')', U.table([lt('m_ref'), lt('m_status'), lt('m_entities'), { label: lt('k_total'), num: true }, { label: lt('k_committed'), num: true },
        lt('m_created'), lt('m_by'), lt('c_actions')], trs, { caption: lt('runs_title') }), null, { flush: true, cls: 'limp-runs' });
    }

    load();
  }

  Ops.views.legacy_import = {
    // the org OWNER only (admin.js / app-shell.js read owner: true; the server refuses anyone else with MRS_FORBIDDEN owner_only)
    allow: 'orgAdmin', owner: true, titleKey: 'limp.nav_legacy_import', icon: 'upload',
    render: function (root, api, param) { return render(root, api, param); },
    _reset: function () { resetState(null); }, _state: function () { return ST; }
  };
})();
