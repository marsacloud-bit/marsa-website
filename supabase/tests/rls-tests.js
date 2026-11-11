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
  G6b adds: adminB (admin, org B), clrJED (clearance_staff, JED only), clrDMM (clearance_staff, DMM only) for the inbox branch checks.
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
  clientB: 'aaaa0000-0000-4000-8000-000000000006',
  finB: 'aaaa0000-0000-4000-8000-000000000007'      // G4: accounts_manager, org B (writes the org-B finance fixtures)
};
const FP1 = '1f'.repeat(32), FP2 = '2f'.repeat(32), FP3 = '3f'.repeat(32), FP4 = '4f'.repeat(32), FP5 = '5f'.repeat(32);
const hex = c => c.repeat(64);
const path4 = (org, tx, doc, name) => `${org}/${tx}/${doc}/${name}`;

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else if (who === 'service') {
    // G5 worker (Edge Function) identity: service_role, no user
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
  // one pending invitation per org (so the isolation sweep covers invitations; 0200)
  await q(`INSERT INTO public.invitations (org_id, email, role, token_hash, invited_by) VALUES
             ($1, 'invite.a@example.com', 'clearance_staff', $3, $5), ($2, 'invite.b@example.com', 'clearance_staff', $4, $6)`,
    [A, B, hex('e'), hex('f'), U.adminA, U.staffB]);
}

// document matching (20261116000100): one saved match per org, written by each org's own staff through the RPC
// (org A: EXT_A + an unlinked B/L reading; org B: B_EXT + a B/L reading of the same transaction B_TX)
async function matchFixtures() {
  const blA = (await q(`INSERT INTO public.document_extractions (org_id, doc_type, source_name, source_sha256, engine, languages, raw_text, extracted_fields, created_by)
                        VALUES ($1, 'bill_of_lading', 'a-bl.jpg', $2, 'tesseract.js@5.1.1', 'eng', 'BL A', '{"bl_number":"ABL1"}', $3) RETURNING id`, [A, hex('9'), U.staffA]))[0].id;
  const blB = (await q(`INSERT INTO public.document_extractions (org_id, transaction_id, doc_type, source_name, source_sha256, engine, languages, raw_text, extracted_fields, created_by)
                        VALUES ($1, $2, 'bill_of_lading', 'b-bl.jpg', $3, 'tesseract.js@5.1.1', 'eng', 'BL B', '{"bl_number":"BBL0001"}', $4) RETURNING id`, [B, B_TX, hex('8'), U.staffB]))[0].id;
  const p = (inv, bl) => ({ invoice_extraction_id: inv, bl_extraction_id: bl, mode: 'two_way', engine_version: 'match-v1', overall: 'review',
    counts: { partial: 1 }, rows: [{ key: 'bl_number', status: 'partial', critical: false, values: { invoice: 'X', bl: 'Y' } }] });
  await as('staffA', `SELECT public.save_document_match($1, $2)`, [A, p(EXT_A, blA)]);
  await as('staffB', `SELECT public.save_document_match($1, $2)`, [B, p(B_EXT, blB)]);
}

// legacy docs (20261119000100): per org, a document batch approved by the org's own staff through the RPCs into its
// transaction (org A: TX3, org B: B_TX) → a row in doc_batches, doc_batch_documents, transaction_shipment_data and both item tables
async function docBatchFixtures() {
  const rpcAs = async (who, sql, params) => (await as(who, sql, params))[0].r;
  for (const [who, org, tx, tag] of [['staffA', A, TX3, 'A'], ['staffB', B, B_TX, 'B']]) {
    const ext = (await q(`INSERT INTO public.document_extractions (org_id, transaction_id, doc_type, source_name, source_sha256, engine, languages, raw_text,
                            extracted_fields, created_by) VALUES ($1, $2, 'commercial_invoice', 'inv.pdf', $3, 'tesseract.js@5.1.1', 'eng', 'INV', $4, $5) RETURNING id`,
      [org, tx, hex(tag === 'A' ? '6' : '7'), JSON.stringify({ invoice_number: 'RLS-INV-' + tag }), U[who]]))[0].id;
    const b = await rpcAs(who, `SELECT public.create_doc_batch($1, $2) r`, [org, { transaction_id: tx }]);
    await rpcAs(who, `SELECT public.attach_doc_batch_document($1, $2) r`, [b.id, { extraction_id: ext, slot: 'commercial_invoice' }]);
    const draft = { invoice: { invoice_number: 'RLS-INV-' + tag, items: [{ description: 'بند ' + tag, quantity: 1 }] },
      packing: { packing_list_number: 'RLS-PL-' + tag, items: [{ description: 'تعبئة ' + tag, packages: 1 }] } };
    const s1 = await rpcAs(who, `SELECT public.save_doc_batch_draft($1, $2) r`, [b.id, { version: b.version, draft }]);
    await rpcAs(who, `SELECT public.approve_doc_batch($1, $2) r`, [b.id, { version: s1.version }]);
  }
}

// G3 (20261103000100 / 0200): one row per org in every new tenant table, written through the real
// RLS-guarded inserts / RPCs by each org's own staff. Org A uses TX3 (air, no containers) so the
// G1/G2 status tests below are unaffected; document requirements are export-only so nothing is gated.
async function g3Fixtures() {
  const rpcAs = async (who, sql, params) => (await as(who, sql, params))[0].r;
  for (const [who, org, tx, cl, tag] of [['staffA', A, TX3, CL101, 'A'], ['staffB', B, B_TX, B_CL, 'B']]) {
    const carrier = (await as(who, `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier','terminal_operator'], $2) RETURNING id`,
      [org, 'ناقل اختبار ' + tag]))[0].id;
    const driver = (await as(who, `INSERT INTO public.drivers (org_id, carrier_id, full_name, national_id_last4) VALUES ($1, $2, $3, '1234') RETURNING id`,
      [org, carrier, 'سائق ' + tag]))[0].id;
    await as(who, `INSERT INTO public.trucks (org_id, carrier_id, plate_no) VALUES ($1, $2, $3)`, [org, carrier, 'RLS ' + tag + '100']);
    await as(who, `INSERT INTO public.client_aliases (org_id, client_id, alias, source) VALUES ($1, $2, $3, 'manual')`, [org, cl, 'اسم بديل ' + tag]);
    // legacy core (20261117000100): the operator ↔ port mapping, written by the org's own transport writer
    await as(who, `INSERT INTO public.party_ports (org_id, party_id, port_code) VALUES ($1, $2, 'SAJED')`, [org, carrier]);
    if (tag === 'B') await rpcAs(who, `SELECT public.add_declaration($1, $2) r`, [tx, { declaration_no: 'RLS-B-DEC-1' }]);
    await rpcAs(who, `SELECT public.create_appointment($1) r`, [{ transaction_id: tx, terminal_party_id: carrier, appointment_at: '2026-12-01T08:00:00Z' }]);
    await rpcAs(who, `SELECT public.create_trip($1) r`, [{ transaction_id: tx, carrier_id: carrier, driver_id: driver, origin: 'ميناء', destination: 'مستودع' }]);
    await rpcAs(who, `SELECT public.create_exception($1) r`, [{ transaction_id: tx, kind: 'other', reason: 'استثناء اختبار ' + tag }]);
    await rpcAs(who, `SELECT public.refresh_alerts($1) r`, [org]);
  }
  // owner-side (no org-B admin user here): one export-only rule per org
  await q(`INSERT INTO public.document_requirements (org_id, operation, mode, document_kind, required_for_stage)
           VALUES ($1, 'export', NULL, 'packing_list', 'customs_declaration'), ($2, 'export', NULL, 'packing_list', 'customs_declaration')`, [A, B]);
}

// G4 (20261104000100): one row per org in every finance table, written through the real RPCs by a finance
// role of each org (org A: adminA; org B: finB, accounts_manager). Org A uses TX3 (as the G3 fixtures do).
// Returns { A: {...ids}, B: {...ids} } for the client-visibility / storage checks below.
const G4_TABLES = ['finance_documents', 'supplier_invoices', 'supplier_invoice_lines', 'cost_allocations', 'cost_accruals',
  'supplier_payments', 'client_charges', 'charge_collections', 'demurrage_cases', 'cost_adjustments'];
async function g4Fixtures() {
  await q(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'finb@example.com', '{"full_name":"محاسب ب"}')`, [U.finB]);
  await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'accounts_manager')`, [U.finB, B]);
  const rpcAs = async (who, sql, params) => (await as(who, sql, params))[0].r;
  const out = {};
  for (const [who, org, br, tx, tag] of [['adminA', A, JED, TX3, 'A'], ['finB', B, B_BR, B_TX, 'B']]) {
    const carrier = (await q(`SELECT id FROM public.parties WHERE org_id = $1 AND name_ar = $2`, [org, 'ناقل اختبار ' + tag]))[0].id;
    const doc = await rpcAs(who, `SELECT public.register_finance_document($1) r`, [{ branch_id: br, kind: 'supplier_invoice',
      original_name: 'inv-' + tag + '.pdf', mime_type: 'application/pdf', size_bytes: 1000, sha256: hex(tag === 'A' ? '7' : '8') }]);
    await as(who, `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('finance', $1, $2)`, [doc.storage_path, U[who]]);
    const inv = await rpcAs(who, `SELECT public.create_supplier_invoice($1) r`, [{ branch_id: br, supplier_id: carrier,
      invoice_number: 'RLS-' + tag + '-1', invoice_date: '2026-11-01', subtotal: 1000, vat_amount: 150, finance_document_id: doc.id,
      lines: [{ description: 'نقل حاوية', quantity: 1, unit_price: 1000, net_amount: 1000, vat_rate: 15, service_code: 'transport' }] }]);
    const alloc = await rpcAs(who, `SELECT public.allocate_invoice_line($1, $2) r`, [inv.lines[0].id, JSON.stringify([{ transaction_id: tx, amount: 400 }])]);
    const pay = await rpcAs(who, `SELECT public.record_supplier_payment($1) r`, [{ supplier_invoice_id: inv.id, amount: 100, method: 'cash', reference: 'PAY-' + tag }]);
    const ch = await rpcAs(who, `SELECT public.create_client_charge($1) r`, [{ transaction_id: tx, kind: 'service', description: 'رسوم تخليص', unit_price: 500 }]);
    await rpcAs(who, `SELECT public.set_charge_status($1, 'approved', NULL) r`, [ch.id]);
    const col = await rpcAs(who, `SELECT public.record_charge_collection($1) r`, [{ charge_id: ch.id, amount: 100, method: 'cash', reference: 'COL-' + tag }]);
    const dc = await rpcAs(who, `SELECT public.create_demurrage_case($1) r`, [{ transaction_id: tx, kind: 'storage', estimated_amount: 300 }]);
    const adj = await rpcAs(who, `SELECT public.create_cost_adjustment($1) r`, [{ kind: 'amendment', supplier_invoice_id: inv.id, reason: 'تعديل اختبار ' + tag }]);
    out[tag] = { org, tx, doc, inv, line: inv.lines[0].id, alloc: alloc.allocations ? alloc.allocations[0] : alloc, pay, ch, col, dc, adj };
  }
  return out;
}

// G5 (20261105000100): one row per org in every billing table. Staff steps go through the real staff RPCs
// (org A: adminA on TX3; org B: finB on B_TX, both bill_admin + fin_write); the worker side (probe completion,
// mock account) through the service-role RPCs; one review item per org is inserted by the owner (superuser),
// because the natural path needs an issued Daftra invoice. Returns { A: {...ids}, B: {...ids} }.
const G5_TABLES = ['daftra_connections', 'daftra_client_links', 'daftra_item_links', 'billing_intents', 'billing_intent_lines',
  'billing_sync_jobs', 'billing_sync_attempts', 'billing_review_items'];
const G5_AUDITED = G5_TABLES.filter(t => t !== 'billing_sync_attempts');
const G5_CAPS = ['clients.search_by_ref', 'clients.read', 'clients.create', 'clients.update', 'products.search_by_code',
  'products.search_by_name', 'products.create', 'invoices.create_draft', 'invoices.read', 'invoices.search_by_reference',
  'invoices.update_draft', 'invoices.line_reference_field', 'invoices.version_token', 'invoices.multi_currency',
  'invoices.issue', 'payments.read', 'credit_notes.create'];
const G5_STAFF_RPCS = ['get_daftra_connection', 'save_daftra_connection', 'request_daftra_probe', 'list_daftra_client_links',
  'link_daftra_client', 'refresh_daftra_client', 'resolve_client_drift', 'unlink_daftra_client', 'list_daftra_items',
  'save_daftra_item', 'create_billing_intent', 'add_billing_lines', 'remove_billing_line', 'request_billing_push',
  'request_billing_pull', 'resolve_billing_conflict', 'cancel_billing_intent', 'retry_billing_job', 'list_billing_intents',
  'get_billing_intent', 'list_billing_jobs', 'get_billing_job', 'billing_review_queue', 'resolve_billing_review', 'tx_billing'];
const G5_WORKER_RPCS = ['daftra_claim_jobs', 'daftra_complete_job', 'daftra_schedule_pulls', 'daftra_mock_load', 'daftra_mock_save', 'daftra_renew_lease'];
// G6a (20261106000100): read-side RPCs (search / reports / dashboards / portal invoices) + the export log
const G6A_RPCS = ['search_records', 'report_transactions', 'report_containers', 'report_trips', 'dash_ops', 'dash_finance',
  'dash_management', 'portal_invoices', 'log_report_export', 'list_report_exports'];
// the staff readers (everything but portal_invoices / log_report_export), called with p_org and an empty filter
const G6A_STAFF_READERS = ['search_records', 'report_transactions', 'report_containers', 'report_trips', 'dash_ops', 'dash_finance',
  'dash_management', 'list_report_exports'];
async function g5Fixtures(G4) {
  const rpcAs = async (who, sql, params) => (await as(who, sql, params))[0].r;
  const caps = {};
  G5_CAPS.forEach(k => { caps[k] = { supported: !['invoices.issue', 'credit_notes.create'].includes(k), evidence: 'mock' }; });
  const out = {};
  let n = 0;
  const key = () => 'a5a50000-0000-4000-8000-' + String(++n).padStart(12, '0');
  for (const [who, org, tag] of [['adminA', A, 'A'], ['finB', B, 'B']]) {
    const tx = G4[tag].tx;
    const conn = await rpcAs(who, `SELECT public.save_daftra_connection($1, $2) r`, [org, { mode: 'mock', subdomain: 'marsa-rls-' + tag.toLowerCase(), sync_enabled: true }]);
    const probe = await rpcAs(who, `SELECT public.request_daftra_probe($1, $2) r`, [org, key()]);
    // worker: claim the probe (one job per org per call) and complete it as the mock would
    const ctxs = await rpcAs('service', `SELECT public.daftra_claim_jobs($1, 5) r`, ['rls-worker']);
    const ctx = ctxs.find(c => c.job.org_id === org && c.job.kind === 'probe');
    if (!ctx) throw new Error('probe job of org ' + tag + ' not claimed');
    await rpcAs('service', `SELECT public.daftra_complete_job($1, $2) r`, [ctx.attempt_id, { outcome: 'ok',
      effects: { capabilities: caps, account: { currency: 'SAR' } },
      calls: [{ op: 'probe', at: new Date().toISOString(), ms: 1, request: { api_key: 'NEVER-STORED' }, response: { ok: true }, error: null, applied: 'yes' }] }]);
    const intent = await rpcAs(who, `SELECT public.create_billing_intent($1, $2) r`, [{ transaction_id: tx, purpose: 'final', currency: 'SAR' }, key()]);
    const intentId = intent.id || (intent.intent && intent.intent.id);
    const push = await rpcAs(who, `SELECT public.request_billing_push($1, $2) r`, [intentId, key()]);
    const review = (await q(`INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, kind, details)
                             VALUES ($1, $2, $3, 'issued_mismatch', '{"fixture":true}') RETURNING id`, [org, tx, intentId]))[0].id;
    await rpcAs('service', `SELECT public.daftra_mock_save($1, $2, 0) r`, [org, { clients: [], fixture: tag }]);
    out[tag] = { org, tx, conn, probe, intent: intentId, push, review, attempt: ctx.attempt_id };
  }
  return out;
}

// G6a: one report_exports row per org, through the real RPC (org A: adminA; org B: staffB). Returns { A: id, B: id }.
async function g6aFixtures() {
  const rpcAs = async (who, sql, params) => (await as(who, sql, params))[0].r;
  const a = await rpcAs('adminA', `SELECT public.log_report_export($1, $2) r`, [A, { report: 'transactions', format: 'xlsx', filters: { from: '2026-10-01' }, row_count: 3 }]);
  const b = await rpcAs('staffB', `SELECT public.log_report_export($1, $2) r`, [B, { report: 'containers', format: 'csv', filters: {}, row_count: 1 }]);
  return { A: a.id, B: b.id };
}

// G6b (20261107000100): the unified inbox. One row per org in every msg_* table, through the real staff RPCs
// (org A: staffA writes / sends, adminA approves; org B: staffB writes / sends, adminB approves) and the
// service-role worker RPCs with a handcrafted mock worker (as G5). The message edit event and one storage
// object per org in the private 'messages' bucket are inserted by the owner (the live worker's job).
// Branch users for the A1 / A2 separation: clrJED (clearance, JED only), clrDMM (clearance, DMM only).
const G6B_TABLES = ['msg_settings', 'msg_channels', 'msg_contacts', 'msg_contact_addresses', 'msg_contact_authorizations', 'msg_threads',
  'msg_messages', 'msg_message_events', 'msg_attachments', 'msg_replies', 'msg_ai_runs', 'msg_extractions', 'msg_classifications',
  'msg_summaries', 'msg_thread_links', 'msg_instructions', 'msg_templates', 'msg_reply_versions', 'msg_reply_approvals', 'msg_outbound',
  'msg_delivery_events', 'msg_auto_reply_policies', 'msg_jobs', 'msg_job_attempts'];
const G6B_AUDITED = ['msg_settings', 'msg_channels', 'msg_contacts', 'msg_contact_addresses', 'msg_contact_authorizations', 'msg_threads',
  'msg_instructions', 'msg_templates', 'msg_replies', 'msg_jobs', 'msg_auto_reply_policies'];
// thread-scoped tables (inherit the thread branch): the rest are org-level (msg_read roles) or admin-only (channel jobs)
const G6B_THREAD_TABLES = ['msg_threads', 'msg_messages', 'msg_message_events', 'msg_attachments', 'msg_extractions', 'msg_classifications',
  'msg_summaries', 'msg_thread_links', 'msg_replies', 'msg_reply_versions', 'msg_reply_approvals', 'msg_outbound', 'msg_delivery_events'];
const G6B_STAFF_RPCS = ['get_msg_settings', 'save_msg_settings', 'list_msg_channels', 'save_msg_channel', 'request_msg_channel_probe',
  'list_msg_contacts', 'get_msg_contact', 'save_msg_contact', 'add_msg_contact_address', 'retire_msg_contact_address',
  'verify_msg_contact_address', 'grant_msg_authorization', 'revoke_msg_authorization', 'list_msg_threads', 'get_msg_thread',
  'update_msg_thread', 'link_msg_thread', 'unlink_msg_thread', 'mark_msg_not_related', 'review_msg_extraction',
  'correct_msg_classification', 'accept_msg_summary', 'request_msg_draft', 'save_msg_reply', 'msg_attachment_suggestions',
  'set_msg_reply_attachments', 'submit_msg_reply', 'cancel_msg_reply', 'decide_msg_reply', 'send_msg_reply', 'retry_msg_send',
  'resolve_msg_send_unknown', 'list_msg_instructions', 'save_msg_instruction', 'review_msg_instruction', 'list_msg_templates',
  'save_msg_template', 'review_msg_template', 'seed_msg_templates', 'list_msg_auto_reply_policies', 'save_msg_auto_reply_policy',
  'tx_messages', 'list_msg_jobs', 'retry_msg_job', 'msg_retention_preview', 'msg_ai_usage'];
const G6B_WORKER_RPCS = ['msg_ingest_messages', 'msg_record_delivery', 'msg_claim_jobs', 'msg_complete_job', 'msg_renew_lease',
  'msg_schedule', 'msg_mock_load', 'msg_mock_save'];
const G6B_RLS_HELPERS = ['msg_can_read_thread', 'msg_can_read_message', 'msg_can_read_job'];
async function g6bFixtures() {
  U.adminB = 'aaaa0000-0000-4000-8000-000000000008';
  U.clrJED = 'aaaa0000-0000-4000-8000-000000000009';
  U.clrDMM = 'aaaa0000-0000-4000-8000-00000000000a';
  await q(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'adminb@example.com', '{"full_name":"مدير ب"}'),
             ($2, 'clrjed@example.com', '{"full_name":"مخلص جدة"}'), ($3, 'clrdmm@example.com', '{"full_name":"مخلص الدمام"}')`, [U.adminB, U.clrJED, U.clrDMM]);
  await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'admin'),
             ($3, $4, $5, 'clearance_staff'), ($6, $4, $7, 'clearance_staff')`, [U.adminB, B, U.clrJED, A, JED, U.clrDMM, DMM]);
  const rpcAs = async (who, sql, params) => (await as(who, sql, params))[0].r;
  const svc = async (sql, params) => (await as('service', sql, params))[0].r;
  const cpIdx = (s, i) => Array.from(s.slice(0, i)).length;
  const sha = s => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex');
  let n = 0;
  const key = () => 'a6b60000-0000-4000-8000-' + String(++n).padStart(12, '0');
  // the handcrafted mock worker: claim + complete until nothing is due
  const work = async () => {
    for (let round = 0; round < 10; round++) {
      const ctxs = await svc(`SELECT public.msg_claim_jobs('rls-worker', 20) r`);
      if (!ctxs.length) return;
      for (const c of ctxs) {
        let res;
        if (c.job.kind === 'probe') {
          res = { outcome: 'ok', effects: { capabilities: { send: { supported: true, evidence: 'mock' }, lookup_send: { supported: true, evidence: 'mock' } },
            account: { address: c.channel.address_norm } }, calls: [{ op: 'probe', applied: 'no', request: { password: 'NEVER-STORED' } }] };
        } else if (c.job.kind === 'process') {
          const m = c.message, body = m.body_text, cn = body.match(/[A-Z]{4}\d{7}/);
          const ex = cn ? [{ kind: 'container_no', raw: cn[0], normalized: cn[0], valid: true, confidence: 0.9, detail: {},
            span: { source: 'body', start: cpIdx(body, cn.index), end: cpIdx(body, cn.index) + cn[0].length } }] : [];
          res = { outcome: 'ok', calls: [{ op: 'process' }], effects: { message_id: m.id, extractions: ex,
            classification: { category: 'general_inquiry', confidence: 0.5, rules: [] },
            summary: { summary_ar: 'استفسار عام', summary_en: 'General inquiry', action_code: 'answer_inquiry', suggested_role: 'clearance_staff', deadline: null, risks: [] },
            risk_flags: [],
            ai_run: { provider: 'rule_mock', provider_version: 'rls-1', input_sha256: sha(body), input_chars: Array.from(body).length, output_chars: 10,
              est_input_tokens: 10, est_output_tokens: 3, est_cost_usd: 0 } } };
        } else if (c.job.kind === 'send') {
          res = { outcome: 'ok', calls: [{ op: 'send', applied: 'yes', request: { body_text: c.send.body_text, to: c.send.to } }],
            effects: { outbound_id: c.send.outbound_id, provider_message_id: 'prov-' + c.send.provider_request_id, status: 'accepted', found_by: 'sent' } };
        } else if (c.job.kind === 'poll') {
          res = { outcome: 'ok', effects: { messages: [], next_cursor: 'c1' } };
        } else {
          res = { outcome: 'ok', effects: { events: [], next_cursor: 's1' } };
        }
        await svc(`SELECT public.msg_complete_job($1, $2) r`, [c.attempt_id, JSON.stringify(res)]);
      }
    }
  };
  const out = {};
  for (const [admin, staff, org, tx, cl, tag] of [['adminA', 'staffA', A, TX3, CL101, 'A'], ['adminB', 'staffB', B, B_TX, B_CL, 'B']]) {
    const t = tag.toLowerCase();
    const chAddr = `inbox@rls-${t}.example`, sender = `agent@sender-${t}.example`;
    const settings = await rpcAs(admin, `SELECT public.save_msg_settings($1, $2) r`, [org, { retention_days: 730 }]);
    const ch = await rpcAs(admin, `SELECT public.save_msg_channel($1, $2, $3) r`, [org, { kind: 'email', name: 'Inbox ' + tag, address: chAddr,
      ingest_enabled: true, send_enabled: true, provider_terms_ack: true }, key()]);
    const probe = await rpcAs(admin, `SELECT public.request_msg_channel_probe($1, $2) r`, [ch.id, key()]);
    await work();
    const contact = await rpcAs(staff, `SELECT public.save_msg_contact($1, $2, $3) r`, [org, { display_name: 'عميل ' + tag, entity_type: 'client', client_id: cl }, key()]);
    const addr = await rpcAs(staff, `SELECT public.add_msg_contact_address($1, $2, $3) r`, [contact.id, { kind: 'email', address: sender }, key()]);
    await rpcAs(admin, `SELECT public.verify_msg_contact_address($1, 'callback', 'اتصال هاتفي للتحقق') r`, [addr.id]);
    const auth = await rpcAs(admin, `SELECT public.grant_msg_authorization($1, $2, 'تفويض اختبار') r`, [contact.id,
      { scope_type: 'client', client_id: cl, may_receive_kinds: ['delivery_order'], may_discuss: [] }]);
    const SECRET_BODY = 'RLS-BODY-' + tag + ' please confirm container ' + (tag === 'A' ? 'MSCU1234565' : 'TGHU1122334') + ' status';
    const ing = await svc(`SELECT public.msg_ingest_messages($1, $2) r`, [ch.id, JSON.stringify([{ provider_message_id: 'rls-em-' + t, kind: 'email',
      from: { address: sender, name: 'Agent ' + tag }, to: [{ address: chAddr }], cc: [], sent_at: new Date().toISOString(),
      subject: 'RLS-SUBJECT-' + tag, body_text: SECRET_BODY, headers: { message_id: '<rls-' + t + '@sender.example>' },
      auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      attachments: [{ provider_attachment_id: 'att-' + t, file_name: 'rls-' + t + '.pdf', mime_type: 'application/pdf', size_bytes: 100, extracted_text: 'x' }],
      raw: { provider: 'mock' } }])]);
    const item = ing.items[0];
    await work();
    const thread = item.thread_id;
    await rpcAs(staff, `SELECT public.link_msg_thread($1, $2, $3) r`, [thread, tx, 'ربط اختبار العزل']);
    const att = (await q(`SELECT id::text id, storage_path FROM public.msg_attachments WHERE message_id = $1`, [item.message_id]))[0];
    await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('messages', $1)`, [att.storage_path]);
    await q(`INSERT INTO public.msg_message_events (org_id, message_id, event, provider_event_id, payload) VALUES ($1, $2, 'reaction', 'rls-ev-' || $3, '{}')`, [org, item.message_id, t]);
    const reply = await rpcAs(staff, `SELECT public.save_msg_reply(NULL, $1, $2) r`, [{ thread_id: thread, reply_to_message_id: item.message_id, lang: 'ar',
      subject: 'Re: RLS', body_text: 'شكرًا، تم استلام رسالتكم.', to: [sender] }, key()]);
    const replyId = reply.id || (reply.reply && reply.reply.id);
    const sub = await rpcAs(staff, `SELECT public.submit_msg_reply($1) r`, [replyId]);
    await rpcAs(admin, `SELECT public.decide_msg_reply($1, $2, 'approve', 'مراجعة', false) r`, [replyId, sub.current_version_id]);
    const send = await rpcAs(staff, `SELECT public.send_msg_reply($1, $2) r`, [replyId, key()]);
    await work();
    await svc(`SELECT public.msg_record_delivery($1, $2) r`, [ch.id, JSON.stringify([{ provider_event_id: 'rls-d-' + t,
      provider_request_id: send.outbound.provider_request_id, status: 'delivered', at: new Date().toISOString() }])]);
    await rpcAs(admin, `SELECT public.save_msg_instruction($1, $2, $3) r`, [org, { instruction_key: 'lvl.telex', kind: 'approval_level',
      params: { category: 'telex_release', level: 'standard' } }, key()]);
    await rpcAs(admin, `SELECT public.seed_msg_templates($1) r`, [org]);
    await rpcAs(admin, `SELECT public.save_msg_auto_reply_policy($1, $2) r`, [org, { kind: 'ack_receipt', enabled: false }]);
    await svc(`SELECT public.msg_mock_save($1, $2, 0) r`, [ch.id, { inbound: [], sent: [], fixture: tag }]);
    out[tag] = { org, tx, settings, ch: ch.id, probe: probe.id, contact: contact.id, addr: addr.id, auth: auth.id, thread, message: item.message_id,
      attachment: att.id, storagePath: att.storage_path, reply: replyId, outbound: send.outbound.id, sendJob: send.job.id, body: SECRET_BODY, sender };
  }
  return out;
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
  ['document_extractions', `SELECT id::text id FROM public.document_extractions WHERE org_id = $1 LIMIT 1`, 'id::text', 'review_note = review_note'],
  // document matching (20261116000100): staff SELECT only (branch-scoped like the extractions), written only through RPCs
  ['document_matches',   `SELECT id::text id FROM public.document_matches WHERE org_id = $1 LIMIT 1`,   'id::text',  'review_note = review_note'],
  // legacy docs (20261119000100): staff SELECT only (branch-scoped), written only through the doc batch RPCs
  ['doc_batches',        `SELECT id::text id FROM public.doc_batches WHERE org_id = $1 LIMIT 1`,        'id::text',  'note = note'],
  ['doc_batch_documents', `SELECT id::text id FROM public.doc_batch_documents WHERE org_id = $1 LIMIT 1`, 'id::text', 'org_id = org_id'],
  ['transaction_shipment_data', `SELECT transaction_id::text id FROM public.transaction_shipment_data WHERE org_id = $1 LIMIT 1`, 'transaction_id::text', 'org_id = org_id'],
  ['shipment_invoice_items', `SELECT id::text id FROM public.shipment_invoice_items WHERE org_id = $1 LIMIT 1`, 'id::text', 'org_id = org_id'],
  ['shipment_packing_items', `SELECT id::text id FROM public.shipment_packing_items WHERE org_id = $1 LIMIT 1`, 'id::text', 'org_id = org_id'],
  ['invitations',        `SELECT id::text id FROM public.invitations WHERE org_id = $1 LIMIT 1`,        'id::text',  'email = email'],
  // G3 registry (20261103000100)
  ['parties',            `SELECT id::text id FROM public.parties WHERE org_id = $1 LIMIT 1`,            'id::text',  'name_ar = name_ar'],
  ['drivers',            `SELECT id::text id FROM public.drivers WHERE org_id = $1 LIMIT 1`,            'id::text',  'full_name = full_name'],
  ['trucks',             `SELECT id::text id FROM public.trucks WHERE org_id = $1 LIMIT 1`,             'id::text',  'plate_type = plate_type'],
  ['client_aliases',     `SELECT id::text id FROM public.client_aliases WHERE org_id = $1 LIMIT 1`,     'id::text',  'source = source'],
  // legacy core (20261117000100): operator ↔ port mapping (transport writers), per-org service catalog (seeded for every org)
  ['party_ports',        `SELECT id::text id FROM public.party_ports WHERE org_id = $1 LIMIT 1`,        'id::text',  'is_active = is_active'],
  ['org_service_items',  `SELECT id::text id FROM public.org_service_items WHERE org_id = $1 LIMIT 1`,  'id::text',  'name_ar = name_ar'],
  ['customs_declarations', `SELECT id::text id FROM public.customs_declarations WHERE org_id = $1 LIMIT 1`, 'id::text', 'status = status'],
  ['bills_of_lading',    `SELECT id::text id FROM public.bills_of_lading WHERE org_id = $1 LIMIT 1`,    'id::text',  'vessel = vessel'],
  ['transaction_bls',    `SELECT bl_id::text id FROM public.transaction_bls WHERE org_id = $1 LIMIT 1`, 'bl_id::text', 'is_primary = is_primary'],
  // G3 operations (20261103000200); transport_trips: explicit columns only (cost / sell outside the SELECT grant)
  ['document_requirements', `SELECT id::text id FROM public.document_requirements WHERE org_id = $1 LIMIT 1`, 'id::text', 'note = note'],
  ['port_appointments',  `SELECT id::text id FROM public.port_appointments WHERE org_id = $1 LIMIT 1`,  'id::text',  'status = status'],
  ['transport_trips',    `SELECT id::text id FROM public.transport_trips WHERE org_id = $1 LIMIT 1`,    'id::text',  'status = status'],
  ['operational_exceptions', `SELECT id::text id FROM public.operational_exceptions WHERE org_id = $1 LIMIT 1`, 'id::text', 'status = status'],
  ['operational_alerts', `SELECT id::text id FROM public.operational_alerts WHERE org_id = $1 LIMIT 1`, 'id::text',  'status = status'],
  // G4 suppliers & operating costs (20261104000100): read by finance roles only, written only through RPCs
  ...G4_TABLES.map(t => [t, `SELECT id::text id FROM public.${t} WHERE org_id = $1 LIMIT 1`, 'id::text', 'org_id = org_id']),
  // G5 Daftra integration & invoicing (20261105000100): read by finance roles only, written only through RPCs
  ...G5_TABLES.map(t => [t, `SELECT id::text id FROM public.${t} WHERE org_id = $1 LIMIT 1`, 'id::text', 'org_id = org_id']),
  // G6a export log (20261106000100): SELECT only (own rows / auditors), append-only, written only by log_report_export
  ['report_exports',     `SELECT id::text id FROM public.report_exports WHERE org_id = $1 LIMIT 1`,     'id::text',  'row_count = row_count'],
  // G6b unified inbox (20261107000100): read by staff (thread scope / org), written only through RPCs; no client branch
  ...G6B_TABLES.map(t => t === 'msg_settings'
    ? [t, `SELECT org_id::text id FROM public.msg_settings WHERE org_id = $1 LIMIT 1`, 'org_id::text', 'retention_days = retention_days']
    : [t, `SELECT id::text id FROM public.${t} WHERE org_id = $1 LIMIT 1`, 'id::text', 'org_id = org_id'])
];
// G2 internal tables: no API grant at all (written/read only through SECURITY DEFINER RPCs)
// G5: daftra_mock_accounts (fake Daftra account state) is service-role only, like the G2 internal tables
const NO_API_TABLES = ['idempotency_keys', 'platform_admins', 'schema_versions', 'client_errors', 'operational_alert_runs',
  'daftra_mock_accounts',
  // G6b: msg_mock_mailboxes (fake mailbox / WhatsApp state) is service-role only (RLS on, no policy, nothing granted)
  'msg_mock_mailboxes',
  // G7: subscription plans / per-org subscriptions / events / usage cache — read through platform RPCs only
  'plans', 'org_subscriptions', 'subscription_events', 'org_usage_counters'];
// platform reference tables without org: read-only for authenticated, nothing for anon (legacy core 20261117000100)
const PLATFORM_TABLES = ['customs_ports'];
const ALL_PUBLIC_TABLES = TENANT_TABLES.map(t => t[0]).concat(['status_labels'], NO_API_TABLES, PLATFORM_TABLES);

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
  try { await g3Fixtures(); pass('G3 fixtures: a row per org in every G3 table (parties … alerts)'); }
  catch (e) { fail('G3 fixtures', errText(e)); return finish(); }
  let G4;
  try { G4 = await g4Fixtures(); pass('G4 fixtures: a row per org in every finance table (documents … adjustments)'); }
  catch (e) { fail('G4 fixtures', errText(e)); return finish(); }
  let G5;
  try { G5 = await g5Fixtures(G4); pass('G5 fixtures: a row per org in every billing table (connection … review items, mock account)'); }
  catch (e) { fail('G5 fixtures', errText(e)); return finish(); }
  let G6A;
  try { G6A = await g6aFixtures(); pass('G6a fixtures: a report_exports row per org (log_report_export)'); }
  catch (e) { fail('G6a fixtures', errText(e)); return finish(); }
  let G6B;
  try { G6B = await g6bFixtures(); pass('G6b fixtures: a row per org in every msg_* table (channel … delivery, mock mailbox)'); }
  catch (e) { fail('G6b fixtures', errText(e)); return finish(); }
  try { await matchFixtures(); pass('doc-match fixtures: a document_matches row per org (invoice ↔ B/L, through save_document_match)'); }
  catch (e) { fail('doc-match fixtures', errText(e)); return finish(); }
  try { await docBatchFixtures(); pass('legacy docs fixtures: an approved document batch per org (batch, slot, shipment data, invoice / packing items)'); }
  catch (e) { fail('legacy docs fixtures', errText(e)); return finish(); }

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
  await check('platform reference tables (customs_ports): authenticated SELECT only, no write, nothing for anon', async () => {
    const r = await q(`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
                        WHERE grantee IN ('anon','authenticated') AND table_schema = 'public' AND table_name = ANY($1)`, [PLATFORM_TABLES]);
    return (r.length === PLATFORM_TABLES.length && r.every(x => x.grantee === 'authenticated' && x.privilege_type === 'SELECT')) || JSON.stringify(r);
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
  await check('G2 internal tables: no privilege at all for anon/authenticated', async () => {
    const r = await q(`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
                        WHERE grantee IN ('anon','authenticated') AND table_schema = 'public' AND table_name = ANY($1)`, [NO_API_TABLES]);
    const c = await q(`SELECT grantee, table_name FROM information_schema.column_privileges
                        WHERE grantee IN ('anon','authenticated') AND table_schema = 'public' AND table_name = ANY($1)`, [NO_API_TABLES]);
    return (r.length === 0 && c.length === 0) || r.concat(c).map(x => x.grantee + ':' + x.table_name + ':' + (x.privilege_type || 'column')).join(', ');
  });
  await check('anon can execute exactly the 6 public RPCs', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE') ORDER BY 1`);
    const got = r.map(x => x.proname).join(',');
    return got === 'health_check,invitation_preview,log_client_error,public_track,submit_contact_message,submit_service_request' || 'anon may execute: ' + got;
  });
  await check('privilege tables carry the audit trigger (memberships, invitations, platform_admins)', async () => {
    const r = await q(`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                        WHERE t.tgname = 'trg_audit' AND c.relname IN ('memberships','invitations','platform_admins') ORDER BY 1`);
    return r.map(x => x.relname).join(',') === 'invitations,memberships,platform_admins' || 'audited: ' + r.map(x => x.relname).join(',');
  });
  await check('anon has no USAGE on schema app', async () =>
    (await q(`SELECT has_schema_privilege('anon', 'app', 'USAGE') u`))[0].u === false);
  await check('authenticated can execute only the 191 documented public RPCs', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') ORDER BY 1`);
    const exp = ['admin_list_members', 'admin_set_member_active', 'convert_request_to_transaction', 'import_commit', 'issue_tracking_token', 'my_context', 'public_track',
      'set_financial_status', 'set_request_status', 'set_transaction_status', 'staff_internal_fields', 'submit_contact_message', 'submit_service_request',
      // G2 (0200 orgs/branches/invitations, 0300 ops/observability)
      'accept_invitation', 'admin_audit_log', 'admin_create_branch', 'admin_invite', 'admin_list_invitations', 'admin_recent_errors',
      'admin_reissue_invitation', 'admin_revoke_invitation', 'admin_update_branch', 'admin_update_org', 'health_check', 'invitation_preview',
      'log_client_error', 'platform_create_org', 'platform_list_orgs', 'platform_recent_errors', 'platform_set_org_active',
      'platform_reissue_admin_invitation',
      // G3 registry (20261103000100)
      'match_client', 'add_declaration', 'set_declaration_status', 'cancel_declaration', 'correct_declaration', 'save_bl', 'link_bl',
      'unlink_bl', 'container_history', 'transaction_completeness',
      // G3 operations (20261103000200)
      'tx_checklist', 'create_appointment', 'reschedule_appointment', 'set_appointment_status', 'create_trip', 'update_trip',
      'set_trip_status', 'trip_finance', 'set_container_return', 'create_exception', 'resolve_exception', 'refresh_alerts',
      'list_alerts', 'ack_alert', 'resolve_alert',
      // G4 suppliers & operating costs (20261104000100)
      'save_party_finance', 'register_finance_document', 'void_finance_document', 'create_supplier_invoice',
      'update_supplier_invoice', 'set_supplier_invoice_status', 'check_supplier_invoice_duplicate', 'add_invoice_lines',
      'update_invoice_line', 'review_invoice_line', 'allocate_invoice_line', 'approve_allocations', 'reject_allocation',
      'reverse_allocation', 'cost_review_queue', 'list_supplier_invoices', 'get_supplier_invoice', 'create_accrual',
      'review_accrual_variance', 'void_accrual', 'list_accruals', 'record_supplier_payment', 'void_supplier_payment',
      'list_supplier_payments', 'create_client_charge', 'update_client_charge', 'set_charge_status', 'list_client_charges',
      'suggest_client_charges', 'record_charge_collection', 'void_charge_collection', 'create_demurrage_case',
      'update_demurrage_case', 'set_demurrage_status', 'list_demurrage', 'create_cost_adjustment', 'review_cost_adjustment',
      'list_cost_adjustments', 'tx_costs', 'tx_margin', 'margin_report', 'cost_report',
      // G5 Daftra integration & invoicing (20261105000100): 25 staff RPCs; the 5 daftra_* worker RPCs are NOT here
      ...G5_STAFF_RPCS,
      // G6a portal / reports (20261106000100): 10 read-side RPCs (log_report_export is the only writer, append-only)
      ...G6A_RPCS,
      // G6b unified inbox (20261107000100): 46 staff RPCs; the 8 msg_* worker / ingest RPCs are NOT here (service_role only)
      ...G6B_STAFF_RPCS,
      // G7 subscriptions (20261108000100): 8 platform-admin RPCs + org_subscription (org admin)
      'platform_list_plans', 'platform_save_plan', 'platform_list_subscriptions', 'platform_set_org_plan', 'platform_suspend_org',
      'platform_activate_org', 'platform_org_usage', 'platform_recount_usage', 'org_subscription',
      // AI document reading (20261114000100): staff ai_access + org-admin settings; ai_reserve / ai_settle are service_role only
      'ai_access', 'ai_get_settings', 'ai_save_settings',
      // document matching (20261116000100): save / review / void a match (staff)
      'save_document_match', 'review_document_match', 'void_document_match',
      // legacy core (20261117000100): void-only cancel of a transaction (ops writers of its branch)
      'cancel_transaction',
      // legacy tx (20261118000100): duplicate pre-check, stepper, combined movement, movements list, driver directory, operators by port
      'check_tx_duplicates', 'tx_lifecycle', 'save_movement', 'list_movements', 'driver_directory', 'port_operators',
      // legacy docs (20261119000100): document batches, approval into the transaction, shipment data, client matching v2, shipping agents
      'create_doc_batch', 'attach_doc_batch_document', 'detach_doc_batch_document', 'merge_doc_batch', 'save_doc_batch_draft', 'get_doc_batch',
      'list_pending_doc_batches', 'discard_doc_batch', 'archive_doc_batch', 'approve_doc_batch', 'get_transaction_shipment', 'match_client_v2',
      'confirm_client_match', 'reject_client_alias', 'seed_shipping_agents', 'match_shipping_agent'];
    const got = r.map(x => x.proname);
    if (exp.length !== 217) return 'expected list has ' + exp.length + ' names';
    const extra = got.filter(x => !exp.includes(x));
    const missing = exp.filter(x => !got.includes(x));
    return (extra.length === 0 && missing.length === 0) || 'unexpected: ' + extra.join(', ') + ' missing: ' + missing.join(', ');
  });
  await check('authenticated cannot execute admin_add_member (SQL Editor only; closes the account-existence oracle)', async () =>
    (await q(`SELECT has_function_privilege('authenticated', 'public.admin_add_member(uuid, text, text, uuid)', 'EXECUTE') x`))[0].x === false
    || 'authenticated may execute admin_add_member', '0200 REVOKE admin_add_member');
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
  await check('storage bucket "finance" (G4 originals) is private', async () =>
    (await q(`SELECT public FROM storage.buckets WHERE id = 'finance'`))[0].public === false);
  await check('G4 tables: authenticated holds SELECT only (no INSERT / UPDATE / DELETE grant)', async () => {
    const r = await q(`SELECT table_name, privilege_type FROM information_schema.role_table_grants
                        WHERE grantee = 'authenticated' AND table_schema = 'public' AND table_name = ANY($1) AND privilege_type <> 'SELECT'`, [G4_TABLES]);
    return r.length === 0 || r.map(x => x.table_name + ':' + x.privilege_type).join(', ');
  });
  await check('G4 tables carry the audit trigger', async () => {
    const r = await q(`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'trg_audit' AND c.relname = ANY($1)`, [G4_TABLES]);
    return r.length === G4_TABLES.length || 'audited: ' + r.map(x => x.relname).join(',');
  });
  await check('G4 dictionaries are never client-visible (status_labels fin_*)', async () =>
    (await q(`SELECT count(*)::int n FROM public.status_labels WHERE domain LIKE 'fin\\_%' AND client_visible`))[0].n === 0);
  await check('G5 worker RPCs (daftra_*): service_role only — not authenticated, not anon, not PUBLIC; SECURITY DEFINER', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') s, p.prosecdef d,
                              coalesce(array_to_string(p.proacl, ','), '') acl
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'daftra\\_%'`);
    const names = r.map(x => x.proname).sort().join(',');
    if (names !== [...G5_WORKER_RPCS].sort().join(',')) return 'daftra_* functions: ' + names;
    const bad = r.filter(x => x.a || x.n || !x.s || !x.d || /(^|,)=X/.test(x.acl));
    return bad.length === 0 || bad.map(x => x.proname + ' ' + JSON.stringify(x)).join('; ');
  });
  await check('G5 staff RPCs: authenticated + SECURITY DEFINER, never anon', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($1)
                          AND (NOT p.prosecdef OR has_function_privilege('anon', p.oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))`, [G5_STAFF_RPCS]);
    const all = (await q(`SELECT count(DISTINCT p.proname)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($1)`, [G5_STAFF_RPCS]))[0].n;
    return (r.length === 0 && all === 25) || 'bad: ' + r.map(x => x.proname).join(',') + ' found ' + all;
  });
  await check('G5 tables: authenticated holds SELECT only (no INSERT / UPDATE / DELETE grant)', async () => {
    const r = await q(`SELECT table_name, privilege_type FROM information_schema.role_table_grants
                        WHERE grantee = 'authenticated' AND table_schema = 'public' AND table_name = ANY($1) AND privilege_type <> 'SELECT'`, [G5_TABLES]);
    return r.length === 0 || r.map(x => x.table_name + ':' + x.privilege_type).join(', ');
  });
  await check('G5 tables carry the audit trigger, except the append-only attempt log and the mock account', async () => {
    const r = await q(`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'trg_audit'
                         AND c.relname = ANY($1) ORDER BY 1`, [G5_TABLES.concat(['daftra_mock_accounts'])]);
    return r.map(x => x.relname).join(',') === [...G5_AUDITED].sort().join(',') || 'audited: ' + r.map(x => x.relname).join(',');
  });
  await check('G5 policies: SELECT only, to authenticated only, none on daftra_mock_accounts', async () => {
    const r = await q(`SELECT tablename, policyname, cmd, roles::text roles FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [G5_TABLES.concat(['daftra_mock_accounts'])]);
    const bad = r.filter(x => x.cmd !== 'SELECT' || x.roles !== '{authenticated}' || x.tablename === 'daftra_mock_accounts');
    const covered = new Set(r.map(x => x.tablename));
    const missing = G5_TABLES.filter(t => !covered.has(t));
    return (bad.length === 0 && missing.length === 0) || 'bad: ' + bad.map(x => x.tablename + '.' + x.policyname).join(',') + ' missing: ' + missing.join(',');
  });
  await check('G5 dictionaries are never client-visible (status_labels daftra_* / bill_*)', async () => {
    const r = (await q(`SELECT count(*)::int n, count(*) FILTER (WHERE client_visible)::int v FROM public.status_labels
                         WHERE domain LIKE 'daftra\\_%' OR domain LIKE 'bill\\_%'`))[0];
    return (r.n > 0 && r.v === 0) || JSON.stringify(r);
  });
  await check('G5 tables hold no secret-like column (api key / secret / token / password / credential)', async () => {
    const r = await q(`SELECT table_name || '.' || column_name c FROM information_schema.columns WHERE table_schema = 'public'
                         AND table_name = ANY($1) AND column_name ~* '(api_?key|secret|token|password|passwd|credential|authorization|cookie)'`,
      [G5_TABLES.concat(['daftra_mock_accounts'])]);
    return r.length === 0 || r.map(x => x.c).join(', ');
  });
  await check('G5 app.bill_* helpers: none executable by anon / authenticated except the RLS helper bill_can_read_job', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'
                         AND (p.proname LIKE 'bill\\_%' OR p.proname LIKE 'tg\\_bill\\_%') AND p.proname <> 'bill_can_read_job'
                         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))`);
    return r.length === 0 || 'callable: ' + r.map(x => x.proname).join(', ');
  });

  /* ---------------------------------------------------------------- anon */
  section('anon: no direct table access');
  for (const t of TENANT_TABLES.map(x => x[0])) {
    await expectErr(`anon cannot SELECT ${t}`, () => as('anon', `SELECT 1 FROM public.${t} LIMIT 1`), /permission denied/, 'REVOKE ALL ... FROM anon (0300 §6)');
  }
  for (const t of NO_API_TABLES) for (const who of ['anon', 'adminA', 'staffA']) {
    await expectErr(`${who} cannot SELECT ${t} (G2 internal table)`, () => as(who, `SELECT 1 FROM public.${t} LIMIT 1`), /permission denied/, 'REVOKE ALL ... FROM anon, authenticated (G2)');
    await expectErr(`${who} cannot DELETE ${t} (G2 internal table)`, () => as(who, `DELETE FROM public.${t} RETURNING 1`), /permission denied/, 'REVOKE ALL ... FROM anon, authenticated (G2)');
  }
  // G7 (20261108000100): platform-only subscription RPCs are unreachable for org members / clients; org_subscription = own org admin only
  for (const [fn, sql] of [
    ['platform_list_plans', `SELECT public.platform_list_plans()`],
    ['platform_save_plan', `SELECT public.platform_save_plan('basic', '{"name_ar":"اختبار"}'::jsonb)`],
    ['platform_list_subscriptions', `SELECT public.platform_list_subscriptions()`],
    ['platform_set_org_plan', `SELECT public.platform_set_org_plan('${A}', '{"plan_code":"basic","status":"active","period_start":"2026-01-01","reason":"x"}'::jsonb)`],
    ['platform_suspend_org', `SELECT public.platform_suspend_org('${A}', 'x')`],
    ['platform_activate_org', `SELECT public.platform_activate_org('${A}', 'x')`],
    ['platform_org_usage', `SELECT public.platform_org_usage('${A}')`],
    ['platform_recount_usage', `SELECT public.platform_recount_usage('${A}')`]]) {
    for (const who of ['adminA', 'staffA', 'clientA', 'staffB']) {
      await expectErr(`${who} cannot call ${fn} (G7 platform-only)`, () => as(who, sql), /MRS_FORBIDDEN/, 'G7 app.is_platform_admin() check');
    }
    await expectErr(`anon cannot call ${fn} (G7)`, () => as('anon', sql), /permission denied/, 'G7 REVOKE ... FROM anon');
  }
  for (const who of ['staffA', 'clientA', 'staffB', 'clientB']) {
    await expectErr(`${who} cannot read org_subscription of org A (G7 admin only)`, () => as(who, `SELECT public.org_subscription('${A}')`), /MRS_NOT_FOUND/, 'G7 app.has_role(p_org, admin)');
  }
  await check('adminA reads own org_subscription without a price (G7-11)', async () => {
    const r = (await as('adminA', `SELECT public.org_subscription('${A}') s`))[0].s;
    return (r && r.plan_code === 'pilot' && !JSON.stringify(r).includes('price')) || 'got ' + JSON.stringify(r);
  });
  await expectErr('anon cannot call org_subscription (G7)', () => as('anon', `SELECT public.org_subscription('${A}')`), /permission denied/);
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
    ['app.is_member', `SELECT app.is_member('${A}')`],
    // G3
    ['match_client', `SELECT public.match_client('${A}', '{"name":"x"}')`],
    ['add_declaration', `SELECT public.add_declaration('${TX1}', '{"declaration_no":"X"}')`],
    ['save_bl', `SELECT public.save_bl('{"org_id":"${A}","bl_number":"X"}')`],
    ['container_history', `SELECT public.container_history('${A}', 'TSTU0000001')`],
    ['transaction_completeness', `SELECT public.transaction_completeness('${TX1}')`],
    ['tx_checklist', `SELECT public.tx_checklist('${TX1}')`],
    ['create_trip', `SELECT public.create_trip('{"transaction_id":"${TX1}"}')`],
    ['trip_finance', `SELECT public.trip_finance(ARRAY['${TX1}']::uuid[])`],
    ['list_alerts', `SELECT public.list_alerts('${A}', '{}')`],
    ['refresh_alerts', `SELECT public.refresh_alerts('${A}')`],
    ['app.seed_document_requirements', `SELECT app.seed_document_requirements('${A}')`],
    ['app.refresh_all_alerts', `SELECT app.refresh_all_alerts()`],
    // G4
    ['tx_costs', `SELECT public.tx_costs('${TX1}')`],
    ['tx_margin', `SELECT public.tx_margin('${TX1}')`],
    ['list_supplier_invoices', `SELECT public.list_supplier_invoices('${A}', '{}')`],
    ['create_supplier_invoice', `SELECT public.create_supplier_invoice('{}')`],
    ['register_finance_document', `SELECT public.register_finance_document('{}')`],
    ['margin_report', `SELECT public.margin_report('${A}', '{}')`],
    ['cost_report', `SELECT public.cost_report('${A}', '{"group_by":"transaction"}')`],
    ['list_demurrage', `SELECT public.list_demurrage('${A}', '{}')`],
    ['app.fin_cost_items', `SELECT * FROM app.fin_cost_items('${A}')`],
    // G5
    ['get_daftra_connection', `SELECT public.get_daftra_connection('${A}')`],
    ['list_billing_intents', `SELECT public.list_billing_intents('${A}', '{}')`],
    ['tx_billing', `SELECT public.tx_billing('${TX3}')`],
    ['create_billing_intent', `SELECT public.create_billing_intent('{}')`],
    ['daftra_claim_jobs', `SELECT public.daftra_claim_jobs('anon', 1)`],
    ['daftra_complete_job', `SELECT public.daftra_complete_job(gen_random_uuid(), '{}')`],
    ['daftra_mock_load', `SELECT public.daftra_mock_load('${A}')`],
    ['app.bill_redact', `SELECT app.bill_redact('{}'::jsonb)`]
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
  await expectErr('admin_add_member refuses an org-B branch (no EXECUTE for authenticated)', () => as('adminA', `SELECT public.admin_add_member($1, 'staff.b@test.local', 'clearance_staff', $2)`, [A, B_BR]), /permission denied/);
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
    ['adminA admin_add_member into org B', 'adminA', `SELECT public.admin_add_member($1, 'staffa@example.com', 'admin', NULL)`, [B], /permission denied/],
    ['adminA admin_add_member with org-B branch', 'adminA', `SELECT public.admin_add_member($1, 'staffb@example.com', 'clearance_staff', $2)`, [A, B_BR], /permission denied/],
    ['adminA admin_add_member role=client', 'adminA', `SELECT public.admin_add_member($1, 'clienta2@example.com', 'client', NULL)`, [A], /permission denied/],
    ['adminA admin_set_member_active on org-B membership', 'adminA', `SELECT public.admin_set_member_active($1, false)`, [memB], /MRS_NOT_FOUND/],
    ['adminA cannot deactivate itself', 'adminA', `SELECT public.admin_set_member_active($1, false)`, [memAdminA], /MRS_FORBIDDEN/],
    ['staffA admin_add_member (self-promotion)', 'staffA', `SELECT public.admin_add_member($1, 'staffa@example.com', 'admin', NULL)`, [A], /permission denied/]
  ]) await expectErr('admin RPC refused: ' + name, () => as(who, sql, params), re, 'public.admin_* (0650)');
  await check('adminA admin_list_members(org A) lists only org-A members', async () => {
    const r = (await as('adminA', `SELECT public.admin_list_members($1) r`, [A]))[0].r;
    return (r.length > 0 && !r.some(m => m.email === 'staffb@example.com' || m.email === 'clientb@example.com')) || JSON.stringify(r.map(m => m.email));
  });
  // the former account-existence oracle (WARN until G2): authenticated can no longer execute admin_add_member at all
  await expectErr('admin_add_member is not an account-existence oracle (EXECUTE revoked from authenticated)', () =>
    as('adminA', `SELECT public.admin_add_member($1, 'no-such-user@example.com', 'clearance_staff', NULL)`, [A]), /permission denied/, '0200 REVOKE admin_add_member; UI uses admin_invite');

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
    'containers', 'total', 'returned', 'timeline', 'label_ar', 'label_en', 'at',
    // legacy tx (20261118000100): a cancelled transaction shows «ملغاة» (no personal data)
    'cancelled', 'cancelled_at']);
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
  // 20261113000100: a miss is the value {"not_found": true} — identical for every cause (no oracle) — instead of the
  // MRS_NOT_FOUND error, so that failed guesses are rate-counted (a raise rolls the counter back). supa.js maps it back.
  const trackMiss = async (name, fn) => check(name, async () => {
    const r = await fn();
    return (r && r.length === 1 && JSON.stringify(r[0].r) === '{"not_found":true}') || JSON.stringify(r);
  }, 'public.public_track');
  await trackMiss('public_track wrong token → {"not_found": true}', () => as('anon', `SELECT public.public_track($1, $2) r`, [trk.ref, 'f'.repeat(64)]));
  await trackMiss('public_track missing token → {"not_found": true}', () => as('anon', `SELECT public.public_track($1, NULL) r`, [trk.ref]));
  await trackMiss('public_track empty token → {"not_found": true}', () => as('anon', `SELECT public.public_track($1, '') r`, [trk.ref]));
  await trackMiss('public_track token hash instead of token → {"not_found": true}', async () => {
    const h = (await q(`SELECT tracking_token_hash h FROM public.service_requests WHERE ref = $1 AND org_id = $2`, [trk.ref, A]))[0].h;
    return as('anon', `SELECT public.public_track($1, $2) r`, [trk.ref, h]);
  });
  await trackMiss('public_track unknown ref → same {"not_found": true} (no oracle)', () => as('anon', `SELECT public.public_track('REQ-2099-999999', $1) r`, [trk.tracking_token]));
  await trackMiss('public_track SQL-ish / oversized input → {"not_found": true}', () => as('anon', `SELECT public.public_track($1, $2) r`, ["REQ-2026-000001' OR 1=1 --", 'x'.repeat(10000)]));
  await check('same ref number in two orgs: token selects the right one', async () => {
    const b = (await as('anon', `SELECT public.submit_service_request($1) r`, [P({ orgSlug: 'org-b' })]))[0].r;
    const sameRefInA = (await q(`SELECT count(*)::int n FROM public.service_requests WHERE ref = $1 AND org_id = $2`, [b.ref, A]))[0].n;
    let crossOk = true;
    if (sameRefInA) {
      // the seed token on B's ref: either A's seed row (same ref) or a miss — never B's row
      const x = (await as('anon', `SELECT public.public_track($1, $2) r`, [b.ref, SEED_TOKEN]))[0].r;
      crossOk = x.not_found === true || b.ref === (await q(`SELECT ref FROM public.service_requests WHERE id = $1`, [REQ_SEED]))[0].ref;
    }
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
  await trackMiss('transaction ref without issued token → {"not_found": true}', () => as('anon', `SELECT public.public_track($1, $2) r`, [conv.ref, SEED_TOKEN]));
  await check('issued transaction token works; re-issue invalidates the old one', async () => {
    const t1 = (await as('staffA', `SELECT public.issue_tracking_token($1) r`, [TX1]))[0].r;
    const ref = t1.ref;
    const ok1 = !!(await as('anon', `SELECT public.public_track($1, $2) r`, [ref, t1.tracking_token]))[0].r.transaction;
    const t2 = (await as('staffA', `SELECT public.issue_tracking_token($1) r`, [TX1]))[0].r;
    let oldRejected = false;
    oldRejected = (await as('anon', `SELECT public.public_track($1, $2) r`, [ref, t1.tracking_token]))[0].r.not_found === true;
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
  // Formerly WARN 'rate guard design' (per phone + 120/10 min per org only: one script could fill the org bucket).
  // Resolved by 20261113000100_public_antispam.sql (docs/online/ANTISPAM_AR.md), which runs before these guards:
  //   visitor  5 / 10 min per IP (cf-connecting-ip, the edge-set header; forged x-real-ip / XFF ignored), IPv6 /48 15;
  //   signed-in account that is not a member / client of the target org (self sign-up is open): 20 / 10 min per
  //   account whatever its IPs, and its IP budget × 4.
  // So neither one source nor one throw-away account can exhaust the org bucket. Full coverage: antispam-tests.js.
  // Left to the edge (documented there, not a code defect): a botnet of many IPs, or many throw-away accounts.
  const hdr = async v => db.query(`SELECT set_config('request.headers', $1, false)`, [v]);
  await check('rate guard design: one IP (rotating phones, forged X-Forwarded-For) is stopped by the per-IP layer long before the org-wide bucket', async () => {
    try {
      let n = 0, last = '';
      for (let i = 0; i < 8; i++) {
        await hdr(JSON.stringify({ 'cf-connecting-ip': '203.0.113.200', 'x-forwarded-for': '10.0.0.' + i, 'x-real-ip': '10.1.0.' + i }));
        try { await as('anon', `SELECT public.submit_service_request($1)`, [P({ orgSlug: 'org-b' })]); n++; }
        catch (e) { last = errText(e); break; }
      }
      return (n === 5 && /MRS_RATE_LIMITED.*try_later/.test(last)) || JSON.stringify({ n, last });
    } finally { await hdr(''); }
  }, 'app.antispam_gate (20261113000100)');
  await check('rate guard design: one signed-in non-member account rotating IPs and phones is stopped at 20 (user bucket), far below 120', async () => {
    try {
      let n = 0, last = '';
      for (let i = 0; i < 30; i++) {
        await hdr(JSON.stringify({ 'cf-connecting-ip': '198.51.100.' + (100 + i) }));
        try { await as('staffA', `SELECT public.submit_service_request($1)`, [P({ orgSlug: 'org-b' })]); n++; }   // staff of A, not of B
        catch (e) { last = errText(e); break; }
      }
      return (n === 20 && /MRS_RATE_LIMITED.*try_later/.test(last)) || JSON.stringify({ n, last });
    } finally { await hdr(''); }
  }, 'app.antispam_gate (20261113000100)');
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
    // financial_status and tracking_token_hash are not API-selectable (0700 + G5 column grants): read back as superuser
    const r = (await as('staffA', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, ref, operational_status, financial_status, tracking_token_hash)
      VALUES ($1, $2, $3, 'import', 'sea', 'HACK-1', 'closed', 'settled', $4) RETURNING id, ref, operational_status`, [A, JED, CL101, hex('a')]))[0];
    Object.assign(r, (await q(`SELECT tracking_token_hash, financial_status FROM public.transactions WHERE id = $1`, [r.id]))[0]);
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
  // legacy tx (20261118000100): the appointment / trip RPCs of earlier sections now move TX3 forward automatically;
  // the stage-order checks below start again from 'new' (owner SQL, no event)
  await q(`UPDATE public.transactions SET operational_status = 'new' WHERE id = $1`, [TX3]);
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

  /* ---------------------------------------------------------------- G4 */
  section('G4 finance data: clients and non-finance staff see no cost / supplier / margin data');
  // the fixtures are real: org A has a row in every finance table, so "0 rows" below is not vacuous
  for (const t of G4_TABLES) {
    await check(`G4 fixture: adminA reads its own org-A ${t}`, async () =>
      (await as('adminA', `SELECT count(*)::int n FROM public.${t} WHERE org_id = $1`, [A]))[0].n > 0 || 'no visible row');
    for (const who of ['clientA', 'clientA2', 'staffA']) {
      await check(`${who} reads 0 rows of ${t} (own org)`, () => denied(who, `SELECT 1 FROM public.${t}`), `RLS ${t}_select: fin_read_roles only`);
    }
  }
  await check('clientA (client 101 = TX3 owner) sees no finance timeline event on its own transaction', async () => {
    const own = (await q(`SELECT count(*)::int n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'finance'`, [TX3]))[0].n;
    if (own === 0) return 'no finance event in the fixture — check would be vacuous';
    return denied('clientA', `SELECT 1 FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'finance'`, [TX3]);
  });
  await check('finance events carry no amounts and are never client-visible', async () => {
    const r = (await q(`SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'finance'
                         AND (visible_to_client OR payload::text ~ '"(amount|net_amount|total_amount|unit_price|subtotal|vat_amount)"')`))[0].n;
    return r === 0 || r + ' leaking finance events';
  });
  await check('clientA sees no finance-bucket storage object', () => denied('clientA', `SELECT 1 FROM storage.objects WHERE bucket_id = 'finance'`));
  await check('staffA (clearance_staff) sees no finance-bucket storage object of its own org', () =>
    denied('staffA', `SELECT 1 FROM storage.objects WHERE bucket_id = 'finance'`));
  await check('staffB / finB see no org-A finance-bucket object', async () => {
    for (const who of ['staffB', 'finB']) {
      const d = await denied(who, `SELECT 1 FROM storage.objects WHERE bucket_id = 'finance' AND name LIKE $1`, [A + '/%']);
      if (d !== true) return who + ': ' + d;
    }
    return true;
  });
  await check('adminA reads its own org-A finance original (positive control)', async () =>
    (await as('adminA', `SELECT 1 FROM storage.objects WHERE bucket_id = 'finance' AND name = $1`, [G4.A.doc.storage_path])).length === 1);
  await expectErr('finB cannot upload into an org-A finance path', () => as('finB',
    `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('finance', $1, $2)`, [`${A}/${G4.A.doc.id}/evil.pdf`, U.finB]), /row-level security|permission denied/);
  await expectErr('clientA cannot upload into the finance bucket', () => as('clientA',
    `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('finance', $1, $2)`, [`${A}/${G4.A.doc.id}/x.pdf`, U.clientA]), /row-level security|permission denied/);
  const g4Readers = [
    ['tx_costs', `SELECT public.tx_costs($1)`, [TX3]],
    ['tx_margin', `SELECT public.tx_margin($1)`, [TX3]],
    ['list_client_charges', `SELECT public.list_client_charges($1)`, [TX3]],
    ['suggest_client_charges', `SELECT public.suggest_client_charges($1)`, [TX3]],
    ['get_supplier_invoice', `SELECT public.get_supplier_invoice($1)`, [G4.A.inv.id]],
    ['list_supplier_invoices', `SELECT public.list_supplier_invoices($1, '{}')`, [A]],
    ['check_supplier_invoice_duplicate', `SELECT public.check_supplier_invoice_duplicate($1, $2)`, [A, { supplier_id: G4.A.inv.supplier_id, invoice_number: 'RLS-A-1', invoice_date: '2026-11-01', total_amount: 1150 }]],
    ['cost_review_queue', `SELECT public.cost_review_queue($1, '{}')`, [A]],
    ['list_accruals', `SELECT public.list_accruals($1, '{}')`, [A]],
    ['list_supplier_payments', `SELECT public.list_supplier_payments($1, '{}')`, [A]],
    ['list_demurrage', `SELECT public.list_demurrage($1, '{}')`, [A]],
    ['list_cost_adjustments', `SELECT public.list_cost_adjustments($1, '{}')`, [A]],
    ['margin_report', `SELECT public.margin_report($1, '{}')`, [A]],
    ['cost_report', `SELECT public.cost_report($1, '{"group_by":"transaction"}')`, [A]]
  ];
  for (const [fn, sql, params] of g4Readers) {
    for (const who of ['clientA', 'staffA']) {
      await expectErr(`${who} gets no result from ${fn} (own org)`, () => as(who, sql, params), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
    }
    await expectErr(`staffB gets no result from ${fn} (org A)`, () => as('staffB', sql, params), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
    await expectErr(`finB (org-B finance) gets no result from ${fn} (org A)`, () => as('finB', sql, params), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
  }
  await check('positive control: adminA reads tx_costs / tx_margin of TX3', async () => {
    const c = (await as('adminA', `SELECT public.tx_costs($1) r`, [TX3]))[0].r;
    const m = (await as('adminA', `SELECT public.tx_margin($1) r`, [TX3]))[0].r;
    return (c.charges.length >= 1 && c.allocations.length >= 1 && m.analytical === true) || JSON.stringify({ c: Object.keys(c), m });
  });
  for (const [fn, sql, params] of [
    ['create_supplier_invoice', `SELECT public.create_supplier_invoice($1)`, [{ branch_id: JED, supplier_id: G4.A.inv.supplier_id, invoice_number: 'X-1', invoice_date: '2026-11-01', subtotal: 1, vat_amount: 0 }]],
    ['create_client_charge', `SELECT public.create_client_charge($1)`, [{ transaction_id: TX3, kind: 'service', description: 'x', unit_price: 1 }]],
    ['record_supplier_payment', `SELECT public.record_supplier_payment($1)`, [{ supplier_invoice_id: G4.A.inv.id, amount: 1, method: 'cash', reference: 'x' }]],
    ['allocate_invoice_line', `SELECT public.allocate_invoice_line($1, $2)`, [G4.A.line, JSON.stringify([{ transaction_id: TX3, amount: 1 }])]],
    ['save_party_finance', `SELECT public.save_party_finance($1, $2)`, [G4.A.inv.supplier_id, { iban_last4: '1234' }]]
  ]) {
    for (const who of ['clientA', 'staffA', 'staffB', 'finB']) {
      await expectErr(`${who} cannot call ${fn} on org A`, () => as(who, sql, params), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
    }
  }
  await expectErr('staffA cannot change a party finance column directly (guard trigger)', () => as('staffA',
    `UPDATE public.parties SET iban_last4 = '9999' WHERE id = $1`, [G4.A.inv.supplier_id]), /MRS_FORBIDDEN|permission denied|row-level security/);

  /* ---------------------------------------------------------------- G5 */
  section('G5 billing / Daftra: clients and non-finance staff see no billing internals; worker RPCs service-role only');
  // the fixtures are real: both orgs have a row in every billing table, so "0 rows" below is not vacuous
  for (const t of G5_TABLES) {
    await check(`G5 fixture: adminA reads its own org-A ${t}`, async () =>
      (await as('adminA', `SELECT count(*)::int n FROM public.${t} WHERE org_id = $1`, [A]))[0].n > 0 || 'no visible row');
    await check(`G5 fixture: finB reads its own org-B ${t} and nothing of org A`, async () => {
      const own = (await as('finB', `SELECT count(*)::int n FROM public.${t} WHERE org_id = $1`, [B]))[0].n;
      const other = (await as('finB', `SELECT count(*)::int n FROM public.${t} WHERE org_id = $1`, [A]))[0].n;
      return (own > 0 && other === 0) || JSON.stringify({ own, other });
    });
    for (const who of ['clientA', 'clientA2', 'staffA']) {
      await check(`${who} reads 0 rows of ${t} (own org)`, () => denied(who, `SELECT 1 FROM public.${t}`), `RLS ${t}_select: fin_read_roles only`);
    }
  }
  await check('G5 fixture: daftra_mock_accounts holds a row per org (owner view)', async () =>
    (await q(`SELECT count(DISTINCT org_id)::int n FROM public.daftra_mock_accounts WHERE org_id = ANY($1)`, [[A, B]]))[0].n === 2);
  for (const who of ['adminA', 'finB', 'clientA']) {
    await expectErr(`${who} cannot SELECT daftra_mock_accounts`, () => as(who, `SELECT 1 FROM public.daftra_mock_accounts`), /permission denied/);
  }
  await check('logged probe request kept no api_key (redacted before insert)', async () => {
    const r = (await q(`SELECT calls::text c FROM public.billing_sync_attempts WHERE id = $1`, [G5.A.attempt]))[0];
    return (!!r && !/NEVER-STORED|api_key/i.test(r.c)) || (r ? r.c : 'no attempt');
  });
  // as G4 'finance' events: internal (staff timelines show the op label only), never client-visible, never amounts
  await check('billing events are internal, carry no amounts / bodies, and no client user sees one', async () => {
    const n = (await q(`SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'billing'`))[0].n;
    if (n === 0) return 'no billing event in the fixture — check would be vacuous';
    const leak = (await q(`SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'billing'
                            AND (visible_to_client OR payload::text ~ '"(amount|net_amount|vat_amount|total_amount|unit_price|lines_total|remote_total|paid_amount|calls|request|response)"')`))[0].n;
    if (leak) return leak + ' leaking billing events';
    for (const who of ['clientA', 'clientA2', 'clientB']) {
      const d = await denied(who, `SELECT 1 FROM public.transaction_events WHERE event_type = 'billing'`);
      if (d !== true) return who + ': ' + d;
    }
    return true;
  });
  await check('G5 rows never reach audit_log readers outside finance: staffA / clientA see no G5 audit row', async () => {
    const n = (await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = ANY($1)`, [G5_AUDITED]))[0].n;
    if (n === 0) return 'no G5 audit row — vacuous';
    const att = (await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name IN ('billing_sync_attempts','daftra_mock_accounts')`))[0].n;
    if (att) return att + ' audit rows for attempts / mock accounts';
    for (const who of ['clientA', 'staffA']) {
      const d = await denied(who, `SELECT 1 FROM public.audit_log WHERE table_name = ANY($1)`, [G5_AUDITED]);
      if (d !== true) return who + ': ' + d;
    }
    return true;
  });
  const g5Readers = [
    ['get_daftra_connection', `SELECT public.get_daftra_connection($1)`, [A]],
    ['list_daftra_client_links', `SELECT public.list_daftra_client_links($1, '{}')`, [A]],
    ['list_daftra_items', `SELECT public.list_daftra_items($1)`, [A]],
    ['list_billing_intents', `SELECT public.list_billing_intents($1, '{}')`, [A]],
    ['get_billing_intent', `SELECT public.get_billing_intent($1)`, [G5.A.intent]],
    ['list_billing_jobs', `SELECT public.list_billing_jobs($1, '{}')`, [A]],
    ['get_billing_job', `SELECT public.get_billing_job($1)`, [G5.A.probe.id]],
    ['billing_review_queue', `SELECT public.billing_review_queue($1, '{}')`, [A]],
    ['tx_billing', `SELECT public.tx_billing($1)`, [TX3]]
  ];
  for (const [fn, sql, params] of g5Readers) {
    for (const who of ['clientA', 'staffA']) {
      await expectErr(`${who} gets no result from ${fn} (own org)`, () => as(who, sql, params), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
    }
    await expectErr(`staffB gets no result from ${fn} (org A)`, () => as('staffB', sql, params), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
    await expectErr(`finB (org-B finance) gets no result from ${fn} (org A)`, () => as('finB', sql, params), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
  }
  await check('positive control: adminA reads tx_billing / get_billing_intent of TX3', async () => {
    const t = (await as('adminA', `SELECT public.tx_billing($1) r`, [TX3]))[0].r;
    const g = (await as('adminA', `SELECT public.get_billing_intent($1) r`, [G5.A.intent]))[0].r;
    return (t.intents.length === 1 && g.intent.id === G5.A.intent && g.lines.length >= 1) || JSON.stringify({ t: t.intents.length, g: Object.keys(g) });
  });
  for (const [fn, sql, params] of [
    ['save_daftra_connection', `SELECT public.save_daftra_connection($1, $2)`, [A, { sync_enabled: false }]],
    ['request_daftra_probe', `SELECT public.request_daftra_probe($1, NULL)`, [A]],
    ['link_daftra_client', `SELECT public.link_daftra_client($1, NULL, NULL)`, [CL101]],
    ['save_daftra_item', `SELECT public.save_daftra_item($1, 'service:none', '{"name_ar":"خدمات"}')`, [A]],
    ['create_billing_intent', `SELECT public.create_billing_intent($1, NULL)`, [{ transaction_id: TX3, purpose: 'interim', currency: 'SAR' }]],
    ['add_billing_lines', `SELECT public.add_billing_lines($1, NULL, NULL)`, [G5.A.intent]],
    ['request_billing_push', `SELECT public.request_billing_push($1, NULL)`, [G5.A.intent]],
    ['request_billing_pull', `SELECT public.request_billing_pull($1)`, [G5.A.intent]],
    ['cancel_billing_intent', `SELECT public.cancel_billing_intent($1, 'x')`, [G5.A.intent]],
    ['resolve_billing_review', `SELECT public.resolve_billing_review($1, 'accept', 'note', NULL)`, [G5.A.review]]
  ]) {
    for (const who of ['clientA', 'staffA', 'staffB', 'finB']) {
      await expectErr(`${who} cannot call ${fn} on org A`, () => as(who, sql, params), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
    }
  }
  const g5Worker = [
    ['daftra_claim_jobs', `SELECT public.daftra_claim_jobs('evil', 5)`, []],
    ['daftra_complete_job', `SELECT public.daftra_complete_job($1, '{"outcome":"ok"}')`, [G5.A.attempt]],
    ['daftra_schedule_pulls', `SELECT public.daftra_schedule_pulls(5)`, []],
    ['daftra_mock_load', `SELECT public.daftra_mock_load($1)`, [A]],
    ['daftra_mock_save', `SELECT public.daftra_mock_save($1, '{}', 1)`, [A]],
    ['daftra_renew_lease', `SELECT public.daftra_renew_lease($1)`, [G5.A.attempt]]
  ];
  for (const [fn, sql, params] of g5Worker) {
    for (const who of ['adminA', 'finB', 'staffA', 'clientA']) {
      await expectErr(`${who} cannot execute worker RPC ${fn}`, () => as(who, sql, params), /permission denied/);
    }
  }
  await check('worker identity cannot use staff RPCs: service_role → MRS_AUTH_REQUIRED (no user)', async () => {
    for (const [fn, sql, params] of [['tx_billing', `SELECT public.tx_billing($1)`, [TX3]],
      ['request_billing_push', `SELECT public.request_billing_push($1, NULL)`, [G5.A.intent]],
      ['list_billing_intents', `SELECT public.list_billing_intents($1, '{}')`, [A]]]) {
      try { await as('service', sql, params); return fn + ' answered for service_role'; }
      catch (e) { if (!/MRS_AUTH_REQUIRED/.test(errText(e))) return fn + ': ' + errText(e); }
    }
    return true;
  });
  await check('the forged worker lane: finB cannot read org-A attempts / jobs and the fixture lease is untouched', async () => {
    const d = await denied('finB', `SELECT 1 FROM public.billing_sync_attempts WHERE org_id = $1`, [A]);
    if (d !== true) return d;
    const j = await denied('finB', `SELECT 1 FROM public.billing_sync_jobs WHERE org_id = $1`, [A]);
    return j;
  });

  /* ---------------------------------------------------------------- G6a */
  section('G6a portal / reports: catalog, clients reach no staff reader, export log append-only');
  await check('G6a RPCs: SECURITY DEFINER, search_path pinned, EXECUTE for authenticated only (not PUBLIC / anon)', async () => {
    const r = await q(`SELECT p.proname, p.prosecdef d, has_function_privilege('anon', p.oid, 'EXECUTE') n,
                              has_function_privilege('authenticated', p.oid, 'EXECUTE') a, coalesce(array_to_string(p.proacl, ','), '') acl,
                              EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c = 'search_path=""') sp
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($1)`, [G6A_RPCS]);
    const bad = r.filter(x => !x.d || x.n || !x.a || !x.sp || /(^|,)=X/.test(x.acl));
    return (r.length === G6A_RPCS.length && bad.length === 0) || 'found ' + r.length + ' bad: ' + bad.map(x => x.proname + ' ' + JSON.stringify(x)).join('; ');
  });
  await check('G6a app helpers (rpt_*, mgmt_roles): not executable by anon / authenticated', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'
                         AND (p.proname LIKE 'rpt\\_%' OR p.proname = 'mgmt_roles')
                         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))`);
    const n = (await q(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'
                         AND (p.proname LIKE 'rpt\\_%' OR p.proname = 'mgmt_roles')`))[0].n;
    return (n >= 10 && r.length === 0) || 'helpers ' + n + ' callable: ' + r.map(x => x.proname).join(', ');
  });
  await check('report_exports: authenticated holds SELECT only, anon nothing, no column grant', async () => {
    const r = await q(`SELECT grantee, privilege_type FROM information_schema.role_table_grants
                        WHERE grantee IN ('anon','authenticated') AND table_schema = 'public' AND table_name = 'report_exports'`);
    const c = await q(`SELECT grantee, column_name, privilege_type FROM information_schema.column_privileges
                        WHERE grantee IN ('anon','authenticated') AND table_schema = 'public' AND table_name = 'report_exports' AND privilege_type <> 'SELECT'`);
    const got = r.map(x => x.grantee + ':' + x.privilege_type).sort().join(',');
    return (got === 'authenticated:SELECT' && c.length === 0) || got + ' cols ' + JSON.stringify(c);
  });
  await check('report_exports: one SELECT policy to authenticated, append-only triggers, not under trg_audit, no row-data column', async () => {
    const pol = await q(`SELECT policyname, cmd, roles::text roles FROM pg_policies WHERE schemaname = 'public' AND tablename = 'report_exports'`);
    const trg = (await q(`SELECT string_agg(t.tgname, ',' ORDER BY t.tgname) s FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                           WHERE c.relname = 'report_exports' AND NOT t.tgisinternal`))[0].s;
    const cols = (await q(`SELECT string_agg(column_name, ',' ORDER BY column_name) s FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'report_exports'`))[0].s;
    const ok = pol.length === 1 && pol[0].cmd === 'SELECT' && pol[0].roles === '{authenticated}'
      && trg === 'trg_append_only,trg_append_only_trunc' && cols === 'actor,created_at,filters,format,id,org_id,report,row_count';
    return ok || JSON.stringify({ pol, trg, cols });
  });
  await check('G6a dictionaries: report_kind / export_format / search_date_field internal, portal_payment_status client-visible', async () => {
    const r = await q(`SELECT domain, count(*)::int n, count(*) FILTER (WHERE client_visible)::int v FROM public.status_labels
                        WHERE domain IN ('report_kind','export_format','search_date_field','portal_payment_status') GROUP BY 1 ORDER BY 1`);
    const m = Object.fromEntries(r.map(x => [x.domain, x]));
    const ok = m.report_kind && m.report_kind.n === 6 && m.report_kind.v === 0 && m.export_format && m.export_format.n === 3 && m.export_format.v === 0
      && m.search_date_field && m.search_date_field.n === 4 && m.search_date_field.v === 0
      && m.portal_payment_status && m.portal_payment_status.n === 4 && m.portal_payment_status.v === 4;
    return ok || JSON.stringify(r);
  });
  // anon: no EXECUTE at all
  for (const fn of G6A_RPCS) {
    const sql = fn === 'portal_invoices' ? `SELECT public.portal_invoices(NULL)`
      : fn === 'log_report_export' ? `SELECT public.log_report_export('${A}', '{"report":"search","format":"csv","row_count":0}')`
      : `SELECT public.${fn}('${A}', '{}')`;
    await expectErr(`anon cannot call ${fn}`, () => as('anon', sql), /permission denied/, 'G6a §5 REVOKE … FROM PUBLIC, anon');
  }
  // clients of org A and org B, and org-B staff: every staff reader on org A → MRS_FORBIDDEN (never an empty success)
  for (const fn of G6A_STAFF_READERS) {
    for (const who of ['clientA', 'clientA2', 'clientB', 'staffB', 'finB']) {
      await expectErr(`${who} gets MRS_FORBIDDEN from ${fn}(org A)`, () => as(who, `SELECT public.${fn}($1, '{}')`, [A]), /MRS_FORBIDDEN/, 'G6a §Roles gate (is_staff / fin_org_read / mgmt)');
    }
  }
  await expectErr('clientB gets MRS_FORBIDDEN from search_records(own org B)', () => as('clientB', `SELECT public.search_records($1, '{}')`, [B]), /MRS_FORBIDDEN/);
  await expectErr('clientB gets MRS_FORBIDDEN from dash_ops(own org B)', () => as('clientB', `SELECT public.dash_ops($1, '{}')`, [B]), /MRS_FORBIDDEN/);
  for (const [who, rep] of [['clientA', 'transactions'], ['clientA', 'search'], ['clientB', 'containers'], ['staffB', 'trips']]) {
    await expectErr(`${who} cannot log a ${rep} export for org A`, () => as(who, `SELECT public.log_report_export($1, $2)`,
      [A, { report: rep, format: 'csv', filters: {}, row_count: 1 }]), /MRS_FORBIDDEN/);
  }
  // non-finance / non-management staff of org A
  for (const [fn, re] of [['dash_finance', /MRS_FORBIDDEN/], ['dash_management', /MRS_FORBIDDEN/]]) {
    await expectErr(`staffA (clearance_staff) gets MRS_FORBIDDEN from ${fn}`, () => as('staffA', `SELECT public.${fn}($1, '{}')`, [A]), re);
  }
  await expectErr('staffA (clearance_staff) cannot log a margins export', () => as('staffA', `SELECT public.log_report_export($1, $2)`,
    [A, { report: 'margins', format: 'xlsx', filters: {}, row_count: 1 }]), /MRS_FORBIDDEN/);
  await expectErr('staffA (clearance_staff) cannot ask trip finance (report_trips include_finance)', () => as('staffA',
    `SELECT public.report_trips($1, '{"include_finance":true}')`, [A]), /MRS_FORBIDDEN/);
  await check('positive control: staffA search_records(org A) answers with org-A rows only, financial_status hidden', async () => {
    const r = (await as('staffA', `SELECT public.search_records($1, '{}') r`, [A]))[0].r;
    const orgs = (await q(`SELECT count(*)::int n FROM public.transactions WHERE id = ANY($1) AND org_id <> $2`, [r.items.map(x => x.id), A]))[0].n;
    return (r.total > 0 && orgs === 0 && r.items.every(x => x.financial_status === null)) || JSON.stringify({ total: r.total, orgs });
  });
  await check('positive control: adminA reads dash_ops / dash_finance / dash_management of org A', async () => {
    for (const fn of ['dash_ops', 'dash_finance', 'dash_management']) {
      const r = (await as('adminA', `SELECT public.${fn}($1, '{}') r`, [A]))[0].r;
      if (!r || typeof r !== 'object') return fn + ' returned ' + JSON.stringify(r);
    }
    return true;
  });
  // portal_invoices: never another client's transaction, same answer for other org
  for (const [who, tx] of [['clientA2', TX1], ['clientB', TX1], ['clientA', TX2], ['clientA', B_TX], ['staffB', TX1]]) {
    await expectErr(`${who} portal_invoices(<not own tx>) → MRS_NOT_FOUND`, () => as(who, `SELECT public.portal_invoices($1)`, [tx]), /MRS_NOT_FOUND/, 'portal_invoices: client_id ∈ my_client_ids()');
  }
  await check('staffA / adminA (no client link) get an empty portal_invoices()', async () => {
    for (const who of ['staffA', 'adminA']) {
      const r = (await as(who, `SELECT public.portal_invoices(NULL) r`))[0].r;
      if (!(r && r.count === 0 && Array.isArray(r.items) && r.items.length === 0)) return who + ': ' + JSON.stringify(r);
    }
    return true;
  });
  await check('clientA portal_invoices() lists no draft / open / cancelled intent', async () => {
    const r = (await as('clientA', `SELECT public.portal_invoices(NULL) r`))[0].r;
    const ids = r.items.map(x => x.id);
    const bad = ids.length ? (await q(`SELECT count(*)::int n FROM public.billing_intents WHERE id = ANY($1) AND status <> 'issued'`, [ids]))[0].n : 0;
    return (Array.isArray(r.items) && bad === 0) || JSON.stringify(r);
  });
  // export log visibility and append-only
  await check('report_exports: clients read 0 rows (own org and other org)', async () => {
    for (const who of ['clientA', 'clientA2', 'clientB']) {
      const d = await denied(who, `SELECT 1 FROM public.report_exports`);
      if (d !== true) return who + ': ' + d;
    }
    return true;
  });
  await check('report_exports: staffA sees only its own rows; adminA (auditor) sees the org-A row of adminA', async () => {
    await as('staffA', `SELECT public.log_report_export($1, $2)`, [A, { report: 'search', format: 'csv', filters: { q: 'MSCU' }, row_count: 0 }]);
    const mine = await as('staffA', `SELECT actor::text a FROM public.report_exports`);
    const adm = await as('adminA', `SELECT actor::text a, org_id::text o FROM public.report_exports`);
    const okS = mine.length === 1 && mine[0].a === U.staffA;
    const okA = adm.length === 2 && adm.every(x => x.o === A);
    const lst = (await as('staffA', `SELECT public.list_report_exports($1, $2) r`, [A, { actor: U.adminA }]))[0].r;
    return (okS && okA && lst.total === 0) || JSON.stringify({ mine, adm, lst: lst.total });
  });
  for (const who of ['adminA', 'staffA', 'clientA']) {
    await expectErr(`${who} cannot UPDATE report_exports`, () => as(who, `UPDATE public.report_exports SET row_count = 0 WHERE id = $1 RETURNING 1`, [G6A.A]), /permission denied/);
    await expectErr(`${who} cannot DELETE report_exports`, () => as(who, `DELETE FROM public.report_exports WHERE id = $1 RETURNING 1`, [G6A.A]), /permission denied/);
    await expectErr(`${who} cannot INSERT report_exports directly`, () => as(who,
      `INSERT INTO public.report_exports (org_id, actor, report, format, row_count) VALUES ($1, $2, 'search', 'csv', 0)`, [A, U.adminA]), /permission denied|row-level security/);
  }
  await expectErr('owner UPDATE of report_exports refused by the trigger (MRS_APPEND_ONLY)', () => q(`UPDATE public.report_exports SET row_count = 0 WHERE id = $1`, [G6A.A]), /MRS_APPEND_ONLY/);
  await expectErr('owner DELETE of report_exports refused by the trigger (MRS_APPEND_ONLY)', () => q(`DELETE FROM public.report_exports WHERE id = $1`, [G6A.B]), /MRS_APPEND_ONLY/);

  /* ---------------------------------------------------------------- G6b */
  section('G6b inbox: catalog, worker RPCs service-role only, clients see nothing, org + branch separation');
  await check('G6b staff RPCs: SECURITY DEFINER, search_path pinned, EXECUTE for authenticated only (not PUBLIC / anon / service-only)', async () => {
    const r = await q(`SELECT p.proname, p.prosecdef d, has_function_privilege('anon', p.oid, 'EXECUTE') n,
                              has_function_privilege('authenticated', p.oid, 'EXECUTE') a, coalesce(array_to_string(p.proacl, ','), '') acl,
                              EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c = 'search_path=""') sp
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($1)`, [G6B_STAFF_RPCS]);
    const bad = r.filter(x => !x.d || x.n || !x.a || !x.sp || /(^|,)=X/.test(x.acl));
    return (G6B_STAFF_RPCS.length === 46 && r.length === 46 && bad.length === 0) || 'found ' + r.length + ' bad: ' + bad.map(x => x.proname + ' ' + JSON.stringify(x)).join('; ');
  });
  await check('G6b worker / ingest RPCs (msg_ingest … msg_mock_save): service_role only — not authenticated, anon or PUBLIC; SECURITY DEFINER, search_path pinned', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') s, p.prosecdef d, coalesce(array_to_string(p.proacl, ','), '') acl,
                              EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c = 'search_path=""') sp
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($1)`, [G6B_WORKER_RPCS]);
    const bad = r.filter(x => x.a || x.n || !x.s || !x.d || !x.sp || /(^|,)=X/.test(x.acl));
    return (r.length === 8 && bad.length === 0) || 'found ' + r.length + ' bad: ' + bad.map(x => x.proname + ' ' + JSON.stringify(x)).join('; ');
  });
  await check('G6b public functions: exactly the 46 staff + 8 worker RPCs (no stray msg function)', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                         AND (p.proname LIKE '%msg%' OR p.proname = 'tx_messages') ORDER BY 1`);
    const exp = G6B_STAFF_RPCS.concat(G6B_WORKER_RPCS).sort();
    return JSON.stringify(r.map(x => x.proname).sort()) === JSON.stringify(exp) || 'got: ' + r.map(x => x.proname).join(',');
  });
  await check('G6b app.msg_* helpers: none executable by anon / authenticated except the 3 RLS helpers', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'
                          AND (p.proname LIKE 'msg\\_%' OR p.proname LIKE 'tg\\_msg\\_%')`);
    const bad = r.filter(x => x.n || (x.a && !G6B_RLS_HELPERS.includes(x.proname)));
    const helpers = r.filter(x => G6B_RLS_HELPERS.includes(x.proname) && x.a).length;
    return (r.length >= 20 && bad.length === 0 && helpers === 3) || 'helpers ' + r.length + ' rls ' + helpers + ' callable: ' + bad.map(x => x.proname).join(', ');
  });
  await check('G6b tables: RLS on, authenticated holds SELECT only, anon nothing, no column grant beyond SELECT', async () => {
    const all = G6B_TABLES.concat(['msg_mock_mailboxes']);
    const rls = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1) AND c.relrowsecurity`, [all]);
    const g = await q(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
                        WHERE grantee IN ('anon','authenticated') AND table_schema = 'public' AND table_name = ANY($1)`, [all]);
    const bad = g.filter(x => x.grantee === 'anon' || x.privilege_type !== 'SELECT' || x.table_name === 'msg_mock_mailboxes');
    const withSel = new Set(g.filter(x => x.privilege_type === 'SELECT').map(x => x.table_name));
    // G6b review fix: msg_channels / msg_messages / msg_threads hold fail-closed COLUMN-level SELECT grants (hidden fields)
    const colSel = await q(`SELECT DISTINCT table_name FROM information_schema.column_privileges WHERE grantee = 'authenticated'
                             AND table_schema = 'public' AND privilege_type = 'SELECT' AND table_name = ANY($1)`, [['msg_channels', 'msg_messages', 'msg_threads']]);
    for (const x of colSel) withSel.add(x.table_name);
    const c = await q(`SELECT table_name, column_name FROM information_schema.column_privileges WHERE grantee IN ('anon','authenticated')
                        AND table_schema = 'public' AND table_name = ANY($1) AND privilege_type <> 'SELECT'`, [all]);
    return (rls.length === all.length && bad.length === 0 && G6B_TABLES.every(t => withSel.has(t)) && c.length === 0)
      || JSON.stringify({ rls: rls.length, bad, missingSelect: G6B_TABLES.filter(t => !withSel.has(t)), c });
  });
  await check('G6b policies: SELECT only, to authenticated only, none on msg_mock_mailboxes, every table covered', async () => {
    const r = await q(`SELECT tablename, policyname, cmd, roles::text roles FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'msg\\_%'`);
    const bad = r.filter(x => x.cmd !== 'SELECT' || x.roles !== '{authenticated}' || x.tablename === 'msg_mock_mailboxes');
    const covered = new Set(r.map(x => x.tablename));
    const missing = G6B_TABLES.filter(t => !covered.has(t));
    return (bad.length === 0 && missing.length === 0) || 'bad: ' + bad.map(x => x.tablename + '.' + x.policyname).join(',') + ' missing: ' + missing.join(',');
  });
  await check('G6b policies never reference client membership (no my_client_ids / client_users branch)', async () => {
    const r = await q(`SELECT tablename, policyname FROM pg_policies WHERE schemaname IN ('public','storage')
                         AND (tablename LIKE 'msg\\_%' OR policyname = 'marsa_messages_read') AND (qual ~* 'my_client_ids|client_users|portal')`);
    return r.length === 0 || r.map(x => x.tablename + '.' + x.policyname).join(', ');
  });
  await check('G6b mutable tables carry the audit trigger; append-only logs and the mock mailbox do not', async () => {
    const r = await q(`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'trg_audit' AND c.relname LIKE 'msg\\_%' ORDER BY 1`);
    return r.map(x => x.relname).join(',') === [...G6B_AUDITED].sort().join(',') || 'audited: ' + r.map(x => x.relname).join(',');
  });
  await check('G6b tables hold no secret-like column (key / secret / token / password / credential)', async () => {
    const r = await q(`SELECT table_name || '.' || column_name c FROM information_schema.columns WHERE table_schema = 'public'
                         AND table_name LIKE 'msg\\_%' AND column_name ~* '(key|secret|token|password|passwd|credential|cookie)'
                         AND column_name NOT IN ('dedupe_key','instruction_key','template_key','idem_key','est_input_tokens','est_output_tokens')`);
    return r.length === 0 || r.map(x => x.c).join(', ');
  });
  await check('G6b dictionaries (status_labels msg_*) are never client-visible', async () => {
    const r = (await q(`SELECT count(*)::int n, count(*) FILTER (WHERE client_visible)::int v, count(DISTINCT domain)::int d
                          FROM public.status_labels WHERE domain LIKE 'msg\\_%'`))[0];
    return (r.n > 0 && r.v === 0 && r.d >= 19) || JSON.stringify(r);
  });
  await check('storage bucket "messages" is private with exactly one policy (SELECT, authenticated, marsa_messages_read)', async () => {
    const b = (await q(`SELECT public FROM storage.buckets WHERE id = 'messages'`))[0];
    const p = await q(`SELECT policyname, cmd, roles::text roles FROM pg_policies WHERE schemaname = 'storage' AND (qual ~ '''messages''' OR with_check ~ '''messages''')`);
    return (b && b.public === false && p.length === 1 && p[0].policyname === 'marsa_messages_read' && p[0].cmd === 'SELECT' && p[0].roles === '{authenticated}')
      || JSON.stringify({ b, p });
  });
  // fixture positive controls: the rows exist, each org reads its own and nothing of the other
  for (const t of G6B_TABLES) {
    await check(`G6b fixture: adminA reads its own org-A ${t}; adminB reads its own org-B ${t} and nothing of org A`, async () => {
      const a = (await as('adminA', `SELECT count(*)::int n FROM public.${t} WHERE org_id = $1`, [A]))[0].n;
      const own = (await as('adminB', `SELECT count(*)::int n FROM public.${t} WHERE org_id = $1`, [B]))[0].n;
      const other = (await as('adminB', `SELECT count(*)::int n FROM public.${t} WHERE org_id = $1`, [A]))[0].n;
      return (a > 0 && own > 0 && other === 0) || JSON.stringify({ a, own, other });
    });
    for (const who of ['clientA', 'clientA2', 'clientB']) {
      await check(`${who} reads 0 rows of ${t} (own org included)`, () => denied(who, `SELECT 1 FROM public.${t}`), `RLS ${t}: staff roles only, no client branch`);
    }
  }
  await check('G6b fixture: msg_mock_mailboxes holds a row per org (owner view)', async () =>
    (await q(`SELECT count(DISTINCT org_id)::int n FROM public.msg_mock_mailboxes WHERE org_id = ANY($1)`, [[A, B]]))[0].n === 2);
  for (const who of ['adminA', 'adminB', 'staffA', 'clientA']) {
    await expectErr(`${who} cannot SELECT msg_mock_mailboxes`, () => as(who, `SELECT 1 FROM public.msg_mock_mailboxes`), /permission denied/);
  }
  for (const who of ['adminA', 'staffA', 'clientA']) {
    await expectErr(`${who} cannot INSERT a thread directly`, () => as(who,
      `INSERT INTO public.msg_threads (org_id, channel_id, kind, subject) VALUES ($1, $2, 'email', 'x')`, [A, G6B.A.ch]), /permission denied|row-level security/);
    await expectErr(`${who} cannot UPDATE a reply directly`, () => as(who, `UPDATE public.msg_replies SET status = 'approved' WHERE id = $1 RETURNING 1`, [G6B.A.reply]), /permission denied/);
    await expectErr(`${who} cannot DELETE a message directly`, () => as(who, `DELETE FROM public.msg_messages WHERE id = $1 RETURNING 1`, [G6B.A.message]), /permission denied/);
  }
  await expectErr('owner UPDATE of msg_messages refused by the trigger (MRS_APPEND_ONLY)', () => q(`UPDATE public.msg_messages SET body_text = 'x' WHERE id = $1`, [G6B.A.message]), /MRS_APPEND_ONLY/);
  await expectErr('owner DELETE of msg_outbound refused (append-only facts)', () => q(`DELETE FROM public.msg_outbound WHERE id = $1`, [G6B.B.outbound]), /MRS_APPEND_ONLY/);
  // anon: no EXECUTE on any G6b RPC
  const g6bAnon = [
    ['get_msg_settings', `SELECT public.get_msg_settings('${A}')`], ['list_msg_channels', `SELECT public.list_msg_channels('${A}')`],
    ['list_msg_threads', `SELECT public.list_msg_threads('${A}', '{}')`], ['get_msg_thread', `SELECT public.get_msg_thread('${G6B.A.thread}')`],
    ['list_msg_contacts', `SELECT public.list_msg_contacts('${A}', '{}')`], ['tx_messages', `SELECT public.tx_messages('${TX3}')`],
    ['save_msg_reply', `SELECT public.save_msg_reply(NULL, '{}', NULL)`], ['send_msg_reply', `SELECT public.send_msg_reply('${G6B.A.reply}', NULL)`],
    ['decide_msg_reply', `SELECT public.decide_msg_reply('${G6B.A.reply}', gen_random_uuid(), 'approve', 'x', false)`],
    ['list_msg_templates', `SELECT public.list_msg_templates('${A}', '{}')`], ['save_msg_auto_reply_policy', `SELECT public.save_msg_auto_reply_policy('${A}', '{}')`],
    ['msg_ingest_messages', `SELECT public.msg_ingest_messages('${G6B.A.ch}', '[]')`], ['msg_claim_jobs', `SELECT public.msg_claim_jobs('anon', 1)`],
    ['msg_mock_load', `SELECT public.msg_mock_load('${G6B.A.ch}')`], ['app.msg_redact', `SELECT app.msg_redact('{}'::jsonb)`],
    ['app.msg_can_read_thread', `SELECT app.msg_can_read_thread('${G6B.A.thread}')`]
  ];
  for (const [fn, sql] of g6bAnon) await expectErr(`anon cannot call ${fn}`, () => as('anon', sql), /permission denied/);
  // clients (own org and other org) and org-B staff: every G6b reader on org A → MRS_FORBIDDEN / MRS_NOT_FOUND, never an empty success
  const g6bReaders = [
    ['get_msg_settings', `SELECT public.get_msg_settings($1)`, [A]], ['list_msg_channels', `SELECT public.list_msg_channels($1)`, [A]],
    ['list_msg_contacts', `SELECT public.list_msg_contacts($1, '{}')`, [A]], ['get_msg_contact', `SELECT public.get_msg_contact($1)`, [G6B.A.contact]],
    ['list_msg_threads', `SELECT public.list_msg_threads($1, '{}')`, [A]], ['get_msg_thread', `SELECT public.get_msg_thread($1)`, [G6B.A.thread]],
    ['msg_attachment_suggestions', `SELECT public.msg_attachment_suggestions($1)`, [G6B.A.reply]],
    ['list_msg_instructions', `SELECT public.list_msg_instructions($1, '{}')`, [A]], ['list_msg_templates', `SELECT public.list_msg_templates($1, '{}')`, [A]],
    ['list_msg_auto_reply_policies', `SELECT public.list_msg_auto_reply_policies($1)`, [A]], ['tx_messages', `SELECT public.tx_messages($1)`, [TX3]],
    ['list_msg_jobs', `SELECT public.list_msg_jobs($1, '{}')`, [A]], ['msg_retention_preview', `SELECT public.msg_retention_preview($1)`, [A]],
    ['msg_ai_usage', `SELECT public.msg_ai_usage($1, '{}')`, [A]]
  ];
  for (const [fn, sql, params] of g6bReaders) {
    for (const who of ['clientA', 'clientA2', 'clientB', 'staffB', 'adminB']) {
      await expectErr(`${who} gets no result from ${fn} (org A)`, () => as(who, sql, params), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
    }
  }
  await expectErr('clientB gets no result from list_msg_threads(own org B)', () => as('clientB', `SELECT public.list_msg_threads($1, '{}')`, [B]), /MRS_FORBIDDEN/);
  await expectErr('clientB gets no result from tx_messages(own tx)', () => as('clientB', `SELECT public.tx_messages($1)`, [B_TX]), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
  for (const [fn, sql, params] of [
    ['save_msg_channel', `SELECT public.save_msg_channel($1, $2, NULL)`, [A, { kind: 'email', name: 'x', address: 'evil@rls.example' }]],
    ['save_msg_contact', `SELECT public.save_msg_contact($1, $2, NULL)`, [A, { display_name: 'x', entity_type: 'other' }]],
    ['update_msg_thread', `SELECT public.update_msg_thread($1, '{"priority":"low"}')`, [G6B.A.thread]],
    ['link_msg_thread', `SELECT public.link_msg_thread($1, $2, 'x')`, [G6B.A.thread, TX1]],
    ['save_msg_reply', `SELECT public.save_msg_reply($1, '{"body_text":"x"}', NULL)`, [G6B.A.reply]],
    ['decide_msg_reply', `SELECT public.decide_msg_reply($1, gen_random_uuid(), 'reject', 'x', false)`, [G6B.A.reply]],
    ['send_msg_reply', `SELECT public.send_msg_reply($1, NULL)`, [G6B.A.reply]],
    ['retry_msg_send', `SELECT public.retry_msg_send($1)`, [G6B.A.outbound]],
    ['grant_msg_authorization', `SELECT public.grant_msg_authorization($1, '{"scope_type":"client"}', 'x')`, [G6B.A.contact]],
    ['save_msg_settings', `SELECT public.save_msg_settings($1, '{"retention_days":90}')`, [A]],
    ['seed_msg_templates', `SELECT public.seed_msg_templates($1)`, [A]]
  ]) {
    for (const who of ['clientA', 'staffB', 'adminB']) {
      await expectErr(`${who} cannot call ${fn} on org A`, () => as(who, sql, params), /MRS_FORBIDDEN|MRS_NOT_FOUND|MRS_INVALID/);
    }
  }
  const g6bWorker = [
    ['msg_ingest_messages', `SELECT public.msg_ingest_messages($1, '[]')`, [G6B.A.ch]],
    ['msg_record_delivery', `SELECT public.msg_record_delivery($1, '[]')`, [G6B.A.ch]],
    ['msg_claim_jobs', `SELECT public.msg_claim_jobs('evil', 5)`, []],
    ['msg_complete_job', `SELECT public.msg_complete_job(gen_random_uuid(), '{"outcome":"ok"}')`, []],
    ['msg_renew_lease', `SELECT public.msg_renew_lease(gen_random_uuid())`, []],
    ['msg_schedule', `SELECT public.msg_schedule(5)`, []],
    ['msg_mock_load', `SELECT public.msg_mock_load($1)`, [G6B.A.ch]],
    ['msg_mock_save', `SELECT public.msg_mock_save($1, '{}', 1)`, [G6B.A.ch]]
  ];
  for (const [fn, sql, params] of g6bWorker) {
    for (const who of ['adminA', 'adminB', 'staffA', 'clientA']) {
      await expectErr(`${who} cannot execute worker RPC ${fn}`, () => as(who, sql, params), /permission denied/);
    }
  }
  await check('worker identity cannot use G6b staff RPCs: service_role → MRS_AUTH_REQUIRED (no user)', async () => {
    for (const [fn, sql, params] of [['list_msg_threads', `SELECT public.list_msg_threads($1, '{}')`, [A]],
      ['send_msg_reply', `SELECT public.send_msg_reply($1, NULL)`, [G6B.A.reply]],
      ['decide_msg_reply', `SELECT public.decide_msg_reply($1, gen_random_uuid(), 'approve', 'x', false)`, [G6B.A.reply]]]) {
      try { await as('service', sql, params); return fn + ' answered for service_role'; }
      catch (e) { if (!/MRS_AUTH_REQUIRED/.test(errText(e))) return fn + ': ' + errText(e); }
    }
    return true;
  });
  // branch separation (G6b-7): the org-A thread is linked to TX3 (JED) → JED staff read it, DMM staff read nothing of it
  await check('branch scope: the linked org-A thread sits on the transaction branch (JED)', async () =>
    (await q(`SELECT branch_id::text b FROM public.msg_threads WHERE id = $1`, [G6B.A.thread]))[0].b === JED);
  for (const t of G6B_THREAD_TABLES) {
    await check(`branch scope: clrJED (JED) reads org-A ${t}; clrDMM (DMM) reads 0 rows`, async () => {
      const j = (await as('clrJED', `SELECT count(*)::int n FROM public.${t} WHERE org_id = $1`, [A]))[0].n;
      const d = (await as('clrDMM', `SELECT count(*)::int n FROM public.${t} WHERE org_id = $1`, [A]))[0].n;
      return (j > 0 && d === 0) || JSON.stringify({ j, d });
    });
  }
  await check('branch scope: clrDMM gets MRS_NOT_FOUND from get_msg_thread / tx_messages(TX3) and an empty list_msg_threads', async () => {
    const e1 = await (async () => { try { await as('clrDMM', `SELECT public.get_msg_thread($1)`, [G6B.A.thread]); return 'answered'; } catch (e) { return errText(e); } })();
    const e2 = await (async () => { try { await as('clrDMM', `SELECT public.tx_messages($1)`, [TX3]); return 'answered'; } catch (e) { return errText(e); } })();
    const l = (await as('clrDMM', `SELECT public.list_msg_threads($1, '{}') r`, [A]))[0].r;
    const lj = (await as('clrJED', `SELECT public.list_msg_threads($1, '{}') r`, [A]))[0].r;
    return (/MRS_NOT_FOUND/.test(e1) && /MRS_NOT_FOUND/.test(e2) && l.total === 0 && lj.total >= 1) || JSON.stringify({ e1, e2, l: l.total, lj: lj.total });
  });
  await check('branch scope: clrJED reads tx_messages(TX3) with the linked thread', async () => {
    const r = (await as('clrJED', `SELECT public.tx_messages($1) r`, [TX3]))[0].r;
    return (r.threads.length === 1 && r.threads[0].id === G6B.A.thread) || JSON.stringify(r);
  });
  await check('messages bucket: the attachment object is visible to clrJED only — not clrDMM, org-B staff, clients or anon', async () => {
    const sql = `SELECT name FROM storage.objects WHERE bucket_id = 'messages' AND name = $1`;
    const j = (await as('clrJED', sql, [G6B.A.storagePath])).length;
    for (const who of ['clrDMM', 'staffB', 'adminB', 'clientA', 'clientA2', 'clientB', 'anon']) {
      const d = await denied(who, sql, [G6B.A.storagePath]);
      if (d !== true) return who + ': ' + d;
    }
    return j === 1 || 'clrJED sees ' + j;
  });
  for (const who of ['adminA', 'staffA', 'clientA']) {
    await expectErr(`${who} cannot upload into the messages bucket`, () => as(who, `INSERT INTO storage.objects (bucket_id, name) VALUES ('messages', $1)`,
      [`${A}/${G6B.A.ch}/x/y/z.pdf`]), /row-level security|permission denied/);
  }
  // privacy: events / audit / attempts carry no body, subject or address; clients never see message events
  await check('message events: internal, no body / subject / address / file name in the payload; clients see none', async () => {
    const n = (await q(`SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'message'`))[0].n;
    if (n === 0) return 'no message event in the fixture — vacuous';
    const leak = (await q(`SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'message'
                            AND (visible_to_client OR payload::text ~ 'RLS-BODY|RLS-SUBJECT|@sender-|rls-[ab]\\.pdf|inbox@rls-')`))[0].n;
    if (leak) return leak + ' leaking message events';
    for (const who of ['clientA', 'clientA2', 'clientB']) {
      const d = await denied(who, `SELECT 1 FROM public.transaction_events WHERE event_type = 'message'`);
      if (d !== true) return who + ': ' + d;
    }
    return true;
  });
  await check('audit_log holds no message body; clients see no G6b audit row', async () => {
    const n = (await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = ANY($1)`, [G6B_AUDITED]))[0].n;
    if (n === 0) return 'no G6b audit row — vacuous';
    const body = (await q(`SELECT count(*)::int n FROM public.audit_log WHERE coalesce(old_data::text, '') || coalesce(new_data::text, '') ~ 'RLS-BODY'`))[0].n;
    const logs = (await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name IN ('msg_messages','msg_job_attempts','msg_mock_mailboxes','msg_reply_versions')`))[0].n;
    if (body || logs) return JSON.stringify({ body, logs });
    for (const who of ['clientA', 'clientB']) {
      const d = await denied(who, `SELECT 1 FROM public.audit_log WHERE table_name = ANY($1)`, [G6B_AUDITED]);
      if (d !== true) return who + ': ' + d;
    }
    return true;
  });
  await check('logged worker calls kept no password and no message body (masked to {chars, sha256})', async () => {
    const r = (await q(`SELECT string_agg(calls::text, ' ') c FROM public.msg_job_attempts WHERE org_id = ANY($1)`, [[A, B]]))[0].c || '';
    return (r.length > 0 && !/NEVER-STORED|RLS-BODY|شكرًا، تم استلام/.test(r)) || r.slice(0, 400);
  });
  await check('auto-reply policies: all disabled; enabling refused (RPC and CHECK)', async () => {
    const on = (await q(`SELECT count(*)::int n FROM public.msg_auto_reply_policies WHERE enabled`))[0].n;
    const e1 = await (async () => { try { await as('adminA', `SELECT public.save_msg_auto_reply_policy($1, '{"kind":"ack_receipt","enabled":true}')`, [A]); return 'ok'; } catch (e) { return errText(e); } })();
    const e2 = await (async () => { try { await q(`UPDATE public.msg_auto_reply_policies SET enabled = true WHERE org_id = $1`, [A]); return 'ok'; } catch (e) { return errText(e); } })();
    return (on === 0 && /auto_reply_disabled_v1/.test(e1) && /check|violates/i.test(e2)) || JSON.stringify({ on, e1, e2 });
  });
  await check('every accepted / delivered outbound has an approval by another user than the author / submitter (four-eyes)', async () => {
    const r = await q(`SELECT o.id FROM public.msg_outbound o JOIN public.msg_replies r ON r.id = o.reply_id
                         WHERE o.state IN ('accepted','delivered','read') AND NOT EXISTS (
                           SELECT 1 FROM public.msg_reply_approvals a JOIN public.msg_reply_versions v ON v.id = a.version_id
                            WHERE a.version_id = o.reply_version_id AND a.decision = 'approve' AND a.actor <> coalesce(v.author_id, v.requested_by)
                              AND a.actor <> r.submitted_by)`);
    const n = (await q(`SELECT count(*)::int n FROM public.msg_outbound WHERE state IN ('accepted','delivered','read')`))[0].n;
    return (n === 2 && r.length === 0) || JSON.stringify({ n, bad: r });
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
