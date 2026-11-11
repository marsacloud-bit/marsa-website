#!/usr/bin/env node
/*
  Marsa (مرسى) — G7 step ٥: isolation and permissions (docs/online/G7_SPEC.md § Tests "g7-isolation-tests.js").
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network, no keys.
  ADDS to rls-tests.js (does not duplicate it: §7 reads rls-tests.js TENANT_TABLES and skips what it already asserts).

  Data: org A = seed "blue-sea" with a full cycle in branch JED and another in branch DMM; org B = «مؤسسة تجريبية ب»
  (org-g7b / TSB) built only through RPCs, with a full cycle — all through lib/g7-cycle.js (real workers + mocks).

  Sections:
    1. generic RPC sweep: every public function executable by `authenticated`, called as A admin / A branch user /
       A client with arguments built from B's ids (uuid params by name, jsonb payloads with every known id key);
       pass = an MRS_* refusal, or a result that contains none of B's ids / refs / names; B's state hash unchanged
    2. platform admin sweep: every tenant table SELECT → 0 rows; every tenant RPC → refusal; platform outputs counts only
    3. branch sweep: every public table with a branch_id column, as branch-scoped users (JED / DMM)
    4. storage sweep: buckets documents / finance / messages (foreign prefix, mismatched id, .., %2e%2e, backslash,
       absolute, other bucket, update / delete, foreign select, client paths)
    5. messaging: threads / messages / attachments / replies across orgs and branches; client + anon see nothing;
       the G6b unique address does not leak the other org
    6. suspended org (G7): platform_suspend_org → every member + the client blocked, public tracking refused;
       platform_set_org_active(true) refused; platform_activate_org restores access
    7. direct API: INSERT / UPDATE / DELETE on every public table as each role against org B rows (skips the
       (table, role, op) triples rls-tests.js already asserts)

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g7-isolation-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const G7_MIGRATION = '20261108000100_g7_subscriptions.sql';

// No network anywhere: any fetch is a test failure (the workers are given no fetch).
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g7-isolation-tests'); };

const L = require(path.join(SUPA, 'tests', 'lib', 'g7-cycle.js'));

/* ------------------------------------------------------------------ helper block (g6b-cycle-tests.js) */
let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e) + (e && e.stack && !QUIET ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : '')); }
}
const J = x => JSON.stringify(x);

/* ------------------------------------------------------------------ ids (prefix c7i0…) */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const U = {
  P: 'c7a90000-0000-4000-8000-0000000000f1',
  A_admin: 'c7a90000-0000-4000-8000-000000000001', A_ops: 'c7a90000-0000-4000-8000-000000000002', A_clr: 'c7a90000-0000-4000-8000-000000000003',
  A_trn: 'c7a90000-0000-4000-8000-000000000004', A_acc: 'c7a90000-0000-4000-8000-000000000005', A_mgr: 'c7a90000-0000-4000-8000-000000000006',
  A_bm: 'c7a90000-0000-4000-8000-000000000007', A_client: 'c7a90000-0000-4000-8000-000000000008', A_sup: 'c7a90000-0000-4000-8000-000000000009',
  A_clrD: 'c7a90000-0000-4000-8000-00000000000a', A_trnD: 'c7a90000-0000-4000-8000-00000000000b', A_client2: 'c7a90000-0000-4000-8000-00000000000c',
  B_admin: 'c7a90000-0000-4000-8000-000000000011', B_ops: 'c7a90000-0000-4000-8000-000000000012', B_clr: 'c7a90000-0000-4000-8000-000000000013',
  B_trn: 'c7a90000-0000-4000-8000-000000000014', B_acc: 'c7a90000-0000-4000-8000-000000000015', B_mgr: 'c7a90000-0000-4000-8000-000000000016',
  B_bm: 'c7a90000-0000-4000-8000-000000000017', B_client: 'c7a90000-0000-4000-8000-000000000018', B_sup: 'c7a90000-0000-4000-8000-000000000019'
};
// "c7i0…" is the spec prefix for this suite; 'i' is not a hex digit, so the uuids use c7a9 (documented deviation)
const EMAIL = k => k.toLowerCase().replace('_', '.') + '@g7iso.example.com';
let keySeq = 0;
const newKey = () => `c7a9e000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;

let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function asService(fn) {
  await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
const num = async (sql, params) => Number((await q(sql, params))[0].n);
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
async function expectErr(name, promiseFn, re) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
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
const H = { q, one, num, rpc, as, asService, step, check, expectErr, pass, fail, section, errText, J, newKey, users: U };

/* ================================================================== org contexts */
const ORG_A = {
  key: 'A', id: A, slug: 'blue-sea', prefix: 'MRS', br1: JED, br2: DMM, tag: 'a9i',
  users: { admin: 'A_admin', ops: 'A_ops', clr: 'A_clr', trn: 'A_trn', acc: 'A_acc', mgr: 'A_mgr', bm: 'A_bm', client: 'A_client' },
  email: 'inbox@g7-a-iso.example', wa: '0500000731', waNorm: '+966500000731', phone: '0501117301', vat: '300000000730003', cr: '7000000731',
  bl: 'MEDUA9I0001', containers: [L.isoContainer('MSCU', 730001), L.isoContainer('MSCU', 730002)],
  attachClient: async (clientId) => {
    await q(`INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [A, clientId, U.A_client]);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'client')`, [U.A_client, A]);
  },
  d: {}
};
// the same org A, second cycle in branch DMM (branch-scoped DMM staff) — shares A's channels / directory / Daftra mock
const ORG_A2 = {
  key: 'A2', id: A, slug: 'blue-sea', prefix: 'MRS', br1: DMM, br2: JED, tag: 'a9d',
  users: { admin: 'A_admin', ops: 'A_ops', clr: 'A_clrD', trn: 'A_trnD', acc: 'A_acc', mgr: 'A_mgr', bm: 'A_bm', client: 'A_client2' },
  email: ORG_A.email, phone: '0501117302', vat: '300000000730013', cr: '7000000732',
  bl: 'MEDUA9D0001', containers: [L.isoContainer('TGHU', 730003), L.isoContainer('TGHU', 730004)],
  attachClient: async (clientId) => {
    await q(`INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [A, clientId, U.A_client2]);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'client')`, [U.A_client2, A]);
  },
  d: {}
};
const ORG_B = {
  key: 'B', id: null, slug: 'org-g7b', prefix: 'TSB', br1: null, br2: null, tag: 'b9i',
  users: { admin: 'B_admin', ops: 'B_ops', clr: 'B_clr', trn: 'B_trn', acc: 'B_acc', mgr: 'B_mgr', bm: 'B_bm', client: 'B_client', sup: 'B_sup' },
  email: 'inbox@org-g7b-iso.example', wa: '0500000742', waNorm: '+966500000742', phone: '0501117402', vat: '300000000740003', cr: '7000000742',
  bl: 'MEDUB9I0001', containers: [L.isoContainer('CAIU', 740001), L.isoContainer('CAIU', 740002)],
  attachClient: async (clientId) => {
    const inv = await rpc('B_admin', `SELECT public.admin_invite($1, $2) r`, [ORG_B.id, { email: EMAIL('B_client'), role: 'client', client_id: clientId, idempotencyKey: newKey() }]);
    await rpc('B_client', `SELECT public.accept_invitation($1) r`, [inv.token]);
  },
  d: {}
};

async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${EMAIL(k)}', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.P}', 'G7 isolation operator');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.A_admin}', '${A}', NULL, 'admin'), ('${U.A_ops}', '${A}', NULL, 'operations_manager'), ('${U.A_clr}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.A_trn}', '${A}', '${JED}', 'transport_staff'), ('${U.A_acc}', '${A}', NULL, 'accountant'), ('${U.A_mgr}', '${A}', NULL, 'accounts_manager'),
      ('${U.A_bm}', '${A}', '${JED}', 'branch_manager'), ('${U.A_sup}', '${A}', NULL, 'supervisor'),
      ('${U.A_clrD}', '${A}', '${DMM}', 'clearance_staff'), ('${U.A_trnD}', '${A}', '${DMM}', 'transport_staff');
  `);
  return one(`SELECT app.seed_document_requirements($1) n`, [A]);
}

/* ================================================================== B secrets (leak needles) */
let NEEDLES = [];
async function collectNeedles(tables) {
  const s = new Set();
  for (const t of tables) {
    if (t === 'organizations') continue;
    const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id' AND data_type = 'uuid'`, [t]);
    if (!cols.length) continue;
    for (const r of await q(`SELECT id::text id FROM public.${t} WHERE org_id = $1`, [ORG_B.id])) s.add(r.id);
  }
  s.add(ORG_B.id);
  for (const r of await q(`SELECT ref FROM public.transactions WHERE org_id = $1`, [ORG_B.id])) s.add(r.ref);
  for (const r of await q(`SELECT name_ar FROM public.clients WHERE org_id = $1`, [ORG_B.id])) s.add(r.name_ar);
  for (const r of await q(`SELECT container_no FROM public.containers WHERE org_id = $1`, [ORG_B.id])) s.add(r.container_no);
  s.add(ORG_B.bl); s.add('org-g7b'); s.add('مؤسسة تجريبية ب'); s.add(ORG_B.email);
  NEEDLES = [...s].filter(x => x && String(x).length >= 6);
  return NEEDLES.length;
}
const leaks = (result, argText) => { const t = J(result); return NEEDLES.filter(n => t.includes(n) && !argText.includes(n)); };

/* ================================================================== 1. generic RPC sweep */
const PUBLIC_BY_DESIGN = {
  health_check: 'public health probe (no tenant data)', invitation_preview: 'token-gated preview (anon)', public_track: 'ref + token gated (anon)',
  submit_service_request: 'public intake: any visitor may submit into an org with intake open (by design)',
  submit_contact_message: 'public contact form (by design)', log_client_error: 'client error log (own session only)'
};
let B_IDS = {};
async function collectBIds() {
  const b = ORG_B.d.cycle, d = ORG_B.d, B = ORG_B.id;
  const first = async (sql) => ((await q(sql, [B]))[0] || {}).id || null;
  const all = async (sql) => (await q(sql, [B])).map(x => x.id);
  B_IDS = {
    org: B, tx: b.tx, client: b.client, branch: ORG_B.br1, thread: b.thread, request: b.req.id, bl: b.bl, container: b.ct[0].id, trip: b.trips[0],
    appointment: b.appt, declaration: b.decl, invoice: b.inv, invoice_line: b.invLines[0], intent: b.intent, charge: b.charges[0], party: d.supplier,
    channel: d.chE.id, document: b.docs.bill_of_lading,
    billing_line: await first(`SELECT id::text id FROM public.billing_intent_lines WHERE org_id = $1 LIMIT 1`),
    message: await first(`SELECT id::text id FROM public.msg_messages WHERE org_id = $1 LIMIT 1`),
    summary: await first(`SELECT id::text id FROM public.msg_summaries WHERE org_id = $1 LIMIT 1`),
    extraction: await first(`SELECT id::text id FROM public.msg_extractions WHERE org_id = $1 LIMIT 1`),
    template: await first(`SELECT id::text id FROM public.msg_templates WHERE org_id = $1 LIMIT 1`),
    msg_job: await first(`SELECT id::text id FROM public.msg_jobs WHERE org_id = $1 LIMIT 1`),
    billing_job: await first(`SELECT id::text id FROM public.billing_sync_jobs WHERE org_id = $1 LIMIT 1`),
    attempt: await first(`SELECT id::text id FROM public.billing_sync_attempts WHERE org_id = $1 LIMIT 1`),
    link: await first(`SELECT id::text id FROM public.daftra_client_links WHERE org_id = $1 LIMIT 1`),
    membership: await first(`SELECT id::text id FROM public.memberships WHERE org_id = $1 AND role = 'clearance_staff' LIMIT 1`),
    invitation: await first(`SELECT id::text id FROM public.invitations WHERE org_id = $1 LIMIT 1`),
    accrual: await first(`SELECT id::text id FROM public.cost_accruals WHERE org_id = $1 LIMIT 1`),
    allocation: await first(`SELECT id::text id FROM public.cost_allocations WHERE org_id = $1 LIMIT 1`),
    finance_document: await first(`SELECT id::text id FROM public.finance_documents WHERE org_id = $1 LIMIT 1`),
    contact: d.contact && d.contact.id, address: d.address && d.address.id, reply: d.reply && d.reply.id,
    alert: await first(`SELECT id::text id FROM public.operational_alerts WHERE org_id = $1 LIMIT 1`),
    allocations: await all(`SELECT id::text id FROM public.cost_allocations WHERE org_id = $1`), charges: b.charges, documents: Object.values(b.docs), trips: b.trips
  };
}
function uuidFor(fn, arg) {
  const I = B_IDS, R = () => '00000000-0000-4000-8000-00000000dead';
  const byArg = { p_org: I.org, p_tx: I.tx, p_transaction_id: I.tx, p_client: I.client, p_branch: I.branch, p_thread: I.thread, p_reply: I.reply, p_invoice: I.invoice,
    p_intent: I.intent, p_request_id: I.request, p_container: I.container, p_bl: I.bl, p_party: I.party, p_contact: I.contact, p_address: I.address,
    p_channel: I.channel, p_message: I.message, p_summary: I.summary, p_link: I.link, p_membership: I.membership, p_invitation: I.invitation, p_attempt: I.attempt,
    p_summary_id: I.summary };
  if (arg === 'p_line') return /billing/.test(fn) ? I.billing_line : I.invoice_line;
  if (arg === 'p_job') return /msg/.test(fn) ? I.msg_job : I.billing_job;
  if (arg in byArg) return byArg[arg] || R();
  if (arg === 'p_id') {
    const map = [[/invoice_line/, I.invoice_line], [/supplier_invoice/, I.invoice], [/trip/, I.trip], [/appointment/, I.appointment], [/declaration/, I.declaration],
      [/billing_intent/, I.intent], [/billing_job/, I.billing_job], [/charge/, I.charge], [/alert/, I.alert], [/accrual/, I.accrual], [/allocation/, I.allocation],
      [/finance_document/, I.finance_document], [/msg_extraction/, I.extraction], [/msg_template|msg_instruction/, I.template], [/msg_contact/, I.contact],
      [/msg_thread/, I.thread], [/demurrage|exception|payment|collection|adjustment|authorization/, null]];
    for (const [re, v] of map) if (re.test(fn)) return v || I.tx;
    return I.tx;
  }
  return I.tx;
}
function uuidArrFor(fn, arg) {
  if (arg === 'p_charge_ids') return B_IDS.charges;
  if (arg === 'p_document_ids') return B_IDS.documents;
  if (fn === 'trip_finance') return B_IDS.trips;
  if (fn === 'approve_allocations') return B_IDS.allocations;
  return [B_IDS.tx];
}
const ID_KEYS = () => ({ org_id: B_IDS.org, transaction_id: B_IDS.tx, client_id: B_IDS.client, branch_id: B_IDS.branch, thread_id: B_IDS.thread, container_id: B_IDS.container,
  trip_id: B_IDS.trip, intent_id: B_IDS.intent, charge_id: B_IDS.charge, supplier_id: B_IDS.party, party_id: B_IDS.party, request_id: B_IDS.request, bl_id: B_IDS.bl,
  document_id: B_IDS.document, supplier_invoice_id: B_IDS.invoice, invoice_id: B_IDS.invoice, channel_id: B_IDS.channel, contact_id: B_IDS.contact,
  cost_allocation_id: B_IDS.allocation, accrual_id: B_IDS.accrual, finance_document_id: B_IDS.finance_document, line_id: B_IDS.invoice_line, id: B_IDS.tx,
  reply_id: B_IDS.reply, message_id: B_IDS.message, terminal_party_id: B_IDS.party, carrier_id: B_IDS.party, operator_id: B_IDS.party, related_invoice_id: B_IDS.invoice,
  evidence_document_id: B_IDS.document, return_instruction_document_id: B_IDS.document, amount: 1, kind: 'service', description: 'x', unit_price: 1 });
function jsonFor(fn, arg, src, minimal) {
  const all = ID_KEYS();
  let obj = all;
  if (minimal) {
    const m = src.match(/only_keys\(\s*p_payload\s*,\s*ARRAY\[([^\]]*)\]/) || src.match(/only_keys\(\s*\w+\s*,\s*ARRAY\[([^\]]*)\]/);
    const keys = m ? (m[1].match(/'([a-z_]+)'/g) || []).map(s => s.slice(1, -1)) : Object.keys(all).filter(k => src.includes("'" + k + "'"));
    obj = {};
    for (const k of keys) if (k in all) obj[k] = all[k];
  }
  if (/^p_(lines|targets|messages|events)$/.test(arg)) return [obj];
  return obj;
}
function textFor(fn, arg) {
  const b = ORG_B.d.cycle;
  const m = { p_ref: b.txRef, p_container_no: b.ct[0].container_no, p_status: 'approved', p_decision: 'approve', p_reason: 'x', p_note: 'x', p_table: 'transactions',
    p_token: '0'.repeat(64), p_method: 'callback', p_category: 'unknown', p_source: 'manual', p_worker: 'w', p_item_key: 'service:customs_clearance' };
  return arg in m ? m[arg] : null;
}
async function listRpcs() {
  return q(`SELECT p.oid, p.proname, coalesce(p.proargnames, '{}') argnames, array(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t) argtypes,
                   pg_get_function_identity_arguments(p.oid) ident, p.prosrc src
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prokind = 'f' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
             ORDER BY p.proname, ident`);
}
function buildCall(f, minimal) {
  const vals = [], casts = [];
  f.argtypes.forEach((t, i) => {
    const a = f.argnames[i] || ('$' + i);
    let v;
    if (t === 'uuid') v = uuidFor(f.proname, a);
    else if (t === 'uuid[]') v = uuidArrFor(f.proname, a);
    else if (t === 'jsonb' || t === 'json') v = J(jsonFor(f.proname, a, f.src, minimal));
    else if (t === 'text') v = textFor(f.proname, a);
    else if (t === 'text[]') v = ['x'];
    else if (t === 'integer' || t === 'bigint' || t === 'numeric' || t === 'smallint') v = 5;
    else if (t === 'boolean') v = false;
    else if (/^timestamp|^date/.test(t)) v = null;
    else v = null;
    vals.push(v); casts.push(`$${i + 1}::${t}`);
  });
  return { sql: `SELECT public.${f.proname}(${casts.join(', ')}) r`, vals, argText: J(vals) };
}
// review fix (§8 pairing): the result code of every (role, RPC, variant) call of §1 and §8
const CALLS = {};
const codeOf = r => r.ok ? 'OK' : ((r.e.match(/MRS_[A-Z_]+/) || [])[0] || (/permission denied|row-level security/.test(r.e) ? 'PERM' : 'ERR'));
function record(who, f, minimal, r) { (CALLS[who] = CALLS[who] || {})[f.proname + (minimal ? '[min]' : '')] = codeOf(r); }
async function callAs(who, f, minimal) {
  const c = buildCall(f, minimal);
  try { const r = await rpc(who, c.sql, c.vals); return { ok: true, r, argText: c.argText }; }
  catch (e) { return { ok: false, e: errText(e), argText: c.argText }; }
}
async function rpcSweep(tables) {
  section('1. generic RPC sweep: every public function executable by authenticated, called with org B ids');
  const fns = await listRpcs();
  const sweepable = fns.filter(f => !PUBLIC_BY_DESIGN[f.proname]);
  await check(`function catalog: ${fns.length} public functions executable by authenticated (${fns.length - sweepable.length} public-by-design skipped: ${Object.keys(PUBLIC_BY_DESIGN).join(', ')})`,
    () => fns.length >= 179 || 'only ' + fns.length);
  for (const who of ['A_admin', 'A_clr', 'A_client']) {
    const h0 = await L.stateHash(H, ORG_B.id, tables);
    const bad = [], refused = { mrs: 0, perm: 0 }, results = { clean: 0 };
    for (const f of sweepable) {
      for (const minimal of [false, true]) {
        if (minimal && !f.argtypes.some(t => t === 'jsonb')) continue;
        const r = await callAs(who, f, minimal);
        record(who, f, minimal, r);
        if (!r.ok) {
          if (/MRS_[A-Z_]+/.test(r.e)) refused.mrs++;
          else if (/permission denied|row-level security/.test(r.e)) refused.perm++;
          else bad.push(f.proname + (minimal ? '[min]' : '') + ': non-MRS error ' + r.e.slice(0, 140));
        } else {
          const lk = leaks(r.r, r.argText);
          if (lk.length) bad.push(f.proname + (minimal ? '[min]' : '') + ': result contains B data ' + J(lk.slice(0, 3)));
          else results.clean++;
        }
      }
    }
    await check(`${who}: ${sweepable.length} RPCs × payload variants with B ids → every call refused (MRS_*) or returned nothing of B ` +
      `(refused ${refused.mrs}, permission ${refused.perm}, clean results ${results.clean})`, () => bad.length === 0 || bad.join(' | '));
    const d = L.hashDiff(h0, await L.stateHash(H, ORG_B.id, tables));
    await check(`${who}: B state hash unchanged by the whole sweep`, () => d.length === 0 || d.join(', '));
  }
}

/* ================================================================== 2. platform admin sweep */
async function platformSweep(tables) {
  section('2. platform admin: no tenant rows, tenant RPCs refused, platform outputs = counts / metadata only');
  const seen = [];
  for (const t of tables) {
    try { const n = Number((await as('P', `SELECT count(*) n FROM public.${t}`))[0].n); if (n) seen.push(t + ':' + n); }
    catch (e) { if (!/permission denied/.test(errText(e))) seen.push(t + ': ' + errText(e).slice(0, 60)); }
  }
  await check(`platform admin: SELECT on every tenant table (${tables.length}) → 0 rows / permission denied`, () => seen.length === 0 || seen.join(', '));
  const fns = (await listRpcs()).filter(f => !PUBLIC_BY_DESIGN[f.proname] && !/^platform_/.test(f.proname));
  // legacy reports (20261124000100): otp_session_check describes only the caller's own session (amr / aal / memberships), no tenant row
  // legacy import (20261125000100): legacy_import_dictionary returns the static header dictionary + labels (no tenant row)
  const OWN_CONTEXT = ['my_context', 'otp_session_check', 'legacy_import_dictionary'];
  const bad = [];
  let n = 0;
  for (const f of fns) {
    const r = await callAs('P', f, false);
    n++;
    const empty = r.ok && (r.r === null || J(r.r) === '{}' || J(r.r) === '[]');
    if (r.ok) { if ((!OWN_CONTEXT.includes(f.proname) && !empty) || leaks(r.r, r.argText).length) bad.push(f.proname + ' returned ' + J(r.r).slice(0, 100)); }
    else if (!/MRS_[A-Z_]+|permission denied/.test(r.e)) bad.push(f.proname + ': ' + r.e.slice(0, 100));
  }
  await check(`platform admin: ${n} tenant RPCs with org B ids → refused or empty (my_context = own context only)`, () => bad.length === 0 || bad.join(' | '));
  // platform metadata the platform admin may see: the org itself + the G7 subscription rows (subscription_events ids)
  const g7Ids = new Set((await q(`SELECT id::text id FROM public.subscription_events WHERE org_id = $1`, [ORG_B.id]).catch(() => [])).map(x => x.id));
  const tenantNeedles = NEEDLES.filter(x => x !== ORG_B.id && x !== 'org-g7b' && x !== 'مؤسسة تجريبية ب' && !g7Ids.has(x));
  const plat = (await listRpcs()).filter(f => /^platform_/.test(f.proname));
  const pbad = [];
  for (const f of plat) {
    if (/^platform_(suspend|activate|set_org_active|create_org|save_plan|set_org_plan|reissue)/.test(f.proname)) continue;   // writers: exercised in §6
    const r = await callAs('P', f, false);
    if (r.ok) { const t = J(r.r); const hit = tenantNeedles.filter(x => t.includes(x)); if (hit.length) pbad.push(f.proname + ': ' + J(hit.slice(0, 3))); }
    else if (!/MRS_/.test(r.e)) pbad.push(f.proname + ': ' + r.e.slice(0, 80));
  }
  await check(`platform readers (${plat.length} platform_* RPCs, writers excluded) expose no tenant row ids / refs / client names / B/L / containers`, () => pbad.length === 0 || pbad.join(' | '));
  for (const who of ['A_admin', 'B_admin', 'A_client']) {
    const refused = [];
    for (const f of plat) { const r = await callAs(who, f, false); if (r.ok || !/MRS_FORBIDDEN/.test(r.e)) refused.push(f.proname + (r.ok ? ' OK' : ' ' + r.e.slice(0, 40))); }
    await check(`${who}: every platform_* RPC (${plat.length}) refused MRS_FORBIDDEN`, () => refused.length === 0 || refused.join(' | '));
  }
}

/* ================================================================== 3. branch sweep */
async function branchSweep() {
  section('3. branch sweep: tables with a branch_id column, as branch-scoped users');
  const tabs = (await q(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                          WHERE c.table_schema = 'public' AND c.column_name = 'branch_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`)).map(x => x.table_name);
  let nonVacuous = 0; const vac = [];
  for (const t of tabs) {
    const other = { A_clr: DMM, A_trn: DMM, A_bm: DMM, A_clrD: JED, A_trnD: JED };
    const own = { A_clr: JED, A_trn: JED, A_bm: JED, A_clrD: DMM, A_trnD: DMM };
    const nOther = await num(`SELECT count(*) n FROM public.${t} WHERE org_id = $1 AND branch_id = $2`, [A, DMM]) + await num(`SELECT count(*) n FROM public.${t} WHERE org_id = $1 AND branch_id = $2`, [A, JED]);
    if (nOther) nonVacuous++; else vac.push(t);
    const bad = [];
    for (const who of Object.keys(own)) {
      try {
        const r = await as(who, `SELECT branch_id, count(*)::int n FROM public.${t} GROUP BY 1`);
        for (const x of r) if (x.branch_id !== null && x.branch_id !== own[who]) bad.push(who + ' sees ' + x.n + ' row(s) of ' + (x.branch_id === other[who] ? 'the other branch' : x.branch_id));
      } catch (e) { if (!/permission denied/.test(errText(e))) bad.push(who + ': ' + errText(e).slice(0, 80)); }
    }
    await check(`${t}: branch-scoped users (JED ×3, DMM ×2) see only their branch or org-wide (NULL) rows [${nOther} A rows with a branch]`, () => bad.length === 0 || bad.join('; '));
  }
  console.log('  branch_id tables without A rows (checked, but vacuous here): ' + (vac.join(', ') || 'none'));
  await check(`branch sweep is not vacuous: ${nonVacuous} of ${tabs.length} branch_id tables hold rows of the A cycles`, () => nonVacuous >= Math.min(6, tabs.length) || 'only ' + nonVacuous + ' (no A rows with a branch: ' + vac.join(', ') + ')');
  await check('org-wide (NULL branch) rows are visible to branch staff only where decision 10 allows: transactions never NULL-branch', async () =>
    (await num(`SELECT count(*) n FROM public.transactions WHERE branch_id IS NULL`)) === 0);
  await check('a JED clearance user cannot open the DMM transaction (tx_checklist → MRS_NOT_FOUND / FORBIDDEN)', async () => {
    try { await rpc('A_clr', `SELECT public.tx_checklist($1) r`, [ORG_A2.d.cycle.tx]); return 'visible'; } catch (e) { return /MRS_NOT_FOUND|MRS_FORBIDDEN/.test(errText(e)) || errText(e); }
  });
}

/* ================================================================== 4. storage sweep */
async function storageSweep() {
  section('4. storage sweep: buckets documents / finance / messages');
  const b = ORG_B.d.cycle, a = ORG_A.d.cycle;
  const bDoc = await one(`SELECT id, storage_path FROM public.documents WHERE id = $1`, [b.docs.bill_of_lading]);
  const bFin = await one(`SELECT id, storage_path FROM public.finance_documents WHERE org_id = $1 LIMIT 1`, [ORG_B.id]);
  const aFin = await one(`SELECT id, storage_path FROM public.finance_documents WHERE org_id = $1 LIMIT 1`, [A]);
  // B objects exist (superuser = what the B uploads put there)
  await q(`INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('documents', $1, $3), ('finance', $2, $3)`, [bDoc.storage_path, bFin.storage_path, U.B_clr]);
  const bMsgPath = `${ORG_B.id}/${b.thread}/x/att.pdf`;
  await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('messages', $1)`, [bMsgPath]);
  // A: a freshly registered own document (the positive control)
  const api = L.orgApi(H, ORG_A);
  const ownId = await api.upload('clr', a.tx, 'packing_list');
  const own = await one(`SELECT storage_path FROM public.documents WHERE id = $1`, [ownId]);
  const objIns = (who, bucket, name) => as(who, `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ($1, $2, $3) RETURNING id`, [bucket, name, U[who]]);
  const refusedIns = async (label, who, bucket, name) => check(`${label} → refused`, async () => {
    try { await objIns(who, bucket, name); return 'accepted ' + bucket + ':' + name; } catch (e) { return /row-level security|permission denied/.test(errText(e)) || errText(e); }
  });
  const [o0, tx0, d0] = own.storage_path.split('/');
  await refusedIns('documents: object for org B\'s document path (foreign prefix)', 'A_clr', 'documents', bDoc.storage_path);
  await refusedIns('documents: own tx + B org prefix', 'A_clr', 'documents', `${ORG_B.id}/${tx0}/${d0}/packing_list.pdf`);
  await refusedIns('documents: mismatched document id in the path', 'A_clr', 'documents', `${o0}/${tx0}/${b.docs.bill_of_lading}/packing_list.pdf`);
  await refusedIns('documents: ".." segment', 'A_clr', 'documents', `${o0}/${tx0}/../${d0}/packing_list.pdf`);
  await refusedIns('documents: "%2e%2e" segment', 'A_clr', 'documents', `${o0}/${tx0}/%2e%2e/${d0}/packing_list.pdf`);
  await refusedIns('documents: backslash path', 'A_clr', 'documents', own.storage_path.replace(/\//g, '\\'));
  await refusedIns('documents: absolute path', 'A_clr', 'documents', '/' + own.storage_path);
  await refusedIns('documents: own valid path into bucket finance (other bucket)', 'A_clr', 'finance', own.storage_path);
  await refusedIns('documents: own valid path into bucket messages (service-only bucket)', 'A_clr', 'messages', own.storage_path);
  await refusedIns('finance: object for org B\'s finance document', 'A_acc', 'finance', bFin.storage_path);
  await refusedIns('finance: A finance path uploaded by another user (not the registrant)', 'A_mgr', 'finance', aFin.storage_path);
  await refusedIns('messages: any authenticated insert (service role only)', 'A_admin', 'messages', `${A}/${a.thread}/x/att.pdf`);
  await refusedIns('client: object for an org B path', 'A_client', 'documents', bDoc.storage_path);
  await check('positive control: A clearance uploads the bytes of its own freshly registered document', async () => (await objIns('A_clr', 'documents', own.storage_path)).length === 1);
  await check('documents rows with traversal / foreign paths are refused at the row level too (storage_path check)', async () => {
    const bad = [];
    for (const p of [`${ORG_B.id}/${a.tx}/{id}/f.pdf`, `${A}/${a.tx}/../{id}/f.pdf`, `${A}/${a.tx}/{id}/..\\f.pdf`, `/${A}/${a.tx}/{id}/f.pdf`, `${A}/${b.tx}/{id}/f.pdf`]) {
      const id = (await one(`SELECT gen_random_uuid()::text id`)).id;
      try {
        await as('A_clr', `INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, uploaded_by) VALUES ($1, $2, $3, 'other', $4, $5, 'f.pdf', 10, $6)`,
          [id, A, a.tx, p.replace('{id}', id), 'f'.repeat(64), U.A_clr]);
        bad.push('accepted ' + p);
      } catch (e) { /* refused */ }
    }
    return bad.length === 0 || bad.join('; ');
  });
  for (const who of ['A_clr', 'A_admin', 'A_client']) {
    await check(`${who}: UPDATE / DELETE of objects (own and foreign) touch 0 rows`, async () => {
      const r = [];
      for (const sql of [`UPDATE storage.objects SET name = name || 'x' RETURNING 1`, `DELETE FROM storage.objects RETURNING 1`]) {
        try { const x = await as(who, sql); if (x.length) r.push(sql.slice(0, 6) + ' ' + x.length); } catch (e) { if (!/permission denied/.test(errText(e))) r.push(errText(e).slice(0, 60)); }
      }
      return r.length === 0 || r.join(', ');
    });
    await check(`${who}: SELECT sees no org B object (documents / finance / messages)`, async () => {
      const r = await as(who, `SELECT bucket_id, name FROM storage.objects WHERE name LIKE $1`, [ORG_B.id + '/%']);
      return r.length === 0 || J(r);
    });
  }
  await check('A client sees only objects of its own client-visible / uploaded documents (none of the other A client, none of B)', async () => {
    const r = await as('A_client', `SELECT name FROM storage.objects`);
    return r.every(x => x.name.startsWith(A + '/' + a.tx + '/')) || J(r);
  });
}

/* ================================================================== 5. messaging */
async function messagingSweep() {
  section('5. messaging across orgs and branches');
  const tabs = ['msg_threads', 'msg_messages', 'msg_attachments', 'msg_extractions', 'msg_classifications', 'msg_summaries', 'msg_thread_links', 'msg_replies',
    'msg_reply_versions', 'msg_outbound', 'msg_channels', 'msg_contacts', 'msg_contact_addresses', 'msg_jobs', 'msg_ai_runs'];
  for (const who of ['A_admin', 'A_ops', 'A_clr', 'A_clrD']) {
    await check(`${who}: 0 org B rows in ${tabs.length} msg_* tables`, async () => {
      const out = [];
      for (const t of tabs) { try { const n = Number((await as(who, `SELECT count(*) n FROM public.${t} WHERE org_id = $1`, [ORG_B.id]))[0].n); if (n) out.push(t + ':' + n); } catch (e) { /* hidden */ } }
      return out.length === 0 || out.join(',');
    });
  }
  for (const who of ['A_client', 'B_client', 'anon']) {
    await check(`${who}: 0 rows of every msg_* table (any org)`, async () => {
      const out = [];
      for (const t of tabs) { try { const n = Number((await as(who, `SELECT count(*) n FROM public.${t}`))[0].n); if (n) out.push(t + ':' + n); } catch (e) { /* permission denied = hidden */ } }
      return out.length === 0 || out.join(',');
    });
  }
  const tD = ORG_A2.d.cycle.thread, tJ = ORG_A.d.cycle.thread;
  await check('the DMM-linked thread moved to branch DMM; the JED thread stays JED', async () => {
    const r = await q(`SELECT id, branch_id FROM public.msg_threads WHERE id = ANY ($1::uuid[])`, [[tD, tJ]]);
    return (r.find(x => x.id === tD).branch_id === DMM && r.find(x => x.id === tJ).branch_id === JED) || J(r);
  });
  await expectErr('JED clearance cannot open the DMM thread (get_msg_thread)', () => rpc('A_clr', `SELECT public.get_msg_thread($1) r`, [tD]), /MRS_NOT_FOUND/);
  await expectErr('DMM clearance cannot open the JED thread', () => rpc('A_clrD', `SELECT public.get_msg_thread($1) r`, [tJ]), /MRS_NOT_FOUND/);
  await check('DMM clearance opens its own thread', async () => !!(await rpc('A_clrD', `SELECT public.get_msg_thread($1) r`, [tD])).thread);
  await check('a reply drafted in DMM is invisible to JED staff (msg_replies + versions)', async () => {
    const rp = ORG_A2.d.reply;
    const j = await as('A_clr', `SELECT count(*)::int n FROM public.msg_replies WHERE id = $1`, [rp.id]);
    const v = await as('A_clr', `SELECT count(*)::int n FROM public.msg_reply_versions WHERE reply_id = $1`, [rp.id]);
    const d = await as('A_clrD', `SELECT count(*)::int n FROM public.msg_replies WHERE id = $1`, [rp.id]);
    return (j[0].n === 0 && v[0].n === 0 && d[0].n === 1) || J({ j, v, d });
  });
  await expectErr('B staff cannot list A threads', () => rpc('B_ops', `SELECT public.list_msg_threads($1, '{}') r`, [A]), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
  await expectErr('A ops cannot link B\'s thread to an A transaction', () => rpc('A_ops', `SELECT public.link_msg_thread($1, $2, 'x') r`, [ORG_B.d.cycle.thread, ORG_A.d.cycle.tx]), /MRS_NOT_FOUND|MRS_FORBIDDEN/);
  await expectErr('A ops cannot link A\'s thread to B\'s transaction', () => rpc('A_ops', `SELECT public.link_msg_thread($1, $2, 'x') r`, [tJ, ORG_B.d.cycle.tx]), /MRS_NOT_FOUND|MRS_INVALID|MRS_FORBIDDEN/);
  await check('G6b unique address: A admin registering B\'s inbox address → address_taken, the error names nothing of B', async () => {
    try { await rpc('A_admin', `SELECT public.save_msg_channel($1, $2, $3) r`, [A, { kind: 'email', name: 'نسخة البريد', address: ORG_B.email, mode: 'mock' }, newKey()]); return 'accepted'; }
    catch (e) { const t = errText(e); return (/address_taken/.test(t) && !/org-g7b|تجريبية ب|TSB-/.test(t) && !t.includes(ORG_B.id)) || t; }
  });
}

/* ================================================================== 6. suspended org */
async function suspendedSweep(tables, g7) {
  section('6. suspended org (G7): platform_suspend_org blocks every member and the client; activate restores');
  if (!g7) { fail('suspended org sweep', 'G7 migration absent — platform_suspend_org missing'); return; }
  const b = ORG_B.d.cycle;
  const members = Object.values(ORG_B.users);
  const visible = async who => {
    const out = [];
    for (const t of tables) {
      const col = t === 'organizations' ? 'id' : 'org_id';
      // own identity rows (the caller's own membership / client link) are "who am I" data, not tenant data
      const self = (t === 'memberships' || t === 'client_users') ? ` AND user_id <> '${U[who]}'` : '';
      try { const n = Number((await as(who, `SELECT count(*) n FROM public.${t} WHERE ${col} = $1${self}`, [ORG_B.id]))[0].n); if (n) out.push(t + ':' + n); } catch (e) { /* hidden */ }
    }
    return out;
  };
  const before = {};
  for (const who of members) before[who] = await visible(who);
  await check('before suspension every B member and the B client see B data (non-vacuous)', () => members.every(w => before[w].length > 0) || J(before));
  await expectErr('suspend needs a reason (MRS_NOTE_REQUIRED)', () => rpc('P', `SELECT public.platform_suspend_org($1, $2) r`, [ORG_B.id, ' ']), /MRS_NOTE_REQUIRED/);
  await step('platform admin: platform_suspend_org(B, reason)', () => rpc('P', `SELECT public.platform_suspend_org($1, $2) r`, [ORG_B.id, 'تعليق تجريبي لاختبار العزل']));
  for (const who of members) await check(`suspended: ${who} sees 0 rows of every tenant table of B`, async () => { const v = await visible(who); return v.length === 0 || v.join(','); });
  const calls = [['list_msg_threads', `SELECT public.list_msg_threads($1, '{}') r`, [ORG_B.id]], ['report_transactions', `SELECT public.report_transactions($1, '{}') r`, [ORG_B.id]],
    ['tx_checklist', `SELECT public.tx_checklist($1) r`, [b.tx]], ['get_billing_intent', `SELECT public.get_billing_intent($1) r`, [b.intent]],
    ['tx_margin', `SELECT public.tx_margin($1) r`, [b.tx]], ['admin_list_members', `SELECT public.admin_list_members($1) r`, [ORG_B.id]],
    ['dash_ops', `SELECT public.dash_ops($1, '{}') r`, [ORG_B.id]], ['portal_invoices', `SELECT public.portal_invoices($1) r`, [b.tx]]];
  for (const who of members) {
    await check(`suspended: ${who} refused by ${calls.length} tenant RPCs (or empty result)`, async () => {
      const bad = [];
      for (const [n, sql, p] of calls) {
        try { const r = await rpc(who, sql, p); const t = J(r); if (t.includes(b.txRef) || t.includes(b.tx)) bad.push(n + ' returned B data'); } catch (e) { if (!/MRS_/.test(errText(e))) bad.push(n + ': ' + errText(e).slice(0, 60)); }
      }
      return bad.length === 0 || bad.join('; ');
    });
  }
  // 20261113000100: a miss is the value {"not_found": true} (no longer the MRS_NOT_FOUND error)
  await check('suspended: public tracking of B refused ({"not_found": true})', async () => {
    const r = await rpc('anon', `SELECT public.public_track($1, $2) r`, [b.reqRef, b.token]);
    return (r && r.not_found === true && Object.keys(r).length === 1) || JSON.stringify(r);
  });
  await expectErr('suspended: public intake into B closed', () => rpc('anon', `SELECT public.submit_service_request($1) r`, [{ orgSlug: 'org-g7b', fullName: 'زائر', phone: '0509990001', email: 'v@x.example', company: 'x',
    direction: 'import', service: 'clearance', mode: 'sea', country: 'x', port: 'x', goods: 'بضاعة', terms: true }]), /MRS_INTAKE_CLOSED/);
  await expectErr('platform_set_org_active(B, true) refused while suspended (subscription_suspended)', () => rpc('P', `SELECT public.platform_set_org_active($1, true) r`, [ORG_B.id]), /subscription_suspended/);
  await check('org A unaffected while B is suspended (A admin still reads A)', async () => (await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [A])) > 0 &&
    Number((await as('A_admin', `SELECT count(*) n FROM public.transactions`))[0].n) > 0);
  await step('platform admin: platform_activate_org(B, reason)', () => rpc('P', `SELECT public.platform_activate_org($1, $2) r`, [ORG_B.id, 'انتهى اختبار العزل']));
  const names = v => v.map(x => x.split(':')[0]);
  for (const who of members) await check(`activated: ${who} sees B data again (the same tables as before the suspension)`, async () => { const v = await visible(who); return J(names(v)) === J(names(before[who])) || J({ before: names(before[who]), after: names(v) }); });
  await check('activated: public tracking of B works again', async () => !!(await rpc('anon', `SELECT public.public_track($1, $2) r`, [b.reqRef, b.token])));
  await check('subscription events suspended + activated recorded with actor + reason; audit rows on org_subscriptions', async () => {
    const ev = await q(`SELECT action, actor, reason FROM public.subscription_events WHERE org_id = $1 AND action IN ('suspended','activated') ORDER BY at`, [ORG_B.id]);
    const au = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'org_subscriptions' AND org_id = $1 AND action = 'UPDATE'`, [ORG_B.id]);
    return (ev.length === 2 && ev[0].action === 'suspended' && ev[1].action === 'activated' && ev.every(e => e.actor === U.P && e.reason) && au >= 2) || J({ ev, au });
  });
}

/* ================================================================== 7. direct API */
function rlsCovered() {
  const src = fs.readFileSync(path.join(SUPA, 'tests', 'rls-tests.js'), 'utf8');
  const start = src.indexOf('const TENANT_TABLES = [');
  const end = src.indexOf('];', start);
  const block = src.slice(start, end);
  const names = new Set((block.match(/\['([a-z_]+)',/g) || []).map(s => s.slice(2, -2)));
  for (const listName of ['G4_TABLES', 'G5_TABLES', 'G6B_TABLES']) {
    if (block.includes('...' + listName)) {
      const m = src.match(new RegExp('const ' + listName + ' = \\[([\\s\\S]*?)\\];'));
      if (m) for (const x of m[1].match(/'([a-z_]+)'/g) || []) names.add(x.slice(1, -1));
    }
  }
  // isolationSweep(who …) in rls-tests.js: staffA = clearance_staff (org-wide), adminA = admin, clientA = client → SELECT / UPDATE / DELETE by id
  return { tables: names, roles: ['A_admin', 'A_client'] };
}
// columns a copied row may carry: not identity, not generated
const COLS = {};
async function insertableCols(t) {
  if (!COLS[t]) COLS[t] = (await q(`SELECT column_name c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
      AND is_identity = 'NO' AND is_generated = 'NEVER' ORDER BY ordinal_position`, [t])).map(x => x.c);
  return COLS[t];
}
// state checked by business BEFORE triggers ahead of RLS (left to its column default so the copy reaches the WITH CHECK):
// a copied returned container would otherwise stop at the empty-return evidence rule, never at RLS
const OMIT_ON_COPY = { containers: ['evidence_document_id', 'return_status', 'operational_state', 'verified_by', 'verified_at', 'returned_at'] };
async function directApiSweep(tables) {
  section('7. direct API: INSERT / UPDATE / DELETE against org B rows on every public table (not already in rls-tests.js)');
  const cov = rlsCovered();
  await check(`rls-tests.js TENANT_TABLES parsed (${cov.tables.size} tables) to skip duplicates`, () => cov.tables.size >= 60 || 'parsed ' + cov.tables.size);
  const roles = ['A_admin', 'A_ops', 'A_clr', 'A_trn', 'A_acc', 'A_mgr', 'A_bm', 'A_sup', 'A_client'];
  const all = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map(x => x.table_name);
  const orgTables = new Set(tables);
  let ran = 0, skipped = 0;
  for (const t of all) {
    const col = t === 'organizations' ? 'id' : (orgTables.has(t) ? 'org_id' : null);
    const sample = col ? await one(`SELECT to_jsonb(x) j FROM public.${t} x WHERE x.${col} = $1 LIMIT 1`, [ORG_B.id]) : await one(`SELECT to_jsonb(x) j FROM public.${t} x LIMIT 1`);
    const bad = [];
    for (const who of roles) {
      const dup = cov.tables.has(t) && cov.roles.includes(who);
      // UPDATE / DELETE
      if (!dup && col) {
        for (const sql of [`UPDATE public.${t} SET ${col} = ${col} WHERE ${col} = $1 RETURNING 1`, `DELETE FROM public.${t} WHERE ${col} = $1 RETURNING 1`]) {
          ran++;
          try { const r = await as(who, sql, [ORG_B.id]); if (r.length) bad.push(who + ' ' + sql.slice(0, 6) + ' ' + r.length + ' row(s)'); }
          catch (e) { if (!/permission denied|row-level security|MRS_/.test(errText(e))) bad.push(who + ' ' + sql.slice(0, 6) + ': ' + errText(e).slice(0, 70)); }
        }
      } else if (dup) skipped += 2;
      // platform reference tables readable by every signed-in user by design: status_labels, customs_ports (20261117000100)
      if (!col && !cov.tables.has(t) && t !== 'status_labels' && t !== 'customs_ports') {
        ran++;
        try { const r = await as(who, `SELECT 1 FROM public.${t} LIMIT 1`); if (r.length && !['status_labels'].includes(t)) bad.push(who + ' SELECT no-API table ' + r.length); }
        catch (e) { if (!/permission denied/.test(errText(e))) bad.push(who + ' SELECT: ' + errText(e).slice(0, 60)); }
      }
      // INSERT a copy of a B row (new id) — rls-tests.js does not assert cross-org INSERT per table.
      // review fix: identity / generated columns are left out (they failed before RLS was reached), trigger-validated
      // references are cleared, and only a tenancy refusal counts: any other error is a FAIL (it would hide RLS)
      if (sample && sample.j) {
        const row = Object.assign({}, sample.j);
        if ('id' in row && typeof row.id === 'string' && /^[0-9a-f-]{36}$/.test(row.id)) row.id = (await one(`SELECT gen_random_uuid()::text id`)).id;
        const cols = (await insertableCols(t)).filter(c => !(OMIT_ON_COPY[t] || []).includes(c));
        const list = cols.map(c => '"' + c + '"').join(', ');
        ran++;
        try {
          await as(who, `INSERT INTO public.${t} (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::public.${t}, $1::jsonb)`, [J(row)]);
          bad.push(who + ' INSERT of a B row accepted');
        } catch (e) {
          const et = errText(e);
          if (!/permission denied|row-level security|MRS_FORBIDDEN|MRS_NOT_FOUND/.test(et)) bad.push(who + ' INSERT not-tenancy error: ' + et.slice(0, 110));
        }
      }
    }
    if (col || sample) await check(`${t}: ${roles.length} A roles cannot write org B rows (UPDATE / DELETE / INSERT)${cov.tables.has(t) ? ' [admin + client UPDATE / DELETE already in rls-tests.js]' : ''}`,
      () => bad.length === 0 || bad.join('; '));
  }
  await check(`direct API sweep ran ${ran} statements (${skipped} skipped as rls-tests.js duplicates)`, () => ran > 500 || 'only ' + ran);
  await check('G7 tables (plans, org_subscriptions, subscription_events, org_usage_counters): no API access for any role incl. platform admin', async () => {
    const bad = [];
    for (const t of ['plans', 'org_subscriptions', 'subscription_events', 'org_usage_counters']) for (const who of ['P', 'A_admin', 'B_admin', 'A_client', 'anon']) {
      try { await as(who, `SELECT 1 FROM public.${t} LIMIT 1`); bad.push(who + ' SELECT ' + t); } catch (e) { if (!/permission denied/.test(errText(e))) bad.push(who + ' ' + t + ': ' + errText(e).slice(0, 50)); }
    }
    return bad.length === 0 || bad.join(', ');
  });
}

/* ================================================================== 8. positive control (runs LAST: it may change B) */
// the same argument builder, called by B's own admin / ops / accountant with B's ids, must reach the business logic:
// shows, per RPC variant, which of §1's refusals come from the authorization checks (paired below), and names the rest
// RPC variants whose §1 refusal is NOT backed by §8 (B's own staff also stop at NOT_FOUND / FORBIDDEN with the generic
// builder: it sends a transaction id where the RPC expects an alert / exception / payment / case id, or an incomplete
// [min] payload). Their isolation is asserted by the dedicated suites (rls-tests, g3–g6b), not by this sweep.
const NOT_EXERCISED = ['accept_invitation', 'ack_alert', 'import_commit', 'portal_invoices', 'resolve_alert', 'resolve_billing_review',
  'resolve_exception', 'resolve_msg_send_unknown', 'retry_msg_send', 'review_cost_adjustment', 'review_msg_instruction', 'review_msg_template',
  'revoke_msg_authorization', 'set_demurrage_status', 'update_demurrage_case', 'update_demurrage_case[min]', 'void_charge_collection',
  'void_supplier_payment', 'save_bl[min]', 'save_msg_channel[min]', 'save_msg_contact[min]',
  // document matching (20261116000100): they take a match id (the builder sends a transaction id); isolation of the
  // matches (org, branch, client, anon) is asserted by doc-match-sql-tests.js
  'review_document_match', 'review_document_match[min]', 'void_document_match',
  // legacy docs (20261119000100): they take a doc batch / batch document / alias id (the builder sends a transaction id); isolation of
  // the batches, shipment data and aliases (org, branch, client, anon) is asserted by legacy-docs-sql-tests.js
  'approve_doc_batch', 'approve_doc_batch[min]', 'archive_doc_batch', 'attach_doc_batch_document', 'attach_doc_batch_document[min]',
  'detach_doc_batch_document', 'discard_doc_batch', 'get_doc_batch', 'merge_doc_batch', 'reject_client_alias', 'save_doc_batch_draft',
  'save_doc_batch_draft[min]',
  // legacy decl (20261120000100): they take a reading id (the builder sends a transaction id; the minimal payload has no version);
  // isolation of the readings, approvals, items and the HS library (org, branch, client, anon) is asserted by legacy-decl-sql-tests.js
  'approve_declaration_extraction[min]', 'get_declaration_review',
  // legacy appt (20261121000100): they take an appointment draft / proof id (the builder sends a transaction id; the minimal payload
  // has no key the RPC needs); isolation of the drafts, cards and proofs (org, branch, client, anon) is asserted by legacy-appt-sql-tests.js
  'approve_appointment_draft[min]', 'cancel_appointment_draft', 'get_appointment_draft', 'move_appointment_draft',
  'verify_empty_return_proof[min]', 'void_empty_return_proof',
  // legacy pay (20261122000100): they take a payment / attachment link / custody entry id (the builder sends another id; the minimal
  // payload has no key the RPC needs); isolation of the register, allocations, attachments and custody (org, branch, finance roles,
  // client, anon) is asserted by legacy-pay-sql-tests.js and rls-tests.js
  'add_payment_documents', 'add_payment_documents[min]', 'correct_payment', 'correct_payment[min]', 'get_payment', 'remove_payment_document',
  'review_payment', 'void_custody_entry', 'void_payment',
  // legacy daftra (20261123000100): they take a run / candidate / review item / trip id (the builder sends another id; the minimal payload
  // has no key the RPC needs); isolation of the runs, staging rows, candidates, supplier links and purchase drafts (org, branch, finance
  // roles, client, anon) is asserted by legacy-daftra-sql-tests.js and rls-tests.js
  'apply_daftra_client_import', 'apply_daftra_client_import[min]', 'confirm_invoice_link', 'confirm_invoice_link[min]', 'get_daftra_run',
  'list_daftra_client_import', 'list_daftra_client_import[min]', 'reject_invoice_candidate', 'request_daftra_purchase_draft', 'resolve_daftra_review',
  'unlink_daftra_supplier',
  // legacy import (20261125000100): they take a run id (the builder sends another id) and are for the owner only; isolation of the
  // runs and staged rows (org, other roles, client, anon, aal1) is asserted by legacy-import-sql-tests.js and rls-tests.js
  'legacy_import_commit', 'legacy_import_commit[min]', 'legacy_import_daftra_candidates', 'legacy_import_daftra_candidates[min]',
  'legacy_import_get_run', 'legacy_import_list_rows', 'legacy_import_list_rows[min]', 'legacy_import_queue_daftra', 'legacy_import_set_options',
  'legacy_import_set_options[min]', 'legacy_import_skip_rows', 'legacy_import_skip_rows[min]', 'legacy_import_stage', 'legacy_import_stage[min]',
  'legacy_import_validate', 'legacy_import_validate[min]', 'legacy_import_void', 'legacy_import_void[min]'];
async function positiveControl() {
  section('8. positive control: the §1 argument builder with B\'s own staff');
  const fns = (await listRpcs()).filter(f => !PUBLIC_BY_DESIGN[f.proname] && !/^platform_/.test(f.proname));
  const okBy = {};
  for (const who of ['B_admin', 'B_ops', 'B_acc']) {
    let ok = 0;
    for (const f of fns) for (const minimal of [false, true]) {
      if (minimal && !f.argtypes.some(t => t === 'jsonb')) continue;
      const r = await callAs(who, f, minimal);
      record(who, f, minimal, r);
      if (r.ok) { ok++; okBy[f.proname] = true; }
    }
    await check(`${who}: the same calls with own-org ids succeed ${ok} time(s)`, () => ok >= 15 || 'only ' + ok);
  }
  await check(`positive control: ${Object.keys(okBy).length} distinct RPCs answered B's own staff (vs 0 B data for A's users in §1)`, () => Object.keys(okBy).length >= 30 || Object.keys(okBy).join(','));
  // review fix: pair per (RPC, variant). An A-side MRS_NOT_FOUND / MRS_FORBIDDEN is isolation evidence only when B's own staff
  // got past the tenant check on the same call (OK, or a business error that is not NOT_FOUND / FORBIDDEN). Calls where
  // neither side reached the business logic are "not exercised" and must equal the named list below exactly (it cannot
  // grow quietly). A-side MRS_INVALID is a validation failure, not an authorization refusal: reported separately.
  const TENANT = c => c === 'MRS_NOT_FOUND' || c === 'MRS_FORBIDDEN';
  const B_ROLES = ['B_admin', 'B_ops', 'B_acc'];
  const keys = new Set(), proven = new Set(), notEx = new Set(), invalidA = new Set();
  for (const who of ['A_admin', 'A_clr', 'A_client']) {
    for (const [k, c] of Object.entries(CALLS[who] || {})) {
      if (/^platform_/.test(k)) continue;            // §2 covers the platform RPCs
      if (c === 'MRS_INVALID') invalidA.add(k);
      if (!TENANT(c)) continue;
      keys.add(k);
      const past = B_ROLES.some(b => { const bc = (CALLS[b] || {})[k]; return bc && bc !== 'PERM' && !TENANT(bc); });
      (past ? proven : notEx).add(k);
    }
  }
  const got = [...notEx].filter(k => !proven.has(k)).sort();
  await check(`§1 ↔ §8 paired: ${proven.size} RPC variants refused for A were reached by B's own staff (the refusal is the tenant check)`, () =>
    proven.size >= 150 || 'only ' + proven.size);
  await check(`not exercised (neither A nor B reached the business logic: builder arguments, not evidence of isolation) = the named list of ${NOT_EXERCISED.length}`, () =>
    J(got) === J(NOT_EXERCISED.slice().sort()) || J({ unexpected: got.filter(k => !NOT_EXERCISED.includes(k)), no_longer: NOT_EXERCISED.filter(k => !got.includes(k)) }));
  pass(`reported: ${invalidA.size} A-side MRS_INVALID variants (validation, not counted as authorization refusals)`);
}

/* ================================================================== main */
async function dbMain() {
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return;
  for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return;
  // legacy step 7 (20261123000100): the owner decisions default to HF5 (no edit of an existing Daftra draft) and resolve-only
  // products (never created); this suite drives the G5 billing cycle, so its connections start with the G5 write policy
  await db.exec(`ALTER TABLE public.daftra_connections ALTER COLUMN allow_draft_update SET DEFAULT true, ALTER COLUMN allow_product_create SET DEFAULT true`);
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return;
  try { const r = await fixtures(); r.n === 15 ? pass('fixtures: auth users, platform admin, org A staff in JED / DMM (seed-style)') : fail('fixtures', 'requirements ' + r.n); }
  catch (e) { fail('fixtures', errText(e)); return; }
  const g7 = migFiles.includes(G7_MIGRATION) && !!(await one(`SELECT to_regprocedure('public.platform_suspend_org(uuid,text,boolean)') p`)).p;
  await check('G7 migration loaded (platform_suspend_org present)', () => g7 || 'absent — §6 cannot run (DB agent deliverable)');

  const W = L.createWorkers(H, ROOT);
  try {
    section('0. data: org B through RPCs; full cycles A (JED), A (DMM), B');
    await L.createOrgViaRpcs(H, ORG_B, { platform: 'P', email: EMAIL, name_ar: 'مؤسسة تجريبية ب', name_en: 'Test Org B',
      branch1: { code: 'RUH', name_ar: 'فرع الرياض' }, branch2: { code: 'KHB', name_ar: 'فرع الخبر' }, extraRoles: [['sup', 'supervisor', null]] });
    await L.setupOrg(H, W, ORG_A);
    await L.setupOrg(H, W, ORG_B);
    Object.assign(ORG_A2.d, { terminal: ORG_A.d.terminal, yard: ORG_A.d.yard, carrier: ORG_A.d.carrier, supplier: ORG_A.d.supplier, driver: ORG_A.d.driver, truck: ORG_A.d.truck,
      chE: ORG_A.d.chE, chW: ORG_A.d.chW, ME: ORG_A.d.ME, MW: ORG_A.d.MW });
    for (const o of [ORG_A, ORG_A2, ORG_B]) for (const s of L.cycleSteps(H, W, o)) await step(s.title, s.run);
    await step('[A2] a reply drafted on the DMM thread (save_msg_reply)', async () => {
      ORG_A2.d.reply = await rpc('A_clrD', `SELECT public.save_msg_reply(NULL, $1, $2) r`, [{ thread_id: ORG_A2.d.cycle.thread, lang: 'en', subject: 'Re: D/O', body_text: 'Thank you, noted.' }, newKey()]);
    });
    await step('[B] a contact + address and a reply draft (more B ids for the sweep)', async () => {
      ORG_B.d.contact = await rpc('B_ops', `SELECT public.save_msg_contact($1, $2, $3) r`, [ORG_B.id, { display_name: 'Agent B', entity_type: 'party', party_id: ORG_B.d.supplier, lang: 'en' }, newKey()]);
      ORG_B.d.address = await rpc('B_ops', `SELECT public.add_msg_contact_address($1, $2, $3) r`, [ORG_B.d.contact.id, { kind: 'email', address: 'ops@agent-b9i.example' }, newKey()]);
      ORG_B.d.reply = await rpc('B_clr', `SELECT public.save_msg_reply(NULL, $1, $2) r`, [{ thread_id: ORG_B.d.cycle.thread, lang: 'en', subject: 'Re: D/O', body_text: 'Noted.' }, newKey()]);
    });
  } catch (e) { fail('data build', errText(e)); return; }

  const tables = await L.tenantTables(H);
  await collectBIds();
  await check(`leak needles collected from org B (${await collectNeedles(tables)} ids / refs / names)`, () => NEEDLES.length > 100 || 'only ' + NEEDLES.length);
  for (const [name, fn] of [['rpc sweep', () => rpcSweep(tables)], ['platform sweep', () => platformSweep(tables)], ['branch sweep', branchSweep],
    ['storage sweep', storageSweep], ['messaging sweep', messagingSweep], ['suspended sweep', () => suspendedSweep(tables, g7)], ['direct API sweep', () => directApiSweep(tables)],
    ['positive control', positiveControl]]) {
    try { await fn(); } catch (e) { fail(name, errText(e)); }
  }
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

async function main() {
  await dbMain();
  finish();
}

main().catch(e => { console.error(e); process.exit(1); });
