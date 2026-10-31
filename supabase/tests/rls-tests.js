#!/usr/bin/env node
/*
  Marsa (مرسى) — STAGING RLS / security test suite.  LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql
  then builds two tenants (org A = seed "blue-sea", org B = "org-b") and these users:
    clientA (client 101, org A)   clientA2 (client 102, org A)   staffA (clearance_staff, org A, all branches)
    adminA (admin, org A)         staffB (clearance_staff, org B) clientB (client, org B)   anon (visitor)

  Prints PASS / FAIL / WARN per case.
    FAIL = a stated security requirement is broken (exit code 1).
    WARN = design-level finding for the security reviewer (exit 0 unless --strict).

  usage (no project dependency is added; PGlite lives outside the repo):
    mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm i @electric-sql/pglite      # once
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/rls-tests.js [/path/to/marsa-website] [--strict] [--quiet]
    (default site path: /Users/apple/Downloads/marsa-website)
  When a new public table or RPC is added, the catalog checks FAIL until it is added to
  TENANT_TABLES / the expected RPC lists below — that is intentional.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const STRICT = args.includes('--strict');
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');

let nPass = 0, nFail = 0, nWarn = 0;
const fails = [], warns = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function warn(name, why) { nWarn++; warns.push(name + ' — ' + why); console.log('WARN  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const CL102 = '0b5e0000-0000-4000-8000-000000000102';
const TX1 = '0b5e0000-0000-4000-8000-000000000201'; // client 101, JED, 2 containers
const TX2 = '0b5e0000-0000-4000-8000-000000000202'; // client 102, DMM, 1 container
const TX3 = '0b5e0000-0000-4000-8000-000000000203'; // client 103, JED, air, 0 containers
const CT303 = '0b5e0000-0000-4000-8000-000000000303';
const REQ_SEED = '0b5e0000-0000-4000-8000-000000000401';
const SEED_TOKEN = 'deadbeef'.repeat(8);

const B = 'bbbb0000-0000-4000-8000-000000000001';
const B_BR = 'bbbb0000-0000-4000-8000-000000000011';
const B_CL = 'bbbb0000-0000-4000-8000-000000000101';
const B_TX = 'bbbb0000-0000-4000-8000-000000000201';
const B_CT = 'bbbb0000-0000-4000-8000-000000000301';
const B_DOC_INT = 'bbbb0000-0000-4000-8000-000000000501';
const B_DOC_CLI = 'bbbb0000-0000-4000-8000-000000000502';
const B_BATCH = 'bbbb0000-0000-4000-8000-000000000601';
const B_EXT = 'bbbb0000-0000-4000-8000-000000000701';
const EXT_A = 'a0e00000-0000-4000-8000-000000000001';  // org A OCR result, unlinked, saved by staffA

const DOC_A_INT = 'a0c00000-0000-4000-8000-000000000001';  // TX1 internal
const DOC_A_CLI = 'a0c00000-0000-4000-8000-000000000002';  // TX1 client-visible
const DOC_A2_CLI = 'a0c00000-0000-4000-8000-000000000003'; // TX2 client-visible (clientA2)
const DOC_A_PEND = 'a0c00000-0000-4000-8000-000000000004'; // TX1 registered by staffA, bytes not uploaded yet
const DOC_CA_OWN = 'a0c00000-0000-4000-8000-000000000005'; // TX1 uploaded by clientA

const U = {
  clientA: 'aaaa0000-0000-4000-8000-000000000001',
  clientA2: 'aaaa0000-0000-4000-8000-000000000002',
  staffA: 'aaaa0000-0000-4000-8000-000000000003',
  adminA: 'aaaa0000-0000-4000-8000-000000000004',
  staffB: 'aaaa0000-0000-4000-8000-000000000005',
  clientB: 'aaaa0000-0000-4000-8000-000000000006'
};
const FP1 = '1f'.repeat(32), FP2 = '2f'.repeat(32), FP3 = '3f'.repeat(32), FP4 = '4f'.repeat(32), FP5 = '5f'.repeat(32);
const hex = c => c.repeat(64);
const path4 = (org, tx, doc, name) => `${org}/${tx}/${doc}/${name}`;

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
const errText = e => (e && (e.message + ' ' + (e.detail || ''))) || String(e);

// expect the statement to fail with an error matching re
async function expectErr(name, promiseFn, re, policyHint) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded' + (policyHint ? ' [check: ' + policyHint + ']' : '')); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e) + (policyHint ? ' [check: ' + policyHint + ']' : '')); }
}
// fn returns true | false | string (string = failure reason)
async function check(name, fn, policyHint) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, (typeof r === 'string' ? r : 'assertion false') + (policyHint ? ' [check: ' + policyHint + ']' : ''));
  } catch (e) { fail(name, 'threw: ' + errText(e) + (policyHint ? ' [check: ' + policyHint + ']' : '')); }
}
// like check, but a false result is a WARN (design finding), not a FAIL
async function advisory(name, fn, why) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else warn(name, (typeof r === 'string' ? r + ' — ' : '') + why);
  } catch (e) { warn(name, 'threw: ' + errText(e) + ' — ' + why); }
}
// statement must be refused: either an error (permission/RLS) or 0 affected/returned rows
async function denied(who, sql, params) {
  try { const r = await as(who, sql, params); return r.length === 0 ? true : 'returned ' + r.length + ' row(s)'; }
  catch (e) { return /permission denied|row-level security|MRS_|violates/.test(errText(e)) ? true : 'unexpected error: ' + errText(e); }
}

async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}

/* ------------------------------------------------------------------ fixtures */
const basePayload = {
  fullName: 'زائر تجريبي', company: 'شركة زائر تجريبية', phone: '0550000011', email: 'visitor@example.com',
  clientType: 'business', crNumber: '7000000011', direction: 'import', service: 'clearance', mode: 'sea',
  country: 'الصين', port: 'ميناء جدة الإسلامي', goods: 'بضاعة اختبار سرية', containerType: '40ft',
  containerNumbers: 'TSTU0000021, TSTU0000022', count: 2, blNumber: 'SECRETBL0021', terms: true,
  notes: 'ملاحظة شخصية', calc: { total: 1234.5 }, documents: [{ kind: 'invoice', name: 'invoice.pdf', size: 1200 }]
};
let phoneSeq = 0;
const freshPhone = () => '0557' + String(100000 + (phoneSeq++)).slice(-6);
const P = over => ({ ...basePayload, phone: freshPhone(), ...over });

async function fixtures() {
  // users + memberships (owner = migration role, bypasses RLS like the Dashboard would)
  await db.exec(`
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${U.clientA}',  'clienta@example.com',  '{"full_name":"عميل أ"}'),
      ('${U.clientA2}', 'clienta2@example.com', '{"full_name":"عميل أ٢"}'),
      ('${U.staffA}',   'staffa@example.com',   '{"full_name":"موظف أ"}'),
      ('${U.adminA}',   'admina@example.com',   '{"full_name":"مدير أ"}'),
      ('${U.staffB}',   'staffb@example.com',   '{"full_name":"موظف ب"}'),
      ('${U.clientB}',  'clientb@example.com',  '{"role":"admin","full_name":"عميل ب"}');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}',   '${A}', NULL, 'admin'),
      ('${U.staffA}',   '${A}', NULL, 'clearance_staff'),
      ('${U.clientA}',  '${A}', NULL, 'client'),
      ('${U.clientA2}', '${A}', NULL, 'client');

    -- org B (second tenant) with a row in every tenant table
    INSERT INTO public.organizations (id, slug, name_ar) VALUES ('${B}', 'org-b', 'مؤسسة ب التجريبية');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع الرياض ب');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.staffB}',  '${B}', NULL, 'clearance_staff'),
      ('${U.clientB}', '${B}', NULL, 'client');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone, notes)
      VALUES ('${B_CL}', '${B}', 'business', 'عميل المؤسسة ب', '0509999999', 'ملاحظة داخلية ب');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${B}', '${B_CL}', '${U.clientB}', 'owner');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, bl_number, notes)
      VALUES ('${B_TX}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea', 'BBL0001', 'ملاحظة داخلية ب');
    INSERT INTO public.containers (id, org_id, transaction_id, container_no) VALUES ('${B_CT}', '${B}', '${B_TX}', 'BBBU0000001');
    INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, uploaded_by, visibility) VALUES
      ('${B_DOC_INT}', '${B}', '${B_TX}', 'commercial_invoice', '${path4(B, B_TX, B_DOC_INT, 'inv.pdf')}', '${hex('b')}', 'inv.pdf', 100, '${U.staffB}', 'internal'),
      ('${B_DOC_CLI}', '${B}', '${B_TX}', 'bill_of_lading', '${path4(B, B_TX, B_DOC_CLI, 'bl.pdf')}', '${hex('c')}', 'bl.pdf', 100, '${U.staffB}', 'client');
    INSERT INTO storage.objects (bucket_id, name, owner) VALUES
      ('documents', '${path4(B, B_TX, B_DOC_INT, 'inv.pdf')}', '${U.staffB}'),
      ('documents', '${path4(B, B_TX, B_DOC_CLI, 'bl.pdf')}', '${U.staffB}');
    INSERT INTO public.import_batches (id, org_id, file_name, file_fingerprint, created_by)
      VALUES ('${B_BATCH}', '${B}', 'b.xlsx', '${FP1}', '${U.staffB}');
    INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ('${B_BATCH}', 'Sheet1', 2, '{"b":1}');
    INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note) VALUES ('${B}', '${B_TX}', 'note', 'حدث ب');
    INSERT INTO public.document_extractions (id, org_id, transaction_id, doc_type, source_name, source_sha256, engine, languages, raw_text, extracted_fields, created_by)
      VALUES ('${B_EXT}', '${B}', '${B_TX}', 'commercial_invoice', 'b-inv.jpg', '${hex('e')}', 'tesseract.js@5.1.1', 'ara+eng',
              'فاتورة ب', '{"invoice_number":"B-1"}', '${U.staffB}');

    -- a closed-intake tenant and a tenant used for the org-wide rate guard
    INSERT INTO public.organizations (id, slug, name_ar, public_intake_enabled) VALUES
      ('cccc0000-0000-4000-8000-000000000001', 'org-closed', 'مؤسسة مغلقة', false),
      ('dddd0000-0000-4000-8000-000000000001', 'org-flood', 'مؤسسة اختبار الإغراق', true);
  `);
  // org B public intake rows (request + contact message) through the real RPCs
  await as('anon', 'SELECT public.submit_service_request($1)', [P({ orgSlug: 'org-b' })]);
  await as('anon', 'SELECT public.submit_contact_message($1)', [{ orgSlug: 'org-b', name: 'زائر ب', phone: '0551111111', email: 'b@example.com', subject: 'quote', message: 'رسالة اختبار للمؤسسة ب', consent: true }]);
  await as('anon', 'SELECT public.submit_contact_message($1)', [{ name: 'زائر أ', phone: '0552222222', email: 'a@example.com', subject: 'quote', message: 'رسالة اختبار للمؤسسة أ', consent: true }]);

  // org A: links done by adminA through the API (tests client_users_insert too)
  await as('adminA', `INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ($1, $2, $3, 'owner'), ($1, $4, $5, 'owner')`,
    [A, CL101, U.clientA, CL102, U.clientA2]);
  // org A documents registered by staffA through the API + their storage objects
  await asRole('staffA', async () => {
    await q(`INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, visibility) VALUES
      ($1, $5, $6, 'commercial_invoice', $8,  '${hex('1')}', 'inv.pdf', 100, 'internal'),
      ($2, $5, $6, 'bill_of_lading',     $9,  '${hex('2')}', 'bl.pdf',  100, 'client'),
      ($3, $5, $7, 'bill_of_lading',     $10, '${hex('3')}', 'bl2.pdf', 100, 'client'),
      ($4, $5, $6, 'packing_list',       $11, '${hex('4')}', 'pl.pdf',  100, 'internal')`,
      [DOC_A_INT, DOC_A_CLI, DOC_A2_CLI, DOC_A_PEND, A, TX1, TX2,
       path4(A, TX1, DOC_A_INT, 'inv.pdf'), path4(A, TX1, DOC_A_CLI, 'bl.pdf'), path4(A, TX2, DOC_A2_CLI, 'bl2.pdf'), path4(A, TX1, DOC_A_PEND, 'pl.pdf')]);
    await q(`INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('documents', $1, $4), ('documents', $2, $4), ('documents', $3, $4)`,
      [path4(A, TX1, DOC_A_INT, 'inv.pdf'), path4(A, TX1, DOC_A_CLI, 'bl.pdf'), path4(A, TX2, DOC_A2_CLI, 'bl2.pdf'), U.staffA]);
    // org A import staging row (so the isolation sweep covers import_batches / import_rows)
    const b = (await q(`INSERT INTO public.import_batches (org_id, file_name, file_fingerprint) VALUES ($1, 'fixture.xlsx', $2) RETURNING id`, [A, FP5]))[0];
    await q(`INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ($1, 'Sheet1', 2, '{"a":1}')`, [b.id]);
    // org A OCR result (so the isolation sweep covers document_extractions)
    await q(`INSERT INTO public.document_extractions (id, org_id, doc_type, source_name, source_sha256, engine, languages, raw_text, extracted_fields)
             VALUES ($1, $2, 'commercial_invoice', 'a-inv.jpg', $3, 'tesseract.js@5.1.1', 'ara+eng', 'فاتورة أ', '{"invoice_number":"A-1"}')`, [EXT_A, A, hex('d')]);
  });
}

/* ------------------------------------------------------------------ tests */
// every tenant table: [table, owner-side sample SQL returning {id}, filter column for "by id", update clause]
const TENANT_TABLES = [
  ['organizations',      `SELECT id::text id FROM public.organizations WHERE id = $1`,                  'id::text',  'name_ar = name_ar'],
  ['branches',           `SELECT id::text id FROM public.branches WHERE org_id = $1 LIMIT 1`,           'id::text',  'org_id = org_id'],
  ['profiles',           null /* special: a member's profile */,                                       'id::text',  'full_name = full_name'],
  ['memberships',        `SELECT id::text id FROM public.memberships WHERE org_id = $1 LIMIT 1`,        'id::text',  'org_id = org_id'],
  ['org_counters',       `SELECT org_id::text id FROM public.org_counters WHERE org_id = $1 LIMIT 1`,   'org_id::text', 'last_value = last_value'],
  ['clients',            `SELECT id::text id FROM public.clients WHERE org_id = $1 LIMIT 1`,            'id::text',  'org_id = org_id'],
  ['client_users',       `SELECT id::text id FROM public.client_users WHERE org_id = $1 LIMIT 1`,       'id::text',  'org_id = org_id'],
  ['import_batches',     `SELECT id::text id FROM public.import_batches WHERE org_id = $1 LIMIT 1`,     'id::text',  'org_id = org_id'],
  ['import_rows',        `SELECT id::text id FROM public.import_rows WHERE org_id = $1 LIMIT 1`,        'id::text',  'org_id = org_id'],
  ['service_requests',   `SELECT id::text id FROM public.service_requests WHERE org_id = $1 LIMIT 1`,   'id::text',  'org_id = org_id'],
  ['transactions',       `SELECT id::text id FROM public.transactions WHERE org_id = $1 LIMIT 1`,       'id::text',  'org_id = org_id'],
  ['documents',          `SELECT id::text id FROM public.documents WHERE org_id = $1 LIMIT 1`,          'id::text',  'org_id = org_id'],
  ['containers',         `SELECT id::text id FROM public.containers WHERE org_id = $1 LIMIT 1`,         'id::text',  'org_id = org_id'],
  ['transaction_events', `SELECT id::text id FROM public.transaction_events WHERE org_id = $1 LIMIT 1`, 'id::text',  'note = note'],
  ['contact_messages',   `SELECT id::text id FROM public.contact_messages WHERE org_id = $1 LIMIT 1`,   'id::text',  'org_id = org_id'],
  ['audit_log',          `SELECT id::text id FROM public.audit_log WHERE org_id = $1 LIMIT 1`,          'id::text',  'table_name = table_name'],
  ['document_extractions', `SELECT id::text id FROM public.document_extractions WHERE org_id = $1 LIMIT 1`, 'id::text', 'review_note = review_note']
];
const ALL_PUBLIC_TABLES = TENANT_TABLES.map(t => t[0]).concat(['status_labels']);

async function isolationSweep(who, targetOrg, memberUser, label) {
  for (const [t, sampleSql, idExpr, setClause] of TENANT_TABLES) {
    const sample = t === 'profiles'
      ? (await q(`SELECT id::text id FROM public.profiles WHERE id = $1`, [memberUser]))[0]
      : (await q(sampleSql, [targetOrg]))[0];
    if (!sample) { fail(`${label}: fixture row exists in ${t}`, 'no row of the target org — test would be vacuous'); continue; }
    const orgCol = t === 'organizations' ? 'id' : (t === 'profiles' ? null : 'org_id');
    const policy = `RLS policy on public.${t}`;
    if (orgCol) {
      await check(`${label}: cannot SELECT ${t} of other org`, () => denied(who, `SELECT 1 FROM public.${t} WHERE ${orgCol} = $1`, [targetOrg]), policy + ' (SELECT)');
    }
    await check(`${label}: cannot SELECT ${t} by id`, () => denied(who, `SELECT 1 FROM public.${t} WHERE ${idExpr} = $1`, [sample.id]), policy + ' (SELECT)');
    await check(`${label}: cannot UPDATE ${t} by id`, () => denied(who, `UPDATE public.${t} SET ${setClause} WHERE ${idExpr} = $1 RETURNING 1`, [sample.id]), policy + ' (UPDATE)');
    await check(`${label}: cannot DELETE ${t} by id`, () => denied(who, `DELETE FROM public.${t} WHERE ${idExpr} = $1 RETURNING 1`, [sample.id]), policy + ' (DELETE)');
  }
}

async function main() {
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migs = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort().map(f => path.join(migDir, f));
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migs) if (!await runFile(m)) return finish();
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return finish();
  try { await fixtures(); pass('fixtures: 2 tenants, 6 users, docs, storage objects'); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }

  /* ---------------------------------------------------------------- catalog */
  section('catalog: RLS, grants, function privileges');
  await check('RLS enabled on every public table', async () => {
    const r = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
    return r.length === 0 || 'RLS disabled on: ' + r.map(x => x.relname).join(', ');
  });
  await check('every public table is covered by this suite', async () => {
    const r = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    const missing = r.map(x => x.relname).filter(t => !ALL_PUBLIC_TABLES.includes(t));
    return missing.length === 0 || 'new tables not in TENANT_TABLES: ' + missing.join(', ');
  });
  await check('anon has no table privilege except SELECT on status_labels', async () => {
    const r = await q(`SELECT table_name, privilege_type FROM information_schema.role_table_grants
                        WHERE grantee = 'anon' AND table_schema = 'public'`);
    const bad = r.filter(x => !(x.table_name === 'status_labels' && x.privilege_type === 'SELECT'));
    return bad.length === 0 || bad.map(x => x.table_name + ':' + x.privilege_type).join(', ');
  });
  await check('no policy targets anon/public except status_labels_read', async () => {
    const r = await q(`SELECT schemaname, tablename, policyname, roles::text roles FROM pg_policies
                        WHERE schemaname IN ('public','storage') AND (roles::text ~ 'anon' OR roles::text ~ 'public')`);
    const bad = r.filter(x => x.policyname !== 'status_labels_read');
    return bad.length === 0 || bad.map(x => x.tablename + '.' + x.policyname + ' ' + x.roles).join(', ');
  });
  await check('anon can execute exactly the 3 public RPCs', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE') ORDER BY 1`);
    const got = r.map(x => x.proname).join(',');
    return got === 'public_track,submit_contact_message,submit_service_request' || 'anon may execute: ' + got;
  });
  await check('anon has no USAGE on schema app', async () =>
    (await q(`SELECT has_schema_privilege('anon', 'app', 'USAGE') u`))[0].u === false);
  await check('authenticated can execute only the 13 documented public RPCs', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') ORDER BY 1`);
    const exp = ['admin_add_member', 'admin_list_members', 'admin_set_member_active', 'convert_request_to_transaction', 'import_commit', 'issue_tracking_token', 'my_context', 'public_track',
      'set_financial_status', 'set_request_status', 'set_transaction_status', 'staff_internal_fields', 'submit_contact_message', 'submit_service_request'];
    const got = r.map(x => x.proname);
    const extra = got.filter(x => !exp.includes(x));
    return extra.length === 0 || 'unexpected: ' + extra.join(', ');
  });
  await check('every SECURITY DEFINER function pins search_path', async () => {
    const r = await q(`SELECT n.nspname || '.' || p.proname f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname IN ('public','app') AND p.prosecdef
                          AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`);
    return r.length === 0 || 'missing search_path: ' + r.map(x => x.f).join(', ');
  });
  await check('authenticated cannot execute state-changing SECURITY DEFINER helpers in app (except the checked ref wrapper)', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND p.prosecdef AND p.provolatile = 'v' AND p.proname <> 'next_ref_checked'
                          AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`);
    return r.length === 0 || 'callable: ' + r.map(x => x.proname).join(', ');
  }, '0300 §7 GRANT list');
  await expectErr('authenticated cannot call app.next_ref directly', () => as('staffB', `SELECT app.next_ref($1, 'transaction')`, [A]), /permission denied/);
  await check('app.next_ref_checked gives staffB no ref and no counter bump for org A', async () => {
    const before = (await q(`SELECT coalesce(sum(last_value), 0)::int n FROM public.org_counters WHERE org_id = $1`, [A]))[0].n;
    const r = (await as('staffB', `SELECT app.next_ref_checked($1, 'transaction') r`, [A]))[0].r;
    const after = (await q(`SELECT coalesce(sum(last_value), 0)::int n FROM public.org_counters WHERE org_id = $1`, [A]))[0].n;
    return (r === null && before === after) || 'ref=' + r + ' before=' + before + ' after=' + after;
  });
  await check('anon/authenticated have no privileges on identity sequences (anon)', async () => {
    const r = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relkind = 'S'
                          AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('anon', c.oid, 'USAGE') ELSE false END`);
    return r.length === 0 || 'anon USAGE on: ' + r.map(x => x.relname).join(', ');
  }, '0700 REVOKE ALL ON ALL SEQUENCES');
  await check('storage bucket "documents" is private', async () =>
    (await q(`SELECT public FROM storage.buckets WHERE id = 'documents'`))[0].public === false);

  /* ---------------------------------------------------------------- anon */
  section('anon: no direct table access');
  for (const t of TENANT_TABLES.map(x => x[0])) {
    await expectErr(`anon cannot SELECT ${t}`, () => as('anon', `SELECT 1 FROM public.${t} LIMIT 1`), /permission denied/, 'REVOKE ALL ... FROM anon (0300 §6)');
  }
  await expectErr('anon cannot INSERT service_requests', () => as('anon',
    `INSERT INTO public.service_requests (org_id, ref, tracking_token_hash, full_name, phone, direction, mode, port, goods)
     VALUES ($1, 'X', $2, 'abc', '0500000000', 'import', 'sea', 'p', 'goods')`, [A, hex('a')]), /permission denied/);
  await expectErr('anon cannot UPDATE transactions', () => as('anon', `UPDATE public.transactions SET notes = 'x'`), /permission denied/);
  await expectErr('anon cannot DELETE contact_messages', () => as('anon', `DELETE FROM public.contact_messages`), /permission denied/);
  await check('anon can read status_labels (public dictionary)', async () => (await as('anon', `SELECT count(*)::int n FROM public.status_labels`))[0].n > 0);
  await check('anon sees no storage objects', () => denied('anon', `SELECT name FROM storage.objects`));
  await expectErr('anon cannot upload to storage', () => as('anon', `INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', $1)`, [path4(A, TX1, DOC_A_PEND, 'pl.pdf')]), /row-level security|permission denied/);
  for (const [fn, sql] of [
    ['my_context', `SELECT public.my_context()`],
    ['set_request_status', `SELECT public.set_request_status('${REQ_SEED}', 'rejected', 'x')`],
    ['convert_request_to_transaction', `SELECT public.convert_request_to_transaction('${REQ_SEED}', '${JED}', NULL)`],
    ['set_transaction_status', `SELECT public.set_transaction_status('${TX1}', 'transport', NULL)`],
    ['set_financial_status', `SELECT public.set_financial_status('${TX1}', 'estimate_only', NULL)`],
    ['issue_tracking_token', `SELECT public.issue_tracking_token('${TX1}')`],
    ['import_commit', `SELECT public.import_commit('${B_BATCH}')`],
    ['app.next_ref', `SELECT app.next_ref('${A}', 'request')`],
    ['app.insert_service_request', `SELECT app.insert_service_request('${A}', '{}'::jsonb, 'staff', NULL, NULL, NULL)`],
    ['app.is_member', `SELECT app.is_member('${A}')`]
  ]) await expectErr(`anon cannot call ${fn}`, () => as('anon', sql), /permission denied/);

  /* ---------------------------------------------------------------- tenant isolation */
  section('tenant isolation (every table, by org and by id)');
  await isolationSweep('staffB', A, U.clientA, 'staffB→orgA');
  await isolationSweep('staffA', B, U.staffB, 'staffA→orgB');
  await isolationSweep('adminA', B, U.staffB, 'adminA→orgB');
  await isolationSweep('clientA', B, U.clientB, 'clientA→orgB');

  section('tenant isolation: cross-tenant writes and RPCs');
  await expectErr('staffB cannot INSERT a client into org A', () => as('staffB',
    `INSERT INTO public.clients (org_id, client_type, name_ar) VALUES ($1, 'business', 'دخيل')`, [A]), /row-level security/, 'clients_insert');
  await expectErr('staffB cannot INSERT a transaction into org A', () => as('staffB',
    `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea')`, [A, JED, CL101]), /row-level security/, 'transactions_insert');
  await expectErr('staffB cannot link org-B transaction to org-A client (composite FK)', () => as('staffB',
    `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea')`, [B, B_BR, CL101]), /foreign key|violates/, 'transactions_client_fk');
  await expectErr('staffB cannot add a note event to an org-A transaction', () => as('staffB',
    `INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note) VALUES ($1, $2, 'note', 'x')`, [A, TX1]), /row-level security/, 'events_insert_note');
  await expectErr('staffB cannot register a document on an org-A transaction', () => as('staffB',
    `INSERT INTO public.documents (org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes)
     VALUES ($1, $2, 'other', $3, $4, 'x.pdf', 10)`, [A, TX1, `${A}/${TX1}/x/x.pdf`, hex('e')]), /row-level security|documents_path_chk/, 'documents_insert');
  await expectErr('staffB cannot add rows to an org-A import batch', async () => {
    const id = (await q(`SELECT id FROM public.import_batches WHERE org_id = $1 LIMIT 1`, [A]))[0];
    const bid = id ? id.id : (await q(`INSERT INTO public.import_batches (org_id, file_name, file_fingerprint, created_by) VALUES ($1, 'a.xlsx', $2, $3) RETURNING id`, [A, FP4, U.staffA]))[0].id;
    return as('staffB', `INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ($1, 'S', 99, '{}')`, [bid]);
  }, /row-level security|MRS_NOT_FOUND/, 'import_rows_insert / app.can_edit_batch');
  await expectErr('staffB cannot grant itself a role in org A', () => as('staffB',
    `INSERT INTO public.memberships (user_id, org_id, role) VALUES ($1, $2, 'admin')`, [U.staffB, A]), /row-level security|permission denied/, 'memberships: no direct writes');
  await expectErr('adminA cannot add a membership in org B', () => as('adminA',
    `INSERT INTO public.memberships (user_id, org_id, role) VALUES ($1, $2, 'admin')`, [U.adminA, B]), /row-level security|permission denied/, 'memberships: no direct writes');
  await expectErr('adminA cannot attach an org-B branch to an org-A membership', () => as('adminA',
    `INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, $3, 'clearance_staff')`, [U.staffA, A, B_BR]), /foreign key|violates|permission denied/, 'memberships_branch_fk');
  await expectErr('admin_add_member refuses an org-B branch', () => as('adminA', `SELECT public.admin_add_member($1, 'staff.b@test.local', 'clearance_staff', $2)`, [A, B_BR]), /MRS_INVALID/);
  await check('adminA cannot bypass the last-admin guard with a direct UPDATE/DELETE', async () => {
    const u = await denied('adminA', `UPDATE public.memberships SET is_active = false WHERE user_id = $1 RETURNING 1`, [U.adminA]);
    const d = await denied('adminA', `DELETE FROM public.memberships WHERE org_id = $1 RETURNING 1`, [A]);
    const n = (await q(`SELECT count(*)::int n FROM public.memberships WHERE user_id = $1 AND is_active`, [U.adminA]))[0].n;
    return (u === true && d === true && n >= 1) || 'update: ' + u + ' delete: ' + d + ' active=' + n;
  });
  for (const [fn, sql, re] of [
    ['set_transaction_status', `SELECT public.set_transaction_status('${TX1}', 'appointment', NULL)`, /MRS_NOT_FOUND/],
    ['set_financial_status', `SELECT public.set_financial_status('${TX1}', 'estimate_only', NULL)`, /MRS_NOT_FOUND/],
    ['issue_tracking_token', `SELECT public.issue_tracking_token('${TX1}')`, /MRS_NOT_FOUND/],
    ['set_request_status', `SELECT public.set_request_status('${REQ_SEED}', 'rejected', 'x')`, /MRS_NOT_FOUND/],
    ['convert_request_to_transaction', `SELECT public.convert_request_to_transaction('${REQ_SEED}', '${JED}', NULL)`, /MRS_NOT_FOUND/]
  ]) await expectErr(`staffB ${fn} on org-A row → MRS_NOT_FOUND`, () => as('staffB', sql), re);
  await expectErr('staffA convert org-A request into org-B branch refused', () => as('staffA',
    `SELECT public.convert_request_to_transaction('${REQ_SEED}', '${B_BR}', NULL)`), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
  await expectErr('staffA convert org-A request with org-B client refused', () => as('staffA',
    `SELECT public.convert_request_to_transaction('${REQ_SEED}', '${JED}', '${B_CL}')`), /MRS_NOT_FOUND/);
  // 0650 admin RPCs (SECURITY DEFINER: they bypass RLS, so the role checks inside them are the only gate)
  const memB = (await q(`SELECT id FROM public.memberships WHERE org_id = $1 LIMIT 1`, [B]))[0].id;
  const memAdminA = (await q(`SELECT id FROM public.memberships WHERE user_id = $1 AND org_id = $2`, [U.adminA, A]))[0].id;
  for (const [name, who, sql, params, re] of [
    ['staffB admin_list_members(org A)', 'staffB', `SELECT public.admin_list_members($1)`, [A], /MRS_FORBIDDEN/],
    ['staffA (non-admin) admin_list_members(org A)', 'staffA', `SELECT public.admin_list_members($1)`, [A], /MRS_FORBIDDEN/],
    ['clientA admin_list_members(org A)', 'clientA', `SELECT public.admin_list_members($1)`, [A], /MRS_FORBIDDEN/],
    ['adminA admin_list_members(org B)', 'adminA', `SELECT public.admin_list_members($1)`, [B], /MRS_FORBIDDEN/],
    ['adminA admin_add_member into org B', 'adminA', `SELECT public.admin_add_member($1, 'staffa@example.com', 'admin', NULL)`, [B], /MRS_FORBIDDEN/],
    ['adminA admin_add_member with org-B branch', 'adminA', `SELECT public.admin_add_member($1, 'staffb@example.com', 'clearance_staff', $2)`, [A, B_BR], /MRS_INVALID.*branch/],
    ['adminA admin_add_member role=client', 'adminA', `SELECT public.admin_add_member($1, 'clienta2@example.com', 'client', NULL)`, [A], /MRS_INVALID.*role/],
    ['adminA admin_set_member_active on org-B membership', 'adminA', `SELECT public.admin_set_member_active($1, false)`, [memB], /MRS_NOT_FOUND/],
    ['adminA cannot deactivate itself', 'adminA', `SELECT public.admin_set_member_active($1, false)`, [memAdminA], /MRS_FORBIDDEN/],
    ['staffA admin_add_member (self-promotion)', 'staffA', `SELECT public.admin_add_member($1, 'staffa@example.com', 'admin', NULL)`, [A], /MRS_FORBIDDEN/]
  ]) await expectErr('admin RPC refused: ' + name, () => as(who, sql, params), re, 'public.admin_* (0650)');
  await check('adminA admin_list_members(org A) lists only org-A members', async () => {
    const r = (await as('adminA', `SELECT public.admin_list_members($1) r`, [A]))[0].r;
    return (r.length > 0 && !r.some(m => m.email === 'staffb@example.com' || m.email === 'clientb@example.com')) || JSON.stringify(r.map(m => m.email));
  });
  await advisory('admin_add_member does not reveal whether an email has an account', async () => {
    try { await as('adminA', `SELECT public.admin_add_member($1, 'no-such-user@example.com', 'clearance_staff', NULL)`, [A]); return 'added?'; }
    catch (e) { return !/MRS_NOT_FOUND.*email/.test(errText(e)) || 'MRS_NOT_FOUND email vs success = account-existence oracle'; }
  }, 'Any org admin can probe which e-mails are registered on the whole Supabase project (cross-tenant user enumeration) and attach ANY existing account (incl. another tenant\'s staff) as staff of his org. Acceptable for staging; for production use an invitation flow (0650 admin_add_member).');

  await check('my_context of staffB lists only org B', async () => {
    const r = (await as('staffB', `SELECT public.my_context() r`))[0].r;
    return r.memberships.length === 1 && r.memberships[0].org_id === B;
  });

  /* ---------------------------------------------------------------- client isolation */
  section('client isolation inside org A (clientA vs clientA2)');
  await check('clientA sees only own client record', async () => {
    const r = await as('clientA', `SELECT id FROM public.clients`);
    return (r.length === 1 && r[0].id === CL101) || 'saw ' + JSON.stringify(r.map(x => x.id));
  }, 'clients_select / app.is_client_user');
  await check('clientA sees only own transactions', async () => {
    const r = await as('clientA', `SELECT id FROM public.transactions`);
    return (r.length === 1 && r[0].id === TX1) || 'saw ' + JSON.stringify(r.map(x => x.id));
  }, 'transactions_select');
  await check('clientA cannot read clientA2 transaction by id', () => denied('clientA', `SELECT 1 FROM public.transactions WHERE id = $1`, [TX2]), 'transactions_select');
  await check('clientA sees only own client-visible documents', async () => {
    const r = await as('clientA', `SELECT id FROM public.documents`);
    return (r.length === 1 && r[0].id === DOC_A_CLI) || 'saw ' + JSON.stringify(r.map(x => x.id));
  }, 'documents_select');
  await check('clientA cannot read clientA2 document by id', () => denied('clientA', `SELECT 1 FROM public.documents WHERE id = $1`, [DOC_A2_CLI]), 'documents_select');
  await check('clientA2 sees only own transaction and document', async () => {
    const t = await as('clientA2', `SELECT id FROM public.transactions`);
    const d = await as('clientA2', `SELECT id FROM public.documents`);
    return (t.length === 1 && t[0].id === TX2 && d.length === 1 && d[0].id === DOC_A2_CLI) || 'tx ' + JSON.stringify(t) + ' docs ' + JSON.stringify(d);
  });
  await check('clientA containers only from own transaction', async () => {
    const r = await as('clientA', `SELECT DISTINCT transaction_id FROM public.containers`);
    return (r.length === 1 && r[0].transaction_id === TX1) || JSON.stringify(r);
  }, 'containers_select / app.can_read_transaction');
  await check('clientA events only own + visible_to_client', async () => {
    const r = await as('clientA', `SELECT transaction_id, visible_to_client FROM public.transaction_events`);
    return (r.length > 0 && r.every(x => x.transaction_id === TX1 && x.visible_to_client)) || JSON.stringify(r);
  }, 'events_select');
  await check('clientA sees no service_requests / contact / import / audit of others', async () => {
    const r = (await as('clientA', `SELECT (SELECT count(*) FROM public.service_requests)::int s, (SELECT count(*) FROM public.contact_messages)::int c,
      (SELECT count(*) FROM public.import_batches)::int b, (SELECT count(*) FROM public.import_rows)::int r, (SELECT count(*) FROM public.audit_log)::int a`))[0];
    return (r.s + r.c + r.b + r.r + r.a === 0) || JSON.stringify(r);
  });
  await check('clientA sees only own membership, client link and profile', async () => {
    const r = (await as('clientA', `SELECT (SELECT count(*) FROM public.memberships)::int m, (SELECT count(*) FROM public.client_users)::int cu,
      (SELECT count(*) FROM public.profiles)::int p`))[0];
    return (r.m === 1 && r.cu === 1 && r.p === 1) || JSON.stringify(r);
  }, 'memberships_select / client_users_select / profiles_select');
  await check('clientA cannot UPDATE own transaction', () => denied('clientA', `UPDATE public.transactions SET notes = 'x' WHERE id = $1 RETURNING 1`, [TX1]), 'transactions_update');
  await check('clientA cannot UPDATE own client record', () => denied('clientA', `UPDATE public.clients SET name_ar = 'تعديل' WHERE id = $1 RETURNING 1`, [CL101]), 'clients_update');
  await expectErr('clientA cannot link itself to clientA2 company', () => as('clientA',
    `INSERT INTO public.client_users (org_id, client_id, user_id) VALUES ($1, $2, $3)`, [A, CL102, U.clientA]), /row-level security/, 'client_users_insert');
  await expectErr('clientA cannot promote itself to admin', () => as('clientA',
    `INSERT INTO public.memberships (user_id, org_id, role) VALUES ($1, $2, 'admin')`, [U.clientA, A]), /row-level security|permission denied/, 'memberships: no direct writes');
  await check('clientA cannot change own membership role', () => denied('clientA', `UPDATE public.memberships SET role = 'admin' WHERE user_id = $1 RETURNING 1`, [U.clientA]), 'memberships_update');
  await check('signup metadata {"role":"admin"} granted nothing', async () =>
    (await q(`SELECT count(*)::int n FROM public.memberships WHERE user_id = $1 AND role <> 'client'`, [U.clientB]))[0].n === 0);
  await expectErr('clientA cannot insert a transaction', () => as('clientA',
    `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea')`, [A, JED, CL101]), /row-level security/);
  await expectErr('clientA cannot add a container', () => as('clientA',
    `INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, 'TSTU0000099')`, [A, TX1]), /row-level security/);
  await expectErr('clientA cannot add an event', () => as('clientA',
    `INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note) VALUES ($1, $2, 'note', 'x')`, [A, TX1]), /row-level security/);
  await expectErr('clientA cannot call staff RPC on own transaction', () => as('clientA', `SELECT public.set_transaction_status($1, 'appointment', NULL)`, [TX1]), /MRS_NOT_FOUND/);
  await expectErr('clientA cannot issue a tracking token', () => as('clientA', `SELECT public.issue_tracking_token($1)`, [TX1]), /MRS_NOT_FOUND/);
  await check('staff cannot see client\'s ... (sanity) staffA sees all org-A transactions', async () =>
    (await as('staffA', `SELECT count(*)::int n FROM public.transactions`))[0].n === 3);
  for (const [t, col, id] of [['transactions', 'notes', TX1], ['transactions', 'tracking_token_hash', TX1], ['clients', 'notes', CL101],
                              ['clients', 'classification', CL101], ['service_requests', 'tracking_token_hash', REQ_SEED]]) {
    await expectErr(`clientA cannot read internal column ${t}.${col}`, () => as('clientA', `SELECT ${col} FROM public.${t} WHERE id = $1`, [id]), /permission denied/, '0700 column grants');
  }
  await check('clientA still reads its own transaction (non-internal columns)', async () =>
    (await as('clientA', `SELECT ref, operational_status FROM public.transactions WHERE id = $1`, [TX1])).length === 1);
  await check('staff_internal_fields: staffA gets notes, clientA / staffB get nothing', async () => {
    const s1 = (await as('staffA', `SELECT public.staff_internal_fields('transactions', ARRAY[$1]::uuid[]) r`, [TX1]))[0].r;
    const s2 = (await as('staffA', `SELECT public.staff_internal_fields('clients', ARRAY[$1]::uuid[]) r`, [CL101]))[0].r;
    const c1 = (await as('clientA', `SELECT public.staff_internal_fields('transactions', ARRAY[$1]::uuid[]) r`, [TX1]))[0].r;
    const c2 = (await as('clientA', `SELECT public.staff_internal_fields('clients', ARRAY[$1]::uuid[]) r`, [CL101]))[0].r;
    const b1 = (await as('staffB', `SELECT public.staff_internal_fields('transactions', ARRAY[$1]::uuid[]) r`, [TX1]))[0].r;
    return (s1[TX1] && 'notes' in s1[TX1] && s2[CL101] && 'classification' in s2[CL101]
      && Object.keys(c1).length === 0 && Object.keys(c2).length === 0 && Object.keys(b1).length === 0) || JSON.stringify({ s1, s2, c1, c2, b1 });
  });
  await expectErr('staff_internal_fields rejects other tables', () => as('staffA', `SELECT public.staff_internal_fields('memberships', ARRAY[$1]::uuid[])`, [TX1]), /MRS_INVALID/);
  await check('staffA can still UPDATE transactions.notes', async () =>
    (await as('staffA', `UPDATE public.transactions SET notes = 'ملاحظة داخلية' WHERE id = $1 RETURNING id`, [TX1])).length === 1);

  /* ---------------------------------------------------------------- public_track */
  section('public_track: token required, no personal data');
  const ALLOWED_KEYS = new Set(['ref', 'environment', 'kind', 'request', 'status', 'status_label_ar', 'status_label_en', 'direction', 'mode',
    'created_at', 'reviewed_at', 'transaction', 'operation', 'operational_status', 'stage_index', 'stage_total', 'status_changed_at',
    'containers', 'total', 'returned', 'timeline', 'label_ar', 'label_en', 'at']);
  const keysOf = (o, acc = []) => { if (Array.isArray(o)) o.forEach(x => keysOf(x, acc)); else if (o && typeof o === 'object') for (const k of Object.keys(o)) { acc.push(k); keysOf(o[k], acc); } return acc; };
  const personal = [basePayload.fullName, basePayload.company, basePayload.email, basePayload.goods, basePayload.blNumber, 'TSTU0000021', basePayload.crNumber, basePayload.notes, 'invoice.pdf'];
  let trk;
  const trkPayload = P({});
  await check('anon submit returns ref + one-time token', async () => {
    trk = (await as('anon', `SELECT public.submit_service_request($1) r`, [trkPayload]))[0].r;
    return /^REQ-\d{4}-\d{6}$/.test(trk.ref) && /^[0-9a-f]{64}$/.test(trk.tracking_token);
  });
  await check('public_track with correct token: only whitelisted, non-personal fields', async () => {
    const t = (await as('anon', `SELECT public.public_track($1, $2) r`, [trk.ref, trk.tracking_token]))[0].r;
    const s = JSON.stringify(t);
    const extra = keysOf(t).filter(k => !ALLOWED_KEYS.has(k));
    const leaked = personal.concat([trkPayload.phone]).filter(v => s.includes(v));
    return (t.kind === 'request' && extra.length === 0 && leaked.length === 0) || 'extra keys ' + extra + ' leaked ' + leaked;
  }, 'public.public_track');
  await check('public_track accepts upper-case token / padded ref', async () =>
    !!(await as('anon', `SELECT public.public_track($1, $2) r`, [' ' + trk.ref.toLowerCase() + ' ', trk.tracking_token.toUpperCase()]))[0].r.request);
  await expectErr('public_track wrong token → MRS_NOT_FOUND', () => as('anon', `SELECT public.public_track($1, $2)`, [trk.ref, 'f'.repeat(64)]), /MRS_NOT_FOUND/);
  await expectErr('public_track missing token → MRS_NOT_FOUND', () => as('anon', `SELECT public.public_track($1, NULL)`, [trk.ref]), /MRS_NOT_FOUND/);
  await expectErr('public_track empty token → MRS_NOT_FOUND', () => as('anon', `SELECT public.public_track($1, '')`, [trk.ref]), /MRS_NOT_FOUND/);
  await expectErr('public_track token hash instead of token → MRS_NOT_FOUND', async () => {
    const h = (await q(`SELECT tracking_token_hash h FROM public.service_requests WHERE ref = $1 AND org_id = $2`, [trk.ref, A]))[0].h;
    return as('anon', `SELECT public.public_track($1, $2)`, [trk.ref, h]);
  }, /MRS_NOT_FOUND/);
  await expectErr('public_track unknown ref → same MRS_NOT_FOUND (no oracle)', () => as('anon', `SELECT public.public_track('REQ-2099-999999', $1)`, [trk.tracking_token]), /MRS_NOT_FOUND/);
  await expectErr('public_track SQL-ish / oversized input → MRS_NOT_FOUND', () => as('anon', `SELECT public.public_track($1, $2)`, ["REQ-2026-000001' OR 1=1 --", 'x'.repeat(10000)]), /MRS_NOT_FOUND/);
  await check('same ref number in two orgs: token selects the right one', async () => {
    const b = (await as('anon', `SELECT public.submit_service_request($1) r`, [P({ orgSlug: 'org-b' })]))[0].r;
    const sameRefInA = (await q(`SELECT count(*)::int n FROM public.service_requests WHERE ref = $1 AND org_id = $2`, [b.ref, A]))[0].n;
    let crossOk = true;
    if (sameRefInA) { try { await as('anon', `SELECT public.public_track($1, $2)`, [b.ref, SEED_TOKEN]); crossOk = b.ref === (await q(`SELECT ref FROM public.service_requests WHERE id = $1`, [REQ_SEED]))[0].ref; } catch (e) { crossOk = true; } }
    const t = (await as('anon', `SELECT public.public_track($1, $2) r`, [b.ref, b.tracking_token]))[0].r;
    return t.request && t.request.ref === b.ref && crossOk;
  });
  let conv;
  await check('converted request: tracking shows transaction stage, still no personal data', async () => {
    conv = (await as('staffA', `SELECT public.convert_request_to_transaction($1, $2, NULL) r`, [REQ_SEED, JED]))[0].r;
    const t = (await as('anon', `SELECT public.public_track($1, $2) r`, [conv.request_ref, SEED_TOKEN]))[0].r;
    const s = JSON.stringify(t);
    const extra = keysOf(t).filter(k => !ALLOWED_KEYS.has(k));
    const leaked = ['مقدم طلب تجريبي', 'شركة طلب تجريبية', '0500000009', 'request@example.com', 'TSTU0000009', 'TESTBL0000009', 'بضاعة تجريبية للاختبار']
      .filter(v => s.includes(v));
    return (t.transaction && t.transaction.ref === conv.ref && extra.length === 0 && leaked.length === 0) || 'extra ' + extra + ' leaked ' + leaked;
  });
  await expectErr('transaction ref without issued token → MRS_NOT_FOUND', () => as('anon', `SELECT public.public_track($1, $2)`, [conv.ref, SEED_TOKEN]), /MRS_NOT_FOUND/);
  await check('issued transaction token works; re-issue invalidates the old one', async () => {
    const t1 = (await as('staffA', `SELECT public.issue_tracking_token($1) r`, [TX1]))[0].r;
    const ref = t1.ref;
    const ok1 = !!(await as('anon', `SELECT public.public_track($1, $2) r`, [ref, t1.tracking_token]))[0].r.transaction;
    const t2 = (await as('staffA', `SELECT public.issue_tracking_token($1) r`, [TX1]))[0].r;
    let oldRejected = false;
    try { await as('anon', `SELECT public.public_track($1, $2)`, [ref, t1.tracking_token]); } catch (e) { oldRejected = /MRS_NOT_FOUND/.test(errText(e)); }
    const ok2 = !!(await as('anon', `SELECT public.public_track($1, $2) r`, [ref, t2.tracking_token]))[0].r.transaction;
    const stored = (await q(`SELECT tracking_token_hash h FROM public.transactions WHERE id = $1`, [TX1]))[0].h;
    return ok1 && oldRejected && ok2 && stored !== t2.tracking_token;
  });
  await check('public_track timeline excludes internal notes', async () => {
    await as('staffA', `INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note) VALUES ($1, $2, 'note', 'سر داخلي')`, [A, conv.transaction_id]);
    const s = JSON.stringify((await as('anon', `SELECT public.public_track($1, $2) r`, [conv.request_ref, SEED_TOKEN]))[0].r);
    return !s.includes('سر داخلي');
  });

  /* ---------------------------------------------------------------- submit validation */
  section('submit_service_request: validation & rate guard');
  const V = [
    ['non-object payload', `SELECT public.submit_service_request('"x"'::jsonb)`, null, /MRS_INVALID.*payload/],
    ['null payload', `SELECT public.submit_service_request(NULL)`, null, /MRS_INVALID.*payload/],
    ['missing fullName', null, P({ fullName: '' }), /MRS_REQUIRED.*fullName/],
    ['short fullName', null, P({ fullName: 'ab' }), /MRS_INVALID.*fullName/],
    ['object fullName', null, P({ fullName: { x: 1 } }), /MRS_INVALID.*fullName/],
    ['invalid phone', null, P({ phone: '12345' }), /MRS_INVALID.*phone/],
    ['missing phone', null, P({ phone: '' }), /MRS_REQUIRED.*phone/],
    ['invalid email', null, P({ email: 'not-an-email' }), /MRS_INVALID.*email/],
    ['missing email (web)', null, P({ email: '' }), /MRS_REQUIRED.*email/],
    ['bad direction', null, P({ direction: 'smuggle' }), /MRS_INVALID.*direction/],
    ['bad mode', null, P({ mode: 'rail' }), /MRS_INVALID.*mode/],
    ['bad service', null, P({ service: 'x' }), /MRS_INVALID.*service/],
    ['goods too long', null, P({ goods: 'x'.repeat(1001) }), /MRS_TOO_LONG.*goods/],
    ['goods too short', null, P({ goods: 'ab' }), /MRS_INVALID.*goods/],
    ['bad VAT', null, P({ taxId: '123' }), /MRS_INVALID.*taxId/],
    ['bad CR', null, P({ crNumber: '12' }), /MRS_INVALID.*crNumber/],
    ['bad HS code', null, P({ hsCode: 'ab12' }), /MRS_INVALID.*hsCode/],
    ['bad eta', null, P({ eta: '2026-13-45' }), /MRS_INVALID.*eta/],
    ['bad currency', null, P({ currency: 'BTC' }), /MRS_INVALID.*currency/],
    ['negative count', null, P({ count: '-5' }), /MRS_INVALID.*count/],
    ['huge count', null, P({ count: 999999 }), /MRS_INVALID.*count/],
    ['bad container number', null, P({ containerNumbers: 'ABC123' }), /MRS_INVALID.*containerNumbers/],
    ['>200 containers', null, P({ containerNumbers: Array.from({ length: 201 }, (_, i) => 'TSTU' + String(1000000 + i)) }), /MRS_TOO_LONG.*containerNumbers/],
    ['>30 declared documents', null, P({ documents: Array.from({ length: 31 }, () => ({ name: 'a.pdf' })) }), /MRS_TOO_LONG.*documents/],
    ['payload > 30000 chars', null, P({ junk: 'x'.repeat(30001) }), /MRS_TOO_LONG.*payload/],
    ['terms not accepted', null, P({ terms: false }), /MRS_REQUIRED.*terms/],
    ['unknown orgSlug', null, P({ orgSlug: 'nope-org' }), /MRS_INTAKE_CLOSED/],
    ['org with intake disabled', null, P({ orgSlug: 'org-closed' }), /MRS_INTAKE_CLOSED/]
  ];
  for (const [name, sql, payload, re] of V) {
    await expectErr('reject: ' + name, () => sql ? as('anon', sql) : as('anon', `SELECT public.submit_service_request($1)`, [payload]), re, 'app.insert_service_request');
  }
  await check('privileged payload keys are ignored (status/source/ref/client/submitter/org)', async () => {
    const r = (await as('anon', `SELECT public.submit_service_request($1) r`, [P({ status: 'converted', source: 'staff', ref: 'REQ-1999-999999',
      clientId: CL101, submittedBy: U.adminA, orgId: B, branchId: JED, tracking_token_hash: hex('0') })]))[0].r;
    const row = (await q(`SELECT org_id, status, source, client_id, submitted_by, ref, tracking_token_hash h FROM public.service_requests WHERE ref = $1 AND org_id = $2`, [r.ref, A]))[0];
    return (row && row.status === 'new' && row.source === 'web' && row.client_id === null && row.submitted_by === null && row.ref !== 'REQ-1999-999999' && row.h !== hex('0')) || JSON.stringify(row);
  });
  await check('control characters stripped, phone normalized', async () => {
    const ph = freshPhone();
    const r = (await as('anon', `SELECT public.submit_service_request($1) r`, [P({ fullName: 'زائر\u0007 \u0001تجريبي', phone: '+966 ' + ph.slice(1) })]))[0].r;
    const row = (await q(`SELECT full_name, phone FROM public.service_requests WHERE ref = $1 AND org_id = $2`, [r.ref, A]))[0];
    return (!/[\u0001\u0007]/.test(row.full_name) && row.phone === ph) || JSON.stringify(row);
  });
  await check('signed-in user cannot attach request to someone else\'s client', async () => {
    const r = (await as('clientA', `SELECT public.submit_service_request($1) r`, [P({ clientId: CL102 })]))[0].r;
    const row = (await q(`SELECT client_id, source, submitted_by FROM public.service_requests WHERE ref = $1 AND org_id = $2`, [r.ref, A]))[0];
    return (row.client_id === null && row.source === 'portal' && row.submitted_by === U.clientA) || JSON.stringify(row);
  });
  await check('rate guard: 5 per phone per hour, any phone format', async () => {
    const forms = ['0550000077', '+966550000077', '٠٥٥٠٠٠٠٠٧٧', '966 55 000 0077', '00966550000077'];
    for (const f of forms) await as('anon', `SELECT public.submit_service_request($1)`, [P({ phone: f })]);
    try { await as('anon', `SELECT public.submit_service_request($1)`, [P({ phone: '055 000 0077' })]); return '6th accepted'; }
    catch (e) { return /MRS_RATE_LIMITED.*phone/.test(errText(e)) || errText(e); }
  });
  await check('rate guard: per-phone limit is per org (other org unaffected)', async () =>
    !!(await as('anon', `SELECT public.submit_service_request($1) r`, [P({ phone: '0550000077', orgSlug: 'org-b' })]))[0].r.ref);
  await check('rate guard: org-wide 120 per 10 minutes', async () => {
    for (let i = 0; i < 120; i++) await as('anon', `SELECT public.submit_service_request($1)`, [P({ orgSlug: 'org-flood' })]);
    try { await as('anon', `SELECT public.submit_service_request($1)`, [P({ orgSlug: 'org-flood' })]); return '121st accepted'; }
    catch (e) { return /MRS_RATE_LIMITED.*org/.test(errText(e)) || errText(e); }
  });
  warn('rate guard design', 'Limits are per phone (attacker rotates numbers) and a global 120/10 min per org: one script can fill the org bucket and block genuine visitors for 10 minutes (intake DoS). Needs edge rate-limit by IP / CAPTCHA (open owner decision) — app.insert_service_request.');
  section('submit_contact_message: validation');
  const CM = { name: 'زائر تجريبي', phone: '0126000000', email: 'v@example.com', subject: 'quote', message: 'رسالة اختبار طويلة بما يكفي', consent: true };
  for (const [name, over, re] of [
    ['missing consent', { consent: false }, /MRS_REQUIRED.*consent/],
    ['short message', { message: 'قصير' }, /MRS_INVALID.*message/],
    ['bad subject', { subject: 'hack' }, /MRS_INVALID.*subject/],
    ['missing email', { email: '' }, /MRS_REQUIRED.*email/],
    ['bad phone', { phone: '999' }, /MRS_INVALID.*phone/],
    ['message too long', { message: 'x'.repeat(1001) }, /MRS_TOO_LONG.*message/]
  ]) await expectErr('contact reject: ' + name, () => as('anon', `SELECT public.submit_contact_message($1)`, [{ ...CM, ...over }]), re);
  await check('contact message accepted and not readable by anon', async () => {
    const r = (await as('anon', `SELECT public.submit_contact_message($1) r`, [CM]))[0].r;
    let hidden = false;
    try { await as('anon', `SELECT 1 FROM public.contact_messages`); } catch (e) { hidden = /permission denied/.test(errText(e)); }
    return /^MSG-\d{4}-\d{6}$/.test(r.ref) && hidden && Object.keys(r).sort().join() === 'created_at,ref';
  });
  await check('contact message content immutable for staff', async () => {
    try { await as('staffA', `UPDATE public.contact_messages SET message = 'تم التعديل على الرسالة الأصلية' WHERE org_id = $1`, [A]); return 'updated'; }
    catch (e) { return /MRS_IMMUTABLE/.test(errText(e)) || errText(e); }
  });

  /* ---------------------------------------------------------------- append-only */
  section('append-only: transaction_events & audit_log');
  await expectErr('adminA cannot UPDATE transaction_events', () => as('adminA', `UPDATE public.transaction_events SET note = 'x'`), /permission denied|MRS_APPEND_ONLY/);
  await expectErr('adminA cannot DELETE transaction_events', () => as('adminA', `DELETE FROM public.transaction_events`), /permission denied|MRS_APPEND_ONLY/);
  await expectErr('adminA cannot UPDATE audit_log', () => as('adminA', `UPDATE public.audit_log SET actor = NULL`), /permission denied|MRS_APPEND_ONLY/);
  await expectErr('adminA cannot DELETE audit_log', () => as('adminA', `DELETE FROM public.audit_log`), /permission denied|MRS_APPEND_ONLY/);
  await expectErr('adminA cannot forge audit_log rows', () => as('adminA',
    `INSERT INTO public.audit_log (org_id, table_name, action) VALUES ($1, 'transactions', 'DELETE')`, [A]), /permission denied|row-level security/);
  await expectErr('adminA cannot TRUNCATE events', () => as('adminA', `TRUNCATE public.transaction_events`), /permission denied|MRS_APPEND_ONLY/);
  await expectErr('owner (service level) cannot UPDATE events', () => q(`UPDATE public.transaction_events SET note = 'x'`), /MRS_APPEND_ONLY/);
  await expectErr('owner cannot DELETE events', () => q(`DELETE FROM public.transaction_events WHERE transaction_id = $1`, [TX1]), /MRS_APPEND_ONLY/);
  await expectErr('owner cannot TRUNCATE events', () => q(`TRUNCATE public.transaction_events CASCADE`), /MRS_APPEND_ONLY/);
  await expectErr('owner cannot UPDATE audit_log', () => q(`UPDATE public.audit_log SET actor = NULL`), /MRS_APPEND_ONLY/);
  await expectErr('owner cannot DELETE audit_log', () => q(`DELETE FROM public.audit_log`), /MRS_APPEND_ONLY/);
  await expectErr('owner cannot TRUNCATE audit_log', () => q(`TRUNCATE public.audit_log`), /MRS_APPEND_ONLY/);
  await expectErr('staff cannot forge a status event', () => as('staffA',
    `INSERT INTO public.transaction_events (org_id, transaction_id, event_type, to_status) VALUES ($1, $2, 'operational_status', 'closed')`, [A, TX1]), /row-level security|MRS_FORBIDDEN/, 'events_insert_note + app.tg_events_before');
  await check('staff note: actor and time stamped by server', async () => {
    const r = (await as('staffA', `INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, actor, created_at)
      VALUES ($1, $2, 'note', 'ملاحظة', $3, '2000-01-01') RETURNING actor, created_at`, [A, TX1, U.adminA]))[0];
    return (r.actor === U.staffA && new Date(r.created_at).getFullYear() > 2000) || JSON.stringify(r);
  });
  await expectErr('document original immutable (sha256)', () => as('staffA', `UPDATE public.documents SET sha256 = $2 WHERE id = $1`, [DOC_A_INT, hex('9')]), /MRS_IMMUTABLE.*sha256/);
  await expectErr('document storage_path immutable', () => as('staffA', `UPDATE public.documents SET storage_path = $2 WHERE id = $1`, [DOC_A_INT, path4(A, TX1, DOC_A_INT, 'other.pdf')]), /MRS_IMMUTABLE.*storage_path/);
  await check('documents cannot be deleted by admin', () => denied('adminA', `DELETE FROM public.documents WHERE id = $1 RETURNING 1`, [DOC_A_INT]), 'no DELETE policy on documents');

  /* ---------------------------------------------------------------- status via RPC */
  section('status changes only via RPC, each recorded as an event');
  for (const [col, val] of [['operational_status', "'closed'"], ['financial_status', "'settled'"], ['ref', "'MRS-2000-000001'"],
    ['tracking_token_hash', `'${hex('a')}'`], ['status_changed_at', "'2000-01-01'"], ['org_id', `'${B}'`], ['request_id', 'NULL']]) {
    const target = col === 'request_id' ? conv.transaction_id : TX1;   // converted tx has a request_id to unlink
    await expectErr(`direct UPDATE transactions.${col} blocked`, () => as('adminA', `UPDATE public.transactions SET ${col} = ${val} WHERE id = '${target}'`), new RegExp('MRS_IMMUTABLE.*' + col + '|foreign key'), 'app.tg_transactions_before');
  }
  await expectErr('direct UPDATE service_requests.status blocked', () => as('adminA', `UPDATE public.service_requests SET status = 'converted' WHERE org_id = '${A}' AND status = 'new'`), /MRS_IMMUTABLE.*status/);
  await expectErr('direct UPDATE service_requests.ref blocked', () => as('adminA', `UPDATE public.service_requests SET ref = 'REQ-0000-000000' WHERE org_id = '${A}'`), /MRS_IMMUTABLE.*ref/);
  await check('API INSERT cannot preset status/ref/token on a transaction', async () => {
    const r = (await as('staffA', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, ref, operational_status, financial_status, tracking_token_hash)
      VALUES ($1, $2, $3, 'import', 'sea', 'HACK-1', 'closed', 'settled', $4) RETURNING id, ref, operational_status, financial_status`, [A, JED, CL101, hex('a')]))[0];
    r.tracking_token_hash = (await q(`SELECT tracking_token_hash FROM public.transactions WHERE id = $1`, [r.id]))[0].tracking_token_hash;
    delete r.id;
    return (/^MRS-\d{4}-\d{6}$/.test(r.ref) && r.operational_status === 'new' && r.financial_status === 'not_started' && r.tracking_token_hash === null) || JSON.stringify(r);
  });
  await check('set_transaction_status writes one event (from/to/actor) + audit row', async () => {
    const before = (await q(`SELECT count(*)::int n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'operational_status'`, [TX1]))[0].n;
    const auditBefore = (await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'transactions' AND row_id = $1`, [TX1]))[0].n;
    const r = (await as('staffA', `SELECT public.set_transaction_status($1, 'appointment', NULL) r`, [TX1]))[0].r;
    const ev = await q(`SELECT from_status, to_status, actor FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'operational_status' ORDER BY id DESC LIMIT 1`, [TX1]);
    const after = (await q(`SELECT count(*)::int n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'operational_status'`, [TX1]))[0].n;
    const au = await q(`SELECT actor, changed_fields FROM public.audit_log WHERE table_name = 'transactions' AND row_id = $1 ORDER BY id DESC LIMIT 1`, [TX1]);
    return (r.to === 'appointment' && after === before + 1 && ev[0].from_status === 'customs_declaration' && ev[0].to_status === 'appointment'
      && ev[0].actor === U.staffA && au.length && (auditBefore < (await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'transactions' AND row_id = $1`, [TX1]))[0].n)
      && au[0].actor === U.staffA && au[0].changed_fields.includes('operational_status')) || JSON.stringify({ r, ev, au });
  });
  await expectErr('backward move by clearance staff refused', () => as('staffA', `SELECT public.set_transaction_status($1, 'new', 'تصحيح')`, [TX1]), /MRS_FORBIDDEN/);
  await expectErr('backward move without note refused', () => as('adminA', `SELECT public.set_transaction_status($1, 'new', NULL)`, [TX1]), /MRS_NOTE_REQUIRED/);
  await check('backward correction by admin keeps history (adds events)', async () => {
    const before = (await q(`SELECT count(*)::int n FROM public.transaction_events WHERE transaction_id = $1`, [TX1]))[0].n;
    await as('adminA', `SELECT public.set_transaction_status($1, 'customs_declaration', 'تصحيح اختبار')`, [TX1]);
    const after = (await q(`SELECT count(*)::int n FROM public.transaction_events WHERE transaction_id = $1`, [TX1]))[0].n;
    return after === before + 2;
  });
  await expectErr('clearance staff cannot set billing stage', () => as('staffA', `SELECT public.set_transaction_status($1, 'under_billing', NULL)`, [TX3]), /MRS_FORBIDDEN|MRS_CONTAINERS/);
  await expectErr('clearance staff cannot set financial status', () => as('staffA', `SELECT public.set_financial_status($1, 'estimate_only', NULL)`, [TX1]), /MRS_FORBIDDEN/);
  await expectErr('operationally_complete blocked while containers not returned', () => as('staffA', `SELECT public.set_transaction_status($1, 'operationally_complete', NULL)`, [TX1]), /MRS_CONTAINERS_NOT_RETURNED/);
  await expectErr('request status: clientA cannot change', () => as('clientA', `SELECT public.set_request_status($1, 'rejected', 'x')`, [REQ_SEED]), /MRS_NOT_FOUND/);
  await expectErr('stage order enforced (clearance staff cannot jump new → operationally_complete)', () => as('staffA',
    `SELECT public.set_transaction_status($1, 'operationally_complete', NULL)`, [TX3]), /MRS_BAD_TRANSITION/, 'set_transaction_status stage_skip');
  await expectErr('stage skip by admin needs a reason', () => as('adminA',
    `SELECT public.set_transaction_status($1, 'transport', NULL)`, [TX3]), /MRS_NOTE_REQUIRED/);
  await check('declared but unregistered containers block operational completion', async () => {
    await q(`UPDATE public.transactions SET container_count = 2 WHERE id = $1`, [TX3]);
    try { await as('adminA', `SELECT public.set_transaction_status($1, 'operationally_complete', 'تخطي اختبار')`, [TX3]); return 'completed with 2 declared / 0 registered containers'; }
    catch (e) { return /MRS_CONTAINERS_NOT_RETURNED/.test(errText(e)) || errText(e); }
    finally { await q(`UPDATE public.transactions SET container_count = 0 WHERE id = $1`, [TX3]); }
  });
  await check('one-step forward move still works and empty_return may be passed over without containers', async () => {
    const st = (await q(`SELECT operational_status s FROM public.transactions WHERE id = $1`, [TX3]))[0].s;
    if (st !== 'new') return 'TX3 not new: ' + st;
    await as('staffA', `SELECT public.set_transaction_status($1, 'in_progress', NULL)`, [TX3]);
    await as('staffA', `SELECT public.set_transaction_status($1, 'customs_declaration', NULL)`, [TX3]);
    await as('adminA', `SELECT public.set_transaction_status($1, 'appointment', NULL)`, [TX3]);
    await as('adminA', `SELECT public.set_transaction_status($1, 'transport', NULL)`, [TX3]);
    const r = (await as('adminA', `SELECT public.set_transaction_status($1, 'operationally_complete', NULL) r`, [TX3]))[0].r;
    return r.to === 'operationally_complete' || JSON.stringify(r);
  });
  await expectErr('container waiver needs a senior role', () => as('staffA',
    `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'استثناء' WHERE id = $1 RETURNING 1`, [CT303]), /MRS_FORBIDDEN/, 'app.tg_containers_before');
  await expectErr('container waiver needs a reason', () => as('adminA',
    `UPDATE public.containers SET return_status = 'waived', waiver_reason = '  ' WHERE id = $1 RETURNING 1`, [CT303]), /MRS_NOTE_REQUIRED/);
  await check('client upload is forced to client visibility / plain upload source', async () => {
    const id = 'a0c00000-0000-4000-8000-0000000000aa';
    await as('clientA', `INSERT INTO public.documents (id, org_id, transaction_id, kind, visibility, source, source_ref, storage_path, sha256, original_name, size_bytes)
      VALUES ($1, $2, $3, 'other', 'internal', 'email', 'spoofed', $4, $5, 'i.pdf', 10)`, [id, A, TX1, path4(A, TX1, id, 'i.pdf'), hex('9')]);
    const d = (await q(`SELECT visibility, source, source_ref FROM public.documents WHERE id = $1`, [id]))[0];
    return (d.visibility === 'client' && d.source === 'upload' && d.source_ref === null) || JSON.stringify(d);
  });

  /* ---------------------------------------------------------------- evidence */
  section('empty-return evidence (per container)');
  await expectErr('client upload cannot pre-classify as confirmed receipt', async () => {
    await as('clientA', `INSERT INTO public.documents (id, org_id, transaction_id, kind, classification, classification_status, storage_path, sha256, original_name, size_bytes)
      VALUES ($1, $2, $3, 'empty_return_receipt', 'empty_return_receipt', 'confirmed', $4, $5, 'r.pdf', 10)`, [DOC_CA_OWN, A, TX1, path4(A, TX1, DOC_CA_OWN, 'r.pdf'), hex('5')]);
    const d = (await q(`SELECT classification, classification_status, uploaded_by FROM public.documents WHERE id = $1`, [DOC_CA_OWN]))[0];
    if (d.classification !== null || d.classification_status !== 'unreviewed' || d.uploaded_by !== U.clientA) return;
    return as('staffA', `UPDATE public.containers SET return_status = 'returned_verified', evidence_document_id = $1 WHERE transaction_id = $2 AND container_no = 'TSTU0000001'`, [DOC_CA_OWN, TX1]);
  }, /MRS_EVIDENCE_INVALID/, 'app.tg_documents_before / app.tg_containers_before');
  await expectErr('evidence document from another transaction rejected', async () => {
    await as('staffA', `UPDATE public.documents SET classification = 'empty_return_receipt', classification_status = 'confirmed' WHERE id = $1`, [DOC_A2_CLI]);
    return as('staffA', `UPDATE public.containers SET return_status = 'returned_verified', evidence_document_id = $1 WHERE transaction_id = $2 AND container_no = 'TSTU0000001'`, [DOC_A2_CLI, TX1]);
  }, /MRS_EVIDENCE_INVALID/);
  await expectErr('EIR (delivery) cannot prove empty return', async () => {
    await as('staffA', `UPDATE public.documents SET classification = 'container_delivery_eir', classification_status = 'confirmed' WHERE id = $1`, [DOC_A_INT]);
    return as('staffA', `UPDATE public.containers SET return_status = 'returned_verified', evidence_document_id = $1 WHERE transaction_id = $2 AND container_no = 'TSTU0000001'`, [DOC_A_INT, TX1]);
  }, /MRS_EVIDENCE_INVALID/);

  /* ---------------------------------------------------------------- import */
  section('bulk import: unique source ids');
  let bA1;
  await check('staffA creates batch + rows; source_row_id derived from file fingerprint', async () => {
    bA1 = (await as('staffA', `INSERT INTO public.import_batches (org_id, file_name, file_fingerprint) VALUES ($1, 'a.xlsx', $2) RETURNING id, created_by`, [A, FP2]))[0];
    await as('staffA', `INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw, normalized, row_status) VALUES ($1, 'Sheet1', 2, '{"r":2}', $2, 'valid'), ($1, 'Sheet1', 3, '{"r":3}', $3, 'valid')`,
      [bA1.id, P({ blNumber: 'IMPBL0002' }), P({ blNumber: 'IMPBL0003' })]);
    const r = await q(`SELECT source_row_id, org_id FROM public.import_rows WHERE batch_id = $1 ORDER BY row_no`, [bA1.id]);
    return (bA1.created_by === U.staffA && r[0].source_row_id === FP2 + ':Sheet1:2' && r[0].org_id === A) || JSON.stringify(r);
  });
  await expectErr('same row twice in one batch rejected', () => as('staffA', `INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ($1, 'Sheet1', 2, '{}')`, [bA1.id]), /import_rows_source_uniq|duplicate key/);
  await expectErr('same file re-imported in a new batch: rows rejected', async () => {
    const b2 = (await as('staffA', `INSERT INTO public.import_batches (org_id, file_name, file_fingerprint) VALUES ($1, 'a-copy.xlsx', $2) RETURNING id`, [A, FP2]))[0];
    return as('staffA', `INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ($1, 'Sheet1', 2, '{"r":2}')`, [b2.id]);
  }, /import_rows_source_uniq|duplicate key/, 'import_rows_source_uniq');
  await check('spoofed source_fingerprint on a row is overwritten by the batch fingerprint', async () => {
    const b3 = (await as('staffA', `INSERT INTO public.import_batches (org_id, file_name, file_fingerprint) VALUES ($1, 'c.xlsx', $2) RETURNING id`, [A, FP3]))[0];
    const r = (await as('staffA', `INSERT INTO public.import_rows (batch_id, source_fingerprint, sheet_name, row_no, raw) VALUES ($1, $2, 'Sheet1', 2, '{}') RETURNING source_fingerprint`, [b3.id, FP2]))[0];
    return r.source_fingerprint === FP3;
  });
  await check('same file in another org is independent (tenant-scoped uniqueness)', async () =>
    (await q(`SELECT count(*)::int n FROM public.import_rows WHERE org_id = $1 AND source_fingerprint = $2 AND row_no = 2`, [B, FP1]))[0].n === 1);
  await expectErr('raw row is immutable', () => as('staffA', `UPDATE public.import_rows SET raw = '{}' WHERE batch_id = $1 AND row_no = 2`, [bA1.id]), /MRS_IMMUTABLE.*raw/);
  await expectErr('row cannot be marked committed directly', () => as('staffA', `UPDATE public.import_rows SET row_status = 'committed' WHERE batch_id = $1`, [bA1.id]), /MRS_BAD_TRANSITION/);
  await expectErr('batch cannot be marked committed directly', () => as('staffA', `UPDATE public.import_batches SET status = 'committed' WHERE id = $1`, [bA1.id]), /MRS_BAD_TRANSITION/);
  await check('import_commit creates exactly one request per source row; re-commit refused', async () => {
    const r = (await as('staffA', `SELECT public.import_commit($1) r`, [bA1.id]))[0].r;
    const n = (await q(`SELECT count(*)::int n FROM public.service_requests WHERE import_row_id IN (SELECT id FROM public.import_rows WHERE batch_id = $1)`, [bA1.id]))[0].n;
    let again = false;
    try { await as('staffA', `SELECT public.import_commit($1)`, [bA1.id]); } catch (e) { again = /MRS_BATCH_NOT_DRAFT/.test(errText(e)); }
    return (r.committed === 2 && n === 2 && r.batch_status === 'committed' && again) || JSON.stringify(r) + ' n=' + n + ' again=' + again;
  });
  await expectErr('staffB cannot commit an org-A batch', () => as('staffB', `SELECT public.import_commit($1)`, [bA1.id]), /MRS_NOT_FOUND/);
  await expectErr('clientA cannot create a batch for clientA2', () => as('clientA',
    `INSERT INTO public.import_batches (org_id, client_id, file_name, file_fingerprint) VALUES ($1, $2, 'x.xlsx', $3)`, [A, CL102, FP4]), /row-level security/, 'import_batches_insert');
  await check('cancelled batch frees its source ids for a later re-import (rows kept)', async () => {
    const b4 = (await as('staffA', `INSERT INTO public.import_batches (org_id, file_name, file_fingerprint) VALUES ($1, 'd.xlsx', $2) RETURNING id`, [A, FP4]))[0];
    await as('staffA', `INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ($1, 'S', 2, '{}')`, [b4.id]);
    await as('staffA', `UPDATE public.import_batches SET status = 'cancelled' WHERE id = $1`, [b4.id]);
    const b5 = (await as('staffA', `INSERT INTO public.import_batches (org_id, file_name, file_fingerprint) VALUES ($1, 'd.xlsx', $2) RETURNING id`, [A, FP4]))[0];
    try { await as('staffA', `INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ($1, 'S', 2, '{}')`, [b5.id]); }
    catch (e) { return 'still blocked: ' + errText(e).slice(0, 80); }
    const kept = (await q(`SELECT count(*)::int n FROM public.import_rows WHERE batch_id = $1 AND NOT is_live`, [b4.id]))[0].n;
    let dup = false;
    try { await as('staffA', `INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ($1, 'S', 2, '{}')`, [b5.id]); } catch (e) { dup = /import_rows_source_uniq|duplicate key/.test(errText(e)); }
    return (kept === 1 && dup) || 'kept=' + kept + ' dupBlocked=' + dup;
  });
  await check('API cannot flip import_rows.is_live', async () => {
    const b6 = (await as('staffA', `INSERT INTO public.import_batches (org_id, file_name, file_fingerprint) VALUES ($1, 'e.xlsx', $2) RETURNING id`, [A, 'e6'.repeat(32)]))[0];
    await as('staffA', `INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ($1, 'S', 2, '{}')`, [b6.id]);
    try { await as('staffA', `UPDATE public.import_rows SET is_live = false WHERE batch_id = $1`, [b6.id]); return 'update succeeded'; }
    catch (e) { return /MRS_IMMUTABLE.*is_live/.test(errText(e)) || errText(e); }
  });
  await expectErr('clients cannot create import batches (bulk bypasses intake rate guard / terms)', () => as('clientA',
    `INSERT INTO public.import_batches (org_id, client_id, file_name, file_fingerprint) VALUES ($1, $2, 'mine.xlsx', $3) RETURNING id`, [A, CL101, 'ab'.repeat(32)]), /row-level security|null value/, 'import_batches_insert');
  await expectErr('client cannot commit a staff batch', () => as('clientA', `SELECT public.import_commit($1)`, [bA1.id]), /MRS_NOT_FOUND/);

  /* ---------------------------------------------------------------- storage */
  section('storage policies (bucket "documents")');
  await check('clientA reads only own client-visible object', async () => {
    const r = await as('clientA', `SELECT name FROM storage.objects WHERE bucket_id = 'documents'`);
    return (r.length === 1 && r[0].name === path4(A, TX1, DOC_A_CLI, 'bl.pdf')) || JSON.stringify(r);
  }, 'marsa_documents_read → documents_select');
  await check('clientA cannot read org-B objects by path', () => denied('clientA', `SELECT name FROM storage.objects WHERE name LIKE $1`, [B + '/%']), 'marsa_documents_read');
  await check('clientA cannot read clientA2 object by path', () => denied('clientA', `SELECT name FROM storage.objects WHERE name = $1`, [path4(A, TX2, DOC_A2_CLI, 'bl2.pdf')]), 'marsa_documents_read');
  await check('clientA cannot read internal object of own transaction', () => denied('clientA', `SELECT name FROM storage.objects WHERE name = $1`, [path4(A, TX1, DOC_A_INT, 'inv.pdf')]), 'marsa_documents_read');
  await check('staffB sees no org-A objects; staffA sees no org-B objects', async () => {
    const a = await denied('staffB', `SELECT name FROM storage.objects WHERE name LIKE $1`, [A + '/%']);
    const b = await denied('staffA', `SELECT name FROM storage.objects WHERE name LIKE $1`, [B + '/%']);
    return a === true && b === true || 'staffB: ' + a + ' staffA: ' + b;
  });
  await expectErr('clientA cannot upload into an org-B path', () => as('clientA',
    `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('documents', $1, $2)`, [path4(B, B_TX, 'x', 'evil.pdf'), U.clientA]), /row-level security/, 'marsa_documents_insert');
  await expectErr('clientA cannot register a document whose path starts with org B', () => as('clientA',
    `INSERT INTO public.documents (org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes) VALUES ($1, $2, 'other', $3, $4, 'e.pdf', 10)`,
    [A, TX1, path4(B, TX1, 'a0c00000-0000-4000-8000-0000000000ff', 'e.pdf'), hex('6')]), /documents_path_chk/);
  await expectErr('clientA cannot register a document in org B', () => as('clientA',
    `INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes) VALUES ($1, $2, $3, 'other', $4, $5, 'e.pdf', 10)`,
    ['a0c00000-0000-4000-8000-0000000000fe', B, B_TX, path4(B, B_TX, 'a0c00000-0000-4000-8000-0000000000fe', 'e.pdf'), hex('7')]), /row-level security|foreign key/, 'documents_insert');
  await expectErr('path traversal in storage_path rejected', () => as('staffA',
    `INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes) VALUES ($1, $2, $3, 'other', $4, $5, 'e.pdf', 10)`,
    ['a0c00000-0000-4000-8000-0000000000fd', A, TX1, `${A}/${TX1}/a0c00000-0000-4000-8000-0000000000fd/../../${B}/x.pdf`, hex('8')]), /documents_path_chk/);
  await expectErr('clientA cannot upload bytes into a path registered by staffA', () => as('clientA',
    `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('documents', $1, $2)`, [path4(A, TX1, DOC_A_PEND, 'pl.pdf'), U.clientA]), /row-level security/, 'marsa_documents_insert (uploaded_by = auth.uid())');
  await check('clientA uploads to the path of its own registered document', async () => {
    await as('clientA', `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('documents', $1, $2)`, [path4(A, TX1, DOC_CA_OWN, 'r.pdf'), U.clientA]);
    return true;
  });
  await expectErr('unregistered path in own org rejected', () => as('staffA',
    `INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', $1)`, [`${A}/${TX1}/random/evil.pdf`]), /row-level security/);
  await expectErr('other bucket rejected', () => as('staffA',
    `INSERT INTO storage.objects (bucket_id, name) VALUES ('documents-public', $1)`, [path4(A, TX1, DOC_A_PEND, 'pl.pdf')]), /row-level security|foreign key/);
  await check('no overwrite / delete of objects (even admin)', async () => {
    const u = await denied('adminA', `UPDATE storage.objects SET name = name || 'x' RETURNING 1`);
    const d = await denied('adminA', `DELETE FROM storage.objects RETURNING 1`);
    return (u === true && d === true) || 'update: ' + u + ' delete: ' + d;
  });

  await check('off-boarded staff loses access to documents (and objects) it uploaded', async () => {
    const mine = (await q(`SELECT count(*)::int n FROM public.documents WHERE uploaded_by = $1`, [U.staffA]))[0].n;
    if (!mine) return 'fixture: staffA uploaded no document';
    await q(`UPDATE public.memberships SET is_active = false WHERE user_id = $1`, [U.staffA]);
    try {
      const d = (await as('staffA', `SELECT count(*)::int n FROM public.documents`))[0].n;
      const o = (await as('staffA', `SELECT count(*)::int n FROM storage.objects`))[0].n;
      return (d === 0 && o === 0) || 'documents=' + d + ' objects=' + o;
    } finally { await q(`UPDATE public.memberships SET is_active = true WHERE user_id = $1`, [U.staffA]); }
  });

  /* ---------------------------------------------------------------- OCR results */
  section('document_extractions (OCR results): staff only, machine output immutable');
  const EXT_INS = `INSERT INTO public.document_extractions (org_id, transaction_id, doc_type, source_name, source_sha256, source_mime, source_size, source_pages,
      engine, languages, mean_confidence, raw_text, extracted_fields, qr_payload, line_items, created_by)
    VALUES ($1, $2, 'commercial_invoice', 'invoice.jpg', $3, 'image/jpeg', 2048, 1, 'tesseract.js@5.1.1', 'ara+eng', 87.5,
      'فاتورة ضريبية رقم INV-1001', '{"invoice_number":"INV-1001","supplier_vat":"300000000000003","total":"1150.00"}',
      '{"seller_name":"مورد تجريبي","vat_number":"300000000000003","timestamp":"2026-10-30T10:00:00Z","total":"1150.00","vat_total":"150.00"}',
      '[{"description":"بضاعة","hs_code":"847130","quantity":"2","unit_price":"500","amount":"1000"}]', $4)
    RETURNING id, created_by, review_status, reviewed_by, transaction_id`;
  let ex1, ex2;
  await check('staffA saves an OCR result; created_by forced to auth.uid()', async () => {
    ex1 = (await as('staffA', EXT_INS, [A, null, hex('5'), U.adminA]))[0];
    return (ex1.created_by === U.staffA && ex1.review_status === 'unreviewed' && ex1.reviewed_by === null) || JSON.stringify(ex1);
  }, 'tg_document_extractions_before (created_by)');
  await check('staffA saves an OCR result linked to own-org transaction', async () => {
    ex2 = (await as('staffA', EXT_INS, [A, TX1, hex('5'), null]))[0];   // same bytes, other scope (transaction) = allowed
    return ex2.transaction_id === TX1;
  });
  await check('staffA reads own-org OCR results', async () => {
    const r = await as('staffA', `SELECT id FROM public.document_extractions WHERE id = ANY ($1::uuid[])`, [[ex1.id, ex2.id, EXT_A]]);
    return r.length === 3 || 'got ' + r.length;
  });
  await expectErr('same file saved twice (same org, no transaction) = duplicate 23505', () => as('staffA', EXT_INS, [A, null, hex('5'), null]),
    /document_extractions_dedupe_uidx|duplicate key/);
  await expectErr('same file saved twice on the same transaction = duplicate', () => as('staffA', EXT_INS, [A, TX1, hex('5'), null]),
    /document_extractions_dedupe_uidx|duplicate key/);
  await check('duplicate check is per tenant (org B has its own row for the same bytes)', async () => {
    await q(`INSERT INTO public.document_extractions (org_id, source_name, source_sha256, engine, languages, raw_text, created_by)
             VALUES ($1, 'x.jpg', $2, 'tesseract.js@5.1.1', 'ara', 'x', $3)`, [B, hex('5'), U.staffB]);
    return true;
  });
  await check('staffB cannot see org-A OCR results', () => denied('staffB', `SELECT id FROM public.document_extractions WHERE org_id = $1`, [A]), 'document_extractions_select');
  await expectErr('staffB cannot insert an OCR result into org A', () => as('staffB', EXT_INS, [A, null, hex('6'), null]), /row-level security/, 'document_extractions_insert');
  await expectErr('staffB cannot link own-org OCR result to an org-A transaction', () => as('staffB', EXT_INS, [B, TX1, hex('6'), null]),
    /row-level security|foreign key|violates/, 'document_extractions_tx_fk');
  await expectErr('staffA cannot link an OCR result to an org-B transaction', () => as('staffA', EXT_INS, [A, B_TX, hex('6'), null]),
    /row-level security|foreign key|violates/, 'document_extractions_tx_fk / insert policy');
  await check('clientA cannot read OCR results (even of own transaction)', () => denied('clientA', `SELECT id FROM public.document_extractions`), 'document_extractions_select');
  await expectErr('clientA cannot insert an OCR result', () => as('clientA', EXT_INS, [A, TX1, hex('7'), null]), /row-level security/, 'document_extractions_insert');
  await expectErr('anon cannot read OCR results', () => as('anon', `SELECT 1 FROM public.document_extractions`), /permission denied/);
  await expectErr('anon cannot insert an OCR result', () => as('anon', EXT_INS, [A, null, hex('7'), null]), /permission denied/);
  for (const [col, val] of [['raw_text', `'نص مزور'`], ['extracted_fields', `'{"total":"1"}'`], ['source_sha256', `'${hex('9')}'`],
                            ['created_by', `'${U.adminA}'`], ['qr_payload', `'{"total":"1"}'`], ['org_id', `'${B}'`],
                            ['reviewed_by', `'${U.adminA}'`], ['engine', `'x'`]]) {
    await expectErr(`OCR result: ${col} is immutable`, () => as('staffA', `UPDATE public.document_extractions SET ${col} = ${val} WHERE id = $1`, [ex1.id]),
      new RegExp('MRS_IMMUTABLE.*' + col), 'tg_document_extractions_before guard list');
  }
  await check('review: reviewed_fields / line_items saved, reviewed_by + reviewed_at stamped by the server', async () => {
    const r = (await as('staffA', `UPDATE public.document_extractions
        SET reviewed_fields = '{"invoice_number":"INV-1001","total":"1150.00","currency":"SAR"}', review_status = 'reviewed',
            line_items = '[{"description":"بضاعة مصححة","quantity":"2","amount":"1000"}]', review_note = 'تمت المراجعة'
        WHERE id = $1 RETURNING reviewed_by, reviewed_at, review_status, extracted_fields ->> 'invoice_number' orig`, [ex1.id]))[0];
    return (r.reviewed_by === U.staffA && r.reviewed_at && r.review_status === 'reviewed' && r.orig === 'INV-1001') || JSON.stringify(r);
  });
  await check('review by adminA re-stamps the reviewer', async () => {
    const r = (await as('adminA', `UPDATE public.document_extractions SET review_note = 'مراجعة ثانية' WHERE id = $1 RETURNING reviewed_by`, [ex1.id]))[0];
    return r.reviewed_by === U.adminA || JSON.stringify(r);
  });
  await expectErr('unknown field key rejected', () => as('staffA', `UPDATE public.document_extractions SET reviewed_fields = '{"evil":"x"}' WHERE id = $1`, [ex1.id]),
    /document_extractions_reviewed_chk/);
  await expectErr('line_items must be an array of objects', () => as('staffA', `UPDATE public.document_extractions SET line_items = '{"a":1}' WHERE id = $1`, [ex1.id]),
    /document_extractions_items_chk/);
  await expectErr('invalid review_status rejected', () => as('staffA', `UPDATE public.document_extractions SET review_status = 'approved' WHERE id = $1`, [ex1.id]),
    /check constraint/);
  await check('transaction_id can be set once (NULL → own-org transaction)', async () =>
    (await as('staffA', `UPDATE public.document_extractions SET transaction_id = $2 WHERE id = $1 RETURNING id`, [EXT_A, TX3])).length === 1);
  await expectErr('transaction_id cannot be changed once set', () => as('staffA', `UPDATE public.document_extractions SET transaction_id = $2 WHERE id = $1`, [EXT_A, TX1]),
    /MRS_IMMUTABLE.*transaction_id/);
  await expectErr('document_id must be a document of the same transaction', () => as('staffA', `UPDATE public.document_extractions SET document_id = $2 WHERE id = $1`, [ex2.id, DOC_A2_CLI]),
    /MRS_INVALID.*document_id/);
  await expectErr('document_id of another org rejected', () => as('staffA', `UPDATE public.document_extractions SET document_id = $2 WHERE id = $1`, [ex2.id, B_DOC_INT]),
    /MRS_INVALID|foreign key|violates/);
  await check('original document attached (document_id NULL → own transaction document)', async () =>
    (await as('staffA', `UPDATE public.document_extractions SET document_id = $2 WHERE id = $1 RETURNING document_id`, [ex2.id, DOC_A_INT]))[0].document_id === DOC_A_INT);
  await expectErr('document_id cannot be changed once set', () => as('staffA', `UPDATE public.document_extractions SET document_id = $2 WHERE id = $1`, [ex2.id, DOC_A_CLI]),
    /MRS_IMMUTABLE.*document_id/);
  await expectErr('staffA cannot DELETE an OCR result', () => as('staffA', `DELETE FROM public.document_extractions WHERE id = $1`, [ex1.id]), /permission denied/);
  await expectErr('adminA cannot DELETE an OCR result', () => as('adminA', `DELETE FROM public.document_extractions WHERE id = $1`, [ex1.id]), /permission denied/);
  await check('void: voided_by stamped; voided row frozen; same file can be saved again', async () => {
    const v = (await as('staffA', `UPDATE public.document_extractions SET voided_at = now(), void_reason = 'قراءة خاطئة' WHERE id = $1 RETURNING voided_by`, [ex1.id]))[0];
    if (v.voided_by !== U.staffA) return 'voided_by=' + v.voided_by;
    try { await as('staffA', `UPDATE public.document_extractions SET review_note = 'x' WHERE id = $1`, [ex1.id]); return 'voided row edited'; }
    catch (e) { if (!/MRS_IMMUTABLE.*voided_at/.test(errText(e))) return errText(e); }
    const again = (await as('staffA', EXT_INS, [A, null, hex('5'), null]))[0];
    return !!again.id;
  });
  await check('OCR results are audited with the actor', async () =>
    (await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'document_extractions' AND actor = $1`, [U.staffA]))[0].n >= 3);
  await check('OCR audit rows carry no scanned content (audit_select has no branch check)', async () => {
    const r = (await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'document_extractions'
      AND (coalesce(new_data, '{}') ?| ARRAY['raw_text','extracted_fields','reviewed_fields','line_items','qr_payload']
        OR coalesce(old_data, '{}') ?| ARRAY['raw_text','extracted_fields','reviewed_fields','line_items','qr_payload'])`))[0];
    const ch = (await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'document_extractions' AND 'reviewed_fields' = ANY(changed_fields)`))[0];
    return r.n === 0 ? (ch.n > 0 || 'changed_fields lost reviewed_fields') : r.n + ' rows with content';
  });

  return finish();
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  if (warns.length) { console.log('WARNINGS (design findings for the security reviewer):'); warns.forEach(w => console.log('  - ' + w)); }
  const failed = nFail > 0 || (STRICT && nWarn > 0);
  console.log((failed ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed, ' + nWarn + ' warnings' + (STRICT ? ' (strict)' : ''));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
