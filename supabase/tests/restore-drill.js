#!/usr/bin/env node
/*
  Marsa (مرسى) — G2.14 restore drill.  LOCAL TESTS ONLY (PGlite). Never point it at Supabase.

  1. Build:   shim.sql → supabase/migrations/*.sql (sorted) → seed.sql → sample data for two orgs
              (org A = seed "blue-sea", org B = "org-b"), partly through the real RPCs so that
              audit_log, transaction_events, idempotency_keys, invitations and client_errors are filled.
  2. Backup:  physical backup of the whole cluster (db.dumpDataDir()).
  3. Restore: into a brand-new PGlite (new PGlite({ loadDataDir })), source closed first.
  4. Compare: for every table in schemas public / app / auth / storage: row count + md5 of the rows
              in a fixed order; sequence positions (never behind; a forward WAL gap is allowed);
              catalog fingerprint (functions, policies, RLS flags, grants, triggers).
  5. Sanity:  a short RLS / RPC subset on the RESTORED database.
  Prints PASS / FAIL; exit code 1 on any mismatch or failed sanity check.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/restore-drill.js [/path/to/marsa-website] [--quiet] [--tamper]
  --tamper alters one restored row before the comparison (self-test: the drill must then FAIL).
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const TX1 = '0b5e0000-0000-4000-8000-000000000201';
const TX3 = '0b5e0000-0000-4000-8000-000000000203';
const B = 'bbbb0000-0000-4000-8000-000000000001';
const B_BR = 'bbbb0000-0000-4000-8000-000000000011';
const B_CL = 'bbbb0000-0000-4000-8000-000000000101';
const B_TX = 'bbbb0000-0000-4000-8000-000000000201';
const B_DOC = 'bbbb0000-0000-4000-8000-000000000501';
const SEED_TOKEN = 'deadbeef'.repeat(8);
const U = {
  adminA: 'dddd0000-0000-4000-8000-000000000001',
  staffA: 'dddd0000-0000-4000-8000-000000000002',
  clientA: 'dddd0000-0000-4000-8000-000000000003',
  adminB: 'dddd0000-0000-4000-8000-000000000004',
  staffB: 'dddd0000-0000-4000-8000-000000000005'
};
const KEY_REQ = '0d0d0000-0000-4000-8000-000000000001';
const KEY_INV = '0d0d0000-0000-4000-8000-00000000000a';   // G4 supplier invoice (replay after restore)
const KEY_PUSH = '0d0d0000-0000-4000-8000-00000000000b';  // G5 push request (replay after restore)
const KEY_INTENT = '0d0d0000-0000-4000-8000-00000000000c'; // G5 billing intent
const G5_TABLES = ['daftra_connections', 'daftra_client_links', 'daftra_item_links', 'billing_intents', 'billing_intent_lines',
  'billing_sync_jobs', 'billing_sync_attempts', 'billing_review_items'];

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else if (who === 'service') {
    await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  } else {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
const errText = e => (e && (e.message + ' ' + (e.detail || ''))) || String(e);
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
  try { await db.exec(sql); if (!QUIET) console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}

/* ------------------------------------------------------------------ sample data */
const reqPayload = (phone, over) => ({
  fullName: 'زائر تجريبي', company: 'شركة زائر تجريبية', phone, email: 'visitor@example.com', clientType: 'business',
  crNumber: '7000000' + phone.slice(-3), direction: 'import', service: 'clearance', mode: 'sea', country: 'الصين',
  port: 'ميناء جدة الإسلامي', goods: 'بضاعة اختبار الاستعادة', containerType: '40ft', containerNumbers: 'TSTU0000031',
  count: 1, blNumber: 'RSTBL' + phone.slice(-4), terms: true, ...over
});

async function buildSample() {
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
      ('${U.adminA}', 'admin.a@restore.example.com', now()), ('${U.staffA}', 'staff.a@restore.example.com', now()),
      ('${U.clientA}', 'client.a@restore.example.com', now()), ('${U.adminB}', 'admin.b@restore.example.com', now()),
      ('${U.staffB}', 'staff.b@restore.example.com', now());
    INSERT INTO public.organizations (id, slug, name_ar, public_intake_enabled) VALUES ('${B}', 'org-b', 'مؤسسة ب التجريبية', true);
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع الرياض ب');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'), ('${U.staffA}', '${A}', NULL, 'clearance_staff'),
      ('${U.clientA}', '${A}', NULL, 'client'),
      ('${U.adminB}', '${B}', NULL, 'admin'), ('${U.staffB}', '${B}', NULL, 'clearance_staff');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CL101}', '${U.clientA}', 'owner');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone, notes)
      VALUES ('${B_CL}', '${B}', 'business', 'عميل المؤسسة ب', '0509999999', 'ملاحظة داخلية ب');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, bl_number)
      VALUES ('${B_TX}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea', 'BBL0001');
    INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ('${B}', '${B_TX}', 'BBBU0000001');
    INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, uploaded_by, visibility)
      VALUES ('${B_DOC}', '${B}', '${B_TX}', 'commercial_invoice', '${B}/${B_TX}/${B_DOC}/inv.pdf', '${'b'.repeat(64)}', 'inv.pdf', 100, '${U.staffB}', 'internal');
    INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('documents', '${B}/${B_TX}/${B_DOC}/inv.pdf', '${U.staffB}');
    INSERT INTO public.import_batches (org_id, file_name, file_fingerprint, created_by)
      VALUES ('${B}', 'b.xlsx', '${'1f'.repeat(32)}', '${U.staffB}');
    INSERT INTO public.document_extractions (org_id, transaction_id, doc_type, source_name, source_sha256, engine, languages, raw_text, extracted_fields, created_by)
      VALUES ('${B}', '${B_TX}', 'commercial_invoice', 'b-inv.jpg', '${'e'.repeat(64)}', 'tesseract.js@5.1.1', 'ara+eng', 'فاتورة ب', '{"invoice_number":"B-1"}', '${U.staffB}');
  `);
  // activity through the real RPCs (fills audit_log, transaction_events, idempotency_keys, invitations, client_errors)
  const r1 = await rpc('anon', `SELECT public.submit_service_request($1) r`, [reqPayload('0559000001', { idempotencyKey: KEY_REQ })]);
  await rpc('anon', `SELECT public.submit_service_request($1) r`, [reqPayload('0559000002', { orgSlug: 'org-b' })]);
  await rpc('anon', `SELECT public.submit_contact_message($1) r`, [{ name: 'زائر أ', phone: '0559000003', email: 'a@example.com', subject: 'quote', message: 'رسالة اختبار الاستعادة أ', consent: true }]);
  await rpc('anon', `SELECT public.submit_contact_message($1) r`, [{ orgSlug: 'org-b', name: 'زائر ب', phone: '0559000004', email: 'b@example.com', subject: 'quote', message: 'رسالة اختبار الاستعادة ب', consent: true }]);
  const req = (await q(`SELECT id::text id FROM public.service_requests WHERE ref = $1`, [r1.ref]))[0].id;
  await rpc('staffA', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [req, JED, '0d0d0000-0000-4000-8000-000000000002']);
  await rpc('staffA', `SELECT public.set_transaction_status($1, 'in_progress', NULL, $2) r`, [TX3, '0d0d0000-0000-4000-8000-000000000003']);
  await rpc('adminA', `SELECT public.set_financial_status($1, 'estimate_only', NULL) r`, [TX1]);
  await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, { email: 'new.staff@restore.example.com', role: 'clearance_staff', branch_id: JED, idempotencyKey: '0d0d0000-0000-4000-8000-000000000004' }]);
  await rpc('staffA', `SELECT public.log_client_error($1) r`, [{ orgId: A, message: 'restore drill error A', code: 'E_A' }]);
  await rpc('staffB', `SELECT public.log_client_error($1) r`, [{ orgId: B, message: 'restore drill error B', code: 'E_B' }]);
  await rpc('anon', `SELECT public.log_client_error($1) r`, [{ message: 'restore drill visitor error' }]);
  // G3 (20261103000100 / 0200): registry + operations rows through the real inserts / RPCs, so every G3 table
  // (and its audit / event rows) is part of the restore comparison
  await q(`SELECT app.seed_document_requirements($1)`, [A]);
  const carrier = (await as('staffA', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier','terminal_operator'], 'ناقل الاستعادة') RETURNING id`, [A]))[0].id;
  const driver = (await as('staffA', `INSERT INTO public.drivers (org_id, carrier_id, full_name, national_id_last4) VALUES ($1, $2, 'سائق الاستعادة', '4321') RETURNING id`, [A, carrier]))[0].id;
  await as('staffA', `INSERT INTO public.trucks (org_id, carrier_id, plate_no) VALUES ($1, $2, 'RST 1001')`, [A, carrier]);
  await as('staffA', `INSERT INTO public.client_aliases (org_id, client_id, alias, source) VALUES ($1, $2, 'اسم الاستعادة البديل', 'manual')`, [A, CL101]);
  await rpc('staffA', `SELECT public.save_bl($1, $2) r`, [{ transaction_id: TX1, bl_number: 'RSTBL-G3-1', bl_type: 'house' }, '0d0d0000-0000-4000-8000-000000000005']);
  await rpc('staffA', `SELECT public.create_appointment($1, $2) r`, [{ transaction_id: TX1, terminal_party_id: carrier, appointment_at: '2026-12-01T08:00:00Z', status: 'confirmed' }, '0d0d0000-0000-4000-8000-000000000006']);
  await rpc('staffA', `SELECT public.create_trip($1, $2) r`, [{ transaction_id: TX1, carrier_id: carrier, driver_id: driver, origin: 'ميناء جدة', destination: 'مستودع' }, '0d0d0000-0000-4000-8000-000000000007']);
  await rpc('staffA', `SELECT public.create_exception($1, $2) r`, [{ transaction_id: TX1, kind: 'inspection', reason: 'معاينة جمركية (اختبار الاستعادة)' }, '0d0d0000-0000-4000-8000-000000000008']);
  await rpc('staffA', `SELECT public.refresh_alerts($1) r`, [A]);
  // G4 (20261104000100): one row in every finance table through the real RPCs (adminA = finance-capable admin);
  // the trip above already has its carrier accrual (trigger). Idempotency keys make the replay check below possible.
  const fdoc = await rpc('adminA', `SELECT public.register_finance_document($1, $2) r`, [{ branch_id: JED, kind: 'supplier_invoice',
    original_name: 'carrier-inv.pdf', mime_type: 'application/pdf', size_bytes: 2048, sha256: '9'.repeat(64) }, '0d0d0000-0000-4000-8000-000000000009']);
  await as('adminA', `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('finance', $1, $2)`, [fdoc.storage_path, U.adminA]);
  const inv = await rpc('adminA', `SELECT public.create_supplier_invoice($1, $2) r`, [{ branch_id: JED, supplier_id: carrier,
    invoice_number: 'RST-INV-1', invoice_date: '2026-11-01', subtotal: 800, vat_amount: 120, finance_document_id: fdoc.id,
    lines: [{ description: 'نقل حاوية (اختبار الاستعادة)', quantity: 1, unit_price: 800, net_amount: 800, vat_rate: 15, service_code: 'transport' }] },
    KEY_INV]);
  const al = await rpc('adminA', `SELECT public.allocate_invoice_line($1, $2) r`, [inv.lines[0].id, JSON.stringify([{ transaction_id: TX1, amount: 800 }])]);
  const allocIds = (al.allocations || [al]).map(x => x.id);
  await rpc('adminA', `SELECT public.approve_allocations($1::uuid[], NULL) r`, [allocIds]);
  await rpc('adminA', `SELECT public.record_supplier_payment($1) r`, [{ supplier_invoice_id: inv.id, amount: 460, method: 'bank_transfer', reference: 'RST-PAY-1' }]);
  const ch = await rpc('adminA', `SELECT public.create_client_charge($1) r`, [{ transaction_id: TX1, kind: 'service', description: 'رسوم تخليص (استعادة)', unit_price: 1500 }]);
  await rpc('adminA', `SELECT public.set_charge_status($1, 'approved', NULL) r`, [ch.id]);
  await rpc('adminA', `SELECT public.record_charge_collection($1) r`, [{ charge_id: ch.id, amount: 500, method: 'cash', reference: 'RST-COL-1' }]);
  await rpc('adminA', `SELECT public.create_demurrage_case($1) r`, [{ transaction_id: TX1, kind: 'storage', estimated_amount: 250 }]);
  await rpc('adminA', `SELECT public.create_cost_adjustment($1) r`, [{ kind: 'amendment', supplier_invoice_id: inv.id, reason: 'تعديل (اختبار الاستعادة)' }]);
  r1.g4 = { inv: inv.id };
  // G5 (20261105000100): a row in every billing table — mock connection, probe completed by the worker identity,
  // a final intent on TX1 with the approved charge, a push request (client / item links + queued job), a review item
  // (owner insert: the natural path needs an issued invoice) and a persisted mock account.
  await rpc('adminA', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'mock', subdomain: 'marsa-restore', sync_enabled: true }]);
  await rpc('adminA', `SELECT public.request_daftra_probe($1, NULL) r`, [A]);
  const caps = {};
  ['clients.search_by_ref', 'clients.read', 'clients.create', 'clients.update', 'products.search_by_code', 'products.search_by_name',
    'products.create', 'invoices.create_draft', 'invoices.read', 'invoices.search_by_reference', 'invoices.update_draft',
    'invoices.line_reference_field', 'invoices.version_token', 'invoices.multi_currency', 'invoices.issue', 'payments.read',
    'credit_notes.create'].forEach(k => { caps[k] = { supported: !['invoices.issue', 'credit_notes.create'].includes(k), evidence: 'mock' }; });
  const ctx = (await rpc('service', `SELECT public.daftra_claim_jobs('restore-worker', 5) r`)).find(c => c.job.kind === 'probe');
  await rpc('service', `SELECT public.daftra_complete_job($1, $2) r`, [ctx.attempt_id, { outcome: 'ok',
    effects: { capabilities: caps, account: { currency: 'SAR' } },
    calls: [{ op: 'probe', at: '2026-11-02T08:00:00Z', ms: 3, request: {}, response: { ok: true }, error: null, applied: 'yes' }] }]);
  const intent = await rpc('adminA', `SELECT public.create_billing_intent($1, $2) r`, [{ transaction_id: TX1, purpose: 'final', currency: 'SAR' }, KEY_INTENT]);
  const intentId = intent.id || intent.intent.id;
  const push = await rpc('adminA', `SELECT public.request_billing_push($1, $2) r`, [intentId, KEY_PUSH]);
  await q(`INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, kind, details) VALUES ($1, $2, $3, 'issued_mismatch', '{"drill":true}')`, [A, TX1, intentId]);
  await rpc('service', `SELECT public.daftra_mock_save($1, $2, 0) r`, [A, { clients: [{ id: 'c-1', reference: 'MRSC-drill' }] }]);
  r1.g5 = { intent: intentId, job: push.job.id };
  return r1;
}

/* ------------------------------------------------------------------ fingerprint */
const SCHEMAS = ['public', 'app', 'auth', 'storage'];
async function snapshot() {
  const tables = await q(`SELECT n.nspname s, c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE c.relkind IN ('r','p') AND n.nspname = ANY ($1) ORDER BY 1, 2`, [SCHEMAS]);
  const out = {};
  for (const { s, t } of tables) {
    // whole-row text in a fixed order: independent of physical order / ctid
    const r = (await q(`SELECT count(*)::int n, coalesce(md5(string_agg(x.r, E'\\n' ORDER BY x.r)), '-') h
                          FROM (SELECT t::text r FROM ${s}.${'"' + t + '"'} t) x`))[0];
    out[`${s}.${t}`] = r;
  }
  for (const r of await q(`SELECT schemaname || '.' || sequencename k, coalesce(last_value, 0)::text v FROM pg_sequences
                             WHERE schemaname = ANY ($1)`, [SCHEMAS])) {
    out['seq ' + r.k] = { n: 1, h: r.v };
  }
  const cat = (await q(`SELECT
      (SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || p.prosecdef || coalesce(array_to_string(p.proacl, ','), ''), ',' ORDER BY 1))
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ANY ($1)) f,
      (SELECT md5(string_agg(schemaname || tablename || policyname || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY 1))
         FROM pg_policies WHERE schemaname = ANY ($1)) p,
      (SELECT md5(string_agg(n.nspname || c.relname || c.relrowsecurity || coalesce(array_to_string(c.relacl, ','), ''), ',' ORDER BY 1))
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ANY ($1) AND c.relkind IN ('r','p','v')) r,
      (SELECT md5(string_agg(tgrelid::regclass::text || tgname, ',' ORDER BY 1)) FROM pg_trigger WHERE NOT tgisinternal) t`, [SCHEMAS]))[0];
  out['catalog functions'] = { n: 1, h: cat.f };
  out['catalog policies'] = { n: 1, h: cat.p };
  out['catalog tables/RLS/grants'] = { n: 1, h: cat.r };
  out['catalog triggers'] = { n: 1, h: cat.t };
  return out;
}

/* ------------------------------------------------------------------ main */
async function main() {
  db = new PGlite();
  section('1. build source database');
  const migDir = path.join(SUPA, 'migrations');
  const migs = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort().map(f => path.join(migDir, f));
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migs) if (!await runFile(m)) return finish();
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return finish();
  let r1;
  try { r1 = await buildSample(); pass('sample data for two orgs (fixtures + RPC activity)'); }
  catch (e) { fail('sample data', errText(e)); return finish(); }

  const before = await snapshot();
  const empty = ['public.organizations', 'public.transactions', 'public.audit_log', 'public.transaction_events', 'public.idempotency_keys',
    'public.invitations', 'public.client_errors', 'public.schema_versions', 'public.documents', 'storage.objects',
    // G3
    'public.parties', 'public.drivers', 'public.trucks', 'public.client_aliases', 'public.customs_declarations', 'public.bills_of_lading',
    'public.transaction_bls', 'public.document_requirements', 'public.port_appointments', 'public.transport_trips',
    'public.operational_exceptions', 'public.operational_alerts', 'public.operational_alert_runs',
    // G4
    'public.finance_documents', 'public.supplier_invoices', 'public.supplier_invoice_lines', 'public.cost_allocations',
    'public.cost_accruals', 'public.supplier_payments', 'public.client_charges', 'public.charge_collections',
    'public.demurrage_cases', 'public.cost_adjustments',
    // G5
    ...G5_TABLES.map(t => 'public.' + t), 'public.daftra_mock_accounts']
    .filter(k => !before[k] || before[k].n === 0);
  await check('source has rows in the key tables (drill is not vacuous)', () => empty.length === 0 || 'empty: ' + empty.join(', '));
  await check('both orgs present in the source', async () =>
    (await q(`SELECT count(DISTINCT org_id)::int n FROM public.transactions`))[0].n === 2);

  section('2. physical backup → 3. restore into a fresh PGlite');
  let dump;
  try {
    dump = await db.dumpDataDir('gzip');
    pass(`dumpDataDir: ${(dump.size / 1024 / 1024).toFixed(1)} MB`);
  } catch (e) { fail('dumpDataDir', errText(e)); return finish(); }
  await db.close();
  try {
    db = new PGlite({ loadDataDir: dump });
    await db.waitReady;
    await q('SELECT 1');
    pass('restored database opens');
  } catch (e) { fail('restore (loadDataDir)', errText(e)); return finish(); }

  section('4. compare row counts + md5 per table, sequences, catalog');
  // --tamper: self-test of the drill — change one row after restore; the comparison must FAIL
  if (args.includes('--tamper')) await q(`UPDATE public.clients SET notes = 'tampered' WHERE id = $1`, [CL101]);
  const after = await snapshot();
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let tables = 0, mismatches = 0;
  for (const k of [...keys].sort()) {
    const a = before[k], b = after[k];
    if (!k.startsWith('seq ') && !k.startsWith('catalog')) tables++;
    if (!a || !b) { mismatches++; fail('present in both: ' + k, a ? 'missing after restore' : 'only after restore'); continue; }
    // sequences: Postgres WAL-logs sequences ahead (up to 32 values), so after crash recovery
    // they may jump FORWARD (gaps are fine). Going backwards would mean duplicate ids → fail.
    if (k.startsWith('seq ') && a.n === b.n && BigInt(b.h) >= BigInt(a.h) && BigInt(b.h) - BigInt(a.h) <= 32n) {
      if (!QUIET) console.log(`  ok  ${k.padEnd(40)} ${a.h} → ${b.h} (forward gap allowed)`);
      continue;
    }
    if (a.n !== b.n || a.h !== b.h) { mismatches++; fail('identical: ' + k, `before n=${a.n} md5=${a.h} / after n=${b.n} md5=${b.h}`); continue; }
    if (!QUIET) console.log(`  ok  ${k.padEnd(40)} ${String(a.n).padStart(5)}  ${a.h}`);
  }
  if (mismatches === 0) pass(`${tables} tables + sequences + catalog identical after restore`);

  section('5. RLS / RPC sanity on the restored database');
  await check('health_check works (anon) and reports the latest schema version', async () => {
    const r = await rpc('anon', `SELECT public.health_check() r`);
    const latest = path.basename(migs[migs.length - 1]).split('_')[0];
    return (r.ok && r.schema_version === latest) || JSON.stringify(r);
  });
  await check('RLS still enabled on every public table', async () => {
    const r = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
    return r.length === 0 || 'RLS off: ' + r.map(x => x.relname).join(', ');
  });
  await check('anon cannot read transactions / clients / audit_log', async () => {
    for (const t of ['transactions', 'clients', 'audit_log']) {
      const d = await denied('anon', `SELECT 1 FROM public.${t} LIMIT 1`);
      if (d !== true) return t + ': ' + d;
    }
    return true;
  });
  await check('staffB cannot read org A transactions / clients / documents', async () => {
    for (const t of ['transactions', 'clients', 'documents', 'service_requests']) {
      const d = await denied('staffB', `SELECT 1 FROM public.${t} WHERE org_id = $1`, [A]);
      if (d !== true) return t + ': ' + d;
    }
    return true;
  });
  await check('staffB still reads its own org B transaction', async () =>
    (await as('staffB', `SELECT 1 FROM public.transactions WHERE id = $1`, [B_TX])).length === 1);
  await check('clientA sees only its own client record', async () => {
    const r = await as('clientA', `SELECT id::text id FROM public.clients`);
    return (r.length === 1 && r[0].id === CL101) || JSON.stringify(r);
  });
  await check('storage: staffA cannot read the org B object', () => denied('staffA',
    `SELECT 1 FROM storage.objects WHERE bucket_id = 'documents' AND name LIKE $1`, [B + '/%']));
  await check('public_track with the seed test token still works', async () => {
    const ref = (await q(`SELECT ref FROM public.service_requests WHERE id = '0b5e0000-0000-4000-8000-000000000401'`))[0].ref;
    return !!(await rpc('anon', `SELECT public.public_track($1, $2) r`, [ref, SEED_TOKEN]));
  });
  await check('idempotency store restored: replay returns the same ref, no new row', async () => {
    const r = await rpc('anon', `SELECT public.submit_service_request($1) r`, [reqPayload('0559000001', { idempotencyKey: KEY_REQ })]);
    const n = (await q(`SELECT count(*)::int n FROM public.service_requests WHERE phone = '0559000001'`))[0].n;
    return (r.ref === r1.ref && r.replayed === true && r.tracking_token === null && n === 1) || JSON.stringify({ r, n });
  });
  await check('audit reader: adminA reads org A, refused on org B', async () => {
    const r = await rpc('adminA', `SELECT public.admin_audit_log($1, '{"limit": 5}') r`, [A]);
    if (r.items.length !== 5) return 'org A items: ' + r.items.length;
    try { await as('adminA', `SELECT public.admin_audit_log($1, '{}')`, [B]); return 'org B readable'; }
    catch (e) { return /MRS_FORBIDDEN/.test(errText(e)) || errText(e); }
  });
  await check('G3 after restore: staffB sees no org A registry / operations rows', async () => {
    for (const t of ['parties', 'customs_declarations', 'bills_of_lading', 'port_appointments', 'operational_exceptions', 'operational_alerts']) {
      const r = await denied('staffB', `SELECT 1 FROM public.${t} WHERE org_id = $1`, [A]);
      if (r !== true) return t + ': ' + r;
    }
    return denied('staffB', `SELECT id FROM public.transport_trips WHERE org_id = $1`, [A]);
  });
  await check('G3 after restore: list_alerts / trip_finance / tx_checklist answer for org A staff', async () => {
    const al = await rpc('staffA', `SELECT public.list_alerts($1) r`, [A]);
    const trip = (await q(`SELECT id FROM public.transport_trips WHERE org_id = $1 LIMIT 1`, [A]))[0].id;
    const fin = await rpc('adminA', `SELECT public.trip_finance($1) r`, [[trip]]);
    const ck = await rpc('staffA', `SELECT public.tx_checklist($1) r`, [TX1]);
    return (al.total > 0 && fin[trip] && ck.configured === true && ck.items.length > 0) || JSON.stringify({ al: al.total, fin, ck: ck.configured });
  });
  await check('G4 after restore: staffB / staffA / clientA see no finance rows of org A', async () => {
    for (const t of ['finance_documents', 'supplier_invoices', 'supplier_invoice_lines', 'cost_allocations', 'cost_accruals',
      'supplier_payments', 'client_charges', 'charge_collections', 'demurrage_cases', 'cost_adjustments']) {
      for (const who of ['staffB', 'staffA', 'clientA']) {
        const r = await denied(who, `SELECT 1 FROM public.${t} WHERE org_id = $1`, [A]);
        if (r !== true) return who + ' ' + t + ': ' + r;
      }
    }
    return true;
  });
  await check('G4 after restore: tx_margin / tx_costs give the same figures; invoice replay returns the same id', async () => {
    const m = await rpc('adminA', `SELECT public.tx_margin($1) r`, [TX1]);
    const sar = (m.currencies || []).find(c => c.currency === 'SAR') || {};
    const c = await rpc('adminA', `SELECT public.tx_costs($1) r`, [TX1]);
    const inv = (await q(`SELECT company_paid_amount::text p, payment_status s FROM public.supplier_invoices WHERE id = $1`, [r1.g4.inv]))[0];
    const again = await rpc('adminA', `SELECT public.create_supplier_invoice($1, $2) r`, [{ branch_id: JED, supplier_id: (await q(`SELECT supplier_id FROM public.supplier_invoices WHERE id = $1`, [r1.g4.inv]))[0].supplier_id,
      invoice_number: 'RST-INV-1', invoice_date: '2026-11-01', subtotal: 800, vat_amount: 120, finance_document_id: (await q(`SELECT finance_document_id FROM public.supplier_invoices WHERE id = $1`, [r1.g4.inv]))[0].finance_document_id,
      lines: [{ description: 'نقل حاوية (اختبار الاستعادة)', quantity: 1, unit_price: 800, net_amount: 800, vat_rate: 15, service_code: 'transport' }] }, KEY_INV]);
    const ok = Number(sar.charges_service) === 1500 && Number(sar.cost_confirmed) === 0 && Number(sar.cost_estimated) === 1050
      && c.charges.length === 1 && c.collections.length === 1 && inv.p === '460.00' && inv.s === 'partial' && again.id === r1.g4.inv;
    return ok || JSON.stringify({ sar, inv, again: again.id });
  });
  await check('G4 after restore: clientA gets no tx_costs / tx_margin for its own TX1', async () => {
    for (const fn of ['tx_costs', 'tx_margin']) {
      try { await as('clientA', `SELECT public.${fn}($1)`, [TX1]); return fn + ' answered for a client'; }
      catch (e) { if (!/MRS_FORBIDDEN|MRS_NOT_FOUND/.test(errText(e))) return fn + ': ' + errText(e); }
    }
    return true;
  });
  await check('G5 after restore: staffB / staffA / clientA see no billing rows of org A; nobody but the service role reads the mock account', async () => {
    for (const t of G5_TABLES) {
      for (const who of ['staffB', 'staffA', 'clientA']) {
        const r = await denied(who, `SELECT 1 FROM public.${t} WHERE org_id = $1`, [A]);
        if (r !== true) return who + ' ' + t + ': ' + r;
      }
      if (!(await as('adminA', `SELECT 1 FROM public.${t} WHERE org_id = $1 LIMIT 1`, [A])).length) return 'adminA lost ' + t;
    }
    try { await as('adminA', `SELECT 1 FROM public.daftra_mock_accounts`); return 'adminA reads daftra_mock_accounts'; }
    catch (e) { if (!/permission denied/.test(errText(e))) return errText(e); }
    const m = await rpc('service', `SELECT public.daftra_mock_load($1) r`, [A]);
    return (m.version === 1 && m.state.clients[0].id === 'c-1') || JSON.stringify(m);
  });
  await check('G5 after restore: push replay returns the same live job; the worker claims it once; staff cannot call worker RPCs', async () => {
    const again = await rpc('adminA', `SELECT public.request_billing_push($1, $2) r`, [r1.g5.intent, KEY_PUSH]);
    const dup = await rpc('adminA', `SELECT public.request_billing_push($1, NULL) r`, [r1.g5.intent]);
    const jobs = (await q(`SELECT count(*)::int n FROM public.billing_sync_jobs WHERE intent_id = $1`, [r1.g5.intent]))[0].n;
    const claimed = await rpc('service', `SELECT public.daftra_claim_jobs('restore-worker-2', 5) r`);
    const pushCtx = claimed.find(c => c.job.id === r1.g5.job);
    try { await as('adminA', `SELECT public.daftra_claim_jobs('x', 1)`); return 'adminA executed daftra_claim_jobs'; }
    catch (e) { if (!/permission denied/.test(errText(e))) return errText(e); }
    return (again.job.id === r1.g5.job && dup.job.id === r1.g5.job && dup.deduplicated === true && jobs === 1 && !!pushCtx
            && pushCtx.intent.lines.length === 1) || JSON.stringify({ again: again.job.id, dup: dup.job.id, jobs, claimed: claimed.length });
  });
  await check('writes work after restore (new request gets the next ref)', async () => {
    const r = await rpc('anon', `SELECT public.submit_service_request($1) r`, [reqPayload('0559000099', {})]);
    return /^[A-Z]+-\d{4}-\d{6}$/.test(r.ref) || JSON.stringify(r);
  });
  finish();
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'RESTORE DRILL FAILED' : 'RESTORE DRILL PASS') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
