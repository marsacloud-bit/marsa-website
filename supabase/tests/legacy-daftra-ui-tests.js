#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy step 7 «مواءمة دفترة» UI tests: assets/js/bill/dft-kit.js (MarsaOps.dftKit), assets/js/bill/dft-settings.js
  (the step-7 tabs and cards of #daftra), the step-7 parts of assets/js/bill/daftra.js and assets/js/bill/tx-bill.js, the supplier
  search of a trip (ops/tx-legacy.js), the opening-draft note of the declaration screens (ops/tx-sections.js, decl-review.js),
  assets/i18n/dft.js and the page wiring (admin.html / ocr.html / sw.js / bill.css). Pure Node, no database, no network, no
  dependencies (vm + window shim + supabase/tests/lib/fake-dom.js; the real MarsaOps.ui / finKit / billKit are loaded).

  Covers: classic-script wrapper + ES5 + no innerHTML; the 'dft' dictionary (ar = en keys, {vars} parity, literal keys, every
  dynamic family); the contract with 20261123000100 (the 30 worker error codes and their Arabic / English texts, the aliases of
  supabase/functions/daftra-sync/adapter.js, custom field names, the key / code patterns, import columns / actions, candidate /
  run / purchase states, the review decisions of resolve_daftra_review, the KSA country list, every MarsaApi call exists);
  owner decisions (no UI changes the write policy; allow_draft_update is shown read only «ممنوع»; the org toggles are owner-only;
  an existing draft is never pushed again; links are https + noopener); pure helpers (errorCode / errorFields / errorText,
  accountView for the Egypt account, codeNorm 000186 = 186, the CustomModel payload, the client-file mapping, the confirmation
  number, the comparison rows, the opening state, today in Asia/Riyadh, safeUrl); DOM flows: the connection tab (KSA guard with
  what to change, policy, owner toggles), products (unmapped list, set code, read-only match, confirm), custom fields (owner
  editor, dry run), client import (Daftra request, staged rows + decisions, the CSV file), reviews, the transaction strip
  (Daftra link, HF5 / KSA push block, error dictionary, refresh once when stale, opening retry, invoice look-up, side-by-side
  confirmation with the number typed again, blocked candidate, review resolution, purchase drafts), the trip supplier search
  and the opening note.

  usage:  node supabase/tests/legacy-daftra-ui-tests.js [/path/to/marsa-website] [--quiet]
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
function eq(name, got, want) { check(name, () => J(got) === J(want) || ('got ' + J(got) + ' want ' + J(want))); }
const settle = (ms) => new Promise(r => setTimeout(r, ms || 0));

/* ------------------------------------------------------------ sources */
const SRC = {
  dict: rd('assets/i18n/dft.js'), billDict: rd('assets/i18n/bill.js'), finDict: rd('assets/i18n/fin.js'),
  alerts: rd('assets/js/ops/alerts.js'), inv: rd('assets/js/fin/invoices.js'), billing: rd('assets/js/bill/billing.js'), xlsx: rd('assets/js/xlsx-lite.js'),
  kit: rd('assets/js/bill/dft-kit.js'), settings: rd('assets/js/bill/dft-settings.js'), daftra: rd('assets/js/bill/daftra.js'), txbill: rd('assets/js/bill/tx-bill.js')
};
const TXLEGACY = rd('assets/js/ops/tx-legacy.js'), TXSECT = rd('assets/js/ops/tx-sections.js'), DECL = rd('assets/js/decl-review.js'), DECL_DICT = rd('assets/i18n/decl.js');
const MIG = rd('supabase/migrations/20261123000100_legacy_daftra.sql');
const SUPA = rd('assets/js/supa.js');
const ADMIN_HTML = rd('admin.html'), OCR_HTML = rd('ocr.html'), SW = rd('sw.js'), CSS = rd('assets/css/pages/bill.css');
const ADAPTER = require(path.join(ROOT, 'supabase/functions/daftra-sync/adapter.js'));

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
function context(o) {
  o = o || {};
  const { document, Node } = makeDom();
  document.documentElement = new Node('html');
  document.activeElement = null;
  document.contains = () => true;
  document.removeEventListener = () => {};
  const storage = o.storage || makeStorage();
  const w = { MarsaI18n: I18N, document, localStorage: storage, sessionStorage: makeStorage(), open: () => null, confirm: () => true };
  w.window = w;
  const c = { window: w, document, localStorage: storage, location: { hash: '' }, Intl, Date, Math, String, Object, Array, JSON, Number, RegExp, parseInt, parseFloat,
    isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, Error, TextDecoder, TextEncoder, Uint8Array, DataView, ArrayBuffer,
    Event: function (t) { this.type = t; }, CustomEvent: function (t) { this.type = t; } };
  vm.createContext(c);
  ['finDict', 'billDict', 'dict', 'alerts', 'inv', 'billing', 'xlsx', 'kit', 'settings', 'daftra', 'txbill'].forEach(k => vm.runInContext(SRC[k], c, { filename: k + '.js' }));
  return { document, w, storage };
}
const base = context();
const D = base.w.MarsaOps.dftKit;

/* ================================================================ static */
section('static: classic scripts, ES5 only, no innerHTML, compile');
const NEW_JS = { 'assets/js/bill/dft-kit.js': SRC.kit, 'assets/js/bill/dft-settings.js': SRC.settings, 'assets/i18n/dft.js': SRC.dict };
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
Object.keys(NEW_JS).forEach(f => {
  const s = strip(NEW_JS[f]);
  check(f + ': IIFE + strict, ES5 only (no let/const/arrow/template/class), no innerHTML', () =>
    (/^\(function \(/m.test(s) && /'use strict';/.test(s) && !/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s) && !/\bclass\s+\w/.test(s)
      && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(s)) || 'not ES5 / uses HTML');
});
['assets/js/bill/tx-bill.js', 'assets/js/bill/daftra.js', 'assets/js/ops/tx-legacy.js', 'assets/js/ops/tx-sections.js'].forEach(f => {
  check(f + ': still ES5 and no innerHTML after the step-7 changes', () => {
    const s = strip(rd(f));
    return (!/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s) && !/innerHTML|insertAdjacentHTML/.test(s)) || f;
  });
});
check('every new / changed file compiles', () => {
  Object.keys(NEW_JS).concat(['assets/js/bill/tx-bill.js', 'assets/js/bill/daftra.js', 'assets/js/ops/tx-legacy.js', 'assets/js/ops/tx-sections.js', 'assets/js/decl-review.js',
    'assets/i18n/decl.js', 'assets/i18n/bill.js', 'sw.js']).forEach(f => new vm.Script(rd(f), { filename: f }));
  return true;
});
check('MarsaOps.dftKit + dftSettings registered; #daftra still one view (finRead) and the tx section bill-invoices kept', () => {
  const O = base.w.MarsaOps;
  return (O.dftKit && O.dftKit.VERSION === 'dft-ui-1' && O.dftSettings && J(O.dftSettings.TABS) === J(['products', 'fields', 'import', 'reviews'])
    && O.views.daftra && O.views.daftra.allow === 'finRead' && O.txSections.some(s => s.id === 'bill-invoices')) || Object.keys(O);
});
check('no interface changes the write policy: allow_draft_update / allow_product_create are never sent; setDaftraWritePolicy is called only by the owner toggles of the two org settings', () => {
  const ui = [SRC.kit, SRC.settings, SRC.daftra, SRC.txbill, TXLEGACY, TXSECT, DECL].join('\n');
  const uses = ui.match(/setDaftraWritePolicy/g) || [];
  return (uses.length === 1 && /var p = \{\}; p\[name\] = !on; return U\.call\(api, 'setDaftraWritePolicy'/.test(SRC.settings)
    && /toggleRow\('auto_draft_on_declaration'/.test(SRC.settings) && /toggleRow\('purchase_drafts_enabled'/.test(SRC.settings)
    && !/toggleRow\('allow_/.test(SRC.settings) && !/allow_draft_update\s*:/.test(ui) && !/allow_product_create\s*:/.test(ui)) || 'policy';
});
check('the AI never approves: no AI call in the step-7 UI; links to Daftra only through safeUrl with rel noopener', () => {
  const ui = SRC.kit + SRC.settings + SRC.txbill;
  const links = (ui.match(/target: '_blank'[^}]*/g) || []);
  return (!/aiExtract|approveDeclarationExtraction/.test(ui) && links.length >= 3 && links.every(l => /rel: 'noopener noreferrer'/.test(l))
    && (SRC.txbill.match(/D\.safeUrl\(/g) || []).length >= 2) || links;
});
check('review: the owner = an org-wide admin (api.orgOwner, app.daftra_is_owner); the org toggles go through setDaftraWritePolicy with a reason; the field-map editor is bill_admin (as on the server); the dry run owner-only', () =>
  (/function isOwner\(api\) \{ try \{ return !!\(api && api\.orgOwner === true && typeof api\.can === 'function' && api\.can\('orgAdmin'\)\); \}/.test(SRC.settings)
    && /var act = owner \? U\.btn\(/.test(SRC.settings) && /U\.call\(api, 'setDaftraWritePolicy', p, String\(v\.reason\)\.trim\(\)\)/.test(SRC.settings)
    && !/'saveDaftraConnection', p\)/.test(SRC.settings)
    && /var canEdit = B\.canAdmin\(api\);/.test(SRC.settings) && /if \(owner\) body\.appendChild\(dryRunCard\(\)\);/.test(SRC.settings)
    && /orgOwner: isOrgAdmin\(\)/.test(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin.js'), 'utf8'))) || 'owner');

/* ================================================================ dictionary */
section('dictionary (namespace dft)');
const AR = Object.keys(dicts.ar).filter(k => k.startsWith('dft.')), EN = Object.keys(dicts.en).filter(k => k.startsWith('dft.'));
check('ar and en have the same keys', () => (AR.length > 380 && AR.length === EN.length && AR.every(k => dicts.en[k] != null)) || [AR.length, EN.length, AR.filter(k => dicts.en[k] == null), EN.filter(k => dicts.ar[k] == null)]);
check('no empty strings', () => AR.concat(EN).every(k => String(dicts.ar[k] || dicts.en[k]).trim()) || 'empty');
check('the {vars} of each string are the same in ar and en', () => {
  const vs = s => (String(s).match(/\{[a-z_]+\}/g) || []).sort().join();
  const bad = AR.filter(k => vs(dicts.ar[k]) !== vs(dicts.en[k]));
  return !bad.length || bad;
});
const has = k => dicts.ar['dft.' + k] != null && dicts.en['dft.' + k] != null;
check('every literal D.t(\'key\') / T(\'key\') of the step-7 code exists', () => {
  const miss = [];
  [SRC.kit, SRC.settings, SRC.daftra, SRC.txbill].forEach(s => { let m; const re = /\b(?:D\.t|T)\('([a-z][a-z0-9_]*)'(?=[,)])/g; while ((m = re.exec(s))) if (!has(m[1])) miss.push(m[1]); });
  return !miss.length || [...new Set(miss)];
});
const fam = (pre, list) => list.filter(c => !has(pre + c)).map(c => pre + c);
check('dynamic families: errors, account reasons / fixes, custom fields, import actions / reasons / states, runs, candidates, purchases, reviews, decisions, opening', () => {
  const miss = [].concat(fam('err_', D.ERROR_CODES), fam('acct_reason_', ['not_checked', 'currency', 'country', 'vat_rate']), fam('acct_fix_', ['not_checked', 'currency', 'country', 'vat_rate', 'then']),
    fam('cf_', D.CUSTOM_FIELDS), fam('cf_type_', D.DECL_TYPES), fam('act_', ['create', 'link', 'update_link', 'review_name', 'conflict', 'skip', 'invalid']),
    fam('reason_', ['daftra_id', 'client_number', 'arabic_name', 'new', 'id_and_code_on_two_clients', 'client_linked_elsewhere', 'name_on_several_clients', 'name', 'external_id']),
    fam('row_st_', ['pending', 'applied', 'skipped', 'conflict']), fam('run_st_', ['queued', 'running', 'ready', 'done', 'applied', 'aborted', 'failed']),
    fam('run_kind_', ['product_match', 'client_import', 'client_file', 'legacy_scan', 'supplier_search']),
    fam('cand_st_', ['open', 'review', 'blocked', 'linked', 'rejected', 'superseded']), fam('src_', ['lookup_number', 'lookup_composite', 'legacy_scan']),
    fam('pd_st_', ['open', 'draft', 'failed', 'cancelled']), fam('rv_kind_', D.REVIEW_KINDS), fam('rv_st_', ['open', 'resolved', 'dismissed']),
    fam('dec_', ['done_in_daftra', 'dismiss', 'acknowledge']),
    fam('op_reason_', ['declaration_no', 'client_inactive', 'client_not_linked', 'not_connected', 'account_not_ksa', 'unmapped_product', 'custom_required', 'error']),
    fam('op_res_', ['queued', 'exists', 'retried', 'blocked', 'disabled']), fam('tab_', ['products', 'fields', 'import', 'reviews']),
    fam('pm_st_', ['mapped', 'code_only', 'no_code', 'not_found']), fam('tx_origin_', ['opening', 'linked', 'marsa']), fam('tx_cmp_', ['client', 'decl', 'bl', 'ctr', 'ref', 'date', 'total', 'state', 'ok', 'bad', 'missing']),
    fam('tx_client_', ['ok', 'conflict', 'unlinked']), fam('rb_', ['client', 'total', 'lines', 'date']));
  return !miss.length || miss;
});
check('the owner decisions are stated in both languages (new drafts only, products never created, KSA guard, AI never approves, empty return)', () =>
  (/مسودات جديدة فقط/.test(dicts.ar['dft.pol_draft_reason']) && /New drafts only/.test(dicts.en['dft.pol_draft_reason']) && dicts.ar['dft.pol_forbidden'] === 'ممنوع'
    && /لا تُنشأ أبدًا/.test(dicts.ar['dft.pol_product_reason']) && /never created/.test(dicts.en['dft.pol_product_reason'])
    && /لا يعتمد شيئًا/.test(dicts.ar['dft.pol_ai']) && /empty-return/.test(dicts.en['dft.pol_ai']) && /لا يلغي اعتماد البيان/.test(dicts.ar['dft.org_auto_hint'])
    && /الريال السعودي/.test(dicts.ar['dft.acct_fix_currency']) && /SAR/.test(dicts.en['dft.acct_fix_currency'])) || 'rules');
check('i18n/bill.js items_rule no longer says products are created; i18n/decl.js Daftra lines describe the opening setting', () =>
  (!/تُنشأ الأصناف عند أول/.test(SRC.billDict) && /لا ينشئ أصنافًا/.test(SRC.billDict) && /never creates Daftra products/.test(SRC.billDict)
    && /فتح مسودة دفترة صفرية عند اعتماد البيان/.test(DECL_DICT) && !/لا تُنشأ في هذه المرحلة/.test(DECL_DICT)) || 'texts');
check('tx-legacy.js: the three Daftra cancel details have ar + en texts', () =>
  ['daftra_invoice_issued', 'daftra_sync_in_flight', 'daftra_purchase'].every(d => (TXLEGACY.match(new RegExp('cancel_err_' + d + ':', 'g')) || []).length === 2 && TXLEGACY.includes("'" + d + "'")) || 'cancel');

/* ================================================================ contract */
section('contract with 20261123000100, adapter.js and supa.js');
const migLabels = dom => { const rows = []; MIG.replace(new RegExp("\\('" + dom + "','([a-z_0-9]+)',\\d+,'([^']*)','([^']*)'", 'g'), (m, c, ar, en) => { rows.push([c, ar, en]); return m; }); return rows; };
check('the 32 worker error codes = the daftra_error dictionary rows (same order) = adapter.js DAFTRA_ERROR_CODES', () => {
  const rows = migLabels('daftra_error');
  return (rows.length === 32 && J(rows.map(r => r[0])) === J(D.ERROR_CODES) && J(Array.from(ADAPTER.DAFTRA_ERROR_CODES)) === J(D.ERROR_CODES)) || [rows.map(r => r[0]), D.ERROR_CODES];
});
check('the Arabic / English error texts are the server dictionary texts', () => {
  const bad = migLabels('daftra_error').filter(r => dicts.ar['dft.err_' + r[0]] !== r[1] || dicts.en['dft.err_' + r[0]] !== r[2]).map(r => r[0]);
  return !bad.length || bad;
});
check('errorCode / errorFields behave exactly as adapter.js for codes, aliases, kinds and messages', () => {
  const probes = D.ERROR_CODES.map(c => ({ code: c })).concat(Object.keys(D.ERROR_ALIASES).map(c => ({ code: c })),
    [{ code: 'config_missing' }, { code: 'weird', kind: 'timeout' }, { code: '', kind: 'conflict' }, { kind: 'zzz' }, null, { code: 'x', message: 'bad (fields: declaration_no, bl)' }, { message: 'no fields here' }]);
  const bad = probes.filter(p => D.errorCode(p) !== ADAPTER.errorCode(p) || J(D.errorFields(p)) !== J(ADAPTER.errorFields(p)));
  return !bad.length || bad;
});
check('custom field names = the daftra_custom_field domain; the key / code patterns are the server\'s', () =>
  (J(migLabels('daftra_custom_field').map(r => r[0])) === J(D.CUSTOM_FIELDS) && MIG.includes("v_key !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'") && String(D.KEY_RE) === '/^[A-Za-z][A-Za-z0-9_]{0,39}$/'
    && MIG.includes("v_code !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'") && String(D.CODE_RE) === '/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/') || 'patterns');
check('the client-file columns = import_clients only_keys; the import actions / candidate / run / purchase states = the CHECK lists', () =>
  (MIG.includes("only_keys(x, ARRAY['" + Object.keys(D.IMPORT_COLS).join("','") + "'])")
    && MIG.includes("proposed_action   text NOT NULL CHECK (proposed_action IN ('create','link','update_link','review_name','conflict','skip','invalid'))")
    && MIG.includes("state               text NOT NULL DEFAULT 'open' CHECK (state IN ('open','review','blocked','linked','rejected','superseded','partial'))")
    && MIG.includes("status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','done','applied','aborted','failed'))")
    && MIG.includes("status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','draft','failed','cancelled'))")) || 'lists');
check('review decisions mirror resolve_daftra_review (kinds, decisions, roles)', () => {
  const body = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.resolve_daftra_review'), MIG.indexOf('-- list_daftra_reviews'));
  return (body.includes("(v_r.kind = 'manual_in_daftra' AND p_decision IN ('done_in_daftra','dismiss'))")
    && body.includes("(v_r.kind IN ('date_mismatch','readback_mismatch','client_mismatch') AND p_decision = 'acknowledge')")
    && body.includes("(v_r.kind = 'opening_blocked' AND p_decision = 'dismiss')")
    && body.includes("v_roles := CASE WHEN p_decision = 'done_in_daftra' OR v_r.kind = 'opening_blocked' THEN app.fin_write_roles() ELSE app.fin_approve_roles() END;")
    && J(D.REVIEW_KINDS) === J(['manual_in_daftra', 'date_mismatch', 'readback_mismatch', 'client_mismatch', 'opening_blocked'])) || 'decisions';
});
check('the Saudi country list = app.daftra_account_check', () =>
  ['sa', 'sau', 'ksa', 'saudi arabia', 'kingdom of saudi arabia', 'السعودية', 'المملكة العربية السعودية'].every(c => D.isSaudiCountry(c) && D.isSaudiCountry(c.toUpperCase()))
    && !D.isSaudiCountry('Egypt') && !D.isSaudiCountry('مصر') && MIG.includes("ARRAY['sa','sau','ksa','saudi arabia','kingdom of saudi arabia','السعودية','المملكة العربية السعودية']") || 'countries');
check('every MarsaApi call of the step-7 UI exists in supa.js', () => {
  const names = new Set();
  [SRC.kit, SRC.settings, SRC.daftra].forEach(s => { let m; const re = /(?:U|D)\.call\(api, '([A-Za-z]+)'/g; while ((m = re.exec(s))) names.add(m[1]); const re3 = /\bcall\(api, '([A-Za-z]+)'/g; while ((m = re3.exec(s))) names.add(m[1]); });
  let m; const re2 = /M\(api, '([A-Za-z]+)'\)/g; while ((m = re2.exec(SRC.txbill))) names.add(m[1]);
  const miss = [...names].filter(n => !new RegExp('\\b' + n + ': ' + n + '\\b').test(SUPA));
  const want = ['listDaftraProductMap', 'saveDaftraProductCode', 'requestDaftraProductMatch', 'confirmDaftraProductMapping', 'saveDaftraCustomFields', 'testDaftraCustomFields',
    'requestDaftraClientImport', 'listDaftraClientImport', 'applyDaftraClientImport', 'importClients', 'listDaftraReviews', 'resolveDaftraReview', 'requestDaftraLegacyScan', 'getDaftraRun',
    'refreshTxDaftra', 'retryDaftraOpening', 'requestDaftraInvoiceLookup', 'confirmInvoiceLink', 'rejectInvoiceCandidate', 'requestDaftraSupplierSearch', 'listDaftraSupplierLinks',
    'requestDaftraPurchaseDraft', 'txBilling'];
  return (!miss.length && want.every(n => names.has(n))) || [miss, want.filter(n => !names.has(n))];
});
check('tx_billing returns what the strip reads (opening, invoice_candidates, purchase_drafts, stale, connection policy + account_check, can)', () => {
  const body = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.tx_billing'), MIG.indexOf('-- save_daftra_connection(p_org'));
  return ["'opening'", "'invoice_candidates'", "'purchase_drafts'", "'stale'", "'allow_draft_update'", "'auto_draft_on_declaration'", "'purchase_drafts_enabled'", "'account_check'", "'can'"].every(k => body.includes(k)) || 'tx_billing';
});

/* ================================================================ pure */
section('pure helpers');
eq('errorCode: code, alias, config_*, kind, conflict → validation, else worker',
  ['account_not_ksa', 'draft_update_refused', 'product_create_refused', 'config_x', 'redirect', 'run_deadline', 'tax_ambiguous', 'not_draft', 'item_unmapped', 'offline', 'exception'].map(c => D.errorCode({ code: c }))
    .concat([D.errorCode({ code: 'zz', kind: 'rate_limited' }), D.errorCode({ kind: 'conflict' }), D.errorCode({ code: 'zz' }), D.errorCode('custom_required')]),
  ['account_not_ksa', 'draft_update_disabled', 'product_create_disabled', 'not_configured', 'not_configured', 'timeout', 'tax_map_invalid', 'invoice_issued', 'unmapped_product', 'network', 'worker',
    'rate_limited', 'validation', 'worker', 'custom_required']);
eq('errorFields reads "(fields: a, b)"', [D.errorFields({ message: 'x (fields: declaration_no, bl)' }), D.errorFields({ message: 'none' })], [['declaration_no', 'bl'], []]);
check('errorText: the Arabic message with the field labels; the account reason labelled; an unknown code = the worker message', () =>
  (D.errorText({ code: 'custom_required', message: 'missing (fields: declaration_no, bl)' }) === 'حقول دفترة الإضافية المطلوبة ناقصة: رقم البيان، رقم البوليصة. لم يُرسل شيء.'
    && /عملة الحساب ليست الريال السعودي/.test(D.errorText({ code: 'product_not_found', message: '(fields: currency)' }))
    && D.errorText('weird') === dicts.ar['dft.err_worker'] && D.errorText(null) === '') || D.errorText({ code: 'custom_required', message: 'missing (fields: declaration_no, bl)' }));
check('errorText in English', () => { LANG = 'en'; const s = D.errorText({ code: 'validation', message: '(fields: client)' }); LANG = 'ar'; return s === 'Daftra refused the data: client.' || s; });
eq('accountView: the Egypt account (EGP, Egypt, no 15 %) → currency, country, VAT fixes, then re-check',
  D.accountView({ ok: false, reason: 'currency', currency: 'EGP', country: 'Egypt', vat_15: false, enforced: true }),
  { ok: false, reason: 'currency', enforced: true, fixes: ['acct_fix_currency', 'acct_fix_country', 'acct_fix_vat_rate', 'acct_fix_then'] });
eq('accountView: not checked (live, no profile) → run the probe; missing check = blocked; ok → no fixes',
  [D.accountView({ ok: false, reason: 'not_checked', enforced: true }).fixes, D.accountView(null).ok, D.accountView({ ok: true, enforced: true }).fixes, D.accountView({ ok: false, reason: 'vat_rate', currency: 'SAR', country: 'SA', vat_15: false }).fixes],
  [['acct_fix_not_checked', 'acct_fix_then'], false, [], ['acct_fix_vat_rate', 'acct_fix_then']]);
eq('codeNorm: zero-insensitive digits (000186 = 186, Arabic digits), text upper-cased, 000 → 0, empty → null',
  [D.codeNorm('000186'), D.codeNorm('186'), D.codeNorm('٠٠١٨٦'), D.codeNorm(' abc-1 '), D.codeNorm('000'), D.codeNorm('  ')], ['186', '186', '186', 'ABC-1', '0', null]);
eq('productState: mapped / code only / not found / no code',
  [D.productState({ mapped: true, link: { remote_code_norm: '1' } }), D.productState({ link: { remote_code_norm: '1' } }), D.productState({ link: { remote_code_norm: '1', last_error_code: 'product_not_found' } }), D.productState({ link: null })],
  ['mapped', 'code_only', 'not_found', 'no_code']);
check('customMapPayload: keys + required, empty = not sent, bad / duplicate keys refused, port / type values trimmed', () => {
  const r = D.customMapPayload({ key_declaration_no: 'field_1', req_declaration_no: true, key_bl: 'field_2', key_port: '', key_goods: '9x', key_origin: 'field_1', type_import: ' وارد ', port_JED: ' جدة ', port_XX: '' }, ['JED', 'XX']);
  return (J(r.map) === J({ fields: { declaration_no: { key: 'field_1', required: true }, bl: { key: 'field_2', required: false } }, port_values: { JED: 'جدة' }, type_values: { import: 'وارد' } })
    && J(r.errors) === J({ key_goods: 'cf_key_bad', key_origin: 'cf_key_dup' })) || J(r);
});
check('mapImportRows: Arabic / English titles, digits westernised, category mapped, empty rows skipped, unknown columns reported', () => {
  const r = D.mapImportRows([['', ''], ['رقم العميل', 'اسم العميل', 'الرقم الضريبي', 'التصنيف', 'Notes', 'E-mail'], ['٠١٢', 'شركة أ', '300000000000003', 'ميناء', 'x', 'a@b.co'], ['', '', '', ''], ['', 'شركة ب', '', 'مطار']]);
  return (r.error === null && r.skipped === 1 && J(r.unknown) === J(['Notes']) && J(r.rows) === J([{ client_number: '012', name: 'شركة أ', vat_number: '300000000000003', port_category: 'port', email: 'a@b.co' }, { name: 'شركة ب', port_category: 'airport' }])) || J(r);
});
eq('mapImportRows refusals: no name column, empty, more than 2000',
  [D.mapImportRows([['code', 'vat'], ['1', '2']]).error, D.mapImportRows([]).error, D.mapImportRows([['name']].concat(Array.from({ length: 2001 }, (x, i) => ['n' + i]))).error],
  ['im_file_e_name', 'im_file_e_empty', 'im_file_e_many']);
eq('numberMatches mirrors confirm_invoice_link (letters / digits only, upper case, Arabic digits)',
  [D.numberMatches('inv-0012', { daftra_number: 'INV0012' }), D.numberMatches('INV٠٠١٢', { daftra_number: 'INV-0012' }), D.numberMatches('0012', { daftra_number: 'INV-0012' }), D.numberMatches('77', { external_invoice_id: '77' }), D.numberMatches('', { daftra_number: '' })],
  [true, true, false, true, false]);
check('compareRows: client check, declaration / B/L / containers from the server match, Marsa values side by side', () => {
  const rows = D.compareRows({ client_name: 'عميل دفترة', client_check: 'conflict', fields: { declaration_no: 'D1', bl: 'BL1', containers: ['C1'] }, match: { declaration: true, bl: false, containers: null }, total: 115, currency: 'SAR', invoice_date: '2026-11-11', remote_state: 'issued', po_number: 'MRS-1' },
    { client: 'عميل', declaration_nos: ['D1'], bl_numbers: ['BL9'], containers: [], ref: 'MRS-1' });
  const by = {}; rows.forEach(r => { by[r.field] = r; });
  return (by.client.check === 'bad' && by.client.note === 'tx_client_conflict' && by.decl.check === 'ok' && by.bl.check === 'bad' && by.bl.marsa === 'BL9' && by.ctr.check === 'missing'
    && by.total.daftra === '115.00 SAR' && by.state.daftra === 'صادرة' && by.ref.marsa === 'MRS-1') || J(rows);
});
eq('openingState: queued (with its ref) / blocked (reason labelled) / off / none',
  [D.openingState({ opening: { intent_id: 'i1' }, intents: [{ id: 'i1', operational_ref: 'MRS-1' }], connection: { auto_draft_on_declaration: true } }).ref,
    D.openingState({ opening: { blocked: { reason: 'custom_required', fields: 'declaration_no,bl' } }, connection: { auto_draft_on_declaration: true } }).reason,
    D.openingState({ connection: {} }).state, D.openingState({ connection: { auto_draft_on_declaration: true }, opening: {} }).state],
  ['MRS-1', 'حقول إضافية إلزامية ناقصة (رقم البيان، رقم البوليصة)', 'off', 'none']);
eq('riyadhToday: Asia/Riyadh (UTC+3), never UTC / the device zone',
  [D.riyadhToday(Date.UTC(2026, 10, 10, 21, 30)), D.riyadhToday(Date.UTC(2026, 10, 10, 20, 59)), D.riyadhToday(Date.UTC(2026, 11, 31, 22, 0))], ['2026-11-11', '2026-11-10', '2027-01-01']);
eq('safeUrl: https only, no script / http / spaces', [D.safeUrl('https://acme.daftra.com/owner/invoices/view/55'), D.safeUrl('http://x.com'), D.safeUrl('javascript:alert(1)'), D.safeUrl('https://x.com/a b'), D.safeUrl(null)],
  ['https://acme.daftra.com/owner/invoices/view/55', null, null, null, null]);
eq('decisionsFor: manual = done (writer) + dismiss (approver); mismatches = acknowledge (approver); opening = dismiss (writer)',
  [D.decisionsFor('manual_in_daftra', { write: true, approve: true }), D.decisionsFor('manual_in_daftra', { write: true }), D.decisionsFor('date_mismatch', { write: true }), D.decisionsFor('client_mismatch', { approve: true }), D.decisionsFor('opening_blocked', { write: true })],
  [['done_in_daftra', 'dismiss'], ['done_in_daftra'], [], ['acknowledge'], ['dismiss']]);
check('reviewLines: manual_in_daftra lists what to add / remove by hand (TAS description, amount, product code); date mismatch in Riyadh time', () => {
  const m = D.reviewLines({ kind: 'manual_in_daftra', details: { daftra_number: 'INV-1', add: [{ description: 'TAS20261110001', total_amount: 50, product_code: '000186' }], remove: [{ description: '', line_ref: 'MRSL-2', total_amount: 10 }] } });
  const d = D.reviewLines({ kind: 'date_mismatch', details: { expected: '2026-11-11', stored: '2026-11-10' } });
  return (m.length === 3 && /INV-1/.test(m[0].text) && m[1].op === 'add' && /أضف في دفترة: TAS20261110001 — 50\.00 · الصنف 000186/.test(m[1].text) && m[2].op === 'remove' && /MRSL-2/.test(m[2].text)
    && /المتوقع 2026-11-11 — المخزّن في دفترة 2026-11-10 \(توقيت الرياض\)/.test(d[0].text)) || J([m, d]);
});
check('remembered runs: per org, newest first, ≤ 8, ids validated; a blocked storage never throws', () => {
  for (let i = 0; i < 10; i++) D.rememberRun('o1', { id: '00000000-0000-4000-8000-00000000000' + i, kind: 'client_import' });
  D.rememberRun('o1', { id: 'bad id', kind: 'client_import' });
  const list = D.recallRuns('o1');
  const c2 = context({ storage: makeStorage({ throws: true }) });
  c2.w.MarsaOps.dftKit.rememberRun('o1', { id: '00000000-0000-4000-8000-000000000001' });
  return (list.length === 7 && list[0].id.endsWith('9') && J(c2.w.MarsaOps.dftKit.recallRuns('o1')) === '[]') || J(list);
});

/* ================================================================ DOM helpers */
const ORG = 'org-1', TX = '11111111-1111-4111-8111-111111111111', TRIP = '22222222-2222-4222-8222-222222222222', RUN = '33333333-3333-4333-8333-333333333333';
const ok = d => Promise.resolve({ data: d, error: null });
const bad = (code, field, msg) => Promise.resolve({ data: null, error: { code, field, message: msg || code } });
function opsEl(document) {
  return (tag, attrs, kids) => {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(k => { const v = attrs[k]; if (v == null || v === false) return; if (k === 'class') n.className = v; else if (k === 'text') n.textContent = String(v);
      else if (k === 'disabled') n.disabled = !!v; else n.setAttribute(k, v === true ? '' : v); });
    [].concat(kids == null ? [] : kids).forEach(function add(c) { if (c == null || c === false) return; if (Array.isArray(c)) return c.forEach(add); n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  };
}
function makeApi(ctx, A, extra) {
  const log = { toasts: [], confirms: [], refresh: 0 };
  let k = 0;
  const roles = (extra && extra.roleSets) || null;
  const api = Object.assign({ orgId: ORG, userId: 'me', roles: ['admin'], branches: [{ id: 'b1' }], orgOwner: !roles,
    can: (set) => roles ? roles.indexOf(Array.isArray(set) ? 'list' : set) !== -1 || (Array.isArray(set) && roles.indexOf('importer') !== -1) : true,
    t: (key, v) => I18N.t(key, v), el: opsEl(ctx.document), MarsaApi: A, toast: (m, t) => log.toasts.push([t, m]),
    confirm: o => { log.confirms.push(o); return Promise.resolve(log.answer !== false); }, modal: () => {}, go: () => {}, refresh: () => { log.refresh++; },
    newIdemKey: () => 'key-' + (++k), label: (d, c) => c, fmtMoney: (n, c) => (+n).toFixed(2) + ' ' + (c || 'SAR'), fmtDate: v => String(v),
    errText: e => (e && e.message) || 'err', isEn: () => false, who: () => 'x', hashQuery: () => ({}) }, extra || {});
  delete api.roleSets;
  return { api, log };
}
const modalForm = D2 => { const all = D2.body.querySelectorAll('form'); return all[all.length - 1] || null; };
function setField(form, name, v) { const c = form.querySelector('[name="' + name + '"]'); if (!c) throw new Error('no field ' + name); if (c.getAttribute('type') === 'checkbox') c.checked = !!v; else c.value = v; return c; }
async function submit(form) { form.dispatch('submit'); await settle(10); }
const btns = (root, sel) => root.querySelectorAll(sel);

/* ================================================================ DOM: #daftra connection tab */
function billingJobsStatic() {
  section('static: the job log (bill/billing.js) knows the step-7 jobs');
  check('job errors go through the Daftra dictionary (MarsaOps.dftKit.errorText) for known codes, raw message otherwise', () =>
    (/function errText\(e\)/.test(SRC.billing) && /K\.errorText\(e\)/.test(SRC.billing) && /errText\(\{ code: j\.last_error_code/.test(SRC.billing) && /errText\(a\.error\)/.test(SRC.billing)) || 'errText');
  check('the kind filter lists the step-7 job kinds', () =>
    ['product_match', 'client_import', 'invoice_lookup', 'legacy_scan', 'supplier_search', 'purchase_push'].every(k => SRC.billing.indexOf("'" + k + "'") !== -1) || 'kinds');
  check('the job target: a transaction (invoice_lookup / purchase_push) links #tx/<id>, a run says «تشغيلة دفترة», not «المنشأة»', () =>
    (/if \(j\.transaction_id\) return el\('a', \{ class: 'ops-ref', href: '#tx\/' \+ j\.transaction_id/.test(SRC.billing) && /if \(j\.run_id\)/.test(SRC.billing)) || 'target');
}

async function connectionFlow() {
  section('DOM: #daftra «الاتصال» — KSA guard (what to change), policy read only «ممنوع», owner toggles, older scan');
  const c = context(), Dc = c.document, calls = [];
  const conn = { id: 'cn', exists: true, mode: 'live_pending', status: 'connected', sync_enabled: true, capabilities: {}, allow_draft_update: false, allow_product_create: false,
    auto_draft_on_declaration: false, purchase_drafts_enabled: false, opening_item: 'item:customs_clearance', purchase_item: 'item:transportation_cost',
    account_check: { ok: false, reason: 'currency', currency: 'EGP', country: 'Egypt', vat_15: false, checked_at: '2026-11-11T08:00:00Z', enforced: true }, last_error_code: 'account_not_ksa' };
  const A = { getDaftraConnection: () => ok({ connection: conn, counts: {}, push_ready: false, missing_capabilities: [] }),
    saveDaftraConnection: p => { calls.push(['save', p]); return ok(Object.assign({}, conn, p)); },
    setDaftraWritePolicy: (p, why) => { calls.push(['policy', p, why]); return ok(Object.assign({}, conn, p)); },
    requestDaftraLegacyScan: (p, o) => { calls.push(['scan', p, o && o.idemKey ? 'key' : null]); return ok({ id: RUN, kind: 'legacy_scan', status: 'queued', resumed: false }); },
    getDaftraRun: id => ok({ id, kind: 'legacy_scan', status: 'failed', counters: { invoices_seen: 300, candidates: 4 }, error_code: 'timeout' }) };
  const root = Dc.createElement('div'); Dc.body.appendChild(root);
  const M = makeApi(c, A);
  await c.w.MarsaOps.views.daftra.render(root, M.api, null); await settle(10);
  const txt = root.textContent;
  check('the Egypt account: writing stopped, the reason, and the three changes the owner makes in Daftra + re-check', () =>
    (root.querySelector('[data-dft="ksa-block"]') && /الكتابة في دفترة متوقفة: عملة الحساب ليست الريال السعودي/.test(txt)
      && J(root.querySelectorAll('[data-fix]').map(n => n.getAttribute('data-fix'))) === J(['acct_fix_currency', 'acct_fix_country', 'acct_fix_vat_rate', 'acct_fix_then'])
      && /EGP/.test(txt) && /Egypt/.test(txt) && /مُلزِم/.test(txt)) || txt.slice(0, 600));
  check('the connection error code is shown from the dictionary', () => /حساب دفترة ليس سعوديًا \(يجب: الريال السعودي/.test(txt) || 'err');
  check('the write policy is read only: «ممنوع» twice, its reason, owner-only note, and no control to change it', () => {
    const pol = root.querySelector('.dft-policy');
    return (pol && (pol.textContent.match(/ممنوع/g) || []).length >= 2 && /مسودات جديدة فقط/.test(pol.textContent) && /لا يُغيَّر هذا من الواجهة/.test(pol.textContent)
      && !pol.querySelector('button') && !pol.querySelector('input')) || (pol && pol.textContent);
  });
  check('org settings: both OFF by default; the owner sees «تفعيل» for each', () =>
    (root.querySelectorAll('.dft-toggle').length === 2 && (root.querySelector('.dft-org').textContent.match(/مطفأ \(الافتراضي\)/g) || []).length === 2
      && !!root.querySelector('[data-act="dft-toggle-auto_draft_on_declaration"]') && !!root.querySelector('[data-act="dft-toggle-purchase_drafts_enabled"]')) || 'toggles');
  root.querySelector('[data-act="dft-toggle-auto_draft_on_declaration"]').click(); await settle(10);
  let tf = modalForm(Dc);
  const tfText = tf ? tf.textContent : '';
  await submit(tf);
  const noReason = calls.filter(x => x[0] === 'policy').length;
  setField(tf, 'reason', 'تجربة المسودة الافتتاحية'); await submit(tf);
  check('turning the opening draft on asks for a written reason (audited, owner only on the server) then sets only that flag through setDaftraWritePolicy', () =>
    (/سجل التدقيق/.test(tfText) && noReason === 0 && J(calls.filter(x => x[0] === 'policy')) === J([['policy', { auto_draft_on_declaration: true }, 'تجربة المسودة الافتتاحية']])
      && !calls.some(x => x[0] === 'save')) || J(calls));
  root.querySelector('[data-act="dft-toggle-purchase_drafts_enabled"]').click(); await settle(10);
  tf = modalForm(Dc); setField(tf, 'reason', ' '); await submit(tf);
  check('no reason, nothing saved', () => calls.filter(x => x[0] === 'policy').length === 1 || J(calls));
  root.querySelector('[data-act="dft-scan"]').click(); await settle(10);
  check('the older-invoice scan: read-only request with an idempotency key; the run is remembered', () =>
    (J(calls.filter(x => x[0] === 'scan')) === J([['scan', {}, 'key']]) && c.w.MarsaOps.dftKit.recallRuns(ORG, ['legacy_scan'])[0].id === RUN) || J(calls));
  const r2 = Dc.createElement('div'); Dc.body.appendChild(r2);
  await c.w.MarsaOps.views.daftra.render(r2, makeApi(c, A, { roleSets: ['finRead', 'billAdmin'] }).api, null); await settle(10);
  check('a non-owner (accounts manager) sees the settings without the toggles; the remembered scan shows its state and error', () =>
    (!r2.querySelector('[data-act="dft-toggle-auto_draft_on_declaration"]') && /يغيّره المالك فقط/.test(r2.textContent) && /فشل/.test(r2.querySelector('.dft-scan').textContent)
      && /300/.test(r2.querySelector('.dft-scan').textContent) && /انتهت مهلة الاتصال/.test(r2.querySelector('.dft-scan').textContent)) || r2.textContent.slice(-500));
  const conn2 = Object.assign({}, conn, { mode: 'mock', account_check: { ok: true, enforced: false } });
  const r3 = Dc.createElement('div'); Dc.body.appendChild(r3);
  await c.w.MarsaOps.views.daftra.render(r3, makeApi(c, Object.assign({}, A, { getDaftraConnection: () => ok({ connection: conn2, counts: {} }) })).api, null); await settle(10);
  check('a mock account with nothing contradicting: «وضع المحاكاة» note, no block', () => (!r3.querySelector('[data-dft="ksa-block"]') && /وضع المحاكاة: لم تُبلغ/.test(r3.textContent)) || 'mock');
}

/* ================================================================ DOM: products */
async function productsFlow() {
  section('DOM: #daftra/products — codes, unmapped list, read-only match, confirmation');
  const c = context(), Dc = c.document, calls = [];
  const items = [
    { item_key: 'item:customs_clearance', service_item: { id: 's1', code: 'customs_clearance', name_ar: 'تخليص جمركي', is_active: true }, mapped: true,
      link: { remote_product_code: '000186', remote_code_norm: '186', external_product_id: '9001', status: 'linked', candidates: [{ external_product_id: '9001', code: '186', name: 'تخليص', exact: true }] } },
    { item_key: 'item:port_charges', service_item: { id: 's2', code: 'port_charges', name_ar: 'أجور الموانئ', is_active: true }, mapped: false,
      link: { remote_product_code: '0042', remote_code_norm: '42', status: 'pending', match_checked_at: '2026-11-11', candidates: [{ external_product_id: '77', code: '42', name: 'أجور', exact: true }, { external_product_id: '78', code: '420', name: 'أخرى', exact: false }] } },
    { item_key: 'item:transportation_cost', service_item: { id: 's3', code: 'transportation_cost', name_ar: 'تكلفة النقل', is_active: true }, mapped: false, link: null }
  ];
  const A = { listDaftraProductMap: () => { calls.push(['list']); return ok({ items, counts: { total: 3, mapped: 1 }, policy: { allow_product_create: false } }); },
    saveDaftraProductCode: (k, code) => { calls.push(['code', k, code]); return ok({ item_key: k }); },
    requestDaftraProductMatch: (keys, o) => { calls.push(['match', keys, o && o.idemKey ? 'key' : null]); return ok({ id: RUN, kind: 'product_match', status: 'queued' }); },
    confirmDaftraProductMapping: (k, ext) => { calls.push(['confirm', k, ext]); return ok({ item_key: k, status: 'linked' }); } };
  const root = Dc.createElement('div'); Dc.body.appendChild(root);
  await c.w.MarsaOps.views.daftra.render(root, makeApi(c, A).api, 'products'); await settle(10);
  check('the tab opens from #daftra/products; counts; the unmapped items are listed by name (they block drafts)', () =>
    (/مربوطة 1 من 3/.test(root.textContent) && root.querySelector('[data-dft="unmapped"]') && /أجور الموانئ، تكلفة النقل/.test(root.querySelector('[data-dft="unmapped"]').textContent)
      && root.querySelector('[aria-selected="true"]').textContent === 'الأصناف بالكود') || root.textContent.slice(0, 400));
  check('states: mapped / code only / no code; only exact candidates of unmapped items can be confirmed', () =>
    (root.querySelector('tr[data-key="item:customs_clearance"]').getAttribute('data-state') === 'mapped' && root.querySelector('tr[data-key="item:port_charges"]').getAttribute('data-state') === 'code_only'
      && root.querySelector('tr[data-key="item:transportation_cost"]').getAttribute('data-state') === 'no_code'
      && root.querySelectorAll('[data-act="dft-confirm"]').length === 1 && !root.querySelector('tr[data-key="item:customs_clearance"] [data-act="dft-confirm"]')) || 'states');
  root.querySelector('tr[data-key="item:transportation_cost"] [data-act="dft-code"]').click(); await settle(5);
  let f = modalForm(Dc); setField(f, 'code', 'bad code!'); await submit(f);
  check('an invalid code is refused locally', () => (!calls.some(x => x[0] === 'code') && /الكود غير صالح/.test(f.textContent)) || f.textContent);
  setField(f, 'code', '٠٠٠٥١'); await submit(f);
  check('the code is saved as typed (western digits) — never a product create', () => J(calls.filter(x => x[0] === 'code')) === J([['code', 'item:transportation_cost', '00051']]) || J(calls));
  root.querySelector('tr[data-key="item:port_charges"] [data-act="dft-confirm"]').click(); await settle(5);
  f = modalForm(Dc);
  check('the confirmation shows the configured code and the Daftra product', () => (/0042/.test(f.textContent) && /77/.test(f.textContent) && /أجور/.test(f.textContent)) || f.textContent);
  await submit(f);
  check('confirm → confirmDaftraProductMapping(item_key, external id)', () => J(calls.filter(x => x[0] === 'confirm')) === J([['confirm', 'item:port_charges', '77']]) || J(calls));
  root.querySelector('[data-act="dft-match-all"]').click(); await settle(10);
  check('«مطابقة كل الأكواد» is a read-only match job for every configured code (keys null) with an idempotency key', () =>
    J(calls.filter(x => x[0] === 'match')) === J([['match', null, 'key']]) || J(calls));
  const r2 = Dc.createElement('div'); Dc.body.appendChild(r2);
  await c.w.MarsaOps.views.daftra.render(r2, makeApi(c, A, { roleSets: ['finRead'] }).api, 'products'); await settle(10);
  check('a finance reader sees the map without set / match / confirm', () => (!r2.querySelector('[data-act="dft-code"]') && !r2.querySelector('[data-act="dft-match-all"]') && !r2.querySelector('[data-act="dft-confirm"]')) || 'reader');
}

/* ================================================================ DOM: fields */
async function fieldsFlow() {
  section('DOM: #daftra/fields — CustomModel map (owner editor) and the read-only dry run');
  const c = context(), Dc = c.document, calls = [];
  const conn = { custom_field_map: { fields: { declaration_no: { key: 'field_1', required: true } }, type_values: {}, port_values: {} } };
  const A = { getDaftraConnection: () => ok({ connection: conn }), listCustomsPorts: () => ok([{ code: 'JED', name_ar: 'ميناء جدة', daftra_value: 'جدة', is_active: true }]),
    saveDaftraCustomFields: m => { calls.push(['save', m]); return ok({}); },
    listTransactions: o => { calls.push(['txs', o.search]); return ok([{ id: TX, ref: 'MRS-2026-000001', clients: { name_ar: 'عميل' } }]); },
    testDaftraCustomFields: id => { calls.push(['dry', id]); return ok({ ok: false, would_send: false, missing: ['bl'], unmapped: [], client_linked: true, account_check: { ok: true },
      values: { declaration_no: '1234', declaration_date: '10/11/2026' }, payload: { invoice_date: '2026-11-11', po_number: 'MRS-2026-000001', draft: 1, custom_fields: { field_1: '1234' } } }); } };
  const root = Dc.createElement('div'); Dc.body.appendChild(root);
  await c.w.MarsaOps.views.daftra.render(root, makeApi(c, A).api, 'fields'); await settle(10);
  check('the map: 8 fields, the configured key + required, the rest «لا يُرسل»; type defaults; port values', () =>
    (root.querySelectorAll('.dft-fields tr[data-field]').length === 8 && /field_1/.test(root.querySelector('tr[data-field="declaration_no"]').textContent)
      && /لا يُرسل/.test(root.querySelector('tr[data-field="bl"]').textContent) && /الافتراضي: وارد/.test(root.textContent) && /جدة/.test(root.querySelector('.dft-values').textContent)) || root.textContent.slice(0, 400));
  root.querySelector('[data-act="dft-cf-edit"]').click(); await settle(5);
  let f = modalForm(Dc);
  setField(f, 'key_bl', 'field_2'); setField(f, 'req_bl', true); setField(f, 'key_goods', 'field_1'); await submit(f);
  check('a key used twice is refused locally', () => (!calls.some(x => x[0] === 'save') && /المفتاح مستخدم لحقل آخر/.test(f.textContent)) || f.textContent);
  setField(f, 'key_goods', ''); setField(f, 'port_JED', 'JEDDAH'); await submit(f);
  check('save → saveDaftraCustomFields with fields / port_values / type_values', () =>
    J(calls.filter(x => x[0] === 'save')) === J([['save', { fields: { declaration_no: { key: 'field_1', required: true }, bl: { key: 'field_2', required: true } }, port_values: { JED: 'JEDDAH' }, type_values: {} }]]) || J(calls));
  const inp = root.querySelector('.dft-dry input[type="search"]'); inp.value = 'MRS'; inp.dispatch('input'); await settle(300);
  root.querySelector('.dft-dry .fin-finder-item').click(); await settle(10);
  check('the dry run: never sent, the missing required field named, the values and the payload (Riyadh date) shown', () => {
    const t = root.querySelector('.dft-dry').textContent;
    return (calls.some(x => x[0] === 'dry' && x[1] === TX) && /لم يُرسل شيء إلى دفترة/.test(t) && /حقول إلزامية ناقصة: رقم البوليصة/.test(t) && /2026-11-11/.test(t) && /field_1/.test(t)) || t;
  });
  const A5 = Object.assign({}, A, { testDaftraCustomFields: id => ok({ ok: true, would_send: false, missing: [], unmapped: [], client_linked: true, account_check: { ok: false, reason: 'currency', currency: 'EGP', country: 'Egypt' },
    values: {}, payload: { invoice_date: '2026-11-11', po_number: 'MRS-2026-000001', draft: 1, custom_fields: {} } }) });
  const r5 = Dc.createElement('div'); Dc.body.appendChild(r5);
  await c.w.MarsaOps.views.daftra.render(r5, makeApi(c, A5).api, 'fields'); await settle(10);
  const inp5 = r5.querySelector('.dft-dry input[type="search"]'); inp5.value = 'MRS'; inp5.dispatch('input'); await settle(300);
  r5.querySelector('.dft-dry .fin-finder-item').click(); await settle(10);
  check('the dry run on a non-KSA account: fields complete but NOT «جاهز» — says sending is stopped', () => {
    const t = r5.querySelector('.dft-dry').textContent;
    return (!/جاهز:/.test(t) && /الإرسال متوقف حتى يُحل ما يلي/.test(t)) || t;
  });
  const r2 = Dc.createElement('div'); Dc.body.appendChild(r2);
  await c.w.MarsaOps.views.daftra.render(r2, makeApi(c, A, { roleSets: ['finRead', 'billAdmin'] }).api, 'fields'); await settle(10);
  check('an accounts manager (bill admin, as on the server): the editor, but no dry run (owner only)', () => (!!r2.querySelector('[data-act="dft-cf-edit"]') && !r2.querySelector('.dft-dry')) || 'owner');
  const r3 = Dc.createElement('div'); Dc.body.appendChild(r3);
  await c.w.MarsaOps.views.daftra.render(r3, makeApi(c, A, { roleSets: ['finRead'] }).api, 'fields'); await settle(10);
  check('a finance reader: neither the editor nor the dry run', () => (!r3.querySelector('[data-act="dft-cf-edit"]') && !r3.querySelector('.dft-dry')) || 'reader');
  const r4 = Dc.createElement('div'); Dc.body.appendChild(r4);
  await c.w.MarsaOps.views.daftra.render(r4, makeApi(c, A, { orgOwner: false }).api, 'fields'); await settle(10);
  check('a BRANCH admin (api.orgOwner false) is not the owner: no dry run (the server would refuse owner_only)', () => !r4.querySelector('.dft-dry') || 'branch admin');
}

/* ================================================================ DOM: import */
async function importFlow() {
  section('DOM: #daftra/import — Daftra request, staged rows, decisions, apply; the tenant CSV file');
  const c = context(), Dc = c.document, calls = [];
  const rows = [
    { id: 'w1', seq: 1, name_ar: 'شركة أ', client_number: 'C1', external_id: '501', proposed_action: 'update_link', match_reason: 'daftra_id', match_client_id: 'c1', match_client_name: 'شركة أ', status: 'pending' },
    { id: 'w2', seq: 2, name_ar: 'شركة ب', external_id: '502', proposed_action: 'review_name', match_reason: 'arabic_name', match_client_id: 'c2', match_client_name: 'شركة ب', status: 'pending', suspended: true },
    { id: 'w3', seq: 3, name_ar: 'شركة ج', external_id: '503', proposed_action: 'conflict', match_reason: 'id_and_code_on_two_clients', match_client_id: 'c3', status: 'conflict' }
  ];
  const A = {
    requestDaftraClientImport: o => { calls.push(['req', o && o.idemKey ? 'key' : null]); return ok({ id: RUN, kind: 'client_import', status: 'queued', created_at: '2026-11-11T09:00:00Z', deduplicated: false }); },
    listDaftraClientImport: (id, f) => { calls.push(['list', id, f]); return ok({ run: { id, kind: 'client_import', status: 'ready', counters: { received: 3, waiting: 3 }, created_at: '2026-11-11' }, rows, total: 3 }); },
    applyDaftraClientImport: (id, p, o) => { calls.push(['apply', id, p, o && o.idemKey ? 'key' : null]); return ok({ waiting: 1 }); },
    importClients: (r, o, k) => { calls.push(['file', r, o, k && k.idemKey ? 'key' : null]); return ok({ id: '44444444-4444-4444-8444-444444444444', kind: 'client_file', status: 'ready' }); }
  };
  const root = Dc.createElement('div'); Dc.body.appendChild(root);
  await c.w.MarsaOps.views.daftra.render(root, makeApi(c, A).api, 'import'); await settle(10);
  check('no run yet: the two sources and «no run remembered»', () => (root.querySelector('[data-act="dft-import-daftra"]') && root.querySelector('[data-act="dft-import-file"]') && /لا توجد تشغيلات محفوظة/.test(root.textContent)) || root.textContent.slice(0, 300));
  root.querySelector('[data-act="dft-import-daftra"]').click(); await settle(20);
  check('request → a read-only import (idempotency key), the run remembered and its staged rows listed', () =>
    (J(calls.filter(x => x[0] === 'req')) === J([['req', 'key']]) && calls.some(x => x[0] === 'list' && x[1] === RUN) && root.querySelectorAll('tr[data-row]').length === 3) || J(calls));
  check('rows: proposal + reason labelled, the name match / conflict rows marked for review, suspended shown, counters', () =>
    (/تحديث ربط قائم/.test(root.textContent) && /بالاسم العربي الموحّد/.test(root.textContent) && /المعرّف والرقم على عميلين مختلفين/.test(root.textContent)
      && root.querySelector('tr[data-row="w2"]').className === 'dft-row-review' && root.querySelector('tr[data-row="w3"]').className === 'dft-row-review'
      && /موقوف في دفترة/.test(root.textContent) && /مستلم 3/.test(root.textContent)) || root.textContent.slice(-800));
  const sel = root.querySelector('select[name="dec_w2"]'); sel.value = 'link'; sel.dispatch('change');
  const sel3 = root.querySelector('select[name="dec_w3"]'); sel3.value = 'skip'; sel3.dispatch('change');
  check('two decisions counted on the button', () => /\(2\)/.test(root.querySelector('[data-act="dft-apply-mine"]').textContent) || root.querySelector('[data-act="dft-apply-mine"]').textContent);
  root.querySelector('[data-act="dft-apply-mine"]').click(); await settle(20);
  check('apply my decisions: link to the matched client / skip; safe proposals NOT applied with them', () =>
    J(calls.filter(x => x[0] === 'apply')) === J([['apply', RUN, { decisions: [{ row_id: 'w2', action: 'link', client_id: 'c2' }, { row_id: 'w3', action: 'skip' }], apply_safe: false }, 'key']]) || J(calls));
  root.querySelector('[data-act="dft-apply-safe"]').click(); await settle(20);
  check('apply the safe proposals', () => J(calls.filter(x => x[0] === 'apply')[1]) === J(['apply', RUN, { apply_safe: true }, 'key']) || J(calls));
  // the tenant file (CSV)
  const csv = '\ufeffرقم العميل,الاسم,الرقم الضريبي,الجوال\n012,شركة س,300000000000003,٠٥٠١٢٣٤٥٦٧\n,,,\n';
  const file = { name: 'clients.csv', arrayBuffer: () => Promise.resolve(new TextEncoder().encode(csv).buffer) };
  const inp = root.querySelector('input[name="client_file"]'); inp.files = [file];
  root.querySelector('[data-act="dft-import-file"]').click(); await settle(40);
  const fc = calls.filter(x => x[0] === 'file');
  check('the CSV is read in the page (UTF-8 BOM, Arabic titles, digits westernised) and staged as a preview with an idempotency key', () =>
    (fc.length === 1 && J(fc[0][1]) === J([{ client_number: '012', name: 'شركة س', vat_number: '300000000000003', phone: '0501234567' }]) && fc[0][2].dry_run === true && fc[0][2].file_name === 'clients.csv' && fc[0][3] === 'key') || J(fc));
  root.querySelector('input[name="client_file"]').files = [{ name: 'clients.pdf', arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }];
  root.querySelector('[data-act="dft-import-file"]').click(); await settle(20);
  check('a file that is not CSV / XLSX is refused locally', () => (calls.filter(x => x[0] === 'file').length === 1 && /CSV أو XLSX/.test(root.querySelector('.dft-im-file').textContent)) || root.querySelector('.dft-im-file').textContent);
}

/* ================================================================ DOM: reviews tab */
async function reviewsFlow() {
  section('DOM: #daftra/reviews — the step-7 review items and their decisions');
  const c = context(), Dc = c.document, calls = [];
  const items = [{ id: 'r1', kind: 'manual_in_daftra', status: 'open', transaction_id: TX, transaction_ref: 'MRS-2026-000001', branch_id: 'b1', operational_ref: 'MRS-2026-000001',
    details: { daftra_number: 'INV-7', daftra_url: 'https://acme.daftra.com/owner/invoices/view/7', add: [{ description: 'TAS1', total_amount: 50 }], remove: [] }, created_at: '2026-11-11' },
    { id: 'r2', kind: 'date_mismatch', status: 'open', transaction_id: TX, branch_id: 'b1', details: { expected: '2026-11-11', stored: '2026-11-10' }, created_at: '2026-11-11' }];
  const A = { listDaftraReviews: f => { calls.push(['list', f]); return ok({ items, total: 2, counts: { manual_in_daftra: 1, date_mismatch: 1 } }); },
    resolveDaftraReview: (id, d, n) => { calls.push(['resolve', id, d, n]); return ok({ id }); } };
  const root = Dc.createElement('div'); Dc.body.appendChild(root);
  await c.w.MarsaOps.views.daftra.render(root, makeApi(c, A, { roleSets: ['finRead', 'finWrite'] }).api, 'reviews'); await settle(10);
  check('open items listed (status open); the manual item says what to add by hand and links to the draft (https, noopener)', () => {
    const a = root.querySelector('tr[data-id="r1"] a[target="_blank"]');
    return (J(calls[0]) === J(['list', { status: 'open', limit: 50, offset: 0 }]) && /أضف في دفترة: TAS1/.test(root.textContent) && a && a.href === 'https://acme.daftra.com/owner/invoices/view/7' && a.getAttribute('rel') === 'noopener noreferrer') || root.textContent.slice(0, 400);
  });
  check('a finance writer may record «نُفّذ يدويًا» but not acknowledge a date mismatch (approver only)', () =>
    (root.querySelector('tr[data-id="r1"] [data-act="dft-review-resolve"]') && !root.querySelector('tr[data-id="r2"] [data-act="dft-review-resolve"]')) || 'roles');
  root.querySelector('tr[data-id="r1"] [data-act="dft-review-resolve"]').click(); await settle(5);
  const f = modalForm(Dc);
  check('the decision dialog offers done_in_daftra only (writer)', () => J(f.querySelector('select[name="decision"]').options.map(o => o.value)) === J(['done_in_daftra']) || 'opts');
  await submit(f);
  check('a note is required', () => !calls.some(x => x[0] === 'resolve') || J(calls));
  setField(f, 'note', 'عدّلت في دفترة'); await submit(f);
  check('resolve → resolveDaftraReview(id, done_in_daftra, note)', () => J(calls.filter(x => x[0] === 'resolve')) === J([['resolve', 'r1', 'done_in_daftra', 'عدّلت في دفترة']]) || J(calls));
}

/* ================================================================ DOM: the transaction strip */
function txData(over) {
  return Object.assign({
    transaction_id: TX, financial_status: 'draft_pending', stale: true, can: { write: true, approve: true },
    connection: { status: 'connected', mode: 'live', sync_enabled: true, allow_draft_update: false, auto_draft_on_declaration: true, purchase_drafts_enabled: true,
      account_check: { ok: false, reason: 'currency', currency: 'EGP', country: 'Egypt', vat_15: false, enforced: true } },
    intents: [
      { id: 'i1', origin: 'opening', operational_ref: 'MRS-2026-000001', purpose: 'final', currency: 'SAR', status: 'draft', sync_state: 'synced', external_invoice_id: '55',
        daftra_number: 'INV-0012', daftra_url: 'https://acme.daftra.com/owner/invoices/view/55', invoice_date: '2026-11-11', lines_total: 0, remote_total: 0, line_count: 1, job_status: 'done',
        lines: [{ id: 'l1', line_ref: 'MRSL-1', description: 'تخليص', state: 'synced', quantity: 1, unit_price: 0, vat_rate: 15, total_amount: 0 }] },
      { id: 'i2', origin: 'marsa', operational_ref: 'MRS-2026-000001/2', purpose: 'interim', currency: 'SAR', status: 'open', sync_state: 'idle', line_count: 1, lines_total: 50,
        last_error_code: 'custom_required', last_error_message: 'missing (fields: declaration_no, bl)', daftra_url: 'javascript:alert(1)',
        lines: [{ id: 'l2', line_ref: 'MRSL-2', description: 'x', state: 'pending_add', total_amount: 50 }] }
    ],
    eligible_charges: [],
    review_items: [
      { id: 'rv1', kind: 'manual_in_daftra', status: 'open', intent_id: 'i1', details: { daftra_number: 'INV-0012', add: [{ line_id: 'l9', description: 'TAS202611', total_amount: 50 }], remove: [] } },
      { id: 'rv2', kind: 'late_charge', status: 'open', intent_id: 'i1' }
    ],
    opening: { intent_id: 'i1', blocked: null },
    invoice_candidates: [
      { id: 'c1', state: 'open', source: 'lookup_number', external_invoice_id: '99', daftra_number: 'INV-0099', client_name: 'عميل دفترة', client_check: 'ok', remote_client_id: '501',
        fields: { declaration_no: 'D1', bl: 'BL1', containers: ['MSKU1234565'] }, match: { declaration: true, bl: true, containers: true, exact: true }, total: 115, currency: 'SAR', invoice_date: '2026-11-01', remote_state: 'issued', po_number: 'MRS-2026-000001' },
      { id: 'c2', state: 'blocked', source: 'lookup_composite', external_invoice_id: '98', daftra_number: 'INV-0098', client_name: 'عميل آخر', client_check: 'conflict', fields: {}, match: {} }
    ],
    purchase_drafts: [{ id: 'p1', trip_id: 'other-trip', reference: 'MRSP-ABCDEF123456', status: 'draft', daftra_number: 'PO-1', daftra_url: 'https://acme.daftra.com/owner/purchase_invoices/view/3', amount: 500, currency: 'SAR' }]
  }, over || {});
}
async function txFlow() {
  section('DOM: the transaction billing strip — Daftra link, HF5 / KSA, errors, refresh, opening, invoice link, reviews, purchase drafts');
  const c = context(), Dc = c.document, calls = [];
  let data = txData();
  const A = {
    txBilling: id => { calls.push(['tb', id]); return ok(data); },
    refreshTxDaftra: id => { calls.push(['refresh', id]); return ok({ transaction_id: id, enqueued: 1, jobs: [] }); },
    retryDaftraOpening: (id, o) => { calls.push(['retry', id, o && o.idemKey ? 'key' : null]); return ok({ status: 'blocked', reason: 'client_not_linked' }); },
    requestDaftraInvoiceLookup: (id, p, o) => { calls.push(['lookup', id, p, o && o.idemKey ? 'key' : null]); return ok({ transaction_id: id, mode: p.mode, job: {} }); },
    confirmInvoiceLink: (id, p, o) => { calls.push(['link', id, p, o && o.idemKey ? 'key' : null]); return ok({ intent: { id: 'i3' } }); },
    rejectInvoiceCandidate: (id, n) => { calls.push(['reject', id, n]); return ok({}); },
    resolveDaftraReview: (id, d, n) => { calls.push(['resolve', id, d, n]); return ok({}); },
    listDeclarations: () => ok([{ declaration_no: 'D1', status: 'accepted' }, { declaration_no: 'D0', status: 'cancelled' }]),
    listBLs: () => ok([{ bl_number: 'BL1' }]),
    listMovements: () => ok([{ trip_id: TRIP, party_type: 'supplier', party_name: 'ناقل', transport_order_no: 'TASTO1', movement_status: 'delivered', container_no: 'MSKU1234565' },
      { trip_id: 'direct-trip', party_type: 'direct', movement_status: 'delivered' }, { trip_id: 'other-trip', party_type: 'company', movement_status: 'delivered' }]),
    requestDaftraPurchaseDraft: (id, o) => { calls.push(['purchase', id, o && o.idemKey ? 'key' : null]); return ok({ id: 'p2', deduplicated: false }); },
    requestBillingPush: () => { calls.push(['push']); return ok({}); }
  };
  const sec = c.w.MarsaOps.txSections.filter(s => s.id === 'bill-invoices')[0];
  const tx = { id: TX, ref: 'MRS-2026-000001', branch_id: 'b1', operational_status: 'in_progress', clients: { name_ar: 'عميل مرسى' }, bl_number: 'BL1', cargo_unit_type: 'container', containers: [{ container_no: 'MSKU1234565' }] };
  const h = Dc.createElement('div'); Dc.body.appendChild(h);
  const M = makeApi(c, A);
  await sec.render(h, tx, M.api); await settle(20);
  check('the KSA banner (the reason) and the HF5 line are shown', () =>
    (!!h.querySelector('[data-bill="ksa-banner"]') && /عملة الحساب ليست الريال السعودي/.test(h.querySelector('[data-bill="ksa-banner"]').textContent) && !!h.querySelector('[data-bill="hf5-line"]')) || h.textContent.slice(0, 400));
  check('the opening draft: origin «افتتاحية», the Daftra link (https, new tab, noopener), the Riyadh invoice date', () => {
    const a = h.querySelector('tr[data-intent="i1"] [data-act="bill-daftra-url"]');
    return (a && a.href === 'https://acme.daftra.com/owner/invoices/view/55' && a.getAttribute('rel') === 'noopener noreferrer' && a.getAttribute('target') === '_blank'
      && /افتتاحية/.test(h.querySelector('tr[data-intent="i1"]').textContent) && /تاريخ الفاتورة 2026-11-11 \(الرياض\)/.test(h.textContent)) || 'link';
  });
  check('a non-https daftra_url is never a link', () => !h.querySelector('tr[data-intent="i2"] [data-act="bill-daftra-url"]') || 'unsafe');
  check('HF5: the existing draft is never pushed again (button disabled, reason); the other intent blocked by the KSA guard', () => {
    const p1 = h.querySelector('tr[data-intent="i1"] [data-act="bill-push"]'), p2 = h.querySelector('tr[data-intent="i2"] [data-act="bill-push"]');
    return (p1 && p1.disabled && /وتعديلها ممنوع/.test(p1.getAttribute('title')) && p2 && p2.disabled && /ليس سعوديًا/.test(p2.getAttribute('title'))) || [p1 && p1.getAttribute('title'), p2 && p2.getAttribute('title')];
  });
  check('the worker error code is shown from the dictionary with the field names', () =>
    /خطأ دفترة: حقول دفترة الإضافية المطلوبة ناقصة: رقم البيان، رقم البوليصة/.test(h.querySelector('tr[data-intent="i2"]').textContent) || h.querySelector('tr[data-intent="i2"]').textContent);
  check('stale → ONE read-only refresh_tx_daftra on open, with a note', () =>
    (calls.filter(x => x[0] === 'refresh').length === 1 && !!h.querySelector('[data-bill="refresh-sent"]')) || J(calls));
  const h2 = Dc.createElement('div'); Dc.body.appendChild(h2);
  await sec.render(h2, tx, M.api); await settle(20);
  check('re-rendering the same transaction within 15 minutes does not ask again', () => calls.filter(x => x[0] === 'refresh').length === 1 || J(calls));
  check('the opening block: requested with its ref; no retry while it exists', () =>
    (h.querySelector('[data-opening="queued"]') && /طُلبت مسودة افتتاحية صفرية \(MRS-2026-000001\)/.test(h.textContent) && !h.querySelector('[data-act="dft-opening-retry"]')) || 'opening');
  check('step-7 review items in their own block (the manual lines), the G5 late charge still in the G5 list', () =>
    (h.querySelector('.dft-tx-reviews') && /أضف في دفترة: TAS202611/.test(h.querySelector('.dft-tx-reviews').textContent) && !/مبلغ لاحق/.test(h.querySelector('.dft-tx-reviews').textContent)
      && !!h.querySelector('.bill-tx-review [data-review="rv2"]')) || 'reviews');
  h.querySelector('.dft-tx-reviews [data-act="dft-review-resolve"]').click(); await settle(5);
  let f = modalForm(Dc);
  check('writer + approver: done_in_daftra and dismiss offered', () => J(f.querySelector('select[name="decision"]').options.map(o => o.value)) === J(['done_in_daftra', 'dismiss']) || 'opts');
  setField(f, 'note', 'تم'); await submit(f);
  check('resolve from the strip → resolveDaftraReview and a refresh', () => (J(calls.filter(x => x[0] === 'resolve')) === J([['resolve', 'rv1', 'done_in_daftra', 'تم']]) && M.log.refresh >= 1) || J(calls));
  // candidates
  check('candidates: the blocked one says another client and has no link button; the open one can be linked', () =>
    (!h.querySelector('tr[data-cand="c2"] [data-act="dft-cand-confirm"]') && /عميل مختلف — مرفوضة/.test(h.querySelector('tr[data-cand="c2"]').textContent)
      && !!h.querySelector('tr[data-cand="c1"] [data-act="dft-cand-confirm"]')) || 'cands');
  h.querySelector('tr[data-cand="c1"] [data-act="dft-cand-confirm"]').click(); await settle(20);
  f = modalForm(Dc);
  check('the visual confirmation: Marsa and Daftra side by side (client, declaration, B/L, containers) with the match of each', () => {
    const t = f.querySelector('.dft-cmp-table');
    const row = n => t.querySelector('tr[data-cmp="' + n + '"]');
    return (t && /عميل مرسى/.test(row('client').textContent) && /عميل دفترة/.test(row('client').textContent) && row('client').getAttribute('data-check') === 'ok'
      && /D1/.test(row('decl').textContent) && !/D0/.test(row('decl').textContent) && row('bl').getAttribute('data-check') === 'ok' && row('ctr').getAttribute('data-check') === 'ok'
      && /MSKU1234565/.test(row('ctr').textContent) && /115\.00 SAR/.test(row('total').textContent)) || (t && t.textContent);
  });
  setField(f, 'confirm_number', 'INV-0098'); await submit(f);
  check('a number that is not the invoice shown is refused before any call', () => (!calls.some(x => x[0] === 'link') && /لا يطابق رقم الفاتورة المعروضة/.test(f.textContent)) || J(calls));
  setField(f, 'confirm_number', 'inv0099'); await submit(f);
  check('the right number (any case / separators) → confirmInvoiceLink(candidate, {confirm_number}, key)', () =>
    J(calls.filter(x => x[0] === 'link')) === J([['link', 'c1', { confirm_number: 'inv0099' }, 'key']]) || J(calls));
  h.querySelector('[data-act="dft-find-composite"]').click(); await settle(10);
  check('the composite look-up is a read-only request (declaration + B/L + containers on the server)', () => J(calls.filter(x => x[0] === 'lookup')) === J([['lookup', TX, { mode: 'composite' }, 'key']]) || J(calls));
  h.querySelector('[data-act="dft-find-number"]').click(); await settle(5);
  f = modalForm(Dc); setField(f, 'number', ' INV-٠٠٧ '); await submit(f);
  check('the number look-up sends the number (western digits)', () => J(calls.filter(x => x[0] === 'lookup')[1]) === J(['lookup', TX, { mode: 'number', number: 'INV-007' }, 'key']) || J(calls));
  // purchase drafts
  check('purchase drafts: the existing one with its Daftra link; only the supplier / company trip without a draft is offered', () =>
    (h.querySelector('tr[data-purchase="p1"] a[target="_blank"]') && h.querySelectorAll('.dft-trip').length === 1 && h.querySelector('.dft-trip').getAttribute('data-trip') === TRIP
      && /TASTO1/.test(h.querySelector('.dft-trip').textContent)) || h.querySelectorAll('.dft-trip').length);
  h.querySelector('[data-act="dft-purchase"]').click(); await settle(10);
  check('request → requestDaftraPurchaseDraft(trip, key)', () => J(calls.filter(x => x[0] === 'purchase')) === J([['purchase', TRIP, 'key']]) || J(calls));
  // opening blocked + retry
  data = txData({ stale: false, opening: { intent_id: null, blocked: { reason: 'client_not_linked' } }, invoice_candidates: [], purchase_drafts: [],
    connection: Object.assign({}, txData().connection, { purchase_drafts_enabled: false, account_check: { ok: true } }) });
  const h3 = Dc.createElement('div'); Dc.body.appendChild(h3);
  const M3 = makeApi(c, A);
  await sec.render(h3, tx, M3.api); await settle(20);
  check('a blocked opening draft shows the reason, that the approval stands, and a retry', () =>
    (h3.querySelector('[data-opening="blocked"]') && /العميل غير مربوط بعميل دفترة/.test(h3.textContent) && /لا يلغي اعتماد البيان/.test(h3.textContent) && h3.querySelector('[data-act="dft-opening-retry"]')
      && !h3.querySelector('[data-bill="ksa-banner"]') && !h3.querySelector('.dft-purchase')) || h3.textContent.slice(0, 500));
  h3.querySelector('[data-act="dft-opening-retry"]').click(); await settle(10);
  check('retry → retryDaftraOpening(tx, key); a still-blocked answer is explained', () =>
    (J(calls.filter(x => x[0] === 'retry')) === J([['retry', TX, 'key']]) && M3.log.toasts.some(t => t[0] === 'warning' && /ما زالت متوقفة: العميل غير مربوط/.test(t[1]))) || J(M3.log.toasts));
  // a reader
  const h4 = Dc.createElement('div'); Dc.body.appendChild(h4);
  await sec.render(h4, tx, makeApi(c, A, { roleSets: ['finRead'] }).api); await settle(20);
  check('a finance reader: no look-up, no retry, no link / reject buttons', () =>
    (!h4.querySelector('[data-act="dft-find-number"]') && !h4.querySelector('[data-act="dft-opening-retry"]') && !h4.querySelector('[data-act="dft-cand-confirm"]')) || 'reader');
}

/* ================================================================ DOM: supplier search + opening note */
async function supplierAndNoteFlow() {
  section('DOM: the trip supplier search (movements) and the opening-draft note (declaration screens)');
  const c = context(), Dc = c.document, calls = [];
  const K = c.w.MarsaOps.dftKit;
  const A = { listDaftraSupplierLinks: () => { calls.push(['links']); return ok({ items: [] }); },
    getDaftraRun: id => { calls.push(['run', id]); return ok({ id, status: 'done', result: { suppliers: [{ external_supplier_id: '700', name: 'ناقل', supplier_number: 'S-1' }, { external_supplier_id: '701', name: 'ناقل', supplier_number: 'S-2' }], exact_match: false } }); },
    requestDaftraSupplierSearch: (p, o) => { calls.push(['search', p, o && o.idemKey ? 'key' : null]); return ok({ id: RUN, kind: 'supplier_search' }); } };
  const M = makeApi(c, A);
  const tx = { id: TX, branch_id: 'b1' };
  check('no button for a direct trip, a cancelled trip, or without a transport / finance writer role', () =>
    (K.tripActions(M.api, tx, { trip_id: TRIP, party_type: 'direct' }).length === 0 && K.tripActions(M.api, tx, { trip_id: TRIP, party_type: 'supplier', movement_status: 'cancelled' }).length === 0
      && K.tripActions(makeApi(c, A, { roleSets: ['finRead'] }).api, tx, { trip_id: TRIP, party_type: 'supplier' }).length === 0) || 'gate');
  const b = K.tripActions(M.api, tx, { trip_id: TRIP, party_type: 'company', party_name: 'ناقل', transport_order_no: 'TASTO9' })[0];
  Dc.body.appendChild(b); b.click(); await settle(10);
  let f = modalForm(Dc);
  check('the dialog: not linked yet, the party and order shown, the query prefilled with the party name', () =>
    (f && /غير مربوط بمورد دفترة بعد/.test(f.textContent) && /TASTO9/.test(f.textContent) && f.querySelector('[name="q"]').value === 'ناقل') || (f && f.textContent));
  await submit(f);
  check('search → requestDaftraSupplierSearch({trip_id, q}, key) — read only; the run is remembered for this trip', () =>
    (J(calls.filter(x => x[0] === 'search')) === J([['search', { trip_id: TRIP, q: 'ناقل' }, 'key']]) && c.storage.getItem('marsa.dft.sup.' + TRIP) === RUN) || J(calls));
  b.click(); await settle(10);
  f = modalForm(Dc);
  check('opening it again shows the last results and why no link was saved (two exact names)', () =>
    (calls.some(x => x[0] === 'run' && x[1] === RUN) && /نتائج آخر بحث \(2\)/.test(f.textContent) && /لا تطابق تام واحد/.test(f.textContent)) || (f && f.textContent));
  // opening note
  const notes = [];
  const A2 = { txBilling: id => ok(id === 'q' ? { connection: { auto_draft_on_declaration: true }, opening: { intent_id: 'i1' }, intents: [{ id: 'i1', operational_ref: 'R1' }] }
    : id === 'b' ? { connection: { auto_draft_on_declaration: true }, opening: { blocked: { reason: 'declaration_no' } }, intents: [] }
      : id === 'off' ? { connection: { auto_draft_on_declaration: false }, opening: {}, intents: [] } : null).then(r => id === 'err' ? { data: null, error: { code: 'MRS_FORBIDDEN', field: 'finance' } } : r) };
  ['q', 'b', 'off', 'err'].forEach(id => notes.push(K.openingNote(A2, id)));
  await settle(10);
  check('the note: requested / blocked with the reason (the approval stands) / OFF / hidden when finance is refused', () =>
    (notes[0].textContent === 'دفترة: طُلبت مسودة افتتاحية صفرية لهذه المعاملة.' && /لا يوجد رقم بيان\. اعتماد البيان قائم/.test(notes[1].textContent)
      && /مطفأ/.test(notes[2].textContent) && notes[3].hidden === true && notes[3].textContent === '') || notes.map(n => n.textContent));
}

/* ================================================================ wiring */
section('wiring: admin.html, ocr.html, sw.js, bill.css, the declaration / movement hooks');
check('admin.html: i18n/dft.js after i18n.js; xlsx-lite before the views; dft-kit after the ops kit; dft-settings before daftra.js; all before admin.js', () => {
  const i = s => ADMIN_HTML.indexOf(s);
  return (i('assets/i18n/dft.js') > i('assets/js/i18n.js') && i('assets/js/xlsx-lite.js') > 0 && i('assets/js/bill/dft-kit.js') > i('assets/js/ops/alerts.js')
    && i('assets/js/bill/dft-kit.js') < i('assets/js/ops/tx-legacy.js') && i('assets/js/bill/dft-settings.js') > i('assets/js/bill/billing.js')
    && i('assets/js/bill/dft-settings.js') < i('assets/js/bill/daftra.js') && i('assets/js/admin.js') > i('assets/js/bill/tx-bill.js')) || 'order';
});
check('ocr.html: i18n/dft.js and bill/dft-kit.js before decl-review.js', () =>
  (OCR_HTML.indexOf('assets/i18n/dft.js') > OCR_HTML.indexOf('assets/js/i18n.js') && OCR_HTML.indexOf('assets/js/bill/dft-kit.js') > 0
    && OCR_HTML.indexOf('assets/js/bill/dft-kit.js') < OCR_HTML.indexOf('assets/js/decl-review.js')) || 'ocr');
check('sw.js: VERSION bumped past step 6 (2026-11-22.4) and the new files precached', () => {
  const v = (/var VERSION = '([^']+)'/.exec(SW) || [])[1];
  return (v && v > '2026-11-22.4' && ['assets/js/bill/dft-kit.js', 'assets/js/bill/dft-settings.js', 'assets/i18n/dft.js', 'assets/js/xlsx-lite.js'].every(f => SW.includes("'" + f + "'"))) || v;
});
check('bill.css: the step-7 rules only add dft- classes, wrap on a phone (no fixed width over 375 px)', () => {
  const part = CSS.slice(CSS.indexOf('/* ---- legacy step 7'), CSS.indexOf('@media print'));
  const sels = part.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{/g, '').match(/(^|\})\s*([^{}@]+)\{/g) || [];
  const badSel = sels.map(s => s.replace(/^\}?\s*/, '').replace(/\{$/, '').trim()).filter(Boolean)
    .filter(s => s.split(',').some(x => !/\.dft-/.test(x) && !/^\.bill-(check-text|pre)$/.test(x.trim())));
  return (!badSel.length && !/(^|[^-])width:\s*\d{3,}px/m.test(part) && /@media \(max-width: 767\.98px\)/.test(part) && /flex-wrap: wrap/.test(part)) || badSel;
});
check('hooks: the movements row asks dftKit.tripActions; the declarations card and decl-review ask dftKit.openingNote (finance only)', () =>
  (/if \(OPS\.dftKit\) acts = acts\.concat\(OPS\.dftKit\.tripActions\(api, tx, m\)\);/.test(TXLEGACY)
    && /OPS\.dftKit && api\.can\('finRead', tx\.branch_id\) \? OPS\.dftKit\.openingNote\(api, tx\.id\) : null/.test(TXSECT)
    && /DK\.openingNote\(API, S\.route\.tx/.test(DECL)) || 'hooks');

/* ================================================================ review regressions */
async function reviewFlow() {
  section('DOM: review regressions — import paging + org scope, partial hints, supplier unlink, empty opening bullet, codes');
  const c = context(), Dc = c.document, K = c.w.MarsaOps.dftKit, calls = [];
  // import: 450 rows → pages of 200; an org switch resets the run
  const RUN2 = '55555555-5555-4555-8555-555555555555';
  const page = off => Array.from({ length: Math.max(0, Math.min(200, 450 - off)) }, (x, i) => ({ id: 'w' + (off + i), seq: off + i + 1, name_ar: 'عميل ' + (off + i), proposed_action: 'review_name',
    match_client_id: 'c' + i, status: 'pending' }));
  const A = { listDaftraClientImport: (id, f2) => { calls.push(['list', id, f2]); return ok({ run: { id, kind: 'client_file', status: 'ready', counters: {}, created_at: '2026-11-11' }, rows: page(f2.offset || 0), total: 450 }); } };
  K.rememberRun(ORG, { id: RUN2, kind: 'client_file', status: 'ready' });
  const root = Dc.createElement('div'); Dc.body.appendChild(root);
  await c.w.MarsaOps.views.daftra.render(root, makeApi(c, A).api, 'import'); await settle(10);
  const first = calls.filter(x => x[0] === 'list')[0];
  const pager = root.querySelector('.fin-pager');
  check('import rows are paged (limit 200 + offset; total 450): a pager is shown', () => (first && first[2].limit === 200 && first[2].offset === 0 && root.querySelectorAll('tr[data-row]').length === 200 && !!pager) || J({ first, n: root.querySelectorAll('tr[data-row]').length }));
  c.w.MarsaOps.dftSettings._state.IM.offset = 400;
  const r2 = Dc.createElement('div'); Dc.body.appendChild(r2);
  await c.w.MarsaOps.views.daftra.render(r2, makeApi(c, A).api, 'import'); await settle(10);
  check('the last page (offset 400) lists rows 401–450, each with a decision control', () => {
    const l = calls.filter(x => x[0] === 'list').pop();
    return (l[2].offset === 400 && r2.querySelectorAll('tr[data-row]').length === 50 && r2.querySelectorAll('tr[data-row] select').length === 50) || J(l);
  });
  const n0 = calls.length;
  const r3 = Dc.createElement('div'); Dc.body.appendChild(r3);
  await c.w.MarsaOps.views.daftra.render(r3, makeApi(c, A, { orgId: 'org-2' }).api, 'import'); await settle(10);
  check('another org: the previous org\'s run is never opened (no list call, state reset)', () =>
    (calls.length === n0 && c.w.MarsaOps.dftSettings._state.IM.run === null && c.w.MarsaOps.dftSettings._state.IM.org === 'org-2') || J(calls.slice(n0)));
  // partial candidates
  const B2 = { txBilling: () => ok(txData({ stale: false, invoice_candidates: [{ id: 'c9', state: 'partial', source: 'lookup_composite', external_invoice_id: '91', daftra_number: 'INV-0091',
    client_name: 'عميل دفترة', fields: {}, match: { declaration: true, bl: true, containers: false, exact: false } }] })),
    listDeclarations: () => ok([]), listBLs: () => ok([]), listMovements: () => ok([]), refreshTxDaftra: () => ok({}) };
  const sec = c.w.MarsaOps.txSections.filter(x => x.id === 'bill-invoices')[0];
  const h = Dc.createElement('div'); Dc.body.appendChild(h);
  await sec.render(h, { id: TX, ref: 'MRS-2026-000001', branch_id: 'b1', operational_status: 'in_progress', clients: { name_ar: 'x' }, containers: [] }, makeApi(c, B2).api); await settle(20);
  check('a partial composite hint: what differs, no link / reject button', () => {
    const tr = h.querySelector('tr[data-cand="c9"]');
    return (tr && /تطابق جزئي/.test(tr.textContent) && /مختلف: الحاويات/.test(tr.textContent) && !tr.querySelector('[data-act="dft-cand-confirm"]') && !tr.querySelector('[data-act="dft-cand-reject"]')) || (tr && tr.textContent);
  });
  // supplier dialog: unlink for a bill admin, the key hint
  const S2 = [];
  const C = { listDaftraSupplierLinks: () => ok({ items: [{ id: 'L1', party_id: 'P1', name: 'ناقل', external_supplier_id: '700', status: 'linked' }] }),
    unlinkDaftraSupplier: (id, why) => { S2.push([id, why]); return ok({ id, status: 'unlinked' }); } };
  K.supplierDialog(makeApi(c, C).api, { id: TX, branch_id: 'b1' }, { trip_id: TRIP, carrier_id: 'P1', party_type: 'company', party_name: 'ناقل' }); await settle(10);
  const dlg = modalForm(Dc);
  const ub = dlg && dlg.querySelector('[data-act="dft-sup-unlink"]');
  check('the supplier dialog: linked, a bill admin can unlink (reason required), the link is keyed on the party name', () =>
    (ub && /اسم جهة النقل «ناقل»/.test(dlg.textContent)) || (dlg && dlg.textContent));
  if (ub) { ub.click(); await settle(5); const uf = modalForm(Dc); await submit(uf); const none = S2.length; setField(uf, 'reason', 'ربط خاطئ'); await submit(uf);
    check('unlink → unlinkDaftraSupplier(link, reason) only with a reason', () => (none === 0 && J(S2) === J([['L1', 'ربط خاطئ']])) || J(S2)); }
  // opening note host
  const host = Dc.createElement('li'); host.hidden = true;
  host.appendChild(K.openingNote(makeApi(c, { txBilling: () => Promise.resolve({ data: null, error: { code: 'MRS_FORBIDDEN' } }) }).api, TX, { host })); await settle(10);
  const host2 = Dc.createElement('li'); host2.hidden = true;
  host2.appendChild(K.openingNote(makeApi(c, { txBilling: () => ok(txData({ opening: { intent_id: 'i1', blocked: null } })) }).api, TX, { host: host2 })); await settle(10);
  check('the opening note keeps its host <li> hidden when there is nothing to say (non-finance), and shows it with the text', () =>
    (host.hidden === true && host2.hidden === false && /\S/.test(host2.textContent)) || J([host.hidden, host2.hidden, host2.textContent]));
  check('decl-review.js hands its <li> to openingNote as the host (no empty bullet on ocr.html)', () => /liD\.hidden = true;[\s\S]{0,200}host: liD/.test(DECL) || 'decl');
  check('codes: #000186 = 000 186 = 186 (legacy normalizeDaftraProductCode_); the new error codes have their text and field labels', () =>
    (K.codeNorm('#000186') === '186' && K.codeNorm(' 000 186 ') === '186' && /لم يُرسل شيء/.test(K.errorText({ code: 'setting_disabled', message: 'x (fields: purchase_disabled)' }))
      && /مسودات المشتريات مطفأة/.test(K.errorText({ code: 'setting_disabled', message: 'x (fields: purchase_disabled)' }))
      && /ضريبة غير صفرية/.test(K.errorText({ code: 'purchase_review', message: 'x (fields: tax_nonzero)' }))) || K.errorText({ code: 'setting_disabled', message: 'x (fields: purchase_disabled)' }));
}

(async function () {
  billingJobsStatic();
  await connectionFlow();
  await productsFlow();
  await fieldsFlow();
  await importFlow();
  await reviewsFlow();
  await txFlow();
  await supplierAndNoteFlow();
  await reviewFlow();
  await settle(20);
  console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.log('FAILED: ' + (e && e.stack || e)); process.exit(1); });
