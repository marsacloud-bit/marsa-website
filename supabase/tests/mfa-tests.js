#!/usr/bin/env node
/*
  Marsa (مرسى) — MFA (TOTP) required for organization admins and platform admins (docs/online/MFA_SPEC.md §7).
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted, MFA held back) → supabase/seed.sql → catalog
  snapshot → the MFA migration (then re-applied twice) → fixtures. A second PGlite proves the preflight.
  Claims always carry an explicit "aal", or (aal = null) none at all with marsa_test.default_aal = 'none'
  (the shim's default-aal2 injection switched off → a missing claim, which must count as aal1).

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/mfa-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const MFA_MIGRATION = '20261109000100_mfa.sql';
const G7_MIGRATION = '20261108000100_g7_subscriptions.sql';
const MFA_FILE = path.join(MIG_DIR, MFA_MIGRATION);

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in mfa-tests'); };

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const J = x => JSON.stringify(x);
const JS = (x, keys) => JSON.stringify(x, keys);   // stable key order
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e)); }
}
async function expectErr(name, promiseFn, re) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
}
async function tryErr(fn) { try { await fn(); return 'ok'; } catch (e) { return errText(e); } }

/* ================================================================== ids */
const A = '0b5e0000-0000-4000-8000-000000000001';       // seed org (synthetic staging data only)
const JED = '0b5e0000-0000-4000-8000-000000000011';
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const ID = n => 'aa1f0000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const M = ID(0xd1), M_BR = ID(0xd2), M_CL = ID(0xd3), X = ID(0xe1);
const U = {
  adminA: ID(1), plat: ID(2), clrA: ID(3), mixed: ID(4), same: ID(5), clientA: ID(6), optUser: ID(7), pendingUser: ID(8),
  oldAdmin: ID(9), both: ID(10), clrM: ID(11), selfInv: ID(12)
};
const EMAIL = k => k.toLowerCase() + '@mfa.example.com';

let db;
async function asRole(who, aal, fn) {
  if (who === 'anon') await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  else if (who === 'service') await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  else {
    if (!U[who]) throw new Error('unknown user ' + who);
    const claims = { sub: U[who], role: 'authenticated' };
    if (aal) claims.aal = aal;
    await db.exec(`SELECT set_config('marsa_test.default_aal', '${aal ? '' : 'none'}', false);
                   SET ROLE authenticated; SELECT set_config('request.jwt.claims', '${J(claims)}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false); SELECT set_config('marsa_test.default_aal', '', false);`); }
}
// owner session carrying the user's claims (no SET ROLE): reaches owner-only app helpers as that user would inside a definer RPC
async function asOwner(who, aal, fn) {
  const claims = { sub: U[who], role: 'authenticated' };
  if (aal !== null) claims.aal = aal;
  await db.exec(`SELECT set_config('marsa_test.default_aal', '${aal === null ? 'none' : ''}', false);
                 SELECT set_config('request.jwt.claims', '${J(claims)}', false);`);
  try { return await fn(); }
  finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false); SELECT set_config('marsa_test.default_aal', '', false);`); }
}
const own = async (who, aal, sql, params) => (await asOwner(who, aal, () => q(sql, params)))[0].r;
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
const num = async (sql, params) => Number((await q(sql, params))[0].n);
const as = (who, aal, sql, params) => asRole(who, aal, () => q(sql, params));
const rpc = async (who, aal, sql, params) => (await as(who, aal, sql, params))[0].r;
const cnt = async (who, aal, sql, params) => Number((await as(who, aal, sql, params))[0].n);
async function runFile(file, quietLoad) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); if (!quietLoad) console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}
const MFA_RE = /MRS_MFA_REQUIRED aal2/;
const AALS = [['aal1', 'aal1'], ['missing aal', null]];

const NEW_FNS = ['app.mfa_gated_roles()', 'app.session_aal()', 'app.mfa_ok()', 'app.mfa_factor_verified(uuid)', 'app.mfa_required_for(uuid)',
  'app.mfa_required_reasons(uuid)', 'app.mfa_pending()'];
const RECREATED = ['app.is_member(uuid)', 'app.has_role(uuid,text[])', 'app.has_branch_role(uuid,uuid,text[])', 'app.rpt_scope(uuid,text[])',
  'app.is_platform_admin()', 'app.fail(text,text)', 'public.my_context()',
  'app.can_read_batch(uuid)', 'app.can_edit_batch(uuid)', 'public.accept_invitation(text)'];
// the only policies re-created (creator branch of import staging now also needs app.is_member)
const RECREATED_POLS = ['public.import_batches.import_batches_select', 'public.import_batches.import_batches_update'];
const DEFINER = ['app.mfa_factor_verified(uuid)', 'app.mfa_required_for(uuid)', 'app.mfa_required_reasons(uuid)', 'app.mfa_pending()',
  'app.is_member(uuid)', 'app.has_role(uuid,text[])', 'app.has_branch_role(uuid,uuid,text[])', 'app.rpt_scope(uuid,text[])',
  'app.is_platform_admin()', 'public.my_context()', 'app.can_read_batch(uuid)', 'app.can_edit_batch(uuid)', 'public.accept_invitation(text)'];
const sigNorm = s => s.replace(/\s+/g, '');

async function catalog() {
  return {
    fns: (await q(`SELECT n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' sig,
                          md5(p.prosrc || coalesce(array_to_string(p.proconfig, ','), '') || p.prosecdef::text || p.provolatile::text) h,
                          coalesce(p.proacl::text, '') acl
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','app') ORDER BY 1`))
      .map(r => ({ sig: sigNorm(r.sig), h: r.h, acl: r.acl })),
    tables: (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname IN ('public','app','storage') AND c.relkind IN ('r','v','m','p') ORDER BY 1`)).map(r => r.t),
    cols: (await q(`SELECT table_schema || '.' || table_name || '.' || column_name c FROM information_schema.columns
                     WHERE table_schema IN ('public','app') ORDER BY 1`)).map(r => r.c),
    pols: (await q(`SELECT schemaname || '.' || tablename || '.' || policyname || ':' || md5(coalesce(qual, '') || coalesce(with_check, '')) p
                      FROM pg_policies WHERE schemaname IN ('public','storage') ORDER BY 1`)).map(r => r.p),
    trg: (await q(`SELECT n.nspname || '.' || c.relname || '.' || t.tgname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','storage') AND NOT t.tgisinternal ORDER BY 1`)).map(r => r.x),
    authExec: (await q(`SELECT p.oid::regprocedure::text s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = 'public' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') ORDER BY 1`)).map(r => r.s),
    anonExec: (await q(`SELECT p.oid::regprocedure::text s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname IN ('public','app') AND has_function_privilege('anon', p.oid, 'EXECUTE') ORDER BY 1`)).map(r => r.s)
  };
}

/* ================================================================== fixtures */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${EMAIL(k)}', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.profiles (id, full_name) SELECT u.id, split_part(u.email, '@', 1) FROM auth.users u WHERE u.email LIKE '%@mfa.example.com'
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.plat}', 'mfa test operator'), ('${U.both}', 'mfa test operator + admin');
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${M}', 'org-mfa-m', 'مؤسسة م للتحقق', 'TFM');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${M_BR}', '${M}', 'JED', 'فرع م');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${M_CL}', '${M}', 'business', 'عميل م التجريبي', '0508888888');
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${X}', 'org-mfa-x', 'مؤسسة موقوفة', 'TFX');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'),
      ('${U.clrA}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.mixed}', '${A}', NULL, 'admin'), ('${U.mixed}', '${M}', '${M_BR}', 'clearance_staff'),
      ('${U.same}', '${A}', NULL, 'admin'), ('${U.same}', '${A}', NULL, 'accountant'),
      ('${U.clientA}', '${A}', NULL, 'client'),
      ('${U.optUser}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.pendingUser}', '${A}', NULL, 'admin'),
      ('${U.oldAdmin}', '${X}', NULL, 'admin'),
      ('${U.both}', '${A}', NULL, 'admin'),
      ('${U.clrM}', '${M}', '${M_BR}', 'clearance_staff'),
      ('${U.selfInv}', '${A}', NULL, 'admin');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CL101}', '${U.clientA}', 'owner');
    UPDATE public.organizations SET is_active = false WHERE id = '${X}';
    INSERT INTO auth.mfa_factors (user_id, friendly_name, factor_type, status) VALUES
      ('${U.optUser}', 'phone', 'totp', 'verified'),
      ('${U.pendingUser}', 'half', 'totp', 'unverified'),
      ('${U.both}', 'phone', 'totp', 'verified');
  `);
  txM = await sqlTx(M, M_BR, M_CL);
}
let txSeq = 0, txM = null;
async function sqlTx(org, branch, client) {
  txSeq++;
  return (await one(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, goods_description)
    VALUES ($1, $2, $3, 'import', 'sea', 'بضاعة اختبار التحقق ' || $4::text) RETURNING id`, [org, branch, client, txSeq])).id;
}

/* ================================================================== sections */
let C0 = null;
let C1M = null;   // the catalog right after the MFA file, before any later migration (G6c re-creates msg_* bodies on its own)

async function secCatalog() {
  section('1. catalog: helpers, re-created functions, privileges, nothing else changed');
  const C1 = C1M;
  await check('schema_versions row 20261109000100 mfa; health_check reports the latest migration file (anon)', async () => {
    const r = await one(`SELECT name FROM public.schema_versions WHERE version = '20261109000100'`);
    const h = await rpc('anon', null, `SELECT public.health_check() r`);
    const latest = fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort().pop().split('_')[0];
    return (r && r.name === 'mfa' && latest >= '20261109000100' && h.schema_version === latest) || J({ r, h, latest });
  });
  const m0 = new Map(C0.fns.map(f => [f.sig, f]));
  const m1 = new Map(C1.fns.map(f => [f.sig, f]));
  await check('exactly the 7 new app.mfa_* / session_aal helpers were added (no other function, no public function)', () => {
    const added = C1.fns.filter(f => !m0.has(f.sig)).map(f => f.sig).sort();
    const removed = C0.fns.filter(f => !m1.has(f.sig)).map(f => f.sig);
    return (J(added) === J(NEW_FNS.map(sigNorm).sort()) && removed.length === 0) || J({ added, removed });
  });
  await check('exactly the 10 listed functions were re-created (every other public / app body, config, security unchanged)', () => {
    const changed = C0.fns.filter(f => m1.get(f.sig) && m1.get(f.sig).h !== f.h).map(f => f.sig).sort();
    return J(changed) === J(RECREATED.map(sigNorm).sort()) || 'changed: ' + changed.join(', ');
  });
  await check('re-created functions keep their exact ACL', () => {
    const diff = RECREATED.map(sigNorm).filter(s => m0.get(s).acl !== m1.get(s).acl).map(s => s + ' ' + m0.get(s).acl + ' → ' + m1.get(s).acl);
    return diff.length === 0 || diff.join('; ');
  });
  await check('no table, column or trigger added / removed / changed; only the 2 import_batches policies re-defined', () => {
    const d = (a, b) => ({ add: b.filter(x => !a.includes(x)), del: a.filter(x => !b.includes(x)) });
    const r = { tables: d(C0.tables, C1.tables), cols: d(C0.cols, C1.cols), trg: d(C0.trg, C1.trg) };
    const pn = x => x.split(':')[0];
    const pd = d(C0.pols, C1.pols);
    const polOk = J(pd.add.map(pn).sort()) === J(RECREATED_POLS) && J(pd.del.map(pn).sort()) === J(RECREATED_POLS)
      && J(C0.pols.map(pn)) === J(C1.pols.map(pn));
    return (Object.values(r).every(x => !x.add.length && !x.del.length) && polOk) || J({ r, pols: pd });
  });
  await check(`set of public functions executable by authenticated unchanged (${C1.authExec.length})`, () =>
    J(C0.authExec) === J(C1.authExec) || J({ before: C0.authExec.length, after: C1.authExec.length }));
  await check('set of functions executable by anon unchanged', () => J(C0.anonExec) === J(C1.anonExec) || J({ before: C0.anonExec, after: C1.anonExec }));
  await check('SECURITY DEFINER exactly where listed, every new / re-created function pins search_path=""', async () => {
    const r = await q(`SELECT n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' sig, p.prosecdef d, p.proconfig c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public')`);
    const want = new Set(NEW_FNS.concat(RECREATED).map(sigNorm));
    const bad = r.filter(x => want.has(sigNorm(x.sig)))
      .filter(x => x.d !== DEFINER.map(sigNorm).includes(sigNorm(x.sig)) || !(x.c || []).includes('search_path=""'))
      .map(x => x.sig + ' definer=' + x.d + ' cfg=' + J(x.c));
    const seen = r.filter(x => want.has(sigNorm(x.sig))).length;
    return (bad.length === 0 && seen === want.size) || J({ bad, seen });
  });
  await check('volatility: mfa_gated_roles IMMUTABLE, the other helpers STABLE (no volatile definer helper)', async () => {
    const r = await q(`SELECT p.proname, p.provolatile v FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
                         AND (p.proname LIKE 'mfa\\_%' OR p.proname = 'session_aal')`);
    const bad = r.filter(x => x.v !== (x.proname === 'mfa_gated_roles' ? 'i' : 's'));
    return (r.length === 7 && bad.length === 0) || J(r);
  });
  await check('anon can execute no app.mfa_* / session_aal helper', async () =>
    (await num(`SELECT count(*) n FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND (p.proname LIKE 'mfa\\_%' OR p.proname = 'session_aal')
                  AND has_function_privilege('anon', p.oid, 'EXECUTE')`)) === 0);
  await check('authenticated cannot execute mfa_factor_verified / mfa_required_for / mfa_required_reasons (arbitrary uid)', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
                         AND p.proname IN ('mfa_factor_verified','mfa_required_for','mfa_required_reasons')
                         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR p.proacl IS NULL
                              OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))`);
    return r.length === 0 || 'callable: ' + r.map(x => x.proname).join(', ');
  });
  await check('authenticated + service_role can execute mfa_pending / mfa_ok / session_aal / mfa_gated_roles (app.fail in invoker paths)', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('service_role', p.oid, 'EXECUTE') s
                         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
                          AND p.proname IN ('mfa_pending','mfa_ok','session_aal','mfa_gated_roles')`);
    return (r.length === 4 && r.every(x => x.a && x.s)) || J(r);
  });
  await expectErr('authenticated calling app.mfa_required_for directly → permission denied', () =>
    as('clrA', 'aal2', `SELECT app.mfa_required_for($1) r`, [U.adminA]), /permission denied/);
  await check('app.mfa_gated_roles() = {admin}', async () => J((await one(`SELECT app.mfa_gated_roles() r`)).r) === J(['admin']));
}

async function secPreflight() {
  section('2. preflight + idempotency');
  const { PGlite } = require('@electric-sql/pglite');
  const main = db;
  db = new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
    const files = fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
    for (const f of files.filter(f => f < G7_MIGRATION)) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    const left = async () => one(`SELECT to_regprocedure('app.mfa_ok()') IS NULL f1, to_regprocedure('app.mfa_pending()') IS NULL f2,
                                        NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261109000100') nov`);
    const fp = async () => J(await q(`SELECT p.oid::regprocedure::text s, md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                        WHERE n.nspname IN ('app','public') ORDER BY 1`));
    let before = await fp();
    let msg = await tryErr(() => db.exec(fs.readFileSync(MFA_FILE, 'utf8')));
    await check('without G7: exact preflight message', () =>
      msg.startsWith('MFA preflight: apply G7 first (schema_versions lacks 20261108000100 g7_subscriptions)') || 'got: ' + msg);
    await check('without G7: nothing created (no helper, no re-created body, no schema_versions row)', async () => {
      const l = await left();
      return (l.f1 && l.f2 && l.nov && before === await fp()) || J(l);
    });
    await db.exec(fs.readFileSync(path.join(MIG_DIR, G7_MIGRATION), 'utf8'));
    await db.exec(`ALTER TABLE auth.mfa_factors RENAME TO mfa_factors_hidden`);
    before = await fp();
    msg = await tryErr(() => db.exec(fs.readFileSync(MFA_FILE, 'utf8')));
    await check('without auth.mfa_factors: exact preflight message', () =>
      msg.startsWith('MFA preflight: auth.mfa_factors not found (Supabase Auth MFA schema missing)') || 'got: ' + msg);
    await check('without auth.mfa_factors: nothing created', async () => {
      const l = await left();
      return (l.f1 && l.f2 && l.nov && before === await fp()) || J(l);
    });
    await db.exec(`ALTER TABLE auth.mfa_factors_hidden RENAME TO mfa_factors`);
    await check('with G7 + auth.mfa_factors: applies (no seed needed)', async () =>
      (await tryErr(() => db.exec(fs.readFileSync(MFA_FILE, 'utf8')))) === 'ok');
  } finally { await db.close(); db = main; }

  const hashes = async () => J(await q(`SELECT n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' s,
                                              md5(p.prosrc || coalesce(array_to_string(p.proconfig, ','), '') || p.prosecdef::text) h, coalesce(p.proacl::text, '') a
                                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`));
  const h1 = await hashes();
  let ok = true;
  for (let i = 0; i < 2; i++) ok = (await runFile(MFA_FILE, true)) && ok;
  await check('re-applied twice more on the full DB: applies, identical function hashes + ACLs, one schema_versions row', async () => {
    const h2 = await hashes();
    const n = await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261109000100'`);
    if (ok && h1 === h2 && n === 1) return true;
    const a = JSON.parse(h1), b = new Map(JSON.parse(h2).map(x => [x.s, x]));
    return J({ ok, n, diff: a.filter(x => J(x) !== J(b.get(x.s))).map(x => [x, b.get(x.s)]) });
  });
}

const ADMIN_RPCS = [
  ['admin_list_members', `SELECT public.admin_list_members($1) r`, () => [A]],
  ['admin_update_org', `SELECT public.admin_update_org($1, $2) r`, () => [A, { name_en: 'Blue Sea Est. (staging)' }]],
  ['admin_list_invitations', `SELECT public.admin_list_invitations($1) r`, () => [A]],
  ['admin_audit_log', `SELECT public.admin_audit_log($1, '{}') r`, () => [A]],
  ['admin_recent_errors', `SELECT public.admin_recent_errors($1) r`, () => [A]],
  ['org_subscription', `SELECT public.org_subscription($1) r`, () => [A]],
  ['dash_management (rpt_scope)', `SELECT public.dash_management($1, '{}') r`, () => [A]]
];
let invSeq = 0;
const invitePayload = () => ({ email: 'invitee' + (++invSeq) + '@mfa.example.com', role: 'clearance_staff', branch_id: JED });

async function secOrgAdmin() {
  section('3. org admin: aal1 / missing aal → no admin privilege; aal2 → full');
  const READS = [
    ['organizations', `SELECT count(*) n FROM public.organizations WHERE id = '${A}'`],
    ['branches', `SELECT count(*) n FROM public.branches WHERE org_id = '${A}'`],
    ['transactions', `SELECT count(*) n FROM public.transactions WHERE org_id = '${A}'`],
    ['clients', `SELECT count(*) n FROM public.clients WHERE org_id = '${A}'`],
    ['memberships of others', `SELECT count(*) n FROM public.memberships WHERE org_id = '${A}' AND user_id <> '${U.adminA}'`],
    ['audit_log', `SELECT count(*) n FROM public.audit_log WHERE org_id = '${A}'`]
  ];
  const at2 = {};
  for (const [label, sql] of READS) at2[label] = await cnt('adminA', 'aal2', sql);
  await check('aal2 baseline: adminA sees org A rows (organizations / branches / transactions / clients / memberships / audit)', () =>
    Object.values(at2).every(n => n > 0) || J(at2));
  for (const [an, aal] of AALS) {
    await check(`${an}: helpers deny (is_member / has_role / has_branch_role false, rpt_scope '{}', is_staff false)`, async () => {
      const r = await as('adminA', aal, `SELECT app.is_member($1) m, app.has_role($1, ARRAY['admin']) a, app.has_role($1, app.all_roles()) ar,
                                                 app.has_branch_role($1, $2, ARRAY['admin']) b, app.is_staff($1) s`, [A, JED]);
      const sc = await own('adminA', aal, `SELECT app.rpt_scope($1, ARRAY['admin']) r`, [A]);
      const sca = await own('adminA', aal, `SELECT app.rpt_scope($1, app.all_roles()) r`, [A]);
      return (r[0].m === false && r[0].a === false && r[0].ar === false && r[0].b === false && r[0].s === false
              && J(sc) === '[]' && J(sca) === '[]') || J({ r, sc, sca });
    });
    await check(`${an}: RLS reads of org A → 0 rows`, async () => {
      const o = {};
      for (const [label, sql] of READS) o[label] = await cnt('adminA', aal, sql);
      return Object.values(o).every(n => n === 0) || J(o);
    });
    await check(`${an}: own membership row still visible (user_id = auth.uid())`, async () =>
      (await cnt('adminA', aal, `SELECT count(*) n FROM public.memberships WHERE user_id = $1`, [U.adminA])) === 1);
    for (const [name, sql, p] of ADMIN_RPCS) await expectErr(`${an}: ${name} → MRS_MFA_REQUIRED (detail aal2)`, () => rpc('adminA', aal, sql, p()), MFA_RE);
    await expectErr(`${an}: admin_invite → MRS_MFA_REQUIRED`, () => rpc('adminA', aal, `SELECT public.admin_invite($1, $2) r`, [A, invitePayload()]), MFA_RE);
    await expectErr(`${an}: report_transactions (rpt_gate_staff) → MRS_MFA_REQUIRED`, () => rpc('adminA', aal, `SELECT public.report_transactions($1, '{}') r`, [A]), MFA_RE);
  }
  await check('aal2: every admin RPC succeeds (list members / update org / invitations / audit / errors / subscription / dash_management)', async () => {
    const bad = [];
    for (const [name, sql, p] of ADMIN_RPCS) { const r = await tryErr(() => rpc('adminA', 'aal2', sql, p())); if (r !== 'ok') bad.push(name + ': ' + r); }
    return bad.length === 0 || bad.join('; ');
  });
  await check('aal2: admin_invite succeeds', async () => {
    const r = await rpc('adminA', 'aal2', `SELECT public.admin_invite($1, $2) r`, [A, invitePayload()]);
    return !!(r && (r.id || r.invitation_id || r.token)) || J(r);
  });
  await check('aal2: report_transactions returns org A rows; helpers true', async () => {
    const r = await rpc('adminA', 'aal2', `SELECT public.report_transactions($1, '{}') r`, [A]);
    const h = await as('adminA', 'aal2', `SELECT app.is_member($1) m, app.has_role($1, ARRAY['admin']) a`, [A]);
    const sc = await own('adminA', 'aal2', `SELECT app.rpt_scope($1, ARRAY['admin']) r`, [A]);
    return (r.totals.count > 0 && h[0].m && h[0].a && sc === null) || J({ t: r.totals, h, sc });
  });
  await check('aal2: RLS reads equal the baseline', async () => {
    const o = {};
    for (const [label, sql] of READS) o[label] = await cnt('adminA', 'aal2', sql);
    o.audit_log = at2.audit_log = Math.min(o.audit_log, at2.audit_log);   // the aal2 admin RPCs above added audit rows
    return J(o) === J(at2) || J({ o, at2 });
  });
  await check('aal3 / any other value is not aal2 → denied', async () =>
    (await as('adminA', 'aal3', `SELECT app.has_role($1, ARRAY['admin']) a`, [A]))[0].a === false);
}

const PLATFORM_RPCS = [
  ['platform_list_orgs', `SELECT public.platform_list_orgs() r`, () => []],
  ['platform_list_plans', `SELECT public.platform_list_plans() r`, () => []],
  ['platform_recent_errors', `SELECT public.platform_recent_errors() r`, () => []],
  ['platform_list_subscriptions', `SELECT public.platform_list_subscriptions() r`, () => []]
];
let orgSeq = 0;
const orgPayload = () => {
  orgSeq++;
  return { slug: 'org-mfa-new' + orgSeq, name_ar: 'مؤسسة تحقق جديدة ' + orgSeq, ref_prefix: 'tn' + String.fromCharCode(96 + orgSeq), default_locale: 'ar',
           branch: { code: 'ruh', name_ar: 'فرع الرياض', city: 'الرياض' }, admin_email: 'newadmin' + orgSeq + '@mfa.example.com',
           idempotencyKey: 'aa1fc000-0000-4000-8000-' + orgSeq.toString(16).padStart(12, '0') };
};

async function secPlatform() {
  section('4. platform admin: aal1 / missing aal → MRS_MFA_REQUIRED; aal2 → ok');
  for (const [an, aal] of AALS) {
    await check(`${an}: app.is_platform_admin() false (true at aal2)`, async () =>
      (await own('plat', aal, `SELECT app.is_platform_admin() r`)) === false && (await own('plat', 'aal2', `SELECT app.is_platform_admin() r`)) === true);
    for (const [name, sql, p] of PLATFORM_RPCS) await expectErr(`${an}: ${name} → MRS_MFA_REQUIRED`, () => rpc('plat', aal, sql, p()), MFA_RE);
    await expectErr(`${an}: platform_create_org → MRS_MFA_REQUIRED`, () => rpc('plat', aal, `SELECT public.platform_create_org($1) r`, [orgPayload()]), MFA_RE);
  }
  await check('aal2: platform_list_orgs / list_plans / recent_errors / list_subscriptions succeed', async () => {
    const bad = [];
    for (const [name, sql, p] of PLATFORM_RPCS) { const r = await tryErr(() => rpc('plat', 'aal2', sql, p())); if (r !== 'ok') bad.push(name + ': ' + r); }
    return bad.length === 0 || bad.join('; ');
  });
  await check('aal2: platform_create_org succeeds', async () => {
    const r = await tryErr(() => rpc('plat', 'aal2', `SELECT public.platform_create_org($1) r`, [orgPayload()]));
    return r === 'ok' || r;
  });
  await check('both (platform admin + org admin, verified factor) aal1: no platform and no admin privilege; aal2: both', async () => {
    const r1 = (await asOwner('both', 'aal1', () => q(`SELECT app.is_platform_admin() p, app.has_role($1, ARRAY['admin']) a`, [A])))[0];
    const r2 = (await asOwner('both', 'aal2', () => q(`SELECT app.is_platform_admin() p, app.has_role($1, ARRAY['admin']) a`, [A])))[0];
    return (!r1.p && !r1.a && r2.p && r2.a) || J({ r1, r2 });
  });
}

async function secStaff() {
  section('5. staff / client unaffected');
  const STAFF_READS = [
    `SELECT count(*) n FROM public.transactions`, `SELECT count(*) n FROM public.documents`, `SELECT count(*) n FROM public.clients`,
    `SELECT count(*) n FROM public.containers`, `SELECT count(*) n FROM public.organizations`, `SELECT count(*) n FROM public.branches`
  ];
  for (const who of ['clrA', 'optUser', 'clientA', 'clrM']) {
    await check(`${who}: row counts at aal1 = missing aal = aal2 (transactions / documents / clients / containers / orgs / branches)`, async () => {
      const r = {};
      for (const a of ['aal1', null, 'aal2']) { r[a || 'none'] = []; for (const s of STAFF_READS) r[a || 'none'].push(await cnt(who, a, s)); }
      return (J(r.aal1) === J(r.aal2) && J(r.none) === J(r.aal2) && r.aal2[0] > 0) || J(r);
    });
  }
  await check('clientA: portal reads (my_context clients, portal_invoices) equal at aal1 and aal2', async () => {
    const c1 = (await rpc('clientA', 'aal1', `SELECT public.my_context() r`)).clients;
    const c2 = (await rpc('clientA', 'aal2', `SELECT public.my_context() r`)).clients;
    const p1 = await tryErr(() => rpc('clientA', 'aal1', `SELECT public.portal_invoices($1) r`, [CL101]));
    const p2 = await tryErr(() => rpc('clientA', 'aal2', `SELECT public.portal_invoices($1) r`, [CL101]));
    return (J(c1) === J(c2) && c1.length === 1 && p1 === p2) || J({ c1, c2, p1, p2 });
  });
  await check('clrA at aal1: set_transaction_status permitted transition (new → in_progress) succeeds', async () => {
    const tx = await sqlTx(A, JED, CL101);
    const r = await tryErr(() => rpc('clrA', 'aal1', `SELECT public.set_transaction_status($1, 'in_progress', NULL) r`, [tx]));
    const st = (await one(`SELECT operational_status s FROM public.transactions WHERE id = $1`, [tx])).s;
    return (r === 'ok' && st === 'in_progress') || J({ r, st });
  });
  for (const [an, aal] of AALS.concat([['aal2', 'aal2']])) {
    await expectErr(`clrA ${an}: admin_list_members still MRS_FORBIDDEN (not rewritten)`, () => rpc('clrA', aal, `SELECT public.admin_list_members($1) r`, [A]), /MRS_FORBIDDEN/);
    await expectErr(`clrA ${an}: platform_list_orgs still MRS_FORBIDDEN`, () => rpc('clrA', aal, `SELECT public.platform_list_orgs() r`), /MRS_FORBIDDEN/);
  }
  await check('clrA aal1: MRS_FORBIDDEN is not MRS_MFA_REQUIRED', async () => !/MRS_MFA_REQUIRED/.test(await tryErr(() => rpc('clrA', 'aal1', `SELECT public.admin_list_members($1) r`, [A]))));
  await check('optUser (optional verified factor, clearance_staff) at aal1: full staff access, my_context satisfied', async () => {
    const c = await rpc('optUser', 'aal1', `SELECT public.my_context() r`);
    const h = (await as('optUser', 'aal1', `SELECT app.has_branch_role($1, $2, ARRAY['clearance_staff']) b`, [A, JED]))[0].b;
    return (c.mfa.required === false && c.mfa.satisfied === true && c.mfa.enrolled === true && h === true) || J({ mfa: c.mfa, h });
  });
}

async function secMixed() {
  section('6. mixed roles (per membership row)');
  await check('mixed aal1: org M staff reads ok (transactions of M visible), org A gives nothing', async () => {
    const m = await cnt('mixed', 'aal1', `SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [M]);
    const a = await cnt('mixed', 'aal1', `SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [A]);
    const h = (await as('mixed', 'aal1', `SELECT app.is_member($1) ma, app.is_member($2) mm, app.has_branch_role($2, $3, ARRAY['clearance_staff']) b`, [A, M, M_BR]))[0];
    return (m > 0 && a === 0 && h.ma === false && h.mm === true && h.b === true) || J({ m, a, h });
  });
  await check('mixed aal1: org M write (set_transaction_status new → in_progress) succeeds', async () => {
    const r = await tryErr(() => rpc('mixed', 'aal1', `SELECT public.set_transaction_status($1, 'in_progress', NULL) r`, [txM]));
    return r === 'ok' || r;
  });
  await expectErr('mixed aal1: admin RPC on A → MRS_MFA_REQUIRED', () => rpc('mixed', 'aal1', `SELECT public.admin_list_members($1) r`, [A]), MFA_RE);
  await expectErr('mixed aal1: admin RPC on M (never admin there) → MRS_MFA_REQUIRED (caller is MFA-pending: per-user error code)', () =>
    rpc('mixed', 'aal1', `SELECT public.admin_list_members($1) r`, [M]), MFA_RE);
  await check('mixed aal2: org A admin + org M staff', async () => {
    const h = (await as('mixed', 'aal2', `SELECT app.has_role($1, ARRAY['admin']) a, app.is_member($2) mm`, [A, M]))[0];
    const r = await tryErr(() => rpc('mixed', 'aal2', `SELECT public.admin_list_members($1) r`, [A]));
    return (h.a && h.mm && r === 'ok') || J({ h, r });
  });
  await expectErr('mixed aal2: admin RPC on M still MRS_FORBIDDEN', () => rpc('mixed', 'aal2', `SELECT public.admin_list_members($1) r`, [M]), /MRS_FORBIDDEN/);

  await check('same (admin + accountant in A) aal1: accountant powers only (has_role accountant true, admin false, is_member true)', async () => {
    const h = (await asOwner('same', 'aal1', () => q(`SELECT app.has_role($1, ARRAY['accountant']) acc, app.has_role($1, ARRAY['admin']) adm,
                                                       app.is_member($1) m, app.rpt_scope($1, app.fin_read_roles()) sc`, [A])))[0];
    return (h.acc && !h.adm && h.m && h.sc === null) || J(h);
  });
  await check('same aal1: finance read (dash_finance) ok', async () => {
    const r = await tryErr(() => rpc('same', 'aal1', `SELECT public.dash_finance($1, '{}') r`, [A]));
    return r === 'ok' || r;
  });
  await expectErr('same aal1: admin RPC → MRS_MFA_REQUIRED', () => rpc('same', 'aal1', `SELECT public.admin_list_members($1) r`, [A]), MFA_RE);
  await check('same aal2: admin RPC ok', async () => (await tryErr(() => rpc('same', 'aal2', `SELECT public.admin_list_members($1) r`, [A]))) === 'ok');
}

async function secContext() {
  section('7. my_context: works at aal1, mfa object per fixture');
  const KEYS = ['user_id', 'profile', 'memberships', 'clients', 'is_platform_admin', 'organizations', 'mfa'];
  const MKEYS = ['org_id', 'org_slug', 'org_name_ar', 'org_name_en', 'environment', 'branch_id', 'branch_code', 'branch_name_ar', 'role',
    'role_label_ar', 'role_label_en', 'mfa_locked'];
  const want = {
    adminA:      { required: true,  reasons: ['org_admin'], enrolled: false },
    plat:        { required: true,  reasons: ['platform_admin'], enrolled: false },
    both:        { required: true,  reasons: ['org_admin', 'platform_admin'], enrolled: true },
    clrA:        { required: false, reasons: [], enrolled: false },
    clientA:     { required: false, reasons: [], enrolled: false },
    optUser:     { required: false, reasons: [], enrolled: true },
    pendingUser: { required: true,  reasons: ['org_admin'], enrolled: false },
    oldAdmin:    { required: false, reasons: [], enrolled: false },
    mixed:       { required: true,  reasons: ['org_admin'], enrolled: false },
    same:        { required: true,  reasons: ['org_admin'], enrolled: false }
  };
  for (const who of Object.keys(want)) {
    for (const [an, aal] of [['aal1', 'aal1'], ['missing aal', null], ['aal2', 'aal2']]) {
      await check(`${who} ${an}: my_context works, mfa exact`, async () => {
        const c = await rpc(who, aal, `SELECT public.my_context() r`);
        const ok2 = aal === 'aal2';
        const exp = { aal: ok2 ? 'aal2' : 'aal1', required: want[who].required, reasons: want[who].reasons, enrolled: want[who].enrolled,
                      satisfied: !want[who].required || ok2 };
        const got = c.mfa;
        const keysOk = KEYS.every(k => k in c) && c.memberships.every(m => MKEYS.every(k => k in m));
        const lockOk = c.memberships.every(m => m.mfa_locked === (m.role === 'admin' && !ok2));
        const keyOrder = J(Object.keys(got).sort()) === J(['aal', 'enrolled', 'reasons', 'required', 'satisfied']);
        return (keysOk && lockOk && keyOrder && JS(exp, Object.keys(exp).sort()) === JS(got, Object.keys(exp).sort())) || J({ exp, got, keysOk, lockOk });
      });
    }
  }
  await check('adminA aal1: memberships / organizations still list the admin row (UI knows what it gets after the challenge)', async () => {
    const c = await rpc('adminA', 'aal1', `SELECT public.my_context() r`);
    return (c.memberships.length === 1 && c.memberships[0].role === 'admin' && c.memberships[0].mfa_locked === true
            && c.organizations.length === 1 && J(c.organizations[0].roles) === J(['admin'])) || J(c);
  });
  await check('plat: is_platform_admin false at aal1 / missing, true at aal2', async () => {
    const a = (await rpc('plat', 'aal1', `SELECT public.my_context() r`)).is_platform_admin;
    const n = (await rpc('plat', null, `SELECT public.my_context() r`)).is_platform_admin;
    const b = (await rpc('plat', 'aal2', `SELECT public.my_context() r`)).is_platform_admin;
    return (a === false && n === false && b === true) || J({ a, n, b });
  });
  await check('mixed aal1: org M row mfa_locked false, org A admin row true', async () => {
    const c = await rpc('mixed', 'aal1', `SELECT public.my_context() r`);
    const a = c.memberships.find(m => m.org_id === A), m = c.memberships.find(x => x.org_id === M);
    return (a.mfa_locked === true && m.mfa_locked === false) || J(c.memberships);
  });
  await check('verified factor of another user is never reported (adminA enrolled false while optUser has one)', async () =>
    (await rpc('adminA', 'aal1', `SELECT public.my_context() r`)).mfa.enrolled === false);
  await check('adminA after verifying a factor (row added): enrolled true, still not satisfied at aal1', async () => {
    await q(`INSERT INTO auth.mfa_factors (user_id, friendly_name, factor_type, status) VALUES ($1, 'late', 'totp', 'verified')`, [U.adminA]);
    try {
      const c = await rpc('adminA', 'aal1', `SELECT public.my_context() r`);
      return (c.mfa.enrolled === true && c.mfa.satisfied === false) || J(c.mfa);
    } finally { await q(`DELETE FROM auth.mfa_factors WHERE user_id = $1`, [U.adminA]); }
  });
  await check('a non-totp verified factor (phone) does not count as enrolled', async () => {
    await q(`INSERT INTO auth.mfa_factors (user_id, friendly_name, factor_type, status) VALUES ($1, 'sms', 'phone', 'verified')`, [U.adminA]);
    try { return (await rpc('adminA', 'aal1', `SELECT public.my_context() r`)).mfa.enrolled === false; }
    finally { await q(`DELETE FROM auth.mfa_factors WHERE user_id = $1`, [U.adminA]); }
  });
  await expectErr('signed out: my_context → MRS_AUTH_REQUIRED (unchanged)', () => rpc('anon', null, `SELECT public.my_context() r`), /MRS_AUTH_REQUIRED|permission denied/);
  await check('deactivated admin membership: MFA no longer required', async () => {
    await q(`UPDATE public.memberships SET is_active = false WHERE user_id = $1`, [U.pendingUser]);
    try { const c = await rpc('pendingUser', 'aal1', `SELECT public.my_context() r`); return (c.mfa.required === false && c.mfa.satisfied === true) || J(c.mfa); }
    finally { await q(`UPDATE public.memberships SET is_active = true WHERE user_id = $1`, [U.pendingUser]); }
  });
}

async function secFail() {
  section('8. app.fail rewrite');
  await expectErr('owner session (no claims): app.fail(MRS_FORBIDDEN) unchanged', () => q(`SELECT app.fail('MRS_FORBIDDEN', 'x')`), /^MRS_FORBIDDEN x/);
  // 20261113000100: a public_track miss is the value {"not_found": true} (failed guesses are rate-counted); only an
  // MFA-pending admin still gets the app.fail rewrite (below)
  await check('service role: public_track miss → {"not_found": true} (20261113000100), no MFA rewrite', async () => {
    const r = (await asRole('service', null, () => q(`SELECT public.public_track('MRS-2026-000001', repeat('0', 64)) r`)))[0].r;
    return J(r) === '{"not_found":true}' || J(r);
  });
  await check('anon: public_track miss → {"not_found": true} (20261113000100)', async () => {
    const r = await rpc('anon', null, `SELECT public.public_track('MRS-2026-000001', repeat('0', 64)) r`);
    return J(r) === '{"not_found":true}' || J(r);
  });
  await expectErr('pending admin aal1: MRS_NOT_FOUND → MRS_MFA_REQUIRED', () =>
    as('pendingUser', 'aal1', `SELECT app.fail('MRS_NOT_FOUND')`), MFA_RE);
  await expectErr('pending admin aal1: public_track not found → MRS_MFA_REQUIRED', () =>
    rpc('pendingUser', 'aal1', `SELECT public.public_track('MRS-2026-000001', repeat('0', 64)) r`), MFA_RE);
  await expectErr('pending admin aal1: other codes untouched (MRS_INVALID)', () => as('pendingUser', 'aal1', `SELECT app.fail('MRS_INVALID', 'k')`), /^MRS_INVALID k/);
  await expectErr('pending admin aal2: MRS_FORBIDDEN unchanged', () => as('pendingUser', 'aal2', `SELECT app.fail('MRS_FORBIDDEN')`), /^MRS_FORBIDDEN/);
  await expectErr('staff aal1: MRS_NOT_FOUND unchanged', () => as('clrA', 'aal1', `SELECT app.fail('MRS_NOT_FOUND')`), /^MRS_NOT_FOUND/);
  await expectErr('old admin (inactive org) aal1: MRS_FORBIDDEN unchanged (MFA not required)', () => as('oldAdmin', 'aal1', `SELECT app.fail('MRS_FORBIDDEN')`), /^MRS_FORBIDDEN/);
  await check('app.mfa_pending(): adminA aal1 true, aal2 false; clrA false; anon session (no uid) false', async () => {
    const a1 = await rpc('adminA', 'aal1', `SELECT app.mfa_pending() r`);
    const a2 = await rpc('adminA', 'aal2', `SELECT app.mfa_pending() r`);
    const c = await rpc('clrA', 'aal1', `SELECT app.mfa_pending() r`);
    const o = (await one(`SELECT app.mfa_pending() r`)).r;
    return (a1 === true && a2 === false && c === false && o === false) || J({ a1, a2, c, o });
  });
}

async function secShim() {
  section('10. shim default aal');
  await check('claims with sub but no aal → app.session_aal() = aal2 (default injection for the existing suites)', async () => {
    await db.exec(`SELECT set_config('request.jwt.claims', '{"sub":"${U.adminA}","role":"authenticated"}', false)`);
    try { return (await one(`SELECT app.session_aal() r, auth.jwt() ->> 'aal' j`)).r === 'aal2'; }
    finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false)`); }
  });
  await check('marsa_test.default_aal = none → no injection → aal1', async () => {
    await db.exec(`SELECT set_config('marsa_test.default_aal', 'none', false); SELECT set_config('request.jwt.claims', '{"sub":"${U.adminA}","role":"authenticated"}', false)`);
    try { const r = await one(`SELECT app.session_aal() r, auth.jwt() ? 'aal' k`); return (r.r === 'aal1' && r.k === false) || J(r); }
    finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false); SELECT set_config('marsa_test.default_aal', '', false)`); }
  });
  await check('marsa_test.default_aal = aal1 → injected aal1', async () => {
    await db.exec(`SELECT set_config('marsa_test.default_aal', 'aal1', false); SELECT set_config('request.jwt.claims', '{"sub":"${U.adminA}","role":"authenticated"}', false)`);
    try { return (await one(`SELECT app.session_aal() r`)).r === 'aal1'; }
    finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false); SELECT set_config('marsa_test.default_aal', '', false)`); }
  });
  await check('explicit aal claim is never overwritten; no sub → no injection', async () => {
    await db.exec(`SELECT set_config('request.jwt.claims', '{"sub":"${U.adminA}","role":"authenticated","aal":"aal1"}', false)`);
    const a = (await one(`SELECT app.session_aal() r`)).r;
    await db.exec(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', false)`);
    const b = (await one(`SELECT auth.jwt() ? 'aal' k`)).k;
    await db.exec(`SELECT set_config('request.jwt.claims', '', false)`);
    return (a === 'aal1' && b === false) || J({ a, b });
  });
  await check('empty aal claim counts as aal1 (admin denied)', async () =>
    (await own('adminA', '', `SELECT app.session_aal() || ':' || app.has_role('${A}', ARRAY['admin'])::text r`)) === 'aal1:false');
}

// extract one CREATE OR REPLACE FUNCTION statement (up to the closing $$;) from a migration file
function extractFn(src, head) {
  const i = src.indexOf(head);
  if (i < 0) throw new Error('not found: ' + head);
  const j = src.indexOf('$$;', src.indexOf('$$', src.indexOf('AS $$', i) + 5));
  return src.slice(i, j + 3);
}
async function secDrift() {
  section('9. drift: re-pasting an older file restores the pre-MFA bodies; re-pasting MFA restores enforcement');
  const src = fs.readFileSync(path.join(MIG_DIR, '20261102000200_orgs_branches_invites.sql'), 'utf8');
  const old = ['CREATE OR REPLACE FUNCTION app.is_member(', 'CREATE OR REPLACE FUNCTION app.has_role(', 'CREATE OR REPLACE FUNCTION app.has_branch_role(',
    'CREATE OR REPLACE FUNCTION app.is_platform_admin('].map(h => extractFn(src, h)).join('\n');
  await db.exec(old);
  await check('after re-pasting the 20261102000200 helper bodies: adminA aal1 regains admin access (the documented warning)', async () =>
    (await as('adminA', 'aal1', `SELECT app.has_role($1, ARRAY['admin']) a`, [A]))[0].a === true
    && (await own('plat', 'aal1', `SELECT app.is_platform_admin() r`)) === true);
  if (!await runFile(MFA_FILE, true)) return;
  await check('after re-pasting 20261109000100_mfa.sql: enforcement back (adminA aal1 denied, aal2 allowed)', async () => {
    const a1 = (await as('adminA', 'aal1', `SELECT app.has_role($1, ARRAY['admin']) a`, [A]))[0].a;
    const a2 = (await as('adminA', 'aal2', `SELECT app.has_role($1, ARRAY['admin']) a`, [A]))[0].a;
    const e = await tryErr(() => rpc('adminA', 'aal1', `SELECT public.admin_list_members($1) r`, [A]));
    const p1 = await own('plat', 'aal1', `SELECT app.is_platform_admin() r`);
    return (a1 === false && a2 === true && p1 === false && MFA_RE.test(e)) || J({ a1, a2, p1, e });
  });
}

const FPB = 'b7'.repeat(32);
async function secReviewFixes() {
  section('11. review fixes: import staging creator branch, self-invitation guard');
  // import staging: adminA (admin-only member of A) creates a draft batch at aal2
  const bid = (await as('adminA', 'aal2', `INSERT INTO public.import_batches (org_id, file_name, file_fingerprint, created_by)
                                            VALUES ($1, 'mfa.xlsx', $2, $3) RETURNING id`, [A, FPB, U.adminA]))[0].id;
  await q(`INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ($1, 'Sheet1', 2, '{"m":1}')`, [bid]);
  try {
    for (const [an, aal] of AALS) {
      await check(`${an}: adminA (creator) sees 0 import_batches / import_rows of its batch; can_read/can_edit false`, async () => {
        const b = await cnt('adminA', aal, `SELECT count(*) n FROM public.import_batches WHERE id = $1`, [bid]);
        const r = await cnt('adminA', aal, `SELECT count(*) n FROM public.import_rows WHERE batch_id = $1`, [bid]);
        const h = (await as('adminA', aal, `SELECT app.can_read_batch($1) cr, app.can_edit_batch($1) ce`, [bid]))[0];
        return (b === 0 && r === 0 && h.cr === false && h.ce === false) || J({ b, r, h });
      });
      await check(`${an}: adminA UPDATE of its batch touches 0 rows; INSERT of an import row is refused`, async () => {
        const u = await as('adminA', aal, `UPDATE public.import_batches SET file_name = 'x.xlsx' WHERE id = $1 RETURNING id`, [bid]).then(x => x.length, e => 'err:' + errText(e));
        const i = await tryErr(() => as('adminA', aal, `INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw) VALUES ($1, 'Sheet1', 3, '{}')`, [bid]));
        const name = (await one(`SELECT file_name f FROM public.import_batches WHERE id = $1`, [bid])).f;
        return ((u === 0 || /row-level security|permission/.test(String(u))) && /row-level security|permission|MRS_MFA_REQUIRED/.test(i) && name === 'mfa.xlsx') || J({ u, i, name });
      });
    }
    await check('aal2: adminA sees and edits its batch (unchanged)', async () => {
      const b = await cnt('adminA', 'aal2', `SELECT count(*) n FROM public.import_batches WHERE id = $1`, [bid]);
      const r = await cnt('adminA', 'aal2', `SELECT count(*) n FROM public.import_rows WHERE batch_id = $1`, [bid]);
      const h = (await as('adminA', 'aal2', `SELECT app.can_read_batch($1) cr, app.can_edit_batch($1) ce`, [bid]))[0];
      return (b === 1 && r === 1 && h.cr && h.ce) || J({ b, r, h });
    });
    await check('staff creator (clrA) at aal1: own batch readable + editable (unaffected)', async () => {
      const id2 = (await as('clrA', 'aal1', `INSERT INTO public.import_batches (org_id, file_name, file_fingerprint, created_by)
                                             VALUES ($1, 'clr.xlsx', $2, $3) RETURNING id`, [A, 'b8'.repeat(32), U.clrA]))[0].id;
      try {
        const h = (await as('clrA', 'aal1', `SELECT app.can_read_batch($1) cr, app.can_edit_batch($1) ce`, [id2]))[0];
        return (h.cr && h.ce) || J(h);
      } finally { await q(`DELETE FROM public.import_batches WHERE id = $1`, [id2]); }
    });
  } finally {
    await q(`DELETE FROM public.import_rows WHERE batch_id = $1`, [bid]);
    await q(`DELETE FROM public.import_batches WHERE id = $1`, [bid]);
  }

  // self-invitation: selfInv (org A admin, no factor) invites its own e-mail as clearance_staff at aal2
  const inv = await rpc('selfInv', 'aal2', `SELECT public.admin_invite($1, $2) r`,
    [A, { email: EMAIL('selfInv'), role: 'clearance_staff', branch_id: JED }]);
  const tok = inv && inv.token;
  await check('aal2: admin_invite to own e-mail returns a token', () => !!tok || J(inv));
  if (!tok) return;
  for (const [an, aal] of AALS) {
    await expectErr(`${an}: accept_invitation of own self-invitation → MRS_MFA_REQUIRED (no membership created)`, () =>
      rpc('selfInv', aal, `SELECT public.accept_invitation($1) r`, [tok]), MFA_RE);
  }
  await check('aal1 / missing aal: still only the admin row, invitation not accepted', async () => {
    const n = await num(`SELECT count(*) n FROM public.memberships WHERE user_id = $1`, [U.selfInv]);
    const a = (await one(`SELECT accepted_at FROM public.invitations WHERE token_hash = app.hash_token($1)`, [tok])).accepted_at;
    return (n === 1 && a === null) || J({ n, a });
  });
  await check('aal2: accept_invitation of own self-invitation succeeds (admin-issued, unchanged)', async () => {
    const r = await rpc('selfInv', 'aal2', `SELECT public.accept_invitation($1) r`, [tok]);
    return (!!r && r.role === 'clearance_staff' && !!r.membership_id) || J(r);
  });
}

/* ================================================================== main */
async function dbMain() {
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  section('load shim + migrations (MFA held back) + seed');
  const files = fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!files.includes(MFA_MIGRATION)) { fail('MFA migration present', MFA_MIGRATION + ' not found'); return; }
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return;
  for (const f of files.filter(f => f < MFA_MIGRATION)) if (!await runFile(path.join(MIG_DIR, f), QUIET)) return;
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return;
  C0 = await catalog();
  if (!await runFile(MFA_FILE)) return;
  C1M = await catalog();
  for (const f of files.filter(f => f > MFA_MIGRATION)) if (!await runFile(path.join(MIG_DIR, f), QUIET)) return;
  try { await fixtures(); pass('fixtures: adminA, plat, both, clrA, mixed, same, clientA, optUser, pendingUser, oldAdmin, clrM, selfInv'); }
  catch (e) { fail('fixtures', errText(e)); return; }
  const secs = [secCatalog, secPreflight, secOrgAdmin, secPlatform, secStaff, secMixed, secContext, secFail, secShim, secDrift, secReviewFixes];
  for (const s of secs) {
    try { await s(); } catch (e) { fail(s.name, errText(e)); }
  }
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

dbMain().then(finish).catch(e => { console.error(e); process.exit(1); });
