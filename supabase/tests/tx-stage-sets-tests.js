#!/usr/bin/env node
/*
  Marsa (مرسى) — owner stages (step م2): migration 20261204000100_tx_stage_sets.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims).

  Covers: file conventions + all_migrations.sql; preflight refusal; re-run on itself (identical catalog); the default set
  (seven owner steps per org, seeding once); RLS (staff read their org only, the admin writes, no DELETE, anon nothing);
  step validation (unknown / repeated internal code, code format); app.tx_stage_set_for (most specific active set wins);
  tx_lifecycle 'steps' / 'stage_set' (grouping, detail, Ro-Ro skipped, the fallback defaults of an org without a set);
  the automatic move to billing (every container verified / waived → operationally_complete → under_billing, cause
  all_returned; a pending proof or an open container stops at empty_return; Ro-Ro unchanged; under_billing for any other
  cause refused); next.manual.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/tx-stage-sets-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261204000100_tx_stage_sets.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in tx-stage-sets-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'deca0000-0000-4000-8000-0000000000b0';           // second org (fixture)
const JED = '0b5e0000-0000-4000-8000-000000000011';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const BR_B = 'deca0000-0000-4000-8000-0000000000b1';
const CL_B = 'deca0000-0000-4000-8000-0000000000b3';
const U = {
  admin: 'deca0000-0000-4000-8000-000000000001',    // admin of A
  opsm: 'deca0000-0000-4000-8000-000000000004',     // operations_manager of A, org-wide
  jed: 'deca0000-0000-4000-8000-000000000005',      // clearance_staff of A, JED only
  portal: 'deca0000-0000-4000-8000-000000000008',   // client user of CLIENT_A
  staffB: 'deca0000-0000-4000-8000-00000000000a'    // admin of B
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
    x = m.match(/duplicate key value violates unique constraint "([^"]+)"/); if (x) return 'uniq:' + x[1];
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
let keySeq = 0;
const newKey = () => 'decaaaac-0000-4000-8000-' + String(++keySeq).padStart(12, '0');

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind = 'r' ORDER BY 1`)).map(x => x.t);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('app','public') ORDER BY 1`)).map(x => x.x);
  const pol = (await q(`SELECT tablename || '.' || policyname x FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const rows = await q(`SELECT (SELECT count(*) FROM public.tx_stage_sets) s, (SELECT count(*) FROM public.tx_stage_steps) st`);
  return { fns, tables, trg, pol, rows };
}

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@stages.example.com', now()), ('${U.opsm}', 'opsm@stages.example.com', now()),
    ('${U.jed}', 'jed@stages.example.com', now()), ('${U.portal}', 'portal@stages.example.com', now()),
    ('${U.staffB}', 'staffb@stages.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.opsm}', 'opsm'), ('${U.jed}', 'jed'),
    ('${U.portal}', 'portal'), ('${U.staffB}', 'staffB') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'stages-org-b', 'مؤسسة ب', 'Stages org B', 'STB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', '0509990000');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.opsm}', '${A}', NULL, 'operations_manager'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;
async function mkTx(who, cols) {
  const c = Object.assign({ org_id: A, branch_id: JED, client_id: CLIENT_A, operation: 'import', mode: 'sea' }, cols || {});
  const k = Object.keys(c);
  return (await as(who || 'jed', `INSERT INTO public.transactions (${k.join(', ')}) VALUES (${k.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`,
    Object.values(c)))[0].id;
}
const addCtr = (tx, no) => as('jed', `INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3) RETURNING id`, [A, tx, no]).then(r => r[0].id);
const st = async id => (await one(`SELECT operational_status s FROM public.transactions WHERE id = $1`, [id])).s;
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
const addDecl = (tx, no) => rpc('jed', `SELECT public.add_declaration($1, $2, $3) r`, [tx, { declaration_no: no }, newKey()]);
const declStatus = (id, s) => rpc('jed', `SELECT public.set_declaration_status($1, $2) r`, [id, s]);
const mkTrip = p => rpc('jed', `SELECT public.create_trip($1, $2) r`, [p, newKey()]);
const lifecycle = (who, tx) => rpc(who, `SELECT public.tx_lifecycle($1) r`, [tx]);
const waive = c => as('opsm', `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'اختبار' WHERE id = $1`, [c]);
const autoEvents = tx => q(`SELECT to_status, payload FROM public.transaction_events
                             WHERE transaction_id = $1 AND event_type = 'operational_status' AND (payload ->> 'auto')::boolean ORDER BY id`, [tx]);
// a container transaction carried to transport: declaration added + released, a trip
async function toTransport(bl, ctrs) {
  const t = await mkTx('jed', { bl_number: bl, container_count: ctrs.length });
  const ids = [];
  for (const n of ctrs) ids.push(await addCtr(t, n));
  const d = (await addDecl(t, bl + '-D')).id;
  await declStatus(d, 'released');
  await mkTrip({ transaction_id: t, container_id: ids[0] });
  return { t, ids };
}
let docSeq = 0;
async function evidenceDoc(tx) {
  const id = 'decadddd-0000-4000-8000-' + String(++docSeq).padStart(12, '0');
  await q(`INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, uploaded_by)
           VALUES ($1, $2, $3, 'empty_return_receipt', $4, $5, 'r.pdf', 10, $6)`, [id, A, tx, A + '/' + tx + '/' + id + '/r.pdf', 'c'.repeat(64), U.jed]);
  return id;
}

/* ------------------------------------------------------------------ 1. file + all_migrations.sql */
async function secFile() {
  section('1. file + all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('migration: preflight on draft_client_hidden (20261203000100), schema_versions row, no BEGIN/COMMIT, down-path, every function pins search_path', () => {
    const fns = (s.match(/CREATE OR REPLACE FUNCTION/g) || []).length, pinned = (s.match(/SET search_path = ''/g) || []).length;
    return (/version = '20261203000100'/.test(s) && /VALUES \('20261204000100', 'tx_stage_sets'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s)
      && /Down-path:/.test(s) && fns === 9 && pinned === 9) || J({ fns, pinned });
  });
  await check('no value list for transaction kinds: operation / mode / transaction_type / cargo_unit_type are format checks only', () =>
    (/operation\s+text CHECK \(operation ~ '\^\[a-z\]/.test(s) && /cargo_unit_type\s+text CHECK \(cargo_unit_type ~ /.test(s)
      && !/operation IN \(/.test(s.replace(/^--.*$/gm, ''))) || 'value list found');
  const LATER_PHASES = ['20261205000100_service_item_price.sql', '20261206000100_storage_gate.sql'];
  await check('this file is the latest migration (later phases excepted)', () => J(migFiles().filter(f => f > MIG)) === J(LATER_PHASES) || 'later ' + J(migFiles().filter(f => f > MIG)));
  const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
  await check('all_migrations.sql: appended verbatim under its header (followed only by the later phases); the paste note names it', () => {
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    return (i > 0 && (body === s || body === s + '\n' || body + '\n' === s) && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles()))
      || 'not appended verbatim / no note / order';
  });
}

/* ------------------------------------------------------------------ 2. preflight + re-run */
async function secRerun() {
  section('2. preflight + re-run');
  const d = await freshDb(MIG);
  const saved = db; db = d;
  try {
    await check('preflight: refused without draft_client_hidden (nothing changed)', async () => {
      await q(`DELETE FROM public.schema_versions WHERE version = '20261203000100'`);
      const r = await code(() => db.exec(fs.readFileSync(MIG_FILE, 'utf8')));
      const t = await one(`SELECT to_regclass('public.tx_stage_sets') x`);
      await q(`INSERT INTO public.schema_versions (version, name) VALUES ('20261203000100', 'draft_client_hidden')`);
      return (/TX STAGE SETS preflight/.test(r) && t.x === null) || r;
    });
    await check('applies, then re-runs on itself with an identical catalog and no extra rows', async () => {
      await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      const c1 = J(await catalog());
      await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      const c2 = J(await catalog());
      return c1 === c2 || 'catalog changed on re-run';
    });
  } finally { await d.close(); db = saved; }
}

/* ------------------------------------------------------------------ 3. defaults + RLS */
async function secDefaults() {
  section('3. default set + RLS');
  await check('every org has one default set of the seven owner steps, in order, with their internal stages', async () => {
    const sets = await q(`SELECT org_id, count(*) n FROM public.tx_stage_sets GROUP BY org_id`);
    const steps = await q(`SELECT x.code, x.label_ar, x.internal_codes FROM public.tx_stage_steps x JOIN public.tx_stage_sets s ON s.id = x.set_id
                            WHERE s.org_id = $1 ORDER BY x.sort_order`, [A]);
    return (sets.length >= 2 && sets.every(r => Number(r.n) === 1)
      && J(steps.map(x => x.code)) === J(['o_new', 'o_active', 'o_opdone', 'o_empty', 'o_under_billing', 'o_billed', 'o_closed'])
      && steps[2].label_ar === 'منتهية تشغيليًا' && J(steps[2].internal_codes) === J(['appointment', 'transport'])
      && J(steps[4].internal_codes) === J(['operationally_complete', 'under_billing'])) || J({ sets, steps });
  });
  await check('seeding again adds nothing (an org that has a set is left alone)', async () =>
    Number((await one(`SELECT app.seed_tx_stage_sets($1) n`, [A])).n) === 0);
  await check('RLS: staff read their own org only; the client user and anon read nothing', async () => {
    const a = await as('jed', `SELECT DISTINCT org_id FROM public.tx_stage_steps`);
    const b = await as('staffB', `SELECT DISTINCT org_id FROM public.tx_stage_sets`);
    const c = await as('portal', `SELECT count(*) n FROM public.tx_stage_sets`);
    const n = await code(() => as('anon', `SELECT count(*) FROM public.tx_stage_sets`));
    return (J(a.map(x => x.org_id)) === J([A]) && J(b.map(x => x.org_id)) === J([B]) && Number(c[0].n) === 0 && n === 'perm') || J({ a, b, c, n });
  });
  await check('RLS: clearance staff cannot add a set; org B admin cannot add one to org A; nobody deletes', async () => {
    const x = await code(() => as('jed', `INSERT INTO public.tx_stage_sets (org_id, name_ar) VALUES ($1, 'x')`, [A]));
    const y = await code(() => as('staffB', `INSERT INTO public.tx_stage_sets (org_id, name_ar) VALUES ($1, 'x')`, [A]));
    const z = await code(() => as('admin', `DELETE FROM public.tx_stage_steps WHERE org_id = $1`, [A]));
    return (x === 'rls' && y === 'rls' && z === 'perm') || J({ x, y, z });
  });
  await check('a step must group known internal stages, none twice; its code is a lower-case word', async () => {
    const set = (await one(`SELECT id FROM public.tx_stage_sets WHERE org_id = $1`, [A])).id;
    const ins = codes => code(() => as('admin', `INSERT INTO public.tx_stage_steps (org_id, set_id, code, label_ar, sort_order, internal_codes)
                                                   VALUES ($1, $2, 'o_x', 'س', 50, $3)`, [A, set, codes]));
    const a = await ins(['nope']), b = await ins(['new', 'new']);
    const c = await code(() => as('admin', `INSERT INTO public.tx_stage_steps (org_id, set_id, code, label_ar, sort_order, internal_codes)
                                              VALUES ($1, $2, 'Bad Code', 'س', 51, ARRAY['new'])`, [A, set]));
    return (a === 'MRS_INVALID internal_codes' && b === 'MRS_INVALID internal_codes' && /^chk:tx_stage_steps_code_check/.test(c)) || J({ a, b, c });
  });
  await check('the steps and sets are audited and stamped (created_by = the admin)', async () => {
    const r = await as('admin', `INSERT INTO public.tx_stage_sets (org_id, name_ar, mode) VALUES ($1, 'جوي', ' AIR ') RETURNING id, mode, created_by`, [A]);
    const a = await one(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'tx_stage_sets' AND row_id = $1`, [r[0].id]);
    return (r[0].mode === 'air' && r[0].created_by === U.admin && Number(a.n) >= 1) || J({ r, a });
  });
}

/* ------------------------------------------------------------------ 4. set choice + tx_lifecycle steps */
async function secSteps() {
  section('4. app.tx_stage_set_for + tx_lifecycle steps');
  await check('a new transaction: seven steps, «جديدة» current (detail = the internal stage), the rest todo; stage_set named', async () => {
    const t = await mkTx('jed', { bl_number: 'STG-1' });
    const r = await lifecycle('jed', t);
    return (r.steps.length === 7 && r.steps[0].code === 'o_new' && r.steps[0].state === 'current' && r.steps[0].detail.code === 'new'
      && r.steps.slice(1).every(x => x.state === 'todo') && r.stage_set && r.stage_set.name_ar === 'المراحل الافتراضية' && r.stages.length === 10) || J(r.steps);
  });
  await check('a more specific active set wins (Ro-Ro set for org A); other kinds keep the default', async () => {
    const s = (await as('admin', `INSERT INTO public.tx_stage_sets (org_id, name_ar, cargo_unit_type) VALUES ($1, 'رورو', 'roro') RETURNING id`, [A]))[0].id;
    await as('admin', `INSERT INTO public.tx_stage_steps (org_id, set_id, code, label_ar, sort_order, internal_codes) VALUES
      ($1, $2, 'r_new', 'جديدة', 1, ARRAY['new','in_progress']), ($1, $2, 'r_customs', 'الجمارك', 2, ARRAY['customs_declaration','appointment']),
      ($1, $2, 'r_done', 'التسليم والفوترة', 3, ARRAY['transport','empty_return','operationally_complete','under_billing','billed','closed'])`, [A, s]);
    const ro = await mkTx('jed', { bl_number: 'STG-RORO', cargo_unit_type: 'roro', chassis_no: 'VINSTG001' });
    const co = await mkTx('jed', { bl_number: 'STG-CTR' });
    const a = await lifecycle('jed', ro), b = await lifecycle('jed', co);
    const pick = (await one(`SELECT app.tx_stage_set_for($1) x`, [ro])).x;
    return (pick === s && J(a.steps.map(x => x.code)) === J(['r_new', 'r_customs', 'r_done']) && a.stage_set.name_ar === 'رورو'
      && b.steps.length === 7 && b.stage_set.name_ar === 'المراحل الافتراضية') || J({ a: a.steps, b: b.stage_set });
  });
  await check('an inactive set no longer applies', async () => {
    await as('admin', `UPDATE public.tx_stage_sets SET is_active = false WHERE org_id = $1 AND cargo_unit_type = 'roro'`, [A]);
    const ro = await mkTx('jed', { bl_number: 'STG-RORO2', cargo_unit_type: 'roro', chassis_no: 'VINSTG002' });
    const r = await lifecycle('jed', ro);
    return (r.steps.length === 7 && r.stage_set.name_ar === 'المراحل الافتراضية' && r.steps[3].state === 'skipped') || J(r.steps.map(x => x.code + ':' + x.state));
  });
  await check('Ro-Ro on the defaults: «إرجاع الحاوية الفارغة» skipped once passed (its only stage does not apply)', async () => {
    const ro = await mkTx('jed', { bl_number: 'STG-RORO3', cargo_unit_type: 'roro', chassis_no: 'VINSTG003' });
    await q(`UPDATE public.transactions SET operational_status = 'operationally_complete' WHERE id = $1`, [ro]);
    const r = await lifecycle('jed', ro);
    const by = Object.fromEntries(r.steps.map(x => [x.code, x.state]));
    return (by.o_empty === 'skipped' && by.o_opdone === 'done' && by.o_under_billing === 'current' && by.o_billed === 'todo') || J(by);
  });
  await check('an org without a set (org B, sets removed by owner SQL) shows the seven defaults, stage_set null', async () => {
    await db.exec(`ALTER TABLE public.tx_stage_steps DISABLE TRIGGER USER; ALTER TABLE public.tx_stage_sets DISABLE TRIGGER USER;
             DELETE FROM public.tx_stage_steps WHERE org_id = '${B}'; DELETE FROM public.tx_stage_sets WHERE org_id = '${B}';
             ALTER TABLE public.tx_stage_steps ENABLE TRIGGER USER; ALTER TABLE public.tx_stage_sets ENABLE TRIGGER USER;`);
    const t = (await as('staffB', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea') RETURNING id`, [B, BR_B, CL_B]))[0].id;
    const r = await lifecycle('staffB', t);
    return (r.steps.length === 7 && r.stage_set === null && r.steps[0].label_ar === 'جديدة') || J(r);
  });
}

/* ------------------------------------------------------------------ 5. automatic move to billing */
async function secBilling() {
  section('5. automatic move to billing (every container verified / waived)');
  await check('one container waived → empty_return → operationally_complete → under_billing (causes container_return, all_returned ×2)', async () => {
    const { t, ids } = await toTransport('BILL-1', ['BILU0000001']);
    await waive(ids[0]);
    const e = (await autoEvents(t)).slice(-3);
    const r = await lifecycle('jed', t);
    const by = Object.fromEntries(r.steps.map(x => [x.code, x.state]));
    return ((await st(t)) === 'under_billing' && J(e.map(x => x.to_status)) === J(['empty_return', 'operationally_complete', 'under_billing'])
      && J(e.map(x => x.payload.cause)) === J(['container_return', 'all_returned', 'all_returned'])
      && by.o_empty === 'done' && by.o_under_billing === 'current') || J({ s: await st(t), e, by });
  });
  await check('two containers, one waived → stays at empty_return; the second waived → under_billing', async () => {
    const { t, ids } = await toTransport('BILL-2', ['BILU0000002', 'BILU0000003']);
    await waive(ids[0]);
    const mid = await st(t);
    await waive(ids[1]);
    return (mid === 'empty_return' && (await st(t)) === 'under_billing') || J({ mid, end: await st(t) });
  });
  await check('a proof still pending verification (evidence_submitted) stops at empty_return', async () => {
    const { t, ids } = await toTransport('BILL-3', ['BILU0000004']);
    const doc = await evidenceDoc(t);
    await as('opsm', `UPDATE public.containers SET return_status = 'evidence_submitted', evidence_document_id = $2 WHERE id = $1`, [ids[0], doc]);
    return (await st(t)) === 'empty_return' || await st(t);
  });
  await check('container_count above the containers entered keeps the gate closed (one entered of two, waived) → empty_return', async () => {
    const t = await mkTx('jed', { bl_number: 'BILL-4', container_count: 2 });
    const c = await addCtr(t, 'BILU0000005');
    const d = (await addDecl(t, 'BILL-4-D')).id;
    await declStatus(d, 'released');
    await mkTrip({ transaction_id: t, container_id: c });
    await waive(c);
    return (await st(t)) === 'empty_return' || await st(t);
  });
  await check('under_billing for any other cause is refused (forward-only engine; closed stays manual)', async () => {
    const t = await mkTx('jed', { bl_number: 'BILL-5' });
    await q(`UPDATE public.transactions SET operational_status = 'operationally_complete' WHERE id = $1`, [t]);
    const a = (await one(`SELECT app.advance_tx_status($1, 'under_billing', 'trip') x`, [t])).x;
    const b = (await one(`SELECT app.advance_tx_status($1, 'closed', 'all_returned') x`, [t])).x;
    return (a === 'operationally_complete' && b === 'operationally_complete') || J({ a, b });
  });
  await check('owner SQL (no JWT claims) never auto-moves: a waiver written by owner SQL leaves the stage alone', async () => {
    const { t, ids } = await toTransport('BILL-6', ['BILU0000006']);
    await q(`UPDATE public.containers SET return_status = 'waived', waiver_reason = 'مالك' WHERE id = $1`, [ids[0]]);
    return (await st(t)) === 'transport' || await st(t);
  });
  await check('next.manual: in_progress manual; operationally_complete / under_billing automatic for containers; under_billing manual for Ro-Ro', async () => {
    const t = await mkTx('jed', { bl_number: 'BILL-7' });
    await addCtr(t, 'BILU0000007');
    const a = (await lifecycle('jed', t)).next;
    await q(`UPDATE public.transactions SET operational_status = 'empty_return' WHERE id = $1`, [t]);
    const b = (await lifecycle('jed', t)).next;
    await q(`UPDATE public.transactions SET operational_status = 'operationally_complete' WHERE id = $1`, [t]);
    const c = (await lifecycle('jed', t)).next;
    const ro = await mkTx('jed', { bl_number: 'BILL-RORO', cargo_unit_type: 'roro', chassis_no: 'VINBILL01' });
    await q(`UPDATE public.transactions SET operational_status = 'operationally_complete' WHERE id = $1`, [ro]);
    const d = (await lifecycle('jed', ro)).next;
    return (a.code === 'in_progress' && a.manual && b.code === 'operationally_complete' && !b.manual && c.code === 'under_billing' && !c.manual
      && d.code === 'under_billing' && d.manual) || J({ a, b, c, d });
  });
  await check('tx_lifecycle stays staff-only (client user → MRS_NOT_FOUND; anon cannot execute)', async () => {
    const t = await mkTx('jed', { bl_number: 'BILL-8' });
    const a = await code(() => lifecycle('portal', t));
    const b = await code(() => as('anon', `SELECT public.tx_lifecycle($1)`, [t]));
    return (a === 'MRS_NOT_FOUND transaction' && b === 'perm') || J({ a, b });
  });
}

/* ================================================================== main */
(async () => {
  console.log('Marsa — owner stages (م2) SQL tests (PGlite; local only)');
  await secFile();
  await secRerun();
  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  // the seed orgs are created after the migrations: they get their default set here (as app.seed_tx_stage_sets does for
  // every org that exists when the migration runs)
  await q(`SELECT app.seed_tx_stage_sets(o.id) FROM public.organizations o`);
  await secDefaults();
  await secSteps();
  await secBilling();
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
