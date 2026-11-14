#!/usr/bin/env node
/*
  Marsa (مرسى) — draft transaction from the matching report + approval after the customs declaration:
  migration 20261127000100_tx_draft_approval.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).
  Invented data only.

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal).

  Covers: file conventions + all_migrations.sql + docs; preflight, re-run on itself (identical catalog), catalog delta;
  existing transactions stay active (no backfill); create_draft_transaction (happy path: draft, hidden 'created' event,
  B/L / containers / shipment data / items written, readings linked, batch approved; B/L / containers rules, Ro-Ro;
  duplicate rolls everything back; replay / conflict; roles, other branch, client, other org); the guard (direct API
  INSERT / UPDATE cannot set the draft / approval columns); approve_transaction (declaration approval required; two-way /
  other transaction / voided / other declaration reading refused; mismatch needs confirm + note; replay; already approved;
  cancelled; 'tx_approval' event client visible; operational status unchanged); get_transaction_approval; privileges;
  supa.js wrappers + i18n messages.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/tx-draft-sql-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261127000100_tx_draft_approval.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in tx-draft-sql-tests'); };

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
  for (const f of migFiles().filter(f => !upTo || f < upTo)) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
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

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql, docs');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261126000100, schema_versions row, search_path = \'\' on every function, no BEGIN / COMMIT', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261126000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261127000100', 'tx_draft_approval'\)/.test(src)
      && !/^\s*(BEGIN|COMMIT)\s*;/m.test(src) && heads.length === NEW_FNS.length + RECREATED.length && bad.length === 0)
      || J({ n: heads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('refusals through app.fail(\'MRS_*\') only; every code has an Arabic message in supa.js and Arabic + English in i18n.js', () => {
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|TX DRAFT preflight/.test(r));
    const used = [...new Set((src.match(/app\.fail\('(MRS_[A-Z_]+)'/g) || []).map(x => x.slice(10, -1)))].sort();
    const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
    const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
    const missing = used.filter(c => !new RegExp('\\b' + c + ':').test(supa) || (i18n.match(new RegExp('\\n\\s+' + c + ': ', 'g')) || []).length < 2);
    return (raises.length === 0 && missing.length === 0 && CODES.every(c => used.includes(c) && src.slice(0, 8000).includes(c))) || J({ raises, missing });
  });
  await check('no TRUNCATE / DROP TABLE / DROP FUNCTION / DELETE / UPDATE of existing rows outside the RPCs; no key or endpoint', () => {
    const c = src.replace(/--.*$/gm, '');
    const outside = c.replace(/AS \$\$[\s\S]*?\$\$;/g, '');
    return (!/\bTRUNCATE\b/i.test(c) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA)/i.test(c) && !/\bDELETE\s+FROM\b/i.test(c)
      && !/\bUPDATE\s+public\./i.test(outside) && !/session_replication_role/.test(c) && !/sk-ant|https?:\/\//i.test(src)) || 'body';
  });
  // later phases may follow this file (20261128000100 return_extension: widens the event types again)
  const LATER_PHASES = ['20261128000100_return_extension.sql'];
  await check('this file is the latest migration (or only listed later phases follow it)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (followed only by the listed later phases, in order) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const nx = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, nx < 0 ? undefined : nx);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 26000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
  await check('docs: LEGACY_DOCS_AR.md and LEGACY_DECL_AR.md name the migration, the RPCs and the error codes', () => {
    const d1 = fs.readFileSync(path.join(ROOT, 'docs', 'online', 'LEGACY_DOCS_AR.md'), 'utf8');
    const d2 = fs.readFileSync(path.join(ROOT, 'docs', 'online', 'LEGACY_DECL_AR.md'), 'utf8');
    const miss = [MIG, 'create_draft_transaction', 'مسودة'].filter(k => !d1.includes(k))
      .concat([MIG, 'approve_transaction', 'MRS_TX_MATCH_MISMATCH', 'match-tx'].filter(k => !d2.includes(k)));
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
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261126000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without doc_match_packing: exact preflight message, nothing created', async () =>
        (msg.startsWith('TX DRAFT preflight: apply doc_match_packing first (schema_versions lacks 20261126000100 doc_match_packing)')
          && (await one(`SELECT to_regprocedure('public.approve_transaction(uuid,jsonb)') IS NULL x`)).x && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261126000100', 'doc_match_packing')`);
      // an existing (production) transaction before the migration
      await db.exec(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${B}', 'pre-org', 'مؤسسة سابقة', 'PRE');
                     INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع');
                     INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل', '0509990000');
                     INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ('${B}', '${BR_B}', '${CL_B}', 'import', 'sea');`);
      const ev0 = await num(`SELECT count(*) n FROM public.transaction_events`);
      const r1 = await tryErr(() => db.exec(src));
      await check('applies on a database with transactions: they stay active (is_draft false, approved_at NULL), no event / row written', async () => {
        const t = await q(`SELECT is_draft, approved_at FROM public.transactions`);
        return (r1 === 'ok' && t.length === 1 && t[0].is_draft === false && t[0].approved_at === null
          && (await num(`SELECT count(*) n FROM public.transaction_events`)) === ev0) || J({ r1, t });
      });
      const C1 = await catalog();
      const r3 = await tryErr(() => db.exec(src));
      await check('re-runs on top of itself with an identical catalog; one schema_versions row', async () =>
        (r3 === 'ok' && J(C1) === J(await catalog()) && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261127000100'`)) === 1) || r3);
      const s0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the new functions; tg_transactions_created re-created with its ACL / definer / config kept; no new table', () => {
        const nm = s => s.split('(')[0];
        const added = [...new Set(C1.fns.filter(f => !s0.has(f.sig)).map(f => nm(f.sig)))].sort();
        const changed = C1.fns.filter(f => s0.has(f.sig) && s0.get(f.sig).h !== f.h).map(f => nm(f.sig)).sort();
        const keep = C1.fns.filter(f => s0.has(f.sig) && RECREATED.includes(nm(f.sig)))
          .every(f => s0.get(f.sig).acl === f.acl && s0.get(f.sig).d === f.d && s0.get(f.sig).c === f.c);
        return (J(added) === J(NEW_FNS) && J(changed) === J(RECREATED) && keep && J(C1.tables) === J(C0.tables)) || J({ added, changed, keep });
      });
      await check('catalog: the 5 new transactions columns; column SELECT for authenticated on 4 of them (not approval_note); a new trigger; the audit label', () => {
        const cols = C1.cols.filter(c => !C0.cols.includes(c)).sort();
        const g = C1.colGrants.filter(c => !C0.colGrants.includes(c) && /:SELECT$/.test(c)).sort();
        const trg = C1.trg.filter(t => !C0.trg.includes(t));
        const lab = C1.labels.filter(l => !C0.labels.includes(l));
        return (J(cols) === J(NEW_COLS) && J(g) === J(['transactions.approval_match_id:authenticated:SELECT', 'transactions.approved_at:authenticated:SELECT',
          'transactions.approved_by:authenticated:SELECT', 'transactions.is_draft:authenticated:SELECT']) && J(trg) === J(['transactions.trg_draft_guard'])
          && lab.length === 1 && /^audit_event\.tx_approval:19:/.test(lab[0]) && J(C1.pol) === J(C0.pol)) || J({ cols, g, trg, lab });
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. create_draft_transaction */
async function secCreate() {
  section('3. create_draft_transaction');
  const b = await batchOf('jed');
  const K = newKey();
  let R;
  await check('happy path: a NEW transaction marked as a draft (stage new), B/L + containers + بيانات فسح + items written, readings linked + reviewed, batch approved', async () => {
    R = await createDraft('jed', b.id, { version: b.version, new_transaction: { client_id: CLIENT_A }, confirm_client: true, idempotencyKey: K });
    const t = await one(`SELECT * FROM public.transactions WHERE id = $1`, [R.transaction_id]);
    const c = await q(`SELECT container_no FROM public.containers WHERE transaction_id = $1`, [R.transaction_id]);
    const sd = await num(`SELECT count(*) n FROM public.transaction_shipment_data WHERE transaction_id = $1 AND batch_id = $2`, [R.transaction_id, b.id]);
    const ii = await num(`SELECT count(*) n FROM public.shipment_invoice_items WHERE transaction_id = $1`, [R.transaction_id]);
    const e = await q(`SELECT transaction_id, review_status FROM public.document_extractions WHERE id = ANY ($1)`, [[b.bl, b.inv, b.pk]]);
    const g = await getB('jed', b.id);
    return (R.is_draft === true && R.created_transaction === true && /^MRS-/.test(R.ref) && t.is_draft === true && t.approved_at === null
      && t.operational_status === 'new' && t.branch_id === JED && t.client_id === CLIENT_A && t.bl_number === b.blNo && t.created_by === U.jed
      && J(c.map(x => x.container_no)) === J(b.ctr) && sd === 1 && ii === 1 && e.every(x => x.transaction_id === R.transaction_id && x.review_status === 'reviewed')
      && g.status === 'approved' && g.transaction_id === R.transaction_id && R.cargo_unit_type === 'container') || J({ R, t, c, sd, ii, e, g: g.status });
  });
  await check('the \'created\' event of a draft is NOT visible to the client (payload draft:true); the client portal user sees no event of it', async () => {
    const ev = await one(`SELECT visible_to_client, payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'created'`, [R.transaction_id]);
    const seen = Number((await as('portal', `SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1`, [R.transaction_id]))[0].n);
    return (ev.visible_to_client === false && ev.payload.draft === true && ev.payload.ref === R.ref && seen === 0) || J({ ev, seen });
  });
  await check('a transaction created any other way stays active: direct API insert → is_draft false and a client-visible \'created\' event', async () => {
    const t = (await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'land') RETURNING id, is_draft`, [A, JED, CLIENT_A]))[0];
    const ev = await one(`SELECT visible_to_client, payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'created'`, [t.id]);
    return (t.is_draft === false && ev.visible_to_client === true && ev.payload.draft === false) || J({ t, ev });
  });
  await check('replay: the same key returns the same result (replayed); the same key with another payload → MRS_IDEMPOTENCY_CONFLICT; one transaction', async () => {
    const rep = await createDraft('jed', b.id, { version: b.version, new_transaction: { client_id: CLIENT_A }, confirm_client: true, idempotencyKey: K });
    const other = await code(() => createDraft('jed', b.id, { version: b.version, new_transaction: { client_id: CLIENT_A2 }, idempotencyKey: K }));
    const again = await code(() => createDraft('jed', b.id, { version: b.version + 1, new_transaction: { client_id: CLIENT_A } }));
    const n = await num(`SELECT count(*) n FROM public.transactions WHERE bl_number = $1`, [b.blNo]);
    return (rep.replayed === true && rep.transaction_id === R.transaction_id && /MRS_IDEMPOTENCY_CONFLICT/.test(other)
      && again === 'MRS_DOC_BATCH_STATE approved' && n === 1) || J({ rep, other, again, n });
  });
  await check('no B/L number in the batch (sea) → MRS_REQUIRED bl_number; batch stays a draft, nothing written', async () => {
    const x = await batchOf('jed', { blField: false });
    const n0 = await num(`SELECT count(*) n FROM public.transactions`);
    const c = await code(() => createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A } }));
    const g = await getB('jed', x.id);
    return (c === 'MRS_REQUIRED bl_number' && g.status === 'draft' && (await num(`SELECT count(*) n FROM public.transactions`)) === n0) || J({ c, g: g.status });
  });
  await check('no container (sea, container) → MRS_REQUIRED containers; Ro-Ro needs the chassis (MRS_REQUIRED chassis_no); Ro-Ro with no container + chassis passes (still a draft)', async () => {
    const x = await batchOf('jed', { ctr: [] });
    const c = await code(() => createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A } }));
    const nc = await code(() => createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A }, cargo_unit_type: 'roro' }));
    const r = await createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A }, cargo_unit_type: 'roro',
      chassis_no: 'jtd-bz3fe50k1234567', vehicle_plate_no: 'abc-1234' });
    const t = await one(`SELECT cargo_unit_type, is_draft, chassis_no, vehicle_plate_no FROM public.transactions WHERE id = $1`, [r.transaction_id]);
    return (c === 'MRS_REQUIRED containers' && nc === 'MRS_REQUIRED chassis_no' && r.is_draft === true && r.cargo_unit_type === 'roro'
      && t.cargo_unit_type === 'roro' && t.is_draft === true && t.chassis_no === 'JTDBZ3FE50K1234567' && t.vehicle_plate_no === 'ABC1234') || J({ c, nc, r, t });
  });
  await check('Ro-Ro with containers in the batch → MRS_INVALID containers_roro; air without a container but with the B/L passes; land needs neither', async () => {
    const x = await batchOf('jed');
    const c = await code(() => createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A }, cargo_unit_type: 'roro' }));
    const y = await batchOf('jed', { ctr: [] });
    const a = await createDraft('jed', y.id, { version: y.version, new_transaction: { client_id: CLIENT_A, mode: 'air' } });
    const z = await batchOf('jed', { ctr: [], blField: false });
    const l = await createDraft('jed', z.id, { version: z.version, new_transaction: { client_id: CLIENT_A, mode: 'land' } });
    return (c === 'MRS_INVALID containers_roro' && a.is_draft === true && a.mode === 'air' && l.is_draft === true && l.mode === 'land') || J({ c, a, l });
  });
  await check('payload: unknown key / cargo_unit_type / mode refused; new_transaction required; a batch of an existing transaction → MRS_INVALID transaction_id', async () => {
    const x = await batchOf('jed');
    const r = [await code(() => createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A }, transaction_id: TX_JED })),
      await code(() => createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A }, cargo_unit_type: 'truck' })),
      await code(() => createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A, mode: 'rail' } })),
      await code(() => createDraft('jed', x.id, { version: x.version }))];
    const y = await mkBatch('jed', { transaction_id: TX_JED });
    const t = await code(() => createDraft('jed', y.id, { version: y.version, new_transaction: { client_id: CLIENT_A } }));
    return (/^MRS_/.test(r[0]) && r[1] === 'MRS_INVALID cargo_unit_type' && r[2] === 'MRS_INVALID mode' && r[3] === 'MRS_REQUIRED new_transaction'
      && t === 'MRS_INVALID transaction_id') || J({ r, t });
  });
  await check('duplicate (same B/L + container as a live transaction) → MRS_DUPLICATE_TX container; everything rolled back (no transaction, batch draft, readings unlinked, no idempotency row)', async () => {
    const x = await batchOf('jed', { bl: b.blNo, ctr: b.ctr });
    const n0 = await num(`SELECT count(*) n FROM public.transactions`);
    const k = newKey();
    const c = await code(() => createDraft('jed', x.id, { version: x.version, new_transaction: { client_id: CLIENT_A }, idempotencyKey: k }));
    const g = await getB('jed', x.id);
    const linked = await num(`SELECT count(*) n FROM public.document_extractions WHERE id = ANY ($1) AND transaction_id IS NOT NULL`, [[x.bl, x.inv, x.pk]]);
    const idem = await num(`SELECT count(*) n FROM public.idempotency_keys WHERE key = $1`, [k]);
    const guc = (await one(`SELECT coalesce(current_setting('marsa.tx_draft', true), '') v`)).v;
    return (c === 'MRS_DUPLICATE_TX container' && g.status === 'draft' && (await num(`SELECT count(*) n FROM public.transactions`)) === n0
      && linked === 0 && idem === 0 && guc === '') || J({ c, g: g.status, linked, idem, guc });
  });
  await check('roles: accountant → MRS_FORBIDDEN role; other branch (dmm) / client user / other org → MRS_NOT_FOUND doc_batch; anon → permission denied', async () => {
    const x = await batchOf('jed');
    const p = { version: x.version, new_transaction: { client_id: CLIENT_A } };
    const r = [await code(() => createDraft('acc', x.id, p)), await code(() => createDraft('dmm', x.id, p)), await code(() => createDraft('portal', x.id, p)),
      await code(() => createDraft('staffB', x.id, p)), await code(() => as('anon', `SELECT public.create_draft_transaction($1, $2)`, [x.id, p]))];
    const g = await getB('jed', x.id);
    return (r[0] === 'MRS_FORBIDDEN role' && r[1] === 'MRS_NOT_FOUND doc_batch' && r[2] === 'MRS_NOT_FOUND doc_batch' && r[3] === 'MRS_NOT_FOUND doc_batch'
      && r[4] === 'perm' && g.status === 'draft') || J({ r, g: g.status });
  });
  await check('the draft counts toward the G7 monthly usage like any transaction (a real MRS record)', async () => {
    const has = await one(`SELECT to_regclass('public.org_usage_monthly') IS NOT NULL x`);
    if (!has.x) return true;
    const n = await num(`SELECT coalesce(sum(transactions_created), 0) n FROM public.org_usage_monthly WHERE org_id = $1`, [A]);
    return n > 0 || 'usage ' + n;
  });
}

/* ================================================================== 4. guard */
async function secGuard() {
  section('4. guard: direct API writes cannot create a draft or approve one');
  const d = await draftOf();
  await check('direct API INSERT with is_draft / approved_* set → stored as an active transaction without approval', async () => {
    const t = (await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, is_draft, approved_at, approved_by, approval_note)
                                VALUES ($1, $2, $3, 'import', 'land', true, now(), $4, 'x') RETURNING id`, [A, JED, CLIENT_A, U.jed]))[0];
    const r = await one(`SELECT is_draft, approved_at, approved_by, approval_note FROM public.transactions WHERE id = $1`, [t.id]);
    return (r.is_draft === false && r.approved_at === null && r.approved_by === null && r.approval_note === null) || J(r);
  });
  await check('direct API UPDATE of is_draft / approved_at / approval_note → MRS_IMMUTABLE; other columns still editable on a draft', async () => {
    const r = [await code(() => as('jed', `UPDATE public.transactions SET is_draft = false WHERE id = $1`, [d.tx])),
      await code(() => as('jed', `UPDATE public.transactions SET approved_at = now() WHERE id = $1`, [d.tx])),
      await code(() => as('jed', `UPDATE public.transactions SET approval_note = 'x' WHERE id = $1`, [d.tx])),
      await code(() => as('admin', `UPDATE public.transactions SET is_draft = true WHERE id = $1`, [TX_JED]))];
    const ok = await code(() => as('jed', `UPDATE public.transactions SET goods_description = 'Brake pads (edited)' WHERE id = $1`, [d.tx]));
    const t = await one(`SELECT is_draft, goods_description FROM public.transactions WHERE id = $1`, [d.tx]);
    return (r[0] === 'MRS_IMMUTABLE is_draft' && r[1] === 'MRS_IMMUTABLE approved_at' && r[2] === 'MRS_IMMUTABLE approval_note'
      && r[3] === 'MRS_IMMUTABLE is_draft' && ok === 'ok' && t.is_draft === true && t.goods_description === 'Brake pads (edited)') || J({ r, ok, t });
  });
  await check('the session setting alone does not make an API insert a draft; a draft cannot carry approved_at (check constraint)', async () => {
    await db.exec(`SELECT set_config('marsa.tx_draft', 'on', false)`);
    let t;
    try {
      t = (await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'land') RETURNING is_draft`, [A, JED, CLIENT_A]))[0];
    } finally { await db.exec(`SELECT set_config('marsa.tx_draft', '', false)`); }
    const c = await code(() => db.exec(`SET session_replication_role = replica; UPDATE public.transactions SET approved_at = now() WHERE id = '${d.tx}'`));
    await db.exec(`SET session_replication_role = origin`);
    return (t.is_draft === false && c === 'chk:transactions_draft_approval_chk') || J({ t, c });
  });
  await check('staff list reads see is_draft / approved_at (column grant); approval_note is not selectable through the API', async () => {
    const r = (await as('jed', `SELECT is_draft, approved_at, approved_by, approval_match_id FROM public.transactions WHERE id = $1`, [d.tx]))[0];
    const n = await code(() => as('jed', `SELECT approval_note FROM public.transactions WHERE id = $1`, [d.tx]));
    return (r.is_draft === true && n === 'perm') || J({ r, n });
  });
}

/* ================================================================== 5. approve_transaction */
async function secApprove() {
  section('5. approve_transaction');
  const d = await draftOf();
  await check('no declaration approval → MRS_REQUIRED declaration_approval (even with a match id); no match id → MRS_REQUIRED match_id', async () => {
    const m = await saveMatch('jed', { inv: d.inv, bl: d.bl, mode: 'two_way', tx: d.tx });
    const a = await code(() => approveTx('jed', d.tx, { match_id: m.id }));
    const b = await code(() => approveTx('jed', d.tx, {}));
    return (a === 'MRS_REQUIRED declaration_approval' && b === 'MRS_REQUIRED match_id') || J({ a, b });
  });
  const dec = await approveDecl('jed', d.tx, { bl: d.blNo, ctrs: d.ctr });
  await check('the declaration approval moves the stage (trigger) but the transaction stays a draft; get_transaction_approval shows it', async () => {
    const t = await one(`SELECT is_draft, operational_status FROM public.transactions WHERE id = $1`, [d.tx]);
    const g = await getAppr('jed', d.tx);
    return (t.is_draft === true && t.operational_status === 'customs_declaration' && g.is_draft === true && g.has_declaration === true
      && g.declaration_approval && g.declaration_approval.extraction_id === dec.extraction && g.last_three_way_match === null) || J({ t, g });
  });
  await check('refused matches → MRS_INVALID match_id: two-way, another transaction\'s, voided, on another declaration reading, unknown id', async () => {
    const two = await saveMatch('jed', { inv: d.inv, bl: d.bl, mode: 'two_way', tx: d.tx });
    const o = await draftOf();
    const od = await approveDecl('jed', o.tx, { bl: o.blNo, ctrs: o.ctr });
    const other = await saveMatch('jed', { inv: o.inv, bl: o.bl, decl: od.extraction });
    const vo = await saveMatch('jed', { inv: d.inv, bl: d.bl, decl: dec.extraction });
    await rpc('jed', `SELECT public.void_document_match($1, 'test') r`, [vo.id]);
    const ox = await ext({ kind: 'customs_declaration', tx: d.tx, fields: { declaration_number: '399999' } });
    const od2 = await saveMatch('jed', { inv: d.inv, bl: d.bl, decl: ox });
    const r = [await code(() => approveTx('jed', d.tx, { match_id: two.id })), await code(() => approveTx('jed', d.tx, { match_id: other.id })),
      await code(() => approveTx('jed', d.tx, { match_id: vo.id })), await code(() => approveTx('jed', d.tx, { match_id: od2.id })),
      await code(() => approveTx('jed', d.tx, { match_id: newKey() }))];
    const t = await one(`SELECT is_draft FROM public.transactions WHERE id = $1`, [d.tx]);
    return (r.every(x => x === 'MRS_INVALID match_id') && t.is_draft === true && other.transaction_id === o.tx) || J({ r, t });
  });
  const mm = await saveMatch('jed', { inv: d.inv, bl: d.bl, decl: dec.extraction, rows: MISMATCH_ROWS, overall: 'review', counts: { match: 2, mismatch: 1 } });
  await check('a mismatch without confirm / without a note → MRS_TX_MATCH_MISMATCH review; nothing changed', async () => {
    const r = [await code(() => approveTx('jed', d.tx, { match_id: mm.id })), await code(() => approveTx('jed', d.tx, { match_id: mm.id, confirm_mismatch: true })),
      await code(() => approveTx('jed', d.tx, { match_id: mm.id, note: 'checked' })),
      await code(() => approveTx('jed', d.tx, { match_id: mm.id, confirm_mismatch: true, note: '   ' }))];
    const t = await one(`SELECT is_draft FROM public.transactions WHERE id = $1`, [d.tx]);
    return (r.every(x => x === 'MRS_TX_MATCH_MISMATCH review') && t.is_draft === true) || J({ r, t });
  });
  await check('roles: accountant → MRS_FORBIDDEN role; dmm / client / other org → MRS_NOT_FOUND transaction', async () => {
    const p = { match_id: mm.id, confirm_mismatch: true, note: 'ok' };
    const r = [await code(() => approveTx('acc', d.tx, p)), await code(() => approveTx('dmm', d.tx, p)), await code(() => approveTx('portal', d.tx, p)),
      await code(() => approveTx('staffB', d.tx, p))];
    return (r[0] === 'MRS_FORBIDDEN role' && r.slice(1).every(x => x === 'MRS_NOT_FOUND transaction')) || J(r);
  });
  const st0 = (await one(`SELECT operational_status FROM public.transactions WHERE id = $1`, [d.tx])).operational_status;
  const K = newKey();
  let R;
  await check('mismatch confirmed with a note → approved: is_draft false, approved_at / by / match / note set; stage unchanged', async () => {
    R = await approveTx('jed', d.tx, { match_id: mm.id, confirm_mismatch: true, note: '  الاسم مختلف في الكتابة فقط  ', idempotencyKey: K });
    const t = await one(`SELECT * FROM public.transactions WHERE id = $1`, [d.tx]);
    return (R.is_draft === false && R.confirmed_mismatch === true && R.approval_match_id === mm.id && t.is_draft === false && t.approved_by === U.jed
      && t.approved_at !== null && t.approval_match_id === mm.id && t.approval_note === 'الاسم مختلف في الكتابة فقط' && t.operational_status === st0) || J({ R, t });
  });
  await check('the \'tx_approval\' event: client visible, payload {match_id, overall, counts, declaration_id, confirmed_mismatch} without the note; the client sees it', async () => {
    const ev = await one(`SELECT * FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'tx_approval'`, [d.tx]);
    const seen = Number((await as('portal', `SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'tx_approval'`, [d.tx]))[0].n);
    return (ev.visible_to_client === true && ev.actor === U.jed && ev.payload.match_id === mm.id && ev.payload.overall === 'review'
      && ev.payload.counts.mismatch === 1 && ev.payload.declaration_id === dec.result.declaration.id && ev.payload.confirmed_mismatch === true
      && !J(ev.payload).includes('الاسم') && seen === 1) || J({ ev, seen });
  });
  await check('replay with the same key (replayed); the same match without a key → already_approved; another match → MRS_TX_NOT_DRAFT; one event', async () => {
    const rep = await approveTx('jed', d.tx, { match_id: mm.id, confirm_mismatch: true, note: '  الاسم مختلف في الكتابة فقط  ', idempotencyKey: K });
    const same = await approveTx('jed', d.tx, { match_id: mm.id });
    const clean = await saveMatch('jed', { inv: d.inv, bl: d.bl, decl: dec.extraction });
    const other = await code(() => approveTx('jed', d.tx, { match_id: clean.id }));
    const n = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'tx_approval'`, [d.tx]);
    const conflict = await code(() => approveTx('jed', d.tx, { match_id: clean.id, idempotencyKey: K }));
    return (rep.replayed === true && same.already_approved === true && same.is_draft === false && other === 'MRS_TX_NOT_DRAFT' && n === 1
      && /MRS_IDEMPOTENCY_CONFLICT/.test(conflict)) || J({ rep, same, other, n, conflict });
  });
  await check('the same match again with a NEW key → already_approved, and a retry with that key replays (never MRS_IN_PROGRESS)', async () => {
    const K2 = newKey();
    const a = await approveTx('jed', d.tx, { match_id: mm.id, idempotencyKey: K2 });
    const b = await code(() => approveTx('jed', d.tx, { match_id: mm.id, idempotencyKey: K2 }));
    const b2 = b === 'ok' ? await approveTx('jed', d.tx, { match_id: mm.id, idempotencyKey: K2 }) : null;
    return (a.already_approved === true && b === 'ok' && b2 && b2.replayed === true) || J({ a, b, b2 });
  });
  await check('the declaration of the latest approval cancelled since → MRS_REQUIRED declaration_approval', async () => {
    const e = await draftOf();
    const dd = await approveDecl('jed', e.tx, { bl: e.blNo, ctrs: e.ctr });
    const m = await saveMatch('jed', { inv: e.inv, bl: e.bl, decl: dd.extraction });
    const cx = await code(() => rpc('admin', `SELECT public.cancel_declaration($1, 'بيان خاطئ') r`, [dd.result.declaration.id]));
    const c = await code(() => approveTx('jed', e.tx, { match_id: m.id }));
    const t = await one(`SELECT is_draft FROM public.transactions WHERE id = $1`, [e.tx]);
    return (cx === 'ok' && c === 'MRS_REQUIRED declaration_approval' && t.is_draft === true) || J({ cx, c, t });
  });
  await check('a transaction that was never a draft → MRS_TX_NOT_DRAFT', async () =>
    (await code(() => approveTx('admin', TX_JED, { match_id: mm.id }))) === 'MRS_TX_NOT_DRAFT');
  await check('a clean three-way match approves without confirmation; get_transaction_approval reports approved_by_name and the match', async () => {
    const e = await draftOf();
    const dd = await approveDecl('jed', e.tx, { bl: e.blNo, ctrs: e.ctr });
    const m = await saveMatch('jed', { inv: e.inv, bl: e.bl, decl: dd.extraction });
    const r = await approveTx('jed', e.tx, { match_id: m.id });
    const g = await getAppr('jed', e.tx);
    return (r.is_draft === false && r.confirmed_mismatch === false && g.approved_by_name === 'jed' && g.last_three_way_match.id === m.id
      && g.last_three_way_match.overall === 'match' && g.approval_note === null) || J({ r, g });
  });
  await check('a cancelled draft (cancel_transaction) → MRS_BAD_TRANSITION cancelled (the shared lock of legacy_core)', async () => {
    const e = await draftOf();
    const dd = await approveDecl('jed', e.tx, { bl: e.blNo, ctrs: e.ctr });
    const m = await saveMatch('jed', { inv: e.inv, bl: e.bl, decl: dd.extraction });
    const cx = await code(() => rpc('admin', `SELECT public.cancel_transaction($1, 'مسودة متروكة') r`, [e.tx]));
    const c = await code(() => approveTx('admin', e.tx, { match_id: m.id }));
    return (cx === 'ok' && c === 'MRS_BAD_TRANSITION cancelled') || J({ cx, c });
  });
  await check('get_transaction_approval: other branch / client / other org → MRS_NOT_FOUND transaction; anon → permission denied', async () => {
    const r = [await code(() => getAppr('dmm', d.tx)), await code(() => getAppr('portal', d.tx)), await code(() => getAppr('staffB', d.tx)),
      await code(() => as('anon', `SELECT public.get_transaction_approval($1)`, [d.tx]))];
    return (r.slice(0, 3).every(x => x === 'MRS_NOT_FOUND transaction') && r[3] === 'perm') || J(r);
  });
}

/* ================================================================== 6. privileges */
async function secPriv() {
  section('6. privileges');
  await check('the 3 RPCs executable by authenticated only (not anon, not service_role); app.tx_approval_json by nobody', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('anon', p.oid, 'EXECUTE') an,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') sr
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1)`, [RPCS]);
    const h = await q(`SELECT has_function_privilege('authenticated', 'app.tx_approval_json(uuid)', 'EXECUTE') au,
                              has_function_privilege('anon', 'app.tx_approval_json(uuid)', 'EXECUTE') an`);
    return (r.length === RPCS.length && r.every(x => x.au && !x.an && !x.sr) && !h[0].au && !h[0].an) || J({ r, h });
  });
}

/* ================================================================== 7. supa.js + i18n */
async function secStatic() {
  section('7. supa.js wrappers, i18n messages');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  await check('supa.js: createDraftTransaction / approveTransaction / getTransactionApproval wrappers exported, with the RPC names', () =>
    (/function createDraftTransaction\(/.test(supa) && /function approveTransaction\(/.test(supa) && /function getTransactionApproval\(/.test(supa)
      && /'create_draft_transaction'/.test(supa) && /'approve_transaction'/.test(supa) && /'get_transaction_approval'/.test(supa)
      && /createDraftTransaction: createDraftTransaction/.test(supa) && /approveTransaction: approveTransaction/.test(supa)) || 'wrappers');
  // vm: the wrappers build the payload (camel → snake, idempotency key) — loader of doc-match-sql-tests.js
  const calls = [];
  const client = {
    rpc: (name, a) => { calls.push({ fn: name, args: a }); const p = Promise.resolve({ data: { ok: true }, error: null }); p.abortSignal = () => p; return p; },
    from: () => { const b = {}; ['select', 'eq', 'is', 'order', 'limit', 'maybeSingle', 'single'].forEach(m => { b[m] = () => b; }); b.then = (r) => Promise.resolve({ data: null, error: null }).then(r); return b; },
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: () => Promise.resolve({ data: { session: null } }) }
  };
  let api = null;
  try {
    const win = { MARSA_CONFIG: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'test-anon-key-not-real', orgSlug: 'blue-sea' },
      supabase: { createClient: () => client }, addEventListener() {}, dispatchEvent() {},
      location: { origin: 'http://127.0.0.1:8000', pathname: '/ocr.html', hostname: '127.0.0.1', href: 'http://127.0.0.1:8000/ocr.html' } };
    const ctx = { window: win, document: { currentScript: null, head: { appendChild() {} }, createElement: () => ({}), addEventListener() {},
        documentElement: { setAttribute() {}, getAttribute: () => null, hasAttribute: () => false }, querySelector: () => null, querySelectorAll: () => [] },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { onLine: true }, location: win.location, console, setTimeout, clearTimeout, Promise, CustomEvent: function () {},
      crypto: require('crypto').webcrypto, URL, Date, Math, JSON };
    win.window = win;
    vm.createContext(ctx); vm.runInContext(supa, ctx);
    api = win.MarsaApi;
  } catch (e) { api = null; }
  await check('vm: createDraftTransaction(batch, {version, newTransaction, cargoUnitType, confirmClient, idemKey}) → create_draft_transaction payload', async () => {
    if (!api || typeof api.createDraftTransaction !== 'function') return 'MarsaApi not loaded in vm';
    calls.length = 0;
    const r = await api.createDraftTransaction('d7a2cccc-0000-4000-8000-000000000001', { version: 3, newTransaction: { clientId: CLIENT_A, operation: 'import', mode: 'sea' },
      cargoUnitType: 'roro', confirmClient: true, idemKey: 'd7a2cccc-0000-4000-8000-000000000009' });
    const c = calls.filter(x => x.fn === 'create_draft_transaction')[0];
    const bad = await api.createDraftTransaction('d7a2cccc-0000-4000-8000-000000000001', {});
    return (c && c.args.p_batch === 'd7a2cccc-0000-4000-8000-000000000001' && c.args.p_payload.version === 3 && c.args.p_payload.new_transaction.client_id === CLIENT_A
      && c.args.p_payload.cargo_unit_type === 'roro' && c.args.p_payload.confirm_client === true && c.args.p_payload.idempotencyKey === 'd7a2cccc-0000-4000-8000-000000000009'
      && !r.error && bad.error && bad.error.code === 'MRS_REQUIRED') || J({ c, r, bad });
  });
  await check('vm: approveTransaction(tx, {matchId, confirmMismatch, note, idemKey}) → approve_transaction payload; getTransactionApproval → get_transaction_approval', async () => {
    if (!api || typeof api.approveTransaction !== 'function') return 'MarsaApi not loaded in vm';
    calls.length = 0;
    await api.approveTransaction(TX_JED, { matchId: 'd7a2cccc-0000-4000-8000-000000000002', confirmMismatch: true, note: 'x', idemKey: 'd7a2cccc-0000-4000-8000-00000000000a' });
    await api.getTransactionApproval(TX_JED);
    const a = calls.filter(x => x.fn === 'approve_transaction')[0], g = calls.filter(x => x.fn === 'get_transaction_approval')[0];
    const bad = await api.approveTransaction(TX_JED, {});
    return (a && a.args.p_tx === TX_JED && a.args.p_payload.match_id === 'd7a2cccc-0000-4000-8000-000000000002' && a.args.p_payload.confirm_mismatch === true
      && a.args.p_payload.note === 'x' && a.args.p_payload.idempotencyKey && g && g.args.p_tx === TX_JED && bad.error && bad.error.code === 'MRS_REQUIRED') || J({ a, g, bad });
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
  await check('the seed transactions are active (is_draft false)', async () => (await num(`SELECT count(*) n FROM public.transactions WHERE is_draft`)) === 0);
  await secCreate();
  await secGuard();
  await secApprove();
  await secPriv();
  await secStatic();
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
}
main().catch(e => { console.error(e); process.exit(1); });
