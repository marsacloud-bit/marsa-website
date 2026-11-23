#!/usr/bin/env node
/*
  Marsa (مرسى) — «عدد الحاويات» of a transaction made / filled from a doc batch: migration 20261130000100_tx_container_count.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).
  Invented data only (fixtures of tx-draft-sql-tests).

  Covers: file conventions + all_migrations.sql; a draft from the matching report (create_draft_transaction) gets
  container_count = its containers (1 and 3); approve_doc_batch into a NEW transaction and into an EXISTING one (raised to
  the containers when lower, never lowered: a larger count entered by staff stays); Ro-Ro stays 0; the backfill of drafts
  made before the file (and only transactions with an approved batch); re-run on itself (no-op, identical catalog); the
  trigger function is not callable by API roles.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/tx-container-count-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261130000100_tx_container_count.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in tx-container-count-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'd7a00000-0000-4000-8000-0000000000b0';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const TX_JED = '0b5e0000-0000-4000-8000-000000000201';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const CLIENT_A2 = '0b5e0000-0000-4000-8000-000000000102';
const BR_B = 'd7a00000-0000-4000-8000-0000000000b1';
const CL_B = 'd7a00000-0000-4000-8000-0000000000b3';
const U = {
  admin: 'd7a10000-0000-4000-8000-000000000001',
  acc: 'd7a10000-0000-4000-8000-000000000002',      // accountant (staff, not an ops writer)
  jed: 'd7a10000-0000-4000-8000-000000000005',      // clearance_staff, JED
  dmm: 'd7a10000-0000-4000-8000-000000000006',      // clearance_staff, DMM
  portal: 'd7a10000-0000-4000-8000-000000000008',   // client user of CLIENT_A
  staffB: 'd7a10000-0000-4000-8000-00000000000a'    // admin of B
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
  for (const f of migFiles().filter(f => (!upTo || f < upTo) && f !== '20261129000100_mfa_off.sql')) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  return d;
}
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
let keySeq = 0;
const newKey = () => 'd7a2aaab-0000-4000-8000-' + String(++keySeq).padStart(12, '0');
let shaSeq = 0;
const sha = () => (++shaSeq).toString(16).padStart(64, 'd');
// ISO 6346 check digit
function iso(prefix4, six) {
  const v = prefix4 + six;
  const L = [10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38];
  let s = 0;
  for (let i = 0; i < 10; i++) { const c = v[i]; const n = /[0-9]/.test(c) ? +c : L[c.charCodeAt(0) - 65]; s += n * (1 << i); }
  return v + String((s % 11) % 10);
}
let ctrSeq = 0, blSeq = 0;
const nextCtr = () => iso('TDRU', String(300000 + (++ctrSeq)));
const nextBl = () => 'TDBL' + String(7000000 + (++blSeq));

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
  const colGrants = (await q(`SELECT table_name || '.' || column_name || ':' || grantee || ':' || privilege_type x FROM information_schema.column_privileges
                               WHERE table_schema = 'public' AND table_name = 'transactions' AND grantee IN ('anon','authenticated') ORDER BY 1`)).map(x => x.x);
  const labels = (await q(`SELECT domain || '.' || code || ':' || sort || ':' || label_ar || ':' || client_visible x FROM public.status_labels ORDER BY 1`)).map(x => x.x);
  return { fns, tables, idx, trg, pol, con, cols, colGrants, labels };
}
const NEW_FNS = ['app.tg_transactions_draft_guard', 'app.tx_approval_json', 'public.approve_transaction', 'public.create_draft_transaction',
  'public.get_transaction_approval'];
const RECREATED = ['app.tg_transactions_created'];
const NEW_COLS = ['transactions.approval_match_id', 'transactions.approval_note', 'transactions.approved_at', 'transactions.approved_by', 'transactions.is_draft'];
const RPCS = ['create_draft_transaction', 'approve_transaction', 'get_transaction_approval'];
const CODES = ['MRS_TX_NOT_DRAFT', 'MRS_TX_MATCH_MISMATCH'];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@txdraft.example.com', now()), ('${U.acc}', 'acc@txdraft.example.com', now()),
    ('${U.jed}', 'jed@txdraft.example.com', now()), ('${U.dmm}', 'dmm@txdraft.example.com', now()),
    ('${U.portal}', 'portal@txdraft.example.com', now()), ('${U.staffB}', 'staffb@txdraft.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.acc}', 'acc'), ('${U.jed}', 'jed'),
    ('${U.dmm}', 'dmm'), ('${U.portal}', 'portal'), ('${U.staffB}', 'staffB')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'txdraft-org-b', 'مؤسسة ب', 'Tx draft org B', 'TDB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', 'Client B Co', '0509990000');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.acc}', '${A}', NULL, 'accountant'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff'),
    ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
async function ext(o) {
  const x = Object.assign({ org: A, tx: null, kind: 'bill_of_lading', fields: {}, items: [], detail: null, by: 'jed', sha: sha() }, o || {});
  let usage = null;
  if (x.detail) {
    usage = (await q(`INSERT INTO app.ai_usage (org_id, user_id, purpose, status, model, reserved_usd, cost_usd, input_tokens, output_tokens, settled_at)
                      VALUES ($1, $2, 'doc_extract', 'ok', 'claude-opus-5-5', 0.48, 0.01, 10, 10, now()) RETURNING id`, [x.org, U[x.by]]))[0].id;
  }
  return (await q(`INSERT INTO public.document_extractions (org_id, transaction_id, doc_type, source_name, source_sha256, engine, languages,
                     raw_text, extracted_fields, line_items, created_by, ai_usage_id, ai_detail)
                   VALUES ($1, $2, $3, 'doc.pdf', $4, $5, 'auto', 'x', $6, $7, $8, $9, $10) RETURNING id`,
    [x.org, x.tx, x.kind, x.sha, x.detail ? 'claude-opus-5-5' : 'tesseract.js@5.1.1', J(x.fields), J(x.items), U[x.by], usage, x.detail ? J(x.detail) : null]))[0].id;
}
const det = (type, containers, decl) => Object.assign({ prompt_version: 'ai-doc-v3', detected_type: type, doc_type: type, containers: containers || [],
  fields: [], warnings: [] }, decl ? { declaration: decl } : {});
const mkBatch = (who, p, org) => rpc(who || 'jed', `SELECT public.create_doc_batch($1, $2) r`, [org || A, p || {}]);
const attach = (who, b, e, slot) => rpc(who || 'jed', `SELECT public.attach_doc_batch_document($1, $2) r`, [b, { extraction_id: e, slot }]);
const getB = (who, b) => rpc(who || 'jed', `SELECT public.get_doc_batch($1) r`, [b]);
const createDraft = (who, b, p) => rpc(who || 'jed', `SELECT public.create_draft_transaction($1, $2) r`, [b, p]);
const approveTx = (who, tx, p) => rpc(who || 'jed', `SELECT public.approve_transaction($1, $2) r`, [tx, p]);
const getAppr = (who, tx) => rpc(who || 'jed', `SELECT public.get_transaction_approval($1) r`, [tx]);
// a batch with the B/L + invoice (+ packing) readings attached, merged by the server and the merged draft saved
async function batchOf(who, o) {
  const x = Object.assign({ bl: nextBl(), ctr: [nextCtr()], packing: true, blField: true, branchId: null }, o || {});
  const b = await mkBatch(who, x.branchId ? { branch_id: x.branchId } : {});
  const blFields = { vessel: 'MSC TEST', voyage: '001A', port_of_loading: 'Shanghai', port_of_discharge: 'Jeddah Islamic Port',
    consignee: 'CONSIGNEE: TEST TRADING CO. ONE\nP.O. BOX 1 JEDDAH', shipper: 'SHANGHAI SUPPLIER LTD', gross_weight: '1200', net_weight: '1000',
    packages_count: '40', package_type: 'CTNS', goods_description: 'Brake pads', shipping_line: 'MSC' };
  if (x.blField) blFields.bl_number = x.bl;
  if (x.ctr.length) blFields.container_numbers = x.ctr.join(', ');
  const bl = await ext({ by: who || 'jed', kind: 'bill_of_lading', fields: blFields,
    detail: det('bill_of_lading', x.ctr.map(c => ({ container_number: c, size_type: '40HC', gross_weight: 1200 }))) });
  const invFields = { invoice_number: 'INV-' + x.bl, invoice_date: '2026-10-01', supplier_name: 'SHANGHAI SUPPLIER LTD', buyer_name: 'TEST TRADING CO. ONE',
    currency: 'USD', total: '5000', incoterms: 'CFR Jeddah', country_of_origin: 'China' };
  if (x.blField) invFields.bl_number = x.bl;
  const inv = await ext({ by: who || 'jed', kind: 'commercial_invoice', fields: invFields,
    items: [{ description: 'Brake pads', hs_code: '870830', quantity: 40, unit: 'CARTON', unit_price: 125, amount: 5000, net_weight: 1000 }],
    detail: det('commercial_invoice') });
  let pk = null;
  if (x.packing) {
    pk = await ext({ by: who || 'jed', kind: 'packing_list', fields: { packing_list_number: 'PL-1', packages_count: '40', net_weight: '1000', gross_weight: '1200' },
      items: [{ description: 'Brake pads', packages: 40, net_weight: 1000, gross_weight: 1200 }], detail: det('packing_list') });
  }
  await attach(who, b.id, bl, 'bill_of_lading');
  const at = await attach(who, b.id, inv, 'commercial_invoice');
  let last = at;
  if (pk) last = await attach(who, b.id, pk, 'packing_list');
  // the ocr.html chain: merge (read-only, server) → save the merged draft (version)
  const m = await rpc(who || 'jed', `SELECT public.merge_doc_batch($1) r`, [b.id]);
  const g0 = await getB(who, b.id);
  const sv = await rpc(who || 'jed', `SELECT public.save_doc_batch_draft($1, $2) r`, [b.id, { version: g0.version, draft: m.draft }]);
  const g = await getB(who, b.id);
  return { id: b.id, version: sv.version, bl, inv, pk, blNo: x.bl, ctr: x.ctr, batch: g, last };
}
// a declaration reading of a transaction's B/L + containers, approved through approve_declaration_extraction
async function approveDecl(who, tx, o) {
  const x = Object.assign({ bl: null, ctrs: [], no: '3' + String(500000 + (++blSeq)) }, o || {});
  const fields = { declaration_number: x.no, declaration_type: 'import', declaration_status: 'accepted', declaration_date: '2026-10-07',
    declaration_date_hijri: '1448/04/15', vessel: 'MSC TEST', country_of_origin: 'الصين', container_numbers: x.ctrs.join(', '),
    importer_name_ar: 'شركة الاختبار الأولى للتجارة', invoice_number: 'INV-D1', total: '5000', currency: 'USD' };
  if (x.bl) fields.bl_number = x.bl;
  const e = await ext({ by: who || 'jed', kind: 'customs_declaration', fields,
    items: [{ description: 'فحمات فرامل', hs_code: '870830', quantity: 40, unit: 'كرتون', amount: 5000, origin_country: 'الصين' }],
    detail: det('customs_declaration', x.ctrs.map(c => ({ container_number: c, size_type: '40HC', gross_weight: 1200 })),
      { type_evidence: 'بيان استيراد', status_raw: 'accepted', bl_raw: x.bl, bl_candidates: x.bl ? [x.bl] : [], bl_rtl_affected: false,
        date_printed: '2026-10-07', date_from_hijri: '2026-10-07', hijri_supported: true }) });
  const rv = await rpc(who || 'jed', `SELECT public.get_declaration_review($1, $2) r`, [e, tx]);
  const r = await rpc(who || 'jed', `SELECT public.approve_declaration_extraction($1, $2, $3) r`, [e, tx, { version: rv.version }]);
  return { extraction: e, result: r };
}
// a valid three-way engine row
function row3(key, status, critical) {
  return { key, label_ar: 'حقل', label_en: 'Field', values: { invoice: 'A', bl: 'A', declaration: 'A' }, status, detail_ar: '', detail_en: '',
    critical: !!critical, conf: { invoice: 0.9, bl: 0.9, declaration: 0.9 },
    pairs: { inv_bl: status, inv_decl: status, bl_decl: status } };
}
const CLEAN_ROWS = [row3('bl_number', 'match', true), row3('consignee', 'match'), row3('gross_weight', 'match', true)];
const MISMATCH_ROWS = [row3('bl_number', 'match', true), row3('consignee', 'mismatch'), row3('gross_weight', 'match', true)];
async function saveMatch(who, o) {
  const x = Object.assign({ mode: 'three_way', rows: CLEAN_ROWS, overall: 'match', counts: { match: 3 } }, o || {});
  const p = { invoice_extraction_id: x.inv, bl_extraction_id: x.bl, mode: x.mode, engine_version: 'match-v1', overall: x.overall,
    counts: x.counts, rows: x.mode === 'two_way' ? x.rows.map(r => ({ ...r, values: { invoice: 'A', bl: 'A' }, conf: { invoice: 0.9, bl: 0.9 },
      pairs: { inv_bl: r.status } })) : x.rows, reviewed_rows: [] };
  if (x.mode === 'three_way') p.declaration_extraction_id = x.decl;
  if (x.tx) p.transaction_id = x.tx;
  return rpc(who || 'jed', `SELECT public.save_document_match($1, $2) r`, [x.org || A, p]);
}
// a full draft: batch → draft transaction (jed, JED)
async function draftOf(o) {
  const b = await batchOf('jed', o);
  const r = await createDraft('jed', b.id, { version: b.version, new_transaction: { client_id: CLIENT_A }, idempotencyKey: newKey() });
  return Object.assign({ tx: r.transaction_id, ref: r.ref, res: r }, b);
}

const cc = async tx => Number((await one(`SELECT container_count n FROM public.transactions WHERE id = $1`, [tx])).n);
const nCtr = async tx => num(`SELECT count(*) n FROM public.containers WHERE transaction_id = $1`, [tx]);

async function secFile() {
  section('1. file');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('migration: preflight on return_extension (20261128000100), schema_versions row, no BEGIN/COMMIT, trigger + backfill', () =>
    (/version = '20261128000100'/.test(s) && /VALUES \('20261130000100', 'tx_container_count'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s)
      && /CREATE TRIGGER trg_container_count AFTER UPDATE OF status ON public\.doc_batches/.test(s)
      && /OLD\.status = 'draft' AND NEW\.status = 'approved'/.test(s) && /SECURITY DEFINER SET search_path = ''/.test(s)) || 'conventions');
  const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
  // later phases (each has its own suite) follow it, in order
  const LATER_PHASES = ['20261201000100_legacy_gaps.sql', '20261202000100_org_logo.sql', '20261203000100_draft_client_hidden.sql', '20261204000100_tx_stage_sets.sql', '20261205000100_service_item_price.sql', '20261206000100_storage_gate.sql', '20261207000100_driver_classes.sql', '20261208000100_ai_providers.sql', '20261209000100_ai_keys.sql', '20261211000100_reconvert.sql'];
  await check('all_migrations.sql: appended verbatim under its header (followed only by the later phases); the paste note names it', () => {
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    const rest = nx < 0 ? '' : all.slice(nx);
    const later = (rest.match(/-- ===== migrations\/([^ ]+) =====/g) || []).map(x => x.replace(/^-- ===== migrations\/| =====$/g, ''));
    return (i > 0 && body === s && J(later) === J(LATER_PHASES) && all.slice(0, 30000).includes(MIG)) || 'not appended verbatim / no note / later ' + J(later);
  });
}

async function secDraft() {
  section('2. draft from the matching report / doc batch approvals');
  await check('a draft with 1 container → container_count 1 (was 0)', async () => {
    const d = await draftOf();
    return ((await cc(d.tx)) === 1 && (await nCtr(d.tx)) === 1) || J({ cc: await cc(d.tx), n: await nCtr(d.tx) });
  });
  await check('a draft with 3 containers → container_count 3', async () => {
    const d = await draftOf({ ctr: [nextCtr(), nextCtr(), nextCtr()] });
    return ((await cc(d.tx)) === 3 && (await nCtr(d.tx)) === 3) || J({ cc: await cc(d.tx), n: await nCtr(d.tx) });
  });
  await check('Ro-Ro draft (no container) → container_count stays 0', async () => {
    const x = await batchOf('jed', { ctr: [] });
    const r = await createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A }, cargo_unit_type: 'roro', chassis_no: 'JTDBZ3FE50K7654321' });
    return (await cc(r.transaction_id)) === 0 || 'cc ' + (await cc(r.transaction_id));
  });
  await check('approve_doc_batch into a NEW (active) transaction with 2 containers → container_count 2, not a draft', async () => {
    const x = await batchOf('jed', { ctr: [nextCtr(), nextCtr()] });
    const r = await rpc('jed', `SELECT public.approve_doc_batch($1, $2) r`, [x.id, { version: x.version, new_transaction: { client_id: CLIENT_A }, confirm_client: true }]);
    const t = await one(`SELECT container_count, is_draft FROM public.transactions WHERE id = $1`, [r.transaction_id]);
    return (t.container_count === 2 && t.is_draft === false) || J(t);
  });
  await check('approve_doc_batch into an EXISTING transaction: raised to its containers when lower (0 + 1 existing + 1 new → 2)', async () => {
    const t = (await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea') RETURNING id`, [A, JED, CLIENT_A]))[0].id;
    await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, t, nextCtr()]);
    const x = await batchOf('jed');
    await rpc('jed', `SELECT public.approve_doc_batch($1, $2) r`, [x.id, { version: x.version, transaction_id: t }]);
    return ((await cc(t)) === 2 && (await nCtr(t)) === 2) || J({ cc: await cc(t), n: await nCtr(t) });
  });
  await check('approve_doc_batch into an EXISTING transaction whose count is larger (5, staff entered) → stays 5 (never lowered)', async () => {
    const t = (await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, container_count) VALUES ($1, $2, $3, 'import', 'sea', 5) RETURNING id`, [A, JED, CLIENT_A]))[0].id;
    const x = await batchOf('jed');
    await rpc('jed', `SELECT public.approve_doc_batch($1, $2) r`, [x.id, { version: x.version, transaction_id: t }]);
    return ((await cc(t)) === 5 && (await nCtr(t)) === 1) || J({ cc: await cc(t), n: await nCtr(t) });
  });
  await check('a failed approval (duplicate container) changes no count and leaves the batch a draft', async () => {
    const d = await draftOf();
    const x = await batchOf('jed', { bl: d.blNo, ctr: d.ctr });
    const n0 = await num(`SELECT coalesce(sum(container_count), 0) n FROM public.transactions`);
    const c = await code(() => createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A } }));
    const g = await getB('jed', x.id);
    return (c === 'MRS_DUPLICATE_TX container' && g.status === 'draft' && (await num(`SELECT coalesce(sum(container_count), 0) n FROM public.transactions`)) === n0) || J({ c, g: g.status });
  });
  await check('the trigger function is not executable by anon / authenticated', async () => {
    const r = await one(`SELECT has_function_privilege('anon', 'app.tg_doc_batches_container_count()', 'EXECUTE') a,
                                has_function_privilege('authenticated', 'app.tg_doc_batches_container_count()', 'EXECUTE') u`);
    return (r.a === false && r.u === false) || J(r);
  });
}

async function catalog2() {
  return q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig, md5(p.prosrc) h, coalesce(p.proacl::text, '') acl
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public')
            UNION ALL SELECT 'trg:' || c.relname || '.' || t.tgname, md5(pg_get_triggerdef(t.oid)), ''
              FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal ORDER BY 1`);
}

async function secBackfill() {
  section('3. backfill of drafts made before the file; re-run');
  const d0 = new PGlite();
  await d0.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles().filter(f => f < MIG && f !== '20261129000100_mfa_off.sql')) await d0.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await d0.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await d0.exec(FIXTURES);
  await withDb(d0, async () => {
    const d = await draftOf({ ctr: [nextCtr(), nextCtr()] });
    const before = await cc(d.tx);
    // a transaction with containers but no doc batch: not touched by the backfill
    const t = (await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea') RETURNING id`, [A, JED, CLIENT_A]))[0].id;
    await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, t, nextCtr()]);
    // a draft made before the file, then cancelled: frozen (legacy_norm) — the backfill must skip it, not abort
    const dc = await draftOf();
    const cr = await code(() => as('admin', `SELECT public.cancel_transaction($1, $2)`, [dc.tx, 'مسودة مكررة']));
    const cancelled = (await one(`SELECT cancelled_at IS NOT NULL c FROM public.transactions WHERE id = $1`, [dc.tx])).c;
    await check('before the file: the draft shows container_count 0 (the bug); a second draft is cancelled', () =>
      (before === 0 && cr === 'ok' && cancelled === true) || J({ before, cr, cancelled }));
    await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
    await check('after the file: the draft → 2; a transaction without an approved batch keeps 0; the cancelled draft keeps 0 (file applied, not aborted)', async () =>
      ((await cc(d.tx)) === 2 && (await cc(t)) === 0 && (await cc(dc.tx)) === 0
        && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261130000100'`)) === 1) || J({ d: await cc(d.tx), t: await cc(t), c: await cc(dc.tx) }));
    const c1 = await catalog2();
    const s1 = await num(`SELECT coalesce(sum(container_count), 0) n FROM public.transactions`);
    await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
    await check('re-run on itself: identical catalog, no data change, one schema_versions row', async () =>
      (J(await catalog2()) === J(c1) && (await num(`SELECT coalesce(sum(container_count), 0) n FROM public.transactions`)) === s1
        && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261130000100'`)) === 1) || 'changed');
  });
  await d0.close();
}

async function main() {
  await secFile();
  await secBackfill();
  section('load shim + migrations + seed + fixtures');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  pass('database ready');
  await secDraft();
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
}
main().catch(e => { console.error(e); process.exit(1); });
