#!/usr/bin/env node
/*
  Marsa (مرسى) — G5 review regressions (docs/online/G5_SPEC.md § "As built" → review fixes). LOCAL TESTS ONLY.
  PGlite (real Postgres in memory), the REAL worker.js + mock-adapter.js; no network, no Daftra, no keys.
  One check group per confirmed review finding:
    F1  one Daftra account per org; a reference hit of another client / currency is never adopted
    F2  value-level redaction (URL query strings, header pairs, error messages, wider key names)
    F3  issued_mismatch details redacted and bounded
    F4  retry of a probe / item job = bill_admin
    F5  client-link counts only from readable branches
    F6  lost create → offline → dead: «unknown» stays sticky, cancel refused, retry adopts, one invoice
    F7  remove after an unknown create waits for the reconcile; backstop: a removed line on the issued invoice holds its charge
    F8  write fencing (daftra_renew_lease), call timeout, late write after a lost lease is surfaced (external_in_use)
    F9  lost create + accountant edit before reconcile → remote_edited conflict (no silent adoption)
    F10 crash after an applied update → ok (no false conflict); pull during an unknown push → no conflict
    F11 issued_mismatch carries the diff; accept writes remote_override
    F13 transactions.financial_status not readable by API roles (staff through staff_internal_fields)
    F15 G4 collection evidence still recordable on an invoiced charge (capped)
    F16 worker RPC lock order (static) + deadlock re-raise
    F18 worker beforeComplete hook (index.ts saves the mock per job before completion)
  usage: NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g5-review-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const FN = path.join(SUPA, 'functions', 'daftra-sync');

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden'); };

const AD = require(path.join(FN, 'adapter.js'));
const { createMockAdapter } = require(path.join(FN, 'mock-adapter.js'));
const { createWorker, runJob, redactCalls, scrubText } = require(path.join(FN, 'worker.js'));

let nPass = 0, nFail = 0;
const fails = [];
function pass(n) { nPass++; if (!QUIET) console.log('PASS  ' + n); }
function fail(n, why) { nFail++; fails.push(n + ' — ' + why); console.log('FAIL  ' + n + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const CL102 = '0b5e0000-0000-4000-8000-000000000102';
const B = 'a7a70000-0000-4000-8000-0000000000b1';
const B_BR = 'a7a70000-0000-4000-8000-0000000000b2';
const B_CL = 'a7a70000-0000-4000-8000-0000000000b3';
const TX = {};
['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'TB'].forEach((k, i) => { TX[k] = 'a7a70000-0000-4000-8000-0000000002' + String(i + 1).padStart(2, '0'); });
const U = {
  accA: 'a7a70000-0000-4000-8000-000000000001', accJ: 'a7a70000-0000-4000-8000-000000000002', supA: 'a7a70000-0000-4000-8000-000000000003',
  mgrA: 'a7a70000-0000-4000-8000-000000000004', clientA: 'a7a70000-0000-4000-8000-000000000005',
  accB: 'a7a70000-0000-4000-8000-000000000006', mgrB: 'a7a70000-0000-4000-8000-000000000007'
};
let keySeq = 0;
const newKey = () => `0e5d0000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;
const CLOCK = () => '2026-11-02T09:00:00.000Z';
const N = x => (x === null || x === undefined) ? x : Number(x);

let db;
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, p) => (await q(sql, p))[0];
async function asRole(who, fn) {
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function asService(fn) {
  await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
const as = (who, sql, p) => asRole(who, () => q(sql, p));
const rpc = async (who, sql, p) => (await as(who, sql, p))[0].r;
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
async function expectErr(name, fn, re) {
  try { await fn(); fail(name, 'expected /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
}
async function check(name, fn) {
  try { const r = await fn(); (r === true || r === undefined) ? pass(name) : fail(name, typeof r === 'string' ? r : 'assertion false'); }
  catch (e) { fail(name, 'threw: ' + errText(e)); }
}
async function step(name, fn) {
  try { const r = await fn(); pass(name); return r; } catch (e) { fail(name, errText(e)); throw new Error('aborted at: ' + name); }
}

const SVC_TYPES = { p_worker: 'text', p_limit: 'int', p_attempt: 'uuid', p_result: 'jsonb', p_org: 'uuid', p_state: 'jsonb', p_version: 'int' };
async function svc(name, a) {
  if (!/^daftra_[a-z_]+$/.test(name)) throw new Error('worker may call only daftra_* RPCs: ' + name);
  const keys = Object.keys(a || {});
  const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${SVC_TYPES[k] || 'text'}`).join(', ')}) r`;
  const vals = keys.map(k => (SVC_TYPES[k] === 'jsonb' ? JSON.stringify(a[k]) : a[k]));
  return asService(async () => (await q(sql, vals))[0].r);
}
const mocks = {};
function adapterFor(connection, orgId) {
  if (connection && connection.mode === 'live_pending') return AD.createRealAdapter({});
  return mocks[orgId];
}
let worker;
async function runAll(max) {
  const tot = { claimed: 0, results: [] };
  for (let i = 0; i < (max || 20); i++) {
    const r = await worker.runOnce({ limit: 5 });
    tot.claimed += r.claimed; tot.results.push(...r.results);
    if (r.errors) throw new Error('complete errors ' + JSON.stringify(r.results.filter(x => x.complete_error)));
    if (!r.claimed) break;
  }
  return tot;
}
const wake = () => q(`UPDATE public.billing_sync_jobs SET next_run_at = now() WHERE status IN ('queued','unknown')`);
const charge = (who, tx, p) => rpc(who, `SELECT public.create_client_charge($1, $2) r`, [Object.assign({ transaction_id: tx }, p), newKey()]);
const approve = (who, id) => rpc(who, `SELECT public.set_charge_status($1, 'approved') r`, [id]);
const intentOf = r => (r && r.intent) ? r.intent : r;
const createIntent = async (who, p) => intentOf(await rpc(who, `SELECT public.create_billing_intent($1, $2) r`, [p, newKey()]));
const push = (who, id) => rpc(who, `SELECT public.request_billing_push($1, $2) r`, [id, newKey()]);
const intentRow = id => one(`SELECT * FROM public.billing_intents WHERE id = $1`, [id]);
const linesOf = id => q(`SELECT * FROM public.billing_intent_lines WHERE intent_id = $1 ORDER BY created_at, id`, [id]);
const pushJob = id => one(`SELECT * FROM public.billing_sync_jobs WHERE intent_id = $1 AND kind = 'invoice_push' ORDER BY created_at DESC, id DESC LIMIT 1`, [id]);
async function billedTx(tx, prices) {
  const ids = [];
  for (const p of prices) { const c = await charge('accA', tx, { kind: 'service', description: 'خدمة ' + p, unit_price: p, service_code: 'customs_clearance' }); await approve('mgrA', c.id); ids.push(c.id); }
  const it = await createIntent('accA', { transaction_id: tx, purpose: 'final', currency: 'SAR' });
  return { it, charges: ids };
}

async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g5review.example.com', now())`).join(', ');
  const txs = Object.keys(TX).filter(k => k !== 'TB').map(k =>
    `('${TX[k]}', '${A}', '${k === 'T2' ? DMM : JED}', '${k === 'T2' ? CL102 : CL101}', 'import', 'sea', 0, 'بضائع ${k}')`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${B}', 'org-b-g5r', 'مؤسسة ب', 'OBR');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع ب');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${B_CL}', '${B}', 'business', 'عميل ب', '0509999990');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.accA}', '${A}', NULL, 'accountant'), ('${U.accJ}', '${A}', '${JED}', 'accountant'), ('${U.supA}', '${A}', NULL, 'supervisor'),
      ('${U.mgrA}', '${A}', NULL, 'accounts_manager'), ('${U.clientA}', '${A}', NULL, 'client'),
      ('${U.accB}', '${B}', NULL, 'accountant'), ('${U.mgrB}', '${B}', NULL, 'accounts_manager');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CL101}', '${U.clientA}', 'owner');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, container_count, goods_description) VALUES ${txs},
      ('${TX.TB}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea', 0, 'بضائع ب');
  `);
}

/* ===================================================================== unit (no DB) */
async function unit() {
  section('F1 (worker): a reference hit is adopted only for the same Daftra client and currency');
  const m = createMockAdapter({ orgId: 'shared', deps: AD, clock: CLOCK });
  const cB = await m.createClient({ ref: 'MRSC-b', name: 'عميل ب' });
  const p = await m.createProduct({ code: 'MRS-service-customs_clearance', name_ar: 'تخليص', vat_rate: 15 });
  const REF = 'MRS-2026-000001/F';
  const invB = await m.createDraftInvoice({ reference: REF, client_id: cB.id, currency: 'SAR', lines: [{ line_ref: 'MRSL-B1', product_id: p.id, description: 'تخليص ب', quantity: 1, unit_price: 400, tax_rate: 15 }] });
  const cA = await m.createClient({ ref: 'MRSC-a', name: 'عميل أ' });
  const ctxFor = (clientExt, currency) => ({
    job: { id: 'j', org_id: 'orgA', kind: 'invoice_push', attempt_no: 1, options: {}, previous_status: 'queued' },
    intent: { id: 'iA', operational_ref: REF, currency, status: 'open', sync_state: 'pending', external_invoice_id: null, pushed_hash: null,
      client: { link_id: 'LA', client_ref: 'MRSC-a', external_id: clientExt, status: 'linked', data: { name: 'عميل أ' } },
      items: [{ link_id: 'IA', item_key: 'service:customs_clearance', product_code: 'MRS-service-customs_clearance', external_product_id: p.id, status: 'linked', name_ar: 'تخليص' }],
      lines: [{ line_id: 'LA1', line_ref: 'MRSL-A1', state: 'pending_add', pushed: false, item_key: 'service:customs_clearance', description: 'تخليص أ', quantity: '1.000', unit_price: '2500.00', vat_rate: '15.00' }] }
  });
  await check('another client\'s invoice with the same reference → conflict external_in_use, nothing appended', async () => {
    const before = m.control.calls.length;
    const r = await runJob(ctxFor(cA.id, 'SAR'), m, { deps: AD, clock: CLOCK });
    const ops = m.control.calls.slice(before).map(c => c.op);
    return (r.outcome === 'conflict' && r.effects.reason === 'external_in_use' && !ops.includes('updateDraftInvoice')
      && m.control.invoice(invB.id).lines.length === 1 && r.effects.diff.some(d => d.field === 'client_id')) || JSON.stringify({ r: r.effects, ops });
  });
  await check('same client, other currency → conflict external_in_use (currency diff)', async () => {
    const r = await runJob(ctxFor(cB.id, 'USD'), m, { deps: AD, clock: CLOCK });
    return (r.outcome === 'conflict' && r.effects.reason === 'external_in_use' && r.effects.diff.some(d => d.field === 'currency')) || JSON.stringify(r.effects);
  });
  await check('an issued invoice of another client found by reference is not marked issued (no frozen adoption)', async () => {
    const m2 = createMockAdapter({ orgId: 's2', deps: AD, clock: CLOCK });
    const c1 = await m2.createClient({ ref: 'X', name: 'x' }), c2 = await m2.createClient({ ref: 'Y', name: 'y' });
    const p2 = await m2.createProduct({ code: 'MRS-service-customs_clearance', name_ar: 'تخليص' });
    const i = await m2.createDraftInvoice({ reference: REF, client_id: c1.id, currency: 'SAR', lines: [] });
    m2.control.issueInvoice(i.id);
    const ctx = ctxFor(c2.id, 'SAR'); ctx.intent.items[0].external_product_id = p2.id;
    const r = await runJob(ctx, m2, { deps: AD, clock: CLOCK });
    return (r.outcome === 'conflict' && r.effects.reason === 'external_in_use') || r.outcome;
  });

  section('F2 (worker): value-level redaction');
  await check('scrubText: URL query, bearer, name=value / name: value secrets', () => {
    const s = scrubText('GET https://acct.daftra.com/api2/site_info?apikey=LEAK_1 failed; Authorization: Bearer LEAK_2; access_token=LEAK_3&x=1 client_secret: "LEAK_4"');
    return (!/LEAK_/.test(s) && /\[redacted\]/.test(s) && /acct\.daftra\.com\/api2\/site_info/.test(s)) || s;
  });
  await check('redact: header pairs masked, access_key / private_key / credentials.pass / auth / jwt dropped, text kept', () => {
    const r = JSON.stringify(redactCalls({ url: 'https://x/a?apikey=LEAK_URL', headers: [['APIKEY', 'LEAK_HDR']], access_key: 'LEAK_A', private_key: 'LEAK_P',
      credentials: { pass: 'LEAK_PASS' }, auth: 'Bearer LEAK_AUTH', jwt: 'LEAK_JWT', body: 'apikey=LEAK_BODY', description: 'أتعاب التخليص', reference: 'MRS-2026-000001/F' }));
    return (!/LEAK_/.test(r) && /أتعاب التخليص/.test(r) && /MRS-2026-000001\/F/.test(r)) || r;
  });
  await check('runJob: an adapter error message echoing the key is scrubbed in error and calls', async () => {
    const bad = { probe: async () => { throw new AD.AdapterError('network', 'GET https://acct.daftra.com/api2?apikey=LEAK_ERR reset', { applied: 'no' }); } };
    const r = await runJob({ job: { id: 'j', org_id: 'o', kind: 'probe', options: {} } }, bad, { deps: AD, clock: CLOCK });
    return (r.outcome === 'retry' && !/LEAK_/.test(JSON.stringify(r))) || JSON.stringify(r);
  });

  section('F8 (worker): call timeout and write fencing');
  await check('a write that never answers times out as applied:unknown → outcome unknown', async () => {
    const mm = createMockAdapter({ orgId: 't', deps: AD, clock: CLOCK });
    const hang = Object.assign(Object.create(mm), { createClient: () => new Promise(() => {}) });
    const ctx = { job: { id: 'j', org_id: 't', kind: 'client_ensure', options: {} }, client: { link_id: 'L', client_ref: 'MRSC-t', status: 'pending', data: { name: 'x' } } };
    const r = await runJob(ctx, hang, { deps: AD, clock: CLOCK, callTimeoutMs: 30 });
    return (r.outcome === 'unknown' && r.calls.some(c => c.op === 'createClient' && c.applied === 'unknown')) || JSON.stringify(r);
  });
  await check('a refused lease renewal sends no write (outcome retry, lease_lost)', async () => {
    const mm = createMockAdapter({ orgId: 't2', deps: AD, clock: CLOCK });
    const ctx = { job: { id: 'j', org_id: 't2', kind: 'client_ensure', options: {} }, client: { link_id: 'L', client_ref: 'MRSC-t2', status: 'pending', data: { name: 'x' } } };
    const r = await runJob(ctx, mm, { deps: AD, clock: CLOCK, beforeWrite: async () => { throw new Error('MRS_BAD_TRANSITION lease_lost'); } });
    return (r.outcome === 'retry' && r.error.kind === 'lease_lost' && mm.control.count('client') === 0) || JSON.stringify(r);
  });
}

/* ===================================================================== DB */
async function dbChecks() {
  const MA = mocks[A];
  section('setup');
  await step('org A: mock connection (subdomain acct-a), probe → connected', async () => {
    await rpc('mgrA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'mock', subdomain: 'acct-a', sync_enabled: true }]);
    await rpc('mgrA', `SELECT public.request_daftra_probe($1, $2) r`, [A, newKey()]);
    await runAll();
    const c = await one(`SELECT status FROM public.daftra_connections WHERE org_id = $1`, [A]);
    if (c.status !== 'connected') throw new Error(c.status);
  });

  section('F1: one Daftra account (subdomain) per org');
  await expectErr('org B cannot save the subdomain of org A (case-insensitive) → MRS_INVALID subdomain_taken',
    () => rpc('mgrB', `SELECT public.save_daftra_connection($1, $2) r`, [B, { mode: 'mock', subdomain: 'ACCT-A' }]), /MRS_INVALID.*subdomain_taken/);
  await check('a partial unique index backs it (lower(subdomain))', async () =>
    !!(await one(`SELECT 1 x FROM pg_indexes WHERE indexname = 'daftra_connections_subdomain_uidx' AND indexdef ~* 'lower'`)));
  await check('org B may save its own subdomain', async () =>
    (await rpc('mgrB', `SELECT public.save_daftra_connection($1, $2) r`, [B, { mode: 'live_pending', subdomain: 'acct-b', sync_enabled: true }])).subdomain === 'acct-b');

  section('F4: retrying a probe job is bill_admin');
  await step('org B (live_pending) probe → failed not_configured', async () => {
    await rpc('mgrB', `SELECT public.request_daftra_probe($1, $2) r`, [B, newKey()]);
    await runAll();
  });
  const probeB = await one(`SELECT id, status FROM public.billing_sync_jobs WHERE org_id = $1 AND kind = 'probe' ORDER BY created_at DESC LIMIT 1`, [B]);
  await check('the probe job failed', () => probeB.status === 'failed' || probeB.status);
  await expectErr('accountant (fin_write, not bill_admin) cannot retry the probe → MRS_FORBIDDEN role',
    () => rpc('accB', `SELECT public.retry_billing_job($1) r`, [probeB.id]), /MRS_FORBIDDEN.*role/);
  await check('accounts manager (bill_admin) can retry it', async () => (await rpc('mgrB', `SELECT public.retry_billing_job($1) r`, [probeB.id])).status === 'queued');

  section('F5: client-link counts only from readable branches');
  const c1 = await charge('accA', TX.T1, { kind: 'service', description: 'تخليص', unit_price: 100, service_code: 'customs_clearance' });
  const c2 = await charge('accA', TX.T2, { kind: 'service', description: 'تخليص DMM', unit_price: 100, service_code: 'customs_clearance' });
  await approve('mgrA', c1.id); await approve('mgrA', c2.id);
  await check('JED-only accountant: unlinked lists CL101 only (CL102 is billable on DMM only)', async () => {
    const r = await rpc('accJ', `SELECT public.list_daftra_client_links($1, '{}') r`, [A]);
    const ids = r.unlinked.map(x => x.client_id);
    return (ids.includes(CL101) && !ids.includes(CL102)) || JSON.stringify(r.unlinked);
  });
  await check('org-wide accountant sees both', async () => {
    const ids = (await rpc('accA', `SELECT public.list_daftra_client_links($1, '{}') r`, [A])).unlinked.map(x => x.client_id);
    return (ids.includes(CL101) && ids.includes(CL102)) || JSON.stringify(ids);
  });
  await rpc('accA', `SELECT public.link_daftra_client($1, NULL, $2) r`, [CL102, newKey()]);
  await check('billable_only: the JED accountant does not learn that CL102 has billable charges', async () => {
    const j = (await rpc('accJ', `SELECT public.list_daftra_client_links($1, '{"billable_only":true}') r`, [A])).items.map(x => x.client_id);
    const a = (await rpc('accA', `SELECT public.list_daftra_client_links($1, '{"billable_only":true}') r`, [A])).items.map(x => x.client_id);
    return (!j.includes(CL102) && a.includes(CL102)) || JSON.stringify({ j, a });
  });
  await runAll();

  section('F2: value-level redaction in SQL (attempts, jobs, connection, audit_log)');
  await check('app.bill_redact / bill_scrub_text: no LEAK_ left, text kept', async () => {
    const payload = { url: 'https://acct-a.daftra.com/api2/site_info?apikey=LEAK_URL', headers: [['APIKEY', 'LEAK_HDRARR']], access_key: 'LEAK_ACCESS',
      private_key: 'LEAK_PRIV', credentials: { pass: 'LEAK_PASS' }, auth: 'Bearer LEAK_AUTH', jwt: 'LEAK_JWT', body: 'apikey=LEAK_BODY',
      description: 'أتعاب التخليص', ref: 'MRS-2026-000001/F', note: 'Authorization: Bearer LEAK_B2' };
    const r = (await one(`SELECT app.bill_redact($1::jsonb)::text t`, [JSON.stringify(payload)])).t;
    return (!/LEAK_/.test(r) && /أتعاب التخليص/.test(r) && /MRS-2026-000001\/F/.test(r)) || r;
  });
  await step('a probe attempt completes with secrets in calls, error message and code', async () => {
    await rpc('mgrA', `SELECT public.request_daftra_probe($1, $2) r`, [A, newKey()]);
    const ctxs = await svc('daftra_claim_jobs', { p_worker: 'w-leak', p_limit: 5 });
    const ctx = ctxs.find(c => c.job.kind === 'probe' && c.job.org_id === A);
    if (!ctx) throw new Error('no probe claimed: ' + JSON.stringify(ctxs.map(c => c.job.kind)));
    const msg = 'GET https://acct-a.daftra.com/api2/site_info?apikey=LEAK_MSG failed';
    await svc('daftra_complete_job', { p_attempt: ctx.attempt_id, p_result: {
      outcome: 'retry', error: { kind: 'network', code: 'token=LEAK_CODE', message: msg, http_status: null },
      calls: [{ op: 'probe', at: CLOCK(), ms: 1, applied: 'no',
        request: { url: 'https://acct-a.daftra.com/api2/site_info?apikey=LEAK_URL', headers: [['APIKEY', 'LEAK_HDRARR']], access_key: 'LEAK_ACCESS',
          private_key: 'LEAK_PRIV', credentials: { pass: 'LEAK_PASS' }, auth: 'Bearer LEAK_AUTH', jwt: 'LEAK_JWT' },
        response: { body: 'apikey=LEAK_BODY' }, error: { kind: 'network', code: 'x', message: msg.replace('LEAK_MSG', 'LEAK_ERR') } }],
      effects: {} } });
  });
  for (const [t, col] of [['billing_sync_attempts', 'x'], ['billing_sync_jobs', 'x'], ['daftra_connections', 'x'], ['audit_log', 'x'], ['billing_intents', 'x']]) {
    await check(`no LEAK_ string stored in ${t}`, async () => {
      const n = (await one(`SELECT count(*)::int n FROM public.${t} ${col} WHERE ${col}::text LIKE '%LEAK\\_%'`)).n;
      return n === 0 || n + ' rows';
    });
  }
  await check('branch accountant / supervisor read no secret through get_daftra_connection / get_billing_job', async () => {
    const c = JSON.stringify(await rpc('accJ', `SELECT public.get_daftra_connection($1) r`, [A]));
    const j = await one(`SELECT id FROM public.billing_sync_jobs WHERE org_id = $1 AND kind = 'probe' ORDER BY created_at DESC LIMIT 1`, [A]);
    const g = JSON.stringify(await rpc('supA', `SELECT public.get_billing_job($1) r`, [j.id]));
    return (!/LEAK_/.test(c) && !/LEAK_/.test(g) && /\[redacted\]/.test(g)) || (c + g).slice(0, 400);
  });
  await wake(); await runAll();

  section('F6: lost create → offline → dead: «unknown» is sticky; cancel refused; retry adopts; one invoice');
  const s6 = await billedTx(TX.T3, [1000]);
  await push('accA', s6.it.id);
  MA.control.loseResponse('createDraftInvoice');
  await runAll();
  const ref6 = s6.it.operational_ref;
  await check('lost create: job unknown, one invoice in Daftra', async () => {
    const j = await pushJob(s6.it.id);
    return (j.status === 'unknown' && MA.control.count('invoice', ref6) === 1) || j.status;
  });
  MA.control.offline(true);
  for (let i = 0; i < 8; i++) { await wake(); await worker.runOnce({ limit: 5 }); }
  MA.control.offline(false);
  await check('offline until dead: job dead, intent sync_state stays unknown (never error), no external id', async () => {
    const j = await pushJob(s6.it.id), i = await intentRow(s6.it.id);
    return (j.status === 'dead' && i.sync_state === 'unknown' && i.external_invoice_id === null) || JSON.stringify({ j: j.status, s: i.sync_state });
  });
  await expectErr('cancel_billing_intent refused (the create may be in Daftra)',
    () => rpc('mgrA', `SELECT public.cancel_billing_intent($1, 'لم تعد مطلوبة') r`, [s6.it.id]), /MRS_BAD_TRANSITION.*(sync_in_flight|unreconciled_remote)/);
  await check('get_billing_intent: can.cancel false', async () => (await rpc('mgrA', `SELECT public.get_billing_intent($1) r`, [s6.it.id])).can.cancel === false);
  await check('defence in depth: even with sync_state forced to error, cancel → unreconciled_remote', async () => {
    await q(`UPDATE public.billing_intents SET sync_state = 'error' WHERE id = $1`, [s6.it.id]);
    try { await rpc('mgrA', `SELECT public.cancel_billing_intent($1, 'x y z') r`, [s6.it.id]); return 'cancelled'; }
    catch (e) { await q(`UPDATE public.billing_intents SET sync_state = 'unknown' WHERE id = $1`, [s6.it.id]); return /unreconciled_remote/.test(errText(e)) || errText(e); }
  });
  await step('retry_billing_job (accountant) + worker', async () => { await rpc('accA', `SELECT public.retry_billing_job($1) r`, [(await pushJob(s6.it.id)).id]); await runAll(); });
  await check('reconciled by reference: adopted, draft / synced, still exactly one invoice', async () => {
    const i = await intentRow(s6.it.id);
    return (i.status === 'draft' && i.sync_state === 'synced' && i.external_invoice_id && MA.control.count('invoice', ref6) === 1) || JSON.stringify({ s: i.status, ss: i.sync_state });
  });

  section('F6b: abandoned lease then failed (not_configured): cancel still refused');
  const s6b = await billedTx(TX.T11, [210]);
  await push('accA', s6b.it.id);
  await step('worker claims, writes the draft, crashes (no completion); lease expires', async () => {
    const ctxs = await svc('daftra_claim_jobs', { p_worker: 'w-crash', p_limit: 5 });
    const ctx = ctxs.find(c => c.intent && c.intent.id === s6b.it.id);
    await runJob(ctx, MA, { deps: AD, clock: CLOCK });
    await q(`UPDATE public.billing_sync_jobs SET locked_until = now() - interval '1 minute' WHERE id = $1`, [ctx.job.id]);
  });
  await step('org A switched to live_pending meanwhile → the takeover run fails not_configured', async () => {
    await rpc('mgrA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'live_pending' }]);
    await runAll();
  });
  await check('job failed after an abandoned attempt; intent stays unknown; cancel refused', async () => {
    const j = await pushJob(s6b.it.id), i = await intentRow(s6b.it.id);
    let c = 'cancelled';
    try { await rpc('mgrA', `SELECT public.cancel_billing_intent($1, 'x y z') r`, [s6b.it.id]); } catch (e) { c = errText(e); }
    return (j.status === 'failed' && i.sync_state === 'unknown' && /sync_in_flight|unreconciled_remote/.test(c)) || JSON.stringify({ j: j.status, s: i.sync_state, c });
  });
  await step('back to mock + probe; retry → adopted, one invoice', async () => {
    await rpc('mgrA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'mock' }]);
    await rpc('mgrA', `SELECT public.request_daftra_probe($1, $2) r`, [A, newKey()]);
    await runAll();
    await rpc('accA', `SELECT public.retry_billing_job($1) r`, [(await pushJob(s6b.it.id)).id]);
    await runAll();
    const i = await intentRow(s6b.it.id);
    if (!(i.status === 'draft' && MA.control.count('invoice', s6b.it.operational_ref) === 1)) throw new Error(JSON.stringify({ s: i.status, n: MA.control.count('invoice', s6b.it.operational_ref) }));
  });

  section('F7: remove after an unknown create waits for the reconcile');
  const s7 = await billedTx(TX.T4, [500, 300]);
  await push('accA', s7.it.id);
  MA.control.loseResponse('createDraftInvoice');
  await runAll();
  MA.control.offline(true);
  for (let i = 0; i < 8; i++) { await wake(); await worker.runOnce({ limit: 5 }); }
  MA.control.offline(false);
  const l7 = await linesOf(s7.it.id);
  const lC2 = l7.find(l => l.charge_id === s7.charges[1]);
  await check('remove_billing_line → pending_remove (not removed at once)', async () => {
    const r = await rpc('accA', `SELECT public.remove_billing_line($1, 'ليست مستحقة') r`, [lC2.id]);
    return r.state === 'pending_remove' || r.state;
  });
  await step('retry + worker', async () => { await rpc('accA', `SELECT public.retry_billing_job($1) r`, [(await pushJob(s7.it.id)).id]); await runAll(); });
  await check('the removed line_ref left the Daftra draft; the other line stays; line removed locally', async () => {
    const i = await intentRow(s7.it.id), inv = MA.control.invoice(i.external_invoice_id);
    const l = await one(`SELECT state FROM public.billing_intent_lines WHERE id = $1`, [lC2.id]);
    return (inv.lines.length === 1 && !inv.lines.some(x => x.line_ref === lC2.line_ref) && l.state === 'removed' && MA.control.count('invoice', s7.it.operational_ref) === 1)
      || JSON.stringify({ lines: inv.lines.map(x => x.line_ref), st: l.state });
  });
  await step('issue in Daftra + pull', async () => {
    const i = await intentRow(s7.it.id);
    MA.control.issueInvoice(i.external_invoice_id);
    await rpc('accA', `SELECT public.request_billing_pull($1) r`, [s7.it.id]);
    await runAll();
  });
  await check('issued: C1 invoiced, C2 approved and eligible again (it is not on the issued invoice)', async () => {
    const r = await q(`SELECT id, status FROM public.client_charges WHERE id = ANY($1) ORDER BY total_amount DESC`, [s7.charges]);
    const tb = await rpc('accA', `SELECT public.tx_billing($1) r`, [TX.T4]);
    return (r[0].status === 'invoiced' && r[1].status === 'approved' && tb.eligible_charges.some(c => c.id === s7.charges[1])) || JSON.stringify(r);
  });

  section('F3 + F7 backstop + F11-like: handcrafted issued pull — redacted, bounded details; removed line on the issued invoice holds its charge');
  const s3 = await billedTx(TX.T9, [800]);
  await push('accA', s3.it.id); await runAll();
  const c3b = await charge('accA', TX.T9, { kind: 'service', description: 'إضافي', unit_price: 90, service_code: 'customs_clearance' });
  await approve('mgrA', c3b.id);
  await rpc('accA', `SELECT public.add_billing_lines($1, $2, $3) r`, [s3.it.id, [c3b.id], newKey()]);
  const l3 = await linesOf(s3.it.id);
  const l3b = l3.find(l => l.charge_id === c3b.id), l3a = l3.find(l => l.charge_id === s3.charges[0]);
  await check('a never-pushed line with nothing unreconciled is still removed at once', async () =>
    (await rpc('accA', `SELECT public.remove_billing_line($1, 'خطأ إدخال') r`, [l3b.id])).state === 'removed');
  await step('pull completes with an issued snapshot carrying both line_refs, secrets and 300 KB', async () => {
    await rpc('accA', `SELECT public.request_billing_pull($1) r`, [s3.it.id]);
    const ctxs = await svc('daftra_claim_jobs', { p_worker: 'w-pull', p_limit: 5 });
    const ctx = ctxs.find(c => c.intent && c.intent.id === s3.it.id);
    const it = await intentRow(s3.it.id);
    const diff = [{ line_ref: l3a.line_ref, field: 'unit_price', pushed: '800.00', remote: '777.00', authorization: 'LEAK_DIFFAUTH' }];
    for (let i = 0; i < 600; i++) diff.push({ line_ref: null, field: 'foreign_line', pushed: null, remote: 'x' + i });
    await svc('daftra_complete_job', { p_attempt: ctx.attempt_id, p_result: { outcome: 'ok', calls: [], effects: {
      intent_id: s3.it.id, external_invoice_id: it.external_invoice_id, daftra_number: 'INV-777', daftra_status: 'issued', remote_state: 'issued',
      remote_hash: 'f'.repeat(64), remote_totals: { net: '867', vat: '130.05', total: '997.05' }, diff,
      remote_snapshot: { lines: [{ line_ref: l3a.line_ref }, { line_ref: l3b.line_ref }], api_token: 'LEAK_SNAPTOKEN', note: 'apikey=LEAK_SNAPVAL',
        pad: Array.from({ length: 100 }, () => 'p'.repeat(3000)) },
      payment: { status: 'unpaid', paid_amount: '0', last_payment_at: null } } } });
  });
  const mm = await one(`SELECT * FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'issued_mismatch'`, [s3.it.id]);
  await check('issued_mismatch: no secret, ≤ 256 KiB, diff ≤ 500, removed_on_remote lists the removed line', async () => {
    const t = JSON.stringify(mm.details);
    return (mm && !/LEAK_/.test(t) && Buffer.byteLength(t) <= 262144 && mm.details.diff.length <= 500
      && (mm.details.removed_on_remote || []).some(x => x.line_ref === l3b.line_ref && x.charge_id === c3b.id)) || t.slice(0, 300);
  });
  await check('audit_log copy holds no secret', async () => (await one(`SELECT count(*)::int n FROM public.audit_log a WHERE a::text LIKE '%LEAK\\_%'`)).n === 0);
  await check('the held charge is not eligible (tx_billing) and cannot be added to a supplementary', async () => {
    const tb = await rpc('accA', `SELECT public.tx_billing($1) r`, [TX.T9]);
    const sup = await createIntent('accA', { transaction_id: TX.T9, purpose: 'supplementary', currency: 'SAR', add_eligible: false }).catch(e => ({ err: errText(e) }));
    let add = 'added';
    if (sup.id) { try { await rpc('accA', `SELECT public.add_billing_lines($1, $2, $3) r`, [sup.id, [c3b.id], newKey()]); } catch (e) { add = errText(e); } }
    return (!tb.eligible_charges.some(c => c.id === c3b.id) && (/not_eligible/.test(add) || /no_eligible|not_eligible|lines/.test(sup.err || ''))) || JSON.stringify({ el: tb.eligible_charges.map(c => c.id), add, sup });
  });
  await check('accept (fin_approve) → the held charge becomes invoiced (Daftra billed it)', async () => {
    await rpc('mgrA', `SELECT public.resolve_billing_review($1, 'accept', 'دفترة هي المرجع', NULL) r`, [mm.id]);
    return (await one(`SELECT status FROM public.client_charges WHERE id = $1`, [c3b.id])).status === 'invoiced';
  });

  section('F15: G4 collection evidence on an invoiced charge');
  await check('record_charge_collection on an invoiced charge succeeds', async () => {
    const st = (await one(`SELECT status FROM public.client_charges WHERE id = $1`, [s3.charges[0]])).status;
    const r = await rpc('accA', `SELECT public.record_charge_collection($1, $2) r`, [{ charge_id: s3.charges[0], amount: 500, method: 'bank_transfer', reference: 'TRX-1' }, newKey()]);
    return (st === 'invoiced' && r.status === 'recorded') || JSON.stringify({ st, r });
  });
  await expectErr('a collection above the remaining total → MRS_OVERPAID',
    () => rpc('accA', `SELECT public.record_charge_collection($1, $2) r`, [{ charge_id: s3.charges[0], amount: 900, method: 'bank_transfer', reference: 'TRX-2' }, newKey()]), /MRS_OVERPAID/);
  await check('a draft charge still refuses collections', async () => {
    const d = await charge('accA', TX.T9, { kind: 'service', description: 'مسودة', unit_price: 10, service_code: 'customs_clearance' });
    try { await rpc('accA', `SELECT public.record_charge_collection($1, $2) r`, [{ charge_id: d.id, amount: 5, method: 'cash', reference: 'x' }, newKey()]); return 'accepted'; }
    catch (e) { return /charge_draft/.test(errText(e)) || errText(e); }
  });

  section('F8: write fencing, late write after a lost lease');
  const s8 = await billedTx(TX.T5, [650]);
  await push('accA', s8.it.id);
  const ctxs8 = await svc('daftra_claim_jobs', { p_worker: 'w-slow', p_limit: 5 });
  const ctx8 = ctxs8.find(c => c.intent && c.intent.id === s8.it.id);
  let release; const gate = new Promise(r => { release = r; });
  const gated = Object.assign(Object.create(MA), { createDraftInvoice: async (d) => { await gate; return MA.createDraftInvoice(d); } });
  const slow = runJob(ctx8, gated, { deps: AD, clock: CLOCK, beforeWrite: () => svc('daftra_renew_lease', { p_attempt: ctx8.attempt_id }) });
  await new Promise(r => setTimeout(r, 30));
  await check('daftra_renew_lease extended the lease of the slow worker', async () => {
    const j = await one(`SELECT locked_until > now() + interval '4 minutes' ok FROM public.billing_sync_jobs WHERE id = $1`, [ctx8.job.id]);
    return j.ok === true;
  });
  await q(`UPDATE public.billing_sync_jobs SET locked_until = now() - interval '1 minute' WHERE id = $1`, [ctx8.job.id]);
  await runAll();
  await check('the takeover run created the draft (one invoice so far); renew is refused for the old attempt', async () => {
    let r = 'renewed';
    try { await svc('daftra_renew_lease', { p_attempt: ctx8.attempt_id }); } catch (e) { r = errText(e); }
    return (MA.control.count('invoice', s8.it.operational_ref) === 1 && /lease_lost/.test(r)) || r;
  });
  release();
  const res8 = await slow;
  const done8 = await svc('daftra_complete_job', { p_attempt: ctx8.attempt_id, p_result: res8 });
  await check('a write already in flight when the lease was lost lands late: completion applies nothing but reports it', async () =>
    (done8.applied === false && (done8.late_writes || []).includes('createDraftInvoice') && MA.control.count('invoice', s8.it.operational_ref) === 2) || JSON.stringify(done8));
  await check('the intent is marked unknown (late_write) and a billing event names the op (no bodies)', async () => {
    const i = await intentRow(s8.it.id);
    const ev = await one(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'billing' AND payload->>'op' = 'late_write'`, [TX.T5]);
    return (i.sync_state === 'unknown' && i.last_error_code === 'late_write' && ev && !/inv-|lines|amount/.test(JSON.stringify(ev.payload))) || JSON.stringify({ s: i.sync_state, ev });
  });
  await step('next push reconciles by reference first', async () => { await push('accA', s8.it.id); await runAll(); });
  await check('the duplicate is detected: conflict external_in_use (never silent)', async () => {
    const i = await intentRow(s8.it.id);
    return (i.sync_state === 'conflict' && i.conflict.reason === 'external_in_use') || JSON.stringify({ s: i.sync_state, c: i.conflict });
  });
  await check('a fenced worker whose lease expired sends nothing: renew refused before the write → no create; takeover creates once', async () => {
    const s = await billedTx(TX.T10, [70]);
    await push('accA', s.it.id);
    const cs = await svc('daftra_claim_jobs', { p_worker: 'w-slow2', p_limit: 5 });
    const cx = cs.find(c => c.intent && c.intent.id === s.it.id);
    await q(`UPDATE public.billing_sync_jobs SET locked_until = now() - interval '1 minute' WHERE id = $1`, [cx.job.id]);
    const r = await runJob(cx, MA, { deps: AD, clock: CLOCK, beforeWrite: () => svc('daftra_renew_lease', { p_attempt: cx.attempt_id }) });
    const n0 = MA.control.count('invoice', s.it.operational_ref);
    const d = await svc('daftra_complete_job', { p_attempt: cx.attempt_id, p_result: r });
    await wake(); await runAll();
    const i = await intentRow(s.it.id);
    return (r.error && r.error.kind === 'lease_lost' && n0 === 0 && MA.control.count('invoice', s.it.operational_ref) === 1 && i.sync_state === 'synced')
      || JSON.stringify({ r: r.outcome, e: r.error, n0, d, s: i.sync_state });
  });

  section('F9: lost create + accountant edit before the reconcile → remote_edited conflict');
  const s9 = await billedTx(TX.T6, [700]);
  await push('accA', s9.it.id);
  MA.control.loseResponse('createDraftInvoice');
  await runAll();
  const inv9 = MA.control.state().invoices.find(x => x.reference === s9.it.operational_ref);
  MA.control.editInvoice(inv9.id, d => { d.lines[0].unit_price = 1; });
  await wake(); await runAll();
  await check('conflict remote_edited with a unit_price diff; pushed_hash not taken from the edited invoice', async () => {
    const i = await intentRow(s9.it.id);
    return (i.sync_state === 'conflict' && i.conflict.reason === 'remote_edited' && i.pushed_hash === null
      && (i.conflict.diff || []).some(d => d.field === 'unit_price' && d.remote === '1.00') && MA.control.invoice(inv9.id).lines[0].unit_price === '1.00')
      || JSON.stringify({ s: i.sync_state, c: i.conflict, ph: i.pushed_hash });
  });

  section('F10a: crash after an applied update → takeover ok, no false conflict');
  const s10 = await billedTx(TX.T7, [400]);
  await push('accA', s10.it.id); await runAll();
  const c10 = await charge('accA', TX.T7, { kind: 'service', description: 'لاحق', unit_price: 60, service_code: 'customs_clearance' });
  await approve('mgrA', c10.id);
  await rpc('accA', `SELECT public.add_billing_lines($1, $2, $3) r`, [s10.it.id, [c10.id], newKey()]);
  await push('accA', s10.it.id);
  await step('worker claims, applies the update, crashes; lease expires', async () => {
    const cs = await svc('daftra_claim_jobs', { p_worker: 'w-crash2', p_limit: 5 });
    const cx = cs.find(c => c.intent && c.intent.id === s10.it.id);
    const r = await runJob(cx, MA, { deps: AD, clock: CLOCK });
    if (r.outcome !== 'ok') throw new Error('first run ' + r.outcome);
    await q(`UPDATE public.billing_sync_jobs SET locked_until = now() - interval '1 minute' WHERE id = $1`, [cx.job.id]);
  });
  const upd10 = MA.control.calls.filter(c => c.op === 'updateDraftInvoice').length;
  await runAll();
  await check('takeover: ok, synced, both lines synced, no update re-sent', async () => {
    const i = await intentRow(s10.it.id), ls = await linesOf(s10.it.id);
    return (i.sync_state === 'synced' && ls.every(l => l.state === 'synced') && MA.control.calls.filter(c => c.op === 'updateDraftInvoice').length === upd10
      && MA.control.invoice(i.external_invoice_id).lines.length === 2) || JSON.stringify({ s: i.sync_state, c: i.conflict, ls: ls.map(l => l.state) });
  });

  section('F10b: a pull between a lost update and its reconcile raises no conflict');
  const s10b = await billedTx(TX.T8, [300]);
  await push('accA', s10b.it.id); await runAll();
  const c10b = await charge('accA', TX.T8, { kind: 'service', description: 'لاحق ب', unit_price: 40, service_code: 'customs_clearance' });
  await approve('mgrA', c10b.id);
  await rpc('accA', `SELECT public.add_billing_lines($1, $2, $3) r`, [s10b.it.id, [c10b.id], newKey()]);
  await push('accA', s10b.it.id);
  MA.control.loseResponse('updateDraftInvoice');
  await runAll();
  await rpc('accA', `SELECT public.request_billing_pull($1) r`, [s10b.it.id]);
  await runAll();
  await check('after the pull: sync_state still unknown, no conflict, push not refused', async () => {
    const i = await intentRow(s10b.it.id);
    return (i.sync_state === 'unknown' && i.conflict === null) || JSON.stringify({ s: i.sync_state, c: i.conflict });
  });
  await wake(); await runAll();
  await check('the reconcile then settles it: synced, 2 lines, one invoice', async () => {
    const i = await intentRow(s10b.it.id);
    return (i.sync_state === 'synced' && MA.control.invoice(i.external_invoice_id).lines.length === 2 && MA.control.count('invoice', s10b.it.operational_ref) === 1) || JSON.stringify({ s: i.sync_state, c: i.conflict });
  });

  section('F11: issued_mismatch carries the diff; accept writes remote_override');
  const it11 = (await billedTx(TX.T1, [])).it;
  await push('accA', it11.id); await runAll();
  const ii = await intentRow(it11.id);
  MA.control.editInvoice(ii.external_invoice_id, d => { d.lines[0].unit_price = 9999; });
  MA.control.issueInvoice(ii.external_invoice_id);
  await rpc('accA', `SELECT public.request_billing_pull($1) r`, [it11.id]);
  await runAll();
  const m11 = await one(`SELECT * FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'issued_mismatch'`, [it11.id]);
  await check('issued; issued_mismatch diff has unit_price remote 9999.00', async () =>
    ((await intentRow(it11.id)).status === 'issued' && m11 && m11.details.diff.some(d => d.field === 'unit_price' && d.remote === '9999.00')) || JSON.stringify(m11 && m11.details.diff));
  await check('accept → the line keeps remote_override.unit_price = 9999.00', async () => {
    await rpc('mgrA', `SELECT public.resolve_billing_review($1, 'accept', 'سعر المحاسب', NULL) r`, [m11.id]);
    const l = (await linesOf(it11.id))[0];
    return (l.remote_override && l.remote_override.unit_price === '9999.00') || JSON.stringify(l.remote_override);
  });

  section('F13: transactions.financial_status is not API-selectable (G5-6)');
  await check('the transaction is invoiced now (G5-7)', async () => (await one(`SELECT financial_status f FROM public.transactions WHERE id = $1`, [TX.T1])).f === 'invoiced');
  await expectErr('client portal user cannot SELECT financial_status of his own transaction', () => as('clientA', `SELECT financial_status FROM public.transactions WHERE id = $1`, [TX.T1]), /permission denied/);
  await check('the client still reads his own transaction (other columns)', async () => (await as('clientA', `SELECT id, ref FROM public.transactions WHERE id = $1`, [TX.T1])).length === 1);
  await check('staff read it through staff_internal_fields (MarsaApi withInternal)', async () => {
    const r = await rpc('accA', `SELECT public.staff_internal_fields('transactions', $1) r`, [[TX.T1]]);
    return (r[TX.T1] && r[TX.T1].financial_status === 'invoiced') || JSON.stringify(r);
  });
  await check('the client gets nothing from staff_internal_fields', async () => {
    const r = await rpc('clientA', `SELECT public.staff_internal_fields('transactions', $1) r`, [[TX.T1]]);
    return JSON.stringify(r) === '{}' || JSON.stringify(r);
  });

  section('F16: worker RPC lock order (static) + deadlock handling');
  await check('daftra_complete_job locks transaction → intent before attempt → job; re-raises 40P01 / 40001', async () => {
    const d = (await one(`SELECT pg_get_functiondef('public.daftra_complete_job(uuid, jsonb)'::regprocedure) d`)).d;
    const iTx = d.indexOf('FROM public.transactions t WHERE t.id = v_tx FOR UPDATE');
    const iJob = d.indexOf('FROM public.billing_sync_jobs j WHERE j.id = v_a.job_id FOR UPDATE');
    return (iTx > 0 && iJob > iTx && /40P01/.test(d)) || JSON.stringify({ iTx, iJob });
  });
  await check('daftra_claim_jobs takes the intent with SKIP LOCKED (never waits on a staff RPC)', async () => {
    const d = (await one(`SELECT pg_get_functiondef('public.daftra_claim_jobs(text, int)'::regprocedure) d`)).d;
    return /FROM public\.billing_intents i WHERE i\.id = v_j\.intent_id FOR UPDATE SKIP LOCKED/.test(d);
  });

  section('F18: beforeComplete hook (index.ts saves the mock per job before the completion)');
  await check('a hook that reports a moved mock turns the job into retry with nothing applied', async () => {
    await rpc('mgrA', `SELECT public.request_daftra_probe($1, $2) r`, [A, newKey()]);
    const before = await one(`SELECT capabilities_checked_at c, status FROM public.daftra_connections WHERE org_id = $1`, [A]);
    const w2 = createWorker({ rpc: svc, adapterFor, workerId: 'w-hook', clock: CLOCK, deps: AD,
      beforeComplete: () => ({ outcome: 'retry', calls: [], effects: {}, error: { kind: 'mock_version', code: 'mock_version', message: 'moved', http_status: null } }) });
    const r = await w2.runOnce({ limit: 5 });
    const after = await one(`SELECT capabilities_checked_at c, status FROM public.daftra_connections WHERE org_id = $1`, [A]);
    const j = await one(`SELECT status, last_error_code FROM public.billing_sync_jobs WHERE org_id = $1 AND kind = 'probe' ORDER BY created_at DESC LIMIT 1`, [A]);
    await wake(); await runAll();
    return (r.results.some(x => x.kind === 'probe' && x.outcome === 'retry') && j.status === 'queued' && j.last_error_code === 'mock_version'
      && String(before.c) === String(after.c) && after.status === 'connected') || JSON.stringify({ r: r.results, j, before, after });
  });
  await check('index.ts saves the mock inside beforeComplete (before daftra_complete_job), not after the run', () => {
    const s = fs.readFileSync(path.join(FN, 'index.ts'), 'utf8');
    return (/beforeComplete/.test(s) && /daftra_mock_save/.test(s) && !/for \(const \[orgId, m\] of mocks\)/.test(s)) || 'index.ts unchanged';
  });

  section('gate');
  await check('no fetch / network used', () => fetchCalls === 0 || String(fetchCalls));
  await check('attempts closed exactly once (none open)', async () => (await one(`SELECT count(*)::int n FROM public.billing_sync_attempts WHERE outcome IS NULL`)).n === 0);
}

async function main() {
  await unit();
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  section('load');
  const dir = path.join(SUPA, 'migrations');
  await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of fs.readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await fixtures();
  pass('shim + migrations + seed + fixtures');
  mocks[A] = createMockAdapter({ orgId: A, deps: AD, clock: CLOCK });
  mocks[B] = createMockAdapter({ orgId: B, deps: AD, clock: CLOCK });
  worker = createWorker({ rpc: svc, adapterFor, workerId: 'g5-review-worker', clock: CLOCK, deps: AD });
  try { await dbChecks(); } catch (e) { fail('db checks', errText(e)); }
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
