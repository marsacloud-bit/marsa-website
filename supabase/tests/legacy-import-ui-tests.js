#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy step 9 «استيراد بيانات النظام القديم» UI tests: assets/js/imp/legacy-import.js (#legacy_import +
  MarsaOps.legacyImport), assets/i18n/limp.js, the wiring (admin.html, sw.js, app-shell.js owner nav item, admin.js owner views,
  pages/limp.css) and the contract with 20261125000100 (the dictionary of legacy headers, the labels, the MarsaApi wrappers).
  Pure Node, no database, no network (vm + window shim + supabase/tests/lib/fake-dom.js; the real MarsaOps.ui / XlsxLite /
  MarsaExport / MarsaXlsx are loaded). Every sample is invented data.

  Covers: ES5 + no innerHTML; dictionary parity; header detection per entity (sheet name first, then the best header overlap;
  headers repeated across entities); the column mapping + manual override; normalisers (Arabic-Indic digits, Excel serials,
  dd/mm/yyyy [hh:mm ص/م], ISO with a zone → Riyadh, Hijri years refused, never the device zone); ISO 6346; rows (row numbers,
  empty rows, the 2000-character and 16 KB limits, dictionary keys only); chunking ≤ 500 rows / ~1.8 MB; the resumable loop
  (timeout → half the chunk, MRS_LI_BUSY → wait, stop); prototype safety; sha-256; file reading (xlsx, CSV with BOM, refused
  types / sizes); DOM flows: owner only, files → detection → mapping → create + stage + validate → review (rows, report CSV with
  the formula guard, XLSX) → commit with confirmation (timeout retried with a smaller chunk, confirm only on the first call) →
  RHK- lookups + candidates handed to the transaction's step-7 confirm flow (never linked here) → void (blockers listed; then
  void with a reason), resume of a committing run.

  usage:  node supabase/tests/legacy-import-ui-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');
const { makeDom } = require('./lib/fake-dom.js');

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const J = JSON.stringify;

let pass = 0, fail = 0;
const fails = [];
let sec = '';
function section(t) { sec = t; if (!QUIET) console.log('\n== ' + t); }
function check(name, fn) {
  let r;
  try { r = fn(); } catch (e) { r = 'threw: ' + (e && e.stack || e); }
  if (r !== true && r && typeof r === 'object') { try { JSON.stringify(r); } catch (e) { r = 'got a non-true value (' + (r.tagName || typeof r) + ')'; } }
  if (r === true) { pass++; if (!QUIET) console.log('  ok  ' + name); }
  else { fail++; fails.push(sec + ' :: ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); if (!QUIET) console.log('  FAIL ' + name + ' → ' + (typeof r === 'string' ? r : J(r))); }
}
async function acheck(name, fn) { let r; try { r = await fn(); } catch (e) { r = 'threw: ' + (e && e.stack || e); } check(name, () => r); }
function eq(name, got, want) { check(name, () => J(got) === J(want) || ('got ' + J(got) + ' want ' + J(want))); }
const settle = (ms) => new Promise(r => setTimeout(r, ms || 0));
async function until(fn, ms) { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (fn()) return true; await settle(5); } return false; }

/* ------------------------------------------------------------ sources */
const F = {
  view: 'assets/js/imp/legacy-import.js', dict: 'assets/i18n/limp.js', alerts: 'assets/js/ops/alerts.js', xlite: 'assets/js/xlsx-lite.js',
  xlsx: 'assets/js/rpt/xlsx.js', exp: 'assets/js/rpt/export.js', rptDict: 'assets/i18n/rpt.js', lrptDict: 'assets/i18n/lrpt.js', opsDict: 'assets/i18n/ops.js',
  shell: 'assets/js/app-shell.js', admin: 'assets/js/admin.js', supa: 'assets/js/supa.js', i18n: 'assets/js/i18n.js'
};
const SRC = {}; Object.keys(F).forEach(k => { SRC[k] = rd(F[k]); });
const MIG = rd('supabase/migrations/20261125000100_legacy_import.sql');
const ADMIN_HTML = rd('admin.html'), SW = rd('sw.js'), CSS = rd('assets/css/pages/limp.css'), PLAN = rd('docs/online/LEGACY_PORT_PLAN_AR.md'), GUIDE = rd('docs/online/LEGACY_IMPORT_AR.md');
// the server's dictionary of legacy headers (app.li_dictionary) and labels (status_labels rows) — the contract the page reads
const DICT_ENTITIES = JSON.parse(/app\.li_dictionary\(\)[\s\S]*?SELECT \$j\$([\s\S]*?)\$j\$/.exec(MIG)[1]);
const LABEL_ROWS = [...MIG.matchAll(/\('(li_entity|li_run_status|li_row_status|li_message)','([a-z_0-9]+)',\d+,'([^']*)','([^']*)',(?:true|false)\)/g)];
const LABELS = {};
LABEL_ROWS.forEach(m => { (LABELS[m[1]] = LABELS[m[1]] || {})[m[2]] = { ar: m[3], en: m[4] }; });
const SERVER_DICT = { version: '20261125000100', entities: DICT_ENTITIES, labels: LABELS,
  limits: { files: 20, file_bytes: 10485760, rows_per_call: 500, row_bytes: 16384, call_bytes: 2097152, rows_per_run: 50000, value_chars: 2000, validate_per_call: 500, commit_per_call: 200, validate_default: 300, commit_default: 100 },
  defaults: { funding_sources: ['org_account', 'cash_box', 'fasah_wallet', 'dry_port_wallet_org', 'client_custody', 'client_custody_dry_port', 'personal_account'], movement_types: ['org_paid', 'received_from_client', 'client_direct'] } };

/* ------------------------------------------------------------ a browser-like context */
const dicts = { ar: {}, en: {} };
let LANG = 'ar';
const I18N = {
  register(ns, d) { ['ar', 'en'].forEach(l => Object.keys((d && d[l]) || {}).forEach(k => { dicts[l][ns + '.' + k] = d[l][k]; })); },
  t(key, vars) {
    let s = dicts[LANG][key] != null ? dicts[LANG][key] : (dicts.ar[key] != null ? dicts.ar[key] : key);
    if (vars) Object.keys(vars).forEach(k => { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  },
  has(key) { return dicts.ar[key] != null; },
  label(domain, code) { return String(code); },
  lang() { return LANG; }
};
function makeStorage() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; }
function context(o) {
  o = o || {};
  const { document, Node } = makeDom();
  document.documentElement = new Node('html');
  document.documentElement.dir = 'rtl';
  document.activeElement = null;
  document.contains = () => true;
  document.removeEventListener = () => {};
  const downloads = [];
  const w = { MarsaI18n: I18N, document, localStorage: makeStorage(), sessionStorage: makeStorage(), open: () => null, confirm: () => true, print: () => {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, innerWidth: 375, innerHeight: 800,
    URL: { createObjectURL: b => { downloads.push(b); return 'blob:x'; }, revokeObjectURL() {} } };
  if (o.crypto) w.crypto = nodeCrypto.webcrypto;
  if (o.shell) w.MarsaShell = o.shell;
  w.window = w;
  const c = { window: w, document, localStorage: w.localStorage, location: { hash: '' }, history: { replaceState() {} },
    Intl, Date, Math, String, Object, Array, JSON, Number, RegExp, parseInt, parseFloat, isFinite, isNaN, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    encodeURIComponent, decodeURIComponent, Error, TextDecoder, TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, Blob, Response, DecompressionStream,
    Event: function (t, x) { this.type = t; Object.assign(this, x || {}); }, CustomEvent: function (t) { this.type = t; }, console };
  vm.createContext(c);
  ['rptDict', 'lrptDict', 'opsDict', 'dict', 'alerts', 'xlite', 'xlsx', 'exp', 'view'].forEach(k => vm.runInContext(SRC[k], c, { filename: F[k] }));
  return { document, w, c, downloads };
}
const base = context();
const LI = base.w.MarsaOps.legacyImport;
LI.LIMITS.busyWaitMs = 1;
const IDX = LI.dictIndex(SERVER_DICT);

/* ================================================================ static */
section('static: classic scripts, ES5 only, no innerHTML, compile');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
['view', 'dict'].forEach(k => {
  check(F[k] + ': IIFE + strict, ES5 only (no let/const/arrow/template/class), no innerHTML / eval', () => {
    const s = strip(SRC[k]);
    return (/^\(function \(/m.test(s) && /'use strict';/.test(s) && !/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s) && !/\bclass\s+\w/.test(s)
      && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(s)) || 'not ES5 / uses HTML';
  });
});
['admin', 'shell'].forEach(k => check(F[k] + ': still ES5 after the step-9 changes', () => { const s = strip(SRC[k]); return (!/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s)) || F[k]; }));
check('every new / changed file compiles (node --check equivalent)', () => {
  Object.keys(F).forEach(k => new vm.Script(SRC[k], { filename: F[k] }));
  new vm.Script(SW, { filename: 'sw.js' });
  return true;
});
check('the view registers #legacy_import for the OWNER only (allow orgAdmin + owner: true) and the pure helpers on MarsaOps.legacyImport', () => {
  const v = base.w.MarsaOps.views.legacy_import;
  return (v && v.allow === 'orgAdmin' && v.owner === true && typeof v.render === 'function' && LI && LI.VERSION === 'limp-1') || 'view';
});
check('the page never approves, verifies, links or bills: no confirmInvoiceLink / approve* / billing / Daftra-draft calls; data through textContent', () => {
  const s = strip(SRC.view);
  const calls = [...s.matchAll(/call\('([a-zA-Z]+)'/g)].map(m => m[1]).filter((x, i, a) => a.indexOf(x) === i).sort();
  const allowed = ['legacyImportCommit', 'legacyImportCreateRun', 'legacyImportDaftraCandidates', 'legacyImportDictionary', 'legacyImportGetRun', 'legacyImportListRows',
    'legacyImportListRuns', 'legacyImportQueueDaftra', 'legacyImportSetOptions', 'legacyImportSkipRows', 'legacyImportStage', 'legacyImportValidate', 'legacyImportVoid',
    'listClients', 'listCustomsPorts', 'listServiceItems'];
  return (calls.every(c => allowed.indexOf(c) !== -1) && !/confirmInvoiceLink|rejectInvoiceCandidate|approve[A-Z]\w*\(|verify[A-Z]\w*\(|createBillingIntent|pushDaftra|createDaftraDraft|reviewPayment/.test(s)) || J(calls);
});
check('every MarsaApi function the page calls is exported by supa.js', () => {
  const s = strip(SRC.view), names = [...s.matchAll(/call\('([a-zA-Z]+)'/g)].map(m => m[1]).filter((x, i, a) => a.indexOf(x) === i);
  const miss = names.filter(n => !new RegExp('\\b' + n + ': ' + n + '\\b').test(SRC.supa));
  return !miss.length || miss;
});

/* ================================================================ dictionary */
section('dictionary limp (ar = en keys, {vars} parity, every key used exists, the label families = the migration rows)');
const D = base.w.MarsaLimpDict;
check('ar and en have the same keys (and > 250 of them)', () => {
  const a = Object.keys(D.ar), e = Object.keys(D.en);
  return (a.length > 250 && a.length === e.length && a.every(k => k in D.en)) || J([a.length, a.filter(k => !(k in D.en)), e.filter(k => !(k in D.ar))]);
});
check('{vars} parity between ar and en', () => {
  const bad = Object.keys(D.ar).filter(k => (D.ar[k].match(/\{\w+\}/g) || []).sort().join() !== (D.en[k].match(/\{\w+\}/g) || []).sort().join());
  return !bad.length || bad;
});
check('every literal lt() key of the view exists', () => {
  const keys = [...SRC.view.matchAll(/\blt\('([a-z0-9_]+)'/g)].map(m => m[1]).filter(k => !/_$/.test(k));
  const extra = ['validated_ok', 'committed_ok', 'skipped_n', 'unskipped_n', 'col_auto', 'col_manual', 'act_revalidate', 'act_validate', 'dft_requeue', 'dft_queue',
    'void_text_committed', 'void_text_open', 'commit_li_1', 'commit_li_2', 'commit_li_3', 'commit_li_4', 'commit_li_5',
    'k_total', 'k_valid', 'k_warning', 'k_error', 'k_duplicate', 'k_skipped', 'k_pending', 'k_committed'];
  const miss = keys.concat(extra).filter((k, i, a) => a.indexOf(k) === i && !(k in D.ar));
  return !miss.length || miss;
});
check('every dynamic family is complete (funding, movement types, mapping kinds, file errors, pre-check levels, candidate states, void blockers, tables)', () => {
  const tables = [...new Set([...MIG.matchAll(/li_c\('([a-z_]+)'/g)].map(m => m[1]))];
  const need = [].concat(LI.FUNDING.map(x => 'fund_' + x), LI.MOVEMENT_TYPES.map(x => 'mt_' + x), LI.MAP_KINDS.map(x => 'map_' + x), LI.MAP_KINDS.map(x => 'map_hint_' + x),
    ['type', 'empty', 'too_big', 'no_reader', 'xls', 'unreadable', 'inflate_big', 'too_many_rows', 'too_wide'].map(x => 'file_err_' + x), ['valid', 'warning', 'error'].map(x => 'pre_' + x),
    ['error', 'warning', 'info'].map(x => 'lvl_' + x), ['open', 'review', 'blocked', 'partial'].map(x => 'cand_' + x),
    ['changed', 'missing', 'added_later', 'billing', 'daftra_sync_in_flight', 'payment'].map(x => 'bl_' + x), tables.map(x => 'tbl_' + x),
    ['required', 'too_long', 'row_too_big', 'container_format', 'container_check_digit', 'invalid_date', 'invalid_datetime'].map(x => 'msg_' + x));
  const miss = need.filter(k => !(k in D.ar));
  return (!miss.length && tables.length >= 10) || miss;
});
check('the fallback labels ent_ / run_st_ / row_st_ = the 20261125000100 status_labels rows (ar + en); the local msg_ codes = the server texts', () => {
  const pre = { li_entity: 'ent_', li_run_status: 'run_st_', li_row_status: 'row_st_' };
  const bad = LABEL_ROWS.filter(m => pre[m[1]]).filter(m => D.ar[pre[m[1]] + m[2]] !== m[3] || D.en[pre[m[1]] + m[2]] !== m[4]).map(m => m[1] + '.' + m[2]);
  const msgBad = ['required', 'too_long', 'container_format', 'container_check_digit', 'invalid_date', 'invalid_datetime'].filter(c => D.ar['msg_' + c] !== LABELS.li_message[c].ar || D.en['msg_' + c] !== LABELS.li_message[c].en);
  const n = LABEL_ROWS.filter(m => pre[m[1]]).length;
  return (!bad.length && !msgBad.length && n === 22 && Object.keys(LABELS.li_message).length >= 92) || J({ bad, msgBad, n });
});
check('the view constants match the server: entities (order), funding sources, movement types, limits, mapping kinds', () =>
  (J(LI.ENTITIES) === J(DICT_ENTITIES.map(e => e.entity)) && J(LI.FUNDING) === J(SERVER_DICT.defaults.funding_sources) && J(LI.MOVEMENT_TYPES) === J(SERVER_DICT.defaults.movement_types)
    && /'branch_id','entities','files','mapping','options','reason'/.test(MIG) && /ARRAY\['ports','service_items','clients','branches'\]/.test(MIG) && J(LI.MAP_KINDS) === J(['ports', 'service_items', 'clients', 'branches'])
    && LI.LIMITS.files === 20 && LI.LIMITS.fileBytes === 10485760 && LI.LIMITS.stageRows === 500 && LI.LIMITS.rowBytes === 16384 && LI.LIMITS.valueChars === 2000
    && LI.LIMITS.callBytes < 2097152 && LI.LIMITS.runRows === 50000 && LI.LIMITS.validateLimit === 300 && LI.LIMITS.commitLimit === 100
    && /> 2000 THEN PERFORM app\.fin_fail\('MRS_TOO_LONG', 'value'/.test(MIG) && /octet_length\(v_clean::text\) > 16384/.test(MIG)) || 'constants');
check('the mapping hints point at message codes the server emits', () => Object.keys(LI.MAP_HINTS).every(c => LABELS.li_message[c]) || Object.keys(LI.MAP_HINTS));

/* ================================================================ wiring */
section('wiring: admin.html, sw.js, owner nav (app-shell.js + admin.js), CSS');
function order(html, list) { let i = -1; return list.every(f => { const j = html.indexOf('src="' + f + '"'); const okk = j > i; i = j; return okk && j !== -1; }); }
check('admin.html: limp.css after lrpt.css; i18n/limp.js after i18n.js; imp/legacy-import.js after xlsx-lite / ops/alerts / rpt/xlsx / rpt/export and before admin.js', () =>
  (ADMIN_HTML.indexOf('pages/limp.css') > ADMIN_HTML.indexOf('pages/lrpt.css') && ADMIN_HTML.indexOf('pages/lrpt.css') > 0
    && order(ADMIN_HTML, ['assets/js/i18n.js', 'assets/i18n/lrpt.js', 'assets/i18n/limp.js', 'assets/js/supa.js', 'assets/js/app-shell.js', 'assets/js/legacy-norm.js', 'assets/js/xlsx-lite.js',
      'assets/js/ops/alerts.js', 'assets/js/rpt/xlsx.js', 'assets/js/rpt/export.js', 'assets/js/rpt/rules.js', 'assets/js/imp/legacy-import.js', 'assets/js/admin.js'])) || 'order');
check('sw.js: VERSION bumped past step 8 (2026-11-24.3) with a comment, the three new files precached', () => {
  const v = (/^var VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)';\s+\/\/ legacy step 9/m.exec(SW) || [])[1] || '';
  return (v && v.localeCompare('2026-11-24.3', 'en', { numeric: true }) > 0 && ['assets/js/imp/legacy-import.js', 'assets/i18n/limp.js', 'assets/css/pages/limp.css'].every(f => SW.indexOf("'" + f + "'") !== -1)) || v;
});
check('app-shell NAV: legacy_import (orgAdmin + owner) in «الإدارة» with its fallback labels; itemVisible hides owner items from a branch admin', () =>
  (/\{ id: 'legacy_import', key: 'limp\.nav_legacy_import', href: 'admin\.html#legacy_import', icon: 'upload', allow: R\.orgAdmin, owner: true \}/.test(SRC.shell)
    && /if \(it\.owner && !isOwner\(\)\) return false;/.test(SRC.shell) && /function isOwner\(\) \{ return \(S\.memberships \|\| \[\]\)\.some\(function \(m\) \{ return m && m\.role === 'admin' && !m\.branch_id; \}\); \}/.test(SRC.shell)
    && (SRC.shell.match(/'limp\.nav_legacy_import':/g) || []).length === 2) || 'shell');
check('admin.js: a module view with owner: true is listed only for the org owner (isOrgAdmin), NAV_ORDER ends with legacy_import', () =>
  (/opsView\(id\) && \(OPS\.views\[id\]\.owner !== true \|\| isOrgAdmin\(\)\)/.test(SRC.admin) && /'audit', 'changes', 'errors', 'legacy_import'\];/.test(SRC.admin)) || 'admin');
check('admin.js: the owner filter really hides the view from a branch admin and shows it to the owner (extracted function)', () => {
  const m = /function opsViewList\(\) \{([\s\S]*?)\n  \}/.exec(SRC.admin);
  if (!m) return 'no opsViewList';
  const mk = owner => new Function('VIEWS', 'DETAIL', 'OPS', 'opsView', 'opsRoleSet', 'isOrgAdmin', 'return function () {' + m[1] + '};')(
    [], {}, { views: { legacy_import: { owner: true, allow: 'orgAdmin', render() {} }, rules: { allow: 'staff', render() {} } } }, id => ({ render() {} }), () => ['admin'], () => owner);
  return (J(mk(true)().map(v => v.id)) === J(['legacy_import', 'rules']) && J(mk(false)().map(v => v.id)) === J(['rules'])) || 'filter';
});
check('limp.css: phone width (grid / stack children min-width 0; the table scroller is position: relative), td row tones, small-screen single column, no dark theme, logical properties', () =>
  (/\.limp-view > \*, \.limp-body > \*, \.limp-create-host > \*, \.limp-run-wrap > \*, \.limp-sheets > \*, \.limp-view \.app-card-body > \*, \.limp-preview > \* \{ min-width: 0; \}/.test(CSS)
    && /\.limp-view \.table-wrap \{ max-width: 100%; overflow-x: auto; position: relative; \}/.test(CSS)
    && /\.limp-view \.table tbody tr\.limp-row-error > td \{ background-color:/.test(CSS) && /@media \(max-width: 599px\) \{[\s\S]*?\.limp-map-row, \.limp-map-row:has\(input\[type="search"\]\) \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(CSS)
    && /grid-template-columns: repeat\(auto-fit, minmax\(min\(220px, 100%\), 1fr\)\)/.test(CSS) && !/prefers-color-scheme/.test(CSS)
    && !/(margin|padding)-(left|right)\s*:|\b(left|right)\s*:\s*\d/.test(CSS)) || 'css');
check('the guide documents the UI (screens, how to resume, the error report, the RHK- step)', () =>
  (/## الواجهة/.test(GUIDE) && /#legacy_import/.test(GUIDE) && /تقرير الأخطاء/.test(GUIDE) && /تابع الترحيل/.test(GUIDE)) || 'guide');

/* ================================================================ pure: text + dates */
section('pure: folding, dates in Asia/Riyadh, ISO 6346');
eq('fold: Arabic-Indic digits, أ/إ/آ → ا, ة → ه, ى → ي, spaces / punctuation / tatweel / harakat dropped (= app.li_key)',
  [LI.fold(' رقم  الجوال '), LI.fold('السجل التجاري / الرقم الموحد'), LI.fold('درجة الثقة %'), LI.fold('المشغّل'), LI.fold('٢٠٢٦-١١'), LI.fold('إعادة_الفارغ'), LI.fold('مـسـتـورد')],
  ['رقمالجوال', 'السجلالتجاريالرقمالموحد', 'درجهالثقه', 'المشغل', '202611', 'اعادهالفارغ', 'مستورد']);
eq('normDate: dd/mm/yyyy, d-m-yyyy, yyyy-mm-dd, Arabic-Indic digits — a date without a time is never shifted',
  [LI.normDate('03/11/2026'), LI.normDate('3-1-2025'), LI.normDate('2026-11-03'), LI.normDate('٠٣/١١/٢٠٢٦'), LI.normDate('۰۳/۱۱/۲۰۲۶')],
  ['2026-11-03', '2025-01-03', '2026-11-03', '2026-11-03', '2026-11-03']);
eq('normDate: Excel serials (46000 = 2025-12-09; the fraction is the wall time) and XlsxLite date strings', [LI.normDate('46000'), LI.normDate(46000.75), LI.normDate('2025-12-09 18:00')],
  ['2025-12-09', '2025-12-09 18:00', '2025-12-09 18:00']);
eq('normDate: times with ص / م / AM / PM, 12 ص = 00:00', [LI.normDate('03/11/2026 08:30 م'), LI.normDate('03/11/2026 08:30 ص'), LI.normDate('03/11/2026 12:05 ص'), LI.normDate('03/11/2026 12:05 PM'), LI.normDate('٠٣/١١/٢٠٢٦ ٠٩:١٥')],
  ['2026-11-03 20:30', '2026-11-03 08:30', '2026-11-03 00:05', '2026-11-03 12:05', '2026-11-03 09:15']);
eq('normDate: an instant with a zone is shown in Riyadh time (UTC+3)', [LI.normDate('2026-11-03T21:30:00Z'), LI.normDate('2026-11-03T08:00:00+02:00')], ['2026-11-04 00:30', '2026-11-03 09:00']);
eq('normDate refuses: a Hijri year, 31/02, 25:00, text, empty', [LI.normDate('15/05/1447'), LI.normDate('31/02/2026'), LI.normDate('03/11/2026 25:00'), LI.normDate('غدًا'), LI.normDate('')], ['', '', '', '', '']);
check('normDate never reads the device zone (only UTC arithmetic)', () => {
  const body = /function normDate\(v\) \{([\s\S]*?)\n  \}/.exec(SRC.view)[1];
  return (!/getHours\(|getDate\(|getMonth\(|getFullYear\(|getTimezoneOffset|toLocale/.test(body) && /getUTCHours/.test(body)) || 'device zone';
});
eq('riyadhToday: 22:30 UTC is already the next day in Riyadh', [LI.riyadhToday(Date.UTC(2026, 10, 10, 22, 30)), LI.riyadhToday(Date.UTC(2026, 10, 10, 20, 59))], ['2026-11-11', '2026-11-10']);
// an independent ISO 6346 check digit (letters A=10 … skipping multiples of 11; weights 2^i; mod 11, 10 → 0)
function iso(c) { const v = {}; let n = 10; for (let i = 0; i < 26; i++) { if (n % 11 === 0) n++; v[String.fromCharCode(65 + i)] = n++; }
  let s = 0; for (let i = 0; i < 10; i++) s += (i < 4 ? v[c[i]] : +c[i]) * 2 ** i; return (s % 11) % 10; }
check('ISO 6346: the textbook CSQU3054383, 200 generated numbers agree with an independent implementation; a wrong digit / a non-ISO shape fail', () => {
  const bad = [];
  for (let k = 0; k < 200; k++) { const p = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'; const own = [0, 1, 2].map(() => p[Math.floor(Math.random() * 26)]).join('') + 'U' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    const good = own + iso(own), wrong = own + ((iso(own) + 1) % 10);
    if (!LI.iso6346Ok(good) || LI.iso6346Ok(wrong)) bad.push(good); }
  return (LI.iso6346Ok('CSQU3054383') && !LI.iso6346Ok('CSQU3054384') && !LI.iso6346Ok('CSQ3054383') && !bad.length) || bad.slice(0, 3);
});
eq('containerList: several numbers per cell (comma, Arabic comma, new line, «و»), Arabic-Indic digits, spaces removed',
  LI.containerList('CSQU 305438-3، MSCU6639871\nTGHU٠١٢٣٤٥٦ و ABCD1234567'), ['CSQU3054383', 'MSCU6639871', 'TGHU0123456', 'ABCD1234567']);

/* ================================================================ pure: detection + mapping */
section('pure: header detection per entity, mapping, manual override');
const canon = ent => DICT_ENTITIES.find(e => e.entity === ent).fields.map(f => f.headers[0]);
check('dictIndex: 8 entities in dependency order, folded headers → keys in prototype-free maps, required keys', () =>
  (J(IDX.list.map(e => e.entity)) === J(LI.ENTITIES) && Object.getPrototypeOf(IDX.byEntity) === null && Object.getPrototypeOf(IDX.byEntity.customers.byHeader) === null
    && J(IDX.byEntity.payments.required) === J(['tx_legacy_id', 'service_item', 'paid_amount', 'paid_at']) && IDX.byEntity.transactions.byHeader[LI.fold('المشغّل')] === 'operator') || 'idx');
check('every entity is detected by its own sheet name, and by its canonical headers under a neutral sheet name', () => {
  const bad = [];
  LI.ENTITIES.forEach(e => {
    const sheet = DICT_ENTITIES.find(x => x.entity === e).sheets[0];
    const a = LI.detectSheet(sheet, [canon(e)], IDX), b = LI.detectSheet('Sheet1', [canon(e)], IDX);
    if (a.entity !== e || a.by !== 'sheet' || a.headerRow !== 0) bad.push(['name', e, a]);
    if (b.entity !== e || b.by !== 'headers') bad.push(['headers', e, b]);
  });
  return !bad.length || bad;
});
check('headers shared across entities (رقم المعاملة, السائق, ملاحظات, كود العميل في دفترة) are decided per sheet by the overlap', () => {
  const mv = LI.detectSheet('ورقة 3', [['رقم المعاملة', 'رقم الحاوية', 'تاريخ ووقت موعد الخروج', 'السائق', 'حالة إعادة الفارغ']], IDX);
  const ct = LI.detectSheet('ورقة 4', [['رقم سجل الحاوية', 'رقم المعاملة', 'رقم الحاوية', 'رقم الختم']], IDX);
  const tx = LI.detectSheet('ورقة 5', [['رقم المعاملة', 'المستورد', 'رقم البوليصة', 'رقم الحاوية', 'السائق', 'ملاحظات']], IDX);
  const dr = LI.detectSheet('ورقة 6', [['اسم السائق', 'رقم الجوال', 'رقم الشاحنة']], IDX);
  const al = LI.detectSheet('ورقة 7', [['كود العميل في دفترة', 'الاسم الإنجليزي كما ظهر في البوليصة', 'درجة الثقة %']], IDX);
  return (mv.entity === 'movements' && ct.entity === 'containers' && tx.entity === 'transactions' && dr.entity === 'drivers' && al.entity === 'aliases') || J([mv, ct, tx, dr, al]);
});
check('the header row may be below a title (first 10 rows); a sheet without a required header or with one header only is not guessed', () => {
  const a = LI.detectSheet('تصدير', [['تقرير المعاملات'], [], ['التسلسل', 'المستورد', 'رقم البوليصة']], IDX);
  const b = LI.detectSheet('x', [['ملاحظات', 'الموظف']], IDX), c = LI.detectSheet('x', [['رقم الجوال']], IDX);
  const late = LI.detectSheet('x', [[], [], [], [], [], [], [], [], [], [], ['المستورد', 'رقم البوليصة']], IDX);
  return (a.entity === 'transactions' && a.headerRow === 2 && !b.entity && !c.entity && !late.entity) || J([a, b, c, late]);
});
check('a sheet name with a suffix («المعاملات 2025») still names the entity; the detection by name keeps the best header row', () => {
  const a = LI.detectSheet('المعاملات 2025', [['نسخة'], ['المستورد', 'رقم البوليصة', 'الميناء']], IDX);
  return (a.entity === 'transactions' && a.by === 'sheet' && a.headerRow === 1) || J(a);
});
check('mapColumns: alternates map to the same key; a second column with the same key stays unmapped (dup); unknown headers unmapped', () => {
  const cols = LI.mapColumns(['المستورد', 'اسم العميل', 'رقم البوليصة', 'عمود غريب', '', 'المشغّل'], IDX.byEntity.transactions);
  return (J(cols.map(c => c.key)) === J(['importer', null, 'bl_number', null, null, 'operator']) && cols[1].dup === true && cols[0].auto === true) || J(cols);
});
check('setColumn: a manual override moves a key from another column; missingRequired follows', () => {
  let cols = LI.mapColumns(['المستورد', 'اسم العميل', 'رقم البوليصة'], IDX.byEntity.transactions);
  cols = LI.setColumn(cols, 1, 'importer');
  const a = J(cols.map(c => c.key)), m1 = LI.missingRequired(cols, IDX.byEntity.transactions);
  cols = LI.setColumn(cols, 2, null);
  return (a === J([null, 'importer', 'bl_number']) && cols[1].auto === false && !m1.length && J(LI.missingRequired(cols, IDX.byEntity.transactions)) === J(['bl_number'])) || a;
});

/* ================================================================ pure: rows, chunks, labels */
section('pure: rows (numbers, limits, keys), local pre-check, chunking, sheet labels');
check('buildRows: row_no = the sheet row, empty rows skipped, unmapped cells dropped, values trimmed; a value > 2000 chars / a row > 16 KB refused locally', () => {
  const head = ['المستورد', 'رقم البوليصة', 'ملاحظات المعاملة', 'غير معروف'];
  const cols = LI.mapColumns(head, IDX.byEntity.transactions);
  const rows = [head, ['  شركة الاختبار ', 'BL-1', '', 'سر'], [], ['', '', '', 'فقط غير مربوط'], ['ب', 'BL-2', 'x'.repeat(2001)],
    ['ج', 'BL-3', 'ش'.repeat(1990)], ['د', 'BL-4', 'ملاحظة']];
  // a 16 KB row: many fields under 2000 chars each
  const wide = ['المستورد', 'رقم البوليصة', 'ملاحظات المعاملة', 'ملاحظات البيان', 'الوكيل الملاحي', 'الباخرة', 'الموظف', 'اسم شركة النقل'];
  const wcols = LI.mapColumns(wide, IDX.byEntity.transactions);
  const big = LI.buildRows([wide, ['ه', 'BL-5'].concat(Array(6).fill('م'.repeat(1990)))], 0, wcols);
  const r = LI.buildRows(rows, 0, cols);
  return (J(r.rows.map(x => x.row_no)) === J([2, 6, 7]) && r.rows[0].data.importer === 'شركة الاختبار' && !('notes' in r.rows[0].data) && Object.keys(r.rows[0].data).length === 2
    && J(r.rejected) === J([{ row_no: 5, code: 'too_long', field: 'notes' }]) && r.empty === 1 && Object.getPrototypeOf(r.rows[0].data) === null
    && big.rows.length === 0 && big.rejected[0].code === 'row_bytes') || J({ r, big: big.rejected });
});
check('prototype safety: «__proto__» / «constructor» headers and cells never reach Object.prototype or the payload', () => {
  const head = ['__proto__', 'constructor', 'المستورد', 'رقم البوليصة'];
  const cols = LI.mapColumns(head, IDX.byEntity.transactions);
  const r = LI.buildRows([head, ['{"polluted":1}', 'x', '__proto__', 'BL-1']], 0, cols);
  const m = LI.cleanMapping({ ports: { '__proto__': 'SAJED', 'ميناء جدة': 'SAJED' }, evil: { a: 'b' } });
  const s = LI.mapSuggestions([{ data: { port: '__proto__' }, messages: [{ code: 'port_unknown', field: 'port' }] }, { data: { port: 'constructor' }, messages: [{ code: 'port_unknown' }] }], {});
  return (({}).polluted === undefined && !Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted') && J(Object.keys(r.rows[0].data).sort()) === J(['bl_number', 'importer'])
    && r.rows[0].data.importer === '__proto__' && J(Object.keys(m)) === J(['ports']) && J(Object.keys(m.ports)) === J(['ميناء جدة']) && J(s.ports) === J(['__proto__', 'constructor'])
    && cols[0].key === null && cols[1].key === null) || J({ r: r.rows, m, s });
});
check('localCheck: required (server code), container shape error + check digit warning, dates (Riyadh-safe) — the server labels apply', () => {
  const m = LI.localCheck(IDX.byEntity.transactions, { importer: 'أ', container_no: 'CSQU3054384, ABC123', declaration_date: '31/02/2026', created_at: '03/11/2026' });
  const p = LI.localCheck(IDX.byEntity.payments, { tx_legacy_id: '7', paid_amount: '10', paid_at: 'أمس' });
  return (J(m.map(x => [x.level, x.code])) === J([['error', 'required'], ['warning', 'container_check_digit'], ['error', 'container_format'], ['warning', 'invalid_date']])
    && J(p.map(x => x.code)) === J(['required', 'invalid_date']) && LI.levelOf(m) === 'error' && LI.levelOf([{ level: 'warning' }]) === 'warning' && LI.levelOf([]) === 'valid'
    && m.every(x => LABELS.li_message[x.code])) || J([m, p]);
});
// harness fixes (step-9 offline harness): the browser pre-check says what the server says
eq('harness fix: normDate accepts a trailing «م» / AD after a date (as app.li_date), still reads «م» after a time as PM',
  [LI.normDate('07/11/2026 م'), LI.normDate('3-11-2026م'), LI.normDate('07/11/2026 AD'), LI.normDate('07/11/2026 08:30 م'), LI.normDate('07/11/2026 هـ')],
  ['2026-11-07', '2026-11-03', '2026-11-07', '2026-11-07 20:30', '']);
check('harness fix: date codes / levels per field = the server (app.li_check_*); a date field the server reads silently gets no message', () => {
  const mv = LI.localCheck(IDX.byEntity.movements, { tx_legacy_id: '1', return_deadline: 'x', returned_at: 'y', appointment_at: 'z' });
  const tx = LI.localCheck(IDX.byEntity.transactions, { importer: 'أ', bl_number: 'B', created_at: 'x', declaration_date: 'y', transport_order_date: 'z' });
  const cu = LI.localCheck(IDX.byEntity.custody, { client_name: 'أ', entry_date: 'غدًا' });
  const pick = a => a.filter(x => x.code !== 'required').map(x => [x.field, x.level, x.code]);
  // the server rows these come from: the migration text
  const srv = [['declaration_date', 'warning', 'invalid_date'], ['created_at', 'warning', 'invalid_datetime'], ['appointment_at', 'error', 'invalid_datetime'],
    ['return_deadline', 'warning', 'invalid_date'], ['returned_at', 'warning', 'invalid_date'], ['paid_at', 'error', 'invalid_date']]
    .every(([f, l, c]) => new RegExp("app\\.li_m\\('" + l + "', '" + c + "', '" + f + "'").test(MIG) && J(LI.DATE_RULES[f]) === J([l, c]));
  return (J(pick(mv)) === J([['return_deadline', 'warning', 'invalid_date'], ['returned_at', 'warning', 'invalid_date'], ['appointment_at', 'error', 'invalid_datetime']])
    && J(pick(tx)) === J([['created_at', 'warning', 'invalid_datetime'], ['declaration_date', 'warning', 'invalid_date']]) && J(pick(cu)) === J([]) && srv) || J({ mv, tx, cu, srv });
});
check('harness fix: a required column is satisfied by its server alternative (dictionary «alt»): «تسلسل المعاملة», «كود العميل في دفترة», the English name', () => {
  const miss = (ent, heads) => LI.missingRequired(LI.mapColumns(heads, IDX.byEntity[ent]), IDX.byEntity[ent]);
  const a = miss('containers', ['تسلسل المعاملة', 'رقم الحاوية']), b = miss('movements', ['تسلسل المعاملة']), c = miss('payments', ['تسلسل المعاملة', 'بند الخدمة', 'المبلغ المسدد', 'تاريخ السداد']);
  const d = miss('transactions', ['كود العميل في دفترة', 'رقم البوليصة']), e = miss('custody', ['كود العميل في دفترة']), f = miss('customers', ['الاسم الإنجليزي']);
  const g = miss('containers', ['رقم الحاوية']), h = miss('transactions', ['رقم البوليصة']);
  const r1 = LI.localCheck(IDX.byEntity.containers, { tx_seq: '7', container_no: 'CSQU3054383' }), r2 = LI.localCheck(IDX.byEntity.containers, { container_no: 'CSQU3054383' });
  return ([a, b, c, d, e, f].every(x => x.length === 0) && J(g) === J(['tx_legacy_id']) && J(h) === J(['importer'])
    && !r1.some(x => x.code === 'required') && r2.some(x => x.code === 'required' && x.field === 'tx_legacy_id')) || J({ a, b, c, d, e, f, g, h, r1, r2 });
});
check('harness fix: the printed ISO form «TEMU 920200 8» is one container in the browser and on the server (app.li_containers)', () => {
  const m = LI.localCheck(IDX.byEntity.containers, { tx_legacy_id: '1', container_no: 'TEMU 920200 8' });
  return (J(LI.containerList('TEMU 920200 8')) === J(['TEMU9202008']) && !m.some(x => x.code === 'container_format')
    && /\(\[A-Z\]\{4\}\)\[\[:space:\]-\]\*\(\[0-9\]\{6\}\)\[\[:space:\]-\]\?\(\[0-9\]\)/.test(MIG)) || J(m);
});
check('harness fix: skipping a parent row warns about its dependents (customers → aliases / transactions / custody, transactions → containers / movements / payments)', () => {
  const w = LI.skipWarnings(['customers', 'drivers', 'customers', 'transactions', 1]);
  return (J(w.map(x => [x.entity, x.dependents, x.code])) === J([['customers', ['aliases', 'transactions', 'custody'], 'client_not_found'], ['transactions', ['containers', 'movements', 'payments'], 'transaction_not_found']])
    && LI.skipWarnings(['drivers', 'payments']).length === 0 && w.every(x => LABELS.li_message[x.code])) || J(w);
});
check('harness fix: createRun records only the files with a staged sheet (a file whose sheets are all «تجاهل» is left out)', () => {
  const parsed = [{ name: 'a.xlsx', sha256: 'a'.repeat(64), size: 10, sheets: [{ name: 'S1' }] }, { name: 'b.xlsx', sha256: 'b'.repeat(64), size: 20, sheets: [{ name: 'S2' }, { name: 'S3' }] },
    { name: 'bad.xlsx', error: 'not_xlsx' }, { name: 'c.csv', sha256: 'c'.repeat(64), size: 5, sheets: [{ name: 'c' }] }];
  const sheets = [{ fileIdx: 0, include: false, entity: 'drivers' }, { fileIdx: 1, include: true, entity: 'transactions' }, { fileIdx: 1, include: false, entity: '' }, { fileIdx: 3, include: true, entity: '' }];
  const f = LI.runFiles(parsed, sheets);
  return (J(f) === J([{ name: 'b.xlsx', sha256: 'b'.repeat(64), size: 20, sheets: ['S2', 'S3'] }])) || J(f);
});
check('harness fix: the stepper — committed: everything through «الترحيل» done, «الربط بدفترة» not current; voiding / voided: no current step', () => {
  const s = ['', 'draft', 'staged', 'validated', 'committing', 'committed', 'voiding', 'voided'].map(x => LI.stepState(x || null));
  return (J(s.map(x => [x.done, x.current])) === J([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, -1], [5, -1], [5, -1]]) && !s[5].ended && s[6].ended && s[7].ended) || J(s);
});
check('chunkRows: ≤ 500 rows per call; a byte budget splits earlier; nothing lost or reordered', () => {
  const rows = Array.from({ length: 1201 }, (x, i) => ({ row_no: i + 2, data: { importer: 'ع' + i, bl_number: 'BL' + i } }));
  const a = LI.chunkRows(rows);
  const b = LI.chunkRows(rows.slice(0, 50), 500, 1200);
  const flat = [].concat(...a).map(r => r.row_no);
  return (J(a.map(c => c.length)) === J([500, 500, 201]) && J(flat) === J(rows.map(r => r.row_no)) && b.length > 1 && b.every(c => LI.utf8Len(J(c)) < 1200 + 200)) || J(a.map(c => c.length));
});
check('sheetLabel: «sheet @ file», ≤ 120 characters, unique in the run (two files with the same sheet name)', () => {
  const used = Object.create(null);
  const a = LI.sheetLabel('المعاملات', 'a.xlsx', used), b = LI.sheetLabel('المعاملات', 'a.xlsx', used), c = LI.sheetLabel('س'.repeat(200), 'f.xlsx', used), d = LI.sheetLabel('س'.repeat(200), 'f.xlsx', used);
  return (a === 'المعاملات @ a.xlsx' && b === 'المعاملات @ a.xlsx #2' && c.length === 120 && d.length === 120 && c !== d) || J([a, b, c.length, d]);
});
check('entitiesOf: only included sheets, in dependency order; refusedOf turns locally refused rows into report rows', () => {
  const s = [{ include: true, entity: 'payments' }, { include: false, entity: 'drivers' }, { include: true, entity: 'customers' }, { include: true, entity: 'payments' }];
  const r = LI.refusedOf([{ include: true, entity: 'transactions', label: 'x @ f', built: { rejected: [{ row_no: 9, code: 'too_long', field: 'notes' }, { row_no: 10, code: 'row_bytes' }] } }]);
  return (J(LI.entitiesOf(s)) === J(['customers', 'payments']) && r.length === 2 && r[0].source === 'local' && r[1].messages[0].code === 'row_too_big' && r[0].messages[0].field === 'notes') || J(r);
});
check('server answers: entity counts in order, blockers parsed from the MRS_LI_VOID_BLOCKED detail, retryable / busy errors', () => {
  const ec = LI.entityCounts({ counts: { by_entity: { payments: { valid: 2, total: 2 }, customers: { error: 1, valid: 3, total: 4 } } } });
  const bl = LI.blockersOf({ code: 'MRS_LI_VOID_BLOCKED', field: '{"total":2,"items":[{"table":"clients","id":"x","reason":"changed","label":"عميل"},{"table":"transactions","id":"y","reason":"billing"}]}' });
  const bl2 = LI.blockersOf({ code: 'UNKNOWN', raw: { message: 'MRS_LI_VOID_BLOCKED {"total":1,"items":[{"table":"trucks","reason":"added_later"}]}' } });
  return (J(ec.map(x => [x.entity, x.total, x.error])) === J([['customers', 4, 1], ['payments', 2, 0]]) && bl.total === 2 && bl.items[1].reason === 'billing' && bl2.items[0].table === 'trucks'
    && LI.isRetryable({ code: 'MRS_TIMEOUT' }) && LI.isRetryable({ code: 'UNKNOWN', raw: { code: '57014', message: 'canceling statement due to statement timeout' } })
    && LI.isRetryable({ code: 'MRS_NETWORK' }) && !LI.isRetryable({ code: 'MRS_LI_STATE' }) && LI.isBusy({ code: 'MRS_LI_BUSY' }) && LI.errCode({ message: 'MRS_LI_BUSY run' }) === 'MRS_LI_BUSY') || J([ec, bl, bl2]);
});
check('mapSuggestions: unknown ports / service items / clients / branches from the row messages, folded unique, existing mapping left out', () => {
  const items = [
    { data: { port: 'ميناء الملك  عبدالعزيز' }, messages: [{ code: 'port_unknown', field: 'port' }] },
    { data: { port: 'ميناء الملك عبدالعزيز' }, messages: [{ code: 'port_unknown', field: 'port' }] },
    { data: { port: 'منفذ قديم' }, messages: [{ code: 'port_unknown', field: 'port' }] },
    { data: { service_item: 'رسوم أرضيات' }, messages: [{ code: 'service_item_unknown', field: 'service_item' }] },
    { data: { importer: 'مؤسسة الاختبار' }, messages: [{ code: 'client_ambiguous', field: 'importer' }, { code: 'bl_required' }] },
    { data: { branch: 'فرع جدة' }, messages: [{ code: 'branch_unknown', field: 'branch' }] }];
  const s = LI.mapSuggestions(items, { ports: { 'منفذ قديم': 'SAJED' } });
  return (J(s) === J({ ports: ['ميناء الملك عبدالعزيز'], service_items: ['رسوم أرضيات'], clients: ['مؤسسة الاختبار'], branches: ['فرع جدة'] })) || J(s);
});

/* ================================================================ pure: the resumable loop */
section('pure: the resumable loop (timeout → half the chunk, busy → wait, stop, give up)');
(async () => {
  await acheck('a timeout halves the limit and retries (the call rolled back); a later success continues with the smaller limit until done', async () => {
    const seen = []; let n = 0;
    const r = await LI.loop({ limit: 100, min: 5, step: l => { seen.push(l); n++; if (n === 2) return Promise.resolve({ error: { code: 'MRS_TIMEOUT' } }); return Promise.resolve({ data: { done: n >= 4 } }); }, isDone: d => d.done });
    return (r.done && J(seen) === J([100, 100, 50, 50]) && r.limit === 50) || J({ seen, r });
  });
  await acheck('MRS_LI_BUSY waits and retries with the same limit; a statement timeout (57014) counts as a timeout', async () => {
    const seen = []; let n = 0;
    const r = await LI.loop({ limit: 40, step: l => { seen.push(l); n++; if (n === 1) return Promise.resolve({ error: { code: 'MRS_LI_BUSY' } });
      if (n === 2) return Promise.resolve({ error: { code: 'UNKNOWN', raw: { code: '57014' }, message: 'canceling statement due to statement timeout' } }); return Promise.resolve({ data: { done: true } }); }, isDone: d => d.done });
    return (r.done && J(seen) === J([40, 40, 20])) || J(seen);
  });
  await acheck('a definite error stops at once (no retry); retries are bounded; the limit never drops below min', async () => {
    let a = 0; const r1 = await LI.loop({ limit: 10, step: () => { a++; return Promise.resolve({ error: { code: 'MRS_LI_STATE', field: 'voided' } }); }, isDone: () => true });
    const seen = []; const r2 = await LI.loop({ limit: 8, min: 5, retries: 3, step: l => { seen.push(l); return Promise.resolve({ error: { code: 'MRS_TIMEOUT' } }); }, isDone: () => true });
    return (a === 1 && r1.error.code === 'MRS_LI_STATE' && r2.error && J(seen) === J([8, 5, 5, 5])) || J({ a, seen });
  });
  await acheck('stopped() ends the loop before the next call (the work so far stays: resumable)', async () => {
    let n = 0, stop = false;
    const r = await LI.loop({ limit: 10, step: () => { n++; if (n === 2) stop = true; return Promise.resolve({ data: { done: false } }); }, isDone: d => d.done, stopped: () => stop });
    return (r.stopped && n === 2 && !r.done) || J({ n, r });
  });

  /* ================================================================ sha-256 + files */
  section('pure: sha-256 (file fingerprint) and file reading (untrusted)');
  check('sha256Js = node crypto for empty, «abc», Arabic text and 10 000 random bytes', () => {
    const bufs = [Buffer.alloc(0), Buffer.from('abc'), Buffer.from('مرسى — استيراد'), nodeCrypto.randomBytes(10000), nodeCrypto.randomBytes(55), nodeCrypto.randomBytes(64)];
    const bad = bufs.filter(b => LI.sha256Js(new Uint8Array(b)) !== nodeCrypto.createHash('sha256').update(b).digest('hex'));
    return !bad.length || bad.length;
  });
  await acheck('sha256Hex uses crypto.subtle when the page has it (same hex as without)', async () => {
    const c2 = context({ crypto: true }), b = nodeCrypto.randomBytes(3000);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    const x = await c2.w.MarsaOps.legacyImport.sha256Hex(ab), y = await LI.sha256Hex(ab);
    return (x === y && x === nodeCrypto.createHash('sha256').update(b).digest('hex')) || [x, y];
  });
  const X = base.w.XlsxLite;
  const toFile = (name, bytes) => ({ name, size: bytes.length, arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)) });
  const CUST = [canon('customers'), ['000101', 'مؤسسة الاختبار التجارية', 'Test Trading Est', '300000000000003', '1010000000', '0500000001', 'a@example.test', 'جدة', 'نشط', 'ميناء', ''],
    ['000102', 'شركة المثال', '', '', '', '', '', 'الدمام', 'نشط', 'مطار', 'ملاحظة']];
  const TXH = ['التسلسل', 'رقم المعاملة', 'المستورد', 'رقم البوليصة', 'رقم الحاوية', 'الميناء', 'تاريخ البيان', 'ملاحظات المعاملة'];
  const TXR = [TXH, ['١', 'TX-1', 'مؤسسة الاختبار التجارية', 'BL-1001', 'CSQU3054383', 'ميناء جدة الإسلامي', '03/11/2026', '=HYPERLINK("x")'],
    ['2', 'TX-2', 'شركة المثال', 'BL-1002', 'CSQU3054384', 'منفذ قديم', '45900', ''], ['3', 'TX-3', 'عميل مجهول', '', 'ABC123', '', 'غير معروف', '=HYPERLINK("y")']];
  const xbytes = X.writeBytes([{ name: 'دليل العملاء', rows: CUST }, { name: 'Sheet2', rows: TXR }, { name: 'ملاحظات', rows: [['أي شيء'], ['نص']] }]);
  const csvBytes = new TextEncoder().encode('\uFEFFاسم السائق,رقم الجوال,رقم الشاحنة\r\nسائق أول,٠٥٠٠٠٠٠٠٠٢,أ ب ج ١٢٣٤\r\nسائق ثان,0500000003,\r\n');
  const parsed = await LI.parseFiles([toFile('legacy.xlsx', xbytes), toFile('السائقون.csv', csvBytes)]);
  check('a real .xlsx (XlsxLite, cached values) + a CSV with a BOM are read; sha256 + size kept; visible non-empty sheets only', () =>
    (parsed.length === 2 && !parsed[0].error && J(parsed[0].sheets.map(s => s.name)) === J(['دليل العملاء', 'Sheet2', 'ملاحظات']) && /^[0-9a-f]{64}$/.test(parsed[0].sha256)
      && parsed[0].size === xbytes.length && parsed[1].sheets[0].name === 'السائقون' && parsed[1].sheets[0].rows[0][0] === 'اسم السائق'
      && parsed[0].sha256 === nodeCrypto.createHash('sha256').update(Buffer.from(xbytes)).digest('hex')) || J(parsed.map(p => p.error || p.sheets.map(s => s.name))));
  check('sheetsFrom: customers by sheet name, transactions by headers, the note sheet not guessed (ignored), drivers by the CSV name', () => {
    const s = LI.sheetsFrom(parsed, IDX);
    return (J(s.map(x => [x.name, x.entity, x.det.by, x.include])) === J([['دليل العملاء', 'customers', 'sheet', true], ['Sheet2', 'transactions', 'headers', true], ['ملاحظات', '', null, false], ['السائقون', 'drivers', 'sheet', true]])
      && s[1].label === 'Sheet2 @ legacy.xlsx' && s[1].columns.filter(c => c.key).length === 8) || J(s.map(x => [x.name, x.entity, x.det]));
  });
  const bad = await Promise.all([LI.parseFile({ name: 'a.xls', size: 10 }), LI.parseFile({ name: 'big.xlsx', size: 11 * 1024 * 1024 }), LI.parseFile({ name: 'a.pdf', size: 10 }),
    LI.parseFile(toFile('fake.xlsx', new TextEncoder().encode('not a zip'))), LI.parseFile({ name: 'e.csv', size: 0 }),
    LI.parseFile(toFile('old.csv', new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0])))]);
  eq('untrusted files refused before parsing: .xls name, > 10 MB, another type, an .xlsx that is not a zip, an empty file, an old .xls renamed .csv',
    bad.map(b => b.error), ['type', 'too_big', 'type', 'unreadable', 'empty', 'xls']);
  await acheck('read limits are passed to XlsxLite (64 MB inflated, 50 000 + header rows, 256 columns); an inflate overflow → inflate_big', async () => {
    let seen = null; const orig = X.read;
    X.read = (b, lim) => { seen = lim; return orig(b, lim); };
    await LI.parseFile(toFile('a.xlsx', xbytes));
    X.read = (b, lim) => orig(b, Object.assign({}, lim, { maxInflateBytes: 100 }));
    const r = await LI.parseFile(toFile('a.xlsx', xbytes));
    X.read = orig;
    return (seen && seen.maxInflateBytes === 64 * 1024 * 1024 && seen.maxRows === 50011 && seen.maxCols === 256 && r.error === 'inflate_big') || J({ seen, r });
  });

  /* ================================================================ DOM flows */
  const ORG = '00000000-0000-4000-8000-000000000001', BR = '00000000-0000-4000-8000-0000000000b1', RUN = '00000000-0000-4000-8000-0000000000e1';
  const TX1 = '00000000-0000-4000-8000-000000000101';
  const okR = d => Promise.resolve({ data: d, error: null });
  const errR = (code, field) => Promise.resolve({ data: null, error: { code, field: field || null, message: code + (field ? ' ' + field : '') } });
  // an in-memory server with the 20261125000100 contract shapes
  function fakeServer(o) {
    o = o || {};
    const S = { calls: [], run: o.run || null, rows: o.rows || [], n: 0, timeouts: o.timeouts || 0, blockers: null, runs: o.runs || [] };
    const log = (...a) => S.calls.push(a);
    function counts() {
      const by_status = {}, by_entity = {};
      S.rows.forEach(r => { by_status[r.status] = (by_status[r.status] || 0) + 1; const e = by_entity[r.entity] = by_entity[r.entity] || { total: 0 }; e[r.status] = (e[r.status] || 0) + 1; e.total++; });
      return { total: S.rows.length, by_status, by_entity };
    }
    function runJson() {
      if (!S.run) return null;
      const msgs = {};
      S.rows.forEach(r => (r.messages || []).forEach(m => { const k = r.entity + '|' + m.level + '|' + m.code; msgs[k] = (msgs[k] || 0) + 1; }));
      return Object.assign({}, S.run, { counts: counts(), pending: S.rows.filter(r => r.status === 'pending').length, to_commit: S.rows.filter(r => r.status === 'valid' || r.status === 'warning').length,
        messages: Object.keys(msgs).map(k => { const p = k.split('|'); return { entity: p[0], level: p[1], code: p[2], n: msgs[k] }; }) });
    }
    function check(r) {
      const d = r.data, m = [];
      if (r.entity === 'transactions') {
        if (!d.bl_number) m.push({ level: 'error', code: 'bl_required', field: 'bl_number' });
        if (d.port === 'منفذ قديم') m.push({ level: 'error', code: 'port_unknown', field: 'port' });
        if (d.container_no === 'CSQU3054384') m.push({ level: 'warning', code: 'container_check_digit', field: 'container_no', detail: d.container_no });
      }
      r.messages = m; r.status = m.some(x => x.level === 'error') ? 'error' : m.length ? 'warning' : 'valid';
    }
    const A = {
      legacyImportDictionary: () => { log('dictionary'); return okR(SERVER_DICT); },
      legacyImportListRuns: f => { log('listRuns', f); const items = S.runs.slice(); if (S.run && !items.some(x => x.id === S.run.id)) items.unshift(runJson()); return okR({ total: items.length, items: items.map(x => x.id === (S.run && S.run.id) ? runJson() : x) }); },
      legacyImportCreateRun: (p, opt) => { log('create', p, opt); S.run = { id: RUN, org_id: ORG, ref: 'LIR-000001', status: 'draft', entities: p.entities, reason: p.reason, files: p.files, branch_id: p.branch_id || null,
        branch_name: p.branch_id ? 'جدة' : null, mapping: p.mapping, options: p.options, created_at: '2026-11-11T07:00:00Z', created_by_name: 'المالك', daftra: null }; return okR(runJson()); },
      legacyImportGetRun: id => { log('getRun', id); return S.run && S.run.id === id ? okR(runJson()) : errR('MRS_NOT_FOUND', 'run'); },
      legacyImportStage: (id, entity, sheet, rows, o) => {
        log('stage', entity, sheet, rows.length, rows[0] && rows[0].row_no, !!(o && o.replace));
        if (S.run.entities.indexOf(entity) === -1) return errR('MRS_INVALID', 'entity');
        let ins = 0, same = 0;
        rows.forEach(r => { const k = J(r.data); const old = S.rows.find(x => x.entity === entity && x.sheet === sheet && x.row_no === r.row_no);
          if (old && J(old.data) === k) { same++; return; }
          if (old) { old.data = r.data; old.status = 'pending'; return; }
          S.rows.push({ id: 'row-' + (++S.n), entity, sheet, row_no: r.row_no, data: r.data, status: 'pending', messages: [] }); ins++; });
        S.run.status = 'staged';
        return okR({ received: rows.length, inserted: ins, replaced: 0, unchanged: same, dropped_keys: 0, run: runJson() });
      },
      legacyImportValidate: (id, opt) => {
        log('validate', opt);
        const todo = S.rows.filter(r => r.status === 'pending').slice(0, (opt && opt.limit) || 300);
        todo.forEach(check);
        const done = !S.rows.some(r => r.status === 'pending');
        if (done) S.run.status = 'validated';
        return okR({ done, processed: todo.length, run: runJson() });
      },
      legacyImportListRows: (id, f) => {
        log('listRows', f);
        let it = S.rows.filter(r => (!f.entity || r.entity === f.entity) && (!f.status || [].concat(f.status).indexOf(r.status) !== -1));
        const total = it.length; it = it.slice(f.offset || 0, (f.offset || 0) + (f.limit || 100));
        return okR({ total, items: it.map(r => Object.assign({}, r, { normalized: null, target_table: r.target_table || null, target_id: r.target_id || null, target_label: r.target_label || null })) });
      },
      legacyImportSkipRows: (id, ids, skip) => { log('skip', ids, skip); S.rows.forEach(r => { if (ids.indexOf(r.id) !== -1) r.status = skip ? 'skipped' : 'pending'; }); S.run.status = 'staged'; return okR({ updated: ids.length, run: runJson() }); },
      legacyImportSetOptions: (id, p) => { log('options', p); S.rows.forEach(r => { if (r.status !== 'skipped') r.status = 'pending'; }); S.run.mapping = p.mapping; S.run.options = p.options; S.run.status = 'staged'; return okR(runJson()); },
      legacyImportCommit: (id, opt) => {
        log('commit', opt);
        if (S.timeouts > 0) { S.timeouts--; return errR('MRS_TIMEOUT'); }
        if (S.run.status === 'validated' && !opt.confirm) return errR('MRS_REQUIRED', 'confirm');
        S.run.status = 'committing';
        const todo = S.rows.filter(r => r.status === 'valid' || r.status === 'warning').slice(0, opt.limit || 100);
        todo.forEach((r, i) => { r.status = 'committed'; if (r.entity === 'transactions') { r.target_table = 'transactions'; r.target_id = TX1; r.target_label = 'MRS-00001' + i; } });
        const done = !S.rows.some(r => r.status === 'valid' || r.status === 'warning');
        if (done) { S.run.status = 'committed'; S.run.committed_at = '2026-11-11T08:00:00Z'; }
        return okR({ done, committed: todo.length, failed: 0, run: runJson() });
      },
      legacyImportQueueDaftra: (id, opt) => { log('queue', opt); S.run.daftra = { queued_at: '2026-11-11T08:05:00Z', lookups: 2, prefix: 'RHK-' }; return okR({ lookups_queued: 2, lookups_deduplicated: 0, scan: { id: 'scan-1' }, run: runJson() }); },
      legacyImportDaftraCandidates: (id, f) => { log('cands', f); return okR({ total: 2, items: [{ candidate: { id: 'cand-1', state: 'open', daftra_number: 'RHK-1001', total: 1150, currency: 'SAR', invoice_date: '2025-03-02' },
        transaction: { id: TX1, ref: 'MRS-000010', legacy_ref: '1', legacy_invoice_no: 'RHK-1001', legacy_reference: 'RHK-1' } },
        { candidate: { id: 'cand-2', state: 'open', daftra_number: '000777', total: 90, currency: 'SAR', invoice_date: '2025-03-04', match: { reference: true } },
          transaction: { id: TX1, ref: 'MRS-000010', legacy_ref: '2', legacy_invoice_no: null, legacy_invoice_id: null, legacy_reference: 'RHK-2' } }] }); },
      legacyImportVoid: (id, reason, opt) => {
        log('void', reason, opt);
        if (opt && opt.dryRun) return okR({ blockers: S.blockers || { total: 0, items: [] }, run: runJson() });
        if (S.blockers && S.blockers.total) return errR('MRS_LI_VOID_BLOCKED', J(S.blockers));
        if (S.run.status !== 'voiding') { S.run.status = 'voiding'; S.run.void_reason = reason; }
        if (S.voidChunks > 0) { S.voidChunks--; return okR({ done: false, rows: 1, voided: { clients: 1 }, kept_containers: 0, run: runJson() }); }
        S.run.status = 'voided'; S.run.voided_at = '2026-11-11T09:00:00Z';
        return okR({ done: true, rows: 2, voided: { transactions: 2, clients: 2 }, kept_containers: 1, run: runJson() });
      },
      listCustomsPorts: () => okR([{ code: 'SAJED', name_ar: 'ميناء جدة الإسلامي', is_active: true }, { code: 'SADMM', name_ar: 'ميناء الملك عبدالعزيز بالدمام', is_active: true }]),
      listServiceItems: () => okR([{ id: 'si-1', code: '000186', name_ar: 'أرضيات' }]),
      listClients: () => okR([{ id: 'cl-1', name_ar: 'مؤسسة الاختبار التجارية' }]),
      confirmInvoiceLink: () => { log('LINK'); return okR({}); }, rejectInvoiceCandidate: () => { log('REJECT'); return okR({}); }
    };
    return { A, S, runJson };
  }
  function mkApi(ctx, A, over) {
    const U = ctx.w.MarsaOps.ui, log = { toasts: [], go: [] };
    const api = Object.assign({ orgId: ORG, roles: ['admin'], branches: [{ id: BR, name_ar: 'جدة', name_en: 'Jeddah' }], userId: 'u1', orgName: 'مؤسسة', orgOwner: true,
      can: () => true, t: k => k, el: U.el, toast: (m, t) => log.toasts.push([t, m]), confirm: () => Promise.resolve(true), go: h => log.go.push(h), refresh() {},
      label: (d, c) => c, fmtDate: v => String(v), fmtMoney: (n, c) => n + ' ' + c, fmtNumber: n => String(n), who: () => 'x', isEn: () => LANG === 'en',
      errText: e => (e && (e.message || e.code)) || 'err', newIdemKey: () => 'k', hashQuery: () => ({}), query: '', MarsaApi: A }, over || {});
    return { api, log };
  }
  const modalForm = Dd => { const all = Dd.body.querySelectorAll('form'); return all[all.length - 1] || null; };
  function setField(form, name, v) { const c = form.querySelector('[name="' + name + '"]'); if (!c) throw new Error('no field ' + name); if (c.getAttribute('type') === 'checkbox') c.checked = !!v; else c.value = v; return c; }
  async function submit(form) { form.dispatch('submit'); await settle(20); }
  const act = (root, a) => root.querySelector('[data-act="' + a + '"]');

  section('DOM: owner only');
  {
    const ctx = context(), srv = fakeServer();
    const { api } = mkApi(ctx, srv.A, { orgOwner: false });
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    ctx.w.MarsaOps.views.legacy_import.render(root, api, null); await settle(20);
    check('a branch admin (not the owner) sees «للمالك فقط» and nothing is called', () => (/لمالك المؤسسة فقط/.test(root.textContent) && !srv.S.calls.length) || J(srv.S.calls));
  }

  section('DOM: files → detection → mapping → create + stage + validate → review → commit → RHK- → void');
  {
    const tracked = [];
    const shell = { progress: { track: (op, p, o) => { tracked.push([op, o && o.label, o && o.cancellable]); return Promise.resolve(p); }, active: () => null } };
    const ctx = context({ shell }), srv = fakeServer({ timeouts: 1 });
    const { api, log } = mkApi(ctx, srv.A);
    const V = ctx.w.MarsaOps.views.legacy_import; V._reset();
    ctx.w.MarsaOps.legacyImport.LIMITS.busyWaitMs = 1;
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    V.render(root, api, null);
    await until(() => act(root, 'li-read'));
    check('first screen: the privacy note, the stepper at «الملفات», the file picker (≤ 20 · 10 MB, .xlsx/.csv), «لا توجد دفعات»', () =>
      (/تُقرأ الملفات داخل المتصفح فقط \(حتى 20 ملفًا، 10 م\.ب/.test(root.textContent) && root.querySelector('.limp-step.is-current[data-step="files"]')
        && /\.xlsx,\.csv/.test(root.querySelector('#limp-files').getAttribute('accept')) && /لا توجد دفعات استيراد بعد/.test(root.textContent) && act(root, 'li-read').disabled === true
        && J(srv.S.calls.map(c => c[0])) === J(['dictionary', 'listRuns'])) || J(srv.S.calls));
    const input = root.querySelector('#limp-files');
    input.files = [toFile('legacy.xlsx', xbytes), toFile('السائقون.csv', csvBytes), toFile('x.pdf', new Uint8Array(3))];
    input.dispatch('change');
    check('picking files: .pdf refused with a message, the two others listed', () =>
      (root.querySelectorAll('.limp-file-list li').length === 2 && /الملف x\.pdf ليس/.test(root.textContent) && act(root, 'li-read').disabled === false) || root.textContent.slice(0, 300));
    act(root, 'li-read').click();
    await until(() => root.querySelectorAll('[data-sheet]').length === 4);
    const cards = root.querySelectorAll('[data-sheet]');
    check('four sheet cards: detected entities, «تجاهل» for the unknown sheet, mapping tables, previews with the local pre-check', () => {
      const ents = cards.map(c => c.querySelector('select[name="entity"]').value);
      return (J(ents) === J(['customers', 'transactions', '', 'drivers']) && /اكتُشف من اسم الورقة/.test(cards[0].textContent) && /اكتُشف من عناوين الأعمدة \(عناوين مطابقة: 8\)/.test(cards[1].textContent)
        && /لم يُكتشف نوع البيانات/.test(cards[2].textContent) && cards[2].classList.contains('is-ignored') && cards[1].querySelector('.limp-mapping') && cards[1].querySelector('.limp-preview')
        && tracked.some(t => t[0] === 'limp_read')) || J(ents);
    });
    check('preview: row numbers of the sheet, local pre-check (required B/L, container shape, check digit warning, unknown date), Arabic-Indic sequence kept as typed, the Riyadh reading of a serial', () => {
      const trs = cards[1].querySelectorAll('.limp-preview tbody tr');
      const lv = trs.map(t => t.getAttribute('data-level'));
      return (trs.length === 3 && J(lv) === J(['valid', 'warning', 'error']) && /خانة التحقق في رقم الحاوية لا تطابق/.test(trs[1].textContent) && /حقل مطلوب فارغ/.test(trs[2].textContent)
        && /رقم الحاوية ليس بصيغة ISO/.test(trs[2].textContent) && /تاريخ غير مفهوم/.test(trs[2].textContent) && /يُقرأ: 2025-08-31/.test(trs[1].textContent) && /١/.test(trs[0].textContent)) || J(lv);
    });
    // manual mapping: unmap the B/L column → the create button is blocked; map it back
    let blSel = cards[1].querySelectorAll('.limp-mapping select').filter(s => s.value === 'bl_number')[0];
    blSel.value = ''; blSel.dispatch('change'); await settle(5);
    check('unmapping a required column: the sheet shows «أعمدة مطلوبة غير مربوطة» and the create button is disabled', () => {
      const c1 = root.querySelectorAll('[data-sheet]')[1];
      return (/أعمدة مطلوبة غير مربوطة: رقم البوليصة/.test(c1.textContent) && act(root, 'li-create').disabled === true && /أوراق فيها أعمدة مطلوبة غير مربوطة: Sheet2/.test(root.textContent)) || 'blocked';
    });
    blSel = root.querySelectorAll('[data-sheet]')[1].querySelectorAll('.limp-mapping select').filter(s => s.getAttribute('aria-label') === 'حقل العمود «رقم البوليصة»')[0];
    blSel.value = 'bl_number'; blSel.dispatch('change'); await settle(5);
    check('mapping it again (manual) unblocks; the column is marked «يدوي»', () =>
      (act(root, 'li-create').disabled === false && /يدوي/.test(root.querySelectorAll('[data-sheet]')[1].querySelector('.limp-mapping').textContent)) || 'unblock');
    // the ignored sheet stays ignored; create without a reason → message, nothing created
    act(root, 'li-create').click(); await settle(10);
    check('no reason → «اكتب سببًا» and no run is created', () => (/اكتب سببًا من 3 أحرف/.test(root.textContent) && !srv.S.calls.some(c => c[0] === 'create')) || 'reason');
    root.querySelector('.limp-create textarea[name="reason"]').value = 'نقل بيانات تجريبية';
    act(root, 'li-create').click();
    await until(() => srv.S.run && srv.S.run.status === 'validated' && act(root, 'li-commit'), 4000);
    const create = srv.S.calls.find(c => c[0] === 'create');
    check('createRun: entities in dependency order, files with name / sha256 / size / sheets, the reason, the default branch (one branch), RHK- prefix, an idempotency key', () =>
      (create && J(create[1].entities) === J(['customers', 'drivers', 'transactions']) && create[1].files.length === 2 && /^[0-9a-f]{64}$/.test(create[1].files[0].sha256)
        && create[1].files[0].size === xbytes.length && J(create[1].files[0].sheets) === J(['دليل العملاء', 'Sheet2', 'ملاحظات']) && create[1].reason === 'نقل بيانات تجريبية'
        && create[1].branch_id === BR && create[1].options.daftra_invoice_prefix === 'RHK-' && create[2].orgId === ORG && !!create[2].idemKey) || J(create));
    const stages = srv.S.calls.filter(c => c[0] === 'stage');
    check('stage: one call per sheet chunk with the «sheet @ file» label, the sheet row numbers, nothing from the ignored sheet', () =>
      (J(stages.map(c => [c[1], c[2], c[3], c[4], c[5]])) === J([['customers', 'دليل العملاء @ legacy.xlsx', 2, 2, true], ['transactions', 'Sheet2 @ legacy.xlsx', 3, 2, true], ['drivers', 'السائقون @ السائقون.csv', 2, 2, true]])
        && srv.S.rows.every(r => Object.keys(r.data).every(k => IDX.byEntity[r.entity].keys[k]))) || J(stages));
    check('validation starts by itself after staging (a dry run) and loops until done; the overlay was used for read / stage / validate', () =>
      (srv.S.calls.filter(c => c[0] === 'validate').length >= 1 && srv.S.calls.filter(c => c[0] === 'validate').every(c => c[1].limit === 300)
        && ['limp_read', 'limp_stage', 'limp_validate'].every(op => tracked.some(t => t[0] === op))) || J(tracked));
    check('review: the run panel (ref, status «مفحوصة», tiles), counts per entity × status, top messages with the server labels, the rows table', () => {
      const t = root.textContent;
      return (/دفعة الاستيراد LIR-000001/.test(t) && /مفحوصة/.test(t) && root.querySelector('.limp-by-entity [data-entity="transactions"]') && /المنفذ غير موجود في قائمة المنافذ المعتمدة/.test(root.querySelector('.limp-messages').textContent)
        && root.querySelectorAll('.limp-rows tbody tr').length === 7 && root.querySelector('.limp-step.is-current[data-step="review"]') && /رحّل الصفوف السليمة \(5\)/.test(act(root, 'li-commit').textContent)) || t.slice(0, 500);
    });
    check('the rows of the server check: status pill, message with the field, the data summary with the legacy headers', () => {
      const tr = root.querySelectorAll('.limp-rows tbody tr').filter(x => x.getAttribute('data-status') === 'error' && /BL|عميل مجهول/.test(x.textContent)).pop();
      return (tr && /خطأ/.test(tr.textContent) && /رقم البوليصة مطلوب/.test(tr.textContent) && /المستورد: عميل مجهول/.test(tr.textContent)) || (tr && tr.textContent);
    });
    // the «needs review» filter = error / warning / duplicate / skipped
    const stSel = root.querySelector('.limp-rows select[name="status"]');
    stSel.value = 'problems'; stSel.dispatch('change'); await settle(10);
    check('the «ما يحتاج مراجعة» filter asks the server for error / warning / duplicate / skipped', () => {
      const c = srv.S.calls.filter(x => x[0] === 'listRows').pop();
      return (J(c[1].status) === J(['error', 'warning', 'duplicate', 'skipped']) && root.querySelectorAll('.limp-rows tbody tr').length === 2) || J(c);
    });
    // error report CSV: every problem row, the messages, the formula guard
    ctx.downloads.length = 0;
    act(root, 'li-report-csv').click(); await until(() => ctx.downloads.length === 1);
    const csvBytesOut = ctx.downloads[0] ? new Uint8Array(await ctx.downloads[0].arrayBuffer()) : new Uint8Array(0);
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvBytesOut);
    check('error report CSV: BOM, one line per problem row, entity / sheet / row / status / messages / data (legacy cell text kept as data)', () =>
      (/^\uFEFF/.test(csv) && csv.split('\r\n').filter(Boolean).length === 3 && /المعاملات,Sheet2 @ legacy\.xlsx,4,خطأ/.test(csv) && /رقم البوليصة مطلوب/.test(csv)
        && /خانة التحقق في رقم الحاوية لا تطابق/.test(csv) && /notes: =HYPERLINK/.test(csv) && !/(^|,)=HYPERLINK/m.test(csv)) || J(csv));
    ctx.downloads.length = 0;
    act(root, 'li-report-xlsx').click(); await until(() => ctx.downloads.length === 1);
    await acheck('error report XLSX: one sheet per entity with the legacy headers as columns + the criteria sheet; text cells only (never a formula)', async () => {
      const b = ctx.downloads[0]; if (!b) return 'no file';
      const ab = await b.arrayBuffer(), wb = await ctx.w.XlsxLite.read(ab);
      const names = wb.sheets.map(s => s.name), tx = wb.sheets.find(s => s.name === 'المعاملات');
      const xml = Buffer.from(ab).toString('latin1');
      return (names[0] === 'المعاملات' && /معايير التقرير/.test(names.join()) && tx.rows[0].indexOf('رقم البوليصة') !== -1 && tx.rows.length === 3 && !/<f>|<f /.test(xml)
        && tx.rows.some(r => r.indexOf('=HYPERLINK("y")') !== -1)) || J([names, tx && tx.rows.length]);
    });
    // skip a row → back to staged
    stSel.value = ''; stSel.dispatch('change'); await settle(10);
    // options: suggest unknown values → map the old port → save → validate again
    act(root, 'li-map-suggest').click(); await settle(20);
    const portRow = root.querySelector('.limp-map-list[data-kind="ports"] .limp-map-row');
    check('«اقترح من أخطاء الفحص» adds the unknown port text with an approved-port choice', () =>
      (portRow && portRow.querySelector('input').value === 'منفذ قديم' && portRow.querySelectorAll('option').some(op => op.value === 'SAJED')) || (portRow && portRow.textContent));
    portRow.querySelector('select').value = 'SAJED';
    const fund = root.querySelector('.limp-options-card select[name="default_funding_source"]'); fund.value = 'org_account';
    act(root, 'li-options-save').click();
    await until(() => srv.S.calls.some(c => c[0] === 'options') && srv.S.run.status === 'validated' && act(root, 'li-commit'), 4000);
    const opt = srv.S.calls.find(c => c[0] === 'options');
    check('saving the options sends the mapping + options, the rows go back to pending and the validation runs again', () =>
      (opt && J(opt[1].mapping) === J({ ports: { 'منفذ قديم': 'SAJED' } }) && opt[1].options.default_funding_source === 'org_account' && opt[1].options.daftra_invoice_prefix === 'RHK-' && opt[1].branch_id === BR
        && srv.S.calls.filter(c => c[0] === 'validate').length >= 2) || J(opt));
    // commit: the confirmation dialog
    act(root, 'li-commit').click(); await settle(20);
    let f = modalForm(ctx.document);
    const ftxt = f ? f.parentNode.parentNode.textContent : '';
    await submit(f);
    check('commit asks for a confirmation that lists the safety rules; without the box ticked nothing is committed', () =>
      (/السدادات تُستورد «بانتظار المراجعة»/.test(ftxt) && /الأسماء البديلة تُستورد «مقترحة»/.test(ftxt) && /تاريخ إعادة الفارغ يُحفظ بيانات فقط/.test(ftxt) && /لا تُنشأ نوايا فوترة ولا مسودات دفترة/.test(ftxt)
        && !srv.S.calls.some(c => c[0] === 'commit')) || ftxt.slice(0, 300));
    setField(f, 'understood', true); await submit(f);
    await until(() => srv.S.run.status === 'committed' && root.querySelector('.limp-dft'), 4000);
    const commits = srv.S.calls.filter(c => c[0] === 'commit').map(c => c[1]);
    check('commit: the first call times out → retried with half the chunk, confirm: true until the first success, then no confirm; loops until done', () =>
      (J(commits[0]) === J({ limit: 100, confirm: true }) && J(commits[1]) === J({ limit: 50, confirm: true }) && commits.slice(2).every(c => !c.confirm) && srv.S.run.status === 'committed'
        && tracked.some(t => t[0] === 'limp_commit' && t[2] === true)) || J(commits));
    check('result: «مُرحّلة», committed count, the stepper done through «الترحيل» (the Daftra step is not marked current), the transaction rows link to #tx/<id>', () =>
      (/اكتمل الترحيل \(عدد الصفوف: 5\)/.test(root.textContent) && !root.querySelector('.limp-step.is-current') && !!root.querySelector('.limp-step.is-done[data-step="commit"]')
        && !root.querySelector('.limp-step.is-done[data-step="link"]') && !!root.querySelector('.limp-rows a[href="#tx/' + TX1 + '"]')) || root.textContent.slice(0, 400));
    check('harness fix: a candidate found by the RHK- reference only shows the reference and «مطابقة بالمرجع» (no «—»); the expected reference is shown on every row', () => {
      const t2 = root.querySelector('.limp-dft [data-cand="cand-2"]'), t1 = root.querySelector('.limp-dft [data-cand="cand-1"]');
      const cell = t2 && t2.querySelectorAll('td')[2];
      return (cell && /RHK-2/.test(cell.textContent) && /مطابقة بالمرجع/.test(cell.textContent) && cell.textContent.trim() !== '—' && !!cell.querySelector('[data-li="by-ref"]')
        && t1 && /RHK-1001/.test(t1.querySelectorAll('td')[2].textContent) && /RHK-1(?!0)/.test(t1.querySelectorAll('td')[2].textContent) && !t1.querySelector('[data-li="by-ref"]')) || (t2 && t2.textContent);
    });
    check('RHK- step: the candidates come from legacyImportDaftraCandidates; «مراجعة وربط» opens the transaction (the step-7 visual confirm flow); nothing is linked here', () => {
      const tr = root.querySelector('.limp-dft [data-cand="cand-1"]');
      return (tr && /RHK-1001/.test(tr.textContent) && /بانتظار التأكيد/.test(tr.textContent) && tr.querySelector('a[data-act="li-dft-review"]').getAttribute('href') === '#tx/' + TX1
        && /لا يُربط شيء تلقائيًا/.test(root.querySelector('.limp-dft').textContent) && !srv.S.calls.some(c => c[0] === 'LINK' || c[0] === 'REJECT')) || (tr && tr.textContent);
    });
    act(root, 'li-dft-queue').click(); await until(() => srv.S.calls.some(c => c[0] === 'queue'));
    await settle(20);
    check('«ابحث في دفترة» queues the read-only lookups with an idempotency key, then shows when it was requested', () =>
      (srv.S.calls.find(c => c[0] === 'queue')[1].idemKey && /طُلب البحث في/.test(root.querySelector('.limp-dft').textContent) && log.toasts.some(t => /أُضيفت عمليات بحث إلى الطابور \(العدد: 2،/.test(t[1]))) || J(log.toasts));
    // void blocked
    srv.S.blockers = { total: 1, items: [{ table: 'clients', id: 'c1', reason: 'changed', label: 'مؤسسة الاختبار التجارية' }] };
    act(root, 'li-void').click(); await settle(30);
    f = modalForm(ctx.document);
    const btxt = f ? f.parentNode.parentNode.textContent : '';
    check('void of a changed run: a dry run first, the blockers listed (record, reference, reason), no void sent', () =>
      (/لا يمكن إلغاء الدفعة LIR-000001/.test(btxt) && /عميل/.test(btxt) && /عُدِّل بعد الاستيراد/.test(btxt) && /مؤسسة الاختبار التجارية/.test(btxt)
        && srv.S.calls.filter(c => c[0] === 'void').every(c => c[2] && c[2].dryRun)) || btxt.slice(0, 300));
    await submit(f);
    // void allowed (the server answers in 3 chunks)
    srv.S.blockers = null; srv.S.voidChunks = 2;
    act(root, 'li-void').click(); await settle(30);
    f = modalForm(ctx.document);
    setField(f, 'reason', 'x'); await submit(f);
    const shortReason = srv.S.calls.filter(c => c[0] === 'void' && !(c[2] && c[2].dryRun)).length;
    setField(f, 'reason', 'بيانات مكررة'); await submit(f);
    await until(() => srv.S.run.status === 'voided');
    await settle(20);
    const realVoids = srv.S.calls.filter(c => c[0] === 'void' && !(c[2] && c[2].dryRun));
    check('void: a reason of 3+ characters, then legacyImportVoid(run, reason, {limit}) in chunks until done; kept containers named; the panel says «ملغاة» with the reason', () =>
      (shortReason === 0 && realVoids.length === 3 && realVoids.every(c => c[1] === 'بيانات مكررة' && c[2] && c[2].limit === 200)
        && /بقيت على معاملاتها \(العدد: 1\)/.test(root.textContent + ' ' + J(log.toasts)) && /أُلغيت الدفعة في/.test(root.textContent) && /بيانات مكررة/.test(root.textContent)) || J(srv.S.calls.filter(c => c[0] === 'void')));
    check('the runs list shows the run with its status and a view link #legacy_import/<id>', () =>
      (!!root.querySelector('.limp-runs [data-run="' + RUN + '"]') && !!root.querySelector('.limp-runs a[href="#legacy_import/' + RUN + '"]')) || 'runs');
  }

  section('DOM: resume an interrupted commit; skip rows; staging in chunks of 500');
  {
    const ctx = context(), rows = [];
    for (let i = 0; i < 5; i++) rows.push({ id: 'r' + i, entity: 'transactions', sheet: 'المعاملات @ a.xlsx', row_no: i + 2, data: { importer: 'ع', bl_number: 'BL' + i }, status: i < 2 ? 'committed' : 'valid', messages: [] });
    const srv = fakeServer({ rows, run: { id: RUN, ref: 'LIR-000002', status: 'committing', entities: ['transactions'], reason: 'تجربة', files: [], created_at: '2026-11-11T07:00:00Z' } });
    const { api } = mkApi(ctx, srv.A);
    const V = ctx.w.MarsaOps.views.legacy_import; V._reset();
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    V.render(root, api, null);
    await until(() => act(root, 'li-commit-resume'));
    check('an open run in «قيد الترحيل» opens by itself with «تابع الترحيل» and the note that nothing is written twice; no file picker; no void while committing', () =>
      (/لا يُكتب صف مرتين/.test(root.textContent) && !root.querySelector('#limp-files') && !act(root, 'li-void')) || root.textContent.slice(0, 300));
    act(root, 'li-commit-resume').click();
    await until(() => srv.S.run.status === 'committed');
    check('resume: commit calls without confirm until done', () => (srv.S.calls.filter(c => c[0] === 'commit').every(c => !c[1].confirm) && srv.S.run.status === 'committed') || J(srv.S.calls));
  }
  {
    const ctx = context(), rows = [];
    for (let i = 0; i < 3; i++) rows.push({ id: 'r' + i, entity: 'drivers', sheet: 'السائقون @ d.csv', row_no: i + 2, data: { name: 'سائق ' + i }, status: 'valid', messages: [] });
    const srv = fakeServer({ rows, run: { id: RUN, ref: 'LIR-000003', status: 'validated', entities: ['drivers', 'transactions'], reason: 'تجربة', files: [], created_at: '2026-11-11T07:00:00Z' } });
    const { api } = mkApi(ctx, srv.A);
    const V = ctx.w.MarsaOps.views.legacy_import; V._reset();
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    V.render(root, api, null);
    await until(() => root.querySelectorAll('.limp-rows tbody tr').length === 3);
    const cb = root.querySelector('.limp-rows input[data-row="r1"]'); cb.checked = true; cb.dispatch('change');
    act(root, 'li-skip').click(); await until(() => srv.S.calls.some(c => c[0] === 'skip'));
    await settle(20);
    check('skip: the picked row ids are sent; the run goes back to «مرفوعة» (validate again)', () =>
      (J(srv.S.calls.find(c => c[0] === 'skip').slice(1)) === J([['r1'], true]) && /مرفوعة/.test(root.querySelector('.limp-run').textContent) && !!act(root, 'li-validate')) || J(srv.S.calls));
    // add more files to the open run: 1200 transaction rows → 500 + 500 + 200
    const big = [['المستورد', 'رقم البوليصة']].concat(Array.from({ length: 1200 }, (x, i) => ['عميل ' + i, 'BL-' + i]));
    const bytes = ctx.w.XlsxLite.writeBytes([{ name: 'المعاملات', rows: big }, { name: 'السدادات', rows: [canon('payments')] }]);
    const input = root.querySelector('#limp-files');
    check('an open run in «مرفوعة» offers «إضافة ملفات إلى الدفعة»', () => (!!input && /إضافة ملفات إلى الدفعة/.test(root.textContent)) || 'add');
    input.files = [toFile('big.xlsx', bytes)]; input.dispatch('change');
    act(root, 'li-read').click(); await until(() => root.querySelectorAll('[data-sheet]').length === 2);
    check('an entity outside the run (payments) is not offered and is flagged', () => {
      const c = root.querySelectorAll('[data-sheet]')[1];
      return (/ليس من بيانات الدفعة المفتوحة/.test(c.textContent) && !c.querySelectorAll('select[name="entity"] option').some(o => o.value === 'payments')) || c.textContent.slice(0, 200);
    });
    act(root, 'li-stage-more').click();
    await until(() => srv.S.calls.filter(c => c[0] === 'stage').length === 3 && srv.S.run.status === 'validated', 5000);
    const st = srv.S.calls.filter(c => c[0] === 'stage');
    check('staging into the open run: no new run, three chunks of 500 / 500 / 200 in row order (only the first replaces the sheet), then validation', () =>
      (!srv.S.calls.some(c => c[0] === 'create') && J(st.map(c => [c[3], c[4], c[5]])) === J([[500, 2, true], [500, 502, false], [200, 1002, false]]) && srv.S.calls.some(c => c[0] === 'validate')) || J(st));
  }

  section('DOM: skipping a parent row warns first (harness fix)');
  {
    const ctx = context(), rows = [{ id: 'c0', entity: 'customers', sheet: 'دليل العملاء @ c.xlsx', row_no: 2, data: { name_ar: 'عميل أ' }, status: 'valid', messages: [] },
      { id: 't0', entity: 'transactions', sheet: 'المعاملات @ c.xlsx', row_no: 2, data: { importer: 'عميل أ', bl_number: 'B1' }, status: 'valid', messages: [] }];
    const srv = fakeServer({ rows, run: { id: RUN, ref: 'LIR-000004', status: 'validated', entities: ['customers', 'transactions'], reason: 'تجربة', files: [], created_at: '2026-11-11T07:00:00Z' } });
    const { api } = mkApi(ctx, srv.A);
    const V = ctx.w.MarsaOps.views.legacy_import; V._reset();
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    V.render(root, api, null);
    await until(() => root.querySelectorAll('.limp-rows tbody tr').length === 2);
    const cb = root.querySelector('.limp-rows input[data-row="c0"]'); cb.checked = true; cb.dispatch('change');
    act(root, 'li-skip').click(); await settle(30);
    const f = modalForm(ctx.document);
    const wt = f ? f.parentNode.parentNode.textContent : '';
    check('skip a customer row: a warning lists its dependents and «العميل غير موجود»-type failures; nothing is skipped yet', () =>
      (/ستفشل تلك الصفوف/.test(wt) && /client_not_found|غير موجود|لم يُعثر/.test(wt) && !srv.S.calls.some(c => c[0] === 'skip')) || wt.slice(0, 300));
    await submit(f); await until(() => srv.S.calls.some(c => c[0] === 'skip'));
    check('confirming the warning sends the skip', () => (J(srv.S.calls.find(c => c[0] === 'skip').slice(1)) === J([['c0'], true])) || J(srv.S.calls));
  }

  section('DOM: resume an interrupted void');
  {
    const ctx = context();
    const srv = fakeServer({ rows: [], run: { id: RUN, ref: 'LIR-000009', status: 'voiding', entities: ['transactions'], reason: 'تجربة', void_reason: 'سبب الإلغاء', files: [], created_at: '2026-11-11T07:00:00Z' } });
    const { api } = mkApi(ctx, srv.A);
    const V = ctx.w.MarsaOps.views.legacy_import; V._reset();
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    V.render(root, api, null);
    await until(() => act(root, 'li-void-resume'));
    check('a run «قيد الإلغاء» opens with «تابع الإلغاء» and its note; no file picker; no new void', () =>
      (/تابع الإلغاء/.test(root.textContent) && /لا تبدأ دفعة جديدة قبل نهايته/.test(root.textContent) && !root.querySelector('#limp-files') && !act(root, 'li-void')) || root.textContent.slice(0, 300));
    act(root, 'li-void-resume').click();
    await until(() => srv.S.run.status === 'voided');
    check('resume: void calls with the stored reason (no dry run) until done', () =>
      (srv.S.calls.filter(c => c[0] === 'void').length >= 1 && srv.S.calls.filter(c => c[0] === 'void').every(c => c[1] === 'سبب الإلغاء' && !(c[2] && c[2].dryRun))) || J(srv.S.calls));
  }

  section('DOM: English (LTR labels from the dictionary + the server labels)');
  {
    LANG = 'en';
    const ctx = context(), rows = [{ id: 'r0', entity: 'customers', sheet: 'c @ f.xlsx', row_no: 2, data: { name_ar: 'أ' }, status: 'error', messages: [{ level: 'error', code: 'client_ambiguous', field: 'name_ar' }] }];
    const srv = fakeServer({ rows, run: { id: RUN, ref: 'LIR-000004', status: 'validated', entities: ['customers'], reason: 'test', files: [], created_at: '2026-11-11T07:00:00Z' } });
    const { api } = mkApi(ctx, srv.A);
    const V = ctx.w.MarsaOps.views.legacy_import; V._reset();
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    V.render(root, api, null);
    await until(() => root.querySelectorAll('.limp-rows tbody tr').length === 1);
    const t = root.textContent;
    LANG = 'ar';
    check('English: page title, run status, entity and message labels in English; no Arabic UI string leaks in the run card', () =>
      (/Legacy data import/.test(t) && /Import run LIR-000004/.test(t) && /Validated/.test(t) && /Several clients with this name/.test(t) && /Customers/.test(t)
        && !/[\u0600-\u06FF]/.test(root.querySelector('.limp-run').textContent.replace(/أ/g, ''))) || t.slice(0, 300));
  }

  section('owner decisions recorded (dated) and respected');
  check('«قرارات المالك» has a dated 2026-11-11 line for the step-9 UI defaults', () => /- \(2026-11-11\) قرارات افتراضية لواجهة المرحلة 9/.test(PLAN) || 'plan');

  console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\nFAILURES:'); fails.forEach(x => console.log('  - ' + x)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
