#!/usr/bin/env node
/*
  Marsa (مرسى) — migration 20261215000100_team_tiers.sql (owner, 25 Nov 2026: three sign-in tiers — the office owner,
  management, employees — with separated permissions).
  LOCAL TESTS ONLY. PGlite with supabase/tests/shim.sql, no network.

  Covers: file conventions + all_migrations.sql; preflight + re-run; the backfill (an org with one admin gets its owner,
  orgs with 2+ admins stay on the legacy fallback); app.set_org_owner (SQL Editor only); the owner invites admins, a
  non-owner admin gets MRS_FORBIDDEN owner_only but still invites / deactivates employees; the owner row is never
  deactivated (MRS_FORBIDDEN owner); a non-owner admin cannot touch another admin (members, invitations); an admin
  invitation stays valid only while its inviter is the owner; owner_transfer rules; the legacy fallback (no owner row);
  the auto-owner trigger (platform_create_org + accept) and the flag cleared on deactivation; the inactive-owner case
  (fallback looks for an ACTIVE owner); owner_transfer only for a flagged owner (never under the fallback); a non-owner
  admin's admin invitation dies once app.set_org_owner runs; branch_manager / supervisor powers unchanged;
  my_context / admin_list_members expose is_owner; table rules (CHECK + one owner per org).

  usage:
    node supabase/tests/team-tiers-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const MIG = '20261215000100_team_tiers.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }
globalThis.fetch = async () => { throw new Error('network forbidden in team-tiers-tests'); };

const A = '7ea30000-0000-4000-8000-0000000000a1';   // two admins → set_org_owner names the owner
const S = '7ea30000-0000-4000-8000-0000000000b2';   // one admin → backfilled owner
const L = '7ea30000-0000-4000-8000-0000000000c3';   // two admins, no owner → legacy fallback
const U = {
  plat:    '7ea3aaaa-0000-4000-8000-0000000000f0',  // platform admin, member of no office
  ownerA:  '7ea3aaaa-0000-4000-8000-0000000000f1',
  admin2A: '7ea3aaaa-0000-4000-8000-0000000000f2',
  admin3A: '7ea3aaaa-0000-4000-8000-0000000000f3',
  staffA:  '7ea3aaaa-0000-4000-8000-0000000000f4',  // accountant
  newadm:  '7ea3aaaa-0000-4000-8000-0000000000f5',  // invited as admin of A
  newemp:  '7ea3aaaa-0000-4000-8000-0000000000f6',  // invited as clearance_staff of A
  soloS:   '7ea3aaaa-0000-4000-8000-0000000000f7',
  l1:      '7ea3aaaa-0000-4000-8000-0000000000f8',
  l2:      '7ea3aaaa-0000-4000-8000-0000000000f9',
  first:   '7ea3aaaa-0000-4000-8000-0000000000fa',  // first admin of an org made by platform_create_org
  second:  '7ea3aaaa-0000-4000-8000-0000000000fb',  // second admin of that org
  bm:      '7ea3aaaa-0000-4000-8000-0000000000fc',  // branch_manager of A / branch B1
  bstaff:  '7ea3aaaa-0000-4000-8000-0000000000fd',  // clearance_staff of A / B1
  ostaff:  '7ea3aaaa-0000-4000-8000-0000000000fe',  // clearance_staff of A / B2 (another branch)
  sup:     '7ea3aaaa-0000-4000-8000-0000000000ff',  // supervisor of A (org-wide)
  ladm:    '7ea3aaaa-0000-4000-8000-0000000000e1',  // invited as admin of L by a legacy (non-owner) admin
  bmemp:   '7ea3aaaa-0000-4000-8000-0000000000e2'   // invited by the branch manager
};
const B1 = '7ea3bbbb-0000-4000-8000-0000000000b1';
const B2 = '7ea3bbbb-0000-4000-8000-0000000000b2';
const EMAIL = k => k.toLowerCase() + '@tiers.example.com';

let db;
async function asRole(who, fn) {
  if (who === 'anon') await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  else if (who === 'service') await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  else {
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[who], role: 'authenticated', aal: 'aal1' })]);
    await db.exec(`SET ROLE authenticated;`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const one = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
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
// loaded BEFORE this migration (the data the backfill finds on a live DB)
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ${Object.keys(U).map(k => `('${U[k]}', '${EMAIL(k)}', now())`).join(', ')};
  INSERT INTO public.profiles (id, full_name) VALUES ${Object.keys(U).map(k => `('${U[k]}', '${k}')`).join(', ')}
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.platform_admins (user_id) VALUES ('${U.plat}');
  INSERT INTO public.organizations (id, slug, name_ar, ref_prefix, environment) VALUES
    ('${A}', 'tiers-a', 'مكتب أ', 'TRA', 'staging'), ('${S}', 'tiers-s', 'مكتب س', 'TRS', 'staging'),
    ('${L}', 'tiers-l', 'مكتب ل', 'TRL', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.ownerA}', '${A}', NULL, 'admin'), ('${U.admin2A}', '${A}', NULL, 'admin'), ('${U.admin3A}', '${A}', NULL, 'admin'),
    ('${U.staffA}', '${A}', NULL, 'accountant'), ('${U.soloS}', '${S}', NULL, 'admin'),
    ('${U.l1}', '${L}', NULL, 'admin'), ('${U.l2}', '${L}', NULL, 'admin');
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B1}', '${A}', 'TB1', 'فرع ١'), ('${B2}', '${A}', 'TB2', 'فرع ٢');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.bm}', '${A}', '${B1}', 'branch_manager'), ('${U.bstaff}', '${A}', '${B1}', 'clearance_staff'),
    ('${U.ostaff}', '${A}', '${B2}', 'clearance_staff'), ('${U.sup}', '${A}', NULL, 'supervisor');
`;
const mid = (who, org) => q(`SELECT id FROM public.memberships WHERE user_id = $1 AND org_id = $2 ORDER BY created_at LIMIT 1`, [U[who], org]).then(r => r[0] && r[0].id);
const ownerOf = org => q(`SELECT user_id FROM public.memberships WHERE org_id = $1 AND is_owner`, [org]).then(r => r.map(x => Object.keys(U).find(k => U[k] === x.user_id)));
const invite = (who, org, email, role) => one(who, `SELECT public.admin_invite($1, $2) r`, [org, { email, role }]);
const setActive = (who, m, v) => one(who, `SELECT public.admin_set_member_active($1, $2) r`, [m, v]);
const transfer = (who, org, m) => one(who, `SELECT public.owner_transfer($1, $2) r`, [org, m]);
const accept = (who, token) => one(who, `SELECT public.accept_invitation($1) r`, [token]);
const members = (who, org) => one(who, `SELECT public.admin_list_members($1) r`, [org]);
const ctxMember = async (who, org) => ((await one(who, `SELECT public.my_context() r`)).memberships || []).find(m => m.org_id === org);
const byUser = (list, who) => (list || []).find(x => x.user_id === U[who]);

/* ------------------------------------------------------------------ 1. the file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('preflight on org_ai_keys, its schema_versions row, no BEGIN / COMMIT, a down-path in the header', () =>
    (/version = '20261214000100'/.test(s) && /VALUES \('20261215000100', 'team_tiers'\)/.test(s) && /TEAM TIERS preflight/.test(s)
      && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s) && /Down-path:/.test(s) && /No BEGIN\/COMMIT/.test(s)) || 'conventions');
  await check('all_migrations.sql: this file verbatim, in order, with its live-DB note', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    return (i > 0 && (body === s || body + '\n' === s) && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles())) || 'bundle';
  });
  const LATER_PHASES = [];
  await check('only the known later migrations follow this file', () => {
    const later = migFiles().filter(f => f > MIG);
    return later.every(f => LATER_PHASES.includes(f)) || 'unexpected later files: ' + later.join(', ');
  });
  await check('header: li_is_owner / daftra_is_owner (import, Daftra, mfa_off) unchanged on purpose; owner_transfer without fallback', () =>
    (/app\.li_is_owner/.test(s) && /app\.daftra_is_owner/.test(s) && /mfa_off gate/.test(s) && /ANY active org-wide admin/.test(s)
      && /legacy fallback does NOT apply/.test(s)) || 'header');
  await check('owner_transfer never calls app.is_org_owner (flagged owner only, twice: before and under the locks)', () => {
    const b = s.slice(s.indexOf('FUNCTION public.owner_transfer'), s.indexOf('-- 5. app.set_org_owner'));
    return (!/is_org_owner/.test(b) && (b.match(/m\.is_owner AND m\.is_active/g) || []).length === 2) || 'owner_transfer body';
  });
  await check('public functions: SECURITY DEFINER + search_path, auth.uid() first, grants to authenticated only', () =>
    (/FUNCTION public\.owner_transfer\(p_org uuid, p_membership uuid\) RETURNS jsonb\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/.test(s)
      && /BEGIN\n  IF auth\.uid\(\) IS NULL THEN PERFORM app\.fail\('MRS_AUTH_REQUIRED'\); END IF;\n  IF p_org IS NULL OR NOT app\.has_branch_role\(p_org, NULL, ARRAY\['admin'\]\)/.test(s)
      && /REVOKE ALL ON FUNCTION app\.set_org_owner\(uuid, text\) FROM PUBLIC, anon, authenticated, service_role;/.test(s)
      && /public\.owner_transfer\(uuid, uuid\)\nTO authenticated;/.test(s)) || 'function rules');
}

async function secPreflight() {
  section('2. preflight + re-run');
  const d = await freshDb(MIG);
  try {
    await check('refused without org_ai_keys (schema_versions row removed)', async () => {
      await d.query(`DELETE FROM public.schema_versions WHERE version = '20261214000100'`);
      let r = 'ok'; try { await d.exec(fs.readFileSync(MIG_FILE, 'utf8')); } catch (e) { r = e.message; }
      await d.query(`INSERT INTO public.schema_versions (version, name) VALUES ('20261214000100', 'org_ai_keys')`);
      return /TEAM TIERS preflight: apply org_ai_keys first/.test(r) || r;
    });
    await check('applies, then re-runs (one constraint, one index, one trigger, one version row)', async () => {
      await d.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      await d.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      const n = async sql => (await d.query(sql)).rows[0].n;
      const c = await n(`SELECT count(*)::int n FROM pg_constraint WHERE conname = 'memberships_owner_shape'`);
      const i = await n(`SELECT count(*)::int n FROM pg_indexes WHERE indexname = 'memberships_one_owner_idx'`);
      const t = await n(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'trg_auto_owner'`);
      const v = await n(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261215000100'`);
      return (c === 1 && i === 1 && t === 1 && v === 1) || J({ c, i, t, v });
    });
  } finally { await d.close(); }
}

/* ------------------------------------------------------------------ 3. backfill + set_org_owner */
async function secBackfill() {
  section('3. backfill, app.set_org_owner, table rules');
  await check('backfill: the one-admin org gets its owner; the 2- and 3-admin orgs have none (legacy)', async () => {
    const s = await ownerOf(S), a = await ownerOf(A), l = await ownerOf(L);
    return (J(s) === J(['soloS']) && a.length === 0 && l.length === 0) || J({ s, a, l });
  });
  await check('app.set_org_owner: not callable by authenticated / service_role / anon', async () => {
    const c = [await code(() => as('ownerA', `SELECT app.set_org_owner($1, $2)`, [A, EMAIL('ownerA')])),
      await code(() => as('service', `SELECT app.set_org_owner($1, $2)`, [A, EMAIL('ownerA')])),
      await code(() => as('anon', `SELECT app.set_org_owner($1, $2)`, [A, EMAIL('ownerA')]))];
    const p = (await q(`SELECT has_function_privilege('authenticated', 'app.set_org_owner(uuid, text)', 'EXECUTE') a,
                               has_function_privilege('service_role', 'app.set_org_owner(uuid, text)', 'EXECUTE') s`))[0];
    return (c.every(x => x === 'perm') && p.a === false && p.s === false) || J({ c, p });
  });
  await check('no owner yet (A, legacy): owner_transfer refused for every admin (owner_only), nothing moves', async () => {
    const c = [await code(async () => transfer('ownerA', A, await mid('admin2A', A))),
      await code(async () => transfer('admin2A', A, await mid('ownerA', A))),
      await code(async () => transfer('admin3A', A, await mid('admin2A', A)))];
    return (c.every(x => x === 'MRS_FORBIDDEN owner_only') && (await ownerOf(A)).length === 0) || J(c);
  });
  await check('app.set_org_owner (SQL Editor): names the owner, moves it, refuses a non-admin / unknown e-mail', async () => {
    await q(`SELECT app.set_org_owner($1, $2)`, [A, EMAIL('admin2A')]);
    const o1 = await ownerOf(A);
    await q(`SELECT app.set_org_owner($1, $2)`, [A, ' ' + EMAIL('ownerA').toUpperCase() + ' ']);
    const o2 = await ownerOf(A);
    const c1 = await code(() => q(`SELECT app.set_org_owner($1, $2)`, [A, EMAIL('staffA')]));
    const c2 = await code(() => q(`SELECT app.set_org_owner($1, $2)`, [A, 'nobody@tiers.example.com']));
    return (J(o1) === J(['admin2A']) && J(o2) === J(['ownerA']) && /MRS_NOT_FOUND/.test(c1) && /MRS_NOT_FOUND/.test(c2)) || J({ o1, o2, c1, c2 });
  });
  await check('table rules: an owner row is an org-wide admin row (CHECK); one owner per org (unique index)', async () => {
    const c1 = await code(() => q(`UPDATE public.memberships SET is_owner = true WHERE user_id = $1 AND org_id = $2`, [U.staffA, A]));
    const c2 = await code(() => q(`UPDATE public.memberships SET is_owner = true WHERE user_id = $1 AND org_id = $2`, [U.admin2A, A]));
    return (/memberships_owner_shape|check constraint/.test(c1) && /memberships_one_owner_idx|duplicate key/.test(c2)) || J({ c1, c2 });
  });
  await check('app helpers are not callable by authenticated (is_org_owner, uid_is_org_owner, the trigger function)', async () => {
    const r = (await q(`SELECT has_function_privilege('authenticated', 'app.is_org_owner(uuid)', 'EXECUTE') a,
                               has_function_privilege('authenticated', 'app.uid_is_org_owner(uuid, uuid)', 'EXECUTE') b,
                               has_function_privilege('authenticated', 'app.tg_membership_auto_owner()', 'EXECUTE') c`))[0];
    return (!r.a && !r.b && !r.c) || J(r);
  });
}

/* ------------------------------------------------------------------ 4. owner vs admin */
let tokNewAdm, tokNewEmp;
async function secPowers() {
  section('4. owner / non-owner admin powers');
  await check('the owner invites an admin', async () => {
    const r = await invite('ownerA', A, EMAIL('newadm'), 'admin');
    tokNewAdm = r.token;
    return (r.role === 'admin' && /^[0-9a-f]{64}$/.test(r.token)) || J(r);
  });
  await check('a non-owner admin inviting an admin → MRS_FORBIDDEN owner_only', async () => {
    const c = await code(() => invite('admin2A', A, 'other-admin@tiers.example.com', 'admin'));
    return c === 'MRS_FORBIDDEN owner_only' || c;
  });
  await check('a non-owner admin invites employees (accountant, clearance_staff) and portal-free roles', async () => {
    const r1 = await invite('admin2A', A, EMAIL('newemp'), 'clearance_staff');
    tokNewEmp = r1.token;
    const r2 = await invite('admin2A', A, 'ops@tiers.example.com', 'operations_manager');
    return (r1.role === 'clearance_staff' && r2.role === 'operations_manager') || J({ r1, r2 });
  });
  await check('a non-owner admin deactivates / reactivates an employee', async () => {
    const m = await mid('staffA', A);
    const off = await setActive('admin2A', m, false);
    const on = await setActive('admin2A', m, true);
    return (off.is_active === false && on.is_active === true) || J({ off, on });
  });
  await check('a non-owner admin cannot deactivate another admin (MRS_NOT_FOUND) nor the owner (MRS_FORBIDDEN owner)', async () => {
    const c2 = await code(async () => setActive('admin2A', await mid('admin3A', A), false));
    const c3 = await code(async () => setActive('admin2A', await mid('ownerA', A), false));
    return (c2 === 'MRS_NOT_FOUND' && c3 === 'MRS_FORBIDDEN owner') || J({ c2, c3 });
  });
  await check('the owner row cannot be deactivated, not even by the owner (MRS_FORBIDDEN owner)', async () => {
    const c = await code(async () => setActive('ownerA', await mid('ownerA', A), false));
    return c === 'MRS_FORBIDDEN owner' || c;
  });
  await check('a non-owner admin cannot reactivate an inactive admin (MRS_NOT_FOUND); the owner can', async () => {
    const m = await mid('admin3A', A);
    await setActive('ownerA', m, false);
    const c = await code(() => setActive('admin2A', m, true));
    const still = (await q(`SELECT is_active FROM public.memberships WHERE id = $1`, [m]))[0].is_active;
    const on = await setActive('ownerA', m, true);
    return (c === 'MRS_NOT_FOUND' && still === false && on.is_active === true) || J({ c, still, on });
  });
  await check('the owner deactivates / reactivates another admin', async () => {
    const m = await mid('admin3A', A);
    const off = await setActive('ownerA', m, false);
    const on = await setActive('ownerA', m, true);
    return (off.is_active === false && on.is_active === true) || J({ off, on });
  });
  await check('admin invitations: a non-owner admin cannot revoke / reissue them (MRS_NOT_FOUND); employee ones it can', async () => {
    const inv = (await q(`SELECT id, role FROM public.invitations WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [A]));
    const adm = inv.find(i => i.role === 'admin'), ops = inv.find(i => i.role === 'operations_manager');
    const c1 = await code(() => as('admin2A', `SELECT public.admin_revoke_invitation($1)`, [adm.id]));
    const c2 = await code(() => as('admin2A', `SELECT public.admin_reissue_invitation($1)`, [adm.id]));
    const c3 = await code(() => as('admin2A', `SELECT public.admin_revoke_invitation($1)`, [ops.id]));
    return (c1 === 'MRS_NOT_FOUND' && c2 === 'MRS_NOT_FOUND' && c3 === 'ok') || J({ c1, c2, c3 });
  });
  await check('admin_list_members (non-owner admin): every row, is_owner on the owner row, can_manage only on employees', async () => {
    const l = await members('admin2A', A);
    const o = byUser(l, 'ownerA'), a3 = byUser(l, 'admin3A'), st = byUser(l, 'staffA'), me = byUser(l, 'admin2A');
    return (l.length === 8 && o.is_owner === true && o.can_manage === false && a3.is_owner === false && a3.can_manage === false
      && st.can_manage === true && me.is_me === true && me.can_manage === false && l[0].user_id === U.ownerA) || J(l);
  });
  await check('admin_list_members (owner): can_manage on the other admins, never on its own row', async () => {
    const l = await members('ownerA', A);
    return (byUser(l, 'admin2A').can_manage === true && byUser(l, 'admin3A').can_manage === true && byUser(l, 'ownerA').can_manage === false
      && byUser(l, 'ownerA').is_owner === true) || J(l);
  });
  await check('my_context: is_owner true for the owner, false for a non-owner admin and for an employee', async () => {
    const o = await ctxMember('ownerA', A), a = await ctxMember('admin2A', A), s = await ctxMember('staffA', A);
    return (o.is_owner === true && a.is_owner === false && s.is_owner === false && 'mfa_locked' in o && 'org_logo_path' in o) || J({ o, a, s });
  });
}

/* ------------------------------------------------------------------ 5. owner_transfer + invitation validity */
async function secTransfer() {
  section('5. owner_transfer; an admin invitation needs an owner inviter');
  await check('owner_transfer refused: non-owner (owner_only), anon (perm), self, an employee / another org (target / not found)', async () => {
    const c = [
      await code(async () => transfer('admin2A', A, await mid('admin3A', A))),
      await code(async () => transfer('anon', A, await mid('admin3A', A))),
      await code(async () => transfer('ownerA', A, await mid('ownerA', A))),
      await code(async () => transfer('ownerA', A, await mid('staffA', A))),
      await code(async () => transfer('ownerA', A, await mid('soloS', S))),
      await code(async () => transfer('staffA', A, await mid('admin2A', A)))];
    return J(c) === J(['MRS_FORBIDDEN owner_only', 'perm', 'MRS_INVALID self', 'MRS_INVALID target', 'MRS_NOT_FOUND', 'MRS_FORBIDDEN owner_only']) || J(c);
  });
  await check('owner_transfer refused for an inactive admin (target)', async () => {
    const m = await mid('admin3A', A);
    await setActive('ownerA', m, false);
    const c = await code(() => transfer('ownerA', A, m));
    await setActive('ownerA', m, true);
    return c === 'MRS_INVALID target' || c;
  });
  await check('the owner\'s pending admin invitation stops working once the ownership moves (accept → MRS_NOT_FOUND)', async () => {
    const r = await transfer('ownerA', A, await mid('admin2A', A));
    const o = await ownerOf(A);
    const c = await code(() => accept('newadm', tokNewAdm));
    const audit = await q(`SELECT new_data FROM public.audit_log WHERE org_id = $1 AND table_name = 'memberships' AND new_data ->> 'owner_transfer' = 'true'`, [A]);
    return (r.owner_user_id === U.admin2A && J(o) === J(['admin2A']) && c === 'MRS_NOT_FOUND' && audit.length === 1) || J({ r, o, c, audit });
  });
  await check('after the transfer: the old owner is a plain admin (owner_only), the new one invites admins', async () => {
    const c = await code(() => invite('ownerA', A, 'x-admin@tiers.example.com', 'admin'));
    const r = await invite('admin2A', A, 'y-admin@tiers.example.com', 'admin');
    const ctx = await ctxMember('ownerA', A);
    return (c === 'MRS_FORBIDDEN owner_only' && r.role === 'admin' && ctx.is_owner === false) || J({ c, r, ctx });
  });
  await check('the ownership moves back; the original admin invitation is valid again and accepts (the invitee is not owner)', async () => {
    await transfer('admin2A', A, await mid('ownerA', A));
    const r = await accept('newadm', tokNewAdm);
    const m = (await q(`SELECT is_owner, role FROM public.memberships WHERE id = $1`, [r.membership_id]))[0];
    return (r.role === 'admin' && m.is_owner === false && J(await ownerOf(A)) === J(['ownerA'])) || J({ r, m });
  });
  await check('an employee invitation of a non-owner admin stays valid (accept ok, not the owner)', async () => {
    const r = await accept('newemp', tokNewEmp);
    const m = (await q(`SELECT is_owner, role FROM public.memberships WHERE id = $1`, [r.membership_id]))[0];
    return (r.role === 'clearance_staff' && m.is_owner === false) || J({ r, m });
  });
}

/* ------------------------------------------------------------------ 6. legacy fallback */
async function secLegacy() {
  section('6. legacy fallback: an org without an owner row');
  await check('no owner row: every org-wide admin acts as the owner (invites an admin, deactivates another admin)', async () => {
    const r = await invite('l1', L, 'l-admin@tiers.example.com', 'admin');
    const m = await mid('l2', L);
    const off = await setActive('l1', m, false);
    const on = await setActive('l1', m, true);
    return (r.role === 'admin' && off.is_active === false && on.is_active === true && (await ownerOf(L)).length === 0) || J({ r, off, on });
  });
  await check('no owner row: my_context is_owner true for each admin; admin_list_members is_owner false on every row', async () => {
    const a = await ctxMember('l1', L), b = await ctxMember('l2', L);
    const l = await members('l1', L);
    return (a.is_owner === true && b.is_owner === true && l.every(x => x.is_owner === false)) || J({ a, b, l });
  });
  await check('no owner row: owner_transfer refused for every admin (owner_only), the org keeps no owner', async () => {
    const c = [await code(async () => transfer('l1', L, await mid('l2', L))),
      await code(async () => transfer('l2', L, await mid('l1', L)))];
    return (c.every(x => x === 'MRS_FORBIDDEN owner_only') && (await ownerOf(L)).length === 0) || J(c);
  });
  await check('a legacy admin\'s pending admin invitation stops working once app.set_org_owner names another owner', async () => {
    const r = await invite('l1', L, EMAIL('ladm'), 'admin');
    await q(`SELECT app.set_org_owner($1, $2)`, [L, EMAIL('l2')]);
    const c = await code(() => accept('ladm', r.token));
    const n = (await q(`SELECT count(*)::int n FROM public.memberships WHERE user_id = $1`, [U.ladm]))[0].n;
    return (c === 'MRS_NOT_FOUND' && n === 0 && J(await ownerOf(L)) === J(['l2'])) || J({ c, n });
  });
  await check('after set_org_owner: the fallback ends for l1 (owner_only, is_owner false); the owner l2 may transfer', async () => {
    const c = await code(() => invite('l1', L, 'l-admin2@tiers.example.com', 'admin'));
    const a = await ctxMember('l1', L);
    const r = await transfer('l2', L, await mid('l1', L));
    const back = await transfer('l1', L, await mid('l2', L));
    return (c === 'MRS_FORBIDDEN owner_only' && a.is_owner === false && r.owner_user_id === U.l1
      && back.owner_user_id === U.l2 && J(await ownerOf(L)) === J(['l2'])) || J({ c, a, r, back });
  });
  await check('the backfilled one-admin org: its owner invites an admin', async () => {
    const r = await invite('soloS', S, 's-admin@tiers.example.com', 'admin');
    return r.role === 'admin' || J(r);
  });
}

/* ------------------------------------------------------------------ 6b. management below the admins */
async function secManagement() {
  section('6b. branch_manager / supervisor: today\'s powers, never the admins');
  await check('branch_manager: admin_list_members = its own row + bm_managed_roles of its branch; no admin / owner row', async () => {
    const l = await members('bm', A);
    const who = l.map(x => Object.keys(U).find(k => U[k] === x.user_id)).sort();
    return (J(who) === J(['bm', 'bstaff']) && l.every(x => x.role !== 'admin' && x.is_owner === false)
      && byUser(l, 'bstaff').can_manage === true && byUser(l, 'bm').can_manage === false) || J(l);
  });
  await check('branch_manager: deactivates / reactivates staff of its branch; another branch, the admins and the owner → MRS_NOT_FOUND', async () => {
    const m = await mid('bstaff', A);
    const off = await setActive('bm', m, false), on = await setActive('bm', m, true);
    const c = [await code(async () => setActive('bm', await mid('ostaff', A), false)),
      await code(async () => setActive('bm', await mid('admin3A', A), false)),
      await code(async () => setActive('bm', await mid('ownerA', A), false)),
      await code(async () => setActive('bm', await mid('sup', A), false))];
    return (off.is_active === false && on.is_active === true && c.every(x => x === 'MRS_NOT_FOUND')) || J({ off, on, c });
  });
  await check('branch_manager: invites bm_managed_roles in its branch only; admin / supervisor / other branch refused', async () => {
    const r = await one('bm', `SELECT public.admin_invite($1, $2) r`, [A, { email: EMAIL('bmemp'), role: 'accountant', branch_id: B1 }]);
    const c = [await code(() => invite('bm', A, 'bm-admin@tiers.example.com', 'admin')),
      await code(() => one('bm', `SELECT public.admin_invite($1, $2) r`, [A, { email: 'bm-sup@tiers.example.com', role: 'supervisor', branch_id: B1 }])),
      await code(() => one('bm', `SELECT public.admin_invite($1, $2) r`, [A, { email: 'bm-o@tiers.example.com', role: 'accountant', branch_id: B2 }]))];
    return (r.role === 'accountant' && J(c) === J(['MRS_FORBIDDEN role', 'MRS_FORBIDDEN role', 'MRS_FORBIDDEN branch'])) || J({ r, c });
  });
  await check('branch_manager: owner_transfer refused (owner_only); my_context is_owner false', async () => {
    const c = await code(async () => transfer('bm', A, await mid('admin3A', A)));
    const x = await ctxMember('bm', A);
    return (c === 'MRS_FORBIDDEN owner_only' && x.is_owner === false) || J({ c, x });
  });
  await check('supervisor: admin_list_members / admin_invite → MRS_FORBIDDEN, set_member_active → MRS_NOT_FOUND, owner_transfer → owner_only', async () => {
    const c = [await code(() => members('sup', A)),
      await code(() => invite('sup', A, 'sup-emp@tiers.example.com', 'clearance_staff')),
      await code(async () => setActive('sup', await mid('staffA', A), false)),
      await code(async () => transfer('sup', A, await mid('admin3A', A)))];
    return J(c) === J(['MRS_FORBIDDEN', 'MRS_FORBIDDEN', 'MRS_NOT_FOUND', 'MRS_FORBIDDEN owner_only']) || J(c);
  });
}

/* ------------------------------------------------------------------ 6c. inactive owner */
async function secInactiveOwner() {
  section('6c. an inactive owner: the flag is cleared, the fallback looks for an ACTIVE owner');
  const Y = '7ea30000-0000-4000-8000-0000000000e5';
  await q(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix, environment) VALUES ($1, 'tiers-y', 'مكتب ي', 'TRY', 'staging')`, [Y]);
  await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'admin')`, [U.l1, Y]);
  await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'admin')`, [U.l2, Y]);
  await check('setup: the first admin of Y is the owner (trigger), the second is not', async () => J(await ownerOf(Y)) === J(['l1']) || J(await ownerOf(Y)));
  await check('trigger: deactivating the owner row (SQL Editor) clears the flag; reactivating it with another admin active does not restore it', async () => {
    const m = await mid('l1', Y);
    await q(`UPDATE public.memberships SET is_active = false WHERE id = $1`, [m]);
    const f1 = (await q(`SELECT is_owner FROM public.memberships WHERE id = $1`, [m]))[0].is_owner;
    await q(`UPDATE public.memberships SET is_active = true WHERE id = $1`, [m]);
    const f2 = (await q(`SELECT is_owner FROM public.memberships WHERE id = $1`, [m]))[0].is_owner;
    return (f1 === false && f2 === false && (await ownerOf(Y)).length === 0) || J({ f1, f2 });
  });
  await check('trigger: an INSERT of an inactive flagged row stores is_owner false', async () => {
    const Z = '7ea30000-0000-4000-8000-0000000000e6';
    await q(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix, environment) VALUES ($1, 'tiers-z', 'مكتب ز', 'TRZ', 'staging')`, [Z]);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role, is_active, is_owner) VALUES ($1, $2, NULL, 'admin', false, true)`, [U.l1, Z]);
    return (await ownerOf(Z)).length === 0 || 'flag kept';
  });
  await check('a stale flag on an inactive row (trigger bypassed): the fallback applies, owner_transfer refused, set_org_owner repairs', async () => {
    const m1 = await mid('l1', Y), m2 = await mid('l2', Y);
    await q(`SELECT app.set_org_owner($1, $2)`, [Y, EMAIL('l1')]);
    await db.exec(`ALTER TABLE public.memberships DISABLE TRIGGER trg_auto_owner;`);
    try { await q(`UPDATE public.memberships SET is_active = false WHERE id = $1`, [m1]); }
    finally { await db.exec(`ALTER TABLE public.memberships ENABLE TRIGGER trg_auto_owner;`); }
    const stale = (await q(`SELECT is_owner, is_active FROM public.memberships WHERE id = $1`, [m1]))[0];
    const ctx = await ctxMember('l2', Y);
    const inv = await code(() => invite('l2', Y, 'y-admin@tiers.example.com', 'admin'));
    const tr = await code(() => transfer('l2', Y, m1));
    const tr1 = await code(() => transfer('l1', Y, m2));
    await q(`SELECT app.set_org_owner($1, $2)`, [Y, EMAIL('l2')]);
    const after = await ownerOf(Y);
    const ctx2 = await ctxMember('l2', Y);
    return (stale.is_owner === true && stale.is_active === false && ctx.is_owner === true && inv === 'ok'
      && tr === 'MRS_FORBIDDEN owner_only' && tr1 === 'MRS_FORBIDDEN owner_only'
      && J(after) === J(['l2']) && ctx2.is_owner === true) || J({ stale, ctx, inv, tr, tr1, after, ctx2 });
  });
  await check('re-run of the migration clears a stale flag on an inactive row', async () => {
    const m = await mid('l1', Y);
    await db.exec(`ALTER TABLE public.memberships DISABLE TRIGGER trg_auto_owner;`);
    try {
      await q(`UPDATE public.memberships SET is_owner = false WHERE org_id = $1`, [Y]);
      await q(`UPDATE public.memberships SET is_owner = true WHERE id = $1`, [m]);
    } finally { await db.exec(`ALTER TABLE public.memberships ENABLE TRIGGER trg_auto_owner;`); }
    const before = (await q(`SELECT is_owner FROM public.memberships WHERE id = $1`, [m]))[0].is_owner;
    await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
    for (const f of migFiles().filter(f => f > MIG)) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    const after = (await q(`SELECT is_owner FROM public.memberships WHERE id = $1`, [m]))[0].is_owner;
    return (before === true && after === false) || J({ before, after });
  });
}

/* ------------------------------------------------------------------ 7. auto-owner trigger */
async function secAutoOwner() {
  section('7. auto-owner: platform_create_org + accept');
  let org;
  await check('the first admin of a new office (platform_create_org → accept) becomes the owner', async () => {
    const c = await one('plat', `SELECT public.platform_create_org($1) r`, [{ slug: 'tiers-new', name_ar: 'مكتب جديد', ref_prefix: 'TRN',
      admin_email: EMAIL('first'), branch: { code: 'JED', name_ar: 'جدة' } }]);
    org = c.org_id;
    const r = await accept('first', c.token);
    const m = (await q(`SELECT is_owner FROM public.memberships WHERE id = $1`, [r.membership_id]))[0];
    const ctx = await ctxMember('first', org);
    return (m.is_owner === true && ctx.is_owner === true) || J({ c, r, m, ctx });
  });
  await check('a second admin invited by that owner is not the owner; employees never are', async () => {
    const i = await invite('first', org, EMAIL('second'), 'admin');
    const r = await accept('second', i.token);
    const m = (await q(`SELECT is_owner FROM public.memberships WHERE id = $1`, [r.membership_id]))[0];
    const ctx = await ctxMember('second', org);
    return (m.is_owner === false && ctx.is_owner === false && J(await ownerOf(org)) === J(['first'])) || J({ r, m, ctx });
  });
  await check('trigger: an org with an inactive lone admin (no owner) → reactivation flags it; an employee row never', async () => {
    const X = '7ea30000-0000-4000-8000-0000000000d4';
    await q(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix, environment) VALUES ($1, 'tiers-x', 'مكتب خ', 'TRX', 'staging')`, [X]);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'accountant')`, [U.staffA, X]);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role, is_active) VALUES ($1, $2, NULL, 'admin', false)`, [U.l1, X]);
    const before = await ownerOf(X);
    await q(`UPDATE public.memberships SET is_active = true WHERE org_id = $1 AND user_id = $2`, [X, U.l1]);
    const after = await ownerOf(X);
    return (before.length === 0 && J(after) === J(['l1'])) || J({ before, after });
  });
}

(async () => {
  await secFile();
  await secPreflight();
  db = await freshDb(MIG);
  await db.exec(FIXTURES);
  await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
  for (const f of migFiles().filter(f => f > MIG)) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await secBackfill();
  await secPowers();
  await secTransfer();
  await secLegacy();
  await secManagement();
  await secInactiveOwner();
  await secAutoOwner();
  await db.close();
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
  process.exit(nFail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
