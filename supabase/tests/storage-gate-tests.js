#!/usr/bin/env node
/*
  Marsa (مرسى) — owner stage 3ج: migration 20261206000100_storage_gate.sql (no appointment while a container's storage
  invoice is unpaid, with a manager override; Jeddah only, a per-org per-port setting).
  LOCAL TESTS ONLY. PGlite (in-memory Postgres), no network.
  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branch JED, org B).

  Covers: file conventions + all_migrations.sql; preflight refusal; re-run on itself (identical catalog, data kept);
  the states in status_labels; container storage columns (invalid state refused, sent / paid stamped, back to none clears;
  a transport writer updates them, audited); the gate ports (SAJED for every org, a new org gets it; staff read, admin
  writes, anon nothing); the gate on every booking path (create_appointment as the user; NULL / issued / sent block,
  none / paid pass; per container; a reschedule, a closed status and a run without a user request pass; another port or an
  inactive gate row passes; Ro-Ro passes); tx_storage_gate (applies / blocked / containers / can_override; another org →
  not found); approve_storage_override (clearance staff forbidden, short reason invalid, a manager approves, a second one
  conflicts, the booking then passes; no direct insert).

  usage:
    node supabase/tests/storage-gate-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261206000100_storage_gate.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in storage-gate-tests'); };

const A = '0b5e0000-0000-4000-8000-000000000001';
const B = 'deca0000-0000-4000-8000-0000000000d0';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const U = {
  admin: 'deca0000-0000-4000-8000-000000000021',
  opsm: 'deca0000-0000-4000-8000-000000000022',     // operations_manager of A (senior ops)
  jed: 'deca0000-0000-4000-8000-000000000023',      // clearance_staff of A, JED
  staffB: 'deca0000-0000-4000-8000-000000000024'    // admin of B
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
    const x = m.match(/violates check constraint "([^"]+)"/); if (x) return 'chk:' + x[1];
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
  const pol = (await q(`SELECT tablename || '.' || policyname x FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const rows = await one(`SELECT (SELECT count(*) FROM public.storage_gate_ports)::int g,
                                 (SELECT count(*) FROM public.status_labels WHERE domain = 'container_storage_state')::int s`);
  return { fns, trg, pol, rows };
}
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@gate.example.com', now()), ('${U.opsm}', 'opsm@gate.example.com', now()),
    ('${U.jed}', 'jed@gate.example.com', now()), ('${U.staffB}', 'staffb@gate.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.opsm}', 'مدير العمليات'), ('${U.jed}', 'jed'), ('${U.staffB}', 'staffB')
    ON CONFLICT (id) DO NOTHING;
  UPDATE public.profiles SET full_name = 'مدير العمليات' WHERE id = '${U.opsm}';
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'gate-org-b', 'مؤسسة ب', 'Gate org B', 'GTB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.opsm}', '${A}', NULL, 'operations_manager'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.staffB}', '${B}', NULL, 'admin');
`;
let seqN = 0;
async function mkTx(port, unit) {
  const n = ++seqN;
  const t = (await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, port_code, cargo_unit_type, chassis_no)
                               VALUES ($1, $2, $3, 'import', 'sea', $4, $5, $6) RETURNING id`,
    [A, JED, CLIENT_A, port, unit || 'container', unit === 'roro' ? 'CHS' + n : null]))[0].id;
  const c1 = unit === 'roro' ? null : (await as('jed', `INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3) RETURNING id`, [A, t, 'SGTU' + String(n).padStart(6, '0') + '1']))[0].id;
  const c2 = unit === 'roro' ? null : (await as('jed', `INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3) RETURNING id`, [A, t, 'SGTU' + String(n).padStart(6, '0') + '2']))[0].id;
  return { t, c1, c2 };
}
const setState = (c, s) => as('jed', `UPDATE public.containers SET storage_state = $2 WHERE id = $1 RETURNING storage_state, storage_sent_at, storage_paid_at`, [c, s]).then(r => r[0]);
const book = (tx, ctr) => code(() => as('jed', `SELECT public.create_appointment($1) r`, [{ transaction_id: tx, container_id: ctr || undefined, appointment_at: new Date(Date.now() + 86400000).toISOString() }]));

async function secFile() {
  section('1. file + all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: preflight on 20261205000100, schema_versions row, no BEGIN/COMMIT, down-path', () =>
    (/version = '20261205000100'/.test(s) && /VALUES \('20261206000100', 'storage_gate'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s) && /Down-path:/.test(s)) || 'conventions');
  await check('no CHECK value list for the states (status_labels + trigger)', () => !/storage_state\s+text[^,\n]*CHECK/.test(s) && /app\.is_code\('container_storage_state'/.test(s) || 'states');
  const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
  await check('all_migrations.sql: appended verbatim under its header, last; the paste note names it', () => {
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && all.slice(i + h.length) === s && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles())) || 'bundle';
  });
  await check('this file is the latest migration', () => migFiles().pop() === MIG || 'latest ' + migFiles().pop());
}

async function secRerun() {
  section('2. preflight + re-run');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  db = await freshDb(MIG);
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await check('preflight: refuses without service_item_price (20261205000100)', async () => {
    await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261205000100'`);
    let msg = ''; try { await db.exec(s); } catch (e) { msg = e.message; }
    await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261205000100', 'service_item_price')`);
    return /STORAGE GATE preflight: apply service_item_price first/.test(msg) || msg;
  });
  await db.exec(s);
  await check('an org that existed before the migration gets its SAJED gate row', async () =>
    (await one(`SELECT count(*)::int n FROM public.storage_gate_ports WHERE org_id = $1 AND port_code = 'SAJED' AND is_active`, [A])).n === 1);
  await q(`UPDATE public.containers SET storage_state = 'paid' WHERE container_no = 'TSTU0000001'`);
  const c1 = await catalog();
  await db.exec(s);
  const c2 = await catalog();
  await check('re-run on itself: identical catalog; a container state kept', async () =>
    J(c1) === J(c2) && (await one(`SELECT storage_state s FROM public.containers WHERE container_no = 'TSTU0000001'`)).s === 'paid' || 'changed');
  await db.close();
}

async function secMain() {
  section('3. states, columns, gate ports');
  await check('status_labels: none / issued / sent / paid (staff only)', async () => {
    const r = await q(`SELECT code, client_visible v FROM public.status_labels WHERE domain = 'container_storage_state' ORDER BY sort`);
    return J(r.map(x => x.code)) === J(['none', 'issued', 'sent', 'paid']) && r.every(x => x.v === false) || J(r);
  });
  const T = await mkTx('SAJED');
  await check('container: an unknown state is refused; sent stamps sent_at, paid stamps paid_at; back to none clears both', async () => {
    const bad = await code(() => setState(T.c1, 'maybe'));
    const s1 = await setState(T.c1, 'sent');
    const s2 = await setState(T.c1, 'paid');
    const s3 = await setState(T.c1, 'none');
    return (bad === 'MRS_INVALID storage_state' && s1.storage_sent_at && !s1.storage_paid_at && s2.storage_paid_at && s2.storage_sent_at
      && !s3.storage_sent_at && !s3.storage_paid_at) || J({ bad, s1, s2, s3 });
  });
  await check('container: amount / invoice number checks', async () => {
    const r = await code(() => as('jed', `UPDATE public.containers SET storage_amount = -5 WHERE id = $1`, [T.c1]));
    return r === 'chk:containers_storage_fields_check' || r;
  });
  await check('a storage change is audited', async () =>
    (await one(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'containers' AND row_id = $1::text`, [T.c1]).catch(() => ({ n: -1 }))).n > 0
    || 'no audit');
  await check('gate ports: SAJED for the seed orgs and a new org; staff read; clearance staff cannot add; anon nothing', async () => {
    const n = (await one(`SELECT count(*)::int n FROM public.storage_gate_ports WHERE port_code = 'SAJED' AND org_id IN ($1, $2)`, [A, B])).n;
    const read = await as('jed', `SELECT port_code FROM public.storage_gate_ports WHERE org_id = $1`, [A]);
    const add = await code(() => as('jed', `INSERT INTO public.storage_gate_ports (org_id, port_code) VALUES ($1, 'SADMM')`, [A]));
    const an = await code(() => as('anon', `SELECT 1 FROM public.storage_gate_ports`));
    return (n === 2 && read.length >= 1 && add === 'rls' && an === 'perm') || J({ n, read, add, an });
  });

  section('4. the gate on bookings');
  await check('not answered (NULL) → refused, with the container number', async () => {
    const r = await book(T.t, T.c2);
    return /^MRS_STORAGE_UNPAID SGTU\d{6}2$/.test(r) || r;
  });
  await check('issued / sent → refused; none / paid → the booking passes (per container)', async () => {
    await setState(T.c2, 'issued'); const a = await book(T.t, T.c2);
    await setState(T.c2, 'sent');   const b = await book(T.t, T.c2);
    await setState(T.c1, 'none');   const c = await book(T.t, T.c1);
    await setState(T.c2, 'paid');   const d = await book(T.t, T.c2);
    return (/^MRS_STORAGE_UNPAID/.test(a) && /^MRS_STORAGE_UNPAID/.test(b) && c === 'ok' && d === 'ok') || J([a, b, c, d]);
  });
  const T2 = await mkTx('SAJED');
  await check('without a container: any unsettled container of the transaction refuses', async () => {
    await setState(T2.c1, 'paid');
    const a = await book(T2.t, null);
    await setState(T2.c2, 'none');
    const b = await book(T2.t, null);
    return (/^MRS_STORAGE_UNPAID SGTU\d{6}2$/.test(a) && b === 'ok') || J([a, b]);
  });
  await check('a reschedule, a closed status and a run without a user request are not gated', async () => {
    const T3 = await mkTx('SAJED');
    const orig = (await q(`INSERT INTO public.port_appointments (org_id, transaction_id, container_id, appointment_at, status) VALUES ($1, $2, $3, now(), 'requested') RETURNING id`, [A, T3.t, T3.c1]))[0].id;
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U.jed, role: 'authenticated' })]);
    const resch = await code(() => q(`INSERT INTO public.port_appointments (org_id, transaction_id, container_id, appointment_at, status, rescheduled_from_id) VALUES ($1, $2, $3, now() + interval '1 day', 'requested', $4)`, [A, T3.t, T3.c1, orig]));
    const done = await code(() => q(`INSERT INTO public.port_appointments (org_id, transaction_id, container_id, appointment_at, status) VALUES ($1, $2, $3, now() - interval '1 day', 'completed')`, [A, T3.t, T3.c2]));
    const live = await code(() => q(`INSERT INTO public.port_appointments (org_id, transaction_id, container_id, appointment_at, status) VALUES ($1, $2, $3, now() + interval '2 day', 'requested')`, [A, T3.t, T3.c2]));
    await db.exec(`SELECT set_config('request.jwt.claims', '', false)`);
    return (resch === 'ok' && done === 'ok' && /^MRS_STORAGE_UNPAID/.test(live)) || J({ resch, done, live });
  });
  await check('another port, an inactive gate row and Ro-Ro are not gated', async () => {
    const D = await mkTx('SADMM');
    const a = await book(D.t, D.c1);
    const T4 = await mkTx('SAJED');
    await q(`UPDATE public.storage_gate_ports SET is_active = false WHERE org_id = $1 AND port_code = 'SAJED'`, [A]);
    const b = await book(T4.t, T4.c1);
    await q(`UPDATE public.storage_gate_ports SET is_active = true WHERE org_id = $1 AND port_code = 'SAJED'`, [A]);
    const R = await mkTx('SAJED', 'roro');
    const c = await book(R.t, null);
    return (a === 'ok' && b === 'ok' && c === 'ok') || J([a, b, c]);
  });

  section('5. tx_storage_gate + approve_storage_override');
  const T5 = await mkTx('SAJED');
  await check('tx_storage_gate: applies, blocked, the containers with their state, can_override false for clearance staff / true for a manager', async () => {
    const g = (await as('jed', `SELECT public.tx_storage_gate($1) r`, [T5.t]))[0].r;
    const m = (await as('opsm', `SELECT public.tx_storage_gate($1) r`, [T5.t]))[0].r;
    return (g.applies === true && g.blocked === true && g.port_code === 'SAJED' && g.containers.length === 2 && g.containers[0].storage_state === null
      && g.override === null && g.can_override === false && m.can_override === true) || J({ g, m });
  });
  await check('tx_storage_gate: staff of another org → not found; anon → no access', async () => {
    const a = await code(() => as('staffB', `SELECT public.tx_storage_gate($1)`, [T5.t]));
    const b = await code(() => as('anon', `SELECT public.tx_storage_gate($1)`, [T5.t]));
    return (a === 'MRS_NOT_FOUND transaction' && b === 'perm') || J([a, b]);
  });
  await check('approve_storage_override: clearance staff forbidden; a short reason invalid; no direct insert', async () => {
    const a = await code(() => as('jed', `SELECT public.approve_storage_override($1, 'العميل وعد بالسداد')`, [T5.t]));
    const b = await code(() => as('opsm', `SELECT public.approve_storage_override($1, 'لا')`, [T5.t]));
    const c = await code(() => as('opsm', `INSERT INTO public.tx_storage_overrides (org_id, transaction_id, reason, approved_by) VALUES ($1, $2, 'xyz', $3)`, [A, T5.t, U.opsm]));
    return (a === 'MRS_FORBIDDEN storage_override' && b === 'MRS_INVALID reason' && c === 'perm') || J([a, b, c]);
  });
  await check('a manager approves (who / when / why); the booking then passes; a second approval conflicts; tx_storage_gate shows it', async () => {
    const before = await book(T5.t, T5.c1);
    const r = (await as('opsm', `SELECT public.approve_storage_override($1, 'العميل وعد بالسداد اليوم') r`, [T5.t]))[0].r;
    const after = await book(T5.t, T5.c1);
    const again = await code(() => as('opsm', `SELECT public.approve_storage_override($1, 'مرة ثانية')`, [T5.t]));
    const g = (await as('jed', `SELECT public.tx_storage_gate($1) r`, [T5.t]))[0].r;
    return (/^MRS_STORAGE_UNPAID/.test(before) && r.reason === 'العميل وعد بالسداد اليوم' && after === 'ok' && again === 'MRS_CONFLICT storage_override'
      && g.blocked === false && g.override && g.override.approved_by_name === 'مدير العمليات') || J({ before, r, after, again, g });
  });
}


/* ------------------------------------------------------------------ 6. the «الأرضيات» section (ops/tx-storage.js, static + pure) */
async function secUi() {
  section('6. «الأرضيات» on the transaction page');
  const vm = require('vm');
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/ops/tx-storage.js'), 'utf8');
  const ctx = { window: {}, Array, Object, String, Number, JSON, Math, Promise, RegExp };
  ctx.window.window = ctx.window; vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'tx-storage.js' });
  const TS = ctx.window.MarsaOps && ctx.window.MarsaOps.txStorage, P = TS && TS.pure;
  await check('tx-storage.js registers the «storage» section (order 45, after «الحاويات», before the appointments)', () => {
    const sec = ctx.window.MarsaOps.txSections.filter(x => x.id === 'storage');
    return (TS && TS.VERSION === 'stg-1' && sec.length === 1 && sec[0].order === 45) || 'section';
  });
  await check('gateView: hidden when the gate does not apply; red while blocked; yellow when open by a manager approval with an unsettled container; green when settled', () => {
    const off = P.gateView({ applies: false });
    const red = P.gateView({ applies: true, blocked: true, can_override: true, containers: [{ id: 'a', container_no: 'X', storage_state: null }, { id: 'b', container_no: 'Y', storage_state: 'sent' }] });
    const yel = P.gateView({ applies: true, blocked: false, override: { reason: 'r' }, containers: [{ id: 'a', storage_state: 'issued' }] });
    const grn = P.gateView({ applies: true, blocked: false, containers: [{ id: 'a', storage_state: 'none' }, { id: 'b', storage_state: 'paid' }] });
    return (off.show === false && red.tone === 'danger' && red.canOverride === true && red.rows[0].settled === false && red.rows[1].remind === 'stg_remind_sent'
      && yel.tone === 'warning' && yel.byOverride === true && yel.canOverride === false && grn.tone === 'success' && grn.rows.every(r => r.settled)) || JSON.stringify({ red, yel, grn });
  });
  await check('rowPatch: the state list only; the amount in digits (Arabic-Indic accepted, 2 decimals); empty → null', () => {
    const a = P.rowPatch({ state: 'paid', invoice: ' INV-1 ', amount: '٧٠٠' });
    const b = P.rowPatch({ state: 'maybe' }), c = P.rowPatch({ state: 'sent', amount: '12,5' }), d = P.rowPatch({ state: '', amount: 'abc' }), e = P.rowPatch({ state: '' });
    return (a.patch.storage_state === 'paid' && a.patch.storage_invoice_no === 'INV-1' && a.patch.storage_amount === 700 && b.error === 'state'
      && c.patch.storage_amount === 12.5 && d.error === 'amount' && e.patch.storage_state === null && e.patch.storage_amount === null) || JSON.stringify([a, b, c, d, e]);
  });
  await check('wiring: admin.html loads tx-storage.js after tx-draft.js and before admin.js; sw.js precaches it; supa.js exports the three calls; ES5 / no innerHTML', () => {
    const h = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8'), sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), su = fs.readFileSync(path.join(ROOT, 'assets/js/supa.js'), 'utf8');
    const i1 = h.indexOf('assets/js/ops/tx-draft.js'), i2 = h.indexOf('assets/js/ops/tx-storage.js'), i3 = h.indexOf('assets/js/admin.js');
    return (i1 > 0 && i2 > i1 && i3 > i2 && sw.includes("'assets/js/ops/tx-storage.js'") && /txStorageGate: txStorageGate, approveStorageOverride: approveStorageOverride, updateContainerStorage: updateContainerStorage/.test(su)
      && !/innerHTML|=>|\blet\b|\bconst\b/.test(src)) || 'wiring';
  });
  await check('strings: every stg_* key used exists in ar and en; MRS_STORAGE_UNPAID in supa.js and i18n.js (ar + en)', () => {
    const ops = fs.readFileSync(path.join(ROOT, 'assets/i18n/ops.js'), 'utf8'), i18 = fs.readFileSync(path.join(ROOT, 'assets/js/i18n.js'), 'utf8'), su = fs.readFileSync(path.join(ROOT, 'assets/js/supa.js'), 'utf8');
    const used = [...new Set((src.match(/T\('(stg_[a-z_]+)'/g) || []).map(x => x.slice(3, -1)))].filter(k => !/_$/.test(k)).concat(['stg_state_null', 'stg_state_none', 'stg_state_issued', 'stg_state_sent', 'stg_state_paid', 'stg_err_amount', 'stg_err_state', 'stg_remind_issued', 'stg_remind_sent']);
    const miss = used.filter(k => ops.split('\n').filter(l => l.indexOf(k + ': \'') !== -1).length !== 2 && (ops.match(new RegExp(k + ": '", 'g')) || []).length !== 2);
    return (!miss.length && (i18.match(/MRS_STORAGE_UNPAID: '/g) || []).length === 2 && /MRS_STORAGE_UNPAID: '/.test(su) && /cdetail_MRS_STORAGE_UNPAID_transaction/.test(i18)) || 'missing ' + JSON.stringify(miss);
  });
}

(async () => {
  console.log('Marsa — storage gate (3ج) SQL tests (PGlite; local only)');
  await secFile();
  await secRerun();
  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  await secMain();
  await secUi();
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
