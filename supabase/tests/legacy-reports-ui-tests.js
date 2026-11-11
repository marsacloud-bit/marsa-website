#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy step 8 «التقارير ولوحات المتابعة والتنبيهات» UI tests: assets/js/rpt/colfilter.js (MarsaColFilter),
  rpt/register.js (#register + the follow-up export), rpt/fasah-recon.js (#fasah_recon + MarsaOps.fasahRecon), rpt/audit-diff.js
  (#changes + the tx log + MarsaAuditDiff), rpt/rules.js (#attention_rules), the step-8 parts of rpt/export.js / rpt/xlsx.js /
  rpt/reports.js / rpt/dashboards.js / ops/alerts.js / app-shell.js (progress, response badge, technical errors, the e-mail code
  gate, nav), admin.js (#transactions?… → #register), supa.js (OTP wrappers + gate), login.html / auth.js (OTP tab),
  assets/i18n/lrpt.js and the page wiring (admin.html / sw.js / lrpt.css). Pure Node, no database, no network
  (vm + window shim + supabase/tests/lib/fake-dom.js; the real MarsaOps.ui / MarsaExport / XlsxLite / MarsaXlsx are loaded).

  usage:  node supabase/tests/legacy-reports-ui-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

/* ------------------------------------------------------------ sources */
const F = {
  colfilter: 'assets/js/rpt/colfilter.js', register: 'assets/js/rpt/register.js', recon: 'assets/js/rpt/fasah-recon.js', audit: 'assets/js/rpt/audit-diff.js',
  rules: 'assets/js/rpt/rules.js', dict: 'assets/i18n/lrpt.js', exp: 'assets/js/rpt/export.js', xlsx: 'assets/js/rpt/xlsx.js', reports: 'assets/js/rpt/reports.js',
  dash: 'assets/js/rpt/dashboards.js', alerts: 'assets/js/ops/alerts.js', shell: 'assets/js/app-shell.js', admin: 'assets/js/admin.js', supa: 'assets/js/supa.js',
  auth: 'assets/js/auth.js', i18n: 'assets/js/i18n.js', rptDict: 'assets/i18n/rpt.js', opsDict: 'assets/i18n/ops.js', payDict: 'assets/i18n/pay.js', loginDict: 'assets/i18n/login.js',
  xlite: 'assets/js/xlsx-lite.js'
};
const SRC = {}; Object.keys(F).forEach(k => { SRC[k] = rd(F[k]); });
const MIG = rd('supabase/migrations/20261124000100_legacy_reports.sql');
const ADMIN_HTML = rd('admin.html'), LOGIN_HTML = rd('login.html'), SW = rd('sw.js'), CSS = rd('assets/css/pages/lrpt.css');
const PLAN = rd('docs/online/LEGACY_PORT_PLAN_AR.md');

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
  label(domain, code) { const k = 'label.' + domain + '.' + code; return dicts[LANG][k] || dicts.ar[k] || String(code); },
  lang() { return LANG; }
};
function makeStorage(o) {
  const m = {};
  return {
    getItem(k) { if (o && o.throws) throw new Error('blocked'); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem(k, v) { if (o && o.throws) throw new Error('quota'); m[k] = String(v); },
    removeItem(k) { delete m[k]; }, _m: m
  };
}
const ok = d => Promise.resolve({ data: d, error: null });
const err = (code, detail) => Promise.resolve({ data: null, error: { code, detail, message: code } });
const ORG = '00000000-0000-4000-8000-000000000001', BR = '00000000-0000-4000-8000-0000000000b1', U1 = '00000000-0000-4000-8000-0000000000a1';
const TX1 = '00000000-0000-4000-8000-000000000101', TX2 = '00000000-0000-4000-8000-000000000102', TX3 = '00000000-0000-4000-8000-000000000103';

function context(o) {
  o = o || {};
  const { document, Node } = makeDom();
  document.documentElement = new Node('html');
  document.documentElement.dir = 'rtl';
  document.activeElement = null;
  document.contains = () => true;
  document.removeEventListener = () => {};
  // form.elements (by name) for the submit handlers
  Object.defineProperty(Object.getPrototypeOf(document.body), 'elements', { configurable: true, get() { const out = {}; this.walk(n => { const nm = n.getAttribute && n.getAttribute('name'); if (nm && !out[nm]) out[nm] = n; }); return out; } });
  const storage = o.storage || makeStorage();
  const hashes = [], downloads = [];
  const location = { hash: o.hash || '' };
  const w = { MarsaI18n: I18N, document, localStorage: storage, sessionStorage: makeStorage(), open: () => null, confirm: () => true, print: () => {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, innerWidth: 1280, innerHeight: 900,
    URL: { createObjectURL: b => { downloads.push(b); return 'blob:x'; }, revokeObjectURL() {} }, MARSA_CONFIG: o.config || {} };
  w.window = w;
  const c = { window: w, document, localStorage: storage, location, history: { state: null, replaceState(s, t, u) { hashes.push(u); location.hash = u; } },
    Intl, Date, Math, String, Object, Array, JSON, Number, RegExp, parseInt, parseFloat, isFinite, isNaN, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    encodeURIComponent, decodeURIComponent, Error, TextDecoder, TextEncoder, Uint8Array, DataView, ArrayBuffer, Blob, Response, DecompressionStream,
    Event: function (t, x) { this.type = t; Object.assign(this, x || {}); }, CustomEvent: function (t) { this.type = t; }, console };
  vm.createContext(c);
  ['rptDict', 'opsDict', 'payDict', 'dict', 'alerts', 'xlite', 'xlsx', 'exp', 'reports', 'dash', 'colfilter', 'register', 'recon', 'audit', 'rules']
    .forEach(k => vm.runInContext(SRC[k], c, { filename: F[k] }));
  return { document, w, c, storage, hashes, downloads, location };
}
// labels admin.js loads from status_labels in the app (transaction_type, cargo_unit_type, transaction_state, movement_status)
I18N.register('label', { ar: { 'transaction_type.re_export': 'إعادة تصدير', 'transaction_type.normal': 'عادية', 'cargo_unit_type.roro': 'Ro-Ro', 'cargo_unit_type.container': 'حاوية',
  'transaction_state.cancelled': 'ملغاة', 'movement_status.delivered': 'سُلّمت', 'movement_status.cancelled': 'ملغاة', 'movement_status.registered': 'مسجلة', 'movement_status.incomplete': 'غير مكتملة' },
  en: { 'transaction_type.re_export': 'Re-export', 'cargo_unit_type.roro': 'Ro-Ro' } });
const base = context();
const O = base.w.MarsaOps, CF = base.w.MarsaColFilter, FR = O.fasahRecon, AD = base.w.MarsaAuditDiff, K = base.w.MarsaExport.kit();

// an opsApi like admin.js opsApi(): roles decide can(set)
const SETS = {
  staff: ['clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
  finRead: ['accountant', 'accounts_manager', 'branch_manager', 'supervisor', 'admin'],
  tripFin: ['accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
  auditRead: ['admin', 'supervisor'], orgAdmin: ['admin'], opsWriter: ['clearance_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin']
};
function mkApi(ctx, A, roles, over) {
  const U = ctx.w.MarsaOps.ui;
  return Object.assign({
    orgId: ORG, roles: roles.slice(), branches: [{ id: BR, name_ar: 'جدة', name_en: 'Jeddah' }], userId: U1, orgName: 'مؤسسة الاختبار',
    can(set, br) { const list = Array.isArray(set) ? set : SETS[set]; return !!list && roles.some(r => list.indexOf(r) !== -1); },
    t: k => k, el: U.el, toast() {}, confirm: () => Promise.resolve(true), go(h) { ctx.location.hash = h; }, refresh() {},
    label: (d, c) => I18N.label(d, c), fmtDate: v => String(v), fmtMoney: (n, c) => n + ' ' + c, fmtNumber: n => String(n), who: () => 'موظف',
    isEn: () => LANG === 'en', errText: e => (e && e.code) || 'err', hashQuery: () => ({}), query: '', MarsaApi: A
  }, over || {});
}
const textOf = n => (n && n.textContent) || '';
const byText = (root, re, tag) => root.querySelectorAll(tag || 'button').filter(b => re.test(b.textContent))[0];

/* ================================================================ static */
section('static: classic scripts, ES5 only, no innerHTML, compile');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const NEW = ['colfilter', 'register', 'recon', 'audit', 'rules', 'dict'];
NEW.forEach(k => {
  check(F[k] + ': IIFE + strict, ES5 only (no let/const/arrow/template/class), no innerHTML', () => {
    const s = strip(SRC[k]);
    return (/^\(function \(/m.test(s) && /'use strict';/.test(s) && !/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s) && !/\bclass\s+\w/.test(s)
      && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(s)) || 'not ES5 / uses HTML';
  });
});
['exp', 'xlsx', 'reports', 'dash', 'alerts', 'admin', 'shell', 'supa', 'auth'].forEach(k => {
  check(F[k] + ': still ES5 after the step-8 changes', () => { const s = strip(SRC[k]); return (!/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s)) || F[k]; });
});
check('the step-8 parts of export.js / reports.js / dashboards.js never use innerHTML', () =>
  !/innerHTML|insertAdjacentHTML/.test(strip(SRC.exp) + strip(SRC.reports) + strip(SRC.dash)) || 'innerHTML');
check('every new / changed file compiles (node --check equivalent)', () => {
  Object.keys(F).concat([]).forEach(k => new vm.Script(SRC[k], { filename: F[k] }));
  new vm.Script(SW, { filename: 'sw.js' });
  return true;
});
check('modules registered: views register / fasah_recon / changes / attention_rules (+ reports kept), tx section audit-trail, MarsaColFilter, fasahRecon, MarsaAuditDiff', () =>
  (O.views.register && O.views.register.allow === 'staff' && O.views.fasah_recon && O.views.fasah_recon.allow === 'staff' && J(O.views.changes.allow) === J(['admin', 'supervisor'])
    && O.views.attention_rules && O.views.attention_rules.allow === 'staff' && O.views.reports && O.txSections.some(s => s.id === 'audit-trail')
    && CF && CF.VERSION === 'cf-1' && FR && typeof FR.compare === 'function' && AD && AD.VERSION === 'audit-diff-1') || Object.keys(O.views));
check('read only: no step-8 view calls a write RPC except the owner settings (setStatusAgingRules / setEmailOtpLogin) and the export log', () => {
  const ui = SRC.register + SRC.recon + SRC.audit + SRC.colfilter;
  const calls = (ui.match(/U\.call\(api, '([a-zA-Z]+)'/g) || []).map(s => s.replace(/U\.call\(api, '|'/g, ''));
  const allowed = ['reportTransactions', 'txAttention', 'listClients', 'listMemberships', 'reportFasahScope', 'logReportExport', 'auditTrail'];
  const rulesCalls = (SRC.rules.match(/U\.call\(api, '([a-zA-Z]+)'/g) || []).map(s => s.replace(/U\.call\(api, '|'/g, ''));
  return (calls.every(c => allowed.indexOf(c) !== -1) && J(rulesCalls.sort()) === J(['getStatusAgingRules', 'setEmailOtpLogin', 'setStatusAgingRules'])
    && !/approve[A-Z]\w*\(|aiExtract|createBilling|pushDaftra|createDaftraDraft/.test(ui)) || J([calls, rulesCalls]);
});

/* ================================================================ dictionary */
section('dictionary lrpt (ar = en keys, {vars} parity, every key used exists) + label entries = the migration rows');
const D = base.w.MarsaLrptDict, LB = base.w.MarsaLrptLabels;
check('ar and en have the same keys (and > 400 of them)', () => {
  const a = Object.keys(D.ar), e = Object.keys(D.en);
  return (a.length > 400 && a.length === e.length && a.every(k => k in D.en)) || J([a.filter(k => !(k in D.en)), e.filter(k => !(k in D.ar))]);
});
check('{vars} parity between ar and en', () => {
  const bad = Object.keys(D.ar).filter(k => (D.ar[k].match(/\{\w+\}/g) || []).sort().join() !== (D.en[k].match(/\{\w+\}/g) || []).sort().join());
  return !bad.length || bad;
});
check('every literal lrpt key used by the step-8 code exists', () => {
  const pats = [[SRC.exp, /\blt\('([a-zA-Z0-9_.]+)'/g], [SRC.reports, /K\.lt\('([a-zA-Z0-9_.]+)'/g], [SRC.register, /\blt\('([a-zA-Z0-9_.]+)'/g], [SRC.dash, /\blt\(api, '([a-zA-Z0-9_.]+)'/g],
    [SRC.recon, /\blt\('([a-zA-Z0-9_.]+)'/g], [SRC.audit, /\b(?:lt|txt)\('([a-zA-Z0-9_.]+)'/g], [SRC.rules, /\blt\('([a-zA-Z0-9_.]+)'/g], [SRC.colfilter, /\bt\('(cf_[a-zA-Z0-9_]+)'/g],
    [SRC.shell, /\bpt\('([a-zA-Z0-9_]+)'/g]];
  const miss = [];
  pats.forEach(p => { [...p[0].matchAll(p[1])].map(m => m[1]).filter(k => !/[_.]$/.test(k)).forEach(k => { if (!(k in D.ar) && miss.indexOf(k) === -1) miss.push(k); }); });
  ['q_critical', 'q_daftra_draft', 'q_re_export', 'q_roro', 'fr_k_released', 'fr_k_released_not', 'fr_k_port_mismatch', 'fr_k_ambiguous', 'fr_k_unknown_port', 'fr_k_duplicates',
    'otp_turn_on', 'otp_turn_off', 'otp_on', 'otp_off', 'otp_now_on', 'otp_now_off', 'cf_open', 'cf_open_active', 'rules_warning', 'rules_critical'].forEach(k => { if (!(k in D.ar)) miss.push(k); });
  return !miss.length || miss;
});
check('every dynamic family is complete (ports, categories, party types, attention, Daftra state, Fasah statuses / notes / file errors, sorts, date fields)', () => {
  const need = [].concat(['SAJED', 'SADMM', 'SAKAC', 'SARUH', 'SAJED_AIR', 'SADMM_AIR', 'SARUH_AIR'].map(p => 'port_' + p), ['airport', 'port', 'shared'].map(c => 'cat_' + c),
    ['supplier', 'company', 'direct'].map(c => 'party_type_' + c), ['any', 'warning', 'critical'].map(c => 'att_filter_' + c), ['warning', 'critical'].map(c => 'att_level_' + c),
    ['status_stale', 'appointment_not_updated', 'empty_return_overdue'].map(c => 'att_reason_' + c), ['none', 'draft', 'issued', 'cancelled_review'].map(c => 'dft_state_' + c),
    FR.STATUSES.map(c => 'fms_' + c), ['ambiguous', 'port', 'port_unknown', 'missing', 'date', 'importer', 'released'].map(c => 'fr_note_' + c),
    ['not_xlsx', 'empty', 'too_big', 'no_reader', 'unreadable', 'no_header', 'no_records', 'too_many_rows', 'inflate_big', 'too_wide'].map(c => 'fr_file_err_' + c),
    ['files', 'no_records', 'too_many_records', 'too_many_scopes'].map(c => 'fr_err_' + c),
    ['appointment_desc', 'appointment_asc', 'deadline_asc', 'updated_desc', 'paid_desc', 'paid_asc', 'amount_desc', 'created_desc', 'ref_desc', 'declaration_date_desc', 'declaration_date_asc'].map(c => 'sort_' + c),
    ['created', 'eta', 'declaration', 'status_changed', 'updated'].map(c => 'sdf_' + c), ['overdue', 'pending', 'returned'].map(c => 'return_scope_' + c));
  const miss = need.filter(k => !(k in D.ar));
  return !miss.length || miss;
});
check('label.<domain>.<code> entries = the 20261124000100 status_labels rows (ar + en) for the step-8 domains', () => {
  const rows = [...MIG.matchAll(/\('([a-z_]+)','([a-z_.]+)',\d+,'([^']*)','([^']*)',(?:true|false)\)/g)];
  const domains = ['attention_level', 'attention_reason', 'tx_daftra_state', 'movement_date_field', 'return_scope', 'payment_date_field', 'fasah_match_status', 'audit_label', 'audit_event', 'alert_kind', 'report_kind', 'search_date_field'];
  const bad = rows.filter(m => domains.indexOf(m[1]) !== -1).filter(m => LB.ar[m[1] + '.' + m[2]] !== m[3] || LB.en[m[1] + '.' + m[2]] !== m[4]).map(m => m[1] + '.' + m[2]);
  const n = rows.filter(m => domains.indexOf(m[1]) !== -1).length;
  return (!bad.length && n >= 80 && Object.keys(LB.ar).length === Object.keys(LB.en).length) || J({ bad, n });
});
check('declaration_status labels (10) match 20261117000100', () => {
  const core = rd('supabase/migrations/20261117000100_legacy_core.sql');
  const rows = [...core.matchAll(/\('declaration_status','([a-z_]+)',\d+,'([^']*)','([^']*)',true\)/g)];
  return (rows.length === 10 && rows.every(m => LB.ar['declaration_status.' + m[1]] === m[2] && LB.en['declaration_status.' + m[1]] === m[3])) || rows.length;
});
check('the new alert kinds have ops labels (ar + en) and are in the #alerts kind filter', () =>
  (/alert_kind_status_stale: 'معاملة متأخرة بلا تحديث'/.test(SRC.opsDict) && /alert_kind_appointment_not_updated: 'Appointment passed, movement not updated'/.test(SRC.opsDict)
    && /'declaration_stalled',\s*\n\s*\/\/[^\n]*\n\s*'status_stale', 'appointment_not_updated'\]/.test(SRC.alerts)) || 'alerts');
check('i18n.js / supa.js: AUTH_OTP_INVALID (ar + en) and the step-8 detail messages kept', () =>
  ((SRC.i18n.match(/AUTH_OTP_INVALID:/g) || []).length === 2 && /AUTH_OTP_INVALID: 'الرمز غير صحيح أو انتهت صلاحيته\.'/.test(SRC.supa)
    && (SRC.i18n.match(/cdetail_MRS_INVALID_aging_rule:/g) || []).length === 2) || 'otp msg');

/* ================================================================ wiring */
section('wiring: admin.html, sw.js, nav, admin.js redirect, CSS');
function order(html, list) { let i = -1; return list.every(f => { const j = html.indexOf('src="' + f + '"'); const okk = j > i; i = j; return okk && j !== -1; }); }
check('admin.html: lrpt.css after rpt.css / dash.css; i18n/lrpt.js after i18n.js; the five modules after rpt/export.js / reports.js / dashboards.js and before admin.js', () =>
  (/href="assets\/css\/pages\/lrpt\.css"/.test(ADMIN_HTML) && ADMIN_HTML.indexOf('pages/lrpt.css') > ADMIN_HTML.indexOf('pages/dash.css')
    && order(ADMIN_HTML, ['assets/js/i18n.js', 'assets/i18n/rpt.js', 'assets/i18n/lrpt.js', 'assets/js/app-shell.js', 'assets/js/xlsx-lite.js', 'assets/js/ops/alerts.js', 'assets/js/rpt/xlsx.js',
      'assets/js/rpt/export.js', 'assets/js/rpt/reports.js', 'assets/js/rpt/dashboards.js', 'assets/js/rpt/colfilter.js', 'assets/js/rpt/register.js', 'assets/js/rpt/fasah-recon.js',
      'assets/js/rpt/audit-diff.js', 'assets/js/rpt/rules.js', 'assets/js/admin.js'])) || 'admin.html order');
check('sw.js: VERSION bumped past step 7 (2026-11-24.1 or a later release) and every new file precached', () =>
  (!/var VERSION = '2026-11-23\.2'/.test(SW) && ((/var VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)'/.exec(SW) || [])[1] || '').localeCompare('2026-11-24.1', 'en', { numeric: true }) >= 0
    && ['assets/css/pages/lrpt.css', 'assets/i18n/lrpt.js', 'assets/js/rpt/colfilter.js', 'assets/js/rpt/register.js', 'assets/js/rpt/fasah-recon.js', 'assets/js/rpt/audit-diff.js', 'assets/js/rpt/rules.js']
      .every(f => SW.indexOf("'" + f + "'") !== -1)) || 'sw.js');
check('app-shell NAV: register / fasah_recon (staff), attention_rules (staff), changes (auditRead) + their fallback labels; admin.js NAV_ORDER has them', () =>
  (/\{ id: 'register', key: 'lrpt\.nav_register', href: 'admin\.html#register', icon: 'layers', allow: R\.staff \}/.test(SRC.shell)
    && /\{ id: 'fasah_recon', key: 'lrpt\.nav_fasah_recon', href: 'admin\.html#fasah_recon', icon: 'listCheck', allow: R\.staff \}/.test(SRC.shell)
    && /\{ id: 'attention_rules', key: 'lrpt\.nav_rules', href: 'admin\.html#attention_rules', icon: 'clock', allow: R\.staff \}/.test(SRC.shell)
    && /\{ id: 'changes', key: 'lrpt\.nav_changes', href: 'admin\.html#changes', icon: 'history', allow: R\.auditRead \}/.test(SRC.shell)
    && (SRC.shell.match(/'lrpt\.nav_register':/g) || []).length === 2
    && /'transactions', 'register',/.test(SRC.admin) && /'reports', 'fasah_recon',/.test(SRC.admin) && /'attention_rules', 'audit', 'changes',/.test(SRC.admin)) || 'nav');
check('admin.js: a filtered #transactions?status|stage|daftra_state|attention link opens #register (module loaded), plain / branch-only #transactions stays; the list links the register', () => {
  const m = /function registerRedirect\(r\) \{([\s\S]*?)\n  \}/.exec(SRC.admin);
  if (!m) return 'no registerRedirect';
  const fn = new Function('opsView', 'return function (r) {' + m[1] + '};')(() => true);
  const off = new Function('opsView', 'return function (r) {' + m[1] + '};')(() => null);
  return (fn({ name: 'transactions', query: 'status=new' }) === 'status=new' && fn({ name: 'transactions', query: 'stage=released&branchId=x' }) === 'stage=released&branchId=x'
    && fn({ name: 'transactions', query: 'daftra_state=draft' }) === 'daftra_state=draft' && fn({ name: 'transactions', query: 'attention=any&evil=1' }) === 'attention=any'
    && fn({ name: 'transactions', query: 'status=' }) === null && fn({ name: 'transactions', query: 'branchId=abc' }) === null && fn({ name: 'transactions', query: '' }) === null
    && fn({ name: 'clients', query: 'status=new' }) === null && off({ name: 'transactions', query: 'status=new' }) === null
    && /history\.replaceState\(null, '', '#register\?' \+ rq\)/.test(SRC.admin) && /href: '#register', 'data-act': 'open-register'/.test(SRC.admin)) || 'redirect';
});
check('lrpt.css: phone width — grid / stack children min-width 0, the column filter is a bottom sheet below 600 px, td row tones (beat the striped tr), print tones, no dark theme', () =>
  (/\.lrpt-register > \*, \.lrpt-recon > \*[^{]*\{ min-width: 0; \}/.test(CSS) && /@media \(max-width: 599px\) \{[\s\S]*?\.cf-pop \{ inset-inline: 8px; inset-block-start: auto; inset-block-end: 8px;/.test(CSS)
    && /\.rpt-table tbody tr\.lrpt-stage-released > td \{ background-color:/.test(CSS) && /td\.is-tone-danger \{ background: #F8D7DA/.test(CSS)
    && !/prefers-color-scheme/.test(CSS) && /\.cf-row \{[^}]*min-block-size: 32px/.test(CSS)) || 'css');
check('export kit: logReportExport knows the four new reports; every new def report is one of them', () =>
  (/'movements', 'payments', 'tx_followup', 'fasah_recon'\], EXPORT_FORMATS/.test(SRC.supa) && ['movements', 'payments', 'tx_followup'].every(k => K.defs[k] && K.defs[k].report === k)
    && /report: 'fasah_recon'/.test(SRC.recon)) || 'reports');
check('every MarsaApi function the step-8 UI calls is exported by supa.js', () => {
  const names = ['dashTxCounts', 'txAttention', 'reportMovements', 'reportPayments', 'reportFasahScope', 'getStatusAgingRules', 'setStatusAgingRules', 'setEmailOtpLogin',
    'otpSessionCheck', 'auditTrail', 'requestEmailOtp', 'verifyEmailOtp', 'otpGate', 'reportTransactions', 'reportTrips', 'logReportExport'];
  const miss = names.filter(n => !new RegExp('\\b' + n + ': ' + n + '\\b').test(SRC.supa));
  return (!miss.length && /emailOtpEnabled: function \(\) \{ return configured && cfg\.emailOtpLogin === true; \}/.test(SRC.supa)) || miss;
});

/* ================================================================ contract with 20261124000100 */
section('contract: filter keys ⊆ the server key lists; the export columns');
function sqlArray(name) {
  const m = new RegExp('FUNCTION app\\.' + name + '\\(\\)[\\s\\S]*?ARRAY\\[([\\s\\S]*?)\\]').exec(MIG);
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]) : null;
}
const SEARCH_KEYS = sqlArray('rpt_search_keys'), MV_KEYS = sqlArray('rpt_mv_keys'), PAY_KEYS = sqlArray('rpt_pay_keys'), TRIP_KEYS = sqlArray('rpt_trip_keys');
check('the migration key lists were found', () => (SEARCH_KEYS && MV_KEYS && PAY_KEYS && TRIP_KEYS && SEARCH_KEYS.length > 20) || J([SEARCH_KEYS, MV_KEYS, PAY_KEYS, TRIP_KEYS]));
check('#register filter keys ⊆ rpt_search_keys (also the tx_followup export log keys)', () => {
  const keys = Object.keys(O.views.register._pure.SCHEMA);
  const miss = keys.filter(k => SEARCH_KEYS.indexOf(k) === -1);
  return !miss.length || miss;
});
function reportsSchema(kind) {
  const m = new RegExp('    ' + kind + ': \\{([\\s\\S]*?)\\},\\n').exec(SRC.reports);
  return m ? [...m[1].matchAll(/([a-z_]+): '/g)].map(x => x[1]) : [];
}
check('#reports movements keys ⊆ rpt_mv_keys, payments ⊆ rpt_pay_keys, trips ⊆ rpt_trip_keys (driver_q / party_type / party_q / q included)', () => {
  const mv = reportsSchema('movements'), pay = reportsSchema('payments'), tr = reportsSchema('trips');
  const bad = mv.filter(k => MV_KEYS.indexOf(k) === -1).concat(pay.filter(k => PAY_KEYS.indexOf(k) === -1), tr.filter(k => TRIP_KEYS.indexOf(k) === -1));
  return (!bad.length && mv.length >= 25 && pay.length >= 13 && ['driver_q', 'party_type', 'party_q', 'q'].every(k => tr.indexOf(k) !== -1)) || J({ bad, mv: mv.length, pay: pay.length });
});
check('movements file: the legacy 19 columns with trip finance (contract order), 17 without (no value / revenue)', () => {
  const want = ['client_name', 'port_name', 'driver_name', 'driver_phone', 'truck_plate', 'container_no', 'declaration_no', 'bl_number', 'appointment_at', 'destination', 'cost_amount',
    'sell_amount', 'return_location', 'return_deadline', 'returned_at', 'return_status', 'movement_status', 'appointment_no', 'notes'];
  const fin = K.defs.movements.columns({ finance: true }).map(c => c.key), nof = K.defs.movements.columns({ finance: false }).map(c => c.key);
  return (J(fin) === J(want) && J(nof) === J(want.filter(k => k !== 'cost_amount' && k !== 'sell_amount'))) || J([fin, nof]);
});
check('regression: movements export verify leaves cancelled movements out of the money totals (as report_movements does)', () => {
  const items = [{ movement_status: 'delivered', cost_amount: 500, cost_currency: 'SAR', sell_amount: 700, sell_currency: 'SAR' },
    { movement_status: 'cancelled', cost_amount: 300, cost_currency: 'SAR', sell_amount: 400, sell_currency: 'SAR' }];
  const d = { totals: { count: 2, by_movement_status: { delivered: 1, cancelled: 1 }, transport_value: { SAR: 500 }, revenue: { SAR: 700 } } };
  const ok = K.defs.movements.verify(items, d, { finance: true });
  const bad = K.defs.movements.verify(items, { totals: Object.assign({}, d.totals, { transport_value: { SAR: 800 } }) }, { finance: true });
  return (ok === null && bad === 'transport_value') || J([ok, bad]);
});
check('follow-up file: the legacy 14 columns (م … فاتورة دفترة) for finance readers, 13 without the Daftra column; the status cell carries the attention tone', () => {
  const cols = K.defs.tx_followup.columns({ finRead: true }), labels = cols.map(c => c.label);
  const want = ['م', 'رقم المعاملة', 'المستورد', 'رقم البيان', 'تاريخ البيان', 'رقم البوليصة', 'عدد الوحدات', 'وحدة الشحن', 'الميناء / المنفذ', 'المشغل', 'الوكيل الملاحي', 'الباخرة', 'حالة المعاملة', 'فاتورة دفترة'];
  const st = cols.filter(c => c.key === 'status')[0];
  return (J(labels) === J(want) && K.defs.tx_followup.columns({ finRead: false }).length === 13 && st.tone({ attention: { level: 'critical' } }) === 'danger'
    && st.tone({ attention: { level: 'warning' } }) === 'warning' && st.tone({}) === null && K.defs.tx_followup.seq === true) || J(labels);
});
check('payments file (legacy «كشف السدادات»): ref, date, client, transactions, declarations, B/L, service, movement / source / method, beneficiary, SADAD no. / bank ref / receipt as three columns, amounts, review, status, entered by; numbered', () => {
  const keys = K.defs.payments.columns().map(c => c.key);
  return (J(keys) === J(['ref', 'paid_at', 'client_names', 'transactions', 'declaration_nos', 'bl_numbers', 'service', 'movement_type', 'funding_source', 'method', 'beneficiary_name',
    'sadad_number', 'bank_reference', 'receipt_no', 'expected_amount', 'paid_amount', 'difference', 'currency', 'review_status', 'status', 'created_by_name']) && K.defs.payments.seq === true) || keys;
});
check('dash_tx_counts stages = the 5 Fasah stages of the contract', () => /var DECL_STAGES = \['accepted', 'cco_review_done', 'awaiting_duty_payment', 'release_ready', 'released'\];/.test(SRC.dash) || 'stages');

/* ================================================================ pure: column filter */
section('pure: MarsaColFilter (keys, values, date tree, Riyadh day)');
eq('dayOf: a timestamp → its Asia/Riyadh day; a date-only value is never shifted', [CF.dayOf('2026-11-10T22:30:00Z'), CF.dayOf('2026-11-10T20:59:00Z'), CF.dayOf('2026-11-10'), CF.dayOf(''), CF.dayOf('x')],
  ['2026-11-11', '2026-11-10', '2026-11-10', '', '']);
const cols0 = [{ key: 'port', label: 'الميناء', type: 'text', value: r => r.port }, { key: 'n', label: 'عدد', type: 'int', value: r => r.n }, { key: 'at', label: 'وقت', type: 'datetime', value: r => r.at }];
const rows0 = [{ port: 'جدة', n: 2, at: '2026-11-10T22:30:00Z' }, { port: 'الدمام', n: 10, at: '2026-11-11T05:00:00Z' }, { port: 'جدة', n: 1, at: '2025-01-02T10:00:00Z' }, { port: '', n: null, at: null }];
check('valuesOf: distinct values with counts; numbers sorted numerically; empty last', () => {
  const v = CF.valuesOf(cols0[0], rows0), n = CF.valuesOf(cols0[1], rows0);
  return (J(v.map(x => [x.key === CF.EMPTY ? 'EMPTY' : x.key, x.n])) === J([['الدمام', 1], ['جدة', 2], ['EMPTY', 1]]) && J(n.map(x => x.key)) === J(['1', '2', '10', CF.EMPTY])) || J([v, n]);
});
check('dateTree: year → month → day, newest first, counts summed', () => {
  const t = CF.dateTree(CF.valuesOf(cols0[2], rows0));
  return (t.length === 2 && t[0].y === '2026' && t[0].n === 2 && t[0].months[0].m === '2026-11' && t[0].months[0].days.length === 1 && t[0].months[0].days[0].d === '2026-11-11' && t[1].y === '2025') || J(t);
});
check('apply: a column filter keeps only the selected keys; state / setState round trip; clearAll', () => {
  const cf = CF.create({ columns: cols0 });
  cf.setRows(rows0);
  cf.setState({ port: ['جدة'] });
  const a = cf.apply(rows0).length, st = J(cf.state());
  cf.setState({ port: ['جدة'], at: ['2026-11-11'] });
  const b = cf.apply(rows0).length;
  cf.clearAll();
  return (a === 2 && st === J({ port: ['جدة'] }) && b === 1 && cf.active() === 0 && cf.apply(rows0).length === 4) || J([a, st, b]);
});
check('regression: cell values «__proto__» / «constructor» are ordinary values (no prototype pollution, nothing dropped) in valuesOf, setState/apply and the Fasah uniq', () => {
  const c1 = [{ key: 'v', label: 'V', type: 'text', value: r => r.v }], rs = [{ v: '__proto__' }, { v: '__proto__' }, { v: 'constructor' }, { v: 'a' }];
  const vals = CF.valuesOf(c1[0], rs), polluted = ({}).n !== undefined || Object.prototype.n !== undefined;
  const cf = CF.create({ columns: c1 }); cf.setRows(rs); cf.setState({ v: ['__proto__'] });
  const kept = cf.apply(rs).length;
  const u = FR.request([{ declarationNo: '__proto__', port: 'SAJED', month: '2026-11' }, { declarationNo: 'constructor' }, { declarationNo: '__proto__' }]).nos;
  return (!polluted && vals.length === 3 && vals.filter(x => x.key === '__proto__')[0].n === 2 && kept === 2 && J(u) === J(['__proto__', 'constructor'])) || J({ polluted, vals, kept, u });
});
check('describe: label + selected values (empty shown as «(فارغ)»)', () => {
  const cf = CF.create({ columns: cols0 }); cf.setRows(rows0); cf.setState({ port: ['جدة', CF.EMPTY] });
  const d = cf.describe();
  return (d.length === 1 && d[0][0] === 'الميناء' && /جدة/.test(d[0][1]) && /\(فارغ\)/.test(d[0][1])) || J(d);
});

/* ================================================================ pure: Fasah reconciliation */
section('pure: Fasah reconciliation (legacy fasahR116*)');
eq('cleanDigits: digits only, Arabic-Indic digits, leading zeros dropped, «0» stays', [FR.cleanDigits('٠٠١٢٣'), FR.cleanDigits('DEC-000456'), FR.cleanDigits('000'), FR.cleanDigits('—')], ['123', '456', '0', '']);
eq('normDate: dd/mm/yyyy, yyyy-mm-dd (with time), an Excel serial; nothing else', [FR.normDate('5/11/2026'), FR.normDate('2026-11-05 10:00'), FR.normDate('46331'), FR.normDate('غدًا')],
  ['2026-11-05', '2026-11-05', '2026-11-05', '']);
eq('mapPort: every customs_ports code from the Fasah names (and a code typed as is)', [
  FR.mapPort('جمرك ميناء جدة الإسلامي'), FR.mapPort('ميناء الملك عبدالعزيز بالدمام - بحري'), FR.mapPort('ميناء الملك عبدالله برابغ'), FR.mapPort('جمرك الرياض - الميناء الجاف ميناء الرياض الجاف'),
  FR.mapPort('جمرك مطار الملك عبدالعزيز الدولي بجدة'), FR.mapPort('مطار الملك فهد الدولي'), FR.mapPort('جوي - الملك خالد'), FR.mapPort('sajed-air'), FR.mapPort('منفذ البطحاء')],
  ['SAJED', 'SADMM', 'SAKAC', 'SARUH', 'SAJED-AIR', 'SADMM-AIR', 'SARUH-AIR', 'SAJED-AIR', '']);
check('isReleased / namesCompatible (company words ignored, a missing name never blocks)', () =>
  (FR.isReleased('فسح كلي') && !FR.isReleased('فسح جزئي') && FR.namesCompatible('شركة الأفق للتجارة', 'الافق') && FR.namesCompatible('', 'x') && !FR.namesCompatible('مؤسسة النور', 'شركة البحر')) || 'names');
const HDR = ['رقم الوثيقة التسلسلي', 'رقم التصريح', 'تاريخ التصريح', 'ميناء التصريح', 'اسم المستورد', 'معلومات قيد الحركة', 'الحالة', 'رسوم البيان الإجمالية', 'رقم السداد'];
const SHEET = [['تقرير البيانات الشهري'], [], HDR,
  ['1', '0001001', '05/11/2026', 'جمرك ميناء جدة الإسلامي', 'شركة الأفق للتجارة', 'M1', 'فسح كلي', '1,250.50', 'P1'],
  ['2', '1002', '06/11/2026', 'جمرك ميناء جدة الإسلامي', 'مؤسسة النور', 'M2', 'تحت المعاينة', '300', 'P2'],
  ['2', '1002', '06/11/2026', 'جمرك ميناء جدة الإسلامي', 'مؤسسة النور', 'M2', 'تحت المعاينة', '300', 'P2'],
  ['3', '1003', '07/11/2026', 'ميناء الملك عبدالعزيز بالدمام بحري', 'شركة البحر', '', 'فسح كلي', '', ''],
  ['4', '1004', '08/11/2026', 'جمرك ميناء جدة الإسلامي', 'العميل الرابع', '', 'فسح كلي', '', ''],
  ['5', '1005', '09/11/2026', 'منفذ غير معروف', 'العميل الخامس', '', 'مقبول', '', ''],
  ['6', '1006', '10/11/2026', 'جمرك ميناء جدة الإسلامي', 'العميل السادس', '', 'مقبول', '', ''],
  ['', '', '', '', '', '', '', '', ''], ['ملاحظة', 'نهاية التقرير']];
check('findHeader: the header row is found below title / blank rows (row 3) with the column map', () => {
  const h = FR.findHeader(SHEET);
  return (h && h.rowIndex === 2 && h.columns.declarationNo === 1 && h.columns.port === 3 && h.columns.status === 6 && h.columns.serial === 0 && h.columns.totalFees === 7) || J(h);
});
check('findHeader: missing a required column (status) → null; header only after row 10 → null', () =>
  (FR.findHeader([HDR.slice(0, 6)]) === null && FR.findHeader(Array(10).fill(['x']).concat([HDR])) === null) || 'header');
const P0 = FR.parseRows(SHEET, 'jed.xlsx');
check('parseRows: records with the mapped port, the month, cleaned numbers, money; the trailing note row skipped', () =>
  (P0.records.length === 7 && P0.records[0].declarationNo === '1001' && P0.records[0].port === 'SAJED' && P0.records[0].month === '2026-11' && P0.records[0].totalFees === 1250.5
    && P0.records[0].row === 4 && P0.summary.headerRow === 3 && P0.summary.skipped === 1 && P0.summary.released === 3) || J(P0.summary));
eq('parseRows errors: empty / no header / no records', [FR.parseRows([], 'a').error, FR.parseRows([['x']], 'a').error, FR.parseRows([HDR, ['', '', '']], 'a').error], ['empty', 'no_header', 'no_records']);
const DD = FR.dedupe(P0.records);
check('dedupe: by the document serial (one duplicate dropped)', () => (DD.records.length === 6 && DD.duplicates === 1) || J(DD));
check('request: unique numbers + port/month scopes only (nothing else from the files goes to the server)', () => {
  const r = FR.request(DD.records);
  return (J(r.nos) === J(['1001', '1002', '1003', '1004', '1005', '1006']) && J(r.scopes) === J([{ port_code: 'SADMM', month: '2026-11' }, { port_code: 'SAJED', month: '2026-11' }])
    && Object.keys(r).sort().join() === 'nos,scopes') || J(r);
});
const SYS = [
  { transaction_id: TX1, ref: 'T-1', declaration_id: 'd1', declaration_no: '1001', declaration_no_norm: '1001', declaration_date: '2026-11-05', month: '2026-11', port_code: 'SAJED', client_name: 'الأفق', declaration_status: 'released', in_scope: true },
  { transaction_id: TX2, ref: 'T-2', declaration_id: 'd2', declaration_no: '1002', declaration_date: '2026-11-01', month: '2026-11', port_code: 'SAJED', client_name: 'مؤسسة النور', declaration_status: 'under_inspection', in_scope: true },
  { transaction_id: TX3, ref: 'T-3', declaration_id: 'd3', declaration_no: '1003', declaration_date: '2026-11-07', month: '2026-11', port_code: 'SAJED', client_name: 'شركة البحر', declaration_status: 'released', in_scope: true },
  { transaction_id: 'x4', ref: 'T-4', declaration_id: 'd4', declaration_no: '1004', declaration_date: '2026-11-08', month: '2026-11', port_code: 'SAJED', client_name: 'العميل الرابع', declaration_status: 'release_ready', in_scope: true },
  { transaction_id: 'x6a', ref: 'T-6a', declaration_id: 'd6a', declaration_no: '1006', declaration_date: '2026-11-01', month: '2026-11', port_code: 'SAJED', client_name: 'العميل السادس', declaration_status: 'accepted', in_scope: true },
  { transaction_id: 'x6b', ref: 'T-6b', declaration_id: 'd6b', declaration_no: '1006', declaration_date: '2026-11-02', month: '2026-11', port_code: 'SAJED', client_name: 'العميل السادس', declaration_status: 'accepted', in_scope: true },
  { transaction_id: 'x7', ref: 'T-7', declaration_id: 'd7', declaration_no: '1007', declaration_date: '2026-11-03', month: '2026-11', port_code: 'SAJED', client_name: 'سبعة', declaration_status: 'released', in_scope: true },
  { transaction_id: 'x8', ref: 'T-8', declaration_id: 'd8', declaration_no: '1008', declaration_date: '2026-11-03', month: '2026-11', port_code: 'SAJED', client_name: 'ثمانية', declaration_status: 'released', in_scope: true, cancelled: true }
];
const CMP = FR.compare(DD.records, SYS);
const stOf = no => (CMP.records.filter(r => r.declarationNo === no)[0] || {}).status;
eq('compare: matched / matched_with_note (date) / port_mismatch / status_mismatch (Fasah released, system not) / port_mismatch (unknown port) / ambiguous',
  ['1001', '1002', '1003', '1004', '1005', '1006'].map(stOf), ['matched', 'matched_with_note', 'port_mismatch', 'status_mismatch', 'missing', 'ambiguous']);
check('compare: notes as codes (date, released, port), the matched system record, the ambiguous candidates', () => {
  const r2 = CMP.records.filter(r => r.declarationNo === '1002')[0], r4 = CMP.records.filter(r => r.declarationNo === '1004')[0], r6 = CMP.records.filter(r => r.declarationNo === '1006')[0];
  const r3 = CMP.records.filter(r => r.declarationNo === '1003')[0];
  return (J(r2.notes) === J(['date']) && r2.system.ref === 'T-2' && J(r4.notes) === J(['released']) && r6.others.length === 2 && J(r3.notes) === J(['port'])) || J([r2.notes, r4.notes, r6.others, r3.notes]);
});
check('compare: system only = in scope, not matched, not cancelled (T-3 kept: its number came on another port; T-8 cancelled left out)', () => {
  const refs = CMP.systemOnly.map(x => x.ref).sort();
  return J(refs) === J(['T-3', 'T-6a', 'T-6b', 'T-7']) || J(refs);
});
check('compare: summary (found = matched + with note + status mismatch), released counts, unknown port rows, per port / month slots', () => {
  const s = CMP.summary, jed = CMP.ports.filter(p => p.port === 'SAJED')[0], unk = CMP.ports.filter(p => !p.port)[0];
  return (s.fasahTotal === 6 && s.found === 3 && s.missing === 1 && s.systemOnly === 4 && s.released === 3 && s.releasedNotInSystem === 1 && s.unknownPort === 1 && s.ambiguous === 1 && s.portMismatch === 1
    && s.byStatus.system_only === 4 && jed.fasahTotal === 4 && jed.systemScope === 7 && jed.systemOnly === 4 && unk && /منفذ غير معروف/.test(unk.rawPort)) || J([s, jed, unk]);
});
check('compare: an ambiguous number resolved by the declaration date', () => {
  const r = FR.compare([{ declarationNo: '1006', port: 'SAJED', month: '2026-11', declarationDate: '2026-11-02', importer: 'العميل السادس', fasahStatus: 'مقبول' }], SYS);
  return (r.records[0].status === 'matched' && r.records[0].system.ref === 'T-6b') || J(r.records[0]);
});
check('limits: 20 files, 10 MB each, 50 000 rows a file, 20 000 records, 100 scopes, header within 10 rows, 64 MB inflated, 256 columns', () =>
  J(FR.LIMITS) === J({ files: 20, fileBytes: 10485760, rowsPerFile: 50000, records: 20000, scopes: 100, headerScan: 10, inflateBytes: 67108864, cols: 256 }) || J(FR.LIMITS));

/* ================================================================ pure: audit diff, rules, register state */
section('pure: audit diff (من X إلى Y), follow-up rules, register filters');
AD.use(mkApi(base, {}, ['admin']));
const AITEM = { id: 7, at: '2026-11-10T21:30:00Z', table_name: 'transactions', action: 'UPDATE', actor_name: 'سارة', label: 'tx.status',
  event: { type: 'operational_status', from_status: 'new', to_status: 'in_progress', note: 'بدأ العمل' },
  changes: [{ field: 'operational_status', from: 'new', to: 'in_progress' }, { field: 'eta', from: '2026-11-01', to: '2026-11-05' }, { field: 'notes', from: null, to: 'ملاحظة' },
    { field: 'status_changed_at', from: '2026-11-10T08:00:00Z', to: '2026-11-10T21:30:00Z' }, { field: 'vessel', from: 'A', to: 'A' }, { field: 'cancel_reason', from: 'x', to: null }],
  transaction_id: TX1, transaction_ref: 'T-1' };
check('lines: labels from the dictionary, codes → labels, timestamps → Riyadh, dates kept, add / remove kinds, unchanged values dropped', () => {
  const l = AD.lines(AITEM);
  const by = f => l.filter(x => x.field === f)[0];
  return (l.length === 5 && by('eta').from === '2026-11-01' && by('eta').label === 'تاريخ الوصول المتوقع' && by('notes').kind === 'add' && by('cancel_reason').kind === 'remove'
    && by('status_changed_at').to === '2026-11-11 00:30' && !by('vessel')) || J(l);
});
check('sentence: «الحقل: من «X» إلى «Y»» / أُضيف / حُذف', () =>
  (AD.sentence({ kind: 'change', label: 'الباخرة', from: 'A', to: 'B' }) === 'الباخرة: من «A» إلى «B»' && AD.sentence({ kind: 'add', label: 'الملاحظات', to: 'x' }) === 'الملاحظات: أُضيف «x»'
    && AD.sentence({ kind: 'remove', label: 'السبب', from: 'y' }) === 'السبب: حُذف «y»') || 'sentence');
check('labelOf / eventText: audit_label, the event name and its status «من … إلى …» and note', () =>
  (AD.labelOf(AITEM) === 'تغيير حالة المعاملة' && AD.labelOf({ action: 'DELETE' }) === 'حذف سجل' && /^تغيير الحالة التشغيلية — من «.+» إلى «.+» — «بدأ العمل»$/.test(AD.eventText(AITEM.event))) || AD.eventText(AITEM.event));
check('regression: billing rows read in Arabic (status / origin / Daftra no.) and row ids are never listed or shown raw', () => {
  const l = AD.lines({ table_name: 'billing_intents', changes: [{ field: 'transaction_id', from: null, to: '1a000000-0000-4000-8000-000000000101' },
    { field: 'status', from: 'open', to: 'draft' }, { field: 'origin', from: null, to: 'opening' }, { field: 'external_invoice_id', from: null, to: '8101' },
    { field: 'client_id', from: '1a000000-0000-4000-8000-000000000001', to: '1a000000-0000-4000-8000-000000000002' }] });
  const s = l.map(AD.sentence).join(' | ');
  return (l.length === 4 && !/[0-9a-f]{8}-[0-9a-f]{4}/.test(s) && /حالة الفاتورة: من «قيد الإعداد» إلى «مسودة في دفترة»/.test(s) && /افتتاحية/.test(s) && /رقم فاتورة دفترة/.test(s) && /العميل: تغيّر/.test(s)) || s;
});
check('value: a boolean → نعم / لا, an object → short JSON', () => (AD.value('x', 'is_active', true) === 'نعم' && AD.value('x', 'meta', { a: 1 }) === '{"a":1}') || 'value');
check('regression: the #changes table filter uses the real audited table names (port_appointments / transport_trips), every one known to audit_label_of; their field labels resolve', () => {
  const m = /var TABLES = \[([^\]]*)\]/.exec(SRC.audit), tables = m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]) : [];
  const fn = MIG.slice(MIG.indexOf('FUNCTION app.audit_label_of'), MIG.indexOf('$$;', MIG.indexOf('FUNCTION app.audit_label_of')));
  const bad = tables.filter(tb => fn.indexOf("WHEN '" + tb + "'") === -1);
  return (!bad.length && tables.indexOf('port_appointments') !== -1 && tables.indexOf('transport_trips') !== -1 && tables.indexOf('appointments') === -1
    && AD.fieldLabel('port_appointments', 'status') === 'حالة الموعد' && AD.fieldLabel('transport_trips', 'status') !== 'status'
    && /'port_appointments\.status': 'appt_status', 'transport_trips\.status': 'trip_status'/.test(SRC.audit)) || J({ bad, tables });
});
const RP = O.views.attention_rules._pure;
const DEFS8 = { new: { warning_hours: 24, critical_hours: 48 }, in_progress: { warning_hours: 48, critical_hours: 96 }, customs_declaration: { warning_hours: 48, critical_hours: 96 },
  appointment: { warning_hours: 48, critical_hours: 96 }, transport: { warning_hours: 24, critical_hours: 48 }, empty_return: { warning_hours: 48, critical_hours: 96 },
  operationally_complete: { warning_hours: 24, critical_hours: 48 }, under_billing: { warning_hours: 48, critical_hours: 96 }, appointment_not_updated: { warning_hours: 6, critical_hours: 12 } };
check('rules: the 9 rule keys of set_status_aging_rules; rows equal to the default are not stored; warning ≥ critical or 0 / > 2160 / text → the row', () => {
  const vals = JSON.parse(J(DEFS8)); vals.new.warning_hours = '30';
  const a = RP.overridesFrom(vals, DEFS8);
  const b = RP.overridesFrom(Object.assign({}, DEFS8, { transport: { warning_hours: 48, critical_hours: 48 } }), DEFS8);
  const c = RP.overridesFrom(Object.assign({}, DEFS8, { appointment: { warning_hours: '0', critical_hours: 5 } }), DEFS8);
  const d = RP.overridesFrom(Object.assign({}, DEFS8, { under_billing: { warning_hours: 'x', critical_hours: 5000 } }), DEFS8);
  return (J(RP.KEYS) === J(Object.keys(DEFS8)) && J(a.rules) === J({ new: { warning_hours: 30, critical_hours: 48 } }) && b.error === 'transport' && c.error === 'appointment' && d.error === 'under_billing'
    && J(RP.overridesFrom(DEFS8, DEFS8).rules) === '{}' && J(RP.overridesFrom(Object.assign({}, DEFS8, { empty_return: { off: true, warning_hours: '', critical_hours: '' } }), DEFS8).rules) === J({ empty_return: null })) || J([a, b, c, d]);
});
const RG = O.views.register._pure;
check('register: hash aliases (status / stage / daftra / branchId), codes split on commas, junk dropped, nothing known → null', () => {
  const s = RG.fromQuery(K, { status: 'transport,appointment', stage: 'released', daftra: 'draft', branchId: BR, attention: 'any', containers_min: '2', evil: 'x', port_code: 'sajed-air' });
  return (J(s.operational_status) === J(['transport', 'appointment']) && J(s.declaration_status) === J(['released']) && s.daftra_state === 'draft' && s.branch_id === BR && s.attention === 'any'
    && s.containers_min === '2' && s.port_code === 'SAJED-AIR' && !('evil' in s) && RG.fromQuery(K, { evil: 'x' }) === null && RG.fromQuery(K, { branchId: 'not-a-uuid' }) === null) || J(s);
});
check('register: toFilters drops the Daftra filter for non-finance readers, the default sort, a date field without dates; counts are numbers', () => {
  const s = { daftra_state: 'draft', sort: 'created_desc', date_field: 'updated', containers_min: '3', q: '  MSCU ', operational_status: ['new'] };
  const a = RG.toFilters(s, false), b = RG.toFilters(s, true);
  return (J(a) === J({ q: 'MSCU', operational_status: 'new', containers_min: 3 }) && b.daftra_state === 'draft' && !('sort' in b) && !('date_field' in b)) || J([a, b]);
});

/* ================================================================ export: row filter, seq, tones, xlsx fills */
section('export: the screen\'s column filters keep the same rows in the file; seq + attention tones; tone fills in the xlsx');
const ROWS = [
  { id: TX1, ref: 'T-1', client_name: 'الأفق', operational_status: 'transport', declaration_status: 'released', declaration_no: '1001', declaration_date: '2026-11-05', bl_number: 'BL1',
    unit_count: 2, container_count: 2, containers: ['MSCU1234567', 'MSCU7654321'],
    port_code: 'SAJED', port_name: 'ميناء جدة الإسلامي', operator_name: 'DPW', agent_name: 'MSC', vessel: 'MSC ANNA', transaction_type: 're_export',
    attention: { level: 'critical', hours: 120.4, reasons: [{ code: 'empty_return_overdue', level: 'critical', container_no: 'MSCU1234567' }] },
    daftra: { state: 'draft', number: null }, employee_name: 'سارة', updated_at: '2026-11-10T21:30:00Z' },
  { id: TX2, ref: 'T-2', client_name: 'النور', operational_status: 'new', declaration_status: 'accepted', declaration_no: '1002', bl_number: 'BL2', unit_count: 1, container_count: 1,
    containers: ['TGHU1111111'], port_code: 'SADMM', port_name: 'ميناء الملك عبدالعزيز بالدمام', attention: { level: 'warning', hours: 30, reasons: [{ code: 'status_stale' }] },
    daftra: { state: 'none' }, updated_at: '2026-11-09T10:00:00Z' },
  { id: TX3, ref: 'T-3', client_name: 'البحر', operational_status: 'closed', declaration_status: null, bl_number: 'BL3', unit_count: 1, cargo_unit_type: 'roro', chassis_no: 'JTDBR32E720012345', vehicle_plate_no: 'ABC 123', containers: [], port_code: 'SAJED',
    port_name: 'ميناء جدة الإسلامي', attention: null, daftra: { state: 'issued', number: 'INV-9' }, updated_at: '2026-11-01T10:00:00Z' }
];
const TOTALS = { count: 3, containers: 3, units: 4, attention: { critical: 1, warning: 1, total: 2 }, by_status: { transport: 1, new: 1, closed: 1 } };
function rtApi(calls, rows) {
  rows = rows || ROWS;
  return {
    reportTransactions: f => { calls.push(['rt', f]); return ok({ items: rows, total: rows.length, totals: TOTALS, fingerprint: 'fp' }); },
    txAttention: f => { calls.push(['att', f]); return ok({ items: [], total: 2, truncated: false, totals: { critical: 1, warning: 1, by_reason: { status_stale: 1, empty_return_overdue: 1 } } }); },
    listClients: () => ok([]), listMemberships: () => ok([{ user_id: U1, role: 'admin', profiles: { full_name: 'أحمد' } }, { user_id: 'c', role: 'client' }]),
    logReportExport: p => { calls.push(['log', p]); return ok({ id: 'l1' }); }, isOnline: () => true
  };
}
(async function main() {
  await acheck('run(tx_followup) with a row filter: audited row_count = the kept rows, «م» numbered after the filter, the status tone, a count totals row; the file is built', async () => {
    const calls = [], A = rtApi(calls), api = mkApi(base, A, ['admin']);
    K.use(api);
    const r = await base.w.MarsaExport.run({ api, def: K.defs.tx_followup, format: 'xlsx', filters: { attention: 'any' }, ctx: { finRead: true }, rowFilter: list => list.filter(x => x.port_code === 'SAJED') });
    const log = calls.filter(c => c[0] === 'log')[0];
    return (r.ok && r.rows === 2 && log && log[1].report === 'tx_followup' && log[1].row_count === 2 && J(log[1].filters) === J({ attention: 'any' })
      && r.data[0].seq === 1 && r.data[1].seq === 2 && r.data[0].status__tone === 'danger' && !r.data[1].status__tone && /إعادة تصدير/.test(r.data[0].status) && /متأخرة · 120 س/.test(r.data[0].status)
      && r.data[0].daftra === 'مسودة دفترة' && r.data[1].daftra === 'فاتورة صادرة · INV-9' && r.data[0].unit === 'MSCU1234567\nMSCU7654321' && r.data[1].unit === 'Ro-Ro\nشاسيه: JTDBR32E720012345\nلوحة: ABC 123' && r.totals.length === 1 && /2/.test(r.totals[0].ref)
      && r.columns.length === 14 && base.downloads.length >= 1) || J({ r: r.ok ? Object.assign({}, r, { blob: null }) : r, log });
  });
  await acheck('regression: the payments file keeps «م», the B/L and the SADAD no. + bank reference + receipt side by side (none dropped)', async () => {
    const calls = [], P = [{ id: TX1, ref: 'P-1', paid_at: '2026-11-10', sadad_number: '9001', bank_reference: 'BR-7', receipt_no: 'RC-3', bl_numbers: ['BL1', 'BL9'], currency: 'SAR', paid_amount: 10 }];
    const api = mkApi(base, { reportPayments: f => ok({ items: P, total: 1, totals: { count: 1, paid: { SAR: 10 } } }), logReportExport: p => { calls.push(p); return ok({ id: 'l' }); }, isOnline: () => true }, ['admin']);
    K.use(api);
    const r = await base.w.MarsaExport.run({ api, def: K.defs.payments, format: 'xlsx', filters: {}, ctx: {} });
    const d = r.ok && r.data[0];
    return (r.ok && r.columns[0].key === 'seq' && d.seq === 1 && d.sadad_number === '9001' && d.bank_reference === 'BR-7' && d.receipt_no === 'RC-3' && d.bl_numbers === 'BL1، BL9' && calls[0].row_count === 1)
      || J(r.ok ? { cols: r.columns.map(c => c.key), d } : r);
  });
  check('regression: unitText reads the server shape (container-number strings) — numbers one per line; Ro-Ro + chassis + plate; objects still accepted', () => {
    const k = base.w.MarsaExport.kit();
    const a = k.unitText({ cargo_unit_type: 'container', containers: ['MSCU1234567', 'MSCU7654321'], unit_count: 2 });
    const b = k.unitText({ cargo_unit_type: 'roro', chassis_no: 'JTDBR32E720012345', vehicle_plate_no: 'ABC 123', containers: [] });
    const c = k.unitText({ cargo_unit_type: 'container', containers: [{ container_no: 'X1' }] }), d = k.unitText({ cargo_unit_type: 'container', containers: [] });
    return (a === 'MSCU1234567\nMSCU7654321' && b === 'Ro-Ro\nشاسيه: JTDBR32E720012345\nلوحة: ABC 123' && c === 'X1' && d !== '' && !/MSCU/.test(d)) || J([a, b, c, d]);
  });
  check('xlsx: a multi-line text cell gets a wrap style (15, or 16/17 with a tone)', () => {
    const X = base.w.MarsaXlsx;
    const s = Buffer.from(X.build({ title: 't', sheets: [{ name: 's', columns: [{ key: 'a', label: 'A', type: 'text' }], rows: [{ a: 'x\ny' }, { a: 'p\nq', a__tone: 'danger' }, { a: 'z' }] }] })).toString('utf8');
    return (/<c r="A2" s="15" t="inlineStr">/.test(s) && /<c r="A3" s="17" t="inlineStr">/.test(s) && /<c r="A4" t="inlineStr">/.test(s) && /<cellXfs count="18">/.test(s)) || s.slice(s.indexOf('<sheetData>'), s.indexOf('<sheetData>') + 400);
  });
  check('xlsx: a tone becomes a fill style (13 warning / 14 danger) on text cells only; 18 cellXfs, 5 fills', () => {
    const X = base.w.MarsaXlsx;
    const bytes = X.build({ title: 't', sheets: [{ name: 's', columns: [{ key: 'a', label: 'A', type: 'text' }, { key: 'b', label: 'B', type: 'int' }], rows: [{ a: 'x', a__tone: 'danger', b: 1, b__tone: 'danger' }, { a: 'y', a__tone: 'warning' }, { a: 'z' }] }] });
    const s = Buffer.from(bytes).toString('utf8');
    return (/<c r="A2" s="14" t="inlineStr">/.test(s) && /<c r="A3" s="13" t="inlineStr">/.test(s) && /<c r="A4" t="inlineStr">/.test(s) && /<c r="B2" s="2"><v>1<\/v>/.test(s)
      && /<cellXfs count="18">/.test(s) && /<fills count="5">/.test(s)) || s.slice(s.indexOf('<sheetData>'), s.indexOf('<sheetData>') + 400);
  });
  check('print: a tone becomes td.is-tone-<tone>', () => {
    const node = base.w.MarsaExport.printReport({ title: 't', columns: [{ key: 'a', label: 'A', type: 'text' }], rows: [{ a: 'x', a__tone: 'warning' }], totals: [] });
    const td = node.querySelector('tbody td');
    base.w.MarsaExport.cleanupPrint();
    return (td && /is-tone-warning/.test(td.className)) || (td && td.className);
  });

  /* ================================================================ DOM: register */
  section('DOM: #register (banner, quick filters, table, tooltip, column filter, follow-up export)');
  {
    const ctx = context(), calls = [];
    const A = rtApi(calls), api = mkApi(ctx, A, ['accountant']);
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    ctx.w.MarsaOps.views.register._reset();
    await ctx.w.MarsaOps.views.register.render(root, api); await settle(20);
    const rt = calls.filter(c => c[0] === 'rt'), att = calls.filter(c => c[0] === 'att');
    check('first load: reportTransactions (limit 200, offset 0) and txAttention with the SAME filters (no limit)', () =>
      (rt.length === 1 && rt[0][1].limit === 200 && rt[0][1].offset === 0 && att.length === 1 && !('limit' in att[0][1]) && J(Object.assign({}, rt[0][1], { limit: undefined, offset: undefined })) === J(Object.assign({}, att[0][1], { limit: undefined, offset: undefined }))) || J(calls));
    check('banner: «1 معاملة متأخرة و1 تحتاج متابعة» with the reasons, a danger tone and the «المتأخرة فقط» toggle', () => {
      const b = root.querySelector('.lrpt-banner');
      return (b && /alert-danger/.test(b.className) && /1 معاملة متأخرة و1 تحتاج متابعة/.test(b.textContent) && /تجاوز آخر موعد لإعادة الفارغ: 1/.test(b.textContent) && !!b.querySelector('.lrpt-late-toggle')) || textOf(b);
    });
    check('quick filters: all, late, critical, Daftra drafts (finance reader), re-export, Ro-Ro; «الكل» pressed', () => {
      const q = root.querySelectorAll('[data-quick]').map(b => b.getAttribute('data-quick'));
      return (J(q) === J(['all', 'late', 'critical', 'daftra_draft', 're_export', 'roro']) && root.querySelector('[data-quick="all"]').getAttribute('aria-pressed') === 'true') || J(q);
    });
    const trs = () => root.querySelectorAll('.lrpt-table-card tbody tr');
    check('table: 3 rows, stage row tones + the attention stripe class, the Daftra column for a finance reader, a totals row', () => {
      const r = trs(), h = root.querySelectorAll('.lrpt-table-card thead th').map(th => th.textContent);
      return (r.length === 3 && /lrpt-stage-released/.test(r[0].className) && /lrpt-row-critical/.test(r[0].className) && /lrpt-row-warning/.test(r[1].className)
        && h.some(x => /فاتورة دفترة/.test(x)) && !!root.querySelector('.lrpt-table-card tfoot .rpt-total-row') && /متأخرة 1 · متابعة 1/.test(root.querySelector('tfoot').textContent)) || J(h);
    });
    check('regression: the totals row under «عدد الوحدات» is totals.units (Ro-Ro = 1), not the container count', () => {
      const td = root.querySelector('.lrpt-table-card tfoot [data-key="unit_count"]');
      return (td && td.getAttribute('data-value') === '4') || (td && td.getAttribute('data-value'));
    });
    check('cells: the container tooltip lists the numbers (focusable), the attention badge with hours, the Daftra pill, «بلا بيان» for no declaration', () => {
      const ctr = root.querySelector('.lrpt-ctr'), r = trs();
      return (ctr && /MSCU1234567، MSCU7654321/.test(ctr.getAttribute('title')) && ctr.getAttribute('tabindex') === '0' && /متأخرة · 120 س/.test(r[0].textContent)
        && /مسودة دفترة/.test(r[0].textContent) && /بلا بيان/.test(r[2].textContent) && /Ro-Ro/.test(r[2].textContent)) || (ctr && ctr.getAttribute('title'));
    });
    check('every column has an accessible filter button (aria-haspopup dialog, aria-expanded, a label naming the column)', () => {
      const b = root.querySelectorAll('.cf-btn');
      return (b.length >= 15 && b.every(x => x.getAttribute('aria-haspopup') === 'dialog' && x.getAttribute('aria-expanded') === 'false' && /تصفية العمود «/.test(x.getAttribute('aria-label')))) || b.length;
    });
    // open the port column filter, keep جدة only
    const portBtn = root.querySelector('[data-cf-key="port"]');
    portBtn.click(); await settle(5);
    const pop = ctx.document.body.querySelector('.cf-pop');
    check('the popover: a labelled dialog with a search box, «تحديد الكل», one checkbox per value with counts; the button says expanded', () =>
      (pop && pop.getAttribute('role') === 'dialog' && !!pop.getAttribute('aria-labelledby') && !!pop.querySelector('.cf-search') && /تحديد الكل/.test(pop.textContent)
        && pop.querySelectorAll('.cf-box').length === 2 && /ميناء جدة الإسلامي/.test(pop.textContent) && portBtn.getAttribute('aria-expanded') === 'true') || textOf(pop));
    const P = portBtn && ctx.w.MarsaOps && null;
    // the open popover's hooks (the column filter instance is internal; the page keeps one open popover)
    const cfPop = (function () { let found = null; ctx.document.body.walk(n => { if (!found && n.getAttribute && n.getAttribute('data-cf-pop') === 'port') found = n; }); return found; })();
    check('the search narrows the list (Arabic-normalised)', () => {
      const s = cfPop.querySelector('.cf-search'); s.value = 'جده'; s.dispatch('input');
      return true;
    });
    await settle(150);
    check('… only جدة stays listed', () => (cfPop.querySelectorAll('.cf-box').length === 1 && /جدة/.test(cfPop.querySelector('.cf-list').textContent)) || cfPop.querySelector('.cf-list').textContent);
    // apply via Enter in the search box: keeps the visible checked values = جدة
    cfPop.querySelector('.cf-search').dispatch('keydown', { key: 'Enter' }); await settle(5);
    check('Enter applies: the popover closes, 2 rows stay, the button is pressed, the count says «معروض 2 من 3», «مسح تصفية الأعمدة» shows', () =>
      (!ctx.document.body.querySelector('.cf-pop') && trs().length === 2 && root.querySelector('[data-cf-key="port"]').getAttribute('aria-pressed') === 'true'
        && /معروض 2 من 3/.test(root.querySelector('.rpt-count').textContent) && root.querySelector('.rpt-cf-clear').hidden === false) || [trs().length, root.querySelector('.rpt-count').textContent]);
    const bar = root.querySelector('.rpt-export-bar');
    const r = await bar.__run('xlsx');
    const log = calls.filter(c => c[0] === 'log').pop();
    check('follow-up export: logged as tx_followup with the server filters, row_count = the 2 visible rows; the criteria name the column filter', () =>
      (r.ok && log[1].report === 'tx_followup' && log[1].format === 'xlsx' && log[1].row_count === 2 && J(log[1].filters) === J({}) && r.rows === 2) || J([log, r.ok, r.error]));
    // regression: Tab / Shift+Tab stay inside the popover; focus reaching the page closes it
    root.querySelector('[data-cf-key="vessel"]').click(); await settle(5);
    {
      const pop = ctx.document.body.querySelector('.cf-pop'), all = [];
      pop.walk(n => { if (n !== pop && ['INPUT', 'BUTTON'].indexOf(n.tagName) !== -1 && !n.disabled && !n.hidden) all.push(n); });
      all.forEach(n => { n.focus = () => { ctx.document.activeElement = n; }; });
      const first = all[0], last = all[all.length - 1];
      ctx.document.activeElement = first; pop.dispatch('keydown', { key: 'Tab', shiftKey: true });
      const a = ctx.document.activeElement === last;
      pop.dispatch('keydown', { key: 'Tab' });
      const b = ctx.document.activeElement === first;
      check('regression: the column-filter dialog keeps keyboard focus inside (Shift+Tab on the first → the last, Tab on the last → the first); a focusin outside closes it', () =>
        (all.length >= 3 && a && b && /document\.addEventListener\('focusin', p\.onFocus, true\)/.test(SRC.colfilter) && /removeEventListener\('focusin', p\.onFocus, true\)/.test(SRC.colfilter)) || J({ n: all.length, a, b }));
      pop.dispatch('keydown', { key: 'Escape' });
    }
    // Escape closes a popover
    root.querySelector('[data-cf-key="vessel"]').click(); await settle(5);
    const p2 = ctx.document.body.querySelector('.cf-pop');
    p2.dispatch('keydown', { key: 'Escape' });
    check('Escape closes the popover and resets aria-expanded', () => (!ctx.document.body.querySelector('.cf-pop') && root.querySelector('[data-cf-key="vessel"]').getAttribute('aria-expanded') === 'false') || 'open');
    // quick filter «المتأخرة فقط»
    calls.length = 0;
    root.querySelector('[data-quick="late"]').click(); await settle(20);
    check('«المتأخرة فقط» reloads with attention=any (list + banner) and puts it in the hash', () => {
      const a = calls.filter(c => c[0] === 'rt')[0];
      return (a && a[1].attention === 'any' && calls.some(c => c[0] === 'att' && c[1].attention === 'any') && /#register\?attention=any/.test(ctx.location.hash)
        && root.querySelector('[data-quick="late"]').getAttribute('aria-pressed') === 'true') || J([calls, ctx.location.hash]);
    });
    check('the column filter survives the reload (same rows): still 2 rows', () => trs().length === 2 || trs().length);
  }
  {
    const ctx = context(), calls = [];
    const api = mkApi(ctx, rtApi(calls), ['clearance_staff'], { hashQuery: () => ({ stage: 'released', status: 'transport', branchId: BR }) });
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    ctx.w.MarsaOps.views.register._reset();
    await ctx.w.MarsaOps.views.register.render(root, api); await settle(20);
    const rt = calls.filter(c => c[0] === 'rt')[0];
    check('a dashboard tile link (?stage=released&status=transport&branchId=…) becomes the filters', () =>
      (rt && rt[1].declaration_status === 'released' && rt[1].operational_status === 'transport' && rt[1].branch_id === BR) || J(rt));
    check('a non-finance reader: no Daftra column, no «مسودات دفترة فقط» chip, no Daftra filter', () =>
      (!root.querySelectorAll('thead th').some(th => /فاتورة دفترة/.test(th.textContent)) && !root.querySelector('[data-quick="daftra_draft"]') && !root.querySelector('[name="daftra_state"]')) || 'daftra visible');
    check('the advanced filters are open when the query set one of them; every field has a label', () => {
      const det = root.querySelector('.lrpt-adv');
      return (det && det.open === true && root.querySelectorAll('.rpt-field').every(g => !!g.querySelector('label'))) || 'adv';
    });
  }

  {
    const ctx = context(), calls = [];
    const CL = '00000000-0000-4000-8000-0000000000c9', EMP = '00000000-0000-4000-8000-0000000000e9', ORG2 = '00000000-0000-4000-8000-0000000000f2';
    const R = ctx.w.MarsaOps.views.register; R._reset();
    const r1 = ctx.document.createElement('div'); ctx.document.body.appendChild(r1);
    await R.render(r1, mkApi(ctx, rtApi(calls), ['admin'], { hashQuery: () => ({ client_id: CL, employee_id: EMP, vessel: 'MSC X' }) })); await settle(20);
    const first = calls.filter(c => c[0] === 'rt').pop();
    calls.length = 0;
    const r2 = ctx.document.createElement('div'); ctx.document.body.appendChild(r2);
    await R.render(r2, mkApi(ctx, rtApi(calls), ['admin'], { orgId: ORG2 })); await settle(20);
    const second = calls.filter(c => c[0] === 'rt').pop();
    check('regression: a client / employee id that this org\'s complete lists do not contain is dropped (never sent); the vessel filter stays', () =>
      (first && !('client_id' in first[1]) && !('employee_id' in first[1]) && first[1].vessel === 'MSC X') || J(first));
    check('regression: after an org switch the register starts clean (no filters of the previous org); the org-switch handler resets register / fasah_recon / changes and strips their hash query', () =>
      (second && !('vessel' in second[1]) && !('client_id' in second[1]) && /var ORG_VIEWS = \['search', 'reports', 'register', 'fasah_recon', 'changes'\];/.test(SRC.exp)
        && typeof ctx.w.MarsaOps.views.changes._reset === 'function') || J(second));
  }

  /* ================================================================ DOM: reports tabs */
  section('DOM: #reports movements / payments / trips groups');
  {
    const ctx = context(), calls = [];
    const MV = [{ id: 'm1', kind: 'appointment', transaction_id: TX1, transaction_ref: 'T-1', client_name: 'الأفق', port_name: 'ميناء جدة الإسلامي', driver_name: 'علي', container_no: 'MSCU1234567',
      appointment_at: '2026-11-10T06:00:00Z', movement_status: 'delivered', return_status: 'pending', overdue: true, days_overdue: 2, cost_amount: 500, cost_currency: 'SAR', sell_amount: 700, sell_currency: 'SAR' },
    { id: 'm2', kind: 'trip', transaction_id: TX2, transaction_ref: 'T-2', client_name: 'النور', movement_status: 'cancelled', cost_amount: null, sell_amount: null }];
    const A = {
      reportMovements: f => { calls.push(['mv', f]); return ok({ items: MV, total: 2, finance: true, totals: { count: 2, appointments: 1, cancelled: 1, delivered_containers: 1, overdue_returns: 1,
        by_movement_status: { delivered: 1, cancelled: 1 }, transport_value: { SAR: 500 }, revenue: { SAR: 700 }, rows_with_finance: 1 } }); },
      reportPayments: f => { calls.push(['pay', f]); return ok({ items: [{ id: TX3, ref: 'PAY-1', paid_at: '2026-11-05', currency: 'SAR', paid_amount: 100, review_status: 'pending', transactions: [{ id: TX1, ref: 'T-1' }] }], total: 1, totals: { count: 1, paid: { SAR: 100 }, by_review_status: { pending: 1 } } }); },
      reportTrips: f => { calls.push(['trips', f]); return ok({ items: [{ id: 't1', transaction_id: TX1, transaction_ref: 'T-1', status: 'planned' }], total: 1,
        totals: { count: 1, by_status: { planned: 1 }, by_carrier: [{ party_type: 'company', party_name: 'ناقل', trips: 1, value_by_currency: {} }], by_driver: [{ driver_id: null, driver_name: null, trips: 1 }] } }); },
      listClients: () => ok([]), listParties: () => ok([]), logReportExport: p => { calls.push(['log', p]); return ok({}); }, isOnline: () => true,
      listMemberships: () => ok([{ user_id: U1, role: 'clearance_staff', profiles: { full_name: 'سارة' } }, { user_id: 'cl1', role: 'client', profiles: { full_name: 'عميل' } }])
    };
    const R = ctx.w.MarsaOps.views.reports;
    async function show(roles, kind) { const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root); R._reset(); await R.render(root, mkApi(ctx, A, roles), kind); await settle(20); return root; }
    const r1 = await show(['clearance_staff'], 'movements');
    const mv1 = calls.filter(c => c[0] === 'mv')[0];
    check('movements (staff): report_movements with the default date field / last 30 days, no amount keys; 17 columns; tabs without payments', () =>
      (mv1 && mv1[1].date_field === 'appointment' && /^\d{4}-\d{2}-\d{2}$/.test(mv1[1].from) && !('value_min' in mv1[1]) && mv1[1].limit === 100
        && r1.querySelectorAll('.rpt-table thead th').length === 17 && !r1.querySelector('[data-tab="payments"]') && !!r1.querySelector('[data-tab="movements"]')) || J([mv1, r1.querySelectorAll('.rpt-table thead th').length]));
    check('movements tiles: movements, appointments, cancelled, delivered containers, overdue returns (no money without trip finance)', () => {
      const t = r1.querySelector('.rpt-tiles').textContent;
      return (/الحركات/.test(t) && /المواعيد/.test(t) && /حاويات سُلّمت/.test(t) && /إعادات متأخرة/.test(t) && !/قيمة النقل/.test(t)) || t;
    });
    check('regression: movements form has the legacy employee filter (staff members only) and the empty-return-status checks', () => {
      const sel = r1.querySelector('select[name="employee_id"]'), opts = sel ? sel.querySelectorAll('option').map(o => o.getAttribute('value')) : [];
      const rs = r1.querySelectorAll('input[name="return_status"]').map(i => i.getAttribute('value'));
      return (sel && J(opts) === J(['', U1]) && rs.indexOf('pending') !== -1 && rs.indexOf('returned_verified') !== -1) || J({ opts, rs });
    });
    check('movements cells: the container with its transaction link, the return status with «متأخرة» days, the movement pill', () => {
      const tr0 = r1.querySelector('.rpt-table tbody tr');
      return (tr0.querySelectorAll('a').some(a => a.href === '#tx/' + TX1) && /MSCU1234567/.test(tr0.textContent) && /2/.test(tr0.querySelector('.lrpt-late').textContent)) || textOf(tr0);
    });
    const r2 = await show(['operations_manager'], 'movements');
    check('movements (trip finance): 19 columns incl. «قيمة النقل» / «عائد المؤسسة», money tiles, the value / revenue range fields', () => {
      const h = r2.querySelectorAll('.rpt-table thead th').map(x => x.textContent);
      return (h.length === 19 && h.some(x => /قيمة النقل/.test(x)) && h.some(x => /عائد المؤسسة/.test(x)) && /قيمة النقل \(SAR\)/.test(r2.querySelector('.rpt-tiles').textContent)
        && !!r2.querySelector('[name="value_min"]') && !!r2.querySelector('[name="revenue_max"]')) || J(h);
    });
    const res = await r2.querySelector('.rpt-export-bar').__run('csv');
    const lg = calls.filter(c => c[0] === 'log').pop();
    check('movements export: audited as movements, the file has the 19 columns and the per-currency totals row', () =>
      (res.ok && lg[1].report === 'movements' && lg[1].row_count === 2 && /قيمة النقل/.test(res.text) && /500/.test(res.text) && /700/.test(res.text)) || J([res.error, lg]));
    const r3 = await show(['accountant'], 'payments');
    const pay = calls.filter(c => c[0] === 'pay')[0];
    check('payments (finance reader): the tab, report_payments with date_field paid (status recorded = the server default, not sent), tiles count + paid', () =>
      (pay && pay[1].date_field === 'paid' && !('status' in pay[1]) && !!r3.querySelector('[data-tab="payments"]') && /المسدد \(SAR\)/.test(r3.querySelector('.rpt-tiles').textContent)
        && r3.querySelectorAll('.rpt-table tbody tr').length === 1 && r3.querySelector('.rpt-table tbody').querySelectorAll('a').some(a => a.href === '#payments/' + TX3)) || J([pay, textOf(r3.querySelector('.rpt-tiles'))]));
    const r4 = await show(['clearance_staff'], 'trips');
    check('trips: the by-carrier and by-driver summaries (party type label, «بلا سائق»)', () => {
      const g = r4.querySelector('.lrpt-groups');
      return (g && g.querySelectorAll('.lrpt-group-card').length === 2 && /شركة نقل/.test(g.textContent) && /بلا سائق/.test(g.textContent)) || textOf(g);
    });
    check('trips: the driver / party / q filters exist on the form', () => (!!r4.querySelector('[name="driver_q"]') && !!r4.querySelector('[name="party_type"]') && !!r4.querySelector('[name="party_q"]') && !!r4.querySelector('[name="q"]')) || 'fields');
  }

  /* ================================================================ DOM: dashboards */
  section('DOM: dashboard tx-count tiles (dash_tx_counts)');
  {
    const ctx = context();
    const counts = { total: 9, open: 7, cancelled: 1, by_status: { new: 2, transport: 1 }, declaration_stages: { accepted: 1, released: 3 }, no_declaration: 2, drafts: { documents: 2, appointments: 1 },
      appointments_today: 4, transported_containers: 5, attention: { critical: 1, warning: 2, total: 3 }, daftra: { none: 3, draft: 2, issued: 1, cancelled_review: 0 }, today: '2026-11-11' };
    const A = { dashOps: () => ok({}), dashTxCounts: f => ok(counts) };
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    await ctx.w.MarsaDash.render(root, 'ops', mkApi(ctx, A, ['admin'])); await settle(20);
    const hrefs = root.querySelectorAll('a').map(a => a.getAttribute('href'));
    check('status tiles → #transactions?status=X; stage tiles → ?stage=X; attention → ?attention=…; Daftra drafts → ?daftra_state=draft', () =>
      (hrefs.indexOf('#transactions?status=new') !== -1 && hrefs.indexOf('#transactions?status=closed') !== -1 && hrefs.indexOf('#transactions?stage=released') !== -1
        && hrefs.indexOf('#transactions?stage=cco_review_done') !== -1 && hrefs.indexOf('#transactions?attention=critical') !== -1 && hrefs.indexOf('#transactions?daftra_state=draft') !== -1) || J(hrefs));
    check('appointments today / transported → #reports/movements with the Riyadh day / delivered; drafts → ocr.html; «بلا بيان» is a plain tile', () =>
      (hrefs.indexOf('#reports/movements?from=2026-11-11&to=2026-11-11') !== -1 && hrefs.indexOf('#reports/movements?movement_status=delivered') !== -1 && hrefs.indexOf('ocr.html') !== -1
        && root.querySelectorAll('[data-dash-tile="no_decl"]').every(n => n.tagName === 'DIV')) || J(hrefs));
    check('values: «فسح كلي» shows 3, drafts 3 with the split, the summary line', () => {
      const rel = root.querySelector('[data-dash-tile="stage_released"]'), dr = root.querySelector('[data-dash-tile="drafts"]');
      return (rel && /^3/.test(rel.textContent) && /فسح كلي/.test(rel.textContent) && dr && /^3/.test(dr.textContent) && /مستندات 2 · بطاقات مواعيد 1/.test(dr.textContent) && /الإجمالي 9/.test(root.textContent)) || textOf(rel);
    });
    const root2 = ctx.document.createElement('div'); ctx.document.body.appendChild(root2);
    await ctx.w.MarsaDash.render(root2, 'ops', mkApi(ctx, { dashOps: () => ok({}), dashTxCounts: () => ok(Object.assign({}, counts, { daftra: null })) }, ['clearance_staff'])); await settle(20);
    check('no Daftra tile when the server returns daftra null (not a finance reader)', () => !root2.querySelectorAll('a').some(a => /daftra_state/.test(a.getAttribute('href'))) || 'daftra tile');
  }

  /* ================================================================ DOM: Fasah reconciliation */
  section('DOM: #fasah_recon (files read in the browser, scope RPC, results, audited export)');
  {
    const ctx = context(), calls = [];
    const X = ctx.w.XlsxLite;
    const bytes = X.writeBytes([{ name: 'report', rows: SHEET }]);
    const file = { name: 'jeddah-nov.xlsx', size: bytes.length, arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)) };
    const parsed = await ctx.w.MarsaOps.views.fasah_recon._parseFile(file);
    check('a real .xlsx (XlsxLite) is parsed: 7 records, the header found on row 3', () => (parsed.records && parsed.records.length === 7 && parsed.summary.headerRow === 3) || J(parsed));
    const bad = await Promise.all([
      ctx.w.MarsaOps.views.fasah_recon._parseFile({ name: 'a.xls', size: 10 }),
      ctx.w.MarsaOps.views.fasah_recon._parseFile({ name: 'big.xlsx', size: 11 * 1024 * 1024 }),
      ctx.w.MarsaOps.views.fasah_recon._parseFile({ name: 'fake.xlsx', size: 5, arrayBuffer: () => Promise.resolve(new TextEncoder().encode('hello').buffer) })]);
    eq('untrusted files: not .xlsx / over 10 MB / not a zip → refused before parsing', bad.map(b => b.error), ['not_xlsx', 'too_big', 'not_xlsx']);
    await acheck('regression: XlsxLite read limits — inflated bytes over the budget → too_big; a row past maxRows → too_many_rows; a cell past maxCols → too_wide (before the rows are filled)', async () => {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
      const codeOf = p => p.then(() => 'ok', e => e && e.code);
      const a = await codeOf(X.read(ab, { maxInflateBytes: 200 })), b = await codeOf(X.read(ab, { maxRows: 2 })), c = await codeOf(X.read(ab, { maxCols: 2 })), d = await codeOf(X.read(ab));
      const far = X.writeBytes([{ name: 's', rows: [['x']] }]);
      const ok2 = await codeOf(X.read(far.buffer.slice(far.byteOffset, far.byteOffset + far.length), { maxRows: 1, maxCols: 1 }));
      return (a === 'too_big' && b === 'too_many_rows' && c === 'too_wide' && d === 'ok' && ok2 === 'ok') || J([a, b, c, d, ok2]);
    });
    await acheck('regression: #fasah_recon reads with those limits (64 MB inflated, rowsPerFile + header rows, 256 columns) and parses the files one after another', async () => {
      const FRV = ctx.w.MarsaOps.views.fasah_recon, order = [];
      const mk = n => ({ name: n + '.xlsx', size: bytes.length, arrayBuffer: () => { order.push('start:' + n); return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)); } });
      const orig = X.read; let seen = null;
      X.read = (b, lim) => { seen = lim; return orig(b, lim).then(r => { order.push('done'); return r; }); };
      const out = await FRV._parseFiles([mk('a'), mk('b')]);
      X.read = orig;
      return (out.length === 2 && out.every(r => r.records && r.records.length === 7) && J(order) === J(['start:a', 'done', 'start:b', 'done'])
        && seen && seen.maxInflateBytes === 64 * 1024 * 1024 && seen.maxRows === 50011 && seen.maxCols === 256 && /parseFiles\(files\)/.test(SRC.recon)) || J({ order, seen });
    });
    const A = {
      reportFasahScope: (nos, scopes) => { calls.push(['scope', nos, scopes]); return ok({ records: SYS, truncated: false, generated_at: '2026-11-11T08:00:00Z' }); },
      logReportExport: p => { calls.push(['log', p]); return ok({}); }, isOnline: () => true
    };
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    ctx.w.MarsaOps.views.fasah_recon._reset();
    ctx.w.MarsaOps.views.fasah_recon.render(root, mkApi(ctx, A, ['clearance_staff']));
    check('the page says the files stay in the browser; the run button is disabled until a file is chosen', () =>
      (/تُقرأ الملفات داخل المتصفح ولا تُرفع/.test(root.textContent) && root.querySelector('.fr-run').disabled === true && root.querySelector('#fr-files').getAttribute('accept').indexOf('.xlsx') === 0) || 'page');
    const input = root.querySelector('#fr-files');
    input.files = [file, { name: 'notes.pdf', size: 10 }];
    input.dispatch('change');
    check('choosing files: the xlsx is listed, the pdf refused with a message', () =>
      (root.querySelectorAll('.lrpt-file-list li').length === 1 && /notes\.pdf/.test(root.querySelector('.rpt-form-error').textContent) && root.querySelector('.fr-run').disabled === false) || textOf(root.querySelector('.lrpt-file-list')));
    root.querySelector('.fr-run').click(); await settle(60);
    const sc = calls.filter(c => c[0] === 'scope')[0];
    check('the server gets only the numbers and the port / month scopes', () =>
      (sc && J(sc[1]) === J(['1001', '1002', '1003', '1004', '1005', '1006']) && J(sc[2]) === J([{ port_code: 'SADMM', month: '2026-11' }, { port_code: 'SAJED', month: '2026-11' }])) || J(sc));
    check('results: tiles, per port / month and per file tables, the records with status chips, the system-only list', () => {
      const t = root.textContent;
      return (/سجلات فسح/.test(t) && /حسب المنفذ والشهر/.test(t) && /حسب الملف/.test(t) && /jeddah-nov\.xlsx/.test(t) && root.querySelectorAll('[data-status]').length === 6
        && /في النظام وليست في تقارير فسح \(4\)/.test(t) && root.querySelectorAll('.lrpt-recon-records tbody tr').length === 6) || t.slice(0, 300);
    });
    root.querySelector('[data-status="missing"]').click(); await settle(5);
    check('a status chip narrows the records (missing → 1 row) and is pressed', () =>
      (root.querySelectorAll('.lrpt-recon-records tbody tr').length === 1 && root.querySelector('[data-status="missing"]').getAttribute('aria-pressed') === 'true') || root.querySelectorAll('.lrpt-recon-records tbody tr').length);
    const ex = await root.querySelector('.rpt-export-bar').__run('xlsx');
    const lg = calls.filter(c => c[0] === 'log').pop();
    check('export: audited first as fasah_recon {months, port_codes, files, system_only, statuses}; regression: row_count = the shown rows + the «system only» sheet rows of the xlsx; then the file', () =>
      (ex.ok && lg[1].report === 'fasah_recon' && lg[1].format === 'xlsx' && J(lg[1].filters) === J({ months: ['2026-11'], port_codes: ['SADMM', 'SAJED'], files: 1, system_only: 4, statuses: ['missing'] }) && lg[1].row_count === 1 + 4
        && ctx.downloads.length === 1) || J([ex, lg]));
    check('the log keys are exactly the server\'s allowed keys for fasah_recon', () => /WHEN 'fasah_recon' THEN ARRAY\['months','port_codes','files','statuses','system_only'\]/.test(MIG)
      && /k IN \('months','port_codes'\) THEN 100 ELSE 20 END/.test(MIG) && /\.slice\(0, 100\)/.test(SRC.recon) || 'keys');
    const rootS = ctx.document.createElement('div'); ctx.document.body.appendChild(rootS);
    ctx.w.MarsaOps.views.fasah_recon.render(rootS, mkApi(ctx, A, ['clearance_staff']));
    const same = /في النظام وليست في تقارير فسح/.test(rootS.textContent);
    const rootO = ctx.document.createElement('div'); ctx.document.body.appendChild(rootO);
    ctx.w.MarsaOps.views.fasah_recon.render(rootO, mkApi(ctx, A, ['clearance_staff'], { orgId: '00000000-0000-4000-8000-0000000000f2' }));
    check('regression: the last reconciliation is redrawn for the same org only — after an org switch nothing of the other org is shown', () =>
      (same && !/في النظام وليست في تقارير فسح/.test(rootO.textContent) && !/1001/.test(rootO.textContent)) || J({ same, other: textOf(rootO).slice(0, 200) }));
  }

  /* ================================================================ DOM: rules / OTP switch / device */
  section('DOM: #attention_rules (owner edit with a reason, OTP switch, device badge)');
  {
    const ctx = context({ config: { emailOtpLogin: true } }), calls = [];
    const data = { rules: DEFS8, defaults: DEFS8, overrides: {}, email_otp_login: false, can_edit: true };
    const A = {
      getStatusAgingRules: () => ok(data),
      setStatusAgingRules: (r, reason) => { calls.push(['set', r, reason]); return ok(Object.assign({}, data, { overrides: r })); },
      setEmailOtpLogin: (on, reason) => { calls.push(['otp', on, reason]); return ok(Object.assign({}, data, { email_otp_login: on })); }
    };
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    await ctx.w.MarsaOps.views.attention_rules.render(root, mkApi(ctx, A, ['admin'])); await settle(10);
    check('the owner sees an input per rule (9) with labels, the fixed empty-return row, the platform switch ON / org OFF', () =>
      (root.querySelectorAll('.lrpt-hours').length === 18 && root.querySelectorAll('.lrpt-hours').every(i => /—/.test(i.getAttribute('aria-label'))) && /تجاوز آخر موعد لإعادة الفارغ/.test(root.textContent)
        && /مفتاح المنصة/.test(root.textContent) && root.querySelector('.lrpt-otp-card').querySelectorAll('.badge').map(b => b.textContent).join() === 'مفعّل,مطفأ') || textOf(root).slice(0, 200));
    root.querySelector('[name="new.warning_hours"]').value = '30';
    const save = byText(root, /حفظ القواعد/);
    save.click(); await settle(5);
    check('no reason → «اكتب سبب التعديل.» and nothing sent', () => (calls.length === 0 && /اكتب سبب التعديل/.test(root.querySelector('.lrpt-rules-card .rpt-form-error').textContent)) || J(calls));
    ctx.document.getElementById('lrpt-rules-reason').value = 'تعديل SLA';
    save.click(); await settle(10);
    check('with a reason: only the changed row is sent with the reason', () => (calls[0] && J(calls[0][1]) === J({ new: { warning_hours: 30, critical_hours: 48 } }) && calls[0][2] === 'تعديل SLA') || J(calls));
    ctx.document.getElementById('lrpt-otp-reason').value = 'تجربة';
    root.querySelector('[data-act="otp-toggle"]').click(); await settle(10);
    check('the OTP switch: setEmailOtpLogin(true, reason)', () => (calls[1] && calls[1][0] === 'otp' && calls[1][1] === true && calls[1][2] === 'تجربة') || J(calls));
    const root2 = ctx.document.createElement('div'); ctx.document.body.appendChild(root2);
    await ctx.w.MarsaOps.views.attention_rules.render(root2, mkApi(ctx, { getStatusAgingRules: () => ok(Object.assign({}, data, { can_edit: false })) }, ['clearance_staff'])); await settle(10);
    check('a staff member reads the numbers, no inputs, no OTP button, the «owner only» note', () =>
      (!root2.querySelector('.lrpt-hours') && !root2.querySelector('[data-act="otp-toggle"]') && /مالك المؤسسة فقط/.test(root2.textContent) && /48/.test(root2.textContent)) || 'edit');
    const A3 = Object.assign({}, A, { setStatusAgingRules: () => err('MRS_MFA_REQUIRED', 'aal2') });
    const root3 = ctx.document.createElement('div'); ctx.document.body.appendChild(root3);
    await ctx.w.MarsaOps.views.attention_rules.render(root3, mkApi(ctx, A3, ['admin'])); await settle(10);
    root3.querySelector('[name="transport.critical_hours"]').value = '72';
    root3.querySelector('#lrpt-rules-reason').value = 'x';
    byText(root3, /حفظ القواعد/).click(); await settle(10);
    check('MRS_MFA_REQUIRED → the two-step verification message', () => /تحقق بخطوتين/.test(root3.querySelector('.lrpt-rules-card .rpt-form-error').textContent) || root3.querySelector('.lrpt-rules-card .rpt-form-error').textContent);
    const data4 = Object.assign({}, data, { rules: Object.assign({}, DEFS8, { transport: null }), overrides: { transport: null } }), calls4 = [];
    const A4 = Object.assign({}, A, { getStatusAgingRules: () => ok(data4), setStatusAgingRules: (r, reason) => { calls4.push(r); return ok(Object.assign({}, data4, { overrides: r })); } });
    const root4 = ctx.document.createElement('div'); ctx.document.body.appendChild(root4);
    await ctx.w.MarsaOps.views.attention_rules.render(root4, mkApi(ctx, A4, ['admin'])); await settle(10);
    const tr4 = root4.querySelector('[data-rule="transport"]'), box4 = root4.querySelector('[name="transport.off"]');
    const shown = { off: /موقوفة/.test(tr4.textContent), notDefault: !/افتراضية/.test(tr4.querySelector('.lrpt-rule-src').textContent), checked: !!(box4 && box4.checked),
      disabled: !!root4.querySelector('[name="transport.warning_hours"]').disabled };
    root4.querySelector('[name="new.warning_hours"]').value = '30';
    root4.querySelector('#lrpt-rules-reason').value = 'سبب';
    byText(root4, /حفظ القواعد/).click(); await settle(10);
    check('regression: a rule switched off (null override) shows «موقوفة» (not the default hours) and stays off when the owner saves another row', () =>
      (shown.off && shown.notDefault && shown.checked && shown.disabled && calls4[0] && calls4[0].transport === null && 'transport' in calls4[0] && J(calls4[0].new) === J({ warning_hours: 30, critical_hours: 48 })) || J({ shown, calls4 }));
    const root5 = ctx.document.createElement('div'); ctx.document.body.appendChild(root5);
    await ctx.w.MarsaOps.views.attention_rules.render(root5, mkApi(ctx, { getStatusAgingRules: () => ok(Object.assign({}, data4, { can_edit: false })) }, ['clearance_staff'])); await settle(10);
    check('regression: a staff reader sees the switched-off rule as «موقوفة» with no hours', () => {
      const tr = root5.querySelector('[data-rule="transport"]');
      return (/موقوفة/.test(tr.textContent) && !/24/.test(tr.querySelectorAll('td')[1].textContent)) || textOf(tr);
    });
  }

  /* ================================================================ DOM: operations log */
  section('DOM: #changes + the transaction log section');
  {
    const ctx = context(), calls = [];
    const A = { auditTrail: f => { calls.push(f); return ok({ items: [AITEM], next_before_id: f.before_id ? null : 7 }); } };
    const root = ctx.document.createElement('div'); ctx.document.body.appendChild(root);
    await ctx.w.MarsaOps.views.changes.render(root, mkApi(ctx, A, ['admin'])); await settle(10);
    check('#changes: auditTrail (limit 50), the label pill, the Riyadh time, the event «من … إلى …», the field diff list', () =>
      (calls[0] && calls[0].limit === 50 && /تغيير حالة المعاملة/.test(root.textContent) && /2026-11-11 00:30/.test(root.textContent) && /تغيير الحالة التشغيلية — من «/.test(root.textContent)
        && root.querySelectorAll('.lrpt-audit-diff li').length === 5 && !!root.querySelector('.lrpt-diff-add') && root.querySelectorAll('a').some(a => a.href === '#tx/' + TX1)) || textOf(root).slice(0, 300));
    byText(root, /الأقدم/).click(); await settle(10);
    check('«الأقدم» pages with before_id = next_before_id', () => (calls[1] && calls[1].before_id === 7 && root.querySelectorAll('.lrpt-audit-item').length === 2) || J(calls));
    const sec2 = ctx.w.MarsaOps.txSections.filter(s => s.id === 'audit-trail')[0];
    const h1 = ctx.document.createElement('div'), h2 = ctx.document.createElement('div');
    sec2.render(h1, { id: TX1, branch_id: BR }, mkApi(ctx, A, ['clearance_staff']));
    sec2.render(h2, { id: TX1, branch_id: BR }, mkApi(ctx, A, ['supervisor']));
    const visible = !h1.children.length && !!h2.children.length;
    if (visible) { byText(h2, /عرض السجل/).click(); await settle(10); }
    check('the tx section: hidden for a clerk; for a supervisor a button loads auditTrail({transaction_id}) and shows the entries', () =>
      (visible && calls[calls.length - 1].transaction_id === TX1 && h2.querySelectorAll('.lrpt-audit-item').length === 1) || J([visible, calls]));
  }

  /* ================================================================ app-shell progress / tech errors */
  section('app-shell.js: progress overlay with a learned ETA + cancel, response badge (off by default), technical errors, OTP gate');
  {
    const { document, Node } = makeDom();
    document.documentElement = new Node('html'); document.documentElement.hasAttribute = () => false; document.documentElement.getAttribute = () => null;
    document.removeEventListener = () => {};
    const store = makeStorage();
    const w = { MarsaI18n: I18N, document, localStorage: store, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, MarsaApi: undefined };
    w.window = w;
    const c = { window: w, document, localStorage: store, sessionStorage: makeStorage(), location: { hash: '', pathname: '/admin.html', href: 'http://x/admin.html', replace() {} }, history: { replaceState() {} },
      navigator: {}, Intl, Date, Math, String, Object, Array, JSON, Number, RegExp, parseInt, parseFloat, isFinite, isNaN, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
      encodeURIComponent, decodeURIComponent, Error, console, CustomEvent: function (t) { this.type = t; }, Event: function (t) { this.type = t; } };
    let shellErr = null;
    try { vm.createContext(c); vm.runInContext(SRC.dict, c); vm.runInContext(SRC.shell, c, { filename: 'app-shell.js' }); } catch (e) { shellErr = e; }
    const SH = w.MarsaShell;
    check('app-shell loads in a demo page and exposes progress / responseBadge / techText', () =>
      (!shellErr && SH && SH.progress && typeof SH.progress.track === 'function' && typeof SH.responseBadge === 'function' && typeof SH.techText === 'function') || String(shellErr && shellErr.stack));
    if (SH) {
      eq('techText: network / timeout / rate / expired session / 5xx in Arabic; null for a business error (techKnown)', [
        SH.techText(new Error('Failed to fetch')), SH.techText({ message: 'The operation was aborted' }), SH.techText({ status: 429 }), SH.techText({ message: 'JWT expired' }),
        SH.techText({ status: 503 }), SH.techKnown({ code: 'MRS_INVALID', message: 'x' })],
        ['تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.', 'انتهت مهلة الطلب دون رد. أعد المحاولة بعد قليل.', 'طلبات كثيرة خلال وقت قصير. انتظر قليلًا ثم أعد المحاولة.',
          'انتهت الجلسة. سجّل الدخول مرة أخرى.', 'الخادم غير متاح مؤقتًا. أعد المحاولة بعد قليل.', null]);
      await acheck('track: a fast job resolves with its value, no overlay, the duration is learned (localStorage)', async () => {
        const v = await SH.progress.track('op:a', Promise.resolve(42), { delay: 50 });
        const learned = JSON.parse(store.getItem('marsa_op_times') || '{}')['op:a'];
        return (v === 42 && !document.body.querySelector('.app-progress') && learned && learned.n === 1 && SH.progress.eta('op:a') != null) || J([v, learned]);
      });
      await acheck('track: a slow job shows the overlay (progressbar, ETA text, cancel); «إلغاء» rejects with {cancelled} and removes it', async () => {
        SH.progress.record('op:b', 4000);
        let res = null;
        const p = SH.progress.track('op:b', new Promise(() => {}), { delay: 5, label: 'تحميل' }).then(null, e => { res = e; });
        await settle(30);
        const ov = document.body.querySelector('.app-progress');
        const bar = ov && ov.querySelector('[role="progressbar"]');
        const text = ov && ov.textContent;
        const cancel = ov && ov.querySelector('.app-progress-cancel');
        if (cancel) cancel.click();
        await p;
        return (ov && bar && /تحميل/.test(text) && /المدة المتوقعة نحو 4 ث/.test(text) && res && res.cancelled === true && res.code === 'MRS_CANCELLED' && !document.body.querySelector('.app-progress')) || J([text, res]);
      });
      await acheck('track: cancellable false → no cancel button', async () => {
        let done;
        const p = SH.progress.track('op:c', new Promise(r => { done = r; }), { delay: 1, cancellable: false });
        await settle(15);
        const has = !!document.body.querySelector('.app-progress-cancel');
        done(1); await p;
        return !has || 'cancel shown';
      });
      await acheck('response badge: OFF by default; ON (per device) → the last time is shown after a tracked job', async () => {
        const before = SH.responseBadge();
        SH.responseBadge(true);
        await SH.progress.track('op:d', Promise.resolve(1));
        const b = document.body.querySelector('.app-rt-badge');
        SH.responseBadge(false);
        return (before === false && b && /زمن الاستجابة/.test(b.textContent) && !document.body.querySelector('.app-rt-badge') && store.getItem('marsa_rt_badge') === null) || J([before, textOf(b)]);
      });
      check('storage blocked: eta null and record does not throw', () => {
        const thr = makeStorage({ throws: true }); c.localStorage = thr; w.localStorage = thr;
        return true;
      });
    }
    check('the OTP gate runs on every app page before the context (signs out + login.html?otp=<reason>#staff when not allowed)', () =>
      (/var gateP = typeof api\.otpGate === 'function' && PAGE !== 'login' \? call\(function \(\) \{ return api\.otpGate\(\); \}\) : Promise\.resolve\(null\);/.test(SRC.shell)
        && /if \(gd && gd\.allowed === false\) \{[\s\S]{0,200}api\.signOut\(\)[\s\S]{0,200}location\.replace\('login\.html\?otp='/.test(SRC.shell)) || 'gate');
    check('errMsg of MarsaOps.ui uses MarsaShell.techKnown for a raw failure without a code', () => /if \(!c && SH && typeof SH\.techKnown === 'function'\)/.test(SRC.alerts) || 'errMsg');
    check('exports run under the progress overlay, never cancellable (the audit comes before the file)', () =>
      /P\.track\('export:' \+ def\.report \+ ':' \+ format, job, \{ label: t\('exp_running'\), cancellable: false \}\)/.test(SRC.exp) || 'export');
  }

  /* ================================================================ OTP: supa.js (vm with a fake client) + login.html / auth.js */
  section('e-mail code login: off by default, shouldCreateUser false, one message, attempts / cooldown, the gate after the code, MFA unchanged');
  {
    const sent = [];
    let sessionToken = null, checkAnswer = { allowed: true, reason: 'ok', otp_session: true, mfa_pending: true };
    const fakeClient = {
      rpc: (name, a) => { sent.push(['rpc', name, a]); return Promise.resolve(name === 'otp_session_check' ? { data: checkAnswer, error: null } : { data: null, error: null }); },
      auth: {
        signInWithOtp: a => { sent.push(['otp', a]); return Promise.resolve({ data: {}, error: null }); },
        verifyOtp: a => { sent.push(['verify', a]); return Promise.resolve({ data: { session: { access_token: sessionToken } }, error: null }); },
        signOut: () => Promise.resolve({ error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getSession: () => Promise.resolve({ data: { session: sessionToken ? { access_token: sessionToken, user: { id: U1 } } : null }, error: null })
      }
    };
    function supaCtx(config) {
      const store = {};
      const win = { MARSA_CONFIG: config, supabase: { createClient: () => fakeClient }, addEventListener() {}, dispatchEvent() {},
        location: { origin: 'http://127.0.0.1:8000', pathname: '/login.html', hostname: '127.0.0.1', href: 'http://127.0.0.1:8000/login.html' } };
      const cx = { window: win, document: { currentScript: null, head: { appendChild() {} }, createElement: () => ({}), addEventListener() {},
          documentElement: { setAttribute() {}, getAttribute: () => null, hasAttribute: () => false }, querySelector: () => null, querySelectorAll: () => [] },
        localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: { onLine: true }, location: win.location, atob: s => Buffer.from(s, 'base64').toString('binary'),
        console, setTimeout, clearTimeout, Promise, CustomEvent: function () {}, crypto: require('crypto').webcrypto, URL, Date, Math, JSON };
      win.window = win; win.atob = cx.atob;
      vm.createContext(cx); vm.runInContext(SRC.supa, cx);
      return win.MarsaApi;
    }
    const tok = (amr, sid) => 'h.' + Buffer.from(JSON.stringify(Object.assign({ sub: U1, amr }, sid ? { session_id: sid } : {}))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.s';
    const on = supaCtx({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'test-anon-key-not-real', orgSlug: 'x', emailOtpLogin: true });
    const off = supaCtx({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'test-anon-key-not-real', orgSlug: 'x' });
    check('platform switch: emailOtpEnabled() only with MARSA_CONFIG.emailOtpLogin === true (absent = off; config.example.js ships false)', () =>
      (on.emailOtpEnabled() === true && off.emailOtpEnabled() === false && /emailOtpLogin: false/.test(rd('assets/js/config.example.js'))) || 'switch');
    await acheck('requestEmailOtp: signInWithOtp with shouldCreateUser false (never creates a user)', async () => {
      await on.requestEmailOtp(' Staff@Org.sa ');
      const a = sent.filter(s => s[0] === 'otp')[0];
      return (a && a[1].email === 'Staff@Org.sa' && a[1].options && a[1].options.shouldCreateUser === false) || J(sent);
    });
    await acheck('verifyEmailOtp: digits only (Arabic-Indic accepted), type email; a malformed code never reaches the server', async () => {
      const bad = await on.verifyEmailOtp('a@b.sa', '12');
      await on.verifyEmailOtp('a@b.sa', '١٢٣ ٤٥٦');
      const v = sent.filter(s => s[0] === 'verify');
      return (bad.error && bad.error.code === 'AUTH_OTP_INVALID' && v.length === 1 && v[0][1].token === '123456' && v[0][1].type === 'email') || J([bad, v]);
    });
    check('sessionUsedOtp reads the amr claim (otp / magiclink → true; password / totp → false; junk → false)', () =>
      (on.sessionUsedOtp({ access_token: tok([{ method: 'otp' }]) }) === true && on.sessionUsedOtp({ access_token: tok(['magiclink']) }) === true
        && on.sessionUsedOtp({ access_token: tok([{ method: 'password' }, { method: 'totp' }]) }) === false && on.sessionUsedOtp({ access_token: 'x' }) === false) || 'amr');
    await acheck('otpGate: a password session passes without a call; a session of the code form → otp_session_check; platform switch off → blocked; a failed check → blocked (fails closed)', async () => {
      sessionToken = tok([{ method: 'password' }]);
      const n0 = sent.length, g1 = await on.otpGate();
      const noCall = sent.length === n0;
      sessionToken = tok([{ method: 'otp' }], 'S-code');
      await on.verifyEmailOtp('a@b.sa', '123456'); await off.verifyEmailOtp('a@b.sa', '123456');   // the code form marks its session
      const g2 = await on.otpGate();
      const called = sent.some(s => s[0] === 'rpc' && s[1] === 'otp_session_check');
      const g3 = await off.otpGate();
      checkAnswer = null;
      const g4 = await on.otpGate();
      checkAnswer = { allowed: false, reason: 'org_disabled', otp_session: true };
      const g5 = await on.otpGate();
      checkAnswer = { allowed: true, reason: 'ok', otp_session: true, mfa_pending: true };
      return (g1.data.allowed === true && noCall && g2.data.allowed === true && called && g3.data.allowed === false && g3.data.reason === 'platform_disabled'
        && g4.data.allowed === false && g4.data.reason === 'check_failed' && g5.data.allowed === false && g5.data.reason === 'org_disabled') || J([g1, g2, g3, g4, g5]);
    });
    await acheck('regression: an e-mail LINK session (password reset / sign-up / invite confirmation: amr otp in the implicit flow, no code-form marker) is never signed out — default config (switch off) and switch on, no server call', async () => {
      sessionToken = tok([{ method: 'otp' }], 'S-recovery');
      const n0 = sent.length, a = await off.otpGate(), b = await on.otpGate();
      const noCall = sent.length === n0;
      // a later password sign-in (new session id) is not taken for the old code session either; signOut clears the marker
      sessionToken = tok([{ method: 'otp' }], 'S-code');
      const c0 = await on.otpGate();
      await on.signOut();
      const c1 = await on.otpGate();
      return (a.data.allowed === true && a.data.reason === 'email_link' && b.data.allowed === true && b.data.reason === 'email_link' && noCall
        && on.sessionFromOtpForm({ access_token: tok([{ method: 'otp' }], 'S-recovery') }) === false && c0.data.reason !== 'email_link' && c1.data.reason === 'email_link') || J([a, b, c0, c1]);
    });
    check('login.html: the code block is hidden by default inside the staff panel, labelled fields, one-time-code autocomplete, numeric input', () => {
      const i = LOGIN_HTML.indexOf('data-otp hidden'), staff = LOGIN_HTML.indexOf('id="staff"'), forgot = LOGIN_HTML.indexOf('data-auth-view="forgot"');
      return (i > staff && i < forgot && /<label class="form-label" for="otp-email">/.test(LOGIN_HTML) && /<label class="form-label" for="otp-code">/.test(LOGIN_HTML)
        && /id="otp-code"[^>]*autocomplete="one-time-code" inputmode="numeric"/.test(LOGIN_HTML) && /id="otp-request-form" data-auth-form novalidate hidden/.test(LOGIN_HTML)) || 'login.html';
    });
    check('auth.js: shown only when the platform switch is on; one message for any answer except a network failure; 60 s cooldown; 5 attempts; the gate after the code, then routeByRole (MFA step there)', () =>
      (/function otpOn\(\) \{ return !!\(otpBox && typeof api\.emailOtpEnabled === 'function' && api\.emailOtpEnabled\(\)/.test(SRC.auth)
        && /if \(r\.error && r\.error\.code === 'MRS_NETWORK'\) \{ showMsg\(errText\(r\.error\), 'danger'\); return; \}\n\s*otpEmail = email;/.test(SRC.auth)
        && /var OTP_COOLDOWN_S = 60, OTP_MAX_TRIES = 5;/.test(SRC.auth)
        && /return api\.otpGate\(\)\.then\(function \(g\) \{[\s\S]{0,120}if \(gd\.allowed !== true\) \{[\s\S]{0,80}return api\.signOut\(\)[\s\S]{0,400}return routeByRole\(true\);/.test(SRC.auth)
        && /if \(session && typeof api\.otpGate === 'function'\) \{/.test(SRC.auth)) || 'auth.js');
    check('login dictionary: the OTP strings in ar and en (same keys); the message never says whether the account exists', () => {
      const keys = ['otpOr', 'otpOpen', 'otpLead', 'otpSend', 'otpCode', 'otpVerify', 'otpResend', 'otpSent', 'otpWait', 'otpWrong', 'otpLocked', 'otpCodeError', 'otpOrgDisabled', 'otpStaffOnly', 'otpNotAllowed'];
      return (keys.every(k => (SRC.loginDict.match(new RegExp('\\n    ' + k + ': ', 'g')) || []).length === 2) && /إن كان هذا البريد لحساب موظف/.test(SRC.loginDict) && /If this address belongs to a staff account/.test(SRC.loginDict)) || 'dict';
    });
  }

  /* ================================================================ owner decisions */
  section('owner decisions recorded (dated) and respected');
  check('«قرارات المالك» has a dated 2026-11-11 line for the step-8 UI defaults', () => /- \(2026-11-11\) قرارات افتراضية لواجهة المرحلة 8/.test(PLAN) || 'plan');
  check('no step-8 UI writes billing / Daftra rows or approves anything', () => {
    const ui = [SRC.register, SRC.recon, SRC.audit, SRC.rules, SRC.colfilter].join('\n');
    return !/createBillingIntent|issueInvoice|pushToDaftra|approve[A-Z]\w*\(|setDaftraWritePolicy/.test(ui) || 'writes';
  });

  console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('\nFAILURES:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);   // app-shell.js arms its badge timers (a page lifetime); the suite ends here
})().catch(e => { console.error(e); process.exit(1); });
