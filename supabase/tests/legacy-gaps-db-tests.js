#!/usr/bin/env node
/*
  Marsa (مرسى) — the legacy gaps of the staff screens: migration 20261201000100_legacy_gaps.sql + the assets/js/supa.js wrappers.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).
  Invented data only (seed org "blue-sea" + made-up users / codes).

  Covers: file conventions + all_migrations.sql; preflight refusal; re-run on itself (identical catalog);
    1. match_client — Daftra code exact (strong) / prefix (weak) / typed into the name, 2-letter word-prefix name match, rows carry
       daftra_client_code + port_category, cross-org / portal / anon refused, malformed code refused;
    2. set_client_legacy_fields — ops writers set category + Daftra code (audit row), accountant refused, other org / portal not
       found, invalid category / code, code taken (case-insensitive), clearing, no-op; the API guard still refuses a direct write;
       staff_internal_fields returns the code to staff only;
    3. follow-up employee — responsible_user_id at creation / later: active staff of the org only (other org, portal, inactive
       refused), org-wide or the transaction's active branch only, unchanged value not re-checked, a non-writer cannot change it
       (RLS); list_assignable_staff rows (names only) / branch filter / gates (ops writers, of p_branch);
    4. container seal / size-type at creation (normalised; over-long refused);
    5. custody_balances — client_code, q on the code, org totals; gates;
    6. report_trips — party_type 'unset' / the effective type (carrier alone = company) in rows + filter, rows (client, party type, orders, driver mobile, declaration no.), transport_value; gates;
    7. report_transactions totals.by_daftra_state shape (finance readers) / null (others);
    supa.js — the wrappers and their RPC names (ES5).

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-gaps-db-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261201000100_legacy_gaps.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in legacy-gaps-db-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'd7a30000-0000-4000-8000-0000000000b0';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const TX_JED = '0b5e0000-0000-4000-8000-000000000201';      // seed: declaration TEST-DEC-0001, client A
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const CLIENT_A2 = '0b5e0000-0000-4000-8000-000000000102';
const CLIENT_A3 = '0b5e0000-0000-4000-8000-000000000103';
const BR_B = 'd7a30000-0000-4000-8000-0000000000b1';
const CL_B = 'd7a30000-0000-4000-8000-0000000000b3';
const U = {
  admin: 'd7a31000-0000-4000-8000-000000000001',
  acc: 'd7a31000-0000-4000-8000-000000000002',      // accountant (finance reader, not an ops writer)
  jed: 'd7a31000-0000-4000-8000-000000000005',      // clearance_staff, JED (ops writer)
  dmm: 'd7a31000-0000-4000-8000-000000000006',      // clearance_staff, DMM
  gone: 'd7a31000-0000-4000-8000-000000000007',     // inactive clearance_staff of A
  portal: 'd7a31000-0000-4000-8000-000000000008',   // client user of CLIENT_A
  staffB: 'd7a31000-0000-4000-8000-00000000000a'    // admin of B
};

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[who], role: 'authenticated', aal: 'aal2' })]);
    await db.exec(`SET ROLE authenticated;`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
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
async function code(fn) {
  try { await fn(); return 'ok'; } catch (e) {
    const m = e.message || '';
    if (/^MRS_/.test(m)) return m + (e.detail ? ' ' + e.detail : '');
    let x = m.match(/violates check constraint "([^"]+)"/); if (x) return 'chk:' + x[1];
    if (/row-level security/.test(m)) return 'rls';
    if (/permission denied/.test(m)) return 'perm';
    return errText(e);
  }
}
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
// ISO 6346 check digit
function iso(prefix4, six) {
  const v = prefix4 + six;
  const L = [10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38];
  let s = 0;
  for (let i = 0; i < 10; i++) { const c = v[i]; const n = /[0-9]/.test(c) ? +c : L[c.charCodeAt(0) - 65]; s += n * (1 << i); }
  return v + String((s % 11) % 10);
}
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
async function catalog2() {
  return q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig, md5(p.prosrc) h, coalesce(p.proacl::text, '') acl
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public')
            UNION ALL SELECT 'trg:' || c.relname || '.' || t.tgname, md5(pg_get_triggerdef(t.oid)), ''
              FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal ORDER BY 1`);
}

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@gaps.example.com', now()), ('${U.acc}', 'acc@gaps.example.com', now()),
    ('${U.jed}', 'jed@gaps.example.com', now()), ('${U.dmm}', 'dmm@gaps.example.com', now()), ('${U.gone}', 'gone@gaps.example.com', now()),
    ('${U.portal}', 'portal@gaps.example.com', now()), ('${U.staffB}', 'staffb@gaps.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'مدير تجريبي'), ('${U.acc}', 'محاسب تجريبي'), ('${U.jed}', 'موظف جدة'),
    ('${U.dmm}', 'موظف الدمام'), ('${U.gone}', 'موظف سابق'), ('${U.portal}', 'عميل البوابة'), ('${U.staffB}', 'مدير ب')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'gaps-org-b', 'مؤسسة ب', 'Gaps org B', 'GPB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', 'Client B Co', '0509990000');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role, is_active) VALUES
    ('${U.admin}', '${A}', NULL, 'admin', true), ('${U.acc}', '${A}', NULL, 'accountant', true),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff', true), ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff', true),
    ('${U.gone}', '${A}', '${JED}', 'clearance_staff', false),
    ('${U.staffB}', '${B}', NULL, 'admin', true);
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;

/* ------------------------------------------------------------------ sections */
async function secFile() {
  section('1. file + all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('migration: preflight on tx_container_count (20261130000100), schema_versions row, no BEGIN/COMMIT, down-path, search_path pinned', () => {
    const fns = (s.match(/CREATE OR REPLACE FUNCTION/g) || []).length, pinned = (s.match(/SET search_path = ''/g) || []).length;
    return (/version = '20261130000100'/.test(s) && /VALUES \('20261201000100', 'legacy_gaps'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s)
      && /Down-path:/.test(s) && fns === 8 && pinned === 8) || J({ fns, pinned });
  });
  // later phases (each has its own suite) follow it, in order
  const LATER_PHASES = ['20261202000100_org_logo.sql', '20261203000100_draft_client_hidden.sql', '20261204000100_tx_stage_sets.sql'];
  await check('this file is the latest migration (later phases excepted)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && J(later) === J(LATER_PHASES)) || 'later ' + J(later);
  });
  const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
  await check('all_migrations.sql: appended verbatim under its header (followed only by the later phases); the paste note names it', () => {
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    const rest = nx < 0 ? '' : all.slice(nx);
    const later = (rest.match(/-- ===== migrations\/([^ ]+) =====/g) || []).map(x => x.replace(/^-- ===== migrations\/| =====$/g, ''));
    return (i > 0 && body === s && J(later) === J(LATER_PHASES) && all.slice(0, 30000).includes(MIG)) || 'not appended verbatim / no note / later ' + J(later);
  });
}

async function secRerun() {
  section('2. preflight + re-run');
  await check('preflight: refused without tx_container_count (nothing changed)', async () => {
    await q(`DELETE FROM public.schema_versions WHERE version = '20261130000100'`);
    const c0 = J(await catalog2());
    const r = await code(() => db.exec(fs.readFileSync(MIG_FILE, 'utf8')));
    await q(`INSERT INTO public.schema_versions (version, name) VALUES ('20261130000100', 'tx_container_count')`);
    return (/LEGACY GAPS preflight/.test(r) && J(await catalog2()) === c0) || r;
  });
  await check('re-run on itself: identical catalog, one schema_versions row', async () => {
    const c1 = J(await catalog2());
    await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
    return (J(await catalog2()) === c1 && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261201000100'`)) === 1) || 'changed';
  });
  await check('helpers / trigger function not executable by API roles; new RPCs: authenticated only', async () => {
    const r = await one(`SELECT has_function_privilege('authenticated', 'app.tg_transactions_responsible()', 'EXECUTE') a,
                                has_function_privilege('authenticated', 'app.rpt_party_types(jsonb)', 'EXECUTE') b,
                                has_function_privilege('anon', 'public.set_client_legacy_fields(uuid,jsonb)', 'EXECUTE') c,
                                has_function_privilege('anon', 'public.list_assignable_staff(uuid,uuid)', 'EXECUTE') d,
                                has_function_privilege('authenticated', 'public.set_client_legacy_fields(uuid,jsonb)', 'EXECUTE') e,
                                has_function_privilege('authenticated', 'public.list_assignable_staff(uuid,uuid)', 'EXECUTE') f,
                                has_function_privilege('anon', 'public.match_client(uuid,jsonb)', 'EXECUTE') g`);
    return (!r.a && !r.b && !r.c && !r.d && r.e && r.f && !r.g) || J(r);
  });
}

const setLegacy = (who, client, p) => rpc(who, `SELECT public.set_client_legacy_fields($1, $2) r`, [client, p]);
const mc = (who, p, org) => rpc(who, `SELECT public.match_client($1, $2) r`, [org || A, p]);
const cand = (r, id) => (r.candidates || []).find(x => x.client_id === id);

async function secClientFields() {
  section('3. set_client_legacy_fields + staff_internal_fields');
  await check('jed (ops writer) sets category + Daftra code (trimmed) → returned, stored, changed', async () => {
    const r = await setLegacy('jed', CLIENT_A, { port_category: 'port', daftra_client_code: '  GAP-001 ' });
    const c = await one(`SELECT port_category, daftra_client_code FROM public.clients WHERE id = $1`, [CLIENT_A]);
    return (r.changed === true && r.daftra_client_code === 'GAP-001' && r.port_category === 'port' && c.daftra_client_code === 'GAP-001' && c.port_category === 'port') || J({ r, c });
  });
  await check('the edit leaves an audit_log row (actor jed, changed daftra_client_code + port_category)', async () => {
    const a = await one(`SELECT actor, changed_fields FROM public.audit_log WHERE table_name = 'clients' AND row_id = $1 AND action = 'UPDATE' ORDER BY id DESC LIMIT 1`, [CLIENT_A]);
    return (a && a.actor === U.jed && a.changed_fields.includes('daftra_client_code') && a.changed_fields.includes('port_category')) || J(a);
  });
  await check('same values again → changed false (no audit row added)', async () => {
    const n0 = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'clients' AND row_id = $1`, [CLIENT_A]);
    const r = await setLegacy('admin', CLIENT_A, { daftra_client_code: 'GAP-001' });
    return (r.changed === false && (await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'clients' AND row_id = $1`, [CLIENT_A])) === n0) || J(r);
  });
  await check('refusals: accountant FORBIDDEN client_edit, org B admin / portal NOT_FOUND client, anon perm', async () => {
    const r = [await code(() => setLegacy('acc', CLIENT_A, { port_category: 'airport' })),
      await code(() => setLegacy('staffB', CLIENT_A, { port_category: 'airport' })),
      await code(() => setLegacy('portal', CLIENT_A, { port_category: 'airport' })),
      await code(() => as('anon', `SELECT public.set_client_legacy_fields($1, '{"port_category":"airport"}')`, [CLIENT_A]))];
    const c = await one(`SELECT port_category FROM public.clients WHERE id = $1`, [CLIENT_A]);
    return (J(r) === J(['MRS_FORBIDDEN client_edit', 'MRS_NOT_FOUND client', 'MRS_NOT_FOUND client', 'perm']) && c.port_category === 'port') || J({ r, c });
  });
  await check('validation: bad category, bad code shape, code taken (case-insensitive), unknown key, empty payload', async () => {
    const r = [await code(() => setLegacy('jed', CLIENT_A2, { port_category: 'sea' })),
      await code(() => setLegacy('jed', CLIENT_A2, { daftra_client_code: 'ab c' })),
      await code(() => setLegacy('jed', CLIENT_A2, { daftra_client_code: '-x' })),
      await code(() => setLegacy('jed', CLIENT_A2, { daftra_client_code: 'gap-001' })),
      await code(() => setLegacy('jed', CLIENT_A2, { name_ar: 'x' })),
      await code(() => setLegacy('jed', CLIENT_A2, {}))];
    return J(r) === J(['MRS_INVALID port_category', 'MRS_INVALID daftra_client_code', 'MRS_INVALID daftra_client_code',
      'MRS_INVALID daftra_client_code_taken', 'MRS_INVALID unknown_key', 'MRS_REQUIRED payload']) || J(r);
  });
  await check('the same code in another org is allowed (unique per org); Arabic digits are made western', async () => {
    const r1 = await setLegacy('staffB', CL_B, { daftra_client_code: 'GAP-001' });
    const r2 = await setLegacy('jed', CLIENT_A2, { daftra_client_code: 'GAP-٠٠٢', port_category: 'airport' });
    return (r1.daftra_client_code === 'GAP-001' && r2.daftra_client_code === 'GAP-002' && r2.port_category === 'airport') || J({ r1, r2 });
  });
  await check('clearing: null / "" clear only the key given', async () => {
    const r = await setLegacy('jed', CLIENT_A2, { port_category: '' });
    const c = await one(`SELECT port_category, daftra_client_code FROM public.clients WHERE id = $1`, [CLIENT_A2]);
    return (r.port_category === null && c.port_category === null && c.daftra_client_code === 'GAP-002') || J({ r, c });
  });
  await check('a direct API write of daftra_client_code is still refused (legacy guard); the column stays out of the clients grant', async () => {
    const r = await code(() => as('jed', `UPDATE public.clients SET daftra_client_code = 'DIRECT-1' WHERE id = $1`, [CLIENT_A2]));
    const sel = await code(() => as('jed', `SELECT daftra_client_code FROM public.clients WHERE id = $1`, [CLIENT_A2]));
    const c = await one(`SELECT daftra_client_code FROM public.clients WHERE id = $1`, [CLIENT_A2]);
    return (r !== 'ok' && sel === 'perm' && c.daftra_client_code === 'GAP-002') || J({ r, sel, c });
  });
  await check('staff_internal_fields(clients) → daftra_client_code + port_category for staff; nothing for portal / other org', async () => {
    const s = await rpc('jed', `SELECT public.staff_internal_fields('clients', $1) r`, [[CLIENT_A, CLIENT_A2]]);
    const p = await rpc('portal', `SELECT public.staff_internal_fields('clients', $1) r`, [[CLIENT_A]]);
    const b = await rpc('staffB', `SELECT public.staff_internal_fields('clients', $1) r`, [[CLIENT_A]]);
    return (s[CLIENT_A].daftra_client_code === 'GAP-001' && s[CLIENT_A].port_category === 'port' && s[CLIENT_A2].daftra_client_code === 'GAP-002'
      && 'notes' in s[CLIENT_A] && J(p) === '{}' && J(b) === '{}') || J({ s, p, b });
  });
}

async function secMatch() {
  section('4. match_client: Daftra code + 2-letter prefix');
  await check('exact code (daftra_client_code key, any case) → strong, rank 3, reason daftra_code, row carries code + category', async () => {
    const r = await mc('jed', { daftra_client_code: 'gap-001' });
    const x = cand(r, CLIENT_A);
    return (x && x.match === 'strong' && x.rank === 3 && x.reasons.includes('daftra_code') && x.daftra_client_code === 'GAP-001'
      && x.port_category === 'port' && r.linked === false && !cand(r, CL_B)) || J(r);
  });
  await check('the code typed into the name field → strong for the exact code', async () => {
    const r = await mc('jed', { name: 'GAP-002' });
    const x = cand(r, CLIENT_A2);
    return (x && x.match === 'strong' && x.reasons.includes('daftra_code')) || J(r);
  });
  await check('a code prefix (2+ characters) → weak with reason daftra_code_prefix, both clients', async () => {
    const r = await mc('jed', { name: 'GAP' });
    const a = cand(r, CLIENT_A), b = cand(r, CLIENT_A2);
    return (a && b && a.match === 'weak' && a.reasons.includes('daftra_code_prefix') && b.reasons.includes('daftra_code_prefix') && r.conflict === false) || J(r);
  });
  await check('2 letters of a word of the name (Arabic) → weak with reason name_prefix', async () => {
    const r = await mc('jed', { name: 'مؤسسة الت' });       // «مؤسسة» is dropped by norm_name → «الت», the start of «التجربة»
    const x = cand(r, CLIENT_A2);
    return (x && x.match === 'weak' && x.reasons.includes('name_prefix')) || J(r);
  });
  await check('2 Latin letters of the English name → weak name_prefix; 1 letter gives no prefix match', async () => {
    const r = await mc('jed', { name_en: 'Te' });
    const r1 = await mc('jed', { name_en: 'T' });
    return ((r.candidates || []).some(x => x.client_id === CLIENT_A3 && x.reasons.includes('name_prefix'))
      && !(r1.candidates || []).some(x => x.reasons.includes('name_prefix'))) || J({ r, r1 });
  });
  await check('VAT / name matching unchanged (strong vat_number for the seed client)', async () => {
    const r = await mc('jed', { name: 'شركة الاختبار الأولى للتجارة', vat_number: '300000000000003' });
    const x = cand(r, CLIENT_A);
    return (x && x.match === 'strong' && x.reasons.includes('vat_number') && x.reasons.includes('name')) || J(r);
  });
  await check('refusals: org B admin on A / portal → MRS_FORBIDDEN org, anon perm, malformed code MRS_INVALID, empty MRS_REQUIRED', async () => {
    const r = [await code(() => mc('staffB', { name: 'GAP-001' })), await code(() => mc('portal', { name: 'GAP-001' })),
      await code(() => as('anon', `SELECT public.match_client($1, '{"name":"GAP-001"}')`, [A])),
      await code(() => mc('jed', { daftra_client_code: 'a b' })), await code(() => mc('jed', {}))];
    return J(r) === J(['MRS_FORBIDDEN org', 'MRS_FORBIDDEN org', 'perm', 'MRS_INVALID daftra_client_code', 'MRS_REQUIRED name']) || J(r);
  });
  await check('org B never sees org A clients (its own GAP-001 only)', async () => {
    const r = await mc('staffB', { daftra_client_code: 'GAP-001' }, B);
    return ((r.candidates || []).length === 1 && r.candidates[0].client_id === CL_B) || J(r);
  });
}

const newTx = (who, extra) => as(who, `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, responsible_user_id)
                                         VALUES ($1, $2, $3, 'import', 'land', $4) RETURNING id`, [A, (extra && extra.branch) || JED, CLIENT_A, extra && extra.resp]).then(r => r[0].id);
async function secResponsible() {
  section('5. follow-up employee (responsible_user_id) + list_assignable_staff');
  let t1;
  await check('creation with an org-wide staff member → stored', async () => {
    t1 = await newTx('jed', { resp: U.admin });
    return (await one(`SELECT responsible_user_id r FROM public.transactions WHERE id = $1`, [t1])).r === U.admin || 'not stored';
  });
  await check('creation refused for another org\'s admin / the portal user / an inactive member / another branch\'s member', async () => {
    const r = [await code(() => newTx('jed', { resp: U.staffB })), await code(() => newTx('jed', { resp: U.portal })),
      await code(() => newTx('jed', { resp: U.gone })), await code(() => newTx('jed', { resp: U.dmm }))];
    return J(r) === J(Array(4).fill('MRS_INVALID responsible_user_id')) || J(r);
  });
  await check('a member of the transaction\'s own branch → stored (admin, DMM transaction, DMM member)', async () => {
    const t = await newTx('admin', { branch: DMM, resp: U.dmm });
    return (await one(`SELECT responsible_user_id r FROM public.transactions WHERE id = $1`, [t])).r === U.dmm || 'not stored';
  });
  await check('a member of a deactivated branch is refused (same rule as has_branch_role)', async () => {
    const t = await newTx('admin', { branch: DMM });
    await q(`UPDATE public.branches SET is_active = false WHERE id = $1`, [DMM]);
    const r = await code(() => as('admin', `UPDATE public.transactions SET responsible_user_id = $2 WHERE id = $1`, [t, U.dmm]));
    await q(`UPDATE public.branches SET is_active = true WHERE id = $1`, [DMM]);
    return r === 'MRS_INVALID responsible_user_id' || r;
  });
  await check('changed later by an ops writer (to the accountant, then cleared); another org\'s user refused', async () => {
    await as('jed', `UPDATE public.transactions SET responsible_user_id = $2 WHERE id = $1`, [t1, U.acc]);
    const a = (await one(`SELECT responsible_user_id r FROM public.transactions WHERE id = $1`, [t1])).r;
    const bad = await code(() => as('jed', `UPDATE public.transactions SET responsible_user_id = $2 WHERE id = $1`, [t1, U.staffB]));
    await as('jed', `UPDATE public.transactions SET responsible_user_id = NULL WHERE id = $1`, [t1]);
    const c = (await one(`SELECT responsible_user_id r FROM public.transactions WHERE id = $1`, [t1])).r;
    return (a === U.acc && bad === 'MRS_INVALID responsible_user_id' && c === null) || J({ a, bad, c });
  });
  await check('a non-writer (accountant) cannot change it (RLS: no row updated)', async () => {
    await as('jed', `UPDATE public.transactions SET responsible_user_id = $2 WHERE id = $1`, [t1, U.jed]);
    await as('acc', `UPDATE public.transactions SET responsible_user_id = $2 WHERE id = $1`, [t1, U.admin]);
    return (await one(`SELECT responsible_user_id r FROM public.transactions WHERE id = $1`, [t1])).r === U.jed || 'changed by accountant';
  });
  await check('an unchanged value is not re-checked: the member deactivated later stays and other edits pass', async () => {
    const t2 = await newTx('admin', { branch: DMM, resp: U.dmm });
    await q(`UPDATE public.memberships SET is_active = false WHERE user_id = $1`, [U.dmm]);
    const r = await code(() => as('admin', `UPDATE public.transactions SET goods_description = 'بضائع تجريبية' WHERE id = $1`, [t2]));
    const again = await code(() => newTx('admin', { branch: DMM, resp: U.dmm }));
    await q(`UPDATE public.memberships SET is_active = true WHERE user_id = $1`, [U.dmm]);
    return (r === 'ok' && (await one(`SELECT responsible_user_id r FROM public.transactions WHERE id = $1`, [t2])).r === U.dmm
      && again === 'MRS_INVALID responsible_user_id') || J({ r, again });
  });
  await check('list_assignable_staff (org-wide writer, no branch): active staff of A only (no portal, inactive, other org); names only', async () => {
    const r = await rpc('admin', `SELECT public.list_assignable_staff($1) r`, [A]);
    const ids = r.rows.map(x => x.user_id);
    const jed = r.rows.find(x => x.user_id === U.jed);
    return ([U.admin, U.acc, U.jed, U.dmm].every(id => ids.includes(id)) && ![U.portal, U.gone, U.staffB].some(id => ids.includes(id))
      && r.rows.every(x => J(Object.keys(x).sort()) === J(['full_name', 'user_id'])) && jed.full_name === 'موظف جدة') || J(r);
  });
  await check('list_assignable_staff with p_branch = JED (admin / the JED writer): org-wide + JED members (no DMM-only member)', async () => {
    const r = [await rpc('admin', `SELECT public.list_assignable_staff($1, $2) r`, [A, JED]), await rpc('jed', `SELECT public.list_assignable_staff($1, $2) r`, [A, JED])];
    return r.every(x => { const ids = x.rows.map(y => y.user_id); return ids.includes(U.admin) && ids.includes(U.acc) && ids.includes(U.jed) && !ids.includes(U.dmm); }) || J(r);
  });
  await check('list_assignable_staff: a branch-scoped writer without p_branch gets the org-wide members only; a deactivated branch\'s members are left out', async () => {
    const a = (await rpc('jed', `SELECT public.list_assignable_staff($1) r`, [A])).rows.map(x => x.user_id);
    await q(`UPDATE public.branches SET is_active = false WHERE id = $1`, [DMM]);
    const b = (await rpc('admin', `SELECT public.list_assignable_staff($1) r`, [A])).rows.map(x => x.user_id);
    await q(`UPDATE public.branches SET is_active = true WHERE id = $1`, [DMM]);
    return (a.includes(U.admin) && a.includes(U.acc) && !a.includes(U.jed) && !a.includes(U.dmm) && b.includes(U.jed) && !b.includes(U.dmm)) || J({ a, b });
  });
  await check('list_assignable_staff gates: org B admin / portal → MRS_FORBIDDEN org; another org\'s branch → MRS_INVALID branch_id; accountant → MRS_FORBIDDEN role; JED writer for DMM → MRS_FORBIDDEN branch; anon perm', async () => {
    const r = [await code(() => rpc('staffB', `SELECT public.list_assignable_staff($1) r`, [A])),
      await code(() => rpc('portal', `SELECT public.list_assignable_staff($1) r`, [A])),
      await code(() => rpc('admin', `SELECT public.list_assignable_staff($1, $2) r`, [A, BR_B])),
      await code(() => rpc('acc', `SELECT public.list_assignable_staff($1) r`, [A])),
      await code(() => rpc('acc', `SELECT public.list_assignable_staff($1, $2) r`, [A, JED])),
      await code(() => rpc('jed', `SELECT public.list_assignable_staff($1, $2) r`, [A, DMM])),
      await code(() => as('anon', `SELECT public.list_assignable_staff($1)`, [A]))];
    return J(r) === J(['MRS_FORBIDDEN org', 'MRS_FORBIDDEN org', 'MRS_INVALID branch_id', 'MRS_FORBIDDEN role', 'MRS_FORBIDDEN role',
      'MRS_FORBIDDEN branch', 'perm']) || J(r);
  });
}

async function secContainers() {
  section('6. container seal no. / size-type at creation');
  await check('a container inserted with seal + size-type (the new-transaction form) is normalised (upper case, no spaces)', async () => {
    const t = await newTx('jed');
    const c = (await as('jed', `INSERT INTO public.containers (org_id, transaction_id, container_no, seal_no, size_type) VALUES ($1, $2, $3, 'sl 12 34', '40hc') RETURNING seal_no, size_type`, [A, t, iso('GAPU', '123456')]))[0];
    return (c.seal_no === 'SL1234' && c.size_type === '40HC') || J(c);
  });
  await check('an over-long seal (31) / size-type (11) is refused by the same checks as the detail edit', async () => {
    const t = await newTx('jed');
    const r = [await code(() => as('jed', `INSERT INTO public.containers (org_id, transaction_id, container_no, seal_no) VALUES ($1, $2, $3, $4)`, [A, t, iso('GAPU', '123457'), 'S'.repeat(31)])),
      await code(() => as('jed', `INSERT INTO public.containers (org_id, transaction_id, container_no, size_type) VALUES ($1, $2, $3, $4)`, [A, t, iso('GAPU', '123457'), 'X'.repeat(11)]))];
    return J(r) === J(['chk:containers_seal_chk', 'chk:containers_size_type_chk']) || J(r);
  });
}

async function secCustody() {
  section('7. custody_balances: client code, search by code, org totals');
  const save = p => rpc('acc', `SELECT public.save_custody_entry($1, $2) r`, [Object.assign({ branch_id: JED, entry_date: '2026-01-15' }, p), null]);
  await save({ client_id: CLIENT_A, kind: 'deposit', amount: 100 });
  await save({ client_id: CLIENT_A2, kind: 'deposit', amount: 50 });
  await save({ client_id: CLIENT_A, kind: 'refund', amount: 30 });
  const bal = (who, f) => rpc(who, `SELECT public.custody_balances($1, $2) r`, [A, f || {}]);
  await check('rows carry client_code; org totals deposits 150 / deductions 0 / refunds 30 / balance 120 / 2 clients', async () => {
    const r = await bal('acc');
    const a = r.rows.find(x => x.client_id === CLIENT_A), b = r.rows.find(x => x.client_id === CLIENT_A2);
    return (a.client_code === 'GAP-001' && b.client_code === 'GAP-002' && +a.balance === 70 && +r.total_deposits === 150 && +r.total_deductions === 0
      && +r.total_refunds === 30 && +r.total_balance === 120 && r.client_count === 2) || J(r);
  });
  await check('q = a code prefix (any case / punctuation) → that client only, totals follow; q by name still works', async () => {
    const r = await bal('acc', { q: 'gap-001' });
    const r2 = await bal('acc', { q: 'gap002' });
    const n = await bal('acc', { q: 'التجربة' });
    return (r.rows.length === 1 && r.rows[0].client_id === CLIENT_A && +r.total_deposits === 100 && r.client_count === 1
      && r2.rows.length === 1 && r2.rows[0].client_id === CLIENT_A2 && n.rows.length === 1 && n.rows[0].client_id === CLIENT_A2) || J({ r, r2, n });
  });
  await check('gates: clearance staff → MRS_FORBIDDEN finance; org B admin → MRS_FORBIDDEN org; unknown filter key refused', async () => {
    const r = [await code(() => bal('jed')), await code(() => bal('staffB')), await code(() => bal('acc', { code: 'x' }))];
    return J(r) === J(['MRS_FORBIDDEN finance', 'MRS_FORBIDDEN org', 'MRS_INVALID unknown_key']) || J(r);
  });
}

async function secTrips() {
  section('8. report_trips: party type unset, row fields, transport value');
  await q(`UPDATE public.transactions SET transport_mode = 'carrier_order', transport_order_no = 'TASTO900001', transport_order_date = '2026-01-10' WHERE id = $1`, [TX_JED]);
  const drv = (await one(`INSERT INTO public.drivers (org_id, full_name, phone) VALUES ($1, 'سائق تجريبي', '0551230000') RETURNING id`, [A])).id;
  const ins = (pt, cost, order) => one(`INSERT INTO public.transport_trips (org_id, transaction_id, driver_id, party_type, party_name, transport_order_no, cost_amount, planned_at, origin)
                                        VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-12 08:00+03', 'GAPS') RETURNING id`, [A, TX_JED, drv, pt, pt ? 'مورد نقل تجريبي' : null, order, cost]).then(r => r.id);
  const t1 = await ins('supplier', 500, 'TO-1'), t2 = await ins(null, 200, null);
  const rep = (who, f) => rpc(who, `SELECT public.report_trips($1, $2) r`, [A, Object.assign({ driver_id: drv }, f || {})]);
  await check('rows: client name, party type, the trip / TASTO order, driver mobile, declaration no., client id', async () => {
    const r = await rep('admin');
    const x = r.items.find(i => i.id === t1);
    return (r.total === 2 && x.client_name === 'شركة الاختبار الأولى للتجارة' && x.party_type === 'supplier' && x.transport_order_no === 'TO-1'
      && x.tx_transport_order_no === 'TASTO900001' && x.tx_transport_order_date === '2026-01-10' && x.driver_phone === '0551230000'
      && x.declaration_no === 'TEST-DEC-0001' && x.client_id === CLIENT_A) || J(r.items);
  });
  await check("party_type 'unset' → only the trip without a party type; ['unset','supplier'] → both; a bad code → MRS_INVALID party_type", async () => {
    const u = await rep('admin', { party_type: 'unset' });
    const both = await rep('admin', { party_type: ['unset', 'supplier'] });
    const s = await rep('admin', { party_type: 'supplier' });
    const bad = await code(() => rep('admin', { party_type: ['unset', 'bogus'] }));
    return (u.total === 1 && u.items[0].id === t2 && both.total === 2 && s.total === 1 && s.items[0].id === t1 && bad === 'MRS_INVALID party_type') || J({ u: u.total, both: both.total, s: s.total, bad });
  });
  await check("a trip with a carrier but no party type is 'company' everywhere: row, filter, by_carrier (not 'unset')", async () => {
    const car = (await one(`INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier'], 'ناقل تجريبي') RETURNING id`, [A])).id;
    const t3 = (await one(`INSERT INTO public.transport_trips (org_id, transaction_id, driver_id, carrier_id, planned_at, origin)
                            VALUES ($1, $2, $3, $4, '2026-01-12 09:00+03', 'GAPS') RETURNING id`, [A, TX_JED, drv, car])).id;
    const all = await rep('admin'), u = await rep('admin', { party_type: 'unset' }), c = await rep('admin', { party_type: 'company' });
    const row = all.items.find(i => i.id === t3), g = all.totals.by_carrier.find(x => x.carrier_id === car);
    const ok = row && row.party_type === 'company' && u.total === 1 && u.items[0].id === t2 && c.items.some(i => i.id === t3)
      && g && g.party_type === 'company';
    return ok || J({ row, u: u.items.map(i => i.id), c: c.items.map(i => i.id), g });
  });
  await check('totals.transport_value = Σ cost by currency with finance (= finance.cost_by_currency); {} without finance', async () => {
    const f = await rep('admin', { include_finance: true });
    const n = await rep('admin');
    return (J(f.totals.transport_value) === J({ SAR: 700 }) && J(f.totals.transport_value) === J(f.totals.finance.cost_by_currency)
      && J(n.totals.transport_value) === '{}' && n.items.every(i => i.cost_amount === null)) || J({ f: f.totals, n: n.totals });
  });
  await check('gates: clearance staff may not include finance (MRS_FORBIDDEN cost); org B admin → refused', async () => {
    const r = [await code(() => rep('jed', { include_finance: true })), await code(() => rep('staffB'))];
    return (r[0] === 'MRS_FORBIDDEN cost' && /^MRS_FORBIDDEN/.test(r[1])) || J(r);
  });
}

async function secTxStatement() {
  section('9. report_transactions: totals.by_daftra_state');
  await check('finance reader → object {state: count} over none / draft / issued / cancelled_review, summing to totals.count; others → null', async () => {
    const a = await rpc('admin', `SELECT public.report_transactions($1, '{}') r`, [A]);
    const j = await rpc('jed', `SELECT public.report_transactions($1, '{}') r`, [A]);
    const d = a.totals.by_daftra_state;
    const keysOk = Object.keys(d).every(k => ['none', 'draft', 'issued', 'cancelled_review'].includes(k));
    const sum = Object.values(d).reduce((s, v) => s + v, 0);
    return (d && typeof d === 'object' && keysOk && sum === a.totals.count && j.totals.by_daftra_state === null) || J({ d, count: a.totals.count, j: j.totals.by_daftra_state });
  });
}

function secSupa() {
  section('10. assets/js/supa.js wrappers');
  const s = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  const body = name => { const i = s.indexOf('function ' + name + '('); return i < 0 ? '' : s.slice(i, s.indexOf('\n  }\n', i) + 4); };
  return Promise.all([
    check('setClientLegacyFields → set_client_legacy_fields (p_client, p_payload) with the two keys only; exported', () =>
      (/rpc\('set_client_legacy_fields', \{ p_client: clientId, p_payload: p \}\)/.test(body('setClientLegacyFields'))
        && /\['port_category', 'daftra_client_code'\]/.test(body('setClientLegacyFields')) && /setClientLegacyFields: setClientLegacyFields/.test(s)) || 'missing'),
    check('listAssignableStaff → list_assignable_staff (p_org, p_branch) with the memberships fallback when the RPC is missing; exported', () =>
      (/rpc\('list_assignable_staff', \{ p_org: oid, p_branch: o\.branchId \|\| null \}\)/.test(body('listAssignableStaff'))
        && /rpcMissing\(r\.error\)/.test(body('listAssignableStaff')) && /listAssignableStaff: listAssignableStaff/.test(s)) || 'missing'),
    check('setTransactionResponsible → updateTransaction({responsible_user_id}); exported', () =>
      (/updateTransaction\(txId, \{ responsible_user_id: userId \|\| null \}\)/.test(body('setTransactionResponsible'))
        && /setTransactionResponsible: setTransactionResponsible/.test(s)) || 'missing'),
    check('the new error details have Arabic (supa.js map) and English (cdetail_) texts', () =>
      ['MRS_INVALID:daftra_client_code', 'MRS_INVALID:daftra_client_code_taken', 'MRS_INVALID:port_category', 'MRS_INVALID:responsible_user_id',
        'MRS_FORBIDDEN:client_edit', 'MRS_NOT_FOUND:client'].every(k => s.includes("'" + k + "'") && s.includes("'cdetail_" + k.replace(':', '_') + "'")) || 'missing'),
    check('the new supa.js code is ES5 (no arrow functions / let / const / template strings)', () => {
      const src = ['setClientLegacyFields', 'listAssignableStaff', 'setTransactionResponsible'].map(body).join('\n');
      return (src.length > 200 && !/=>|\blet\s|\bconst\s|`/.test(src)) || 'not ES5';
    })
  ]);
}

async function main() {
  await secFile();
  section('load shim + migrations + seed + fixtures');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  pass('database ready');
  await secRerun();
  await secClientFields();
  await secMatch();
  await secResponsible();
  await secContainers();
  await secCustody();
  await secTrips();
  await secTxStatement();
  await secSupa();
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
}
main().catch(e => { console.error(e); process.exit(1); });
