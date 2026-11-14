#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 2 (transaction form + lifecycle + guards): migration 20261118000100_legacy_tx.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal).

  Covers: file conventions + all_migrations.sql + docs; preflight, apply on dirty appointment data (index skipped, NOTICE),
  re-run on itself (identical catalog), catalog delta; dictionaries; the duplicate transaction guard (B/L + container through
  containers and transactions, B/L key normalisation, the container's own B/L, cancelled / other org / no B/L exempt, Ro-Ro
  chassis, renumber, B/L change) and check_tx_duplicates (shape, branch masking, warning, permissions, payload errors); the
  automatic lifecycle (declaration added / released, Ro-Ro release, appointment, trip, container return, invoice → billed,
  forward only, owner SQL never auto-moves, the document gate, the return gate, manual gates unchanged, cancelled frozen) and
  tx_lifecycle; duplicate appointments (legacy rule with / without TAS number, minute, cancelled / missed free the slot,
  reschedule, unique index) ; save_movement (permissions, required fields, driver / truck find-or-create, legacy statuses,
  delivered rule, finance keys, reschedule, cancel, return plan, idempotent duplicate, idempotency key, Ro-Ro, cancelled
  transaction), list_movements, driver_directory, port_operators; public_track «ملغاة»; grants and function privileges;
  supa.js wrappers and i18n messages.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-tx-sql-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261118000100_legacy_tx.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in legacy-tx-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'deca0000-0000-4000-8000-0000000000b0';           // second org (fixture)
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const TX_JED = '0b5e0000-0000-4000-8000-000000000201';      // seed: JED, B/L TESTBL0000001, TSTU0000001 / TSTU0000002
const TX_DMM = '0b5e0000-0000-4000-8000-000000000202';      // seed: DMM, B/L TESTBL0000002, TSTU0000003
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const BR_B = 'deca0000-0000-4000-8000-0000000000b1';
const CL_B = 'deca0000-0000-4000-8000-0000000000b3';
const P = {
  topA: 'deca0000-0000-4000-8000-0000000000e1',   // terminal operator, org A, mapped to SAJED
  topA2: 'deca0000-0000-4000-8000-0000000000e2',  // terminal operator, org A, no port mapping
  topA3: 'deca0000-0000-4000-8000-0000000000e6',  // terminal operator, org A, mapped to SADMM only
  carA: 'deca0000-0000-4000-8000-0000000000e3',   // carrier, org A
  yardA: 'deca0000-0000-4000-8000-0000000000e4',  // yard, org A
  topB: 'deca0000-0000-4000-8000-0000000000e5'    // terminal operator, org B
};
const U = {
  admin: 'deca0000-0000-4000-8000-000000000001',    // admin of A
  acc: 'deca0000-0000-4000-8000-000000000002',      // accountant of A, org-wide
  opsm: 'deca0000-0000-4000-8000-000000000004',     // operations_manager of A, org-wide (trip finance)
  jed: 'deca0000-0000-4000-8000-000000000005',      // clearance_staff of A, JED only
  dmm: 'deca0000-0000-4000-8000-000000000006',      // clearance_staff of A, DMM only
  trn: 'deca0000-0000-4000-8000-000000000007',      // transport_staff of A, JED only (no trip finance)
  portal: 'deca0000-0000-4000-8000-000000000008',   // client user of CLIENT_A
  stranger: 'deca0000-0000-4000-8000-000000000009', // no membership
  staffB: 'deca0000-0000-4000-8000-00000000000a'    // admin of B
};

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn, aal) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else if (who === 'service') {
    await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[who], role: 'authenticated', aal: aal || 'aal2' })]);
    await db.exec(`SET ROLE authenticated;`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params, aal) => asRole(who, () => q(sql, params), aal);
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
async function tryErr(fn) { try { await fn(); return 'ok'; } catch (e) { return errText(e); } }
// 'ok' | 'MRS_X detail' | 'chk:<constraint>' | 'uniq:<constraint>' | 'fk:<constraint>' | 'perm' | 'rls' | other text
async function code(fn) {
  try { await fn(); return 'ok'; } catch (e) {
    const m = e.message || '';
    if (/^MRS_/.test(m)) return m + (e.detail ? ' ' + e.detail : '');
    let x = m.match(/violates check constraint "([^"]+)"/); if (x) return 'chk:' + x[1];
    x = m.match(/duplicate key value violates unique constraint "([^"]+)"/); if (x) return 'uniq:' + x[1];
    x = m.match(/violates foreign key constraint "([^"]+)"/); if (x) return 'fk:' + x[1];
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
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
let keySeq = 0;
const newKey = () => 'decaaaab-0000-4000-8000-' + String(++keySeq).padStart(12, '0');

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind = 'r' ORDER BY 1`)).map(x => x.t);
  const idx = (await q(`SELECT indexname || ':' || md5(indexdef) x FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('app','public') ORDER BY 1`)).map(x => x.x);
  const pol = (await q(`SELECT tablename || '.' || policyname x FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const con = (await q(`SELECT conrelid::regclass::text || '.' || conname || ':' || md5(pg_get_constraintdef(oid)) x FROM pg_constraint
                         WHERE connamespace = 'public'::regnamespace ORDER BY 1`)).map(x => x.x);
  const cols = (await q(`SELECT table_name || '.' || column_name x FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`)).map(x => x.x);
  const colgr = (await q(`SELECT table_name || '.' || column_name || ':' || privilege_type x FROM information_schema.column_privileges
                           WHERE table_schema = 'public' AND grantee = 'authenticated' ORDER BY 1`)).map(x => x.x);
  const labels = (await q(`SELECT domain || '.' || code || ':' || sort || ':' || label_ar || ':' || client_visible x FROM public.status_labels ORDER BY 1`)).map(x => x.x);
  return { fns, tables, idx, trg, pol, con, cols, colgr, labels };
}
const NEW_FNS = ['app.advance_tx_status', 'app.appt_duplicate', 'app.appt_minute', 'app.auto_lifecycle_on', 'app.container_bl_key',
  'app.movement_fleet', 'app.movement_json', 'app.movement_status', 'app.tg_appointments_legacy_dup', 'app.tg_appointments_legacy_tx',
  'app.tg_bills_of_lading_legacy_dup', 'app.tg_containers_legacy_dup', 'app.tg_containers_legacy_tx', 'app.tg_declarations_legacy_tx', 'app.tg_transactions_legacy_billed',
  'app.tg_transactions_legacy_dup', 'app.tg_trips_legacy_tx', 'app.tx_dup_conflicts', 'app.tx_dup_lock', 'public.check_tx_duplicates',
  'public.driver_directory', 'public.list_movements', 'public.port_operators', 'public.save_movement', 'public.tx_lifecycle'];
const RECREATED = ['public.public_track'];
const NEW_TRG = ['bills_of_lading.trg_legacy_tx_dup', 'containers.trg_legacy_tx_dup', 'containers.trg_legacy_tx_status', 'customs_declarations.trg_legacy_tx_status',
  'port_appointments.trg_legacy_dup', 'port_appointments.trg_legacy_tx_status', 'transactions.trg_legacy_tx_billed',
  'transactions.trg_legacy_tx_dup', 'transport_trips.trg_legacy_tx_status'];
const NEW_IDX = ['drivers_org_phone_idx', 'port_appointments_dup_uidx', 'transport_trips_appointment_uidx'];
const RPCS = ['check_tx_duplicates', 'driver_directory', 'list_movements', 'port_operators', 'save_movement', 'tx_lifecycle'];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@legacytx.example.com', now()), ('${U.acc}', 'acc@legacytx.example.com', now()),
    ('${U.opsm}', 'opsm@legacytx.example.com', now()), ('${U.jed}', 'jed@legacytx.example.com', now()),
    ('${U.dmm}', 'dmm@legacytx.example.com', now()), ('${U.trn}', 'trn@legacytx.example.com', now()),
    ('${U.portal}', 'portal@legacytx.example.com', now()), ('${U.stranger}', 'stranger@legacytx.example.com', now()),
    ('${U.staffB}', 'staffb@legacytx.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.acc}', 'acc'), ('${U.opsm}', 'opsm'), ('${U.jed}', 'jed'),
    ('${U.dmm}', 'dmm'), ('${U.trn}', 'trn'), ('${U.portal}', 'portal'), ('${U.stranger}', 'stranger'), ('${U.staffB}', 'staffB')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'legacytx-org-b', 'مؤسسة ب', 'Legacy tx org B', 'LTB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', '0509990000');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.acc}', '${A}', NULL, 'accountant'), ('${U.opsm}', '${A}', NULL, 'operations_manager'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff'),
    ('${U.trn}', '${A}', '${JED}', 'transport_staff'), ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
  INSERT INTO public.parties (id, org_id, kinds, name_ar) VALUES
    ('${P.topA}', '${A}', ARRAY['terminal_operator'], 'مشغل جدة'), ('${P.topA2}', '${A}', ARRAY['terminal_operator'], 'مشغل عام'),
    ('${P.topA3}', '${A}', ARRAY['terminal_operator'], 'مشغل الدمام'), ('${P.carA}', '${A}', ARRAY['carrier'], 'شركة نقل أ'),
    ('${P.yardA}', '${A}', ARRAY['yard'], 'ساحة أ'), ('${P.topB}', '${B}', ARRAY['terminal_operator'], 'مشغل ب');
  INSERT INTO public.party_ports (org_id, party_id, port_code) VALUES ('${A}', '${P.topA}', 'SAJED'), ('${A}', '${P.topA3}', 'SADMM');
`;
// a transaction created through the API (as PostgREST would), JED / CLIENT_A sea import unless overridden
async function mkTx(who, cols, branch) {
  const c = Object.assign({ org_id: A, branch_id: branch || JED, client_id: CLIENT_A, operation: 'import', mode: 'sea' }, cols || {});
  const k = Object.keys(c);
  return (await as(who || 'jed', `INSERT INTO public.transactions (${k.join(', ')}) VALUES (${k.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`,
    Object.values(c)))[0].id;
}
const addCtr = (who, tx, no, extra) => as(who || 'jed', `INSERT INTO public.containers (org_id, transaction_id, container_no${extra ? ', bl_id' : ''})
  VALUES ($1, $2, $3${extra ? ', $4' : ''}) RETURNING id`, [A, tx, no].concat(extra ? [extra] : [])).then(r => r[0].id);
const txRow = id => one(`SELECT * FROM public.transactions WHERE id = $1`, [id]);
const st = async id => (await txRow(id)).operational_status;
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
const dup = (who, p, org) => rpc(who, `SELECT public.check_tx_duplicates($1, $2) r`, [org || A, p]);
const addDecl = (who, tx, p) => rpc(who, `SELECT public.add_declaration($1, $2, $3) r`, [tx, p, newKey()]);
const declStatus = (who, id, s) => rpc(who, `SELECT public.set_declaration_status($1, $2) r`, [id, s]);
const mkAppt = (who, p) => rpc(who, `SELECT public.create_appointment($1, $2) r`, [p, newKey()]);
const mkTrip = (who, p) => rpc(who, `SELECT public.create_trip($1, $2) r`, [p, newKey()]);
const setStatus = (who, tx, s, note) => rpc(who, `SELECT public.set_transaction_status($1, $2, $3, $4) r`, [tx, s, note || null, newKey()]);
const lifecycle = (who, tx) => rpc(who, `SELECT public.tx_lifecycle($1) r`, [tx]);
const move = (who, p, key) => rpc(who, `SELECT public.save_movement($1, $2) r`, [p, key || null]);
const movements = (who, tx) => rpc(who, `SELECT public.list_movements($1) r`, [tx]);
// owner SQL carrying service_role claims (the G5 worker's financial_status write: app.bill_tx_financial is definer code)
async function asWorker(sql, params) {
  await db.exec(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  try { return await q(sql, params); } finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false)`); }
}
const autoEvents = tx => q(`SELECT from_status, to_status, payload, visible_to_client v FROM public.transaction_events
                             WHERE transaction_id = $1 AND event_type = 'operational_status' AND (payload ->> 'auto')::boolean ORDER BY id`, [tx]);
// a live declaration written by owner SQL (no JWT claims: no automatic move of its own)
const ownerDecl = (tx, no, status) => q(`INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no, status, source)
  VALUES ($1, $2, $3, $4, 'manual')`, [A, tx, no, status || 'submitted']);
const inHours = h => new Date(Date.now() + h * 3600000).toISOString();
const X = {};

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql, docs');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261117000100, schema_versions row, search_path = \'\' on every function', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261117000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261118000100', 'legacy_tx'\)/.test(src)
      && heads.length === NEW_FNS.length + RECREATED.length && bad.length === 0) || J({ n: heads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('SECURITY DEFINER exactly where intended (not on the pure helpers / app.tx_dup_lock / app.auto_lifecycle_on / app.movement_status); refusals through app.fail(\'MRS_*\')', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const name = h => (h.match(/FUNCTION ([a-z0-9_.]+)\(/) || [])[1];
    const definer = heads.filter(h => /SECURITY DEFINER/.test(h)).map(name).sort();
    const want = NEW_FNS.concat(RECREATED).filter(f => !['app.appt_minute', 'app.auto_lifecycle_on', 'app.movement_status', 'app.tx_dup_lock'].includes(f)).sort();
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|LEGACY TX preflight/.test(r));
    const codes = src.match(/app\.fail\('([A-Z_]+)'/g) || [];
    return (J(definer) === J(want) && raises.length === 0 && codes.length >= 50 && codes.every(c => /app\.fail\('MRS_[A-Z_]+'/.test(c))) || J({ definer, raises: raises.length, codes: codes.length });
  });
  await check('every MRS code used has an Arabic message in supa.js and Arabic + English in i18n.js; new codes are exactly MRS_DUPLICATE_TX / MRS_DUPLICATE_APPOINTMENT', () => {
    const used = [...new Set((src.match(/app\.fail\('(MRS_[A-Z_]+)'/g) || []).map(x => x.slice(10, -1)))].sort();
    const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
    const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
    const missing = used.filter(c => !new RegExp('\\b' + c + ':').test(supa) || (i18n.match(new RegExp('\\n\\s+' + c + ': ', 'g')) || []).length < 2);
    const details = ['cdetail_MRS_DUPLICATE_TX_container', 'cdetail_MRS_DUPLICATE_TX_chassis'].every(k => (i18n.match(new RegExp(k + ':', 'g')) || []).length === 2)
      && /'MRS_DUPLICATE_TX:container'/.test(supa) && /'MRS_DUPLICATE_TX:chassis'/.test(supa);
    return (missing.length === 0 && details && used.includes('MRS_DUPLICATE_TX') && used.includes('MRS_DUPLICATE_APPOINTMENT')) || 'missing: ' + missing.join(', ') + ' details ' + details;
  });
  await check('no TRUNCATE / DROP TABLE / DROP FUNCTION / DISABLE TRIGGER / session_replication_role / DELETE; no key or endpoint', () => {
    const c = src.replace(/--.*$/gm, '');
    return (!/\bTRUNCATE\b/i.test(c) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA)/i.test(c) && !/DISABLE TRIGGER/i.test(c) && !/session_replication_role/.test(c)
      && !/\bDELETE\s+FROM\b/i.test(c) && !/sk-ant|api\.anthropic\.com|https?:\/\//i.test(src)) || 'body';
  });
  await check('no personal data / legacy organization name copied from the legacy code (no e-mail, phone number, real org name)', () =>
    (!/@[a-z0-9-]+\.[a-z]/i.test(src.replace(/--.*$/gm, '')) && !/\b05[0-9]{8}\b/.test(src) && !/رأس الحكمة/.test(src)) || 'personal data');
  // later phases may follow this file (20261119000100 legacy_docs)
  const LATER_PHASES = ['20261119000100_legacy_docs.sql', '20261120000100_legacy_decl.sql', '20261121000100_legacy_appt.sql', '20261122000100_legacy_pay.sql', '20261123000100_legacy_daftra.sql', '20261124000100_legacy_reports.sql', '20261125000100_legacy_import.sql', '20261126000100_doc_match_packing.sql', '20261127000100_tx_draft_approval.sql'];
  await check('this file is the latest migration (or only listed later phases follow it)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (followed only by the listed later phases, in order) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    const after = next < 0 ? [] : (all.slice(next).match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && after.every(f => LATER_PHASES.includes(f)) && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 9000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
  await check('docs/online/LEGACY_TX_AR.md exists and names the migration, the RPCs, the two error codes and the owner decisions', () => {
    const p = path.join(ROOT, 'docs', 'online', 'LEGACY_TX_AR.md');
    if (!fs.existsSync(p)) return 'missing';
    const d = fs.readFileSync(p, 'utf8');
    const miss = [MIG, 'MRS_DUPLICATE_TX', 'MRS_DUPLICATE_APPOINTMENT', 'advance_tx_status', 'إثبات'].concat(RPCS).filter(x => !d.includes(x));
    return miss.length === 0 || 'missing: ' + miss.join(', ');
  });
}

/* ================================================================== 2. preflight, re-run, catalog */
async function secPreflight() {
  section('2. preflight, dirty data, re-run, catalog delta (separate database, no seed)');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const d = await freshDb(MIG);
  try {
    await withDb(d, async () => {
      const C0 = await catalog();
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261117000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without legacy_core: exact preflight message, nothing created', async () =>
        (msg.startsWith('LEGACY TX preflight: apply legacy_core first (schema_versions lacks 20261117000100 legacy_core)')
          && (await one(`SELECT to_regprocedure('public.save_movement(jsonb,uuid)') IS NULL x`)).x && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261117000100', 'legacy_core')`);
      // existing data: two live duplicate appointments (same tx / container / minute / number) and a pre-existing duplicate transaction
      await db.exec(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${B}', 'pre-org', 'مؤسسة سابقة', 'PRE');
                     INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع');
                     INSERT INTO public.clients (id, org_id, client_type, name_ar) VALUES ('${CL_B}', '${B}', 'business', 'عميل');
                     INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, bl_number)
                       VALUES ('deca0000-0000-4000-8000-0000000000c1', '${B}', '${BR_B}', '${CL_B}', 'import', 'sea', 'PREBL1'),
                              ('deca0000-0000-4000-8000-0000000000c2', '${B}', '${BR_B}', '${CL_B}', 'import', 'sea', 'PREBL1');
                     INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES
                       ('${B}', 'deca0000-0000-4000-8000-0000000000c1', 'PREU0000001'), ('${B}', 'deca0000-0000-4000-8000-0000000000c2', 'PREU0000001');
                     INSERT INTO public.port_appointments (id, org_id, transaction_id, appointment_at, appointment_no) VALUES
                       ('deca0000-0000-4000-8000-0000000000d1', '${B}', 'deca0000-0000-4000-8000-0000000000c1', '2026-12-01 08:00+00', 'TAS12345678'),
                       ('deca0000-0000-4000-8000-0000000000d2', '${B}', 'deca0000-0000-4000-8000-0000000000c1', '2026-12-01 08:00:30+00', 'TAS12345678');`);
      const r1b = await tryErr(() => db.exec(src));
      await check('dirty data: the file applies, keeps the existing rows (no data change) and skips only port_appointments_dup_uidx', async () => {
        const idx = (await one(`SELECT to_regclass('public.port_appointments_dup_uidx') IS NULL x`)).x;
        const nA = await num(`SELECT count(*) n FROM public.port_appointments WHERE status = 'requested'`);
        const nC = await num(`SELECT count(*) n FROM public.containers WHERE container_no = 'PREU0000001'`);
        return (r1b === 'ok' && idx && nA === 2 && nC === 2) || J({ r1b, idx, nA, nC });
      });
      await check('dirty data: the pre-existing duplicate transaction stays writable for unrelated columns (the guard checks only B/L / unit changes)', async () =>
        (await code(() => db.query(`UPDATE public.transactions SET goods_description = 'x' WHERE id = 'deca0000-0000-4000-8000-0000000000c2'`))) === 'ok');
      await db.exec(`UPDATE public.port_appointments SET status = 'cancelled', status_reason = 'مكرر' WHERE id = 'deca0000-0000-4000-8000-0000000000d2'`);
      const r2 = await tryErr(() => db.exec(src));
      await check('after the duplicate is cancelled, a re-run creates port_appointments_dup_uidx', async () =>
        (r2 === 'ok' && !(await one(`SELECT to_regclass('public.port_appointments_dup_uidx') IS NULL x`)).x) || r2);
      const C1 = await catalog();
      const audit1 = await num(`SELECT count(*) n FROM public.audit_log`);
      const ev1 = await num(`SELECT count(*) n FROM public.transaction_events`);
      const r3 = await tryErr(() => db.exec(src));
      await check('re-runs on top of itself with an identical catalog (functions, ACLs, indexes, triggers, constraints, columns, column grants, labels); no data', async () =>
        (r3 === 'ok' && J(C1) === J(await catalog()) && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261118000100'`)) === 1
          && (await num(`SELECT count(*) n FROM public.audit_log`)) === audit1 && (await num(`SELECT count(*) n FROM public.transaction_events`)) === ev1) || r3);
      const s0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the new functions; only public_track re-created (ACL / definer / config kept)', () => {
        const nm = s => s.split('(')[0];
        const added = C1.fns.filter(f => !s0.has(f.sig)).map(f => nm(f.sig)).sort();
        const changed = C1.fns.filter(f => s0.has(f.sig) && J(s0.get(f.sig)) !== J(f)).map(f => nm(f.sig)).sort();
        const pt = C1.fns.find(f => nm(f.sig) === 'public.public_track'); const pt0 = s0.get(pt.sig);
        return (J(added) === J(NEW_FNS.slice().sort()) && J(changed) === J(RECREATED) && pt.acl === pt0.acl && pt.d === pt0.d && pt.c === pt0.c)
          || J({ added, changed });
      });
      await check('catalog: no new table or policy; the 9 new triggers; 3 new indexes; + transport_trips.appointment_id, drivers.last_truck_id', () => {
        const t = C1.tables.filter(x => !C0.tables.includes(x)), p = C1.pol.filter(x => !C0.pol.includes(x));
        const tr = C1.trg.filter(x => !C0.trg.includes(x)), gone = C0.trg.filter(x => !C1.trg.includes(x));
        const ix = C1.idx.filter(x => !C0.idx.includes(x)).map(x => x.split(':')[0]).sort();
        const cols = C1.cols.filter(x => !C0.cols.includes(x));
        return (t.length === 0 && p.length === 0 && J(tr) === J(NEW_TRG.slice().sort()) && gone.length === 0 && J(ix) === J(NEW_IDX)
          && J(cols) === J(['drivers.last_truck_id', 'transport_trips.appointment_id'])) || J({ t, p, tr, gone, ix, cols });
      });
      await check('catalog: + 5 labels (movement_status ×4 staff-only, transaction_state.cancelled client-visible)', () => {
        const l = C1.labels.filter(x => !C0.labels.includes(x));
        return (l.length === 5 && l.some(x => x.startsWith('transaction_state.cancelled:1:ملغاة:true'))
          && l.filter(x => x.startsWith('movement_status.')).every(x => x.endsWith(':false'))) || J(l);
      });
      await check('column grants: transport_trips.appointment_id selectable; cost / sell still hidden', () =>
        (C1.colgr.includes('transport_trips.appointment_id:SELECT') && !C1.colgr.some(x => /^transport_trips\.(cost_amount|sell_amount|cost_basis):/.test(x))) || 'grants');
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. dictionaries */
async function secLabels() {
  section('3. dictionaries');
  await check('movement_status labels = the legacy movement statuses', async () => {
    const r = await q(`SELECT code, label_ar FROM public.status_labels WHERE domain = 'movement_status' ORDER BY sort`);
    return J(r.map(x => x.code)) === J(['registered', 'incomplete', 'delivered', 'cancelled'])
      && r[1].label_ar === 'موعد مسجل — بيانات النقل ناقصة' && r[2].label_ar === 'تم النقل' && r[3].label_ar === 'ملغى' || J(r);
  });
  await check('transaction_state.cancelled = «ملغاة», readable by a client user and by anon (status_labels policy)', async () => {
    const a = await as('portal', `SELECT label_ar, label_en FROM public.status_labels WHERE domain = 'transaction_state' AND code = 'cancelled'`);
    const b = await as('anon', `SELECT label_ar FROM public.status_labels WHERE domain = 'transaction_state' AND code = 'cancelled'`);
    return (a.length === 1 && a[0].label_ar === 'ملغاة' && a[0].label_en === 'Cancelled' && b.length === 1) || J({ a, b });
  });
}

/* ================================================================== 4. duplicate transaction guard */
async function secDuplicates() {
  section('4. duplicate transaction guard (legacy assertNoDuplicateTransaction_)');
  await check('the seed has no auto-move (owner SQL): TX_JED kept its seed trail', async () =>
    (await autoEvents(TX_JED)).length === 0 && (await st(TX_JED)) === 'customs_declaration');
  X.d1 = await mkTx('jed', { bl_number: 'DUPBL-001' });
  await check('a first transaction with a B/L and a container is accepted', async () => (await code(() => addCtr('jed', X.d1, 'DUPU0000001'))) === 'ok');
  X.d2 = await mkTx('jed', { bl_number: 'dupbl 001' });
  await check('same B/L (other spelling: lower case, space instead of -) + same container on a second transaction → MRS_DUPLICATE_TX container', async () =>
    (await code(() => addCtr('jed', X.d2, 'dupu 0000001'))) === 'MRS_DUPLICATE_TX container');
  await check('same B/L + another container → accepted (only the same unit is a duplicate)', async () => (await code(() => addCtr('jed', X.d2, 'DUPU0000002'))) === 'ok');
  await check('renumbering a container onto the twin number → MRS_DUPLICATE_TX container', async () =>
    (await code(() => as('jed', `UPDATE public.containers SET container_no = 'DUPU0000001' WHERE transaction_id = $1`, [X.d2]))) === 'MRS_DUPLICATE_TX container');
  X.d3 = await mkTx('jed', { bl_number: 'OTHERBL-9' });
  await check('another B/L + the same container → accepted (DEC-02: a container repeats across transactions)', async () =>
    (await code(() => addCtr('jed', X.d3, 'DUPU0000001'))) === 'ok');
  await check('changing a transaction\'s B/L onto the twin B/L (its container follows the transaction B/L) → MRS_DUPLICATE_TX container', async () =>
    (await code(() => as('jed', `UPDATE public.transactions SET bl_number = 'DUPBL001' WHERE id = $1`, [X.d3]))) === 'MRS_DUPLICATE_TX container');
  X.d4 = await mkTx('jed', {});
  await check('no B/L → no duplicate check (same container accepted)', async () => (await code(() => addCtr('jed', X.d4, 'DUPU0000001'))) === 'ok');
  await check('a container with its own B/L (bl_id) is compared under that B/L, not the transaction\'s primary', async () => {
    const t = await mkTx('jed', { bl_number: 'DUPBL-001' }).catch(e => errText(e));
    return /MRS_DUPLICATE_TX/.test(t) ? 'creating a tx with the B/L alone must pass' : true;
  });
  await check('the DMM branch (same org) is checked too: DMM transaction with the same B/L + container → MRS_DUPLICATE_TX', async () => {
    const t = await mkTx('dmm', { bl_number: 'DUPBL-001' }, DMM);
    return (await code(() => addCtr('dmm', t, 'DUPU0000001'))) === 'MRS_DUPLICATE_TX container';
  });
  await check('org B: same B/L + container is another org → accepted', async () => {
    const t = (await as('staffB', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, bl_number)
                                   VALUES ($1, $2, $3, 'import', 'sea', 'DUPBL-001') RETURNING id`, [B, BR_B, CL_B]))[0].id;
    return (await code(() => as('staffB', `INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, 'DUPU0000001')`, [B, t]))) === 'ok';
  });
  await check('a cancelled transaction does not count: after cancel_transaction the same B/L + container is accepted', async () => {
    const t = await mkTx('jed', { bl_number: 'CXLBL-1' });
    await addCtr('jed', t, 'CXLU0000001');
    const t2 = await mkTx('jed', { bl_number: 'CXLBL-1' });
    const before = await code(() => addCtr('jed', t2, 'CXLU0000001'));
    await as('jed', `SELECT public.cancel_transaction($1, 'مكررة')`, [t]);
    const after = await code(() => addCtr('jed', t2, 'CXLU0000001'));
    X.cancelledTx = t;
    return (before === 'MRS_DUPLICATE_TX container' && after === 'ok') || J({ before, after });
  });
  // Ro-Ro: same B/L + chassis
  X.r1 = await mkTx('jed', { bl_number: 'RORO-BL-1', cargo_unit_type: 'roro', chassis_no: 'jt-123 456' });
  await check('Ro-Ro: same B/L + same chassis (another spelling) → MRS_DUPLICATE_TX chassis (insert)', async () =>
    (await code(() => mkTx('jed', { bl_number: 'roro bl 1', cargo_unit_type: 'roro', chassis_no: 'JT123456' }))) === 'MRS_DUPLICATE_TX chassis');
  await check('Ro-Ro: same B/L + another chassis → accepted; changing it onto the twin chassis → MRS_DUPLICATE_TX chassis', async () => {
    const t = await mkTx('jed', { bl_number: 'RORO-BL-1', cargo_unit_type: 'roro', chassis_no: 'JT999999' });
    X.r2 = t;
    return (await code(() => as('jed', `UPDATE public.transactions SET chassis_no = 'JT123456' WHERE id = $1`, [t]))) === 'MRS_DUPLICATE_TX chassis';
  });
  await check('Ro-Ro: another B/L + the same chassis → accepted', async () =>
    (await code(() => mkTx('jed', { bl_number: 'RORO-BL-2', cargo_unit_type: 'roro', chassis_no: 'JT123456' }))) === 'ok');
  await check('a container transaction with the same B/L as a Ro-Ro one is not a chassis twin', async () =>
    (await code(() => mkTx('jed', { bl_number: 'RORO-BL-1' }))) === 'ok');
  await check('updating an unrelated column of a transaction never runs the guard', async () =>
    (await code(() => as('jed', `UPDATE public.transactions SET goods_description = 'قطع' WHERE id = $1`, [X.d2]))) === 'ok');

  section('4b. check_tx_duplicates (form pre-check)');
  await check('shape: the duplicate with ref (readable), the open container elsewhere as a warning', async () => {
    const r = await dup('jed', { bl_number: 'DUPBL-001', containers: ['dupu-0000001', 'NEWU0000001'] });
    const d = r.duplicates;
    const t1 = await txRow(X.d1);
    const w = r.container_elsewhere.map(x => x.ref);
    return (d.length >= 1 && d.some(x => x.kind === 'container' && x.unit === 'DUPU0000001' && x.ref === t1.ref && x.other_branch === false && x.branch_id === JED)
      && w.includes(t1.ref) && w.includes((await txRow(X.d3)).ref)) || J(r);
  });
  await check('a twin in a branch the caller cannot read: listed with other_branch, no id / ref / branch', async () => {
    const r = await dup('dmm', { bl_number: 'DUPBL-001', containers: ['DUPU0000001'] });
    const hidden = r.duplicates.filter(x => x.other_branch);
    return (hidden.length >= 1 && hidden.every(x => x.transaction_id === null && x.ref === null && x.branch_id === null)
      && r.container_elsewhere.every(x => x.ref !== (null))) || J(r);
  });
  await check('transaction_id excludes the transaction itself; no B/L → no duplicates', async () => {
    const a = await dup('jed', { transaction_id: X.d1, bl_number: 'DUPBL-001', containers: ['DUPU0000001'] });
    const b = await dup('jed', { bl_number: null, containers: ['DUPU0000001'] });
    return (!a.duplicates.some(x => x.transaction_id === X.d1) && b.duplicates.length === 0 && b.container_elsewhere.length >= 1) || J({ a, b });
  });
  await check('Ro-Ro pre-check: chassis twin listed; no container warnings', async () => {
    const r = await dup('jed', { bl_number: 'RORO-BL-1', cargo_unit_type: 'roro', chassis_no: 'jt 123456', containers: ['DUPU0000001'] });
    return (r.duplicates.length === 1 && r.duplicates[0].kind === 'chassis' && r.duplicates[0].unit === 'JT123456' && r.container_elsewhere.length === 0) || J(r);
  });
  await check('a cancelled transaction is neither a duplicate nor a warning', async () => {
    const r = await dup('jed', { bl_number: 'CXLBL-1', containers: ['CXLU0000001'] });
    const c = (await txRow(X.cancelledTx)).ref;
    return (!r.duplicates.some(x => x.ref === c) && !r.container_elsewhere.some(x => x.ref === c)) || J(r);
  });
  for (const [label, who, org, p, want] of [
    ['stranger → MRS_FORBIDDEN', 'stranger', A, { bl_number: 'X' }, 'MRS_FORBIDDEN'],
    ['client user → MRS_FORBIDDEN', 'portal', A, { bl_number: 'X' }, 'MRS_FORBIDDEN'],
    ['org B admin on org A → MRS_FORBIDDEN', 'staffB', A, { bl_number: 'X' }, 'MRS_FORBIDDEN'],
    ['unknown key → MRS_INVALID unknown_key', 'jed', A, { bl: 'X' }, 'MRS_INVALID unknown_key'],
    ['bad cargo type → MRS_INVALID cargo_unit_type', 'jed', A, { bl_number: 'X', cargo_unit_type: 'truck' }, 'MRS_INVALID cargo_unit_type'],
    ['containers not an array → MRS_INVALID containers', 'jed', A, { bl_number: 'X', containers: 'ABCU1234567' }, 'MRS_INVALID containers'],
    ['a transaction of another branch → MRS_NOT_FOUND transaction', 'dmm', A, { transaction_id: X.d1, bl_number: 'X' }, 'MRS_NOT_FOUND transaction']]) {
    await check('check_tx_duplicates: ' + label, async () => { const r = await code(() => dup(who, p, org)); return r === want || r; });
  }
  await check('check_tx_duplicates: anon cannot execute it', async () => (await code(() => dup('anon', { bl_number: 'X' }))) === 'perm');
}

/* ================================================================== 5. lifecycle */
async function secLifecycle() {
  section('5. automatic lifecycle (forward only, gates kept)');
  X.l1 = await mkTx('jed', { bl_number: 'LIFE-1', container_count: 1 });
  X.l1c = await addCtr('jed', X.l1, 'LIFU0000001');
  await check('declaration added (add_declaration) → customs_declaration, one client-visible auto event (cause declaration, actor = the user)', async () => {
    X.l1d = (await addDecl('jed', X.l1, { declaration_no: 'LIFE-DEC-1' })).id;
    const e = await autoEvents(X.l1);
    const a = await one(`SELECT actor FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'operational_status' ORDER BY id DESC LIMIT 1`, [X.l1]);
    return ((await st(X.l1)) === 'customs_declaration' && e.length === 1 && e[0].from_status === 'new' && e[0].v === true
      && e[0].payload.cause === 'declaration' && e[0].payload.direction === 'forward' && a.actor === U.jed) || J(e);
  });
  await check('declaration released → appointment (container transaction: customs done, the appointment is next)', async () => {
    await declStatus('jed', X.l1d, 'released');
    const e = await autoEvents(X.l1);
    return ((await st(X.l1)) === 'appointment' && e[e.length - 1].payload.cause === 'declaration_released') || J(e);
  });
  await check('a second release / declaration never moves backwards (appointment kept after a new declaration)', async () => {
    await addDecl('jed', X.l1, { declaration_no: 'LIFE-DEC-2' });
    return (await st(X.l1)) === 'appointment';
  });
  await check('trip created (create_trip) → transport (cause trip)', async () => {
    await mkTrip('jed', { transaction_id: X.l1, container_id: X.l1c });
    return (await st(X.l1)) === 'transport' && (await autoEvents(X.l1)).pop().payload.cause === 'trip';
  });
  await check('container return recorded (waiver by a senior role) → empty_return, never operationally_complete (manual step)', async () => {
    await as('opsm', `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'استثناء اختبار' WHERE id = $1`, [X.l1c]);
    return ((await st(X.l1)) === 'empty_return' && (await autoEvents(X.l1)).pop().payload.cause === 'container_return') || await st(X.l1);
  });
  await check('manual operationally_complete still works (gate passes: every container waived)', async () =>
    (await setStatus('jed', X.l1, 'operationally_complete')).to === 'operationally_complete');
  await check('nothing auto-moves into under_billing; financial invoiced while operationally_complete → no billed', async () => {
    await asWorker(`UPDATE public.transactions SET financial_status = 'invoiced' WHERE id = $1`, [X.l1]);
    return (await st(X.l1)) === 'operationally_complete';
  });
  await check('invoice issued while under_billing → billed (cause invoiced; the G5 worker as service_role)', async () => {
    const t = await mkTx('jed', {});
    await q(`UPDATE public.transactions SET operational_status = 'under_billing' WHERE id = $1`, [t]);
    await asWorker(`UPDATE public.transactions SET financial_status = 'invoiced' WHERE id = $1`, [t]);
    const e = await autoEvents(t);
    return ((await st(t)) === 'billed' && e.length === 1 && e[0].from_status === 'under_billing' && e[0].payload.cause === 'invoiced') || J(e);
  });
  await check('a return recorded before the transport stage does not move the transaction', async () => {
    const t = await mkTx('jed', { bl_number: 'LIFE-EARLY' });
    const c = await addCtr('jed', t, 'LIFU0000009');
    await as('opsm', `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'استثناء' WHERE id = $1`, [c]);
    return (await st(t)) === 'new';
  });
  await check('appointment created on a new transaction WITHOUT a declaration → stays new (no automatic jump over customs, no event)', async () => {
    const t = await mkTx('jed', {});
    const c = await addCtr('jed', t, 'LIFU0000012');
    await mkAppt('jed', { transaction_id: t, container_id: c, appointment_at: inHours(24) });
    await mkTrip('jed', { transaction_id: t, container_id: c });
    return ((await st(t)) === 'new' && (await autoEvents(t)).length === 0) || await st(t);
  });
  await check('review: transport staff cannot skip customs through save_movement (new, no declaration → stays new; set_transaction_status still refuses the jump)', async () => {
    const t = await mkTx('jed', { bl_number: 'SKIP-1' });
    const c = await addCtr('jed', t, 'SKPU0000001');
    const manual = await code(() => setStatus('trn', t, 'transport', 'x'));
    const r = await move('trn', { transaction_id: t, container_id: c, appointment_at: inHours(30), driver_name: 'سائق تخطي', driver_phone: '0551230001', truck_plate: 'SKP1' });
    return (manual.startsWith('MRS_') && r.lifecycle_status === 'new' && (await st(t)) === 'new' && (await autoEvents(t)).length === 0) || J({ manual, r: r.lifecycle_status });
  });
  await check('appointment created on a new transaction that has a declaration → appointment (forward only)', async () => {
    const t = await mkTx('jed', {});
    const c = await addCtr('jed', t, 'LIFU0000002');
    await ownerDecl(t, 'LIFE-DEC-L2');
    await mkAppt('jed', { transaction_id: t, container_id: c, appointment_at: inHours(24) });
    X.l2 = t;
    return (await st(t)) === 'appointment';
  });
  await check('Ro-Ro: declaration released → operationally_complete (no appointment / empty return)', async () => {
    const t = await mkTx('jed', { bl_number: 'RORO-LIFE', cargo_unit_type: 'roro', chassis_no: 'VIN0001' });
    const d = (await addDecl('jed', t, { declaration_no: 'RORO-DEC-1' })).id;
    await declStatus('jed', d, 'released');
    X.ro = t;
    const e = await autoEvents(t);
    return ((await st(t)) === 'operationally_complete' && e.map(x => x.to_status).join(',') === 'customs_declaration,operationally_complete') || J(e);
  });
  await check('owner SQL (no JWT claims: SQL Editor / seed / import) never auto-moves', async () => {
    const t = await mkTx('jed', {});
    await q(`INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no, status, source) VALUES ($1, $2, 'OWNER-DEC-1', 'released', 'manual')`, [A, t]);
    await q(`INSERT INTO public.transport_trips (org_id, transaction_id) VALUES ($1, $2)`, [A, t]);
    return (await st(t)) === 'new' && (await autoEvents(t)).length === 0;
  });
  await check('the G3.10 document gate: a mandatory document for appointment stops the release move at customs_declaration', async () => {
    const r = (await one(`INSERT INTO public.document_requirements (org_id, document_kind, required_for_stage) VALUES ($1, 'delivery_order', 'appointment') RETURNING id`, [A])).id;
    try {
      const t = await mkTx('jed', {});
      const d = (await addDecl('jed', t, { declaration_no: 'GATE-DEC-1' })).id;
      await declStatus('jed', d, 'released');
      const s1 = await st(t);
      const lc = await lifecycle('jed', t);
      return (s1 === 'customs_declaration' && lc.next.code === 'appointment' && J(lc.next.docs_missing) === '["delivery_order"]') || J({ s1, lc: lc.next });
    } finally { await q(`UPDATE public.document_requirements SET is_active = false WHERE id = $1`, [r]); }
  });
  await check('the manual gates are unchanged: set_transaction_status to operationally_complete with a container not returned → MRS_CONTAINERS_NOT_RETURNED', async () =>
    (await code(() => setStatus('jed', X.l2, 'operationally_complete', 'تخطي'))).startsWith('MRS_'));
  await check('declared-but-unregistered containers: app.advance_tx_status stops at empty_return (owner call)', async () => {
    const t = await mkTx('jed', { container_count: 2 });
    await q(`UPDATE public.transactions SET operational_status = 'transport' WHERE id = $1`, [t]);
    const r = (await one(`SELECT app.advance_tx_status($1, 'operationally_complete', 'test') s`, [t])).s;
    return (r === 'empty_return' && (await st(t)) === 'empty_return') || r;
  });
  await check('app.advance_tx_status refuses under_billing / closed / new targets and backward moves (status kept, no event)', async () => {
    const t = await mkTx('jed', {});
    await q(`UPDATE public.transactions SET operational_status = 'transport' WHERE id = $1`, [t]);
    const r = [];
    for (const s of ['under_billing', 'closed', 'new', 'customs_declaration', 'billed', 'nope']) r.push((await one(`SELECT app.advance_tx_status($1, $2, 'test') s`, [t, s])).s);
    return (r.every(x => x === 'transport') && (await autoEvents(t)).length === 0) || J(r);
  });
  await check('a cancelled transaction never moves (advance returns closed)', async () =>
    (await one(`SELECT app.advance_tx_status($1, 'transport', 'test') s`, [X.cancelledTx])).s === 'closed');
  await check('app.advance_tx_status is not executable by authenticated / service_role', async () =>
    (await code(() => as('admin', `SELECT app.advance_tx_status($1, 'transport', 'x')`, [X.l2]))) === 'perm'
    && (await code(() => as('service', `SELECT app.advance_tx_status($1, 'transport', 'x')`, [X.l2]))) === 'perm');

  section('5b. tx_lifecycle (stepper)');
  await check('shape: 10 stages done / current / todo with reached_at + auto + cause; next + blockers; pending containers', async () => {
    const r = await lifecycle('jed', X.l2);
    const s = r.stages;
    const cur = s.find(x => x.state === 'current');
    return (s.length === 10 && cur.code === 'appointment' && cur.auto === true && cur.cause === 'appointment' && cur.reached_at
      && s.find(x => x.code === 'new').state === 'done' && s.find(x => x.code === 'transport').state === 'todo'
      && r.next.code === 'transport' && r.next.manual === false && r.next.containers_not_returned === 0
      && J(r.pending_containers) === '["LIFU0000002"]' && r.follow_up_required === false && r.cancelled === false && r.cargo_unit_type === 'container') || J(r);
  });
  await check('cancelled transaction: cancelled = true, next = null', async () => {
    const r = await lifecycle('jed', X.cancelledTx);
    return (r.cancelled === true && r.cancelled_at && r.next === null && r.operational_status === 'closed') || J(r);
  });
  await check('review: next operationally_complete is manual on a container transaction, in_progress is manual', async () => {
    const t = await mkTx('jed', {});
    await addCtr('jed', t, 'LIFU0000013');
    const a = (await lifecycle('jed', t)).next;
    await q(`UPDATE public.transactions SET operational_status = 'empty_return' WHERE id = $1`, [t]);
    const b = (await lifecycle('jed', t)).next;
    return (a.code === 'in_progress' && a.manual === true && b.code === 'operationally_complete' && b.manual === true) || J({ a, b });
  });
  await check('next under_billing is manual and reports the containers not returned', async () => {
    const t = await mkTx('jed', {});
    await addCtr('jed', t, 'LIFU0000003');
    await q(`UPDATE public.transactions SET operational_status = 'operationally_complete' WHERE id = $1`, [t]);
    const r = await lifecycle('jed', t);
    return (r.next.code === 'under_billing' && r.next.manual === true && r.next.containers_not_returned === 1 && r.follow_up_required === true) || J(r.next);
  });
  await check('Ro-Ro stepper: appointment + empty_return are skipped (never todo / done) and next never points at them', async () => {
    const t = await mkTx('jed', { bl_number: 'RORO-STEP', cargo_unit_type: 'roro', chassis_no: 'VIN0003' });
    const a = await lifecycle('jed', t);
    await q(`UPDATE public.transactions SET operational_status = 'customs_declaration' WHERE id = $1`, [t]);
    const b = await lifecycle('jed', t);
    const done = await lifecycle('jed', X.ro);                               // released Ro-Ro, now operationally_complete
    const sk = r => r.stages.filter(x => x.state === 'skipped').map(x => x.code).join(',');
    return (sk(a) === 'appointment,empty_return' && sk(b) === 'appointment,empty_return' && b.next.code === 'transport'
      && sk(done) === 'appointment,empty_return' && done.stages.find(x => x.code === 'transport').state === 'done'
      && done.stages.find(x => x.code === 'operationally_complete').state === 'current') || J({ a: sk(a), b: b.next, done: done.stages.map(x => x.code + ':' + x.state) });
  });
  await check('container stepper never reports skipped', async () => {
    const r = await lifecycle('jed', X.l2);
    return r.stages.every(x => x.state !== 'skipped') || J(r.stages);
  });
  for (const [who, want] of [['dmm', 'MRS_NOT_FOUND transaction'], ['portal', 'MRS_NOT_FOUND transaction'], ['staffB', 'MRS_NOT_FOUND transaction'], ['anon', 'perm']]) {
    await check('tx_lifecycle as ' + who + ' → ' + want, async () => { const r = await code(() => lifecycle(who, X.l2)); return r === want || r; });
  }
}

/* ================================================================== 6. duplicate appointments */
async function secAppointments() {
  section('6. duplicate appointments (legacy findDuplicateMovementRow_)');
  X.a1 = await mkTx('jed', {});
  X.a1c = await addCtr('jed', X.a1, 'APPU0000001');
  X.a1c2 = await addCtr('jed', X.a1, 'APPU0000002');
  const at = '2026-12-20T08:00:00Z';
  X.ap1 = (await mkAppt('jed', { transaction_id: X.a1, container_id: X.a1c, appointment_at: at, appointment_no: 'TAS10000001' })).id;
  await check('same container + minute + same number → MRS_DUPLICATE_APPOINTMENT', async () =>
    (await code(() => mkAppt('jed', { transaction_id: X.a1, container_id: X.a1c, appointment_at: '2026-12-20T08:00:40Z', appointment_no: 'TAS10000001' })))
      === 'MRS_DUPLICATE_APPOINTMENT appointment');
  await check('a new one WITHOUT a number at that minute → duplicate (legacy: no TAS = container + time)', async () =>
    (await code(() => mkAppt('jed', { transaction_id: X.a1, container_id: X.a1c, appointment_at: at }))) === 'MRS_DUPLICATE_APPOINTMENT appointment');
  await check('another number at the same minute → accepted (legacy: a TAS number narrows the match)', async () =>
    (await code(() => mkAppt('jed', { transaction_id: X.a1, container_id: X.a1c, appointment_at: at, appointment_no: 'TAS10000002' }))) === 'ok');
  await check('another container or another minute → accepted', async () =>
    (await code(() => mkAppt('jed', { transaction_id: X.a1, container_id: X.a1c2, appointment_at: at, appointment_no: 'TAS10000001' }))) === 'ok'
    && (await code(() => mkAppt('jed', { transaction_id: X.a1, container_id: X.a1c, appointment_at: '2026-12-20T08:01:00Z', appointment_no: 'TAS10000001' }))) === 'ok');
  await check('cancelled / missed free the slot', async () => {
    await as('jed', `SELECT public.set_appointment_status($1, 'cancelled', 'خطأ')`, [X.ap1]);
    const a = await code(() => mkAppt('jed', { transaction_id: X.a1, container_id: X.a1c, appointment_at: at, appointment_no: 'TAS10000001' }));
    const id = (await one(`SELECT id FROM public.port_appointments WHERE transaction_id = $1 AND container_id = $3 AND status = 'requested' AND appointment_no = 'TAS10000001' AND appointment_at = $2`, [X.a1, at, X.a1c])).id;
    await as('jed', `SELECT public.set_appointment_status($1, 'missed', 'لم يحضر')`, [id]);
    const b = await code(() => mkAppt('jed', { transaction_id: X.a1, container_id: X.a1c, appointment_at: at, appointment_no: 'TAS10000001' }));
    return (a === 'ok' && b === 'ok') || J({ a, b, rows: await q(`SELECT id, status, appointment_no, appointment_at, container_id FROM public.port_appointments WHERE transaction_id = $1`, [X.a1]) });
  });
  await check('reschedule onto a slot held by another live appointment → MRS_DUPLICATE_APPOINTMENT', async () => {
    const x = (await mkAppt('jed', { transaction_id: X.a1, container_id: X.a1c, appointment_at: '2026-12-21T09:00:00Z' })).id;
    return (await code(() => rpc('jed', `SELECT public.reschedule_appointment($1, $2, 'تعديل', $3) r`,
      [x, { appointment_at: '2026-12-20T08:01:00Z', appointment_no: 'TAS10000001' }, newKey()]))) === 'MRS_DUPLICATE_APPOINTMENT appointment';
  });
  await check('the backstop unique index exists (live rows only, minute, number)', async () => {
    const r = await one(`SELECT indexdef FROM pg_indexes WHERE indexname = 'port_appointments_dup_uidx'`);
    return (r && /UNIQUE/.test(r.indexdef) && /appt_minute/.test(r.indexdef) && /missed/.test(r.indexdef)) || J(r);
  });
  await check('the index refuses a raw duplicate the trigger would also refuse (owner insert)', async () =>
    /MRS_DUPLICATE_APPOINTMENT|uniq:port_appointments_dup_uidx/.test(await code(() => q(`INSERT INTO public.port_appointments (org_id, transaction_id, container_id, appointment_at, appointment_no)
      VALUES ($1, $2, $3, '2026-12-20T08:01:10Z', 'TAS10000001')`, [A, X.a1, X.a1c]))));
}

/* ================================================================== 7. save_movement */
async function secMovements() {
  section('7. save_movement (legacy saveMovement) + list_movements + driver_directory');
  X.m = await mkTx('jed', { bl_number: 'MOVE-1' });
  await ownerDecl(X.m, 'MOVE-DEC-1');
  X.mc = await addCtr('jed', X.m, 'MOVU0000001');
  X.mc2 = await addCtr('jed', X.m, 'MOVU0000002');
  const base = o => Object.assign({ transaction_id: X.m, container_id: X.mc, appointment_at: '2026-12-22T10:00:00Z', driver_name: 'سائق أول',
    driver_phone: '+966 55 123 4567', truck_plate: 'abc-1234' }, o || {});
  for (const [label, who, p, want] of [
    ['transaction_id missing → MRS_REQUIRED transaction_id', 'jed', { container_id: X.mc }, 'MRS_REQUIRED transaction_id'],
    ['unknown key → MRS_INVALID unknown_key', 'jed', base({ foo: 1 }), 'MRS_INVALID unknown_key'],
    ['other branch → MRS_NOT_FOUND transaction', 'dmm', base(), 'MRS_NOT_FOUND transaction'],
    ['client user → MRS_NOT_FOUND transaction', 'portal', base(), 'MRS_NOT_FOUND transaction'],
    ['accountant (not a transport writer) → MRS_FORBIDDEN role', 'acc', base(), 'MRS_FORBIDDEN role'],
    ['transport staff with an amount → MRS_FORBIDDEN cost', 'trn', base({ cost_amount: 100 }), 'MRS_FORBIDDEN cost'],
    ['container missing on a container transaction → MRS_REQUIRED container_id', 'jed', base({ container_id: null }), 'MRS_REQUIRED container_id'],
    ['container of another transaction → MRS_INVALID container_id', 'jed', base({ container_id: X.l1c }), 'MRS_INVALID container_id'],
    ['appointment time missing → MRS_REQUIRED appointment_at', 'jed', base({ appointment_at: null }), 'MRS_REQUIRED appointment_at'],
    ['driver name missing → MRS_REQUIRED driver_name', 'jed', base({ driver_name: null }), 'MRS_REQUIRED driver_name'],
    ['driver phone missing → MRS_REQUIRED driver_phone', 'jed', base({ driver_phone: null }), 'MRS_REQUIRED driver_phone'],
    ['bad driver phone → MRS_INVALID driver_phone', 'jed', base({ driver_phone: '12345' }), 'MRS_INVALID driver_phone'],
    ['truck missing → MRS_REQUIRED truck_plate', 'jed', base({ truck_plate: null }), 'MRS_REQUIRED truck_plate'],
    ['bad movement status → MRS_INVALID movement_status', 'jed', base({ movement_status: 'done' }), 'MRS_INVALID movement_status'],
    ['cancel without a movement → MRS_BAD_TRANSITION cancelled', 'jed', base({ movement_status: 'cancelled', reason: 'x' }), 'MRS_BAD_TRANSITION cancelled'],
    ['delivered_at without delivered → MRS_INVALID delivered_at', 'jed', base({ delivered_at: '2026-11-01T10:00:00Z' }), 'MRS_INVALID delivered_at'],
    ['carrier of the wrong kind → MRS_INVALID carrier_id', 'jed', base({ carrier_id: P.yardA }), 'MRS_INVALID carrier_id']]) {
    await check('save_movement: ' + label, async () => { const r = await code(() => move(who, p)); return r === want || r; });
  }
  await check('nothing was written by the refused calls (no driver, truck, appointment, trip)', async () =>
    (await num(`SELECT count(*) n FROM public.drivers WHERE org_id = $1 AND phone = '0551234567'`, [A])) === 0
    && (await num(`SELECT count(*) n FROM public.port_appointments WHERE transaction_id = $1`, [X.m])) === 0);
  const k1 = newKey();
  await check('transport staff: a new movement → appointment + linked trip, driver created (phone 05…), truck created (plate normalised), status incomplete, transport stage', async () => {
    const r = await move('trn', base({ appointment_no: '12345678TAS', terminal_party_id: P.topA, destination: 'الرياض', origin: 'ميناء جدة',
      return_deadline: '2026-12-30', return_yard_party_id: P.yardA }), k1);
    X.mv1 = r;
    const m = r.movement;
    const d = await one(`SELECT full_name, phone, last_truck_id, created_by FROM public.drivers WHERE id = $1`, [r.driver_id]);
    const t = await one(`SELECT plate_no FROM public.trucks WHERE id = $1`, [r.truck_id]);
    const trip = await one(`SELECT appointment_id, planned_at, destination, driver_id FROM public.transport_trips WHERE id = $1`, [m.trip_id]);
    const c = await one(`SELECT return_deadline::text d, return_yard_party_id y, return_location l FROM public.containers WHERE id = $1`, [X.mc]);
    return (r.is_new === true && r.already_exists === false && r.driver_created && r.truck_created && d.phone === '0551234567' && d.full_name === 'سائق أول'
      && d.last_truck_id === r.truck_id && d.created_by === U.trn && t.plate_no === 'ABC1234' && trip.appointment_id === m.appointment_id
      && m.appointment_no === 'TAS12345678' && m.movement_status === 'incomplete' && m.cost_amount === null && m.driver_phone === '0551234567'
      && m.truck_plate === 'ABC1234' && m.container_no === 'MOVU0000001' && r.lifecycle_status === 'transport' && r.transaction.operational_status === 'transport'
      && J(r.pending_containers) === '["MOVU0000001","MOVU0000002"]' && r.follow_up_required === true
      && c.d === '2026-12-30' && c.y === P.yardA && c.l === 'ساحة أ') || J({ r, d, t, trip, c });
  });
  await check('the idempotency key replays the stored answer (replayed), nothing new', async () => {
    const r = await move('trn', base({ appointment_no: '12345678TAS', terminal_party_id: P.topA, destination: 'الرياض', origin: 'ميناء جدة',
      return_deadline: '2026-12-30', return_yard_party_id: P.yardA }), k1);
    return (r.replayed === true && r.movement.appointment_id === X.mv1.movement.appointment_id
      && (await num(`SELECT count(*) n FROM public.port_appointments WHERE transaction_id = $1`, [X.m])) === 1) || J(r);
  });
  await check('same container + minute again → MRS_DUPLICATE_APPOINTMENT; idempotent: true → the existing movement, already_exists, nothing written', async () => {
    const a = await code(() => move('trn', base()));
    const n0 = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1`, [X.m]);
    const r = await move('trn', base({ idempotent: true }));
    const n1 = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1`, [X.m]);
    return (a === 'MRS_DUPLICATE_APPOINTMENT appointment' && r.already_exists === true && r.is_new === false
      && r.movement.appointment_id === X.mv1.movement.appointment_id && n0 === n1) || J({ a, r });
  });
  await check('the same phone with another name: the driver entry is reused and renamed (legacy directory follows the last movement); a new truck becomes last_truck', async () => {
    const r = await move('trn', base({ container_id: X.mc2, driver_name: 'سائق أول معدل', driver_phone: '0551234567', truck_plate: 'XYZ 999' }));
    X.mv2 = r;
    const d = await one(`SELECT full_name, last_truck_id FROM public.drivers WHERE id = $1`, [r.driver_id]);
    return (r.driver_id === X.mv1.driver_id && r.driver_created === false && r.truck_created === true && d.full_name === 'سائق أول معدل'
      && d.last_truck_id === r.truck_id) || J({ r, d });
  });
  await check('delivered without the amounts → MRS_REQUIRED cost_amount (legacy «تم النقل» needs value and revenue)', async () =>
    (await code(() => move('trn', { transaction_id: X.m, appointment_id: X.mv1.movement.appointment_id, driver_id: X.mv1.driver_id,
      truck_id: X.mv1.truck_id, movement_status: 'delivered' }))) === 'MRS_REQUIRED cost_amount');
  await check('delivered without a destination → MRS_REQUIRED destination', async () =>
    (await code(() => move('opsm', { transaction_id: X.m, appointment_id: X.mv2.movement.appointment_id, driver_id: X.mv2.driver_id,
      truck_id: X.mv2.truck_id, cost_amount: 500, sell_amount: 650, movement_status: 'delivered' }))) === 'MRS_REQUIRED destination');
  await check('operations manager: confirm + amounts → registered (amounts visible to a finance role)', async () => {
    const r = await move('opsm', { transaction_id: X.m, appointment_id: X.mv1.movement.appointment_id, driver_id: X.mv1.driver_id,
      truck_id: X.mv1.truck_id, cost_amount: '٥٠٠', sell_amount: 650.5, appointment_status: 'confirmed' });
    return (r.is_new === false && r.movement.movement_status === 'registered' && r.movement.appointment_status === 'confirmed'
      && Number(r.movement.cost_amount) === 500 && Number(r.movement.sell_amount) === 650.5) || J(r);
  });
  await check('transport staff then marks it delivered: trip delivered, appointment completed, container delivered', async () => {
    const r = await move('trn', { transaction_id: X.m, appointment_id: X.mv1.movement.appointment_id, driver_id: X.mv1.driver_id,
      truck_id: X.mv1.truck_id, movement_status: 'delivered', delivered_at: new Date(Date.now() - 3600000).toISOString() });
    const c = await one(`SELECT delivered_at, operational_state FROM public.containers WHERE id = $1`, [X.mc]);
    return (r.movement.movement_status === 'delivered' && r.movement.trip_status === 'delivered' && r.movement.appointment_status === 'completed'
      && r.movement.unloaded_at && r.movement.cost_amount === null && c.delivered_at && c.operational_state === 'delivered') || J({ r, c });
  });
  await check('a delivered movement cannot be edited or cancelled', async () =>
    (await code(() => move('trn', { transaction_id: X.m, appointment_id: X.mv1.movement.appointment_id, driver_id: X.mv1.driver_id, truck_id: X.mv1.truck_id,
      destination: 'جدة' }))) === 'MRS_BAD_TRANSITION completed'
    && (await code(() => move('trn', { transaction_id: X.m, trip_id: X.mv1.movement.trip_id, movement_status: 'cancelled', reason: 'x' }))) === 'MRS_BAD_TRANSITION delivered');
  await check('a new time without a reason → MRS_NOTE_REQUIRED reason; with a reason = a reschedule (old row kept, trip follows the new row)', async () => {
    const p = { transaction_id: X.m, appointment_id: X.mv2.movement.appointment_id, driver_id: X.mv2.driver_id, truck_id: X.mv2.truck_id,
      appointment_at: '2026-12-23T07:30:00Z' };
    const a = await code(() => move('trn', p));
    const r = await move('trn', Object.assign({ reason: 'المحطة أجلت الموعد' }, p));
    const old = await one(`SELECT status, status_reason FROM public.port_appointments WHERE id = $1`, [X.mv2.movement.appointment_id]);
    const nw = await one(`SELECT rescheduled_from_id FROM public.port_appointments WHERE id = $1`, [r.movement.appointment_id]);
    const trip = await one(`SELECT appointment_id, planned_at FROM public.transport_trips WHERE id = $1`, [X.mv2.movement.trip_id]);
    X.mv2b = r;
    return (a === 'MRS_NOTE_REQUIRED reason' && old.status === 'rescheduled' && nw.rescheduled_from_id === X.mv2.movement.appointment_id
      && r.movement.trip_id === X.mv2.movement.trip_id && trip.appointment_id === r.movement.appointment_id
      && new Date(trip.planned_at).toISOString() === '2026-12-23T07:30:00.000Z') || J({ a, old, nw, trip });
  });
  await check('reschedule_appointment (G3 RPC) also moves the linked trip to the new row', async () => {
    const r = await rpc('jed', `SELECT public.reschedule_appointment($1, $2, 'تغيير', $3) r`, [X.mv2b.movement.appointment_id, { appointment_at: '2026-12-24T07:30:00Z' }, newKey()]);
    const trip = await one(`SELECT appointment_id FROM public.transport_trips WHERE id = $1`, [X.mv2.movement.trip_id]);
    X.mv2c = r.appointment.id;
    return trip.appointment_id === r.appointment.id || J(trip);
  });
  await check('cancel a movement: needs a reason; then appointment + trip cancelled, movement_status cancelled', async () => {
    const a = await code(() => move('trn', { transaction_id: X.m, appointment_id: X.mv2c, movement_status: 'cancelled' }));
    const r = await move('trn', { transaction_id: X.m, appointment_id: X.mv2c, movement_status: 'cancelled', reason: 'ألغى العميل النقل' });
    return (a === 'MRS_NOTE_REQUIRED reason' && r.movement.movement_status === 'cancelled' && r.movement.appointment_status === 'cancelled'
      && r.movement.trip_status === 'cancelled') || J({ a, r });
  });
  await check('the return plan of a returned / waived container is frozen → MRS_BAD_TRANSITION waived', async () => {
    await as('opsm', `UPDATE public.containers SET return_status = 'waived', waiver_reason = 'استثناء' WHERE id = $1`, [X.mc2]);
    return (await code(() => move('trn', base({ container_id: X.mc2, appointment_at: '2026-12-26T10:00:00Z', return_deadline: '2027-01-01' })))) === 'MRS_BAD_TRANSITION waived';
  });
  await check('events: appointment / trip events carry via save_movement, never amounts; a return_plan container event', async () => {
    const e = await q(`SELECT event_type, payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type IN ('appointment','trip','container')`, [X.m]);
    const s = J(e);
    return (e.some(x => x.event_type === 'trip' && x.payload.via === 'save_movement') && e.some(x => x.payload.op === 'return_plan')
      && !/650\.5|"cost_amount":\s*[0-9]|"sell_amount":\s*[0-9]/.test(s)) || s.slice(0, 400);
  });

  section('7b. list_movements');
  await check('list_movements: latest appointment of each chain (no rescheduled rows), with trip; amounts only for finance roles', async () => {
    const a = await movements('trn', X.m), b = await movements('opsm', X.m);
    const ids = a.map(x => x.appointment_id);
    return (a.length === 2 && !ids.includes(X.mv2.movement.appointment_id) && a.every(x => x.cost_amount === null)
      && b.some(x => Number(x.cost_amount) === 500) && a.find(x => x.appointment_id === X.mv1.movement.appointment_id).movement_status === 'delivered') || J(a);
  });
  await check('a trip without an appointment is listed too', async () => {
    await mkTrip('jed', { transaction_id: X.m, container_id: X.mc, destination: 'الدمام' });
    const a = await movements('jed', X.m);
    return a.some(x => x.appointment_id === null && x.trip_id && x.destination === 'الدمام' && x.movement_status === 'incomplete') || J(a);
  });
  for (const [who, want] of [['dmm', 'MRS_NOT_FOUND transaction'], ['portal', 'MRS_NOT_FOUND transaction'], ['anon', 'perm']]) {
    await check('list_movements as ' + who + ' → ' + want, async () => { const r = await code(() => movements(who, X.m)); return r === want || r; });
  }

  section('7c. Ro-Ro and cancelled transactions');
  await check('Ro-Ro: a container → MRS_INVALID container_id; without an appointment time → the trip alone (transport stage untouched past operationally_complete)', async () => {
    const t = await mkTx('jed', { bl_number: 'RORO-MV', cargo_unit_type: 'roro', chassis_no: 'VIN0002' });
    await ownerDecl(t, 'RORO-MV-DEC');
    const a = await code(() => move('jed', { transaction_id: t, container_id: X.mc, driver_name: 'سائق', driver_phone: '0559998888', truck_plate: 'R1' }));
    const r = await move('jed', { transaction_id: t, driver_name: 'سائق', driver_phone: '0559998888', truck_plate: 'R1', destination: 'جدة' });
    return (a === 'MRS_INVALID container_id' && r.movement.appointment_id === null && r.movement.trip_id && r.transaction.operational_status === 'transport'
      && r.pending_containers.length === 0 && r.follow_up_required === false) || J({ a, r });
  });
  await check('a cancelled transaction → MRS_BAD_TRANSITION cancelled', async () =>
    (await code(() => move('jed', { transaction_id: X.cancelledTx, appointment_at: '2026-12-22T10:00:00Z', driver_name: 'س', driver_phone: '0551112222', truck_plate: 'AA11' })))
      === 'MRS_BAD_TRANSITION cancelled');

  section('7d. driver_directory');
  await check('by name (legacy search key) and by phone digits; with the last truck plate', async () => {
    const a = await rpc('trn', `SELECT public.driver_directory($1, $2) r`, [A, 'سائق اول']);
    const b = await rpc('trn', `SELECT public.driver_directory($1, $2) r`, [A, '١٢٣٤٥']);
    const c = await rpc('trn', `SELECT public.driver_directory($1, NULL) r`, [A]);
    return (a.some(x => x.driver_id === X.mv1.driver_id && x.last_truck_plate === 'XYZ999') && b.some(x => x.phone === '0551234567') && c.length >= 2) || J({ a, b });
  });
  await check('a 1-character query → []; too long → MRS_TOO_LONG q', async () =>
    J(await rpc('trn', `SELECT public.driver_directory($1, 'س') r`, [A])) === '[]'
    && (await code(() => rpc('trn', `SELECT public.driver_directory($1, $2) r`, [A, 'x'.repeat(61)]))) === 'MRS_TOO_LONG q');
  for (const [who, want] of [['stranger', 'MRS_FORBIDDEN'], ['portal', 'MRS_FORBIDDEN'], ['staffB', 'MRS_FORBIDDEN'], ['anon', 'perm']]) {
    await check('driver_directory as ' + who + ' → ' + want, async () => { const r = await code(() => rpc(who, `SELECT public.driver_directory($1, NULL) r`, [A])); return r === want || r; });
  }
  await check('org B does not see org A drivers', async () => (await rpc('staffB', `SELECT public.driver_directory($1, NULL) r`, [B])).length === 0);
}

/* ================================================================== 8. ports */
async function secPorts() {
  section('8. port_operators');
  await check('SAJED: the mapped operator first, then operators mapped to no port; an operator mapped elsewhere is left out', async () => {
    const r = await rpc('jed', `SELECT public.port_operators($1, 'SAJED') r`, [A]);
    const ids = r.map(x => x.party_id);
    return (ids[0] === P.topA && r[0].mapped === true && ids.includes(P.topA2) && !ids.includes(P.topA3) && !ids.includes(P.carA) && !ids.includes(P.topB)) || J(r);
  });
  await check('no port → every active terminal operator of the org; a deactivated mapping frees the operator for every port', async () => {
    const all = await rpc('jed', `SELECT public.port_operators($1, NULL) r`, [A]);
    await as('trn', `UPDATE public.party_ports SET is_active = false WHERE party_id = $1`, [P.topA3]);
    const r = await rpc('jed', `SELECT public.port_operators($1, 'SAJED') r`, [A]);
    return (all.length === 3 && r.some(x => x.party_id === P.topA3 && x.mapped === false)) || J({ all, r });
  });
  await check('the transaction rule agrees: an operator mapped to SADMM only is refused on a SAJED transaction', async () => {
    await as('trn', `UPDATE public.party_ports SET is_active = true WHERE party_id = $1`, [P.topA3]);
    return (await code(() => mkTx('jed', { port_code: 'SAJED', terminal_party_id: P.topA3 }))) === 'MRS_INVALID terminal_party_id';
  });
  for (const [label, who, port, want] of [['unknown port → MRS_INVALID port_code', 'jed', 'XXXXX', 'MRS_INVALID port_code'],
    ['stranger → MRS_FORBIDDEN', 'stranger', 'SAJED', 'MRS_FORBIDDEN'], ['client → MRS_FORBIDDEN', 'portal', 'SAJED', 'MRS_FORBIDDEN'],
    ['anon → perm', 'anon', 'SAJED', 'perm']]) {
    await check('port_operators: ' + label, async () => { const r = await code(() => rpc(who, `SELECT public.port_operators($1, $2) r`, [A, port])); return r === want || r; });
  }
}

/* ================================================================== 9. cancelled visibility */
async function secCancelled() {
  section('9. «ملغاة» in public tracking and the portal');
  const t = await mkTx('jed', {});
  const tok = (await rpc('jed', `SELECT public.issue_tracking_token($1, $2) r`, [t, newKey()])).tracking_token;
  const ref = (await txRow(t)).ref;
  const track = () => rpc('anon', `SELECT public.public_track($1, $2) r`, [ref, tok]);
  await check('live transaction: cancelled = false, normal label', async () => {
    const r = (await track()).transaction;
    return (r.cancelled === false && r.cancelled_at === null && r.status_label_ar === 'جديدة') || J(r);
  });
  await as('jed', `SELECT public.cancel_transaction($1, 'طلب العميل')`, [t]);
  await check('cancelled: cancelled = true + cancelled_at, label «ملغاة» / Cancelled, operational_status stays closed, the cancel event labelled «ملغاة», no reason', async () => {
    const r = await track();
    const x = r.transaction;
    const last = x.timeline[x.timeline.length - 1];
    return (x.cancelled === true && x.cancelled_at && x.status_label_ar === 'ملغاة' && x.status_label_en === 'Cancelled' && x.operational_status === 'closed'
      && last.label_ar === 'ملغاة' && last.status === 'closed' && !J(r).includes('طلب العميل')) || J(r);
  });
  await check('the client portal reads cancelled_at of its transaction (not the reason / who)', async () => {
    const a = await as('portal', `SELECT cancelled_at FROM public.transactions WHERE id = $1`, [t]);
    const b = await code(() => as('portal', `SELECT cancel_reason FROM public.transactions WHERE id = $1`, [t]));
    return (a.length === 1 && a[0].cancelled_at && b === 'perm') || J({ a, b });
  });
}

/* ================================================================== 10. grants, privileges */
/* ================================================================== 9b. review regressions */
async function secReview() {
  section('9b. review regressions');
  const saveBl = (who, p) => rpc(who, `SELECT public.save_bl($1, $2) r`, [p, newKey()]);
  await check('review: renumbering a B/L (save_bl with id) onto a live twin B/L + container → MRS_DUPLICATE_TX container', async () => {
    const t1 = await mkTx('jed', { bl_number: 'PRB-MAIN-1' });
    await addCtr('jed', t1, 'PRBU0000001');
    const t2 = await mkTx('jed', { bl_number: 'PRB-OTHER-2' });
    const sec = await saveBl('jed', { transaction_id: t2, bl_number: 'PRB-SEC-3', bl_type: 'master' });
    const a = await code(() => addCtr('jed', t2, 'PRBU0000001', sec.id));
    const b = await code(() => saveBl('jed', { id: sec.id, bl_number: 'PRB-MAIN-1' }));
    const d = await dup('jed', { bl_number: 'PRB-MAIN-1', containers: ['PRBU0000001'] });
    const c = await code(() => saveBl('jed', { id: sec.id, bl_number: 'PRB-SEC-4' }));
    return (a === 'ok' && b === 'MRS_DUPLICATE_TX container' && d.duplicates.length === 1 && c === 'ok') || J({ a, b, d, c });
  });
  await check('review: idempotent duplicate replay writes nothing to the driver / truck registry', async () => {
    const t = await mkTx('jed', { bl_number: 'IDEM-FLEET-1' });
    await ownerDecl(t, 'IDEM-FLEET-DEC');
    const c = await addCtr('jed', t, 'IDFU0000001');
    const p = { transaction_id: t, container_id: c, appointment_at: '2026-12-27T08:00:00Z', driver_name: 'سائق مراجعة', driver_phone: '0551113333', truck_plate: 'RVW1111' };
    const r1 = await move('trn', p);
    const r2 = await move('trn', Object.assign({}, p, { driver_name: 'اسم مختلف', truck_plate: 'RVW9999', idempotent: true }));
    const d = await one(`SELECT full_name, last_truck_id FROM public.drivers WHERE id = $1`, [r1.driver_id]);
    const n = await num(`SELECT count(*) n FROM public.trucks WHERE org_id = $1 AND plate_no = 'RVW9999'`, [A]);
    return (r2.already_exists === true && r2.driver_created === false && r2.truck_created === false && r2.driver_id === r1.driver_id
      && d.full_name === 'سائق مراجعة' && d.last_truck_id === r1.truck_id && n === 0) || J({ r2, d, n });
  });
  await check('review: the same TAS number in two spellings (create_appointment «TAS-…», save_movement «TAS…») → MRS_DUPLICATE_APPOINTMENT', async () => {
    const t = await mkTx('jed', { bl_number: 'TAS-SPELL-1' });
    const c = await addCtr('jed', t, 'TASU0000001');
    await mkAppt('jed', { transaction_id: t, container_id: c, appointment_at: '2026-12-22T08:00:00Z', appointment_no: 'TAS-12345678' });
    const a = await code(() => move('trn', { transaction_id: t, container_id: c, appointment_at: '2026-12-22T08:00:00Z', appointment_no: 'TAS12345678',
      driver_name: 'سائق تاس', driver_phone: '0551114444', truck_plate: 'TAS1111' }));
    const ix = await one(`SELECT indexdef FROM pg_indexes WHERE indexname = 'port_appointments_dup_uidx'`);
    return (a === 'MRS_DUPLICATE_APPOINTMENT appointment' && /legacy_search_key/.test(ix.indexdef)) || J({ a, ix });
  });
  await check('review: a driver stored as +966… is found by 05… (no second driver), and by phone digits in driver_directory', async () => {
    const id = (await one(`INSERT INTO public.drivers (org_id, full_name, phone) VALUES ($1, 'سائق مسجل', '+966507778899') RETURNING id`, [A])).id;
    const t = await mkTx('jed', { bl_number: 'PHONE-1' });
    const c = await addCtr('jed', t, 'PHNU0000001');
    const r = await move('trn', { transaction_id: t, container_id: c, appointment_at: '2026-12-28T08:00:00Z', driver_name: 'سائق مسجل',
      driver_phone: '0507778899', truck_plate: 'PHN1111' });
    const n = await num(`SELECT count(*) n FROM public.drivers WHERE org_id = $1 AND full_name = 'سائق مسجل'`, [A]);
    const dd = await rpc('trn', `SELECT public.driver_directory($1, $2) r`, [A, '0507778']);
    const dd2 = await rpc('trn', `SELECT public.driver_directory($1, $2) r`, [A, '0507778899']);
    return (r.driver_created === false && r.driver_id === id && n === 1 && dd.some(x => x.driver_id === id) && dd2.some(x => x.driver_id === id)) || J({ r: r.driver_id, n, dd });
  });
  await check('review: «تم النقل» completes a still-requested appointment (it no longer blocks cancel_transaction with open_appointments)', async () => {
    const t = await mkTx('jed', { bl_number: 'DELIV-REQ-1' });
    await ownerDecl(t, 'DELIV-REQ-DEC');
    const c = await addCtr('jed', t, 'DLRU0000001');
    const r = await move('opsm', { transaction_id: t, container_id: c, appointment_at: inHours(-2), driver_name: 'سائق تسليم', driver_phone: '0551115555',
      truck_plate: 'DLR1111', destination: 'الرياض', cost_amount: 100, sell_amount: 150, movement_status: 'delivered' });
    const open = await num(`SELECT count(*) n FROM public.port_appointments WHERE transaction_id = $1 AND status IN ('requested','confirmed')`, [t]);
    const cx = await code(() => as('opsm', `SELECT public.cancel_transaction($1, 'خطأ')`, [t]));
    return (r.movement.movement_status === 'delivered' && r.movement.appointment_status === 'completed' && open === 0
      && cx !== 'MRS_BAD_TRANSITION open_appointments') || J({ m: r.movement, open, cx });
  });
}

async function secGrants() {
  section('10. grants and function privileges');
  await check('the 6 new RPCs: authenticated only (not anon, not service_role, not PUBLIC)', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') s
                         FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname = ANY ($1)`, [RPCS]);
    return (r.length === 6 && r.every(x => x.a && !x.n && !x.s)) || J(r);
  });
  await check('the new app helpers / triggers are closed to authenticated and service_role (app.appt_minute: pure, signed-in only)', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('service_role', p.oid, 'EXECUTE') s,
                              has_function_privilege('anon', p.oid, 'EXECUTE') n
                         FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'app' AND ('app.' || p.proname) = ANY ($1)`, [NEW_FNS]);
    const bad = r.filter(x => x.proname === 'appt_minute' ? (!x.a || x.n) : (x.a || x.s || x.n));
    return (r.length === NEW_FNS.filter(f => f.startsWith('app.')).length && bad.length === 0) || J(bad);
  });
  await check('public_track keeps its anon + authenticated EXECUTE', async () => {
    const r = await one(`SELECT has_function_privilege('anon', 'public.public_track(text,text)', 'EXECUTE') a, has_function_privilege('authenticated', 'public.public_track(text,text)', 'EXECUTE') b`);
    return r.a && r.b;
  });
  await check('transport_trips.appointment_id is selectable by staff; cost_amount still is not', async () =>
    (await code(() => as('jed', `SELECT appointment_id FROM public.transport_trips LIMIT 1`))) === 'ok'
    && (await code(() => as('jed', `SELECT cost_amount FROM public.transport_trips LIMIT 1`))) === 'perm');
  await check('drivers.last_truck_id is readable by staff of the org; port_appointments still has no API write', async () =>
    (await code(() => as('trn', `SELECT last_truck_id FROM public.drivers LIMIT 1`))) === 'ok'
    && (await code(() => as('admin', `INSERT INTO public.port_appointments (org_id, transaction_id, appointment_at) VALUES ($1, $2, now())`, [A, X.m]))) === 'perm');
  await check('no volatile SECURITY DEFINER app function is executable by authenticated', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND p.prosecdef AND p.provolatile = 'v' AND p.proname <> 'next_ref_checked'
                          AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`);
    return r.length === 0 || r.map(x => x.proname).join(', ');
  });
}

/* ================================================================== 11. supa.js */
async function secClient() {
  section('11. supa.js wrappers');
  const s = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  await check('a wrapper per RPC (+ cancel_transaction) and exported', () => {
    const pairs = [['cancelTransaction', 'cancel_transaction'], ['checkTxDuplicates', 'check_tx_duplicates'], ['txLifecycle', 'tx_lifecycle'],
      ['saveMovement', 'save_movement'], ['listMovements', 'list_movements'], ['driverDirectory', 'driver_directory'], ['portOperators', 'port_operators']];
    const miss = pairs.filter(([f, r]) => !new RegExp('function ' + f + '\\(').test(s) || !s.includes("'" + r + "'") || !new RegExp('\\b' + f + ': ' + f + '\\b').test(s));
    return (miss.length === 0 && /idemRpc\('save_movement'/.test(s) && /listCustomsPorts: listCustomsPorts/.test(s) && /listPartyPorts: listPartyPorts/.test(s))
      || 'missing: ' + miss.map(x => x[0]).join(', ');
  });
  await check('TX_COLS selects the step-1 columns + cancelled_at, never the hidden ones', () => {
    const m = s.match(/var TX_COLS = ([\s\S]*?);/);
    const cols = m[1].replace(/\/\/.*$/gm, '').replace(/['+\s]/g, '').split(',');
    const want = ['port_code', 'terminal_party_id', 'cargo_unit_type', 'chassis_no', 'vehicle_plate_no', 'transaction_type', 'transport_mode',
      'transport_party_id', 'transport_order_no', 'transport_order_date', 'cancelled_at'];
    return (want.every(c => cols.includes(c)) && !['notes', 'financial_status', 'declaration_notes', 'cancel_reason', 'cancelled_by', 'tracking_token_hash'].some(c => cols.includes(c))) || J(cols);
  });
  await check('every TX_COLS column is actually API-selectable (column grant)', async () => {
    const m = s.match(/var TX_COLS = ([\s\S]*?);/);
    const cols = m[1].replace(/\/\/.*$/gm, '').replace(/['+\s]/g, '').split(',').filter(Boolean);
    return (await code(() => as('jed', `SELECT ${cols.join(', ')} FROM public.transactions LIMIT 1`))) === 'ok';
  });
  await check('listTransactions: cancelled filter (only / exclude) on cancelled_at', () =>
    /o\.cancelled === 'only'\) q = q\.not\('cancelled_at', 'is', null\)/.test(s) && /o\.cancelled === 'exclude'\) q = q\.is\('cancelled_at', null\)/.test(s));
}

/* ================================================================== main */
(async () => {
  console.log('Marsa — legacy tx (step 2) SQL tests (PGlite; local only)');
  await secFile();
  await secPreflight();

  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  if (!QUIET) console.log('  loaded');

  await secLabels();
  await secDuplicates();
  await secLifecycle();
  await secAppointments();
  await secMovements();
  await secPorts();
  await secCancelled();
  await secReview();
  await secGrants();
  await secClient();
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
