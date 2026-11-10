#!/usr/bin/env node
/*
  Marsa (مرسى) — G4 suppliers & operating costs test suite (docs/online/G4_SPEC.md).  LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql
  Org A = seed "blue-sea" (branches JED, DMM). Org B = "org-b" (inserted as owner).
  Users (org A):
    adminA admin            accA accountant (all)     mgrA accounts_manager (all)   accJ accountant JED
    bmJ branch_manager JED  bmD branch_manager DMM    supA supervisor (all)         opsA operations_manager (all)
    trJ transport_staff JED clrJ clearance_staff JED  clientA client 101
  Org B: accB accountant, adminB admin.
  Transactions: TX1 (seed, JED, client 101, containers 301/302), TX2 (seed, DMM, client 102, container 303),
                TX4 (JED, client 101, under_billing → late costs), B_TX (org B).

  Structure: one async function per section, run in order (SECTIONS); state shared through S.
  Prints PASS / FAIL per case; exit code 1 on any FAIL.
  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g4-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_G4 = '20261104000100_g4_costs.sql';

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
const TX1 = '0b5e0000-0000-4000-8000-000000000201';
const TX2 = '0b5e0000-0000-4000-8000-000000000202';
const TX4 = '0b5e0000-0000-4000-8000-000000000204';
const C301 = '0b5e0000-0000-4000-8000-000000000301';
const C302 = '0b5e0000-0000-4000-8000-000000000302';
const C303 = '0b5e0000-0000-4000-8000-000000000303';
const B = 'bbbb0000-0000-4000-8000-000000000001';
const B_BR = 'bbbb0000-0000-4000-8000-000000000011';
const B_CL = 'bbbb0000-0000-4000-8000-000000000101';
const B_TX = 'bbbb0000-0000-4000-8000-000000000201';
const PK = 'abc40000-0000-4000-8000-0000000000a1';    // carrier
const PT = 'abc40000-0000-4000-8000-0000000000a2';    // terminal operator
const PP = 'abc40000-0000-4000-8000-0000000000a3';    // port / supplier
const PB = 'abc40000-0000-4000-8000-0000000000b1';    // org B supplier

const U = {
  adminA: 'abc40000-0000-4000-8000-000000000001', accA: 'abc40000-0000-4000-8000-000000000002',
  mgrA: 'abc40000-0000-4000-8000-000000000003', accJ: 'abc40000-0000-4000-8000-000000000004',
  bmJ: 'abc40000-0000-4000-8000-000000000005', bmD: 'abc40000-0000-4000-8000-000000000006',
  supA: 'abc40000-0000-4000-8000-000000000007', opsA: 'abc40000-0000-4000-8000-000000000008',
  trJ: 'abc40000-0000-4000-8000-000000000009', clrJ: 'abc40000-0000-4000-8000-00000000000a',
  clientA: 'abc40000-0000-4000-8000-00000000000b', accB: 'abc40000-0000-4000-8000-00000000000c',
  adminB: 'abc40000-0000-4000-8000-00000000000d'
};
let keySeq = 0;
const newKey = () => `0e4e0000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;
let shaSeq = 0;
const newSha = () => (++shaSeq).toString(16).padStart(64, 'c');
const today = () => new Date().toISOString().slice(0, 10);
const N = x => (x === null || x === undefined) ? x : Number(x);

const G4_TABLES = ['finance_documents', 'supplier_invoices', 'supplier_invoice_lines', 'cost_allocations', 'cost_accruals',
  'supplier_payments', 'client_charges', 'charge_collections', 'demurrage_cases', 'cost_adjustments'];
const G4_RPCS = ['save_party_finance', 'register_finance_document', 'void_finance_document', 'create_supplier_invoice',
  'update_supplier_invoice', 'set_supplier_invoice_status', 'check_supplier_invoice_duplicate', 'add_invoice_lines',
  'update_invoice_line', 'review_invoice_line', 'allocate_invoice_line', 'approve_allocations', 'reject_allocation',
  'reverse_allocation', 'cost_review_queue', 'list_supplier_invoices', 'get_supplier_invoice', 'create_accrual',
  'review_accrual_variance', 'void_accrual', 'list_accruals', 'record_supplier_payment', 'void_supplier_payment',
  'list_supplier_payments', 'create_client_charge', 'update_client_charge', 'set_charge_status', 'list_client_charges',
  'suggest_client_charges', 'record_charge_collection', 'void_charge_collection', 'create_demurrage_case',
  'update_demurrage_case', 'set_demurrage_status', 'list_demurrage', 'create_cost_adjustment', 'review_cost_adjustment',
  'list_cost_adjustments', 'tx_costs', 'tx_margin', 'margin_report', 'cost_report'];

/* ------------------------------------------------------------------ helpers */
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
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e)); }
}
async function denied(who, sql, params) {
  try { const r = await as(who, sql, params); return r.length === 0 ? true : 'returned ' + r.length + ' row(s)'; }
  catch (e) { return /permission denied|row-level security|MRS_|violates/.test(errText(e)) ? true : 'unexpected error: ' + errText(e); }
}
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}

/* ------------------------------------------------------------------ RPC wrappers */
const R = {
  doc: (who, p, k) => rpc(who, `SELECT public.register_finance_document($1, $2) r`, [p, k || null]),
  inv: (who, p, k) => rpc(who, `SELECT public.create_supplier_invoice($1, $2) r`, [p, k || null]),
  updInv: (who, id, p) => rpc(who, `SELECT public.update_supplier_invoice($1, $2) r`, [id, p]),
  invSt: (who, id, st, note) => rpc(who, `SELECT public.set_supplier_invoice_status($1, $2, $3) r`, [id, st, note || null]),
  lines: (who, id, lines, src, k) => rpc(who, `SELECT public.add_invoice_lines($1, $2, $3, $4) r`, [id, JSON.stringify(lines), src || 'manual', k || null]),
  updLine: (who, id, p) => rpc(who, `SELECT public.update_invoice_line($1, $2) r`, [id, p]),
  review: (who, id, d, note, svc) => rpc(who, `SELECT public.review_invoice_line($1, $2, $3, $4) r`, [id, d, note || null, svc || null]),
  alloc: (who, line, targets, k) => rpc(who, `SELECT public.allocate_invoice_line($1, $2, $3) r`, [line, JSON.stringify(targets), k || null]),
  approve: (who, ids, note) => rpc(who, `SELECT public.approve_allocations($1::uuid[], $2) r`, [ids, note || null]),
  reject: (who, id, reason) => rpc(who, `SELECT public.reject_allocation($1, $2) r`, [id, reason]),
  reverse: (who, id, reason) => rpc(who, `SELECT public.reverse_allocation($1, $2) r`, [id, reason]),
  getInv: (who, id) => rpc(who, `SELECT public.get_supplier_invoice($1) r`, [id]),
  pay: (who, p, k) => rpc(who, `SELECT public.record_supplier_payment($1, $2) r`, [p, k || null]),
  voidPay: (who, id, reason) => rpc(who, `SELECT public.void_supplier_payment($1, $2) r`, [id, reason]),
  charge: (who, p, k) => rpc(who, `SELECT public.create_client_charge($1, $2) r`, [p, k || null]),
  chargeSt: (who, id, st, note) => rpc(who, `SELECT public.set_charge_status($1, $2, $3) r`, [id, st, note || null]),
  collect: (who, p, k) => rpc(who, `SELECT public.record_charge_collection($1, $2) r`, [p, k || null]),
  dcase: (who, p, k) => rpc(who, `SELECT public.create_demurrage_case($1, $2) r`, [p, k || null]),
  adj: (who, p, k) => rpc(who, `SELECT public.create_cost_adjustment($1, $2) r`, [p, k || null]),
  revAdj: (who, id, d, note) => rpc(who, `SELECT public.review_cost_adjustment($1, $2, $3) r`, [id, d, note || null]),
  accrual: (who, p, k) => rpc(who, `SELECT public.create_accrual($1, $2) r`, [p, k || null]),
  revAcc: (who, id, d, note) => rpc(who, `SELECT public.review_accrual_variance($1, $2, $3) r`, [id, d, note || null]),
  margin: (who, tx) => rpc(who, `SELECT public.tx_margin($1) r`, [tx]),
  trip: (who, p) => rpc(who, `SELECT public.create_trip($1) r`, [p]),
  updTrip: (who, id, p) => rpc(who, `SELECT public.update_trip($1, $2) r`, [id, p]),
  tripSt: (who, id, st, note) => rpc(who, `SELECT public.set_trip_status($1, $2, NULL, $3) r`, [id, st, note || null])
};
const accrualOfTrip = trip => one(`SELECT * FROM public.cost_accruals WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`, [trip]);
const accrualById = id => one(`SELECT * FROM public.cost_accruals WHERE id = $1`, [id]);
const invRow = id => one(`SELECT * FROM public.supplier_invoices WHERE id = $1`, [id]);
async function mkDoc(who, branch, kind) {
  return R.doc(who, { branch_id: branch, kind: kind || 'supplier_invoice', original_name: 'inv.pdf', mime_type: 'application/pdf',
                      size_bytes: 1000, sha256: newSha() });
}
// invoice with file + clean lines, ready to allocate (lines ok)
async function mkInvoice(who, o) {
  const doc = o.noFile ? null : await mkDoc(who, o.branch || JED);
  const lines = o.lines || [{ description: 'بند', quantity: 1, unit_price: 1000, net_amount: 1000, vat_rate: 15, service_code: 'transport' }];
  const sub = lines.reduce((s, l) => s + l.net_amount, 0);
  const vat = lines.reduce((s, l) => s + (l.vat_amount != null ? l.vat_amount : Math.round(l.net_amount * (l.vat_rate == null ? 15 : l.vat_rate)) / 100), 0);
  const p = Object.assign({ branch_id: o.branch || JED, supplier_id: o.supplier || PK, invoice_number: o.number,
    invoice_date: o.date || today(), subtotal: sub, vat_amount: Math.round(vat * 100) / 100, lines }, o.extra || {});
  if (doc) p.finance_document_id = doc.id;
  return R.inv(who, p);
}

/* ------------------------------------------------------------------ fixtures */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g4.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.organizations (id, slug, name_ar) VALUES ('${B}', 'org-b', 'مؤسسة ب التجريبية');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع الرياض ب');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${B_CL}', '${B}', 'business', 'عميل ب', '0509999999');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ('${B_TX}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ('${TX4}', '${A}', '${JED}', '${CL101}', 'import', 'sea');
    UPDATE public.transactions SET operational_status = 'under_billing' WHERE id = '${TX4}';
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'), ('${U.accA}', '${A}', NULL, 'accountant'),
      ('${U.mgrA}', '${A}', NULL, 'accounts_manager'), ('${U.accJ}', '${A}', '${JED}', 'accountant'),
      ('${U.bmJ}', '${A}', '${JED}', 'branch_manager'), ('${U.bmD}', '${A}', '${DMM}', 'branch_manager'),
      ('${U.supA}', '${A}', NULL, 'supervisor'), ('${U.opsA}', '${A}', NULL, 'operations_manager'),
      ('${U.trJ}', '${A}', '${JED}', 'transport_staff'), ('${U.clrJ}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.clientA}', '${A}', NULL, 'client'),
      ('${U.accB}', '${B}', NULL, 'accountant'), ('${U.adminB}', '${B}', NULL, 'admin');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CL101}', '${U.clientA}', 'owner');
    INSERT INTO public.parties (id, org_id, kinds, name_ar, vat_number) VALUES
      ('${PK}', '${A}', ARRAY['carrier'], 'ناقل الاختبار', '300000000000111'),
      ('${PT}', '${A}', ARRAY['terminal_operator'], 'محطة الاختبار', NULL),
      ('${PP}', '${A}', ARRAY['supplier','shipping_agent'], 'مورد الميناء', NULL),
      ('${PB}', '${B}', ARRAY['carrier'], 'ناقل ب', NULL);
  `);
}

const S = {};

/* ================================================================== sections */
async function secCatalog() {
  section('catalog: version, RLS, grants, privileges, dictionaries');
  await check('schema_versions has 20261104000100 g4_costs', async () =>
    (await count(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261104000100' AND name = 'g4_costs'`)) === 1);
  for (const t of G4_TABLES) {
    await check(`${t}: RLS on, audit trigger, no anon privilege, authenticated SELECT only`, async () => {
      const r = await one(`SELECT c.relrowsecurity rls,
                                  EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'trg_audit') audit,
                                  (SELECT count(*)::int FROM information_schema.role_table_grants x
                                    WHERE x.grantee = 'anon' AND x.table_schema = 'public' AND x.table_name = c.relname) anon,
                                  (SELECT string_agg(x.privilege_type, ',' ORDER BY x.privilege_type) FROM information_schema.role_table_grants x
                                    WHERE x.grantee = 'authenticated' AND x.table_schema = 'public' AND x.table_name = c.relname) auth
                             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relname = $1`, [t]);
      return (r && r.rls && r.audit && r.anon === 0 && r.auth === 'SELECT') || JSON.stringify(r);
    });
  }
  await check('every G4 RPC: authenticated may execute, anon may not, SECURITY DEFINER with search_path', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n,
                              p.prosecdef d, EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%') sp
                         FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname = ANY($1)`, [G4_RPCS]);
    const bad = r.filter(x => !x.a || x.n || !x.d || !x.sp).map(x => x.proname);
    const missing = G4_RPCS.filter(n => !r.find(x => x.proname === n));
    return (bad.length === 0 && missing.length === 0 && r.length === G4_RPCS.length) || JSON.stringify({ bad, missing, n: r.length });
  });
  await check('app.fin_* helpers: not executable by authenticated except the two policy helpers', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND (p.proname LIKE 'fin\\_%' OR p.proname LIKE 'sync\\_%' OR p.proname IN
                              ('tg_parties_fin_guard','tg_supplier_invoices_before','tg_invoice_lines_review','tg_trip_accrual','tg_demurrage_accrual',
                               'tg_alloc_cap','tg_alloc_guard','tg_payment_totals','tg_client_charges_price','tg_collection_check'))
                          AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
                        ORDER BY 1`);
    const got = r.map(x => x.proname).join(',');
    return got === 'fin_can_read_invoice,fin_read_roles' || got;
  });
  await check('transaction_events accepts finance (and keeps every G3 type)', async () => {
    const r = await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'transaction_events_event_type_check'`);
    return ['finance', 'docs_override', 'appointment', 'trip', 'exception', 'declaration', 'bl', 'container', 'tracking_token']
      .every(x => r.d.includes(`'${x}'`)) || r.d;
  });
  // + fin_funding_source (20261117000100 legacy_core)
  await check('dictionaries: 21 fin_* domains, all internal, ar + en', async () => {
    const r = await one(`SELECT count(DISTINCT domain)::int d, count(*) FILTER (WHERE client_visible)::int v,
                                count(*) FILTER (WHERE label_ar = '' OR label_en = '')::int e
                           FROM public.status_labels WHERE domain LIKE 'fin\\_%'`);
    return (r.d === 21 && r.v === 0 && r.e === 0) || JSON.stringify(r);
  });
  // 14 G4 codes + gate_in_appointment / gate_out_appointment (20261117000100 legacy_core)
  await check('fin_service catalog has the 16 codes; app.fin_check_service refuses an unknown code', async () => {
    const n = await count(`SELECT count(*)::int n FROM public.status_labels WHERE domain = 'fin_service'`);
    let err = '';
    try { await q(`SELECT app.fin_check_service('teleport')`); } catch (e) { err = errText(e); }
    return (n === 16 && /MRS_INVALID service_code/.test(err)) || JSON.stringify({ n, err });
  });
  await check('storage bucket "finance" is private (25 MB), with read / insert policies and no update / delete policy', async () => {
    const b = await one(`SELECT public, file_size_limit FROM storage.buckets WHERE id = 'finance'`);
    const p = await q(`SELECT policyname, cmd, roles::text roles FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'marsa_finance%' ORDER BY 1`);
    return (b.public === false && N(b.file_size_limit) === 26214400 && p.length === 2 && p.every(x => x.roles.includes('authenticated'))
            && p.map(x => x.cmd).sort().join(',') === 'INSERT,SELECT') || JSON.stringify({ b, p });
  });
  await check('composite FK helpers exist: transport_trips (id, transaction_id), operational_exceptions (id, transaction_id)', async () =>
    (await count(`SELECT count(*)::int n FROM pg_constraint WHERE conname IN ('transport_trips_id_tx_uniq','operational_exceptions_id_tx_uniq')`)) === 2);
}

async function secRoles() {
  section('role helpers');
  await check('fin_read / fin_write / fin_approve role lists', async () => {
    const r = await one(`SELECT app.fin_read_roles() r, app.fin_write_roles() w, app.fin_approve_roles() a`);
    return (r.r.join(',') === 'accountant,accounts_manager,branch_manager,supervisor,admin'
         && r.w.join(',') === 'accountant,accounts_manager,branch_manager,admin'
         && r.a.join(',') === 'accounts_manager,branch_manager,admin') || JSON.stringify(r);
  });
  await check('invoice number normalization (inv-0012 → INV12, INV 12 → INV12, ١٢٣ → 123, INV-0001 / inv 1 → INV1)', async () => {
    const r = await one(`SELECT app.fin_norm_no('inv-0012') a, app.fin_norm_no('INV 12') b, app.fin_norm_no('١٢٣') c,
                                app.fin_norm_no('INV-0001') d, app.fin_norm_no('inv 1') e, app.fin_norm_no('A-00') f, app.fin_norm_no('فا-٠٠٧') g`);
    return (r.a === 'INV12' && r.b === 'INV12' && r.c === '123' && r.d === 'INV1' && r.e === 'INV1' && r.f === 'A0' && r.g === 'فا7') || JSON.stringify(r);
  });
}

async function secParties() {
  section('1. parties: finance columns');
  await expectErr('a transport writer cannot set iban_last4 directly (MRS_FORBIDDEN party_finance)',
    () => as('trJ', `UPDATE public.parties SET iban_last4 = '1234' WHERE id = $1`, [PK]), /MRS_FORBIDDEN.*party_finance/);
  await expectErr('nor payment_terms_days / default_currency', () => as('trJ', `UPDATE public.parties SET default_currency = 'USD' WHERE id = $1`, [PK]),
    /MRS_FORBIDDEN.*party_finance/);
  await expectErr('a direct INSERT with finance columns is refused', () => as('trJ',
    `INSERT INTO public.parties (org_id, kinds, name_ar, bank_name) VALUES ($1, ARRAY['carrier'], 'ناقل جديد', 'بنك')`, [A]), /MRS_FORBIDDEN.*party_finance/);
  await check('address / contact_name are written directly by transport writers', async () => {
    const r = await as('trJ', `UPDATE public.parties SET address = 'جدة - حي الميناء', contact_name = 'أحمد' WHERE id = $1 RETURNING address, contact_name`, [PK]);
    return (r.length === 1 && r[0].contact_name === 'أحمد') || JSON.stringify(r);
  });
  await expectErr('save_party_finance: transport staff → MRS_FORBIDDEN', () => rpc('trJ', `SELECT public.save_party_finance($1, $2) r`, [PK, { bank_name: 'x' }]), /MRS_FORBIDDEN/);
  await expectErr('save_party_finance: supervisor (read only) → MRS_FORBIDDEN', () => rpc('supA', `SELECT public.save_party_finance($1, $2) r`, [PK, { bank_name: 'x' }]), /MRS_FORBIDDEN/);
  await expectErr('save_party_finance: org B → MRS_NOT_FOUND', () => rpc('accB', `SELECT public.save_party_finance($1, $2) r`, [PK, { bank_name: 'x' }]), /MRS_NOT_FOUND/);
  await expectErr('save_party_finance: full IBAN refused (last 4 only)', () => rpc('accA', `SELECT public.save_party_finance($1, $2) r`, [PK, { iban_last4: 'SA0380000000608010167519' }]), /MRS_TOO_LONG|MRS_INVALID/);
  await expectErr('save_party_finance: unknown key refused', () => rpc('accA', `SELECT public.save_party_finance($1, $2) r`, [PK, { iban: '1' }]), /MRS_INVALID.*unknown_key/);
  await check('save_party_finance (accountant) stores the four finance columns; staff still read them', async () => {
    const r = await rpc('accA', `SELECT public.save_party_finance($1, $2) r`, [PK, { iban_last4: '٤٤٥٦', bank_name: 'بنك الاختبار', payment_terms_days: 30, default_currency: 'sar' }]);
    const s = await as('trJ', `SELECT iban_last4, bank_name, payment_terms_days, default_currency FROM public.parties WHERE id = $1`, [PK]);
    return (r.iban_last4 === '4456' && r.payment_terms_days === 30 && s[0].default_currency === 'SAR' && s[0].bank_name === 'بنك الاختبار') || JSON.stringify({ r, s });
  });
  await check('the flag does not leak: a later direct update in the same session is still refused', async () => {
    try { await as('trJ', `UPDATE public.parties SET bank_name = 'y' WHERE id = $1`, [PK]); return 'succeeded'; }
    catch (e) { return /party_finance/.test(errText(e)) || errText(e); }
  });
}

async function secFiles() {
  section('2. finance documents + storage');
  const sha = newSha();
  S.doc1 = await R.doc('accJ', { branch_id: JED, kind: 'supplier_invoice', original_name: 'فاتورة/../x.pdf', mime_type: 'application/pdf', size_bytes: 2048, sha256: sha });
  await check('register_finance_document: path = {org}/{id}/{safe name}, bucket finance', async () =>
    (S.doc1.storage_bucket === 'finance' && S.doc1.storage_path.startsWith(`${A}/${S.doc1.id}/`) && S.doc1.storage_path.split('/').length === 3
     && !S.doc1.storage_path.includes('..')) || JSON.stringify(S.doc1));
  await expectErr('same sha256 again → MRS_INVALID file_duplicate (hint = existing id)',
    () => R.doc('accA', { branch_id: DMM, kind: 'supplier_invoice', original_name: 'b.pdf', size_bytes: 10, sha256: sha }),
    new RegExp('MRS_INVALID file_duplicate ' + S.doc1.id));
  await expectErr('transport staff cannot register (MRS_FORBIDDEN)', () => R.doc('trJ', { branch_id: JED, original_name: 'a.pdf', size_bytes: 1, sha256: newSha() }), /MRS_FORBIDDEN/);
  await expectErr('supervisor cannot register (read only)', () => R.doc('supA', { branch_id: JED, original_name: 'a.pdf', size_bytes: 1, sha256: newSha() }), /MRS_FORBIDDEN/);
  await expectErr('JED accountant cannot register in DMM', () => R.doc('accJ', { branch_id: DMM, original_name: 'a.pdf', size_bytes: 1, sha256: newSha() }), /MRS_FORBIDDEN/);
  await expectErr('org B cannot register in org A', () => R.doc('accB', { branch_id: JED, original_name: 'a.pdf', size_bytes: 1, sha256: newSha() }), /MRS_NOT_FOUND/);
  await expectErr('bad mime type refused', () => R.doc('accA', { branch_id: JED, original_name: 'a.exe', mime_type: 'application/x-msdownload', size_bytes: 1, sha256: newSha() }), /MRS_INVALID.*mime_type/);
  await expectErr('size above 25 MB refused', () => R.doc('accA', { branch_id: JED, original_name: 'a.pdf', size_bytes: 26214401, sha256: newSha() }), /MRS_INVALID.*size_bytes/);
  await check('storage: the uploader inserts exactly at the registered path', async () => {
    await as('accJ', `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('finance', $1, $2)`, [S.doc1.storage_path, U.accJ]);
    return true;
  });
  await expectErr('storage: another finance user cannot upload to that path', () => as('accA',
    `INSERT INTO storage.objects (bucket_id, name) VALUES ('finance', $1)`, [S.doc1.storage_path.replace('.pdf', '2.pdf')]), /row-level security/);
  await expectErr('storage: an unregistered path is refused', () => as('accJ',
    `INSERT INTO storage.objects (bucket_id, name) VALUES ('finance', $1)`, [`${A}/${S.doc1.id}/other.pdf`]), /row-level security/);
  await expectErr('storage: a deeper path is refused (foldername = 2)', () => as('accJ',
    `INSERT INTO storage.objects (bucket_id, name) VALUES ('finance', $1)`, [`${A}/${S.doc1.id}/x/${S.doc1.storage_path.split('/')[2]}`]), /row-level security/);
  await check('storage read: JED finance reads; DMM branch manager, transport staff, client, org B see nothing', async () => {
    const mine = await as('accJ', `SELECT name FROM storage.objects WHERE bucket_id = 'finance'`);
    const r = [await denied('bmD', `SELECT name FROM storage.objects WHERE bucket_id = 'finance'`),
               await denied('trJ', `SELECT name FROM storage.objects WHERE bucket_id = 'finance'`),
               await denied('clientA', `SELECT name FROM storage.objects WHERE bucket_id = 'finance'`),
               await denied('accB', `SELECT name FROM storage.objects WHERE bucket_id = 'finance'`)];
    return (mine.length === 1 && r.every(x => x === true)) || JSON.stringify({ mine, r });
  });
  await expectErr('storage: no update of an original', async () => {
    const r = await as('accJ', `UPDATE storage.objects SET name = name || 'x' WHERE bucket_id = 'finance' RETURNING 1`);
    if (r.length === 0) throw new Error('row-level security: 0 rows');
  }, /row-level security/);
  await check('replay: same key + payload returns the same document (no second row)', async () => {
    const k = newKey(); const p = { branch_id: JED, kind: 'payment_evidence', original_name: 'r.pdf', size_bytes: 5, sha256: newSha() };
    const a = await R.doc('accA', p, k); const b = await R.doc('accA', p, k);
    const n = await count(`SELECT count(*)::int n FROM public.finance_documents WHERE sha256 = $1`, [p.sha256]);
    return (a.id === b.id && b.replayed === true && n === 1) || JSON.stringify({ a, b, n });
  });
  await expectErr('void_finance_document: accountant (no approve role) → MRS_FORBIDDEN', () => rpc('accA', `SELECT public.void_finance_document($1, 'x') r`, [S.doc1.id]), /MRS_FORBIDDEN/);
  await expectErr('void_finance_document: reason required', () => rpc('mgrA', `SELECT public.void_finance_document($1, ' ') r`, [S.doc1.id]), /MRS_NOTE_REQUIRED/);
  await check('void then re-register the same bytes is allowed (dedupe only among non-void)', async () => {
    const d = await mkDoc('accA', JED);
    const sha2 = (await one(`SELECT sha256 FROM public.finance_documents WHERE id = $1`, [d.id])).sha256;
    await rpc('mgrA', `SELECT public.void_finance_document($1, 'نسخة خاطئة') r`, [d.id]);
    const d2 = await R.doc('accA', { branch_id: JED, original_name: 'again.pdf', size_bytes: 9, sha256: sha2 });
    return d2.id !== d.id || 'same id';
  });
}

async function secInvoices() {
  section('3. supplier invoices');
  // C1: carrier invoice, number INV-0012, 2 lines (allocation targets later)
  S.c1 = await mkInvoice('accA', { number: 'INV-0012', lines: [
    { description: 'نقل حاوية 1', quantity: 1, unit_price: 800, net_amount: 800, vat_rate: 15, service_code: 'transport' },
    { description: 'رسوم بوابة', quantity: 2, unit_price: 50, net_amount: 100, vat_rate: 15, service_code: 'port_charges' }] });
  await check('create_supplier_invoice: header + lines, number_norm, VAT snapshot from the party, status received / unpaid', async () => {
    const c = S.c1;
    return (c.number_norm === 'INV12' && c.status === 'received' && c.payment_status === 'unpaid' && N(c.total_amount) === 1035
            && c.supplier_vat_number === '300000000000111' && c.lines.length === 2 && c.lines.every(l => l.review_status === 'ok')
            && N(c.discrepancy.total) === 0) || JSON.stringify(c);
  });
  await expectErr('hard duplicate: "inv 12" for the same supplier → invoice_number_taken (hint = existing id)',
    () => R.inv('accA', { branch_id: JED, supplier_id: PK, invoice_number: 'inv 12', invoice_date: today(), subtotal: 1 }),
    new RegExp('MRS_INVALID invoice_number_taken ' + S.c1.id));
  await expectErr('hard duplicate also across branches (DMM)', () => R.inv('accA', { branch_id: DMM, supplier_id: PK, invoice_number: 'INV0012', invoice_date: today() }),
    /invoice_number_taken/);
  await check('the same number under ANOTHER supplier is allowed but reported as a possible duplicate', async () => {
    const x = await R.inv('accA', { branch_id: JED, supplier_id: PP, invoice_number: 'INV-12', invoice_date: today(), subtotal: 5, vat_amount: 0 });
    S.ppDup = x.id;
    return x.possible_duplicates.some(d => d.id === S.c1.id && d.reasons.includes('same_number_other_supplier')) || JSON.stringify(x.possible_duplicates);
  });
  await check('possible duplicate: same supplier, same total, date within 7 days, another number', async () => {
    const d = new Date(Date.now() - 5 * 86400e3).toISOString().slice(0, 10);
    const x = await R.inv('accA', { branch_id: JED, supplier_id: PK, invoice_number: 'INV-0013', invoice_date: d, subtotal: 900, vat_amount: 135 });
    S.c1near = x.id;
    return x.possible_duplicates.some(p => p.id === S.c1.id && p.reasons.includes('same_supplier_total_date')) || JSON.stringify(x.possible_duplicates);
  });
  await check('check_supplier_invoice_duplicate: exact / possible / file', async () => {
    const sha = (await one(`SELECT sha256 FROM public.finance_documents WHERE id = $1`, [S.c1.finance_document_id])).sha256;
    const r = await rpc('accJ', `SELECT public.check_supplier_invoice_duplicate($1, $2) r`, [A, { supplier_id: PK, invoice_number: 'inv-00012',
      invoice_date: today(), total_amount: 1035, sha256: sha }]);
    return (r.exact.length === 1 && r.exact[0].id === S.c1.id && r.possible.some(p => p.id === S.c1near) && !r.possible.some(p => p.id === S.c1.id)
            && r.file.length === 1 && r.file[0].invoices[0].id === S.c1.id) || JSON.stringify(r);
  });
  await check('a void invoice frees its number (re-entry allowed)', async () => {
    const x = await R.inv('accA', { branch_id: JED, supplier_id: PK, invoice_number: 'V-77', invoice_date: today(), subtotal: 10 });
    await R.invSt('mgrA', x.id, 'void', 'أُدخلت بالخطأ');
    const y = await R.inv('accA', { branch_id: JED, supplier_id: PK, invoice_number: 'v77', invoice_date: today(), subtotal: 10 });
    return y.id !== x.id || 'same';
  });
  await expectErr('total must equal subtotal + VAT', () => R.inv('accA', { branch_id: JED, supplier_id: PK, invoice_number: 'T-1', invoice_date: today(),
    subtotal: 100, vat_amount: 15, total_amount: 120 }), /MRS_INVALID.*total_amount/);
  await expectErr('negative amount refused (sign comes from the document type)', () => R.inv('accA', { branch_id: JED, supplier_id: PK,
    invoice_number: 'T-2', invoice_date: today(), subtotal: '-5' }), /MRS_INVALID.*subtotal/);
  await expectErr('credit note needs adjusts_invoice_id', () => R.inv('accA', { branch_id: JED, supplier_id: PK, doc_type: 'credit_note',
    invoice_number: 'CN-1', invoice_date: today(), subtotal: 10 }), /MRS_REQUIRED.*adjusts_invoice_id/);
  await expectErr('credit note of another supplier\'s invoice refused', () => R.inv('accA', { branch_id: JED, supplier_id: PP, doc_type: 'credit_note',
    adjusts_invoice_id: S.c1.id, invoice_number: 'CN-1', invoice_date: today(), subtotal: 10 }), /MRS_INVALID.*adjusts_invoice_id/);
  await expectErr('due_date before invoice_date refused', () => R.inv('accA', { branch_id: JED, supplier_id: PK, invoice_number: 'T-3',
    invoice_date: '2026-10-10', due_date: '2026-10-01' }), /MRS_INVALID.*due_date/);
  await expectErr('inactive / foreign supplier refused', () => R.inv('accA', { branch_id: JED, supplier_id: PB, invoice_number: 'T-4', invoice_date: today() }),
    /MRS_INVALID.*supplier_id/);

  // state machine
  await expectErr('received → approved is not a transition', () => R.invSt('mgrA', S.c1.id, 'approved'), /MRS_BAD_TRANSITION/);
  await check('received → under_review (accountant)', async () => (await R.invSt('accA', S.c1.id, 'under_review')).status === 'under_review');
  await expectErr('approve needs an approve role (accountant → MRS_FORBIDDEN)', () => R.invSt('accA', S.c1.id, 'approved'), /MRS_FORBIDDEN/);
  await expectErr('approval gate: every ok line fully allocated (lines_unallocated, hint = line numbers)', () => R.invSt('mgrA', S.c1.id, 'approved'),
    /MRS_INVALID lines_unallocated 1,2/);
  // gates on a fresh invoice: file, lines, pending review
  const g = await R.inv('mgrA', { branch_id: JED, supplier_id: PP, invoice_number: 'G-1', invoice_date: today(), subtotal: 100, vat_amount: 15 });
  S.gInv = g.id;
  await R.invSt('mgrA', g.id, 'under_review');
  await expectErr('four eyes: the creator cannot approve (MRS_FORBIDDEN self_approval)', () => R.invSt('mgrA', g.id, 'approved'), /MRS_FORBIDDEN self_approval/);
  await expectErr('approval gate: original file required', () => R.invSt('bmJ', g.id, 'approved'), /MRS_REQUIRED original_file/);
  const gd = await mkDoc('accA', JED);
  await R.updInv('accA', g.id, { finance_document_id: gd.id });
  await expectErr('approval gate: at least one line', () => R.invSt('bmJ', g.id, 'approved'), /MRS_REQUIRED lines/);
  const gl = await R.lines('accA', g.id, [{ description: 'رسوم', net_amount: 100, vat_rate: 15 }]);
  S.gLine = gl.lines[0].id;
  await expectErr('approval gate: no line pending review (hint = line numbers)', () => R.invSt('bmJ', g.id, 'approved'), /MRS_INVALID lines_pending_review 1/);
  await R.review('accA', S.gLine, 'overhead', 'مصروف إداري عام', 'documentation');
  await R.updInv('accA', g.id, { subtotal: 110, vat_amount: 16.5 });
  await expectErr('approval gate: header ≠ lines needs a note (MRS_NOTE_REQUIRED discrepancy)', () => R.invSt('bmJ', g.id, 'approved'), /MRS_NOTE_REQUIRED discrepancy/);
  await check('approved with a discrepancy note (stored); an overhead line needs no allocation', async () => {
    const r = await R.invSt('bmJ', g.id, 'approved', 'فرق تقريب من المورد');
    return (r.status === 'approved' && r.discrepancy_note === 'فرق تقريب من المورد' && r.approved_by === U.bmJ) || JSON.stringify(r);
  });
  await expectErr('edits locked after approval: header (invoice_locked)', () => R.updInv('accA', g.id, { notes: 'x' }), /MRS_BAD_TRANSITION invoice_locked/);
  await expectErr('edits locked after approval: new lines', () => R.lines('accA', g.id, [{ description: 'x', net_amount: 1 }]), /invoice_locked/);
  await expectErr('edits locked after approval: line review', () => R.review('accA', S.gLine, 'ok'), /invoice_locked/);
  await expectErr('approved → disputed needs a note', () => R.invSt('accA', g.id, 'disputed'), /MRS_NOTE_REQUIRED/);
  await check('approved → disputed with a note; then editable again', async () => {
    const r = await R.invSt('accA', g.id, 'disputed', 'المورد سيصدر إشعارًا');
    const u = await R.updInv('accA', g.id, { notes: 'بانتظار الإشعار' });
    return (r.status === 'disputed' && r.approved_by === null && u.notes === 'بانتظار الإشعار') || JSON.stringify({ r, u });
  });
  await check('admin may approve an invoice he created (four eyes exception)', async () => {
    const x = await mkInvoice('adminA', { number: 'ADM-1', supplier: PP, lines: [{ description: 'عام', net_amount: 50, vat_rate: 15, service_code: 'other' }] });
    await R.review('adminA', x.lines[0].id, 'overhead', 'عام');
    await R.invSt('adminA', x.id, 'under_review');
    return (await R.invSt('adminA', x.id, 'approved')).status === 'approved';
  });
  await expectErr('void needs a note', () => R.invSt('mgrA', S.c1near, 'void'), /MRS_NOTE_REQUIRED/);
}

async function secLines() {
  section('4. invoice lines: auto review, never deleted');
  const x = await R.inv('accA', { branch_id: JED, supplier_id: PP, invoice_number: 'L-1', invoice_date: today(), subtotal: 0 });
  S.lInv = x.id;
  const r = await R.lines('accA', x.id, [
    { description: 'سليم', quantity: 1, unit_price: 100, net_amount: 100, vat_rate: 15, service_code: 'storage' },
    { description: 'بلا خدمة', net_amount: 100, vat_rate: 15 },
    { description: 'كمية × سعر', quantity: 2, unit_price: 100, net_amount: 150, vat_rate: 15, vat_amount: 22.5, service_code: 'storage' },
    { description: 'ضريبة', net_amount: 100, vat_rate: 15, vat_amount: 10, service_code: 'storage' },
    { net_amount: 40, vat_rate: 0, service_code: 'other' }]);
  const L = r.lines;
  S.lLines = L.map(l => l.id);
  await check('reasons: ok / no_service / qty_price_mismatch / vat_mismatch / unreadable (placeholder kept)', async () => {
    const st = L.map(l => l.review_status + ':' + l.review_reasons.join('+'));
    return (st[0] === 'ok:' && st[1] === 'pending_review:no_service' && st[2] === 'pending_review:qty_price_mismatch'
            && st[3] === 'pending_review:vat_mismatch' && st[4] === 'pending_review:unreadable' && L[4].description === '(بند غير مقروء)'
            && L.map(l => l.line_no).join() === '1,2,3,4,5') || st.join(' | ');
  });
  await check('OCR lines are always pending_review (from_ocr)', async () => {
    const o = await R.lines('accA', x.id, [{ description: 'من OCR', net_amount: 10, vat_rate: 15, service_code: 'storage' }], 'ocr');
    S.ocrLine = o.lines[0].id;
    return (o.lines[0].review_status === 'pending_review' && o.lines[0].review_reasons.includes('from_ocr') && o.lines[0].source === 'ocr') || JSON.stringify(o.lines[0]);
  });
  await check('discrepancy is reported (header 0 vs lines), never silently fixed', async () => {
    const d = (await R.getInv('accA', x.id)).discrepancy;
    return (N(d.net) === -500 && N(d.total) < 0 && N(d.line_count) === 6) || JSON.stringify(d);
  });
  await expectErr('excluded needs a note', () => R.review('accA', L[1].id, 'excluded'), /MRS_NOTE_REQUIRED/);
  await expectErr('overhead needs a note', () => R.review('accA', L[1].id, 'overhead', ' '), /MRS_NOTE_REQUIRED/);
  await check('excluded with a note: the line stays (counted in the header check, not in costs)', async () => {
    const e = await R.review('accA', L[3].id, 'excluded', 'بند مكرر في الفاتورة');
    const n = await count(`SELECT count(*)::int n FROM public.supplier_invoice_lines WHERE supplier_invoice_id = $1`, [x.id]);
    return (e.review_status === 'excluded' && e.from === 'pending_review' && n === 6) || JSON.stringify({ e, n });
  });
  await check('ok with a service code sets the service; a content edit re-runs the review', async () => {
    const o = await R.review('accA', L[1].id, 'ok', null, 'storage');
    const u = await R.updLine('accA', L[1].id, { vat_amount: 1 });
    const u2 = await R.updLine('accA', L[1].id, { vat_amount: 15 });
    return (o.review_status === 'ok' && o.service_code === 'storage' && u.review_status === 'pending_review'
            && u.review_reasons.join() === 'vat_mismatch' && u2.review_status === 'ok') || JSON.stringify({ o, u, u2 });
  });
  await check('no DELETE privilege on lines (or any G4 table) for the API', async () => {
    const r = await q(`SELECT table_name FROM information_schema.role_table_grants
                        WHERE grantee IN ('authenticated','anon') AND table_schema = 'public' AND privilege_type IN ('DELETE','INSERT','UPDATE','TRUNCATE')
                          AND table_name = ANY($1)`, [G4_TABLES]);
    return r.length === 0 || r.map(x => x.table_name).join(',');
  });
  await expectErr('a direct DELETE is refused', () => as('accA', `DELETE FROM public.supplier_invoice_lines WHERE id = $1`, [L[0].id]), /permission denied/);
  await expectErr('no RPC removes a line: update with line_no / empty payload refused', () => R.updLine('accA', L[0].id, {}), /MRS_REQUIRED/);
  await expectErr('lines: more than 200 at once refused', () => R.lines('accA', x.id, Array.from({ length: 201 }, () => ({ description: 'x', net_amount: 1 }))),
    /MRS_TOO_LONG/);
  await expectErr('line total must equal net + VAT', () => R.lines('accA', x.id, [{ description: 'x', net_amount: 10, vat_amount: 1, total_amount: 12 }]),
    /MRS_INVALID.*total_amount/);
}

async function secAllocations() {
  section('5. allocations');
  // trips + accruals for the allocation tests
  S.tr1 = await R.trip('opsA', { transaction_id: TX1, container_id: C301, carrier_id: PK, cost_amount: 800, cost_basis: 'agreed', sell_amount: 1200 });
  S.tr2 = await R.trip('opsA', { transaction_id: TX1, container_id: C302, carrier_id: PK });
  S.tr3 = await R.trip('opsA', { transaction_id: TX2, container_id: C303, carrier_id: PK, cost_amount: 500, cost_basis: 'estimated' });
  const L1 = S.c1.lines[0].id, L2 = S.c1.lines[1].id;
  await expectErr('a transport writer cannot allocate (MRS_FORBIDDEN)', () => R.alloc('trJ', L1, [{ transaction_id: TX1, amount: 1 }]), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
  await expectErr('JED accountant cannot allocate to a DMM transaction', () => R.alloc('accJ', L1, [{ transaction_id: TX2, amount: 1 }]), /MRS_NOT_FOUND|MRS_FORBIDDEN/);
  await expectErr('mixed amount / share targets refused', () => R.alloc('accA', L1, [{ transaction_id: TX1, amount: 1 }, { transaction_id: TX1, share_pct: 10 }]),
    /MRS_INVALID targets/);
  await expectErr('cross-transaction target: a container of TX2 on a TX1 allocation', () => R.alloc('accA', L1, [{ transaction_id: TX1, container_id: C303, amount: 1 }]),
    /MRS_INVALID container_id/);
  await expectErr('cross-transaction target: a trip of TX2 on a TX1 allocation', () => R.alloc('accA', L1, [{ transaction_id: TX1, trip_id: S.tr3.id, amount: 1 }]),
    /MRS_INVALID trip_id/);
  await expectErr('composite FK holds even for a direct insert (trip of another transaction)', () => q(`
    INSERT INTO public.cost_allocations (org_id, supplier_invoice_id, line_id, transaction_id, trip_id, amount)
    VALUES ($1, $2, $3, $4, $5, 1)`, [A, S.c1.id, L1, TX1, S.tr3.id]), /foreign key/);
  const a1 = await R.alloc('accA', L1, [{ transaction_id: TX1, trip_id: S.tr1.id, container_id: C301, amount: 800 }]);
  S.a1 = a1.allocations[0];
  await check('allocation to a trip is matched to the trip\'s accrual automatically; remaining = 0', async () => {
    const acc = await accrualOfTrip(S.tr1.id);
    return (S.a1.accrual_id === acc.id && S.a1.status === 'proposed' && N(a1.remaining) === 0 && S.a1.service_code === 'transport') || JSON.stringify({ a1, acc });
  });
  await expectErr('Σ cap: 0.01 more on a fully allocated line → MRS_OVER_ALLOCATED (remaining 0.00)', () => R.alloc('accA', L1, [{ transaction_id: TX1, amount: 0.01, no_accrual: true }]),
    /MRS_OVER_ALLOCATED 0\.00/);
  await check('Σ cap holds for two inserts inside one transaction (owner, direct)', async () => {
    let err = '';
    try {
      await db.exec(`BEGIN;
        INSERT INTO public.cost_allocations (org_id, supplier_invoice_id, line_id, transaction_id, amount) VALUES ('${A}', '${S.c1.id}', '${L2}', '${TX1}', 60);
        INSERT INTO public.cost_allocations (org_id, supplier_invoice_id, line_id, transaction_id, amount) VALUES ('${A}', '${S.c1.id}', '${L2}', '${TX1}', 60);
        COMMIT;`);
    } catch (e) { err = errText(e); await db.exec('ROLLBACK'); }
    const n = await count(`SELECT count(*)::int n FROM public.cost_allocations WHERE line_id = $1`, [L2]);
    return (/MRS_OVER_ALLOCATED 40/.test(err) && n === 0) || JSON.stringify({ err, n });
  });
  await check('share mode: 3 × 33.3333…% of 100.00 sums to exactly 100.00 (largest remainder)', async () => {
    const r = await R.alloc('accA', L2, [{ transaction_id: TX1, share_pct: 33.3333 }, { transaction_id: TX1, share_pct: 33.3333 }, { transaction_id: TX1, share_pct: 33.3334 }]);
    const am = r.allocations.map(x => N(x.amount));
    S.shareIds = r.allocations.map(x => x.id);
    return (Math.round(am.reduce((s, v) => s + v, 0) * 100) === 10000 && N(r.remaining) === 0 && am.join() === '33.33,33.33,33.34') || am.join();
  });
  await expectErr('shares above 100 % refused', () => R.alloc('accA', S.lLines[0], [{ transaction_id: TX1, share_pct: 60 }, { transaction_id: TX1, share_pct: 41 }]),
    /MRS_INVALID share_pct/);
  await expectErr('a pending-review line takes no allocation (line_pending_review)', () => R.alloc('accA', S.ocrLine, [{ transaction_id: TX1, amount: 1 }]),
    /MRS_BAD_TRANSITION line_pending_review/);
  await expectErr('an excluded line takes no allocation', () => R.alloc('accA', S.lLines[3], [{ transaction_id: TX1, amount: 1 }]), /line_excluded/);
  await expectErr('an overhead line takes no allocation', () => R.alloc('accA', S.gLine, [{ transaction_id: TX1, amount: 1 }]), /line_overhead|invoice_locked|MRS_BAD_TRANSITION/);
  await expectErr('an allocated line cannot be edited (allocated)', () => R.updLine('accA', L1, { description: 'x' }), /MRS_BAD_TRANSITION allocated/);
  await expectErr('an allocated line cannot be excluded', () => R.review('accA', L1, 'excluded', 'x'), /MRS_BAD_TRANSITION allocated/);
  await expectErr('approve: accountant has no approve role', () => R.approve('accA', [S.a1.id]), /MRS_FORBIDDEN/);
  await check('approve (accounts manager): status approved, the trip accrual becomes matched', async () => {
    const r = await R.approve('mgrA', [S.a1.id].concat(S.shareIds), 'مطابقة');
    const acc = await accrualOfTrip(S.tr1.id);
    return (r.count === 4 && acc.status === 'matched' && N(acc.matched_amount) === 800) || JSON.stringify({ r, acc });
  });
  await expectErr('approved rows are immutable (direct update of amount)', () => q(`UPDATE public.cost_allocations SET amount = 1 WHERE id = $1`, [S.a1.id]), /MRS_IMMUTABLE|MRS_OVER/);
  await expectErr('approve twice → MRS_BAD_TRANSITION approved', () => R.approve('mgrA', [S.a1.id]), /MRS_BAD_TRANSITION approved/);
  await check('four eyes on allocations: the creator cannot approve his own (self_approval)', async () => {
    const x = await mkInvoice('mgrA', { number: 'FE-1', supplier: PP, lines: [{ description: 'x', quantity: 1, unit_price: 10, net_amount: 10, vat_rate: 15, service_code: 'other' }] });
    const al = await R.alloc('mgrA', x.lines[0].id, [{ transaction_id: TX1, amount: 10 }]);
    S.feAlloc = al.allocations[0].id;
    try { await R.approve('mgrA', [S.feAlloc]); return 'approved'; } catch (e) { return /self_approval/.test(errText(e)) || errText(e); }
  });
  await check('reject (proposed only) with a reason', async () => {
    const r = await R.reject('bmJ', S.feAlloc, 'تخصيص خاطئ');
    return (r.status === 'rejected' && r.decision_note === 'تخصيص خاطئ') || JSON.stringify(r);
  });
  await expectErr('a rejected allocation never comes back', () => R.approve('bmJ', [S.feAlloc]), /MRS_BAD_TRANSITION rejected/);
  // late cost
  const late = await mkInvoice('accA', { number: 'LATE-1', supplier: PP, lines: [{ description: 'أرضيات متأخرة', quantity: 1, unit_price: 300, net_amount: 300, vat_rate: 15, service_code: 'storage' }] });
  S.late = late;
  const la = await R.alloc('accA', late.lines[0].id, [{ transaction_id: TX4, amount: 300 }]);
  await check('late flag: transaction already under billing', async () => la.allocations[0].is_late === true || JSON.stringify(la));
  await expectErr('late allocation needs a note (MRS_NOTE_REQUIRED late_cost)', () => R.approve('mgrA', [la.allocations[0].id]), /MRS_NOTE_REQUIRED late_cost/);
  await check('late approval with a note adds an approved late_cost adjustment (document = the invoice original) + events', async () => {
    const r = await R.approve('mgrA', [la.allocations[0].id], 'وصلت فاتورة الأرضيات بعد الفوترة');
    const adj = await one(`SELECT * FROM public.cost_adjustments WHERE supplier_invoice_id = $1 AND kind = 'late_cost'`, [late.id]);
    const ev = await q(`SELECT payload ->> 'op' op FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'finance' ORDER BY id`, [TX4]);
    return (adj && adj.status === 'approved' && N(adj.amount) === 300 && adj.finance_document_id === late.finance_document_id
            && r.items[0].late_adjustment_id === adj.id && ev.map(e => e.op).join() === 'allocation_proposed,allocation_approved,late_cost') || JSON.stringify({ adj, ev });
  });
  // reverse
  await check('reverse (invoice not approved): reason kept, accrual back to open, line free again', async () => {
    const r = await R.reverse('bmJ', S.a1.id, 'خُصص للرحلة الخطأ');
    const acc = await accrualOfTrip(S.tr1.id);
    const again = await R.alloc('accA', L1, [{ transaction_id: TX1, trip_id: S.tr1.id, amount: 800 }]);
    S.a1 = again.allocations[0];
    await R.approve('mgrA', [S.a1.id]);
    const acc2 = await accrualOfTrip(S.tr1.id);
    return (r.status === 'reversed' && r.reverse_reason === 'خُصص للرحلة الخطأ' && acc.status === 'open' && N(acc.matched_amount) === 0
            && acc2.status === 'matched') || JSON.stringify({ r, acc, acc2 });
  });
  await check('invoice C1 approved once every ok line is fully allocated', async () =>
    (await R.invSt('mgrA', S.c1.id, 'approved')).status === 'approved');
  await expectErr('reverse while the invoice is approved → invoice_approved (dispute first)', () => R.reverse('mgrA', S.a1.id, 'x'), /MRS_BAD_TRANSITION invoice_approved/);
  await expectErr('void of an invoice with approved allocations → has_approved_allocations', async () => {
    await R.invSt('mgrA', S.c1.id, 'disputed', 'مراجعة');
    try { await R.invSt('mgrA', S.c1.id, 'void', 'x'); }
    finally { await R.invSt('accA', S.c1.id, 'under_review'); await R.invSt('mgrA', S.c1.id, 'approved'); }
  }, /has_approved_allocations/);
}

async function secAccruals() {
  section('6. accruals');
  await check('trip with agreed cost → one open accrual (agreed, carrier, container, transport)', async () => {
    const a = await accrualOfTrip(S.tr3.id);
    return (a.status === 'open' && N(a.amount) === 500 && a.basis === 'estimated' && a.supplier_id === PK && a.container_id === C303
            && a.service_code === 'transport' && a.source === 'trip') || JSON.stringify(a);
  });
  await check('trip without cost → accrual with amount NULL (unknown)', async () => {
    const a = await accrualOfTrip(S.tr2.id);
    return (a.status === 'open' && a.amount === null) || JSON.stringify(a);
  });
  await check('cost change while unmatched → updated in place (audit keeps the before value), still one accrual', async () => {
    await R.updTrip('opsA', S.tr3.id, { cost_amount: 550, cost_basis: 'agreed' });
    const a = await accrualOfTrip(S.tr3.id);
    const n = await count(`SELECT count(*)::int n FROM public.cost_accruals WHERE trip_id = $1`, [S.tr3.id]);
    const au = await one(`SELECT old_data ->> 'amount' o, new_data ->> 'amount' nw FROM public.audit_log WHERE table_name = 'cost_accruals' AND row_id = $1
                           AND action = 'UPDATE' ORDER BY id DESC LIMIT 1`, [a.id]);
    return (N(a.amount) === 550 && a.basis === 'agreed' && n === 1 && N(au.o) === 500 && N(au.nw) === 550) || JSON.stringify({ a, n, au });
  });
  await check('a status-only trip update changes nothing on the accrual', async () => {
    const before = await accrualOfTrip(S.tr3.id);
    await R.tripSt('opsA', S.tr3.id, 'dispatched');
    const after = await accrualOfTrip(S.tr3.id);
    return JSON.stringify(before) === JSON.stringify(after) || JSON.stringify({ before, after });
  });
  await check('cost change AFTER a match → variance, pending_amount = new cost, amount unchanged', async () => {
    await R.updTrip('opsA', S.tr1.id, { cost_amount: 950 });
    const a = await accrualOfTrip(S.tr1.id);
    return (a.status === 'variance' && N(a.amount) === 800 && N(a.pending_amount) === 950 && a.variance_reason === 'trip_cost_changed_after_match')
      || JSON.stringify(a);
  });
  const acc1 = (await accrualOfTrip(S.tr1.id)).id;
  await expectErr('review needs an approve role', () => R.revAcc('accA', acc1, 'keep_amount', 'x'), /MRS_FORBIDDEN/);
  await expectErr('review needs a note', () => R.revAcc('mgrA', acc1, 'keep_amount', ''), /MRS_NOTE_REQUIRED/);
  await expectErr('keep_open with a pending amount refused', () => R.revAcc('mgrA', acc1, 'keep_open', 'x'), /MRS_BAD_TRANSITION pending_amount/);
  await check('keep_amount → pending dropped, re-matched (matched)', async () => {
    const r = await R.revAcc('mgrA', acc1, 'keep_amount', 'السعر المتفق عليه هو المعتمد');
    return (r.status === 'matched' && r.pending_amount === null && N(r.amount) === 800) || JSON.stringify(r);
  });
  await check('accept_new_amount → amount 950, re-matched → variance amount_diff (−150)', async () => {
    await R.updTrip('opsA', S.tr1.id, { cost_amount: 940 });
    await R.updTrip('opsA', S.tr1.id, { cost_amount: 950 });
    const r = await R.revAcc('mgrA', acc1, 'accept_new_amount', 'تكلفة إضافية مقبولة');
    return (r.status === 'variance' && N(r.amount) === 950 && r.variance_reason === 'amount_diff' && N(r.variance_amount) === -150) || JSON.stringify(r);
  });
  await check('keep_open → open; the residual (amount − matched) stays an estimated cost', async () => {
    const r = await R.revAcc('mgrA', acc1, 'keep_open', 'بانتظار فاتورة الفرق');
    const items = await q(`SELECT amount, level FROM app.fin_cost_items($1) WHERE ref_id = $2`, [A, acc1]);
    return (r.status === 'open' && items.length === 1 && N(items[0].amount) === 150 && items[0].level === 'estimated') || JSON.stringify({ r, items });
  });
  await check('accept → matched (variance kept on the row)', async () => {
    await q(`UPDATE public.cost_accruals SET status = 'variance', variance_reason = 'amount_diff' WHERE id = $1`, [acc1]);
    const r = await R.revAcc('mgrA', acc1, 'accept', 'نقبل الفرق');
    return (r.status === 'matched' && r.variance_reason === 'amount_diff' && N(r.variance_amount) === -150) || JSON.stringify(r);
  });
  await check('cancel an unmatched trip → accrual void (trip_cancelled)', async () => {
    await R.tripSt('opsA', S.tr2.id, 'cancelled', 'أُلغيت الرحلة');
    const a = await accrualOfTrip(S.tr2.id);
    return (a.status === 'void' && a.void_reason === 'trip_cancelled') || JSON.stringify(a);
  });
  await check('cancel a matched trip → variance trip_cancelled_after_match; the allocation stays the only cost', async () => {
    await R.tripSt('opsA', S.tr1.id, 'cancelled', 'أُلغيت بعد التنفيذ');
    const a = await accrualOfTrip(S.tr1.id);
    const items = await q(`SELECT source, amount FROM app.fin_cost_items($1, $2) WHERE source IN ('allocation','accrual')`, [A, TX1]);
    const accItem = items.filter(i => i.source === 'accrual');
    return (a.status === 'variance' && a.variance_reason === 'trip_cancelled_after_match' && accItem.length === 0) || JSON.stringify({ a, items });
  });
  await check('backfill: exactly one accrual per non-cancelled trip (no duplicates)', async () => {
    const r = await one(`SELECT (SELECT count(*)::int FROM public.transport_trips WHERE status <> 'cancelled') t,
                                (SELECT count(*)::int FROM public.cost_accruals a JOIN public.transport_trips t ON t.id = a.trip_id
                                  WHERE t.status <> 'cancelled' AND a.status <> 'void') a,
                                (SELECT count(*)::int FROM (SELECT trip_id FROM public.cost_accruals WHERE status <> 'void' AND trip_id IS NOT NULL
                                                             GROUP BY 1 HAVING count(*) > 1) d) dup`);
    return (r.t === r.a && r.dup === 0) || JSON.stringify(r);
  });
  await check('currency mismatch: a SAR invoice cannot match a USD accrual (MRS_INVALID currency)', async () => {
    const t = await R.trip('opsA', { transaction_id: TX1, carrier_id: PK, cost_amount: 100, cost_currency: 'USD', leg_no: 9 });
    const x = await mkInvoice('accA', { number: 'USD-1', lines: [{ description: 'x', quantity: 1, unit_price: 100, net_amount: 100, vat_rate: 15, service_code: 'transport' }] });
    try { await R.alloc('accA', x.lines[0].id, [{ transaction_id: TX1, trip_id: t.id, amount: 100 }]); return 'allocated'; }
    catch (e) { return /MRS_INVALID currency/.test(errText(e)) || errText(e); }
  });
  await check('manual accrual + void (open, unmatched only)', async () => {
    const a = await R.accrual('accA', { transaction_id: TX1, supplier_id: PP, service_code: 'inspection', amount: 75 });
    const v = await rpc('accA', `SELECT public.void_accrual($1, 'لا حاجة') r`, [a.id]);
    return (a.source === 'manual' && a.status === 'open' && v.status === 'void') || JSON.stringify({ a, v });
  });
  await expectErr('void of a matched accrual refused', () => rpc('accA', `SELECT public.void_accrual($1, 'x') r`, [acc1]), /MRS_BAD_TRANSITION/);
  await expectErr('an accrual never creates a payment: no payment rows were created by any of the above', async () => {
    const n = await count(`SELECT count(*)::int n FROM public.supplier_payments`);
    if (n === 0) throw new Error('MRS_OK none');
  }, /MRS_OK none/);
}

async function secPayments() {
  section('7. supplier payments');
  const p1 = await mkInvoice('accA', { number: 'PAY-1', supplier: PP, lines: [{ description: 'رسوم', quantity: 1, unit_price: 1000, net_amount: 1000, vat_rate: 15, service_code: 'port_charges' }] });
  S.p1 = p1;
  const ev = await mkDoc('accA', JED, 'payment_evidence');
  await expectErr('reference or evidence required', () => R.pay('accA', { supplier_invoice_id: p1.id, amount: 100, paid_at: today(), method: 'bank_transfer' }), /MRS_REQUIRED reference_or_evidence/);
  await expectErr('future date refused', () => R.pay('accA', { supplier_invoice_id: p1.id, amount: 100, paid_at: '2099-01-01', method: 'cash', reference: 'r' }), /MRS_INVALID paid_at/);
  await expectErr('supervisor cannot record (read only)', () => R.pay('supA', { supplier_invoice_id: p1.id, amount: 1, method: 'cash', reference: 'r' }), /MRS_FORBIDDEN/);
  const pay1 = await R.pay('accA', { supplier_invoice_id: p1.id, amount: 500, paid_at: today(), method: 'bank_transfer', reference: 'TRX-1' });
  await check('partial payment → partial (company 500)', async () =>
    (pay1.invoice.payment_status === 'partial' && N(pay1.invoice.company_paid_amount) === 500 && pay1.currency === 'SAR') || JSON.stringify(pay1));
  await expectErr('overpay → MRS_OVERPAID (remaining 650.00)', () => R.pay('accA', { supplier_invoice_id: p1.id, amount: 650.01, method: 'cash', reference: 'r' }), /MRS_OVERPAID 650\.00/);
  const pay2 = await R.pay('accA', { supplier_invoice_id: p1.id, amount: 650, method: 'cheque', evidence_document_id: ev.id });
  await check('the rest → paid', async () => pay2.invoice.payment_status === 'paid' || JSON.stringify(pay2));
  await check('void (approve role, reason) recomputes → partial', async () => {
    const v = await R.voidPay('mgrA', pay2.id, 'شيك مرتجع');
    return (v.status === 'void' && v.invoice.payment_status === 'partial' && N(v.invoice.company_paid_amount) === 500) || JSON.stringify(v);
  });
  await expectErr('void needs an approve role', () => R.voidPay('accA', pay1.id, 'x'), /MRS_FORBIDDEN/);
  await expectErr('append-only: a direct amount change is refused', () => q(`UPDATE public.supplier_payments SET amount = 1 WHERE id = $1`, [pay1.id]), /MRS_APPEND_ONLY/);
  await expectErr('append-only: void → recorded refused', () => q(`UPDATE public.supplier_payments SET status = 'recorded', voided_at = NULL, void_reason = NULL WHERE id = $1`, [pay2.id]), /MRS_APPEND_ONLY|violates/);
  await expectErr('append-only: no delete even for the owner', () => q(`DELETE FROM public.supplier_payments WHERE id = $1`, [pay1.id]), /MRS_APPEND_ONLY/);
  // client direct
  const s1 = await mkInvoice('accA', { number: 'ST-1', supplier: PT, branch: DMM, lines: [{ description: 'أرضيات', quantity: 1, unit_price: 400, net_amount: 400, vat_rate: 15, service_code: 'storage' }] });
  S.s1 = s1;
  const cev = await mkDoc('accA', DMM, 'payment_evidence');
  await expectErr('client-direct needs client_id', () => R.pay('accA', { supplier_invoice_id: s1.id, amount: 460, method: 'bank_transfer', payer: 'client', evidence_document_id: cev.id }), /MRS_REQUIRED client_id/);
  await expectErr('client-direct needs an evidence file', () => R.pay('accA', { supplier_invoice_id: s1.id, amount: 460, method: 'bank_transfer', payer: 'client', client_id: CL102, reference: 'x' }), /MRS_REQUIRED evidence_document_id/);
  // the S1 cost is allocated (TX2, client 102, storage case) before the client's direct payment: it settles that client's share
  S.dc2 = await R.dcase('accA', { transaction_id: TX2, kind: 'storage', container_id: C303, operator_id: PT, estimated_amount: 400 });
  const s1al = await R.alloc('accA', s1.lines[0].id, [{ transaction_id: TX2, demurrage_case_id: S.dc2.id, amount: 400 }]);
  await R.approve('bmD', [s1al.allocations[0].id]);
  S.s1Alloc = s1al.allocations[0].id;
  await expectErr('client-direct by a client with no allocation on the invoice → MRS_INVALID client_id', () => R.pay('accA',
    { supplier_invoice_id: s1.id, amount: 10, method: 'bank_transfer', payer: 'client', client_id: CL101, evidence_document_id: cev.id }), /MRS_INVALID client_id/);
  await expectErr('client-direct above that client\'s allocated gross → MRS_OVERPAID (460.00)', () => R.pay('accA',
    { supplier_invoice_id: s1.id, amount: 460.01, method: 'bank_transfer', payer: 'client', client_id: CL102, evidence_document_id: cev.id }), /MRS_OVERPAID 460\.00/);
  await check('client paid the supplier directly → paid_directly_by_client (company paid 0)', async () => {
    const r = await R.pay('accA', { supplier_invoice_id: s1.id, amount: 460, method: 'bank_transfer', payer: 'client', client_id: CL102, evidence_document_id: cev.id });
    return (r.invoice.payment_status === 'paid_directly_by_client' && N(r.invoice.company_paid_amount) === 0 && N(r.invoice.client_paid_amount) === 460) || JSON.stringify(r);
  });
  await check('a payment never creates a charge, collection, accrual or allocation', async () => {
    const r = await one(`SELECT (SELECT count(*)::int FROM public.client_charges) c, (SELECT count(*)::int FROM public.charge_collections) k,
                                (SELECT count(*)::int FROM public.cost_allocations WHERE supplier_invoice_id IN ($1, $2)) a`, [p1.id, s1.id]);
    return (r.c === 0 && r.k === 0 && r.a === 1) || JSON.stringify(r);   // the one S1 allocation made above
  });
  await check('client-direct on an invoice whose allocation carries a reimbursable charge → charged_to_client', async () => {
    const x = await mkInvoice('accA', { number: 'RB-1', supplier: PP, lines: [{ description: 'رسوم', quantity: 1, unit_price: 200, net_amount: 200, vat_rate: 15, service_code: 'port_charges' }] });
    const al = await R.alloc('accA', x.lines[0].id, [{ transaction_id: TX1, amount: 200 }]);
    await R.approve('mgrA', [al.allocations[0].id]);
    S.rbAlloc = al.allocations[0].id; S.rbInv = x;
    await R.charge('accA', { transaction_id: TX1, kind: 'reimbursable', description: 'رسوم ميناء مستردة', source: 'from_cost', cost_allocation_id: S.rbAlloc });
    try { await R.pay('accA', { supplier_invoice_id: x.id, amount: 230, method: 'cash', payer: 'client', client_id: CL101, evidence_document_id: (await mkDoc('accA', JED, 'payment_evidence')).id }); return 'paid'; }
    catch (e) { return /MRS_BAD_TRANSITION charged_to_client/.test(errText(e)) || errText(e); }
  });
  await check('credit note: no payment (MRS_BAD_TRANSITION credit_note)', async () => {
    const cn = await R.inv('accA', { branch_id: JED, supplier_id: PP, doc_type: 'credit_note', adjusts_invoice_id: p1.id, invoice_number: 'CN-PAY', invoice_date: today(), subtotal: 100, vat_amount: 15 });
    try { await R.pay('accA', { supplier_invoice_id: cn.id, amount: 10, method: 'cash', reference: 'r' }); return 'paid'; }
    catch (e) { return /credit_note/.test(errText(e)) || errText(e); }
  });
  await check('list_supplier_payments: three separate figures per currency', async () => {
    await R.invSt('accA', p1.id, 'under_review');
    const al = await R.alloc('accA', p1.lines[0].id, [{ transaction_id: TX1, amount: 1000 }]);
    await R.approve('mgrA', [al.allocations[0].id]);
    await R.invSt('mgrA', p1.id, 'approved');
    const r = await rpc('supA', `SELECT public.list_supplier_payments($1, '{}') r`, [A]);
    const t = r.totals_by_currency.SAR;
    // due: C1 (1035) + G? (disputed, not approved) + ADM-1 (57.5 approved, unpaid) + LATE-1 (not approved) + PAY-1 (1150 − 500)
    return (N(t.paid_by_company) === 500 && N(t.paid_by_client_direct) === 460 && N(t.due_approved_unpaid) === 1035 + 57.5 + 650
            && r.items.length === 3) || JSON.stringify(r);
  });
}

async function secCharges() {
  section('8. client charges');
  await check('manual service: price independent of cost (no cost link), VAT 15 by default', async () => {
    const c = await R.charge('accA', { transaction_id: TX1, kind: 'service', description: 'أتعاب تخليص', quantity: 2, unit_price: 1250, service_code: 'customs_clearance' });
    S.chService = c;
    return (N(c.net_amount) === 2500 && N(c.vat_amount) === 375 && N(c.total_amount) === 2875 && c.cost_allocation_id === null && c.accrual_id === null
            && c.source === 'manual' && c.status === 'draft') || JSON.stringify(c);
  });
  await check('reimbursable: VAT 0 by default', async () => {
    const c = await R.charge('accA', { transaction_id: TX1, kind: 'reimbursable', description: 'رسوم فحص', unit_price: 100 });
    return (N(c.vat_rate) === 0 && N(c.total_amount) === 100) || JSON.stringify(c);
  });
  await expectErr('manual charge with a cost link refused', () => R.charge('accA', { transaction_id: TX1, kind: 'service', description: 'x', unit_price: 1, cost_allocation_id: S.a1.id }), /MRS_INVALID cost_link/);
  await check('markup: price = round(cost × (1 + pct), 2) computed once and stored', async () => {
    const c = await R.charge('accA', { transaction_id: TX1, kind: 'service', description: 'نقل', source: 'markup', cost_allocation_id: S.a1.id, markup_pct: 12.5 });
    S.chMarkup = c;
    return (N(c.unit_price) === 900 && N(c.cost_snapshot) === 800 && N(c.markup_pct) === 12.5 && c.cost_changed === false) || JSON.stringify(c);
  });
  await expectErr('no double charge on one cost (cost_charged)', () => R.charge('accA', { transaction_id: TX1, kind: 'reimbursable', description: 'x', source: 'from_cost', cost_allocation_id: S.a1.id }), /MRS_INVALID cost_charged/);
  await expectErr('no double charge: the unique index holds for a direct insert too', () => q(`
    INSERT INTO public.client_charges (org_id, transaction_id, kind, description, unit_price, source, cost_allocation_id, cost_snapshot)
    VALUES ($1, $2, 'service', 'x', 1, 'from_cost', $3, 1)`, [A, TX1, S.a1.id]), /duplicate key|unique/);
  await check('from_trip takes the trip sell amount (G3 sell becomes a charge only here)', async () => {
    const t = await R.trip('opsA', { transaction_id: TX1, carrier_id: PK, cost_amount: 300, sell_amount: 450, sell_currency: 'SAR', leg_no: 7 });
    S.sellTrip = t;
    const c = await R.charge('accA', { transaction_id: TX1, kind: 'service', description: 'نقل داخلي', source: 'from_trip', trip_id: t.id });
    S.chTrip = c;
    return (N(c.unit_price) === 450 && c.trip_id === t.id && N(c.vat_rate) === 15) || JSON.stringify(c);
  });
  await expectErr('a trip is charged once (trip_charged)', () => R.charge('accA', { transaction_id: TX1, kind: 'service', description: 'x', source: 'from_trip', trip_id: S.sellTrip.id }), /trip_charged/);
  await check('paid_by_client guard: a reimbursable charge on a cost the client paid directly is refused', async () => {
    try { await R.charge('bmD', { transaction_id: TX2, kind: 'reimbursable', description: 'أرضيات', source: 'from_cost', cost_allocation_id: S.s1Alloc }); return 'created'; }
    catch (e) { return /MRS_INVALID paid_by_client/.test(errText(e)) || errText(e); }
  });
  await expectErr('invoiced is reserved for G5 (g5_only)', () => R.chargeSt('mgrA', S.chService.id, 'invoiced'), /MRS_BAD_TRANSITION g5_only/);
  await expectErr('approval needs an approve role', () => R.chargeSt('accA', S.chService.id, 'approved'), /MRS_FORBIDDEN/);
  await check('draft → approved; edits refused afterwards', async () => {
    const r = await R.chargeSt('mgrA', S.chService.id, 'approved');
    let locked = false;
    try { await rpc('accA', `SELECT public.update_client_charge($1, '{"note":"x"}') r`, [S.chService.id]); } catch (e) { locked = /MRS_BAD_TRANSITION/.test(errText(e)); }
    return (r.status === 'approved' && locked) || JSON.stringify(r);
  });
  await expectErr('approved → draft needs a note', () => R.chargeSt('mgrA', S.chService.id, 'draft'), /MRS_NOTE_REQUIRED/);
  await check('draft edit: manual price change re-prices; markup edit re-prices from the snapshot', async () => {
    const m = await rpc('accA', `SELECT public.update_client_charge($1, $2) r`, [S.chMarkup.id, { markup_pct: 25 }]);
    return N(m.unit_price) === 1000 || JSON.stringify(m);
  });
  await check('void (approve role + note) frees the cost for a new charge', async () => {
    await R.chargeSt('mgrA', S.chMarkup.id, 'void', 'تسعير خاطئ');
    const c = await R.charge('accA', { transaction_id: TX1, kind: 'service', description: 'نقل', source: 'from_cost', cost_allocation_id: S.a1.id });
    S.chFromCost = c;
    return (N(c.unit_price) === 800 && c.status === 'draft') || JSON.stringify(c);
  });
}

async function secCollections() {
  section('9. charge collections');
  await expectErr('a draft charge takes no collection', () => R.collect('accA', { charge_id: S.chFromCost.id, amount: 1, method: 'cash', reference: 'r' }), /MRS_BAD_TRANSITION charge_draft/);
  const k1 = await R.collect('accA', { charge_id: S.chService.id, amount: 2000, method: 'bank_transfer', reference: 'RCPT-1' });
  await check('collection recorded on an approved charge (currency of the charge)', async () => (k1.status === 'recorded' && k1.currency === 'SAR' && k1.transaction_id === TX1) || JSON.stringify(k1));
  await expectErr('Σ collections ≤ charge total → MRS_OVERPAID (remaining 875.00)', () => R.collect('accA', { charge_id: S.chService.id, amount: 875.01, method: 'cash', reference: 'r' }), /MRS_OVERPAID 875\.00/);
  await expectErr('a charge with collections cannot be voided', () => R.chargeSt('mgrA', S.chService.id, 'void', 'x'), /has_collections/);
  await check('void collection (approve role) then the full amount fits', async () => {
    await rpc('mgrA', `SELECT public.void_charge_collection($1, 'إيصال مكرر') r`, [k1.id]);
    const k2 = await R.collect('accA', { charge_id: S.chService.id, amount: 2875, method: 'bank_transfer', reference: 'RCPT-2' });
    return k2.status === 'recorded';
  });
  await expectErr('append-only collections: no delete', () => q(`DELETE FROM public.charge_collections WHERE id = $1`, [k1.id]), /MRS_APPEND_ONLY/);
}

async function secDemurrage() {
  section('10. demurrage: four figures on fixed data');
  // TX2 case S.dc2: estimate 400 (+15 %), S1 (400 + 60) allocated and approved, paid 460 directly by the client
  await check('case accrual: estimate 400 matched by the S1 allocation', async () => {
    const a = await one(`SELECT * FROM public.cost_accruals WHERE demurrage_case_id = $1`, [S.dc2.id]);
    return (a.status === 'matched' && N(a.matched_amount) === 400 && a.service_code === 'storage') || JSON.stringify(a);
  });
  await check('charge + collection on the case (manual service charge 500 + 15 %, collected 300)', async () => {
    const c = await R.charge('bmD', { transaction_id: TX2, kind: 'service', description: 'أرضيات على العميل', unit_price: 500, demurrage_case_id: S.dc2.id });
    await R.chargeSt('bmD', c.id, 'approved');
    S.dcCharge = c;
    await R.collect('bmD', { charge_id: c.id, amount: 300, method: 'cash', reference: 'R-9' });
    return true;
  });
  await check('figures: charged 575, collected 300, paid to operator 0, paid by client 460, due 460, remaining {275, 0}', async () => {
    const r = await rpc('bmD', `SELECT public.list_demurrage($1, $2) r`, [A, { transaction_id: TX2 }]);
    const f = r.items[0].figures;
    return (N(f.charged_to_client) === 575 && N(f.collected_from_client) === 300 && N(f.paid_to_operator) === 0
            && N(f.paid_by_client_to_operator) === 460 && N(f.operator_due) === 460 && f.operator_due_level === 'allocated'
            && N(f.remaining.to_collect) === 275 && N(f.remaining.to_pay_operator) === 0) || JSON.stringify(f);
  });
  await check('estimate only (no allocation yet): operator_due = estimate × 1.15 (estimated)', async () => {
    const c = await R.dcase('accA', { transaction_id: TX1, kind: 'demurrage', container_id: C301, operator_id: PP, estimated_amount: 200,
                                      free_until: '2026-10-01', charged_until: '2026-10-06' });
    S.dc1 = c;
    return (N(c.figures.operator_due) === 230 && c.figures.operator_due_level === 'estimated' && c.days === 5 && !!c.accrual_id) || JSON.stringify(c);
  });
  await check('estimate change while unmatched → accrual updated in place', async () => {
    await rpc('accA', `SELECT public.update_demurrage_case($1, $2) r`, [S.dc1.id, { estimated_amount: 260 }]);
    const a = await one(`SELECT amount, status FROM public.cost_accruals WHERE demurrage_case_id = $1 AND status <> 'void'`, [S.dc1.id]);
    return (N(a.amount) === 260 && a.status === 'open') || JSON.stringify(a);
  });
  await expectErr('operator must be a terminal / agent / yard', () => R.dcase('accA', { transaction_id: TX1, kind: 'storage', operator_id: PK }), /MRS_INVALID operator_id/);
  await expectErr('waive needs an approve role', () => rpc('accA', `SELECT public.set_demurrage_status($1, 'waived', 'x') r`, [S.dc1.id]), /MRS_FORBIDDEN/);
  await check('waived (approve role + note) → its unmatched accrual is void', async () => {
    const r = await rpc('mgrA', `SELECT public.set_demurrage_status($1, 'waived', 'تنازل المشغل') r`, [S.dc1.id]);
    const a = await one(`SELECT status FROM public.cost_accruals WHERE demurrage_case_id = $1`, [S.dc1.id]);
    return (r.status === 'waived' && a.status === 'void') || JSON.stringify({ r, a });
  });
}

async function secAdjustments() {
  section('11. cost adjustments');
  await expectErr('a fee needs a document (no file, no document, no invoice)', () => R.adj('accA', { kind: 'washing', transaction_id: TX1, amount: 50, reason: 'غسيل' }), /MRS_REQUIRED document/);
  await expectErr('CHECK: document link (direct insert)', () => q(`INSERT INTO public.cost_adjustments (org_id, kind, transaction_id, reason) VALUES ($1, 'other', $2, 'x')`, [A, TX1]), /cost_adjustments_doc_chk/);
  await expectErr('CHECK: duplicate_invoice needs related_invoice_id ≠ itself (direct insert)', () => q(`
    INSERT INTO public.cost_adjustments (org_id, kind, supplier_invoice_id, related_invoice_id, reason) VALUES ($1, 'duplicate_invoice', $2, $2, 'x')`, [A, S.c1.id]),
    /cost_adjustments_related_chk/);
  await expectErr('duplicate_invoice of another supplier refused', () => R.adj('accA', { kind: 'duplicate_invoice', supplier_invoice_id: S.ppDup, related_invoice_id: S.c1.id, reason: 'x' }), /MRS_INVALID related_invoice_id/);
  await expectErr('reason required', () => R.adj('accA', { kind: 'other', supplier_invoice_id: S.c1.id }), /MRS_NOTE_REQUIRED|MRS_REQUIRED/);
  // fee → accrual → later invoice matches it
  const fd = await mkDoc('accA', JED, 'adjustment_evidence');
  const fee = await R.adj('accA', { kind: 'repair', transaction_id: TX1, container_id: C302, supplier_id: PP, amount: 350, finance_document_id: fd.id, reason: 'إصلاح باب الحاوية' });
  await expectErr('four eyes on adjustments', () => R.revAdj('accA', fee.id, 'approved', 'x'), /MRS_FORBIDDEN/);
  await check('approved fee creates an expected cost (source adjustment) on the transaction', async () => {
    const r = await R.revAdj('mgrA', fee.id, 'approved', 'موافق حسب تقرير الإصلاح');
    const a = await accrualById(r.accrual_id);
    S.feeAcc = a;
    return (r.status === 'approved' && a.source === 'adjustment' && a.adjustment_id === fee.id && N(a.amount) === 350 && a.service_code === 'repair'
            && a.status === 'open') || JSON.stringify({ r, a });
  });
  await check('the later repair invoice line matches that accrual like a trip', async () => {
    const x = await mkInvoice('accA', { number: 'REP-1', supplier: PP, lines: [{ description: 'إصلاح', quantity: 1, unit_price: 350, net_amount: 350, vat_rate: 15, service_code: 'repair' }] });
    const al = await R.alloc('accA', x.lines[0].id, [{ transaction_id: TX1, accrual_id: S.feeAcc.id, amount: 350 }]);
    await R.approve('mgrA', [al.allocations[0].id]);
    const a = await accrualById(S.feeAcc.id);
    return (a.status === 'matched' && N(a.matched_amount) === 350) || JSON.stringify(a);
  });
  await check('rejected adjustment: kept, no effect', async () => {
    const j = await R.adj('accA', { kind: 'other', transaction_id: TX1, amount: 10, document_id: null, finance_document_id: fd.id, reason: 'رسوم غير مستحقة' });
    const r = await R.revAdj('mgrA', j.id, 'rejected', 'غير مستحقة');
    return (r.status === 'rejected' && r.accrual_id === null) || JSON.stringify(r);
  });
  await check('approved duplicate_invoice voids the copy (duplicate_of_id), file and lines stay', async () => {
    const dup = await mkInvoice('accA', { number: 'INV-0012-B', lines: [{ description: 'نقل حاوية 1', quantity: 1, unit_price: 800, net_amount: 800, vat_rate: 15, service_code: 'transport' }] });
    const j = await R.adj('accA', { kind: 'duplicate_invoice', supplier_invoice_id: dup.id, related_invoice_id: S.c1.id, reason: 'نفس الفاتورة بترقيم مختلف' });
    await R.revAdj('mgrA', j.id, 'approved', 'مكررة');
    const v = await invRow(dup.id);
    const n = await count(`SELECT count(*)::int n FROM public.supplier_invoice_lines WHERE supplier_invoice_id = $1`, [dup.id]);
    const items = await count(`SELECT count(*)::int n FROM app.fin_cost_items($1) WHERE supplier_invoice_id = $2`, [A, dup.id]);
    return (v.status === 'void' && v.void_reason === 'duplicate' && v.duplicate_of_id === S.c1.id && v.finance_document_id && n === 1 && items === 0) || JSON.stringify({ v, n, items });
  });
  await check('duplicate approval refused when the copy has payments', async () => {
    const dup = await mkInvoice('accA', { number: 'DUP-PAID', lines: [{ description: 'x', quantity: 1, unit_price: 10, net_amount: 10, vat_rate: 15, service_code: 'transport' }] });
    await R.pay('accA', { supplier_invoice_id: dup.id, amount: 5, method: 'cash', reference: 'r' });
    const j = await R.adj('accA', { kind: 'duplicate_invoice', supplier_invoice_id: dup.id, related_invoice_id: S.c1.id, reason: 'مكررة' });
    try { await R.revAdj('mgrA', j.id, 'approved', 'x'); return 'approved'; } catch (e) { return /has_payments/.test(errText(e)) || errText(e); }
  });
}

async function secReports() {
  section('12. cost items, margins, reports');
  await check('invariant: for every non-void invoice, Σ items (allocation / overhead / unallocated) = Σ net of non-excluded lines', async () => {
    const r = await q(`
      WITH it AS (SELECT supplier_invoice_id si, sum(amount) s FROM app.fin_cost_items($1) WHERE source IN ('allocation','overhead','unallocated') GROUP BY 1),
           ln AS (SELECT i.id si, sum(l.net_amount) * CASE WHEN i.doc_type = 'credit_note' THEN -1 ELSE 1 END s
                    FROM public.supplier_invoices i JOIN public.supplier_invoice_lines l ON l.supplier_invoice_id = i.id
                   WHERE i.org_id = $1 AND i.status <> 'void' AND l.review_status <> 'excluded' GROUP BY i.id, i.doc_type)
      SELECT ln.si, ln.s, coalesce(it.s, 0) got FROM ln LEFT JOIN it ON it.si = ln.si WHERE ln.s <> coalesce(it.s, 0)`, [A]);
    const n = await count(`SELECT count(*)::int n FROM public.supplier_invoices WHERE org_id = $1 AND status <> 'void'`, [A]);
    return (r.length === 0 && n > 5) || JSON.stringify(r);
  });
  await check('no item for excluded lines, void invoices, proposed / rejected / reversed allocations, matched / void accruals', async () => {
    const r = await one(`SELECT
      (SELECT count(*)::int FROM app.fin_cost_items($1) i JOIN public.supplier_invoice_lines l ON l.id = i.ref_id WHERE l.review_status = 'excluded') ex,
      (SELECT count(*)::int FROM app.fin_cost_items($1) i JOIN public.supplier_invoices s ON s.id = i.supplier_invoice_id WHERE s.status = 'void') vo,
      (SELECT count(*)::int FROM app.fin_cost_items($1) i JOIN public.cost_allocations a ON a.id = i.ref_id WHERE a.status <> 'approved') al,
      (SELECT count(*)::int FROM app.fin_cost_items($1) i JOIN public.cost_accruals a ON a.id = i.ref_id WHERE a.status <> 'open') ac`, [A]);
    return (r.ex === 0 && r.vo === 0 && r.al === 0 && r.ac === 0) || JSON.stringify(r);
  });
  await check('tx_margin TX2 (exact): service 500, cost confirmed 550 (trip, estimated) …', async () => {
    const m = await R.margin('bmD', TX2);
    const c = m.currencies.find(x => x.currency === 'SAR');
    // TX2: trip TR3 accrual open 550 (estimated); S1 allocation 400 approved on an approved? (S1 not approved → estimated) paid by client (share 1)
    return (m.analytical === true && N(c.charges_service) === 500 && N(c.cost_estimated) === 550 && N(c.cost_confirmed) === 0
            && N(c.client_paid_direct) === 400 && N(c.margin_confirmed) === 500 && N(c.margin_expected) === -50 && m.level === 'estimated'
            && m.pending.some(p => p.type === 'open_accrual')) || JSON.stringify(m);
  });
  await check('tx_margin: unknown level when an open accrual has no amount', async () => {
    const t = await R.trip('opsA', { transaction_id: TX4, carrier_id: PK });
    const m = await R.margin('accA', TX4);
    await R.tripSt('opsA', t.id, 'cancelled', 'x');
    const m2 = await R.margin('accA', TX4);
    return (m.level === 'unknown' && m.pending.some(p => p.type === 'unknown_accrual') && m2.level !== 'unknown') || JSON.stringify({ m, m2 });
  });
  await check('cost_report: every group_by answers, totals per currency', async () => {
    const out = {};
    for (const g of ['transaction', 'client', 'supplier', 'service', 'branch', 'level']) {
      const r = await rpc('accA', `SELECT public.cost_report($1, $2) r`, [A, { group_by: g }]);
      out[g] = r.rows.length;
      if (!r.rows.length || !r.totals_by_currency.SAR) return g + ': ' + JSON.stringify(r);
    }
    return Object.values(out).every(n => n > 0) || JSON.stringify(out);
  });
  await check('cost_report branch scope: DMM branch manager sees DMM items only; JED accountant none of DMM', async () => {
    const d = await rpc('bmD', `SELECT public.cost_report($1, $2) r`, [A, { group_by: 'branch' }]);
    const j = await rpc('accJ', `SELECT public.cost_report($1, $2) r`, [A, { group_by: 'branch' }]);
    return (d.rows.every(x => x.key === DMM) && d.rows.length > 0 && j.rows.every(x => x.key === JED)) || JSON.stringify({ d: d.rows, j: j.rows });
  });
  await expectErr('cost_report: group_by required', () => rpc('accA', `SELECT public.cost_report($1, '{}') r`, [A]), /MRS_REQUIRED group_by/);
  await check('margin_report: rows per transaction / currency, branch-scoped, with level and pending count', async () => {
    const r = await rpc('accA', `SELECT public.margin_report($1, '{}') r`, [A]);
    const d = await rpc('bmD', `SELECT public.margin_report($1, '{}') r`, [A]);
    return (r.items.some(i => i.transaction_id === TX1) && r.items.some(i => i.transaction_id === TX2) && d.items.every(i => i.branch_id === DMM)
            && r.totals_by_currency.SAR && r.analytical === true) || JSON.stringify({ r, d });
  });
  await check('cost_review_queue lists pending lines, discrepancies and variances', async () => {
    const r = await rpc('accA', `SELECT public.cost_review_queue($1, '{}') r`, [A]);
    return (r.counts.lines_pending > 0 && r.counts.invoices_discrepancy > 0 && r.lines_pending.some(l => l.id === S.ocrLine)) || JSON.stringify(r.counts);
  });
  await check('list_supplier_invoices: counts by status / payment status, q search, needs_review', async () => {
    const r = await rpc('accA', `SELECT public.list_supplier_invoices($1, $2) r`, [A, { q: 'inv 12' }]);
    const nr = await rpc('accA', `SELECT public.list_supplier_invoices($1, $2) r`, [A, { needs_review: true }]);
    return (r.items.some(i => i.id === S.c1.id) && r.counts.by_status.approved >= 1 && nr.items.some(i => i.id === S.lInv)
            && !nr.items.some(i => i.id === S.c1.id)) || JSON.stringify({ r: r.counts, nr: nr.total });
  });
  await check('get_supplier_invoice: lines with allocations, payments, discrepancy, can flags', async () => {
    const r = await R.getInv('accA', S.c1.id);
    return (r.lines.length === 2 && r.lines[0].allocations.length >= 1 && r.can.approve === false && r.can.void === false && r.can.pay === true
            && r.invoice.supplier_name === 'ناقل الاختبار') || JSON.stringify(r.can);
  });
  await check('tx_costs + suggest_client_charges for TX1', async () => {
    const c = await rpc('accA', `SELECT public.tx_costs($1) r`, [TX1]);
    const s = await rpc('accA', `SELECT public.suggest_client_charges($1) r`, [TX1]);
    return (c.allocations.length > 0 && c.accruals.length > 0 && c.charges.length > 0 && Array.isArray(s.trips_with_sell)
            && s.reimbursable_costs.every(x => x.cost_allocation_id !== S.a1.id)) || JSON.stringify({ s });
  });
}

async function secIsolation() {
  section('isolation: other org, other branch, non-finance staff, clients');
  for (const t of G4_TABLES) {
    await check(`${t}: org B, transport staff, clearance staff, operations manager and the client read 0 rows`, async () => {
      const r = [];
      for (const who of ['accB', 'trJ', 'clrJ', 'opsA', 'clientA']) r.push(who + ':' + await denied(who, `SELECT 1 FROM public.${t}`));
      return r.every(x => x.endsWith(':true')) || r.join(' ');
    });
  }
  await check('JED accountant reads no DMM invoice / allocation / accrual of a DMM transaction', async () => {
    const r = [await denied('accJ', `SELECT 1 FROM public.supplier_invoices WHERE branch_id = $1`, [DMM]),
               await denied('accJ', `SELECT 1 FROM public.cost_accruals WHERE transaction_id = $1`, [TX2]),
               await denied('accJ', `SELECT 1 FROM public.client_charges WHERE transaction_id = $1`, [TX2])];
    return r.every(x => x === true) || r.join();
  });
  await expectErr('get_supplier_invoice of a DMM invoice by the JED accountant → MRS_NOT_FOUND', () => R.getInv('accJ', S.s1.id), /MRS_NOT_FOUND/);
  await expectErr('org B: list_supplier_invoices(org A) → MRS_FORBIDDEN', () => rpc('accB', `SELECT public.list_supplier_invoices($1) r`, [A]), /MRS_FORBIDDEN/);
  await expectErr('org B: get_supplier_invoice → MRS_NOT_FOUND', () => R.getInv('accB', S.c1.id), /MRS_NOT_FOUND/);
  await expectErr('org B: tx_margin → MRS_NOT_FOUND', () => R.margin('accB', TX1), /MRS_NOT_FOUND/);
  await expectErr('operations manager: tx_margin → MRS_FORBIDDEN finance', () => R.margin('opsA', TX1), /MRS_FORBIDDEN finance/);
  await expectErr('transport staff: tx_costs → MRS_FORBIDDEN finance', () => rpc('trJ', `SELECT public.tx_costs($1) r`, [TX1]), /MRS_FORBIDDEN finance/);
  await expectErr('clearance staff: list_demurrage → MRS_FORBIDDEN', () => rpc('clrJ', `SELECT public.list_demurrage($1) r`, [A]), /MRS_FORBIDDEN/);
  await expectErr('client: tx_margin → MRS_NOT_FOUND', () => R.margin('clientA', TX1), /MRS_NOT_FOUND/);
  await expectErr('client: list_client_charges → MRS_NOT_FOUND', () => rpc('clientA', `SELECT public.list_client_charges($1) r`, [TX1]), /MRS_NOT_FOUND/);
  await expectErr('client: cost_report → MRS_FORBIDDEN', () => rpc('clientA', `SELECT public.cost_report($1, '{"group_by":"level"}') r`, [A]), /MRS_FORBIDDEN/);
  await expectErr('anon cannot call any G4 RPC', () => rpc('anon', `SELECT public.tx_margin($1) r`, [TX1]), /permission denied/);
  await check('supervisor reads every list but cannot write', async () => {
    const l = await rpc('supA', `SELECT public.list_supplier_invoices($1) r`, [A]);
    const m = await R.margin('supA', TX1);
    let w = '';
    try { await R.charge('supA', { transaction_id: TX1, kind: 'service', description: 'x', unit_price: 1 }); } catch (e) { w = errText(e); }
    return (l.total > 0 && m.transaction_id === TX1 && /MRS_FORBIDDEN/.test(w)) || JSON.stringify({ t: l.total, w });
  });
  await check('client sees no finance events (and finance events never carry amounts)', async () => {
    const c = (await as('clientA', `SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'finance'`))[0].n;
    const r = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE visible_to_client)::int v,
                                count(*) FILTER (WHERE jsonb_path_exists(payload, '$.** ? (@.type() == "number")'))::int num
                           FROM public.transaction_events WHERE event_type = 'finance'`);
    return (c === 0 && r.n > 0 && r.v === 0 && r.num === 0) || JSON.stringify({ c, r });
  });
}

async function secIdempotency() {
  section('idempotent replays: every create RPC');
  const doc = await mkDoc('accA', JED);
  const inv = await mkInvoice('accA', { number: 'IDEM-1', lines: [{ description: 'x', quantity: 1, unit_price: 100, net_amount: 100, vat_rate: 15, service_code: 'transport' }] });
  const cases = [
    ['register_finance_document', k => R.doc('accA', { branch_id: JED, original_name: 'i.pdf', size_bytes: 3, sha256: 'e'.repeat(64) }, k),
                                  k => R.doc('accA', { branch_id: JED, original_name: 'j.pdf', size_bytes: 3, sha256: 'e'.repeat(64) }, k)],
    ['create_supplier_invoice', k => R.inv('accA', { branch_id: JED, supplier_id: PP, invoice_number: 'IDEM-2', invoice_date: today(), subtotal: 10, finance_document_id: doc.id }, k),
                                k => R.inv('accA', { branch_id: JED, supplier_id: PP, invoice_number: 'IDEM-3', invoice_date: today(), subtotal: 10 }, k)],
    ['add_invoice_lines', k => R.lines('accA', inv.id, [{ description: 'y', net_amount: 5, service_code: 'transport' }], 'manual', k),
                          k => R.lines('accA', inv.id, [{ description: 'z', net_amount: 5 }], 'manual', k)],
    ['allocate_invoice_line', k => R.alloc('accA', inv.lines[0].id, [{ transaction_id: TX1, amount: 40 }], k),
                              k => R.alloc('accA', inv.lines[0].id, [{ transaction_id: TX1, amount: 41 }], k)],
    ['create_accrual', k => R.accrual('accA', { transaction_id: TX1, amount: 5 }, k), k => R.accrual('accA', { transaction_id: TX1, amount: 6 }, k)],
    ['record_supplier_payment', k => R.pay('accA', { supplier_invoice_id: inv.id, amount: 10, method: 'cash', reference: 'I1' }, k),
                                k => R.pay('accA', { supplier_invoice_id: inv.id, amount: 11, method: 'cash', reference: 'I1' }, k)],
    ['create_client_charge', k => R.charge('accA', { transaction_id: TX1, kind: 'service', description: 'i', unit_price: 1 }, k),
                             k => R.charge('accA', { transaction_id: TX1, kind: 'service', description: 'i', unit_price: 2 }, k)],
    ['record_charge_collection', k => R.collect('bmD', { charge_id: S.dcCharge.id, amount: 1, method: 'cash', reference: 'I' }, k),
                                 k => R.collect('bmD', { charge_id: S.dcCharge.id, amount: 2, method: 'cash', reference: 'I' }, k)],
    ['create_demurrage_case', k => R.dcase('accA', { transaction_id: TX1, kind: 'detention' }, k), k => R.dcase('accA', { transaction_id: TX1, kind: 'storage' }, k)],
    ['create_cost_adjustment', k => R.adj('accA', { kind: 'amendment', supplier_invoice_id: inv.id, reason: 'تعديل' }, k),
                               k => R.adj('accA', { kind: 'amendment', supplier_invoice_id: inv.id, reason: 'تعديل آخر' }, k)]
  ];
  for (const [name, call, other] of cases) {
    await check(`${name}: replay returns the first result (replayed); a different payload with the key → MRS_IDEMPOTENCY_CONFLICT`, async () => {
      const k = newKey();
      const a = await call(k); const b = await call(k);
      const ida = a.id || (a.lines && a.lines[0].id) || (a.allocations && a.allocations[0].id);
      const idb = b.id || (b.lines && b.lines[0].id) || (b.allocations && b.allocations[0].id);
      let conflict = '';
      try { await other(k); } catch (e) { conflict = errText(e); }
      return (ida && ida === idb && b.replayed === true && /MRS_IDEMPOTENCY_CONFLICT/.test(conflict)) || JSON.stringify({ ida, idb, r: b.replayed, conflict });
    });
  }
}


/* ------------------------------------------------------------------ review fixes (regression) */
const TXR = n => 'abc40000-0000-4000-8000-0000000005' + String(n).padStart(2, '0');
async function mkTx(id, branch, client) {
  await q(`INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, $4, 'import', 'sea')`, [id, A, branch, client]);
  return id;
}
async function approveInv(inv) { await R.invSt('accA', inv.id, 'under_review'); return R.invSt('mgrA', inv.id, 'approved'); }
const curOf = (m, c) => (m.currencies || []).find(x => x.currency === (c || 'SAR')) || {};
async function tryErr(fn) { try { await fn(); return 'ok'; } catch (e) { return errText(e); } }

async function secReviewFixes() {
  section('review fixes: isolation, money integrity, readers');
  const T5 = await mkTx(TXR(5), JED, CL101), T6 = await mkTx(TXR(6), JED, CL102), T7 = await mkTx(TXR(7), JED, CL101);
  const T8 = await mkTx(TXR(8), JED, CL101), T9 = await mkTx(TXR(9), JED, CL101), T10 = await mkTx(TXR(10), JED, CL101);
  const T11 = await mkTx(TXR(11), JED, CL101);
  const portLine = (net) => [{ description: 'رسوم ميناء', quantity: 1, unit_price: net, net_amount: net, vat_rate: 15, service_code: 'port_charges' }];
  const trLine = (net) => [{ description: 'نقل', quantity: 1, unit_price: net, net_amount: net, vat_rate: 15, service_code: 'transport' }];

  // --- 1. get_supplier_invoice: a duplicate claim on another branch's invoice stays under that invoice's read rule
  const IJ = await mkInvoice('accA', { number: 'RF-DUP-J', supplier: PP, branch: JED, lines: portLine(4321) });
  const ID = await mkInvoice('accA', { number: 'RF-DUP-D', supplier: PP, branch: DMM, lines: [{ description: 'سعر سري الدمام', quantity: 1, unit_price: 4321, net_amount: 4321, vat_rate: 15, service_code: 'port_charges' }] });
  const dupAdj = await R.adj('accA', { kind: 'duplicate_invoice', supplier_invoice_id: ID.id, related_invoice_id: IJ.id, amount: 4321, reason: 'DMM internal reason' });
  await check('get_supplier_invoice(JED original) as the JED accountant hides the DMM duplicate adjustment', async () => {
    const j = await R.getInv('accJ', IJ.id), a = await R.getInv('accA', IJ.id);
    return (!j.adjustments.some(x => x.id === dupAdj.id) && a.adjustments.some(x => x.id === dupAdj.id)) || JSON.stringify({ j: j.adjustments, a: a.adjustments.length });
  });

  // --- 2. a finance document is attached only to a record of its own branch
  const dDoc = await mkDoc('accA', DMM);
  await expectErr('create_supplier_invoice at JED with a DMM original → MRS_INVALID finance_document_id', () => R.inv('accA', { branch_id: JED, supplier_id: PP,
    invoice_number: 'RF-BR-1', invoice_date: today(), subtotal: 10, vat_amount: 1.5, finance_document_id: dDoc.id }), /MRS_INVALID finance_document_id/);
  const ed = await R.inv('accA', { branch_id: JED, supplier_id: PP, invoice_number: 'RF-BR-2', invoice_date: today(), subtotal: 10, vat_amount: 1.5 });
  await expectErr('update_supplier_invoice: a DMM original on a JED invoice → MRS_INVALID', () => R.updInv('accA', ed.id, { finance_document_id: dDoc.id }), /MRS_INVALID finance_document_id/);
  await expectErr('record_supplier_payment: DMM evidence on a JED invoice → MRS_INVALID evidence_document_id', async () => R.pay('accA',
    { supplier_invoice_id: IJ.id, amount: 1, method: 'cash', evidence_document_id: (await mkDoc('accA', DMM, 'payment_evidence')).id }), /MRS_INVALID evidence_document_id/);
  await expectErr('record_charge_collection: DMM evidence on a JED charge → MRS_INVALID evidence_document_id', async () => R.collect('accA',
    { charge_id: S.chService.id, amount: 0.01, method: 'cash', evidence_document_id: (await mkDoc('accA', DMM, 'collection_evidence')).id }), /MRS_INVALID evidence_document_id/);
  await expectErr('create_cost_adjustment: a DMM document on a JED transaction → MRS_INVALID finance_document_id', async () => R.adj('accA',
    { kind: 'washing', transaction_id: TX1, amount: 5, reason: 'غسيل', finance_document_id: (await mkDoc('accA', DMM, 'adjustment_evidence')).id }), /MRS_INVALID finance_document_id/);
  await check('the JED accountant reads the original (finance_documents row) of a JED invoice', async () => {
    const r = await as('accJ', `SELECT id FROM public.finance_documents WHERE id = $1`, [IJ.finance_document_id]);
    return r.length === 1 || 'rows ' + r.length;
  });

  // --- 3. supervisors are org-wide (audit_log shows every G4 row of the org)
  await expectErr('a branch-scoped supervisor membership is refused (memberships_supervisor_no_branch)', () => q(
    `INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, $3, 'supervisor')`, [U.opsA, A, JED]), /memberships_supervisor_no_branch/);
  await expectErr('a branch-scoped supervisor invitation is refused (invitations_supervisor_no_branch)', () => q(
    `INSERT INTO public.invitations (org_id, branch_id, email, role, token_hash, expires_at, invited_by)
     VALUES ($1, $2, 'sup.jed@example.com', 'supervisor', repeat('a', 64), now() + interval '1 day', $3)`, [A, JED, U.adminA]), /invitations_supervisor_no_branch/);

  // --- 4. allocation rows carry the transaction branch + can_approve (four eyes, approve role at THAT branch)
  const SPL = await mkInvoice('accA', { number: 'RF-SPLIT', supplier: PP, branch: JED, lines: portLine(1000) });
  await R.alloc('accA', SPL.lines[0].id, [{ transaction_id: TX1, amount: 600 }, { transaction_id: TX2, amount: 400 }]);
  await check('get_supplier_invoice allocations: transaction_branch_id + can_approve (bmJ: JED yes, DMM no)', async () => {
    const g = await R.getInv('bmJ', SPL.id), al = g.lines[0].allocations;
    const j = al.find(x => x.transaction_id === TX1), d = al.find(x => x.transaction_id === TX2);
    return (j.transaction_branch_id === JED && d.transaction_branch_id === DMM && j.can_approve === true && d.can_approve === false) || JSON.stringify(al);
  });
  await check('… and the creator never sees can_approve (four eyes)', async () => {
    const g = await R.getInv('accA', SPL.id);
    return g.lines[0].allocations.every(x => x.can_approve === false) || JSON.stringify(g.lines[0].allocations);
  });
  await check('cost_review_queue rows carry branch_id (allocations, accruals, adjustments) and can flags', async () => {
    const r = await rpc('bmJ', `SELECT public.cost_review_queue($1, '{}') r`, [A]);
    const a = r.allocations_proposed.filter(x => x.supplier_invoice_id === SPL.id);
    return (a.length === 1 && a[0].branch_id === JED && a[0].can_approve === true
            && r.accruals_variance.every(x => 'branch_id' in x && 'can_review' in x)
            && r.adjustments_proposed.every(x => 'branch_id' in x && 'can_review' in x)) || JSON.stringify(a);
  });

  // --- 5. demurrage / charge rows carry the transaction branch
  await check('list_demurrage items and list_client_charges carry branch_id', async () => {
    const d = await rpc('bmD', `SELECT public.list_demurrage($1, $2) r`, [A, { transaction_id: TX2 }]);
    const c = await rpc('bmD', `SELECT public.list_client_charges($1) r`, [TX2]);
    return (d.items.length > 0 && d.items.every(x => x.branch_id === DMM) && c.branch_id === DMM && c.items.every(x => x.branch_id === DMM)) || JSON.stringify({ d: d.items.map(x => x.branch_id), c: c.branch_id });
  });

  // --- 6. one charge per cost across the accrual ↔ allocation link and the trip
  const tr5 = await R.trip('opsA', { transaction_id: T5, carrier_id: PK, cost_amount: 800, cost_basis: 'agreed', sell_amount: 1200, sell_currency: 'SAR', leg_no: 1 });
  const acc5 = await accrualOfTrip(tr5.id);
  await R.charge('accA', { transaction_id: T5, kind: 'reimbursable', description: 'نقل مسترد', source: 'from_cost', accrual_id: acc5.id });
  const I6 = await mkInvoice('accA', { number: 'RF-TRIP-5', supplier: PK, branch: JED, lines: trLine(800) });
  const al6 = await R.alloc('accA', I6.lines[0].id, [{ transaction_id: T5, trip_id: tr5.id, amount: 800 }]);
  await R.approve('mgrA', [al6.allocations[0].id]);
  await expectErr('charge on the allocation of an accrual that is already charged → cost_charged', () => R.charge('accA',
    { transaction_id: T5, kind: 'reimbursable', description: 'x', source: 'from_cost', cost_allocation_id: al6.allocations[0].id }), /MRS_INVALID cost_charged/);
  await expectErr('from_trip on a leg already billed through its cost → trip_charged', () => R.charge('accA',
    { transaction_id: T5, kind: 'service', description: 'x', source: 'from_trip', trip_id: tr5.id }), /MRS_INVALID trip_charged/);
  const tr6 = await R.trip('opsA', { transaction_id: T6, carrier_id: PK, cost_amount: 500, cost_basis: 'agreed', sell_amount: 700, sell_currency: 'SAR', leg_no: 1 });
  await R.charge('accA', { transaction_id: T6, kind: 'service', description: 'نقل', source: 'from_trip', trip_id: tr6.id });
  await expectErr('a cost charge on a trip already billed from its sell price → trip_charged', async () => R.charge('accA',
    { transaction_id: T6, kind: 'service', description: 'x', source: 'markup', markup_pct: 10, accrual_id: (await accrualOfTrip(tr6.id)).id }), /MRS_INVALID trip_charged/);

  // --- 7./8./9. credit notes: no source links, capped by the original, reduce what is owed
  const I9 = await mkInvoice('accA', { number: 'RF-PAY-9', supplier: PP, branch: JED, lines: portLine(1000) });
  const al9 = await R.alloc('accA', I9.lines[0].id, [{ transaction_id: T5, amount: 1000 }]);
  await R.approve('mgrA', [al9.allocations[0].id]);
  await approveInv(I9);
  const cnDoc = await mkDoc('accA', JED, 'credit_note');
  const CN9 = await R.inv('accA', { branch_id: JED, supplier_id: PP, doc_type: 'credit_note', adjusts_invoice_id: I9.id, invoice_number: 'RF-CN-9',
    invoice_date: today(), subtotal: 200, vat_amount: 30, finance_document_id: cnDoc.id, lines: portLine(200) });
  await check('a credit note takes the currency of its original', async () => CN9.currency === 'SAR' || CN9.currency);
  await expectErr('credit note above what is left of the original → credit_exceeds_invoice (920.00)', () => R.inv('accA', { branch_id: JED, supplier_id: PP,
    doc_type: 'credit_note', adjusts_invoice_id: I9.id, invoice_number: 'RF-CN-BIG', invoice_date: today(), subtotal: 800.01, vat_amount: 120 }), /credit_exceeds_invoice 920\.00/);
  await expectErr('credit note in another currency than its original → MRS_INVALID currency', () => R.inv('accA', { branch_id: JED, supplier_id: PP,
    doc_type: 'credit_note', adjusts_invoice_id: I9.id, invoice_number: 'RF-CN-USD', invoice_date: today(), currency: 'USD', subtotal: 1, vat_amount: 0 }), /MRS_INVALID currency/);
  await expectErr('credit-note line on a transaction that never carried the original → credit_target', () => R.alloc('accA', CN9.lines[0].id,
    [{ transaction_id: T6, amount: 200 }]), /MRS_INVALID credit_target/);
  await expectErr('credit-note line linked to a trip → credit_note_link', () => R.alloc('accA', CN9.lines[0].id,
    [{ transaction_id: T5, trip_id: tr5.id, amount: 200 }]), /MRS_INVALID credit_note_link/);
  const alc = await R.alloc('accA', CN9.lines[0].id, [{ transaction_id: T5, amount: 200 }]);
  await R.approve('mgrA', [alc.allocations[0].id]);
  await approveInv(CN9);
  await check('approved credit note: payable 920 on the original, due_approved_unpaid follows', async () => {
    const g = await R.getInv('accA', I9.id);
    return (N(g.payable_amount) === 920 && N(g.invoice.payable_amount) === 920) || JSON.stringify({ p: g.payable_amount });
  });
  await expectErr('paying the gross original after the credit → MRS_OVERPAID 920.00', () => R.pay('accA',
    { supplier_invoice_id: I9.id, amount: 1150, method: 'bank_transfer', reference: 'X' }), /MRS_OVERPAID 920\.00/);
  const pev = await mkDoc('accA', JED, 'payment_evidence');
  const pay9 = await R.pay('accA', { supplier_invoice_id: I9.id, amount: 920, method: 'bank_transfer', evidence_document_id: pev.id });
  await check('paying the net 920 → paid', async () => pay9.invoice.payment_status === 'paid' || JSON.stringify(pay9.invoice));
  await check('tx cost = 1000 − 200 credit (T5 port charges)', async () => {
    const r = await q(`SELECT sum(amount)::numeric s FROM app.fin_cost_items($1, $2) WHERE supplier_id = $3`, [A, T5, PP]);
    return N(r[0].s) === 800 || JSON.stringify(r);
  });
  await expectErr('reversing the original allocation under the credit → credit_allocated', async () => {
    await R.invSt('mgrA', I9.id, 'disputed', 'مراجعة');
    return R.reverse('mgrA', al9.allocations[0].id, 'تصحيح');
  }, /credit_allocated/);

  // --- 22. payment evidence path
  await check('get_supplier_invoice / list_supplier_payments return evidence_path of the payment evidence', async () => {
    const g = await R.getInv('accA', I9.id), l = await rpc('accA', `SELECT public.list_supplier_payments($1, $2) r`, [A, { supplier_id: PP }]);
    const lp = l.items.find(x => x.id === pay9.id);
    return (g.payments[0].evidence_path === pev.storage_path && lp && lp.evidence_path === pev.storage_path) || JSON.stringify({ g: g.payments[0], lp });
  });

  // --- 10. a client's direct payment covers only its own transactions on a shared invoice
  const I10 = await mkInvoice('accA', { number: 'RF-SHARE', supplier: PP, branch: JED, lines: portLine(1000) });
  const al10 = await R.alloc('accA', I10.lines[0].id, [{ transaction_id: T7, share_pct: 60 }, { transaction_id: T6, share_pct: 40 }]);
  await R.approve('mgrA', al10.allocations.map(x => x.id));
  await R.pay('accA', { supplier_invoice_id: I10.id, amount: 690, method: 'bank_transfer', payer: 'client', client_id: CL101,
                        evidence_document_id: (await mkDoc('accA', JED, 'payment_evidence')).id });
  await check('shared invoice: client 101 paid its 60 % → T7 client_paid_direct 600, T6 (client 102) 0', async () => {
    const m7 = curOf(await R.margin('accA', T7)), m6 = curOf(await R.margin('accA', T6));
    return (N(m7.client_paid_direct) === 600 && N(m6.client_paid_direct) === 0 && N(m6.cost_estimated) >= 400) || JSON.stringify({ m7, m6 });
  });
  await check('client 102 can still be charged its own share (no paid_by_client)', async () => {
    const c = await R.charge('accA', { transaction_id: T6, kind: 'reimbursable', description: 'رسوم', source: 'from_cost', cost_allocation_id: al10.allocations[1].id });
    return c.status === 'draft' || JSON.stringify(c);
  });

  // --- 11. a draft reimbursable charge keeps the cost in the margin
  const I11 = await mkInvoice('accA', { number: 'RF-PT-11', supplier: PP, branch: JED, lines: portLine(1000) });
  const al11 = await R.alloc('accA', I11.lines[0].id, [{ transaction_id: T8, amount: 1000 }]);
  await R.approve('mgrA', [al11.allocations[0].id]);
  const ch11 = await R.charge('accA', { transaction_id: T8, kind: 'reimbursable', description: 'رسوم', source: 'from_cost', cost_allocation_id: al11.allocations[0].id });
  await check('draft reimbursable charge: cost stays (estimated 1000), pass-through 0', async () => {
    const m = curOf(await R.margin('accA', T8));
    return (N(m.cost_estimated) === 1000 && N(m.pass_through_cost) === 0) || JSON.stringify(m);
  });
  await R.chargeSt('mgrA', ch11.id, 'approved');
  await check('approved: the cost becomes pass-through (1000)', async () => {
    const m = curOf(await R.margin('accA', T8));
    return (N(m.cost_estimated) === 0 && N(m.pass_through_cost) === 1000) || JSON.stringify(m);
  });
  await expectErr('reversing an allocation that carries a charge → charged_to_client', () => R.reverse('mgrA', al11.allocations[0].id, 'x'), /charged_to_client/);

  // --- 12. a charge whose cost source is gone is flagged
  const tr8 = await R.trip('opsA', { transaction_id: T8, carrier_id: PK, cost_amount: 800, cost_basis: 'agreed', leg_no: 1 });
  const acc8 = await accrualOfTrip(tr8.id);
  const ch8 = await R.charge('accA', { transaction_id: T8, kind: 'service', description: 'نقل', source: 'markup', markup_pct: 15, accrual_id: acc8.id });
  await R.chargeSt('mgrA', ch8.id, 'approved');
  await expectErr('void_accrual while a charge references it → charged_to_client', () => rpc('accA', `SELECT public.void_accrual($1, 'x') r`, [acc8.id]), /charged_to_client/);
  await R.tripSt('opsA', tr8.id, 'cancelled', 'أُلغيت الرحلة');
  await check('cancelled trip: the approved charge is pending charge_source_gone, level not confirmed', async () => {
    const m = await R.margin('accA', T8);
    return (m.pending.some(x => x.type === 'charge_source_gone' && x.id === ch8.id) && m.level !== 'confirmed') || JSON.stringify(m.pending);
  });

  // --- 13. no sourced charge of any kind on a cost the client paid directly; no client payment over a sourced charge
  await expectErr('markup SERVICE charge on a client-paid cost → paid_by_client', () => R.charge('bmD',
    { transaction_id: TX2, kind: 'service', description: 'أرضيات', source: 'markup', markup_pct: 10, cost_allocation_id: S.s1Alloc }), /MRS_INVALID paid_by_client/);
  const I13 = await mkInvoice('accA', { number: 'RF-PAY-13', supplier: PP, branch: JED, lines: portLine(300) });
  const al13 = await R.alloc('accA', I13.lines[0].id, [{ transaction_id: T7, amount: 300 }]);
  await R.charge('accA', { transaction_id: T7, kind: 'service', description: 'رسوم', source: 'from_cost', cost_allocation_id: al13.allocations[0].id });
  await expectErr('client-direct payment over a from_cost SERVICE charge → charged_to_client', async () => R.pay('accA',
    { supplier_invoice_id: I13.id, amount: 345, method: 'cash', payer: 'client', client_id: CL101, evidence_document_id: (await mkDoc('accA', JED, 'payment_evidence')).id }),
    /charged_to_client/);

  // --- 14. demurrage: every figure in the case currency
  const dcS = await R.dcase('accA', { transaction_id: TX2, kind: 'storage', operator_id: PT });
  const IU = await mkInvoice('accA', { number: 'RF-USD', supplier: PT, branch: DMM, extra: { currency: 'USD' },
    lines: [{ description: 'storage', quantity: 1, unit_price: 100, net_amount: 100, vat_rate: 15, service_code: 'storage' }] });
  await expectErr('USD invoice line on a SAR case with no estimate → MRS_INVALID currency', () => R.alloc('accA', IU.lines[0].id,
    [{ transaction_id: TX2, demurrage_case_id: dcS.id, amount: 100 }]), /MRS_INVALID currency/);
  await expectErr('EUR charge on a SAR case → MRS_INVALID currency', () => R.charge('accA',
    { transaction_id: TX2, kind: 'service', description: 'x', unit_price: 300, currency: 'EUR', demurrage_case_id: dcS.id }), /MRS_INVALID currency/);
  const IS = await mkInvoice('accA', { number: 'RF-SAR-CASE', supplier: PT, branch: DMM,
    lines: [{ description: 'أرضيات', quantity: 1, unit_price: 100, net_amount: 100, vat_rate: 15, service_code: 'storage' }] });
  await R.alloc('accA', IS.lines[0].id, [{ transaction_id: TX2, demurrage_case_id: dcS.id, amount: 100 }]);
  await expectErr('case currency change while an allocation is linked → currency_in_use', () => rpc('accA',
    `SELECT public.update_demurrage_case($1, $2) r`, [dcS.id, { currency: 'USD' }]), /currency_in_use/);

  // --- 15. an allocation without a trip link matches the one open accrual of the same supplier
  const tr10 = await R.trip('opsA', { transaction_id: T10, carrier_id: PK, cost_amount: 800, cost_basis: 'agreed', leg_no: 1 });
  const I15 = await mkInvoice('accA', { number: 'RF-AUTO', supplier: PK, branch: JED, lines: trLine(800) });
  await check('transaction-only allocation is auto-matched to the single open same-supplier accrual', async () => {
    const r = await R.alloc('accA', I15.lines[0].id, [{ transaction_id: T10, amount: 800 }]);
    const acc = await accrualOfTrip(tr10.id);
    return (r.allocations[0].accrual_id === acc.id && r.allocations[0].trip_id === tr10.id && r.allocations[0].auto_accrual === true) || JSON.stringify(r.allocations[0]);
  });
  await R.trip('opsA', { transaction_id: T9, carrier_id: PK, cost_amount: 800, cost_basis: 'agreed', leg_no: 1 });
  await R.trip('opsA', { transaction_id: T9, carrier_id: PK, cost_amount: 500, cost_basis: 'agreed', leg_no: 2 });
  const I15b = await mkInvoice('accA', { number: 'RF-AUTO-2', supplier: PK, branch: JED, lines: trLine(800) });
  await expectErr('two open candidates → MRS_REQUIRED accrual_id (the user picks)', () => R.alloc('accA', I15b.lines[0].id, [{ transaction_id: T9, amount: 800 }]), /MRS_REQUIRED accrual_id/);
  await check('… or states no_accrual: true', async () => {
    const r = await R.alloc('accA', I15b.lines[0].id, [{ transaction_id: T9, amount: 800, no_accrual: true }]);
    return r.allocations[0].accrual_id === null || JSON.stringify(r.allocations[0]);
  });

  // --- 16. invoice-number normalization keeps digit-run boundaries, folds Arabic variants
  await check('fin_norm_no: A-1-23 ≠ A-12-3; 2026/1/05 → 2026-1-5; فاتورة 12 = فاتوره 12; أ12 = ا12; INV-0001 = inv 1', async () => {
    const r = await one(`SELECT app.fin_norm_no('A-1-23') a, app.fin_norm_no('A-12-3') b, app.fin_norm_no('2026/1/05') c,
                                app.fin_norm_no('فاتورة 12') d, app.fin_norm_no('فاتوره 12') e, app.fin_norm_no('أ12') f, app.fin_norm_no('ا12') g,
                                app.fin_norm_no('INV-0001') h, app.fin_norm_no('inv 1') i, app.fin_norm_no('فـاتُورة ١٢') j`);
    return (r.a === 'A1-23' && r.b === 'A12-3' && r.c === '2026-1-5' && r.d === r.e && r.d === 'فاتوره12' && r.f === r.g
            && r.h === 'INV1' && r.i === 'INV1' && r.j === r.d) || JSON.stringify(r);
  });
  const N1 = await R.inv('accA', { branch_id: JED, supplier_id: PP, invoice_number: 'A-1-23', invoice_date: today(), subtotal: 10, vat_amount: 1.5 });
  await check('A-12-3 is a different invoice (accepted), reported as a similar number', async () => {
    const r = await R.inv('accA', { branch_id: JED, supplier_id: PP, invoice_number: 'A-12-3', invoice_date: today(), subtotal: 20, vat_amount: 3 });
    return (r.possible_duplicates || []).some(x => x.id === N1.id && x.reasons.includes('similar_number')) || JSON.stringify(r.possible_duplicates);
  });

  // --- 17. a currency change of the trip after the proposal is refused at approval
  const tr11 = await R.trip('opsA', { transaction_id: T11, carrier_id: PK, cost_amount: 800, cost_basis: 'agreed', leg_no: 1 });
  const I17 = await mkInvoice('accA', { number: 'RF-CUR', supplier: PK, branch: JED, lines: trLine(800) });
  const al17 = await R.alloc('accA', I17.lines[0].id, [{ transaction_id: T11, trip_id: tr11.id, amount: 800 }]);
  await R.updTrip('opsA', tr11.id, { cost_currency: 'USD' });
  await expectErr('approve_allocations: accrual now USD vs SAR invoice → MRS_INVALID currency', () => R.approve('mgrA', [al17.allocations[0].id]), /MRS_INVALID currency/);

  // --- 23. the caller's own unattached registration of a file is handed back, not blocked
  const sha = newSha();
  const d1 = await R.doc('accA', { branch_id: JED, kind: 'supplier_invoice', original_name: 'o.pdf', mime_type: 'application/pdf', size_bytes: 10, sha256: sha });
  const failCreate = await tryErr(() => R.inv('accA', { branch_id: JED, supplier_id: PP, invoice_number: 'RF-PAY-9', invoice_date: today(), subtotal: 1, finance_document_id: d1.id }));
  await check('after a failed create, registering the same file again returns the same document (reused)', async () => {
    const d2 = await R.doc('accA', { branch_id: JED, kind: 'supplier_invoice', original_name: 'o.pdf', mime_type: 'application/pdf', size_bytes: 10, sha256: sha });
    return (/invoice_number_taken/.test(failCreate) && d2.id === d1.id && d2.reused === true) || JSON.stringify({ failCreate, d2 });
  });
  await expectErr('another user registering that file → file_duplicate', () => R.doc('accJ',
    { branch_id: JED, kind: 'supplier_invoice', original_name: 'o.pdf', size_bytes: 10, sha256: sha }), /file_duplicate/);
}

/* ------------------------------------------------------------------ migration safety (separate databases) */
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
  section('migration: applies on a G2 + G3 database with data, twice; preflight');
  const saved = db;
  const g4 = fs.readFileSync(path.join(SUPA, 'migrations', MIG_G4), 'utf8');
  db = new PGlite();
  try {
    await loadUpTo(db, MIG_G4);
    await db.exec(`
      INSERT INTO public.parties (id, org_id, kinds, name_ar) VALUES ('${PK}', '${A}', ARRAY['carrier'], 'ناقل قديم');
      INSERT INTO public.transport_trips (org_id, transaction_id, container_id, leg_no, carrier_id, status, cost_amount, cost_basis) VALUES
        ('${A}', '${TX1}', '${C301}', 1, '${PK}', 'delivered', 700, 'agreed'),
        ('${A}', '${TX1}', '${C302}', 1, '${PK}', 'planned', NULL, NULL),
        ('${A}', '${TX2}', '${C303}', 1, NULL, 'planned', 300, 'estimated');
      INSERT INTO public.transport_trips (org_id, transaction_id, leg_no, status, status_reason, cost_amount) VALUES
        ('${A}', '${TX2}', 2, 'cancelled', 'أُلغيت', 900);`);
    const ev0 = await count(`SELECT count(*)::int n FROM public.transaction_events`);
    await check('G4 applies on a live-like G3 database (trips with and without cost, a cancelled one)', async () => { await db.exec(g4); return true; });
    await check('backfill: one accrual per non-cancelled trip (3 of 4), amounts / basis / unknown kept, no events', async () => {
      const r = await q(`SELECT a.amount, a.basis, a.status, t.status ts FROM public.cost_accruals a JOIN public.transport_trips t ON t.id = a.trip_id ORDER BY a.amount NULLS FIRST`);
      const ev1 = await count(`SELECT count(*)::int n FROM public.transaction_events`);
      return (r.length === 3 && r[0].amount === null && N(r[1].amount) === 300 && r[1].basis === 'estimated' && N(r[2].amount) === 700
              && r[2].basis === 'agreed' && r.every(x => x.status === 'open' && x.ts !== 'cancelled') && ev1 === ev0) || JSON.stringify({ r, ev0, ev1 });
    });
    const counts = async () => {
      const o = {};
      for (const t of G4_TABLES.concat(['status_labels', 'transaction_events', 'audit_log', 'schema_versions'])) o[t] = await count(`SELECT count(*)::int n FROM public.${t}`);
      o.policies = await count(`SELECT count(*)::int n FROM pg_policies`);
      o.triggers = await count(`SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal`);
      return o;
    };
    const c1 = await counts();
    await check('backfilled accruals have their INSERT row in audit_log (trigger attached before the backfill)', async () => {
      const r = await one(`SELECT (SELECT count(*)::int FROM public.cost_accruals) a,
                                  (SELECT count(*)::int FROM public.audit_log WHERE table_name = 'cost_accruals' AND action = 'INSERT') l`);
      return (r.a === 3 && r.l === 3) || JSON.stringify(r);
    });
    await check('re-run: the file applies again and changes no count (rows, policies, triggers)', async () => {
      await db.exec(g4);
      const c2 = await counts();
      return JSON.stringify(c1) === JSON.stringify(c2) || JSON.stringify({ c1, c2 });
    });
    await check('after re-run a trip still keeps exactly one live accrual', async () => {
      await db.exec(`UPDATE public.transport_trips SET cost_amount = 750 WHERE cost_amount = 700`);
      const r = await q(`SELECT a.amount FROM public.cost_accruals a JOIN public.transport_trips t ON t.id = a.trip_id WHERE t.cost_amount = 750`);
      return (r.length === 1 && N(r[0].amount) === 750) || JSON.stringify(r);
    });
  } catch (e) { fail('migration safety (live-like)', errText(e)); }
  finally { try { await db.close(); } catch (e) { /* ignore */ } }

  db = new PGlite();
  try {
    await loadUpTo(db, MIG_G4);
    await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261103000200'`);
    await check('preflight: without G3 B the file stops with "G4 preflight: apply G3 first" and applies nothing', async () => {
      let err = '';
      try { await db.exec(g4); } catch (e) { err = errText(e); }
      const left = await one(`SELECT to_regclass('public.supplier_invoices') IS NULL AS none,
                                     NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261104000100') AS nover`);
      return (/G4 preflight: apply G3 first/.test(err) && left.none && left.nover) || JSON.stringify({ err, left });
    });
  } catch (e) { fail('migration safety (preflight)', errText(e)); }
  finally { try { await db.close(); } catch (e) { /* ignore */ } db = saved; }
}

/* ------------------------------------------------------------------ runner */
const SECTIONS = [
  ['catalog', secCatalog],
  ['roles', secRoles],
  ['parties', secParties],
  ['files', secFiles],
  ['invoices', secInvoices],
  ['lines', secLines],
  ['allocations', secAllocations],
  ['accruals', secAccruals],
  ['payments', secPayments],
  ['charges', secCharges],
  ['collections', secCollections],
  ['demurrage', secDemurrage],
  ['adjustments', secAdjustments],
  ['reports', secReports],
  ['isolation', secIsolation],
  ['idempotency', secIdempotency],
  ['review_fixes', secReviewFixes],
  ['migration_safety', secMigrationSafety]
];

async function main() {
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return finish();
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return finish();
  try { await fixtures(); pass('fixtures: two orgs, finance roles by branch, parties, TX4 under billing'); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }
  for (const [label, fn] of SECTIONS) {
    try { await fn(); }
    catch (e) { fail('section ' + label + ' aborted', errText(e)); }
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
