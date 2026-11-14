#!/usr/bin/env node
/*
  Marsa (مرسى) — deployment environment: migration 20261112000100_deploy_env.sql + supabase/production/post_install_checks.sql
  (supabase/production/README.md). LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at
  Supabase. No network.

  Two databases:
    STG  shim → every migration → seed.sql → fixtures          (the staging project: nothing may change there)
    PRD  shim → every migration (NO seed) → a platform admin   (a new production project, switched in section 5)
  The SQL Editor is the superuser with no JWT claims; API roles run as anon / authenticated / service_role.

  Covers: file conventions + all_migrations.sql; preflight + re-run (a switched row survives); catalog delta (exactly the
  new helpers, exactly 3 re-created bodies with their ACL, no public table); staging unchanged (health_check, new orgs,
  public results, a forced environment on a direct insert); set_deploy_environment rules (privileges, SQL Editor only,
  one-way, refused with a demo org / a staging org, also by a direct UPDATE; no DELETE / TRUNCATE of the row); after the
  switch new orgs + public results report production, seed.sql is refused and no org can be made a demo org;
  post_install_checks.sql read-only, expected keys, blockers (pg_cron + its 3 jobs, an older body re-pasted), cron jobs
  without their command; the install file of scripts/build-production-sql.py (empty-DB preflight, switch, checks that
  roll the whole install back).

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/prod-env-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const MIG = '20261112000100_deploy_env.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const CHECKS_FILE = path.join(SUPA, 'production', 'post_install_checks.sql');
const CRON_JOBS = ['marsa_idem_purge', 'marsa_client_errors_purge', 'marsa_refresh_alerts'];
const CRON_BLOCKERS = ['pg_cron_missing'].concat(CRON_JOBS.map(j => 'cron_job_missing:' + j));

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

// No network anywhere
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in prod-env-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const SEED_TOKEN = 'deadbeef'.repeat(8);                     // seed.sql public request (known TEST token)
const U = {
  plat: 'a7e00000-0000-4000-8000-000000000001', adminA: 'a7e00000-0000-4000-8000-000000000002',
  platP: 'a7e00000-0000-4000-8000-000000000003'              // PRD platform admin
};

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else if (who === 'service') {
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
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const one = async (sql, params) => (await q(sql, params))[0];
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
async function runFile(dbx, file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await dbx.exec(sql); if (!QUIET) console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @line ' + sql.slice(0, +e.position).split('\n').length : '')); return false; }
}
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
// phases added after this file (each has its own suite); schema_version then reports the latest of them
const LATER_PHASES = ['20261113000100_public_antispam.sql', '20261114000100_ai_documents.sql', '20261115000100_convert_in_place.sql',
  '20261116000100_doc_match.sql', '20261117000100_legacy_core.sql', '20261118000100_legacy_tx.sql', '20261119000100_legacy_docs.sql', '20261120000100_legacy_decl.sql', '20261121000100_legacy_appt.sql', '20261122000100_legacy_pay.sql', '20261123000100_legacy_daftra.sql', '20261124000100_legacy_reports.sql', '20261125000100_legacy_import.sql', '20261126000100_doc_match_packing.sql', '20261127000100_tx_draft_approval.sql', '20261128000100_return_extension.sql'];
const LATEST = migFiles().pop().slice(0, 14);
async function freshDb(upTo) {
  const d = new PGlite();
  await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles().filter(f => !upTo || f < upTo)) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  return d;
}
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
const env = async () => (await one(`SELECT environment e FROM app.deploy_settings`)).e;
const setEnv = v => one(`SELECT public.set_deploy_environment($1) r`, [v]).then(x => x.r);

let orgSeq = 0;
const orgPayload = o => {
  orgSeq++;
  return Object.assign({ slug: 'env-org-' + orgSeq, name_ar: 'مؤسسة اختبار البيئة ' + orgSeq, name_en: 'Env test ' + orgSeq,
    ref_prefix: 'ENV', default_locale: 'ar', branch: { code: 'ruh', name_ar: 'فرع الرياض', city: 'الرياض' },
    admin_email: 'owner' + orgSeq + '@env.example.com', idempotencyKey: crypto.randomUUID() }, o || {});
};
const createOrg = (who, o) => rpc(who, `SELECT public.platform_create_org($1) r`, [orgPayload(o)]);
let phoneSeq = 0;
const reqPayload = o => Object.assign({
  fullName: 'زائر تجريبي', company: 'شركة زائر تجريبية', phone: '0558' + String(100000 + (phoneSeq++)).slice(-6),
  email: 'visitor@example.com', clientType: 'business', crNumber: '7000000011', direction: 'import', service: 'clearance',
  mode: 'sea', country: 'الصين', port: 'ميناء جدة الإسلامي', goods: 'بضاعة اختبار', containerType: '40ft',
  containerNumbers: 'TSTU0000031', count: 1, blNumber: 'TESTBL0031', terms: true }, o || {});
const runChecksInTx = async () => (await q(fs.readFileSync(CHECKS_FILE, 'utf8')))[0].checks;
const runChecks = async () => {
  await db.exec('BEGIN READ ONLY');
  try { return (await q(fs.readFileSync(CHECKS_FILE, 'utf8')))[0].checks; }
  finally { await db.exec('ROLLBACK'); }
};
// catalog fingerprint: functions (body, ACL, definer, config), public tables, columns, triggers
async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind = 'r' ORDER BY 1`)).map(x => x.t);
  const cols = (await q(`SELECT table_schema || '.' || table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, '') c
                           FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`)).map(x => x.c);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname || ':' || t.tgfoid::regproc::text x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                          WHERE NOT t.tgisinternal ORDER BY 1`)).map(x => x.x);
  const cons = (await q(`SELECT conname || ':' || pg_get_constraintdef(oid) x FROM pg_constraint WHERE conrelid = 'public.organizations'::regclass ORDER BY 1`)).map(x => x.x);
  return { fns, tables, cols, trg, cons };
}

/* ------------------------------------------------------------------ fixtures (superuser) */
async function fixtures() {
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ('${U.plat}', 'plat@env.example.com', now()), ('${U.adminA}', 'admina@env.example.com', now());
    INSERT INTO public.profiles (id, full_name) VALUES ('${U.plat}', 'plat'), ('${U.adminA}', 'admina') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.plat}', 'test operator');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ('${U.adminA}', '${A}', NULL, 'admin');
  `);
}
async function prdFixtures() {
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ('${U.platP}', 'operator@env.example.com', now());
    INSERT INTO public.profiles (id, full_name) VALUES ('${U.platP}', 'operator') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.platP}', 'production operator');
  `);
}

const NEW_FNS = ['app.deploy_environment()', 'app.is_demo_org(o organizations)', 'app.tg_deploy_settings_guard()',
  'app.tg_org_environment()', 'public.set_deploy_environment(p_env text)'];
const RECREATED = ['public.health_check()', 'public.platform_create_org(p_payload jsonb)', 'public.public_track(p_ref text, p_token text)'];

/* ================================================================== sections */
async function secFile() {
  section('1. file: conventions, all_migrations.sql, no hard-coded staging left');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261111000100, schema_versions row, search_path = \'\' on every function', () => {
    const fnHeads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = fnHeads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261111000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261112000100', 'deploy_env'\)/.test(src)
      && fnHeads.length === 8 && bad.length === 0) || J({ n: fnHeads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  // later phases may follow this file (20261113000100 public_antispam); none may sort before it unnoticed
  await check('this file is present; only the listed later phases follow it', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (appended like the earlier phases; later phases follow it) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    return (i > 0 && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 3000).includes(MIG)) || 'not appended verbatim / no header line';
  });
  await check('no function body of the live catalog still hard-codes the \'staging\' environment (only the deploy helpers)', async () => {
    const r = await q(`SELECT n.nspname || '.' || p.proname s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname IN ('app','public') AND p.prosrc ~ '''staging''' ORDER BY 1`);
    // + the in-place conversion (20261115000100): removes the 'staging' key from organizations.settings
    const ok = ['app.deploy_environment', 'app.tg_deploy_settings_guard', 'public.convert_org_to_production', 'public.platform_create_org',
      'public.set_deploy_environment'];
    const bad = r.map(x => x.s).filter(s => !ok.includes(s));
    return bad.length === 0 || 'still literal: ' + bad.join(', ');
  });
}

async function secPreflight() {
  section('2. preflight, re-run, catalog delta (separate databases, no seed)');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const d = await freshDb(MIG);
  try {
    await withDb(d, async () => {
      const C0 = await catalog();
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261111000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without G5b: exact preflight message', () => msg.startsWith('ENV preflight: apply G5b first (schema_versions lacks 20261111000100 g5b_daftra_live)') || 'got: ' + msg);
      await check('without G5b: nothing created (catalog identical, no schema_versions row, no app.deploy_settings)', async () =>
        (J(C0) === J(await catalog()) && (await one(`SELECT to_regclass('app.deploy_settings') r`)).r === null
          && (await one(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261112000100'`)).n === 0) || 'catalog changed');
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261111000100', 'g5b_daftra_live')`);
      const r1 = await tryErr(() => db.exec(src));
      const C1 = await catalog();
      const r2 = await tryErr(() => db.exec(src));
      await check('applies, and re-runs on top of itself with an identical catalog', async () =>
        (r1 === 'ok' && r2 === 'ok' && J(C1) === J(await catalog())) || J({ r1, r2 }));
      await check('a fresh install starts as staging (one row)', async () =>
        (await env()) === 'staging' && (await one(`SELECT count(*)::int n FROM app.deploy_settings`)).n === 1);

      const m0 = new Map(C0.fns.map(f => [f.sig, f]));
      const m1 = new Map(C1.fns.map(f => [f.sig, f]));
      await check('exactly the 5 new functions were added (4 app helpers / triggers + public.set_deploy_environment)', () => {
        const added = C1.fns.filter(f => !m0.has(f.sig)).map(f => f.sig).sort();
        const removed = C0.fns.filter(f => !m1.has(f.sig)).map(f => f.sig);
        return (J(added) === J(NEW_FNS.slice().sort()) && removed.length === 0) || J({ added, removed });
      });
      await check('exactly health_check / platform_create_org / public_track re-created, with their exact ACL, definer, config', () => {
        const changed = C0.fns.filter(f => m1.get(f.sig) && J(m1.get(f.sig)) !== J(f)).map(f => f.sig).sort();
        const acl = RECREATED.filter(s => m0.get(s).acl !== m1.get(s).acl || m0.get(s).d !== m1.get(s).d || m0.get(s).c !== m1.get(s).c);
        return (J(changed) === J(RECREATED.slice().sort()) && acl.length === 0) || J({ changed, acl });
      });
      await check('no public table / column / organizations constraint changed; +app.deploy_settings; +3 triggers only', () => {
        const dl = (a, b) => ({ add: b.filter(x => !a.includes(x)), del: a.filter(x => !b.includes(x)) });
        const t = dl(C0.tables, C1.tables), c = dl(C0.cols, C1.cols), tr = dl(C0.trg, C1.trg), k = dl(C0.cons, C1.cons);
        return (J(t) === J({ add: ['app.deploy_settings'], del: [] }) && !c.add.length && !c.del.length && !k.add.length && !k.del.length
          && J(tr.add.sort()) === J(['deploy_settings.trg_deploy_settings_guard:app.tg_deploy_settings_guard',
            'deploy_settings.trg_deploy_settings_truncate:app.tg_deploy_settings_guard', 'organizations.trg_org_environment:app.tg_org_environment'])
          && !tr.del.length) || J({ t, c, tr, k });
      });
      await check('new functions: SECURITY DEFINER for deploy_environment / tg_org_environment / set_deploy_environment, search_path="" everywhere', () => {
        const want = { 'app.deploy_environment()': true, 'app.tg_org_environment()': true, 'public.set_deploy_environment(p_env text)': true,
          'app.is_demo_org(o organizations)': false, 'app.tg_deploy_settings_guard()': false };
        const bad = NEW_FNS.filter(s => m1.get(s).d !== want[s] || !/search_path=\\"\\"/.test(m1.get(s).c));         // proconfig::text = {"search_path=\"\""}
        return bad.length === 0 || bad.join(', ');
      });

      // a switched database stays production when the file is pasted again
      await check('re-run after the switch keeps production (ON CONFLICT DO NOTHING) and the switch time', async () => {
        const s = await setEnv('production');
        const r = await tryErr(() => db.exec(src));
        const row = await one(`SELECT environment, switched_at FROM app.deploy_settings`);
        return (s.changed === true && r === 'ok' && row.environment === 'production' && row.switched_at !== null) || J({ s, r, row });
      });
    });
  } finally { await d.close(); }
}

async function secStaging() {
  section('3. staging (default): behaviour unchanged');
  await check('app.deploy_settings = staging; health_check (anon) environment staging + schema_version = the latest file', async () => {
    const h = await rpc('anon', `SELECT public.health_check() r`);
    return ((await env()) === 'staging' && h.ok === true && h.environment === 'staging' && h.schema_version === LATEST
      && J(Object.keys(h).sort()) === J(['db_time', 'environment', 'ok', 'schema_version'])) || J(h);
  });
  await check('seed org blue-sea is staging', async () => (await one(`SELECT environment e FROM public.organizations WHERE id = $1`, [A])).e === 'staging');
  await check('platform_create_org: new org environment staging, settings {"staging": true}, same result keys', async () => {
    const r = await createOrg('plat');
    const o = await one(`SELECT environment, settings FROM public.organizations WHERE id = $1`, [r.org_id]);
    return (o.environment === 'staging' && J(o.settings) === J({ staging: true }) && /^[0-9a-f]{64}$/.test(r.token)
      && J(Object.keys(r).sort()) === J(['accept_path', 'branch_id', 'email', 'expires_at', 'invitation_id', 'org_id', 'slug', 'token', 'token_shown'])) || J({ o, r });
  });
  await check('platform_create_org: an "environment" key is still refused (MRS_INVALID unknown_key)', async () =>
    /MRS_INVALID.*unknown_key/.test(await tryErr(() => createOrg('plat', { environment: 'production' }))));
  await check('platform_list_orgs / my_context report staging', async () => {
    const l = await rpc('plat', `SELECT public.platform_list_orgs() r`);
    const c = await rpc('adminA', `SELECT public.my_context() r`);
    const list = Array.isArray(l) ? l : (l.orgs || l.organizations || []);
    return (list.length >= 2 && list.every(o => o.environment === 'staging') && c.organizations.every(o => o.environment === 'staging')) || J({ l, c });
  });
  await check('public: submit_service_request + public_track (seed token) report staging', async () => {
    const s = await rpc('anon', `SELECT public.submit_service_request($1) r`, [reqPayload()]);
    const t1 = await rpc('anon', `SELECT public.public_track($1, $2) r`, [s.ref, s.tracking_token]);
    const ref = (await one(`SELECT ref FROM public.service_requests WHERE id = '0b5e0000-0000-4000-8000-000000000401'`)).ref;
    const t2 = await rpc('anon', `SELECT public.public_track($1, $2) r`, [ref, SEED_TOKEN]);
    return (s.environment === 'staging' && t1.environment === 'staging' && t2.environment === 'staging' && t2.kind === 'request') || J({ s, t1, t2 });
  });
  await check('a direct SQL insert asking for production is forced to the deployment environment (staging)', async () => {
    const r = await one(`INSERT INTO public.organizations (slug, name_ar, environment) VALUES ('env-direct', 'مؤسسة مباشرة', 'production') RETURNING environment`);
    return r.environment === 'staging' || J(r);
  });
  await check('organizations.environment stays immutable (trg_guard) and its CHECK is unchanged', async () => {
    const m = await tryErr(() => as('adminA', `UPDATE public.organizations SET environment = 'production' WHERE id = $1`, [A]));
    const r = await one(`SELECT environment e FROM public.organizations WHERE id = $1`, [A]);
    const k = await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = 'public.organizations'::regclass AND conname = 'organizations_environment_check'`);
    return (r.e === 'staging' && m !== 'ok' && /'staging'.*'production'/.test(k.d)) || J({ m, r, k });
  });
}

async function secSwitchRules() {
  section('4. set_deploy_environment: privileges, SQL Editor only, refusals on staging');
  await check('no API role can execute set_deploy_environment / app.deploy_environment / app.is_demo_org (not even service_role)', async () => {
    const r = await q(`SELECT p.oid::regprocedure::text s, has_function_privilege('anon', p.oid, 'EXECUTE') a,
                              has_function_privilege('authenticated', p.oid, 'EXECUTE') u, has_function_privilege('service_role', p.oid, 'EXECUTE') sr,
                              p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) pub
                         FROM pg_proc p WHERE p.oid IN ('public.set_deploy_environment(text)'::regprocedure, 'app.deploy_environment()'::regprocedure,
                                                        'app.is_demo_org(public.organizations)'::regprocedure, 'app.tg_org_environment()'::regprocedure)`);
    return (r.length === 4 && r.every(x => !x.a && !x.u && !x.sr && !x.pub)) || J(r);
  });
  for (const who of ['anon', 'adminA', 'plat', 'service']) {
    await check(`${who}: set_deploy_environment('production') → permission denied, nothing changed`, async () => {
      const m = await tryErr(() => as(who, `SELECT public.set_deploy_environment('production')`));
      return (/permission denied/.test(m) && (await env()) === 'staging') || m;
    });
  }
  await check('API roles cannot read or write app.deploy_settings', async () => {
    const out = [];
    for (const who of ['anon', 'adminA', 'service']) {
      out.push(await tryErr(() => as(who, `SELECT environment FROM app.deploy_settings`)));
      out.push(await tryErr(() => as(who, `UPDATE app.deploy_settings SET environment = 'production'`)));
    }
    return (out.every(m => /permission denied/.test(m)) && (await env()) === 'staging') || J(out);
  });
  await check('superuser WITH request JWT claims (an API request path) → MRS_FORBIDDEN sql_editor_only', async () => {
    await db.exec(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    try { const m = await tryErr(() => setEnv('production')); return (/MRS_FORBIDDEN.*sql_editor_only/.test(m) && (await env()) === 'staging') || m; }
    finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false)`); }
  });
  await check('unknown value / NULL → MRS_INVALID environment', async () => {
    const a = await tryErr(() => setEnv('prod')), b = await tryErr(() => setEnv(null));
    return (/MRS_INVALID.*environment/.test(a) && /MRS_INVALID.*environment/.test(b)) || J({ a, b });
  });
  await check('staging → staging is a no-op (changed false)', async () => {
    const r = await setEnv(' Staging ');
    return (r.environment === 'staging' && r.changed === false && r.from === 'staging') || J(r);
  });
  await check('production refused while the seed org exists → MRS_FORBIDDEN demo_org_present; still staging', async () => {
    const m = await tryErr(() => setEnv('production'));
    return (/MRS_FORBIDDEN.*demo_org_present/.test(m) && (await env()) === 'staging'
      && (await rpc('anon', `SELECT public.health_check() r`)).environment === 'staging') || m;
  });
  await check('app.is_demo_org: slug blue-sea or settings.demo = true; not a normal org', async () => {
    const r = await q(`SELECT o.slug, app.is_demo_org(o) d FROM public.organizations o ORDER BY o.created_at`);
    const x = await one(`SELECT app.is_demo_org(ROW(gen_random_uuid(), 'other-demo', 'تجريبي', NULL, 'MRS', 'staging', true, 'ar', '{"demo": true}'::jsonb, true, now(), now())::public.organizations) d`);
    return (r.find(o => o.slug === 'blue-sea').d === true && r.filter(o => o.slug !== 'blue-sea').every(o => !o.d) && x.d === true) || J({ r, x });
  });
  await check('a direct UPDATE / DELETE of the row is guarded (DELETE → MRS_IMMUTABLE)', async () => {
    const m = await tryErr(() => db.exec(`DELETE FROM app.deploy_settings`));
    const n = (await one(`SELECT count(*)::int n FROM app.deploy_settings`)).n;
    const i = await tryErr(() => db.exec(`INSERT INTO app.deploy_settings (id, environment) VALUES (false, 'production')`));
    return (/MRS_IMMUTABLE/.test(m) && n === 1 && /check/i.test(i)) || J({ m, n, i });
  });
  await check('TRUNCATE of the row → MRS_IMMUTABLE (statement trigger); still one staging row', async () => {
    const m = await tryErr(() => db.exec(`TRUNCATE app.deploy_settings`));
    return (/MRS_IMMUTABLE.*deploy_settings/.test(m) && (await one(`SELECT count(*)::int n FROM app.deploy_settings`)).n === 1
      && (await env()) === 'staging') || m;
  });
  await check('a direct UPDATE staging → production gets the switch refusals (seed org → MRS_FORBIDDEN demo_org_present)', async () => {
    const m = await tryErr(() => db.exec(`UPDATE app.deploy_settings SET environment = 'production'`));
    return (/MRS_FORBIDDEN.*demo_org_present/.test(m) && (await env()) === 'staging') || m;
  });
  await check('staging: the seed org can still be updated (settings / slug trigger refuses demo orgs on production only)', async () => {
    await db.exec(`BEGIN`);
    try {
      const m = await tryErr(() => db.exec(`UPDATE public.organizations SET settings = settings || '{"demo": true}' WHERE id = '${A}'`));
      return m === 'ok' || m;
    } finally { await db.exec('ROLLBACK'); }
  });
}

async function secProduction() {
  section('5. production: a new project, switched once, one-way');
  const d = await freshDb();
  try {
    await withDb(d, async () => {
      await prdFixtures();
      await check('fresh production project: staging until switched (health_check staging)', async () =>
        (await rpc('anon', `SELECT public.health_check() r`)).environment === 'staging');
      // refusals inside a rolled-back transaction (nothing stays behind)
      await db.exec(`BEGIN; INSERT INTO public.organizations (slug, name_ar, settings) VALUES ('demo-two', 'مؤسسة عرض', '{"demo": true}')`);
      const m1 = await tryErr(() => setEnv('production'));
      await db.exec('ROLLBACK');
      await check('an org flagged {"demo": true} → MRS_FORBIDDEN demo_org_present', () => /MRS_FORBIDDEN.*demo_org_present/.test(m1) || m1);
      await db.exec('BEGIN');
      const o = await asRole('platP', () => q(`SELECT public.platform_create_org($1) r`, [orgPayload()]));
      const m2 = await tryErr(() => setEnv('production'));
      await db.exec('ROLLBACK');
      await check('an org created while still staging → MRS_FORBIDDEN staging_orgs_present', () => (o.length === 1 && /MRS_FORBIDDEN.*staging_orgs_present/.test(m2)) || m2);
      await db.exec('BEGIN');
      await asRole('platP', () => q(`SELECT public.platform_create_org($1) r`, [orgPayload()]));
      const m3 = await tryErr(() => db.exec(`UPDATE app.deploy_settings SET environment = 'production'`));
      await db.exec('ROLLBACK');
      await check('a direct UPDATE with an org created as staging → MRS_FORBIDDEN staging_orgs_present', () => /MRS_FORBIDDEN.*staging_orgs_present/.test(m3) || m3);
      await check('both refusals left nothing: no org, still staging', async () =>
        (await one(`SELECT count(*)::int n FROM public.organizations`)).n === 0 && (await env()) === 'staging');

      let sw;
      await check('SQL Editor: set_deploy_environment(\'production\') → changed, switched_at, switched_by = session user', async () => {
        sw = await setEnv('production');
        const row = await one(`SELECT environment, switched_at, switched_by FROM app.deploy_settings`);
        return (sw.environment === 'production' && sw.from === 'staging' && sw.changed === true && sw.switched_at
          && row.environment === 'production' && row.switched_by && row.switched_by.length > 0) || J({ sw, row });
      });
      await check('again → no-op (changed false, same switched_at)', async () => {
        const r = await setEnv('production');
        return (r.changed === false && r.switched_at === sw.switched_at) || J(r);
      });
      await check('production → staging refused (function: MRS_BAD_TRANSITION; direct UPDATE: MRS_BAD_TRANSITION)', async () => {
        const a = await tryErr(() => setEnv('staging'));
        const b = await tryErr(() => db.exec(`UPDATE app.deploy_settings SET environment = 'staging'`));
        return (/MRS_BAD_TRANSITION.*production_is_one_way/.test(a) && /MRS_BAD_TRANSITION.*production_is_one_way/.test(b) && (await env()) === 'production') || J({ a, b });
      });
      await check('TRUNCATE / DELETE after the switch → MRS_IMMUTABLE; health_check still production', async () => {
        const a = await tryErr(() => db.exec(`TRUNCATE app.deploy_settings`));
        const b = await tryErr(() => db.exec(`DELETE FROM app.deploy_settings`));
        return (/MRS_IMMUTABLE/.test(a) && /MRS_IMMUTABLE/.test(b) && (await env()) === 'production') || J({ a, b });
      });
      await check('health_check (anon) reports production', async () => (await rpc('anon', `SELECT public.health_check() r`)).environment === 'production');
      let org;
      await check('platform_create_org: new org environment production, settings {}', async () => {
        org = await createOrg('platP', { slug: 'real-org', ref_prefix: 'RLO' });
        const r = await one(`SELECT environment, settings FROM public.organizations WHERE id = $1`, [org.org_id]);
        return (r.environment === 'production' && J(r.settings) === J({})) || J(r);
      });
      await check('platform_list_orgs reports production', async () => {
        const l = await rpc('platP', `SELECT public.platform_list_orgs() r`);
        const list = Array.isArray(l) ? l : (l.orgs || l.organizations || []);
        return (list.length === 1 && list[0].environment === 'production') || J(l);
      });
      await check('public: submit_service_request (orgSlug) + public_track report production; without orgSlug intake is closed (no blue-sea)', async () => {
        const s = await rpc('anon', `SELECT public.submit_service_request($1) r`, [reqPayload({ orgSlug: 'real-org' })]);
        const t = await rpc('anon', `SELECT public.public_track($1, $2) r`, [s.ref, s.tracking_token]);
        const c = await tryErr(() => as('anon', `SELECT public.submit_service_request($1) r`, [reqPayload()]));
        return (s.environment === 'production' && t.environment === 'production' && t.kind === 'request' && /MRS_INTAKE_CLOSED/.test(c)) || J({ s, t, c });
      });
      await check('an existing org cannot become a demo org (settings.demo = true / slug blue-sea → demo_org_in_production)', async () => {
        const a = await tryErr(() => db.exec(`UPDATE public.organizations SET settings = settings || '{"demo": true}' WHERE slug = 'real-org'`));
        const b = await tryErr(() => db.exec(`UPDATE public.organizations SET slug = 'blue-sea' WHERE slug = 'real-org'`));
        const c = await tryErr(() => db.exec(`UPDATE public.organizations SET name_ar = 'مؤسسة حقيقية' WHERE slug = 'real-org'`));
        const r = await one(`SELECT slug, settings FROM public.organizations WHERE id = $1`, [org.org_id]);
        return (/MRS_FORBIDDEN.*demo_org_in_production/.test(a) && /MRS_FORBIDDEN.*demo_org_in_production/.test(b) && c === 'ok'
          && r.slug === 'real-org' && J(r.settings) === J({})) || J({ a, b, c, r });
      });
      await check('a direct insert asking for staging is forced to production', async () =>
        (await one(`INSERT INTO public.organizations (slug, name_ar, environment) VALUES ('direct-two', 'مؤسسة مباشرة', 'staging') RETURNING environment`)).environment === 'production');
      await check('seed.sql is refused in production (demo_org_in_production) and inserts nothing', async () => {
        const m = await tryErr(() => db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8')));
        const n = (await one(`SELECT count(*)::int n FROM public.organizations WHERE slug = 'blue-sea' OR id = $1`, [A])).n;
        return (/MRS_FORBIDDEN.*demo_org_in_production/.test(m) && n === 0) || J({ m, n });
      });

      section('6b. post_install_checks.sql on production');
      await check('blockers: the platform admin without TOTP + pg_cron (absent in PGlite); after a verified TOTP factor → pg_cron only', async () => {
        const c1 = await runChecks();
        await db.exec(`INSERT INTO auth.mfa_factors (user_id, friendly_name, factor_type, status) VALUES ('${U.platP}', 'phone', 'totp', 'verified')`);
        const c2 = await runChecks();
        return (J(c1.blockers) === J(['platform_admin_without_totp'].concat(CRON_BLOCKERS)) && c1.platform_admins[0].totp_verified === false
          && J(c2.blockers) === J(CRON_BLOCKERS) && c2.platform_admins[0].totp_verified === true && c2.platform_admins[0].email === 'o***@env.example.com'
          && c2.deploy_environment === 'production' && c2.demo_org_present === false && c2.seed_rows === 0
          && J(c2.orgs_by_environment) === J({ production: 2 })) || J({ c1: c1.blockers, c2 });
      });
      await check('with pg_cron present: cron_jobs lists jobid / jobname / schedule / active, never the command', async () => {
        await db.exec(`CREATE SCHEMA cron; CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text, command text, jobname text, active boolean DEFAULT true);
                       INSERT INTO cron.job (schedule, command, jobname) VALUES ('* * * * *', 'select net.http_post(''x'', headers := ''{"Authorization":"Bearer sb_secret_TESTONLY"}'')', 'msg-worker & <tick>'),
                                                                                ('*/5 * * * *', 'select 1', 'daftra-worker')`);
        const c = await runChecks();
        await db.exec(`DROP SCHEMA cron CASCADE`);
        const s = J(c);
        return (Array.isArray(c.cron_jobs) && c.cron_jobs.length === 2 && c.cron_jobs[0].jobname === 'msg-worker & <tick>'
          && J(Object.keys(c.cron_jobs[0]).sort()) === J(['active', 'jobid', 'jobname', 'schedule']) && !/sb_secret|http_post|command/.test(s)) || s;
      });
      await check('cron_job_missing:<name> for each marsa_* job absent or inactive; none when all three are active', async () => {
        await db.exec(`CREATE SCHEMA cron; CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text, command text, jobname text, active boolean DEFAULT true);
                       INSERT INTO cron.job (schedule, command, jobname, active) VALUES ('17 3 * * *', 'x', 'marsa_idem_purge', true), ('*/15 * * * *', 'x', 'marsa_refresh_alerts', false)`);
        const a = await runChecks();
        await db.exec(`UPDATE cron.job SET active = true; INSERT INTO cron.job (schedule, command, jobname) VALUES ('27 3 * * *', 'x', 'marsa_client_errors_purge')`);
        const b = await runChecks();
        await db.exec(`DROP SCHEMA cron CASCADE`);
        return (J(a.blockers) === J(['pg_cron_missing', 'cron_job_missing:marsa_client_errors_purge', 'cron_job_missing:marsa_refresh_alerts'])
          && J(b.blockers) === J(['pg_cron_missing'])) || J({ a: a.blockers, b: b.blockers });
      });
      await check('an older migration re-pasted over health_check (hard-coded staging) → env_body_reverted (rolled back)', async () => {
        const old = fs.readFileSync(path.join(MIG_DIR, migFiles().find(f => f.startsWith('20261102000300'))), 'utf8');
        const stmt = (old.match(/CREATE OR REPLACE FUNCTION public\.health_check\(\)[\s\S]*?\n\$\$;/) || [])[0];
        if (!stmt || !/'staging'/.test(stmt)) return 'old health_check body not found';
        await db.exec('BEGIN');
        try {
          await db.exec(stmt);
          const c = await runChecksInTx();
          return (c.deploy_environment === 'staging' && c.blockers.includes('env_body_reverted') && c.blockers.includes('deploy_environment_not_production')) || J(c.blockers);
        } finally { await db.exec('ROLLBACK'); }
      });
      await check('after the rollback: no env_body_reverted, health_check production again', async () => {
        const c = await runChecks();
        return (!c.blockers.includes('env_body_reverted') && c.deploy_environment === 'production') || J(c.blockers);
      });
    });
  } finally { await d.close(); }
}

const KEYS = ['auth_users_without_access', 'blockers', 'converted_orgs', 'cron_jobs', 'daftra_connections_mock', 'demo_org_present', 'deploy_environment', 'extensions', 'health_check',
  'min_schema_version', 'msg_channels_mock', 'orgs_by_environment', 'platform_admins', 'platform_admins_count',
  'public_tables_without_rls', 'public_tables_without_rls_names', 'schema_version', 'seed_rows', 'warnings'];
async function secChecks() {
  section('6a. post_install_checks.sql on staging (seed): read-only, expected keys, blockers');
  const src = fs.readFileSync(CHECKS_FILE, 'utf8');
  await check('file: one statement, no write / DDL / function call outside the read-only list', () => {
    const code = src.replace(/--.*$/gm, '');
    const stmts = code.split(';').filter(s => s.trim());
    return (stmts.length === 1 && !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|set_config|set_deploy_environment|nextval|pg_cron|net\.http)\b/i.test(code.replace(/'[^']*'/g, '')))
      || 'statements ' + stmts.length;
  });
  let c;
  await check('runs inside a READ ONLY transaction and returns the expected keys', async () => {
    c = await runChecks();
    return J(Object.keys(c).sort()) === J(KEYS) || J(Object.keys(c).sort());
  });
  if (!c) return;
  await check('values: staging, schema = the latest file, RLS on every public table, demo org + seed rows present', () =>
    (c.deploy_environment === 'staging' && c.schema_version === LATEST && c.health_check.ok === true
      && c.public_tables_without_rls === 0 && c.demo_org_present === true && c.seed_rows >= 10) || J(c));
  await check('platform admins: count + masked e-mail + TOTP flag (none verified here)', () =>
    (c.platform_admins_count === 1 && c.platform_admins[0].email === 'p***@env.example.com' && c.platform_admins[0].totp_verified === false) || J(c.platform_admins));
  await check('extensions absent in PGlite → nulls, cron_jobs null; mock counts are numbers', () =>
    (J(c.extensions) === J({ pg_net: null, pg_cron: null, pg_trgm: null, supabase_vault: null }) && c.cron_jobs === null
      && Number.isInteger(c.msg_channels_mock) && Number.isInteger(c.daftra_connections_mock)) || J(c));
  await check('blockers on staging name the demo / seed / environment / staging orgs / TOTP problems', () =>
    J(c.blockers) === J(['deploy_environment_not_production', 'demo_org_present', 'seed_rows_present', 'platform_admin_without_totp', 'staging_orgs_present']
      .concat(CRON_BLOCKERS)) || J(c.blockers));
  await check('a public table without RLS is reported (temporary table, rolled back)', async () => {
    await db.exec(`BEGIN; CREATE TABLE public.zz_no_rls (id int)`);
    try { const r = (await q(src))[0].checks; return (r.public_tables_without_rls === 1 && J(r.public_tables_without_rls_names) === J(['zz_no_rls']) && r.blockers.includes('public_tables_without_rls')) || J(r); }
    finally { await db.exec('ROLLBACK'); }
  });
  await check('running it changed nothing (row counts of the touched tables identical)', async () => {
    const snap = () => q(`SELECT (SELECT count(*) FROM public.organizations) o, (SELECT count(*) FROM public.schema_versions) v,
                                 (SELECT count(*) FROM public.audit_log) a, (SELECT environment FROM app.deploy_settings) e`);
    const a = J(await snap()); await runChecks(); await q(src);
    return a === J(await snap());
  });
}

async function secInstall() {
  section('7. install file: scripts/build-production-sql.py (fresh PGlite, one transaction)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marsa-install-'));
  const out = path.join(tmp, 'install.sql');
  try {
    let log = '';
    await check('build-production-sql.py writes the install file (outside the repository); --check-seed refuses seed.sql', () => {
      log = execFileSync('python3', ['-I', path.join(ROOT, 'scripts', 'build-production-sql.py'), out], { encoding: 'utf8' });
      let refused = false;
      try { execFileSync('python3', ['-I', path.join(ROOT, 'scripts', 'build-production-sql.py'), '--check-seed', path.join(SUPA, 'seed.sql')], { stdio: 'pipe' }); }
      catch (e) { refused = e.status === 1 && /REFUSED/.test(String(e.stdout)); }
      return (fs.existsSync(out) && /sha256: [0-9a-f]{64}/.test(log) && refused) || log;
    });
    if (!fs.existsSync(out)) return;
    const sql = fs.readFileSync(out, 'utf8');
    const install = async (text, prep) => {
      const d = new PGlite();
      try {
        await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
        if (prep) await d.exec(prep);
        await d.exec('BEGIN');
        const m = await tryErr(() => d.exec(text));
        if (m === 'ok') await d.exec('COMMIT'); else await d.exec('ROLLBACK');
        const left = (await d.query(`SELECT to_regclass('public.schema_versions') IS NOT NULL t`)).rows[0].t;
        const h = left ? (await d.query(`SELECT public.health_check() h`)).rows[0].h : null;
        return { m, left, h };
      } finally { await d.close(); }
    };
    const FAKE_CRON = `CREATE SCHEMA cron; CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text, command text, jobname text, active boolean DEFAULT true);
                       INSERT INTO cron.job (schedule, command, jobname) VALUES ('17 3 * * *', 'x', 'marsa_idem_purge'), ('27 3 * * *', 'x', 'marsa_client_errors_purge'), ('*/15 * * * *', 'x', 'marsa_refresh_alerts')`;
    await check('without pg_cron: the last post-install check RAISEs and the whole install rolls back (nothing left)', async () => {
      const r = await install(sql);
      return (/POST-INSTALL: pg_cron is not enabled/.test(r.m) && r.left === false) || J(r);
    });
    const PG_CRON_TEST = "IF NOT EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = 'pg_cron') THEN";
    await check('pg_cron present (simulated) but a job missing → POST-INSTALL: pg_cron job(s) missing; rolled back', async () => {
      if (!sql.includes(PG_CRON_TEST)) return 'pg_cron check not found in the install file';
      const r = await install(sql.replace(PG_CRON_TEST, 'IF false THEN'), FAKE_CRON.replace(", ('*/15 * * * *', 'x', 'marsa_refresh_alerts')", ''));
      return (/POST-INSTALL: pg_cron job\(s\) missing: marsa_refresh_alerts/.test(r.m) && r.left === false) || J(r);
    });
    await check('pg_cron + its 3 jobs (simulated): installs; production, latest schema, no org; a second run is refused by the preflight', async () => {
      const text = sql.replace(PG_CRON_TEST, 'IF false THEN');
      const d = new PGlite();
      try {
        await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
        await d.exec(FAKE_CRON);
        const m = await tryErr(() => d.exec('BEGIN; ' + text + ' COMMIT;'));
        const h = (await d.query(`SELECT public.health_check() h`)).rows[0].h;
        const n = (await d.query(`SELECT count(*)::int n FROM public.organizations`)).rows[0].n;
        const again = await tryErr(() => d.exec(text));
        return (m === 'ok' && h.environment === 'production' && h.schema_version === migFiles().pop().slice(0, 14) && n === 0
          && /MRS_PREFLIGHT: this database already has the Marsa schema/.test(again)) || J({ m, h, n, again });
      } finally { await d.close(); }
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const SECTIONS = [secFile, secPreflight, secStaging, secSwitchRules, secChecks, secProduction, secInstall];

async function main() {
  db = new PGlite();
  section('load shim + migrations + seed');
  if (!migFiles().includes(MIG)) { fail('deploy_env migration present', MIG + ' not found'); return finish(); }
  if (!fs.existsSync(CHECKS_FILE)) { fail('post_install_checks.sql present', CHECKS_FILE + ' not found'); return finish(); }
  if (!await runFile(db, path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migFiles()) if (!await runFile(db, path.join(MIG_DIR, m))) return finish();
  if (!await runFile(db, path.join(SUPA, 'seed.sql'))) return finish();
  try { await fixtures(); pass('fixtures: a platform admin, an org A admin'); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }
  for (const s of SECTIONS) {
    try { await s(); }
    catch (e) { fail('section ' + s.name + ' aborted', errText(e) + '\n' + (e.stack || '').split('\n').slice(0, 4).join(' | ')); }
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
main().catch(e => { console.error(e); process.exit(1); });
