#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 6 (payments, disbursements and client custody): migration 20261122000100_legacy_pay.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal).

  Covers: file conventions + all_migrations.sql + docs + the owner decisions; preflight, re-run on itself (identical
  catalog), catalog delta; the funding source × method matrix (SQL CHECK and RPC), the payer defaults (org settings name),
  the method references (SADAD digits, bank ref format, receipt ≤ 100, one column per method), global duplicate
  prevention (the message cites the earlier entry, transaction and amount; a void frees it), invoice identity (same
  issuer + number = hard block, another issuer = MRS_CONFIRM_INVOICE_REUSE, an existing G4 invoice reused, the internal
  FP number unique), the G4 bookings (supplier invoice created, supplier payment company / client, the invoice payment
  status), shared allocations (≥ 2, Σ = total, each > 0, no duplicate transaction + invoice, one branch, one client where
  required; a transaction shows only its share), typed attachments (8 / 4 MB / 12 MB, PDF / image, branch, in use, per
  allocation in shared mode, soft removal, add later), four-eyes review (admins included), correct = void + re-record
  (before / after event, documents carried, references reused), void (approver, Daftra / invoiced / custody locks), the
  reimbursable draft charge, the custody ledger (deposit / deduction / refund, deduction ≤ the payment share, one active
  deduction, never negative under the lock and the trigger, voiding a deposit that would go negative refused — the legacy
  bug), the balances view and RPCs, match_payment_transaction / check_payment_duplicates; RLS incl. the finance roles and
  branch scoping, function privileges, conversion lists, audit; supa.js wrappers and i18n messages; idempotent re-apply.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-pay-sql-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261122000100_legacy_pay.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in legacy-pay-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';
const B = 'a99d0000-0000-4000-8000-0000000000b0';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const CLIENT_A2 = 'a9910000-0000-4000-8000-000000000102';
const BR_B = 'a99d0000-0000-4000-8000-0000000000b1';
const CL_B = 'a99d0000-0000-4000-8000-0000000000b3';
const SUP = 'a9920000-0000-4000-8000-000000000001';      // supplier party of A (the invoice issuer)
const SUP2 = 'a9920000-0000-4000-8000-000000000002';     // another issuer of A
const SUP_OFF = 'a9920000-0000-4000-8000-000000000003';  // inactive party of A
const SUP_B = 'a9920000-0000-4000-8000-0000000000b1';    // party of B
const U = {
  admin: 'a99f0000-0000-4000-8000-000000000001',    // admin of A (org-wide)
  acc: 'a99f0000-0000-4000-8000-000000000002',      // accountant of A (org-wide): finance writer, not an approver
  mgr: 'a99f0000-0000-4000-8000-000000000003',      // accounts_manager of A (org-wide): approver
  accJ: 'a99f0000-0000-4000-8000-000000000004',     // accountant of A, JED only
  mgrJ: 'a99f0000-0000-4000-8000-000000000005',     // branch_manager of A, JED only (approver there)
  accD: 'a99f0000-0000-4000-8000-000000000006',     // accountant of A, DMM only
  jed: 'a99f0000-0000-4000-8000-000000000007',      // clearance_staff of A, JED (staff, NOT finance)
  sup: 'a99f0000-0000-4000-8000-000000000008',      // supervisor of A (finance reader only)
  portal: 'a99f0000-0000-4000-8000-000000000009',   // client user of CLIENT_A
  stranger: 'a99f0000-0000-4000-8000-00000000000a', // no membership
  staffB: 'a99f0000-0000-4000-8000-00000000000b'    // admin of B
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
const newKey = () => 'a99faaab-0000-4000-8000-' + String(++keySeq).padStart(12, '0');
let shaSeq = 0;
const sha = () => (++shaSeq).toString(16).padStart(64, 'f');
let refSeq = 0;
const sadadNo = () => String(7000000000 + (++refSeq));
const bankRef = () => 'FT' + (++refSeq) + '-X' + refSeq;
const receipt = () => 'RC-' + (++refSeq);
const claim = () => 'INV-' + (1000 + (++refSeq));

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind IN ('r','v') ORDER BY 1`)).map(x => x.t);
  const idx = (await q(`SELECT indexname || ':' || md5(indexdef) x FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`)).map(x => x.x);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
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
const NEW_TABLES = ['public.client_custody_balances', 'public.client_custody_entries', 'public.client_disbursements', 'public.disbursement_allocations',
  'public.payment_documents'];
const NEW_FNS = ['app.custody_balance', 'app.custody_json', 'app.custody_lock', 'app.pay_can_read', 'app.pay_detail', 'app.pay_lock', 'app.pay_locked',
  'app.pay_inv_key', 'app.pay_int_key', 'app.pay_is_author',
  'app.pay_org_payer', 'app.pay_record', 'app.pay_ref_conflict', 'app.pay_ref_norm', 'app.pay_row', 'app.pay_void_core', 'app.tg_custody_balance',
  'app.tg_custody_guard', 'app.tg_pay_alloc_guard', 'app.tg_pay_before', 'app.tg_pay_doc_guard', 'app.tg_pay_guard', 'app.tg_pay_sum',
  'public.add_payment_documents', 'public.check_payment_duplicates', 'public.client_custody_balance', 'public.correct_payment',
  'public.custody_balances', 'public.get_payment', 'public.list_custody_entries', 'public.list_payments', 'public.match_payment_transaction',
  'public.record_payment_bundle', 'public.remove_payment_document', 'public.review_payment', 'public.save_custody_entry', 'public.tx_disbursements',
  'public.void_custody_entry', 'public.void_payment'];
const RECREATED = ['app.convert_delete_guards', 'app.convert_delete_tables', 'app.tg_payment_totals'];
const RPCS = ['add_payment_documents', 'check_payment_duplicates', 'client_custody_balance', 'correct_payment', 'custody_balances', 'get_payment',
  'list_custody_entries', 'list_payments', 'match_payment_transaction', 'record_payment_bundle', 'remove_payment_document', 'review_payment',
  'save_custody_entry', 'tx_disbursements', 'void_custody_entry', 'void_payment'];
const CODES = ['MRS_PAY_REF_TAKEN', 'MRS_PAY_REF_METHOD', 'MRS_PAY_REFERENCE', 'MRS_PAY_FUNDING', 'MRS_PAY_ALLOCATION', 'MRS_PAY_DOCUMENT',
  'MRS_PAY_INVOICE_TAKEN', 'MRS_CONFIRM_INVOICE_REUSE', 'MRS_PAY_LOCKED', 'MRS_CUSTODY_NEGATIVE', 'MRS_CUSTODY_LINK'];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at)
    SELECT v.id::uuid, v.k || '@legacypay.example.com', now() FROM (VALUES
      ('${U.admin}','admin'),('${U.acc}','acc'),('${U.mgr}','mgr'),('${U.accJ}','accj'),('${U.mgrJ}','mgrj'),('${U.accD}','accd'),
      ('${U.jed}','jed'),('${U.sup}','sup'),('${U.portal}','portal'),('${U.stranger}','stranger'),('${U.staffB}','staffb')) v(id, k);
  INSERT INTO public.profiles (id, full_name) SELECT u.id, split_part(u.email, '@', 1) FROM auth.users u WHERE u.email LIKE '%@legacypay.example.com'
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'legacypay-org-b', 'مؤسسة ب', 'Legacy pay org B', 'LPB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES
    ('${CL_B}', '${B}', 'business', 'عميل ب', 'Client B Co', '0509990001'),
    ('${CLIENT_A2}', '${A}', 'business', 'عميل ثان للاختبار', 'Second Test Client', '0509990002');
  INSERT INTO public.parties (id, org_id, kinds, name_ar, vat_number) VALUES
    ('${SUP}', '${A}', ARRAY['supplier'], 'جهة الفاتورة التجريبية', '300000000000003'),
    ('${SUP2}', '${A}', ARRAY['supplier'], 'جهة أخرى تجريبية', NULL),
    ('${SUP_OFF}', '${A}', ARRAY['supplier'], 'جهة موقوفة', NULL),
    ('${SUP_B}', '${B}', ARRAY['supplier'], 'جهة المؤسسة ب', NULL);
  UPDATE public.parties SET is_active = false WHERE id = '${SUP_OFF}';
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.acc}', '${A}', NULL, 'accountant'), ('${U.mgr}', '${A}', NULL, 'accounts_manager'),
    ('${U.accJ}', '${A}', '${JED}', 'accountant'), ('${U.mgrJ}', '${A}', '${JED}', 'branch_manager'), ('${U.accD}', '${A}', '${DMM}', 'accountant'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.sup}', '${A}', NULL, 'supervisor'), ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
async function mkTx(o) {
  const x = Object.assign({ org: A, branch: JED, client: CLIENT_A, n: 1 }, o || {});
  const tx = (await q(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, container_count, bl_number)
                       VALUES ($1, $2, $3, 'import', 'sea', 0, $4) RETURNING id, ref`, [x.org, x.branch, x.client, x.bl || null]))[0];
  return { id: tx.id, ref: tx.ref, org: x.org };
}
// a finance original of the branch (owner SQL: the page registers it with register_finance_document and uploads the bytes)
async function mkDoc(o) {
  const x = Object.assign({ org: A, branch: JED, size: 200000, mime: 'application/pdf', by: 'acc', name: 'doc.pdf' }, o || {});
  const id = crypto.randomUUID();
  await q(`INSERT INTO public.finance_documents (id, org_id, branch_id, kind, storage_path, sha256, original_name, mime_type, size_bytes, uploaded_by)
           VALUES ($1, $2, $3, 'payment_evidence', $4, $5, $6, $7, $8, $9)`,
    [id, x.org, x.branch, x.org + '/' + id + '/' + x.name, sha(), x.name, x.mime, x.size, U[x.by]]);
  return id;
}
let svcItem;
const base = (tx, o) => Object.assign({ movement_type: 'org_paid', pattern: 'single', service_code: 'port_charges', transaction_id: tx,
  paid_amount: 100, paid_at: '2026-11-01', funding_source: 'org_account', method: 'sadad', paying_account: 'Test Bank 01',
  sadad_number: sadadNo(), beneficiary_party_id: SUP }, o || {});
const rec = (who, p, key) => rpc(who || 'acc', `SELECT public.record_payment_bundle($1, $2) r`, [p, key || null]);
const getPay = (who, id) => rpc(who || 'acc', `SELECT public.get_payment($1) r`, [id]);
const review = (who, id, d, n) => rpc(who || 'mgr', `SELECT public.review_payment($1, $2, $3) r`, [id, d, n || null]);
const voidPay = (who, id, r) => rpc(who || 'mgr', `SELECT public.void_payment($1, $2) r`, [id, r]);
const correct = (who, id, p, r, key) => rpc(who || 'acc', `SELECT public.correct_payment($1, $2, $3, $4) r`, [id, p, r, key || null]);
const txPay = (who, tx) => rpc(who || 'acc', `SELECT public.tx_disbursements($1) r`, [tx]);
const custody = (who, p, key) => rpc(who || 'acc', `SELECT public.save_custody_entry($1, $2) r`, [p, key || null]);
const voidCustody = (who, id, r) => rpc(who || 'mgr', `SELECT public.void_custody_entry($1, $2) r`, [id, r]);
const balance = async client => Number((await one(`SELECT app.custody_balance($1) b`, [client])).b);

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql, docs, the owner decisions');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261121000100, schema_versions row, search_path = \'\' on every function', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261121000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261122000100', 'legacy_pay'\)/.test(src)
      && heads.length === NEW_FNS.length + RECREATED.length && bad.length === 0) || J({ n: heads.length, want: NEW_FNS.length + RECREATED.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('refusals through app.fail / app.fin_fail(\'MRS_*\') only (no RAISE EXCEPTION besides the guard / preflight)', () => {
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|LEGACY PAY preflight/.test(r));
    const codes = src.match(/app\.(fin_)?fail\('([A-Z_]+)'/g) || [];
    return (raises.length === 0 && codes.length >= 100 && codes.every(c => /app\.(fin_)?fail\('MRS_[A-Z_]+'/.test(c))) || J({ raises: raises.length, codes: codes.length });
  });
  await check('every MRS code used has an Arabic message in supa.js and Arabic + English in i18n.js; the new codes are exactly the 11 of the header', () => {
    const used = [...new Set((src.match(/app\.(?:fin_)?fail\('(MRS_[A-Z_]+)'/g) || []).map(x => x.replace(/^.*\('/, '').replace(/'$/, '')))].sort();
    const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
    const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
    const missing = used.filter(c => !new RegExp('\\b' + c + ':').test(supa) || (i18n.match(new RegExp('\\n\\s+' + c + ': ', 'g')) || []).length < 2);
    const newOnes = used.filter(c => /^MRS_(PAY_|CUSTODY_|CONFIRM_INVOICE)/.test(c));
    return (missing.length === 0 && J(newOnes.sort()) === J(CODES.slice().sort()) && CODES.every(c => src.slice(0, 9000).includes(c))) || 'missing: ' + missing.join(', ') + ' new: ' + newOnes;
  });
  await check('no TRUNCATE / DROP TABLE / DROP FUNCTION / DISABLE TRIGGER / session_replication_role / DELETE; no key or endpoint', () => {
    const c = src.replace(/--.*$/gm, '');
    return (!/\bTRUNCATE\b/i.test(c) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA|VIEW)/i.test(c) && !/DISABLE TRIGGER/i.test(c) && !/session_replication_role/.test(c)
      && !/\bDELETE\s+FROM\b/i.test(c) && !/sk-ant|api\.anthropic\.com|https?:\/\//i.test(src)) || 'body';
  });
  await check('no personal data / legacy organization name or constant payer copied from the legacy code', () =>
    (!/@[a-z0-9-]+\.[a-z]/i.test(src.replace(/--.*$/gm, '')) && !/\b05[0-9]{8}\b/.test(src) && !/رأس الحكمة/.test(src) && !/institutionName\s*[:=]/.test(src)) || 'personal data');
  await check('the owner decisions are in the code: four eyes without an admin exception, no Daftra call, the void-deposit check, no auto-approval', () => {
    const c = src.replace(/--.*$/gm, '');
    return (/IF app\.pay_is_author\(v_d\.id, auth\.uid\(\)\) THEN PERFORM app\.fail\('MRS_FORBIDDEN', 'self_approval'\)/.test(c) && !/fin_four_eyes/.test(c)
      && !/INSERT INTO public\.(billing_|daftra_)|functions\.invoke|net\.http/i.test(c) && /IF v_bal - v_e\.signed_amount < 0 THEN PERFORM app\.fin_fail\('MRS_CUSTODY_NEGATIVE'/.test(c)
      && !/review_status = 'approved'[^;]*INSERT/.test(c) && /v_review NOT IN \('draft','pending'\)/.test(c)) || 'decisions';
  });
  const LATER_PHASES = [];
  await check('this file is the latest migration (or only listed later phases follow it)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (appended last, in order) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && next < 0 && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 16000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
  await check('docs/online/LEGACY_PAY_AR.md exists and names the migration, every RPC, the error codes, the doc types and the rules', () => {
    const p = path.join(ROOT, 'docs', 'online', 'LEGACY_PAY_AR.md');
    if (!fs.existsSync(p)) return 'missing';
    const d = fs.readFileSync(p, 'utf8');
    const miss = [MIG, 'client_disbursements', 'disbursement_allocations', 'payment_documents', 'client_custody_entries', 'client_custody_balances',
      'payment_proof', 'appointment_invoice', 'ai-doc-v3', 'fasah_wallet', 'dry_port_wallet', 'sadad', 'mada', 'TAS', 'FP', 'عهدة', 'أربع أعين', 'supplier_payments']
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
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261121000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without legacy_appt: exact preflight message, nothing created', async () =>
        (msg.startsWith('LEGACY PAY preflight: apply legacy_appt first (schema_versions lacks 20261121000100 legacy_appt)')
          && (await one(`SELECT to_regclass('public.client_disbursements') IS NULL x`)).x && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261121000100', 'legacy_appt')`);
      const r1 = await tryErr(() => db.exec(src));
      const C1 = await catalog();
      const audit1 = await num(`SELECT count(*) n FROM public.audit_log`);
      const r3 = await tryErr(() => db.exec(src));
      await check('applies, then re-runs on top of itself with an identical catalog (functions, ACLs, indexes, triggers, policies, constraints, columns, grants, labels); no data', async () =>
        (r1 === 'ok' && r3 === 'ok' && J(C1) === J(await catalog()) && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261122000100'`)) === 1
          && (await num(`SELECT count(*) n FROM public.audit_log`)) === audit1) || J({ r1, r3 }));
      const s0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the new functions, tables and view; the re-created ones listed (ACL / definer / config kept)', () => {
        const nm = s => s.split('(')[0];
        const added = [...new Set(C1.fns.filter(f => !s0.has(f.sig)).map(f => nm(f.sig)))].sort();
        const changed = C1.fns.filter(f => s0.has(f.sig) && s0.get(f.sig).h !== f.h).map(f => nm(f.sig)).sort();
        const keep = C1.fns.filter(f => s0.has(f.sig) && RECREATED.includes(nm(f.sig)))
          .every(f => s0.get(f.sig).acl === f.acl && s0.get(f.sig).d === f.d && s0.get(f.sig).c === f.c);
        const tbl = C1.tables.filter(t => !C0.tables.includes(t)).sort();
        return (J(added) === J(NEW_FNS.slice().sort()) && J(changed) === J(RECREATED) && keep && J(tbl) === J(NEW_TABLES)) || J({ added, changed, tbl });
      });
      await check('catalog: the only new columns outside the new tables are supplier_invoices.internal_invoice_no / created_by_disbursement_id and supplier_payments.disbursement_allocation_id; G4 RPCs untouched', () => {
        const cols = C1.cols.filter(c => !C0.cols.includes(c) && !NEW_TABLES.some(t => c.startsWith(t.split('.')[1] + '.'))).sort();
        const same = ['public.record_supplier_payment', 'public.void_supplier_payment', 'public.create_supplier_invoice', 'public.create_client_charge',
          'app.fin_payment_recompute', 'app.fin_funding_check', 'app.norm_tas'].every(n => C1.fns.filter(f => f.sig.startsWith(n + '(')).every(f => s0.get(f.sig) && s0.get(f.sig).h === f.h));
        return (J(cols) === J(['supplier_invoices.created_by_disbursement_id', 'supplier_invoices.internal_invoice_no', 'supplier_payments.disbursement_allocation_id']) && same) || J({ cols, same });
      });
      await check('catalog: anon / authenticated grants on the new relations are SELECT for authenticated only', () => {
        const g = C1.grants.filter(x => !C0.grants.includes(x) && !/:service_role:/.test(x));
        return (g.length === 5 && g.every(x => /:authenticated:SELECT$/.test(x))) || J(g);
      });
      await check('catalog: the new labels are the 7 domains (19 rows); existing labels unchanged', () => {
        const add = C1.labels.filter(x => !C0.labels.includes(x));
        const gone = C0.labels.filter(x => !C1.labels.includes(x));
        return (gone.length === 0 && add.length === 19 && add.every(x => /^(pay_movement_type|pay_pattern|pay_review_status|pay_status|pay_document_role|custody_entry_kind|custody_entry_status)\./.test(x))) || J({ add, gone });
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. matrix, payer, references */
async function secMatrix() {
  section('3. funding source × method matrix (SQL + RPC), payer defaults, method references');
  const t = await mkTx();
  await check('app.fin_funding_check is the CHECK of the table: a row breaking the matrix cannot be stored even by the owner', async () => {
    const r = await code(() => q(`INSERT INTO public.client_disbursements (org_id, branch_id, ref, movement_type, pattern, service_item_id, service_code,
        expected_amount, paid_amount, paid_at, funding_source, method, payer_name, beneficiary_party_id, beneficiary_name, receipt_no, created_by)
      VALUES ($1, $2, 'PAY-999990', 'org_paid', 'single', $3, 'x1', 1, 1, current_date, 'cash_box', 'mada', 'x', $4, 'x', 'R1', $5)`,
      [A, JED, svcItem, SUP, U.acc]));
    return r === 'chk:client_disbursements_matrix_chk' || r;
  });
  const cases = [
    ['fasah_wallet method needs the fasah_wallet source', { funding_source: 'org_account', method: 'fasah_wallet', sadad_number: undefined, paying_account: undefined }, 'MRS_PAY_FUNDING fasah_wallet_source'],
    ['fasah_wallet source needs the fasah_wallet method', { funding_source: 'fasah_wallet', method: 'sadad', paying_account: undefined }, 'MRS_PAY_FUNDING fasah_wallet_method'],
    ['cash box ⇒ cash', { funding_source: 'cash_box', method: 'mada', sadad_number: undefined, receipt_no: receipt() }, 'MRS_PAY_FUNDING cash_box_method'],
    ['dry-port wallet method needs a dry-port source', { funding_source: 'org_account', method: 'dry_port_wallet', sadad_number: undefined, paying_account: undefined }, 'MRS_PAY_FUNDING dry_port_wallet_source'],
    ['a dry-port source needs the dry-port method', { funding_source: 'client_custody_dry_port', method: 'cash', sadad_number: undefined, receipt_no: receipt(), paying_account: undefined }, 'MRS_PAY_FUNDING dry_port_wallet_method'],
    ['personal account needs the payer name', { funding_source: 'personal_account', method: 'cash', sadad_number: undefined, receipt_no: receipt(), paying_account: undefined }, 'MRS_PAY_FUNDING payer_name'],
    ['SADAD needs the paying account', { paying_account: undefined }, 'MRS_PAY_FUNDING paying_account'],
    ['mada needs the paying account', { method: 'mada', sadad_number: undefined, receipt_no: receipt(), paying_account: undefined }, 'MRS_PAY_FUNDING paying_account'],
    ['bank transfer needs the paying account', { method: 'bank_transfer', sadad_number: undefined, bank_reference: bankRef(), paying_account: undefined }, 'MRS_PAY_FUNDING paying_account'],
    ['a wallet has no bank / account', { funding_source: 'fasah_wallet', method: 'fasah_wallet', sadad_number: undefined, receipt_no: receipt() }, 'MRS_PAY_FUNDING wallet_no_account'],
    ['org_paid needs a real funding source', { funding_source: undefined }, 'MRS_REQUIRED funding_source'],
    ['the legacy_unknown source is never accepted for a new entry', { funding_source: 'legacy_unknown' }, 'MRS_PAY_FUNDING funding_source'],
    ['client_direct is not an org_paid source', { funding_source: 'client_direct' }, 'MRS_PAY_FUNDING funding_source'],
    ['card / offset are not register methods', { method: 'card' }, 'MRS_INVALID method']
  ];
  for (const [name, o, want] of cases) {
    await check('matrix: ' + name + ' → ' + want, async () => {
      const p = base(t.id, o); Object.keys(p).forEach(k => { if (p[k] === undefined) delete p[k]; });
      const r = await code(() => rec('acc', p));
      return r === want || r;
    });
  }
  await check('allowed: fasah wallet + fasah wallet (no account, payer «محفظة فسح»), dry-port wallet org-funded, cash box + cash (payer = the org name), personal account + its payer, client custody', async () => {
    const r1 = await rec('acc', base(t.id, { funding_source: 'fasah_wallet', method: 'fasah_wallet', sadad_number: sadadNo(), paying_account: undefined }));
    const r2 = await rec('acc', base(t.id, { funding_source: 'dry_port_wallet_org', method: 'dry_port_wallet', sadad_number: undefined, receipt_no: receipt(), paying_account: undefined }));
    const r3 = await rec('acc', base(t.id, { funding_source: 'cash_box', method: 'cash', sadad_number: undefined, receipt_no: receipt(), paying_account: undefined }));
    const r4 = await rec('acc', base(t.id, { funding_source: 'personal_account', method: 'cash', sadad_number: undefined, receipt_no: receipt(), paying_account: undefined, payer_name: 'Test Employee' }));
    const r5 = await rec('acc', base(t.id, { funding_source: 'client_custody', paying_account: 'Client bank 1' }));
    return (r1.payer_name === 'محفظة فسح' && r1.paying_account === null && r2.payer_name === 'محفظة الميناء الجاف' && r3.payer_name === 'مؤسسة البحر الأزرق (بيئة تجريبية)'
      && r4.payer_name === 'Test Employee' && r5.payer_name === 'شركة الاختبار الأولى للتجارة' && r5.funding_source === 'client_custody') || J([r1.payer_name, r2.payer_name, r3.payer_name, r4.payer_name, r5.payer_name]);
  });
  await check('payer default for org_account = organizations.settings.payer_name when set (not a constant), else the org name; a typed payer is replaced', async () => {
    const a = await rec('acc', base(t.id, { payer_name: 'typed name' }));
    await q(`UPDATE public.organizations SET settings = settings || '{"payer_name": "اسم الدافع من الإعدادات"}' WHERE id = $1`, [A]);
    const b = await rec('acc', base(t.id));
    await q(`UPDATE public.organizations SET settings = settings - 'payer_name' WHERE id = $1`, [A]);
    return (a.payer_name === 'مؤسسة البحر الأزرق (بيئة تجريبية)' && b.payer_name === 'اسم الدافع من الإعدادات') || J([a.payer_name, b.payer_name]);
  });
  await check('client_direct → funding client_direct, payer = the client; received_from_client → funding not_applicable_receipt, beneficiary = the org (no party), no invoice booked', async () => {
    const pr = await mkDoc();
    const a = await rec('acc', base(t.id, { movement_type: 'client_direct', funding_source: 'org_account', documents: [{ finance_document_id: pr, role: 'payment_proof' }] }));
    const b = await rec('acc', base(t.id, { movement_type: 'received_from_client', funding_source: undefined, beneficiary_party_id: undefined, claim_no: claim() }));
    const b2 = await code(() => rec('acc', base(t.id, { movement_type: 'received_from_client', beneficiary_party_id: SUP })));
    return (a.funding_source === 'client_direct' && a.payer_name === 'شركة الاختبار الأولى للتجارة' && b.funding_source === 'not_applicable_receipt'
      && b.beneficiary_party_id === null && b.beneficiary_name === 'مؤسسة البحر الأزرق (بيئة تجريبية)' && b.allocations[0].supplier_invoice === null
      && b.allocations[0].supplier_payment_id === null && b2 === 'MRS_INVALID beneficiary_party_id') || J({ a: a.funding_source, b: b.beneficiary_name, b2 });
  });
  await check('beneficiary (the invoice issuer) is required, an active party of the org', async () => {
    const r = [await code(() => rec('acc', base(t.id, { beneficiary_party_id: undefined }))), await code(() => rec('acc', base(t.id, { beneficiary_party_id: SUP_OFF }))),
      await code(() => rec('acc', base(t.id, { beneficiary_party_id: SUP_B })))];
    return J(r) === J(['MRS_REQUIRED beneficiary_party_id', 'MRS_INVALID beneficiary_party_id', 'MRS_INVALID beneficiary_party_id']) || J(r);
  });
  await check('references: SADAD digits only (Arabic digits converted), bank ref ^[A-Z0-9]+(-[A-Z0-9]+)*$ (upper-cased), receipt ≤ 100 with letters / digits', async () => {
    const r = [await code(() => rec('acc', base(t.id, { sadad_number: '12 34' }))), await code(() => rec('acc', base(t.id, { sadad_number: '12A4' }))),
      await code(() => rec('acc', base(t.id, { method: 'bank_transfer', sadad_number: undefined, bank_reference: 'AB--12' }))),
      await code(() => rec('acc', base(t.id, { method: 'bank_transfer', sadad_number: undefined, bank_reference: 'AB 12' }))),
      await code(() => rec('acc', base(t.id, { method: 'mada', sadad_number: undefined, receipt_no: 'x'.repeat(101) }))),
      await code(() => rec('acc', base(t.id, { method: 'mada', sadad_number: undefined, receipt_no: '#12' })))];
    const ok1 = await rec('acc', base(t.id, { sadad_number: '٧٧٧' + String(++refSeq) }));
    const ok2 = await rec('acc', base(t.id, { method: 'bank_transfer', sadad_number: undefined, bank_reference: 'ft' + (++refSeq) + '-ab' }));
    return (J(r) === J(['MRS_PAY_REFERENCE sadad_number', 'MRS_PAY_REFERENCE sadad_number', 'MRS_PAY_REFERENCE bank_reference', 'MRS_PAY_REFERENCE bank_reference',
      'MRS_TOO_LONG receipt_no', 'MRS_PAY_REFERENCE receipt_no']) && /^777[0-9]+$/.test(ok1.sadad_number) && /^FT[0-9]+-AB$/.test(ok2.bank_reference)) || J({ r, a: ok1.sadad_number, b: ok2.bank_reference });
  });
  await check('one reference column per method: missing → MRS_REQUIRED, the column of another method → MRS_PAY_REF_METHOD; a wallet needs a reference or the proof file', async () => {
    const r = [await code(() => rec('acc', base(t.id, { sadad_number: undefined }))),
      await code(() => rec('acc', base(t.id, { method: 'bank_transfer', sadad_number: undefined }))),
      await code(() => rec('acc', base(t.id, { method: 'cheque', sadad_number: undefined }))),
      await code(() => rec('acc', base(t.id, { receipt_no: receipt() }))),
      await code(() => rec('acc', base(t.id, { method: 'bank_transfer', bank_reference: bankRef() }))),
      await code(() => rec('acc', base(t.id, { method: 'cash', funding_source: 'cash_box', sadad_number: undefined, receipt_no: receipt(), bank_reference: bankRef() }))),
      await code(() => rec('acc', base(t.id, { funding_source: 'fasah_wallet', method: 'fasah_wallet', sadad_number: undefined, paying_account: undefined })))];
    const pr = await mkDoc();
    const w = await rec('acc', base(t.id, { funding_source: 'fasah_wallet', method: 'fasah_wallet', sadad_number: undefined, paying_account: undefined,
      documents: [{ finance_document_id: pr, role: 'payment_proof' }] }));
    return (J(r) === J(['MRS_REQUIRED sadad_number', 'MRS_REQUIRED bank_reference', 'MRS_REQUIRED receipt_no', 'MRS_PAY_REF_METHOD receipt_no',
      'MRS_PAY_REF_METHOD sadad_number', 'MRS_PAY_REF_METHOD bank_reference', 'MRS_REQUIRED payment_reference']) && !!w.id) || J(r);
  });
  await check('the other fields: service item from the catalog, paid > 0, date required and not after today (Riyadh), appointment no TAS normalised (bidi, reversed), expected / difference', async () => {
    const r = [await code(() => rec('acc', base(t.id, { service_code: 'no_such_item' }))), await code(() => rec('acc', base(t.id, { service_code: undefined }))),
      await code(() => rec('acc', base(t.id, { paid_amount: 0 }))), await code(() => rec('acc', base(t.id, { paid_amount: undefined }))),
      await code(() => rec('acc', base(t.id, { paid_at: undefined }))), await code(() => rec('acc', base(t.id, { paid_at: '2099-01-01' }))),
      await code(() => rec('acc', base(t.id, { appointment_no: 'TAS12' })))];
    const a = await rec('acc', base(t.id, { appointment_no: '‏20261115004211TAS', expected_amount: 120, paid_amount: 100 }));
    const b = await rec('acc', base(t.id, { service_item_id: svcItem, service_code: undefined, expected_amount: 80 }));
    return (J(r) === J(['MRS_INVALID service_item', 'MRS_REQUIRED service_item', 'MRS_INVALID paid_amount', 'MRS_REQUIRED paid_amount', 'MRS_REQUIRED paid_at',
      'MRS_INVALID paid_at', 'MRS_INVALID appointment_no']) && a.appointment_no === 'TAS20261115004211' && Number(a.difference) === 20 && a.paid_at === '2026-11-01'
      && Number(b.difference) === -20 && b.service_code === 'port_charges' && !!a.service_name_ar) || J({ r, a: a.appointment_no, d: a.difference });
  });
  await check('the transaction: required, a finance writer of its branch, not cancelled; non-finance staff / another org refused', async () => {
    const tc = await mkTx();
    await q(`UPDATE public.transactions SET cancelled_at = now(), cancelled_by = $2, cancel_reason = 'test', operational_status = 'closed' WHERE id = $1`, [tc.id, U.admin]);
    const r = [await code(() => rec('acc', base(undefined))), await code(() => rec('jed', base(t.id))), await code(() => rec('accD', base(t.id))),
      await code(() => rec('staffB', base(t.id))), await code(() => rec('acc', base(tc.id))), await code(() => rec('sup', base(t.id)))];
    return J(r) === J(['MRS_REQUIRED transaction_id', 'MRS_FORBIDDEN role', 'MRS_NOT_FOUND transaction', 'MRS_NOT_FOUND transaction', 'MRS_BAD_TRANSITION cancelled', 'MRS_FORBIDDEN role']) || J(r);
  });
}

/* ================================================================== 4. G4 bookings, idempotency */
async function secBooking() {
  section('4. record_payment_bundle: the G4 supplier invoice / payment, idempotent replay, events');
  const t = await mkTx();
  let P;
  await check('org_paid + claim no → a new supplier invoice of the issuer (total = expected, the entity invoice file, the FP internal no) + a company supplier payment; invoice paid', async () => {
    const inv = await mkDoc(), pr = await mkDoc();
    P = await rec('acc', base(t.id, { claim_no: 'REF-260809154618646', internal_invoice_no: 'fp 00012345', expected_amount: 100, paid_amount: 100,
      documents: [{ finance_document_id: inv, role: 'entity_invoice' }, { finance_document_id: pr, role: 'payment_proof' }] }));
    const a = P.allocations[0];
    const si = await one(`SELECT * FROM public.supplier_invoices WHERE id = $1`, [a.supplier_invoice.id]);
    const sp = await one(`SELECT * FROM public.supplier_payments WHERE id = $1`, [a.supplier_payment_id]);
    return (P.ref && /^PAY-\d{6}$/.test(P.ref) && P.review_status === 'pending' && P.status === 'recorded' && si.supplier_id === SUP && si.invoice_number === 'REF-260809154618646'
      && Number(si.total_amount) === 100 && si.finance_document_id === inv && si.internal_invoice_no === 'FP 00012345' && si.created_by_disbursement_id === P.id
      && si.payment_status === 'paid' && sp.payer === 'company' && sp.evidence_document_id === pr && sp.reference === P.sadad_number && sp.method === 'sadad'
      && sp.disbursement_allocation_id === a.id && P.documents.length === 2 && a.supplier_invoice.created_by_this === true) || J({ P: P.ref, si, sp });
  });
  await check('paid above the claim value (legacy: negative difference) → saved, the invoice total = the paid amount; an explicit invoice_total below the paid amount → G4 MRS_OVERPAID (nothing written); paid below → partial, difference kept', async () => {
    const p1 = await rec('acc', base(t.id, { claim_no: claim(), expected_amount: 50, paid_amount: 60 }));
    const si1 = await one(`SELECT total_amount, payment_status FROM public.supplier_invoices WHERE id = $1`, [p1.allocations[0].supplier_invoice.id]);
    const n0 = await num(`SELECT count(*) n FROM public.client_disbursements`);
    const r = await code(() => rec('acc', base(t.id, { claim_no: claim(), expected_amount: 50, paid_amount: 60, invoice_total: 50 })));
    const n1 = await num(`SELECT count(*) n FROM public.client_disbursements`);
    const p2 = await rec('acc', base(t.id, { claim_no: claim(), expected_amount: 150, paid_amount: 100 }));
    const st = (await one(`SELECT payment_status s FROM public.supplier_invoices WHERE id = $1`, [p2.allocations[0].supplier_invoice.id])).s;
    return (Number(p1.difference) === -10 && Number(si1.total_amount) === 60 && si1.payment_status === 'paid'
      && /^MRS_OVERPAID/.test(r) && n0 === n1 && st === 'partial' && Number(p2.difference) === 50) || J({ r, st, si1, d: p1.difference });
  });
  await check('no claim no → only the register (no invoice, no G4 payment)', async () => {
    const p = await rec('acc', base(t.id));
    return (p.allocations[0].supplier_invoice === null && p.allocations[0].supplier_payment_id === null && p.claim_no === null) || J(p.allocations);
  });
  await check('client_direct + claim no → a CLIENT supplier payment of the transaction\'s client (no G4 cost allocation needed: the register line proves the share); the proof file is required', async () => {
    const pr = await mkDoc();
    const r = await code(() => rec('acc', base(t.id, { movement_type: 'client_direct', claim_no: claim() })));
    const p = await rec('acc', base(t.id, { movement_type: 'client_direct', claim_no: claim(), documents: [{ finance_document_id: pr, role: 'payment_proof' }] }));
    const sp = await one(`SELECT payer, client_id FROM public.supplier_payments WHERE id = $1`, [p.allocations[0].supplier_payment_id]);
    const si = await one(`SELECT payment_status FROM public.supplier_invoices WHERE id = $1`, [p.allocations[0].supplier_invoice.id]);
    return (r === 'MRS_REQUIRED payment_proof' && sp.payer === 'client' && sp.client_id === CLIENT_A && si.payment_status === 'paid_directly_by_client') || J({ r, sp, si });
  });
  await check('G4 unchanged for direct record_supplier_payment: a client payer without a cost allocation is still refused (tg_payment_totals re-created)', async () => {
    const si = (await rpc('acc', `SELECT public.create_supplier_invoice($1) r`, [{ branch_id: JED, supplier_id: SUP2, invoice_number: claim(), invoice_date: '2026-11-01', total_amount: 10 }])).id;
    const pr = await mkDoc();
    const r = await code(() => rpc('acc', `SELECT public.record_supplier_payment($1) r`, [{ supplier_invoice_id: si, amount: 5, paid_at: '2026-11-01', method: 'cash',
      payer: 'client', client_id: CLIENT_A, evidence_document_id: pr }]));
    return r === 'MRS_INVALID client_id' || r;
  });
  await check('idempotent: the same key + payload → the stored answer (replayed), no second entry / payment; the same key with another payload → MRS_IDEMPOTENCY_CONFLICT', async () => {
    const k = newKey(), p = base(t.id, { claim_no: claim() });
    const a = await rec('acc', p, k);
    const n = await num(`SELECT count(*) n FROM public.client_disbursements`);
    const b = await rec('acc', p, k);
    const c = await code(() => rec('acc', Object.assign({}, p, { paid_amount: 99 }), k));
    return (a.id === b.id && b.replayed === true && n === await num(`SELECT count(*) n FROM public.client_disbursements`) && c === 'MRS_IDEMPOTENCY_CONFLICT idempotency_key') || J({ a: a.id, b: b.id, c });
  });
  await check('finance events on the transaction (never amounts): payment_recorded with the ref', async () => {
    const r = await q(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'finance' AND payload ->> 'op' = 'payment_recorded'`, [t.id]);
    return (r.length >= 5 && r.every(x => x.payload.entity === 'client_disbursement' && x.payload.ref && !('amount' in x.payload) && !('paid_amount' in x.payload))) || J(r.slice(0, 2));
  });
  await check('direct writes are refused (the RPC is the only path): authenticated cannot INSERT / UPDATE / DELETE', async () => {
    const r = [await code(() => as('admin', `UPDATE public.client_disbursements SET notes = 'x'`)), await code(() => as('admin', `DELETE FROM public.disbursement_allocations`)),
      await code(() => as('admin', `INSERT INTO public.payment_documents (org_id) VALUES ($1)`, [A]))];
    return r.every(x => x === 'perm') || J(r);
  });
  await check('append-only (owner): no DELETE (MRS_APPEND_ONLY), immutable amounts (MRS_IMMUTABLE), a void entry stays void', async () => {
    const r = [await code(() => q(`DELETE FROM public.client_disbursements WHERE id = $1`, [P.id])),
      await code(() => q(`UPDATE public.client_disbursements SET paid_amount = 1 WHERE id = $1`, [P.id])),
      await code(() => q(`UPDATE public.disbursement_allocations SET amount = 1 WHERE disbursement_id = $1`, [P.id])),
      await code(() => q(`DELETE FROM public.client_custody_entries WHERE org_id = $1`, [A]))];
    return (/MRS_APPEND_ONLY/.test(r[0]) && /MRS_IMMUTABLE paid_amount/.test(r[1]) && /MRS_IMMUTABLE amount/.test(r[2]) && (r[3] === 'ok' || /MRS_APPEND_ONLY/.test(r[3]))) || J(r);
  });
}

/* ================================================================== 5. duplicates and invoice identity */
async function secDuplicates() {
  section('5. global duplicate prevention of references; invoice identity');
  const t = await mkTx(), t2 = await mkTx();
  await check('the same SADAD no (any transaction of the org) → MRS_PAY_REF_TAKEN sadad_number, the message cites the earlier entry, its transaction and amount', async () => {
    const s = sadadNo();
    const a = await rec('acc', base(t.id, { sadad_number: s, paid_amount: 1250 }));
    const r = await code(() => rec('acc', base(t2.id, { sadad_number: s })), true);
    return r === 'MRS_PAY_REF_TAKEN sadad_number | ' + a.ref + ' · ' + t.ref + ' · 1250.00 SAR' || r;
  });
  await check('bank refs compare without dashes / case (FT1-AB = ft1ab); receipts without separators', async () => {
    const n = ++refSeq;
    await rec('acc', base(t.id, { method: 'bank_transfer', sadad_number: undefined, bank_reference: 'FT' + n + '-AB' }));
    const r1 = await code(() => rec('acc', base(t2.id, { method: 'bank_transfer', sadad_number: undefined, bank_reference: 'ft' + n + 'ab' })));
    await rec('acc', base(t.id, { method: 'mada', sadad_number: undefined, receipt_no: 'R ' + n + '/7' }));
    const r2 = await code(() => rec('acc', base(t2.id, { method: 'cheque', sadad_number: undefined, receipt_no: 'r-' + n + '.7' })));
    return (r1 === 'MRS_PAY_REF_TAKEN bank_reference' && r2 === 'MRS_PAY_REF_TAKEN receipt_no') || J({ r1, r2 });
  });
  await check('the unique indexes back the check (owner insert of a duplicate SADAD no fails); another org may use the same number', async () => {
    const s = sadadNo();
    const a = await rec('acc', base(t.id, { sadad_number: s }));
    const r = await code(() => q(`INSERT INTO public.client_disbursements (org_id, branch_id, ref, movement_type, pattern, service_item_id, service_code,
        expected_amount, paid_amount, paid_at, funding_source, method, paying_account, payer_name, beneficiary_party_id, beneficiary_name, sadad_number, created_by)
      SELECT org_id, branch_id, 'PAY-999991', movement_type, pattern, service_item_id, service_code, 1, 1, paid_at, funding_source, method, paying_account, payer_name,
             beneficiary_party_id, beneficiary_name, sadad_number, created_by FROM public.client_disbursements WHERE id = $1`, [a.id]));
    const tb = await mkTx({ org: B, branch: BR_B, client: CL_B });
    const itemB = (await one(`SELECT id FROM public.org_service_items WHERE org_id = $1 AND code = 'port_charges'`, [B])).id;
    const b = await rec('staffB', base(tb.id, { sadad_number: s, beneficiary_party_id: SUP_B, service_code: undefined, service_item_id: itemB }));
    return (r === 'uniq:client_disbursements_sadad_uidx' && b.sadad_number === s) || r;
  });
  await check('a void entry frees its reference', async () => {
    const s = sadadNo();
    const a = await rec('acc', base(t.id, { sadad_number: s }));
    await voidPay('mgr', a.id, 'entered twice');
    const b = await rec('acc', base(t2.id, { sadad_number: s }));
    return b.sadad_number === s;
  });
  await check('invoice identity: the same issuer + the same invoice no in a live entry → MRS_PAY_INVOICE_TAKEN (also inside one shared entry); number variants (inv-0012 = INV 12) count as the same', async () => {
    const c = 'IDN-' + (++refSeq);
    const a = await rec('acc', base(t.id, { claim_no: c + '-0012' }));
    const r1 = await code(() => rec('acc', base(t2.id, { claim_no: c + ' 12' })), true);
    const r2 = await code(() => rec('acc', base(undefined, { pattern: 'shared', transaction_id: undefined, paid_amount: 20,
      allocations: [{ transaction_id: t.id, amount: 10, claim_no: 'SH-' + refSeq }, { transaction_id: t2.id, amount: 10, claim_no: 'sh ' + refSeq }] })));
    return (r1.startsWith('MRS_PAY_INVOICE_TAKEN invoice_number | ' + a.ref) && r2.startsWith('MRS_PAY_INVOICE_TAKEN invoice_number')) || J({ r1, r2 });
  });
  await check('the same invoice no from ANOTHER issuer → MRS_CONFIRM_INVOICE_REUSE (names the other issuer); confirm_invoice_reuse → saved', async () => {
    const c = claim();
    await rec('acc', base(t.id, { claim_no: c }));
    const r = await code(() => rec('acc', base(t2.id, { claim_no: c, beneficiary_party_id: SUP2 })), true);
    const ok = await rec('acc', base(t2.id, { claim_no: c, beneficiary_party_id: SUP2, confirm_invoice_reuse: true }));
    return (r === 'MRS_CONFIRM_INVOICE_REUSE invoice_number | ' + c + ' · جهة الفاتورة التجريبية' && !!ok.allocations[0].supplier_invoice.id) || J({ r });
  });
  await check('an existing G4 invoice of the issuer with that number (entered in payables) is reused, not created twice; an explicit supplier_invoice_id must be of the issuer', async () => {
    const c = claim();
    const si = (await rpc('acc', `SELECT public.create_supplier_invoice($1) r`, [{ branch_id: JED, supplier_id: SUP, invoice_number: c, invoice_date: '2026-10-30', total_amount: 300 }])).id;
    const p = await rec('acc', base(t.id, { claim_no: c, paid_amount: 100 }));
    const n = await num(`SELECT count(*) n FROM public.supplier_invoices WHERE org_id = $1 AND number_norm = app.fin_norm_no($2)`, [A, c]);
    const st = (await one(`SELECT payment_status s FROM public.supplier_invoices WHERE id = $1`, [si])).s;
    const si2 = (await rpc('acc', `SELECT public.create_supplier_invoice($1) r`, [{ branch_id: JED, supplier_id: SUP2, invoice_number: claim(), invoice_date: '2026-10-30', total_amount: 300 }])).id;
    const bad = await code(() => rec('acc', base(t.id, { supplier_invoice_id: si2 })));
    return (p.allocations[0].supplier_invoice.id === si && p.allocations[0].supplier_invoice.created_by_this === false && n === 1 && st === 'partial'
      && bad === 'MRS_INVALID supplier_invoice_id') || J({ n, st, bad });
  });
  await check('supplier_invoices.internal_invoice_no is unique among the org\'s non-void invoices (FP 1 = fp-1): MRS_PAY_INVOICE_TAKEN internal_invoice_no; the index backs it', async () => {
    const fp = 'FP' + (900000 + (++refSeq));
    await rec('acc', base(t.id, { claim_no: claim(), internal_invoice_no: fp }));
    const r = await code(() => rec('acc', base(t2.id, { claim_no: claim(), internal_invoice_no: fp.toLowerCase().replace('fp', 'fp-') })));
    const idx = await one(`SELECT indexdef d FROM pg_indexes WHERE indexname = 'supplier_invoices_internal_no_uidx'`);
    return (r === 'MRS_PAY_INVOICE_TAKEN internal_invoice_no' && /UNIQUE/.test(idx.d)) || r;
  });
  await check('check_payment_duplicates: the live form check lists the reference conflicts and the invoice conflicts (taken / other issuer / existing G4 invoice / internal no) without saving', async () => {
    const s = sadadNo(), c = claim(), c2 = claim(), fp = 'FP77' + refSeq;
    const a = await rec('acc', base(t.id, { sadad_number: s, claim_no: c, internal_invoice_no: fp }));
    await rpc('acc', `SELECT public.create_supplier_invoice($1) r`, [{ branch_id: JED, supplier_id: SUP, invoice_number: c2, invoice_date: '2026-10-30', total_amount: 5 }]);
    const n0 = await num(`SELECT count(*) n FROM public.client_disbursements`);
    const r = await rpc('acc', `SELECT public.check_payment_duplicates($1, $2) r`, [A, { sadad_number: s, beneficiary_party_id: SUP2,
      claims: [{ claim_no: c }, { claim_no: c2 }, { claim_no: 'none', internal_invoice_no: fp.toLowerCase() }] }]);
    const r2 = await rpc('acc', `SELECT public.check_payment_duplicates($1, $2) r`, [A, { sadad_number: s, exclude_id: a.id, beneficiary_party_id: SUP, claims: [{ claim_no: c }] }]);
    const kinds = r.invoices.map(x => x.kind).sort();
    return (r.references.length === 1 && r.references[0].ref === a.ref && r.references[0].transaction_ref === t.ref && J(kinds) === J(['internal_taken', 'other_issuer', 'other_issuer'])
      && r2.references.length === 0 && r2.invoices.length === 0 && n0 === await num(`SELECT count(*) n FROM public.client_disbursements`)) || J({ r, r2 });
  });
}

/* ================================================================== 6. shared allocations */
async function secShared() {
  section('6. shared payment allocations; a transaction shows only its share');
  const t1 = await mkTx(), t2 = await mkTx(), tD = await mkTx({ branch: DMM }), tC2 = await mkTx({ client: CLIENT_A2 });
  const sh = o => base(undefined, Object.assign({ pattern: 'shared', transaction_id: undefined, paid_amount: 100 }, o));
  await check('shared needs ≥ 2 allocations; Σ = total (±0.005: halalas equal); each amount > 0; single cannot carry allocations; shared cannot carry a top-level transaction / claim', async () => {
    const r = [await code(() => rec('acc', sh({ allocations: [{ transaction_id: t1.id, amount: 100 }] }))),
      await code(() => rec('acc', sh({ allocations: [{ transaction_id: t1.id, amount: 60 }, { transaction_id: t2.id, amount: 39.99 }] })), true),
      await code(() => rec('acc', sh({ allocations: [{ transaction_id: t1.id, amount: 100 }, { transaction_id: t2.id, amount: 0 }] }))),
      await code(() => rec('acc', base(t1.id, { allocations: [] }))),
      await code(() => rec('acc', sh({ transaction_id: t1.id, allocations: [{ transaction_id: t1.id, amount: 50 }, { transaction_id: t2.id, amount: 50 }] }))),
      await code(() => rec('acc', sh({ claim_no: 'X', allocations: [{ transaction_id: t1.id, amount: 50 }, { transaction_id: t2.id, amount: 50 }] })))];
    return J(r) === J(['MRS_PAY_ALLOCATION count', 'MRS_PAY_ALLOCATION sum | 0.01', 'MRS_PAY_ALLOCATION amount', 'MRS_PAY_ALLOCATION not_allowed',
      'MRS_PAY_ALLOCATION not_allowed', 'MRS_PAY_ALLOCATION not_allowed']) || J(r);
  });
  await check('no duplicate transaction + invoice inside one entry (the same transaction twice with no invoice too); the same transaction with two invoices is fine', async () => {
    const r = [await code(() => rec('acc', sh({ allocations: [{ transaction_id: t1.id, amount: 50, claim_no: 'D1-' + refSeq }, { transaction_id: t1.id, amount: 50, claim_no: 'd1 ' + refSeq }] }))),
      await code(() => rec('acc', sh({ allocations: [{ transaction_id: t1.id, amount: 50 }, { transaction_id: t1.id, amount: 50 }] })))];
    const ok = await rec('acc', sh({ allocations: [{ transaction_id: t1.id, amount: 50, claim_no: claim() }, { transaction_id: t1.id, amount: 50, claim_no: claim() }] }));
    return (J(r) === J(['MRS_PAY_ALLOCATION duplicate', 'MRS_PAY_ALLOCATION duplicate']) && ok.allocations.length === 2) || J(r);
  });
  await check('one branch per entry (MRS_PAY_ALLOCATION branch); one client for client_direct / received / custody-funded entries (MRS_PAY_ALLOCATION client); org-funded entries may span clients', async () => {
    const r = [await code(() => rec('admin', sh({ allocations: [{ transaction_id: t1.id, amount: 50 }, { transaction_id: tD.id, amount: 50 }] }))),
      await code(() => rec('acc', sh({ movement_type: 'received_from_client', beneficiary_party_id: undefined, funding_source: undefined,
        allocations: [{ transaction_id: t1.id, amount: 50 }, { transaction_id: tC2.id, amount: 50 }] }))),
      await code(() => rec('acc', sh({ funding_source: 'client_custody', allocations: [{ transaction_id: t1.id, amount: 50 }, { transaction_id: tC2.id, amount: 50 }] })))];
    const ok = await rec('acc', sh({ allocations: [{ transaction_id: t1.id, amount: 50 }, { transaction_id: tC2.id, amount: 50 }] }));
    return (J(r) === J(['MRS_PAY_ALLOCATION branch', 'MRS_PAY_ALLOCATION client', 'MRS_PAY_ALLOCATION client']) && ok.allocations.length === 2) || J(r);
  });
  let S;
  await check('a shared entry over 2 transactions with an invoice each: one G4 invoice + payment per line; tx_disbursements of each transaction shows only its share', async () => {
    const i1 = await mkDoc(), i2 = await mkDoc(), pr = await mkDoc();
    S = await rec('acc', sh({ paid_amount: 90, allocations: [{ transaction_id: t1.id, amount: 34.5, claim_no: claim(), key: 'a' }, { transaction_id: t2.id, amount: 55.5, claim_no: claim(), key: 'b' }],
      documents: [{ finance_document_id: i1, role: 'entity_invoice', allocation: 1 }, { finance_document_id: i2, role: 'entity_invoice', allocation: 'b' },
        { finance_document_id: pr, role: 'payment_proof' }] }));
    const x1 = await txPay('acc', t1.id), x2 = await txPay('acc', t2.id);
    const it1 = x1.items.find(i => i.id === S.id), it2 = x2.items.find(i => i.id === S.id);
    const sis = await q(`SELECT finance_document_id f FROM public.supplier_invoices WHERE created_by_disbursement_id = $1 ORDER BY total_amount`, [S.id]);
    return (S.pattern === 'shared' && S.claim_no === null && S.allocations.length === 2 && S.allocations.every(a => a.supplier_payment_id) && Number(it1.share) === 34.5
      && Number(it2.share) === 55.5 && !('paid_amount' in it1) && it1.pattern === 'shared' && sis.length === 2 && sis[0].f === i1 && sis[1].f === i2
      && S.documents.filter(d => d.allocation_id).length === 2) || J({ it1, it2, sis });
  });
  await check('tx_disbursements: count, total share, pending review, rejected, last paid date; finance readers only (a non-finance staff → MRS_FORBIDDEN finance)', async () => {
    const t = await mkTx();
    const a = await rec('acc', base(t.id, { paid_amount: 10, paid_at: '2026-10-01' }));
    const b = await rec('acc', base(t.id, { paid_amount: 15, paid_at: '2026-10-05', review_status: 'draft' }));
    await review('mgr', a.id, 'reject', 'wrong amount');
    const x = await txPay('acc', t.id);
    const r = await code(() => txPay('jed', t.id));
    return (x.count === 2 && Number(x.total_share) === 25 && x.pending_review === 1 && x.rejected === 1 && x.last_paid_at === '2026-10-05'
      && x.items.length === 2 && Number(x.by_movement.org_paid) === 25 && r === 'MRS_FORBIDDEN finance') || J({ x, r });
  });
  await check('the deferred Σ check backs the RPC: an owner insert of an entry without its allocation fails at commit', async () => {
    const r = await tryErr(() => db.exec(`BEGIN; INSERT INTO public.client_disbursements (org_id, branch_id, ref, movement_type, pattern, service_item_id, service_code,
        expected_amount, paid_amount, paid_at, funding_source, method, paying_account, payer_name, beneficiary_party_id, beneficiary_name, sadad_number, created_by)
      VALUES ('${A}', '${JED}', 'PAY-999992', 'org_paid', 'single', '${svcItem}', 'x1', 5, 5, current_date, 'org_account', 'sadad', 'b', 'p', '${SUP}', 'x', '9${++refSeq}', '${U.acc}'); COMMIT;`));
    await db.exec('ROLLBACK').catch(() => {});
    return /MRS_PAY_ALLOCATION/.test(r) || r;
  });
  await check('list_payments: search (ref / claim / SADAD / transaction ref / client / payer / beneficiary), filters (movement, pattern, review, method, dates, transaction, client), totals, paging; void hidden by default', async () => {
    const all = await rpc('acc', `SELECT public.list_payments($1, $2) r`, [A, {}]);
    const byRef = await rpc('acc', `SELECT public.list_payments($1, $2) r`, [A, { q: S.ref }]);
    const byTx = await rpc('acc', `SELECT public.list_payments($1, $2) r`, [A, { q: t2.ref }]);
    const shared = await rpc('acc', `SELECT public.list_payments($1, $2) r`, [A, { pattern: 'shared', transaction_id: t2.id }]);
    const rej = await rpc('acc', `SELECT public.list_payments($1, $2) r`, [A, { review_status: 'rejected' }]);
    const dates = await rpc('acc', `SELECT public.list_payments($1, $2) r`, [A, { date_from: '2026-10-02', date_to: '2026-10-06' }]);
    const page = await rpc('acc', `SELECT public.list_payments($1, $2) r`, [A, { limit: 2, offset: 1 }]);
    const voids = await rpc('acc', `SELECT public.list_payments($1, $2) r`, [A, { status: 'void' }]);
    const bad = await code(() => rpc('jed', `SELECT public.list_payments($1, $2) r`, [A, {}]));
    return (all.total > 20 && all.rows.every(r => r.status === 'recorded') && byRef.total === 1 && byRef.rows[0].id === S.id && byTx.rows.some(r => r.id === S.id)
      && shared.total >= 1 && shared.rows.every(r => r.pattern === 'shared') && rej.total === 1 && dates.rows.every(r => r.paid_at >= '2026-10-02' && r.paid_at <= '2026-10-06')
      && page.rows.length === 2 && voids.total >= 1 && voids.rows.every(r => r.status === 'void') && Number(all.totals.paid) > 0 && bad === 'MRS_FORBIDDEN finance') || J({ all: all.total, byRef: byRef.total, rej: rej.total, bad });
  });
}

/* ================================================================== 7. attachments */
async function secDocs() {
  section('7. typed attachments: limits, types, branch, in use, per allocation, soft removal, add later');
  const t = await mkTx(), t2 = await mkTx();
  await check('≤ 8 files per save; each ≤ 4 MB; ≤ 12 MB in all; PDF or image only; the record\'s branch; one live link per file', async () => {
    const docs = []; for (let i = 0; i < 9; i++) docs.push({ finance_document_id: await mkDoc({ size: 1000 }), role: 'extra' });
    const big = await mkDoc({ size: 4 * 1024 * 1024 + 1, name: 'big.pdf' });
    const m = []; for (let i = 0; i < 4; i++) m.push({ finance_document_id: await mkDoc({ size: 3.5 * 1024 * 1024 }), role: 'extra' });
    const xl = await mkDoc({ mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'a.xlsx' });
    const dm = await mkDoc({ branch: DMM });
    const used = await mkDoc();
    await rec('acc', base(t.id, { documents: [{ finance_document_id: used, role: 'extra' }] }));
    const r = [await code(() => rec('acc', base(t.id, { documents: docs }))), await code(() => rec('acc', base(t.id, { documents: [{ finance_document_id: big, role: 'extra' }] })), true),
      await code(() => rec('acc', base(t.id, { documents: m }))), await code(() => rec('acc', base(t.id, { documents: [{ finance_document_id: xl, role: 'extra' }] }))),
      await code(() => rec('acc', base(t.id, { documents: [{ finance_document_id: dm, role: 'extra' }] }))),
      await code(() => rec('acc', base(t.id, { documents: [{ finance_document_id: used, role: 'payment_proof' }] }))),
      await code(() => rec('acc', base(t.id, { documents: [{ finance_document_id: used, role: 'receipt' }] })))];
    const ok8 = await rec('acc', base(t.id, { documents: docs.slice(0, 8) }));
    return (J(r) === J(['MRS_PAY_DOCUMENT count', 'MRS_PAY_DOCUMENT size | big.pdf', 'MRS_PAY_DOCUMENT total', 'MRS_PAY_DOCUMENT type', 'MRS_PAY_DOCUMENT branch',
      'MRS_PAY_DOCUMENT in_use', 'MRS_PAY_DOCUMENT role']) && ok8.documents.length === 8) || J(r);
  });
  await check('shared: every entity invoice names its allocation (index or key); single: no allocation link', async () => {
    const i1 = await mkDoc();
    const r = [await code(() => rec('acc', base(undefined, { pattern: 'shared', transaction_id: undefined, paid_amount: 20, allocations: [{ transaction_id: t.id, amount: 10 }, { transaction_id: t2.id, amount: 10 }],
        documents: [{ finance_document_id: i1, role: 'entity_invoice' }] }))),
      await code(() => rec('acc', base(undefined, { pattern: 'shared', transaction_id: undefined, paid_amount: 20, allocations: [{ transaction_id: t.id, amount: 10 }, { transaction_id: t2.id, amount: 10 }],
        documents: [{ finance_document_id: i1, role: 'entity_invoice', allocation: 3 }] }))),
      await code(() => rec('acc', base(t.id, { documents: [{ finance_document_id: i1, role: 'entity_invoice', allocation: 1 }] })))];
    return J(r) === J(['MRS_PAY_DOCUMENT allocation', 'MRS_PAY_DOCUMENT allocation', 'MRS_PAY_DOCUMENT allocation']) || J(r);
  });
  await check('add_payment_documents adds files to a recorded entry (same limits, idempotent); remove_payment_document removes softly (row kept, file free again)', async () => {
    const p = await rec('acc', base(t.id));
    const d1 = await mkDoc(), d2 = await mkDoc();
    const k = newKey();
    const a = await rpc('acc', `SELECT public.add_payment_documents($1, $2, $3) r`, [p.id, [{ finance_document_id: d1, role: 'payment_proof' }, { finance_document_id: d2, role: 'extra' }], k]);
    const a2 = await rpc('acc', `SELECT public.add_payment_documents($1, $2, $3) r`, [p.id, [{ finance_document_id: d1, role: 'payment_proof' }, { finance_document_id: d2, role: 'extra' }], k]);
    const link = a.documents.find(d => d.finance_document_id === d2).id;
    const nr = await code(() => rpc('acc', `SELECT public.remove_payment_document($1, $2) r`, [link, ' ']));
    const rm = await rpc('acc', `SELECT public.remove_payment_document($1, $2) r`, [link, 'wrong file']);
    const again = await code(() => rpc('acc', `SELECT public.remove_payment_document($1, $2) r`, [link, 'again']));
    const reuse = await rec('acc', base(t.id, { documents: [{ finance_document_id: d2, role: 'extra' }] }));
    const row = await one(`SELECT removed_at IS NOT NULL r, remove_reason FROM public.payment_documents WHERE id = $1`, [link]);
    return (a.documents.length === 2 && a2.replayed === true && nr === 'MRS_NOTE_REQUIRED reason' && rm.document_count === 1 && again === 'MRS_BAD_TRANSITION removed'
      && reuse.documents.length === 1 && row.r && row.remove_reason === 'wrong file') || J({ nr, again, row });
  });
  await check('get_payment: documents carry the storage path for the signed URL; NOT_FOUND for another branch / org / non-finance', async () => {
    const d = await mkDoc();
    const p = await rec('acc', base(t.id, { documents: [{ finance_document_id: d, role: 'payment_proof' }] }));
    const g = await getPay('accJ', p.id);
    const r = [await code(() => getPay('accD', p.id)), await code(() => getPay('staffB', p.id)), await code(() => getPay('jed', p.id)), await code(() => getPay('portal', p.id))];
    return (g.documents[0].storage_path.startsWith(A + '/' + d + '/') && g.documents[0].role === 'payment_proof' && r.every(x => x === 'MRS_NOT_FOUND payment')) || J(r);
  });
}

/* ================================================================== 8. review, correct, void */
async function secLifecycle() {
  section('8. four-eyes review; correct = void + re-record; void; the reimbursable charge and the locks');
  const t = await mkTx();
  await check('review: draft → submit → pending; approve / reject only from pending, by a finance approver who is NOT the creator (an admin creator cannot approve either); reject needs a note', async () => {
    const d = await rec('acc', base(t.id, { review_status: 'draft' }));
    const r0 = await code(() => review('mgr', d.id, 'approve'));
    const s = await review('acc', d.id, 'submit');
    const r1 = await code(() => review('acc', d.id, 'approve'));
    const r2 = await code(() => review('mgr', d.id, 'reject'));
    const ok = await review('mgr', d.id, 'approve', 'checked');
    const r3 = await code(() => review('admin', d.id, 'reject', 'late'));
    const a = await rec('admin', base(t.id));
    const r4 = await code(() => review('admin', a.id, 'approve'));
    const ok2 = await review('mgrJ', a.id, 'approve');
    const r5 = await code(() => rec('acc', base(t.id, { review_status: 'approved' })));
    return (d.review_status === 'draft' && r0 === 'MRS_BAD_TRANSITION draft' && s.review_status === 'pending' && r1 === 'MRS_FORBIDDEN role' && r2 === 'MRS_NOTE_REQUIRED note'
      && ok.review_status === 'approved' && ok.reviewed_by === U.mgr && r3 === 'MRS_BAD_TRANSITION approved' && r4 === 'MRS_FORBIDDEN self_approval'
      && ok2.review_status === 'approved' && r5 === 'MRS_INVALID review_status' && ok.four_eyes.can_review === false) || J({ r0, r1, r2, r3, r4, r5 });
  });
  await check('get_payment.four_eyes.can_review: true for another approver on a pending entry, false for its creator', async () => {
    const p = await rec('mgr', base(t.id));
    const a = await getPay('mgr', p.id), b = await getPay('mgrJ', p.id);
    return (a.four_eyes.can_review === false && b.four_eyes.can_review === true) || J({ a: a.four_eyes, b: b.four_eyes });
  });
  let O, C;
  await check('correct_payment: one transaction voids the old entry (its G4 payment voided, its created invoice voided) and records the new one (corrects_id, pending, same reference reusable), documents carried', async () => {
    const inv = await mkDoc(), pr = await mkDoc();
    const s = sadadNo(), c = claim();
    O = await rec('acc', base(t.id, { sadad_number: s, claim_no: c, documents: [{ finance_document_id: inv, role: 'entity_invoice' }, { finance_document_id: pr, role: 'payment_proof' }] }));
    await review('mgr', O.id, 'approve');
    const r0 = await code(() => correct('acc', O.id, base(t.id, { sadad_number: s, claim_no: c, paid_amount: 90 }), 'amount was 90'));
    const res = await correct('mgr', O.id, base(t.id, { sadad_number: s, claim_no: c, paid_amount: 90, expected_amount: 90 }), 'amount was 90');
    C = res.payment;
    const oldSp = await one(`SELECT status FROM public.supplier_payments WHERE id = $1`, [O.allocations[0].supplier_payment_id]);
    const oldSi = await one(`SELECT status FROM public.supplier_invoices WHERE id = $1`, [O.allocations[0].supplier_invoice.id]);
    return (r0 === 'MRS_FORBIDDEN role' && res.voided.status === 'void' && res.voided.corrected_by.id === C.id && C.corrects.id === O.id && C.review_status === 'pending'
      && C.sadad_number === s && Number(C.paid_amount) === 90 && oldSp.status === 'void' && oldSi.status === 'void' && C.allocations[0].supplier_invoice.id !== O.allocations[0].supplier_invoice.id
      && C.documents.length === 2 && C.documents.every(d => !d.removed_at) && res.voided.documents.every(d => d.remove_reason === 'corrected')
      && J(res.changed) === J(['expected_amount', 'paid_amount', 'allocations']) && C.original_created_by === U.acc && C.created_by === U.mgr) || J({ r0, changed: res.changed, docs: C.documents.length });
  });
  await check('correct_payment: before / after finance event (ids, changed fields, no amounts); a void entry cannot be corrected again; remove_document_ids / keep_documents', async () => {
    const ev = await q(`SELECT payload, from_status, to_status FROM public.transaction_events WHERE transaction_id = $1 AND payload ->> 'op' = 'payment_corrected'`, [t.id]);
    const r = await code(() => correct('mgr', O.id, base(t.id), 'again'));
    const x = await rec('acc', base(t.id, { documents: [{ finance_document_id: await mkDoc(), role: 'extra' }, { finance_document_id: await mkDoc(), role: 'payment_proof' }] }));
    const y = await correct('acc', x.id, base(t.id, { sadad_number: x.sadad_number }), 'drop one', newKey());
    const z = await correct('acc', y.payment.id, base(t.id, { sadad_number: x.sadad_number, remove_document_ids: [y.payment.documents.find(d => d.role === 'extra').id] }), 'drop extra');
    const w = await correct('acc', z.payment.id, base(t.id, { sadad_number: x.sadad_number, keep_documents: false }), 'drop all');
    return (ev.length === 1 && ev[0].payload.before === O.id && ev[0].payload.after === C.id && ev[0].from_status === O.ref && ev[0].to_status === C.ref
      && !JSON.stringify(ev[0].payload).includes('"90') && r === 'MRS_BAD_TRANSITION void' && y.payment.documents.length === 2 && z.payment.documents.length === 1
      && z.payment.documents[0].role === 'payment_proof' && w.payment.documents.length === 0) || J({ ev, r });
  });
  await check('correct_payment of a shared entry: an entity invoice follows its allocation (transaction + invoice); a removed allocation with its invoice file → MRS_PAY_DOCUMENT allocation', async () => {
    const t2 = await mkTx(), c1 = claim(), c2 = claim(), i1 = await mkDoc(), i2 = await mkDoc();
    const S = await rec('acc', base(undefined, { pattern: 'shared', transaction_id: undefined, paid_amount: 20, allocations: [{ transaction_id: t.id, amount: 10, claim_no: c1 }, { transaction_id: t2.id, amount: 10, claim_no: c2 }],
      documents: [{ finance_document_id: i1, role: 'entity_invoice', allocation: 1 }, { finance_document_id: i2, role: 'entity_invoice', allocation: 2 }] }));
    const swapped = await correct('acc', S.id, base(undefined, { sadad_number: S.sadad_number, pattern: 'shared', transaction_id: undefined, paid_amount: 25,
      allocations: [{ transaction_id: t2.id, amount: 15, claim_no: c2 }, { transaction_id: t.id, amount: 10, claim_no: c1 }] }), 'amounts');
    const P = swapped.payment;
    const link = id => P.allocations.find(a => a.id === P.documents.find(d => d.finance_document_id === id).allocation_id).transaction_id;
    const r = await code(() => correct('acc', P.id, base(undefined, { sadad_number: S.sadad_number, pattern: 'shared', transaction_id: undefined, paid_amount: 20,
      allocations: [{ transaction_id: t.id, amount: 10, claim_no: c1 }, { transaction_id: t2.id, amount: 10, claim_no: claim() }] }), 'new invoice'));
    return (link(i1) === t.id && link(i2) === t2.id && r === 'MRS_PAY_DOCUMENT allocation') || J({ r });
  });
  await check('void_payment: finance approver only, a reason, recorded only; voids the G4 payments and frees the invoice identity (the same invoice can be recorded again)', async () => {
    const c = claim();
    const p = await rec('acc', base(t.id, { claim_no: c }));
    const r = [await code(() => voidPay('acc', p.id, 'x')), await code(() => voidPay('mgr', p.id, ' ')), await code(() => voidPay('accD', p.id, 'x'))];
    const v = await voidPay('mgr', p.id, 'duplicate entry');
    const again = await code(() => voidPay('mgr', p.id, 'again'));
    const sp = await one(`SELECT status FROM public.supplier_payments WHERE id = $1`, [p.allocations[0].supplier_payment_id]);
    const rerec = await rec('acc', base(t.id, { claim_no: c }));
    return (J(r) === J(['MRS_FORBIDDEN role', 'MRS_NOTE_REQUIRED reason', 'MRS_NOT_FOUND payment']) && v.status === 'void' && again === 'MRS_BAD_TRANSITION void'
      && sp.status === 'void' && !!rerec.allocations[0].supplier_invoice.id) || J({ r, again });
  });
  await check('charge_client (org_paid only): one DRAFT reimbursable client charge per line (VAT 0, nothing pushed to Daftra); void voids the draft charge', async () => {
    const r = await code(() => rec('acc', base(t.id, { movement_type: 'received_from_client', beneficiary_party_id: undefined, funding_source: undefined, charge_client: true })));
    const p = await rec('acc', base(t.id, { charge_client: true, paid_amount: 40, claim_no: claim() }));
    const ch = await one(`SELECT * FROM public.client_charges WHERE id = $1`, [p.allocations[0].client_charge.id]);
    await voidPay('mgr', p.id, 'not billable');
    const ch2 = await one(`SELECT status FROM public.client_charges WHERE id = $1`, [ch.id]);
    const jobs = await num(`SELECT count(*) n FROM public.billing_sync_jobs`);
    return (r === 'MRS_INVALID charge_client' && ch.kind === 'reimbursable' && ch.status === 'draft' && Number(ch.unit_price) === 40 && Number(ch.vat_rate) === 0
      && ch.transaction_id === t.id && ch2.status === 'void' && jobs === 0) || J({ r, ch, ch2 });
  });
  await check('locks: an invoiced charge (G5), a Daftra-linked entry (step 7 column) or an active custody deduction → MRS_PAY_LOCKED on void AND correct', async () => {
    const p1 = await rec('acc', base(t.id, { charge_client: true }));
    await q(`SELECT set_config('marsa.bill_invoiced', 'on', false)`);
    await q(`UPDATE public.client_charges SET status = 'invoiced' WHERE id = $1`, [p1.allocations[0].client_charge.id]);
    await q(`SELECT set_config('marsa.bill_invoiced', '', false)`);
    const inv = (await one(`SELECT status FROM public.client_charges WHERE id = $1`, [p1.allocations[0].client_charge.id])).status;
    const flag = null;
    const p2 = await rec('acc', base(t.id));
    await q(`ALTER TABLE public.client_disbursements DISABLE TRIGGER trg_guard`);
    await q(`UPDATE public.client_disbursements SET daftra_draft_id = 'D-1' WHERE id = $1`, [p2.id]);
    await q(`ALTER TABLE public.client_disbursements ENABLE TRIGGER trg_guard`);
    const p3 = await rec('acc', base(t.id, { funding_source: 'client_custody', paid_amount: 5 }));
    await custody('acc', { client_id: CLIENT_A, kind: 'deposit', amount: 5, entry_date: '2026-11-01', transaction_id: t.id });
    await custody('acc', { client_id: CLIENT_A, kind: 'deduction', amount: 5, entry_date: '2026-11-01', transaction_id: t.id, disbursement_id: p3.id });
    const r = [await code(() => voidPay('mgr', p1.id, 'x')), await code(() => correct('mgr', p1.id, base(t.id), 'x')), await code(() => voidPay('mgr', p2.id, 'x')),
      await code(() => correct('acc', p2.id, base(t.id), 'x')), await code(() => voidPay('mgr', p3.id, 'x')), await code(() => correct('acc', p3.id, base(t.id), 'x'))];
    return (inv === 'invoiced' && J(r) === J(['MRS_PAY_LOCKED invoiced', 'MRS_PAY_LOCKED invoiced', 'MRS_PAY_LOCKED daftra', 'MRS_PAY_LOCKED daftra',
      'MRS_PAY_LOCKED custody', 'MRS_PAY_LOCKED custody'])) || J({ inv, flag, r });
  });
}

/* ================================================================== 9. custody */
async function secCustody() {
  section('9. client custody: deposit / deduction / refund, never negative, the void-deposit bug, balances');
  const t = await mkTx({ client: CLIENT_A2 }), tOther = await mkTx();
  const C = CLIENT_A2;
  let dep;
  await check('deposit: amount > 0, date (not in the future, Riyadh), a branch when no transaction; balance returned; finance writers only', async () => {
    const r = [await code(() => custody('acc', { client_id: C, kind: 'deposit', amount: 0, entry_date: '2026-11-01', branch_id: JED })),
      await code(() => custody('acc', { client_id: C, kind: 'deposit', amount: 10, branch_id: JED })),
      await code(() => custody('acc', { client_id: C, kind: 'deposit', amount: 10, entry_date: '2099-01-01', branch_id: JED })),
      await code(() => custody('acc', { client_id: C, kind: 'deposit', amount: 10, entry_date: '2026-11-01' })),
      await code(() => custody('jed', { client_id: C, kind: 'deposit', amount: 10, entry_date: '2026-11-01', branch_id: JED })),
      await code(() => custody('accD', { client_id: C, kind: 'deposit', amount: 10, entry_date: '2026-11-01', branch_id: JED })),
      await code(() => custody('staffB', { client_id: C, kind: 'deposit', amount: 10, entry_date: '2026-11-01', branch_id: JED })),
      await code(() => custody('acc', { client_id: C, kind: 'loan', amount: 10, entry_date: '2026-11-01', branch_id: JED }))];
    dep = await custody('acc', { client_id: C, kind: 'deposit', amount: 500, entry_date: '2026-11-01', branch_id: JED, reference: 'DEP-1' });
    return (J(r) === J(['MRS_INVALID amount', 'MRS_REQUIRED entry_date', 'MRS_INVALID entry_date', 'MRS_REQUIRED branch_id', 'MRS_FORBIDDEN finance',
      'MRS_FORBIDDEN role', 'MRS_NOT_FOUND client', 'MRS_INVALID kind']) && Number(dep.balance) === 500 && dep.kind === 'deposit' && /^CUS-\d{6}$/.test(dep.ref) && Number(dep.signed_amount) === 500) || J({ r, dep });
  });
  let pay;
  await check('deduction: needs a transaction of the SAME client and one of its recorded payments; ≤ the payment\'s share in that transaction; one active per client + transaction + payment', async () => {
    pay = await rec('acc', base(t.id, { funding_source: 'client_custody', paid_amount: 200 }));
    const payOther = await rec('acc', base(tOther.id, { paid_amount: 50 }));
    const r = [await code(() => custody('acc', { client_id: C, kind: 'deduction', amount: 10, entry_date: '2026-11-02', branch_id: JED })),
      await code(() => custody('acc', { client_id: C, kind: 'deduction', amount: 10, entry_date: '2026-11-02', transaction_id: t.id })),
      await code(() => custody('acc', { client_id: C, kind: 'deduction', amount: 10, entry_date: '2026-11-02', transaction_id: tOther.id, disbursement_id: payOther.id })),
      await code(() => custody('acc', { client_id: C, kind: 'deduction', amount: 10, entry_date: '2026-11-02', transaction_id: t.id, disbursement_id: payOther.id })),
      await code(() => custody('acc', { client_id: C, kind: 'deduction', amount: 200.01, entry_date: '2026-11-02', transaction_id: t.id, disbursement_id: pay.id }), true),
      await code(() => custody('acc', { client_id: C, kind: 'deposit', amount: 1, entry_date: '2026-11-02', branch_id: JED, disbursement_id: pay.id }))];
    const ok = await custody('acc', { client_id: C, kind: 'deduction', amount: 200, entry_date: '2026-11-02', transaction_id: t.id, disbursement_id: pay.id });
    const dup = await code(() => custody('acc', { client_id: C, kind: 'deduction', amount: 1, entry_date: '2026-11-02', transaction_id: t.id, disbursement_id: pay.id }));
    return (J(r) === J(['MRS_CUSTODY_LINK transaction_required', 'MRS_CUSTODY_LINK payment_required', 'MRS_CUSTODY_LINK client_mismatch',
      'MRS_CUSTODY_LINK payment_not_in_transaction', 'MRS_CUSTODY_LINK exceeds_payment | 200.00', 'MRS_INVALID disbursement_id'])
      && Number(ok.balance) === 300 && ok.payment_ref === pay.ref && ok.transaction_ref === t.ref && dup === 'MRS_CUSTODY_LINK duplicate_deduction') || J({ r, dup });
  });
  await check('a deduction is capped by the shared payment\'s share of that transaction (not the payment total); a void payment cannot be deducted', async () => {
    const t2 = await mkTx({ client: C });
    const S = await rec('acc', base(undefined, { pattern: 'shared', transaction_id: undefined, paid_amount: 100, funding_source: 'client_custody',
      allocations: [{ transaction_id: t.id, amount: 30 }, { transaction_id: t2.id, amount: 70 }] }));
    const r = await code(() => custody('acc', { client_id: C, kind: 'deduction', amount: 31, entry_date: '2026-11-02', transaction_id: t.id, disbursement_id: S.id }), true);
    const ok = await custody('acc', { client_id: C, kind: 'deduction', amount: 30, entry_date: '2026-11-02', transaction_id: t.id, disbursement_id: S.id });
    const v = await rec('acc', base(t.id, { paid_amount: 5 }));
    await voidPay('mgr', v.id, 'test');
    const r2 = await code(() => custody('acc', { client_id: C, kind: 'deduction', amount: 1, entry_date: '2026-11-02', transaction_id: t.id, disbursement_id: v.id }));
    return (r === 'MRS_CUSTODY_LINK exceeds_payment | 30.00' && Number(ok.balance) === 270 && r2 === 'MRS_CUSTODY_LINK payment_void') || J({ r, r2, b: ok.balance });
  });
  await check('the balance never goes negative: a refund / deduction above the balance → MRS_CUSTODY_NEGATIVE with the balance', async () => {
    const r = await code(() => custody('acc', { client_id: C, kind: 'refund', amount: 270.01, entry_date: '2026-11-03', branch_id: JED }), true);
    const ok = await custody('acc', { client_id: C, kind: 'refund', amount: 20, entry_date: '2026-11-03', branch_id: JED });
    return (r === 'MRS_CUSTODY_NEGATIVE refund | 270.00' && Number(ok.balance) === 250) || J({ r, b: ok.balance });
  });
  await check('LEGACY BUG FIXED: voiding the deposit that funds the deductions (balance 250, deposit 500) → MRS_CUSTODY_NEGATIVE; the deposit stays active', async () => {
    const r = await code(() => voidCustody('mgr', dep.id, 'entered by mistake'), true);
    const st = (await one(`SELECT status FROM public.client_custody_entries WHERE id = $1`, [dep.id])).status;
    return (r === 'MRS_CUSTODY_NEGATIVE void_deposit | 250.00' && st === 'active' && await balance(C) === 250) || J({ r, st });
  });
  await check('the trigger backs it: an owner UPDATE voiding that deposit directly also fails (trg_custody_balance), as does an owner insert of an overdraft', async () => {
    const r1 = await code(() => q(`UPDATE public.client_custody_entries SET status = 'void', void_reason = 'direct', voided_at = now(), voided_by = $2 WHERE id = $1`, [dep.id, U.admin]));
    const r2 = await code(() => q(`INSERT INTO public.client_custody_entries (org_id, branch_id, client_id, ref, kind, amount, entry_date, created_by)
                                   VALUES ($1, $2, $3, 'CUS-999990', 'refund', 1000, current_date, $4)`, [A, JED, C, U.acc]));
    return (/^MRS_CUSTODY_NEGATIVE/.test(r1) && /^MRS_CUSTODY_NEGATIVE/.test(r2)) || J({ r1, r2 });
  });
  await check('void: a reason of ≥ 3 characters; finance approver; a voided deduction / refund gives the money back; once void stays void; then the deposit void is possible when it no longer goes negative', async () => {
    const ded = (await q(`SELECT id FROM public.client_custody_entries WHERE client_id = $1 AND kind = 'deduction' AND status = 'active' ORDER BY amount DESC LIMIT 1`, [C]))[0].id;
    const r = [await code(() => voidCustody('mgr', ded, 'ab')), await code(() => voidCustody('acc', ded, 'abc')), await code(() => voidCustody('accD', ded, 'abc'))];
    const v = await voidCustody('mgr', ded, 'abc');
    const again = await code(() => voidCustody('mgr', ded, 'again'));
    const dep2 = await custody('acc', { client_id: C, kind: 'deposit', amount: 1000, entry_date: '2026-11-04', branch_id: JED });
    const vd = await voidCustody('mgr', dep.id, 'merged into the next deposit');
    return (J(r) === J(['MRS_NOTE_REQUIRED reason', 'MRS_FORBIDDEN role', 'MRS_NOT_FOUND custody_entry']) && Number(v.balance) === 450 && again === 'MRS_BAD_TRANSITION void'
      && Number(dep2.balance) === 1450 && Number(vd.balance) === 950 && vd.status === 'void' && vd.void_reason === 'merged into the next deposit') || J({ r, v: v.balance, again });
  });
  await check('balances: custody_balances (org-wide per client, totals), client_custody_balance (the client page), the security-invoker view (the caller\'s branches), tx_disbursements custody_balance', async () => {
    const all = await rpc('acc', `SELECT public.custody_balances($1, $2) r`, [A, {}]);
    const nz = await rpc('accD', `SELECT public.custody_balances($1, $2) r`, [A, { nonzero: true, q: 'عميل ثان' }]);
    const one1 = await rpc('acc', `SELECT public.client_custody_balance($1) r`, [C]);
    const view = await as('accJ', `SELECT * FROM public.client_custody_balances WHERE client_id = $1`, [C]);
    const viewD = await as('accD', `SELECT * FROM public.client_custody_balances WHERE client_id = $1`, [C]);
    const tx = await txPay('acc', t.id);
    const r = [await code(() => rpc('jed', `SELECT public.client_custody_balance($1) r`, [C])), await code(() => rpc('staffB', `SELECT public.client_custody_balance($1) r`, [C])),
      await code(() => rpc('portal', `SELECT public.custody_balances($1, $2) r`, [A, {}]))];
    const row = all.rows.find(x => x.client_id === C);
    return (Number(row.balance) === 950 && Number(row.total_deposits) === 1000 && Number(one1.balance) === 950 && nz.rows.length === 1 && Number(view[0].balance) === 950
      && viewD.length === 0 && Number(tx.custody_balance) === 950 && J(r) === J(['MRS_FORBIDDEN finance', 'MRS_NOT_FOUND client', 'MRS_FORBIDDEN org'])) || J({ row, one1, nz: nz.rows.length, r });
  });
  await check('list_custody_entries: filters (client, kind, status, transaction, dates, search), branch-scoped rows', async () => {
    const all = await rpc('acc', `SELECT public.list_custody_entries($1, $2) r`, [A, { client_id: C }]);
    const ded = await rpc('acc', `SELECT public.list_custody_entries($1, $2) r`, [A, { client_id: C, kind: 'deduction', status: 'active' }]);
    const qq = await rpc('acc', `SELECT public.list_custody_entries($1, $2) r`, [A, { q: 'DEP-1' }]);
    const dmm = await rpc('accD', `SELECT public.list_custody_entries($1, $2) r`, [A, { client_id: C }]);
    return (all.total >= 5 && ded.rows.every(x => x.kind === 'deduction' && x.status === 'active') && qq.total === 1 && dmm.total === 0) || J({ all: all.total, ded: ded.total, qq: qq.total, dmm: dmm.total });
  });
  await check('idempotent custody save (same key → the same entry, replayed)', async () => {
    const k = newKey(), p = { client_id: C, kind: 'deposit', amount: 1, entry_date: '2026-11-05', branch_id: JED };
    const a = await custody('acc', p, k), b = await custody('acc', p, k);
    return (a.id === b.id && b.replayed === true) || J({ a: a.id, b: b.id });
  });
}

/* ================================================================== 10. matching */
async function secMatch() {
  section('10. match_payment_transaction: auto-suggested only when unique');
  const blA = 'MEDU' + (700000 + (++refSeq));
  const t1 = await mkTx({ bl: blA }), t2 = await mkTx({ bl: 'OTHR' + refSeq });
  const ctr = 'CSQU3054383';
  await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, t2.id, ctr]);
  await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, t1.id, ctr]);
  await check('a B/L of one transaction → unique; a container on two transactions → two candidates, no unique; B/L + container → both listed, the B/L one scores higher but nothing unique', async () => {
    const a = await rpc('acc', `SELECT public.match_payment_transaction($1, $2) r`, [A, { bl_number: blA.toLowerCase() }]);
    const b = await rpc('acc', `SELECT public.match_payment_transaction($1, $2) r`, [A, { container_numbers: ['csqu 3054383'] }]);
    const c = await rpc('acc', `SELECT public.match_payment_transaction($1, $2) r`, [A, { bl_number: blA, container_numbers: [ctr] }]);
    const n = await rpc('acc', `SELECT public.match_payment_transaction($1, $2) r`, [A, {}]);
    return (a.unique_transaction_id === t1.id && a.candidates.length === 1 && J(a.candidates[0].matched_by) === J(['bl_number']) && b.unique_transaction_id === null
      && b.candidates.length === 2 && c.unique_transaction_id === null && c.candidates[0].transaction_id === t1.id && c.candidates[0].score === 2 && n.candidates.length === 0) || J({ a, b: b.candidates.length, c: c.candidates });
  });
  await check('appointment no (TAS, booking ref) and declaration no; branch-scoped (a DMM accountant does not see JED transactions); non-finance refused', async () => {
    const tas = 'TAS' + (20261115000000 + (++refSeq));
    await q(`INSERT INTO public.port_appointments (org_id, transaction_id, appointment_at, appointment_no) VALUES ($1, $2, now(), $3)`, [A, t2.id, tas]);
    const a = await rpc('acc', `SELECT public.match_payment_transaction($1, $2) r`, [A, { appointment_no: tas.slice(3) + 'TAS' }]);
    const d = await rpc('accD', `SELECT public.match_payment_transaction($1, $2) r`, [A, { appointment_no: tas }]);
    const r = await code(() => rpc('jed', `SELECT public.match_payment_transaction($1, $2) r`, [A, { appointment_no: tas }]));
    return (a.unique_transaction_id === t2.id && d.candidates.length === 0 && r === 'MRS_FORBIDDEN finance') || J({ a, d: d.candidates.length, r });
  });
}

/* ================================================================== 11. RLS, privileges, conversion, audit */
async function secRls() {
  section('11. RLS incl. the finance roles and branch scoping, function privileges, conversion lists, audit');
  const T = ['client_disbursements', 'disbursement_allocations', 'payment_documents', 'client_custody_entries'];
  // a DMM entry and a DMM custody entry by the DMM accountant (branch scoping)
  const tD = await mkTx({ branch: DMM });
  await rec('accD', base(tD.id, { claim_no: claim(), documents: [{ finance_document_id: await mkDoc({ branch: DMM, by: 'accD' }), role: 'payment_proof' }] }));
  await custody('accD', { client_id: CLIENT_A, kind: 'deposit', amount: 3, entry_date: '2026-11-01', branch_id: DMM });
  await check('RLS enabled on the 4 tables; SELECT for authenticated only (the view too); nothing for anon', async () => {
    const r = await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY ($1) AND relnamespace = 'public'::regnamespace`, [T]);
    const g = await q(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public'
                        AND table_name = ANY ($1) AND grantee IN ('anon','authenticated')`, [T.concat(['client_custody_balances'])]);
    const an = await code(() => as('anon', `SELECT 1 FROM public.client_disbursements`));
    return (r.length === 4 && r.every(x => x.relrowsecurity) && g.length === 5 && g.every(x => x.grantee === 'authenticated' && x.privilege_type === 'SELECT') && an === 'perm') || J({ r, g, an });
  });
  await check('SELECT: finance readers of the branch see the rows (org-wide accountant / supervisor / admin all, JED accountant only JED, DMM accountant only DMM); non-finance staff, the client portal, another org, a stranger see nothing', async () => {
    const cnt = async (who, t) => Number((await as(who, `SELECT count(*) n FROM public.${t} WHERE org_id = $1`, [A]))[0].n);
    const all = await num(`SELECT count(*) n FROM public.client_disbursements WHERE org_id = $1`, [A]);
    const jed = await num(`SELECT count(*) n FROM public.client_disbursements WHERE org_id = $1 AND branch_id = $2`, [A, JED]);
    const dmm = await num(`SELECT count(*) n FROM public.client_disbursements WHERE org_id = $1 AND branch_id = $2`, [A, DMM]);
    const res = { acc: await cnt('acc', 'client_disbursements'), sup: await cnt('sup', 'client_disbursements'), admin: await cnt('admin', 'client_disbursements'),
      accJ: await cnt('accJ', 'client_disbursements'), accD: await cnt('accD', 'client_disbursements'), jed: await cnt('jed', 'client_disbursements'),
      portal: await cnt('portal', 'client_disbursements'), staffB: await cnt('staffB', 'client_disbursements'), stranger: await cnt('stranger', 'client_disbursements'),
      allocJed: await cnt('jed', 'disbursement_allocations'), docsPortal: await cnt('portal', 'payment_documents'), custJed: await cnt('jed', 'client_custody_entries'),
      custAccD: await cnt('accD', 'client_custody_entries'), custAcc: await cnt('acc', 'client_custody_entries'), allocAccJ: await cnt('accJ', 'disbursement_allocations') };
    const allocJ = await num(`SELECT count(*) n FROM public.disbursement_allocations a JOIN public.client_disbursements d ON d.id = a.disbursement_id WHERE d.branch_id = $1`, [JED]);
    return (res.acc === all && res.sup === all && res.admin === all && res.accJ === jed && res.accD === dmm && dmm > 0 && jed > dmm && res.jed === 0 && res.portal === 0
      && res.staffB === 0 && res.stranger === 0 && res.allocJed === 0 && res.docsPortal === 0 && res.custJed === 0 && res.custAccD === 1 && res.custAcc > 1
      && res.allocAccJ === allocJ) || J(Object.assign(res, { all, jedRows: jed, dmmRows: dmm }));
  });
  await check('org B sees only its own rows; B\'s RPCs cannot read A\'s entries / transactions / clients', async () => {
    const a = (await q(`SELECT id FROM public.client_disbursements WHERE org_id = $1 LIMIT 1`, [A]))[0].id;
    const atx = (await q(`SELECT transaction_id t FROM public.disbursement_allocations WHERE org_id = $1 LIMIT 1`, [A]))[0].t;
    const r = [await code(() => getPay('staffB', a)), await code(() => rpc('staffB', `SELECT public.list_payments($1, $2) r`, [A, {}])),
      await code(() => rpc('staffB', `SELECT public.tx_disbursements($1) r`, [atx])),
      await code(() => rpc('staffB', `SELECT public.custody_balances($1, $2) r`, [A, {}]))];
    const own = Number((await as('staffB', `SELECT count(*) n FROM public.client_disbursements`))[0].n);
    return (J(r) === J(['MRS_NOT_FOUND payment', 'MRS_FORBIDDEN org', 'MRS_NOT_FOUND transaction', 'MRS_FORBIDDEN org']) && own >= 1) || J({ r, own });
  });
  await check('function privileges: the 16 RPCs executable by authenticated only; internal helpers / triggers by nobody (the RLS helper by authenticated)', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('anon', p.oid, 'EXECUTE') an,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') sr
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1)`, [RPCS]);
    const helpers = NEW_FNS.filter(f => f.startsWith('app.') && f !== 'app.pay_can_read').map(f => f.slice(4));
    const h = await q(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = ANY ($1)
                         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))`, [helpers]);
    const c = await one(`SELECT has_function_privilege('authenticated', 'app.pay_can_read(uuid)', 'EXECUTE') a, has_function_privilege('anon', 'app.pay_can_read(uuid)', 'EXECUTE') b,
                                has_function_privilege('authenticated', 'app.tg_payment_totals()', 'EXECUTE') t`);
    return (r.length === RPCS.length && r.every(x => x.au && !x.an && !x.sr) && h.length === 0 && c.a === true && c.b === false && c.t === false) || J({ r, h, c });
  });
  await check('conversion lists: the 4 tables in app.convert_delete_tables (78), their no-delete guards in app.convert_delete_guards (39), every table classified', async () => {
    const t = (await one(`SELECT app.convert_delete_tables() t`)).t;
    const g = (await one(`SELECT app.convert_delete_guards() g`)).g;
    const keep = (await one(`SELECT app.convert_keep_tables() k`)).k;
    const all = (await q(`SELECT 'public.' || relname n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`)).map(x => x.n);
    const un = all.filter(x => !t.includes(x) && !keep.includes(x) && !['public.status_labels', 'public.schema_versions', 'public.organizations',
      'public.profiles', 'public.platform_admins', 'public.plans', 'public.customs_ports', 'public.daftra_mock_accounts'].includes(x));
    return (T.every(x => t.includes('public.' + x) && g.includes('public.' + x + ':trg_no_delete')) && g.length === 39 && t.length === 78 && un.length === 0) || J({ g: g.length, t: t.length, un });
  });
  await check('the trail: the 4 tables are audited (insert / update)', async () => {
    const r = await q(`SELECT DISTINCT table_name FROM public.audit_log WHERE table_name = ANY ($1)`, [T]);
    return r.length === 4 || J(r);
  });
}

/* ================================================================== 12. front end (static) */
async function secStatic() {
  section('12. supa.js wrappers, i18n');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  await check('supa.js: one exported wrapper per RPC, calling it by name; the writes through the idempotent path', () => {
    const W = { recordPaymentBundle: 'record_payment_bundle', correctPayment: 'correct_payment', voidPayment: 'void_payment', reviewPayment: 'review_payment',
      addPaymentDocuments: 'add_payment_documents', removePaymentDocument: 'remove_payment_document', getPayment: 'get_payment', listPayments: 'list_payments',
      txDisbursements: 'tx_disbursements', checkPaymentDuplicates: 'check_payment_duplicates', matchPaymentTransaction: 'match_payment_transaction',
      saveCustodyEntry: 'save_custody_entry', voidCustodyEntry: 'void_custody_entry', listCustodyEntries: 'list_custody_entries', custodyBalances: 'custody_balances',
      clientCustodyBalance: 'client_custody_balance' };
    const miss = Object.keys(W).filter(f => !new RegExp('function ' + f + '\\(').test(supa) || !new RegExp(f + ': ' + f + '[,\\n]').test(supa) || !supa.includes("'" + W[f] + "'"));
    const idem = ['record_payment_bundle', 'correct_payment', 'add_payment_documents', 'save_custody_entry'].filter(n => !new RegExp("idemRpc\\('" + n + "'").test(supa));
    return (miss.length === 0 && Object.values(W).sort().join() === RPCS.join() && idem.length === 0) || 'missing: ' + miss.join(', ') + ' idem: ' + idem.join(', ');
  });
  await check('supa.js: aiExtract knows the payment doc types (ai-doc-v3, 4 MB) and MRS_PAY_FUNDING has a message per matrix rule', () =>
    (/'payment_proof'/.test(supa) && /'appointment_invoice'/.test(supa) && /AI_MAX_PAY_BYTES\s*=\s*4 \* 1024 \* 1024/.test(supa)
      && ['fasah_wallet_source', 'fasah_wallet_method', 'cash_box_method', 'dry_port_wallet_source', 'dry_port_wallet_method', 'payer_name', 'paying_account', 'wallet_no_account']
        .every(r => supa.includes("'MRS_PAY_FUNDING:" + r + "'"))) || 'supa.js');
}

/* ================================================================== 13. review fixes (regressions) */
async function secReviewFixes() {
  section('13. review fixes: four eyes across corrections, evidence after approval, branch-scoped duplicates, identity, corrections');
  const t = await mkTx(), tD = await mkTx({ branch: DMM });
  await check('four eyes across corrections: the original creator cannot approve a corrected copy (even an unchanged one); nor can an earlier corrector in the chain; can_review false', async () => {
    const s = sadadNo();
    const E1 = await rec('mgr', base(t.id, { sadad_number: s }));
    const E2 = (await correct('acc', E1.id, base(t.id, { sadad_number: s, notes: 'typo' }), 'note only')).payment;
    const g = await getPay('mgr', E2.id);
    const r1 = await code(() => review('mgr', E2.id, 'approve'));
    const r1b = await code(() => review('mgr', E2.id, 'reject', 'not mine'));
    const ok = await review('mgrJ', E2.id, 'approve');
    const s2 = sadadNo();
    const X1 = await rec('mgrJ', base(t.id, { sadad_number: s2 }));
    const X2 = (await correct('mgr', X1.id, base(t.id, { sadad_number: s2, paid_amount: 101, expected_amount: 101 }), 'amount')).payment;
    const X3 = (await correct('acc', X2.id, base(t.id, { sadad_number: s2, paid_amount: 101, expected_amount: 101, notes: 'x' }), 'note')).payment;
    const r2 = await code(() => review('mgr', X3.id, 'approve'));
    const r3 = await code(() => review('mgrJ', X3.id, 'approve'));
    const ok2 = await review('admin', X3.id, 'approve');
    return (E2.created_by === U.acc && E2.original_created_by === U.mgr && g.four_eyes.can_review === false && r1 === 'MRS_FORBIDDEN self_approval'
      && r1b === 'MRS_FORBIDDEN self_approval' && ok.review_status === 'approved' && r2 === 'MRS_FORBIDDEN self_approval' && r3 === 'MRS_FORBIDDEN self_approval'
      && ok2.review_status === 'approved') || J({ r1, r1b, r2, r3, fe: g.four_eyes });
  });
  await check('evidence after approval: add / remove documents on an approved entry → MRS_BAD_TRANSITION approved_documents (the review stays what was approved)', async () => {
    const pr = await mkDoc();
    const W = await rec('acc', base(t.id, { funding_source: 'fasah_wallet', method: 'fasah_wallet', paying_account: undefined, sadad_number: undefined,
      documents: [{ finance_document_id: pr, role: 'payment_proof' }] }));
    await review('mgr', W.id, 'approve');
    const r1 = await code(() => rpc('acc', `SELECT public.remove_payment_document($1, $2) r`, [W.documents[0].id, 'replace it']));
    const nd = await mkDoc();
    const r2 = await code(() => rpc('acc', `SELECT public.add_payment_documents($1, $2) r`, [W.id, [{ finance_document_id: nd, role: 'payment_proof' }]]));
    const r3 = await code(() => rpc('admin', `SELECT public.remove_payment_document($1, $2) r`, [W.documents[0].id, 'replace it']));
    const g = await getPay('acc', W.id);
    return (r1 === 'MRS_BAD_TRANSITION approved_documents' && r2 === 'MRS_BAD_TRANSITION approved_documents' && r3 === r1 && g.review_status === 'approved'
      && g.documents.filter(d => !d.removed_at).length === 1) || J({ r1, r2, r3 });
  });
  await check('the save rules stay true on removal: the last proof of a wallet payment without a reference / of a client-direct payment with an invoice cannot be removed; after adding a replacement it can', async () => {
    const p1 = await mkDoc(), p2 = await mkDoc(), p3 = await mkDoc();
    const W = await rec('acc', base(t.id, { funding_source: 'fasah_wallet', method: 'fasah_wallet', paying_account: undefined, sadad_number: undefined,
      documents: [{ finance_document_id: p1, role: 'payment_proof' }] }));
    const r1 = await code(() => rpc('acc', `SELECT public.remove_payment_document($1, $2) r`, [W.documents[0].id, 'wrong']));
    await rpc('acc', `SELECT public.add_payment_documents($1, $2) r`, [W.id, [{ finance_document_id: p2, role: 'payment_proof' }]]);
    const ok = await rpc('acc', `SELECT public.remove_payment_document($1, $2) r`, [W.documents[0].id, 'wrong']);
    const C = await rec('acc', base(t.id, { movement_type: 'client_direct', funding_source: undefined, claim_no: claim(), documents: [{ finance_document_id: p3, role: 'payment_proof' }] }));
    const r2 = await code(() => rpc('acc', `SELECT public.remove_payment_document($1, $2) r`, [C.documents[0].id, 'wrong']));
    return (r1 === 'MRS_REQUIRED payment_reference' && ok.documents.filter(d => !d.removed_at).length === 1 && r2 === 'MRS_REQUIRED payment_proof') || J({ r1, r2 });
  });
  await check('branch scoping of duplicates: a DMM-only accountant learns only «taken» about a JED entry (no ref, transaction, amount, date, issuer) — in check_payment_duplicates and in the save errors; JED sees the details', async () => {
    const s = sadadNo(), c = claim();
    const J1 = await rec('accJ', base(t.id, { sadad_number: s, claim_no: c, paid_amount: 4321, expected_amount: 4321 }));
    const d = await rpc('accD', `SELECT public.check_payment_duplicates($1, $2) r`, [A, { sadad_number: s, beneficiary_party_id: SUP, claims: [{ claim_no: c }] }]);
    const dj = await rpc('accJ', `SELECT public.check_payment_duplicates($1, $2) r`, [A, { sadad_number: s, beneficiary_party_id: SUP, claims: [{ claim_no: c }] }]);
    const r1 = await code(() => rec('accD', base(tD.id, { sadad_number: s })), true);
    const r2 = await code(() => rec('accD', base(tD.id, { claim_no: c })), true);
    const r3 = await code(() => rec('accD', base(tD.id, { claim_no: c, beneficiary_party_id: SUP2 })), true);
    const r1j = await code(() => rec('accJ', base(t.id, { sadad_number: s })), true);
    const ref = d.references[0] || {}, inv = d.invoices[0] || {};
    const txt = JSON.stringify(d);
    return (ref.hidden === true && ref.ref === null && ref.amount === null && ref.transaction_ref === null && ref.paid_at === null && ref.id === null
      && inv.kind === 'taken' && inv.hidden === true && inv.ref === null && inv.id === null && !txt.includes(J1.ref) && !txt.includes('4321') && !txt.includes(t.ref)
      && dj.references[0].ref === J1.ref && dj.invoices[0].ref === J1.ref
      && r1 === 'MRS_PAY_REF_TAKEN sadad_number' && r2 === 'MRS_PAY_INVOICE_TAKEN invoice_number' && r3 === 'MRS_CONFIRM_INVOICE_REUSE invoice_number | ' + c + ' · -'
      && r1j.startsWith('MRS_PAY_REF_TAKEN sadad_number | ' + J1.ref + ' · ' + t.ref + ' · 4321.00 SAR')) || J({ d, r1, r2, r3, r1j });
  });
  await check('a correction moved to another branch does not carry the old branch\'s files (MRS_PAY_DOCUMENT branch | name); un-ticked (remove_document_ids) it saves without them', async () => {
    const pr = await mkDoc({ name: 'jed-proof.pdf' });
    const s = sadadNo();
    const O = await rec('acc', base(t.id, { sadad_number: s, documents: [{ finance_document_id: pr, role: 'payment_proof' }] }));
    const r = await code(() => correct('acc', O.id, base(tD.id, { sadad_number: s }), 'wrong branch'), true);
    const ok = await correct('acc', O.id, base(tD.id, { sadad_number: s, remove_document_ids: [O.documents[0].id] }), 'wrong branch');
    return (r === 'MRS_PAY_DOCUMENT branch | jed-proof.pdf' && ok.payment.branch_id === DMM && ok.payment.documents.length === 0) || J({ r });
  });
  await check('a correction keeps the created invoice\'s date and VAT when the form leaves them out (get_payment exposes them); an explicit VAT is used', async () => {
    const c = claim(), s = sadadNo();
    const O = await rec('acc', base(t.id, { sadad_number: s, claim_no: c, invoice_date: '2026-10-15', invoice_vat_amount: 13.04, invoice_total: 100 }));
    const C1 = (await correct('acc', O.id, base(t.id, { sadad_number: s, claim_no: c, notes: 'typo' }), 'note')).payment;
    const si1 = await one(`SELECT invoice_date::text d, vat_amount v, status FROM public.supplier_invoices WHERE id = $1`, [C1.allocations[0].supplier_invoice.id]);
    const C2 = (await correct('acc', C1.id, base(t.id, { sadad_number: s, claim_no: c, invoice_vat_amount: 0 }), 'no vat')).payment;
    const si2 = await one(`SELECT invoice_date::text d, vat_amount v FROM public.supplier_invoices WHERE id = $1`, [C2.allocations[0].supplier_invoice.id]);
    const x = O.allocations[0].supplier_invoice;
    return (x.invoice_date === '2026-10-15' && Number(x.vat_amount) === 13.04 && si1.d === '2026-10-15' && Number(si1.v) === 13.04 && si1.status !== 'void'
      && si2.d === '2026-10-15' && Number(si2.v) === 0) || J({ x, si1, si2 });
  });
  await check('invoice identity ignores separators like the legacy (INV-12/345 = INV 12.345 = INV12345): same issuer → MRS_PAY_INVOICE_TAKEN, another issuer → confirm; a G4 invoice written with separators is reused', async () => {
    const n = 7000 + (++refSeq);
    await rec('acc', base(t.id, { claim_no: 'SEP-' + n + '/45' }));
    const r1 = await code(() => rec('acc', base(t.id, { claim_no: 'SEP' + n + '45' })));
    const r2 = await code(() => rec('acc', base(t.id, { claim_no: 'sep ' + n + '.45' })));
    const r3 = await code(() => rec('acc', base(t.id, { claim_no: 'SEP_' + n + '45', beneficiary_party_id: SUP2 })));
    const g = (await rpc('acc', `SELECT public.create_supplier_invoice($1) r`, [{ branch_id: JED, supplier_id: SUP, invoice_number: 'G4-' + n + '/7', invoice_date: '2026-10-30', total_amount: 300 }])).id;
    const P = await rec('acc', base(t.id, { claim_no: 'G4' + n + '7' }));
    const keys = await one(`SELECT app.pay_inv_key('INV-123/456') a, app.pay_inv_key('INV 123456') b, app.pay_inv_key('inv.0123456') c, app.pay_inv_key('١٢ ٣٤') d`);
    return (r1 === 'MRS_PAY_INVOICE_TAKEN invoice_number' && r2 === r1 && r3 === 'MRS_CONFIRM_INVOICE_REUSE invoice_number' && P.allocations[0].supplier_invoice.id === g
      && keys.a === 'INV123456' && keys.b === keys.a && keys.c === keys.a && keys.d === '1234') || J({ r1, r2, r3, keys });
  });
  await check('MRS_CONFIRM_INVOICE_REUSE lists every reused number of a shared entry (one confirmation covers what was shown)', async () => {
    const t2 = await mkTx(), c1 = claim(), c2 = claim();
    await rec('acc', base(t.id, { claim_no: c1, beneficiary_party_id: SUP2 }));
    await rec('acc', base(t.id, { claim_no: c2, beneficiary_party_id: SUP2 }));
    const r = await code(() => rec('acc', base(undefined, { pattern: 'shared', transaction_id: undefined, paid_amount: 20,
      allocations: [{ transaction_id: t.id, amount: 10, claim_no: c1 }, { transaction_id: t2.id, amount: 10, claim_no: c2 }] })), true);
    return r === 'MRS_CONFIRM_INVOICE_REUSE invoice_number | ' + c1 + ' · جهة أخرى تجريبية؛ ' + c2 + ' · جهة أخرى تجريبية' || r;
  });
  await check('an appointment fee never takes an FP… number as its claim / Reference No (MRS_INVALID claim_no_fp); other services may', async () => {
    const r1 = await code(() => rec('acc', base(t.id, { service_code: 'gate_out_appointment', claim_no: 'FP00012345' })));
    const r2 = await code(() => rec('acc', base(t.id, { service_code: 'gate_in_appointment', claim_no: 'fp-77' + refSeq })));
    const t3 = await mkTx();
    const r3 = await code(() => rec('acc', base(undefined, { service_code: 'gate_out_appointment', pattern: 'shared', transaction_id: undefined, paid_amount: 20,
      allocations: [{ transaction_id: t.id, amount: 10, claim_no: claim() }, { transaction_id: t3.id, amount: 10, claim_no: 'FP9' + refSeq }] })));
    const ok = await rec('acc', base(t.id, { service_code: 'gate_out_appointment', claim_no: claim(), internal_invoice_no: 'FP55' + refSeq }));
    const ok2 = await rec('acc', base(t.id, { claim_no: 'FP66' + refSeq }));
    return (r1 === 'MRS_INVALID claim_no_fp' && r2 === r1 && r3 === r1 && !!ok.id && !!ok2.id) || J({ r1, r2, r3 });
  });
  await check('the internal no: a reused G4 invoice with another internal no → MRS_INVALID internal_invoice_mismatch | its no; the internal no of a line without an invoice is unique too', async () => {
    const gno = 'G5-' + (++refSeq);
    const g = (await rpc('acc', `SELECT public.create_supplier_invoice($1) r`, [{ branch_id: JED, supplier_id: SUP, invoice_number: gno, invoice_date: '2026-10-30', total_amount: 300 }])).id;
    await q(`UPDATE public.supplier_invoices SET internal_invoice_no = $2 WHERE id = $1`, [g, 'FP111' + refSeq]);
    const fpOld = 'FP111' + refSeq, fpNew = 'FP222' + refSeq;
    const r1 = await code(() => rec('acc', base(t.id, { claim_no: gno, internal_invoice_no: fpNew })), true);
    const okSame = await rec('acc', base(t.id, { claim_no: gno, internal_invoice_no: fpOld.toLowerCase() }));
    const fp3 = 'FP333' + refSeq;
    const a = await rec('acc', base(t.id, { internal_invoice_no: fp3 }));
    const r2 = await code(() => rec('acc', base(t.id, { claim_no: claim(), internal_invoice_no: fp3 })));
    const r3 = await code(() => rec('acc', base(t.id, { internal_invoice_no: 'fp-' + fp3.slice(2) })));
    return (r1 === 'MRS_INVALID internal_invoice_mismatch | ' + fpOld && okSame.allocations[0].supplier_invoice.id === g && !!a.id
      && r2 === 'MRS_PAY_INVOICE_TAKEN internal_invoice_no' && r3 === r2) || J({ r1, r2, r3 });
  });
  await check('check_payment_duplicates in a correction (exclude_id) does not report the entry\'s own internal no; another entry still does', async () => {
    const c = claim(), fp = 'FP88' + (++refSeq);
    const E = await rec('acc', base(t.id, { claim_no: c, internal_invoice_no: fp }));
    const r = await rpc('acc', `SELECT public.check_payment_duplicates($1, $2) r`, [A, { exclude_id: E.id, beneficiary_party_id: SUP, claims: [{ claim_no: c, internal_invoice_no: fp }] }]);
    const r2 = await rpc('acc', `SELECT public.check_payment_duplicates($1, $2) r`, [A, { beneficiary_party_id: SUP, claims: [{ claim_no: claim(), internal_invoice_no: fp }] }]);
    return (r.invoices.length === 0 && r2.invoices.length === 1 && r2.invoices[0].kind === 'internal_taken') || J({ r, r2 });
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
  svcItem = (await one(`SELECT id FROM public.org_service_items WHERE org_id = $1 AND code = 'port_charges'`, [A])).id;
  pass('database ready');
  await secMatrix();
  await secBooking();
  await secDuplicates();
  await secShared();
  await secDocs();
  await secLifecycle();
  await secCustody();
  await secMatch();
  await secRls();
  await secStatic();
  await secReviewFixes();
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
}
main().catch(e => { console.error(e); process.exit(1); });
