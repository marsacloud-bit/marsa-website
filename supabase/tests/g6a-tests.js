#!/usr/bin/env node
/*
  Marsa (مرسى) — G6a portal / dashboards / search / reports / export-log test suite (docs/online/G6A_SPEC.md).
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql → G3/G4/G5 fixtures
  (inserted as superuser). Every reader is called as the API role 'authenticated' with request.jwt.claims.

  Org A = seed "blue-sea" (branches JED = A1, DMM = A2). Org B = "org-b".
  Users (org A):
    adminA admin            supA supervisor (all)      opsA operations_manager (all)   bmJ branch_manager JED
    accA accountant (all)   mgrA accounts_manager      accJ accountant JED              clrJ clearance_staff JED
    trJ transport_staff JED clrD clearance_staff DMM    mix accountant JED + clearance_staff DMM
    cA1 client 101 (A-c1)   cA2 client 102 (A-c2)
  Org B: adminB admin, cB1 client B-c1.
  Transactions: TX1 (seed, JED, 101), TX2 (seed, DMM, 102), TX3 (seed, JED, 103), TX4 (JED, 101), TX5 (DMM, 101), B_TX (org B).
  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g6a-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_G6A = '20261106000100_g6a_portal_reports.sql';

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
const TX4 = '0b5e0000-0000-4000-8000-0000000002a4';
const TX5 = '0b5e0000-0000-4000-8000-0000000002a5';
const B = 'bbbb0000-0000-4000-8000-000000000001';
const B_BR = 'bbbb0000-0000-4000-8000-000000000011';
const B_CL = 'bbbb0000-0000-4000-8000-000000000101';
const B_TX = 'bbbb0000-0000-4000-8000-000000000201';
const id6 = n => `06a60000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const P_CAR = id6(1), P_AGENT = id6(2), P_YARD = id6(3), P_SUP = id6(4), BL1 = id6(5), BL2 = id6(6);
const D_VIS = id6(10), D_INT = id6(11), D_VOID = id6(12), D_A2 = id6(13), D_EVID = id6(14);
const C4A = id6(20), C4B = id6(21), C5 = id6(22), CB = id6(23);
const TR1 = id6(30), TR2 = id6(31), TR3 = id6(32);
const I1 = id6(40), I2 = id6(41), I3 = id6(42), I4 = id6(43), I5 = id6(44), I6 = id6(45), I7 = id6(46);
const SI1 = id6(50), SI2 = id6(51), SI3 = id6(52);
const DRV = id6(60), TRK = id6(61);

const U = {
  adminA: 'a6a60000-0000-4000-8000-000000000001', supA: 'a6a60000-0000-4000-8000-000000000002',
  opsA: 'a6a60000-0000-4000-8000-000000000003', bmJ: 'a6a60000-0000-4000-8000-000000000004',
  accA: 'a6a60000-0000-4000-8000-000000000005', mgrA: 'a6a60000-0000-4000-8000-000000000006',
  accJ: 'a6a60000-0000-4000-8000-000000000007', clrJ: 'a6a60000-0000-4000-8000-000000000008',
  trJ: 'a6a60000-0000-4000-8000-000000000009', clrD: 'a6a60000-0000-4000-8000-00000000000a',
  mix: 'a6a60000-0000-4000-8000-00000000000b', cA1: 'a6a60000-0000-4000-8000-00000000000c',
  cA2: 'a6a60000-0000-4000-8000-00000000000d', adminB: 'a6a60000-0000-4000-8000-00000000000e',
  cB1: 'a6a60000-0000-4000-8000-00000000000f'
};
const STAFF = ['adminA', 'supA', 'opsA', 'bmJ', 'accA', 'mgrA', 'accJ', 'clrJ', 'trJ', 'clrD', 'mix'];
const CLIENTS = ['cA1', 'cA2', 'cB1'];
const RPCS = ['search_records', 'report_transactions', 'report_containers', 'report_trips', 'dash_ops', 'dash_finance',
  'dash_management', 'portal_invoices', 'log_report_export', 'list_report_exports'];
const ORG_RPCS = RPCS.filter(n => n !== 'portal_invoices' && n !== 'log_report_export');
const G4G5_TABLES = ['supplier_invoices', 'supplier_invoice_lines', 'cost_accruals', 'cost_adjustments', 'cost_allocations',
  'supplier_payments', 'client_charges', 'charge_collections', 'demurrage_cases', 'finance_documents', 'billing_intents',
  'billing_intent_lines', 'billing_sync_jobs', 'billing_sync_attempts', 'billing_review_items', 'daftra_connections',
  'daftra_client_links', 'daftra_item_links', 'daftra_mock_accounts', 'report_exports'];
const MONEY_RE = /amount|total|cost|sell|price|paid|money|vat|net|margin|outstanding|payable/i;

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
    if (typeof r === 'string') fail(name, r);
    else if (r === false || r === null || r === 0 || r === undefined) fail(name, 'assertion false');
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
  try { await dbx.exec(sql); if (!QUIET) console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}
const ids = r => (r.items || []).map(x => x.id).sort();
const same = (a, b) => JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort());
const N = x => (x === null || x === undefined) ? x : Number(x);
const cents = x => Math.round(Number(x || 0) * 100);
const sortKeys = o => (o && typeof o === 'object' && !Array.isArray(o))
  ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])])) : o;
function keysDeep(o, acc) {
  acc = acc || [];
  if (o && typeof o === 'object') {
    if (Array.isArray(o)) o.forEach(v => keysDeep(v, acc));
    else Object.keys(o).forEach(k => { acc.push(k); keysDeep(o[k], acc); });
  }
  return acc;
}

/* ------------------------------------------------------------------ RPC wrappers */
const R = {
  search: (who, f, org) => rpc(who, `SELECT public.search_records($1, $2) r`, [org || A, f || {}]),
  rtx: (who, f, org) => rpc(who, `SELECT public.report_transactions($1, $2) r`, [org || A, f || {}]),
  rcont: (who, f, org) => rpc(who, `SELECT public.report_containers($1, $2) r`, [org || A, f || {}]),
  rtrip: (who, f, org) => rpc(who, `SELECT public.report_trips($1, $2) r`, [org || A, f || {}]),
  dops: (who, f, org) => rpc(who, `SELECT public.dash_ops($1, $2) r`, [org || A, f || {}]),
  dfin: (who, f, org) => rpc(who, `SELECT public.dash_finance($1, $2) r`, [org || A, f || {}]),
  dmgmt: (who, f, org) => rpc(who, `SELECT public.dash_management($1, $2) r`, [org || A, f || {}]),
  inv: (who, tx) => rpc(who, `SELECT public.portal_invoices($1) r`, [tx || null]),
  log: (who, p, org) => rpc(who, `SELECT public.log_report_export($1, $2) r`, [org || A, p]),
  logs: (who, f, org) => rpc(who, `SELECT public.list_report_exports($1, $2) r`, [org || A, f || {}])
};
const CALL = {
  search_records: (who, org) => R.search(who, {}, org), report_transactions: (who, org) => R.rtx(who, {}, org),
  report_containers: (who, org) => R.rcont(who, {}, org), report_trips: (who, org) => R.rtrip(who, {}, org),
  dash_ops: (who, org) => R.dops(who, {}, org), dash_finance: (who, org) => R.dfin(who, {}, org),
  dash_management: (who, org) => R.dmgmt(who, {}, org), list_report_exports: (who, org) => R.logs(who, {}, org),
  log_report_export: (who, org) => R.log(who, { report: 'transactions', format: 'csv', filters: {}, row_count: 1 }, org)
};

const S = {};

/* ------------------------------------------------------------------ fixtures (superuser) */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g6a.example.com', now())`).join(', ');
  const sha = n => n.toString(16).padStart(64, 'a');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.profiles (id, full_name) SELECT u.id, split_part(u.email, '@', 1) FROM auth.users u
      WHERE u.email LIKE '%@g6a.example.com' ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
    INSERT INTO public.organizations (id, slug, name_ar) VALUES ('${B}', 'org-b', 'مؤسسة ب التجريبية');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع الرياض ب');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone, vat_number) VALUES ('${B_CL}', '${B}', 'business', 'عميل ب', '0509999999', '300000000000099');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ('${B_TX}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, port_of_loading) VALUES
      ('${TX4}', '${A}', '${JED}', '${CL101}', 'import', 'sea', 'شنغهاي'),
      ('${TX5}', '${A}', '${DMM}', '${CL101}', 'import', 'sea', NULL);
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'), ('${U.supA}', '${A}', NULL, 'supervisor'),
      ('${U.opsA}', '${A}', NULL, 'operations_manager'), ('${U.bmJ}', '${A}', '${JED}', 'branch_manager'),
      ('${U.accA}', '${A}', NULL, 'accountant'), ('${U.mgrA}', '${A}', NULL, 'accounts_manager'),
      ('${U.accJ}', '${A}', '${JED}', 'accountant'), ('${U.clrJ}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.trJ}', '${A}', '${JED}', 'transport_staff'), ('${U.clrD}', '${A}', '${DMM}', 'clearance_staff'),
      ('${U.mix}', '${A}', '${JED}', 'accountant'), ('${U.mix}', '${A}', '${DMM}', 'clearance_staff'),
      ('${U.cA1}', '${A}', NULL, 'client'), ('${U.cA2}', '${A}', NULL, 'client'),
      ('${U.adminB}', '${B}', NULL, 'admin'), ('${U.cB1}', '${B}', NULL, 'client');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES
      ('${A}', '${CL101}', '${U.cA1}', 'owner'), ('${A}', '${CL102}', '${U.cA2}', 'owner'), ('${B}', '${B_CL}', '${U.cB1}', 'owner');
    -- parties / fleet
    INSERT INTO public.parties (id, org_id, kinds, name_ar, name_en) VALUES
      ('${P_CAR}', '${A}', ARRAY['carrier'], 'ناقل الشمال', 'North Haulage'),
      ('${P_AGENT}', '${A}', ARRAY['shipping_agent'], 'وكيل ملاحي تجريبي', 'Test Agency'),
      ('${P_YARD}', '${A}', ARRAY['yard'], 'ساحة الإرجاع', 'Return Yard'),
      ('${P_SUP}', '${A}', ARRAY['supplier'], 'مورد تجريبي', 'Test Supplier');
    INSERT INTO public.drivers (id, org_id, carrier_id, full_name) VALUES ('${DRV}', '${A}', '${P_CAR}', 'سائق تجريبي');
    INSERT INTO public.trucks (id, org_id, carrier_id, plate_no) VALUES ('${TRK}', '${A}', '${P_CAR}', 'ABC1234');
    -- B/Ls: BL1 primary on TX4 (agent + carrier name + port), BL2 non-primary on TX5 (mirror leaves TX5.bl_number empty)
    INSERT INTO public.bills_of_lading (id, org_id, bl_number, shipping_agent_id, carrier_name, port_of_loading, port_of_discharge) VALUES
      ('${BL1}', '${A}', 'BLX777', '${P_AGENT}', 'MAERSK LINE', 'NINGBO', 'JEDDAH'),
      ('${BL2}', '${A}', 'BLY888', NULL, NULL, NULL, NULL);
    INSERT INTO public.transaction_bls (transaction_id, bl_id, org_id, is_primary) VALUES
      ('${TX4}', '${BL1}', '${A}', true), ('${TX5}', '${BL2}', '${A}', false);
    -- declarations: an active one on TX4, a CANCELLED one on TX2
    INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no, declaration_date, status) VALUES
      ('${A}', '${TX4}', 'DEC4001', '2026-10-15', 'submitted');
    INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no, declaration_date, status, cancelled_at, cancel_reason) VALUES
      ('${A}', '${TX2}', 'DEC2CANCEL', '2026-10-16', 'cancelled', now(), 'خطأ');
    -- containers (Riyadh dates)
    INSERT INTO public.containers (id, org_id, transaction_id, container_no, container_type, return_deadline, return_yard_party_id) VALUES
      ('${C4A}', '${A}', '${TX4}', 'MSCU1234567', '40ft', app.rpt_today() - 2, '${P_YARD}'),
      ('${C4B}', '${A}', '${TX4}', 'ABCD7654321', '20ft', app.rpt_today() + 2, NULL),
      ('${C5}', '${A}', '${TX5}', 'DMMU0000005', '20ft', app.rpt_today() + 20, NULL),
      ('${CB}', '${B}', '${B_TX}', 'BBBB1111111', '20ft', app.rpt_today() - 1, NULL);
    -- trips: JED (TX4) 2 legs with finance, DMM (TX5) 1 leg
    INSERT INTO public.transport_trips (id, org_id, transaction_id, container_id, leg_no, carrier_id, driver_id, truck_id, origin, destination,
                                        planned_at, status, cost_amount, cost_currency, sell_amount, sell_currency) VALUES
      ('${TR1}', '${A}', '${TX4}', '${C4A}', 1, '${P_CAR}', '${DRV}', '${TRK}', 'ميناء جدة', 'مستودع العميل', now() + interval '1 day', 'planned', 500.25, 'SAR', 800, 'SAR'),
      ('${TR2}', '${A}', '${TX4}', '${C4B}', 1, NULL, NULL, NULL, 'ميناء جدة', 'مستودع', now() - interval '1 day', 'planned', 300, 'USD', NULL, 'SAR'),
      ('${TR3}', '${A}', '${TX5}', '${C5}', 1, '${P_CAR}', NULL, NULL, 'ميناء الدمام', 'الرياض', now() - interval '3 days', 'delivered', 200, 'SAR', 350.5, 'SAR');
    -- appointments
    INSERT INTO public.port_appointments (org_id, transaction_id, container_id, appointment_at, status) VALUES
      ('${A}', '${TX4}', '${C4A}', now() + interval '2 hours', 'requested'),
      ('${A}', '${TX1}', NULL, now() + interval '3 days', 'confirmed'),
      ('${A}', '${TX5}', '${C5}', now() + interval '1 day', 'confirmed');
    -- alerts / exceptions
    INSERT INTO public.operational_alerts (org_id, branch_id, transaction_id, kind, severity, title_ar, dedupe_key, status) VALUES
      ('${A}', '${JED}', '${TX4}', 'empty_return_overdue', 'critical', 'حاوية متأخرة', 'g6a:1', 'open'),
      ('${A}', '${DMM}', '${TX5}', 'appointment_soon', 'warning', 'موعد قريب', 'g6a:2', 'acknowledged'),
      ('${A}', '${JED}', '${TX1}', 'docs_missing', 'info', 'مستندات ناقصة', 'g6a:3', 'open');
    INSERT INTO public.operational_exceptions (org_id, transaction_id, kind, reason, status) VALUES
      ('${A}', '${TX4}', 'other', 'سبب تجريبي', 'open'), ('${A}', '${TX5}', 'inspection', 'معاينة', 'in_progress');
    -- documents (TX1 of client 101): client-visible, internal, voided client; TX2 (client 102) client-visible
    INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, visibility, uploaded_by) VALUES
      ('${D_VIS}', '${A}', '${TX1}', 'other', '${A}/${TX1}/${D_VIS}/vis.pdf', '${sha(1)}', 'vis.pdf', 10, 'client', '${U.clrJ}'),
      ('${D_INT}', '${A}', '${TX1}', 'other', '${A}/${TX1}/${D_INT}/int.pdf', '${sha(2)}', 'int.pdf', 10, 'internal', '${U.clrJ}'),
      ('${D_A2}', '${A}', '${TX2}', 'other', '${A}/${TX2}/${D_A2}/a2.pdf', '${sha(4)}', 'a2.pdf', 10, 'client', '${U.clrD}');
    INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, visibility, uploaded_by,
                                  voided_at, voided_by, void_reason) VALUES
      ('${D_VOID}', '${A}', '${TX1}', 'other', '${A}/${TX1}/${D_VOID}/void.pdf', '${sha(3)}', 'void.pdf', 10, 'client', '${U.clrJ}', now(), '${U.clrJ}', 'خطأ');
    INSERT INTO storage.objects (bucket_id, name) VALUES
      ('documents', '${A}/${TX1}/${D_VIS}/vis.pdf'), ('documents', '${A}/${TX1}/${D_INT}/int.pdf'),
      ('documents', '${A}/${TX1}/${D_VOID}/void.pdf'), ('documents', '${A}/${TX2}/${D_A2}/a2.pdf');
    -- G4 supplier invoices: SI1 JED approved unpaid overdue, SI2 DMM approved partial due in 3 days, SI3 JED received
    INSERT INTO public.supplier_invoices (id, org_id, branch_id, supplier_id, invoice_number, number_norm, invoice_date, due_date, currency,
                                          subtotal, vat_amount, total_amount, status, company_paid_amount, payment_status) VALUES
      ('${SI1}', '${A}', '${JED}', '${P_SUP}', 'SUP-1', 'SUP1', app.rpt_today() - 20, app.rpt_today() - 5, 'SAR', 1000, 150, 1150, 'approved', 0, 'unpaid'),
      ('${SI2}', '${A}', '${DMM}', '${P_SUP}', 'SUP-2', 'SUP2', app.rpt_today() - 3, app.rpt_today() + 3, 'SAR', 500, 0, 500, 'approved', 100, 'partial'),
      ('${SI3}', '${A}', '${JED}', '${P_SUP}', 'SUP-3', 'SUP3', app.rpt_today() - 1, NULL, 'USD', 80, 0, 80, 'received', 0, 'unpaid');
    -- G5 billing intents (superuser): issued / draft / open / cancelled
    INSERT INTO public.billing_intents (id, org_id, transaction_id, client_id, purpose, purpose_key, currency, operational_ref, status,
                                        daftra_number, issued_at, remote_net, remote_vat, remote_total, payment_status, paid_amount,
                                        lines_total, last_synced_at, sync_state, cancelled_at, cancel_reason) VALUES
      ('${I1}', '${A}', '${TX1}', '${CL101}', 'final', 'F', 'SAR', 'G6A-I1', 'issued', 'INV-1001', now() - interval '2 days', 1000, 150, 1150, 'partial', 500, 1150, now() - interval '1 hour', 'synced', NULL, NULL),
      ('${I2}', '${A}', '${TX4}', '${CL101}', 'final', 'F', 'USD', 'G6A-I2', 'issued', 'INV-1002', now() - interval '1 day', 100, 0, 100, 'paid', 100, 100, now() - interval '2 hours', 'synced', NULL, NULL),
      ('${I3}', '${A}', '${TX1}', '${CL101}', 'interim', 'I1', 'SAR', 'G6A-I3', 'draft', NULL, NULL, NULL, NULL, 5000, 'unknown', NULL, 999, NULL, 'pending', NULL, NULL),
      ('${I4}', '${A}', '${TX2}', '${CL102}', 'final', 'F', 'SAR', 'G6A-I4', 'open', NULL, NULL, NULL, NULL, 4000, 'unknown', NULL, 50, NULL, 'idle', NULL, NULL),
      ('${I5}', '${A}', '${TX2}', '${CL102}', 'interim', 'I1', 'SAR', 'G6A-I5', 'issued', 'INV-2001', now() - interval '3 days', 200, 30, 230, 'unpaid', 0, 230, now(), 'synced', NULL, NULL),
      ('${I6}', '${B}', '${B_TX}', '${B_CL}', 'final', 'F', 'SAR', 'G6A-I6', 'issued', 'INV-B1', now(), 10, 0, 10, 'unpaid', 0, 10, now(), 'synced', NULL, NULL),
      ('${I7}', '${A}', '${TX1}', '${CL101}', 'final', 'F', 'EUR', 'G6A-I7', 'cancelled', NULL, NULL, NULL, NULL, 777, 'unknown', NULL, 777, NULL, 'idle', now(), 'ملغى');
    INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, kind, status) VALUES ('${A}', '${TX4}', '${I2}', 'issued_cancelled', 'open');
    -- dates for search / management: TX5 created 2026-03-10 21:30Z (= 2026-03-11 Riyadh), status changed 2026-03-11 21:00Z (= 03-12 Riyadh)
    UPDATE public.transactions SET created_at = '2026-03-10 21:30:00+00', status_changed_at = '2026-03-11 21:00:00+00' WHERE id = '${TX5}';
    UPDATE public.transactions SET eta = '2026-12-01' WHERE id = '${TX4}';
    -- TX3 completed operationally now (event), created 4 days ago
    UPDATE public.transactions SET operational_status = 'operationally_complete', created_at = now() - interval '4 days',
                                   status_changed_at = now() WHERE id = '${TX3}';
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, payload)
      VALUES ('${A}', '${TX3}', 'operational_status', 'new', 'operationally_complete', true, '{}');
    -- a client-visible and an internal event on TX1 (seed has visible ones too)
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, visible_to_client, payload)
      VALUES ('${A}', '${TX1}', 'note', false, '{"note":"internal"}');
  `);
  for (const t of [TX1, TX2, TX3, TX4, TX5]) S['ref_' + t] = (await one(`SELECT ref FROM public.transactions WHERE id = $1`, [t])).ref;
  // extra JED transactions for paging (12)
  for (let i = 0; i < 12; i++) {
    await db.exec(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ('${A}', '${JED}', '${CL103}', 'export', 'land')`);
  }
}

/* ================================================================== sections */
async function secCatalog() {
  section('catalog: version, privileges, report_exports, dictionaries, indexes');
  await check('schema_versions has 20261106000100 g6a_portal_reports', async () =>
    (await count(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261106000100' AND name = 'g6a_portal_reports'`)) === 1);
  await check('every new public RPC: SECURITY DEFINER, search_path = \'\', EXECUTE for authenticated only (not PUBLIC / anon)', async () => {
    const r = await q(`SELECT p.proname, p.prosecdef d, coalesce(p.proconfig, '{}') @> ARRAY['search_path=""'] sp,
                              has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n,
                              p.proacl::text acl
                         FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname = ANY($1)`, [RPCS]);
    const bad = r.filter(x => !x.d || !x.sp || !x.a || x.n || /(^|[{,])=X/.test(x.acl)).map(x => x.proname);
    return (r.length === RPCS.length && bad.length === 0) || JSON.stringify({ n: r.length, bad });
  });
  await check('every new app.* helper (rpt_*, mgmt_roles) not executable by authenticated / anon / PUBLIC', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a,
                              has_function_privilege('anon', p.oid, 'EXECUTE') n, p.proacl::text acl
                         FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                        WHERE ns.nspname = 'app' AND (p.proname LIKE 'rpt\\_%' OR p.proname = 'mgmt_roles')`);
    const bad = r.filter(x => x.a || x.n || x.acl === null || /(^|[{,])=X/.test(x.acl)).map(x => x.proname);
    return (r.length >= 20 && bad.length === 0) || JSON.stringify({ n: r.length, bad });
  });
  await check('every SECURITY DEFINER app.rpt_* helper sets search_path = \'\'', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                        WHERE ns.nspname = 'app' AND p.proname LIKE 'rpt\\_%' AND p.prosecdef
                          AND NOT (coalesce(p.proconfig, '{}') @> ARRAY['search_path=""'])`);
    return r.length === 0 || JSON.stringify(r);
  });
  await check('roles: mgmt = admin, supervisor, branch_manager; rpt_audit = admin, supervisor', async () => {
    const r = await one(`SELECT app.mgmt_roles() m, app.rpt_audit_roles() a`);
    return (r.m.join() === 'admin,supervisor,branch_manager' && r.a.join() === 'admin,supervisor') || JSON.stringify(r);
  });
  await check('report_exports: RLS on, 1 policy, authenticated SELECT only, anon nothing, append-only triggers, not audited', async () => {
    const r = await one(`SELECT c.relrowsecurity rls,
        (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = 'report_exports') pol,
        (SELECT string_agg(x.privilege_type, ',' ORDER BY x.privilege_type) FROM information_schema.role_table_grants x
          WHERE x.grantee = 'authenticated' AND x.table_name = 'report_exports') auth,
        (SELECT count(*)::int FROM information_schema.role_table_grants x WHERE x.grantee IN ('anon','PUBLIC') AND x.table_name = 'report_exports') anon,
        EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'trg_append_only') ao,
        EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'trg_append_only_trunc') aot,
        EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'trg_audit') audit
      FROM pg_class c WHERE c.relname = 'report_exports' AND c.relnamespace = 'public'::regnamespace`);
    return (r.rls && r.pol === 1 && r.auth === 'SELECT' && r.anon === 0 && r.ao && r.aot && !r.audit) || JSON.stringify(r);
  });
  await check('report_exports_select policy: auditor set spelled out = app.rpt_audit_roles(); no G6a helper in any policy', async () => {
    const r = await one(`SELECT qual FROM pg_policies WHERE tablename = 'report_exports'`);
    const any = await count(`SELECT count(*)::int n FROM pg_policies WHERE coalesce(qual, '') || coalesce(with_check, '') ~ '(rpt_|mgmt_roles)'`);
    return (/ARRAY\['admin'::text, 'supervisor'::text\]/.test(r.qual) && any === 0) || r.qual;
  });
  await check('report_exports columns: no row-data / totals column (id, org_id, actor, report, format, filters, row_count, created_at)', async () => {
    const r = await q(`SELECT column_name c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'report_exports' ORDER BY ordinal_position`);
    return r.map(x => x.c).join(',') === 'id,org_id,actor,report,format,filters,row_count,created_at' || JSON.stringify(r);
  });
  await check('dictionaries: report_kind 7 (+ fasah_sheet, 20261120000100), export_format 3, search_date_field 4 (internal); portal_payment_status 4 (client-visible)', async () => {
    const r = await q(`SELECT domain, count(*)::int n, bool_and(client_visible) v, bool_or(client_visible) anyv,
                              bool_and(label_ar <> '' AND label_en <> '') l
                         FROM public.status_labels WHERE domain IN ('report_kind','export_format','search_date_field','portal_payment_status')
                        GROUP BY 1 ORDER BY 1`);
    const m = Object.fromEntries(r.map(x => [x.domain, x]));
    return (m.report_kind.n === 7 && !m.report_kind.anyv && m.export_format.n === 3 && !m.export_format.anyv
            && m.search_date_field.n === 4 && !m.search_date_field.anyv && m.portal_payment_status.n === 4 && m.portal_payment_status.v
            && r.every(x => x.l)) || JSON.stringify(r);
  });
  await check('btree indexes exist (8, incl. report_exports and the transaction_events status index); the unusable ones do not', async () => {
    const names = ['transactions_g6a_created_idx', 'transactions_g6a_eta_idx', 'transactions_g6a_status_changed_idx', 'transport_trips_g6a_carrier_idx',
      'billing_intents_g6a_issued_idx', 'transaction_events_g6a_status_idx', 'report_exports_org_idx', 'report_exports_actor_idx'];
    const gone = ['transactions_g6a_ref_idx', 'containers_g6a_no_idx', 'bills_of_lading_g6a_no_idx', 'customs_declarations_g6a_no_idx',
      'port_appointments_g6a_at_idx'];
    const r = await q(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`, [names]);
    const g = await q(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`, [gone]);
    return (r.length === names.length && g.length === 0) || JSON.stringify({ have: r.map(x => x.indexname), gone: g.map(x => x.indexname) });
  });
  await check('no pg_trgm in this harness DB → no *_trgm_idx (btree fallback); the file never creates the extension', async () => {
    const r = await one(`SELECT (SELECT count(*)::int FROM pg_extension WHERE extname = 'pg_trgm') ext,
                                (SELECT count(*)::int FROM pg_indexes WHERE indexname LIKE '%\\_trgm\\_idx') idx`);
    const src = fs.readFileSync(path.join(SUPA, 'migrations', MIG_G6A), 'utf8');
    return (r.ext === 0 && r.idx === 0 && !/CREATE\s+EXTENSION/i.test(src.replace(/--.*$/gm, ''))
            && src.includes("RAISE NOTICE 'g6a: pg_trgm not installed, btree fallback'")) || JSON.stringify(r);
  });
  await check('no new transaction_events type (constraint unchanged by G6a)', async () => {
    const src = fs.readFileSync(path.join(SUPA, 'migrations', MIG_G6A), 'utf8');
    return !/transaction_events_event_type_check/.test(src) && !/INSERT INTO public\.transaction_events/.test(src);
  });
  await check('the file adds no column to an existing table and replaces no G2–G5 function / policy (source scan)', async () => {
    const src = fs.readFileSync(path.join(SUPA, 'migrations', MIG_G6A), 'utf8').replace(/--.*$/gm, '');
    const fns = [...src.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z_]+)/g)].map(m => m[1]);
    const prior = fs.readdirSync(path.join(SUPA, 'migrations')).filter(f => /^\d+_.*\.sql$/.test(f) && f < MIG_G6A)
      .map(f => fs.readFileSync(path.join(SUPA, 'migrations', f), 'utf8')).join('\n');
    const clash = fns.filter(n => prior.includes('FUNCTION ' + n + '('));
    const pols = [...src.matchAll(/CREATE POLICY (\w+) ON ([\w.]+)/g)].map(m => m[2]);
    return (!/ADD COLUMN/i.test(src) && clash.length === 0 && pols.every(t => t === 'public.report_exports')) || JSON.stringify({ clash, pols });
  });
}

async function secAnon() {
  section('anonymous / signed-out callers');
  for (const n of RPCS) {
    await expectErr(`anon: ${n} refused (no EXECUTE grant)`, () => asRole('anon', () => {
      const sig = n === 'portal_invoices' ? `public.${n}(NULL)` : `public.${n}('${A}', '{}')`;
      return q(`SELECT ${sig} r`);
    }), /permission denied/);
  }
  await expectErr('authenticated without a sub → MRS_AUTH_REQUIRED (search_records)', async () => {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', false);`);
    try { return await q(`SELECT public.search_records('${A}', '{}') r`); }
    finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
  }, /MRS_AUTH_REQUIRED/);
  await check('anon: report_exports not readable', async () => denied('anon', `SELECT * FROM public.report_exports`));
}

async function secSearch() {
  section('4. search_records: filters, validation, paging, isolation, finance field');
  const all = await R.search('adminA', { limit: 100 });
  S.allA = all;
  await check('no filter (admin) = every org A transaction, most recent first, tie-break id', async () => {
    const n = await count(`SELECT count(*)::int n FROM public.transactions WHERE org_id = $1`, [A]);
    const exp = (await q(`SELECT id FROM public.transactions WHERE org_id = $1 ORDER BY created_at DESC, id LIMIT 100`, [A])).map(x => x.id);
    return (all.total === n && JSON.stringify(all.items.map(x => x.id)) === JSON.stringify(exp) && all.limit === 100 && all.offset === 0
            && /^[0-9a-f]{32}$/.test(all.fingerprint)) || JSON.stringify({ total: all.total, n });
  });
  await check('item shape: the §4.1 keys exactly', async () => {
    const want = ['id', 'ref', 'branch_id', 'branch_name', 'client_id', 'client_name', 'client_name_en', 'operation', 'mode', 'operational_status',
      'bl_number', 'declaration_no', 'port_of_loading', 'port_of_discharge', 'shipping_line', 'eta', 'created_at', 'status_changed_at',
      'container_count', 'financial_status', 'matched'].sort();
    // legacy step 1 (20261117000100) adds cancelled_at to the row when that migration is present
    if (fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).some(f => f.startsWith('20261117000100'))) { want.push('cancelled_at'); want.sort(); }
    return JSON.stringify(Object.keys(all.items[0]).sort()) === JSON.stringify(want) || JSON.stringify(Object.keys(all.items[0]));
  });
  await check('container_count = real number of containers (TX4: 2, TX1: 2, TX3: 0)', async () => {
    const m = Object.fromEntries(all.items.map(x => [x.id, x.container_count]));
    return (m[TX4] === 2 && m[TX1] === 2 && m[TX3] === 0) || JSON.stringify([m[TX4], m[TX1], m[TX3]]);
  });
  const cases = [
    ['declaration_no (lower case, spaced) → TX4', { declaration_no: 'dec 4001' }, [TX4]],
    ['declaration_no of a CANCELLED declaration still finds its transaction (any status) → TX2', { declaration_no: 'DEC2CANCEL' }, [TX2]],
    ['declaration_no on the tx column (seed TEST-DEC-0001) → TX1', { declaration_no: 'test-dec-0001' }, [TX1]],
    ['bl_number via the primary link / mirror → TX4', { bl_number: 'blx777' }, [TX4]],
    ['bl_number via a NON-primary transaction_bls link (tx column empty) → TX5', { bl_number: 'BLY 888' }, [TX5]],
    ['container_no lower-case with spaces → TX4', { container_no: 'mscu 1234' }, [TX4]],
    ['container_no prefix shared by seed containers → TX1, TX2', { container_no: 'TSTU' }, [TX1, TX2]],
    ['client_id exact → TX2 only', { client_id: CL102 }, [TX2]],
    ['client_q name (ar) → TX2', { client_q: 'الثانية' }, [TX2]],
    ['client_q CR number of client 101 → TX1, TX4, TX5', { client_q: '7000000001' }, [TX1, TX4, TX5]],
    ['carrier_id via trip carrier → TX4, TX5', { carrier_id: P_CAR }, [TX4, TX5]],
    ['carrier_id via B/L shipping agent → TX4', { carrier_id: P_AGENT }, [TX4]],
    ['carrier_q B/L carrier name (MAERSK) → TX4', { carrier_q: 'maersk' }, [TX4]],
    ['carrier_q trip carrier party name (ar) → TX4, TX5', { carrier_q: 'الشمال' }, [TX4, TX5]],
    ['carrier_q tx shipping_line → TX1, TX2', { carrier_q: 'خط ملاحي' }, [TX1, TX2]],
    ['port via linked B/L (NINGBO) → TX4', { port: 'ningbo' }, [TX4]],
    ['port via tx port_of_discharge (الدمام) → TX2', { port: 'الدمام' }, [TX2]],
    ['port via tx port_of_loading (شنغهاي) → TX4', { port: 'شنغهاي' }, [TX4]],
    ['date created = 2026-03-11 (Riyadh day of 2026-03-10 21:30Z) → TX5', { date_field: 'created', from: '2026-03-11', to: '2026-03-11' }, [TX5]],
    ['date created = 2026-03-10 (UTC day) → nothing (Riyadh boundary)', { date_field: 'created', from: '2026-03-10', to: '2026-03-10' }, []],
    ['date status_changed = 2026-03-12 (Riyadh of 03-11 21:00Z) → TX5', { date_field: 'status_changed', from: '2026-03-12', to: '2026-03-12' }, [TX5]],
    ['date eta 2026-12-01 → TX4', { date_field: 'eta', from: '2026-12-01', to: '2026-12-31' }, [TX4]],
    ['date declaration 2026-10-15 (active declaration of TX4) → TX4', { date_field: 'declaration', from: '2026-10-15', to: '2026-10-15' }, [TX4]],
    ['date declaration 2026-10-16 (only a CANCELLED declaration) → nothing', { date_field: 'declaration', from: '2026-10-16', to: '2026-10-16' }, []],
    ['branch DMM (admin) → TX2, TX5', { branch_id: DMM }, [TX2, TX5]],
    ['status array (customs_declaration, operationally_complete) → TX1, TX3', { operational_status: ['customs_declaration', 'operationally_complete'] }, [TX1, TX3]],
    ['q = tx ref → that tx', null, null],
    ['q = container number fragment → TX4', { q: 'mscu1234' }, [TX4]],
    ['q = cancelled declaration number → TX2', { q: 'dec2cancel' }, [TX2]],
    ['q = non-primary B/L → TX5', { q: 'bly888' }, [TX5]],
    ['q = client name (en) → client 102 tx', { q: 'Test Est. Two' }, [TX2]],
    ['combined: client_q 7000000001 + branch JED → TX1, TX4', { client_q: '7000000001', branch_id: JED }, [TX1, TX4]],
    ['combined: carrier_id + container_no → TX4', { carrier_id: P_CAR, container_no: 'MSCU' }, [TX4]],
    ['combined: carrier_id + branch DMM + status new → TX5', { carrier_id: P_CAR, branch_id: DMM, operational_status: 'new' }, [TX5]]
  ];
  for (const [label, f, exp] of cases) {
    if (!f) {
      await check('search: ' + label, async () => { const r = await R.search('adminA', { q: S['ref_' + TX4] }); return same(ids(r), [TX4]) || JSON.stringify(ids(r)); });
      continue;
    }
    await check('search: ' + label, async () => {
      const r = await R.search('adminA', Object.assign({ limit: 100 }, f));
      return (same(ids(r), exp) && r.total === exp.length) || JSON.stringify({ got: ids(r), total: r.total });
    });
  }
  await check('LIKE metacharacters are literal: q "%%" and "__" → 0 rows (not everything)', async () => {
    const a = await R.search('adminA', { q: '%%' }), b = await R.search('adminA', { q: '__' }), c = await R.search('adminA', { client_q: '\\%' });
    return (a.total === 0 && b.total === 0 && c.total === 0) || JSON.stringify([a.total, b.total, c.total]);
  });
  await check('matched: container search names the container; cancelled declaration carries its status', async () => {
    const r = await R.search('adminA', { container_no: 'mscu' });
    const d = await R.search('adminA', { q: 'DEC2CANCEL' });
    const m1 = r.items[0].matched, m2 = d.items[0].matched;
    return (m1.some(x => x.field === 'container_no' && x.value === 'MSCU1234567') && m1.length <= 5
            && m2.some(x => x.field === 'declaration_no' && x.value === 'DEC2CANCEL' && x.declaration_status === 'cancelled'))
      || JSON.stringify({ m1, m2 });
  });
  await check('matched: carrier / port / client / bl values; no filter → []', async () => {
    const r = await R.search('adminA', { carrier_id: P_AGENT, port: 'ningbo', client_q: 'الأولى', bl_number: 'BLX' });
    const m = r.items[0].matched;
    const fields = m.map(x => x.field);
    return (r.total === 1 && ['bl_number', 'client', 'carrier', 'port'].every(f => fields.includes(f)) && m.length <= 5
            && all.items.every(x => Array.isArray(x.matched) && x.matched.length === 0)) || JSON.stringify(m);
  });
  await check('sort ref ascending (tie-break id); created_asc is the reverse of created_desc', async () => {
    const r = await R.search('adminA', { sort: 'ref', limit: 100 });
    const exp = (await q(`SELECT id FROM public.transactions WHERE org_id = $1 ORDER BY ref, id`, [A])).map(x => x.id);
    const a = await R.search('adminA', { sort: 'created_asc', limit: 100 });
    const expA = (await q(`SELECT id FROM public.transactions WHERE org_id = $1 ORDER BY created_at, id`, [A])).map(x => x.id);
    return (JSON.stringify(r.items.map(x => x.id)) === JSON.stringify(exp) && JSON.stringify(a.items.map(x => x.id)) === JSON.stringify(expA)) || 'order';
  });
  await check('sort eta (nulls last) and status_changed_desc', async () => {
    const r = await R.search('adminA', { sort: 'eta', limit: 100 });
    const s = await R.search('adminA', { sort: 'status_changed_desc', limit: 100 });
    const expS = (await q(`SELECT id FROM public.transactions WHERE org_id = $1 ORDER BY status_changed_at DESC, id`, [A])).map(x => x.id);
    return (r.items[0].id === TX4 && JSON.stringify(s.items.map(x => x.id)) === JSON.stringify(expS)) || 'order';
  });
  await check('pagination: limit 4 pages are disjoint, union = full set, total + fingerprint stable', async () => {
    const seen = []; let fp = null; let tot = null;
    for (let off = 0; off < all.total; off += 4) {
      const p = await R.search('adminA', { limit: 4, offset: off });
      if (fp && (p.fingerprint !== fp || p.total !== tot)) return 'unstable';
      fp = p.fingerprint; tot = p.total; seen.push(...p.items.map(x => x.id));
    }
    return (seen.length === all.total && new Set(seen).size === all.total && same(seen, ids(all)) && fp === all.fingerprint) || 'pages ' + seen.length;
  });
  await check('default limit 25; offset beyond the end → empty items, same total', async () => {
    const d = await R.search('adminA', {});
    const e = await R.search('adminA', { offset: 1000 });
    return (d.limit === 25 && d.items.length === Math.min(25, all.total) && e.items.length === 0 && e.total === all.total) || JSON.stringify([d.limit, e.total]);
  });
  for (const [label, f, re] of [
    ['q of 1 char → MRS_INVALID search_query_short', { q: 'a' }, /MRS_INVALID search_query_short/],
    ['q of 81 chars → MRS_TOO_LONG q', { q: 'x'.repeat(81) }, /MRS_TOO_LONG q/],
    ['unknown key → MRS_INVALID unknown_key', { foo: 1 }, /MRS_INVALID unknown_key/],
    ['bad status code → MRS_INVALID operational_status', { operational_status: 'nope' }, /MRS_INVALID operational_status/],
    ['bad status inside an array → MRS_INVALID operational_status', { operational_status: ['new', 'nope'] }, /MRS_INVALID operational_status/],
    ['status as object → MRS_INVALID operational_status', { operational_status: { a: 1 } }, /MRS_INVALID operational_status/],
    ['from > to → MRS_INVALID date_range', { from: '2026-05-02', to: '2026-05-01' }, /MRS_INVALID date_range/],
    ['range wider than 1096 days → MRS_INVALID date_range', { from: '2020-01-01', to: '2026-01-01' }, /MRS_INVALID date_range/],
    ['bad date → MRS_INVALID from', { from: '2026-13-40' }, /MRS_INVALID from/],
    ['bad date_field → MRS_INVALID date_field', { date_field: 'paid' }, /MRS_INVALID date_field/],
    ['bad sort → MRS_INVALID sort', { sort: 'random' }, /MRS_INVALID sort/],
    ['limit 101 → MRS_INVALID limit', { limit: 101 }, /MRS_INVALID limit/],
    ['offset above 1 000 000 → MRS_INVALID offset', { offset: 1000001 }, /MRS_INVALID offset/],
    ['malformed client_id → MRS_INVALID client_id', { client_id: 'x' }, /MRS_INVALID client_id/],
    ['branch of another org → MRS_INVALID branch_id', { branch_id: B_BR }, /MRS_INVALID branch_id/]]) {
    await expectErr('search: ' + label, () => R.search('adminA', f), re);
  }
  await check('branch isolation: JED clearance staff sees only JED rows', async () => {
    const r = await R.search('clrJ', { limit: 100 });
    const exp = (await q(`SELECT id FROM public.transactions WHERE org_id = $1 AND branch_id = $2`, [A, JED])).map(x => x.id);
    return (same(ids(r), exp) && r.items.every(x => x.branch_id === JED)) || JSON.stringify({ got: r.total, exp: exp.length });
  });
  await check('branch isolation: JED staff with branch_id = DMM → 0 rows (not an error)', async () => {
    const r = await R.search('clrJ', { branch_id: DMM });
    return (r.total === 0 && r.items.length === 0) || JSON.stringify(r);
  });
  await check('branch isolation: JED staff searching a DMM container / B/L → 0 rows', async () => {
    const a = await R.search('clrJ', { container_no: 'DMMU0000005' }), b = await R.search('clrJ', { q: 'BLY888' });
    return (a.total === 0 && b.total === 0) || JSON.stringify([a.total, b.total]);
  });
  await check('mixed memberships (accountant JED + clearance DMM): both branches', async () => {
    const r = await R.search('mix', { limit: 100 });
    return (r.total === (await count(`SELECT count(*)::int n FROM public.transactions WHERE org_id = $1`, [A]))) || String(r.total);
  });
  await expectErr('org isolation: org B admin on p_org = A → MRS_FORBIDDEN organization', () => R.search('adminB'), /MRS_FORBIDDEN organization/);
  await check('org isolation: org B admin on its own org sees only B_TX', async () => {
    const r = await R.search('adminB', {}, B);
    return same(ids(r), [B_TX]) || JSON.stringify(ids(r));
  });
  await check('financial_status: null for clearance / transport / operations staff; set for finance roles at the branch', async () => {
    const c = await R.search('clrJ', { limit: 100 }), t = await R.search('trJ', { limit: 100 }), o = await R.search('opsA', { limit: 100 });
    const a = await R.search('accJ', { limit: 100 }), m = await R.search('mix', { limit: 100 });
    const mixOk = m.items.every(x => (x.branch_id === JED) === (x.financial_status !== null));
    return (c.items.every(x => x.financial_status === null) && t.items.every(x => x.financial_status === null)
            && o.items.every(x => x.financial_status === null) && a.items.every(x => typeof x.financial_status === 'string') && mixOk)
      || 'finance field leak';
  });
  for (const who of CLIENTS) await expectErr(`client ${who}: search_records → MRS_FORBIDDEN`, () => R.search(who), /MRS_FORBIDDEN/);
}

async function secReports() {
  section('5.1 reports: transactions = search, totals over the whole set, fingerprint, containers, trips');
  const filters = [{}, { branch_id: JED }, { client_q: '7000000001' }, { container_no: 'TSTU' }, { operational_status: ['new'] }, { q: 'MRS' }];
  for (const f of filters) {
    await check('report_transactions = search_records (same ids, same total, same fingerprint) for ' + JSON.stringify(f), async () => {
      const a = await R.search('adminA', Object.assign({ limit: 100 }, f)), b = await R.rtx('adminA', Object.assign({ limit: 500 }, f));
      return (same(ids(a), ids(b)) && a.total === b.total && a.fingerprint === b.fingerprint) || JSON.stringify({ a: a.total, b: b.total });
    });
  }
  await check('report_transactions item = search item + open_returns + declaration_status', async () => {
    const r = await R.rtx('adminA', { container_no: 'MSCU' });
    const it = r.items[0];
    return (it.id === TX4 && it.open_returns === 2 && it.declaration_status === 'submitted' && Array.isArray(it.matched)) || JSON.stringify(it);
  });
  await check('report_transactions totals over the WHOLE set = Σ of all pages (limit 3)', async () => {
    const first = await R.rtx('adminA', { limit: 3 });
    let n = 0, cont = 0, open = 0; const by = {};
    for (let off = 0; off < first.total; off += 3) {
      const p = await R.rtx('adminA', { limit: 3, offset: off });
      if (JSON.stringify(p.totals) !== JSON.stringify(first.totals) || p.fingerprint !== first.fingerprint) return 'totals changed between pages';
      p.items.forEach(x => { n++; cont += x.container_count; open += x.open_returns; by[x.operational_status] = (by[x.operational_status] || 0) + 1; });
    }
    const t = first.totals;
    return (t.count === n && t.count === first.total && t.containers === cont && t.open_returns === open
            && JSON.stringify(Object.keys(by).sort().map(k => [k, by[k]])) === JSON.stringify(Object.keys(t.by_status).sort().map(k => [k, t.by_status[k]])))
      || JSON.stringify({ t, n, cont, open, by });
  });
  await check('report_transactions totals equal direct superuser counts (branch JED)', async () => {
    const r = await R.rtx('adminA', { branch_id: JED });
    const e = await one(`SELECT count(*)::int n, (SELECT count(*)::int FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
                                 WHERE t.org_id = $1 AND t.branch_id = $2) c FROM public.transactions WHERE org_id = $1 AND branch_id = $2`, [A, JED]);
    return (r.totals.count === e.n && r.totals.containers === e.c) || JSON.stringify({ t: r.totals, e });
  });
  await check('fingerprint changes after an update of a row in the set, not after one outside it', async () => {
    const a = await R.rtx('adminA', { branch_id: JED });
    await db.exec(`UPDATE public.transactions SET goods_description = 'تحديث' WHERE id = '${TX2}'`);   // DMM: outside
    const b = await R.rtx('adminA', { branch_id: JED });
    await db.exec(`UPDATE public.transactions SET goods_description = 'تحديث' WHERE id = '${TX4}'`);   // JED: inside
    const c = await R.rtx('adminA', { branch_id: JED });
    return (a.fingerprint === b.fingerprint && b.fingerprint !== c.fingerprint && a.total === c.total) || JSON.stringify([a.fingerprint, b.fingerprint, c.fingerprint]);
  });
  await expectErr('report_transactions: limit 501 → MRS_INVALID limit', () => R.rtx('adminA', { limit: 501 }), /MRS_INVALID limit/);
  await check('report_transactions: limit 500 allowed, default 100', async () => {
    const a = await R.rtx('adminA', { limit: 500 }), b = await R.rtx('adminA', {});
    return (a.limit === 500 && b.limit === 100) || JSON.stringify([a.limit, b.limit]);
  });

  // containers
  const today = (await one(`SELECT app.rpt_today()::text d`)).d;
  await check('report_containers (admin): every org A container, deadline ascending, days_overdue with Riyadh today', async () => {
    const r = await R.rcont('adminA', { limit: 500 });
    const n = await count(`SELECT count(*)::int n FROM public.containers WHERE org_id = $1`, [A]);
    const c = r.items.find(x => x.id === C4A), d = r.items.find(x => x.id === C4B);
    const dl = r.items.map(x => x.return_deadline).filter(Boolean);
    return (r.total === n && c.days_overdue === 2 && d.days_overdue === 0 && c.return_yard_name === 'ساحة الإرجاع'
            && c.transaction_ref === S['ref_' + TX4] && JSON.stringify(dl) === JSON.stringify(dl.slice().sort())) || JSON.stringify({ total: r.total, n, c, today });
  });
  await check('report_containers totals: overdue / due_3d / open = superuser predicates (Riyadh today)', async () => {
    const r = await R.rcont('adminA', {});
    const e = await one(`SELECT count(*)::int n,
        count(*) FILTER (WHERE return_status IN ('pending','evidence_submitted','disputed'))::int o,
        count(*) FILTER (WHERE return_status IN ('pending','evidence_submitted','disputed') AND return_deadline < app.rpt_today())::int ov,
        count(*) FILTER (WHERE return_status IN ('pending','evidence_submitted','disputed') AND return_deadline BETWEEN app.rpt_today() AND app.rpt_today() + 3)::int d3
      FROM public.containers WHERE org_id = $1`, [A]);
    return (r.totals.count === e.n && r.totals.open === e.o && r.totals.overdue === e.ov && r.totals.due_3d === e.d3 && e.ov >= 1 && e.d3 >= 1
            && r.totals.by_return_status.pending === e.o) || JSON.stringify({ t: r.totals, e });
  });
  await check('report_containers overdue=true → only MSCU1234567; container_no filter normalized', async () => {
    const r = await R.rcont('adminA', { overdue: true }), s = await R.rcont('adminA', { container_no: 'abcd 7654' });
    return (same(ids(r), [C4A]) && same(ids(s), [C4B])) || JSON.stringify([ids(r), ids(s)]);
  });
  await check('report_containers return_deadline range (Riyadh dates) + branch scope (JED staff: no DMM container)', async () => {
    const r = await R.rcont('adminA', { date_field: 'return_deadline', from: today, to: today });
    const j = await R.rcont('clrJ', { limit: 500 });
    return (r.total === 0 && j.items.every(x => x.id !== C5) && j.total === 4) || JSON.stringify([r.total, j.total]);
  });
  for (const [label, f, re] of [
    ['bad return_status → MRS_INVALID return_status', { return_status: 'lost' }, /MRS_INVALID return_status/],
    ['bad operational_state → MRS_INVALID operational_state', { operational_state: ['at_port', 'x'] }, /MRS_INVALID operational_state/],
    ['bad date_field → MRS_INVALID date_field', { date_field: 'eta' }, /MRS_INVALID date_field/],
    ['bad sort → MRS_INVALID sort', { sort: 'ref' }, /MRS_INVALID sort/],
    ['unknown key → MRS_INVALID unknown_key', { q: 'x' }, /MRS_INVALID unknown_key/]]) {
    await expectErr('report_containers: ' + label, () => R.rcont('adminA', f), re);
  }
  await check('report_containers date_field gate_out / returned_at / created use Riyadh day boundaries', async () => {
    await db.exec(`UPDATE public.containers SET gate_out_at = '2026-03-10 22:00:00+00' WHERE id = '${C4B}';
                   UPDATE public.containers SET returned_at = '2026-04-01 20:59:00+00' WHERE id = '${C5}';`);
    const g = await R.rcont('adminA', { date_field: 'gate_out', from: '2026-03-11', to: '2026-03-11' });
    const g0 = await R.rcont('adminA', { date_field: 'gate_out', from: '2026-03-10', to: '2026-03-10' });
    const r = await R.rcont('adminA', { date_field: 'returned_at', from: '2026-04-01', to: '2026-04-01' });
    const c = await R.rcont('adminA', { date_field: 'created', from: today, to: today });
    return (same(ids(g), [C4B]) && g0.total === 0 && same(ids(r), [C5]) && c.total >= 3) || JSON.stringify([ids(g), g0.total, ids(r), c.total]);
  });
  await check('report_containers operational_state array + return_status code', async () => {
    const r = await R.rcont('adminA', { operational_state: ['expected', 'at_port'], return_status: 'pending' });
    return r.total === (await count(`SELECT count(*)::int n FROM public.containers WHERE org_id = $1 AND operational_state IN ('expected','at_port') AND return_status = 'pending'`, [A])) || String(r.total);
  });

  // trips
  await check('report_trips: clearance staff → finance fields null on every row', async () => {
    const r = await R.rtrip('clrJ', {});
    return (r.total === 2 && r.items.every(x => x.cost_amount === null && x.sell_amount === null && x.cost_currency === null && x.sell_currency === null)
            && r.totals.finance.rows_with_finance === 0) || JSON.stringify(r.items);
  });
  await expectErr('report_trips: include_finance without a trip_finance role anywhere → MRS_FORBIDDEN cost', () => R.rtrip('clrJ', { include_finance: true }), /MRS_FORBIDDEN cost/);
  await expectErr('report_trips: transport staff include_finance → MRS_FORBIDDEN cost', () => R.rtrip('trJ', { include_finance: true }), /MRS_FORBIDDEN cost/);
  await check('report_trips: operations manager include_finance → amounts set; without the flag → null', async () => {
    const r = await R.rtrip('opsA', { include_finance: true }), n = await R.rtrip('opsA', {});
    const t1 = r.items.find(x => x.id === TR1);
    return (r.total === 3 && N(t1.cost_amount) === 500.25 && t1.cost_currency === 'SAR' && N(t1.sell_amount) === 800
            && n.items.every(x => x.cost_amount === null)) || JSON.stringify(t1);
  });
  await check('report_trips: finance per ROW branch (accountant JED + clearance DMM): JED rows set, DMM row null', async () => {
    const r = await R.rtrip('mix', { include_finance: true });
    const d = r.items.find(x => x.id === TR3), j = r.items.find(x => x.id === TR1);
    return (r.total === 3 && d.cost_amount === null && d.sell_currency === null && N(j.cost_amount) === 500.25 && r.totals.finance.rows_with_finance === 2)
      || JSON.stringify(r.items);
  });
  await check('report_trips: finance totals = Σ exactly the non-null values returned (per currency, minor units)', async () => {
    for (const who of ['opsA', 'mix', 'accJ', 'adminA']) {
      const r = await R.rtrip(who, { include_finance: true, limit: 500 });
      const cost = {}, sell = {};
      r.items.forEach(x => {
        if (x.cost_amount !== null) cost[x.cost_currency] = (cost[x.cost_currency] || 0) + cents(x.cost_amount);
        if (x.sell_amount !== null) sell[x.sell_currency] = (sell[x.sell_currency] || 0) + cents(x.sell_amount);
      });
      const tc = Object.fromEntries(Object.entries(r.totals.finance.cost_by_currency).map(([k, v]) => [k, cents(v)]));
      const ts = Object.fromEntries(Object.entries(r.totals.finance.sell_by_currency).map(([k, v]) => [k, cents(v)]));
      if (JSON.stringify(Object.entries(tc).sort()) !== JSON.stringify(Object.entries(cost).sort())
          || JSON.stringify(Object.entries(ts).sort()) !== JSON.stringify(Object.entries(sell).sort())) return who + ' ' + JSON.stringify({ tc, cost, ts, sell });
    }
    const o = await R.rtrip('opsA', { include_finance: true });
    return (cents(o.totals.finance.cost_by_currency.SAR) === 70025 && cents(o.totals.finance.cost_by_currency.USD) === 30000
            && cents(o.totals.finance.sell_by_currency.SAR) === 115050) || JSON.stringify(o.totals.finance);
  });
  await check('report_trips: carrier / status / client / date filters, driver + truck names, sort', async () => {
    const c = await R.rtrip('adminA', { carrier_id: P_CAR }), s = await R.rtrip('adminA', { status: ['planned', 'dispatched'] });
    const cl = await R.rtrip('adminA', { client_id: CL102 }), asc = await R.rtrip('adminA', { sort: 'planned_asc' });
    const t1 = c.items.find(x => x.id === TR1);
    return (same(ids(c), [TR1, TR3]) && same(ids(s), [TR1, TR2]) && cl.total === 0 && t1.driver_name === 'سائق تجريبي' && t1.truck_plate === 'ABC1234'
            && t1.carrier_name === 'ناقل الشمال' && t1.container_no === 'MSCU1234567' && asc.items[0].id === TR3) || JSON.stringify({ c: ids(c), s: ids(s) });
  });
  await check('report_trips: totals.by_status over the whole set; fingerprint stable across pages', async () => {
    const a = await R.rtrip('adminA', { limit: 1 }), b = await R.rtrip('adminA', { limit: 1, offset: 1 });
    return (a.totals.count === 3 && a.totals.by_status.planned === 2 && a.totals.by_status.delivered === 1 && a.fingerprint === b.fingerprint
            && a.items[0].id !== b.items[0].id) || JSON.stringify(a.totals);
  });
  await expectErr('report_trips: bad status → MRS_INVALID trip_status', () => R.rtrip('adminA', { status: 'lost' }), /MRS_INVALID trip_status/);
  await expectErr('report_trips: limit 600 → MRS_INVALID limit', () => R.rtrip('adminA', { limit: 600 }), /MRS_INVALID limit/);
  for (const n of ['report_transactions', 'report_containers', 'report_trips']) {
    for (const who of CLIENTS) await expectErr(`client ${who}: ${n} → MRS_FORBIDDEN`, () => CALL[n](who), /MRS_FORBIDDEN/);
    await expectErr(`org B admin: ${n} on org A → MRS_FORBIDDEN`, () => CALL[n]('adminB'), /MRS_FORBIDDEN/);
  }
}

async function secDashboards() {
  section('3. dashboards per role');
  const finOk = ['adminA', 'supA', 'bmJ', 'accA', 'mgrA', 'accJ', 'mix'];
  const mgmtOk = ['adminA', 'supA', 'bmJ'];
  for (const who of STAFF) {
    await check(`dash_ops: ${who} allowed`, async () => !!(await R.dops(who)).generated_at);
    if (finOk.includes(who)) await check(`dash_finance: ${who} allowed`, async () => !!(await R.dfin(who)).generated_at);
    else await expectErr(`dash_finance: ${who} → MRS_FORBIDDEN finance`, () => R.dfin(who), /MRS_FORBIDDEN finance/);
    if (mgmtOk.includes(who)) await check(`dash_management: ${who} allowed`, async () => !!(await R.dmgmt(who)).generated_at);
    else await expectErr(`dash_management: ${who} → MRS_FORBIDDEN`, () => R.dmgmt(who), /MRS_FORBIDDEN/);
  }
  for (const who of CLIENTS) for (const n of ['dash_ops', 'dash_finance', 'dash_management']) {
    await expectErr(`client ${who}: ${n} → MRS_FORBIDDEN`, () => CALL[n](who), /MRS_FORBIDDEN/);
  }
  for (const n of ['dash_ops', 'dash_finance', 'dash_management']) await expectErr(`org B admin: ${n} on org A → MRS_FORBIDDEN`, () => CALL[n]('adminB'), /MRS_FORBIDDEN/);

  // dash_ops counts = superuser counts with the same predicates, per branch scope
  const scopes = { adminA: [JED, DMM], clrJ: [JED], trJ: [JED], clrD: [DMM], bmJ: [JED], mix: [JED, DMM] };
  for (const who of Object.keys(scopes)) {
    await check(`dash_ops (${who}): counts = direct superuser counts for branches ${scopes[who].length === 2 ? 'JED+DMM' : (scopes[who][0] === JED ? 'JED' : 'DMM')}`, async () => {
      const r = await R.dops(who), br = scopes[who];
      const e = await one(`
        WITH t AS (SELECT * FROM public.transactions WHERE org_id = $1 AND branch_id = ANY ($2::uuid[]))
        SELECT (SELECT count(*)::int FROM t WHERE operational_status IN ('new','in_progress','customs_declaration','appointment','transport','empty_return')) open,
               (SELECT count(*)::int FROM public.containers c WHERE c.transaction_id IN (SELECT id FROM t) AND c.return_status IN ('pending','evidence_submitted','disputed') AND c.return_deadline < app.rpt_today()) overdue,
               (SELECT count(*)::int FROM public.containers c WHERE c.transaction_id IN (SELECT id FROM t) AND c.return_status IN ('pending','evidence_submitted','disputed')) open_returns,
               (SELECT count(*)::int FROM public.transport_trips tr WHERE tr.transaction_id IN (SELECT id FROM t) AND tr.status = 'planned') planned,
               (SELECT count(*)::int FROM public.transport_trips tr WHERE tr.transaction_id IN (SELECT id FROM t) AND tr.status IN ('planned','dispatched') AND tr.planned_at < now()) late,
               (SELECT count(*)::int FROM public.port_appointments a WHERE a.transaction_id IN (SELECT id FROM t) AND a.status IN ('requested','confirmed') AND a.appointment_at >= now() AND a.appointment_at < now() + interval '7 days') next7,
               (SELECT count(*)::int FROM public.operational_alerts al WHERE al.transaction_id IN (SELECT id FROM t) AND al.status IN ('open','acknowledged') AND al.severity = 'critical') crit,
               (SELECT count(*)::int FROM public.operational_alerts al WHERE al.transaction_id IN (SELECT id FROM t) AND al.status IN ('open','acknowledged') AND al.severity = 'warning') warn,
               (SELECT count(*)::int FROM public.operational_exceptions x WHERE x.transaction_id IN (SELECT id FROM t) AND x.status IN ('open','in_progress')) exc,
               (SELECT count(*)::int FROM t) n`, [A, br]);
      const byN = Object.values(r.transactions.by_status).reduce((s, v) => s + v, 0);
      return (r.transactions.open === e.open && r.containers.overdue === e.overdue && r.containers.open_returns === e.open_returns
              && r.transport.by_status.planned === e.planned && r.transport.late === e.late && r.appointments.next_7d === e.next7
              && r.alerts.critical === e.crit && r.alerts.warning === e.warn && r.exceptions_open === e.exc && byN === e.n)
        || JSON.stringify({ r: { open: r.transactions.open, ov: r.containers.overdue, pl: r.transport.by_status.planned, late: r.transport.late,
                                 n7: r.appointments.next_7d, al: r.alerts, exc: r.exceptions_open, byN }, e });
    });
  }
  await check('dash_ops: no money key anywhere (recursive key scan), for every staff role', async () => {
    for (const who of STAFF) {
      const r = await R.dops(who);
      const bad = keysDeep(r).filter(k => MONEY_RE.test(k));
      if (bad.length) return who + ': ' + bad.join(',');
    }
    return true;
  });
  await check('dash_ops: upcoming / nearest lists ≤ 10, nearest ordered by deadline with days_left', async () => {
    const r = await R.dops('adminA');
    const nr = r.containers.nearest;
    return (r.appointments.upcoming.length <= 10 && r.transport.upcoming.length <= 10 && nr.length <= 10 && nr[0].id === C4A && nr[0].days_left === -2)
      || JSON.stringify(nr);
  });
  await check('dash_ops: requests block only for ops writers (clearance yes; transport / accountant null)', async () => {
    const c = await R.dops('clrJ'), t = await R.dops('trJ'), a = await R.dops('accA'), ad = await R.dops('adminA');
    return (c.requests !== null && t.requests === null && a.requests === null && ad.requests.new >= 1) || JSON.stringify([c.requests, t.requests, a.requests, ad.requests]);
  });
  await check('dash_ops: branch filter DMM as admin = clrD scope', async () => {
    const a = await R.dops('adminA', { branch_id: DMM }), d = await R.dops('clrD');
    return (JSON.stringify(a.transactions) === JSON.stringify(d.transactions) && JSON.stringify(a.containers) === JSON.stringify(d.containers)) || 'differs';
  });
  await expectErr('dash_ops: unknown key → MRS_INVALID unknown_key', () => R.dops('adminA', { from: '2026-01-01' }), /MRS_INVALID unknown_key/);

  // dash_finance
  const finScopes = { adminA: [JED, DMM], accA: [JED, DMM], accJ: [JED], bmJ: [JED], mix: [JED] };
  for (const who of Object.keys(finScopes)) {
    await check(`dash_finance (${who}): official = Σ Daftra-synced fields of ISSUED intents in scope only`, async () => {
      const r = await R.dfin(who), br = finScopes[who];
      // issued, minus those with an OPEN G5 'issued_cancelled' review item (Daftra cancelled them; reported apart)
      const e = await q(`SELECT i.currency::text cur, count(*)::int n, sum(i.remote_total) tot, sum(coalesce(i.paid_amount, 0)) paid
                           FROM public.billing_intents i JOIN public.transactions t ON t.id = i.transaction_id
                          WHERE i.org_id = $1 AND i.status = 'issued' AND t.branch_id = ANY ($2::uuid[])
                            AND NOT EXISTS (SELECT 1 FROM public.billing_review_items r WHERE r.intent_id = i.id
                                              AND r.kind = 'issued_cancelled' AND r.status = 'open')
                          GROUP BY 1 ORDER BY 1`, [A, br]);
      const o = r.official.by_currency;
      const ok = e.length === Object.keys(o).length && e.every(x => o[x.cur] && o[x.cur].issued_count === x.n && cents(o[x.cur].total) === cents(x.tot)
        && cents(o[x.cur].paid) === cents(x.paid) && cents(o[x.cur].outstanding) === cents(x.tot) - cents(x.paid));
      return (ok && r.official.source === 'daftra') || JSON.stringify({ o, e });
    });
  }
  await check('dash_finance: a draft with lines_total and a fake remote_total (5000) is NOT official; unofficial never added', async () => {
    const r = await R.dfin('adminA');
    const sar = r.official.by_currency.SAR;
    return (cents(sar.total) === cents(1150 + 230) && sar.issued_count === 2 && !r.official.by_currency.EUR
            && r.unofficial.open_intents === 2 && cents(r.unofficial.open_lines_total_by_currency.SAR) === cents(999 + 50)
            && r.unofficial.label_ar === 'قيد الإعداد — غير رسمي') || JSON.stringify({ o: r.official, u: r.unofficial });
  });
  await check('dash_finance: last_synced_at = max over issued intents in scope', async () => {
    const r = await R.dfin('accJ');
    const e = await one(`SELECT max(i.last_synced_at) m FROM public.billing_intents i JOIN public.transactions t ON t.id = i.transaction_id
                          WHERE i.org_id = $1 AND i.status = 'issued' AND t.branch_id = $2`, [A, JED]);
    return new Date(r.official.last_synced_at).getTime() === new Date(e.m).getTime() || JSON.stringify([r.official.last_synced_at, e.m]);
  });
  await check('dash_finance: payables by currency (open / overdue amounts, counts) per supplier-invoice branch', async () => {
    const a = await R.dfin('adminA'), j = await R.dfin('accJ');
    const pa = a.payables.by_currency.SAR, pj = j.payables.by_currency.SAR;
    return (cents(pa.open_amount) === cents(1150 + 400) && cents(pa.overdue_amount) === 115000 && pa.open_count === 2 && pa.overdue_count === 1
            && a.payables.due_7d_count === 1 && cents(pj.open_amount) === 115000 && pj.open_count === 1 && j.payables.due_7d_count === 0)
      || JSON.stringify({ pa, pj });
  });
  await check('dash_finance: supplier invoices by status / needs_review; billing intents / sync / review / connection', async () => {
    const r = await R.dfin('adminA'), j = await R.dfin('accJ');
    return (r.supplier_invoices.by_status.approved === 2 && r.supplier_invoices.by_status.received === 1 && r.supplier_invoices.needs_review === 1
            && j.supplier_invoices.by_status.approved === 1 && r.billing.intents_by_status.issued === 3 && r.billing.intents_by_status.draft === 1
            && r.billing.intents_by_status.open === 1 && r.billing.sync.pending === 1 && r.billing.review_open === 1
            && r.billing.connection.status === 'not_connected' && r.billing.connection.mode === 'mock' && j.billing.intents_by_status.open === 0)
      || JSON.stringify({ si: r.supplier_invoices, b: r.billing });
  });
  await check('dash_finance: costs counts = superuser predicates (accruals open from trips)', async () => {
    const r = await R.dfin('adminA');
    const e = await one(`SELECT (SELECT count(*)::int FROM public.cost_accruals WHERE org_id = $1 AND status = 'open') ao,
                                (SELECT count(*)::int FROM public.cost_adjustments WHERE org_id = $1 AND status = 'proposed') ap`, [A]);
    return (r.costs.accruals_open === e.ao && r.costs.adjustments_pending === e.ap && Number.isInteger(r.costs.review_queue)) || JSON.stringify({ c: r.costs, e });
  });
  await check('dash_finance: currency filter USD → only USD (the USD invoice is cancelled in Daftra → reported apart) / no payables', async () => {
    const r = await R.dfin('adminA', { currency: 'USD' });
    const c = r.official.cancelled_pending_review.by_currency;
    return (Object.keys(r.official.by_currency).length === 0 && Object.keys(c).join() === 'USD' && c.USD.count === 1 && cents(c.USD.total) === 10000
            && Object.keys(r.payables.by_currency).length === 0) || JSON.stringify(r.official);
  });
  await check('dash_finance: financial_status counts of the scoped transactions', async () => {
    const r = await R.dfin('accJ');
    const n = Object.values(r.financial_status).reduce((s, v) => s + v, 0);
    return n === (await count(`SELECT count(*)::int n FROM public.transactions WHERE org_id = $1 AND branch_id = $2`, [A, JED])) || String(n);
  });

  // dash_management
  await check('dash_management (admin): period = current Riyadh month; transactions / containers / alerts = superuser counts', async () => {
    const r = await R.dmgmt('adminA');
    const e = await one(`SELECT date_trunc('month', app.rpt_today())::date::text f,
        (date_trunc('month', app.rpt_today()) + interval '1 month - 1 day')::date::text t,
        (SELECT count(*)::int FROM public.transactions WHERE org_id = $1 AND date_trunc('month', (created_at AT TIME ZONE 'Asia/Riyadh')) = date_trunc('month', app.rpt_today())) created,
        (SELECT count(*)::int FROM public.transactions WHERE org_id = $1 AND operational_status IN ('new','in_progress','customs_declaration','appointment','transport','empty_return')) open_now,
        (SELECT count(*)::int FROM public.containers c WHERE c.org_id = $1 AND c.return_status IN ('pending','evidence_submitted','disputed') AND c.return_deadline < app.rpt_today()) ov,
        (SELECT count(*)::int FROM public.operational_alerts WHERE org_id = $1 AND status IN ('open','acknowledged') AND severity = 'critical') crit`, [A]);
    return (r.period.from === e.f && r.period.to === e.t && r.transactions.created === e.created && r.transactions.open_now === e.open_now
            && r.transactions.completed === 1 && Number(r.transactions.avg_cycle_days) >= 3.9 && Number(r.transactions.avg_cycle_days) <= 4.1
            && r.containers.overdue_now === e.ov && r.alerts_critical_now === e.crit) || JSON.stringify({ r: r.transactions, p: r.period, e });
  });
  await check('dash_management: by_branch only branches in scope (bmJ: JED only; admin: JED + DMM)', async () => {
    const a = await R.dmgmt('adminA'), b = await R.dmgmt('bmJ');
    const sumOpen = a.by_branch.reduce((s, x) => s + x.open_now, 0);
    return (a.by_branch.length === 2 && b.by_branch.length === 1 && b.by_branch[0].branch_id === JED && sumOpen === a.transactions.open_now
            && b.transactions.open_now === b.by_branch[0].open_now) || JSON.stringify({ a: a.by_branch, b: b.by_branch });
  });
  await check('dash_management: finance block (all mgmt roles have fin_read): official in period, payables overdue, margin link', async () => {
    const a = await R.dmgmt('adminA'), b = await R.dmgmt('bmJ');
    return (a.finance && cents(a.finance.payables_overdue_by_currency.SAR) === 115000 && a.finance.margin_link === '#margins'
            && b.finance && keysDeep(b.finance).every(k => !/margin_confirmed|cost/.test(k))) || JSON.stringify([a.finance, b.finance]);
  });
  await check('dash_management: explicit period without data → zero counts; avg null', async () => {
    const r = await R.dmgmt('adminA', { from: '2025-01-01', to: '2025-01-31' });
    return (r.transactions.created === 0 && r.transactions.completed === 0 && r.transactions.avg_cycle_days === null
            && r.requests.received === 0 && Object.keys(r.finance.official_by_currency).length === 0) || JSON.stringify(r.transactions);
  });
  await check('dash_management: the period 2026-03-11 counts TX5 as created', async () => {
    const r = await R.dmgmt('adminA', { from: '2026-03-11', to: '2026-03-11' });
    return r.transactions.created === 1 || JSON.stringify(r.transactions);
  });
  await expectErr('dash_management: from > to → MRS_INVALID date_range', () => R.dmgmt('adminA', { from: '2026-02-02', to: '2026-02-01' }), /MRS_INVALID date_range/);
  await expectErr('dash_management: currency key → MRS_INVALID unknown_key', () => R.dmgmt('adminA', { currency: 'SAR' }), /MRS_INVALID unknown_key/);
}

async function secPortal() {
  section('2. portal: invoices (G6a-1) and "never others\' files, even with direct links"');
  const KEYS = ['id', 'transaction_id', 'transaction_ref', 'daftra_number', 'issued_at', 'currency', 'net', 'vat', 'total', 'payment_status',
    'paid_amount', 'remote_state'].sort();
  await check('portal_invoices (client A-c1): only ISSUED intents of own transactions (I1, I2), newest first', async () => {
    const r = await R.inv('cA1');
    return (JSON.stringify(r.items.map(x => x.id)) === JSON.stringify([I2, I1]) && r.count === 2) || JSON.stringify(r);
  });
  await check('portal_invoices: key set equality (no lines, no Marsa totals, no sync state, no conflicts, no costs)', async () => {
    const r = await R.inv('cA1');
    return r.items.every(x => JSON.stringify(Object.keys(x).sort()) === JSON.stringify(KEYS)) || JSON.stringify(Object.keys(r.items[0]));
  });
  await check('portal_invoices: Daftra-synced figures (net / vat / total / paid / payment status)', async () => {
    const r = await R.inv('cA1');
    const a = r.items.find(x => x.id === I1);
    return (a.daftra_number === 'INV-1001' && N(a.net) === 1000 && N(a.vat) === 150 && N(a.total) === 1150 && N(a.paid_amount) === 500
            && a.payment_status === 'partial' && a.currency === 'SAR' && a.transaction_ref === S['ref_' + TX1] && a.remote_state === 'issued') || JSON.stringify(a);
  });
  await check('portal_invoices: an open issued_cancelled review item → remote_state cancelled', async () => {
    const r = await R.inv('cA1');
    return r.items.find(x => x.id === I2).remote_state === 'cancelled' || 'state';
  });
  await check('portal_invoices: draft (I3), open (I4) and cancelled (I7) intents never appear for anyone', async () => {
    for (const who of CLIENTS) {
      const r = await R.inv(who);
      if (r.items.some(x => [I3, I4, I7].includes(x.id))) return who;
    }
    return true;
  });
  await check('portal_invoices(TX1) for its owner → only I1; client A-c2 → its own I5 only', async () => {
    const a = await R.inv('cA1', TX1), b = await R.inv('cA2');
    return (JSON.stringify(a.items.map(x => x.id)) === JSON.stringify([I1]) && JSON.stringify(b.items.map(x => x.id)) === JSON.stringify([I5])) || 'ids';
  });
  await expectErr('portal_invoices(A\'s tx) as client B of the same org → MRS_NOT_FOUND transaction', () => R.inv('cA2', TX1), /MRS_NOT_FOUND transaction/);
  await expectErr('portal_invoices(A\'s tx) as client C of another org → MRS_NOT_FOUND transaction', () => R.inv('cB1', TX1), /MRS_NOT_FOUND transaction/);
  await expectErr('portal_invoices(random uuid) → MRS_NOT_FOUND transaction (same answer as other org)', () => R.inv('cA1', id6(999)), /MRS_NOT_FOUND transaction/);
  await check('portal_invoices: client of org B sees only its own (I6)', async () => {
    const r = await R.inv('cB1');
    return JSON.stringify(r.items.map(x => x.id)) === JSON.stringify([I6]) || JSON.stringify(r);
  });
  await check('portal_invoices: staff user without client links → {items: [], count: 0}', async () => {
    for (const who of ['clrJ', 'adminA', 'accA']) {
      const r = await R.inv(who);
      if (r.items.length !== 0 || r.count !== 0) return who;
    }
    return true;
  });
  await expectErr('portal_invoices(tx) as staff (no client link) → MRS_NOT_FOUND', () => R.inv('adminA', TX1), /MRS_NOT_FOUND transaction/);
  await check('a deactivated client membership loses its invoices', async () => {
    await db.exec(`UPDATE public.memberships SET is_active = false WHERE user_id = '${U.cA2}' AND role = 'client'`);
    const r = await R.inv('cA2');
    await db.exec(`UPDATE public.memberships SET is_active = true WHERE user_id = '${U.cA2}' AND role = 'client'`);
    return r.count === 0 || JSON.stringify(r);
  });

  // direct-id reads (RLS) as client B (same org) and client C (other org)
  const dirs = [
    ['transaction by id', `SELECT id FROM public.transactions WHERE id = '${TX1}'`],
    ['containers of the transaction', `SELECT id FROM public.containers WHERE transaction_id = '${TX1}'`],
    ['client-visible document by id', `SELECT id FROM public.documents WHERE id = '${D_VIS}'`],
    ['internal document by id', `SELECT id FROM public.documents WHERE id = '${D_INT}'`],
    ['transaction_events of the transaction', `SELECT id FROM public.transaction_events WHERE transaction_id = '${TX1}'`],
    ['storage.objects row of the document path', `SELECT id FROM storage.objects WHERE name = '${A}/${TX1}/${D_VIS}/vis.pdf'`],
    ['customs declarations of the transaction', `SELECT id FROM public.customs_declarations WHERE transaction_id = '${TX1}'`],
    ['transaction_bls of A\'s TX4', `SELECT bl_id FROM public.transaction_bls WHERE transaction_id = '${TX4}'`],
    ['client record of A', `SELECT id FROM public.clients WHERE id = '${CL101}'`]
  ];
  for (const who of ['cA2', 'cB1']) {
    for (const [label, sql] of dirs) await check(`direct link as ${who}: ${label} → 0 rows`, async () => denied(who, sql));
  }
  await check('owner (A-c1): own transaction, containers, client-visible doc + its storage object are readable', async () => {
    const t = await as('cA1', `SELECT id FROM public.transactions WHERE id = $1`, [TX1]);
    const c = await as('cA1', `SELECT id FROM public.containers WHERE transaction_id = $1`, [TX1]);
    const d = await as('cA1', `SELECT id FROM public.documents WHERE id = $1`, [D_VIS]);
    const o = await as('cA1', `SELECT id FROM storage.objects WHERE name = $1`, [`${A}/${TX1}/${D_VIS}/vis.pdf`]);
    return (t.length === 1 && c.length === 2 && d.length === 1 && o.length === 1) || JSON.stringify([t.length, c.length, d.length, o.length]);
  });
  await check('owner (A-c1): INTERNAL and VOIDED documents → 0 rows, and their storage objects → 0 rows', async () => {
    const d = await as('cA1', `SELECT id FROM public.documents WHERE id = ANY ($1::uuid[])`, [[D_INT, D_VOID]]);
    const o = await as('cA1', `SELECT id FROM storage.objects WHERE name = ANY ($1::text[])`,
      [[`${A}/${TX1}/${D_INT}/int.pdf`, `${A}/${TX1}/${D_VOID}/void.pdf`]]);
    return (d.length === 0 && o.length === 0) || JSON.stringify([d.length, o.length]);
  });
  await check('owner (A-c1): only client-visible events (no internal note)', async () => {
    const e = await as('cA1', `SELECT visible_to_client v FROM public.transaction_events WHERE transaction_id = $1`, [TX1]);
    return (e.length > 0 && e.every(x => x.v)) || JSON.stringify(e);
  });
  await check('owner (A-c1): DMM transaction of the same client (TX5) is readable (client scope is not branch scope)', async () => {
    const t = await as('cA1', `SELECT id FROM public.transactions WHERE id = $1`, [TX5]);
    return t.length === 1;
  });
  await check('client A-c2 cannot read client 101 documents in another transaction either (D_A2 is its own)', async () => {
    const own = await as('cA2', `SELECT id FROM public.documents`);
    return (own.length === 1 && own[0].id === D_A2) || JSON.stringify(own);
  });
  for (const who of CLIENTS) {
    await check(`client ${who}: every G4 / G5 / G6a table → 0 rows`, async () => {
      for (const t of G4G5_TABLES) {
        const r = await denied(who, `SELECT 1 FROM public.${t}`);
        if (r !== true) return t + ': ' + r;
      }
      return true;
    });
    await check(`client ${who}: transactions.financial_status not selectable (column grant)`, async () => {
      const e = await tryErr(() => as(who, `SELECT financial_status FROM public.transactions`));
      return /permission denied/.test(e) || e;
    });
    for (const n of ORG_RPCS.concat(['log_report_export'])) {
      await expectErr(`client ${who}: ${n} → MRS_FORBIDDEN`, () => CALL[n](who, who === 'cB1' ? B : A), /MRS_FORBIDDEN/);
    }
  }
}

async function secExportLog() {
  section('5.4 export log: gate = report gate, filters, caps, append-only, visibility');
  const ok = async (who, p, org) => R.log(who, p, org);
  await check('admin: one valid log per report × format (18 rows), returns {id, created_at}', async () => {
    let n = 0;
    for (const report of ['search', 'transactions', 'containers', 'trips', 'margins', 'costs']) {
      for (const format of ['xlsx', 'csv', 'print']) {
        const r = await ok('adminA', { report, format, filters: {}, row_count: 3 });
        if (!/^[0-9a-f-]{36}$/.test(r.id) || !r.created_at) return JSON.stringify(r);
        n++;
      }
    }
    return n === 18;
  });
  await check('log stores exactly report, format, filters, row_count, actor (no data)', async () => {
    const f = { q: 'MSCU', branch_id: JED, operational_status: ['new', 'transport'], from: '2026-10-01', to: '2026-10-31' };
    const r = await ok('clrJ', { report: 'search', format: 'xlsx', filters: f, row_count: 42 });
    const row = await one(`SELECT * FROM public.report_exports WHERE id = $1`, [r.id]);
    return (row.actor === U.clrJ && row.org_id === A && row.report === 'search' && row.format === 'xlsx' && row.row_count === 42
            && JSON.stringify(sortKeys(row.filters)) === JSON.stringify(sortKeys(f))) || JSON.stringify(row);
  });
  await check('filters omitted → {}', async () => {
    const r = await ok('clrJ', { report: 'containers', format: 'csv', row_count: 0 });
    return JSON.stringify((await one(`SELECT filters FROM public.report_exports WHERE id = $1`, [r.id])).filters) === '{}';
  });
  await expectErr('clearance staff cannot log margins (finance gate) → MRS_FORBIDDEN finance', () => ok('clrJ', { report: 'margins', format: 'csv', row_count: 1 }), /MRS_FORBIDDEN finance/);
  await expectErr('operations manager cannot log costs → MRS_FORBIDDEN finance', () => ok('opsA', { report: 'costs', format: 'xlsx', row_count: 1 }), /MRS_FORBIDDEN finance/);
  await check('accountant may log margins / costs', async () => !!(await ok('accJ', { report: 'margins', format: 'xlsx', filters: { currency: 'SAR' }, row_count: 5 })).id);
  await expectErr('trips with include_finance by clearance staff → MRS_FORBIDDEN cost', () => ok('clrJ', { report: 'trips', format: 'csv', filters: { include_finance: true }, row_count: 1 }), /MRS_FORBIDDEN cost/);
  await check('trips with include_finance by operations manager → ok', async () => !!(await ok('opsA', { report: 'trips', format: 'csv', filters: { include_finance: true }, row_count: 1 })).id);
  await expectErr('org B admin logging for org A → MRS_FORBIDDEN organization', () => ok('adminB', { report: 'search', format: 'csv', row_count: 1 }), /MRS_FORBIDDEN organization/);
  for (const [label, p, re] of [
    ['unknown report → MRS_INVALID report', { report: 'payroll', format: 'csv', row_count: 1 }, /MRS_INVALID report/],
    ['missing report → MRS_INVALID report', { format: 'csv', row_count: 1 }, /MRS_INVALID report/],
    ['unknown format → MRS_INVALID format', { report: 'search', format: 'pdf', row_count: 1 }, /MRS_INVALID format/],
    ['unknown payload key → MRS_INVALID unknown_key', { report: 'search', format: 'csv', row_count: 1, rows: [] }, /MRS_INVALID unknown_key/],
    ['filter key not of the report (container key on search) → MRS_INVALID filters', { report: 'search', format: 'csv', row_count: 1, filters: { overdue: true } }, /MRS_INVALID filters/],
    ['limit / offset are not logged filters → MRS_INVALID filters', { report: 'search', format: 'csv', row_count: 1, filters: { limit: 500 } }, /MRS_INVALID filters/],
    ['filter value object → MRS_INVALID filters', { report: 'search', format: 'csv', row_count: 1, filters: { q: { a: 1 } } }, /MRS_INVALID filters/],
    ['filters not an object → MRS_INVALID filters', { report: 'search', format: 'csv', row_count: 1, filters: ['q'] }, /MRS_INVALID filters/],
    ['filter text of 81 chars → MRS_TOO_LONG filters', { report: 'search', format: 'csv', row_count: 1, filters: { q: 'x'.repeat(81) } }, /MRS_TOO_LONG filters/],
    ['filters above 4096 bytes → MRS_TOO_LONG filters', { report: 'search', format: 'csv', row_count: 1,
      filters: { operational_status: Array(20).fill('y'.repeat(80)), q: 'a', port: 'b', bl_number: 'c', container_no: 'd',
                 client_q: Array(20).fill('z'.repeat(80)), carrier_q: Array(20).fill('w'.repeat(80)) } }, /MRS_TOO_LONG filters/],
    ['array of non-strings → MRS_INVALID filters', { report: 'search', format: 'csv', row_count: 1, filters: { operational_status: [1, 2] } }, /MRS_INVALID filters/],
    ['row_count 10001 → MRS_INVALID export_rows', { report: 'search', format: 'xlsx', row_count: 10001 }, /MRS_INVALID export_rows/],
    ['row_count -1 → MRS_INVALID export_rows', { report: 'search', format: 'xlsx', row_count: -1 }, /MRS_INVALID export_rows/],
    ['row_count 1.5 → MRS_INVALID export_rows', { report: 'search', format: 'xlsx', row_count: 1.5 }, /MRS_INVALID export_rows/],
    ['row_count as string → MRS_INVALID export_rows', { report: 'search', format: 'xlsx', row_count: '5' }, /MRS_INVALID export_rows/],
    ['row_count missing → MRS_INVALID export_rows', { report: 'search', format: 'xlsx' }, /MRS_INVALID export_rows/],
    ['print with 2001 rows → MRS_INVALID export_rows', { report: 'transactions', format: 'print', row_count: 2001 }, /MRS_INVALID export_rows/]]) {
    await expectErr('log_report_export: ' + label, () => ok('adminA', p), re);
  }
  await check('caps: print 2000 and xlsx 10000 are accepted', async () => {
    const a = await ok('adminA', { report: 'transactions', format: 'print', row_count: 2000 });
    const b = await ok('adminA', { report: 'containers', format: 'xlsx', row_count: 10000 });
    return !!(a.id && b.id);
  });
  await check('margins filters = margin_report keys; costs filters = cost_report keys', async () => {
    const a = await ok('mgrA', { report: 'margins', format: 'csv', row_count: 1, filters: { level: 'confirmed', branch_id: JED } });
    const b = await ok('mgrA', { report: 'costs', format: 'csv', row_count: 1, filters: { group_by: 'supplier', include_overhead: false } });
    const e = await tryErr(() => ok('mgrA', { report: 'margins', format: 'csv', row_count: 1, filters: { group_by: 'client' } }));
    return (a.id && b.id && /MRS_INVALID filters/.test(e)) || e;
  });
  await expectErr('direct INSERT by authenticated → permission denied', () => as('adminA',
    `INSERT INTO public.report_exports (org_id, actor, report, format, row_count) VALUES ($1, $2, 'search', 'csv', 1)`, [A, U.adminA]), /permission denied/);
  await expectErr('UPDATE by authenticated → permission denied', () => as('adminA', `UPDATE public.report_exports SET row_count = 0`), /permission denied/);
  await expectErr('DELETE by authenticated → permission denied', () => as('adminA', `DELETE FROM public.report_exports`), /permission denied/);
  await expectErr('UPDATE as superuser → MRS_APPEND_ONLY (trigger)', () => q(`UPDATE public.report_exports SET row_count = 0`), /MRS_APPEND_ONLY/);
  await expectErr('DELETE as superuser → MRS_APPEND_ONLY (trigger)', () => q(`DELETE FROM public.report_exports`), /MRS_APPEND_ONLY/);
  await expectErr('TRUNCATE as superuser → MRS_APPEND_ONLY', () => q(`TRUNCATE public.report_exports`), /MRS_APPEND_ONLY/);
  await check('visibility (table): clearance staff sees only own rows; supervisor / admin all org rows; other org none', async () => {
    const own = await as('clrJ', `SELECT actor FROM public.report_exports`);
    const sup = await as('supA', `SELECT actor FROM public.report_exports WHERE org_id = $1`, [A]);
    const all = await count(`SELECT count(*)::int n FROM public.report_exports WHERE org_id = $1`, [A]);
    const b = await as('adminB', `SELECT 1 FROM public.report_exports`);
    return (own.length === 2 && own.every(x => x.actor === U.clrJ) && sup.length === all && b.length === 0) || JSON.stringify([own.length, sup.length, all, b.length]);
  });
  await check('list_report_exports: non-auditor own rows; auditor all + actor names; actor filter for someone else → 0', async () => {
    const own = await R.logs('clrJ'), sup = await R.logs('supA', { limit: 200 }), x = await R.logs('clrJ', { actor: U.adminA });
    const all = await count(`SELECT count(*)::int n FROM public.report_exports WHERE org_id = $1`, [A]);
    const adm = await R.logs('adminA', { actor: U.clrJ });
    return (own.total === 2 && own.items.every(i => i.actor === U.clrJ) && own.all === false && sup.total === all && sup.all === true
            && x.total === 0 && adm.total === 2 && adm.items[0].actor_name === 'clrj'
            && JSON.stringify(Object.keys(own.items[0]).sort()) === JSON.stringify(['actor', 'actor_name', 'created_at', 'filters', 'format', 'id', 'report', 'row_count']))
      || JSON.stringify({ own: own.total, sup: sup.total, all, x: x.total, adm: adm.total });
  });
  await check('list_report_exports: report filter, date range (Riyadh today), paging (≤ 200, default 50)', async () => {
    const t = (await one(`SELECT app.rpt_today()::text d`)).d;
    const a = await R.logs('adminA', { report: 'margins' }), b = await R.logs('adminA', { from: t, to: t }), c = await R.logs('adminA');
    const e = await tryErr(() => R.logs('adminA', { limit: 201 }));
    return (a.items.every(i => i.report === 'margins') && a.total >= 4 && b.total === c.total && c.limit === 50 && /MRS_INVALID limit/.test(e)) || JSON.stringify([a.total, b.total, c.total, e]);
  });
  await expectErr('list_report_exports: org B admin on org A → MRS_FORBIDDEN', () => R.logs('adminB'), /MRS_FORBIDDEN organization/);
  await check('list_report_exports: org B admin on its own org → 0 rows', async () => (await R.logs('adminB', {}, B)).total === 0);
}

async function secNoWrites() {
  section('readers write nothing');
  const tables = (await q(`SELECT c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'report_exports' ORDER BY 1`)).map(x => x.t);
  const snap = async () => {
    const o = {};
    for (const t of tables) o[t] = await count(`SELECT count(*)::int n FROM public.${t}`);
    o.max_tx_updated = (await one(`SELECT max(updated_at)::text m FROM public.transactions`)).m;
    o.exports = await count(`SELECT count(*)::int n FROM public.report_exports`);
    return o;
  };
  const before = await snap();
  for (const who of STAFF.concat(CLIENTS)) {
    for (const n of ORG_RPCS) { try { await CALL[n](who); } catch (e) { /* forbidden is fine */ } }
    try { await R.inv(who); await R.inv(who, TX1); } catch (e) { /* not found is fine */ }
    try { await R.rtrip(who, { include_finance: true }); } catch (e) { /* forbidden is fine */ }
    try { await R.search(who, { q: 'MSCU', container_no: 'MSCU', carrier_q: 'x', port: 'y' }); } catch (e) { /* forbidden is fine */ }
  }
  const after = await snap();
  await check('after every reader for every role: row counts of every pre-G6a table, transactions.updated_at and report_exports unchanged', async () =>
    JSON.stringify(before) === JSON.stringify(after) || JSON.stringify(Object.keys(before).filter(k => before[k] !== after[k])));
}

/* ------------------------------------------------------------------ migration safety */
/* ------------------------------------------------------------------ review fixes (regressions) */
// error inside an open transaction without aborting it: superuser statement, or (who given) as that API user
async function errInTx(fn) {
  await db.exec('SAVEPOINT g6a_sp');
  try { await fn(); await db.exec('RELEASE SAVEPOINT g6a_sp'); return 'ok'; }
  catch (e) { await db.exec('ROLLBACK TO SAVEPOINT g6a_sp; RELEASE SAVEPOINT g6a_sp'); return errText(e); }
}
async function errInTxAs(who, sql, params) {
  await db.exec('SAVEPOINT g6a_sp');
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  let out = 'ok';
  try { await db.query(sql, params || []); } catch (e) { out = errText(e); }
  await db.exec(out === 'ok' ? 'RELEASE SAVEPOINT g6a_sp' : 'ROLLBACK TO SAVEPOINT g6a_sp; RELEASE SAVEPOINT g6a_sp');
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`);
  return out;
}
// superuser query with the caller's JWT claims (auth.uid() = who) — for revoked app.* helpers
async function withClaims(who, fn) {
  await db.exec(`SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  try { return await fn(); } finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false);`); }
}
async function secReviewFixes() {
  section('review fixes: bill-to ownership, credit notes, Daftra-cancelled, container / Arabic-digit input, trip links, ranges, scope, dates');

  // 1. portal_invoices follows the invoice's bill-to client, not the transaction's current client
  await db.exec('BEGIN');
  try {
    await check('setup: ops manager moves TX1 (issued INV-1001 billed to client 101) to client 102 through RLS', async () => {
      const r = await as('opsA', `UPDATE public.transactions SET client_id = $1 WHERE id = $2 RETURNING id`, [CL102, TX1]);
      const i = await one(`SELECT client_id FROM public.billing_intents WHERE id = $1`, [I1]);
      return (r.length === 1 && i.client_id === CL101) || JSON.stringify({ r, i });
    });
    await check('after the move: client 102 sees none of client 101\'s invoices (list)', async () => {
      const r = await R.inv('cA2');
      return (JSON.stringify(r.items.map(x => x.daftra_number)) === JSON.stringify(['INV-2001'])) || JSON.stringify(r.items.map(x => x.daftra_number));
    });
    await check('after the move: client 102 portal_invoices(TX1) → no item (the tx is now his, the invoice is not)', async () => {
      const r = await R.inv('cA2', TX1);
      return (r.count === 0 && r.items.length === 0) || JSON.stringify(r);
    });
    await check('after the move: client 101 still sees INV-1001 and INV-1002; portal_invoices(TX1) → INV-1001 only', async () => {
      const a = await R.inv('cA1'), b = await R.inv('cA1', TX1);
      return (JSON.stringify(a.items.map(x => x.id)) === JSON.stringify([I2, I1]) && JSON.stringify(b.items.map(x => x.id)) === JSON.stringify([I1]))
        || JSON.stringify([a.items.map(x => x.daftra_number), b.items.map(x => x.daftra_number)]);
    });
    await check('after the move: other org client portal_invoices(TX1) → MRS_NOT_FOUND', async () =>
      /MRS_NOT_FOUND/.test(await errInTxAs('cB1', `SELECT public.portal_invoices($1)`, [TX1])));
  } finally { await db.exec('ROLLBACK'); }

  // 2. payables = G4 payable (total − approved credit notes) − paid
  await db.exec('BEGIN');
  try {
    await db.exec(`INSERT INTO public.supplier_invoices (org_id, branch_id, supplier_id, invoice_number, number_norm, invoice_date, due_date, currency,
                     subtotal, vat_amount, total_amount, status, company_paid_amount, payment_status, doc_type, adjusts_invoice_id)
                   VALUES ('${A}', '${JED}', '${P_SUP}', 'CN-1', 'CN1', app.rpt_today() - 4, app.rpt_today() - 4, 'SAR', 130.43, 19.57, 150,
                           'approved', 0, 'unpaid', 'credit_note', '${SI1}')`);
    await check('approved 150 credit note on SI1 (1150): dash_finance payables SAR = 1400 open / 1000 overdue = G4 payable − paid', async () => {
      const r = (await R.dfin('adminA')).payables.by_currency.SAR;
      const e = await one(`SELECT sum(greatest(app.fin_invoice_payable(si.id) - si.company_paid_amount - si.client_paid_amount, 0)) o,
                                  sum(greatest(app.fin_invoice_payable(si.id) - si.company_paid_amount - si.client_paid_amount, 0))
                                    FILTER (WHERE si.due_date < app.rpt_today()) ov
                             FROM public.supplier_invoices si WHERE si.org_id = $1 AND si.status = 'approved' AND si.doc_type <> 'credit_note'
                              AND si.payment_status IN ('unpaid','partial') AND si.currency = 'SAR'`, [A]);
      return (cents(r.open_amount) === 140000 && cents(r.overdue_amount) === 100000 && cents(r.open_amount) === cents(e.o)
              && cents(r.overdue_amount) === cents(e.ov)) || JSON.stringify({ r, e });
    });
    await check('credit note: dash_management payables_overdue SAR = 1000 (not the gross 1150)', async () => {
      const r = await R.dmgmt('adminA');
      return cents(r.finance.payables_overdue_by_currency.SAR) === 100000 || JSON.stringify(r.finance.payables_overdue_by_currency);
    });
  } finally { await db.exec('ROLLBACK'); }

  // 3. official figures leave out issued invoices Daftra cancelled (open issued_cancelled review item)
  const P5 = await one(`SELECT (app.rpt_today() - 5)::text f, app.rpt_today()::text t`);
  await check('dash_management: the Daftra-cancelled USD invoice is not official; reported in cancelled_pending_review_by_currency', async () => {
    const r = await R.dmgmt('adminA', { from: P5.f, to: P5.t });
    const c = r.finance.cancelled_pending_review_by_currency;
    return (!r.finance.official_by_currency.USD && c.USD && c.USD.count === 1 && cents(c.USD.total) === 10000) || JSON.stringify(r.finance);
  });
  await db.exec('BEGIN');
  try {
    await db.exec(`UPDATE public.billing_review_items SET status = 'dismissed', resolution = 'dismiss', resolved_at = now() WHERE intent_id = '${I2}'`);
    await check('after "dismiss": the invoice counts as official again (dash_finance + dash_management); portal shows it issued', async () => {
      const f = await R.dfin('adminA'), m = await R.dmgmt('adminA', { from: P5.f, to: P5.t }), p = await R.inv('cA1');
      const pi = p.items.find(x => x.id === I2);
      return (f.official.by_currency.USD && f.official.by_currency.USD.issued_count === 1 && !f.official.cancelled_pending_review.by_currency.USD
              && m.finance.official_by_currency.USD && m.finance.official_by_currency.USD.issued_count === 1 && pi && pi.remote_state === 'issued')
        || JSON.stringify({ f: f.official, m: m.finance, pi });
    });
    const rel = await errInTx(() => db.exec(`UPDATE public.billing_intents SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'release' WHERE id = '${I2}'`));
    await check('after "release_charges" (intent → cancelled): neither official nor pending review nor in the portal', async () => {
      if (rel !== 'ok') return 'setup failed: ' + rel;
      const f = await R.dfin('adminA'), p = await R.inv('cA1');
      return (!f.official.by_currency.USD && !f.official.cancelled_pending_review.by_currency.USD && !p.items.some(x => x.id === I2))
        || JSON.stringify({ f: f.official, p: p.items.map(x => x.id) });
    });
  } finally { await db.exec('ROLLBACK'); }

  // 4. container numbers typed with hyphens (ISO "MSCU 123456-7")
  for (const v of ['MSCU-1234567', 'MSCU 123456-7', 'mscu 123456-7']) {
    await check(`container_no "${v}": search / report_transactions / report_containers find MSCU1234567 (TX4)`, async () => {
      const s1 = await R.search('adminA', { container_no: v }), s2 = await R.search('adminA', { q: v }), r = await R.rtx('adminA', { container_no: v });
      const c = await R.rcont('adminA', { container_no: v });
      const chip = (s2.items[0] && s2.items[0].matched || []).some(x => x.field === 'container_no' && x.value === 'MSCU1234567');
      return (same(ids(s1), [TX4]) && same(ids(s2), [TX4]) && same(ids(r), [TX4]) && same(ids(c), [C4A]) && chip)
        || JSON.stringify([ids(s1), ids(s2), ids(r), ids(c), s2.items[0] && s2.items[0].matched]);
    });
  }
  await check('B/L and declaration numbers keep their hyphen rule (rpt_norm_no unchanged: "BLX-777" finds nothing)', async () =>
    (await R.search('adminA', { bl_number: 'BLX-777' })).total === 0);

  // 5. Arabic-Indic digits in free text (CR / VAT)
  await check('q / client_q in Arabic-Indic digits (VAT ٣٠٠٠٠٠٠٠) = the western query; "client" chip present', async () => {
    const w = await R.search('adminA', { q: '30000000', limit: 100 }), a = await R.search('adminA', { q: '٣٠٠٠٠٠٠٠', limit: 100 });
    const cw = await R.search('adminA', { client_q: '30000000', limit: 100 }), ca = await R.search('adminA', { client_q: '٣٠٠٠٠٠٠٠', limit: 100 });
    const chip = a.items.length && a.items.every(x => (x.matched || []).some(m => m.field === 'client'));
    return (w.total > 0 && same(ids(w), ids(a)) && w.total === a.total && cw.total > 0 && same(ids(cw), ids(ca)) && chip)
      || JSON.stringify({ w: w.total, a: a.total, cw: cw.total, ca: ca.total, chip });
  });
  await check('client CR in Arabic-Indic digits (٧٠٠٠٠٠٠٠٠١) → client 101 transactions only', async () => {
    const a = await R.search('adminA', { client_q: '٧٠٠٠٠٠٠٠٠١', limit: 100 });
    const e = await q(`SELECT id FROM public.transactions WHERE org_id = $1 AND client_id = $2`, [A, CL101]);
    return same(ids(a), e.map(x => x.id)) || JSON.stringify([a.total, e.length]);
  });

  // 6. trip tiles: report_trips reproduces dash_ops today_planned / late (with the branch filter)
  await db.exec('BEGIN');
  try {
    await db.exec(`INSERT INTO public.transport_trips (org_id, transaction_id, leg_no, origin, destination, planned_at, status)
                   VALUES ('${A}', '${TX4}', 7, 'أ', 'ب', (app.rpt_today()::timestamp + interval '23 hours 59 minutes') AT TIME ZONE 'Asia/Riyadh', 'planned'),
                          ('${A}', '${TX5}', 7, 'أ', 'ب', (app.rpt_today()::timestamp + interval '1 minute') AT TIME ZONE 'Asia/Riyadh', 'dispatched')`);
    const today = (await one(`SELECT app.rpt_today()::text d`)).d;
    for (const [who, f] of [['adminA', {}], ['adminA', { branch_id: JED }], ['adminA', { branch_id: DMM }], ['clrJ', {}], ['trJ', {}]]) {
      await check(`trip tiles (${who} ${f.branch_id === JED ? 'JED' : f.branch_id === DMM ? 'DMM' : 'all'}): today_planned / late = report_trips totals of the tile links`, async () => {
        const d = (await R.dops(who, f)).transport;
        const tp = await R.rtrip(who, Object.assign({ from: today, to: today, status: ['planned', 'dispatched', 'loaded', 'delivered'] }, f));
        const lt = await R.rtrip(who, Object.assign({ late: true }, f));
        return (d.today_planned === tp.total && d.late === lt.total && (who !== 'adminA' || !!f.branch_id || d.today_planned === 2))
          || JSON.stringify({ d: [d.today_planned, d.late], r: [tp.total, lt.total] });
      });
    }
    await check('report_trips late: only planned / dispatched with planned_at past', async () => {
      const r = await R.rtrip('adminA', { late: true, limit: 500 });
      return r.items.every(x => ['planned', 'dispatched'].includes(x.status) && new Date(x.planned_at) < new Date()) && r.late === true;
    });
    await check('report_trips late = "false" / absent → no late filter', async () =>
      (await R.rtrip('adminA', { late: 'false' })).total === (await R.rtrip('adminA', {})).total);
    await check('late is an export filter key (log_report_export trips {late:true})', async () =>
      /^ok$/.test(await errInTxAs('trJ', `SELECT public.log_report_export($1, $2)`, [A, { report: 'trips', format: 'csv', filters: { late: true }, row_count: 1 }])));
    await check('late: object value → MRS_INVALID late', async () => /MRS_INVALID late/.test(await errInTxAs('adminA', `SELECT public.report_trips($1, $2)`, [A, { late: {} }])));
  } finally { await db.exec('ROLLBACK'); }

  // 7. dash_management: one bound alone defaults the other to that bound's month
  const M = await one(`SELECT (date_trunc('month', app.rpt_today()) - interval '1 day')::date::text prev_end,
                              (date_trunc('month', app.rpt_today()) - interval '1 month')::date::text prev_start,
                              (date_trunc('month', app.rpt_today()) + interval '2 month')::date::text next2_start,
                              (date_trunc('month', app.rpt_today()) + interval '3 month - 1 day')::date::text next2_end`);
  await check('dash_management {to: last day of the previous month} alone → period = that month (no date_range error)', async () => {
    const r = await R.dmgmt('adminA', { to: M.prev_end });
    return (r.period.from === M.prev_start && r.period.to === M.prev_end) || JSON.stringify(r.period);
  });
  await check('dash_management {from: a date after the current month} alone → period ends at that month\'s end', async () => {
    const r = await R.dmgmt('adminA', { from: M.next2_start });
    return (r.period.from === M.next2_start && r.period.to === M.next2_end) || JSON.stringify(r.period);
  });
  await check('dash_management {from: 2026-03-11} alone → to 2026-03-31, TX5 created in it', async () => {
    const r = await R.dmgmt('adminA', { from: '2026-03-11' });
    return (r.period.to === '2026-03-31' && r.transactions.created === 1) || JSON.stringify([r.period, r.transactions]);
  });

  // 8. rpt_scope (computed once per call) = has_branch_role per row, incl. inactive branch / membership / org
  const ROLESETS = ['staff_roles', 'fin_read_roles', 'mgmt_roles', 'trip_finance_roles', 'ops_writer_roles'];
  const scopeSame = async () => {
    for (const who of STAFF.concat(CLIENTS, ['adminB'])) {
      const r = await withClaims(who, () => q(`SELECT rs, count(*)::int n FROM unnest($1::text[]) rs
          CROSS JOIN LATERAL (SELECT CASE rs WHEN 'staff_roles' THEN app.staff_roles() WHEN 'fin_read_roles' THEN app.fin_read_roles()
                                     WHEN 'mgmt_roles' THEN app.mgmt_roles() WHEN 'trip_finance_roles' THEN app.trip_finance_roles()
                                     ELSE app.ops_writer_roles() END roles) x
          CROSS JOIN LATERAL (SELECT o.id org, app.rpt_scope(o.id, x.roles) sc FROM public.organizations o) s
          JOIN public.transactions t ON t.org_id = s.org
         WHERE (s.sc IS NULL OR t.branch_id = ANY (s.sc)) IS DISTINCT FROM app.has_branch_role(t.org_id, t.branch_id, x.roles)
         GROUP BY 1`, [ROLESETS]));
      if (r.length) return who + ': ' + JSON.stringify(r);
    }
    return true;
  };
  await check('rpt_scope = has_branch_role for every user × role set × transaction (both orgs)', scopeSame);
  await db.exec('BEGIN');
  try {
    await db.exec(`UPDATE public.branches SET is_active = false WHERE id = '${DMM}';
                   UPDATE public.memberships SET is_active = false WHERE user_id = '${U.accJ}';
                   UPDATE public.organizations SET is_active = false WHERE id = '${B}';`);
    await check('rpt_scope = has_branch_role with an inactive branch, an inactive membership and an inactive org', scopeSame);
  } finally { await db.exec('ROLLBACK'); }

  // 9. sargable date bounds = the Riyadh-day rule (rpt_in(rpt_day(col))) around Riyadh midnight
  const RANGES = [['2026-03-10', '2026-03-10'], ['2026-03-11', '2026-03-11'], ['2026-03-12', '2026-03-12'], [null, '2026-03-11'], ['2026-03-11', null],
    ['2026-03-11', '2026-03-12']];
  for (const df of ['created', 'status_changed']) {
    const col = df === 'created' ? 'created_at' : 'status_changed_at';
    await check(`date_field ${df}: report_transactions = superuser rpt_in(rpt_day(${col})) for ${RANGES.length} ranges around 21:00Z`, async () => {
      for (const [f0, t0] of RANGES) {
        const flt = { date_field: df, limit: 500 }; if (f0) flt.from = f0; if (t0) flt.to = t0;
        const r = await R.rtx('adminA', flt);
        const e = await q(`SELECT id FROM public.transactions WHERE org_id = $1 AND app.rpt_in(app.rpt_day(${col}), $2::date, $3::date)`, [A, f0, t0]);
        if (!same(ids(r), e.map(x => x.id))) return JSON.stringify({ f0, t0, got: r.total, want: e.length });
      }
      return true;
    });
  }
  await check('report_trips / report_containers / list_report_exports date bounds = the Riyadh-day rule (today, yesterday, tomorrow)', async () => {
    const d = await one(`SELECT (app.rpt_today() - 1)::text y, app.rpt_today()::text t, (app.rpt_today() + 1)::text m`);
    for (const day of [d.y, d.t, d.m]) {
      const tr = await R.rtrip('adminA', { from: day, to: day, limit: 500 });
      const te = await q(`SELECT id FROM public.transport_trips WHERE org_id = $1 AND app.rpt_in(app.rpt_day(planned_at), $2::date, $2::date)`, [A, day]);
      const cr = await R.rcont('adminA', { date_field: 'created', from: day, to: day, limit: 500 });
      const ce = await q(`SELECT id FROM public.containers WHERE org_id = $1 AND app.rpt_in(app.rpt_day(created_at), $2::date, $2::date)`, [A, day]);
      const lr = await R.logs('adminA', { from: day, to: day, limit: 200 });
      const le = await q(`SELECT id FROM public.report_exports WHERE org_id = $1 AND app.rpt_in(app.rpt_day(created_at), $2::date, $2::date)`, [A, day]);
      if (!same(ids(tr), te.map(x => x.id)) || !same(ids(cr), ce.map(x => x.id)) || lr.total !== le.length)
        return JSON.stringify({ day, tr: [tr.total, te.length], cr: [cr.total, ce.length], lr: [lr.total, le.length] });
    }
    return true;
  });

  // 10. source guards
  await check('source: readers no longer call has_branch_role per row on the scanned set; no rpt_in(rpt_day()) range on a timestamp column', async () => {
    const src = fs.readFileSync(path.join(SUPA, 'migrations', MIG_G6A), 'utf8').replace(/--.*$/gm, '');
    const perRow = (src.match(/has_branch_role\(/g) || []).length;  // only rpt_tx_json (page rows)
    return (perRow === 1 && !/rpt_in\(app\.rpt_day\(/.test(src) && !/rpt_mgmt_rows\(p_org/.test(src)) || JSON.stringify({ perRow });
  });
  await check('source: transaction-local lock_timeout guard before the first DDL', async () => {
    const src = fs.readFileSync(path.join(SUPA, 'migrations', MIG_G6A), 'utf8');
    const i = src.indexOf("set_config('lock_timeout', '5s', true)"), j = src.search(/^CREATE /m);
    return i > 0 && i < j;
  });
  await check('app.rpt_mgmt_rows dropped (replaced by period-bounded queries)', async () =>
    (await count(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'rpt_mgmt_rows'`)) === 0);
}

async function loadUpTo(dbx, stopBefore) {
  const migDir = path.join(SUPA, 'migrations');
  await dbx.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const m of fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    if (stopBefore && m >= stopBefore) break;
    await dbx.exec(fs.readFileSync(path.join(migDir, m), 'utf8'));
  }
  await dbx.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
}
async function catalogSnap() {
  return {
    funcs: (await q(`SELECT p.oid::regprocedure::text s, md5(pg_get_functiondef(p.oid)) d, coalesce(p.proacl::text, '') acl
                       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname IN ('app','public') AND p.prokind = 'f' ORDER BY 1`)),
    policies: (await q(`SELECT schemaname || '.' || tablename || '.' || policyname k, md5(coalesce(qual, '') || '|' || coalesce(with_check, '') || '|' || cmd || '|' || array_to_string(roles, ',')) d
                          FROM pg_policies ORDER BY 1`)),
    columns: (await q(`SELECT table_name || '.' || column_name c FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name IN ('transactions','clients','service_requests','transport_trips','containers','billing_intents')
                        ORDER BY 1`)).map(x => x.c),
    colgrants: (await q(`SELECT table_name || '.' || column_name || '.' || privilege_type c FROM information_schema.column_privileges
                          WHERE grantee = 'authenticated' AND table_schema = 'public'
                            AND table_name IN ('transactions','clients','service_requests','transport_trips') ORDER BY 1`)).map(x => x.c)
  };
}
async function secMigrationSafety() {
  section('migration: preflight, applies on a G2–G5 database with data, twice; catalog diff; trigram branch');
  const saved = db;
  const g6a = fs.readFileSync(path.join(SUPA, 'migrations', MIG_G6A), 'utf8');

  db = new PGlite();
  try {
    await loadUpTo(db, MIG_G6A);
    await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261105000100'`);
    await check('preflight: without the G5 row the file stops with "G6a preflight: apply G5 first" and applies nothing', async () => {
      let err = '';
      try { await db.exec(g6a); } catch (e) { err = errText(e); }
      const left = await one(`SELECT to_regclass('public.report_exports') IS NULL AS none,
                                     NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261106000100') AS nover,
                                     to_regprocedure('public.search_records(uuid, jsonb)') IS NULL AS nofn`);
      return (/G6a preflight: apply G5 first \(schema_versions lacks 20261105000100 g5_daftra\)/.test(err) && left.none && left.nover && left.nofn)
        || JSON.stringify({ err, left });
    });
  } catch (e) { fail('migration safety (preflight)', errText(e)); }
  finally { try { await db.close(); } catch (e) { /* ignore */ } }

  db = new PGlite();
  try {
    await loadUpTo(db, MIG_G6A);
    // live-like G2–G5 rows
    await db.exec(`
      INSERT INTO public.client_charges (org_id, transaction_id, kind, description, unit_price, status) VALUES
        ('${A}', '${TX1}', 'service', 'قديم', 100, 'approved');
      INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose, purpose_key, currency, operational_ref, status, remote_total, issued_at)
        VALUES ('${A}', '${TX1}', '${CL101}', 'final', 'F', 'SAR', 'LIVE-1', 'issued', 10, now());
      INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no, status) VALUES ('${A}', '${TX2}', 'LIVEDEC1', 'submitted');`);
    const before = await catalogSnap();
    const rows = async () => {
      const o = {};
      for (const t of ['transactions', 'containers', 'clients', 'billing_intents', 'client_charges', 'customs_declarations', 'status_labels',
                       'schema_versions', 'audit_log', 'transaction_events']) o[t] = await count(`SELECT count(*)::int n FROM public.${t}`);
      o.policies = await count(`SELECT count(*)::int n FROM pg_policies`);
      o.triggers = await count(`SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal`);
      o.functions = await count(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public')`);
      o.indexes = await count(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname = 'public'`);
      return o;
    };
    const r0 = await rows();
    await check('G6a applies on a live-like G2–G5 database (charges, issued intent, declarations)', async () => { await db.exec(g6a); return true; });
    const r1 = await rows();
    const after = await catalogSnap();
    await check('apply: data rows unchanged (only status_labels + schema_versions grow)', async () => {
      const diff = Object.keys(r0).filter(k => r0[k] !== r1[k]);
      return (diff.sort().join() === 'functions,indexes,policies,schema_versions,status_labels,triggers' && r1.status_labels - r0.status_labels === 17
              && r1.schema_versions - r0.schema_versions === 1 && r1.policies - r0.policies === 1) || JSON.stringify({ diff, r0, r1 });
    });
    await check('catalog diff: no pre-G6a function body / ACL and no policy changed', async () => {
      const fa = Object.fromEntries(after.funcs.map(x => [x.s, x]));
      const changed = before.funcs.filter(x => !fa[x.s] || fa[x.s].d !== x.d || fa[x.s].acl !== x.acl).map(x => x.s);
      const pa = Object.fromEntries(after.policies.map(x => [x.k, x.d]));
      const pch = before.policies.filter(x => pa[x.k] !== x.d).map(x => x.k);
      return (changed.length === 0 && pch.length === 0) || JSON.stringify({ changed, pch });
    });
    await check('no new column on transactions / clients / service_requests / transport_trips / containers / billing_intents; column grants unchanged', async () =>
      (JSON.stringify(before.columns) === JSON.stringify(after.columns) && JSON.stringify(before.colgrants) === JSON.stringify(after.colgrants)) || 'columns changed');
    await check('re-run: the file applies again and changes no count (rows, policies, triggers, functions, indexes)', async () => {
      await db.exec(g6a);
      const r2 = await rows();
      return JSON.stringify(r1) === JSON.stringify(r2) || JSON.stringify({ r1, r2 });
    });
    await check('a third run after G6a data exists (an export row) still works and keeps it', async () => {
      await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${U.adminA}', 'x@g6a.example.com');
                     INSERT INTO public.profiles (id) VALUES ('${U.adminA}') ON CONFLICT DO NOTHING;
                     INSERT INTO public.memberships (user_id, org_id, role) VALUES ('${U.adminA}', '${A}', 'admin');`);
      await asRole('adminA', () => q(`SELECT public.log_report_export($1, '{"report":"search","format":"csv","row_count":1}') r`, [A]));
      await db.exec(g6a);
      return (await count(`SELECT count(*)::int n FROM public.report_exports`)) === 1;
    });
    await check('live-like data is readable through the new readers (issued intent official, declaration searchable)', async () => {
      const f = await asRole('adminA', () => q(`SELECT public.dash_finance($1, '{}') r`, [A]));
      const s = await asRole('adminA', () => q(`SELECT public.search_records($1, '{"declaration_no":"livedec1"}') r`, [A]));
      return (cents(f[0].r.official.by_currency.SAR.total) === 1000 && s[0].r.total === 1 && s[0].r.items[0].id === TX2) || JSON.stringify([f[0].r.official, s[0].r.total]);
    });
  } catch (e) { fail('migration safety (live-like)', errText(e)); }
  finally { try { await db.close(); } catch (e) { /* ignore */ } }

  // trigram branch: pg_trgm already installed (as on a Supabase project where the owner enabled it)
  let pgTrgm = null;
  try { pgTrgm = require('@electric-sql/pglite/contrib/pg_trgm').pg_trgm; } catch (e) { pgTrgm = null; }
  if (!pgTrgm) {
    await check('pg_trgm not available in this PGlite build → NOTICE path only (asserted in catalog section)', async () => true);
  } else {
    db = new PGlite({ extensions: { pg_trgm: pgTrgm } });
    try {
      await loadUpTo(db, MIG_G6A);
      await db.exec(`CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions;`);
      await db.exec(g6a);
      const TRGM = ['bills_of_lading_bl_number_trgm_idx', 'bills_of_lading_carrier_name_trgm_idx', 'containers_container_no_trgm_idx',
        'customs_declarations_declaration_no_trgm_idx', 'parties_name_ar_trgm_idx'];
      await check('pg_trgm installed (schema extensions): 5 GIN *_trgm_idx on the child-table columns, with extensions.gin_trgm_ops', async () => {
        const r = await q(`SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE '%\\_trgm\\_idx' ORDER BY indexname`);
        return (r.map(x => x.indexname).join() === TRGM.join() && r.every(x => /USING gin/.test(x.indexdef) && /extensions\.gin_trgm_ops/.test(x.indexdef)))
          || JSON.stringify(r.map(x => x.indexname));
      });
      await check('pg_trgm: a re-run drops trigram indexes an earlier build made on transactions / clients (unusable), keeps the 5', async () => {
        await db.exec(`CREATE INDEX transactions_ref_trgm_idx ON public.transactions USING gin (ref extensions.gin_trgm_ops);
                       CREATE INDEX clients_name_ar_trgm_idx ON public.clients USING gin (name_ar extensions.gin_trgm_ops);`);
        await db.exec(g6a);
        const r = await q(`SELECT indexname FROM pg_indexes WHERE indexname LIKE '%\\_trgm\\_idx' ORDER BY indexname`);
        return r.map(x => x.indexname).join() === TRGM.join() || JSON.stringify(r.map(x => x.indexname));
      });
      await check('pg_trgm: re-run keeps 5 trigram indexes; search still correct (ILIKE)', async () => {
        await db.exec(g6a);
        await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${U.adminA}', 'y@g6a.example.com');
                       INSERT INTO public.profiles (id) VALUES ('${U.adminA}') ON CONFLICT DO NOTHING;
                       INSERT INTO public.memberships (user_id, org_id, role) VALUES ('${U.adminA}', '${A}', 'admin');`);
        const s = await asRole('adminA', () => q(`SELECT public.search_records($1, '{"container_no":"tstu 0000003"}') r`, [A]));
        const n = await count(`SELECT count(*)::int n FROM pg_indexes WHERE indexname LIKE '%\\_trgm\\_idx'`);
        return (n === 5 && s[0].r.total === 1 && s[0].r.items[0].id === TX2) || JSON.stringify([n, s[0].r.total]);
      });
    } catch (e) { fail('migration safety (pg_trgm)', errText(e)); }
    finally { try { await db.close(); } catch (e) { /* ignore */ } }
  }
  db = saved;
}

/* ------------------------------------------------------------------ runner */
const SECTIONS = [
  ['catalog', secCatalog],
  ['anon', secAnon],
  ['search', secSearch],
  ['reports', secReports],
  ['dashboards', secDashboards],
  ['portal', secPortal],
  ['export_log', secExportLog],
  ['no_writes', secNoWrites],
  ['review_fixes', secReviewFixes],
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
  try { await fixtures(); pass('fixtures: two orgs, branch-scoped roles, G3 / G4 / G5 rows, portal documents'); }
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
