#!/usr/bin/env node
/*
  Marsa (مرسى) — empty-container return deadline → extension request to the shipping agent:
  migration 20261128000100_return_extension.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).
  Invented data only.

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal).

  Covers: file conventions + all_migrations.sql + docs; preflight, re-run on itself (identical catalog), catalog delta,
  alert_causes = the 20261125000100 body except the empty-return branch; the rules (defaults 3 / 7, owner + reason, range,
  unknown key, stored garbage ignored); the alerts (fires exactly lead_days before the deadline on the Riyadh day — the
  midnight edge at UTC+3, not at lead+1, overdue critical, the title follows the request state, resolved after the deadline
  moves, the no-deadline alert); prepare (default containers, agent from the B/L, several agents → MRS_REQUIRED bl_id, explicit
  agent, returned / waived / foreign container → MRS_INVALID, no deadline → MRS_REQUIRED, missing e-mail, the exception
  in_progress, replay / conflict, one active request per agent / container); the text (placeholders, AR + EN, the org template,
  unknown placeholder refused); the transitions (update re-renders unless edited, mark sent needs to_address, decide approved
  moves the deadlines and skips returned / waived ones, never earlier, partial subset, rejected keeps the deadline, draft needs a
  note, thread of another transaction refused, cancel resolves the exception, final rows immutable); RLS / privileges (client,
  other branch, accountant read-only, other org, anon, no direct writes); events (internal, payload without the text); no
  message / outbound / SMTP row; supa.js wrappers in a vm + the error messages.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/return-extension-sql-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261128000100_return_extension.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in return-extension-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'd7b00000-0000-4000-8000-0000000000b0';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const BR_B = 'd7b00000-0000-4000-8000-0000000000b1';
const CL_B = 'd7b00000-0000-4000-8000-0000000000b3';
const U = {
  admin: 'd7b10000-0000-4000-8000-000000000001',
  acc: 'd7b10000-0000-4000-8000-000000000002',      // accountant (staff, not a transport writer)
  jed: 'd7b10000-0000-4000-8000-000000000005',      // clearance_staff, JED
  dmm: 'd7b10000-0000-4000-8000-000000000006',      // clearance_staff, DMM
  portal: 'd7b10000-0000-4000-8000-000000000008',   // client user of CLIENT_A
  staffB: 'd7b10000-0000-4000-8000-00000000000a',   // admin of B
  admJed: 'd7b10000-0000-4000-8000-00000000000b'    // branch_manager of A, JED (not the org owner)
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
async function code(fn) {
  try { await fn(); return 'ok'; } catch (e) {
    const m = e.message || '';
    if (/^MRS_/.test(m)) return m + (e.detail ? ' ' + e.detail : '');
    let x = m.match(/violates check constraint "([^"]+)"/); if (x) return 'chk:' + x[1];
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
const newKey = () => 'd7b2aaab-0000-4000-8000-' + String(++keySeq).padStart(12, '0');
function iso(prefix4, six) {
  const v = prefix4 + six;
  const L = [10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38];
  let s = 0;
  for (let i = 0; i < 10; i++) { const c = v[i]; const n = /[0-9]/.test(c) ? +c : L[c.charCodeAt(0) - 65]; s += n * (1 << i); }
  return v + String((s % 11) % 10);
}
let ctrSeq = 0, blSeq = 0, agSeq = 0;
const nextCtr = () => iso('RXTU', String(400000 + (++ctrSeq)));
const nextBl = () => 'RXBL' + String(8000000 + (++blSeq));
const TODAY = `(now() AT TIME ZONE 'Asia/Riyadh')::date`;

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
  const labels = (await q(`SELECT domain || '.' || code || ':' || sort || ':' || label_ar || ':' || client_visible x FROM public.status_labels ORDER BY 1`)).map(x => x.x);
  return { fns, tables, idx, trg, pol, con, cols, labels };
}
const NEW_FNS = ['app.empty_return_rules', 'app.empty_return_rules_check', 'app.empty_return_rules_defaults', 'app.rx_builtin_template',
  'app.rx_close_exception', 'app.rx_email', 'app.rx_event', 'app.rx_json', 'app.rx_lock', 'app.rx_period', 'app.rx_pick_containers',
  'app.rx_placeholders', 'app.rx_placeholders_check', 'app.rx_render', 'app.rx_template', 'app.rx_text', 'app.rx_uuid_list', 'app.rx_vars',
  'app.tg_return_extension_guard', 'public.cancel_return_extension', 'public.decide_return_extension', 'public.get_empty_return_rules',
  'public.list_return_extensions', 'public.mark_return_extension_sent', 'public.prepare_return_extension', 'public.set_empty_return_rules',
  'public.set_return_extension_template', 'public.update_return_extension'];
const RECREATED = ['app.alert_causes', 'app.convert_delete_tables'];
const RPCS = ['prepare_return_extension', 'update_return_extension', 'mark_return_extension_sent', 'decide_return_extension',
  'cancel_return_extension', 'list_return_extensions', 'get_empty_return_rules', 'set_empty_return_rules', 'set_return_extension_template'];
const CODES = ['MRS_RX_EXISTS'];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@rx.example.com', now()), ('${U.acc}', 'acc@rx.example.com', now()),
    ('${U.jed}', 'jed@rx.example.com', now()), ('${U.dmm}', 'dmm@rx.example.com', now()),
    ('${U.portal}', 'portal@rx.example.com', now()), ('${U.staffB}', 'staffb@rx.example.com', now()), ('${U.admJed}', 'admjed@rx.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'المالك'), ('${U.acc}', 'acc'), ('${U.jed}', 'موظف جدة'),
    ('${U.dmm}', 'dmm'), ('${U.portal}', 'portal'), ('${U.staffB}', 'staffB'), ('${U.admJed}', 'admJed')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'rx-org-b', 'مؤسسة ب', 'Rx org B', 'RXB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', 'Client B Co', '0509990000');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.acc}', '${A}', NULL, 'accountant'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff'),
    ('${U.staffB}', '${B}', NULL, 'admin'), ('${U.admJed}', '${A}', '${JED}', 'branch_manager');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
const prepare = (who, tx, p) => rpc(who || 'jed', `SELECT public.prepare_return_extension($1, $2) r`, [tx, p || {}]);
const update = (who, id, p) => rpc(who || 'jed', `SELECT public.update_return_extension($1, $2) r`, [id, p || {}]);
const markSent = (who, id, note) => rpc(who || 'jed', `SELECT public.mark_return_extension_sent($1, $2) r`, [id, note == null ? null : note]);
const decide = (who, id, p) => rpc(who || 'jed', `SELECT public.decide_return_extension($1, $2) r`, [id, p || {}]);
const cancel = (who, id, reason) => rpc(who || 'jed', `SELECT public.cancel_return_extension($1, $2) r`, [id, reason]);
const list = (who, org, f) => rpc(who || 'jed', `SELECT public.list_return_extensions($1, $2) r`, [org || A, f || {}]);
const getRules = (who, org) => rpc(who || 'jed', `SELECT public.get_empty_return_rules($1) r`, [org || A]);
const setRules = (who, rules, reason, org) => rpc(who || 'admin', `SELECT public.set_empty_return_rules($1, $2, $3) r`, [org || A, rules, reason]);
const setTpl = (who, tpl, reason, org) => rpc(who || 'admin', `SELECT public.set_return_extension_template($1, $2, $3) r`, [org || A, tpl, reason]);
async function agent(o) {
  const x = Object.assign({ org: A, email: null, name: 'وكيل ملاحي ' + (++agSeq), en: 'Agent Line ' + agSeq }, o || {});
  return (await q(`INSERT INTO public.parties (org_id, kinds, name_ar, name_en, email) VALUES ($1, ARRAY['shipping_agent'], $2, $3, $4) RETURNING id`,
    [x.org, x.name, x.en, x.email]))[0].id;
}
// a transaction (JED by default) with containers (deadline offsets from the Riyadh today, null = no deadline) and B/Ls with agents
async function mkTx(o) {
  const x = Object.assign({ org: A, branch: JED, client: CLIENT_A, ctr: [2], bls: [{ agentEmail: 'ops@agent-one.example.com' }] }, o || {});
  const tx = (await q(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea') RETURNING id, ref`,
    [x.org, x.branch, x.client]))[0];
  const ctrs = [];
  for (const off of x.ctr) {
    const no = nextCtr();
    const c = (await q(`INSERT INTO public.containers (org_id, transaction_id, container_no, container_type, return_deadline)
                        VALUES ($1, $2, $3, '40ft', CASE WHEN $4::int IS NULL THEN NULL ELSE ${TODAY} + $4::int END) RETURNING id, container_no, return_deadline`,
      [x.org, tx.id, no, off]))[0];
    ctrs.push(c);
  }
  const bls = [];
  let first = true;
  for (const b of x.bls) {
    const ag = b.agent !== undefined ? b.agent : (b.none ? null : await agent({ org: x.org, email: b.agentEmail || null }));
    const no = nextBl();
    const bl = (await q(`INSERT INTO public.bills_of_lading (org_id, bl_number, shipping_agent_id) VALUES ($1, $2, $3) RETURNING id`, [x.org, no, ag]))[0].id;
    await q(`INSERT INTO public.transaction_bls (transaction_id, bl_id, org_id, is_primary) VALUES ($1, $2, $3, $4)`, [tx.id, bl, x.org, first]);
    first = false;
    bls.push({ id: bl, no, agent: ag });
  }
  return { id: tx.id, ref: tx.ref, ctrs, bls };
}
const causes = (tx, at) => q(`SELECT dedupe_key, kind, severity, container_id, title_ar, title_en, due_at FROM app.alert_causes($1, $2::timestamptz)
                               WHERE transaction_id = $3 AND kind LIKE 'empty_return%' ORDER BY dedupe_key`, [A, at || new Date().toISOString(), tx]);

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql, docs');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261127000100, schema_versions row, search_path = \'\' on every function, no BEGIN / COMMIT', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261127000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261128000100', 'return_extension'\)/.test(src)
      && !/^\s*(BEGIN|COMMIT)\s*;/m.test(src) && heads.length === NEW_FNS.length + RECREATED.length && bad.length === 0)
      || J({ n: heads.length, want: NEW_FNS.length + RECREATED.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('refusals through app.fail(\'MRS_*\') only; every code has an Arabic message in supa.js and Arabic + English in i18n.js', () => {
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|RETURN EXTENSION preflight/.test(r));
    const used = [...new Set((src.match(/app\.fail\('(MRS_[A-Z_]+)'/g) || []).map(x => x.slice(10, -1)))].sort();
    const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
    const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
    const missing = used.filter(c => !new RegExp('\\b' + c + ':').test(supa) || (i18n.match(new RegExp('\\n\\s+' + c + ': ', 'g')) || []).length < 2);
    return (raises.length === 0 && missing.length === 0 && CODES.every(c => used.includes(c) && src.slice(0, 9000).includes(c))) || J({ raises, missing });
  });
  await check('no TRUNCATE / DROP TABLE / DROP FUNCTION / DELETE / UPDATE of existing rows outside the RPCs; no key or endpoint; never SMTP / msg_outbound', () => {
    const c = src.replace(/--.*$/gm, '');
    const outside = c.replace(/AS \$\$[\s\S]*?\$\$;/g, '');
    return (!/\bTRUNCATE\b/i.test(c) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA)/i.test(c) && !/\bDELETE\s+FROM\b/i.test(c)
      && !/\bUPDATE\s+public\./i.test(outside) && !/session_replication_role/.test(c) && !/sk-ant|https?:\/\//i.test(src)
      && !/msg_outbound|msg_replies|msg_jobs|net\.http|smtp/i.test(c.replace(/CREATE OR REPLACE FUNCTION app\.convert_delete_tables[\s\S]*?\$\$;/, ''))) || 'body';
  });
  await check('this file is the latest migration', () => migFiles()[migFiles().length - 1] === MIG || migFiles().slice(-1)[0]);
  await check('all_migrations.sql holds this file verbatim (appended last, in order) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const body = all.slice(i + marker.length);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 26000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
  await check('alert_causes = the 20261125000100 body except the empty-return branch (+ the lead_days CTE column, + the no-deadline branch)', () => {
    const fnOf = (s, from) => { const a = s.indexOf('CREATE OR REPLACE FUNCTION app.alert_causes', from || 0); const b = s.indexOf('\n$$;', a); return s.slice(a, b); };
    const li = fnOf(fs.readFileSync(path.join(MIG_DIR, '20261125000100_legacy_import.sql'), 'utf8'));
    const me = fnOf(src);
    const cut = s => {
      const a = s.indexOf("  SELECT CASE WHEN c.return_deadline < today.d THEN 'empty_return_overdue:'");
      const a2 = s.lastIndexOf('  -- RX: the lead time', a) > 0 && s.lastIndexOf('  -- RX: the lead time', a) > a - 400 ? s.lastIndexOf('  -- RX: the lead time', a) : a;
      const b = s.indexOf("  SELECT 'exception_open:'");
      return s.slice(0, a2) + s.slice(b);
    };
    const norm = s => cut(s).replace(/,\n\s+\(app\.empty_return_rules\(p_org\) ->> 'lead_days'\)::int AS lead_days\),\s+-- RX/, '),');
    return (li.length > 1000 && norm(li) === norm(me) && /c\.return_deadline <= today\.d \+ today\.lead_days/.test(me) && /c\.return_deadline <= today\.d \+ 3/.test(li)
      && /'empty_return_no_deadline:'/.test(me)) || 'body differs outside the empty-return branch';
  });
  await check('docs: LEGACY_APPT_AR.md §5b names the migration, the RPCs, the rule, the error code and that the program never sends', () => {
    const d = fs.readFileSync(path.join(ROOT, 'docs', 'online', 'LEGACY_APPT_AR.md'), 'utf8');
    const miss = [MIG, 'prepare_return_extension', 'mark_return_extension_sent', 'decide_return_extension', 'lead_days', 'MRS_RX_EXISTS',
      'البرنامج لا يرسل البريد بنفسه', 'empty_return_no_deadline'].filter(k => !d.includes(k));
    return miss.length === 0 || 'missing: ' + miss.join(', ');
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
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261127000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without tx_draft_approval: exact preflight message, nothing created', async () =>
        (msg.startsWith('RETURN EXTENSION preflight: apply tx_draft_approval first (schema_versions lacks 20261127000100 tx_draft_approval)')
          && (await one(`SELECT to_regclass('public.return_extension_requests') IS NULL x`)).x && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261127000100', 'tx_draft_approval')`);
      // live data before the migration: an org, a transaction, a container due in 3 days, an alert
      await db.exec(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${B}', 'pre-org', 'مؤسسة سابقة', 'PRE');
                     INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع');
                     INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل', '0509990000');`);
      const t = (await q(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ('${B}', '${BR_B}', '${CL_B}', 'import', 'sea') RETURNING id`))[0].id;
      await q(`INSERT INTO public.containers (org_id, transaction_id, container_no, return_deadline) VALUES ($1, $2, $3, ${TODAY} + 3), ($1, $2, $4, ${TODAY} + 4)`,
        [B, t, nextCtr(), nextCtr()]);
      const before = await q(`SELECT dedupe_key, kind, severity FROM app.alert_causes($1, now()) ORDER BY 1`, [B]);
      const ev0 = await num(`SELECT count(*) n FROM public.transaction_events`);
      const r1 = await tryErr(() => db.exec(src));
      await check('applies on live data: the same alert set (default lead 3 = the old +3), no event / row written, settings untouched', async () => {
        const after = await q(`SELECT dedupe_key, kind, severity FROM app.alert_causes($1, now()) ORDER BY 1`, [B]);
        const st = await one(`SELECT settings FROM public.organizations WHERE id = $1`, [B]);
        return (r1 === 'ok' && before.length === 1 && J(before) === J(after) && (await num(`SELECT count(*) n FROM public.transaction_events`)) === ev0
          && !('empty_return_rules' in (st.settings || {}))) || J({ r1, before, after });
      });
      const C1 = await catalog();
      const r3 = await tryErr(() => db.exec(src));
      await check('re-runs on top of itself with an identical catalog; one schema_versions row', async () =>
        (r3 === 'ok' && J(C1) === J(await catalog()) && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261128000100'`)) === 1) || r3);
      const s0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the new functions; alert_causes / convert_delete_tables re-created with ACL / definer / config kept; one new table', () => {
        const nm = s => s.split('(')[0];
        const added = [...new Set(C1.fns.filter(f => !s0.has(f.sig)).map(f => nm(f.sig)))].sort();
        const changed = C1.fns.filter(f => s0.has(f.sig) && s0.get(f.sig).h !== f.h).map(f => nm(f.sig)).sort();
        const keep = C1.fns.filter(f => s0.has(f.sig) && RECREATED.includes(nm(f.sig)))
          .every(f => s0.get(f.sig).acl === f.acl && s0.get(f.sig).d === f.d && s0.get(f.sig).c === f.c);
        const tables = C1.tables.filter(x => !C0.tables.includes(x));
        return (J(added) === J(NEW_FNS) && J(changed) === J(RECREATED) && keep && J(tables) === J(['public.return_extension_requests'])) || J({ added, changed, keep, tables });
      });
      await check('catalog: one policy (SELECT), two triggers (guard, audit), the event / alert-kind CHECKs widened, 8 labels', () => {
        const pol = C1.pol.filter(x => !C0.pol.includes(x)), trg = C1.trg.filter(x => !C0.trg.includes(x));
        const lab = C1.labels.filter(l => !C0.labels.includes(l));
        const conChanged = C1.con.filter(x => !C0.con.includes(x) && !/^return_extension_requests\./.test(x)).map(x => x.split(':')[0]).sort();
        return (J(pol) === J(['return_extension_requests.return_extension_requests_select'])
          && J(trg) === J(['return_extension_requests.trg_audit', 'return_extension_requests.trg_guard']) && lab.length === 8
          && J(conChanged) === J(['operational_alerts.operational_alerts_kind_check', 'transaction_events.transaction_events_event_type_check'])) || J({ pol, trg, lab, conChanged });
      });
      await check('the conversion list classifies the new table (convert_check finds no unclassified org table)', async () => {
        const t2 = await one(`SELECT 'public.return_extension_requests' = ANY (app.convert_delete_tables()) x`);
        return t2.x === true || 'not listed';
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. rules */
async function secRules() {
  section('3. rules: organizations.settings.empty_return_rules');
  await check('defaults lead 3 / request 7; staff read (incl. the accountant); can_edit only for the org owner', async () => {
    const r = await getRules('jed'), a = await getRules('admin'), c = await getRules('acc'), j = await getRules('admJed');
    return (J(r.rules) === J({ lead_days: 3, default_request_days: 7 }) && J(r.defaults) === J(r.rules) && r.can_edit === false && a.can_edit === true
      && c.rules.lead_days === 3 && j.can_edit === false && r.template.custom === false && r.placeholders.length === 13 && /\{\{tx_ref\}\}/.test(r.builtin.subject)) || J({ r, a: a.can_edit });
  });
  await check('client user / other org / anon → refused', async () => {
    const p = await code(() => getRules('portal')), b = await code(() => getRules('staffB')), an = await code(() => getRules('anon'));
    return (p === 'MRS_FORBIDDEN organization' && b === 'MRS_FORBIDDEN organization' && /perm/.test(an)) || J({ p, b, an });
  });
  await check('set: owner only (a branch admin / a clerk → MRS_FORBIDDEN owner_only), reason required, out of range / unknown key / not whole → MRS_INVALID empty_return_rule', async () => {
    const c1 = await code(() => setRules('jed', { lead_days: 2 }, 'x')), c2 = await code(() => setRules('admJed', { lead_days: 2 }, 'x'));
    const c3 = await code(() => setRules('admin', { lead_days: 2 }, ' ')), c4 = await code(() => setRules('admin', { lead_days: 0 }, 'x'));
    const c5 = await code(() => setRules('admin', { lead_days: 31 }, 'x')), c6 = await code(() => setRules('admin', { lead: 2 }, 'x'));
    const c7 = await code(() => setRules('admin', { lead_days: 2.5 }, 'x')), c8 = await code(() => setRules('admin', { lead_days: '2' }, 'x'));
    return (c1 === 'MRS_FORBIDDEN owner_only' && c2 === 'MRS_FORBIDDEN owner_only' && c3 === 'MRS_NOTE_REQUIRED reason'
      && [c4, c5, c6, c7, c8].every(c => c === 'MRS_INVALID empty_return_rule')) || J([c1, c2, c3, c4, c5, c6, c7, c8]);
  });
  await check('set lead 5 / request 10 with a reason → stored + reason; get reflects it; {} → back to the defaults', async () => {
    const r = await setRules('admin', { lead_days: 5, default_request_days: 10 }, 'المالك طلب 5 أيام');
    const st = await one(`SELECT settings -> 'empty_return_rules' s, settings ->> 'empty_return_rules_reason' w FROM public.organizations WHERE id = $1`, [A]);
    const back = await setRules('admin', {}, 'رجوع');
    return (J(r.rules) === J({ lead_days: 5, default_request_days: 10 }) && J(st.s) === J({ lead_days: 5, default_request_days: 10 }) && st.w === 'المالك طلب 5 أيام'
      && J(back.rules) === J({ lead_days: 3, default_request_days: 7 })) || J({ r, st, back });
  });
  await check('a stored invalid value (SQL editor) is ignored, never fails: the defaults stay in force', async () => {
    await q(`UPDATE public.organizations SET settings = jsonb_set(settings, '{empty_return_rules}', '{"lead_days": "x", "default_request_days": 99}') WHERE id = $1`, [A]);
    const r = (await one(`SELECT app.empty_return_rules($1) r`, [A])).r;
    const c = await num(`SELECT count(*) n FROM app.alert_causes($1, now())`, [A]);
    await q(`UPDATE public.organizations SET settings = settings - 'empty_return_rules' WHERE id = $1`, [A]);
    return (J(r) === J({ lead_days: 3, default_request_days: 7 }) && c >= 0) || J(r);
  });
}

/* ================================================================== 4. alerts */
async function secAlerts() {
  section('4. alerts: lead time (Riyadh day), titles, overdue, resolve, no deadline');
  // Riyadh = UTC+3: 2026-12-10 21:30Z is 2026-12-11 00:30 in Riyadh; 20:30Z is still 2026-12-10 23:30
  const tx = await mkTx({ ctr: [null] });
  const c = tx.ctrs[0];
  await q(`UPDATE public.containers SET return_deadline = '2026-12-14' WHERE id = $1`, [c.id]);
  await check('lead 3: fires on the Riyadh day exactly 3 days before (2026-12-11 00:30 Riyadh = 12-10 21:30Z), not one hour earlier (12-10 23:30 Riyadh)', async () => {
    const yes = await causes(tx.id, '2026-12-10T21:30:00Z'), no = await causes(tx.id, '2026-12-10T20:30:00Z');
    return (yes.length === 1 && yes[0].kind === 'empty_return_due' && yes[0].severity === 'warning' && yes[0].dedupe_key === 'empty_return_due:' + c.id
      && no.length === 0 && new Date(yes[0].due_at).toISOString() === '2026-12-14T21:00:00.000Z') || J({ yes, no });
  });
  await check('the title says what to do: «اطلب تمديدًا من الوكيل الملاحي» / "request an extension from the shipping agent"', async () => {
    const r = await causes(tx.id, '2026-12-12T09:00:00Z');
    return (r.length === 1 && r[0].title_ar === 'موعد إرجاع الحاوية الفارغة قريب ' + c.container_no + ' — ' + tx.ref + ' — اطلب تمديدًا من الوكيل الملاحي'
      && r[0].title_en === 'Empty return due ' + c.container_no + ' — ' + tx.ref + ' — request an extension from the shipping agent') || J(r);
  });
  await check('lead 5 (owner): fires 5 days before, not 6 days before', async () => {
    await setRules('admin', { lead_days: 5 }, 'خمسة أيام');
    const yes = await causes(tx.id, '2026-12-09T09:00:00Z'), no = await causes(tx.id, '2026-12-08T09:00:00Z');
    await setRules('admin', {}, 'رجوع');
    return (yes.length === 1 && no.length === 0) || J({ yes, no });
  });
  await check('past the deadline: empty_return_overdue, critical, another dedupe key', async () => {
    const r = await causes(tx.id, '2026-12-15T09:00:00Z');
    return (r.length === 1 && r[0].kind === 'empty_return_overdue' && r[0].severity === 'critical' && r[0].dedupe_key === 'empty_return_overdue:' + c.id
      && /^تأخر إرجاع الحاوية الفارغة /.test(r[0].title_ar) && / — اطلب تمديدًا من الوكيل الملاحي$/.test(r[0].title_ar)) || J(r);
  });
  await check('no deadline + gated out → empty_return_no_deadline (warning, «أدخل الموعد»); not before gate-out, not once returned / waived', async () => {
    const t2 = await mkTx({ ctr: [null] });
    const k = t2.ctrs[0];
    const n0 = await causes(t2.id);
    await q(`UPDATE public.containers SET gate_out_at = now() - interval '1 day' WHERE id = $1`, [k.id]);
    const n1 = await causes(t2.id);
    await q(`UPDATE public.containers SET return_status = 'waived', waiver_reason = 'اختبار' WHERE id = $1`, [k.id]);
    const n2 = await causes(t2.id);
    return (n0.length === 0 && n1.length === 1 && n1[0].kind === 'empty_return_no_deadline' && n1[0].severity === 'warning'
      && n1[0].dedupe_key === 'empty_return_no_deadline:' + k.id && /بلا موعد إرجاع/.test(n1[0].title_ar) && n2.length === 0) || J({ n0, n1, n2 });
  });
  await check('refresh_alerts_core stores the new kind (CHECK widened) and the labels exist (alert_kind / return_extension_status)', async () => {
    const t3 = await mkTx({ ctr: [null] });
    await q(`UPDATE public.containers SET gate_out_at = now() WHERE id = $1`, [t3.ctrs[0].id]);
    await q(`SELECT app.refresh_alerts_core($1, now())`, [A]);
    const a = await num(`SELECT count(*) n FROM public.operational_alerts WHERE kind = 'empty_return_no_deadline' AND container_id = $1 AND status = 'open'`, [t3.ctrs[0].id]);
    const l = await num(`SELECT count(*) n FROM public.status_labels WHERE (domain = 'alert_kind' AND code = 'empty_return_no_deadline')
                           OR domain = 'return_extension_status' OR (domain = 'audit_event' AND code = 'return_extension')`);
    const lst = await rpc('jed', `SELECT public.list_alerts($1, $2) r`, [A, { kind: 'empty_return_no_deadline' }]);
    return (a === 1 && l === 8 && (lst.items || lst.rows || lst).length >= 1) || J({ a, l, lst });
  });
}

/* ================================================================== 5. prepare */
let P1, TX1;
async function secPrepare() {
  section('5. prepare_return_extension');
  TX1 = await mkTx({ ctr: [2, 1, 20] });
  const K = newKey();
  await check('happy path: the due containers only (2 of 3, by number), the B/L agent + its e-mail, requested 7 days after the earliest deadline, a draft', async () => {
    P1 = await prepare('jed', TX1.id, { idempotencyKey: K });
    const due = TX1.ctrs.slice(0, 2).map(c => c.container_no).sort();
    const cur = (await one(`SELECT (${TODAY} + 1)::text d, (${TODAY} + 8)::text u`));
    return (P1.status === 'draft' && J(P1.containers.map(c => c.container_no)) === J(due) && P1.agent_party_id === TX1.bls[0].agent
      && P1.bl_id === TX1.bls[0].id && P1.bl_number === TX1.bls[0].no && P1.to_address === 'ops@agent-one.example.com' && P1.missing_email === false
      && P1.current_deadline === cur.d && P1.requested_until === cur.u && P1.requested_days === 7 && P1.lead_days === 3 && P1.ref === TX1.ref) || J(P1);
  });
  await check('the text: Arabic then English, the B/L, the ref, every container with its current deadline, the days / date, the signature; no {{…}} left', async () => {
    const b = P1.body, s = P1.subject;
    return (/^طلب تمديد مهلة إرجاع الحاويات الفارغة \/ Detention extension request — /.test(s) && s.includes(TX1.ref) && s.includes('B/L ' + TX1.bls[0].no)
      && s.includes(P1.containers[0].container_no) && b.indexOf('السادة') < b.indexOf('Dear') && b.includes('لمدة 7 يومًا حتى تاريخ ' + P1.requested_until)
      && b.includes('by 7 days, until ' + P1.requested_until) && P1.containers.every(c => b.includes('- ' + c.container_no + ' — ' + c.return_deadline))
      && b.includes('موظف جدة') && b.includes('Dear Agent Line') && !/\{\{|\}\}/.test(b + s)) || b;
  });
  await check('a detention_extension exception was opened and set in_progress (source manual, reason with the date and count); events: exception created + status', async () => {
    const e = await one(`SELECT kind, status, source, reason, container_id FROM public.operational_exceptions WHERE id = $1`, [P1.exception_id]);
    const ev = await q(`SELECT payload ->> 'op' op FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'exception' ORDER BY created_at, id`, [TX1.id]);
    return (e.kind === 'detention_extension' && e.status === 'in_progress' && e.source === 'manual' && e.container_id === null
      && e.reason === 'طلب تمديد مهلة إرجاع الحاويات الفارغة حتى ' + P1.requested_until + ' — 2 حاوية' && J(ev.map(x => x.op)) === J(['created', 'status'])) || J({ e, ev });
  });
  await check('replay: the same key → the same request (replayed); another payload with the key → MRS_IDEMPOTENCY_CONFLICT', async () => {
    const r = await prepare('jed', TX1.id, { idempotencyKey: K });
    const c = await code(() => prepare('jed', TX1.id, { requested_days: 9, idempotencyKey: K }));
    return (r.replayed === true && r.id === P1.id && /MRS_IDEMPOTENCY_CONFLICT/.test(c)) || J({ r: r.id, c });
  });
  await check('one active request per agent (MRS_RX_EXISTS agent) and a container in one active request (MRS_RX_EXISTS container)', async () => {
    const c1 = await code(() => prepare('jed', TX1.id, { container_ids: [TX1.ctrs[2].id] }));
    const c2 = await code(() => prepare('jed', TX1.id, { container_ids: [TX1.ctrs[0].id] }));
    return (c1 === 'MRS_RX_EXISTS agent' && c2 === 'MRS_RX_EXISTS container') || J({ c1, c2 });
  });
  await check('no container due within the lead time → every open container with a deadline; requested_until / days chosen by the user', async () => {
    const t = await mkTx({ ctr: [10, 12] });
    const r = await prepare('jed', t.id, { requested_until: (await one(`SELECT (${TODAY} + 20)::text d`)).d });
    const t2 = await mkTx({ ctr: [10] });
    const r2 = await prepare('jed', t2.id, { requested_days: 14 });
    return (r.containers.length === 2 && r.requested_days === 10 && r2.requested_days === 14) || J({ r: r.requested_days, r2: r2.requested_days });
  });
  await check('refusals: returned / waived / foreign container → MRS_INVALID container_ids; no deadline → MRS_REQUIRED return_deadline; none open → MRS_REQUIRED container_ids; bad days / dates', async () => {
    const t = await mkTx({ ctr: [2, null] });
    await q(`UPDATE public.containers SET return_status = 'waived', waiver_reason = 'معفاة' WHERE id = $1`, [t.ctrs[0].id]);
    const a = await code(() => prepare('jed', t.id, { container_ids: [t.ctrs[0].id] }));
    const b = await code(() => prepare('jed', t.id, { container_ids: [TX1.ctrs[2].id] }));
    const c = await code(() => prepare('jed', t.id, { container_ids: [t.ctrs[1].id] }));
    const d = await code(() => prepare('jed', t.id, {}));
    const t2 = await mkTx({ ctr: [] });
    const e = await code(() => prepare('jed', t2.id, {}));
    const t3 = await mkTx({ ctr: [2] });
    const f = await code(() => prepare('jed', t3.id, { requested_days: 61 }));
    const g = await code(() => prepare('jed', t3.id, { requested_days: 0 }));
    const dd = await one(`SELECT (${TODAY} + 2)::text a, (${TODAY} + 9)::text b`);
    const h = await code(() => prepare('jed', t3.id, { requested_until: dd.a }));
    const i = await code(() => prepare('jed', t3.id, { requested_days: 5, requested_until: dd.b }));
    const j = await code(() => prepare('jed', t3.id, { to_address: 'not-an-email' }));
    const k = await code(() => prepare('jed', t3.id, { container_ids: 'x' }));
    const l = await code(() => prepare('jed', t3.id, { nope: 1 }));
    return (a === 'MRS_INVALID container_ids' && b === 'MRS_INVALID container_ids' && c === 'MRS_REQUIRED return_deadline' && d === 'MRS_REQUIRED return_deadline'
      && e === 'MRS_REQUIRED container_ids' && f === 'MRS_INVALID requested_days' && g === 'MRS_INVALID requested_days' && h === 'MRS_INVALID requested_until'
      && i === 'MRS_INVALID requested_until' && j === 'MRS_INVALID to_address' && k === 'MRS_INVALID container_ids' && l === 'MRS_INVALID unknown_key') || J({ a, b, c, d, e, f, g, h, i, j, k, l });
  });
  await check('several agents on the B/Ls → MRS_REQUIRED bl_id; with bl_id → that agent; bl_id of another transaction → MRS_INVALID bl_id', async () => {
    const t = await mkTx({ ctr: [2, 2], bls: [{ agentEmail: 'a1@line.example.com' }, { agentEmail: 'a2@line.example.com' }] });
    const a = await code(() => prepare('jed', t.id, {}));
    const r = await prepare('jed', t.id, { bl_id: t.bls[1].id, container_ids: [t.ctrs[1].id] });
    const b = await code(() => prepare('jed', t.id, { bl_id: TX1.bls[0].id, container_ids: [t.ctrs[0].id] }));
    return (a === 'MRS_REQUIRED bl_id' && r.agent_party_id === t.bls[1].agent && r.to_address === 'a2@line.example.com' && b === 'MRS_INVALID bl_id') || J({ a, r: r.agent_party_id, b });
  });
  await check('several agents + an explicit agent (the UI picker) without bl_id → the B/L of THAT agent (never the primary B/L of another agent); agent_party_id null → MRS_REQUIRED bl_id', async () => {
    const t = await mkTx({ ctr: [2, 2], bls: [{ agentEmail: 'p1@line.example.com' }, { agentEmail: 'p2@line.example.com' }] });
    const r = await prepare('jed', t.id, { agent_party_id: t.bls[1].agent, container_ids: [t.ctrs[1].id] });
    const n = await code(() => prepare('jed', t.id, { agent_party_id: null, container_ids: [t.ctrs[0].id] }));
    return (r.agent_party_id === t.bls[1].agent && r.bl_id === t.bls[1].id && r.bl_number === t.bls[1].no && r.subject.includes(t.bls[1].no)
      && r.to_address === 'p2@line.example.com' && n === 'MRS_REQUIRED bl_id') || J({ r: [r.agent_party_id, r.bl_id], n });
  });
  await check('an agent without e-mail → draft with to_address NULL and missing_email; an explicit agent (kind shipping_agent of the org); a non-agent party → MRS_INVALID', async () => {
    const t = await mkTx({ ctr: [2], bls: [{}] });
    const r = await prepare('jed', t.id, {});
    const t2 = await mkTx({ ctr: [2], bls: [{ none: true }] });
    const ag = await agent({ email: 'Mixed.Case@Agent.example.com' });
    const r2 = await prepare('jed', t2.id, { agent_party_id: ag });
    const yard = (await q(`INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['yard'], 'ساحة اختبار') RETURNING id`, [A]))[0].id;
    const t3 = await mkTx({ ctr: [2], bls: [{ none: true }] });
    const c = await code(() => prepare('jed', t3.id, { agent_party_id: yard }));
    const r3 = await prepare('jed', t3.id, { to_address: 'Line@Example.com' });
    return (r.to_address === null && r.missing_email === true && r2.agent_party_id === ag && r2.to_address === 'mixed.case@agent.example.com'
      && c === 'MRS_INVALID agent_party_id' && r3.agent_party_id === null && r3.to_address === 'line@example.com' && /الوكيل الملاحي المحترمين/.test(r3.body)) || J({ r, r2, c, r3: r3.agent_party_id });
  });
  await check('roles: a clerk of another branch → MRS_NOT_FOUND transaction; the accountant (read-only staff) → MRS_FORBIDDEN role; client / other org / anon refused; cancelled transaction → MRS_BAD_TRANSITION cancelled', async () => {
    const t = await mkTx({ ctr: [2] });
    const a = await code(() => prepare('dmm', t.id, {})), b = await code(() => prepare('acc', t.id, {}));
    const c = await code(() => prepare('portal', t.id, {})), d = await code(() => prepare('staffB', t.id, {}));
    const e = await code(() => as('anon', `SELECT public.prepare_return_extension($1, '{}') r`, [t.id]));
    await q(`UPDATE public.transactions SET cancelled_at = now(), cancel_reason = 'اختبار' WHERE id = $1`, [t.id]).catch(() => null);
    const cx = await one(`SELECT cancelled_at IS NOT NULL x FROM public.transactions WHERE id = $1`, [t.id]);
    const f = cx.x ? await code(() => prepare('jed', t.id, {})) : 'MRS_BAD_TRANSITION cancelled';
    return (a === 'MRS_NOT_FOUND transaction' && b === 'MRS_FORBIDDEN role' && c === 'MRS_NOT_FOUND transaction' && d === 'MRS_NOT_FOUND transaction'
      && /perm/.test(e) && f === 'MRS_BAD_TRANSITION cancelled') || J({ a, b, c, d, e, f });
  });
}

/* ================================================================== 6. text / template */
async function secText() {
  section('6. the message text: org template, placeholders');
  await check('unknown / spaced placeholder → MRS_INVALID placeholder; subject + body required; owner only; reason required', async () => {
    const a = await code(() => setTpl('admin', { subject: 'x {{nope}}', body: 'y' }, 'r'));
    const b = await code(() => setTpl('admin', { subject: 'x', body: 'y {{ tx_ref }}' }, 'r'));
    const c = await code(() => setTpl('admin', { subject: 'x' }, 'r'));
    const d = await code(() => setTpl('jed', { subject: 'x', body: 'y' }, 'r'));
    const e = await code(() => setTpl('admin', { subject: 'x', body: 'y' }, ''));
    const f = await code(() => setTpl('admin', { subject: 'x', body: 'y', extra: 1 }, 'r'));
    return (a === 'MRS_INVALID placeholder' && b === 'MRS_INVALID placeholder' && c === 'MRS_REQUIRED body' && d === 'MRS_FORBIDDEN owner_only'
      && e === 'MRS_NOTE_REQUIRED reason' && f === 'MRS_INVALID unknown_key') || J({ a, b, c, d, e, f });
  });
  await check('an org template is used for new requests (every placeholder rendered); null → back to the built-in text', async () => {
    const all = '{{tx_ref}}|{{bl_number}}|{{agent_name}}|{{agent_name_en}}|{{container_first}}|{{container_count}}|{{current_deadline}}|{{requested_days}}|{{requested_until}}|{{org_name}}|{{today}}';
    const g = await setTpl('admin', { subject: 'تمديد {{tx_ref}}', body: all + '\n{{container_list}}\n{{signature}}' }, 'نص المؤسسة');
    const t = await mkTx({ ctr: [2] });
    const r = await prepare('jed', t.id, {});
    const parts = r.body.split('\n')[0].split('|');
    const back = await setTpl('admin', null, 'رجوع');
    const t2 = await mkTx({ ctr: [2] });
    const r2 = await prepare('jed', t2.id, {});
    return (g.template.custom === true && r.subject === 'تمديد ' + t.ref && parts[0] === t.ref && parts[1] === t.bls[0].no && parts[5] === '1' && parts[7] === '7'
      && parts.every(x => x && !/\{\{/.test(x)) && /- RXTU/.test(r.body) && back.template.custom === false && /^طلب تمديد مهلة/.test(r2.subject)) || J({ g: g.template, r: r.body, r2: r2.subject });
  });
}

/* ================================================================== 7. transitions */
async function secTransitions() {
  section('7. update / mark sent / decide / cancel');
  await check('update (draft): days → requested_until + the text re-rendered; edited body kept on a later days change; rerender resets; to_address null clears', async () => {
    const t = await mkTx({ ctr: [2] });
    const r = await prepare('jed', t.id, {});
    const u1 = await update('jed', r.id, { requested_days: 10 });
    const u2 = await update('jed', r.id, { body: 'نص معدّل يدويًا' });
    const u3 = await update('jed', r.id, { requested_days: 12 });
    const u4 = await update('jed', r.id, { rerender: true });
    const u5 = await update('jed', r.id, { to_address: null });
    const e1 = await code(() => update('jed', r.id, { subject: '' })), e2 = await code(() => update('jed', r.id, { body: 'x'.repeat(8001) }));
    return (u1.requested_days === 10 && /لمدة 10 يومًا/.test(u1.body) && u1.text_edited === false && u2.text_edited === true && u2.body === 'نص معدّل يدويًا'
      && u3.requested_days === 12 && u3.body === 'نص معدّل يدويًا' && u4.text_edited === false && /لمدة 12 يومًا/.test(u4.body) && u5.to_address === null
      && u5.missing_email === true && e1 === 'MRS_REQUIRED subject' && e2 === 'MRS_TOO_LONG body') || J({ u1: u1.requested_days, u2: u2.text_edited, u3: u3.body, e1, e2 });
  });
  await check('mark sent: needs to_address (MRS_REQUIRED to_address); then sent + sent_at / by; again → MRS_BAD_TRANSITION sent; update after sent → MRS_BAD_TRANSITION sent', async () => {
    const t = await mkTx({ ctr: [2], bls: [{}] });
    const r = await prepare('jed', t.id, {});
    const a = await code(() => markSent('jed', r.id));
    await update('jed', r.id, { to_address: 'agent@line.example.com' });
    const s = await markSent('jed', r.id, 'أُرسل من ops@marsacloud.com');
    const b = await code(() => markSent('jed', r.id)), c = await code(() => update('jed', r.id, { requested_days: 3 }));
    return (a === 'MRS_REQUIRED to_address' && s.status === 'sent' && s.sent_by === U.jed && !!s.sent_at && s.sent_note === 'أُرسل من ops@marsacloud.com'
      && s.sent_by_name === 'موظف جدة' && b === 'MRS_BAD_TRANSITION sent' && c === 'MRS_BAD_TRANSITION sent') || J({ a, s, b, c });
  });
  await check('the alert title follows the request: draft «جاهز ولم يُرسَل» → sent «مُرسَل بانتظار رد الوكيل»; the alert row title is refreshed (same dedupe key)', async () => {
    const t = await mkTx({ ctr: [1] });
    const r = await prepare('jed', t.id, {});
    const a1 = await causes(t.id);
    await markSent('jed', r.id);
    const a2 = await causes(t.id);
    await q(`SELECT app.refresh_alerts_core($1, now())`, [A]);
    const row = await one(`SELECT title_ar, title_en, status FROM public.operational_alerts WHERE dedupe_key = $1`, ['empty_return_due:' + t.ctrs[0].id]);
    return (/ — طلب التمديد جاهز ولم يُرسَل بعد$/.test(a1[0].title_ar) && / — extension request prepared, not sent yet$/.test(a1[0].title_en)
      && / — طلب التمديد مُرسَل بانتظار رد الوكيل الملاحي$/.test(a2[0].title_ar) && / — extension requested, awaiting the shipping agent$/.test(a2[0].title_en)
      && a1[0].dedupe_key === a2[0].dedupe_key && row.title_ar === a2[0].title_ar && row.status === 'open') || J({ a1, a2, row });
  });
  let D;
  const t = await mkTx({ ctr: [1, 2, 2] });
  await check('decide approved: return_deadline moves to decided_until through set_container_return (return_plan events) for open containers; returned / waived skipped; the alert resolves; exception resolved', async () => {
    const r = await prepare('jed', t.id, { container_ids: t.ctrs.map(c => c.id) });
    await markSent('jed', r.id);
    await q(`UPDATE public.containers SET return_status = 'waived', waiver_reason = 'معفاة' WHERE id = $1`, [t.ctrs[2].id]);
    await q(`SELECT app.refresh_alerts_core($1, now())`, [A]);
    const before = await num(`SELECT count(*) n FROM public.operational_alerts WHERE transaction_id = $1 AND status = 'open' AND kind = 'empty_return_due'`, [t.id]);
    const until = (await one(`SELECT (${TODAY} + 15)::text d`)).d;
    D = await decide('jed', r.id, { outcome: 'approved', decided_until: until, note: 'وافق الوكيل بالبريد', idempotencyKey: newKey() });
    const c = await q(`SELECT id, return_deadline::text d FROM public.containers WHERE transaction_id = $1 ORDER BY container_no`, [t.id]);
    const ev = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'container' AND payload ->> 'op' = 'return_plan'`, [t.id]);
    const e = await one(`SELECT status, resolution_note FROM public.operational_exceptions WHERE id = $1`, [r.exception_id]);
    await q(`SELECT app.refresh_alerts_core($1, now())`, [A]);
    const after = await num(`SELECT count(*) n FROM public.operational_alerts WHERE transaction_id = $1 AND status = 'open' AND kind LIKE 'empty_return%'`, [t.id]);
    return (D.status === 'approved' && D.decided_until === until && D.updated.length === 2 && D.skipped.length === 1 && D.skipped[0].id === t.ctrs[2].id
      && c.filter(x => x.id !== t.ctrs[2].id).every(x => x.d === until) && ev === 2 && e.status === 'resolved' && e.resolution_note === 'وافق الوكيل الملاحي على التمديد حتى ' + until + ' — وافق الوكيل بالبريد'
      && before === 2 && after === 0 && D.demurrage_hint === false && D.decided_by_name === 'موظف جدة') || J({ D, c, ev, e, before, after });
  });
  await check('a decided request never changes (MRS_BAD_TRANSITION approved; the guard also refuses a direct definer update); a new request is possible again', async () => {
    const a = await code(() => decide('jed', D.id, { outcome: 'rejected', note: 'x' }));
    const b = await code(() => cancel('jed', D.id, 'x'));
    const g = await code(() => q(`UPDATE public.return_extension_requests SET decision_note = 'x' WHERE id = $1`, [D.id]));
    return (a === 'MRS_BAD_TRANSITION approved' && b === 'MRS_BAD_TRANSITION approved' && g === 'MRS_IMMUTABLE status') || J({ a, b, g });
  });
  await check('decide: never earlier than a container\'s own later deadline (unchanged[]); partial: a subset of the containers only; demurrage hint for an open detention case', async () => {
    const t2 = await mkTx({ ctr: [1, 30, 2] });
    await q(`INSERT INTO public.demurrage_cases (org_id, transaction_id, container_id, kind, free_until) VALUES ($1, $2, $3, 'detention', ${TODAY} + 1)`, [A, t2.id, t2.ctrs[0].id]);
    const r = await prepare('jed', t2.id, { container_ids: t2.ctrs.map(c => c.id) });
    const until = (await one(`SELECT (${TODAY} + 10)::text d`)).d;
    const bad = await code(() => decide('jed', r.id, { outcome: 'approved', decided_until: until, container_ids: [t2.ctrs[0].id], note: 'n' }));
    const x = await decide('jed', r.id, { outcome: 'partially_approved', decided_until: until, container_ids: [t2.ctrs[0].id, t2.ctrs[1].id], note: 'هاتفيًا' });
    const c = await q(`SELECT id, return_deadline::text d FROM public.containers WHERE transaction_id = $1`, [t2.id]);
    const dc = await one(`SELECT free_until::text f FROM public.demurrage_cases WHERE transaction_id = $1`, [t2.id]);
    const by = Object.fromEntries(c.map(z => [z.id, z.d]));
    return (bad === 'MRS_INVALID container_ids' && x.status === 'partially_approved' && x.updated.length === 1 && x.unchanged.length === 1
      && by[t2.ctrs[0].id] === until && by[t2.ctrs[1].id] !== until && by[t2.ctrs[2].id] !== until && x.demurrage_hint === true
      && dc.f === (await one(`SELECT (${TODAY} + 1)::text d`)).d) || J({ bad, x, by });
  });
  await check('decide refusals: no outcome / bad outcome, decided_until missing / not after the current deadline / > 365 days, rejected with a date, draft without a note, thread of another transaction, document of another transaction', async () => {
    const t3 = await mkTx({ ctr: [2] });
    const r = await prepare('jed', t3.id, {});
    const d0 = (await one(`SELECT (${TODAY} + 2)::text a, (${TODAY} + 5)::text b, (${TODAY} + 400)::text c`));
    const a = await code(() => decide('jed', r.id, {})), b = await code(() => decide('jed', r.id, { outcome: 'maybe' }));
    const c = await code(() => decide('jed', r.id, { outcome: 'approved', note: 'n' })), d = await code(() => decide('jed', r.id, { outcome: 'approved', decided_until: d0.a, note: 'n' }));
    const e = await code(() => decide('jed', r.id, { outcome: 'approved', decided_until: d0.c, note: 'n' }));
    const f = await code(() => decide('jed', r.id, { outcome: 'rejected', decided_until: d0.b, note: 'n' }));
    const g = await code(() => decide('jed', r.id, { outcome: 'approved', decided_until: d0.b }));
    const h = await code(() => decide('jed', r.id, { outcome: 'rejected' }));
    const ch = (await q(`SELECT id FROM public.msg_channels WHERE org_id = $1 LIMIT 1`, [A]))[0];
    let th = null;
    if (ch) th = (await q(`INSERT INTO public.msg_threads (org_id, channel_id, kind, subject, transaction_id) VALUES ($1, $2, 'email', 'x', $3) RETURNING id`, [A, ch.id, TX1.id]))[0].id;
    const i = th ? await code(() => decide('jed', r.id, { outcome: 'approved', decided_until: d0.b, note: 'n', msg_thread_id: th })) : 'MRS_INVALID msg_thread_id';
    const j = await code(() => decide('jed', r.id, { outcome: 'approved', decided_until: d0.b, note: 'n', document_id: '00000000-0000-4000-8000-000000000999' }));
    return (a === 'MRS_REQUIRED outcome' && b === 'MRS_INVALID outcome' && c === 'MRS_REQUIRED decided_until' && d === 'MRS_INVALID decided_until'
      && e === 'MRS_INVALID decided_until' && f === 'MRS_INVALID decided_until' && g === 'MRS_REQUIRED note' && h === 'MRS_REQUIRED note'
      && i === 'MRS_INVALID msg_thread_id' && j === 'MRS_INVALID document_id') || J({ a, b, c, d, e, f, g, h, i, j });
  });
  await check('decide rejected (from sent, note required): the deadline unchanged, the alert stays, the exception resolved with the note; replay with the same key', async () => {
    const t4 = await mkTx({ ctr: [1] });
    const r = await prepare('jed', t4.id, {});
    await markSent('jed', r.id);
    const K = newKey();
    const x = await decide('jed', r.id, { outcome: 'rejected', note: 'رفض الوكيل: الحاوية مطلوبة للتصدير', idempotencyKey: K });
    const y = await decide('jed', r.id, { outcome: 'rejected', note: 'رفض الوكيل: الحاوية مطلوبة للتصدير', idempotencyKey: K });
    const c = await one(`SELECT return_deadline::text d FROM public.containers WHERE id = $1`, [t4.ctrs[0].id]);
    const al = await causes(t4.id);
    const e = await one(`SELECT status, resolution_note FROM public.operational_exceptions WHERE id = $1`, [r.exception_id]);
    return (x.status === 'rejected' && x.decided_until === null && y.replayed === true && c.d === String(r.current_deadline)
      && al.length === 1 && / — اطلب تمديدًا من الوكيل الملاحي$/.test(al[0].title_ar) && e.status === 'resolved'
      && /^رفض الوكيل الملاحي طلب التمديد — رفض الوكيل/.test(e.resolution_note)) || J({ x, c, al, e });
  });
  await check('cancel: reason required (MRS_NOTE_REQUIRED reason); draft → cancelled, exception resolved; a new request for the same agent is then allowed', async () => {
    const t5 = await mkTx({ ctr: [2] });
    const r = await prepare('jed', t5.id, {});
    const a = await code(() => cancel('jed', r.id, '  '));
    const x = await cancel('jed', r.id, 'الوكيل مدّد تلقائيًا');
    const e = await one(`SELECT status, resolution_note FROM public.operational_exceptions WHERE id = $1`, [r.exception_id]);
    const again = await prepare('jed', t5.id, {});
    return (a === 'MRS_NOTE_REQUIRED reason' && x.status === 'cancelled' && x.cancel_reason === 'الوكيل مدّد تلقائيًا' && e.status === 'resolved'
      && e.resolution_note === 'أُلغي طلب التمديد — الوكيل مدّد تلقائيًا' && again.status === 'draft' && again.id !== r.id) || J({ a, x, e });
  });
  await check('list_return_extensions: by transaction / status / active; counts draft + sent; another branch\'s clerk does not see JED rows; unknown status refused', async () => {
    const l = await list('jed', A, { transaction_id: TX1.id });
    const act = await list('jed', A, { status: 'active' });
    const dm = await list('dmm', A, { status: 'active' });
    const bad = await code(() => list('jed', A, { status: 'weird' }));
    const ot = await code(() => list('dmm', A, { transaction_id: TX1.id }));
    return (l.items.length === 1 && l.items[0].id === P1.id && l.items[0].agent_name && act.total >= 3 && act.counts.draft >= 1 && act.counts.sent >= 0
      && act.items.every(x => ['draft', 'sent'].includes(x.status)) && dm.total === 0 && bad === 'MRS_INVALID status' && ot === 'MRS_NOT_FOUND transaction') || J({ l: l.total, act: act.total, dm: dm.total, bad, ot });
  });
}

/* ================================================================== 8. RLS / privileges / events */
async function secPriv() {
  section('8. RLS, privileges, events, nothing sent');
  await check('table: staff of the branch read; client user, other branch, other org read nothing; no INSERT / UPDATE / DELETE for authenticated; anon no access', async () => {
    const j = Number((await as('jed', `SELECT count(*) n FROM public.return_extension_requests`))[0].n);
    const p = Number((await as('portal', `SELECT count(*) n FROM public.return_extension_requests`))[0].n);
    const d = Number((await as('dmm', `SELECT count(*) n FROM public.return_extension_requests`))[0].n);
    const b = Number((await as('staffB', `SELECT count(*) n FROM public.return_extension_requests`))[0].n);
    const ins = await code(() => as('jed', `INSERT INTO public.return_extension_requests (org_id, transaction_id, container_ids, current_deadline, requested_days, requested_until, subject, body, exception_id)
                                           VALUES ($1, $2, ARRAY[$3]::uuid[], current_date, 1, current_date + 1, 's', 'b', $4)`, [A, TX1.id, TX1.ctrs[0].id, P1.exception_id]));
    const upd = await code(() => as('jed', `UPDATE public.return_extension_requests SET body = 'x'`));
    const del = await code(() => as('jed', `DELETE FROM public.return_extension_requests`));
    const an = await code(() => as('anon', `SELECT count(*) FROM public.return_extension_requests`));
    return (j >= 5 && p === 0 && d === 0 && b === 0 && ins === 'perm' && upd === 'perm' && del === 'perm' && an === 'perm') || J({ j, p, d, b, ins, upd, del, an });
  });
  await check('functions: the 9 RPCs executable by authenticated only (not anon / PUBLIC); app.rx_* / empty_return_rules* not executable by API roles', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n
                         FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = ANY ($1)`, [RPCS]);
    const h = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
                        WHERE s.nspname = 'app' AND (p.proname LIKE 'rx\\_%' OR p.proname LIKE 'empty\\_return\\_rules%' OR p.proname = 'tg_return_extension_guard')
                          AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))`);
    return (r.length === RPCS.length && r.every(x => x.a && !x.n) && h.length === 0) || J({ r, h });
  });
  await check('write RPCs on a request of another branch / org → MRS_NOT_FOUND request; the accountant → MRS_FORBIDDEN role', async () => {
    const a = await code(() => markSent('dmm', P1.id)), b = await code(() => cancel('staffB', P1.id, 'x'));
    const c = await code(() => update('acc', P1.id, { requested_days: 3 })), d = await code(() => decide('portal', P1.id, { outcome: 'rejected', note: 'x' }));
    return (a === 'MRS_NOT_FOUND request' && b === 'MRS_NOT_FOUND request' && c === 'MRS_FORBIDDEN role' && d === 'MRS_NOT_FOUND request') || J({ a, b, c, d });
  });
  await check('events: return_extension (prepared / updated / sent / decided / cancelled), never client visible, payload without subject / body; the portal user sees none', async () => {
    const ev = await q(`SELECT payload, visible_to_client v FROM public.transaction_events WHERE event_type = 'return_extension'`);
    const ops = [...new Set(ev.map(e => e.payload.op))].sort();
    const seen = Number((await as('portal', `SELECT count(*) n FROM public.transaction_events WHERE event_type = 'return_extension'`))[0].n);
    return (J(ops) === J(['cancelled', 'decided', 'prepared', 'sent', 'updated']) && ev.every(e => e.v === false && !('body' in e.payload) && !('subject' in e.payload)
      && e.payload.request_id && Array.isArray(e.payload.container_ids)) && seen === 0) || J({ ops, seen });
  });
  await check('the audit trail has the request rows without the text (subject / body stripped)', async () => {
    const a = await q(`SELECT new_data FROM public.audit_log WHERE table_name = 'return_extension_requests' LIMIT 50`);
    return (a.length > 0 && a.every(x => !x.new_data || (!('body' in x.new_data) && !('subject' in x.new_data)))) || a.length;
  });
  await check('nothing was sent or queued: no msg_outbound / msg_replies / msg_jobs rows', async () =>
    (await num(`SELECT (SELECT count(*) FROM public.msg_outbound) + (SELECT count(*) FROM public.msg_replies) + (SELECT count(*) FROM public.msg_jobs) n`)) === 0);
}

/* ================================================================== 9. supa.js */
async function secStatic() {
  section('9. supa.js wrappers (vm) + messages');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  const calls = [];
  const client = {
    rpc: (fn, a) => { calls.push({ fn, args: a }); return Promise.resolve({ data: { ok: true }, error: null }); },
    from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: () => Promise.resolve({ data: null, error: null }), limit() { return this; }, order() { return this; } }),
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: U.jed } } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) }
  };
  let api = null;
  try {
    const win = { MARSA_CONFIG: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'test-anon-key-not-real', orgSlug: 'blue-sea' },
      supabase: { createClient: () => client }, addEventListener() {}, dispatchEvent() {},
      location: { origin: 'http://127.0.0.1:8000', pathname: '/admin.html', hostname: '127.0.0.1', href: 'http://127.0.0.1:8000/admin.html' } };
    const ctx = { window: win, document: { currentScript: null, head: { appendChild() {} }, createElement: () => ({}), addEventListener() {},
        documentElement: { setAttribute() {}, getAttribute: () => null, hasAttribute: () => false }, querySelector: () => null, querySelectorAll: () => [] },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { onLine: true }, location: win.location, console, setTimeout, clearTimeout, Promise, CustomEvent: function () {},
      crypto: require('crypto').webcrypto, URL, Date, Math, JSON };
    win.window = win;
    vm.createContext(ctx); vm.runInContext(supa, ctx);
    api = win.MarsaApi;
  } catch (e) { api = null; }
  const TXID = 'd7b2cccc-0000-4000-8000-000000000001', RID = 'd7b2cccc-0000-4000-8000-000000000002', CID = 'd7b2cccc-0000-4000-8000-000000000003';
  await check('vm: prepareReturnExtension(tx, {containerIds, requestedDays, toAddress, idemKey}) → prepare_return_extension payload (empty values dropped); bad ids refused locally', async () => {
    if (!api || typeof api.prepareReturnExtension !== 'function') return 'MarsaApi not loaded in vm';
    calls.length = 0;
    await api.prepareReturnExtension(TXID, { containerIds: [CID], requestedDays: 7, toAddress: 'a@b.example.com', blId: null, agentPartyId: '', idemKey: 'd7b2cccc-0000-4000-8000-000000000009' });
    const c = calls.filter(x => x.fn === 'prepare_return_extension')[0];
    const bad = await api.prepareReturnExtension(TXID, { containerIds: ['x'] });
    const bad2 = await api.prepareReturnExtension('nope', {});
    return (c && c.args.p_tx === TXID && J(c.args.p_payload.container_ids) === J([CID]) && c.args.p_payload.requested_days === 7 && c.args.p_payload.to_address === 'a@b.example.com'
      && !('bl_id' in c.args.p_payload) && !('agent_party_id' in c.args.p_payload) && c.args.p_payload.idempotencyKey === 'd7b2cccc-0000-4000-8000-000000000009'
      && bad.error.code === 'MRS_INVALID' && bad2.error.code === 'MRS_REQUIRED') || J({ c, bad, bad2 });
  });
  await check('vm: update / mark sent / decide / cancel → their RPCs and argument names; decide needs an outcome, cancel a reason (locally)', async () => {
    calls.length = 0;
    await api.updateReturnExtension(RID, { requestedUntil: '2026-12-20', toAddress: null, body: 'b', rerender: true });
    await api.markReturnExtensionSent(RID, '  ');
    await api.decideReturnExtension(RID, { outcome: 'approved', decidedUntil: '2026-12-25', note: 'ok', idemKey: 'd7b2cccc-0000-4000-8000-00000000000a' });
    await api.cancelReturnExtension(RID, ' سبب ');
    const nd = await api.decideReturnExtension(RID, {}), nc = await api.cancelReturnExtension(RID, '');
    const u = calls.find(x => x.fn === 'update_return_extension'), m = calls.find(x => x.fn === 'mark_return_extension_sent');
    const d = calls.find(x => x.fn === 'decide_return_extension'), c = calls.find(x => x.fn === 'cancel_return_extension');
    return (u && u.args.p_id === RID && u.args.p_payload.requested_until === '2026-12-20' && u.args.p_payload.to_address === null && u.args.p_payload.rerender === true
      && m && m.args.p_note === null && d && d.args.p_payload.outcome === 'approved' && d.args.p_payload.decided_until === '2026-12-25' && d.args.p_payload.idempotencyKey
      && c && c.args.p_reason === 'سبب' && nd.error.code === 'MRS_REQUIRED' && nc.error.code === 'MRS_NOTE_REQUIRED') || J({ u, m, d, c, nd, nc });
  });
  await check('supa.js exports the 9 wrappers; MRS_RX_EXISTS has an Arabic message; the new field names have labels', () => {
    const names = ['prepareReturnExtension', 'updateReturnExtension', 'markReturnExtensionSent', 'decideReturnExtension', 'cancelReturnExtension',
      'listReturnExtensions', 'getEmptyReturnRules', 'setEmptyReturnRules', 'setReturnExtensionTemplate'];
    const miss = names.filter(n => !api || typeof api[n] !== 'function');
    return (miss.length === 0 && /MRS_RX_EXISTS: 'يوجد طلب تمديد مفتوح/.test(supa) && /to_address: 'بريد الوكيل الملاحي'/.test(supa) && /decided_until: 'تاريخ المهلة الجديد'/.test(supa)) || J(miss);
  });
}

async function main() {
  await secFile();
  await secPreflight();
  section('load shim + migrations + seed + fixtures');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  pass('database ready');
  await secRules();
  await secAlerts();
  await secPrepare();
  await secText();
  await secTransitions();
  await secPriv();
  await secStatic();
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
}
main().catch(e => { console.error(e); process.exit(1); });
