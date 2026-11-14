#!/usr/bin/env node
/*
  Marsa (مرسى) — document matching (invoice ↔ B/L ↔ customs declaration): migration 20261116000100_doc_match.sql and
  the supa.js API calls. LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase.
  No network (fetch throws).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal).

  Covers: file conventions + all_migrations.sql; preflight + re-run + catalog delta; the six new extraction field keys;
  grants (read-only table, staff RPCs authenticated only, helpers closed); save (two_way / three_way, validation of the
  payload and of every row, kinds, voided / foreign / invisible extractions, one transaction per match + adoption,
  overall ↔ rows consistency, counts, reviewed rows, idempotency); RLS (isolation between two orgs, branch scoping by
  the match's and the extractions' transaction, clients / strangers / anon denied, no direct write); review / void flows;
  the guard (machine result immutable, voided rows frozen, no DELETE even for the owner); the audit trail without the
  compared values; supa.js (vm, mocked client); and convert_org_to_production deleting the org's matches (last).
  + 20261126000100_doc_match_packing.sql (the packing list as a 4th optional document, engine match-v2): file conventions,
  preflight / re-run / catalog delta, grants, save with packing (kind / org / voided / distinct / engine rules / rows keys /
  transaction), list, visibility through the packing extraction, review / void, guard + table checks, supa.js pass-through.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/doc-match-sql-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const MIG = '20261116000100_doc_match.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in doc-match-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'd0c00000-0000-4000-8000-0000000000b0';           // second org (fixture)
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const TX_JED = '0b5e0000-0000-4000-8000-000000000201';      // seed transaction, branch JED
const TX_DMM = '0b5e0000-0000-4000-8000-000000000202';      // seed transaction, branch DMM
const TX_JED2 = '0b5e0000-0000-4000-8000-000000000203';     // seed transaction, branch JED (air)
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const BR_B = 'd0c00000-0000-4000-8000-0000000000b1';
const TX_B = 'd0c00000-0000-4000-8000-0000000000b2';
const CL_B = 'd0c00000-0000-4000-8000-0000000000b3';
const U = {
  admin: 'd0c00000-0000-4000-8000-000000000001',    // admin of A (MFA-gated, platform admin for the conversion)
  staff: 'd0c00000-0000-4000-8000-000000000002',    // accountant of A, org-wide
  jed: 'd0c00000-0000-4000-8000-000000000003',      // clearance_staff of A, JED only
  dmm: 'd0c00000-0000-4000-8000-000000000004',      // clearance_staff of A, DMM only
  portal: 'd0c00000-0000-4000-8000-000000000005',   // client user of A
  stranger: 'd0c00000-0000-4000-8000-000000000006', // no membership
  staffB: 'd0c00000-0000-4000-8000-000000000007',   // admin of B
  gone: 'd0c00000-0000-4000-8000-000000000008'      // deactivated staff of A
};

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn, aal) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else if (who === 'service') {
    await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[who], role: 'authenticated', aal: aal || 'aal2' })]);
    await db.exec(`SET ROLE authenticated;`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params, aal) => asRole(who, () => q(sql, params), aal);
const one = async (sql, params) => (await q(sql, params))[0];
const num = async (sql, params) => Number((await one(sql, params)).n);
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
async function tryErr(fn) { try { await fn(); return 'ok'; } catch (e) { return errText(e); } }
async function code(fn) { try { await fn(); return 'ok'; } catch (e) { return /^MRS_/.test(e.message || '') ? (e.message + (e.detail ? ' ' + e.detail : '')) : errText(e); } }
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
async function freshDb(upTo) {
  const d = new PGlite();
  await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles().filter(f => !upTo || f < upTo)) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  return d;
}
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let keySeq = 0;
const newKey = () => 'd0c0aaaa-0000-4000-8000-' + String(++keySeq).padStart(12, '0');

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind = 'r' ORDER BY 1`)).map(x => x.t);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('app','public') ORDER BY 1`)).map(x => x.x);
  const pol = (await q(`SELECT tablename || '.' || policyname x FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  return { fns, tables, trg, pol };
}
const NEW_FNS = ['app.doc_match_row_keys()', 'app.doc_match_rows_check(p_rows jsonb, p_mode text)', 'app.doc_match_statuses()',
  'app.doc_match_visible(p_org uuid, p_tx uuid, p_inv uuid, p_bl uuid, p_decl uuid)', 'app.tg_document_matches_audit()',
  'app.tg_document_matches_guard()', 'app.tg_document_matches_no_delete()',
  'public.review_document_match(p_id uuid, p_reviewed_rows jsonb, p_note text)', 'public.save_document_match(p_org uuid, p_payload jsonb)',
  'public.void_document_match(p_id uuid, p_reason text)'];
const RECREATED = ['app.convert_delete_guards()', 'app.convert_delete_tables()', 'app.extraction_field_keys()'];
const NEW_KEYS = ['gross_weight', 'net_weight', 'packages_count', 'package_type', 'goods_description', 'incoterms'];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@match.example.com', now()), ('${U.staff}', 'staff@match.example.com', now()),
    ('${U.jed}', 'jed@match.example.com', now()), ('${U.dmm}', 'dmm@match.example.com', now()),
    ('${U.portal}', 'portal@match.example.com', now()), ('${U.stranger}', 'stranger@match.example.com', now()),
    ('${U.staffB}', 'staffb@match.example.com', now()), ('${U.gone}', 'gone@match.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.staff}', 'staff'), ('${U.jed}', 'jed'),
    ('${U.dmm}', 'dmm'), ('${U.portal}', 'portal'), ('${U.stranger}', 'stranger'), ('${U.staffB}', 'staffB'), ('${U.gone}', 'gone')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'match-org-b', 'مؤسسة المطابقة ب', 'Match org B', 'MTB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', '0509990000');
  INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ('${TX_B}', '${B}', '${BR_B}', '${CL_B}', 'import', 'sea');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.staff}', '${A}', NULL, 'accountant'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff'),
    ('${U.staffB}', '${B}', NULL, 'admin'), ('${U.gone}', '${A}', NULL, 'accountant');
  UPDATE public.memberships SET is_active = false WHERE user_id = '${U.gone}';
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;
let shaSeq = 0;
const sha = () => (++shaSeq).toString(16).padStart(64, 'c');
// an extraction inserted by the owner (as the SQL Editor would): kind, org, transaction, fields
async function ext(kind, o) {
  o = o || {};
  const r = await one(`INSERT INTO public.document_extractions (org_id, transaction_id, doc_type, source_name, source_sha256, engine, languages,
                         raw_text, extracted_fields, created_by)
                       VALUES ($1, $2, $3, $4, $5, 'tesseract.js@5.1.1', 'ara+eng', 'نص', $6, $7) RETURNING id`,
    [o.org || A, o.tx || null, kind, kind + '.pdf', sha(), J(o.fields || {}), o.by || U.staff]);
  return r.id;
}
// a valid engine row
function row(key, status, o) {
  return Object.assign({ key, label_ar: 'حقل', label_en: 'Field', values: { invoice: 'A', bl: 'A' }, status, detail_ar: '', detail_en: '',
    critical: false, conf: { invoice: 0.9, bl: 0.8 }, pairs: { inv_bl: status === 'info' ? null : status } }, o || {});
}
function rows3(list) {
  return list.map(r => Object.assign({}, r, { values: Object.assign({ declaration: 'A' }, r.values), conf: Object.assign({ declaration: 0.7 }, r.conf),
    pairs: { inv_bl: r.status === 'info' ? null : r.status, inv_decl: 'match', bl_decl: 'match' } }));
}
const GOOD_ROWS = [row('bl_number', 'match', { critical: true }), row('container_numbers', 'match', { critical: true, values: { invoice: ['CSQU3054383'], bl: ['CSQU3054383'] } }),
  row('consignee', 'partial', { critical: false }), row('gross_weight', 'match', { critical: true, values: { invoice: 18250.5, bl: '18250' } }),
  row('goods_description', 'missing'), row('invoice_totals', 'info', { values: { invoice: '1000' } })];
const COUNTS = { match: 3, mismatch: 0, partial: 1, missing: 1 };
function payload(o) {
  return Object.assign({ invoice_extraction_id: X.inv, bl_extraction_id: X.bl, mode: 'two_way', engine_version: 'match-v1', overall: 'review',
    counts: COUNTS, rows: GOOD_ROWS, reviewed_rows: ['bl_number'], note: 'ملاحظة' }, o || {});
}
const save = (who, p, org, aal) => as(who, `SELECT public.save_document_match($1, $2) r`, [org || A, p], aal).then(r => r[0].r);
const review = (who, id, rr, note) => as(who, `SELECT public.review_document_match($1, $2, $3) r`, [id, rr == null ? null : J(rr), note == null ? null : note]).then(r => r[0].r);
const voidM = (who, id, why) => as(who, `SELECT public.void_document_match($1, $2) r`, [id, why]).then(r => r[0].r);
const X = {};           // extraction ids of the main fixtures

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261115000100, schema_versions row, search_path = \'\' on every function but the field-key list', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h) && !/extraction_field_keys/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261115000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261116000100', 'doc_match'\)/.test(src)
      && heads.length === 13 && bad.length === 0) || J({ n: heads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('SECURITY DEFINER exactly on the 3 RPCs, the visibility helper and the audit trigger; every refusal goes through app.fail(\'MRS_*\')', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const definer = heads.filter(h => /SECURITY DEFINER/.test(h)).map(h => (h.match(/FUNCTION ([a-z_.]+)\(/) || [])[1]).sort();
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|MATCH preflight/.test(r));
    const codes = src.match(/app\.fail\('([A-Z_]+)'/g) || [];
    return (J(definer) === J(['app.doc_match_visible', 'app.tg_document_matches_audit', 'public.review_document_match',
      'public.save_document_match', 'public.void_document_match'])
      && raises.length === 0 && codes.length >= 30 && codes.every(c => /app\.fail\('MRS_[A-Z_]+'/.test(c))) || J({ definer, raises: raises.length });
  });
  await check('no TRUNCATE / DROP TABLE / DISABLE TRIGGER / session_replication_role; no key or endpoint', () => {
    const c = src.replace(/--.*$/gm, '');
    return (!/\bTRUNCATE\b/i.test(c) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA)/i.test(c) && !/DISABLE TRIGGER/i.test(c) && !/session_replication_role/.test(c)
      && !/sk-ant|api\.anthropic\.com/i.test(src)) || 'body';
  });
  // later phases may follow this file (20261117000100 legacy_core: re-creates convert_delete_tables with party_ports)
  const LATER_PHASES = ['20261117000100_legacy_core.sql', '20261118000100_legacy_tx.sql', '20261119000100_legacy_docs.sql', '20261120000100_legacy_decl.sql', '20261121000100_legacy_appt.sql', '20261122000100_legacy_pay.sql', '20261123000100_legacy_daftra.sql', '20261124000100_legacy_reports.sql', '20261125000100_legacy_import.sql', '20261126000100_doc_match_packing.sql', '20261127000100_tx_draft_approval.sql', '20261128000100_return_extension.sql'];
  await check('this file is present; only the listed later phases follow it', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (appended like the earlier phases) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    const after = next < 0 ? [] : (all.slice(next).match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && after.every(f => LATER_PHASES.includes(f)) && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 7000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
}

/* ================================================================== 2. preflight, re-run, catalog */
async function secPreflight() {
  section('2. preflight, re-run, catalog delta (separate database, no seed)');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const d = await freshDb(MIG);
  try {
    await withDb(d, async () => {
      const C0 = await catalog();
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261115000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without convert_in_place: exact preflight message, nothing created', async () =>
        (msg.startsWith('MATCH preflight: apply convert_in_place first (schema_versions lacks 20261115000100 convert_in_place)')
          && (await one(`SELECT to_regclass('public.document_matches') IS NULL x`)).x && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261115000100', 'convert_in_place')`);
      const r1 = await tryErr(() => db.exec(src));
      const C1 = await catalog();
      const r2 = await tryErr(() => db.exec(src));
      await check('applies, and re-runs on top of itself with an identical catalog; one schema_versions row', async () =>
        (r1 === 'ok' && r2 === 'ok' && J(C1) === J(await catalog())
          && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261116000100'`)) === 1) || J({ r1, r2 }));
      const s0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the 10 new functions; only the 3 re-created bodies changed (ACL / definer / config kept)', () => {
        const added = C1.fns.filter(f => !s0.has(f.sig)).map(f => f.sig).sort();
        const changed = C1.fns.filter(f => s0.has(f.sig) && J(s0.get(f.sig)) !== J(f)).map(f => f.sig).sort();
        const sameMeta = RECREATED.every(sig => { const a = s0.get(sig), b = C1.fns.find(f => f.sig === sig); return a.acl === b.acl && a.d === b.d && a.c === b.c; });
        return (J(added) === J(NEW_FNS.slice().sort()) && J(changed) === J(RECREATED) && sameMeta) || J({ added, changed, sameMeta });
      });
      await check('catalog: + public.document_matches only; its 3 triggers and 1 SELECT policy', () => {
        const t = C1.tables.filter(x => !C0.tables.includes(x)), tr = C1.trg.filter(x => !C0.trg.includes(x)), p = C1.pol.filter(x => !C0.pol.includes(x));
        return (J(t) === J(['public.document_matches']) && J(tr) === J(['document_matches.trg_audit', 'document_matches.trg_guard', 'document_matches.trg_no_delete'])
          && J(p) === J(['document_matches.document_matches_select'])) || J({ t, tr, p });
      });
      await check('field keys: the 22 earlier keys + the 6 match keys (a superset)', async () => {
        const k = (await one(`SELECT app.extraction_field_keys() k`)).k;
        return (k.length === 28 && NEW_KEYS.every(x => k.includes(x)) && ['invoice_number', 'iban', 'vessel', 'consignee'].every(x => k.includes(x))) || J(k);
      });
      await check('conversion lists: + public.document_matches and its trg_no_delete guard (nothing else changed)', async () => {
        const t = (await one(`SELECT app.convert_delete_tables() t`)).t, g = (await one(`SELECT app.convert_delete_guards() g`)).g;
        return (t.length === 62 && t.includes('public.document_matches') && t.indexOf('public.document_matches') === t.indexOf('public.document_extractions') + 1
          && g.length === 24 && g[23] === 'public.document_matches:trg_no_delete') || J({ t: t.length, g: g.length });
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. grants */
async function secGrants() {
  section('3. grants: read-only table, staff RPCs, closed helpers');
  await check('authenticated: SELECT only on document_matches (no INSERT / UPDATE / DELETE / TRUNCATE); anon nothing', async () => {
    const r = await one(`SELECT has_table_privilege('authenticated', 'public.document_matches', 'SELECT') s,
                                has_table_privilege('authenticated', 'public.document_matches', 'INSERT') i,
                                has_table_privilege('authenticated', 'public.document_matches', 'UPDATE') u,
                                has_table_privilege('authenticated', 'public.document_matches', 'DELETE') d,
                                has_table_privilege('authenticated', 'public.document_matches', 'TRUNCATE') t,
                                has_table_privilege('anon', 'public.document_matches', 'SELECT') a`);
    return (r.s && !r.i && !r.u && !r.d && !r.t && !r.a) || J(r);
  });
  await check('RLS on, one policy (SELECT to authenticated)', async () => {
    const r = await q(`SELECT policyname, cmd, roles::text FROM pg_policies WHERE tablename = 'document_matches'`);
    const rls = (await one(`SELECT relrowsecurity x FROM pg_class WHERE oid = 'public.document_matches'::regclass`)).x;
    return (rls && r.length === 1 && r[0].cmd === 'SELECT' && r[0].roles === '{authenticated}') || J(r);
  });
  await check('the 3 RPCs: authenticated only (not anon, not service_role, not PUBLIC)', async () => {
    const sigs = ['public.save_document_match(uuid, jsonb)', 'public.review_document_match(uuid, jsonb, text)', 'public.void_document_match(uuid, text)'];
    const r = await q(`SELECT s, has_function_privilege('authenticated', s, 'EXECUTE') au, has_function_privilege('anon', s, 'EXECUTE') an,
                              has_function_privilege('service_role', s, 'EXECUTE') sr FROM unnest($1::text[]) s`, [sigs]);
    return r.every(x => x.au && !x.an && !x.sr) || J(r);
  });
  await check('helpers: only app.doc_match_visible (read-only, for the policy) and the field keys are executable by authenticated', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('anon', p.oid, 'EXECUTE') an
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND (p.proname LIKE 'doc_match%' OR p.proname LIKE 'tg_document_matches%' OR p.proname IN ('convert_delete_tables', 'convert_delete_guards', 'extraction_field_keys'))
                        ORDER BY 1`);
    const open = r.filter(x => x.au).map(x => x.proname);
    // 12 = the 10 of this file + the two overloads of 20261126000100 (doc_match_rows_check(jsonb, text, boolean), doc_match_visible(… 6 uuids))
    return (J(open) === J(['doc_match_visible', 'doc_match_visible', 'extraction_field_keys']) && r.every(x => !x.an) && r.length === 12) || J(r);
  });
  await check('anon cannot read the table nor call the RPCs', async () => {
    const a = await tryErr(() => as('anon', `SELECT 1 FROM public.document_matches`));
    const b = await tryErr(() => as('anon', `SELECT public.save_document_match($1, '{}'::jsonb)`, [A]));
    return (/permission denied/.test(a) && /permission denied/.test(b)) || J({ a, b });
  });
}

/* ================================================================== 4. field keys */
async function secKeys() {
  section('4. extraction field keys v2 (ai-doc-v2)');
  await check('an extraction with the 6 new keys is accepted (staff insert under RLS)', async () => {
    const r = await as('staff', `INSERT INTO public.document_extractions (org_id, doc_type, source_name, source_sha256, engine, languages, raw_text, extracted_fields, created_by)
      VALUES ($1, 'bill_of_lading', 'bl.png', $2, 'tesseract.js@5.1.1', 'eng', 'x', $3, $4) RETURNING extracted_fields`,
      [A, sha(), J({ gross_weight: '18250.5', net_weight: '17000', packages_count: '1200', package_type: 'CTNS', goods_description: 'Brake pads', incoterms: 'FOB Shanghai' }), U.staff]);
    return (r[0].extracted_fields.incoterms === 'FOB Shanghai') || J(r);
  });
  await check('reviewed_fields accept the new keys too; an unknown key is still refused', async () => {
    const id = await ext('commercial_invoice');
    const okR = await tryErr(() => as('staff', `UPDATE public.document_extractions SET reviewed_fields = $2 WHERE id = $1`, [id, J({ gross_weight: '10' })]));
    const bad = await tryErr(() => as('staff', `UPDATE public.document_extractions SET reviewed_fields = $2 WHERE id = $1`, [id, J({ weight_kg: '10' })]));
    return (okR === 'ok' && /document_extractions_reviewed_chk/.test(bad)) || J({ okR, bad });
  });
}

/* ================================================================== 5. save */
async function secSave() {
  section('5. save_document_match: two_way / three_way, validation, kinds, transactions, overall, idempotency');
  X.inv = await ext('commercial_invoice'); X.bl = await ext('bill_of_lading'); X.decl = await ext('customs_declaration');
  await check('two_way: saved by an org-wide staff member → {id, created_at, status saved, transaction_id null, mode, overall}', async () => {
    const r = await save('staff', payload());
    X.m1 = r.id;
    const m = await one(`SELECT * FROM public.document_matches WHERE id = $1`, [r.id]);
    return (r.status === 'saved' && r.mode === 'two_way' && r.overall === 'review' && r.transaction_id === null && r.created_at
      && m.created_by === U.staff && m.match_count === 3 && m.partial_count === 1 && m.missing_count === 1 && m.mismatch_count === 0
      && m.rows.length === 6 && J(m.reviewed_rows) === '["bl_number"]' && m.note === 'ملاحظة' && m.engine_version === 'match-v1'
      && m.declaration_extraction_id === null && m.reviewed_at === null) || J({ r, m });
  });
  await check('three_way: invoice + B/L + declaration with declaration values / pairs → mode three_way', async () => {
    const r = await save('staff', payload({ mode: 'three_way', declaration_extraction_id: X.decl, rows: rows3(GOOD_ROWS) }));
    X.m3 = r.id;
    const m = await one(`SELECT declaration_extraction_id d, mode, rows FROM public.document_matches WHERE id = $1`, [r.id]);
    return (m.d === X.decl && m.mode === 'three_way' && m.rows[0].values.declaration === 'A' && m.rows[0].pairs.bl_decl === 'match') || J(m);
  });
  await check('the same extractions can be matched again (a new row each time: a re-check after corrections)', async () => {
    const r = await save('staff', payload({ note: null }));
    X.m1b = r.id;
    return (r.id !== X.m1) || 'same id';
  });
  // payload validation: [payload, expected code prefix]
  const big = Array.from({ length: 61 }, (_, i) => row('items', 'match'));
  const cases = [
    ['unknown payload key', payload({ extra: 1 }), 'MRS_INVALID unknown_key'],
    ['mode missing', payload({ mode: undefined }), 'MRS_REQUIRED mode'],
    ['mode bad', payload({ mode: 'one_way' }), 'MRS_INVALID mode'],
    ['three_way without a declaration', payload({ mode: 'three_way' }), 'MRS_REQUIRED declaration_extraction_id'],
    ['two_way with a declaration', payload({ declaration_extraction_id: X.decl }), 'MRS_INVALID mode'],
    ['engine_version bad', payload({ engine_version: 'v1' }), 'MRS_INVALID engine_version'],
    ['overall bad', payload({ overall: 'ok' }), 'MRS_INVALID overall'],
    ['invoice id missing', payload({ invoice_extraction_id: null }), 'MRS_REQUIRED invoice_extraction_id'],
    ['B/L id missing', payload({ bl_extraction_id: undefined }), 'MRS_REQUIRED bl_extraction_id'],
    ['invoice id malformed', payload({ invoice_extraction_id: 'x' }), 'MRS_INVALID invoice_extraction_id'],
    ['same extraction twice', payload({ bl_extraction_id: X.inv }), 'MRS_INVALID bl_extraction_id'],
    ['rows missing', payload({ rows: undefined }), 'MRS_INVALID rows'],
    ['rows empty', payload({ rows: [] }), 'MRS_INVALID rows'],
    ['rows not an array', payload({ rows: { a: 1 } }), 'MRS_INVALID rows'],
    ['more than 60 rows', payload({ rows: big, counts: {} }), 'MRS_INVALID rows_too_many'],
    ['row not an object', payload({ rows: ['x'] }), 'MRS_INVALID rows'],
    ['row key unknown', payload({ rows: [row('iban', 'match')], counts: {} }), 'MRS_INVALID rows.key'],
    ['row key missing', payload({ rows: [{ status: 'match' }], counts: {} }), 'MRS_INVALID rows.key'],
    ['row status unknown', payload({ rows: [row('vessel', 'ok')], counts: {} }), 'MRS_INVALID rows.status'],
    ['row unknown property', payload({ rows: [Object.assign(row('vessel', 'match'), { html: '<b>' })], counts: {} }), 'MRS_INVALID rows.unknown_key'],
    ['duplicate row key', payload({ rows: [row('vessel', 'match'), row('vessel', 'match')], counts: {} }), 'MRS_INVALID rows.duplicate'],
    ['label too long', payload({ rows: [row('vessel', 'match', { label_ar: 'x'.repeat(1001) })], counts: {} }), 'MRS_INVALID rows.label_ar'],
    ['critical not boolean', payload({ rows: [row('vessel', 'match', { critical: 'yes' })], counts: {} }), 'MRS_INVALID rows.critical'],
    ['values with an unknown document', payload({ rows: [row('vessel', 'match', { values: { packing_list: 'x' } })], counts: {} }), 'MRS_INVALID rows.values'],
    ['declaration value in two_way', payload({ rows: [row('vessel', 'match', { values: { invoice: 'a', declaration: 'a' } })], counts: {} }), 'MRS_INVALID rows.values'],
    ['value is an object', payload({ rows: [row('vessel', 'match', { values: { invoice: { a: 1 } } })], counts: {} }), 'MRS_INVALID rows.values'],
    ['value too long', payload({ rows: [row('vessel', 'match', { values: { invoice: 'x'.repeat(2001) } })], counts: {} }), 'MRS_INVALID rows.values'],
    ['confidence above 1', payload({ rows: [row('vessel', 'match', { conf: { invoice: 1.5 } })], counts: {} }), 'MRS_INVALID rows.conf'],
    ['confidence a string', payload({ rows: [row('vessel', 'match', { conf: { bl: '0.5' } })], counts: {} }), 'MRS_INVALID rows.conf'],
    ['pair key of three_way in two_way', payload({ rows: [row('vessel', 'match', { pairs: { inv_decl: 'match' } })], counts: {} }), 'MRS_INVALID rows.pairs'],
    ['pair status unknown', payload({ rows: [row('vessel', 'match', { pairs: { inv_bl: 'same' } })], counts: {} }), 'MRS_INVALID rows.pairs'],
    ['corrected not boolean', payload({ rows: [row('vessel', 'match', { corrected: 1 })], counts: {} }), 'MRS_INVALID rows.corrected'],
    ['counts more than rows', payload({ counts: { match: 7 } }), 'MRS_INVALID counts'],
    ['counts negative', payload({ counts: { match: -1 } }), 'MRS_INVALID counts'],
    ['counts fraction', payload({ counts: { match: 1.5 } }), 'MRS_INVALID counts'],
    ['counts unknown key', payload({ counts: { info: 1 } }), 'MRS_INVALID unknown_key'],
    ['reviewed row not in the rows', payload({ reviewed_rows: ['iban'] }), 'MRS_INVALID reviewed_rows'],
    ['reviewed rows duplicated', payload({ reviewed_rows: ['bl_number', 'bl_number'] }), 'MRS_INVALID reviewed_rows'],
    ['reviewed rows not an array', payload({ reviewed_rows: 'bl_number' }), 'MRS_INVALID reviewed_rows'],
    ['note too long', payload({ note: 'x'.repeat(1001) }), 'MRS_TOO_LONG note'],
    ['transaction malformed', payload({ transaction_id: 'nope' }), 'MRS_INVALID transaction_id'],
    ['transaction of another org', payload({ transaction_id: TX_B }), 'MRS_NOT_FOUND transaction'],
    // overall ↔ rows
    ['critical mismatch saved as review', payload({ rows: [row('bl_number', 'mismatch', { critical: true })], counts: { mismatch: 1 } }), 'MRS_INVALID overall'],
    ['mismatch saved as match', payload({ overall: 'match', rows: [row('vessel', 'mismatch')], counts: { mismatch: 1 } }), 'MRS_INVALID overall'],
    ['critical partial saved as match', payload({ overall: 'match', rows: [row('hs_codes', 'partial', { critical: true })], counts: { partial: 1 } }), 'MRS_INVALID overall']
  ];
  for (const [name, p, want] of cases) {
    await check('refused: ' + name + ' → ' + want, async () => {
      const got = await code(() => save('staff', p));
      return got.startsWith(want) || 'got: ' + got;
    });
  }
  await check('overall accepted when consistent: a non-critical partial / missing with match; a critical mismatch with mismatch', async () => {
    const a = await save('staff', payload({ overall: 'match', rows: [row('vessel', 'partial'), row('incoterms', 'missing'), row('bl_number', 'match', { critical: true })],
      counts: { match: 1, partial: 1, missing: 1 }, reviewed_rows: [] }));
    const b = await save('staff', payload({ overall: 'mismatch', rows: [row('consignee', 'mismatch', { critical: true })], counts: { mismatch: 1 }, reviewed_rows: [] }));
    const c = await save('staff', payload({ overall: 'review', rows: [row('items', 'match'), row('items', 'partial')], counts: { match: 1, partial: 1 }, reviewed_rows: ['items'] }));
    return (a.overall === 'match' && b.overall === 'mismatch' && c.status === 'saved') || J({ a, b, c });
  });
  // kinds / voided / foreign extractions
  await check('kinds: a B/L in the invoice slot / an invoice in the B/L slot / an invoice in the declaration slot → MRS_MATCH_DOC_KIND <slot>', async () => {
    const a = await code(() => save('staff', payload({ invoice_extraction_id: X.bl, bl_extraction_id: X.inv })));
    const i2 = await ext('commercial_invoice'), i3 = await ext('commercial_invoice');
    const b = await code(() => save('staff', payload({ bl_extraction_id: i2 })));
    const c = await code(() => save('staff', payload({ mode: 'three_way', declaration_extraction_id: i3, rows: rows3(GOOD_ROWS) })));
    return (a === 'MRS_MATCH_DOC_KIND invoice_extraction_id' && b === 'MRS_MATCH_DOC_KIND bl_extraction_id' && c === 'MRS_MATCH_DOC_KIND declaration_extraction_id') || J({ a, b, c });
  });
  await check('kind = the CURRENT doc_type: a reviewer who corrects the type to commercial_invoice makes it usable', async () => {
    const id = await ext('other');
    const before = await code(() => save('staff', payload({ invoice_extraction_id: id })));
    await as('staff', `UPDATE public.document_extractions SET doc_type = 'commercial_invoice' WHERE id = $1`, [id]);
    const after = await save('staff', payload({ invoice_extraction_id: id }));
    return (before === 'MRS_MATCH_DOC_KIND invoice_extraction_id' && after.status === 'saved') || J({ before, after });
  });
  await check('a voided extraction → MRS_MATCH_DOC_VOIDED <slot>', async () => {
    const id = await ext('bill_of_lading');
    await as('staff', `UPDATE public.document_extractions SET voided_at = now(), void_reason = 'خطأ' WHERE id = $1`, [id]);
    const got = await code(() => save('staff', payload({ bl_extraction_id: id })));
    return got === 'MRS_MATCH_DOC_VOIDED bl_extraction_id' || got;
  });
  await check('an extraction of another org → MRS_NOT_FOUND <slot> (never its kind / state)', async () => {
    const id = await ext('bill_of_lading', { org: B, by: U.staffB });
    const got = await code(() => save('staff', payload({ bl_extraction_id: id })));
    const ghost = await code(() => save('staff', payload({ invoice_extraction_id: 'd0c0ffff-0000-4000-8000-000000000001' })));
    return (got === 'MRS_NOT_FOUND bl_extraction_id' && ghost === 'MRS_NOT_FOUND invoice_extraction_id') || J({ got, ghost });
  });
  // transactions
  X.invJ = await ext('commercial_invoice', { tx: TX_JED }); X.blJ = await ext('bill_of_lading', { tx: TX_JED });
  X.blD = await ext('bill_of_lading', { tx: TX_DMM }); X.declJ = await ext('customs_declaration', { tx: TX_JED });
  await check('a match on a transaction: extractions of that transaction (or unlinked) → transaction_id stored', async () => {
    const r = await save('jed', payload({ transaction_id: TX_JED, invoice_extraction_id: X.invJ, bl_extraction_id: X.bl }));
    X.mJ = r.id;
    return r.transaction_id === TX_JED || J(r);
  });
  await check('no transaction in the payload: the match adopts the extractions\' transaction (branch-scoped like them)', async () => {
    const r = await save('staff', payload({ invoice_extraction_id: X.invJ, bl_extraction_id: X.blJ, mode: 'three_way', declaration_extraction_id: X.declJ, rows: rows3(GOOD_ROWS) }));
    X.mJ3 = r.id;
    return r.transaction_id === TX_JED || J(r);
  });
  await check('extractions of two different transactions, or of another transaction than the payload\'s → MRS_INVALID transaction_id', async () => {
    const a = await code(() => save('staff', payload({ invoice_extraction_id: X.invJ, bl_extraction_id: X.blD })));
    const b = await code(() => save('staff', payload({ transaction_id: TX_JED2, invoice_extraction_id: X.invJ })));
    return (a === 'MRS_INVALID transaction_id' && b === 'MRS_INVALID transaction_id') || J({ a, b });
  });
  await check('branch: a DMM-only member cannot use a JED transaction (MRS_NOT_FOUND transaction) nor JED extractions (MRS_NOT_FOUND <slot>)', async () => {
    const a = await code(() => save('dmm', payload({ transaction_id: TX_JED })));
    const b = await code(() => save('dmm', payload({ invoice_extraction_id: X.invJ })));
    const c = await save('dmm', payload({ transaction_id: TX_DMM, bl_extraction_id: X.blD }));
    return (a === 'MRS_NOT_FOUND transaction' && b === 'MRS_NOT_FOUND invoice_extraction_id' && c.transaction_id === TX_DMM) || J({ a, b, c });
  });
  // who may save
  await check('callers: a client (portal), a stranger, a deactivated member, staff of org B → MRS_FORBIDDEN; no session → MRS_AUTH_REQUIRED', async () => {
    const got = [];
    for (const w of ['portal', 'stranger', 'gone', 'staffB']) got.push(await code(() => save(w, payload())));
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', false);`);
    let none;
    try { none = await code(() => q(`SELECT public.save_document_match($1, $2)`, [A, payload()])); }
    finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
    return (got.every(g => g === 'MRS_FORBIDDEN') && none === 'MRS_AUTH_REQUIRED') || J({ got, none });
  });
  await check('org admin at aal1 (MFA not completed) → MRS_MFA_REQUIRED; at aal2 → saved', async () => {
    const a = await code(() => save('admin', payload(), A, 'aal1'));
    const b = await save('admin', payload());
    return (a.startsWith('MRS_MFA_REQUIRED') && b.status === 'saved') || J({ a, b });
  });
  // idempotency
  await check('idempotency: the same key + payload replays the first result (one row); another payload with the key → MRS_IDEMPOTENCY_CONFLICT', async () => {
    const k = newKey();
    const n0 = await num(`SELECT count(*) n FROM public.document_matches`);
    const a = await save('staff', payload({ idempotencyKey: k }));
    const b = await save('staff', payload({ idempotencyKey: k }));
    const c = await code(() => save('staff', payload({ idempotencyKey: k, note: 'غير ذلك' })));
    const d = await code(() => save('jed', payload({ idempotencyKey: k })));
    const n1 = await num(`SELECT count(*) n FROM public.document_matches`);
    return (a.id === b.id && b.replayed === true && c.startsWith('MRS_IDEMPOTENCY_CONFLICT') && d.startsWith('MRS_IDEMPOTENCY_CONFLICT') && n1 === n0 + 1)
      || J({ a, b, c, d, n0, n1 });
  });
  await check('a malformed idempotency key → MRS_INVALID idempotency_key', async () =>
    (await code(() => save('staff', payload({ idempotencyKey: 'abc' })))) === 'MRS_INVALID idempotency_key');
}

/* ================================================================== 6. RLS */
async function secRls() {
  section('6. RLS: two orgs, branches, clients, direct writes');
  const ids = async who => (await as(who, `SELECT id FROM public.document_matches ORDER BY created_at`)).map(r => r.id);
  X.mB = (await save('staffB', {
    invoice_extraction_id: await ext('commercial_invoice', { org: B, by: U.staffB }), bl_extraction_id: await ext('bill_of_lading', { org: B, by: U.staffB }),
    mode: 'two_way', engine_version: 'match-v1', overall: 'review', counts: COUNTS, rows: GOOD_ROWS }, B)).id;
  await check('org isolation: org A staff never see org B\'s match and vice versa', async () => {
    const a = await ids('staff'), b = await ids('staffB');
    return (!a.includes(X.mB) && b.length === 1 && b[0] === X.mB && a.includes(X.m1)) || J({ a: a.length, b });
  });
  await check('org-wide staff see every org A match (with or without transaction)', async () => {
    const a = await ids('staff');
    return [X.m1, X.m3, X.mJ, X.mJ3].every(x => a.includes(x)) || J(a.length);
  });
  await check('branch scoping: the JED member sees JED and unlinked matches, not DMM; the DMM member the reverse', async () => {
    const j = await ids('jed'), d = await ids('dmm');
    const dm = (await q(`SELECT id FROM public.document_matches WHERE transaction_id = $1`, [TX_DMM])).map(r => r.id);
    return (j.includes(X.mJ) && j.includes(X.m1) && !dm.some(x => j.includes(x)) && !d.includes(X.mJ) && !d.includes(X.mJ3) && d.includes(X.m1)
      && dm.every(x => d.includes(x)) && dm.length === 1) || J({ j: j.length, d: d.length, dm });
  });
  await check('an unlinked match whose extraction is LATER linked to a JED transaction is hidden from the DMM member too', async () => {
    const inv = await ext('commercial_invoice'), bl = await ext('bill_of_lading');
    const r = await save('staff', payload({ invoice_extraction_id: inv, bl_extraction_id: bl }));
    const before = (await ids('dmm')).includes(r.id);
    await as('staff', `UPDATE public.document_extractions SET transaction_id = $2 WHERE id = $1`, [inv, TX_JED]);
    const after = (await ids('dmm')).includes(r.id), jed = (await ids('jed')).includes(r.id);
    const rv = await code(() => review('dmm', r.id, ['bl_number']));
    return (before && !after && jed && rv === 'MRS_NOT_FOUND document_match') || J({ before, after, jed, rv });
  });
  await check('clients (portal), strangers, deactivated members: no rows; anon: permission denied', async () => {
    const p = await ids('portal'), s = await ids('stranger'), g = await ids('gone');
    const a = await tryErr(() => as('anon', `SELECT 1 FROM public.document_matches`));
    return (p.length === 0 && s.length === 0 && g.length === 0 && /permission denied/.test(a)) || J({ p, s, g, a });
  });
  await check('no direct write for staff (INSERT / UPDATE / DELETE → permission denied), even the org admin', async () => {
    const i = await tryErr(() => as('staff', `INSERT INTO public.document_matches (org_id, invoice_extraction_id, bl_extraction_id, mode, engine_version, overall, rows)
      VALUES ($1, $2, $3, 'two_way', 'match-v1', 'match', '[{"key":"vessel","status":"match"}]')`, [A, X.inv, X.bl]));
    const u = await tryErr(() => as('admin', `UPDATE public.document_matches SET overall = 'match' WHERE id = $1`, [X.m1]));
    const d = await tryErr(() => as('admin', `DELETE FROM public.document_matches WHERE id = $1`, [X.m1]));
    return (/permission denied/.test(i) && /permission denied/.test(u) && /permission denied/.test(d)) || J({ i, u, d });
  });
}

/* ================================================================== 7. review / void */
async function secReview() {
  section('7. review_document_match / void_document_match');
  await check('review: status reviewed, the ticked rows, the note, reviewed_by = the caller (no four-eyes: the saver may review)', async () => {
    const r = await review('staff', X.m1, ['bl_number', 'container_numbers', 'gross_weight'], '  تمت المراجعة  ');
    const m = await one(`SELECT status, reviewed_rows, review_note, reviewed_by, reviewed_at, created_by FROM public.document_matches WHERE id = $1`, [X.m1]);
    return (r.status === 'reviewed' && r.reviewed_at && r.reviewed_by === U.staff && m.status === 'reviewed' && m.reviewed_rows.length === 3
      && m.review_note === 'تمت المراجعة' && m.reviewed_by === U.staff && m.created_by === U.staff) || J({ r, m });
  });
  await check('re-review by another staff member replaces the ticks / note and records the new reviewer', async () => {
    const r = await review('jed', X.m1, ['bl_number'], null);
    const m = await one(`SELECT reviewed_rows, review_note, reviewed_by FROM public.document_matches WHERE id = $1`, [X.m1]);
    return (r.status === 'reviewed' && J(m.reviewed_rows) === '["bl_number"]' && m.review_note === null && m.reviewed_by === U.jed) || J(m);
  });
  await check('review refusals: no ticks → MRS_REQUIRED reviewed_rows; unknown / duplicated key or not an array → MRS_INVALID; note > 1000 → MRS_TOO_LONG', async () => {
    const a = await code(() => review('staff', X.m3, []));
    const b = await code(() => review('staff', X.m3, ['iban']));
    const c = await code(() => review('staff', X.m3, ['bl_number', 'bl_number']));
    const d = await code(() => review('staff', X.m3, { a: 1 }));
    const e = await code(() => review('staff', X.m3, ['bl_number'], 'x'.repeat(1001)));
    return (a === 'MRS_REQUIRED reviewed_rows' && b === 'MRS_INVALID reviewed_rows' && c === 'MRS_INVALID reviewed_rows' && d === 'MRS_INVALID reviewed_rows'
      && e === 'MRS_TOO_LONG note') || J({ a, b, c, d, e });
  });
  await check('review by someone who cannot see the match → MRS_NOT_FOUND document_match (org B, DMM member on a JED match, client, unknown id)', async () => {
    const got = [await code(() => review('staffB', X.m1, ['bl_number'])), await code(() => review('dmm', X.mJ, ['bl_number'])),
      await code(() => review('portal', X.m1, ['bl_number'])), await code(() => review('staff', 'd0c0ffff-0000-4000-8000-000000000009', ['bl_number']))];
    return got.every(g => g === 'MRS_NOT_FOUND document_match') || J(got);
  });
  await check('void: a reason is required (MRS_REQUIRED void_reason), at most 500 characters', async () => {
    const a = await code(() => voidM('staff', X.m1b, '   '));
    const b = await code(() => voidM('staff', X.m1b, 'x'.repeat(501)));
    return (a === 'MRS_REQUIRED void_reason' && b === 'MRS_TOO_LONG void_reason') || J({ a, b });
  });
  await check('void: {status voided, voided_at, voided_by}; then void again / review → MRS_MATCH_VOIDED; still listed (no delete)', async () => {
    const r = await voidM('jed', X.m1b, 'مطابقة مكررة');
    const again = await code(() => voidM('staff', X.m1b, 'مرة أخرى'));
    const rv = await code(() => review('staff', X.m1b, ['bl_number']));
    const m = await one(`SELECT voided_by, void_reason FROM public.document_matches WHERE id = $1`, [X.m1b]);
    return (r.status === 'voided' && r.voided_at && r.voided_by === U.jed && again === 'MRS_MATCH_VOIDED' && rv === 'MRS_MATCH_VOIDED'
      && m.voided_by === U.jed && m.void_reason === 'مطابقة مكررة' && (await as('staff', `SELECT 1 FROM public.document_matches WHERE id = $1`, [X.m1b])).length === 1) || J({ r, again, rv, m });
  });
  await check('void by someone who cannot see it → MRS_NOT_FOUND document_match', async () =>
    (await code(() => voidM('dmm', X.mJ3, 'x'))) === 'MRS_NOT_FOUND document_match');
}

/* ================================================================== 8. guard + audit */
async function secGuard() {
  section('8. guard (owner / SQL Editor too) and the audit trail');
  const immut = { rows: `'[{"key":"vessel","status":"match"}]'::jsonb`, overall: `'match'`, invoice_extraction_id: `'${X.decl}'`, org_id: `'${B}'`,
    mode: `'two_way'`, match_count: '9', note: `'x'`, created_by: `'${U.admin}'`, transaction_id: `'${TX_JED2}'` };
  for (const [col, val] of Object.entries(immut)) {
    await check(`owner UPDATE of ${col} → MRS_IMMUTABLE ${col}`, async () => {
      const got = await code(() => q(`UPDATE public.document_matches SET ${col} = ${val} WHERE id = $1`, [X.m3]));
      return got === 'MRS_IMMUTABLE ' + col || got;
    });
  }
  await check('a voided match is frozen even for the owner (MRS_MATCH_VOIDED); reviewed → saved is a bad transition', async () => {
    const a = await code(() => q(`UPDATE public.document_matches SET review_note = 'x' WHERE id = $1`, [X.m1b]));
    const b = await code(() => q(`UPDATE public.document_matches SET status = 'saved', reviewed_at = NULL, reviewed_by = NULL WHERE id = $1`, [X.m1]));
    return (a === 'MRS_MATCH_VOIDED' && b === 'MRS_BAD_TRANSITION status') || J({ a, b });
  });
  await check('no DELETE, even for the owner (MRS_APPEND_ONLY document_matches)', async () =>
    (await code(() => q(`DELETE FROM public.document_matches WHERE id = $1`, [X.m3]))) === 'MRS_APPEND_ONLY document_matches');
  await check('table checks: mode ⇔ declaration, distinct extractions, reviewed ⇔ reviewer, void ⇔ reason, ≤ 60 rows', async () => {
    const base = `INSERT INTO public.document_matches (org_id, invoice_extraction_id, bl_extraction_id, declaration_extraction_id, mode, engine_version, overall, rows, status, reviewed_at, reviewed_by, voided_at, void_reason, created_by)`;
    const r1 = `'[{"key":"vessel","status":"match"}]'`;
    const got = [
      await tryErr(() => q(`${base} VALUES ($1, $2, $3, NULL, 'three_way', 'match-v1', 'match', ${r1}, 'saved', NULL, NULL, NULL, NULL, $4)`, [A, X.inv, X.bl, U.staff])),
      await tryErr(() => q(`${base} VALUES ($1, $2, $2, NULL, 'two_way', 'match-v1', 'match', ${r1}, 'saved', NULL, NULL, NULL, NULL, $3)`, [A, X.inv, U.staff])),
      await tryErr(() => q(`${base} VALUES ($1, $2, $3, NULL, 'two_way', 'match-v1', 'match', ${r1}, 'reviewed', NULL, NULL, NULL, NULL, $4)`, [A, X.inv, X.bl, U.staff])),
      await tryErr(() => q(`${base} VALUES ($1, $2, $3, NULL, 'two_way', 'match-v1', 'match', ${r1}, 'saved', NULL, NULL, now(), NULL, $4)`, [A, X.inv, X.bl, U.staff])),
      await tryErr(() => q(`${base} VALUES ($1, $2, $3, NULL, 'two_way', 'match-v1', 'match', $5, 'saved', NULL, NULL, NULL, NULL, $4)`, [A, X.inv, X.bl, U.staff,
        J(Array.from({ length: 61 }, () => ({ key: 'items', status: 'match' })))])),
      await tryErr(() => q(`${base} VALUES ($1, $2, $3, NULL, 'two_way', 'match-v1', 'match', '[]', 'saved', NULL, NULL, NULL, NULL, $4)`, [A, X.inv, X.bl, U.staff]))];
    const want = ['document_matches_mode_chk', 'document_matches_distinct_chk', 'document_matches_review_chk', 'document_matches_void_chk', 'document_matches_rows_chk', 'document_matches_rows_chk'];
    return got.every((g, i) => g.includes(want[i])) || J(got);
  });
  await check('foreign keys: an extraction of another org cannot be referenced even by the owner (composite FK)', async () => {
    const idB = await ext('bill_of_lading', { org: B, by: U.staffB });
    const got = await tryErr(() => q(`INSERT INTO public.document_matches (org_id, invoice_extraction_id, bl_extraction_id, mode, engine_version, overall, rows, created_by)
      VALUES ($1, $2, $3, 'two_way', 'match-v1', 'match', '[{"key":"vessel","status":"match"}]', $4)`, [A, X.inv, idB, U.staff]));
    return /document_matches_bl_fk|foreign key/.test(got) || got;
  });
  await check('audit: INSERT / UPDATE (review) / UPDATE (void) rows for the match, by the acting user', async () => {
    const r = await q(`SELECT action, actor, changed_fields FROM public.audit_log WHERE table_name = 'document_matches' AND row_id = $1 ORDER BY id`, [X.m1b]);
    return (r.length === 2 && r[0].action === 'INSERT' && r[0].actor === U.staff && r[1].action === 'UPDATE' && r[1].actor === U.jed
      && r[1].changed_fields.includes('voided_at') && r[1].changed_fields.includes('void_reason')) || J(r);
  });
  await check('audit: the compared values (rows) and the free-text notes never reach audit_log; changed_fields still names them', async () => {
    const r = await q(`SELECT old_data, new_data, changed_fields FROM public.audit_log WHERE table_name = 'document_matches'`);
    const leaks = r.filter(x => ['rows', 'note', 'review_note', 'void_reason'].some(k => (x.new_data && k in x.new_data) || (x.old_data && k in x.old_data)));
    const rev = r.find(x => x.changed_fields && x.changed_fields.includes('review_note'));
    const txt = J(r);
    return (r.length >= 10 && leaks.length === 0 && rev && !/CSQU3054383|ملاحظة|تمت المراجعة|مطابقة مكررة/.test(txt)) || J({ n: r.length, leaks: leaks.length });
  });
}

/* ================================================================== 9. supa.js (vm) */
async function secSupa() {
  section('9. supa.js: saveDocumentMatch / reviewDocumentMatch / listDocumentMatches / voidDocumentMatch (vm, mocked client)');
  const src = rd('assets/js/supa.js');
  const calls = [];
  let nextRpc = { data: { id: 'x', created_at: 'now', status: 'saved' }, error: null };
  let listRes = { data: [], error: null };
  function builder(table) {
    const b = { table, ops: [] };
    ['select', 'eq', 'is', 'order', 'limit', 'maybeSingle', 'range', 'or', 'single', 'insert', 'update'].forEach(m => {
      b[m] = function () { b.ops.push([m].concat([].slice.call(arguments))); return b; };
    });
    b.then = (res, rej) => { calls.push({ from: table, ops: b.ops }); return Promise.resolve(typeof listRes === 'function' ? listRes() : listRes).then(res, rej); };
    return b;
  }
  const client = {
    rpc: (name, a) => { calls.push({ rpc: name, args: a }); const p = Promise.resolve(nextRpc); p.abortSignal = () => p; return p; },
    from: t => builder(t),
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: () => Promise.resolve({ data: { session: null } }) }
  };
  function load(config) {
    const store = {};
    const win = {
      MARSA_CONFIG: config, supabase: { createClient: () => client }, addEventListener() {}, dispatchEvent() {},
      location: { origin: 'http://127.0.0.1:8000', pathname: '/ocr.html', hostname: '127.0.0.1', href: 'http://127.0.0.1:8000/ocr.html' }
    };
    const ctx = { window: win, document: { currentScript: null, head: { appendChild() {} }, createElement: () => ({}), addEventListener() {},
        documentElement: { setAttribute() {}, getAttribute: () => null, hasAttribute: () => false }, querySelector: () => null, querySelectorAll: () => [] },
      localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: { onLine: true }, location: win.location,
      console, setTimeout, clearTimeout, Promise, CustomEvent: function () {}, crypto: require('crypto').webcrypto, URL, Date, Math, JSON };
    win.window = win;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    return { api: win.MarsaApi, store };
  }
  let api = null, loadErr = null;
  try { api = load({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'test-anon-key-not-real', orgSlug: 'blue-sea' }).api; } catch (e) { loadErr = e; }
  await check('supa.js loads in a vm and exports the match calls', () =>
    (api && ['saveDocumentMatch', 'reviewDocumentMatch', 'listDocumentMatches', 'voidDocumentMatch', 'getDocumentMatch'].every(k => typeof api[k] === 'function')) || String(loadErr));
  if (!api) return;
  const ORG = A;
  await check('saveDocumentMatch → RPC save_document_match {p_org, p_payload} with the contract keys + an idempotency key', async () => {
    calls.length = 0;
    const r = await api.saveDocumentMatch({ orgId: ORG, transactionId: TX_JED, invoiceExtractionId: X.inv, blExtractionId: X.bl, declarationExtractionId: X.decl,
      mode: 'three_way', engineVersion: 'match-v1', overall: 'review', counts: { match: 2, mismatch: 0, partial: 1, missing: 0 }, rows: [{ key: 'vessel', status: 'match' }],
      reviewedRows: ['vessel'], note: 'n' });
    const c = calls.find(x => x.rpc === 'save_document_match');
    const p = c && c.args.p_payload;
    return (r.data && r.data.status === 'saved' && c && c.args.p_org === ORG && p.invoice_extraction_id === X.inv && p.bl_extraction_id === X.bl
      && p.declaration_extraction_id === X.decl && p.transaction_id === TX_JED && p.mode === 'three_way' && p.engine_version === 'match-v1'
      && p.overall === 'review' && J(p.counts) === J({ match: 2, mismatch: 0, partial: 1, missing: 0 }) && J(p.reviewed_rows) === '["vessel"]'
      && p.note === 'n' && /^[0-9a-f-]{36}$/.test(p.idempotencyKey)) || J({ r, c });
  });
  await check('saveDocumentMatch: mode defaults from the declaration; refused before any call: ids, overall, rows, note', async () => {
    calls.length = 0;
    await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, overall: 'match', rows: [{ key: 'vessel', status: 'match' }] });
    const m = calls[0] && calls[0].args.p_payload.mode;
    calls.length = 0;
    const bad = [
      await api.saveDocumentMatch({ orgId: ORG, blExtractionId: X.bl, overall: 'match', rows: [{}] }),
      await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, overall: 'match', rows: [{}] }),
      await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, overall: 'ok', rows: [{}] }),
      await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, overall: 'match', rows: [] }),
      await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, overall: 'match', rows: [{}], note: 'x'.repeat(1001) })];
    return (m === 'two_way' && calls.length === 0 && J(bad.map(b => b.error.code + ':' + b.error.field)) === J(['MRS_REQUIRED:invoice_extraction_id',
      'MRS_REQUIRED:bl_extraction_id', 'MRS_INVALID:overall', 'MRS_INVALID:rows', 'MRS_TOO_LONG:note'])) || J({ m, calls: calls.length, bad: bad.map(b => b.error && b.error.code) });
  });
  await check('reviewDocumentMatch → review_document_match {p_id, p_reviewed_rows, p_note}; no ticks refused before the call', async () => {
    calls.length = 0;
    nextRpc = { data: { id: X.m1, status: 'reviewed', reviewed_at: 'now' }, error: null };
    const r = await api.reviewDocumentMatch(X.m1, ['vessel'], 'ok');
    const c = calls.find(x => x.rpc === 'review_document_match');
    const e = await api.reviewDocumentMatch(X.m1, []);
    return (r.data.status === 'reviewed' && c.args.p_id === X.m1 && J(c.args.p_reviewed_rows) === '["vessel"]' && c.args.p_note === 'ok'
      && e.error.code === 'MRS_REQUIRED' && calls.length === 1) || J({ r, c, e });
  });
  await check('voidDocumentMatch → void_document_match {p_id, p_reason}; empty reason refused before the call', async () => {
    calls.length = 0;
    const r = await api.voidDocumentMatch(X.m1, '  سبب  ');
    const e = await api.voidDocumentMatch(X.m1, ' ');
    return (calls.length === 1 && calls[0].rpc === 'void_document_match' && calls[0].args.p_reason === 'سبب' && e.error.code === 'MRS_REQUIRED' && e.error.field === 'void_reason') || J(calls);
  });
  await check('server errors keep their MRS code + an Arabic message (MRS_MATCH_DOC_KIND names the slot)', async () => {
    nextRpc = { data: null, error: { message: 'MRS_MATCH_DOC_KIND', details: 'bl_extraction_id', code: 'P0001' } };
    const r = await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, overall: 'match', rows: [{ key: 'vessel', status: 'match' }] });
    nextRpc = { data: null, error: { message: 'MRS_NOT_FOUND', details: 'document_match', code: 'P0001' } };
    const n = await api.reviewDocumentMatch(X.m1, ['vessel']);
    return (r.error.code === 'MRS_MATCH_DOC_KIND' && /بوليصة الشحن/.test(r.error.message) && n.error.code === 'MRS_NOT_FOUND'
      && /المطابقة غير موجودة/.test(n.error.message)) || J({ r: r.error, n: n.error });
  });
  await check('listDocumentMatches → document_matches of the org, newest first, live only, limit 10 by default; rows mapped (transaction_ref, counts, voided)', async () => {
    calls.length = 0;
    listRes = { data: [{ id: 'm1', created_at: 't', overall: 'review', mode: 'two_way', transaction_id: TX_JED, transactions: { ref: 'MRS-2026-000001' },
      match_count: 3, mismatch_count: 0, partial_count: 1, missing_count: 1, status: 'reviewed', voided_at: null },
      { id: 'm2', created_at: 't', overall: 'match', mode: 'three_way', transaction_id: null, transactions: null, match_count: 1, mismatch_count: 0, partial_count: 0,
        missing_count: 0, status: 'saved', voided_at: 'x' }], error: null };
    const r = await api.listDocumentMatches({ orgId: ORG, transactionId: TX_JED });
    const c = calls.find(x => x.from === 'document_matches');
    const ops = J(c && c.ops);
    const d = r.data;
    return (c && /transactions!document_matches_tx_fk\(ref\)/.test(ops) && !/"rows/.test(ops) && ops.includes(J(['eq', 'org_id', ORG])) && ops.includes(J(['eq', 'transaction_id', TX_JED]))
      && ops.includes(J(['is', 'voided_at', null])) && ops.includes(J(['limit', 10])) && ops.includes('"ascending":false')
      && d[0].transaction_ref === 'MRS-2026-000001' && J(d[0].counts) === J({ match: 3, mismatch: 0, partial: 1, missing: 1 }) && d[0].status === 'reviewed'
      && !('transactions' in d[0]) && d[1].transaction_ref === null && d[1].status === 'voided') || J({ ops, d });
  });
  // packing list (20261126000100)
  await check('saveDocumentMatch + packingExtractionId → payload.packing_extraction_id, engine match-v2 by default; the mode stays from the declaration', async () => {
    calls.length = 0;
    nextRpc = { data: { id: 'x', created_at: 'now', status: 'saved' }, error: null };
    await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, packingExtractionId: X.pack, overall: 'review', rows: [{ key: 'vessel', status: 'match' }] });
    const p = calls[0] && calls[0].args.p_payload;
    calls.length = 0;
    await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, declarationExtractionId: X.decl, packingExtractionId: X.pack,
      engineVersion: 'match-v2', overall: 'review', rows: [{ key: 'vessel', status: 'match' }] });
    const p3 = calls[0] && calls[0].args.p_payload;
    return (p && p.packing_extraction_id === X.pack && p.engine_version === 'match-v2' && p.mode === 'two_way' && p.declaration_extraction_id === null
      && p3.packing_extraction_id === X.pack && p3.mode === 'three_way' && p3.engine_version === 'match-v2') || J({ p, p3 });
  });
  await check('saveDocumentMatch without a packing list: no packing_extraction_id key at all (a database without 20261126000100 keeps working), engine match-v1', async () => {
    calls.length = 0;
    await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, overall: 'review', rows: [{ key: 'vessel', status: 'match' }] });
    const p = calls[0] && calls[0].args.p_payload;
    calls.length = 0;
    const bad = await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, packingExtractionId: 'nope', overall: 'review', rows: [{}] });
    return (p && !('packing_extraction_id' in p) && p.engine_version === 'match-v1' && calls.length === 0
      && bad.error.code === 'MRS_INVALID' && bad.error.field === 'packing_extraction_id') || J({ p, bad: bad.error });
  });
  await check('listDocumentMatches / getDocumentMatch select packing_extraction_id; rows carry packing_extraction_id + with_packing', async () => {
    calls.length = 0;
    listRes = { data: [{ id: 'm1', created_at: 't', overall: 'review', mode: 'two_way', transaction_id: null, transactions: null, packing_extraction_id: X.pack,
      engine_version: 'match-v2', match_count: 1, mismatch_count: 0, partial_count: 0, missing_count: 0, status: 'saved', voided_at: null }], error: null };
    const r = await api.listDocumentMatches({ orgId: ORG });
    const ops = J(calls.find(x => x.from === 'document_matches').ops);
    listRes = { data: { id: 'm2', packing_extraction_id: null, rows: [], transactions: null, match_count: 0 }, error: null };
    calls.length = 0;
    const g = await api.getDocumentMatch(X.m1);
    const gops = J(calls.find(x => x.from === 'document_matches').ops);
    return (/packing_extraction_id/.test(ops) && /packing_extraction_id/.test(gops) && r.data[0].packing_extraction_id === X.pack && r.data[0].with_packing === true
      && g.data.packing_extraction_id === null && g.data.with_packing === false) || J({ ops, r: r.data, g });
  });
  await check('a database without 20261126000100 (42703 unknown column): list / get read the earlier columns once more (packing_extraction_id null)', async () => {
    calls.length = 0;
    let n = 0;
    listRes = () => (++n === 1
      ? { data: null, error: { code: '42703', message: 'column document_matches.packing_extraction_id does not exist', details: null, hint: null } }
      : { data: [{ id: 'm1', created_at: 't', overall: 'match', mode: 'two_way', transactions: null, match_count: 1, mismatch_count: 0, partial_count: 0, missing_count: 0 }], error: null });
    const r = await api.listDocumentMatches({ orgId: ORG });
    const sel = calls.filter(x => x.from === 'document_matches').map(x => J(x.ops.find(o => o[0] === 'select')));
    n = 0;
    listRes = () => (++n === 1 ? { data: null, error: { code: '42501', message: 'permission denied for table document_matches' } } : { data: [], error: null });
    const e = await api.listDocumentMatches({ orgId: ORG });
    listRes = { data: [], error: null };
    return (r.data && r.data.length === 1 && r.data[0].packing_extraction_id === null && sel.length === 2 && /packing_extraction_id/.test(sel[0])
      && !/packing_extraction_id/.test(sel[1]) && e.error && n === 1) || J({ r, sel, e, n });
  });
  await check('server errors on the packing slot: MRS_MATCH_DOC_KIND names «بيان التعبئة»; MRS_NOT_FOUND / MRS_REQUIRED packing_extraction_id have their own text', async () => {
    nextRpc = { data: null, error: { message: 'MRS_MATCH_DOC_KIND', details: 'packing_extraction_id', code: 'P0001' } };
    const a = await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, packingExtractionId: X.pack, overall: 'match', rows: [{ key: 'vessel', status: 'match' }] });
    nextRpc = { data: null, error: { message: 'MRS_NOT_FOUND', details: 'packing_extraction_id', code: 'P0001' } };
    const b = await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, packingExtractionId: X.pack, overall: 'match', rows: [{ key: 'vessel', status: 'match' }] });
    nextRpc = { data: null, error: { message: 'MRS_REQUIRED', details: 'packing_extraction_id', code: 'P0001' } };
    const c = await api.saveDocumentMatch({ orgId: ORG, invoiceExtractionId: X.inv, blExtractionId: X.bl, engineVersion: 'match-v2', overall: 'match', rows: [{ key: 'vessel', status: 'match' }] });
    nextRpc = { data: { id: 'x', created_at: 'now', status: 'saved' }, error: null };
    return (a.error.code === 'MRS_MATCH_DOC_KIND' && /بيان التعبئة/.test(a.error.message) && /قراءة بيان التعبئة غير موجودة/.test(b.error.message)
      && /بيان التعبئة/.test(c.error.message)) || J({ a: a.error, b: b.error, c: c.error });
  });
  await check('demo mode (no config): every match call → MRS_DEMO_MODE, nothing stored locally', async () => {
    const d = load({});
    const a2 = d.api;
    const r = [await a2.saveDocumentMatch({}), await a2.reviewDocumentMatch('x', ['a']), await a2.listDocumentMatches({}), await a2.voidDocumentMatch('x', 'y')];
    return (r.every(x => x.error && x.error.code === 'MRS_DEMO_MODE') && Object.keys(d.store).length === 0) || J(r.map(x => x.error && x.error.code));
  });
  await check('error strings: MRS_MATCH_DOC_KIND / _DOC_VOIDED / MRS_MATCH_VOIDED in Arabic + English in supa.js and i18n.js', () => {
    const i18 = rd('assets/js/i18n.js');
    const bad = ['MRS_MATCH_DOC_KIND', 'MRS_MATCH_DOC_VOIDED', 'MRS_MATCH_VOIDED'].filter(c =>
      (src.match(new RegExp(c + ':', 'g')) || []).length !== 2 || (i18.match(new RegExp(c + ':', 'g')) || []).length !== 2);
    const codes = [...new Set((fs.readFileSync(MIG_FILE, 'utf8').match(/app\.fail\('(MRS_[A-Z_]+)'/g) || []).map(x => x.slice(10, -1)))];
    const missing = codes.filter(c => !new RegExp('\\b' + c + ':').test(src));
    return (bad.length === 0 && missing.length === 0) || J({ bad, missing });
  });
}

/* ================================================================== 11. packing list (20261126000100) */
const PMIG = '20261126000100_doc_match_packing.sql';
const PMIG_FILE = path.join(MIG_DIR, PMIG);
const P_NEW_FNS = ['app.doc_match_rows_check(p_rows jsonb, p_mode text, p_packing boolean)',
  'app.doc_match_visible(p_org uuid, p_tx uuid, p_inv uuid, p_bl uuid, p_decl uuid, p_pack uuid)'];
const P_RECREATED = ['app.doc_match_rows_check(p_rows jsonb, p_mode text)', 'app.doc_match_visible(p_org uuid, p_tx uuid, p_inv uuid, p_bl uuid, p_decl uuid)',
  'app.tg_document_matches_guard()', 'public.review_document_match(p_id uuid, p_reviewed_rows jsonb, p_note text)',
  'public.save_document_match(p_org uuid, p_payload jsonb)', 'public.void_document_match(p_id uuid, p_reason text)'];
// rows of a match with the packing list: + values / conf 'packing' and the pairs inv_pack, bl_pack (+ decl_pack in three_way)
function rowsP(list, three) {
  return list.map(r => {
    const st = r.status === 'info' ? null : r.status;
    const pairs = Object.assign({}, r.pairs, { inv_pack: st, bl_pack: st }, three ? { decl_pack: st } : {});
    return Object.assign({}, r, { values: Object.assign({ packing: r.values && r.values.bl !== undefined ? r.values.bl : 'A' }, r.values),
      conf: Object.assign({ packing: 0.85 }, r.conf), pairs });
  });
}
function payloadP(o) {
  return payload(Object.assign({ packing_extraction_id: X.pack, engine_version: 'match-v2', rows: rowsP(GOOD_ROWS) }, o || {}));
}

async function secPackFile() {
  section('11a. packing list migration: file conventions, all_migrations.sql');
  const src = fs.readFileSync(PMIG_FILE, 'utf8');
  const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
  await check('file conventions: header, encoding guard, preflight on 20261125000100, schema_versions row, no BEGIN / COMMIT, search_path = \'\' on every function', () => {
    const c = src.replace(/--.*$/gm, '');
    const bad = heads.filter(h => !/SET search_path = ''/.test(h));
    return (/^-- =+\n-- Marsa — STAGING \/ PROTOTYPE\. 20261126000100 — /.test(src) && /ENCODING ERROR: Arabic text was pasted incorrectly/.test(src)
      && /version = '20261125000100'/.test(src) && /MATCH PACKING preflight: apply legacy_import first/.test(src)
      && src.includes("INSERT INTO public.schema_versions (version, name) VALUES ('20261126000100', 'doc_match_packing')\nON CONFLICT (version) DO NOTHING;")
      && !/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(c) && heads.length === 8 && bad.length === 0) || J({ n: heads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('SECURITY DEFINER exactly on the 3 RPCs and the 2 visibility helpers; every refusal through app.fail(\'MRS_*\'); no new error code', () => {
    const definer = heads.filter(h => /SECURITY DEFINER/.test(h)).map(h => (h.match(/FUNCTION ([a-z_.]+)\(/) || [])[1]).sort();
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|MATCH PACKING preflight/.test(r));
    const codes = [...new Set((src.match(/app\.fail\('([A-Z_]+)'/g) || []).map(x => x.slice(10, -1)))];
    const old = new Set((fs.readFileSync(MIG_FILE, 'utf8').match(/app\.fail\('([A-Z_]+)'/g) || []).map(x => x.slice(10, -1)));
    return (J(definer) === J(['app.doc_match_visible', 'app.doc_match_visible', 'public.review_document_match', 'public.save_document_match', 'public.void_document_match'])
      && raises.length === 0 && codes.length > 5 && codes.every(c => old.has(c))) || J({ definer, raises: raises.length, codes });
  });
  await check('no TRUNCATE / DROP TABLE / DROP FUNCTION / DISABLE TRIGGER; no key or endpoint; the arguments of save / review / void unchanged', () => {
    const c = src.replace(/--.*$/gm, '');
    return (!/\bTRUNCATE\b/i.test(c) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA|COLUMN)/i.test(c) && !/DISABLE TRIGGER/i.test(c) && !/session_replication_role/.test(c)
      && !/sk-ant|api\.anthropic\.com/i.test(src) && /FUNCTION public\.save_document_match\(p_org uuid, p_payload jsonb\) RETURNS jsonb/.test(src)
      && /FUNCTION public\.review_document_match\(p_id uuid, p_reviewed_rows jsonb, p_note text\) RETURNS jsonb/.test(src)
      && /FUNCTION public\.void_document_match\(p_id uuid, p_reason text\) RETURNS jsonb/.test(src)) || 'body';
  });
  // later phases may follow this file (20261127000100 tx_draft_approval: transactions.approval_match_id → document_matches; no match object changed)
  const PLATER = ['20261127000100_tx_draft_approval.sql', '20261128000100_return_extension.sql'];
  await check('this file is the latest migration (or only listed later phases follow it)', () =>
    migFiles().filter(f => f > PMIG).every(f => PLATER.includes(f)) || 'latest: ' + migFiles().pop());
  await check('all_migrations.sql holds this file verbatim (followed only by the listed later phases, in order) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + PMIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const after = next < 0 ? [] : (all.slice(next).match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && after.every(f => PLATER.includes(f)) && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, all.indexOf('DO $guard$')).includes('health_check() = 20261125000100') && all.slice(0, all.indexOf('DO $guard$')).includes(PMIG)
      && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
  await check('docs: DOC_MATCH_AR.md names the migration and the packing slot; LEGACY_PORT_PLAN_AR.md has a dated line', () => {
    const d = rd('docs/online/DOC_MATCH_AR.md'), pl = rd('docs/online/LEGACY_PORT_PLAN_AR.md');
    const miss = [PMIG, 'packing_extraction_id', 'بيان التعبئة', 'match-v2', 'packing_list', 'ai-doc-v3'].filter(k => !d.includes(k));
    return (miss.length === 0 && /\(2026-11-12\)[^\n]*20261126000100_doc_match_packing\.sql/.test(pl)) || J({ miss, plan: /20261126000100/.test(pl) });
  });
}

async function secPackPreflight() {
  section('11b. packing list migration: preflight, re-run, catalog delta (separate database, no seed)');
  const src = fs.readFileSync(PMIG_FILE, 'utf8');
  const d = await freshDb(PMIG);
  try {
    await withDb(d, async () => {
      const C0 = await catalog();
      const cols0 = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_matches' ORDER BY 1`)).map(x => x.column_name);
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261125000100'`);
      const msg = await tryErr(() => db.exec(src));
      const cols1 = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_matches' ORDER BY 1`)).map(x => x.column_name);
      await check('without legacy_import: exact preflight message, nothing created', async () =>
        (msg.startsWith('MATCH PACKING preflight: apply legacy_import first (schema_versions lacks 20261125000100 legacy_import)')
          && J(cols0) === J(cols1) && !cols1.includes('packing_extraction_id') && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261125000100', 'legacy_import')`);
      const r1 = await tryErr(() => db.exec(src));
      const C1 = await catalog();
      const k1 = await q(`SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid = 'public.document_matches'::regclass ORDER BY 1`);
      const r2 = await tryErr(() => db.exec(src));
      const k2 = await q(`SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid = 'public.document_matches'::regclass ORDER BY 1`);
      await check('applies, and re-runs on top of itself with an identical catalog and constraints; one schema_versions row', async () =>
        (r1 === 'ok' && r2 === 'ok' && J(C1) === J(await catalog()) && J(k1) === J(k2)
          && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261126000100'`)) === 1) || J({ r1, r2 }));
      const s0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the 2 new overloads; only the 6 re-created bodies changed (ACL / definer / config kept); no table / trigger / policy added', () => {
        const added = C1.fns.filter(f => !s0.has(f.sig)).map(f => f.sig).sort();
        const changed = C1.fns.filter(f => s0.has(f.sig) && J(s0.get(f.sig)) !== J(f)).map(f => f.sig).sort();
        const sameMeta = P_RECREATED.every(sig => { const a = s0.get(sig), b = C1.fns.find(f => f.sig === sig); return a && b && a.acl === b.acl && a.d === b.d && a.c === b.c; });
        return (J(added) === J(P_NEW_FNS.slice().sort()) && J(changed) === J(P_RECREATED.slice().sort()) && sameMeta
          && J(C0.tables) === J(C1.tables) && J(C0.trg) === J(C1.trg) && J(C0.pol) === J(C1.pol)) || J({ added, changed, sameMeta });
      });
      await check('column packing_extraction_id uuid NULL; composite FK (id, org_id) → document_extractions; distinct + engine checks; an index', async () => {
        const c = await one(`SELECT data_type t, is_nullable n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_matches' AND column_name = 'packing_extraction_id'`);
        const k = new Map(k1.map(x => [x.conname, x.def]));
        const ix = await one(`SELECT count(*)::int n FROM pg_indexes WHERE tablename = 'document_matches' AND indexname = 'document_matches_pack_idx'`);
        return (c && c.t === 'uuid' && c.n === 'YES'
          && /FOREIGN KEY \(packing_extraction_id, org_id\) REFERENCES (public\.)?document_extractions\(id, org_id\)/.test(k.get('document_matches_pack_fk') || '')
          && /packing_extraction_id/.test(k.get('document_matches_pack_distinct_chk') || '') && /match-v2/.test(k.get('document_matches_pack_engine_chk') || '')
          && k.has('document_matches_distinct_chk') && k.has('document_matches_mode_chk') && ix.n === 1) || J({ c, k: k1.map(x => x.conname) });
      });
      await check('the SELECT policy goes through the 6-argument helper (+ packing_extraction_id); the conversion lists are unchanged', async () => {
        const p = await one(`SELECT qual FROM pg_policies WHERE tablename = 'document_matches' AND policyname = 'document_matches_select'`);
        const t = C0.fns.find(f => f.sig === 'app.convert_delete_tables()'), t1 = C1.fns.find(f => f.sig === 'app.convert_delete_tables()');
        return (/doc_match_visible\(org_id, transaction_id, invoice_extraction_id, bl_extraction_id, declaration_extraction_id, packing_extraction_id\)/.test(p.qual)
          && J(t) === J(t1)) || J(p);
      });
    });
  } finally { await d.close(); }
}

async function secPack() {
  section('11c. packing list: grants, save (match-v2), list, visibility, review / void, guard, table checks');
  await check('grants: the 6-argument visibility helper executable by authenticated only; the 3-argument rows check closed; RPC grants unchanged', async () => {
    const r = await one(`SELECT has_function_privilege('authenticated', 'app.doc_match_visible(uuid,uuid,uuid,uuid,uuid,uuid)', 'EXECUTE') va,
                                has_function_privilege('anon', 'app.doc_match_visible(uuid,uuid,uuid,uuid,uuid,uuid)', 'EXECUTE') vn,
                                has_function_privilege('service_role', 'app.doc_match_visible(uuid,uuid,uuid,uuid,uuid,uuid)', 'EXECUTE') vs,
                                has_function_privilege('authenticated', 'app.doc_match_rows_check(jsonb,text,boolean)', 'EXECUTE') ra,
                                has_function_privilege('authenticated', 'app.doc_match_rows_check(jsonb,text)', 'EXECUTE') r2,
                                has_function_privilege('authenticated', 'public.save_document_match(uuid,jsonb)', 'EXECUTE') sa,
                                has_function_privilege('anon', 'public.save_document_match(uuid,jsonb)', 'EXECUTE') sn,
                                has_function_privilege('service_role', 'public.save_document_match(uuid,jsonb)', 'EXECUTE') ss`);
    return (r.va && !r.vn && !r.vs && !r.ra && !r.r2 && r.sa && !r.sn && !r.ss) || J(r);
  });
  X.pack = await ext('packing_list', { fields: { packing_list_number: 'PL-0001', gross_weight: '27500', packages_count: '1200' } });
  X.pack2 = await ext('packing_list');
  await check('old saves keep their meaning: every match saved before is match-v1 with packing_extraction_id NULL', async () => {
    const r = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE engine_version = 'match-v1' AND packing_extraction_id IS NULL)::int v1 FROM public.document_matches`);
    return (r.n > 10 && r.n === r.v1) || J(r);
  });
  await check('two_way + packing (match-v2): saved; packing values / pairs stored; mode stays two_way', async () => {
    const r = await save('staff', payloadP());
    X.mP = r.id;
    const m = await one(`SELECT packing_extraction_id p, declaration_extraction_id d, mode, engine_version e, rows FROM public.document_matches WHERE id = $1`, [r.id]);
    return (r.status === 'saved' && r.mode === 'two_way' && m.p === X.pack && m.d === null && m.mode === 'two_way' && m.e === 'match-v2'
      && m.rows[0].values.packing !== undefined && m.rows[0].pairs.bl_pack === 'match' && m.rows[0].conf.packing === 0.85) || J({ r, m });
  });
  await check('three_way + packing (match-v2): saved with decl_pack pairs; mode three_way (decided by the declaration)', async () => {
    const r = await save('staff', payloadP({ mode: 'three_way', declaration_extraction_id: X.decl, rows: rowsP(rows3(GOOD_ROWS), true) }));
    X.mP3 = r.id;
    const m = await one(`SELECT packing_extraction_id p, declaration_extraction_id d, mode, rows FROM public.document_matches WHERE id = $1`, [r.id]);
    return (m.p === X.pack && m.d === X.decl && m.mode === 'three_way' && m.rows[0].pairs.decl_pack === 'match' && m.rows[0].values.declaration === 'A') || J(m);
  });
  await check('B/L gross 25000 vs packing gross 27500: a critical mismatch row must be saved as overall mismatch', async () => {
    const mm = row('gross_weight', 'mismatch', { critical: true, values: { invoice: 25000, bl: 25000, packing: 27500 }, conf: { invoice: 0.9, bl: 0.9, packing: 0.9 },
      pairs: { inv_bl: 'match', inv_pack: 'mismatch', bl_pack: 'mismatch' } });
    const bad = await code(() => save('staff', payloadP({ rows: [mm], counts: { mismatch: 1 }, reviewed_rows: [] })));
    const ok = await save('staff', payloadP({ overall: 'mismatch', rows: [mm], counts: { mismatch: 1 }, reviewed_rows: [] }));
    return (bad === 'MRS_INVALID overall' && ok.overall === 'mismatch') || J({ bad, ok });
  });
  const ib = await ext('commercial_invoice');
  const voidedPack = await ext('packing_list');
  await as('staff', `UPDATE public.document_extractions SET voided_at = now(), void_reason = 'خطأ' WHERE id = $1`, [voidedPack]);
  const packB = await ext('packing_list', { org: B, by: U.staffB });
  const cases = [
    ['match-v2 without a packing list', () => payload({ engine_version: 'match-v2' }), 'MRS_REQUIRED packing_extraction_id'],
    ['match-v1 with a packing list', () => payloadP({ engine_version: 'match-v1' }), 'MRS_INVALID engine_version'],
    ['another engine version (match-v3)', () => payloadP({ engine_version: 'match-v3' }), 'MRS_INVALID engine_version'],
    ['packing id malformed', () => payloadP({ packing_extraction_id: 'x' }), 'MRS_INVALID packing_extraction_id'],
    ['packing = the invoice', () => payloadP({ packing_extraction_id: X.inv }), 'MRS_INVALID packing_extraction_id'],
    ['packing = the B/L', () => payloadP({ packing_extraction_id: X.bl }), 'MRS_INVALID packing_extraction_id'],
    ['packing = the declaration', () => payloadP({ mode: 'three_way', declaration_extraction_id: X.decl, packing_extraction_id: X.decl, rows: rowsP(rows3(GOOD_ROWS), true) }), 'MRS_INVALID packing_extraction_id'],
    ['a commercial invoice in the packing slot', () => payloadP({ packing_extraction_id: ib }), 'MRS_MATCH_DOC_KIND packing_extraction_id'],
    ['a packing list in the invoice slot', () => payloadP({ invoice_extraction_id: X.pack2 }), 'MRS_MATCH_DOC_KIND invoice_extraction_id'],
    ['a voided packing list', () => payloadP({ packing_extraction_id: voidedPack }), 'MRS_MATCH_DOC_VOIDED packing_extraction_id'],
    ['a packing list of another org', () => payloadP({ packing_extraction_id: packB }), 'MRS_NOT_FOUND packing_extraction_id'],
    ['an unknown packing id', () => payloadP({ packing_extraction_id: 'd0c0ffff-0000-4000-8000-0000000000aa' }), 'MRS_NOT_FOUND packing_extraction_id'],
    ['a packing value without the packing list (match-v1)', () => payload({ rows: rowsP(GOOD_ROWS) }), 'MRS_INVALID rows.values'],
    ['a packing confidence without the packing list', () => payload({ rows: [row('vessel', 'match', { conf: { packing: 0.5 } })], counts: {} }), 'MRS_INVALID rows.conf'],
    ['a packing pair without the packing list', () => payload({ rows: [row('vessel', 'match', { pairs: { inv_pack: 'match' } })], counts: {} }), 'MRS_INVALID rows.pairs'],
    ['decl_pack in a two_way packing match', () => payloadP({ rows: [row('vessel', 'match', { pairs: { decl_pack: 'match' } })], counts: {} }), 'MRS_INVALID rows.pairs'],
    ['an unknown document key next to packing', () => payloadP({ rows: [row('vessel', 'match', { values: { packing_list: 'x' } })], counts: {} }), 'MRS_INVALID rows.values'],
    ['more than 60 rows (limit unchanged)', () => payloadP({ rows: Array.from({ length: 61 }, () => row('items', 'match')), counts: {} }), 'MRS_INVALID rows_too_many']
  ];
  for (const [name, mk, want] of cases) {
    await check('packing refused: ' + name + ' → ' + want, async () => {
      const got = await code(() => save('staff', mk()));
      return got.startsWith(want) || 'got: ' + got;
    });
  }
  await check('packing of another transaction → MRS_INVALID transaction_id; a packing list on a transaction is adopted (branch-scoped)', async () => {
    const pd = await ext('packing_list', { tx: TX_DMM }), pj = await ext('packing_list', { tx: TX_JED });
    const a = await code(() => save('staff', payloadP({ invoice_extraction_id: X.invJ, packing_extraction_id: pd })));
    const b = await save('staff', payloadP({ packing_extraction_id: pj }));
    const pj2 = await ext('packing_list', { tx: TX_JED });
    const c = await code(() => save('dmm', payloadP({ packing_extraction_id: pj2 })));
    return (a === 'MRS_INVALID transaction_id' && b.transaction_id === TX_JED && c === 'MRS_NOT_FOUND packing_extraction_id') || J({ a, b, c });
  });
  await check('idempotency with packing: the same key + payload replays (one row)', async () => {
    const k = newKey();
    const n0 = await num(`SELECT count(*) n FROM public.document_matches`);
    const a = await save('staff', payloadP({ idempotencyKey: k })), b = await save('staff', payloadP({ idempotencyKey: k }));
    return (a.id === b.id && b.replayed === true && (await num(`SELECT count(*) n FROM public.document_matches`)) === n0 + 1) || J({ a, b });
  });
  await check('list: staff read packing_extraction_id (null on the 2- / 3-document matches)', async () => {
    const r = await as('staff', `SELECT id, packing_extraction_id p, engine_version e FROM public.document_matches WHERE id = ANY ($1)`, [[X.mP, X.mP3, X.m1, X.m3]]);
    const by = new Map(r.map(x => [x.id, x]));
    return (r.length === 4 && by.get(X.mP).p === X.pack && by.get(X.mP3).p === X.pack && by.get(X.m1).p === null && by.get(X.m3).p === null
      && by.get(X.m1).e === 'match-v1') || J(r);
  });
  await check('visibility through the packing list: an unlinked match whose packing reading is LATER linked to a JED transaction is hidden from the DMM member', async () => {
    const inv = await ext('commercial_invoice'), bl = await ext('bill_of_lading'), pk = await ext('packing_list');
    X.pack3 = pk;
    const r = await save('staff', payloadP({ invoice_extraction_id: inv, bl_extraction_id: bl, packing_extraction_id: pk }));
    X.mPV = r.id;
    const seen = async who => (await as(who, `SELECT 1 FROM public.document_matches WHERE id = $1`, [r.id])).length === 1;
    const before = await seen('dmm');
    await as('staff', `UPDATE public.document_extractions SET transaction_id = $2 WHERE id = $1`, [pk, TX_JED]);
    const after = await seen('dmm'), jed = await seen('jed'), staff = await seen('staff');
    const v5 = (await as('dmm', `SELECT app.doc_match_visible($1, NULL, $2, $3, NULL) v`, [A, inv, bl]))[0].v;
    const v6 = (await as('dmm', `SELECT app.doc_match_visible($1, NULL, $2, $3, NULL, $4) v`, [A, inv, bl, pk]))[0].v;
    const rv = await code(() => review('dmm', r.id, ['bl_number']));
    const vd = await code(() => voidM('dmm', r.id, 'x'));
    return (before && !after && jed && staff && v5 === true && v6 === false && rv === 'MRS_NOT_FOUND document_match' && vd === 'MRS_NOT_FOUND document_match')
      || J({ before, after, jed, staff, v5, v6, rv, vd });
  });
  await check('review / void of a packing match: the JED member reviews then voids it; voided → frozen', async () => {
    const r = await review('jed', X.mPV, ['bl_number', 'gross_weight'], 'راجعت بيان التعبئة');
    const v = await voidM('jed', X.mPV, 'إعادة قراءة بيان التعبئة');
    const again = await code(() => review('staff', X.mPV, ['bl_number']));
    const m = await one(`SELECT status, voided_by, packing_extraction_id p FROM public.document_matches WHERE id = $1`, [X.mPV]);
    return (r.status === 'reviewed' && v.status === 'voided' && v.voided_by === U.jed && again === 'MRS_MATCH_VOIDED' && m.p === X.pack3) || J({ r, v, again, m });
  });
  await check('org B never sees org A\'s packing matches; clients / anon nothing', async () => {
    const b = await as('staffB', `SELECT 1 FROM public.document_matches WHERE packing_extraction_id IS NOT NULL`);
    const p = await as('portal', `SELECT 1 FROM public.document_matches WHERE packing_extraction_id IS NOT NULL`);
    return (b.length === 0 && p.length === 0) || J({ b: b.length, p: p.length });
  });
  await check('guard: owner UPDATE of packing_extraction_id → MRS_IMMUTABLE packing_extraction_id', async () => {
    const got = await code(() => q(`UPDATE public.document_matches SET packing_extraction_id = $2 WHERE id = $1`, [X.mP, X.pack2]));
    const nul = await code(() => q(`UPDATE public.document_matches SET packing_extraction_id = NULL WHERE id = $1`, [X.mP]));
    return (got === 'MRS_IMMUTABLE packing_extraction_id' && nul === 'MRS_IMMUTABLE packing_extraction_id') || J({ got, nul });
  });
  await check('table checks (owner insert): packing = invoice → pack_distinct_chk; packing on match-v1 → pack_engine_chk; packing of org B → pack_fk', async () => {
    const base = `INSERT INTO public.document_matches (org_id, invoice_extraction_id, bl_extraction_id, packing_extraction_id, mode, engine_version, overall, rows, created_by)`;
    const r1 = `'[{"key":"vessel","status":"match"}]'`;
    const a = await tryErr(() => q(`${base} VALUES ($1, $2, $3, $2, 'two_way', 'match-v2', 'match', ${r1}, $4)`, [A, X.inv, X.bl, U.staff]));
    const b = await tryErr(() => q(`${base} VALUES ($1, $2, $3, $5, 'two_way', 'match-v1', 'match', ${r1}, $4)`, [A, X.inv, X.bl, U.staff, X.pack2]));
    const c = await tryErr(() => q(`${base} VALUES ($1, $2, $3, $5, 'two_way', 'match-v2', 'match', ${r1}, $4)`, [A, X.inv, X.bl, U.staff, packB]));
    return (a.includes('document_matches_pack_distinct_chk') && b.includes('document_matches_pack_engine_chk') && /document_matches_pack_fk|foreign key/.test(c)) || J({ a, b, c });
  });
  await check('audit: a packing match is audited (INSERT) without its rows; packing_extraction_id is in the trail', async () => {
    const r = await one(`SELECT action, new_data FROM public.audit_log WHERE table_name = 'document_matches' AND row_id = $1 AND action = 'INSERT'`, [X.mP]);
    return (r && !('rows' in r.new_data) && r.new_data.packing_extraction_id === X.pack) || J(r);
  });
}

/* ================================================================== 10. conversion (last: changes the deployment) */
async function secConvert() {
  section('10. convert_org_to_production deletes the org\'s matches (with the extractions, in one statement)');
  await check('convert_check: document_matches is classified and its delete guard listed (no unclassified / unexpected guard blocker)', async () => {
    const c = (await one(`SELECT app.convert_check($1) c`, [A])).c;
    return !c.some(x => /unclassified_tables|unexpected_delete_guards/.test(x)) || J(c);
  });
  await check('convert_org_preview counts the org\'s document_matches', async () => {
    const p = (await one(`SELECT public.convert_org_preview($1) p`, [A])).p;
    const n = await num(`SELECT count(*) n FROM public.document_matches WHERE org_id = $1`, [A]);
    const s = J(p);
    return (n > 10 && new RegExp('"document_matches":' + n + '\\b').test(s)) || s.slice(0, 600);
  });
  // conditions of the conversion: the owner is a platform admin with the admin membership; no other staging org
  await q(`INSERT INTO public.platform_admins (user_id, note) VALUES ($1, 'owner') ON CONFLICT DO NOTHING`, [U.admin]);
  await q(`UPDATE public.organizations SET environment = 'production' WHERE id = $1`, [B]);
  const nB = await num(`SELECT count(*) n FROM public.document_matches WHERE org_id = $1`, [B]);
  const nA = await num(`SELECT count(*) n FROM public.document_matches WHERE org_id = $1`, [A]);
  const block = (await one(`SELECT app.convert_check($1) c`, [A])).c;
  let r = null, err = 'ok';
  if (block.length === 0) {
    try { r = (await one(`SELECT public.convert_org_to_production($1, 'marsa-match', 'مرسى للتخليص', 'Marsa Clearance', 'DELETE-TEST-DATA-marsa-match') r`, [A])).r; }
    catch (e) { err = errText(e); }
  } else err = 'blocked: ' + J(block);
  await check('the conversion runs; its summary counts the deleted document_matches', () =>
    (r && r.deleted && r.deleted.document_matches === nA && nA > 10) || J({ err, deleted: r && r.deleted && r.deleted.document_matches, nA }));
  await check('after: no match / extraction of the org left; org B\'s matches untouched; the delete guard is back on', async () => {
    const a = await num(`SELECT count(*) n FROM public.document_matches WHERE org_id = $1`, [A]);
    const e = await num(`SELECT count(*) n FROM public.document_extractions WHERE org_id = $1`, [A]);
    const b = await num(`SELECT count(*) n FROM public.document_matches WHERE org_id = $1`, [B]);
    const g = (await one(`SELECT tgenabled e FROM pg_trigger WHERE tgrelid = 'public.document_matches'::regclass AND tgname = 'trg_no_delete'`)).e;
    const del = await code(() => q(`DELETE FROM public.document_matches WHERE org_id = $1`, [B]));
    return (a === 0 && e === 0 && b === nB && g === 'O' && del === 'MRS_APPEND_ONLY document_matches') || J({ a, e, b, g, del });
  });
  await check('every deleted match left its DELETE row in audit_log (without the compared values)', async () => {
    const r = await q(`SELECT old_data FROM public.audit_log WHERE table_name = 'document_matches' AND action = 'DELETE'`);
    return (r.length === nA && r.every(x => !('rows' in x.old_data) && !('note' in x.old_data))) || J({ n: r.length, nA });
  });
}

/* ================================================================== main */
(async () => {
  console.log('Marsa — document matching SQL tests (PGlite; local only)');
  await secFile();
  await secPreflight();
  await secPackFile();
  await secPackPreflight();

  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  if (!QUIET) console.log('  loaded');

  await secGrants();
  await secKeys();
  await secSave();
  await secRls();
  await secReview();
  await secGuard();
  await secPack();
  await secSupa();
  await secConvert();
  await check('no network call was attempted', () => fetchCalls === 0);
  await db.close();

  console.log('\n' + '-'.repeat(70));
  if (nFail) {
    console.log('FAILURES:');
    for (const f of fails) console.log('  - ' + f);
    console.log(`FAILED — ${nPass} passed, ${nFail} failed`);
    process.exit(1);
  }
  console.log(`OK — ${nPass} passed, 0 failed`);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
