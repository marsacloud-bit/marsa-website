#!/usr/bin/env node
/*
  Marsa (مرسى) — G5b LIVE Daftra adapter tests (docs/online/G5B_DAFTRA_LIVE_AR.md § Tests). LOCAL TESTS ONLY.
  The REAL daftra-live.js + adapter.js (+ worker.js for runJob / runOnce) talk to the loopback fake Daftra API v2 server in
  tests/lib/fake-daftra-server.js through a node-http `http(req)`. Section 9 drives the REAL worker against PGlite (shim +
  every migration + seed) with the live adapter, like g5-cycle-tests does with the mock; section 10 is the SQL side of
  migration 20261111000100_g5b_daftra_live.sql. No real Daftra, no real key, no network beyond 127.0.0.1.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g5b-daftra-live-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const FN = path.join(SUPA, 'functions', 'daftra-sync');
const MIG = '20261111000100_g5b_daftra_live.sql';
const MIG_DIR = path.join(SUPA, 'migrations');
const MIG_FILE = path.join(MIG_DIR, MIG);

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g5b-daftra-live-tests'); };

const AD = require(path.join(FN, 'adapter.js'));
const DL = require(path.join(FN, 'daftra-live.js'));
const { createWorker, runJob } = require(path.join(FN, 'worker.js'));
const FDS = require(path.join(SUPA, 'tests', 'lib', 'fake-daftra-server.js'));
const DEPS = Object.assign({}, AD, DL);              // what index.ts passes: the merged MarsaDaftra API

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + (e && (e.stack || e.message))); }
}
const J = x => JSON.stringify(x);
const errOf = async p => { try { await p; return null; } catch (e) { return e; } };
const FIXED = '2026-11-03T09:00:00.000Z';
const clock = () => FIXED;

const KEY = 'dk_TEST_a1b2c3-NOT-A-REAL-KEY-Zq9';          // test value only, never a real key
const seen = [];                                          // every result / error the adapter produced (key scan)
const keep = x => { seen.push(x); return x; };
const keepErr = async p => { const e = await errOf(p); seen.push(e && { kind: e.kind, code: e.code, message: e.message, applied: e.applied, json: e.toJSON && e.toJSON() }); return e; };

let SRV, BASE;
const nodeHttp = FDS.createNodeHttp();
function live(o) {
  return AD.createRealAdapter(Object.assign({ impl: DL.createDaftraLive, deps: DEPS, http: nodeHttp, apiKey: KEY, baseUrl: BASE,
    allowLoopback: true, clock, timeouts: { read: 2000, write: 2000 }, deadlineMs: 8000 }, o || {}));
}
const reqs = (pred) => SRV.requests.filter(r => !pred || pred(r));
const writes = () => SRV.requests.filter(r => r.method !== 'GET');
const mark = () => SRV.requests.length;
const since = n => SRV.requests.slice(n);
const lref = n => 'MRSL-' + String(n).padStart(16, '0').replace(/[^0-9A-F]/g, 'A');

/* ================================================================== 0. static rules */
async function secStatic() {
  section('0. static: classic script, no network / env / Deno, no key, exports');
  const src = fs.readFileSync(path.join(FN, 'daftra-live.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  await check('daftra-live.js: no require / import / export, no fetch / XMLHttpRequest / WebSocket, no Deno., no process.env', () => {
    const bad = [];
    if (/\brequire\s*\(|^\s*import\s|^\s*export\s/m.test(code)) bad.push('import/require');
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(code)) bad.push('network');
    if (/\bDeno\./.test(code)) bad.push('Deno');
    if (/process\.env/.test(code)) bad.push('process.env');
    if (/(sk_live|eyJ[A-Za-z0-9_-]{20,}|apikey\s*[:=]\s*['"][^'"]+['"])/i.test(code)) bad.push('key-like literal');
    if (/console\./.test(code)) bad.push('console logging');
    return bad.length === 0 || bad.join('; ');
  });
  await check('dual export (module.exports / globalThis.MarsaDaftra) and the API', () =>
    (/module\.exports = API/.test(src) && /globalThis\.MarsaDaftra = Object\.assign/.test(src) && typeof DL.createDaftraLive === 'function'
      && typeof DL.guardDaftraRequest === 'function' && Array.isArray(DL.DAFTRA_LIVE_ALLOWED)) || 'exports');
  await check('index.ts: live gate (org allowlist + subdomain + key), "Marsa" fallback only when MARSA_DAFTRA_API_KEY is empty, AbortSignal timeouts, no key in logs', () => {
    const ts = fs.readFileSync(path.join(FN, 'index.ts'), 'utf8');
    const bad = [];
    if (!/MARSA_DAFTRA_LIVE_ORG/.test(ts) || !/MARSA_DAFTRA_SUBDOMAIN/.test(ts)) bad.push('allowlist env');
    if (!/env\('MARSA_DAFTRA_API_KEY'\) \|\| env\('Marsa'\)/.test(ts)) bad.push('key fallback order');
    if (!/AbortSignal\.timeout/.test(ts)) bad.push('AbortSignal');
    if (/console\./.test(ts)) bad.push('console');
    if (!/impl: D\.createDaftraLive/.test(ts)) bad.push('explicit factory');
    if (!/import '\.\/daftra-live\.js'/.test(ts)) bad.push('import');
    if (/apiKey[^\n]*(json\(|liveRefused|message)/.test(ts)) bad.push('key near output');
    if (!/redirect: 'manual'/.test(ts)) bad.push('redirects');
    return bad.length === 0 || bad.join('; ');
  });
  await check('adapter.js: REAL_ENDPOINTS_TO_VERIFY carries the verified facts; createRealAdapter needs an explicit factory', () => {
    const s = J(AD.REAL_ENDPOINTS_TO_VERIFY);
    return (/VERIFIED/.test(s) && /MARSA_DAFTRA_API_KEY/.test(s) && /update_draft/.test(s) && /po_number/.test(s) && /TAX IDS/.test(s)) || s.slice(0, 200);
  });
}

/* ================================================================== 1. the guard */
async function secGuard() {
  section('1. the hard request guard: never issue, drafts only, allowlist');
  const g = DL.guardDaftraRequest;
  const draft = { Invoice: { draft: 1, client_id: 1 }, InvoiceItem: [] };
  await check('update_draft refused in every form (GET /0, /1, query, upper case, via PUT)', () => {
    const r = [g('GET', 'invoices/update_draft/12/0.json'), g('GET', 'invoices/update_draft/12/1.json'), g('GET', 'invoices.json', null, '?x=update_draft'),
      g('GET', 'invoices/UPDATE_DRAFT/12/0.json'), g('PUT', 'invoices/update_draft/12/0.json', draft)];
    return r.every(x => x === 'issue_refused') || J(r);
  });
  await check('invoice writes need Invoice.draft === 1 exactly (0, false, true, "1", missing → refused)', () => {
    const r = [0, false, true, '1', undefined].map(d => g('POST', 'invoices.json', { Invoice: { draft: d, client_id: 1 } }))
      .concat([g('PUT', 'invoices/5.json', { Invoice: { draft: 0 } }), g('POST', 'invoices.json', { InvoiceItem: [] }), g('POST', 'invoices.json', null)]);
    return (r.every(x => x === 'draft_required') && g('POST', 'invoices.json', draft) === null && g('PUT', 'invoices/5.json', draft) === null) || J(r);
  });
  await check('payments / deposits / reminders never sent with an invoice', () => {
    const r = ['Payment', 'InvoicePayment', 'Deposit', 'InvoiceReminder'].map(k => g('POST', 'invoices.json', Object.assign({}, draft, { [k]: [{}] })));
    return r.every(x => x === 'payment_refused') || J(r);
  });
  await check('anything outside the allowlist refused (payments, credit notes, deletes, bulk, v2, traversal, absolute)', () => {
    const r = [g('POST', 'invoice_payments.json', {}), g('GET', 'invoice_payments.json'), g('POST', 'credit_notes.json', {}), g('DELETE', 'invoices/5.json'),
      g('DELETE', 'clients/5.json'), g('POST', 'clients/bulk.json', {}), g('PUT', 'products/5.json', {}), g('GET', '../v2/api/entity/client/list/1'),
      g('GET', '/clients.json'), g('GET', 'clients/5.json?x'), g('POST', 'invoices/5/send.json', draft), g('GET', 'clients/abc.json')];
    return r.every(x => x === 'path_refused') || J(r);
  });
  await check('the 12 allowed pairs pass', () => {
    const r = [['GET', 'site_info.json'], ['GET', 'taxes.json'], ['GET', 'clients.json'], ['GET', 'clients/9.json'], ['POST', 'clients.json', {}],
      ['PUT', 'clients/9.json', {}], ['GET', 'products.json'], ['POST', 'products.json', {}], ['GET', 'invoices.json'], ['GET', 'invoices/9.json'],
      ['POST', 'invoices.json', draft], ['PUT', 'invoices/9.json', draft]].map(x => g(x[0], x[1], x[2]));
    return (r.every(x => x === null) && DL.DAFTRA_LIVE_ALLOWED.length === 12) || J(r);
  });
}

/* ================================================================== 2. factory */
async function secFactory() {
  section('2. createRealAdapter: explicit factory → live; otherwise the not_configured stub');
  await check('createRealAdapter({}) and without a factory / http / key / url → stub: every method not_configured, no request', async () => {
    const n = mark();
    const cfgs = [{}, { http: nodeHttp, apiKey: KEY, baseUrl: BASE }, { impl: DL.createDaftraLive, apiKey: KEY, baseUrl: BASE },
      { impl: DL.createDaftraLive, http: nodeHttp, baseUrl: BASE }, { impl: DL.createDaftraLive, http: nodeHttp, apiKey: KEY }];
    const kinds = [];
    for (const c of cfgs) {
      const a = AD.createRealAdapter(c);
      for (const m of AD.ADAPTER_METHODS) { const e = await errOf(a[m]('1')); kinds.push(e ? e.kind + '/' + e.applied : 'ok'); }
    }
    return (kinds.every(k => k === 'not_configured/no') && since(n).length === 0) || J(Array.from(new Set(kinds)));
  });
  await check('a bad base URL (non-daftra https, http, loopback without allowLoopback, bad subdomain) → not_configured config_base_url, no request', async () => {
    const n = mark();
    const r = [];
    for (const u of ['https://evil.example.com/api2', 'http://marsa.daftra.com/api2', BASE.replace('/api2', '/x'), 'https://UPPER.daftra.com/api2', 'https://a.b.daftra.com/api2']) {
      const e = await errOf(live({ baseUrl: u }).probe());
      r.push(e && e.kind + ':' + e.code);
    }
    const e2 = await errOf(live({ allowLoopback: false }).probe());
    r.push(e2 && e2.kind + ':' + e2.code);
    return (r.every(x => x === 'not_configured:config_base_url') && since(n).length === 0) || J(r);
  });
  await check('a real-looking https base URL is accepted (adapter built; nothing called here)', () => {
    const a = DL.createDaftraLive({ deps: DEPS, http: async () => { throw new Error('not called'); }, apiKey: KEY, baseUrl: 'https://marsacloud.daftra.com/api2' });
    return (a.mode === 'live' && AD.ADAPTER_METHODS.every(m => typeof a[m] === 'function')) || 'not built';
  });
}

/* ================================================================== 3. probe */
async function secProbe() {
  section('3. probe: read-only, honest capabilities, account + taxes');
  const n = mark();
  const p = keep(await live().probe());
  const rq = since(n);
  await check('probe sends only GETs: site_info, taxes, one page of clients / products / invoices / API invoices (id DESC)', () =>
    (rq.every(r => r.method === 'GET') && rq.map(r => r.path).join(',') === 'site_info.json,taxes.json,clients.json,products.json,invoices.json,invoices.json'
      && rq[5].query.external_source === 'api' && rq[5].query.sort === 'id' && rq[5].query.direction === 'DESC'
      && rq.every(r => r.apikey && !r.authorization)) || J(rq.map(r => r.method + ' ' + r.path)));
  await check('every CAPABILITY_KEYS key reported with evidence; invoices.issue and credit_notes.create false (policy)', () => {
    const k = Object.keys(p.capabilities);
    const off = k.filter(x => !p.capabilities[x].supported).sort().join(',');
    return (k.length === AD.CAPABILITY_KEYS.length && AD.CAPABILITY_KEYS.every(x => p.capabilities[x] && typeof p.capabilities[x].evidence === 'string'
      && p.capabilities[x].evidence.length > 10 && p.capabilities[x].evidence.length <= 300) && off === 'credit_notes.create,invoices.issue'
      && /never issues/.test(p.capabilities['invoices.issue'].evidence)
      && AD.PUSH_REQUIRED_CAPABILITIES.every(x => p.capabilities[x].supported === true)) || J(p.capabilities);
  });
  await check('evidence is honest: create / update "not exercised", bn1 / po_number / description observations', () => {
    const c = p.capabilities;
    return (/not exercised/.test(c['clients.create'].evidence) && /not exercised/.test(c['products.create'].evidence)
      && /NOT seen|not observable/.test(c['invoices.line_reference_field'].evidence) && /NOT seen/.test(c['invoices.search_by_reference'].evidence)
      && /draft = 1/.test(c['invoices.create_draft'].evidence)) || J(c);
  });
  await check('account: name, currency, country, subdomain, taxes (id, name, value, included, active), tax_map 15.00 → 1 (inclusive / inactive skipped)', () => {
    const a = p.account;
    return (a.name === 'Fake Logistics Co' && a.currency === 'SAR' && a.country === 'SA' && a.subdomain === 'marsa-fake' && a.taxes.length === 3
      && a.taxes.every(t => 'id' in t && 'name' in t && 'value' in t && 'included' in t && 'active' in t) && a.tax_map['15.00'] === '1'
      && /none/.test(a.tax_map['0.00']) && a.counts && a.counts.clients === 0) || J(a);
  });
  await check('probe through worker.runJob: 17 capabilities kept (incl. invoices.version_token), account passed through', async () => {
    const r = await runJob({ job: { id: 'j', org_id: 'o', kind: 'probe', options: {} } }, live(), { deps: AD, clock });
    return (r.outcome === 'ok' && Object.keys(r.effects.capabilities).length === 17 && r.effects.capabilities['invoices.version_token'].supported === true
      && r.effects.account.tax_map['15.00'] === '1' && r.calls.length === 1 && r.calls[0].op === 'probe') || J(r);
  });
  await check('identity binding: a site whose subdomain differs from the expected one → not_configured account_mismatch', async () => {
    const e = await keepErr(live({ expectSubdomain: 'other-co' }).probe());
    const ok2 = keep(await live({ expectSubdomain: 'marsa-fake' }).probe());
    return (e && e.kind === 'not_configured' && e.code === 'account_mismatch' && ok2.account.subdomain === 'marsa-fake') || J(e);
  });
  await check('a bad key → 401 → not_configured auth_failed on the first call (probe job fails, never retried as transient)', async () => {
    const e = await keepErr(live({ apiKey: 'wrong-key' }).probe());
    return (e && e.kind === 'not_configured' && e.code === 'auth_failed' && e.http_status === 401 && e.applied === 'no') || J(e);
  });
}

/* ================================================================== 4. clients */
async function secClients() {
  section('4. clients: exact ref, VAT, create (202), read, partial update');
  const L = live();
  const ref = 'MRSC-0b5e0000-0000-4000-8000-000000000101';
  const n0 = mark();
  const c1 = keep(await L.createClient({ ref, name: ' شركة البحر الأزرق ', name_en: 'Blue Sea', vat_number: '300000000000003', cr_number: '4030000001',
    address_short: 'RRRD2929', address: '1 Street, Jeddah', email: 'billing@blue.example', phone: '0500000001' }));
  const post = since(n0).find(r => r.method === 'POST');
  await check('createClient: POST clients.json {Client} with client_number = ref, type 3, bn1/bn2 + labels; 202 → id', () => {
    const b = post && post.body && post.body.Client;
    return (c1.id && /^\d+$/.test(c1.id) && b && b.client_number === ref && b.type === 3 && b.business_name === 'شركة البحر الأزرق' && b.bn1 === '300000000000003'
      && b.bn1_label === 'VAT' && b.bn2 === '4030000001' && b.bn2_label === 'CR' && b.address1 === '1 Street, Jeddah' && b.address2 === 'RRRD2929'
      && b.phone1 === '0500000001' && post.status === 202 && !('name_en' in b)) || J({ c1, post });
  });
  // decoys: a fuzzy keyword hit that is not exact (…1010) and a client with another number
  SRV.state.clients.push({ id: '90', client_number: ref + '0', business_name: 'decoy', bn1: '300000000000003' });
  SRV.state.clients.push({ id: '91', client_number: 'X-1', business_name: 'other' });
  await check('findClientByRef: exact client_number match (fuzzy keyword decoy ignored); unknown ref → null', async () => {
    const r = keep(await L.findClientByRef(ref));
    const none = await L.findClientByRef('MRSC-0b5e0000-0000-4000-8000-000000000999');
    const q = SRV.requests.filter(x => x.path === 'clients.json' && x.query.keywords === ref);
    return (r && r.id === c1.id && r.ref === ref && none === null && q.length >= 1) || J({ r, none });
  });
  await check('getClient: the snapshot shape (name, vat, cr, address, short address, email, phone; name_en null — no Daftra field)', async () => {
    const r = keep(await L.getClient(c1.id));
    const n = AD.normalizeClient(r);
    return (n.name === 'شركة البحر الأزرق' && n.vat_number === '300000000000003' && n.cr_number === '4030000001' && n.address_short === 'RRRD2929'
      && n.address === '1 Street, Jeddah' && n.email === 'billing@blue.example' && n.phone === '0500000001' && n.name_en === null) || J(r);
  });
  await check('getClient: unknown id → not_found (404); a non-numeric id → not_found bad_id with no request', async () => {
    const e1 = await keepErr(L.getClient('999999'));
    const n = mark();
    const e2 = await keepErr(L.getClient('c-1'));
    return (e1 && e1.kind === 'not_found' && e1.http_status === 404 && e2 && e2.kind === 'not_found' && e2.code === 'bad_id' && since(n).length === 0) || J({ e1, e2 });
  });
  await check('findClientsByVat: keywords do not cover bn1 here → bounded scan finds both exact bn1 matches (sorted by id)', async () => {
    const r = keep(await L.findClientsByVat(' 300000000000003 '));
    return (r.length === 2 && r.map(x => x.id).join(',') === ['90', c1.id].sort((a, b) => a - b).join(',')
      && SRV.requests.some(x => x.path === 'clients.json' && !x.query.keywords && Number(x.query.limit) === 500)) || J(r);
  });
  await check('findClientsByVat: no VAT → [] without a request; an unknown VAT → []', async () => {
    const n = mark();
    const a = await L.findClientsByVat(null);
    const b = await L.findClientsByVat('');
    const m = since(n).length;
    const c = await L.findClientsByVat('399999999999993');
    return (a.length === 0 && b.length === 0 && m === 0 && c.length === 0) || J({ a, b, m, c });
  });
  await check('updateClient: PUT clients/{id}.json with only the sent fields (partial); null clears, the name is never emptied', async () => {
    const n = mark();
    keep(await L.updateClient(c1.id, { phone: '0511111111', email: null, name: null }));
    const put = since(n).find(r => r.method === 'PUT');
    const back = await L.getClient(c1.id);
    return (put && put.path === 'clients/' + c1.id + '.json' && J(Object.keys(put.body.Client).sort()) === J(['email', 'phone1'])
      && put.body.Client.email === '' && back.phone === '0511111111' && back.email === null && back.name === 'شركة البحر الأزرق') || J({ put, back });
  });
  await check('createClient: 400 → validation with field NAMES only (the echoed value never surfaces); nothing created', async () => {
    const e = await keepErr(L.createClient({ ref: 'MRSC-0b5e0000-0000-4000-8000-000000000555', name: 'x', _force: 1 }).then(() => null));
    SRV.faults.push({ method: 'POST', path: /^clients\.json$/, status: 400, body: { result: 'failed', code: 400, message: 'Bad Request',
      validation_errors: { business_name: 'value "' + KEY + '" rejected', 'Client.email': 'bad <script>' } } });
    const e2 = await keepErr(L.createClient({ ref: 'MRSC-0b5e0000-0000-4000-8000-000000000556', name: 'y' }));
    return (e === null && e2 && e2.kind === 'validation' && e2.http_status === 400 && e2.applied === 'no'
      && e2.message === 'Daftra rejected the request (HTTP 400): fields Client.email, business_name' && !e2.message.includes(KEY)) || J(e2);
  });
  await check('createClient: 402 → validation plan_limit', async () => {
    SRV.faults.push({ method: 'POST', path: /^clients\.json$/, status: 402, body: { message: 'You have reached your clients limit.' } });
    const e1 = await keepErr(L.createClient({ ref: 'MRSC-0b5e0000-0000-4000-8000-000000000557', name: 'z' }));
    return (e1 && e1.kind === 'validation' && e1.code === 'plan_limit' && e1.http_status === 402) || J({ e1 });
  });
  await check('M1 regression: a renumbered client (client_number not kept) is RETURNED with its id (ref_kept false), never thrown away', async () => {
    SRV.config.renumberClients = true;
    try {
      const r = keep(await L.createClient({ ref: 'MRSC-0b5e0000-0000-4000-8000-000000000558', name: 'w' }));
      const inDaftra = SRV.state.clients.filter(c => c.business_name === 'w');
      return (r.id && r.ref_kept === false && r.ref !== 'MRSC-0b5e0000-0000-4000-8000-000000000558' && inDaftra.length === 1 && inDaftra[0].id === r.id) || J(r);
    } finally { SRV.config.renumberClients = false; }
  });
  await check('createClient: no name / malformed ref → validation before any request', async () => {
    const n = mark();
    const e1 = await keepErr(L.createClient({ ref: 'MRSC-0b5e0000-0000-4000-8000-000000000559' }));
    const e2 = await keepErr(L.createClient({ ref: 'bad ref with spaces', name: 'x' }));
    return (e1 && e1.kind === 'validation' && e2 && e2.kind === 'validation' && since(n).length === 0) || J({ e1, e2 });
  });
}

/* ================================================================== 5. products */
async function secProducts() {
  section('5. products: exact code, normalized name, create with tax ids');
  const L = live();
  const n = mark();
  const p1 = keep(await L.createProduct({ code: 'MRS-service-customs_clearance', name_ar: 'أتعاب التخليص', name_en: 'Clearance fees', tax_code: 'standard', vat_rate: 15 }));
  const p2 = keep(await L.createProduct({ code: 'MRS-reimbursable-port_charges', name_ar: 'رسوم الميناء', tax_code: 'out_of_scope', vat_rate: 0 }));
  const posts = since(n).filter(r => r.method === 'POST');
  await check('createProduct: POST products.json {Product} type 2, product_code, tax1 = tax id 1 for 15 %, 0 for 0 %; 202 → id', () => {
    const [a, b] = posts.map(r => r.body.Product);
    return (posts.length === 2 && a.product_code === 'MRS-service-customs_clearance' && a.type === 2 && a.tax1 === 1 && a.tax2 === 0 && a.description === 'Clearance fees'
      && b.tax1 === 0 && p1.id && p2.id && p1.vat_rate === '15.00' && p2.vat_rate === '0.00' && posts.every(r => r.status === 202)) || J({ posts, p1, p2 });
  });
  SRV.state.products.push({ id: '299', name: 'decoy', product_code: 'MRS-service-customs_clearance_x' });
  await check('findProductByCode: product_code filter + exact match (prefix decoy ignored); unknown → null', async () => {
    const r = keep(await L.findProductByCode('MRS-service-customs_clearance'));
    const none = await L.findProductByCode('MRS-service-none');
    return (r && r.id === p1.id && r.code === 'MRS-service-customs_clearance' && r.name_ar === 'أتعاب التخليص' && none === null
      && SRV.requests.some(x => x.query.product_code === 'MRS-service-customs_clearance')) || J({ r, none });
  });
  await check('findProductsByName: keywords + normalized Arabic match (hamza, taa marbuta, spaces) ', async () => {
    const a = keep(await L.findProductsByName('  اتعاب   التخليص '));
    const b = await L.findProductsByName('أتعاب  التخليص');
    const c = await L.findProductsByName('غير موجود');
    return (a.length === 1 && a[0].id === p1.id && b.length === 1 && c.length === 0) || J({ a, b, c });
  });
}

/* ================================================================== 6. invoices */
const S6 = {};
async function secInvoices() {
  section('6. invoices: draft create, read view, reference lookup, draft update, payments');
  const L = live();
  const cl = SRV.state.clients.find(c => c.business_name === 'شركة البحر الأزرق');
  const prod = SRV.state.products.find(p => p.product_code === 'MRS-service-customs_clearance');
  const prod0 = SRV.state.products.find(p => p.product_code === 'MRS-reimbursable-port_charges');
  const ref = 'BLU-2026-00012/F';
  const lines = [{ line_ref: lref('1'), product_id: prod.id, description: 'أتعاب التخليص', quantity: 1, unit_price: 2500, tax_rate: 15 },
    { line_ref: lref('2'), product_id: prod0.id, description: 'رسوم الميناء (مبلغ مسترد)', quantity: '1.000', unit_price: '600.00', tax_rate: '0.00' }];
  const n = mark();
  const created = keep(await L.createDraftInvoice({ reference: ref, client_id: cl.id, currency: 'SAR', date: '2026-11-03', notes: 'شكراً', lines }));
  const post = since(n).find(r => r.method === 'POST');
  S6.id = created.id; S6.ref = ref; S6.cl = cl; S6.prod = prod; S6.lines = lines;
  await check('createDraftInvoice: draft 1, is_offline 1, po_number = ref, notes + [MARSA-REF:], currency, date; items: item = text + [MRSL-…] marker, tax1 ids', () => {
    const b = post.body;
    return (b.Invoice.draft === 1 && b.Invoice.is_offline === 1 && b.Invoice.po_number === ref && b.Invoice.notes === 'شكراً\n[MARSA-REF:' + ref + ']'
      && b.Invoice.currency_code === 'SAR' && b.Invoice.date === '2026-11-03' && b.Invoice.client_id === Number(cl.id) && b.InvoiceItem.length === 2
      && !('description' in b.InvoiceItem[0]) && b.InvoiceItem[0].item === 'أتعاب التخليص [' + lref('1') + ']' && b.InvoiceItem[0].tax1 === 1
      && b.InvoiceItem[1].tax1 === 0 && b.InvoiceItem[0].product_id === Number(prod.id) && post.status === 202 && created.id && created.status === 'draft') || J(b);
  });
  const v = keep(await L.getInvoice(created.id));
  S6.version = v.version;
  await check('getInvoice: the worker view (draft, number null, version = modified, reference, lines with line_ref / tax_rate, totals)', () =>
    (v.id === created.id && v.status === 'draft' && v.number === null && /^2026-11-03 \d\d:\d\d:\d\d$/.test(v.version) && v.reference === ref
      && v.client_id === cl.id && v.currency === 'SAR' && v.notes === 'شكراً' && v.lines.length === 2 && v.lines[0].line_ref === lref('1')
      && v.lines[0].description === 'أتعاب التخليص' && v.lines[0].tax_rate === '15.00' && v.lines[1].tax_rate === '0.00' && v.lines[0].quantity === '1.000'
      && v.totals.net === '3100.00' && v.totals.vat === '375.00' && v.totals.total === '3475.00') || J(v));
  await check('the content hash of the read-back equals the hash of what was pushed (stable canonical round trip)', async () => {
    const pushed = await AD.contentHash(AD.canonicalInvoice({ client_id: cl.id, currency: 'SAR', lines: lines.map(l => Object.assign({}, l, { product_id: String(l.product_id) })) }));
    return pushed === await AD.invoiceHash(v) || 'hash differs';
  });
  await check('findInvoiceByReference: po_number filter → exactly the invoice (decoy ref/F2 and other refs ignored)', async () => {
    await L.createDraftInvoice({ reference: ref + '2', client_id: cl.id, currency: 'SAR', lines: [] });
    const h = keep(await L.findInvoiceByReference(ref));
    const none = await L.findInvoiceByReference('BLU-2026-00099/F');
    return (h.length === 1 && h[0].id === created.id && h[0].reference === ref && none.length === 0
      && SRV.requests.some(r => r.query.po_number === ref)) || J({ h, none });
  });
  await check('PO numbers disabled on the account: the reference is found through the notes marker (recent-invoice scan)', async () => {
    SRV.config.poNumbers = false;
    try {
      const c2 = await L.createDraftInvoice({ reference: 'BLU-2026-00013/F', client_id: cl.id, currency: 'SAR', lines: [lines[0]] });
      const h = keep(await L.findInvoiceByReference('BLU-2026-00013/F'));
      const raw = SRV.state.invoices.find(x => x.Invoice.id === c2.id).Invoice;
      return (h.length === 1 && h[0].id === c2.id && h[0].reference === 'BLU-2026-00013/F' && !('po_number' in raw)) || J({ h, raw });
    } finally { SRV.config.poNumbers = true; }
  });
  await check('two invoices with the same reference → both returned (the worker turns > 1 into a conflict, never picks one)', async () => {
    await L.createDraftInvoice({ reference: 'DUP-1/F', client_id: cl.id, currency: 'SAR', lines: [] });
    await L.createDraftInvoice({ reference: 'DUP-1/F', client_id: cl.id, currency: 'SAR', lines: [] });
    const h = await L.findInvoiceByReference('DUP-1/F');
    return h.length === 2 || J(h);
  });
  await check('updateDraftInvoice: re-read, PUT with draft 1 + the full item list; a foreign accountant line is re-sent verbatim (col_3 kept)', async () => {
    SRV.control.addItem(created.id, { item: 'بند يدوي', description: 'accountant', unit_price: '50', quantity: '2', col_3: 'kept-col' });
    const cur = await L.getInvoice(created.id);
    const foreign = cur.lines.find(l => !l.line_ref);
    const owned = cur.lines.filter(l => l.line_ref);
    const desired = [Object.assign({}, owned[0], { unit_price: '2600.00' }), owned[1], foreign,
      { line_ref: lref('3'), product_id: prod.id, description: 'بند جديد', quantity: 1, unit_price: 100, tax_rate: 15 }];
    const n2 = mark();
    keep(await L.updateDraftInvoice(created.id, { lines: desired, expected_version: cur.version }));
    const rq = since(n2);
    const put = rq.find(r => r.method === 'PUT');
    const back = await L.getInvoice(created.id);
    const it = put.body.InvoiceItem;
    S6.version = back.version;
    return (rq[0].method === 'GET' && put && put.body.Invoice.draft === 1 && put.body.Invoice.is_offline === 1 && put.body.Invoice.po_number === ref
      && it.length === 4 && it[2].col_3 === 'kept-col' && it[2].item === 'بند يدوي' && it[2].description === 'accountant' && !('id' in it[2])
      && it[0].unit_price === 2600 && it[0].item === 'أتعاب التخليص [' + lref('1') + ']' && it[3].item === 'بند جديد [' + lref('3') + ']'
      && back.lines.length === 4 && back.lines.filter(l => !l.line_ref).length === 1 && back.lines.find(l => l.line_ref === lref('1')).unit_price === '2600.00') || J({ rq: rq.map(r => r.method), put: put && put.body });
  });
  await check('updateDraftInvoice: a stale expected_version → conflict version, no PUT', async () => {
    const n2 = mark();
    const e = await keepErr(L.updateDraftInvoice(created.id, { lines: [], expected_version: '2000-01-01 00:00:00' }));
    return (e && e.kind === 'conflict' && e.code === 'version' && e.applied === 'no' && !since(n2).some(r => r.method !== 'GET')) || J(e);
  });
  await check('updateDraftInvoice: a line id that is no longer on the remote → conflict version, no PUT', async () => {
    const n2 = mark();
    const e = await keepErr(L.updateDraftInvoice(created.id, { lines: [{ id: '1', line_ref: null, description: 'x', quantity: 1, unit_price: 1, tax_rate: 0 }] }));
    return (e && e.kind === 'conflict' && !since(n2).some(r => r.method !== 'GET')) || J(e);
  });
  await check('listPayments: InvoicePayment[] from GET invoices/{id}.json — completed (1) and overpaid (4) only, date part', async () => {
    SRV.control.addPayment(created.id, 1000, 1);
    SRV.control.addPayment(created.id, 77, 2);       // pending: not money received
    SRV.control.addPayment(created.id, 5, 4);
    const p = keep(await L.listPayments(created.id));
    return (J(p) === J([{ amount: '1000.00', date: '2026-11-04' }, { amount: '5.00', date: '2026-11-04' }])) || J(p);
  });
  await check('updateDraftInvoice: a draft that carries payments → conflict has_payments, no PUT', async () => {
    const n2 = mark();
    const e = await keepErr(L.updateDraftInvoice(created.id, { lines: [] }));
    return (e && e.kind === 'conflict' && e.code === 'has_payments' && !since(n2).some(r => r.method !== 'GET')) || J(e);
  });
  await check('an issued invoice reads as issued with its number; updateDraftInvoice refuses (conflict not_draft), no PUT', async () => {
    const c3 = await L.createDraftInvoice({ reference: 'ISS-1/F', client_id: cl.id, currency: 'SAR', lines: [lines[0]] });
    SRV.control.issue(c3.id);
    const vi = await L.getInvoice(c3.id);
    const n2 = mark();
    const e = await keepErr(L.updateDraftInvoice(c3.id, { lines: [] }));
    return (vi.status === 'issued' && /^\d{6}$/.test(vi.number) && AD.remoteState(vi.status) === 'issued' && e && e.code === 'not_draft'
      && !since(n2).some(r => r.method !== 'GET')) || J({ vi, e });
  });
  await check('createDraftInvoice: malformed input refused before any request (ref, client id, currency, date, line_ref, figures)', async () => {
    const n2 = mark();
    const base = { reference: 'X-1/F', client_id: cl.id, currency: 'SAR', lines: [] };
    const bad = [Object.assign({}, base, { reference: 'a b' }), Object.assign({}, base, { client_id: 'c-1' }), Object.assign({}, base, { currency: 'sar' }),
      Object.assign({}, base, { date: '03/11/2026' }), Object.assign({}, base, { lines: [Object.assign({}, lines[0], { line_ref: 'L1' })] }),
      Object.assign({}, base, { lines: [Object.assign({}, lines[0], { quantity: 0 })] }), Object.assign({}, base, { lines: 'x' })];
    const r = [];
    for (const b of bad) { const e = await keepErr(L.createDraftInvoice(b)); r.push(e && e.kind); }
    return (r.every(k => k === 'validation') && !since(n2).some(x => x.method !== 'GET')) || J(r);
  });
}

/* ================================================================== 7. tax mapping */
async function secTaxes() {
  section('7. tax mapping: rate → one active exclusive tax, MARSA_DAFTRA_TAX_MAP override, refusals before writes');
  const cl = S6.cl;
  const line = r => ({ line_ref: lref('9'), product_id: S6.prod.id, description: 'x', quantity: 1, unit_price: 10, tax_rate: r });
  await check('a rate with no active exclusive tax (5 % inactive) → validation tax_unmapped, nothing written', async () => {
    const n = mark();
    const e = await keepErr(live().createDraftInvoice({ reference: 'TX-1/F', client_id: cl.id, currency: 'SAR', lines: [line(5)] }));
    return (e && e.code === 'tax_unmapped' && !since(n).some(r => r.method !== 'GET')) || J(e);
  });
  await check('two active exclusive taxes of 15 % → tax_ambiguous; MARSA_DAFTRA_TAX_MAP {"15": 7} resolves it', async () => {
    SRV.state.taxes.push({ id: 7, name: 'VAT KSA', value: 15, included: 0, is_active: 1 });
    try {
      const e = await keepErr(live().createProduct({ code: 'MRS-service-tx_a', name_ar: 'أ', vat_rate: 15 }));
      const n = mark();
      const p = await live({ taxMap: { 15: 7 } }).createProduct({ code: 'MRS-service-tx_b', name_ar: 'ب', vat_rate: 15 });
      const post = since(n).find(r => r.method === 'POST');
      return (e && e.code === 'tax_ambiguous' && p.id && post.body.Product.tax1 === 7) || J({ e, post });
    } finally { SRV.state.taxes.pop(); }
  });
  await check('a map entry pointing at an inclusive / unknown tax → tax_map_invalid; {"0": 0} keeps "no tax"; {"5": 1} wrong value → invalid', async () => {
    const e1 = await keepErr(live({ taxMap: { 15: 2 } }).createProduct({ code: 'MRS-service-tx_c', name_ar: 'ج', vat_rate: 15 }));
    const e2 = await keepErr(live({ taxMap: { 15: 999 } }).createProduct({ code: 'MRS-service-tx_d', name_ar: 'د', vat_rate: 15 }));
    const e3 = await keepErr(live({ taxMap: { 5: 1 } }).createProduct({ code: 'MRS-service-tx_e', name_ar: 'ه', vat_rate: 5 }));
    const n = mark();
    await live({ taxMap: { 0: 0 } }).createProduct({ code: 'MRS-service-tx_f', name_ar: 'و', vat_rate: 0 });
    const post = since(n).find(r => r.method === 'POST');
    return (e1 && e1.code === 'tax_map_invalid' && e2 && e2.code === 'tax_map_invalid' && e3 && e3.code === 'tax_map_invalid' && post.body.Product.tax1 === 0) || J({ e1, e2, e3 });
  });
  await check('a line whose tax id is unknown to Marsa reads tax_rate null (a difference, never a guess)', async () => {
    const x = SRV.state.invoices.find(i => String(i.Invoice.id) === String(S6.id));
    const was = x.items[0].tax1;
    x.items[0].tax1 = 55;
    try { const v = await live().getInvoice(S6.id); return v.lines[0].tax_rate === null || J(v.lines[0]); }
    finally { x.items[0].tax1 = was; }
  });
}

/* ================================================================== 8. error mapping */
async function secErrors() {
  section('8. error mapping: HTTP statuses, network, timeout, lost responses');
  const L = live();
  const cl = S6.cl;
  const table = [[400, 'validation', 'validation'], [422, 'validation', 'validation'], [401, 'not_configured', 'auth_failed'], [402, 'validation', 'plan_limit'],
    [403, 'not_configured', 'forbidden'], [404, 'not_found', 'not_found'], [409, 'conflict', 'conflict'], [429, 'rate_limited', 'rate_limited'],
    [500, 'http_5xx', 'http_5xx'], [502, 'http_5xx', 'http_5xx'], [503, 'http_5xx', 'http_5xx'], [302, 'not_configured', 'redirect'], [418, 'network', 'http_418']];
  await check('reads: every status → its kind / code, applied no, fixed message with the status only', async () => {
    const bad = [];
    for (const [st, kind, code] of table) {
      SRV.faults.push({ method: 'GET', path: /^clients\/\d+\.json$/, status: st, body: { result: 'failed', code: st, message: 'echo ' + KEY } });
      const e = await keepErr(L.getClient(cl.id));
      if (!e || e.kind !== kind || e.code !== code || e.applied !== 'no' || e.http_status !== st || !e.message.includes(String(st)) || e.message.includes(KEY)) bad.push(st + ':' + J(e && e.toJSON()));
    }
    return bad.length === 0 || bad.join(' | ');
  });
  await check('writes: 4xx → applied no; 5xx and unknown statuses → applied unknown (may have landed)', async () => {
    const bad = [];
    for (const [st, kind] of table) {
      SRV.faults.push({ method: 'PUT', path: /^clients\/\d+\.json$/, status: st });
      const e = await keepErr(L.updateClient(cl.id, { phone: '0500000009' }));
      const want = (st >= 500 || st === 418) ? 'unknown' : 'no';
      if (!e || e.kind !== kind || e.applied !== want) bad.push(st + ':' + (e && e.kind + '/' + e.applied));
    }
    return bad.length === 0 || bad.join(' | ');
  });
  await check('a 200 with result "failed" in the body is an error, not a success', async () => {
    SRV.faults.push({ method: 'GET', path: /^clients\/\d+\.json$/, status: 200, body: { result: 'failed', code: 404, message: 'Item not found' } });
    const e = await keepErr(L.getClient(cl.id));
    return (e && e.kind === 'not_found') || J(e);
  });
  await check('timeout on a read → timeout applied no; on a write (createClient) → timeout applied unknown', async () => {
    SRV.faults.push({ method: 'GET', path: /^clients\/\d+\.json$/, delayMs: 2600 });
    const e1 = await keepErr(L.getClient(cl.id));
    SRV.faults.push({ method: 'POST', path: /^clients\.json$/, delayMs: 2600 });
    const e2 = await keepErr(L.createClient({ ref: 'MRSC-0b5e0000-0000-4000-8000-000000000601', name: 'slow' }));
    return (e1 && e1.kind === 'timeout' && e1.applied === 'no' && e2 && e2.kind === 'timeout' && e2.applied === 'unknown') || J({ e1, e2 });
  });
  await check('a dropped connection: read → network no; write → network unknown (applied or not, Marsa cannot tell)', async () => {
    SRV.faults.push({ method: 'GET', path: /^clients\/\d+\.json$/, drop: 'before' });
    const e1 = await keepErr(L.getClient(cl.id));
    SRV.faults.push({ method: 'POST', path: /^products\.json$/, drop: 'before' });
    const e2 = await keepErr(L.createProduct({ code: 'MRS-service-drop_a', name_ar: 'سقوط', vat_rate: 0 }));
    return (e1 && e1.kind === 'network' && e1.applied === 'no' && e2 && e2.kind === 'network' && e2.applied === 'unknown') || J({ e1, e2 });
  });
  await check('a connection that never opens (closed port): even a write → network applied no (nothing was sent)', async () => {
    const net = require('net');
    const tmp = net.createServer();
    await new Promise(r => tmp.listen(0, '127.0.0.1', r));
    const port = tmp.address().port;
    await new Promise(r => tmp.close(r));
    const dead = live({ baseUrl: 'http://127.0.0.1:' + port + '/api2' });
    const e = await keepErr(dead.createProduct({ code: 'MRS-service-dead', name_ar: 'لا', vat_rate: 0 }));
    return (e && e.kind === 'network' && e.applied === 'no') || J(e);
  });
  await check('a 2xx with an unreadable body: read → network no; write → network unknown', async () => {
    SRV.faults.push({ method: 'GET', path: /^clients\/\d+\.json$/, rawText: '<html>maintenance</html>' });
    const e1 = await keepErr(L.getClient(cl.id));
    SRV.faults.push({ method: 'POST', path: /^products\.json$/, rawText: 'not json' });
    const e2 = await keepErr(L.createProduct({ code: 'MRS-service-raw_a', name_ar: 'خام', vat_rate: 0 }));
    return (e1 && e1.code === 'bad_response' && e1.applied === 'no' && e2 && e2.code === 'bad_response' && e2.applied === 'unknown') || J({ e1, e2 });
  });
  await check('a 202 without an id → network no_id applied unknown', async () => {
    SRV.faults.push({ method: 'POST', path: /^products\.json$/, status: 202, apply: true, body: { result: 'successful', code: 202 } });
    const e = await keepErr(L.createProduct({ code: 'MRS-service-noid_a', name_ar: 'بلا', vat_rate: 0 }));
    return (e && e.code === 'no_id' && e.applied === 'unknown') || J(e);
  });
  await check('the method deadline: a write is never started without its full timeout ahead (applied no, nothing sent)', async () => {
    let t = 0;
    const slowClock = () => (t += 10000);
    const n = mark();
    const e = await keepErr(live({ now: slowClock, deadlineMs: 15000, timeouts: { read: 2000, write: 8000 } }).createProduct({ code: 'MRS-service-late_a', name_ar: 'متأخر', vat_rate: 0 }));
    return (e && e.kind === 'timeout' && e.code === 'deadline' && e.applied === 'no' && !since(n).some(r => r.method !== 'GET')) || J(e);
  });
  await check('lost response on createDraftInvoice (applied, then dropped) → unknown; a re-push finds it by reference: one invoice, never two', async () => {
    const ref = 'LOST-1/F';
    SRV.faults.push({ method: 'POST', path: /^invoices\.json$/, drop: 'after' });
    const e = await keepErr(L.createDraftInvoice({ reference: ref, client_id: cl.id, currency: 'SAR', lines: [S6.lines[0]] }));
    const h = await L.findInvoiceByReference(ref);
    return (e && e.applied === 'unknown' && h.length === 1 && SRV.state.invoices.filter(x => x.Invoice.po_number === ref).length === 1) || J({ e, h });
  });
  await check('worker.runJob: a lost createClient → outcome unknown (never failed / retry), the call recorded applied unknown', async () => {
    SRV.faults.push({ method: 'POST', path: /^clients\.json$/, drop: 'after' });
    const ctx = { job: { id: 'j', org_id: 'o', kind: 'client_ensure', attempt_no: 1, options: {}, previous_status: 'queued' },
      client: { link_id: 'L', client_id: 'C', client_ref: 'MRSC-0b5e0000-0000-4000-8000-000000000777', external_id: null, status: 'pending', data: { name: 'ضائع', vat_number: null } } };
    const r = keep(await runJob(ctx, L, { deps: AD, clock }));
    const ctx2 = JSON.parse(J(ctx)); ctx2.job.previous_status = 'unknown';
    const r2 = keep(await runJob(ctx2, L, { deps: AD, clock }));
    return (r.outcome === 'unknown' && r.calls.some(c => c.op === 'createClient' && c.applied === 'unknown') && r2.outcome === 'ok' && r2.effects.found_by === 'ref'
      && SRV.state.clients.filter(c => c.client_number === ctx.client.client_ref).length === 1) || J({ r, r2 });
  });
}

/* ================================================================== 8b. review regressions (H1–H3, M1–M5, L2) */
// a dedicated fake account per scenario (options the main one does not use)
async function freshAccount(opts) {
  const srv = FDS.createFakeDaftraServer(Object.assign({ apiKey: KEY }, opts || {}));
  const base = (await srv.start()).baseUrl;
  const L = o => live(Object.assign({ baseUrl: base }, o || {}));
  const a = L();
  const cl = await a.createClient({ ref: 'MRSC-0b5e0000-0000-4000-8000-00000000c001', name: 'عميل المراجعة' });
  const p15 = await a.createProduct({ code: 'MRS-service-rev_15', name_ar: 'خدمة 15', vat_rate: 15 });
  const p0 = await a.createProduct({ code: 'MRS-reimbursable-rev_0', name_ar: 'مسترد', vat_rate: 0 });
  return { srv, base, L, cl, p15, p0, posts: () => srv.requests.filter(r => r.method === 'POST'), stop: () => srv.stop() };
}
// a worker invoice_push context (the shape worker.js reads)
function pushCtx(o) {
  return {
    job: { id: 'j', org_id: 'o', kind: 'invoice_push', attempt_no: 1, options: {}, previous_status: o.prev || 'queued' },
    intent: { id: 'iR', operational_ref: o.ref, currency: 'SAR', status: 'open', sync_state: 'pending', external_invoice_id: o.ext || null,
      pushed_hash: o.pushedHash || null, invoice_date: '2026-11-03',
      client: { link_id: 'LC', client_ref: o.clientRef || 'MRSC-0b5e0000-0000-4000-8000-00000000c001', external_id: o.clientExt || null,
        status: o.clientStatus || 'pending', data: { name: o.clientName || 'عميل المراجعة' } },
      items: [{ link_id: 'LI', item_key: 'service:rev_15', product_code: 'MRS-service-rev_15', external_product_id: o.productId, status: 'linked', name_ar: 'خدمة 15' }],
      lines: (o.lines || [lref('C1')]).map((r, i) => ({ line_id: 'LL' + i, line_ref: r, state: o.lineState || 'pending_add', pushed: !!o.pushed,
        item_key: 'service:rev_15', description: 'بند ' + i, quantity: '1.000', unit_price: '100.00', vat_rate: '15.00' })) }
  };
}

async function secReview() {
  section('8b. review regressions: tax inheritance, reference lookup, line marker, renumbered clients, VAT scan, inclusive tax, run deadline');

  /* H1 — re-sent lines always carry tax1 / tax2 (an item without them inherits the product's taxes) */
  {
    const F = await freshAccount({ inheritProductTax: true });
    try {
      await check('H1 setup: the fake models inheritance (an item PUT without tax1 takes the product\'s 15 % tax)', async () => {
        const a = F.L();
        const d = await a.createDraftInvoice({ reference: 'H1-0/F', client_id: F.cl.id, currency: 'SAR', lines: [] });
        const res = await nodeHttp({ method: 'PUT', url: F.base + '/invoices/' + d.id + '.json', headers: { APIKEY: KEY, 'Content-Type': 'application/json' },
          body: J({ Invoice: { draft: 1 }, InvoiceItem: [{ item: 'x', unit_price: 10, quantity: 1, product_id: Number(F.p15.id) }] }), timeoutMs: 2000 });
        const x = F.srv.state.invoices.find(v => v.Invoice.id === d.id);
        return (res.status === 200 && String(x.items[0].tax1) === '1') || J(x.items);
      });
      await check('H1: a foreign line with tax1 null and a Marsa 0 % line stored as null are re-sent with tax1 = 0, tax2 = 0 (VAT unchanged)', async () => {
        const a = F.L();
        const d = await a.createDraftInvoice({ reference: 'H1-1/F', client_id: F.cl.id, currency: 'SAR', lines: [
          { line_ref: lref('D1'), product_id: F.p15.id, description: 'خدمة', quantity: 1, unit_price: 100, tax_rate: 15 },
          { line_ref: lref('D2'), product_id: F.p15.id, description: 'zero', quantity: 1, unit_price: 100, tax_rate: 0 }] });
        const x = F.srv.state.invoices.find(v => v.Invoice.id === d.id);
        x.items[1].tax1 = null; x.items[1].tax2 = null;                      // Daftra may store "no tax" as null
        F.srv.control.addItem(d.id, { item: 'manual', product_id: F.p15.id, unit_price: '100', quantity: '1', tax1: null, tax2: null });
        const cur = await a.getInvoice(d.id);
        const desired = cur.lines.map(l => l.line_ref === lref('D1') ? Object.assign({}, l, { unit_price: '120.00' }) : l);
        const n = F.srv.requests.length;
        await a.updateDraftInvoice(d.id, { lines: desired, expected_version: cur.version });
        const put = F.srv.requests.slice(n).find(r => r.method === 'PUT');
        const back = await a.getInvoice(d.id);
        const its = put.body.InvoiceItem;
        return (its.length === 3 && its.every(i => 'tax1' in i && 'tax2' in i) && its[1].tax1 === 0 && its[1].tax2 === 0 && its[2].tax1 === 0
          && back.lines.map(l => l.tax_rate).join(',') === '15.00,0.00,0.00' && back.totals.vat === '18.00') || J({ its, back: back.lines, t: back.totals });
      });
    } finally { await F.stop(); }
  }

  /* H2 — the reference scan walks API invoices newest id first, and never answers "none" it cannot prove */
  {
    const F = await freshAccount({ poNumbers: false });
    try {
      const a = F.L();
      for (let i = 0; i < 250; i++) F.srv.control.addInvoice({ api: true, client_id: F.cl.id, date: '2026-11-0' + (1 + (i % 9)), notes: '[MARSA-REF:OTHER-' + i + '/F]' });
      F.srv.faults.push({ method: 'POST', path: /^invoices\.json$/, drop: 'after' });
      const e = await keepErr(a.createDraftInvoice({ reference: 'H2-1/F', client_id: F.cl.id, currency: 'SAR', date: '2026-10-01', lines: [] }));
      await check('H2: a back-dated lost create behind 250 later-dated drafts (PO numbers off) is found by the id-DESC API scan', async () => {
        const h = await a.findInvoiceByReference('H2-1/F');
        const scan = F.srv.requests.filter(r => r.path === 'invoices.json' && r.query.external_source === 'api');
        return (e && e.applied === 'unknown' && h.length === 1 && scan.length >= 1 && scan.every(r => r.query.sort === 'id' && r.query.direction === 'DESC')) || J({ e, h });
      });
      for (let i = 0; i < 250; i++) F.srv.control.addInvoice({ api: true, client_id: F.cl.id, date: '2026-11-03', notes: '[MARSA-REF:LATER-' + i + '/F]' });
      await check('H2: the same invoice pushed beyond the bounded scan (PO numbers off) → validation reference_lookup_incomplete, never []', async () => {
        const e2 = await keepErr(a.findInvoiceByReference('H2-1/F'));
        return (e2 && e2.kind === 'validation' && e2.code === 'reference_lookup_incomplete' && e2.applied === 'no') || J(e2);
      });
      await check('H2: worker reconcile of a lost create (previous_status unknown) on that account → failed reference_lookup_incomplete, NO second draft', async () => {
        const before = F.srv.state.invoices.length;
        const n = F.srv.requests.length;
        const r = await runJob(pushCtx({ ref: 'H2-1/F', prev: 'unknown', clientExt: F.cl.id, clientStatus: 'linked', productId: F.p15.id }), F.L(), { deps: AD, clock });
        return (r.outcome === 'failed' && r.error.code === 'reference_lookup_incomplete' && !F.srv.requests.slice(n).some(x => x.method !== 'GET')
          && F.srv.state.invoices.length === before) || J({ o: r.outcome, e: r.error });
      });
      await check('H2 probe: PO numbers not kept + more API invoices than the scan → invoices.search_by_reference unsupported (push blocked)', async () => {
        const p = await a.probe();
        const c = p.capabilities['invoices.search_by_reference'];
        return (c.supported === false && /cannot prove/.test(c.evidence) && p.account.counts.api_invoices === 501) || J(c);
      });
    } finally { await F.stop(); }
  }
  {
    const F = await freshAccount({ poNumbers: true });
    try {
      const a = F.L();
      for (let i = 0; i < 250; i++) F.srv.control.addInvoice({ api: true, client_id: F.cl.id, po_number: 'P-' + i + '/F', notes: '[MARSA-REF:P-' + i + '/F]' });
      await check('H2: PO numbers kept (proven on Marsa\'s invoices) + a large account → an unknown ref is [] (the po_number filter is authoritative)', async () => {
        const h = await a.findInvoiceByReference('NEW-1/F');
        const hit = await a.findInvoiceByReference('P-3/F');
        const p = await a.probe();
        return (h.length === 0 && hit.length === 1 && p.capabilities['invoices.search_by_reference'].supported === true) || J({ h, hit });
      });
      await check('H2: a fresh account (few API invoices) → [] for an unknown ref even without PO evidence (complete scan)', async () => {
        const G = await freshAccount({ poNumbers: false });
        try { const h = await G.L().findInvoiceByReference('NEW-2/F'); const p = await G.L().probe(); return (h.length === 0 && p.capabilities['invoices.search_by_reference'].supported === true) || J(h); }
        finally { await G.stop(); }
      });
    } finally { await F.stop(); }
  }

  /* H3 — the line marker rides in InvoiceItem.item; an account that does not echo `description` keeps line identity */
  {
    const F = await freshAccount({ echoItemDescription: false });
    try {
      await check('H3: description not returned → line_refs still read back (marker in item); text stripped of the marker', async () => {
        const a = F.L();
        const d = await a.createDraftInvoice({ reference: 'H3-0/F', client_id: F.cl.id, currency: 'SAR', lines: [
          { line_ref: lref('E1'), product_id: F.p15.id, description: 'نص البند', quantity: 1, unit_price: 100, tax_rate: 15 }] });
        const v = await a.getInvoice(d.id);
        const raw = F.srv.state.invoices.find(x => x.Invoice.id === d.id).items[0];
        return (!('description' in raw) && v.lines[0].line_ref === lref('E1') && v.lines[0].description === 'نص البند') || J({ raw, v: v.lines });
      });
      await check('H3: worker push twice on that account → line_results synced on the first, the second sends no PUT; one item, 115.00', async () => {
        const ref = 'H3-1/F';
        const r1 = await runJob(pushCtx({ ref, clientExt: F.cl.id, clientStatus: 'linked', productId: F.p15.id, lines: [lref('E2')] }), F.L(), { deps: AD, clock });
        const ctx2 = pushCtx({ ref, clientExt: F.cl.id, clientStatus: 'linked', productId: F.p15.id, lines: [lref('E2')], lineState: 'synced', pushed: true,
          ext: r1.effects.external_invoice_id, pushedHash: r1.effects.pushed_hash });
        const n = F.srv.requests.length;
        const r2 = await runJob(ctx2, F.L(), { deps: AD, clock });
        const x = F.srv.state.invoices.find(v => v.Invoice.id === r1.effects.external_invoice_id);
        return (r1.outcome === 'ok' && r1.effects.line_results.length === 1 && r1.effects.line_results[0].state === 'synced' && r2.outcome === 'ok'
          && !F.srv.requests.slice(n).some(q2 => q2.method !== 'GET') && x.items.length === 1 && x.Invoice.summary_total === '115.00') || J({ r1: r1.effects.line_results, r2: r2.outcome, items: x.items.length });
      });
      await check('H3: a long line text keeps the whole marker (text cut first, item ≤ 500)', async () => {
        const a = F.L();
        const d = await a.createDraftInvoice({ reference: 'H3-2/F', client_id: F.cl.id, currency: 'SAR', lines: [
          { line_ref: lref('E3'), product_id: F.p15.id, description: 'ن'.repeat(600), quantity: 1, unit_price: 1, tax_rate: 15 }] });
        const raw = F.srv.state.invoices.find(x => x.Invoice.id === d.id).items[0];
        return (raw.item.length <= 500 && raw.item.endsWith('[' + lref('E3') + ']') && (await a.getInvoice(d.id)).lines[0].line_ref === lref('E3')) || raw.item.length;
      });
      await check('H3 probe: sample items without `item` → invoices.line_reference_field unsupported', async () => {
        F.srv.faults.push({ method: 'GET', path: /^invoices\.json$/, status: 200, body: { result: 'successful', code: 200,
          data: [{ Invoice: { id: '1', draft: 1 }, InvoiceItem: [{ id: '5', unit_price: '1', quantity: '1' }] }], pagination: { page: 1, page_count: 1, total_results: 1 } } });
        const p = await F.L().probe();
        const p2 = await F.L().probe();
        return (p.capabilities['invoices.line_reference_field'].supported === false && p2.capabilities['invoices.line_reference_field'].supported === true) || J(p.capabilities['invoices.line_reference_field']);
      });
    } finally { await F.stop(); }
  }

  /* M1 — a renumbered client is linked, not re-created */
  {
    const F = await freshAccount({ renumberClients: true });
    try {
      await check('M1: worker push on a renumbering account → client created ONCE and linked by id; the next push (linked) creates no client', async () => {
        const ref = 'M1-1/F';
        const cref = 'MRSC-0b5e0000-0000-4000-8000-00000000c0m1';
        const r1 = await runJob(pushCtx({ ref, clientRef: cref, clientName: 'مرقّم', productId: F.p15.id }), F.L(), { deps: AD, clock });
        const ce = r1.effects.clients && r1.effects.clients[0];
        const n = F.srv.requests.length;
        const r2 = await runJob(pushCtx({ ref, clientRef: cref, clientName: 'مرقّم', clientExt: ce && ce.external_id, clientStatus: 'linked', productId: F.p15.id,
          ext: r1.effects.external_invoice_id, pushedHash: r1.effects.pushed_hash, lineState: 'synced', pushed: true }), F.L(), { deps: AD, clock });
        return (r1.outcome === 'ok' && ce && /^\d+$/.test(ce.external_id) && r2.outcome === 'ok' && !F.srv.requests.slice(n).some(x => x.method === 'POST')
          && F.srv.state.clients.filter(c => c.business_name === 'مرقّم').length === 1) || J({ r1: r1.outcome, e: r1.error, ce, r2: r2.outcome });
      });
    } finally { await F.stop(); }
  }

  /* M2 — a bounded VAT scan that found nothing refuses */
  {
    const F = await freshAccount({});
    try {
      for (let i = 0; i < 15; i++) F.srv.state.clients.push({ id: String(1000 + i), client_number: 'X-' + i, business_name: 'c' + i, bn1: i === 14 ? '311111111111113' : null });
      await check('M2: VAT on a client beyond the scan bound → validation vat_scan_incomplete (never a silent "no duplicate")', async () => {
        const e = await keepErr(F.L({ limits: { scanPages: 1, scanLimit: 10 } }).findClientsByVat('311111111111113'));
        const ok2 = await F.L({ limits: { scanPages: 2, scanLimit: 10 } }).findClientsByVat('311111111111113');
        const none = await F.L({ limits: { scanPages: 2, scanLimit: 10 } }).findClientsByVat('399999999999993');
        return (e && e.kind === 'validation' && e.code === 'vat_scan_incomplete' && e.applied === 'no' && ok2.length === 1 && none.length === 0) || J({ e, ok2 });
      });
      await check('M2: worker ensureClient on that account → failed vat_scan_incomplete with no client created', async () => {
        const n = F.srv.requests.length;
        const ctx = { job: { id: 'j', org_id: 'o', kind: 'client_ensure', attempt_no: 1, options: {}, previous_status: 'queued' },
          client: { link_id: 'L', client_id: 'C', client_ref: 'MRSC-0b5e0000-0000-4000-8000-00000000c0m2', external_id: null, status: 'pending', data: { name: 'مكرر', vat_number: '311111111111113' } } };
        const r = await runJob(ctx, F.L({ limits: { scanPages: 1, scanLimit: 10 } }), { deps: AD, clock });
        return (r.outcome === 'failed' && r.error.code === 'vat_scan_incomplete' && !F.srv.requests.slice(n).some(x => x.method === 'POST')) || J(r);
      });
    } finally { await F.stop(); }
  }

  /* M3 — an inclusive tax is a difference, never the same rate */
  {
    const F = await freshAccount({});
    try {
      await check('M3: a line switched to the 15 % INCLUSIVE tax reads tax_rate null and changes the content hash', async () => {
        const a = F.L();
        const d = await a.createDraftInvoice({ reference: 'M3-1/F', client_id: F.cl.id, currency: 'SAR', lines: [
          { line_ref: lref('F1'), product_id: F.p15.id, description: 'خدمة', quantity: 1, unit_price: 100, tax_rate: 15 }] });
        const v1 = await a.getInvoice(d.id);
        F.srv.control.editItem(d.id, 0, { tax1: 2 });
        const v2 = await a.getInvoice(d.id);
        return (v1.lines[0].tax_rate === '15.00' && v2.lines[0].tax_rate === null && (await AD.invoiceHash(v1)) !== (await AD.invoiceHash(v2))
          && v2.totals.total === '100.00') || J({ v1: v1.lines, v2: v2.lines, t: v2.totals });
      });
    } finally { await F.stop(); }
  }

  /* M4 — the run deadline */
  await check('M4: runDeadline closer than write timeout + 5 s → no write starts (timeout run_deadline, applied no); reads still run', async () => {
    const n = mark();
    const a = live({ runDeadline: Date.now() + 5000, timeouts: { read: 2000, write: 2000 } });
    const r = await a.findProductByCode('MRS-service-customs_clearance');
    const e = await keepErr(a.createProduct({ code: 'MRS-service-m4_a', name_ar: 'م4', vat_rate: 0 }));
    const e2 = await keepErr(live({ runDeadline: Date.now() - 1 }).getClient(S6.cl.id));
    return (r && e && e.kind === 'timeout' && e.code === 'run_deadline' && e.applied === 'no' && !since(n).some(x => x.method !== 'GET')
      && e2 && e2.code === 'run_deadline' && e2.applied === 'no') || J({ e, e2 });
  });
  await check('M4: index.ts passes runDeadline = run start + 130 s to the live adapter', () => {
    const ts = fs.readFileSync(path.join(FN, 'index.ts'), 'utf8');
    return (/RUN_HARD_DEADLINE_MS = 130000/.test(ts) && /liveDaftraFor\(connection, orgId, runStart \+ RUN_HARD_DEADLINE_MS\)/.test(ts)
      && /deadlineMs: LIVE_DEADLINE_MS, runDeadline,/.test(ts)) || 'runDeadline not wired';
  });

  /* M5 — nothing but the re-read between taxes and the PUT */
  await check('M5: updateDraftInvoice sends taxes → GET invoice → PUT invoice, with no other request between the re-read and the PUT', async () => {
    const a = live();
    const cur = await live().getInvoice(S6.id);
    const x = SRV.state.invoices.find(v => v.Invoice.id === S6.id);
    const pays = x.payments; x.payments = [];
    try {
      const n = mark();
      await a.updateDraftInvoice(S6.id, { lines: cur.lines, expected_version: cur.version });
      const seq = since(n).map(r => r.method + ' ' + r.path).join(',');
      return seq === 'GET taxes.json,GET invoices/' + S6.id + '.json,PUT invoices/' + S6.id + '.json' || seq;
    } finally { x.payments = pays; }
  });

  /* L2 — issue_date / html_notes kept in the PUT header */
  await check('L2: the PUT header keeps issue_date and html_notes', async () => {
    const x = SRV.state.invoices.find(v => v.Invoice.id === S6.id);
    const pays = x.payments; x.payments = [];
    x.Invoice.html_notes = '<p>ملاحظة</p>'; x.Invoice.issue_date = '2026-11-03';
    try {
      const cur = await live().getInvoice(S6.id);
      const n = mark();
      await live().updateDraftInvoice(S6.id, { lines: cur.lines, expected_version: cur.version });
      const put = since(n).find(r => r.method === 'PUT');
      return (put.body.Invoice.html_notes === '<p>ملاحظة</p>' && put.body.Invoice.issue_date === '2026-11-03' && put.body.Invoice.draft === 1) || J(put.body.Invoice);
    } finally { x.payments = pays; }
  });
}

/* ================================================================== 9. worker end to end on PGlite */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const B = 'c5b50000-0000-4000-8000-0000000000b1';
const B_BR = 'c5b50000-0000-4000-8000-0000000000b2';
const B_CL = 'c5b50000-0000-4000-8000-0000000000b3';
const TXA = 'c5b50000-0000-4000-8000-000000000201';
const TXA2 = 'c5b50000-0000-4000-8000-000000000202';
const TXOB = 'c5b50000-0000-4000-8000-000000000205';
const U = {
  accA: 'c5b50000-0000-4000-8000-000000000001', mgrA: 'c5b50000-0000-4000-8000-000000000002',
  accB: 'c5b50000-0000-4000-8000-000000000004', mgrB: 'c5b50000-0000-4000-8000-000000000005'
};
let keySeq = 0;
const newKey = () => `0e5b0000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;
let db;
async function asRole(who, fn) {
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function asService(fn) {
  await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
const rpc = async (who, sql, params) => (await asRole(who, () => q(sql, params)))[0].r;
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const tryErr = async fn => { try { await fn(); return 'ok'; } catch (e) { return errText(e); } };
const SVC_TYPES = { p_worker: 'text', p_limit: 'int', p_attempt: 'uuid', p_result: 'jsonb', p_org: 'uuid', p_state: 'jsonb', p_version: 'int' };
async function svc(name, a) {
  if (!/^daftra_[a-z_]+$/.test(name)) throw new Error('worker may call only daftra_* service RPCs, got ' + name);
  const keys = Object.keys(a || {});
  const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${SVC_TYPES[k] || 'text'}`).join(', ')}) r`;
  return (await asService(() => q(sql, keys.map(k => (SVC_TYPES[k] === 'jsonb' ? J(a[k]) : a[k])))))[0].r;
}
const LIVE_ORG = A;
const adapterLog = [];
// the index.ts gate, in node: live only for the allowlisted org whose subdomain matches; everything else → the stub
function adapterFor(connection, orgId) {
  adapterLog.push({ org: orgId, mode: connection && connection.mode });
  if (connection && connection.mode === 'live' && orgId === LIVE_ORG && connection.subdomain === 'marsa-fake') return live({ expectSubdomain: 'marsa-fake' });
  return AD.createRealAdapter({ subdomain: connection && connection.subdomain });
}
let worker;
async function runAll(max) {
  const tot = { claimed: 0, ok: 0, retry: 0, failed: 0, unknown: 0, conflict: 0, frozen: 0, errors: 0, results: [] };
  for (let i = 0; i < (max || 20); i++) {
    const r = await worker.runOnce({ limit: 5 });
    for (const k of Object.keys(tot)) if (k !== 'results') tot[k] += r[k] || 0;
    tot.results.push(...r.results);
    if (!r.claimed) break;
  }
  if (tot.errors) throw new Error('complete_job errors: ' + J(tot.results.filter(x => x.complete_error)));
  return tot;
}
const wake = () => q(`UPDATE public.billing_sync_jobs SET next_run_at = now() WHERE status IN ('queued','unknown')`);
const charge = (who, tx, p) => rpc(who, `SELECT public.create_client_charge($1, $2) r`, [Object.assign({ transaction_id: tx }, p), newKey()]);
const approve = (who, id) => rpc(who, `SELECT public.set_charge_status($1, 'approved') r`, [id]);
const intentOf = r => (r && r.intent) ? r.intent : r;
const push = (who, id) => rpc(who, `SELECT public.request_billing_push($1, $2) r`, [id, newKey()]);
const intentRow = id => one(`SELECT * FROM public.billing_intents WHERE id = $1`, [id]);

async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g5b.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${B}', 'org-b-g5b', 'مؤسسة ب', 'OBC');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع ب');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone, vat_number) VALUES ('${B_CL}', '${B}', 'business', 'عميل ب', '0509999999', '300000000000999');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.accA}', '${A}', NULL, 'accountant'), ('${U.mgrA}', '${A}', NULL, 'accounts_manager'),
      ('${U.accB}', '${B}', NULL, 'accountant'), ('${U.mgrB}', '${B}', NULL, 'accounts_manager');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, container_count, goods_description) VALUES
      ('${TXA}', '${A}', '${JED}', '${CL101}', 'import', 'sea', 0, 'أجهزة'),
      ('${TXA2}', '${A}', '${JED}', '${CL101}', 'import', 'sea', 0, 'قطع'),
      ('${TXOB}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea', 0, 'ملابس');
  `);
}

async function secCycle() {
  section('9. worker end to end: PGlite + the REAL worker + the live adapter against the fake server');
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await fixtures();
  pass('shim + migrations + seed + fixtures');
  worker = createWorker({ rpc: svc, adapterFor, workerId: 'g5b-live-worker', clock, deps: AD, callTimeoutMs: 10000 });
  // a fresh fake account for the cycle
  await SRV.stop();
  SRV = FDS.createFakeDaftraServer({ apiKey: KEY });
  BASE = (await SRV.start()).baseUrl;

  const C = {};
  C.chS = await charge('accA', TXA, { kind: 'service', description: 'أتعاب التخليص', unit_price: 2500, vat_rate: 15, service_code: 'customs_clearance' });
  C.chR = await charge('accA', TXA, { kind: 'reimbursable', description: 'رسوم الميناء (مبلغ مسترد)', unit_price: 600, vat_rate: 0, service_code: 'port_charges' });
  C.ch2 = await charge('accA', TXA2, { kind: 'service', description: 'تخليص', unit_price: 400, vat_rate: 15, service_code: 'customs_clearance' });
  for (const c of [C.chS, C.chR, C.ch2]) await approve('mgrA', c.id);
  await check('live needs a subdomain: save_daftra_connection {mode:live} without one → MRS_REQUIRED subdomain', async () => {
    const m = await tryErr(() => rpc('mgrA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'live', sync_enabled: true }]));
    return /MRS_REQUIRED/.test(m) && /subdomain/.test(m) || m;
  });
  await check('accountant (not bill_admin) cannot switch to live', async () => {
    const m = await tryErr(() => rpc('accA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'live', subdomain: 'marsa-fake', sync_enabled: true }]));
    return /MRS_FORBIDDEN/.test(m) || m;
  });
  await check('org A → live (subdomain marsa-fake, sync on): not_connected until a probe', async () => {
    const r = await rpc('mgrA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'live', subdomain: 'marsa-fake', sync_enabled: true }]);
    const c = await one(`SELECT mode, status, capabilities FROM public.daftra_connections WHERE org_id = $1`, [A]);
    return (c.mode === 'live' && c.status === 'not_connected' && J(c.capabilities) === '{}' && !!r) || J(c);
  });
  await rpc('mgrA', `SELECT public.request_daftra_probe($1, $2) r`, [A, newKey()]);
  const n0 = mark();
  const r1 = await runAll();
  await check('live probe job → connected, capabilities_source live, 17 keys, issue false, attempt adapter_mode live; only GETs', async () => {
    const c = await one(`SELECT status, capabilities_source, capabilities FROM public.daftra_connections WHERE org_id = $1`, [A]);
    const a = await one(`SELECT a.adapter_mode, a.calls FROM public.billing_sync_attempts a JOIN public.billing_sync_jobs j ON j.id = a.job_id
                          WHERE j.org_id = $1 AND j.kind = 'probe' ORDER BY a.started_at DESC LIMIT 1`, [A]);
    return (c.status === 'connected' && c.capabilities_source === 'live' && Object.keys(c.capabilities).length === 17
      && c.capabilities['invoices.issue'].supported === false && c.capabilities['invoices.create_draft'].supported === true
      && a.adapter_mode === 'live' && J(a.calls).includes('tax_map') && since(n0).every(x => x.method === 'GET') && r1.ok === 1) || J({ c, a, r1 });
  });
  await check('get_daftra_connection: push_ready with the live capabilities', async () => {
    const g = await rpc('accA', `SELECT public.get_daftra_connection($1) r`, [A]);
    return (g.push_ready === true && (g.missing_capabilities || []).length === 0) || J(g);
  });
  C.iA = intentOf(await rpc('accA', `SELECT public.create_billing_intent($1, $2) r`, [{ transaction_id: TXA, purpose: 'final', currency: 'SAR' }, newKey()]));
  await push('accA', C.iA.id);
  const n1 = mark();
  const r2 = await runAll();
  await check('first push: one Daftra client (client_number = MRSC-…), two products, ONE draft (draft 1) with both line refs', async () => {
    const i = await intentRow(C.iA.id);
    const inv = SRV.state.invoices.filter(x => x.Invoice.po_number === C.iA.operational_ref);
    const ls = await q(`SELECT line_ref, state, remote_line_id FROM public.billing_intent_lines WHERE intent_id = $1 ORDER BY line_ref`, [C.iA.id]);
    const refs = inv[0] ? inv[0].items.map(x => /\[(MRSL-[0-9A-F]{16})\]/.exec(x.item)[1]).sort().join(',') : '';
    C.ext = i.external_invoice_id;
    return (SRV.state.clients.filter(c => c.client_number === 'MRSC-' + CL101).length === 1 && SRV.state.products.length === 2 && inv.length === 1
      && inv[0].Invoice.draft === 1 && refs === ls.map(l => l.line_ref).join(',') && i.status === 'draft' && i.sync_state === 'synced'
      && i.external_invoice_id === inv[0].Invoice.id && i.pushed_hash === i.remote_hash && ls.every(l => l.state === 'synced' && l.remote_line_id)
      && r2.ok >= 1) || J({ i, inv: inv.map(x => x.Invoice), ls, r2: r2.results });
  });
  await check('every invoice write of the run carried draft 1; no update_draft path; APIKEY on every request, never Authorization', () => {
    const rq = since(n1);
    return (rq.filter(r => /^invoices/.test(r.path) && r.method !== 'GET').every(r => r.body.Invoice.draft === 1)
      && !SRV.requests.some(r => /update_draft/.test(r.path)) && SRV.requests.every(r => r.apikey && !r.authorization)) || J(rq.map(r => r.method + ' ' + r.path));
  });
  await check('client + item links linked to the Daftra ids; financial_status draft_pending', async () => {
    const l = await one(`SELECT status, external_id FROM public.daftra_client_links WHERE org_id = $1 AND client_id = $2 AND status <> 'unlinked'`, [A, CL101]);
    const it = await q(`SELECT status, external_product_id FROM public.daftra_item_links WHERE org_id = $1 AND status <> 'retired'`, [A]);
    const t = await one(`SELECT financial_status FROM public.transactions WHERE id = $1`, [TXA]);
    const cid = SRV.state.clients.find(c => c.client_number === 'MRSC-' + CL101).id;
    return (['linked', 'drift'].includes(l.status) && l.external_id === cid && it.length === 2 && it.every(x => x.status === 'linked' && /^\d+$/.test(x.external_product_id))
      && t.financial_status === 'draft_pending') || J({ l, it, t });
  });
  await check('re-push with nothing changed: no write at all (read, same hash, no-op)', async () => {
    await push('accA', C.iA.id);
    const n = mark();
    const r = await runAll();
    return (!since(n).some(x => x.method !== 'GET') && r.ok === 1 && SRV.state.invoices.length === 1) || J({ rq: since(n).map(x => x.method + ' ' + x.path), r: r.results });
  });
  await check('lost response on the first push of TX-A2: unknown, then reconciled by reference — exactly one invoice for the ref', async () => {
    C.i2 = intentOf(await rpc('accA', `SELECT public.create_billing_intent($1, $2) r`, [{ transaction_id: TXA2, purpose: 'final', currency: 'SAR' }, newKey()]));
    await push('accA', C.i2.id);
    SRV.faults.push({ method: 'POST', path: /^invoices\.json$/, drop: 'after' });
    const r = await runAll(1);
    const j = await one(`SELECT status FROM public.billing_sync_jobs WHERE intent_id = $1 ORDER BY created_at DESC LIMIT 1`, [C.i2.id]);
    await wake();
    const r2 = await runAll();
    const i = await intentRow(C.i2.id);
    const inv = SRV.state.invoices.filter(x => x.Invoice.po_number === C.i2.operational_ref);
    return (r.unknown === 1 && j.status === 'unknown' && inv.length === 1 && i.external_invoice_id === inv[0].Invoice.id && i.sync_state === 'synced'
      && r2.ok >= 1) || J({ r: r.results, j, r2: r2.results, i, n: inv.length });
  });
  await check('an accountant edit in Daftra → the next push is a conflict (remote_edited) and NO write is sent', async () => {
    SRV.control.editItem(C.ext, 0, { unit_price: '2600' });
    await push('accA', C.iA.id);
    const n = mark();
    const r = await runAll();
    const i = await intentRow(C.iA.id);
    return (r.conflict === 1 && i.conflict && i.conflict.reason === 'remote_edited' && !since(n).some(x => x.method !== 'GET')) || J({ r: r.results, c: i.conflict });
  });
  await check('keep_remote (fin_approve) → synced on the accountant\'s figures; the foreign edit is never overwritten', async () => {
    await rpc('mgrA', `SELECT public.resolve_billing_conflict($1, 'keep_remote', 'accountant price kept') r`, [C.iA.id]);
    await runAll();
    const i = await intentRow(C.iA.id);
    const x = SRV.state.invoices.find(v => v.Invoice.id === C.ext);
    return (i.sync_state === 'synced' && !i.conflict && x.items.some(it => it.unit_price === '2600')) || J({ i, items: x.items });
  });
  await check('the accountant issues inside Daftra → pull → intent issued with the Daftra number; Marsa never updates it again', async () => {
    SRV.control.issue(C.ext);
    await rpc('accA', `SELECT public.request_billing_pull($1) r`, [C.iA.id]);
    const r = await runAll();
    const i = await intentRow(C.iA.id);
    const m = await tryErr(() => push('accA', C.iA.id));
    return (i.status === 'issued' && i.daftra_number === SRV.state.invoices.find(v => v.Invoice.id === C.ext).Invoice.no && /MRS_BAD_TRANSITION/.test(m) && r.ok >= 1) || J({ i, m, r: r.results });
  });
  await check('payment recorded by the accountant in Daftra → pull → paid; TX-A financial_status settled', async () => {
    const x = SRV.state.invoices.find(v => v.Invoice.id === C.ext);
    SRV.control.addPayment(C.ext, x.Invoice.summary_total, 1);
    await rpc('accA', `SELECT public.request_billing_pull($1) r`, [C.iA.id]);
    await runAll();
    const i = await intentRow(C.iA.id);
    const t = await one(`SELECT financial_status FROM public.transactions WHERE id = $1`, [TXA]);
    return (i.payment_status === 'paid' && t.financial_status === 'settled') || J({ ps: i.payment_status, t });
  });
  await check('across the whole cycle: no update_draft, no non-draft invoice write, no payment write, no Authorization header, no fetch', () =>
    (!SRV.requests.some(r => /update_draft|invoice_payments|credit_notes/.test(r.path))
      && SRV.requests.filter(r => /^invoices/.test(r.path) && r.method !== 'GET').every(r => r.body && r.body.Invoice && r.body.Invoice.draft === 1)
      && SRV.requests.every(r => !r.authorization) && fetchCalls === 0) || 'violations');
  await check('org B in live mode is NOT the allowlisted org → every job fails not_configured; zero requests for it', async () => {
    await rpc('mgrB', `SELECT public.save_daftra_connection($1, $2) r`, [B, { mode: 'live', subdomain: 'org-b-co', sync_enabled: true }]);
    await rpc('mgrB', `SELECT public.request_daftra_probe($1, $2) r`, [B, newKey()]);
    const n = mark();
    await runAll();
    const j = await one(`SELECT status, last_error_code FROM public.billing_sync_jobs WHERE org_id = $1 AND kind = 'probe' ORDER BY created_at DESC LIMIT 1`, [B]);
    const c = await one(`SELECT status FROM public.daftra_connections WHERE org_id = $1`, [B]);
    return (j.status === 'failed' && /not_configured/.test(j.last_error_code) && c.status !== 'connected' && since(n).length === 0) || J({ j, c });
  });
  await check('live_pending unchanged: probe fails not_configured, no request', async () => {
    await rpc('mgrB', `SELECT public.save_daftra_connection($1, $2) r`, [B, { mode: 'live_pending' }]);
    await rpc('mgrB', `SELECT public.request_daftra_probe($1, $2) r`, [B, newKey()]);
    const n = mark();
    await runAll();
    const j = await one(`SELECT status, last_error_code FROM public.billing_sync_jobs WHERE org_id = $1 AND kind = 'probe' ORDER BY created_at DESC LIMIT 1`, [B]);
    return (j.status === 'failed' && /not_configured/.test(j.last_error_code) && since(n).length === 0) || J(j);
  });
  await check('the attempt logs and job errors never hold the API key', async () => {
    const r = await one(`SELECT (SELECT coalesce(string_agg(calls::text || coalesce(error::text, ''), ''), '') FROM public.billing_sync_attempts) a,
                                (SELECT coalesce(string_agg(coalesce(last_error_message, ''), ''), '') FROM public.billing_sync_jobs) j`);
    return (!r.a.includes(KEY) && !r.j.includes(KEY) && r.a.length > 100) || 'key found';
  });
}

/* ================================================================== 10. SQL: migration 20261111000100 */
async function secSql() {
  section('10. SQL: migration 20261111000100_g5b_daftra_live.sql');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261110000100, schema_versions row, search_path = \'\' on the function', () => {
    const fnHeads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261110000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261111000100', 'g5b_daftra_live'\)/.test(src)
      && fnHeads.length === 1 && fnHeads.every(h => /SECURITY DEFINER SET search_path = ''/.test(h))) || J(fnHeads.length);
  });
  await check('schema_versions row; health_check reports 20261111000100', async () => {
    const r = await one(`SELECT name FROM public.schema_versions WHERE version = '20261111000100'`);
    const h = (await one(`SELECT public.health_check() r`)).r;
    return (r && r.name === 'g5b_daftra_live' && h.schema_version === '20261111000100') || J({ r, h });
  });
  await check('constraints: mode IN (mock, live_pending, live); live ⇒ subdomain; label daftra_mode live (internal)', async () => {
    const c = await q(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = 'public.daftra_connections'::regclass
                         AND conname IN ('daftra_connections_mode_check','daftra_connections_live_sub_chk') ORDER BY 1`);
    const l = await one(`SELECT label_ar, label_en, client_visible FROM public.status_labels WHERE domain = 'daftra_mode' AND code = 'live'`);
    const m = await tryErr(() => q(`UPDATE public.daftra_connections SET subdomain = NULL WHERE org_id = $1`, [A]));
    return (c.length === 2 && /mode <> 'live'/.test(c[0].d) && /'live'/.test(c[1].d) && l && /drafts only/.test(l.label_en) && l.client_visible === false
      && /daftra_connections_live_sub_chk/.test(m)) || J({ c, l, m });
  });
  await check('save_daftra_connection: authenticated only; an unknown mode refused', async () => {
    const r = await one(`SELECT has_function_privilege('anon', 'public.save_daftra_connection(uuid, jsonb)', 'EXECUTE') a,
                                has_function_privilege('authenticated', 'public.save_daftra_connection(uuid, jsonb)', 'EXECUTE') u`);
    const m = await tryErr(() => rpc('mgrA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'production' }]));
    return (!r.a && r.u && /MRS_INVALID/.test(m)) || J({ r, m });
  });
  await check('live: a subdomain change is another account → not_connected, capabilities cleared (a new probe is required)', async () => {
    await q(`UPDATE public.daftra_connections SET status = 'connected', capabilities = '{"x":1}'::jsonb WHERE org_id = $1`, [A]);
    const before = await one(`SELECT mode FROM public.daftra_connections WHERE org_id = $1`, [A]);
    await rpc('mgrA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { subdomain: 'marsa-fake-2' }]);
    const c = await one(`SELECT status, capabilities FROM public.daftra_connections WHERE org_id = $1`, [A]);
    await rpc('mgrA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'mock' }]);
    await q(`UPDATE public.daftra_connections SET status = 'connected' WHERE org_id = $1`, [A]);
    await rpc('mgrA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { subdomain: 'marsa-fake-3' }]);
    const m = await one(`SELECT status FROM public.daftra_connections WHERE org_id = $1`, [A]);
    return (before.mode === 'live' && c.status === 'not_connected' && J(c.capabilities) === '{}' && m.status === 'connected') || J({ c, m });
  });
  await check('all_migrations.sql: this file appended verbatim at the end (marker once) + the header note', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    return (i > 0 && all.slice(i + marker.length).replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && /pastes supabase\/migrations\/20261111000100_g5b_daftra_live\.sql/.test(all.slice(0, 3000))) || 'not appended verbatim';
  });
  await db.close();

  // a separate database: everything before G5b, then the preflight, then twice
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
    for (const f of fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f) && f < MIG).sort()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    const fp = async () => J(await q(`SELECT p.oid::regprocedure::text s, md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                       WHERE n.nspname IN ('app','public') ORDER BY 1`)) +
      J(await q(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = 'public.daftra_connections'::regclass ORDER BY conname`));
    await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261110000100'`);
    const before = await fp();
    const msg = await tryErr(() => db.exec(src));
    await check('without G6c: exact preflight message, nothing changed', async () =>
      (msg.startsWith('G5b preflight: apply G6c first (schema_versions lacks 20261110000100 g6c_live_email)') && before === await fp()
        && (await one(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261111000100'`)).n === 0) || 'got: ' + msg);
    await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261110000100', 'g6c_live_email')`);
    const r1 = await tryErr(() => db.exec(src));
    const after1 = await fp();
    const r2 = await tryErr(() => db.exec(src));
    await check('applies, and re-runs on top of itself with an identical catalog', async () =>
      (r1 === 'ok' && r2 === 'ok' && after1 === await fp() && (await one(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261111000100'`)).n === 1) || J({ r1, r2 }));
    await check('the re-created function differs from the G5 body only by the G5b lines (live accepted, subdomain rules)', async () => {
      const d = (await one(`SELECT pg_get_functiondef('public.save_daftra_connection(uuid, jsonb)'::regprocedure) d`)).d;
      return (/'mock','live_pending','live'/.test(d) && /MRS_REQUIRED', 'subdomain'/.test(d) && /v\.mode = 'live' AND v\.subdomain IS DISTINCT FROM v_old\.subdomain/.test(d)
        && /subdomain_taken/.test(d) && /bill_admin_roles/.test(d)) || 'body';
    });
  } finally { await db.close(); }
}

/* ================================================================== 11. secrets */
async function secSecrets() {
  section('11. the API key never leaves the APIKEY header');
  await check('no adapter result or error (message, code, toJSON) contains the key', () => {
    const s = J(seen);
    return (seen.length > 40 && !s.includes(KEY) && !s.includes(KEY.slice(3, 20))) || 'key found in ' + seen.length + ' outputs';
  });
  await check('every request carried the APIKEY header and none carried Authorization', () =>
    (SRV.requests.length > 0 && SRV.requests.every(r => r.apikeyHeader && !r.authorization)) || 'header rule broken');
  await check('the http(req) contract: the key only in headers.APIKEY, never in the URL or body', async () => {
    const got = [];
    const spy = FDS.createNodeHttp({ onRequest: r => got.push(r) });
    const L = live({ http: spy });
    await L.findClientByRef('MRSC-0b5e0000-0000-4000-8000-000000000101');
    await errOf(L.createProduct({ code: 'MRS-service-spy_a', name_ar: 'تجسس', vat_rate: 0 }));
    return (got.length >= 2 && got.every(r => r.headers.APIKEY === KEY && !r.url.includes(KEY) && !String(r.body || '').includes(KEY) && !('Authorization' in r.headers))) || 'contract';
  });
}

async function main() {
  SRV = FDS.createFakeDaftraServer({ apiKey: KEY });
  BASE = (await SRV.start()).baseUrl;
  try {
    await secStatic();
    await secGuard();
    await secFactory();
    await secProbe();
    await secClients();
    await secProducts();
    await secInvoices();
    await secTaxes();
    await secErrors();
    await secReview();
    await secSecrets();
    try { await secCycle(); await secSql(); } catch (e) { fail('cycle / sql', errText(e) + ' ' + (e && e.stack)); }
    await check('across the suite: the guard was never bypassed (no update_draft request, every invoice write draft 1), no fetch', () =>
      (!SRV.requests.some(r => /update_draft/.test(r.path)) && SRV.requests.filter(r => /^invoices/.test(r.path) && r.method !== 'GET').every(r => r.body.Invoice.draft === 1)
        && fetchCalls === 0) || 'violation');
  } finally { await SRV.stop(); }
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
