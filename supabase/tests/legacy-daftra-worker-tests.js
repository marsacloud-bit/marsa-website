#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 7 (Daftra alignment): the daftra-sync WORKER side of docs/online/LEGACY_DAFTRA_AR.md
  «عقد المهام». LOCAL TESTS ONLY. No real Daftra, no key, NO NETWORK: globalThis.fetch throws; the live adapter
  (daftra-live.js) talks to the in-memory fake Daftra API v2 of tests/lib/fake-daftra-server.js through its socket-free
  stub transport (server.inProcess(): a stubbed fetch), so every HTTP method / path / query / body is asserted exactly.

  Sections
    0. static: classic scripts, no fetch / env / key, the new API, index.ts passes the policy and never follows redirects
    1. adapter.js helpers: zero-insensitive codes, Riyadh date (Intl), dates, KSA check, CustomModel, containers, error codes
    2. the request guard: HF5 (no write on an existing invoice), resolve-only products, purchase drafts (zero tax, ?send=draft)
    3. worker + MOCK adapter (contexts in the DB contract shape): the Egypt-configured account, a code with leading zeros,
       a required custom field missing, a suspended / inactive client, a date stored differently, the opening zero line,
       HF5, product_match, client_import (paging, 0 rows), invoice_lookup (number, several composite matches, another
       client), legacy_scan (batches + cursor resume), supplier_search, purchase_push (zero tax, dedupe, lost response)
    4. worker + LIVE adapter over the stub: the exact requests of each kind; no write on a non-KSA account or under HF5
    5. end to end: PGlite (shim + every migration + seed, the step-7 defaults UNCHANGED: HF5 + resolve-only) + the REAL
       worker + the live adapter over the stub — probe (Egypt → refused, KSA → connected), product match + confirm,
       custom fields, the created draft (Riyadh date, po_number, CustomModel, read-back, daftra_url), date_mismatch,
       HF5 manual_in_daftra with no PUT, the opening draft on a declaration, client import, invoice lookup (review / blocked),
       client_mismatch on pull, legacy scan in batches, supplier search, the purchase draft per trip
    6. the single-file bundle (scripts/bundle-edge-function.py daftra-sync) carries the new code

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-daftra-worker-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const FN = path.join(SUPA, 'functions', 'daftra-sync');
const MIG_DIR = path.join(SUPA, 'migrations');

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in legacy-daftra-worker-tests'); };

const AD = require(path.join(FN, 'adapter.js'));
const DL = require(path.join(FN, 'daftra-live.js'));
const { createMockAdapter } = require(path.join(FN, 'mock-adapter.js'));
const { createWorker, runJob } = require(path.join(FN, 'worker.js'));
const FDS = require(path.join(SUPA, 'tests', 'lib', 'fake-daftra-server.js'));
const DEPS = Object.assign({}, AD, DL);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
const J = x => JSON.stringify(x);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + (e && (e.stack || e.message))); }
}
const errOf = async p => { try { await p; return null; } catch (e) { return e; } };

const KEY = 'dk_TEST_step7-NOT-A-REAL-KEY';                 // test value only
const CLOCK_ISO = '2026-11-10T21:30:00.000Z';               // 00:30 on 2026-11-11 in Riyadh: UTC would say 11-10
const clock = () => CLOCK_ISO;
const RIYADH_TODAY = '2026-11-11';
const lref = n => 'MRSL-' + String(n).padStart(16, '0').replace(/[^0-9A-F]/g, 'A');
const OPEN = { allow_draft_update: true, allow_product_create: true };
const HF5 = { allow_draft_update: false, allow_product_create: false, products: 'resolve_only' };
const KSA_ACC = { ok: true, reason: null, currency: 'SAR', country: 'SA', vat_15: true, enforced: true };
const EGYPT_ACC = { ok: false, reason: 'currency', currency: 'EGP', country: 'EG', vat_15: false, enforced: true };
const MAP = { fields: { declaration_no: { key: 'cf_decl', required: true }, declaration_date: { key: 'cf_date' }, bl: { key: 'cf_bl', required: true },
  port: { key: 'cf_port' }, declaration_type: { key: 'cf_type' }, containers: { key: 'cf_ctr' }, goods: { key: 'cf_goods' }, origin: { key: 'cf_origin' } } };
const conn = (o) => Object.assign({ mode: 'mock', status: 'connected', policy: HF5, account: KSA_ACC, custom_field_map: MAP, today: RIYADH_TODAY, time_zone: 'Asia/Riyadh' }, o || {});
const CF_OK = { payload: { cf_decl: 'DCL-77', cf_date: '05/11/2026', cf_bl: 'BLX1', cf_ctr: 'TSTU1000001', cf_type: 'وارد' },
  fields: [{ name: 'declaration_no', key: 'cf_decl', required: true, value: 'DCL-77' }, { name: 'declaration_date', key: 'cf_date', required: false, value: '05/11/2026' },
    { name: 'bl', key: 'cf_bl', required: true, value: 'BLX1' }, { name: 'declaration_type', key: 'cf_type', required: false, value: 'وارد' },
    { name: 'containers', key: 'cf_ctr', required: false, value: 'TSTU1000001' }], missing: [] };

// an invoice_push context in the DB contract shape (app.bill_job_context)
function pushCtx(o) {
  const x = Object.assign({ prev: 'queued', ext: null, clientExt: 'c-1', clientStatus: 'linked', active: true, items: null, lines: null, cf: CF_OK,
    origin: 'marsa', opening: false, policy: HF5, account: KSA_ACC, invoice_date: RIYADH_TODAY }, o || {});
  return {
    job: { id: 'j-push', org_id: 'org-1', kind: 'invoice_push', attempt_no: 1, options: x.opening ? { opening: true } : {}, previous_status: x.prev, expected_hash: x.expected || null },
    attempt_id: 'att-1',
    connection: conn({ policy: x.policy, account: x.account }),
    intent: { id: 'i-1', transaction_id: 't-1', transaction_ref: 'MRS-2026-000101', operational_ref: x.ref || 'MRS-2026-000101/F', po_number: x.ref || 'MRS-2026-000101/F',
      currency: 'SAR', purpose: 'final', origin: x.origin, status: 'open', sync_state: 'pending', external_invoice_id: x.ext, pushed_hash: x.pushedHash || null,
      remote_version: null, invoice_date: x.invoice_date, notes: null, daftra_url: null, custom_fields: x.cf,
      opening_line: x.opening ? { item_key: 'item:customs_clearance', description: '', quantity: 1, unit_price: 0, vat_rate: 15 } : null,
      client: { link_id: 'L-1', client_id: 'cl-1', client_ref: 'MRSC-cl-1', external_id: x.clientExt, status: x.clientStatus, data: { name: 'عميل الاختبار' },
        pushed_snapshot: null, active: x.active },
      items: x.items || [{ link_id: 'I-1', item_key: 'item:customs_clearance', product_code: 'MRS-item-customs_clearance', external_product_id: null,
        remote_product_code: '000186', remote_code_norm: '186', name_ar: 'أجور تخليص', name_en: null, default_vat_rate: 15, tax_code: 'standard', status: 'pending' }],
      lines: x.lines || [{ line_id: 'ln-1', line_ref: lref('A1'), state: 'pending_add', pushed: false, remote_line_id: null, item_key: 'item:customs_clearance',
        description: 'أجور التخليص', daftra_description: '', manual_in_daftra: false, quantity: '1.000', unit_price: '1000.00', vat_rate: '15.00',
        net_amount: '1000.00', vat_amount: '150.00', total_amount: '1150.00' }] }
  };
}
const runCtx = (kind, run, extra) => Object.assign({ job: { id: 'j-' + kind, org_id: 'org-1', kind, attempt_no: 1, options: {}, previous_status: 'queued' },
  attempt_id: 'att-' + kind, connection: conn(), run: Object.assign({ id: 'run-1', kind, params: {}, cursor: {}, page_size: 100, pages_per_job: 5 }, run || {}) }, extra || {});
const mock = o => createMockAdapter(Object.assign({ orgId: 'org-1', deps: AD, clock }, o || {}));
const ops = m => m.control.calls.map(c => c.op);
const WRITE_OPS = AD.WRITE_METHODS;

/* ================================================================== 0. static */
async function secStatic() {
  section('0. static: classic scripts, no network / env / key, the step-7 API, index.ts');
  const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  for (const f of ['adapter.js', 'worker.js', 'mock-adapter.js', 'daftra-live.js']) {
    await check(f + ': no require / import / export, no fetch / XHR / WebSocket, no Deno. / process.env, no console, no key-like literal', () => {
      const code = strip(fs.readFileSync(path.join(FN, f), 'utf8'));
      const bad = [];
      if (/\brequire\s*\(|^\s*import\s|^\s*export\s/m.test(code)) bad.push('module');
      if (/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(code)) bad.push('network');
      if (/\bDeno\.|process\.env/.test(code)) bad.push('env');
      if (/console\./.test(code)) bad.push('console');
      if (/(sk_live|eyJ[A-Za-z0-9_-]{20,}|apikey\s*[:=]\s*['"][^'"]+['"])/i.test(code)) bad.push('key');
      return bad.length === 0 || bad.join(', ');
    });
  }
  await check('nothing account-specific in the function: no Daftra field key (field_N), no product code (10001 / 000186 / 000191), no subdomain', () => {
    const all = ['adapter.js', 'worker.js', 'mock-adapter.js', 'daftra-live.js', 'index.ts'].map(f => strip(fs.readFileSync(path.join(FN, f), 'utf8'))).join('\n');
    return (!/\bfield_[0-9]+\b/.test(all) && !/'(10001|000186|000191)'/.test(all) && !/marsacloud/i.test(all)) || 'account data';
  });
  await check('the adapter contract: 9 new methods, createPurchaseDraft a write method, the write / read-only kinds, the helpers', () => {
    const want = ['findProductsByCodeNorm', 'listProducts', 'listClients', 'findInvoicesByNumber', 'listInvoices', 'searchSuppliers', 'findPurchaseByReference', 'getPurchase', 'createPurchaseDraft'];
    return (want.every(m => AD.ADAPTER_METHODS.includes(m)) && AD.WRITE_METHODS.includes('createPurchaseDraft') && AD.WRITE_METHODS.length === 6
      && J(AD.WRITE_KINDS) === J(['invoice_push', 'purchase_push', 'client_ensure', 'client_push', 'item_ensure'])
      && ['codeNorm', 'riyadhDate', 'normalizeDate', 'ksaBlock', 'writePolicy', 'customModel', 'containerSet', 'errorCode', 'errorFields'].every(k => typeof AD[k] === 'function')
      && AD.CAPABILITY_KEYS.length === 17) || 'contract';
  });
  await check('the not_configured stub covers the new methods (no request, no key)', async () => {
    const st = AD.createRealAdapter({});
    const es = await Promise.all(['listClients', 'createPurchaseDraft', 'searchSuppliers'].map(m => errOf(st[m]({}))));
    return es.every(e => e && e.kind === 'not_configured' && e.applied === 'no') || J(es);
  });
  await check('index.ts: the live adapter gets the org write policy (fail closed), one adapter per org AND policy, redirect: manual, no console', () => {
    const ts = fs.readFileSync(path.join(FN, 'index.ts'), 'utf8');
    const bad = [];
    if (!/policy: \{ allow_draft_update: connection\?\.policy\?\.allow_draft_update === true, allow_product_create: connection\?\.policy\?\.allow_product_create === true \}/.test(ts)) bad.push('policy');
    if (!/lives\.get\(lkey\)/.test(ts)) bad.push('cache key');
    if (!/redirect: 'manual'/.test(ts)) bad.push('redirect');
    if (/console\./.test(ts)) bad.push('console');
    return bad.length === 0 || bad.join(', ');
  });
}

/* ================================================================== 1. helpers */
async function secHelpers() {
  section('1. adapter.js helpers');
  await check('codeNorm mirrors app.daftra_code_norm: 000186 = 186, Arabic digits, 000 → 0, letters upper-cased, blank → null', () => {
    const r = ['000186', '186', '٠٠١٨٦', '000', ' mrs-x1 ', '  ', '0010001', null].map(AD.codeNorm);
    return J(r) === J(['186', '186', '186', '0', 'MRS-X1', null, '10001', null]) || J(r);
  });
  await check('riyadhDate (Intl, Asia/Riyadh): 21:30Z → the next day; 20:59Z → the same day; never UTC / host zone', () => {
    const r = [AD.riyadhDate('2026-11-10T21:30:00Z'), AD.riyadhDate('2026-11-10T20:59:59Z'), AD.riyadhDate('2026-12-31T21:00:00Z'), AD.riyadhDate('x')];
    return J(r) === J(['2026-11-11', '2026-11-10', '2027-01-01', null]) || J(r);
  });
  await check('normalizeDate: YYYY-MM-DD[ time], YYYY/MM/DD, DD/MM/YYYY, DD-MM-YYYY; invalid → null', () => {
    const r = ['2026-11-11 10:00:00', '2026/1/5', '11/11/2026', '05-01-2026', '31/02/2026', '', null].map(AD.normalizeDate);
    return J(r) === J(['2026-11-11', '2026-01-05', '2026-11-11', '2026-01-05', null, null, null]) || J(r);
  });
  await check('ksaBlock: no account / ok false → refused; enforced needs SAR + Saudi Arabia + 15 %; mock blocked only by a contradiction', () => {
    const r = [AD.ksaBlock(null), AD.ksaBlock(EGYPT_ACC), AD.ksaBlock(KSA_ACC), AD.ksaBlock(Object.assign({}, KSA_ACC, { vat_15: false })),
      AD.ksaBlock(Object.assign({}, KSA_ACC, { country: 'Egypt' })), AD.ksaBlock({ ok: true, enforced: false }), AD.ksaBlock({ ok: true, enforced: false, currency: 'EGP' }),
      AD.ksaBlock(Object.assign({}, KSA_ACC, { country: 'المملكة العربية السعودية', currency: 'sar' }))];
    return J(r) === J(['not_checked', 'currency', null, 'vat_rate', 'country', null, 'currency', null]) || J(r);
  });
  await check('writePolicy fails closed: only an explicit true allows', () => {
    const r = [AD.writePolicy(null), AD.writePolicy({ allow_draft_update: 'true', allow_product_create: 1 }), AD.writePolicy(OPEN)];
    return J(r) === J([{ allow_draft_update: false, allow_product_create: false }, { allow_draft_update: false, allow_product_create: false }, OPEN]) || J(r);
  });
  await check('customModel: {CustomModel:{key:[value]}}, the date field a single value + type_CustomModel.<key> = date; a bad key refused', async () => {
    const r = AD.customModel({ cf_decl: 'D-1', cf_date: '05/11/2026', cf_goods: 'ب'.repeat(1200) }, ['cf_date']);
    const e = await errOf(Promise.resolve().then(() => AD.customModel({ '1x': 'v' })));
    return (J(r.CustomModel.cf_decl) === J(['D-1']) && r.CustomModel.cf_date === '05/11/2026' && r['type_CustomModel.cf_date'] === 'date'
      && r.CustomModel.cf_goods[0].length === 1000 && e && e.code === 'custom_field_key' && J(AD.customModel({})) === '{}') || J({ r: Object.keys(r), e });
  });
  await check('containerSet: ISO containers (any separator), Ro-Ro "chassis / plate" → the chassis', () => {
    const r = [AD.containerSet('TSTU1000001، tstu-1000002; TSTU 1000001'), AD.containerSet('JTDBR32E720123456 / ABC1234'), AD.containerSet('')];
    return J(r) === J([['TSTU1000001', 'TSTU1000002'], ['JTDBR32E720123456'], []]) || J(r);
  });
  await check('errorCode: the 32 dictionary codes are the migration\'s daftra_error labels; aliases and kinds fall back; errorFields reads "(fields: …)"', () => {
    const mig = fs.readFileSync(path.join(MIG_DIR, '20261123000100_legacy_daftra.sql'), 'utf8');
    const codes = (mig.match(/\('daftra_error','([a-z_0-9]+)'/g) || []).map(x => x.split("','")[1].replace(/'$/, ''));
    const r = [AD.errorCode({ code: 'account_not_ksa' }), AD.errorCode({ code: 'draft_update_refused' }), AD.errorCode({ code: 'run_deadline', kind: 'timeout' }),
      AD.errorCode({ code: 'http_418', kind: 'network' }), AD.errorCode({ code: 'config_api_key', kind: 'not_configured' }), AD.errorCode({ code: 'zzz', kind: 'conflict' }),
      AD.errorCode({ code: 'zzz', kind: 'zzz' })];
    const f = AD.errorFields({ message: 'missing (fields: declaration_no, bl)' });
    return (J(codes.slice().sort()) === J(AD.DAFTRA_ERROR_CODES.slice().sort()) && codes.length === 32
      && J(r) === J(['account_not_ksa', 'draft_update_disabled', 'timeout', 'network', 'not_configured', 'validation', 'worker']) && J(f) === J(['declaration_no', 'bl'])) || J({ codes, r, f });
  });
}

/* ================================================================== 2. guard */
async function secGuard() {
  section('2. the request guard (daftra-live.js): HF5, resolve-only products, purchase drafts');
  const g = DL.guardDaftraRequest;
  const draft = { Invoice: { draft: 1, client_id: 1 }, InvoiceItem: [] };
  const po = (o, items) => ({ PurchaseOrder: Object.assign({ supplier_id: 3, draft: 1 }, o || {}), PurchaseOrderItem: items || [{ item: 'x', unit_price: 10, quantity: 1, tax1: 0, tax2: 0 }] });
  await check('HF5 by default: PUT invoices/{id} refused (draft_update_refused) unless allow_draft_update === true; a NEW draft (POST invoices.json) allowed', () => {
    const r = [g('PUT', 'invoices/9.json', draft), g('PUT', 'invoices/9.json', draft, '', HF5), g('PUT', 'invoices/9.json', draft, '', OPEN), g('POST', 'invoices.json', draft, '', HF5),
      g('POST', 'invoices/9.json', draft, '', OPEN), g('GET', 'invoices/update_draft/9/0.json', null, '', OPEN)];
    return J(r) === J(['draft_update_refused', 'draft_update_refused', null, null, 'path_refused', 'issue_refused']) || J(r);
  });
  await check('resolve-only: POST products refused (product_create_refused) unless allow_product_create === true; GET products always', () => {
    const r = [g('POST', 'products.json', {}), g('POST', 'products.json', {}, '', HF5), g('POST', 'products.json', {}, '', OPEN), g('GET', 'products.json')];
    return J(r) === J(['product_create_refused', 'product_create_refused', null, null]) || J(r);
  });
  await check('purchase drafts: ?send=draft + PurchaseOrder.draft 1 + zero taxes on every item; no PUT, no payment; suppliers GET only', () => {
    const r = [g('POST', 'purchase_invoices.json', po(), '?send=draft'), g('POST', 'purchase_invoices.json', po(), ''), g('POST', 'purchase_invoices.json', po({ draft: 0 }), '?send=draft'),
      g('POST', 'purchase_invoices.json', po({}, [{ item: 'x', unit_price: 10, quantity: 1, tax1: 1, tax2: 0 }]), '?send=draft'),
      g('POST', 'purchase_invoices.json', Object.assign(po(), { PurchaseOrderPayment: [{}] }), '?send=draft'), g('PUT', 'purchase_invoices/5.json', po(), '?send=draft', OPEN),
      g('GET', 'suppliers.json'), g('POST', 'suppliers.json', {}), g('GET', 'purchase_invoices/5.json'), g('DELETE', 'clients/5.json', null, '', OPEN)];
    return J(r) === J([null, 'draft_required', 'draft_required', 'tax_refused', 'payment_refused', 'path_refused', null, 'path_refused', null, 'path_refused']) || J(r);
  });
  await check('the live adapter itself refuses updateDraftInvoice / createProduct before any request under the default (fail-closed) policy', async () => {
    const S = FDS.createFakeDaftraServer({ apiKey: KEY });
    const L = AD.createRealAdapter({ impl: DL.createDaftraLive, deps: DEPS, http: S.inProcess(), apiKey: KEY, baseUrl: 'http://127.0.0.1:9999/api2', allowLoopback: true, clock });
    const e1 = await errOf(L.updateDraftInvoice('5', { lines: [] }));
    const e2 = await errOf(L.createProduct({ code: 'X1', name_ar: 'x' }));
    return (e1 && e1.code === 'draft_update_refused' && e2 && e2.code === 'product_create_refused' && S.requests.length === 0) || J({ e1, e2, n: S.requests.length });
  });
}

/* ================================================================== 3. worker + mock */
async function secMock() {
  section('3. worker + MOCK adapter (contexts in the DB contract shape)');
  const setup = () => {
    const m = mock();
    const cl = m.control.addClient({ name: 'عميل الاختبار', ref: 'C-100' });
    const p = m.control.addProduct({ code: '186', name_ar: 'أجور تخليص (دفترة)' });          // Daftra keeps the code without zeros
    return { m, cl, p };
  };
  await check('Egypt-configured account (connection.account not KSA): EVERY write kind fails account_not_ksa with ZERO adapter calls', async () => {
    const { m, cl } = setup();
    const kinds = ['invoice_push', 'purchase_push', 'client_ensure', 'client_push', 'item_ensure'];
    const out = [];
    for (const k of kinds) {
      const ctx = Object.assign(pushCtx({ clientExt: cl.id, account: EGYPT_ACC }), { purchase: { id: 'pu-1' }, client: { link_id: 'L' }, item: { link_id: 'I' } });
      ctx.job.kind = k;
      const r = await runJob(ctx, m, { deps: AD, clock });
      out.push([r.outcome, r.error && r.error.code, r.calls.length]);
    }
    const none = await runJob(Object.assign(pushCtx({ clientExt: cl.id }), { connection: { policy: HF5 } }), m, { deps: AD, clock });
    return (out.every(x => x[0] === 'failed' && x[1] === 'account_not_ksa' && x[2] === 0) && m.control.calls.length === 0
      && none.error.code === 'account_not_ksa' && /fields: not_checked/.test(none.error.message)) || J({ out, calls: ops(m), none: none.error });
  });
  await check('a read-only kind on the Egypt account still runs (GET only)', async () => {
    const { m } = setup();
    const ctx = runCtx('client_import', {}, { connection: conn({ account: EGYPT_ACC }) });
    const r = await runJob(ctx, m, { deps: AD, clock });
    return (r.outcome === 'ok' && r.effects.rows.length === 1 && ops(m).every(o => !WRITE_OPS.includes(o))) || J(r);
  });
  await check('product with leading zeros: the configured 000186 resolves the Daftra product 186 (zero-insensitive); never createProduct', async () => {
    const { m, cl, p } = setup();
    const r = await runJob(pushCtx({ clientExt: cl.id }), m, { deps: AD, clock });
    const inv = m.control.invoice(r.effects.external_invoice_id);
    return (r.outcome === 'ok' && inv.lines[0].product_id === p.id && !ops(m).includes('createProduct') && ops(m).includes('findProductsByCodeNorm')
      && m.control.count('product') === 1) || J({ r, o: ops(m) });
  });
  await check('unmapped (no code) → unmapped_product (fields: the item); code not in Daftra → product_not_found (fields: the code); nothing created', async () => {
    const { m, cl } = setup();
    const it = pushCtx().intent.items[0];
    const r1 = await runJob(pushCtx({ clientExt: cl.id, items: [Object.assign({}, it, { remote_product_code: null, remote_code_norm: null })] }), m, { deps: AD, clock });
    const r2 = await runJob(pushCtx({ clientExt: cl.id, items: [Object.assign({}, it, { remote_product_code: '0999' })] }), m, { deps: AD, clock });
    return (r1.outcome === 'failed' && r1.error.code === 'unmapped_product' && J(AD.errorFields(r1.error)) === J(['item:customs_clearance'])
      && r2.outcome === 'failed' && r2.error.code === 'product_not_found' && J(AD.errorFields(r2.error)) === J(['0999'])
      && m.control.count('invoice') === 0 && !ops(m).some(o => WRITE_OPS.includes(o))) || J({ r1: r1.error, r2: r2.error });
  });
  await check('a required custom field missing → custom_required (fields: names) before ANY call', async () => {
    const { m, cl } = setup();
    const r = await runJob(pushCtx({ clientExt: cl.id, cf: Object.assign({}, CF_OK, { missing: ['declaration_no', 'bl'] }) }), m, { deps: AD, clock });
    return (r.outcome === 'failed' && r.error.code === 'custom_required' && J(AD.errorFields(r.error)) === J(['declaration_no', 'bl']) && r.calls.length === 0) || J(r);
  });
  await check('an inactive Marsa client → client_inactive (no call); a Daftra-suspended client → client_suspended, no draft', async () => {
    const { m, cl } = setup();
    const r1 = await runJob(pushCtx({ clientExt: cl.id, active: false }), m, { deps: AD, clock });
    m.control.suspendClient(cl.id);
    const r2 = await runJob(pushCtx({ clientExt: cl.id }), m, { deps: AD, clock });
    return (r1.error.code === 'client_inactive' && r1.calls.length === 0 && r2.outcome === 'failed' && r2.error.code === 'client_suspended'
      && m.control.count('invoice') === 0 && !ops(m).includes('createDraftInvoice')) || J({ r1: r1.error, r2: r2.error, o: ops(m) });
  });
  await check('the new draft: Riyadh invoice date, po_number, the custom fields, the clearance line named with an empty description; read_back reported', async () => {
    const { m, cl } = setup();
    const r = await runJob(pushCtx({ clientExt: cl.id }), m, { deps: AD, clock });
    const inv = m.control.invoice(r.effects.external_invoice_id);
    const raw = inv.lines_raw[0];
    return (r.outcome === 'ok' && inv.date === RIYADH_TODAY && inv.reference === 'MRS-2026-000101/F' && J(inv.custom_fields) === J(CF_OK.payload)
      && raw.item === 'أجور تخليص' && raw.daftra_description === '' && r.effects.found_by === 'created' && J(r.effects.read_back) === J({ date: RIYADH_TODAY, client_id: cl.id, total: '1150.00', line_count: 1 })
      && r.effects.line_results.length === 1 && r.effects.line_results[0].state === 'synced') || J({ r: r.effects, inv });
  });
  await check('no pinned date in the context → today in Asia/Riyadh from the worker clock via Intl (2026-11-11, not the UTC 2026-11-10)', async () => {
    const { m, cl } = setup();
    const ctx = pushCtx({ clientExt: cl.id, invoice_date: null });
    delete ctx.connection.today;
    const r = await runJob(ctx, m, { deps: AD, clock });
    return (m.control.invoice(r.effects.external_invoice_id).date === '2026-11-11') || J(r.effects);
  });
  await check('Daftra stored another date → read_back.date differs from the Riyadh invoice date (SQL: date_mismatch)', async () => {
    const { m, cl } = setup();
    m.control.storeDateAs('2026-11-10');
    const r = await runJob(pushCtx({ clientExt: cl.id }), m, { deps: AD, clock });
    return (r.outcome === 'ok' && r.effects.read_back.date === '2026-11-10') || J(r.effects);
  });
  await check('appointment line: the TAS number only as Daftra description; a manual_in_daftra line is never sent', async () => {
    const { m, cl, p } = setup();
    const items = [Object.assign({}, pushCtx().intent.items[0], { external_product_id: p.id, status: 'linked' }),
      { link_id: 'I-2', item_key: 'item:gate_out_appointment', external_product_id: p.id, status: 'linked', name_ar: 'موعد خروج', remote_product_code: '7' }];
    const base = pushCtx().intent.lines[0];
    const lines = [base, Object.assign({}, base, { line_id: 'ln-2', line_ref: lref('A2'), item_key: 'item:gate_out_appointment', description: 'رسوم موعد TAS-1', daftra_description: 'TAS123456', unit_price: '50.00', total_amount: '57.50' }),
      Object.assign({}, base, { line_id: 'ln-3', line_ref: lref('A3'), manual_in_daftra: true })];
    const r = await runJob(pushCtx({ clientExt: cl.id, items, lines }), m, { deps: AD, clock });
    const raw = m.control.invoice(r.effects.external_invoice_id).lines_raw;
    return (r.outcome === 'ok' && raw.length === 2 && raw[1].item === 'موعد خروج' && raw[1].daftra_description === 'TAS123456' && raw.every(l => l.line_ref !== lref('A3'))) || J(raw);
  });
  await check('opening intent: ONE zero line (clearance product, empty description) + po_number = the transaction ref; needs a linked client', async () => {
    const { m, cl, p } = setup();
    const r = await runJob(pushCtx({ clientExt: cl.id, origin: 'opening', opening: true, ref: 'MRS-2026-000101', lines: [] }), m, { deps: AD, clock });
    const inv = m.control.invoice(r.effects.external_invoice_id);
    const r2 = await runJob(pushCtx({ clientExt: null, clientStatus: 'pending', origin: 'opening', opening: true, lines: [] }), m, { deps: AD, clock });
    return (r.outcome === 'ok' && inv.reference === 'MRS-2026-000101' && inv.lines.length === 1 && inv.lines[0].unit_price === '0.00' && inv.lines[0].product_id === p.id
      && inv.lines_raw[0].daftra_description === '' && inv.lines_raw[0].line_ref === null && r.effects.read_back.line_count === 1 && r.effects.read_back.total === '0.00'
      && r2.error.code === 'client_not_linked' && r2.calls.length === 0) || J({ r: r.effects, inv, r2: r2.error });
  });
  await check('HF5: an existing draft that differs is NEVER updated (draft_update_disabled, no updateDraftInvoice); found by reference → adopted as is', async () => {
    const { m, cl, p } = setup();
    const first = await runJob(pushCtx({ clientExt: cl.id }), m, { deps: AD, clock });
    const ext = first.effects.external_invoice_id;
    const lines = pushCtx().intent.lines.concat([Object.assign({}, pushCtx().intent.lines[0], { line_id: 'ln-9', line_ref: lref('B9'), state: 'pending_add' })]);
    const synced = lines.map((l, i) => i === 0 ? Object.assign({}, l, { state: 'synced', pushed: true }) : l);
    const items = [Object.assign({}, pushCtx().intent.items[0], { external_product_id: p.id, status: 'linked' })];
    m.control.reset();
    const r = await runJob(pushCtx({ clientExt: cl.id, ext, pushedHash: first.effects.pushed_hash, lines: synced, items }), m, { deps: AD, clock });
    const r2 = await runJob(pushCtx({ clientExt: cl.id, prev: 'unknown', items }), m, { deps: AD, clock });
    return (r.outcome === 'failed' && r.error.code === 'draft_update_disabled' && !ops(m).includes('updateDraftInvoice') && m.control.invoice(ext).lines.length === 1
      && r2.outcome === 'ok' && r2.effects.found_by === 'ref' && r2.effects.external_invoice_id === ext && m.control.count('invoice') === 1 && !('read_back' in r2.effects)) || J({ r: r.error, o: ops(m), r2: r2.effects });
  });
  await check('the recorder refuses a policy-forbidden write even if an algorithm asks for it (logged applied no, nothing sent)', async () => {
    const { m, cl } = setup();
    const ctx = Object.assign(pushCtx({ clientExt: cl.id }), { item: { link_id: 'I-x', item_key: 'item:x', product_code: 'MRS-item-x', name_ar: 'صنف جديد' } });
    ctx.job.kind = 'item_ensure';
    const r = await runJob(ctx, m, { deps: AD, clock });
    return (r.outcome === 'failed' && r.error.code === 'product_create_disabled' && m.control.count('product') === 1 && !ops(m).includes('createProduct')) || J(r);
  });
  await check('product_match: zero-insensitive code candidates (000186 → 186), name candidates for an item without a code; never a write', async () => {
    const { m } = setup();
    m.control.addProduct({ code: '1860', name_ar: 'آخر' });
    m.control.addProduct({ code: 'S-9', name_ar: 'موعد دخول' });
    const r = await runJob(runCtx('product_match', {}, { products: [{ item_key: 'item:customs_clearance', link_id: 'I-1', remote_product_code: '000186', remote_code_norm: '186', name_ar: 'x' },
      { item_key: 'item:gate_in_appointment', link_id: 'I-2', remote_product_code: null, remote_code_norm: null, name_ar: 'موعد دخول' }] }), m, { deps: AD, clock });
    const c1 = r.effects.products[0].candidates, c2 = r.effects.products[1].candidates;
    return (r.outcome === 'ok' && r.effects.run_id === 'run-1' && c1.length === 1 && c1[0].code === '186' && c2.length === 1 && c2[0].code === 'S-9'
      && r.effects.scanned === 3 && ops(m).every(o => !WRITE_OPS.includes(o))) || J(r.effects);
  });
  await check('client_import: pages from the cursor (≤ 500 rows), the Arabic official name, suspended flag, next_cursor; GET only', async () => {
    const m = mock();
    for (let i = 0; i < 7; i++) m.control.addClient({ name: 'Client ' + i, secondary_name: 'عميل ' + i, ref: 'C-' + i, vat_number: '3000' + i, suspended: i === 3 });
    const r1 = await runJob(runCtx('client_import', { page_size: 3, pages_per_job: 2 }), m, { deps: AD, clock });
    const r2 = await runJob(runCtx('client_import', { page_size: 3, pages_per_job: 2, cursor: r1.effects.next_cursor }), m, { deps: AD, clock });
    const row = r1.effects.rows[0];
    return (r1.effects.rows.length === 6 && J(r1.effects.next_cursor) === J({ page: 3 }) && r2.effects.rows.length === 1 && r2.effects.next_cursor === null
      && row.name === 'عميل 0' && row.name_en === 'Client 0' && row.client_number === 'C-0' && r1.effects.rows[3].suspended === true
      && ops(m).every(o => o === 'listClients')) || J({ r1: r1.effects, r2: r2.effects });
  });
  await check('client_import on an empty account: rows [] and next_cursor null (SQL aborts the run: empty_result); nothing deleted / written', async () => {
    const m = mock();
    const r = await runJob(runCtx('client_import'), m, { deps: AD, clock });
    return (r.outcome === 'ok' && r.effects.rows.length === 0 && r.effects.next_cursor === null && J(ops(m)) === J(['listClients'])) || J(r);
  });
  const txCtx = (lookup, t) => ({ job: { id: 'j-lk', org_id: 'org-1', kind: 'invoice_lookup', attempt_no: 1, options: lookup, previous_status: 'queued' }, attempt_id: 'att-lk',
    connection: conn(), transaction: Object.assign({ id: 't-1', ref: 'MRS-2026-000101', client_external_id: null, declaration_nos: ['DCL-77'], bl_numbers: ['BLX1'],
      containers: ['TSTU1000001'], cargo_unit_type: 'container' }, t || {}), lookup });
  await check('invoice_lookup by number: the invoice with its composite fields (from the custom field map), state, total, client; GET only', async () => {
    const { m, cl } = setup();
    m.control.addInvoice({ client_id: cl.id, number: 'INV-1001', status: 'issued', date: '2026-10-01', total: 1150, custom_fields: { cf_decl: ['DCL-77'], cf_bl: ['BLX1'], cf_ctr: ['TSTU1000001'] } });
    m.control.addInvoice({ client_id: cl.id, number: 'INV-1002', status: 'issued' });
    const r = await runJob(txCtx({ mode: 'number', number: 'inv 1001' }), m, { deps: AD, clock });
    const x = r.effects.invoices[0];
    return (r.outcome === 'ok' && r.effects.transaction_id === 't-1' && r.effects.invoices.length === 1 && x.daftra_number === 'INV-1001' && x.remote_state === 'issued'
      && x.total === '1150.00' && x.client_id === cl.id && x.client_name === 'عميل الاختبار' && x.date === '2026-10-01'
      && J(x.fields) === J({ declaration_no: 'DCL-77', bl: 'BLX1', containers: ['TSTU1000001'] }) && ops(m).every(o => !WRITE_OPS.includes(o))) || J(r.effects);
  });
  await check('invoice_lookup composite: several exact matches all reported (SQL → review), another client\'s match reported (SQL → blocked), non-matching dropped', async () => {
    const { m, cl } = setup();
    const other = m.control.addClient({ name: 'عميل آخر' });
    const f = { cf_decl: ['DCL-77'], cf_bl: ['BLX1'], cf_ctr: ['TSTU1000001'] };
    m.control.addInvoice({ client_id: cl.id, number: 'INV-1', custom_fields: f });
    m.control.addInvoice({ client_id: cl.id, number: 'INV-2', status: 'draft', custom_fields: f });
    m.control.addInvoice({ client_id: other.id, number: 'INV-3', custom_fields: f });
    m.control.addInvoice({ client_id: cl.id, number: 'INV-4', custom_fields: { cf_decl: ['ZZZ'] } });
    const r = await runJob(txCtx({ mode: 'composite' }, { client_external_id: cl.id }), m, { deps: AD, clock });
    const nos = r.effects.invoices.map(x => x.daftra_number).sort();
    return (r.outcome === 'ok' && J(nos) === J(['INV-1', 'INV-2', 'INV-3']) && r.effects.invoices.find(x => x.daftra_number === 'INV-3').client_id === other.id
      && ops(m).every(o => !WRITE_OPS.includes(o))) || J(r.effects);
  });
  await check('legacy_scan: id-ascending batches, next_cursor {page, last_id}, a resumed batch skips what was reported; the end → null', async () => {
    const { m, cl } = setup();
    for (let i = 0; i < 5; i++) m.control.addInvoice({ client_id: cl.id, number: 'OLD-' + i, custom_fields: { cf_decl: ['D-' + i] } });
    const r1 = await runJob(runCtx('legacy_scan', { page_size: 2, pages_per_job: 2 }), m, { deps: AD, clock });
    const r2 = await runJob(runCtx('legacy_scan', { page_size: 2, pages_per_job: 2, cursor: r1.effects.next_cursor }), m, { deps: AD, clock });
    const r3 = await runJob(runCtx('legacy_scan', { page_size: 2, pages_per_job: 2, cursor: { page: 2, last_id: r1.effects.invoices[3].external_invoice_id } }), m, { deps: AD, clock });
    return (J(r1.effects.invoices.map(x => x.daftra_number)) === J(['OLD-0', 'OLD-1', 'OLD-2', 'OLD-3']) && J(r1.effects.next_cursor) === J({ page: 3, last_id: r1.effects.invoices[3].external_invoice_id })
      && J(r2.effects.invoices.map(x => x.daftra_number)) === J(['OLD-4']) && r2.effects.next_cursor === null && r3.effects.invoices.length === 1
      && r1.effects.invoices[0].fields.declaration_no === 'D-0' && ops(m).every(o => o === 'listInvoices')) || J({ r1: r1.effects, r2: r2.effects, r3: r3.effects });
  });
  await check('supplier_search: GET only, ≤ 50, a suspended supplier is never offered; no q → failed validation', async () => {
    const m = mock();
    m.control.addSupplier({ name: 'شركة النقل التجريبية', supplier_number: 'S-1' });
    m.control.addSupplier({ name: 'شركة النقل التجريبية فرع 2' });
    m.control.addSupplier({ name: 'شركة النقل الموقوفة', suspended: true });
    const r = await runJob(runCtx('supplier_search', { params: { q: 'شركة النقل' } }), m, { deps: AD, clock });
    const r0 = await runJob(runCtx('supplier_search', { params: {} }), m, { deps: AD, clock });
    return (r.outcome === 'ok' && r.effects.suppliers.length === 2 && r.effects.suppliers[0].supplier_number === 'S-1' && !r.effects.suppliers.some(s => /الموقوفة/.test(s.name))
      && r0.outcome === 'failed' && r0.error.code === 'validation' && ops(m).every(o => o === 'searchSuppliers')) || J({ r: r.effects, r0 });
  });
  const purCtx = (o) => {
    const x = Object.assign({ ext: null, sup: null, prev: 'queued' }, o || {});
    return { job: { id: 'j-pur', org_id: 'org-1', kind: 'purchase_push', attempt_no: 1, options: {}, previous_status: x.prev }, attempt_id: 'att-pur', connection: conn(),
      purchase: { id: 'pu-1', reference: 'MRSP-0123456789AB', trip_id: 'tr-1', transaction_id: 't-1', transaction_ref: 'MRS-2026-000101', supplier_external_id: x.sup,
        supplier_name: 'شركة النقل', external_purchase_id: x.ext, status: 'open', invoice_date: RIYADH_TODAY,
        item: { link_id: 'I-t', item_key: 'item:transportation_cost', external_product_id: x.prod || null, remote_product_code: '000191', remote_code_norm: '191', name_ar: 'تكلفة النقل', status: x.prod ? 'linked' : 'pending' },
        lines: [{ item_key: 'item:transportation_cost', description: 'MRS-2026-000101', quantity: 1, unit_price: 750, vat_rate: 0 }], amount: 750, currency: 'SAR', tax: 0 } };
  };
  await check('purchase_push: supplier not linked → supplier_not_linked; then ONE zero-tax draft (product by code 191), reference looked up first', async () => {
    const m = mock();
    const s = m.control.addSupplier({ name: 'شركة النقل' });
    const tp = m.control.addProduct({ code: '191', name_ar: 'تكلفة النقل' });
    const r0 = await runJob(purCtx(), m, { deps: AD, clock });
    const r = await runJob(purCtx({ sup: s.id }), m, { deps: AD, clock });
    const pu = m.control.purchase(r.effects.external_purchase_id);
    return (r0.error.code === 'supplier_not_linked' && r0.calls.length === 0 && r.outcome === 'ok' && r.effects.found_by === 'created' && r.effects.purchase_id === 'pu-1'
      && pu.lines.length === 1 && pu.lines[0].tax_rate === '0.00' && pu.lines[0].unit_price === '750.00' && pu.lines[0].product_id === tp.id && pu.date === RIYADH_TODAY
      && J(ops(m).filter(o => o !== 'findProductsByCodeNorm')) === J(['findPurchaseByReference', 'getAccountProfile', 'createPurchaseDraft', 'getPurchase'])
      && J(r.effects.checks) === J({ tax_nonzero: false, not_draft: false, unread: false })) || J({ r0: r0.error, r: r.effects, o: ops(m) });
  });
  await check('purchase_push dedupe: a saved id is only read (found_by ref, no create); the same reference found → adopted; a lost create → unknown', async () => {
    const m = mock();
    const s = m.control.addSupplier({ name: 'شركة النقل' });
    const tp = m.control.addProduct({ code: '191', name_ar: 'تكلفة النقل' });
    const first = await runJob(purCtx({ sup: s.id, prod: tp.id }), m, { deps: AD, clock });
    m.control.reset();
    const again = await runJob(purCtx({ sup: s.id, prod: tp.id, ext: first.effects.external_purchase_id }), m, { deps: AD, clock });
    const byRef = await runJob(purCtx({ sup: s.id, prod: tp.id, prev: 'unknown' }), m, { deps: AD, clock });
    m.control.loseResponse('createPurchaseDraft');
    const m2ctx = purCtx({ sup: s.id, prod: tp.id });
    m2ctx.purchase.reference = 'MRSP-FFFFFFFFFFFF';
    const lost = await runJob(m2ctx, m, { deps: AD, clock });
    return (again.outcome === 'ok' && again.effects.found_by === 'ref' && !ops(m).slice(0, 1).includes('createPurchaseDraft') && byRef.effects.found_by === 'ref'
      && byRef.effects.external_purchase_id === first.effects.external_purchase_id && lost.outcome === 'unknown' && lost.effects.purchase_id === 'pu-1'
      && m.control.count('purchase', 'MRSP-0123456789AB') === 1) || J({ again: again.effects, byRef: byRef.effects, lost });
  });
}

/* ================================================================== 4. worker + live adapter over the stub */
function liveOf(S, o) {
  return AD.createRealAdapter(Object.assign({ impl: DL.createDaftraLive, deps: DEPS, http: S.inProcess(), apiKey: KEY, baseUrl: 'http://127.0.0.1:9999/api2', allowLoopback: true,
    expectSubdomain: 'marsa-fake', clock, timeouts: { read: 2000, write: 2000 }, deadlineMs: 8000 }, o || {}));
}
async function secLive() {
  section('4. worker + LIVE adapter over the stubbed transport: the exact requests');
  const fresh = (o) => {
    const S = FDS.createFakeDaftraServer(Object.assign({ apiKey: KEY }, o || {}));
    const cl = S.control.addClient({ business_name: 'عميل الاختبار', client_number: 'C-100' });
    const pid = S.control.addProduct({ name: 'أجور تخليص', product_code: '186', tax1: 1 });
    return { S, cl, pid };
  };
  const nonGet = S => S.requests.filter(r => r.method !== 'GET');
  await check('invoice_push (HF5 / resolve-only): GETs, ONE POST invoices.json (draft 1, Riyadh date, po_number, CustomModel, named items), then GET invoices/{id}; no PUT', async () => {
    const { S, cl, pid } = fresh();
    const r = await runJob(pushCtx({ clientExt: cl }), liveOf(S, { policy: HF5 }), { deps: DEPS, clock });
    const w = nonGet(S);
    const b = w[0] && w[0].body;
    const seq = S.requests.map(x => x.method + ' ' + x.path);
    const it = b && b.InvoiceItem[0];
    return (r.outcome === 'ok' && w.length === 1 && w[0].method === 'POST' && w[0].path === 'invoices.json' && b.Invoice.draft === 1 && b.Invoice.is_offline === 1
      && b.Invoice.date === RIYADH_TODAY && b.Invoice.po_number === 'MRS-2026-000101/F' && b.Invoice.client_id === Number(cl) && b.Invoice.currency_code === 'SAR'
      && J(b.CustomModel) === J({ cf_decl: ['DCL-77'], cf_date: '05/11/2026', cf_bl: ['BLX1'], cf_ctr: ['TSTU1000001'], cf_type: ['وارد'] }) && b['type_CustomModel.cf_date'] === 'date'
      && it.item === 'أجور تخليص [' + lref('A1') + ']' && it.description === '' && it.product_id === Number(pid) && it.tax1 === 1 && it.unit_price === 1000
      && seq.includes('GET products.json') && seq.includes('GET clients/' + cl + '.json') && seq[seq.length - 1] === 'GET invoices/' + r.effects.external_invoice_id + '.json'
      && !S.requests.some(x => x.method === 'PUT' || /update_draft/.test(x.path) || (x.method === 'POST' && x.path === 'products.json'))
      && r.effects.daftra_url === 'https://marsa-fake.daftra.com/owner/invoices/view/' + r.effects.external_invoice_id
      && r.effects.read_back.date === RIYADH_TODAY && r.effects.read_back.client_id === cl && r.effects.read_back.total === '1150.00' && r.effects.read_back.line_count === 1
      && S.requests.every(x => x.apikey && !x.authorization)) || J({ r: r.effects || r, seq, b });
  });
  await check('products by code without leading zeros over HTTP: product_code=000186 → none, product_code=186 → found (no POST products)', async () => {
    const { S, cl } = fresh();
    await runJob(pushCtx({ clientExt: cl }), liveOf(S, { policy: HF5 }), { deps: DEPS, clock });
    const pr = S.requests.filter(x => x.path === 'products.json').map(x => x.query.product_code || ('kw:' + x.query.keywords));
    return J(pr) === J(['000186', '186']) || J(pr);
  });
  await check('non-KSA account: ZERO requests of any kind for every write job', async () => {
    const { S, cl } = fresh();
    const L = liveOf(S, { policy: OPEN });
    for (const k of ['invoice_push', 'purchase_push', 'client_ensure', 'client_push', 'item_ensure']) {
      const ctx = Object.assign(pushCtx({ clientExt: cl, account: EGYPT_ACC, policy: OPEN }), { purchase: { id: 'p' }, client: { link_id: 'L', external_id: cl }, item: { link_id: 'I' } });
      ctx.job.kind = k;
      await runJob(ctx, L, { deps: DEPS, clock });
    }
    return S.requests.length === 0 || J(S.requests.map(x => x.method + ' ' + x.path));
  });
  await check('allow_draft_update false with an existing draft: reads only; NO PUT / POST on invoices/{id} (draft_update_disabled); the account stays as it was', async () => {
    const { S, cl } = fresh();
    const L = liveOf(S, { policy: HF5 });
    const first = await runJob(pushCtx({ clientExt: cl }), L, { deps: DEPS, clock });
    const items = [Object.assign({}, pushCtx().intent.items[0], { external_product_id: S.state.products[0].id, status: 'linked' })];
    const lines = pushCtx().intent.lines.map(l => Object.assign({}, l, { state: 'synced', pushed: true }))
      .concat([Object.assign({}, pushCtx().intent.lines[0], { line_id: 'ln-2', line_ref: lref('B2'), unit_price: '5.00' })]);
    S.reset();
    const r = await runJob(pushCtx({ clientExt: cl, ext: first.effects.external_invoice_id, pushedHash: first.effects.pushed_hash, items, lines }), L, { deps: DEPS, clock });
    const x = S.state.invoices[0];
    return (r.outcome === 'failed' && r.error.code === 'draft_update_disabled' && S.requests.every(q => q.method === 'GET') && x.items.length === 1) || J({ r: r.error, rq: S.requests.map(q => q.method + ' ' + q.path) });
  });
  await check('Daftra stored another date over HTTP → read_back.date is the stored one', async () => {
    const { S, cl } = fresh();
    S.control.storeDateAs('2026-11-09');
    const r = await runJob(pushCtx({ clientExt: cl }), liveOf(S, { policy: HF5 }), { deps: DEPS, clock });
    return (r.outcome === 'ok' && r.effects.read_back.date === '2026-11-09') || J(r.effects);
  });
  await check('suspended Daftra client over HTTP (Client.suspend = 1) → client_suspended; no POST', async () => {
    const { S, cl } = fresh();
    S.state.clients.find(c => c.id === cl).suspend = 1;
    const r = await runJob(pushCtx({ clientExt: cl }), liveOf(S, { policy: HF5 }), { deps: DEPS, clock });
    return (r.error && r.error.code === 'client_suspended' && nonGet(S).length === 0) || J(r);
  });
  await check('client_import: GET clients.json?page=&limit= only (secondary Arabic name, suspend); next_cursor while pages remain', async () => {
    const { S } = fresh();
    for (let i = 0; i < 4; i++) S.control.addClient({ business_name: 'Client ' + i, secondary_name: 'عميل ' + i, client_number: 'K-' + i, bn1: '31000' + i, suspend: i === 1 ? 1 : 0, city: 'جدة' });
    const r = await runJob(runCtx('client_import', { page_size: 2, pages_per_job: 2 }), liveOf(S), { deps: DEPS, clock });
    const rq = S.requests.map(x => x.method + ' ' + x.path + '?' + x.query.page + '/' + x.query.limit);
    const row = r.effects.rows[1];
    return (r.outcome === 'ok' && J(rq) === J(['GET clients.json?1/2', 'GET clients.json?2/2']) && r.effects.rows.length === 4 && J(r.effects.next_cursor) === J({ page: 3 })
      && row.name === 'عميل 0' && row.name_en === 'Client 0' && row.vat_number === '310000' && row.city === 'جدة' && r.effects.rows[2].suspended === true) || J({ rq, r: r.effects });
  });
  await check('invoice_lookup number: GET invoices.json?keywords=…, then GET invoices/{id}.json for the custom fields (CustomModel); GET only', async () => {
    const { S, cl } = fresh();
    const id = S.control.addInvoice({ client_id: cl, draft: 0, no: 'INV-1001', date: '2026-10-01' });
    S.control.setInvoiceFields(id, { cf_decl: ['DCL-77'], cf_bl: ['BLX1'], cf_ctr: ['TSTU1000001, TSTU1000002'] });
    const r = await runJob(Object.assign(runCtx('invoice_lookup'), { job: { id: 'j', org_id: 'o', kind: 'invoice_lookup', options: {} }, run: undefined,
      transaction: { id: 't-1', declaration_nos: ['DCL-77'], bl_numbers: ['BLX1'], containers: ['TSTU1000001'] }, lookup: { mode: 'number', number: 'INV-1001' } }), liveOf(S), { deps: DEPS, clock });
    const x = r.effects.invoices[0];
    return (r.outcome === 'ok' && x && x.daftra_number === 'INV-1001' && x.remote_state === 'issued' && J(x.fields.containers) === J(['TSTU1000001', 'TSTU1000002'])
      && x.fields.declaration_no === 'DCL-77' && S.requests.every(q => q.method === 'GET') && S.requests.some(q => q.path === 'invoices/' + id + '.json')
      && S.requests.some(q => q.path === 'invoices.json' && q.query.keywords === 'INV-1001')) || J({ r: r.effects, rq: S.requests.map(q => q.path) });
  });
  await check('invoice_lookup composite: keywords per declaration + the client\'s invoices (client_id filter), details for the fields; several matches all returned', async () => {
    const { S, cl } = fresh();
    for (const no of ['INV-1', 'INV-2']) S.control.setInvoiceFields(S.control.addInvoice({ client_id: cl, draft: 0, no }), { cf_decl: ['DCL-77'], cf_bl: ['BLX1'], cf_ctr: ['TSTU1000001'] });
    S.control.setInvoiceFields(S.control.addInvoice({ client_id: cl, draft: 0, no: 'INV-9' }), { cf_decl: ['OTHER'] });
    const r = await runJob(Object.assign(runCtx('invoice_lookup'), { job: { id: 'j', org_id: 'o', kind: 'invoice_lookup', options: {} }, run: undefined,
      transaction: { id: 't-1', client_external_id: cl, declaration_nos: ['DCL-77'], bl_numbers: ['BLX1'], containers: ['TSTU1000001'] }, lookup: { mode: 'composite' } }), liveOf(S), { deps: DEPS, clock });
    return (r.outcome === 'ok' && J(r.effects.invoices.map(x => x.daftra_number).sort()) === J(['INV-1', 'INV-2']) && S.requests.every(q => q.method === 'GET')
      && S.requests.some(q => q.path === 'invoices.json' && q.query.client_id === cl && q.query.sort === 'id')) || J(r.effects);
  });
  await check('legacy_scan: GET invoices.json?sort=id&direction=ASC pages; detail reads within the budget; the cursor', async () => {
    const { S, cl } = fresh({ listCustomModel: true });
    for (let i = 0; i < 3; i++) S.control.setInvoiceFields(S.control.addInvoice({ client_id: cl, draft: 0, no: 'OLD-' + i }), { cf_decl: ['D-' + i] });
    const r = await runJob(runCtx('legacy_scan', { page_size: 2, pages_per_job: 1 }), liveOf(S), { deps: DEPS, clock });
    const q0 = S.requests.find(q => q.path === 'invoices.json');
    return (r.outcome === 'ok' && J(r.effects.invoices.map(x => x.fields.declaration_no)) === J(['D-0', 'D-1']) && q0.query.sort === 'id' && q0.query.direction === 'ASC'
      && J(r.effects.next_cursor) === J({ page: 2, last_id: r.effects.invoices[1].external_invoice_id }) && !S.requests.some(q => /^invoices\/\d/.test(q.path))) || J(r.effects);
  });
  await check('supplier_search: GET suppliers.json?name=… only', async () => {
    const { S } = fresh();
    S.control.addSupplier({ business_name: 'شركة النقل التجريبية', supplier_number: 'S-1' });
    const r = await runJob(runCtx('supplier_search', { params: { q: 'شركة النقل التجريبية' } }), liveOf(S), { deps: DEPS, clock });
    return (r.outcome === 'ok' && r.effects.suppliers.length === 1 && J(S.requests.map(q => q.method + ' ' + q.path + ' ' + q.query.name)) === J(['GET suppliers.json شركة النقل التجريبية'])) || J({ r: r.effects, rq: S.requests });
  });
  await check('purchase_push: GET purchase_invoices.json (keywords, scan), POST purchase_invoices.json?send=draft (draft 1, tax1 = tax2 = 0, marker), GET purchase_invoices/{id}.json', async () => {
    const { S } = fresh();
    const sup = S.control.addSupplier({ business_name: 'شركة النقل' });
    const tp = S.control.addProduct({ name: 'تكلفة النقل', product_code: '191' });
    const ctx = { job: { id: 'j', org_id: 'o', kind: 'purchase_push', options: {}, previous_status: 'queued' }, connection: conn({ policy: HF5 }),
      purchase: { id: 'pu-1', reference: 'MRSP-0123456789AB', supplier_external_id: sup, external_purchase_id: null, status: 'open', invoice_date: RIYADH_TODAY,
        item: { item_key: 'item:transportation_cost', external_product_id: tp, status: 'linked', name_ar: 'تكلفة النقل' },
        lines: [{ item_key: 'item:transportation_cost', description: 'MRS-2026-000101', quantity: 1, unit_price: 750, vat_rate: 0 }], currency: 'SAR' } };
    const r = await runJob(ctx, liveOf(S, { policy: HF5 }), { deps: DEPS, clock });
    const w = nonGet(S);
    const b = w[0] && w[0].body;
    const seq = S.requests.map(q => q.method + ' ' + q.path);
    return (r.outcome === 'ok' && r.effects.found_by === 'created' && w.length === 1 && w[0].path === 'purchase_invoices.json' && w[0].query.send === 'draft'
      && b.PurchaseOrder.draft === 1 && b.PurchaseOrder.supplier_id === Number(sup) && b.PurchaseOrder.date === RIYADH_TODAY && b.PurchaseOrder.notes === '[MARSA-REF:MRSP-0123456789AB]'
      && b.PurchaseOrderItem.length === 1 && b.PurchaseOrderItem[0].tax1 === 0 && b.PurchaseOrderItem[0].tax2 === 0 && b.PurchaseOrderItem[0].unit_price === 750
      && b.PurchaseOrderItem[0].product_id === Number(tp) && seq[0] === 'GET purchase_invoices.json' && seq[seq.length - 1] === 'GET purchase_invoices/' + r.effects.external_purchase_id + '.json'
      && r.effects.daftra_url === 'https://marsa-fake.daftra.com/owner/purchase_invoices/view/' + r.effects.external_purchase_id) || J({ r: r.effects || r, seq, b });
  });
  await check('purchase_push a second time (same reference): found by the notes marker, no second POST', async () => {
    const { S } = fresh();
    const sup = S.control.addSupplier({ business_name: 'شركة النقل' });
    const tp = S.control.addProduct({ name: 'تكلفة النقل', product_code: '191' });
    const ctx = () => ({ job: { id: 'j', org_id: 'o', kind: 'purchase_push', options: {}, previous_status: 'unknown' }, connection: conn({ policy: HF5 }),
      purchase: { id: 'pu-1', reference: 'MRSP-AAAAAAAAAAAA', supplier_external_id: sup, external_purchase_id: null, status: 'open', invoice_date: RIYADH_TODAY,
        item: { item_key: 'item:transportation_cost', external_product_id: tp, status: 'linked', name_ar: 'تكلفة النقل' }, lines: [{ quantity: 1, unit_price: 100, vat_rate: 0 }], currency: 'SAR' } });
    const L = liveOf(S, { policy: HF5 });
    const a = await runJob(ctx(), L, { deps: DEPS, clock });
    const b = await runJob(ctx(), L, { deps: DEPS, clock });
    return (a.effects.found_by === 'created' && b.effects.found_by === 'ref' && b.effects.external_purchase_id === a.effects.external_purchase_id
      && nonGet(S).length === 1 && S.state.purchases.length === 1) || J({ a: a.effects, b: b.effects });
  });
  await check('a redirect is never followed: 302 → not_configured (redirect), ONE request recorded', async () => {
    const { S } = fresh();
    S.faults.push({ method: 'GET', path: /^clients\.json$/, status: 302, body: '' });
    const r = await runJob(runCtx('client_import'), liveOf(S), { deps: DEPS, clock });
    return (r.outcome === 'failed' && r.error.code === 'redirect' && AD.errorCode(r.error) === 'not_configured' && S.requests.length === 1) || J({ r, n: S.requests.length });
  });
  await check('the stub transport never touched the network (fetch was never called)', () => fetchCalls === 0 || 'fetch calls: ' + fetchCalls);
}

/* ================================================================== 5. end to end */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const CLIENT_A2 = 'a7e10000-0000-4000-8000-000000000102';
const CARRIER = 'a7e20000-0000-4000-8000-000000000002';
const U = {
  admin: 'a7ef0000-0000-4000-8000-000000000001', mgr: 'a7ef0000-0000-4000-8000-000000000004', acc: 'a7ef0000-0000-4000-8000-000000000003',
  jed: 'a7ef0000-0000-4000-8000-000000000007', trJ: 'a7ef0000-0000-4000-8000-000000000008'
};
let db;
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
async function one(sql, params) { return (await q(sql, params))[0]; }
async function asUser(who, fn) {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [J({ sub: U[who], role: 'authenticated', aal: 'aal2' })]);
  await db.exec(`SET ROLE authenticated;`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function asService(fn) {
  await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
const rpc = (who, sql, params) => asUser(who, () => q(sql, params)).then(r => r[0].r);
async function code(fn) {
  try { await fn(); return 'ok'; } catch (e) { return (e.message || '') + (e.detail ? ' ' + e.detail : ''); }
}
let keySeq = 0;
const newKey = () => 'a7efaaab-0000-4000-8000-' + String(++keySeq).padStart(12, '0');
const SVC_TYPES = { p_worker: 'text', p_limit: 'int', p_attempt: 'uuid', p_result: 'jsonb', p_org: 'uuid', p_state: 'jsonb', p_version: 'int' };
async function svc(name, a) {
  if (!/^daftra_[a-z_]+$/.test(name)) throw new Error('the worker may call only daftra_* service RPCs, got ' + name);
  const keys = Object.keys(a || {});
  const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${SVC_TYPES[k] || 'text'}`).join(', ')}) r`;
  return (await asService(() => q(sql, keys.map(k => (SVC_TYPES[k] === 'jsonb' ? J(a[k]) : a[k])))))[0].r;
}

async function secE2E() {
  section('5. end to end: PGlite + the REAL worker + the live adapter over the stub (owner defaults: HF5 + resolve-only, unchanged)');
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) SELECT v.id::uuid, v.k || '@l7worker.example.com', now() FROM (VALUES
      ('${U.admin}','admin'),('${U.mgr}','mgr'),('${U.acc}','acc'),('${U.jed}','jed'),('${U.trJ}','trj')) v(id, k);
    INSERT INTO public.profiles (id, full_name) SELECT u.id, split_part(u.email, '@', 1) FROM auth.users u WHERE u.email LIKE '%@l7worker.example.com'
      ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
    INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES ('${CLIENT_A2}', '${A}', 'business', 'مؤسسة الاختبار الثانية', 'Second Test', '0509990002');
    INSERT INTO public.parties (id, org_id, kinds, name_ar) VALUES ('${CARRIER}', '${A}', ARRAY['carrier'], 'شركة النقل التجريبية');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.admin}', '${A}', NULL, 'admin'), ('${U.mgr}', '${A}', NULL, 'accounts_manager'), ('${U.acc}', '${A}', NULL, 'accountant'),
      ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.trJ}', '${A}', '${JED}', 'transport_staff');
  `);
  pass('shim + every migration + seed + fixtures (no write-policy override: the owner defaults)');

  // the Daftra account starts EGYPT-configured (owner decision: the guard must refuse every write until it is switched)
  let S = FDS.createFakeDaftraServer({ apiKey: KEY, site: { currency_code: 'EGP', country_code: 'EG' },
    taxes: [{ id: 7, name: 'VAT', value: 14, included: 0, is_active: 1 }] });
  const http = (req) => S.inProcess()(req);
  const adapters = [];
  const adapterFor = (connection, orgId) => {
    if (connection && connection.mode === 'live' && orgId === A && connection.subdomain === 'marsa-fake') {
      const L = AD.createRealAdapter({ impl: DL.createDaftraLive, deps: DEPS, http, apiKey: KEY, baseUrl: 'http://127.0.0.1:9999/api2', allowLoopback: true,
        expectSubdomain: 'marsa-fake', clock: () => new Date().toISOString(), timeouts: { read: 2000, write: 2000 }, deadlineMs: 8000, policy: connection.policy });
      adapters.push(connection.policy);
      return L;
    }
    return AD.createRealAdapter({ subdomain: connection && connection.subdomain });
  };
  const worker = createWorker({ rpc: svc, adapterFor, workerId: 'l7-worker', deps: DEPS, callTimeoutMs: 10000 });
  async function runAll(max) {
    const tot = { claimed: 0, ok: 0, retry: 0, failed: 0, unknown: 0, conflict: 0, results: [] };
    for (let i = 0; i < (max || 25); i++) {
      const r = await worker.runOnce({ limit: 5 });
      for (const k of Object.keys(tot)) if (k !== 'results') tot[k] += r[k] || 0;
      tot.results.push(...r.results);
      if (!r.claimed) break;
    }
    const bad = tot.results.filter(x => x.complete_error);
    if (bad.length) throw new Error('complete_job errors: ' + J(bad));
    return tot;
  }
  const wake = () => q(`UPDATE public.billing_sync_jobs SET next_run_at = now() WHERE status IN ('queued','unknown')`);
  const writes = () => S.requests.filter(r => r.method !== 'GET');
  const today = (await one(`SELECT to_char((now() AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD') d`)).d;
  let ctrSeq = 0;
  async function mkTx(o) {
    const x = Object.assign({ client: CLIENT_A, containers: 1 }, o || {});
    const tx = await one(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, container_count, bl_number, port_code, goods_description, country)
                          VALUES ($1, $2, $3, 'import', 'sea', $4, $5, 'SAJED', 'قطع غيار', 'الصين') RETURNING id, ref`, [A, JED, x.client, x.containers, 'BLW' + (++ctrSeq)]);
    const ctrs = [];
    for (let i = 0; i < x.containers; i++) {
      const c = 'TSTU' + String(2000000 + (++ctrSeq)).slice(-7);
      ctrs.push(c);
      await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, tx.id, c]);
    }
    return { id: tx.id, ref: tx.ref, bl: 'BLW' + (ctrSeq - x.containers), ctrs };
  }
  const blOf = async t => (await one(`SELECT bl_number FROM public.transactions WHERE id = $1`, [t.id])).bl_number;
  const addDecl = (t, no) => rpc('jed', `SELECT public.add_declaration($1, $2) r`, [t.id, { declaration_no: no, declaration_type: 'استيراد', declaration_date: '2026-11-05', status: 'submitted' }]);
  async function charge(t, o) {
    const x = Object.assign({ service: 'customs_clearance', price: 1000, desc: 'أجور التخليص' }, o || {});
    return (await one(`INSERT INTO public.client_charges (org_id, transaction_id, kind, service_code, description, quantity, unit_price, net_amount, vat_rate, vat_amount,
                         total_amount, status) VALUES ($1, $2, 'service', $3, $4, 1, $5::numeric, $5::numeric, 15, $5::numeric * 0.15, $5::numeric * 1.15, 'approved') RETURNING id`,
      [A, t.id, x.service, x.desc, x.price])).id;
  }

  /* --- connection + probe on the Egypt account */
  await rpc('mgr', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'live', subdomain: 'marsa-fake', sync_enabled: true }]);
  await rpc('mgr', `SELECT public.request_daftra_probe($1, $2) r`, [A, newKey()]);
  await runAll();
  await check('probe on the Egypt-configured account: connected, account profile EGP / EG / [14]; the probe sent GETs only', async () => {
    const c = await one(`SELECT status, account_profile p FROM public.daftra_connections WHERE org_id = $1`, [A]);
    return (c.status === 'connected' && c.p.currency === 'EGP' && c.p.country === 'EG' && J(c.p.vat_rates) === J([14]) && writes().length === 0) || J(c);
  });
  const CL_EXT = S.control.addClient({ business_name: 'عميل الاختبار', client_number: 'C-100' });
  const OTHER_EXT = S.control.addClient({ business_name: 'عميل آخر', client_number: 'C-200' });
  const P186 = S.control.addProduct({ name: 'أجور تخليص', product_code: '186', tax1: 1 });
  S.control.addProduct({ name: 'أجور تخليص قديمة', product_code: '1860', tax1: 1 });
  await q(`INSERT INTO public.daftra_client_links (org_id, client_id, client_ref, external_id, status, linked_at) VALUES ($1, $2, $3, $4, 'linked', now())`,
    [A, CLIENT_A, 'MRSC-' + CLIENT_A, CL_EXT]);
  await rpc('mgr', `SELECT public.save_daftra_custom_fields($1, $2) r`, [A, { fields: {
    declaration_no: { key: 'cf_decl', required: true }, declaration_date: { key: 'cf_date' }, bl: { key: 'cf_bl', required: true }, port: { key: 'cf_port' },
    declaration_type: { key: 'cf_type' }, containers: { key: 'cf_ctr' }, goods: { key: 'cf_goods' }, origin: { key: 'cf_origin' } } }]);

  /* --- products: code 000186 configured, matched over HTTP, confirmed by a human */
  await rpc('mgr', `SELECT public.save_daftra_product_code($1, $2, $3) r`, [A, 'service:customs_clearance', '000186']);
  const run = await rpc('mgr', `SELECT public.request_daftra_product_match($1, $2, $3) r`, [A, { item_keys: ['service:customs_clearance'] }, newKey()]);
  await runAll();
  await check('product_match (read-only) over HTTP: the Daftra product 186 is the exact candidate of 000186; 1860 is not; nothing linked yet', async () => {
    const il = await one(`SELECT status, candidates FROM public.daftra_item_links WHERE org_id = $1 AND item_key = 'service:customs_clearance'`, [A]);
    const r = await one(`SELECT status, counters FROM public.daftra_runs WHERE id = $1`, [run.id]);
    const ex = (il.candidates || []).filter(c => c.exact);
    return (r.status === 'done' && il.status === 'pending' && ex.length === 1 && ex[0].external_product_id === P186 && writes().length === 0) || J({ il, r });
  });
  await rpc('mgr', `SELECT public.confirm_daftra_product_mapping($1, $2, $3) r`, [A, 'service:customs_clearance', { external_product_id: P186 }]);

  /* --- Egypt: the push is refused; a job queued meanwhile fails at the claim; nothing is written */
  const t1 = await mkTx();
  await charge(t1);
  await addDecl(t1, 'DCL-E2E-1');
  const it1 = await rpc('acc', `SELECT public.create_billing_intent($1) r`, [{ transaction_id: t1.id }]);
  await check('Egypt account: request_billing_push → MRS_DAFTRA_ACCOUNT_NOT_KSA currency (nothing queued, nothing sent)', async () => {
    const r = await code(() => rpc('acc', `SELECT public.request_billing_push($1) r`, [it1.id]));
    return (/^MRS_DAFTRA_ACCOUNT_NOT_KSA currency/.test(r) && writes().length === 0) || r;
  });

  /* --- the owner switches the account to KSA; a new probe */
  S.state.site.currency_code = 'SAR'; S.state.site.country_code = 'SA';
  S.state.taxes.splice(0, S.state.taxes.length, { id: 1, name: 'VAT', value: 15, included: 0, is_active: 1, site_id: 1 });
  await rpc('mgr', `SELECT public.request_daftra_probe($1, $2) r`, [A, newKey()]);
  await runAll();
  const pr1 = await rpc('acc', `SELECT public.request_billing_push($1) r`, [it1.id]);
  // the account flips back to Egypt before the worker runs (a stale profile): the queued write job must fail at the claim
  await q(`UPDATE public.daftra_connections SET account_profile = '{"currency":"EGP","country":"EG","vat_rates":[14]}' WHERE org_id = $1`, [A]);
  const n0 = S.requests.length;
  await runAll();
  await check('a write job queued before the account changed back to Egypt: failed account_not_ksa at the claim; ZERO requests', async () => {
    const j = await one(`SELECT status, last_error_code FROM public.billing_sync_jobs WHERE id = $1`, [pr1.job.id]);
    return (j.status === 'failed' && j.last_error_code === 'account_not_ksa' && S.requests.length === n0) || J(j);
  });
  await rpc('mgr', `SELECT public.request_daftra_probe($1, $2) r`, [A, newKey()]);
  await runAll();
  await rpc('acc', `SELECT public.retry_billing_job($1) r`, [pr1.job.id]).catch(() => null);
  await wake();
  const wm = writes().length;
  await runAll();
  const i1 = await one(`SELECT * FROM public.billing_intents WHERE id = $1`, [it1.id]);
  await check('KSA account: ONE new draft — POST invoices.json with the Riyadh date (= the DB claim date), po_number, CustomModel, the product 186; no PUT, no POST products', async () => {
    const w = writes().slice(wm);
    const b = w[0] && w[0].body;
    const it = b && b.InvoiceItem[0];
    return (w.length === 1 && w[0].path === 'invoices.json' && b.Invoice.draft === 1 && b.Invoice.date === today && i1.invoice_date && b.Invoice.po_number === i1.operational_ref
      && b.CustomModel.cf_decl[0] === 'DCL-E2E-1' && b.CustomModel.cf_date === '05/11/2026' && b['type_CustomModel.cf_date'] === 'date' && b.CustomModel.cf_bl[0] === t1.bl
      && b.CustomModel.cf_type[0] === 'وارد' && it.product_id === Number(P186) && it.description === '' && i1.status === 'draft' && i1.sync_state === 'synced'
      && !S.requests.some(r => r.method === 'PUT' || (r.method === 'POST' && r.path === 'products.json'))) || J({ w: w.map(x => x.path), b, i1 });
  });
  await check('the draft row: daftra_url (https view link), external id, no date / read-back review item', async () => {
    const rv = await q(`SELECT kind FROM public.billing_review_items WHERE intent_id = $1 AND status = 'open'`, [it1.id]);
    return (i1.daftra_url === 'https://marsa-fake.daftra.com/owner/invoices/view/' + i1.external_invoice_id && rv.length === 0) || J({ url: i1.daftra_url, rv });
  });

  /* --- date_mismatch */
  const t2 = await mkTx();
  await charge(t2);
  await addDecl(t2, 'DCL-E2E-2');
  const it2 = await rpc('acc', `SELECT public.create_billing_intent($1) r`, [{ transaction_id: t2.id }]);
  await rpc('acc', `SELECT public.request_billing_push($1) r`, [it2.id]);
  S.control.storeDateAs('2026-01-01');
  await runAll();
  await check('Daftra stores another date than the Riyadh date sent → ONE date_mismatch review item (expected / stored / Asia/Riyadh)', async () => {
    const r = await one(`SELECT details FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'date_mismatch' AND status = 'open'`, [it2.id]);
    return (r && r.details.stored === '2026-01-01' && r.details.expected === today && r.details.time_zone === 'Asia/Riyadh') || J(r);
  });

  /* --- HF5: a line added after the draft exists */
  const c2 = await charge(t1, { price: 300, desc: 'رسوم إضافية' });
  await rpc('acc', `SELECT public.add_billing_lines($1, $2) r`, [it1.id, [c2]]);
  const wh = writes().length;
  await wake();
  await runAll();
  await check('HF5: the added line → ONE manual_in_daftra item; push refused (MRS_DAFTRA_DRAFT_LOCKED); the worker sends NO write', async () => {
    const m = await one(`SELECT details FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'manual_in_daftra' AND status = 'open'`, [it1.id]);
    const r = await code(() => rpc('acc', `SELECT public.request_billing_push($1) r`, [it1.id]));
    return (m && m.details.add.length === 1 && /^MRS_DAFTRA_DRAFT_LOCKED manual_in_daftra/.test(r) && writes().length === wh && S.state.invoices[0].items.length === 1) || J({ m, r });
  });

  /* --- pull: client_mismatch */
  S.state.invoices.find(x => x.Invoice.id === i1.external_invoice_id).Invoice.client_id = OTHER_EXT;
  await rpc('acc', `SELECT public.request_billing_pull($1) r`, [it1.id]);
  await runAll();
  await check('invoice_pull (GET only) reports remote_client_id → another Daftra client → client_mismatch review item', async () => {
    const r = await one(`SELECT details FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'client_mismatch' AND status = 'open'`, [it1.id]);
    const i = await one(`SELECT remote_client_id FROM public.billing_intents WHERE id = $1`, [it1.id]);
    return (r && r.details.remote_client_id === OTHER_EXT && i.remote_client_id === OTHER_EXT) || J({ r, i });
  });

  /* --- opening zero draft on a declaration */
  await rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, 'test: owner setting') r`, [A, { auto_draft_on_declaration: true }]);
  await rpc('mgr', `SELECT public.save_daftra_product_code($1, $2, $3) r`, [A, 'item:customs_clearance', '000186']);
  await q(`UPDATE public.daftra_item_links SET external_product_id = $2, status = 'linked' WHERE org_id = $1 AND item_key = 'item:customs_clearance'`, [A, P186]);
  const t3 = await mkTx();
  const wo = writes().length;
  await addDecl(t3, 'DCL-E2E-3');
  await runAll();
  await check('opening: the declaration opens ONE zero draft — po_number = the transaction ref, one clearance item at 0, empty description, the custom fields', async () => {
    const i = await one(`SELECT * FROM public.billing_intents WHERE transaction_id = $1 AND origin = 'opening'`, [t3.id]);
    const w = writes().slice(wo);
    const b = w[0] && w[0].body;
    return (i && i.status === 'draft' && w.length === 1 && b.Invoice.po_number === t3.ref && b.InvoiceItem.length === 1 && b.InvoiceItem[0].unit_price === 0
      && b.InvoiceItem[0].description === '' && b.InvoiceItem[0].product_id === Number(P186) && b.CustomModel.cf_decl[0] === 'DCL-E2E-3'
      && (await one(`SELECT count(*)::int n FROM public.billing_review_items WHERE intent_id = $1 AND kind IN ('readback_mismatch','date_mismatch')`, [i.id])).n === 0) || J({ i, b });
  });
  await rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, 'test: owner setting') r`, [A, { auto_draft_on_declaration: false }]);

  /* --- client import */
  S.control.addClient({ business_name: 'Gulf Trading', secondary_name: 'الخليج للتجارة', client_number: 'C-300', bn1: '310000000000003' });
  const wi = writes().length;
  const imp = await rpc('mgr', `SELECT public.request_daftra_client_import($1, $2) r`, [A, newKey()]);
  await runAll();
  await check('client_import over HTTP: rows staged (link by Daftra id for the linked client), the run ready; GET only, nothing deleted', async () => {
    const r = await one(`SELECT status, counters FROM public.daftra_runs WHERE id = $1`, [imp.id]);
    const rows = await q(`SELECT external_id, name_ar, proposed_action FROM public.daftra_client_import_rows WHERE run_id = $1 ORDER BY seq`, [imp.id]);
    const linked = rows.find(x => x.external_id === CL_EXT);
    return (r.status === 'ready' && rows.length === 3 && linked.proposed_action === 'update_link' && rows.some(x => x.name_ar === 'الخليج للتجارة')
      && writes().length === wi && S.state.clients.length === 3) || J({ r, rows });
  });

  /* --- invoice lookup (composite): two exact matches → review; another client → blocked */
  const t4 = await mkTx();
  await addDecl(t4, 'DCL-E2E-4');
  const bl4 = await blOf(t4);
  for (const [cl, no] of [[CL_EXT, 'INV-5001'], [CL_EXT, 'INV-5002'], [OTHER_EXT, 'INV-5003']]) {
    S.control.setInvoiceFields(S.control.addInvoice({ client_id: cl, draft: 0, no }), { cf_decl: ['DCL-E2E-4'], cf_bl: [bl4], cf_ctr: [t4.ctrs.join(', ')] });
  }
  S.config.keywordsCoverCustom = true;
  const lk = await rpc('acc', `SELECT public.request_daftra_invoice_lookup($1, $2, $3) r`, [t4.id, { mode: 'composite' }, newKey()]);
  await runAll();
  await check('invoice_lookup composite over HTTP: 2 exact matches of the linked client → review, another client\'s → blocked; GET only', async () => {
    const c = await q(`SELECT daftra_number, state, client_check FROM public.daftra_invoice_candidates WHERE transaction_id = $1 ORDER BY daftra_number`, [t4.id]);
    const j = await one(`SELECT status FROM public.billing_sync_jobs WHERE id = $1`, [lk.job.id]);
    return (j.status === 'done' && J(c.map(x => x.daftra_number + ':' + x.state)) === J(['INV-5001:review', 'INV-5002:review', 'INV-5003:blocked'])
      && S.requests.filter(r => r.method !== 'GET').length === writes().length) || J({ c, j });
  });

  /* --- legacy scan in batches: an older invoice of t1 made in the Daftra UI (not behind any intent) */
  S.control.setInvoiceFields(S.control.addInvoice({ client_id: CL_EXT, draft: 0, no: 'INV-6001' }),
    { cf_decl: ['DCL-E2E-1'], cf_bl: [t1.bl], cf_ctr: [t1.ctrs.join(', ')] });
  const scan = await rpc('mgr', `SELECT public.request_daftra_legacy_scan($1, $2, $3) r`, [A, { page_size: 2, pages_per_job: 1 }, newKey()]);
  await runAll(40);
  await check('legacy_scan over HTTP: several batches (cursor), the run done; candidates for the exact composite matches; GET only', async () => {
    const r = await one(`SELECT status, pages, counters FROM public.daftra_runs WHERE id = $1`, [scan.id]);
    const c = await q(`SELECT transaction_id, daftra_number, state FROM public.daftra_invoice_candidates WHERE run_id = $1`, [scan.id]);
    const jobs = await one(`SELECT count(*)::int n FROM public.billing_sync_jobs WHERE run_id = $1 AND status = 'done'`, [scan.id]);
    return (r.status === 'done' && r.pages >= 3 && jobs.n === r.pages && r.counters.invoices_seen >= 7 && c.length === 1 && c[0].transaction_id === t1.id
      && c[0].daftra_number === 'INV-6001' && c[0].state === 'open') || J({ r, c, jobs });
  });

  /* --- supplier search + purchase draft per trip */
  const t5 = await mkTx({ containers: 0 });
  const trip = await one(`INSERT INTO public.transport_trips (org_id, transaction_id, carrier_id, party_type, party_name, status) VALUES ($1, $2, $3, 'company', 'شركة النقل التجريبية', 'delivered') RETURNING *`,
    [A, t5.id, CARRIER]);
  const SUP = S.control.addSupplier({ business_name: 'شركة النقل التجريبية', supplier_number: 'S-1' });
  S.control.addSupplier({ business_name: 'شركة النقل الأخرى' });
  await rpc('trJ', `SELECT public.request_daftra_supplier_search($1, $2, $3) r`, [A, { trip_id: trip.id }, newKey()]);
  await runAll();
  await check('supplier_search over HTTP (GET suppliers.json?name=…): the unique exact name → a supplier link', async () => {
    const l = await one(`SELECT external_supplier_id FROM public.daftra_supplier_links WHERE org_id = $1 AND party_id = $2`, [A, CARRIER]);
    return (l && l.external_supplier_id === SUP && S.requests.some(r => r.path === 'suppliers.json' && r.query.name === 'شركة النقل التجريبية')) || J(l);
  });
  await check('purchase drafts are behind the org flag (OFF by default): MRS_DAFTRA_PURCHASE_DISABLED', async () =>
    /^MRS_DAFTRA_PURCHASE_DISABLED/.test(await code(() => rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip.id, newKey()]))));
  await rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, 'test: owner setting') r`, [A, { purchase_drafts_enabled: true }]);
  const PTR = S.control.addProduct({ name: 'تكلفة النقل', product_code: '191', tax1: 0 });
  await rpc('mgr', `SELECT public.save_daftra_product_code($1, $2, $3) r`, [A, 'item:transportation_cost', '000191']);
  await q(`UPDATE public.daftra_item_links SET external_product_id = $2, status = 'linked' WHERE org_id = $1 AND item_key = 'item:transportation_cost'`, [A, PTR]);
  const acc0 = await one(`SELECT id FROM public.cost_accruals WHERE trip_id = $1`, [trip.id]);
  if (acc0) await q(`UPDATE public.cost_accruals SET amount = 750, status = 'open' WHERE id = $1`, [acc0.id]);
  else await q(`INSERT INTO public.cost_accruals (org_id, transaction_id, source, trip_id, supplier_id, service_code, amount, basis) VALUES ($1, $2, 'trip', $3, $4, 'transport', 750, 'agreed')`,
    [A, t5.id, trip.id, CARRIER]);
  const pd = await rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip.id, newKey()]);
  const wp = writes().length;
  await runAll();
  await check('purchase_push over HTTP: ONE POST purchase_invoices.json?send=draft (zero tax, the transport product, 750, the MRSP marker); the id kept; status draft', async () => {
    const w = writes().slice(wp);
    const p = await one(`SELECT status, sync_state, external_purchase_id, daftra_url FROM public.daftra_purchase_drafts WHERE id = $1`, [pd.id]);
    const b = w[0] && w[0].body;
    return (w.length === 1 && w[0].path === 'purchase_invoices.json' && w[0].query.send === 'draft' && b.PurchaseOrder.draft === 1 && b.PurchaseOrder.supplier_id === Number(SUP)
      && b.PurchaseOrderItem[0].tax1 === 0 && b.PurchaseOrderItem[0].tax2 === 0 && b.PurchaseOrderItem[0].unit_price === 750 && b.PurchaseOrderItem[0].product_id === Number(PTR)
      && b.PurchaseOrder.notes === '[MARSA-REF:' + pd.reference + ']' && p.status === 'draft' && p.sync_state === 'synced' && p.external_purchase_id === S.state.purchases[0].PurchaseOrder.id
      && p.daftra_url === 'https://marsa-fake.daftra.com/owner/purchase_invoices/view/' + p.external_purchase_id) || J({ w: w.map(x => x.path), b, p });
  });
  await check('a second purchase request for the trip is deduplicated; no second POST', async () => {
    const again = await rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip.id, newKey()]);
    await runAll();
    return (again.deduplicated === true && S.state.purchases.length === 1) || J(again);
  });

  await check('over the whole cycle: no PUT, no update_draft, no POST products, no DELETE; every write was a new draft; the adapters got the HF5 policy', () => {
    const bad = S.requests.filter(r => r.method === 'PUT' || r.method === 'DELETE' || /update_draft/.test(r.path) || (r.method === 'POST' && r.path === 'products.json'));
    const w = writes();
    return (bad.length === 0 && w.every(r => (r.path === 'invoices.json' && r.body.Invoice.draft === 1) || (r.path === 'purchase_invoices.json' && r.query.send === 'draft'))
      && adapters.every(p => p.allow_draft_update === false && p.allow_product_create === false) && fetchCalls === 0) || J({ bad: bad.map(r => r.method + ' ' + r.path), w: w.map(r => r.path) });
  });
  await db.close();
}

/* ================================================================== 6. bundle */
async function secBundle() {
  section('6. the single-file Dashboard bundle carries the step-7 code');
  await check('python3 scripts/bundle-edge-function.py daftra-sync → one file with the new methods, the guard policy and the KSA guard', () => {
    const out = execFileSync('python3', ['-I', path.join(ROOT, 'scripts', 'bundle-edge-function.py'), 'daftra-sync'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const need = ['findProductsByCodeNorm', 'createPurchaseDraft', 'draft_update_refused', 'account_not_ksa', 'type_CustomModel.', 'riyadhDate', 'legacyScanJob'];
    return (!/import '\.\//.test(out) && need.every(n => out.includes(n))) || 'missing: ' + need.filter(n => !out.includes(n)).join(', ');
  });
}

/* ================================================================== 7. review regressions */
async function secReview() {
  section('7. review regressions: the account re-read before the first write, 3xx on a write, Ro-Ro, codes, suppliers, purchase checks');
  const freshS = (o) => {
    const S = FDS.createFakeDaftraServer(Object.assign({ apiKey: KEY }, o || {}));
    const cl = S.control.addClient({ business_name: 'عميل الاختبار', client_number: 'C-100' });
    S.control.addProduct({ name: 'أجور تخليص', product_code: '186', tax1: 1 });
    return { S, cl };
  };
  await check('accountCheck: SAR + Saudi Arabia + an active 15 % → null; EGP → currency; EG → country; 15 % inactive → vat_rate; nothing → not_checked', () => {
    const r = [AD.accountCheck({ currency: 'SAR', country: 'SA', taxes: [{ value: '15.00', active: true }] }), AD.accountCheck({ currency: 'EGP', country: 'EG', taxes: [{ value: 14 }] }),
      AD.accountCheck({ currency: 'SAR', country: 'Egypt', taxes: [{ value: 15 }] }), AD.accountCheck({ currency: 'SAR', country: 'SA', taxes: [{ value: 15, active: false }] }),
      AD.accountCheck(null)];
    return J(r) === J([null, 'currency', 'country', 'vat_rate', 'not_checked']) || J(r);
  });
  await check('a live account whose cached profile says KSA but now answers Egypt: the re-read before the first write refuses (account_not_ksa), NO POST', async () => {
    const { S, cl } = freshS({ site: { currency_code: 'EGP', country_code: 'EG' } });
    const r = await runJob(pushCtx({ clientExt: cl }), liveOf(S, { policy: HF5 }), { deps: DEPS, clock });
    const seq = S.requests.map(x => x.method + ' ' + x.path);
    return (r.outcome === 'failed' && r.error.code === 'account_not_ksa' && /fields: currency/.test(r.error.message) && S.requests.every(x => x.method === 'GET')
      && seq.includes('GET site_info.json') && r.calls.some(c => c.op === 'getAccountProfile')) || J({ r: r.error, seq });
  });
  await check('a mock (not enforced) account is not re-read; the same write on a KSA live account re-reads once (site_info, taxes) then POSTs', async () => {
    const m = mock();
    m.control.addProduct({ code: '186', name_ar: 'أجور تخليص' });
    const c = m.control.addClient({ name: 'عميل الاختبار' });
    await runJob(pushCtx({ clientExt: c.id, account: { ok: true, enforced: false } }), m, { deps: AD, clock });
    const { S, cl } = freshS();
    const r = await runJob(pushCtx({ clientExt: cl }), liveOf(S, { policy: HF5 }), { deps: DEPS, clock });
    const seq = S.requests.map(x => x.method + ' ' + x.path);
    const iSite = seq.indexOf('GET site_info.json'), iPost = seq.indexOf('POST invoices.json');
    return (!ops(m).includes('getAccountProfile') && r.outcome === 'ok' && seq.filter(x => x === 'GET site_info.json').length === 1 && iSite >= 0 && iSite < iPost) || J({ o: ops(m), seq });
  });
  await check('a 302 answer to a write POST is «possibly applied» (applied unknown → outcome unknown), never «definitely not applied»', async () => {
    const { S } = freshS();
    const sup = S.control.addSupplier({ business_name: 'شركة النقل' });
    S.control.addProduct({ name: 'تكلفة النقل', product_code: '191' });
    S.faults.push({ method: 'POST', path: /^purchase_invoices\.json$/, status: 302, apply: true });
    const ctx = { job: { id: 'j-pur', org_id: 'org-1', kind: 'purchase_push', attempt_no: 1, options: {}, previous_status: 'queued' }, attempt_id: 'att-pur', connection: conn(),
      purchase: { id: 'pu-1', reference: 'MRSP-0123456789AB', supplier_external_id: String(sup), external_purchase_id: null, status: 'open', invoice_date: RIYADH_TODAY,
        item: { link_id: 'I-t', item_key: 'item:transportation_cost', remote_product_code: '191', remote_code_norm: '191', name_ar: 'تكلفة النقل', status: 'pending' },
        lines: [{ item_key: 'item:transportation_cost', description: 'x', quantity: 1, unit_price: 750, vat_rate: 0 }], amount: 750, currency: 'SAR', tax: 0 } };
    const r = await runJob(ctx, liveOf(S, { policy: HF5 }), { deps: DEPS, clock });
    const post = r.calls.find(c => c.op === 'createPurchaseDraft');
    return (r.outcome === 'unknown' && post && post.applied === 'unknown') || J({ outcome: r.outcome, post, e: r.error });
  });
  await check('containerSet: the legacy Ro-Ro value «Ro-Ro — شاسيه … — لوحة …» → the chassis; Marsa\'s older «chassis / plate» still → the chassis', () => {
    const r = [AD.containerSet('Ro-Ro — شاسيه JTMHV05J804012345 — لوحة 1234'), AD.containerSet('Ro-Ro — شاسيه JTMHV05J804012345'),
      AD.containerSet('JTMHV05J804012345 / 1234'), AD.containerSet('TSTU1000001، TSTU1000002')];
    return J(r) === J([['JTMHV05J804012345'], ['JTMHV05J804012345'], ['JTMHV05J804012345'], ['TSTU1000001', 'TSTU1000002']]) || J(r);
  });
  await check('codeNorm: a leading # and inner spaces are ignored like the legacy (#000186 = 000 186 = 186)', () => {
    const r = [AD.codeNorm('#000186'), AD.codeNorm(' 000 186 '), AD.codeNorm('ab-1'), AD.codeNorm('#')];
    return J(r) === J(['186', '186', 'AB-1', null]) || J(r);
  });
  await check('supplier_search reports the Daftra secondary name (mock and live), so SQL can match it exactly', async () => {
    const m = mock();
    m.control.addSupplier({ name: 'Invoice Party Co', secondary_name: 'جهة الفاتورة' });
    const r = await runJob(runCtx('supplier_search', { params: { q: 'جهة الفاتورة' } }), m, { deps: AD, clock });
    const { S } = freshS();
    S.control.addSupplier({ business_name: 'Invoice Party Co', secondary_name: 'جهة الفاتورة' });
    const r2 = await runJob(runCtx('supplier_search', { params: { q: 'Invoice Party Co' } }), liveOf(S, { policy: HF5 }), { deps: DEPS, clock });
    return (r.outcome === 'ok' && r.effects.suppliers[0].secondary_name === 'جهة الفاتورة' && r2.outcome === 'ok' && r2.effects.suppliers[0].secondary_name === 'جهة الفاتورة')
      || J({ r: r.effects, r2: r2.effects || r2.error });
  });
  await check('purchase draft re-read after the create: Daftra applied a tax / is not a draft → checks (SQL flags purchase_review); the live view reads tax1 / tax2', async () => {
    const m = mock();
    const s = m.control.addSupplier({ name: 'شركة النقل' });
    m.control.addProduct({ code: '191', name_ar: 'تكلفة النقل' });
    m.control.storePurchaseAs({ tax_rate: 15, status: 'issued' });
    const ctx = { job: { id: 'j-pur', org_id: 'org-1', kind: 'purchase_push', attempt_no: 1, options: {}, previous_status: 'queued' }, attempt_id: 'att-pur', connection: conn(),
      purchase: { id: 'pu-1', reference: 'MRSP-0123456789AB', supplier_external_id: s.id, external_purchase_id: null, status: 'open', invoice_date: RIYADH_TODAY,
        item: { link_id: 'I-t', item_key: 'item:transportation_cost', remote_product_code: '191', remote_code_norm: '191', name_ar: 'تكلفة النقل', status: 'pending' },
        lines: [{ item_key: 'item:transportation_cost', description: 'x', quantity: 1, unit_price: 750, vat_rate: 0 }], amount: 750, currency: 'SAR', tax: 0 } };
    const r = await runJob(ctx, m, { deps: AD, clock });
    const { S } = freshS();
    S.state.purchases.push({ PurchaseOrder: { id: '777', supplier_id: '1', draft: 1, notes: '[MARSA-REF:MRSP-0123456789AB]', currency_code: 'SAR' },
      items: [{ id: '1', item: 'x', unit_price: '1', quantity: '1', tax1: '1', tax2: '0' }] });
    const v = await liveOf(S, { policy: HF5 }).getPurchase('777');
    return (r.outcome === 'ok' && J(r.effects.checks) === J({ tax_nonzero: true, not_draft: true, unread: false }) && v.tax_nonzero === true) || J({ r: r.effects, v });
  });
}

(async function main() {
  try {
    await secStatic();
    await secHelpers();
    await secGuard();
    await secMock();
    await secLive();
    await secE2E();
    await secBundle();
    await secReview();
  } catch (e) {
    fail('suite crashed', e && (e.stack || e.message));
  }
  console.log('\n' + '-'.repeat(70));
  if (nFail) {
    console.log('FAILURES:');
    for (const f of fails) console.log('  - ' + f);
    console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed');
    process.exit(1);
  }
  console.log('OK — ' + nPass + ' passed, 0 failed');
})();
