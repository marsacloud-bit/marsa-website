#!/usr/bin/env node
/*
  Marsa (مرسى) — migration 20261210000100_org_served_ports.sql + the «الموانئ التي نخدمها» card and the website ports
  block (owner, 22 Nov 2026: some brokers serve only certain ports; each office picks its ports, only those show on its site).
  LOCAL TESTS ONLY. PGlite (in-memory Postgres), no network.

  Covers: file conventions + all_migrations.sql; preflight + re-run; customs_ports land kind + the 3 added ports;
  the table (RLS, audit, no direct write, nothing for anon); get_served_ports (staff of the org, all active ports +
  served flag); save_served_ports (admins only, order kept, duplicates folded, unknown / inactive refused, empty list
  clears); site_served_ports (anon, only the chosen active ports of an active office, only public fields); the
  conversion keeps the choice; the admin card / supa.js / index.html / i18n (static).

  usage:
    node supabase/tests/served-ports-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const MIG = '20261210000100_org_served_ports.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

const A = 'a0b10000-0000-4000-8000-000000000001';
const B = 'a0b10000-0000-4000-8000-000000000002';
const U = {
  admin: 'a0b1aaaa-0000-4000-8000-000000000001',   // admin of A
  staff: 'a0b1aaaa-0000-4000-8000-000000000002',   // accountant of A
  other: 'a0b1aaaa-0000-4000-8000-000000000003'    // admin of B
};

let db;
async function asRole(who, fn) {
  if (who === 'anon') await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  else {
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[who], role: 'authenticated', aal: 'aal2' })]);
    await db.exec(`SET ROLE authenticated;`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
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
const FIXTURES = `
  INSERT INTO public.organizations (id, slug, name_ar) VALUES ('${A}', 'office-a', 'مكتب أ'), ('${B}', 'office-b', 'مكتب ب');
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@ports.example.com', now()), ('${U.staff}', 'staff@ports.example.com', now()), ('${U.other}', 'other@ports.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.staff}', 'staff'), ('${U.other}', 'other') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.staff}', '${A}', NULL, 'accountant'), ('${U.other}', '${B}', NULL, 'admin');
`;
const save = (who, org, codes) => as(who, `SELECT public.save_served_ports($1, $2) r`, [org, codes]).then(r => r[0].r);
const get = (who, org) => as(who, `SELECT public.get_served_ports($1) r`, [org]).then(r => r[0].r);
const site = (who, slug) => as(who, `SELECT public.site_served_ports($1) r`, [slug]).then(r => r[0].r);
const served = list => list.filter(x => x.served).map(x => x.code);

/* ------------------------------------------------------------------ 1. the file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('preflight on ai_keys, its schema_versions row, no BEGIN / COMMIT', () =>
    (/version = '20261209000100'/.test(s) && /VALUES \('20261210000100', 'org_served_ports'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s)) || 'conventions');
  await check('all_migrations.sql: this file verbatim, in order, with its live-DB note', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    return (i > 0 && (body === s || body + '\n' === s) && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles())) || 'bundle';
  });
  const LATER_PHASES = ['20261211000100_reconvert.sql', '20261213000100_site_profile.sql', '20261214000100_org_ai_keys.sql'];
  await check('this file is the latest migration (later phases excepted)', () => J(migFiles().filter(f => f > MIG)) === J(LATER_PHASES) || 'later ' + J(migFiles().filter(f => f > MIG)));
}

/* ------------------------------------------------------------------ 2. preflight + re-run */
async function secPreflight() {
  section('2. preflight + re-run');
  const d = await freshDb(MIG);
  try {
    await check('refused without ai_keys (schema_versions row removed)', async () => {
      await d.query(`DELETE FROM public.schema_versions WHERE version = '20261209000100'`);
      let r = 'ok'; try { await d.exec(fs.readFileSync(MIG_FILE, 'utf8')); } catch (e) { r = e.message; }
      await d.query(`INSERT INTO public.schema_versions (version, name) VALUES ('20261209000100', 'ai_keys')`);
      return /SERVED PORTS preflight: apply ai_keys first/.test(r) || r;
    });
    await check('applies, then re-runs without touching a saved choice', async () => {
      await d.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      await d.exec(`INSERT INTO public.organizations (id, slug, name_ar) VALUES ('${A}', 'office-a', 'مكتب أ');
                    INSERT INTO public.org_served_ports (org_id, port_code, sort) VALUES ('${A}', 'SASLW', 1);`);
      await d.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      const n = (await d.query(`SELECT count(*)::int n FROM public.org_served_ports WHERE org_id = '${A}' AND port_code = 'SASLW'`)).rows[0].n;
      const p = (await d.query(`SELECT count(*)::int n FROM public.customs_ports`)).rows[0].n;
      return (n === 1 && p === 10) || J({ n, p });
    });
  } finally { await d.close(); }
}

/* ------------------------------------------------------------------ 3. the ports list */
async function secPorts() {
  section('3. customs_ports: land crossings + the Madinah airport');
  await check('the land kind is accepted; the 3 owner ports exist with their kinds', async () => {
    const r = await q(`SELECT code, kind, name_ar FROM public.customs_ports WHERE code IN ('SASLW','SAHDT','SAMED-AIR') ORDER BY code`);
    return J(r.map(x => x.code + ':' + x.kind)) === J(['SAHDT:land', 'SAMED-AIR:air', 'SASLW:land'])
      && r.find(x => x.code === 'SASLW').name_ar === 'جمرك سلوى' && r.find(x => x.code === 'SAHDT').name_ar === 'جمرك الحديثة' || J(r);
  });
  await check('an unknown kind is still refused', async () =>
    /check/i.test(await code(() => q(`INSERT INTO public.customs_ports (code, unlocode, kind, name_ar, name_en) VALUES ('SAXXX','SAXXX','rail','x x','x x')`))) || 'accepted');
  await check('four airports, two land crossings', async () => {
    const r = await q(`SELECT kind, count(*)::int n FROM public.customs_ports WHERE is_active GROUP BY kind ORDER BY kind`);
    const m = Object.fromEntries(r.map(x => [x.kind, x.n]));
    return (m.air === 4 && m.land === 2) || J(m);
  });
}

/* ------------------------------------------------------------------ 4. the table */
async function secTable() {
  section('4. org_served_ports: RLS, audit, no direct write');
  await check('RLS on, audit trigger, nothing for anon, only SELECT for authenticated', async () => {
    const rls = (await q(`SELECT relrowsecurity r FROM pg_class WHERE oid = 'public.org_served_ports'::regclass`))[0].r;
    const aud = (await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = 'public.org_served_ports'::regclass AND tgname = 'trg_audit'`))[0].n;
    const g = await q(`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'org_served_ports' AND grantee IN ('anon','authenticated') ORDER BY 1, 2`);
    return (rls && aud === 1 && J(g.map(x => x.grantee + ':' + x.privilege_type)) === J(['authenticated:SELECT'])) || J({ rls, aud, g });
  });
  await check('an admin cannot insert directly (only through save_served_ports)', async () =>
    (await code(() => as('admin', `INSERT INTO public.org_served_ports (org_id, port_code) VALUES ('${A}', 'SAJED')`))) === 'perm' || 'inserted');
}

/* ------------------------------------------------------------------ 5. RPCs */
async function secRpc() {
  section('5. get / save / site');
  await check('get_served_ports: staff of A see every active port, none served yet', async () => {
    const r = await get('staff', A);
    return (r.length === 10 && served(r).length === 0 && r.every(x => x.code && x.kind && x.name_ar && x.name_en)) || J(r).slice(0, 300);
  });
  await check('get_served_ports: another office\'s admin and anon refused', async () => {
    const a = await code(() => get('other', A)), b = await code(() => get('anon', A));
    return (/MRS_FORBIDDEN/.test(a) && b === 'perm') || J({ a, b });
  });
  await check('save_served_ports: staff (not admin), another office and anon refused', async () => {
    const a = await code(() => save('staff', A, ['SAJED'])), b = await code(() => save('other', A, ['SAJED'])), c = await code(() => save('anon', A, ['SAJED']));
    return (/MRS_FORBIDDEN/.test(a) && /MRS_FORBIDDEN/.test(b) && c === 'perm') || J({ a, b, c });
  });
  await check('admin saves: the order is kept, duplicates and spacing / case folded, served ports listed first', async () => {
    const r = await save('admin', A, ['sahdt', 'SAJED', ' SAJED ', 'SAMED-AIR']);
    return J(served(r)) === J(['SAHDT', 'SAJED', 'SAMED-AIR']) && J(r.slice(0, 3).map(x => x.code)) === J(['SAHDT', 'SAJED', 'SAMED-AIR']) || J(served(r));
  });
  await check('unknown or inactive codes refused; nothing changes', async () => {
    const a = await code(() => save('admin', A, ['SAJED', 'NOPE1']));
    await q(`UPDATE public.customs_ports SET is_active = false WHERE code = 'SAKAC'`);
    const b = await code(() => save('admin', A, ['SAKAC']));
    await q(`UPDATE public.customs_ports SET is_active = true WHERE code = 'SAKAC'`);
    const c = await code(() => save('admin', A, null));
    const now = served(await get('admin', A));
    return (/MRS_INVALID port_code/.test(a) && /MRS_INVALID port_code/.test(b) && /MRS_REQUIRED/.test(c) && J(now) === J(['SAHDT', 'SAJED', 'SAMED-AIR'])) || J({ a, b, c, now });
  });
  await check('the website (anon): only the chosen ports, in order, only public fields; office B empty; unknown / bad slug empty', async () => {
    const a = await site('anon', 'office-a'), b = await site('anon', 'office-b'), c = await site('anon', 'nobody-here'), d = await site('anon', "x'; drop");
    return (J(a.map(x => x.code)) === J(['SAHDT', 'SAJED', 'SAMED-AIR']) && J(Object.keys(a[0]).sort()) === J(['code', 'kind', 'name_ar', 'name_en'])
      && J(b) === '[]' && J(c) === '[]' && J(d) === '[]') || J({ a, b, c, d });
  });
  await check('an inactive port or an inactive office is not shown on the website', async () => {
    await q(`UPDATE public.customs_ports SET is_active = false WHERE code = 'SAHDT'`);
    const a = await site('anon', 'office-a');
    await q(`UPDATE public.customs_ports SET is_active = true WHERE code = 'SAHDT'`);
    await q(`UPDATE public.organizations SET is_active = false WHERE id = '${A}'`);
    const b = await site('anon', 'office-a');
    await q(`UPDATE public.organizations SET is_active = true WHERE id = '${A}'`);
    return (J(a.map(x => x.code)) === J(['SAJED', 'SAMED-AIR']) && J(b) === '[]') || J({ a, b });
  });
  await check('re-saving a shorter list removes the rest; an empty list clears; every change is audited', async () => {
    await save('admin', A, ['SAJED']);
    const one = served(await get('admin', A));
    await save('admin', A, []);
    const none = served(await get('admin', A));
    const aud = (await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'org_served_ports'`))[0].n;
    return (J(one) === J(['SAJED']) && none.length === 0 && aud >= 6) || J({ one, none, aud });
  });
  await check('staff of B cannot read A\'s rows through the table', async () => {
    await save('admin', A, ['SADMM']);
    const n = (await as('other', `SELECT count(*)::int n FROM public.org_served_ports WHERE org_id = $1`, [A]))[0].n;
    const m = (await as('staff', `SELECT count(*)::int n FROM public.org_served_ports WHERE org_id = $1`, [A]))[0].n;
    return (n === 0 && m === 1) || J({ n, m });
  });
  await check('the in-place conversion keeps the choice (configuration)', async () =>
    (await q(`SELECT 'public.org_served_ports' = ANY (app.convert_keep_tables()) k`))[0].k || 'not kept');
}

/* ------------------------------------------------------------------ 6. front end (static) */
async function secFront() {
  section('6. supa.js / admin card / index.html / i18n');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'i18n', 'admin.js'), 'utf8');
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const home = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'site-ports.js'), 'utf8');
  await check('supa.js wraps the three RPCs and exports them', () =>
    (/rpc\('get_served_ports'/.test(supa) && /rpc\('save_served_ports'/.test(supa) && /rpc\('site_served_ports'/.test(supa)
      && /getServedPorts: getServedPorts/.test(supa) && /saveServedPorts: saveServedPorts/.test(supa) && /siteServedPorts: siteServedPorts/.test(supa)) || 'wrappers');
  await check('admin.js: the «الموانئ التي نخدمها» card in the organisation view, admins save', () =>
    (/call\('getServedPorts'/.test(admin) && /call\('saveServedPorts'/.test(admin) && /data-served-ports/.test(admin)
      && /servedPortsCard\(\)\.then/.test(admin)) || 'card');
  await check('i18n/admin.js: the card texts in ar and en', () => {
    const ctx = { window: {} }; let reg = null;
    ctx.window.MarsaI18n = { register: (ns, d) => { if (ns === 'admin') reg = d; }, t: k => k };
    vm.runInNewContext(i18n, ctx);
    const keys = ['ports_title', 'ports_sub', 'ports_save', 'ports_saved', 'ports_kind_sea', 'ports_kind_air', 'ports_kind_dry', 'ports_kind_land'];
    return (reg && keys.every(k => reg.ar[k] && reg.en[k])) || 'missing: ' + keys.filter(k => !(reg && reg.ar[k] && reg.en[k])).join(',');
  });
  await check('index.html: the ports block is filled from the office choice (site-ports.js after supa.js)', () =>
    (/data-site-ports/.test(idx) && idx.indexOf('<script src="assets/js/supa.js"') > 0
      && idx.indexOf('<script src="assets/js/supa.js"') < idx.indexOf('<script src="assets/js/site-ports.js"')
      && /siteServedPorts/.test(home) && /textContent/.test(home) && !/innerHTML\s*=\s*[^'"]*name_/.test(home)) || 'home');
}

(async () => {
  await secFile();
  await secPreflight();
  db = await freshDb();
  await db.exec(FIXTURES);
  await secPorts();
  await secTable();
  await secRpc();
  await db.close();
  await secFront();
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
  process.exit(nFail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
