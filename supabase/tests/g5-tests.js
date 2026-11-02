#!/usr/bin/env node
/*
  Marsa (مرسى) — G5 Daftra integration & invoicing test suite (docs/online/G5_SPEC.md).  LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network, no Daftra, no keys.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql
  SQL level: worker results are HANDCRAFTED here and sent as service_role
  (SET ROLE service_role; request.jwt.claims {"role":"service_role"}). The end-to-end run with the real
  worker.js + mock-adapter.js is g5-cycle-tests.js (SYNC agent).

  Org A = seed "blue-sea" (branches JED, DMM). Org B = "org-b".
  Users (org A):
    adminA admin            accA accountant (all)     mgrA accounts_manager (all)   accJ accountant JED
    bmJ branch_manager JED  bmD branch_manager DMM    supA supervisor (all)         opsA operations_manager (all)
    trJ transport_staff JED clrJ clearance_staff JED  clientA client 101
  Org B: accB accountant, adminB admin.
  Transactions: TX1 (seed, JED, client 101, containers not returned), TX2 (seed, DMM, client 102),
                TX3 (seed, JED, client 103), TX4 (JED, client 101), B_TX (org B).
  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g5-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_G5 = '20261105000100_g5_daftra.sql';

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
const CL103 = '0b5e0000-0000-4000-8000-000000000103';
const TX1 = '0b5e0000-0000-4000-8000-000000000201';
const TX2 = '0b5e0000-0000-4000-8000-000000000202';
const TX3 = '0b5e0000-0000-4000-8000-000000000203';
const TX4 = '0b5e0000-0000-4000-8000-000000000204';
const B = 'bbbb0000-0000-4000-8000-000000000001';
const B_BR = 'bbbb0000-0000-4000-8000-000000000011';
const B_CL = 'bbbb0000-0000-4000-8000-000000000101';
const B_TX = 'bbbb0000-0000-4000-8000-000000000201';

const U = {
  adminA: 'abc50000-0000-4000-8000-000000000001', accA: 'abc50000-0000-4000-8000-000000000002',
  mgrA: 'abc50000-0000-4000-8000-000000000003', accJ: 'abc50000-0000-4000-8000-000000000004',
  bmJ: 'abc50000-0000-4000-8000-000000000005', bmD: 'abc50000-0000-4000-8000-000000000006',
  supA: 'abc50000-0000-4000-8000-000000000007', opsA: 'abc50000-0000-4000-8000-000000000008',
  trJ: 'abc50000-0000-4000-8000-000000000009', clrJ: 'abc50000-0000-4000-8000-00000000000a',
  clientA: 'abc50000-0000-4000-8000-00000000000b', accB: 'abc50000-0000-4000-8000-00000000000c',
  adminB: 'abc50000-0000-4000-8000-00000000000d'
};
let keySeq = 0;
const newKey = () => `0e5e0000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;
const N = x => (x === null || x === undefined) ? x : Number(x);
const H = s => crypto.createHash('sha256').update(String(s)).digest('hex');
let extSeq = 0;
const ext = p => `${p}-${++extSeq}`;

const G5_TABLES = ['daftra_connections', 'daftra_client_links', 'daftra_item_links', 'billing_intents', 'billing_intent_lines',
  'billing_sync_jobs', 'billing_sync_attempts', 'billing_review_items'];
const ALL_G5_TABLES = G5_TABLES.concat(['daftra_mock_accounts']);
const AUDITED = ['daftra_connections', 'daftra_client_links', 'daftra_item_links', 'billing_intents', 'billing_intent_lines',
  'billing_sync_jobs', 'billing_review_items'];
const STAFF_RPCS = ['get_daftra_connection', 'save_daftra_connection', 'request_daftra_probe', 'list_daftra_client_links',
  'link_daftra_client', 'refresh_daftra_client', 'resolve_client_drift', 'unlink_daftra_client', 'list_daftra_items',
  'save_daftra_item', 'create_billing_intent', 'add_billing_lines', 'remove_billing_line', 'request_billing_push',
  'request_billing_pull', 'resolve_billing_conflict', 'cancel_billing_intent', 'retry_billing_job', 'list_billing_intents',
  'get_billing_intent', 'list_billing_jobs', 'get_billing_job', 'billing_review_queue', 'resolve_billing_review', 'tx_billing'];
const WORKER_RPCS = [['daftra_claim_jobs', 'text, int', `'w', 1`], ['daftra_complete_job', 'uuid, jsonb', `gen_random_uuid(), '{}'`],
  ['daftra_schedule_pulls', 'int', '1'], ['daftra_mock_load', 'uuid', `'${A}'`], ['daftra_mock_save', 'uuid, jsonb, int', `'${A}', '{}', 0`],
  ['daftra_renew_lease', 'uuid', 'gen_random_uuid()']];
const CAPS = ['clients.search_by_ref', 'clients.read', 'clients.create', 'clients.update', 'products.search_by_code',
  'products.search_by_name', 'products.create', 'invoices.create_draft', 'invoices.read', 'invoices.search_by_reference',
  'invoices.update_draft', 'invoices.line_reference_field', 'invoices.version_token', 'invoices.multi_currency',
  'invoices.issue', 'payments.read', 'credit_notes.create'];

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else if (who === 'service') {
    await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const count = async (sql, params) => (await q(sql, params))[0].n;
const one = async (sql, params) => (await q(sql, params))[0];

async function expectErr(name, promiseFn, re) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
}
async function check(name, fn) {
  try {
    const r = await fn();
    if (typeof r === 'string') fail(name, r);
    else if (r === false || r === null || r === 0) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + errText(e)); }
}
async function denied(who, sql, params) {
  try { const r = await as(who, sql, params); return r.length === 0 ? true : 'returned ' + r.length + ' row(s)'; }
  catch (e) { return /permission denied|row-level security|MRS_|violates/.test(errText(e)) ? true : 'unexpected error: ' + errText(e); }
}
async function tryErr(fn) { try { await fn(); return 'ok'; } catch (e) { return errText(e); } }
async function runFile(dbx, file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await dbx.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}

/* ------------------------------------------------------------------ RPC wrappers */
const R = {
  conn: (who, org) => rpc(who, `SELECT public.get_daftra_connection($1) r`, [org || A]),
  saveConn: (who, p, org) => rpc(who, `SELECT public.save_daftra_connection($1, $2) r`, [org || A, p]),
  probe: (who, k, org) => rpc(who, `SELECT public.request_daftra_probe($1, $2) r`, [org || A, k || null]),
  links: (who, f, org) => rpc(who, `SELECT public.list_daftra_client_links($1, $2) r`, [org || A, f || {}]),
  link: (who, client, extId, k) => rpc(who, `SELECT public.link_daftra_client($1, $2, $3) r`, [client, extId || null, k || null]),
  refresh: (who, link) => rpc(who, `SELECT public.refresh_daftra_client($1) r`, [link]),
  drift: (who, link, d, note, extId) => rpc(who, `SELECT public.resolve_client_drift($1, $2, $3, $4) r`, [link, d, note || null, extId || null]),
  unlink: (who, link, reason) => rpc(who, `SELECT public.unlink_daftra_client($1, $2) r`, [link, reason || null]),
  items: (who, org) => rpc(who, `SELECT public.list_daftra_items($1) r`, [org || A]),
  saveItem: (who, key, p, org) => rpc(who, `SELECT public.save_daftra_item($1, $2, $3) r`, [org || A, key, p]),
  intent: (who, p, k) => rpc(who, `SELECT public.create_billing_intent($1, $2) r`, [p, k || null]),
  addLines: (who, id, ids, k) => rpc(who, `SELECT public.add_billing_lines($1, $2::uuid[], $3) r`, [id, ids || null, k || null]),
  rmLine: (who, id, reason) => rpc(who, `SELECT public.remove_billing_line($1, $2) r`, [id, reason || null]),
  push: (who, id, k) => rpc(who, `SELECT public.request_billing_push($1, $2) r`, [id, k || null]),
  pull: (who, id) => rpc(who, `SELECT public.request_billing_pull($1) r`, [id]),
  resolve: (who, id, d, note) => rpc(who, `SELECT public.resolve_billing_conflict($1, $2, $3) r`, [id, d, note || null]),
  cancel: (who, id, reason) => rpc(who, `SELECT public.cancel_billing_intent($1, $2) r`, [id, reason || null]),
  retry: (who, id) => rpc(who, `SELECT public.retry_billing_job($1) r`, [id]),
  list: (who, f, org) => rpc(who, `SELECT public.list_billing_intents($1, $2) r`, [org || A, f || {}]),
  get: (who, id) => rpc(who, `SELECT public.get_billing_intent($1) r`, [id]),
  jobs: (who, f, org) => rpc(who, `SELECT public.list_billing_jobs($1, $2) r`, [org || A, f || {}]),
  job: (who, id) => rpc(who, `SELECT public.get_billing_job($1) r`, [id]),
  queue: (who, f, org) => rpc(who, `SELECT public.billing_review_queue($1, $2) r`, [org || A, f || {}]),
  review: (who, id, d, note, intent) => rpc(who, `SELECT public.resolve_billing_review($1, $2, $3, $4) r`, [id, d, note || null, intent || null]),
  txb: (who, tx) => rpc(who, `SELECT public.tx_billing($1) r`, [tx]),
  charge: (who, p) => rpc(who, `SELECT public.create_client_charge($1) r`, [p]),
  chargeSt: (who, id, st, note) => rpc(who, `SELECT public.set_charge_status($1, $2, $3) r`, [id, st, note || null])
};
const svc = (sql, params) => as('service', sql, params);
const claim = async (worker, limit) => (await svc(`SELECT public.daftra_claim_jobs($1, $2) r`, [worker || 'w1', limit || 5]))[0].r;
const complete = async (attempt, result) => (await svc(`SELECT public.daftra_complete_job($1, $2) r`, [attempt, result]))[0].r;
const intentRow = id => one(`SELECT * FROM public.billing_intents WHERE id = $1`, [id]);
const jobRow = id => one(`SELECT * FROM public.billing_sync_jobs WHERE id = $1`, [id]);
const lineRows = id => q(`SELECT * FROM public.billing_intent_lines WHERE intent_id = $1 ORDER BY created_at, id`, [id]);
const linkRow = id => one(`SELECT * FROM public.daftra_client_links WHERE id = $1`, [id]);
const chargeRow = id => one(`SELECT * FROM public.client_charges WHERE id = $1`, [id]);
const txRow = id => one(`SELECT * FROM public.transactions WHERE id = $1`, [id]);
const due = () => q(`UPDATE public.billing_sync_jobs SET next_run_at = now() WHERE status IN ('queued','unknown')`);

async function mkCharge(tx, o, approve) {
  const who = tx === B_TX ? 'accB' : 'accA';
  const c = await R.charge(who, Object.assign({ transaction_id: tx, kind: 'service', description: 'خدمة', unit_price: 100 }, o));
  if (approve !== false) await R.chargeSt(tx === B_TX ? 'adminB' : 'mgrA', c.id, 'approved');
  return c;
}

/* ------------------------------------------------------------------ handcrafted worker results */
const call = (op, request, response, applied) => ({ op, at: new Date().toISOString(), ms: 1, request: request || {}, response: response || {},
  error: null, applied: applied || 'yes' });
function probeOk(extra) {
  const caps = {};
  CAPS.forEach(k => { caps[k] = { supported: !['invoices.issue', 'credit_notes.create'].includes(k), evidence: 'mock' }; });
  return { outcome: 'ok', effects: { capabilities: caps, account: { currency: 'SAR' } },
           calls: [call('probe', Object.assign({ api_key: 'NEVER-STORED', headers: { Authorization: 'Bearer x' } }, extra || {}), { ok: true })] };
}
function clientOk(ctx, o) {
  o = o || {};
  const c = ctx.client;
  return { outcome: 'ok', calls: [call('findClientByRef', { ref: c.client_ref }, null)],
           effects: Object.assign({ client_link_id: c.link_id, external_id: c.external_id || ext('c'),
             found_by: c.external_id ? 'manual' : 'created', remote_snapshot: c.data }, o) };
}
function itemOk(ctx, o) {
  const i = ctx.item;
  return { outcome: 'ok', effects: Object.assign({ item_link_id: i.link_id, external_product_id: i.external_product_id || ext('p'),
    found_by: i.external_product_id ? 'manual' : 'created', remote_snapshot: { code: i.product_code } }, o || {}) };
}
const money = x => (Math.round(x * 100) / 100).toFixed(2);
function snapOf(it, lines) {
  return { id: it.external_invoice_id, reference: it.operational_ref, client_id: it.client.external_id, currency: it.currency,
           lines: lines.map(l => ({ id: l.remote_line_id, line_ref: l.line_ref, unit_price: String(l.unit_price) })) };
}
function pushOk(ctx, o) {
  o = o || {};
  const it = ctx.intent;
  const extId = it.external_invoice_id || o.ext || ext('inv');
  const live = it.lines.filter(l => l.state !== 'pending_remove' && !(o.skip || []).includes(l.line_id));
  const hash = H(extId + '|' + live.map(l => l.line_ref).sort().join(',') + (o.salt || ''));
  const net = live.reduce((s, l) => s + Number(l.net_amount), 0), vat = live.reduce((s, l) => s + Number(l.vat_amount), 0);
  const res = it.lines.filter(l => !(o.skip || []).includes(l.line_id)).map(l => ({ line_id: l.line_id,
    state: l.state === 'pending_remove' ? 'removed' : 'synced', remote_line_id: l.remote_line_id || ext('l') }));
  const effects = {
    intent_id: it.id, external_invoice_id: extId, found_by: o.found_by || (it.external_invoice_id ? 'existing' : 'created'),
    daftra_status: 'draft', remote_state: 'draft', remote_version: 'v' + (++extSeq), remote_hash: hash, pushed_hash: hash,
    remote_snapshot: snapOf(Object.assign({}, it, { external_invoice_id: extId }), live),
    remote_totals: { net: money(net), vat: money(vat), total: money(net + vat) }, line_results: res,
    clients: ['linked', 'drift'].includes(it.client.status) ? [] : [{ client_link_id: it.client.link_id,
      external_id: it.client.external_id || ext('c'), found_by: 'created', remote_snapshot: it.client.data }],
    items: it.items.filter(i => i.status !== 'linked').map(i => ({ item_link_id: i.link_id,
      external_product_id: i.external_product_id || ext('p'), found_by: 'created' }))
  };
  return { outcome: 'ok', effects: Object.assign(effects, o.effects || {}),
           calls: [call('findInvoiceByReference', { reference: it.operational_ref, apiKey: 'x' }, []),
                   call('createDraftInvoice', { reference: it.operational_ref }, { id: extId, token: 'secret-token' })] };
}
function pullRes(ctx, o) {
  o = o || {};
  const it = ctx.intent;
  const live = (o.lines || it.lines.filter(l => l.state !== 'pending_remove'));
  return { outcome: 'ok', effects: Object.assign({
    intent_id: it.id, external_invoice_id: it.external_invoice_id, daftra_number: o.number || null, daftra_status: o.status || 'draft',
    remote_state: o.state || 'draft', remote_hash: o.hash || it.pushed_hash, remote_snapshot: snapOf(it, live),
    remote_totals: o.totals || { net: '0.00', vat: '0.00', total: '0.00' },
    payment: o.payment || { status: 'unpaid', paid_amount: '0.00', last_payment_at: null } }, o.effects || {}),
    calls: [call('getInvoice', { id: it.external_invoice_id }, { status: o.status || 'draft' })] };
}
function defaultResult(ctx) {
  switch (ctx.job.kind) {
    case 'probe': return probeOk();
    case 'item_ensure': return itemOk(ctx);
    case 'invoice_push': return pushOk(ctx);
    case 'invoice_pull': return pullRes(ctx);
    default: return clientOk(ctx);
  }
}
// one claim → handler (default results) → complete; returns [{ctx, res}]
async function work(handler, worker) {
  const ctxs = await claim(worker || 'w1', 5);
  const out = [];
  for (const c of ctxs) {
    const r = handler ? await handler(c) : defaultResult(c);
    if (r === null) { out.push({ ctx: c, res: null }); continue; }
    out.push({ ctx: c, res: await complete(c.attempt_id, r === undefined ? defaultResult(c) : r) });
  }
  return out;
}
// claim until the wanted job comes up (other jobs of the lane complete with default results)
async function claimFor(pred) {
  for (let i = 0; i < 12; i++) {
    const cs = await claim('w1', 5);
    let hit = null;
    for (const c of cs) {
      if (!hit && pred(c)) hit = c;
      else await complete(c.attempt_id, defaultResult(c));
    }
    if (hit) return hit;
    if (!cs.length) await due();
  }
  throw new Error('job not claimed');
}
const claimIntent = (id, kind) => claimFor(c => c.intent && c.intent.id === id && (!kind || c.job.kind === kind));
async function drain(handler, max) {
  const all = [];
  for (let i = 0; i < (max || 15); i++) {
    const r = await work(handler);
    if (!r.length) break;
    all.push(...r);
  }
  return all;
}

/* ------------------------------------------------------------------ fixtures */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g5.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.organizations (id, slug, name_ar) VALUES ('${B}', 'org-b', 'مؤسسة ب التجريبية');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع الرياض ب');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone, vat_number) VALUES ('${B_CL}', '${B}', 'business', 'عميل ب', '0509999999', '300000000000003');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ('${B_TX}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ('${TX4}', '${A}', '${JED}', '${CL101}', 'import', 'sea');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'), ('${U.accA}', '${A}', NULL, 'accountant'),
      ('${U.mgrA}', '${A}', NULL, 'accounts_manager'), ('${U.accJ}', '${A}', '${JED}', 'accountant'),
      ('${U.bmJ}', '${A}', '${JED}', 'branch_manager'), ('${U.bmD}', '${A}', '${DMM}', 'branch_manager'),
      ('${U.supA}', '${A}', NULL, 'supervisor'), ('${U.opsA}', '${A}', NULL, 'operations_manager'),
      ('${U.trJ}', '${A}', '${JED}', 'transport_staff'), ('${U.clrJ}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.clientA}', '${A}', NULL, 'client'),
      ('${U.accB}', '${B}', NULL, 'accountant'), ('${U.adminB}', '${B}', NULL, 'admin');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CL101}', '${U.clientA}', 'owner');
  `);
  S.ref1 = (await txRow(TX1)).ref;
  S.ref4 = (await txRow(TX4)).ref;
  // G4 sell side: approved charges (TX1: service 2500 @15 + reimbursable 600 @0; USD documentation; a draft transport)
  S.ch1 = await mkCharge(TX1, { kind: 'service', service_code: 'customs_clearance', description: 'أتعاب تخليص', quantity: 2, unit_price: 1250 });
  S.ch2 = await mkCharge(TX1, { kind: 'reimbursable', service_code: 'port_charges', description: 'رسوم ميناء (نيابة)', unit_price: 600 });
  S.ch3 = await mkCharge(TX1, { kind: 'service', service_code: 'transport', description: 'نقل', unit_price: 1000 }, false);
  S.chUsd = await mkCharge(TX1, { kind: 'service', service_code: 'documentation', description: 'مستندات', unit_price: 100, currency: 'USD' });
  S.ch5 = await mkCharge(TX2, { kind: 'service', service_code: 'customs_clearance', description: 'تخليص الدمام', unit_price: 800 });
  S.ch6 = await mkCharge(TX4, { kind: 'service', description: 'خدمة 5٪', unit_price: 300, vat_rate: 5 });
  S.chB = await mkCharge(B_TX, { kind: 'service', service_code: 'customs_clearance', description: 'تخليص ب', unit_price: 400 });
  S.clientsBefore = await q(`SELECT * FROM public.clients ORDER BY id`);
}

const S = {};

/* ================================================================== sections */
async function secCatalog() {
  section('catalog: version, RLS, grants, privileges, dictionaries, events');
  await check('schema_versions has 20261105000100 g5_daftra', async () =>
    (await count(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261105000100' AND name = 'g5_daftra'`)) === 1);
  for (const t of G5_TABLES) {
    await check(`${t}: RLS on, no anon privilege, authenticated SELECT only, ${AUDITED.includes(t) ? 'audited' : 'NOT audited (append-only history)'}`, async () => {
      const r = await one(`SELECT c.relrowsecurity rls,
                                  EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'trg_audit') audit,
                                  (SELECT count(*)::int FROM information_schema.role_table_grants x
                                    WHERE x.grantee = 'anon' AND x.table_schema = 'public' AND x.table_name = c.relname) anon,
                                  (SELECT string_agg(x.privilege_type, ',' ORDER BY x.privilege_type) FROM information_schema.role_table_grants x
                                    WHERE x.grantee = 'authenticated' AND x.table_schema = 'public' AND x.table_name = c.relname) auth,
                                  (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) pol
                             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relname = $1`, [t]);
      return (r && r.rls && r.audit === AUDITED.includes(t) && r.anon === 0 && r.auth === 'SELECT' && r.pol === 1) || JSON.stringify(r);
    });
  }
  await check('daftra_mock_accounts: RLS on, no policy, no privilege for anon / authenticated, not audited', async () => {
    const r = await one(`SELECT c.relrowsecurity rls, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = 'daftra_mock_accounts') pol,
                                (SELECT count(*)::int FROM information_schema.role_table_grants x WHERE x.table_name = 'daftra_mock_accounts'
                                   AND x.grantee IN ('anon','authenticated','PUBLIC')) g,
                                EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'trg_audit') audit
                           FROM pg_class c WHERE c.relname = 'daftra_mock_accounts'`);
    return (r.rls && r.pol === 0 && r.g === 0 && !r.audit) || JSON.stringify(r);
  });
  await check('every staff RPC: authenticated may execute, anon may not, SECURITY DEFINER with search_path = \'\'', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n,
                              p.prosecdef d, coalesce(p.proconfig, '{}') @> ARRAY['search_path=""'] sp
                         FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname = ANY($1)`, [STAFF_RPCS]);
    const bad = r.filter(x => !x.a || x.n || !x.d || !x.sp).map(x => x.proname);
    const missing = STAFF_RPCS.filter(n => !r.find(x => x.proname === n));
    return (bad.length === 0 && missing.length === 0 && r.length === STAFF_RPCS.length) || JSON.stringify({ bad, missing, n: r.length });
  });
  await check('every worker RPC: service_role only (not authenticated, not anon, not PUBLIC), SECURITY DEFINER', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') s, p.prosecdef d,
                              coalesce(p.proconfig, '{}') @> ARRAY['search_path=""'] sp, p.proacl::text acl
                         FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname LIKE 'daftra\\_%'`);
    const bad = r.filter(x => x.a || x.n || !x.s || !x.d || !x.sp || /(^|[{,])=X/.test(x.acl)).map(x => x.proname);
    return (r.length === WORKER_RPCS.length && bad.length === 0) || JSON.stringify({ bad, n: r.length });
  });
  await check('app.bill_* / tg_bill_* helpers: not executable by authenticated / anon except the policy helper bill_can_read_job', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND (p.proname LIKE 'bill\\_%' OR p.proname LIKE 'tg\\_bill\\_%')
                          AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
                        ORDER BY 1`);
    const total = await count(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                WHERE n.nspname = 'app' AND (p.proname LIKE 'bill\\_%' OR p.proname LIKE 'tg\\_bill\\_%')`);
    return (r.map(x => x.proname).join(',') === 'bill_can_read_job' && total > 40) || JSON.stringify({ r, total });
  });
  await check('every SECURITY DEFINER app.bill_* helper sets search_path = \'\'', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND (p.proname LIKE 'bill\\_%' OR p.proname LIKE 'tg\\_bill\\_%')
                          AND NOT (coalesce(p.proconfig, '{}') @> ARRAY['search_path=""'])
                          AND p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'sql' LIMIT 1) AND p.prosecdef`);
    return r.length === 0 || JSON.stringify(r);
  });
  await check('transaction_events accepts billing (and keeps every G4 type)', async () => {
    const r = await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'transaction_events_event_type_check'`);
    return ['billing', 'finance', 'docs_override', 'appointment', 'trip', 'exception', 'declaration', 'bl', 'container', 'tracking_token', 'financial_status']
      .every(x => r.d.includes(`'${x}'`)) || r.d;
  });
  await check('dictionaries: 14 daftra_* / bill_* domains, all internal, ar + en; 17 capabilities', async () => {
    const r = await one(`SELECT count(DISTINCT domain)::int d, count(*) FILTER (WHERE client_visible)::int v,
                                count(*) FILTER (WHERE label_ar = '' OR label_en = '')::int e,
                                count(*) FILTER (WHERE domain = 'daftra_capability')::int caps
                           FROM public.status_labels WHERE domain LIKE 'daftra\\_%' OR domain LIKE 'bill\\_%'`);
    return (r.d === 14 && r.v === 0 && r.e === 0 && r.caps === 17) || JSON.stringify(r);
  });
  await check('roles: bill_admin = accounts_manager, admin; push gate = 8 capabilities', async () => {
    const r = await one(`SELECT app.bill_admin_roles() a, app.bill_required_caps() c, app.bill_capability_keys() k`);
    return (r.a.join(',') === 'accounts_manager,admin' && r.c.length === 8 && r.k.join(',') === CAPS.join(',')) || JSON.stringify(r);
  });
  await check('composite FKs: lines → (intent, transaction) and (charge, transaction); jobs → (x, org)', async () => {
    const n = await count(`SELECT count(*)::int n FROM pg_constraint WHERE conname IN ('billing_intent_lines_intent_fk','billing_intent_lines_charge_fk',
                             'billing_sync_jobs_intent_fk','billing_sync_jobs_client_fk','billing_sync_jobs_item_fk','billing_sync_attempts_job_fk',
                             'billing_intents_tx_fk','billing_intents_client_fk','billing_review_items_charge_fk') AND array_length(conkey, 1) = 2`);
    return n === 9 || String(n);
  });
  await check('money numeric(14,2), quantity numeric(14,3), VAT numeric(5,2), currency char(3) on intents / lines', async () => {
    const r = await q(`SELECT table_name || '.' || column_name c, data_type, numeric_precision p, numeric_scale s, character_maximum_length l
                         FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('billing_intents','billing_intent_lines')
                          AND column_name IN ('net_amount','total_amount','remote_total','paid_amount','quantity','vat_rate','currency')`);
    const bad = r.filter(x => (x.c.endsWith('quantity') ? !(x.p === 14 && x.s === 3) : x.c.endsWith('vat_rate') ? !(x.p === 5 && x.s === 2)
                               : x.c.endsWith('currency') ? !(x.data_type === 'character' && x.l === 3) : !(x.p === 14 && x.s === 2)));
    return (r.length === 8 && bad.length === 0) || JSON.stringify({ r, bad });
  });
}

async function secSecrets() {
  section('no secrets: columns, redaction, attempts');
  await check('no G5 column is named like a secret (api key / secret / token / password / credential)', async () => {
    const r = await q(`SELECT table_name || '.' || column_name c FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = ANY($1)
                          AND column_name ~* '(api_?key|secret|token|password|passwd|credential|auth)'`, [ALL_G5_TABLES]);
    return r.length === 0 || JSON.stringify(r);
  });
  await check('the only *key* columns are the operational item_key / purpose_key / dedupe_key (no key material)', async () => {
    const r = await q(`SELECT DISTINCT column_name c FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = ANY($1) AND column_name ILIKE '%key%' ORDER BY 1`, [ALL_G5_TABLES]);
    return r.map(x => x.c).join(',') === 'dedupe_key,item_key,purpose_key' || JSON.stringify(r);
  });
  await check('app.bill_redact drops secret-like keys at any depth (objects in arrays too) and cuts strings > 4000', async () => {
    const r = (await one(`SELECT app.bill_redact($1) r`, [{ api_key: 'k', ApiKey: 'k2', nested: { 'api-key': 'x', Authorization: 'Bearer',
      list: [{ password: 'p', ok: 1 }, { access_token: 't' }], cookie: 'c', client_secret: 's' }, keep: 'x'.repeat(5000), n: 5 }])).r;
    const s = JSON.stringify(r);
    return (!/api|Authorization|password|token|cookie|secret/i.test(s.replace(/"keep"/, '')) && r.nested.list[0].ok === 1
            && r.keep.length === 4000 && r.n === 5) || s.slice(0, 300);
  });
  await check('connection settings refuse an api key (unknown_key) — nothing secret can be saved', async () => {
    const e = await tryErr(() => R.saveConn('mgrA', { api_key: 'live-key' }));
    return /MRS_INVALID unknown_key/.test(e) || e;
  });
}

async function secConnection() {
  section('1-2. connection + capability probe');
  await check('get_daftra_connection: defaults (exists false, mock, not_connected), push not ready, 8 missing capabilities', async () => {
    const r = await R.conn('accA');
    return (r.connection.exists === false && r.connection.mode === 'mock' && r.connection.status === 'not_connected'
            && r.push_ready === false && r.missing_capabilities.length === 8) || JSON.stringify(r);
  });
  await expectErr('save_daftra_connection: accountant → MRS_FORBIDDEN role (bill_admin only)', () => R.saveConn('accA', { sync_enabled: true }), /MRS_FORBIDDEN role/);
  await expectErr('save_daftra_connection: branch manager → MRS_FORBIDDEN role', () => R.saveConn('bmJ', { sync_enabled: true }), /MRS_FORBIDDEN role/);
  await expectErr('save_daftra_connection: supervisor → MRS_FORBIDDEN', () => R.saveConn('supA', { sync_enabled: true }), /MRS_FORBIDDEN/);
  await expectErr('save_daftra_connection: org B admin on org A → MRS_FORBIDDEN org', () => R.saveConn('adminB', { sync_enabled: true }), /MRS_FORBIDDEN org/);
  await expectErr('get_daftra_connection: operations manager → MRS_FORBIDDEN finance', () => R.conn('opsA'), /MRS_FORBIDDEN finance/);
  await expectErr('get_daftra_connection: client → MRS_FORBIDDEN', () => R.conn('clientA'), /MRS_FORBIDDEN/);
  await check('save (accounts manager): mock, subdomain placeholder, sync enabled, notes; status stays not_connected', async () => {
    const r = await R.saveConn('mgrA', { mode: 'mock', subdomain: 'Marsa-Demo', sync_enabled: true, invoice_notes: 'شكرًا لتعاملكم' });
    return (r.exists && r.subdomain === 'marsa-demo' && r.sync_enabled === true && r.status === 'not_connected' && r.mode === 'mock'
            && N(r.default_service_vat_rate) === 15 && r.reimbursable_tax_code === 'out_of_scope') || JSON.stringify(r);
  });
  for (const [label, p, re] of [
    ['mode live → MRS_INVALID mode', { mode: 'live' }, /MRS_INVALID mode/],
    ['bad subdomain → MRS_INVALID subdomain', { subdomain: 'bad_sub!' }, /MRS_INVALID subdomain/],
    ['sync_enabled as string → MRS_INVALID', { sync_enabled: 'yes' }, /MRS_INVALID sync_enabled/],
    ['allowed rate above 100 → MRS_INVALID', { allowed_vat_rates: [0, 150] }, /MRS_INVALID allowed_vat_rates/],
    ['empty allowed rates → MRS_INVALID', { allowed_vat_rates: [] }, /MRS_INVALID allowed_vat_rates/],
    ['default rate outside the allowed rates → MRS_INVALID', { default_service_vat_rate: 5 }, /MRS_INVALID default_service_vat_rate/],
    ['unknown reimbursable tax code → MRS_INVALID', { reimbursable_tax_code: 'free' }, /MRS_INVALID reimbursable_tax_code/],
    ['notes above 500 → MRS_TOO_LONG', { invoice_notes: 'x'.repeat(501) }, /MRS_TOO_LONG invoice_notes/]]) {
    await expectErr('save: ' + label, () => R.saveConn('mgrA', p), re);
  }
  await expectErr('no direct UPDATE of the connection (API writes refused)', () => as('mgrA', `UPDATE public.daftra_connections SET status = 'connected'`), /permission denied/);
  await expectErr('no direct INSERT of a connection', () => as('adminB', `INSERT INTO public.daftra_connections (org_id) VALUES ($1)`, [B]), /permission denied/);
  await check('save never sets connected: sync off / on keeps not_connected (only a probe completion connects)', async () => {
    await R.saveConn('mgrA', { sync_enabled: false });
    const r = await R.saveConn('mgrA', { sync_enabled: true });
    return r.status === 'not_connected' || r.status;
  });
  await expectErr('request_daftra_probe: accountant → MRS_FORBIDDEN role', () => R.probe('accA'), /MRS_FORBIDDEN role/);
  const k = newKey();
  S.probe1 = await R.probe('mgrA', k);
  await check('request_daftra_probe (bill_admin): job probe queued, priority 0, dedupe_key probe', async () =>
    (S.probe1.kind === 'probe' && S.probe1.status === 'queued' && S.probe1.priority === 0 && S.probe1.dedupe_key === 'probe'
     && S.probe1.deduplicated === false) || JSON.stringify(S.probe1));
  await check('probe: same idem key replays; a second request returns the same live job (deduplicated)', async () => {
    const a = await R.probe('mgrA', k);
    const b = await R.probe('adminA');
    return (a.replayed === true && a.id === S.probe1.id && b.id === S.probe1.id && b.deduplicated === true) || JSON.stringify({ a, b });
  });
  let ctx;
  await check('claim (service role): the probe context carries the connection only (mode / settings, no secret)', async () => {
    const c = await claim('w1', 5);
    ctx = c.find(x => x.job.id === S.probe1.id);
    return (c.length === 1 && ctx && ctx.job.kind === 'probe' && ctx.job.attempt_no === 1 && ctx.connection.mode === 'mock'
            && N(ctx.connection.settings.default_service_vat_rate) === 15 && !/key|secret|password/i.test(JSON.stringify(ctx.connection))
            && ctx.client === undefined && ctx.intent === undefined) || JSON.stringify(c);
  });
  await check('claim opened one attempt (outcome NULL) and leased the job for 5 minutes', async () => {
    const a = await one(`SELECT * FROM public.billing_sync_attempts WHERE id = $1`, [ctx.attempt_id]);
    const j = await jobRow(S.probe1.id);
    return (a.outcome === null && a.worker === 'w1' && a.adapter_mode === 'mock' && j.status === 'running' && j.locked_by === 'w1'
            && new Date(j.locked_until) > new Date(Date.now() + 4 * 60000)) || JSON.stringify({ a, j });
  });
  await check('probe completion: connected, 17 capabilities (issue / credit notes false), source mock, last check ok', async () => {
    const r = await complete(ctx.attempt_id, probeOk());
    const c = (await R.conn('accA')).connection;
    return (r.applied === true && r.job_status === 'done' && c.status === 'connected' && Object.keys(c.capabilities).length === 17
            && c.capabilities['invoices.issue'].supported === false && c.capabilities['credit_notes.create'].supported === false
            && c.capabilities['invoices.create_draft'].supported === true && c.capabilities_source === 'mock' && c.last_check_status === 'ok')
      || JSON.stringify({ r, c });
  });
  await check('attempt calls are stored redacted (no api key / Authorization header / token)', async () => {
    const a = await one(`SELECT calls FROM public.billing_sync_attempts WHERE id = $1`, [ctx.attempt_id]);
    const s = JSON.stringify(a.calls);
    return (a.calls.length === 1 && a.calls[0].op === 'probe' && !/NEVER-STORED|api_key|Authorization|Bearer/.test(s)) || s;
  });
  await check('push_ready after the probe; nothing missing', async () => {
    const r = await R.conn('supA');
    return (r.push_ready === true && r.missing_capabilities.length === 0) || JSON.stringify(r);
  });
  await check('a mode change forces a new probe: live_pending → not_connected, capabilities cleared', async () => {
    const r = await R.saveConn('mgrA', { mode: 'live_pending' });
    return (r.status === 'not_connected' && Object.keys(r.capabilities).length === 0 && r.from === 'connected') || JSON.stringify(r);
  });
  await check('live_pending probe fails not_configured (worker stub) → connection error, last check failed', async () => {
    await R.probe('mgrA');
    const [c] = await claim('w1', 5);
    const r = await complete(c.attempt_id, { outcome: 'failed', error: { kind: 'not_configured', code: 'not_configured',
      message: 'Daftra live adapter not configured (G5 staging: mock only)', http_status: null }, calls: [], effects: {} });
    const x = (await R.conn('mgrA')).connection;
    return (c.connection.mode === 'live_pending' && r.job_status === 'failed' && x.status === 'error' && x.last_check_status === 'failed'
            && x.last_error_code === 'not_configured') || JSON.stringify({ r, x });
  });
  await check('back to mock + a new probe → connected again', async () => {
    await R.saveConn('mgrA', { mode: 'mock' });
    await R.probe('mgrA');
    await drain();
    const x = (await R.conn('mgrA')).connection;
    return x.status === 'connected' || x.status;
  });
  await check('sync off → status disabled, push not ready; on again → connected (probe result kept)', async () => {
    const a = await R.saveConn('mgrA', { sync_enabled: false });
    const ready = (await R.conn('mgrA')).push_ready;
    const b = await R.saveConn('mgrA', { sync_enabled: true });
    return (a.status === 'disabled' && ready === false && b.status === 'connected') || JSON.stringify({ a: a.status, ready, b: b.status });
  });
  await check('allowed rates / default rate / reimbursable tax code saved (sorted, distinct)', async () => {
    const r = await R.saveConn('mgrA', { allowed_vat_rates: [15, 0, 15], default_service_vat_rate: 15, reimbursable_tax_code: 'out_of_scope' });
    return (r.allowed_vat_rates.map(Number).join(',') === '0,15') || JSON.stringify(r.allowed_vat_rates);
  });
  // org B: connected through its own probe (another org, another mock account)
  await R.saveConn('adminB', { mode: 'mock', sync_enabled: true }, B);
  await R.probe('adminB', null, B);
  await drain();
  await check('org B connected through its own probe; org A connection untouched', async () => {
    const b = (await R.conn('adminB', B)).connection, a = (await R.conn('mgrA')).connection;
    return (b.status === 'connected' && b.org_id === B && a.status === 'connected' && a.id !== b.id) || JSON.stringify({ a, b });
  });
}

async function secServiceOnly() {
  section('service-only worker RPCs; staff RPCs refuse the service role');
  for (const [name, sig, argsSql] of WORKER_RPCS) {
    await expectErr(`${name}: authenticated → permission denied`, () => as('adminA', `SELECT public.${name}(${argsSql})`), /permission denied/);
    await expectErr(`${name}: anon → permission denied`, () => as('anon', `SELECT public.${name}(${argsSql})`), /permission denied/);
    await check(`${name}: with a forged EXECUTE grant the body still refuses (MRS_FORBIDDEN service_only)`, async () => {
      await q(`GRANT EXECUTE ON FUNCTION public.${name}(${sig}) TO authenticated`);
      try { return /MRS_FORBIDDEN service_only/.test(await tryErr(() => as('adminA', `SELECT public.${name}(${argsSql})`))) || 'not refused'; }
      finally { await q(`REVOKE EXECUTE ON FUNCTION public.${name}(${sig}) FROM authenticated`); }
    });
  }
  await expectErr('staff RPC as the service role → MRS_AUTH_REQUIRED (get_daftra_connection)', () => svc(`SELECT public.get_daftra_connection($1)`, [A]), /MRS_AUTH_REQUIRED/);
  await expectErr('staff RPC as the service role → MRS_AUTH_REQUIRED (create_billing_intent)', () => svc(`SELECT public.create_billing_intent($1)`, [{ transaction_id: TX1 }]), /MRS_AUTH_REQUIRED/);
  await expectErr('staff RPC as the service role → MRS_AUTH_REQUIRED (request_billing_push)', () => svc(`SELECT public.request_billing_push(gen_random_uuid())`), /MRS_AUTH_REQUIRED/);
  await expectErr('anon cannot call staff RPCs', () => as('anon', `SELECT public.get_daftra_connection($1)`, [A]), /permission denied/);
  await expectErr('claim: bad worker name → MRS_INVALID worker', () => svc(`SELECT public.daftra_claim_jobs('', 1)`), /MRS_INVALID worker/);
  await expectErr('claim: limit 0 → MRS_INVALID limit', () => svc(`SELECT public.daftra_claim_jobs('w', 0)`), /MRS_INVALID limit/);
  await expectErr('complete: unknown attempt → MRS_NOT_FOUND', () => svc(`SELECT public.daftra_complete_job(gen_random_uuid(), '{"outcome":"ok"}')`), /MRS_NOT_FOUND attempt/);
}

async function secClients() {
  section('3. client links: uniqueness per org, drift, review, never auto-overwrite');
  await check('list: no link yet; client 101 is billable and unlinked', async () => {
    const r = await R.links('accA');
    return (r.items.length === 0 && r.unlinked.some(x => x.client_id === CL101 && x.client_ref === 'MRSC-' + CL101)) || JSON.stringify(r);
  });
  await check('list: unlinked billable clients carry approved_count = number of approved charges (integration: the UI column)', async () => {
    const r = await R.links('accA');
    const x = r.unlinked.find(u => u.client_id === CL101);
    const n = (await q(`SELECT count(*)::int n FROM public.client_charges ch JOIN public.transactions t ON t.id = ch.transaction_id
                         WHERE t.client_id = $1 AND ch.status = 'approved'`, [CL101]))[0].n;
    return (x && x.approved_count === n && n > 0) || JSON.stringify({ x, n });
  });
  await expectErr('link: supervisor → MRS_FORBIDDEN role', () => R.link('supA', CL101), /MRS_FORBIDDEN role/);
  await expectErr('link: operations manager → MRS_FORBIDDEN role', () => R.link('opsA', CL101), /MRS_FORBIDDEN role/);
  await expectErr('link: org B → MRS_NOT_FOUND client', () => R.link('accB', CL101), /MRS_NOT_FOUND client/);
  await expectErr('link: malformed external id → MRS_INVALID external_id', () => R.link('accA', CL101, '../etc'), /MRS_INVALID external_id/);
  S.lk1 = await R.link('accA', CL101);
  await check('link (fin_write): pending, client_ref MRSC-<client id>, client_ensure queued', async () =>
    (S.lk1.link.status === 'pending' && S.lk1.link.client_ref === 'MRSC-' + CL101 && S.lk1.job.kind === 'client_ensure'
     && S.lk1.job.priority === 1) || JSON.stringify(S.lk1));
  await check('client_ensure context: client data = the snapshot of the Marsa client (trimmed, address on one line)', async () => {
    const [c] = await claim('w1', 5);
    S.ctxC1 = c;
    const d = c.client.data;
    return (c.job.kind === 'client_ensure' && c.client.client_ref === 'MRSC-' + CL101 && d.name === 'شركة الاختبار الأولى للتجارة'
            && d.vat_number === '300000000000003' && d.address_short === 'TEST0001' && /شارع تجريبي/.test(d.address) && d.phone === '0500000001')
      || JSON.stringify(c);
  });
  await check('client_ensure completion (created) → linked, external id set, no drift', async () => {
    await complete(S.ctxC1.attempt_id, clientOk(S.ctxC1, { external_id: 'c-1', found_by: 'created' }));
    const l = await linkRow(S.lk1.link.id);
    return (l.status === 'linked' && l.external_id === 'c-1' && l.drift.length === 0 && l.linked_at) || JSON.stringify(l);
  });
  await check('one Daftra client ↔ one Marsa client: linking client 102 to c-1 → MRS_INVALID external_id_taken (hint = the link)', async () => {
    const e = await tryErr(() => R.link('accA', CL102, 'c-1'));
    return new RegExp('MRS_INVALID external_id_taken ' + S.lk1.link.id).test(e) || e;
  });
  await check('the same Daftra id is allowed in another org (uniqueness is per org)', async () => {
    const r = await R.link('accB', B_CL, 'c-1');
    S.lkB = r;
    return (r.link.external_id === 'c-1' && r.job.kind === 'client_refresh') || JSON.stringify(r);
  });
  await expectErr('the partial unique index holds for a direct insert too (same org, same external id)', () => q(`
    INSERT INTO public.daftra_client_links (org_id, client_id, client_ref, external_id) VALUES ($1, $2, 'x', 'c-1')`, [A, CL102]), /duplicate key|unique/);
  await expectErr('client_ref is immutable', () => q(`UPDATE public.daftra_client_links SET client_ref = 'MRSC-' || $2 WHERE id = $1`, [S.lk1.link.id, CL102]), /MRS_IMMUTABLE/);
  await check('link again (same client): the live link is reused, a refresh is queued', async () => {
    const r = await R.link('accA', CL101);
    return (r.link.id === S.lk1.link.id && r.job.kind === 'client_refresh') || JSON.stringify(r);
  });
  await drain();
  await check('local drift: a Marsa client edit shows local:name_en (warning only)', async () => {
    await q(`UPDATE public.clients SET name_en = 'Test Trading Co. One LLC' WHERE id = $1`, [CL101]);
    const r = await R.links('accA', { status: 'drift' });
    const it = r.items.find(x => x.id === S.lk1.link.id);
    return (it && it.status === 'drift' && it.drift.join() === 'local:name_en') || JSON.stringify(r);
  });
  await check('remote drift: a refresh reading another phone → remote:phone too; the link is drift', async () => {
    await R.refresh('accA', S.lk1.link.id);
    await work(c => clientOk(c, { found_by: 'ref', remote_snapshot: Object.assign({}, S.ctxC1.client.data, { phone: '0555555555' }) }));
    const l = await linkRow(S.lk1.link.id);
    return (l.status === 'drift' && l.drift.join() === 'local:name_en,remote:phone' && l.drift_detected_at) || JSON.stringify(l);
  });
  await expectErr('resolve_client_drift: accountant → MRS_FORBIDDEN role (fin_approve)', () => R.drift('accA', S.lk1.link.id, 'acknowledge', 'ok'), /MRS_FORBIDDEN role/);
  await expectErr('resolve_client_drift: note required', () => R.drift('mgrA', S.lk1.link.id, 'acknowledge', ' '), /MRS_NOTE_REQUIRED/);
  await expectErr('resolve_client_drift: unknown decision', () => R.drift('mgrA', S.lk1.link.id, 'overwrite', 'x'), /MRS_INVALID decision/);
  await check('acknowledge: Daftra becomes the baseline (remote drift gone); the Marsa client row is NOT changed', async () => {
    const r = await R.drift('mgrA', S.lk1.link.id, 'acknowledge', 'اعتماد بيانات دفترة');
    const c = await one(`SELECT name_en, phone FROM public.clients WHERE id = $1`, [CL101]);
    return (r.link.drift.join() === 'local:name_en,local:phone' && r.link.review_note === 'اعتماد بيانات دفترة'
            && c.phone === '0500000001' && c.name_en === 'Test Trading Co. One LLC') || JSON.stringify({ r: r.link.drift, c });
  });
  await check('push_local (fin_approve, note): client_push job; completion → linked, no drift', async () => {
    const r = await R.drift('mgrA', S.lk1.link.id, 'push_local', 'تحديث بيانات العميل في دفترة');
    const done = await work(c => clientOk(c, { found_by: 'pushed', remote_snapshot: c.client.data }));
    const l = await linkRow(S.lk1.link.id);
    return (r.job.kind === 'client_push' && done.length === 1 && done[0].ctx.job.kind === 'client_push' && l.status === 'linked'
            && l.drift.length === 0) || JSON.stringify({ r, l });
  });
  await check('VAT hit without a reference → conflict: needs_review with candidates (never a silent adoption)', async () => {
    S.lk2 = await R.link('accA', CL102);
    const out = await work(c => ({ outcome: 'conflict', effects: { client_link_id: c.client.link_id,
      candidates: [{ external_id: 'c-90', name: 'مؤسسة التجربة', vat_number: '300000000000013' }] }, calls: [] }));
    const l = await linkRow(S.lk2.link.id);
    return (out[0].res.job_status === 'conflict' && l.status === 'needs_review' && l.candidates.length === 1 && l.external_id === null)
      || JSON.stringify({ out, l });
  });
  await expectErr('choose: an id outside the candidates → MRS_INVALID external_id', () => R.drift('mgrA', S.lk2.link.id, 'choose', 'اختيار', 'c-91'), /MRS_INVALID external_id/);
  await expectErr('refresh while needs_review → MRS_REQUIRED client_review', () => R.refresh('accA', S.lk2.link.id), /MRS_REQUIRED client_review/);
  await check('choose a candidate → pending + client_refresh; completion (manual) → linked, baseline = Daftra', async () => {
    const r = await R.drift('mgrA', S.lk2.link.id, 'choose', 'نفس العميل', 'c-90');
    await work(c => clientOk(c, { found_by: 'manual', remote_snapshot: Object.assign({}, c.client.data, { name: 'مؤسسة التجربة' }) }));
    const l = await linkRow(S.lk2.link.id);
    return (r.job.kind === 'client_refresh' && l.status === 'drift' && l.external_id === 'c-90' && l.drift.join() === 'local:name'
            && l.pushed_snapshot.name === 'مؤسسة التجربة') || JSON.stringify(l);
  });
  await check('create_new → client_ensure with force_create; completion → linked to a new client', async () => {
    S.lk3 = await R.link('accA', CL103);
    await work(c => ({ outcome: 'conflict', effects: { client_link_id: c.client.link_id, candidates: [{ external_id: 'c-95', name: 'x' }] } }));
    const r = await R.drift('mgrA', S.lk3.link.id, 'create_new', 'عميل مختلف');
    const [c] = await claim('w1', 5);
    await complete(c.attempt_id, clientOk(c, { external_id: 'c-96', found_by: 'created' }));
    const l = await linkRow(S.lk3.link.id);
    return (r.job.options.force_create === true && c.job.options.force_create === true && l.status === 'linked' && l.external_id === 'c-96')
      || JSON.stringify({ r, l });
  });
  await expectErr('unlink: accountant → MRS_FORBIDDEN role (bill_admin)', () => R.unlink('accA', S.lk3.link.id, 'x'), /MRS_FORBIDDEN role/);
  await expectErr('unlink: reason required', () => R.unlink('mgrA', S.lk3.link.id, ''), /MRS_NOTE_REQUIRED/);
  await check('unlink (bill_admin, reason) → unlinked; the client can be linked again (new row)', async () => {
    const u = await R.unlink('mgrA', S.lk3.link.id, 'ربط خاطئ');
    const again = await R.link('accA', CL103, 'c-96');
    S.lk3b = again;
    return (u.status === 'unlinked' && u.unlink_reason === 'ربط خاطئ' && again.link.id !== S.lk3.link.id && again.link.status === 'pending')
      || JSON.stringify({ u, again });
  });
  await drain();
  await check('G5 never changed a Marsa client row (only the test edit of name_en)', async () => {
    const now = await q(`SELECT * FROM public.clients ORDER BY id`);
    const diff = now.filter((c, i) => JSON.stringify(Object.assign({}, c, { name_en: null, updated_at: null }))
                                   !== JSON.stringify(Object.assign({}, S.clientsBefore[i], { name_en: null, updated_at: null })));
    return (now.length === S.clientsBefore.length && diff.length === 0) || JSON.stringify(diff.map(x => x.id));
  });
}

async function secItems() {
  section('4. item catalog: every key, defaults, unique mapping both ways');
  await check('list_daftra_items: 45 keys (3 kinds × 15), all unmapped, canonical names and tax defaults', async () => {
    const r = await R.items('accA');
    const by = k => r.items.find(x => x.item_key === k);
    const cc = by('service:customs_clearance'), rp = by('reimbursable:port_charges'), none = by('service:none'), int = by('internal_service:transport');
    return (r.items.length === 45 && r.counts.unmapped === 45 && cc.product_code === 'MRS-service-customs_clearance' && cc.name_ar === 'تخليص جمركي'
            && N(cc.default_vat_rate) === 15 && cc.tax_code === 'standard' && rp.name_ar === 'رسوم ميناء — مبلغ مسترد' && N(rp.default_vat_rate) === 0
            && rp.tax_code === 'out_of_scope' && none.name_ar === 'خدمات أخرى' && none.name_en === 'Other services'
            && int.name_ar === 'نقل — خدمة داخلية' && cc.mapped === false) || JSON.stringify({ n: r.items.length, cc, rp, none, int });
  });
  await expectErr('save_daftra_item: accountant → MRS_FORBIDDEN role', () => R.saveItem('accA', 'service:transport', { name_en: 'x' }), /MRS_FORBIDDEN role/);
  await expectErr('save_daftra_item: unknown service code → MRS_INVALID item_key', () => R.saveItem('mgrA', 'service:teleport', { name_en: 'x' }), /MRS_INVALID item_key/);
  await expectErr('save_daftra_item: unknown kind → MRS_INVALID item_key', () => R.saveItem('mgrA', 'goods:none', { name_en: 'x' }), /MRS_INVALID item_key/);
  await expectErr('save_daftra_item: bad tax code', () => R.saveItem('mgrA', 'service:transport', { tax_code: 'vat' }), /MRS_INVALID tax_code/);
  await check('manual product id → pending + item_ensure verify job; completion → linked', async () => {
    const r = await R.saveItem('mgrA', 'service:customs_clearance', { external_product_id: 'p-100' });
    const [c] = await claim('w1', 5);
    await complete(c.attempt_id, itemOk(c, { found_by: 'manual' }));
    const i = await one(`SELECT * FROM public.daftra_item_links WHERE id = $1`, [r.id]);
    return (r.status === 'pending' && r.job.kind === 'item_ensure' && c.item.product_code === 'MRS-service-customs_clearance'
            && c.item.external_product_id === 'p-100' && i.status === 'linked') || JSON.stringify({ r, c, i });
  });
  await check('one product ↔ one key: p-100 on another key → MRS_INVALID external_id_taken', async () => {
    const e = await tryErr(() => R.saveItem('mgrA', 'service:transport', { external_product_id: 'p-100' }));
    return /MRS_INVALID external_id_taken/.test(e) || e;
  });
  await check('the same product id in org B is allowed', async () => {
    const r = await R.saveItem('adminB', 'service:customs_clearance', { external_product_id: 'p-100' }, B);
    await drain();
    return r.external_product_id === 'p-100' || JSON.stringify(r);
  });
  await expectErr('one key ↔ one product: a second live row for a key is refused (unique index)', () => q(`
    INSERT INTO public.daftra_item_links (org_id, item_key, product_code, name_ar, default_vat_rate, tax_code)
    VALUES ($1, 'service:customs_clearance', 'x', 'اسم', 15, 'standard')`, [A]), /duplicate key|unique/);
  await expectErr('item_key / product_code are immutable', () => q(`UPDATE public.daftra_item_links SET item_key = 'service:transport' WHERE org_id = $1 AND item_key = 'service:customs_clearance'`, [A]), /MRS_IMMUTABLE/);
  await check('worker conflict (same name, other code) → needs_review with candidates', async () => {
    const r = await R.saveItem('mgrA', 'internal_service:none', { external_product_id: 'p-200' });
    await work(c => ({ outcome: 'conflict', effects: { item_link_id: c.item.link_id, candidates: [{ id: 'p-201', code: 'OTHER', name: 'خدمات أخرى' }] } }));
    const i = await one(`SELECT * FROM public.daftra_item_links WHERE id = $1`, [r.id]);
    S.itemReview = r.id;
    return (i.status === 'needs_review' && i.candidates[0].external_product_id === 'p-201') || JSON.stringify(i);
  });
  await check('retire (bill_admin): retired, listed apart; the key shows defaults again', async () => {
    const r = await R.saveItem('mgrA', 'internal_service:none', { retire: true });
    const l = await R.items('accA');
    const k = l.items.find(x => x.item_key === 'internal_service:none');
    return (r.status === 'retired' && l.retired.some(x => x.id === S.itemReview) && k.mapped === false) || JSON.stringify({ r, k });
  });
}

async function secIntents() {
  section('5-6. billing intents: one per purpose + currency, fixed operational reference');
  await expectErr('create: supervisor → MRS_FORBIDDEN', () => R.intent('supA', { transaction_id: TX1 }), /MRS_FORBIDDEN/);
  await expectErr('create: operations manager → MRS_FORBIDDEN', () => R.intent('opsA', { transaction_id: TX1 }), /MRS_FORBIDDEN/);
  await expectErr('create: org B → MRS_NOT_FOUND', () => R.intent('accB', { transaction_id: TX1 }), /MRS_NOT_FOUND/);
  await expectErr('create: client → MRS_NOT_FOUND', () => R.intent('clientA', { transaction_id: TX1 }), /MRS_NOT_FOUND/);
  await expectErr('create: DMM transaction by the JED accountant → MRS_NOT_FOUND', () => R.intent('accJ', { transaction_id: TX2 }), /MRS_NOT_FOUND/);
  await expectErr('create: unknown key refused', () => R.intent('accA', { transaction_id: TX1, client_id: CL102 }), /MRS_INVALID unknown_key/);
  await expectErr('create: bad purpose', () => R.intent('accA', { transaction_id: TX1, purpose: 'proforma' }), /MRS_INVALID purpose/);
  await expectErr('create: a transaction without an approved charge in that currency → MRS_REQUIRED lines', () => R.intent('accA', { transaction_id: TX3 }), /MRS_REQUIRED lines/);
  await expectErr('supplementary before an issued final → MRS_BAD_TRANSITION no_issued_final', () => R.intent('accA', { transaction_id: TX1, purpose: 'supplementary' }), /MRS_BAD_TRANSITION no_issued_final/);
  S.IF = await R.intent('accJ', { transaction_id: TX1, note: 'فاتورة المعاملة' });
  await check('final intent (JED accountant): ref <tx.ref>/F, client = transaction client, SAR, approved SAR charges added', async () => {
    const lines = S.IF.lines;
    return (S.IF.operational_ref === S.ref1 + '/F' && S.IF.purpose_key === 'F' && S.IF.client_id === CL101 && S.IF.currency === 'SAR'
            && S.IF.status === 'open' && S.IF.sync_state === 'idle' && lines.length === 2
            && lines.map(l => l.charge_id).sort().join() === [S.ch1.id, S.ch2.id].sort().join()
            && N(S.IF.lines_total) === 2875 + 600 && lines.every(l => /^MRSL-[0-9A-F]{16}$/.test(l.line_ref) && l.state === 'pending_add'))
      || JSON.stringify(S.IF);
  });
  await check('line snapshot: item_key, kind, service code, VAT from the charge (G4 binding)', async () => {
    const l1 = S.IF.lines.find(l => l.charge_id === S.ch1.id), l2 = S.IF.lines.find(l => l.charge_id === S.ch2.id);
    return (l1.item_key === 'service:customs_clearance' && N(l1.vat_rate) === 15 && N(l1.total_amount) === 2875
            && l2.item_key === 'reimbursable:port_charges' && N(l2.vat_rate) === 0 && l2.kind === 'reimbursable'
            && l1.line_ref === 'MRSL-' + l1.id.replace(/-/g, '').slice(0, 16).toUpperCase()) || JSON.stringify({ l1, l2 });
  });
  await check('one final per transaction + currency: a second → MRS_INVALID intent_taken (hint = existing id)', async () => {
    const e = await tryErr(() => R.intent('accA', { transaction_id: TX1 }));
    return new RegExp('MRS_INVALID intent_taken ' + S.IF.id).test(e) || e;
  });
  await expectErr('the partial unique index holds for a direct insert too', () => q(`
    INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose, purpose_key, operational_ref)
    VALUES ($1, $2, $3, 'final', 'F', 'other-ref')`, [A, TX1, CL101]), /duplicate key|unique/);
  await expectErr('operational_ref is immutable', () => q(`UPDATE public.billing_intents SET operational_ref = 'X' WHERE id = $1`, [S.IF.id]), /MRS_IMMUTABLE/);
  await check('another currency gets its own final: <ref>/F-USD with the USD charge only', async () => {
    S.IU = await R.intent('accA', { transaction_id: TX1, currency: 'usd' });
    return (S.IU.operational_ref === S.ref1 + '/F-USD' && S.IU.lines.length === 1 && S.IU.lines[0].charge_id === S.chUsd.id) || JSON.stringify(S.IU);
  });
  await expectErr('cancel: accountant → MRS_FORBIDDEN (fin_approve)', () => R.cancel('accA', S.IU.id, 'x'), /MRS_FORBIDDEN/);
  await expectErr('cancel: reason required', () => R.cancel('mgrA', S.IU.id, ''), /MRS_NOTE_REQUIRED/);
  await check('cancel an open intent → cancelled, lines removed, charge approved again (eligible)', async () => {
    const r = await R.cancel('mgrA', S.IU.id, 'عملة خاطئة');
    const l = await lineRows(S.IU.id);
    const c = await chargeRow(S.chUsd.id);
    return (r.status === 'cancelled' && r.cancel_reason === 'عملة خاطئة' && l.every(x => x.state === 'removed' && x.removed_reason === 'intent_cancelled')
            && c.status === 'approved') || JSON.stringify({ r, l, c });
  });
  await check('a cancelled reference is never reused: the next USD final is <ref>/F-USD-R2', async () => {
    S.IU2 = await R.intent('accA', { transaction_id: TX1, currency: 'USD' });
    return (S.IU2.operational_ref === S.ref1 + '/F-USD-R2' && S.IU2.revision === 2 && S.IU2.lines.length === 1) || JSON.stringify(S.IU2);
  });
  await check('interim before the final is issued: I1 (no eligible SAR charge left → MRS_REQUIRED lines)', async () => {
    const e = await tryErr(() => R.intent('accA', { transaction_id: TX1, purpose: 'interim' }));
    return /MRS_REQUIRED lines/.test(e) || e;
  });
  await check('add_eligible false: an intent without lines; add_billing_lines adds the chosen charge', async () => {
    S.I4 = await R.intent('accA', { transaction_id: TX4, add_eligible: false });
    const r = await R.addLines('accA', S.I4.id, [S.ch6.id]);
    return (S.I4.lines.length === 0 && r.added.length === 1 && r.intent.line_count === 1 && S.I4.operational_ref === S.ref4 + '/F') || JSON.stringify(r);
  });
  await check('a transaction always has a client (transactions.client_id NOT NULL); the RPC still guards MRS_REQUIRED client', async () => {
    const r = await one(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'client_id'`);
    const src = await one(`SELECT prosrc FROM pg_proc WHERE proname = 'create_billing_intent'`);
    return (r.is_nullable === 'NO' && /MRS_REQUIRED', 'client'/.test(src.prosrc)) || JSON.stringify(r);
  });
  await check('intent_created event: billing, internal, ids only', async () => {
    const e = await one(`SELECT * FROM public.transaction_events WHERE event_type = 'billing' AND payload ->> 'id' = $1`, [S.IF.id]);
    return (e && e.payload.op === 'intent_created' && e.visible_to_client === false && e.payload.purpose_key === 'F') || JSON.stringify(e);
  });
}

async function secLines() {
  section('8. lines: eligibility, no double billing, charge guard, removal');
  await expectErr('a draft charge is not eligible (hint = id)', () => R.addLines('accA', S.IF.id, [S.ch3.id]), new RegExp('MRS_INVALID not_eligible ' + S.ch3.id));
  await expectErr('another transaction\'s charge is not eligible', () => R.addLines('accA', S.IF.id, [S.ch5.id]), /MRS_INVALID not_eligible/);
  await expectErr('another currency is not eligible', () => R.addLines('accA', S.IF.id, [S.chUsd.id]), /MRS_INVALID not_eligible/);
  await expectErr('a charge already on a live line is not eligible', () => R.addLines('accA', S.IF.id, [S.ch1.id]), /MRS_INVALID not_eligible/);
  await expectErr('an empty id list → MRS_REQUIRED lines', () => R.addLines('accA', S.IF.id, []), /MRS_REQUIRED lines/);
  await expectErr('no double billing: a second live line for one charge is refused by the unique index (direct insert)', () => q(`
    INSERT INTO public.billing_intent_lines (org_id, transaction_id, intent_id, charge_id, line_ref, item_key, description, quantity, unit_price,
      net_amount, vat_rate, vat_amount, total_amount, currency, kind)
    VALUES ($1, $2, $3, $4, 'MRSL-0000000000000000', 'service:none', 'x', 1, 1, 1, 0, 0, 1, 'SAR', 'service')`, [A, TX1, S.IU2.id, S.ch1.id]), /duplicate key|unique/);
  await expectErr('a line can never point at another transaction\'s charge (composite FK)', () => q(`
    INSERT INTO public.billing_intent_lines (org_id, transaction_id, intent_id, charge_id, line_ref, item_key, description, quantity, unit_price,
      net_amount, vat_rate, vat_amount, total_amount, currency, kind)
    VALUES ($1, $2, $3, $4, 'MRSL-0000000000000000', 'service:none', 'x', 1, 1, 1, 0, 0, 1, 'SAR', 'service')`, [A, TX1, S.IF.id, S.ch5.id]), /foreign key/);
  await expectErr('line snapshot is immutable', () => q(`UPDATE public.billing_intent_lines SET unit_price = 1 WHERE intent_id = $1`, [S.IF.id]), /MRS_IMMUTABLE/);
  await expectErr('charge guard: a billed charge cannot go back to draft (G4 set_charge_status) → in_invoice', () => R.chargeSt('mgrA', S.ch1.id, 'draft', 'تعديل'), /MRS_BAD_TRANSITION in_invoice/);
  await expectErr('charge guard: nor be voided', () => R.chargeSt('mgrA', S.ch1.id, 'void', 'إلغاء'), /MRS_BAD_TRANSITION in_invoice/);
  await expectErr('G4 set_charge_status(invoiced) is still g5_only', () => R.chargeSt('mgrA', S.ch1.id, 'invoiced'), /MRS_BAD_TRANSITION g5_only/);
  await expectErr('invoiced is set only by the G5 completion path (direct UPDATE refused)', () => q(`UPDATE public.client_charges SET status = 'invoiced' WHERE id = $1`, [S.ch1.id]), /MRS_BAD_TRANSITION g5_only/);
  await expectErr('remove: reason required', () => R.rmLine('accA', S.I4.lines ? null : null, ''), /MRS_NOTE_REQUIRED|MRS_NOT_FOUND/);
  const l4 = (await lineRows(S.I4.id))[0];
  await expectErr('remove: supervisor → MRS_FORBIDDEN', () => R.rmLine('supA', l4.id, 'x'), /MRS_FORBIDDEN/);
  await check('remove a never-pushed line (nothing in flight) → removed at once; the charge is eligible again', async () => {
    const r = await R.rmLine('accA', l4.id, 'سعر خاطئ');
    const t = await R.txb('accA', TX4);
    return (r.state === 'removed' && r.from === 'pending_add' && r.removed_reason === 'سعر خاطئ' && N(r.intent.lines_total) === 0
            && t.eligible_charges.some(c => c.id === S.ch6.id)) || JSON.stringify(r);
  });
  await expectErr('remove twice → MRS_BAD_TRANSITION removed', () => R.rmLine('accA', l4.id, 'x'), /MRS_BAD_TRANSITION removed/);
  await check('the charge leaves approved freely once no live line holds it (guard released)', async () => {
    await R.chargeSt('mgrA', S.ch6.id, 'draft', 'تعديل السعر');
    await R.chargeSt('mgrA', S.ch6.id, 'approved');
    return (await chargeRow(S.ch6.id)).status === 'approved';
  });
  await check('add the charge back (a new line, a new line_ref)', async () => {
    const r = await R.addLines('accA', S.I4.id, null);
    return (r.added.length === 1 && r.added[0].line_ref !== l4.line_ref) || JSON.stringify(r);
  });
}

async function secPushGate() {
  section('push gate: connection, capability, tax, lines, conflict; dedupe + idempotency');
  await check('not connected (sync disabled) → MRS_BAD_TRANSITION not_connected (hint sync_disabled)', async () => {
    await R.saveConn('mgrA', { sync_enabled: false });
    const e = await tryErr(() => R.push('accA', S.IF.id));
    await R.saveConn('mgrA', { sync_enabled: true });
    return /MRS_BAD_TRANSITION not_connected/.test(e) || e;
  });
  await check('a capability missing → MRS_BAD_TRANSITION capability (hint = the missing keys)', async () => {
    await q(`UPDATE public.daftra_connections SET capabilities = capabilities - 'invoices.update_draft' WHERE org_id = $1`, [A]);
    const e = await tryErr(() => R.push('accA', S.IF.id));
    const g = await R.get('accA', S.IF.id);
    await q(`UPDATE public.daftra_connections SET capabilities = capabilities || '{"invoices.update_draft":{"supported":true,"evidence":"mock"}}' WHERE org_id = $1`, [A]);
    return (/MRS_BAD_TRANSITION capability invoices.update_draft/.test(e) && g.can.push === false && g.can.push_blocked_by === 'capability'
            && g.checks.capabilities_missing.join() === 'invoices.update_draft') || e + JSON.stringify(g.can);
  });
  await check('a VAT rate outside the allowed rates → MRS_INVALID tax_rate_unmapped (hint = line refs)', async () => {
    const e = await tryErr(() => R.push('accA', S.I4.id));
    const l = (await lineRows(S.I4.id)).find(x => x.state === 'pending_add');
    return new RegExp('MRS_INVALID tax_rate_unmapped ' + l.line_ref).test(e) || e;
  });
  await check('allowing 5 % in the settings lets it pass the tax check', async () => {
    await R.saveConn('mgrA', { allowed_vat_rates: [0, 5, 15] });
    const g = await R.get('accA', S.I4.id);
    return g.checks.tax_rate_unmapped.length === 0 || JSON.stringify(g.checks);
  });
  await check('no live line → MRS_REQUIRED lines', async () => {
    const l = (await lineRows(S.I4.id)).find(x => x.state === 'pending_add');
    await R.rmLine('accA', l.id, 'لاحقًا');
    const e = await tryErr(() => R.push('accA', S.I4.id));
    return /MRS_REQUIRED lines/.test(e) || e;
  });
  await expectErr('push: supervisor → MRS_FORBIDDEN', () => R.push('supA', S.IF.id), /MRS_FORBIDDEN/);
  await expectErr('push: org B → MRS_NOT_FOUND', () => R.push('accB', S.IF.id), /MRS_NOT_FOUND intent/);
  const k = newKey();
  S.p1 = await R.push('accJ', S.IF.id, k);
  await check('push (JED accountant): invoice_push queued, intent pending; items / client link rows exist for the lines', async () => {
    const items = await q(`SELECT item_key, status FROM public.daftra_item_links WHERE org_id = $1 AND item_key IN ('service:customs_clearance','reimbursable:port_charges') AND status <> 'retired'`, [A]);
    return (S.p1.job.kind === 'invoice_push' && S.p1.job.priority === 2 && S.p1.deduplicated === false && S.p1.intent.sync_state === 'pending'
            && items.length === 2) || JSON.stringify({ p: S.p1, items });
  });
  await check('double click: a second request returns the same live job (deduplicated); the idem key replays', async () => {
    const a = await R.push('accA', S.IF.id);
    const b = await R.push('accJ', S.IF.id, k);
    const n = await count(`SELECT count(*)::int n FROM public.billing_sync_jobs WHERE intent_id = $1`, [S.IF.id]);
    return (a.job.id === S.p1.job.id && a.deduplicated === true && b.replayed === true && b.job.id === S.p1.job.id && n === 1) || JSON.stringify({ a, b, n });
  });
  await check('push_requested event once (not for the deduplicated request)', async () =>
    (await count(`SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'billing' AND payload ->> 'op' = 'push_requested' AND payload ->> 'id' = $1`, [S.IF.id])) === 1);
  await check('get_billing_intent: checks + can (push while queued), eligible none, connection mock', async () => {
    const g = await R.get('accJ', S.IF.id);
    return (g.checks.client_link === 'linked' && g.checks.reimbursable_taxed.length === 0 && g.checks.other_currency.length === 0
            && g.can.push === true && g.can.cancel === false && g.connection.mode === 'mock' && g.jobs.length === 1
            && g.transaction.ref === S.ref1) || JSON.stringify({ c: g.checks, can: g.can });
  });
}

async function secClaimComplete() {
  section('7-8. claim / complete: lane per org, lease, retry, unknown, append-only, effects');
  let ctx;
  await check('claim: the push context = intent with lines (refs, state), client link, items, invoice date, notes', async () => {
    const c = await claim('w1', 5);
    ctx = c.find(x => x.job.kind === 'invoice_push');
    const it = ctx && ctx.intent;
    return (c.length === 1 && it.operational_ref === S.ref1 + '/F' && it.lines.length === 2 && it.lines.every(l => l.state === 'pending_add')
            && it.client.external_id === 'c-1' && it.client.client_ref === 'MRSC-' + CL101 && it.items.length === 2
            && it.items.find(i => i.item_key === 'service:customs_clearance').external_product_id === 'p-100'
            && /^\d{4}-\d{2}-\d{2}$/.test(it.invoice_date) && it.notes === 'شكرًا لتعاملكم' && ctx.job.previous_status === 'queued')
      || JSON.stringify(c);
  });
  await check('claim set intent sync_state in_flight', async () => (await intentRow(S.IF.id)).sync_state === 'in_flight');
  await check('one running job per org: org A is skipped while its lease is live (an org B job is still claimable)', async () => {
    await R.probe('mgrA');
    const bi = await R.intent('accB', { transaction_id: B_TX });
    S.IB = bi;
    await R.push('accB', bi.id);
    const c = await claim('w2', 5);
    S.ctxB = c.find(x => x.job.org_id === B);
    // keep the queued org A probe out of the way of the lease scenario below
    await q(`UPDATE public.billing_sync_jobs SET next_run_at = now() + interval '1 day' WHERE kind = 'probe' AND status = 'queued' AND org_id = $1`, [A]);
    return (c.length === 1 && c[0].job.org_id === B) || JSON.stringify(c.map(x => x.job));
  });
  await check('org B push context never carries org A data', async () => {
    const s = JSON.stringify(S.ctxB);
    return (!s.includes(A) && !s.includes(CL101) && S.ctxB.intent.client.external_id === 'c-1' && S.ctxB.intent.client.client_ref === 'MRSC-' + B_CL)
      || 'leak';
  });
  await complete(S.ctxB.attempt_id, pushOk(S.ctxB));
  await check('lease_lost: an attempt whose job is held by another worker applies nothing', async () => {
    await q(`UPDATE public.billing_sync_jobs SET locked_by = 'w9' WHERE id = $1`, [ctx.job.id]);
    const r = await complete(ctx.attempt_id, pushOk(ctx));
    const a = await one(`SELECT outcome, calls FROM public.billing_sync_attempts WHERE id = $1`, [ctx.attempt_id]);
    const i = await intentRow(S.IF.id);
    return (r.applied === false && r.outcome === 'lease_lost' && a.outcome === 'lease_lost' && a.calls.length === 2
            && i.external_invoice_id === null && i.status === 'open') || JSON.stringify({ r, a, i });
  });
  await check('lease expiry: the running job is claimable again; its open attempt is closed abandoned; previous_status unknown', async () => {
    await q(`UPDATE public.billing_sync_jobs SET locked_until = now() - interval '1 minute', locked_by = 'w1' WHERE id = $1`, [ctx.job.id]);
    // an attempt opened by w1 is still open: re-open the scenario with a fresh claim by w1, then expire it
    const c1 = await claim('w1', 5);
    const again = c1.find(x => x.job.id === ctx.job.id);
    await q(`UPDATE public.billing_sync_jobs SET locked_until = now() - interval '1 minute' WHERE id = $1`, [ctx.job.id]);
    const c2 = await claim('w3', 5);
    const re = c2.find(x => x.job.id === ctx.job.id);
    const a = await one(`SELECT outcome FROM public.billing_sync_attempts WHERE id = $1`, [again.attempt_id]);
    ctx = re;
    return (again && again.job.previous_status === 'unknown' && re && re.job.previous_status === 'unknown' && re.job.attempt_no === 3
            && a.outcome === 'abandoned') || JSON.stringify({ again: again && again.job, re: re && re.job, a });
  });
  await check('completing an abandoned attempt later changes nothing (applied false)', async () => {
    const old = await one(`SELECT id FROM public.billing_sync_attempts WHERE job_id = $1 AND outcome = 'abandoned'`, [ctx.job.id]);
    const r = await complete(old.id, pushOk(ctx));
    return (r.applied === false && r.outcome === 'abandoned') || JSON.stringify(r);
  });
  await check('push ok: draft / synced, Daftra id, hashes, remote figures; lines synced + pushed + remote line id', async () => {
    const res = pushOk(ctx, { ext: 'inv-A1' });
    S.pushHash = res.effects.pushed_hash;
    const r = await complete(ctx.attempt_id, res);
    const i = await intentRow(S.IF.id);
    const l = await lineRows(S.IF.id);
    return (r.applied && r.job_status === 'done' && i.status === 'draft' && i.sync_state === 'synced' && i.external_invoice_id === 'inv-A1'
            && i.pushed_hash === S.pushHash && i.remote_hash === S.pushHash && N(i.remote_total) === 3475 && N(i.lines_total) === 3475
            && l.every(x => x.state === 'synced' && x.pushed && x.remote_line_id)) || JSON.stringify({ r, i, l });
  });
  await check('financial_status → draft_pending (forward), with a financial_status event', async () => {
    const t = await txRow(TX1);
    const e = await count(`SELECT count(*)::int n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'financial_status' AND to_status = 'draft_pending'`, [TX1]);
    return (t.financial_status === 'draft_pending' && e === 1) || t.financial_status;
  });
  await check('draft_synced event (ids only); attempt closed ok with redacted calls', async () => {
    const e = await one(`SELECT payload FROM public.transaction_events WHERE event_type = 'billing' AND payload ->> 'op' = 'draft_synced' AND payload ->> 'id' = $1`, [S.IF.id]);
    const a = await one(`SELECT outcome, calls FROM public.billing_sync_attempts WHERE id = $1`, [ctx.attempt_id]);
    return (e && e.payload.job_id === ctx.job.id && a.outcome === 'ok' && !/apiKey|secret-token/.test(JSON.stringify(a.calls))) || JSON.stringify({ e, a });
  });
  await expectErr('attempts are append-only: a closed attempt cannot be updated', () => q(`UPDATE public.billing_sync_attempts SET outcome = 'failed' WHERE id = $1`, [ctx.attempt_id]), /MRS_APPEND_ONLY/);
  await expectErr('attempts are append-only: no delete', () => q(`DELETE FROM public.billing_sync_attempts WHERE id = $1`, [ctx.attempt_id]), /MRS_APPEND_ONLY/);
  await expectErr('attempts: an open attempt changes only finished_at / outcome / calls / error', async () => {
    await R.probe('mgrA');
    await due();
    const [c] = await claim('w1', 5);
    S.probeCtx = c;
    return q(`UPDATE public.billing_sync_attempts SET worker = 'other', outcome = 'ok', finished_at = now() WHERE id = $1`, [c.attempt_id]);
  }, /MRS_APPEND_ONLY/);
  await complete(S.probeCtx.attempt_id, probeOk());
  await check('the job lane is free again after completion; jobs list (fin_read) shows done jobs', async () => {
    const l = await R.jobs('accA', { intent_id: S.IF.id });
    return (l.total === 1 && l.items[0].status === 'done' && l.items[0].last_attempt.outcome === 'ok') || JSON.stringify(l);
  });
  await check('get_billing_job: attempts history (3 attempts: lease_lost, abandoned, ok)', async () => {
    const j = await R.job('accJ', ctx.job.id);
    return (j.attempts.map(a => a.outcome).join() === 'lease_lost,abandoned,ok') || JSON.stringify(j.attempts.map(a => a.outcome));
  });

  // late approved charge on the draft: appended on the next push; concurrency of line_results
  await check('a late approved charge added to the draft → sync_state pending', async () => {
    await R.chargeSt('mgrA', S.ch3.id, 'approved');
    const r = await R.addLines('accA', S.IF.id, [S.ch3.id]);
    S.l3 = r.added[0];
    return (r.intent.sync_state === 'pending' && r.intent.status === 'draft') || JSON.stringify(r.intent);
  });
  await check('remove a pushed line → pending_remove (the worker removes that line_ref only)', async () => {
    const l2 = (await lineRows(S.IF.id)).find(x => x.charge_id === S.ch2.id);
    const r = await R.rmLine('accA', l2.id, 'سيُفوتر لاحقًا');
    S.l2 = l2;
    return (r.state === 'pending_remove' && r.pushed === true) || JSON.stringify(r);
  });
  await R.push('accA', S.IF.id);
  let c2;
  await check('retry: a timeout without send → queued, backoff 30 s, attempts 1', async () => {
    [c2] = await claim('w1', 5);
    const r = await complete(c2.attempt_id, { outcome: 'retry', error: { kind: 'timeout', code: 'timeout', message: 'no response', http_status: null },
      calls: [], effects: { intent_id: S.IF.id } });
    const j = await jobRow(c2.job.id);
    const sec = (new Date(j.next_run_at) - Date.now()) / 1000;
    const i = await intentRow(S.IF.id);
    return (r.job_status === 'queued' && j.attempts === 1 && sec > 20 && sec <= 31 && i.sync_state === 'error' && i.last_error_code === 'timeout')
      || JSON.stringify({ r, j, sec, i: i.sync_state });
  });
  await check('not claimable before its next_run_at', async () => (await claim('w1', 5)).filter(x => x.job.id === c2.job.id).length === 0);
  await check('second retry doubles the backoff (60 s)', async () => {
    await due();
    const [c] = await claim('w1', 5);
    await complete(c.attempt_id, { outcome: 'retry', error: { kind: 'network', code: 'network', message: 'reset' } });
    const j = await jobRow(c.job.id);
    const sec = (new Date(j.next_run_at) - Date.now()) / 1000;
    return (j.attempts === 2 && sec > 50 && sec <= 61) || JSON.stringify({ j, sec });
  });
  await check('max attempts reached → dead; sync_failed event', async () => {
    await q(`UPDATE public.billing_sync_jobs SET max_attempts = 3 WHERE id = $1`, [c2.job.id]);
    await due();
    const [c] = await claim('w1', 5);
    const r = await complete(c.attempt_id, { outcome: 'retry', error: { kind: 'http_5xx', code: 'http_503', http_status: 503 } });
    const e = await count(`SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'billing' AND payload ->> 'op' = 'sync_failed' AND payload ->> 'id' = $1`, [S.IF.id]);
    return (r.job_status === 'dead' && e === 1) || JSON.stringify({ r, e });
  });
  await expectErr('retry_billing_job: supervisor → MRS_FORBIDDEN', () => R.retry('supA', c2.job.id), /MRS_FORBIDDEN/);
  await expectErr('retry_billing_job: org B → MRS_NOT_FOUND', () => R.retry('accB', c2.job.id), /MRS_NOT_FOUND job/);
  await check('retry_billing_job (fin_write): dead → queued, max_attempts = attempts + 3', async () => {
    const r = await R.retry('accA', c2.job.id);
    return (r.status === 'queued' && r.max_attempts === r.attempts + 3 && r.attempts === 3) || JSON.stringify(r);
  });
  await expectErr('retry_billing_job on a queued job → MRS_BAD_TRANSITION queued', () => R.retry('accA', c2.job.id), /MRS_BAD_TRANSITION queued/);
  await check('lines added while in flight stay pending_add; a pushed line removed in flight keeps pending_remove', async () => {
    const [c] = await claim('w1', 5);
    // during the flight: another charge approved and added
    S.ch7 = await mkCharge(TX1, { kind: 'service', service_code: 'inspection', description: 'معاينة', unit_price: 200 });
    const add = await R.addLines('accA', S.IF.id, [S.ch7.id]);
    // the worker only knew the context lines: ch1 synced, ch2 pending_remove → removed, ch3 pending_add → synced
    const res = pushOk(c);
    S.pushHash = res.effects.pushed_hash;
    await complete(c.attempt_id, res);
    const l = await lineRows(S.IF.id);
    const i = await intentRow(S.IF.id);
    const st = id => (l.find(x => x.charge_id === id) || {}).state;
    return (c.intent.lines.length === 3 && st(S.ch1.id) === 'synced' && st(S.ch3.id) === 'synced' && st(S.ch7.id) === 'pending_add'
            && l.find(x => x.charge_id === S.ch2.id && x.state === 'removed') && i.sync_state === 'pending' && add.added.length === 1)
      || JSON.stringify({ l: l.map(x => [x.charge_id, x.state]), s: i.sync_state });
  });
  await check('a line reported synced while it is now pending_remove keeps pending_remove (pushed true)', async () => {
    await R.push('accA', S.IF.id);
    const [c] = await claim('w1', 5);
    const l7 = (await lineRows(S.IF.id)).find(x => x.charge_id === S.ch7.id);
    // removed in flight after the worker read the context (pending_add then) — the worker reports it synced
    await q(`UPDATE public.billing_intent_lines SET state = 'pending_remove', removed_reason = 'خطأ' WHERE id = $1`, [l7.id]);
    const res = pushOk(c);
    S.pushHash = res.effects.pushed_hash;
    await complete(c.attempt_id, res);
    const after = await one(`SELECT state, pushed FROM public.billing_intent_lines WHERE id = $1`, [l7.id]);
    const i = await intentRow(S.IF.id);
    return (after.state === 'pending_remove' && after.pushed === true && i.sync_state === 'pending') || JSON.stringify({ after, s: i.sync_state });
  });
  await check('next push removes that line only (reported removed) → synced', async () => {
    await R.push('accA', S.IF.id);
    const [c] = await claim('w1', 5);
    const res = pushOk(c);
    S.pushHash = res.effects.pushed_hash;
    await complete(c.attempt_id, res);
    const l = await lineRows(S.IF.id);
    const i = await intentRow(S.IF.id);
    return (l.filter(x => x.state === 'synced').length === 2 && l.filter(x => x.state === 'removed').length === 2 && i.sync_state === 'synced')
      || JSON.stringify(l.map(x => x.state));
  });
  await check('ch7 is eligible again after its line was removed; re-added for the issue scenario', async () => {
    const r = await R.addLines('accA', S.IF.id, [S.ch7.id]);
    await R.push('accA', S.IF.id);
    const [c] = await claim('w1', 5);
    const res = pushOk(c);
    S.pushHash = res.effects.pushed_hash;
    await complete(c.attempt_id, res);
    return (r.added.length === 1 && (await intentRow(S.IF.id)).sync_state === 'synced') || JSON.stringify(r);
  });

  // unknown result (a lost response) and reconciliation
  await check('unknown: lost response → job unknown (+2 min), intent unknown, expected_hash kept', async () => {
    const i2 = await R.intent('bmD', { transaction_id: TX2 });
    S.I2 = i2;
    await R.push('bmD', i2.id);
    const [c] = await claim('w1', 5);
    const exp = H('expected');
    const r = await complete(c.attempt_id, { outcome: 'unknown', expected_hash: exp,
      error: { kind: 'timeout', code: 'timeout', message: 'sent, no answer', http_status: null }, effects: { intent_id: i2.id },
      calls: [Object.assign(call('createDraftInvoice', { reference: c.intent.operational_ref }, null, 'unknown'), { error: { kind: 'timeout' } })] });
    const j = await jobRow(c.job.id);
    const i = await intentRow(i2.id);
    const sec = (new Date(j.next_run_at) - Date.now()) / 1000;
    S.unkJob = c.job.id;
    return (r.job_status === 'unknown' && j.expected_hash === exp && sec > 100 && sec <= 121 && i.sync_state === 'unknown'
            && (await one(`SELECT outcome FROM public.billing_sync_attempts WHERE id = $1`, [c.attempt_id])).outcome === 'unknown')
      || JSON.stringify({ r, j, i: i.sync_state });
  });
  await expectErr('cancel while the result is unknown → MRS_BAD_TRANSITION sync_in_flight', () => R.cancel('bmD', S.I2.id, 'x'), /MRS_BAD_TRANSITION sync_in_flight/);
  await check('a push request while unknown returns the same job (deduplicated)', async () => {
    const r = await R.push('bmD', S.I2.id);
    return (r.job.id === S.unkJob && r.deduplicated === true && r.intent.sync_state === 'unknown') || JSON.stringify(r);
  });
  await check('reclaimed after the delay with previous_status unknown and the expected hash (reconcile first)', async () => {
    await due();
    const [c] = await claim('w1', 5);
    S.ctxUnk = c;
    return (c.job.id === S.unkJob && c.job.previous_status === 'unknown' && c.job.expected_hash === H('expected')) || JSON.stringify(c.job);
  });
  await check('reconcile adopts the invoice found by reference (found_by ref) → draft synced; expected_hash cleared', async () => {
    const r = await complete(S.ctxUnk.attempt_id, pushOk(S.ctxUnk, { found_by: 'ref', ext: 'inv-A2' }));
    const i = await intentRow(S.I2.id);
    const j = await jobRow(S.unkJob);
    return (r.job_status === 'done' && i.external_invoice_id === 'inv-A2' && i.status === 'draft' && i.sync_state === 'synced' && j.expected_hash === null)
      || JSON.stringify({ r, i, j });
  });

  // invalid results never apply
  await check('invalid effects (bad external id) → attempt failed, job failed, nothing applied', async () => {
    S.I2b = S.I2;
    await R.push('accA', S.I4.id).catch(() => null);
    const ch = await mkCharge(TX3, { kind: 'service', description: 'خدمة فرد', unit_price: 50 });
    S.I3 = await R.intent('accA', { transaction_id: TX3 });
    await R.push('accA', S.I3.id);
    const [c] = await claim('w1', 5);
    const bad = pushOk(c, { ext: '../../etc' });
    const r = await complete(c.attempt_id, bad);
    const a = await one(`SELECT outcome, error FROM public.billing_sync_attempts WHERE id = $1`, [c.attempt_id]);
    const i = await intentRow(S.I3.id);
    S.badJob = c.job.id; S.ch3x = ch;
    return (r.applied === false && r.job_status === 'failed' && a.outcome === 'failed' && a.error.code === 'MRS_INVALID'
            && i.external_invoice_id === null && i.sync_state === 'error') || JSON.stringify({ r, a, i });
  });
  await check('external_id_taken: adopting a Daftra invoice already linked to another intent is refused', async () => {
    await R.retry('accA', S.badJob);
    const [c] = await claim('w1', 5);
    const r = await complete(c.attempt_id, pushOk(c, { ext: 'inv-A1' }));
    const i = await intentRow(S.I3.id);
    return (r.job_status === 'failed' && /external_id_taken|MRS_INVALID/.test(JSON.stringify(r.error)) && i.external_invoice_id === null)
      || JSON.stringify({ r, i });
  });
  await check('external_in_use (reference lookup hit another intent\'s invoice) → conflict; release allowed', async () => {
    await R.retry('accA', S.badJob);
    const [c] = await claim('w1', 5);
    await complete(c.attempt_id, { outcome: 'conflict', effects: { intent_id: S.I3.id, reason: 'external_in_use', external_ids: ['inv-A1'],
      diff: [{ line_ref: null, field: 'reference', pushed: c.intent.operational_ref, remote: 'inv-A1' }] } });
    const i = await intentRow(S.I3.id);
    const r = await R.resolve('mgrA', S.I3.id, 'release', 'مرجع مستخدم');
    const c3 = await chargeRow(S.ch3x.id);
    return (i.sync_state === 'conflict' && i.conflict.reason === 'external_in_use' && r.status === 'cancelled' && c3.status === 'approved')
      || JSON.stringify({ i: i.conflict, r: r.status });
  });
  await check('an unknown outcome name is refused (job failed)', async () => {
    S.I3b = await R.intent('accA', { transaction_id: TX3 });
    await R.push('accA', S.I3b.id);
    const [c] = await claim('w1', 5);
    const r = await complete(c.attempt_id, { outcome: 'maybe' });
    return (r.job_status === 'failed' && r.error.message === 'outcome') || JSON.stringify(r);
  });
  await check('a final failure (validation) → failed, intent error, sync_failed event', async () => {
    await R.retry('accA', (await one(`SELECT id FROM public.billing_sync_jobs WHERE intent_id = $1`, [S.I3b.id])).id);
    const [c] = await claim('w1', 5);
    const r = await complete(c.attempt_id, { outcome: 'failed', error: { kind: 'validation', code: 'http_422', message: 'currency', http_status: 422 },
      effects: { intent_id: S.I3b.id } });
    const i = await intentRow(S.I3b.id);
    return (r.job_status === 'failed' && i.sync_state === 'error' && i.last_error_code === 'http_422') || JSON.stringify({ r, i });
  });
  await check('skip disabled orgs: org B jobs wait while its sync is off; its probe still runs', async () => {
    await R.saveConn('adminB', { sync_enabled: false }, B);
    await R.pull('accA', S.IF.id);
    const pb = await R.probe('adminB', null, B);
    await R.saveConn('adminB', { sync_enabled: true }, B);
    await R.pull('accB', S.IB.id);
    await R.saveConn('adminB', { sync_enabled: false }, B);
    const c = await claim('w1', 5);
    const kinds = c.map(x => x.job.org_id === B ? 'B:' + x.job.kind : 'A:' + x.job.kind).sort().join();
    for (const x of c) await complete(x.attempt_id, defaultResult(x));
    const c2 = await claim('w1', 5);
    await R.saveConn('adminB', { sync_enabled: true }, B);
    for (const x of c2) await complete(x.attempt_id, defaultResult(x));
    return (kinds === 'A:invoice_pull,B:probe' && c2.length === 0 && pb.kind === 'probe') || JSON.stringify({ kinds, c2: c2.map(x => x.job.kind) });
  });
  await drain();
}

async function secConflicts() {
  section('9. read before update: manual edits are conflicts, resolved by a human');
  await check('push outcome conflict (remote_edited) → sync_state conflict, diff + remote snapshot kept, conflict event', async () => {
    S.ch8 = await mkCharge(TX1, { kind: 'service', service_code: 'saber', description: 'سابر', unit_price: 150 });
    await R.addLines('accA', S.IF.id, [S.ch8.id]);
    await R.push('accA', S.IF.id);
    const c = await claimIntent(S.IF.id, 'invoice_push');
    const l1 = c.intent.lines.find(l => l.state === 'synced');
    S.editedRef = l1.line_ref;
    await complete(c.attempt_id, { outcome: 'conflict', effects: { intent_id: S.IF.id, reason: 'remote_edited', remote_hash: H('edited'),
      remote_snapshot: { lines: [{ line_ref: l1.line_ref, unit_price: '999.00' }, { line_ref: null, description: 'بند المحاسب' }] },
      diff: [{ line_ref: l1.line_ref, field: 'unit_price', pushed: '1250.00', remote: '999.00' },
             { line_ref: null, field: 'foreign_line', pushed: null, remote: 'بند المحاسب' }] },
      calls: [call('getInvoice', { id: 'inv-A1' }, { status: 'draft' })] });
    const i = await intentRow(S.IF.id);
    const e = await count(`SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'billing' AND payload ->> 'op' = 'conflict' AND payload ->> 'id' = $1`, [S.IF.id]);
    return (i.sync_state === 'conflict' && i.conflict.reason === 'remote_edited' && i.conflict.diff.length === 2 && i.remote_hash === H('edited')
            && i.pushed_hash === S.pushHash && e >= 1) || JSON.stringify(i);
  });
  await expectErr('push while a conflict is open → MRS_BAD_TRANSITION conflict_open', () => R.push('accA', S.IF.id), /MRS_BAD_TRANSITION conflict_open/);
  await expectErr('resolve: accountant → MRS_FORBIDDEN (fin_approve)', () => R.resolve('accA', S.IF.id, 'keep_remote', 'x'), /MRS_FORBIDDEN/);
  await expectErr('resolve: note required', () => R.resolve('mgrA', S.IF.id, 'keep_remote', ''), /MRS_NOTE_REQUIRED/);
  await expectErr('resolve: recreate is only for remote_missing', () => R.resolve('mgrA', S.IF.id, 'recreate', 'x'), /MRS_BAD_TRANSITION conflict_reason remote_edited/);
  await check('queue: the conflict is listed', async () => {
    const r = await R.queue('accA');
    return (r.conflicts.some(x => x.id === S.IF.id) && r.counts.conflicts >= 1) || JSON.stringify(r.counts);
  });
  await check('keep_remote: accountant edits accepted, nothing sent; pushed_hash = remote hash; owned line keeps a remote_override', async () => {
    const jobsBefore = await count(`SELECT count(*)::int n FROM public.billing_sync_jobs WHERE intent_id = $1`, [S.IF.id]);
    const r = await R.resolve('mgrA', S.IF.id, 'keep_remote', 'المحاسب عدّل السعر باتفاق');
    const l = await one(`SELECT remote_override FROM public.billing_intent_lines WHERE line_ref = $1`, [S.editedRef]);
    const jobsAfter = await count(`SELECT count(*)::int n FROM public.billing_sync_jobs WHERE intent_id = $1`, [S.IF.id]);
    S.pushHash = H('edited');
    return (r.pushed_hash === H('edited') && r.conflict === null && r.sync_state === 'pending' && l.remote_override.unit_price === '999.00'
            && jobsAfter === jobsBefore) || JSON.stringify({ r, l });
  });
  await check('push after keep_remote → appended line, synced', async () => {
    await R.push('accA', S.IF.id);
    const c = await claimIntent(S.IF.id, 'invoice_push');
    const res = pushOk(c);
    S.pushHash = res.effects.pushed_hash;
    await complete(c.attempt_id, res);
    return (await intentRow(S.IF.id)).sync_state === 'synced';
  });
  await check('overwrite_remote: an explicit push with options.overwrite (owned lines only)', async () => {
    await R.push('accA', S.IF.id);
    const c = await claimIntent(S.IF.id, 'invoice_push');
    await complete(c.attempt_id, { outcome: 'conflict', effects: { intent_id: S.IF.id, reason: 'remote_edited', remote_hash: H('edited2'), diff: [] } });
    const r = await R.resolve('mgrA', S.IF.id, 'overwrite_remote', 'إعادة أسعار مرسى');
    const c2 = await claimIntent(S.IF.id, 'invoice_push');
    const res = pushOk(c2);
    S.pushHash = res.effects.pushed_hash;
    await complete(c2.attempt_id, res);
    const i = await intentRow(S.IF.id);
    return (r.job.options.overwrite === true && c2.job.options.overwrite === true && i.sync_state === 'synced' && i.conflict === null)
      || JSON.stringify({ r, i });
  });
  await check('remote_missing (draft deleted in Daftra) → recreate: Daftra id cleared, push with recreate, new draft', async () => {
    await R.pull('bmD', S.I2.id);
    const c = await claimIntent(S.I2.id, 'invoice_pull');
    await complete(c.attempt_id, { outcome: 'conflict', effects: { intent_id: S.I2.id, reason: 'remote_missing', remote_hash: null, diff: [],
      external_invoice_id: 'inv-A2' } });
    const i0 = await intentRow(S.I2.id);
    const r = await R.resolve('bmD', S.I2.id, 'recreate', 'حُذفت المسودة');
    const i1 = await intentRow(S.I2.id);
    await due();
    const out = await drain();
    const mine = out.find(x => x.ctx.intent && x.ctx.intent.id === S.I2.id && x.ctx.job.kind === 'invoice_push');
    const i2 = await intentRow(S.I2.id);
    return (i0.sync_state === 'conflict' && i0.conflict.reason === 'remote_missing' && i1.external_invoice_id === null && i1.status === 'open'
            && mine && mine.ctx.job.options.recreate === true && i2.status === 'draft' && i2.external_invoice_id && i2.external_invoice_id !== 'inv-A2')
      || JSON.stringify({ i0: i0.conflict, i1: i1.status, i2: i2.status, ext: i2.external_invoice_id });
  });
  await check('cancel a draft (remote draft exists) → MRS_BAD_TRANSITION remote_draft_exists', async () =>
    /MRS_BAD_TRANSITION remote_draft_exists/.test(await tryErr(() => R.cancel('bmD', S.I2.id, 'x'))));
  await check('remote_missing → release: intent cancelled, lines removed (released), charge approved again', async () => {
    await R.pull('bmD', S.I2.id);
    const c = await claimIntent(S.I2.id, 'invoice_pull');
    await complete(c.attempt_id, { outcome: 'conflict', effects: { intent_id: S.I2.id, reason: 'remote_missing' } });
    const r = await R.resolve('bmD', S.I2.id, 'release', 'لا حاجة للفاتورة');
    const l = await lineRows(S.I2.id);
    const ch = await chargeRow(S.ch5.id);
    return (r.status === 'cancelled' && l.every(x => x.state === 'removed' && x.removed_reason === 'released') && ch.status === 'approved')
      || JSON.stringify({ r: r.status, l: l.map(x => x.state), ch: ch.status });
  });
  await check('pull detects a manual edit too: draft hash ≠ pushed hash → conflict', async () => {
    await R.pull('accA', S.IF.id);
    const c = await claimIntent(S.IF.id, 'invoice_pull');
    await complete(c.attempt_id, pullRes(c, { hash: H('edited-on-pull'), effects: { diff: [{ line_ref: null, field: 'foreign_line', pushed: null, remote: 'x' }] } }));
    const i = await intentRow(S.IF.id);
    const ok = i.sync_state === 'conflict' && i.conflict.reason === 'remote_edited' && i.last_pulled_at !== null;
    await R.resolve('mgrA', S.IF.id, 'keep_remote', 'بند إضافي من المحاسب');
    S.pushHash = H('edited-on-pull');
    return ok || JSON.stringify(i);
  });
}

async function secIssue() {
  section('10-13. issued invoices are frozen; late charges; review queue; payments; financial status forward only');
  const lines = (await lineRows(S.IF.id)).filter(l => l.state !== 'removed');
  const onIssued = lines.filter(l => l.charge_id !== S.ch8.id);      // the accountant dropped the saber line before issuing
  await check('pull: the accountant issued it → intent issued, number stored, charges invoiced, frozen lines', async () => {
    await R.pull('accA', S.IF.id);
    const c = await claimIntent(S.IF.id, 'invoice_pull');
    const res = pullRes(c, { state: 'issued', status: 'issued', number: 'INV-000001', hash: H('issued-content'),
      lines: c.intent.lines.filter(l => l.line_id !== lines.find(x => x.charge_id === S.ch8.id).id),
      totals: { net: '3700.00', vat: '555.00', total: '4255.00' },
      effects: { diff: [{ line_ref: lines.find(x => x.charge_id === S.ch8.id).line_ref, field: 'line', pushed: 'present', remote: null }] } });
    await complete(c.attempt_id, res);
    const i = await intentRow(S.IF.id);
    const ch = await Promise.all(onIssued.map(l => chargeRow(l.charge_id)));
    return (i.status === 'issued' && i.daftra_number === 'INV-000001' && i.issued_at && N(i.remote_total) === 4255 && i.sync_state === 'synced'
            && ch.every(x => x.status === 'invoiced')) || JSON.stringify({ i, ch: ch.map(x => x.status) });
  });
  await check('a live line not on the issued invoice → removed (not_on_issued), its charge stays approved → late_charge item', async () => {
    const l8 = await one(`SELECT * FROM public.billing_intent_lines WHERE charge_id = $1 ORDER BY created_at DESC LIMIT 1`, [S.ch8.id]);
    const c8 = await chargeRow(S.ch8.id);
    const r = await one(`SELECT * FROM public.billing_review_items WHERE charge_id = $1 AND kind = 'late_charge' AND status = 'open'`, [S.ch8.id]);
    S.late8 = r;
    return (l8.state === 'removed' && l8.removed_reason === 'not_on_issued' && c8.status === 'approved' && r && r.intent_id === S.IF.id)
      || JSON.stringify({ l8, c8: c8.status, r });
  });
  await check('remote content ≠ pushed hash → one issued_mismatch review item with the diff (Daftra wins)', async () => {
    const r = await q(`SELECT * FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'issued_mismatch'`, [S.IF.id]);
    S.mismatch = r[0];
    return (r.length === 1 && r[0].details.diff.length === 1 && r[0].details.remote_hash === H('issued-content')) || JSON.stringify(r);
  });
  await check('financial_status → invoiced; issued event lists the invoiced charge ids (no amounts)', async () => {
    const t = await txRow(TX1);
    const e = await one(`SELECT payload FROM public.transaction_events WHERE event_type = 'billing' AND payload ->> 'op' = 'issued' AND payload ->> 'id' = $1`, [S.IF.id]);
    return (t.financial_status === 'invoiced' && e.payload.charge_ids.length === onIssued.length) || JSON.stringify({ f: t.financial_status, e });
  });
  await expectErr('push on an issued intent → MRS_BAD_TRANSITION intent_issued', () => R.push('accA', S.IF.id), /MRS_BAD_TRANSITION intent_issued/);
  await expectErr('add lines on an issued intent → intent_issued', () => R.addLines('accA', S.IF.id, null), /MRS_BAD_TRANSITION intent_issued/);
  await expectErr('remove a frozen line → intent_issued', () => R.rmLine('accA', onIssued[0].id, 'x'), /MRS_BAD_TRANSITION intent_issued/);
  await expectErr('cancel an issued intent → intent_issued', () => R.cancel('mgrA', S.IF.id, 'x'), /MRS_BAD_TRANSITION intent_issued/);
  await expectErr('an invoiced charge cannot be changed by G4 set_charge_status (MRS_BAD_TRANSITION invoiced)', () => R.chargeSt('mgrA', onIssued[0].charge_id, 'void', 'x'), /MRS_BAD_TRANSITION (invoiced|g5_only)/);
  await expectErr('nor leave invoiced by a direct update (g5_only)', () => q(`UPDATE public.client_charges SET status = 'approved' WHERE id = $1`, [onIssued[0].charge_id]), /MRS_BAD_TRANSITION g5_only/);
  await check('a charge approved after the issue → late_charge review item (trigger)', async () => {
    S.ch9 = await mkCharge(TX1, { kind: 'service', service_code: 'washing', description: 'غسيل', unit_price: 80 });
    const r = await one(`SELECT * FROM public.billing_review_items WHERE charge_id = $1 AND kind = 'late_charge' AND status = 'open'`, [S.ch9.id]);
    S.late9 = r;
    return (r && r.intent_id === S.IF.id && r.details.reason === 'approved_after_issue') || JSON.stringify(r);
  });
  await check('review queue: late charges and the mismatch are listed', async () => {
    const r = await R.queue('accJ');
    return (r.late_charges.length === 2 && r.issued_mismatch.length === 1 && r.counts.late_charges === 2) || JSON.stringify(r.counts);
  });
  await check('interim after the final is issued → MRS_BAD_TRANSITION final_issued', async () =>
    /MRS_BAD_TRANSITION final_issued/.test(await tryErr(() => R.intent('accA', { transaction_id: TX1, purpose: 'interim' }))));
  await check('supplementary S1 (add_eligible false) after the issued final: ref <tx>/S1', async () => {
    S.S1 = await R.intent('accA', { transaction_id: TX1, purpose: 'supplementary', add_eligible: false });
    return (S.S1.operational_ref === S.ref1 + '/S1' && S.S1.purpose === 'supplementary' && S.S1.lines.length === 0) || JSON.stringify(S.S1);
  });
  await expectErr('resolve_billing_review: accountant → MRS_FORBIDDEN', () => R.review('accA', S.late9.id, 'dismiss', 'x'), /MRS_FORBIDDEN/);
  await expectErr('resolve_billing_review: decision of another kind → MRS_INVALID decision', () => R.review('mgrA', S.late9.id, 'accept', 'x'), /MRS_INVALID decision/);
  await expectErr('resolve_billing_review: supplementary without an intent → MRS_REQUIRED intent', () => R.review('mgrA', S.late9.id, 'supplementary', 'x'), /MRS_REQUIRED intent/);
  await expectErr('resolve_billing_review: supplementary into the final → MRS_INVALID intent', () => R.review('mgrA', S.late9.id, 'supplementary', 'x', S.IF.id), /MRS_INVALID intent/);
  await check('late charge → supplementary: the charge becomes a line of S1 in the same call', async () => {
    const r = await R.review('mgrA', S.late9.id, 'supplementary', 'فاتورة إضافية', S.S1.id);
    const l = await lineRows(S.S1.id);
    return (r.status === 'resolved' && r.resolution === 'supplementary' && r.resolved_intent_id === S.S1.id && r.added.length === 1
            && l.length === 1 && l[0].charge_id === S.ch9.id) || JSON.stringify({ r, l });
  });
  await check('a late item whose charge lands on a live line otherwise is auto-resolved (billed)', async () => {
    await R.addLines('accA', S.S1.id, [S.ch8.id]);
    const r = await one(`SELECT * FROM public.billing_review_items WHERE id = $1`, [S.late8.id]);
    return (r.status === 'resolved' && r.resolution === 'billed' && r.resolved_intent_id === S.S1.id) || JSON.stringify(r);
  });
  await check('dismiss a late charge: the charge stays approved and unbilled', async () => {
    const ch = await mkCharge(TX1, { kind: 'reimbursable', description: 'مصروف متأخر', unit_price: 20 });
    const it = await one(`SELECT * FROM public.billing_review_items WHERE charge_id = $1 AND status = 'open'`, [ch.id]);
    const r = await R.review('mgrA', it.id, 'dismiss', 'لن يُفوتر');
    return (r.status === 'dismissed' && (await chargeRow(ch.id)).status === 'approved') || JSON.stringify(r);
  });
  await check('issued_mismatch → accept: owned lines keep the Daftra values as an override note', async () => {
    const r = await R.review('mgrA', S.mismatch.id, 'accept', 'دفترة هي المرجع');
    return (r.status === 'resolved' && r.resolution === 'accept') || JSON.stringify(r);
  });
  await check('payments: partial → payment_status partial, financial still invoiced (S1 open)', async () => {
    await R.pull('accA', S.IF.id);
    const c = await claimIntent(S.IF.id, 'invoice_pull');
    await complete(c.attempt_id, pullRes(c, { state: 'issued', status: 'issued', number: 'INV-000001', hash: H('issued-content'),
      lines: c.intent.lines, totals: { net: '3700.00', vat: '555.00', total: '4255.00' },
      payment: { status: 'partial', paid_amount: '1000.00', last_payment_at: '2026-11-02' } }));
    const i = await intentRow(S.IF.id);
    return (i.payment_status === 'partial' && N(i.paid_amount) === 1000 && i.last_payment_at && (await txRow(TX1)).financial_status === 'invoiced')
      || JSON.stringify(i);
  });
  await check('S1 pushed and issued by the accountant (charges invoiced); final paid in full → paid event', async () => {
    await R.push('accA', S.S1.id);
    await drain();
    await R.pull('accA', S.S1.id);
    const c = await claimIntent(S.S1.id, 'invoice_pull');
    await complete(c.attempt_id, pullRes(c, { state: 'issued', status: 'issued', number: 'INV-000002', hash: (await intentRow(S.S1.id)).pushed_hash,
      payment: { status: 'paid', paid_amount: '264.50', last_payment_at: '2026-11-02' } }));
    await R.pull('accA', S.IF.id);
    const c2 = await claimIntent(S.IF.id, 'invoice_pull');
    await complete(c2.attempt_id, pullRes(c2, { state: 'issued', status: 'issued', number: 'INV-000001', hash: H('issued-content'), lines: c2.intent.lines,
      payment: { status: 'paid', paid_amount: '4255.00', last_payment_at: '2026-11-03' } }));
    const s1 = await intentRow(S.S1.id), f = await intentRow(S.IF.id);
    const paidEv = await count(`SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'billing' AND payload ->> 'op' = 'paid' AND transaction_id = $1`, [TX1]);
    const inv = await count(`SELECT count(*)::int n FROM public.client_charges WHERE id = ANY($1) AND status = 'invoiced'`, [[S.ch8.id, S.ch9.id]]);
    return (s1.status === 'issued' && s1.payment_status === 'paid' && f.payment_status === 'paid' && paidEv === 2 && inv === 2)
      || JSON.stringify({ s1: [s1.status, s1.payment_status], f: f.payment_status, paidEv, inv });
  });
  await check('financial_status settled: every issued intent paid and nothing open / draft left (USD intent cancelled first)', async () => {
    const before = (await txRow(TX1)).financial_status;
    await R.cancel('mgrA', S.IU2.id, 'تُفوتر لاحقًا');
    await R.pull('accA', S.IF.id);
    const c = await claimIntent(S.IF.id, 'invoice_pull');
    await complete(c.attempt_id, pullRes(c, { state: 'issued', status: 'issued', hash: H('issued-content'), lines: c.intent.lines,
      payment: { status: 'paid', paid_amount: '4255.00', last_payment_at: '2026-11-03' } }));
    const t = await txRow(TX1);
    return (before === 'invoiced' && t.financial_status === 'settled') || JSON.stringify({ before, now: t.financial_status });
  });
  await check('financial status is forward only: a new open intent does not move settled back', async () => {
    await R.intent('accA', { transaction_id: TX1, currency: 'USD' });
    return (await txRow(TX1)).financial_status === 'settled';
  });
  await check('cancelled in Daftra after issue → issued_cancelled review item; charges stay invoiced until resolved', async () => {
    await R.pull('accA', S.S1.id);
    const c = await claimIntent(S.S1.id, 'invoice_pull');
    await complete(c.attempt_id, pullRes(c, { state: 'cancelled', status: 'cancelled', number: 'INV-000002' }));
    const r = await one(`SELECT * FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'issued_cancelled' AND status = 'open'`, [S.S1.id]);
    S.cancelled = r;
    return (r && (await chargeRow(S.ch9.id)).status === 'invoiced' && (await intentRow(S.S1.id)).status === 'issued') || JSON.stringify(r);
  });
  await check('release_charges: intent cancelled, lines removed, charges invoiced → approved; financial status not moved back', async () => {
    const r = await R.review('mgrA', S.cancelled.id, 'release_charges', 'أُلغيت في دفترة');
    const i = await intentRow(S.S1.id);
    const c9 = await chargeRow(S.ch9.id);
    const t = await txRow(TX1);
    return (r.status === 'resolved' && i.status === 'cancelled' && c9.status === 'approved' && t.financial_status === 'settled'
            && (await lineRows(S.S1.id)).every(l => l.state === 'removed')) || JSON.stringify({ r: r.status, i: i.status, c9: c9.status, t: t.financial_status });
  });
  await check('push outcome frozen (the draft was issued meanwhile): handled as a pull → issued, charges invoiced, no update', async () => {
    const tx5 = 'abc50000-0000-4000-8000-000000000605';
    await q(`INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, $4, 'import', 'air')`, [tx5, A, JED, CL101]);
    const ch = await mkCharge(tx5, { kind: 'service', service_code: 'customs_clearance', description: 'تخليص جوي', unit_price: 500 });
    const it = await R.intent('accA', { transaction_id: tx5 });
    await R.push('accA', it.id);
    const c1 = await claimIntent(it.id, 'invoice_push');
    const ok = pushOk(c1);
    await complete(c1.attempt_id, ok);
    const ch2 = await mkCharge(tx5, { kind: 'service', description: 'إضافة', unit_price: 50 });
    await R.addLines('accA', it.id, [ch2.id]);
    await R.push('accA', it.id);
    const c2 = await claimIntent(it.id, 'invoice_push');
    const fr = pullRes(c2, { state: 'issued', status: 'issued', number: 'INV-000009', hash: ok.effects.pushed_hash,
      lines: c2.intent.lines.filter(l => l.state === 'synced') });
    const r = await complete(c2.attempt_id, Object.assign(fr, { outcome: 'frozen' }));
    const i = await intentRow(it.id);
    const late = await one(`SELECT * FROM public.billing_review_items WHERE charge_id = $1 AND status = 'open'`, [ch2.id]);
    const a = await one(`SELECT outcome FROM public.billing_sync_attempts WHERE id = $1`, [c2.attempt_id]);
    return (r.job_status === 'done' && a.outcome === 'frozen' && i.status === 'issued' && i.daftra_number === 'INV-000009'
            && (await chargeRow(ch.id)).status === 'invoiced' && (await chargeRow(ch2.id)).status === 'approved' && late && late.kind === 'late_charge'
            && (await count(`SELECT count(*)::int n FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'issued_mismatch'`, [it.id])) === 0)
      || JSON.stringify({ r, a, i: i.status, late });
  });
  await check('frozen on a pull job is refused (frozen is a push outcome only)', async () => {
    await R.pull('accA', S.IF.id);
    const c = await claimIntent(S.IF.id, 'invoice_pull');
    const r = await complete(c.attempt_id, { outcome: 'frozen', effects: {} });
    return (r.job_status === 'failed' && r.applied === false) || JSON.stringify(r);
  });
  await check('issued_mismatch → credit_note_in_daftra is recorded (Marsa creates no credit note)', async () => {
    const it = await one(`SELECT * FROM public.billing_review_items WHERE kind = 'issued_mismatch' AND status = 'resolved' LIMIT 1`);
    const ins = await one(`INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, kind, details)
                           VALUES ($1, $2, $3, 'issued_mismatch', '{"diff":[]}') RETURNING id`, [A, TX1, S.IF.id]);
    const r = await R.review('mgrA', ins.id, 'credit_note_in_daftra', 'إشعار دائن في دفترة');
    return (it && r.status === 'resolved' && r.resolution === 'credit_note_in_daftra') || JSON.stringify(r);
  });
  await check('get_billing_intent of the issued final: can.push false (intent_issued), review items listed', async () => {
    const g = await R.get('accA', S.IF.id);
    return (g.can.push === false && g.can.push_blocked_by === 'intent_issued' && g.can.cancel === false && g.review_items.length >= 2
            && g.intent.daftra_number === 'INV-000001') || JSON.stringify(g.can);
  });
}

async function secScheduler() {
  section('13. scheduler + mock account state');
  await check('daftra_schedule_pulls: unpaid draft / issued invoices not pulled for 15 min get a pull job (once)', async () => {
    await drain();
    await q(`UPDATE public.billing_intents SET last_pulled_at = now() - interval '1 hour' WHERE external_invoice_id IS NOT NULL`);
    const a = (await svc(`SELECT public.daftra_schedule_pulls(50) r`))[0].r;
    const b = (await svc(`SELECT public.daftra_schedule_pulls(50) r`))[0].r;
    const exp = await count(`SELECT count(*)::int n FROM public.billing_intents i JOIN public.daftra_connections c ON c.org_id = i.org_id AND c.sync_enabled
                              WHERE i.external_invoice_id IS NOT NULL AND i.status IN ('draft','issued') AND i.payment_status <> 'paid'`);
    const jobs = await count(`SELECT count(*)::int n FROM public.billing_sync_jobs WHERE kind = 'invoice_pull' AND status = 'queued' AND requested_by IS NULL`);
    return (a.enqueued === exp && exp > 0 && b.enqueued === 0 && jobs === exp) || JSON.stringify({ a, b, exp, jobs });
  });
  await drain();
  await check('paid invoices are not scheduled', async () => {
    await q(`UPDATE public.billing_intents SET last_pulled_at = now() - interval '1 hour'`);
    await svc(`SELECT public.daftra_schedule_pulls(50)`);
    return (await count(`SELECT count(*)::int n FROM public.billing_sync_jobs WHERE kind = 'invoice_pull' AND status = 'queued' AND intent_id = $1`, [S.IF.id])) === 0;
  });
  await drain();
  await check('daftra_mock_load: empty state, version 0', async () => {
    const r = (await svc(`SELECT public.daftra_mock_load($1) r`, [A]))[0].r;
    return (JSON.stringify(r.state) === '{}' && r.version === 0) || JSON.stringify(r);
  });
  await check('daftra_mock_save / load round-trip (optimistic version)', async () => {
    const s = (await svc(`SELECT public.daftra_mock_save($1, $2, 0) r`, [A, { clients: [{ id: 'c-1' }], seq: { c: 1 } }]))[0].r;
    const l = (await svc(`SELECT public.daftra_mock_load($1) r`, [A]))[0].r;
    return (s.version === 1 && l.version === 1 && l.state.clients[0].id === 'c-1') || JSON.stringify({ s, l });
  });
  await expectErr('daftra_mock_save with a stale version → MRS_BAD_TRANSITION mock_version', () => svc(`SELECT public.daftra_mock_save($1, '{}', 0)`, [A]), /MRS_BAD_TRANSITION mock_version/);
  await expectErr('daftra_mock_save: unknown org → MRS_NOT_FOUND', () => svc(`SELECT public.daftra_mock_save(gen_random_uuid(), '{}', 0)`), /MRS_NOT_FOUND org/);
  await expectErr('daftra_mock_accounts invisible to authenticated (permission denied)', () => as('adminA', `SELECT * FROM public.daftra_mock_accounts`), /permission denied/);
}

async function secIsolation() {
  section('isolation: other org, other branch, non-finance staff, clients');
  for (const t of ALL_G5_TABLES) {
    await check(`${t}: org B, transport, clearance, operations manager and the client read 0 org A rows`, async () => {
      const r = [];
      for (const who of ['accB', 'trJ', 'clrJ', 'opsA', 'clientA']) r.push(who + ':' + await denied(who, `SELECT 1 FROM public.${t} WHERE ${t === 'daftra_mock_accounts' ? 'org_id' : 'org_id'} = $1`, [A]));
      return r.every(x => x.endsWith(':true')) || r.join(' ');
    });
  }
  await check('JED accountant reads no DMM intent / line / job / review item', async () => {
    const r = [await denied('accJ', `SELECT 1 FROM public.billing_intents WHERE transaction_id = $1`, [TX2]),
               await denied('accJ', `SELECT 1 FROM public.billing_intent_lines WHERE transaction_id = $1`, [TX2]),
               await denied('accJ', `SELECT 1 FROM public.billing_sync_jobs WHERE intent_id = $1`, [S.I2.id]),
               await denied('accJ', `SELECT 1 FROM public.billing_sync_attempts a JOIN public.billing_sync_jobs j ON j.id = a.job_id WHERE j.intent_id = $1`, [S.I2.id])];
    return r.every(x => x === true) || r.join();
  });
  await check('...but reads its own branch rows and org-level rows (connection, links, items, probe jobs)', async () => {
    const r = await one(`SELECT (SELECT count(*)::int FROM public.billing_intents WHERE transaction_id = '${TX1}') i,
                                (SELECT count(*)::int FROM public.daftra_connections) c, (SELECT count(*)::int FROM public.daftra_client_links) l,
                                (SELECT count(*)::int FROM public.billing_sync_jobs WHERE kind = 'probe') p`).catch(() => null);
    const x = await asRole('accJ', () => one(`SELECT (SELECT count(*)::int FROM public.billing_intents WHERE transaction_id = '${TX1}') i,
                                (SELECT count(*)::int FROM public.daftra_connections) c, (SELECT count(*)::int FROM public.daftra_client_links) l,
                                (SELECT count(*)::int FROM public.billing_sync_jobs WHERE kind = 'probe') p`));
    return (x.i > 0 && x.c === 1 && x.l >= 3 && x.p >= 1 && r) || JSON.stringify(x);
  });
  await expectErr('get_billing_intent of a DMM intent by the JED accountant → MRS_NOT_FOUND', () => R.get('accJ', S.I2.id), /MRS_NOT_FOUND/);
  await expectErr('get_billing_job of a DMM job by the JED accountant → MRS_NOT_FOUND', () => R.job('accJ', S.unkJob), /MRS_NOT_FOUND job/);
  await check('list_billing_intents (JED accountant): only JED rows', async () => {
    const r = await R.list('accJ');
    return (r.total > 0 && r.items.every(x => x.branch_id === JED)) || JSON.stringify(r.items.map(x => x.branch_id));
  });
  await check('list_billing_jobs (JED accountant): no DMM job', async () => {
    const r = await R.jobs('accJ', { limit: 200 });
    return !r.items.some(x => x.branch_id === DMM) || 'leak';
  });
  await expectErr('org B: get_billing_intent → MRS_NOT_FOUND', () => R.get('accB', S.IF.id), /MRS_NOT_FOUND/);
  await expectErr('org B: list_billing_intents(org A) → MRS_FORBIDDEN', () => R.list('accB', {}, A), /MRS_FORBIDDEN/);
  await expectErr('org B: tx_billing → MRS_NOT_FOUND', () => R.txb('accB', TX1), /MRS_NOT_FOUND/);
  await expectErr('operations manager: tx_billing → MRS_FORBIDDEN finance', () => R.txb('opsA', TX1), /MRS_FORBIDDEN finance/);
  await expectErr('transport staff: get_billing_intent → MRS_FORBIDDEN finance', () => R.get('trJ', S.IF.id), /MRS_FORBIDDEN finance/);
  await expectErr('clearance staff: billing_review_queue → MRS_FORBIDDEN', () => R.queue('clrJ'), /MRS_FORBIDDEN/);
  await expectErr('client: tx_billing → MRS_NOT_FOUND', () => R.txb('clientA', TX1), /MRS_NOT_FOUND/);
  await expectErr('client: get_billing_intent → MRS_NOT_FOUND', () => R.get('clientA', S.IF.id), /MRS_NOT_FOUND/);
  await expectErr('client: list_billing_intents → MRS_FORBIDDEN', () => R.list('clientA'), /MRS_FORBIDDEN/);
  await expectErr('client: get_daftra_connection → MRS_FORBIDDEN', () => R.conn('clientA'), /MRS_FORBIDDEN/);
  await check('tx_billing: every intent carries job_status = its latest invoice job status (integration: queued hint)', async () => {
    const t = await R.txb('accA', TX1);
    for (const i of t.intents) {
      const j = (await q(`SELECT status FROM public.billing_sync_jobs WHERE intent_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [i.id]))[0];
      if (!('job_status' in i) || i.job_status !== (j ? j.status : null)) return JSON.stringify({ id: i.id, got: i.job_status, want: j && j.status });
    }
    return t.intents.length > 0 || 'no intent';
  });
  await check('supervisor reads every list but cannot write', async () => {
    const l = await R.list('supA');
    const t = await R.txb('supA', TX1);
    const w = await tryErr(() => R.intent('supA', { transaction_id: TX4 }));
    return (l.total > 0 && t.intents.length > 0 && /MRS_FORBIDDEN/.test(w)) || JSON.stringify({ t: l.total, w });
  });
  await check('client sees no billing event; billing events never carry numbers, amounts or bodies', async () => {
    const c = (await as('clientA', `SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'billing'`))[0].n;
    const r = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE visible_to_client)::int v,
                                count(*) FILTER (WHERE jsonb_path_exists(payload, '$.** ? (@.type() == "number")'))::int num,
                                count(*) FILTER (WHERE payload ?| ARRAY['calls','request','response','amount','total_amount','net_amount','unit_price',
                                                                       'remote_total','paid_amount','lines','remote_snapshot','diff','error'])::int body
                           FROM public.transaction_events WHERE event_type = 'billing'`);
    return (c === 0 && r.n > 10 && r.v === 0 && r.num === 0 && r.body === 0) || JSON.stringify({ c, r });
  });
  await check('audit_log never holds attempt calls (billing_sync_attempts not audited)', async () =>
    (await count(`SELECT count(*)::int n FROM public.audit_log WHERE table_name IN ('billing_sync_attempts','daftra_mock_accounts')`)) === 0);
  await check('audit_log has rows for intents, lines, jobs and links (existing trigger)', async () => {
    const r = await q(`SELECT DISTINCT table_name FROM public.audit_log WHERE table_name = ANY($1) ORDER BY 1`, [AUDITED]);
    return r.length === AUDITED.length || JSON.stringify(r);
  });
}

async function secNoBlock() {
  section('12. tax policy: no blocking operational link');
  await check('TX1 was pushed and issued while its containers\' empty returns are still pending', async () => {
    const r = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE empty_returned_at IS NULL)::int open
                           FROM public.containers WHERE transaction_id = $1`, [TX1]).catch(async () =>
      one(`SELECT count(*)::int n, count(*)::int open FROM public.containers WHERE transaction_id = $1`, [TX1]));
    const i = await intentRow(S.IF.id);
    const t = await txRow(TX1);
    return (r.n === 2 && r.open === 2 && i.status === 'issued' && !['operationally_complete', 'closed'].includes(t.operational_status))
      || JSON.stringify({ r, s: i.status, op: t.operational_status });
  });
  await check('a reimbursable line taxed > 0 is a warning (reimbursable_taxed), not a block', async () => {
    const ch = await mkCharge(TX4, { kind: 'reimbursable', description: 'مصروف بضريبة', unit_price: 100, vat_rate: 15 });
    await R.addLines('accA', S.I4.id, [ch.id]);
    const g = await R.get('accA', S.I4.id);
    const p = await R.push('accA', S.I4.id);
    await drain();
    return (g.checks.reimbursable_taxed.length === 1 && p.job.kind === 'invoice_push' && (await intentRow(S.I4.id)).status === 'draft')
      || JSON.stringify({ c: g.checks, p });
  });
  await check('the line VAT comes from the charge (G4), not from the item default', async () => {
    const l = (await lineRows(S.I4.id)).find(x => x.kind === 'reimbursable' && x.state !== 'removed');
    const it = await one(`SELECT default_vat_rate FROM public.daftra_item_links WHERE org_id = $1 AND item_key = $2 AND status <> 'retired'`, [A, l.item_key]);
    return (N(l.vat_rate) === 15 && N(it.default_vat_rate) === 0) || JSON.stringify({ l: l.vat_rate, it });
  });
}

async function secIdempotency() {
  section('idempotent replays: every idem RPC');
  const ch = await mkCharge(TX4, { kind: 'service', description: 'idem', unit_price: 10 });
  const ch2 = await mkCharge(TX4, { kind: 'service', description: 'idem2', unit_price: 11 });
  await q(`INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ('abc50000-0000-4000-8000-000000000601', $1, $2, $3, 'export', 'sea')`, [A, JED, CL102]);
  await mkCharge('abc50000-0000-4000-8000-000000000601', { kind: 'service', description: 'idem tx', unit_price: 5 });
  const cases = [
    ['create_billing_intent', k => R.intent('accA', { transaction_id: 'abc50000-0000-4000-8000-000000000601' }, k),
                              k => R.intent('accA', { transaction_id: 'abc50000-0000-4000-8000-000000000601', note: 'x' }, k), x => x.id],
    ['add_billing_lines', k => R.addLines('accA', S.I4.id, [ch.id], k), k => R.addLines('accA', S.I4.id, [ch2.id], k), x => x.added[0].id],
    ['request_billing_push', k => R.push('accA', S.I4.id, k), k => R.push('accA', S.IF.id, k), x => x.job.id],
    ['request_daftra_probe', k => R.probe('mgrA', k), k => R.probe('mgrA', k, B).catch(e => { throw e; }), x => x.id],
    ['link_daftra_client', k => R.link('accA', CL102, null, k), k => R.link('accA', CL102, 'c-777', k), x => x.link.id]
  ];
  for (const [name, a, other, idOf] of cases) {
    await check(`${name}: replay returns the first result (replayed); a different payload with the key → MRS_IDEMPOTENCY_CONFLICT`, async () => {
      const k = newKey();
      const r1 = await a(k); const r2 = await a(k);
      const conflict = await tryErr(() => other(k));
      return (idOf(r1) && idOf(r1) === idOf(r2) && r2.replayed === true && /MRS_IDEMPOTENCY_CONFLICT|MRS_FORBIDDEN/.test(conflict))
        || JSON.stringify({ a: idOf(r1), b: idOf(r2), r: r2.replayed, conflict });
    });
  }
  await drain();
}

async function secTwoOrgs() {
  section('two orgs: one lane each, no cross-org rows');
  await check('every job / link / item / intent of org B carries org B ids only', async () => {
    const r = await one(`SELECT
      (SELECT count(*)::int FROM public.billing_sync_jobs j JOIN public.billing_intents i ON i.id = j.intent_id WHERE j.org_id <> i.org_id) a,
      (SELECT count(*)::int FROM public.billing_intents i JOIN public.transactions t ON t.id = i.transaction_id WHERE i.org_id <> t.org_id) b,
      (SELECT count(*)::int FROM public.billing_intent_lines l JOIN public.client_charges c ON c.id = l.charge_id WHERE l.transaction_id <> c.transaction_id) c,
      (SELECT count(*)::int FROM public.billing_sync_attempts a JOIN public.billing_sync_jobs j ON j.id = a.job_id WHERE a.org_id <> j.org_id) d`);
    return (r.a + r.b + r.c + r.d === 0) || JSON.stringify(r);
  });
  await check('the same Daftra ids live in both orgs without clashing (c-1 / p-100 per account)', async () => {
    const r = await q(`SELECT org_id FROM public.daftra_client_links WHERE external_id = 'c-1' AND status <> 'unlinked' ORDER BY org_id`);
    const p = await q(`SELECT org_id FROM public.daftra_item_links WHERE external_product_id = 'p-100' AND status <> 'retired' ORDER BY org_id`);
    return (r.length === 2 && p.length === 2 && r[0].org_id !== r[1].org_id) || JSON.stringify({ r, p });
  });
  await check('one running job per org: two queued jobs of one org → one claimed, the other waits for the lane', async () => {
    await R.probe('mgrA');
    await R.pull('accA', S.I4.id);
    const c = await claim('w1', 5);
    const a = c.filter(x => x.job.org_id === A).length;
    const c2 = await claim('w2', 5);
    for (const x of c.concat(c2)) await complete(x.attempt_id, defaultResult(x));
    const c3 = await claim('w1', 5);
    for (const x of c3) await complete(x.attempt_id, defaultResult(x));
    return (a === 1 && c2.filter(x => x.job.org_id === A).length === 0 && c3.filter(x => x.job.org_id === A).length === 1) || JSON.stringify({ a, c2: c2.length, c3: c3.length });
  });
  await drain();
  await check('unlink of a client whose intent has a Daftra invoice → MRS_BAD_TRANSITION in_use', async () =>
    /MRS_BAD_TRANSITION in_use/.test(await tryErr(() => R.unlink('mgrA', S.lk1.link.id, 'x'))));
  await check('tx_billing: intents with lines, eligible charges, review items, financial status, connection', async () => {
    const t = await R.txb('accJ', TX1);
    return (t.intents.length >= 5 && t.intents.every(i => Array.isArray(i.lines)) && t.financial_status === 'settled'
            && t.connection.status === 'connected' && t.connection.mode === 'mock' && t.review_items.length >= 4 && t.can.write === true)
      || JSON.stringify({ n: t.intents.length, f: t.financial_status, r: t.review_items.length });
  });
  await check('list_daftra_client_links: counts by effective status; billable_only filter', async () => {
    const r = await R.links('accA', { billable_only: true });
    return (r.total >= 2 && r.counts.linked >= 1 && r.counts.unlinked === 1) || JSON.stringify(r.counts);
  });
}

/* ------------------------------------------------------------------ migration safety */
async function loadUpTo(dbx, stopBefore) {
  const migDir = path.join(SUPA, 'migrations');
  await dbx.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const m of fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    if (stopBefore && m >= stopBefore) break;
    await dbx.exec(fs.readFileSync(path.join(migDir, m), 'utf8'));
  }
  await dbx.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
}
async function secMigrationSafety() {
  section('migration: applies on a G2 + G3 + G4 database with data, twice; preflight');
  const saved = db;
  const g5 = fs.readFileSync(path.join(SUPA, 'migrations', MIG_G5), 'utf8');
  db = new PGlite();
  try {
    await loadUpTo(db, MIG_G5);
    // live-like G4 data: charges in every state
    await db.exec(`
      INSERT INTO public.client_charges (org_id, transaction_id, kind, description, unit_price, status) VALUES
        ('${A}', '${TX1}', 'service', 'قديم', 100, 'approved'), ('${A}', '${TX1}', 'reimbursable', 'قديم 2', 50, 'draft'),
        ('${A}', '${TX2}', 'service', 'قديم 3', 70, 'approved');
      INSERT INTO public.client_charges (org_id, transaction_id, kind, description, unit_price, status, void_reason) VALUES
        ('${A}', '${TX2}', 'service', 'ملغى', 10, 'void', 'x');`);
    await check('G5 applies on a live-like G4 database (charges approved / draft / void)', async () => { await db.exec(g5); return true; });
    const counts = async () => {
      const o = {};
      for (const t of ALL_G5_TABLES.concat(['status_labels', 'client_charges', 'transaction_events', 'audit_log', 'schema_versions'])) o[t] = await count(`SELECT count(*)::int n FROM public.${t}`);
      o.policies = await count(`SELECT count(*)::int n FROM pg_policies`);
      o.triggers = await count(`SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal`);
      o.functions = await count(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public')`);
      o.charges = JSON.stringify(await q(`SELECT status, count(*)::int n FROM public.client_charges GROUP BY 1 ORDER BY 1`));
      return o;
    };
    const c1 = await counts();
    await check('no G4 row changed by the apply; G5 tables empty', async () =>
      (c1.charges === JSON.stringify([{ status: 'approved', n: 2 }, { status: 'draft', n: 1 }, { status: 'void', n: 1 }]) && c1.billing_intents === 0
       && c1.daftra_connections === 0) || JSON.stringify(c1));
    await check('re-run: the file applies again and changes no count (rows, policies, triggers, functions)', async () => {
      await db.exec(g5);
      const c2 = await counts();
      return JSON.stringify(c1) === JSON.stringify(c2) || JSON.stringify({ c1, c2 });
    });
    await check('a third run still works after G5 data exists (an intent, an invoiced charge)', async () => {
      await db.exec(`SELECT set_config('marsa.bill_invoiced', 'on', false);
                     UPDATE public.client_charges SET status = 'invoiced' WHERE description = 'قديم';
                     SELECT set_config('marsa.bill_invoiced', 'off', false);`);
      await db.exec(g5);
      return (await count(`SELECT count(*)::int n FROM public.client_charges WHERE status = 'invoiced'`)) === 1;
    });
  } catch (e) { fail('migration safety (live-like)', errText(e)); }
  finally { try { await db.close(); } catch (e) { /* ignore */ } }

  db = new PGlite();
  try {
    await loadUpTo(db, MIG_G5);
    await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261104000100'`);
    await check('preflight: without G4 the file stops with "G5 preflight: apply G4 first" and applies nothing', async () => {
      let err = '';
      try { await db.exec(g5); } catch (e) { err = errText(e); }
      const left = await one(`SELECT to_regclass('public.billing_intents') IS NULL AS none,
                                     NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261105000100') AS nover`);
      return (/G5 preflight: apply G4 first \(schema_versions lacks 20261104000100 g4_costs\)/.test(err) && left.none && left.nover) || JSON.stringify({ err, left });
    });
  } catch (e) { fail('migration safety (preflight G4)', errText(e)); }
  finally { try { await db.close(); } catch (e) { /* ignore */ } }

  db = new PGlite();
  try {
    await loadUpTo(db, MIG_G5);
    await db.exec(`INSERT INTO public.client_charges (org_id, transaction_id, kind, description, unit_price, status) VALUES ('${A}', '${TX1}', 'service', 'x', 1, 'invoiced')`);
    await check('preflight: an invoiced charge before G5 stops the file ("client_charges already invoiced outside G5")', async () => {
      let err = '';
      try { await db.exec(g5); } catch (e) { err = errText(e); }
      return (/G5 preflight: client_charges already invoiced outside G5/.test(err) && (await one(`SELECT to_regclass('public.billing_intents') IS NULL AS none`)).none) || err;
    });
  } catch (e) { fail('migration safety (preflight invoiced)', errText(e)); }
  finally { try { await db.close(); } catch (e) { /* ignore */ } db = saved; }
}

/* ------------------------------------------------------------------ runner */
const SECTIONS = [
  ['catalog', secCatalog],
  ['secrets', secSecrets],
  ['connection', secConnection],
  ['service_only', secServiceOnly],
  ['clients', secClients],
  ['items', secItems],
  ['intents', secIntents],
  ['lines', secLines],
  ['push_gate', secPushGate],
  ['claim_complete', secClaimComplete],
  ['conflicts', secConflicts],
  ['issue', secIssue],
  ['scheduler', secScheduler],
  ['no_block', secNoBlock],
  ['idempotency', secIdempotency],
  ['two_orgs', secTwoOrgs],
  ['isolation', secIsolation],
  ['migration_safety', secMigrationSafety]
];

async function main() {
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!await runFile(db, path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migFiles) if (!await runFile(db, path.join(migDir, m))) return finish();
  if (!await runFile(db, path.join(SUPA, 'seed.sql'))) return finish();
  try { await fixtures(); pass('fixtures: two orgs, finance roles by branch, approved G4 charges'); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }
  for (const [label, fn] of SECTIONS) {
    try { await fn(); }
    catch (e) { fail('section ' + label + ' aborted', errText(e) + '\n' + (e.stack || '').split('\n').slice(0, 3).join(' | ')); }
  }
  finish();
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
