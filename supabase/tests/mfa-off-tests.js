#!/usr/bin/env node
/*
  Marsa (مرسى) — two-step verification no longer required: migration 20261129000100_mfa_off.sql (owner's decision 2026-11-15).
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).
  Invented data only.

  The other suites hold this file back (they keep testing their own migration under the MFA spec of 20261109000100);
  this suite loads EVERY migration and proves the combined state:
    file conventions + all_migrations.sql (verbatim, header, contents line); preflight (exact message, nothing changed);
    re-run → identical function hashes + ACLs, one schema_versions row; mfa_gated_roles = {}; an org admin at aal1:
    my_context().mfa required false / mfa_pending false / no mfa_locked row, has_role admin, app.fail never turns into
    MRS_MFA_REQUIRED, ai_get_settings works; a platform admin at aal1 = is_platform_admin; li_gate at aal1 passes for the
    owner and still refuses a non-owner (owner_only) and anon; privileges of the 4 re-created functions unchanged.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/mfa-off-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261129000100_mfa_off.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const PREV = '20261128000100_return_extension.sql';

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in mfa-off-tests'); };

const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const JED = '0b5e0000-0000-4000-8000-000000000011';
const U = {
  admin: 'd7c10000-0000-4000-8000-000000000001',   // org-wide admin of A (the owner)
  bm: 'd7c10000-0000-4000-8000-000000000002',      // branch_manager of A, JED (not the owner)
  clr: 'd7c10000-0000-4000-8000-000000000003',     // clearance_staff, JED
  plat: 'd7c10000-0000-4000-8000-000000000004'     // platform admin, no membership
};

let db;
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const J = x => JSON.stringify(x);
async function check(name, fn) {
  try {
    const r = await fn();
    if (typeof r === 'string') fail(name, r);
    else if (r === false || r === null || r === 0 || r === undefined) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + errText(e)); }
}
async function tryErr(fn) { try { await fn(); return 'ok'; } catch (e) { return (e.message || '') + (e.detail ? ' ' + e.detail : ''); } }
const claims = (who, aal) => J(who === 'anon' ? { role: 'anon' } : { sub: U[who], role: 'authenticated', aal });
// as PostgREST: role authenticated / anon + the claims
async function as(who, aal, sql, params) {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [claims(who, aal)]);
  await db.exec(who === 'anon' ? 'SET ROLE anon' : 'SET ROLE authenticated');
  try { return await q(sql, params); } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
// app.* helpers (not granted to authenticated) evaluated as the owner role with the caller's claims
async function asClaims(who, aal, sql, params) {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [claims(who, aal)]);
  try { return await q(sql, params); } finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false);`); }
}
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
const src = fs.readFileSync(MIG_FILE, 'utf8');
const RECREATED = ['app.mfa_gated_roles()', 'app.mfa_required_for(uuid)', 'app.is_platform_admin()', 'app.li_gate(uuid)'];
const fnState = async () => J(await q(`SELECT p.oid::regprocedure::text s, md5(p.prosrc || coalesce(array_to_string(p.proconfig, ','), '') || p.prosecdef::text) h,
                                              coalesce(p.proacl::text, '') a
                                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`));

async function secFiles() {
  section('1. file conventions, all_migrations.sql');
  const LATER_PHASES = ['20261130000100_tx_container_count.sql', '20261201000100_legacy_gaps.sql', '20261202000100_org_logo.sql', '20261203000100_draft_client_hidden.sql', '20261204000100_tx_stage_sets.sql', '20261205000100_service_item_price.sql', '20261206000100_storage_gate.sql', '20261207000100_driver_classes.sql', '20261208000100_ai_providers.sql', '20261209000100_ai_keys.sql', '20261210000100_org_served_ports.sql'];
  await check('this file is the latest migration (later phases excepted)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('no BEGIN / COMMIT, a schema_versions row, every function pins search_path', () => {
    const fns = src.match(/CREATE OR REPLACE FUNCTION/g) || [];
    const pinned = src.match(/SET search_path = ''/g) || [];
    return (!/^\s*(BEGIN|COMMIT)\s*;/mi.test(src) && src.includes("VALUES ('20261129000100', 'mfa_off')") && fns.length === 4
      && pinned.length === 4) || J({ fns: fns.length, pinned: pinned.length });
  });
  await check('all_migrations.sql holds this file verbatim (appended last, in order) + a header line + the contents note', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const nx = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, nx < 0 ? undefined : nx);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 26000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
}

async function secPreflight() {
  section('2. preflight');
  const main = db;
  db = new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
    for (const f of migFiles().filter(f => f < PREV)) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    const before = await fnState();
    const msg = await tryErr(() => db.exec(src));
    await check('without return_extension: exact preflight message', () =>
      msg.startsWith('MFA OFF preflight: apply return_extension first (schema_versions lacks 20261128000100)') || 'got: ' + msg);
    await check('without return_extension: nothing changed (functions, no schema_versions row)', async () => {
      const r = await one(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261129000100'`);
      return (r.n === 0 && before === await fnState()) || J(r);
    });
  } finally { await db.close(); db = main; }
}

async function secRerun() {
  section('3. re-run on the full DB');
  const h1 = await fnState();
  let ok = true;
  for (let i = 0; i < 2; i++) ok = (await tryErr(() => db.exec(src))) === 'ok' && ok;
  await check('re-applied twice: applies, identical function hashes + ACLs, one schema_versions row', async () => {
    const n = (await one(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261129000100'`)).n;
    return (ok && n === 1 && h1 === await fnState()) || J({ ok, n });
  });
  await check('health_check reports the latest migration (20261129000100 or a later phase) (anon)', async () =>
    (await as('anon', null, `SELECT public.health_check() r`))[0].r.schema_version === migFiles().slice(-1)[0].split('_')[0]);
}

async function secPolicy() {
  section('4. no role needs aal2');
  await check('app.mfa_gated_roles() = {}', async () => J((await one(`SELECT app.mfa_gated_roles() r`)).r) === '[]');
  await check('org admin at aal1: my_context().mfa required false, mfa_pending false, no mfa_locked row', async () => {
    const c = (await as('admin', 'aal1', `SELECT public.my_context() r`))[0].r;
    const locked = (c.memberships || []).filter(m => m.mfa_locked);
    return (c.mfa && c.mfa.required === false && c.mfa_pending !== true && locked.length === 0) || J({ mfa: c.mfa, p: c.mfa_pending, locked });
  });
  await check('org admin / branch manager at aal1: has_role true; app.mfa_pending() false', async () => {
    const a = (await asClaims('admin', 'aal1', `SELECT app.has_role($1, ARRAY['admin']) h, app.mfa_pending() p`, [A]))[0];
    const b = (await asClaims('bm', 'aal1', `SELECT app.has_branch_role($1, $2, ARRAY['branch_manager']) h, app.mfa_pending() p`, [A, JED]))[0];
    return (a.h === true && a.p === false && b.h === true && b.p === false) || J({ a, b });
  });
  await check('app.fail(MRS_FORBIDDEN) for an admin at aal1 stays MRS_FORBIDDEN (never MRS_MFA_REQUIRED)', async () => {
    const m = await tryErr(() => asClaims('admin', 'aal1', `SELECT app.fail('MRS_FORBIDDEN')`));
    return m.startsWith('MRS_FORBIDDEN') || m;
  });
  await check('ai_get_settings: org admin at aal1 → ok; clearance staff → MRS_FORBIDDEN', async () => {
    const a = await tryErr(() => as('admin', 'aal1', `SELECT public.ai_get_settings($1) r`, [A]));
    const c = await tryErr(() => as('clr', 'aal1', `SELECT public.ai_get_settings($1) r`, [A]));
    return (a === 'ok' && c.startsWith('MRS_FORBIDDEN')) || J({ a, c });
  });
  await check('platform admin at aal1: is_platform_admin() true; mfa_required_for false', async () => {
    const r = (await asClaims('plat', 'aal1', `SELECT app.is_platform_admin() p, app.mfa_required_for($1) m`, [U.plat]))[0];
    return (r.p === true && r.m === false) || J(r);
  });
  await check('li_gate at aal1: the owner passes; branch manager → MRS_FORBIDDEN owner_only; no uid → MRS_AUTH_REQUIRED', async () => {
    const o = await tryErr(() => asClaims('admin', 'aal1', `SELECT app.li_gate($1)`, [A]));
    const b = await tryErr(() => asClaims('bm', 'aal1', `SELECT app.li_gate($1)`, [A]));
    const n = await tryErr(() => q(`SELECT app.li_gate($1)`, [A]));
    return (o === 'ok' && b.startsWith('MRS_FORBIDDEN owner_only') && n.startsWith('MRS_AUTH_REQUIRED')) || J({ o, b, n });
  });
}

async function secPriv() {
  section('5. privileges of the re-created functions');
  await check('anon executes none; authenticated only mfa_gated_roles', async () => {
    const r = await q(`SELECT p.oid::regprocedure::text s, has_function_privilege('anon', p.oid, 'EXECUTE') an,
                              has_function_privilege('authenticated', p.oid, 'EXECUTE') au
                         FROM pg_proc p WHERE p.oid::regprocedure::text = ANY ($1) ORDER BY 1`, [RECREATED]);
    const bad = r.filter(x => x.an || (x.au !== (x.s === 'app.mfa_gated_roles()')));
    return (r.length === 4 && bad.length === 0) || J(r);
  });
}

async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k}@mfaoff.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.profiles (id, full_name) SELECT u.id, split_part(u.email, '@', 1) FROM auth.users u WHERE u.email LIKE '%@mfaoff.example.com'
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.plat}', 'mfa-off test operator');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.admin}', '${A}', NULL, 'admin'), ('${U.bm}', '${A}', '${JED}', 'branch_manager'), ('${U.clr}', '${A}', '${JED}', 'clearance_staff');
  `);
}

async function main() {
  db = new PGlite();
  section('load shim + every migration + seed');
  try {
    await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
    for (const f of migFiles()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
    await fixtures();
    pass('loaded: shim, ' + migFiles().length + ' migrations, seed, fixtures');
  } catch (e) { fail('load', errText(e)); return finish(); }
  for (const s of [secFiles, secPreflight, secRerun, secPolicy, secPriv]) {
    try { await s(); } catch (e) { fail(s.name, errText(e)); }
  }
  finish();
}
function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}
main();
