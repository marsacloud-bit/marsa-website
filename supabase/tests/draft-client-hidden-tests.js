#!/usr/bin/env node
/*
  Marsa (مرسى) — a DRAFT transaction is hidden from the portal client: migration 20261203000100_draft_client_hidden.sql.
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network (fetch throws).
  Invented data only (seed org "blue-sea" + made-up users / numbers).

  Covers: file conventions + all_migrations.sql; preflight refusal; re-run on itself (identical catalog);
    a draft of client A made the real way (doc batch → create_draft_transaction) with containers, a B/L, a customs declaration
    (approve_declaration_extraction), events (client-visible ones too), a port appointment, a transport trip, a client-visible
    document + its Storage object, an issued invoice and a tracking token:
      the portal client of A sees none of it — direct selects on every table (transactions, containers, transaction_bls,
      bills_of_lading, customs_declarations, transaction_events, documents, storage.objects, port_appointments,
      transport_trips, billing_intents), the portal reads (containers + transactions(ref) embed), portal_invoices (list +
      p_tx → MRS_NOT_FOUND), public_track (own ref + token → not_found; a request converted into the draft → the request
      only) and cannot upload a document to it;
      staff of the branch see all of it; staff of another branch / org and another client see nothing;
      a non-draft transaction of A stays visible to the client (rows, timeline, public_track);
    after approve_transaction: the client sees the transaction, its containers / B/L / declaration / document, the
      client events by the existing visible_to_client rules ('created' of the draft stays hidden, 'tx_approval' shows),
      portal_invoices and public_track;
    staff visibility unchanged: per staff user the visible row counts equal those under the previous definitions (the
      down-path bodies re-pasted), which show the draft to the client again (the bug), and re-applying gives the same catalog.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/draft-client-hidden-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261203000100_draft_client_hidden.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in draft-client-hidden-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'd7a50000-0000-4000-8000-0000000000b0';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const TX_JED = '0b5e0000-0000-4000-8000-000000000201';      // seed: a normal (non-draft) transaction of client A
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const CLIENT_A2 = '0b5e0000-0000-4000-8000-000000000102';
const U = {
  admin: 'd7a51000-0000-4000-8000-000000000001',
  acc: 'd7a51000-0000-4000-8000-000000000002',      // accountant (finance reader)
  jed: 'd7a51000-0000-4000-8000-000000000005',      // clearance_staff, JED (ops writer)
  dmm: 'd7a51000-0000-4000-8000-000000000006',      // clearance_staff, DMM (another branch)
  portal: 'd7a51000-0000-4000-8000-000000000008',   // client user of CLIENT_A
  portal2: 'd7a51000-0000-4000-8000-000000000009',  // client user of CLIENT_A2
  staffB: 'd7a51000-0000-4000-8000-00000000000a'    // admin of B
};
const DMM = '0b5e0000-0000-4000-8000-000000000012';

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
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
let keySeq = 0;
const newKey = () => 'd7a5aaab-0000-4000-8000-' + String(++keySeq).padStart(12, '0');
let shaSeq = 0;
const sha = () => (++shaSeq).toString(16).padStart(64, 'e');
// ISO 6346 check digit
function iso(prefix4, six) {
  const v = prefix4 + six;
  const L = [10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38];
  let s = 0;
  for (let i = 0; i < 10; i++) { const c = v[i]; const n = /[0-9]/.test(c) ? +c : L[c.charCodeAt(0) - 65]; s += n * (1 << i); }
  return v + String((s % 11) % 10);
}
let ctrSeq = 0, blSeq = 0;
const nextCtr = () => iso('DCHU', String(400000 + (++ctrSeq)));
const nextBl = () => 'DCBL' + String(8000000 + (++blSeq));

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const pol = (await q(`SELECT schemaname || '.' || tablename || '.' || policyname || ':' || cmd || ':' || roles::text || ':' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) x
                          FROM pg_policies ORDER BY 1`)).map(x => x.x);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname || ':' || md5(pg_get_triggerdef(t.oid)) x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         WHERE NOT t.tgisinternal ORDER BY 1`)).map(x => x.x);
  return { fns, pol, trg };
}

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@dch.example.com', now()), ('${U.acc}', 'acc@dch.example.com', now()),
    ('${U.jed}', 'jed@dch.example.com', now()), ('${U.dmm}', 'dmm@dch.example.com', now()),
    ('${U.portal}', 'portal@dch.example.com', now()), ('${U.portal2}', 'portal2@dch.example.com', now()),
    ('${U.staffB}', 'staffb@dch.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'مدير تجريبي'), ('${U.acc}', 'محاسب تجريبي'), ('${U.jed}', 'موظف جدة'),
    ('${U.dmm}', 'موظف الدمام'), ('${U.portal}', 'عميل البوابة'), ('${U.portal2}', 'عميل آخر'), ('${U.staffB}', 'مدير ب')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'dch-org-b', 'مؤسسة ب', 'Draft hidden org B', 'DCB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.acc}', '${A}', NULL, 'accountant'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff'),
    ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner'),
    ('${A}', '${CLIENT_A2}', '${U.portal2}', 'owner');
`;

/* ------------------------------------------------------------------ the draft flow (as tx-draft-sql-tests) */
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
const getB = (who, b) => rpc(who || 'jed', `SELECT public.get_doc_batch($1) r`, [b]);
async function draftOf() {
  const blNo = nextBl(), ctr = [nextCtr(), nextCtr()];
  const b = await rpc('jed', `SELECT public.create_doc_batch($1, $2) r`, [A, {}]);
  const bl = await ext({ kind: 'bill_of_lading', fields: { bl_number: blNo, vessel: 'MSC TEST', voyage: '001A', port_of_loading: 'Shanghai',
    port_of_discharge: 'Jeddah Islamic Port', consignee: 'CONSIGNEE: TEST TRADING CO. ONE\nP.O. BOX 1 JEDDAH', shipper: 'SHANGHAI SUPPLIER LTD',
    gross_weight: '1200', net_weight: '1000', packages_count: '40', package_type: 'CTNS', goods_description: 'Brake pads', shipping_line: 'MSC',
    container_numbers: ctr.join(', ') },
    detail: det('bill_of_lading', ctr.map(c => ({ container_number: c, size_type: '40HC', gross_weight: 600 }))) });
  const inv = await ext({ kind: 'commercial_invoice', fields: { invoice_number: 'INV-' + blNo, invoice_date: '2026-10-01', supplier_name: 'SHANGHAI SUPPLIER LTD',
    buyer_name: 'TEST TRADING CO. ONE', currency: 'USD', total: '5000', incoterms: 'CFR Jeddah', country_of_origin: 'China', bl_number: blNo },
    items: [{ description: 'Brake pads', hs_code: '870830', quantity: 40, unit: 'CARTON', unit_price: 125, amount: 5000, net_weight: 1000 }],
    detail: det('commercial_invoice') });
  await rpc('jed', `SELECT public.attach_doc_batch_document($1, $2) r`, [b.id, { extraction_id: bl, slot: 'bill_of_lading' }]);
  await rpc('jed', `SELECT public.attach_doc_batch_document($1, $2) r`, [b.id, { extraction_id: inv, slot: 'commercial_invoice' }]);
  const m = await rpc('jed', `SELECT public.merge_doc_batch($1) r`, [b.id]);
  const g0 = await getB('jed', b.id);
  const sv = await rpc('jed', `SELECT public.save_doc_batch_draft($1, $2) r`, [b.id, { version: g0.version, draft: m.draft }]);
  const r = await rpc('jed', `SELECT public.create_draft_transaction($1, $2) r`,
    [b.id, { version: sv.version, new_transaction: { client_id: CLIENT_A }, idempotencyKey: newKey() }]);
  return { tx: r.transaction_id, ref: r.ref, res: r, bl, inv, blNo, ctr };
}
async function approveDecl(tx, blNo, ctrs) {
  const no = '3' + String(600000 + (++blSeq));
  const fields = { declaration_number: no, declaration_type: 'import', declaration_status: 'accepted', declaration_date: '2026-10-07',
    declaration_date_hijri: '1448/04/15', vessel: 'MSC TEST', country_of_origin: 'الصين', container_numbers: ctrs.join(', '),
    importer_name_ar: 'شركة الاختبار الأولى للتجارة', invoice_number: 'INV-D1', total: '5000', currency: 'USD', bl_number: blNo };
  const e = await ext({ kind: 'customs_declaration', fields,
    items: [{ description: 'فحمات فرامل', hs_code: '870830', quantity: 40, unit: 'كرتون', amount: 5000, origin_country: 'الصين' }],
    detail: det('customs_declaration', ctrs.map(c => ({ container_number: c, size_type: '40HC', gross_weight: 600 })),
      { type_evidence: 'بيان استيراد', status_raw: 'accepted', bl_raw: blNo, bl_candidates: [blNo], bl_rtl_affected: false,
        date_printed: '2026-10-07', date_from_hijri: '2026-10-07', hijri_supported: true }) });
  const rv = await rpc('jed', `SELECT public.get_declaration_review($1, $2) r`, [e, tx]);
  const r = await rpc('jed', `SELECT public.approve_declaration_extraction($1, $2, $3) r`, [e, tx, { version: rv.version }]);
  return { extraction: e, result: r };
}
function row3(key, status, critical) {
  return { key, label_ar: 'حقل', label_en: 'Field', values: { invoice: 'A', bl: 'A', declaration: 'A' }, status, detail_ar: '', detail_en: '',
    critical: !!critical, conf: { invoice: 0.9, bl: 0.9, declaration: 0.9 }, pairs: { inv_bl: status, inv_decl: status, bl_decl: status } };
}
const saveMatch = (tx, inv, bl, decl) => rpc('jed', `SELECT public.save_document_match($1, $2) r`, [A, {
  invoice_extraction_id: inv, bl_extraction_id: bl, declaration_extraction_id: decl, transaction_id: tx, mode: 'three_way',
  engine_version: 'match-v1', overall: 'match', counts: { match: 3 },
  rows: [row3('bl_number', 'match', true), row3('consignee', 'match'), row3('gross_weight', 'match', true)], reviewed_rows: [] }]);

/* ------------------------------------------------------------------ what a user sees of one transaction */
const TX_TABLES = ['transactions', 'containers', 'transaction_bls', 'customs_declarations', 'transaction_events', 'documents',
  'port_appointments', 'transport_trips', 'billing_intents'];
async function seen(who, tx) {
  const out = {};
  for (const t of TX_TABLES) {
    const col = t === 'transactions' ? 'id' : 'transaction_id';
    out[t] = Number((await as(who, `SELECT count(*) n FROM public.${t} WHERE ${col} = $1`, [tx]))[0].n);
  }
  out.bills_of_lading = Number((await as(who, `SELECT count(*) n FROM public.bills_of_lading b
                                                 WHERE b.id IN (SELECT tb.bl_id FROM public.transaction_bls tb WHERE tb.transaction_id = $1)
                                                    OR b.bl_number IN (SELECT t.bl_number FROM public.transactions t WHERE t.id = $1)`, [tx]))[0].n);
  out.objects = Number((await as(who, `SELECT count(*) n FROM storage.objects WHERE bucket_id = 'documents' AND split_part(name, '/', 2) = $1`, [tx]))[0].n);
  return out;
}
const total = o => Object.values(o).reduce((a, b) => a + b, 0);

/* ------------------------------------------------------------------ 1. file */
async function secFile() {
  section('1. file + all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('migration: preflight on org_logo (20261202000100), schema_versions row, no BEGIN/COMMIT, down-path, search_path pinned', () => {
    const fns = (s.match(/CREATE OR REPLACE FUNCTION/g) || []).length, pinned = (s.match(/SET search_path = ''/g) || []).length;
    return (/version = '20261202000100'/.test(s) && /VALUES \('20261203000100', 'draft_client_hidden'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s)
      && /Down-path:/.test(s) && fns === 4 && pinned === 4) || J({ fns, pinned });
  });
  await check('changes no data / grants: no INSERT / UPDATE / DELETE outside function bodies (but schema_versions), no GRANT / REVOKE, no aal2', () => {
    const c = s.replace(/^--.*$/gm, '').replace(/AS \$\$[\s\S]*?\$\$;/g, '').replace(/DO \$pre\$[\s\S]*?\$pre\$;/g, '');
    const w = (c.match(/\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+[\w.]+/g) || []).filter(x => !/public\.schema_versions/.test(x));
    return (w.length === 0 && !/\b(GRANT|REVOKE)\b/.test(c) && !/aal2/.test(s.replace(/^--.*$/gm, ''))) || J(w);
  });
  await check('the four client paths re-created: is_tx_client, transactions_select, portal_invoices, public_track (each excludes is_draft)', () => {
    const body = (re) => (s.match(re) || [''])[0];
    return (/NOT t\.is_draft AND app\.is_client_user\(t\.client_id\)/.test(body(/FUNCTION app\.is_tx_client[\s\S]*?\$\$;/))
      && /CREATE POLICY transactions_select ON public\.transactions FOR SELECT TO authenticated\s+USING \(app\.has_branch_role\(org_id, branch_id, app\.staff_roles\(\)\) OR \(NOT is_draft AND app\.is_client_user\(client_id\)\)\);/.test(s)
      && (body(/FUNCTION public\.portal_invoices[\s\S]*?END \$\$;/).match(/is_draft/g) || []).length === 2
      && (body(/FUNCTION public\.public_track[\s\S]*?END \$\$;/).match(/NOT t\.is_draft/g) || []).length === 2) || 'bodies';
  });
  await check('is_bl_client re-created: own non-draft link required; only a link to another client\'s transaction hides (a own draft is ignored)', () => {
    const b = (s.match(/FUNCTION app\.is_bl_client[\s\S]*?\$\$;/) || [''])[0];
    return (/EXISTS \(SELECT 1 FROM public\.transaction_bls tb WHERE tb\.bl_id = p_bl AND app\.is_tx_client\(tb\.transaction_id\)\)/.test(b)
      && /NOT EXISTS \(SELECT 1 FROM public\.transaction_bls tb JOIN public\.transactions t ON t\.id = tb\.transaction_id\s+WHERE tb\.bl_id = p_bl AND NOT app\.is_client_user\(t\.client_id\)\)/.test(b)
      && /app\.is_bl_client from\s+(--\s+)?20261103000100/.test(s)) || 'is_bl_client body / down-path';
  });
  // later phases (each has its own suite) follow it, in order
  const LATER_PHASES = ['20261204000100_tx_stage_sets.sql', '20261205000100_service_item_price.sql', '20261206000100_storage_gate.sql', '20261207000100_driver_classes.sql'];
  await check('this file is the latest migration (later phases excepted)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && J(later) === J(LATER_PHASES)) || 'later ' + J(later);
  });
  const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
  await check('all_migrations.sql: appended verbatim under its header (followed only by the later phases); the paste note names it', () => {
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const later = order.slice(order.indexOf(MIG) + 1);
    return (i > 0 && body === s && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles()) && J(later) === J(LATER_PHASES))
      || 'not appended verbatim / no note / order / later ' + J(later);
  });
}

/* ------------------------------------------------------------------ 2. preflight + re-run */
async function secRerun() {
  section('2. preflight + re-run');
  await check('preflight: refused without org_logo (nothing changed)', async () => {
    await q(`DELETE FROM public.schema_versions WHERE version = '20261202000100'`);
    const c0 = J(await catalog());
    const r = await code(() => db.exec(fs.readFileSync(MIG_FILE, 'utf8')));
    await q(`INSERT INTO public.schema_versions (version, name) VALUES ('20261202000100', 'org_logo')`);
    return (/DRAFT CLIENT HIDDEN preflight/.test(r) && J(await catalog()) === c0) || r;
  });
  await check('re-run on itself: identical catalog (functions, policies, triggers), one schema_versions row', async () => {
    const c1 = J(await catalog());
    await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
    return (J(await catalog()) === c1 && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261203000100'`)) === 1) || 'changed';
  });
  await check('privileges kept: is_tx_client / is_bl_client authenticated (not anon); portal_invoices authenticated (not anon); public_track anon + authenticated', async () => {
    const r = await one(`SELECT has_function_privilege('authenticated', 'app.is_tx_client(uuid)', 'EXECUTE') a,
                                has_function_privilege('authenticated', 'app.is_bl_client(uuid)', 'EXECUTE') g,
                                has_function_privilege('anon', 'app.is_bl_client(uuid)', 'EXECUTE') h,
                                has_function_privilege('anon', 'app.is_tx_client(uuid)', 'EXECUTE') b,
                                has_function_privilege('authenticated', 'public.portal_invoices(uuid)', 'EXECUTE') c,
                                has_function_privilege('anon', 'public.portal_invoices(uuid)', 'EXECUTE') d,
                                has_function_privilege('anon', 'public.public_track(text,text)', 'EXECUTE') e,
                                has_function_privilege('authenticated', 'public.public_track(text,text)', 'EXECUTE') f`);
    return (r.a && !r.b && r.c && !r.d && r.e && r.f && r.g && !r.h) || J(r);
  });
}

/* ------------------------------------------------------------------ 3. the draft and everything hanging off it */
let SHARED_BL, D, TOK, REQ_TOK, REQ_REF, DOC_ID, NON_DRAFT_TOK, NON_DRAFT_REF;
async function secSetup() {
  section('3. a draft of client A with containers / B/L / declaration / events / appointment / trip / document / invoice / token');
  D = await draftOf();
  await check('create_draft_transaction made a draft of client A (JED) with its containers', async () => {
    const t = await one(`SELECT is_draft, client_id, branch_id FROM public.transactions WHERE id = $1`, [D.tx]);
    return (t.is_draft === true && t.client_id === CLIENT_A && t.branch_id === JED
      && (await num(`SELECT count(*) n FROM public.containers WHERE transaction_id = $1`, [D.tx])) === 2) || J(t);
  });
  D.decl = await approveDecl(D.tx, D.blNo, D.ctr);
  // a client-visible note event, a port appointment, a transport trip, a client-visible document (+ its Storage object), an
  // issued invoice — staff rows written as the definer would (no API guard on the superuser)
  await q(`INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, visible_to_client, actor)
           VALUES ($1, $2, 'note', 'ملاحظة للعميل', true, $3)`, [A, D.tx, U.jed]);
  await q(`INSERT INTO public.port_appointments (org_id, transaction_id, appointment_at) VALUES ($1, $2, now() + interval '2 days')`, [A, D.tx]);
  await q(`INSERT INTO public.transport_trips (org_id, transaction_id) VALUES ($1, $2)`, [A, D.tx]);
  DOC_ID = (await one(`SELECT gen_random_uuid() id`)).id;
  await q(`INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, mime_type, size_bytes, visibility, uploaded_by)
           VALUES ($1, $2, $3, 'other', $4, $5, 'bl.pdf', 'application/pdf', 1000, 'client', $6)`,
    [DOC_ID, A, D.tx, A + '/' + D.tx + '/' + DOC_ID + '/bl.pdf', sha(), U.jed]);
  await q(`INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('documents', $1, $2)`, [A + '/' + D.tx + '/' + DOC_ID + '/bl.pdf', U.jed]);
  await q(`INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose_key, operational_ref, status, issued_at, daftra_number)
           VALUES ($1, $2, $3, 'F', $4, 'issued', now(), 'INV-DRAFT-1')`, [A, D.tx, CLIENT_A, D.ref]);
  const tk = await rpc('jed', `SELECT public.issue_tracking_token($1, $2) r`, [D.tx, newKey()]);
  TOK = tk.tracking_token;
  // a public request whose transaction is the draft (the request shows, the transaction does not)
  REQ_TOK = 'ab'.repeat(32); REQ_REF = 'BSR-2026-990001';
  const rq = await one(`INSERT INTO public.service_requests (org_id, ref, full_name, phone, direction, service, mode, port, goods, tracking_token_hash)
                        VALUES ($1, $2, 'طالب تجريبي', '0500000000', 'import', 'clearance', 'sea', 'ميناء جدة الإسلامي', 'بضاعة تجريبية',
                                app.hash_token($3)) RETURNING id`, [A, REQ_REF, REQ_TOK]);
  await q(`UPDATE public.transactions SET request_id = $2 WHERE id = $1`, [D.tx, rq.id]);
  // the seed transaction of client A (not a draft) gets a token too
  const tk2 = await rpc('jed', `SELECT public.issue_tracking_token($1, $2) r`, [TX_JED, newKey()]);
  NON_DRAFT_TOK = tk2.tracking_token; NON_DRAFT_REF = tk2.ref;
  await check('fixture rows exist (superuser view): declaration, events (client-visible ones too), appointment, trip, document, object, invoice', async () => {
    const r = await one(`SELECT (SELECT count(*) FROM public.customs_declarations WHERE transaction_id = $1) d,
                                (SELECT count(*) FROM public.transaction_events WHERE transaction_id = $1 AND visible_to_client) ev,
                                (SELECT count(*) FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'created' AND NOT visible_to_client) cr,
                                (SELECT count(*) FROM public.port_appointments WHERE transaction_id = $1) a,
                                (SELECT count(*) FROM public.transport_trips WHERE transaction_id = $1) t,
                                (SELECT count(*) FROM public.documents WHERE transaction_id = $1 AND visibility = 'client') doc,
                                (SELECT count(*) FROM public.transaction_bls WHERE transaction_id = $1) bl,
                                (SELECT count(*) FROM public.billing_intents WHERE transaction_id = $1 AND status = 'issued') inv`, [D.tx]);
    return (+r.d >= 1 && +r.ev >= 2 && +r.cr === 1 && +r.a === 1 && +r.t === 1 && +r.doc === 1 && +r.bl >= 1 && +r.inv === 1) || J(r);
  });
}

/* ------------------------------------------------------------------ 4. the client sees nothing of the draft */
async function secClientHidden() {
  section('4. the portal client of A sees nothing of the draft (direct selects + portal / tracking RPCs)');
  await check('direct selects as the client: 0 rows on every transaction-linked table (+ bills_of_lading, storage.objects)', async () => {
    const s = await seen('portal', D.tx);
    return total(s) === 0 || J(s);
  });
  await check('portal reads: listTransactions / getTransaction (+ containers embed), listMyContainers (+ transactions(ref)), listEvents, listDocuments', async () => {
    const r = [
      await as('portal', `SELECT id FROM public.transactions WHERE id = $1 OR ref = $2`, [D.tx, D.ref]),
      await as('portal', `SELECT c.id FROM public.containers c WHERE c.container_no = ANY($1)`, [D.ctr]),
      await as('portal', `SELECT e.id FROM public.transaction_events e WHERE e.transaction_id = $1`, [D.tx]),
      await as('portal', `SELECT d.id FROM public.documents d WHERE d.id = $1`, [DOC_ID])];
    const listAll = await as('portal', `SELECT id FROM public.transactions`);
    const ctrAll = await as('portal', `SELECT transaction_id FROM public.containers`);
    return (r.every(x => x.length === 0) && !listAll.some(x => x.id === D.tx) && listAll.some(x => x.id === TX_JED)
      && !ctrAll.some(x => x.transaction_id === D.tx) && ctrAll.some(x => x.transaction_id === TX_JED)) || J({ r: r.map(x => x.length), listAll });
  });
  await check('portal_invoices: the draft\'s issued invoice is not listed; p_tx = the draft → MRS_NOT_FOUND transaction', async () => {
    const l = await rpc('portal', `SELECT public.portal_invoices(NULL) r`);
    const c = await code(() => as('portal', `SELECT public.portal_invoices($1) r`, [D.tx]));
    return (!l.items.some(x => x.transaction_id === D.tx) && c === 'MRS_NOT_FOUND transaction') || J({ l, c });
  });
  await check('public_track (anon and the client): the draft\'s own ref + token → {"not_found": true}', async () => {
    const a = await rpc('anon', `SELECT public.public_track($1, $2) r`, [D.ref, TOK]);
    const b = await rpc('portal', `SELECT public.public_track($1, $2) r`, [D.ref, TOK]);
    return (a && a.not_found === true && b && b.not_found === true && !J(a).includes(D.ref.slice(-6))) || J({ a, b });
  });
  await check('public_track: a request converted into the draft shows the request only (no transaction key)', async () => {
    const r = await rpc('anon', `SELECT public.public_track($1, $2) r`, [REQ_REF, REQ_TOK]);
    return (r && r.kind === 'request' && r.request && r.request.ref === REQ_REF && !('transaction' in r)) || J(r);
  });
  await check('the client cannot upload a document to the draft (documents_insert → RLS)', async () => {
    const id = (await one(`SELECT gen_random_uuid() id`)).id;
    const r = await code(() => as('portal', `INSERT INTO public.documents (id, org_id, transaction_id, kind, storage_path, sha256, original_name, size_bytes, visibility, uploaded_by)
                                              VALUES ($1, $2, $3, 'other', $4, $5, 'x.pdf', 10, 'client', $6)`,
      [id, A, D.tx, A + '/' + D.tx + '/' + id + '/x.pdf', sha(), U.portal]));
    return r === 'rls' || r;
  });
  await check('helpers: is_tx_client / can_read_transaction false for the client on the draft, true on the non-draft', async () => {
    const r = await as('portal', `SELECT app.is_tx_client($1) a, app.can_read_transaction($1) b, app.is_tx_client($2) c, app.can_read_transaction($2) d`, [D.tx, TX_JED]);
    return (r[0].a === false && r[0].b === false && r[0].c === true && r[0].d === true) || J(r);
  });
  await check('another client (A2), staff of another branch (DMM) and of another org (B) see nothing of the draft', async () => {
    const r = [total(await seen('portal2', D.tx)), total(await seen('dmm', D.tx)), total(await seen('staffB', D.tx))];
    return r.every(x => x === 0) || J(r);
  });
}

/* ------------------------------------------------------------------ 5. staff + the non-draft */
async function secStaff() {
  section('5. staff see the draft; a non-draft transaction of A stays visible to the client');
  await check('staff of the branch (jed) and the org admin see the draft and every row hanging off it', async () => {
    const j = await seen('jed', D.tx), a = await seen('admin', D.tx);
    const okJ = j.transactions === 1 && j.containers === 2 && j.customs_declarations >= 1 && j.transaction_events >= 3 && j.documents === 1
      && j.port_appointments === 1 && j.transport_trips === 1 && j.transaction_bls >= 1 && j.objects === 1;
    return (okJ && a.transactions === 1 && a.billing_intents === 1 && a.documents === 1) || J({ j, a });
  });
  await check('the accountant (finance reader) sees the draft\'s invoice row', async () => (await seen('acc', D.tx)).billing_intents === 1 || 'no');
  await check('non-draft TX_JED: the client sees the transaction, its containers, declaration and client events', async () => {
    const s = await seen('portal', TX_JED);
    return (s.transactions === 1 && s.containers === 2 && s.customs_declarations >= 1 && s.transaction_events >= 1
      && s.port_appointments === 0 && s.transport_trips === 0) || J(s);
  });
  await check('non-draft TX_JED: public_track with its token → the transaction and its timeline', async () => {
    const r = await rpc('anon', `SELECT public.public_track($1, $2) r`, [NON_DRAFT_REF, NON_DRAFT_TOK]);
    return (r && r.kind === 'transaction' && r.transaction && r.transaction.ref === NON_DRAFT_REF && r.transaction.timeline.length >= 1
      && r.transaction.containers.total === 2) || J(r);
  });
  // a B/L shared by the live TX_JED and the draft of the same client (split B/L: the OCR flow for the rest of the shipment)
  SHARED_BL = (await one(`INSERT INTO public.bills_of_lading (org_id, bl_number, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [A, nextBl(), U.jed])).id;
  await check('fixture: staff link one B/L to the live TX_JED and to the draft (link_bl); the client\'s draft-only B/L is a separate one', async () => {
    const a = await rpc('jed', `SELECT public.link_bl($1, $2, false) r`, [TX_JED, SHARED_BL]);
    const b = await rpc('jed', `SELECT public.link_bl($1, $2, false) r`, [D.tx, SHARED_BL]);
    return (a.bl_id === SHARED_BL && b.bl_id === SHARED_BL && a.shared_with_other_client === false && b.shared_with_other_client === false
      && (await num(`SELECT count(*) n FROM public.transaction_bls WHERE bl_id = $1`, [SHARED_BL])) === 2) || J({ a, b });
  });
  await check('shared B/L: the client still reads it through the live TX_JED while the draft is a draft (is_bl_client true)', async () => {
    const r = await as('portal', `SELECT (SELECT count(*) FROM public.bills_of_lading WHERE id = $1) n, app.is_bl_client($1) v,
                                         (SELECT count(*) FROM public.transaction_bls WHERE bl_id = $1 AND transaction_id = $2) live,
                                         (SELECT count(*) FROM public.transaction_bls WHERE bl_id = $1 AND transaction_id = $3) dr`,
      [SHARED_BL, TX_JED, D.tx]);
    const s = await seen('portal', TX_JED);
    return (+r[0].n === 1 && r[0].v === true && +r[0].live === 1 && +r[0].dr === 0 && s.bills_of_lading >= 1) || J({ r, s });
  });
  await check('the draft-only B/L stays hidden from the client; another client (A2) does not see the shared B/L', async () => {
    const r = await as('portal', `SELECT count(*) n, bool_or(app.is_bl_client(id)) v FROM public.bills_of_lading WHERE bl_number = $1`, [D.blNo]);
    const any = await num(`SELECT count(*) n FROM public.bills_of_lading WHERE bl_number = $1`, [D.blNo]);
    const o = await as('portal2', `SELECT count(*) n FROM public.bills_of_lading WHERE id = $1`, [SHARED_BL]);
    return (any === 1 && +r[0].n === 0 && +o[0].n === 0) || J({ r, any, o });
  });
  await check('a draft of ANOTHER client on the B/L still hides it from the client (the consolidated-B/L rule)', async () => {
    const other = await one(`INSERT INTO public.bills_of_lading (org_id, bl_number, created_by) VALUES ($1, $2, $3) RETURNING id`, [A, nextBl(), U.jed]);
    await rpc('jed', `SELECT public.link_bl($1, $2, false) r`, [TX_JED, other.id]);
    const before = +(await as('portal', `SELECT count(*) n FROM public.bills_of_lading WHERE id = $1`, [other.id]))[0].n;
    await q(`UPDATE public.transactions SET client_id = $2 WHERE id = $1`, [D.tx, CLIENT_A2]);
    let after;
    try {
      await q(`INSERT INTO public.transaction_bls (transaction_id, bl_id, org_id) VALUES ($1, $2, $3)`, [D.tx, other.id, A]);
      after = +(await as('portal', `SELECT count(*) n FROM public.bills_of_lading WHERE id = $1`, [other.id]))[0].n;
    } finally {
      await q(`DELETE FROM public.transaction_bls WHERE transaction_id = $1 AND bl_id = $2`, [D.tx, other.id]);
      await q(`UPDATE public.transactions SET client_id = $2 WHERE id = $1`, [D.tx, CLIENT_A]);
      await q(`DELETE FROM public.transaction_bls WHERE transaction_id = $1 AND bl_id = $2`, [TX_JED, other.id]);
      await q(`DELETE FROM public.bills_of_lading WHERE id = $1`, [other.id]);
    }
    return (before === 1 && after === 0) || J({ before, after });
  });
}

/* ------------------------------------------------------------------ 6. staff visibility unchanged (vs the previous definitions) */
const OLD_SQL = () => {
  const rls = fs.readFileSync(path.join(MIG_DIR, '20261031000300_security_rls.sql'), 'utf8');
  const g6a = fs.readFileSync(path.join(MIG_DIR, '20261106000100_g6a_portal_reports.sql'), 'utf8');
  const ltx = fs.readFileSync(path.join(MIG_DIR, '20261118000100_legacy_tx.sql'), 'utf8');
  const g3 = fs.readFileSync(path.join(MIG_DIR, '20261103000100_g3_registry.sql'), 'utf8');
  const fnOf = (src, re, end) => { const i = src.search(re); return src.slice(i, src.indexOf(end, i) + end.length); };
  return [fnOf(rls, /CREATE OR REPLACE FUNCTION app\.is_tx_client/, '$$;'),
    'DROP POLICY IF EXISTS transactions_select ON public.transactions;',
    fnOf(rls, /CREATE POLICY transactions_select/, ';'),
    fnOf(g3, /CREATE OR REPLACE FUNCTION app\.is_bl_client/, '$$;'),
    fnOf(g6a, /CREATE OR REPLACE FUNCTION public\.portal_invoices/, 'END $$;'),
    fnOf(ltx, /CREATE OR REPLACE FUNCTION public\.public_track/, 'END $$;'),
    `DELETE FROM public.schema_versions WHERE version = '20261203000100';`].join('\n');
};
const STAFF = ['admin', 'acc', 'jed', 'dmm', 'staffB'];
async function staffSnapshot() {
  const out = {};
  for (const w of STAFF) {
    out[w] = {};
    for (const t of TX_TABLES.concat(['bills_of_lading'])) out[w][t] = Number((await as(w, `SELECT count(*) n FROM public.${t}`))[0].n);
    out[w].objects = Number((await as(w, `SELECT count(*) n FROM storage.objects WHERE bucket_id = 'documents'`))[0].n);
    out[w].track = J(await rpc(w, `SELECT public.public_track($1, $2) r`, [NON_DRAFT_REF, NON_DRAFT_TOK]));
  }
  return out;
}
// the client side of the non-draft TX_JED (every transaction-linked table + its B/Ls, incl. the one shared with the draft)
const CLIENTS = ['portal', 'portal2'];
async function clientSnapshot() {
  const out = {};
  for (const w of CLIENTS) {
    out[w] = await seen(w, TX_JED);
    out[w].shared_bl = Number((await as(w, `SELECT count(*) n FROM public.bills_of_lading WHERE id = $1`, [SHARED_BL]))[0].n);
  }
  return out;
}
const OLD_BL_CLIENT = () => {
  const g3 = fs.readFileSync(path.join(MIG_DIR, '20261103000100_g3_registry.sql'), 'utf8');
  const i = g3.search(/CREATE OR REPLACE FUNCTION app\.is_bl_client/);
  return g3.slice(i, g3.indexOf('$$;', i) + 3);
};
async function secStaffUnchanged() {
  section('6. staff visibility unchanged; the down-path restores the old behaviour (the bug); re-applying gives the same catalog');
  const now = await staffSnapshot();
  const cnow = await clientSnapshot();
  const c1 = J(await catalog());
  // the regression this file guards against: the new is_tx_client with the 20261103000100 is_bl_client body
  await db.exec(OLD_BL_CLIENT());
  await check('without the is_bl_client re-creation the client would lose the shared B/L of its live TX_JED (what section 5 fixes)', async () =>
    (cnow.portal.shared_bl === 1 && (await clientSnapshot()).portal.shared_bl === 0) || J(cnow));
  await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
  await db.exec(OLD_SQL());
  await check('down-path (previous bodies re-pasted): the client sees the draft again — the bug this migration fixes', async () => {
    const s = await seen('portal', D.tx);
    return (s.transactions === 1 && s.containers === 2 && s.documents === 1) || J(s);
  });
  const old = await staffSnapshot();
  await check('every staff user sees exactly the same rows under the new and the previous definitions', () => J(now) === J(old) || J({ now, old }));
  const cold = await clientSnapshot();
  await check('the clients see exactly the same rows of the non-draft TX_JED (+ its B/Ls) under the new and the previous definitions', () =>
    (J(cnow) === J(cold) && cnow.portal.transactions === 1 && cnow.portal.shared_bl === 1 && cnow.portal2.shared_bl === 0) || J({ cnow, cold }));
  await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
  await check('re-applied after the down-path: identical catalog, the draft hidden again', async () =>
    (J(await catalog()) === c1 && total(await seen('portal', D.tx)) === 0) || 'catalog / visibility');
}

/* ------------------------------------------------------------------ 7. approval */
async function secApproved() {
  section('7. after approve_transaction the client sees the transaction (events by the existing visible_to_client rules)');
  const m = await saveMatch(D.tx, D.inv, D.bl, D.decl.extraction);
  const R = await rpc('jed', `SELECT public.approve_transaction($1, $2) r`, [D.tx, { match_id: m.id, idempotencyKey: newKey() }]);
  await check('approved: is_draft false', async () => R.is_draft === false && (await one(`SELECT is_draft FROM public.transactions WHERE id = $1`, [D.tx])).is_draft === false || J(R));
  await check('the client now sees the transaction, its containers, B/L link, declaration, document and Storage object', async () => {
    const s = await seen('portal', D.tx);
    return (s.transactions === 1 && s.containers === 2 && s.transaction_bls >= 1 && s.customs_declarations >= 1 && s.documents === 1 && s.objects === 1
      && s.port_appointments === 0 && s.transport_trips === 0 && s.billing_intents === 0) || J(s);
  });
  await check('events: exactly the visible_to_client ones — \'tx_approval\' and the note show, the draft\'s \'created\' stays hidden', async () => {
    const ev = await as('portal', `SELECT event_type FROM public.transaction_events WHERE transaction_id = $1`, [D.tx]);
    const vis = await num(`SELECT count(*) n FROM public.transaction_events WHERE transaction_id = $1 AND visible_to_client`, [D.tx]);
    const types = ev.map(x => x.event_type);
    return (ev.length === vis && types.includes('tx_approval') && types.includes('note') && !types.includes('created')) || J({ types, vis });
  });
  await check('portal_invoices lists the invoice; p_tx = the transaction works', async () => {
    const l = await rpc('portal', `SELECT public.portal_invoices(NULL) r`);
    const one1 = await rpc('portal', `SELECT public.portal_invoices($1) r`, [D.tx]);
    return (l.items.some(x => x.transaction_id === D.tx) && one1.count === 1 && one1.items[0].daftra_number === 'INV-DRAFT-1') || J({ l, one1 });
  });
  await check('public_track: own ref + token → the transaction; the converted request now carries it too', async () => {
    const a = await rpc('anon', `SELECT public.public_track($1, $2) r`, [D.ref, TOK]);
    const b = await rpc('anon', `SELECT public.public_track($1, $2) r`, [REQ_REF, REQ_TOK]);
    return (a.kind === 'transaction' && a.transaction.ref === D.ref && a.transaction.containers.total === 2
      && b.kind === 'request' && b.transaction && b.transaction.ref === D.ref) || J({ a, b });
  });
  await check('another client (A2) still sees nothing of it', async () => total(await seen('portal2', D.tx)) === 0 || 'seen');
}

async function main() {
  await secFile();
  section('load shim + migrations + seed + fixtures');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  pass('database ready');
  await secRerun();
  await secSetup();
  await secClientHidden();
  await secStaff();
  await secStaffUnchanged();
  await secApproved();
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
}
main().catch(e => { console.error(e); process.exit(1); });
