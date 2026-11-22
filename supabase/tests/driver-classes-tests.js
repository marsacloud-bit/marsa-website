#!/usr/bin/env node
/*
  Marsa (مرسى) — owner stage 3د: migration 20261207000100_driver_classes.sql (the drivers directory: classification,
  the party it belongs to, the truck it works on).
  LOCAL TESTS ONLY. PGlite (in-memory Postgres), no network.
  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea", org B).

  Covers: file conventions + all_migrations.sql; preflight refusal; re-run on itself; the classes in status_labels;
  the class trigger (unknown class refused, an individual has no party); save_driver (individual + a new truck by plate,
  the mobile normalised; company / contractor need a carrier party of the org; one active driver per mobile; an existing
  inactive truck refused; an edit moves the class / party / truck; transport writers only, another org forbidden);
  list_drivers (all fields, search by name / mobile in another spelling / plate / party name; staff only; anon none).

  usage:
    node supabase/tests/driver-classes-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261207000100_driver_classes.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in driver-classes-tests'); };

const A = '0b5e0000-0000-4000-8000-000000000001';
const B = 'deca0000-0000-4000-8000-0000000000e0';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const CAR = 'deca0000-0000-4000-8000-0000000000e1';    // carrier party of A
const SUP = 'deca0000-0000-4000-8000-0000000000e2';    // supplier party of A (not a carrier)
const CAR_B = 'deca0000-0000-4000-8000-0000000000e3';  // carrier party of B
const U = {
  opsm: 'deca0000-0000-4000-8000-000000000031',     // operations_manager of A
  trans: 'deca0000-0000-4000-8000-000000000032',    // transport_staff of A (JED)
  acct: 'deca0000-0000-4000-8000-000000000033',     // accountant of A (staff, not a transport writer)
  staffB: 'deca0000-0000-4000-8000-000000000034'    // admin of B
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
async function code(fn) {
  try { await fn(); return 'ok'; } catch (e) {
    const m = e.message || '';
    if (/^MRS_/.test(m)) return m + (e.detail ? ' ' + e.detail : '');
    if (/row-level security/.test(m)) return 'rls';
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
async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig, md5(p.prosrc) h,
                              coalesce(p.proacl::text, '') acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = 'public' ORDER BY 1`)).map(x => x.x);
  const rows = await one(`SELECT (SELECT count(*) FROM public.status_labels WHERE domain = 'driver_class')::int s`);
  return { fns, trg, rows };
}
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.opsm}', 'opsm@drv.example.com', now()), ('${U.trans}', 'trans@drv.example.com', now()),
    ('${U.acct}', 'acct@drv.example.com', now()), ('${U.staffB}', 'staffb@drv.example.com', now());
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'drv-org-b', 'مؤسسة ب', 'Drivers org B', 'DRB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.opsm}', '${A}', NULL, 'operations_manager'), ('${U.trans}', '${A}', '${JED}', 'transport_staff'),
    ('${U.acct}', '${A}', NULL, 'accountant'), ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.parties (id, org_id, kinds, name_ar, phone) VALUES
    ('${CAR}', '${A}', ARRAY['carrier'], 'مؤسسة النقل السريع', '0551112222'),
    ('${SUP}', '${A}', ARRAY['supplier'], 'مورد تجريبي', NULL),
    ('${CAR_B}', '${B}', ARRAY['carrier'], 'ناقل المؤسسة ب', NULL);
`;
const save = (who, p, org) => as(who, `SELECT public.save_driver($1, $2) r`, [org || A, p]).then(r => r[0].r);

async function secFile() {
  section('1. file + all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: preflight on 20261206000100, schema_versions row, no BEGIN/COMMIT, down-path; no CHECK value list for the class', () =>
    (/version = '20261206000100'/.test(s) && /VALUES \('20261207000100', 'driver_classes'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s)
      && /Down-path:/.test(s) && !/driver_class\s+text[^,\n]*CHECK/.test(s) && /app\.is_code\('driver_class'/.test(s)) || 'conventions');
  const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
  await check('all_migrations.sql: appended verbatim under its header, last; the paste note names it', () => {
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    return (i > 0 && (body === s || body + '\n' === s) && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles())) || 'bundle';
  });
  const LATER_PHASES = ['20261208000100_ai_providers.sql', '20261209000100_ai_keys.sql', '20261210000100_org_served_ports.sql'];
  await check('this file is the latest migration (later phases excepted)', () => J(migFiles().filter(f => f > MIG)) === J(LATER_PHASES) || 'later ' + J(migFiles().filter(f => f > MIG)));
}

async function secRerun() {
  section('2. preflight + re-run');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  db = await freshDb(MIG);
  await check('preflight: refuses without storage_gate (20261206000100)', async () => {
    await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261206000100'`);
    let msg = ''; try { await db.exec(s); } catch (e) { msg = e.message; }
    await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261206000100', 'storage_gate')`);
    return /DRIVER CLASSES preflight: apply storage_gate first/.test(msg) || msg;
  });
  await db.exec(s);
  const c1 = await catalog();
  await db.exec(s);
  const c2 = await catalog();
  await check('re-run on itself: identical catalog', () => J(c1) === J(c2) || 'changed');
  await db.close();
}

async function secMain() {
  section('3. classes + trigger');
  await check('status_labels: individual / company / contractor (staff only)', async () => {
    const r = await q(`SELECT code, client_visible v FROM public.status_labels WHERE domain = 'driver_class' ORDER BY sort`);
    return J(r.map(x => x.code)) === J(['individual', 'company', 'contractor']) && r.every(x => !x.v) || J(r);
  });
  await check('trigger: an unknown class refused; an individual with a party refused (direct writes too)', async () => {
    const a = await code(() => as('trans', `INSERT INTO public.drivers (org_id, full_name, phone, driver_class) VALUES ($1, 'سائق', '0500000001', 'freelance')`, [A]));
    const b = await code(() => as('trans', `INSERT INTO public.drivers (org_id, carrier_id, full_name, phone, driver_class) VALUES ($1, $2, 'سائق', '0500000002', 'individual')`, [A, CAR]));
    return (a === 'MRS_INVALID driver_class' && b === 'MRS_INVALID carrier_id') || J([a, b]);
  });

  section('4. save_driver');
  let ind;
  await check('an individual driver with a new truck: mobile normalised, truck created, no party', async () => {
    ind = await save('trans', { full_name: 'سالم الحربي', phone: '+966 55 123 4567', driver_class: 'individual', truck_plate: 'أ ب ج 1234' });
    const k = await one(`SELECT plate_no, carrier_id FROM public.trucks WHERE org_id = $1 AND plate_no = $2`, [A, ind.truck_plate]);
    return (ind.phone === '0551234567' && ind.driver_class === 'individual' && ind.party === null && k && k.carrier_id === null && !/\s/.test(ind.truck_plate)) || J({ ind, k });
  });
  await check('company / contractor need a carrier party of this org', async () => {
    const a = await code(() => save('trans', { full_name: 'خالد', phone: '0552222333', driver_class: 'company' }));
    const b = await code(() => save('trans', { full_name: 'خالد', phone: '0552222333', driver_class: 'company', carrier_id: SUP }));
    const c = await code(() => save('trans', { full_name: 'خالد', phone: '0552222333', driver_class: 'contractor', carrier_id: CAR_B }));
    const d = await save('trans', { full_name: 'خالد', phone: '0552222333', driver_class: 'contractor', carrier_id: CAR, truck_plate: 'TRK777' });
    return (a === 'MRS_REQUIRED carrier_id' && b === 'MRS_INVALID carrier_id' && c === 'MRS_INVALID carrier_id' && d.party && d.party.name_ar === 'مؤسسة النقل السريع'
      && d.party.phone === '0551112222' && d.truck_plate === 'TRK777') || J([a, b, c, d]);
  });
  await check('one active driver per mobile (another spelling of the same number too)', async () => {
    const r = await code(() => save('trans', { full_name: 'آخر', phone: '966551234567', driver_class: 'individual' }));
    return r === 'MRS_CONFLICT phone' || r;
  });
  await check('required / invalid fields: name, mobile, class', async () => {
    const a = await code(() => save('trans', { phone: '0550000009', driver_class: 'individual' }));
    const b = await code(() => save('trans', { full_name: 'سائق', phone: '12', driver_class: 'individual' }));
    const c = await code(() => save('trans', { full_name: 'سائق', phone: '0550000009' }));
    const d = await code(() => save('trans', { full_name: 'سائق', phone: '0550000009', driver_class: 'x' }));
    const e = await code(() => save('trans', { full_name: 'سائق', phone: '0550000009', driver_class: 'individual', nope: 1 }));
    return (a === 'MRS_REQUIRED full_name' && b === 'MRS_INVALID phone' && c === 'MRS_REQUIRED driver_class' && d === 'MRS_INVALID driver_class' && /^MRS_/.test(e)) || J([a, b, c, d, e]);
  });
  await check('an existing inactive truck plate is refused', async () => {
    await q(`INSERT INTO public.trucks (org_id, plate_no, is_active) VALUES ($1, 'OLD999', false)`, [A]);
    const r = await code(() => save('trans', { full_name: 'سائق جديد', phone: '0558889999', driver_class: 'individual', truck_plate: 'OLD999' }));
    return r === 'MRS_INVALID truck_plate' || r;
  });
  await check('an edit moves the class / party / truck; omitting truck_plate keeps the truck', async () => {
    const e1 = await save('opsm', { id: ind.id, full_name: 'سالم الحربي', phone: '0551234567', driver_class: 'company', carrier_id: CAR, truck_plate: 'NEW123' });
    const e2 = await save('opsm', { id: ind.id, full_name: 'سالم بن علي', phone: '0551234567', driver_class: 'individual' });
    return (e1.driver_class === 'company' && e1.party && e1.truck_plate === 'NEW123' && e2.driver_class === 'individual' && e2.party === null
      && e2.truck_plate === 'NEW123' && e2.full_name === 'سالم بن علي') || J([e1, e2]);
  });
  await check('rights: an accountant cannot save; staff of another org cannot save in this org; anon cannot call', async () => {
    const a = await code(() => save('acct', { full_name: 'س', phone: '0551010101', driver_class: 'individual' }));
    const b = await code(() => save('staffB', { full_name: 'سائق ب', phone: '0551010101', driver_class: 'individual' }, A));
    const c = await code(() => as('anon', `SELECT public.save_driver($1, '{}')`, [A]));
    return (a === 'MRS_FORBIDDEN organization' && b === 'MRS_FORBIDDEN organization' && c === 'perm') || J([a, b, c]);
  });

  section('5. list_drivers');
  await check('list_drivers: every field; search by name, mobile (other spelling), plate, party name', async () => {
    const L = (who, s) => as(who, `SELECT public.list_drivers($1, $2) r`, [A, s]).then(r => r[0].r);
    const all = await L('acct', null);
    const byName = await L('acct', 'سالم'), byPhone = await L('acct', '+966552222333'), byPlate = await L('acct', 'TRK 777'), byParty = await L('acct', 'النقل السريع');
    const k = all.find(x => x.full_name === 'خالد');
    return (k && k.driver_class === 'contractor' && k.party && k.truck_plate === 'TRK777' && 'license_no' in k && k.is_active === true
      && byName.length === 1 && byPhone.length === 1 && byPhone[0].full_name === 'خالد' && byPlate.length === 1 && byParty.some(x => x.full_name === 'خالد'))
      || J({ n: all.length, byName: byName.length, byPhone: byPhone.length, byPlate: byPlate.length, byParty: byParty.length });
  });
  await check('list_drivers: staff of another org forbidden; anon cannot call', async () => {
    const a = await code(() => as('staffB', `SELECT public.list_drivers($1, NULL)`, [A]));
    const b = await code(() => as('anon', `SELECT public.list_drivers($1, NULL)`, [A]));
    return (a === 'MRS_FORBIDDEN organization' && b === 'perm') || J([a, b]);
  });
}


/* ------------------------------------------------------------------ 6. the «السائقون» page (ops/drivers.js, static + pure) */
async function secUi() {
  section('6. «السائقون» page + the appointment-card note');
  const vm = require('vm');
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/ops/drivers.js'), 'utf8');
  const ctx = { window: {}, Array, Object, String, Number, JSON, Math, Promise, RegExp };
  ctx.window.window = ctx.window; vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'drivers.js' });
  const D = ctx.window.MarsaOps && ctx.window.MarsaOps.drivers, V = ctx.window.MarsaOps && ctx.window.MarsaOps.views && ctx.window.MarsaOps.views.drivers;
  await check('drivers.js registers #drivers (staff, ops.nav_drivers)', () => (D && D.VERSION === 'drv2-2' && V && V.allow === 'staff' && V.titleKey === 'ops.nav_drivers' && typeof V.render === 'function') || 'view');
  await check('driverRow: an individual drops the party; a company keeps it; empty plate / licence → null; the id on an edit', () => {
    const a = D.pure.driverRow({ full_name: ' سالم ', phone: '055', driver_class: 'individual', carrier_id: 'x', truck_plate: ' ', license_no: '' });
    const b = D.pure.driverRow({ full_name: 'خالد', phone: '055', driver_class: 'company', carrier_id: 'c1', truck_plate: 'AB1' }, 'id1');
    const c = D.pure.driverRow({ full_name: 'x', phone: '1', driver_class: 'boss' });
    return (a.full_name === 'سالم' && a.carrier_id === null && a.truck_plate === null && a.license_no === null && !('id' in a)
      && b.carrier_id === 'c1' && b.id === 'id1' && b.truck_plate === 'AB1' && c.driver_class === null) || JSON.stringify([a, b, c]);
  });
  await check('matches: inactive hidden unless asked; the class filter (incl. «غير مصنّف»); search over the party too', () => {
    const U = { matches: (q, arr) => !q || arr.some(x => x && String(x).indexOf(q) !== -1) };
    const d1 = { full_name: 'خالد', driver_class: 'contractor', is_active: true, party: { name_ar: 'مؤسسة النقل' } };
    const d2 = { full_name: 'محمد', driver_class: null, is_active: false };
    return (D.pure.matches(U, d1, { q: 'النقل', cls: '' }) && !D.pure.matches(U, d2, { q: '', cls: '' }) && D.pure.matches(U, d2, { q: '', cls: '_none', inactive: true })
      && !D.pure.matches(U, d1, { q: '', cls: 'individual' })) || 'matches';
  });
  // owner, 20 Nov 2026: «سائق جديد — اختر تصنيفه» on #tx right after the appointment card is read
  await check('#tx section driver_classify (order 52) lists only the transaction unclassified active drivers', () => {
    const S = (ctx.window.MarsaOps.txSections || []).filter(x => x && x.id === 'driver_classify');
    const dir = [{ id: 'a', driver_class: null, is_active: true }, { id: 'b', driver_class: 'individual', is_active: true },
      { id: 'c', driver_class: null, is_active: false }, { id: 'd', driver_class: null, is_active: true }];
    const u = D.pure.unclassifiedOf([{ driver_id: 'a' }, { driver_id: 'b' }, { driver_id: null }], [{ driver_id: 'c' }], dir);
    return (S.length === 1 && S[0].order === 52 && typeof S[0].render === 'function' && u.length === 1 && u[0].id === 'a') || JSON.stringify(u);
  });
  await check('classifyRow: class required; company / contractor need a party; individual drops it; the truck is kept', () => {
    const d = { id: 'x', full_name: 'محمد', phone: '0559998888', license_no: null };
    const e1 = D.pure.classifyRow(d, '', null), e2 = D.pure.classifyRow(d, 'contractor', ''), ok1 = D.pure.classifyRow(d, 'contractor', 'p1'), ok2 = D.pure.classifyRow(d, 'individual', 'p1');
    return (e1.error === 'drv2_err_class' && e2.error === 'drv2_err_party' && ok1.row.carrier_id === 'p1' && ok1.row.driver_class === 'contractor' && ok1.row.id === 'x'
      && !('truck_plate' in ok1.row) && ok2.row.carrier_id === null && ok2.row.is_active === true) || JSON.stringify([e1, e2, ok1, ok2]);
  });
  await check('wiring: nav item in «التشغيل» after «الجهات والناقلون» (admin.js + app-shell.js); admin.html loads drivers.js before admin.js; sw.js precaches it; supa.js exports the two calls', () => {
    const ad = fs.readFileSync(path.join(ROOT, 'assets/js/admin.js'), 'utf8'), sh = fs.readFileSync(path.join(ROOT, 'assets/js/app-shell.js'), 'utf8');
    const h = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8'), sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), su = fs.readFileSync(path.join(ROOT, 'assets/js/supa.js'), 'utf8');
    return (/\{ id: 'ops', items: \['alerts', 'schedule', 'exceptions', 'parties', 'drivers'\] \}/.test(ad) && /'parties', 'drivers',\n    'search'/.test(ad)
      && /\{ id: 'drivers', key: 'ops\.nav_drivers', href: 'admin\.html#drivers', icon: 'user', allow: R\.staff \}/.test(sh)
      && h.indexOf('assets/js/ops/drivers.js') > h.indexOf('assets/js/ops/parties.js') && h.indexOf('assets/js/ops/drivers.js') < h.indexOf('assets/js/admin.js')
      && sw.includes("'assets/js/ops/drivers.js'") && /listDriversDirectory: listDriversDirectory, saveDriverEntry: saveDriverEntry/.test(su)
      && !/innerHTML|=>|\blet\b|\bconst\b/.test(src)) || 'wiring';
  });
  await check('strings: every drv2_* key used + nav_drivers + driver_class_* exist in ar and en; the appointment-card storage note in appt.js (ar + en) and tx-appt.js', () => {
    const ops = fs.readFileSync(path.join(ROOT, 'assets/i18n/ops.js'), 'utf8'), ap = fs.readFileSync(path.join(ROOT, 'assets/i18n/appt.js'), 'utf8');
    const ta = fs.readFileSync(path.join(ROOT, 'assets/js/ops/tx-appt.js'), 'utf8');
    const used = [...new Set((src.match(/t\('(drv2_[a-z_]+)'/g) || []).map(x => x.slice(3, -1)))].concat(['nav_drivers', 'driver_class_individual', 'driver_class_company', 'driver_class_contractor']);
    const miss = used.filter(k => (ops.match(new RegExp('\\b' + k + ": '", 'g')) || []).length !== 2);
    return (!miss.length && (ap.match(/tc_storage_blocked: '/g) || []).length === 2 && /T\('tc_storage_blocked'\)/.test(ta) && /call\(api, 'txStorageGate', tx\.id\)/.test(ta)) || 'missing ' + JSON.stringify(miss);
  });
}

(async () => {
  console.log('Marsa — driver classes (3د) SQL tests (PGlite; local only)');
  await secFile();
  await secRerun();
  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  await secMain();
  if (typeof secUi === 'function') await secUi();
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
