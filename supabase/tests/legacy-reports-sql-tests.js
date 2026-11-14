#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 8 (reports, dashboards, alerts): migration 20261124000100_legacy_reports.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal / amr).

  Covers: file conventions + all_migrations.sql + docs + the owner decisions; preflight, re-run on itself (identical catalog),
  catalog delta (no table / column / trigger); dash_tx_counts (= the lists the tiles open, Riyadh "today", drafts, stages,
  transported containers, finance-only Daftra counts, no money); the register (every new filter, the legacy 23-field search, date
  field 'updated', sorts, Ro-Ro units, row fields, Daftra state for finance readers only, attention); aging rules (defaults,
  override, validation, owner only, Riyadh time, effective billed state) and the two alert kinds through refresh_alerts;
  tx_attention; report_movements (every filter, totals, finance gate); report_trips (by_carrier / by_driver, driver / party / q);
  report_payments (every filter, totals, finance scope); report_fasah_scope (digits, scopes, caps, branch scope); the export log
  (new reports + gates); audit_trail (labels, diff, event, transaction scope); e-mail code login (otp_session_check,
  set_email_otp_login); RLS / privileges (org B, client portal, anon, helpers); supa.js wrappers, i18n.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-reports-sql-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const MIG = '20261124000100_legacy_reports.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

globalThis.fetch = async () => { throw new Error('network forbidden in legacy-reports-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';
const B = 'a8dd0000-0000-4000-8000-0000000000b0';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const CLIENT_A2 = 'a8d10000-0000-4000-8000-000000000102';
const BR_B = 'a8dd0000-0000-4000-8000-0000000000b1';
const CL_B = 'a8dd0000-0000-4000-8000-0000000000b3';
const P = {
  op: 'a8d20000-0000-4000-8000-000000000001',      // terminal operator
  agent: 'a8d20000-0000-4000-8000-000000000002',   // shipping agent
  carrier: 'a8d20000-0000-4000-8000-000000000003', // transport company
  sup: 'a8d20000-0000-4000-8000-000000000004',     // payment beneficiary
  carrierB: 'a8d20000-0000-4000-8000-0000000000b4'
};
const U = {
  admin: 'a8df0000-0000-4000-8000-000000000001',    // admin of A, org-wide = the owner
  sup: 'a8df0000-0000-4000-8000-000000000002',      // supervisor of A (org-wide)
  bmJ: 'a8df0000-0000-4000-8000-000000000003',      // branch_manager of A, JED
  acc: 'a8df0000-0000-4000-8000-000000000004',      // accountant of A, org-wide
  accJ: 'a8df0000-0000-4000-8000-000000000005',     // accountant of A, JED only
  jed: 'a8df0000-0000-4000-8000-000000000006',      // clearance_staff of A, JED
  dmm: 'a8df0000-0000-4000-8000-000000000007',      // clearance_staff of A, DMM
  trJ: 'a8df0000-0000-4000-8000-000000000008',      // transport_staff of A, JED
  ops: 'a8df0000-0000-4000-8000-000000000009',      // operations_manager of A, org-wide (trip finance, not fin_read)
  portal: 'a8df0000-0000-4000-8000-00000000000a',   // client user of CLIENT_A
  staffB: 'a8df0000-0000-4000-8000-00000000000b',   // admin of B
  adminJ: 'a8df0000-0000-4000-8000-00000000000c'    // admin of A at JED only (not the owner)
};

/* ------------------------------------------------------------------ helpers */
let db;
let roleLock = Promise.resolve();
async function asRole(who, fn, claims) {
  const prev = roleLock;
  let release;
  roleLock = new Promise(r => { release = r; });
  await prev;
  try { return await asRoleNow(who, fn, claims); } finally { release(); }
}
async function asRoleNow(who, fn, claims) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify(Object.assign({ sub: U[who], role: 'authenticated', aal: 'aal2' }, claims || {}))]);
    await db.exec(`SET ROLE authenticated;`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params, claims) => asRole(who, () => q(sql, params), claims);
const one = async (sql, params) => (await q(sql, params))[0];
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const J = x => JSON.stringify(x);
async function check(name, fn) {
  try {
    const r = await fn();
    if (typeof r === 'string') fail(name, r);
    else if (r === false || r === null || r === 0 || r === undefined) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + errText(e) + '\n        ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')); }
}
async function code(fn) {
  try { await fn(); return 'ok'; } catch (e) {
    const m = e.message || '';
    if (/^MRS_/.test(m)) return m + (e.detail ? ' ' + e.detail : '');
    if (/permission denied/.test(m)) return 'perm';
    return errText(e);
  }
}
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
async function freshDb(upTo) {
  const d = new PGlite();
  await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles().filter(f => !upTo || f < upTo)) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  return d;
}
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
// a write that must not move updated_at / fire guards (time travel of the fixtures): triggers off for this statement only
async function raw(sql, params) {
  await db.exec(`SET session_replication_role = replica`);
  try { return await q(sql, params); } finally { await db.exec(`SET session_replication_role = origin`); }
}
const rpc = (who, sql, params, claims) => as(who, sql, params, claims).then(r => r[0].r);
const R = (who, fn, filters) => rpc(who, `SELECT public.${fn}($1, $2) r`, [A, filters || {}]);
let seq = 0;
const nx = p => p + '-' + (++seq);
let ctrSeq = 0;
const ctrNo = () => 'RPTU' + String(1000000 + (++ctrSeq)).slice(-7);

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind IN ('r','v') ORDER BY 1`)).map(x => x.t);
  const idx = (await q(`SELECT indexname || ':' || md5(indexdef) x FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('app','public') ORDER BY 1`)).map(x => x.x);
  const pol = (await q(`SELECT tablename || '.' || policyname x FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const con = (await q(`SELECT conrelid::regclass::text || '.' || conname || ':' || md5(pg_get_constraintdef(oid)) x FROM pg_constraint
                         WHERE connamespace = 'public'::regnamespace ORDER BY 1`)).map(x => x.x);
  const cols = (await q(`SELECT table_name || '.' || column_name x FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`)).map(x => x.x);
  const grants = (await q(`SELECT table_name || ':' || grantee || ':' || privilege_type x FROM information_schema.role_table_grants
                            WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','service_role') ORDER BY 1`)).map(x => x.x);
  const labels = (await q(`SELECT domain || '.' || code || ':' || sort || ':' || label_ar || ':' || client_visible x FROM public.status_labels ORDER BY 1`)).map(x => x.x);
  return { fns, tables, idx, trg, pol, con, cols, grants, labels };
}
const NEW_FNS = ['app.aging_rules_check', 'app.att_ids', 'app.att_json', 'app.att_reasons', 'app.audit_changes', 'app.audit_label_of',
  'app.rpt_billed', 'app.rpt_daftra_json', 'app.rpt_daftra_state', 'app.rpt_decl_status', 'app.rpt_digits_no', 'app.rpt_mv', 'app.rpt_mv_keys',
  'app.rpt_num_range', 'app.rpt_pay_keys', 'app.rpt_ports', 'app.rpt_unit_count', 'app.status_aging_defaults', 'app.status_aging_rules',
  'public.audit_trail', 'public.dash_tx_counts', 'public.get_status_aging_rules', 'public.otp_session_check', 'public.report_fasah_scope',
  'public.report_movements', 'public.report_payments', 'public.set_email_otp_login', 'public.set_status_aging_rules', 'public.tx_attention'];
const RECREATED = ['app.alert_causes', 'app.rpt_export_keys', 'app.rpt_search_keys', 'app.rpt_trip_keys', 'app.rpt_tx_json', 'app.rpt_tx_match',
  'app.rpt_tx_result', 'app.rpt_tx_sort', 'public.log_report_export', 'public.report_transactions', 'public.report_trips'];
const RPCS = ['audit_trail', 'dash_tx_counts', 'get_status_aging_rules', 'otp_session_check', 'report_fasah_scope', 'report_movements',
  'report_payments', 'set_email_otp_login', 'set_status_aging_rules', 'tx_attention'];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at)
    SELECT v.id::uuid, v.k || '@legacyreports.example.com', now() FROM (VALUES
      ('${U.admin}','admin'),('${U.sup}','sup'),('${U.bmJ}','bmj'),('${U.acc}','acc'),('${U.accJ}','accj'),('${U.jed}','jed'),
      ('${U.dmm}','dmm'),('${U.trJ}','trj'),('${U.ops}','ops'),('${U.portal}','portal'),('${U.staffB}','staffb'),('${U.adminJ}','adminj')) v(id, k);
  INSERT INTO public.profiles (id, full_name) SELECT u.id, 'موظف ' || split_part(u.email, '@', 1) FROM auth.users u
   WHERE u.email LIKE '%@legacyreports.example.com' ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'legacyreports-org-b', 'مؤسسة ب', 'Legacy reports org B', 'LRB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES
    ('${CL_B}', '${B}', 'business', 'عميل ب', 'Client B Co', '0509990001'),
    ('${CLIENT_A2}', '${A}', 'business', 'مؤسسة التقارير الثانية', 'Second Reports Est', '0509990002');
  INSERT INTO public.parties (id, org_id, kinds, name_ar, name_en) VALUES
    ('${P.op}', '${A}', ARRAY['terminal_operator'], 'مشغل محطة تجريبي', 'Test Terminal Operator'),
    ('${P.agent}', '${A}', ARRAY['shipping_agent'], 'وكيل ملاحي تجريبي', 'Test Shipping Agent'),
    ('${P.carrier}', '${A}', ARRAY['carrier'], 'شركة النقل التجريبية', 'Test Transport Co'),
    ('${P.sup}', '${A}', ARRAY['supplier'], 'جهة الفاتورة التجريبية', 'Test Billing Entity'),
    ('${P.carrierB}', '${B}', ARRAY['carrier'], 'ناقل ب', 'Carrier B');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.sup}', '${A}', NULL, 'supervisor'), ('${U.bmJ}', '${A}', '${JED}', 'branch_manager'),
    ('${U.acc}', '${A}', NULL, 'accountant'), ('${U.accJ}', '${A}', '${JED}', 'accountant'), ('${U.jed}', '${A}', '${JED}', 'clearance_staff'),
    ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff'), ('${U.trJ}', '${A}', '${JED}', 'transport_staff'),
    ('${U.ops}', '${A}', NULL, 'operations_manager'), ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
  UPDATE public.clients SET daftra_client_code = '000186', port_category = 'port' WHERE id = '${CLIENT_A}';
  UPDATE public.clients SET daftra_client_code = '000777', port_category = 'airport' WHERE id = '${CLIENT_A2}';
`;
const TX = {};
async function mkTx(key, o) {
  const x = Object.assign({ org: A, branch: JED, client: CLIENT_A, containers: 1, port: 'SAJED', roro: false }, o || {});
  const tx = await one(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, container_count, bl_number, port_code,
                          goods_description, country, cargo_unit_type, chassis_no, transaction_type, responsible_user_id, terminal_party_id,
                          shipping_line, transport_order_no, notes, transport_mode)
                        VALUES ($1, $2, $3, 'import', 'sea', $4, $5, $6, 'قطع غيار', 'الصين', $7, $8, $9, $10, $11, $12, $13, $14,
                                CASE WHEN $13::text IS NULL THEN NULL ELSE 'carrier_order' END) RETURNING id, ref`,
    [x.org, x.branch, x.client, x.roro ? 0 : x.containers, x.bl || nx('BLR'), x.port, x.roro ? 'roro' : 'container', x.roro ? x.chassis : null,
     x.type || 'normal', x.emp || null, x.op || null, x.line || null, x.order || null, x.notes || null]);
  const ctrs = [];
  for (let i = 0; i < (x.roro ? 0 : x.containers); i++) {
    const c = await one(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3) RETURNING id, container_no`,
      [x.org, tx.id, ctrNo()]);
    ctrs.push(c);
  }
  const t = { id: tx.id, ref: tx.ref, org: x.org, branch: x.branch, ctrs };
  if (key) TX[key] = t;
  return t;
}
async function decl(t, no, status, date) {
  return (await one(`INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no, declaration_type, declaration_date, status)
                     VALUES ($1, $2, $3, 'import', $4, $5) RETURNING id`, [t.org, t.id, no, date || '2026-11-03', status || 'submitted'])).id;
}
async function setStatus(t, s) { await raw(`UPDATE public.transactions SET operational_status = $2 WHERE id = $1`, [t.id, s]); }
async function age(t, hours) { await raw(`UPDATE public.transactions SET updated_at = now() - make_interval(hours => $2) WHERE id = $1`, [t.id, hours]); }
// an appointment hours ago (or at a fixed instant), optionally with its trip
async function appt(t, ctr, at, o) {
  const x = Object.assign({ status: 'confirmed' }, o || {});
  const a = await one(`INSERT INTO public.port_appointments (org_id, transaction_id, container_id, appointment_at, status, appointment_no,
                         booking_ref, operator_name, terminal_party_id, created_by, status_reason)
                       VALUES ($1, $2, $3, ${at}, $4, $5, $6, $7, $8, $9, CASE WHEN $4 IN ('cancelled','missed') THEN 'اختبار' END) RETURNING id, appointment_at`,
    [t.org, t.id, ctr ? ctr.id : null, x.status, x.no || null, x.booking || null, x.operator || null, x.terminal || null, x.by || U.trJ]);
  return a;
}
async function trip(t, ctr, o) {
  const x = Object.assign({ status: 'planned' }, o || {});
  return one(`INSERT INTO public.transport_trips (org_id, transaction_id, container_id, appointment_id, carrier_id, driver_id, truck_id,
                destination, cost_amount, cost_currency, sell_amount, sell_currency, status, party_type, party_name, unloaded_at, created_by)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SAR', $10, 'SAR', $11, $12, $13, $14, $15) RETURNING id`,
    [t.org, t.id, ctr ? ctr.id : null, x.appt || null, x.carrier || null, x.driver || null, x.truck || null, x.dest || null,
     x.cost == null ? null : x.cost, x.sell == null ? null : x.sell, x.status, x.ptype || null, x.pname || null,
     x.status === 'delivered' ? (x.unloaded || new Date().toISOString()) : null, x.by || U.trJ]);
}
const riyadhAt = (dayOffset, hhmm) => `((app.rpt_today() + ${dayOffset})::timestamp + interval '${hhmm}') AT TIME ZONE 'Asia/Riyadh'`;
const D = {};
async function fixtures() {
  await db.exec(FIXTURES);
  D.driver1 = (await one(`INSERT INTO public.drivers (org_id, carrier_id, full_name, phone) VALUES ($1, $2, 'سائق أول', '0551112233') RETURNING id`, [A, P.carrier])).id;
  D.driver2 = (await one(`INSERT INTO public.drivers (org_id, full_name, phone) VALUES ($1, 'سائق ثان', '0554445566') RETURNING id`, [A])).id;
  D.truck1 = (await one(`INSERT INTO public.trucks (org_id, carrier_id, plate_no) VALUES ($1, $2, 'ABC1234') RETURNING id`, [A, P.carrier])).id;
  // T1 (JED): 2 containers, declaration accepted, B/L with vessel + agent, operator, employee, Daftra code via the client
  const t1 = await mkTx('t1', { containers: 2, emp: U.jed, op: P.op, order: 'TASTO7781', notes: 'ملاحظة داخلية مميزة' });
  await decl(t1, 'D-1001', 'accepted', '2026-11-03');
  // the primary B/L made from bl_number by the G3 trigger: + vessel, carrier name, shipping agent
  await q(`UPDATE public.bills_of_lading b SET vessel = 'MSC AURORA', carrier_name = 'MSC', shipping_agent_id = $2
             FROM public.transaction_bls tb WHERE tb.bl_id = b.id AND tb.transaction_id = $1`, [t1.id, P.agent]);
  // T2 (JED): Ro-Ro re-export, port SADMM, released
  const t2 = await mkTx('t2', { roro: true, chassis: 'JTDBR32E720012345', port: 'SADMM', type: 're_export', line: 'Hapag Lines' });
  await decl(t2, 'D-1002', 'released', '2026-10-20');
  // T3 (DMM): client A2, awaiting duty payment
  const t3 = await mkTx('t3', { branch: DMM, client: CLIENT_A2, port: 'SADMM' });
  await decl(t3, '0002001', 'awaiting_duty_payment', '2026-11-04');
  // T4 (JED): new, 3 containers, no declaration
  await mkTx('t4', { containers: 3 });
  // T5 (JED): issued Daftra invoice; T6 (JED): Daftra draft
  const t5 = await mkTx('t5', {}); await setStatus(t5, 'under_billing');
  const t6 = await mkTx('t6', {}); await setStatus(t6, 'operationally_complete');
  for (const [t, st, ext] of [[t5, 'issued', 'inv-5'], [t6, 'draft', 'inv-6']]) {
    await raw(`INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose, purpose_key, currency, revision, operational_ref, status,
                 external_invoice_id, daftra_number, issued_at) VALUES ($1, $2, $3, 'final', 'F', 'SAR', 1, $4, $5, $6, $7, $8)`,
      [A, t.id, CLIENT_A, t.ref, st, ext, 'INV-' + ext, st === 'issued' ? new Date().toISOString() : null]);
  }
  // movements on T1: today 00:30 Riyadh (delivered), yesterday 23:30 Riyadh (registered), a cancelled one
  D.a1 = await appt(t1, t1.ctrs[0], riyadhAt(0, '00:30'), { no: 'TAS12345678', booking: 'BK-77', operator: 'مشغل الحاويات', terminal: P.op });
  D.r1 = await trip(t1, t1.ctrs[0], { appt: D.a1.id, carrier: P.carrier, driver: D.driver1, truck: D.truck1, dest: 'مستودع العميل جدة', cost: 500, sell: 700,
    status: 'delivered', ptype: 'company', pname: 'شركة النقل التجريبية' });
  D.a2 = await appt(t1, t1.ctrs[1], riyadhAt(-1, '23:30'), { status: 'requested', no: 'TAS22222222' });
  D.r2 = await trip(t1, t1.ctrs[1], { appt: D.a2.id, driver: D.driver2, dest: 'الرياض', cost: 300, sell: 450, status: 'planned', ptype: 'direct', pname: 'سائق ثان' });
  D.a3 = await appt(t1, t1.ctrs[1], riyadhAt(-2, '10:00'), { status: 'cancelled', no: 'TAS33333333' });
  // a trip without appointment on T3 (DMM), delivered
  D.r3 = await trip(t3, t3.ctrs[0], { driver: D.driver1, dest: 'الدمام', cost: 200, sell: 260, status: 'delivered', ptype: 'company', pname: 'شركة النقل التجريبية', carrier: P.carrier });
  // empty returns of T1: container 1 deadline yesterday (overdue), container 2 deadline today (not overdue: Riyadh date)
  await raw(`UPDATE public.containers SET return_deadline = app.rpt_today() - 1, return_location = 'ساحة الفارغ' WHERE id = $1`, [t1.ctrs[0].id]);
  await raw(`UPDATE public.containers SET return_deadline = app.rpt_today() WHERE id = $1`, [t1.ctrs[1].id]);
  // drafts: one document batch (JED), one pending appointment draft (T1)
  await raw(`INSERT INTO public.doc_batches (org_id, branch_id, kind, status, created_by) VALUES ($1, $2, 'shipment', 'draft', $3)`, [A, JED, U.admin]);
  await raw(`INSERT INTO public.doc_batches (org_id, branch_id, kind, status, created_by) VALUES ($1, $2, 'shipment', 'draft', $3)`, [A, DMM, U.admin]);
  await raw(`INSERT INTO public.appointment_drafts (org_id, transaction_id, status, created_by) VALUES ($1, $2, 'pending', $3)`, [A, t1.id, U.admin]);
  // org B: one transaction with a declaration and a movement (never visible to A)
  const tb = await mkTx('tb', { org: B, branch: BR_B, client: CL_B });
  await decl(tb, 'D-1001', 'accepted', '2026-11-03');
  await appt(tb, tb.ctrs[0], riyadhAt(0, '01:00'), { by: U.staffB });
  // every fixture transaction freshly updated (no stale attention unless a test ages it)
  await raw(`UPDATE public.transactions SET updated_at = now()`);
}
// payments through the step-6 RPC (finance writers): T1 (JED) by accJ, T3 (DMM) by acc
let sadad = 900000;
const payBase = (tx, o) => Object.assign({ movement_type: 'org_paid', pattern: 'single', service_code: 'port_charges', transaction_id: tx,
  paid_amount: 100, paid_at: '2026-11-01', funding_source: 'org_account', method: 'sadad', paying_account: 'Test Bank 01',
  sadad_number: String(++sadad), beneficiary_party_id: P.sup }, o || {});
async function payFixtures() {
  D.pay1 = await rpc('accJ', `SELECT public.record_payment_bundle($1, NULL) r`, [payBase(TX.t1.id, { paid_amount: 150.5, paid_at: '2026-11-02', claim_no: 'CLM-501' })]);
  D.pay2 = await rpc('acc', `SELECT public.record_payment_bundle($1, NULL) r`, [payBase(TX.t3.id, { paid_amount: 80, paid_at: '2026-11-05',
    funding_source: 'cash_box', method: 'cash', sadad_number: undefined, receipt_no: 'RC-9911', paying_account: undefined })]);
  D.pay3 = await rpc('accJ', `SELECT public.record_payment_bundle($1, NULL) r`, [payBase(TX.t1.id, { paid_amount: 20, paid_at: '2026-10-15',
    movement_type: 'received_from_client', funding_source: 'not_applicable_receipt', method: 'bank_transfer', sadad_number: undefined,
    bank_reference: 'BREF-31', beneficiary_party_id: undefined })]).catch(e => ({ error: errText(e) }));
}

/* ================================================================== 1. file */
async function secFile() {
  section('1. file conventions, all_migrations.sql, docs, owner decisions');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('migration present, UTF-8 guard, preflight on 20261123000100, schema_versions row', () =>
    (src.includes("'جديد' <> U&'\\062C\\062F\\064A\\062F'") && src.includes("version = '20261123000100'")
     && src.includes("VALUES ('20261124000100', 'legacy_reports')")) || 'header');
  await check('no secret / personal data / legacy organization name copied (no e-mail, phone, key)', () =>
    (!/@[a-z0-9-]+\.[a-z]/i.test(src.replace(/--.*$/gm, '')) && !/\b05[0-9]{8}\b/.test(src) && !/رأس الحكمة/.test(src)
     && !/sk-ant|apikey|api_key\s*=/i.test(src)) || 'personal data');
  await check('read side only: no CREATE TABLE / ADD COLUMN / CREATE TRIGGER, no Daftra / billing write, no approval', () =>
    (!/CREATE TABLE/i.test(src) && !/ADD COLUMN/i.test(src) && !/CREATE TRIGGER/i.test(src)
     && !/(INSERT INTO|UPDATE|DELETE FROM) public\.(billing_|daftra_|transactions\b|containers\b|port_appointments|transport_trips|client_disbursements|empty_return_proofs)/i.test(src)
     && !/functions\.invoke|net\.http/i.test(src)) || 'writes');
  await check('every SECURITY DEFINER function pins search_path', () => {
    const bad = (src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$/g) || []).filter(f => /SECURITY DEFINER/.test(f) && !/SET search_path = ''/.test(f));
    return bad.length === 0 || bad.map(b => b.slice(0, 80)).join(' | ');
  });
  // later phases may follow this file (20261125000100 legacy_import: re-creates att_reasons / alert_causes / rpt_tx_match / audit_label_of)
  const LATER_PHASES = ['20261125000100_legacy_import.sql', '20261126000100_doc_match_packing.sql'];
  await check('this file is the latest migration (or only listed later phases follow it)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (appended last, in order) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const after = order.slice(order.indexOf(MIG) + 1);
    return (i > 0 && after.every(f => LATER_PHASES.includes(f)) && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 24000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
  await check('docs/online/LEGACY_REPORTS_AR.md names the migration, every RPC, the error details and the decisions', () => {
    const p = path.join(ROOT, 'docs', 'online', 'LEGACY_REPORTS_AR.md');
    if (!fs.existsSync(p)) return 'missing';
    const d = fs.readFileSync(p, 'utf8');
    const miss = [MIG, ...RPCS, 'report_trips', 'report_transactions', 'log_report_export', 'aging_rule', 'status_stale', 'appointment_not_updated',
      'shouldCreateUser', 'aal2', 'Asia/Riyadh'].filter(k => !d.includes(k));
    return miss.length === 0 || 'missing: ' + miss.join(', ');
  });
  await check('the plan records the step-8 defaults as a dated owner-decision line', () => {
    const d = fs.readFileSync(path.join(ROOT, 'docs', 'online', 'LEGACY_PORT_PLAN_AR.md'), 'utf8');
    const i = d.indexOf('## قرارات المالك'), j = d.indexOf('## ترتيب البناء');
    return (i > 0 && /\(2026-11-1\d\)[^\n]*مرحلة 8/.test(d.slice(i, j)) && d.slice(i, j).includes('20261124000100_legacy_reports.sql')) || 'no step-8 line';
  });
}

/* ================================================================== 2. preflight, re-run, catalog delta */
async function secPreflight() {
  section('2. preflight, re-run on itself, catalog delta');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('preflight: refused on a database without legacy_daftra (nothing changed)', async () => {
    const d = await freshDb('20261123000100');
    try {
      const e = await withDb(d, async () => { try { await db.exec(src); return 'applied'; } catch (x) { return x.message; } });
      const v = await withDb(d, () => q(`SELECT 1 FROM public.schema_versions WHERE version = '20261124000100'`));
      return (/LEGACY REPORTS preflight/.test(e) && v.length === 0) || e;
    } finally { await d.close(); }
  });
  // the catalog of a database that ends with this file (later phases re-create some of its readers)
  const later = migFiles().filter(f => f > MIG);
  const own = later.length ? await freshDb(later[0]) : db;
  const before = await withDb(own, catalog);
  await check('re-run on itself: identical catalog (functions, ACLs, constraints, labels, grants)', async () => {
    await withDb(own, () => db.exec(src));
    const after = await withDb(own, catalog);
    const keys = Object.keys(before).filter(k => J(before[k]) !== J(after[k]));
    return keys.length === 0 || 'changed: ' + keys.join(', ');
  });
  await check('catalog delta vs legacy_daftra: the new functions exactly; no new table / column / trigger / policy; one index (audit_log_tx_child_idx)', async () => {
    const d = await freshDb(MIG);
    try {
      const prev = await withDb(d, catalog);
      const sig = x => x.sig.split('(')[0];
      const added = before.fns.map(sig).filter(s => !prev.fns.map(sig).includes(s));
      const uniq = [...new Set(added)].sort();
      const changed = before.fns.filter(f => { const p = prev.fns.find(x => x.sig === f.sig); return p && p.h !== f.h; }).map(sig).sort();
      const same = ['tables', 'cols', 'trg', 'pol', 'grants'].filter(k => J(prev[k]) !== J(before[k]));
      const newIdx = before.idx.filter(x => !prev.idx.includes(x)).map(x => x.split(':')[0]), goneIdx = prev.idx.filter(x => !before.idx.includes(x));
      if (J(newIdx) !== J(['audit_log_tx_child_idx']) || goneIdx.length) same.push('idx');
      return (J(uniq) === J(NEW_FNS) && J([...new Set(changed)].sort()) === J(RECREATED) && same.length === 0)
        || J({ added: uniq.filter(x => !NEW_FNS.includes(x)), missing: NEW_FNS.filter(x => !uniq.includes(x)), changed, same });
    } finally { await d.close(); }
  });
  await check('constraints: only the alert kind and the export report CHECKs changed (supersets)', async () => {
    const r = await one(`SELECT pg_get_constraintdef(c1.oid) k, pg_get_constraintdef(c2.oid) e FROM pg_constraint c1, pg_constraint c2
                          WHERE c1.conname = 'operational_alerts_kind_check' AND c2.conname = 'report_exports_report_check'`);
    return (['docs_missing', 'declaration_stalled', 'status_stale', 'appointment_not_updated'].every(x => r.k.includes(x))
      && ['search', 'fasah_sheet', 'movements', 'payments', 'tx_followup', 'fasah_recon'].every(x => r.e.includes(x))) || J(r);
  });
  await check('dictionaries: new labels, internal only (client_visible false), Arabic + English filled', async () => {
    // (the two audit labels of the legacy import, 20261125000100, are left out: counted by its own suite)
    const r = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE client_visible)::int v, count(*) FILTER (WHERE label_ar = '' OR label_en IS NULL)::int e
                           FROM public.status_labels WHERE NOT (domain = 'audit_label' AND code LIKE 'legacy_import.%') AND (domain IN ('attention_level',
                             'attention_reason','tx_daftra_state','movement_date_field',
                             'return_scope','payment_date_field','fasah_match_status','audit_label','audit_event')
                              OR (domain = 'alert_kind' AND code IN ('status_stale','appointment_not_updated'))
                              OR (domain = 'report_kind' AND code IN ('movements','payments','tx_followup','fasah_recon')))`);
    return (r.n === 2 + 3 + 4 + 6 + 3 + 2 + 7 + 31 + 18 + 2 + 4 && r.v === 0 && r.e === 0) || J(r);
  });
}

/* ================================================================== 3. dash_tx_counts */
async function secDash() {
  section('3. dash_tx_counts: tiles = the lists they open');
  await check('admin: totals, every status key, the 5 Fasah stages, drafts, appointments today (Riyadh), transported containers', async () => {
    const r = await R('admin', 'dash_tx_counts');
    const st = Object.keys(r.by_status);
    return (r.total === 9 && st.length === 10 && r.by_status.new === 6 && r.by_status.under_billing === 1
      && r.declaration_stages.accepted === 1 && r.declaration_stages.released === 1 && r.declaration_stages.awaiting_duty_payment === 1
      && r.declaration_stages.cco_review_done === 0 && r.declaration_stages.release_ready === 0 && r.no_declaration === 5
      && r.drafts.documents === 2 && r.drafts.appointments === 1 && r.appointments_today === 1 && r.transported_containers === 2
      && r.daftra.issued === 1 && r.daftra.draft === 1) || J(r);
  });
  await check('each status / stage tile count = report_transactions total for that filter', async () => {
    const r = await R('admin', 'dash_tx_counts');
    const bad = [];
    for (const [k, n] of Object.entries(r.by_status)) {
      const x = await R('admin', 'report_transactions', { operational_status: k, limit: 1 });
      if (x.total !== n) bad.push('status ' + k + ' ' + n + '/' + x.total);
    }
    for (const [k, n] of Object.entries(r.declaration_stages)) {
      const x = await R('admin', 'report_transactions', { declaration_status: k, limit: 1 });
      if (x.total !== n) bad.push('stage ' + k + ' ' + n + '/' + x.total);
    }
    const dr = await R('acc', 'report_transactions', { daftra_state: 'draft', limit: 1 });
    if (dr.total !== r.daftra.draft) bad.push('daftra draft');
    return bad.length === 0 || bad.join(', ');
  });
  await check('appointments today / transported containers = report_movements (date today; movement delivered)', async () => {
    const r = await R('admin', 'dash_tx_counts');
    const today = (await one(`SELECT app.rpt_today()::text d`)).d;
    const m1 = await R('admin', 'report_movements', { from: today, to: today, limit: 1 });
    const m2 = await R('admin', 'report_movements', { movement_status: 'delivered', limit: 1 });
    return (m1.totals.appointments === r.appointments_today && m2.totals.delivered_containers === r.transported_containers) || J({ m1: m1.totals, m2: m2.totals });
  });
  await check('branch scope: clearance JED sees JED only (DMM transaction, DMM draft, DMM trip left out); no Daftra block, no money key', async () => {
    const r = await R('jed', 'dash_tx_counts');
    const keys = JSON.stringify(r);
    return (r.total === 7 && r.drafts.documents === 1 && r.transported_containers === 1 && r.daftra === null
      && !/amount|cost|sell|revenue|value/.test(keys)) || J(r);
  });
  await check('branch_id filter; another org\'s branch → MRS_INVALID branch_id; client / org B / anon refused', async () => {
    const r = await R('admin', 'dash_tx_counts', { branch_id: DMM });
    const e1 = await code(() => R('admin', 'dash_tx_counts', { branch_id: BR_B }));
    const e2 = await code(() => R('portal', 'dash_tx_counts'));
    const e3 = await code(() => R('staffB', 'dash_tx_counts'));
    const e4 = await code(() => as('anon', `SELECT public.dash_tx_counts($1, '{}') r`, [A]));
    return (r.total === 2 && e1 === 'MRS_INVALID branch_id' && e2 === 'MRS_FORBIDDEN organization' && e3 === 'MRS_FORBIDDEN organization' && e4 === 'perm')
      || J({ t: r.total, e1, e2, e3, e4 });
  });
}

/* ================================================================== 4. register */
async function secRegister() {
  section('4. transactions register: legacy filters, 23-field search, row fields');
  const ids = r => r.items.map(i => i.id).sort();
  // seed.sql transactions may match too: compared on the fixture transactions only
  const mine = () => Object.values(TX).map(t => t.id);
  const has = (r, ...ts) => J(ids(r).filter(i => mine().includes(i))) === J(ts.map(t => TX[t].id).sort());
  const cases = [
    ['client_code (Daftra code, contains, zeros kept)', { client_code: '0186' }, ['t1', 't2', 't4', 't5', 't6']],
    ['client_category', { client_category: 'airport' }, ['t3']],
    ['port_code (one / array)', { port_code: ['SADMM'] }, ['t2', 't3']],
    ['declaration_status array', { declaration_status: ['accepted', 'released'] }, ['t1', 't2']],
    ['vessel (B/L)', { vessel: 'aurora' }, ['t1']],
    ['terminal_party_id', { terminal_party_id: P.op }, ['t1']],
    ['operator_q (party or appointment operator)', { operator_q: 'مشغل' }, ['t1']],
    ['agent_q (B/L agent party / shipping line)', { agent_q: 'hapag' }, ['t2']],
    ['agent_q agent party', { agent_q: 'وكيل ملاحي' }, ['t1']],
    ['employee_id (responsible / creator)', { employee_id: U.jed }, ['t1']],
    ['containers range (Ro-Ro = 1)', { containers_min: 2, containers_max: 3 }, ['t1', 't4']],
    ['containers_max 1', { containers_max: 1 }, ['t2', 't3', 't5', 't6']],
    ['cargo_unit_type roro', { cargo_unit_type: 'roro' }, ['t2']],
    ['transaction_type re_export', { transaction_type: ['re_export'] }, ['t2']],
    ['container_no matches the Ro-Ro chassis', { container_no: 'jtdbr32e7200' }, ['t2']],
    ['q: chassis', { q: '12345' }, ['t2']],
    ['q: vessel', { q: 'MSC AUR' }, ['t1']],
    ['q: transport order', { q: 'tasto7781' }, ['t1']],
    ['q: notes', { q: 'مميزة' }, ['t1']],
    ['q: employee name', { q: 'موظف jed' }, ['t1']],
    ['q: Daftra code', { q: '000777' }, ['t3']],
    ['q: port name', { q: 'رابغ' }, []],
    ['q: port code', { q: 'SADMM' }, ['t2', 't3']],
    ['q: declaration digits', { q: '0002001' }, ['t3']]
  ];
  for (const [name, f, exp] of cases) {
    await check('filter ' + name, async () => {
      const r = await R('admin', 'report_transactions', Object.assign({ limit: 50 }, f));
      return has(r, ...exp) || J({ got: r.items.filter(i => mine().includes(i.id)).map(i => Object.keys(TX).find(k => TX[k].id === i.id)), exp });
    });
  }
  await check('search_records takes the same keys and returns the same ids', async () => {
    const a = await R('admin', 'search_records', { port_code: 'SADMM', limit: 50 });
    const b = await R('admin', 'report_transactions', { port_code: 'SADMM', limit: 50 });
    return (J(ids(a)) === J(ids(b)) && a.total === b.total) || 'differs';
  });
  await check('date_field updated (Riyadh day bounds); declaration date', async () => {
    await raw(`UPDATE public.transactions SET updated_at = ((app.rpt_today() - 10)::timestamp + interval '23 hours 50 minutes') AT TIME ZONE 'Asia/Riyadh' WHERE id = $1`, [TX.t4.id]);
    const d10 = (await one(`SELECT (app.rpt_today() - 10)::text d`)).d, d9 = (await one(`SELECT (app.rpt_today() - 9)::text d`)).d;
    const r1 = await R('admin', 'report_transactions', { date_field: 'updated', from: d10, to: d10 });
    const r2 = await R('admin', 'report_transactions', { date_field: 'updated', from: d9, to: d9 });
    const r3 = await R('admin', 'report_transactions', { date_field: 'declaration', from: '2026-11-03', to: '2026-11-04' });
    await raw(`UPDATE public.transactions SET updated_at = now() WHERE id = $1`, [TX.t4.id]);
    return (has(r1, 't4') && r2.total === 0 && has(r3, 't1', 't3')) || J({ r1: r1.total, r2: r2.total, r3: r3.items.map(i => i.ref) });
  });
  await check('sorts ref_desc / declaration_date_desc / updated_desc accepted; bad sort / attention / port / range refused', async () => {
    const s = await R('admin', 'report_transactions', { sort: 'ref_desc', limit: 50 });
    const refs = s.items.map(i => i.ref);
    const ok2 = (await R('admin', 'report_transactions', { sort: 'declaration_date_desc', limit: 2 })).items[0].id === TX.t3.id;
    const e = [await code(() => R('admin', 'report_transactions', { sort: 'x' })), await code(() => R('admin', 'report_transactions', { attention: 'soon' })),
      await code(() => R('admin', 'report_transactions', { port_code: 'XXX' })),
      await code(() => R('admin', 'report_transactions', { containers_min: 3, containers_max: 1 })),
      await code(() => R('admin', 'report_transactions', { daftra_state: 'paid' })), await code(() => R('admin', 'report_transactions', { date_field: 'x' }))];
    return (J(refs) === J([...refs].sort().reverse()) && ok2 && J(e) === J(['MRS_INVALID sort', 'MRS_INVALID attention', 'MRS_INVALID port_code',
      'MRS_INVALID containers_range', 'MRS_INVALID daftra_state', 'MRS_INVALID date_field'])) || J({ refs, ok2, e });
  });
  await check('row fields: port, operator, agent, vessel, employee, client code / category, unit count, containers (tooltip), declaration stage', async () => {
    const r = await R('admin', 'report_transactions', { q: 'aurora' });
    const x = r.items[0];
    const r2 = (await R('admin', 'report_transactions', { cargo_unit_type: 'roro' })).items[0];
    return (x.port_code === 'SAJED' && x.port_name === 'ميناء جدة الإسلامي' && x.operator_name === 'مشغل محطة تجريبي' && x.agent_name === 'وكيل ملاحي تجريبي'
      && x.vessel === 'MSC AURORA' && x.employee_id === U.jed && x.employee_name === 'موظف jed' && x.client_code === '000186'
      && x.client_category === 'port' && x.unit_count === 2 && x.containers.length === 2 && x.declaration_status === 'accepted'
      && x.declaration_date === '2026-11-03' && r2.unit_count === 1 && r2.containers.length === 0 && r2.chassis_no === 'JTDBR32E720012345'
      && r2.transaction_type === 're_export') || J({ x, r2 });
  });
  await check('regression: containers are container-number strings (what the follow-up «وحدة الشحن» and the tooltip read); totals.units = the sum of the rows\' unit_count (Ro-Ro = 1)', async () => {
    const x = (await R('admin', 'report_transactions', { q: 'aurora' })).items[0];
    const all = await R('admin', 'report_transactions', { limit: 500 });
    const sum = all.items.reduce((a, i) => a + (+i.unit_count || 0), 0);
    const rr = await R('admin', 'report_transactions', { cargo_unit_type: 'roro' });
    return (x.containers.every(c => typeof c === 'string' && /^[A-Z]{4}\d{7}$/.test(c)) && all.total === all.items.length && all.totals.units === sum
      && rr.totals.units === rr.total && rr.totals.containers === 0) || J({ c: x.containers, units: all.totals.units, sum, rr: rr.totals });
  });
  await check('Daftra state: finance readers see {state, number}; clearance staff null; daftra_state filter matches only rows of their fin scope', async () => {
    const a = (await R('acc', 'report_transactions', { daftra_state: ['issued'] })).items;
    const d = (await R('acc', 'report_transactions', { daftra_state: 'draft' })).items;
    const j = (await R('jed', 'report_transactions', { q: TX.t5.ref })).items[0];
    const jf = await R('jed', 'report_transactions', { daftra_state: 'issued' });
    const n = (await R('acc', 'report_transactions', { daftra_state: 'none', limit: 50 })).total;
    const dj = (await R('accJ', 'report_transactions', { daftra_state: 'none', limit: 50 })).total;
    return (a.length === 1 && a[0].daftra.state === 'issued' && a[0].daftra.number === 'INV-inv-5' && d[0].daftra.state === 'draft'
      && j.daftra === null && jf.total === 0 && n === 7 && dj === 5) || J({ a, d: d.length, j: j.daftra, jf: jf.total, n, dj });
  });
  await check('totals: attention counts; by_daftra_state for finance only (null for clearance)', async () => {
    const a = await R('acc', 'report_transactions', {});
    const j = await R('jed', 'report_transactions', {});
    return (a.totals.attention && typeof a.totals.attention.critical === 'number' && a.totals.by_daftra_state.issued === 1 && j.totals.by_daftra_state === null) || J({ a: a.totals, j: j.totals });
  });
  await check('branch isolation: DMM clearance never sees JED rows, even by exact number; org B rows never', async () => {
    const r = await R('dmm', 'report_transactions', { q: 'D-1001' });
    const r2 = await R('admin', 'report_transactions', { declaration_no: 'D-1001', limit: 50 });
    return (r.total === 0 && r2.total === 1 && r2.items[0].id === TX.t1.id) || J({ r: r.total, r2: r2.total });
  });
}

/* ================================================================== 5. attention / aging */
async function secAttention() {
  section('5. attention: aging rules, Riyadh time, effective Daftra state, the two alert kinds');
  const att = async (who, t) => (await R(who || 'admin', 'report_transactions', { q: t.ref })).items[0].attention;
  await check('defaults = the legacy rules (new 24/48, active 48/96, complete 24/48, transport 24/48, under billing 48/96, appointment 6/12)', async () => {
    const r = await rpc('jed', `SELECT public.get_status_aging_rules($1) r`, [A]);
    const x = r.rules;
    return (x.new.warning_hours === 24 && x.new.critical_hours === 48 && x.in_progress.critical_hours === 96 && x.operationally_complete.warning_hours === 24
      && x.transport.critical_hours === 48 && x.under_billing.warning_hours === 48 && x.appointment_not_updated.warning_hours === 6
      && x.appointment_not_updated.critical_hours === 12 && !('billed' in x) && !('empty_return_overdue' in x) && r.can_edit === false
      && J(r.overrides) === '{}') || J(r);
  });
  const t = await mkTx('ta', {});
  await raw(`UPDATE public.transactions SET updated_at = now() WHERE id = $1`, [t.id]);
  await check('status_stale: 23 h → none; 25 h → warning; 49 h → critical (hours since the last update)', async () => {
    await age(t, 23); const a0 = await att(null, t);
    await age(t, 25); const a1 = await att(null, t);
    await age(t, 49); const a2 = await att(null, t);
    return (a0 === null && a1.level === 'warning' && a1.reasons[0].code === 'status_stale' && a1.reasons[0].warning_hours === 24
      && a2.level === 'critical' && a2.hours >= 49) || J({ a0, a1, a2 });
  });
  await check('effective status: an issued Daftra invoice → billed → no aging; a draft does not change the status (in_progress 48 h)', async () => {
    await age(TX.t5, 200); const a5 = await att('acc', TX.t5);
    await setStatus(TX.t6, 'in_progress'); await age(TX.t6, 47); const a6 = await att('acc', TX.t6);
    await age(TX.t6, 50); const a6b = await att('acc', TX.t6);
    await setStatus(TX.t6, 'operationally_complete'); await raw(`UPDATE public.transactions SET updated_at = now() WHERE id IN ($1, $2)`, [TX.t5.id, TX.t6.id]);
    return (a5 === null && a6 === null && a6b.level === 'warning' && a6b.reasons[0].status === 'in_progress') || J({ a5, a6, a6b });
  });
  await check('org override: set by the org-wide admin with a reason; the reader follows; null switches a rule off; {} restores', async () => {
    const r = await rpc('admin', `SELECT public.set_status_aging_rules($1, $2, $3) r`, [A, { new: { warning_hours: 10, critical_hours: 20 }, transport: null }, 'اختبار']);
    const a = await att(null, t);
    const audit = await one(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'organizations' AND row_id = $1 AND 'settings' = ANY (changed_fields)`, [A]);
    const ok1 = r.rules.new.warning_hours === 10 && !('transport' in r.rules && r.rules.transport) && r.rules.transport === null && a.reasons[0].critical_hours === 20;
    const r2 = await rpc('admin', `SELECT public.set_status_aging_rules($1, '{}'::jsonb, $2) r`, [A, 'إرجاع']);
    return (ok1 && r2.rules.new.warning_hours === 24 && J(r2.overrides) === '{}' && audit.n >= 1) || J({ r: r.rules, a, r2: r2.rules, audit });
  });
  await check('override refusals: unknown key / bad hours / warning ≥ critical / empty_return_overdue → MRS_INVALID aging_rule; no reason; supervisor / branch manager / aal1', async () => {
    const s = (who, rules, why, claims) => code(() => rpc(who, `SELECT public.set_status_aging_rules($1, $2, $3) r`, [A, rules, why], claims));
    const e = [await s('admin', { foo: { warning_hours: 1, critical_hours: 2 } }, 'x'), await s('admin', { new: { warning_hours: 0, critical_hours: 2 } }, 'x'),
      await s('admin', { new: { warning_hours: 5, critical_hours: 5 } }, 'x'), await s('admin', { new: { warning_hours: 1.5, critical_hours: 5 } }, 'x'),
      await s('admin', { empty_return_overdue: { warning_hours: 1, critical_hours: 2 } }, 'x'), await s('admin', { new: 'x' }, 'x'),
      await s('admin', {}, ' '), await s('sup', {}, 'x'), await s('bmJ', {}, 'x'), await s('admin', {}, 'x', { aal: 'aal1' })];
    return J(e) === J(['MRS_INVALID aging_rule', 'MRS_INVALID aging_rule', 'MRS_INVALID aging_rule', 'MRS_INVALID aging_rule', 'MRS_INVALID aging_rule',
      'MRS_INVALID aging_rule', 'MRS_NOTE_REQUIRED reason', 'MRS_FORBIDDEN owner_only', 'MRS_FORBIDDEN owner_only', 'MRS_MFA_REQUIRED aal2']) || J(e);
  });
  await check('an invalid stored override is ignored by the reader (the default stays), never an error', async () => {
    await raw(`UPDATE public.organizations SET settings = settings || '{"status_aging_rules": {"new": {"warning_hours": 50, "critical_hours": 10}, "x": 1}}' WHERE id = $1`, [A]);
    const r = await one(`SELECT app.status_aging_rules($1) r`, [A]);
    await raw(`UPDATE public.organizations SET settings = settings - 'status_aging_rules' WHERE id = $1`, [A]);
    return (r.r.new.warning_hours === 24 && !('x' in r.r)) || J(r);
  });
  const tp = await mkTx('tp', {});
  await check('appointment_not_updated: passed 5 h → none; 7 h → warning; 13 h → critical; delivered / cancelled / under billing → none', async () => {
    const a = await appt(tp, tp.ctrs[0], `now() - interval '5 hours'`, { status: 'confirmed' });
    await raw(`UPDATE public.transactions SET updated_at = now() WHERE id = $1`, [tp.id]);
    const x0 = await att(null, tp);
    await raw(`UPDATE public.port_appointments SET appointment_at = now() - interval '7 hours' WHERE id = $1`, [a.id]);
    const x1 = await att(null, tp);
    await raw(`UPDATE public.port_appointments SET appointment_at = now() - interval '13 hours' WHERE id = $1`, [a.id]);
    const x2 = await att(null, tp);
    await setStatus(tp, 'under_billing'); await raw(`UPDATE public.transactions SET updated_at = now() WHERE id = $1`, [tp.id]);
    const x3 = await att(null, tp);
    await setStatus(tp, 'appointment');
    const r = await trip(tp, tp.ctrs[0], { appt: a.id, dest: 'x', cost: 1, sell: 2, status: 'delivered' });
    const x4 = await att(null, tp);
    await raw(`UPDATE public.transport_trips SET status = 'planned', unloaded_at = NULL WHERE id = $1`, [r.id]);
    D.tpAppt = a.id;
    return (x0 === null && x1.level === 'warning' && x1.reasons[0].code === 'appointment_not_updated' && x1.reasons[0].container_no === tp.ctrs[0].container_no
      && x2.level === 'critical' && x3 === null && x4 === null) || J({ x0, x1, x2, x3, x4 });
  });
  await check('empty_return_overdue: deadline yesterday (Riyadh date) → critical; deadline today → not overdue', async () => {
    const a = await att(null, TX.t1);
    const er = a && a.reasons.filter(x => x.code === 'empty_return_overdue');
    return (a.level === 'critical' && er.length === 1 && er[0].container_id === TX.t1.ctrs[0].id) || J(a);
  });
  await check('attention filter: any / critical / warning; equals tx_attention totals for the same filters', async () => {
    await age(t, 30);
    const any = await R('admin', 'report_transactions', { attention: 'any', limit: 50 });
    const cr = await R('admin', 'report_transactions', { attention: 'critical', limit: 50 });
    const wa = await R('admin', 'report_transactions', { attention: 'warning', limit: 50 });
    const ta = await R('admin', 'tx_attention', {});
    const ta2 = await R('admin', 'tx_attention', { attention: 'critical' });
    return (any.total === cr.total + wa.total && any.total === ta.total && cr.total === ta.totals.critical && wa.total === ta.totals.warning
      && ta2.total === cr.total && ta.items[0].level === 'critical' && ta.totals.by_reason.status_stale >= 1 && ta.rules.new
      && wa.items.some(i => i.id === t.id)) || J({ any: any.total, cr: cr.total, wa: wa.total, ta: ta.totals });
  });
  await check('tx_attention is branch-scoped (DMM staff: no JED reason); clients / org B refused', async () => {
    const r = await R('dmm', 'tx_attention', {});
    const e1 = await code(() => R('portal', 'tx_attention', {}));
    const e2 = await code(() => R('staffB', 'tx_attention', {}));
    return (r.items.every(i => i.ref === TX.t3.ref) && e1 === 'MRS_FORBIDDEN organization' && e2 === 'MRS_FORBIDDEN organization') || J({ r: r.items, e1, e2 });
  });
  await check('refresh_alerts: status_stale + appointment_not_updated alerts (severity, titles, list_alerts kind filter); a fresh update resolves status_stale', async () => {
    await raw(`UPDATE public.operational_alert_runs SET last_run_at = '-infinity'`);
    const r = await rpc('admin', `SELECT public.refresh_alerts($1) r`, [A]);
    const s = await one(`SELECT * FROM public.operational_alerts WHERE kind = 'status_stale' AND transaction_id = $1`, [t.id]);
    const ap = await one(`SELECT * FROM public.operational_alerts WHERE kind = 'appointment_not_updated' AND subject_id = $1`, [D.tpAppt]);
    const l = await rpc('admin', `SELECT public.list_alerts($1, $2) r`, [A, { kind: 'status_stale' }]);
    await raw(`UPDATE public.transactions SET updated_at = now() WHERE id = $1`, [t.id]);
    await q(`SELECT app.refresh_alerts_core($1, now())`, [A]);
    const s2 = await one(`SELECT status, resolution FROM public.operational_alerts WHERE id = $1`, [s.id]);
    return (r.refreshed && s.severity === 'warning' && /أكثر من 24 ساعة/.test(s.title_ar) && ap && ap.severity === 'critical' && /12 ساعة/.test(ap.title_ar)
      && l.items.length >= 1 && l.items.every(i => i.kind === 'status_stale') && s2.status === 'resolved' && s2.resolution === 'auto') || J({ r, s, ap, s2 });
  });
  await check('a cancelled transaction raises no attention and no new alert', async () => {
    const c = await mkTx(null, {}); await age(c, 100);
    await raw(`UPDATE public.transactions SET cancelled_at = now(), cancelled_by = $2, cancel_reason = 'x', operational_status = 'closed' WHERE id = $1`, [c.id, U.admin]);
    const n = await one(`SELECT count(*)::int n FROM app.att_reasons($1, ARRAY[$2]::uuid[], now())`, [A, c.id]);
    const k = await one(`SELECT count(*)::int n FROM app.alert_causes($1, now()) x WHERE x.transaction_id = $2`, [A, c.id]);
    return (n.n === 0 && k.n === 0) || J({ n, k });
  });
}

/* ================================================================== 6. movements */
async function secMovements() {
  section('6. report_movements: filters, totals, finance gate');
  const ids = r => r.items.map(i => i.id).sort();
  await check('rows: appointments (not rescheduled) + trips without appointment; 19 legacy columns present', async () => {
    const r = await R('admin', 'report_movements', { transaction_id: TX.t1.id });
    const x = r.items.find(i => i.appointment_id === D.a1.id);
    const cols = ['client_name', 'port_name', 'driver_name', 'driver_phone', 'truck_plate', 'container_no', 'declaration_no', 'bl_number', 'appointment_at',
      'destination', 'cost_amount', 'sell_amount', 'return_location', 'return_deadline', 'returned_at', 'return_status', 'movement_status', 'appointment_no', 'notes'];
    return (r.total === 3 && x.trip_id === D.r1.id && x.movement_status === 'delivered' && x.cost_amount === 500 && x.sell_amount === 700
      && x.driver_name === 'سائق أول' && x.truck_plate === 'ABC1234' && x.port_name === 'ميناء جدة الإسلامي' && x.declaration_no === 'D-1001'
      && x.operator_name === 'مشغل الحاويات' && x.party_name === 'شركة النقل التجريبية' && x.overdue === true && x.days_overdue === 1
      && cols.every(c => c in x)) || J({ total: r.total, x });
  });
  const f = async (filters) => ids(await R('admin', 'report_movements', Object.assign({ limit: 100 }, filters)));
  const exp = (...xs) => xs.sort();
  await check('filters: client / driver / truck / carrier / party / status / B/L / declaration / container / port / booking / operator / employee / destination / q', async () => {
    const t1 = TX.t1, a1 = D.a1.id, a2 = D.a2.id, r3 = D.r3.id;
    const got = {
      client: await f({ client_id: CLIENT_A2 }), driver: await f({ driver_id: D.driver1 }), driverq: await f({ driver_q: 'ثان' }),
      truck: await f({ truck_q: 'abc-1234' }), carrier: await f({ carrier_id: P.carrier }), ptype: await f({ party_type: 'direct' }),
      pq: await f({ party_q: 'النقل التجريبية' }), ms: await f({ movement_status: ['cancelled'] }), bl: await f({ bl_number: t1.ref ? (await one(`SELECT bl_number FROM public.transactions WHERE id = $1`, [t1.id])).bl_number : '' }),
      decl: await f({ declaration_no: '2001' }), ctr: await f({ container_no: t1.ctrs[0].container_no.toLowerCase() }), port: await f({ port_code: 'SADMM' }),
      book: await f({ booking_q: 'bk-77' }), op: await f({ operator_q: 'الحاويات' }), emp: await f({ employee_id: U.trJ }), dest: await f({ destination_q: 'الدمام' }),
      q: await f({ q: 'TAS22222222' })
    };
    const want = { client: [r3], driver: exp(a1, r3), driverq: [a2], truck: [a1], carrier: exp(a1, r3), ptype: [a2], pq: exp(a1, r3), ms: [D.a3.id],
      bl: exp(a1, a2, D.a3.id), decl: [r3], ctr: [a1], port: [r3], book: [a1], op: [a1], emp: exp(a1, a2, D.a3.id, r3), dest: [r3], q: [a2] };
    const bad = Object.keys(want).filter(k => J(got[k]) !== J(want[k].sort()));
    return bad.length === 0 || J(bad.map(k => [k, got[k].length, want[k].length]));
  });
  await check('return_scope overdue / pending / returned; return_status codes', async () => {
    const o = await f({ return_scope: 'overdue' });
    await raw(`UPDATE public.containers SET returned_at = now(), return_status = 'pending' WHERE id = $1`, [TX.t3.ctrs[0].id]);
    const rt = await f({ return_scope: 'returned' });
    const pe = await f({ return_scope: 'pending', transaction_id: TX.t1.id });
    const rs = await f({ return_status: ['pending'], port_code: 'SADMM' });
    const e = await code(() => R('admin', 'report_movements', { return_scope: 'soon' }));
    return (J(o) === J([D.a1.id]) && J(rt) === J([D.r3.id]) && pe.length === 3 && J(rs) === J([D.r3.id]) && e === 'MRS_INVALID return_scope') || J({ o, rt, pe, rs, e });
  });
  await check('regression: an actual return date past the deadline (status still pending) is «returned» only — not overdue, not counted, no empty_return_overdue attention', async () => {
    const id = TX.t3.ctrs[0].id;
    const prev = await one(`SELECT return_deadline::text d, returned_at, return_status FROM public.containers WHERE id = $1`, [id]);
    await raw(`UPDATE public.containers SET return_deadline = app.rpt_today() - 5, returned_at = now(), return_status = 'pending' WHERE id = $1`, [id]);
    const o = await f({ return_scope: 'overdue' }), rt = await f({ return_scope: 'returned' });
    const tot = await R('admin', 'report_movements', { transaction_id: TX.t3.id });
    const att = await one(`SELECT count(*)::int n FROM app.att_reasons($1, ARRAY[$2]::uuid[], now()) x WHERE x.reason = 'empty_return_overdue' AND x.container_id = $3`, [A, TX.t3.id, id]);
    await raw(`UPDATE public.containers SET returned_at = NULL WHERE id = $1`, [id]);
    const o2 = await f({ return_scope: 'overdue' });
    const att2 = await one(`SELECT count(*)::int n FROM app.att_reasons($1, ARRAY[$2]::uuid[], now()) x WHERE x.reason = 'empty_return_overdue' AND x.container_id = $3`, [A, TX.t3.id, id]);
    await raw(`UPDATE public.containers SET return_deadline = $2::date, returned_at = $3, return_status = $4 WHERE id = $1`, [id, prev.d, prev.returned_at, prev.return_status]);
    return (o.indexOf(D.r3.id) === -1 && rt.indexOf(D.r3.id) !== -1 && tot.items.filter(i => i.id === D.r3.id).every(i => i.overdue === false) && tot.totals.overdue_returns === tot.items.filter(i => i.overdue).length
      && att.n === 0 && o2.indexOf(D.r3.id) !== -1 && att2.n === 1) || J({ o, rt, tot: tot.totals, att, o2, att2 });
  });
  await check('date fields with Riyadh day bounds: today = 00:30 Riyadh (not yesterday 23:30); return_deadline is a date (not shifted)', async () => {
    const dd = async n => (await one(`SELECT (app.rpt_today() + $1::int)::text d`, [n])).d;
    const today = await dd(0), yest = await dd(-1);
    const t = await f({ from: today, to: today, transaction_id: TX.t1.id });
    const y = await f({ from: yest, to: yest, transaction_id: TX.t1.id });
    const dl = await f({ date_field: 'return_deadline', from: yest, to: yest });
    const e = await code(() => R('admin', 'report_movements', { date_field: 'x' }));
    return (J(t) === J([D.a1.id]) && J(y) === J([D.a2.id]) && J(dl) === J([D.a1.id]) && e === 'MRS_INVALID date_field') || J({ t, y, dl, e });
  });
  await check('totals: appointments, cancelled, delivered containers, overdue returns, transport value / revenue of the non-cancelled rows', async () => {
    const r = await R('admin', 'report_movements', {});
    const T = r.totals;
    return (T.count === 4 && T.appointments === 3 && T.cancelled === 1 && T.delivered_containers === 2 && T.overdue_returns === 1
      && T.transport_value.SAR === 1000 && T.revenue.SAR === 1410 && T.rows_with_finance === 4 && T.by_movement_status.delivered === 2) || J(T);
  });
  await check('finance gate: clearance staff → amounts null and money totals empty; value range → MRS_FORBIDDEN cost; operations manager may', async () => {
    const r = await R('jed', 'report_movements', {});
    const e = await code(() => R('jed', 'report_movements', { value_min: 100 }));
    const o = await R('ops', 'report_movements', { value_min: 400, value_max: 600 });
    const rv = await R('ops', 'report_movements', { revenue_min: 450 });
    const e2 = await code(() => R('ops', 'report_movements', { value_min: 600, value_max: 100 }));
    return (r.items.every(i => i.cost_amount === null && i.sell_amount === null) && J(r.totals.transport_value) === '{}' && r.totals.rows_with_finance === 0
      && r.finance === false && e === 'MRS_FORBIDDEN cost' && J(ids(o)) === J([D.a1.id]) && rv.total === 2 && e2 === 'MRS_INVALID value_range') || J({ e, o: ids(o), rv: rv.total, e2 });
  });
  await check('branch scope: DMM staff only the DMM trip; org B rows never; sorts; paging totals stable', async () => {
    const r = await R('dmm', 'report_movements', {});
    const s = await R('admin', 'report_movements', { sort: 'appointment_asc', limit: 2 });
    const p2 = await R('admin', 'report_movements', { sort: 'appointment_asc', limit: 2, offset: 2 });
    const e = await code(() => R('admin', 'report_movements', { sort: 'x' }));
    return (J(ids(r)) === J([D.r3.id]) && s.total === 4 && p2.total === 4 && s.fingerprint === p2.fingerprint && s.items[0].appointment_at <= s.items[1].appointment_at
      && e === 'MRS_INVALID sort') || J({ r: r.total, e });
  });
}

/* ================================================================== 7. transport report */
async function secTrips() {
  section('7. report_trips: by_carrier / by_driver, driver / party / q filters');
  await check('groups by party and by driver (trips desc); values only with include_finance', async () => {
    const r = await R('ops', 'report_trips', { include_finance: true, limit: 100 });
    const c = r.totals.by_carrier.find(x => x.party_name === 'شركة النقل التجريبية');
    const d1 = r.totals.by_driver.find(x => x.driver_id === D.driver1);
    const n = await R('ops', 'report_trips', { limit: 100 });
    return (c.trips === 2 && c.party_type === 'company' && c.value_by_currency.SAR === 700 && d1.trips === 2 && d1.value_by_currency.SAR === 700
      && r.totals.by_carrier[0].trips >= r.totals.by_carrier[r.totals.by_carrier.length - 1].trips
      && n.totals.by_carrier.every(x => J(x.value_by_currency) === '{}')) || J(r.totals);
  });
  await check('driver_id / driver_q / party_type / party_q / q filters; rows carry party_name and driver_phone', async () => {
    const a = await R('admin', 'report_trips', { driver_id: D.driver1 });
    const b = await R('admin', 'report_trips', { driver_q: 'ثان' });
    const c = await R('admin', 'report_trips', { party_type: 'direct' });
    const d = await R('admin', 'report_trips', { party_q: 'التجريبية' });
    const e = await R('admin', 'report_trips', { q: 'TAS12345678' });
    const x = await code(() => R('admin', 'report_trips', { party_type: 'x' }));
    return (a.total === 2 && b.total >= 1 && c.items.every(i => i.party_type === 'direct') && d.total === 2 && e.total === 1 && e.items[0].driver_phone === '0551112233'
      && e.items[0].party_name === 'شركة النقل التجريبية' && x === 'MRS_INVALID party_type') || J({ a: a.total, b: b.total, c: c.total, d: d.total, e: e.total, x });
  });
}

/* ================================================================== 8. payments */
async function secPayments() {
  section('8. report_payments: filters, totals, finance scope');
  await check('fixtures: three register entries', () => !!(D.pay1 && D.pay1.id && D.pay2 && D.pay2.id && D.pay3 && D.pay3.id) || J(D.pay3));
  const ids = r => r.items.map(i => i.id).sort();
  await check('rows + totals (count, paid by currency, by review / movement type); legacy columns', async () => {
    const r = await R('acc', 'report_payments', {});
    const x = r.items.find(i => i.id === D.pay1.id);
    return (r.total === 3 && r.totals.count === 3 && r.totals.paid.SAR === 250.5 && r.totals.by_movement_type.org_paid === 2
      && x.client_names === 'شركة الاختبار الأولى للتجارة' && x.declaration_nos === 'D-1001' && x.sadad_number && x.created_by_name === 'موظف accj'
      && x.service_code === 'port_charges' && x.method === 'sadad' && x.funding_source === 'org_account' && x.transactions[0].ref === TX.t1.ref) || J({ t: r.totals, x });
  });
  await check('filters: date, client, service, funding source, method, review status, movement type, transaction, q, status', async () => {
    const g = async fl => ids(await R('acc', 'report_payments', fl));
    const got = {
      date: await g({ from: '2026-11-02', to: '2026-11-05' }), client: await g({ client_id: CLIENT_A2 }), clientq: await g({ client_q: 'الثانية' }),
      svc: await g({ service_code: 'port_charges', funding_source: ['cash_box'] }), method: await g({ method: 'sadad' }),
      rs: await g({ review_status: ['pending', 'draft', 'approved', 'rejected'] }), mt: await g({ movement_type: 'received_from_client' }),
      tx: await g({ transaction_id: TX.t3.id }), q: await g({ q: 'RC-9911' }), q2: await g({ q: 'CLM-501' }), q3: await g({ q: 'D-1001' }),
      voids: await g({ status: 'void' })
    };
    const want = { date: [D.pay1.id, D.pay2.id], client: [D.pay2.id], clientq: [D.pay2.id], svc: [D.pay2.id], method: [D.pay1.id], rs: [D.pay1.id, D.pay2.id, D.pay3.id],
      mt: [D.pay3.id], tx: [D.pay2.id], q: [D.pay2.id], q2: [D.pay1.id], q3: [D.pay1.id, D.pay3.id], voids: [] };
    const bad = Object.keys(want).filter(k => J(got[k]) !== J(want[k].sort()));
    const e = [await code(() => R('acc', 'report_payments', { method: 'bitcoin' })), await code(() => R('acc', 'report_payments', { status: 'x' })),
      await code(() => R('acc', 'report_payments', { date_field: 'x' })), await code(() => R('acc', 'report_payments', { sort: 'x' }))];
    return (bad.length === 0 && J(e) === J(['MRS_INVALID method', 'MRS_INVALID status', 'MRS_INVALID date_field', 'MRS_INVALID sort'])) || J({ bad: bad.map(k => [k, got[k]]), e });
  });
  await check('finance scope: JED accountant sees JED entries only; clearance / operations manager / client / org B refused', async () => {
    const r = await R('accJ', 'report_payments', {});
    const e = [await code(() => R('jed', 'report_payments', {})), await code(() => R('ops', 'report_payments', {})),
      await code(() => R('portal', 'report_payments', {})), await code(() => R('staffB', 'report_payments', {}))];
    return (J(ids(r)) === J([D.pay1.id, D.pay3.id].sort()) && J(e) === J(['MRS_FORBIDDEN finance', 'MRS_FORBIDDEN finance', 'MRS_FORBIDDEN org', 'MRS_FORBIDDEN org'])) || J({ r: ids(r), e });
  });
}

/* ================================================================== 9. Fasah reconciliation scope */
async function secFasah() {
  section('9. report_fasah_scope: declaration digits, port / month scopes, caps, branch scope');
  const call = (who, nos, scopes) => rpc(who, `SELECT public.report_fasah_scope($1, $2, $3) r`, [A, nos, scopes]);
  await check('by number: digits only, leading zeros ignored (2001 = 0002001); records carry port / date / stage / status', async () => {
    const r = await call('admin', ['2001', '١٠٠١', '999999'], []);
    const x = r.records.find(i => i.transaction_id === TX.t3.id);
    return (r.counts.by_no === 2 && x && x.declaration_no_norm === '2001' && x.port_code === 'SADMM' && x.declaration_date === '2026-11-04'
      && x.month === '2026-11' && x.declaration_status === 'awaiting_duty_payment' && x.by_no && !x.in_scope && r.ports.length === 7) || J(r);
  });
  await check('scopes: every system declaration of the port and month (in_scope), plus the numbers; org B never', async () => {
    const r = await call('admin', ['1002'], [{ port_code: 'SAJED', month: '2026-11' }, { port_code: 'sadmm', month: '2026-10' }]);
    const t = r.records.map(i => i.transaction_id).sort();
    return (J(t) === J([TX.t1.id, TX.t2.id].sort()) && r.records.find(i => i.transaction_id === TX.t2.id).by_no && r.counts.in_scope === 2) || J(r.records);
  });
  await check('branch scope: DMM clearance gets the DMM declaration only (scoped true)', async () => {
    const r = await call('dmm', ['1001', '2001', '1002'], [{ port_code: 'SAJED', month: '2026-11' }]);
    return (r.records.length === 1 && r.records[0].transaction_id === TX.t3.id && r.scoped === true) || J(r);
  });
  await check('caps and validation: > 20000 numbers / > 40 chars → MRS_TOO_LONG nos; bad scope → MRS_INVALID scopes; client / org B refused', async () => {
    const big = Array.from({ length: 20001 }, (_, i) => String(i));
    const e = [await code(() => call('admin', big, [])), await code(() => call('admin', ['1'.repeat(41)], [])),
      await code(() => call('admin', [], [{ port_code: 'XX', month: '2026-11' }])), await code(() => call('admin', [], [{ port_code: 'SAJED', month: '2026-13' }])),
      await code(() => call('admin', [], { a: 1 })), await code(() => call('portal', [], [])), await code(() => rpc('staffB', `SELECT public.report_fasah_scope($1, $2, $3) r`, [A, [], []]))];
    return J(e) === J(['MRS_TOO_LONG nos', 'MRS_TOO_LONG nos', 'MRS_INVALID scopes', 'MRS_INVALID scopes', 'MRS_INVALID scopes',
      'MRS_FORBIDDEN organization', 'MRS_FORBIDDEN organization']) || J(e);
  });
  await check('read-only: no row changes in the business tables', async () => {
    const n0 = await one(`SELECT (SELECT count(*) FROM public.transactions) + (SELECT count(*) FROM public.customs_declarations) n`);
    await call('admin', ['1001'], [{ port_code: 'SAJED', month: '2026-11' }]);
    const n1 = await one(`SELECT (SELECT count(*) FROM public.transactions) + (SELECT count(*) FROM public.customs_declarations) n`);
    return n0.n === n1.n;
  });
}

/* ================================================================== 10. export log */
async function secExport() {
  section('10. log_report_export: the step-8 reports and their gates');
  const log = (who, p) => rpc(who, `SELECT public.log_report_export($1, $2) r`, [A, p]);
  await check('movements / tx_followup / fasah_recon by staff; payments by finance; rows recorded (no data)', async () => {
    const a = await log('jed', { report: 'movements', format: 'xlsx', filters: { return_scope: 'overdue', port_code: ['SAJED'] }, row_count: 3 });
    const b = await log('jed', { report: 'tx_followup', format: 'print', filters: { attention: 'any', port_code: 'SAJED', daftra_state: 'draft' }, row_count: 5 });
    const c = await log('jed', { report: 'fasah_recon', format: 'xlsx', filters: { months: ['2026-11'], port_codes: ['SAJED'], files: 2, statuses: ['missing'] }, row_count: 10 });
    const d = await log('accJ', { report: 'payments', format: 'csv', filters: { method: 'sadad', from: '2026-11-01' }, row_count: 2 });
    const rows = await q(`SELECT report, row_count, filters FROM public.report_exports WHERE id = ANY ($1)`, [[a.id, b.id, c.id, d.id]]);
    return (rows.length === 4 && rows.every(x => !('items' in x.filters))) || J(rows);
  });
  await check('gates: payments → MRS_FORBIDDEN finance for clearance; movements value range → MRS_FORBIDDEN cost; unknown keys → MRS_INVALID filters', async () => {
    const e = [await code(() => log('jed', { report: 'payments', format: 'xlsx', filters: {}, row_count: 1 })),
      await code(() => log('jed', { report: 'movements', format: 'xlsx', filters: { value_min: '5' }, row_count: 1 })),
      await code(() => log('jed', { report: 'movements', format: 'xlsx', filters: { amount: 1 }, row_count: 1 })),
      await code(() => log('jed', { report: 'fasah_recon', format: 'xlsx', filters: { nos: ['1'] }, row_count: 1 })),
      await code(() => log('portal', { report: 'movements', format: 'xlsx', filters: {}, row_count: 1 })),
      await code(() => log('jed', { report: 'tx_followup', format: 'print', filters: {}, row_count: 2001 }))];
    const ok = await log('ops', { report: 'movements', format: 'xlsx', filters: { value_min: '5' }, row_count: 1 });
    return (J(e) === J(['MRS_FORBIDDEN finance', 'MRS_FORBIDDEN cost', 'MRS_INVALID filters', 'MRS_INVALID filters', 'MRS_FORBIDDEN organization',
      'MRS_INVALID export_rows']) && !!ok.id) || J(e);
  });
  await check('regression: fasah_recon accepts up to 100 months / ports (its ≤ 100 scopes) and a system_only count; other arrays keep the 20 cap', async () => {
    const months = Array.from({ length: 30 }, (_, i) => (2024 + Math.floor(i / 12)) + '-' + String(i % 12 + 1).padStart(2, '0'));
    const a = await log('jed', { report: 'fasah_recon', format: 'xlsx', filters: { months, port_codes: ['SAJED'], files: 20, system_only: 40 }, row_count: 140 });
    const e = [await code(() => log('jed', { report: 'fasah_recon', format: 'xlsx', filters: { months: months.concat(months, months, months).slice(0, 101) }, row_count: 1 })),
      await code(() => log('jed', { report: 'fasah_recon', format: 'xlsx', filters: { statuses: Array.from({ length: 21 }, (_, i) => 's' + i) }, row_count: 1 })),
      await code(() => log('jed', { report: 'movements', format: 'xlsx', filters: { port_code: Array.from({ length: 21 }, () => 'SAJED') }, row_count: 1 }))];
    const row = await one(`SELECT row_count, filters FROM public.report_exports WHERE id = $1`, [a.id]);
    return (!!a.id && row.row_count === 140 && row.filters.system_only === 40 && row.filters.months.length === 30
      && J(e) === J(['MRS_INVALID filters', 'MRS_INVALID filters', 'MRS_INVALID filters'])) || J({ a, row, e });
  });
  // 2026-11-14: «كشف إدخال فسح» from the readings (ocr.html matching report, ops/fasah-sheet.js renderDraft) has no transaction
  // yet: it is logged with filters {} — accepted as is (no migration); a portal user is still refused
  await check('fasah_sheet with filters {} (readings draft, no transaction yet) is logged by staff with no filter recorded; portal → refused', async () => {
    const a = await log('jed', { report: 'fasah_sheet', format: 'csv', filters: {}, row_count: 48 });
    const b = await log('jed', { report: 'fasah_sheet', format: 'print', filters: {}, row_count: 48 });
    const p = await code(() => log('portal', { report: 'fasah_sheet', format: 'xlsx', filters: {}, row_count: 1 }));
    const row = await one(`SELECT report, format, filters, row_count FROM public.report_exports WHERE id = $1`, [a.id]);
    return (!!a.id && !!b.id && row.report === 'fasah_sheet' && J(row.filters) === '{}' && row.row_count === 48 && /^MRS_(FORBIDDEN|NOT_FOUND)/.test(p)) || J({ row, p });
  });
  await check('list_report_exports shows the new kinds to the auditor', async () => {
    const r = await rpc('sup', `SELECT public.list_report_exports($1, $2) r`, [A, { report: 'fasah_recon' }]);
    return r.total >= 1 || J(r);
  });
}

/* ================================================================== 11. audit trail */
async function secAudit() {
  section('11. audit_trail: business labels, field diff, the transaction event, the transaction scope');
  await check('transaction scope: the transaction + its containers / appointments / trips / declarations rows; labels + changes', async () => {
    await rpc('admin', `SELECT public.set_transaction_status($1, $2, $3, NULL, false) r`, [TX.t4.id, 'in_progress', 'بدء العمل']).catch(() => null);
    await q(`UPDATE public.containers SET return_location = 'ساحة جديدة' WHERE id = $1`, [TX.t4.ctrs[0].id]);
    const r = await rpc('sup', `SELECT public.audit_trail($1, $2) r`, [A, { transaction_id: TX.t4.id, limit: 200 }]);
    const tbls = [...new Set(r.items.map(i => i.table_name))].sort();
    const ins = r.items.find(i => i.table_name === 'transactions' && i.action === 'INSERT');
    const cu = r.items.find(i => i.table_name === 'containers' && i.action === 'UPDATE');
    const st = r.items.find(i => i.label === 'tx.status');
    return (tbls.includes('transactions') && tbls.includes('containers') && ins.label === 'tx.create' && ins.transaction_ref === TX.t4.ref
      && cu.label === 'container.return' && cu.container_no === TX.t4.ctrs[0].container_no
      && cu.changes.length === 1 && cu.changes[0].field === 'return_location' && cu.changes[0].from === null && cu.changes[0].to === 'ساحة جديدة'
      && (!st || (st.changes.some(c => c.field === 'operational_status' && c.from === 'new' && c.to === 'in_progress')
                  && st.event && st.event.type === 'operational_status' && st.event.to_status === 'in_progress'))
      && r.items.every(i => !i.changes.some(c => c.field === 'updated_at'))) || J({ tbls, ins, cu, st });
  });
  await check('the organization settings change is labelled settings.update; keyset paging; gate admin / supervisor only', async () => {
    const r = await rpc('admin', `SELECT public.audit_trail($1, $2) r`, [A, { table_name: 'organizations', limit: 1 }]);
    const r2 = r.next_before_id ? await rpc('admin', `SELECT public.audit_trail($1, $2) r`, [A, { table_name: 'organizations', limit: 1, before_id: r.next_before_id }]) : null;
    const e = [await code(() => rpc('bmJ', `SELECT public.audit_trail($1, '{}') r`, [A])), await code(() => rpc('acc', `SELECT public.audit_trail($1, '{}') r`, [A])),
      await code(() => rpc('staffB', `SELECT public.audit_trail($1, '{}') r`, [A])), await code(() => rpc('admin', `SELECT public.audit_trail($1, $2) r`, [A, { transaction_id: TX.tb.id }])),
      await code(() => rpc('admin', `SELECT public.audit_trail($1, $2) r`, [A, { table_name: 'Bad Name' }]))];
    return (r.items[0].label === 'settings.update' && (!r2 || r2.items.every(i => i.id < r.items[0].id))
      && J(e) === J(['MRS_FORBIDDEN role', 'MRS_FORBIDDEN role', 'MRS_FORBIDDEN role', 'MRS_NOT_FOUND transaction', 'MRS_INVALID table_name'])) || J({ r: r.items[0], e });
  });
  await check('regression: the transaction log = the same rows as the plain scan (transaction + child rows), paged by before_id, table filter port_appointments; served by audit_log_tx_child_idx', async () => {
    const want = (await q(`SELECT a.id FROM public.audit_log a WHERE a.org_id = $1 AND ((a.table_name = 'transactions' AND a.row_id = $2::text)
                             OR (a.table_name IN ('containers','port_appointments','transport_trips','customs_declarations','empty_return_proofs','billing_intents')
                                 AND coalesce(a.new_data, a.old_data) ->> 'transaction_id' = $2::text)) ORDER BY a.id DESC`, [A, TX.t1.id])).map(x => +x.id);
    const all = await rpc('sup', `SELECT public.audit_trail($1, $2) r`, [A, { transaction_id: TX.t1.id, limit: 200 }]);
    const p1 = await rpc('sup', `SELECT public.audit_trail($1, $2) r`, [A, { transaction_id: TX.t1.id, limit: 2 }]);
    const p2 = await rpc('sup', `SELECT public.audit_trail($1, $2) r`, [A, { transaction_id: TX.t1.id, limit: 2, before_id: p1.next_before_id }]);
    const ap = await rpc('sup', `SELECT public.audit_trail($1, $2) r`, [A, { transaction_id: TX.t1.id, table_name: 'port_appointments', limit: 200 }]);
    await raw(`SET enable_seqscan = off`);
    const plan = (await q(`EXPLAIN SELECT a.id FROM public.audit_log a WHERE a.org_id = $1
                             AND a.table_name IN ('containers','port_appointments','transport_trips','customs_declarations','empty_return_proofs','billing_intents')
                             AND (coalesce(a.new_data, a.old_data) ->> 'transaction_id') = $2`, [A, TX.t1.id])).map(r => r['QUERY PLAN']).join('\n');
    await raw(`RESET enable_seqscan`);
    const ids = r => r.items.map(i => +i.id);
    return (want.length >= 4 && J(ids(all)) === J(want) && J(ids(p1).concat(ids(p2))) === J(want.slice(0, 4)) && ap.items.length >= 1 && ap.items.every(i => i.table_name === 'port_appointments')
      && /audit_log_tx_child_idx/.test(plan)) || J({ want, all: ids(all), p1: ids(p1), p2: ids(p2), ap: ap.items.length, plan });
  });
  await check('labels by rule (payments, trips, appointments, declarations)', async () => {
    const x = await one(`SELECT app.audit_label_of('client_disbursements', 'UPDATE', ARRAY['review_status']) a, app.audit_label_of('client_disbursements', 'UPDATE', ARRAY['status','void_reason']) b,
                                app.audit_label_of('transport_trips', 'UPDATE', ARRAY['status']) c, app.audit_label_of('port_appointments', 'INSERT', NULL) d,
                                app.audit_label_of('customs_declarations', 'UPDATE', ARRAY['status']) e, app.audit_label_of('transactions', 'UPDATE', ARRAY['cancelled_at','operational_status']) f,
                                app.audit_label_of('x', 'DELETE', NULL) g`);
    return (x.a === 'payment.review' && x.b === 'payment.void' && x.c === 'trip.status' && x.d === 'appointment.add' && x.e === 'declaration.status'
      && x.f === 'tx.cancel' && x.g === 'row.delete') || J(x);
  });
}

/* ================================================================== 12. e-mail code login */
async function secOtp() {
  section('12. e-mail code login: OFF by default, org switch, otp_session_check, MFA unchanged');
  const chk = (who, claims) => rpc(who, `SELECT public.otp_session_check() r`, [], claims);
  const OTP = { amr: [{ method: 'otp', timestamp: 1 }], aal: 'aal1' };
  await check('password session: allowed (reason password); OTP session while the org switch is OFF → not allowed (org_disabled)', async () => {
    const a = await chk('jed', { amr: [{ method: 'password', timestamp: 1 }], aal: 'aal1' });
    const b = await chk('jed', OTP);
    return (a.otp_session === false && a.allowed && a.reason === 'password' && b.otp_session && !b.allowed && b.reason === 'org_disabled') || J({ a, b });
  });
  await check('the org-wide admin (aal2, reason) switches it on: staff OTP session allowed; portal-only user never; a member of another org with it OFF not allowed', async () => {
    const r = await rpc('admin', `SELECT public.set_email_otp_login($1, true, $2) r`, [A, 'تجربة الدخول بالرمز']);
    const a = await chk('jed', OTP);
    const p = await chk('portal', OTP);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'clearance_staff')`, [U.dmm, B]);
    const m = await chk('dmm', OTP);
    await q(`DELETE FROM public.memberships WHERE user_id = $1 AND org_id = $2`, [U.dmm, B]);
    return (r.email_otp_login === true && a.allowed && a.reason === 'ok' && !p.allowed && p.reason === 'no_staff_membership' && !m.allowed && m.reason === 'org_disabled') || J({ r, a, p, m });
  });
  await check('MFA unchanged: an admin OTP session is aal1 → mfa_pending, admin RPCs refused (MRS_MFA_REQUIRED)', async () => {
    const a = await chk('admin', OTP);
    const e = await code(() => rpc('admin', `SELECT public.set_email_otp_login($1, false, 'x') r`, [A], OTP));
    return (a.allowed && a.aal === 'aal1' && a.mfa_pending === true && e === 'MRS_MFA_REQUIRED aal2') || J({ a, e });
  });
  await check('refusals: supervisor / branch manager → owner_only; no reason; null enabled; switched OFF again', async () => {
    const e = [await code(() => rpc('sup', `SELECT public.set_email_otp_login($1, false, 'x') r`, [A])),
      await code(() => rpc('bmJ', `SELECT public.set_email_otp_login($1, false, 'x') r`, [A])),
      await code(() => rpc('admin', `SELECT public.set_email_otp_login($1, false, '  ') r`, [A])),
      await code(() => rpc('admin', `SELECT public.set_email_otp_login($1, NULL, 'x') r`, [A]))];
    const r = await rpc('admin', `SELECT public.set_email_otp_login($1, false, 'إيقاف') r`, [A]);
    return (J(e) === J(['MRS_FORBIDDEN owner_only', 'MRS_FORBIDDEN owner_only', 'MRS_NOTE_REQUIRED reason', 'MRS_REQUIRED enabled']) && r.email_otp_login === false) || J(e);
  });
}

/* ================================================================== 13. RLS / privileges */
async function secRls() {
  section('13. RLS / privileges: org B, client portal, anon, helpers');
  await check('the 10 RPCs: SECURITY DEFINER, search_path pinned, EXECUTE for authenticated only', async () => {
    const r = await q(`SELECT p.proname, p.prosecdef d, coalesce(p.proconfig::text, '') c, has_function_privilege('authenticated', p.oid, 'EXECUTE') au,
                              has_function_privilege('anon', p.oid, 'EXECUTE') an, has_function_privilege('service_role', p.oid, 'EXECUTE') sr
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1)`, [RPCS]);
    return (r.length === RPCS.length && r.every(x => x.d && /search_path=/.test(x.c) && x.au && !x.an && !x.sr)) || J(r);
  });
  await check('the step-8 helpers: not executable by anon / authenticated / service_role', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = ANY ($1)
                         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))`,
      [NEW_FNS.filter(x => x.startsWith('app.')).map(x => x.split('.')[1]).concat(['rpt_tx_match', 'rpt_tx_json', 'alert_causes'])]);
    return r.length === 0 || J(r);
  });
  await check('client portal user: every staff reader refused (nothing new for clients)', async () => {
    const e = [];
    for (const fn of ['dash_tx_counts', 'tx_attention', 'report_movements', 'report_payments', 'report_transactions', 'report_trips', 'audit_trail'])
      e.push(await code(() => R('portal', fn, {})));
    e.push(await code(() => rpc('portal', `SELECT public.get_status_aging_rules($1) r`, [A])));
    return e.every(x => /^MRS_FORBIDDEN/.test(x)) || J(e);
  });
  await check('org B admin on org A: refused everywhere; org A admin on org B: refused', async () => {
    const e = [];
    for (const fn of ['dash_tx_counts', 'tx_attention', 'report_movements', 'report_payments', 'audit_trail']) e.push(await code(() => R('staffB', fn, {})));
    e.push(await code(() => rpc('admin', `SELECT public.dash_tx_counts($1, '{}') r`, [B])));
    e.push(await code(() => rpc('staffB', `SELECT public.set_status_aging_rules($1, '{}', 'x') r`, [A])));
    return e.every(x => /^MRS_FORBIDDEN/.test(x)) || J(e);
  });
  await check('anon: no EXECUTE on any step-8 RPC', async () => {
    const e = [];
    for (const fn of RPCS) e.push(await code(() => as('anon', fn === 'otp_session_check' ? `SELECT public.otp_session_check()` : fn === 'report_fasah_scope'
      ? `SELECT public.report_fasah_scope($1, '{}', '[]')` : fn === 'get_status_aging_rules' ? `SELECT public.get_status_aging_rules($1)`
      : fn === 'set_status_aging_rules' ? `SELECT public.set_status_aging_rules($1, '{}', 'x')` : fn === 'set_email_otp_login'
      ? `SELECT public.set_email_otp_login($1, true, 'x')` : `SELECT public.${fn}($1, '{}')`, fn === 'otp_session_check' ? [] : [A])));
    return e.every(x => x === 'perm') || J(e);
  });
}

/* ================================================================== 14. static: supa.js + i18n */
async function secStatic() {
  section('14. supa.js wrappers, error messages');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
  const W = { dashTxCounts: 'dash_tx_counts', txAttention: 'tx_attention', reportMovements: 'report_movements', reportPayments: 'report_payments',
    reportFasahScope: 'report_fasah_scope', getStatusAgingRules: 'get_status_aging_rules', setStatusAgingRules: 'set_status_aging_rules',
    setEmailOtpLogin: 'set_email_otp_login', otpSessionCheck: 'otp_session_check', auditTrail: 'audit_trail' };
  await check('supa.js: one wrapper per RPC, exported on MarsaApi', () => {
    const miss = Object.entries(W).filter(([k, v]) => !new RegExp('function ' + k + '\\(').test(supa) || !supa.includes("'" + v + "'")
      || !new RegExp('\\b' + k + ': ' + k + '\\b').test(supa));
    return miss.length === 0 || 'missing: ' + miss.map(x => x[0]).join(', ');
  });
  await check('supa.js: the export log accepts the 4 new report kinds', () =>
    ["'movements'", "'payments'", "'tx_followup'", "'fasah_recon'"].every(k => /var EXPORT_REPORTS = \[[^\]]*/.exec(supa)[0].includes(k)) || 'EXPORT_REPORTS');
  const DETAILS = ['MRS_INVALID:aging_rule', 'MRS_INVALID:attention', 'MRS_INVALID:daftra_state', 'MRS_INVALID:port_code', 'MRS_INVALID:containers_range',
    'MRS_INVALID:value_range', 'MRS_INVALID:revenue_range', 'MRS_INVALID:return_scope', 'MRS_INVALID:movement_status', 'MRS_INVALID:scopes', 'MRS_TOO_LONG:nos',
    'MRS_INVALID:party_type', 'MRS_FORBIDDEN:role'];
  await check('error details: Arabic in supa.js codeDetails and Arabic + English in i18n.js', () => {
    const miss = DETAILS.filter(d => !supa.includes("'" + d + "'") || (i18n.split('cdetail_' + d.replace(':', '_') + ':').length - 1) < 2);
    return miss.length === 0 || 'missing: ' + miss.join(', ');
  });
}

/* ================================================================== main */
async function main() {
  db = new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
    for (const f of migFiles()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
    pass('loaded ' + migFiles().length + ' migrations + seed');
  } catch (e) { fail('load', errText(e)); return finish(); }
  try { await fixtures(); pass('fixtures'); } catch (e) { fail('fixtures', errText(e) + ' ' + (e.stack || '').split('\n')[1]); return finish(); }
  try { await payFixtures(); pass('payment fixtures'); } catch (e) { fail('payment fixtures', errText(e)); }
  for (const s of [secFile, secPreflight, secDash, secRegister, secMovements, secTrips, secPayments, secFasah, secAttention, secExport, secAudit, secOtp, secRls, secStatic]) {
    try { await s(); } catch (e) { fail(s.name, 'section threw: ' + errText(e)); }
  }
  finish();
}
function finish() {
  console.log('\n' + nPass + ' passed, ' + nFail + ' failed');
  if (nFail) { console.log('\nFailures:\n  ' + fails.join('\n  ')); process.exit(1); }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
