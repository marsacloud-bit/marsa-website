#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 9 (legacy data migration): migration 20261125000100_legacy_import.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).
  Invented data only (no legacy customer, no real name / phone / reference).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal / amr).

  Covers: file conventions + all_migrations.sql + docs + the owner decision line; preflight, re-run on itself (identical catalog),
  catalog delta; the parsers (Riyadh dates / Excel serials / Arabic-Indic digits / money / container lists / ports / statuses);
  staging (limits, dropped keys, idempotent re-staging, replaced rows); validation of every entity and every rule (customers,
  aliases, drivers, transactions incl. Ro-Ro, containers, movements, payments, custody), duplicates inside the file and against
  Marsa / earlier runs; the commit (dependency order, chunked + resumable, re-commit after a simulated timeout, idempotent,
  nothing approved / verified, lifecycle suppressed, legacy refs, audit with the run id); attention / alerts quiet for imported
  billed rows; the RHK- Daftra step (jobs queued, never linked); void (blocked by a later change / use, then succeeds; re-import
  after a void); scoping (owner only, aal2, branch admin / other roles / client portal / other org / anon refused); supa.js + i18n.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-import-sql-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261125000100_legacy_import.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

globalThis.fetch = async () => { throw new Error('network forbidden in legacy-import-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';
const B = 'a9dd0000-0000-4000-8000-0000000000b0';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const BR_B = 'a9dd0000-0000-4000-8000-0000000000b1';
const CL_B = 'a9dd0000-0000-4000-8000-0000000000b3';
const P = { op: 'a9d20000-0000-4000-8000-000000000001', carrier: 'a9d20000-0000-4000-8000-000000000003', sup: 'a9d20000-0000-4000-8000-000000000004' };
const U = {
  admin: 'a9df0000-0000-4000-8000-000000000001',    // admin of A, org-wide = the owner
  adminJ: 'a9df0000-0000-4000-8000-00000000000c',   // branch manager of A at JED (an admin cannot be branch-scoped)
  acc: 'a9df0000-0000-4000-8000-000000000004',      // accountant of A, org-wide
  jed: 'a9df0000-0000-4000-8000-000000000006',      // clearance_staff of A, JED
  sup: 'a9df0000-0000-4000-8000-000000000002',      // supervisor (org-wide)
  portal: 'a9df0000-0000-4000-8000-00000000000a',   // client user of CLIENT_A
  staffB: 'a9df0000-0000-4000-8000-00000000000b'    // admin of B
};

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn, claims) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else {
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
const num = async (sql, params) => +(await one(sql, params)).n;
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
async function raw(sql, params) {
  await db.exec(`SET session_replication_role = replica`);
  try { return await q(sql, params); } finally { await db.exec(`SET session_replication_role = origin`); }
}
const rpc = (who, sql, params, claims) => as(who, sql, params, claims).then(r => r[0].r);

// ISO 6346 check digit (the container numbers of the fixtures are valid unless a test says otherwise)
function iso(prefix4, six) {
  const v = prefix4 + six;
  const L = [10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38];
  let s = 0;
  for (let i = 0; i < 10; i++) { const c = v[i]; const n = /[0-9]/.test(c) ? +c : L[c.charCodeAt(0) - 65]; s += n * (1 << i); }
  return v + String((s % 11) % 10);
}
const C = { c1: iso('TSTU', '100001'), c2: iso('TSTU', '100002'), c3: iso('TSTU', '100003'), c4: iso('TSTU', '100004'), c5: iso('TSTU', '100005'),
  c6: iso('TSTU', '100006'), c7: iso('TSTU', '100007'), ex: iso('EXSU', '200001'), c8: iso('TSTU', '100008') };
const badDigit = (c) => c.slice(0, 10) + String((+c[10] + 1) % 10);

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
const RPCS = ['legacy_import_commit', 'legacy_import_create_run', 'legacy_import_daftra_candidates', 'legacy_import_dictionary', 'legacy_import_get_run',
  'legacy_import_list_rows', 'legacy_import_list_runs', 'legacy_import_queue_daftra', 'legacy_import_set_options', 'legacy_import_skip_rows',
  'legacy_import_stage', 'legacy_import_validate', 'legacy_import_void'];
const RECREATED = ['app.alert_causes', 'app.att_reasons', 'app.audit_label_of', 'app.auto_lifecycle_on', 'app.convert_delete_tables', 'app.daftra_apply_scan', 'app.rpt_tx_match'];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at)
    SELECT v.id::uuid, v.k || '@legacyimport.example.com', now() FROM (VALUES
      ('${U.admin}','admin'),('${U.adminJ}','adminj'),('${U.acc}','acc'),('${U.jed}','jed'),('${U.sup}','sup'),('${U.portal}','portal'),
      ('${U.staffB}','staffb')) v(id, k);
  INSERT INTO public.profiles (id, full_name) SELECT u.id, 'موظف ' || split_part(u.email, '@', 1) FROM auth.users u
   WHERE u.email LIKE '%@legacyimport.example.com' ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'legacyimport-org-b', 'مؤسسة ب', 'Legacy import org B', 'LIB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone, daftra_client_code) VALUES
    ('${CL_B}', '${B}', 'business', 'عميل المؤسسة ب', 'Org B client', '0509990001', '000186');
  INSERT INTO public.parties (id, org_id, kinds, name_ar, name_en) VALUES
    ('${P.op}', '${A}', ARRAY['terminal_operator'], 'مشغل محطة الاستيراد', 'Import Test Operator'),
    ('${P.carrier}', '${A}', ARRAY['carrier'], 'شركة النقل للاختبار', 'Import Test Transport'),
    ('${P.sup}', '${A}', ARRAY['supplier'], 'جهة الفاتورة للاختبار', 'Import Test Issuer');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.adminJ}', '${A}', '${JED}', 'branch_manager'), ('${U.acc}', '${A}', NULL, 'accountant'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.sup}', '${A}', NULL, 'supervisor'), ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
  UPDATE public.clients SET daftra_client_code = '000186' WHERE id = '${CLIENT_A}';
`;
const X = {};
async function fixtures() {
  await db.exec(FIXTURES);
  // a transaction already in Marsa (B/L + container) and a declaration number already used
  const t = await one(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, container_count, bl_number, port_code, declaration_no)
                       VALUES ($1, $2, $3, 'import', 'sea', 1, 'EXISTBL1', 'SAJED', 'DX500') RETURNING id, ref`, [A, JED, CLIENT_A]);
  await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, t.id, C.ex]);
  X.existTx = t;
  // a payment already in Marsa with SADAD no 880088 (duplicate reference)
  X.existPay = await rpc('acc', `SELECT public.record_payment_bundle($1, NULL) r`, [{ movement_type: 'org_paid', pattern: 'single',
    service_code: 'port_charges', transaction_id: t.id, paid_amount: 10, paid_at: '2026-11-01', funding_source: 'org_account', method: 'sadad',
    paying_account: 'Test Bank 01', sadad_number: '880088', beneficiary_party_id: P.sup }]);
}

/* ------------------------------------------------------------------ the legacy workbook (invented) */
const SHEETS = {
  customers: { sheet: 'دليل العملاء', rows: [
    { daftra_code: '5001', name_ar: 'شركة الأفق للاختبار', name_en: 'Ufuq Test Co', vat_number: '399999999999993', phone: '0551234567', port_category: 'ميناء', city: 'جدة' },
    { daftra_code: '5002', name_ar: 'مؤسسة النخبة للاختبار', vat_number: '123', phone: '12' },
    { daftra_code: '5001', name_ar: 'شركة الأفق مكرر' },
    { daftra_code: '000186', name_ar: 'اسم آخر لعميل موجود' },
    { notes: 'صف بلا اسم' },
    { daftra_code: 'A*B', name_ar: 'كود غير صالح' },
    { daftra_code: '5003', name_ar: 'شركة البيان للاختبار', status: 'موقوف' }] },
  aliases: { sheet: 'أسماء العملاء البديلة', rows: [
    { client_code: '5001', alias: 'UFUQ TRADING LLC', status: 'معتمد', confidence: '95%' },
    { client_name: 'شركة الأفق للاختبار', alias: 'Ufuq Trading', status: 'معتمد' },
    { client_code: '9999', alias: 'Ghost Importer' },
    { client_code: '5002', alias: 'Nukhba Old Name', status: 'مرفوض' }] },
  drivers: { sheet: 'السائقون', rows: [
    { name: 'سائق الاختبار الأول', phone: '0501112222', truck_plate: 'ABC 1234' },
    { name: 'سائق الاختبار الثاني', phone: '٠٥٠٣٣٣٤٤٤٤' },
    { name: 'سائق مكرر', phone: '0501112222' },
    { name: 'س' }] },
  transactions: { sheet: 'المعاملات', rows: [
    // T1 (row 1): name match to the customers row, 2 containers, released declaration, legacy «نشطة», Excel serial date, TASTO, RHK-
    { legacy_id: 'TX-0001', seq: '101', importer: 'شركة الأفق للاختبار', bl_number: 'blt 1', container_no: C.c1 + ', ' + C.c2.slice(0, 4) + ' ' + C.c2.slice(4),
      port: 'ميناء جدة الإسلامي', declaration_no: 'D9001', declaration_date: '03/11/2026', declaration_status: 'فسح كلي', operational_status: 'نشطة',
      created_at: '46329.5', transport_order_no: 'tasto 900001', transport_company: 'شركة النقل للاختبار', vessel: 'TEST VESSEL', operator: 'مشغل محطة الاستيراد',
      employee: 'موظف قديم', daftra_invoice_no: '000123', declaration_type: 'استيراد' },
    // T2: Ro-Ro, historically billed
    { legacy_id: 'TX-0002', seq: '102', client_code: '5002', importer: 'مؤسسة النخبة للاختبار', bl_number: 'BLT2', cargo_unit_type: 'مركبة Ro-Ro',
      chassis_no: 'jtd-123 456 789', plate_no: 'أ ب ج 123', port: 'SADMM', operational_status: 'تمت الفوترة', daftra_invoice_no: '000124' },
    // T3: under billing (container) → operationally complete + proof needed; Marsa client by code
    { legacy_id: 'TX-0003', seq: '103', client_code: '186', importer: 'غير مهم', bl_number: 'BLT3', container_no: C.c3, port: 'ميناء الملك عبدالعزيز بالدمام',
      operational_status: 'تحت الفوترة', branch: 'DMM' },
    // T4: duplicate of T1 inside the file (same B/L + container)
    { legacy_id: 'TX-0004', seq: '104', importer: 'شركة الأفق للاختبار', bl_number: 'BLT1', container_no: C.c1, port: 'SAJED' },
    // T5: already in Marsa (B/L + container)
    { legacy_id: 'TX-0005', seq: '105', client_code: '000186', bl_number: 'EXISTBL1', container_no: C.ex, port: 'SAJED' },
    // T6: malformed container
    { legacy_id: 'TX-0006', seq: '106', client_code: '000186', bl_number: 'BLT6', container_no: 'ABC123', port: 'SAJED' },
    // T7: wrong check digit (warning only)
    { legacy_id: 'TX-0007', seq: '107', client_code: '000186', bl_number: 'BLT7', container_no: badDigit(C.c7), port: 'SAJED' },
    // T8: unknown port
    { legacy_id: 'TX-0008', seq: '108', client_code: '000186', bl_number: 'BLT8', container_no: C.c8, port: 'ميناء القمر' },
    // T9: unknown client
    { legacy_id: 'TX-0009', seq: '109', importer: 'عميل لا يوجد', bl_number: 'BLT9', container_no: C.c4, port: 'SAJED' },
    // T10: bad TASTO
    { legacy_id: 'TX-0010', seq: '110', client_code: '000186', bl_number: 'BLT10', container_no: C.c5, port: 'SAJED', transport_order_no: 'TAS-1' },
    // T11: the declaration belongs to another Marsa transaction
    { legacy_id: 'TX-0011', seq: '111', client_code: '000186', bl_number: 'BLT11', container_no: C.c6, port: 'SAJED', declaration_no: 'dx500' },
    // T12: unknown branch; T13: no B/L
    { legacy_id: 'TX-0012', seq: '112', client_code: '000186', bl_number: 'BLT12', container_no: iso('TSTU', '100012'), port: 'SAJED', branch: 'XYZ' },
    { legacy_id: 'TX-0013', seq: '113', client_code: '000186', container_no: iso('TSTU', '100013'), port: 'SAJED' },
    // T14: containers come from the containers sheet only; T15: billed historical container transaction (movement deadline past)
    { legacy_id: 'TX-0014', seq: '114', client_code: '000186', bl_number: 'BLT14', port: 'SAJED', operational_status: 'جديد' },
    { legacy_id: 'TX-0015', seq: '115', client_code: '000186', bl_number: 'BLT15', container_no: iso('TSTU', '100015'), port: 'SAJED', operational_status: 'تمت الفوترة' }] },
  containers: { sheet: 'حاويات المعاملات', rows: [
    { legacy_id: 'CR-1', tx_legacy_id: 'TX-0014', container_no: iso('TSTU', '100014'), seal_no: 's-1', size_type: '40hc' },
    { legacy_id: 'CR-2', tx_legacy_id: 'TX-0001', container_no: C.c1 },
    { legacy_id: 'CR-3', tx_legacy_id: 'TX-9999', container_no: iso('TSTU', '100099') },
    { legacy_id: 'CR-4', tx_legacy_id: 'TX-0002', container_no: iso('TSTU', '100098') }] },
  movements: { sheet: 'حركة النقل', rows: [
    { legacy_id: 'MV-1', tx_legacy_id: 'TX-0001', container_no: C.c1, appointment_at: '05/11/2026 08:30 م', driver_name: 'سائق الاختبار الأول', driver_phone: '0501112222',
      truck_plate: 'ABC1234', status: 'تم النقل', destination: 'مستودع الاختبار', transport_value: '500', org_revenue: '700',
      return_deadline: '10/11/2026', returned_at: '09/11/2026', return_state: 'تمت الإعادة', appointment_ref: 'TAS12345678' },
    { legacy_id: 'MV-2', tx_legacy_id: 'TX-0001', container_no: C.c2, appointment_at: '2026-11-06 07:00', driver_name: 'سائق جديد ثالث',
      driver_phone: '0507778888', status: 'موعد مسجل', appointment_ref: 'REF-77' },
    { legacy_id: 'MV-3', tx_legacy_id: 'TX-0001', container_no: C.c1, appointment_at: '06/11/2026 09:00', appointment_ref: 'TAS12345678' },
    { legacy_id: 'MV-4', tx_legacy_id: 'TX-0001', container_no: iso('TSTU', '100077'), appointment_at: '06/11/2026 10:00' },
    { legacy_id: 'MV-5', tx_legacy_id: 'TX-0003', appointment_at: '07/11/2026 10:00', driver_name: 'سائق جديد ثالث', driver_phone: '0507778888', status: 'موعد مسجل — بيانات النقل ناقصة' },
    { legacy_id: 'MV-6', tx_legacy_id: 'TX-0003' },
    { legacy_id: 'MV-7', tx_legacy_id: 'TX-0015', return_deadline: '01/10/2026' }] },
  payments: { sheet: 'السدادات', rows: [
    { legacy_id: 'PAY-L1', tx_legacy_id: 'TX-0001', service_item: 'أجور الموانئ Port Charges', paid_amount: '150.50', paid_at: '02/11/2026',
      route: 'سددت المؤسسة عن العميل', sadad_number: '7001001', funding_source: 'حساب المؤسسة', paying_account: 'Test Bank 01', issuer: 'جهة الفاتورة للاختبار' },
    { legacy_id: 'PAY-L2', tx_legacy_id: 'TX-0001', service_item: '000177', paid_amount: '١٬٢٥٠٫٧٥', paid_at: '2026-11-03', movement_type: 'دفع العميل للجهة مباشرة',
      method: 'تحويل بنكي', bank_reference: 'tr 555', paying_account: 'Client Bank 02', issuer: 'جهة جديدة للاختبار' },
    { legacy_id: 'PAY-L3', tx_legacy_id: 'TX-0003', service_item: 'أجور التخليص', paid_amount: '300', paid_at: '01/11/2026', movement_type: 'استلمت المؤسسة من العميل',
      method: 'نقدي', receipt_no: 'RC-77' },
    { legacy_id: 'PAY-L4', tx_legacy_id: 'TX-0001', service_item: 'port_charges', paid_amount: '20', paid_at: '01/11/2026', route: 'سددت المؤسسة عن العميل',
      method: 'رقم سداد', sadad_number: '7001004', funding_source: 'غير محدد — سجل سابق', paying_account: 'Test Bank 01', issuer: 'جهة الفاتورة للاختبار' },
    { legacy_id: 'PAY-L5', tx_legacy_id: 'TX-0001', service_item: 'port_charges', paid_amount: '20', paid_at: '01/11/2026', pattern: 'مشترك', route: 'سداد مشترك', sadad_number: '7001005' },
    { legacy_id: 'PAY-L6', tx_legacy_id: 'TX-0001', service_item: 'port_charges', paid_amount: '30', paid_at: '01/11/2026', route: 'سددت المؤسسة عن العميل',
      sadad_number: '7001001', funding_source: 'حساب المؤسسة', paying_account: 'Test Bank 01', issuer: 'جهة الفاتورة للاختبار' },
    { legacy_id: 'PAY-L7', tx_legacy_id: 'TX-0001', service_item: 'port_charges', paid_amount: '30', paid_at: '01/01/2099', route: 'سددت المؤسسة عن العميل',
      sadad_number: '7001007', funding_source: 'حساب المؤسسة', paying_account: 'Test Bank 01', issuer: 'جهة الفاتورة للاختبار' },
    { legacy_id: 'PAY-L8', tx_legacy_id: 'TX-0003', service_item: 'port_charges', paid_amount: '30', paid_at: '01/11/2026', route: 'سددت المؤسسة عن العميل',
      sadad_number: '880088', funding_source: 'حساب المؤسسة', paying_account: 'Test Bank 01', issuer: 'جهة الفاتورة للاختبار' },
    { legacy_id: 'PAY-L9', tx_legacy_id: 'TX-0001', service_item: 'بند لا يوجد', paid_amount: 'abc', paid_at: 'غدًا' }] },
  custody: { sheet: 'عهدة العملاء', rows: [
    { legacy_id: 'CUS-L1', client_name: 'شركة الأفق للاختبار', kind: 'إيداع عهدة', amount: '1000', entry_date: '01/10/2026' },
    { legacy_id: 'CUS-L2', client_name: 'شركة الأفق للاختبار', kind: 'خصم من العهدة', amount: '250' },
    { legacy_id: 'CUS-L3', client_name: 'شركة الأفق للاختبار', kind: 'إيداع عهدة', amount: '500', status: 'ملغي' },
    { legacy_id: 'CUS-L4', client_code: '5002', client_name: 'مؤسسة النخبة للاختبار', kind: 'إيداع عهدة', amount: '100' },
    { legacy_id: 'CUS-L5', client_code: '5002', client_name: 'مؤسسة النخبة للاختبار', kind: 'إرجاع عهدة', amount: '300' }] }
};
const ENTS = ['customers', 'aliases', 'drivers', 'transactions', 'containers', 'movements', 'payments', 'custody'];
const sha = n => require('crypto').createHash('sha256').update(String(n)).digest('hex');
async function createRun(who, payload, claims) {
  return rpc(who || 'admin', `SELECT public.legacy_import_create_run($1, $2, NULL) r`, [A, Object.assign({ branch_id: JED, entities: ENTS,
    files: [{ name: 'legacy-export.xlsx', sha256: sha('legacy'), size: 12345, sheets: Object.values(SHEETS).map(s => s.sheet) }],
    reason: 'استيراد بيانات النظام القديم (اختبار)' }, payload || {})], claims);
}
const stage = (run, ent, rows, who, sheet) => rpc(who || 'admin', `SELECT public.legacy_import_stage($1, $2) r`,
  [run, { entity: ent, sheet: sheet || SHEETS[ent].sheet, rows: rows.map((d, i) => ({ row_no: i + 2, data: d })) }]);
async function validateAll(run, limit) {
  let r, n = 0;
  do { r = await rpc('admin', `SELECT public.legacy_import_validate($1, $2) r`, [run, { limit: limit || 500 }]); n++; } while (!r.done && n < 200);
  return r;
}
async function commitAll(run, limit) {
  let r, n = 0;
  do { r = await rpc('admin', `SELECT public.legacy_import_commit($1, $2) r`, [run, { limit: limit || 200, confirm: true }]); n++; } while (!r.done && n < 400);
  return r;
}
async function voidAll(run, reason, limit) {
  let r, n = 0;
  do { r = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [run, reason, limit ? { limit } : {}]); n++; } while (!r.done && n < 400);
  r.calls = n;
  return r;
}
const rows = (run, ent) => q(`SELECT * FROM public.legacy_import_rows WHERE run_id = $1 AND entity = $2 ORDER BY sheet, row_no`, [run, ent]);
const rowAt = async (run, ent, rowNo) => one(`SELECT * FROM public.legacy_import_rows WHERE run_id = $1 AND entity = $2 AND row_no = $3`, [run, ent, rowNo]);
const codes = r => (r.messages || []).map(m => m.code);
const hasMsg = (r, level, c) => (r.messages || []).some(m => m.level === level && m.code === c);

/* ================================================================== 1. file */
async function secFile() {
  section('1. file conventions, all_migrations.sql, docs, owner decisions');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('migration present, UTF-8 guard, preflight on 20261124000100, schema_versions row', () =>
    (src.includes("'جديد' <> U&'\\062C\\062F\\064A\\062F'") && src.includes("version = '20261124000100'")
     && src.includes("VALUES ('20261125000100', 'legacy_import')")) || 'header');
  await check('no secret / personal data / legacy organization name or customer seed copied', () =>
    (!/@[a-z0-9-]+\.[a-z]/i.test(src.replace(/--.*$/gm, '')) && !/\b05[0-9]{8}\b/.test(src) && !/رأس الحكمة/.test(src)
     && !/sk-ant|apikey|api_key\s*=/i.test(src) && !/upgradeToV|seedCustomerDirectory/.test(src)) || 'personal data');
  await check('every SECURITY DEFINER function pins search_path', () => {
    const bad = (src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$/g) || []).filter(f => /SECURITY DEFINER/.test(f) && !/SET search_path = ''/.test(f));
    return bad.length === 0 || bad.map(b => b.slice(0, 80)).join(' | ');
  });
  await check('never approves / verifies: no approved review, no returned_verified, no proof insert, no billing intent insert, no net call', () =>
    (!/review_status\s*=\s*'approved'|'approved'\s*,\s*auth\.uid/.test(src) && !/return_status\s*=\s*'returned_verified'/.test(src)
     && !/INSERT INTO public\.(empty_return_proofs|billing_intents|client_charges)/.test(src) && !/net\.http|functions\.invoke/.test(src)
     && /'suggested'/.test(src) && /'review_status', 'pending'/.test(src)) || 'approval');
  // later phases may follow this file (20261126000100 doc_match_packing: document_matches.packing_extraction_id; no import object)
  const LATER_PHASES = ['20261126000100_doc_match_packing.sql', '20261127000100_tx_draft_approval.sql', '20261128000100_return_extension.sql'];
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
  await check('docs/online/LEGACY_IMPORT_AR.md names the migration, the RPCs, the headers and the safety rules', () => {
    const p = path.join(ROOT, 'docs', 'online', 'LEGACY_IMPORT_AR.md');
    if (!fs.existsSync(p)) return 'missing';
    const d = fs.readFileSync(p, 'utf8');
    const miss = [MIG, ...RPCS, 'MRS_LI_VOID_BLOCKED', 'RHK', 'Asia/Riyadh', 'دليل العملاء', 'حركة النقل', 'السدادات', 'عهدة العملاء'].filter(k => !d.includes(k));
    return miss.length === 0 || 'missing: ' + miss.join(', ');
  });
  await check('the plan records the step-9 defaults as a dated owner-decision line', () => {
    const d = fs.readFileSync(path.join(ROOT, 'docs', 'online', 'LEGACY_PORT_PLAN_AR.md'), 'utf8');
    const i = d.indexOf('## قرارات المالك'), j = d.indexOf('## ترتيب البناء');
    return (i > 0 && /\(2026-11-11\)[^\n]*مرحلة 9/.test(d.slice(i, j)) && d.slice(i, j).includes(MIG)) || 'no step-9 line';
  });
}

/* ================================================================== 2. preflight, re-run, catalog */
async function secPreflight() {
  section('2. preflight, re-run on itself, catalog delta');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const d = await freshDb(MIG);
  try {
    const before = await withDb(d, catalog);
    await check('preflight: refused on a database without legacy_reports (nothing changed)', async () => {
      const e = await withDb(d, async () => {
        await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261124000100'`);
        try { await db.exec(src); return 'applied'; } catch (x) { return x.message; } finally {
          await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261124000100', 'legacy_reports')`);
        }
      });
      const same = J(await withDb(d, catalog)) === J(before);
      return (/LEGACY IMPORT preflight: apply legacy_reports first/.test(e) && same) || e;
    });
    await withDb(d, () => db.exec(src));
    const after = await withDb(d, catalog);
    await check('re-run on itself: identical catalog (functions, ACLs, constraints, indexes, triggers, policies, labels, grants)', async () => {
      await withDb(d, () => db.exec(src));
      const again = await withDb(d, catalog);
      const keys = Object.keys(after).filter(k => J(after[k]) !== J(again[k]));
      return keys.length === 0 || 'changed: ' + keys.join(', ');
    });
    await check('catalog delta: 2 tables, the RPCs + app.li_* helpers, the re-created bodies (ACL kept), 3 columns on transactions, 1 trigger', () => {
      const sig = x => x.sig.split('(')[0];
      const added = [...new Set(after.fns.map(sig).filter(s => !before.fns.map(sig).includes(s)))].sort();
      const changed = [...new Set(after.fns.filter(f => { const p = before.fns.find(x => x.sig === f.sig); return p && (p.h !== f.h || p.acl !== f.acl); }).map(sig))].sort();
      const aclKept = after.fns.filter(f => RECREATED.includes(sig(f))).every(f => (before.fns.find(x => x.sig === f.sig) || {}).acl === f.acl);
      const tables = after.tables.filter(t => !before.tables.includes(t));
      const cols = after.cols.filter(c => !before.cols.includes(c) && !/^legacy_import_/.test(c));
      const trg = after.trg.filter(t => !before.trg.includes(t));
      const pubs = added.filter(x => x.startsWith('public.')).map(x => x.slice(7)).sort();
      const nonLi = added.filter(x => x.startsWith('app.') && !/^app\.(li_|tg_transactions_li_guard)/.test(x));
      return (J(tables) === J(['public.legacy_import_rows', 'public.legacy_import_runs']) && J(pubs) === J(RPCS) && nonLi.length === 0
        && J(changed) === J(RECREATED) && aclKept && J(cols) === J(['transactions.import_run_id', 'transactions.legacy_created_at', 'transactions.legacy_ref'])
        && J(trg) === J(['legacy_import_rows.trg_audit', 'legacy_import_rows.trg_touch', 'legacy_import_runs.trg_audit', 'legacy_import_runs.trg_touch', 'transactions.trg_li_guard']))
        || J({ tables, pubs, nonLi, changed, aclKept, cols, trg });
    });
    await check('dictionaries: entity / status / message labels internal (client_visible false), Arabic + English', async () => {
      const r = await withDb(d, () => one(`SELECT count(*)::int n, count(*) FILTER (WHERE client_visible)::int v, count(*) FILTER (WHERE label_ar = '' OR coalesce(label_en, '') = '')::int e,
                                                count(*) FILTER (WHERE domain = 'li_message')::int m
                                            FROM public.status_labels WHERE domain IN ('li_entity','li_run_status','li_row_status','li_message')
                                               OR (domain = 'audit_label' AND code LIKE 'legacy_import.%')`));
      return (r.v === 0 && r.e === 0 && r.m >= 80 && r.n === 8 + 7 + 7 + r.m + 2) || J(r);
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. parsers */
async function secParsers() {
  section('3. parsers: Riyadh dates, Excel serials, Arabic-Indic digits, money, containers, ports, statuses');
  const v = async (sql) => (await one(`SELECT (${sql})::text v`)).v;
  await check('li_ts: dd/mm/yyyy hh:mm م = Riyadh wall time (17:30Z); ص; ISO without zone = Riyadh; ISO with Z kept', async () =>
    (await v(`app.li_ts('05/11/2026 08:30 م') = '2026-11-05 17:30:00+00'`)) === 'true'
    && (await v(`app.li_ts('05/11/2026 12:15 ص') = '2026-11-04 21:15:00+00'`)) === 'true'
    && (await v(`app.li_ts('2026-11-06 07:00') = '2026-11-06 04:00:00+00'`)) === 'true'
    && (await v(`app.li_ts('2026-11-03T21:30:00Z') = '2026-11-03 21:30:00+00'`)) === 'true' || 'ts');
  await check('li_ts / li_date: Excel serial 46329.5 = 2026-11-03 12:00 Riyadh; its date 2026-11-03; Arabic-Indic digits; 2026م', async () =>
    (await v(`app.li_ts('46329.5') = '2026-11-03 09:00:00+00'`)) === 'true' && (await v(`app.li_date('46329.5')`)) === '2026-11-03'
    && (await v(`app.li_date('٠٣/١١/٢٠٢٦')`)) === '2026-11-03' && (await v(`app.li_date('3-11-2026م')`)) === '2026-11-03' || 'serial');
  await check('li_date: a date is never shifted; an ISO instant = its Riyadh day (21:30Z → next day); Hijri / garbage → NULL', async () =>
    (await v(`app.li_date('2026-11-03')`)) === '2026-11-03' && (await v(`app.li_date('2026-11-03T21:30:00Z')`)) === '2026-11-04'
    && (await v(`app.li_date('1446/05/01')`)) === null && (await v(`app.li_date('31/02/2026')`)) === null && (await v(`app.li_date('غدًا')`)) === null
    && (await v(`app.li_ts('1446/05/01 10:00')`)) === null || 'date');
  await check('li_money: Arabic digits / ٫ / ٬ / SAR / ر.س; spreadsheet float noise rounded; text → NaN', async () =>
    (await v(`app.li_money('١٬٢٥٠٫٧٥')`)) === '1250.75' && (await v(`app.li_money('1,250.5 SAR')`)) === '1250.50'
    && (await v(`app.li_money('150.50000000001')`)) === '150.50' && (await v(`app.li_money('300 ر.س')`)) === '300.00'
    && (await v(`app.li_money('abc')`)) === 'NaN' && (await v(`app.li_money('')`)) === null || 'money');
  await check('li_containers: several numbers in one cell (space / dash / comma), residue detected', async () =>
    (await v(`app.li_containers('tstu 1000016, TSTU-1000021')`)) === '{TSTU1000016,TSTU1000021}'
    && (await v(`app.li_containers_rest('TSTU1000016 / TSTU1000021')`)) === 'false' && (await v(`app.li_containers_rest('ABC123')`)) === 'true' || 'containers');
  await check('harness fix: li_containers reads the printed ISO form with the check digit apart («TEMU 920200 8», «TEMU-920200-8»); a short number stays a residue', async () =>
    (await v(`app.li_containers('TEMU 920200 8')`)) === '{TEMU9202008}' && (await v(`app.li_containers_rest('TEMU 920200 8')`)) === 'false'
    && (await v(`app.li_containers('temu-920200-8, TSTU 1000016')`)) === '{TEMU9202008,TSTU1000016}'
    && (await v(`app.li_containers_rest('MSCU12345')`)) === 'true' && (await v(`app.li_date('07/11/2026 م')`)) === '2026-11-07' || 'printed');
  await check('ports: legacy Arabic names / codes → approved port codes; unknown → NULL; statuses legacy → Marsa', async () => {
    const r = await one(`SELECT app.li_port(x, 'ميناء جدة الإسلامي') a, app.li_port(x, 'sadmm') b, app.li_port(x, 'مطار الملك خالد الدولي بالرياض') c,
                                app.li_port(x, 'ميناء القمر') d, app.li_tx_status('تمت الفوترة') e, app.li_tx_status('منتهية تشغيليًا') f,
                                app.li_tx_status('نشطة') g, app.li_mv_status('موعد مسجل — بيانات النقل ناقصة') h, app.li_mv_status('تم النقل') i,
                                app.li_pay_method('غير محدد — سجل سابق') j, app.li_pay_funding('محفظة الميناء الجاف — تمويل المؤسسة') k,
                                app.li_cargo('مركبة Ro-Ro') l
                           FROM (SELECT (ROW(gen_random_uuid(), '${A}', 'LIR-000000', NULL, ARRAY['customers'], 'draft', 'xxx', '[]', '{}', '{}', '{}', '{}',
                                     gen_random_uuid(), now(), now(), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::public.legacy_import_runs) x) z`);
    return (r.a === 'SAJED' && r.b === 'SADMM' && r.c === 'SARUH-AIR' && r.d === null && r.e === 'billed' && r.f === 'operationally_complete'
      && r.g === 'active' && r.h === 'incomplete' && r.i === 'delivered' && r.j === null && r.k === 'dry_port_wallet_org' && r.l === 'roro') || J(r);
  });
}

/* ================================================================== 4. scoping */
async function secScope() {
  section('4. scoping: owner only (org-wide admin, aal2), reason, one open run per org');
  await check('branch admin / accountant / supervisor / clearance: MRS_FORBIDDEN owner_only; portal: MRS_FORBIDDEN; anon: permission denied', async () => {
    const e = [];
    for (const w of ['adminJ', 'acc', 'sup', 'jed', 'portal']) e.push(await code(() => createRun(w)));
    e.push(await code(() => as('anon', `SELECT public.legacy_import_create_run($1, '{}', NULL) r`, [A])));
    return J(e) === J(['MRS_FORBIDDEN owner_only', 'MRS_FORBIDDEN owner_only', 'MRS_FORBIDDEN owner_only', 'MRS_FORBIDDEN owner_only', 'MRS_FORBIDDEN owner_only', 'perm']) || J(e);
  });
  await check('the owner at aal1 → MRS_MFA_REQUIRED; org B admin on org A → MRS_FORBIDDEN', async () => {
    const e1 = await code(() => createRun('admin', {}, { aal: 'aal1' }));
    const e2 = await code(() => rpc('staffB', `SELECT public.legacy_import_create_run($1, $2, NULL) r`, [A, { entities: ['customers'], reason: 'xxx' }]));
    return (e1 === 'MRS_MFA_REQUIRED aal2' && e2 === 'MRS_FORBIDDEN owner_only') || J({ e1, e2 });
  });
  await check('payload checks: reason required, entities, files ≤ 20 / sha256 / ≤ 10 MB, foreign branch, mapping of another org', async () => {
    const e = [await code(() => createRun('admin', { reason: ' ' })), await code(() => createRun('admin', { entities: ['bogus'] })),
      await code(() => createRun('admin', { files: Array.from({ length: 21 }, (_, i) => ({ name: 'f' + i, sha256: sha(i) })) })),
      await code(() => createRun('admin', { files: [{ name: 'a.xlsx', sha256: 'zz' }] })),
      await code(() => createRun('admin', { files: [{ name: 'a.xlsx', sha256: sha(1), size: 10485761 }] })),
      await code(() => createRun('admin', { branch_id: BR_B })),
      await code(() => createRun('admin', { mapping: { clients: { 'اسم': CL_B } } })),
      await code(() => createRun('admin', { options: { default_funding_source: 'client_direct' } }))];
    return J(e) === J(['MRS_NOTE_REQUIRED reason', 'MRS_INVALID entities', 'MRS_LI_LIMIT files', 'MRS_INVALID files', 'MRS_LI_LIMIT file_bytes',
      'MRS_INVALID branch_id', 'MRS_INVALID mapping_client', 'MRS_INVALID default_funding_source']) || J(e);
  });
}

/* ================================================================== 5. staging */
let RUN;
async function secStage() {
  section('5. staging: chunks, limits, dropped keys, idempotent re-staging');
  RUN = await createRun('admin');
  await check('a run is created: LIR- ref, draft, entities in dependency order, files kept; a second open run → MRS_LI_STATE open_run', async () => {
    const e = await code(() => createRun('admin'));
    return (/^LIR-\d{6}$/.test(RUN.ref) && RUN.status === 'draft' && J(RUN.entities) === J(ENTS) && RUN.files.length === 1 && e === 'MRS_LI_STATE open_run') || J({ RUN, e });
  });
  for (const ent of ENTS) await stage(RUN.id, ent, SHEETS[ent].rows);
  await check('stage: every row staged once (empty values dropped), status staged, counts per entity', async () => {
    const r = await rpc('admin', `SELECT public.legacy_import_get_run($1) r`, [RUN.id]);
    const total = Object.values(SHEETS).reduce((a, s) => a + s.rows.length, 0);
    return (r.status === 'staged' && r.counts.total === total && r.counts.by_entity.transactions.total === SHEETS.transactions.rows.length) || J(r.counts);
  });
  await check('re-staging the same chunk is a no-op (unchanged = n, no new row)', async () => {
    const r = await stage(RUN.id, 'customers', SHEETS.customers.rows);
    return (r.inserted === 0 && r.unchanged === SHEETS.customers.rows.length && r.run.counts.total === Object.values(SHEETS).reduce((a, s) => a + s.rows.length, 0)) || J(r);
  });
  await check('unknown keys are dropped (counted); a changed row of the same sheet + row no replaces the pending one', async () => {
    const r = await stage(RUN.id, 'drivers', [SHEETS.drivers.rows[0], SHEETS.drivers.rows[1], SHEETS.drivers.rows[2], { name: 'سائق رابع', __proto__x: 'x', evil: '=HYPERLINK()' }]);
    const r2 = await stage(RUN.id, 'drivers', SHEETS.drivers.rows);
    return (r.dropped_keys === 2 && r.replaced === 1 && r2.replaced === 1 && (await num(`SELECT count(*) n FROM public.legacy_import_rows WHERE run_id = $1 AND entity = 'drivers'`, [RUN.id])) === 4) || J({ r, r2 });
  });
  await check('limits: > 500 rows per call, a value > 2000 chars, an object value, an entity outside the run → refused', async () => {
    const e = [await code(() => stage(RUN.id, 'drivers', Array.from({ length: 501 }, (_, i) => ({ name: 'n' + i })))),
      await code(() => stage(RUN.id, 'drivers', [{ name: 'x'.repeat(2001) }])),
      await code(() => stage(RUN.id, 'drivers', [{ name: { a: 1 } }])),
      await code(() => rpc('admin', `SELECT public.legacy_import_stage($1, $2) r`, [RUN.id, { entity: 'bogus', rows: [] }]))];
    return J(e) === J(['MRS_LI_LIMIT rows_per_call', 'MRS_TOO_LONG value', 'MRS_INVALID value', 'MRS_INVALID entity']) || J(e);
  });
  await check('the staged rows: owner reads them (RLS); clearance / portal / org B see none', async () => {
    const o = (await as('admin', `SELECT count(*)::int n FROM public.legacy_import_rows`))[0].n;
    const j = (await as('jed', `SELECT count(*)::int n FROM public.legacy_import_rows`))[0].n;
    const p = (await as('portal', `SELECT count(*)::int n FROM public.legacy_import_runs`))[0].n;
    const b = (await as('staffB', `SELECT count(*)::int n FROM public.legacy_import_rows`))[0].n;
    return (o > 30 && j === 0 && p === 0 && b === 0) || J({ o, j, p, b });
  });
}

/* ================================================================== 6. validation */
async function secValidate() {
  section('6. validation: every entity, every rule, duplicates inside the file and against Marsa');
  await check('chunked validation (limit 7) completes in dependency order and the run is validated', async () => {
    const r = await validateAll(RUN.id, 7);
    return (r.done && r.run.status === 'validated' && r.run.pending === 0) || J(r.run);
  });
  const cu = await rows(RUN.id, 'customers');
  await check('customers: valid, warnings (VAT / phone dropped), duplicate in file, exists in Marsa (code 000186), name required, bad code, inactive', () =>
    (cu[0].status === 'valid' && cu[0].normalized.code === '005001' && cu[0].normalized.port_category === 'port'
     && cu[1].status === 'warning' && hasMsg(cu[1], 'warning', 'vat_invalid') && hasMsg(cu[1], 'warning', 'phone_invalid') && !cu[1].normalized.vat_number
     && cu[2].status === 'duplicate' && hasMsg(cu[2], 'warning', 'duplicate_in_file')
     && cu[3].status === 'duplicate' && hasMsg(cu[3], 'info', 'exists_in_marsa') && cu[3].normalized.match_id === CLIENT_A
     && cu[4].status === 'error' && hasMsg(cu[4], 'error', 'name_required') && cu[5].status === 'error' && hasMsg(cu[5], 'error', 'daftra_code_invalid')
     && cu[6].status === 'valid' && cu[6].normalized.is_active === false) || J(cu.map(r => [r.status, codes(r)])));
  const al = await rows(RUN.id, 'aliases');
  await check('aliases: suggested (never approved), same alias twice → duplicate, unknown client → error, legacy rejected → skipped', () =>
    (al[0].status === 'valid' && hasMsg(al[0], 'info', 'alias_suggested') && al[0].normalized.client_row === cu[0].id && al[0].normalized.confidence === 95
     && al[1].status === 'duplicate' && al[2].status === 'error' && hasMsg(al[2], 'error', 'client_not_found') && al[3].status === 'skipped')
    || J(al.map(r => [r.status, codes(r), r.normalized])));
  const dr = await rows(RUN.id, 'drivers');
  await check('drivers: phones normalised (Arabic-Indic), truck to add, duplicate phone, name too short', () =>
    (dr[0].status === 'valid' && dr[0].normalized.plate === 'ABC1234' && hasMsg(dr[0], 'info', 'truck_created') && dr[1].normalized.phone === '0503334444'
     && dr[2].status === 'duplicate' && dr[3].status === 'error') || J(dr.map(r => [r.status, codes(r), r.normalized])));
  const tx = await rows(RUN.id, 'transactions');
  const T = i => tx[i - 1];
  await check('T1: client = the customers row (name), 2 containers parsed, port, declaration released, legacy «نشطة» → customs_declaration, TASTO, carrier, operator, Excel date', () =>
    (T(1).status === 'valid' && T(1).normalized.client_row === cu[0].id && J(T(1).normalized.containers) === J([C.c1, C.c2]) && T(1).normalized.bl_number === 'BLT1'
     && T(1).normalized.port_code === 'SAJED' && T(1).normalized.declaration_status === 'released' && T(1).normalized.operational_status === 'customs_declaration'
     && T(1).normalized.transport_order_no === 'TASTO900001' && T(1).normalized.transport_mode === 'carrier_order' && T(1).normalized.transport_party_id === P.carrier
     && T(1).normalized.terminal_party_id === P.op && T(1).normalized.legacy_ref === '101' && T(1).normalized.daftra.number === '000123' && hasMsg(T(1), 'info', 'created_at_kept')
     && new Date(T(1).normalized.created_at).toISOString() === '2026-11-03T09:00:00.000Z' && T(1).normalized.declaration_date === '2026-11-03')
    || J([T(1).status, codes(T(1)), T(1).normalized]));
  await check('T2: Ro-Ro chassis normalised (A-Z0-9), plate, port code, «تمت الفوترة» → billed + invoiced (historical, info)', () =>
    (T(2).status === 'valid' && T(2).normalized.cargo_unit_type === 'roro' && T(2).normalized.chassis_no === 'JTD123456789' && T(2).normalized.vehicle_plate_no
     && T(2).normalized.operational_status === 'billed' && T(2).normalized.financial_status === 'invoiced' && hasMsg(T(2), 'info', 'status_billed_historical')
     && T(2).normalized.client_row === cu[1].id) || J([T(2).status, codes(T(2)), T(2).normalized]));
  await check('T3: «تحت الفوترة» of a container transaction → operationally_complete + needs the empty-return proof (warning); branch DMM; code 186 → 000186', () =>
    (T(3).status === 'warning' && T(3).normalized.operational_status === 'operationally_complete' && hasMsg(T(3), 'warning', 'needs_empty_return_proof')
     && T(3).normalized.branch_id === DMM && T(3).normalized.client_id === CLIENT_A && T(3).normalized.port_code === 'SADMM') || J([T(3).status, codes(T(3)), T(3).normalized]));
  await check('T4 duplicate in file (B/L + container); T5 already in Marsa (B/L + container, step-2 guard)', () =>
    (T(4).status === 'duplicate' && hasMsg(T(4), 'warning', 'duplicate_in_file') && T(5).status === 'duplicate' && hasMsg(T(5), 'info', 'exists_in_marsa')
     && T(5).normalized.match_id === X.existTx.id) || J([codes(T(4)), codes(T(5))]));
  await check('T6 malformed container (error); T7 wrong ISO 6346 check digit (warning only); T8 unknown port; T9 unknown client', () =>
    (T(6).status === 'error' && hasMsg(T(6), 'error', 'container_format') && T(7).status === 'warning' && hasMsg(T(7), 'warning', 'container_check_digit')
     && T(8).status === 'error' && hasMsg(T(8), 'error', 'port_unknown') && T(9).status === 'error' && hasMsg(T(9), 'error', 'client_not_found'))
    || J([6, 7, 8, 9].map(i => [T(i).status, codes(T(i))])));
  await check('T10 bad TASTO; T11 declaration of another Marsa transaction; T12 unknown branch; T13 no B/L; T14 containers only from the containers sheet', () =>
    (T(10).status === 'error' && hasMsg(T(10), 'error', 'transport_order_invalid') && T(11).status === 'error' && hasMsg(T(11), 'error', 'declaration_taken')
     && T(12).status === 'error' && hasMsg(T(12), 'error', 'branch_unknown') && T(13).status === 'error' && hasMsg(T(13), 'error', 'bl_required')
     && T(14).status === 'valid' && T(14).normalized.operational_status === 'new') || J([10, 11, 12, 13, 14].map(i => [T(i).status, codes(T(i))])));
  const ct = await rows(RUN.id, 'containers');
  await check('containers: to a run transaction; the same container as the transaction row → duplicate; unknown transaction; Ro-Ro refused', () =>
    (ct[0].status === 'valid' && ct[0].normalized.tx_row === T(14).id && ct[0].normalized.seal_no === 'S-1' && ct[1].status === 'duplicate'
     && ct[2].status === 'error' && hasMsg(ct[2], 'error', 'transaction_not_found') && ct[3].status === 'error' && hasMsg(ct[3], 'error', 'roro_no_container'))
    || J(ct.map(r => [r.status, codes(r)])));
  const mv = await rows(RUN.id, 'movements');
  await check('movements: Riyadh appointment time, delivered trip with value / revenue, driver = the drivers row, return data kept (no proof), TAS', () =>
    (mv[0].status === 'valid' && new Date(mv[0].normalized.appointment_at).toISOString() === '2026-11-05T17:30:00.000Z' && mv[0].normalized.movement_status === 'delivered'
     && mv[0].normalized.cost_amount === 500 && mv[0].normalized.sell_amount === 700 && mv[0].normalized.driver_row === dr[0].id
     && mv[0].normalized.appointment_no === 'TAS12345678' && mv[0].normalized.return_deadline === '2026-11-10' && hasMsg(mv[0], 'info', 'returned_recorded_no_proof'))
    || J([mv[0].status, codes(mv[0]), mv[0].normalized]));
  await check('movements: new driver (info), non-TAS reference kept as booking ref (warning), same TAS twice → duplicate, foreign container, incomplete, empty', () =>
    (mv[1].status === 'warning' && hasMsg(mv[1], 'info', 'driver_created') && mv[1].normalized.booking_ref === 'REF-77' && mv[1].normalized.driver_new === true
     && mv[2].status === 'duplicate' && mv[3].status === 'error' && hasMsg(mv[3], 'error', 'container_not_on_transaction')
     && mv[4].normalized.movement_status === 'incomplete' && mv[4].normalized.container_no === C.c3 && mv[5].status === 'error' && hasMsg(mv[5], 'error', 'movement_empty'))
    || J(mv.map(r => [r.status, codes(r)])));
  const pa = await rows(RUN.id, 'payments');
  await check('payments: method inferred from the SADAD no, funding mapped, beneficiary party found; Arabic money; client-direct bank transfer + new party; received cash', () =>
    (pa[0].status === 'valid' && pa[0].normalized.method === 'sadad' && hasMsg(pa[0], 'info', 'method_inferred') && pa[0].normalized.funding_source === 'org_account'
     && pa[0].normalized.beneficiary_party_id === P.sup && hasMsg(pa[0], 'info', 'payment_pending_review')
     && pa[1].status === 'valid' && pa[1].normalized.paid_amount === 1250.75 && pa[1].normalized.bank_reference === 'TR-555' && pa[1].normalized.funding_source === 'client_direct'
     && hasMsg(pa[1], 'info', 'beneficiary_created') && pa[2].status === 'valid' && pa[2].normalized.movement_type === 'received_from_client'
     && pa[2].normalized.method === 'cash') || J(pa.slice(0, 3).map(r => [r.status, codes(r), r.normalized])));
  await check('payments: unknown funding (no run default) error; shared refused; duplicate SADAD in file; future date; SADAD already in Marsa; bad amount / item / date', () =>
    (pa[3].status === 'error' && hasMsg(pa[3], 'error', 'funding_unknown') && pa[4].status === 'error' && hasMsg(pa[4], 'error', 'shared_not_supported')
     && pa[5].status === 'duplicate' && hasMsg(pa[5], 'warning', 'duplicate_in_file') && pa[6].status === 'error' && hasMsg(pa[6], 'error', 'future_date')
     && pa[7].status === 'duplicate' && hasMsg(pa[7], 'info', 'payment_ref_taken') && pa[8].status === 'error'
     && ['service_item_unknown', 'invalid_amount', 'invalid_date'].every(c => hasMsg(pa[8], 'error', c))) || J(pa.slice(3).map(r => [r.status, codes(r)])));
  const cs = await rows(RUN.id, 'custody');
  await check('custody: per client one opening balance (1000 − 250 = 750 on the first line), legacy-void line skipped, negative client refused', () =>
    (cs[0].status === 'valid' && cs[0].normalized.carrier === true && cs[0].normalized.balance === 750 && hasMsg(cs[0], 'info', 'custody_opening')
     && cs[1].normalized.carrier === false && hasMsg(cs[1], 'info', 'custody_merged') && cs[2].status === 'skipped'
     && cs[3].status === 'error' && hasMsg(cs[3], 'error', 'custody_negative') && cs[4].status === 'error') || J(cs.map(r => [r.status, codes(r), r.normalized])));
  await check('list_rows: filters (entity, status array, q) and the row shape; get_run summary of message codes', async () => {
    const r = await rpc('admin', `SELECT public.legacy_import_list_rows($1, $2) r`, [RUN.id, { entity: 'transactions', status: ['error'], limit: 50 }]);
    const r2 = await rpc('admin', `SELECT public.legacy_import_list_rows($1, $2) r`, [RUN.id, { q: 'TX-0007' }]);
    const g = await rpc('admin', `SELECT public.legacy_import_get_run($1) r`, [RUN.id]);
    const x = r.items[0];
    return (r.total === 7 && x.entity === 'transactions' && x.data && x.messages && !('keys' in (x.normalized || {})) && r2.total >= 1
      && g.messages.some(m => m.code === 'duplicate_in_file')) || J({ t: r.total, x, t2: r2.total });
  });
  await check('set_options with a default funding source → rows back to pending; after re-validation PAY-L4 is valid (info funding_default)', async () => {
    const r = await rpc('admin', `SELECT public.legacy_import_set_options($1, $2) r`, [RUN.id, { options: { default_funding_source: 'org_account' } }]);
    const pend = r.pending;
    await validateAll(RUN.id);
    const p4 = await rowAt(RUN.id, 'payments', 5);
    return (r.status === 'staged' && pend > 30 && p4.status === 'valid' && hasMsg(p4, 'info', 'funding_default')) || J({ s: r.status, pend, p4: [p4.status, codes(p4)] });
  });
  await check('skip_rows: the owner leaves T7 out → skipped after re-validation; commit refused before validation ends (MRS_LI_STATE staged)', async () => {
    const t7 = await rowAt(RUN.id, 'transactions', 8);
    await rpc('admin', `SELECT public.legacy_import_skip_rows($1, $2) r`, [RUN.id, { row_ids: [t7.id], skip: true }]);
    const e = await code(() => rpc('admin', `SELECT public.legacy_import_commit($1, $2) r`, [RUN.id, { confirm: true }]));
    await validateAll(RUN.id);
    const t7b = await rowAt(RUN.id, 'transactions', 8);
    return (e === 'MRS_LI_STATE staged' && t7b.status === 'skipped' && hasMsg(t7b, 'info', 'skipped_by_owner')) || J({ e, s: t7b.status });
  });
}

/* ================================================================== 7. commit */
const S = {};
async function secCommit() {
  section('7. commit: chunked, resumable after a timeout, idempotent; nothing approved; legacy refs; audit');
  await check('commit needs confirm on the first call; staff cannot commit', async () => {
    const e1 = await code(() => rpc('admin', `SELECT public.legacy_import_commit($1, '{}') r`, [RUN.id]));
    const e2 = await code(() => rpc('acc', `SELECT public.legacy_import_commit($1, $2) r`, [RUN.id, { confirm: true }]));
    return (e1 === 'MRS_REQUIRED confirm' && e2 === 'MRS_NOT_FOUND run') || J({ e1, e2 });
  });
  S.clients0 = await num(`SELECT count(*) n FROM public.clients WHERE org_id = $1`, [A]);
  S.tx0 = await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [A]);
  await check('a commit call that times out (rolled back) leaves nothing; the retry continues; chunks of 4', async () => {
    await db.exec('BEGIN');
    await asRole('admin', () => q(`SELECT public.legacy_import_commit($1, $2) r`, [RUN.id, { confirm: true, limit: 4 }]));
    await db.exec('ROLLBACK');
    const r0 = await one(`SELECT status FROM public.legacy_import_runs WHERE id = $1`, [RUN.id]);
    const c0 = await num(`SELECT count(*) n FROM public.legacy_import_rows WHERE run_id = $1 AND status = 'committed'`, [RUN.id]);
    const first = await rpc('admin', `SELECT public.legacy_import_commit($1, $2) r`, [RUN.id, { confirm: true, limit: 4 }]);
    const r = await commitAll(RUN.id, 4);
    S.commit = r;
    return (r0.status === 'validated' && c0 === 0 && first.committed > 0 && !first.done && r.done && r.run.status === 'committed') || J({ r0, c0, first, r: r.run && r.run.status });
  });
  await check('re-commit after the end: MRS_LI_STATE committed; no row written twice', async () => {
    const e = await code(() => rpc('admin', `SELECT public.legacy_import_commit($1, $2) r`, [RUN.id, { confirm: true }]));
    const dupT = await num(`SELECT count(*) n FROM (SELECT legacy_ref FROM public.transactions WHERE import_run_id = $1 GROUP BY 1 HAVING count(*) > 1) x`, [RUN.id]);
    return (e === 'MRS_LI_STATE committed' && dupT === 0) || J({ e, dupT });
  });
  const tx = await q(`SELECT t.*, (SELECT array_agg(c.container_no ORDER BY c.container_no) FROM public.containers c WHERE c.transaction_id = t.id) ctrs
                        FROM public.transactions t WHERE t.import_run_id = $1 ORDER BY t.legacy_ref`, [RUN.id]);
  const T = s => tx.find(t => t.legacy_ref === s);
  S.tx = tx; S.T = T;
  await check('transactions: 5 created (T1, T2, T3, T14, T15), Marsa refs continue their own sequence, legacy_ref = the legacy sequence, run id', () =>
    (tx.length === 5 && tx.every(t => /^[A-Z]+-/.test(t.ref) && t.ref !== t.legacy_ref) && J(tx.map(t => t.legacy_ref)) === J(['101', '102', '103', '114', '115']))
    || J(tx.map(t => [t.ref, t.legacy_ref])));
  await check('T1: legacy status kept (no lifecycle auto-advance), declaration released (source import), containers, vessel, legacy_created_at from the legacy serial (created_at = import time)', async () => {
    const t = T('101');
    const d = await one(`SELECT status, source FROM public.customs_declarations WHERE transaction_id = $1`, [t.id]);
    const b = await one(`SELECT b.vessel FROM public.bills_of_lading b JOIN public.transaction_bls tb ON tb.bl_id = b.id WHERE tb.transaction_id = $1`, [t.id]);
    return (t.operational_status === 'customs_declaration' && d.status === 'released' && d.source === 'import' && J(t.ctrs) === J([C.c1, C.c2].sort())
      && b.vessel === 'TEST VESSEL' && new Date(t.legacy_created_at).toISOString() === '2026-11-03T09:00:00.000Z'
      && Math.abs(new Date(t.created_at) - Date.now()) < 600000 && t.transport_order_no === 'TASTO900001'
      && t.client_id !== CLIENT_A) || J({ t: [t.operational_status, t.ctrs, t.created_at, t.legacy_created_at], d, b });
  });
  await check('T2 billed (historical): billed + invoiced, Ro-Ro, no billing intent; T3 operationally complete, billing gate closed (no proof)', async () => {
    const t2 = T('102'), t3 = T('103');
    const bi = await num(`SELECT count(*) n FROM public.billing_intents WHERE transaction_id = ANY ($1)`, [tx.map(t => t.id)]);
    const rd = await rpc('admin', `SELECT public.tx_readiness($1) r`, [t3.id]).catch(e => ({ err: errText(e) }));
    return (t2.operational_status === 'billed' && t2.financial_status === 'invoiced' && t2.cargo_unit_type === 'roro' && t2.chassis_no === 'JTD123456789'
      && bi === 0 && t3.operational_status === 'operationally_complete' && t3.branch_id === DMM && rd.billing_gate_open === false) || J({ t2: t2.operational_status, bi, rd });
  });
  await check('T14 gets its container from the containers sheet (container_count updated, source import)', async () => {
    const t = T('114');
    const c = await one(`SELECT container_no, seal_no, size_type, source FROM public.containers WHERE transaction_id = $1`, [t.id]);
    return (J(t.ctrs) === J([iso('TSTU', '100014')]) && t.container_count === 1 && c.seal_no === 'S-1' && c.size_type === '40HC' && c.source === 'import') || J({ t, c });
  });
  await check('customers / aliases / drivers: clients source legacy + Daftra code; the inactive one inactive; aliases suggested only; drivers + trucks', async () => {
    const c = await q(`SELECT name_ar, daftra_client_code, source, is_active, national_address FROM public.clients WHERE org_id = $1 AND source = 'legacy' ORDER BY daftra_client_code`, [A]);
    const al = await q(`SELECT a.status, a.approved_by FROM public.client_aliases a JOIN public.clients c ON c.id = a.client_id WHERE c.source = 'legacy'`);
    const dr = await q(`SELECT full_name, phone, last_truck_id FROM public.drivers WHERE org_id = $1 AND full_name LIKE 'سائق%' ORDER BY phone`, [A]);
    return (c.length === 3 && J(c.map(x => x.daftra_client_code)) === J(['005001', '005002', '005003']) && c[2].is_active === false && c[0].national_address.city === 'جدة'
      && al.length === 1 && al.every(a => a.status === 'suggested' && a.approved_by === null)
      && dr.some(d => d.phone === '0501112222' && d.last_truck_id) && dr.some(d => d.phone === '0503334444') && dr.some(d => d.phone === '0507778888')
      && dr.filter(d => d.phone === '0507778888').length === 1) || J({ c, al, dr });
  });
  await check('movements: appointment at the Riyadh time (completed), delivered trip with value / revenue, return data stored, return_status still pending', async () => {
    const t = T('101');
    const a = await q(`SELECT a.status, a.appointment_at, a.appointment_no, a.booking_ref, r.status trip, r.cost_amount, r.sell_amount, r.unloaded_at
                         FROM public.port_appointments a LEFT JOIN public.transport_trips r ON r.appointment_id = a.id WHERE a.transaction_id = $1 ORDER BY a.appointment_at`, [t.id]);
    const c = await one(`SELECT return_status, return_deadline::text dl, returned_at, verified_by, evidence_document_id FROM public.containers WHERE transaction_id = $1 AND container_no = $2`, [t.id, C.c1]);
    return (a.length === 2 && a[0].status === 'completed' && new Date(a[0].appointment_at).toISOString() === '2026-11-05T17:30:00.000Z' && a[0].trip === 'delivered'
      && +a[0].cost_amount === 500 && +a[0].sell_amount === 700 && a[0].appointment_no === 'TAS12345678' && a[1].status === 'confirmed' && a[1].booking_ref === 'REF-77'
      && c.return_status === 'pending' && c.dl === '2026-11-10' && c.returned_at && c.verified_by === null && c.evidence_document_id === null) || J({ a, c });
  });
  await check('payments: pending review (four eyes), never approved; SADAD / bank / receipt; client-direct; received; new beneficiary party; the run in the notes', async () => {
    const p = await q(`SELECT d.ref, d.review_status, d.reviewed_by, d.method, d.movement_type, d.paid_amount, d.sadad_number, d.bank_reference, d.receipt_no, d.notes,
                              d.beneficiary_name FROM public.client_disbursements d
                         JOIN public.legacy_import_rows o ON o.target_id = d.id WHERE o.run_id = $1 ORDER BY o.row_no`, [RUN.id]);
    const party = await one(`SELECT kinds, is_active FROM public.parties WHERE org_id = $1 AND name_ar = 'جهة جديدة للاختبار'`, [A]);
    return (p.length === 4 && p.every(x => x.review_status === 'pending' && x.reviewed_by === null && x.notes.includes(RUN.ref))
      && p[0].method === 'sadad' && p[0].sadad_number === '7001001' && p[1].movement_type === 'client_direct' && p[1].bank_reference === 'TR-555'
      && +p[1].paid_amount === 1250.75 && p[2].movement_type === 'received_from_client' && p[2].receipt_no === 'RC-77' && party && party.kinds.includes('supplier'))
      || J({ p, party });
  });
  await check('custody: one opening deposit of 750 for the client (reference = the run), balance 750; the merged line points to it', async () => {
    const e = await q(`SELECT e.kind, e.amount, e.reference, e.status FROM public.client_custody_entries e
                         JOIN public.legacy_import_rows o ON o.target_id = e.id WHERE o.run_id = $1 AND o.entity = 'custody'`, [RUN.id]);
    const cs = await rows(RUN.id, 'custody');
    return (e.length === 2 && e.every(x => x.kind === 'deposit' && +x.amount === 750 && x.reference === RUN.ref) && cs[0].target_id === cs[1].target_id
      && cs[0].status === 'committed' && cs[1].status === 'committed') || J({ e, cs: cs.map(r => [r.status, r.target_id]) });
  });
  await check('nothing verified / approved / billed by the import: no proof, no returned_verified, no approved alias / payment, no Daftra job, no billing intent', async () => {
    const r = await one(`SELECT (SELECT count(*) FROM public.empty_return_proofs p WHERE p.transaction_id = ANY ($1))::int proofs,
                                (SELECT count(*) FROM public.containers c WHERE c.transaction_id = ANY ($1) AND c.return_status <> 'pending')::int ret,
                                (SELECT count(*) FROM public.billing_sync_jobs j WHERE j.transaction_id = ANY ($1))::int jobs,
                                (SELECT count(*) FROM public.billing_intents b WHERE b.transaction_id = ANY ($1))::int intents,
                                (SELECT count(*) FROM public.client_disbursements d JOIN public.disbursement_allocations a ON a.disbursement_id = d.id
                                  WHERE a.transaction_id = ANY ($1) AND d.review_status = 'approved')::int appr`, [tx.map(t => t.id)]);
    return (r.proofs === 0 && r.ret === 0 && r.jobs === 0 && r.intents === 0 && r.appr === 0) || J(r);
  });
  await check('audit: every committed row has an audit entry with the run id + target; the created rows have their own INSERT audit', async () => {
    const n = await num(`SELECT count(*) n FROM public.legacy_import_rows WHERE run_id = $1 AND status = 'committed'`, [RUN.id]);
    const a = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'legacy_import_rows' AND new_data ->> 'run_id' = $1 AND new_data ->> 'status' = 'committed'`, [RUN.id]);
    const t = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'transactions' AND action = 'INSERT' AND new_data ->> 'import_run_id' = $1`, [RUN.id]);
    const lab = await one(`SELECT app.audit_label_of('legacy_import_rows', 'UPDATE', ARRAY['status']) a, app.audit_label_of('legacy_import_runs', 'INSERT', NULL) b`);
    return (n > 15 && a === n && t === 5 && lab.a === 'legacy_import.row' && lab.b === 'legacy_import.run') || J({ n, a, t, lab });
  });
  await check('fingerprints taken for every created row as it committed; the run counts committed', async () => {
    const r = await one(`SELECT count(*) FILTER (WHERE NOT (e ? 'fp'))::int nofp, count(*)::int n FROM public.legacy_import_rows o, jsonb_array_elements(o.created_rows) e
                          WHERE o.run_id = $1`, [RUN.id]);
    return (r.n > 20 && r.nofp === 0 && S.commit.run.counts.by_status.committed > 15) || J(r);
  });
  await check('legacy_ref is searchable in the register (report_transactions q) and is server-set only (no column grant; the guard trigger)', async () => {
    const r = await rpc('admin', `SELECT public.report_transactions($1, $2) r`, [A, { q: '114' }]);
    const e1 = await code(() => as('jed', `UPDATE public.transactions SET legacy_ref = 'HACK' WHERE id = $1`, [T('101').id]));
    const e2 = await code(() => as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, legacy_ref, import_run_id, notes)
                                           VALUES ($1, $2, $3, 'import', 'sea', 'FAKE', $4, 'li-guard-probe')`, [A, JED, CLIENT_A, RUN.id]));
    const t = await one(`SELECT legacy_ref, import_run_id FROM public.transactions WHERE id = $1`, [T('101').id]);
    const t2 = await q(`SELECT legacy_ref, import_run_id FROM public.transactions WHERE notes = 'li-guard-probe'`);
    // either refused by the column grants or neutralised by trg_li_guard: never stored
    const ok1 = e1 === 'perm' || e1 === 'ok', ok2 = e2 === 'perm' || (e2 === 'ok' && t2.length === 1 && t2[0].legacy_ref === null && t2[0].import_run_id === null);
    return (r.items.some(i => i.id === T('114').id) && ok1 && ok2 && t.legacy_ref === '101' && t.import_run_id === RUN.id)
      || J({ hit: r.items.map(i => i.ref), e1, e2, t, t2 });
  });
}

/* ================================================================== 8. attention / alerts */
async function secQuiet() {
  section('8. attention / alerts: imported billed rows stay quiet');
  await check('T15 (imported, billed) has an overdue empty-return deadline but no attention reason and no alert; T3 (active) still can', async () => {
    const t15 = S.T('115');
    const c = await one(`SELECT return_deadline::text d FROM public.containers WHERE transaction_id = $1`, [t15.id]);
    const att = await num(`SELECT count(*) n FROM app.att_reasons($1, ARRAY[$2]::uuid[], now())`, [A, t15.id]);
    await q(`SELECT public.refresh_alerts($1)`, [A]).catch(() => null);
    const al = await num(`SELECT count(*) n FROM public.operational_alerts WHERE transaction_id = $1`, [t15.id]);
    const quiet = (await one(`SELECT app.li_quiet_tx($1, 'billed') a, app.li_quiet_tx(NULL, 'billed') b, app.li_quiet_tx($1, 'operationally_complete') c`, [RUN.id]));
    return (c.d === '2026-10-01' && att === 0 && al === 0 && quiet.a === true && quiet.b === false && quiet.c === false) || J({ c, att, al, quiet });
  });
}

/* ================================================================== 9. RHK Daftra step */
async function secDaftra() {
  section('9. RHK- invoices: step-7 read-only jobs queued, candidates for a human, never linked');
  await check('without a Daftra connection: MRS_BAD_TRANSITION not_connected', async () =>
    (await code(() => rpc('admin', `SELECT public.legacy_import_queue_daftra($1, NULL) r`, [RUN.id]))) === 'MRS_BAD_TRANSITION not_connected');
  await rpc('admin', `SELECT public.save_daftra_connection($1, $2) r`, [A, {}]).catch(() => null);
  await raw(`UPDATE public.daftra_connections SET status = 'connected', sync_enabled = true WHERE org_id = $1`, [A]);
  await check('queue: one invoice_lookup by the legacy Daftra invoice number (any numbering, not only RHK-) + the legacy_scan run; nothing linked; idempotent re-queue deduplicates', async () => {
    const r = await rpc('admin', `SELECT public.legacy_import_queue_daftra($1, NULL) r`, [RUN.id]);
    const jobs = await q(`SELECT kind, options, transaction_id FROM public.billing_sync_jobs WHERE org_id = $1 AND kind IN ('invoice_lookup','legacy_scan') ORDER BY kind`, [A]);
    const r2 = await rpc('admin', `SELECT public.legacy_import_queue_daftra($1, NULL) r`, [RUN.id]);
    const links = await num(`SELECT count(*) n FROM public.billing_intents WHERE transaction_id = ANY ($1)`, [S.tx.map(t => t.id)]);
    return (r.lookups_queued === 2 && jobs.filter(j => j.kind === 'invoice_lookup').length === 2 && jobs.some(j => j.options.number === '000123') && jobs.some(j => j.options.number === '000124')
      && jobs.some(j => j.kind === 'legacy_scan') && r2.lookups_deduplicated === 2 && r2.lookups_queued === 0 && links === 0 && r.run.daftra.prefix === 'RHK-')
      || J({ r, jobs, r2, links });
  });
  await check('a candidate found by the worker is listed for the run (state open) and stays unlinked until confirm_invoice_link', async () => {
    const t1 = S.T('101');
    await raw(`INSERT INTO public.daftra_invoice_candidates (org_id, transaction_id, source, external_invoice_id, daftra_number, client_check, state)
               VALUES ($1, $2, 'lookup_number', 'ext-rhk-1001', '000123', 'ok', 'open')`, [A, t1.id]);
    const r = await rpc('admin', `SELECT public.legacy_import_daftra_candidates($1, '{}') r`, [RUN.id]);
    const st = await one(`SELECT state, linked_intent_id FROM public.daftra_invoice_candidates WHERE external_invoice_id = 'ext-rhk-1001'`);
    return (r.total === 1 && r.items[0].transaction.legacy_ref === '101' && r.items[0].transaction.legacy_invoice_no === '000123'
      && r.items[0].transaction.legacy_reference === 'RHK-TX-0001' && r.items[0].candidate.daftra_number === '000123' && st.state === 'open' && st.linked_intent_id === null) || J({ r, st });
  });
  await check('void of the run is blocked while its Daftra jobs are in flight (daftra_sync_in_flight)', async () => {
    const r = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [RUN.id, 'اختبار الإلغاء', { dry_run: true }]);
    return r.blockers.items.some(b => b.reason === 'daftra_sync_in_flight') || J(r.blockers);
  });
}

/* ================================================================== 10. void */
async function secVoid() {
  section('10. void: refused after a later change / use, then succeeds; re-import after a void; another org untouched');
  // a small second run (after the first is committed)
  const run2 = await createRun('admin', { entities: ['customers', 'transactions', 'payments', 'custody'], branch_id: JED, reason: 'دفعة ثانية للاختبار' });
  await stage(run2.id, 'customers', [{ daftra_code: '6001', name_ar: 'شركة الإلغاء للاختبار', vat_number: '311111111111113' }]);
  await stage(run2.id, 'transactions', [{ legacy_id: 'TX-2001', seq: '201', client_code: '6001', bl_number: 'BLV1', container_no: iso('TSTU', '200001'), port: 'SAJED' },
    { legacy_id: 'TX-2002', seq: '202', client_code: '6001', bl_number: 'BLV2', container_no: iso('TSTU', '200002'), port: 'SAJED',
      declaration_no: 'DV2002', declaration_status: 'قبول البيان', declaration_type: 'استيراد' }]);
  await stage(run2.id, 'payments', [{ legacy_id: 'PAY-V1', tx_legacy_id: 'TX-2001', service_item: 'port_charges', paid_amount: '40', paid_at: '01/11/2026',
    route: 'سددت المؤسسة عن العميل', sadad_number: '7002001', funding_source: 'حساب المؤسسة', paying_account: 'Test Bank 01', issuer: 'جهة الفاتورة للاختبار' }]);
  await stage(run2.id, 'custody', [{ client_code: '6001', client_name: 'شركة الإلغاء للاختبار', kind: 'إيداع عهدة', amount: '90' }]);
  await validateAll(run2.id);
  // the org turned the opening Daftra draft on: an imported declaration must still not create one (deferred trigger, lifecycle off)
  await raw(`UPDATE public.daftra_connections SET auto_draft_on_declaration = true WHERE org_id = $1`, [A]);
  const c2 = await commitAll(run2.id);
  await raw(`UPDATE public.daftra_connections SET auto_draft_on_declaration = false WHERE org_id = $1`, [A]);
  await check('lifecycle suppressed until COMMIT: no opening Daftra draft / review item for an imported declaration, status kept', async () => {
    const t = await one(`SELECT id, operational_status FROM public.transactions WHERE import_run_id = $1 AND legacy_ref = '202'`, [run2.id]);
    const n = await num(`SELECT (SELECT count(*) FROM public.billing_intents WHERE transaction_id = $1) + (SELECT count(*) FROM public.billing_review_items WHERE transaction_id = $1) n`, [t.id]);
    const d = await one(`SELECT status FROM public.customs_declarations WHERE transaction_id = $1`, [t.id]);
    return (n === 0 && t.operational_status === 'customs_declaration' && d.status === 'accepted') || J({ n, t, d });
  });
  const cl = await one(`SELECT id, phone FROM public.clients WHERE org_id = $1 AND daftra_client_code = '006001'`, [A]);
  await check('run 2 committed (client, 2 transactions, payment, custody)', () => (c2.run.status === 'committed' && c2.run.counts.by_status.committed === 5 && cl) || J(c2.run.counts));
  await check('a later change of a created row (client phone) → void refused with the list (MRS_LI_VOID_BLOCKED, reason changed)', async () => {
    await as('admin', `UPDATE public.clients SET phone = '0559990000' WHERE id = $1`, [cl.id]);
    const e = await code(() => rpc('admin', `SELECT public.legacy_import_void($1, $2) r`, [run2.id, 'اختبار']));
    const d = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [run2.id, 'اختبار', { dry_run: true }]);
    return (/^MRS_LI_VOID_BLOCKED /.test(e) && d.blockers.items.some(b => b.table === 'clients' && b.reason === 'changed')) || J({ e, d: d.blockers });
  });
  await check('the change undone (same fingerprint) → nothing blocks', async () => {
    await as('admin', `UPDATE public.clients SET phone = NULL WHERE id = $1`, [cl.id]);
    const d = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [run2.id, 'اختبار', { dry_run: true }]);
    return d.blockers.total === 0 || J(d.blockers);
  });
  await check('void succeeds: transaction cancelled (closed, reason), payment void, custody void, client inactive with code / VAT released; void twice refused', async () => {
    const r0 = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [run2.id, 'دفعة خاطئة', { limit: 1 }]);
    const busy = await code(() => createRun('admin'));
    const r = await voidAll(run2.id, 'سبب آخر لا يُستخدم', 2);
    const t = await one(`SELECT operational_status, cancelled_at, cancel_reason FROM public.transactions WHERE import_run_id = $1 AND legacy_ref = '201'`, [run2.id]);
    const p = await one(`SELECT d.status FROM public.client_disbursements d JOIN public.legacy_import_rows o ON o.target_id = d.id WHERE o.run_id = $1`, [run2.id]);
    const e = await one(`SELECT e.status FROM public.client_custody_entries e JOIN public.legacy_import_rows o ON o.target_id = e.id WHERE o.run_id = $1`, [run2.id]);
    const c = await one(`SELECT is_active, daftra_client_code, vat_number FROM public.clients WHERE id = $1`, [cl.id]);
    const again = await code(() => rpc('admin', `SELECT public.legacy_import_void($1, $2) r`, [run2.id, 'مرة ثانية']));
    return (r0.done === false && r0.run.status === 'voiding' && busy === 'MRS_LI_STATE open_run' && r.calls > 1 && r.run.status === 'voided'
      && r.run.void_reason === 'دفعة خاطئة' && t.operational_status === 'closed' && t.cancelled_at && /دفعة خاطئة/.test(t.cancel_reason) && p.status === 'void'
      && e.status === 'void' && c.is_active === false && c.daftra_client_code === null && c.vat_number === null && again === 'MRS_LI_STATE voided') || J({ r0: [r0.done, r0.run.status], busy, r: [r.calls, r.run.status, r.voided], t, p, e, c, again });
  });
  await check('re-import after the void: the same rows validate again (no duplicate against the voided run) and commit', async () => {
    const run3 = await createRun('admin', { entities: ['customers', 'transactions'], reason: 'إعادة الاستيراد بعد الإلغاء' });
    await stage(run3.id, 'customers', [{ daftra_code: '6001', name_ar: 'شركة الإلغاء للاختبار', vat_number: '311111111111113' }]);
    await stage(run3.id, 'transactions', [{ legacy_id: 'TX-2001', seq: '201', client_code: '6001', bl_number: 'BLV1', container_no: iso('TSTU', '200001'), port: 'SAJED' }]);
    const v = await validateAll(run3.id);
    const c = await commitAll(run3.id);
    S.run3 = run3;
    return (v.run.counts.by_status.valid === 2 && c.run.counts.by_status.committed === 2) || J({ v: v.run.counts, c: c.run.counts });
  });
  await check('a later use of an imported client (a new Marsa transaction) blocks the void (added_later); a draft run is simply closed', async () => {
    const cl3 = await one(`SELECT id FROM public.clients WHERE org_id = $1 AND daftra_client_code = '006001' AND is_active`, [A]);
    await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea')`, [A, JED, cl3.id]);
    const d = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [S.run3.id, 'اختبار', { dry_run: true }]);
    const run4 = await createRun('admin', { entities: ['drivers'], reason: 'دفعة مسودة' });
    const v4 = await rpc('admin', `SELECT public.legacy_import_void($1, $2) r`, [run4.id, 'لا حاجة']);
    return (d.blockers.items.some(b => b.table === 'transactions' && b.reason === 'added_later') && v4.run.status === 'voided') || J({ d: d.blockers, v4: v4.run.status });
  });
  await check('a second person approves an imported payment (four eyes) → the void lists it as changed', async () => {
    const pid = (await one(`SELECT o.target_id id FROM public.legacy_import_rows o WHERE o.run_id = $1 AND o.entity = 'payments' AND o.status = 'committed' ORDER BY o.row_no LIMIT 1`, [RUN.id])).id;
    const self = await code(() => rpc('admin', `SELECT public.review_payment($1, 'approve', NULL) r`, [pid]));
    await rpc('adminJ', `SELECT public.review_payment($1, 'approve', NULL) r`, [pid]);
    const d = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [RUN.id, 'اختبار', { dry_run: true }]);
    return (/self_approval/.test(self) && d.blockers.items.some(b => b.table === 'client_disbursements' && b.id === pid && b.reason === 'changed')) || J({ self, d: d.blockers });
  });
  await check('another org: org B admin cannot read / validate / void org A runs (MRS_NOT_FOUND); org A codes never match org B clients', async () => {
    const e = [await code(() => rpc('staffB', `SELECT public.legacy_import_get_run($1) r`, [RUN.id])),
      await code(() => rpc('staffB', `SELECT public.legacy_import_validate($1, '{}') r`, [RUN.id])),
      await code(() => rpc('staffB', `SELECT public.legacy_import_void($1, 'xxx') r`, [RUN.id])),
      await code(() => rpc('portal', `SELECT public.legacy_import_list_rows($1, '{}') r`, [RUN.id]))];
    const rb = await rpc('staffB', `SELECT public.legacy_import_create_run($1, $2, NULL) r`, [B, { entities: ['transactions'], branch_id: BR_B, reason: 'org B run' }]);
    await rpc('staffB', `SELECT public.legacy_import_stage($1, $2) r`, [rb.id, { entity: 'transactions', rows: [{ row_no: 2, data: { legacy_id: 'TX-0001', client_code: '5001',
      bl_number: 'BB1', container_no: iso('BBBU', '300001'), port: 'SAJED' } }] }]);
    await rpc('staffB', `SELECT public.legacy_import_validate($1, '{}') r`, [rb.id]);
    const r = await one(`SELECT status, messages FROM public.legacy_import_rows WHERE run_id = $1`, [rb.id]);
    const lb = await rpc('staffB', `SELECT public.legacy_import_list_runs($1, '{}') r`, [B]);
    return (J(e) === J(['MRS_NOT_FOUND run', 'MRS_NOT_FOUND run', 'MRS_NOT_FOUND run', 'MRS_NOT_FOUND run']) && r.status === 'error'
      && r.messages.some(m => m.code === 'client_not_found') && lb.total === 1) || J({ e, r, lb: lb.total });
  });
}

/* ================================================================== 10b. review fixes (step-9 review) */
async function secReview() {
  section('10b. review fixes: void baseline per row, plan month, staging places, corrected sheets, kept containers, custody / movements re-import, RHK- reference, custody carrier');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  // R1 + R2: an edit by staff while the run is still committing stays visible to the void; a back-dated legacy creation date is data only
  const r5 = await createRun('admin', { entities: ['transactions', 'containers'], branch_id: JED, reason: 'مراجعة: تعديل أثناء الترحيل' });
  await stage(r5.id, 'transactions', [
    { legacy_id: 'TX-5001', seq: '501', client_code: '000186', bl_number: 'BLR51', container_no: iso('RVWU', '500001'), port: 'SAJED', operational_status: 'جديد' },
    { legacy_id: 'TX-5002', seq: '502', client_code: '000186', bl_number: 'BLR52', container_no: iso('RVWU', '500002'), port: 'SAJED', operational_status: 'جديد',
      created_at: '15/03/2020' }]);
  await stage(r5.id, 'containers', [{ legacy_id: 'CR-51', tx_legacy_id: 'TX-5001', container_no: iso('RVWU', '500011') }]);
  await validateAll(r5.id);
  const first = await rpc('admin', `SELECT public.legacy_import_commit($1, $2) r`, [r5.id, { confirm: true, limit: 1 }]);
  const t51 = await one(`SELECT id FROM public.transactions WHERE import_run_id = $1 AND legacy_ref = '501'`, [r5.id]);
  const fp1 = await one(`SELECT count(*) FILTER (WHERE e ? 'fp' AND e ->> 'fp' IS NOT NULL)::int n, count(*)::int t
                           FROM public.legacy_import_rows o, jsonb_array_elements(o.created_rows) e WHERE o.run_id = $1 AND o.status = 'committed'`, [r5.id]);
  const edit = await code(() => as('jed', `UPDATE public.transactions SET notes = 'staff note added during commit' WHERE id = $1`, [t51.id]));
  const c5 = await commitAll(r5.id);
  await check('R1 void baseline: fingerprints taken per row as it commits (run still committing); a staff edit between commit calls blocks the void (changed), the untouched transaction does not', async () => {
    const d = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [r5.id, 'اختبار', { dry_run: true }]);
    const t52 = await one(`SELECT id FROM public.transactions WHERE import_run_id = $1 AND legacy_ref = '502'`, [r5.id]);
    return (first.run.status === 'committing' && fp1.t > 0 && fp1.n === fp1.t && edit === 'ok' && c5.run.status === 'committed'
      && d.blockers.items.some(b => b.table === 'transactions' && b.id === t51.id && b.reason === 'changed')
      && !d.blockers.items.some(b => b.id === t52.id)
      && !/app\.li_rank\(o\.entity\) < app\.li_rank\(r\.entity\)/.test(src) && !/fingerprints of everything the run created, taken once/.test(src))
      || J({ first: first.run.status, fp1, edit, c5: c5.run.status, d: d.blockers });
  });
  await check('R2 plan month: a legacy creation date of 2020 is kept as legacy_created_at; created_at = the import time; the plan counter of 2020-03 is untouched', async () => {
    const t = await one(`SELECT created_at, legacy_created_at, operational_status FROM public.transactions WHERE import_run_id = $1 AND legacy_ref = '502'`, [r5.id]);
    const old = await num(`SELECT count(*) n FROM public.org_usage_counters WHERE org_id = $1 AND metric = 'transactions_month' AND period_start = '2020-03-01'`, [A]);
    const e = await code(() => as('jed', `UPDATE public.transactions SET legacy_created_at = '2001-01-01' WHERE import_run_id = $1 AND legacy_ref = '502'`, [r5.id]));
    const t2 = await one(`SELECT legacy_created_at FROM public.transactions WHERE import_run_id = $1 AND legacy_ref = '502'`, [r5.id]);
    return (t.operational_status === 'new' && new Date(t.legacy_created_at).toISOString() === '2020-03-14T21:00:00.000Z'
      && Math.abs(new Date(t.created_at) - Date.now()) < 600000 && old === 0 && (e === 'perm' || e === 'ok')
      && new Date(t2.legacy_created_at).toISOString() === '2020-03-14T21:00:00.000Z') || J({ t, old, e, t2 });
  });
  // R3 + R4: two equal lines of a sheet are two rows; a corrected sheet re-staged with replace drops the removed line
  const r6 = await createRun('admin', { entities: ['custody'], branch_id: JED, reason: 'مراجعة: صفوف متطابقة' });
  const line = { client_code: '000186', client_name: 'عميل الاختبار', kind: 'إيداع عهدة', amount: '500', entry_date: '01/10/2026' };
  const s1 = await stage(r6.id, 'custody', [line, line, { client_code: '000186', client_name: 'عميل الاختبار', kind: 'إيداع عهدة', amount: '300' }], 'admin', 'عهدة @ a.xlsx');
  const s1b = await stage(r6.id, 'custody', [line, line, { client_code: '000186', client_name: 'عميل الاختبار', kind: 'إيداع عهدة', amount: '300' }], 'admin', 'عهدة @ a.xlsx');
  const s2 = await rpc('admin', `SELECT public.legacy_import_stage($1, $2) r`, [r6.id, { entity: 'custody', sheet: 'عهدة @ a.xlsx', replace: true,
    rows: [{ row_no: 2, data: line }, { row_no: 3, data: line }] }]);
  await validateAll(r6.id);
  const cs6 = await rows(r6.id, 'custody');
  await check('R3 staging: two identical custody lines are two rows (500 + 500 = 1000), re-sending them is unchanged', () =>
    (s1.inserted === 3 && s1.unchanged === 0 && s1b.unchanged === 3 && s1b.inserted === 0 && cs6.length === 2 && cs6[0].normalized.balance === 1000
     && hasMsg(cs6[0], 'info', 'custody_opening')) || J({ s1, s1b, cs6: cs6.map(r => [r.row_no, r.status, r.normalized && r.normalized.balance]) }));
  await check('R4 corrected sheet: stage with replace removes every staged row of that sheet first (the deleted 300 line is gone)', () =>
    (s2.removed === 3 && s2.inserted === 2 && s2.run.counts.total === 2 && !cs6.some(r => r.raw.amount === '300')) || J(s2));
  await commitAll(r6.id);
  // R5 custody re-import: legacy ids already imported are duplicates; a client opened by a run without legacy ids takes no more lines
  const r7 = await createRun('admin', { entities: ['custody'], branch_id: JED, reason: 'مراجعة: إعادة استيراد العهدة' });
  await stage(r7.id, 'custody', [
    { legacy_id: 'CUS-L1', client_name: 'شركة الأفق للاختبار', kind: 'إيداع عهدة', amount: '1000', entry_date: '01/10/2026' },
    { legacy_id: 'CUS-L2', client_name: 'شركة الأفق للاختبار', kind: 'خصم من العهدة', amount: '250' },
    { legacy_id: 'CUS-L9', client_name: 'شركة الأفق للاختبار', kind: 'إيداع عهدة', amount: '200' },
    { legacy_id: 'CUS-L9', client_name: 'شركة الأفق للاختبار', kind: 'إيداع عهدة', amount: '200' },
    line]);
  await validateAll(r7.id);
  const cs7 = await rows(r7.id, 'custody');
  const c7 = await commitAll(r7.id);
  await check('R5 custody re-import: CUS-L1 / L2 already imported (duplicate), CUS-L9 once (duplicate in file) → one new deposit of 200; the client opened without legacy ids refuses the line', async () => {
    const ufuq = await one(`SELECT id FROM public.clients WHERE org_id = $1 AND daftra_client_code = '005001'`, [A]);
    const e = await q(`SELECT amount, reference FROM public.client_custody_entries WHERE client_id = $1 AND status = 'active' ORDER BY amount`, [ufuq.id]);
    const ca = await q(`SELECT amount FROM public.client_custody_entries WHERE client_id = $1 AND status = 'active'`, [CLIENT_A]);
    return (cs7[0].status === 'duplicate' && hasMsg(cs7[0], 'info', 'already_imported') && cs7[1].status === 'duplicate' && cs7[2].normalized.balance === 200
      && cs7[3].status === 'duplicate' && hasMsg(cs7[3], 'warning', 'duplicate_in_file') && cs7[4].status === 'error' && hasMsg(cs7[4], 'error', 'custody_already_opened')
      && J(e.map(x => +x.amount)) === J([200, 750]) && e[0].reference === r7.ref && ca.length === 1 && +ca[0].amount === 1000 && c7.run.status === 'committed')
      || J({ cs7: cs7.map(r => [r.status, codes(r), r.normalized && r.normalized.balance]), e, ca });
  });
  // R6 kept containers: a container a run added to an older Marsa transaction is never deleted by the void (an alert points to it)
  const r8 = await createRun('admin', { entities: ['transactions', 'containers'], branch_id: JED, reason: 'مراجعة: حاوية على معاملة سابقة' });
  await stage(r8.id, 'transactions', [{ legacy_id: 'TX-8005', seq: '805', client_code: '000186', bl_number: 'EXISTBL1', container_no: C.ex, port: 'SAJED' }]);
  await stage(r8.id, 'containers', [{ legacy_id: 'CR-8', tx_legacy_id: 'TX-8005', container_no: iso('QQQU', '400001'), size_type: '40hc' }]);
  await validateAll(r8.id);
  await commitAll(r8.id);
  const qc = await one(`SELECT id, transaction_id FROM public.containers WHERE container_no = $1`, [iso('QQQU', '400001')]);
  await raw(`INSERT INTO public.operational_alerts (org_id, branch_id, transaction_id, container_id, kind, severity, title_ar, dedupe_key)
             VALUES ($1, $2, $3, $4, 'empty_return_due', 'warning', 'إعادة الفارغ', $5)`, [A, JED, qc.transaction_id, qc.id, 'li-review-' + qc.id]);
  await check('R6 kept container: dry run 0 blockers, the void finishes (kept_containers = 1), the container stays on the older transaction with its alert', async () => {
    const d = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [r8.id, 'اختبار', { dry_run: true }]);
    const v = await voidAll(r8.id, 'مراجعة الإلغاء');
    const still = await num(`SELECT count(*) n FROM public.containers WHERE id = $1`, [qc.id]);
    const al = await num(`SELECT count(*) n FROM public.operational_alerts WHERE container_id = $1`, [qc.id]);
    return (qc.transaction_id === X.existTx.id && d.blockers.total === 0 && v.run.status === 'voided' && v.kept_containers === 1 && still === 1 && al === 1)
      || J({ qc, d: d.blockers, v, still, al });
  });
  // R7 movements re-import: the same legacy movement, the same trip without an appointment → duplicates (no second trip)
  const trip = { tx_legacy_id: 'TX-0003', driver_name: 'سائق جديد ثالث', driver_phone: '0507778888', destination: 'مستودع المراجعة', transport_value: '100' };
  const r9 = await createRun('admin', { entities: ['movements'], branch_id: JED, reason: 'مراجعة: النقل 1' });
  const byId = { legacy_id: 'MV-R1', tx_legacy_id: 'TX-0003', destination: 'مستودع أ', transport_value: '80' };
  await stage(r9.id, 'movements', [byId, trip]);
  await validateAll(r9.id);
  const mv9 = await rows(r9.id, 'movements');
  await commitAll(r9.id);
  const r10 = await createRun('admin', { entities: ['movements'], branch_id: JED, reason: 'مراجعة: النقل 2' });
  await stage(r10.id, 'movements', [Object.assign({}, byId, { destination: 'مستودع ج', transport_value: '90' }), trip]);
  await validateAll(r10.id);
  const mv10 = await rows(r10.id, 'movements');
  await check('R7 movements: a legacy movement id committed by an earlier run → already imported; the same trip without an appointment or id in a later run → trip_duplicate; one trip only', async () => {
    const n = await num(`SELECT count(*) n FROM public.transport_trips r JOIN public.transactions t ON t.id = r.transaction_id
                          WHERE t.import_run_id = $1 AND t.legacy_ref = '103' AND r.destination = 'مستودع المراجعة'`, [RUN.id]);
    return (mv9[0].status === 'valid' && mv9[1].status === 'valid'
      && mv10[0].status === 'duplicate' && hasMsg(mv10[0], 'info', 'already_imported') && mv10[1].status === 'duplicate' && hasMsg(mv10[1], 'info', 'trip_duplicate') && n === 1) || J({ mv9: mv9.map(r => [r.status, codes(r)]), mv10: mv10.map(r => [r.status, codes(r)]), n });
  });
  await voidAll(r10.id, 'لا حاجة');
  // R8 the RHK- reference: a Daftra invoice whose po_number is RHK-<legacy «رقم المعاملة»> becomes a candidate of that transaction
  await check('R8 legacy scan: po_number RHK-TX-0001 (any case of the prefix) → an open candidate of T1 (reference match, not linked); an unknown legacy id → none', async () => {
    const j = await one(`SELECT * FROM public.billing_sync_jobs WHERE org_id = $1 AND kind = 'legacy_scan' ORDER BY created_at DESC LIMIT 1`, [A]);
    await q(`SELECT app.daftra_apply_scan(j, $2) FROM public.billing_sync_jobs j WHERE j.id = $1`, [j.id, { run_id: j.run_id, next_cursor: null, invoices: [
      { external_invoice_id: '9001', daftra_number: '000555', po_number: 'rhk-TX-0001', date: '2026-10-01', currency: 'SAR', total: 100 },
      { external_invoice_id: '9002', daftra_number: '000556', po_number: 'RHK-TX-9999', date: '2026-10-01', currency: 'SAR', total: 50 }] }]);
    const c = await q(`SELECT transaction_id, source, state, match, linked_intent_id FROM public.daftra_invoice_candidates WHERE external_invoice_id IN ('9001','9002')`);
    const r = await rpc('admin', `SELECT public.legacy_import_daftra_candidates($1, '{}') r`, [RUN.id]);
    return (c.length === 1 && c[0].transaction_id === S.T('101').id && c[0].source === 'legacy_scan' && c[0].state === 'open' && c[0].match.reference === true
      && c[0].linked_intent_id === null && r.items.some(i => i.candidate.daftra_number === '000555')) || J({ c, r: r.total });
  });
  // R9 custody carrier: when the opening deposit fails, the merged lines of that client fail too (parent_failed), never «committed» without an entry
  const r11 = await createRun('admin', { entities: ['custody'], branch_id: JED, reason: 'مراجعة: فشل الرصيد الافتتاحي' });
  await stage(r11.id, 'custody', [
    { legacy_id: 'CUS-H1', client_code: '5002', client_name: 'مؤسسة النخبة للاختبار', kind: 'إيداع عهدة', amount: '100' },
    { legacy_id: 'CUS-H2', client_code: '5002', client_name: 'مؤسسة النخبة للاختبار', kind: 'إيداع عهدة', amount: '50' }]);
  await validateAll(r11.id);
  const h1 = await rowAt(r11.id, 'custody', 2);
  await raw(`UPDATE public.legacy_import_rows SET normalized = normalized || jsonb_build_object('client_id', gen_random_uuid()) WHERE id = $1`, [h1.id]);
  const c11 = await commitAll(r11.id);
  await check('R9 custody carrier failed → the merged line is parent_failed (no committed row without a deposit)', async () => {
    const cs = await rows(r11.id, 'custody');
    return (cs[0].status === 'error' && hasMsg(cs[0], 'error', 'commit_failed') && cs[1].status === 'error' && hasMsg(cs[1], 'error', 'parent_failed')
      && c11.run.status === 'committed') || J(cs.map(r => [r.status, codes(r)]));
  });
}

async function secHarness() {
  section('10c. harness fixes: a void left-over of another run never blocks; a staff row still does');
  // run A creates a transaction; run B adds a trip and a container to it; B is voided (the trip is cancelled, the container kept)
  const ra = await createRun('admin', { entities: ['transactions'], branch_id: JED, reason: 'هارنس: دفعة أ' });
  await stage(ra.id, 'transactions', [{ legacy_id: 'TX-8101', seq: '8101', client_code: '000186', bl_number: 'H10BL1', container_no: iso('QQQU', '410001'), port: 'SAJED' }]);
  await validateAll(ra.id);
  const ca = await commitAll(ra.id);
  const rb = await createRun('admin', { entities: ['containers', 'movements'], branch_id: JED, reason: 'هارنس: دفعة ب' });
  await stage(rb.id, 'containers', [{ legacy_id: 'CR-H10', tx_legacy_id: 'TX-8101', container_no: iso('QQQU', '410002'), size_type: '40hc' }]);
  await stage(rb.id, 'movements', [{ legacy_id: 'MV-H10', tx_legacy_id: 'TX-8101', container_no: iso('QQQU', '410001'), destination: 'مستودع الهارنس', transport_value: '70' }]);
  await validateAll(rb.id);
  const cb = await commitAll(rb.id);
  const before = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [ra.id, 'اختبار', { dry_run: true }]);
  const vb = await voidAll(rb.id, 'هارنس: إلغاء ب');
  const after = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [ra.id, 'اختبار', { dry_run: true }]);
  await check('H1 while B is live its trip / container block A (added_later); once B is voided they are left-overs: A has 0 blockers', async () =>
    (ca.run.status === 'committed' && cb.run.status === 'committed' && before.blockers.total >= 2
      && before.blockers.items.some(i => i.table === 'transport_trips' && i.reason === 'added_later') && before.blockers.items.some(i => i.table === 'containers' && i.reason === 'added_later')
      && vb.run.status === 'voided' && vb.kept_containers === 1 && after.blockers.total === 0) || J({ ca: ca.run.status, cb: cb.run.status, before: before.blockers, vb: [vb.run.status, vb.kept_containers], after: after.blockers }));
  // a staff appointment on A's transaction (even cancelled) still blocks
  const tx = await one(`SELECT id, branch_id FROM public.transactions WHERE import_run_id = $1`, [ra.id]);
  await raw(`INSERT INTO public.transport_trips (org_id, transaction_id, destination, status, status_reason) VALUES ($1, $2, 'رحلة موظف', 'cancelled', 'ألغاها الموظف')`, [A, tx.id]);
  const staff = await rpc('admin', `SELECT public.legacy_import_void($1, $2, $3) r`, [ra.id, 'اختبار', { dry_run: true }]);
  await check('H2 a staff trip on A\'s transaction (cancelled) still blocks A\'s void', async () =>
    (staff.blockers.total === 1 && staff.blockers.items[0].table === 'transport_trips' && staff.blockers.items[0].reason === 'added_later') || J(staff.blockers));
  await raw(`DELETE FROM public.transport_trips WHERE transaction_id = $1 AND destination = 'رحلة موظف'`, [tx.id]);
  const va = await voidAll(ra.id, 'هارنس: إلغاء أ');
  await check('H3 A then voids; B\'s kept container stays on A\'s (closed) transaction', async () => {
    const n = await num(`SELECT count(*) n FROM public.containers WHERE transaction_id = $1 AND container_no = $2`, [tx.id, iso('QQQU', '410002')]);
    return (va.run.status === 'voided' && n === 1) || J({ va: va.run.status, n });
  });
}

/* ================================================================== 11. RLS, privileges, wrappers */
async function secStatic() {
  section('11. privileges, dictionary, supa.js wrappers, i18n');
  await check('helpers are not callable by authenticated / anon; the dictionary RPC is (no tenant data); tables have RLS', async () => {
    const e1 = await code(() => as('jed', `SELECT app.li_ctx($1)`, [A]));
    const e2 = await code(() => as('anon', `SELECT public.legacy_import_dictionary()`));
    const dct = await rpc('jed', `SELECT public.legacy_import_dictionary() r`);
    const rls = await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('legacy_import_runs','legacy_import_rows')`);
    return (e1 === 'perm' && e2 === 'perm' && dct.entities.length === 8 && rls.every(x => x.relrowsecurity)) || J({ e1, e2, rls });
  });
  await check('dictionary: canonical legacy headers per entity (transactions 37-column names + the older sheet), field keys, limits, labels', async () => {
    const d = await rpc('admin', `SELECT public.legacy_import_dictionary() r`);
    const tx = d.entities.find(e => e.entity === 'transactions');
    const h = tx.fields.flatMap(f => f.headers);
    const need = ['رقم المعاملة', 'التسلسل', 'المستورد', 'رقم البوليصة', 'رقم الحاوية', 'الميناء', 'رقم البيان', 'حالة البيان', 'الحالة التشغيلية', 'رقم الشاسيه',
      'اسم العميل', 'المشغّل', 'اسم السفينة', 'انتهت تشغيليًا'];
    const pay = d.entities.find(e => e.entity === 'payments').fields.map(f => f.headers[0]);
    return (need.every(x => h.includes(x)) && pay.includes('مصدر تمويل السداد') && d.limits.rows_per_call === 500 && d.limits.files === 20
      && d.labels.li_message.custody_negative.ar && J(d.entities.map(e => e.entity)) === J(ENTS)) || J({ miss: need.filter(x => !h.includes(x)), pay });
  });
  await check('import RPCs: EXECUTE for authenticated only (anon revoked)', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'legacy_import_%'`);
    return (r.length === RPCS.length && r.every(x => !x.a && x.u)) || J(r);
  });
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  await check('supa.js: one exported wrapper per RPC, calling it by name', () => {
    const W = { legacyImportDictionary: 'legacy_import_dictionary', legacyImportCreateRun: 'legacy_import_create_run', legacyImportSetOptions: 'legacy_import_set_options',
      legacyImportStage: 'legacy_import_stage', legacyImportValidate: 'legacy_import_validate', legacyImportCommit: 'legacy_import_commit',
      legacyImportVoid: 'legacy_import_void', legacyImportGetRun: 'legacy_import_get_run', legacyImportListRuns: 'legacy_import_list_runs',
      legacyImportListRows: 'legacy_import_list_rows', legacyImportSkipRows: 'legacy_import_skip_rows', legacyImportQueueDaftra: 'legacy_import_queue_daftra',
      legacyImportDaftraCandidates: 'legacy_import_daftra_candidates' };
    const miss = Object.keys(W).filter(f => !new RegExp('function ' + f + '\\(').test(supa) || !new RegExp(f + ': ' + f + '[,\\n]').test(supa) || !supa.includes("'" + W[f] + "'"));
    return (miss.length === 0 && Object.values(W).sort().join() === RPCS.join()) || 'missing: ' + miss.join(', ');
  });
  await check('i18n: the MRS_LI_* codes in Arabic + English (i18n.js and supa.js)', () => {
    const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
    const need = ['MRS_LI_STATE', 'MRS_LI_LIMIT', 'MRS_LI_BUSY', 'MRS_LI_VOID_BLOCKED'];
    const c = k => (i18n.match(new RegExp('\\b' + k + ':', 'g')) || []).length;
    return (need.every(k => c(k) >= 2 && supa.includes(k + ':')) && i18n.includes('cdetail_MRS_LI_STATE_open_run') && supa.includes("'MRS_LI_STATE:open_run'"))
      || J(need.map(k => [k, c(k), supa.includes(k + ':')]));
  });
}

/* ================================================================== main */
async function main() {
  await secFile();
  await secPreflight();
  db = new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
    for (const f of migFiles()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
    pass('loaded ' + migFiles().length + ' migrations + seed');
  } catch (e) { fail('load', errText(e)); return finish(); }
  try { await fixtures(); pass('fixtures'); } catch (e) { fail('fixtures', errText(e) + ' ' + (e.stack || '').split('\n')[1]); return finish(); }
  for (const s of [secParsers, secScope, secStage, secValidate, secCommit, secQuiet, secDaftra, secVoid, secReview, secHarness, secStatic]) {
    try { await s(); } catch (e) { fail(s.name, 'section threw: ' + errText(e) + ' ' + (e.stack || '').split('\n')[1]); }
  }
  finish();
}
function finish() {
  console.log('\n' + nPass + ' passed, ' + nFail + ' failed');
  if (nFail) { console.log('\nFailures:\n  ' + fails.join('\n  ')); process.exit(1); }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
