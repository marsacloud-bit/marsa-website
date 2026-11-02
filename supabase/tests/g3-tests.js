#!/usr/bin/env node
/*
  Marsa (مرسى) — G3 registry / operations test suite (docs/online/G3_SPEC.md).  LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql
  Org A = seed "blue-sea" (branches JED, DMM). Org B = "org-b" (inserted as owner).
  Users:
    adminA  admin A                 staffA  clearance_staff A (all branches)   accA   accountant A (all branches)
    opsJ    operations_manager JED  clrJ    clearance_staff JED                trJ    transport_staff JED
    trD     transport_staff DMM     clientA client 101 (TX1, TX4)              clientA2 client 102 (TX2, TX5)
    staffB  clearance_staff B       adminB  admin B                            clientB client of org B
  Transactions: TX1 (seed, JED, client 101, decl TEST-DEC-0001, B/L TESTBL0000001, 2 containers)
                TX2 (seed, DMM, client 102, B/L TESTBL0000002)   TX3 (seed, JED, client 103, air, empty)
                TX4 (JED, client 101, sea, 1 container)          TX5 (DMM, client 102, sea)

  Structure: one async function per section, run in order by the runner at the bottom (SECTIONS).
  Migration A (20261103000100) owns the sections for spec items 1–6. Migration B appends its
  sections to SECTIONS (state built by earlier sections is shared through module variables).

  Prints PASS / FAIL per case; exit code 1 on any FAIL.
  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g3-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_A = '20261103000100_g3_registry.sql';

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
const TX5 = '0b5e0000-0000-4000-8000-000000000205';
const TX_LAND = '0b5e0000-0000-4000-8000-000000000209';   // land import (completeness ready_for regression)
const B = 'bbbb0000-0000-4000-8000-000000000001';
const B_BR = 'bbbb0000-0000-4000-8000-000000000011';
const B_CL = 'bbbb0000-0000-4000-8000-000000000101';
const B_TX = 'bbbb0000-0000-4000-8000-000000000201';
const B_CT = 'bbbb0000-0000-4000-8000-000000000301';

const U = {
  adminA: 'abc30000-0000-4000-8000-000000000001',
  staffA: 'abc30000-0000-4000-8000-000000000002',
  accA: 'abc30000-0000-4000-8000-000000000003',
  opsJ: 'abc30000-0000-4000-8000-000000000004',
  clrJ: 'abc30000-0000-4000-8000-000000000005',
  trJ: 'abc30000-0000-4000-8000-000000000006',
  trD: 'abc30000-0000-4000-8000-000000000007',
  clientA: 'abc30000-0000-4000-8000-000000000008',
  clientA2: 'abc30000-0000-4000-8000-000000000009',
  staffB: 'abc30000-0000-4000-8000-00000000000a',
  adminB: 'abc30000-0000-4000-8000-00000000000b',
  clientB: 'abc30000-0000-4000-8000-00000000000c'
};
const EMAIL = k => k.toLowerCase() + '@g3.example.com';
let keySeq = 0;
const newKey = () => `0e3e0000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;
const hex = c => c.repeat(64);
let docSeq = 0;

/* ------------------------------------------------------------------ helpers (same style as rls-tests.js) */
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
const errText = e => (e && (e.message + ' ' + (e.detail || ''))) || String(e);
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
// a document row registered as owner (classification set directly, like a reviewed upload)
async function ownerDoc(org, tx, kind, classification, status) {
  const id = `d0c30000-0000-4000-8000-${(++docSeq).toString(16).padStart(12, '0')}`;
  await q(`INSERT INTO public.documents (id, org_id, transaction_id, kind, classification, classification_status, storage_path,
             sha256, original_name, size_bytes, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'f.pdf', 100, $9)`,
    [id, org, tx, kind, classification || null, status || 'unreviewed', `${org}/${tx}/${id}/f.pdf`,
     hex((docSeq % 10).toString()).slice(0, 56) + String(docSeq).padStart(8, '0'), U.staffA]);
  return id;
}
const txRow = id => one(`SELECT * FROM public.transactions WHERE id = $1`, [id]);
const blOf = num => one(`SELECT * FROM public.bills_of_lading WHERE org_id = $1 AND bl_number = $2 ORDER BY created_at LIMIT 1`, [A, num]);

/* ------------------------------------------------------------------ fixtures */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${EMAIL(k)}', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.organizations (id, slug, name_ar) VALUES ('${B}', 'org-b', 'مؤسسة ب التجريبية');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع الرياض ب');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone, vat_number) VALUES
      ('${B_CL}', '${B}', 'business', 'شركة الاختبار الأولى للتجارة', '0509999999', '300000000000003');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, bl_number, declaration_no) VALUES
      ('${B_TX}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea', 'BBL0001', 'B-DEC-0001');
    INSERT INTO public.containers (id, org_id, transaction_id, container_no) VALUES ('${B_CT}', '${B}', '${B_TX}', 'TSTU0000001');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, container_count, goods_description) VALUES
      ('${TX4}', '${A}', '${JED}', '${CL101}', 'import', 'sea', 1, 'بضاعة اختبار'),
      ('${TX5}', '${A}', '${DMM}', '${CL102}', 'import', 'sea', 0, NULL);
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'),
      ('${U.staffA}', '${A}', NULL, 'clearance_staff'),
      ('${U.accA}',   '${A}', NULL, 'accountant'),
      ('${U.opsJ}',   '${A}', '${JED}', 'operations_manager'),
      ('${U.clrJ}',   '${A}', '${JED}', 'clearance_staff'),
      ('${U.trJ}',    '${A}', '${JED}', 'transport_staff'),
      ('${U.trD}',    '${A}', '${DMM}', 'transport_staff'),
      ('${U.clientA}', '${A}', NULL, 'client'),
      ('${U.clientA2}', '${A}', NULL, 'client'),
      ('${U.staffB}', '${B}', NULL, 'clearance_staff'),
      ('${U.adminB}', '${B}', NULL, 'admin'),
      ('${U.clientB}', '${B}', NULL, 'client');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES
      ('${A}', '${CL101}', '${U.clientA}', 'owner'), ('${A}', '${CL102}', '${U.clientA2}', 'owner'),
      ('${B}', '${B_CL}', '${U.clientB}', 'owner');
  `);
}

/* ------------------------------------------------------------------ shared state between sections */
const S = {};

/* ================================================================== sections: migration A (items 1–6) */
async function secCatalog() {
  section('catalog: versions, RLS, grants, function privileges');
  await check('schema_versions has 20261103000100 g3_registry', async () =>
    (await count(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261103000100' AND name = 'g3_registry'`)) === 1);
  const TABLES = ['parties', 'drivers', 'trucks', 'client_aliases', 'customs_declarations', 'bills_of_lading', 'transaction_bls'];
  for (const t of TABLES) {
    await check(`${t}: RLS on, audit trigger, no anon privilege`, async () => {
      const r = await one(`SELECT c.relrowsecurity rls,
                                  EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'trg_audit') audit,
                                  (SELECT count(*)::int FROM information_schema.role_table_grants x
                                    WHERE x.grantee = 'anon' AND x.table_schema = 'public' AND x.table_name = c.relname) anon
                             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relname = $1`, [t]);
      return (r && r.rls && r.audit && r.anon === 0) || JSON.stringify(r);
    });
  }
  await check('internal columns hidden from the API SELECT grant (declaration notes / cancel_reason, B/L notes)', async () => {
    const r = await one(`SELECT has_column_privilege('authenticated', 'public.customs_declarations', 'notes', 'SELECT') a,
                                has_column_privilege('authenticated', 'public.customs_declarations', 'cancel_reason', 'SELECT') b,
                                has_column_privilege('authenticated', 'public.customs_declarations', 'declaration_no', 'SELECT') c,
                                has_column_privilege('authenticated', 'public.bills_of_lading', 'notes', 'SELECT') d,
                                has_column_privilege('authenticated', 'public.bills_of_lading', 'bl_number', 'SELECT') e`);
    return (!r.a && !r.b && r.c && !r.d && r.e) || JSON.stringify(r);
  });
  await check('declarations / B/Ls / links: no INSERT/UPDATE/DELETE grant (RPC only)', async () => {
    const r = await q(`SELECT table_name, privilege_type FROM information_schema.role_table_grants
                        WHERE grantee = 'authenticated' AND table_schema = 'public'
                          AND table_name IN ('customs_declarations','bills_of_lading','transaction_bls') AND privilege_type <> 'SELECT'`);
    return r.length === 0 || r.map(x => x.table_name + ':' + x.privilege_type).join(', ');
  });
  const RPCS = ['match_client(uuid,jsonb)', 'add_declaration(uuid,jsonb,uuid)', 'set_declaration_status(uuid,text,text)',
    'cancel_declaration(uuid,text,jsonb)', 'correct_declaration(uuid,jsonb,text)', 'save_bl(jsonb,uuid)',
    'link_bl(uuid,uuid,boolean)', 'unlink_bl(uuid,uuid,text)', 'container_history(uuid,text)',
    'transaction_completeness(uuid)', 'staff_internal_fields(text,uuid[])'];
  for (const fn of RPCS) {
    await check(`public.${fn}: SECURITY DEFINER, search_path pinned, authenticated yes, anon no`, async () => {
      const r = await one(`SELECT p.prosecdef d, coalesce(array_to_string(p.proconfig, ','), '') c,
                                  has_function_privilege('authenticated', p.oid, 'EXECUTE') x,
                                  has_function_privilege('anon', p.oid, 'EXECUTE') an
                             FROM pg_proc p WHERE p.oid = $1::regprocedure`, ['public.' + fn]);
      return (r.d && /search_path=/.test(r.c) && r.x && !r.an) || JSON.stringify(r);
    });
  }
  await check('exactly one overload per new RPC name', async () => {
    const r = await q(`SELECT p.proname, count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = ANY ($1) GROUP BY 1 HAVING count(*) > 1`,
      [RPCS.map(x => x.split('(')[0])]);
    return r.length === 0 || JSON.stringify(r);
  });
  await check('authenticated cannot execute state-changing SECURITY DEFINER helpers in app', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND p.prosecdef AND p.provolatile = 'v' AND p.proname <> 'next_ref_checked'
                          AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`);
    return r.length === 0 || 'callable: ' + r.map(x => x.proname).join(', ');
  });
  await check('every SECURITY DEFINER function pins search_path', async () => {
    const r = await q(`SELECT n.nspname || '.' || p.proname f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname IN ('public','app') AND p.prosecdef
                          AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`);
    return r.length === 0 || r.map(x => x.f).join(', ');
  });
  await check('transaction_events accepts the G3 event types (declaration, bl, container + reserved for B)', async () => {
    const d = (await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'transaction_events_event_type_check'`)).d;
    return ['declaration', 'bl', 'container', 'appointment', 'trip', 'exception', 'docs_override', 'note', 'created']
      .every(x => d.includes(`'${x}'`)) || d;
  });
  await check('status_labels: G3 dictionaries present (declaration_status, bl_type, container_state, party_kind)', async () => {
    const r = await q(`SELECT domain, count(*)::int n FROM public.status_labels
                        WHERE domain IN ('declaration_status','bl_type','container_state','party_kind','alias_source','client_match')
                        GROUP BY 1 ORDER BY 1`);
    const m = Object.fromEntries(r.map(x => [x.domain, x.n]));
    return (m.declaration_status === 6 && m.bl_type === 5 && m.container_state === 6 && m.party_kind === 7
      && m.alias_source === 4 && m.client_match === 3) || JSON.stringify(m);
  });
  await expectErr('anon cannot call match_client', () => as('anon', `SELECT public.match_client($1, '{"name":"x"}')`, [A]), /permission denied/);
  await expectErr('anon cannot call add_declaration', () => as('anon', `SELECT public.add_declaration($1, '{"declaration_no":"X"}')`, [TX3]), /permission denied/);
}

async function secBackfill() {
  section('backfill / legacy adoption of seed values');
  await check('TX1: seed declaration_no became one active declaration (submitted, manual), mirror unchanged', async () => {
    const r = await q(`SELECT declaration_no, status, source FROM public.customs_declarations WHERE transaction_id = $1`, [TX1]);
    const t = await txRow(TX1);
    return (r.length === 1 && r[0].declaration_no === 'TEST-DEC-0001' && r[0].status === 'submitted' && r[0].source === 'manual'
      && t.declaration_no === 'TEST-DEC-0001') || JSON.stringify({ r, t: t.declaration_no });
  });
  await check('TX1 / TX2 / org B: seed bl_number became a primary B/L link with the same number', async () => {
    const r = await q(`SELECT t.id, t.bl_number tx_bl, b.bl_number, b.bl_type, tb.is_primary
                         FROM public.transactions t JOIN public.transaction_bls tb ON tb.transaction_id = t.id
                         JOIN public.bills_of_lading b ON b.id = tb.bl_id WHERE t.id = ANY ($1) ORDER BY t.id`, [[TX1, TX2, B_TX]]);
    return (r.length === 3 && r.every(x => x.is_primary && x.tx_bl === x.bl_number && x.bl_type === 'other')) || JSON.stringify(r);
  });
  await check('legacy adoption emitted declaration + bl events (internal, not client-visible)', async () => {
    const r = await q(`SELECT event_type, visible_to_client v, payload->>'via' via FROM public.transaction_events
                        WHERE transaction_id = $1 AND event_type IN ('declaration','bl')`, [TX1]);
    return (r.length === 2 && r.every(x => !x.v && x.via === 'transaction_edit')) || JSON.stringify(r);
  });
  await check('every container has visit_ref = <container_no>@<transaction ref>', async () =>
    (await count(`SELECT count(*)::int n FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
                   WHERE c.visit_ref IS DISTINCT FROM c.container_no || '@' || t.ref`)) === 0);
  await check('seed containers start in operational_state expected', async () =>
    (await count(`SELECT count(*)::int n FROM public.containers WHERE transaction_id IN ($1, $2) AND operational_state <> 'expected'`, [TX1, TX2])) === 0);
  await check('re-running the migration file changes nothing (no duplicate declarations / B/Ls / links / events)', async () => {
    const snap = async () => (await q(`SELECT (SELECT count(*) FROM public.customs_declarations)::int d,
                                              (SELECT count(*) FROM public.bills_of_lading)::int b,
                                              (SELECT count(*) FROM public.transaction_bls)::int l,
                                              (SELECT count(*) FROM public.transaction_events)::int e`))[0];
    const before = await snap();
    if (!await runFile(path.join(SUPA, 'migrations', MIG_A))) return 'reload failed';
    const after = await snap();
    return JSON.stringify(before) === JSON.stringify(after) || JSON.stringify({ before, after });
  });
}

async function secParties() {
  section('parties / drivers / trucks (item 1)');
  await check('transport_staff adds a party: kinds de-duplicated, phone normalized, created_by stamped', async () => {
    const r = (await as('trJ', `INSERT INTO public.parties (org_id, kinds, name_ar, phone, created_by)
                                 VALUES ($1, ARRAY['yard','carrier','carrier'], 'ناقل الاختبار', '٠٥٥ 123-4567', $2)
                                 RETURNING id, kinds, phone, created_by`, [A, U.adminA]))[0];
    S.carrier = r.id;
    return (JSON.stringify(r.kinds) === '["carrier","yard"]' && r.phone === '0551234567' && r.created_by === U.trJ) || JSON.stringify(r);
  });
  await check('parties insert leaves an audit row', async () =>
    (await count(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'parties' AND row_id = $1 AND action = 'INSERT'`, [S.carrier])) === 1);
  S.yard = (await as('staffA', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['yard'], 'ساحة الاختبار') RETURNING id`, [A]))[0].id;
  S.agent = (await as('staffA', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['shipping_agent'], 'وكيل ملاحي تجريبي') RETURNING id`, [A]))[0].id;
  await expectErr('accountant cannot add a party (not a transport writer)', () => as('accA',
    `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier'], 'دخيل')`, [A]), /row-level security/);
  await check('accountant (staff) can read the directory', async () =>
    (await as('accA', `SELECT count(*)::int n FROM public.parties WHERE org_id = $1`, [A]))[0].n === 3);
  await check('client cannot read parties / drivers / trucks', async () => {
    for (const t of ['parties', 'drivers', 'trucks']) {
      const r = await denied('clientA', `SELECT 1 FROM public.${t}`);
      if (r !== true) return t + ': ' + r;
    }
    return true;
  });
  await as('staffA', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier'], 'Gulf Lines')`, [A]);
  await expectErr('party name unique per org, case-insensitive', () => as('staffA',
    `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier'], 'GULF LINES')`, [A]), /parties_org_name_uidx|duplicate/);
  await check('same party name allowed in another org', async () => {
    await as('staffB', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier'], 'Gulf Lines')`, [B]);
    return true;
  });
  await expectErr('unknown party kind refused', () => as('staffA',
    `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['bank'], 'جهة غير معروفة')`, [A]), /check constraint|violates/);
  await expectErr('empty kinds refused', () => as('staffA',
    `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, '{}', 'جهة بلا نوع')`, [A]), /check constraint|violates/);
  await expectErr('a driver\'s carrier must be a party of kind carrier', () => as('trJ',
    `INSERT INTO public.drivers (org_id, carrier_id, full_name) VALUES ($1, $2, 'سائق')`, [A, S.yard]), /MRS_INVALID.*carrier_id/);
  await check('driver under a carrier: only the last 4 ID digits are kept', async () => {
    const r = (await as('trJ', `INSERT INTO public.drivers (org_id, carrier_id, full_name, phone, national_id_last4, license_no)
                                 VALUES ($1, $2, 'سائق تجريبي', '0550001111', '٤٣٢١', 'L-1') RETURNING id, national_id_last4`, [A, S.carrier]))[0];
    S.driver = r.id;
    return r.national_id_last4 === '4321' || JSON.stringify(r);
  });
  await expectErr('a full national ID is refused', () => as('trJ',
    `INSERT INTO public.drivers (org_id, full_name, national_id_last4) VALUES ($1, 'سائق ٢', '1012345678')`, [A]), /check constraint|violates/);
  await check('truck plate normalized (spaces / dashes / case)', async () => {
    const r = (await as('trJ', `INSERT INTO public.trucks (org_id, carrier_id, plate_no, plate_type) VALUES ($1, $2, 'abc 1234', 'نقل')
                                 RETURNING id, plate_no`, [A, S.carrier]))[0];
    S.truck = r.id;
    return r.plate_no === 'ABC1234' || r.plate_no;
  });
  await expectErr('truck plate unique per org', () => as('trD',
    `INSERT INTO public.trucks (org_id, plate_no) VALUES ($1, 'ABC-1234')`, [A]), /trucks_org_plate_uniq|duplicate/);
  await expectErr('org B cannot attach a driver to an org A carrier', () => as('staffB',
    `INSERT INTO public.drivers (org_id, carrier_id, full_name) VALUES ($1, $2, 'سائق ب')`, [B, S.carrier]), /MRS_INVALID|foreign key|violates/);
  await expectErr('no DELETE on parties (deactivate instead)', () => as('staffA', `DELETE FROM public.parties WHERE id = $1`, [S.yard]), /permission denied/);
  await expectErr('party org_id is immutable', () => as('staffA', `UPDATE public.parties SET org_id = $2 WHERE id = $1`, [S.yard, B]), /MRS_IMMUTABLE|row-level security/);
  await check('party can be deactivated by a transport writer', async () =>
    (await as('trD', `UPDATE public.parties SET is_active = false WHERE id = $1 RETURNING is_active`, [S.yard]))[0].is_active === false);
}

async function secAliases() {
  section('client aliases + name normalization (item 2)');
  for (const [inp, out] of [
    ['شركة الإختبار الأولى للتجارة', 'الاختبار الاولي للتجاره'],
    ['Test Trading Co., Ltd.', 'test trading'],
    ['مؤسسة  التجربة، الثانية', 'التجربه الثانيه'],
    ['Blue-Sea LLC (٢٠٢٦)', 'blue sea 2026'],
    ['  شـــركة   آل  إبراهيم  ', 'ال ابراهيم']]) {
    await check(`app.norm_name(${JSON.stringify(inp)}) = ${JSON.stringify(out)}`, async () => {
      const r = (await q(`SELECT app.norm_name($1) v`, [inp]))[0].v;
      return r === out || JSON.stringify(r);
    });
  }
  await check('ops writer adds an alias; alias_norm is computed server-side (client value ignored)', async () => {
    const r = (await as('staffA', `INSERT INTO public.client_aliases (org_id, client_id, alias, alias_norm, source)
                                    VALUES ($1, $2, 'TTO Import Est.', 'forged', 'bl') RETURNING id, alias_norm, created_by`, [A, CL101]))[0];
    S.alias = r.id;
    return (r.alias_norm === 'tto import' && r.created_by === U.staffA) || JSON.stringify(r);
  });
  await expectErr('the same normalized alias cannot point at a second client', () => as('staffA',
    `INSERT INTO public.client_aliases (org_id, client_id, alias, source) VALUES ($1, $2, 'TTO  import, EST', 'manual')`, [A, CL102]), /MRS_INVALID.*alias_taken/);
  await expectErr('alias of punctuation only refused', () => as('staffA',
    `INSERT INTO public.client_aliases (org_id, client_id, alias) VALUES ($1, $2, '--')`, [A, CL102]), /MRS_INVALID.*alias|check constraint/);
  await expectErr('accountant cannot add aliases', () => as('accA',
    `INSERT INTO public.client_aliases (org_id, client_id, alias) VALUES ($1, $2, 'اسم بديل')`, [A, CL102]), /row-level security/);
  await expectErr('aliases are not updatable (remove + add)', () => as('staffA',
    `UPDATE public.client_aliases SET alias = 'x' WHERE id = $1`, [S.alias]), /permission denied/);
  await check('client cannot read aliases', () => denied('clientA', `SELECT 1 FROM public.client_aliases`));
  await expectErr('org B cannot alias an org A client (composite FK / RLS)', () => as('staffB',
    `INSERT INTO public.client_aliases (org_id, client_id, alias) VALUES ($1, $2, 'دخيل')`, [B, CL101]), /foreign key|row-level security|violates/);
  await check('remove alias (DELETE) works for ops writers and is audited', async () => {
    const tmp = (await as('staffA', `INSERT INTO public.client_aliases (org_id, client_id, alias) VALUES ($1, $2, 'مؤقت للحذف') RETURNING id`, [A, CL102]))[0].id;
    const d = await as('clrJ', `DELETE FROM public.client_aliases WHERE id = $1 RETURNING id`, [tmp]);
    const a = await count(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'client_aliases' AND row_id = $1 AND action = 'DELETE'`, [tmp]);
    return (d.length === 1 && a === 1) || JSON.stringify({ d, a });
  });
}

async function secMatchClient() {
  section('match_client: ranked candidates, never links (item 2)');
  const mc = (who, p) => rpc(who, `SELECT public.match_client($1, $2) r`, [A, p]);
  const snapshot = async () => (await q(`SELECT (SELECT count(*) FROM public.client_users)::int cu,
      (SELECT count(*) FROM public.clients)::int c, (SELECT count(*) FROM public.client_aliases)::int a,
      (SELECT count(*) FROM public.transactions)::int t,
      (SELECT count(*) FROM public.service_requests WHERE client_id IS NOT NULL)::int r,
      (SELECT count(*) FROM public.audit_log)::int au`))[0];
  const before = await snapshot();
  await check('exact VAT → strong, first, reason vat_number', async () => {
    const r = await mc('staffA', { vat_number: '300000000000003' });
    const c = r.candidates[0];
    return (c && c.client_id === CL101 && c.match === 'strong' && c.reasons.includes('vat_number') && r.linked === false) || JSON.stringify(r);
  });
  await check('exact CR (Arabic-Indic digits) → strong', async () => {
    const r = await mc('clrJ', { cr_number: '٧٠٠٠٠٠٠٠٠٢' });
    return (r.candidates[0] && r.candidates[0].client_id === CL102 && r.candidates[0].match === 'strong') || JSON.stringify(r);
  });
  await check('alias (normalized) → alias, reason alias', async () => {
    const r = await mc('staffA', { name: 'tto  import EST' });
    const c = r.candidates[0];
    return (c && c.client_id === CL101 && c.match === 'alias' && c.reasons.includes('alias')) || JSON.stringify(r);
  });
  await check('normalized client name → alias, reason name', async () => {
    const r = await mc('staffA', { name: 'شركة الإختبار الاولى للتجاره' });
    const c = r.candidates[0];
    return (c && c.client_id === CL101 && c.match === 'alias' && c.reasons.includes('name')) || JSON.stringify(r);
  });
  await check('token similarity → weak with score and reason similar_name', async () => {
    const r = await mc('staffA', { name: 'التجربة' });
    const c = r.candidates.find(x => x.client_id === CL102);
    return (c && c.match === 'weak' && c.score > 0 && c.reasons.includes('similar_name') && r.conflict === false) || JSON.stringify(r);
  });
  await check('VAT of one client + CR of another → conflict, both strong, differing numbers flagged', async () => {
    const r = await mc('staffA', { vat_number: '300000000000003', cr_number: '7000000002' });
    const ids = r.candidates.filter(x => x.match === 'strong').map(x => x.client_id).sort();
    const c1 = r.candidates.find(x => x.client_id === CL101);
    return (r.conflict === true && JSON.stringify(ids) === JSON.stringify([CL101, CL102].sort()) && c1.reasons.includes('cr_differs'))
      || JSON.stringify(r);
  });
  await check('ranking: strong before alias before weak', async () => {
    const r = await mc('staffA', { name: 'التجربة', vat_number: '300000000000003' });
    const ranks = r.candidates.map(x => x.rank);
    return ranks.every((x, i) => i === 0 || ranks[i - 1] >= x) && ranks[0] === 3 || JSON.stringify(ranks);
  });
  await check('nothing matches → empty list', async () => {
    const r = await mc('staffA', { name: 'لا يوجد أبدا زززز' });
    return (r.candidates.length === 0 && r.conflict === false) || JSON.stringify(r);
  });
  await check('org B data is never a candidate in org A (same VAT exists in org B)', async () => {
    const r = await mc('staffA', { vat_number: '300000000000003' });
    return r.candidates.every(x => x.client_id !== B_CL) || JSON.stringify(r);
  });
  await check('match_client never links: no row written anywhere', async () => {
    const after = await snapshot();
    return JSON.stringify(before) === JSON.stringify(after) || JSON.stringify({ before, after });
  });
  await expectErr('staffB on org A → MRS_FORBIDDEN', () => as('staffB', `SELECT public.match_client($1, '{"name":"x"}')`, [A]), /MRS_FORBIDDEN/);
  await expectErr('client → MRS_FORBIDDEN', () => as('clientA', `SELECT public.match_client($1, '{"name":"x"}')`, [A]), /MRS_FORBIDDEN/);
  await expectErr('empty payload → MRS_REQUIRED', () => as('staffA', `SELECT public.match_client($1, '{}')`, [A]), /MRS_REQUIRED/);
}

async function secDeclarations() {
  section('customs declarations: add / status / correct / cancel + replace (item 3)');
  const add = (who, tx, p, key) => rpc(who, `SELECT public.add_declaration($1, $2, $3) r`, [tx, p, key || null]);
  const k1 = newKey();
  await check('clearance staff adds a declaration (normalized number, default submitted) → mirrored on the transaction', async () => {
    const r = await add('clrJ', TX3, { declaration_no: ' dec 3001 ', declaration_type: 'استيراد', declaration_date: '2026-11-01', notes: 'داخلي' }, k1);
    S.d1 = r.id;
    const t = await txRow(TX3);
    return (r.declaration_no === 'DEC3001' && r.status === 'submitted' && t.declaration_no === 'DEC3001'
      && t.declaration_type === 'استيراد' && String(t.declaration_date).length > 0) || JSON.stringify({ r, t: t.declaration_no });
  });
  await check('idempotent replay: same key → same row, replayed, no duplicate', async () => {
    const r = await add('clrJ', TX3, { declaration_no: ' dec 3001 ', declaration_type: 'استيراد', declaration_date: '2026-11-01', notes: 'داخلي' }, k1);
    const n = await count(`SELECT count(*)::int n FROM public.customs_declarations WHERE transaction_id = $1`, [TX3]);
    return (r.id === S.d1 && r.replayed === true && n === 1) || JSON.stringify({ r, n });
  });
  await expectErr('same key, different payload → MRS_IDEMPOTENCY_CONFLICT', () => add('clrJ', TX3, { declaration_no: 'DEC3999' }, k1), /MRS_IDEMPOTENCY_CONFLICT/);
  await expectErr('active number already used in the org → MRS_INVALID declaration_no_taken', () => add('staffA', TX2, { declaration_no: 'DEC3001' }), /MRS_INVALID.*declaration_no_taken/);
  await expectErr('legacy number of another transaction → taken', () => add('staffA', TX2, { declaration_no: 'test-dec-0001' }), /MRS_INVALID.*declaration_no_taken/);
  await expectErr('other branch (transport DMM) → MRS_NOT_FOUND', () => add('trD', TX3, { declaration_no: 'X1' }), /MRS_NOT_FOUND/);
  await expectErr('transport staff of the branch → MRS_FORBIDDEN role', () => add('trJ', TX3, { declaration_no: 'X1' }), /MRS_FORBIDDEN.*role/);
  await expectErr('accountant → MRS_FORBIDDEN role', () => add('accA', TX3, { declaration_no: 'X1' }), /MRS_FORBIDDEN.*role/);
  await expectErr('org B staff → MRS_NOT_FOUND', () => add('staffB', TX3, { declaration_no: 'X1' }), /MRS_NOT_FOUND/);
  await expectErr('client → MRS_NOT_FOUND', () => add('clientA', TX1, { declaration_no: 'X1' }), /MRS_NOT_FOUND/);
  await expectErr('initial status cancelled refused', () => add('clrJ', TX3, { declaration_no: 'X2', status: 'cancelled' }), /MRS_INVALID.*status/);
  await expectErr('unknown payload key refused', () => add('clrJ', TX3, { declaration_no: 'X2', hacked: true }), /MRS_INVALID/);
  await expectErr('bad date refused', () => add('clrJ', TX3, { declaration_no: 'X2', declaration_date: '2026-13-40' }), /MRS_INVALID.*declaration_date/);
  await expectErr('source document of another transaction refused', async () => {
    const doc = await ownerDoc(A, TX1, 'customs_declaration');
    return add('clrJ', TX3, { declaration_no: 'X2', source_document_id: doc });
  }, /MRS_INVALID.*source_document_id/);
  await expectErr('direct INSERT into customs_declarations refused (RPC only)', () => as('staffA',
    `INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no) VALUES ($1, $2, 'DIRECT1')`, [A, TX3]), /permission denied/);

  const st = (who, id, s, note) => rpc(who, `SELECT public.set_declaration_status($1, $2, $3) r`, [id, s, note || null]);
  await check('status forward: submitted → under_inspection → released', async () => {
    const a = await st('clrJ', S.d1, 'under_inspection');
    const b = await st('clrJ', S.d1, 'released');
    return (a.status === 'under_inspection' && b.status === 'released' && b.from === 'under_inspection') || JSON.stringify({ a, b });
  });
  await expectErr('backward without a note → MRS_NOTE_REQUIRED', () => st('clrJ', S.d1, 'submitted'), /MRS_NOTE_REQUIRED/);
  await expectErr('backward by clearance staff → MRS_FORBIDDEN', () => st('clrJ', S.d1, 'submitted', 'خطأ'), /MRS_FORBIDDEN/);
  await check('backward by operations manager with a note', async () => (await st('opsJ', S.d1, 'submitted', 'أعيد للمراجعة')).status === 'submitted');
  await expectErr('status cancelled only through cancel_declaration', () => st('clrJ', S.d1, 'cancelled'), /MRS_BAD_TRANSITION/);
  await expectErr('same status → MRS_BAD_TRANSITION', () => st('clrJ', S.d1, 'submitted'), /MRS_BAD_TRANSITION/);

  const corr = (who, id, p, reason) => rpc(who, `SELECT public.correct_declaration($1, $2, $3) r`, [id, p, reason]);
  await expectErr('correct without a reason → MRS_NOTE_REQUIRED', () => corr('clrJ', S.d1, { declaration_no: 'DEC3002' }, ' '), /MRS_NOTE_REQUIRED/);
  await check('correct: number changed, corrected_at set, mirrored, before/after in audit_log and in the event', async () => {
    const r = await corr('clrJ', S.d1, { declaration_no: 'dec3002' }, 'خطأ إدخال في الرقم');
    const t = await txRow(TX3);
    const au = await one(`SELECT old_data->>'declaration_no' o, new_data->>'declaration_no' n FROM public.audit_log
                           WHERE table_name = 'customs_declarations' AND row_id = $1 AND action = 'UPDATE'
                             AND 'declaration_no' = ANY (changed_fields) ORDER BY id DESC LIMIT 1`, [S.d1]);
    const ev = await one(`SELECT note, payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'declaration'
                           AND payload->>'op' = 'corrected' ORDER BY id DESC LIMIT 1`, [TX3]);
    return (r.declaration_no === 'DEC3002' && r.corrected_at && t.declaration_no === 'DEC3002' && au && au.o === 'DEC3001'
      && au.n === 'DEC3002' && ev.note === 'خطأ إدخال في الرقم' && ev.payload.before.declaration_no === 'DEC3001')
      || JSON.stringify({ r, t: t.declaration_no, au, ev });
  });
  await expectErr('correct with no actual change → MRS_BAD_TRANSITION no_change', () => corr('clrJ', S.d1, { declaration_no: 'DEC3002' }, 'لا شيء'), /MRS_BAD_TRANSITION.*no_change/);

  const cancel = (who, id, reason, rep) => rpc(who, `SELECT public.cancel_declaration($1, $2, $3) r`, [id, reason, rep === undefined ? null : rep]);
  await expectErr('cancel without a reason → MRS_NOTE_REQUIRED', () => cancel('clrJ', S.d1, ''), /MRS_NOTE_REQUIRED/);
  await check('cancel (no replacement): status cancelled with reason; transaction mirror cleared', async () => {
    const r = await cancel('clrJ', S.d1, 'ألغته الجمارك');
    const t = await txRow(TX3);
    return (r.cancelled.status === 'cancelled' && r.cancelled.cancel_reason === 'ألغته الجمارك' && r.replacement === null
      && t.declaration_no === null) || JSON.stringify({ r, t: t.declaration_no });
  });
  await expectErr('cancel twice → MRS_BAD_TRANSITION', () => cancel('clrJ', S.d1, 'مرة أخرى'), /MRS_BAD_TRANSITION/);
  await expectErr('cancelled number cannot be reused by another transaction', () => add('staffA', TX2, { declaration_no: 'DEC3002' }), /MRS_INVALID.*declaration_no_cancelled/);
  await expectErr('cancelled number cannot be reused without an explicit replacement (same transaction)', () => add('clrJ', TX3, { declaration_no: 'DEC3002' }), /MRS_INVALID.*declaration_no_cancelled/);
  await check('explicit replacement (replaces_id) may reuse the number; old row → replaced, linked', async () => {
    const r = await add('clrJ', TX3, { declaration_no: 'DEC3002', replaces_id: S.d1 });
    S.d2 = r.id;
    const old = await one(`SELECT status, replaced_by_id FROM public.customs_declarations WHERE id = $1`, [S.d1]);
    const t = await txRow(TX3);
    return (old.status === 'replaced' && old.replaced_by_id === r.id && r.replaced_id === S.d1 && t.declaration_no === 'DEC3002')
      || JSON.stringify({ r, old, t: t.declaration_no });
  });
  await expectErr('replaces_id must be a cancelled declaration of the same transaction', () => add('clrJ', TX3, { declaration_no: 'DEC3010', replaces_id: S.d2 }), /MRS_BAD_TRANSITION/);
  await check('cancel + replace in one call: chain d1 → d2 → d3, mirror = d3', async () => {
    const r = await cancel('clrJ', S.d2, 'أعيد تقديم البيان', { declaration_no: 'DEC3003', declaration_type: 'استيراد' });
    S.d3 = r.replacement.id;
    const chain = await q(`SELECT id, declaration_no, status, replaced_by_id FROM public.customs_declarations WHERE transaction_id = $1 ORDER BY created_at`, [TX3]);
    const t = await txRow(TX3);
    return (r.cancelled.status === 'replaced' && r.cancelled.replaced_by_id === S.d3 && chain.length === 3
      && chain[0].replaced_by_id === S.d2 && chain[1].replaced_by_id === S.d3 && chain[2].status === 'submitted'
      && t.declaration_no === 'DEC3003') || JSON.stringify({ r, chain, t: t.declaration_no });
  });
  await check('a failing replacement rolls the whole cancel back', async () => {
    try { await cancel('clrJ', S.d3, 'سبب', { declaration_no: 'TEST-DEC-0001' }); return 'should fail'; }
    catch (e) { if (!/declaration_no_taken/.test(errText(e))) return 'wrong error ' + errText(e); }
    try { await cancel('clrJ', S.d3, 'سبب', { declaration_no: 'X', bogus: 1 }); return 'should fail'; }
    catch (e) { if (!/MRS_INVALID/.test(errText(e))) return 'wrong error ' + errText(e); }
    const d = await one(`SELECT status FROM public.customs_declarations WHERE id = $1`, [S.d3]);
    return d.status === 'submitted' || d.status;
  });
  await expectErr('correct a replaced declaration → MRS_BAD_TRANSITION', () => corr('clrJ', S.d2, { declaration_type: 'x' }, 'سبب'), /MRS_BAD_TRANSITION/);
  await expectErr('correct to a cancelled number of the chain → refused', () => corr('opsJ', S.d3, { declaration_no: 'DEC3002' }, 'سبب'), /MRS_INVALID.*declaration_no_cancelled/);
  await check('every declaration change emitted an internal event (none client-visible)', async () => {
    const r = await q(`SELECT payload->>'op' op, visible_to_client v FROM public.transaction_events
                        WHERE transaction_id = $1 AND event_type = 'declaration' ORDER BY id`, [TX3]);
    const ops = r.map(x => x.op).join(',');
    return (r.every(x => !x.v) && ops === 'added,status,status,status,corrected,cancelled,added,replaced,cancelled,added,replaced') || ops;
  });
  await expectErr('other branch cannot cancel → MRS_NOT_FOUND', () => cancel('trD', S.d3, 'x'), /MRS_NOT_FOUND/);
  await expectErr('org B cannot change status → MRS_NOT_FOUND', () => st('staffB', S.d3, 'released'), /MRS_NOT_FOUND/);
}

async function secLegacy() {
  section('legacy writes on transactions are adopted (compatibility)');
  await check('direct UPDATE of transactions.declaration_no creates a declaration and the mirror normalizes it', async () => {
    await as('staffA', `UPDATE public.transactions SET declaration_no = 'leg 77' WHERE id = $1`, [TX5]);
    const d = await q(`SELECT declaration_no, status FROM public.customs_declarations WHERE transaction_id = $1`, [TX5]);
    const t = await txRow(TX5);
    return (d.length === 1 && d[0].declaration_no === 'LEG77' && t.declaration_no === 'LEG77') || JSON.stringify({ d, t: t.declaration_no });
  });
  // regression (review): a record edit never renumbers / cancels / revives a declaration — those are
  // correct_declaration / cancel_declaration / an explicit replacement (reason, audit, exception)
  await expectErr('renumbering the active declaration through the record → MRS_BAD_TRANSITION use_correct_declaration', () => as('staffA',
    `UPDATE public.transactions SET declaration_no = 'LEG78' WHERE id = $1`, [TX5]), /MRS_BAD_TRANSITION.*use_correct_declaration/);
  await check('a record edit of date / type only corrects the active declaration in place (legacy_edit event)', async () => {
    await as('staffA', `UPDATE public.transactions SET declaration_type = 'تصدير' WHERE id = $1`, [TX5]);
    const d = await q(`SELECT declaration_no, declaration_type, corrected_at FROM public.customs_declarations WHERE transaction_id = $1`, [TX5]);
    const e = await one(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'declaration' ORDER BY id DESC LIMIT 1`, [TX5]);
    return (d.length === 1 && d[0].declaration_no === 'LEG77' && d[0].declaration_type === 'تصدير' && d[0].corrected_at !== null
      && e.payload.op === 'corrected' && e.payload.legacy_edit === true) || JSON.stringify({ d, e });
  });
  await expectErr('clearing the number on the record → MRS_BAD_TRANSITION use_cancel_declaration (nothing cancelled)', () => as('staffA',
    `UPDATE public.transactions SET declaration_no = NULL WHERE id = $1`, [TX5]), /MRS_BAD_TRANSITION.*use_cancel_declaration/);
  await check('after cancel_declaration, typing the cancelled number back on the record is refused; a new number is added', async () => {
    const d = await one(`SELECT id FROM public.customs_declarations WHERE transaction_id = $1 AND status = 'submitted'`, [TX5]);
    await rpc('staffA', `SELECT public.cancel_declaration($1, 'ألغته الجمارك') r`, [d.id]);
    let err = '';
    try { await as('staffA', `UPDATE public.transactions SET declaration_no = 'LEG77' WHERE id = $1`, [TX5]); } catch (e) { err = errText(e); }
    await as('staffA', `UPDATE public.transactions SET declaration_no = 'LEG78' WHERE id = $1`, [TX5]);
    const r = await q(`SELECT declaration_no, status, replaced_by_id FROM public.customs_declarations WHERE transaction_id = $1 ORDER BY created_at`, [TX5]);
    return (/MRS_INVALID.*declaration_no_cancelled/.test(err) && r.length === 2 && r[0].declaration_no === 'LEG77' && r[0].status === 'cancelled'
      && r[0].replaced_by_id === null && r[1].declaration_no === 'LEG78' && r[1].status === 'submitted') || JSON.stringify({ err, r });
  });
  await expectErr('legacy write of a number active elsewhere is refused', () => as('staffA',
    `UPDATE public.transactions SET declaration_no = 'DEC3003' WHERE id = $1`, [TX5]), /duplicate|MRS_INVALID/);
  await check('direct UPDATE of transactions.bl_number: B/L found-or-created and linked as primary, old primary kept as secondary', async () => {
    await as('staffA', `UPDATE public.transactions SET bl_number = 'LEGBL 1' WHERE id = $1`, [TX5]);
    await as('staffA', `UPDATE public.transactions SET bl_number = 'LEGBL2' WHERE id = $1`, [TX5]);
    const l = await q(`SELECT b.bl_number, tb.is_primary FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                        WHERE tb.transaction_id = $1 ORDER BY b.bl_number`, [TX5]);
    const kept = await count(`SELECT count(*)::int n FROM public.bills_of_lading WHERE org_id = $1 AND bl_number = 'LEGBL1'`, [A]);
    const t = await txRow(TX5);
    return (l.length === 2 && l[0].bl_number === 'LEGBL1' && !l[0].is_primary && l[1].bl_number === 'LEGBL2' && l[1].is_primary
      && t.bl_number === 'LEGBL2' && kept === 1) || JSON.stringify({ l, t: t.bl_number, kept });
  });
  await check('legacy bl_number equal to an existing B/L reuses it (one B/L, several transactions)', async () => {
    await as('staffA', `UPDATE public.transactions SET bl_number = 'TESTBL0000002' WHERE id = $1`, [TX5]);
    const n = await count(`SELECT count(*)::int n FROM public.bills_of_lading WHERE org_id = $1 AND bl_number = 'TESTBL0000002'`, [A]);
    const links = await count(`SELECT count(*)::int n FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                                WHERE b.bl_number = 'TESTBL0000002' AND b.org_id = $1`, [A]);
    return (n === 1 && links === 2) || JSON.stringify({ n, links });
  });
  await check('convert_request_to_transaction: request B/L lands as the primary B/L of the new transaction', async () => {
    const r = await rpc('staffA', `SELECT public.convert_request_to_transaction('0b5e0000-0000-4000-8000-000000000401', $1, NULL, NULL) r`, [JED]);
    S.convTx = r.transaction_id;
    const l = await q(`SELECT b.bl_number, tb.is_primary FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                        WHERE tb.transaction_id = $1`, [r.transaction_id]);
    return (l.length === 1 && l[0].bl_number === 'TESTBL0000009' && l[0].is_primary) || JSON.stringify(l);
  });
  // regression (review): a B/L number from intake / the record never adopts another client's (or branch's) B/L
  await check('new transaction of another client in another branch with TX1\'s B/L number: not linked, conflict event, client sees nothing', async () => {
    const before = await as('clientA2', `SELECT count(*)::int n FROM public.bills_of_lading WHERE bl_number = 'TESTBL0000001'`);
    const t = (await as('staffA', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, bl_number)
                                    VALUES ($1, $2, $3, 'import', 'sea', 'TESTBL0000001') RETURNING id`, [A, DMM, CL102]))[0];
    S.txConflict = t.id;
    const after = await as('clientA2', `SELECT count(*)::int n FROM public.bills_of_lading WHERE bl_number = 'TESTBL0000001'`);
    const links = await count(`SELECT count(*)::int n FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                                WHERE b.org_id = $1 AND b.bl_number = 'TESTBL0000001'`, [A]);
    const mine = await count(`SELECT count(*)::int n FROM public.transaction_bls WHERE transaction_id = $1`, [t.id]);
    const e = await one(`SELECT payload, visible_to_client v FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'bl'`, [t.id]);
    const tx = await txRow(t.id);
    return (before[0].n === 0 && after[0].n === 0 && links === 1 && mine === 0 && e && e.payload.op === 'conflict' && !e.v
      && tx.bl_number === 'TESTBL0000001') || JSON.stringify({ before, after, links, mine, e, bl: tx.bl_number });
  });
  await check('JED staff still edit TX1\'s B/L afterwards (it feeds no DMM transaction)', async () => {
    const r = await rpc('clrJ', `SELECT public.save_bl($1) r`, [{ id: (await blOf('TESTBL0000001')).id, voyage: '017W' }]);
    return r.bl_number === 'TESTBL0000001' || JSON.stringify(r);
  });
  await check('a stale record save of an older B/L number demotes (never deletes) the newer primary; container bl_id kept', async () => {
    const bl2 = (await blOf('TESTBL0000002')).id;
    const ct = (await q(`INSERT INTO public.containers (org_id, transaction_id, container_no, bl_id) VALUES ($1, $2, 'TSTU0000005', $3) RETURNING id`,
      [A, TX5, bl2]))[0].id;
    await as('staffA', `UPDATE public.transactions SET bl_number = 'LEGBL2' WHERE id = $1`, [TX5]);
    const l = await q(`SELECT b.bl_number, tb.is_primary FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                        WHERE tb.transaction_id = $1 ORDER BY b.bl_number`, [TX5]);
    const c = await one(`SELECT bl_id FROM public.containers WHERE id = $1`, [ct]);
    await as('staffA', `UPDATE public.transactions SET bl_number = NULL WHERE id = $1`, [TX5]);
    const cleared = await q(`SELECT is_primary FROM public.transaction_bls WHERE transaction_id = $1`, [TX5]);
    await as('staffA', `UPDATE public.transactions SET bl_number = 'TESTBL0000002' WHERE id = $1`, [TX5]);
    const t = await txRow(TX5);
    await q(`DELETE FROM public.containers WHERE id = $1`, [ct]);
    return (l.length === 3 && l.map(x => x.bl_number + ':' + x.is_primary).join(',') === 'LEGBL1:false,LEGBL2:true,TESTBL0000002:false'
      && c.bl_id === bl2 && cleared.length === 3 && cleared.every(x => !x.is_primary) && t.bl_number === 'TESTBL0000002')
      || JSON.stringify({ l, c, cleared, bl: t.bl_number });
  });
}

async function secBLs() {
  section('bills of lading + many-to-many links (item 4)');
  const save = (who, p, key) => rpc(who, `SELECT public.save_bl($1, $2) r`, [p, key || null]);
  const link = (who, tx, bl, prim) => rpc(who, `SELECT public.link_bl($1, $2, $3) r`, [tx, bl, prim === undefined ? false : prim]);
  const unlink = (who, tx, bl, reason) => rpc(who, `SELECT public.unlink_bl($1, $2, $3) r`, [tx, bl, reason]);
  const k = newKey();
  const p1 = { transaction_id: TX4, bl_number: 'mscu 123', bl_type: 'master', vessel: 'MSC TEST', voyage: '001E',
    packages: 40, gross_weight_kg: '12500.5', issued_at: '2026-10-20', notes: 'ملاحظة داخلية', shipping_agent_id: S.agent };
  await check('save_bl with transaction_id: created, linked as primary (first link), mirrored', async () => {
    const r = await save('clrJ', p1, k);
    S.bl1 = r.id;
    const t = await txRow(TX4);
    return (r.created && !r.existing && r.linked && r.is_primary && r.bl_number === 'MSCU123' && t.bl_number === 'MSCU123') || JSON.stringify({ r, t: t.bl_number });
  });
  await check('idempotent replay: same key → same B/L, replayed, nothing duplicated', async () => {
    const r = await save('clrJ', p1, k);
    const n = await count(`SELECT count(*)::int n FROM public.bills_of_lading WHERE org_id = $1 AND bl_number = 'MSCU123'`, [A]);
    const l = await count(`SELECT count(*)::int n FROM public.transaction_bls WHERE transaction_id = $1`, [TX4]);
    return (r.id === S.bl1 && r.replayed === true && n === 1 && l === 1) || JSON.stringify({ r, n, l });
  });
  await check('save_bl without id on an existing (number, type) returns it unchanged — never a duplicate', async () => {
    const r = await save('staffA', { org_id: A, bl_number: 'MSCU123', bl_type: 'master', vessel: 'OTHER' });
    const b = await one(`SELECT vessel FROM public.bills_of_lading WHERE id = $1`, [S.bl1]);
    return (r.id === S.bl1 && r.existing && !r.created && b.vessel === 'MSC TEST') || JSON.stringify({ r, b });
  });
  await check('same number with another type is a separate B/L (house under master)', async () => {
    const r = await save('staffA', { org_id: A, bl_number: 'MSCU123', bl_type: 'house' });
    S.blHouse = r.id;
    return (r.created && r.id !== S.bl1) || JSON.stringify(r);
  });
  await expectErr('bl_type outside the list → MRS_INVALID', () => save('staffA', { org_id: A, bl_number: 'Z1', bl_type: 'courier' }), /MRS_INVALID.*bl_type/);
  await expectErr('shipping_agent_id must be a party of kind shipping_agent', () => save('staffA', { org_id: A, bl_number: 'Z1', shipping_agent_id: S.carrier }), /MRS_INVALID.*shipping_agent_id/);
  await expectErr('save_bl without org or transaction → MRS_REQUIRED org_id', () => save('staffA', { bl_number: 'Z1' }), /MRS_REQUIRED.*org_id/);
  await expectErr('accountant cannot save B/Ls → MRS_FORBIDDEN', () => save('accA', { org_id: A, bl_number: 'Z1' }), /MRS_FORBIDDEN/);
  await expectErr('transport staff cannot save B/Ls → MRS_FORBIDDEN', () => save('trJ', { org_id: A, bl_number: 'Z1' }), /MRS_FORBIDDEN/);
  await expectErr('org B staff cannot create in org A → MRS_FORBIDDEN', () => save('staffB', { org_id: A, bl_number: 'Z1' }), /MRS_FORBIDDEN/);
  await expectErr('org B staff cannot edit an org A B/L → MRS_NOT_FOUND', () => save('staffB', { id: S.bl1, vessel: 'X' }), /MRS_NOT_FOUND/);
  await expectErr('direct INSERT into bills_of_lading refused', () => as('staffA',
    `INSERT INTO public.bills_of_lading (org_id, bl_number) VALUES ($1, 'DIRECT')`, [A]), /permission denied/);
  await expectErr('direct INSERT into transaction_bls refused', () => as('staffA',
    `INSERT INTO public.transaction_bls (transaction_id, bl_id, org_id) VALUES ($1, $2, $3)`, [TX4, S.blHouse, A]), /permission denied/);

  S.blT1 = (await blOf('TESTBL0000001')).id;
  await check('many-to-many: TX1\'s B/L also linked to TX4 (not primary); TX4 keeps its primary', async () => {
    const r = await link('clrJ', TX4, S.blT1);
    const t = await txRow(TX4);
    const n = await count(`SELECT count(*)::int n FROM public.transaction_bls WHERE bl_id = $1`, [S.blT1]);
    return (!r.is_primary && t.bl_number === 'MSCU123' && n === 2) || JSON.stringify({ r, t: t.bl_number, n });
  });
  await check('link again → already_linked, no change', async () => (await link('clrJ', TX4, S.blT1)).already_linked === true);
  await check('make it primary: exactly one primary, mirror follows', async () => {
    const r = await link('clrJ', TX4, S.blT1, true);
    const p = await q(`SELECT bl_id FROM public.transaction_bls WHERE transaction_id = $1 AND is_primary`, [TX4]);
    const t = await txRow(TX4);
    return (r.is_primary && p.length === 1 && p[0].bl_id === S.blT1 && t.bl_number === 'TESTBL0000001') || JSON.stringify({ r, p, t: t.bl_number });
  });
  await expectErr('other branch cannot link → MRS_NOT_FOUND', () => link('trD', TX4, S.bl1), /MRS_NOT_FOUND/);
  await expectErr('org B cannot link an org A B/L to its transaction → MRS_NOT_FOUND bl', () => link('staffB', B_TX, S.bl1), /MRS_NOT_FOUND.*bl/);
  await expectErr('transport staff cannot link → MRS_FORBIDDEN', () => link('trJ', TX4, S.blHouse), /MRS_FORBIDDEN/);

  await check('container bl_id: a B/L linked to the container\'s transaction is accepted', async () => {
    S.ct4 = (await as('trJ', `INSERT INTO public.containers (org_id, transaction_id, container_no, bl_id) VALUES ($1, $2, 'TSTU0000001', $3)
                               RETURNING id`, [A, TX4, S.bl1]))[0].id;
    return true;
  });
  await expectErr('container bl_id: a B/L not linked to that transaction is refused', () => as('trJ',
    `UPDATE public.containers SET bl_id = $2 WHERE id = $1`, [S.ct4, S.blHouse]), /containers_bl_fk|foreign key/);
  await expectErr('unlink without a reason → MRS_NOTE_REQUIRED', () => unlink('clrJ', TX4, S.blT1, ''), /MRS_NOTE_REQUIRED/);
  await check('unlink the primary: oldest remaining link promoted, mirror follows, TX1 keeps its link', async () => {
    const r = await unlink('clrJ', TX4, S.blT1, 'ربط بالخطأ');
    const t = await txRow(TX4);
    const t1 = await count(`SELECT count(*)::int n FROM public.transaction_bls WHERE transaction_id = $1 AND bl_id = $2`, [TX1, S.blT1]);
    return (r.was_primary && r.promoted_bl_id === S.bl1 && t.bl_number === 'MSCU123' && t1 === 1) || JSON.stringify({ r, t: t.bl_number, t1 });
  });
  await check('unlink a B/L used by a container: container bl_id cleared, B/L record kept, mirror NULL', async () => {
    const r = await unlink('opsJ', TX4, S.bl1, 'بوليصة أخرى');
    const c = await one(`SELECT bl_id FROM public.containers WHERE id = $1`, [S.ct4]);
    const b = await count(`SELECT count(*)::int n FROM public.bills_of_lading WHERE id = $1`, [S.bl1]);
    const t = await txRow(TX4);
    return (r.containers_cleared === 1 && c.bl_id === null && b === 1 && t.bl_number === null) || JSON.stringify({ r, c, b, t: t.bl_number });
  });
  await expectErr('unlink a link that does not exist → MRS_NOT_FOUND link', () => unlink('clrJ', TX4, S.bl1, 'x'), /MRS_NOT_FOUND.*link/);
  await check('relink + renumber the B/L: every transaction where it is primary is re-mirrored', async () => {
    await link('clrJ', TX4, S.bl1, true);
    await save('staffA', { id: S.bl1, bl_number: 'MSCU124' });
    const t = await txRow(TX4);
    return t.bl_number === 'MSCU124' || t.bl_number;
  });
  await expectErr('renumber to an existing (number, type) → MRS_INVALID bl_number_taken', () => save('staffA', { id: S.blHouse, bl_number: 'MSCU124', bl_type: 'master' }), /MRS_INVALID.*bl_number_taken/);
  await expectErr('a B/L feeding only another branch\'s transactions is not even found for editing', async () => {
    const bl2 = (await blOf('TESTBL0000002')).id;
    return save('clrJ', { id: bl2, vessel: 'X' });
  }, /MRS_NOT_FOUND.*bl/);
  await check('B/L link events recorded (internal)', async () => {
    const r = await q(`SELECT payload->>'op' op, visible_to_client v FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'bl' ORDER BY id`, [TX4]);
    return (r.every(x => !x.v) && r.map(x => x.op).join(',') === 'linked,linked,primary,unlinked,unlinked,linked,updated') || r.map(x => x.op).join(',');
  });

  // regression (review): branch scoping of B/Ls + deliberate cross-client sharing
  const bl2 = (await blOf('TESTBL0000002')).id;
  await expectErr('save_bl without id on a number held by another branch\'s B/L → MRS_FORBIDDEN bl_other_branch (never linked)', () => save('clrJ',
    { transaction_id: TX4, bl_number: 'TESTBL0000002', bl_type: 'other' }), /MRS_FORBIDDEN.*bl_other_branch/);
  await expectErr('link_bl of another branch\'s B/L id → MRS_NOT_FOUND bl', () => link('clrJ', TX4, bl2), /MRS_NOT_FOUND.*bl/);
  await check('org-wide staff link it deliberately to a JED transaction of another client → shared_with_other_client flagged (result + event)', async () => {
    const r = await link('staffA', TX4, bl2);
    const e = await one(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'bl' ORDER BY id DESC LIMIT 1`, [TX4]);
    return (r.shared_with_other_client === true && e.payload.shared_with_other_client === true) || JSON.stringify({ r, e });
  });
  await expectErr('the shared B/L can only be edited by someone allowed on every transaction (JED staff → MRS_FORBIDDEN branch)', () =>
    save('clrJ', { id: bl2, vessel: 'X' }), /MRS_FORBIDDEN.*branch/);
  await check('while shared across clients, neither client reads the B/L record (no cross-client cargo details)', async () => {
    const a1 = await denied('clientA', `SELECT goods_description FROM public.bills_of_lading WHERE id = $1`, [bl2]);
    const a2 = await denied('clientA2', `SELECT goods_description FROM public.bills_of_lading WHERE id = $1`, [bl2]);
    return (a1 === true && a2 === true) || JSON.stringify({ a1, a2 });
  });
  await check('unlinking it again: the owning client reads it again', async () => {
    await unlink('staffA', TX4, bl2, 'ربط تجريبي');
    return (await as('clientA2', `SELECT count(*)::int n FROM public.bills_of_lading WHERE id = $1`, [bl2]))[0].n === 1;
  });
}

async function secContainers() {
  section('containers: repeat across transactions, visit_ref, state, history (item 5)');
  await check('the same container number in another transaction is allowed (TX1 and TX4 both have TSTU0000001)', async () =>
    (await count(`SELECT count(*)::int n FROM public.containers WHERE org_id = $1 AND container_no = 'TSTU0000001'`, [A])) === 2);
  await expectErr('the same number twice in one transaction is refused', () => as('trJ',
    `INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, 'tstu 0000001')`, [A, TX4]), /containers_tx_no_uniq|duplicate/);
  await check('visit_ref = <container_no>@<transaction ref>; seal / size normalized', async () => {
    const r = (await as('trJ', `UPDATE public.containers SET seal_no = 'ab 123', size_type = '45g1', gross_weight_kg = 21000
                                 WHERE id = $1 RETURNING visit_ref, seal_no, size_type`, [S.ct4]))[0];
    const t = await txRow(TX4);
    return (r.visit_ref === 'TSTU0000001@' + t.ref && r.seal_no === 'AB123' && r.size_type === '45G1') || JSON.stringify(r);
  });
  await check('visit_ref cannot be forged by the API (recomputed)', async () => {
    const r = (await as('trJ', `UPDATE public.containers SET visit_ref = 'FAKE' WHERE id = $1 RETURNING visit_ref`, [S.ct4]))[0];
    return r.visit_ref !== 'FAKE' || r.visit_ref;
  });
  await as('trD', `INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, 'TSTU0000001')`, [A, TX5]);
  const hist = (who, no, org) => rpc(who, `SELECT public.container_history($1, $2) r`, [org || A, no]);
  await check('container_history: org-wide clearance staff sees all 3 visits (newest first)', async () => {
    const r = await hist('staffA', 'tstu 000 0001');
    const refs = r.visits.map(v => v.visit_ref);
    return (r.container_no === 'TSTU0000001' && r.visits.length === 3 && new Set(refs).size === 3) || JSON.stringify(r);
  });
  await check('container_history is branch-scoped (JED sees 2, DMM sees 1)', async () => {
    const j = await hist('clrJ', 'TSTU0000001');
    const d = await hist('trD', 'TSTU0000001');
    return (j.visits.length === 2 && d.visits.length === 1 && d.visits[0].transaction_id === TX5) || JSON.stringify({ j: j.visits.length, d: d.visits.length });
  });
  await check('container_history never mixes orgs (org B has the same number)', async () => {
    const r = await hist('staffB', 'TSTU0000001', B);
    return (r.visits.length === 1 && r.visits[0].container_id === B_CT) || JSON.stringify(r);
  });
  await expectErr('container_history: org B on org A → MRS_FORBIDDEN', () => hist('staffB', 'TSTU0000001'), /MRS_FORBIDDEN/);
  await expectErr('container_history: client → MRS_FORBIDDEN', () => hist('clientA', 'TSTU0000001'), /MRS_FORBIDDEN/);
  await expectErr('container_history: malformed number → MRS_INVALID', () => hist('staffA', 'ABC'), /MRS_INVALID.*container_no/);
  await check('operational_state change emits an internal container event', async () => {
    await as('trJ', `UPDATE public.containers SET operational_state = 'at_port' WHERE id = $1`, [S.ct4]);
    const e = await one(`SELECT from_status, to_status, visible_to_client v FROM public.transaction_events
                          WHERE transaction_id = $1 AND event_type = 'container' ORDER BY id DESC LIMIT 1`, [TX4]);
    return (e && e.from_status === 'expected' && e.to_status === 'at_port' && !e.v) || JSON.stringify(e);
  });
  await expectErr('unknown operational_state refused', () => as('trJ', `UPDATE public.containers SET operational_state = 'lost' WHERE id = $1`, [S.ct4]), /check constraint|violates/);
  await expectErr('empty_returned without any return evidence → MRS_EVIDENCE_INVALID', () => as('trJ',
    `UPDATE public.containers SET operational_state = 'empty_returned' WHERE id = $1`, [S.ct4]), /MRS_EVIDENCE_INVALID/);
  // regression (review): "returned" needs a VERIFIED receipt (or a waiver), never a Return Note on file
  await expectErr('a Return Note as submitted evidence is not enough for empty_returned → MRS_EVIDENCE_INVALID', async () => {
    const note = await ownerDoc(A, TX4, 'empty_return_note', 'empty_return_note', 'confirmed');
    return as('trJ', `UPDATE public.containers SET evidence_document_id = $2, return_status = 'evidence_submitted', operational_state = 'empty_returned'
                       WHERE id = $1`, [S.ct4, note]);
  }, /MRS_EVIDENCE_INVALID.*operational_state/);
  await expectErr('a receipt awaiting verification (evidence_submitted) is not enough either', async () => {
    const rc = await ownerDoc(A, TX4, 'empty_return_receipt', 'empty_return_receipt', 'unreviewed');
    return as('trJ', `UPDATE public.containers SET evidence_document_id = $2, return_status = 'evidence_submitted', operational_state = 'empty_returned'
                       WHERE id = $1`, [S.ct4, rc]);
  }, /MRS_EVIDENCE_INVALID.*operational_state/);
  await check('verified empty-return receipt switches operational_state to empty_returned automatically', async () => {
    const doc = await ownerDoc(A, TX4, 'empty_return_receipt', 'empty_return_receipt', 'confirmed');
    const r = (await as('trJ', `UPDATE public.containers SET return_status = 'returned_verified', evidence_document_id = $2
                                 WHERE id = $1 RETURNING operational_state, return_status`, [S.ct4, doc]))[0];
    return (r.operational_state === 'empty_returned' && r.return_status === 'returned_verified') || JSON.stringify(r);
  });
  await check('verification undone (disputed) takes operational_state back out of empty_returned; re-verifying restores it', async () => {
    const d = (await as('trJ', `UPDATE public.containers SET return_status = 'disputed' WHERE id = $1 RETURNING operational_state, verified_at`, [S.ct4]))[0];
    const seen = await as('clientA', `SELECT operational_state FROM public.containers WHERE id = $1`, [S.ct4]);
    const v = (await as('trJ', `UPDATE public.containers SET return_status = 'returned_verified' WHERE id = $1 RETURNING operational_state`, [S.ct4]))[0];
    return (d.operational_state === 'at_port' || d.operational_state === 'released') && d.verified_at === null
      && seen[0].operational_state !== 'empty_returned' && v.operational_state === 'empty_returned' || JSON.stringify({ d, seen, v });
  });
  await check('client reads its containers with operational_state / return status / deadline', async () => {
    const r = await as('clientA', `SELECT container_no, operational_state, return_status, return_deadline, visit_ref FROM public.containers WHERE transaction_id = $1`, [TX4]);
    return (r.length === 1 && r[0].operational_state === 'empty_returned') || JSON.stringify(r);
  });
  await check('client cannot read another client\'s containers', () => denied('clientA', `SELECT 1 FROM public.containers WHERE transaction_id = $1`, [TX5]));
}

async function secCompleteness() {
  section('transaction_completeness (item 6: data + documents)');
  const comp = (who, tx) => rpc(who, `SELECT public.transaction_completeness($1) r`, [tx]);
  await check('TX3 (air, sparse): score < 100, missing documents / fields with labels, advisory, no clearance claim', async () => {
    const r = await comp('staffA', TX3);
    const docs = r.missing.filter(m => m.document).map(m => m.document);
    const fields = r.missing.filter(m => m.field).map(m => m.field);
    const labelled = r.missing.every(m => m.label_ar && m.label_en && m.required_for);
    return (r.score >= 0 && r.score < 100 && docs.includes('bill_of_lading') && docs.includes('commercial_invoice')
      && fields.includes('hs_code') && fields.includes('bl_number') && labelled && r.advisory === true
      && Array.isArray(r.ready_for) && !JSON.stringify(r).includes('cleared')) || JSON.stringify(r);
  });
  await check('ready_for stops at the first stage with something missing', async () => {
    const r = await comp('staffA', TX3);
    return JSON.stringify(r.ready_for) === '["in_progress"]' || JSON.stringify(r.ready_for);
  });
  await check('a declared-but-unreviewed document is reported as unreviewed, not satisfied', async () => {
    S.inv4 = await ownerDoc(A, TX4, 'commercial_invoice');
    const r = await comp('clrJ', TX4);
    const m = r.missing.find(x => x.document === 'commercial_invoice');
    return (m && m.status === 'unreviewed') || JSON.stringify(r.missing);
  });
  await check('confirming the classification satisfies it and raises the score', async () => {
    const before = (await comp('clrJ', TX4)).score;
    await as('clrJ', `UPDATE public.documents SET classification = 'commercial_invoice', classification_status = 'confirmed' WHERE id = $1`, [S.inv4]);
    const r = await comp('clrJ', TX4);
    return (!r.missing.some(x => x.document === 'commercial_invoice') && r.score > before) || JSON.stringify({ before, r });
  });
  await check('a voided document does not count', async () => {
    const d = await ownerDoc(A, TX4, 'packing_list', 'packing_list', 'confirmed');
    await q(`UPDATE public.documents SET voided_at = now(), void_reason = 'نسخة خاطئة' WHERE id = $1`, [d]);
    const r = await comp('clrJ', TX4);
    const m = r.missing.find(x => x.document === 'packing_list');
    return (m && m.status === 'missing') || JSON.stringify(r.missing);
  });
  await check('containers registered + returned count as data items', async () => {
    const r = await comp('staffA', TX4);
    return (r.items_total >= 9 && !r.missing.some(x => x.field === 'containers') && !r.missing.some(x => x.field === 'empty_return')) || JSON.stringify(r);
  });
  // regression (review): completeness never lists post-release stages before customs released the declaration
  await check('land import, all customs data / documents on file, DRAFT declaration: ready_for stops at customs_declaration', async () => {
    await q(`INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, container_count, goods_description,
               port_of_discharge, country, hs_code) VALUES ($1, $2, $3, $4, 'import', 'land', 0, 'بضاعة برية', 'منفذ البطحاء', 'الإمارات', '84713000')`,
      [TX_LAND, A, JED, CL101]);
    await ownerDoc(A, TX_LAND, 'commercial_invoice', 'commercial_invoice', 'confirmed');
    await ownerDoc(A, TX_LAND, 'packing_list', 'packing_list', 'confirmed');
    S.dLand = (await rpc('clrJ', `SELECT public.add_declaration($1, '{"declaration_no":"LAND-DEC-1","status":"draft"}') r`, [TX_LAND])).id;
    const r = await comp('clrJ', TX_LAND);
    return (JSON.stringify(r.ready_for) === '["in_progress","customs_declaration"]' && r.ready_limit === 'declaration_release'
      && !r.ready_for.includes('operationally_complete')) || JSON.stringify(r);
  });
  await check('released declaration: the later stages may be listed', async () => {
    await rpc('clrJ', `SELECT public.set_declaration_status($1, 'released') r`, [S.dLand]);
    const r = await comp('clrJ', TX_LAND);
    return (r.ready_for.includes('appointment') && r.ready_for.includes('operationally_complete') && r.ready_limit === null) || JSON.stringify(r);
  });
  await expectErr('other branch → MRS_NOT_FOUND', () => comp('trD', TX4), /MRS_NOT_FOUND/);
  await expectErr('org B → MRS_NOT_FOUND', () => comp('staffB', TX4), /MRS_NOT_FOUND/);
  await expectErr('client → MRS_NOT_FOUND', () => comp('clientA', TX4), /MRS_NOT_FOUND/);
}

async function secClientVisibility() {
  section('client portal visibility (declarations, B/Ls, containers)');
  await check('client sees declaration number + status of its own transactions only', async () => {
    const r = await as('clientA', `SELECT transaction_id, declaration_no, status FROM public.customs_declarations ORDER BY created_at`);
    return (r.length >= 1 && r.every(x => [TX1, TX4, TX_LAND].includes(x.transaction_id)) && r.some(x => x.declaration_no === 'TEST-DEC-0001')) || JSON.stringify(r);
  });
  await expectErr('client cannot read declaration notes', () => as('clientA', `SELECT notes FROM public.customs_declarations`), /permission denied/);
  await expectErr('client cannot read the cancel reason', () => as('clientA', `SELECT cancel_reason FROM public.customs_declarations`), /permission denied/);
  await check('client cannot see another client\'s declarations', () => denied('clientA', `SELECT 1 FROM public.customs_declarations WHERE transaction_id = $1`, [TX3]));
  await check('client sees the B/Ls linked to its transactions, not others', async () => {
    const r = (await as('clientA', `SELECT bl_number FROM public.bills_of_lading ORDER BY 1`)).map(x => x.bl_number);
    return (r.includes('TESTBL0000001') && r.includes('MSCU124') && !r.includes('TESTBL0000002') && !r.includes('LEGBL1')) || JSON.stringify(r);
  });
  await expectErr('client cannot read B/L notes', () => as('clientA', `SELECT notes FROM public.bills_of_lading`), /permission denied/);
  await check('client sees links of its transactions only', async () => {
    const r = await as('clientA', `SELECT DISTINCT transaction_id FROM public.transaction_bls`);
    return r.every(x => [TX1, TX4].includes(x.transaction_id)) && r.length === 2 || JSON.stringify(r);
  });
  await check('client sees no declaration / bl / container events', async () =>
    (await as('clientA', `SELECT count(*)::int n FROM public.transaction_events WHERE event_type IN ('declaration','bl','container')`))[0].n === 0);
  await check('staff_internal_fields: staff get declaration notes / cancel reason and B/L notes; client gets nothing', async () => {
    const s = await rpc('staffA', `SELECT public.staff_internal_fields('customs_declarations', $1) r`, [[S.d1, S.d3]]);
    const b = await rpc('staffA', `SELECT public.staff_internal_fields('bills_of_lading', $1) r`, [[S.bl1]]);
    const c = await rpc('clientA', `SELECT public.staff_internal_fields('customs_declarations', $1) r`, [[S.d1]]);
    const x = await rpc('staffB', `SELECT public.staff_internal_fields('bills_of_lading', $1) r`, [[S.bl1]]);
    return (s[S.d1].notes === 'داخلي' && s[S.d1].cancel_reason === 'ألغته الجمارك' && b[S.bl1].notes === 'ملاحظة داخلية'
      && Object.keys(c).length === 0 && Object.keys(x).length === 0) || JSON.stringify({ s, b, c, x });
  });
  await check('staff read declarations with explicit columns (internal ones through staff_internal_fields)', async () =>
    (await as('trJ', `SELECT count(*)::int n FROM public.customs_declarations WHERE transaction_id = $1`, [TX3]))[0].n === 3);
}

async function secIsolation() {
  section('isolation sweep: other org / other branch on every new table');
  const sample = {
    parties: [`SELECT id::text id FROM public.parties WHERE org_id = $1 LIMIT 1`, 'id::text', 'name_ar = name_ar'],
    drivers: [`SELECT id::text id FROM public.drivers WHERE org_id = $1 LIMIT 1`, 'id::text', 'full_name = full_name'],
    trucks: [`SELECT id::text id FROM public.trucks WHERE org_id = $1 LIMIT 1`, 'id::text', 'plate_type = plate_type'],
    client_aliases: [`SELECT id::text id FROM public.client_aliases WHERE org_id = $1 LIMIT 1`, 'id::text', 'source = source'],
    customs_declarations: [`SELECT id::text id FROM public.customs_declarations WHERE org_id = $1 LIMIT 1`, 'id::text', 'status = status'],
    bills_of_lading: [`SELECT id::text id FROM public.bills_of_lading WHERE org_id = $1 LIMIT 1`, 'id::text', 'vessel = vessel'],
    transaction_bls: [`SELECT bl_id::text id FROM public.transaction_bls WHERE org_id = $1 LIMIT 1`, 'bl_id::text', 'is_primary = is_primary']
  };
  for (const [who, org] of [['staffB', A], ['adminB', A], ['clientB', A], ['staffA', B], ['clientA', B]]) {
    for (const [t, [sql, idExpr, setClause]] of Object.entries(sample)) {
      const row = (await q(sql, [org]))[0];
      if (!row) { if (!(org === B && ['drivers', 'trucks', 'client_aliases'].includes(t))) fail(`${who}→${t}: fixture row`, 'none'); continue; }
      await check(`${who}: cannot SELECT ${t} of the other org`, () => denied(who, `SELECT 1 FROM public.${t} WHERE org_id = $1`, [org]));
      await check(`${who}: cannot UPDATE ${t} of the other org`, () => denied(who, `UPDATE public.${t} SET ${setClause} WHERE ${idExpr} = $1 RETURNING 1`, [row.id]));
      await check(`${who}: cannot DELETE ${t} of the other org`, () => denied(who, `DELETE FROM public.${t} WHERE ${idExpr} = $1 RETURNING 1`, [row.id]));
    }
  }
  await check('other branch: DMM staff see no JED declarations / links', async () => {
    const d = await denied('trD', `SELECT 1 FROM public.customs_declarations WHERE transaction_id IN ($1, $2)`, [TX3, TX1]);
    const l = await denied('trD', `SELECT 1 FROM public.transaction_bls WHERE transaction_id IN ($1, $2)`, [TX4, TX1]);
    return (d === true && l === true) || JSON.stringify({ d, l });
  });
  await check('other branch: JED staff see no DMM declarations / links', async () => {
    const d = await denied('clrJ', `SELECT 1 FROM public.customs_declarations WHERE transaction_id = $1`, [TX5]);
    const l = await denied('clrJ', `SELECT 1 FROM public.transaction_bls WHERE transaction_id IN ($1, $2)`, [TX5, TX2]);
    return (d === true && l === true) || JSON.stringify({ d, l });
  });
  // regression (review): B/Ls are branch-scoped through the transactions they feed
  await check('other branch: DMM staff do not read a JED-only B/L (nor its notes); they read DMM ones', async () => {
    const j = await as('trD', `SELECT count(*)::int n FROM public.bills_of_lading WHERE id = ANY ($1)`, [[S.bl1, S.blT1]]);
    const d = await as('trD', `SELECT count(*)::int n FROM public.bills_of_lading WHERE bl_number = 'TESTBL0000002'`);
    const n = await rpc('trD', `SELECT public.staff_internal_fields('bills_of_lading', $1) r`, [[S.bl1]]);
    return (j[0].n === 0 && d[0].n === 1 && Object.keys(n).length === 0) || JSON.stringify({ j, d, n });
  });
  await check('a B/L linked to nothing yet is read by the org\'s ops writers only', async () => {
    const w = await as('clrJ', `SELECT count(*)::int n FROM public.bills_of_lading WHERE id = $1`, [S.blHouse]);
    const t = await as('trJ', `SELECT count(*)::int n FROM public.bills_of_lading WHERE id = $1`, [S.blHouse]);
    return (w[0].n === 1 && t[0].n === 0) || JSON.stringify({ w, t });
  });
}

/* ================================================================== sections: migration B (items 7–12)
   Extra fixtures (created in secOpsCatalog, as owner):
     TX6  JED, client 101, import sea, 1 container declared, port of discharge "Jeddah Islamic Port" (gate + appointments + trips)
     TX7  JED, client 101, import sea, no containers, already in_progress (checklist n/a + docs_missing alert)
     plat platform admin (platform_create_org seeds requirements)
   Migration A's backfill section re-runs MIG_A (restoring A's cancel_declaration / completeness), so the
   first B section re-runs MIG_B as well — which also proves B is re-runnable. */
const MIG_B = '20261103000200_g3_operations.sql';
const TX6 = '0b5e0000-0000-4000-8000-000000000206';
const TX7 = '0b5e0000-0000-4000-8000-000000000207';
U.plat = 'abc30000-0000-4000-8000-00000000000d';

const status = (who, tx, st, note, key) => rpc(who, `SELECT public.set_transaction_status($1, $2, $3, $4) r`, [tx, st, note || null, key || null]);
// explicit document override (the override dialog): p_docs_override = true
const statusOv = (who, tx, st, note, key) => rpc(who, `SELECT public.set_transaction_status($1, $2, $3, $4, true) r`, [tx, st, note || null, key || null]);
const checklist = (who, tx) => rpc(who, `SELECT public.tx_checklist($1) r`, [tx]);
const opsSnap = async () => (await q(`SELECT
    (SELECT count(*) FROM public.document_requirements)::int r, (SELECT count(*) FROM public.port_appointments)::int a,
    (SELECT count(*) FROM public.transport_trips)::int t, (SELECT count(*) FROM public.operational_exceptions)::int x,
    (SELECT count(*) FROM public.operational_alerts)::int al, (SELECT count(*) FROM public.transaction_events)::int e`))[0];

async function secOpsCatalog() {
  section('B catalog: re-run, versions, RLS, grants, function privileges');
  await check('re-running migration B after A restores B (seeds existing orgs once)', async () => {
    if (!await runFile(path.join(SUPA, 'migrations', MIG_B))) return 'reload failed';
    const src = (await one(`SELECT prosrc s FROM pg_proc WHERE oid = 'public.cancel_declaration(uuid,text,jsonb)'::regprocedure`)).s;
    return src.includes('declaration_cancelled') || 'cancel_declaration is not B\'s version';
  });
  await check('re-running migration B again changes nothing (no duplicate requirements / rows / events)', async () => {
    const before = await opsSnap();
    if (!await runFile(path.join(SUPA, 'migrations', MIG_B))) return 'reload failed';
    const after = await opsSnap();
    return JSON.stringify(before) === JSON.stringify(after) || JSON.stringify({ before, after });
  });
  await check('schema_versions has 20261103000200 g3_operations', async () =>
    (await count(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261103000200' AND name = 'g3_operations'`)) === 1);
  const TABLES = ['document_requirements', 'port_appointments', 'transport_trips', 'operational_exceptions', 'operational_alerts'];
  for (const t of TABLES) {
    await check(`${t}: RLS on, audit trigger, no anon privilege`, async () => {
      const r = await one(`SELECT c.relrowsecurity rls,
                                  EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'trg_audit') audit,
                                  (SELECT count(*)::int FROM information_schema.role_table_grants x
                                    WHERE x.grantee = 'anon' AND x.table_schema = 'public' AND x.table_name = c.relname) anon
                             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname = 'public' AND c.relname = $1`, [t]);
      return (r && r.rls && r.audit && r.anon === 0) || JSON.stringify(r);
    });
  }
  await check('operational_alert_runs: RLS on, no privilege at all for anon / authenticated', async () => {
    const r = await q(`SELECT grantee FROM information_schema.role_table_grants WHERE table_schema = 'public'
                        AND table_name = 'operational_alert_runs' AND grantee IN ('anon','authenticated')`);
    const c = await q(`SELECT grantee FROM information_schema.column_privileges WHERE table_schema = 'public'
                        AND table_name = 'operational_alert_runs' AND grantee IN ('anon','authenticated')`);
    const rls = (await one(`SELECT relrowsecurity r FROM pg_class WHERE oid = 'public.operational_alert_runs'::regclass`)).r;
    return (rls && r.length === 0 && c.length === 0) || JSON.stringify({ rls, r, c });
  });
  await check('trip cost / sell columns hidden from the API SELECT grant', async () => {
    const r = await one(`SELECT has_column_privilege('authenticated', 'public.transport_trips', 'cost_amount', 'SELECT') a,
                                has_column_privilege('authenticated', 'public.transport_trips', 'sell_amount', 'SELECT') b,
                                has_column_privilege('authenticated', 'public.transport_trips', 'cost_basis', 'SELECT') c,
                                has_column_privilege('authenticated', 'public.transport_trips', 'status', 'SELECT') d`);
    return (!r.a && !r.b && !r.c && r.d) || JSON.stringify(r);
  });
  await check('appointments / trips / exceptions / alerts: no INSERT/UPDATE/DELETE grant (RPC only)', async () => {
    const r = await q(`SELECT table_name, privilege_type FROM information_schema.role_table_grants
                        WHERE grantee = 'authenticated' AND table_schema = 'public' AND privilege_type <> 'SELECT'
                          AND table_name IN ('port_appointments','transport_trips','operational_exceptions','operational_alerts')`);
    return r.length === 0 || r.map(x => x.table_name + ':' + x.privilege_type).join(', ');
  });
  await check('document_requirements: SELECT / INSERT / UPDATE granted, no DELETE', async () => {
    const r = (await q(`SELECT privilege_type p FROM information_schema.role_table_grants WHERE grantee = 'authenticated'
                         AND table_schema = 'public' AND table_name = 'document_requirements' ORDER BY 1`)).map(x => x.p);
    return (r.includes('SELECT') && r.includes('INSERT') && r.includes('UPDATE') && !r.includes('DELETE')) || r.join(',');
  });
  const RPCS = ['tx_checklist(uuid)', 'set_transaction_status(uuid,text,text,uuid,boolean)', 'platform_create_org(jsonb)',
    'create_appointment(jsonb,uuid)', 'reschedule_appointment(uuid,jsonb,text,uuid)', 'set_appointment_status(uuid,text,text)',
    'create_trip(jsonb,uuid)', 'update_trip(uuid,jsonb)', 'set_trip_status(uuid,text,timestamptz,text)', 'trip_finance(uuid[])',
    'set_container_return(uuid,jsonb)', 'create_exception(jsonb,uuid)', 'resolve_exception(uuid,text,text)',
    'cancel_declaration(uuid,text,jsonb)', 'transaction_completeness(uuid)', 'refresh_alerts(uuid)', 'list_alerts(uuid,jsonb)',
    'ack_alert(uuid)', 'resolve_alert(uuid,text)'];
  for (const fn of RPCS) {
    await check(`public.${fn}: SECURITY DEFINER, search_path pinned, authenticated yes, anon no`, async () => {
      const r = await one(`SELECT p.prosecdef d, coalesce(array_to_string(p.proconfig, ','), '') c,
                                  has_function_privilege('authenticated', p.oid, 'EXECUTE') x,
                                  has_function_privilege('anon', p.oid, 'EXECUTE') an
                             FROM pg_proc p WHERE p.oid = $1::regprocedure`, ['public.' + fn]);
      return (r.d && /search_path=/.test(r.c) && r.x && !r.an) || JSON.stringify(r);
    });
  }
  await check('exactly one overload per B RPC name (set_transaction_status keeps the 4-argument signature)', async () => {
    const r = await q(`SELECT p.proname, count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = ANY ($1) GROUP BY 1 HAVING count(*) > 1`,
      [RPCS.map(x => x.split('(')[0])]);
    return r.length === 0 || JSON.stringify(r);
  });
  await check('authenticated cannot execute B\'s app helpers (seed, refresh, causes, inserts)', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                          AND p.proname = ANY ($1)`,
      [['seed_document_requirements', 'tx_requirements', 'alert_causes', 'refresh_alerts_core', 'refresh_all_alerts',
        'exc_insert', 'appt_event', 'trip_event', 'appt_fields', 'trip_fields', 'g3_check_party', 'g3_check_fleet']]);
    return r.length === 0 || 'callable: ' + r.map(x => x.proname).join(', ');
  });
  await check('authenticated cannot execute state-changing SECURITY DEFINER helpers in app (A + B)', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND p.prosecdef AND p.provolatile = 'v' AND p.proname <> 'next_ref_checked'
                          AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`);
    return r.length === 0 || 'callable: ' + r.map(x => x.proname).join(', ');
  });
  await check('every SECURITY DEFINER function pins search_path', async () => {
    const r = await q(`SELECT n.nspname || '.' || p.proname f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname IN ('public','app') AND p.prosecdef
                          AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`);
    return r.length === 0 || r.map(x => x.f).join(', ');
  });
  await check('status_labels: B dictionaries present', async () => {
    const r = await q(`SELECT domain, count(*)::int n FROM public.status_labels WHERE domain IN ('requirement_status',
                        'appointment_status','trip_status','cost_basis','exception_kind','exception_source','exception_status',
                        'alert_kind','alert_severity','alert_status') GROUP BY 1`);
    const m = Object.fromEntries(r.map(x => [x.domain, x.n]));
    return (m.requirement_status === 4 && m.appointment_status === 6 && m.trip_status === 5 && m.cost_basis === 3
      && m.exception_kind === 10 && m.exception_source === 4 && m.exception_status === 4 && m.alert_kind === 7
      && m.alert_severity === 3 && m.alert_status === 3) || JSON.stringify(m);
  });
  await check('pg_cron absent locally: no schedule attempted, migration loaded', async () =>
    (await count(`SELECT count(*)::int n FROM pg_extension WHERE extname = 'pg_cron'`)) === 0);
  await expectErr('anon cannot call create_appointment', () => as('anon', `SELECT public.create_appointment('{}')`), /permission denied/);
  await expectErr('anon cannot call refresh_alerts', () => as('anon', `SELECT public.refresh_alerts($1)`, [A]), /permission denied/);

  // fixtures for B
  await q(`INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, container_count, goods_description,
             port_of_discharge, country, hs_code) VALUES
             ($1, $3, $4, $5, 'import', 'sea', 1, 'أجهزة', 'Jeddah Islamic Port', 'CN', '847130'),
             ($2, $3, $4, $5, 'import', 'sea', 0, 'قطع غيار', 'Dammam Port', 'CN', '870899')`, [TX6, TX7, A, JED, CL101]);
  await q(`UPDATE public.transactions SET operational_status = 'in_progress' WHERE id = $1`, [TX7]);
  await q(`INSERT INTO public.platform_admins (user_id, note) VALUES ($1, 'g3 tests')`, [U.plat]);
  S.terminal = (await as('staffA', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['terminal_operator'], 'محطة الحاويات الجنوبية') RETURNING id`, [A]))[0].id;
  S.yard2 = (await as('staffA', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['yard'], 'ساحة الفارغ الشمالية') RETURNING id`, [A]))[0].id;
  S.carrier2 = (await as('staffA', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier'], 'ناقل ثانٍ') RETURNING id`, [A]))[0].id;
  S.truck2 = (await as('staffA', `INSERT INTO public.trucks (org_id, carrier_id, plate_no) VALUES ($1, $2, 'XYZ 9876') RETURNING id`, [A, S.carrier2]))[0].id;
  pass('B fixtures: TX6, TX7, platform admin, terminal / yard / second carrier');
}

async function secRequirements() {
  section('document requirements: seed, admin edits, checklist (item 7)');
  await check('existing orgs were seeded once with the defaults (org A and org B: 15 rules each)', async () => {
    const r = await q(`SELECT org_id, count(*)::int n FROM public.document_requirements WHERE org_id = ANY ($1) GROUP BY 1`, [[A, B]]);
    return (r.length === 2 && r.every(x => x.n === 15)) || JSON.stringify(r);
  });
  await check('defaults: import sea B/L + invoice + packing list before customs_declaration, CoO optional, DO before appointment, receipt before completion', async () => {
    const r = await q(`SELECT document_kind k, required_for_stage s, is_optional o FROM public.document_requirements
                        WHERE org_id = $1 AND operation = 'import' AND mode = 'sea' ORDER BY 1`, [A]);
    const m = Object.fromEntries(r.map(x => [x.k, x.s + (x.o ? ':opt' : '')]));
    return (m.bill_of_lading === 'customs_declaration' && m.commercial_invoice === 'customs_declaration'
      && m.packing_list === 'customs_declaration' && m.certificate_of_origin === 'customs_declaration:opt'
      && m.delivery_order === 'appointment' && m.empty_return_receipt === 'operationally_complete') || JSON.stringify(m);
  });
  await check('air: the AWB is the bill_of_lading kind', async () =>
    (await count(`SELECT count(*)::int n FROM public.document_requirements WHERE org_id = $1 AND mode = 'air'
                   AND document_kind = 'bill_of_lading' AND note LIKE '%AWB%'`, [A])) === 1);
  await check('app.seed_document_requirements adds nothing to an org that already has rules', async () =>
    (await one(`SELECT app.seed_document_requirements($1) n`, [A])).n === 0);
  await check('platform_create_org seeds the defaults for the new org', async () => {
    const r = await rpc('plat', `SELECT public.platform_create_org($1) r`, [{ slug: 'org-c', name_ar: 'مؤسسة ج', ref_prefix: 'ORC',
      branch: { code: 'JED', name_ar: 'جدة' }, admin_email: 'admin-c@g3.example.com', idempotencyKey: newKey() }]);
    S.orgC = r.org_id;
    return (await count(`SELECT count(*)::int n FROM public.document_requirements WHERE org_id = $1`, [r.org_id])) === 15 || 'not seeded';
  });
  await check('staff read the rules; client and org B do not', async () => {
    const s = (await as('trJ', `SELECT count(*)::int n FROM public.document_requirements WHERE org_id = $1`, [A]))[0].n;
    const c = await denied('clientA', `SELECT 1 FROM public.document_requirements`);
    const b = await denied('staffB', `SELECT 1 FROM public.document_requirements WHERE org_id = $1`, [A]);
    return (s === 15 && c === true && b === true) || JSON.stringify({ s, c, b });
  });
  await check('org admin adds a port-specific rule (port trimmed, created_by stamped, audited)', async () => {
    const r = (await as('adminA', `INSERT INTO public.document_requirements (org_id, operation, mode, port, document_kind, required_for_stage, created_by)
                                    VALUES ($1, 'import', 'sea', '  jeddah islamic port ', 'saber_certificate', 'customs_declaration', $2)
                                    RETURNING id, port, created_by`, [A, U.staffA]))[0];
    S.reqPort = r.id;
    const a = await count(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'document_requirements' AND row_id = $1`, [r.id]);
    return (r.port === 'jeddah islamic port' && r.created_by === U.adminA && a === 1) || JSON.stringify({ r, a });
  });
  await expectErr('clearance staff cannot add rules (org admin only)', () => as('clrJ',
    `INSERT INTO public.document_requirements (org_id, document_kind, required_for_stage) VALUES ($1, 'other', 'transport')`, [A]), /row-level security/);
  await check('operations manager cannot edit rules (no row matched)', () => denied('opsJ',
    `UPDATE public.document_requirements SET is_active = false WHERE id = $1 RETURNING id`, [S.reqPort]));
  await expectErr('org B admin cannot add a rule to org A', () => as('adminB',
    `INSERT INTO public.document_requirements (org_id, document_kind, required_for_stage) VALUES ($1, 'other', 'transport')`, [A]), /row-level security/);
  await expectErr('unknown document kind refused', () => as('adminA',
    `INSERT INTO public.document_requirements (org_id, document_kind, required_for_stage) VALUES ($1, 'selfie', 'transport')`, [A]), /check constraint|violates/);
  await expectErr('stage "new" is not a requirement stage', () => as('adminA',
    `INSERT INTO public.document_requirements (org_id, document_kind, required_for_stage) VALUES ($1, 'other', 'new')`, [A]), /check constraint|violates/);
  await expectErr('duplicate rule refused', () => as('adminA',
    `INSERT INTO public.document_requirements (org_id, operation, mode, document_kind, required_for_stage) VALUES ($1, 'import', 'sea', 'packing_list', 'customs_declaration')`, [A]), /document_requirements_rule_uidx|duplicate/);
  await expectErr('no DELETE on rules (deactivate instead)', () => as('adminA', `DELETE FROM public.document_requirements WHERE id = $1`, [S.reqPort]), /permission denied/);
  await expectErr('rule org_id is immutable', () => as('adminA', `UPDATE public.document_requirements SET org_id = $2 WHERE id = $1`, [S.reqPort, B]), /MRS_IMMUTABLE|row-level security/);

  await check('tx_checklist TX6: rules for import / sea / its port, all missing, CoO optional, receipt applies (1 container declared)', async () => {
    const r = await checklist('clrJ', TX6);
    const m = Object.fromEntries(r.items.map(i => [i.document_kind, i]));
    return (r.configured && r.stage === 'new' && r.next_stage === 'in_progress'
      && ['bill_of_lading', 'commercial_invoice', 'packing_list', 'saber_certificate', 'delivery_order', 'empty_return_receipt']
        .every(k => m[k] && m[k].status === 'missing' && m[k].blocking && !m[k].optional)
      && m.certificate_of_origin.optional && !m.certificate_of_origin.blocking && m.saber_certificate
      && !!m.bill_of_lading.label_ar && !!m.bill_of_lading.stage_label_ar) || JSON.stringify(r);
  });
  await check('a port rule does not apply to another port (TX7 has no saber_certificate item)', async () => {
    const r = await checklist('clrJ', TX7);
    return !r.items.some(i => i.document_kind === 'saber_certificate') || JSON.stringify(r.items.map(i => i.document_kind));
  });
  await check('deactivated rule disappears from the checklist', async () => {
    await as('adminA', `UPDATE public.document_requirements SET is_active = false WHERE id = $1`, [S.reqPort]);
    const r = await checklist('clrJ', TX6);
    return !r.items.some(i => i.document_kind === 'saber_certificate') || 'still listed';
  });
  await check('TX7 (no containers): empty_return_receipt is not_applicable, never blocking', async () => {
    const r = await checklist('clrJ', TX7);
    const i = r.items.find(x => x.document_kind === 'empty_return_receipt');
    return (i && i.status === 'not_applicable' && !i.blocking) || JSON.stringify(i);
  });
  await check('declared-but-unreviewed → unreviewed (still blocking); confirmed → satisfied with the document id', async () => {
    S.inv6 = await ownerDoc(A, TX6, 'commercial_invoice');
    const a = (await checklist('clrJ', TX6)).items.find(i => i.document_kind === 'commercial_invoice');
    await as('clrJ', `UPDATE public.documents SET classification = 'commercial_invoice', classification_status = 'confirmed' WHERE id = $1`, [S.inv6]);
    const b = (await checklist('clrJ', TX6)).items.find(i => i.document_kind === 'commercial_invoice');
    return (a.status === 'unreviewed' && a.blocking && b.status === 'satisfied' && !b.blocking && b.document_ids[0] === S.inv6) || JSON.stringify({ a, b });
  });
  await check('a document reclassified to another kind no longer counts for its declared kind', async () => {
    const d = await ownerDoc(A, TX6, 'packing_list', 'other', 'reclassified');
    const i = (await checklist('clrJ', TX6)).items.find(x => x.document_kind === 'packing_list');
    S.otherDoc6 = d;
    return i.status === 'missing' || JSON.stringify(i);
  });
  await check('a voided confirmed document does not count', async () => {
    const d = await ownerDoc(A, TX6, 'packing_list', 'packing_list', 'confirmed');
    await q(`UPDATE public.documents SET voided_at = now(), void_reason = 'نسخة خاطئة' WHERE id = $1`, [d]);
    const i = (await checklist('clrJ', TX6)).items.find(x => x.document_kind === 'packing_list');
    return i.status === 'missing' || JSON.stringify(i);
  });
  await check('completeness now uses the rules (delivery_order for appointment, optional CoO not in the score)', async () => {
    const r = await rpc('clrJ', `SELECT public.transaction_completeness($1) r`, [TX6]);
    const dOrder = r.missing.find(m => m.document === 'delivery_order');
    const coo = r.missing.find(m => m.document === 'certificate_of_origin');
    return (r.requirements_configured === true && dOrder && dOrder.required_for === 'appointment' && coo && coo.optional === true
      && !r.missing.some(m => m.document === 'commercial_invoice') && r.advisory === true) || JSON.stringify(r);
  });
  await expectErr('tx_checklist: other branch → MRS_NOT_FOUND', () => checklist('trD', TX6), /MRS_NOT_FOUND/);
  await expectErr('tx_checklist: org B → MRS_NOT_FOUND', () => checklist('staffB', TX6), /MRS_NOT_FOUND/);
  await expectErr('tx_checklist: client → MRS_NOT_FOUND', () => checklist('clientA', TX6), /MRS_NOT_FOUND/);
}

async function secDocsGate() {
  section('MRS_DOCS_MISSING gate in set_transaction_status (item 7)');
  await check('new → in_progress: no rule for that stage, allowed', async () => (await status('clrJ', TX6, 'in_progress')).to === 'in_progress');
  await expectErr('in_progress → customs_declaration refused with the missing kinds (optional CoO not listed)',
    () => status('clrJ', TX6, 'customs_declaration'), /MRS_DOCS_MISSING[\s\S]*bill_of_lading,packing_list/);
  await check('the detail lists exactly the missing mandatory kinds', async () => {
    try { await status('clrJ', TX6, 'customs_declaration'); return 'succeeded'; }
    catch (e) { return e.detail === 'bill_of_lading,packing_list' || 'detail=' + e.detail; }
  });
  await check('the refusal blocks only that move: the transaction stays usable (declaration added, status unchanged)', async () => {
    const d = await rpc('clrJ', `SELECT public.add_declaration($1, '{"declaration_no":"G3B-DEC-0006"}') r`, [TX6]);
    S.d6 = d.id;
    const t = await txRow(TX6);
    return (d.status === 'submitted' && t.operational_status === 'in_progress') || JSON.stringify({ d, s: t.operational_status });
  });
  await expectErr('clearance staff cannot override even with a reason', () => status('clrJ', TX6, 'customs_declaration', 'عاجل'), /MRS_DOCS_MISSING/);
  await expectErr('clearance staff with the explicit override flag → MRS_FORBIDDEN docs_override', () => statusOv('clrJ', TX6, 'customs_declaration', 'عاجل'), /MRS_FORBIDDEN.*docs_override/);
  await expectErr('operations manager without a reason → still MRS_DOCS_MISSING', () => status('opsJ', TX6, 'customs_declaration'), /MRS_DOCS_MISSING/);
  // regression (review): a routine note never doubles as an override
  await expectErr('operations manager with a routine note but no override flag → still MRS_DOCS_MISSING', () =>
    status('opsJ', TX6, 'customs_declaration', 'تم رفع البيان بواسطة أحمد'), /MRS_DOCS_MISSING/);
  await expectErr('override flag without a reason → MRS_NOTE_REQUIRED docs_override', () => statusOv('opsJ', TX6, 'customs_declaration'), /MRS_NOTE_REQUIRED.*docs_override/);
  await check('operations manager overrides with a reason → moved + internal docs_override event with kinds and reason', async () => {
    const k = newKey();
    const r = await statusOv('opsJ', TX6, 'customs_declaration', 'الجمارك قبلت البوليصة إلكترونيًا', k);
    const e = await one(`SELECT note, visible_to_client v, payload FROM public.transaction_events
                          WHERE transaction_id = $1 AND event_type = 'docs_override' ORDER BY id DESC LIMIT 1`, [TX6]);
    const replay = await statusOv('opsJ', TX6, 'customs_declaration', 'الجمارك قبلت البوليصة إلكترونيًا', k);
    const n = await count(`SELECT count(*)::int n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'docs_override'`, [TX6]);
    return (r.to === 'customs_declaration' && JSON.stringify(r.docs_override) === '["bill_of_lading","packing_list"]'
      && e && !e.v && e.note === 'الجمارك قبلت البوليصة إلكترونيًا' && JSON.stringify(e.payload.kinds) === '["bill_of_lading","packing_list"]'
      && e.payload.for_event === r.event_id && replay.replayed === true && replay.event_id === r.event_id && n === 1)
      || JSON.stringify({ r, e, replay, n });
  });
  await check('client sees the status event, never the override', async () => {
    const r = await as('clientA', `SELECT event_type, note FROM public.transaction_events WHERE transaction_id = $1`, [TX6]);
    return (r.some(x => x.event_type === 'operational_status') && !r.some(x => x.event_type === 'docs_override' || x.note)) || JSON.stringify(r);
  });
  await check('backward correction is never gated (senior + reason)', async () =>
    (await status('opsJ', TX6, 'in_progress', 'تصحيح للاختبار')).to === 'in_progress');
  await check('with the documents confirmed the normal move passes without an override', async () => {
    await ownerDoc(A, TX6, 'bill_of_lading', 'bill_of_lading', 'confirmed');
    await ownerDoc(A, TX6, 'packing_list', 'packing_list', 'reclassified');
    const r = await status('clrJ', TX6, 'customs_declaration');
    return (r.to === 'customs_declaration' && r.docs_override === null) || JSON.stringify(r);
  });
  await expectErr('customs_declaration → appointment needs the delivery order', () => status('trJ', TX6, 'appointment'), /MRS_DOCS_MISSING[\s\S]*delivery_order/);
  await check('an unreviewed delivery order still blocks', async () => {
    S.do6 = await ownerDoc(A, TX6, 'delivery_order');
    try { await status('trJ', TX6, 'appointment'); return 'moved'; }
    catch (e) { return (/MRS_DOCS_MISSING/.test(e.message) && e.detail === 'delivery_order') || errText(e); }
  });
  await check('a stage skip passes over a stage: its missing documents count too (override lists delivery_order)', async () => {
    // a stage-skip note alone is refused; the explicit override (same note as its reason) passes
    let plain = '';
    try { await status('opsJ', TX6, 'transport', 'تخطٍّ موثق للاختبار'); plain = 'moved'; } catch (e) { plain = errText(e); }
    if (!/MRS_DOCS_MISSING/.test(plain)) return 'stage-skip note bypassed the gate: ' + plain;
    const r = await statusOv('opsJ', TX6, 'transport', 'تخطٍّ موثق للاختبار');
    const back = await status('opsJ', TX6, 'customs_declaration', 'تراجع بعد الاختبار');
    return (JSON.stringify(r.docs_override) === '["delivery_order"]' && back.to === 'customs_declaration') || JSON.stringify({ r, back });
  });
  await check('confirmed delivery order → transport staff moves to appointment', async () => {
    await as('clrJ', `UPDATE public.documents SET classification = 'delivery_order', classification_status = 'confirmed' WHERE id = $1`, [S.do6]);
    return (await status('trJ', TX6, 'appointment')).to === 'appointment';
  });
  await check('an org without rules is never gated (org B rules removed → B_TX reaches customs_declaration with no documents)', async () => {
    await q(`DELETE FROM public.document_requirements WHERE org_id = $1`, [B]);
    await status('staffB', B_TX, 'in_progress');
    const r = await status('staffB', B_TX, 'customs_declaration');
    return (r.to === 'customs_declaration' && r.docs_override === null) || JSON.stringify(r);
  });
}

async function secAppointments() {
  section('port appointments: create / confirm / reschedule chain / status (item 8)');
  const at = h => new Date(Date.now() + h * 3600e3).toISOString();
  const create = (who, p, k) => rpc(who, `SELECT public.create_appointment($1, $2) r`, [p, k || null]);
  S.ct6 = (await as('trJ', `INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, 'TSTU0000006') RETURNING id`, [A, TX6]))[0].id;
  const K = newKey();
  const base = { transaction_id: TX6, container_id: S.ct6, terminal_party_id: S.terminal, appointment_at: at(30), window_minutes: 120,
    appointment_no: 'apt 001', driver_id: S.driver, truck_id: S.truck };
  await check('transport staff creates a requested appointment (number normalized, internal event)', async () => {
    const r = await create('trJ', base, K);
    S.ap1 = r.id;
    const e = await one(`SELECT visible_to_client v, payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'appointment'
                          ORDER BY id DESC LIMIT 1`, [TX6]);
    return (r.status === 'requested' && r.appointment_no === 'APT001' && r.driver_id === S.driver && e && !e.v
      && e.payload.appointment_id === r.id) || JSON.stringify({ r, e });
  });
  await check('idempotent replay: same key → same appointment, replayed, one row', async () => {
    const r = await create('trJ', base, K);
    const n = await count(`SELECT count(*)::int n FROM public.port_appointments WHERE transaction_id = $1`, [TX6]);
    return (r.id === S.ap1 && r.replayed === true && n === 1) || JSON.stringify({ r, n });
  });
  await expectErr('same key + different payload → MRS_IDEMPOTENCY_CONFLICT', () => create('trJ', { ...base, window_minutes: 30 }, K), /MRS_IDEMPOTENCY_CONFLICT/);
  await expectErr('terminal must be a terminal / yard party', () => create('trJ', { ...base, terminal_party_id: S.agent }), /MRS_INVALID.*terminal_party_id/);
  await expectErr('container of another transaction refused', () => create('trJ', { ...base, container_id: S.ct4 }), /MRS_INVALID.*container_id/);
  await expectErr('inactive party refused (deactivated yard)', () => create('trJ', { ...base, terminal_party_id: S.yard }), /MRS_INVALID.*terminal_party_id/);
  await expectErr('appointment_at required', () => create('trJ', { transaction_id: TX6 }), /MRS_REQUIRED.*appointment_at/);
  await expectErr('malformed appointment_at refused', () => create('trJ', { transaction_id: TX6, appointment_at: 'tomorrow' }), /MRS_INVALID.*appointment_at/);
  await expectErr('unknown key refused', () => create('trJ', { transaction_id: TX6, appointment_at: at(5), driver_national_id: '1' }), /MRS_INVALID.*unknown_key/);
  await expectErr('other branch → MRS_NOT_FOUND', () => create('trD', { transaction_id: TX6, appointment_at: at(5) }), /MRS_NOT_FOUND/);
  await expectErr('accountant (not a transport writer) → MRS_FORBIDDEN', () => create('accA', { transaction_id: TX6, appointment_at: at(5) }), /MRS_FORBIDDEN/);
  await expectErr('org B → MRS_NOT_FOUND', () => create('staffB', { transaction_id: TX6, appointment_at: at(5) }), /MRS_NOT_FOUND/);
  await expectErr('client → MRS_NOT_FOUND', () => create('clientA', { transaction_id: TX6, appointment_at: at(5) }), /MRS_NOT_FOUND/);

  const setSt = (who, id, s, reason) => rpc(who, `SELECT public.set_appointment_status($1, $2, $3) r`, [id, s, reason || null]);
  await check('confirm → client-visible event with time + window + container number + opaque ref only', async () => {
    const r = await setSt('trJ', S.ap1, 'confirmed');
    const e = await as('clientA', `SELECT payload, note FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'appointment'`, [TX6]);
    return (r.status === 'confirmed' && e.length === 1 && e[0].note === null
      && JSON.stringify(Object.keys(e[0].payload).sort()) === '["appointment_at","appointment_ref","container_no","op","window_minutes"]'
      && e[0].payload.window_minutes === 120 && e[0].payload.container_no === 'TSTU0000006'
      && e[0].payload.appointment_ref !== S.ap1 && !JSON.stringify(e[0].payload).includes(S.ap1)) || JSON.stringify({ r, e });
  });
  await check('client cannot read the appointment rows (driver / truck / terminal stay internal)', () =>
    denied('clientA', `SELECT 1 FROM public.port_appointments WHERE transaction_id = $1`, [TX6]));
  await expectErr('status rescheduled only through reschedule_appointment', () => setSt('trJ', S.ap1, 'rescheduled', 'x'), /MRS_BAD_TRANSITION.*use_reschedule_appointment/);
  const resched = (who, id, p, reason, k) => rpc(who, `SELECT public.reschedule_appointment($1, $2, $3, $4) r`, [id, p, reason || null, k || null]);
  await expectErr('reschedule needs a reason', () => resched('trJ', S.ap1, { appointment_at: at(40) }), /MRS_NOTE_REQUIRED/);
  const KR = newKey();
  const pR = { appointment_at: at(48), appointment_no: 'APT002' };
  await check('reschedule keeps the old row (rescheduled + reason) and adds a linked new one inheriting driver / truck / terminal', async () => {
    const r = await resched('trJ', S.ap1, pR, 'المحطة أجّلت الموعد', KR);
    S.ap2 = r.appointment.id;
    const old = await one(`SELECT status, status_reason, appointment_no FROM public.port_appointments WHERE id = $1`, [S.ap1]);
    return (old.status === 'rescheduled' && old.status_reason === 'المحطة أجّلت الموعد' && old.appointment_no === 'APT001'
      && r.appointment.rescheduled_from_id === S.ap1 && r.appointment.status === 'requested'
      && r.appointment.driver_id === S.driver && r.appointment.truck_id === S.truck && r.appointment.terminal_party_id === S.terminal
      && r.appointment.container_id === S.ct6 && r.appointment.window_minutes === 120
      && JSON.stringify(r.chain) === JSON.stringify([S.ap1, S.ap2])) || JSON.stringify({ r, old });
  });
  await check('reschedule replay → same result, no extra row', async () => {
    const r = await resched('trJ', S.ap1, { appointment_at: undefined }, 'x', KR).catch(e => e);
    const r2 = await resched('trJ', S.ap1, pR, 'المحطة أجّلت الموعد', KR).catch(e => e);
    const n = await count(`SELECT count(*)::int n FROM public.port_appointments WHERE transaction_id = $1`, [TX6]);
    return (/MRS_IDEMPOTENCY_CONFLICT/.test(errText(r)) && r2.replayed === true && r2.appointment.id === S.ap2 && n === 2) || JSON.stringify({ r: errText(r), r2, n });
  });
  await expectErr('a rescheduled row cannot be rescheduled again', () => resched('trJ', S.ap1, { appointment_at: at(50) }, 'مرة أخرى'), /MRS_BAD_TRANSITION.*rescheduled/);
  await check('second reschedule → chain of 3, oldest first', async () => {
    const r = await resched('trJ', S.ap2, { appointment_at: at(72), driver_id: null }, 'تغيير السائق');
    S.ap3 = r.appointment.id;
    return (JSON.stringify(r.chain) === JSON.stringify([S.ap1, S.ap2, S.ap3]) && r.appointment.driver_id === null) || JSON.stringify(r);
  });
  await expectErr('requested → completed refused (confirm first)', () => setSt('trJ', S.ap3, 'completed'), /MRS_BAD_TRANSITION/);
  await expectErr('missed needs a reason', () => setSt('trJ', S.ap3, 'missed'), /MRS_NOTE_REQUIRED/);
  await check('confirm then complete', async () => {
    await setSt('trJ', S.ap3, 'confirmed');
    return (await setSt('trJ', S.ap3, 'completed')).status === 'completed';
  });
  await expectErr('completed is final', () => setSt('trJ', S.ap3, 'cancelled', 'x'), /MRS_BAD_TRANSITION/);
  await check('nothing lost: 3 rows (rescheduled, rescheduled, completed), events for each change', async () => {
    const r = (await q(`SELECT status FROM public.port_appointments WHERE transaction_id = $1 ORDER BY created_at`, [TX6])).map(x => x.status);
    const e = await count(`SELECT count(*)::int n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'appointment' AND NOT visible_to_client`, [TX6]);
    return (JSON.stringify(r) === '["rescheduled","rescheduled","completed"]' && e >= 7) || JSON.stringify({ r, e });
  });
  // regression (review): a confirmed slot that stops being valid is withdrawn for the client (same opaque ref)
  await check('client events: the rescheduled confirmed slot is withdrawn, the completed one says completed', async () => {
    const e = (await as('clientA', `SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'appointment' ORDER BY id`, [TX6]))
      .map(x => x.payload);
    const ops = e.map(x => x.op).join(',');
    return (ops === 'confirmed,withdrawn,confirmed,completed' && e[0].appointment_ref === e[1].appointment_ref
      && e[2].appointment_ref === e[3].appointment_ref && e[0].appointment_ref !== e[2].appointment_ref) || JSON.stringify(e);
  });
  await check('confirmed → cancelled and confirmed → missed each withdraw the slot for the client; missed can still be rescheduled', async () => {
    const c = await create('trJ', { transaction_id: TX6, appointment_at: at(30), status: 'confirmed' });
    await setSt('trJ', c.id, 'cancelled', 'المحطة أغلقت');
    const m = await create('trJ', { transaction_id: TX6, appointment_at: at(31), status: 'confirmed' });
    await setSt('trJ', m.id, 'missed', 'تأخر السائق');
    const r = await resched('trJ', m.id, { appointment_at: at(33) }, 'موعد بديل');
    await setSt('trJ', r.appointment.id, 'cancelled', 'لم يعد مطلوبًا');
    const e = (await as('clientA', `SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'appointment' ORDER BY id`, [TX6]))
      .map(x => x.payload).slice(4);
    return (e.map(x => x.op).join(',') === 'confirmed,withdrawn,confirmed,withdrawn' && e[0].appointment_ref === e[1].appointment_ref
      && e[2].appointment_ref === e[3].appointment_ref && r.rescheduled.status === 'rescheduled') || JSON.stringify(e);
  });
  await check('other branch / org B see no appointment rows', async () => {
    const a = await denied('trD', `SELECT 1 FROM public.port_appointments WHERE transaction_id = $1`, [TX6]);
    const b = await denied('staffB', `SELECT 1 FROM public.port_appointments`);
    return (a === true && b === true) || JSON.stringify({ a, b });
  });
  await expectErr('set_appointment_status: other branch → MRS_NOT_FOUND', () => setSt('trD', S.ap3, 'cancelled', 'x'), /MRS_NOT_FOUND/);
  await expectErr('reschedule: org B → MRS_NOT_FOUND', () => resched('staffB', S.ap3, { appointment_at: at(9) }, 'x'), /MRS_NOT_FOUND/);
}

async function secTrips() {
  section('transport trips: legs, statuses, cost / sell privacy (item 9)');
  const create = (who, p, k) => rpc(who, `SELECT public.create_trip($1, $2) r`, [p, k || null]);
  const upd = (who, id, p) => rpc(who, `SELECT public.update_trip($1, $2) r`, [id, p]);
  const setSt = (who, id, s, at, note) => rpc(who, `SELECT public.set_trip_status($1, $2, $3, $4) r`, [id, s, at || null, note || null]);
  const fin = (who, ids) => rpc(who, `SELECT public.trip_finance($1) r`, [ids]);
  const K = newKey();
  const leg1 = { transaction_id: TX6, container_id: S.ct6, carrier_id: S.carrier, driver_id: S.driver, truck_id: S.truck,
    origin: 'ميناء جدة الإسلامي', destination: 'مستودع العميل', planned_at: new Date(Date.now() + 86400e3).toISOString() };
  await check('transport staff creates leg 1 (auto leg number, planned, no finance fields in the result)', async () => {
    const r = await create('trJ', leg1, K);
    S.trip1 = r.id;
    return (r.leg_no === 1 && r.status === 'planned' && !('cost_amount' in r) && !('sell_amount' in r)) || JSON.stringify(r);
  });
  await check('create_trip replay → same trip', async () => {
    const r = await create('trJ', leg1, K);
    return (r.id === S.trip1 && r.replayed === true && (await count(`SELECT count(*)::int n FROM public.transport_trips WHERE transaction_id = $1`, [TX6])) === 1) || JSON.stringify(r);
  });
  await check('second leg on the same container gets leg 2; several legs allowed', async () => {
    const r = await create('trJ', { transaction_id: TX6, container_id: S.ct6, origin: 'مستودع العميل', destination: 'ساحة الفارغ' });
    S.trip2 = r.id;
    return r.leg_no === 2 || JSON.stringify(r);
  });
  await expectErr('transport staff cannot set a cost (MRS_FORBIDDEN cost)', () => create('trJ', { transaction_id: TX6, cost_amount: 100 }), /MRS_FORBIDDEN.*cost/);
  await expectErr('carrier must be a carrier party', () => create('trJ', { transaction_id: TX6, carrier_id: S.agent }), /MRS_INVALID.*carrier_id/);
  await expectErr('truck of another carrier refused', () => create('trJ', { transaction_id: TX6, carrier_id: S.carrier, truck_id: S.truck2 }), /MRS_INVALID.*truck_id/);
  await expectErr('other branch → MRS_NOT_FOUND', () => create('trD', { transaction_id: TX6 }), /MRS_NOT_FOUND/);
  await expectErr('org B → MRS_NOT_FOUND', () => create('staffB', { transaction_id: TX6 }), /MRS_NOT_FOUND/);
  await check('operations manager sets cost + sell (amounts never in the event)', async () => {
    const r = await upd('opsJ', S.trip1, { cost_amount: '1,500.50', sell_amount: 2000, cost_basis: 'agreed' });
    const e = await one(`SELECT payload::text p FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'trip' ORDER BY id DESC LIMIT 1`, [TX6]);
    const pl = JSON.parse(e.p);
    return (JSON.stringify(r.changed) === '["cost_amount","cost_basis","sell_amount"]' && !('cost_amount' in pl) && !('sell_amount' in pl)
      && !e.p.includes('1500.5')) || JSON.stringify({ r, e });
  });
  await expectErr('transport staff cannot SELECT cost_amount', () => as('trJ', `SELECT cost_amount FROM public.transport_trips`), /permission denied/);
  await expectErr('transport staff cannot SELECT sell_amount', () => as('trJ', `SELECT sell_amount FROM public.transport_trips`), /permission denied/);
  await expectErr('select * fails closed for everyone (explicit columns)', () => as('opsJ', `SELECT * FROM public.transport_trips`), /permission denied/);
  await check('transport staff reads the operational columns', async () =>
    (await as('trJ', `SELECT count(*)::int n FROM public.transport_trips WHERE transaction_id = $1 AND status = 'planned'`, [TX6]))[0].n === 2);
  await check('trip_finance: ops manager + accountant get amounts; transport / clearance staff, other branch, org B, client get nothing', async () => {
    const o = await fin('opsJ', [S.trip1]);
    const a = await fin('accA', [S.trip1]);
    const t = await fin('trJ', [S.trip1]);
    const c = await fin('clrJ', [S.trip1]);
    const d = await fin('trD', [S.trip1]);
    const b = await fin('staffB', [S.trip1]);
    const cl = await fin('clientA', [S.trip1]);
    return (Number(o[S.trip1].cost_amount) === 1500.5 && Number(o[S.trip1].sell_amount) === 2000 && o[S.trip1].cost_basis === 'agreed'
      && Number(a[S.trip1].sell_amount) === 2000 && [t, c, d, b, cl].every(x => Object.keys(x).length === 0)) || JSON.stringify({ o, a, t, c, d, b, cl });
  });
  await check('accountant may change cost only', async () => (await upd('accA', S.trip1, { cost_basis: 'invoice' })).changed[0] === 'cost_basis');
  await expectErr('accountant cannot change operational fields', () => upd('accA', S.trip1, { origin: 'x' }), /MRS_FORBIDDEN.*role/);
  await expectErr('transport staff cannot change cost via update_trip', () => upd('trJ', S.trip1, { sell_amount: 1 }), /MRS_FORBIDDEN.*cost/);
  await expectErr('negative amount refused', () => upd('opsJ', S.trip1, { cost_amount: '-5' }), /MRS_INVALID.*cost_amount/);
  await expectErr('bad currency refused', () => upd('opsJ', S.trip1, { sell_currency: 'riyal' }), /MRS_INVALID|MRS_TOO_LONG/);
  await check('status: dispatched → loaded (loaded_at) → delivered (unloaded_at)', async () => {
    await setSt('trJ', S.trip1, 'dispatched');
    const l = await setSt('trJ', S.trip1, 'loaded', new Date(Date.now() - 3600e3).toISOString());
    const d = await setSt('trJ', S.trip1, 'delivered');
    return (l.loaded_at && d.unloaded_at && d.status === 'delivered' && d.from === 'loaded') || JSON.stringify({ l, d });
  });
  await expectErr('delivered is final', () => setSt('trJ', S.trip1, 'cancelled', null, 'x'), /MRS_BAD_TRANSITION/);
  await check('leg 2: skipping ahead is allowed, backward is not', async () => {
    await setSt('trJ', S.trip2, 'loaded');
    try { await setSt('trJ', S.trip2, 'dispatched'); return 'went backward'; } catch (e) { return /MRS_BAD_TRANSITION/.test(e.message) || errText(e); }
  });
  await expectErr('cancel needs a note', () => setSt('trJ', S.trip2, 'cancelled'), /MRS_NOTE_REQUIRED/);
  await expectErr('future timestamp refused', () => setSt('trJ', S.trip2, 'delivered', new Date(Date.now() + 3 * 86400e3).toISOString()), /MRS_INVALID.*at/);
  await check('cancel with note keeps the reason; a cancelled leg refuses operational edits but keeps finance edits', async () => {
    const c = await setSt('trJ', S.trip2, 'cancelled', null, 'تعطل الشاحنة');
    let opsRefused = false;
    try { await upd('trJ', S.trip2, { origin: 'x' }); } catch (e) { opsRefused = /MRS_BAD_TRANSITION/.test(e.message); }
    const f = await upd('opsJ', S.trip2, { cost_amount: 300, cost_basis: 'invoice' });
    return (c.status === 'cancelled' && c.status_reason === 'تعطل الشاحنة' && opsRefused && f.changed.length === 2) || JSON.stringify({ c, opsRefused, f });
  });
  await check('client sees no trip rows and no trip events', async () => {
    const t = await denied('clientA', `SELECT id FROM public.transport_trips`);
    const e = (await as('clientA', `SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'trip'`))[0].n;
    return (t === true && e === 0) || JSON.stringify({ t, e });
  });
  await expectErr('set_trip_status: other branch → MRS_NOT_FOUND', () => setSt('trD', S.trip1, 'cancelled', null, 'x'), /MRS_NOT_FOUND/);
  await expectErr('update_trip: org B → MRS_NOT_FOUND', () => upd('staffB', S.trip1, { origin: 'x' }), /MRS_NOT_FOUND/);
}

async function secEmptyReturn() {
  section('empty return plan + proof rule (item 10)');
  const setRet = (who, id, p) => rpc(who, `SELECT public.set_container_return($1, $2) r`, [id, p]);
  S.note6 = await ownerDoc(A, TX6, 'empty_return_note', 'empty_return_note', 'confirmed');
  await check('set_container_return: deadline + yard (location filled with its name) + Return Note as instruction', async () => {
    const r = await setRet('trJ', S.ct6, { return_deadline: '2026-11-20', return_yard_party_id: S.yard2, return_instruction_document_id: S.note6 });
    const e = await one(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'container' ORDER BY id DESC LIMIT 1`, [TX6]);
    return (r.return_deadline === '2026-11-20' && r.return_location === 'ساحة الفارغ الشمالية' && r.return_instruction_document_id === S.note6
      && r.return_status === 'pending' && e.payload.op === 'return_plan' && e.payload.changed.length === 4) || JSON.stringify({ r, e });
  });
  await expectErr('yard must be a yard / terminal party', () => setRet('trJ', S.ct6, { return_yard_party_id: S.carrier2 }), /MRS_INVALID.*return_yard_party_id/);
  await expectErr('inactive yard refused', () => setRet('trJ', S.ct6, { return_yard_party_id: S.yard }), /MRS_INVALID.*return_yard_party_id/);
  await expectErr('instruction document of another transaction refused', () => setRet('trJ', S.ct6, { return_instruction_document_id: S.inv4 }), /MRS_INVALID.*return_instruction_document_id/);
  await expectErr('direct write cannot point the instruction at another transaction either', () => as('trJ',
    `UPDATE public.containers SET return_instruction_document_id = $2 WHERE id = $1`, [S.ct6, S.inv4]), /MRS_INVALID/);
  await expectErr('empty payload refused', () => setRet('trJ', S.ct6, {}), /MRS_REQUIRED/);
  await expectErr('unknown key refused (no proof through this RPC)', () => setRet('trJ', S.ct6, { return_status: 'returned_verified' }), /MRS_INVALID.*unknown_key/);
  await expectErr('accountant → MRS_FORBIDDEN', () => setRet('accA', S.ct6, { return_location: 'x' }), /MRS_FORBIDDEN/);
  await expectErr('other branch → MRS_NOT_FOUND', () => setRet('trD', S.ct6, { return_location: 'x' }), /MRS_NOT_FOUND/);
  await expectErr('the Return Note is never proof (returned_verified refused)', () => as('trJ',
    `UPDATE public.containers SET return_status = 'returned_verified', evidence_document_id = $2 WHERE id = $1`, [S.ct6, S.note6]), /MRS_EVIDENCE_INVALID/);
  await check('attaching evidence stamps evidence_received_at', async () => {
    S.rcpt6 = await ownerDoc(A, TX6, 'empty_return_receipt');
    const r = (await as('trJ', `UPDATE public.containers SET return_status = 'evidence_submitted', evidence_document_id = $2 WHERE id = $1
                                 RETURNING evidence_received_at`, [S.ct6, S.rcpt6]))[0];
    return r.evidence_received_at !== null || JSON.stringify(r);
  });
  await expectErr('an unreviewed receipt cannot verify', () => as('trJ',
    `UPDATE public.containers SET return_status = 'returned_verified' WHERE id = $1`, [S.ct6]), /MRS_EVIDENCE_INVALID/);
  await check('a confirmed receipt verifies (existing path) → empty_returned; client sees the return event', async () => {
    await as('clrJ', `UPDATE public.documents SET classification = 'empty_return_receipt', classification_status = 'confirmed' WHERE id = $1`, [S.rcpt6]);
    const r = (await as('trJ', `UPDATE public.containers SET return_status = 'returned_verified' WHERE id = $1 RETURNING operational_state`, [S.ct6]))[0];
    const e = await as('clientA', `SELECT to_status FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'container_return'`, [TX6]);
    return (r.operational_state === 'empty_returned' && e.some(x => x.to_status === 'returned_verified')) || JSON.stringify({ r, e });
  });
  await expectErr('a verified container\'s plan is closed', () => setRet('trJ', S.ct6, { return_location: 'x' }), /MRS_BAD_TRANSITION/);
  await check('client reads the return columns of its container', async () => {
    const r = await as('clientA', `SELECT return_deadline, return_status, return_yard_party_id, evidence_received_at FROM public.containers WHERE id = $1`, [S.ct6]);
    return (r.length === 1 && r[0].return_status === 'returned_verified') || JSON.stringify(r);
  });
}

async function secExceptions() {
  section('operational exceptions + auto exception from cancel_declaration (item 11)');
  const create = (who, p, k) => rpc(who, `SELECT public.create_exception($1, $2) r`, [p, k || null]);
  const resolve = (who, id, s, note) => rpc(who, `SELECT public.resolve_exception($1, $2, $3) r`, [id, s, note || null]);
  await expectErr('demurrage needs a document or an amount', () => create('trJ', { transaction_id: TX6, kind: 'demurrage', reason: 'أرضيات' }), /MRS_REQUIRED.*document_or_amount/);
  const K = newKey();
  const p = { transaction_id: TX6, container_id: S.ct6, kind: 'demurrage', reason: 'أرضيات 3 أيام', amount: 450, currency: 'sar' };
  await check('demurrage with an amount: open, manual, dated, internal event', async () => {
    const r = await create('trJ', p, K);
    S.exc1 = r.id;
    const e = await one(`SELECT visible_to_client v FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'exception' ORDER BY id DESC LIMIT 1`, [TX6]);
    return (r.status === 'open' && r.source === 'manual' && r.currency === 'SAR' && Number(r.amount) === 450 && r.occurred_at && e && !e.v) || JSON.stringify({ r, e });
  });
  await check('create_exception replay → same row', async () => {
    const r = await create('trJ', p, K);
    return (r.id === S.exc1 && r.replayed === true) || JSON.stringify(r);
  });
  await check('repair fee with a document only is accepted', async () => {
    const d = await ownerDoc(A, TX6, 'operator_invoice');
    S.exc2 = (await create('trJ', { transaction_id: TX6, kind: 'repair_fee', reason: 'إصلاح باب الحاوية', source: 'document', document_id: d })).id;
    return true;
  });
  await expectErr('CHECK: a fee without document and amount is refused even for the owner', () => q(
    `INSERT INTO public.operational_exceptions (org_id, transaction_id, kind, reason) VALUES ($1, $2, 'cleaning_fee', 'تنظيف')`, [A, TX6]), /operational_exceptions_fee_chk/);
  await expectErr('CHECK: reason is required', () => q(
    `INSERT INTO public.operational_exceptions (org_id, transaction_id, kind, reason) VALUES ($1, $2, 'other', '  ')`, [A, TX6]), /check constraint|violates/);
  await expectErr('CHECK: source and date cannot be NULL', () => q(
    `INSERT INTO public.operational_exceptions (org_id, transaction_id, kind, reason, source, occurred_at) VALUES ($1, $2, 'other', 'x', NULL, NULL)`, [A, TX6]), /not-null|null value/);
  await expectErr('reason required (RPC)', () => create('trJ', { transaction_id: TX6, kind: 'other' }), /MRS_NOTE_REQUIRED/);
  await expectErr('source system is reserved for the server', () => create('trJ', { transaction_id: TX6, kind: 'other', reason: 'x', source: 'system' }), /MRS_INVALID.*source/);
  await expectErr('source document needs the document', () => create('trJ', { transaction_id: TX6, kind: 'other', reason: 'x', source: 'document' }), /MRS_REQUIRED.*document_id/);
  await expectErr('document of another transaction refused', () => create('trJ', { transaction_id: TX6, kind: 'other', reason: 'x', document_id: S.inv4 }), /MRS_INVALID.*document_id/);
  await expectErr('occurred_at in the future refused', () => create('trJ', { transaction_id: TX6, kind: 'other', reason: 'x', occurred_at: '2099-01-01' }), /MRS_INVALID.*occurred_at/);
  await expectErr('unknown kind refused', () => create('trJ', { transaction_id: TX6, kind: 'theft', reason: 'x' }), /MRS_INVALID.*kind/);
  await expectErr('other branch → MRS_NOT_FOUND', () => create('trD', { transaction_id: TX6, kind: 'other', reason: 'x' }), /MRS_NOT_FOUND/);
  await expectErr('client → MRS_NOT_FOUND', () => create('clientA', { transaction_id: TX6, kind: 'other', reason: 'x' }), /MRS_NOT_FOUND/);
  await check('cancel_declaration auto-creates a declaration_cancelled exception (system, linked, reason copied)', async () => {
    const r = await rpc('clrJ', `SELECT public.cancel_declaration($1, 'رفض الجمارك', '{"declaration_no":"G3B-DEC-0006R"}') r`, [S.d6]);
    const x = await one(`SELECT kind, source, declaration_id, reason, status FROM public.operational_exceptions WHERE id = $1`, [r.exception_id]);
    S.excDecl = r.exception_id;
    return (x && x.kind === 'declaration_cancelled' && x.source === 'system' && x.declaration_id === S.d6 && x.reason === 'رفض الجمارك'
      && x.status === 'open' && r.replacement && r.cancelled.status === 'replaced') || JSON.stringify({ r, x });
  });
  await check('a failed cancel leaves no exception behind (atomic)', async () => {
    const before = await count(`SELECT count(*)::int n FROM public.operational_exceptions WHERE transaction_id = $1`, [TX6]);
    try { await rpc('clrJ', `SELECT public.cancel_declaration($1, 'x', '{"declaration_no":"TEST-DEC-0001"}') r`, [(await one(`SELECT id FROM public.customs_declarations WHERE declaration_no = 'G3B-DEC-0006R'`)).id]); } catch (e) { /* number taken */ }
    const after = await count(`SELECT count(*)::int n FROM public.operational_exceptions WHERE transaction_id = $1`, [TX6]);
    return before === after || JSON.stringify({ before, after });
  });
  await expectErr('waive needs a senior role', () => resolve('trJ', S.exc1, 'waived', 'سامحنا الوكيل'), /MRS_FORBIDDEN.*waiver/);
  await expectErr('resolve needs a note', () => resolve('trJ', S.exc1, 'resolved'), /MRS_NOTE_REQUIRED/);
  await check('open → in_progress → resolved (note, by, at)', async () => {
    await resolve('trJ', S.exc1, 'in_progress');
    const r = await resolve('trJ', S.exc1, 'resolved', 'دفعت الأرضيات');
    return (r.status === 'resolved' && r.resolution_note === 'دفعت الأرضيات' && r.resolved_by === U.trJ && r.resolved_at && r.from === 'in_progress') || JSON.stringify(r);
  });
  await expectErr('resolved is final', () => resolve('trJ', S.exc1, 'waived', 'x'), /MRS_BAD_TRANSITION/);
  await check('operations manager waives', async () => (await resolve('opsJ', S.exc2, 'waived', 'تحمّلها المشغل')).status === 'waived');
  await check('client, other branch and org B see no exceptions', async () => {
    const c = await denied('clientA', `SELECT 1 FROM public.operational_exceptions`);
    const d = await denied('trD', `SELECT 1 FROM public.operational_exceptions WHERE transaction_id = $1`, [TX6]);
    const b = await denied('staffB', `SELECT 1 FROM public.operational_exceptions`);
    const e = (await as('clientA', `SELECT count(*)::int n FROM public.transaction_events WHERE event_type = 'exception'`))[0].n;
    return (c === true && d === true && b === true && e === 0) || JSON.stringify({ c, d, b, e });
  });
  await expectErr('resolve_exception: other branch → MRS_NOT_FOUND', () => resolve('trD', S.excDecl, 'in_progress'), /MRS_NOT_FOUND/);
}

async function secAlerts() {
  section('operational alerts: refresh, dedupe, ack, auto-resolve, manual resolve, scope (item 12)');
  const core = (when) => one(`SELECT app.refresh_alerts_core($1, coalesce($2::timestamptz, now())) r`, [A, when || null]).then(x => x.r);
  const list = (who, f, org) => rpc(who, `SELECT public.list_alerts($1, $2) r`, [org || A, f || {}]);
  const alert = key => one(`SELECT * FROM public.operational_alerts WHERE org_id = $1 AND dedupe_key = $2`, [A, key]);
  const at = h => new Date(Date.now() + h * 3600e3).toISOString();
  // causes: appointment soon (TX6), appointment missed (TX6), overdue empty return (TX5 / DMM), open exception (S.excDecl),
  // docs missing (TX7 in_progress → customs_declaration)
  S.apSoon = (await rpc('trJ', `SELECT public.create_appointment($1) r`, [{ transaction_id: TX6, appointment_at: at(3), status: 'confirmed' }])).id;
  S.apMiss = (await rpc('trJ', `SELECT public.create_appointment($1) r`, [{ transaction_id: TX6, appointment_at: at(-5), window_minutes: 60 }])).id;
  S.ct5 = (await one(`SELECT id FROM public.containers WHERE transaction_id = $1`, [TX5])).id;
  await rpc('trD', `SELECT public.set_container_return($1, $2) r`, [S.ct5, { return_deadline: new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10) }]);
  let first;
  await check('first refresh opens one alert per cause', async () => {
    first = await core();
    const kinds = (await q(`SELECT kind, dedupe_key FROM public.operational_alerts WHERE org_id = $1 AND status = 'open'`, [A]));
    const has = k => kinds.some(x => x.kind === k);
    return (first.inserted >= 5 && has('appointment_soon') && has('appointment_missed') && has('empty_return_overdue')
      && has('exception_open') && kinds.some(x => x.dedupe_key === `docs_missing:${TX7}:customs_declaration`)) || JSON.stringify({ first, kinds });
  });
  await check('alert content: severity, bilingual title with the ref, due date, branch from the transaction', async () => {
    const m = await alert('appointment_missed:' + S.apMiss);
    const o = await alert('empty_return_overdue:' + S.ct5);
    const d = await alert(`docs_missing:${TX7}:customs_declaration`);
    const t6 = await txRow(TX6);
    return (m.severity === 'critical' && m.title_ar.includes(t6.ref) && m.title_en && m.branch_id === JED && m.due_at
      && o.severity === 'critical' && o.branch_id === DMM && o.container_id === S.ct5
      && d.title_ar.includes('بوليصة الشحن') && d.severity === 'warning') || JSON.stringify({ m, o, d });
  });
  await check('dedupe: refreshing again inserts nothing and keeps one row per key', async () => {
    const n0 = await count(`SELECT count(*)::int n FROM public.operational_alerts WHERE org_id = $1`, [A]);
    const r = await core();
    const n1 = await count(`SELECT count(*)::int n FROM public.operational_alerts WHERE org_id = $1`, [A]);
    const dup = await count(`SELECT count(*)::int n FROM (SELECT dedupe_key FROM public.operational_alerts GROUP BY org_id, dedupe_key HAVING count(*) > 1) x`);
    return (r.inserted === 0 && r.updated === first.active && n0 === n1 && dup === 0) || JSON.stringify({ r, n0, n1, dup });
  });
  await check('refresh does not flood the audit trail (last_seen_at changes are not audited)', async () => {
    const a0 = await count(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'operational_alerts'`);
    await core();
    const a1 = await count(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'operational_alerts'`);
    return a0 === a1 || JSON.stringify({ a0, a1 });
  });
  await check('viewing never changes an alert (list_alerts is read-only)', async () => {
    const before = JSON.stringify(await q(`SELECT id, status, updated_at FROM public.operational_alerts ORDER BY id`));
    await list('trJ'); await list('clrJ', { status: 'all' });
    const after = JSON.stringify(await q(`SELECT id, status, updated_at FROM public.operational_alerts ORDER BY id`));
    return before === after || 'changed';
  });
  await check('list_alerts: severity order, counts, ref; JED staff do not see the DMM alert', async () => {
    const r = await list('clrJ');
    const sev = r.items.map(i => i.severity);
    const sorted = [...sev].sort((a, b) => ['critical', 'warning', 'info'].indexOf(a) - ['critical', 'warning', 'info'].indexOf(b));
    return (JSON.stringify(sev) === JSON.stringify(sorted) && r.items.every(i => i.branch_id === JED && i.ref)
      && r.counts.critical >= 1 && r.total === r.items.length && !r.items.some(i => i.container_id === S.ct5)) || JSON.stringify(r);
  });
  await check('list_alerts: DMM transport staff see only the DMM alert; filters work', async () => {
    const r = await list('trD');
    const f = await list('clrJ', { kind: 'appointment_missed' });
    return (r.items.length >= 1 && r.items.every(i => i.branch_id === DMM) && f.items.length === 1 && f.items[0].subject_id === S.apMiss)
      || JSON.stringify({ r: r.items.map(i => i.kind), f: f.items.length });
  });
  await check('direct SELECT on operational_alerts is branch-scoped too', async () => {
    const d = (await as('trD', `SELECT DISTINCT branch_id FROM public.operational_alerts`)).map(x => x.branch_id);
    return (d.length === 1 && d[0] === DMM) || JSON.stringify(d);
  });
  await expectErr('list_alerts: org B → MRS_FORBIDDEN', () => list('staffB'), /MRS_FORBIDDEN/);
  await expectErr('list_alerts: client → MRS_FORBIDDEN', () => list('clientA'), /MRS_FORBIDDEN/);
  await check('clients and org B read no alert rows', async () => {
    const c = await denied('clientA', `SELECT 1 FROM public.operational_alerts`);
    const b = await denied('staffB', `SELECT 1 FROM public.operational_alerts WHERE org_id = $1`, [A]);
    return (c === true && b === true) || JSON.stringify({ c, b });
  });

  const missKey = 'appointment_missed:' + S.apMiss;
  await check('ack keeps the alert open (acknowledged) while the cause persists', async () => {
    const a = await alert(missKey);
    const r = await rpc('trJ', `SELECT public.ack_alert($1) r`, [a.id]);
    await core();
    const b = await alert(missKey);
    return (r.status === 'acknowledged' && b.status === 'acknowledged' && b.acknowledged_by === U.trJ && b.cause_active) || JSON.stringify({ r, b });
  });
  await expectErr('ack twice → MRS_BAD_TRANSITION', async () => rpc('trJ', `SELECT public.ack_alert($1) r`, [(await alert(missKey)).id]), /MRS_BAD_TRANSITION/);
  await expectErr('ack from the other branch → MRS_NOT_FOUND', async () => rpc('trD', `SELECT public.ack_alert($1) r`, [(await alert(missKey)).id]), /MRS_NOT_FOUND/);
  await check('fixing the cause (missed appointment rescheduled) auto-resolves the acknowledged alert', async () => {
    await rpc('trJ', `SELECT public.reschedule_appointment($1, $2, 'فات الموعد') r`, [S.apMiss, { appointment_at: at(30) }]);
    const r = await core();
    const a = await alert(missKey);
    return (r.resolved >= 1 && a.status === 'resolved' && a.resolution === 'auto' && !a.cause_active && !!a.resolved_at) || JSON.stringify({ r, a });
  });
  await check('docs_missing auto-resolves once the documents are confirmed', async () => {
    for (const k of ['bill_of_lading', 'commercial_invoice', 'packing_list']) await ownerDoc(A, TX7, k, k, 'confirmed');
    await core();
    const a = await alert(`docs_missing:${TX7}:customs_declaration`);
    return (a.status === 'resolved' && a.resolution === 'auto') || JSON.stringify(a);
  });
  const ovKey = 'empty_return_overdue:' + S.ct5;
  await expectErr('manual resolve needs a note', async () => rpc('trD', `SELECT public.resolve_alert($1, '') r`, [(await alert(ovKey)).id]), /MRS_NOTE_REQUIRED/);
  await check('manual resolve with a note sticks while the cause persists', async () => {
    const r = await rpc('trD', `SELECT public.resolve_alert($1, 'الساحة أكدت الاستلام هاتفيًا') r`, [(await alert(ovKey)).id]);
    await core();
    const a = await alert(ovKey);
    return (r.status === 'resolved' && r.resolution === 'manual' && a.status === 'resolved' && a.resolution === 'manual' && a.cause_active
      && a.note === 'الساحة أكدت الاستلام هاتفيًا') || JSON.stringify({ r, a });
  });
  await check('cause gone then back → the alert reopens (new occurrence, ack / resolution cleared)', async () => {
    await rpc('trD', `SELECT public.set_container_return($1, $2) r`, [S.ct5, { return_deadline: new Date(Date.now() + 20 * 86400e3).toISOString().slice(0, 10) }]);
    await core();
    const gone = await alert(ovKey);
    await rpc('trD', `SELECT public.set_container_return($1, $2) r`, [S.ct5, { return_deadline: new Date(Date.now() - 86400e3).toISOString().slice(0, 10) }]);
    await core();
    const back = await alert(ovKey);
    const n = await count(`SELECT count(*)::int n FROM public.operational_alerts WHERE dedupe_key = $1`, [ovKey]);
    return (!gone.cause_active && gone.status === 'resolved' && back.status === 'open' && back.resolution === null && back.note === null
      && back.cause_active && n === 1) || JSON.stringify({ gone, back, n });
  });
  await check('empty_return_due (deadline within 3 days) is a warning', async () => {
    await rpc('trD', `SELECT public.set_container_return($1, $2) r`, [S.ct5, { return_deadline: new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10) }]);
    await core();
    const due = await alert('empty_return_due:' + S.ct5);
    const ov = await alert(ovKey);
    return (due && due.severity === 'warning' && due.status === 'open' && ov.status === 'resolved' && ov.resolution === 'auto') || JSON.stringify({ due, ov });
  });
  await check('declaration_stalled appears 3 days later and the soon / due alerts age out (time-shifted refresh)', async () => {
    const r = await core(new Date(Date.now() + 4 * 86400e3).toISOString());
    const st = await q(`SELECT kind, status FROM public.operational_alerts WHERE org_id = $1 AND kind = 'declaration_stalled'`, [A]);
    const soon = await alert('appointment_soon:' + S.apSoon);
    return (st.length >= 1 && st.every(x => x.status === 'open') && soon.status === 'resolved') || JSON.stringify({ r, st, soon });
  });
  await check('back to now: stalled alerts auto-resolve, the soon alert reopens', async () => {
    await core();
    const st = await q(`SELECT status, resolution FROM public.operational_alerts WHERE org_id = $1 AND kind = 'declaration_stalled'`, [A]);
    const soon = await alert('appointment_soon:' + S.apSoon);
    return (st.every(x => x.status === 'resolved' && x.resolution === 'auto') && soon.status === 'open') || JSON.stringify({ st, soon });
  });
  await check('refresh_alerts (staff): runs once, then rate-limited within the minute (no error)', async () => {
    const a = await rpc('trJ', `SELECT public.refresh_alerts($1) r`, [A]);
    const b = await rpc('clrJ', `SELECT public.refresh_alerts($1) r`, [A]);
    const run = await one(`SELECT last_run_by FROM public.operational_alert_runs WHERE org_id = $1`, [A]);
    return (a.refreshed === true && b.refreshed === false && b.rate_limited === true && b.retry_after_seconds > 0 && run.last_run_by === U.trJ)
      || JSON.stringify({ a, b, run });
  });
  await check('refresh_alerts returns org-wide counts only (opened / resolved), no per-branch data', async () => {
    await q(`UPDATE public.operational_alert_runs SET last_run_at = now() - interval '2 minutes' WHERE org_id = $1`, [A]);
    const r = await rpc('trD', `SELECT public.refresh_alerts($1) r`, [A]);
    return (JSON.stringify(Object.keys(r).sort()) === '["last_run_at","opened","rate_limited","refreshed","resolved"]'
      && Number.isInteger(r.opened) && Number.isInteger(r.resolved)) || JSON.stringify(r);
  });
  await check('a second refresh within the minute says rate_limited (refreshed:false, retry_after_seconds), no error', async () => {
    const r = await rpc('trD', `SELECT public.refresh_alerts($1) r`, [A]);
    return (r.refreshed === false && r.rate_limited === true && r.retry_after_seconds > 0) || JSON.stringify(r);
  });
  await expectErr('refresh_alerts: org B → MRS_FORBIDDEN', () => rpc('staffB', `SELECT public.refresh_alerts($1) r`, [A]), /MRS_FORBIDDEN/);
  await expectErr('refresh_alerts: client → MRS_FORBIDDEN', () => rpc('clientA', `SELECT public.refresh_alerts($1) r`, [A]), /MRS_FORBIDDEN/);
  await expectErr('authenticated cannot call the core refresh directly', () => as('staffA', `SELECT app.refresh_alerts_core($1)`, [A]), /permission denied/);
  await check('app.refresh_all_alerts (cron entry) refreshes every active org', async () => {
    const n = (await one(`SELECT app.refresh_all_alerts() n`)).n;
    const runs = await count(`SELECT count(*)::int n FROM public.operational_alert_runs`);
    return (n >= 3 && runs >= 3) || JSON.stringify({ n, runs });
  });
  // regression (review): alerts are scoped through the parent transaction, not their own (stale) branch_id
  await check('branch move: the old branch loses the alert at once (select / list / ack / resolve), the new branch gets it open', async () => {
    const ex = await rpc('opsJ', `SELECT public.create_exception($1) r`, [{ transaction_id: TX4, kind: 'other', reason: 'اختبار نقل الفرع' }]);
    await core();
    const key = 'exception_open:' + ex.id;
    const a0 = await alert(key);
    await rpc('trJ', `SELECT public.resolve_alert($1, 'تمت المتابعة') r`, [a0.id]);   // closed by hand while the cause is active
    await as('staffA', `UPDATE public.transactions SET branch_id = $2 WHERE id = $1`, [TX4, DMM]);
    const oldSel = await as('trJ', `SELECT count(*)::int n FROM public.operational_alerts WHERE id = $1`, [a0.id]);
    const oldList = await rpc('trJ', `SELECT public.list_alerts($1, '{"status":"all"}') r`, [A]);
    let ackErr = '', resErr = '';
    try { await rpc('trJ', `SELECT public.ack_alert($1) r`, [a0.id]); } catch (e) { ackErr = errText(e); }
    try { await rpc('trJ', `SELECT public.resolve_alert($1, 'x') r`, [a0.id]); } catch (e) { resErr = errText(e); }
    const moved = await as('trD', `SELECT status, branch_id, resolution FROM public.operational_alerts WHERE id = $1`, [a0.id]);
    const dList = await rpc('trD', `SELECT public.list_alerts($1, $2) r`, [A, { transaction_id: TX4 }]);
    // restore: back to JED, exception resolved, alert auto-resolved
    await as('staffA', `UPDATE public.transactions SET branch_id = $2 WHERE id = $1`, [TX4, JED]);
    await rpc('opsJ', `SELECT public.resolve_exception($1, 'resolved', 'انتهى الاختبار') r`, [ex.id]);
    await core();
    const end = await alert(key);
    return (oldSel[0].n === 0 && !oldList.items.some(i => i.id === a0.id) && /MRS_NOT_FOUND/.test(ackErr) && /MRS_NOT_FOUND/.test(resErr)
      && moved.length === 1 && moved[0].status === 'open' && moved[0].branch_id === DMM && moved[0].resolution === null
      && dList.items.some(i => i.id === a0.id) && end.status === 'resolved' && end.branch_id === JED)
      || JSON.stringify({ oldSel, ackErr, resErr, moved, end });
  });
  await check('org B alerts stay in org B (its own refresh)', async () => {
    const r = await rpc('staffB', `SELECT public.list_alerts($1, '{"status":"all"}') r`, [B]);
    return r.items.every(i => i.org_id === B) || JSON.stringify(r.items);
  });
}

async function secOpsClientVisibility() {
  section('client portal: B tables stay internal, only allowed events');
  await check('client reads none of the B tables', async () => {
    for (const t of ['document_requirements', 'port_appointments', 'operational_exceptions', 'operational_alerts']) {
      const r = await denied('clientA', `SELECT 1 FROM public.${t}`);
      if (r !== true) return t + ': ' + r;
    }
    return (await denied('clientA', `SELECT id FROM public.transport_trips`)) === true || 'trips readable';
  });
  await check('client-visible events of TX6: status, appointment confirmed (time only), container returned — nothing else', async () => {
    const r = await as('clientA', `SELECT event_type, note, payload FROM public.transaction_events WHERE transaction_id = $1`, [TX6]);
    const types = [...new Set(r.map(x => x.event_type))].sort();
    const appt = r.filter(x => x.event_type === 'appointment');
    return (JSON.stringify(types) === '["appointment","container_return","created","operational_status"]'
      && appt.every(x => ['confirmed', 'withdrawn', 'completed'].includes(x.payload.op) && !('driver_id' in x.payload) && !('appointment_id' in x.payload)
        && Object.keys(x.payload).every(k => ['op', 'appointment_ref', 'appointment_at', 'window_minutes', 'container_no'].includes(k)))
      && r.every(x => x.note === null)) || JSON.stringify({ types, appt });
  });
  await check('another client sees none of TX6\'s events', () => denied('clientA2', `SELECT 1 FROM public.transaction_events WHERE transaction_id = $1`, [TX6]));
}

async function secOpsIsolation() {
  section('B isolation sweep: other org on every B table and RPC');
  const sample = {
    document_requirements: [`SELECT id::text id FROM public.document_requirements WHERE org_id = $1 LIMIT 1`, 'note = note'],
    port_appointments: [`SELECT id::text id FROM public.port_appointments WHERE org_id = $1 LIMIT 1`, 'status = status'],
    transport_trips: [`SELECT id::text id FROM public.transport_trips WHERE org_id = $1 LIMIT 1`, 'status = status'],
    operational_exceptions: [`SELECT id::text id FROM public.operational_exceptions WHERE org_id = $1 LIMIT 1`, 'status = status'],
    operational_alerts: [`SELECT id::text id FROM public.operational_alerts WHERE org_id = $1 LIMIT 1`, 'status = status']
  };
  for (const who of ['staffB', 'adminB', 'clientB']) {
    for (const [t, [sql, setClause]] of Object.entries(sample)) {
      const row = (await q(sql, [A]))[0];
      if (!row) { fail(`${who}→${t}: fixture row`, 'none'); continue; }
      await check(`${who}: cannot SELECT ${t} of org A`, () => denied(who, `SELECT 1 FROM public.${t} WHERE org_id = $1`, [A]));
      await check(`${who}: cannot UPDATE ${t} of org A`, () => denied(who, `UPDATE public.${t} SET ${setClause} WHERE id::text = $1 RETURNING 1`, [row.id]));
      await check(`${who}: cannot DELETE ${t} of org A`, () => denied(who, `DELETE FROM public.${t} WHERE id::text = $1 RETURNING 1`, [row.id]));
    }
  }
  const ap = (await one(`SELECT id FROM public.port_appointments WHERE org_id = $1 AND status = 'requested' LIMIT 1`, [A])).id;
  const tr = (await one(`SELECT id FROM public.transport_trips WHERE org_id = $1 LIMIT 1`, [A])).id;
  const ex = (await one(`SELECT id FROM public.operational_exceptions WHERE org_id = $1 AND status = 'open' LIMIT 1`, [A])).id;
  const al = (await one(`SELECT id FROM public.operational_alerts WHERE org_id = $1 AND status = 'open' LIMIT 1`, [A])).id;
  const calls = [
    ['tx_checklist', `SELECT public.tx_checklist($1)`, [TX6]],
    ['set_transaction_status', `SELECT public.set_transaction_status($1, 'transport', 'x')`, [TX6]],
    ['create_appointment', `SELECT public.create_appointment($1)`, [{ transaction_id: TX6, appointment_at: '2026-12-01T08:00:00Z' }]],
    ['reschedule_appointment', `SELECT public.reschedule_appointment($1, '{"appointment_at":"2026-12-01T08:00:00Z"}', 'x')`, [ap]],
    ['set_appointment_status', `SELECT public.set_appointment_status($1, 'cancelled', 'x')`, [ap]],
    ['create_trip', `SELECT public.create_trip($1)`, [{ transaction_id: TX6 }]],
    ['update_trip', `SELECT public.update_trip($1, '{"origin":"x"}')`, [tr]],
    ['set_trip_status', `SELECT public.set_trip_status($1, 'cancelled', NULL, 'x')`, [tr]],
    ['set_container_return', `SELECT public.set_container_return($1, '{"return_location":"x"}')`, [S.ct5]],
    ['create_exception', `SELECT public.create_exception($1)`, [{ transaction_id: TX6, kind: 'other', reason: 'x' }]],
    ['resolve_exception', `SELECT public.resolve_exception($1, 'in_progress')`, [ex]],
    ['refresh_alerts', `SELECT public.refresh_alerts($1)`, [A]],
    ['list_alerts', `SELECT public.list_alerts($1)`, [A]],
    ['ack_alert', `SELECT public.ack_alert($1)`, [al]],
    ['resolve_alert', `SELECT public.resolve_alert($1, 'x')`, [al]]
  ];
  for (const [name, sql, params] of calls) {
    await expectErr(`staffB: ${name} with org A ids refused`, () => as('staffB', sql, params), /MRS_NOT_FOUND|MRS_FORBIDDEN/);
  }
  await check('staffB: trip_finance of an org A trip → {}', async () =>
    Object.keys(await rpc('staffB', `SELECT public.trip_finance($1) r`, [[tr]])).length === 0);
}

/* ================================================================== migration safety on a fresh database
   (review regressions): a second PGlite loaded with the pre-G3 migrations + seed and legacy states the
   G3 files must survive, then migration A + B applied. The shared db is restored afterwards. */
async function secMigrationSafety() {
  section('migration safety: pre-G3 database with legacy states, then A + B');
  const saved = db;
  db = new PGlite();
  try {
    const migDir = path.join(SUPA, 'migrations');
    const pre = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f) && f < '20261103').sort();
    if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return;
    for (const m of pre) if (!await runFile(path.join(migDir, m))) return;
    if (!await runFile(path.join(SUPA, 'seed.sql'))) return;
    const TXC = '0b5e0000-0000-4000-8000-0000000002c1', TXD = '0b5e0000-0000-4000-8000-0000000002c2', CT301 = '0b5e0000-0000-4000-8000-000000000301';
    // legacy states: TX1 weeks old; a number equal to TX1's after normalization; another client's transaction with
    // TX1's B/L number; container 301 pointing at an empty-return receipt that was voided later
    await q(`UPDATE public.transactions SET created_at = now() - interval '20 days', status_changed_at = now() - interval '20 days',
               declaration_date = current_date - 20 WHERE id = $1`, [TX1]);
    await q(`INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, declaration_no) VALUES ($1, $2, $3, $4, 'import', 'sea', 'test-dec-0001')`,
      [TXC, A, JED, CL101]);
    await q(`INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, bl_number) VALUES ($1, $2, $3, $4, 'import', 'sea', 'TESTBL0000001')`,
      [TXD, A, DMM, CL102]);
    await q(`INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, 'mig@g3.example.com', now()) ON CONFLICT DO NOTHING`, [U.staffA]);
    const doc = await ownerDoc(A, TX1, 'empty_return_receipt', 'empty_return_receipt', 'confirmed');
    await q(`UPDATE public.containers SET evidence_document_id = $2, return_status = 'evidence_submitted' WHERE id = $1`, [CT301, doc]);
    await q(`UPDATE public.documents SET voided_at = now(), void_reason = 'نسخة خاطئة' WHERE id = $1`, [doc]);

    const migA = fs.readFileSync(path.join(migDir, MIG_A), 'utf8');
    const migB = fs.readFileSync(path.join(migDir, MIG_B), 'utf8');
    await check('preflight: colliding legacy declaration numbers stop migration A with the refs and numbers (nothing applied)', async () => {
      let err = '';
      try { await db.exec(migA); } catch (e) { err = errText(e); }
      const left = await one(`SELECT to_regclass('public.parties') IS NULL AS none,
                                     NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261103000100') AS nover`);
      return (/G3 preflight/.test(err) && err.includes('TEST-DEC-0001') && err.includes('test-dec-0001') && left.none && left.nover) || JSON.stringify({ err, left });
    });
    await q(`UPDATE public.transactions SET declaration_no = NULL WHERE id = $1`, [TXC]);
    await check('after fixing the collision, A + B apply over a container whose evidence was voided later', async () => {
      await db.exec(migA); await db.exec(migB);
      return true;
    });
    await check('that container is still writable after G3 (evidence re-checked only when attached / changed)', async () => {
      const r = await q(`UPDATE public.containers SET seal_no = 'sl 77' WHERE id = $1 RETURNING seal_no, visit_ref`, [CT301]);
      return (r.length === 1 && r[0].seal_no === 'SL77') || JSON.stringify(r);
    });
    await check('backfilled declaration keeps the legacy timeline (backdated) → declaration_stalled is raised now', async () => {
      const d = await one(`SELECT id, created_at, updated_at FROM public.customs_declarations WHERE transaction_id = $1`, [TX1]);
      const e = await one(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'declaration'`, [TX1]);
      const c = await count(`SELECT count(*)::int n FROM app.alert_causes($1, now()) x WHERE x.kind = 'declaration_stalled' AND x.subject_id = $2`, [A, d.id]);
      const old = Date.now() - new Date(d.updated_at).getTime() > 10 * 86400e3;
      return (old && e.payload.backdated === true && e.payload.via === 'backfill' && c === 1) || JSON.stringify({ d, e, c });
    });
    await check('backfill: another client\'s transaction with the same B/L number is not linked (conflict event), the B/L keeps one link', async () => {
      const mine = await count(`SELECT count(*)::int n FROM public.transaction_bls WHERE transaction_id = $1`, [TXD]);
      const links = await count(`SELECT count(*)::int n FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                                  WHERE b.org_id = $1 AND b.bl_number = 'TESTBL0000001'`, [A]);
      const e = await one(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'bl'`, [TXD]);
      return (mine === 0 && links === 1 && e && e.payload.op === 'conflict' && e.payload.via === 'backfill') || JSON.stringify({ mine, links, e });
    });
    await check('re-running migration A alone after B keeps B\'s cancel_declaration and transaction_completeness; re-runs add no event', async () => {
      const n0 = await count(`SELECT count(*)::int n FROM public.transaction_events`);
      await db.exec(migA);
      const n1 = await count(`SELECT count(*)::int n FROM public.transaction_events`);
      const src = await one(`SELECT pg_get_functiondef('public.cancel_declaration(uuid,text,jsonb)'::regprocedure) c,
                                    pg_get_functiondef('public.transaction_completeness(uuid)'::regprocedure) t`);
      await db.exec(migB);
      return (src.c.includes('declaration_cancelled') && src.t.includes('document_requirements') && n0 === n1) || JSON.stringify({ n0, n1 });
    });
  } finally {
    try { await db.close(); } catch (e) { /* ignore */ }
    db = saved;
  }
}

/* ------------------------------------------------------------------ runner */
// Migration B: append ['<label>', secFn] entries here (keep the order: later sections may use S.*).
const SECTIONS = [
  ['catalog', secCatalog],
  ['backfill', secBackfill],
  ['parties', secParties],
  ['aliases', secAliases],
  ['match_client', secMatchClient],
  ['declarations', secDeclarations],
  ['legacy', secLegacy],
  ['bills_of_lading', secBLs],
  ['containers', secContainers],
  ['completeness', secCompleteness],
  ['client_visibility', secClientVisibility],
  ['isolation', secIsolation],
  // migration B (items 7–12)
  ['ops_catalog', secOpsCatalog],
  ['requirements', secRequirements],
  ['docs_gate', secDocsGate],
  ['appointments', secAppointments],
  ['trips', secTrips],
  ['empty_return', secEmptyReturn],
  ['exceptions', secExceptions],
  ['alerts', secAlerts],
  ['ops_client_visibility', secOpsClientVisibility],
  ['ops_isolation', secOpsIsolation],
  // review regressions on a separate, freshly loaded database
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
  try { await fixtures(); pass('fixtures: two orgs, branch-scoped staff, clients, TX4 / TX5'); }
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
