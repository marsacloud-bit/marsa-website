#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 7 (Daftra alignment): migration 20261123000100_legacy_daftra.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws), no
  Daftra, no key: worker results are HANDCRAFTED here and sent as service_role (the job contract of
  docs/online/LEGACY_DAFTRA_AR.md «عقد المهام»).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal).

  Covers: file conventions + all_migrations.sql + docs + the owner decisions; preflight, re-run on itself (identical
  catalog), catalog delta; the KSA account guard (probe profile, claim fails write jobs, push gate); products by code
  without leading zeros (never created; unmapped block; match / confirm); CustomModel custom fields (map validation,
  values, custom_required, owner-only dry run); the opening zero draft on declaration approval (OFF by default, ON +
  idempotent, blocked / retry, failure isolation); the Riyadh date + read-back (date_mismatch, readback_mismatch,
  daftra_url); HF5 (manual_in_daftra items, push lock, done_in_daftra, policy guard on logged calls, no pull conflict,
  issued totals, owner-only policy flag); line descriptions / eligibility (TAS only, empty clearance, shared payment and
  internal transport cost excluded); client import (staging, proposals, apply, manual category kept, empty → aborted,
  never deletes) and import_clients; invoice lookup / confirm link (client conflict hard block, visual confirmation,
  > 1 match → review, issued → billed through the lifecycle) + client_mismatch on pull + legacy scan cursor + read-only
  refresh; cancel guard; supplier search + supplier links; purchase drafts (flag OFF by default, dedupe, id kept on a
  lost response); RLS (other org / branch / non-finance / client / anon), function privileges; supa.js wrappers, i18n.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-daftra-sql-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const MIG = '20261123000100_legacy_daftra.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in legacy-daftra-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';
const B = 'a7dd0000-0000-4000-8000-0000000000b0';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const CLIENT_A2 = 'a7d10000-0000-4000-8000-000000000102';
const CLIENT_OFF = 'a7d10000-0000-4000-8000-000000000103';
const BR_B = 'a7dd0000-0000-4000-8000-0000000000b1';
const CL_B = 'a7dd0000-0000-4000-8000-0000000000b3';
const SUP = 'a7d20000-0000-4000-8000-000000000001';
const CARRIER = 'a7d20000-0000-4000-8000-000000000002';
const U = {
  admin: 'a7df0000-0000-4000-8000-000000000001',    // admin of A, org-wide = the owner
  bmJ: 'a7df0000-0000-4000-8000-000000000002',      // branch_manager of A, JED only (approver there; not the owner)
  acc: 'a7df0000-0000-4000-8000-000000000003',      // accountant of A (org-wide): finance writer
  mgr: 'a7df0000-0000-4000-8000-000000000004',      // accounts_manager of A (org-wide): bill_admin + approver
  accJ: 'a7df0000-0000-4000-8000-000000000005',     // accountant of A, JED only
  accD: 'a7df0000-0000-4000-8000-000000000006',     // accountant of A, DMM only
  jed: 'a7df0000-0000-4000-8000-000000000007',      // clearance_staff of A, JED (ops writer, NOT finance)
  trJ: 'a7df0000-0000-4000-8000-000000000008',      // transport_staff of A, JED
  sup: 'a7df0000-0000-4000-8000-000000000009',      // supervisor of A (finance reader)
  ops: 'a7df0000-0000-4000-8000-00000000000a',      // operations_manager of A (import roles, not finance)
  portal: 'a7df0000-0000-4000-8000-00000000000b',   // client user of CLIENT_A
  staffB: 'a7df0000-0000-4000-8000-00000000000c'    // admin of B
};

/* ------------------------------------------------------------------ helpers */
let db;
let roleLock = Promise.resolve();
async function asRole(who, fn, aal) {
  const prev = roleLock;
  let release;
  roleLock = new Promise(r => { release = r; });
  await prev;
  try { return await asRoleNow(who, fn, aal); } finally { release(); }
}
async function asRoleNow(who, fn, aal) {
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
// 'MRS_X detail' (+ ' | hint' when withHint), 'chk:<name>', 'uniq:<name>', 'rls', 'perm'
async function code(fn, withHint) {
  try { await fn(); return 'ok'; } catch (e) {
    const m = e.message || '';
    if (/^MRS_/.test(m)) return m + (e.detail ? ' ' + e.detail : '') + (withHint && e.hint ? ' | ' + e.hint : '');
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
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
let keySeq = 0;
const newKey = () => 'a7dfaaab-0000-4000-8000-' + String(++keySeq).padStart(12, '0');
const H = s => crypto.createHash('sha256').update(String(s)).digest('hex');
let seq = 0;
const nx = p => p + '-' + (++seq);

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind IN ('r','v') ORDER BY 1`)).map(x => x.t);
  const idx = (await q(`SELECT indexname || ':' || md5(indexdef) x FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname || ':' || t.tgdeferrable x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('app','public') ORDER BY 1`)).map(x => x.x);
  const pol = (await q(`SELECT tablename || '.' || policyname x FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const con = (await q(`SELECT conrelid::regclass::text || '.' || conname || ':' || md5(pg_get_constraintdef(oid)) x FROM pg_constraint
                         WHERE connamespace = 'public'::regnamespace ORDER BY 1`)).map(x => x.x);
  const cols = (await q(`SELECT table_name || '.' || column_name x FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`)).map(x => x.x);
  const grants = (await q(`SELECT table_name || ':' || grantee || ':' || privilege_type x FROM information_schema.role_table_grants
                            WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','service_role') ORDER BY 1`)).map(x => x.x);
  const labels = (await q(`SELECT domain || '.' || code || ':' || sort || ':' || label_ar || ':' || client_visible x FROM public.status_labels ORDER BY 1`)).map(x => x.x);
  return { fns, tables, idx, trg, pol, con, cols, grants, labels };
}
const NEW_TABLES = ['public.daftra_client_import_rows', 'public.daftra_invoice_candidates', 'public.daftra_purchase_drafts', 'public.daftra_runs',
  'public.daftra_supplier_links'];
const NEW_FNS = ['app.daftra_account_block', 'app.daftra_account_check', 'app.daftra_allow_create', 'app.daftra_allow_update', 'app.daftra_apply_client_import',
  'app.daftra_apply_lookup', 'app.daftra_apply_product_match', 'app.daftra_apply_purchase', 'app.daftra_apply_run_error', 'app.daftra_apply_scan',
  'app.daftra_apply_supplier_search', 'app.daftra_candidate_json', 'app.daftra_check_client', 'app.daftra_client_check', 'app.daftra_code_norm',
  'app.daftra_custom_fields', 'app.daftra_custom_values', 'app.daftra_enqueue', 'app.daftra_fail_at_claim', 'app.daftra_import_apply',
  'app.daftra_import_apply_row', 'app.daftra_import_propose', 'app.daftra_import_roles', 'app.daftra_import_stage', 'app.daftra_invoice_match',
  'app.daftra_invoice_row', 'app.daftra_is_owner', 'app.daftra_item_mapped', 'app.daftra_line_meta', 'app.daftra_manual_refresh',
  'app.daftra_missing_caps', 'app.daftra_need_connection', 'app.daftra_opening_try', 'app.daftra_purchase_unreconciled', 'app.daftra_push_block', 'app.daftra_review_open',
  'app.daftra_run_json', 'app.daftra_setting_block', 'app.daftra_tx_keys', 'app.daftra_unmapped', 'app.daftra_write_kinds', 'app.tg_bill_line_hf5', 'app.tg_daftra_no_delete',
  'app.tg_daftra_opening',
  'public.apply_daftra_client_import', 'public.confirm_daftra_product_mapping', 'public.confirm_invoice_link', 'public.get_daftra_run',
  'public.import_clients', 'public.list_daftra_client_import', 'public.list_daftra_product_map', 'public.list_daftra_reviews',
  'public.list_daftra_supplier_links', 'public.refresh_tx_daftra', 'public.reject_invoice_candidate', 'public.request_daftra_client_import',
  'public.request_daftra_invoice_lookup', 'public.request_daftra_legacy_scan', 'public.request_daftra_product_match',
  'public.request_daftra_purchase_draft', 'public.request_daftra_supplier_search', 'public.resolve_daftra_review', 'public.retry_daftra_opening',
  'public.save_daftra_custom_fields', 'public.save_daftra_product_code', 'public.set_daftra_write_policy', 'public.test_daftra_custom_fields',
  'public.unlink_daftra_supplier'];
const RECREATED = ['app.bill_add_lines', 'app.bill_apply_probe', 'app.bill_apply_pull', 'app.bill_apply_push_ok', 'app.bill_can_read_job',
  'app.bill_check_item_key', 'app.bill_complete', 'app.bill_conn_block', 'app.bill_conn_json', 'app.bill_ctx_item', 'app.bill_eligible',
  'app.bill_item_defaults', 'app.bill_job_context', 'app.bill_job_json', 'app.bill_mark_issued', 'app.convert_delete_guards', 'app.convert_delete_tables',
  'app.tg_clients_legacy_guard', 'public.cancel_transaction', 'public.daftra_claim_jobs', 'public.daftra_complete_job', 'public.request_billing_push',
  'public.retry_billing_job', 'public.save_daftra_connection', 'public.tx_billing'];
const RPCS = ['apply_daftra_client_import', 'confirm_daftra_product_mapping', 'confirm_invoice_link', 'get_daftra_run', 'import_clients',
  'list_daftra_client_import', 'list_daftra_product_map', 'list_daftra_reviews', 'list_daftra_supplier_links', 'refresh_tx_daftra',
  'reject_invoice_candidate', 'request_daftra_client_import', 'request_daftra_invoice_lookup', 'request_daftra_legacy_scan',
  'request_daftra_product_match', 'request_daftra_purchase_draft', 'request_daftra_supplier_search', 'resolve_daftra_review', 'retry_daftra_opening',
  'save_daftra_custom_fields', 'save_daftra_product_code', 'set_daftra_write_policy', 'test_daftra_custom_fields', 'unlink_daftra_supplier'];
const CODES = ['MRS_DAFTRA_ACCOUNT_NOT_KSA', 'MRS_DAFTRA_UNMAPPED', 'MRS_DAFTRA_CUSTOM_REQUIRED', 'MRS_DAFTRA_DRAFT_LOCKED', 'MRS_DAFTRA_CLIENT_CONFLICT',
  'MRS_DAFTRA_PURCHASE_DISABLED', 'MRS_DAFTRA_CONFIRM_MISMATCH', 'MRS_DAFTRA_IMPORT'];
const NEW_TABLE_NAMES = NEW_TABLES.map(t => t.split('.')[1]);

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at)
    SELECT v.id::uuid, v.k || '@legacydaftra.example.com', now() FROM (VALUES
      ('${U.admin}','admin'),('${U.bmJ}','bmj'),('${U.acc}','acc'),('${U.mgr}','mgr'),('${U.accJ}','accj'),('${U.accD}','accd'),
      ('${U.jed}','jed'),('${U.trJ}','trj'),('${U.sup}','sup'),('${U.ops}','ops'),('${U.portal}','portal'),('${U.staffB}','staffb')) v(id, k);
  INSERT INTO public.profiles (id, full_name) SELECT u.id, split_part(u.email, '@', 1) FROM auth.users u WHERE u.email LIKE '%@legacydaftra.example.com'
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'legacydaftra-org-b', 'مؤسسة ب', 'Legacy daftra org B', 'LDB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES
    ('${CL_B}', '${B}', 'business', 'عميل ب', 'Client B Co', '0509990001'),
    ('${CLIENT_A2}', '${A}', 'business', 'مؤسسة الاختبار الثانية', 'Second Test Est', '0509990002'),
    ('${CLIENT_OFF}', '${A}', 'business', 'عميل موقوف للاختبار', 'Inactive Test Client', '0509990003');
  UPDATE public.clients SET is_active = false WHERE id = '${CLIENT_OFF}';
  INSERT INTO public.parties (id, org_id, kinds, name_ar) VALUES
    ('${SUP}', '${A}', ARRAY['supplier'], 'جهة الفاتورة التجريبية'),
    ('${CARRIER}', '${A}', ARRAY['carrier'], 'شركة النقل التجريبية');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.bmJ}', '${A}', '${JED}', 'branch_manager'), ('${U.acc}', '${A}', NULL, 'accountant'),
    ('${U.mgr}', '${A}', NULL, 'accounts_manager'), ('${U.accJ}', '${A}', '${JED}', 'accountant'), ('${U.accD}', '${A}', '${DMM}', 'accountant'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.trJ}', '${A}', '${JED}', 'transport_staff'), ('${U.sup}', '${A}', NULL, 'supervisor'),
    ('${U.ops}', '${A}', NULL, 'operations_manager'), ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
const svc = (sql, params) => as('service', sql, params).then(r => r[0].r);
let ctrSeq = 0;
const ctrNo = () => 'TSTU' + String(1000000 + (++ctrSeq)).slice(-7);
async function mkTx(o) {
  const x = Object.assign({ org: A, branch: JED, client: CLIENT_A, containers: 1 }, o || {});
  const bl = x.bl === undefined ? 'BLT' + (++seq) : x.bl;
  const tx = (await q(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, container_count, bl_number, port_code, goods_description, country)
                       VALUES ($1, $2, $3, 'import', 'sea', $4, $5, $6, $7, $8) RETURNING id, ref`,
    [x.org, x.branch, x.client, x.containers, bl, x.port === undefined ? 'SAJED' : x.port, x.goods || 'قطع غيار', x.country || 'الصين']))[0];
  const ctrs = [];
  for (let i = 0; i < x.containers; i++) {
    const c = ctrNo(); ctrs.push(c);
    await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [x.org, tx.id, c]);
  }
  return { id: tx.id, ref: tx.ref, org: x.org, bl, ctrs };
}
// a declaration through the staff RPC (the clearance staff of the branch): the deferred opening trigger runs at commit
const addDecl = (tx, no, who) => rpc(who || 'jed', `SELECT public.add_declaration($1, $2) r`,
  [tx.id, { declaration_no: no || nx('DCL'), declaration_type: 'استيراد', declaration_date: '2026-11-05', status: 'submitted' }]);
async function charge(tx, o) {
  const x = Object.assign({ kind: 'service', service: 'customs_clearance', price: 1000, vat: 15, desc: 'أجور التخليص' }, o || {});
  const v = Math.round(x.price * x.vat) / 100;
  return (await one(`INSERT INTO public.client_charges (org_id, transaction_id, kind, service_code, description, quantity, unit_price, net_amount,
                       vat_rate, vat_amount, total_amount, status) VALUES ($1, $2, $3, $4, $5, 1, $6::numeric, $6::numeric, $7::numeric, $8::numeric,
                       $6::numeric + $8::numeric, 'approved') RETURNING id`,
    [tx.org, tx.id, x.kind, x.service, x.desc, x.price, x.vat, v])).id;
}
// a linked Daftra client (owner SQL shortcut of link_daftra_client + its client_refresh job, tested in G5); a pending link
// created by an earlier push request is completed in place
async function linkClient(org, client, ext) {
  const ex = await one(`SELECT id FROM public.daftra_client_links WHERE org_id = $1 AND client_id = $2 AND status <> 'unlinked'`, [org, client]);
  if (ex) await q(`UPDATE public.daftra_client_links SET external_id = $2, status = 'linked', linked_at = now() WHERE id = $1`, [ex.id, ext]);
  else await q(`INSERT INTO public.daftra_client_links (org_id, client_id, client_ref, external_id, status, linked_at)
                VALUES ($1, $2, $4, $3, 'linked', now())`, [org, client, ext, 'MRSC-' + client]);
}
// a confirmed product mapping (owner SQL shortcut of save_daftra_product_code + match + confirm, tested separately below)
async function mapItem(org, key, codeV, ext) {
  await q(`SELECT app.bill_ensure_item($1, $2)`, [org, key]);
  await q(`UPDATE public.daftra_item_links SET remote_product_code = $3, remote_code_norm = app.daftra_code_norm($3), external_product_id = $4,
             status = 'linked' WHERE org_id = $1 AND item_key = $2 AND status <> 'retired'`, [org, key, codeV, ext]);
}
// park every due job except the given one, claim it, return its context
async function claimJob(jobId) {
  await q(`UPDATE public.billing_sync_jobs SET next_run_at = now() + interval '1 day' WHERE status IN ('queued','unknown') AND id <> $1`, [jobId]);
  await q(`UPDATE public.billing_sync_jobs SET next_run_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
  const ctxs = await svc(`SELECT public.daftra_claim_jobs('w-test', 20) r`);
  return ctxs.find(c => c.job.id === jobId) || null;
}
const complete = (ctx, result) => svc(`SELECT public.daftra_complete_job($1, $2) r`, [ctx.attempt_id, result]);
const jobOf = async id => one(`SELECT * FROM public.billing_sync_jobs WHERE id = $1`, [id]);
const lastJob = async (where, params) => one(`SELECT * FROM public.billing_sync_jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 1`, params);
const CAPS_ALL = async () => {
  const keys = (await one(`SELECT app.bill_capability_keys() k`)).k;
  const caps = {}; for (const k of keys) caps[k] = { supported: !['invoices.issue', 'credit_notes.create'].includes(k), evidence: 'test' };
  return caps;
};
const KSA = { currency: 'SAR', country: 'SA', taxes: [{ id: 1, value: 15, active: 1, included: 0 }, { id: 3, value: 5, active: 0 }] };
async function connect(org, who, account) {
  await rpc(who, `SELECT public.save_daftra_connection($1, $2) r`, [org, { sync_enabled: true }]);
  const job = await rpc(who, `SELECT public.request_daftra_probe($1) r`, [org]);
  const ctx = await claimJob(job.id);
  await complete(ctx, { outcome: 'ok', effects: { capabilities: await CAPS_ALL(), account: account === undefined ? KSA : account } });
}
let intentSeq = 0;
// an intent with lines + its push job claimed and completed 'ok' (created) → {intent, lines, ctx}
async function pushed(tx, o) {
  const x = Object.assign({ who: 'acc' }, o || {});
  const it = await rpc(x.who, `SELECT public.create_billing_intent($1) r`, [{ transaction_id: tx.id }]);
  const pr = await rpc(x.who, `SELECT public.request_billing_push($1) r`, [it.id]);
  const ctx = await claimJob(pr.job.id);
  const ext = 'inv-' + (++intentSeq);
  const h = H(ext);
  const lines = ctx.intent.lines;
  const res = await complete(ctx, { outcome: 'ok', effects: {
    intent_id: it.id, external_invoice_id: ext, found_by: 'created', daftra_status: 'draft', remote_state: 'draft', remote_version: '1',
    remote_hash: h, pushed_hash: h, remote_snapshot: { lines: lines.map(l => ({ line_ref: l.line_ref })) },
    remote_totals: { net: 0, vat: 0, total: lines.reduce((s, l) => s + Number(l.total_amount), 0) },
    line_results: lines.map((l, i) => ({ line_id: l.line_id, state: 'synced', remote_line_id: 'rl-' + intentSeq + '-' + i })),
    daftra_url: 'https://acct.example.test/owner/invoices/view/' + intentSeq,
    read_back: x.read_back || { date: ctx.intent.invoice_date, client_id: ctx.intent.client.external_id,
                                total: lines.reduce((s, l) => s + Number(l.total_amount), 0), line_count: lines.length } } });
  return { intent: await one(`SELECT * FROM public.billing_intents WHERE id = $1`, [it.id]), ctx, res, ext, hash: h };
}

/* ================================================================== 15. review regressions (step-7 review findings) */
const owner = (p, why) => rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, $3) r`, [A, p, why || 'test: owner setting']);
async function secReview() {
  section('15. review regressions: settings re-checked at retry / claim, purchase «possibly applied», owner-only settings, supplier links, HF5 issue, …');
  // --- purchase: a fresh trip of the linked carrier (s-1), flag ON (set in section 12)
  const tx2 = await mkTx({ containers: 1 });
  await addDecl(tx2, nx('DPR'));
  const trip2 = await one(`INSERT INTO public.transport_trips (org_id, transaction_id, carrier_id, party_type, party_name, status, container_id)
                            SELECT $1, $2, $3, 'company', 'شركة النقل التجريبية', 'delivered', k.id FROM public.containers k WHERE k.transaction_id = $2 LIMIT 1 RETURNING *`,
    [A, tx2.id, CARRIER]);
  const a0 = await one(`SELECT id FROM public.cost_accruals WHERE trip_id = $1`, [trip2.id]);
  if (a0) await q(`UPDATE public.cost_accruals SET amount = 500, supplier_id = $2, status = 'open' WHERE id = $1`, [a0.id, CARRIER]);
  else await q(`INSERT INTO public.cost_accruals (org_id, transaction_id, source, trip_id, supplier_id, service_code, amount, basis) VALUES ($1, $2, 'trip', $3, $4, 'transport', 500, 'agreed')`,
    [A, tx2.id, trip2.id, CARRIER]);
  await owner({ purchase_drafts_enabled: true });
  const pd = await rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip2.id, newKey()]);
  const pjob = pd.job.id;
  const pState = async () => one(`SELECT status, sync_state, external_purchase_id, last_error_code FROM public.daftra_purchase_drafts WHERE id = $1`, [pd.id]);
  await check('purchase context: the line carries the legacy description parts (transaction | client | declaration | container), ≤ 900', async () => {
    const ctx = await claimJob(pjob);
    const d = ctx.purchase.lines[0].description;
    const res = await complete(ctx, { outcome: 'unknown', effects: { purchase_id: pd.id }, error: { kind: 'timeout', code: 'timeout', message: 'lost' },
      calls: [{ op: 'createPurchaseDraft', applied: 'unknown' }] });
    return (d.startsWith('المعاملة: ' + tx2.ref + ' | العميل: ') && /\| البيان: DPR-/.test(d) && d.includes('| الحاوية: ' + tx2.ctrs[0]) && d.length <= 900
      && res.job_status === 'unknown') || J({ d, res });
  });
  await check('purchase «possibly applied» is sticky: a lost create, then a lookup that fails (retry) → still unknown; the next claim is previous_status unknown', async () => {
    const s1 = await pState();
    const ctx2 = await claimJob(pjob);
    await complete(ctx2, { outcome: 'retry', effects: { purchase_id: pd.id }, error: { kind: 'network', code: 'network', message: 'lookup failed' },
      calls: [{ op: 'findPurchaseByReference', applied: 'no' }] });
    const s2 = await pState();
    const ctx3 = await claimJob(pjob);
    await complete(ctx3, { outcome: 'failed', effects: { purchase_id: pd.id }, error: { kind: 'validation', code: 'reference_lookup_incomplete', message: 'cannot prove' } });
    const s3 = await pState();
    return (s1.sync_state === 'unknown' && ctx2.job.previous_status === 'unknown' && s2.sync_state === 'unknown' && ctx3.job.previous_status === 'unknown'
      && s3.sync_state === 'unknown' && s3.external_purchase_id === null) || J({ s1, s2, s3, p2: ctx2.job.previous_status, p3: ctx3.job.previous_status });
  });
  await check('purchase flag OFF → retry_billing_job refused (MRS_DAFTRA_PURCHASE_DISABLED); re-request refused too', async () => {
    await owner({ purchase_drafts_enabled: false });
    const r1 = await code(() => rpc('acc', `SELECT public.retry_billing_job($1) r`, [pjob]));
    const r2 = await code(() => rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip2.id, newKey()]));
    return (r1 === 'MRS_DAFTRA_PURCHASE_DISABLED' && r2 === 'MRS_DAFTRA_PURCHASE_DISABLED') || J({ r1, r2 });
  });
  await check('a purchase job queued while ON is failed at its claim once the owner turns it OFF (setting_disabled, nothing handed to the worker); unknown kept', async () => {
    await owner({ purchase_drafts_enabled: true });
    const rr = await rpc('acc', `SELECT public.retry_billing_job($1) r`, [pjob]);
    const s0 = await pState();
    await owner({ purchase_drafts_enabled: false });
    const ctx = await claimJob(pjob);
    const j = await jobOf(pjob);
    const s1 = await pState();
    const at = await one(`SELECT outcome, error FROM public.billing_sync_attempts WHERE job_id = $1 ORDER BY attempt_no DESC LIMIT 1`, [pjob]);
    return (rr.status === 'queued' && s0.sync_state === 'unknown' && ctx === null && j.status === 'failed' && j.last_error_code === 'setting_disabled'
      && /purchase_disabled/.test(j.last_error_message) && at.outcome === 'failed' && s1.sync_state === 'unknown') || J({ rr, s0, ctx: !!ctx, j, s1, at });
  });
  await check('re-request keeps «possibly applied» (sync_state unknown, previous_status unknown); a cancelled trip fails the claim (trip_cancelled)', async () => {
    await owner({ purchase_drafts_enabled: true });
    const p = await rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip2.id, newKey()]);
    const s0 = await pState();
    await q(`UPDATE public.transport_trips SET status = 'cancelled', status_reason = 'اختبار' WHERE id = $1`, [trip2.id]);
    const ctx = await claimJob(p.job.id);
    const j = await jobOf(p.job.id);
    await q(`UPDATE public.transport_trips SET status = 'delivered', status_reason = NULL WHERE id = $1`, [trip2.id]);
    const r = await rpc('acc', `SELECT public.retry_billing_job($1) r`, [p.job.id]);
    const ctx2 = await claimJob(p.job.id);
    pd.job2 = p.job.id;
    return (s0.sync_state === 'unknown' && ctx === null && j.last_error_code === 'setting_disabled' && /trip_cancelled/.test(j.last_error_message)
      && r.status === 'queued' && ctx2 && ctx2.job.previous_status === 'unknown' && (pd.ctx = ctx2)) || J({ s0, j, r, ctx2: !!ctx2 });
  });
  await check('purchase draft read back with a non-zero tax / not a draft → kept (status draft) but flagged purchase_review (fields)', async () => {
    await complete(pd.ctx, { outcome: 'ok', effects: { purchase_id: pd.id, external_purchase_id: 'pi-rev-1', found_by: 'created', daftra_number: 'PUR-R1',
      checks: { tax_nonzero: true, not_draft: false } }, calls: [{ op: 'createPurchaseDraft', applied: 'yes' }] });
    const s = await one(`SELECT status, sync_state, last_error_code, last_error_message FROM public.daftra_purchase_drafts WHERE id = $1`, [pd.id]);
    return (s.status === 'draft' && s.sync_state === 'synced' && s.last_error_code === 'purchase_review' && /fields: tax_nonzero\)/.test(s.last_error_message)) || J(s);
  });
  await owner({ purchase_drafts_enabled: false });

  // --- opening retry
  await check('opening flag OFF: retry_billing_job of a failed opening push is refused (MRS_BAD_TRANSITION opening_disabled); a queued one fails at its claim', async () => {
    const t = await mkTx(); await addDecl(t, nx('DOP'));
    const i = await one(`INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose, purpose_key, currency, revision, operational_ref, origin, note)
                         VALUES ($1, $2, $3, 'final', 'F', 'SAR', 1, $4, 'opening', 'test') RETURNING id`, [A, t.id, CLIENT_A, t.ref]);
    const j = await one(`INSERT INTO public.billing_sync_jobs (org_id, kind, intent_id, dedupe_key, status, attempts, finished_at, options)
                         VALUES ($1, 'invoice_push', $2, $3, 'failed', 1, now(), '{"opening": true}') RETURNING id`, [A, i.id, 'invoice_push:' + i.id]);
    const r = await code(() => rpc('acc', `SELECT public.retry_billing_job($1) r`, [j.id]));
    await q(`UPDATE public.billing_sync_jobs SET status = 'queued', finished_at = NULL WHERE id = $1`, [j.id]);
    const ctx = await claimJob(j.id);
    const jj = await jobOf(j.id);
    return (r === 'MRS_BAD_TRANSITION opening_disabled' && ctx === null && jj.status === 'failed' && jj.last_error_code === 'setting_disabled') || J({ r, jj });
  });

  // --- owner-only settings
  await check('save_daftra_connection: an accounts manager cannot change the opening / purchase settings (MRS_FORBIDDEN owner_only); the same value is accepted', async () => {
    const r1 = await code(() => rpc('mgr', `SELECT public.save_daftra_connection($1, $2) r`, [A, { auto_draft_on_declaration: true }]));
    const r2 = await code(() => rpc('mgr', `SELECT public.save_daftra_connection($1, $2) r`, [A, { purchase_drafts_enabled: true }]));
    const r3 = await code(() => rpc('admin', `SELECT public.save_daftra_connection($1, $2) r`, [A, { purchase_drafts_enabled: true }]));
    const ok = await rpc('mgr', `SELECT public.save_daftra_connection($1, $2) r`, [A, { auto_draft_on_declaration: false, purchase_drafts_enabled: false }]);
    const r4 = await code(() => rpc('mgr', `SELECT public.set_daftra_write_policy($1, $2, $3) r`, [A, { purchase_drafts_enabled: true }, 'x']));
    const r5 = await code(() => owner({ auto_draft_on_declaration: true }, ' '));
    const c = await one(`SELECT auto_draft_on_declaration a, purchase_drafts_enabled p FROM public.daftra_connections WHERE org_id = $1`, [A]);
    return (r1 === 'MRS_FORBIDDEN owner_only' && r2 === 'MRS_FORBIDDEN owner_only' && r3 === 'MRS_FORBIDDEN owner_only' && ok.auto_draft_on_declaration === false
      && r4 === 'MRS_FORBIDDEN owner_only' && r5 === 'MRS_NOTE_REQUIRED reason' && c.a === false && c.p === false) || J({ r1, r2, r3, r4, r5, c });
  });
  await check('opening trigger: a deadlock in the Daftra-only work never undoes the declaration (opening_blocked, code busy)', async () => {
    const def = (await one(`SELECT pg_get_functiondef('app.daftra_opening_try(uuid,text)'::regprocedure) d`)).d;
    await q(`CREATE OR REPLACE FUNCTION app.daftra_opening_try(p_tx uuid, p_source text) RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $f$
             BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $f$`);
    await owner({ auto_draft_on_declaration: true });
    let r, n, it;
    try {
      const t = await mkTx();
      r = await code(() => addDecl(t, nx('DDL')));
      n = await num(`SELECT count(*) n FROM public.customs_declarations WHERE transaction_id = $1`, [t.id]);
      it = await one(`SELECT details FROM public.billing_review_items WHERE transaction_id = $1 AND kind = 'opening_blocked' AND status = 'open'`, [t.id]);
    } finally {
      await q(def);
      await owner({ auto_draft_on_declaration: false });
    }
    return (r === 'ok' && n === 1 && it && it.details.reason === 'error' && it.details.code === 'busy') || J({ r, n, it });
  });

  // --- stale probe (org B, mock)
  await check('a probe that started before the target changed (subdomain) never stamps its account profile', async () => {
    const job = await rpc('staffB', `SELECT public.request_daftra_probe($1) r`, [B]);
    const ctx = await claimJob(job.id);
    const c0 = await one(`SELECT account_checked_at FROM public.daftra_connections WHERE org_id = $1`, [B]);
    await rpc('staffB', `SELECT public.save_daftra_connection($1, $2) r`, [B, { subdomain: 'other-acct' }]);
    await complete(ctx, { outcome: 'ok', effects: { capabilities: await CAPS_ALL(), account: KSA } });
    const c1 = await one(`SELECT account_checked_at, target_changed_at FROM public.daftra_connections WHERE org_id = $1`, [B]);
    await rpc('staffB', `SELECT public.save_daftra_connection($1, $2) r`, [B, { subdomain: null }]);
    return (String(c1.account_checked_at) === String(c0.account_checked_at) && c1.target_changed_at) || J({ c0, c1 });
  });

  // --- supplier links
  await check('supplier search with a party: the link is keyed on the PARTY name, never on the typed q (an arbitrary q links nothing)', async () => {
    const run = await rpc('trJ', `SELECT public.request_daftra_supplier_search($1, $2, $3) r`, [A, { party_id: SUP, q: 'مورد عشوائي آخر' }, newKey()]);
    const ctx = await claimJob(run.job.id);
    await complete(ctx, { outcome: 'ok', effects: { run_id: run.id, suppliers: [{ external_supplier_id: 's-evil', name: 'مورد عشوائي آخر' }] } });
    const l = await num(`SELECT count(*) n FROM public.daftra_supplier_links WHERE org_id = $1 AND (party_id = $2 OR external_supplier_id = 's-evil') AND status = 'linked'`, [A, SUP]);
    return (l === 0 && ctx.run.params.match_name === 'جهة الفاتورة التجريبية') || J({ l, p: ctx.run.params });
  });
  let supLink;
  await check('the Daftra secondary name counts as an exact name (legacy findExactDaftraSupplierR12_)', async () => {
    const run = await rpc('trJ', `SELECT public.request_daftra_supplier_search($1, $2, $3) r`, [A, { party_id: SUP }, newKey()]);
    const ctx = await claimJob(run.job.id);
    await complete(ctx, { outcome: 'ok', effects: { run_id: run.id, suppliers: [{ external_supplier_id: 's-sec', name: 'Invoice Party Co', secondary_name: 'جهة الفاتورة التجريبية' }] } });
    supLink = await one(`SELECT * FROM public.daftra_supplier_links WHERE org_id = $1 AND party_id = $2 AND status = 'linked'`, [A, SUP]);
    return (supLink && supLink.external_supplier_id === 's-sec') || J(supLink);
  });
  await check('unlink_daftra_supplier: bill_admin only, reason required, audited; the party can be linked again', async () => {
    const r1 = await code(() => rpc('trJ', `SELECT public.unlink_daftra_supplier($1, $2) r`, [supLink.id, 'خطأ']));
    const r2 = await code(() => rpc('mgr', `SELECT public.unlink_daftra_supplier($1, $2) r`, [supLink.id, ' ']));
    const ok = await rpc('mgr', `SELECT public.unlink_daftra_supplier($1, $2) r`, [supLink.id, 'ربط خاطئ']);
    const r3 = await code(() => rpc('mgr', `SELECT public.unlink_daftra_supplier($1, $2) r`, [supLink.id, 'مرة أخرى']));
    const aud = await num(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'daftra_supplier_links' AND (new_data ->> 'status') = 'unlinked' AND (new_data ->> 'id') = $1`, [supLink.id]);
    const run = await rpc('trJ', `SELECT public.request_daftra_supplier_search($1, $2, $3) r`, [A, { party_id: SUP }, newKey()]);
    const ctx = await claimJob(run.job.id);
    await complete(ctx, { outcome: 'ok', effects: { run_id: run.id, suppliers: [{ external_supplier_id: 's-sec', name: 'جهة الفاتورة التجريبية' }] } });
    const again = await num(`SELECT count(*) n FROM public.daftra_supplier_links WHERE org_id = $1 AND party_id = $2 AND status = 'linked'`, [A, SUP]);
    return (r1 === 'MRS_FORBIDDEN role' && r2 === 'MRS_NOTE_REQUIRED reason' && ok.status === 'unlinked' && ok.unlink_reason === 'ربط خاطئ' && r3 === 'MRS_BAD_TRANSITION unlinked'
      && aud >= 1 && again === 1) || J({ r1, r2, ok, r3, aud, again });
  });
  await check('a trip known by name only: an edited q steers the search but the link is keyed on the trip party name (usable by the purchase draft)', async () => {
    const t = await mkTx({ containers: 0 });
    const tr = await one(`INSERT INTO public.transport_trips (org_id, transaction_id, party_type, party_name, status) VALUES ($1, $2, 'supplier', 'ناقل بالاسم فقط', 'delivered') RETURNING *`, [A, t.id]);
    const run = await rpc('trJ', `SELECT public.request_daftra_supplier_search($1, $2, $3) r`, [A, { trip_id: tr.id, q: 'ناقل آخر' }, newKey()]);
    const ctx = await claimJob(run.job.id);
    await complete(ctx, { outcome: 'ok', effects: { run_id: run.id, suppliers: [{ external_supplier_id: 's-n1', name: 'ناقل آخر' }] } });
    const n1 = await num(`SELECT count(*) n FROM public.daftra_supplier_links WHERE org_id = $1 AND external_supplier_id = 's-n1'`, [A]);
    const run2 = await rpc('trJ', `SELECT public.request_daftra_supplier_search($1, $2, $3) r`, [A, { trip_id: tr.id, q: 'ناقل' }, newKey()]);
    const ctx2 = await claimJob(run2.job.id);
    await complete(ctx2, { outcome: 'ok', effects: { run_id: run2.id, suppliers: [{ external_supplier_id: 's-n2', name: 'ناقل بالاسم فقط' }, { external_supplier_id: 's-n3', name: 'ناقل' }] } });
    const l = await one(`SELECT party_id, name_norm = app.norm_name('ناقل بالاسم فقط') ok FROM public.daftra_supplier_links WHERE org_id = $1 AND external_supplier_id = 's-n2' AND status = 'linked'`, [A]);
    return (n1 === 0 && l && l.party_id === null && l.ok === true) || J({ n1, l });
  });

  // --- import: the Daftra client number from a file
  await check('import_clients by a non-finance import role never sets the Daftra client number; a bill_admin file does', async () => {
    await rpc('ops', `SELECT public.import_clients($1, $2, $3, $4) r`, [A, [{ client_number: 'C-PLANT', name: 'عميل ملف العمليات' }], {}, newKey()]);
    await rpc('mgr', `SELECT public.import_clients($1, $2, $3, $4) r`, [A, [{ client_number: 'C-FIN', name: 'عميل ملف المالية' }], {}, newKey()]);
    const a = await one(`SELECT daftra_client_code c FROM public.clients WHERE org_id = $1 AND name_ar = 'عميل ملف العمليات'`, [A]);
    const b = await one(`SELECT daftra_client_code c FROM public.clients WHERE org_id = $1 AND name_ar = 'عميل ملف المالية'`, [A]);
    return (a && a.c === null && b && b.c === 'C-FIN') || J({ a, b });
  });

  // --- line rules, codes, read-back
  await check('a G4 appointment fee without a TAS number is excluded (tas_missing): its free text is never sent', async () => {
    const t = await mkTx();
    const c = await charge(t, { service: 'gate_in_appointment', desc: 'رسوم موعد للحاوية ' + t.ctrs[0], price: 100 });
    const m = (await one(`SELECT app.daftra_line_meta(c) r FROM public.client_charges c WHERE c.id = $1`, [c])).r;
    return (m.excluded === 'tas_missing' && m.description === null) || J(m);
  });
  await check('product codes: a leading # and inner spaces are ignored like the legacy (#000186 = 000 186 = 186)', async () => {
    const r = await one(`SELECT app.daftra_code_norm('#000186') a, app.daftra_code_norm(' 000 186 ') b, app.daftra_code_norm('ab-1') c, app.daftra_code_norm(' # ') d`);
    return (r.a === '186' && r.b === '186' && r.c === 'AB-1' && r.d === null) || J(r);
  });
  await check('read-back of a created draft without a readable date → date_mismatch (stored null)', async () => {
    const t = await mkTx(); await charge(t); await addDecl(t, nx('DRN'));
    const p = await pushed(t, { read_back: { date: null } });
    const it = await one(`SELECT details FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'date_mismatch'`, [p.intent.id]);
    return (it && it.details.stored === null && !!it.details.expected) || J(it);
  });

  // --- HF5: issued with an open manual_in_daftra item
  const hf5Case = async tag => {
    const t = await mkTx(); await charge(t); await addDecl(t, nx(tag));
    const p = await pushed(t);
    const c2 = await charge(t, { service: 'customs_clearance', price: 300, desc: 'رسوم أضيفت يدويًا' });
    await rpc('acc', `SELECT public.add_billing_lines($1, $2) r`, [p.intent.id, [c2]]);
    const issue = async total => {
      const job = await rpc('acc', `SELECT public.request_billing_pull($1) r`, [p.intent.id]);
      const ctx = await claimJob(job.id);
      await complete(ctx, { outcome: 'ok', effects: { intent_id: p.intent.id, external_invoice_id: p.ext, daftra_number: 'INV-' + tag, daftra_status: 'issued',
        remote_state: 'issued', remote_hash: H('issued ' + tag), remote_snapshot: { lines: p.ctx.intent.lines.map(l => ({ line_ref: l.line_ref })) },
        remote_totals: { net: 0, vat: 0, total }, remote_client_id: 'dc-a' } });
    };
    const base = p.ctx.intent.lines.reduce((s, l) => s + Number(l.total_amount), 0);
    return { t, p, c2, issue, base };
  };
  const st = async (intent, c2) => ({
    ch: (await one(`SELECT status FROM public.client_charges WHERE id = $1`, [c2])).status,
    line: await one(`SELECT state, manual_in_daftra FROM public.billing_intent_lines WHERE intent_id = $1 AND charge_id = $2`, [intent, c2]),
    late: await num(`SELECT count(*) n FROM public.billing_review_items WHERE charge_id = $1 AND kind = 'late_charge'`, [c2]),
    man: await one(`SELECT id, status, details FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'manual_in_daftra' ORDER BY created_at DESC LIMIT 1`, [intent]),
    mm: await num(`SELECT count(*) n FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'issued_mismatch'`, [intent])
  });
  await check('HF5 issue with the hand edit done as listed (official total = lines + the listed addition): the addition is invoiced, no late_charge, no mismatch', async () => {
    const k = await hf5Case('HFA');
    await k.issue(k.base + 345);
    const s = await st(k.p.intent.id, k.c2);
    return (s.ch === 'invoiced' && s.line.state === 'synced' && s.line.manual_in_daftra === true && s.late === 0 && s.man.status === 'resolved' && s.mm === 0) || J(s);
  });
  await check('HF5 issue without the listed addition in the total: it is HELD (not removed, no late_charge, the manual item stays open, issued) → dismiss = not billed (late_charge)', async () => {
    const k = await hf5Case('HFB');
    await k.issue(k.base);
    const s1 = await st(k.p.intent.id, k.c2);
    const ok = await rpc('mgr', `SELECT public.resolve_daftra_review($1, $2, $3) r`, [s1.man.id, 'dismiss', 'لم يُضف في دفترة']);
    const s2 = await st(k.p.intent.id, k.c2);
    return (s1.ch !== 'invoiced' && s1.line.state === 'pending_add' && s1.late === 0 && s1.man.status === 'open' && s1.man.details.issued === true && s1.mm === 0
      && ok.status === 'dismissed' && s2.line.state === 'removed' && s2.late === 1 && s2.ch !== 'invoiced') || J({ s1, s2 });
  });
  await check('HF5 issue held, then done_in_daftra: the addition is invoiced (synced manual)', async () => {
    const k = await hf5Case('HFC');
    await k.issue(k.base + 1);
    const s1 = await st(k.p.intent.id, k.c2);
    await rpc('acc', `SELECT public.resolve_daftra_review($1, $2, $3) r`, [s1.man.id, 'done_in_daftra', 'أضيف يدويًا']);
    const s2 = await st(k.p.intent.id, k.c2);
    return (s1.line.state === 'pending_add' && s2.ch === 'invoiced' && s2.line.state === 'synced' && s2.line.manual_in_daftra === true && s2.late === 0) || J({ s1, s2 });
  });

  // --- composite lookup: partial hints
  await check('composite lookup: two of three keys equal → a partial hint (what differs), never linkable (MRS_BAD_TRANSITION partial)', async () => {
    const t = await mkTx({ containers: 1 }); await addDecl(t, 'DPT-' + (++seq));
    const dno = (await one(`SELECT declaration_no d FROM public.customs_declarations WHERE transaction_id = $1`, [t.id])).d;
    const lk = await rpc('acc', `SELECT public.request_daftra_invoice_lookup($1, $2, $3) r`, [t.id, { mode: 'composite' }, newKey()]);
    const ctx = await claimJob(lk.job.id);
    await complete(ctx, { outcome: 'ok', effects: { transaction_id: t.id, invoices: [
      { external_invoice_id: 'dp-1', daftra_number: 'P-1', remote_state: 'draft', client_id: 'dc-a', fields: { declaration_no: dno, bl: t.bl, containers: ['ZZZU1234567'] } },
      { external_invoice_id: 'dp-2', daftra_number: 'P-2', remote_state: 'draft', client_id: 'dc-a', fields: { declaration_no: 'OTHER', bl: 'OTHERBL', containers: t.ctrs } }] } });
    const c = await q(`SELECT id, state, external_invoice_id, match FROM public.daftra_invoice_candidates WHERE transaction_id = $1`, [t.id]);
    const r = c[0] ? await code(() => rpc('mgr', `SELECT public.confirm_invoice_link($1, $2, $3) r`, [c[0].id, { confirm_number: 'P-1' }, newKey()])) : 'none';
    const tb = await rpc('acc', `SELECT public.tx_billing($1) r`, [t.id]);
    return (c.length === 1 && c[0].state === 'partial' && c[0].external_invoice_id === 'dp-1' && c[0].match.containers === false && c[0].match.declaration === true
      && r === 'MRS_BAD_TRANSITION partial' && tb.invoice_candidates.some(x => x.state === 'partial')) || J({ c, r });
  });
}

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql, docs, the owner decisions');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const body = src.replace(/--.*$/gm, '');
  await check('file conventions: encoding guard, preflight on 20261122000100, schema_versions row, search_path = \'\' on every function', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261122000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261123000100', 'legacy_daftra'\)/.test(src)
      && heads.length === NEW_FNS.length + RECREATED.length && bad.length === 0) || J({ n: heads.length, want: NEW_FNS.length + RECREATED.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('refusals through app.fail / app.fin_fail(\'MRS_*\') only (no RAISE EXCEPTION besides the guard / preflight / the guarded MRS_DAFTRA_IMPORT)', () => {
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|LEGACY DAFTRA preflight|MESSAGE = 'MRS_DAFTRA_IMPORT'/.test(r));
    const codes = src.match(/app\.(fin_)?fail\('([A-Z_]+)'/g) || [];
    return (raises.length === 0 && codes.length >= 100 && codes.every(c => /app\.(fin_)?fail\('MRS_[A-Z_]+'/.test(c))) || J({ raises, codes: codes.length });
  });
  await check('every MRS code used has an Arabic message in supa.js and Arabic + English in i18n.js; the new codes are exactly the 8 of the header', () => {
    const used = [...new Set((src.match(/app\.(?:fin_)?fail\('(MRS_[A-Z_]+)'/g) || []).map(x => x.replace(/^.*\('/, '').replace(/'$/, '')))].sort();
    const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
    const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
    const missing = used.concat(['MRS_DAFTRA_IMPORT', 'MRS_DAFTRA_CUSTOM_REQUIRED']).filter(c => !new RegExp('\\b' + c + ':').test(supa) || (i18n.match(new RegExp('\\n\\s+' + c + ': ', 'g')) || []).length < 2);
    const newOnes = [...new Set(used.concat(['MRS_DAFTRA_IMPORT', 'MRS_DAFTRA_CUSTOM_REQUIRED']).filter(c => /^MRS_DAFTRA_/.test(c)))];
    return (missing.length === 0 && J(newOnes.sort()) === J(CODES.slice().sort()) && CODES.every(c => src.slice(0, 12000).includes(c))) || 'missing: ' + missing.join(', ') + ' new: ' + newOnes;
  });
  await check('no TRUNCATE / DROP TABLE / DROP FUNCTION / DISABLE TRIGGER / session_replication_role / DELETE; no key, endpoint or account value', () =>
    (!/\bTRUNCATE\b/i.test(body) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA|VIEW)/i.test(body) && !/DISABLE TRIGGER/i.test(body) && !/session_replication_role/.test(body)
      && !/\bDELETE\s+FROM\b/i.test(body) && !/sk-ant|api\.anthropic\.com|daftra\.com|marsacloud|api2\//i.test(src)) || 'body');
  await check('nothing account-specific is seeded: no Daftra field key (field_N), no product code (10001 / 000186 …), no subdomain, no personal data', () =>
    (!/\bfield_[0-9]+\b/.test(body) && !/'0{2,}[0-9]+'|'1000[0-9]'/.test(body) && !/@[a-z0-9-]+\.[a-z]/i.test(body) && !/\b05[0-9]{8}\b/.test(src)
      && !/رأس الحكمة/.test(src) && !/RHK-/.test(body)) || 'account data');
  await check('the owner decisions are in the code: allow_draft_update / allow_product_create / auto_draft_on_declaration / purchase_drafts_enabled DEFAULT false; the KSA guard before writes; Riyadh date', () =>
    (/allow_draft_update boolean NOT NULL DEFAULT false/.test(src) && /allow_product_create boolean NOT NULL DEFAULT false/.test(src)
      && /auto_draft_on_declaration boolean NOT NULL DEFAULT false/.test(src) && /purchase_drafts_enabled boolean NOT NULL DEFAULT false/.test(src)
      && /IF v_j\.kind = ANY \(app\.daftra_write_kinds\(\)\) THEN/.test(body) && /app\.daftra_fail_at_claim\(v_j, v_worker, 'account_not_ksa', v_acc\)/.test(body)
      && /'updateDraftInvoice' = ANY \(v_ops\) AND NOT app\.daftra_allow_update/.test(body) && /app\.rpt_today\(\)/.test(body)
      && !/review_status = 'approved'/.test(body)) || 'decisions');
  // later phases may follow this file (20261124000100 legacy_reports: re-creates readers of G6a / G3, never a step-7 function)
  const LATER_PHASES = ['20261124000100_legacy_reports.sql', '20261125000100_legacy_import.sql', '20261126000100_doc_match_packing.sql', '20261127000100_tx_draft_approval.sql'];
  await check('this file is the latest migration (or only listed later phases follow it)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (appended in order; only listed later phases follow) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const after = next < 0 ? [] : (all.slice(next).match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const b = all.slice(i + marker.length, next < 0 ? undefined : next);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && after.every(f => LATER_PHASES.includes(f)) && b.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 20000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
  await check('docs/online/LEGACY_DAFTRA_AR.md exists with the job contract «عقد المهام» naming every job kind, RPC, error code and rule', () => {
    const p = path.join(ROOT, 'docs', 'online', 'LEGACY_DAFTRA_AR.md');
    if (!fs.existsSync(p)) return 'missing';
    const d = fs.readFileSync(p, 'utf8');
    const miss = [MIG, 'عقد المهام', 'product_match', 'client_import', 'invoice_lookup', 'legacy_scan', 'supplier_search', 'purchase_push',
      'invoice_push', 'invoice_pull', 'probe', 'daftra_claim_jobs', 'daftra_complete_job', 'daftra_renew_lease', 'account_not_ksa', 'custom_required',
      'manual_in_daftra', 'date_mismatch', 'readback_mismatch', 'client_mismatch', 'opening_blocked', 'allow_draft_update', 'allow_product_create',
      'Asia/Riyadh', 'po_number', 'next_cursor', 'read_back', 'daftra_url', 'zero', 'HF5']
      .concat(RPCS, CODES).filter(x => !d.includes(x));
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
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261122000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without legacy_pay: exact preflight message, nothing created', async () =>
        (msg.startsWith('LEGACY DAFTRA preflight: apply legacy_pay first (schema_versions lacks 20261122000100 legacy_pay)')
          && (await one(`SELECT to_regclass('public.daftra_runs') IS NULL x`)).x && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261122000100', 'legacy_pay')`);
      const r1 = await tryErr(() => db.exec(src));
      const C1 = await catalog();
      const audit1 = await num(`SELECT count(*) n FROM public.audit_log`);
      const r3 = await tryErr(() => db.exec(src));
      await check('applies, then re-runs on top of itself with an identical catalog (functions, ACLs, indexes, triggers, policies, constraints, columns, grants, labels); no data', async () =>
        (r1 === 'ok' && r3 === 'ok' && J(C1) === J(await catalog()) && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261123000100'`)) === 1
          && (await num(`SELECT count(*) n FROM public.audit_log`)) === audit1) || J({ r1, r3 }));
      const s0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the new functions and tables; the re-created ones listed (ACL / definer / config kept)', () => {
        const nm = s => s.split('(')[0];
        const added = [...new Set(C1.fns.filter(f => !s0.has(f.sig)).map(f => nm(f.sig)))].sort();
        const changed = [...new Set(C1.fns.filter(f => s0.has(f.sig) && s0.get(f.sig).h !== f.h).map(f => nm(f.sig)))].sort();
        const keep = C1.fns.filter(f => s0.has(f.sig) && RECREATED.includes(nm(f.sig)))
          .every(f => s0.get(f.sig).acl === f.acl && s0.get(f.sig).d === f.d && s0.get(f.sig).c === f.c);
        const tbl = C1.tables.filter(t => !C0.tables.includes(t)).sort();
        return (J(added) === J(NEW_FNS.slice().sort()) && J(changed) === J(RECREATED.slice().sort()) && keep && J(tbl) === J(NEW_TABLES)) || J({ added, changed, tbl, keep });
      });
      await check('catalog: the new columns outside the new tables are the documented ones (connection, item links, intents, lines, jobs, clients)', () => {
        const cols = C1.cols.filter(c => !C0.cols.includes(c) && !NEW_TABLE_NAMES.some(t => c.startsWith(t + '.'))).sort();
        const want = ['billing_intent_lines.daftra_description', 'billing_intent_lines.manual_in_daftra', 'billing_intents.daftra_url',
          'billing_intents.invoice_date', 'billing_intents.origin', 'billing_intents.remote_client_id', 'billing_sync_jobs.purchase_id',
          'billing_sync_jobs.run_id', 'billing_sync_jobs.transaction_id', 'clients.daftra_client_code', 'daftra_connections.account_checked_at',
          'daftra_connections.account_profile', 'daftra_connections.allow_draft_update', 'daftra_connections.allow_product_create',
          'daftra_connections.auto_draft_on_declaration', 'daftra_connections.custom_field_map', 'daftra_connections.opening_item',
          'daftra_connections.policy_changed_at', 'daftra_connections.policy_changed_by', 'daftra_connections.policy_reason',
          'daftra_connections.purchase_drafts_enabled', 'daftra_connections.purchase_item', 'daftra_connections.target_changed_at', 'daftra_item_links.mapped_at', 'daftra_item_links.mapped_by',
          'daftra_item_links.match_checked_at', 'daftra_item_links.remote_code_norm', 'daftra_item_links.remote_product_code', 'daftra_item_links.service_item_id'];
        return J(cols) === J(want) || J(cols);
      });
      await check('catalog: grants on the new relations are SELECT for authenticated only; clients.daftra_client_code is not column-granted (fail closed)', async () => {
        const g = C1.grants.filter(x => !C0.grants.includes(x) && !/:service_role:/.test(x));
        const colGrant = await one(`SELECT has_column_privilege('authenticated', 'public.clients', 'daftra_client_code', 'SELECT') x`);
        return (g.length === 5 && g.every(x => /:authenticated:SELECT$/.test(x)) && colGrant.x === false) || J({ g, colGrant });
      });
      await check('catalog: the new labels are the 11 step-7 additions (bill_job_kind 6, bill_review_kind 5, 8 new domains, daftra_error 32, candidate state + partial); existing labels unchanged', () => {
        const add = C1.labels.filter(x => !C0.labels.includes(x));
        const gone = C0.labels.filter(x => !C1.labels.includes(x));
        const doms = [...new Set(add.map(x => x.split('.')[0]))].sort();
        return (gone.length === 0 && add.length === 6 + 5 + 3 + 5 + 7 + 7 + 7 + 4 + 8 + 32 && J(doms) === J(['bill_intent_origin', 'bill_job_kind', 'bill_review_kind',
          'daftra_candidate_state', 'daftra_custom_field', 'daftra_error', 'daftra_import_action', 'daftra_purchase_status', 'daftra_run_kind', 'daftra_run_status'])
          && add.every(x => /:false$/.test(x))) || J({ n: add.length, doms, gone });
      });
      await check('catalog: the opening trigger is a DEFERRED constraint trigger on customs_declarations; the HF5 trigger on billing_intent_lines', () =>
        (C1.trg.includes('customs_declarations.trg_daftra_opening:true') && C1.trg.includes('billing_intent_lines.trg_bill_hf5:false')) || J(C1.trg.filter(t => /daftra|hf5/.test(t))));
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. account guard */
async function secAccount() {
  section('3. KSA account guard (fail closed before every write)');
  await check('app.daftra_account_check: mock without a profile ok; mock reporting EGP → currency; live without profile → not_checked; live SAR/SA/15 ok; SAR/EG → country; no 15 % → vat_rate', async () => {
    const c = async (mode, prof) => (await one(`SELECT app.daftra_account_check(jsonb_populate_record(NULL::public.daftra_connections,
        jsonb_build_object('id', gen_random_uuid(), 'mode', $1::text, 'account_profile', $2::jsonb))) r`, [mode, prof === null ? null : J(prof)])).r;
    const r = [await c('mock', null), await c('mock', { currency: 'EGP', country: 'EG' }), await c('live', null),
      await c('live', { currency: 'SAR', country: 'SA', vat_rates: [15] }), await c('live', { currency: 'SAR', country: 'EG', vat_rates: [15] }),
      await c('live', { currency: 'SAR', country: 'Saudi Arabia', vat_rates: [5] }), await c('live_pending', { currency: 'sar', country: 'السعودية', vat_rates: [0, 15] })];
    const got = r.map(x => x.reason);
    return (J(got) === J([null, 'currency', 'not_checked', null, 'country', 'vat_rate', null]) && r[3].ok === true && r[3].enforced === true && r[0].enforced === false) || J(got);
  });
  await check('probe completion stores the account profile (currency upper-cased, active tax rates only, no name / subdomain / counts)', async () => {
    const p = (await one(`SELECT account_profile p FROM public.daftra_connections WHERE org_id = $1`, [A])).p;
    return (p.currency === 'SAR' && p.country === 'SA' && J(p.vat_rates) === J([15]) && !('name' in p) && !('subdomain' in p) && !('counts' in p) && !!p.checked_at) || J(p);
  });
  await check('a write job of an org whose account is not KSA is failed AT THE CLAIM (account_not_ksa, attempt recorded, nothing handed to the worker); a read-only job is still claimed', async () => {
    const t = await mkTx();
    await charge(t);
    await mapItem(A, 'service:customs_clearance', '10x', 'p-cc');
    const it = await rpc('acc', `SELECT public.create_billing_intent($1) r`, [{ transaction_id: t.id }]);
    const pr = await rpc('acc', `SELECT public.request_billing_push($1) r`, [it.id]);
    await q(`UPDATE public.daftra_connections SET account_profile = '{"currency":"EGP","country":"EG","vat_rates":[14]}' WHERE org_id = $1`, [A]);
    const ctx = await claimJob(pr.job.id);
    const j = await jobOf(pr.job.id);
    const att = await q(`SELECT outcome, error FROM public.billing_sync_attempts WHERE job_id = $1`, [pr.job.id]);
    const i = await one(`SELECT sync_state, last_error_code FROM public.billing_intents WHERE id = $1`, [it.id]);
    const lk = await rpc('acc', `SELECT public.request_daftra_invoice_lookup($1, $2) r`, [t.id, { mode: 'number', number: 'X-1' }]);
    const ctx2 = await claimJob(lk.job.id);
    if (ctx2) await complete(ctx2, { outcome: 'ok', effects: { transaction_id: t.id, invoices: [] } });
    const push2 = await code(() => rpc('acc', `SELECT public.request_billing_push($1) r`, [it.id]));
    await q(`UPDATE public.daftra_connections SET account_profile = '{"currency":"SAR","country":"SA","vat_rates":[15]}' WHERE org_id = $1`, [A]);
    return (ctx === null && j.status === 'failed' && j.last_error_code === 'account_not_ksa' && att.length === 1 && att[0].outcome === 'failed'
      && att[0].error.code === 'account_not_ksa' && i.sync_state === 'error' && i.last_error_code === 'account_not_ksa' && ctx2 && ctx2.job.kind === 'invoice_lookup'
      && push2 === 'MRS_DAFTRA_ACCOUNT_NOT_KSA currency') || J({ ctx: !!ctx, j: j.status, att, i, push2 });
  });
  await check('the claim context carries the policy (HF5 / resolve_only), the account check, the custom field map, today in Asia/Riyadh', async () => {
    const t = await mkTx();
    await charge(t);
    const it = await rpc('acc', `SELECT public.create_billing_intent($1) r`, [{ transaction_id: t.id }]);
    const pr = await rpc('acc', `SELECT public.request_billing_push($1) r`, [it.id]);
    const ctx = await claimJob(pr.job.id);
    const today = (await one(`SELECT to_char((now() AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD') d`)).d;
    const c = ctx.connection;
    await complete(ctx, { outcome: 'retry', error: { kind: 'network', code: 'network', message: 'test' } });
    return (c.policy.allow_draft_update === false && c.policy.allow_product_create === false && c.policy.products === 'resolve_only'
      && c.account.ok === true && c.time_zone === 'Asia/Riyadh' && c.today === today && ctx.intent.invoice_date === today
      && ctx.intent.po_number === ctx.intent.operational_ref && typeof c.custom_field_map === 'object') || J({ c, d: ctx.intent.invoice_date, today });
  });
}

/* ================================================================== 4. products */
async function secProducts() {
  section('4. products: by code without leading zeros, never created; match / confirm; unmapped block');
  await check('app.daftra_code_norm: 000186 = 186, Arabic digits, 0 → 0, letters upper-cased, blank → NULL', async () => {
    const r = await one(`SELECT app.daftra_code_norm('000186') a, app.daftra_code_norm('186') b, app.daftra_code_norm('٠٠١٨٦') c, app.daftra_code_norm('000') d,
                                app.daftra_code_norm(' mrs-x1 ') e, app.daftra_code_norm('  ') f, app.daftra_code_norm('0010001') g`);
    return (r.a === '186' && r.b === '186' && r.c === '186' && r.d === '0' && r.e === 'MRS-X1' && r.f === null && r.g === '10001') || J(r);
  });
  await check('save_daftra_product_code: bill_admin only; an org service item key; the code is normalised; the same code twice in a namespace → code_taken; another namespace may share it', async () => {
    const r1 = await code(() => rpc('acc', `SELECT public.save_daftra_product_code($1, $2, $3) r`, [A, 'item:gate_out_appointment', '000186']));
    const ok = await rpc('mgr', `SELECT public.save_daftra_product_code($1, $2, $3) r`, [A, 'item:gate_out_appointment', '000186']);
    const r2 = await code(() => rpc('mgr', `SELECT public.save_daftra_product_code($1, $2, $3) r`, [A, 'item:gate_in_appointment', '186']), true);
    const ok2 = await rpc('mgr', `SELECT public.save_daftra_product_code($1, $2, $3) r`, [A, 'service:gate_out_appointment', '186']);
    const r3 = await code(() => rpc('mgr', `SELECT public.save_daftra_product_code($1, $2, $3) r`, [A, 'item:no_such_item', '1']));
    const r4 = await code(() => rpc('mgr', `SELECT public.save_daftra_product_code($1, $2, $3) r`, [A, 'item:late_fee', 'a b']));
    return (r1 === 'MRS_FORBIDDEN role' && ok.remote_product_code === '000186' && ok.remote_code_norm === '186' && ok.status === 'pending' && !!ok.service_item_id
      && r2 === 'MRS_INVALID code_taken | item:gate_out_appointment' && ok2.remote_code_norm === '186' && r3 === 'MRS_INVALID item_key'
      && r4 === 'MRS_INVALID remote_product_code') || J({ r1, ok, r2, r3, r4 });
  });
  await check('request_daftra_product_match: a READ-ONLY run + job; the claim context lists the configured codes; the completion stores the candidates with exact = zero-insensitive code equality', async () => {
    const run = await rpc('mgr', `SELECT public.request_daftra_product_match($1, $2, $3) r`, [A, { item_keys: ['item:gate_out_appointment'] }, newKey()]);
    const ctx = await claimJob(run.job.id);
    const p = ctx.products.find(x => x.item_key === 'item:gate_out_appointment');
    const res = await complete(ctx, { outcome: 'ok', effects: { run_id: run.id, scanned: 40, products: [{ item_key: 'item:gate_out_appointment', candidates: [
      { external_product_id: 'p-186', code: '186', name: 'موعد خروج' }, { external_product_id: 'p-1860', code: '1860', name: 'أخرى' }] }] } });
    const il = await one(`SELECT candidates, status FROM public.daftra_item_links WHERE org_id = $1 AND item_key = 'item:gate_out_appointment'`, [A]);
    const r = await one(`SELECT status, counters FROM public.daftra_runs WHERE id = $1`, [run.id]);
    return (ctx.job.kind === 'product_match' && p && p.remote_code_norm === '186' && res.job_status === 'done' && il.status === 'pending'
      && il.candidates[0].exact === true && il.candidates[1].exact === false && r.status === 'done' && r.counters.exact === 1) || J({ p, res, il, r });
  });
  await check('confirm_daftra_product_mapping: not a candidate / another code refused; the exact candidate → linked (mapped by / at); acc refused', async () => {
    const r1 = await code(() => rpc('mgr', `SELECT public.confirm_daftra_product_mapping($1, $2, $3) r`, [A, 'item:gate_out_appointment', { external_product_id: 'p-9' }]));
    const r2 = await code(() => rpc('mgr', `SELECT public.confirm_daftra_product_mapping($1, $2, $3) r`, [A, 'item:gate_out_appointment', { external_product_id: 'p-1860' }]), true);
    const r3 = await code(() => rpc('acc', `SELECT public.confirm_daftra_product_mapping($1, $2, $3) r`, [A, 'item:gate_out_appointment', { external_product_id: 'p-186' }]));
    const ok = await rpc('mgr', `SELECT public.confirm_daftra_product_mapping($1, $2, $3) r`, [A, 'item:gate_out_appointment', { external_product_id: 'p-186' }]);
    const m = await rpc('acc', `SELECT public.list_daftra_product_map($1) r`, [A]);
    const row = m.items.find(x => x.item_key === 'item:gate_out_appointment');
    return (r1 === 'MRS_INVALID not_a_candidate' && r2 === 'MRS_INVALID code_mismatch | 1860' && r3 === 'MRS_FORBIDDEN role' && ok.status === 'linked'
      && ok.external_product_id === 'p-186' && ok.mapped_by === U.mgr && row.mapped === true && m.items.length >= 26 && m.policy.allow_product_create === false) || J({ r1, r2, r3, ok, row });
  });
  await check('unmapped service items block the push with the list (MRS_DAFTRA_UNMAPPED items | keys); mapped → queued', async () => {
    const t = await mkTx();
    await charge(t, { service: 'storage', desc: 'تخزين' });
    await charge(t, { service: 'port_charges', desc: 'أجور موانئ' });
    const it = await rpc('acc', `SELECT public.create_billing_intent($1) r`, [{ transaction_id: t.id }]);
    const r = await code(() => rpc('acc', `SELECT public.request_billing_push($1) r`, [it.id]), true);
    await mapItem(A, 'service:storage', 'S1', 'p-st'); await mapItem(A, 'service:port_charges', 'PC1', 'p-pc');
    const ok = await rpc('acc', `SELECT public.request_billing_push($1) r`, [it.id]);
    return (r === 'MRS_DAFTRA_UNMAPPED items | service:port_charges,service:storage' && ok.job.status === 'queued') || J({ r, ok });
  });
  await check('under resolve_only the push gate does not need products.create / invoices.update_draft; a logged createProduct is refused (product_create_disabled)', async () => {
    await q(`UPDATE public.daftra_connections SET capabilities = capabilities || '{"products.create":{"supported":false},"invoices.update_draft":{"supported":false}}' WHERE org_id = $1`, [A]);
    const blk = (await one(`SELECT app.bill_conn_block($1) b`, [A])).b;
    const t = await mkTx(); await charge(t);
    const it = await rpc('acc', `SELECT public.create_billing_intent($1) r`, [{ transaction_id: t.id }]);
    const pr = await rpc('acc', `SELECT public.request_billing_push($1) r`, [it.id]);
    const ctx = await claimJob(pr.job.id);
    const res = await complete(ctx, { outcome: 'retry', error: { kind: 'network', code: 'network', message: 'x' },
      calls: [{ op: 'createProduct', applied: 'yes', request: {}, response: {} }] });
    await q(`UPDATE public.daftra_connections SET capabilities = capabilities || '{"products.create":{"supported":true},"invoices.update_draft":{"supported":true}}' WHERE org_id = $1`, [A]);
    return (blk === null && res.job_status === 'failed' && res.error.code === 'MRS_INVALID' && /product_create_disabled/.test(res.error.message)) || J({ blk, res });
  });
}

/* ================================================================== 5. custom fields */
async function secCustom() {
  section('5. CustomModel custom fields: per-org map, values, custom_required, owner-only dry run');
  await check('save_daftra_custom_fields validation: bill_admin; field names from the dictionary; keys ^[A-Za-z][A-Za-z0-9_]*$, unique; port codes / types checked', async () => {
    const bad = [
      await code(() => rpc('acc', `SELECT public.save_daftra_custom_fields($1, $2) r`, [A, {}])),
      await code(() => rpc('mgr', `SELECT public.save_daftra_custom_fields($1, $2) r`, [A, { fields: { vessel: { key: 'k1' } } }]), true),
      await code(() => rpc('mgr', `SELECT public.save_daftra_custom_fields($1, $2) r`, [A, { fields: { bl: { key: '1x' } } }]), true),
      await code(() => rpc('mgr', `SELECT public.save_daftra_custom_fields($1, $2) r`, [A, { fields: { bl: { key: 'k1' }, port: { key: 'k1' } } }]), true),
      await code(() => rpc('mgr', `SELECT public.save_daftra_custom_fields($1, $2) r`, [A, { port_values: { XXNOPE: 'v' } }]), true),
      await code(() => rpc('mgr', `SELECT public.save_daftra_custom_fields($1, $2) r`, [A, { type_values: { transit: 'v' } }]), true),
      await code(() => rpc('mgr', `SELECT public.save_daftra_custom_fields($1, $2) r`, [A, { other: 1 }]))];
    return J(bad) === J(['MRS_FORBIDDEN role', 'MRS_INVALID fields | vessel', 'MRS_INVALID field_key | bl', 'MRS_INVALID field_key_taken | k1',
      'MRS_INVALID port_code | XXNOPE', 'MRS_INVALID declaration_type | transit', 'MRS_INVALID unknown_key']) || J(bad);
  });
  await check('the values: declaration no, date DD/MM/YYYY, primary B/L, port = the org value (else customs_ports.daftra_value), type → وارد, containers, goods ≤ 1000, origin ≤ 250; only configured keys sent', async () => {
    await rpc('mgr', `SELECT public.save_daftra_custom_fields($1, $2) r`, [A, { fields: {
      declaration_no: { key: 'cf_decl', required: true }, declaration_date: { key: 'cf_date' }, bl: { key: 'cf_bl', required: true },
      port: { key: 'cf_port' }, declaration_type: { key: 'cf_type' }, containers: { key: 'cf_ctr' }, goods: { key: 'cf_goods' } },
      port_values: { SAJED: 'ميناء جدة (قيمة المؤسسة)' } }]);
    const t = await mkTx({ containers: 2, goods: 'ب'.repeat(1000) });
    await addDecl(t, 'DCV-1');
    const f = (await one(`SELECT app.daftra_custom_fields($1) r`, [t.id])).r;
    const v = (await one(`SELECT app.daftra_custom_values($1) r`, [t.id])).r;
    return (f.payload.cf_decl === 'DCV-1' && f.payload.cf_date === '05/11/2026' && f.payload.cf_bl === t.bl && f.payload.cf_port === 'ميناء جدة (قيمة المؤسسة)'
      && f.payload.cf_type === 'وارد' && f.payload.cf_ctr === t.ctrs.slice().sort().join(', ') && f.payload.cf_goods.length === 1000
      && !('origin' in f.payload) && v.origin === 'الصين' && v.origin.length <= 250 && J(f.missing) === '[]' && f.fields.length === 7) || J({ f, v });
  });
  await check('Ro-Ro: the containers field carries the legacy «Ro-Ro — شاسيه … — لوحة …» value; an unmapped port falls back to customs_ports.daftra_value', async () => {
    const t = await mkTx({ containers: 0, port: 'SADMM' });
    await q(`UPDATE public.transactions SET cargo_unit_type = 'roro', chassis_no = 'JTDBR32E720123456', vehicle_plate_no = 'ABC1234' WHERE id = $1`, [t.id]);
    const v = (await one(`SELECT app.daftra_custom_values($1) r`, [t.id])).r;
    const p = await one(`SELECT daftra_value, name_ar FROM public.customs_ports WHERE code = 'SADMM'`);
    return (v.containers === 'Ro-Ro — شاسيه JTDBR32E720123456 — لوحة ABC1234' && v.port === (p.daftra_value || p.name_ar)) || J({ v, p });
  });
  await check('custom_required: a required field without a value blocks the push before any job (MRS_DAFTRA_CUSTOM_REQUIRED fields | names)', async () => {
    const t = await mkTx(); await charge(t);
    const it = await rpc('acc', `SELECT public.create_billing_intent($1) r`, [{ transaction_id: t.id }]);
    const n0 = await num(`SELECT count(*) n FROM public.billing_sync_jobs WHERE intent_id = $1`, [it.id]);
    const r = await code(() => rpc('acc', `SELECT public.request_billing_push($1) r`, [it.id]), true);
    const n1 = await num(`SELECT count(*) n FROM public.billing_sync_jobs WHERE intent_id = $1`, [it.id]);
    return (r === 'MRS_DAFTRA_CUSTOM_REQUIRED fields | declaration_no' && n0 === 0 && n1 === 0) || J({ r, n1 });
  });
  await check('test_daftra_custom_fields: OWNER ONLY (org-wide admin; a branch manager / the accounts manager refused); a dry run — nothing queued, would_send false', async () => {
    const t = await mkTx(); await addDecl(t);
    const r1 = await code(() => rpc('mgr', `SELECT public.test_daftra_custom_fields($1) r`, [t.id]));
    const r2 = await code(() => rpc('bmJ', `SELECT public.test_daftra_custom_fields($1) r`, [t.id]));
    const n0 = await num(`SELECT count(*) n FROM public.billing_sync_jobs`);
    const r = await rpc('admin', `SELECT public.test_daftra_custom_fields($1) r`, [t.id]);
    const n1 = await num(`SELECT count(*) n FROM public.billing_sync_jobs`);
    return (r1 === 'MRS_FORBIDDEN owner_only' && r2 === 'MRS_FORBIDDEN owner_only' && n0 === n1 && r.would_send === false && r.dry_run === true
      && r.payload.po_number === t.ref && r.payload.custom_fields.cf_bl === t.bl && r.payload.opening_line.unit_price === 0
      && r.payload.opening_line.description === '' && r.payload.time_zone === 'Asia/Riyadh') || J({ r1, r2, r });
  });
}

/* ================================================================== 6. opening draft */
async function secOpening() {
  section('6. opening zero draft on declaration approval (org setting OFF by default)');
  await check('default OFF: a declaration adds no intent and no job', async () => {
    const t = await mkTx();
    await addDecl(t);
    return (await num(`SELECT count(*) n FROM public.billing_intents WHERE transaction_id = $1`, [t.id])) === 0;
  });
  await rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, 'test: owner setting') r`, [A, { auto_draft_on_declaration: true }]);
  await mapItem(A, 'item:customs_clearance', '10x1', 'p-clr');
  await linkClient(A, CLIENT_A, 'dc-a');
  let opened;
  await check('ON + linked client + mapped clearance product: the declaration (at commit, deferred) opens ONE intent (origin opening, ref = the transaction ref, push job opening)', async () => {
    const t = await mkTx();
    await addDecl(t);
    const i = await q(`SELECT * FROM public.billing_intents WHERE transaction_id = $1`, [t.id]);
    const j = await q(`SELECT * FROM public.billing_sync_jobs WHERE intent_id = $1`, [i[0] && i[0].id]);
    opened = { t, i: i[0], j: j[0] };
    return (i.length === 1 && i[0].origin === 'opening' && i[0].operational_ref === t.ref && i[0].purpose_key === 'F' && j.length === 1
      && j[0].kind === 'invoice_push' && j[0].options.opening === true) || J({ i, j });
  });
  await check('idempotent: another declaration change and a retry keep ONE opening intent (retry → exists)', async () => {
    const d = await one(`SELECT id FROM public.customs_declarations WHERE transaction_id = $1`, [opened.t.id]);
    await rpc('jed', `SELECT public.set_declaration_status($1, $2) r`, [d.id, 'under_inspection']);
    const r = await rpc('acc', `SELECT public.retry_daftra_opening($1, $2) r`, [opened.t.id, newKey()]);
    return ((await num(`SELECT count(*) n FROM public.billing_intents WHERE transaction_id = $1`, [opened.t.id])) === 1 && r.status === 'exists') || J(r);
  });
  await check('the opening context: the clearance line at 0 SAR with an empty description, po_number = the transaction ref, the custom fields, the Riyadh date, no charge line', async () => {
    const ctx = await claimJob(opened.j.id);
    const today = (await one(`SELECT to_char((now() AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD') d`)).d;
    const x = ctx.intent;
    const okc = x.origin === 'opening' && x.opening_line.unit_price === 0 && x.opening_line.description === '' && x.opening_line.item_key === 'item:customs_clearance'
      && x.po_number === opened.t.ref && x.invoice_date === today && x.lines.length === 0 && x.custom_fields.payload.cf_bl === opened.t.bl
      && x.items.some(i => i.item_key === 'item:customs_clearance' && i.remote_product_code === '10x1') && x.client.external_id === 'dc-a';
    const h = H('open-1');
    await complete(ctx, { outcome: 'ok', effects: { intent_id: x.id, external_invoice_id: 'inv-open-1', found_by: 'created', daftra_status: 'draft', remote_state: 'draft',
      remote_hash: h, pushed_hash: h, remote_snapshot: {}, remote_totals: { net: 0, vat: 0, total: 0 }, line_results: [],
      daftra_url: 'https://acct.example.test/owner/invoices/view/77', read_back: { date: today, client_id: 'dc-a', total: 0, line_count: 1 } } });
    const i = await one(`SELECT status, daftra_url, external_invoice_id FROM public.billing_intents WHERE id = $1`, [x.id]);
    const rv = await num(`SELECT count(*) n FROM public.billing_review_items WHERE intent_id = $1`, [x.id]);
    return (okc && i.status === 'draft' && i.daftra_url === 'https://acct.example.test/owner/invoices/view/77' && rv === 0) || J({ x, i, rv });
  });
  await check('no linked client → one open opening_blocked item (client_not_linked); the declaration is saved; after linking, retry → queued and the item resolved', async () => {
    const t = await mkTx({ client: CLIENT_A2 });
    const d = await addDecl(t);
    const blk = await one(`SELECT * FROM public.billing_review_items WHERE transaction_id = $1 AND kind = 'opening_blocked' AND status = 'open'`, [t.id]);
    const n = await num(`SELECT count(*) n FROM public.billing_intents WHERE transaction_id = $1`, [t.id]);
    await linkClient(A, CLIENT_A2, 'dc-a2');
    const r = await rpc('accJ', `SELECT public.retry_daftra_opening($1, $2) r`, [t.id, newKey()]);
    const blk2 = await one(`SELECT status, resolution FROM public.billing_review_items WHERE id = $1`, [blk && blk.id]);
    return (!!d.id && blk && blk.details.reason === 'client_not_linked' && n === 0 && r.status === 'queued' && blk2.status === 'resolved'
      && blk2.resolution === 'opening_requested') || J({ blk, n, r, blk2 });
  });
  await check('an inactive client → blocked client_inactive; a non-finance retry is refused; retry while the setting is OFF → opening_disabled', async () => {
    const t = await mkTx({ client: CLIENT_OFF });
    await linkClient(A, CLIENT_OFF, 'dc-off');
    await addDecl(t);
    const blk = await one(`SELECT details FROM public.billing_review_items WHERE transaction_id = $1 AND kind = 'opening_blocked'`, [t.id]);
    const r1 = await code(() => rpc('jed', `SELECT public.retry_daftra_opening($1, $2) r`, [t.id, newKey()]));
    await rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, 'test: owner setting') r`, [A, { auto_draft_on_declaration: false }]);
    const r2 = await code(() => rpc('acc', `SELECT public.retry_daftra_opening($1, $2) r`, [t.id, newKey()]));
    await rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, 'test: owner setting') r`, [A, { auto_draft_on_declaration: true }]);
    return (blk.details.reason === 'client_inactive' && r1 === 'MRS_FORBIDDEN role' && r2 === 'MRS_BAD_TRANSITION opening_disabled') || J({ blk, r1, r2 });
  });
  await check('failure isolation: an error inside the Daftra hook never undoes the declaration (kept as opening_blocked reason error)', async () => {
    await q(`CREATE OR REPLACE FUNCTION public.zz_test_boom() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'boom in test'; END $f$`);
    await q(`CREATE TRIGGER zz_test_boom BEFORE INSERT ON public.billing_intents FOR EACH ROW EXECUTE FUNCTION public.zz_test_boom()`);
    const t = await mkTx();
    const r = await code(() => addDecl(t));
    await q(`DROP TRIGGER zz_test_boom ON public.billing_intents`); await q(`DROP FUNCTION public.zz_test_boom()`);
    const d = await num(`SELECT count(*) n FROM public.customs_declarations WHERE transaction_id = $1 AND status = 'submitted'`, [t.id]);
    const blk = await one(`SELECT details FROM public.billing_review_items WHERE transaction_id = $1 AND kind = 'opening_blocked'`, [t.id]);
    return (r === 'ok' && d === 1 && blk && blk.details.reason === 'error') || J({ r, d, blk });
  });
  await check('owner SQL (no JWT: migrations, imports) never opens a draft', async () => {
    const t = await mkTx();
    await q(`INSERT INTO public.customs_declarations (org_id, transaction_id, declaration_no, status) VALUES ($1, $2, $3, 'submitted')`, [A, t.id, nx('DSQL')]);
    return (await num(`SELECT count(*) n FROM public.billing_intents WHERE transaction_id = $1`, [t.id])) === 0;
  });
  // the later sections create their own final intents
  await rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, 'test: owner setting') r`, [A, { auto_draft_on_declaration: false }]);
}

/* ================================================================== 7. read-back + HF5 */
async function secHf5() {
  section('7. Riyadh date + read-back; HF5 (no edit of an existing draft)');
  await check('read-back: another stored date → date_mismatch; another client / total → readback_mismatch (fields); same → nothing', async () => {
    const t1 = await mkTx(); await charge(t1); await addDecl(t1, nx('DRB'));
    const a = await pushed(t1, { read_back: { date: '2026-01-01', client_id: 'dc-other', total: 1, line_count: 9 } });
    const r = await q(`SELECT kind, details FROM public.billing_review_items WHERE intent_id = $1 ORDER BY kind`, [a.intent.id]);
    const t2 = await mkTx(); await charge(t2); await addDecl(t2, nx('DRB'));
    const b = await pushed(t2);
    const r2 = await num(`SELECT count(*) n FROM public.billing_review_items WHERE intent_id = $1 AND kind IN ('date_mismatch','readback_mismatch')`, [b.intent.id]);
    const dm = r.find(x => x.kind === 'date_mismatch'), rm = r.find(x => x.kind === 'readback_mismatch');
    return (dm && dm.details.stored === '2026-01-01' && dm.details.time_zone === 'Asia/Riyadh' && rm && J(rm.details.fields) === J(['client', 'total', 'lines'])
      && r2 === 0 && b.intent.daftra_url && b.intent.invoice_date) || J({ r, r2 });
  });
  await check('an invalid daftra_url in the result is refused (MRS_INVALID daftra_url: the job fails, nothing applied)', async () => {
    const t = await mkTx(); await charge(t); await addDecl(t, nx('DU'));
    const it = await rpc('acc', `SELECT public.create_billing_intent($1) r`, [{ transaction_id: t.id }]);
    const pr = await rpc('acc', `SELECT public.request_billing_push($1) r`, [it.id]);
    const ctx = await claimJob(pr.job.id);
    const h = H('u');
    const res = await complete(ctx, { outcome: 'ok', effects: { intent_id: it.id, external_invoice_id: 'inv-u', found_by: 'created', remote_state: 'draft',
      remote_hash: h, pushed_hash: h, line_results: [], daftra_url: 'javascript:alert(1)' } });
    const i = await one(`SELECT external_invoice_id FROM public.billing_intents WHERE id = $1`, [it.id]);
    return (res.job_status === 'failed' && /daftra_url/.test(res.error.message) && i.external_invoice_id === null) || J({ res, i });
  });
  let D;
  await check('HF5: a line added after the draft exists → ONE open manual_in_daftra item listing it; the push is refused (MRS_DAFTRA_DRAFT_LOCKED manual_in_daftra)', async () => {
    const t = await mkTx(); await charge(t); await addDecl(t, nx('DH'));
    const p = await pushed(t);
    const c2 = await charge(t, { service: 'customs_clearance', price: 300, desc: 'رسوم إضافية' });
    await rpc('acc', `SELECT public.add_billing_lines($1, $2) r`, [p.intent.id, [c2]]);
    const items = await q(`SELECT * FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'manual_in_daftra' AND status = 'open'`, [p.intent.id]);
    const r = await code(() => rpc('acc', `SELECT public.request_billing_push($1) r`, [p.intent.id]), true);
    D = { t, p, c2, item: items[0] };
    return (items.length === 1 && items[0].details.add.length === 1 && items[0].details.add[0].charge_id === c2 && items[0].details.external_invoice_id === p.ext
      && r === 'MRS_DAFTRA_DRAFT_LOCKED manual_in_daftra | ' + items[0].id) || J({ items, r });
  });
  await check('HF5: removing a pushed line → pending_remove listed in the same item (remove); nothing is sent', async () => {
    const l = await one(`SELECT id FROM public.billing_intent_lines WHERE intent_id = $1 AND state = 'synced' LIMIT 1`, [D.p.intent.id]);
    await rpc('acc', `SELECT public.remove_billing_line($1, $2) r`, [l.id, 'خطأ في البند']);
    const items = await q(`SELECT * FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'manual_in_daftra' AND status = 'open'`, [D.p.intent.id]);
    const jobs = await num(`SELECT count(*) n FROM public.billing_sync_jobs WHERE intent_id = $1 AND status = 'queued'`, [D.p.intent.id]);
    D.removed = l.id;
    return (items.length === 1 && items[0].id === D.item.id && items[0].details.remove.length === 1 && items[0].details.remove[0].line_id === l.id && jobs === 0) || J({ items, jobs });
  });
  await check('resolve_daftra_review done_in_daftra (finance writer, note required): the added line → synced manual, the removed one → removed; the item resolved; the intent synced', async () => {
    const r0 = await code(() => rpc('acc', `SELECT public.resolve_daftra_review($1, $2, $3) r`, [D.item.id, 'done_in_daftra', '']));
    const r1 = await code(() => rpc('jed', `SELECT public.resolve_daftra_review($1, $2, $3) r`, [D.item.id, 'done_in_daftra', 'تم']));
    const r2 = await code(() => rpc('acc', `SELECT public.resolve_daftra_review($1, $2, $3) r`, [D.item.id, 'acknowledge', 'تم']));
    const ok = await rpc('acc', `SELECT public.resolve_daftra_review($1, $2, $3) r`, [D.item.id, 'done_in_daftra', 'أضيف البند يدويًا في دفترة']);
    const lines = await q(`SELECT charge_id, state, manual_in_daftra FROM public.billing_intent_lines WHERE intent_id = $1 ORDER BY created_at`, [D.p.intent.id]);
    const open = await num(`SELECT count(*) n FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'manual_in_daftra' AND status = 'open'`, [D.p.intent.id]);
    const i = await one(`SELECT sync_state FROM public.billing_intents WHERE id = $1`, [D.p.intent.id]);
    const added = lines.find(l => l.charge_id === D.c2);
    return (r0 === 'MRS_NOTE_REQUIRED note' && r1 === 'MRS_NOT_FOUND review_item' && r2 === 'MRS_INVALID decision' && ok.status === 'resolved'
      && ok.resolution === 'done_in_daftra' && added.state === 'synced' && added.manual_in_daftra === true
      && lines.some(l => l.state === 'removed') && open === 0 && i.sync_state === 'synced') || J({ r0, r1, r2, lines, open, i });
  });
  await check('HF5 on the completion: a logged updateDraftInvoice (applied) is refused — job failed draft_update_disabled, nothing applied', async () => {
    const t = await mkTx(); await charge(t); await addDecl(t, nx('DX'));
    const it = await rpc('acc', `SELECT public.create_billing_intent($1) r`, [{ transaction_id: t.id }]);
    const pr = await rpc('acc', `SELECT public.request_billing_push($1) r`, [it.id]);
    const ctx = await claimJob(pr.job.id);
    const res = await complete(ctx, { outcome: 'ok', calls: [{ op: 'updateDraftInvoice', applied: 'yes' }], effects: { intent_id: it.id } });
    return (res.job_status === 'failed' && /draft_update_disabled/.test(res.error.message)) || J(res);
  });
  await check('HF5 on the pull: a hand edit of the draft (remote hash ≠ pushed hash) is expected — no remote_edited conflict, the mirror refreshed', async () => {
    const job = await rpc('acc', `SELECT public.request_billing_pull($1) r`, [D.p.intent.id]);
    const ctx = await claimJob(job.id);
    await complete(ctx, { outcome: 'ok', effects: { intent_id: D.p.intent.id, external_invoice_id: D.p.ext, daftra_status: 'draft', remote_state: 'draft',
      remote_hash: H('edited by hand'), remote_totals: { net: 1300, vat: 195, total: 1495 }, remote_client_id: 'dc-a' } });
    const i = await one(`SELECT sync_state, conflict, remote_total FROM public.billing_intents WHERE id = $1`, [D.p.intent.id]);
    return (i.sync_state !== 'conflict' && i.conflict === null && Number(i.remote_total) === 1495) || J(i);
  });
  await check('HF5 issue: the manual line is invoiced with the others; the official total ≠ the lines → one issued_mismatch (reason totals); manual items closed', async () => {
    const job = await rpc('acc', `SELECT public.request_billing_pull($1) r`, [D.p.intent.id]);
    const ctx = await claimJob(job.id);
    await complete(ctx, { outcome: 'ok', effects: { intent_id: D.p.intent.id, external_invoice_id: D.p.ext, daftra_number: 'INV-77', daftra_status: 'issued',
      remote_state: 'issued', remote_hash: H('issued'), remote_snapshot: { lines: [] }, remote_totals: { net: 1300, vat: 195, total: 1000 }, remote_client_id: 'dc-a' } });
    const ch = await one(`SELECT status FROM public.client_charges WHERE id = $1`, [D.c2]);
    const mm = await one(`SELECT details FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'issued_mismatch'`, [D.p.intent.id]);
    const i = await one(`SELECT status FROM public.billing_intents WHERE id = $1`, [D.p.intent.id]);
    return (ch.status === 'invoiced' && i.status === 'issued' && mm && mm.details.reason === 'totals' && Number(mm.details.remote_total) === 1000) || J({ ch, mm, i });
  });
  await check('set_daftra_write_policy: OWNER ONLY (accounts manager / branch manager refused), reason required, audited (before / after); push of a draft then allowed', async () => {
    const r1 = await code(() => rpc('mgr', `SELECT public.set_daftra_write_policy($1, $2, $3) r`, [A, { allow_draft_update: true }, 'x']));
    const r2 = await code(() => rpc('bmJ', `SELECT public.set_daftra_write_policy($1, $2, $3) r`, [A, { allow_draft_update: true }, 'x']));
    const r3 = await code(() => rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, $3) r`, [A, { allow_draft_update: true }, ' ']));
    const r4 = await code(() => rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, $3) r`, [A, { allow_draft_update: 'yes' }, 'x']));
    const ok = await rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, $3) r`, [A, { allow_draft_update: true }, 'اختبار السياسة']);
    const aud = await one(`SELECT count(*) n FROM public.audit_log WHERE table_name = 'daftra_connections' AND (new_data ->> 'allow_draft_update') = 'true'
                             AND (old_data ->> 'allow_draft_update') = 'false'`);
    const t = await mkTx(); await charge(t); await addDecl(t, nx('DP'));
    const p = await pushed(t);
    await charge(t, { price: 50, desc: 'إضافي' });
    await rpc('acc', `SELECT public.add_billing_lines($1) r`, [p.intent.id]);
    const push = await rpc('acc', `SELECT public.request_billing_push($1) r`, [p.intent.id]);
    const man = await num(`SELECT count(*) n FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'manual_in_daftra'`, [p.intent.id]);
    await rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, $3) r`, [A, { allow_draft_update: false }, 'إعادة السياسة']);
    await q(`UPDATE public.billing_sync_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [push.job.id]);
    return (r1 === 'MRS_FORBIDDEN owner_only' && r2 === 'MRS_FORBIDDEN owner_only' && r3 === 'MRS_NOTE_REQUIRED reason' && r4 === 'MRS_INVALID allow_draft_update'
      && ok.allow_draft_update === true && ok.policy_reason === 'اختبار السياسة' && ok.from.allow_draft_update === false && Number(aud.n) >= 1
      && push.job.status === 'queued' && man === 0) || J({ r1, r2, r3, r4, aud, man });
  });
}

async function secHf5Retry() {
  await check('HF5: retry_billing_job never re-queues the push of an intent whose draft exists (MRS_DAFTRA_DRAFT_LOCKED manual_in_daftra)', async () => {
    const t = await mkTx(); await charge(t); await addDecl(t, nx('DRT'));
    const p = await pushed(t);
    const j = await one(`INSERT INTO public.billing_sync_jobs (org_id, kind, intent_id, dedupe_key, status, attempts, finished_at)
                         VALUES ($1, 'invoice_push', $2, $3, 'failed', 1, now()) RETURNING id`, [A, p.intent.id, 'invoice_push:' + p.intent.id]);
    const r = await code(() => rpc('acc', `SELECT public.retry_billing_job($1) r`, [j.id]));
    return r === 'MRS_DAFTRA_DRAFT_LOCKED manual_in_daftra' || r;
  });
}

/* ================================================================== 8. line rules */
async function secLines() {
  section('8. sales line rules: TAS only, empty clearance description, shared payment / internal transport cost excluded');
  const base = (tx, o) => Object.assign({ movement_type: 'org_paid', pattern: 'single', service_code: 'port_charges', transaction_id: tx,
    paid_amount: 100, paid_at: '2026-11-01', funding_source: 'org_account', method: 'sadad', paying_account: 'Test Bank 01',
    sadad_number: String(8100000000 + (++seq)), beneficiary_party_id: SUP, charge_client: true }, o || {});
  const pay = async p => rpc('acc', `SELECT public.record_payment_bundle($1) r`, [p]);
  const approve = async id => rpc('mgr', `SELECT public.set_charge_status($1, $2) r`, [id, 'approved']);
  let t, chAppt, chClr, chShared, chTrans, chManual;
  await check('fixtures: register payments that charge the client (appointment with TAS, clearance, a shared payment, the internal transport cost) + a G4 clearance charge, all approved', async () => {
    t = await mkTx();
    const t2 = await mkTx();
    const a = await pay(base(t.id, { service_code: 'gate_out_appointment', appointment_no: 'TAS20261101', claim_no: 'REF-' + seq }));
    const c = await pay(base(t.id, { service_code: 'customs_clearance', claim_no: 'CLR-' + (++seq) }));
    const s = await pay(base(undefined, { pattern: 'shared', transaction_id: undefined, paid_amount: 20,
      allocations: [{ transaction_id: t.id, amount: 10, claim_no: 'SH-' + (++seq) }, { transaction_id: t2.id, amount: 10, claim_no: 'SH-' + (++seq) }] }));
    const tr = await pay(base(t.id, { service_code: 'transportation_cost', claim_no: 'TR-' + (++seq) }));
    const chOf = async (d, tx) => (await one(`SELECT client_charge_id c FROM public.disbursement_allocations WHERE disbursement_id = $1 AND transaction_id = $2`, [d.id, tx])).c;
    chAppt = await chOf(a, t.id); chClr = await chOf(c, t.id); chShared = await chOf(s, t.id); chTrans = await chOf(tr, t.id);
    for (const id of [chAppt, chClr, chShared, chTrans]) await approve(id);
    chManual = await charge(t, { service: 'customs_clearance', desc: 'أجور التخليص اليدوية', price: 500 });
    return !!(chAppt && chClr && chShared && chTrans && chManual);
  });
  await check('eligible charges show the Daftra key, description and the exclusion: TAS only / empty / shared_payment / internal_transport_cost', async () => {
    const tb = await rpc('acc', `SELECT public.tx_billing($1) r`, [t.id]);
    const e = id => tb.eligible_charges.find(c => c.id === id);
    return (e(chAppt).item_key === 'item:gate_out_appointment' && e(chAppt).daftra_description === 'TAS20261101' && e(chAppt).daftra_block === null
      && e(chClr).item_key === 'item:customs_clearance' && e(chClr).daftra_description === '' && e(chShared).daftra_block === 'shared_payment'
      && e(chTrans).daftra_block === 'internal_transport_cost' && e(chManual).item_key === 'service:customs_clearance' && e(chManual).daftra_description === '')
      || J(tb.eligible_charges.map(c => [c.id === chAppt ? 'appt' : c.id === chClr ? 'clr' : c.id === chShared ? 'shared' : c.id === chTrans ? 'trans' : 'manual',
        c.item_key, c.daftra_description, c.daftra_block]));
  });
  await check('create_billing_intent adds only the eligible lines (with their Daftra description); an explicit excluded charge → not_eligible', async () => {
    const it = await rpc('acc', `SELECT public.create_billing_intent($1) r`, [{ transaction_id: t.id }]);
    const lines = await q(`SELECT charge_id, item_key, daftra_description FROM public.billing_intent_lines WHERE intent_id = $1`, [it.id]);
    const r = await code(() => rpc('acc', `SELECT public.add_billing_lines($1, $2) r`, [it.id, [chShared]]), true);
    const r2 = await code(() => rpc('acc', `SELECT public.add_billing_lines($1, $2) r`, [it.id, [chTrans]]), true);
    const ids = lines.map(l => l.charge_id).sort();
    return (J(ids) === J([chAppt, chClr, chManual].sort()) && lines.find(l => l.charge_id === chAppt).daftra_description === 'TAS20261101'
      && r === 'MRS_INVALID not_eligible | ' + chShared && r2 === 'MRS_INVALID not_eligible | ' + chTrans) || J({ lines, r, r2 });
  });
}

/* ================================================================== 9. client import */
async function secImport() {
  section('9. client import: Daftra pages (staging, proposals, apply) and the tenant file');
  let run, rows;
  const CL_CODE = 'a7d10000-0000-4000-8000-000000000201', CL_NAME = 'a7d10000-0000-4000-8000-000000000202', CL_LINKED = 'a7d10000-0000-4000-8000-000000000203',
    CL_X1 = 'a7d10000-0000-4000-8000-000000000204', CL_X2 = 'a7d10000-0000-4000-8000-000000000205';
  await check('fixtures: a client with a Daftra number (manual category port), one matched only by its Arabic name, one already linked; two for a conflict', async () => {
    await q(`INSERT INTO public.clients (id, org_id, client_type, name_ar, port_category, daftra_client_code) VALUES
      ($1, $6, 'business', 'شركة الكود للتجارة', 'port', 'C-100'), ($2, $6, 'business', 'مؤسسة الاسم المطابق', NULL, NULL),
      ($3, $6, 'business', 'شركة مربوطة مسبقًا', NULL, NULL), ($4, $6, 'business', 'عميل التعارض الأول', NULL, 'C-300'),
      ($5, $6, 'business', 'عميل التعارض الثاني', NULL, NULL)`, [CL_CODE, CL_NAME, CL_LINKED, CL_X1, CL_X2, A]);
    await linkClient(A, CL_LINKED, 'd-200'); await linkClient(A, CL_X2, 'd-300');
    return true;
  });
  await check('request_daftra_client_import: bill_admin; one live run per org (a second request returns it); a read-only job', async () => {
    const r0 = await code(() => rpc('acc', `SELECT public.request_daftra_client_import($1, $2) r`, [A, newKey()]));
    run = await rpc('mgr', `SELECT public.request_daftra_client_import($1, $2) r`, [A, newKey()]);
    const again = await rpc('mgr', `SELECT public.request_daftra_client_import($1, $2) r`, [A, newKey()]);
    return (r0 === 'MRS_FORBIDDEN role' && run.kind === 'client_import' && run.job.kind === 'client_import' && again.id === run.id && again.deduplicated === true) || J({ r0, run, again });
  });
  await check('pages: the context carries the cursor; a page with next_cursor stages its rows and queues the next page; the last page → ready', async () => {
    const ctx = await claimJob(run.job.id);
    await complete(ctx, { outcome: 'ok', effects: { run_id: run.id, next_cursor: { page: 2 }, rows: [
      { external_id: 'd-100', client_number: 'C-100', name: 'شركة الكود للتجارة', vat_number: '300000000000777' },
      { external_id: 'd-150', client_number: 'C-150', name: 'مؤسسة  الاسم   المطابق' },
      { external_id: 'd-200', client_number: 'C-200', name: 'شركة مربوطة مسبقًا' }] } });
    const next = await lastJob(`run_id = $1 AND status = 'queued'`, [run.id]);
    const ctx2 = await claimJob(next.id);
    await complete(ctx2, { outcome: 'ok', effects: { run_id: run.id, next_cursor: null, rows: [
      { external_id: 'd-300', client_number: 'C-300', name: 'عميل التعارض' },
      { external_id: 'd-400', client_number: 'C-400', name: 'عميل جديد من دفترة', phone: '0551234567', suspended: true },
      { external_id: 'd-500', name: '' }] } });
    const r = await one(`SELECT status, pages, counters FROM public.daftra_runs WHERE id = $1`, [run.id]);
    rows = await q(`SELECT * FROM public.daftra_client_import_rows WHERE run_id = $1 ORDER BY seq`, [run.id]);
    return (ctx.run.cursor.page === 1 && ctx2.run.cursor.page === 2 && next.dedupe_key.endsWith(':p1') && r.status === 'ready' && r.pages === 2 && rows.length === 6)
      || J({ c1: ctx && ctx.run, r, n: rows.length });
  });
  await check('proposals: link (client number), review_name (normalised Arabic name), update_link (Daftra id), conflict (id and number on two clients), create, invalid', async () => {
    const p = rows.map(x => x.proposed_action);
    return J(p) === J(['link', 'review_name', 'update_link', 'conflict', 'create', 'invalid']) && rows[1].match_client_id === CL_NAME && rows[0].match_client_id === CL_CODE || J(p);
  });
  await check('apply: the safe proposals applied (link / update_link / create) — the manual category kept, never deleted; the review row waits; counters', async () => {
    const before = await num(`SELECT count(*) n FROM public.clients WHERE org_id = $1`, [A]);
    const r0 = await code(() => rpc('acc', `SELECT public.apply_daftra_client_import($1, $2, $3) r`, [run.id, {}, newKey()]));
    const res = await rpc('mgr', `SELECT public.apply_daftra_client_import($1, $2, $3) r`, [run.id, {}, newKey()]);
    const after = await num(`SELECT count(*) n FROM public.clients WHERE org_id = $1`, [A]);
    const cc = await one(`SELECT port_category, daftra_client_code FROM public.clients WHERE id = $1`, [CL_CODE]);
    const lk = await one(`SELECT external_id, status FROM public.daftra_client_links WHERE client_id = $1 AND status <> 'unlinked'`, [CL_CODE]);
    const nw = await one(`SELECT c.source, c.daftra_client_code, c.is_active, l.external_id FROM public.clients c JOIN public.daftra_client_links l ON l.client_id = c.id
                           WHERE c.org_id = $1 AND c.name_ar = 'عميل جديد من دفترة'`, [A]);
    const rv = await one(`SELECT status FROM public.daftra_client_import_rows WHERE id = $1`, [rows[1].id]);
    return (r0 === 'MRS_FORBIDDEN role' && after === before + 1 && cc.port_category === 'port' && cc.daftra_client_code === 'C-100' && lk.external_id === 'd-100'
      && lk.status === 'linked' && nw.source === 'daftra' && nw.daftra_client_code === 'C-400' && nw.is_active === false && nw.external_id === 'd-400'
      && rv.status === 'pending' && res.status === 'ready' && res.waiting === 2 && res.counters.created === 1 && res.counters.linked === 1 && res.counters.updated === 1)
      || J({ r0, before, after, cc, lk, nw, rv, res });
  });
  await check('decisions: the review row linked to the matched client by a human; the conflict skipped → run applied', async () => {
    const res = await rpc('mgr', `SELECT public.apply_daftra_client_import($1, $2, $3) r`, [run.id,
      { decisions: [{ row_id: rows[1].id, action: 'link', client_id: CL_NAME }, { row_id: rows[3].id, action: 'skip' }] }, newKey()]);
    const lk = await one(`SELECT external_id FROM public.daftra_client_links WHERE client_id = $1 AND status <> 'unlinked'`, [CL_NAME]);
    const c = await one(`SELECT daftra_client_code FROM public.clients WHERE id = $1`, [CL_NAME]);
    return (res.status === 'applied' && res.waiting === 0 && lk.external_id === 'd-150' && c.daftra_client_code === 'C-150') || J({ res, lk, c });
  });
  await check('API callers cannot write clients.daftra_client_code (reset on insert, immutable on update)', async () => {
    const r = await code(() => as('jed', `UPDATE public.clients SET daftra_client_code = 'HACK' WHERE id = $1`, [CL_NAME]));
    const c = await one(`SELECT daftra_client_code FROM public.clients WHERE id = $1`, [CL_NAME]);
    return (r !== 'ok' && c.daftra_client_code === 'C-150') || J({ r, c });
  });
  await check('0 rows from Daftra in the whole run → aborted (empty_result), nothing to apply', async () => {
    const r2 = await rpc('mgr', `SELECT public.request_daftra_client_import($1, $2) r`, [A, newKey()]);
    const ctx = await claimJob(r2.job.id);
    await complete(ctx, { outcome: 'ok', effects: { run_id: r2.id, rows: [], next_cursor: null } });
    const r = await one(`SELECT status, error_code FROM public.daftra_runs WHERE id = $1`, [r2.id]);
    const ap = await code(() => rpc('mgr', `SELECT public.apply_daftra_client_import($1, $2, $3) r`, [r2.id, {}, newKey()]));
    return (r.status === 'aborted' && r.error_code === 'empty_result' && ap === 'MRS_BAD_TRANSITION aborted') || J({ r, ap });
  });
  await check('import_clients (the tenant file): import roles (accountant refused, operations manager ok); dry run stages only; by number / name / new; a manual category never overwritten; limits', async () => {
    const r0 = await code(() => rpc('acc', `SELECT public.import_clients($1, $2, $3, $4) r`, [A, [{ name: 'x' }], {}, newKey()]));
    const r1 = await code(() => rpc('ops', `SELECT public.import_clients($1, $2, $3, $4) r`, [A, [], {}, newKey()]));
    const many = Array.from({ length: 2001 }, (x, i) => ({ name: 'عميل ' + i }));
    const r2 = await code(() => rpc('ops', `SELECT public.import_clients($1, $2, $3, $4) r`, [A, many, {}, newKey()]));
    const rowsF = [{ client_number: 'C-100', name: 'أي اسم', port_category: 'airport' }, { name: 'شركة مربوطة مسبقًا' },
      { name: 'عميل الملف الجديد', vat_number: '300000000000999', port_category: 'shared' }];
    const n0 = await num(`SELECT count(*) n FROM public.clients WHERE org_id = $1`, [A]);
    const dry = await rpc('ops', `SELECT public.import_clients($1, $2, $3, $4) r`, [A, rowsF, { dry_run: true }, newKey()]);
    const n1 = await num(`SELECT count(*) n FROM public.clients WHERE org_id = $1`, [A]);
    const real = await rpc('ops', `SELECT public.import_clients($1, $2, $3, $4) r`, [A, rowsF, { file_name: 'clients.xlsx' }, newKey()]);
    const n2 = await num(`SELECT count(*) n FROM public.clients WHERE org_id = $1`, [A]);
    const cc = await one(`SELECT port_category FROM public.clients WHERE id = $1`, [CL_CODE]);
    const nw = await one(`SELECT source, port_category, vat_number FROM public.clients WHERE org_id = $1 AND name_ar = 'عميل الملف الجديد'`, [A]);
    const rw = await q(`SELECT proposed_action, status FROM public.daftra_client_import_rows WHERE run_id = $1 ORDER BY seq`, [real.id]);
    return (r0 === 'MRS_FORBIDDEN role' && r1 === 'MRS_DAFTRA_IMPORT empty' && r2 === 'MRS_DAFTRA_IMPORT too_many_rows' && dry.dry_run === true && n1 === n0
      && n2 === n0 + 1 && cc.port_category === 'port' && nw.source === 'import' && nw.port_category === 'shared' && nw.vat_number === '300000000000999'
      && J(rw.map(x => x.proposed_action + ':' + x.status)) === J(['link:applied', 'review_name:pending', 'create:applied']) && real.kind === 'client_file')
      || J({ r0, r1, r2, n0, n1, n2, cc, nw, rw });
  });
}

/* ================================================================== 10. invoices: lookup / link / scan / refresh */
async function secInvoices() {
  section('10. invoice lookup + confirm link, client_mismatch on pull, legacy scan cursor, read-only refresh');
  let t, cand;
  await check('request_daftra_invoice_lookup: finance writer of the branch; number required; composite needs declaration + B/L + containers; the context carries the keys', async () => {
    t = await mkTx({ containers: 2 });
    const r0 = await code(() => rpc('accD', `SELECT public.request_daftra_invoice_lookup($1, $2, $3) r`, [t.id, { mode: 'number', number: 'X' }, newKey()]));
    const r1 = await code(() => rpc('acc', `SELECT public.request_daftra_invoice_lookup($1, $2, $3) r`, [t.id, { mode: 'number' }, newKey()]));
    const r2 = await code(() => rpc('acc', `SELECT public.request_daftra_invoice_lookup($1, $2, $3) r`, [t.id, { mode: 'composite' }, newKey()]));
    await addDecl(t, 'DLK-1');
    const lk = await rpc('accJ', `SELECT public.request_daftra_invoice_lookup($1, $2, $3) r`, [t.id, { mode: 'number', number: 'INV-1001' }, newKey()]);
    const ctx = await claimJob(lk.job.id);
    await complete(ctx, { outcome: 'ok', effects: { transaction_id: t.id, invoices: [
      { external_invoice_id: 'di-1', daftra_number: 'INV-1001', daftra_status: 'draft', remote_state: 'draft', date: '2026-10-01', currency: 'SAR', total: 1150,
        client_id: 'dc-a', client_name: 'شركة الاختبار', fields: { declaration_no: 'DLK-1', bl: t.bl, containers: t.ctrs } },
      { external_invoice_id: 'di-2', daftra_number: 'INV-1002', remote_state: 'draft', client_id: 'dc-a' }] } });
    cand = await one(`SELECT * FROM public.daftra_invoice_candidates WHERE transaction_id = $1 AND state = 'open'`, [t.id]);
    return (r0 === 'MRS_NOT_FOUND transaction' && r1 === 'MRS_REQUIRED number' && r2 === 'MRS_REQUIRED declaration_no' && ctx.transaction.client_external_id === 'dc-a'
      && J(ctx.transaction.containers) === J(t.ctrs.slice().sort()) && ctx.lookup.number === 'INV-1001' && cand && cand.external_invoice_id === 'di-1'
      && cand.match.exact === true && cand.client_check === 'ok') || J({ r0, r1, r2, cand });
  });
  await check('confirm_invoice_link: approver only; the typed number must match (visual confirmation); then a linked intent (origin linked, draft), a read-only pull queued, the candidate linked', async () => {
    const r0 = await code(() => rpc('acc', `SELECT public.confirm_invoice_link($1, $2, $3) r`, [cand.id, { confirm_number: 'INV-1001' }, newKey()]));
    const r1 = await code(() => rpc('mgr', `SELECT public.confirm_invoice_link($1, $2, $3) r`, [cand.id, { confirm_number: 'INV-1010' }, newKey()]));
    const ok = await rpc('mgr', `SELECT public.confirm_invoice_link($1, $2, $3) r`, [cand.id, { confirm_number: 'inv 1001' }, newKey()]);
    const c = await one(`SELECT state, linked_intent_id FROM public.daftra_invoice_candidates WHERE id = $1`, [cand.id]);
    const pull = await one(`SELECT kind, status FROM public.billing_sync_jobs WHERE intent_id = $1`, [ok.intent.id]);
    const push = await code(() => rpc('acc', `SELECT public.request_billing_push($1) r`, [ok.intent.id]));
    return (r0 === 'MRS_FORBIDDEN role' && r1 === 'MRS_DAFTRA_CONFIRM_MISMATCH confirm_number' && ok.intent.origin === 'linked' && ok.intent.status === 'draft'
      && ok.intent.external_invoice_id === 'di-1' && c.state === 'linked' && c.linked_intent_id === ok.intent.id && pull.kind === 'invoice_pull'
      && /^MRS_DAFTRA_DRAFT_LOCKED/.test(push)) || J({ r0, r1, ok, c, pull, push });
  });
  await check('a Daftra client other than the linked one → blocked candidate; confirm → MRS_DAFTRA_CLIENT_CONFLICT (hard block)', async () => {
    const t2 = await mkTx(); await addDecl(t2, nx('DCC'));
    const lk = await rpc('acc', `SELECT public.request_daftra_invoice_lookup($1, $2, $3) r`, [t2.id, { mode: 'number', number: 'INV-2001' }, newKey()]);
    const ctx = await claimJob(lk.job.id);
    await complete(ctx, { outcome: 'ok', effects: { transaction_id: t2.id, invoices: [{ external_invoice_id: 'di-9', daftra_number: 'INV-2001', remote_state: 'issued', client_id: 'dc-someone-else' }] } });
    const c = await one(`SELECT * FROM public.daftra_invoice_candidates WHERE transaction_id = $1`, [t2.id]);
    const r = await code(() => rpc('mgr', `SELECT public.confirm_invoice_link($1, $2, $3) r`, [c.id, { confirm_number: 'INV-2001' }, newKey()]));
    return (c.state === 'blocked' && c.client_check === 'conflict' && r === 'MRS_DAFTRA_CLIENT_CONFLICT client') || J({ c, r });
  });
  await check('composite lookup: only exact matches (declaration + B/L + containers); > 1 → review; confirm needs choose_among_multiple + a note; an issued invoice → issued, invoiced, billed from under_billing', async () => {
    const t3 = await mkTx({ containers: 1 }); await addDecl(t3, 'DCOMP-1');
    const lk = await rpc('acc', `SELECT public.request_daftra_invoice_lookup($1, $2, $3) r`, [t3.id, { mode: 'composite' }, newKey()]);
    const ctx = await claimJob(lk.job.id);
    const f = { declaration_no: 'dcomp 1', bl: t3.bl, containers: t3.ctrs };
    await complete(ctx, { outcome: 'ok', effects: { transaction_id: t3.id, invoices: [
      { external_invoice_id: 'dc-x1', daftra_number: 'L-1', remote_state: 'issued', client_id: 'dc-a', total: 500, fields: f },
      { external_invoice_id: 'dc-x2', daftra_number: 'L-2', remote_state: 'issued', client_id: 'dc-a', total: 500, fields: f },
      { external_invoice_id: 'dc-x3', daftra_number: 'L-3', remote_state: 'issued', client_id: 'dc-a', fields: Object.assign({}, f, { containers: ['ABCU1234567'] }) }] } });
    const cs = await q(`SELECT * FROM public.daftra_invoice_candidates WHERE transaction_id = $1 ORDER BY daftra_number`, [t3.id]);
    const r1 = await code(() => rpc('mgr', `SELECT public.confirm_invoice_link($1, $2, $3) r`, [cs[0].id, { confirm_number: 'L-1' }, newKey()]));
    const r2 = await code(() => rpc('mgr', `SELECT public.confirm_invoice_link($1, $2, $3) r`, [cs[0].id, { confirm_number: 'L-1', choose_among_multiple: true }, newKey()]));
    await q(`UPDATE public.transactions SET operational_status = 'under_billing' WHERE id = $1`, [t3.id]);
    const ok = await rpc('mgr', `SELECT public.confirm_invoice_link($1, $2, $3) r`, [cs[0].id, { confirm_number: 'L-1', choose_among_multiple: true, note: 'الفاتورة الصحيحة' }, newKey()]);
    const tx = await one(`SELECT operational_status, financial_status FROM public.transactions WHERE id = $1`, [t3.id]);
    const other = await one(`SELECT state FROM public.daftra_invoice_candidates WHERE id = $1`, [cs[1].id]);
    return (cs.length === 2 && cs.every(c => c.state === 'review') && r1 === 'MRS_BAD_TRANSITION review_required' && r2 === 'MRS_NOTE_REQUIRED note'
      && ok.intent.status === 'issued' && tx.financial_status === 'invoiced' && tx.operational_status === 'billed' && other.state === 'superseded') || J({ cs: cs.length, r1, r2, tx, other });
  });
  await check('client_mismatch on pull: Daftra reports another client for a linked invoice → one client_mismatch review item', async () => {
    const i = await one(`SELECT id FROM public.billing_intents WHERE external_invoice_id = 'di-1'`);
    const job = await lastJob(`intent_id = $1 AND kind = 'invoice_pull' AND status = 'queued'`, [i.id]);
    const ctx = await claimJob(job.id);
    await complete(ctx, { outcome: 'ok', effects: { intent_id: i.id, external_invoice_id: 'di-1', daftra_status: 'draft', remote_state: 'draft',
      remote_hash: H('di-1'), remote_client_id: 'dc-intruder', remote_totals: { total: 1150 } } });
    const r = await one(`SELECT details FROM public.billing_review_items WHERE intent_id = $1 AND kind = 'client_mismatch' AND status = 'open'`, [i.id]);
    return (r && r.details.remote_client_id === 'dc-intruder' && r.details.linked_client_id === 'dc-a') || J(r);
  });
  await check('legacy_scan: bill_admin; batched by cursor (next page queued, resumable); exact composite matches become candidates; the end → done; read-only (unknown = retry)', async () => {
    const t4 = await mkTx({ containers: 1 }); await addDecl(t4, 'DSCAN-1');
    const r0 = await code(() => rpc('acc', `SELECT public.request_daftra_legacy_scan($1, $2, $3) r`, [A, {}, newKey()]));
    const run = await rpc('mgr', `SELECT public.request_daftra_legacy_scan($1, $2, $3) r`, [A, { page_size: 50 }, newKey()]);
    const ctx = await claimJob(run.job.id);
    const u = await complete(ctx, { outcome: 'unknown', error: { kind: 'timeout', code: 'timeout', message: 't' } });
    const j1 = await jobOf(run.job.id);
    const ctx1 = await claimJob(run.job.id);
    await complete(ctx1, { outcome: 'ok', effects: { run_id: run.id, next_cursor: { page: 2, last_id: '900' }, invoices: [
      { external_invoice_id: 'old-1', daftra_number: 'RX-1', remote_state: 'issued', client_id: 'dc-a', fields: { declaration_no: 'DSCAN-1', bl: t4.bl, containers: t4.ctrs } },
      { external_invoice_id: 'old-2', daftra_number: 'RX-2', remote_state: 'issued', client_id: 'dc-a', fields: { declaration_no: 'NOPE-1' } }] } });
    const r1 = await one(`SELECT status, pages, cursor, counters FROM public.daftra_runs WHERE id = $1`, [run.id]);
    const next = await lastJob(`run_id = $1 AND status = 'queued'`, [run.id]);
    const ctx2 = await claimJob(next.id);
    await complete(ctx2, { outcome: 'ok', effects: { run_id: run.id, next_cursor: null, invoices: [] } });
    const r2 = await one(`SELECT status FROM public.daftra_runs WHERE id = $1`, [run.id]);
    const c = await one(`SELECT state, source FROM public.daftra_invoice_candidates WHERE external_invoice_id = 'old-1'`);
    const g = await rpc('acc', `SELECT public.get_daftra_run($1) r`, [run.id]);
    return (r0 === 'MRS_FORBIDDEN role' && ctx.run.page_size === 50 && u.job_status === 'queued' && j1.status === 'queued' && r1.status === 'running' && r1.pages === 1
      && r1.cursor.page === 2 && r1.counters.invoices_seen === 2 && r1.counters.candidates === 1 && ctx2.run.cursor.last_id === '900' && r2.status === 'done'
      && c.state === 'open' && c.source === 'legacy_scan' && g.candidates.open === 1) || J({ r0, u, j1: j1.status, r1, r2, c, g });
  });
  await check('legacy_scan resumes a failed run from its cursor (resumed true, same run)', async () => {
    const run = await rpc('mgr', `SELECT public.request_daftra_legacy_scan($1, $2, $3) r`, [A, {}, newKey()]);
    const ctx = await claimJob(run.job.id);
    await complete(ctx, { outcome: 'ok', effects: { run_id: run.id, next_cursor: { page: 7 }, invoices: [] } });
    const next = await lastJob(`run_id = $1 AND status = 'queued'`, [run.id]);
    const ctx2 = await claimJob(next.id);
    await complete(ctx2, { outcome: 'failed', error: { kind: 'validation', code: 'forbidden', message: 'x' } });
    const rf = await one(`SELECT status FROM public.daftra_runs WHERE id = $1`, [run.id]);
    const again = await rpc('mgr', `SELECT public.request_daftra_legacy_scan($1, $2, $3) r`, [A, {}, newKey()]);
    const ctx3 = await claimJob(again.job.id);
    await complete(ctx3, { outcome: 'ok', effects: { run_id: run.id, next_cursor: null, invoices: [] } });
    return (rf.status === 'failed' && again.id === run.id && again.resumed === true && ctx3.run.cursor.page === 7) || J({ rf, again });
  });
  await check('refresh_tx_daftra: a read-only pull of the stale invoices (finance reader of the branch); deduplicated; nothing for another branch', async () => {
    await q(`UPDATE public.billing_intents SET last_pulled_at = now() - interval '1 hour' WHERE external_invoice_id = 'di-1'`);
    await q(`UPDATE public.billing_sync_jobs SET status = 'cancelled', finished_at = now() WHERE status IN ('queued','unknown') AND intent_id IN (SELECT id FROM public.billing_intents WHERE external_invoice_id = 'di-1')`);
    const r1 = await rpc('accJ', `SELECT public.refresh_tx_daftra($1) r`, [t.id]);
    const r2 = await rpc('sup', `SELECT public.refresh_tx_daftra($1) r`, [t.id]);
    const r3 = await code(() => rpc('accD', `SELECT public.refresh_tx_daftra($1) r`, [t.id]));
    return (r1.enqueued === 1 && r1.jobs[0].kind === 'invoice_pull' && r2.enqueued === 0 && r2.jobs[0].deduplicated === true && r3 === 'MRS_NOT_FOUND transaction') || J({ r1, r2, r3 });
  });
}

/* ================================================================== 11. cancel guard */
async function secCancel() {
  section('11. cancel_transaction: the Daftra guard (fail closed)');
  await check('an issued Daftra invoice → daftra_invoice_issued; a Daftra job in flight → daftra_sync_in_flight; a purchase draft → daftra_purchase', async () => {
    const issuedTx = await one(`SELECT transaction_id t FROM public.billing_intents WHERE status = 'issued' AND origin = 'linked' LIMIT 1`);
    await q(`UPDATE public.transactions SET operational_status = 'customs_declaration', financial_status = 'not_started' WHERE id = $1`, [issuedTx.t]);
    const r1 = await code(() => rpc('admin', `SELECT public.cancel_transaction($1, $2) r`, [issuedTx.t, 'اختبار']));
    const t = await mkTx({ containers: 0 });
    const lk = await rpc('acc', `SELECT public.request_daftra_invoice_lookup($1, $2, $3) r`, [t.id, { mode: 'number', number: 'Z-1' }, newKey()]);
    const r2 = await code(() => rpc('admin', `SELECT public.cancel_transaction($1, $2) r`, [t.id, 'اختبار']));
    await q(`UPDATE public.billing_sync_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [lk.job.id]);
    const ok = await rpc('admin', `SELECT public.cancel_transaction($1, $2) r`, [t.id, 'اختبار']);
    return (r1 === 'MRS_BAD_TRANSITION daftra_invoice_issued' && r2 === 'MRS_BAD_TRANSITION daftra_sync_in_flight' && ok.to === 'closed') || J({ r1, r2, ok });
  });
}

/* ================================================================== 12. suppliers + purchase drafts */
async function secPurchase() {
  section('12. supplier search (unique exact match) and purchase drafts per trip (flag OFF by default)');
  let trip, tx;
  await check('transport_trips has party_type (supplier / company / direct) and transport_order_no (step 5)', async () =>
    (await num(`SELECT count(*) n FROM information_schema.columns WHERE table_name = 'transport_trips' AND column_name IN ('party_type','transport_order_no','party_name')`)) === 3);
  await check('supplier search: transport staff of the trip branch; a read-only run; ONE exact name → a supplier link (party); two exact → none; the results kept', async () => {
    tx = await mkTx({ containers: 0 });
    trip = await one(`INSERT INTO public.transport_trips (org_id, transaction_id, carrier_id, party_type, party_name, status) VALUES ($1, $2, $3, 'company', 'شركة النقل التجريبية', 'delivered') RETURNING *`,
      [A, tx.id, CARRIER]);
    const r0 = await code(() => rpc('accD', `SELECT public.request_daftra_supplier_search($1, $2, $3) r`, [A, { trip_id: trip.id }, newKey()]));
    const run = await rpc('trJ', `SELECT public.request_daftra_supplier_search($1, $2, $3) r`, [A, { trip_id: trip.id }, newKey()]);
    const ctx = await claimJob(run.job.id);
    await complete(ctx, { outcome: 'ok', effects: { run_id: run.id, suppliers: [{ external_supplier_id: 's-1', name: 'شركة  النقل التجريبية' },
      { external_supplier_id: 's-2', name: 'شركة النقل التجريبية فرع 2' }] } });
    const l = await one(`SELECT * FROM public.daftra_supplier_links WHERE org_id = $1 AND party_id = $2`, [A, CARRIER]);
    const g = await rpc('trJ', `SELECT public.get_daftra_run($1) r`, [run.id]);
    const run2 = await rpc('trJ', `SELECT public.request_daftra_supplier_search($1, $2, $3) r`, [A, { q: 'مورد مكرر' }, newKey()]);
    const ctx2 = await claimJob(run2.job.id);
    await complete(ctx2, { outcome: 'ok', effects: { run_id: run2.id, suppliers: [{ external_supplier_id: 's-7', name: 'مورد مكرر' }, { external_supplier_id: 's-8', name: 'مورد  مكرر' }] } });
    const l2 = await num(`SELECT count(*) n FROM public.daftra_supplier_links WHERE org_id = $1 AND external_supplier_id IN ('s-7','s-8')`, [A]);
    const lst = await rpc('jed', `SELECT public.list_daftra_supplier_links($1) r`, [A]);
    return (r0 === 'MRS_NOT_FOUND trip' && ctx.run.params.q === 'شركة النقل التجريبية' && l && l.external_supplier_id === 's-1' && g.result.exact_match === true
      && g.result.suppliers.length === 2 && l2 === 0 && lst.items.length === 1 && lst.items[0].party_name === 'شركة النقل التجريبية') || J({ r0, l, g: g && g.result, l2 });
  });
  await check('purchase drafts: the org flag is OFF by default (MRS_DAFTRA_PURCHASE_DISABLED)', async () => {
    const c = await one(`SELECT purchase_drafts_enabled e FROM public.daftra_connections WHERE org_id = $1`, [A]);
    const r = await code(() => rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip.id, newKey()]));
    return (c.e === false && r === 'MRS_DAFTRA_PURCHASE_DISABLED') || J({ c, r });
  });
  await check('ON: the transport product must be mapped, the trip must have costs; then ONE draft (zero tax, the cost accruals) + a job; a second request is deduplicated', async () => {
    await rpc('admin', `SELECT public.set_daftra_write_policy($1, $2, 'test: owner setting') r`, [A, { purchase_drafts_enabled: true }]);
    const r1 = await code(() => rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip.id, newKey()]), true);
    await mapItem(A, 'item:transportation_cost', '0191', 'p-tr');
    const r2 = await code(() => rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip.id, newKey()]));
    const acc0 = await one(`SELECT id FROM public.cost_accruals WHERE trip_id = $1`, [trip.id]);
    if (acc0) await q(`UPDATE public.cost_accruals SET amount = 750, supplier_id = $2, status = 'open' WHERE id = $1`, [acc0.id, CARRIER]);
    else await q(`INSERT INTO public.cost_accruals (org_id, transaction_id, source, trip_id, supplier_id, service_code, amount, basis) VALUES ($1, $2, 'trip', $3, $4, 'transport', 750, 'agreed')`,
      [A, tx.id, trip.id, CARRIER]);
    const p = await rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip.id, newKey()]);
    const p2 = await rpc('acc', `SELECT public.request_daftra_purchase_draft($1, $2) r`, [trip.id, newKey()]);
    trip.purchase = p;
    return (r1 === 'MRS_DAFTRA_UNMAPPED items | item:transportation_cost' && r2 === 'MRS_REQUIRED cost_accruals' && Number(p.amount) === 750 && p.status === 'open'
      && /^MRSP-[0-9A-F]{12}$/.test(p.reference) && p.job.kind === 'purchase_push' && p2.deduplicated === true && p2.id === p.id) || J({ r1, r2, p, p2 });
  });
  await check('the purchase context (supplier id, transport product code, one line at 0 tax); a lost response keeps the Daftra id at once; the next run → draft', async () => {
    const ctx = await claimJob(trip.purchase.job.id);
    const pc = ctx.purchase;
    const res = await complete(ctx, { outcome: 'unknown', effects: { purchase_id: trip.purchase.id, external_purchase_id: 'pi-1' },
      error: { kind: 'timeout', code: 'timeout', message: 'lost' }, calls: [{ op: 'createPurchaseDraft', applied: 'unknown' }] });
    const p1 = await one(`SELECT external_purchase_id, sync_state FROM public.daftra_purchase_drafts WHERE id = $1`, [trip.purchase.id]);
    const ctx2 = await claimJob(trip.purchase.job.id);
    await complete(ctx2, { outcome: 'ok', effects: { purchase_id: trip.purchase.id, external_purchase_id: 'pi-1', found_by: 'ref', daftra_number: 'PUR-9' } });
    const p2 = await one(`SELECT status, sync_state, daftra_number FROM public.daftra_purchase_drafts WHERE id = $1`, [trip.purchase.id]);
    return (pc.supplier_external_id === 's-1' && pc.item.remote_product_code === '0191' && pc.lines.length === 1 && pc.lines[0].vat_rate === 0 && pc.tax === 0
      && res.job_status === 'unknown' && p1.external_purchase_id === 'pi-1' && p1.sync_state === 'unknown' && ctx2.job.previous_status === 'unknown'
      && p2.status === 'draft' && p2.daftra_number === 'PUR-9') || J({ pc, res, p1, p2 });
  });
  await check('cancel_transaction with a purchase draft → daftra_purchase', async () => {
    const r = await code(() => rpc('admin', `SELECT public.cancel_transaction($1, $2) r`, [tx.id, 'اختبار']));
    return r === 'MRS_BAD_TRANSITION daftra_purchase' || r;
  });
}

/* ================================================================== 13. RLS, privileges */
async function secRls() {
  section('13. RLS (other org / branch / non-finance / client / anon), function privileges, conversion lists');
  await check('another org sees none of A\'s step-7 rows; the client user and anon see nothing; the DMM accountant sees no JED candidate / purchase', async () => {
    const out = {};
    for (const t of NEW_TABLE_NAMES) {
      out[t] = [Number((await as('staffB', `SELECT count(*) n FROM public.${t}`))[0].n), Number((await as('portal', `SELECT count(*) n FROM public.${t}`))[0].n),
        await code(() => as('anon', `SELECT count(*) n FROM public.${t}`))];
    }
    const dC = Number((await as('accD', `SELECT count(*) n FROM public.daftra_invoice_candidates c JOIN public.transactions t ON t.id = c.transaction_id WHERE t.branch_id = $1`, [JED]))[0].n);
    const dP = Number((await as('accD', `SELECT count(*) n FROM public.daftra_purchase_drafts`))[0].n);
    const jC = Number((await as('jed', `SELECT count(*) n FROM public.daftra_invoice_candidates`))[0].n);
    const jL = Number((await as('jed', `SELECT count(*) n FROM public.daftra_supplier_links`))[0].n);
    const aC = Number((await as('accJ', `SELECT count(*) n FROM public.daftra_invoice_candidates`))[0].n);
    const ok = Object.values(out).every(([b, p, a]) => b === 0 && p === 0 && a === 'perm');
    return (ok && dC === 0 && dP === 0 && jC === 0 && jL === 1 && aC > 0) || J({ out, dC, dP, jC, jL, aC });
  });
  await check('no write grant: an authenticated INSERT / UPDATE / DELETE into any new table is refused', async () => {
    const r = [];
    for (const t of NEW_TABLE_NAMES) {
      r.push(await code(() => as('admin', `INSERT INTO public.${t} (org_id) VALUES ($1)`, [A])));
      r.push(await code(() => as('admin', `UPDATE public.${t} SET org_id = org_id`)));
      r.push(await code(() => as('admin', `DELETE FROM public.${t}`)));
    }
    return r.every(x => x === 'perm') || J(r);
  });
  await check('another org\'s staff is refused by every org-level RPC of A; a branch accountant never reaches another branch\'s transaction', async () => {
    const r = [await code(() => rpc('staffB', `SELECT public.list_daftra_product_map($1) r`, [A])), await code(() => rpc('staffB', `SELECT public.request_daftra_client_import($1, $2) r`, [A, newKey()])),
      await code(() => rpc('staffB', `SELECT public.list_daftra_reviews($1, '{}') r`, [A])), await code(() => rpc('staffB', `SELECT public.set_daftra_write_policy($1, $2, $3) r`, [A, { allow_draft_update: true }, 'x'])),
      await code(() => rpc('jed', `SELECT public.list_daftra_reviews($1, '{}') r`, [A]))];
    return J(r) === J(['MRS_FORBIDDEN org', 'MRS_FORBIDDEN org', 'MRS_FORBIDDEN org', 'MRS_FORBIDDEN org', 'MRS_FORBIDDEN finance']) || J(r);
  });
  await check('function privileges: the 24 RPCs → authenticated only; the worker RPCs → service_role only; the helpers → nobody', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('anon', p.oid, 'EXECUTE') an,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') sr
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1)`, [RPCS]);
    const w = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('service_role', p.oid, 'EXECUTE') sr
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('daftra_claim_jobs','daftra_complete_job')`);
    const h = await q(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname LIKE 'daftra\\_%'
                         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))`);
    return (r.length === RPCS.length && r.every(x => x.au && !x.an && !x.sr) && w.every(x => !x.au && x.sr) && h.length === 0) || J({ r, w, h });
  });
  await check('worker RPCs refuse staff; staff RPCs refuse the service role (no auth.uid)', async () => {
    const r1 = await code(() => rpc('admin', `SELECT public.daftra_claim_jobs('w', 1) r`));
    const r2 = await code(() => svc(`SELECT public.import_clients($1, $2) r`, [A, [{ name: 'x' }]]));
    return (r1 === 'perm' && r2 === 'perm') || J({ r1, r2 });
  });
  await check('conversion lists: the 5 tables in app.convert_delete_tables (83), their no-delete guards in app.convert_delete_guards (44), every table classified', async () => {
    const t = (await one(`SELECT app.convert_delete_tables() t`)).t;
    const g = (await one(`SELECT app.convert_delete_guards() g`)).g;
    const keep = (await one(`SELECT app.convert_keep_tables() k`)).k;
    const all = (await q(`SELECT 'public.' || relname n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`)).map(x => x.n);
    const un = all.filter(x => !t.includes(x) && !keep.includes(x) && !['public.status_labels', 'public.schema_versions', 'public.organizations',
      'public.profiles', 'public.platform_admins', 'public.plans', 'public.customs_ports', 'public.daftra_mock_accounts'].includes(x));
    return (NEW_TABLE_NAMES.every(x => t.includes('public.' + x) && g.includes('public.' + x + ':trg_no_delete')) && g.length === 44 && t.length === 83 + 2 /* + legacy_import_rows, legacy_import_runs (20261125000100) */ && un.length === 0) || J({ g: g.length, t: t.length, un });
  });
  await check('no DELETE even for the owner (trg_no_delete); the trail: runs / candidates / supplier links / purchases audited, import rows not', async () => {
    const r = await code(() => q(`DELETE FROM public.daftra_runs WHERE org_id = $1`, [A]));
    const a = await q(`SELECT DISTINCT table_name t FROM public.audit_log WHERE table_name = ANY ($1) ORDER BY 1`, [NEW_TABLE_NAMES]);
    return (r === 'MRS_APPEND_ONLY daftra_runs' && J(a.map(x => x.t)) === J(['daftra_invoice_candidates', 'daftra_purchase_drafts', 'daftra_runs', 'daftra_supplier_links'])) || J({ r, a });
  });
}

/* ================================================================== 14. supa.js, i18n */
async function secStatic() {
  section('14. supa.js wrappers, i18n');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  await check('supa.js: one exported wrapper per RPC, calling it by name; the writes through the idempotent path', () => {
    const W = { setDaftraWritePolicy: 'set_daftra_write_policy', saveDaftraCustomFields: 'save_daftra_custom_fields', testDaftraCustomFields: 'test_daftra_custom_fields',
      listDaftraProductMap: 'list_daftra_product_map', saveDaftraProductCode: 'save_daftra_product_code', requestDaftraProductMatch: 'request_daftra_product_match',
      confirmDaftraProductMapping: 'confirm_daftra_product_mapping', retryDaftraOpening: 'retry_daftra_opening', resolveDaftraReview: 'resolve_daftra_review',
      listDaftraReviews: 'list_daftra_reviews', requestDaftraClientImport: 'request_daftra_client_import', listDaftraClientImport: 'list_daftra_client_import',
      applyDaftraClientImport: 'apply_daftra_client_import', importClients: 'import_clients', requestDaftraInvoiceLookup: 'request_daftra_invoice_lookup',
      confirmInvoiceLink: 'confirm_invoice_link', rejectInvoiceCandidate: 'reject_invoice_candidate', requestDaftraLegacyScan: 'request_daftra_legacy_scan',
      getDaftraRun: 'get_daftra_run', refreshTxDaftra: 'refresh_tx_daftra', requestDaftraSupplierSearch: 'request_daftra_supplier_search',
      listDaftraSupplierLinks: 'list_daftra_supplier_links', requestDaftraPurchaseDraft: 'request_daftra_purchase_draft',
      unlinkDaftraSupplier: 'unlink_daftra_supplier' };
    const miss = Object.keys(W).filter(f => !new RegExp('function ' + f + '\\(').test(supa) || !new RegExp(f + ': ' + f + '[,\\n]').test(supa) || !supa.includes("'" + W[f] + "'"));
    const idem = ['request_daftra_product_match', 'retry_daftra_opening', 'request_daftra_client_import', 'apply_daftra_client_import', 'import_clients',
      'request_daftra_invoice_lookup', 'confirm_invoice_link', 'request_daftra_legacy_scan', 'request_daftra_supplier_search', 'request_daftra_purchase_draft']
      .filter(n => !new RegExp("idemRpc\\('" + n + "'").test(supa));
    return (miss.length === 0 && Object.values(W).sort().join() === RPCS.join() && idem.length === 0 && !/daftra_claim_jobs|daftra_complete_job/.test(supa)) || 'missing: ' + miss.join(', ') + ' idem: ' + idem.join(', ');
  });
  await check('i18n: the daftra_error dictionary (worker codes → Arabic / English) and the codeDetails of the new detail words', async () => {
    const e = await q(`SELECT code, label_ar, label_en FROM public.status_labels WHERE domain = 'daftra_error'`);
    const codes = e.map(x => x.code);
    const need = ['account_not_ksa', 'custom_required', 'unmapped_product', 'product_not_found', 'client_suspended', 'draft_update_disabled', 'date_mismatch',
      'empty_result', 'reference_lookup_incomplete', 'auth_failed', 'forbidden', 'validation', 'rate_limited', 'timeout'];
    const det = ['MRS_FORBIDDEN:owner_only', 'MRS_BAD_TRANSITION:daftra_invoice_issued', 'MRS_BAD_TRANSITION:daftra_sync_in_flight', 'MRS_BAD_TRANSITION:opening_disabled',
      'MRS_INVALID:not_a_candidate', 'MRS_REQUIRED:supplier_link'].filter(k => !supa.includes("'" + k + "'"));
    return (need.every(c => codes.includes(c)) && e.every(x => /[؀-ۿ]/.test(x.label_ar) && x.label_en.length > 5) && det.length === 0) || J({ codes, det });
  });
}

/* ================================================================== main */
async function main() {
  await secFile();
  await secPreflight();
  section('load shim + migrations + seed + fixtures');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  await check('the defaults of a new connection follow the owner decisions (no draft update, no product create, no opening, no purchase)', async () => {
    await rpc('mgr', `SELECT public.save_daftra_connection($1, $2) r`, [A, {}]);
    const c = await one(`SELECT allow_draft_update a, allow_product_create b, auto_draft_on_declaration c, purchase_drafts_enabled d, opening_item, purchase_item
                           FROM public.daftra_connections WHERE org_id = $1`, [A]);
    return (c.a === false && c.b === false && c.c === false && c.d === false && c.opening_item === 'item:customs_clearance' && c.purchase_item === 'item:transportation_cost') || J(c);
  });
  await connect(A, 'mgr');
  await connect(B, 'staffB');
  pass('database ready (org A + B connected in mock mode, KSA account profile)');
  const SECTIONS = [secAccount, secProducts, secCustom, secOpening, secHf5, secHf5Retry, secLines, secImport, secInvoices, secCancel, secPurchase, secRls, secStatic,
    secReview];
  for (const s of SECTIONS) {
    try { await s(); } catch (e) { fail('section ' + s.name + ' aborted', errText(e) + ' | ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')); }
  }
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
}
main().catch(e => { console.error(e); process.exit(1); });
