#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 1 (data model foundation): migration 20261117000100_legacy_core.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal).

  Covers: file conventions + all_migrations.sql; preflight + re-run on itself (identical catalog) + catalog delta;
  dictionaries; every pure helper (norm_declaration_status / _type, norm_tas, norm_sa_phone, norm_chassis,
  norm_hijri_date, legacy_search_key, fin_funding_check) with edge cases; customs_ports seed + RLS; party_ports rules +
  RLS; every new transactions CHECK and trigger rule (Ro-Ro, plate, re-export, transport mode / TASTO order, port,
  terminal operator ↔ port, carrier, cancel columns, column grants); customs_declarations Hijri date / type code / Fasah
  stages through the RPCs; clients / client_aliases columns, API guards and match_client ignoring rejected aliases;
  payment methods; the per-org service catalog (seed counts, new org, idempotent seed, RLS); cancel_transaction
  (permissions, every refusal, effects, frozen row); grants; and convert_org_to_production with the new tables (last).

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-core-sql-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261117000100_legacy_core.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in legacy-core-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'deca0000-0000-4000-8000-0000000000b0';           // second org (fixture)
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const TX_JED = '0b5e0000-0000-4000-8000-000000000201';      // seed: JED, customs_declaration stage, 2 containers
const TX_DMM = '0b5e0000-0000-4000-8000-000000000202';      // seed: DMM, 1 container
const TX_JED2 = '0b5e0000-0000-4000-8000-000000000203';     // seed: JED, air, no containers
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const BR_B = 'deca0000-0000-4000-8000-0000000000b1';
const TX_B = 'deca0000-0000-4000-8000-0000000000b2';
const CL_B = 'deca0000-0000-4000-8000-0000000000b3';
const P = {                                                  // parties
  topA: 'deca0000-0000-4000-8000-0000000000e1',   // terminal operator, org A
  topA2: 'deca0000-0000-4000-8000-0000000000e2',  // terminal operator, org A, no port mapping
  carA: 'deca0000-0000-4000-8000-0000000000e3',   // carrier, org A
  supA: 'deca0000-0000-4000-8000-0000000000e4',   // supplier, org A
  topB: 'deca0000-0000-4000-8000-0000000000e5'    // terminal operator, org B
};
const U = {
  admin: 'deca0000-0000-4000-8000-000000000001',    // admin of A (MFA-gated)
  acc: 'deca0000-0000-4000-8000-000000000002',      // accountant of A, org-wide
  accm: 'deca0000-0000-4000-8000-000000000003',     // accounts_manager of A, org-wide
  opsm: 'deca0000-0000-4000-8000-000000000004',     // operations_manager of A, org-wide
  jed: 'deca0000-0000-4000-8000-000000000005',      // clearance_staff of A, JED only
  dmm: 'deca0000-0000-4000-8000-000000000006',      // clearance_staff of A, DMM only
  trn: 'deca0000-0000-4000-8000-000000000007',      // transport_staff of A, JED only
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
const newKey = () => 'decaaaaa-0000-4000-8000-' + String(++keySeq).padStart(12, '0');

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind = 'r' ORDER BY 1`)).map(x => x.t);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('app','public') ORDER BY 1`)).map(x => x.x);
  const pol = (await q(`SELECT tablename || '.' || policyname x FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const con = (await q(`SELECT conrelid::regclass::text || '.' || conname || ':' || md5(pg_get_constraintdef(oid)) x FROM pg_constraint
                         WHERE connamespace = 'public'::regnamespace ORDER BY 1`)).map(x => x.x);
  const cols = (await q(`SELECT table_name || '.' || column_name x FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`)).map(x => x.x);
  const colgr = (await q(`SELECT table_name || '.' || column_name || ':' || privilege_type x FROM information_schema.column_privileges
                           WHERE table_schema = 'public' AND grantee = 'authenticated' ORDER BY 1`)).map(x => x.x);
  const labels = (await q(`SELECT domain || '.' || code || ':' || sort || ':' || label_ar || ':' || client_visible x FROM public.status_labels ORDER BY 1`)).map(x => x.x);
  return { fns, tables, trg, pol, con, cols, colgr, labels };
}
const NEW_FNS = ['app.fin_funding_check', 'app.legacy_search_key', 'app.legacy_spaces', 'app.norm_chassis', 'app.norm_declaration_status', 'app.norm_declaration_type',
  'app.norm_hijri_date', 'app.norm_sa_phone', 'app.norm_tas', 'app.seed_org_service_items', 'app.service_items_template',
  'app.tg_client_aliases_legacy', 'app.tg_clients_legacy_guard', 'app.tg_containers_legacy_roro', 'app.tg_declarations_legacy_norm',
  'app.tg_org_service_items_before', 'app.tg_organizations_seed_service_items', 'app.tg_party_ports_before', 'app.tg_transactions_legacy_guard',
  'app.tg_transactions_legacy_norm', 'public.cancel_transaction'];
const RECREATED = ['app.alert_causes', 'app.convert_delete_tables', 'app.convert_keep_tables', 'app.decl_fields', 'app.decl_insert', 'app.decl_json',
  'app.decl_no_check', 'app.g3_lock_tx', 'app.rpt_tx_json', 'public.correct_declaration', 'public.dash_management', 'public.match_client',
  'public.set_declaration_status', 'public.staff_internal_fields'];
const NEW_TRG = ['clients.trg_legacy_guard', 'client_aliases.trg_legacy', 'containers.trg_legacy_roro', 'customs_declarations.trg_legacy_norm',
  'org_service_items.trg_audit', 'org_service_items.trg_guard', 'org_service_items.trg_norm', 'org_service_items.trg_stamp', 'org_service_items.trg_touch',
  'organizations.trg_seed_service_items', 'party_ports.trg_audit', 'party_ports.trg_guard', 'party_ports.trg_norm', 'party_ports.trg_stamp',
  'party_ports.trg_touch', 'transactions.trg_legacy_guard', 'transactions.trg_legacy_norm'];
const NEW_POL = ['customs_ports.customs_ports_select', 'org_service_items.org_service_items_insert', 'org_service_items.org_service_items_select',
  'org_service_items.org_service_items_update', 'party_ports.party_ports_insert', 'party_ports.party_ports_select', 'party_ports.party_ports_update'];
const SERVICE_CODES = ['do_late_linking_fee', 'transportation_cost', 'inbound_freight', 'gate_in_appointment', 'gate_out_appointment', 'agent_fines_merge',
  'agent_fines_extension', 'logistics_services', 'port_entry_permit', 'storage_charges', 'bl_endorsement', 'sending_documents', 'port_charges',
  'saber_certificate', 'outbound_freight', 'transport_charges', 'other_charges', 'port_storage_groundage', 'handling_charges', 'delivery_order',
  'unloading_charges', 'labor_charges', 'customs_clearance', 'customs_duties', 'electricity_charges', 'late_fee'];
const PORTS = [
  ['SAJED', 'SAJED', 'sea', 'ميناء جدة الإسلامي', 'جمرك ميناء جدة الإسلامي'],
  ['SADMM', 'SADMM', 'sea', 'ميناء الملك عبدالعزيز بالدمام', 'جمرك ميناء الملك عبدالعزيز'],
  ['SAKAC', 'SAKAC', 'sea', 'ميناء الملك عبدالله (رابغ)', null],
  ['SARUH', 'SARUH', 'dry', 'ميناء الرياض الجاف', 'جمرك الرياض - الميناء الجاف'],
  ['SAJED-AIR', 'SAJED', 'air', 'مطار الملك عبدالعزيز الدولي بجدة', 'جمرك مطار الملك عبدالعزيز الدولي'],
  ['SADMM-AIR', 'SADMM', 'air', 'مطار الملك فهد الدولي بالدمام', 'جمرك مطار الملك فهد الدولي'],
  ['SARUH-AIR', 'SARUH', 'air', 'مطار الملك خالد الدولي بالرياض', 'جمرك مطار الملك خالد الدولي']];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@legacy.example.com', now()), ('${U.acc}', 'acc@legacy.example.com', now()),
    ('${U.accm}', 'accm@legacy.example.com', now()), ('${U.opsm}', 'opsm@legacy.example.com', now()),
    ('${U.jed}', 'jed@legacy.example.com', now()), ('${U.dmm}', 'dmm@legacy.example.com', now()),
    ('${U.trn}', 'trn@legacy.example.com', now()), ('${U.portal}', 'portal@legacy.example.com', now()),
    ('${U.stranger}', 'stranger@legacy.example.com', now()), ('${U.staffB}', 'staffb@legacy.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.acc}', 'acc'), ('${U.accm}', 'accm'), ('${U.opsm}', 'opsm'),
    ('${U.jed}', 'jed'), ('${U.dmm}', 'dmm'), ('${U.trn}', 'trn'), ('${U.portal}', 'portal'), ('${U.stranger}', 'stranger'), ('${U.staffB}', 'staffB')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'legacy-org-b', 'مؤسسة النقل ب', 'Legacy org B', 'LGB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', '0509990000');
  INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ('${TX_B}', '${B}', '${BR_B}', '${CL_B}', 'import', 'sea');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.acc}', '${A}', NULL, 'accountant'), ('${U.accm}', '${A}', NULL, 'accounts_manager'),
    ('${U.opsm}', '${A}', NULL, 'operations_manager'), ('${U.jed}', '${A}', '${JED}', 'clearance_staff'),
    ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff'), ('${U.trn}', '${A}', '${JED}', 'transport_staff'),
    ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
  INSERT INTO public.parties (id, org_id, kinds, name_ar) VALUES
    ('${P.topA}', '${A}', ARRAY['terminal_operator'], 'مشغل محطة أ'), ('${P.topA2}', '${A}', ARRAY['terminal_operator'], 'مشغل محطة أ٢'),
    ('${P.carA}', '${A}', ARRAY['carrier'], 'شركة نقل أ'), ('${P.supA}', '${A}', ARRAY['supplier'], 'مورد أ'),
    ('${P.topB}', '${B}', ARRAY['terminal_operator'], 'مشغل محطة ب');
`;
// a transaction inserted by the owner (as the SQL Editor would): JED, CLIENT_A, sea import unless overridden
let txSeq = 0;
async function mkTx(o) {
  o = Object.assign({ org: A, branch: JED, client: CLIENT_A, cols: {} }, o || {});
  const keys = ['org_id', 'branch_id', 'client_id', 'operation', 'mode'].concat(Object.keys(o.cols));
  const vals = [o.org, o.branch, o.client, 'import', 'sea'].concat(Object.values(o.cols));
  const r = await one(`INSERT INTO public.transactions (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, vals);
  txSeq++;
  return r.id;
}
const setTx = (id, set, params) => q(`UPDATE public.transactions SET ${set} WHERE id = $1`, [id].concat(params || []));
const txRow = id => one(`SELECT * FROM public.transactions WHERE id = $1`, [id]);
const cancel = (who, id, why, aal) => as(who, `SELECT public.cancel_transaction($1, $2) r`, [id, why], aal).then(r => r[0].r);
const X = {};

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261116000100, schema_versions row, search_path = \'\' on every function', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261116000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261117000100', 'legacy_core'\)/.test(src)
      && heads.length === 35 && bad.length === 0) || J({ n: heads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('SECURITY DEFINER exactly on the RPCs / definer triggers / seed (not on the pure helpers nor the invoker guards); refusals through app.fail(\'MRS_*\')', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const name = h => (h.match(/FUNCTION ([a-z0-9_.]+)\(/) || [])[1];
    const definer = heads.filter(h => /SECURITY DEFINER/.test(h)).map(name).sort();
    const want = ['app.alert_causes', 'app.decl_insert', 'app.decl_no_check', 'app.g3_lock_tx', 'app.rpt_tx_json', 'app.seed_org_service_items', 'app.tg_containers_legacy_roro', 'app.tg_declarations_legacy_norm',
      'app.tg_org_service_items_before', 'app.tg_organizations_seed_service_items', 'app.tg_party_ports_before', 'app.tg_transactions_legacy_norm',
      'public.cancel_transaction', 'public.correct_declaration', 'public.dash_management', 'public.match_client', 'public.set_declaration_status',
      'public.staff_internal_fields'].sort();
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|LEGACY preflight/.test(r));
    const codes = src.match(/app\.fail\('([A-Z_]+)'/g) || [];
    return (J(definer) === J(want) && raises.length === 0 && codes.length >= 40 && codes.every(c => /app\.fail\('MRS_[A-Z_]+'/.test(c))) || J({ definer, raises: raises.length, codes: codes.length });
  });
  await check('only existing MRS codes are used (the UI already has their messages)', () => {
    const used = [...new Set((src.match(/app\.fail\('(MRS_[A-Z_]+)'/g) || []).map(x => x.slice(10, -1)))].sort();
    const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
    const missing = used.filter(c => !new RegExp('\\b' + c + ':').test(supa));
    return missing.length === 0 || 'no message in supa.js for: ' + missing.join(', ');
  });
  await check('no TRUNCATE / DROP TABLE / DROP FUNCTION / DISABLE TRIGGER / session_replication_role / DELETE; no key or endpoint', () => {
    const c = src.replace(/--.*$/gm, '');
    return (!/\bTRUNCATE\b/i.test(c) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA)/i.test(c) && !/DISABLE TRIGGER/i.test(c) && !/session_replication_role/.test(c)
      && !/\bDELETE\s+FROM\b/i.test(c) && !/sk-ant|api\.anthropic\.com|https?:\/\//i.test(src)) || 'body';
  });
  await check('no personal data / legacy organization name copied from the legacy code (no e-mail, phone number, real org name)', () =>
    (!/@[a-z0-9-]+\.[a-z]/i.test(src.replace(/--.*$/gm, '')) && !/\b05[0-9]{8}\b/.test(src) && !/رأس الحكمة/.test(src)) || 'personal data');
  // later phases may follow this file (20261118000100 legacy_tx: re-creates public_track)
  const LATER_PHASES = ['20261118000100_legacy_tx.sql', '20261119000100_legacy_docs.sql', '20261120000100_legacy_decl.sql'];
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
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const after = next < 0 ? [] : (all.slice(next).match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && after.every(f => LATER_PHASES.includes(f)) && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 8000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
  await check('docs/online/LEGACY_CORE_AR.md exists and names the migration, cancel_transaction and the 7 ports', () => {
    const p = path.join(ROOT, 'docs', 'online', 'LEGACY_CORE_AR.md');
    if (!fs.existsSync(p)) return 'missing';
    const d = fs.readFileSync(p, 'utf8');
    return (d.includes(MIG) && d.includes('cancel_transaction') && PORTS.every(x => d.includes(x[0]))) || 'content';
  });
}

/* ================================================================== 2. preflight, re-run, catalog */
async function secPreflight() {
  section('2. preflight, re-run, catalog delta (separate database, no seed)');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const d = await freshDb(MIG);
  try {
    await withDb(d, async () => {
      const C0 = await catalog();
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261116000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without doc_match: exact preflight message, nothing created', async () =>
        (msg.startsWith('LEGACY preflight: apply doc_match first (schema_versions lacks 20261116000100 doc_match)')
          && (await one(`SELECT to_regclass('public.customs_ports') IS NULL x`)).x && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261116000100', 'doc_match')`);
      // a pre-existing org and declaration: the file seeds the catalog for it and back-fills the type code
      await db.exec(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${B}', 'pre-org', 'مؤسسة سابقة', 'PRE');
                     INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع');
                     INSERT INTO public.clients (id, org_id, client_type, name_ar) VALUES ('${CL_B}', '${B}', 'business', 'عميل');
                     INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, declaration_no, declaration_type)
                       VALUES ('${TX_B}', '${B}', '${BR_B}', '${CL_B}', 'import', 'sea', 'PRE-1', 'تصدير');
                     UPDATE public.customs_declarations SET updated_at = now() - interval '10 days' WHERE transaction_id = '${TX_B}';`);
      const declBefore = await one(`SELECT updated_at::text u FROM public.customs_declarations WHERE transaction_id = $1`, [TX_B]);
      const declAudit0 = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'customs_declarations'`);
      const r1 = await tryErr(() => db.exec(src));
      const declAfter = await one(`SELECT updated_at::text u FROM public.customs_declarations WHERE transaction_id = $1`, [TX_B]);
      const declAudit1 = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'customs_declarations'`);
      await check('review fix: the type code reaches existing declarations without touching them (updated_at kept → no stalled alert auto-resolved; no audit rows)', async () =>
        (declBefore && declAfter && declBefore.u === declAfter.u && declAudit1 === declAudit0) || J({ declBefore, declAfter, declAudit0, declAudit1 }));
      const C1 = await catalog();
      const items1 = await num(`SELECT count(*) n FROM public.org_service_items WHERE org_id = $1`, [B]);
      const audit1 = await num(`SELECT count(*) n FROM public.audit_log`);
      const r2 = await tryErr(() => db.exec(src));
      await check('applies, and re-runs on top of itself with an identical catalog (functions, ACLs, constraints, columns, column grants, labels)', async () =>
        (r1 === 'ok' && r2 === 'ok' && J(C1) === J(await catalog())
          && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261117000100'`)) === 1) || J({ r1, r2 }));
      await check('re-run adds no data: same 26 catalog items, no new audit rows, 7 ports', async () =>
        (items1 === 26 && (await num(`SELECT count(*) n FROM public.org_service_items WHERE org_id = $1`, [B])) === 26
          && (await num(`SELECT count(*) n FROM public.audit_log`)) === audit1 && (await num(`SELECT count(*) n FROM public.customs_ports`)) === 7)
        || J({ items1, audit1 }));
      await check('an existing org got the catalog; an existing declaration got its type code (تصدير → export)', async () => {
        const c = await one(`SELECT declaration_type_code c FROM public.customs_declarations WHERE transaction_id = $1`, [TX_B]);
        return (items1 === 26 && c && c.c === 'export') || J({ items1, c });
      });
      const s0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the 21 new functions; only the 14 re-created bodies changed (ACL / definer / config kept)', () => {
        const nm = s => s.split('(')[0];
        const added = C1.fns.filter(f => !s0.has(f.sig)).map(f => nm(f.sig)).sort();
        const changed = C1.fns.filter(f => s0.has(f.sig) && J(s0.get(f.sig)) !== J(f)).map(f => nm(f.sig)).sort();
        const sameMeta = C1.fns.filter(f => RECREATED.includes(nm(f.sig))).every(b => { const a = s0.get(b.sig); return a && a.acl === b.acl && a.d === b.d && a.c === b.c; });
        return (J(added) === J(NEW_FNS.slice().sort()) && J(changed) === J(RECREATED) && sameMeta) || J({ added, changed, sameMeta });
      });
      await check('catalog: + customs_ports, party_ports, org_service_items; the 17 new triggers; the 7 new policies', () => {
        const t = C1.tables.filter(x => !C0.tables.includes(x)), tr = C1.trg.filter(x => !C0.trg.includes(x)), p = C1.pol.filter(x => !C0.pol.includes(x));
        const goneT = C0.trg.filter(x => !C1.trg.includes(x)), goneP = C0.pol.filter(x => !C1.pol.includes(x));
        return (J(t) === J(['public.customs_ports', 'public.org_service_items', 'public.party_ports']) && J(tr) === J(NEW_TRG.slice().sort())
          && J(p) === J(NEW_POL) && goneT.length === 0 && goneP.length === 0) || J({ t, tr, p, goneT, goneP });
      });
      await check('catalog: the new columns (14 transactions, 2 declarations, 4 clients, 7 aliases) and nothing dropped', () => {
        const added = C1.cols.filter(x => !C0.cols.includes(x)).filter(x => !/^(customs_ports|party_ports|org_service_items)\./.test(x));
        const dropped = C0.cols.filter(x => !C1.cols.includes(x));
        const by = t => added.filter(x => x.startsWith(t + '.')).length;
        return (by('transactions') === 14 && by('customs_declarations') === 2 && by('clients') === 4 && by('client_aliases') === 7
          && added.length === 27 && dropped.length === 0) || J({ added, dropped });
      });
      await check('constraints: the declaration status / payment method CHECKs are re-created as supersets; no other existing constraint changed', () => {
        const key = x => x.split(':')[0];
        const m0 = new Map(C0.con.map(x => [key(x), x]));
        const changed = C1.con.filter(x => m0.has(key(x)) && m0.get(key(x)) !== x).map(key).sort();
        const removed = C0.con.filter(x => !C1.con.some(y => key(y) === key(x))).map(key);
        return (J(changed) === J(['charge_collections.charge_collections_method_check', 'customs_declarations.customs_declarations_status_check',
          'supplier_payments.supplier_payments_method_check']) && removed.length === 0) || J({ changed, removed });
      });
      await check('labels: existing codes keep their labels (only declaration_status sorts move); 43 new rows', () => {
        const key = x => x.split(':')[0];
        const m0 = new Map(C0.labels.map(x => [key(x), x]));
        const changed = C1.labels.filter(x => m0.has(key(x)) && m0.get(key(x)) !== x).map(key);
        const added = C1.labels.filter(x => !m0.has(key(x)));
        return (changed.every(k => /^declaration_status\.(released|cancelled|replaced|under_inspection)$/.test(k)) && added.length === 43) || J({ changed, n: added.length });
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. dictionaries */
async function secLabels() {
  section('3. dictionaries (status_labels)');
  const want = { transaction_type: 2, cargo_unit_type: 2, transport_mode: 2, customs_port_kind: 3, declaration_type: 3, declaration_status: 10,
    client_port_category: 3, client_source: 5, alias_status: 3, fin_payment_method: 10, fin_funding_source: 10, fin_service: 16 };
  await check('domain sizes: ' + Object.entries(want).map(([k, v]) => k + ' ' + v).join(', '), async () => {
    const r = await q(`SELECT domain, count(*)::int n FROM public.status_labels WHERE domain = ANY($1) GROUP BY 1`, [Object.keys(want)]);
    const got = Object.fromEntries(r.map(x => [x.domain, x.n]));
    return Object.keys(want).every(k => got[k] === want[k]) || J(got);
  });
  await check('declaration stages in Fasah order: draft < submitted < accepted < under_inspection < cco_review_done < awaiting_duty_payment < release_ready < released', async () => {
    const r = (await q(`SELECT code FROM public.status_labels WHERE domain = 'declaration_status' ORDER BY sort`)).map(x => x.code);
    return J(r) === J(['draft', 'submitted', 'accepted', 'under_inspection', 'cco_review_done', 'awaiting_duty_payment', 'release_ready', 'released',
      'cancelled', 'replaced']) || J(r);
  });
  await check('released is labelled فسح كلي; the funding sources / payment methods / internal domains are never client-visible', async () => {
    const r = await one(`SELECT label_ar l FROM public.status_labels WHERE domain = 'declaration_status' AND code = 'released'`);
    const v = await num(`SELECT count(*) n FROM public.status_labels WHERE client_visible AND domain IN ('fin_funding_source','fin_payment_method','fin_service',
                           'transport_mode','client_port_category','client_source','alias_status')`);
    return (r.l === 'فسح كلي' && v === 0) || J({ r, v });
  });
  await check('the new payment method codes are labelled (رقم سداد / مدى / محفظة فسح / محفظة الميناء الجاف); the old 6 kept', async () => {
    const r = (await q(`SELECT code, label_ar FROM public.status_labels WHERE domain = 'fin_payment_method' ORDER BY sort`));
    return (J(r.map(x => x.code)) === J(['bank_transfer', 'cash', 'cheque', 'card', 'offset', 'other', 'sadad', 'mada', 'fasah_wallet', 'dry_port_wallet'])
      && r[6].label_ar === 'رقم سداد' && r[9].label_ar === 'محفظة الميناء الجاف') || J(r);
  });
}

/* ================================================================== 4. pure helpers */
async function secHelpers() {
  section('4. helper functions (edge cases)');
  const fn = async (f, input) => (await one(`SELECT ${f}($1) v`, [input])).v;
  const table = async (f, cases) => {
    for (const [input, want] of cases) {
      await check(`${f}(${J(input)}) → ${J(want)}`, async () => { const v = await fn(f, input); return v === want || 'got ' + J(v); });
    }
  };
  await table('app.norm_declaration_status', [
    ['قبول البيان ـ مرحلة تفتيش ومعاينة البضاعة', 'accepted'], ['مرحلة تفتيش ومعاينة البضاعة', 'accepted'], ['قبول  البيان', 'accepted'],
    ['انتهاء مراجعة مركز العمليات الجمركية', 'cco_review_done'], ['انتهت مراجعة مركز العمليات الجمركية', 'cco_review_done'],
    ['مرحلة انتظار تحصيل الرسوم الجمركية', 'awaiting_duty_payment'], ['بانتظار السداد', 'awaiting_duty_payment'], ['الرسوم الجمركية غير مسددة', 'awaiting_duty_payment'],
    ['جاهز لطباعة إشعار الفسح الإلكتروني', 'release_ready'], ['طباعة اشعار الفسح', 'release_ready'],
    ['فسح كلي', 'released'], ['تم الفسح', 'released'], ['مفسوح', 'released'], ['تمَّ الفسح كلياً', 'released'],
    ['released', 'released'], [' Under_Inspection ', 'under_inspection'], ['cco_review_done', 'cco_review_done'],
    ['مسودة', null], ['تحت المعاينة', null], ['ملغى', null], ['فسـح كلي', null], ['\tdraft\n', 'draft'],
    ['قيد الإجراء', null], ['', null], ['   ', null], [null, null], ['xyz', null]]);
  await table('app.norm_declaration_type', [
    ['استيراد', 'import'], [' import ', 'import'], ['IMPORT', 'import'], ['بيان استيراد', 'import'], ['تصدير', 'export'], ['تصدر', 'export'],
    ['Export', 'export'], ['إعادة تصدير', 'export'], ['تصفية', 'clearance'], ['تصفيه', 'clearance'], ['clearance', 'clearance'],
    ['re-export', null], ['عبور', null], ['', null], [null, null]]);
  await table('app.norm_tas', [
    ['TAS12345678', 'TAS12345678'], ['tas 1234-5678', 'TAS12345678'], ['TAS١٢٣٤٥٦٧٨٩', 'TAS123456789'], ['12345678TAS', 'TAS12345678'],
    ['‏12345678TAS‎', 'TAS12345678'], ['‫TAS 98765432‬', 'TAS98765432'], ['Ref: TAS00012345 / gate', 'TAS00012345'],
    ['TAS1234567', null], ['FP12345678', null], ['12345678', null], ['', null], [null, null], ['TA S12345678', 'TAS12345678'],
    ['TAS12345678TAS99999999', 'TAS12345678']]);
  await table('app.norm_sa_phone', [
    ['0501234567', '0501234567'], ['+966501234567', '0501234567'], ['00966501234567', '0501234567'], ['966501234567', '0501234567'],
    ['501234567', '0501234567'], ['٠٥٠١٢٣٤٥٦٧', '0501234567'], ['+966 50 123 4567', '0501234567'], ['(050) 123-4567', '0501234567'],
    ['جوال: 0501234567', '0501234567'], ['0112345678', null], ['+966126543210', null], ['0401234567', null], ['050123456', null],
    ['05012345678', null], ['+971501234567', null], ['abc', null], ['', null], [null, null], ['+96650+1234567', null]]);
  for (const [input, want] of [['0112345678', '0112345678'], ['+966126543210', '0126543210'], ['0182345678', null], ['0501234567', '0501234567'], ['', null]]) {
    await check(`app.norm_sa_phone(${J(input)}, landline) → ${J(want)}`, async () => {
      const v = (await one(`SELECT app.norm_sa_phone($1, true) v`, [input])).v; return v === want || 'got ' + J(v);
    });
  }
  await table('app.norm_chassis', [
    ['jtd-123 456/xyz', 'JTD123456XYZ'], [' 1HGCM82633A004352 ', '1HGCM82633A004352'], ['١٢٣ab', '123AB'], ['شاسيه ABC123', 'ABC123'],
    ['---', null], ['', null], [null, null]]);
  await table('app.norm_hijri_date', [
    ['1447/03/05', '1447/03/05'], ['1447/3/5', '1447/03/05'], ['5/3/1447', '1447/03/05'], ['١٤٤٧/٠٣/٠٥', '1447/03/05'], ['۱۴۴۷-۳-۵', '1447/03/05'],
    ['1447.03.05', '1447/03/05'], ['1447/03/05 هـ', '1447/03/05'], ['5/3/1447AH', '1447/03/05'], ['1447/3/5ه', '1447/03/05'], [' 1447 / 03 / 05 ', '1447/03/05'], ['1300/01/01', '1300/01/01'], ['1700/12/30', '1700/12/30'],
    ['1299/12/30', null], ['1701/01/01', null], ['1447/13/01', null], ['1447/00/10', null], ['1447/02/31', null], ['1447/02/00', null],
    ['2026/11/10', null], ['1447/03', null], ['1447/03/05/01', null], ['14470305', null], ['abc', null], ['', null], [null, null], ['147/03/05', null]]);
  // review fix: NBSP and the other Unicode spaces JS \\s strips (Fasah / PDF / OCR / Excel text) — same answers as MarsaNorm
  const NB = '\u00A0', NNB = '\u202F', EM = '\u2003', IDS = '\u3000', BOM = '\uFEFF';
  await table('app.norm_declaration_status', [['قبول' + NB + 'البيان', 'accepted'], ['تم' + NB + 'الفسح', 'released'], ['released' + NB, 'released'],
    [NNB + 'draft' + EM, 'draft'], [NB + NB, null]]);
  await table('app.norm_declaration_type', [['استيراد' + NB, 'import'], [NB + 'export' + NB, 'export'], ['تصفية' + IDS, 'clearance']]);
  await table('app.norm_tas', [['TAS' + NB + '12345678', 'TAS12345678'], ['TAS' + NNB + '1234' + EM + '5678', 'TAS12345678'], [BOM + 'TAS12345678', 'TAS12345678']]);
  await table('app.norm_hijri_date', [['1447/3/15' + NB + 'هـ', '1447/03/15'], ['1446' + NB + '/05/12', '1446/05/12'], [NB + '1447/03/05' + NB, '1447/03/05'],
    ['15' + NNB + '/' + NNB + '3' + NNB + '/' + NNB + '1447', '1447/03/15']]);
  await table('app.legacy_search_key', [['TEST' + NB + 'X', 'testx'], ['ABC' + EM + 'DEF', 'abcdef'], [NB + IDS, null], ['فسح' + NB + 'كلي', 'فسحكلي']]);
  await table('app.legacy_spaces', [['a' + NB + 'b' + NNB + 'c' + IDS + 'd' + BOM, 'a b c d '], ['a\tb', 'a\tb'], ['', ''], [null, null]]);
  await table('app.legacy_search_key', [['Ro-Ro', 'roro'], ['إعادة  تصدير', 'اعادهتصدير'], ['مُستورد_ ة', 'مُستورده'], ['١٢ أ', '١٢ا'], ['A/B\\C.D', 'abcd'], ['', null], [null, null]]);
  // funding source ↔ method matrix
  const ff = (s, m, p, a) => one(`SELECT app.fin_funding_check($1, $2, $3, $4) v`, [s, m, p, a]).then(r => r.v);
  const mx = [
    [['org_account', 'bank_transfer', null, 'الراجحي'], null], [['org_account', 'sadad', null, 'حساب 1'], null], [['org_account', 'mada', null, null], 'paying_account'],
    [['org_account', 'sadad', null, ' '], 'paying_account'], [['org_account', 'bank_transfer', null, null], 'paying_account'], [['org_account', 'cheque', null, null], null],
    [['fasah_wallet', 'fasah_wallet', null, null], null], [['fasah_wallet', 'sadad', null, 'x'], 'fasah_wallet_method'], [['org_account', 'fasah_wallet', null, null], 'fasah_wallet_source'],
    [['fasah_wallet', 'fasah_wallet', null, 'بنك'], 'wallet_no_account'], [['cash_box', 'cash', null, null], null], [['cash_box', 'mada', null, 'x'], 'cash_box_method'],
    [['dry_port_wallet_org', 'dry_port_wallet', null, null], null], [['client_custody_dry_port', 'dry_port_wallet', null, null], null],
    [['client_custody', 'dry_port_wallet', null, null], 'dry_port_wallet_source'], [['dry_port_wallet_org', 'cash', null, null], 'dry_port_wallet_method'],
    [['dry_port_wallet_org', 'dry_port_wallet', null, 'x'], 'wallet_no_account'], [['personal_account', 'mada', 'أحمد', 'x'], null],
    [['personal_account', 'cash', null, null], 'payer_name'], [['personal_account', 'cash', '  ', null], 'payer_name'], [['client_direct', 'other', null, null], null],
    [['not_applicable_receipt', 'bank_transfer', null, 'x'], null], [['org_account', 'visa', null, null], 'payment_method'], [['wallet', 'cash', null, null], 'funding_source'],
    [[null, 'cash', null, null], 'funding_source'], [['org_account', null, null, null], 'payment_method'],
    // review fix: «غير محدد — سجل سابق» is a legacy-edit value only — a new record never gets it
    [['legacy_unknown', 'cash', null, null], 'funding_source'], [['org_account', 'legacy_unknown', null, null], 'payment_method']];
  for (const [a, want] of mx) {
    await check(`app.fin_funding_check(${a.map(x => J(x)).join(', ')}) → ${J(want)}`, async () => { const v = await ff(...a); return v === want || 'got ' + J(v); });
  }
  // legacy edit / import (p_legacy, legacy isLegacyEdit): unknown source / method accepted, the paying account rule skipped,
  // every other rule still applies
  const fl = (s, m, p, a) => one(`SELECT app.fin_funding_check($1, $2, $3, $4, true) v`, [s, m, p, a]).then(r => r.v);
  const lx = [
    [['legacy_unknown', 'cash', null, null], null], [[null, 'sadad', null, null], null], [['org_account', null, null, null], null],
    [['org_account', 'legacy_unknown', null, null], null], [[null, null, null, null], null], [['org_account', 'sadad', null, null], null],
    [['org_account', 'mada', null, ' '], null], [['legacy_unknown', 'fasah_wallet', null, null], 'fasah_wallet_source'],
    [['cash_box', 'mada', null, 'x'], 'cash_box_method'], [['personal_account', 'cash', null, null], 'payer_name'],
    [['fasah_wallet', 'fasah_wallet', null, 'بنك'], 'wallet_no_account'], [['org_account', 'visa', null, null], 'payment_method'],
    [['wallet', 'cash', null, null], 'funding_source']];
  for (const [a, want] of lx) {
    await check(`app.fin_funding_check(${a.map(x => J(x)).join(', ')}, legacy) → ${J(want)}`, async () => { const v = await fl(...a); return v === want || 'got ' + J(v); });
  }
  await check('fin_funding_check: legacy flag NULL = false; legacy_unknown is not a payment method code (the payment RPCs refuse it)', async () => {
    const v = (await one(`SELECT app.fin_funding_check('legacy_unknown', 'cash', NULL, NULL, NULL) v`)).v;
    const c = await num(`SELECT count(*) n FROM public.status_labels WHERE domain = 'fin_payment_method' AND code = 'legacy_unknown'`);
    return (v === 'funding_source' && c === 0) || J({ v, c });
  });
}

/* ================================================================== 5. ports */
async function secPorts() {
  section('5. customs_ports + party_ports');
  await check('the 7 approved legacy ports: code, UN/LOCODE, kind, Arabic name, Daftra value, order; English names set', async () => {
    const r = await q(`SELECT code, unlocode, kind, name_ar, daftra_value, name_en, is_active FROM public.customs_ports ORDER BY sort`);
    return (r.length === 7 && r.every((x, i) => x.code === PORTS[i][0] && x.unlocode === PORTS[i][1] && x.kind === PORTS[i][2]
      && x.name_ar === PORTS[i][3] && x.daftra_value === PORTS[i][4] && x.name_en && x.is_active)) || J(r);
  });
  await check('kinds: 3 sea, 3 air, 1 dry; a city LOCODE covers both its sea / dry port and its airport', async () => {
    const r = await q(`SELECT kind, count(*)::int n FROM public.customs_ports GROUP BY 1 ORDER BY 1`);
    return J(r) === J([{ kind: 'air', n: 3 }, { kind: 'dry', n: 1 }, { kind: 'sea', n: 3 }]) || J(r);
  });
  for (const [label, sql, want] of [
    ['code format', `INSERT INTO public.customs_ports (code, unlocode, kind, name_ar, name_en, daftra_value) VALUES ('SAJ', 'SAJ', 'sea', 'س', 'x1', 'xx')`, 'chk:customs_ports_code_check'],
    ['code ↔ unlocode / kind', `INSERT INTO public.customs_ports (code, unlocode, kind, name_ar, name_en, daftra_value) VALUES ('SAYNB-AIR', 'SAYNB', 'sea', 'ينبع', 'Yanbu', 'جمرك ينبع')`, 'chk:customs_ports_kind_code_chk'],
    ['kind domain', `INSERT INTO public.customs_ports (code, unlocode, kind, name_ar, name_en, daftra_value) VALUES ('SAYNB', 'SAYNB', 'land', 'ينبع', 'Yanbu', 'جمرك ينبع')`, 'chk:customs_ports_kind_check'],
    ['unique Arabic name', `INSERT INTO public.customs_ports (code, unlocode, kind, name_ar, name_en, daftra_value) VALUES ('SAYNB', 'SAYNB', 'sea', 'ميناء جدة الإسلامي', 'Yanbu', 'جمرك ينبع')`, 'uniq:customs_ports_name_uniq']]) {
    await check('customs_ports CHECK: ' + label + ' → ' + want, async () => { const g = await code(() => q(sql)); return g === want || g; });
  }
  await check('read: staff, the client portal and org B staff read the ports (reference data); anon: permission denied', async () => {
    const s = await as('jed', `SELECT count(*)::int n FROM public.customs_ports`), c = await as('portal', `SELECT count(*)::int n FROM public.customs_ports`);
    const b = await as('staffB', `SELECT count(*)::int n FROM public.customs_ports`);
    const a = await code(() => as('anon', `SELECT 1 FROM public.customs_ports`));
    return (s[0].n === 7 && c[0].n === 7 && b[0].n === 7 && a === 'perm') || J({ s, c, b, a });
  });
  await check('no write for anyone through the API (even the org admin): INSERT / UPDATE / DELETE → permission denied', async () => {
    const i = await code(() => as('admin', `INSERT INTO public.customs_ports (code, unlocode, kind, name_ar, name_en, daftra_value) VALUES ('SAYNB','SAYNB','sea','ينبع','Yanbu','ينبع')`));
    const u = await code(() => as('admin', `UPDATE public.customs_ports SET daftra_value = 'x' WHERE code = 'SAJED'`));
    const d = await code(() => as('admin', `DELETE FROM public.customs_ports WHERE code = 'SAJED'`));
    return (i === 'perm' && u === 'perm' && d === 'perm') || J({ i, u, d });
  });
  // party_ports
  const pp = (who, party, port) => as(who, `INSERT INTO public.party_ports (org_id, party_id, port_code) VALUES ($1, $2, $3) RETURNING id`, [A, party, port]);
  await check('a transport writer (JED transport staff) maps a terminal operator to a port; created_by = the caller; audited', async () => {
    const r = await pp('trn', P.topA, 'SAJED');
    X.pp1 = r[0].id;
    const row = await one(`SELECT created_by, is_active FROM public.party_ports WHERE id = $1`, [X.pp1]);
    const au = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'party_ports' AND row_id = $1 AND action = 'INSERT'`, [X.pp1]);
    return (row.created_by === U.trn && row.is_active === true && au === 1) || J({ row, au });
  });
  await check('a second port for the same operator; the same mapping twice → unique party_ports_uniq', async () => {
    await pp('opsm', P.topA, 'SAJED-AIR');
    const g = await code(() => pp('trn', P.topA, 'SAJED'));
    return g === 'uniq:party_ports_uniq' || g;
  });
  for (const [label, who, party, port, want] of [
    ['a non-operator party (supplier)', 'trn', P.supA, 'SAJED', 'MRS_INVALID party_id'],
    ['a carrier is not a terminal operator', 'trn', P.carA, 'SAJED', 'MRS_INVALID party_id'],
    ['another org\'s operator', 'trn', P.topB, 'SAJED', 'MRS_INVALID party_id'],
    ['an unknown port', 'trn', P.topA2, 'SAYNB-SEA', 'MRS_INVALID port_code'],
    ['an accountant (not a transport writer)', 'acc', P.topA2, 'SAJED', 'rls'],
    ['a client', 'portal', P.topA2, 'SAJED', 'rls'],
    ['staff of org B', 'staffB', P.topA2, 'SAJED', 'rls']]) {
    await check('party_ports refused: ' + label + ' → ' + want, async () => { const g = await code(() => pp(who, party, port)); return g === want || g; });
  }
  await check('a retired port cannot be mapped (MRS_INVALID port_code); re-activated it can', async () => {
    await q(`UPDATE public.customs_ports SET is_active = false WHERE code = 'SAKAC'`);
    const a = await code(() => pp('trn', P.topA2, 'SAKAC'));
    await q(`UPDATE public.customs_ports SET is_active = true WHERE code = 'SAKAC'`);
    const b = await code(() => pp('trn', P.topA2, 'SAKAC'));
    X.ppK = (await one(`SELECT id FROM public.party_ports WHERE party_id = $1 AND port_code = 'SAKAC'`, [P.topA2])).id;
    return (a === 'MRS_INVALID port_code' && b === 'ok') || J({ a, b });
  });
  await check('RLS read: org A staff (any branch) see A mappings; org B staff, the client, a stranger see none; anon permission denied', async () => {
    const n = async w => (await as(w, `SELECT count(*)::int n FROM public.party_ports`))[0].n;
    const a = await n('dmm'), b = await n('staffB'), c = await n('portal'), s = await n('stranger');
    const an = await code(() => as('anon', `SELECT 1 FROM public.party_ports`));
    return (a === 3 && b === 0 && c === 0 && s === 0 && an === 'perm') || J({ a, b, c, s, an });
  });
  await check('(de)activate: is_active may change; party / port / org are immutable (MRS_IMMUTABLE); DELETE → permission denied; org B cannot touch A rows', async () => {
    const u = await as('trn', `UPDATE public.party_ports SET is_active = false WHERE id = $1 RETURNING is_active`, [X.ppK]);
    const im = await code(() => as('trn', `UPDATE public.party_ports SET port_code = 'SADMM' WHERE id = $1`, [X.pp1]));
    const im2 = await code(() => as('trn', `UPDATE public.party_ports SET party_id = $2 WHERE id = $1`, [X.pp1, P.topA2]));
    const d = await code(() => as('admin', `DELETE FROM public.party_ports WHERE id = $1`, [X.pp1]));
    const b = await as('staffB', `UPDATE public.party_ports SET is_active = false WHERE id = $1 RETURNING id`, [X.pp1]);
    return (u[0].is_active === false && im === 'MRS_IMMUTABLE port_code' && im2 === 'MRS_IMMUTABLE party_id' && d === 'perm' && b.length === 0) || J({ u, im, im2, d, b });
  });
}

/* ================================================================== 6. transactions */
async function secTransactions() {
  section('6. transactions: legacy columns, CHECKs, triggers, column grants');
  X.t1 = await mkTx();                                     // JED, new, no containers
  await check('defaults: cargo_unit_type container, transaction_type normal, the rest NULL (seed rows too)', async () => {
    const r = await q(`SELECT cargo_unit_type, transaction_type, port_code, chassis_no, transport_mode, cancelled_at FROM public.transactions WHERE id = ANY($1)`, [[X.t1, TX_JED, TX_B]]);
    return (r.length === 3 && r.every(x => x.cargo_unit_type === 'container' && x.transaction_type === 'normal' && x.port_code === null && x.chassis_no === null
      && x.transport_mode === null && x.cancelled_at === null)) || J(r);
  });
  await check('staff (JED clearance) create a Ro-Ro re-export through the API: chassis normalised to A-Z0-9, plate to one spelling, port stored', async () => {
    const r = await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, cargo_unit_type, chassis_no, vehicle_plate_no,
                                 transaction_type, port_code) VALUES ($1, $2, $3, 'export', 'sea', 'roro', ' jtd-12 345/ab ', 'abc-1234', 're_export', 'SAJED')
                               RETURNING id`, [A, JED, CLIENT_A]);
    X.roro = r[0].id;
    const t = await txRow(X.roro);
    return (t.chassis_no === 'JTD12345AB' && t.vehicle_plate_no === 'ABC1234' && t.transaction_type === 're_export' && t.port_code === 'SAJED'
      && t.cargo_unit_type === 'roro' && t.container_count === 0) || J(t);
  });
  const cases = [
    ['Ro-Ro without a chassis', `cargo_unit_type = 'roro'`, 'chk:transactions_roro_chk'],
    ['a chassis on a container transaction', `chassis_no = 'ABCD1234'`, 'chk:transactions_roro_chk'],
    ['a plate on a container transaction', `vehicle_plate_no = 'ABC123'`, 'chk:transactions_roro_chk'],
    ['Ro-Ro counting containers', `cargo_unit_type = 'roro', chassis_no = 'ABCD1234', container_count = 1`, 'chk:transactions_roro_chk'],
    ['cargo unit outside the domain', `cargo_unit_type = 'bulk'`, 'chk:transactions_cargo_unit_chk'],
    ['chassis shorter than 4 after normalisation', `cargo_unit_type = 'roro', chassis_no = 'a-b-1'`, 'chk:transactions_chassis_chk'],
    ['chassis longer than 30', `cargo_unit_type = 'roro', chassis_no = '${'A'.repeat(31)}'`, 'chk:transactions_chassis_chk'],
    ['a chassis made only of symbols', `cargo_unit_type = 'roro', chassis_no = '-- //'`, 'MRS_INVALID chassis_no'],
    ['a one-character plate', `cargo_unit_type = 'roro', chassis_no = 'ABCD1234', vehicle_plate_no = 'a'`, 'chk:transactions_plate_chk'],
    ['transaction type outside the domain', `transaction_type = 'reexport'`, 'chk:transactions_type_chk'],
    ['transport mode outside the domain', `transport_mode = 'truck'`, 'chk:transactions_transport_mode_chk'],
    ['an order number without carrier_order', `transport_mode = 'driver', transport_order_no = 'TASTO1'`, 'chk:transactions_transport_order_chk'],
    ['an order date without carrier_order', `transport_order_date = current_date`, 'chk:transactions_transport_order_chk'],
    ['an order number that is not TASTO<digits>', `transport_mode = 'carrier_order', transport_order_no = 'TAS12345678'`, 'chk:transactions_transport_order_chk'],
    ['TASTO without digits', `transport_mode = 'carrier_order', transport_order_no = 'tasto'`, 'chk:transactions_transport_order_chk'],
    ['declaration notes over 2000', `declaration_notes = '${'x'.repeat(2001)}'`, 'chk:transactions_declaration_notes_chk'],
    ['cancelled_at without a reason', `cancelled_at = now(), operational_status = 'closed'`, 'chk:transactions_cancel_chk'],
    ['a cancelled transaction that is not closed', `cancelled_at = now(), cancel_reason = 'x'`, 'chk:transactions_cancel_chk'],
    ['a cancel reason over 500', `cancelled_at = now(), cancel_reason = '${'x'.repeat(501)}', operational_status = 'closed'`, 'chk:transactions_cancel_chk'],
    ['an unknown port', `port_code = 'SAYNB-SEA'`, 'MRS_INVALID port_code'],
    ['a supplier as terminal operator', `terminal_party_id = '${P.supA}'`, 'MRS_INVALID terminal_party_id'],
    ['another org\'s terminal operator', `terminal_party_id = '${P.topB}'`, 'MRS_INVALID terminal_party_id'],
    ['a terminal operator as transport company', `transport_party_id = '${P.topA}'`, 'MRS_INVALID transport_party_id']];
  for (const [label, set, want] of cases) {
    await check('refused: ' + label + ' → ' + want, async () => { const g = await code(() => setTx(X.t1, set)); return g === want || g; });
  }
  await check('carrier order: TASTO number normalised (upper case, Arabic digits, spaces), date, carrier party accepted', async () => {
    await setTx(X.t1, `transport_mode = 'carrier_order', transport_order_no = ' tasto ٠٠١٢ ', transport_order_date = '2026-11-01', transport_party_id = $2`, [P.carA]);
    const t = await txRow(X.t1);
    return (t.transport_order_no === 'TASTO0012' && t.transport_party_id === P.carA) || J(t);
  });
  await check('a TASTO number belongs to one live transaction of the org (transactions_transport_order_uidx); another org may reuse it', async () => {
    const t2 = await mkTx();
    const g = await code(() => setTx(t2, `transport_mode = 'carrier_order', transport_order_no = 'TASTO0012'`));
    const b = await code(() => setTx(TX_B, `transport_mode = 'carrier_order', transport_order_no = 'TASTO0012'`));
    X.t2 = t2;
    return (g === 'uniq:transactions_transport_order_uidx' && b === 'ok') || J({ g, b });
  });
  await check('terminal operator ↔ port: an operator mapped to SAJED / SAJED-AIR is refused on SADMM, accepted on SAJED; an unmapped operator is accepted anywhere', async () => {
    const a = await code(() => setTx(X.t2, `port_code = 'SADMM', terminal_party_id = $2`, [P.topA]));
    const b = await code(() => setTx(X.t2, `port_code = 'SAJED', terminal_party_id = $2`, [P.topA]));
    const c = await code(() => setTx(X.t2, `port_code = 'SADMM'`));                         // port change re-checks the operator
    const t3 = await mkTx();
    const d = await code(() => setTx(t3, `port_code = 'SARUH', terminal_party_id = $2`, [P.topA2]));   // topA2: its only mapping is inactive
    return (a === 'MRS_INVALID terminal_party_id' && b === 'ok' && c === 'MRS_INVALID terminal_party_id' && d === 'ok') || J({ a, b, c, d });
  });
  await check('a retired port: refused on a new value, kept on rows that already carry it (other edits still pass)', async () => {
    await q(`UPDATE public.customs_ports SET is_active = false WHERE code = 'SAJED'`);
    const a = await code(() => setTx(X.t1, `port_code = 'SAJED'`));
    const b = await code(() => setTx(X.t2, `declaration_notes = 'ملاحظة البيان'`));             // t2 already on SAJED
    await q(`UPDATE public.customs_ports SET is_active = true WHERE code = 'SAJED'`);
    return (a === 'MRS_INVALID port_code' && b === 'ok') || J({ a, b });
  });
  await check('Ro-Ro carries no containers: switching a transaction with containers → MRS_INVALID cargo_unit_type; adding a container to a Ro-Ro transaction → MRS_INVALID cargo_unit_type', async () => {
    const a = await code(() => setTx(TX_JED, `cargo_unit_type = 'roro', chassis_no = 'ABCD1234', container_count = 0`));
    const b = await code(() => as('trn', `INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, 'MSCU1234565')`, [A, X.roro]));
    const c = await code(() => q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, 'MSCU1234565')`, [A, X.roro]));
    return (a === 'MRS_INVALID cargo_unit_type' && b === 'MRS_INVALID cargo_unit_type' && c === 'MRS_INVALID cargo_unit_type') || J({ a, b, c });
  });
  await check('declaration notes: trimmed, empty → NULL', async () => {
    await setTx(X.t1, `declaration_notes = '   '`);
    const a = (await txRow(X.t1)).declaration_notes;
    await setTx(X.t1, `declaration_notes = '  ملاحظة  '`);
    return (a === null && (await txRow(X.t1)).declaration_notes === 'ملاحظة') || J(a);
  });
  await check('API guard: staff cannot write the cancel columns (insert → cleared; update → MRS_IMMUTABLE)', async () => {
    const r = await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, cancelled_at, cancel_reason, operational_status)
                                VALUES ($1, $2, $3, 'import', 'air', now(), 'x', 'closed') RETURNING id`, [A, JED, CLIENT_A]);
    const t = await txRow(r[0].id);
    const u = await code(() => as('jed', `UPDATE public.transactions SET cancel_reason = 'x' WHERE id = $1`, [X.t1]));
    const u2 = await code(() => as('opsm', `UPDATE public.transactions SET cancelled_by = $2 WHERE id = $1`, [X.t1, U.opsm]));
    X.t4 = r[0].id;
    return (t.cancelled_at === null && t.cancel_reason === null && t.operational_status === 'new' && u === 'MRS_IMMUTABLE cancel_reason'
      && u2 === 'MRS_IMMUTABLE cancelled_by') || J({ t, u, u2 });
  });
  await check('staff edit the legacy columns through the API (RLS + branch): JED staff on a JED transaction yes, DMM staff no rows', async () => {
    const a = await as('jed', `UPDATE public.transactions SET transaction_type = 're_export', port_code = 'SAJED-AIR' WHERE id = $1 RETURNING id`, [X.t4]);
    const b = await as('dmm', `UPDATE public.transactions SET transaction_type = 'normal' WHERE id = $1 RETURNING id`, [X.t4]);
    return (a.length === 1 && b.length === 0 && (await txRow(X.t4)).transaction_type === 're_export') || J({ a, b });
  });
  await check('column grants: the client (portal) reads cargo unit / chassis / type / port of his transaction, not declaration_notes / cancel_reason / cancelled_by', async () => {
    await setTx(TX_JED, `declaration_notes = 'داخلي'`);
    const ok = await as('portal', `SELECT cargo_unit_type, chassis_no, vehicle_plate_no, transaction_type, port_code, terminal_party_id, transport_mode,
                                          transport_order_no, cancelled_at FROM public.transactions WHERE id = $1`, [TX_JED]);
    const bad = [];
    for (const c of ['declaration_notes', 'cancel_reason', 'cancelled_by']) bad.push(await code(() => as('portal', `SELECT ${c} FROM public.transactions WHERE id = $1`, [TX_JED])));
    return (ok.length === 1 && bad.every(x => x === 'perm')) || J({ ok, bad });
  });
  await check('staff read the hidden columns through staff_internal_fields (branch-scoped); the client and org B get nothing', async () => {
    const s = (await as('jed', `SELECT public.staff_internal_fields('transactions', $1) r`, [[TX_JED]]))[0].r;
    const d = (await as('dmm', `SELECT public.staff_internal_fields('transactions', $1) r`, [[TX_JED]]))[0].r;
    const c = (await as('portal', `SELECT public.staff_internal_fields('transactions', $1) r`, [[TX_JED]]))[0].r;
    const b = (await as('staffB', `SELECT public.staff_internal_fields('transactions', $1) r`, [[TX_JED]]))[0].r;
    return (s[TX_JED] && s[TX_JED].declaration_notes === 'داخلي' && 'cancel_reason' in s[TX_JED] && 'cancelled_by' in s[TX_JED] && 'notes' in s[TX_JED]
      && J(d) === '{}' && J(c) === '{}' && J(b) === '{}') || J({ s, d, c, b });
  });
}

/* ================================================================== 7. declarations */
async function secDeclarations() {
  section('7. customs_declarations: Hijri date, type code, Fasah stages');
  const add = (who, tx, p) => as(who, `SELECT public.add_declaration($1, $2, $3) r`, [tx, p, newKey()]).then(r => r[0].r);
  const st = (who, id, s, note) => as(who, `SELECT public.set_declaration_status($1, $2, $3) r`, [id, s, note || null]).then(r => r[0].r);
  const corr = (who, id, p, why) => as(who, `SELECT public.correct_declaration($1, $2, $3) r`, [id, p, why]).then(r => r[0].r);
  await check('add_declaration: a Hijri date in Arabic digits d/m/yyyy → 1447/03/05; type استيراد → type code import; a Fasah stage as the first status', async () => {
    const r = await add('jed', TX_JED2, { declaration_no: 'lgc 0001', declaration_type: 'استيراد', declaration_date: '2026-09-01', declaration_date_hijri: '٥/٣/١٤٤٧', status: 'accepted' });
    X.d1 = r.id;
    return (r.declaration_date_hijri === '1447/03/05' && r.declaration_type_code === 'import' && r.status === 'accepted' && r.declaration_no === 'LGC0001') || J(r);
  });
  for (const [label, h] of [['month 13', '1447/13/01'], ['day 31', '1447/02/31'], ['year 1299', '1299/12/01'], ['a Gregorian date', '2026-11-10'], ['text', 'أمس']]) {
    await check('add_declaration refuses a bad Hijri date (' + label + ') → MRS_INVALID declaration_date_hijri', async () => {
      const g = await code(() => add('jed', X.t1, { declaration_no: 'LGC-BAD-' + label.length + h.length, declaration_date_hijri: h }));
      return g === 'MRS_INVALID declaration_date_hijri' || g;
    });
  }
  await check('add_declaration: an unknown status is still refused (MRS_INVALID status); cancelled is not a starting status', async () => {
    const a = await code(() => add('jed', X.t1, { declaration_no: 'LGC-ST1', status: 'paid' }));
    const b = await code(() => add('jed', X.t1, { declaration_no: 'LGC-ST2', status: 'cancelled' }));
    return (a === 'MRS_INVALID status' && b === 'MRS_INVALID status') || J({ a, b });
  });
  await check('the Fasah stages forward, one after the other, by clearance staff: accepted → under_inspection → cco_review_done → awaiting_duty_payment → release_ready → released', async () => {
    const seen = [];
    for (const s of ['under_inspection', 'cco_review_done', 'awaiting_duty_payment', 'release_ready', 'released']) seen.push((await st('jed', X.d1, s)).status + '<' + (await one(`SELECT 1 x`)).x);
    const ev = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'declaration' AND payload ->> 'op' = 'status'`, [TX_JED2]);
    return (seen.length === 5 && seen[4].startsWith('released') && ev === 5) || J({ seen, ev });
  });
  await check('backward (released → awaiting_duty_payment): no note → MRS_NOTE_REQUIRED; clearance staff with a note → MRS_FORBIDDEN; operations manager with a note → ok', async () => {
    const a = await code(() => st('jed', X.d1, 'awaiting_duty_payment'));
    const b = await code(() => st('jed', X.d1, 'awaiting_duty_payment', 'تصحيح'));
    const c = await st('opsm', X.d1, 'awaiting_duty_payment', 'تصحيح المرحلة');
    return (a === 'MRS_NOTE_REQUIRED' && b === 'MRS_FORBIDDEN role' && c.status === 'awaiting_duty_payment' && c.from === 'released') || J({ a, b, c });
  });
  await check('set_declaration_status: an unknown stage → MRS_INVALID status; cancelled → use cancel_declaration; same → same_status', async () => {
    const a = await code(() => st('jed', X.d1, 'paid'));
    const b = await code(() => st('jed', X.d1, 'cancelled'));
    const c = await code(() => st('jed', X.d1, 'awaiting_duty_payment'));
    return (a === 'MRS_INVALID status' && b === 'MRS_BAD_TRANSITION use_cancel_declaration' && c === 'MRS_BAD_TRANSITION same_status') || J({ a, b, c });
  });
  await check('correct_declaration: the Hijri date and the type change (تصفية → clearance); the event lists them; clearing the Hijri date with null', async () => {
    const r = await corr('jed', X.d1, { declaration_date_hijri: '1447-3-6', declaration_type: 'تصفية' }, 'تصحيح التاريخ');
    const e = await corr('jed', X.d1, { declaration_date_hijri: null }, 'حذف التاريخ');
    const bad = await code(() => corr('jed', X.d1, { declaration_date_hijri: '1447/3/40' }, 'x'));
    return (r.declaration_date_hijri === '1447/03/06' && r.declaration_type_code === 'clearance' && J(r.changed) === J(['declaration_date_hijri', 'declaration_type'])
      && e.declaration_date_hijri === null && bad === 'MRS_INVALID declaration_date_hijri') || J({ r, e, bad });
  });
  await check('the type code is derived on every write (owner writes too); an unknown type leaves it NULL; the seed declaration has none', async () => {
    await q(`UPDATE public.customs_declarations SET declaration_type = 'export' WHERE id = $1`, [X.d1]);
    const a = (await one(`SELECT declaration_type_code c FROM public.customs_declarations WHERE id = $1`, [X.d1])).c;
    await q(`UPDATE public.customs_declarations SET declaration_type = 'عبور' WHERE id = $1`, [X.d1]);
    const b = (await one(`SELECT declaration_type_code c FROM public.customs_declarations WHERE id = $1`, [X.d1])).c;
    const sd = await one(`SELECT declaration_type_code c FROM public.customs_declarations WHERE transaction_id = $1`, [TX_JED]);
    return (a === 'export' && b === null && sd && sd.c === null) || J({ a, b, sd });
  });
  await check('table CHECKs (owner writes): the trigger normalises a Hijri date; a bad one → MRS_INVALID; a bad status → CHECK; the type code is generated (never written)', async () => {
    await q(`UPDATE public.customs_declarations SET declaration_date_hijri = '1447.03.07' WHERE id = $1`, [X.d1]);
    const a = (await one(`SELECT declaration_date_hijri h FROM public.customs_declarations WHERE id = $1`, [X.d1])).h;
    const b = await code(() => q(`UPDATE public.customs_declarations SET declaration_date_hijri = '1447/15/07' WHERE id = $1`, [X.d1]));
    const c = await code(() => q(`UPDATE public.customs_declarations SET status = 'paid' WHERE id = $1`, [X.d1]));
    const e0 = await code(() => q(`UPDATE public.customs_declarations SET declaration_type_code = 'transit' WHERE id = $1`, [X.d1]));
    const e = /can only be updated to DEFAULT/.test(e0) ? 'generated' : e0;
    const f = await code(() => db.exec(`ALTER TABLE public.customs_declarations DISABLE TRIGGER trg_legacy_norm;
                                   UPDATE public.customs_declarations SET declaration_date_hijri = '1447/3/7' WHERE id = '${X.d1}'`));
    await q(`ALTER TABLE public.customs_declarations ENABLE TRIGGER trg_legacy_norm`);
    return (a === '1447/03/07' && b === 'MRS_INVALID declaration_date_hijri' && c === 'chk:customs_declarations_status_check'
      && e === 'generated' && /customs_declarations_hijri_chk/.test(f)) || J({ a, b, c, e, f });
  });
  await check('the client reads the Hijri date / type code of his own declaration; org B staff see nothing', async () => {
    await q(`UPDATE public.transactions SET client_id = $2 WHERE id = $1`, [TX_JED2, CLIENT_A]);
    const c = await as('portal', `SELECT declaration_date_hijri, declaration_type_code, status FROM public.customs_declarations WHERE id = $1`, [X.d1]);
    const b = await as('staffB', `SELECT 1 FROM public.customs_declarations WHERE id = $1`, [X.d1]);
    return (c.length === 1 && c[0].declaration_date_hijri === '1447/03/07' && b.length === 0) || J({ c, b });
  });
}

/* ================================================================== 8. clients + aliases */
async function secClients() {
  section('8. clients + client_aliases');
  await check('API insert: match statistics are reset (match_count 0, last_matched_at NULL), source forced to manual; category kept', async () => {
    const r = await as('jed', `INSERT INTO public.clients (org_id, client_type, name_ar, port_category, match_count, last_matched_at, source)
                                VALUES ($1, 'business', 'شركة المطابقة التجريبية', 'airport', 9, now(), 'import') RETURNING id`, [A]);
    X.c1 = r[0].id;
    const c = await one(`SELECT port_category, match_count, last_matched_at, source FROM public.clients WHERE id = $1`, [X.c1]);
    return (c.port_category === 'airport' && c.match_count === 0 && c.last_matched_at === null && c.source === 'manual') || J(c);
  });
  await check('review fix: API insert cannot forge provenance (daftra / legacy / portal → manual, staff and admin alike); the owner (import RPCs) may set it', async () => {
    const got = [];
    for (const [who, src] of [['jed', 'daftra'], ['opsm', 'legacy'], ['admin', 'portal']]) {
      const r = await as(who, `INSERT INTO public.clients (org_id, client_type, name_ar, source, match_count) VALUES ($1, 'business', $2, $3, 50) RETURNING id`,
        [A, 'عميل مصدر ' + src, src]);
      got.push((await one(`SELECT source, match_count FROM public.clients WHERE id = $1`, [r[0].id])));
    }
    const o = await one(`INSERT INTO public.clients (org_id, client_type, name_ar, source) VALUES ($1, 'business', 'عميل مستورد من دفترة', 'daftra') RETURNING source`, [A]);
    return (got.every(x => x.source === 'manual' && x.match_count === 0) && o.source === 'daftra') || J({ got, o });
  });
  await check('API update: port_category editable; match_count / last_matched_at / source immutable (MRS_IMMUTABLE)', async () => {
    const a = await as('jed', `UPDATE public.clients SET port_category = 'shared' WHERE id = $1 RETURNING id`, [X.c1]);
    const b = await code(() => as('jed', `UPDATE public.clients SET match_count = 3 WHERE id = $1`, [X.c1]));
    const c = await code(() => as('jed', `UPDATE public.clients SET last_matched_at = now() WHERE id = $1`, [X.c1]));
    const d = await code(() => as('jed', `UPDATE public.clients SET source = 'daftra' WHERE id = $1`, [X.c1]));
    return (a.length === 1 && b === 'MRS_IMMUTABLE match_count' && c === 'MRS_IMMUTABLE last_matched_at' && d === 'MRS_IMMUTABLE source') || J({ a, b, c, d });
  });
  for (const [label, set, want] of [['port category outside the domain', `port_category = 'sea'`, 'chk:clients_port_category_chk'],
    ['negative match count', `match_count = -1`, 'chk:clients_match_count_chk'], ['unknown source', `source = 'excel'`, 'chk:clients_source_chk']]) {
    await check('clients CHECK: ' + label + ' → ' + want, async () => { const g = await code(() => q(`UPDATE public.clients SET ${set} WHERE id = $1`, [X.c1])); return g === want || g; });
  }
  await check('the owner (matching RPCs later) may write the statistics; the client portal reads category / count of his own record', async () => {
    await q(`UPDATE public.clients SET match_count = 4, last_matched_at = now() WHERE id = $1`, [CLIENT_A]);
    const r = await as('portal', `SELECT port_category, match_count, last_matched_at, source FROM public.clients WHERE id = $1`, [CLIENT_A]);
    return (r.length === 1 && r[0].match_count === 4 && r[0].source === 'manual') || J(r);
  });
  const ins = (who, client, alias, status, extra) => as(who, `INSERT INTO public.client_aliases (org_id, client_id, alias, source, status, confidence, occurrences, last_used_at,
                                          approved_by, approved_at, source_ref) VALUES ($1, $2, $3, 'bl', $4, $5, 7, now(), $6, now(), $7) RETURNING id`,
    [A, client, alias, status, (extra || {}).confidence == null ? 90 : extra.confidence, U.opsm, (extra || {}).ref || ' BL-1 ']);
  await check('alias insert (API): approved → approved_by = the caller + approved_at; counters reset (occurrences 1, last_used_at NULL); source_ref trimmed', async () => {
    const r = await ins('jed', X.c1, 'Matching Test Trading', 'approved');
    X.al1 = r[0].id;
    const a = await one(`SELECT * FROM public.client_aliases WHERE id = $1`, [X.al1]);
    return (a.status === 'approved' && a.approved_by === U.jed && a.approved_at && a.occurrences === 1 && a.last_used_at === null && a.source_ref === 'BL-1'
      && a.confidence === 90) || J(a);
  });
  await check('alias insert (API): rejected / suggested carry no approver', async () => {
    const r = await ins('jed', CLIENT_A, 'Rejected Name Holdings', 'rejected');
    const s = await ins('jed', X.c1, 'Suggested Name Est', 'suggested');
    X.alR = r[0].id;
    const a = await q(`SELECT status, approved_by, approved_at FROM public.client_aliases WHERE id = ANY($1)`, [[r[0].id, s[0].id]]);
    return a.every(x => x.approved_by === null && x.approved_at === null) || J(a);
  });
  for (const [label, status, extra, want] of [['unknown status', 'pending', {}, 'chk:client_aliases_status_chk'],
    ['confidence 101', 'approved', { confidence: 101 }, 'chk:client_aliases_confidence_chk'], ['confidence -1', 'approved', { confidence: -1 }, 'chk:client_aliases_confidence_chk'],
    ['source_ref over 120', 'approved', { ref: 'x'.repeat(121) }, 'chk:client_aliases_source_ref_chk']]) {
    await check('client_aliases CHECK: ' + label + ' → ' + want, async () => {
      const g = await code(() => ins('jed', X.c1, 'Alias ' + label, status, extra));
      return g === want || g;
    });
  }
  await check('client_aliases occurrences ≥ 1 (owner write) → CHECK; staff still cannot UPDATE aliases (permission denied)', async () => {
    const a = await code(() => q(`INSERT INTO public.client_aliases (org_id, client_id, alias, occurrences) VALUES ($1, $2, 'Zero Occ Co', 0)`, [A, X.c1]));
    const b = await code(() => as('jed', `UPDATE public.client_aliases SET status = 'approved' WHERE id = $1`, [X.alR]));
    return (a === 'chk:client_aliases_occurrences_chk' && b === 'perm') || J({ a, b });
  });
  await check('existing aliases (before this file) count as approved: the column default', async () => {
    const d = await one(`SELECT column_default d FROM information_schema.columns WHERE table_name = 'client_aliases' AND column_name = 'status'`);
    return /'approved'/.test(d.d) || J(d);
  });
  await check('match_client: an approved alias matches (reason alias); a rejected alias is never used (no alias hit, no similarity)', async () => {
    const m = (await as('jed', `SELECT public.match_client($1, $2) r`, [A, { name_en: 'Matching Test Trading' }]))[0].r;
    const r = (await as('jed', `SELECT public.match_client($1, $2) r`, [A, { name_en: 'Rejected Name Holdings' }]))[0].r;
    const hitA = m.candidates.find(c => c.client_id === X.c1);
    const hitR = r.candidates.find(c => c.client_id === CLIENT_A);
    return (hitA && hitA.reasons.includes('alias') && hitA.match === 'alias' && !hitR) || J({ m: m.candidates.map(c => c.reasons), r: r.candidates });
  });
  await check('review fix: match_client — a suggested (unreviewed) alias is never an alias match: at most weak / similar_name, rank 1, no conflict', async () => {
    const m = (await as('jed', `SELECT public.match_client($1, $2) r`, [A, { name_en: 'Suggested Name Est' }]))[0].r;
    const hit = m.candidates.find(c => c.client_id === X.c1);
    return (hit && hit.match === 'weak' && hit.rank === 1 && !hit.reasons.includes('alias') && hit.reasons.includes('similar_name') && m.conflict === false)
      || J(m);
  });
  await check('review fix: match_client — the same alias once approved by staff is an alias match (rank 2)', async () => {
    await q(`UPDATE public.client_aliases SET status = 'approved', approved_by = $2, approved_at = now() WHERE client_id = $1 AND alias = 'Suggested Name Est'`, [X.c1, U.opsm]);
    const m = (await as('jed', `SELECT public.match_client($1, $2) r`, [A, { name_en: 'Suggested Name Est' }]))[0].r;
    const hit = m.candidates.find(c => c.client_id === X.c1);
    await q(`UPDATE public.client_aliases SET status = 'suggested', approved_by = NULL, approved_at = NULL WHERE client_id = $1 AND alias = 'Suggested Name Est'`, [X.c1]);
    return (hit && hit.match === 'alias' && hit.rank === 2 && hit.reasons.includes('alias')) || J(m.candidates);
  });
}

/* ================================================================== 9. finance + service catalog */
async function secFinance() {
  section('9. payment methods + per-org service catalog');
  await check('supplier_payments / charge_collections method CHECKs list the 10 codes = the fin_payment_method dictionary', async () => {
    const r = await q(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname IN ('supplier_payments_method_check','charge_collections_method_check')`);
    const codes = (await q(`SELECT code FROM public.status_labels WHERE domain = 'fin_payment_method'`)).map(x => x.code);
    return (r.length === 2 && r.every(x => codes.every(c => x.d.includes("'" + c + "'")) && !x.d.includes("'visa'")) && codes.length === 10) || J(r);
  });
  await check('the payment RPCs accept the new codes (app.is_code) and still refuse an unknown method', async () => {
    const a = (await one(`SELECT app.is_code('fin_payment_method', 'sadad') a, app.is_code('fin_payment_method', 'mada') b,
                                 app.is_code('fin_payment_method', 'dry_port_wallet') c, app.is_code('fin_payment_method', 'visa') d`));
    return (a.a && a.b && a.c && !a.d) || J(a);
  });
  await check('template: 26 items, distinct codes in legacy order, every fin_service a G4 service code, distinct legacy codes', async () => {
    const t = await q(`SELECT t.*, app.is_code('fin_service', t.fin_service) ok FROM app.service_items_template() t ORDER BY t.sort`);
    return (t.length === 26 && J(t.map(x => x.code)) === J(SERVICE_CODES) && t.every(x => x.ok && x.name_ar && x.name_en)
      && new Set(t.map(x => x.legacy_code)).size === 26 && t[3].legacy_code === '000189' && t[22].legacy_code === '10001') || J(t.filter(x => !x.ok));
  });
  await check('org A (seed) and org B (fixture) were seeded at creation: 26 template items each, active, source template', async () => {
    const r = await q(`SELECT org_id, count(*)::int n, bool_and(is_active AND source = 'template') ok FROM public.org_service_items GROUP BY 1 ORDER BY 1`);
    return (r.length === 2 && r.every(x => x.n === 26 && x.ok)) || J(r);
  });
  await check('a new org gets the catalog (trigger); app.seed_org_service_items is idempotent (returns 0) and never restores a deactivated / renamed item', async () => {
    const o = 'deca0000-0000-4000-8000-0000000000c0';
    await q(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ($1, 'legacy-org-c', 'مؤسسة ج', 'LGC')`, [o]);
    const n = await num(`SELECT count(*) n FROM public.org_service_items WHERE org_id = $1`, [o]);
    await q(`UPDATE public.org_service_items SET is_active = false, name_ar = 'تكلفة النقل (موقوف)' WHERE org_id = $1 AND code = 'transportation_cost'`, [o]);
    const again = (await one(`SELECT app.seed_org_service_items($1) n`, [o])).n;
    const row = await one(`SELECT is_active, name_ar FROM public.org_service_items WHERE org_id = $1 AND code = 'transportation_cost'`, [o]);
    const missing = await code(() => q(`SELECT app.seed_org_service_items('deca0000-0000-4000-8000-0000000000ff')`));
    await q(`UPDATE public.organizations SET environment = 'production' WHERE id = $1`, [o]);     // not a staging org for the conversion
    return (n === 26 && again === 0 && row.is_active === false && row.name_ar === 'تكلفة النقل (موقوف)' && missing === 'MRS_NOT_FOUND organization') || J({ n, again, row, missing });
  });
  await check('a deleted (missing) code is re-added by the seed: returns 1', async () => {
    await db.exec(`ALTER TABLE public.org_service_items DISABLE TRIGGER trg_audit; DELETE FROM public.org_service_items WHERE org_id = '${B}' AND code = 'late_fee';
             ALTER TABLE public.org_service_items ENABLE TRIGGER trg_audit`);
    const n = (await one(`SELECT app.seed_org_service_items($1) n`, [B])).n;
    return (n === 1 && (await num(`SELECT count(*) n FROM public.org_service_items WHERE org_id = $1`, [B])) === 26) || 'got ' + n;
  });
  await check('RLS read: org A staff (any role / branch) read 26 A items; org B staff only theirs; the client and a stranger none; anon permission denied', async () => {
    const n = async w => (await as(w, `SELECT count(*)::int n FROM public.org_service_items WHERE org_id = $1`, [A]))[0].n;
    const a = await n('dmm'), t = await n('trn'), b = await n('staffB'), c = await n('portal'), s = await n('stranger');
    const bb = (await as('staffB', `SELECT count(*)::int n FROM public.org_service_items`))[0].n;
    const an = await code(() => as('anon', `SELECT 1 FROM public.org_service_items`));
    return (a === 26 && t === 26 && b === 0 && bb === 26 && c === 0 && s === 0 && an === 'perm') || J({ a, t, b, bb, c, s, an });
  });
  await check('write: an accounts manager adds an item (source manual, created_by stamped, audited); the admin renames one', async () => {
    const r = await as('accm', `INSERT INTO public.org_service_items (org_id, code, name_ar, name_en, fin_service, sort, source, created_by)
                                 VALUES ($1, 'washing_fee', ' رسوم غسيل ', 'Washing fee', 'washing', 100, 'manual', $2) RETURNING id`, [A, U.admin]);
    const row = await one(`SELECT name_ar, created_by, source FROM public.org_service_items WHERE id = $1`, [r[0].id]);
    const au = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'org_service_items' AND row_id = $1`, [r[0].id]);
    const u = await as('admin', `UPDATE public.org_service_items SET name_en = 'Customs clearance' WHERE org_id = $1 AND code = 'customs_clearance' RETURNING id`, [A]);
    X.svc = r[0].id;
    return (row.name_ar === 'رسوم غسيل' && row.created_by === U.accm && row.source === 'manual' && au === 1 && u.length === 1) || J({ row, au, u });
  });
  for (const [label, who, sql, params, want] of [
    ['clearance staff cannot add', 'jed', `INSERT INTO public.org_service_items (org_id, code, name_ar) VALUES ($1, 'x_fee', 'رسم')`, [A], 'rls'],
    ['an accountant cannot add', 'acc', `INSERT INTO public.org_service_items (org_id, code, name_ar) VALUES ($1, 'x_fee', 'رسم')`, [A], 'rls'],
    ['org B admin cannot add to org A', 'staffB', `INSERT INTO public.org_service_items (org_id, code, name_ar) VALUES ($1, 'x_fee', 'رسم')`, [A], 'rls'],
    ['a duplicate code', 'accm', `INSERT INTO public.org_service_items (org_id, code, name_ar) VALUES ($1, 'late_fee', 'رسم')`, [A], 'uniq:org_service_items_code_uniq'],
    ['a bad code', 'accm', `INSERT INTO public.org_service_items (org_id, code, name_ar) VALUES ($1, 'Late Fee', 'رسم')`, [A], 'chk:org_service_items_code_check'],
    ['an unknown fin_service', 'accm', `INSERT INTO public.org_service_items (org_id, code, name_ar, fin_service) VALUES ($1, 'y_fee', 'رسم', 'bribe')`, [A], 'MRS_INVALID fin_service'],
    ['a non-numeric legacy code', 'accm', `INSERT INTO public.org_service_items (org_id, code, name_ar, legacy_code) VALUES ($1, 'z_fee', 'رسم', 'A1')`, [A], 'chk:org_service_items_legacy_code_check'],
    ['the code is immutable', 'accm', `UPDATE public.org_service_items SET code = 'late_fee_2' WHERE org_id = $1 AND code = 'late_fee'`, [A], 'MRS_IMMUTABLE code'],
    ['the legacy code is immutable', 'admin', `UPDATE public.org_service_items SET legacy_code = '1' WHERE org_id = $1 AND code = 'late_fee'`, [A], 'MRS_IMMUTABLE legacy_code'],
    ['no DELETE (deactivate)', 'admin', `DELETE FROM public.org_service_items WHERE org_id = $1 AND code = 'late_fee'`, [A], 'perm']]) {
    await check('service catalog refused: ' + label + ' → ' + want, async () => { const g = await code(() => as(who, sql, params)); return g === want || g; });
  }
  await check('clearance staff UPDATE touches no row (RLS); deactivating by the accounts manager works', async () => {
    const a = await as('jed', `UPDATE public.org_service_items SET is_active = false WHERE id = $1 RETURNING id`, [X.svc]);
    const b = await as('accm', `UPDATE public.org_service_items SET is_active = false WHERE id = $1 RETURNING is_active`, [X.svc]);
    return (a.length === 0 && b[0].is_active === false) || J({ a, b });
  });
}

/* ================================================================== 10. cancel_transaction */
async function secCancel() {
  section('10. cancel_transaction: permissions, refusals, effects, frozen row');
  const t = await mkTx();
  await check('who: anon → permission denied; a stranger / org B staff / the client / the DMM member → MRS_NOT_FOUND; an accountant → MRS_FORBIDDEN role; no session → MRS_AUTH_REQUIRED', async () => {
    const an = await code(() => as('anon', `SELECT public.cancel_transaction($1, 'x')`, [t]));
    const got = [];
    for (const w of ['stranger', 'staffB', 'portal', 'dmm', 'acc']) got.push(await code(() => cancel(w, t, 'سبب')));
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', false);`);
    const noSession = await code(() => q(`SELECT public.cancel_transaction($1, 'x')`, [t]));
    await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`);
    const svc = await code(() => as('service', `SELECT public.cancel_transaction($1, 'x')`, [t]));
    return (an === 'perm' && J(got) === J(['MRS_NOT_FOUND transaction', 'MRS_NOT_FOUND transaction', 'MRS_NOT_FOUND transaction', 'MRS_NOT_FOUND transaction',
      'MRS_FORBIDDEN role']) && noSession === 'MRS_AUTH_REQUIRED' && svc === 'perm') || J({ an, got, noSession, svc });
  });
  await check('an MFA-gated admin at aal1 → MRS_MFA_REQUIRED', async () => {
    const g = await code(() => cancel('admin', t, 'سبب', 'aal1'));
    return g === 'MRS_MFA_REQUIRED aal2' || g;
  });
  await check('the reason: missing / blank → MRS_NOTE_REQUIRED reason; over 500 → MRS_TOO_LONG reason; nothing changed', async () => {
    const a = await code(() => cancel('jed', t, null)), b = await code(() => cancel('jed', t, ' \u0007 ')), c = await code(() => cancel('jed', t, 'x'.repeat(501)));
    const row = await txRow(t);
    return (a === 'MRS_NOTE_REQUIRED reason' && b === 'MRS_NOTE_REQUIRED reason' && c === 'MRS_TOO_LONG reason' && row.cancelled_at === null && row.operational_status === 'new') || J({ a, b, c });
  });
  await check('success (JED clearance staff, stage new): → closed + cancelled_at / _by / reason; result {from new, to closed, event_id}', async () => {
    const r = await cancel('jed', t, '  أُلغيت بطلب العميل  ');
    const row = await txRow(t);
    X.ct = t; X.ctEv = r.event_id;
    return (r.to === 'closed' && r.from === 'new' && r.transaction_id === t && r.ref === row.ref && row.operational_status === 'closed' && row.cancelled_at
      && row.cancelled_by === U.jed && row.cancel_reason === 'أُلغيت بطلب العميل') || J({ r, row });
  });
  await check('trail: a client-visible status event (op cancelled, no free text) + an internal note event with the reason; audit_log row names the cancel columns', async () => {
    const ev = await q(`SELECT event_type, from_status, to_status, visible_to_client, note, payload, actor FROM public.transaction_events
                         WHERE transaction_id = $1 AND (id = $2 OR (payload ->> 'for_event')::bigint = $2) ORDER BY id`, [t, X.ctEv]);
    const au = await one(`SELECT changed_fields FROM public.audit_log WHERE table_name = 'transactions' AND row_id = $1 AND action = 'UPDATE' ORDER BY id DESC LIMIT 1`, [t]);
    return (ev.length === 2 && ev[0].event_type === 'operational_status' && ev[0].visible_to_client === true && ev[0].note === null && ev[0].to_status === 'closed'
      && ev[0].payload.op === 'cancelled' && ev[0].actor === U.jed && ev[1].event_type === 'note' && ev[1].visible_to_client === false
      && ev[1].note === 'أُلغيت بطلب العميل' && ['cancelled_at', 'cancelled_by', 'cancel_reason', 'operational_status'].every(f => au.changed_fields.includes(f))) || J({ ev, au });
  });
  await check('the client sees the closing status event but not the reason', async () => {
    await q(`UPDATE public.transactions SET client_id = client_id WHERE id = $1`, [TX_JED]);   // no-op on another row
    const r = await as('portal', `SELECT event_type, note FROM public.transaction_events WHERE transaction_id = $1 ORDER BY id`, [t]);
    return (r.some(x => x.event_type === 'operational_status') && !r.some(x => x.note && /أُلغيت/.test(x.note))) || J(r);
  });
  await check('a second cancel → MRS_BAD_TRANSITION already_cancelled', async () => {
    const g = await code(() => cancel('opsm', t, 'مرة أخرى'));
    return g === 'MRS_BAD_TRANSITION already_cancelled' || g;
  });
  await check('frozen: owner / staff updates and set_transaction_status (reopen by the admin) → MRS_BAD_TRANSITION cancelled; no-op writes pass', async () => {
    const a = await code(() => setTx(t, `notes = 'x'`));
    const b = await code(() => as('jed', `UPDATE public.transactions SET port_code = 'SAJED' WHERE id = $1`, [t]));
    const c = await code(() => as('admin', `SELECT public.set_transaction_status($1, 'new', 'إعادة فتح') r`, [t]));
    const d = await code(() => setTx(t, `operational_status = operational_status`));
    const e = await code(() => q(`UPDATE public.transactions SET cancelled_at = NULL, cancel_reason = NULL, operational_status = 'new' WHERE id = $1`, [t]));
    return (a === 'MRS_BAD_TRANSITION cancelled' && b === 'MRS_BAD_TRANSITION cancelled' && c === 'MRS_BAD_TRANSITION cancelled' && d === 'ok'
      && e === 'MRS_BAD_TRANSITION cancelled') || J({ a, b, c, d, e });
  });
  await check('frozen: a declaration cannot be added to a cancelled transaction (the mirror write is refused)', async () => {
    const g = await code(() => as('jed', `SELECT public.add_declaration($1, $2, $3)`, [t, { declaration_no: 'LGC-CXL-1' }, newKey()]));
    return g === 'MRS_BAD_TRANSITION cancelled' || g;
  });
  // refusals by state
  const refusals = [
    ['closed (without a cancel)', async x => setTx(x, `operational_status = 'closed'`), 'jed', 'MRS_BAD_TRANSITION closed'],
    ['under billing', async x => setTx(x, `operational_status = 'under_billing'`), 'opsm', 'MRS_BAD_TRANSITION billed'],
    ['billed', async x => setTx(x, `operational_status = 'billed'`), 'opsm', 'MRS_BAD_TRANSITION billed'],
    ['financial status invoiced', async x => setTx(x, `financial_status = 'invoiced'`), 'opsm', 'MRS_BAD_TRANSITION billed'],
    ['financial status settled', async x => setTx(x, `financial_status = 'settled'`), 'opsm', 'MRS_BAD_TRANSITION billed'],
    ['past the declaration stage, clearance staff', async x => setTx(x, `operational_status = 'transport'`), 'jed', 'MRS_FORBIDDEN role'],
    ['an open billing intent (a Daftra draft may exist)', async x => q(`INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose_key, operational_ref)
                                                   VALUES ($1, $2, $3, 'F', 'LGC-' || $4 || '/F')`, [A, x, CLIENT_A, x.slice(-6)]), 'opsm', 'MRS_BAD_TRANSITION billing_intent'],
    ['an invoiced client charge', async x => q(`INSERT INTO public.client_charges (org_id, transaction_id, kind, description, unit_price, net_amount, total_amount, status)
                                                VALUES ($1, $2, 'service', 'تخليص', 100, 100, 100, 'invoiced')`, [A, x]), 'opsm', 'MRS_BAD_TRANSITION invoiced_charge'],
    ['an open (requested) appointment', async x => q(`INSERT INTO public.port_appointments (org_id, transaction_id, appointment_at) VALUES ($1, $2, now() + interval '1 day')`, [A, x]),
      'opsm', 'MRS_BAD_TRANSITION open_appointments'],
    ['a confirmed appointment', async x => q(`INSERT INTO public.port_appointments (org_id, transaction_id, appointment_at, status) VALUES ($1, $2, now(), 'confirmed')`, [A, x]),
      'opsm', 'MRS_BAD_TRANSITION open_appointments'],
    ['a planned trip', async x => q(`INSERT INTO public.transport_trips (org_id, transaction_id) VALUES ($1, $2)`, [A, x]), 'opsm', 'MRS_BAD_TRANSITION open_trips'],
    ['a loaded trip', async x => q(`INSERT INTO public.transport_trips (org_id, transaction_id, status) VALUES ($1, $2, 'loaded')`, [A, x]), 'opsm', 'MRS_BAD_TRANSITION open_trips'],
    // review fixes
    ['financial status draft_pending (a Daftra draft may exist outside Marsa)', async x => setTx(x, `financial_status = 'draft_pending'`), 'opsm', 'MRS_BAD_TRANSITION billed'],
    ['a draft client charge (it could never be voided nor billed afterwards)', async x => q(`INSERT INTO public.client_charges (org_id, transaction_id, kind, description, unit_price, net_amount, total_amount)
                                                            VALUES ($1, $2, 'service', 'تخليص', 100, 100, 100)`, [A, x]), 'opsm', 'MRS_BAD_TRANSITION open_charges'],
    ['an approved client charge', async x => q(`INSERT INTO public.client_charges (org_id, transaction_id, kind, description, unit_price, net_amount, total_amount, status)
                                                VALUES ($1, $2, 'service', 'تخليص', 100, 100, 100, 'approved')`, [A, x]), 'opsm', 'MRS_BAD_TRANSITION open_charges'],
    ['an open operational exception', async x => q(`INSERT INTO public.operational_exceptions (org_id, transaction_id, kind, source, reason)
                                                    VALUES ($1, $2, 'other', 'manual', 'x')`, [A, x]), 'opsm', 'MRS_BAD_TRANSITION open_exceptions'],
    ['an open demurrage case', async x => q(`INSERT INTO public.demurrage_cases (org_id, transaction_id, kind) VALUES ($1, $2, 'demurrage')`, [A, x]),
      'opsm', 'MRS_BAD_TRANSITION open_demurrage'],
    ['a container with a return deadline, not returned', async x => q(`INSERT INTO public.containers (org_id, transaction_id, container_no, return_deadline)
                                                    VALUES ($1, $2, 'LGCU0000011', current_date + 5)`, [A, x]), 'opsm', 'MRS_BAD_TRANSITION open_returns'],
    ['a container that left the port, not returned', async x => q(`INSERT INTO public.containers (org_id, transaction_id, container_no, gate_out_at)
                                                    VALUES ($1, $2, 'LGCU0000012', now())`, [A, x]), 'opsm', 'MRS_BAD_TRANSITION open_returns']];
  for (const [label, prep, who, want] of refusals) {
    await check('refused: ' + label + ' → ' + want + ' (nothing changed)', async () => {
      const x = await mkTx();
      await prep(x);
      const before = await txRow(x);
      const g = await code(() => cancel(who, x, 'سبب الإلغاء'));
      const after = await txRow(x);
      return (g === want && after.cancelled_at === null && after.operational_status === before.operational_status) || J({ g, st: after.operational_status });
    });
  }
  const allowed = [
    ['a cancelled billing intent', async x => q(`INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose_key, operational_ref, status, cancelled_at, cancel_reason)
                                                 VALUES ($1, $2, $3, 'F', 'LGC-' || $4 || '/F', 'cancelled', now(), 'x')`, [A, x, CLIENT_A, x.slice(-6)]), 'jed'],
    ['a void client charge', async x => q(`INSERT INTO public.client_charges (org_id, transaction_id, kind, description, unit_price, net_amount, total_amount, status, void_reason)
                                            VALUES ($1, $2, 'service', 'تخليص', 100, 100, 100, 'void', 'x')`, [A, x]), 'jed'],
    ['a container still in the port (no gate-out, no deadline)', async x => q(`INSERT INTO public.containers (org_id, transaction_id, container_no)
                                            VALUES ($1, $2, 'LGCU0000013')`, [A, x]), 'jed'],
    ['a resolved exception and a closed demurrage case', async x => {
      await q(`INSERT INTO public.operational_exceptions (org_id, transaction_id, kind, source, reason, status, resolved_at, resolution_note)
               VALUES ($1, $2, 'other', 'manual', 'x', 'resolved', now(), 'x')`, [A, x]);
      await q(`INSERT INTO public.demurrage_cases (org_id, transaction_id, kind, status) VALUES ($1, $2, 'demurrage', 'closed')`, [A, x]);
    }, 'jed'],
    ['cancelled / completed appointments', async x => q(`INSERT INTO public.port_appointments (org_id, transaction_id, appointment_at, status, status_reason) VALUES
                                                         ($1, $2, now(), 'cancelled', 'x'), ($1, $2, now(), 'completed', NULL)`, [A, x]), 'jed'],
    ['delivered / cancelled trips', async x => q(`INSERT INTO public.transport_trips (org_id, transaction_id, status, status_reason) VALUES
                                                  ($1, $2, 'delivered', NULL), ($1, $2, 'cancelled', 'x')`, [A, x]), 'jed'],
    ['past the declaration stage by an operations manager', async x => setTx(x, `operational_status = 'transport'`), 'opsm'],
    ['the declaration stage by clearance staff', async x => setTx(x, `operational_status = 'customs_declaration'`), 'jed'],
    ['a Ro-Ro transaction', async x => setTx(x, `cargo_unit_type = 'roro', chassis_no = 'VIN0000001'`), 'jed']];
  for (const [label, prep, who] of allowed) {
    await check('allowed: ' + label + ' → cancelled', async () => {
      const x = await mkTx();
      await prep(x);
      const r = await code(() => cancel(who, x, 'سبب'));
      const after = await txRow(x);
      return (r === 'ok' && after.cancelled_at && after.operational_status === 'closed') || J({ r, st: after.operational_status });
    });
  }
  await check('a cancelled transaction frees its TASTO order number for another transaction of the org', async () => {
    const x = await mkTx({ cols: { transport_mode: 'carrier_order', transport_order_no: 'TASTO9001' } });
    const y = await mkTx();
    const before = await code(() => setTx(y, `transport_mode = 'carrier_order', transport_order_no = 'TASTO9001'`));
    await cancel('jed', x, 'نقل الأمر');
    const after = await code(() => setTx(y, `transport_mode = 'carrier_order', transport_order_no = 'TASTO9001'`));
    return (before === 'uniq:transactions_transport_order_uidx' && after === 'ok') || J({ before, after });
  });
  await check('a DMM transaction: the DMM member may cancel it, the JED member may not see it', async () => {
    const x = await mkTx({ branch: DMM });
    const a = await code(() => cancel('jed', x, 'سبب'));
    const b = await code(() => cancel('dmm', x, 'سبب'));
    return (a === 'MRS_NOT_FOUND transaction' && b === 'ok') || J({ a, b });
  });
  // ---- review fixes: nothing can be billed / charged / changed on a cancelled transaction
  await check('review fix: approved charge → cancel refused; once voided → cancelled; then create_billing_intent / create_client_charge / create_demurrage_case → MRS_BAD_TRANSITION cancelled (no intent row)', async () => {
    const x = await mkTx();
    const ch = await one(`INSERT INTO public.client_charges (org_id, transaction_id, kind, description, unit_price, net_amount, total_amount, status)
                          VALUES ($1, $2, 'service', 'تخليص', 100, 100, 100, 'approved') RETURNING id`, [A, x]);
    const a = await code(() => cancel('opsm', x, 'سبب'));
    await q(`UPDATE public.client_charges SET status = 'void', void_reason = 'إلغاء المعاملة' WHERE id = $1`, [ch.id]);
    const b = await code(() => cancel('opsm', x, 'سبب'));
    const c = await code(() => as('accm', `SELECT public.create_billing_intent($1, $2)`, [{ transaction_id: x }, newKey()]));
    const d = await code(() => as('accm', `SELECT public.create_client_charge($1, $2)`, [{ transaction_id: x, kind: 'service', description: 'رسوم', unit_price: 50 }, newKey()]));
    const e = await code(() => as('accm', `SELECT public.create_demurrage_case($1, $2)`, [{ transaction_id: x, kind: 'storage' }, newKey()]));
    const n = await num(`SELECT count(*) n FROM public.billing_intents WHERE transaction_id = $1`, [x]);
    return (a === 'MRS_BAD_TRANSITION open_charges' && b === 'ok' && c === 'MRS_BAD_TRANSITION cancelled' && d === 'MRS_BAD_TRANSITION cancelled'
      && e === 'MRS_BAD_TRANSITION cancelled' && n === 0) || J({ a, b, c, d, e, n });
  });
  await check('review fix: cancel takes the active declaration with it (status cancelled, same reason, internal event, no exception); the mirror is cleared', async () => {
    const x = await mkTx();
    const d = (await as('jed', `SELECT public.add_declaration($1, $2, $3) r`, [x, { declaration_no: 'DUP555', status: 'accepted' }, newKey()]))[0].r;
    const r = await cancel('jed', x, 'أُدخلت بالخطأ');
    const dr = await one(`SELECT status, cancel_reason, cancelled_at FROM public.customs_declarations WHERE id = $1`, [d.id]);
    const t = await txRow(x);
    const ev = await one(`SELECT visible_to_client v, from_status f, payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'declaration' AND payload ->> 'op' = 'cancelled'`, [x]);
    const ex = await num(`SELECT count(*) n FROM public.operational_exceptions WHERE transaction_id = $1`, [x]);
    X.dupTx = x; X.dupDecl = d.id;
    return (r.declarations_cancelled === 1 && dr.status === 'cancelled' && dr.cancel_reason === 'أُدخلت بالخطأ' && dr.cancelled_at && t.declaration_no === null
      && t.cancelled_at && ev && ev.v === false && ev.f === 'accepted' && ev.payload.with_transaction === true && ex === 0) || J({ r, dr, t: t.declaration_no, ev, ex });
  });
  await check('review fix: the declaration number of a cancelled transaction is free for a corrected re-entry on a new transaction', async () => {
    const y = await mkTx();
    const g = await code(() => as('jed', `SELECT public.add_declaration($1, $2, $3)`, [y, { declaration_no: 'DUP555' }, newKey()]));
    const t = await txRow(y);
    return (g === 'ok' && t.declaration_no === 'DUP555') || J({ g, no: t.declaration_no });
  });
  await check('review fix: the G3 rule stays for a live transaction — a number cancelled there is still not reusable elsewhere', async () => {
    const x = await mkTx(), y = await mkTx();
    const d = (await as('jed', `SELECT public.add_declaration($1, $2, $3) r`, [x, { declaration_no: 'KEEP777' }, newKey()]))[0].r;
    await as('jed', `SELECT public.cancel_declaration($1, 'خطأ')`, [d.id]);
    const g = await code(() => as('jed', `SELECT public.add_declaration($1, $2, $3)`, [y, { declaration_no: 'KEEP777' }, newKey()]));
    return g === 'MRS_INVALID declaration_no_cancelled' || g;
  });
  await check('review fix: frozen children — set_declaration_status / correct_declaration / cancel_declaration on a cancelled transaction → MRS_BAD_TRANSITION cancelled, nothing changed', async () => {
    const before = await one(`SELECT status, declaration_no, updated_at FROM public.customs_declarations WHERE id = $1`, [X.dupDecl]);
    const a = await code(() => as('opsm', `SELECT public.set_declaration_status($1, 'released')`, [X.dupDecl]));
    const b = await code(() => as('opsm', `SELECT public.correct_declaration($1, $2, 'fix')`, [X.dupDecl, { declaration_no: 'DUP654321' }]));
    const c = await code(() => as('opsm', `SELECT public.cancel_declaration($1, 'x')`, [X.dupDecl]));
    const after = await one(`SELECT status, declaration_no, updated_at FROM public.customs_declarations WHERE id = $1`, [X.dupDecl]);
    return (a === 'MRS_BAD_TRANSITION cancelled' && b === 'MRS_BAD_TRANSITION cancelled' && c === 'MRS_BAD_TRANSITION cancelled' && J(before) === J(after)) || J({ a, b, c, before, after });
  });
  await check('review fix: other child RPCs (appointment, trip, exception) refuse a cancelled transaction', async () => {
    const x = X.dupTx;
    const got = [
      await code(() => as('opsm', `SELECT public.create_appointment($1, $2)`, [{ transaction_id: x, appointment_at: new Date(Date.now() + 864e5).toISOString() }, newKey()])),
      await code(() => as('opsm', `SELECT public.create_trip($1, $2)`, [{ transaction_id: x }, newKey()])),
      await code(() => as('opsm', `SELECT public.create_exception($1, $2)`, [{ transaction_id: x, kind: 'other', reason: 'x' }, newKey()]))];
    return got.every(g => g === 'MRS_BAD_TRANSITION cancelled') || J(got);
  });
  await check('review fix: dash_management — a cancel is not counted as closed; it has its own count; a normal close still counts', async () => {
    const x = await mkTx();
    await cancel('opsm', x, 'سبب');
    const r = (await as('admin', `SELECT public.dash_management($1, '{}'::jsonb) r`, [A]))[0].r;
    const cx = await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1 AND cancelled_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'`, [A]);
    const closedEv = await num(`SELECT count(DISTINCT e.transaction_id) n FROM public.transaction_events e WHERE e.org_id = $1 AND e.event_type = 'operational_status'
                                  AND e.to_status = 'closed' AND e.payload ->> 'op' IS DISTINCT FROM 'cancelled'`, [A]);
    return (Number(r.transactions.cancelled) === cx && cx >= 1 && Number(r.transactions.closed) === closedEv) || J({ t: r.transactions, cx, closedEv });
  });
  await check('review fix: report rows carry cancelled_at (a cancelled transaction is told apart from a closed one)', async () => {
    const r = (await one(`SELECT app.rpt_tx_json($1, '{}'::jsonb, true) j`, [X.dupTx])).j;
    return (r.cancelled_at && r.operational_status === 'closed') || J(r);
  });
  await check('review fix: alerts — a cancelled transaction raises none; a declaration stalled in a new Fasah stage (accepted / awaiting_duty_payment) is flagged', async () => {
    const x = await mkTx();
    const d = (await as('jed', `SELECT public.add_declaration($1, $2, $3) r`, [x, { declaration_no: 'STALL1', status: 'awaiting_duty_payment' }, newKey()]))[0].r;
    const later = new Date(Date.now() + 5 * 864e5).toISOString();
    const c1 = (await q(`SELECT dedupe_key FROM app.alert_causes($1, $2::timestamptz) WHERE subject_id = $3`, [A, later, d.id])).map(r => r.dedupe_key);
    const c2 = (await q(`SELECT count(*)::int n FROM app.alert_causes($1, $2::timestamptz) c JOIN public.transactions t ON t.id = c.transaction_id
                         WHERE t.cancelled_at IS NOT NULL`, [A, later]))[0].n;
    return (J(c1) === J(['declaration_stalled:' + d.id + ':awaiting_duty_payment']) && c2 === 0) || J({ c1, c2 });
  });
}

/* ================================================================== 11. grants */
async function secGrants() {
  section('11. grants: tables, RLS, functions');
  await check('RLS enabled on the 3 new tables; customs_ports: SELECT only for authenticated, nothing for anon', async () => {
    const r = await q(`SELECT relname, relrowsecurity r FROM pg_class WHERE oid IN ('public.customs_ports'::regclass, 'public.party_ports'::regclass, 'public.org_service_items'::regclass)`);
    const g = await one(`SELECT has_table_privilege('authenticated', 'public.customs_ports', 'SELECT') s, has_table_privilege('authenticated', 'public.customs_ports', 'INSERT') i,
                                has_table_privilege('authenticated', 'public.customs_ports', 'UPDATE') u, has_table_privilege('authenticated', 'public.customs_ports', 'DELETE') d,
                                has_table_privilege('anon', 'public.customs_ports', 'SELECT') a`);
    return (r.length === 3 && r.every(x => x.r) && g.s && !g.i && !g.u && !g.d && !g.a) || J({ r, g });
  });
  await check('party_ports / org_service_items: authenticated SELECT / INSERT / UPDATE, never DELETE / TRUNCATE; anon nothing', async () => {
    const r = await q(`SELECT t, has_table_privilege('authenticated', t, 'SELECT') s, has_table_privilege('authenticated', t, 'INSERT') i,
                              has_table_privilege('authenticated', t, 'UPDATE') u, has_table_privilege('authenticated', t, 'DELETE') d,
                              has_table_privilege('authenticated', t, 'TRUNCATE') tr, has_table_privilege('anon', t, 'SELECT') a
                         FROM unnest(ARRAY['public.party_ports','public.org_service_items']) t`);
    return r.every(x => x.s && x.i && x.u && !x.d && !x.tr && !x.a) || J(r);
  });
  await check('cancel_transaction: authenticated only (not anon, not service_role); the seed + definer triggers: nobody', async () => {
    const r = await one(`SELECT has_function_privilege('authenticated', 'public.cancel_transaction(uuid, text)', 'EXECUTE') a,
                                has_function_privilege('anon', 'public.cancel_transaction(uuid, text)', 'EXECUTE') n,
                                has_function_privilege('service_role', 'public.cancel_transaction(uuid, text)', 'EXECUTE') s`);
    const closed = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('service_role', p.oid, 'EXECUTE') s
                              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'
                               AND p.proname IN ('seed_org_service_items','tg_transactions_legacy_norm','tg_containers_legacy_roro','tg_declarations_legacy_norm',
                                                 'tg_party_ports_before','tg_org_service_items_before','tg_organizations_seed_service_items')`);
    return (r.a && !r.n && !r.s && closed.length === 7 && closed.every(x => !x.a && !x.s)) || J({ r, closed });
  });
  await check('the pure normalisers: authenticated and service_role may call them, anon may not; fin_funding_check closed (G4 rule)', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('service_role', p.oid, 'EXECUTE') s,
                              has_function_privilege('anon', p.oid, 'EXECUTE') n
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'
                          AND p.proname IN ('legacy_spaces','legacy_search_key','norm_declaration_status','norm_declaration_type','norm_tas','norm_sa_phone','norm_chassis',
                                            'norm_hijri_date','service_items_template','fin_funding_check')`);
    const open = r.filter(x => x.proname !== 'fin_funding_check'), fin = r.find(x => x.proname === 'fin_funding_check');
    return (open.length === 9 && r.filter(x => x.proname === 'fin_funding_check').length === 1 && open.every(x => x.a && x.s && !x.n) && fin && !fin.a && !fin.s && !fin.n) || J(r);
  });
  await check('a signed-in staff member can call a helper (no data access); the seed function is refused (permission denied)', async () => {
    const a = (await as('jed', `SELECT app.norm_tas('TAS12345678') v`))[0].v;
    const b = await code(() => as('admin', `SELECT app.seed_org_service_items($1)`, [A]));
    return (a === 'TAS12345678' && b === 'perm') || J({ a, b });
  });
  await check('no volatile SECURITY DEFINER app function of this file is executable by authenticated', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND p.prosecdef AND p.provolatile = 'v' AND p.proname <> 'next_ref_checked'
                          AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`);
    return r.length === 0 || r.map(x => x.proname).join(', ');
  });
}

/* ================================================================== 12. conversion (last: changes the deployment) */
async function secConvert() {
  section('12. convert_org_to_production: party_ports deleted with the parties, the service catalog kept');
  await check('conversion lists: party_ports right after parties (deleted); org_service_items kept; customs_ports has no org (not listed)', async () => {
    const t = (await one(`SELECT app.convert_delete_tables() t`)).t, k = (await one(`SELECT app.convert_keep_tables() k`)).k;
    return (t.indexOf('public.party_ports') === t.indexOf('public.parties') + 1 && t.length === 71 /* + 5 legacy docs tables (20261119000100) + 3 legacy decl tables (20261120000100) */ && k.includes('public.org_service_items') && k.length === 21
      && !t.includes('public.customs_ports') && !k.includes('public.customs_ports')) || J({ t: t.length, k: k.length });
  });
  await check('convert_check: every org-scoped table classified, no unexpected delete guard', async () => {
    const c = (await one(`SELECT app.convert_check($1) c`, [A])).c;
    return !c.some(x => /unclassified_tables|unexpected_delete_guards/.test(x)) || J(c);
  });
  await q(`INSERT INTO public.platform_admins (user_id, note) VALUES ($1, 'owner') ON CONFLICT DO NOTHING`, [U.admin]);
  await q(`UPDATE public.organizations SET environment = 'production' WHERE id = $1`, [B]);
  const nPP = await num(`SELECT count(*) n FROM public.party_ports WHERE org_id = $1`, [A]);
  const nSvc = await num(`SELECT count(*) n FROM public.org_service_items WHERE org_id = $1`, [A]);
  const block = (await one(`SELECT app.convert_check($1) c`, [A])).c;
  let r = null, err = 'ok';
  if (block.length === 0) {
    try { r = (await one(`SELECT public.convert_org_to_production($1, 'marsa-legacy', 'مرسى للتخليص', 'Marsa Clearance', 'DELETE-TEST-DATA-marsa-legacy') r`, [A])).r; }
    catch (e) { err = errText(e); }
  } else err = 'blocked: ' + J(block);
  await check('the conversion runs; its summary counts the deleted party_ports', () =>
    (r && r.deleted && r.deleted.party_ports === nPP && nPP >= 3) || J({ err, pp: r && r.deleted && r.deleted.party_ports, nPP }));
  await check('after: no party_ports / cancelled transaction of the org left; the service catalog and the ports kept; org B untouched', async () => {
    const pp = await num(`SELECT count(*) n FROM public.party_ports WHERE org_id = $1`, [A]);
    const tx = await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [A]);
    const svc = await num(`SELECT count(*) n FROM public.org_service_items WHERE org_id = $1`, [A]);
    const ports = await num(`SELECT count(*) n FROM public.customs_ports`);
    const b = await num(`SELECT count(*) n FROM public.org_service_items WHERE org_id = $1`, [B]);
    return (pp === 0 && tx === 0 && svc === nSvc && svc >= 27 && ports === 7 && b === 26) || J({ pp, tx, svc, ports, b });
  });
}

/* ================================================================== main */
(async () => {
  console.log('Marsa — legacy core (step 1) SQL tests (PGlite; local only)');
  await secFile();
  await secPreflight();

  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  if (!QUIET) console.log('  loaded');

  await secLabels();
  await secHelpers();
  await secPorts();
  await secTransactions();
  await secDeclarations();
  await secClients();
  await secFinance();
  await secCancel();
  await secGrants();
  await secConvert();
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
