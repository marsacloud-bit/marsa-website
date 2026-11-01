#!/usr/bin/env node
/*
  Marsa (مرسى) — G2 organizations / branches / invitations / roles test suite.  LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql
  Org A = seed "blue-sea" (branches JED, DMM). Org B is created through platform_create_org.
  Users:
    plat     platform admin (no tenant membership)
    adminA   admin of org A                bmJ     branch_manager of org A / JED
    staffJ   clearance_staff org A / JED   staffD  clearance_staff org A / DMM
    ownerB   invited admin of org B        wrong   confirmed account with another e-mail
    unconf   account whose e-mail is NOT confirmed
    newStaff / newClient / newBm           accept staff / client / branch-manager invitations
    admin2 / alt / helper / ownerC / dual  review-fix cases (second admin, alternate mailboxes,
                                           org C owner, admin of both A and B)

  Prints PASS / FAIL per case; exit code 1 on any FAIL.
  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g2-tests.js [/path/to/marsa-website] [--quiet]
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
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const CL102 = '0b5e0000-0000-4000-8000-000000000102'; // only transaction: TX2 (DMM)
const TX1 = '0b5e0000-0000-4000-8000-000000000201'; // JED, client 101
const TX2 = '0b5e0000-0000-4000-8000-000000000202'; // DMM
const TX3 = '0b5e0000-0000-4000-8000-000000000203'; // JED, 0 containers
const CT301 = '0b5e0000-0000-4000-8000-000000000301'; // TX1 (JED)
const CT303 = '0b5e0000-0000-4000-8000-000000000303'; // TX2 (DMM)

const U = {
  plat: 'cafe0000-0000-4000-8000-000000000001',
  adminA: 'cafe0000-0000-4000-8000-000000000002',
  bmJ: 'cafe0000-0000-4000-8000-000000000003',
  staffJ: 'cafe0000-0000-4000-8000-000000000004',
  staffD: 'cafe0000-0000-4000-8000-000000000005',
  ownerB: 'cafe0000-0000-4000-8000-000000000006',
  wrong: 'cafe0000-0000-4000-8000-000000000007',
  unconf: 'cafe0000-0000-4000-8000-000000000008',
  newStaff: 'cafe0000-0000-4000-8000-000000000009',
  newClient: 'cafe0000-0000-4000-8000-00000000000a',
  newBm: 'cafe0000-0000-4000-8000-00000000000b',
  admin2: 'cafe0000-0000-4000-8000-00000000000c',
  alt: 'cafe0000-0000-4000-8000-00000000000d',
  helper: 'cafe0000-0000-4000-8000-00000000000e',
  ownerC: 'cafe0000-0000-4000-8000-00000000000f',
  dual: 'cafe0000-0000-4000-8000-000000000010'
};
const EMAIL = {
  plat: 'platform@example.com', adminA: 'admin.a@example.com', bmJ: 'bm.jed@example.com',
  staffJ: 'staff.jed@example.com', staffD: 'staff.dmm@example.com', ownerB: 'owner.b@example.com',
  wrong: 'someone.else@example.com', unconf: 'unconfirmed@example.com', newStaff: 'new.staff@example.com',
  newClient: 'new.client@example.com', newBm: 'new.bm@example.com', admin2: 'admin.two@example.com',
  alt: 'alt.mailbox@example.com', helper: 'helper@example.com', ownerC: 'owner.c@example.com', dual: 'dual@example.com'
};
const KEY1 = '11111111-1111-4111-8111-111111111111';
const KEY2 = '22222222-2222-4222-8222-222222222222';
const KEY3 = '33333333-3333-4333-8333-333333333333';
const KEY4 = '44444444-4444-4444-8444-444444444444';
const KEY5 = '55555555-5555-4555-8555-555555555555';

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
// statement must be refused: an error (permission/RLS/MRS) or 0 rows
async function denied(who, sql, params) {
  try { const r = await as(who, sql, params); return r.length === 0 ? true : 'returned ' + r.length + ' row(s)'; }
  catch (e) { return /permission denied|row-level security|MRS_|violates/.test(errText(e)) ? true : 'unexpected error: ' + errText(e); }
}
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}
const count = async (sql, params) => (await q(sql, params))[0].n;

async function fixtures() {
  const users = Object.keys(U).map(k =>
    `('${U[k]}', '${EMAIL[k]}', ${k === 'unconf' ? 'NULL' : 'now()'})`).join(',\n      ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
      ${users};
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.plat}', 'test operator');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'),
      ('${U.bmJ}',    '${A}', '${JED}', 'branch_manager'),
      ('${U.staffJ}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.staffD}', '${A}', '${DMM}', 'clearance_staff');
  `);
}

/* ------------------------------------------------------------------ main */
async function main() {
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migs = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort().map(f => path.join(migDir, f));
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migs) if (!await runFile(m)) return finish();
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return finish();
  // the migrations must be re-runnable on top of themselves
  if (!await runFile(path.join(migDir, '20261102000200_orgs_branches_invites.sql'))) return finish();
  try { await fixtures(); pass('fixtures: platform admin, org A members incl. branch_manager'); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }

  /* ---------------------------------------------------------------- roles + constraints */
  section('roles and membership scope constraints');
  await check('role branch_manager has ar/en labels', async () => {
    const r = (await q(`SELECT label_ar, label_en FROM public.status_labels WHERE domain = 'role' AND code = 'branch_manager'`))[0];
    return (r && r.label_ar === 'مدير فرع' && r.label_en === 'Branch manager') || JSON.stringify(r);
  });
  await check('branch_manager is a staff / ops / transport role, not finance', async () => {
    const r = (await q(`SELECT 'branch_manager' = ANY (app.staff_roles()) s, 'branch_manager' = ANY (app.ops_writer_roles()) o,
                               'branch_manager' = ANY (app.transport_writer_roles()) t, 'branch_manager' = ANY (app.finance_roles()) f`))[0];
    return (r.s && r.o && r.t && !r.f) || JSON.stringify(r);
  });
  await expectErr('admin membership cannot be branch-scoped', () => q(
    `INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, $3, 'admin')`, [U.wrong, A, JED]), /memberships_admin_no_branch/);
  await expectErr('branch_manager membership requires a branch', () => q(
    `INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'branch_manager')`, [U.wrong, A]), /memberships_branch_manager_branch/);
  await check('seed + fixture memberships satisfy the new CHECKs', async () =>
    (await count(`SELECT count(*)::int n FROM public.memberships WHERE (role = 'admin' AND branch_id IS NOT NULL)
                                                                  OR (role = 'branch_manager' AND branch_id IS NULL)`)) === 0);

  /* ---------------------------------------------------------------- privileges */
  section('privileges');
  await check('admin_add_member is not executable by authenticated / anon', async () => {
    const r = (await q(`SELECT has_function_privilege('authenticated', 'public.admin_add_member(uuid,text,text,uuid)', 'EXECUTE') a,
                               has_function_privilege('anon', 'public.admin_add_member(uuid,text,text,uuid)', 'EXECUTE') b`))[0];
    return (!r.a && !r.b) || JSON.stringify(r);
  });
  await expectErr('adminA cannot call admin_add_member', () => as('adminA',
    `SELECT public.admin_add_member($1, $2, 'clearance_staff', NULL)`, [A, EMAIL.wrong]), /permission denied/);
  await check('anon may execute invitation_preview but no other new RPC', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE')
                          AND (p.proname LIKE 'platform_%' OR p.proname LIKE 'admin_%' OR p.proname LIKE '%invit%')`);
    const got = r.map(x => x.proname).join(',');
    return got === 'invitation_preview' || 'anon may execute: ' + got;
  });
  for (const fn of ['platform_list_orgs()', 'platform_create_org(jsonb)', 'platform_set_org_active(uuid,boolean)',
    'admin_update_org(uuid,jsonb)', 'admin_create_branch(uuid,jsonb)', 'admin_update_branch(uuid,jsonb)',
    'admin_invite(uuid,jsonb)', 'admin_list_invitations(uuid)', 'admin_revoke_invitation(uuid)',
    'admin_reissue_invitation(uuid)', 'invitation_preview(text)', 'accept_invitation(text)',
    'platform_reissue_admin_invitation(uuid)']) {
    await check(`public.${fn}: SECURITY DEFINER, search_path pinned, authenticated may execute`, async () => {
      const r = (await q(`SELECT p.prosecdef d, coalesce(array_to_string(p.proconfig, ','), '') c,
                                 has_function_privilege('authenticated', p.oid, 'EXECUTE') x
                            FROM pg_proc p WHERE p.oid = $1::regprocedure`, ['public.' + fn]))[0];
      return (r.d && /search_path=/.test(r.c) && r.x) || JSON.stringify(r);
    });
  }
  await check('new app helpers are not executable by authenticated (except the pure role list)', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND p.proname IN ('is_platform_admin','can_manage_member','can_manage_invitation',
                              'invitation_status','mask_email','only_keys','puuid','branch_fields','branch_json','create_invitation')
                          AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))`);
    return r.length === 0 || 'callable: ' + r.map(x => x.proname).join(', ');
  });
  await check('platform_admins / invitations: RLS on, no anon privilege, no direct writes', async () => {
    const r = await q(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relname IN ('platform_admins','invitations')`);
    const g = await q(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
                        WHERE table_schema = 'public' AND table_name IN ('platform_admins','invitations')
                          AND grantee IN ('anon','authenticated')`);
    const cg = await q(`SELECT DISTINCT privilege_type FROM information_schema.column_privileges
                         WHERE table_schema = 'public' AND table_name = 'invitations' AND grantee = 'authenticated'`);
    return (r.length === 2 && r.every(x => x.relrowsecurity) && g.length === 0
            && cg.length === 1 && cg[0].privilege_type === 'SELECT') || JSON.stringify({ r, g, cg });
  });
  await expectErr('nobody reads invitations.token_hash through the API', () => as('adminA',
    `SELECT token_hash FROM public.invitations`), /permission denied/);
  await check('platform_admins invisible to everyone through the API', async () =>
    (await denied('plat', `SELECT 1 FROM public.platform_admins`)) === true && (await denied('adminA', `SELECT 1 FROM public.platform_admins`)) === true);
  await expectErr('adminA cannot make itself platform admin', () => as('adminA',
    `INSERT INTO public.platform_admins (user_id) VALUES ($1)`, [U.adminA]), /permission denied|row-level security/);
  await expectErr('direct UPDATE of organizations is closed (whitelist RPC only)', () => as('adminA',
    `UPDATE public.organizations SET ref_prefix = 'ZZ' WHERE id = $1`, [A]), /permission denied/);
  await expectErr('direct INSERT of branches is closed (RPC only)', () => as('adminA',
    `INSERT INTO public.branches (org_id, code, name_ar) VALUES ($1, 'XX', 'فرع')`, [A]), /permission denied/);
  await expectErr('direct UPDATE of branches is closed (last-branch guard)', () => as('adminA',
    `UPDATE public.branches SET is_active = false WHERE org_id = $1`, [A]), /permission denied/);

  /* ---------------------------------------------------------------- platform */
  section('platform admin: create org B (idempotent)');
  const orgPayload = { slug: 'org-bravo', name_ar: 'مؤسسة برافو التجريبية', name_en: 'Bravo (staging)', ref_prefix: 'brv',
    default_locale: 'ar', branch: { code: 'ruh', name_ar: 'فرع الرياض', city: 'الرياض' }, admin_email: 'Owner.B@Example.com',
    idempotencyKey: KEY1 };
  for (const who of ['adminA', 'bmJ', 'staffD']) {
    await expectErr(`${who} refused on platform_list_orgs`, () => as(who, `SELECT public.platform_list_orgs()`), /MRS_FORBIDDEN/);
    await expectErr(`${who} refused on platform_create_org`, () => as(who, `SELECT public.platform_create_org($1)`,
      [{ ...orgPayload, slug: 'evil-' + who.toLowerCase(), idempotencyKey: KEY3 }]), /MRS_FORBIDDEN/);
    await expectErr(`${who} refused on platform_set_org_active`, () => as(who, `SELECT public.platform_set_org_active($1, false)`, [A]), /MRS_FORBIDDEN/);
  }
  await expectErr('anon cannot call platform_create_org', () => as('anon', `SELECT public.platform_create_org($1)`, [orgPayload]), /permission denied/);
  await expectErr('platform_create_org refuses unknown keys (e.g. environment)', () => as('plat',
    `SELECT public.platform_create_org($1)`, [{ ...orgPayload, environment: 'production', idempotencyKey: KEY3 }]), /MRS_INVALID.*unknown_key/);
  await expectErr('platform_create_org needs a first branch', () => as('plat',
    `SELECT public.platform_create_org($1)`, [{ ...orgPayload, branch: undefined, idempotencyKey: KEY3 }]), /MRS_REQUIRED.*branch/);
  await expectErr('platform_create_org refuses a taken slug', () => as('plat',
    `SELECT public.platform_create_org($1)`, [{ ...orgPayload, slug: 'blue-sea', idempotencyKey: KEY3 }]), /MRS_INVALID.*slug_taken/);

  let created = null;
  await check('platform admin creates org B with first branch + admin invitation', async () => {
    created = await rpc('plat', `SELECT public.platform_create_org($1) r`, [orgPayload]);
    const o = (await q(`SELECT * FROM public.organizations WHERE id = $1`, [created.org_id]))[0];
    const b = (await q(`SELECT * FROM public.branches WHERE id = $1`, [created.branch_id]))[0];
    const i = (await q(`SELECT * FROM public.invitations WHERE id = $1`, [created.invitation_id]))[0];
    return (o && o.environment === 'staging' && o.slug === 'org-bravo' && o.ref_prefix === 'BRV'
      && b && b.org_id === o.id && b.code === 'RUH'
      && i && i.role === 'admin' && i.branch_id === null && i.email === 'owner.b@example.com' && i.invited_by === U.plat
      && /^[0-9a-f]{64}$/.test(created.token) && created.accept_path === 'login.html?invite=' + created.token
      && i.token_hash !== created.token) || JSON.stringify({ created, o, b, i });
  });
  if (!created || !created.token) return finish();
  const B = created.org_id, B_BR = created.branch_id, ownerToken = created.token;
  await check('only the SHA-256 of the token is stored (also not in the idempotency replay row)', async () => {
    const i = (await q(`SELECT token_hash = encode(sha256(convert_to($2, 'UTF8')), 'hex') ok FROM public.invitations WHERE id = $1`,
      [created.invitation_id, ownerToken]))[0];
    const k = (await q(`SELECT response::text t FROM public.idempotency_keys WHERE key = $1`, [KEY1]))[0];
    return (i.ok && k && !k.t.includes(ownerToken)) || JSON.stringify({ i, k });
  });
  await check('idempotent replay returns the same org without the token and creates nothing', async () => {
    const r = await rpc('plat', `SELECT public.platform_create_org($1) r`, [orgPayload]);
    const n = await count(`SELECT count(*)::int n FROM public.organizations WHERE slug = 'org-bravo'`);
    const ni = await count(`SELECT count(*)::int n FROM public.invitations WHERE org_id = $1`, [B]);
    const nb = await count(`SELECT count(*)::int n FROM public.branches WHERE org_id = $1`, [B]);
    return (r.org_id === B && r.replayed === true && r.token === null && r.token_shown === true && n === 1 && ni === 1 && nb === 1)
      || JSON.stringify({ r, n, ni, nb });
  });
  await expectErr('same idempotency key with a different payload → MRS_IDEMPOTENCY_CONFLICT', () => as('plat',
    `SELECT public.platform_create_org($1)`, [{ ...orgPayload, name_ar: 'اسم آخر' }]), /MRS_IDEMPOTENCY_CONFLICT/);
  await check('platform_list_orgs lists both orgs with counts and no tenant data', async () => {
    const r = await rpc('plat', `SELECT public.platform_list_orgs() r`);
    const b = r.find(o => o.id === B), a = r.find(o => o.id === A);
    const keys = Object.keys(b || {}).sort().join(',');
    return (a && b && b.branches === 1 && b.admins === 0 && b.pending_admin_invitations === 1 && b.environment === 'staging'
      && !/client|transaction|document/.test(keys)) || JSON.stringify(r);
  });
  await check('my_context: is_platform_admin true for plat, false for adminA; organizations[] for adminA', async () => {
    const p = await rpc('plat', `SELECT public.my_context() r`);
    const a = await rpc('adminA', `SELECT public.my_context() r`);
    const orgA = (a.organizations || []).find(o => o.org_id === A);
    return (p.is_platform_admin === true && p.organizations.length === 0 && a.is_platform_admin === false
      && orgA && orgA.slug === 'blue-sea' && JSON.stringify(orgA.roles) === '["admin"]'
      && Array.isArray(a.memberships) && Array.isArray(a.clients) && a.user_id === U.adminA) || JSON.stringify({ p, a });
  });

  /* ---------------------------------------------------------------- invitations: preview + accept */
  section('invitation preview + accept (org B admin)');
  await check('anon invitation_preview shows org, role and a masked e-mail only', async () => {
    const r = await rpc('anon', `SELECT public.invitation_preview($1) r`, [ownerToken]);
    const keys = Object.keys(r).sort().join(',');
    return (keys === 'branch_name_ar,email_masked,expires_at,org_name_ar,org_name_en,role,role_label_ar,role_label_en'
      && r.org_name_ar === orgPayload.name_ar && r.role === 'admin' && r.email_masked === 'o***@example.com')
      || JSON.stringify(r);
  });
  for (const [label, tok] of [['unknown token', 'ab'.repeat(32)], ['malformed token', 'x'], ['null token', null]]) {
    await expectErr('invitation_preview: ' + label + ' → MRS_NOT_FOUND', () => as('anon', `SELECT public.invitation_preview($1)`, [tok]), /MRS_NOT_FOUND/);
  }
  await expectErr('anon cannot accept an invitation', () => as('anon', `SELECT public.accept_invitation($1)`, [ownerToken]), /permission denied/);
  await expectErr('accept by a user with another e-mail → MRS_EMAIL_MISMATCH', () => as('wrong',
    `SELECT public.accept_invitation($1)`, [ownerToken]), /MRS_EMAIL_MISMATCH/);
  let accepted = null;
  await check('invited owner (confirmed, e-mail differs only in case) accepts → admin of org B', async () => {
    await q(`UPDATE auth.users SET email = 'OWNER.b@example.com' WHERE id = $1`, [U.ownerB]);
    accepted = await rpc('ownerB', `SELECT public.accept_invitation($1) r`, [ownerToken]);
    const m = (await q(`SELECT * FROM public.memberships WHERE user_id = $1 AND org_id = $2`, [U.ownerB, B]));
    const i = (await q(`SELECT accepted_by FROM public.invitations WHERE id = $1`, [created.invitation_id]))[0];
    return (m.length === 1 && m[0].role === 'admin' && m[0].branch_id === null && m[0].is_active
      && accepted.membership_id === m[0].id && accepted.org_id === B && i.accepted_by === U.ownerB) || JSON.stringify({ accepted, m });
  });
  await check('second accept by the same user returns the same result, no duplicate', async () => {
    const r = await rpc('ownerB', `SELECT public.accept_invitation($1) r`, [ownerToken]);
    const n = await count(`SELECT count(*)::int n FROM public.memberships WHERE user_id = $1 AND org_id = $2`, [U.ownerB, B]);
    return (r.membership_id === accepted.membership_id && r.invitation_id === accepted.invitation_id && n === 1) || JSON.stringify({ r, n });
  });
  await expectErr('already-accepted token by another user → MRS_NOT_FOUND', () => as('wrong',
    `SELECT public.accept_invitation($1)`, [ownerToken]), /MRS_NOT_FOUND/);
  await expectErr('preview of an accepted invitation → MRS_NOT_FOUND', () => as('anon',
    `SELECT public.invitation_preview($1)`, [ownerToken]), /MRS_NOT_FOUND/);
  await check('my_context of ownerB lists org B with roles [admin]', async () => {
    const r = await rpc('ownerB', `SELECT public.my_context() r`);
    return (r.organizations.length === 1 && r.organizations[0].org_id === B && r.organizations[0].roles[0] === 'admin'
      && r.memberships.length === 1) || JSON.stringify(r);
  });

  await check('platform_list_orgs shows admin e-mails masked only (no raw tenant e-mail)', async () => {
    const r = await rpc('plat', `SELECT public.platform_list_orgs() r`);
    const b = r.find(o => o.id === B);
    const raw = JSON.stringify(r).match(/"[^"*]+@[^"]+"/g);
    return (b && JSON.stringify(b.admin_emails_masked) === '["o***@example.com"]' && !('admin_emails' in b) && !raw)
      || JSON.stringify({ b, raw });
  });
  await check('platform_admins changes are audited (grant + removal)', async () => {
    const ins = await count(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'platform_admins' AND action = 'INSERT' AND row_id = $1`, [U.plat]);
    await q(`INSERT INTO public.platform_admins (user_id, note) VALUES ($1, 'temp')`, [U.wrong]);
    await q(`DELETE FROM public.platform_admins WHERE user_id = $1`, [U.wrong]);
    const del = await count(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'platform_admins' AND action = 'DELETE' AND row_id = $1 AND org_id IS NULL`, [U.wrong]);
    return (ins === 1 && del === 1) || JSON.stringify({ ins, del });
  });
  await check('app.new_token: 64 hex, no fixed UUID version / variant nibbles', async () => {
    const toks = (await q(`SELECT app.new_token() t FROM generate_series(1, 40)`)).map(x => x.t);
    const at = i => new Set(toks.map(t => t[i])).size;
    return (toks.every(t => /^[0-9a-f]{64}$/.test(t)) && new Set(toks).size === 40 && at(12) > 1 && at(16) > 1 && at(44) > 1)
      || JSON.stringify(toks.slice(0, 3));
  });

  /* ---------------------------------------------------------------- platform admin has no tenant access */
  section('platform admin: no implicit tenant data access');
  // give org B some operational rows (owner side)
  await db.exec(`
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES
      ('bbbb1000-0000-4000-8000-000000000101', '${B}', 'business', 'عميل برافو', '0509999990');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode)
      VALUES ('bbbb1000-0000-4000-8000-000000000201', '${B}', '${B_BR}', 'bbbb1000-0000-4000-8000-000000000101', 'import', 'sea');
    INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, uploaded_by)
      VALUES ('bbbb1000-0000-4000-8000-000000000501', '${B}', 'bbbb1000-0000-4000-8000-000000000201', 'other',
              '${B}/bbbb1000-0000-4000-8000-000000000201/bbbb1000-0000-4000-8000-000000000501/x.pdf', '${'b'.repeat(64)}', 'x.pdf', 10, '${U.ownerB}');
  `);
  const B_CL = 'bbbb1000-0000-4000-8000-000000000101', B_TX = 'bbbb1000-0000-4000-8000-000000000201';
  for (const t of ['transactions', 'clients', 'documents', 'containers', 'service_requests', 'memberships', 'invitations', 'audit_log', 'branches']) {
    for (const org of [A, B]) {
      await check(`platform admin cannot read ${t} of ${org === A ? 'org A' : 'org B'}`, () =>
        denied('plat', `SELECT 1 FROM public.${t} WHERE org_id = $1`, [org]));
    }
  }
  await expectErr('platform admin refused on admin_list_members(org B)', () => as('plat', `SELECT public.admin_list_members($1)`, [B]), /MRS_FORBIDDEN/);
  await expectErr('platform admin refused on admin_invite(org B)', () => as('plat', `SELECT public.admin_invite($1, $2)`,
    [B, { email: 'x@example.com', role: 'admin' }]), /MRS_FORBIDDEN/);
  await expectErr('platform admin refused on admin_update_org(org B)', () => as('plat', `SELECT public.admin_update_org($1, $2)`,
    [B, { name_en: 'x' }]), /MRS_FORBIDDEN/);

  /* ---------------------------------------------------------------- branches */
  section('branches (org admin)');
  let br2 = null;
  await check('ownerB creates a second branch', async () => {
    br2 = await rpc('ownerB', `SELECT public.admin_create_branch($1, $2) r`, [B, { code: 'jed', name_ar: 'فرع جدة برافو', city: 'جدة' }]);
    return (br2.code === 'JED' && br2.org_id === B && br2.is_active === true) || JSON.stringify(br2);
  });
  await expectErr('duplicate branch code → MRS_INVALID code_taken', () => as('ownerB',
    `SELECT public.admin_create_branch($1, $2)`, [B, { code: 'JED', name_ar: 'مكرر' }]), /MRS_INVALID.*code_taken/);
  await expectErr('branch code format is validated', () => as('ownerB',
    `SELECT public.admin_create_branch($1, $2)`, [B, { code: 'j!', name_ar: 'خطأ' }]), /MRS_INVALID.*code/);
  await expectErr('branch unknown key → MRS_INVALID', () => as('ownerB',
    `SELECT public.admin_create_branch($1, $2)`, [B, { code: 'ABH', name_ar: 'أبها', org_id: A }]), /MRS_INVALID.*unknown_key/);
  await expectErr('branch code is immutable after create', () => as('ownerB',
    `SELECT public.admin_update_branch($1, $2)`, [br2.id, { code: 'JDD' }]), /MRS_IMMUTABLE.*code/);
  await check('branch rename + deactivate + reactivate', async () => {
    const r1 = await rpc('ownerB', `SELECT public.admin_update_branch($1, $2) r`, [br2.id, { code: 'JED', name_ar: 'فرع جدة الجديد', name_en: 'Jeddah' }]);
    const r2 = await rpc('ownerB', `SELECT public.admin_update_branch($1, $2) r`, [br2.id, { is_active: false }]);
    const r3 = await rpc('ownerB', `SELECT public.admin_update_branch($1, $2) r`, [br2.id, { is_active: true }]);
    return (r1.name_ar === 'فرع جدة الجديد' && r1.name_en === 'Jeddah' && r2.is_active === false && r3.is_active === true) || JSON.stringify({ r1, r2, r3 });
  });
  await check('last active branch cannot be deactivated (MRS_FORBIDDEN last_branch)', async () => {
    await rpc('ownerB', `SELECT public.admin_update_branch($1, $2) r`, [br2.id, { is_active: false }]);
    try { await as('ownerB', `SELECT public.admin_update_branch($1, $2)`, [B_BR, { is_active: false }]); return 'deactivated the last branch'; }
    catch (e) { if (!/MRS_FORBIDDEN.*last_branch/.test(errText(e))) return 'wrong error: ' + errText(e); }
    await rpc('ownerB', `SELECT public.admin_update_branch($1, $2) r`, [br2.id, { is_active: true }]);
    return (await count(`SELECT count(*)::int n FROM public.branches WHERE org_id = $1 AND is_active`, [B])) === 2;
  });
  await expectErr('branch_manager cannot create branches', () => as('bmJ',
    `SELECT public.admin_create_branch($1, $2)`, [A, { code: 'TIF', name_ar: 'الطائف' }]), /MRS_FORBIDDEN/);

  /* ---------------------------------------------------------------- org settings */
  section('org settings whitelist');
  await check('ownerB updates names, locale, intake and settings (validated, normalized)', async () => {
    const r = await rpc('ownerB', `SELECT public.admin_update_org($1, $2) r`, [B, {
      name_en: 'Bravo Clearance', default_locale: 'en', public_intake_enabled: false,
      settings: { brand_color: '#AABBCC', contact_phone: '+966 55 123 4567', contact_email: 'Info@Bravo.example.com',
                  address_ar: 'الرياض', logo_path: B + '/branding/logo.png' } }]);
    const o = (await q(`SELECT * FROM public.organizations WHERE id = $1`, [B]))[0];
    return (r.name_en === 'Bravo Clearance' && o.default_locale === 'en' && o.public_intake_enabled === false
      && o.settings.brand_color === '#aabbcc' && o.settings.contact_phone === '0551234567'
      && o.settings.contact_email === 'info@bravo.example.com' && o.settings.staging === true
      && o.slug === 'org-bravo' && o.environment === 'staging') || JSON.stringify({ r, o });
  });
  await check('a settings key set to null is removed', async () => {
    await rpc('ownerB', `SELECT public.admin_update_org($1, $2) r`, [B, { settings: { address_ar: null } }]);
    const o = (await q(`SELECT settings FROM public.organizations WHERE id = $1`, [B]))[0];
    return (!('address_ar' in o.settings) && o.settings.brand_color === '#aabbcc') || JSON.stringify(o);
  });
  for (const [label, payload, re] of [
    ['unknown top-level key (slug)', { slug: 'hijack' }, /MRS_INVALID.*unknown_key/],
    ['unknown top-level key (environment)', { environment: 'production' }, /MRS_INVALID.*unknown_key/],
    ['unknown top-level key (is_active)', { is_active: false }, /MRS_INVALID.*unknown_key/],
    ['unknown settings key', { settings: { custom_css: 'x' } }, /MRS_INVALID.*unknown_key/],
    ['bad brand_color', { settings: { brand_color: 'red' } }, /MRS_INVALID.*brand_color/],
    ['bad contact_phone', { settings: { contact_phone: '12' } }, /MRS_INVALID.*contact_phone/],
    ['bad contact_email', { settings: { contact_email: 'nope' } }, /MRS_INVALID.*contact_email/],
    ['logo_path outside the org folder', { settings: { logo_path: A + '/logo.png' } }, /MRS_INVALID.*logo_path/],
    ['logo_path as a URL', { settings: { logo_path: 'https://evil.example.com/x.png' } }, /MRS_INVALID.*logo_path/],
    ['bad default_locale', { default_locale: 'fr' }, /MRS_INVALID.*default_locale/],
    ['non-boolean public_intake_enabled', { public_intake_enabled: 'yes' }, /MRS_INVALID.*public_intake_enabled/],
    ['too short name_ar', { name_ar: 'x' }, /MRS_INVALID.*name_ar/],
    ['settings not an object', { settings: 'x' }, /MRS_INVALID/]
  ]) await expectErr('admin_update_org refuses ' + label, () => as('ownerB', `SELECT public.admin_update_org($1, $2)`, [B, payload]), re);
  await expectErr('branch_manager cannot update org settings', () => as('bmJ',
    `SELECT public.admin_update_org($1, $2)`, [A, { name_en: 'x' }]), /MRS_FORBIDDEN/);

  /* ---------------------------------------------------------------- invitations: rules */
  section('invitations: who may invite what');
  for (const [label, payload, re] of [
    ['admin with a branch', { email: 'x1@example.com', role: 'admin', branch_id: JED }, /MRS_INVALID.*branch/],
    ['branch_manager without a branch', { email: 'x2@example.com', role: 'branch_manager' }, /MRS_BRANCH_REQUIRED/],
    ['client without client_id', { email: 'x3@example.com', role: 'client' }, /MRS_REQUIRED.*client_id/],
    ['client of another org', { email: 'x4@example.com', role: 'client', client_id: B_CL }, /MRS_INVALID.*client/],
    ['branch of another org', { email: 'x5@example.com', role: 'clearance_staff', branch_id: B_BR }, /MRS_INVALID.*branch/],
    ['staff role with client_id', { email: 'x6@example.com', role: 'clearance_staff', client_id: CL101 }, /MRS_INVALID.*client_id/],
    ['unknown role', { email: 'x7@example.com', role: 'owner' }, /MRS_INVALID.*role/],
    ['bad e-mail', { email: 'not-an-email', role: 'accountant' }, /MRS_INVALID.*email/],
    ['malformed branch id', { email: 'x8@example.com', role: 'accountant', branch_id: 'abc' }, /MRS_INVALID.*branch_id/],
    ['unknown key', { email: 'x9@example.com', role: 'accountant', org_id: B }, /MRS_INVALID.*unknown_key/]
  ]) await expectErr('admin_invite refuses ' + label, () => as('adminA', `SELECT public.admin_invite($1, $2)`, [A, payload]), re);

  let bmInv = null;
  await check('adminA invites a branch_manager for JED (idempotent replay, no duplicate)', async () => {
    const p = { email: EMAIL.newBm, role: 'branch_manager', branch_id: JED, idempotencyKey: KEY2 };
    bmInv = await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, p]);
    const again = await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, p]);
    const n = await count(`SELECT count(*)::int n FROM public.invitations WHERE org_id = $1 AND email = $2`, [A, EMAIL.newBm]);
    return (/^[0-9a-f]{64}$/.test(bmInv.token) && again.invitation_id === bmInv.invitation_id && again.token === null
      && again.replayed === true && again.token_shown === true && n === 1) || JSON.stringify({ bmInv, again, n });
  });
  await expectErr('a second pending invitation for the same target → MRS_INVALID invitation_pending', () => as('adminA',
    `SELECT public.admin_invite($1, $2)`, [A, { email: EMAIL.newBm, role: 'branch_manager', branch_id: JED }]), /MRS_INVALID.*invitation_pending/);
  await expectErr('another user replaying adminA\'s idempotency key → conflict', () => as('ownerB',
    `SELECT public.admin_invite($1, $2)`, [B, { email: EMAIL.newBm, role: 'admin', idempotencyKey: KEY2 }]), /MRS_IDEMPOTENCY_CONFLICT/);
  await check('newBm accepts → branch_manager of JED', async () => {
    const r = await rpc('newBm', `SELECT public.accept_invitation($1) r`, [bmInv.token]);
    const m = (await q(`SELECT role, branch_id FROM public.memberships WHERE id = $1`, [r.membership_id]))[0];
    return (m.role === 'branch_manager' && m.branch_id === JED) || JSON.stringify(m);
  });

  section('branch_manager scope');
  let staffInv = null;
  await check('bmJ invites clearance_staff for its own branch', async () => {
    staffInv = await rpc('bmJ', `SELECT public.admin_invite($1, $2) r`, [A, { email: EMAIL.newStaff, role: 'clearance_staff', branch_id: JED }]);
    return /^[0-9a-f]{64}$/.test(staffInv.token) || JSON.stringify(staffInv);
  });
  await expectErr('bmJ cannot invite staff for another branch (DMM)', () => as('bmJ',
    `SELECT public.admin_invite($1, $2)`, [A, { email: 'd1@example.com', role: 'clearance_staff', branch_id: DMM }]), /MRS_FORBIDDEN.*branch/);
  await expectErr('bmJ cannot invite org-wide staff (no branch)', () => as('bmJ',
    `SELECT public.admin_invite($1, $2)`, [A, { email: 'd2@example.com', role: 'accountant' }]), /MRS_FORBIDDEN.*branch/);
  for (const role of ['admin', 'supervisor', 'branch_manager', 'operations_manager', 'accounts_manager']) {
    await expectErr(`bmJ cannot invite ${role}`, () => as('bmJ', `SELECT public.admin_invite($1, $2)`,
      [A, { email: 'r.' + role + '@example.com', role, branch_id: role === 'admin' ? undefined : JED }]), /MRS_FORBIDDEN.*role/);
  }
  await expectErr('bmJ cannot invite into org B', () => as('bmJ', `SELECT public.admin_invite($1, $2)`,
    [B, { email: 'b1@example.com', role: 'clearance_staff', branch_id: B_BR }]), /MRS_FORBIDDEN/);
  let clientInv = null;
  await check('bmJ invites a client-portal user for client 101', async () => {
    clientInv = await rpc('bmJ', `SELECT public.admin_invite($1, $2) r`, [A, { email: EMAIL.newClient, role: 'client', client_id: CL101 }]);
    return /^[0-9a-f]{64}$/.test(clientInv.token) || JSON.stringify(clientInv);
  });
  let dmmInv = null;
  await check('bmJ lists only its own branch / own client invitations', async () => {
    dmmInv = await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, { email: 'dmm.staff@example.com', role: 'transport_staff', branch_id: DMM }]);
    const l = await rpc('bmJ', `SELECT public.admin_list_invitations($1) r`, [A]);
    const ids = l.map(x => x.id);
    const direct = (await as('bmJ', `SELECT id FROM public.invitations`)).map(x => x.id).sort();
    const all = (await rpc('adminA', `SELECT public.admin_list_invitations($1) r`, [A])).map(x => x.id);
    return (ids.includes(staffInv.invitation_id) && ids.includes(clientInv.invitation_id) && !ids.includes(dmmInv.invitation_id)
      && !ids.includes(bmInv.invitation_id) && JSON.stringify(direct) === JSON.stringify(ids.slice().sort())
      && all.includes(dmmInv.invitation_id) && all.includes(bmInv.invitation_id)
      && !l.some(x => 'token_hash' in x || 'token' in x)) || JSON.stringify({ ids, direct, all });
  });
  await expectErr('bmJ cannot revoke a DMM invitation', () => as('bmJ', `SELECT public.admin_revoke_invitation($1)`, [dmmInv.invitation_id]), /MRS_NOT_FOUND/);
  await expectErr('bmJ cannot reissue a DMM invitation', () => as('bmJ', `SELECT public.admin_reissue_invitation($1)`, [dmmInv.invitation_id]), /MRS_NOT_FOUND/);

  await check('newStaff accepts → clearance_staff of JED', async () => {
    const r = await rpc('newStaff', `SELECT public.accept_invitation($1) r`, [staffInv.token]);
    const m = (await q(`SELECT role, branch_id, created_by FROM public.memberships WHERE id = $1`, [r.membership_id]))[0];
    return (m.role === 'clearance_staff' && m.branch_id === JED && m.created_by === U.bmJ) || JSON.stringify(m);
  });
  await check('newClient accepts → client membership + client_users link, sees only client 101 transactions', async () => {
    const r = await rpc('newClient', `SELECT public.accept_invitation($1) r`, [clientInv.token]);
    const cu = (await q(`SELECT client_id, is_active FROM public.client_users WHERE id = $1`, [r.client_user_id]))[0];
    const tx = (await as('newClient', `SELECT id FROM public.transactions ORDER BY id`)).map(x => x.id);
    return (cu && cu.client_id === CL101 && cu.is_active && r.role === 'client' && JSON.stringify(tx) === JSON.stringify([TX1]))
      || JSON.stringify({ r, cu, tx });
  });

  await check('bmJ admin_list_members: own branch lower roles + itself only', async () => {
    const r = await rpc('bmJ', `SELECT public.admin_list_members($1) r`, [A]);
    const emails = r.map(m => m.email).sort();
    return JSON.stringify(emails) === JSON.stringify([EMAIL.bmJ, EMAIL.newStaff, EMAIL.staffJ].sort()) || JSON.stringify(emails);
  });
  const memId = async who => (await q(`SELECT id FROM public.memberships WHERE user_id = $1 AND org_id = $2`, [U[who], A]))[0].id;
  await expectErr('bmJ cannot deactivate DMM staff', async () => as('bmJ', `SELECT public.admin_set_member_active($1, false)`, [await memId('staffD')]), /MRS_NOT_FOUND/);
  await expectErr('bmJ cannot deactivate the org admin', async () => as('bmJ', `SELECT public.admin_set_member_active($1, false)`, [await memId('adminA')]), /MRS_NOT_FOUND/);
  await expectErr('bmJ cannot deactivate the other JED branch manager', async () => as('bmJ', `SELECT public.admin_set_member_active($1, false)`, [await memId('newBm')]), /MRS_NOT_FOUND/);
  await expectErr('bmJ cannot deactivate itself', async () => as('bmJ', `SELECT public.admin_set_member_active($1, false)`, [await memId('bmJ')]), /MRS_NOT_FOUND|MRS_FORBIDDEN/);

  await check('bmJ reads JED transactions only', async () => {
    const tx = (await as('bmJ', `SELECT id FROM public.transactions WHERE org_id = $1 ORDER BY id`, [A])).map(x => x.id);
    return JSON.stringify(tx) === JSON.stringify([TX1, TX3]) || JSON.stringify(tx);
  });
  await check('bmJ moves a JED transaction (set_transaction_status)', async () => {
    const r = await rpc('bmJ', `SELECT public.set_transaction_status($1, 'in_progress', NULL) r`, [TX3]);
    return r.to === 'in_progress' || JSON.stringify(r);
  });
  await check('bmJ may skip stages with a reason (senior role, like operations_manager)', async () => {
    const r = await rpc('bmJ', `SELECT public.set_transaction_status($1, 'transport', 'تخطي موثق') r`, [TX3]);
    return r.to === 'transport' || JSON.stringify(r);
  });
  await check('bmJ may correct backwards with a reason', async () => {
    const r = await rpc('bmJ', `SELECT public.set_transaction_status($1, 'in_progress', 'تصحيح') r`, [TX3]);
    return r.to === 'in_progress' || JSON.stringify(r);
  });
  await expectErr('bmJ refused on a DMM transaction', () => as('bmJ',
    `SELECT public.set_transaction_status($1, 'appointment', NULL)`, [TX2]), /MRS_NOT_FOUND/);
  await expectErr('bmJ cannot close (finance stage roles unchanged)', () => as('bmJ',
    `SELECT public.set_transaction_status($1, 'closed', 'x')`, [TX1]), /MRS_FORBIDDEN|MRS_CONTAINERS_NOT_RETURNED|MRS_BAD_TRANSITION/);
  await check('bmJ may waive a JED container with a reason', async () => {
    const r = await as('bmJ', `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'استثناء موثق' WHERE id = $1 RETURNING return_status`, [CT301]);
    return (r.length === 1 && r[0].return_status === 'waived') || JSON.stringify(r);
  });
  await check('bmJ cannot waive a DMM container', () => denied('bmJ',
    `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'x' WHERE id = $1 RETURNING 1`, [CT303]));
  await expectErr('staffJ (clearance) still cannot waive', () => as('staffJ',
    `UPDATE public.containers SET return_status = 'pending', waiver_reason = NULL WHERE id = $1 RETURNING 1`, [CT301]).then(() => as('staffJ',
    `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'x' WHERE id = $1 RETURNING 1`, [CT301])), /MRS_FORBIDDEN/);
  // review fix: client_users links are org-wide (every branch) → never written directly by a branch manager
  await check('bmJ cannot UPDATE client_users (portal links are org-wide)', () => denied('bmJ',
    `UPDATE public.client_users SET is_active = false WHERE user_id = $1 RETURNING 1`, [U.newClient]));
  await check('bmJ cannot link itself to a DMM client via INSERT client_users', () => denied('bmJ',
    `INSERT INTO public.client_users (org_id, client_id, user_id) VALUES ($1, $2, $3) RETURNING 1`, [A, CL102, U.bmJ]));
  await check('bmJ cannot link another account to a client via INSERT client_users', () => denied('bmJ',
    `INSERT INTO public.client_users (org_id, client_id, user_id) VALUES ($1, $2, $3) RETURNING 1`, [A, CL101, U.helper]));
  await expectErr('bmJ cannot invite its own e-mail as a client', () => as('bmJ', `SELECT public.admin_invite($1, $2)`,
    [A, { email: EMAIL.bmJ.toUpperCase(), role: 'client', client_id: CL101 }]), /MRS_FORBIDDEN.*email/);
  await expectErr('bmJ cannot invite its own e-mail as JED staff', () => as('bmJ', `SELECT public.admin_invite($1, $2)`,
    [A, { email: EMAIL.bmJ, role: 'clearance_staff', branch_id: JED }]), /MRS_FORBIDDEN.*email/);
  await expectErr('bmJ cannot invite a portal user for a client whose transactions are in DMM', () => as('bmJ',
    `SELECT public.admin_invite($1, $2)`, [A, { email: EMAIL.helper, role: 'client', client_id: CL102 }]), /MRS_FORBIDDEN.*client/);
  await check('adminA may still invite a portal user for the DMM client', async () => {
    const r = await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, { email: 'cl102@example.com', role: 'client', client_id: CL102 }]);
    return /^[0-9a-f]{64}$/.test(r.token) || JSON.stringify(r);
  });
  await check('a planted self-invitation (invited_by = invitee, not admin) is refused at accept', async () => {
    const tok = 'c'.repeat(64);
    await q(`INSERT INTO public.invitations (org_id, email, role, branch_id, token_hash, invited_by)
             VALUES ($1, $2, 'accountant', $3, app.hash_token($4), $5)`, [A, EMAIL.bmJ, JED, tok, U.bmJ]);
    let e1 = '';
    try { await as('bmJ', `SELECT public.accept_invitation($1)`, [tok]); } catch (e) { e1 = errText(e); }
    const n = await count(`SELECT count(*)::int n FROM public.memberships WHERE user_id = $1`, [U.bmJ]);
    await q(`UPDATE public.invitations SET revoked_at = now() WHERE token_hash = app.hash_token($1)`, [tok]);
    return (/MRS_FORBIDDEN.*self_invite/.test(e1) && n === 1) || JSON.stringify({ e1, n });
  });
  await check('after all attempts bmJ still cannot read the DMM transaction', () =>
    denied('bmJ', `SELECT 1 FROM public.transactions WHERE id = $1`, [TX2]));

  /* ---------------------------------------------------------------- deactivation */
  section('deactivated member loses access immediately');
  await check('staffJ reads JED data, is deactivated by bmJ, then reads nothing', async () => {
    const before = (await as('staffJ', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    const r = await rpc('bmJ', `SELECT public.admin_set_member_active($1, false) r`, [await memId('staffJ')]);
    const after = (await as('staffJ', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    const cl = (await as('staffJ', `SELECT count(*)::int n FROM public.clients`))[0].n;
    const ctx = await rpc('staffJ', `SELECT public.my_context() r`);
    return (before > 0 && r.is_active === false && after === 0 && cl === 0 && ctx.memberships.length === 0 && ctx.organizations.length === 0)
      || JSON.stringify({ before, r, after, cl, ctx });
  });
  await expectErr('deactivated staffJ cannot move a transaction', () => as('staffJ',
    `SELECT public.set_transaction_status($1, 'in_progress', NULL)`, [TX1]), /MRS_NOT_FOUND/);
  await check('bmJ reactivates staffJ', async () => {
    const r = await rpc('bmJ', `SELECT public.admin_set_member_active($1, true) r`, [await memId('staffJ')]);
    return r.is_active === true && (await as('staffJ', `SELECT count(*)::int n FROM public.transactions`))[0].n > 0;
  });
  await check('org admin of a suspended org loses access; reactivation restores it', async () => {
    await rpc('plat', `SELECT public.platform_set_org_active($1, false) r`, [B]);
    let err = '';
    try { await as('ownerB', `SELECT public.admin_list_members($1)`, [B]); } catch (e) { err = errText(e); }
    const tx = (await as('ownerB', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    const ctx = await rpc('ownerB', `SELECT public.my_context() r`);
    await rpc('plat', `SELECT public.platform_set_org_active($1, true) r`, [B]);
    const tx2 = (await as('ownerB', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    return (/MRS_FORBIDDEN/.test(err) && tx === 0 && ctx.organizations.length === 0 && tx2 === 1) || JSON.stringify({ err, tx, ctx, tx2 });
  });
  await expectErr('platform_set_org_active same status → MRS_BAD_TRANSITION', () => as('plat',
    `SELECT public.platform_set_org_active($1, true)`, [B]), /MRS_BAD_TRANSITION/);

  // review fix: a deactivated 'client' membership ends client-portal access
  const clientMem = (await q(`SELECT id FROM public.memberships WHERE user_id = $1 AND org_id = $2 AND role = 'client'`, [U.newClient, A]))[0].id;
  await check('client member deactivated → no transactions / documents / events, my_context.clients empty', async () => {
    const before = (await as('newClient', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    const r = await rpc('adminA', `SELECT public.admin_set_member_active($1, false) r`, [clientMem]);
    const tx = (await as('newClient', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    const ev = (await as('newClient', `SELECT count(*)::int n FROM public.transaction_events`))[0].n;
    const dc = (await as('newClient', `SELECT count(*)::int n FROM public.documents`))[0].n;
    const cl = (await as('newClient', `SELECT count(*)::int n FROM public.clients`))[0].n;
    const ctx = await rpc('newClient', `SELECT public.my_context() r`);
    const cu = (await q(`SELECT is_active FROM public.client_users WHERE user_id = $1 AND client_id = $2`, [U.newClient, CL101]))[0];
    return (before === 1 && r.is_active === false && tx === 0 && ev === 0 && dc === 0 && cl === 0 && ctx.clients.length === 0
      && cu.is_active === false) || JSON.stringify({ before, r, tx, ev, dc, cl, ctx: ctx.clients, cu });
  });
  await check('even a client_users link switched back on by hand stays dead while the client membership is inactive', async () => {
    await q(`UPDATE public.client_users SET is_active = true WHERE user_id = $1`, [U.newClient]);
    const tx = (await as('newClient', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    await q(`UPDATE public.client_users SET is_active = false WHERE user_id = $1`, [U.newClient]);
    return tx === 0 || 'tx=' + tx;
  });
  await check('client member reactivated → the invited client link is restored', async () => {
    await rpc('adminA', `SELECT public.admin_set_member_active($1, true) r`, [clientMem]);
    const tx = (await as('newClient', `SELECT id FROM public.transactions`)).map(x => x.id);
    return JSON.stringify(tx) === JSON.stringify([TX1]) || JSON.stringify(tx);
  });

  // review fix: suspending an org also stops the client portal and public tracking
  const reqRef = (await q(`SELECT ref FROM public.service_requests WHERE id = '0b5e0000-0000-4000-8000-000000000401'`))[0].ref;
  const SEED_TOKEN = 'deadbeef'.repeat(8);
  await check('org A suspended → client portal reads nothing, cannot upload, anon tracking MRS_NOT_FOUND; reactivation restores', async () => {
    const t0 = await rpc('anon', `SELECT public.public_track($1, $2) r`, [reqRef, SEED_TOKEN]);
    await rpc('plat', `SELECT public.platform_set_org_active($1, false) r`, [A]);
    const n = {};
    for (const t of ['transactions', 'clients', 'transaction_events', 'containers', 'documents']) {
      n[t] = (await as('newClient', `SELECT count(*)::int n FROM public.${t}`))[0].n;
    }
    const isc = (await as('newClient', `SELECT app.is_tx_client($1) x`, [TX1]))[0].x;
    const up = await denied('newClient', `INSERT INTO public.documents (org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, uploaded_by)
      VALUES ($1, $2, 'other', $3, $4, 'x.pdf', 10, $5) RETURNING 1`, [A, TX1, `${A}/${TX1}/0b5e0000-0000-4000-8000-000000000599/x.pdf`, 'a'.repeat(64), U.newClient]);
    let e1 = '';
    try { await as('anon', `SELECT public.public_track($1, $2)`, [reqRef, SEED_TOKEN]); } catch (e) { e1 = errText(e); }
    const ctx = await rpc('newClient', `SELECT public.my_context() r`);
    await rpc('plat', `SELECT public.platform_set_org_active($1, true) r`, [A]);
    const t1 = await rpc('anon', `SELECT public.public_track($1, $2) r`, [reqRef, SEED_TOKEN]);
    const back = (await as('newClient', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    return (t0.kind === 'request' && Object.values(n).every(x => x === 0) && isc === false && up === true
      && /MRS_NOT_FOUND/.test(e1) && ctx.clients.length === 0 && t1.kind === 'request' && back === 1)
      || JSON.stringify({ t0: !!t0, n, isc, up, e1, ctx: ctx.clients, t1: !!t1, back });
  });

  // review fix: deactivating a branch cuts its branch-scoped members (org-wide roles keep access)
  await check('DMM deactivated → staffD reads nothing there and cannot move TX2; adminA keeps access; reactivation restores', async () => {
    const before = (await as('staffD', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    await rpc('adminA', `SELECT public.admin_update_branch($1, $2) r`, [DMM, { is_active: false }]);
    const after = (await as('staffD', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    let e1 = '';
    try { await as('staffD', `SELECT public.set_transaction_status($1, 'in_progress', NULL)`, [TX2]); } catch (e) { e1 = errText(e); }
    const adm = (await as('adminA', `SELECT count(*)::int n FROM public.transactions WHERE id = $1`, [TX2]))[0].n;
    const ctx = await rpc('staffD', `SELECT public.my_context() r`);
    await rpc('adminA', `SELECT public.admin_update_branch($1, $2) r`, [DMM, { is_active: true }]);
    const again = (await as('staffD', `SELECT count(*)::int n FROM public.transactions`))[0].n;
    return (before === 1 && after === 0 && /MRS_NOT_FOUND/.test(e1) && adm === 1 && again === 1)
      || JSON.stringify({ before, after, e1, adm, again, orgs: ctx.organizations });
  });
  await check('a branch manager of a deactivated branch can no longer manage its members', async () => {
    await rpc('adminA', `SELECT public.admin_update_branch($1, $2) r`, [JED, { is_active: false }]);
    let e1 = '';
    try { await as('bmJ', `SELECT public.admin_set_member_active($1, false)`, [await memId('staffJ')]); } catch (e) { e1 = errText(e); }
    await rpc('adminA', `SELECT public.admin_update_branch($1, $2) r`, [JED, { is_active: true }]);
    return /MRS_NOT_FOUND|MRS_FORBIDDEN/.test(e1) || 'no error: ' + e1;
  });

  // review fix: pending invitations die with their inviter's authority
  await check('inviter (branch manager) deactivated via RPC → its pending invitation is revoked, accept MRS_NOT_FOUND', async () => {
    const inv = await rpc('newBm', `SELECT public.admin_invite($1, $2) r`, [A, { email: EMAIL.alt, role: 'transport_staff', branch_id: JED }]);
    const r = await rpc('adminA', `SELECT public.admin_set_member_active($1, false) r`, [await memId('newBm')]);
    let e1 = '';
    try { await as('alt', `SELECT public.accept_invitation($1)`, [inv.token]); } catch (e) { e1 = errText(e); }
    const st = (await rpc('adminA', `SELECT public.admin_list_invitations($1) r`, [A])).find(x => x.id === inv.invitation_id).status;
    const n = await count(`SELECT count(*)::int n FROM public.memberships WHERE user_id = $1`, [U.alt]);
    return (r.invitations_revoked >= 1 && /MRS_NOT_FOUND/.test(e1) && st === 'revoked' && n === 0) || JSON.stringify({ r, e1, st, n });
  });
  await check('inviter loses authority some other way → preview + accept MRS_NOT_FOUND until it is restored', async () => {
    const inv = await rpc('bmJ', `SELECT public.admin_invite($1, $2) r`, [A, { email: EMAIL.helper, role: 'accountant', branch_id: JED }]);
    await q(`UPDATE public.memberships SET is_active = false WHERE user_id = $1`, [U.bmJ]);
    let e1 = '', e2 = '';
    try { await as('anon', `SELECT public.invitation_preview($1)`, [inv.token]); } catch (e) { e1 = errText(e); }
    try { await as('helper', `SELECT public.accept_invitation($1)`, [inv.token]); } catch (e) { e2 = errText(e); }
    await q(`UPDATE public.memberships SET is_active = true WHERE user_id = $1`, [U.bmJ]);
    const pv = await rpc('anon', `SELECT public.invitation_preview($1) r`, [inv.token]);
    await rpc('bmJ', `SELECT public.admin_revoke_invitation($1) r`, [inv.invitation_id]);
    return (/MRS_NOT_FOUND/.test(e1) && /MRS_NOT_FOUND/.test(e2) && pv.role === 'accountant') || JSON.stringify({ e1, e2, pv });
  });
  await check('off-boarded admin cannot come back through an admin invitation to its own alt mailbox', async () => {
    await q(`INSERT INTO public.memberships (user_id, org_id, role) VALUES ($1, $2, 'admin')`, [U.admin2, A]);
    const inv = await rpc('admin2', `SELECT public.admin_invite($1, $2) r`, [A, { email: EMAIL.alt, role: 'admin' }]);
    const r = await rpc('adminA', `SELECT public.admin_set_member_active($1, false) r`, [await memId('admin2')]);
    let e1 = '';
    try { await as('alt', `SELECT public.accept_invitation($1)`, [inv.token]); } catch (e) { e1 = errText(e); }
    const n = await count(`SELECT count(*)::int n FROM public.memberships WHERE user_id = $1 AND is_active`, [U.alt]);
    return (r.invitations_revoked >= 1 && /MRS_NOT_FOUND/.test(e1) && n === 0) || JSON.stringify({ r, e1, n });
  });
  await check('deactivating a member revokes pending invitations addressed to that member', async () => {
    const inv = await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, { email: EMAIL.staffD, role: 'accountant', branch_id: DMM }]);
    const r = await rpc('adminA', `SELECT public.admin_set_member_active($1, false) r`, [await memId('staffD')]);
    let e1 = '';
    try { await as('staffD', `SELECT public.accept_invitation($1)`, [inv.token]); } catch (e) { e1 = errText(e); }
    await rpc('adminA', `SELECT public.admin_set_member_active($1, true) r`, [await memId('staffD')]);
    return (r.invitations_revoked >= 1 && /MRS_NOT_FOUND/.test(e1)
      && (await count(`SELECT count(*)::int n FROM public.memberships WHERE user_id = $1`, [U.staffD])) === 1) || JSON.stringify({ r, e1 });
  });
  await check('last-admin guard serializes on the organization row (FOR NO KEY UPDATE before counting)', async () => {
    const src = (await q(`SELECT prosrc FROM pg_proc WHERE oid = 'public.admin_set_member_active(uuid,boolean)'::regprocedure`))[0].prosrc;
    const lock = src.indexOf('public.organizations o WHERE o.id = v_m.org_id FOR NO KEY UPDATE'), cnt = src.indexOf('SELECT count(*) INTO v_admins');
    return (lock > 0 && cnt > lock) || 'no org lock before the admin count';
  });

  /* ---------------------------------------------------------------- invitation negatives */
  section('invitations: revoked / expired / reissued / unconfirmed');
  await check('revoked invitation: preview + accept → MRS_NOT_FOUND', async () => {
    const inv = await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, { email: EMAIL.wrong, role: 'accountant' }]);
    const rv = await rpc('adminA', `SELECT public.admin_revoke_invitation($1) r`, [inv.invitation_id]);
    let e1 = '', e2 = '';
    try { await as('anon', `SELECT public.invitation_preview($1)`, [inv.token]); } catch (e) { e1 = errText(e); }
    try { await as('wrong', `SELECT public.accept_invitation($1)`, [inv.token]); } catch (e) { e2 = errText(e); }
    const n = await count(`SELECT count(*)::int n FROM public.memberships WHERE user_id = $1`, [U.wrong]);
    return (rv.status === 'revoked' && /MRS_NOT_FOUND/.test(e1) && /MRS_NOT_FOUND/.test(e2) && n === 0) || JSON.stringify({ rv, e1, e2, n });
  });
  let expInv = null;
  await check('expired invitation: preview MRS_NOT_FOUND, accept MRS_EXPIRED', async () => {
    expInv = await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, { email: EMAIL.wrong, role: 'accountant' }]);
    await q(`UPDATE public.invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expInv.invitation_id]);
    let e1 = '', e2 = '';
    try { await as('anon', `SELECT public.invitation_preview($1)`, [expInv.token]); } catch (e) { e1 = errText(e); }
    try { await as('wrong', `SELECT public.accept_invitation($1)`, [expInv.token]); } catch (e) { e2 = errText(e); }
    const st = (await rpc('adminA', `SELECT public.admin_list_invitations($1) r`, [A])).find(x => x.id === expInv.invitation_id).status;
    return (/MRS_NOT_FOUND/.test(e1) && /MRS_EXPIRED/.test(e2) && st === 'expired') || JSON.stringify({ e1, e2, st });
  });
  await check('reissue: old token dead, new token works', async () => {
    const re = await rpc('adminA', `SELECT public.admin_reissue_invitation($1) r`, [expInv.invitation_id]);
    let e1 = '';
    try { await as('wrong', `SELECT public.accept_invitation($1)`, [expInv.token]); } catch (e) { e1 = errText(e); }
    const pv = await rpc('anon', `SELECT public.invitation_preview($1) r`, [re.token]);
    const ok = await rpc('wrong', `SELECT public.accept_invitation($1) r`, [re.token]);
    return (re.token !== expInv.token && /MRS_NOT_FOUND/.test(e1) && pv.role === 'accountant' && ok.role === 'accountant')
      || JSON.stringify({ re, e1, pv, ok });
  });
  await expectErr('reissue of an accepted invitation → MRS_BAD_TRANSITION', () => as('adminA',
    `SELECT public.admin_reissue_invitation($1)`, [expInv.invitation_id]), /MRS_BAD_TRANSITION/);
  await expectErr('revoke of an accepted invitation → MRS_BAD_TRANSITION', () => as('adminA',
    `SELECT public.admin_revoke_invitation($1)`, [expInv.invitation_id]), /MRS_BAD_TRANSITION/);
  await check('an expired pending invitation does not block a new one for the same target', async () => {
    const a = await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, { email: 'late@example.com', role: 'accountant' }]);
    await q(`UPDATE public.invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.invitation_id]);
    const b = await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, { email: 'late@example.com', role: 'accountant' }]);
    const old = (await q(`SELECT revoked_at FROM public.invitations WHERE id = $1`, [a.invitation_id]))[0];
    return (b.invitation_id !== a.invitation_id && old.revoked_at !== null) || JSON.stringify({ a, b, old });
  });
  await check('unconfirmed e-mail → MRS_EMAIL_UNCONFIRMED, nothing granted', async () => {
    const inv = await rpc('adminA', `SELECT public.admin_invite($1, $2) r`, [A, { email: EMAIL.unconf, role: 'accountant' }]);
    let e1 = '';
    try { await as('unconf', `SELECT public.accept_invitation($1)`, [inv.token]); } catch (e) { e1 = errText(e); }
    const n = await count(`SELECT count(*)::int n FROM public.memberships WHERE user_id = $1`, [U.unconf]);
    const st = (await q(`SELECT accepted_at FROM public.invitations WHERE id = $1`, [inv.invitation_id]))[0];
    return (/MRS_EMAIL_UNCONFIRMED/.test(e1) && n === 0 && st.accepted_at === null) || JSON.stringify({ e1, n, st });
  });
  await check('invitation audit rows never contain the token hash', async () => {
    const n = await count(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'invitations'`);
    const bad = await count(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'invitations'
                              AND (coalesce(new_data, '{}') ? 'token_hash' OR coalesce(old_data, '{}') ? 'token_hash')`);
    return (n > 0 && bad === 0) || JSON.stringify({ n, bad });
  });

  /* ---------------------------------------------------------------- cross-org ids */
  section('cross-org ids on every new RPC');
  const bInv = await rpc('ownerB', `SELECT public.admin_invite($1, $2) r`, [B, { email: 'b.staff@example.com', role: 'clearance_staff', branch_id: B_BR }]);
  const bMem = (await q(`SELECT id FROM public.memberships WHERE org_id = $1 LIMIT 1`, [B]))[0].id;
  const aMem = await memId('staffD');
  const aInv = dmmInv.invitation_id;
  for (const [name, who, sql, params, re] of [
    ['adminA admin_update_org(B)', 'adminA', `SELECT public.admin_update_org($1, $2)`, [B, { name_en: 'x' }], /MRS_FORBIDDEN/],
    ['adminA admin_create_branch(B)', 'adminA', `SELECT public.admin_create_branch($1, $2)`, [B, { code: 'ZZ', name_ar: 'زز' }], /MRS_FORBIDDEN/],
    ['adminA admin_update_branch(B branch)', 'adminA', `SELECT public.admin_update_branch($1, $2)`, [B_BR, { name_ar: 'سرقة' }], /MRS_NOT_FOUND/],
    ['adminA admin_invite(B)', 'adminA', `SELECT public.admin_invite($1, $2)`, [B, { email: 'z@example.com', role: 'admin' }], /MRS_FORBIDDEN/],
    ['adminA admin_list_invitations(B)', 'adminA', `SELECT public.admin_list_invitations($1)`, [B], /MRS_FORBIDDEN/],
    ['adminA admin_revoke_invitation(B inv)', 'adminA', `SELECT public.admin_revoke_invitation($1)`, [bInv.invitation_id], /MRS_NOT_FOUND/],
    ['adminA admin_reissue_invitation(B inv)', 'adminA', `SELECT public.admin_reissue_invitation($1)`, [bInv.invitation_id], /MRS_NOT_FOUND/],
    ['adminA admin_list_members(B)', 'adminA', `SELECT public.admin_list_members($1)`, [B], /MRS_FORBIDDEN/],
    ['adminA admin_set_member_active(B membership)', 'adminA', `SELECT public.admin_set_member_active($1, false)`, [bMem], /MRS_NOT_FOUND/],
    ['ownerB admin_update_org(A)', 'ownerB', `SELECT public.admin_update_org($1, $2)`, [A, { name_en: 'x' }], /MRS_FORBIDDEN/],
    ['ownerB admin_create_branch(A)', 'ownerB', `SELECT public.admin_create_branch($1, $2)`, [A, { code: 'ZZ', name_ar: 'زز' }], /MRS_FORBIDDEN/],
    ['ownerB admin_update_branch(JED)', 'ownerB', `SELECT public.admin_update_branch($1, $2)`, [JED, { is_active: false }], /MRS_NOT_FOUND/],
    ['ownerB admin_invite(B) with org-A branch', 'ownerB', `SELECT public.admin_invite($1, $2)`, [B, { email: 'z@example.com', role: 'accountant', branch_id: JED }], /MRS_INVALID.*branch/],
    ['ownerB admin_invite(B) with org-A client', 'ownerB', `SELECT public.admin_invite($1, $2)`, [B, { email: 'z@example.com', role: 'client', client_id: CL101 }], /MRS_INVALID.*client/],
    ['ownerB admin_list_invitations(A)', 'ownerB', `SELECT public.admin_list_invitations($1)`, [A], /MRS_FORBIDDEN/],
    ['ownerB admin_revoke_invitation(A inv)', 'ownerB', `SELECT public.admin_revoke_invitation($1)`, [aInv], /MRS_NOT_FOUND/],
    ['ownerB admin_reissue_invitation(A inv)', 'ownerB', `SELECT public.admin_reissue_invitation($1)`, [aInv], /MRS_NOT_FOUND/],
    ['ownerB admin_list_members(A)', 'ownerB', `SELECT public.admin_list_members($1)`, [A], /MRS_FORBIDDEN/],
    ['ownerB admin_set_member_active(A membership)', 'ownerB', `SELECT public.admin_set_member_active($1, false)`, [aMem], /MRS_NOT_FOUND/],
    ['staffD (non-admin) admin_invite(A)', 'staffD', `SELECT public.admin_invite($1, $2)`, [A, { email: 'z@example.com', role: 'accountant', branch_id: DMM }], /MRS_FORBIDDEN/],
    ['staffD admin_list_invitations(A)', 'staffD', `SELECT public.admin_list_invitations($1)`, [A], /MRS_FORBIDDEN/],
    ['staffD admin_revoke_invitation(A inv)', 'staffD', `SELECT public.admin_revoke_invitation($1)`, [aInv], /MRS_NOT_FOUND/],
    ['staffD admin_update_branch(DMM)', 'staffD', `SELECT public.admin_update_branch($1, $2)`, [DMM, { name_ar: 'x' }], /MRS_NOT_FOUND/],
    ['anon admin_list_invitations', 'anon', `SELECT public.admin_list_invitations($1)`, [A], /permission denied/],
    ['anon platform_list_orgs', 'anon', `SELECT public.platform_list_orgs()`, [], /permission denied/]
  ]) await expectErr('refused: ' + name, () => as(who, sql, params), re);
  await check('ownerB invitation SELECT sees only org B', async () => {
    const r = await as('ownerB', `SELECT DISTINCT org_id FROM public.invitations`);
    return (r.length === 1 && r[0].org_id === B) || JSON.stringify(r);
  });
  await check('adminA invitation SELECT sees only org A', async () => {
    const r = await as('adminA', `SELECT DISTINCT org_id FROM public.invitations`);
    return (r.length === 1 && r[0].org_id === A) || JSON.stringify(r);
  });
  await check('accepting an org-B invitation never grants org-A access', async () => {
    const tx = (await as('ownerB', `SELECT count(*)::int n FROM public.transactions WHERE org_id = $1`, [A]))[0].n;
    const cl = (await as('ownerB', `SELECT count(*)::int n FROM public.clients WHERE org_id = $1`, [A]))[0].n;
    return (tx === 0 && cl === 0) || JSON.stringify({ tx, cl });
  });

  /* ---------------------------------------------------------------- idempotency is per org */
  section('idempotency keys are bound to the org');
  await check('same key + same payload sent to org A then org B → MRS_IDEMPOTENCY_CONFLICT, nothing in B', async () => {
    await q(`INSERT INTO public.memberships (user_id, org_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin')`, [U.dual, A, B]);
    const p = { email: 'dual.target@example.com', role: 'supervisor', idempotencyKey: KEY4 };
    const a = await rpc('dual', `SELECT public.admin_invite($1, $2) r`, [A, p]);
    let e1 = '';
    try { await as('dual', `SELECT public.admin_invite($1, $2)`, [B, p]); } catch (e) { e1 = errText(e); }
    const nb = await count(`SELECT count(*)::int n FROM public.invitations WHERE org_id = $1 AND email = 'dual.target@example.com'`, [B]);
    await q(`UPDATE public.memberships SET is_active = false WHERE user_id = $1`, [U.dual]);
    return (a.invitation_id && /MRS_IDEMPOTENCY_CONFLICT/.test(e1) && nb === 0) || JSON.stringify({ a, e1, nb });
  });

  /* ---------------------------------------------------------------- platform re-issue of a lost admin link */
  section('platform_reissue_admin_invitation');
  const orgC = { slug: 'org-charlie', name_ar: 'مؤسسة تشارلي التجريبية', ref_prefix: 'chl',
    branch: { code: 'abh', name_ar: 'فرع أبها' }, admin_email: EMAIL.ownerC, idempotencyKey: KEY5 };
  const c1 = await rpc('plat', `SELECT public.platform_create_org($1) r`, [orgC]);
  const C = c1.org_id;
  await check('replayed create (lost link) → token null; platform re-issue returns a new working token, old one dead', async () => {
    const re = await rpc('plat', `SELECT public.platform_create_org($1) r`, [orgC]);
    const ri = await rpc('plat', `SELECT public.platform_reissue_admin_invitation($1) r`, [C]);
    let e1 = '';
    try { await as('anon', `SELECT public.invitation_preview($1)`, [c1.token]); } catch (e) { e1 = errText(e); }
    const pv = await rpc('anon', `SELECT public.invitation_preview($1) r`, [ri.token]);
    return (re.token === null && re.replayed === true && /^[0-9a-f]{64}$/.test(ri.token) && ri.token !== c1.token
      && ri.invitation_id === c1.invitation_id && ri.accept_path === 'login.html?invite=' + ri.token
      && /MRS_NOT_FOUND/.test(e1) && pv.role === 'admin') || JSON.stringify({ re, ri, e1, pv });
  });
  for (const who of ['adminA', 'ownerB', 'bmJ']) {
    await expectErr(`${who} refused on platform_reissue_admin_invitation`, () => as(who,
      `SELECT public.platform_reissue_admin_invitation($1)`, [C]), /MRS_FORBIDDEN/);
  }
  await expectErr('anon cannot call platform_reissue_admin_invitation', () => as('anon',
    `SELECT public.platform_reissue_admin_invitation($1)`, [C]), /permission denied/);
  await expectErr('platform re-issue for an org that already has an admin (B) → MRS_BAD_TRANSITION', () => as('plat',
    `SELECT public.platform_reissue_admin_invitation($1)`, [B]), /MRS_BAD_TRANSITION.*admin_exists/);
  await check('after the owner accepts, platform re-issue is refused (tenant manages itself)', async () => {
    const ri = await rpc('plat', `SELECT public.platform_reissue_admin_invitation($1) r`, [C]);
    const acc = await rpc('ownerC', `SELECT public.accept_invitation($1) r`, [ri.token]);
    let e1 = '';
    try { await as('plat', `SELECT public.platform_reissue_admin_invitation($1)`, [C]); } catch (e) { e1 = errText(e); }
    return (acc.role === 'admin' && acc.org_id === C && /MRS_BAD_TRANSITION.*admin_exists|MRS_NOT_FOUND/.test(e1)) || JSON.stringify({ acc, e1 });
  });

  /* ---------------------------------------------------------------- last-admin guard kept */
  section('member guards kept');
  await expectErr('adminA cannot deactivate itself', async () => as('adminA', `SELECT public.admin_set_member_active($1, false)`, [await memId('adminA')]), /MRS_FORBIDDEN/);
  await expectErr('ownerB (last admin of B) cannot deactivate itself', () => as('ownerB',
    `SELECT public.admin_set_member_active($1, false)`, [accepted.membership_id]), /MRS_FORBIDDEN/);

  finish();
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
  process.exit(nFail ? 1 : 0);
}

main().catch(e => { fail('runner', errText(e)); finish(); });
