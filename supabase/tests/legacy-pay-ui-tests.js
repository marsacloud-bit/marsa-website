#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy step 6 UI tests: assets/js/fin/payments.js (#payments register, form, detail), assets/js/fin/custody.js
  (#custody + the client-page balance), assets/js/fin/draft.js (MarsaDraft), the payments section of assets/js/fin/tx-fin.js,
  assets/i18n/pay.js and the page wiring (admin.html / admin.js / app-shell.js / sw.js / pay.css). Pure Node, no database, no
  network, no dependencies (vm + window shim + supabase/tests/lib/fake-dom.js; the real MarsaOps.ui / finUi kits are loaded).

  Covers: classic-script wrapper + ES5 + no innerHTML; the 'pay' dictionary (ar = en keys, {vars} parity, every literal key and
  every dynamic family); the contract with 20261122000100 / 20261117000100 (methods, funding sources, the funding × method
  rule order of app.fin_funding_check, the bank reference pattern, the attachment limits, document roles, the supa.js wrappers
  called); pure helpers (matrix, references, payer modes, allocation totals, payload single / shared / received, local
  validation, server error → field, duplicate explanations, correct-mode state, locks, AI suggestion fills only empty fields,
  Riyadh today, date-only display never shifted); MarsaDraft (per user, TTL, storage that throws); custody helpers (max,
  validation, payload); DOM flows: register filters + scroll box, the payment form (funding drives the methods, inline
  reference validation, duplicates explained with the earlier transaction, typed uploads + bundle payload + idempotency key,
  the MRS_CONFIRM_INVOICE_REUSE confirm, shared totals, draft restored after a refresh, Claude reading fills only empty fields
  and suggests the unique transaction without saving), the detail (four eyes, approve / reject / void with reason, locks),
  the transaction section (share only, add payment pre-linked), the custody page (deduction max, local refusal, save, void
  of a deposit refused with a clear message) and the client-page balance.

  usage:  node supabase/tests/legacy-pay-ui-tests.js [/path/to/marsa-website] [--quiet]
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
  pay: rd('assets/js/fin/payments.js'), cu: rd('assets/js/fin/custody.js'), draft: rd('assets/js/fin/draft.js'), dict: rd('assets/i18n/pay.js'),
  txfin: rd('assets/js/fin/tx-fin.js'), payai: rd('assets/js/fin/pay-ai.js'), alerts: rd('assets/js/ops/alerts.js'), inv: rd('assets/js/fin/invoices.js'),
  norm: rd('assets/js/legacy-norm.js')
};
const MIG = rd('supabase/migrations/20261122000100_legacy_pay.sql');
const CORE = rd('supabase/migrations/20261117000100_legacy_core.sql');
const SUPA = rd('assets/js/supa.js');
const ADMIN_HTML = rd('admin.html'), ADMIN_JS = rd('assets/js/admin.js'), SHELL = rd('assets/js/app-shell.js'), SW = rd('sw.js'), CSS = rd('assets/css/pages/pay.css');
const I18NJS = rd('assets/js/i18n.js');

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
    removeItem(k) { if (o && o.throws) throw new Error('blocked'); delete m[k]; },
    _m: m
  };
}
function context(o) {
  o = o || {};
  const { document } = makeDom();
  const storage = o.storage || makeStorage();
  const w = { MarsaI18n: I18N, document, sessionStorage: storage, open: () => null, confirm: () => true };
  w.window = w;
  class FileReader { readAsDataURL(f) { setTimeout(() => { this.result = 'data:' + f.type + ';base64,QUJD' + f.name; this.onload && this.onload(); }, 0); } }
  const c = { window: w, document, sessionStorage: storage, location: { hash: '' }, FileReader, Intl, Date, Math, String, Object, Array, JSON, Number, RegExp, parseInt, parseFloat,
    isFinite, isNaN, Promise, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, Error, Event: function (t) { this.type = t; } };
  vm.createContext(c);
  ['dict', 'norm', 'alerts', 'inv', 'payai', 'draft', 'pay', 'cu', 'txfin'].forEach(k => vm.runInContext(SRC[k], c, { filename: k + '.js' }));
  return { document, w, storage };
}
const base = context();
const P = base.w.MarsaOps.finPay.pure, CP = base.w.MarsaOps.finCustody.pure, DR = base.w.MarsaDraft, PA = base.w.MarsaPayAi;

/* ================================================================ static */
section('static: classic scripts, ES5 only, no innerHTML, compile');
const NEW_JS = { 'assets/js/fin/payments.js': SRC.pay, 'assets/js/fin/custody.js': SRC.cu, 'assets/js/fin/draft.js': SRC.draft, 'assets/i18n/pay.js': SRC.dict };
Object.keys(NEW_JS).forEach(f => {
  const s = NEW_JS[f].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  check(f + ': IIFE + strict, ES5 only (no let/const/arrow/template/class), no innerHTML', () =>
    (/^\(function \(/m.test(s) && /'use strict';/.test(s) && !/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s) && !/\bclass\s+\w/.test(s)
      && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(s)) || 'not ES5 / uses HTML');
});
check('tx-fin.js: still ES5 and no innerHTML after the payments section', () => {
  const s = SRC.txfin.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  return (!/\b(let|const)\s/.test(s) && !/=>/.test(s) && !/`/.test(s) && !/innerHTML/.test(s)) || 'tx-fin';
});
check('every new / changed file compiles', () => { Object.keys(NEW_JS).concat(['assets/js/fin/tx-fin.js', 'assets/js/admin.js', 'assets/js/app-shell.js', 'assets/js/supa.js', 'sw.js']).forEach(f => new vm.Script(rd(f), { filename: f })); return true; });
check('the views and the section are registered (payments, custody, fin-payments order 78, clientSections custody)', () => {
  const O = base.w.MarsaOps;
  return (O.views.payments && O.views.payments.allow === 'finRead' && O.views.custody && O.views.custody.allow === 'finRead'
    && O.txSections.some(s => s.id === 'fin-payments' && s.order === 78) && O.clientSections.some(s => s.id === 'custody')) || Object.keys(O.views);
});
check('AI never saves / approves: recordPaymentBundle and reviewPayment are never called from the Claude reading code', () => {
  const ai = SRC.pay.slice(SRC.pay.indexOf('function aiSection()'), SRC.pay.indexOf('function showResult('));
  return (ai.length > 1000 && !/recordPaymentBundle|reviewPayment|correctPayment|voidPayment/.test(ai) && /PA\.merge\(readings\)/.test(ai) && /applySuggestion\(state, aiResult\.suggestion/.test(ai)) || 'ai';
});
check('review: approve / reject offered only when the server says four_eyes.can_review (no client-side admin exception)', () =>
  (/if \(fe\.can_review === true\) \{/.test(SRC.pay) && !/isAdmin|'admin'/.test(SRC.pay.slice(SRC.pay.indexOf('function renderDetail'), SRC.pay.indexOf('function allocLabel')))) || 'four eyes');
check('dates: "today" is Asia/Riyadh (UTC+3) and a payment date is formatted in UTC from its Y-M-D (never shifted)', () =>
  (/function riyadhToday\(now\) \{ return new Date\(\(now == null \? Date\.now\(\) : \+now\) \+ 3 \* 3600000\)/.test(SRC.pay) && /timeZone: 'UTC'/.test(SRC.pay) && /timeZone: 'Asia\/Riyadh'/.test(SRC.pay)) || 'dates');

/* ================================================================ dictionary */
section('dictionary (namespace pay) and the fintx payment strings');
const AR = Object.keys(dicts.ar).filter(k => k.startsWith('pay.')), EN = Object.keys(dicts.en).filter(k => k.startsWith('pay.'));
check('ar and en have the same keys', () => (AR.length > 380 && AR.length === EN.length && AR.every(k => dicts.en[k] != null)) || [AR.length, EN.length, AR.filter(k => dicts.en[k] == null), EN.filter(k => dicts.ar[k] == null)]);
check('no empty strings', () => AR.concat(EN).every(k => String(dicts.ar[k] || dicts.en[k]).trim()) || 'empty');
check('the {vars} of each string are the same in ar and en', () => {
  const vs = s => (String(s).match(/\{[a-z_]+\}/g) || []).sort().join();
  const bad = AR.filter(k => vs(dicts.ar[k]) !== vs(dicts.en[k]));
  return !bad.length || bad;
});
const has = k => dicts.ar['pay.' + k] != null && dicts.en['pay.' + k] != null;
check('every literal T(\'key\') of payments.js exists (pay.<k>), and of custody.js (pay.cu_<k>)', () => {
  const miss = [];
  let m; const re = /\bT\('([a-z][a-z0-9_]*)'(?=[,)])/g;
  while ((m = re.exec(SRC.pay))) if (!has(m[1])) miss.push(m[1]);
  const re2 = /\bT\('([a-z][a-z0-9_]*)'(?=[,)])/g;
  while ((m = re2.exec(SRC.cu))) if (!has('cu_' + m[1])) miss.push('cu_' + m[1]);
  // the conditional / computed keys
  ['f_payer_person', 'f_wallet_ref', 'payer_fasah', 'payer_dry', 'submitted', 'approved', 'rejected', 'voided', 'too_long', 'save_correct', 'saving'].forEach(k => { if (!has(k)) miss.push(k); });
  return !miss.length || miss;
});
const fam = (pre, list) => list.filter(c => !has(pre + c)).map(c => pre + c);
check('dynamic families: labels, hints, locks, rules, references, files, validation, AI, duplicates, custody', () => {
  const miss = [].concat(fam('mt_', P.MOVEMENTS), fam('mt_hint_', P.MOVEMENTS), fam('pattern_', P.PATTERNS), fam('source_', P.ALL_SOURCES), fam('src_hint_', P.ORG_SOURCES),
    fam('method_', P.METHODS), fam('review_', P.REVIEW), fam('status_', P.STATUSES), fam('role_', P.DOC_ROLES), fam('charge_', ['draft', 'approved', 'invoiced', 'void']),
    fam('lock_', ['daftra', 'invoiced', 'custody']), fam('payer_hint_', ['client', 'org_default', 'required', 'optional']),
    fam('rule_', ['payment_method', 'funding_source', 'fasah_wallet_source', 'fasah_wallet_method', 'cash_box_method', 'dry_port_wallet_source', 'dry_port_wallet_method', 'payer_name', 'paying_account', 'wallet_no_account']),
    fam('f_', P.REF_FIELDS), fam('ref_format_', P.REF_FIELDS), fam('ref_hint_', P.REF_FIELDS.concat(['wallet'])), fam('files_', ['count', 'size', 'total', 'type']),
    fam('', ['required', 'money', 'money_zero', 'date_bad', 'date_future', 'tas_invalid', 'claim_bad', 'internal_bad', 'tx_required', 'alloc_count', 'alloc_max', 'alloc_dup',
      'alloc_branch', 'alloc_client', 'alloc_sum', 'invoice_twice', 'wallet_ref_or_proof', 'proof_required', 'doc_alloc', 'reason_min']),
    fam('ai_st_', ['reading', 'done', 'error']), fam('ai_files_', ['count', 'size', 'total', 'type']), fam('f_', PA.FILLABLE.concat(['funding_source'])),
    fam('dup_', ['ref', 'inv_taken', 'inv_other', 'inv_existing', 'inv_internal']),
    fam('cu_kind_', CP.KINDS), fam('cu_kind_hint_', CP.KINDS), fam('cu_st_', ['active', 'void']),
    fam('cu_e_', ['required', 'money', 'date_bad', 'date_future', 'tx_required', 'payment_required', 'over_share', 'over_balance']),
    fam('nav_', ['payments', 'custody']));
  return !miss.length || miss;
});
check('the rules are stated in both languages: four eyes without admin exception, AI never approves, balance never negative, channel never the beneficiary', () =>
  (/ولا استثناء للمدير/.test(dicts.ar['pay.four_eyes_mine']) && /no admin exception/.test(dicts.en['pay.four_eyes_mine']) && /لا يعتمد ولا يتحقق/.test(dicts.ar['pay.four_eyes_rule'])
    && /never approves or verifies/.test(dicts.en['pay.four_eyes_rule']) && /لا يصبح سالبًا أبدًا/.test(dicts.ar['pay.cu_never_negative'])
    && /never the payment channel/.test(dicts.en['pay.beneficiary_hint']) && /الحقول الفارغة فقط/.test(dicts.ar['pay.ai_hint'])) || 'rules');
check('fintx payment strings (tx-fin.js): ar = en keys', () => {
  const ar = SRC.txfin.match(/\bpay_[a-z_]+:/g) || [];
  const keys = [...new Set(ar)];
  return (keys.length >= 21 && ar.length === keys.length * 2) || [keys.length, ar.length];
});
check('custody-negative detail messages exist in supa.js and i18n.js (ar + en) for void_deposit / deduction / refund', () =>
  ['void_deposit', 'deduction', 'refund'].every(d => SUPA.includes("'MRS_CUSTODY_NEGATIVE:" + d + "'") && (I18NJS.match(new RegExp('cdetail_MRS_CUSTODY_NEGATIVE_' + d + ':', 'g')) || []).length === 2) || 'details');

/* ================================================================ contract */
section('contract with the migrations and supa.js');
check('register methods = record_payment_bundle list', () => {
  const m = /v_method NOT IN \(([^)]+)\)/.exec(MIG);
  return (m && J(m[1].split(',').map(x => x.trim().replace(/'/g, ''))) === J(P.METHODS)) || (m && m[1]);
});
check('org-paid funding sources = record_payment_bundle list; movements = their sources', () => {
  const m = /v_src NOT IN \(([^)]+)\)/.exec(MIG);
  return (m && J(m[1].split(',').map(x => x.trim().replace(/'/g, ''))) === J(P.ORG_SOURCES) && /IF v_mt = 'client_direct' THEN v_src := 'client_direct';/.test(MIG)
    && /ELSIF v_mt = 'received_from_client' THEN v_src := 'not_applicable_receipt';/.test(MIG)) || (m && m[1]);
});
check('fundingRule mirrors app.fin_funding_check: same rules in the same order', () => {
  const body = CORE.slice(CORE.indexOf('CREATE OR REPLACE FUNCTION app.fin_funding_check'), CORE.indexOf('-- 2. customs_ports'));
  const sql = (body.match(/RETURN '([a-z_]+)'/g) || []).map(s => s.slice(8, -1));
  const js = (SRC.pay.slice(SRC.pay.indexOf('function fundingRule'), SRC.pay.indexOf('function ruleField')).match(/return '([a-z_]+)'/g) || []).map(s => s.slice(8, -1));
  return J(sql) === J(js) || [sql, js];
});
check('the bank reference pattern and the attachment limits are the server\'s', () =>
  (MIG.includes("v_bank !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'") && /var BANK_RE = \/\^\[A-Z0-9\]\+\(-\[A-Z0-9\]\+\)\*\$\/;/.test(SRC.pay) && MIG.includes('> 4194304') && MIG.includes('> 12582912')
    && MIG.includes("jsonb_array_length(p -> 'documents') > 8") && P.LIMITS.files === 8 && P.LIMITS.fileBytes === 4194304 && P.LIMITS.totalBytes === 12582912
    && MIG.includes("NOT IN ('application/pdf','image/jpeg','image/png','image/webp','image/heic')") && J(P.DOC_MIME) === J(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])) || 'limits');
check('document roles / review states = the migration', () =>
  (P.DOC_ROLES.every(r => MIG.includes("'pay_document_role','" + r + "'") || MIG.includes("'" + r + "'")) && /v_review NOT IN \('draft','pending'\)/.test(MIG) && J(P.REVIEW) === J(['draft', 'pending', 'approved', 'rejected'])) || 'roles');
check('every MarsaApi call of the new UI exists in supa.js (incl. the new listServiceItems)', () => {
  const names = new Set();
  [SRC.pay, SRC.cu].forEach(s => { let m; const re = /U\.call\(api, '([A-Za-z]+)'/g; while ((m = re.exec(s))) names.add(m[1]); });
  let m; const re2 = /M\(api, '([A-Za-z]+)'\)/g; const tx = SRC.txfin.slice(SRC.txfin.indexOf('function renderPayments')); while ((m = re2.exec(tx))) names.add(m[1]);
  const miss = [...names].filter(n => !new RegExp('\\b' + n + ': ' + n + '\\b').test(SUPA));
  return (!miss.length && names.has('listServiceItems') && names.has('recordPaymentBundle') && names.has('txDisbursements') && names.size >= 18) || [miss, [...names]];
});
check('supa.js listServiceItems reads org_service_items of the active org (active only by default)', () =>
  /function listServiceItems\(f\) \{[\s\S]{0,400}c\.from\('org_service_items'\)\.select\('id,code,name_ar,name_en,fin_service,sort,is_active'\)\.eq\('org_id', oid\)[\s\S]{0,120}if \(f\.active !== false\) q = q\.eq\('is_active', true\);/.test(SUPA) || 'listServiceItems');

/* ================================================================ wiring */
section('wiring: admin.html, admin.js, app-shell.js, sw.js, pay.css');
check('admin.html: pay.css after fin.css; i18n/pay.js after i18n.js; draft / pay-ai / payments / custody after the fin kit and before admin.js', () => {
  const i = s => ADMIN_HTML.indexOf(s);
  return (i('pages/pay.css') > i('pages/fin.css') && i('assets/i18n/pay.js') > i('assets/js/i18n.js') && i('fin/draft.js') > i('fin/invoices.js')
    && i('fin/pay-ai.js') > 0 && i('fin/payments.js') > i('fin/draft.js') && i('fin/custody.js') > i('fin/payments.js') && i('assets/js/admin.js') > i('fin/custody.js')
    && i('assets/js/legacy-norm.js') > 0 && i('assets/js/legacy-norm.js') < i('fin/payments.js')) || 'order';
});
check('sw.js: VERSION bumped past the backend (2026-11-22.1) and every new file precached', () => {
  const v = (/var VERSION = '([^']+)'/.exec(SW) || [])[1];
  return (v && v > '2026-11-22.1' && ['assets/js/fin/draft.js', 'assets/js/fin/payments.js', 'assets/js/fin/custody.js', 'assets/js/fin/pay-ai.js', 'assets/css/pages/pay.css', 'assets/i18n/pay.js'].every(f => SW.includes("'" + f + "'"))) || v;
});
check('admin.js: nav order has payments + custody after payables; client sections hook; orgName on the module api', () =>
  (/'payables', 'payments', 'custody',/.test(ADMIN_JS) && /function renderClientSections\(host, client\)/.test(ADMIN_JS) && /renderClientSections\(clientSections, c\);/.test(ADMIN_JS)
    && /orgName: activeOrgName\(\),/.test(ADMIN_JS)) || 'admin.js');
check('app-shell.js: payments + custody in the finance group (finRead) with ar + en fallbacks', () =>
  (/\{ id: 'payments', key: 'pay\.nav_payments', href: 'admin\.html#payments', icon: 'receipt', allow: R\.finRead \}/.test(SHELL) && /\{ id: 'custody', key: 'pay\.nav_custody', href: 'admin\.html#custody', icon: 'shield', allow: R\.finRead \}/.test(SHELL)
    && (SHELL.match(/'pay\.nav_payments':/g) || []).length === 2) || 'shell');
check('pay.css: the register table scrolls in its own box (both directions, sticky head), errors visible, no fixed widths over 375 px outside the scroll box', () =>
  (/\.table-wrap\.pay-scroll \{ max-height: min\(70vh, 640px\); overflow: auto;/.test(CSS) && /position: sticky; top: 0;/.test(CSS) && /\.pay-view \.form-error:not\(\[hidden\]\) \{ display: block; \}/.test(CSS)
    && /minmax\(min\(100%, 220px\), 1fr\)/.test(CSS) && !/(^|[^-])width:\s*[4-9]\d\dpx/m.test(CSS.replace(/min-width: (980|760)px/g, ''))) || 'css');
check('CSS order: pay.css only adds pay- / cu- / fin-pay-stats classes (no override of the shared classes with equal specificity)', () => {
  const sels = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{/g, '').match(/(^|\})\s*([^{}@]+)\{/g) || [];
  const bad = sels.map(s => s.replace(/^\}?\s*/, '').replace(/\{$/, '').trim()).filter(Boolean).filter(s => s.split(',').some(x => !/\.(pay-|cu-|fin-pay-)/.test(x)));
  return !bad.length || bad;
});

/* ================================================================ pure */
section('pure: funding × method matrix, references, payer');
eq('methodsFor: fasah wallet ⇒ fasah wallet only; cash box ⇒ cash; dry sources ⇒ dry wallet; others: no wallet',
  [P.methodsFor('fasah_wallet'), P.methodsFor('cash_box'), P.methodsFor('dry_port_wallet_org'), P.methodsFor('client_custody_dry_port'), P.methodsFor('org_account'), P.methodsFor('client_direct')],
  [['fasah_wallet'], ['cash'], ['dry_port_wallet'], ['dry_port_wallet'], ['sadad', 'mada', 'bank_transfer', 'cash', 'cheque', 'other'], ['sadad', 'mada', 'bank_transfer', 'cash', 'cheque', 'other']]);
check('every method a source offers passes fundingRule (with payer + account when needed); every other method is refused', () => {
  const bad = [];
  P.ALL_SOURCES.forEach(src => P.METHODS.forEach(m => {
    const ok = P.methodsFor(src).indexOf(m) !== -1;
    const r = P.fundingRule(src, m, 'payer', P.isWallet(m) ? null : 'Bank');
    if (ok !== (r === null)) bad.push([src, m, r]);
  }));
  return !bad.length || bad;
});
eq('fundingRule cases', [P.fundingRule('org_account', 'sadad', 'x', ''), P.fundingRule('personal_account', 'cash', '', ''), P.fundingRule('fasah_wallet', 'fasah_wallet', 'x', 'Bank'),
  P.fundingRule('org_account', 'fasah_wallet', 'x', ''), P.fundingRule('cash_box', 'mada', 'x', 'B'), P.fundingRule('', 'cash', 'x', ''), P.fundingRule('org_account', 'card', 'x', '')],
  ['paying_account', 'payer_name', 'wallet_no_account', 'fasah_wallet_source', 'cash_box_method', 'funding_source', 'payment_method']);
eq('refField per method (wallets use the receipt / transaction no)', P.METHODS.map(P.refField), ['sadad_number', 'receipt_no', 'receipt_no', 'receipt_no', 'bank_reference', 'receipt_no', 'receipt_no', 'receipt_no']);
eq('normRef: SADAD Arabic digits → western, spaces dropped; bank ref upper-cased, no spaces', [P.normRef('sadad_number', '١٢٣ ٤٥٦'), P.normRef('bank_reference', ' ft-12 ab '), P.normRef('receipt_no', '  R  12 ')],
  ['123456', 'FT-12AB', 'R 12']);
eq('refError: SADAD digits only; bank ref pattern; receipt ≤ 100', [P.refError('sadad_number', '12a'), P.refError('sadad_number', '١٢٣'), P.refError('bank_reference', 'FT--1'), P.refError('bank_reference', 'ft-1-a'),
  P.refError('bank_reference', 'SA03 8000'), P.refError('receipt_no', 'x'.repeat(101)), P.refError('receipt_no', '-1'), P.refError('receipt_no', 'R-1/2')],
  ['format', null, 'format', null, null, 'too_long', 'format', null]);
eq('payerInfo: org account fixed from settings, wallets fixed, cash box defaults to the org, personal required, client otherwise',
  [P.payerInfo('org_paid', 'org_account').mode, P.payerInfo('org_paid', 'fasah_wallet').key, P.payerInfo('org_paid', 'client_custody_dry_port').key, P.payerInfo('org_paid', 'cash_box').mode,
    P.payerInfo('org_paid', 'personal_account').mode, P.payerInfo('client_direct', '').mode, P.payerInfo('received_from_client', '').mode],
  ['org', 'payer_fasah', 'payer_dry', 'org_default', 'required', 'client', 'client']);
check('payer default is never a constant name in the UI: the org-account payer comes from api.orgName (admin.js) / the server settings', () =>
  (/value: api\.orgName \|\| ''/.test(SRC.pay) && !/مرسى للتخليص|Marsa Clearance/.test(SRC.pay)) || 'payer');

section('pure: amounts, allocations, files, dates');
eq('allocTotals: Σ ±0.005, unallocated, balanced', [P.allocTotals('100', [{ amount: '60' }, { amount: '40.004' }]).balanced, P.allocTotals('100', [{ amount: '60' }, { amount: '30' }]).unallocated,
  P.allocTotals('100', [{ amount: '60' }, { amount: '50' }]).unallocated, P.allocTotals('١٠٠', [{ amount: '٥٠' }, { amount: '50' }]).balanced], [true, 10, -10, true]);
eq('filesCheck: count 8, type, size 4 MB, total 12 MB', [
  P.filesCheck(Array(9).fill({ name: 'a.pdf', size: 10, type: 'application/pdf' })), P.filesCheck([{ name: 'a.gif', size: 10, type: 'image/gif' }]),
  P.filesCheck([{ name: 'big.pdf', size: 4194305, type: 'application/pdf' }]), P.filesCheck(Array(4).fill({ name: 'a.pdf', size: 4000000, type: 'application/pdf' })),
  P.filesCheck([{ name: 'h.heic', size: 9, type: 'image/heic' }])],
  [{ field: 'count' }, { field: 'type', name: 'a.gif' }, { field: 'size', name: 'big.pdf' }, { field: 'total' }, null]);
check('riyadhToday: 22:30 UTC is already the next day in Riyadh; fmtDay keeps the calendar day in every zone', () =>
  (P.riyadhToday(Date.UTC(2026, 10, 10, 22, 30)) === '2026-11-11' && P.riyadhToday(Date.UTC(2026, 10, 10, 20, 59)) === '2026-11-10'
    && /10/.test(P.fmtDay('2026-11-10', 'en')) && !/9 Nov/.test(P.fmtDay('2026-11-10', 'en')) && P.fmtDay('2026-11-10', 'en') === '10 Nov 2026') || [P.riyadhToday(Date.UTC(2026, 10, 10, 22, 30)), P.fmtDay('2026-11-10', 'en')]);
eq('normTas = MarsaNorm.normTas (bidi marks, reversed …TAS)', [P.normTas('tas 2026 1111 0001'), P.normTas('\u200f20261111TAS'), P.normTas('TAS123')], ['TAS202611110001', 'TAS20261111', '']);

section('pure: payload, validation, server errors, duplicates');
const TXA = { id: 'aaaaaaaa-0000-4000-8000-000000000001', ref: 'MRS-2026-000001', client_id: 'c1', client_name: 'عميل ١', branch_id: 'b1' };
const TXB = { id: 'aaaaaaaa-0000-4000-8000-000000000002', ref: 'MRS-2026-000002', client_id: 'c1', client_name: 'عميل ١', branch_id: 'b1' };
const TXC = { id: 'aaaaaaaa-0000-4000-8000-000000000003', ref: 'MRS-2026-000003', client_id: 'c2', client_name: 'عميل ٢', branch_id: 'b1' };
function st(o) { return Object.assign(P.emptyState('2026-11-10'), o); }
const single = st({ service_item_id: 'svc1', tx: TXA, claim_no: 'REF-77', internal_invoice_no: 'fp 123', appointment_no: 'tas20261111000', expected_amount: '54.05', paid_amount: '54,05',
  paid_at: '2026-11-09', funding_source: 'org_account', method: 'sadad', paying_account: 'الراجحي', payer_name: 'typed', beneficiary_party_id: 'p1', payment_channel: 'SADAD',
  sadad_number: '١٢٣٤٥', bank_reference: 'LEFT', receipt_no: 'LEFT', notes: ' n ', charge_client: true });
eq('buildPayload single: only the method\'s reference, TAS normalised, payer omitted (org account), internal upper-cased, review pending', P.buildPayload(single, [{ finance_document_id: 'd1', role: 'payment_proof' }]),
  { movement_type: 'org_paid', pattern: 'single', paid_amount: 54.05, paid_at: '2026-11-09', method: 'sadad', review_status: 'pending', service_item_id: 'svc1', funding_source: 'org_account',
    expected_amount: 54.05, appointment_no: 'TAS20261111000', paying_account: 'الراجحي', beneficiary_party_id: 'p1', payment_channel: 'SADAD', sadad_number: '12345', notes: 'n',
    charge_client: true, transaction_id: TXA.id, claim_no: 'REF-77', internal_invoice_no: 'FP 123', documents: [{ finance_document_id: 'd1', role: 'payment_proof' }] });
const shared = st({ pattern: 'shared', movement_type: 'client_direct', service_item_id: 'svc1', paid_amount: '100', method: 'bank_transfer', paying_account: 'SNB', bank_reference: 'ft-9',
  beneficiary_party_id: 'p1', as_draft: true, allocations: [{ key: 'a1', tx: TXA, amount: '60', claim_no: 'R1', internal_invoice_no: '', invoice_date: '2026-11-01', notes: '' },
    { key: 'a2', tx: TXB, amount: '40', claim_no: 'R2', internal_invoice_no: '', invoice_date: '', notes: 'x' }] });
eq('buildPayload shared client_direct: allocations with keys, no funding source (server sets client_direct), draft, no top-level transaction / claim', P.buildPayload(shared),
  { movement_type: 'client_direct', pattern: 'shared', paid_amount: 100, paid_at: '2026-11-10', method: 'bank_transfer', review_status: 'draft', service_item_id: 'svc1', paying_account: 'SNB',
    beneficiary_party_id: 'p1', bank_reference: 'FT-9', allocations: [{ transaction_id: TXA.id, amount: 60, key: 'a1', claim_no: 'R1', invoice_date: '2026-11-01' }, { transaction_id: TXB.id, amount: 40, key: 'a2', claim_no: 'R2', notes: 'x' }] });
eq('buildPayload received_from_client: no beneficiary, no invoice fields, no charge_client', P.buildPayload(st({ movement_type: 'received_from_client', service_item_id: 's', tx: TXA, paid_amount: '10',
  method: 'cash', receipt_no: 'R1', beneficiary_party_id: 'p1', claim_no: 'X', charge_client: true })),
  { movement_type: 'received_from_client', pattern: 'single', paid_amount: 10, paid_at: '2026-11-10', method: 'cash', review_status: 'pending', service_item_id: 's', receipt_no: 'R1', transaction_id: TXA.id });
eq('validate: empty form', Object.keys(P.validate(st({}), [], { today: '2026-11-10' })).sort(), ['beneficiary_party_id', 'funding_source', 'method', 'paid_amount', 'service_item_id', 'tx']);
eq('validate: future date (Riyadh), bad TAS, bad money, rule + reference', P.validate(st({ service_item_id: 's', tx: TXA, beneficiary_party_id: 'p', paid_amount: '1.234', paid_at: '2026-11-11',
  appointment_no: 'TAS12', funding_source: 'org_account', method: 'mada', receipt_no: '' }), [], { today: '2026-11-10' }),
  { paid_amount: 'money', paid_at: 'date_future', appointment_no: 'tas_invalid', paying_account: 'rule_paying_account', receipt_no: 'required' });
eq('validate: wallet needs a reference OR a proof file; with the proof file it passes', [P.validate(st({ service_item_id: 's', tx: TXA, beneficiary_party_id: 'p', paid_amount: '5', funding_source: 'fasah_wallet', method: 'fasah_wallet' }), []).receipt_no,
  Object.keys(P.validate(st({ service_item_id: 's', tx: TXA, beneficiary_party_id: 'p', paid_amount: '5', funding_source: 'fasah_wallet', method: 'fasah_wallet' }), [{ role: 'payment_proof', size: 5, type: 'application/pdf', name: 'p.pdf' }])).length],
  ['wallet_ref_or_proof', 0]);
eq('validate shared: sum, one client for client_direct, duplicate tx + invoice, entity invoice without allocation', [
  P.validate(Object.assign({}, shared, { allocations: [Object.assign({}, shared.allocations[0], { amount: '50' }), shared.allocations[1]] }), [{ role: 'payment_proof', size: 5, type: 'application/pdf' }]).allocations,
  P.validate(Object.assign({}, shared, { allocations: [shared.allocations[0], Object.assign({}, shared.allocations[1], { tx: TXC })] }), [{ role: 'payment_proof', size: 5, type: 'application/pdf' }]).allocations,
  P.validate(Object.assign({}, shared, { allocations: [shared.allocations[0], Object.assign({}, shared.allocations[1], { tx: TXA, claim_no: 'r-1' })] }), [{ role: 'payment_proof', size: 5, type: 'application/pdf' }])['alloc.a2.claim_no'],
  P.validate(shared, [{ role: 'payment_proof', size: 5, type: 'application/pdf' }, { role: 'entity_invoice', size: 5, type: 'application/pdf', alloc: '' }])._files,
  P.validate(shared, [])._files, Object.keys(P.validate(shared, [{ role: 'payment_proof', size: 5, type: 'application/pdf' }])).length],
  ['alloc_sum', 'alloc_client', 'alloc_dup', 'doc_alloc', 'proof_required', 0]);
eq('validate correct mode: reason ≥ 3', P.validate(Object.assign({}, single, { reason: 'ab' }), [], { correct: true, today: '2026-11-10' }).reason, 'reason_min');
eq('errorField: server errors land on their field', [P.errorField({ code: 'MRS_PAY_REF_TAKEN', field: 'sadad_number' }), P.errorField({ code: 'MRS_PAY_FUNDING', field: 'wallet_no_account' }),
  P.errorField({ code: 'MRS_PAY_INVOICE_TAKEN', field: 'internal_invoice_no' }), P.errorField({ code: 'MRS_CONFIRM_INVOICE_REUSE', field: 'invoice_number' }),
  P.errorField({ code: 'MRS_REQUIRED', field: 'payment_proof' }), P.errorField({ code: 'MRS_REQUIRED', field: 'service_item' }), P.errorField({ code: 'MRS_PAY_ALLOCATION', field: 'sum' }),
  P.errorField({ code: 'MRS_FORBIDDEN', field: 'self_approval' })], ['sadad_number', 'paying_account', 'internal_invoice_no', 'claim_no', '_files', 'service_item_id', 'allocations', '_form']);
check('dupLines: the earlier payment, its transaction, amount and date are cited; invoice kinds get their tone', () => {
  const l = P.dupLines({ references: [{ field: 'sadad_number', id: 'x', ref: 'PAY-000012', transaction_ref: 'MRS-2026-000007', amount: 1250, paid_at: '2026-11-02' }],
    invoices: [{ claim_no: 'R1', kind: 'taken', ref: 'PAY-000009', issuer_name: 'فسح' }, { claim_no: 'R1', kind: 'other_issuer', issuer_name: 'جهة' }, { claim_no: 'R1', kind: 'existing_invoice', issuer_name: 'ج' }] });
  const t = base.w.MarsaOps.finPay.T(l[0].key, l[0].vars);
  return (l.length === 4 && /PAY-000012/.test(t) && /MRS-2026-000007/.test(t) && /1250\.00/.test(t) && /رقم السداد/.test(t) && J(l.map(x => x.tone)) === J(['danger', 'danger', 'warning', 'info'])) || [l, t];
});
check('stateFromPayment → buildPayload round trip (shared): same allocations, the corrected entry\'s values', () => {
  const d = { movement_type: 'org_paid', pattern: 'shared', service_item_id: 's', expected_amount: 100, paid_amount: 100, paid_at: '2026-11-01', funding_source: 'org_account', method: 'bank_transfer',
    paying_account: 'SNB', payer_name: 'ORG', beneficiary_party_id: 'p1', bank_reference: 'FT-1', branch_id: 'b1',
    allocations: [{ seq: 1, transaction_id: TXA.id, transaction_ref: 'A', client_id: 'c1', amount: 70, claim_no: 'R1' }, { seq: 2, transaction_id: TXB.id, transaction_ref: 'B', client_id: 'c1', amount: 30, claim_no: 'R2' }] };
  const p = P.buildPayload(P.stateFromPayment(d, '2026-11-10'));
  return (p.payer_name === undefined && p.bank_reference === 'FT-1' && J(p.allocations.map(a => [a.transaction_id, a.amount, a.claim_no, a.key])) === J([[TXA.id, 70, 'R1', 'a1'], [TXB.id, 30, 'R2', 'a2']])) || p;
});
eq('lockOf: daftra / invoiced charge / active custody deduction', [P.lockOf({ daftra_draft_id: 1 }), P.lockOf({ allocations: [{ client_charge: { status: 'invoiced' } }] }),
  P.lockOf({ custody_deductions: [{ status: 'void' }, { status: 'active' }] }), P.lockOf({ allocations: [{ client_charge: { status: 'draft' } }] })], ['daftra', 'invoiced', 'custody', null]);
check('applySuggestion: only empty fields are filled; a method the source refuses and another method\'s reference are skipped; pattern / review never change', () => {
  const s = st({ funding_source: 'cash_box', paid_amount: '99.00', as_draft: true });
  const r = P.applySuggestion(s, { claim_no: 'R9', paid_amount: 54.05, expected_amount: 54.05, method: 'sadad', sadad_number: '777', paid_at: '2026-11-03', appointment_no: 'tas 20261103 000',
    beneficiary_name: 'وزارة', service_code: 'gate_in_appointment' }, {});
  return (r.state.paid_amount === '99.00' && r.state.claim_no === 'R9' && r.state.expected_amount === '54.05' && r.state.method === '' && r.skipped.indexOf('method') !== -1
    && r.state.paid_at === '2026-11-03' && r.state.sadad_number === '' && r.skipped.indexOf('sadad_number') !== -1 && r.state.appointment_no === 'TAS20261103000' && r.state.pattern === 'single' && r.state.as_draft === true && r.service_code === 'gate_in_appointment'
    && r.beneficiary_name === 'وزارة' && s.claim_no === '') || r;
});
check('partyByName: one rough match only (never a payment channel)', () => {
  const ps = [{ id: 'p1', name_ar: 'منصة فسح' }, { id: 'p2', name_ar: 'شركة الموانئ' }, { id: 'p3', name_ar: '' }];
  return (P.partyByName(ps, 'شركة الموانئ').id === 'p2' && P.partyByName(ps, 'زمزم') === null && PA.isChannel('Fasah') && PA.isChannel('STC Pay')) || 'party';
});

section('MarsaDraft: per user, sessionStorage only, never throws');
check('save / load / clear per user; another user sees nothing; no user id → nothing stored', () => {
  const ok1 = DR.save('pay-form.new', 'user-1', { state: { paid_amount: '5' } });
  const l1 = DR.load('pay-form.new', 'user-1'), l2 = DR.load('pay-form.new', 'user-2'), nouser = DR.save('pay-form.new', null, { a: 1 });
  DR.clear('pay-form.new', 'user-1');
  return (ok1 && l1.data.state.paid_amount === '5' && l2 === null && nouser === false && DR.load('pay-form.new', 'user-1') === null && !/localStorage/.test(SRC.draft.replace(/\/\*[\s\S]*?\*\//g, ''))) || [ok1, l1, l2, nouser];
});
check('an old draft (> 12 h) is dropped; a corrupt one is dropped', () => {
  base.storage.setItem('marsa.draft.v1:user-1:x', JSON.stringify({ v: 1, at: Date.now() - 13 * 3600000, data: { a: 1 } }));
  base.storage.setItem('marsa.draft.v1:user-1:y', '{not json');
  return (DR.load('x', 'user-1') === null && DR.load('y', 'user-1') === null && base.storage.getItem('marsa.draft.v1:user-1:x') === null) || 'ttl';
});
check('a storage that throws (private mode / quota) → false / null, never an exception', () => {
  const c2 = context({ storage: makeStorage({ throws: true }) });
  const D2 = c2.w.MarsaDraft;
  return (D2.save('s', 'u1', { a: 1 }) === false && D2.load('s', 'u1') === null && D2.clear('s', 'u1') === false && D2.autosave('s', 'u1', () => ({ a: 1 })).flush() === false) || 'throws';
});

section('custody pure');
eq('maxFor: deduction ≤ min(share, balance); refund ≤ balance; deposit unlimited', [CP.maxFor('deduction', 500, 120), CP.maxFor('deduction', 80, 120), CP.maxFor('refund', 80, 120), CP.maxFor('deposit', 80, null)], [120, 80, 80, null]);
eq('validateEntry: deduction needs tx + payment; over share / over balance; future date; branch when no tx', [
  CP.validateEntry({ client_id: 'c', kind: 'deduction', amount: '10', entry_date: '2026-11-10', transaction_id: '', disbursement_id: '' }, { today: '2026-11-10' }),
  CP.validateEntry({ client_id: 'c', kind: 'deduction', amount: '130', entry_date: '2026-11-10', transaction_id: 't', disbursement_id: 'd' }, { balance: 500, share: 120, today: '2026-11-10' }),
  CP.validateEntry({ client_id: 'c', kind: 'refund', amount: '90', entry_date: '2026-11-11', transaction_id: '', branch_id: 'b' }, { balance: 80, today: '2026-11-10' }),
  CP.validateEntry({ client_id: 'c', kind: 'deposit', amount: '90', entry_date: '2026-11-10', transaction_id: '' }, { today: '2026-11-10' })],
  [{ transaction_id: 'tx_required', disbursement_id: 'payment_required', branch_id: 'required' }, { amount: 'over_share' }, { entry_date: 'date_future', amount: 'over_balance' }, { branch_id: 'required' }]);
eq('buildEntryPayload: transaction wins over branch; disbursement only on a deduction', [CP.buildEntryPayload({ client_id: 'c', kind: 'deduction', amount: '١٠', entry_date: '2026-11-10', transaction_id: 't', disbursement_id: 'd', branch_id: 'b', reference: ' r ', notes: '' }),
  CP.buildEntryPayload({ client_id: 'c', kind: 'deposit', amount: '5', entry_date: '2026-11-10', transaction_id: '', disbursement_id: 'd', branch_id: 'b' })],
  [{ client_id: 'c', kind: 'deduction', amount: 10, entry_date: '2026-11-10', transaction_id: 't', disbursement_id: 'd', reference: 'r' }, { client_id: 'c', kind: 'deposit', amount: 5, entry_date: '2026-11-10', branch_id: 'b' }]);

/* ================================================================ DOM flows */
const ORG = '00000000-0000-4000-8000-0000000000aa';
const ME = '00000000-0000-4000-8000-0000000000a1', OTHER = '00000000-0000-4000-8000-0000000000b2';
const PAY_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const ok = d => Promise.resolve({ data: d, error: null });
const bad = (code, field, extra) => Promise.resolve({ data: null, error: { code, field: field || null, message: code + (field ? ':' + field : '') + (extra ? ' ' + extra : ''), extra: extra || null } });
function F(name, size, type) { return { name, size: size || 1000, type: type || 'application/pdf', lastModified: 1 }; }
function makeApi(ctx, A, extra) {
  const log = { toasts: [], confirms: [], go: [] };
  let k = 0;
  const api = Object.assign({ orgId: ORG, userId: ME, roles: ['accounts_manager'], branches: [{ id: 'b1', name_ar: 'جدة', is_active: true }], orgName: 'مؤسسة الاختبار',
    can: () => true, t: (key, v) => I18N.t(key, v), el: null, MarsaApi: A, toast: (m, t) => log.toasts.push([t, m]), confirm: o => { log.confirms.push(o); return Promise.resolve(log.answer !== false); },
    go: h => log.go.push(h), refresh: () => {}, newIdemKey: () => 'key-' + (++k), label: (d, c) => c, fmtMoney: (n, c) => (+n).toFixed(2) + ' ' + (c || 'SAR'), fmtDate: v => String(v),
    errText: e => (e && e.message) || 'err', isEn: () => false, who: id => id === ME ? 'أنا' : 'زميل', hashQuery: () => ({}) }, extra || {});
  return { api, log };
}
const byName = (root, n) => root.querySelector('[data-name="' + n + '"]');
function setVal(root, n, v, ev) { const c = byName(root, n); if (!c) throw new Error('no control ' + n); c.value = v; c.dispatch(ev || (c.tagName === 'SELECT' ? 'change' : 'input')); return c; }
function btnText(root, re) { return root.querySelectorAll('button').filter(b => re.test(b.textContent)); }
const ITEMS = [{ id: 'svc1', code: 'gate_in_appointment', name_ar: 'موعد دخول', is_active: true }, { id: 'svc2', code: 'port_charges', name_ar: 'أجور الموانئ', is_active: true }];
const PARTIES = [{ id: 'p1', name_ar: 'شركة تبادل التجارية', kinds: ['supplier'] }, { id: 'p2', name_ar: 'هيئة الموانئ', kinds: ['supplier'] }];

async function registerFlow() {
  section('DOM: #payments register (filters, search, scroll box)');
  const c = context(), D = c.document;
  const calls = [];
  const A = { listPayments: (org, f) => { calls.push([org, f]); return ok({ total: 2, totals: { paid: 150, expected: 160, difference: 10 }, rows: [
    { id: PAY_ID, ref: 'PAY-000001', movement_type: 'org_paid', pattern: 'shared', allocation_count: 2, service_name_ar: 'موعد دخول', paid_at: '2026-11-10', paid_amount: 100, expected_amount: 110, difference: 10,
      method: 'sadad', funding_source: 'org_account', sadad_number: '12345', beneficiary_name: 'هيئة الموانئ', payer_name: 'المؤسسة', review_status: 'pending', status: 'recorded',
      transactions: [{ transaction_id: TXA.id, ref: 'MRS-2026-000001', client_name: 'عميل' }, { transaction_id: TXB.id, ref: 'MRS-2026-000002' }, { transaction_id: TXC.id, ref: 'MRS-2026-000003' }] },
    { id: 'p2', ref: 'PAY-000002', movement_type: 'client_direct', pattern: 'single', paid_at: '2026-11-09', paid_amount: 50, method: 'cash', funding_source: 'client_direct', review_status: 'approved', status: 'void', transactions: [] }] }); } };
  const root = D.createElement('div'); D.body.appendChild(root);
  const { api } = makeApi(c, A);
  await c.w.MarsaOps.views.payments.render(root, api, null); await settle(5);
  check('first load: status recorded, limit 50, the org; tiles; rows with the ref link, the Riyadh date, the transactions (+1 more), the void row muted', () =>
    (J(calls[0]) === J([ORG, { limit: 50, offset: 0, status: 'recorded' }]) && /150\.00 SAR/.test(root.textContent) && /PAY-000001/.test(root.textContent)
      && root.querySelectorAll('a').some(a => a.href === '#payments/' + PAY_ID) && /\+1 أخرى/.test(root.textContent) && root.querySelector('tr[data-id="p2"]').className === 'is-muted'
      && /بانتظار المراجعة/.test(root.textContent) && root.querySelector('.pay-scroll') && /2 سجل/.test(root.textContent)) || [calls, root.textContent.slice(0, 300)]);
  root.querySelector('select[name="method"]').value = 'sadad'; root.querySelector('select[name="method"]').dispatch('change'); await settle(5);
  root.querySelector('select[name="funding_source"]').value = 'fasah_wallet'; root.querySelector('select[name="funding_source"]').dispatch('change'); await settle(5);
  root.querySelector('select[name="status"]').value = 'all'; root.querySelector('select[name="status"]').dispatch('change'); await settle(5);
  const s = root.querySelector('input[type="search"]'); s.value = 'PAY-1'; s.dispatch('input'); await settle(200);
  const last = calls[calls.length - 1][1];
  check('filters: method, funding source, status all, search q (debounced) reach list_payments; the search box is not rebuilt (focus kept)', () =>
    (last.method === 'sadad' && last.funding_source === 'fasah_wallet' && last.status === 'all' && last.q === 'PAY-1' && root.querySelector('input[type="search"]') === s) || J(last));
  const r2 = D.createElement('div'); D.body.appendChild(r2);
  const A2 = { listPayments: (org, f) => { calls.push(['q', f]); return ok({ total: 0, rows: [], totals: {} }); } };
  await c.w.MarsaOps.views.payments.render(r2, makeApi(c, A2, { hashQuery: () => ({ tx: TXA.id }), can: () => false }).api, null); await settle(5);
  check('#payments?tx=<id> filters by the transaction; empty state; no «new» button without finWrite', () =>
    (calls[calls.length - 1][1].transaction_id === TXA.id && /لا توجد سدادات/.test(r2.textContent) && !r2.querySelector('[data-act="pay-new"]') && !!r2.querySelector('[data-act="clear-tx"]')) || r2.textContent);
  const r2b = D.createElement('div'); D.body.appendChild(r2b);
  await c.w.MarsaOps.views.payments.render(r2b, makeApi(c, A2, { hashQuery: () => ({}), can: () => false }).api, null); await settle(5);
  check('after #payments?tx=<id>, a plain #payments drops the transaction filter (not sticky)', () =>
    (!calls[calls.length - 1][1].transaction_id && !r2b.querySelector('[data-act="clear-tx"]')) || J(calls[calls.length - 1]));
}

function formApi(c, over) {
  const calls = [];
  const A = Object.assign({
    listServiceItems: o => { calls.push(['items', o]); return ok(ITEMS); },
    listParties: o => { calls.push(['parties']); return ok(PARTIES); },
    getTransaction: id => { calls.push(['tx', id]); return ok({ id, ref: 'MRS-2026-000001', client_id: 'c1', branch_id: 'b1', clients: { name_ar: 'عميل ١' } }); },
    listTransactions: o => { calls.push(['txs', o]); return ok([TXB].map(x => ({ id: x.id, ref: x.ref, client_id: x.client_id, branch_id: x.branch_id, clients: { name_ar: x.client_name } }))); },
    checkPaymentDuplicates: (org, p) => { calls.push(['dup', p]); return ok(p.sadad_number === '999' ? { references: [{ field: 'sadad_number', id: 'x', ref: 'PAY-000012', transaction_ref: 'MRS-2026-000007', amount: 1250, paid_at: '2026-11-02' }], invoices: [] } : { references: [], invoices: [] }); },
    uploadFinanceDocument: (o, opts) => { calls.push(['upload', o.kind, o.file.name, o.branchId, opts && opts.idemKey ? 'key' : null]); return ok({ id: 'doc-' + o.file.name }); },
    recordPaymentBundle: (p, o) => { calls.push(['record', p, o]); return ok({ id: PAY_ID, ref: 'PAY-000031' }); },
    aiExtract: o => { calls.push(['ai', o.docType, o.promptVersion, o.file.media_type]); return ok(o.docType === 'appointment_invoice'
      ? { usage_id: 'u1', doc_type: o.docType, payment: { kind: 'invoice', issuer_name: 'هيئة الموانئ', invoice_no: 'REF-55', internal_invoice_no: 'FP998', appointment_no: 'TAS202611100001', service_code: 'gate_in_appointment', invoice_date: '2026-11-08', total: 54.05, bl_number: 'BL1', container_numbers: ['MSKU1234565'] } }
      : { usage_id: 'u2', doc_type: o.docType, payment: { kind: 'proof', beneficiary_name: 'Fasah', payment_channel: 'Fasah', paid_at: '2026-11-08', amount: 50, method: 'sadad', sadad_number: '4455', bank_reference: 'IGNORED' } }); },
    matchPaymentTransaction: (org, h) => { calls.push(['match', h]); return ok({ candidates: [{ transaction_id: TXA.id, ref: 'MRS-2026-000001', client_id: 'c1', client_name: 'عميل ١', branch_id: 'b1', matched_by: ['bl_number'], score: 1 }], unique_transaction_id: TXA.id }); }
  }, over || {});
  return { A, calls };
}
async function formFlows() {
  section('DOM: the payment form — funding drives the methods, references validated inline, duplicates explained');
  const c = context(), D = c.document;
  const { A, calls } = formApi(c);
  const root = D.createElement('div'); D.body.appendChild(root);
  const M = makeApi(c, A, { hashQuery: () => ({ tx: TXA.id }) });
  await c.w.MarsaOps.views.payments.render(root, M.api, 'new'); await settle(5);
  check('opens with the catalog, the parties and the pre-linked transaction (#payments/new?tx=); default date = Riyadh today', () =>
    (calls.some(x => x[0] === 'items') && calls.some(x => x[0] === 'tx' && x[1] === TXA.id) && /MRS-2026-000001/.test(root.textContent) && byName(root, 'paid_at').value === P.riyadhToday()
      && byName(root, 'service_item_id').options.length === 3 && byName(root, 'beneficiary_party_id').options.length === 3) || root.textContent.slice(0, 400));
  setVal(root, 'funding_source', 'fasah_wallet');
  check('fasah wallet source → the method is fasah wallet only (auto), no bank field, payer fixed «محفظة فسح»', () =>
    (byName(root, 'method').options.length === 2 && byName(root, 'method').value === 'fasah_wallet' && !byName(root, 'paying_account') && byName(root, 'payer_name').value === 'محفظة فسح'
      && byName(root, 'payer_name').disabled && /لا يُسجل بنك على سداد المحفظة/.test(root.textContent)) || [byName(root, 'method').options.map(o => o.value), root.textContent.slice(0, 200)]);
  setVal(root, 'funding_source', 'cash_box');
  check('cash box → cash only; the payer defaults to the organization name (placeholder from api.orgName)', () =>
    (byName(root, 'method').value === 'cash' && byName(root, 'method').options.length === 2 && byName(root, 'payer_name').getAttribute('placeholder') === 'مؤسسة الاختبار' && !!byName(root, 'receipt_no')) || byName(root, 'method').options.map(o => o.value));
  setVal(root, 'funding_source', 'org_account');
  check('org account → cash is still allowed (kept), wallets are not offered; the payer is the settings name (disabled)', () =>
    (byName(root, 'method').value === 'cash' && J(byName(root, 'method').options.map(o => o.value)) === J(['', 'sadad', 'mada', 'bank_transfer', 'cash', 'cheque', 'other'])
      && byName(root, 'payer_name').disabled && byName(root, 'payer_name').value === 'مؤسسة الاختبار') || byName(root, 'method').options.map(o => o.value));
  setVal(root, 'method', 'sadad');
  setVal(root, 'sadad_number', '12ab');
  check('SADAD: inline format error while typing; the bank field is required for SADAD', () =>
    (/رقم السداد أرقام فقط/.test(root.querySelector('#pay-f-sadad_number-e').textContent) && !root.querySelector('#pay-f-sadad_number-e').hidden && byName(root, 'paying_account')
      && /مطلوب لسداد ومدى/.test(root.textContent)) || root.querySelector('#pay-f-sadad_number-e').textContent);
  const sn = setVal(root, 'sadad_number', '٩٩٩'); sn.dispatch('blur'); await settle(400);
  check('blur: Arabic digits normalised; check_payment_duplicates explains the earlier payment with its transaction, amount and date', () =>
    (byName(root, 'sadad_number').value === '999' && calls.some(x => x[0] === 'dup' && x[1].sadad_number === '999') && /PAY-000012/.test(root.querySelector('.pay-dup').textContent)
      && /MRS-2026-000007/.test(root.querySelector('.pay-dup').textContent) && /1250\.00/.test(root.querySelector('.pay-dup').textContent)) || root.querySelector('.pay-dup').textContent);
  // save with missing fields → local errors, nothing sent
  root.querySelector('[data-act="save"]').click(); await settle(5);
  check('save with missing fields: errors in place, no upload, no record_payment_bundle', () =>
    (!calls.some(x => x[0] === 'record' || x[0] === 'upload') && !root.querySelector('#pay-f-service_item_id-e').hidden && !root.querySelector('#pay-f-paid_amount-e').hidden
      && !root.querySelector('#pay-f-paying_account-e').hidden && /راجع الحقول المحددة/.test(root.querySelector('.pay-form-error').textContent)) || root.querySelector('.pay-form-error').textContent);
  setVal(root, 'service_item_id', 'svc1'); setVal(root, 'beneficiary_party_id', 'p2'); setVal(root, 'paid_amount', '54.05'); setVal(root, 'expected_amount', '60');
  check('difference = expected − paid, live', () => /5\.95 SAR/.test(root.querySelector('.pay-diff-out').textContent) || root.querySelector('.pay-diff-out').textContent);
  setVal(root, 'paying_account', 'الراجحي'); setVal(root, 'sadad_number', '123456'); setVal(root, 'claim_no', 'REF-1'); setVal(root, 'appointment_no', 'tas 2026 1110 0001');
  byName(root, 'appointment_no').dispatch('blur');
  const pick = root.querySelector('input[data-files="pick"]');
  pick.files = [F('inv.pdf'), F('proof.png', 2000, 'image/png')]; pick.dispatch('change'); await settle(1);
  root.querySelector('[data-role-of="1"]').value = 'payment_proof'; root.querySelector('[data-role-of="1"]').dispatch('change');
  root.querySelector('[data-act="save"]').click(); await settle(30);
  const rec = calls.filter(x => x[0] === 'record');
  check('save: each file uploaded with its kind (entity invoice → supplier_invoice, proof → payment_evidence) in the transaction branch, then ONE bundle with the typed documents + idempotency key', () =>
    (J(calls.filter(x => x[0] === 'upload').map(x => [x[1], x[2], x[3]])) === J([['supplier_invoice', 'inv.pdf', 'b1'], ['payment_evidence', 'proof.png', 'b1']]) && rec.length === 1
      && J(rec[0][1].documents) === J([{ finance_document_id: 'doc-inv.pdf', role: 'entity_invoice' }, { finance_document_id: 'doc-proof.png', role: 'payment_proof' }])
      && rec[0][1].transaction_id === TXA.id && rec[0][1].sadad_number === '123456' && rec[0][1].appointment_no === 'TAS202611100001' && rec[0][1].payer_name === undefined
      && rec[0][1].review_status === 'pending' && rec[0][1].expected_amount === 60 && typeof rec[0][2].idemKey === 'string') || J(rec));
  check('success: toast with the reference, go to #payments/<id>', () => (M.log.go[0] === '#payments/' + PAY_ID && /PAY-000031/.test(M.log.toasts[0][1])) || J(M.log));

  section('DOM: MRS_CONFIRM_INVOICE_REUSE → explicit confirmation; MRS_PAY_INVOICE_TAKEN → hard block on the field');
  const c2 = context(), D2 = c2.document;
  let n = 0;
  const f2 = formApi(c2, { recordPaymentBundle: (p, o) => { f2.calls.push(['record', p, o]); n++; return n === 1 ? bad('MRS_CONFIRM_INVOICE_REUSE', 'invoice_number', 'REF-1 · جهة أخرى') : ok({ id: PAY_ID, ref: 'PAY-000040' }); } });
  const r2 = D2.createElement('div'); D2.body.appendChild(r2);
  const M2 = makeApi(c2, f2.A, { hashQuery: () => ({ tx: TXA.id }) });
  await c2.w.MarsaOps.views.payments.render(r2, M2.api, 'new'); await settle(5);
  function fillMin(root) {
    setVal(root, 'service_item_id', 'svc2'); setVal(root, 'beneficiary_party_id', 'p1'); setVal(root, 'paid_amount', '10'); setVal(root, 'claim_no', 'REF-1');
    setVal(root, 'funding_source', 'cash_box'); setVal(root, 'receipt_no', 'R-1');
  }
  fillMin(r2);
  r2.querySelector('[data-act="save"]').click(); await settle(30);
  const rr = f2.calls.filter(x => x[0] === 'record');
  check('the confirm cites the other issuer; yes → the same form re-sent with confirm_invoice_reuse: true and a NEW idempotency key', () =>
    (M2.log.confirms.length === 1 && /جهة أخرى/.test(M2.log.confirms[0].text) && rr.length === 2 && rr[0][1].confirm_invoice_reuse === undefined && rr[1][1].confirm_invoice_reuse === true
      && rr[0][2].idemKey !== rr[1][2].idemKey && M2.log.go[0] === '#payments/' + PAY_ID) || J([M2.log, rr.map(x => x[1].confirm_invoice_reuse)]));
  const c3 = context(), D3 = c3.document;
  const f3 = formApi(c3, { recordPaymentBundle: (p, o) => { f3.calls.push(['record', p]); return bad('MRS_CONFIRM_INVOICE_REUSE', 'invoice_number', 'REF-1 · جهة أخرى'); } });
  const r3 = D3.createElement('div'); D3.body.appendChild(r3);
  const M3 = makeApi(c3, f3.A, { hashQuery: () => ({ tx: TXA.id }) });
  M3.log.answer = false;
  await c3.w.MarsaOps.views.payments.render(r3, M3.api, 'new'); await settle(5);
  fillMin(r3);
  r3.querySelector('[data-act="save"]').click(); await settle(30);
  check('no → nothing re-sent; the message stays on the invoice number', () =>
    (f3.calls.filter(x => x[0] === 'record').length === 1 && !r3.querySelector('#pay-f-claim_no-e').hidden && M3.log.go.length === 0) || r3.querySelector('#pay-f-claim_no-e').textContent);
  const f3b = formApi(c3, { recordPaymentBundle: () => bad('MRS_PAY_REF_TAKEN', 'receipt_no', 'PAY-000012 · MRS-2026-000007 · 1250.00 SAR') });
  const r3b = D3.createElement('div'); D3.body.appendChild(r3b);
  await c3.w.MarsaOps.views.payments.render(r3b, makeApi(c3, f3b.A, { hashQuery: () => ({ tx: TXA.id }) }).api, 'new'); await settle(5);
  fillMin(r3b);
  r3b.querySelector('[data-act="save"]').click(); await settle(30);
  check('a server duplicate (MRS_PAY_REF_TAKEN) is shown on the reference field with the earlier payment', () =>
    (!r3b.querySelector('#pay-f-receipt_no-e').hidden && /PAY-000012/.test(r3b.querySelector('#pay-f-receipt_no-e').textContent)) || r3b.querySelector('#pay-f-receipt_no-e').textContent);

  section('DOM: shared payment — live allocated / unallocated totals, allocation-linked invoices');
  const c4 = context(), D4 = c4.document;
  const f4 = formApi(c4);
  const r4 = D4.createElement('div'); D4.body.appendChild(r4);
  await c4.w.MarsaOps.views.payments.render(r4, makeApi(c4, f4.A, { hashQuery: () => ({ tx: TXA.id }) }).api, 'new'); await settle(5);
  setVal(r4, 'paid_amount', '100');
  setVal(r4, 'pattern', 'shared');
  check('switching to shared makes 2 allocations (the first keeps the transaction); no top-level transaction field', () =>
    (r4.querySelectorAll('[data-alloc]').length === 2 && /MRS-2026-000001/.test(r4.querySelector('[data-alloc="a1"]').textContent) && !byName(r4, 'tx') && !!byName(r4, 'alloc.a1.amount')) || r4.textContent.slice(0, 300));
  setVal(r4, 'alloc.a1.amount', '70');
  check('totals live: allocated 70, unallocated 30 (short)', () => (/70\.00 SAR/.test(r4.querySelector('.pay-totals').textContent) && /30\.00 SAR/.test(r4.querySelector('.pay-totals').textContent) && /is-short/.test(r4.querySelector('.pay-totals').className)) || r4.querySelector('.pay-totals').textContent);
  r4.querySelector('[data-fill="a2"]').click();
  check('«إكمال بالمتبقي» fills the rest → balanced', () => (byName(r4, 'alloc.a2.amount').value === '30.00' && /is-ok/.test(r4.querySelector('.pay-totals').className)) || byName(r4, 'alloc.a2.amount').value);
  r4.querySelector('[data-act="alloc-add"]').click();
  check('add allocation → 3 rows, each removable now', () => (r4.querySelectorAll('[data-alloc]').length === 3 && r4.querySelectorAll('[data-rm]').length === 3) || r4.querySelectorAll('[data-alloc]').length);
  r4.querySelector('[data-rm="a3"]').click();
  const pk = r4.querySelector('input[data-files="pick"]'); pk.files = [F('i1.pdf')]; pk.dispatch('change'); await settle(1);
  check('in shared mode each attachment has an allocation select; an entity invoice without one is refused locally', () => {
    const s = r4.querySelector('[data-alloc-of="0"]');
    setVal(r4, 'service_item_id', 'svc1'); setVal(r4, 'beneficiary_party_id', 'p1'); setVal(r4, 'funding_source', 'cash_box'); setVal(r4, 'receipt_no', 'R9');
    r4.querySelector('[data-act="save"]').click();
    return (s && s.options.length === 3 && /اربط كل فاتورة جهة بالتوزيع/.test(r4.querySelector('#pay-f-_files') ? '' : r4.textContent) && !f4.calls.some(x => x[0] === 'record')) || r4.textContent.slice(-400);
  });

  section('DOM: the draft is autosaved per user and restored after a refresh (files are not)');
  const c5 = context(), D5 = c5.document;
  const f5 = formApi(c5);
  const r5 = D5.createElement('div'); D5.body.appendChild(r5);
  await c5.w.MarsaOps.views.payments.render(r5, makeApi(c5, f5.A).api, 'new'); await settle(5);
  setVal(r5, 'paid_amount', '77.70'); setVal(r5, 'notes', 'ملاحظة مؤقتة', 'input');
  await settle(450);
  const key = Object.keys(c5.storage._m).filter(k => /pay-form\.new/.test(k))[0];
  check('sessionStorage key carries the user id and the scope', () => (key === 'marsa.draft.v1:' + ME + ':pay-form.new' && /77\.70/.test(c5.storage._m[key])) || Object.keys(c5.storage._m));
  const r5b = D5.createElement('div'); D5.body.appendChild(r5b);
  await c5.w.MarsaOps.views.payments.render(r5b, makeApi(c5, f5.A).api, 'new'); await settle(5);
  check('a new render (refresh) restores the values with a banner saying files are not kept', () =>
    (byName(r5b, 'paid_amount').value === '77.70' && /استُعيدت مسودة/.test(r5b.textContent) && /المرفقات لا تُحفظ/.test(r5b.textContent)) || r5b.textContent.slice(0, 300));
  const r5c = D5.createElement('div'); D5.body.appendChild(r5c);
  await c5.w.MarsaOps.views.payments.render(r5c, makeApi(c5, f5.A, { userId: OTHER }).api, 'new'); await settle(5);
  check('another user on the same tab sees an empty form', () => (byName(r5c, 'paid_amount').value === '' && !/استُعيدت مسودة/.test(r5c.textContent)) || 'leak');
  r5b.querySelector('[data-act="discard-draft"]').click(); await settle(5);
  check('discard → the draft is cleared and the form is empty', () => (!c5.storage._m[key] && byName(r5b, 'paid_amount').value === '') || J(Object.keys(c5.storage._m)));

  section('DOM: «قراءة المستندات بـ Claude» — one call per document, only empty fields filled, unique transaction suggested, nothing saved');
  const c6 = context(), D6 = c6.document;
  const f6 = formApi(c6);
  const r6 = D6.createElement('div'); D6.body.appendChild(r6);
  await c6.w.MarsaOps.views.payments.render(r6, makeApi(c6, f6.A).api, 'new'); await settle(5);
  setVal(r6, 'paid_amount', '50.00');
  setVal(r6, 'funding_source', 'org_account');
  const ai = r6.querySelector('input[data-ai="pick"]');
  ai.files = [F('inv.pdf'), F('proof.jpg', 3000, 'image/jpeg')]; ai.dispatch('change');
  check('the 2 documents are listed: first entity invoice, then payment proof', () => (r6.querySelector('[data-ai-kind="0"]').value === 'entity_invoice' && r6.querySelector('[data-ai-kind="1"]').value === 'payment_proof') || 'kinds');
  r6.querySelector('[data-act="ai-read"]').click(); await settle(60);
  const aic = f6.calls.filter(x => x[0] === 'ai');
  check('two aiExtract calls (appointment_invoice + payment_proof, ai-doc-v3), one document each', () =>
    J(aic.map(x => [x[1], x[2], x[3]])) === J([['appointment_invoice', 'ai-doc-v3', 'application/pdf'], ['payment_proof', 'ai-doc-v3', 'image/jpeg']]) || J(aic));
  check('only EMPTY fields are filled: the typed paid amount stays; claim (Reference No), internal FP, TAS, dates, method sadad + its SADAD no, the service item, the issuer as beneficiary (not Fasah)', () =>
    (byName(r6, 'paid_amount').value === '50.00' && byName(r6, 'claim_no').value === 'REF-55' && byName(r6, 'internal_invoice_no').value === 'FP998' && byName(r6, 'appointment_no') && byName(r6, 'appointment_no').value === 'TAS202611100001'
      && byName(r6, 'paid_at').value === '2026-11-08' && byName(r6, 'method').value === 'sadad' && byName(r6, 'sadad_number').value === '4455' && byName(r6, 'service_item_id').value === 'svc1'
      && byName(r6, 'beneficiary_party_id').value === 'p2' && byName(r6, 'expected_amount').value === '54.05') || J(['claim_no', 'paid_at', 'method', 'sadad_number', 'service_item_id', 'beneficiary_party_id', 'expected_amount'].map(n => byName(r6, n) && byName(r6, n).value)));
  check('warnings shown (amount mismatch); the unique transaction is pre-selected with a «check it» badge; the read files became typed attachments; nothing recorded', () =>
    (/يختلف عن مبلغ إثبات السداد/.test(r6.textContent) && f6.calls.some(x => x[0] === 'match' && x[1].bl_number === 'BL1') && /مقترحة من القراءة/.test(r6.textContent)
      && r6.querySelectorAll('.pay-files-box .pay-file').length === 2 && !f6.calls.some(x => x[0] === 'record') && /لا تحفظ ولا تعتمد شيئًا/.test(r6.textContent)) || r6.textContent.slice(0, 600));
  const c7 = context(), D7 = c7.document;
  const f7 = formApi(c7, { aiExtract: o => bad('MRS_AI_WRONG_DOCUMENT', 'not_payment_proof') });
  const r7 = D7.createElement('div'); D7.body.appendChild(r7);
  await c7.w.MarsaOps.views.payments.render(r7, makeApi(c7, f7.A).api, 'new'); await settle(5);
  const ai7 = r7.querySelector('input[data-ai="pick"]'); ai7.files = [F('a.pdf'), F('b.pdf')]; ai7.dispatch('change');
  r7.querySelector('[data-act="ai-read"]').click(); await settle(40);
  check('a wrong document: the error is shown on that document, nothing filled', () => (/تعذرت القراءة/.test(r7.textContent) && byName(r7, 'claim_no').value === '') || r7.textContent.slice(0, 300));
  const ai7b = r7.querySelector('input[data-ai="pick"]'); ai7b.files = [F('1.pdf'), F('2.pdf'), F('3.pdf'), F('4.pdf'), F('5.pdf')]; ai7b.dispatch('change');
  check('more than 6 documents → refused before any call (button disabled + message)', () => (r7.querySelector('[data-act="ai-read"]').disabled && /الحد الأقصى 6 مستندات/.test(r7.textContent)) || 'six');
}

async function detailFlows() {
  section('DOM: #payments/<id> — four eyes, approve / reject / void with reason, locks');
  const c = context(), D = c.document;
  const pay = (o) => Object.assign({ id: PAY_ID, ref: 'PAY-000031', branch_id: 'b1', movement_type: 'org_paid', pattern: 'single', status: 'recorded', review_status: 'pending', created_by: ME,
    paid_at: '2026-11-10', paid_amount: 54.05, expected_amount: 54.05, difference: 0, method: 'sadad', funding_source: 'org_account', sadad_number: '123', beneficiary_name: 'هيئة الموانئ',
    allocations: [{ id: 'al1', seq: 1, transaction_id: TXA.id, transaction_ref: 'MRS-2026-000001', amount: 54.05, claim_no: 'REF-1', supplier_invoice: { id: 'si1', invoice_number: 'REF-1', created_by_this: true } }],
    documents: [{ id: 'l1', role: 'payment_proof', original_name: 'proof.pdf', size_bytes: 2048, storage_path: 'o/b/x' }], four_eyes: { creator: ME, can_review: false }, custody_deductions: [] }, o || {});
  const calls = [];
  let cur = pay();
  const A = { getPayment: id => { calls.push(['get', id]); return ok(cur); }, reviewPayment: (id, d, n) => { calls.push(['review', id, d, n]); return ok(cur); },
    voidPayment: (id, r) => { calls.push(['void', id, r]); return ok(cur); }, removePaymentDocument: (l, r) => { calls.push(['rm', l, r]); return ok(cur); },
    uploadFinanceDocument: o => ok({ id: 'd9' }), addPaymentDocuments: (id, docs, o) => { calls.push(['add', id, docs, o && o.idemKey]); return ok(cur); }, financeDocumentUrl: () => ok('https://x') };
  const r1 = D.createElement('div'); D.body.appendChild(r1);
  await c.w.MarsaOps.views.payments.render(r1, makeApi(c, A).api, PAY_ID); await settle(5);
  check('my own pending payment: the four-eyes message, no approve / reject; correct + void offered (approver, not locked); share table + invoice link', () =>
    (/فلا يمكنك اعتماده أو رفضه/.test(r1.textContent) && !r1.querySelector('[data-act="approve"]') && !r1.querySelector('[data-act="reject"]') && r1.querySelector('[data-act="correct"]').href === '#payments/new?correct=' + PAY_ID
      && r1.querySelector('[data-act="void"]') && r1.querySelectorAll('a').some(a => a.href === '#costs/si1') && /أُنشئت من هذا السداد/.test(r1.textContent)) || r1.textContent.slice(0, 500));
  cur = pay({ created_by: OTHER, four_eyes: { creator: OTHER, can_review: true } });
  const r2 = D.createElement('div'); D.body.appendChild(r2);
  const M2 = makeApi(c, A);
  await c.w.MarsaOps.views.payments.render(r2, M2.api, PAY_ID); await settle(5);
  r2.querySelector('[data-act="approve"]').click(); await settle(10);
  check('another approver: approve behind a confirm → reviewPayment(id, approve)', () => (M2.log.confirms.length === 1 && calls.some(x => x[0] === 'review' && x[2] === 'approve')) || J(calls));
  r2.querySelector('[data-act="reject"]').click(); await settle(1);
  r2.querySelector('[data-go="reject"]').click(); await settle(5);
  check('reject needs a note (≥ 3 characters)', () => (!calls.some(x => x[2] === 'reject') && /3 أحرف على الأقل/.test(r2.textContent)) || 'reject');
  r2.querySelector('#pay-rp-reject').value = 'المبلغ غير مطابق'; r2.querySelector('[data-go="reject"]').click(); await settle(10);
  check('reject with the note → reviewPayment(id, reject, note)', () => calls.some(x => x[0] === 'review' && x[2] === 'reject' && x[3] === 'المبلغ غير مطابق') || J(calls));
  r2.querySelector('[data-act="void"]').click(); await settle(1);
  r2.querySelector('#pay-rp-void').value = 'سداد مكرر'; r2.querySelector('[data-go="void"]').click(); await settle(10);
  check('void with a reason → voidPayment(id, reason)', () => calls.some(x => x[0] === 'void' && x[2] === 'سداد مكرر') || J(calls));
  // more attachments on a recorded payment
  const pk = r2.querySelector('input[data-files="pick"]'); pk.files = [F('extra.pdf')]; pk.dispatch('change'); await settle(1);
  r2.querySelector('[data-role-of="0"]').value = 'extra'; r2.querySelector('[data-role-of="0"]').dispatch('change');
  r2.querySelector('[data-act="add-docs"]').click(); await settle(20);
  check('add attachments: uploaded then addPaymentDocuments(id, [{doc, role}], idemKey)', () =>
    calls.some(x => x[0] === 'add' && x[1] === PAY_ID && J(x[2]) === J([{ finance_document_id: 'd9', role: 'extra' }]) && x[3]) || J(calls.filter(x => x[0] === 'add')));
  r2.querySelector('[data-remove="l1"]').click(); await settle(1);
  r2.querySelector('#pay-rp-rm-l1').value = 'ملف خاطئ'; r2.querySelector('[data-go="rm-l1"]').click(); await settle(10);
  check('remove an attachment (soft) with a reason → removePaymentDocument(link, reason)', () => calls.some(x => x[0] === 'rm' && x[1] === 'l1' && x[2] === 'ملف خاطئ') || J(calls));
  cur = pay({ created_by: OTHER, four_eyes: { can_review: false }, custody_deductions: [{ id: 'e1', ref: 'CUS-000001', amount: 10, status: 'active' }] });
  const r3 = D.createElement('div'); D.body.appendChild(r3);
  await c.w.MarsaOps.views.payments.render(r3, makeApi(c, A).api, PAY_ID); await settle(5);
  check('a payment deducted from custody: lock message, no void / correct', () => (/ألغِ حركة الخصم أولًا/.test(r3.textContent) && !r3.querySelector('[data-act="void"]') && !r3.querySelector('[data-act="correct"]')) || r3.textContent.slice(0, 300));
  cur = pay({ created_by: OTHER, four_eyes: { can_review: true } });
  const A4 = Object.assign({}, A, { reviewPayment: () => bad('MRS_FORBIDDEN', 'self_approval') });
  const r4 = D.createElement('div'); D.body.appendChild(r4);
  const M4 = makeApi(c, A4);
  await c.w.MarsaOps.views.payments.render(r4, M4.api, PAY_ID); await settle(5);
  r4.querySelector('[data-act="approve"]').click(); await settle(10);
  check('the server\'s self_approval refusal is explained as the four-eyes rule (not a generic "forbidden")', () => (M4.log.toasts.some(x => x[0] === 'error' && /مبدأ الأربعة أعين/.test(x[1]))) || J(M4.log.toasts));
  cur = pay({ created_by: OTHER, four_eyes: { can_review: false } });
  const r5 = D.createElement('div'); D.body.appendChild(r5);
  await c.w.MarsaOps.views.payments.render(r5, makeApi(c, A, { can: (set) => set === 'finRead' }).api, PAY_ID); await settle(5);
  check('a finance reader: no action at all (no submit / approve / correct / void / remove / add documents)', () =>
    (!r5.querySelector('[data-act]') && !r5.querySelector('[data-remove]')) || r5.querySelectorAll('[data-act]').map(b => b.getAttribute('data-act')));
}

async function correctFlow() {
  section('DOM: correct = void + re-record in one call (#payments/new?correct=<id>)');
  const c = context(), D = c.document;
  const old = { id: PAY_ID, ref: 'PAY-000031', branch_id: 'b1', movement_type: 'org_paid', pattern: 'single', status: 'recorded', review_status: 'rejected', service_item_id: 'svc1',
    paid_at: '2026-11-05', paid_amount: 54.05, expected_amount: 54.05, funding_source: 'fasah_wallet', method: 'fasah_wallet', payer_name: 'محفظة فسح', beneficiary_party_id: 'p2', receipt_no: 'W-1',
    allocations: [{ id: 'al1', seq: 1, transaction_id: TXA.id, transaction_ref: 'MRS-2026-000001', client_id: 'c1', client_name: 'عميل ١', amount: 54.05, claim_no: 'REF-1' }],
    documents: [{ id: 'l1', role: 'payment_proof', original_name: 'proof.pdf' }, { id: 'l2', role: 'extra', original_name: 'x.pdf' }] };
  const f = formApi(c, { getPayment: id => ok(old), correctPayment: (id, p, r, o) => { f.calls.push(['correct', id, p, r, o && o.idemKey]); return ok({ voided: old, payment: { id: 'new-id', ref: 'PAY-000032' }, changed: ['paid_amount'] }); } });
  const root = D.createElement('div'); D.body.appendChild(root);
  const M = makeApi(c, f.A, { hashQuery: () => ({ correct: PAY_ID }) });
  await c.w.MarsaOps.views.payments.render(root, M.api, 'new'); await settle(5);
  check('the form is prefilled from the payment (transaction, claim, wallet, reference) with the carried attachments listed', () =>
    (byName(root, 'paid_amount').value === '54.05' && byName(root, 'claim_no').value === 'REF-1' && byName(root, 'method').value === 'fasah_wallet' && byName(root, 'receipt_no').value === 'W-1'
      && /MRS-2026-000001/.test(root.textContent) && root.querySelectorAll('[data-carried]').length === 2 && /تصحّح السداد PAY-000031/.test(root.textContent)) || root.textContent.slice(0, 400));
  setVal(root, 'paid_amount', '50');
  root.querySelector('[data-act="save"]').click(); await settle(5);
  check('a reason is required', () => (!f.calls.some(x => x[0] === 'correct') && !root.querySelector('#pay-f-reason-e').hidden) || 'reason');
  root.querySelector('[data-name="reason"]').value = 'المبلغ الصحيح 50'; root.querySelector('[data-name="reason"]').dispatch('input');
  const cb = root.querySelector('[data-carried="l2"]'); cb.checked = true; cb.dispatch('change');
  root.querySelector('[data-act="save"]').click(); await settle(20);
  const cc = f.calls.filter(x => x[0] === 'correct')[0];
  check('correctPayment(old id, the whole form, reason, idemKey); the unticked attachment is removed, the proof carried; go to the new entry', () =>
    (cc && cc[1] === PAY_ID && cc[2].paid_amount === 50 && cc[2].transaction_id === TXA.id && J(cc[2].remove_document_ids) === J(['l2']) && cc[3] === 'المبلغ الصحيح 50' && cc[4]
      && !f.calls.some(x => x[0] === 'record') && M.log.go[0] === '#payments/new-id' && /PAY-000032/.test(M.log.toasts[0][1])) || J([cc, M.log]));
}

async function txSectionFlow() {
  section('DOM: the transaction payments section (share only, add payment pre-linked)');
  const c = context(), D = c.document;
  const A = { txDisbursements: id => ok({ transaction_id: id, ref: 'MRS-2026-000001', count: 2, total_share: 130.5, pending_review: 1, rejected: 0, last_paid_at: '2026-11-10', custody_balance: 400,
    by_movement: { org_paid: 100, client_direct: 30.5 },
    items: [{ id: PAY_ID, ref: 'PAY-000031', pattern: 'shared', share: 100, paid_at: '2026-11-10', method: 'sadad', funding_source: 'org_account', review_status: 'pending', movement_type: 'org_paid', service_name_ar: 'موعد دخول', document_count: 2 },
      { id: 'x2', ref: 'PAY-000032', pattern: 'single', share: 30.5, paid_at: '2026-11-09', method: 'cash', funding_source: 'client_direct', review_status: 'approved', movement_type: 'client_direct' }] }) };
  const sec = c.w.MarsaOps.txSections.filter(s => s.id === 'fin-payments')[0];
  const h = D.createElement('div'); D.body.appendChild(h);
  const k = makeApi(c, A); k.api.el = opsEl(D);
  await sec.render(h, { id: TXA.id, branch_id: 'b1' }, k.api); await settle(5);
  check('share-only totals, pending count, last date, custody balance; the shared payment shows its share (100), not its total', () =>
    (/130\.50 SAR/.test(h.textContent) && /100\.00 SAR/.test(h.textContent) && /سداد مشترك/.test(h.textContent) && /400\.00 SAR/.test(h.textContent) && /هذه المعاملة فقط/.test(h.textContent)
      && h.querySelectorAll('[data-pay]').length === 2 && /مرفقات: 2/.test(h.textContent)) || h.textContent.slice(0, 500));
  check('«إضافة سداد» → #payments/new?tx=<id>; «كل سدادات المعاملة» → #payments?tx=<id>', () =>
    (h.querySelector('[data-act="pay-add"]').href === '#payments/new?tx=' + TXA.id && h.querySelector('[data-act="pay-all"]').href === '#payments?tx=' + TXA.id) || 'links');
  const h2 = D.createElement('div'); D.body.appendChild(h2);
  const k2 = makeApi(c, A, { can: s => s === 'finRead' }); k2.api.el = opsEl(D);
  await sec.render(h2, { id: TXA.id, branch_id: 'b1' }, k2.api); await settle(5);
  const h3 = D.createElement('div');
  const k3 = makeApi(c, A, { can: () => false }); k3.api.el = opsEl(D);
  const r3 = sec.render(h3, { id: TXA.id, branch_id: 'b1' }, k3.api);
  check('a finance reader sees the panel without «إضافة سداد»; a non-finance role sees nothing', () => (!h2.querySelector('[data-act="pay-add"]') && h2.querySelector('[data-act="pay-all"]') && r3 === null && !h3.children.length) || 'roles');
}
function opsEl(document) {
  return (tag, attrs, kids) => {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(k => { const v = attrs[k]; if (v == null || v === false) return; if (k === 'class') n.className = v; else if (k === 'text') n.textContent = String(v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); });
    [].concat(kids == null ? [] : kids).forEach(function add(c) { if (c == null || c === false) return; if (Array.isArray(c)) return c.forEach(add); n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  };
}

async function custodyFlows() {
  section('DOM: #custody — balances, ledger, deduction with its maximum, void refusal explained');
  const c = context(), D = c.document;
  const calls = [];
  let voidAnswer = bad('MRS_CUSTODY_NEGATIVE', 'void_deposit', '40.00');
  const A = {
    custodyBalances: (org, f) => { calls.push(['bal', f]); return ok({ rows: [{ client_id: 'c1', client_name: 'عميل ١', balance: 400, total_deposits: 500, total_deductions: 100, total_refunds: 0, entry_count: 3, last_entry_date: '2026-11-10' }], total_balance: 400 }); },
    listClients: o => ok([{ id: 'c1', name_ar: 'عميل ١' }, { id: 'c2', name_ar: 'عميل ٢' }]),
    listCustodyEntries: (org, f) => { calls.push(['list', f]); return ok(f.kind === 'deduction' ? { rows: [{ id: 'e7', disbursement_id: 'pd', ref: 'CUS-000007', kind: 'deduction', status: 'active' }], total: 1 }
      : { total: 1, rows: [{ id: 'e1', ref: 'CUS-000001', client_id: 'c1', client_name: 'عميل ١', kind: 'deposit', amount: 500, signed_amount: 500, entry_date: '2026-11-01', status: 'active', branch_id: 'b1' }] }); },
    clientCustodyBalance: id => { calls.push(['cbal', id]); return ok({ client_id: id, balance: 400, total_deposits: 500, total_deductions: 100, total_refunds: 0, entry_count: 3, last_entry_date: '2026-11-10' }); },
    listTransactions: o => { calls.push(['txs', o]); return ok([{ id: TXA.id, ref: 'MRS-2026-000001', client_id: 'c1', branch_id: 'b1' }]); },
    txDisbursements: id => ok({ items: [{ id: 'pa', ref: 'PAY-000031', share: 120, service_name_ar: 'موعد دخول' }, { id: 'pd', ref: 'PAY-000030', share: 50 }] }),
    saveCustodyEntry: (p, o) => { calls.push(['save', p, o && o.idemKey]); return ok({ id: 'e9', ref: 'CUS-000009', balance: 280 }); },
    voidCustodyEntry: (id, r) => { calls.push(['void', id, r]); return voidAnswer; }
  };
  const root = D.createElement('div'); D.body.appendChild(root);
  const M = makeApi(c, A);
  await c.w.MarsaOps.views.custody.render(root, M.api); await settle(10);
  check('balances tab: total tile, the client row with balance / deposits / deductions; non-zero filter sent', () =>
    (calls.some(x => x[0] === 'bal' && x[1].nonzero === true) && /400\.00 SAR/.test(root.textContent) && !!root.querySelector('tr[data-client="c1"]') && /3 حركة/.test(root.textContent)) || root.textContent.slice(0, 300));
  root.querySelector('[data-new-for="c1"]').click(); await settle(10);
  const form = root.querySelector('.cu-form');
  check('new entry for the client: current balance shown, deposit by default, today (Riyadh)', () =>
    (form && /رصيد العهدة الحالي/.test(form.textContent) && /400\.00 SAR/.test(form.textContent) && byName(form, 'kind').value === 'deposit' && byName(form, 'entry_date').value === P.riyadhToday()) || (form && form.textContent));
  setVal(form, 'kind', 'deduction'); await settle(5);
  setVal(form, 'transaction_id', TXA.id); await settle(10);
  const payOpts = byName(form, 'disbursement_id').options;
  check('deduction: the client\'s transactions; its payments with the transaction share; an already deducted payment is disabled', () =>
    (calls.some(x => x[0] === 'txs' && x[1].clientId === 'c1' && x[1].cancelled === 'exclude') && payOpts.length === 3 && /120\.00 SAR/.test(payOpts[1].textContent)
      && payOpts[2].disabled && /مخصوم سابقًا/.test(payOpts[2].textContent)) || payOpts.map(o => [o.value, o.textContent, o.disabled]));
  setVal(form, 'disbursement_id', 'pa');
  check('the maximum is shown: min(share 120, balance 400)', () => /الحد الأعلى للخصم 120\.00 SAR/.test(form.textContent) || form.textContent.slice(-300));
  setVal(form, 'amount', '130');
  form.querySelector('[data-act="cu-save"]').click(); await settle(5);
  check('over the payment share → refused locally (nothing sent)', () => (!calls.some(x => x[0] === 'save') && /أكبر من حصة السداد/.test(form.textContent)) || form.textContent.slice(-300));
  setVal(form, 'amount', '120'); setVal(form, 'reference', 'خصم');
  form.querySelector('[data-act="cu-save"]').click(); await settle(10);
  const sv = calls.filter(x => x[0] === 'save')[0];
  check('save → saveCustodyEntry({client, deduction, 120, date, transaction, payment, reference}, idemKey); toast with the new balance', () =>
    (sv && J(sv[1]) === J({ client_id: 'c1', kind: 'deduction', amount: 120, entry_date: P.riyadhToday(), transaction_id: TXA.id, disbursement_id: 'pa', reference: 'خصم' }) && sv[2]
      && M.log.toasts.some(t => /CUS-000009/.test(t[1]) && /280\.00 SAR/.test(t[1]))) || J([sv, M.log.toasts]));
  root.querySelector('[data-ledger="c1"]').click(); await settle(10);
  check('ledger of the client: filters sent; the deposit row with its void action', () =>
    (calls.some(x => x[0] === 'list' && x[1].client_id === 'c1' && x[1].status === 'all') && !!root.querySelector('tr[data-entry="e1"]') && !!root.querySelector('[data-void="e1"]')) || root.textContent.slice(0, 300));
  root.querySelector('[data-void="e1"]').click(); await settle(1);
  root.querySelector('[data-void-go="e1"]').click(); await settle(5);
  check('void needs a reason ≥ 3 characters', () => (!calls.some(x => x[0] === 'void') && /3 أحرف على الأقل/.test(root.textContent)) || 'reason');
  root.querySelector('#cu-void-e1').value = 'إيداع خاطئ'; root.querySelector('[data-void-go="e1"]').click(); await settle(10);
  check('voiding a deposit that would make the balance negative: refused with a clear message (balance) and what to do first', () =>
    (calls.some(x => x[0] === 'void' && x[2] === 'إيداع خاطئ') && /سيصبح رصيد عهدة العميل سالبًا \(الرصيد الحالي 40\.00 ريال\)/.test(root.textContent) && /ألغِ أولًا حركات الخصم أو الإرجاع/.test(root.textContent)) || root.textContent.slice(0, 600));
  const r2 = D.createElement('div'); D.body.appendChild(r2);
  await c.w.MarsaOps.views.custody.render(r2, makeApi(c, A, { can: s => s === 'finRead' }).api); await settle(10);
  check('a finance reader: no new entry, no void', () => (!r2.querySelector('[data-act="cu-new"]') && !r2.querySelector('[data-void]') && !r2.querySelector('[data-new-for]')) || 'reader');
  const r3 = D.createElement('div'); D.body.appendChild(r3);
  await c.w.MarsaOps.views.custody.render(r3, makeApi(c, A, { hashQuery: () => ({ client: '00000000-0000-4000-8000-0000000000c1' }) }).api); await settle(10);
  check('#custody?client=<id> opens the ledger of that client', () => calls.some(x => x[0] === 'list' && x[1].client_id === '00000000-0000-4000-8000-0000000000c1') || 'query');
  const nList = calls.filter(x => x[0] === 'list').length;
  const r3b = D.createElement('div'); D.body.appendChild(r3b);
  await c.w.MarsaOps.views.custody.render(r3b, makeApi(c, A, { hashQuery: () => ({}) }).api); await settle(10);
  check('after #custody?client=<id>, a plain #custody reopens on the balances tab (client filter not sticky)', () =>
    calls.filter(x => x[0] === 'list').length === nList || J(calls.slice(-3)));

  section('DOM: the custody draft, the client page balance');
  const c2 = context(), D2 = c2.document;
  const r4 = D2.createElement('div'); D2.body.appendChild(r4);
  const M4 = makeApi(c2, A);
  await c2.w.MarsaOps.views.custody.render(r4, M4.api); await settle(10);
  r4.querySelector('[data-act="cu-new"]').click(); await settle(10);
  const f4 = r4.querySelector('.cu-form');
  setVal(f4, 'amount', '33'); await settle(450);
  const r5 = D2.createElement('div'); D2.body.appendChild(r5);
  await c2.w.MarsaOps.views.custody.render(r5, makeApi(c2, A).api); await settle(20);
  check('an unsaved custody entry reopens after a refresh with its values (per user, sessionStorage)', () =>
    (r5.querySelector('.cu-form') && byName(r5.querySelector('.cu-form'), 'amount').value === '33' && /استُعيدت مسودة حركة/.test(r5.textContent)) || r5.textContent.slice(0, 300));
  const cs = c2.w.MarsaOps.clientSections.filter(s => s.id === 'custody')[0];
  const h = D2.createElement('div');
  await cs.render(h, { id: 'c1' }, makeApi(c2, A).api); await settle(5);
  const h2 = D2.createElement('div');
  const none = cs.render(h2, { id: 'c1' }, makeApi(c2, A, { can: () => false }).api);
  check('client page: the balance card (finance readers) with the ledger link; nothing for other staff', () =>
    (/عهدة العميل/.test(h.textContent) && /400\.00 SAR/.test(h.textContent) && h.querySelector('[data-act="cu-ledger"]').href === '#custody?client=c1' && none === null && !h2.children.length) || h.textContent);
}

/* ================================================================ review fixes (regressions) */
async function reviewFixFlows() {
  section('review fixes: pure helpers (reuse confirmation, FP claim, correct-mode state, shared VAT, hidden duplicates, AI merge, file types)');
  const st = Object.assign(P.emptyState('2026-11-10'), { movement_type: 'org_paid', funding_source: 'cash_box', method: 'cash', receipt_no: 'R1', paid_amount: '10',
    beneficiary_party_id: 'p1', claim_no: 'REF-1', tx: { id: TXA.id, branch_id: 'b1' }, service_item_id: 'svc2' });
  st.confirm_reuse = true; st.confirm_reuse_sig = P.reuseSig(st);
  const p1 = P.buildPayload(st, []);
  const st2 = Object.assign({}, st, { claim_no: 'REF-2' }), st3 = Object.assign({}, st, { beneficiary_party_id: 'p2' }), st4 = Object.assign({}, st, { notes: 'x' });
  eq('the invoice-reuse confirmation covers exactly what was confirmed: a new claim no / issuer makes it stale; other edits keep it', [p1.confirm_invoice_reuse,
    P.buildPayload(st2, []).confirm_invoice_reuse, P.buildPayload(st3, []).confirm_invoice_reuse, P.buildPayload(st4, []).confirm_invoice_reuse,
    P.buildPayload(Object.assign({}, st, { confirm_reuse_sig: '' }), []).confirm_invoice_reuse], [true, undefined, undefined, true, undefined]);
  const sh = Object.assign(P.emptyState('2026-11-10'), { pattern: 'shared', beneficiary_party_id: 'p1', allocations: [{ key: 'a1', tx: { id: 't1' }, amount: '5', claim_no: 'X1' }, { key: 'a2', tx: { id: 't2' }, amount: '5', claim_no: 'X2' }] });
  const sig = P.reuseSig(sh), shB = JSON.parse(JSON.stringify(sh)); shB.allocations[1].claim_no = 'X3';
  check('shared: changing one allocation\'s claim no changes the confirmation signature; the session draft never keeps the confirmation', () =>
    (sig !== P.reuseSig(shB) && P.draftState(st).confirm_reuse === false && P.draftState(st).confirm_reuse_sig === '' && st.confirm_reuse === true) || 'sig');
  eq('an appointment fee refuses an FP… claim no locally (claim_fp, single and shared); other services accept it; errorField places the server detail', [
    P.validate(Object.assign({}, st, { claim_no: 'FP0012' }), [], { today: '2026-11-10', serviceCode: 'gate_in_appointment' }).claim_no,
    P.validate(Object.assign({}, st, { claim_no: 'FP0012' }), [], { today: '2026-11-10', serviceCode: 'port_charges' }).claim_no,
    P.validate(Object.assign({}, sh, { paid_amount: '10', method: 'sadad', funding_source: 'org_account', paying_account: 'b', sadad_number: '1', allocations: [sh.allocations[0], Object.assign({}, sh.allocations[1], { claim_no: 'fp-9' })] }), [], { today: '2026-11-10', serviceCode: 'gate_out_appointment' })['alloc.a2.claim_no'],
    P.errorField({ code: 'MRS_INVALID', field: 'claim_no_fp' }), P.errorField({ code: 'MRS_INVALID', field: 'internal_invoice_mismatch' })],
    ['claim_fp', undefined, 'claim_fp', 'claim_no', 'internal_invoice_no']);
  const recP = { movement_type: 'org_paid', pattern: 'single', paid_at: '2026-10-02', paid_amount: 100, expected_amount: 100, funding_source: 'org_account', method: 'sadad', sadad_number: '1',
    allocations: [{ seq: 1, transaction_id: 't1', claim_no: 'INV1', supplier_invoice: { id: 'si', total_amount: 115, invoice_date: '2026-09-30', vat_amount: 15, created_by_this: true } }] };
  const cs = P.stateFromPayment(recP, '2026-11-10');
  const applied = P.applySuggestion(cs, { paid_at: '2026-11-05', invoice_date: '2026-11-01', invoice_vat_amount: 3 }, {});
  check('correct mode: the recorded payment date is never replaced by a reading; invoice date + VAT come from the booked invoice and are sent again', () =>
    (cs.paid_at_touched === true && applied.state.paid_at === '2026-10-02' && applied.filled.indexOf('paid_at') === -1 && cs.invoice_date === '2026-09-30' && cs.invoice_vat_amount === '15.00'
      && applied.state.invoice_vat_amount === '15.00' && P.buildPayload(cs, []).invoice_vat_amount === 15 && P.buildPayload(cs, []).invoice_date === '2026-09-30') || J({ cs: [cs.paid_at_touched, cs.invoice_date, cs.invoice_vat_amount], a: applied.state.paid_at }));
  const shS = P.stateFromPayment({ movement_type: 'org_paid', pattern: 'shared', paid_at: '2026-10-02', paid_amount: 20, method: 'sadad', funding_source: 'org_account',
    allocations: [{ seq: 1, transaction_id: 't1', amount: 10, claim_no: 'A', supplier_invoice: { invoice_date: '2026-09-01', vat_amount: 1.3 } }, { seq: 2, transaction_id: 't2', amount: 10, claim_no: 'B' }] }, '2026-11-10');
  const shP = P.buildPayload(shS, []);
  eq('shared: each allocation carries its invoice VAT (form, payload, correction prefill); a bad VAT is refused locally', [shP.allocations.map(a => [a.invoice_vat_amount, a.invoice_date || null]),
    P.validate(Object.assign({}, shS, { allocations: [Object.assign({}, shS.allocations[0], { invoice_vat_amount: '-1' }), shS.allocations[1]] }), [], { today: '2026-11-10' })['alloc.a1.invoice_vat_amount'],
    P.emptyAlloc([]).invoice_vat_amount], [[[1.3, '2026-09-01'], [undefined, null]], 'money_zero', '']);
  const hl = P.dupLines({ references: [{ field: 'sadad_number', hidden: true, id: null, ref: null, amount: null }], invoices: [{ claim_no: 'X', kind: 'taken', hidden: true, ref: null }] });
  check('duplicates of a branch the user cannot read: «taken in another branch», no ref / amount placeholders', () =>
    (hl.length === 2 && hl[0].key === 'dup_ref_hidden' && hl[1].key === 'dup_inv_taken_hidden' && /فرع آخر/.test(I18N.t('pay.' + hl[0].key, hl[0].vars)) && !/\{|—/.test(I18N.t('pay.' + hl[0].key, hl[0].vars))) || J(hl));
  check('claimKey ignores separators like the server key (INV-123/456 = INV 123456 = INV123456)', () =>
    (P.claimKey('INV-123/456') === P.claimKey('INV 123456') && P.claimKey('INV123456') === 'INV123456' && P.claimKey('inv-0012') === P.claimKey('INV 12')) || P.claimKey('INV-123/456'));
  const inv1 = { payment: { kind: 'invoice', issuer_name: 'هيئة الموانئ', invoice_no: 'R1', total: 100 } };
  const pr = (amt, ref) => ({ payment: { kind: 'proof', amount: amt, method: 'sadad', sadad_number: ref || '123' } });
  const m1 = PA.merge([inv1, pr(100), pr(100)]), m2 = PA.merge([inv1, pr(100), pr(90, '9')]);
  eq('AI merge: two proofs of ONE payment are not added up (first proof decides); a different second amount warns proofs_differ', [m1.suggestion.paid_amount, m1.warnings.map(w => w.code),
    m2.suggestion.paid_amount, m2.warnings.map(w => w.code)], [100, [], 100, ['proofs_differ']]);
  const m3 = PA.merge([{ payment: { kind: 'invoice', invoice_no: 'A', total: 10, vat_amount: 1.3, invoice_date: '2026-11-01' } }, { payment: { kind: 'invoice', invoice_no: 'B', total: 20, vat_amount: 2.61 } }]);
  eq('AI merge: suggested allocations carry each invoice\'s VAT and date', m3.allocations_suggested.map(a => [a.claim_no, a.invoice_vat_amount, a.invoice_date]), [['A', 1.3, '2026-11-01'], ['B', 2.61, null]]);
  eq('file types agree: what Claude reads is an attachment type (no GIF); HEIC is attached, not read', [PA.checkFiles([{ size: 10, type: 'image/gif' }]).field, PA.checkFiles([{ size: 10, type: 'image/heic' }]).field,
    P.filesCheck([{ name: 'a.heic', size: 10, type: 'image/heic' }]), /image\/gif/.test(SRC.pay), /image\/gif/.test(SRC.payai)], ['type', 'type', null, false, false]);

  section('DOM: review fixes — the reuse confirmation is not sticky; approved evidence locked; custody search keeps focus');
  const c = context(), D = c.document;
  let n = 0;
  const f = formApi(c, { recordPaymentBundle: (p, o) => { f.calls.push(['record', p, o]); n++;
    return n === 1 ? bad('MRS_CONFIRM_INVOICE_REUSE', 'invoice_number', 'REF-1 · جهة أخرى') : n === 2 ? bad('MRS_PAY_REF_TAKEN', 'receipt_no', 'PAY-000012 · MRS-2026-000007 · 1.00 SAR')
      : n === 3 ? bad('MRS_CONFIRM_INVOICE_REUSE', 'invoice_number', 'REF-9 · جهة ثالثة') : ok({ id: PAY_ID, ref: 'PAY-000050' }); } });
  const root = D.createElement('div'); D.body.appendChild(root);
  const M = makeApi(c, f.A, { hashQuery: () => ({ tx: TXA.id }) });
  await c.w.MarsaOps.views.payments.render(root, M.api, 'new'); await settle(5);
  setVal(root, 'service_item_id', 'svc2'); setVal(root, 'beneficiary_party_id', 'p1'); setVal(root, 'paid_amount', '10'); setVal(root, 'claim_no', 'REF-1');
  setVal(root, 'funding_source', 'cash_box'); setVal(root, 'receipt_no', 'R-1');
  root.querySelector('[data-act="save"]').click(); await settle(40);
  await settle(450);
  const draftTxt = Object.keys(c.storage._m).map(k => c.storage._m[k]).join(' ');
  setVal(root, 'claim_no', 'REF-9'); setVal(root, 'receipt_no', 'R-2');
  root.querySelector('[data-act="save"]').click(); await settle(40);
  const rr = f.calls.filter(x => x[0] === 'record');
  check('confirmed REF-1, the retry failed on the receipt, the claim was then changed to REF-9: the next save does NOT carry the old confirmation and asks again', () =>
    (rr.length === 4 && rr[1][1].confirm_invoice_reuse === true && rr[2][1].confirm_invoice_reuse === undefined && rr[3][1].confirm_invoice_reuse === true && rr[3][1].claim_no === 'REF-9'
      && M.log.confirms.length === 2 && /جهة ثالثة/.test(M.log.confirms[1].text)) || J({ n: rr.length, c: rr.map(x => x[1].confirm_invoice_reuse), confirms: M.log.confirms.length }));
  check('the session draft never stores the reuse confirmation', () => (draftTxt.length > 10 && !/"confirm_reuse":true/.test(draftTxt)) || draftTxt.slice(0, 200));

  const pay = Object.assign({ id: PAY_ID, ref: 'PAY-000031', branch_id: 'b1', movement_type: 'org_paid', pattern: 'single', status: 'recorded', review_status: 'approved', created_by: OTHER,
    paid_at: '2026-11-10', paid_amount: 5, expected_amount: 5, difference: 0, method: 'fasah_wallet', funding_source: 'fasah_wallet', allocations: [{ id: 'al1', seq: 1, transaction_id: TXA.id, amount: 5 }],
    documents: [{ id: 'l1', role: 'payment_proof', original_name: 'proof.pdf', size_bytes: 2048, storage_path: 'o/b/x' }], four_eyes: { creator: OTHER, can_review: false }, custody_deductions: [] });
  const r2 = D.createElement('div'); D.body.appendChild(r2);
  await c.w.MarsaOps.views.payments.render(r2, makeApi(c, { getPayment: () => ok(pay), financeDocumentUrl: () => ok('https://x') }).api, PAY_ID); await settle(5);
  check('an approved payment: no add / remove attachment controls, a note explains «correct» instead', () =>
    (!r2.querySelector('[data-remove]') && !r2.querySelector('[data-act="add-docs"]') && !!r2.querySelector('[data-note="docs-locked"]') && /معتمد/.test(r2.querySelector('[data-note="docs-locked"]').textContent)) || r2.textContent.slice(0, 300));

  const c3 = context(), D3 = c3.document;
  const cc = [];
  const A3 = { custodyBalances: (org, fl) => { cc.push(['bal', fl]); return ok({ rows: [], total_balance: 0 }); }, listClients: () => ok([{ id: 'c1', name_ar: 'عميل ١' }]),
    listCustodyEntries: (org, fl) => { cc.push(['list', fl]); return ok({ rows: [], total: 0 }); } };
  const r3 = D3.createElement('div'); D3.body.appendChild(r3);
  await c3.w.MarsaOps.views.custody.render(r3, makeApi(c3, A3).api); await settle(10);
  const sb = r3.querySelector('input[type="search"]'); sb.value = 'عم'; sb.dispatch('input'); await settle(250);
  const same1 = r3.querySelector('input[type="search"]') === sb;
  sb.value = 'عميل'; sb.dispatch('input'); await settle(250);
  check('custody balances: the search box is not rebuilt by the reload it triggers (typing continues in the same input)', () =>
    (same1 && r3.querySelector('input[type="search"]') === sb && cc.filter(x => x[0] === 'bal').some(x => x[1].q === 'عميل')) || J(cc));
}

(async function () {
  await registerFlow();
  await formFlows();
  await detailFlows();
  await correctFlow();
  await txSectionFlow();
  await custodyFlows();
  await reviewFixFlows();
  await settle(20);
  console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.log('FAILED: ' + (e && e.stack || e)); process.exit(1); });
