#!/usr/bin/env node
/*
  Marsa (مرسى) — G5 step ١٣ end-to-end Daftra sync cycle (docs/online/G5_SPEC.md § Tests). LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network, no Daftra, no keys:
  the REAL worker.js + mock-adapter.js drive PGlite through the service RPCs (as service_role); staff actions go
  through the staff RPCs (as authenticated); time is moved by a superuser UPDATE billing_sync_jobs SET next_run_at.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql
  Org A = seed "blue-sea" (clients 101 / 102). Org B = fixture "org-b" (ref prefix OBB).
  Users: accA accountant · mgrA accounts_manager (fin_approve + bill_admin) · clientA portal user of client 101 ·
         accB accountant · mgrB accounts_manager (org B).

  Scenario (plan step ١٣ «مزامنة صحيحة بلا ازدواج»):
    0. unit checks without the DB: canonicalInvoice / contentHash, mock determinism, real adapter stub, redaction
    1. setup: approved charges, both orgs connected in mock mode, probe → connected
    2. create: final intent TX-A → one client, two products, one draft with 2 line_refs; draft_pending
    3. duplicate: double push → one job; idem replay; re-run → no second invoice; second final refused
    4. lost response (unknown → reconcile by reference), timeout (retry), offline (dead → retry_billing_job)
    5. update: a late line appended (same remote line ids), a line removed (only that line_ref)
    6. manual edit: conflict (no update sent) → keep_remote; overwrite_remote; deleteDraft → recreate
    7. issue: pull → issued, number, charges invoiced, push refused, never updated; late charge → S1 invoice
    8. payments: partial → paid → financial_status settled
    9. two orgs: parallel runs, no cross-org refs, one running job per org
   10. line ↔ transaction mapping
   11. gate: exactly one of everything, Σ invoiced = Σ issued lines, attempts = completions, events clean,
       the client portal user sees nothing, no network

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g5-cycle-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const FN = path.join(SUPA, 'functions', 'daftra-sync');
const G5_MIGRATION = '20261105000100_g5_daftra.sql';

// No network anywhere: any fetch is a test failure (the worker is given no fetch).
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g5-cycle-tests'); };

const AD = require(path.join(FN, 'adapter.js'));
const { createMockAdapter } = require(path.join(FN, 'mock-adapter.js'));
const { createWorker, runJob } = require(path.join(FN, 'worker.js'));

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const CL102 = '0b5e0000-0000-4000-8000-000000000102';
const B = 'c5c50000-0000-4000-8000-0000000000b1';
const B_BR = 'c5c50000-0000-4000-8000-0000000000b2';
const B_CL = 'c5c50000-0000-4000-8000-0000000000b3';
const TXA = 'c5c50000-0000-4000-8000-000000000201';
const TXB = 'c5c50000-0000-4000-8000-000000000202';
const TXC = 'c5c50000-0000-4000-8000-000000000203';
const TXD = 'c5c50000-0000-4000-8000-000000000204';
const TXOB = 'c5c50000-0000-4000-8000-000000000205';
const CA1 = 'c5c50000-0000-4000-8000-000000000301';
const U = {
  accA: 'c5c50000-0000-4000-8000-000000000001',
  mgrA: 'c5c50000-0000-4000-8000-000000000002',
  clientA: 'c5c50000-0000-4000-8000-000000000003',
  accB: 'c5c50000-0000-4000-8000-000000000004',
  mgrB: 'c5c50000-0000-4000-8000-000000000005'
};
const G5_TABLES = ['daftra_connections', 'daftra_client_links', 'daftra_item_links', 'billing_intents', 'billing_intent_lines',
  'billing_sync_jobs', 'billing_sync_attempts', 'billing_review_items', 'daftra_mock_accounts'];
let keySeq = 0;
const newKey = () => `0e5c0000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;
const N = x => (x === null || x === undefined) ? x : Number(x);
const FIXED_CLOCK = () => '2026-11-02T09:00:00.000Z';

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn) {
  if (!U[who]) throw new Error('unknown user ' + who);
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function asService(fn) {
  await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const one = async (sql, params) => (await q(sql, params))[0];
const count = async (sql, params) => (await q(sql, params))[0].n;

async function expectErr(name, promiseFn, re) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
}
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e)); }
}
async function step(name, fn) {
  try { const r = await fn(); pass(name); return r; }
  catch (e) { fail(name, errText(e)); throw new Error('cycle aborted at: ' + name); }
}
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}

/* ------------------------------------------------------------------ service rpc for the worker (PGlite as service_role) */
const SVC_TYPES = { p_worker: 'text', p_limit: 'int', p_attempt: 'uuid', p_result: 'jsonb', p_org: 'uuid', p_state: 'jsonb', p_version: 'int' };
let completeCalls = 0;
const svcLog = [];
async function svc(name, argsObj) {
  if (!/^daftra_[a-z_]+$/.test(name)) throw new Error('worker may call only daftra_* service RPCs, got ' + name);
  const keys = Object.keys(argsObj || {});
  const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${SVC_TYPES[k] || 'text'}`).join(', ')}) r`;
  const vals = keys.map(k => (SVC_TYPES[k] === 'jsonb' ? JSON.stringify(argsObj[k]) : argsObj[k]));
  if (name === 'daftra_complete_job') completeCalls++;
  svcLog.push(name);
  return asService(async () => (await q(sql, vals))[0].r);
}

/* ------------------------------------------------------------------ mocks and worker */
const mocks = {};
const adapterUse = [];      // {job_org, adapter_org}
function adapterFor(connection, orgId) {
  const m = mocks[orgId];
  if (!m) throw new Error('no mock for org ' + orgId);
  if (connection && connection.mode === 'live_pending') return AD.createRealAdapter({});
  adapterUse.push({ job_org: orgId, adapter_org: m.orgId });
  return m;
}
let worker;
async function runOnce(limit) { return worker.runOnce({ limit: limit || 5 }); }
// run until no job is claimable (bounded)
async function runAll(max) {
  const tot = { claimed: 0, ok: 0, retry: 0, failed: 0, unknown: 0, conflict: 0, frozen: 0, errors: 0, results: [] };
  for (let i = 0; i < (max || 20); i++) {
    const r = await runOnce();
    for (const k of Object.keys(tot)) if (k !== 'results') tot[k] += r[k] || 0;
    tot.results.push(...r.results);
    if (!r.claimed) break;
  }
  if (tot.errors) throw new Error('complete_job errors: ' + JSON.stringify(tot.results.filter(x => x.complete_error)));
  return tot;
}
const wake = () => q(`UPDATE public.billing_sync_jobs SET next_run_at = now() WHERE status IN ('queued','unknown')`);

/* ------------------------------------------------------------------ staff RPC shortcuts */
const charge = (who, tx, p) => rpc(who, `SELECT public.create_client_charge($1, $2) r`, [Object.assign({ transaction_id: tx }, p), newKey()]);
const approveCharge = (who, id) => rpc(who, `SELECT public.set_charge_status($1, 'approved') r`, [id]);
const createIntent = (who, p, key) => rpc(who, `SELECT public.create_billing_intent($1, $2) r`, [p, key || newKey()]);
const push = (who, id, key) => rpc(who, `SELECT public.request_billing_push($1, $2) r`, [id, key || newKey()]);
const pull = (who, id) => rpc(who, `SELECT public.request_billing_pull($1) r`, [id]);
const getIntent = (who, id) => rpc(who, `SELECT public.get_billing_intent($1) r`, [id]);
const intentRow = id => one(`SELECT * FROM public.billing_intents WHERE id = $1`, [id]);
const linesOf = id => q(`SELECT * FROM public.billing_intent_lines WHERE intent_id = $1 ORDER BY line_ref`, [id]);
const jobRow = id => one(`SELECT * FROM public.billing_sync_jobs WHERE id = $1`, [id]);
const txFin = tx => one(`SELECT financial_status FROM public.transactions WHERE id = $1`, [tx]).then(r => r.financial_status);
const intentOf = r => (r && r.intent) ? r.intent : r;
const jobOf = r => (r && r.job) ? r.job : r;
const invCalls = (m, op) => m.control.calls.filter(c => c.op === op).length;

/* ================================================================== 0. unit checks (no DB) */
async function unitChecks() {
  section('0. unit checks: adapter, mock, worker (no DB)');
  await check('the three scripts expose the spec API', () => {
    const need = ['ADAPTER_METHODS', 'CAPABILITY_KEYS', 'AdapterError', 'canonicalInvoice', 'contentHash', 'normalizeClient', 'normalizeName', 'createRealAdapter', 'REAL_ENDPOINTS_TO_VERIFY'];
    const miss = need.filter(k => !(k in AD));
    return (miss.length === 0 && typeof createMockAdapter === 'function' && typeof createWorker === 'function' && typeof runJob === 'function') || 'missing ' + miss;
  });
  await check('the scripts never require another file, never use fetch / Deno / process.env, carry no key (G5b: + daftra-live.js)', () => {
    const bad = [];
    for (const f of ['adapter.js', 'mock-adapter.js', 'worker.js', 'daftra-live.js']) {
      const s = fs.readFileSync(path.join(FN, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
      if (/\brequire\s*\(|^\s*import\s|^\s*export\s/m.test(s)) bad.push(f + ': import/require');
      if (/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(s)) bad.push(f + ': network');
      if (/\bDeno\./.test(s) || /process\.env/.test(s)) bad.push(f + ': Deno / process.env');
      if (/(sk_live|eyJ[A-Za-z0-9_-]{20,}|apikey\s*[:=]\s*['"][^'"]+['"])/i.test(s)) bad.push(f + ': key-like literal');
    }
    return bad.length === 0 || bad.join('; ');
  });
  const inv1 = { id: 'x', client_id: 'c-1', currency: 'SAR', number: 'INV-1', version: '3', totals: { total: 1 },
    lines: [{ id: 'l-2', line_ref: 'MRSL-B', product_id: 'p-1', description: ' خدمة  ', quantity: 1, unit_price: 2500, tax_rate: 15 },
      { id: 'l-9', line_ref: null, product_id: 'p-2', description: 'يدوي', quantity: '2', unit_price: '50.5', tax_rate: '0' },
      { id: 'l-1', line_ref: 'MRSL-A', product_id: 'p-2', description: 'رسوم', quantity: '1.000', unit_price: '600.00', tax_rate: '0.00' }] };
  const inv2 = { lines: [inv1.lines[2], inv1.lines[1], Object.assign({}, inv1.lines[0], { quantity: '1.0', unit_price: '2500.004' })].map(l => {
    const o = {}; for (const k of Object.keys(l).reverse()) o[k] = l[k]; return o; }), currency: 'sar', client_id: 'c-1', id: 'y', number: null, version: '9' };
  await check('canonicalInvoice: sorted by line_ref, foreign last, fixed decimals, ids / totals / numbers excluded', () => {
    const c = AD.canonicalInvoice(inv1);
    return (c.lines.map(l => l.line_ref).join(',') === 'MRSL-A,MRSL-B,' && c.lines[1].unit_price === '2500.00' && c.lines[0].quantity === '1.000'
      && c.lines[2].unit_price === '50.50' && c.lines[1].description === 'خدمة' && !('totals' in c) && !('number' in c) && !('id' in c.lines[0])) || JSON.stringify(c);
  });
  await check('contentHash: stable across key order, number formatting, line order, version, number', async () => {
    const h1 = await AD.contentHash(AD.canonicalInvoice(inv1)), h2 = await AD.contentHash(AD.canonicalInvoice(inv2));
    const h3 = await AD.contentHash(AD.canonicalInvoice(Object.assign({}, inv1, { lines: inv1.lines.slice(1) })));
    return (/^[0-9a-f]{64}$/.test(h1) && h1 === h2 && h1 !== h3) || JSON.stringify({ h1, h2, h3 });
  });
  await check('contentHash: a price change of 0.01 changes the hash', async () => {
    const h1 = await AD.invoiceHash(inv1);
    const e = JSON.parse(JSON.stringify(inv1)); e.lines[0].unit_price = 2500.01;
    return h1 !== await AD.invoiceHash(e);
  });
  await check('normalizeName folds Arabic letters, diacritics, spaces', () =>
    AD.normalizeName('  رسوم   الميناء ') === AD.normalizeName('رسـوم المیناء'.replace('ی', 'ي')) && AD.normalizeName('أتعاب') === AD.normalizeName('اتعاب')
    && AD.normalizeName('خدمة') === AD.normalizeName('خدمه'));
  await check('normalizeClient: the snapshot shape, trimmed, empty → null', () => {
    const c = AD.normalizeClient({ name: ' شركة ', vat_number: '', email: 'a@b.c', extra: 1 });
    return (Object.keys(c).sort().join(',') === 'address,address_short,cr_number,email,name,name_en,phone,vat_number' && c.name === 'شركة' && c.vat_number === null) || JSON.stringify(c);
  });
  await check('createRealAdapter: every method throws not_configured, applied:no, no fetch', async () => {
    const r = AD.createRealAdapter({ subdomain: 'marsa-demo' });
    const kinds = [];
    for (const m of AD.ADAPTER_METHODS) { try { await r[m]('x'); kinds.push('ok'); } catch (e) { kinds.push(e.kind + '/' + e.applied); } }
    return (kinds.every(k => k === 'not_configured/no') && fetchCalls === 0 && AD.REAL_ENDPOINTS_TO_VERIFY.length >= 10
      && AD.REAL_ENDPOINTS_TO_VERIFY.every(e => e.capability && e.method && e.path && e.note)) || kinds.join(',');
  });
  await check('mock probe: every key supported except invoices.issue and credit_notes.create, evidence mock', async () => {
    const m = createMockAdapter({ orgId: 'o', deps: AD });
    const p = await m.probe();
    const off = Object.keys(p.capabilities).filter(k => !p.capabilities[k].supported).sort().join(',');
    return (off === 'credit_notes.create,invoices.issue' && Object.keys(p.capabilities).length === AD.CAPABILITY_KEYS.length
      && Object.values(p.capabilities).every(c => c.evidence === 'mock')) || off;
  });
  async function script() {
    const m = createMockAdapter({ orgId: 'o', deps: AD, clock: FIXED_CLOCK });
    const c = await m.createClient({ ref: 'MRSC-1', name: 'عميل' });
    const p = await m.createProduct({ code: 'MRS-service-none', name_ar: 'خدمات أخرى', vat_rate: 15 });
    const i = await m.createDraftInvoice({ reference: 'R/F', client_id: c.id, currency: 'SAR', lines: [{ line_ref: 'MRSL-1', product_id: p.id, description: 'd', quantity: 1, unit_price: 100, tax_rate: 15 }] });
    m.control.editInvoice(i.id, d => { d.lines[0].unit_price = 90; });
    m.control.issueInvoice(i.id);
    m.control.addPayment(i.id, 50, '2026-11-02');
    return m;
  }
  await check('mock determinism: the same script → the same state (ids c-1 / p-1 / inv-1 / l-1, INV-000001)', async () => {
    const s1 = (await script()).control.state(), s2 = (await script()).control.state();
    return (JSON.stringify(s1) === JSON.stringify(s2) && s1.clients[0].id === 'c-1' && s1.products[0].id === 'p-1'
      && s1.invoices[0].id === 'inv-1' && s1.invoices[0].lines[0].id === 'l-1' && s1.invoices[0].number === 'INV-000001') || JSON.stringify(s1);
  });
  await check('mock: issued invoice refuses update (conflict not a draft); version mismatch → conflict version', async () => {
    const m = await script();
    const r = [];
    try { await m.updateDraftInvoice('inv-1', { lines: [] }); r.push('ok'); } catch (e) { r.push(e.kind + ':' + e.message); }
    const c = await m.createClient({ ref: 'MRSC-2', name: 'x' });
    const i = await m.createDraftInvoice({ reference: 'R2', client_id: c.id, currency: 'SAR', lines: [] });
    try { await m.updateDraftInvoice(i.id, { lines: [], expected_version: '99' }); r.push('ok'); } catch (e) { r.push(e.kind + ':' + e.message); }
    return r.join('|') === 'conflict:not a draft|conflict:version' || r.join('|');
  });
  await check('mock: does not enforce unique references (duplicates countable), payments → partial', async () => {
    const m = await script();
    const c = await m.createClient({ ref: 'MRSC-1', name: 'عميل' });
    await m.createDraftInvoice({ reference: 'R/F', client_id: c.id, currency: 'SAR', lines: [] });
    const inv = await m.getInvoice('inv-1');
    return (m.control.count('client', 'MRSC-1') === 2 && m.control.count('invoice', 'R/F') === 2 && inv.payment.status === 'partial'
      && inv.payment.paid_amount === '50.00' && inv.totals.total === '103.50') || JSON.stringify(inv);
  });
  await check('mock: loseResponse applies then throws timeout/unknown; failNext applied:no does not apply; offline → network', async () => {
    const m = createMockAdapter({ orgId: 'o', deps: AD });
    m.control.loseResponse('createClient');
    let e1; try { await m.createClient({ ref: 'R', name: 'n' }); } catch (e) { e1 = e; }
    m.control.failNext('createClient', 'timeout', { applied: 'no' });
    let e2; try { await m.createClient({ ref: 'R2', name: 'n' }); } catch (e) { e2 = e; }
    m.control.offline(true);
    let e3; try { await m.findClientByRef('R'); } catch (e) { e3 = e; }
    m.control.offline(false);
    return (e1 && e1.kind === 'timeout' && e1.applied === 'unknown' && e2 && e2.applied === 'no' && e3 && e3.kind === 'network'
      && m.control.count('client', 'R') === 1 && m.control.count('client', 'R2') === 0) || JSON.stringify([e1, e2, e3]);
  });
  await check('worker.runJob: an AdapterError applied:unknown → outcome unknown, never failed / retry; secrets redacted from calls', async () => {
    const m = createMockAdapter({ orgId: 'o', deps: AD });
    m.control.loseResponse('createClient');
    const ctx = { connection: { account: { ok: true, reason: null, enforced: false }, policy: { allow_draft_update: true, allow_product_create: true } }, job: { id: 'j', org_id: 'o', kind: 'client_ensure', attempt_no: 1, options: {}, previous_status: 'queued' },
      client: { link_id: 'L', client_id: 'C', client_ref: 'MRSC-C', external_id: null, status: 'pending', data: { name: 'x', vat_number: null } } };
    const r = await runJob(ctx, m, { deps: AD, clock: FIXED_CLOCK });
    const m2 = { probe: async () => ({ capabilities: {}, account: { api_key: 'SHOULD-NOT-APPEAR', nested: { Authorization: 'Bearer x', token: 't' } } }) };
    const r2 = await runJob({ job: { id: 'j2', org_id: 'o', kind: 'probe', options: {} } }, m2, { deps: AD, clock: FIXED_CLOCK });
    const s = JSON.stringify(r2);
    return (r.outcome === 'unknown' && r.calls.some(c => c.applied === 'unknown') && r2.outcome === 'ok'
      && !/SHOULD-NOT-APPEAR|Bearer|"token"/.test(s)) || JSON.stringify({ r, s });
  });
  await check('worker.runJob: VAT hit → conflict with candidates, no client created', async () => {
    const m = createMockAdapter({ orgId: 'o', deps: AD });
    await m.createClient({ ref: 'OTHER', name: 'عميل قديم', vat_number: '300000000000003' });
    const ctx = { connection: { account: { ok: true, reason: null, enforced: false }, policy: { allow_draft_update: true, allow_product_create: true } }, job: { id: 'j', org_id: 'o', kind: 'client_ensure', options: {} },
      client: { link_id: 'L', client_ref: 'MRSC-C', status: 'pending', data: { name: 'x', vat_number: '300000000000003' } } };
    const r = await runJob(ctx, m, { deps: AD });
    return (r.outcome === 'conflict' && r.effects.candidates.length === 1 && r.effects.candidates[0].external_id === 'c-1' && m.control.count('client') === 1) || JSON.stringify(r);
  });
}

/* ================================================================== fixtures */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g5cycle.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${B}', 'org-b-g5', 'مؤسسة ب التجريبية', 'OBB');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع الرياض ب');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone, vat_number) VALUES ('${B_CL}', '${B}', 'business', 'عميل ب', '0509999999', '300000000000999');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.accA}', '${A}', NULL, 'accountant'), ('${U.mgrA}', '${A}', NULL, 'accounts_manager'), ('${U.clientA}', '${A}', NULL, 'client'),
      ('${U.accB}', '${B}', NULL, 'accountant'), ('${U.mgrB}', '${B}', NULL, 'accounts_manager');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CL101}', '${U.clientA}', 'owner');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, container_count, goods_description) VALUES
      ('${TXA}', '${A}', '${JED}', '${CL101}', 'import', 'sea', 1, 'أجهزة'),
      ('${TXB}', '${A}', '${DMM}', '${CL102}', 'import', 'sea', 0, 'مواد غذائية'),
      ('${TXC}', '${A}', '${JED}', '${CL102}', 'import', 'sea', 0, 'قطع غيار'),
      ('${TXD}', '${A}', '${JED}', '${CL101}', 'export', 'sea', 0, 'تمور'),
      ('${TXOB}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea', 0, 'ملابس');
    INSERT INTO public.containers (id, org_id, transaction_id, container_no) VALUES ('${CA1}', '${A}', '${TXA}', 'CYCU5000001');
  `);
}

/* ================================================================== the cycle */
const C = {};

async function cycle() {
  const MA = mocks[A], MB = mocks[B];

  section('1. setup: approved charges, both orgs connected (mock), probe');
  C.chS = await step('TX-A service charge 2500 @ 15 % (customs_clearance)', () => charge('accA', TXA,
    { kind: 'service', description: 'أتعاب التخليص', unit_price: 2500, vat_rate: 15, service_code: 'customs_clearance' }));
  C.chR = await step('TX-A reimbursable 600 @ 0 % (port_charges)', () => charge('accA', TXA,
    { kind: 'reimbursable', description: 'رسوم الميناء (مبلغ مسترد)', unit_price: 600, vat_rate: 0, service_code: 'port_charges' }));
  C.chB = await step('TX-B service 1000 @ 15 % (transport)', () => charge('accA', TXB, { kind: 'service', description: 'نقل', unit_price: 1000, service_code: 'transport' }));
  C.chC = await step('TX-C service 400 @ 15 % (customs_clearance)', () => charge('accA', TXC, { kind: 'service', description: 'تخليص', unit_price: 400, service_code: 'customs_clearance' }));
  C.chD = await step('TX-D service 350 @ 15 % (documentation)', () => charge('accA', TXD, { kind: 'service', description: 'مستندات', unit_price: 350, service_code: 'documentation' }));
  C.chOB = await step('org B TX service 700 @ 15 % (customs_clearance)', () => charge('accB', TXOB, { kind: 'service', description: 'تخليص ب', unit_price: 700, service_code: 'customs_clearance' }));
  await step('all approved (accounts managers)', async () => {
    for (const c of [C.chS, C.chR, C.chB, C.chC, C.chD]) await approveCharge('mgrA', c.id);
    return approveCharge('mgrB', C.chOB.id);
  });
  await check('before connecting: push gate refuses (not_connected) — staging jobs never start without a connection', async () => {
    const i = await createIntent('accA', { transaction_id: TXD, purpose: 'final', currency: 'SAR' });
    C.iD = intentOf(i);
    try { await push('accA', C.iD.id); return 'push accepted without connection'; }
    catch (e) { return /MRS_BAD_TRANSITION.*not_connected/.test(errText(e)) || errText(e); }
  });
  for (const [who, org] of [['mgrA', A], ['mgrB', B]]) {
    await step(`${org === A ? 'org A' : 'org B'}: save_daftra_connection mock + sync_enabled (bill_admin)`, () =>
      rpc(who, `SELECT public.save_daftra_connection($1, $2) r`, [org, { mode: 'mock', subdomain: org === A ? 'marsa-demo' : 'marsa-demo-b', sync_enabled: true }]));
    await step(`${org === A ? 'org A' : 'org B'}: request_daftra_probe`, () => rpc(who, `SELECT public.request_daftra_probe($1, $2) r`, [org, newKey()]));
  }
  await expectErr('accountant (not bill_admin) cannot save the connection', () =>
    rpc('accA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'mock', sync_enabled: true }]), /MRS_FORBIDDEN/);
  const r1 = await step('worker run: both probes done', () => runAll());
  await check('probe jobs ok in both orgs; connection connected, all 17 capabilities from mock (incl. invoices.version_token, not redacted)', async () => {
    const c = await q(`SELECT org_id, status, capabilities_source, capabilities FROM public.daftra_connections ORDER BY org_id`);
    const ok = c.length === 2 && c.every(x => x.status === 'connected' && x.capabilities_source === 'mock'
      && x.capabilities['invoices.create_draft'].supported === true && x.capabilities['invoices.issue'].supported === false
      && Object.keys(x.capabilities).length === 17 && x.capabilities['invoices.version_token'].supported === true);
    return (ok && r1.ok >= 2) || JSON.stringify({ c, r1 });
  });
  await check('get_daftra_connection: push_ready, no missing capabilities', async () => {
    const g = await rpc('accA', `SELECT public.get_daftra_connection($1) r`, [A]);
    return (g.push_ready === true && (g.missing_capabilities || []).length === 0) || JSON.stringify(g);
  });

  section('2. create: final intent TX-A → one client, two products, one draft with line_refs');
  C.iA = intentOf(await step('create_billing_intent TX-A final SAR (eligible lines added)', () => createIntent('accA', { transaction_id: TXA, purpose: 'final', currency: 'SAR' })));
  await check('operational_ref = <tx ref>/F, two pending_add lines with MRSL- refs', async () => {
    const tx = await one(`SELECT ref FROM public.transactions WHERE id = $1`, [TXA]);
    const ls = await linesOf(C.iA.id);
    C.txARef = tx.ref;
    return (C.iA.operational_ref === tx.ref + '/F' && ls.length === 2 && ls.every(l => /^MRSL-[0-9A-F]{16}$/.test(l.line_ref) && l.state === 'pending_add')) || JSON.stringify({ i: C.iA, ls });
  });
  C.pA = await step('request_billing_push TX-A', () => push('accA', C.iA.id));
  await check('job queued (worker not run yet): intent stays open', async () => {
    const j = await jobRow(jobOf(C.pA).id);
    const i = await intentRow(C.iA.id);
    return (j.status === 'queued' && j.kind === 'invoice_push' && i.status === 'open') || JSON.stringify({ j, i });
  });
  await step('worker run', () => runAll());
  await check('Daftra mock: exactly one client by ref MRSC-<client>, two products, one invoice with the 2 line_refs', async () => {
    const s = MA.control.state();
    const ls = await linesOf(C.iA.id);
    const inv = s.invoices.filter(x => x.reference === C.iA.operational_ref);
    const refs = inv[0] ? inv[0].lines.map(l => l.line_ref).sort().join(',') : '';
    return (MA.control.count('client', 'MRSC-' + CL101) === 1 && s.products.length === 2 && inv.length === 1
      && refs === ls.map(l => l.line_ref).sort().join(',') && inv[0].status === 'draft'
      && s.products.map(p => p.code).sort().join(',') === 'MRS-reimbursable-port_charges,MRS-service-customs_clearance') || JSON.stringify(s);
  });
  await check('intent draft / synced, external id + hash stored, lines synced with remote line ids', async () => {
    const i = await intentRow(C.iA.id);
    const ls = await linesOf(C.iA.id);
    C.extA = i.external_invoice_id;
    return (i.status === 'draft' && i.sync_state === 'synced' && i.external_invoice_id === 'inv-1' && /^[0-9a-f]{64}$/.test(i.pushed_hash)
      && i.pushed_hash === i.remote_hash && ls.every(l => l.state === 'synced' && l.pushed && l.remote_line_id)) || JSON.stringify({ i, ls });
  });
  await check('client link linked (found by ref → created), item links linked', async () => {
    const l = await q(`SELECT status, external_id FROM public.daftra_client_links WHERE org_id = $1 AND client_id = $2 AND status <> 'unlinked'`, [A, CL101]);
    const it = await q(`SELECT item_key, status, external_product_id FROM public.daftra_item_links WHERE org_id = $1 AND status <> 'retired' ORDER BY item_key`, [A]);
    return (l.length === 1 && l[0].status === 'linked' && l[0].external_id === 'c-1' && it.length === 2 && it.every(x => x.status === 'linked' && x.external_product_id)) || JSON.stringify({ l, it });
  });
  await check('financial_status TX-A = draft_pending', async () => (await txFin(TXA)) === 'draft_pending' || await txFin(TXA));

  section('3. duplicate: double push, idem replay, re-run, second final');
  const k1 = newKey();
  const d1 = await step('push request #1', () => push('accA', C.iA.id, k1));
  const d2 = await step('push request #2 (double click, new key)', () => push('accA', C.iA.id));
  const d3 = await step('push request #1 replayed (same idem key)', () => push('accA', C.iA.id, k1));
  await check('one live job: #2 deduplicated to the same job, the replay returns the first result', () =>
    (jobOf(d1).id === jobOf(d2).id && d2.deduplicated === true && d1.deduplicated === false && d3.replayed === true
      && AD.stableStringify(Object.assign({}, d3, { replayed: undefined })) === AD.stableStringify(d1))
    || JSON.stringify({ j1: jobOf(d1).id, j2: jobOf(d2).id, dd2: d2.deduplicated, rep: d3.replayed }));
  await check('exactly one queued invoice_push job for the intent', async () =>
    (await count(`SELECT count(*)::int n FROM public.billing_sync_jobs WHERE intent_id = $1 AND status IN ('queued','running','unknown')`, [C.iA.id])) === 1);
  const upBefore = invCalls(MA, 'updateDraftInvoice'), crBefore = invCalls(MA, 'createDraftInvoice');
  await step('worker re-run', () => runAll());
  await check('re-run: no second invoice, no create, no update (no-op)', () =>
    (MA.control.count('invoice', C.iA.operational_ref) === 1 && invCalls(MA, 'createDraftInvoice') === crBefore && invCalls(MA, 'updateDraftInvoice') === upBefore)
    || JSON.stringify({ n: MA.control.count('invoice', C.iA.operational_ref), c: invCalls(MA, 'createDraftInvoice'), u: invCalls(MA, 'updateDraftInvoice') }));
  await expectErr('a second final intent for TX-A SAR → intent_taken', () => createIntent('accA', { transaction_id: TXA, purpose: 'final', currency: 'SAR' }), /MRS_INVALID.*intent_taken/);

  section('4. lost response, timeout, offline');
  C.iB = intentOf(await step('final intent TX-B', () => createIntent('accA', { transaction_id: TXB, purpose: 'final', currency: 'SAR' })));
  MA.control.loseResponse('createDraftInvoice');
  C.pB = await step('push TX-B (createDraftInvoice response will be lost)', () => push('accA', C.iB.id));
  const rB = await step('worker run', () => runAll());
  await check('attempt outcome unknown (never failed / retry), job unknown, intent sync unknown', async () => {
    const j = await jobRow(jobOf(C.pB).id);
    const at = await q(`SELECT outcome FROM public.billing_sync_attempts WHERE job_id = $1 ORDER BY attempt_no`, [j.id]);
    const i = await intentRow(C.iB.id);
    return (j.status === 'unknown' && j.expected_hash && at.length === 1 && at[0].outcome === 'unknown' && i.sync_state === 'unknown' && rB.unknown === 1)
      || JSON.stringify({ j, at, i, rB: rB.results });
  });
  await check('Daftra applied the lost create: one invoice exists for the ref', () => MA.control.count('invoice', C.iB.operational_ref) === 1);
  await step('time passes (reconcile delay) → worker run', async () => { await wake(); return runAll(); });
  await check('reconciled by reference: adopted, still exactly one invoice, intent draft / synced', async () => {
    const i = await intentRow(C.iB.id);
    const j = await jobRow(jobOf(C.pB).id);
    const ls = await linesOf(C.iB.id);
    return (MA.control.count('invoice', C.iB.operational_ref) === 1 && i.status === 'draft' && i.sync_state === 'synced' && j.status === 'done'
      && i.external_invoice_id && ls.every(l => l.state === 'synced')) || JSON.stringify({ i, j, ls, n: MA.control.count('invoice', C.iB.operational_ref) });
  });
  await check('client 102 created once (by ref) during TX-B', () => MA.control.count('client', 'MRSC-' + CL102) === 1);

  C.iC = intentOf(await step('final intent TX-C', () => createIntent('accA', { transaction_id: TXC, purpose: 'final', currency: 'SAR' })));
  MA.control.failNext('createDraftInvoice', 'timeout', { applied: 'no' });
  C.pC = await step('push TX-C (createDraftInvoice times out before send)', () => push('accA', C.iC.id));
  const rC = await step('worker run', () => runAll());
  await check('timeout applied:no → retry: job queued with backoff, nothing created', async () => {
    const j = await jobRow(jobOf(C.pC).id);
    return (rC.retry === 1 && j.status === 'queued' && j.attempts === 1 && new Date(j.next_run_at) > new Date() && MA.control.count('invoice', C.iC.operational_ref) === 0) || JSON.stringify({ j, rC: rC.results });
  });
  await step('backoff elapsed → worker run', async () => { await wake(); return runAll(); });
  await check('TX-C: one invoice, synced', async () => {
    const i = await intentRow(C.iC.id);
    return (MA.control.count('invoice', C.iC.operational_ref) === 1 && i.sync_state === 'synced' && i.status === 'draft') || JSON.stringify(i);
  });

  MA.control.offline(true);
  C.pD = await step('push TX-D while Daftra is offline', () => push('accA', C.iD.id));
  await step('worker runs until the job is dead (offline, retries with backoff)', async () => {
    for (let i = 0; i < 12; i++) { await wake(); await runAll(3); const j = await jobRow(jobOf(C.pD).id); if (j.status === 'dead') return j; }
    throw new Error('job never dead: ' + JSON.stringify(await jobRow(jobOf(C.pD).id)));
  });
  await check('dead after max_attempts, every attempt retry, nothing created', async () => {
    const j = await jobRow(jobOf(C.pD).id);
    const at = await q(`SELECT outcome FROM public.billing_sync_attempts WHERE job_id = $1`, [j.id]);
    return (j.attempts === j.max_attempts && at.length === j.attempts && at.every(a => a.outcome === 'retry') && MA.control.count('invoice', C.iD.operational_ref) === 0) || JSON.stringify({ j, at });
  });
  MA.control.offline(false);
  await step('retry_billing_job (fin_write) after Daftra is back', () => rpc('accA', `SELECT public.retry_billing_job($1) r`, [jobOf(C.pD).id]));
  await step('worker run', async () => { await wake(); return runAll(); });
  await check('TX-D synced, exactly one invoice', async () => {
    const i = await intentRow(C.iD.id);
    const j = await jobRow(jobOf(C.pD).id);
    return (MA.control.count('invoice', C.iD.operational_ref) === 1 && i.sync_state === 'synced' && j.status === 'done') || JSON.stringify({ i, j });
  });

  section('4b. a worker crashes mid-job (lease expiry)');
  C.pullB = await step('pull TX-B queued', () => pull('accA', C.iB.id));
  const crashed = await step('a worker claims it and dies (no completion)', async () => {
    const ctxs = await svc('daftra_claim_jobs', { p_worker: 'crashed-worker', p_limit: 5 });
    if (ctxs.length !== 1 || ctxs[0].job.id !== C.pullB.id) throw new Error(JSON.stringify(ctxs.map(c => c.job)));
    return ctxs[0];
  });
  await check('while the lease is live, no other job of the org is claimed (one running job per org)', async () => {
    const other = await push('accA', C.iC.id);
    const r = await runOnce();
    const ok = r.claimed === 0;
    await wake(); await runAll();          // drain the TX-C push after the check
    return ok || JSON.stringify({ other: jobOf(other).id, r: r.results });
  });
  await q(`UPDATE public.billing_sync_jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [C.pullB.id]);
  await step('lease expired → the next worker run takes the job over', () => runAll());
  await check('the dead attempt closed abandoned, the job re-run as unknown-first and done', async () => {
    const at = await q(`SELECT attempt_no, outcome, worker FROM public.billing_sync_attempts WHERE job_id = $1 ORDER BY attempt_no`, [C.pullB.id]);
    const j = await jobRow(C.pullB.id);
    return (at.length === 2 && at[0].outcome === 'abandoned' && at[0].worker === 'crashed-worker' && at[1].outcome === 'ok' && j.status === 'done') || JSON.stringify({ at, j });
  });
  await check('the crashed worker completes late → applied:false, nothing changed (history never rewritten)', async () => {
    const before = await intentRow(C.iB.id);
    const r = await svc('daftra_complete_job', { p_attempt: crashed.attempt_id, p_result: { outcome: 'conflict', effects: { intent_id: C.iB.id, reason: 'remote_missing', diff: [] } } });
    const after = await intentRow(C.iB.id);
    const a = await one(`SELECT outcome FROM public.billing_sync_attempts WHERE id = $1`, [crashed.attempt_id]);
    return (r.applied === false && after.sync_state === before.sync_state && after.sync_state === 'synced' && a.outcome === 'abandoned') || JSON.stringify({ r, before: before.sync_state, after: after.sync_state, a });
  });

  section('5. update: a late line appended, a line removed');
  const before = MA.control.invoice(C.extA);
  C.chDoc = await step('late approved charge on TX-A: documentation 300', async () => {
    const c = await charge('accA', TXA, { kind: 'service', description: 'رسوم مستندات', unit_price: 300, service_code: 'documentation' });
    await approveCharge('mgrA', c.id);
    return c;
  });
  const add = await step('add_billing_lines (all eligible)', () => rpc('accA', `SELECT public.add_billing_lines($1, NULL, $2) r`, [C.iA.id, newKey()]));
  C.lineDoc = add.added[0];
  await check('one line added, intent sync_state pending', async () =>
    (add.added.length === 1 && (await intentRow(C.iA.id)).sync_state === 'pending') || JSON.stringify(add));
  await step('push + worker run', async () => { await push('accA', C.iA.id); return runAll(); });
  await check('remote: line appended, previous lines untouched (same remote line ids), 3 lines', () => {
    const after = MA.control.invoice(C.extA);
    const keep = before.lines.every(b => after.lines.some(a => a.id === b.id && a.line_ref === b.line_ref && a.unit_price === b.unit_price));
    return (after.lines.length === 3 && keep && after.lines.some(l => l.line_ref === C.lineDoc.line_ref)) || JSON.stringify({ before, after });
  });
  await step('push again + worker run (no change)', async () => { await push('accA', C.iA.id); return runAll(); });
  await check('no duplicate line on re-run: every line_ref once on the remote', () => {
    const inv = MA.control.invoice(C.extA);
    return (inv.lines.length === 3 && new Set(inv.lines.map(l => l.line_ref)).size === 3) || JSON.stringify(inv);
  });
  await expectErr('a pushed line cannot be removed without a reason', () => rpc('accA', `SELECT public.remove_billing_line($1, $2) r`, [C.lineDoc.id, '']), /MRS_(NOTE_)?REQUIRED|MRS_INVALID/);
  await step('remove the documentation line (pushed → pending_remove)', () => rpc('accA', `SELECT public.remove_billing_line($1, $2) r`, [C.lineDoc.id, 'أضيف بالخطأ']));
  await check('line pending_remove until the worker runs', async () => (await one(`SELECT state FROM public.billing_intent_lines WHERE id = $1`, [C.lineDoc.id])).state === 'pending_remove');
  const before2 = MA.control.invoice(C.extA);
  await step('push + worker run', async () => { await push('accA', C.iA.id); return runAll(); });
  await check('only that line_ref removed remotely; other lines same ids; local line removed; charge approved again', async () => {
    const after = MA.control.invoice(C.extA);
    const l = await one(`SELECT state FROM public.billing_intent_lines WHERE id = $1`, [C.lineDoc.id]);
    const ch = await one(`SELECT status FROM public.client_charges WHERE id = $1`, [C.chDoc.id]);
    const rest = before2.lines.filter(x => x.line_ref !== C.lineDoc.line_ref);
    return (after.lines.length === 2 && !after.lines.some(x => x.line_ref === C.lineDoc.line_ref) && rest.every(b => after.lines.some(a => a.id === b.id))
      && l.state === 'removed' && ch.status === 'approved') || JSON.stringify({ after, l, ch });
  });
  await step('the removed charge is voided in G4 (no longer billed, guard released)', () =>
    rpc('mgrA', `SELECT public.set_charge_status($1, 'void', $2) r`, [C.chDoc.id, 'خارج نطاق الفاتورة']));

  section('6. manual edit by the accountant in Daftra');
  const lsA = await linesOf(C.iA.id);
  C.lineS = lsA.find(l => l.charge_id === C.chS.id);
  MA.control.editInvoice(C.extA, d => {
    d.lines.find(l => l.line_ref === C.lineS.line_ref).unit_price = '2400.00';
    d.lines.push({ line_ref: null, product_id: d.lines[0].product_id, description: 'بند أضافه المحاسب', quantity: 1, unit_price: 50, tax_rate: 15 });
  });
  const up6 = invCalls(MA, 'updateDraftInvoice');
  await step('push + worker run after the manual edit', async () => { await push('accA', C.iA.id); return runAll(); });
  await check('conflict remote_edited with a diff on unit_price; NO update call sent', async () => {
    const i = await intentRow(C.iA.id);
    const d = (i.conflict && i.conflict.diff) || [];
    return (i.sync_state === 'conflict' && i.conflict.reason === 'remote_edited' && d.some(x => x.line_ref === C.lineS.line_ref && x.field === 'unit_price')
      && invCalls(MA, 'updateDraftInvoice') === up6) || JSON.stringify({ i, calls: invCalls(MA, 'updateDraftInvoice') });
  });
  await expectErr('push refused while the conflict is open (conflict_open)', () => push('accA', C.iA.id), /MRS_BAD_TRANSITION.*conflict_open/);
  await expectErr('accountant cannot resolve (fin_approve)', () => rpc('accA', `SELECT public.resolve_billing_conflict($1, 'keep_remote', 'x') r`, [C.iA.id]), /MRS_FORBIDDEN/);
  await expectErr('resolution needs a note', () => rpc('mgrA', `SELECT public.resolve_billing_conflict($1, 'keep_remote', '') r`, [C.iA.id]), /MRS_NOTE_REQUIRED/);
  await step('keep_remote (accept the accountant edits)', () => rpc('mgrA', `SELECT public.resolve_billing_conflict($1, 'keep_remote', $2) r`, [C.iA.id, 'المحاسب عدّل السعر باتفاق مع العميل']));
  await check('synced again, remote_override on the edited line, nothing sent, foreign line kept', async () => {
    const i = await intentRow(C.iA.id);
    const l = await one(`SELECT remote_override FROM public.billing_intent_lines WHERE id = $1`, [C.lineS.id]);
    const inv = MA.control.invoice(C.extA);
    return (i.sync_state === 'synced' && l.remote_override && inv.lines.length === 3 && inv.lines.some(x => !x.line_ref)
      && invCalls(MA, 'updateDraftInvoice') === up6) || JSON.stringify({ i, l, inv });
  });
  await step('push + worker run after keep_remote', async () => { await push('accA', C.iA.id); return runAll(); });
  await check('no conflict, no update (remote is the accepted baseline)', async () =>
    ((await intentRow(C.iA.id)).sync_state === 'synced' && invCalls(MA, 'updateDraftInvoice') === up6) || JSON.stringify(await intentRow(C.iA.id)));

  MA.control.editInvoice(C.extA, d => { d.lines.find(l => l.line_ref === C.lineS.line_ref).unit_price = '2300.00'; });
  await step('second manual edit → pull (detected on pull too)', async () => { await pull('accA', C.iA.id); return runAll(); });
  await check('pull detects the edit: conflict', async () => (await intentRow(C.iA.id)).sync_state === 'conflict' || JSON.stringify(await intentRow(C.iA.id)));
  await step('overwrite_remote (explicit, Marsa-owned lines only)', () => rpc('mgrA', `SELECT public.resolve_billing_conflict($1, 'overwrite_remote', $2) r`, [C.iA.id, 'الاتفاق 2500']));
  await step('worker run', () => runAll());
  await check('owned lines restored to Marsa values, foreign line still kept, one update sent, synced', async () => {
    const inv = MA.control.invoice(C.extA);
    const i = await intentRow(C.iA.id);
    const s = inv.lines.find(l => l.line_ref === C.lineS.line_ref);
    return (s.unit_price === '2500.00' && inv.lines.some(x => !x.line_ref && x.description === 'بند أضافه المحاسب') && inv.lines.length === 3
      && invCalls(MA, 'updateDraftInvoice') === up6 + 1 && i.sync_state === 'synced') || JSON.stringify({ inv, i });
  });

  const extC = (await intentRow(C.iC.id)).external_invoice_id;
  MA.control.deleteDraft(extC);
  await step('TX-C draft deleted in Daftra → pull', async () => { await pull('accA', C.iC.id); return runAll(); });
  await check('conflict remote_missing', async () => {
    const i = await intentRow(C.iC.id);
    return (i.sync_state === 'conflict' && i.conflict.reason === 'remote_missing') || JSON.stringify(i);
  });
  await step('recreate', () => rpc('mgrA', `SELECT public.resolve_billing_conflict($1, 'recreate', $2) r`, [C.iC.id, 'حُذفت المسودة بالخطأ']));
  await step('worker run', () => runAll());
  await check('exactly one live invoice for the TX-C ref, new external id, synced', async () => {
    const i = await intentRow(C.iC.id);
    return (MA.control.count('invoice', C.iC.operational_ref) === 1 && i.external_invoice_id && i.external_invoice_id !== extC && i.sync_state === 'synced' && i.status === 'draft') || JSON.stringify(i);
  });

  section('7. issue in Daftra: frozen');
  MA.control.issueInvoice(C.extA);
  const up7 = invCalls(MA, 'updateDraftInvoice');
  await step('pull TX-A after the accountant issued it', async () => { await pull('accA', C.iA.id); return runAll(); });
  await check('intent issued, Daftra number stored, live charges invoiced', async () => {
    const i = await intentRow(C.iA.id);
    const ch = await q(`SELECT c.status FROM public.client_charges c JOIN public.billing_intent_lines l ON l.charge_id = c.id
                         WHERE l.intent_id = $1 AND l.state <> 'removed'`, [C.iA.id]);
    return (i.status === 'issued' && i.daftra_number === 'INV-000001' && ch.length === 2 && ch.every(c => c.status === 'invoiced')) || JSON.stringify({ i, ch });
  });
  await check('issued_mismatch review item: the remote content differs from what Marsa pushed? (Daftra wins)', async () => {
    const n = await count(`SELECT count(*)::int n FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'issued_mismatch'`, [C.iA.id]);
    const i = await intentRow(C.iA.id);
    // the remote = the overwrite read-back (pushed_hash) → no mismatch item
    return (i.remote_hash === i.pushed_hash ? n === 0 : n === 1) || JSON.stringify({ n, i });
  });
  await expectErr('push on the issued intent refused (intent_issued)', () => push('accA', C.iA.id), /MRS_BAD_TRANSITION.*intent_issued/);
  await expectErr('an invoiced charge cannot be moved back by G4 (in_invoice / bad transition)', () =>
    rpc('mgrA', `SELECT public.set_charge_status($1, 'draft', 'x') r`, [C.chS.id]), /MRS_BAD_TRANSITION/);
  await step('pull again', async () => { await pull('accA', C.iA.id); return runAll(); });
  await check('worker never called update on the issued invoice', () => invCalls(MA, 'updateDraftInvoice') === up7 || String(invCalls(MA, 'updateDraftInvoice') - up7));
  C.chLate = await step('a new approved charge on TX-A after issue (storage 450)', async () => {
    const c = await charge('accA', TXA, { kind: 'service', description: 'أرضيات', unit_price: 450, service_code: 'storage' });
    await approveCharge('mgrA', c.id);
    return c;
  });
  C.review = await step('late_charge review item opened', async () => {
    const r = await one(`SELECT * FROM public.billing_review_items WHERE charge_id = $1 AND kind = 'late_charge' AND status = 'open'`, [C.chLate.id]);
    if (!r) throw new Error('no late_charge item');
    return r;
  });
  await check('billing_review_queue lists the late charge', async () => {
    const r = await rpc('accA', `SELECT public.billing_review_queue($1, '{}') r`, [A]);
    return (r.late_charges || []).some(x => (x.id || x.review_id) === C.review.id) || JSON.stringify(r.late_charges);
  });
  await expectErr('a final purpose again is refused; interim after an issued final refused', () =>
    createIntent('accA', { transaction_id: TXA, purpose: 'interim', currency: 'SAR' }), /MRS_BAD_TRANSITION.*final_issued/);
  C.iS = intentOf(await step('supplementary intent S1 (no auto lines)', () => createIntent('accA', { transaction_id: TXA, purpose: 'supplementary', currency: 'SAR', add_eligible: false })));
  await check('S1 operational ref = <tx ref>/S1', () => C.iS.operational_ref === C.txARef + '/S1' || C.iS.operational_ref);
  await step('resolve the late charge → supplementary S1 (line added in the same call)', () =>
    rpc('mgrA', `SELECT public.resolve_billing_review($1, 'supplementary', $2, $3) r`, [C.review.id, 'فاتورة إضافية للأرضيات', C.iS.id]));
  await step('push S1 + worker run', async () => { await push('accA', C.iS.id); return runAll(); });
  await check('S1 has its own invoice, one line, the late charge', async () => {
    const i = await intentRow(C.iS.id);
    const ls = await linesOf(C.iS.id);
    const inv = MA.control.invoice(i.external_invoice_id);
    return (i.status === 'draft' && MA.control.count('invoice', C.iS.operational_ref) === 1 && ls.length === 1 && ls[0].charge_id === C.chLate.id
      && inv.lines.length === 1 && inv.lines[0].line_ref === ls[0].line_ref) || JSON.stringify({ i, ls, inv });
  });

  section('8. payments (Daftra is the source of truth)');
  MA.control.addPayment(C.extA, 1000, '2026-11-02');
  await step('partial payment → pull', async () => { await pull('accA', C.iA.id); return runAll(); });
  await check('payment_status partial, paid 1000', async () => {
    const i = await intentRow(C.iA.id);
    return (i.payment_status === 'partial' && N(i.paid_amount) === 1000) || JSON.stringify(i);
  });
  const totA = MA.control.invoice(C.extA).totals.total;
  MA.control.addPayment(C.extA, Number(totA) - 1000, '2026-11-03');
  await step('rest paid → pull', async () => { await pull('accA', C.iA.id); return runAll(); });
  await check('payment_status paid; S1 still draft → TX-A financial_status stays invoiced (not settled)', async () => {
    const i = await intentRow(C.iA.id);
    return (i.payment_status === 'paid' && N(i.paid_amount) === Number(totA) && (await txFin(TXA)) === 'invoiced') || JSON.stringify({ i, f: await txFin(TXA) });
  });
  const extS = (await intentRow(C.iS.id)).external_invoice_id;
  MA.control.issueInvoice(extS);
  MA.control.addPayment(extS, Number(MA.control.invoice(extS).totals.total), '2026-11-04');
  await step('S1 issued and paid in Daftra → pull', async () => { await pull('accA', C.iS.id); return runAll(); });
  await check('every issued intent paid, no open / draft left → TX-A settled', async () => {
    const i = await intentRow(C.iS.id);
    return (i.status === 'issued' && i.payment_status === 'paid' && (await txFin(TXA)) === 'settled') || JSON.stringify({ i, f: await txFin(TXA) });
  });

  section('9. two orgs');
  C.iOB = intentOf(await step('org B final intent', () => createIntent('accB', { transaction_id: TXOB, purpose: 'final', currency: 'SAR' })));
  await step('org B push + org A pull queued together', async () => { await push('accB', C.iOB.id); await pull('accA', C.iB.id); await pull('accA', C.iC.id); });
  const r9 = await step('one worker run', () => runOnce(10));
  await check('one run claims at most one job per org (lane = org)', () => {
    const per = {};
    for (const x of r9.results) per[x.org_id] = (per[x.org_id] || 0) + 1;
    return (Object.values(per).every(n => n === 1) && per[B] === 1 && per[A] === 1) || JSON.stringify(r9.results);
  });
  await step('drain', () => runAll());
  await check('org B synced on its own mock: own client / product ids, ref OBB-…', async () => {
    const i = await intentRow(C.iOB.id);
    const sB = MB.control.state();
    return (i.status === 'draft' && i.sync_state === 'synced' && /^OBB-/.test(i.operational_ref) && sB.invoices.length === 1 && sB.clients.length === 1
      && sB.clients[0].ref === 'MRSC-' + B_CL) || JSON.stringify({ i, sB });
  });
  await check('org B mock never sees org A refs; org A mock never sees org B refs', async () => {
    const aRefs = (await q(`SELECT operational_ref FROM public.billing_intents WHERE org_id = $1`, [A])).map(r => r.operational_ref);
    const sB = JSON.stringify(MB.control.state()), sA = JSON.stringify(MA.control.state());
    const leakB = aRefs.filter(r => sB.includes(r)).concat([CL101, CL102].filter(id => sB.includes(id)));
    const leakA = [C.iOB.operational_ref, B_CL].filter(r => sA.includes(r));
    return (leakB.length === 0 && leakA.length === 0) || JSON.stringify({ leakB, leakA });
  });
  await check('every adapter use matched the job org (no cross-org adapter)', () => adapterUse.every(u => u.job_org === u.adapter_org) || JSON.stringify(adapterUse.filter(u => u.job_org !== u.adapter_org)));
  await check('org B staff cannot read org A intents (RLS)', async () => (await as('accB', `SELECT count(*)::int n FROM public.billing_intents WHERE org_id = $1`, [A]))[0].n === 0);

  section('10. line ↔ transaction mapping');
  await check('every remote line with a line_ref maps to exactly one live line of the same transaction', async () => {
    const bad = [];
    for (const [org, m] of [[A, MA], [B, MB]]) {
      for (const inv of m.control.state().invoices) {
        const it = await one(`SELECT * FROM public.billing_intents WHERE org_id = $1 AND external_invoice_id = $2`, [org, inv.id]);
        if (!it) { bad.push('no intent for ' + inv.id); continue; }
        for (const l of inv.lines.filter(x => x.line_ref)) {
          const r = await q(`SELECT l.transaction_id lt, c.transaction_id ct FROM public.billing_intent_lines l JOIN public.client_charges c ON c.id = l.charge_id
                              WHERE l.org_id = $1 AND l.line_ref = $2 AND l.state <> 'removed'`, [org, l.line_ref]);
          if (r.length !== 1 || r[0].lt !== it.transaction_id || r[0].ct !== it.transaction_id) bad.push(inv.id + ':' + l.line_ref + ':' + JSON.stringify(r));
        }
      }
    }
    return bad.length === 0 || bad.join('; ');
  });
  await check('no live synced line without a remote line after sync', async () => {
    const bad = [];
    for (const [org, m] of [[A, MA], [B, MB]]) {
      const ls = await q(`SELECT l.line_ref, i.external_invoice_id FROM public.billing_intent_lines l JOIN public.billing_intents i ON i.id = l.intent_id
                           WHERE l.org_id = $1 AND l.state <> 'removed' AND i.status IN ('draft','issued')`, [org]);
      for (const l of ls) {
        const inv = m.control.invoice(l.external_invoice_id);
        if (!inv || !inv.lines.some(x => x.line_ref === l.line_ref)) bad.push(l.line_ref);
      }
    }
    return bad.length === 0 || bad.join(',');
  });

  section('10b. client drift: a rename inside Daftra is shown as remote drift, never written back');
  const lk = await one(`SELECT id, external_id FROM public.daftra_client_links WHERE org_id = $1 AND client_id = $2 AND status <> 'unlinked'`, [A, CL101]);
  const cliBefore = await one(`SELECT * FROM public.clients WHERE id = $1`, [CL101]);
  MA.control.renameClient(lk.external_id, 'اسم عدّله المحاسب في دفترة');
  await step('refresh_daftra_client (accountant) + worker run', async () => { await rpc('accA', `SELECT public.refresh_daftra_client($1) r`, [lk.id]); return runAll(); });
  await check('link drift = remote:name (the Daftra side changed), baseline kept, Marsa client row unchanged', async () => {
    const l = await one(`SELECT status, drift, pushed_snapshot, remote_snapshot FROM public.daftra_client_links WHERE id = $1`, [lk.id]);
    const cli = await one(`SELECT * FROM public.clients WHERE id = $1`, [CL101]);
    return (l.status === 'drift' && (l.drift || []).join() === 'remote:name' && l.pushed_snapshot.name !== l.remote_snapshot.name
      && JSON.stringify(cli) === JSON.stringify(cliBefore)) || JSON.stringify(l);
  });
  await check('acknowledge (fin_approve, note) → Daftra data becomes the baseline; Marsa now differs locally (local:name), still no overwrite', async () => {
    const r = await rpc('mgrA', `SELECT public.resolve_client_drift($1, 'acknowledge', $2) r`, [lk.id, 'اعتماد اسم دفترة']);
    const cli = await one(`SELECT * FROM public.clients WHERE id = $1`, [CL101]);
    return ((r.link.drift || []).join() === 'local:name' && JSON.stringify(cli) === JSON.stringify(cliBefore)
      && MA.control.count('client', 'MRSC-' + CL101) === 1) || JSON.stringify(r.link);
  });

  section('11. gate (exit criteria): no duplicates, correct sync');
  for (const [name, m] of [['org A', MA], ['org B', MB]]) {
    await check(`${name}: invoices per operational_ref = 1, products per code = 1, clients per ref = 1, owned lines per line_ref = 1`, () => {
      const s = m.control.state();
      const dup = arr => { const c = {}; for (const x of arr) c[x] = (c[x] || 0) + 1; return Object.keys(c).filter(k => c[k] > 1); };
      const d = { inv: dup(s.invoices.map(i => i.reference)), prod: dup(s.products.map(p => p.code)), cli: dup(s.clients.map(c => c.ref)),
        lines: dup([].concat(...s.invoices.map(i => i.lines.filter(l => l.line_ref).map(l => l.line_ref)))) };
      return Object.values(d).every(x => x.length === 0) || JSON.stringify(d);
    });
  }
  await check('Σ invoiced charges = Σ synced lines of issued intents', async () => {
    const r = await one(`SELECT (SELECT coalesce(sum(total_amount), 0) FROM public.client_charges WHERE status = 'invoiced') c,
                                (SELECT coalesce(sum(l.total_amount), 0) FROM public.billing_intent_lines l JOIN public.billing_intents i ON i.id = l.intent_id
                                  WHERE i.status = 'issued' AND l.state = 'synced') l`);
    return (N(r.c) === N(r.l) && N(r.c) > 0) || JSON.stringify(r);
  });
  await check('billing_sync_attempts count = worker completions; none left open', async () => {
    const r = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE outcome IS NULL)::int open FROM public.billing_sync_attempts`);
    return (r.n === completeCalls && r.open === 0) || JSON.stringify({ r, completeCalls });
  });
  await check('attempts are append-only (UPDATE / DELETE of a closed attempt refused)', async () => {
    const a = await one(`SELECT id FROM public.billing_sync_attempts ORDER BY started_at LIMIT 1`);
    const errs = [];
    for (const sql of [`UPDATE public.billing_sync_attempts SET outcome = 'ok' WHERE id = $1`, `DELETE FROM public.billing_sync_attempts WHERE id = $1`]) {
      try { await q(sql, [a.id]); errs.push('allowed'); } catch (e) { errs.push('refused'); }
    }
    return errs.join(',') === 'refused,refused' || errs.join(',');
  });
  await check('no amount and no request body in transaction_events (billing events: ids and codes only, internal)', async () => {
    const r = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE visible_to_client)::int v,
                                count(*) FILTER (WHERE jsonb_path_exists(payload, '$.** ? (@.type() == "number")'))::int num,
                                count(*) FILTER (WHERE payload::text ~* '"(amount|price|total|vat|net|request|response|calls|lines|paid_amount|remote_snapshot)[a-z_]*"\\s*:')::int k
                           FROM public.transaction_events WHERE event_type = 'billing'`);
    return (r.n > 10 && r.v === 0 && r.num === 0 && r.k === 0) || JSON.stringify(r);
  });
  await check('no secret-like column in any G5 table', async () => {
    const r = await q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1)
                        AND column_name ~* '(key|secret|token|password)' AND column_name NOT IN ('item_key','dedupe_key','purpose_key')`, [G5_TABLES]);
    return r.length === 0 || JSON.stringify(r);
  });
  await check('no secret-like key stored in any attempt call log', async () =>
    (await count(`SELECT count(*)::int n FROM public.billing_sync_attempts WHERE calls::text ~* '"(api[_-]?key|secret|token|password|authorization|cookie)"'`)) === 0);
  for (const t of G5_TABLES) {
    await check(`client portal user sees 0 rows of ${t}`, async () => {
      try { const r = await as('clientA', `SELECT 1 FROM public.${t}`); return r.length === 0 || r.length + ' rows'; }
      catch (e) { return /permission denied/.test(errText(e)) || errText(e); }
    });
  }
  for (const [name, sql, params] of [
    ['tx_billing', `SELECT public.tx_billing($1) r`, [TXA]], ['get_billing_intent', `SELECT public.get_billing_intent($1) r`, [C.iA.id]],
    ['list_billing_intents', `SELECT public.list_billing_intents($1, '{}') r`, [A]], ['list_billing_jobs', `SELECT public.list_billing_jobs($1, '{}') r`, [A]],
    ['billing_review_queue', `SELECT public.billing_review_queue($1, '{}') r`, [A]], ['get_daftra_connection', `SELECT public.get_daftra_connection($1) r`, [A]],
    ['list_daftra_client_links', `SELECT public.list_daftra_client_links($1, '{}') r`, [A]], ['list_daftra_items', `SELECT public.list_daftra_items($1) r`, [A]],
    ['create_billing_intent', `SELECT public.create_billing_intent($1, NULL) r`, [{ transaction_id: TXA, purpose: 'interim' }]]]) {
    await expectErr(`client: ${name} → MRS_NOT_FOUND / MRS_FORBIDDEN`, () => rpc('clientA', sql, params), /MRS_NOT_FOUND|MRS_FORBIDDEN/);
  }
  await check('client sees no billing events in the timeline', async () =>
    (await as('clientA', `SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'billing'`))[0].n === 0);
  await expectErr('staff cannot call the worker RPCs (daftra_claim_jobs)', () => rpc('accA', `SELECT public.daftra_claim_jobs('x', 1) r`), /permission denied|MRS_FORBIDDEN/);
  await check('the worker called only daftra_* service RPCs; no fetch / network used', () =>
    (svcLog.every(n => /^daftra_/.test(n)) && fetchCalls === 0) || JSON.stringify({ fetchCalls, other: svcLog.filter(n => !/^daftra_/.test(n)) }));

  section('11b. mock persistence (daftra_mock_save / load) and live_pending');
  await check('daftra_mock_load on an empty org → empty state', async () => {
    const r = await svc('daftra_mock_load', { p_org: B });
    return (r && (r.state === null || typeof r.state === 'object')) || JSON.stringify(r);
  });
  await check('daftra_mock_save / load round-trip, then a stale version → mock_version', async () => {
    const l0 = await svc('daftra_mock_load', { p_org: A });
    const st = MA.control.state();
    await svc('daftra_mock_save', { p_org: A, p_state: st, p_version: Number(l0.version || 0) });
    const l1 = await svc('daftra_mock_load', { p_org: A });
    const m2 = createMockAdapter({ orgId: A, deps: AD, state: l1.state });
    let stale = 'accepted';
    try { await svc('daftra_mock_save', { p_org: A, p_state: st, p_version: Number(l0.version || 0) }); } catch (e) { stale = errText(e); }
    return (AD.stableStringify(m2.control.state()) === AD.stableStringify(st) && l1.version === Number(l0.version || 0) + 1 && /mock_version/.test(stale)) || JSON.stringify({ l0v: l0.version, l1v: l1.version, stale });
  });
  await check('daftra_mock_accounts invisible to authenticated staff', async () => {
    try { const r = await as('mgrA', `SELECT 1 FROM public.daftra_mock_accounts`); return r.length === 0 || r.length + ' rows'; }
    catch (e) { return /permission denied/.test(errText(e)) || errText(e); }
  });
  await step('org B switched to live_pending (bill_admin) — no real adapter configured', () =>
    rpc('mgrB', `SELECT public.save_daftra_connection($1, $2) r`, [B, { mode: 'live_pending', sync_enabled: true }]));
  await check('live_pending: probe job fails not_configured, no network, connection not connected', async () => {
    await rpc('mgrB', `SELECT public.request_daftra_probe($1, $2) r`, [B, newKey()]);
    const r = await runAll();
    const c = await one(`SELECT status, last_error_code FROM public.daftra_connections WHERE org_id = $1`, [B]);
    const j = await one(`SELECT status, last_error_code FROM public.billing_sync_jobs WHERE org_id = $1 AND kind = 'probe' ORDER BY created_at DESC LIMIT 1`, [B]);
    return (j.status === 'failed' && /not_configured/.test(j.last_error_code || '') && c.status !== 'connected' && fetchCalls === 0) || JSON.stringify({ j, c, r: r.results });
  });
}

async function main() {
  await unitChecks();
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!migFiles.includes(G5_MIGRATION)) { fail('G5 migration present', G5_MIGRATION + ' not found (DB agent writes it)'); return finish(); }
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return finish();
  // legacy step 7 (20261123000100): the owner decisions default to HF5 (no edit of an existing Daftra draft) and resolve-only
  // products (never created); this suite tests the G5 behaviour, so the connections it creates start with the G5 write policy
  await db.exec(`ALTER TABLE public.daftra_connections ALTER COLUMN allow_draft_update SET DEFAULT true, ALTER COLUMN allow_product_create SET DEFAULT true`);
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return finish();
  try { await fixtures(); pass('fixtures: finance users A + B, org B (OBB), TX-A..D (org A), TX-OB (org B)'); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }
  mocks[A] = createMockAdapter({ orgId: A, deps: AD, clock: FIXED_CLOCK });
  mocks[B] = createMockAdapter({ orgId: B, deps: AD, clock: FIXED_CLOCK });
  worker = createWorker({ rpc: svc, adapterFor, workerId: 'g5-cycle-worker', clock: FIXED_CLOCK, deps: AD });
  try { await cycle(); }
  catch (e) { fail('cycle', errText(e)); }
  finish();
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
