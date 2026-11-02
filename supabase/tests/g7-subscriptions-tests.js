#!/usr/bin/env node
/*
  Marsa (مرسى) — G7 step ١١: subscription plans, per-org limits, suspend / activate
  (docs/online/G7_SPEC.md § Data model, § RPC list, § Tests "g7-subscriptions-tests.js"). LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network, no Daftra, no mailbox,
  no WhatsApp, no LLM, no payment provider, no keys.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted, G7 held back) → supabase/seed.sql → pre-G7
  fixtures (org B with transactions + documents = "live staging with G2–G6b data") → the G7 migration (preflight
  probe first, then applied three times in total) → fixtures.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g7-subscriptions-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const G7_MIGRATION = '20261108000100_g7_subscriptions.sql';
const G7_FILE = path.join(SUPA, 'migrations', G7_MIGRATION);

// No network anywhere: any fetch is a test failure.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g7-subscriptions-tests'); };

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e) + (e && e.stack && !QUIET ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : '')); }
}
const J = x => JSON.stringify(x);
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/* ================================================================== DB harness */
const A = '0b5e0000-0000-4000-8000-000000000001';       // seed org (synthetic staging data only)
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CL101 = '0b5e0000-0000-4000-8000-000000000101';
const TXA1 = '0b5e0000-0000-4000-8000-000000000201';
const ID = n => 'c7a00000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const B = ID(0xb1), B_BR = ID(0xb2), B_CL = ID(0xb3), B_TX1 = ID(0xb4), B_TX2 = ID(0xb5), B_DOC = ID(0xb6);
const M = ID(0xd1), M_BR = ID(0xd2);
const T_CL = ID(0xe3);
const ROLE_USERS = { admin: 'adminA', operations_manager: 'opsA', branch_manager: 'bmA', supervisor: 'supA', clearance_staff: 'clrA',
  transport_staff: 'trnA', accountant: 'accA', accounts_manager: 'amA', client: 'clientA' };
const U = {
  pa: ID(1), adminA: ID(2), opsA: ID(3), bmA: ID(4), supA: ID(5), clrA: ID(6), trnA: ID(7), accA: ID(8), amA: ID(9), clientA: ID(10),
  adminB: ID(11), adminT: ID(20), clrT: ID(21), opsT: ID(22), lateT: ID(23), clientT: ID(24), xT: ID(25),
  adminM: ID(30), clrM: ID(31), opsM: ID(32), extraA1: ID(40), extraA2: ID(41), extraA3: ID(42),
  rAdmin: ID(50), rOps: ID(51), rU1: ID(52), rU2: ID(53), rU3: ID(54), rU4: ID(55), rU5: ID(56)
};
// review-fix org R (created after G7 is applied, plain SQL like an owner seed)
const R = ID(0xf1), R1 = ID(0xf2), R2 = ID(0xf3), R_CL = ID(0xf4), R3 = ID(0xf5);
const EMAIL = k => k.toLowerCase() + '@g7sub.example.com';
let keySeq = 0;
const newKey = () => `c7a0f000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;

let db;
async function asRole(who, fn) {
  if (who === 'anon') await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  else if (who === 'service') await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
// SQL-Editor-only RPCs (admin_add_member): the owner session carrying the user's claims, no SET ROLE
async function asOwnerWithClaims(who, fn) {
  await db.exec(`SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  try { return await fn(); }
  finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
const num = async (sql, params) => Number((await q(sql, params))[0].n);
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
async function expectErr(name, promiseFn, re) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
}
async function step(name, fn) {
  try { const r = await fn(); pass(name); return r; }
  catch (e) { fail(name, errText(e)); throw new Error('aborted at: ' + name); }
}
async function tryErr(fn) { try { await fn(); return 'ok'; } catch (e) { return errText(e); } }
async function runFile(file, quietLoad) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); if (!quietLoad) console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}

/* ------------------------------------------------------------------ RPC shortcuts */
const P = {
  plans: who => rpc(who, `SELECT public.platform_list_plans() r`),
  savePlan: (who, code, p) => rpc(who, `SELECT public.platform_save_plan($1, $2) r`, [code, p]),
  subs: who => rpc(who, `SELECT public.platform_list_subscriptions() r`),
  setPlan: (who, org, p, k) => rpc(who, `SELECT public.platform_set_org_plan($1, $2, $3) r`, [org, p, k || null]),
  suspend: (who, org, why, cancel) => rpc(who, `SELECT public.platform_suspend_org($1, $2, $3) r`, [org, why, !!cancel]),
  activate: (who, org, why) => rpc(who, `SELECT public.platform_activate_org($1, $2) r`, [org, why]),
  usage: (who, org, m) => rpc(who, `SELECT public.platform_org_usage($1, $2) r`, [org, m === undefined ? 6 : m]),
  recount: (who, org) => rpc(who, `SELECT public.platform_recount_usage($1) r`, [org]),
  orgSub: (who, org) => rpc(who, `SELECT public.org_subscription($1) r`, [org]),
  setActive: (who, org, v) => rpc(who, `SELECT public.platform_set_org_active($1, $2) r`, [org, v]),
  createOrg: (who, p) => rpc(who, `SELECT public.platform_create_org($1) r`, [p]),
  invite: (who, org, p) => rpc(who, `SELECT public.admin_invite($1, $2) r`, [org, p]),
  accept: (who, token) => rpc(who, `SELECT public.accept_invitation($1) r`, [token]),
  addMember: (who, org, email, role, br) => asOwnerWithClaims(who, async () => (await q(`SELECT public.admin_add_member($1, $2, $3, $4) r`, [org, email, role, br || null]))[0].r),
  setMember: (who, m, v) => rpc(who, `SELECT public.admin_set_member_active($1, $2) r`, [m, v]),
  createBranch: (who, org, p) => rpc(who, `SELECT public.admin_create_branch($1, $2) r`, [org, p]),
  updateBranch: (who, br, p) => rpc(who, `SELECT public.admin_update_branch($1, $2) r`, [br, p]),
  convert: (who, req, br, cl, k) => rpc(who, `SELECT public.convert_request_to_transaction($1, $2, $3, $4) r`, [req, br || null, cl || null, k || null]),
  finDoc: (who, p) => rpc(who, `SELECT public.register_finance_document($1) r`, [p])
};
const ALL_PLATFORM = [
  ['platform_list_plans', `SELECT public.platform_list_plans() r`, []],
  ['platform_save_plan', `SELECT public.platform_save_plan('hack', '{"name_ar":"اختراق"}'::jsonb) r`, []],
  ['platform_list_subscriptions', `SELECT public.platform_list_subscriptions() r`, []],
  ['platform_set_org_plan', `SELECT public.platform_set_org_plan($1, '{"plan_code":"pilot","reason":"x"}'::jsonb) r`, [A]],
  ['platform_suspend_org', `SELECT public.platform_suspend_org($1, 'x') r`, [A]],
  ['platform_activate_org', `SELECT public.platform_activate_org($1, 'x') r`, [A]],
  ['platform_org_usage', `SELECT public.platform_org_usage($1) r`, [A]],
  ['platform_recount_usage', `SELECT public.platform_recount_usage($1) r`, [A]]
];
const RPC_SIGS = ['platform_list_plans()', 'platform_save_plan(text, jsonb)', 'platform_list_subscriptions()', 'platform_set_org_plan(uuid, jsonb, uuid)',
  'platform_suspend_org(uuid, text, boolean)', 'platform_activate_org(uuid, text)', 'platform_org_usage(uuid, integer)', 'platform_recount_usage(uuid)',
  'org_subscription(uuid)'];
const NEW_TABLES = ['plans', 'org_subscriptions', 'subscription_events', 'org_usage_counters'];
const APP_FNS = ['g7_metric_keys', 'g7_period', 'g7_overrides_valid', 'g7_plan_limits', 'g7_limits', 'g7_counter', 'g7_used', 'g7_usage',
  'g7_assert_active', 'g7_bump', 'g7_pending', 'g7_object_size', 'g7_check', 'g7_recount', 'g7_sub_lock', 'g7_plan_json', 'g7_sub_json', 'g7_tg_org_insert',
  'g7_tg_org_reactivate', 'g7_tg_transaction', 'g7_tg_branch', 'g7_tg_membership', 'g7_tg_invitation', 'g7_tg_storage_enforced',
  'g7_tg_attachment_count', 'g7_tg_message_count', 'g7_tg_outbound', 'g7_tg_ai_run_count', 'g7_tg_draft_job', 'g7_tg_append_only',
  'g7_tg_tx_created_at', 'g7_tg_object_size'];
// read no table → not SECURITY DEFINER; g7_tg_tx_created_at is INVOKER on purpose (app.is_api_caller must see the caller)
const PURE_FNS = ['g7_metric_keys', 'g7_period', 'g7_overrides_valid', 'g7_plan_limits', 'g7_tg_append_only', 'g7_tg_tx_created_at'];
const G7_TRIGGERS = [['organizations', 'trg_g7_org_insert'], ['organizations', 'trg_g7_org_reactivate'], ['transactions', 'trg_g7_transaction'],
  ['branches', 'trg_g7_branch'], ['memberships', 'trg_g7_membership'], ['invitations', 'trg_g7_invitation'], ['documents', 'trg_g7_storage'],
  ['finance_documents', 'trg_g7_storage'], ['msg_attachments', 'trg_g7_storage'], ['msg_messages', 'trg_g7_count'], ['msg_ai_runs', 'trg_g7_count'],
  ['msg_outbound', 'trg_g7_limit'], ['msg_jobs', 'trg_g7_limit'], ['transactions', 'trg_g7_created_at'], ['objects', 'trg_g7_object_size']];

const counter = async (org, metric, period) => num(`SELECT coalesce((SELECT value FROM public.org_usage_counters WHERE org_id = $1 AND metric = $2
  AND period_start = ${period ? '$3::date' : (metric === 'storage_bytes' ? `DATE '1970-01-01'` : `app.g7_period(now())`)}), 0) n`, period ? [org, metric, period] : [org, metric]);
const sub = org => one(`SELECT * FROM public.org_subscriptions WHERE org_id = $1`, [org]);
const usageOf = org => one(`SELECT app.g7_usage($1) u`, [org]).then(r => r.u);
const events = (org, action) => num(`SELECT count(*) n FROM public.subscription_events WHERE org_id = $1 ${action ? 'AND action = $2' : ''}`, action ? [org, action] : [org]);

let reqSeq = 0;
async function newRequest(org, branch) {
  reqSeq++;
  const id = ID(0x5000 + reqSeq);
  await q(`INSERT INTO public.service_requests (id, org_id, branch_id, ref, status, source, tracking_token_hash, client_type, full_name, company, phone,
             direction, service, mode, country, port, goods, terms_accepted_at)
           VALUES ($1, $2, $3, app.next_ref($2, 'request'), 'new', 'web', app.hash_token($4), 'business', 'مقدم طلب تجريبي', 'شركة طلب', '0500000009',
             'import', 'clearance', 'sea', 'الصين', 'ميناء جدة الإسلامي', 'بضاعة تجريبية', now())`, [id, org, branch || null, 'tok' + reqSeq]);
  return id;
}
async function sqlTx(org, branch, client, createdAt) {
  return (await one(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, goods_description${createdAt ? ', created_at' : ''})
    VALUES ($1, $2, $3, 'import', 'sea', 'بضاعة تجريبية'${createdAt ? ', $4::timestamptz' : ''}) RETURNING id`, createdAt ? [org, branch, client, createdAt] : [org, branch, client])).id;
}
let docSeq = 0;
function docInsertSql() {
  return `INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, mime_type, size_bytes, uploaded_by)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'other', $2::text || '/' || $3::text || '/' || $1::text || '/f.pdf', $4, 'f.pdf', 'application/pdf', $5::bigint, $6::uuid) RETURNING id`;
}
async function docAs(who, org, tx, size) {
  docSeq++;
  const id = ID(0x6000 + docSeq);
  const args = [id, org, tx, sha('doc' + docSeq), size, U[who] || who];
  return who in U ? (await as(who, docInsertSql(), args))[0].id : (await q(docInsertSql(), args))[0].id;
}

/* ------------------------------------------------------------------ messaging (G6b) service side, mock only */
const svc = async (sql, params) => (await as('service', sql, params))[0].r;
const ingest = (ch, msgs) => svc(`SELECT public.msg_ingest_messages($1, $2) r`, [ch, JSON.stringify(msgs)]);
const claim = limit => svc(`SELECT public.msg_claim_jobs('g7w', $1) r`, [limit || 20]);
const complete = (att, res) => svc(`SELECT public.msg_complete_job($1, $2) r`, [att, JSON.stringify(res)]);
function defaultResult(c) {
  const m = c.message;
  switch (c.job.kind) {
    case 'probe': return { outcome: 'ok', effects: { capabilities: { send: { supported: true, evidence: 'mock' }, lookup_send: { supported: true, evidence: 'mock' },
      status_events: { supported: true, evidence: 'mock' }, attachments: { supported: true, evidence: 'mock' }, threading: { supported: true, evidence: 'mock' },
      templates: { supported: false, evidence: 'mock' } }, account: { address: c.channel.address_norm } }, calls: [{ op: 'probe', applied: 'no' }] };
    case 'poll': return { outcome: 'ok', effects: { messages: [], next_cursor: 'c1' } };
    case 'status': return { outcome: 'ok', effects: { events: [], next_cursor: 's1' } };
    case 'process': {
      const txt = (m.subject || '') + ' ' + m.body_text;
      return { outcome: 'ok', calls: [{ op: 'process' }], effects: { message_id: m.id, extractions: [],
        classification: { category: 'unknown', confidence: 0.5, rules: [] },
        summary: { summary_ar: 'ملخص الرسالة', summary_en: 'Message summary', action_code: 'review_manually', suggested_role: 'clearance_staff', deadline: null, risks: [] },
        risk_flags: [],
        ai_run: { provider: 'rule_mock', provider_version: 'test-1', input_sha256: sha(txt), input_chars: Array.from(txt).length, output_chars: 20,
                  est_input_tokens: 5, est_output_tokens: 5, est_cost_usd: 0 } } };
    }
  }
  return { outcome: 'failed', error: { kind: 'validation', code: 'x', applied: 'no' } };
}
async function work(kinds, max) {
  let n = 0;
  for (let round = 0; round < (max || 10); round++) {
    const ctxs = await claim(20);
    if (!ctxs || !ctxs.length) break;
    for (const c of ctxs) {
      if (kinds && !kinds.includes(c.job.kind)) throw new Error('unexpected job kind ' + c.job.kind);
      await complete(c.attempt_id, defaultResult(c));
      n++;
    }
  }
  return n;
}
let nMsg = 0;
function email(o) {
  nMsg++;
  return { provider_message_id: o.pid || ('g7em-' + nMsg), kind: 'email', from: { address: o.from, name: o.name || 'Sender' },
    to: [{ address: o.to }], cc: [], sent_at: new Date().toISOString(), subject: o.subject || 'Subject ' + nMsg,
    body_text: o.body || 'Hello', headers: { message_id: '<g7m' + nMsg + '@agent.example>' }, auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    attachments: o.attachments || [], raw: { provider: 'mock' } };
}

/* ================================================================== pre-G7 fixtures ("live staging data") */
async function preFixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${EMAIL(k)}', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.profiles (id, full_name) SELECT u.id, split_part(u.email, '@', 1) FROM auth.users u WHERE u.email LIKE '%@g7sub.example.com'
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.pa}', 'g7 test operator');
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${B}', 'org-g7a-b', 'مؤسسة ب للاشتراكات', 'TSA');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع الرياض ب');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${B_CL}', '${B}', 'business', 'عميل سري ب للاختبار', '0509999999');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ('${U.adminB}', '${B}', NULL, 'admin');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode, goods_description, created_at) VALUES
      ('${B_TX1}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea', 'بضاعة سرية ب', now()),
      ('${B_TX2}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea', 'بضاعة سرية ب', now() - interval '62 days');
    INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, mime_type, size_bytes, uploaded_by) VALUES
      ('${B_DOC}', '${B}', '${B_TX1}', 'other', '${B}/${B_TX1}/${B_DOC}/secret-b.pdf', repeat('e', 64), 'secret-b.pdf', 'application/pdf', 5000, '${U.adminB}'),
      ('${ID(0xa1)}', '${A}', '${TXA1}', 'other', '${A}/${TXA1}/${ID(0xa1)}/a.pdf', repeat('f', 64), 'a.pdf', 'application/pdf', 1234, '${U.adminB}');
  `);
}

async function fixtures() {
  await db.exec(`
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'), ('${U.opsA}', '${A}', NULL, 'operations_manager'), ('${U.bmA}', '${A}', '${JED}', 'branch_manager'),
      ('${U.supA}', '${A}', NULL, 'supervisor'), ('${U.clrA}', '${A}', '${JED}', 'clearance_staff'), ('${U.trnA}', '${A}', '${JED}', 'transport_staff'),
      ('${U.accA}', '${A}', '${JED}', 'accountant'), ('${U.amA}', '${A}', NULL, 'accounts_manager'), ('${U.clientA}', '${A}', NULL, 'client');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CL101}', '${U.clientA}', 'owner');
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${M}', 'org-g7a-m', 'مؤسسة م للرسائل', 'TSM');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${M_BR}', '${M}', 'JED', 'فرع م');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminM}', '${M}', NULL, 'admin'), ('${U.clrM}', '${M}', '${M_BR}', 'clearance_staff'), ('${U.opsM}', '${M}', NULL, 'operations_manager');
  `);
}

/* ================================================================== sections */
async function secPreflightAndApply() {
  section('P. preflight, first apply on live G2–G6b data, backfill, re-runs');
  const catalog = async () => ({
    fns: (await q(`SELECT p.oid::regprocedure::text sig, md5(p.prosrc || coalesce(array_to_string(p.proconfig, ','), '') || p.prosecdef::text) h
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','app') ORDER BY 1`)),
    cols: (await q(`SELECT table_name || '.' || column_name c FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`)).map(r => r.c),
    pols: (await q(`SELECT tablename || '.' || policyname || ':' || md5(coalesce(qual, '') || coalesce(with_check, '')) p FROM pg_policies
                     WHERE schemaname IN ('public','storage') ORDER BY 1`)).map(r => r.p),
    trg: (await q(`SELECT c.relname || '.' || t.tgname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY 1`)).map(r => r.x)
  });
  // preflight: without the G6b row the file stops with the exact message and creates nothing
  await q(`DELETE FROM public.schema_versions WHERE version = '20261107000100'`);
  const pre = await catalog();
  let msg = null;
  try { await db.exec(fs.readFileSync(G7_FILE, 'utf8')); } catch (e) { msg = e.message; }
  await check('preflight without the G6b schema_versions row → exact RAISE message', () =>
    msg === 'G7 preflight: apply G6b first (schema_versions lacks 20261107000100 g6b_inbox)' || 'got: ' + msg);
  await check('preflight failure created nothing (no table, no function, no trigger, no schema_versions row)', async () => {
    const post = await catalog();
    const t = await one(`SELECT to_regclass('public.plans') p, to_regclass('public.org_subscriptions') s,
                                (SELECT count(*) FROM public.schema_versions WHERE version = '20261108000100')::int v`);
    return (t.p === null && t.s === null && t.v === 0 && J(pre) === J(post)) || J(t);
  });
  await q(`INSERT INTO public.schema_versions (version, name) VALUES ('20261107000100', 'g6b_inbox')`);

  // first apply on a DB holding G2–G6b data
  const before = await catalog();
  if (!await runFile(G7_FILE)) throw new Error('G7 migration did not apply');
  pass('G7 migration applies on a DB holding G2–G6b data (seed org + org B with transactions / documents)');
  const after = await catalog();
  await check('G7 adds no column to any existing table', () => {
    const added = after.cols.filter(c => !before.cols.includes(c) && !NEW_TABLES.includes(c.split('.')[0]));
    const removed = before.cols.filter(c => !after.cols.includes(c));
    return (added.length === 0 && removed.length === 0) || 'added ' + added.join(',') + ' removed ' + removed.join(',');
  });
  await check('G7 re-creates no pre-G7 function (every earlier public / app function body, config and security unchanged)', () => {
    const m = new Map(after.fns.map(f => [f.sig, f.h]));
    const changed = before.fns.filter(f => m.get(f.sig) !== f.h).map(f => f.sig);
    return changed.length === 0 || 'changed: ' + changed.join(', ');
  });
  await check('G7 changes no existing policy and drops no existing trigger', () => {
    const lostP = before.pols.filter(p => !after.pols.includes(p));
    const lostT = before.trg.filter(t => !after.trg.includes(t));
    const newT = after.trg.filter(t => !before.trg.includes(t)).filter(t => !/\.trg_g7_/.test(t) && !NEW_TABLES.includes(t.split('.')[0]));
    return (lostP.length === 0 && lostT.length === 0 && newT.length === 0) || J({ lostP, lostT, newT });
  });
  await check('schema_versions row 20261108000100 g7_subscriptions; health_check reports it', async () => {
    const r = await one(`SELECT name FROM public.schema_versions WHERE version = '20261108000100'`);
    const h = await rpc('anon', `SELECT public.health_check() r`);
    return (r && r.name === 'g7_subscriptions' && h.schema_version === '20261108000100') || J({ r, h });
  });

  // backfill
  await check('backfill: every org (seed org A, org B) has a pilot / active subscription, period_start = created_at (Riyadh date), no end', async () => {
    const r = await q(`SELECT o.id, s.plan_code, s.status, s.period_end, s.period_start = (o.created_at AT TIME ZONE 'Asia/Riyadh')::date ps
                         FROM public.organizations o LEFT JOIN public.org_subscriptions s ON s.org_id = o.id`);
    const bad = r.filter(x => x.plan_code !== 'pilot' || x.status !== 'active' || x.period_end !== null || !x.ps);
    return (r.length === 2 && bad.length === 0) || J(r);
  });
  await check('backfill: one event "created" per org (actor NULL, source backfill)', async () => {
    const r = await q(`SELECT org_id, action, actor, detail FROM public.subscription_events ORDER BY org_id`);
    return (r.length === 2 && r.every(x => x.action === 'created' && x.actor === null && x.detail.source === 'backfill')) || J(r);
  });
  const realTx = async (org, monthsBack) => num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1
     AND app.g7_period(created_at) = (app.g7_period(now()) - make_interval(months => $2))::date`, [org, monthsBack]);
  await check('backfill counters = real rows: transactions this month (A 3, B 1) and B 2 months back (1)', async () => {
    const a = await counter(A, 'transactions_month'), b = await counter(B, 'transactions_month');
    const b2 = await num(`SELECT coalesce((SELECT value FROM public.org_usage_counters WHERE org_id = $1 AND metric = 'transactions_month'
                            AND period_start = (app.g7_period(now()) - interval '2 months')::date), 0) n`, [B]);
    return (a === await realTx(A, 0) && a === 3 && b === 1 && b2 === 1 && b2 === await realTx(B, 2)) || J({ a, b, b2 });
  });
  await check('backfill counters = real rows: storage_bytes (A 1234, B 5000), messages / AI runs 0', async () => {
    const r = [await counter(A, 'storage_bytes'), await counter(B, 'storage_bytes'), await counter(A, 'messages_month'), await counter(B, 'ai_runs_month')];
    return J(r) === J([1234, 5000, 0, 0]) || J(r);
  });
  await check('seeds (G7-13): pilot all NULL; basic 5 / 1 / 300 / 10240 / 3000 / 500; pro 25 / 5 / 3000 / 102400 / 30000 / 5000; enterprise all NULL; no price', async () => {
    const r = await q(`SELECT code, max_users u, max_branches b, max_tx_month t, max_storage_mb s, max_messages_month m, max_ai_runs_month a, price_monthly_sar p, is_active
                         FROM public.plans ORDER BY sort`);
    const f = x => [x.code, x.u, x.b, x.t, x.s === null ? null : Number(x.s), x.m, x.a, x.p, x.is_active].join('|');
    return r.map(f).join(';') === ['pilot||||||||true', 'basic|5|1|300|10240|3000|500||true', 'pro|25|5|3000|102400|30000|5000||true',
      'enterprise||||||||true'].join(';') || r.map(f).join(';');
  });
  await check('seed notes mark the values «قيم مبدئية — قرار المالك»', async () =>
    (await num(`SELECT count(*) n FROM public.plans WHERE code IN ('basic','pro','enterprise') AND notes LIKE '%قيم مبدئية — قرار المالك%'`)) === 3);

  // owner edit, then re-run twice
  await q(`UPDATE public.plans SET max_users = 7, notes = 'تعديل المالك' WHERE code = 'basic'`);
  const snap = async () => J({
    s: await q(`SELECT org_id, plan_code, status, period_start, period_end, limit_overrides FROM public.org_subscriptions ORDER BY org_id`),
    c: await q(`SELECT org_id, metric, period_start, value FROM public.org_usage_counters ORDER BY 1, 2, 3`),
    e: await num(`SELECT count(*) n FROM public.subscription_events`),
    p: await q(`SELECT code, name_ar, max_users, max_branches, max_tx_month, max_storage_mb, max_messages_month, max_ai_runs_month, notes, is_active FROM public.plans ORDER BY code`),
    v: await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261108000100'`)
  });
  const s1 = await snap();
  const ok2 = await runFile(G7_FILE, true), s2 = await snap();
  const ok3 = await runFile(G7_FILE, true), s3 = await snap();
  await check('re-run ×2: applies again, no count / subscription / event / schema_versions change', () => (ok2 && ok3 && s1 === s2 && s2 === s3) || 'differs');
  await check('re-run never overwrites the owner-edited plan (basic max_users 7, owner note kept)', async () => {
    const p = await one(`SELECT max_users, notes FROM public.plans WHERE code = 'basic'`);
    return (p.max_users === 7 && p.notes === 'تعديل المالك') || J(p);
  });
  await q(`UPDATE public.plans SET max_users = 5, notes = 'قيم مبدئية — قرار المالك. لم تُسعَّر.' WHERE code = 'basic'`);
}

async function secCatalog() {
  section('catalog: RLS, grants, function security, audit, append-only, triggers');
  for (const t of NEW_TABLES) {
    await check(`${t}: RLS enabled, no policy`, async () => {
      const r = await one(`SELECT c.relrowsecurity rls, (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = $1)::int pol
                             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`, [t]);
      return (r.rls === true && r.pol === 0) || J(r);
    });
    await check(`${t}: no table or column privilege for PUBLIC / anon / authenticated`, async () => {
      const r = await q(`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = $1
                           AND grantee IN ('PUBLIC','anon','authenticated')`, [t]);
      const c = await q(`SELECT grantee FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = $1
                           AND grantee IN ('PUBLIC','anon','authenticated')`, [t]);
      return (r.length === 0 && c.length === 0) || J(r.concat(c));
    });
    for (const who of ['anon', 'adminA', 'pa']) {
      await expectErr(`${who} cannot SELECT ${t} directly`, () => as(who, `SELECT 1 FROM public.${t} LIMIT 1`), /permission denied/);
    }
  }
  await expectErr('platform admin cannot UPDATE org_subscriptions directly (no API write path)', () =>
    as('pa', `UPDATE public.org_subscriptions SET status = 'active' RETURNING 1`), /permission denied/);
  await check('every new function exists and pins search_path = \'\'', async () => {
    const r = await q(`SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE (n.nspname = 'app' AND p.proname LIKE 'g7\\_%') OR (n.nspname = 'public' AND p.proname = ANY ($1))`,
      [RPC_SIGS.map(s => s.split('(')[0])]);
    const names = r.map(x => x.proname);
    const missing = APP_FNS.concat(RPC_SIGS.map(s => s.split('(')[0])).filter(n => !names.includes(n));
    const bad = r.filter(x => !(x.proconfig || []).includes('search_path=""'));
    return (missing.length === 0 && bad.length === 0 && r.length === APP_FNS.length + RPC_SIGS.length) || J({ missing, bad: bad.map(x => x.proname + ':' + x.proconfig), n: r.length });
  });
  await check('SECURITY DEFINER: the 9 RPCs and every helper / trigger function that reads or writes the new tables', async () => {
    const r = await q(`SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE (n.nspname = 'app' AND p.proname LIKE 'g7\\_%') OR (n.nspname = 'public' AND p.proname = ANY ($1))`, [RPC_SIGS.map(s => s.split('(')[0])]);
    const bad = r.filter(x => x.prosecdef !== !PURE_FNS.includes(x.proname));
    return bad.length === 0 || bad.map(x => x.proname + ':' + x.prosecdef).join(', ');
  });
  await check('no new function is executable by PUBLIC or anon', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE ((n.nspname = 'app' AND p.proname LIKE 'g7\\_%') OR (n.nspname = 'public' AND p.proname = ANY ($1)))
                          AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR coalesce(array_to_string(p.proacl, ','), '=X') ~ '(^|,)=X')`,
      [RPC_SIGS.map(s => s.split('(')[0])]);
    return r.length === 0 || r.map(x => x.proname).join(', ');
  });
  await check('app.g7_* helpers / trigger functions are not executable by authenticated', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'app' AND p.proname LIKE 'g7\\_%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`);
    return r.length === 0 || r.map(x => x.proname).join(', ');
  });
  await expectErr('authenticated cannot call app.g7_bump directly', () => as('adminA', `SELECT app.g7_bump($1, 'transactions_month', -5, false)`, [A]), /permission denied/);
  await expectErr('authenticated cannot call app.g7_recount directly', () => as('pa', `SELECT app.g7_recount($1)`, [A]), /permission denied/);
  await check('the 9 RPCs are executable by authenticated', async () => {
    const r = await q(`SELECT count(*)::int n FROM unnest($1::text[]) s WHERE has_function_privilege('authenticated', ('public.' || s)::regprocedure, 'EXECUTE')`, [RPC_SIGS]);
    return r[0].n === 9 || 'only ' + r[0].n;
  });
  await check('audit trigger (app.tg_audit) on plans and org_subscriptions; trg_touch on both', async () => {
    const r = await q(`SELECT c.relname || '.' || t.tgname || ':' || p.proname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
                        WHERE c.relname IN ('plans','org_subscriptions') AND t.tgname IN ('trg_audit','trg_touch') ORDER BY 1`);
    return r.map(x => x.x).join(',') === 'org_subscriptions.trg_audit:tg_audit,org_subscriptions.trg_touch:touch_updated_at,plans.trg_audit:tg_audit,plans.trg_touch:touch_updated_at' || r.map(x => x.x).join(',');
  });
  await check('subscription_events / org_usage_counters carry no audit trigger (append-only log / derived cache)', async () =>
    (await num(`SELECT count(*) n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname IN ('subscription_events','org_usage_counters') AND t.tgname = 'trg_audit'`)) === 0);
  await expectErr('subscription_events: UPDATE (owner) → MRS_APPEND_ONLY', () => q(`UPDATE public.subscription_events SET reason = 'x'`), /MRS_APPEND_ONLY/);
  await expectErr('subscription_events: DELETE (owner) → MRS_APPEND_ONLY', () => q(`DELETE FROM public.subscription_events`), /MRS_APPEND_ONLY/);
  await expectErr('subscription_events: TRUNCATE (owner) → MRS_APPEND_ONLY', () => q(`TRUNCATE public.subscription_events`), /MRS_APPEND_ONLY/);
  await check('the 15 trg_g7_* triggers exist on the 12 create-path tables + storage.objects', async () => {
    const r = await q(`SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname LIKE 'trg\\_g7\\_%' ORDER BY 1, 2`);
    const got = r.map(x => x.relname + '.' + x.tgname).sort(), exp = G7_TRIGGERS.map(x => x[0] + '.' + x[1]).sort();
    return J(got) === J(exp) || J(got);
  });
  await check('CHECK limit_overrides: app.g7_overrides_valid accepts {} / known keys, refuses unknown key, negative, fraction, string, array, > 10^9', async () => {
    const r = await one(`SELECT app.g7_overrides_valid('{}') a, app.g7_overrides_valid('{"users":3,"storage_mb":0}') b, app.g7_overrides_valid('{"seats":3}') c,
       app.g7_overrides_valid('{"users":-1}') d, app.g7_overrides_valid('{"users":1.5}') e, app.g7_overrides_valid('{"users":"3"}') f,
       app.g7_overrides_valid('[]') g, app.g7_overrides_valid('{"users":1000000001}') h, app.g7_overrides_valid('{"users":null}') i`);
    return (r.a && r.b && !r.c && !r.d && !r.e && !r.f && !r.g && !r.h && !r.i) || J(r);
  });
  await check('app.g7_period: calendar month in Asia/Riyadh (23:30 UTC on Oct 31 = Nov 1 in Riyadh)', async () => {
    const r = await one(`SELECT app.g7_period('2026-10-31T23:30:00Z')::text a, app.g7_period('2026-10-31T20:30:00Z')::text b`);
    return (r.a === '2026-11-01' && r.b === '2026-10-01') || J(r);
  });
  await check('trial without period_end is refused by the table CHECK', async () =>
    /org_subscriptions_trial_end/.test(await tryErr(() => q(`UPDATE public.org_subscriptions SET status = 'trial', period_end = NULL WHERE org_id = $1`, [B]))));
}

async function secInert() {
  section('inert default: pilot (unlimited) lets every create path pass');
  const tx0 = await counter(A, 'transactions_month');
  await check('pilot: 100 direct transaction inserts pass and are counted (+100)', async () => {
    await q(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode)
             SELECT $1, $2, $3, 'import', 'sea' FROM generate_series(1, 100)`, [A, JED, CL101]);
    return (await counter(A, 'transactions_month')) === tx0 + 100 || 'counter ' + await counter(A, 'transactions_month');
  });
  await check('pilot: convert_request_to_transaction passes', async () => {
    const r = await P.convert('opsA', await newRequest(A, JED), JED, CL101);
    return (r && r.transaction_id && (await counter(A, 'transactions_month')) === tx0 + 101) || J(r);
  });
  await check('pilot: admin_add_member ×3 (new staff users) pass', async () => {
    for (const k of ['extraA1', 'extraA2', 'extraA3']) await P.addMember('adminA', A, EMAIL(k), 'clearance_staff', JED);
    return (await usageOf(A)).users === 11 || J(await usageOf(A));
  });
  await check('pilot: admin_create_branch ×3 pass', async () => {
    for (const c of ['RUH', 'MED', 'TIF']) await P.createBranch('adminA', A, { code: c, name_ar: 'فرع ' + c });
    return (await usageOf(A)).branches === 5 || J(await usageOf(A));
  });
  await check('pilot: staff invitation + documents pass; over_limit empty', async () => {
    await P.invite('adminA', A, { email: 'newstaff@g7sub.example.com', role: 'clearance_staff', branch_id: JED });
    await docAs('clrA', A, TXA1, 20000000);
    const u = await usageOf(A);
    return (u.over_limit.length === 0 && u.storage_mb === 20) || J(u);
  });
}

async function secPlansRpc() {
  section('platform_list_plans / platform_save_plan');
  await check('platform_list_plans: 4 seed plans sorted, limits with six keys, orgs count, price null', async () => {
    const r = await P.plans('pa');
    const pilot = r.find(x => x.code === 'pilot');
    return (r.map(x => x.code).join(',') === 'pilot,basic,pro,enterprise' && Object.keys(pilot.limits).sort().join(',') ===
      'ai_runs_month,branches,messages_month,storage_mb,transactions_month,users' && pilot.orgs === 3 && pilot.price_monthly_sar === null) || J(r);
  });
  await expectErr('save_plan: bad code → MRS_INVALID code', () => P.savePlan('pa', 'Bad-Code', { name_ar: 'باقة' }), /MRS_INVALID code/);
  await expectErr('save_plan: new plan without name_ar → MRS_REQUIRED name_ar', () => P.savePlan('pa', 'tiny', { limits: {} }), /MRS_REQUIRED name_ar/);
  await expectErr('save_plan: negative limit → MRS_INVALID users', () => P.savePlan('pa', 'tiny', { name_ar: 'صغيرة', limits: { users: -1 } }), /MRS_INVALID users/);
  await expectErr('save_plan: fractional limit → MRS_INVALID storage_mb', () => P.savePlan('pa', 'tiny', { name_ar: 'صغيرة', limits: { storage_mb: 1.5 } }), /MRS_INVALID storage_mb/);
  await expectErr('save_plan: unknown limit key → MRS_INVALID limits', () => P.savePlan('pa', 'tiny', { name_ar: 'صغيرة', limits: { seats: 1 } }), /MRS_INVALID limits/);
  await expectErr('save_plan: unknown payload key → MRS_INVALID unknown_key', () => P.savePlan('pa', 'tiny', { name_ar: 'صغيرة', code: 'x' }), /MRS_INVALID unknown_key/);
  await expectErr('save_plan: negative price → MRS_INVALID price_monthly_sar', () => P.savePlan('pa', 'tiny', { name_ar: 'صغيرة', price_monthly_sar: -1 }), /MRS_INVALID price_monthly_sar/);
  const tiny = await step('save_plan: create "tiny" (users 3, branches 2, tx 3, storage 1 MB, messages 1, AI 1)', () => P.savePlan('pa', 'tiny',
    { name_ar: 'باقة اختبار صغيرة', name_en: 'Tiny test plan', sort: 90, limits: { users: 3, branches: 2, transactions_month: 3, storage_mb: 1, messages_month: 1, ai_runs_month: 1 } }));
  await check('save_plan result: created, limits as given, price null, orgs 0', () =>
    (tiny.created === true && Object.entries({ users: 3, branches: 2, transactions_month: 3, storage_mb: 1, messages_month: 1, ai_runs_month: 1 }).every(([k, v]) => tiny.limits[k] === v)
      && tiny.price_monthly_sar === null && tiny.orgs === 0) || J(tiny));
  await check('save_plan update: partial (price placeholder, one limit to unlimited) keeps the other fields', async () => {
    const r = await P.savePlan('pa', 'tiny', { price_monthly_sar: 0, limits: { ai_runs_month: null } });
    const r2 = await P.savePlan('pa', 'tiny', { price_monthly_sar: null, limits: { ai_runs_month: 1 } });
    return (r.created === false && r.name_ar === 'باقة اختبار صغيرة' && r.limits.users === 3 && r.limits.ai_runs_month === null && Number(r.price_monthly_sar) === 0
      && r2.limits.ai_runs_month === 1 && r2.price_monthly_sar === null) || J(r);
  });
  await expectErr('save_plan: deactivating pilot → MRS_BAD_TRANSITION pilot_required', () => P.savePlan('pa', 'pilot', { is_active: false }), /MRS_BAD_TRANSITION pilot_required/);
  await step('save_plan: create inactive plan "legacy"', () => P.savePlan('pa', 'legacy', { name_ar: 'باقة قديمة', is_active: false, limits: { users: 1 } }));
  await check('plans are audited (audit_log rows for plans: INSERT tiny, UPDATE tiny, INSERT legacy), org_id NULL', async () => {
    const r = await q(`SELECT action, new_data ->> 'code' code, org_id, actor FROM public.audit_log WHERE table_name = 'plans' AND new_data ->> 'code' IN ('tiny','legacy') ORDER BY id`);
    return (r.filter(x => x.code === 'tiny').length === 3 && r.some(x => x.code === 'legacy' && x.action === 'INSERT') && r.every(x => x.org_id === null)
      && r.every(x => x.actor === U.pa)) || J(r);
  });
}

async function secOrgCreate() {
  section('new org (platform_create_org untouched) → AFTER INSERT subscription pilot / active');
  const r = await step('platform_create_org: org T (prefix TST, branch T1)', () => P.createOrg('pa', { slug: 'org-g7a-t', name_ar: 'مؤسسة ت للاشتراكات', ref_prefix: 'TST',
    admin_email: EMAIL('adminT'), branch: { code: 'T1', name_ar: 'الفرع الأول' } }));
  S.T = r.org_id; S.T1 = r.branch_id;
  await check('new org: subscription pilot / active, period_start today (Riyadh), event created by the platform admin', async () => {
    const s = await sub(S.T);
    const e = await one(`SELECT actor, action, to_plan, to_status, detail FROM public.subscription_events WHERE org_id = $1`, [S.T]);
    const today = (await one(`SELECT (now() AT TIME ZONE 'Asia/Riyadh')::date::text d`)).d;
    return (s.plan_code === 'pilot' && s.status === 'active' && s.period_end === null && s.period_start.toISOString().slice(0, 10) === today
      && e.actor === U.pa && e.action === 'created' && e.detail.source === 'org_created') || J({ s, e });
  });
  await check('new org subscription row is audited (org_subscriptions INSERT with org_id)', async () =>
    (await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'org_subscriptions' AND org_id = $1 AND action = 'INSERT'`, [S.T])) === 1);
  await step('org T admin accepts the platform invitation', () => P.accept('adminT', r.token));
  await q(`INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ($1, $2, 'business', 'عميل ت السري', '0508888888')`, [T_CL, S.T]);
}

async function secSetPlan() {
  section('platform_set_org_plan: validation, events, idempotency');
  await expectErr('unknown org → MRS_NOT_FOUND', () => P.setPlan('pa', ID(0xdead), { plan_code: 'tiny', reason: 'x' }), /MRS_NOT_FOUND/);
  await expectErr('unknown plan → MRS_INVALID plan_code', () => P.setPlan('pa', S.T, { plan_code: 'nope', reason: 'x' }), /MRS_INVALID plan_code/);
  await expectErr('inactive plan → MRS_INVALID plan_inactive', () => P.setPlan('pa', S.T, { plan_code: 'legacy', reason: 'x' }), /MRS_INVALID plan_inactive/);
  await expectErr('status suspended → MRS_BAD_TRANSITION use_suspend', () => P.setPlan('pa', S.T, { status: 'suspended', reason: 'x' }), /MRS_BAD_TRANSITION use_suspend/);
  await expectErr('status cancelled → MRS_BAD_TRANSITION use_suspend', () => P.setPlan('pa', S.T, { status: 'cancelled', reason: 'x' }), /MRS_BAD_TRANSITION use_suspend/);
  await expectErr('status bogus → MRS_INVALID status', () => P.setPlan('pa', S.T, { status: 'gold', reason: 'x' }), /MRS_INVALID status/);
  await expectErr('trial without period_end → MRS_INVALID period', () => P.setPlan('pa', S.T, { status: 'trial', reason: 'x' }), /MRS_INVALID period/);
  await expectErr('period_end before period_start → MRS_INVALID period', () => P.setPlan('pa', S.T, { period_start: '2026-11-10', period_end: '2026-11-01', reason: 'x' }), /MRS_INVALID period/);
  await expectErr('malformed date → MRS_INVALID period', () => P.setPlan('pa', S.T, { period_start: '2026-13-45', reason: 'x' }), /MRS_INVALID period/);
  await expectErr('limit_overrides unknown key → MRS_INVALID limit_overrides', () => P.setPlan('pa', S.T, { limit_overrides: { seats: 1 }, reason: 'x' }), /MRS_INVALID limit_overrides/);
  await expectErr('limit_overrides negative → MRS_INVALID limit_overrides', () => P.setPlan('pa', S.T, { limit_overrides: { users: -2 }, reason: 'x' }), /MRS_INVALID limit_overrides/);
  await expectErr('no reason → MRS_NOTE_REQUIRED reason', () => P.setPlan('pa', S.T, { plan_code: 'tiny' }), /MRS_NOTE_REQUIRED reason/);
  await expectErr('blank reason → MRS_NOTE_REQUIRED reason', () => P.setPlan('pa', S.T, { plan_code: 'tiny', reason: '   ' }), /MRS_NOTE_REQUIRED reason/);
  await expectErr('unknown payload key → MRS_INVALID unknown_key', () => P.setPlan('pa', S.T, { plan_code: 'tiny', reason: 'x', price: 1 }), /MRS_INVALID unknown_key/);
  await check('a refused call changed nothing (still pilot, no new event)', async () => (await sub(S.T)).plan_code === 'pilot' && (await events(S.T)) === 1);
  const k = newKey();
  const pl = { plan_code: 'tiny', status: 'active', reason: 'تجربة باقة صغيرة' };
  const r = await step('set plan tiny (idempotency key)', () => P.setPlan('pa', S.T, pl, k));
  await check('result: {subscription (plan tiny, limits), usage (6 keys), over_limit []}', () =>
    (r.subscription.plan_code === 'tiny' && r.subscription.limits.users === 3 && r.usage.users === 1 && r.usage.branches === 1
      && Array.isArray(r.over_limit) && r.over_limit.length === 0 && Object.keys(r.usage).length === 6 && !('price_monthly_sar' in r.subscription)) || J(r));
  await check('event plan_changed pilot → tiny with reason and actor; audit UPDATE org_subscriptions', async () => {
    const e = await one(`SELECT * FROM public.subscription_events WHERE org_id = $1 AND action = 'plan_changed'`, [S.T]);
    const a = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'org_subscriptions' AND org_id = $1 AND action = 'UPDATE'`, [S.T]);
    return (e && e.from_plan === 'pilot' && e.to_plan === 'tiny' && e.reason === 'تجربة باقة صغيرة' && e.actor === U.pa && a === 1) || J({ e, a });
  });
  await check('idempotent replay (same key, same payload) → replayed, no second event', async () => {
    const x = await P.setPlan('pa', S.T, pl, k);
    return (x.replayed === true && (await events(S.T, 'plan_changed')) === 1) || J(x);
  });
  await expectErr('same key, different payload → MRS_IDEMPOTENCY_CONFLICT', () => P.setPlan('pa', S.T, { plan_code: 'basic', reason: 'x' }, k), /MRS_IDEMPOTENCY_CONFLICT/);
  await check('limits_changed event when only overrides change; status_changed / period_changed recorded separately', async () => {
    await P.setPlan('pa', S.T, { limit_overrides: { ai_runs_month: 1 }, reason: 'تجاوز صريح' });
    await P.setPlan('pa', S.T, { limit_overrides: {}, reason: 'إزالة التجاوز' });
    return (await events(S.T, 'limits_changed')) === 2 && (await events(S.T, 'status_changed')) === 0 && (await events(S.T, 'period_changed')) === 0;
  });
}

const S = {};
async function secUsers() {
  section('users limit (tiny: 3): admin_invite, accept_invitation, admin_add_member, reactivation, second role, client');
  const inv1 = await step('invite clearance staff (users 1 < 3)', () => P.invite('adminT', S.T, { email: EMAIL('clrT'), role: 'clearance_staff', branch_id: S.T1 }));
  const inv2 = await step('invite transport staff (pending invitations do not count)', () => P.invite('adminT', S.T, { email: EMAIL('lateT'), role: 'transport_staff', branch_id: S.T1 }));
  await step('accept_invitation (clrT) → users 2', () => P.accept('clrT', inv1.token));
  await step('admin_add_member (opsT, operations manager) → users 3', () => P.addMember('adminT', S.T, EMAIL('opsT'), 'operations_manager'));
  await check('usage users = 3 (live distinct active staff)', async () => (await usageOf(S.T)).users === 3 || J(await usageOf(S.T)));
  await expectErr('admin_invite of another staff user at the limit → MRS_PLAN_LIMIT users', () =>
    P.invite('adminT', S.T, { email: EMAIL('xT'), role: 'accountant', branch_id: S.T1 }), /MRS_PLAN_LIMIT users/);
  await check('the refused invitation left no row', async () => (await num(`SELECT count(*) n FROM public.invitations WHERE email = $1`, [EMAIL('xT')])) === 0);
  await expectErr('admin_add_member of a new user at the limit → MRS_PLAN_LIMIT users', () => P.addMember('adminT', S.T, EMAIL('xT'), 'supervisor'), /MRS_PLAN_LIMIT users/);
  await expectErr('accept_invitation at the limit → MRS_PLAN_LIMIT users', () => P.accept('lateT', inv2.token), /MRS_PLAN_LIMIT users/);
  await check('refused accept: no membership, invitation still pending, users still 3', async () => {
    const m = await num(`SELECT count(*) n FROM public.memberships WHERE user_id = $1`, [U.lateT]);
    const i = await one(`SELECT accepted_at FROM public.invitations WHERE id = $1`, [inv2.invitation_id]);
    return (m === 0 && i.accepted_at === null && (await usageOf(S.T)).users === 3) || J({ m, i });
  });
  await check('second role of an already counted user is not double-counted (admin_add_member clrT transport_staff passes)', async () => {
    await P.addMember('adminT', S.T, EMAIL('clrT'), 'transport_staff', S.T1);
    return (await usageOf(S.T)).users === 3;
  });
  const cinv = await step('client-portal invitation at the limit passes (clients are not counted)', () =>
    P.invite('adminT', S.T, { email: EMAIL('clientT'), role: 'client', client_id: T_CL }));
  await step('client accepts at the limit', () => P.accept('clientT', cinv.token));
  await check('client membership exists; users still 3', async () =>
    (await num(`SELECT count(*) n FROM public.memberships WHERE user_id = $1 AND role = 'client' AND is_active`, [U.clientT])) === 1 && (await usageOf(S.T)).users === 3);
  await expectErr('role change client → staff at the limit (direct UPDATE) → MRS_PLAN_LIMIT users', () =>
    q(`UPDATE public.memberships SET role = 'supervisor' WHERE user_id = $1 AND org_id = $2`, [U.clientT, S.T]), /MRS_PLAN_LIMIT users/);
  const opsM = await one(`SELECT id FROM public.memberships WHERE user_id = $1 AND org_id = $2`, [U.opsT, S.T]);
  await step('deactivate opsT → users 2', () => P.setMember('adminT', opsM.id, false));
  await step('now accept_invitation (lateT) passes → users 3', () => P.accept('lateT', inv2.token));
  await expectErr('reactivating opsT at the limit → MRS_PLAN_LIMIT users', () => P.setMember('adminT', opsM.id, true), /MRS_PLAN_LIMIT users/);
  await check('opsT stays inactive; users 3', async () =>
    (await one(`SELECT is_active FROM public.memberships WHERE id = $1`, [opsM.id])).is_active === false && (await usageOf(S.T)).users === 3);
  S.opsMembership = opsM.id;
  // opsT is needed for the transaction checks: give the slot back through a raised override
  await P.setPlan('pa', S.T, { limit_overrides: { users: 4 }, reason: 'مقعد إضافي' });
  await step('with users override 4 the reactivation passes', () => P.setMember('adminT', opsM.id, true));
}

async function secBranches() {
  section('branches limit (tiny: 2): create, reactivate');
  const b2 = await step('admin_create_branch T2 (1 < 2)', () => P.createBranch('adminT', S.T, { code: 'T2', name_ar: 'الفرع الثاني' }));
  await expectErr('admin_create_branch T3 at the limit → MRS_PLAN_LIMIT branches', () => P.createBranch('adminT', S.T, { code: 'T3', name_ar: 'الفرع الثالث' }), /MRS_PLAN_LIMIT branches/);
  const b3 = await step('an inactive branch can still be created (not counted)', () => P.createBranch('adminT', S.T, { code: 'T3', name_ar: 'الفرع الثالث', is_active: false }));
  await expectErr('reactivating T3 at the limit → MRS_PLAN_LIMIT branches', () => P.updateBranch('adminT', b3.id, { is_active: true }), /MRS_PLAN_LIMIT branches/);
  await step('deactivate T2', () => P.updateBranch('adminT', b2.id, { is_active: false }));
  await step('now reactivating T3 passes', () => P.updateBranch('adminT', b3.id, { is_active: true }));
  await check('usage branches = 2 (live: active branches only)', async () => (await usageOf(S.T)).branches === 2 || J(await usageOf(S.T)));
}

async function secTransactions() {
  section('transactions limit (tiny: 3/month): convert, direct insert, rollback, import_commit, rollover');
  S.req = [];
  for (let i = 0; i < 4; i++) S.req.push(await newRequest(S.T, S.T1));
  const t1 = await step('convert #1', () => P.convert('opsT', S.req[0], S.T1, T_CL));
  S.ttx = t1.transaction_id;
  await step('convert #2', () => P.convert('opsT', S.req[1], S.T1, T_CL));
  await step('direct (SQL) insert #3', () => sqlTx(S.T, S.T1, T_CL));
  await check('counter transactions_month = 3', async () => (await counter(S.T, 'transactions_month')) === 3);
  const k = newKey();
  await expectErr('convert #4 at the limit → MRS_PLAN_LIMIT transactions_month', () => P.convert('opsT', S.req[3], S.T1, T_CL, k), /MRS_PLAN_LIMIT transactions_month/);
  await check('rollback: the refused convert left the counter at 3, the request unconverted, no transaction, no idempotency row', async () => {
    const r = await one(`SELECT status FROM public.service_requests WHERE id = $1`, [S.req[3]]);
    const t = await num(`SELECT count(*) n FROM public.transactions WHERE request_id = $1`, [S.req[3]]);
    const i = await num(`SELECT count(*) n FROM public.idempotency_keys WHERE key = $1`, [k]);
    return ((await counter(S.T, 'transactions_month')) === 3 && r.status !== 'converted' && t === 0 && i === 0) || J({ r, t, i });
  });
  await expectErr('direct insert at the limit → MRS_PLAN_LIMIT transactions_month', () => sqlTx(S.T, S.T1, T_CL), /MRS_PLAN_LIMIT transactions_month/);
  await check('rollback: counter still 3, transaction rows still 3', async () =>
    (await counter(S.T, 'transactions_month')) === 3 && (await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [S.T])) === 3);
  // import_commit exercised for real at the limit (review fix: the path was only grepped in the migration source)
  await check('import_commit at the limit: rows committed as service requests; transactions and the counter unchanged (3)', async () => {
    const fp = sha('g7-import-at-limit');
    const b = (await as('opsT', `INSERT INTO public.import_batches (org_id, file_name, file_fingerprint) VALUES ($1, 'legacy.xlsx', $2) RETURNING id`, [S.T, fp]))[0];
    const norm = bl => J({ fullName: 'عميل مستورد', company: 'شركة مستوردة', phone: '05571' + bl.slice(-5), clientType: 'business', direction: 'import',
      service: 'clearance', mode: 'sea', country: 'الصين', port: 'ميناء جدة الإسلامي', goods: 'بضاعة مستوردة', blNumber: bl, terms: true });
    await as('opsT', `INSERT INTO public.import_rows (batch_id, sheet_name, row_no, raw, normalized, row_status) VALUES
      ($1, 'Sheet1', 2, '{"r":2}', $2, 'valid'), ($1, 'Sheet1', 3, '{"r":3}', $3, 'valid')`, [b.id, norm('G7IMPBL00001'), norm('G7IMPBL00002')]);
    const r = await rpc('opsT', `SELECT public.import_commit($1) r`, [b.id]);
    const rows = await q(`SELECT row_status FROM public.import_rows WHERE batch_id = $1 ORDER BY row_no`, [b.id]);
    const tx = await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [S.T]);
    S.importedRef = r.items && r.items[0] && r.items[0].ref;
    return (r.committed === 2 && r.errors === 0 && rows.every(x => x.row_status === 'committed') && tx === 3
      && (await counter(S.T, 'transactions_month')) === 3) || J({ r, rows, tx });
  });
  await expectErr('converting an imported request at the limit → MRS_PLAN_LIMIT transactions_month (counter still 3)', async () => {
    const req = await one(`SELECT id FROM public.service_requests WHERE org_id = $1 AND ref = $2`, [S.T, S.importedRef]);
    return P.convert('opsT', req.id, S.T1, T_CL);
  }, /MRS_PLAN_LIMIT transactions_month/);
  await check('the live import_commit (pg_get_functiondef, not the migration file) records any MRS_* row failure as row_status error', async () => {
    const d = (await one(`SELECT pg_get_functiondef('public.import_commit(uuid)'::regprocedure) d`)).d;
    return (/EXCEPTION WHEN OTHERS THEN[\s\S]{0,400}row_status = 'error'[\s\S]{0,300}LIKE 'MRS\\_%'/.test(d) && (await counter(S.T, 'transactions_month')) === 3) || 'row error handler not found in the live function';
  });
  // period rollover: a back-dated row lands in its own month; the current month row is untouched
  await check('rollover: a back-dated (previous month) insert is keyed by its own month and does not touch the current month', async () => {
    const prev = (await one(`SELECT (app.g7_period(now()) - interval '1 month')::date::text p`)).p;
    await sqlTx(S.T, S.T1, T_CL, prev + 'T12:00:00+03:00');
    return ((await counter(S.T, 'transactions_month', prev)) === 1 && (await counter(S.T, 'transactions_month')) === 3) || 'prev/cur ' +
      (await counter(S.T, 'transactions_month', prev)) + '/' + (await counter(S.T, 'transactions_month'));
  });
  await P.setPlan('pa', S.T, { limit_overrides: { users: 4, transactions_month: 5 }, reason: 'رفع حد المعاملات' });
  await step('after raising the limit to 5 the same convert (same key) passes', () => P.convert('opsT', S.req[3], S.T1, T_CL, k));
  await check('rollover: current month 4, previous month still 1 (separate keys, never reset in place)', async () => {
    const prev = (await one(`SELECT (app.g7_period(now()) - interval '1 month')::date::text p`)).p;
    return (await counter(S.T, 'transactions_month')) === 4 && (await counter(S.T, 'transactions_month', prev)) === 1;
  });
  await check('recount agrees with the triggers (every trigger-kept counter unchanged; rows it adds are 0) and is idempotent', async () => {
    const before = await q(`SELECT metric, period_start::text p, value::text v FROM public.org_usage_counters WHERE org_id = $1 ORDER BY 1, 2`, [S.T]);
    const r1 = await P.recount('pa', S.T);
    const mid = await q(`SELECT metric, period_start::text p, value::text v FROM public.org_usage_counters WHERE org_id = $1 ORDER BY 1, 2`, [S.T]);
    const r2 = await P.recount('pa', S.T);
    const after = await q(`SELECT metric, period_start::text p, value::text v FROM public.org_usage_counters WHERE org_id = $1 ORDER BY 1, 2`, [S.T]);
    const key = x => x.metric + '@' + x.p;
    const bm = new Map(before.map(x => [key(x), x.v]));
    const ok = mid.every(x => bm.has(key(x)) ? bm.get(key(x)) === x.v : x.v === '0') && before.every(x => mid.some(y => key(y) === key(x)));
    return (ok && J(mid) === J(after) && r1.changed === false && r2.changed === false && (await events(S.T, 'recounted')) === 2) || J({ before, mid, r1 });
  });
  await check('recount repairs a drifted counter and records before / after', async () => {
    await q(`UPDATE public.org_usage_counters SET value = 99 WHERE org_id = $1 AND metric = 'transactions_month' AND period_start = app.g7_period(now())`, [S.T]);
    const r = await P.recount('pa', S.T);
    const e = await one(`SELECT detail FROM public.subscription_events WHERE org_id = $1 AND action = 'recounted' ORDER BY at DESC LIMIT 1`, [S.T]);
    return (r.changed === true && r.before.transactions_month === 99 && r.after.transactions_month === 4 && e.detail.before.transactions_month === 99
      && (await counter(S.T, 'transactions_month')) === 4) || J(r);
  });
}

async function secStorage() {
  section('storage limit (tiny: 1 MB): documents, finance_documents');
  await step('document 600 000 bytes (clearance staff, direct insert through RLS)', () => docAs('clrT', S.T, S.ttx, 600000));
  const before = await counter(S.T, 'storage_bytes');
  await expectErr('second document 600 000 bytes would exceed 1 MiB → MRS_PLAN_LIMIT storage_mb', () => docAs('clrT', S.T, S.ttx, 600000), /MRS_PLAN_LIMIT storage_mb/);
  await check('rollback: storage counter unchanged after the refusal', async () => (await counter(S.T, 'storage_bytes')) === before && before === 600000);
  await expectErr('finance document 500 000 bytes (register_finance_document) → MRS_PLAN_LIMIT storage_mb', () =>
    P.finDoc('adminT', { branch_id: S.T1, kind: 'supplier_invoice', original_name: 'inv.pdf', mime_type: 'application/pdf', size_bytes: 500000, sha256: sha('fin1') }), /MRS_PLAN_LIMIT storage_mb/);
  await step('finance document 400 000 bytes passes (1 000 000 ≤ 1 048 576)', () =>
    P.finDoc('adminT', { branch_id: S.T1, kind: 'supplier_invoice', original_name: 'inv.pdf', mime_type: 'application/pdf', size_bytes: 400000, sha256: sha('fin2') }));
  await check('usage storage_mb = ceil(1 000 000 / 1 MiB) = 1; storage_bytes counter 1 000 000', async () =>
    (await usageOf(S.T)).storage_mb === 1 && (await counter(S.T, 'storage_bytes')) === 1000000);
  await check('voiding keeps the bytes counted (cumulative)', async () => {
    await q(`UPDATE public.documents SET voided_at = now(), voided_by = $2, void_reason = 'اختبار' WHERE org_id = $1`, [S.T, U.adminT]);
    return (await counter(S.T, 'storage_bytes')) === 1000000;
  });
}

async function secMessaging() {
  section('messages / AI runs (org M): inbound + attachments counted never refused; send_msg_reply and request_msg_draft enforced');
  const CHM = 'inbox@org-g7a-m.example';
  const ch = await step('org M: mock e-mail channel (admin)', () => rpc('adminM', `SELECT public.save_msg_channel($1, $2, $3) r`,
    [M, { kind: 'email', name: 'بريد م', address: CHM, default_branch_id: M_BR, ingest_enabled: true, send_enabled: true, provider_terms_ack: true }, newKey()]));
  await rpc('adminM', `SELECT public.request_msg_channel_probe($1, $2) r`, [ch.id, newKey()]);
  await step('probe completed by the test worker (mock) → connected', async () => {
    await work(['probe']);
    const c = await one(`SELECT status FROM public.msg_channels WHERE id = $1`, [ch.id]);
    if (c.status !== 'connected') throw new Error('channel ' + c.status);
  });
  await P.setPlan('pa', M, { plan_code: 'tiny', reason: 'باقة صغيرة للرسائل', limit_overrides: { users: 10, messages_month: 1, ai_runs_month: 1, storage_mb: 1 } });
  const r1 = await step('inbound e-mail #1 with a 2 MiB attachment (storage limit 1 MB)', () => ingest(ch.id, [email({ from: 'agent@agent.example', to: CHM, subject: 'D/O',
    attachments: [{ provider_attachment_id: 'att-1', file_name: 'big.pdf', mime_type: 'application/pdf', size_bytes: 2097152 }] })]));
  S.mt1 = r1.items[0].thread_id;
  await check('attachment accepted and counted (storage 2 MiB > 1 MB limit, over_limit storage_mb)', async () => {
    const u = await usageOf(M);
    return ((await counter(M, 'storage_bytes')) === 2097152 && u.storage_mb === 2 && u.over_limit.includes('storage_mb')
      && (await num(`SELECT count(*) n FROM public.msg_attachments WHERE org_id = $1`, [M])) === 1) || J(u);
  });
  await check('message counted (messages_month 1)', async () => (await counter(M, 'messages_month')) === 1);
  const r2 = await step('inbound e-mail #2 over the messages limit is accepted (never refused)', () =>
    ingest(ch.id, [email({ from: 'other@agent2.example', to: CHM, subject: 'Freight' })]));
  S.mt2 = r2.items[0].thread_id;
  await check('inbound over limit: messages_month 2 > 1, over_limit messages_month, thread 2 distinct', async () => {
    const u = await usageOf(M);
    return ((await counter(M, 'messages_month')) === 2 && u.over_limit.includes('messages_month') && S.mt1 !== S.mt2) || J(u);
  });
  await step('process jobs completed (mock rule provider) — never refused at the AI limit', () => work(['process']));
  await check('AI process runs counted: ai_runs_month 2 > 1 (over_limit ai_runs_month)', async () => {
    const u = await usageOf(M);
    return ((await counter(M, 'ai_runs_month')) === 2 && (await num(`SELECT count(*) n FROM public.msg_ai_runs WHERE org_id = $1 AND kind = 'process'`, [M])) === 2
      && u.over_limit.includes('ai_runs_month')) || J(u);
  });
  const rep = await step('manual reply by clearance staff', () => rpc('clrM', `SELECT public.save_msg_reply(NULL, $1, $2) r`, [{ thread_id: S.mt1, body_text: 'We received your message.' }, newKey()]));
  const repId = rep.id || (rep.reply && rep.reply.id);
  const subm = await step('submitted', () => rpc('clrM', `SELECT public.submit_msg_reply($1) r`, [repId]));
  await step('approved by the org admin (four-eyes)', () => rpc('adminM', `SELECT public.decide_msg_reply($1, $2, 'approve', 'ok', false) r`, [repId, subm.current_version_id]));
  const sk = newKey();
  await expectErr('send_msg_reply at the messages limit → MRS_PLAN_LIMIT messages_month', () => rpc('clrM', `SELECT public.send_msg_reply($1, $2) r`, [repId, sk]), /MRS_PLAN_LIMIT messages_month/);
  await check('refused send: no outbound row, reply still approved, no send job', async () => {
    const o = await num(`SELECT count(*) n FROM public.msg_outbound WHERE org_id = $1`, [M]);
    const r = await one(`SELECT status FROM public.msg_replies WHERE id = $1`, [repId]);
    const j = await num(`SELECT count(*) n FROM public.msg_jobs WHERE org_id = $1 AND kind = 'send'`, [M]);
    return (o === 0 && r.status === 'approved' && j === 0) || J({ o, r, j });
  });
  await expectErr('request_msg_draft at the AI limit → MRS_PLAN_LIMIT ai_runs_month', () =>
    rpc('opsM', `SELECT public.request_msg_draft($1, $2, $3) r`, [S.mt2, { template_key: 'delivery_order', lang: 'en' }, newKey()]), /MRS_PLAN_LIMIT ai_runs_month/);
  await check('refused draft request: no draft job', async () => (await num(`SELECT count(*) n FROM public.msg_jobs WHERE org_id = $1 AND kind = 'draft'`, [M])) === 0);
  await P.setPlan('pa', M, { limit_overrides: { users: 10, messages_month: 100, ai_runs_month: 100, storage_mb: 1 }, reason: 'رفع الحدود' });
  await step('after raising the limits: send passes (same key)', () => rpc('clrM', `SELECT public.send_msg_reply($1, $2) r`, [repId, sk]));
  await step('after raising the limits: draft request passes', () => rpc('opsM', `SELECT public.request_msg_draft($1, $2, $3) r`, [S.mt2, { template_key: 'delivery_order', lang: 'en' }, newKey()]));
  await check('counters agree with a recount for org M (messages 2, AI 2, storage 2 MiB)', async () => {
    const r = await P.recount('pa', M);
    return (r.changed === false && r.after.messages_month === 2 && r.after.ai_runs_month === 2 && r.after.storage_bytes === 2097152) || J(r);
  });
}

async function secTrial() {
  section('trial expiry (G7-7): enforced creates refused trial_expired; reads, updates, status transitions keep working');
  const yest = (await one(`SELECT ((now() AT TIME ZONE 'Asia/Riyadh')::date - 1)::text d`)).d;
  await step('set org T to trial ending yesterday', () => P.setPlan('pa', S.T, { status: 'trial', period_start: '2026-01-01', period_end: yest, reason: 'تجربة منتهية' }));
  await check('events status_changed active → trial and period_changed recorded', async () =>
    (await events(S.T, 'status_changed')) === 1 && (await events(S.T, 'period_changed')) === 1);
  await expectErr('trial expired: convert → MRS_PLAN_INACTIVE trial_expired', async () => P.convert('opsT', await newRequest(S.T, S.T1), S.T1, T_CL), /MRS_PLAN_INACTIVE trial_expired/);
  await expectErr('trial expired: direct transaction insert → MRS_PLAN_INACTIVE trial_expired', () => sqlTx(S.T, S.T1, T_CL), /MRS_PLAN_INACTIVE trial_expired/);
  await expectErr('trial expired: staff invitation → MRS_PLAN_INACTIVE trial_expired', () =>
    P.invite('adminT', S.T, { email: 'trialstaff@g7sub.example.com', role: 'clearance_staff', branch_id: S.T1 }), /MRS_PLAN_INACTIVE trial_expired/);
  await expectErr('trial expired: document upload → MRS_PLAN_INACTIVE trial_expired', () => docAs('clrT', S.T, S.ttx, 10), /MRS_PLAN_INACTIVE trial_expired/);
  await expectErr('trial expired: new branch → MRS_PLAN_INACTIVE trial_expired', () => P.createBranch('adminT', S.T, { code: 'T9', name_ar: 'فرع جديد' }), /MRS_PLAN_INACTIVE trial_expired/);
  await check('trial expired: reads keep working (members list, transactions visible to staff)', async () => {
    const m = await rpc('adminT', `SELECT public.admin_list_members($1) r`, [S.T]);
    const t = await as('opsT', `SELECT id FROM public.transactions WHERE org_id = $1`, [S.T]);
    return (m.length >= 4 && t.length === 5) || J({ m: m.length, t: t.length });
  });
  await check('trial expired: updates and status transitions keep working (branch rename, transaction status)', async () => {
    const b = await P.updateBranch('adminT', S.T1, { name_ar: 'الفرع الأول المعدل' });
    const s = await rpc('opsT', `SELECT public.set_transaction_status($1, 'in_progress', NULL) r`, [S.ttx]);
    return (b.name_ar === 'الفرع الأول المعدل' && s.to === 'in_progress') || J({ b, s });
  });
  await check('org_subscription (org admin) shows status trial and the period end', async () => {
    const r = await P.orgSub('adminT', S.T);
    return (r.status === 'trial' && r.period_end === yest && r.plan_code === 'tiny') || J(r);
  });
  const tomorrow = (await one(`SELECT ((now() AT TIME ZONE 'Asia/Riyadh')::date + 30)::text d`)).d;
  await step('platform admin extends the trial', () => P.setPlan('pa', S.T, { period_end: tomorrow, reason: 'تمديد التجربة' }));
  await step('creates pass again after the extension (direct insert)', () => sqlTx(S.T, S.T1, T_CL));
  await step('switch back to active', () => P.setPlan('pa', S.T, { status: 'active', period_end: null, reason: 'تفعيل' }));
}

async function secSuspend() {
  section('suspend / activate (G7-1 blocked, G7-14 guard)');
  const tok = await rpc('opsT', `SELECT public.issue_tracking_token($1) r`, [S.ttx]);
  await check('before suspension: public tracking, client portal, staff access work', async () => {
    const p = await rpc('anon', `SELECT public.public_track($1, $2) r`, [tok.ref, tok.tracking_token]);
    const c = await as('clientT', `SELECT id FROM public.transactions WHERE org_id = $1`, [S.T]);
    const s = await as('opsT', `SELECT id FROM public.transactions WHERE org_id = $1`, [S.T]);
    return (p.ref === tok.ref && c.length >= 1 && s.length >= 6) || J({ p, c: c.length, s: s.length });
  });
  await expectErr('suspend without reason → MRS_NOTE_REQUIRED reason', () => P.suspend('pa', S.T, '  '), /MRS_NOTE_REQUIRED reason/);
  await expectErr('suspend unknown org → MRS_NOT_FOUND', () => P.suspend('pa', ID(0xdead), 'x'), /MRS_NOT_FOUND/);
  const r = await step('platform_suspend_org(T, reason)', () => P.suspend('pa', S.T, 'تأخر السداد (اختبار)'));
  await check('suspended: subscription suspended + suspended_at / by, organizations.is_active false, event suspended', async () => {
    const s = await sub(S.T);
    const o = await one(`SELECT is_active FROM public.organizations WHERE id = $1`, [S.T]);
    const e = await one(`SELECT * FROM public.subscription_events WHERE org_id = $1 AND action = 'suspended'`, [S.T]);
    return (r.unchanged === false && s.status === 'suspended' && s.suspended_by === U.pa && s.suspended_at && o.is_active === false
      && e.from_status === 'active' && e.to_status === 'suspended' && e.reason === 'تأخر السداد (اختبار)') || J({ r, s, o, e });
  });
  await check('suspend again → {unchanged:true}, no second event', async () => {
    const x = await P.suspend('pa', S.T, 'مرة أخرى');
    return (x.unchanged === true && (await events(S.T, 'suspended')) === 1) || J(x);
  });
  for (const who of ['adminT', 'opsT', 'clrT', 'lateT']) {
    await check(`suspended: ${who} sees no transaction rows`, async () => (await as(who, `SELECT id FROM public.transactions WHERE org_id = $1`, [S.T])).length === 0);
  }
  await expectErr('suspended: org admin RPC (admin_list_members) → MRS_FORBIDDEN', () => rpc('adminT', `SELECT public.admin_list_members($1) r`, [S.T]), /MRS_FORBIDDEN/);
  await expectErr('suspended: org_subscription for the org admin → MRS_NOT_FOUND', () => P.orgSub('adminT', S.T), /MRS_NOT_FOUND/);
  await check('suspended: client portal sees nothing', async () => (await as('clientT', `SELECT id FROM public.transactions`)).length === 0);
  await expectErr('suspended: public tracking → MRS_NOT_FOUND', () => rpc('anon', `SELECT public.public_track($1, $2) r`, [tok.ref, tok.tracking_token]), /MRS_NOT_FOUND/);
  await check('suspended: data kept (transactions, documents, memberships untouched)', async () =>
    (await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [S.T])) === 6 && (await num(`SELECT count(*) n FROM public.memberships WHERE org_id = $1 AND is_active`, [S.T])) >= 5);
  await expectErr('platform_set_org_active(true) on a suspended subscription → MRS_BAD_TRANSITION subscription_suspended', () => P.setActive('pa', S.T, true), /MRS_BAD_TRANSITION subscription_suspended/);
  await expectErr('direct owner UPDATE organizations.is_active = true → MRS_BAD_TRANSITION subscription_suspended', () =>
    q(`UPDATE public.organizations SET is_active = true WHERE id = $1`, [S.T]), /MRS_BAD_TRANSITION subscription_suspended/);
  await expectErr('API roles have no direct write path to organizations.is_active (platform admin UPDATE → permission denied)', () =>
    as('pa', `UPDATE public.organizations SET is_active = true WHERE id = $1 RETURNING 1`, [S.T]), /permission denied/);
  await expectErr('platform_set_org_plan on a suspended org → MRS_BAD_TRANSITION org_suspended', () => P.setPlan('pa', S.T, { plan_code: 'basic', reason: 'x' }), /MRS_BAD_TRANSITION org_suspended/);
  await check('platform RPCs keep working for a suspended org (list_subscriptions shows suspended, usage readable)', async () => {
    const l = (await P.subs('pa')).find(x => x.org_id === S.T);
    const u = await P.usage('pa', S.T);
    return (l.status === 'suspended' && l.is_active === false && u.current.transactions_month === 5) || J({ l, u: u.current });
  });
  await check('suspended → cancelled (p_cancel) records event cancelled', async () => {
    const x = await P.suspend('pa', S.T, 'إلغاء الاشتراك', true);
    return (x.status === 'cancelled' && (await events(S.T, 'cancelled')) === 1 && (await sub(S.T)).status === 'cancelled') || J(x);
  });
  await expectErr('activate without reason → MRS_NOTE_REQUIRED reason', () => P.activate('pa', S.T, ''), /MRS_NOTE_REQUIRED reason/);
  const a = await step('platform_activate_org(T, reason)', () => P.activate('pa', S.T, 'تمت التسوية'));
  await check('activated: status active, is_active true, suspended_at / by cleared, event activated', async () => {
    const s = await sub(S.T);
    const o = await one(`SELECT is_active FROM public.organizations WHERE id = $1`, [S.T]);
    const e = await one(`SELECT * FROM public.subscription_events WHERE org_id = $1 AND action = 'activated'`, [S.T]);
    return (a.unchanged === false && s.status === 'active' && s.suspended_at === null && s.suspended_by === null && o.is_active === true
      && e.from_status === 'cancelled' && e.to_status === 'active') || J({ a, s, o, e });
  });
  await check('the activation GUC does not leak out of platform_activate_org', async () =>
    ((await one(`SELECT coalesce(current_setting('app.g7_activating', true), '') v`)).v !== 'on'));
  await check('after activation: staff, client portal and public tracking work again', async () => {
    const p = await rpc('anon', `SELECT public.public_track($1, $2) r`, [tok.ref, tok.tracking_token]);
    const c = await as('clientT', `SELECT id FROM public.transactions WHERE org_id = $1`, [S.T]);
    const m = await rpc('adminT', `SELECT public.admin_list_members($1) r`, [S.T]);
    return (p.ref === tok.ref && c.length >= 1 && m.length >= 4) || J({ p, c: c.length });
  });
  await check('activate again → {unchanged:true}', async () => (await P.activate('pa', S.T, 'مرة أخرى')).unchanged === true);
  await check('audit trail: org_subscriptions UPDATE rows for suspend / cancel / activate; organizations is_active changes audited', async () => {
    const s = await q(`SELECT new_data ->> 'status' st FROM public.audit_log WHERE table_name = 'org_subscriptions' AND org_id = $1 AND action = 'UPDATE' ORDER BY id`, [S.T]);
    const o = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'organizations' AND org_id = $1 AND 'is_active' = ANY (changed_fields)`, [S.T]);
    const sts = s.map(x => x.st);
    return (sts.includes('suspended') && sts.includes('cancelled') && sts[sts.length - 1] === 'active' && o >= 2) || J({ sts, o });
  });
  await check('operational pause: platform_set_org_active(false) leaves the subscription active; (true) works', async () => {
    await P.setActive('pa', S.T, false);
    const s1 = (await sub(S.T)).status;
    await P.setActive('pa', S.T, true);
    return (s1 === 'active' && (await one(`SELECT is_active FROM public.organizations WHERE id = $1`, [S.T])).is_active === true) || s1;
  });
}

async function secDowngrade() {
  section('downgrade below current usage (G7-9)');
  const membersBefore = await num(`SELECT count(*) n FROM public.memberships WHERE org_id = $1 AND is_active`, [S.T]);
  const r = await step('downgrade T to users 1 / transactions 1 (reason given)', () =>
    P.setPlan('pa', S.T, { limit_overrides: { users: 1, transactions_month: 1 }, reason: 'تخفيض الباقة' }));
  await check('allowed; result over_limit lists users and transactions_month', () =>
    (r.over_limit.includes('users') && r.over_limit.includes('transactions_month') && !r.over_limit.includes('branches')) || J(r.over_limit));
  await check('nothing deleted or deactivated', async () =>
    (await num(`SELECT count(*) n FROM public.memberships WHERE org_id = $1 AND is_active`, [S.T])) === membersBefore
    && (await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [S.T])) === 6);
  await check('platform_list_subscriptions shows over_limit for T', async () => {
    const l = (await P.subs('pa')).find(x => x.org_id === S.T);
    return (l.over_limit.includes('users') && l.usage.users >= 4 && l.limits.users === 1) || J(l);
  });
  await expectErr('new enforced creates are refused after the downgrade (direct transaction) → MRS_PLAN_LIMIT', () => sqlTx(S.T, S.T1, T_CL), /MRS_PLAN_LIMIT transactions_month/);
  await check('existing users keep working after the downgrade (org admin reads members)', async () => (await rpc('adminT', `SELECT public.admin_list_members($1) r`, [S.T])).length >= 4);
}

/* ================================================================== review fixes (regressions) */
async function secPendingWork() {
  section('review fix: queued sends / draft jobs count against the monthly limits (org M, no worker run in between)');
  const ch = await one(`SELECT id, address_norm FROM public.msg_channels WHERE org_id = $1 LIMIT 1`, [M]);
  const r3 = await step('inbound e-mail #3 (new thread)', () => ingest(ch.id, [email({ from: 'third@agent3.example', to: ch.address_norm, subject: 'Customs' })]));
  S.mt3 = r3.items[0].thread_id;
  const r45 = await step('inbound e-mails #4 and #5 (two more threads, for draft requests)', () => ingest(ch.id, [
    email({ from: 'fourth@agent4.example', to: ch.address_norm, subject: 'Delivery order' }),
    email({ from: 'fifth@agent5.example', to: ch.address_norm, subject: 'Demurrage' })]));
  S.mt4 = r45.items[0].thread_id; S.mt5 = r45.items[1].thread_id;
  const approved = async (thread, body) => {
    const rep = await rpc('clrM', `SELECT public.save_msg_reply(NULL, $1, $2) r`, [{ thread_id: thread, body_text: body }, newKey()]);
    const id = rep.id || (rep.reply && rep.reply.id);
    const sb = await rpc('clrM', `SELECT public.submit_msg_reply($1) r`, [id]);
    await rpc('adminM', `SELECT public.decide_msg_reply($1, $2, 'approve', 'ok', false) r`, [id, sb.current_version_id]);
    return id;
  };
  const repA = await step('approved reply on thread 2', () => approved(S.mt2, 'Reply on thread two.'));
  const repB = await step('approved reply on thread 3', () => approved(S.mt3, 'Reply on thread three.'));
  const mUsed = await counter(M, 'messages_month');
  const mPend = Number((await one(`SELECT app.g7_pending($1, 'messages_month') n`, [M])).n);
  await check('a send still in flight (queued outbound, no msg_messages copy yet) is pending work', () => mPend >= 1 || 'pending ' + mPend);
  await P.setPlan('pa', M, { limit_overrides: { users: 10, messages_month: mUsed + mPend + 1, ai_runs_month: 100, storage_mb: 1 }, reason: 'حد = المستخدم + المعلق + 1' });
  await step('send #1 at limit − 1 (counting the pending send) passes', () => rpc('clrM', `SELECT public.send_msg_reply($1, $2) r`, [repA, newKey()]));
  await expectErr('send #2 before any worker run → MRS_PLAN_LIMIT messages_month (queued sends cannot overshoot)', () =>
    rpc('clrM', `SELECT public.send_msg_reply($1, $2) r`, [repB, newKey()]), /MRS_PLAN_LIMIT messages_month/);
  await check('refused send #2: no outbound row for that reply, counter unchanged', async () =>
    ((await num(`SELECT count(*) n FROM public.msg_outbound WHERE reply_id = $1`, [repB])) === 0 && (await counter(M, 'messages_month')) === mUsed) || 'outbound created');
  const aUsed = await counter(M, 'ai_runs_month');
  const aPend = Number((await one(`SELECT app.g7_pending($1, 'ai_runs_month') n`, [M])).n);
  await check('an unfinished draft job is pending AI work', () => aPend >= 1 || 'pending ' + aPend);
  await P.setPlan('pa', M, { limit_overrides: { users: 10, messages_month: mUsed + mPend + 1, ai_runs_month: aUsed + aPend + 1, storage_mb: 1 }, reason: 'حد الذكاء = المستخدم + المعلق + 1' });
  await step('draft request #1 (thread 4) at limit − 1 passes', () =>
    rpc('opsM', `SELECT public.request_msg_draft($1, $2, $3) r`, [S.mt4, { template_key: 'delivery_order', lang: 'en' }, newKey()]));
  await expectErr('draft request #2 (thread 5) before any worker run → MRS_PLAN_LIMIT ai_runs_month', () =>
    rpc('opsM', `SELECT public.request_msg_draft($1, $2, $3) r`, [S.mt5, { template_key: 'delivery_order', lang: 'en' }, newKey()]), /MRS_PLAN_LIMIT ai_runs_month/);
  await check('refused draft request: no draft job on thread 5', async () =>
    (await num(`SELECT count(*) n FROM public.msg_jobs WHERE org_id = $1 AND kind = 'draft' AND thread_id = $2`, [M, S.mt5])) === 0);
  await check('retry of a failed send is checked too (trg_g7_limit fires on msg_outbound failed → queued)', async () => {
    const t = await one(`SELECT tgtype FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'msg_outbound' AND t.tgname = 'trg_g7_limit'`);
    return (t && (t.tgtype & 16) === 16 && (t.tgtype & 4) === 4) || J(t);   // UPDATE + INSERT bits
  });
  await P.setPlan('pa', M, { limit_overrides: { users: 10, messages_month: 100, ai_runs_month: 100, storage_mb: 1 }, reason: 'رفع الحدود' });
}

async function secReviewFixes() {
  section('review fixes on org R: back-dated inserts, branch reactivation seats, declared object size, recount lock');
  await db.exec(`
    INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${R}', 'org-g7a-r', 'مؤسسة ر للمراجعة', 'TSR');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${R1}', '${R}', 'R1', 'فرع ر١'), ('${R2}', '${R}', 'R2', 'فرع ر٢');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${R_CL}', '${R}', 'business', 'عميل ر', '0508888888');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ('${U.rAdmin}', '${R}', NULL, 'admin'), ('${U.rOps}', '${R}', NULL, 'operations_manager');`);
  // 1. back-dated / forward-dated direct inserts
  await P.setPlan('pa', R, { limit_overrides: { transactions_month: 3 }, reason: 'حد صغير للمعاملات' });
  const insAs = async (who, at) => {
    const r = await as(who, `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, goods_description, created_at)
      VALUES ($1, $2, $3, 'import', 'sea', 'بضاعة', $4::timestamptz) RETURNING id`, [R, R1, R_CL, at]);
    return q(`SELECT id, created_at, app.g7_period(created_at)::text p FROM public.transactions WHERE id = $1`, [r[0].id]);
  };
  await step('ops writer direct insert #1 (no created_at given)', () => as('rOps', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, goods_description)
    VALUES ($1, $2, $3, 'import', 'sea', 'بضاعة') RETURNING id`, [R, R1, R_CL]));
  const cur = (await one(`SELECT app.g7_period(now())::text p`)).p;
  const b1 = await step('ops writer direct insert #2 with created_at 2020-01-15 (API caller)', () => insAs('rOps', '2020-01-15T10:00:00+03:00'));
  await check('the back-dated created_at was forced to now(): counted in the current month', async () =>
    (b1[0].p === cur && (await counter(R, 'transactions_month')) === 2) || J(b1[0]));
  const f1 = await step('ops writer direct insert #3 with created_at 2099-01-15 (API caller)', () => insAs('rOps', '2099-01-15T10:00:00+03:00'));
  await check('the forward-dated created_at was forced to now(): counter 3 = limit', async () =>
    (f1[0].p === cur && (await counter(R, 'transactions_month')) === 3) || J(f1[0]));
  await expectErr('at the limit a back-dated (2020-02-15) direct insert → MRS_PLAN_LIMIT transactions_month', () => insAs('rOps', '2020-02-15T10:00:00+03:00'), /MRS_PLAN_LIMIT transactions_month/);
  await expectErr('at the limit a forward-dated (2099) direct insert → MRS_PLAN_LIMIT transactions_month', () => insAs('rOps', '2099-03-15T10:00:00+03:00'), /MRS_PLAN_LIMIT transactions_month/);
  await check('R: 3 transaction rows, all in the current month; recount changes nothing', async () => {
    const n = await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1 AND app.g7_period(created_at) = app.g7_period(now())`, [R]);
    const rc = await P.recount('pa', R);
    return (n === 3 && (await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [R])) === 3 && rc.changed === false) || J({ n, rc });
  });
  await check('legacy import (SQL Editor / service role, not an API caller) keeps a historical created_at in its own month', async () => {
    const r = await one(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, goods_description, created_at)
      VALUES ($1, $2, $3, 'import', 'sea', 'بضاعة قديمة', '2020-01-15T10:00:00+03:00') RETURNING app.g7_period(created_at)::text p`, [R, R1, R_CL]);
    return (r.p === '2020-01-01' && (await counter(R, 'transactions_month', '2020-01-01')) === 1 && (await counter(R, 'transactions_month')) === 3) || J(r);
  });
  // 2. users: deactivate a branch, add users, reactivate
  await P.setPlan('pa', R, { limit_overrides: { transactions_month: 3, users: 4, branches: 5 }, reason: 'حد المستخدمين ٤' });
  await db.exec(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ('${U.rU1}', '${R}', '${R2}', 'clearance_staff'), ('${U.rU2}', '${R}', '${R2}', 'transport_staff');`);
  await check('R users = 4 (admin, ops, 2 in branch R2) = limit', async () => (await usageOf(R)).users === 4 || J(await usageOf(R)));
  await expectErr('a 5th user in R1 → MRS_PLAN_LIMIT users', () => q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, $3, 'accountant')`, [U.rU3, R, R1]), /MRS_PLAN_LIMIT users/);
  await step('org admin deactivates branch R2 (its 2 members stop counting)', () => P.updateBranch('rAdmin', R2, { is_active: false }));
  await step('two new users in R1 now pass (users 4)', () => q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, $3, 'accountant'), ($4, $2, $3, 'clearance_staff')`, [U.rU3, R, R1, U.rU4]));
  await expectErr('reactivating R2 would bring users to 6 > 4 → MRS_PLAN_LIMIT users', () => P.updateBranch('rAdmin', R2, { is_active: true }), /MRS_PLAN_LIMIT users/);
  await check('refused reactivation: R2 stays inactive, users still 4, nothing deleted', async () =>
    ((await one(`SELECT is_active FROM public.branches WHERE id = $1`, [R2])).is_active === false && (await usageOf(R)).users === 4
      && (await num(`SELECT count(*) n FROM public.memberships WHERE org_id = $1 AND is_active`, [R])) === 6) || J(await usageOf(R)));
  await P.setPlan('pa', R, { limit_overrides: { transactions_month: 3, users: 6, branches: 5 }, reason: 'حد المستخدمين ٦' });
  await step('with users 6 the reactivation of R2 passes (users 6 = limit)', () => P.updateBranch('rAdmin', R2, { is_active: true }));
  await check('R users = 6', async () => (await usageOf(R)).users === 6 || J(await usageOf(R)));
  await check('positive: reactivating a branch whose members are all counted elsewhere passes at the limit', async () => {
    await db.exec(`INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${R3}', '${R}', 'R3', 'فرع ر٣');
      INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ('${U.rU3}', '${R}', '${R3}', 'transport_staff');`);
    await P.updateBranch('rAdmin', R3, { is_active: false });
    await P.updateBranch('rAdmin', R3, { is_active: true });
    return (await usageOf(R)).users === 6 || J(await usageOf(R));
  });
  // 3. declared size vs the stored object
  const txR = (await one(`SELECT id FROM public.transactions WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`, [R])).id;
  const docR = await step('document registered with size_bytes 1000 (ops writer)', () => docAs('rOps', R, txR, 1000));
  const pathR = (await one(`SELECT storage_path FROM public.documents WHERE id = $1`, [docR])).storage_path;
  await expectErr('storage object of 5 MiB for a row that declared 1000 bytes → MRS_INVALID size_bytes', () =>
    q(`INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('documents', $1, $2, '{"size": 5242880, "mimetype": "application/pdf"}')`, [pathR, U.rOps]), /MRS_INVALID size_bytes/);
  await step('object whose metadata size equals the declared 1000 bytes is accepted', () =>
    q(`INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('documents', $1, $2, '{"size": 1000, "mimetype": "application/pdf"}')`, [pathR, U.rOps]));
  await expectErr('a later metadata update to a different size → MRS_INVALID size_bytes', () =>
    q(`UPDATE storage.objects SET metadata = '{"size": 26214400}' WHERE bucket_id = 'documents' AND name = $1`, [pathR]), /MRS_INVALID size_bytes/);
  await check('the upload policy path (authenticated uploader) is checked too', async () => {
    const d2 = await docAs('rOps', R, txR, 2000);
    const p2 = (await one(`SELECT storage_path FROM public.documents WHERE id = $1`, [d2])).storage_path;
    const e = await tryErr(() => as('rOps', `INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('documents', $1, $2, '{"size": 9999999}')`, [p2, U.rOps]));
    return /MRS_INVALID size_bytes/.test(e) || e;
  });
  await check('recount uses the real object size: an object stored before the check (trigger disabled) is counted at its real size', async () => {
    const d3 = await docAs('rOps', R, txR, 3000);
    const p3 = (await one(`SELECT storage_path FROM public.documents WHERE id = $1`, [d3])).storage_path;
    await db.exec(`ALTER TABLE storage.objects DISABLE TRIGGER trg_g7_object_size`);
    try { await q(`INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('documents', $1, $2, '{"size": 3000000}')`, [p3, U.rOps]); }
    finally { await db.exec(`ALTER TABLE storage.objects ENABLE TRIGGER trg_g7_object_size`); }
    const before = await counter(R, 'storage_bytes');
    const rc = await P.recount('pa', R);
    const after = await counter(R, 'storage_bytes');
    return (before === 6000 && after === 1000 + 2000 + 3000000 && rc.changed === true) || J({ before, after });
  });
  // 4. recount / bump serialization (single-connection PGlite: assert the locks are taken)
  await check('g7_bump takes the shared per-org usage lock; platform_recount_usage takes it exclusively first', async () => {
    const key = await one(`SELECT hashtext('marsa.g7.usage') a, hashtext($1::text) b`, [R]);
    const lockOf = async () => q(`SELECT mode FROM pg_locks WHERE locktype = 'advisory' AND classid = ($1::int)::oid AND objid = ($2::int)::oid AND objsubid = 2 AND granted`, [key.a, key.b]);
    await db.exec('BEGIN');
    let shared, excl;
    try {
      await q(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, goods_description, created_at)
        VALUES ($1, $2, $3, 'import', 'sea', 'بضاعة', '2020-02-15T10:00:00+03:00')`, [R, R1, R_CL]);
      shared = (await lockOf()).map(x => x.mode);
    } finally { await db.exec('ROLLBACK'); }
    await db.exec('BEGIN');
    try { await as('pa', `SELECT public.platform_recount_usage($1) r`, [R]); excl = (await lockOf()).map(x => x.mode); }
    finally { await db.exec('ROLLBACK'); }
    return (shared.includes('ShareLock') && excl.includes('ExclusiveLock')) || J({ shared, excl });
  });
}

async function secSuspendJobs() {
  section('review fix: a suspended org\'s queued worker jobs are paused (not cancelled) and released on activation');
  await q(`INSERT INTO public.billing_sync_jobs (org_id, kind, dedupe_key) VALUES ($1, 'probe', 'g7-suspend-probe')`, [M]);
  const queued = await num(`SELECT count(*) n FROM public.msg_jobs WHERE org_id = $1 AND status IN ('queued','unknown')`, [M]);
  await check('org M has queued messaging jobs (sends, drafts, process) and a queued Daftra job', async () => queued >= 3 || 'queued ' + queued);
  const r = await step('platform_suspend_org(M)', () => P.suspend('pa', M, 'تعليق مع أعمال معلقة'));
  await check('suspend paused every queued job of M (next_run_at = infinity) and recorded the counts in the event', async () => {
    const m = await num(`SELECT count(*) n FROM public.msg_jobs WHERE org_id = $1 AND status IN ('queued','unknown') AND next_run_at <> 'infinity'`, [M]);
    const b = await num(`SELECT count(*) n FROM public.billing_sync_jobs WHERE org_id = $1 AND status IN ('queued','unknown') AND next_run_at <> 'infinity'`, [M]);
    const e = await one(`SELECT detail FROM public.subscription_events WHERE org_id = $1 AND action = 'suspended' ORDER BY at DESC LIMIT 1`, [M]);
    const c = await num(`SELECT count(*) n FROM public.msg_jobs WHERE org_id = $1 AND status = 'cancelled'`, [M]);
    return (r.unchanged === false && m === 0 && b === 0 && e.detail.paused_msg_jobs === queued && e.detail.paused_billing_jobs === 1 && c === 0) || J({ m, b, e, c });
  });
  await check('service worker: msg_claim_jobs returns no job of the suspended org', async () => {
    const got = await claim(20);
    S.claimedOther = got.filter(x => x.job.org_id !== M);
    return got.every(x => x.job.org_id !== M) || J(got.map(x => x.job.kind + ':' + x.job.org_id));
  });
  for (const c of S.claimedOther || []) await complete(c.attempt_id, defaultResult(c)).catch(() => {});
  await check('service worker: daftra_claim_jobs returns no job of the suspended org', async () => {
    const got = await svc(`SELECT public.daftra_claim_jobs('g7w', 20) r`);
    return got.every(x => (x.job ? x.job.org_id : x.org_id) !== M) || J(got);
  });
  const a = await step('platform_activate_org(M)', () => P.activate('pa', M, 'إعادة التفعيل'));
  await check('activation released the paused jobs (claimable again: next_run_at <= now()) and recorded the counts', async () => {
    const m = await num(`SELECT count(*) n FROM public.msg_jobs WHERE org_id = $1 AND status IN ('queued','unknown') AND next_run_at > now()`, [M]);
    const b = await num(`SELECT count(*) n FROM public.billing_sync_jobs WHERE org_id = $1 AND status IN ('queued','unknown') AND next_run_at > now()`, [M]);
    const e = await one(`SELECT detail FROM public.subscription_events WHERE org_id = $1 AND action = 'activated' ORDER BY at DESC LIMIT 1`, [M]);
    return (a.unchanged === false && m === 0 && b === 0 && e.detail.released_msg_jobs === queued && e.detail.released_billing_jobs === 1) || J({ m, b, e });
  });
  await q(`UPDATE public.billing_sync_jobs SET status = 'cancelled' WHERE org_id = $1 AND dedupe_key = 'g7-suspend-probe'`, [M]);
}

async function secRoles() {
  section('roles: every platform RPC refused for all tenant roles + anon; org_subscription for the own org admin only');
  for (const [name, sql, params] of ALL_PLATFORM) {
    for (const role of Object.keys(ROLE_USERS)) {
      await expectErr(`${name}: ${role} → MRS_FORBIDDEN`, () => rpc(ROLE_USERS[role], sql, params), /MRS_FORBIDDEN/);
    }
    await expectErr(`${name}: anon → permission denied`, () => rpc('anon', sql, params), /permission denied/);
  }
  await check('org_subscription: own org admin → plan, status, limits, usage, over_limit; no price, no events', async () => {
    const r = await P.orgSub('adminA', A);
    return (r.plan_code === 'pilot' && r.status === 'active' && 'limits' in r && 'usage' in r && Array.isArray(r.over_limit)
      && !('price_monthly_sar' in r) && !('events' in r) && !J(r).includes('price')) || J(r);
  });
  for (const role of Object.keys(ROLE_USERS).filter(r => r !== 'admin')) {
    await expectErr(`org_subscription: ${role} of the org → MRS_NOT_FOUND`, () => P.orgSub(ROLE_USERS[role], A), /MRS_NOT_FOUND/);
  }
  await expectErr('org_subscription: admin of another org → MRS_NOT_FOUND', () => P.orgSub('adminB', A), /MRS_NOT_FOUND/);
  await expectErr('org_subscription: platform admin (not a member) → MRS_NOT_FOUND', () => P.orgSub('pa', A), /MRS_NOT_FOUND/);
  await expectErr('org_subscription: anon → permission denied', () => rpc('anon', `SELECT public.org_subscription($1) r`, [A]), /permission denied/);
  await expectErr('platform_org_usage: months 0 → MRS_INVALID months', () => P.usage('pa', A, 0), /MRS_INVALID months/);
  await expectErr('platform_org_usage: months 25 → MRS_INVALID months', () => P.usage('pa', A, 25), /MRS_INVALID months/);
  await expectErr('platform_org_usage: unknown org → MRS_NOT_FOUND', () => P.usage('pa', ID(0xdead)), /MRS_NOT_FOUND/);
  await expectErr('platform_recount_usage: unknown org → MRS_NOT_FOUND', () => P.recount('pa', ID(0xdead)), /MRS_NOT_FOUND/);
  await expectErr('platform_activate_org: unknown org → MRS_NOT_FOUND', () => P.activate('pa', ID(0xdead), 'x'), /MRS_NOT_FOUND/);
}

async function secPrivacy() {
  section('platform outputs contain counts only (G7-10)');
  const secrets = new Set();
  for (const r of await q(`SELECT ref FROM public.transactions UNION SELECT ref FROM public.service_requests`)) secrets.add(r.ref);
  for (const r of await q(`SELECT name_ar FROM public.clients UNION SELECT name_en FROM public.clients WHERE name_en IS NOT NULL`)) secrets.add(r.name_ar);
  for (const r of await q(`SELECT DISTINCT goods_description g FROM public.transactions WHERE goods_description IS NOT NULL`)) secrets.add(r.g);
  for (const r of await q(`SELECT original_name n FROM public.documents UNION SELECT original_name FROM public.finance_documents`)) secrets.add(r.n);
  for (const r of await q(`SELECT container_no c FROM public.containers`)) secrets.add(r.c);
  for (const r of await q(`SELECT subject s FROM public.msg_messages WHERE subject IS NOT NULL UNION SELECT from_address_norm FROM public.msg_messages WHERE from_address_norm IS NOT NULL`)) secrets.add(r.s);
  for (const r of await q(`SELECT email FROM auth.users WHERE email LIKE '%@g7sub.example.com' AND id <> $1`, [U.pa])) secrets.add(r.email);
  const tenantIds = (await q(`SELECT id::text id FROM public.transactions UNION SELECT id::text FROM public.clients UNION SELECT id::text FROM public.documents`)).map(r => r.id);
  const scan = (label, obj) => check(`${label}: no tenant ref / client name / goods / file name / container / message / user e-mail / row id`, () => {
    const s = J(obj);
    const hits = [...secrets].filter(x => x && x.length > 3 && s.includes(x)).concat(tenantIds.filter(x => s.includes(x)));
    return hits.length === 0 || 'leaks: ' + hits.slice(0, 5).join(', ');
  });
  await scan('platform_list_subscriptions', await P.subs('pa'));
  await scan('platform_list_plans', await P.plans('pa'));
  for (const org of [A, B, M]) await scan('platform_org_usage(' + (org === A ? 'A' : org === B ? 'B' : 'M') + ')', await P.usage('pa', org, 24));
  await scan('platform_recount_usage(M)', await P.recount('pa', M));
  await check('platform_org_usage: history of 24 months (newest first), limits, current usage, events newest first (≤ 50)', async () => {
    const u = await P.usage('pa', S.T, 24);
    return (u.history.length === 24 && u.history[0].period_start > u.history[1].period_start && u.current.transactions_month === 5 && u.history[1].transactions_month === 1
      && u.events.length > 5 && u.events.length <= 50 && u.events[0].at >= u.events[u.events.length - 1].at && 'limits' in u) || J(u.history.slice(0, 2));
  });
  await check('platform_list_subscriptions: one row per org with the documented keys', async () => {
    const l = await P.subs('pa');
    const keys = ['org_id', 'slug', 'name_ar', 'name_en', 'is_active', 'plan_code', 'plan_name_ar', 'plan_name_en', 'status', 'period_start', 'period_end',
      'trial_expired', 'limit_overrides', 'limits', 'usage', 'over_limit', 'status_reason', 'suspended_at', 'updated_at'];
    const orgs = await num(`SELECT count(*) n FROM public.organizations`);
    return (l.length === orgs && l.every(x => keys.every(k => k in x) && Object.keys(x).length === keys.length)) || J(l[0]);
  });
}

async function secFinalReconcile() {
  section('final reconciliation: counters = real rows for every org');
  for (const org of (await q(`SELECT id FROM public.organizations ORDER BY created_at, id`)).map(r => r.id)) {
    await check(`org ${org.slice(-4)}: monthly counters and storage_bytes equal a fresh recount (no drift)`, async () => {
      const before = await q(`SELECT metric, period_start, value FROM public.org_usage_counters WHERE org_id = $1 ORDER BY 1, 2`, [org]);
      await q(`SELECT app.g7_recount($1)`, [org]);
      const after = await q(`SELECT metric, period_start, value FROM public.org_usage_counters WHERE org_id = $1 ORDER BY 1, 2`, [org]);
      return J(before) === J(after) || J({ before, after });
    });
  }
}

async function dbMain() {
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  section('load shim + migrations (G7 held back) + seed + pre-G7 data');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!migFiles.includes(G7_MIGRATION)) { fail('G7 migration present', G7_MIGRATION + ' not found'); return; }
  if (migFiles[migFiles.length - 1] !== G7_MIGRATION) { fail('G7 migration is the latest', 'latest is ' + migFiles[migFiles.length - 1]); return; }
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return;
  for (const m of migFiles.filter(f => f !== G7_MIGRATION)) if (!await runFile(path.join(migDir, m), QUIET)) return;
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return;
  try { await preFixtures(); pass('pre-G7 fixtures: users, platform admin, org B with 2 transactions (one 2 months back) + document, document in A'); }
  catch (e) { fail('pre-G7 fixtures', errText(e)); return; }
  try { await secPreflightAndApply(); } catch (e) { fail('preflight / apply', errText(e)); return; }
  try { await fixtures(); pass('fixtures: 9 role users in A, org M with admin / clearance / ops'); }
  catch (e) { fail('fixtures', errText(e)); return; }
  const secs = [secCatalog, secInert, secPlansRpc, secOrgCreate, secSetPlan, secUsers, secBranches, secTransactions, secStorage, secMessaging,
    secPendingWork, secTrial, secSuspend, secDowngrade, secReviewFixes, secSuspendJobs, secRoles, secPrivacy, secFinalReconcile];
  for (const s of secs) {
    try { await s(); } catch (e) { fail(s.name, errText(e)); }
  }
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

dbMain().then(finish).catch(e => { console.error(e); process.exit(1); });
