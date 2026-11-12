#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 3 (shipment document batch and approval): migration 20261119000100_legacy_docs.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal).

  Covers: file conventions + all_migrations.sql + docs; preflight, re-run on itself (identical catalog), catalog delta;
  dictionaries; the ai-doc-v3 field / item keys (= extract.js), document_extractions.ai_detail (shape, AI-only, immutable,
  kept out of the trail); parties.aliases + the shipping-agent seed (no duplicates, aliases completed, admin RPC) and
  match_shipping_agent; the identity-name helper (SQL ↔ extract.js parity) and the Latin client key; doc batches (create:
  branch rules / roles; attach: wrong-slot guard on the saved kind and the detected type, voided, other org / branch,
  other open batch, same file, capacity, transaction adoption / mismatch, idempotent re-attach; detach = void; merge:
  sections, containers by number, items joined, merge conflicts; save: optimistic version, shape errors, comparison,
  summary columns; list / get: branch scoping, status filter; discard / archive rules); the comparison (legacy rules +
  seal / container sets + the missing-fields checklist); approve_doc_batch (new transaction from the draft, existing
  transaction: empty columns filled / differing kept, port inference, B/L through save_bl, containers through the step-2
  duplicate guard — a duplicate rolls everything back —, shipment data, items replaced void-only, readings linked +
  reviewed, alias suggested / approved, Ro-Ro refusal, stale version, idempotency replay, an approved batch is frozen, roles
  / branches); match_client_v2 (cascade, conflict, thresholds, rejected / suggested aliases), confirm_client_match (alias
  learning, statistics, conflict, a suggested alias moves), reject_client_alias; RLS on the 5 tables (branch scope, no
  API write, clients / anon nothing), the audit trail without content, the conversion lists, function privileges;
  supa.js wrappers and i18n messages.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-docs-sql-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261119000100_legacy_docs.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const XJS = require(path.join(SUPA, 'functions', 'ai-extract', 'extract.js'));

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in legacy-docs-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'deca0000-0000-4000-8000-0000000000b0';           // second org (fixture)
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const TX_JED = '0b5e0000-0000-4000-8000-000000000201';      // seed: JED, B/L TESTBL0000001, TSTU0000001 / TSTU0000002
const TX_DMM = '0b5e0000-0000-4000-8000-000000000202';      // seed: DMM, B/L TESTBL0000002, TSTU0000003
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';    // «شركة الاختبار الأولى للتجارة» / Test Trading Co. One, VAT 300000000000003
const CLIENT_A2 = '0b5e0000-0000-4000-8000-000000000102';   // «مؤسسة التجربة الثانية» / Test Est. Two
const BR_B = 'deca0000-0000-4000-8000-0000000000b1';
const CL_B = 'deca0000-0000-4000-8000-0000000000b3';
const U = {
  admin: 'decb0000-0000-4000-8000-000000000001',    // admin of A (org-wide)
  acc: 'decb0000-0000-4000-8000-000000000002',      // accountant of A (staff, not an ops writer)
  jed: 'decb0000-0000-4000-8000-000000000005',      // clearance_staff of A, JED only
  dmm: 'decb0000-0000-4000-8000-000000000006',      // clearance_staff of A, DMM only
  trn: 'decb0000-0000-4000-8000-000000000007',      // transport_staff of A, JED (staff, not an ops writer)
  portal: 'decb0000-0000-4000-8000-000000000008',   // client user of CLIENT_A
  stranger: 'decb0000-0000-4000-8000-000000000009', // no membership
  staffB: 'decb0000-0000-4000-8000-00000000000a'    // admin of B
};

/* ------------------------------------------------------------------ helpers */
let db;
// one simulated caller at a time (SET ROLE is per connection): concurrent as() calls queue up
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
// 'ok' | 'MRS_X detail' | 'chk:<constraint>' | 'uniq:<constraint>' | 'perm' | 'rls' | other text
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
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
let keySeq = 0;
const newKey = () => 'decbaaab-0000-4000-8000-' + String(++keySeq).padStart(12, '0');
let shaSeq = 0;
const sha = () => (++shaSeq).toString(16).padStart(64, 'c');

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
  const grants = (await q(`SELECT table_name || ':' || grantee || ':' || privilege_type x FROM information_schema.role_table_grants
                            WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','service_role') ORDER BY 1`)).map(x => x.x);
  const labels = (await q(`SELECT domain || '.' || code || ':' || sort || ':' || label_ar || ':' || client_visible x FROM public.status_labels ORDER BY 1`)).map(x => x.x);
  return { fns, tables, idx, trg, pol, con, cols, grants, labels };
}
const NEW_TABLES = ['public.doc_batch_documents', 'public.doc_batches', 'public.shipment_invoice_items', 'public.shipment_packing_items',
  'public.transaction_shipment_data'];
const NEW_FNS = ['app.ai_usage_source_ok', 'app.client_alias_learn', 'app.client_latin_key', 'app.cm_align', 'app.cm_ar_latin',
  'app.cm_ar_tokens', 'app.cm_lev', 'app.cm_phonetic', 'app.cm_score', 'app.cm_str_sim', 'app.cm_token_sim', 'app.consignee_identity_name',
  'app.doc_batch_compare', 'app.doc_batch_draft_check', 'app.doc_batch_json', 'app.doc_batch_lock', 'app.doc_batch_merge',
  'app.doc_batch_visible', 'app.doc_bl_no', 'app.doc_cmp_row', 'app.doc_draft_overlay',
  'app.doc_num', 'app.doc_obj_check', 'app.doc_reading_section', 'app.doc_val', 'app.extraction_detail_ok', 'app.party_aliases_ok',
  'app.seed_shipping_agents', 'app.shipping_agents_template', 'app.tg_legacy_docs_audit', 'app.tg_legacy_docs_guard',
  'app.tg_legacy_docs_no_delete', 'public.ai_bind_source', 'public.approve_doc_batch', 'public.archive_doc_batch', 'public.attach_doc_batch_document',
  'public.confirm_client_match', 'public.create_doc_batch', 'public.detach_doc_batch_document', 'public.discard_doc_batch',
  'public.get_doc_batch', 'public.get_transaction_shipment', 'public.list_pending_doc_batches', 'public.match_client_v2',
  'public.match_shipping_agent', 'public.merge_doc_batch', 'public.reject_client_alias', 'public.save_doc_batch_draft',
  'public.seed_shipping_agents'];
const RECREATED = ['app.convert_delete_guards', 'app.convert_delete_tables', 'app.extraction_field_keys', 'app.extraction_items_ok',
  'app.tg_ai_usage_guard', 'app.tg_audit', 'app.tg_document_extractions_before'];
const RPCS = ['approve_doc_batch', 'archive_doc_batch', 'attach_doc_batch_document', 'confirm_client_match', 'create_doc_batch',
  'detach_doc_batch_document', 'discard_doc_batch', 'get_doc_batch', 'get_transaction_shipment', 'list_pending_doc_batches',
  'match_client_v2', 'match_shipping_agent', 'merge_doc_batch', 'reject_client_alias', 'save_doc_batch_draft', 'seed_shipping_agents'];
const CODES = ['MRS_DOC_WRONG_SLOT', 'MRS_DOC_IN_OTHER_BATCH', 'MRS_DOC_BATCH_STATE', 'MRS_DOC_BATCH_STALE', 'MRS_CLIENT_ALIAS_CONFLICT'];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@legacydocs.example.com', now()), ('${U.acc}', 'acc@legacydocs.example.com', now()),
    ('${U.jed}', 'jed@legacydocs.example.com', now()), ('${U.dmm}', 'dmm@legacydocs.example.com', now()),
    ('${U.trn}', 'trn@legacydocs.example.com', now()), ('${U.portal}', 'portal@legacydocs.example.com', now()),
    ('${U.stranger}', 'stranger@legacydocs.example.com', now()), ('${U.staffB}', 'staffb@legacydocs.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.acc}', 'acc'), ('${U.jed}', 'jed'),
    ('${U.dmm}', 'dmm'), ('${U.trn}', 'trn'), ('${U.portal}', 'portal'), ('${U.stranger}', 'stranger'), ('${U.staffB}', 'staffB')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'legacydocs-org-b', 'مؤسسة ب', 'Legacy docs org B', 'LDB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', 'Client B Co', '0509990000');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.acc}', '${A}', NULL, 'accountant'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff'),
    ('${U.trn}', '${A}', '${JED}', 'transport_staff'), ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
// a saved reading (owner SQL; created_by = the user): an AI v3 reading when detail is given (ai_usage_id of a fake ok usage)
async function ext(o) {
  const x = Object.assign({ org: A, tx: null, kind: 'bill_of_lading', fields: {}, items: [], detail: null, by: 'jed', sha: sha(), engine: 'tesseract.js@5.1.1' }, o || {});
  let usage = null;
  if (x.detail) {
    usage = (await q(`INSERT INTO app.ai_usage (org_id, user_id, purpose, status, model, reserved_usd, cost_usd, input_tokens, output_tokens, settled_at)
                      VALUES ($1, $2, 'doc_extract', 'ok', 'claude-opus-5-5', 0.48, 0.01, 10, 10, now()) RETURNING id`, [x.org, U[x.by]]))[0].id;
  }
  return (await q(`INSERT INTO public.document_extractions (org_id, transaction_id, doc_type, source_name, source_sha256, engine, languages,
                     raw_text, extracted_fields, line_items, created_by, ai_usage_id, ai_detail)
                   VALUES ($1, $2, $3, 'doc.pdf', $4, $5, 'auto', 'x', $6, $7, $8, $9, $10) RETURNING id`,
    [x.org, x.tx, x.kind, x.sha, x.detail ? 'claude-opus-5-5' : x.engine, J(x.fields), J(x.items), U[x.by], usage, x.detail ? J(x.detail) : null]))[0].id;
}
const det = (type, containers) => ({ prompt_version: 'ai-doc-v3', detected_type: type, doc_type: type, containers: containers || [], fields: [], warnings: [] });
const mkBatch = (who, p, org) => rpc(who || 'jed', `SELECT public.create_doc_batch($1, $2) r`, [org || A, p || {}]);
const attach = (who, b, e, slot) => rpc(who || 'jed', `SELECT public.attach_doc_batch_document($1, $2) r`, [b, { extraction_id: e, slot }]);
const getB = (who, b) => rpc(who || 'jed', `SELECT public.get_doc_batch($1) r`, [b]);
const merge = (who, b) => rpc(who || 'jed', `SELECT public.merge_doc_batch($1) r`, [b]);
const saveD = (who, b, p) => rpc(who || 'jed', `SELECT public.save_doc_batch_draft($1, $2) r`, [b, p]);
const approve = (who, b, p) => rpc(who || 'jed', `SELECT public.approve_doc_batch($1, $2) r`, [b, p]);
const list = (who, f, org) => rpc(who || 'jed', `SELECT public.list_pending_doc_batches($1, $2) r`, [org || A, f || {}]);
const matchV2 = (who, p, org) => rpc(who || 'jed', `SELECT public.match_client_v2($1, $2) r`, [org || A, p]);
const confirm = (who, p, org) => rpc(who || 'jed', `SELECT public.confirm_client_match($1, $2) r`, [org || A, p]);
// a ready batch: B/L + invoice + packing list readings merged and saved
async function readyBatch(who, o) {
  const x = Object.assign({ bl: 'LDBL0000001', ctr: ['MSCU1234565'], seal: ['SL1001'], consignee: 'CONSIGNEE: TEST TRADING CO. ONE\nP.O. BOX 1 JEDDAH', tx: null, branchId: null }, o || {});
  const p = {};
  if (x.tx) p.transaction_id = x.tx;
  if (x.branchId) p.branch_id = x.branchId;
  const b = await mkBatch(who, p);
  const bl = await ext({ by: who || 'jed', kind: 'bill_of_lading', fields: { bl_number: x.bl, vessel: 'MSC TEST', voyage: '001A', port_of_loading: 'Shanghai',
    port_of_discharge: 'Jeddah Islamic Port', consignee: x.consignee, shipper: 'SHANGHAI SUPPLIER LTD', gross_weight: '1200', net_weight: '1000',
    packages_count: '40', package_type: 'CTNS', goods_description: 'Brake pads', shipping_line: 'MSC', container_numbers: x.ctr.join(', '),
    seal_numbers: x.seal.join(', ') }, detail: det('bill_of_lading', x.ctr.map((c, i) => ({ container_number: c, seal_number: x.seal[i] || null, size_type: '40HC',
    packages_count: 40, net_weight: 1000, gross_weight: 1200 }))) });
  const inv = await ext({ by: who || 'jed', kind: 'commercial_invoice', fields: { invoice_number: 'INV-1', invoice_date: '2026-10-01', supplier_name: 'SHANGHAI SUPPLIER LTD',
    buyer_name: 'TEST TRADING CO. ONE', currency: 'USD', total: '5000', incoterms: 'CFR Jeddah', country_of_origin: 'China', bl_number: x.bl,
    container_numbers: x.ctr.join(', ') }, items: [{ description: 'Brake pads', hs_code: '870830', quantity: 40, unit: 'CARTON', unit_price: 125, amount: 5000, net_weight: 1000 }],
    detail: det('commercial_invoice') });
  const pk = await ext({ by: who || 'jed', kind: 'packing_list', fields: { packing_list_number: 'PL-1', packages_count: '40', net_weight: '1000', gross_weight: '1200',
    bl_number: x.bl, seal_numbers: x.seal.join(', ') }, items: [{ description: 'Brake pads', packages: 40, net_weight: 1000, gross_weight: 1200,
    container_number: x.ctr[0], seal_number: x.seal[0] }], detail: det('packing_list') });
  await attach(who, b.id, bl, 'bill_of_lading');
  await attach(who, b.id, inv, 'commercial_invoice');
  await attach(who, b.id, pk, 'packing_list');
  const m = await merge(who, b.id);
  const cur = await getB(who, b.id);
  const s = await saveD(who, b.id, { version: cur.version, draft: m.draft });
  return { id: b.id, version: s.version, bl, inv, pk, draft: m.draft, batch: s };
}

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql, docs');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261118000100, schema_versions row, search_path = \'\' on every function', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h) && !/FUNCTION app\.(extraction_field_keys)\(/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261118000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261119000100', 'legacy_docs'\)/.test(src)
      && heads.length === NEW_FNS.length + RECREATED.length && bad.length === 0) || J({ n: heads.length, want: NEW_FNS.length + RECREATED.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('refusals through app.fail(\'MRS_*\') only (no RAISE EXCEPTION besides the guard / preflight)', () => {
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|LEGACY DOCS preflight/.test(r));
    const codes = src.match(/app\.fail\('([A-Z_]+)'/g) || [];
    return (raises.length === 0 && codes.length >= 60 && codes.every(c => /app\.fail\('MRS_[A-Z_]+'/.test(c))) || J({ raises: raises.length, codes: codes.length });
  });
  await check('every MRS code used has an Arabic message in supa.js and Arabic + English in i18n.js; the new codes are exactly the 5 of the header', () => {
    const used = [...new Set((src.match(/app\.fail\('(MRS_[A-Z_]+)'/g) || []).map(x => x.slice(10, -1)))].sort();
    const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
    const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
    const missing = used.filter(c => !new RegExp('\\b' + c + ':').test(supa) || (i18n.match(new RegExp('\\n\\s+' + c + ': ', 'g')) || []).length < 2);
    return (missing.length === 0 && CODES.every(c => used.includes(c) && new RegExp(c).test(src.slice(0, 6000)))) || 'missing: ' + missing.join(', ');
  });
  await check('no TRUNCATE / DROP TABLE / DROP FUNCTION / DISABLE TRIGGER / session_replication_role / DELETE; no key or endpoint', () => {
    const c = src.replace(/--.*$/gm, '');
    return (!/\bTRUNCATE\b/i.test(c) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA)/i.test(c) && !/DISABLE TRIGGER/i.test(c) && !/session_replication_role/.test(c)
      && !/\bDELETE\s+FROM\b/i.test(c) && !/sk-ant|api\.anthropic\.com|https?:\/\//i.test(src)) || 'body';
  });
  await check('no personal data / legacy organization name copied from the legacy code (no e-mail, phone number, real org name)', () =>
    (!/@[a-z0-9-]+\.[a-z]/i.test(src.replace(/--.*$/gm, '').replace(/@\[A-Z0-9\._%\+-\]\+/g, '')) && !/\b05[0-9]{8}\b/.test(src) && !/رأس الحكمة/.test(src)) || 'personal data');
  // later phases may follow this file (20261120000100 legacy_decl: re-creates extraction_field_keys / extraction_detail_ok / the conversion lists)
  const LATER_PHASES = ['20261120000100_legacy_decl.sql', '20261121000100_legacy_appt.sql', '20261122000100_legacy_pay.sql', '20261123000100_legacy_daftra.sql', '20261124000100_legacy_reports.sql', '20261125000100_legacy_import.sql', '20261126000100_doc_match_packing.sql'];
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
  await check('docs/online/LEGACY_DOCS_AR.md exists and names the migration, every RPC, the error codes, ai-doc-v3 and the draft rule', () => {
    const p = path.join(ROOT, 'docs', 'online', 'LEGACY_DOCS_AR.md');
    if (!fs.existsSync(p)) return 'missing';
    const d = fs.readFileSync(p, 'utf8');
    const miss = [MIG, 'ai-doc-v3', 'packing_list', 'مسودة'].concat(RPCS, CODES).filter(x => !d.includes(x));
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
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261118000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without legacy_tx: exact preflight message, nothing created', async () =>
        (msg.startsWith('LEGACY DOCS preflight: apply legacy_tx first (schema_versions lacks 20261118000100 legacy_tx)')
          && (await one(`SELECT to_regclass('public.doc_batches') IS NULL x`)).x && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261118000100', 'legacy_tx')`);
      // an existing org with an existing shipping agent «MSC» and a carrier named like an agent: no duplicates
      await db.exec(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${B}', 'pre-org', 'مؤسسة سابقة', 'PRE');
                     INSERT INTO public.parties (org_id, kinds, name_ar, name_en) VALUES ('${B}', ARRAY['shipping_agent'], 'وكيل إم إس سي', 'MSC'),
                                                                                       ('${B}', ARRAY['carrier'], 'ميرسك', NULL);`);
      const r1 = await tryErr(() => db.exec(src));
      await check('applies on an existing org: 13 agents added; the existing «MSC» agent gets its aliases (no second MSC); the carrier «ميرسك» is not duplicated', async () => {
        const agents = await num(`SELECT count(*) n FROM public.parties WHERE org_id = $1 AND 'shipping_agent' = ANY (kinds)`, [B]);
        const msc = await q(`SELECT name_ar, aliases FROM public.parties WHERE org_id = $1 AND (name_en = 'MSC' OR name_ar = 'إم إس سي')`, [B]);
        const maersk = await num(`SELECT count(*) n FROM public.parties WHERE org_id = $1 AND (name_ar = 'ميرسك' OR name_en = 'Maersk')`, [B]);
        return (r1 === 'ok' && agents === 14 && msc.length === 1 && msc[0].aliases.includes('MEDITERRANEAN SHIPPING COMPANY') && maersk === 1) || J({ r1, agents, msc, maersk });
      });
      const C1 = await catalog();
      const parties1 = await num(`SELECT count(*) n FROM public.parties`);
      const audit1 = await num(`SELECT count(*) n FROM public.audit_log`);
      const r3 = await tryErr(() => db.exec(src));
      await check('re-runs on top of itself with an identical catalog (functions, ACLs, indexes, triggers, policies, constraints, columns, grants, labels); no data', async () =>
        (r3 === 'ok' && J(C1) === J(await catalog()) && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261119000100'`)) === 1
          && (await num(`SELECT count(*) n FROM public.parties`)) === parties1 && (await num(`SELECT count(*) n FROM public.audit_log`)) === audit1) || r3);
      const s0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the new functions and tables; the re-created ones listed (ACL / definer / config kept)', () => {
        const nm = s => s.split('(')[0];
        const added = [...new Set(C1.fns.filter(f => !s0.has(f.sig)).map(f => nm(f.sig)))].sort();
        const changed = C1.fns.filter(f => s0.has(f.sig) && s0.get(f.sig).h !== f.h).map(f => nm(f.sig)).sort();
        const keep = C1.fns.filter(f => s0.has(f.sig) && RECREATED.includes(nm(f.sig)))
          .every(f => s0.get(f.sig).acl === f.acl && s0.get(f.sig).d === f.d && s0.get(f.sig).c === f.c);
        const tbl = C1.tables.filter(t => !C0.tables.includes(t)).sort();
        return (J(added) === J(NEW_FNS.slice().sort()) && J(changed) === J(RECREATED) && keep && J(tbl) === J(NEW_TABLES)) || J({ added, changed, tbl });
      });
      await check('catalog: new columns are document_extractions.ai_detail and parties.aliases (+ the 5 tables); no other table touched', () => {
        const cols = C1.cols.filter(c => !C0.cols.includes(c) && !NEW_TABLES.some(t => c.startsWith(t.split('.')[1] + '.'))).sort();
        return J(cols) === J(['document_extractions.ai_detail', 'parties.aliases']) || J(cols);
      });
      await check('catalog: anon / authenticated grants on the new tables are SELECT for authenticated only', () => {
        const g = C1.grants.filter(x => !C0.grants.includes(x));
        const api = g.filter(x => !/:service_role:/.test(x));
        return (api.length === 5 && api.every(x => /:authenticated:SELECT$/.test(x))) || J(api);
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. readings */
async function secReadings() {
  section('3. readings: ai-doc-v3 keys, items, ai_detail');
  await check('app.extraction_field_keys() = extract.js ALL_KEYS_V3 (66 keys with the 8 declaration keys of 20261120000100 and the 16 card / EIR keys of 20261121000100, the v2 keys first, order kept)', async () => {
    const k = (await one(`SELECT app.extraction_field_keys() k`)).k;
    return (J(k) === J(XJS.ALL_KEYS_V3) && k.length === 66 && J(k.slice(0, 28)) === J(XJS.ALL_KEYS)) || J(k);
  });
  await check('line items: the v3 item keys of extract.js are accepted, an unknown key is refused (CHECK)', async () => {
    const it = {}; XJS.ITEM_KEYS_V3.forEach(k => { it[k] = k === 'description' ? 'x' : 1; });
    const okR = (await one(`SELECT app.extraction_items_ok($1) x`, [J([it])])).x;
    const bad = (await one(`SELECT app.extraction_items_ok($1) x`, [J([{ description: 'x', colour: 'red' }])])).x;
    return (okR === true && bad === false) || J({ okR, bad });
  });
  await check('ai_detail shape: extract.js postProcess v3 output passes; bad version / type / container key / size refused', async () => {
    const out = XJS.postProcess({ doc_type: 'packing_list', fields: [{ name: 'packing_list_number', value: 'PL-9', confidence: 0.9, page: 1 }],
      line_items: [{ description: 'x', hs_code: null, quantity: null, unit_price: null, amount: null, unit: null, scientific_name: null, origin_country: null,
        net_weight: 10, gross_weight: 11, packages: 2, container_number: 'MSCU1234565', seal_number: 'S1', notes: null }],
      containers: [{ container_number: 'MSCU1234565', seal_number: 'S1', size_type: '40HC', packages_count: 2, net_weight: 10, gross_weight: 11 }], warnings: [] }, 'packing_list', 'ai-doc-v3');
    const t = async v => (await one(`SELECT app.extraction_detail_ok($1) x`, [v === null ? null : J(v)])).x;
    const good = await t(out.ai_detail);
    const bads = await Promise.all([{ prompt_version: 'v3' }, { prompt_version: 'ai-doc-v3', detected_type: 'passport' },
      { prompt_version: 'ai-doc-v3', containers: [{ container_number: 'X', colour: 'red' }] }, { prompt_version: 'ai-doc-v3', extra: 1 },
      { prompt_version: 'ai-doc-v3', containers: Array.from({ length: 301 }, () => ({ container_number: 'MSCU1234565' })) }].map(t));
    return (good === true && (await t(null)) === true && bads.every(x => x === false) && out.kind === 'packing_list') || J({ good, bads });
  });
  await check('API insert: ai_detail without an AI reading (no ai_usage_id) → MRS_INVALID ai_detail', async () =>
    (await code(() => as('jed', `INSERT INTO public.document_extractions (org_id, doc_type, source_name, source_sha256, engine, languages, raw_text, created_by, ai_detail)
      VALUES ($1, 'bill_of_lading', 'x.pdf', $2, 'tesseract.js@5.1.1', 'eng', 'x', $3, $4)`, [A, sha(), U.jed, J(det('bill_of_lading'))]))) === 'MRS_INVALID ai_detail');
  const e1 = await ext({ detail: det('bill_of_lading', [{ container_number: 'MSCU1234565', seal_number: 'S1' }]), fields: { bl_number: 'AIDBL1' } });
  await check('API update: ai_detail is immutable (MRS_IMMUTABLE ai_detail); review columns still editable', async () => {
    const a = await code(() => as('jed', `UPDATE public.document_extractions SET ai_detail = $2 WHERE id = $1`, [e1, J(det('packing_list'))]));
    const b = await code(() => as('jed', `UPDATE public.document_extractions SET review_note = 'checked' WHERE id = $1`, [e1]));
    return (/MRS_IMMUTABLE ai_detail/.test(a) && b === 'ok') || J({ a, b });
  });
  await check('the audit trail of document_extractions carries no ai_detail (nor the OCR content)', async () => {
    const r = await q(`SELECT new_data FROM public.audit_log WHERE table_name = 'document_extractions' AND row_id = $1`, [e1]);
    return (r.length >= 1 && r.every(x => !('ai_detail' in (x.new_data || {})) && !('extracted_fields' in (x.new_data || {})))) || J(r);
  });
}

/* ================================================================== 4. parties / agents / names */
async function secAgents() {
  section('4. shipping agents, identity name, Latin client key');
  await check('seed_shipping_agents: org admin only (jed / staffB on A / portal → MRS_FORBIDDEN role)', async () => {
    const r = await Promise.all(['jed', 'staffB', 'portal'].map(w => code(() => rpc(w, `SELECT public.seed_shipping_agents($1) r`, [A]))));
    return r.every(x => x === 'MRS_FORBIDDEN role') || J(r);
  });
  let s1, s2;
  await check('seed_shipping_agents (admin): 15 legacy agents added once; a second run adds nothing (idempotent)', async () => {
    s1 = await rpc('admin', `SELECT public.seed_shipping_agents($1) r`, [A]);
    s2 = await rpc('admin', `SELECT public.seed_shipping_agents($1) r`, [A]);
    const n = await num(`SELECT count(*) n FROM public.parties WHERE org_id = $1 AND 'shipping_agent' = ANY (kinds)`, [A]);
    return (s1.added === 15 && s2.added === 0 && n === 15) || J({ s1, s2, n });
  });
  await check('the agent list = MarsaNorm.AGENTS (legacy defaultShippingAgents) with Arabic names and aliases', async () => {
    const norm = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'legacy-norm.js'), 'utf8');
    const m = /var AGENTS = \[([\s\S]*?)\];/.exec(norm);
    const want = m ? m[1].match(/'([^']+)'/g).map(x => x.slice(1, -1)) : [];
    const got = (await q(`SELECT name_en FROM app.shipping_agents_template() ORDER BY sort`)).map(x => x.name_en);
    const al = await num(`SELECT count(*) n FROM app.shipping_agents_template() WHERE cardinality(aliases) >= 1 AND name_ar ~ '[ء-ي]'`);
    return (J(got) === J(want) && al === 15) || J({ got, want });
  });
  await check('match_shipping_agent: long legal name → alias hit; short name → name hit; a sentence containing it → contains; staff only', async () => {
    const a = await rpc('jed', `SELECT public.match_shipping_agent($1, $2) r`, [A, 'Mediterranean Shipping Company S.A.']);
    const b = await rpc('jed', `SELECT public.match_shipping_agent($1, $2) r`, [A, 'msc']);
    const c = await rpc('jed', `SELECT public.match_shipping_agent($1, $2) r`, [A, 'As agent for HAPAG-LLOYD AG, Hamburg']);
    const p = await code(() => rpc('portal', `SELECT public.match_shipping_agent($1, $2) r`, [A, 'msc']));
    return (a[0] && a[0].name_en === 'MSC' && b[0].match === 'name' && b[0].name_en === 'MSC' && c.some(x => x.name_en === 'Hapag-Lloyd')
      && p === 'MRS_FORBIDDEN org') || J({ a, b, c, p });
  });
  await check('parties.aliases CHECK: ≤ 20 aliases of 2–160 chars', async () =>
    (await code(() => q(`UPDATE public.parties SET aliases = ARRAY['x'] WHERE org_id = $1 AND name_en = 'MSC'`, [A]))) === 'chk:parties_aliases_chk');
  const SAMPLES = ['CONSIGNEE: ABC TRADING CO. LTD\nP.O. BOX 1234 JEDDAH\nVAT 300000000000003', 'TEST TRADING CO. ONE, 1234 KING FAHD ROAD, JEDDAH',
    'شركة الاختبار الأولى للتجارة\nجدة - المملكة العربية السعودية\nTEL +966 12 000 0000', 'TO ORDER OF\nAL NOOR EST.\nNOTIFY: SAME AS CONSIGNEE',
    'XYZ IMPORTS LLC CR NO 7000000001 RIYADH', 'BUYER - GOLDEN FOODS COMPANY | ADDRESS: DAMMAM', 'MAJOR & SONS TRADING\nEMAIL: info@major.example',
    'single'];
  await check('app.consignee_identity_name = extract.js identityName on ' + SAMPLES.length + ' address blocks (legacy extractCustomerIdentityName_)', async () => {
    const diffs = [];
    for (const s of SAMPLES) {
      const sql = (await one(`SELECT app.consignee_identity_name($1) v`, [s])).v;
      const js = XJS.identityName(s) || null;
      if (sql !== js) diffs.push(J({ s, sql, js }));
    }
    return (diffs.length === 0 && XJS.identityName(SAMPLES[0]) === 'ABC TRADING CO. LTD' && XJS.identityName(SAMPLES[3]) === 'TO ORDER OF AL NOOR EST.') || diffs.join(' | ');
  });
  await check('app.client_latin_key: legacy normalizeCustomerLatinName_ (& → AND, company words dropped)', async () => {
    const r = (await one(`SELECT app.client_latin_key('Al-Noor Trading Co. Ltd & Sons') a, app.client_latin_key('Test Trading Co. One') b, app.client_latin_key(NULL) c`));
    return (r.a === 'AL NOOR AND SONS' && r.b === 'TEST ONE' && r.c === null) || J(r);
  });
}

/* ================================================================== 5. batches */
async function secBatches() {
  section('5. doc batches: create, attach (wrong-slot guard), detach, merge, save, list, discard, archive');
  await check('create: ops writers only (accountant / transport staff / portal / stranger / other org → MRS_FORBIDDEN role)', async () => {
    const r = await Promise.all([['acc', A], ['trn', A], ['portal', A], ['stranger', A], ['staffB', A]].map(([w, o]) => code(() => mkBatch(w, {}, o))));
    return r.every(x => x === 'MRS_FORBIDDEN role') || J(r);
  });
  await check('create: the branch — jed → JED; an org-wide admin with two branches must name one (MRS_REQUIRED branch_id); a transaction gives its branch', async () => {
    const a = await mkBatch('jed');
    const b = await code(() => mkBatch('admin'));
    const c = await mkBatch('admin', { branch_id: DMM });
    const d = await mkBatch('admin', { transaction_id: TX_JED });
    const e = await code(() => mkBatch('dmm', { branch_id: JED }));
    const f = await code(() => mkBatch('dmm', { transaction_id: TX_JED }));
    return (a.branch_id === JED && a.status === 'draft' && a.version === 1 && b === 'MRS_REQUIRED branch_id' && c.branch_id === DMM
      && d.branch_id === JED && d.transaction_id === TX_JED && d.transaction_ref && e === 'MRS_FORBIDDEN branch' && f === 'MRS_NOT_FOUND transaction'
      && a.slots.bill_of_lading === 0 && a.slots.packing_list === 0 && Array.isArray(a.documents)) || J({ a: [a.branch_id, a.status, a.version, a.slots], b, c: c.branch_id, d: [d.branch_id, d.transaction_id, d.transaction_ref], e, f });
  });
  await check('create: unknown key → MRS_INVALID unknown_key; idempotency key replays the same batch', async () => {
    const a = await code(() => mkBatch('jed', { colour: 1 }));
    const k = newKey();
    const b1 = await mkBatch('jed', { idempotencyKey: k });
    const b2 = await mkBatch('jed', { idempotencyKey: k });
    return (a === 'MRS_INVALID unknown_key' && b1.id === b2.id && b2.replayed === true) || J({ a, b1: b1.id, b2 });
  });
  const b = await mkBatch('jed');
  const blE = await ext({ kind: 'bill_of_lading', fields: { bl_number: 'SLOTBL1' }, detail: det('bill_of_lading') });
  const invAsBl = await ext({ kind: 'bill_of_lading', fields: { invoice_number: 'X' }, detail: det('commercial_invoice') });
  const ocrInv = await ext({ kind: 'commercial_invoice', fields: { invoice_number: 'OCR-1' } });
  await check('wrong-slot guard: a B/L reading in the invoice slot → MRS_DOC_WRONG_SLOT commercial_invoice:bill_of_lading', async () =>
    (await code(() => attach('jed', b.id, blE, 'commercial_invoice'))) === 'MRS_DOC_WRONG_SLOT commercial_invoice:bill_of_lading');
  await check('wrong-slot guard on the DETECTED type: saved as a B/L but Claude detected an invoice → MRS_DOC_WRONG_SLOT bill_of_lading:commercial_invoice', async () =>
    (await code(() => attach('jed', b.id, invAsBl, 'bill_of_lading'))) === 'MRS_DOC_WRONG_SLOT bill_of_lading:commercial_invoice');
  await check('attach: the right slot works (AI v3 and OCR readings); the same reading again → already_attached, no second row', async () => {
    const a1 = await attach('jed', b.id, blE, 'bill_of_lading');
    const a2 = await attach('jed', b.id, blE, 'bill_of_lading');
    const a3 = await attach('jed', b.id, ocrInv, 'commercial_invoice');
    const n = await num(`SELECT count(*) n FROM public.doc_batch_documents WHERE batch_id = $1`, [b.id]);
    return (a1.document.slot === 'bill_of_lading' && a1.document.seq === 1 && a1.already_attached === false && a2.already_attached === true
      && a3.document.detected_type === 'commercial_invoice' && n === 2 && a3.batch.slots.commercial_invoice === 1) || J({ a1, a2, a3, n });
  });
  await check('attach: capacity — a second B/L → MRS_INVALID slot_full; an unknown slot → MRS_INVALID slot', async () => {
    const e2 = await ext({ kind: 'bill_of_lading', fields: { bl_number: 'SLOTBL2' } });
    const a = await code(() => attach('jed', b.id, e2, 'bill_of_lading'));
    const c = await code(() => attach('jed', b.id, e2, 'passport'));
    return (a === 'MRS_INVALID slot_full' && c === 'MRS_INVALID slot') || J({ a, c });
  });
  await check('attach: a reading already in another open batch → MRS_DOC_IN_OTHER_BATCH; the same file twice in one batch → MRS_INVALID duplicate_file', async () => {
    const b2 = await mkBatch('jed');
    const a = await code(() => attach('jed', b2.id, blE, 'bill_of_lading'));
    const s = sha();
    const x1 = await ext({ kind: 'packing_list', sha: s });
    const x2 = await ext({ kind: 'packing_list', sha: s, tx: TX_JED });
    await attach('jed', b2.id, x1, 'packing_list');
    const c = await code(() => attach('jed', b2.id, x2, 'packing_list'));
    return (a === 'MRS_DOC_IN_OTHER_BATCH' && c === 'MRS_INVALID duplicate_file') || J({ a, c });
  });
  await check('attach: voided reading → MRS_MATCH_DOC_VOIDED; reading of another org / of a branch the caller cannot read → MRS_NOT_FOUND extraction', async () => {
    const v = await ext({ kind: 'packing_list' });
    await q(`UPDATE public.document_extractions SET voided_at = now(), void_reason = 'x' WHERE id = $1`, [v]);
    const xb = await ext({ org: B, kind: 'packing_list', by: 'staffB' });
    const xd = await ext({ kind: 'packing_list', tx: TX_DMM, by: 'dmm' });
    const r = await Promise.all([code(() => attach('jed', b.id, v, 'packing_list')), code(() => attach('jed', b.id, xb, 'packing_list')),
      code(() => attach('jed', b.id, xd, 'packing_list'))]);
    return J(r) === J(['MRS_MATCH_DOC_VOIDED extraction', 'MRS_NOT_FOUND extraction', 'MRS_NOT_FOUND extraction']) || J(r);
  });
  await check('attach: a batch without a transaction adopts the reading\'s; a reading of another transaction then → MRS_INVALID transaction_id', async () => {
    const b3 = await mkBatch('jed');
    const x1 = await ext({ kind: 'bill_of_lading', tx: TX_JED });
    const r1 = await attach('jed', b3.id, x1, 'bill_of_lading');
    const tx2 = (await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea') RETURNING id`, [A, JED, CLIENT_A]))[0].id;
    const x2 = await ext({ kind: 'packing_list', tx: tx2 });
    const r2 = await code(() => attach('jed', b3.id, x2, 'packing_list'));
    return (r1.batch.transaction_id === TX_JED && r2 === 'MRS_INVALID transaction_id') || J({ r1: r1.batch, r2 });
  });
  await check('detach: void-only (the row stays, detached_at set, the slot frees up); detaching twice → MRS_NOT_FOUND; DELETE refused', async () => {
    const g = await getB('jed', b.id);
    const docId = g.documents.find(x => x.slot === 'commercial_invoice').id;
    const r = await rpc('jed', `SELECT public.detach_doc_batch_document($1, 'wrong file') r`, [docId]);
    const again = await code(() => rpc('jed', `SELECT public.detach_doc_batch_document($1, 'x') r`, [docId]));
    const row = await one(`SELECT detached_at IS NOT NULL d, detach_reason FROM public.doc_batch_documents WHERE id = $1`, [docId]);
    const del = await code(() => q(`DELETE FROM public.doc_batch_documents WHERE id = $1`, [docId]));
    return (r.batch.slots.commercial_invoice === 0 && again === 'MRS_NOT_FOUND doc_batch_document' && row.d && row.detach_reason === 'wrong file'
      && del === 'MRS_APPEND_ONLY doc_batch_documents') || J({ r, again, row, del });
  });

  // merge
  const mb = await mkBatch('jed');
  const mBl = await ext({ kind: 'bill_of_lading', fields: { bl_number: 'MRGBL1', consignee: 'CONSIGNEE: TEST TRADING CO. ONE\nP.O. BOX 1 JEDDAH', vessel: 'MSC A',
    gross_weight: '1,200', packages_count: '40', container_numbers: 'MSCU1234565', seal_numbers: 'SL1' },
    detail: det('bill_of_lading', [{ container_number: 'MSCU1234565', seal_number: 'SL1', size_type: '40 HIGH CUBE', gross_weight: 1200 }]) });
  const mI1 = await ext({ kind: 'commercial_invoice', fields: { invoice_number: 'I-1', currency: 'USD', total: '100', container_numbers: 'TGHU1234560' },
    items: [{ description: 'A', quantity: 1, amount: 100 }], detail: det('commercial_invoice') });
  const mI2 = await ext({ kind: 'commercial_invoice', fields: { invoice_number: 'I-2', currency: 'EUR' }, items: [{ description: 'B', quantity: 2, amount: 50 }] });
  await attach('jed', mb.id, mBl, 'bill_of_lading'); await attach('jed', mb.id, mI1, 'commercial_invoice'); await attach('jed', mb.id, mI2, 'commercial_invoice');
  await q(`UPDATE public.document_extractions SET reviewed_fields = '{"vessel":"MSC REVIEWED"}' WHERE id = $1`, [mBl]);
  let M;
  await check('merge: B/L → shipment (staff-reviewed field wins, identity name derived, numbers parsed), containers by number incl. one only on an invoice, size / type cut to 10', async () => {
    M = await merge('jed', mb.id);
    const s = M.draft.shipment;
    return (s.bl_number === 'MRGBL1' && s.vessel === 'MSC REVIEWED' && s.consignee_name === 'TEST TRADING CO. ONE' && s.gross_weight === 1200 && s.packages_count === 40
      && s.containers.length === 2 && s.containers[0].container_number === 'MSCU1234565' && s.containers[0].seal_number === 'SL1'
      && s.containers[0].size_type === '40 HIGH CU' && s.containers[1].container_number === 'TGHU1234560' && M.version === 1) || J(M.draft);
  });
  await check('merge: two invoices — items joined (invoice_number on each line), a later non-empty value wins, the disagreement is a merge conflict', async () => {
    const iv = M.draft.invoice;
    const c = M.merge_conflicts.filter(x => x.section === 'invoice').map(x => x.field).sort();
    return (iv.items.length === 2 && iv.items[0].invoice_number === 'I-1' && iv.items[1].invoice_number === 'I-2' && iv.items[1].total === 50
      && iv.invoice_number === 'I-2' && iv.currency === 'EUR' && J(c) === J(['currency', 'invoice_number'])
      && M.merge_conflicts[0].values[0].slot === 'commercial_invoice') || J({ iv, mc: M.merge_conflicts });
  });
  await check('merge: the merged draft passes the draft check and comes with its comparison; merge is read-only (version unchanged)', async () => {
    const bad = (await one(`SELECT app.doc_batch_draft_check($1) x`, [J(M.draft)])).x;
    const g = await getB('jed', mb.id);
    return (bad === null && M.comparison.engine === 'batch-v1' && Array.isArray(M.comparison.missing_fields) && g.version === 1 && J(g.draft) === '{}') || J({ bad, v: g.version });
  });
  await check('save: optimistic version (stale → MRS_DOC_BATCH_STALE), version + 1, comparison recomputed, bl / importer / container count from the draft', async () => {
    const s = await saveD('jed', mb.id, { version: 1, draft: M.draft });
    const stale = await code(() => saveD('jed', mb.id, { version: 1, draft: M.draft }));
    const noV = await code(() => saveD('jed', mb.id, { draft: M.draft }));
    return (s.version === 2 && s.bl_number === 'MRGBL1' && s.importer_name === 'TEST TRADING CO. ONE' && s.container_count === 2
      && s.comparison.engine === 'batch-v1' && stale === 'MRS_DOC_BATCH_STALE' && noV === 'MRS_REQUIRED version') || J({ s, stale, noV });
  });
  await check('save: draft shape refused — unknown section, unknown key, text in a number, bad container number, bad date, negative weight, too many items', async () => {
    const cases = [[{ passport: {} }, 'draft.unknown_key'], [{ shipment: { colour: 'x' } }, 'draft.shipment.colour'],
      [{ shipment: { gross_weight: 'heavy' } }, 'draft.shipment.gross_weight'], [{ shipment: { containers: [{ container_number: 'BAD' }] } }, 'draft.shipment.containers'],
      [{ invoice: { invoice_date: '01/10/2026' } }, 'draft.invoice.invoice_date'], [{ packing: { total_net_weight: -1 } }, 'draft.packing.total_net_weight'],
      [{ invoice: { items: Array.from({ length: 501 }, () => ({ description: 'x' })) } }, 'draft.invoice.items'],
      [{ invoice: { items: [{ description: 'x', colour: 1 }] } }, 'draft.invoice.items'], [{ source_notes: [1] }, 'draft.source_notes']];
    const got = [];
    for (const [d, want] of cases) {
      const c = await code(() => saveD('jed', mb.id, { version: 2, draft: d }));
      if (c !== 'MRS_INVALID ' + want) got.push(want + ' → ' + c);
    }
    const t = await code(() => saveD('jed', mb.id, { version: 2, draft: { shipment: { temperature_c: -18 } }, client_id: CL_B }));
    return (got.length === 0 && t === 'MRS_NOT_FOUND client') || got.join(' | ') + ' / ' + t;
  });
  await check('list_pending_doc_batches: branch scoping (dmm sees no JED draft, admin sees both), status filter, org B sees none of A', async () => {
    const jed = await list('jed');
    const dmm = await list('dmm');
    const adm = await list('admin', { status: 'draft', limit: 200 });
    const appr = await list('jed', { status: 'approved' });
    const bad = await code(() => list('jed', { status: 'lost' }));
    const forB = await code(() => list('staffB', {}, A));
    return (jed.some(x => x.id === mb.id) && !dmm.some(x => x.branch_id === JED) && adm.some(x => x.branch_id === DMM) && adm.some(x => x.id === mb.id)
      && appr.length === 0 && bad === 'MRS_INVALID status' && forB === 'MRS_FORBIDDEN org'
      && jed.find(x => x.id === mb.id).document_count === 3 && jed.find(x => x.id === mb.id).created_by_name === 'jed') || J({ jed: jed.length, dmm, bad, forB });
  });
  await check('get_doc_batch: other branch / other org / portal → MRS_NOT_FOUND doc_batch; the full view lists the documents in slot order', async () => {
    const r = await Promise.all(['dmm', 'staffB', 'portal'].map(w => code(() => getB(w, mb.id))));
    const g = await getB('admin', mb.id);
    return (r.every(x => x === 'MRS_NOT_FOUND doc_batch') && J(g.documents.map(d => d.slot + d.seq)) === J(['bill_of_lading1', 'commercial_invoice1', 'commercial_invoice2'])
      && g.documents[1].prompt_version === 'ai-doc-v3' && g.documents[2].prompt_version === null) || J({ r, docs: g.documents });
  });
  await check('discard: reason required; draft → discarded; then attach / save / approve → MRS_DOC_BATCH_STATE discarded; archive → archived; archived is final', async () => {
    const x = await mkBatch('jed');
    const noWhy = await code(() => rpc('jed', `SELECT public.discard_doc_batch($1, '') r`, [x.id]));
    const d = await rpc('jed', `SELECT public.discard_doc_batch($1, 'duplicate upload') r`, [x.id]);
    const s = await code(() => saveD('jed', x.id, { version: 1, draft: {} }));
    const ap = await code(() => approve('jed', x.id, { version: 1, transaction_id: TX_JED }));
    const ar = await rpc('jed', `SELECT public.archive_doc_batch($1, 'old') r`, [x.id]);
    const ar2 = await code(() => rpc('jed', `SELECT public.archive_doc_batch($1, 'again') r`, [x.id]));
    const del = await code(() => q(`DELETE FROM public.doc_batches WHERE id = $1`, [x.id]));
    return (noWhy === 'MRS_NOTE_REQUIRED reason' && d.status === 'discarded' && d.close_reason === 'duplicate upload' && s === 'MRS_DOC_BATCH_STATE discarded'
      && ap === 'MRS_DOC_BATCH_STATE discarded' && ar.status === 'archived' && ar2 === 'MRS_DOC_BATCH_STATE archived' && del === 'MRS_APPEND_ONLY doc_batches') || J({ noWhy, d, s, ap, ar, ar2, del });
  });
  await check('roles: accountant / transport staff can read a JED batch but not change it (MRS_FORBIDDEN role)', async () => {
    const g = await getB('trn', mb.id);
    const r = await Promise.all([code(() => saveD('acc', mb.id, { version: 2, draft: {} })), code(() => rpc('trn', `SELECT public.discard_doc_batch($1, 'x') r`, [mb.id])),
      code(() => approve('acc', mb.id, { version: 2, transaction_id: TX_JED }))]);
    return (g.id === mb.id && r.every(x => x === 'MRS_FORBIDDEN role')) || J(r);
  });
}

/* ================================================================== 6. comparison */
async function secCompare() {
  section('6. comparison (legacy buildDocumentComparison_ + seals / containers as sets + missing fields)');
  const cmp = d => one(`SELECT app.doc_batch_compare($1) c`, [J(d)]).then(r => r.c);
  await check('B/L number: B/L + invoice + packing list equal through the legacy search key → match; one differs → conflict', async () => {
    const a = await cmp({ shipment: { bl_number: 'MEDU 123' }, invoice: { bl_number: 'medu-123' }, packing: { bl_number: 'MEDU123' } });
    const b = await cmp({ shipment: { bl_number: 'MEDU123' }, invoice: { bl_number: 'MEDU124' } });
    return (a.matches.some(x => x.field === 'bl_number') && b.conflicts.some(x => x.field === 'bl_number' && x.values.bl === 'MEDU123')) || J({ a, b });
  });
  await check('one source only → no row (a field needs ≥ 2 values); numbers rounded to 3 decimals; 0 counts as absent', async () => {
    const a = await cmp({ shipment: { bl_number: 'X' } });
    const b = await cmp({ shipment: { gross_weight: 1200.0004 }, packing: { total_gross_weight: 1200 } });
    const c = await cmp({ shipment: { gross_weight: 0 }, packing: { total_gross_weight: 5 } });
    return (!a.matches.concat(a.conflicts).some(x => x.field === 'bl_number') && b.matches.some(x => x.field === 'gross_weight')
      && !c.matches.concat(c.conflicts).some(x => x.field === 'gross_weight')) || J({ a, b, c });
  });
  await check('seals / containers as sets: the invoice naming one of the B/L seals → match; a seal not on the B/L → conflict', async () => {
    const d = { shipment: { containers: [{ container_number: 'MSCU1234565', seal_number: 'S1' }, { container_number: 'TGHU1234560', seal_number: 'S2' }] },
      invoice: { seal_numbers: ['S2'], container_numbers: ['MSCU1234565'] }, packing: { items: [{ description: 'x', seal_number: 'S9' }] } };
    const a = await cmp(d);
    return (a.conflicts.some(x => x.field === 'seal_numbers') && a.matches.some(x => x.field === 'container_numbers')) || J(a);
  });
  await check('legacy derived values: invoice net weight = sum of item net weights; invoice packages = cartons; consignee ↔ buyer; shipper ↔ seller', async () => {
    const a = await cmp({ shipment: { net_weight: 30, packages_count: 5, consignee_name: 'ABC CO', shipper: 'S LTD' },
      invoice: { buyer: 'abc co', seller: 'OTHER', items: [{ description: 'a', net_weight: 10, quantity: 2, unit: 'CARTON' }, { description: 'b', net_weight: 20, quantity: 3, unit: 'CTNS' }] } });
    const f = s => a[s].map(x => x.field).sort();
    return (J(f('matches')) === J(['consignee_buyer', 'net_weight', 'packages_count']) && J(f('conflicts')) === J(['shipper_seller'])) || J(a);
  });
  await check('missing-fields checklist (legacy order): an empty draft misses all 14; a full one misses none', async () => {
    const a = await cmp({});
    const full = { shipment: { consignee: 'X', bl_number: 'B', goods_description: 'G', packages_count: 1, net_weight: 1, gross_weight: 2,
      containers: [{ container_number: 'MSCU1234565' }] }, invoice: { invoice_number: 'I', invoice_date: '2026-01-01', currency: 'USD', total: 1, incoterms: 'FOB',
      items: [{ description: 'x' }] }, packing: { items: [{ description: 'x' }] } };
    const b = await cmp(full);
    return (J(a.missing_fields) === J(['consignee', 'bl_number', 'container_number', 'goods_description', 'packages_count', 'net_weight', 'gross_weight',
      'invoice_number', 'invoice_date', 'currency', 'total', 'incoterms', 'invoice_items', 'packing_items']) && b.missing_fields.length === 0) || J({ a, b });
  });
}

/* ================================================================== 7. approve */
async function secApprove() {
  section('7. approve_doc_batch: new / existing transaction, duplicate guard, items, alias, idempotency, frozen batch');
  // new transaction from the draft
  const r1 = await readyBatch('jed');
  let A1, K1;
  await check('approve → new transaction: client required (MRS_REQUIRED client_id), inactive / foreign client → MRS_NOT_FOUND client', async () => {
    const a = await code(() => approve('jed', r1.id, { version: r1.version, new_transaction: {} }));
    const b = await code(() => approve('jed', r1.id, { version: r1.version, new_transaction: { client_id: CL_B } }));
    const c = await code(() => approve('jed', r1.id, { version: r1.version }));
    const d = await code(() => approve('jed', r1.id, { version: r1.version + 5, new_transaction: { client_id: CLIENT_A } }));
    return (a === 'MRS_REQUIRED client_id' && b === 'MRS_NOT_FOUND client' && c === 'MRS_REQUIRED transaction_id' && d === 'MRS_DOC_BATCH_STALE') || J({ a, b, c, d });
  });
  await check('approve → new transaction: ref generated, status new, branch of the batch, the chosen client kept, columns filled from the draft, port inferred (SAJED)', async () => {
    K1 = newKey();
    A1 = await approve('jed', r1.id, { version: r1.version, new_transaction: { client_id: CLIENT_A }, idempotencyKey: K1 });
    const t = await one(`SELECT * FROM public.transactions WHERE id = $1`, [A1.transaction_id]);
    return (A1.status === 'approved' && A1.created_transaction === true && /^MRS-/.test(A1.ref) && t.operational_status === 'new' && t.branch_id === JED
      && t.client_id === CLIENT_A && t.bl_number === 'LDBL0000001' && t.port_code === 'SAJED' && t.goods_description === 'Brake pads' && t.package_count === 40
      && t.created_by === U.jed && A1.tx_filled.includes('port_code') && A1.tx_kept.length === 0) || J({ A1, t });
  });
  await check('approve → B/L created through save_bl and linked as primary (vessel, voyage, ports, weight, carrier)', async () => {
    const bl = await one(`SELECT b.*, tb.is_primary FROM public.bills_of_lading b JOIN public.transaction_bls tb ON tb.bl_id = b.id WHERE tb.transaction_id = $1`, [A1.transaction_id]);
    return (A1.bl.created === true && A1.bl.is_primary === true && bl.bl_number === 'LDBL0000001' && bl.vessel === 'MSC TEST' && bl.voyage === '001A'
      && Number(bl.gross_weight_kg) === 1200 && bl.packages === 40 && bl.carrier_name === 'MSC' && bl.is_primary) || J({ bl, A1: A1.bl });
  });
  await check('approve → containers inserted (seal, size / type, gross weight); shipment data written; invoice / packing items inserted', async () => {
    const c = await q(`SELECT container_no, seal_no, size_type, gross_weight_kg::float w FROM public.containers WHERE transaction_id = $1`, [A1.transaction_id]);
    const s = await one(`SELECT * FROM public.transaction_shipment_data WHERE transaction_id = $1`, [A1.transaction_id]);
    const ii = await q(`SELECT * FROM public.shipment_invoice_items WHERE transaction_id = $1`, [A1.transaction_id]);
    const pi = await q(`SELECT * FROM public.shipment_packing_items WHERE transaction_id = $1`, [A1.transaction_id]);
    return (J(A1.containers.added) === J(['MSCU1234565']) && c.length === 1 && c[0].seal_no === 'SL1001' && c[0].size_type === '40HC' && c[0].w === 1200
      && s.batch_id === r1.id && s.consignee_name === 'TEST TRADING CO. ONE' && s.invoice_number === 'INV-1' && String(s.invoice_date).length > 0
      && s.currency === 'USD' && Number(s.total_value) === 5000 && s.packing_list_number === 'PL-1' && s.approved_by === U.jed
      && s.containers.length === 1 && Array.isArray(s.missing_fields) && ii.length === 1 && ii[0].supplier_hs_code === '870830' && ii[0].unit === 'CARTON'
      && pi.length === 1 && pi[0].container_no === 'MSCU1234565' && pi[0].seal_no === 'SL1001' && A1.invoice_items === 1 && A1.packing_items === 1) || J({ c, s, ii, pi });
  });
  await check('approve → the readings are linked to the transaction and marked reviewed by the approver; the batch is approved with its result', async () => {
    const e = await q(`SELECT transaction_id, review_status, reviewed_by FROM public.document_extractions WHERE id = ANY ($1)`, [[r1.bl, r1.inv, r1.pk]]);
    const b = await getB('jed', r1.id);
    return (e.every(x => x.transaction_id === A1.transaction_id && x.review_status === 'reviewed' && x.reviewed_by === U.jed) && A1.extractions_linked === 3
      && b.status === 'approved' && b.approved_by === U.jed && b.transaction_id === A1.transaction_id && b.approve_result.ref === A1.ref) || J({ e, b: b.status });
  });
  await check('approve → the consignee name learned as a SUGGESTED alias only (no confirmation); client statistics unchanged', async () => {
    const a = await q(`SELECT status, source, source_ref FROM public.client_aliases WHERE client_id = $1 AND alias = 'TEST TRADING CO. ONE'`, [CLIENT_A]);
    const c = await one(`SELECT match_count FROM public.clients WHERE id = $1`, [CLIENT_A]);
    return (a.length === 0 || (a[0].status === 'suggested' && a[0].source === 'bl')) && c.match_count === 0 && (A1.client_alias === null || A1.client_alias.status !== 'approved') || J({ a, c, al: A1.client_alias });
  });
  await check('approve: replay of the idempotency key returns the same result (replayed); without a key an approved batch → MRS_DOC_BATCH_STATE approved', async () => {
    const rep = await approve('jed', r1.id, { version: r1.version, new_transaction: { client_id: CLIENT_A }, idempotencyKey: K1 });
    const other = await code(() => approve('jed', r1.id, { version: r1.version, new_transaction: { client_id: CLIENT_A2 }, idempotencyKey: K1 }));
    const again = await code(() => approve('jed', r1.id, { version: r1.version, new_transaction: { client_id: CLIENT_A } }));
    const n = await num(`SELECT count(*) n FROM public.transactions WHERE bl_number = 'LDBL0000001'`);
    return (rep.replayed === true && rep.transaction_id === A1.transaction_id && /MRS_IDEMPOTENCY_CONFLICT/.test(other)
      && again === 'MRS_DOC_BATCH_STATE approved' && n === 1) || J({ rep, other, again, n });
  });
  await check('an approved batch is frozen: save / attach / detach / discard / archive → MRS_DOC_BATCH_STATE approved; owner UPDATE of the draft refused by the guard', async () => {
    const g = await getB('jed', r1.id);
    const x = await ext({ kind: 'customs_declaration' });
    const r = await Promise.all([code(() => saveD('jed', r1.id, { version: g.version, draft: {} })), code(() => attach('jed', r1.id, x, 'customs_declaration')),
      code(() => rpc('jed', `SELECT public.detach_doc_batch_document($1, 'x') r`, [g.documents[0].id])),
      code(() => rpc('jed', `SELECT public.discard_doc_batch($1, 'x') r`, [r1.id])), code(() => rpc('jed', `SELECT public.archive_doc_batch($1, 'x') r`, [r1.id]))]);
    const own = await code(() => q(`UPDATE public.doc_batches SET draft = '{}' WHERE id = $1`, [r1.id]));
    return (r.every(y => y === 'MRS_DOC_BATCH_STATE approved') && /MRS_IMMUTABLE draft/.test(own)) || J({ r, own });
  });

  // duplicate guard (step 2): the same B/L + container already on a live transaction
  await check('duplicate guard: a second batch with the same B/L + container into a NEW transaction → MRS_DUPLICATE_TX container; nothing written, batch still draft', async () => {
    const r2 = await readyBatch('jed');
    const txBefore = await num(`SELECT count(*) n FROM public.transactions`);
    const c = await code(() => approve('jed', r2.id, { version: r2.version, new_transaction: { client_id: CLIENT_A } }));
    const g = await getB('jed', r2.id);
    const txAfter = await num(`SELECT count(*) n FROM public.transactions`);
    const sd = await num(`SELECT count(*) n FROM public.transaction_shipment_data WHERE batch_id = $1`, [r2.id]);
    const linked = await num(`SELECT count(*) n FROM public.document_extractions WHERE id = ANY ($1) AND transaction_id IS NOT NULL`, [[r2.bl, r2.inv, r2.pk]]);
    return (c === 'MRS_DUPLICATE_TX container' && g.status === 'draft' && txAfter === txBefore && sd === 0 && linked === 0) || J({ c, g: g.status, txBefore, txAfter, sd });
  });

  // existing transaction (seed TX_JED: B/L TESTBL0000001, TSTU0000001 / TSTU0000002)
  let A2, r3;
  await check('approve → existing transaction: empty columns filled, differing ones KEPT and reported; the transaction\'s client is never replaced', async () => {
    r3 = await readyBatch('jed', { bl: 'TESTBL0000001', ctr: ['TSTU0000001', 'MSKU9070323'], seal: ['SEALX1', 'SEALX2'], tx: TX_JED });
    const before = await one(`SELECT * FROM public.transactions WHERE id = $1`, [TX_JED]);
    A2 = await approve('jed', r3.id, { version: r3.version });
    const t = await one(`SELECT * FROM public.transactions WHERE id = $1`, [TX_JED]);
    return (A2.transaction_id === TX_JED && A2.created_transaction === false && t.client_id === before.client_id && t.port_of_discharge === before.port_of_discharge
      && A2.tx_kept.includes('port_of_discharge') && A2.tx_kept.includes('goods_description') && A2.tx_filled.includes('port_of_loading')
      && t.port_of_loading === 'Shanghai') || J({ A2, t });
  });
  await check('approve → existing container completed (empty seal / size / weight only), the new one inserted; nothing overwritten', async () => {
    const c = await q(`SELECT container_no, seal_no, size_type FROM public.containers WHERE transaction_id = $1 ORDER BY container_no`, [TX_JED]);
    const t1 = c.find(x => x.container_no === 'TSTU0000001');
    return (J(A2.containers.added) === J(['MSKU9070323']) && J(A2.containers.updated) === J(['TSTU0000001']) && t1.seal_no === 'SEALX1'
      && t1.size_type === '40HC' && c.some(x => x.container_no === 'MSKU9070323')) || J({ c, A2: A2.containers });
  });
  await check('re-approval of the same transaction: the previous items are VOIDED (void-only), the new ones live; shipment data replaced (one row)', async () => {
    const r4 = await readyBatch('jed', { bl: 'TESTBL0000001', ctr: ['TSTU0000001'], seal: ['SEALX1'], tx: TX_JED });
    const before = await q(`SELECT id FROM public.shipment_invoice_items WHERE transaction_id = $1 AND voided_at IS NULL`, [TX_JED]);
    const a = await approve('jed', r4.id, { version: r4.version });
    const voided = await q(`SELECT void_reason FROM public.shipment_invoice_items WHERE id = ANY ($1)`, [before.map(x => x.id)]);
    const live = await num(`SELECT count(*) n FROM public.shipment_invoice_items WHERE transaction_id = $1 AND voided_at IS NULL`, [TX_JED]);
    const sd = await q(`SELECT batch_id FROM public.transaction_shipment_data WHERE transaction_id = $1`, [TX_JED]);
    return (before.length === 1 && voided.every(x => /استُبدلت/.test(x.void_reason)) && live === 1 && sd.length === 1 && sd[0].batch_id === r4.id
      && J(a.containers.unchanged) === J(['TSTU0000001'])) || J({ before, voided, live, sd });
  });
  await check('items are void-only: an owner UPDATE of a live item\'s content → MRS_IMMUTABLE; a voided item is frozen; DELETE refused', async () => {
    const live = await one(`SELECT id FROM public.shipment_invoice_items WHERE transaction_id = $1 AND voided_at IS NULL`, [TX_JED]);
    const dead = await one(`SELECT id FROM public.shipment_invoice_items WHERE transaction_id = $1 AND voided_at IS NOT NULL LIMIT 1`, [TX_JED]);
    const a = await code(() => q(`UPDATE public.shipment_invoice_items SET description = 'x' WHERE id = $1`, [live.id]));
    const b = await code(() => q(`UPDATE public.shipment_invoice_items SET void_reason = 'y' WHERE id = $1`, [dead.id]));
    const c = await code(() => q(`DELETE FROM public.shipment_packing_items WHERE transaction_id = $1`, [TX_JED]));
    const d = await code(() => q(`DELETE FROM public.transaction_shipment_data WHERE transaction_id = $1`, [TX_JED]));
    return (/MRS_IMMUTABLE description/.test(a) && /MRS_IMMUTABLE voided_at/.test(b) && c === 'MRS_APPEND_ONLY shipment_packing_items'
      && d === 'MRS_APPEND_ONLY transaction_shipment_data') || J({ a, b, c, d });
  });
  await check('approve with confirm_client → the identity name becomes an APPROVED alias of the transaction\'s client (+ match statistics)', async () => {
    const r5 = await readyBatch('jed', { bl: 'CONFBL0001', ctr: ['CSQU3054383'], seal: ['C1'], consignee: 'IMPORTER - BLUE OCEAN FOODS\nRIYADH' });
    const a = await approve('jed', r5.id, { version: r5.version, new_transaction: { client_id: CLIENT_A2 }, confirm_client: true });
    const al = await one(`SELECT status, approved_by, occurrences FROM public.client_aliases WHERE client_id = $1 AND alias = 'BLUE OCEAN FOODS'`, [CLIENT_A2]);
    const c = await one(`SELECT match_count, last_matched_at FROM public.clients WHERE id = $1`, [CLIENT_A2]);
    return (a.client_alias.status === 'approved' && al.status === 'approved' && al.approved_by === U.jed && al.occurrences === 1 && c.match_count === 1
      && c.last_matched_at) || J({ a: a.client_alias, al, c });
  });
  await check('approve: the shipping agent is set on the B/L (agent party of the org only: a carrier → MRS_INVALID shipping_agent_id)', async () => {
    const msc = (await one(`SELECT id FROM public.parties WHERE org_id = $1 AND name_en = 'MSC'`, [A])).id;
    const car = (await as('jed', `INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['carrier'], 'ناقل الوثائق') RETURNING id`, [A]))[0].id;
    const r6 = await readyBatch('jed', { bl: 'AGBL00001', ctr: ['TGHU9999998'.slice(0, 10) + XJS.iso6346CheckDigit('TGHU999999')], seal: ['A1'] });
    const bad = await code(() => approve('jed', r6.id, { version: r6.version, new_transaction: { client_id: CLIENT_A }, shipping_agent_id: car }));
    const a = await approve('jed', r6.id, { version: r6.version, new_transaction: { client_id: CLIENT_A }, shipping_agent_id: msc });
    const bl = await one(`SELECT shipping_agent_id FROM public.bills_of_lading WHERE id = $1`, [a.bl.id]);
    return (bad === 'MRS_INVALID shipping_agent_id' && bl.shipping_agent_id === msc) || J({ bad, bl });
  });
  await check('approve: Ro-Ro transaction + containers in the draft → MRS_INVALID containers_roro (nothing written)', async () => {
    const ro = (await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, cargo_unit_type, chassis_no)
                                 VALUES ($1, $2, $3, 'import', 'sea', 'roro', 'JTDBR32E720012345') RETURNING id`, [A, JED, CLIENT_A]))[0].id;
    const r7 = await readyBatch('jed', { bl: 'ROROBL001', ctr: ['CSQU3054383'], seal: ['R1'], tx: ro });
    const c = await code(() => approve('jed', r7.id, { version: r7.version }));
    const n = await num(`SELECT count(*) n FROM public.transaction_shipment_data WHERE transaction_id = $1`, [ro]);
    return (c === 'MRS_INVALID containers_roro' && n === 0) || J({ c, n });
  });
  await check('approve: branch rules — dmm cannot approve a JED batch (MRS_NOT_FOUND doc_batch); jed cannot approve into a DMM transaction (MRS_NOT_FOUND transaction)', async () => {
    const r8 = await readyBatch('jed', { bl: 'BRBL00001', ctr: ['MSKU1234561'.slice(0, 10) + XJS.iso6346CheckDigit('MSKU123456')], seal: ['B1'] });
    const a = await code(() => approve('dmm', r8.id, { version: r8.version, new_transaction: { client_id: CLIENT_A } }));
    const b = await code(() => approve('jed', r8.id, { version: r8.version, transaction_id: TX_DMM }));
    const c = await code(() => approve('jed', r8.id, { version: r8.version, transaction_id: TX_JED, new_transaction: { client_id: CLIENT_A } }));
    return (a === 'MRS_NOT_FOUND doc_batch' && b === 'MRS_NOT_FOUND transaction' && c === 'MRS_INVALID new_transaction') || J({ a, b, c });
  });
  await check('approve: a batch without documents → MRS_REQUIRED documents; with an unsaved (empty) draft → MRS_REQUIRED draft', async () => {
    const e = await mkBatch('jed');
    const a = await code(() => approve('jed', e.id, { version: 1, transaction_id: TX_JED }));
    const x = await ext({ kind: 'customs_declaration', fields: { declaration_number: '123' } });
    await attach('jed', e.id, x, 'customs_declaration');
    const b = await code(() => approve('jed', e.id, { version: 1, transaction_id: TX_JED }));
    return (a === 'MRS_REQUIRED documents' && b === 'MRS_REQUIRED draft') || J({ a, b });
  });
  await check('nothing is approved automatically: no code path sets status approved besides approve_doc_batch; drafts start as draft', () => {
    const src = fs.readFileSync(MIG_FILE, 'utf8');
    const sets = src.match(/UPDATE public\.doc_batches \w+ SET status = 'approved'/g) || [];
    const ins = /INSERT INTO public\.doc_batches[^;]*'approved'/.test(src);
    return (sets.length === 1 && !ins && /FUNCTION public\.approve_doc_batch[\s\S]*UPDATE public\.doc_batches y SET status = 'approved'[\s\S]*FUNCTION public\.get_transaction_shipment/.test(src)) || 'sets: ' + sets.length;
  });
  await check('audit: the approval leaves trail rows (doc_batches UPDATE by the approver, shipment data INSERT) WITHOUT the document content', async () => {
    const r = await q(`SELECT table_name, action, actor, new_data FROM public.audit_log WHERE row_id = $1 OR row_id = $2 ORDER BY id`, [r1.id, A1.transaction_id]);
    const b = r.filter(x => x.table_name === 'doc_batches' && x.action === 'UPDATE' && x.actor === U.jed);
    const s = r.filter(x => x.table_name === 'transaction_shipment_data');
    const leak = r.some(x => ['doc_batches', 'transaction_shipment_data'].includes(x.table_name) && x.new_data && ('draft' in x.new_data || 'consignee' in x.new_data || 'invoice_number' in x.new_data || 'bl_number' in x.new_data));
    return (b.length >= 1 && b.some(x => x.new_data.status === 'approved') && s.length === 1 && !leak) || J(r.map(x => [x.table_name, x.action, Object.keys(x.new_data || {})]));
  });
  await check('get_transaction_shipment: staff of the branch → data + live items + batches; dmm / portal → MRS_NOT_FOUND transaction', async () => {
    const g = await rpc('jed', `SELECT public.get_transaction_shipment($1) r`, [TX_JED]);
    const r = await Promise.all(['dmm', 'portal'].map(w => code(() => rpc(w, `SELECT public.get_transaction_shipment($1) r`, [TX_JED]))));
    return (g.shipment_data.transaction_id === TX_JED && g.invoice_items.length === 1 && !('voided_at' in g.invoice_items[0]) && g.batches.length >= 2
      && r.every(x => x === 'MRS_NOT_FOUND transaction')) || J({ g: Object.keys(g), r });
  });
}

/* ================================================================== 8. client matching */
async function secMatching() {
  section('8. match_client_v2, confirm_client_match, reject_client_alias');
  await check('exact official English name (company words dropped) → 100 english_name, suggested; the address block is cleaned first', async () => {
    const r = await matchV2('jed', { name: 'CONSIGNEE: TEST TRADING COMPANY ONE\nP.O. BOX 55 JEDDAH' });
    return (r.source_name === 'TEST TRADING COMPANY ONE' && r.best && r.best.client_id === CLIENT_A && r.best.method === 'english_name'
      && r.candidates[0].confidence === 100 && r.suggested === true && r.confirmed === false && r.conflict === false
      && r.thresholds.suggest === 90 && r.thresholds.review === 70) || J(r);
  });
  await check('exact Arabic name → arabic_name; VAT number → vat_number; never links anything (no alias, no statistics)', async () => {
    const before = await num(`SELECT count(*) n FROM public.client_aliases`);
    const a = await matchV2('jed', { name: 'شركة الاختبار الأولى للتجارة' });
    const b = await matchV2('jed', { name: 'Somebody', vat_number: '300000000000013' });
    const after = await num(`SELECT count(*) n FROM public.client_aliases`);
    return (a.best.method === 'arabic_name' && a.best.client_id === CLIENT_A && b.candidates.some(x => x.client_id === CLIENT_A2 && x.method === 'vat_number')
      && before === after) || J({ a, b });
  });
  await check('two clients with the same English name → conflict, no suggestion (legacy: a duplicate English name means review)', async () => {
    await q(`INSERT INTO public.clients (org_id, client_type, name_ar, name_en) VALUES ($1, 'business', 'نسخة عميل', 'Twin Foods Co'), ($1, 'business', 'نسخة عميل ٢', 'TWIN FOODS LTD')`, [A]);
    const r = await matchV2('jed', { name: 'Twin Foods' });
    return (r.conflict === true && r.best === null && r.suggested === false && r.candidates.filter(x => x.method === 'english_name').length === 2) || J(r);
  });
  await check('similar names only → method similar, confidence < 100, never suggested below 90; candidates 70–89 flagged review', async () => {
    const r = await matchV2('jed', { name: 'TEST TRADING ONE GLOBAL' });
    const c = r.candidates.find(x => x.client_id === CLIENT_A);
    return (c && c.method === 'similar' && c.confidence < 100 && (c.confidence >= 90 || r.best === null) && typeof c.review === 'boolean') || J(r);
  });
  let aliasId;
  await check('confirm_client_match: an approved alias is created (staff), occurrences 1, client match_count + 1; the alias then matches as «alias»', async () => {
    const mc0 = (await one(`SELECT match_count FROM public.clients WHERE id = $1`, [CLIENT_A])).match_count;
    const r = await confirm('jed', { client_id: CLIENT_A, source_name: 'NOTIFY HOLDINGS GROUP\nKING ROAD 12', source_ref: 'BL123', confidence: 95 });
    aliasId = r.alias_id;
    const m = await matchV2('jed', { name: 'Notify Holdings Group' });
    const a = await one(`SELECT * FROM public.client_aliases WHERE id = $1`, [aliasId]);
    return (r.status === 'approved' && r.created === true && r.occurrences === 1 && r.match_count === mc0 + 1 && a.approved_by === U.jed && a.confidence === 95
      && a.source_ref === 'BL123' && m.best && m.best.method === 'alias' && m.best.client_id === CLIENT_A) || J({ r, m, a });
  });
  await check('confirm again → occurrences 2 (no second alias); the same name for ANOTHER client → MRS_CLIENT_ALIAS_CONFLICT', async () => {
    const r = await confirm('jed', { client_id: CLIENT_A, source_name: 'Notify Holdings Group' });
    const c = await code(() => confirm('jed', { client_id: CLIENT_A2, source_name: 'NOTIFY HOLDINGS GROUP' }));
    return (r.alias_id === aliasId && r.occurrences === 2 && r.created === false && c === 'MRS_CLIENT_ALIAS_CONFLICT') || J({ r, c });
  });
  await check('a SUGGESTED alias only adds to the similarity (never an «alias» match) and moves to the client a staff member confirms', async () => {
    await q(`INSERT INTO public.client_aliases (org_id, client_id, alias, source, status) VALUES ($1, $2, 'Suggested Trading Name', 'ocr', 'suggested')`, [A, CLIENT_A]);
    const m = await matchV2('jed', { name: 'Suggested Trading Name' });
    const hit = m.candidates.find(x => x.client_id === CLIENT_A);
    const r = await confirm('jed', { client_id: CLIENT_A2, source_name: 'Suggested Trading Name' });
    const a = await one(`SELECT client_id, status FROM public.client_aliases WHERE alias = 'Suggested Trading Name'`);
    return (hit && hit.method === 'similar' && r.status === 'approved' && a.client_id === CLIENT_A2 && a.status === 'approved') || J({ m, r, a });
  });
  await check('reject_client_alias: ops writers only; a rejected alias is never used (no alias match, no similarity)', async () => {
    const f = await code(() => rpc('acc', `SELECT public.reject_client_alias($1, 'wrong') r`, [aliasId]));
    const r = await rpc('jed', `SELECT public.reject_client_alias($1, 'wrong client') r`, [aliasId]);
    const m = await matchV2('jed', { name: 'Notify Holdings Group' });
    return (f === 'MRS_FORBIDDEN role' && r.status === 'rejected' && !m.candidates.some(x => x.method === 'alias')) || J({ f, r, m });
  });
  await check('match_client_v2 / confirm_client_match: permissions and payload (portal / other org → MRS_FORBIDDEN, unknown key, empty name, inactive client)', async () => {
    const r = await Promise.all([code(() => matchV2('portal', { name: 'x' })), code(() => matchV2('staffB', { name: 'x' }, A)),
      code(() => matchV2('jed', { name: 'x', colour: 1 })), code(() => matchV2('jed', { name: '' })),
      code(() => confirm('acc', { client_id: CLIENT_A, source_name: 'x y' })), code(() => confirm('jed', { client_id: CL_B, source_name: 'x y' })),
      code(() => confirm('jed', { client_id: CLIENT_A }))]);
    return J(r) === J(['MRS_FORBIDDEN org', 'MRS_FORBIDDEN org', 'MRS_INVALID unknown_key', 'MRS_REQUIRED name', 'MRS_FORBIDDEN role',
      'MRS_NOT_FOUND client', 'MRS_REQUIRED source_name']) || J(r);
  });
}

/* ================================================================== 9. RLS, privileges, conversion */
async function secRls() {
  section('9. RLS on the new tables, function privileges, conversion lists');
  const T = ['doc_batches', 'doc_batch_documents', 'transaction_shipment_data', 'shipment_invoice_items', 'shipment_packing_items'];
  await check('RLS enabled on the 5 tables; no INSERT / UPDATE / DELETE grant for authenticated / anon', async () => {
    const r = await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY ($1) AND relnamespace = 'public'::regnamespace`, [T]);
    const g = await q(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public'
                        AND table_name = ANY ($1) AND grantee IN ('anon','authenticated')`, [T]);
    return (r.length === 5 && r.every(x => x.relrowsecurity) && g.length === 5 && g.every(x => x.grantee === 'authenticated' && x.privilege_type === 'SELECT')) || J({ r, g });
  });
  await check('direct writes are refused (permission denied) for staff on all 5 tables', async () => {
    const r = [];
    for (const t of T) {
      r.push(await code(() => as('admin', `UPDATE public.${t} SET org_id = org_id`)));
      r.push(await code(() => as('admin', `DELETE FROM public.${t}`)));
    }
    r.push(await code(() => as('admin', `INSERT INTO public.doc_batches (org_id, branch_id, created_by) VALUES ($1, $2, $3)`, [A, JED, U.admin])));
    return r.every(x => x === 'perm') || J(r);
  });
  await check('SELECT: jed sees JED batches / shipment rows only, dmm none of JED, org B / portal nothing; anon permission denied', async () => {
    const cnt = async (who, t) => Number((await as(who, `SELECT count(*) n FROM public.${t}`))[0].n);
    const jedB = await cnt('jed', 'doc_batches'), allB = await num(`SELECT count(*) n FROM public.doc_batches WHERE branch_id = $1`, [JED]);
    const dmmJ = Number((await as('dmm', `SELECT count(*) n FROM public.doc_batches WHERE branch_id = $1`, [JED]))[0].n);
    const dmmS = Number((await as('dmm', `SELECT count(*) n FROM public.transaction_shipment_data WHERE transaction_id = $1`, [TX_JED]))[0].n);
    const jedS = Number((await as('jed', `SELECT count(*) n FROM public.transaction_shipment_data WHERE transaction_id = $1`, [TX_JED]))[0].n);
    const others = [];
    for (const t of T) { others.push(await cnt('staffB', t)); others.push(await cnt('portal', t)); }
    const docs = await cnt('jed', 'doc_batch_documents');
    const an = await code(() => as('anon', `SELECT 1 FROM public.doc_batches`));
    return (jedB === allB && jedB > 0 && dmmJ === 0 && dmmS === 0 && jedS === 1 && others.every(x => x === 0) && docs > 0 && an === 'perm') || J({ jedB, allB, dmmJ, dmmS, jedS, others, an });
  });
  await check('function privileges: the 16 RPCs executable by authenticated only (not anon, not service_role); internal helpers by nobody', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('anon', p.oid, 'EXECUTE') an,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') sr
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1)`, [RPCS]);
    const h = await q(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
                         AND p.proname IN ('seed_shipping_agents','client_alias_learn','doc_batch_lock','doc_batch_json','doc_batch_merge','doc_reading_section',
                                           'doc_batch_compare','doc_cmp_row','doc_val','doc_num','tg_legacy_docs_audit','tg_legacy_docs_guard','tg_legacy_docs_no_delete')
                         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))`);
    return (r.length === RPCS.length && r.every(x => x.au && !x.an && !x.sr) && h.length === 0) || J({ r, h });
  });
  await check('conversion lists: the 5 tables are in app.convert_delete_tables, their no-delete guards in app.convert_delete_guards (44 with the 3 tables of 20261120000100, the 3 of 20261121000100, the 4 of 20261122000100 and the 5 of 20261123000100), every table classified', async () => {
    const t = (await one(`SELECT app.convert_delete_tables() t`)).t;
    const g = (await one(`SELECT app.convert_delete_guards() g`)).g;
    const keep = (await one(`SELECT app.convert_keep_tables() k`)).k;
    const all = (await q(`SELECT 'public.' || relname n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`)).map(x => x.n);
    const un = all.filter(x => !t.includes(x) && !keep.includes(x) && !['public.status_labels', 'public.schema_versions', 'public.organizations',
      'public.profiles', 'public.platform_admins', 'public.plans', 'public.customs_ports', 'public.daftra_mock_accounts'].includes(x));
    return (T.every(x => t.includes('public.' + x) && g.includes('public.' + x + ':trg_no_delete')) && g.length === 44) || J({ g: g.length, un });
  });
}

/* ================================================================== 10. front end (static) */
async function secStatic() {
  section('10. supa.js wrappers, i18n, ai-extract compatibility');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  await check('supa.js: one exported wrapper per RPC, calling it by name', () => {
    const W = { createDocBatch: 'create_doc_batch', attachDocBatchDocument: 'attach_doc_batch_document', detachDocBatchDocument: 'detach_doc_batch_document',
      mergeDocBatch: 'merge_doc_batch', saveDocBatchDraft: 'save_doc_batch_draft', getDocBatch: 'get_doc_batch', listPendingDocBatches: 'list_pending_doc_batches',
      discardDocBatch: 'discard_doc_batch', archiveDocBatch: 'archive_doc_batch', approveDocBatch: 'approve_doc_batch', getTransactionShipment: 'get_transaction_shipment',
      matchClientV2: 'match_client_v2', confirmClientMatch: 'confirm_client_match', rejectClientAlias: 'reject_client_alias', seedShippingAgents: 'seed_shipping_agents',
      matchShippingAgent: 'match_shipping_agent' };
    const miss = Object.keys(W).filter(f => !new RegExp('function ' + f + '\\(').test(supa) || !new RegExp(f + ': ' + f + '[,\\n]').test(supa) || !supa.includes("'" + W[f] + "'"));
    return (miss.length === 0 && Object.values(W).sort().join() === RPCS.join()) || 'missing: ' + miss.join(', ');
  });
  await check('supa.js: approveDocBatch / createDocBatch use the idempotent path; aiExtract sends prompt_version only when asked (v2 unchanged); ai_detail saved', () =>
    (/idemRpc\('approve_doc_batch'/.test(supa) && /idemRpc\('create_doc_batch'/.test(supa) && /if \(v3\) body\.prompt_version = AI_PROMPT_V3/.test(supa)
      && /'packing_list'/.test(supa) && /'ai_detail'\]/.test(supa)) || 'supa');
}

/* ================================================================== 11. review fixes (regressions) */
const ctr = p => p + XJS.iso6346CheckDigit(p);
async function secReview() {
  section('11. review fixes: idempotency per batch, suggested alias cap, late batch keeps approved data, phonetic matching, buyer identity, B/L placeholder, combined file, source binding');
  await check('review: a key reused for ANOTHER batch with an identical payload → MRS_IDEMPOTENCY_CONFLICT (never the first batch\'s result); the second batch stays draft', async () => {
    const b1 = await readyBatch('jed', { bl: 'IDEMBL0001', ctr: [ctr('CSQU305438')], seal: ['I1'] });
    const b2 = await readyBatch('jed', { bl: 'IDEMBL0002', ctr: [ctr('MSKU907032')], seal: ['I2'] });
    const K = newKey();
    const a1 = await approve('jed', b1.id, { version: b1.version, new_transaction: { client_id: CLIENT_A }, idempotencyKey: K });
    const c = await code(() => approve('jed', b2.id, { version: b2.version, new_transaction: { client_id: CLIENT_A }, idempotencyKey: K }));
    const g = await getB('jed', b2.id);
    const a2 = await approve('jed', b2.id, { version: b2.version, new_transaction: { client_id: CLIENT_A }, idempotencyKey: newKey() });
    return (b1.version === b2.version && a1.batch_id === b1.id && /MRS_IDEMPOTENCY_CONFLICT/.test(c) && g.status === 'draft'
      && a2.batch_id === b2.id && a2.transaction_id !== a1.transaction_id) || J({ c, g: g.status, a1: a1.batch_id, a2: a2.batch_id });
  });
  await check('review: an unconfirmed SUGGESTED alias never yields a suggestion (≤ 89, review, reason suggested_alias); a confirmed one does', async () => {
    const b = await readyBatch('jed', { bl: 'ZEPHBL0001', ctr: [ctr('TGHU100001')], seal: ['Z1'], consignee: 'ZEPHYR NOVA IMPORTS' });
    const a = await approve('jed', b.id, { version: b.version, new_transaction: { client_id: CLIENT_A2 } });
    const m = await matchV2('jed', { name: 'ZEPHYR NOVA IMPORTS' });
    const c = m.candidates.find(x => x.client_id === CLIENT_A2);
    await confirm('jed', { client_id: CLIENT_A2, source_name: 'ZEPHYR NOVA IMPORTS' });
    const m2 = await matchV2('jed', { name: 'ZEPHYR NOVA IMPORTS' });
    return (a.client_alias && a.client_alias.status === 'suggested' && m.best === null && m.suggested === false && c && c.confidence <= 89
      && c.review === true && c.reasons.includes('suggested_alias') && m2.best && m2.best.method === 'alias' && m2.best.client_id === CLIENT_A2) || J({ a: a.client_alias, m, m2 });
  });
  await check('review: a later batch on an approved transaction (packing list only) KEEPS the approved shipment / invoice data and the invoice items', async () => {
    const C1 = ctr('TGHU200002');
    const b1 = await readyBatch('jed', { bl: 'LATEBL0001', ctr: [C1], seal: ['L1'] });
    const a1 = await approve('jed', b1.id, { version: b1.version, new_transaction: { client_id: CLIENT_A } });
    const T = a1.transaction_id;
    const inv0 = await q(`SELECT id FROM public.shipment_invoice_items WHERE transaction_id = $1 AND voided_at IS NULL`, [T]);
    const b2 = await mkBatch('jed', { transaction_id: T });
    const pk = await ext({ kind: 'packing_list', fields: { packing_list_number: 'PL-LATE', packages_count: '41', net_weight: '1001', gross_weight: '1201' },
      items: [{ description: 'Brake pads (late list)', packages: 41, net_weight: 1001, gross_weight: 1201, container_number: C1 }], detail: det('packing_list') });
    await attach('jed', b2.id, pk, 'packing_list');
    const m = await merge('jed', b2.id);
    const g = await getB('jed', b2.id);
    const sv = await saveD('jed', b2.id, { version: g.version, draft: m.draft });
    const a2 = await approve('jed', b2.id, { version: sv.version });
    const sd = await one(`SELECT * FROM public.transaction_shipment_data WHERE transaction_id = $1`, [T]);
    const invLive = await q(`SELECT id FROM public.shipment_invoice_items WHERE transaction_id = $1 AND voided_at IS NULL`, [T]);
    const packLive = await q(`SELECT packing_list_number, description FROM public.shipment_packing_items WHERE transaction_id = $1 AND voided_at IS NULL`, [T]);
    return (sd.batch_id === b2.id && sd.shipper === 'SHANGHAI SUPPLIER LTD' && sd.invoice_number === 'INV-1' && sd.currency === 'USD'
      && Number(sd.total_value) === 5000 && sd.vessel === 'MSC TEST' && sd.consignee_name === 'TEST TRADING CO. ONE' && sd.packing_list_number === 'PL-LATE'
      && Number(sd.packing_total_packages) === 41 && sd.bl_number === 'LATEBL0001' && sd.draft && sd.draft.invoice.invoice_number === 'INV-1'
      && J(invLive.map(x => x.id)) === J(inv0.map(x => x.id)) && packLive.length === 1 && packLive[0].packing_list_number === 'PL-LATE'
      && a2.merged_previous && a2.merged_previous.batch_id === b1.id && a2.merged_previous.invoice_items_kept === true
      && a2.merged_previous.packing_items_kept === false && a2.invoice_items === 0 && a2.packing_items === 1
      && !a2.missing_fields.includes('invoice_number') && a2.bl && a2.bl.existing === true) || J({ sd, invLive, inv0, packLive, a2 });
  });
  await check('review: app.doc_draft_overlay = legacy mergeDocumentDrafts_ (non-empty wins, containers by number, items only when present, notes unioned)', async () => {
    const r = (await one(`SELECT app.doc_draft_overlay($1, $2) d`, [J({ shipment: { vessel: 'A', voyage: '1', containers: [{ container_number: 'X1', seal_number: 'S1' }] },
      invoice: { invoice_number: 'I1', items: [{ description: 'a' }] }, source_notes: ['n1'] }),
      J({ shipment: { vessel: 'B', voyage: '', containers: [{ container_number: 'X1', size_type: '40HC' }, { container_number: 'X2' }] },
        invoice: { invoice_number: null, items: [] }, packing: { packing_list_number: 'P1' }, source_notes: ['n2'] })])).d;
    return (r.shipment.vessel === 'B' && r.shipment.voyage === '1' && r.shipment.containers.length === 2 && r.shipment.containers[0].seal_number === 'S1'
      && r.shipment.containers[0].size_type === '40HC' && r.invoice.invoice_number === 'I1' && r.invoice.items.length === 1
      && r.packing.packing_list_number === 'P1' && r.source_notes.length === 2) || J(r);
  });
  await check('review: legacy phonetic / transliteration scoring — an English consignee finds an Arabic-only client; near spellings score ≥ 70 (review)', async () => {
    const ids = (await q(`INSERT INTO public.clients (org_id, client_type, name_ar, name_en) VALUES ($1, 'business', 'مؤسسة النور التجارية', NULL),
                           ($1, 'business', 'شركة الرشيد للأغذية', 'ALRASHID FOODS') RETURNING id`, [A])).map(x => x.id);
    const sim0 = (await one(`SELECT app.name_sim(app.norm_name('AL NOOR TRADING EST'), app.norm_name('مؤسسة النور التجارية')) v`)).v;
    const a = await matchV2('jed', { name: 'AL NOOR TRADING EST' });
    const b = await matchV2('jed', { name: 'AL RASHEED FOODS' });
    const ca = a.candidates.find(x => x.client_id === ids[0]);
    const cb = b.candidates.find(x => x.client_id === ids[1]);
    const lev = (await one(`SELECT app.cm_lev('kitten', 'sitting') a, app.cm_ar_latin('النور') b, app.cm_phonetic('Rasheed') c`));
    await q(`UPDATE public.clients SET is_active = false WHERE id = ANY ($1)`, [ids]);
    return (Number(sim0) === 0 && ca && ca.confidence >= 40 && ca.reasons.includes('phonetic_name') && cb && cb.confidence >= 70
      && lev.a === 3 && lev.b === 'ALNWR' && lev.c === 'RSHD') || J({ sim0, ca, cb, lev });
  });
  await check('review: consignee vs invoice buyer compared on the identity name (an address block after the buyer name is no conflict)', async () => {
    const c = (await one(`SELECT app.doc_batch_compare($1) c`, [J({ shipment: { consignee_name: 'ABC FOODS CO' },
      invoice: { buyer: 'ABC FOODS CO, P.O. BOX 1234, JEDDAH, SAUDI ARABIA' } })])).c;
    return (c.matches.some(x => x.field === 'consignee_buyer') && !c.conflicts.some(x => x.field === 'consignee_buyer')) || J(c);
  });
  await check('review: legacy normalizeValidBillNo_ — N/A / NONE / 0000 / غير متوفر is no B/L number (no conflict, still missing)', async () => {
    const r = await one(`SELECT app.doc_bl_no('N/A') a, app.doc_bl_no(' n a ') b, app.doc_bl_no('0000') c, app.doc_bl_no('غير متوفر') d, app.doc_bl_no('NONE') e,
                                app.doc_bl_no('medu 123') f, app.doc_bl_no('NA1234') g`);
    const c = (await one(`SELECT app.doc_batch_compare($1) c`, [J({ shipment: { bl_number: 'MEDU1234567' }, invoice: { bl_number: 'N/A' } })])).c;
    const c2 = (await one(`SELECT app.doc_batch_compare($1) c`, [J({ invoice: { bl_number: 'N/A' } })])).c;
    return (r.a === null && r.b === null && r.c === null && r.d === null && r.e === null && r.f === 'MEDU123' && r.g === 'NA1234'
      && !c.conflicts.some(x => x.field === 'bl_number') && c2.missing_fields.includes('bl_number')) || J({ r, c, c2 });
  });
  await check('review: an invoice printing «B/L NO: N/A» → no bogus bill of lading on approval (bl null, shipment data bl_number null)', async () => {
    const b = await mkBatch('jed');
    const inv = await ext({ kind: 'commercial_invoice', fields: { invoice_number: 'INV-NA', bl_number: 'N/A', currency: 'USD', total: '10', buyer_name: 'NA BUYER' },
      items: [{ description: 'x', quantity: 1 }], detail: det('commercial_invoice') });
    await attach('jed', b.id, inv, 'commercial_invoice');
    const m = await merge('jed', b.id);
    const sv = await saveD('jed', b.id, { version: (await getB('jed', b.id)).version, draft: m.draft });
    const a = await approve('jed', b.id, { version: sv.version, new_transaction: { client_id: CLIENT_A } });
    const sd = await one(`SELECT bl_number FROM public.transaction_shipment_data WHERE transaction_id = $1`, [a.transaction_id]);
    const n = await num(`SELECT count(*) n FROM public.bills_of_lading WHERE bl_number IN ('N/A', 'NA')`);
    return (m.draft.invoice.bl_number === undefined && a.bl === null && sd.bl_number === null && n === 0 && a.missing_fields.includes('bl_number')) || J({ m: m.draft.invoice, a, sd, n });
  });
  await check('review: a combined file (detected_documents) is accepted in the slot of any type it holds and fills every section; items stay in its own section', async () => {
    const b = await mkBatch('jed');
    const d = Object.assign(det('bill_of_lading'), { detected_documents: ['bill_of_lading', 'commercial_invoice', 'packing_list'] });
    const e = await ext({ kind: 'commercial_invoice', fields: { bl_number: 'COMBO00001', shipper: 'COMBO SHIPPER', invoice_number: 'INV-C', currency: 'EUR',
      packing_list_number: 'PL-C', packages_count: '5' }, items: [{ description: 'combo goods', quantity: 5 }], detail: d });
    const r = await attach('jed', b.id, e, 'commercial_invoice');
    const m = await merge('jed', b.id);
    const lone = await ext({ kind: 'commercial_invoice', detail: det('bill_of_lading') });
    const w = await code(() => attach('jed', b.id, lone, 'commercial_invoice'));
    const ok = (await one(`SELECT app.extraction_detail_ok($1) a, app.extraction_detail_ok($2) b`, [J(d),
      J(Object.assign(det('bill_of_lading'), { detected_documents: ['passport'] }))]));
    return (r.document.detected_type === 'commercial_invoice' && m.draft.shipment.bl_number === 'COMBO00001' && m.draft.shipment.shipper === 'COMBO SHIPPER'
      && m.draft.invoice.invoice_number === 'INV-C' && m.draft.invoice.items.length === 1 && m.draft.packing.packing_list_number === 'PL-C'
      && m.draft.packing.items.length === 0 && w === 'MRS_DOC_WRONG_SLOT commercial_invoice:bill_of_lading' && ok.a === true && ok.b === false) || J({ r: r.document, m: m.draft, w, ok });
  });
  await check('review: an ai-doc-v3 reading is saved only under the SHA-256 bound to its usage by the Edge Function (MRS_INVALID source_sha256 otherwise)', async () => {
    const mk = async () => (await one(`INSERT INTO app.ai_usage (org_id, user_id, purpose, status, model, reserved_usd) VALUES ($1, $2, 'doc_extract', 'reserved',
                                        'claude-opus-5-5', 0.48) RETURNING id`, [A, U.jed])).id;
    const settle = id => q(`UPDATE app.ai_usage SET status = 'ok', cost_usd = 0.01 WHERE id = $1`, [id]);
    const ins = (usage, h) => code(() => as('jed', `INSERT INTO public.document_extractions (org_id, doc_type, source_name, source_sha256, engine, languages,
      raw_text, created_by, ai_usage_id, ai_detail) VALUES ($1, 'bill_of_lading', 'x.pdf', $2, 'claude-opus-5-5', 'auto', 'x', $3, $4, $5)`, [A, h, U.jed, usage, J(det('bill_of_lading'))]));
    const H = 'ab'.repeat(32), H2 = 'cd'.repeat(32);
    const u1 = await mk(); await settle(u1);
    const unbound = await ins(u1, H);
    const u2 = await mk();
    const notSvc = await code(() => rpc('jed', `SELECT public.ai_bind_source($1, $2) r`, [u2, H]));
    const bound = await rpc('service', `SELECT public.ai_bind_source($1, $2) r`, [u2, H]);
    const twice = await code(() => rpc('service', `SELECT public.ai_bind_source($1, $2) r`, [u2, H2]));
    const badHash = await code(() => rpc('service', `SELECT public.ai_bind_source($1, 'x') r`, [u2]));
    await settle(u2);
    const after = await code(() => q(`UPDATE app.ai_usage SET source_sha256 = $2 WHERE id = $1`, [u2, H2]));
    const wrong = await ins(u2, H2);
    const right = await ins(u2, H);
    const settledBind = await code(() => rpc('service', `SELECT public.ai_bind_source($1, $2) r`, [u1, H]));
    return (unbound === 'MRS_INVALID source_sha256' && (notSvc === 'perm' || notSvc === 'MRS_FORBIDDEN service_only') && bound.source_sha256 === H
      && twice === 'MRS_BAD_TRANSITION bound' && badHash === 'MRS_INVALID source_sha256' && /MRS_APPEND_ONLY|MRS_IMMUTABLE/.test(after)
      && wrong === 'MRS_INVALID source_sha256' && right === 'ok' && settledBind === 'MRS_BAD_TRANSITION bound') || J({ unbound, notSvc, bound, twice, badHash, after, wrong, right, settledBind });
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
  pass('database ready');
  await secReadings();
  await secAgents();
  await secBatches();
  await secCompare();
  await secApprove();
  await secMatching();
  await secReview();
  await secRls();
  await secStatic();
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
}
main().catch(e => { console.error(e); process.exit(1); });
