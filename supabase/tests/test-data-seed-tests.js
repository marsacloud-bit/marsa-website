#!/usr/bin/env node
/*
  Marsa (مرسى) — the test-data seed / cleanup of the org 'marsa': supabase/seed/test_data_seed.sql + test_data_cleanup.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory) with every migration. Never point it at Supabase.
  No network (fetch throws). Invented data only (a fake org 'marsa' + admin + branches + one non-test client / transaction,
  and a second org that also owns a «تجريبي — » client which the cleanup must not touch).

  Covers: the files are not migrations (not in all_migrations.sql / the migrations folder), no BEGIN/COMMIT, encoding guard;
    seed: the counts row, every operational status, Fasah stages, Ro-Ro / air / re-export, ISO 6346 check digits, client
      Daftra codes / categories, drivers' fake mobiles, party types, payments (types / pending only), shared payment,
      custody (deposit / deduction / refund), follow-up + critical badges; its own fleet (8 drivers / 6 trucks, never a
      find-or-create), Ro-Ro + air in several statuses, coherent dates (ETA ≤ declaration ≤ delivery ≤ return, payments
      after the declaration), stage-aging badges (status_stale warning + critical, declaration_stalled), no payment on a
      new transaction; the screens' RPCs answer as the admin
      (report_transactions, custody_balances, report_trips, list_payments, report_payments, dash_tx_counts, tx_attention);
      no outbox / e-mail / billing / Daftra / job / charge rows; role + JWT claims restored; a second run is refused and
      changes nothing;
    cleanup: refusals R1 (marker on a real client's transaction) / R2 (a real transaction uses a test party; a real
      driver / truck of a test carrier, a real supplier invoice of a test supplier, a real B/L of a test shipping agent —
      tables without a transaction / client column) — nothing deleted; a real driver whose last truck is a test truck is
      kept (pointer cleared); the run: proof row all 0, the database back to its pre-seed state (every table's row count,
      the audit trail, the usage counter VALUES, the triggers' enabled state), the non-test client / transaction
      byte-identical, the other org's «تجريبي — » client kept; a second cleanup is a harmless no-op;
    seed guards: an existing driver with a test mobile (another spelling) / a TST… truck → the seed is refused;
    production privileges: seed + cleanup once more as a NOSUPERUSER role that owns every public / app table and function
      (like postgres on Supabase): ALTER TABLE … DISABLE TRIGGER, SET ROLE back, RLS — all inside a rolled-back transaction.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/test-data-seed-tests.js [/path/to/marsa-website] [--quiet]
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
const SEED = path.join(SUPA, 'seed', 'test_data_seed.sql');
const CLEAN = path.join(SUPA, 'seed', 'test_data_cleanup.sql');
const README = path.join(SUPA, 'seed', 'README_TEST_DATA_AR.md');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in test-data-seed-tests'); };

const ORG = 'f2000000-0000-4000-8000-000000000001';
const ORG2 = 'f2000000-0000-4000-8000-0000000000b0';
const JED = 'f2000000-0000-4000-8000-000000000011';
const ADMIN = 'f1000000-0000-4000-8000-000000000001';
const CLERK = 'f1000000-0000-4000-8000-000000000002';
const REAL_CLIENT = 'f3000000-0000-4000-8000-000000000001';
const REAL_TX = 'f3000000-0000-4000-8000-000000000002';
const ORG2_CLIENT = 'f3000000-0000-4000-8000-0000000000b1';
const PREFIX = 'تجريبي — ';

let db;
const J = x => JSON.stringify(x);
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
async function check(name, fn) {
  try {
    const r = await fn();
    if (typeof r === 'string') fail(name, r);
    else if (r === false || r === null || r === 0 || r === undefined) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + errText(e) + '\n        ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')); }
}
async function asAdmin(fn) {
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [J({ sub: ADMIN, role: 'authenticated', aal: 'aal1' })]);
  await db.exec('SET ROLE authenticated;');
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
const rpc = (sql, params) => asAdmin(async () => (await q(sql, params))[0].r);
// the last result set of a multi-statement file
async function runFile(file) { const r = await db.exec(fs.readFileSync(file, 'utf8')); return r[r.length - 1].rows; }
async function runFileErr(file) { try { await runFile(file); return null; } catch (e) { return errText(e); } }

// every public / app table's row count (the whole database "state" the seed may touch)
async function tableCounts() {
  const ts = await q(`SELECT format('%I.%I', n.nspname, c.relname) t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE c.relkind = 'r' AND n.nspname IN ('public','app') ORDER BY 1`);
  const out = {};
  for (const { t } of ts) out[t] = Number((await one(`SELECT count(*) n FROM ${t}`)).n);
  return out;
}
const triggerState = () => q(`SELECT t.tgrelid::regclass::text tb, t.tgname, t.tgenabled FROM pg_trigger t WHERE NOT t.tgisinternal ORDER BY 1, 2`);
const sideTables = () => q(`SELECT format('%I.%I', n.nspname, c.relname) t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname IN ('public','app')
    AND (c.relname ~ '^(msg_|billing_|daftra_)' OR c.relname ~ '(outbox|email|notif|job|queue|webhook)'
         OR c.relname IN ('client_charges','charge_collections','service_requests','contact_messages','invitations','report_exports'))
  ORDER BY 1`);

const FIXTURE = `
  SELECT public.set_deploy_environment('production');
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${ADMIN}', 'owner@seedtest.example.com', now()), ('${CLERK}', 'clerk@seedtest.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${ADMIN}', 'مالك تجريبي'), ('${CLERK}', 'موظف فرع تجريبي')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix) VALUES
    ('${ORG}', 'marsa', 'مؤسسة البحر الأزرق', 'Blue Sea Est.', 'MRS'), ('${ORG2}', 'other-org', 'مؤسسة أخرى', 'Other', 'OTH');
  INSERT INTO public.branches (id, org_id, code, name_ar, city) VALUES
    ('${JED}', '${ORG}', 'JED', 'فرع جدة', 'جدة'), ('f2000000-0000-4000-8000-000000000012', '${ORG}', 'DMM', 'فرع الدمام', 'الدمام'),
    ('f2000000-0000-4000-8000-0000000000b2', '${ORG2}', 'RUH', 'فرع الرياض', 'الرياض');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role, is_active) VALUES
    ('${ADMIN}', '${ORG}', NULL, 'admin', true), ('${CLERK}', '${ORG}', '${JED}', 'clearance_staff', true);
  SELECT app.seed_document_requirements('${ORG}');
  -- the worst case of the Daftra settings: connected, sync on, the opening draft on every declaration, purchase drafts on.
  -- The seed must still create no billing intent / job / review item (the deferred opening trigger only acts for a request
  -- with JWT claims; the seed clears them before its transaction commits)
  INSERT INTO public.daftra_connections (org_id, status, sync_enabled, auto_draft_on_declaration, purchase_drafts_enabled)
    VALUES ('${ORG}', 'connected', true, true, true);
  INSERT INTO public.clients (id, org_id, client_type, name_ar) VALUES ('${ORG2_CLIENT}', '${ORG2}', 'business', '${PREFIX}عميل مؤسسة أخرى');
  -- one real-looking (non-test) client + transaction + container, made the way the app makes them (the admin through RLS)
  SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated","aal":"aal1"}', false);
  SET ROLE authenticated;
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en) VALUES ('${REAL_CLIENT}', '${ORG}', 'business', 'شركة النخبة للتجارة', 'Elite Trading');
  INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, port_code, bl_number, container_count)
    VALUES ('${REAL_TX}', '${ORG}', '${JED}', '${REAL_CLIENT}', 'import', 'sea', 'SAJED', 'REALBL0001', 1);
  INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ('${ORG}', '${REAL_TX}', 'MSCU1234565');
  RESET ROLE;
  SELECT set_config('request.jwt.claims', '', false);
`;
const realSnapshot = async () => J(await q(`
  SELECT (SELECT to_jsonb(c) FROM public.clients c WHERE c.id = '${REAL_CLIENT}') cl,
         (SELECT to_jsonb(t) FROM public.transactions t WHERE t.id = '${REAL_TX}') tx,
         (SELECT jsonb_agg(to_jsonb(k) ORDER BY k.id) FROM public.containers k WHERE k.transaction_id = '${REAL_TX}') ct,
         (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.transaction_events e WHERE e.transaction_id = '${REAL_TX}') ev,
         (SELECT to_jsonb(c) FROM public.clients c WHERE c.id = '${ORG2_CLIENT}') other`));

/* ------------------------------------------------------------------ 1. files */
async function secFiles() {
  section('1. files');
  const seed = fs.readFileSync(SEED, 'utf8'), clean = fs.readFileSync(CLEAN, 'utf8');
  const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
  await check('seed / cleanup / README exist; not migrations (not in all_migrations.sql, not in migrations/)', () =>
    fs.existsSync(README) && !/test_data_(seed|cleanup)/.test(all)
      && !fs.readdirSync(MIG_DIR).some(f => /test_data/.test(f)));
  await check('no BEGIN / COMMIT (the SQL editor wraps one transaction); encoding guard; slug lookup, never an e-mail', () =>
    [seed, clean].every(s => !/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(s) && s.includes("U&'\\062C\\062F\\064A\\062F'")
      && /slug = 'marsa'/.test(s) && !/email\s*=/.test(s)));
  await check('seed never sets charge_client, never touches billing / Daftra / message tables, never creates auth users', () =>
    !/charge_client'\s*,\s*true/.test(seed) && !/INSERT INTO (public\.)?(billing_|daftra_|msg_)/i.test(seed)
      && !/auth\.users/.test(seed) && !/INSERT INTO public\.(memberships|branches|organizations)/.test(seed));
  await check('cleanup disables only named triggers (no session_replication_role) and re-enables them', () =>
    !/session_replication_role\s*=/.test(clean.replace(/^--.*$/mg, '')) && /DISABLE TRIGGER %I/.test(clean) && /ENABLE %s TRIGGER %I/.test(clean));
}

/* ------------------------------------------------------------------ 2. seed */
let before, beforeTrg, beforeReal, seedRow, sideBefore, beforeUsage;
const usageValues = async () => J(await q(`SELECT org_id, metric, period_start, value FROM public.org_usage_counters ORDER BY 1, 2, 3`));
async function secSeed() {
  section('2. seed');
  before = await tableCounts();
  beforeTrg = J(await triggerState());
  beforeReal = await realSnapshot();
  beforeUsage = await usageValues();
  const side = await sideTables();
  sideBefore = {}; for (const { t } of side) sideBefore[t] = before[t];
  await check('seed runs; the last statement is one row of counts', async () => {
    const rows = await runFile(SEED);
    seedRow = rows[0];
    return (rows.length === 1 && seedRow.clients === 20 && seedRow.transactions >= 40 && seedRow.transactions <= 80) || J(rows);
  });
  await check('counts row: containers, declarations, appointments, trips, payments, custody all > 0', () =>
    ['containers', 'declarations', 'appointments', 'trips', 'payments', 'payment_allocations', 'custody_movements']
      .every(k => Number(seedRow[k]) > 0) || J(seedRow));
  await check('role and JWT claims are back (postgres, no claims) after the seed', async () => {
    const r = await one(`SELECT current_user u, coalesce(current_setting('request.jwt.claims', true), '') c`);
    return (r.u === 'postgres' && r.c === '') || J(r);
  });
  await check('every operational status is present (new … closed) + one cancelled', async () => {
    const by = seedRow.transactions_by_status;
    const need = ['new','in_progress','customs_declaration','appointment','transport','empty_return','operationally_complete','under_billing','billed','closed','cancelled'];
    return need.every(s => by[s] > 0) || J(by);
  });
  // the seed's status plan, exactly (owner decision 2026-11-20: «تحت الفوترة» stays manual — the last waived return must
  // not move a transaction on by itself, so empty_return keeps its 7 and the later stages their own counts)
  await check('per-status spread = the plan: new 6, in_progress 6, customs_declaration 10, appointment 7, transport 9, empty_return 7, operationally_complete 6, under_billing 5, billed 3, closed 1, cancelled 1 (61)', async () => {
    const by = seedRow.transactions_by_status;
    const plan = { new: 6, in_progress: 6, customs_declaration: 10, appointment: 7, transport: 9, empty_return: 7,
      operationally_complete: 6, under_billing: 5, billed: 3, closed: 1, cancelled: 1 };
    const got = {};
    for (const k of Object.keys(by)) got[k] = Number(by[k]);
    const keys = Object.keys(got).sort(), want = Object.keys(plan).sort();
    return (J(keys) === J(want) && want.every(k => got[k] === plan[k]) && Number(seedRow.transactions) === 61) || J({ got, plan });
  });
  await check('no automatic move past empty_return during the seed (every operationally_complete / under_billing / billed / closed event was a hand move)', async () => {
    const r = await one(`SELECT count(*) n FROM transaction_events e JOIN transactions t ON t.id = e.transaction_id
                          WHERE t.bl_number LIKE 'TESTBL%' AND e.event_type = 'operational_status'
                            AND e.to_status IN ('operationally_complete','under_billing','billed','closed')
                            AND coalesce((e.payload ->> 'auto')::boolean, false)`);
    return Number(r.n) === 0 || J(r);
  });
  await check('statuses match the data: appointment ⇒ appointment(s) and no trip; transport+ (containers) ⇒ trips; complete+ ⇒ all returned', async () => {
    const r = await one(`
      SELECT count(*) FILTER (WHERE t.operational_status = 'appointment' AND (NOT EXISTS (SELECT 1 FROM port_appointments a WHERE a.transaction_id = t.id)
                                OR EXISTS (SELECT 1 FROM transport_trips r WHERE r.transaction_id = t.id))) bad_appt,
             count(*) FILTER (WHERE t.operational_status IN ('transport','empty_return','operationally_complete','under_billing','billed','closed')
                                AND t.cancelled_at IS NULL AND t.container_count > 0
                                AND NOT EXISTS (SELECT 1 FROM transport_trips r WHERE r.transaction_id = t.id)) bad_trip,
             count(*) FILTER (WHERE t.operational_status IN ('operationally_complete','under_billing','billed','closed') AND t.cancelled_at IS NULL
                                AND EXISTS (SELECT 1 FROM containers c WHERE c.transaction_id = t.id AND c.return_status NOT IN ('returned_verified','waived'))) bad_ret,
             count(*) FILTER (WHERE t.operational_status = 'empty_return'
                                AND NOT EXISTS (SELECT 1 FROM containers c WHERE c.transaction_id = t.id AND c.return_status = 'waived')) bad_er
        FROM transactions t WHERE t.bl_number LIKE 'TESTBL%'`);
    return (Number(r.bad_appt) + Number(r.bad_trip) + Number(r.bad_ret) + Number(r.bad_er) === 0) || J(r);
  });
  await check('refs from the normal numbering (MRS-…), follow-up employee = the admin, branch = an active branch of the org, marker on every transaction', async () => {
    const r = await one(`SELECT count(*) n, count(*) FILTER (WHERE ref LIKE 'MRS-%') refs, count(*) FILTER (WHERE responsible_user_id = '${ADMIN}') resp,
                                count(DISTINCT branch_id) br, count(*) FILTER (WHERE notes = 'TEST-SEED') mk
                           FROM transactions WHERE bl_number LIKE 'TESTBL%'`);
    return (r.n === r.refs && r.n === r.resp && Number(r.br) === 1 && r.n === r.mk) || J(r);
  });
  await check('clients: 20 «تجريبي — », Daftra codes TST-1001…TST-1020, categories airport / port / shared, no e-mail / phone', async () => {
    const r = await one(`SELECT count(*) n, count(DISTINCT port_category) cats, min(daftra_client_code) lo, max(daftra_client_code) hi,
                                count(*) FILTER (WHERE email IS NOT NULL OR phone IS NOT NULL) contact
                           FROM clients WHERE org_id = '${ORG}' AND name_ar LIKE '${PREFIX}%'`);
    return (Number(r.n) === 20 && Number(r.cats) === 3 && r.lo === 'TST-1001' && r.hi === 'TST-1020' && Number(r.contact) === 0) || J(r);
  });
  await check('2–4 transactions per client', async () => {
    const r = await one(`SELECT min(n) lo, max(n) hi FROM (SELECT count(*) n FROM transactions WHERE bl_number LIKE 'TESTBL%' GROUP BY client_id) x`);
    return (Number(r.lo) >= 2 && Number(r.hi) <= 4) || J(r);
  });
  await check('containers: 1–3 per container transaction, TSTU… with a valid ISO 6346 check digit, seal + size', async () => {
    const r = await one(`SELECT count(*) n, count(*) FILTER (WHERE app.msg_iso6346_ok(c.container_no)) ok,
                                count(*) FILTER (WHERE c.seal_no LIKE 'TSTSEAL%' AND c.size_type IS NOT NULL) meta,
                                (SELECT max(m) FROM (SELECT count(*) m FROM containers k WHERE k.container_no LIKE 'TSTU%' GROUP BY k.transaction_id) y) mx
                           FROM containers c WHERE c.container_no LIKE 'TSTU%'`);
    return (Number(r.n) > 0 && r.n === r.ok && r.n === r.meta && Number(r.mx) <= 3) || J(r);
  });
  await check('Ro-Ro (chassis + plate, no container), air and re-export transactions exist; approved ports only', async () => {
    const r = await one(`SELECT count(*) FILTER (WHERE cargo_unit_type = 'roro' AND chassis_no IS NOT NULL AND vehicle_plate_no IS NOT NULL AND container_count = 0) roro,
                                count(*) FILTER (WHERE mode = 'air') air, count(*) FILTER (WHERE transaction_type = 're_export') rex,
                                count(*) FILTER (WHERE port_code IS NULL OR port_code NOT IN (SELECT code FROM customs_ports)) badport
                           FROM transactions WHERE bl_number LIKE 'TESTBL%'`);
    return (Number(r.roro) > 0 && Number(r.air) > 0 && Number(r.rex) > 0 && Number(r.badport) === 0) || J(r);
  });
  await check('declarations: every Fasah stage (draft … released), Hijri + Gregorian dates, TSTD… numbers mirrored on the transaction', async () => {
    const r = await one(`SELECT count(DISTINCT d.status) st, count(*) FILTER (WHERE d.declaration_date_hijri ~ '^14[0-9]{2}/[0-9]{2}/[0-9]{2}$' AND d.declaration_date IS NOT NULL) dated,
                                count(*) n, count(*) FILTER (WHERE t.declaration_no = d.declaration_no) mirrored
                           FROM customs_declarations d JOIN transactions t ON t.id = d.transaction_id WHERE d.declaration_no LIKE 'TSTD%'`);
    return (Number(r.st) === 8 && r.n === r.dated && r.n === r.mirrored) || J(r);
  });
  await check('trips: fake drivers «تجريبي — » with 0500000xxx, trucks TST…, value + revenue, party types supplier / company / direct / unset', async () => {
    const r = await one(`SELECT (SELECT count(*) FROM drivers d WHERE d.org_id = '${ORG}' AND (d.full_name NOT LIKE '${PREFIX}%' OR d.phone !~ '^0500000[0-9]{3}$')) baddrv,
                                (SELECT count(*) FROM trucks k WHERE k.org_id = '${ORG}' AND k.plate_no !~ '^TST[0-9]+$') badtrk,
                                count(*) FILTER (WHERE r.cost_amount > 0 AND r.sell_amount > 0) money, count(*) n,
                                count(DISTINCT coalesce(r.party_type, 'unset')) pts, count(*) FILTER (WHERE r.status = 'delivered') dlv
                           FROM transport_trips r JOIN transactions t ON t.id = r.transaction_id WHERE t.bl_number LIKE 'TESTBL%'`);
    return (Number(r.baddrv) === 0 && Number(r.badtrk) === 0 && r.n === r.money && Number(r.pts) === 4 && Number(r.dlv) > 0) || J(r);
  });
  await check('payments: the 3 movement types, ≥ 5 funding sources, ≥ 5 methods, ≥ 5 service items; none approved (four eyes, one user)', async () => {
    const r = await one(`SELECT count(DISTINCT movement_type) mt, count(DISTINCT funding_source) fs, count(DISTINCT method) me, count(DISTINCT service_code) sv,
                                count(*) FILTER (WHERE review_status IN ('approved','rejected')) reviewed,
                                count(*) FILTER (WHERE review_status = 'pending') pend, count(*) FILTER (WHERE review_status = 'draft') dr
                           FROM client_disbursements WHERE org_id = '${ORG}' AND notes LIKE 'TEST-SEED%'`);
    return (Number(r.mt) === 3 && Number(r.fs) >= 5 && Number(r.me) >= 5 && Number(r.sv) >= 5 && Number(r.reviewed) === 0
      && Number(r.pend) > 0 && Number(r.dr) > 0) || J(r);
  });
  await check('one shared (aggregated) payment with 3 allocations summing to the paid amount', async () => {
    const r = await q(`SELECT d.paid_amount, sum(a.amount) s, count(*) n FROM client_disbursements d JOIN disbursement_allocations a ON a.disbursement_id = d.id
                        WHERE d.pattern = 'shared' AND d.notes LIKE 'TEST-SEED%' GROUP BY d.id, d.paid_amount`);
    return (r.length === 1 && Number(r[0].n) === 3 && Number(r[0].s) === Number(r[0].paid_amount)) || J(r);
  });
  await check('custody: 6 clients, deposits + deductions (each linked to a custody-funded payment) + refunds, no negative balance', async () => {
    const r = await one(`SELECT count(DISTINCT client_id) cl, count(*) FILTER (WHERE kind = 'deposit') dep, count(*) FILTER (WHERE kind = 'refund') ref,
                                count(*) FILTER (WHERE kind = 'deduction' AND disbursement_id IS NOT NULL) ded,
                                (SELECT count(*) FROM (SELECT client_id FROM client_custody_entries WHERE org_id = '${ORG}' AND status = 'active'
                                                        GROUP BY 1 HAVING sum(signed_amount) < 0) x) neg
                           FROM client_custody_entries WHERE org_id = '${ORG}' AND notes LIKE 'TEST-SEED%'`);
    return (Number(r.cl) === 6 && Number(r.dep) > 0 && Number(r.ref) > 0 && Number(r.ded) > 0 && Number(r.neg) === 0) || J(r);
  });
  await check('follow-up badges: overdue empty returns (critical) + passed appointments not updated (warning and critical)', async () => {
    const r = await q(`SELECT reason, level, count(*) n FROM app.att_reasons('${ORG}', NULL, now()) GROUP BY 1, 2`);
    const has = (re, lv) => r.some(x => x.reason === re && x.level === lv && Number(x.n) > 0);
    return (has('empty_return_overdue', 'critical') && has('appointment_not_updated', 'warning') && has('appointment_not_updated', 'critical')) || J(r);
  });
  await check('own fleet: exactly 8 drivers + 6 trucks, new rows created by the admin, used by every test trip / appointment', async () => {
    const r = await one(`SELECT (SELECT count(*) FROM drivers WHERE org_id = '${ORG}') drv, (SELECT count(*) FROM trucks WHERE org_id = '${ORG}') trk,
                                (SELECT count(*) FROM drivers WHERE org_id = '${ORG}' AND created_by = '${ADMIN}') drv_new,
                                (SELECT count(*) FROM transport_trips r JOIN transactions t ON t.id = r.transaction_id
                                  WHERE t.bl_number LIKE 'TESTBL%' AND (r.driver_id NOT IN (SELECT id FROM drivers WHERE full_name LIKE '${PREFIX}%')
                                                                        OR r.truck_id NOT IN (SELECT id FROM trucks WHERE plate_no ~ '^TST[0-9]+$'))) foreign_fleet`);
    return (Number(r.drv) === 8 && Number(r.trk) === 6 && Number(r.drv_new) === 8 && Number(r.foreign_fleet) === 0) || J(r);
  });
  await check('storage gate (20261206000100): every Jeddah test container with an appointment is settled (paid TSTSTG… / none), some earlier ones still issued / sent / not answered; nothing outside the gate ports', async () => {
    const r = await one(`WITH c AS (SELECT k.id, t.port_code, s.storage_state st, s.storage_invoice_no inv,
                                         EXISTS (SELECT 1 FROM port_appointments a WHERE a.container_id = k.id) booked
                                    FROM containers k JOIN transactions t ON t.id = k.transaction_id
                                    LEFT JOIN container_storage s ON s.container_id = k.id
                                   WHERE t.bl_number LIKE 'TESTBL%' AND t.org_id = '${ORG}')
      SELECT count(*) FILTER (WHERE port_code = 'SAJED' AND booked) booked_jed,
             count(*) FILTER (WHERE port_code = 'SAJED' AND booked AND (st IS NULL OR st NOT IN ('paid','none'))) booked_unsettled,
             count(*) FILTER (WHERE st = 'paid' AND inv !~ '^TSTSTG[0-9]{6}$') bad_inv,
             count(*) FILTER (WHERE port_code = 'SAJED' AND NOT booked AND (st IS NULL OR st IN ('issued','sent'))) open_jed,
             count(*) FILTER (WHERE port_code <> 'SAJED' AND st IS NOT NULL) outside FROM c`);
    return (Number(r.booked_jed) > 0 && Number(r.booked_unsettled) === 0 && Number(r.bad_inv) === 0 && Number(r.open_jed) > 0 && Number(r.outside) === 0) || J(r);
  });
  await check('Ro-Ro and air transactions each in at least 3 statuses (container-less stage skip exercised by both)', async () => {
    const r = await one(`SELECT count(DISTINCT operational_status) FILTER (WHERE cargo_unit_type = 'roro') roro,
                                count(DISTINCT operational_status) FILTER (WHERE mode = 'air') air,
                                count(*) FILTER (WHERE cargo_unit_type = 'roro' AND operational_status IN ('operationally_complete','under_billing')) roro_late
                           FROM transactions WHERE bl_number LIKE 'TESTBL%' AND cancelled_at IS NULL`);
    return (Number(r.roro) >= 3 && Number(r.air) >= 3 && Number(r.roro_late) > 0) || J(r);
  });
  await check('dates are coherent: ETA future for new, past from customs on; ETA ≤ declaration < today; declaration < delivery ≤ return; payments between declaration and today', async () => {
    const r = await one(`
      SELECT (SELECT count(*) FROM transactions t WHERE t.bl_number LIKE 'TESTBL%' AND t.cancelled_at IS NULL
                 AND ((t.operational_status = 'new' AND t.eta <= current_date)
                      OR (t.operational_status NOT IN ('new','in_progress') AND t.eta >= current_date))) bad_eta,
             (SELECT count(*) FROM customs_declarations d JOIN transactions t ON t.id = d.transaction_id
               WHERE d.declaration_no LIKE 'TSTD%' AND (d.declaration_date < t.eta OR d.declaration_date >= current_date)) bad_decl,
             (SELECT count(*) FROM transport_trips r JOIN customs_declarations d ON d.transaction_id = r.transaction_id
               WHERE d.declaration_no LIKE 'TSTD%' AND r.status = 'delivered' AND (r.unloaded_at::date <= d.declaration_date OR r.unloaded_at > now())) bad_dlv,
             (SELECT count(*) FROM transport_trips r JOIN transactions t ON t.id = r.transaction_id
               WHERE t.bl_number LIKE 'TESTBL%' AND r.status = 'delivered' AND r.unloaded_at::date < t.eta) dlv_before_eta,
             (SELECT count(*) FROM containers c JOIN transport_trips r ON r.container_id = c.id
               WHERE c.container_no LIKE 'TSTU%' AND r.status = 'delivered'
                 AND ((c.returned_at IS NOT NULL AND (c.returned_at < r.unloaded_at OR c.returned_at > now())) OR c.return_deadline <= r.unloaded_at::date)) bad_ret,
             (SELECT count(*) FROM client_disbursements x JOIN disbursement_allocations a ON a.disbursement_id = x.id
                JOIN customs_declarations d ON d.transaction_id = a.transaction_id
               WHERE x.notes LIKE 'TEST-SEED%' AND (x.paid_at < d.declaration_date OR x.paid_at > current_date)) bad_paid,
             (SELECT count(*) FROM transport_trips r JOIN transactions t ON t.id = r.transaction_id WHERE t.bl_number LIKE 'TESTBL%' AND r.status = 'delivered') dlv`);
    return (Number(r.dlv) > 10 && ['bad_eta','bad_decl','bad_dlv','dlv_before_eta','bad_ret','bad_paid'].every(k => Number(r[k]) === 0)) || J(r);
  });
  await check('stage-aging right after the seed: status_stale warning AND critical, a fresh share, declaration_stalled alerts; touch triggers back on', async () => {
    const r = await q(`SELECT reason, level, count(*) n FROM app.att_reasons('${ORG}', NULL, now()) GROUP BY 1, 2`);
    const has = (re, lv) => r.some(x => x.reason === re && x.level === lv && Number(x.n) > 0);
    const z = await one(`SELECT (SELECT count(*) FROM app.alert_causes('${ORG}', now()) WHERE kind = 'declaration_stalled') stalled,
                                (SELECT count(*) FROM transactions WHERE bl_number LIKE 'TESTBL%' AND updated_at > now() - interval '1 hour') fresh,
                                (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_touch' AND tgenabled = 'D'
                                   AND tgrelid IN ('public.transactions'::regclass, 'public.customs_declarations'::regclass)) off`);
    return (has('status_stale', 'warning') && has('status_stale', 'critical') && Number(z.stalled) > 0 && Number(z.fresh) > 0
      && Number(z.off) === 0) || J([r, z]);
  });
  await check('no payment (custody-funded or other) on a new transaction', async () => {
    const r = await one(`SELECT count(*) n FROM disbursement_allocations a JOIN transactions t ON t.id = a.transaction_id
                          WHERE t.bl_number LIKE 'TESTBL%' AND t.operational_status = 'new' AND t.cancelled_at IS NULL`);
    return Number(r.n) === 0 || J(r);
  });
  await check('no outbox / e-mail / billing / Daftra / job / charge / notification rows were created', async () => {
    const changed = [];
    for (const t of Object.keys(sideBefore)) {
      const n = Number((await one(`SELECT count(*) n FROM ${t}`)).n);
      if (n !== sideBefore[t]) changed.push(t + ' ' + sideBefore[t] + '→' + n);
    }
    return (Object.keys(sideBefore).length >= 20 && changed.length === 0) || ('changed: ' + changed.join(', ') + ' / tables ' + Object.keys(sideBefore).length);
  });
  await check('financial status untouched (no invoice), the non-test client / transaction unchanged', async () => {
    const r = await one(`SELECT count(*) FILTER (WHERE financial_status <> 'not_started') n FROM transactions WHERE bl_number LIKE 'TESTBL%'`);
    return (Number(r.n) === 0 && (await realSnapshot()) === beforeReal) || J(r);
  });
}

/* ------------------------------------------------------------------ 3. the screens' RPCs */
async function secScreens() {
  section('3. the screens answer (as the admin)');
  await check('report_transactions: the test rows are listed', async () => {
    const r = await rpc(`SELECT public.report_transactions($1, '{"limit": 100}'::jsonb) r`, [ORG]);
    return (Number(r.total) >= 60 && (r.items || r.rows || []).length > 0) || J(Object.keys(r)) + ' total ' + r.total;
  });
  await check('dash_tx_counts: every status tile has its count', async () => {
    const r = await rpc(`SELECT public.dash_tx_counts($1, '{}'::jsonb) r`, [ORG]);
    const by = r.by_status || {};
    return (['new','in_progress','customs_declaration','appointment','transport','empty_return','operationally_complete','under_billing','billed']
      .every(s => by[s] > 0) && r.cancelled === 1 && r.attention && r.attention.critical > 0) || J(r);
  });
  await check('tx_attention: critical + warning items', async () => {
    const r = await rpc(`SELECT public.tx_attention($1, '{}'::jsonb) r`, [ORG]);
    return (r.totals.critical > 0 && r.totals.warning > 0) || J(r.totals);
  });
  await check('custody_balances: 6 clients with TST- codes', async () => {
    const r = await rpc(`SELECT public.custody_balances($1, '{}'::jsonb) r`, [ORG]);
    const rows = r.rows || r.items || [];
    return (rows.length === 6 && rows.every(x => /^TST-/.test(x.client_code || ''))) || J(r).slice(0, 400);
  });
  await check('report_trips: rows with party types and the transport value', async () => {
    const r = await rpc(`SELECT public.report_trips($1, '{"limit": 200}'::jsonb) r`, [ORG]);
    const rows = r.rows || r.items || [];
    return (rows.length > 0 && new Set(rows.map(x => x.party_type || 'unset')).size === 4) || J(Object.keys(r)) + ' ' + rows.length;
  });
  await check('report_trips party_type unset filter answers', async () => {
    const r = await rpc(`SELECT public.report_trips($1, '{"party_type": "unset"}'::jsonb) r`, [ORG]);
    return (r.rows || r.items || []).length > 0 || J(r).slice(0, 300);
  });
  await check('list_payments (the payments register) + report_payments list the test entries', async () => {
    const a = await rpc(`SELECT public.list_payments($1, '{"limit": 200}'::jsonb) r`, [ORG]);
    const b = await rpc(`SELECT public.report_payments($1, '{}'::jsonb) r`, [ORG]);
    const ra = a.rows || a.items || [], rb = b.rows || b.items || [];
    return (ra.length >= 40 && rb.length > 0) || ('list ' + ra.length + ' report ' + rb.length + ' ' + J(Object.keys(a)));
  });
  await check('report_movements + list_custody_entries answer', async () => {
    const a = await rpc(`SELECT public.report_movements($1, '{}'::jsonb) r`, [ORG]);
    const b = await rpc(`SELECT public.list_custody_entries($1, '{}'::jsonb) r`, [ORG]);
    return ((a.items || []).length > 0 && (b.rows || b.items || []).length > 0) || J([Object.keys(a), Object.keys(b)]);
  });
}

/* ------------------------------------------------------------------ 4. second run */
async function secRerun() {
  section('4. a second seed run');
  await check('refused with a clear message, nothing changed', async () => {
    const c0 = J(await tableCounts());
    const e = await runFileErr(SEED);
    return (/test data already exists/.test(e || '') && J(await tableCounts()) === c0) || ('err: ' + e);
  });
}

/* ------------------------------------------------------------------ 5. cleanup refusals */
async function secRefusals() {
  section('5. cleanup refusals (nothing deleted)');
  await check('R1: a TESTBL B/L on a real client\'s transaction → refused', async () => {
    const c0 = J(await tableCounts());
    await db.exec('BEGIN');
    let e;
    try {
      await db.exec(`UPDATE public.transactions SET bl_number = 'TESTBL99999' WHERE id = '${REAL_TX}'`);
      e = await runFileErr(CLEAN);
    } finally { await db.exec('ROLLBACK'); }
    return (/refused \(R1\)/.test(e || '') && J(await tableCounts()) === c0) || ('err: ' + e);
  });
  await check('R2: a real transaction uses a test terminal operator → refused', async () => {
    const c0 = J(await tableCounts());
    await db.exec('BEGIN');
    let e;
    try {
      await db.exec(`UPDATE public.transactions SET terminal_party_id = (SELECT id FROM public.parties WHERE org_id = '${ORG}'
                       AND name_ar = '${PREFIX}محطة الحاويات الشمالية') WHERE id = '${REAL_TX}'`);
      e = await runFileErr(CLEAN);
    } finally { await db.exec('ROLLBACK'); }
    return (/refused \(R2\)/.test(e || '') && J(await tableCounts()) === c0) || ('err: ' + e);
  });
  // real rows in tables WITHOUT a transaction / client column that point to a test party: refused, nothing deleted
  const party = n => `(SELECT id FROM public.parties WHERE org_id = '${ORG}' AND name_ar = '${PREFIX}${n}')`;
  const refusedR2 = (name, setup, table) => check(name, async () => {
    const c0 = J(await tableCounts());
    await db.exec('BEGIN');
    let e, kept;
    try {
      await db.exec(setup);
      const n0 = J(await tableCounts());
      await db.exec('SAVEPOINT r2');
      e = await runFileErr(CLEAN);
      await db.exec('ROLLBACK TO SAVEPOINT r2');
      kept = J(await tableCounts()) === n0;
    } finally { await db.exec('ROLLBACK'); }
    return (new RegExp('refused \\(R2\\).*public\\.' + table + '\\b').test(e || '') && kept && J(await tableCounts()) === c0) || ('err: ' + e + ' kept ' + kept);
  });
  await refusedR2('R2: a real driver (no trips) of a test carrier → refused, names drivers.carrier_id',
    `INSERT INTO public.drivers (org_id, carrier_id, full_name, phone) VALUES ('${ORG}', ${party('شركة النقل السريع')}, 'سائق حقيقي', '0551112222')`, 'drivers');
  await refusedR2('R2: a real truck of a test carrier → refused',
    `INSERT INTO public.trucks (org_id, carrier_id, plate_no) VALUES ('${ORG}', ${party('شركة القوافل للنقل')}, 'REAL123')`, 'trucks');
  await refusedR2('R2: a real supplier invoice (no allocation) of a test supplier → refused',
    `INSERT INTO public.supplier_invoices (org_id, branch_id, supplier_id, invoice_number, number_norm, invoice_date)
     VALUES ('${ORG}', '${JED}', ${party('شركة الكهرباء (وهمية)')}, 'REAL-INV-1', 'REALINV1', current_date)`, 'supplier_invoices');
  await refusedR2('R2: a real unlinked B/L of a test shipping agent → refused',
    `INSERT INTO public.bills_of_lading (org_id, bl_number, shipping_agent_id) VALUES ('${ORG}', 'REALBL0007', ${party('وكيل الملاحة الأول')})`, 'bills_of_lading');
  await check('a real driver whose last truck is a test truck: cleanup runs, the driver is KEPT with the pointer cleared', async () => {
    await db.exec('BEGIN');
    let ok;
    try {
      await db.exec(`INSERT INTO public.drivers (org_id, full_name, phone, last_truck_id)
                     VALUES ('${ORG}', 'سائق حقيقي اثنان', '0551234567', (SELECT id FROM public.trucks WHERE org_id = '${ORG}' AND plate_no = 'TST1001'))`);
      const rows = await runFile(CLEAN);
      const d = await q(`SELECT full_name, last_truck_id FROM public.drivers WHERE org_id = '${ORG}'`);
      ok = (Object.values(rows[0]).every(v => Number(v) === 0) && d.length === 1 && d[0].full_name === 'سائق حقيقي اثنان' && d[0].last_truck_id === null) || J([rows, d]);
    } finally { await db.exec('ROLLBACK'); }
    return ok;
  });
  await check('R3: a billing row linked to a test transaction → refused; deleted too only when allowed explicitly', async () => {
    await db.exec('BEGIN');
    let e, ok;
    try {
      // a billing review item on a test transaction (stands for any message / billing / Daftra row)
      await db.exec(`INSERT INTO public.billing_review_items (org_id, transaction_id, kind)
                     SELECT t.org_id, t.id, 'issued_mismatch' FROM public.transactions t WHERE t.bl_number = 'TESTBL00001'`);
      await db.exec('SAVEPOINT r3');
      e = await runFileErr(CLEAN);
      await db.exec('ROLLBACK TO SAVEPOINT r3');
      await db.exec(`SELECT set_config('marsa.cleanup_allow_external', 'yes', true)`);
      const rows = await runFile(CLEAN);
      ok = Object.values(rows[0]).every(v => Number(v) === 0)
        && Number((await one(`SELECT count(*) n FROM public.billing_review_items`)).n) === 0;
    } catch (x) { e = 'setup: ' + errText(x); } finally { await db.exec('ROLLBACK'); }
    return (/refused \(R3\)/.test(e || '') && ok) || ('err: ' + e + ' ok ' + ok);
  });
}

/* ------------------------------------------------------------------ 6. cleanup */
async function secCleanup() {
  section('6. cleanup');
  let row;
  await check('cleanup runs; the proof row is all 0', async () => {
    const rows = await runFile(CLEAN);
    row = rows[0];
    return (rows.length === 1 && Object.values(row).every(v => Number(v) === 0)) || J(rows);
  });
  await check('the database is back to its pre-seed state (every public / app table\'s row count, audit trail, usage counter)', async () => {
    const after = await tableCounts();
    const diff = Object.keys(before).filter(t => before[t] !== after[t]).map(t => t + ' ' + before[t] + '→' + after[t]);
    return diff.length === 0 || diff.join(', ');
  });
  await check('the usage counters have exactly their pre-seed VALUES (not only their row count)', async () =>
    (await usageValues()) === beforeUsage || (await usageValues()));
  await check('triggers: the same enabled state as before (guards re-enabled)', async () => J(await triggerState()) === beforeTrg);
  await check('the non-test client / transaction / container / events and the other org\'s «تجريبي — » client are byte-identical', async () =>
    (await realSnapshot()) === beforeReal);
  await check('the guards work again: audit_log is append-only after the cleanup', async () => {
    try { await db.exec(`DELETE FROM public.audit_log WHERE id = (SELECT min(id) FROM public.audit_log)`); return 'delete allowed'; }
    catch (e) { return /APPEND_ONLY/.test(e.message) || e.message; }
  });
  await check('a second cleanup is a harmless no-op (all 0, nothing changed)', async () => {
    const c0 = J(await tableCounts());
    const rows = await runFile(CLEAN);
    return (Object.values(rows[0]).every(v => Number(v) === 0) && J(await tableCounts()) === c0) || J(rows);
  });
  for (const [name, setup] of [
    ['seed refused: a real driver already has a test mobile (another spelling, +966 …)', `INSERT INTO public.drivers (org_id, full_name, phone) VALUES ('${ORG}', 'سائق حقيقي', '+966500000102')`],
    ['seed refused: a real truck already has a TST… plate', `INSERT INTO public.trucks (org_id, plate_no) VALUES ('${ORG}', 'TST1003')`],
  ]) {
    await check(name + ' — nothing changed, the real row untouched', async () => {
      await db.exec('BEGIN');
      let e, n0, n1, row0, row1;
      try {
        await db.exec(setup);
        n0 = J(await tableCounts());
        row0 = J(await q(`SELECT to_jsonb(d) j FROM public.drivers d UNION ALL SELECT to_jsonb(k) FROM public.trucks k ORDER BY 1`));
        await db.exec('SAVEPOINT g');
        e = await runFileErr(SEED);
        await db.exec('ROLLBACK TO SAVEPOINT g');
        n1 = J(await tableCounts());
        row1 = J(await q(`SELECT to_jsonb(d) j FROM public.drivers d UNION ALL SELECT to_jsonb(k) FROM public.trucks k ORDER BY 1`));
      } finally { await db.exec('ROLLBACK'); }
      return (/test mobile .* TST… plate/.test(e || '') && n0 === n1 && row0 === row1) || ('err: ' + e);
    });
  }
  await check('the seed can run again after the cleanup', async () => {
    await db.exec('BEGIN');
    try { const rows = await runFile(SEED); return rows[0].clients === 20 || J(rows); } finally { await db.exec('ROLLBACK'); }
  });
}

/* ------------------------------------------------------------------ 7. production privileges */
// On Supabase the SQL editor runs as postgres, which is NOT a superuser but owns the tables and the SECURITY DEFINER
// functions. Re-created here: a NOSUPERUSER role that owns every public / app table / view / sequence / function, member
// of authenticated; seed + cleanup run under SET SESSION AUTHORIZATION, inside a transaction that is rolled back.
const NOSU_SETUP = `
  -- the cleanup's temp tables of the earlier runs in this session belong to the superuser (a fresh SQL-editor session has none)
  DROP TABLE IF EXISTS pg_temp._test_cleanup_root, pg_temp._test_cleanup_gone, pg_temp._test_cleanup_owned;
  CREATE ROLE marsa_owner_test NOSUPERUSER NOLOGIN NOBYPASSRLS;
  GRANT authenticated, anon TO marsa_owner_test;
  DO $nosu$ DECLARE r record; BEGIN
    -- the cleanup's temp tables need TEMPORARY on the database: the Supabase postgres role has it (PUBLIC keeps the
    -- default TEMP grant there), PGlite's template1 grants it to nobody
    EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO marsa_owner_test', current_database());
    FOR r IN SELECT n.nspname FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' LOOP
      EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO marsa_owner_test', r.nspname);
    END LOOP;
    FOR r IN SELECT c.oid::regclass AS t, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname IN ('public','app') AND c.relkind IN ('r','v','m','S','p')
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('e','a','i')) LOOP
      EXECUTE format('ALTER %s %s OWNER TO marsa_owner_test', CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
                     WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.t);
    END LOOP;
    FOR r IN SELECT p.oid::regprocedure AS f, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('public','app') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') LOOP
      EXECUTE format('ALTER %s %s OWNER TO marsa_owner_test', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, r.f);
    END LOOP;
    FOR r IN SELECT c.oid::regclass AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname NOT IN ('public','app','pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%' AND c.relkind = 'r' LOOP
      EXECUTE format('GRANT ALL ON TABLE %s TO marsa_owner_test', r.t);
    END LOOP;
  END $nosu$;`;
async function secNoSuper() {
  section('7. production privileges (a NOSUPERUSER owner)');
  await check('seed + cleanup as a NOSUPERUSER owner (ALTER TABLE … DISABLE TRIGGER, SET ROLE back, RLS): counts row, proof row all 0, database / usage / triggers unchanged', async () => {
    const c0 = J(await tableCounts()), u0 = await usageValues(), t0 = J(await triggerState());
    await db.exec('BEGIN');
    let res, step = 'setup';
    try {
      await db.exec(NOSU_SETUP);
      step = 'run';
      // the role must exist while the session is switched back: back to the savepoint, RESET, then roll everything back
      await db.exec('SAVEPOINT nosu');
      await db.exec('SET SESSION AUTHORIZATION marsa_owner_test');
      const who = await one(`SELECT current_user u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) su`);
      step = 'seed'; const s = (await runFile(SEED))[0];
      const mid = await one(`SELECT current_user u, coalesce(current_setting('request.jwt.claims', true), '') c,
                                    (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D') off`);
      step = 'cleanup'; const cl = (await runFile(CLEAN))[0];
      step = 'after'; const after = { counts: J(await tableCounts()), usage: await usageValues(), trg: J(await triggerState()) };
      res = (who.u === 'marsa_owner_test' && who.su === false && s.clients === 20 && s.transactions === seedRow.transactions
        && mid.u === 'marsa_owner_test' && mid.c === '' && Number(mid.off) === 0
        && Object.values(cl).every(v => Number(v) === 0) && after.counts === c0 && after.usage === u0 && after.trg === t0)
        || J({ who, s, mid, cl, counts: after.counts === c0, usage: after.usage === u0, trg: after.trg === t0 });
      step = 'done';
    } catch (x) { res = 'threw at ' + step + ': ' + errText(x); } finally {
      if (step !== 'setup') await db.exec('ROLLBACK TO SAVEPOINT nosu');
      await db.exec('RESET SESSION AUTHORIZATION');
      await db.exec('ROLLBACK');
    }
    const r = await one(`SELECT current_user u, (SELECT count(*) FROM pg_roles WHERE rolname = 'marsa_owner_test') n`);
    return (res === true && r.u === 'postgres' && Number(r.n) === 0 && J(await tableCounts()) === c0) || res || J(r);
  });
}

async function main() {
  await secFiles();
  section('load shim + migrations + fixtures');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await db.exec(FIXTURE);
  pass('database ready');
  await secSeed();
  await secScreens();
  await secRerun();
  await secRefusals();
  await secCleanup();
  await secNoSuper();
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
