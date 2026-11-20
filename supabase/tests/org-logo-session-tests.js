#!/usr/bin/env node
/*
  Marsa (مرسى) — the organisation logo (migration 20261202000100_org_logo.sql + assets/js/supa.js orgLogoUrl / uploadOrgLogo /
  removeOrgLogo) and the 12-hour session cap (supa.js getSession → sessionCap, MARSA_CONFIG.sessionMaxHours).
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).
  Invented data only (seed org "blue-sea" + made-up users).

  Covers: file conventions + all_migrations.sql; preflight refusal; re-run on itself (identical catalog);
    bucket 'org-assets' private / png-jpeg-webp only / 1 MiB; storage.objects policies — insert / update / delete by the org admin
    only (logo-<digits>.<png|jpg|webp> names, the org's own folder), read by staff + portal users of the org, never by another org,
    an inactive member, anon, a deeper / malformed path; helper privileges; my_context + logo_path / org_logo_path (staff, portal,
    unset → null, the other keys unchanged); admin_update_org still refuses another org's folder;
    supa.js (vm, fake client) — orgLogoUrl (path check, own-origin signed URL), uploadOrgLogo (type / size checks, the path, the
    admin_update_org payload, the old object removed, a failed update removes the new object), removeOrgLogo; the session cap with
    a fake clock: default 12 h / config / 0 disables, fresh session kept + sessionExpiresAt, an over-cap session on an app page →
    local sign-out + login.html?expired=1&next=…#staff|#client, on login.html → sign-out without redirect (no loop), no URL
    exempts a stale session (an e-mail link session counts from its own sign-in), the cap counts from the session's own amr
    time (not user.last_sign_in_at), clock-skew correction (iat / exp), a failed logout call (stored session removed / retried),
    the expiry timer, the last_sign_in_at fallback; ES5 in the new code.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/org-logo-session-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261202000100_org_logo.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const SUPA_JS = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in org-logo-session-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'e1060000-0000-4000-8000-0000000000b0';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const CL_B = 'e1060000-0000-4000-8000-0000000000b3';
const U = {
  admin: 'e1061000-0000-4000-8000-000000000001',    // org-wide admin of A
  staff: 'e1061000-0000-4000-8000-000000000002',    // clearance_staff of A (not admin)
  gone: 'e1061000-0000-4000-8000-000000000003',     // inactive admin of A
  portal: 'e1061000-0000-4000-8000-000000000004',   // portal user of CLIENT_A
  adminB: 'e1061000-0000-4000-8000-000000000005',   // admin of B
  portalB: 'e1061000-0000-4000-8000-000000000006'   // portal user of CL_B
};
const LOGO_A = A + '/logo-1763300000000.png';
const LOGO_B = B + '/logo-1763300000001.webp';

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[who], role: 'authenticated', aal: 'aal1' })]);
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
    if (/row-level security/.test(m)) return 'rls';
    if (/permission denied/.test(m)) return 'perm';
    return errText(e);
  }
}
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
async function catalog() {
  return q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig, md5(p.prosrc) h, coalesce(p.proacl::text, '') acl
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public')
            UNION ALL SELECT 'pol:' || schemaname || '.' || tablename || '.' || policyname, md5(coalesce(qual, '') || coalesce(with_check, '') || cmd), ''
              FROM pg_policies WHERE schemaname IN ('public','storage')
            UNION ALL SELECT 'bucket:' || id, md5(public::text || coalesce(file_size_limit::text, '') || coalesce(allowed_mime_types::text, '')), ''
              FROM storage.buckets ORDER BY 1`);
}
const objIns = (who, name, bucket) => as(who, `INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ($1, $2, $3, '{"size": 1000, "mimetype": "image/png"}')`,
  [bucket || 'org-assets', name, U[who] || null]);
const objSeen = (who, name) => as(who, `SELECT name FROM storage.objects WHERE bucket_id = 'org-assets' AND name = $1`, [name]).then(r => r.length);

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@logo.example.com', now()), ('${U.staff}', 'staff@logo.example.com', now()), ('${U.gone}', 'gone@logo.example.com', now()),
    ('${U.portal}', 'portal@logo.example.com', now()), ('${U.adminB}', 'adminb@logo.example.com', now()), ('${U.portalB}', 'portalb@logo.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'مدير تجريبي'), ('${U.staff}', 'موظف تجريبي'), ('${U.gone}', 'مدير سابق'),
    ('${U.portal}', 'عميل البوابة'), ('${U.adminB}', 'مدير ب'), ('${U.portalB}', 'عميل ب')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'logo-org-b', 'مؤسسة ب', 'Logo org B', 'LGB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', 'Client B Co', '0509990001');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role, is_active) VALUES
    ('${U.admin}', '${A}', NULL, 'admin', true), ('${U.staff}', '${A}', NULL, 'clearance_staff', true),
    ('${U.gone}', '${A}', NULL, 'admin', false), ('${U.adminB}', '${B}', NULL, 'admin', true);
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner'),
    ('${B}', '${CL_B}', '${U.portalB}', 'owner');
`;

/* ------------------------------------------------------------------ 1. file */
async function secFile() {
  section('1. file + all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('migration: preflight on legacy_gaps (20261201000100), schema_versions row, no BEGIN/COMMIT, down-path, search_path pinned', () => {
    const fns = (s.match(/CREATE OR REPLACE FUNCTION/g) || []).length, pinned = (s.match(/SET search_path = ''/g) || []).length;
    return (/version = '20261201000100'/.test(s) && /VALUES \('20261202000100', 'org_logo'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s)
      && /Down-path:/.test(s) && fns === 3 && pinned === 3) || J({ fns, pinned });
  });
  await check('no aal2 / MFA requirement re-introduced (mfa_off stays in force)', () =>
    !/aal2|mfa_gated_roles\s*\(\)\s*RETURNS|mfa_required_for\s*\(uuid\)\s*RETURNS/.test(s.replace(/^--.*$/gm, '')) || 'aal2 found');
  await check('bucket: images only, no SVG', () => /ARRAY\['image\/png','image\/jpeg','image\/webp'\]/.test(s) && !/svg/i.test(s.replace(/^--.*$/gm, '')) || 'mime list');
  // later phases (each has its own suite) follow it, in order
  const LATER_PHASES = ['20261203000100_draft_client_hidden.sql', '20261204000100_tx_stage_sets.sql', '20261205000100_service_item_price.sql', '20261206000100_storage_gate.sql'];
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
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const later = order.slice(order.indexOf(MIG) + 1);
    return (i > 0 && body === s && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles()) && J(later) === J(LATER_PHASES))
      || 'not appended verbatim / no note / order / later ' + J(later);
  });
}

/* ------------------------------------------------------------------ 2. preflight + re-run */
async function secRerun() {
  section('2. preflight + re-run');
  await check('preflight: refused without legacy_gaps (nothing changed)', async () => {
    await q(`DELETE FROM public.schema_versions WHERE version = '20261201000100'`);
    const c0 = J(await catalog());
    const r = await code(() => db.exec(fs.readFileSync(MIG_FILE, 'utf8')));
    await q(`INSERT INTO public.schema_versions (version, name) VALUES ('20261201000100', 'legacy_gaps')`);
    return (/ORG LOGO preflight/.test(r) && J(await catalog()) === c0) || r;
  });
  await check('re-run on itself: identical catalog (functions, policies, buckets), one schema_versions row', async () => {
    const c1 = J(await catalog());
    await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
    return (J(await catalog()) === c1 && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261202000100'`)) === 1) || 'changed';
  });
  await check('helpers: org_asset_org not executable by API roles; org_asset_can authenticated only; my_context authenticated only', async () => {
    const r = await one(`SELECT has_function_privilege('authenticated', 'app.org_asset_org(text)', 'EXECUTE') a,
                                has_function_privilege('anon', 'app.org_asset_org(text)', 'EXECUTE') b,
                                has_function_privilege('authenticated', 'app.org_asset_can(text,text)', 'EXECUTE') c,
                                has_function_privilege('anon', 'app.org_asset_can(text,text)', 'EXECUTE') d,
                                has_function_privilege('anon', 'public.my_context()', 'EXECUTE') e,
                                has_function_privilege('authenticated', 'public.my_context()', 'EXECUTE') f`);
    return (!r.a && !r.b && r.c && !r.d && !r.e && r.f) || J(r);
  });
  await check('policies: the four marsa_org_assets_* on storage.objects, TO authenticated only', async () => {
    const r = await q(`SELECT policyname, cmd, roles::text roles FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                         AND policyname LIKE 'marsa_org_assets_%' ORDER BY 1`);
    return (J(r.map(x => x.policyname + ':' + x.cmd)) === J(['marsa_org_assets_delete:DELETE', 'marsa_org_assets_insert:INSERT', 'marsa_org_assets_read:SELECT', 'marsa_org_assets_update:UPDATE'])
      && r.every(x => x.roles === '{authenticated}')) || J(r);
  });
}

/* ------------------------------------------------------------------ 3. bucket + policies */
async function secBucket() {
  section('3. bucket org-assets + storage.objects policies');
  await check('bucket org-assets: private, 1 MiB, png / jpeg / webp', async () => {
    const b = await one(`SELECT public, file_size_limit, allowed_mime_types::text m FROM storage.buckets WHERE id = 'org-assets'`);
    return (b && b.public === false && Number(b.file_size_limit) === 1048576 && b.m === '{image/png,image/jpeg,image/webp}') || J(b);
  });
  await check('org_asset_org: well-formed names only', async () => {
    const r = await one(`SELECT app.org_asset_org($1) a, app.org_asset_org($2) b, app.org_asset_org($3) c, app.org_asset_org($4) d, app.org_asset_org($5) e, app.org_asset_org(NULL) f`,
      [LOGO_A, A + '/x/logo-1.png', A.toUpperCase() + '/logo-1763300000000.png', A + '/..png', 'not-a-uuid/logo.png']);
    return (r.a === A && r.b === null && r.c === null && r.d === null && r.e === null && r.f === null) || J(r);
  });
  await check('admin of A uploads a logo into A\'s folder', async () => (await code(() => objIns('admin', LOGO_A))) === 'ok' || 'refused');
  await check('admin of A: other names refused (wrong file name, svg, deeper path, other org folder, no folder)', async () => {
    const r = [];
    for (const n of [A + '/evil.png', A + '/logo-1763300000000.svg', A + '/logo-176.png', A + '/sub/logo-1763300000000.png', B + '/logo-1763300000000.png', 'logo-1763300000000.png', A + '/logo-1763300000000.PNG'])
      r.push(await code(() => objIns('admin', n)));
    return r.every(x => x === 'rls') || J(r);
  });
  await check('staff (not admin) / inactive admin / portal user / admin of B / anon cannot upload into A', async () => {
    const r = [];
    for (const who of ['staff', 'gone', 'portal', 'adminB']) r.push(who + ':' + await code(() => objIns(who, A + '/logo-1763300000009.png')));
    r.push('anon:' + await code(() => objIns('anon', A + '/logo-1763300000009.png')));
    return r.every(x => /:(rls|perm)$/.test(x)) || J(r);
  });
  await check('admin of B uploads into B; the documents bucket rules are untouched (no document row → refused)', async () => {
    const okB = await code(() => objIns('adminB', LOGO_B));
    const doc = await code(() => objIns('admin', A + '/' + B + '/' + B + '/x.pdf', 'documents'));
    return (okB === 'ok' && doc === 'rls') || J({ okB, doc });
  });
  await check('read: admin, staff, portal user of A see A\'s logo; admin / portal of B, inactive admin, anon do not', async () => {
    const r = {};
    for (const who of ['admin', 'staff', 'portal', 'adminB', 'portalB', 'gone']) r[who] = await objSeen(who, LOGO_A);
    r.anon = await asRole('anon', () => q(`SELECT name FROM storage.objects WHERE bucket_id = 'org-assets'`)).then(x => x.length, () => -1);
    return (r.admin === 1 && r.staff === 1 && r.portal === 1 && r.adminB === 0 && r.portalB === 0 && r.gone === 0 && r.anon <= 0) || J(r);
  });
  await check('read: portal user of B sees B\'s logo only', async () => {
    const r = await as('portalB', `SELECT name FROM storage.objects WHERE bucket_id = 'org-assets' ORDER BY 1`);
    return J(r.map(x => x.name)) === J([LOGO_B]) || J(r);
  });
  await check('a deactivated portal link no longer reads the logo', async () => {
    await q(`UPDATE public.client_users SET is_active = false WHERE user_id = $1`, [U.portal]);
    const n = await objSeen('portal', LOGO_A);
    await q(`UPDATE public.client_users SET is_active = true WHERE user_id = $1`, [U.portal]);
    return n === 0 || 'still sees ' + n;
  });
  await check('a malformed name in the bucket (service role) is read by nobody', async () => {
    await q(`INSERT INTO storage.objects (bucket_id, name) VALUES ('org-assets', $1)`, [A + '/sub/odd.png']);
    const n = (await objSeen('admin', A + '/sub/odd.png')) + (await objSeen('staff', A + '/sub/odd.png'));
    return n === 0 || 'seen ' + n;
  });
  await check('update: admin of A may, staff / admin of B may not (0 rows)', async () => {
    const st = await as('staff', `UPDATE storage.objects SET metadata = '{"size": 900}' WHERE bucket_id = 'org-assets' AND name = $1 RETURNING 1`, [LOGO_A]);
    const ob = await as('adminB', `UPDATE storage.objects SET metadata = '{"size": 900}' WHERE bucket_id = 'org-assets' AND name = $1 RETURNING 1`, [LOGO_A]);
    const ad = await as('admin', `UPDATE storage.objects SET metadata = '{"size": 900}' WHERE bucket_id = 'org-assets' AND name = $1 RETURNING 1`, [LOGO_A]);
    return (st.length === 0 && ob.length === 0 && ad.length === 1) || J({ st: st.length, ob: ob.length, ad: ad.length });
  });
  await check('update: admin cannot rename an object to a bad name / into another org', async () => {
    const a = await code(() => as('admin', `UPDATE storage.objects SET name = $2 WHERE bucket_id = 'org-assets' AND name = $1`, [LOGO_A, A + '/evil.png']));
    const b = await code(() => as('admin', `UPDATE storage.objects SET name = $2 WHERE bucket_id = 'org-assets' AND name = $1`, [LOGO_A, B + '/logo-1763300000000.png']));
    return (a === 'rls' && b === 'rls') || J({ a, b });
  });
  await check('delete: staff / portal / admin of B remove nothing; admin of A removes A\'s object', async () => {
    const extra = A + '/logo-1763300000002.jpg';
    await objIns('admin', extra);
    const st = await as('staff', `DELETE FROM storage.objects WHERE bucket_id = 'org-assets' AND name = $1 RETURNING 1`, [extra]);
    const po = await as('portal', `DELETE FROM storage.objects WHERE bucket_id = 'org-assets' AND name = $1 RETURNING 1`, [extra]);
    const ob = await as('adminB', `DELETE FROM storage.objects WHERE bucket_id = 'org-assets' RETURNING name`);
    const ad = await as('admin', `DELETE FROM storage.objects WHERE bucket_id = 'org-assets' AND name = $1 RETURNING 1`, [extra]);
    const left = await num(`SELECT count(*) n FROM storage.objects WHERE bucket_id = 'org-assets' AND name = ANY ($1)`, [[LOGO_A, LOGO_B]]);
    return (st.length === 0 && po.length === 0 && ob.length === 1 && ob[0].name === LOGO_B && ad.length === 1 && left === 1) || J({ st: st.length, po: po.length, ob, ad: ad.length, left });
  });
}

/* ------------------------------------------------------------------ 4. my_context */
async function secContext() {
  section('4. my_context + logo_path / org_logo_path');
  await check('unset logo → organizations[].logo_path / memberships[].org_logo_path null; mfa object and other keys kept', async () => {
    const c = await rpc('admin', `SELECT public.my_context() r`);
    const o = (c.organizations || []).find(x => x.org_id === A), m = (c.memberships || []).find(x => x.org_id === A);
    return (o && 'logo_path' in o && o.logo_path === null && m && 'org_logo_path' in m && m.org_logo_path === null
      && c.mfa && c.mfa.required === false && m.org_slug && m.role === 'admin' && J(o.roles) === J(['admin'])
      && 'mfa_locked' in m && m.mfa_locked === false) || J({ o, m, mfa: c.mfa });
  });
  await check('admin_update_org(settings.logo_path) → my_context returns the path (admin, staff); org B untouched', async () => {
    await rpc('admin', `SELECT public.admin_update_org($1, $2) r`, [A, { settings: { logo_path: LOGO_A } }]);
    const ca = await rpc('admin', `SELECT public.my_context() r`), cs = await rpc('staff', `SELECT public.my_context() r`), cb = await rpc('adminB', `SELECT public.my_context() r`);
    const pa = ca.organizations.find(x => x.org_id === A).logo_path, ma = ca.memberships.find(x => x.org_id === A).org_logo_path;
    const ps = cs.organizations.find(x => x.org_id === A).logo_path, pb = cb.organizations.find(x => x.org_id === B).logo_path;
    return (pa === LOGO_A && ma === LOGO_A && ps === LOGO_A && pb === null) || J({ pa, ma, ps, pb });
  });
  await check('portal user: clients[].org_logo_path is the org\'s logo', async () => {
    const c = await rpc('portal', `SELECT public.my_context() r`);
    const cl = (c.clients || []).find(x => x.client_id === CLIENT_A);
    return (cl && cl.org_logo_path === LOGO_A && cl.org_id === A && cl.link_role === 'owner') || J(c.clients);
  });
  await check('admin_update_org still refuses a path in another org\'s folder / a URL; staff cannot set it', async () => {
    const a = await code(() => rpc('admin', `SELECT public.admin_update_org($1, $2) r`, [A, { settings: { logo_path: LOGO_B } }]));
    const b = await code(() => rpc('admin', `SELECT public.admin_update_org($1, $2) r`, [A, { settings: { logo_path: 'https://evil.example.com/x.png' } }]));
    const c = await code(() => rpc('staff', `SELECT public.admin_update_org($1, $2) r`, [A, { settings: { logo_path: LOGO_A } }]));
    return (/MRS_INVALID logo_path/.test(a) && /MRS_INVALID logo_path/.test(b) && /MRS_FORBIDDEN/.test(c)) || J({ a, b, c });
  });
  await check('logo_path null removes it (my_context null again)', async () => {
    await rpc('admin', `SELECT public.admin_update_org($1, $2) r`, [A, { settings: { logo_path: null } }]);
    const c = await rpc('admin', `SELECT public.my_context() r`);
    return c.organizations.find(x => x.org_id === A).logo_path === null || 'still set';
  });
}

/* ------------------------------------------------------------------ 5. supa.js (vm) */
const SUPA_URL = 'https://example.supabase.co';
function boot(o) {
  o = o || {};
  const calls = { rpc: [], signOut: [], upload: [], remove: [], signed: [], replace: [], timers: [] };
  let now = o.now || Date.UTC(2026, 10, 16, 8, 0, 0);
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  }
  const state = { session: o.session === undefined ? null : o.session, ctx: o.ctx || { memberships: [], organizations: [], clients: [] } };
  const store = o.storeBacked ? { marsa_auth: '{}' } : {};
  const result = d => { const p = Promise.resolve(d); p.abortSignal = () => p; return p; };
  const client = {
    rpc: (name, a) => {
      calls.rpc.push({ fn: name, args: a });
      if (name === 'my_context') return result({ data: state.ctx, error: null });
      if (name === 'admin_update_org') return result(o.updateError ? { data: null, error: { message: 'MRS_FORBIDDEN', code: 'P0001', details: '' } } : { data: { id: a.p_org, settings: a.p_payload.settings }, error: null });
      return result({ data: null, error: null });
    },
    from: () => { const b = {}; ['select', 'eq', 'is', 'order', 'limit', 'maybeSingle', 'single'].forEach(m => { b[m] = () => b; }); b.then = (r) => Promise.resolve({ data: null, error: null }).then(r); return b; },
    storage: {
      from: (bucket) => ({
        createSignedUrl: (p, s) => { calls.signed.push({ bucket, p, s }); return Promise.resolve({ data: { signedUrl: (o.foreign ? 'https://evil.example.com' : SUPA_URL) + '/storage/v1/object/sign/' + bucket + '/' + p + '?token=t' }, error: null }); },
        upload: (p, file, opt) => { calls.upload.push({ bucket, p, opt }); return Promise.resolve(o.uploadError ? { data: null, error: { message: 'boom' } } : { data: { path: p }, error: null }); },
        remove: (list) => { calls.remove.push({ bucket, list }); return Promise.resolve({ data: [], error: null }); }
      })
    },
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      // storeBacked: the session lives under localStorage 'marsa_auth' (removing that key ends it)
      getSession: () => Promise.resolve({ data: { session: o.storeBacked && !('marsa_auth' in store) ? null : state.session }, error: null }),
      signOut: (opt) => {
        calls.signOut.push(opt || null);
        if (o.signOutError) return Promise.resolve({ error: { message: 'Failed to fetch', status: 0 } });   // supabase-js keeps the stored session
        state.session = null; return Promise.resolve({ error: null });
      }
    }
  };
  const loc = Object.assign({ origin: 'http://127.0.0.1:8000', hostname: '127.0.0.1', pathname: '/admin.html', search: '', hash: '' }, o.location || {});
  loc.href = loc.origin + loc.pathname + loc.search + loc.hash;
  loc.replace = (u) => { calls.replace.push(u); };
  const cfg = Object.assign({ supabaseUrl: SUPA_URL, supabaseAnonKey: 'test-anon-key-not-real', orgSlug: 'blue-sea' }, o.cfg || {});
  const win = { MARSA_CONFIG: cfg, supabase: { createClient: () => client }, addEventListener() {}, dispatchEvent() {}, location: loc };
  const fakeSetTimeout = (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; };
  const ctx = { window: win, document: { currentScript: null, head: { appendChild() {} }, createElement: () => ({}), addEventListener() {},
      documentElement: { setAttribute() {}, getAttribute: () => null, hasAttribute: () => false }, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { onLine: true }, location: loc, console, setTimeout: fakeSetTimeout, clearTimeout() {}, Promise, CustomEvent: function () {},
    crypto: require('crypto').webcrypto, URL, Date: FakeDate, Math, JSON, atob: s => Buffer.from(s, 'base64').toString('binary') };
  win.window = win;
  vm.createContext(ctx); vm.runInContext(SUPA_JS, ctx, { filename: 'supa.js' });
  return { api: win.MarsaApi, calls, state, store, setNow: t => { now = t; }, now: () => now };
}
const HOUR = 3600000;
const T0 = Date.UTC(2026, 10, 16, 8, 0, 0);
const sess = (signedAgoMs, extra) => Object.assign({ access_token: 'x.e30.y', user: { id: U.admin, email: 'admin@logo.example.com', last_sign_in_at: new Date(T0 - signedAgoMs).toISOString() } }, extra || {});
const fakeFile = (type, size) => ({ name: 'logo.' + (type.split('/')[1] || 'bin'), type, size });
function jwtWith(claims) { return 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.s'; }

async function secSupaStatic() {
  section('5. supa.js: wrappers, strings, ES5');
  const pick = (name) => (SUPA_JS.match(new RegExp('\\n  function ' + name + '\\([\\s\\S]*?\\n  \\}\\n')) || [''])[0];
  const block = (SUPA_JS.match(/\/\* ---- session cap[\s\S]*?\n  function sessionExpiresAt[\s\S]*?\n  \}\n/) || [''])[0]
    + (SUPA_JS.match(/\n  var LOGO_BUCKET[\s\S]*?\n  function classifyDocument/) || [''])[0] + pick('getSession');
  await check('new code present (cap block, logo block, getSession hook)', () => block.length > 3000 && /sessionCap\(r\.data\)/.test(block) || 'blocks missing');
  await check('new code is ES5 (no arrow functions / let / const / template strings)', () => !/=>|`|\blet\s|\bconst\s/.test(block) || 'ES6 found');
  await check('localStorage only inside try/catch in the new code', () => {
    const uses = block.split('\n').filter(l => /localStorage/.test(l));
    return (uses.length > 0 && uses.every(l => /try \{ localStorage\.\w+\([^)]*\); \} catch \(e\)/.test(l))) || J(uses);
  });
  await check('no URL-based exemption from the cap is left (LINK_FLOW_AT_LOAD removed)', () => !/LINK_FLOW_AT_LOAD/.test(SUPA_JS) || 'still there');
  await check('exports: orgLogoUrl, uploadOrgLogo, removeOrgLogo, orgLogoPathOf, sessionMaxHours, sessionExpiresAt', () =>
    ['orgLogoUrl: orgLogoUrl', 'uploadOrgLogo: uploadOrgLogo', 'removeOrgLogo: removeOrgLogo', 'orgLogoPathOf: orgLogoPathOf', 'sessionMaxHours: function', 'sessionExpiresAt: sessionExpiresAt']
      .every(x => SUPA_JS.includes(x)) || 'missing export');
  await check('new error codes have Arabic (AR.errors) and English (err register) texts', () =>
    ['MRS_LOGO_TYPE', 'MRS_LOGO_TOO_LARGE', 'MRS_SESSION_EXPIRED'].every(k => (SUPA_JS.match(new RegExp('\\n\\s+' + k + ": '", 'g')) || []).length === 2)
    && /MRS_LOGO_TYPE: 'صيغة/.test(SUPA_JS) && /MRS_LOGO_TYPE: 'This logo/.test(SUPA_JS) || 'strings');
  await check('the expiry sign-out is local (never signs the other devices out)', () => /signOut\(\{ scope: 'local' \}\)/.test(block) || 'scope');
}

async function secSupaLogo() {
  section('6. supa.js: organisation logo (vm)');
  await check('orgLogoUrl(path) → signed URL from org-assets (600 s default); empty → null; bad path refused without a call', async () => {
    const b = boot();
    const r = await b.api.orgLogoUrl(LOGO_A);
    const e = await b.api.orgLogoUrl('');
    const bad = [];
    for (const p of ['https://evil.example.com/x.png', A + '/../x.png', '../' + A + '/logo.png', A + '/a/b.png', 42]) bad.push(await b.api.orgLogoUrl(p));
    return (r.data && r.data.indexOf(SUPA_URL + '/') === 0 && b.calls.signed.length === 1 && b.calls.signed[0].bucket === 'org-assets' && b.calls.signed[0].s === 600
      && e.data === null && !e.error && bad.every(x => x.error && x.error.code === 'MRS_INVALID')) || J({ r, e, bad, s: b.calls.signed });
  });
  await check('orgLogoUrl: a signed URL on a foreign origin is refused; expiresIn clamped 60..3600', async () => {
    const f = boot({ foreign: true });
    const r = await f.api.orgLogoUrl(LOGO_A);
    const b = boot();
    await b.api.orgLogoUrl(LOGO_A, 5); await b.api.orgLogoUrl(LOGO_A, 99999);
    return (r.error && r.error.code === 'MRS_INVALID' && b.calls.signed[0].s === 60 && b.calls.signed[1].s === 3600) || J({ r, s: b.calls.signed });
  });
  await check('orgLogoPathOf(ctx, org) reads organizations / memberships / clients; ignores malformed paths', () => {
    const b = boot();
    const p1 = b.api.orgLogoPathOf({ organizations: [{ org_id: A, logo_path: LOGO_A }] }, A);
    const p2 = b.api.orgLogoPathOf({ memberships: [{ org_id: B, org_logo_path: LOGO_B }] }, B);
    const p3 = b.api.orgLogoPathOf({ clients: [{ org_id: A, org_logo_path: LOGO_A }] }, A);
    const p4 = b.api.orgLogoPathOf({ organizations: [{ org_id: A, logo_path: 'https://evil.example.com/a.png' }] }, A);
    const p5 = b.api.orgLogoPathOf(null, A);
    return (p1 === LOGO_A && p2 === LOGO_B && p3 === LOGO_A && p4 === null && p5 === null) || J([p1, p2, p3, p4, p5]);
  });
  await check('uploadOrgLogo: svg / gif / empty / > 1 MB / no file / bad org refused before any call', async () => {
    const b = boot();
    const r = [await b.api.uploadOrgLogo(A, fakeFile('image/svg+xml', 500)), await b.api.uploadOrgLogo(A, fakeFile('image/gif', 500)),
      await b.api.uploadOrgLogo(A, fakeFile('image/png', 0)), await b.api.uploadOrgLogo(A, fakeFile('image/png', 1048577)),
      await b.api.uploadOrgLogo(A, null), await b.api.uploadOrgLogo('blue-sea', fakeFile('image/png', 500))];
    const codes = r.map(x => x.error && x.error.code);
    return (J(codes) === J(['MRS_LOGO_TYPE', 'MRS_LOGO_TYPE', 'MRS_LOGO_TOO_LARGE', 'MRS_LOGO_TOO_LARGE', 'MRS_REQUIRED', 'MRS_INVALID'])
      && b.calls.upload.length === 0 && b.calls.rpc.length === 0) || J({ codes, u: b.calls.upload, rpc: b.calls.rpc });
  });
  await check('uploadOrgLogo(org, png) → org-assets/<org>/logo-<now>.png (no upsert) → admin_update_org settings.logo_path → old object removed', async () => {
    const old = A + '/logo-1763000000000.webp';
    const b = boot({ ctx: { organizations: [{ org_id: A, logo_path: old }], memberships: [], clients: [] } });
    const r = await b.api.uploadOrgLogo(A, fakeFile('image/png', 2048));
    const want = A + '/logo-' + T0 + '.png';
    const u = b.calls.upload[0], up = b.calls.rpc.filter(x => x.fn === 'admin_update_org')[0];
    return (!r.error && r.data.logo_path === want && u && u.bucket === 'org-assets' && u.p === want && u.opt.upsert === false && u.opt.contentType === 'image/png'
      && up && up.args.p_org === A && J(up.args.p_payload) === J({ settings: { logo_path: want } })
      && J(b.calls.remove) === J([{ bucket: 'org-assets', list: [old] }])) || J({ r, calls: b.calls });
  });
  await check('uploadOrgLogo: jpeg → .jpg, webp → .webp; no old logo → nothing removed', async () => {
    const b = boot();
    const r1 = await b.api.uploadOrgLogo(A, fakeFile('image/jpeg', 10)), r2 = await b.api.uploadOrgLogo(A, fakeFile('image/webp', 10));
    return (/\/logo-\d+\.jpg$/.test(r1.data.logo_path) && /\/logo-\d+\.webp$/.test(r2.data.logo_path) && b.calls.remove.length === 0) || J({ r1, r2, rm: b.calls.remove });
  });
  await check('uploadOrgLogo: a refused path update removes the new object again and returns the error', async () => {
    const b = boot({ updateError: true });
    const r = await b.api.uploadOrgLogo(A, fakeFile('image/png', 10));
    return (r.error && b.calls.upload.length === 1 && J(b.calls.remove) === J([{ bucket: 'org-assets', list: [b.calls.upload[0].p] }])) || J({ r, calls: b.calls });
  });
  await check('uploadOrgLogo: a failed upload → MRS_UPLOAD, no path update', async () => {
    const b = boot({ uploadError: true });
    const r = await b.api.uploadOrgLogo(A, fakeFile('image/png', 10));
    return (r.error && r.error.code === 'MRS_UPLOAD' && b.calls.rpc.filter(x => x.fn === 'admin_update_org').length === 0) || J({ r, rpc: b.calls.rpc });
  });
  await check('removeOrgLogo(org) → settings.logo_path null, then the object removed', async () => {
    const b = boot({ ctx: { organizations: [{ org_id: A, logo_path: LOGO_A }], memberships: [], clients: [] } });
    const r = await b.api.removeOrgLogo(A);
    const up = b.calls.rpc.filter(x => x.fn === 'admin_update_org')[0];
    return (!r.error && r.data.logo_path === null && up && J(up.args.p_payload) === J({ settings: { logo_path: null } })
      && J(b.calls.remove) === J([{ bucket: 'org-assets', list: [LOGO_A] }])) || J({ r, calls: b.calls });
  });
  await check('demo mode (no config): logo calls → MRS_DEMO_MODE, orgLogoUrl(empty) → null', async () => {
    const b = boot({ cfg: { supabaseUrl: '', supabaseAnonKey: '' } });
    const u = await b.api.uploadOrgLogo(A, fakeFile('image/png', 10)), r = await b.api.removeOrgLogo(A), e = await b.api.orgLogoUrl(null);
    return (u.error.code === 'MRS_DEMO_MODE' && r.error.code === 'MRS_DEMO_MODE' && e.data === null) || J({ u, r, e });
  });
}

async function secSupaCap() {
  section('7. supa.js: the session cap (fake clock)');
  await check('sessionMaxHours(): 12 by default; config 8 → 8; 0 → 0 (disabled); invalid → 12', () => {
    const r = [boot().api.sessionMaxHours(), boot({ cfg: { sessionMaxHours: 8 } }).api.sessionMaxHours(), boot({ cfg: { sessionMaxHours: 0 } }).api.sessionMaxHours(),
      boot({ cfg: { sessionMaxHours: 'abc' } }).api.sessionMaxHours(), boot({ cfg: { sessionMaxHours: -3 } }).api.sessionMaxHours()];
    return J(r) === J([12, 8, 0, 12, 12]) || J(r);
  });
  await check('fresh session (signed in 2 h ago): kept; sessionExpiresAt = sign-in + 12 h; one timer at the expiry', async () => {
    const b = boot({ now: T0, session: sess(2 * HOUR) });
    const r = await b.api.getSession();
    return (r.data && r.data.user && b.calls.signOut.length === 0 && b.calls.replace.length === 0
      && b.api.sessionExpiresAt() === new Date(T0 + 10 * HOUR).toISOString()
      && b.calls.timers.length === 1 && b.calls.timers[0].ms === 10 * HOUR + 1000) || J({ r, c: b.calls, e: b.api.sessionExpiresAt() });
  });
  await check('session over 12 h on admin.html#transactions → local sign-out, getSession null, login.html?expired=1&next=admin.html%23transactions#staff', async () => {
    const b = boot({ now: T0, session: sess(12 * HOUR + 60000), location: { pathname: '/admin.html', hash: '#transactions' } });
    const r = await b.api.getSession();
    return (r.data === null && !r.error && J(b.calls.signOut) === J([{ scope: 'local' }])
      && J(b.calls.replace) === J(['login.html?expired=1&next=' + encodeURIComponent('admin.html#transactions') + '#staff'])) || J({ r, c: b.calls });
  });
  await check('portal.html → …next=portal.html#client; an odd hash is dropped from next', async () => {
    const b = boot({ now: T0, session: sess(13 * HOUR), location: { pathname: '/portal.html', hash: '#<script>' } });
    await b.api.getSession();
    return J(b.calls.replace) === J(['login.html?expired=1&next=portal.html#client']) || J(b.calls.replace);
  });
  await check('login.html: an over-cap session is signed out without any redirect (no loop)', async () => {
    const b = boot({ now: T0, session: sess(20 * HOUR), location: { pathname: '/login.html', search: '?expired=1&next=admin.html' } });
    const r = await b.api.getSession();
    const r2 = await b.api.getSession();
    return (r.data === null && r2.data === null && b.calls.signOut.length === 1 && b.calls.replace.length === 0) || J({ r, r2, c: b.calls });
  });
  await check('a public page (tracking.html): signed out, not redirected', async () => {
    const b = boot({ now: T0, session: sess(20 * HOUR), location: { pathname: '/tracking.html' } });
    const r = await b.api.getSession();
    return (r.data === null && b.calls.signOut.length === 1 && b.calls.replace.length === 0) || J(b.calls);
  });
  await check('no URL exempts a stale session: admin.html?mode=1, portal.html?code=x, login.html?mode=reset / ?invite= / #reset, #type=invite', async () => {
    const locs = [{ pathname: '/admin.html', search: '?mode=1' }, { pathname: '/portal.html', search: '?code=x' }, { pathname: '/login.html', search: '?mode=reset' },
      { pathname: '/login.html', search: '?invite=' + 'a'.repeat(64) }, { pathname: '/login.html', hash: '#reset' }, { pathname: '/admin.html', hash: '#access_token=abc&type=invite' }];
    const bad = [];
    for (const l of locs) {
      const b = boot({ now: T0, session: sess(30 * HOUR), location: l });
      const r = await b.api.getSession();
      const app = l.pathname !== '/login.html';
      if (r.data !== null || b.calls.signOut.length !== 1 || b.calls.replace.length !== (app ? 1 : 0)) bad.push(J(l));
    }
    return bad.length === 0 || bad.join(' | ');
  });
  await check('an e-mail link session (new session, amr = now) on login.html#access_token…&type=recovery is kept even though the user is old', async () => {
    const link = { access_token: jwtWith({ sub: U.admin, iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 3600, amr: [{ method: 'otp', timestamp: Math.floor(T0 / 1000) }] }),
      user: { id: U.admin, last_sign_in_at: new Date(T0 - 30 * HOUR).toISOString() } };
    const b = boot({ now: T0, session: link, location: { pathname: '/login.html', hash: '#access_token=abc&type=recovery' } });
    const r = await b.api.getSession();
    return (r.data && b.calls.signOut.length === 0 && b.api.sessionExpiresAt() === new Date(T0 + 12 * HOUR).toISOString()) || J({ c: b.calls, e: b.api.sessionExpiresAt() });
  });
  await check('sessionMaxHours 0: a 30-hour-old session is kept, no timer, sessionExpiresAt null', async () => {
    const b = boot({ now: T0, session: sess(30 * HOUR), cfg: { sessionMaxHours: 0 } });
    const r = await b.api.getSession();
    return (r.data && b.calls.signOut.length === 0 && b.calls.timers.length === 0 && b.api.sessionExpiresAt() === null) || J({ c: b.calls });
  });
  await check('sessionMaxHours 1 (config): a 90-minute-old session expires', async () => {
    const b = boot({ now: T0, session: sess(90 * 60000), cfg: { sessionMaxHours: 1 } });
    const r = await b.api.getSession();
    return (r.data === null && b.calls.signOut.length === 1 && b.calls.replace.length === 1) || J(b.calls);
  });
  await check('fake clock: the expiry timer fires after 12 h → signed out + redirected (page left open)', async () => {
    const b = boot({ now: T0, session: sess(11 * HOUR), location: { pathname: '/ocr.html' } });
    await b.api.getSession();
    const t = b.calls.timers[0];
    const before = b.calls.signOut.length;
    b.setNow(T0 + t.ms);
    t.fn();
    await new Promise(r => setTimeout(r, 20));
    return (t.ms === HOUR + 1000 && before === 0 && b.calls.signOut.length === 1 && J(b.calls.replace) === J(['login.html?expired=1&next=ocr.html#staff'])) || J({ t: t && t.ms, c: b.calls });
  });
  await check('fake clock: 11 h 59 min → kept; 12 h 00 min 01 s → expired', async () => {
    const b1 = boot({ now: T0, session: sess(12 * HOUR - 60000) });
    const k = await b1.api.getSession();
    const b2 = boot({ now: T0, session: sess(12 * HOUR + 1000) });
    const x = await b2.api.getSession();
    return (k.data && b1.calls.signOut.length === 0 && x.data === null && b2.calls.signOut.length === 1) || J({ k: !!k.data, x: !!x.data });
  });
  await check('no last_sign_in_at: the access token amr time is used; neither → not capped', async () => {
    const amr = { access_token: jwtWith({ sub: U.admin, amr: [{ method: 'password', timestamp: Math.floor((T0 - 13 * HOUR) / 1000) }] }), user: { id: U.admin } };
    const b = boot({ now: T0, session: amr });
    const r = await b.api.getSession();
    const none = boot({ now: T0, session: { access_token: 'x.e30.y', user: { id: U.admin } } });
    const n = await none.api.getSession();
    return (r.data === null && b.calls.signOut.length === 1 && n.data && none.calls.signOut.length === 0 && none.api.sessionExpiresAt() === null) || J({ r, n, b: b.calls, none: none.calls });
  });
  await check('the cap counts from THIS session (earliest amr), not user.last_sign_in_at: a later sign-in elsewhere does not extend it', async () => {
    // PC signed in 13 h ago; the phone signed in 1 h ago → after a refresh, session.user.last_sign_in_at is the phone's
    const pc = { access_token: jwtWith({ sub: U.admin, iat: Math.floor((T0 - 600000) / 1000), exp: Math.floor((T0 + 3000000) / 1000),
        amr: [{ method: 'otp', timestamp: Math.floor((T0 - 2 * HOUR) / 1000) }, { method: 'password', timestamp: Math.floor((T0 - 13 * HOUR) / 1000) }] }),
      user: { id: U.admin, last_sign_in_at: new Date(T0 - HOUR).toISOString() } };
    const b = boot({ now: T0, session: pc });
    const r = await b.api.getSession();
    return (r.data === null && J(b.calls.signOut) === J([{ scope: 'local' }]) && b.calls.replace.length === 1
      && b.api.sessionExpiresAt(pc) === new Date(T0 - HOUR).toISOString()) || J({ r, c: b.calls, e: b.api.sessionExpiresAt(pc) });
  });
  await check('clock skew: device 13 h ahead + a fresh sign-in → kept (corrected by the token exp); device 6 h behind → a 13 h old session still expires (iat)', async () => {
    const tSign = Math.floor(T0 / 1000);
    const fresh = { access_token: jwtWith({ sub: U.admin, iat: tSign, exp: tSign + 3600, amr: [{ method: 'password', timestamp: tSign }] }), user: { id: U.admin } };
    const ahead = boot({ now: T0 + 13 * HOUR, session: fresh });
    const k = await ahead.api.getSession();
    const old = { access_token: jwtWith({ sub: U.admin, iat: tSign, exp: tSign + 3600, amr: [{ method: 'password', timestamp: tSign - 13 * 3600 }] }), user: { id: U.admin } };
    const behind = boot({ now: T0 - 6 * HOUR, session: old });
    const x = await behind.api.getSession();
    return (k.data && ahead.calls.signOut.length === 0 && ahead.calls.timers.length === 1 && ahead.calls.timers[0].ms === 11 * HOUR + 1000
      && x.data === null && behind.calls.signOut.length === 1) || J({ k: !!k.data, a: ahead.calls, x: !!x.data, b: behind.calls });
  });
  await check('logout call fails (offline / 5xx): the stored session marsa_auth is removed, then expired + redirected', async () => {
    const b = boot({ now: T0, session: sess(13 * HOUR), signOutError: true, storeBacked: true });
    const r = await b.api.getSession();
    const r2 = await b.api.getSession();
    return (r.data === null && !('marsa_auth' in b.store) && b.calls.signOut.length === 1 && b.calls.replace.length === 1 && r2.data === null) || J({ r, c: b.calls, s: b.store });
  });
  await check('logout call fails and the session cannot be removed: no "ended" redirect, getSession null, retried by a timer', async () => {
    const b = boot({ now: T0, session: sess(13 * HOUR), signOutError: true });
    const r = await b.api.getSession();
    const t = b.calls.timers[b.calls.timers.length - 1];
    return (r.data === null && b.calls.replace.length === 0 && t && t.ms === 30000) || J({ r, c: b.calls });
  });
  await check('sessionExpiresAt(session) computes for a given session; signed out → null', async () => {
    const b = boot({ now: T0, session: null });
    const g = await b.api.getSession();
    return (g.data === null && b.api.sessionExpiresAt() === null
      && b.api.sessionExpiresAt(sess(HOUR)) === new Date(T0 - HOUR + 12 * HOUR).toISOString()) || J({ e: b.api.sessionExpiresAt() });
  });
  await check('concurrent getSession calls on an expired session sign out once and redirect once', async () => {
    const b = boot({ now: T0, session: sess(15 * HOUR) });
    const rs = await Promise.all([b.api.getSession(), b.api.getSession(), b.api.getSession()]);
    return (rs.every(r => r.data === null) && b.calls.signOut.length === 1 && b.calls.replace.length === 1) || J(b.calls);
  });
  await check('demo mode: getSession → null, no cap activity', async () => {
    const b = boot({ cfg: { supabaseUrl: '', supabaseAnonKey: '' } });
    const r = await b.api.getSession();
    return (r.data === null && !r.error && b.calls.timers.length === 0 && b.calls.replace.length === 0) || J({ r, c: b.calls });
  });
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
  for (const s of [secRerun, secBucket, secContext, secSupaStatic, secSupaLogo, secSupaCap]) {
    try { await s(); } catch (e) { fail(s.name, errText(e)); }
  }
  await check('no network call was attempted', () => fetchCalls === 0 || 'fetch calls: ' + fetchCalls);
  console.log('\n' + '-'.repeat(70));
  console.log('org-logo-session-tests: ' + nPass + ' passed, ' + nFail + ' failed');
  if (nFail) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exitCode = 1; }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
