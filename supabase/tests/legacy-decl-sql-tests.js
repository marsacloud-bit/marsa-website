#!/usr/bin/env node
/*
  Marsa (مرسى) — legacy port step 4 (customs declaration reading, approval, HS reference, Fasah sheet audit): migration
  20261120000100_legacy_decl.sql. LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at
  Supabase. No network (fetch throws).

  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea" with branches JED / DMM, org B).
  A user is simulated the way PostgREST does it (role authenticated + request.jwt.claims with an explicit aal).

  Covers: file conventions + all_migrations.sql + docs; preflight, re-run on itself (identical catalog), catalog delta;
  the declaration keys (= extract.js ALL_KEYS_V3) and ai_detail.declaration (extract.js postProcess output accepted, bad
  shapes refused); the helpers (B/L token equivalence SQL ↔ MarsaDocMatch.blEquivalent parity, HS normaliser, status /
  type normalisers, Hijri CHECK); get_declaration_review (draft, comparison, branch scoping, voided / wrong kind / other
  transaction); approve_declaration_extraction (new declaration via add_declaration source ocr, containers with source
  declaration, items, HS learning, reading linked + reviewed, approval row + declaration event, transaction fields only
  when empty, B/L never replaced; refusals: roles, required fields, bad values, stale version, idempotent replay + key
  conflict, already approved, B/L mismatch unless confirmed, other active number, number of another transaction, the
  step-2 duplicate container guard rolling everything back, Ro-Ro; existing declaration: empty fields filled, status
  forward, a backward status kept; the declaration of a step-3 doc batch slot); the HS reference library (learned only
  from approvals, usage count, invoice description from the approved invoice line, legacy scoring exactly, org scope);
  get_transaction_declaration; the Fasah sheet export audit (log_report_export fasah_sheet); RLS on the 3 tables,
  containers.source for API callers, function privileges, conversion lists; supa.js wrappers and i18n messages.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/legacy-decl-sql-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261120000100_legacy_decl.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const XJS = require(path.join(SUPA, 'functions', 'ai-extract', 'extract.js'));
const DM = require(path.join(ROOT, 'assets', 'js', 'doc-match.js'));
const MN = require(path.join(ROOT, 'assets', 'js', 'legacy-norm.js'));

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in legacy-decl-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'decd0000-0000-4000-8000-0000000000b0';           // second org (fixture)
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const BR_B = 'decd0000-0000-4000-8000-0000000000b1';
const CL_B = 'decd0000-0000-4000-8000-0000000000b3';
const U = {
  admin: 'dece0000-0000-4000-8000-000000000001',    // admin of A (org-wide)
  acc: 'dece0000-0000-4000-8000-000000000002',      // accountant of A (staff, not an ops writer)
  jed: 'dece0000-0000-4000-8000-000000000005',      // clearance_staff of A, JED only
  dmm: 'dece0000-0000-4000-8000-000000000006',      // clearance_staff of A, DMM only
  trn: 'dece0000-0000-4000-8000-000000000007',      // transport_staff of A, JED (staff, not an ops writer)
  portal: 'dece0000-0000-4000-8000-000000000008',   // client user of CLIENT_A
  stranger: 'dece0000-0000-4000-8000-000000000009', // no membership
  staffB: 'dece0000-0000-4000-8000-00000000000a'    // admin of B
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
const newKey = () => 'decdaaab-0000-4000-8000-' + String(++keySeq).padStart(12, '0');
let shaSeq = 0;
const sha = () => (++shaSeq).toString(16).padStart(64, 'd');
const ctr = p => p + XJS.iso6346CheckDigit(p);       // a valid ISO 6346 number from its 10-character prefix
let ctrSeq = 0;
const nextCtr = () => ctr('DECU' + String(100000 + (++ctrSeq)));

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
const NEW_TABLES = ['public.declaration_approvals', 'public.declaration_items', 'public.hs_reference'];
const NEW_FNS = ['app.bl_equivalent', 'app.bl_tokens', 'app.decl_compare', 'app.decl_draft_of', 'app.decl_merge_notes', 'app.decl_reading', 'app.decl_review_version',
  'app.decl_try_date', 'app.extraction_decl_detail_ok', 'app.hs_code_norm', 'app.hs_reference_learn', 'app.tg_containers_source',
  'app.tg_legacy_decl_guard', 'public.approve_declaration_extraction', 'public.get_declaration_review', 'public.get_transaction_declaration',
  'public.search_hs_reference'];
const RECREATED = ['app.convert_delete_guards', 'app.convert_delete_tables', 'app.extraction_detail_ok', 'app.extraction_field_keys', 'app.rpt_export_keys'];
const RPCS = ['approve_declaration_extraction', 'get_declaration_review', 'get_transaction_declaration', 'search_hs_reference'];
const CODES = ['MRS_DECL_STALE', 'MRS_DECL_BL_MISMATCH', 'MRS_DECL_NUMBER_CONFLICT', 'MRS_DECL_ALREADY_APPROVED'];

/* ------------------------------------------------------------------ fixtures */
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@legacydecl.example.com', now()), ('${U.acc}', 'acc@legacydecl.example.com', now()),
    ('${U.jed}', 'jed@legacydecl.example.com', now()), ('${U.dmm}', 'dmm@legacydecl.example.com', now()),
    ('${U.trn}', 'trn@legacydecl.example.com', now()), ('${U.portal}', 'portal@legacydecl.example.com', now()),
    ('${U.stranger}', 'stranger@legacydecl.example.com', now()), ('${U.staffB}', 'staffb@legacydecl.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.acc}', 'acc'), ('${U.jed}', 'jed'),
    ('${U.dmm}', 'dmm'), ('${U.trn}', 'trn'), ('${U.portal}', 'portal'), ('${U.stranger}', 'stranger'), ('${U.staffB}', 'staffB')
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'legacydecl-org-b', 'مؤسسة ب', 'Legacy decl org B', 'LCB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${BR_B}', '${B}', 'RUH', 'فرع الرياض');
  INSERT INTO public.clients (id, org_id, client_type, name_ar, name_en, phone) VALUES ('${CL_B}', '${B}', 'business', 'عميل ب', 'Client B Co', '0509990001');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.acc}', '${A}', NULL, 'accountant'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.dmm}', '${A}', '${DMM}', 'clearance_staff'),
    ('${U.trn}', '${A}', '${JED}', 'transport_staff'), ('${U.staffB}', '${B}', NULL, 'admin');
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;
const rpc = (who, sql, params) => as(who, sql, params).then(r => r[0].r);
let blSeq = 0;
// a transaction (owner SQL) with a primary B/L saved through save_bl (vessel empty) unless bl === null
async function mkTx(o) {
  const x = Object.assign({ org: A, branch: JED, client: CLIENT_A, bl: 'DECLBL' + String(++blSeq).padStart(6, '0'), roro: false, by: 'jed', country: null }, o || {});
  const tx = (await q(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, cargo_unit_type, chassis_no, country)
                       VALUES ($1, $2, $3, 'import', 'sea', $4, $5, $6) RETURNING id`,
    [x.org, x.branch, x.client, x.roro ? 'roro' : 'container', x.roro ? 'JTDBR32E720000001' : null, x.country]))[0].id;
  if (x.bl) await rpc(x.by, `SELECT public.save_bl($1, NULL) r`, [{ transaction_id: tx, bl_number: x.bl, primary: true }]);
  return tx;
}
// a saved reading (owner SQL; created_by = the user): an AI v3 reading when detail is given
async function ext(o) {
  const x = Object.assign({ org: A, tx: null, kind: 'customs_declaration', fields: {}, items: [], detail: null, by: 'jed', sha: sha(), voided: false }, o || {});
  let usage = null;
  if (x.detail) {
    usage = (await q(`INSERT INTO app.ai_usage (org_id, user_id, purpose, status, model, reserved_usd, cost_usd, input_tokens, output_tokens, settled_at, source_sha256)
                      VALUES ($1, $2, 'doc_extract', 'ok', 'claude-opus-5-5', 0.48, 0.01, 10, 10, now(), $3) RETURNING id`, [x.org, U[x.by], x.sha]))[0].id;
  }
  const id = (await q(`INSERT INTO public.document_extractions (org_id, transaction_id, doc_type, source_name, source_sha256, engine, languages,
                     raw_text, extracted_fields, line_items, created_by, ai_usage_id, ai_detail)
                   VALUES ($1, $2, $3, 'decl.pdf', $4, $5, 'auto', 'x', $6, $7, $8, $9, $10) RETURNING id`,
    [x.org, x.tx, x.kind, x.sha, x.detail ? 'claude-opus-5-5' : 'tesseract.js@5.1.1', J(x.fields), J(x.items), U[x.by], usage, x.detail ? J(x.detail) : null]))[0].id;
  if (x.voided) await q(`UPDATE public.document_extractions SET voided_at = now(), void_reason = 'test' WHERE id = $1`, [id]);
  return id;
}
const det = (containers, decl, type) => Object.assign({ prompt_version: 'ai-doc-v3', detected_type: type || 'customs_declaration', doc_type: type || 'customs_declaration',
  containers: containers || [], fields: [], warnings: [] }, decl ? { declaration: decl } : {});
// a declaration reading (the shape extract.js postProcess saves)
async function declExt(o) {
  const x = Object.assign({ no: '3' + String(100000 + (++blSeq)), type: 'import', status: 'accepted', date: '2025-09-07', hijri: '1447/03/15',
    bl: null, ctrs: [nextCtr()], items: [{ description: 'فحمات فرامل', hs_code: '870830', quantity: 40, unit: 'كرتون', amount: 5000, origin_country: 'الصين', net_weight: 1000, gross_weight: 1200 }],
    vessel: 'MSC TEST', country: 'الصين', cands: null, rtl: false, tx: null, by: 'jed', org: A, kind: 'customs_declaration', voided: false, extra: {} }, o || {});
  const fields = Object.assign({ declaration_number: x.no, declaration_type: x.type, declaration_status: x.status, declaration_date: x.date,
    declaration_date_hijri: x.hijri, vessel: x.vessel, country_of_origin: x.country, container_numbers: x.ctrs.join(', '),
    importer_name_ar: 'شركة الاختبار الأولى للتجارة', invoice_number: 'INV-D1', total: '5000', currency: 'USD' }, x.bl ? { bl_number: x.bl } : {}, x.extra);
  Object.keys(fields).forEach(k => { if (fields[k] == null) delete fields[k]; });
  return ext({ org: x.org, tx: x.tx, by: x.by, kind: x.kind, voided: x.voided, fields, items: x.items,
    detail: det(x.ctrs.map(c => ({ container_number: c, seal_number: 'SL' + c.slice(-4), size_type: '40HC', gross_weight: 1200 })),
      { type_evidence: x.type ? 'بيان استيراد' : null, status_raw: x.status, bl_raw: x.bl, bl_candidates: x.cands || (x.bl ? [x.bl] : []), bl_rtl_affected: x.rtl,
        date_printed: x.date, date_from_hijri: x.date, hijri_supported: true }) });
}
const review = (who, e, tx) => rpc(who || 'jed', `SELECT public.get_declaration_review($1, $2) r`, [e, tx]);
const approve = (who, e, tx, p) => rpc(who || 'jed', `SELECT public.approve_declaration_extraction($1, $2, $3) r`, [e, tx, p]);
async function approveNow(who, e, tx, p) {
  const r = await review(who, e, tx);
  return approve(who, e, tx, Object.assign({ version: r.version }, p || {}));
}

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql, docs');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261119000100, schema_versions row, search_path = \'\' on every function', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h) && !/FUNCTION app\.(extraction_field_keys)\(/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261119000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261120000100', 'legacy_decl'\)/.test(src)
      && heads.length === NEW_FNS.length + RECREATED.length && bad.length === 0) || J({ n: heads.length, want: NEW_FNS.length + RECREATED.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('refusals through app.fail(\'MRS_*\') only (no RAISE EXCEPTION besides the guard / preflight)', () => {
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|LEGACY DECL preflight/.test(r));
    const codes = src.match(/app\.fail\('([A-Z_]+)'/g) || [];
    return (raises.length === 0 && codes.length >= 30 && codes.every(c => /app\.fail\('MRS_[A-Z_]+'/.test(c))) || J({ raises: raises.length, codes: codes.length });
  });
  await check('every MRS code used has an Arabic message in supa.js and Arabic + English in i18n.js; the new codes are exactly the 4 of the header', () => {
    const used = [...new Set((src.match(/app\.fail\('(MRS_[A-Z_]+)'/g) || []).map(x => x.slice(10, -1)))].sort();
    const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
    const i18n = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
    const missing = used.filter(c => !new RegExp('\\b' + c + ':').test(supa) || (i18n.match(new RegExp('\\n\\s+' + c + ': ', 'g')) || []).length < 2);
    const newOnes = used.filter(c => /^MRS_DECL_/.test(c));
    return (missing.length === 0 && J(newOnes.sort()) === J(CODES.slice().sort()) && CODES.every(c => src.slice(0, 7000).includes(c))) || 'missing: ' + missing.join(', ') + ' new: ' + newOnes;
  });
  await check('no TRUNCATE / DROP TABLE / DROP FUNCTION / DISABLE TRIGGER / session_replication_role / DELETE; no key or endpoint', () => {
    const c = src.replace(/--.*$/gm, '');
    return (!/\bTRUNCATE\b/i.test(c) && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA)/i.test(c) && !/DISABLE TRIGGER/i.test(c) && !/session_replication_role/.test(c)
      && !/\bDELETE\s+FROM\b/i.test(c) && !/sk-ant|api\.anthropic\.com|https?:\/\//i.test(src)) || 'body';
  });
  await check('no personal data / legacy organization name copied from the legacy code (no e-mail, phone number, real org name)', () =>
    (!/@[a-z0-9-]+\.[a-z]/i.test(src.replace(/--.*$/gm, '')) && !/\b05[0-9]{8}\b/.test(src) && !/رأس الحكمة/.test(src)) || 'personal data');
  // later phases may follow this file (20261121000100 legacy_appt: re-creates extraction_field_keys / extraction_detail_ok / the conversion lists)
  const LATER_PHASES = ['20261121000100_legacy_appt.sql', '20261122000100_legacy_pay.sql', '20261123000100_legacy_daftra.sql'];
  await check('this file is the latest migration (or only listed later phases follow it)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (appended last, in order) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const after = next < 0 ? [] : (all.slice(next).match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && after.every(f => LATER_PHASES.includes(f)) && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 12000).includes(MIG) && J(order) === J(migFiles())) || 'not appended verbatim / no header line / order';
  });
  await check('docs/online/LEGACY_DECL_AR.md exists and names the migration, every RPC, the error codes, ai-doc-v3, the Hijri rule and the draft rule', () => {
    const p = path.join(ROOT, 'docs', 'online', 'LEGACY_DECL_AR.md');
    if (!fs.existsSync(p)) return 'missing';
    const d = fs.readFileSync(p, 'utf8');
    const miss = [MIG, 'ai-doc-v3', 'hs_reference', 'declaration_items', 'declaration_approvals', 'مسودة', 'أم القرى', 'كشف-إدخال-فسح', 'fasah_sheet']
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
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261119000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without legacy_docs: exact preflight message, nothing created', async () =>
        (msg.startsWith('LEGACY DECL preflight: apply legacy_docs first (schema_versions lacks 20261119000100 legacy_docs)')
          && (await one(`SELECT to_regclass('public.hs_reference') IS NULL x`)).x && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261119000100', 'legacy_docs')`);
      const r1 = await tryErr(() => db.exec(src));
      const C1 = await catalog();
      const audit1 = await num(`SELECT count(*) n FROM public.audit_log`);
      const r3 = await tryErr(() => db.exec(src));
      await check('applies, then re-runs on top of itself with an identical catalog (functions, ACLs, indexes, triggers, policies, constraints, columns, grants, labels); no data', async () =>
        (r1 === 'ok' && r3 === 'ok' && J(C1) === J(await catalog()) && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261120000100'`)) === 1
          && (await num(`SELECT count(*) n FROM public.audit_log`)) === audit1) || J({ r1, r3 }));
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
      await check('catalog: the only new column outside the 3 tables is containers.source; the Fasah stages / Hijri CHECK of step 1 are untouched', () => {
        const cols = C1.cols.filter(c => !C0.cols.includes(c) && !NEW_TABLES.some(t => c.startsWith(t.split('.')[1] + '.'))).sort();
        const decl = c => c.filter(x => /^customs_declarations\./.test(x));
        return (J(cols) === J(['containers.source']) && J(decl(C0.con)) === J(decl(C1.con))) || J(cols);
      });
      await check('catalog: anon / authenticated grants on the new tables are SELECT for authenticated only (hs_reference: column grants, review fix)', () => {
        const g = C1.grants.filter(x => !C0.grants.includes(x));
        const api = g.filter(x => !/:service_role:/.test(x));
        return (api.length === 2 && api.every(x => /:authenticated:SELECT$/.test(x)) && !api.some(x => /^hs_reference:/.test(x))) || J(api);
      });
      await check('catalog: the new labels are report_kind.fasah_sheet + the decl_conflict / container_source domains; existing labels unchanged', () => {
        const add = C1.labels.filter(x => !C0.labels.includes(x));
        const gone = C0.labels.filter(x => !C1.labels.includes(x));
        return (gone.length === 0 && add.length === 12 && add.every(x => /^(report_kind\.fasah_sheet|decl_conflict\.|container_source\.)/.test(x))
          && add.some(x => /^decl_conflict\.shipment_on_other_tx:7:/.test(x))) || J({ add, gone });
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. readings */
async function secReadings() {
  section('3. readings: declaration keys, ai_detail.declaration');
  await check('app.extraction_field_keys() = extract.js ALL_KEYS_V3 (66 keys: the 42 of step 3 first, then the 8 declaration keys, then the 16 card / EIR keys of 20261121000100)', async () => {
    const k = (await one(`SELECT app.extraction_field_keys() k`)).k;
    return (J(k) === J(XJS.ALL_KEYS_V3) && k.length === 66 && J(k.slice(42, 50)) === J(XJS.DECL_KEYS)) || J(k);
  });
  const F = (n, v) => ({ name: n, value: v, confidence: 0.9, page: 1 });
  const c1 = ctr('MSCU305438');
  const out = XJS.postProcess({ doc_type: 'customs_declaration', detected_documents: ['customs_declaration'],
    fields: [F('declaration_number', '3012345'), F('declaration_type', 'استيراد'), F('declaration_status', 'تم الفسح'), F('declaration_date_hijri', '١٥/٣/١٤٤٧'),
      F('declaration_date', '2025-09-08'), F('bl_number', '123456 MEDU'), F('container_numbers', c1)],
    line_items: [], containers: [{ container_number: c1, seal_number: 'S1', size_type: '40HC', packages_count: 1, net_weight: 1, gross_weight: 2 }], warnings: [],
    declaration: { declaration_type_evidence: 'بيان استيراد', bl_candidates: ['MEDU 123456'], bl_rtl_affected: true } }, 'customs_declaration', 'ai-doc-v3');
  await check('ai_detail.declaration: extract.js postProcess output passes the CHECK; bad keys / types / sizes refused', async () => {
    const t = async v => (await one(`SELECT app.extraction_detail_ok($1) x`, [J(v)])).x;
    const base = { prompt_version: 'ai-doc-v3' };
    const good = await t(out.ai_detail);
    const bads = await Promise.all([{ x: 1 }, { bl_rtl_affected: 'yes' }, { bl_candidates: 'A' }, { bl_candidates: Array(11).fill('A') },
      { bl_candidates: ['x'.repeat(81)] }, { status_raw: 'x'.repeat(301) }, { type_evidence: 5 }].map(dd => t(Object.assign({}, base, { declaration: dd }))));
    return (good === true && out.ai_detail.declaration.bl_rtl_affected === true && bads.every(x => x === false)) || J({ good, bads, d: out.ai_detail.declaration });
  });
  await check('a declaration reading (extract.js output) saves with its fields; the reading values are normalised (type code, Fasah stage, Hijri, Gregorian from the Hijri)', async () => {
    const e = await ext({ fields: out.extracted_fields, detail: out.ai_detail });
    const r = await one(`SELECT extracted_fields f FROM public.document_extractions WHERE id = $1`, [e]);
    return (r.f.declaration_type === 'import' && r.f.declaration_status === 'released' && r.f.declaration_date_hijri === '1447/03/15'
      && r.f.declaration_date === '2025-09-07' && r.f.bl_number === '123456 MEDU') || J(r.f);
  });
}

/* ================================================================== 4. helpers */
async function secHelpers() {
  section('4. helpers: B/L token equivalence (SQL = MarsaDocMatch), HS code, status / type normalisers, Hijri CHECK');
  const cases = [['MEDU 123456', '123456MEDU', true], ['MEDU123456', 'medu-123456', true], ['MEDU 123 456', '456 MEDU 123', true],
    ['ABC123', 'ABC124', false], ['MEDU١٢٣', '123 MEDU', true], ['ABC123', 'ABC123X', false], ['', 'ABC', false], [null, null, false],
    ['شحنة', 'بضاعة', false], ['HLCU-JEA-2501234', '2501234 JEA HLCU', true], ['SHA/1234', '1234 SHA 1', false]];
  await check('app.bl_equivalent = MarsaDocMatch.blEquivalent on ' + cases.length + ' cases (any token order, Arabic digits, separators; empty token lists never match)', async () => {
    const bad = [];
    for (const [a, b, want] of cases) {
      const s = (await one(`SELECT app.bl_equivalent($1, $2) x`, [a, b])).x;
      const j = DM.blEquivalent(a, b);
      if (s !== want || j !== want) bad.push({ a, b, s, j, want });
    }
    return bad.length === 0 || J(bad);
  });
  await check('app.bl_tokens: letter / digit runs, western digits, sorted = MarsaDocMatch.blTokens', async () => {
    const s = (await one(`SELECT app.bl_tokens('medu-١٢ ab 3') t`)).t;
    return (J(s) === J(['12', '3', 'AB', 'MEDU']) && J(DM.blTokens('medu-١٢ ab 3')) === J(s)) || J(s);
  });
  await check('app.hs_code_norm: digits only (Arabic digits, dots); < 2 or > 14 digits → NULL', async () => {
    const r = await one(`SELECT app.hs_code_norm('٨٧٠٨.٣٠') a, app.hs_code_norm('8708 30 00') b, app.hs_code_norm('X') c, app.hs_code_norm('1') d,
                                app.hs_code_norm('123456789012345') e`);
    return (r.a === '870830' && r.b === '87083000' && r.c === null && r.d === null && r.e === null) || J(r);
  });
  await check('status / type normalisers (step 1) agree with extract.js and MarsaNorm: تم الفسح → released, بيان تصدير → export', async () => {
    const vals = ['تم الفسح', 'قبول البيان', 'بانتظار السداد', 'جاهز لطباعة إشعار الفسح الإلكتروني', 'انتهاء مراجعة مركز العمليات الجمركية', 'غير معروف', 'released'];
    const bad = [];
    for (const v of vals) {
      const s = (await one(`SELECT app.norm_declaration_status($1) x`, [v])).x;
      if ((s || '') !== XJS.normDeclarationStatus(v) || (s || '') !== MN.normDeclarationStatus(v)) bad.push({ v, s, x: XJS.normDeclarationStatus(v), m: MN.normDeclarationStatus(v) });
    }
    for (const v of ['بيان استيراد', 'بيان تصدير', 'بيان تصفية', 'export', 'غير']) {
      const s = (await one(`SELECT app.norm_declaration_type($1) x`, [v])).x;
      if ((s || '') !== XJS.normDeclarationType(v) || (s || '') !== MN.normDeclarationType(v)) bad.push({ v, s });
    }
    return (bad.length === 0 && XJS.normDeclarationStatus('تم الفسح') === 'released') || J(bad);
  });
  await check('Hijri: extract.js normalizeHijri / hijriToGregorian = MarsaNorm on known Umm al-Qura dates (1 Muharram 1447 = 2025-06-26, 1 Ramadan 1446 = 2025-03-01, 15/3/1447 = 2025-09-07)', () => {
    const known = [['1447/01/01', '2025-06-26'], ['1446/09/01', '2025-03-01'], ['15/3/1447', '2025-09-07'], ['١٤٤٦/١٠/٠١', '2025-03-30']];
    const bad = known.filter(([h, g]) => XJS.hijriToGregorian(h) !== g || MN.hijriToGregorian(h) !== g);
    return (bad.length === 0 && XJS.normalizeHijri('5/3/1447 هـ') === '1447/03/05' && XJS.normalizeHijri('1701/01/01') === '') || J(bad);
  });
  await check('the step-1 Hijri CHECK refuses an out-of-range date through add_declaration (MRS_INVALID declaration_date_hijri)', async () => {
    const tx = await mkTx();
    const r = await code(() => rpc('jed', `SELECT public.add_declaration($1, $2, NULL) r`, [tx, { declaration_no: 'HIJ1', declaration_date_hijri: '1447/13/01' }]));
    return r === 'MRS_INVALID declaration_date_hijri' || r;
  });
}

/* ================================================================== 5. review */
async function secReview() {
  section('5. get_declaration_review: draft, comparison, scoping, refusals');
  const tx = await mkTx({ bl: 'MEDU123456' });
  const c1 = nextCtr(), c2 = nextCtr();
  await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, tx, c1]);
  const e = await declExt({ bl: '123456 MEDU', cands: ['123456 MEDU', 'MEDU 123456'], rtl: true, ctrs: [c1, c2], status: 'فسح كلي' });
  let R;
  await check('draft: number / type / Fasah stage / dates / B/L as read + candidates / RTL / containers with seals / items with HS digits', async () => {
    R = await review('jed', e, tx);
    const d = R.draft;
    return (d.declaration_no === R.draft.declaration_no && /^3\d+$/.test(d.declaration_no) && d.declaration_type === 'import' && d.status === 'released'
      && d.declaration_date === '2025-09-07' && d.declaration_date_hijri === '1447/03/15' && d.bl_number === '123456 MEDU'
      && J(d.bl_candidates) === J(['123456 MEDU', 'MEDU 123456']) && d.bl_rtl_affected === true && d.containers.length === 2
      && d.containers[0].seal_number && d.items.length === 1 && d.items[0].hs_code === '870830' && d.items[0].value === 5000
      && d.importer_name_ar === 'شركة الاختبار الأولى للتجارة' && typeof R.version === 'string' && R.version.length === 32 && R.approval === null) || J(R);
  });
  await check('comparison: B/L token-equivalent despite the RTL order (match), containers matched / new, action add, status initial, nothing missing, can_approve', () => {
    const c = R.comparison;
    return (c.bl.status === 'match' && c.bl.matched_with === '123456 MEDU' && J(c.bl.transaction_bls) === J(['MEDU123456'])
      && J(c.containers.matched) === J([c1]) && J(c.containers.new) === J([c2]) && c.declaration.action === 'add' && c.status.direction === 'initial'
      && c.missing.length === 0 && c.can_approve === true) || J(c);
  });
  await check('comparison: a B/L that is not token-equivalent → bl_mismatch (blocking, confirmable); no type / date / containers → missing; can_approve false', async () => {
    const tx2 = await mkTx({ bl: 'OOLU7777' });
    const e2 = await declExt({ bl: 'OOLU7778', type: null, date: null, hijri: null, ctrs: [] });
    const c = (await review('jed', e2, tx2)).comparison;
    return (c.bl.status === 'mismatch' && c.conflicts.some(x => x.code === 'bl_mismatch' && x.blocking && x.confirmable)
      && J(c.missing) === J(['declaration_type', 'declaration_date', 'containers']) && c.can_approve === false) || J(c);
  });
  await check('read-only: get_declaration_review changes nothing (reading unreviewed, no declaration, no container added)', async () => {
    const r = await one(`SELECT (SELECT review_status FROM public.document_extractions WHERE id = $1) s,
                                (SELECT count(*) FROM public.customs_declarations WHERE transaction_id = $2)::int d,
                                (SELECT count(*) FROM public.containers WHERE transaction_id = $2)::int c`, [e, tx]);
    return (r.s === 'unreviewed' && r.d === 0 && r.c === 1) || J(r);
  });
  await check('scoping: dmm (other branch) / staffB / portal / stranger → MRS_NOT_FOUND transaction; acc (staff) may read', async () => {
    const r = [];
    for (const w of ['dmm', 'staffB', 'portal', 'stranger']) r.push(await code(() => review(w, e, tx)));
    const acc = await code(() => review('acc', e, tx));
    return (r.every(x => x === 'MRS_NOT_FOUND transaction') && acc === 'ok') || J({ r, acc });
  });
  await check('refusals: a voided reading → MRS_MATCH_DOC_VOIDED; an invoice reading → MRS_MATCH_DOC_KIND; linked to another transaction → MRS_INVALID transaction_id; another org → MRS_NOT_FOUND extraction', async () => {
    const v = await declExt({ voided: true });
    const k = await ext({ kind: 'commercial_invoice', fields: { invoice_number: 'X1' } });
    const other = await mkTx();
    const linked = await declExt({ tx: other });
    const eb = await ext({ org: B, by: 'staffB', fields: { declaration_number: 'B1' } });
    const r = [await code(() => review('jed', v, tx)), await code(() => review('jed', k, tx)), await code(() => review('jed', linked, tx)),
      await code(() => review('jed', eb, tx))];
    return J(r) === J(['MRS_MATCH_DOC_VOIDED extraction', 'MRS_MATCH_DOC_KIND customs_declaration', 'MRS_INVALID transaction_id', 'MRS_NOT_FOUND extraction']) || J(r);
  });
  await check('review fix — wrong document (legacy assertExpectedDocumentType_): a reading saved as customs_declaration whose AI detected type is other / bill_of_lading → MRS_MATCH_DOC_KIND for the review AND the approval; a file that also holds a declaration (detected_documents) passes', async () => {
    const t2 = await mkTx();
    const fields = { declaration_number: '3999001', declaration_type: 'import', declaration_status: 'accepted', declaration_date: '2025-09-07', container_numbers: nextCtr() };
    const eo = await ext({ fields, detail: Object.assign(det([], null), { detected_type: 'other' }) });
    const eb = await ext({ fields: Object.assign({}, fields, { declaration_number: '3999002' }), detail: Object.assign(det([], null), { detected_type: 'bill_of_lading' }) });
    const em = await ext({ fields: Object.assign({}, fields, { declaration_number: '3999003' }),
      detail: Object.assign(det([], null), { detected_type: 'bill_of_lading', detected_documents: ['bill_of_lading', 'customs_declaration'] }) });
    const r = [await code(() => review('jed', eo, t2)), await code(() => approve('jed', eo, t2, { version: 'x' })), await code(() => review('jed', eb, t2)),
      await code(() => review('jed', em, t2))];
    const n = await num(`SELECT count(*) n FROM public.declaration_approvals WHERE extraction_id = ANY ($1::uuid[])`, [[eo, eb]]);
    return (J(r) === J(['MRS_MATCH_DOC_KIND customs_declaration', 'MRS_MATCH_DOC_KIND customs_declaration', 'MRS_MATCH_DOC_KIND customs_declaration', 'ok']) && n === 0) || J(r);
  });
  await check('review fix — hijri_unverified also when the calendar IS supported but the Hijri day does not exist (1446/09/30: Ramadan 1446 has 29 days); non-blocking', async () => {
    const t2 = await mkTx();
    const ex = await ext({ fields: { declaration_number: '3999010', declaration_type: 'import', declaration_status: 'accepted', declaration_date: '2025-03-30',
      declaration_date_hijri: '1446/09/30', container_numbers: nextCtr() }, detail: det([], { date_printed: '2025-03-30', date_from_hijri: null, hijri_supported: true }) });
    const ok = await declExt({ hijri: '1446/09/29', date: '2025-03-29' });
    const c = (await review('jed', ex, t2)).comparison, c2 = (await review('jed', ok, t2)).comparison;
    const hit = c.conflicts.filter(x => x.code === 'hijri_unverified');
    return (MN.hijriToGregorian('1446/09/30') === '' && hit.length === 1 && hit[0].blocking === false && !c2.conflicts.some(x => x.code === 'hijri_unverified')) || J({ c, c2 });
  });
}

/* ================================================================== 6. approve */
async function secApprove() {
  section('6. approve_declaration_extraction: new declaration, containers, items, HS, reading, approval, refusals, idempotency, existing declaration, doc batch');
  const tx = await mkTx({ bl: 'MEDU654321' });
  const c0 = nextCtr(), c1 = nextCtr();
  await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, tx, c0]);
  const e = await declExt({ bl: '654321 MEDU', rtl: true, ctrs: [c0, c1] });
  const rv = await review('jed', e, tx);
  const K = newKey();
  let R;
  await check('role: accountant / transport staff of the branch → MRS_FORBIDDEN role; dmm → MRS_NOT_FOUND (other branch); nothing written', async () => {
    const r = [await code(() => approve('acc', e, tx, { version: rv.version })), await code(() => approve('trn', e, tx, { version: rv.version })),
      await code(() => approve('dmm', e, tx, { version: rv.version }))];
    const n = await num(`SELECT count(*) n FROM public.declaration_approvals WHERE extraction_id = $1`, [e]);
    return (r[0] === 'MRS_FORBIDDEN role' && r[1] === 'MRS_FORBIDDEN role' && /^MRS_NOT_FOUND/.test(r[2]) && n === 0) || J(r);
  });
  await check('version: missing → MRS_REQUIRED version; wrong → MRS_DECL_STALE', async () => {
    const a = await code(() => approve('jed', e, tx, {}));
    const b = await code(() => approve('jed', e, tx, { version: 'x' + rv.version.slice(1) }));
    return (a === 'MRS_REQUIRED version' && b === 'MRS_DECL_STALE') || J({ a, b });
  });
  await check('approve: declaration added through add_declaration (source ocr, Hijri, type, status), result shape, B/L match kept', async () => {
    R = await approve('jed', e, tx, { version: rv.version, idempotencyKey: K });
    const d = await one(`SELECT * FROM public.customs_declarations WHERE transaction_id = $1`, [tx]);
    const t = await one(`SELECT bl_number, declaration_no, declaration_type, declaration_date::text dd FROM public.transactions WHERE id = $1`, [tx]);
    return (R.declaration_action === 'added' && R.status_action === 'initial' && R.bl.status === 'match' && d.source === 'ocr' && d.status === 'accepted'
      && d.declaration_type_code === 'import' && d.declaration_date_hijri === '1447/03/15' && t.declaration_no === d.declaration_no && t.dd === '2025-09-07'
      && t.bl_number === 'MEDU654321' && R.declaration.id === d.id && R.daftra_hook === 'deferred' && /RTL/.test(d.notes)) || J({ R, d, t });
  });
  await check('containers merged with source declaration (the existing one gets its empty seal / size / weight; the new one added)', async () => {
    const rows = await q(`SELECT container_no, seal_no, size_type, gross_weight_kg::text g, source FROM public.containers WHERE transaction_id = $1 ORDER BY container_no`, [tx]);
    const m = Object.fromEntries(rows.map(x => [x.container_no, x]));
    return (J(R.containers.added) === J([c1]) && J(R.containers.updated) === J([c0]) && m[c1].source === 'declaration' && m[c1].seal_no
      && m[c0].seal_no && m[c0].source === null && m[c1].size_type === '40HC') || J({ c: R.containers, rows });
  });
  await check('items: declaration_items written (HS digits, Arabic description, value, origin, weights); HS reference learned; the reading linked + reviewed', async () => {
    const it = await q(`SELECT * FROM public.declaration_items WHERE declaration_id = $1 AND voided_at IS NULL`, [R.declaration.id]);
    const h = await q(`SELECT * FROM public.hs_reference WHERE id = ANY ($1::uuid[])`, [R.hs_reference.ids]);
    const x = await one(`SELECT transaction_id, review_status, reviewed_by FROM public.document_extractions WHERE id = $1`, [e]);
    return (R.items === 1 && it.length === 1 && it[0].hs_code === '870830' && it[0].description_ar === 'فحمات فرامل' && Number(it[0].value) === 5000
      && it[0].origin_country === 'الصين' && Number(it[0].gross_weight_kg) === 1200 && it[0].approval_id === R.approval_id && R.hs_reference.saved === 1
      && h.length === 1 && h[0].hs_code === '870830' && h[0].usage_count === 1 && h[0].last_declaration_no === R.declaration.declaration_no
      && h[0].last_importer === 'شركة الاختبار الأولى للتجارة' && x.transaction_id === tx && x.review_status === 'reviewed' && x.reviewed_by === U.jed) || J({ it, h, x });
  });
  await check('transaction fields only when empty: vessel on the primary B/L, declaration notes, country filled (tx_filled); the approval row + the declaration event op approved (the step-7 hook)', async () => {
    const bl = await one(`SELECT bl.vessel FROM public.transaction_bls tb JOIN public.bills_of_lading bl ON bl.id = tb.bl_id WHERE tb.transaction_id = $1 AND tb.is_primary`, [tx]);
    const t = await one(`SELECT declaration_notes, country FROM public.transactions WHERE id = $1`, [tx]);
    const a = await one(`SELECT * FROM public.declaration_approvals WHERE id = $1`, [R.approval_id]);
    const ev = await q(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'declaration' AND payload ->> 'op' = 'approved'`, [tx]);
    return (bl.vessel === 'MSC TEST' && ['vessel', 'declaration_notes', 'country'].every(k => R.tx_filled.includes(k)) && R.tx_kept.length === 0
      && /RTL/.test(t.declaration_notes) && t.country === 'الصين' && a.bl_status === 'match' && a.daftra_hook === 'deferred' && a.approved_by === U.jed
      && a.extraction_id === e && ev.length === 1 && ev[0].payload.approval_id === R.approval_id) || J({ bl, t, a, ev, f: R.tx_filled });
  });
  await check('idempotent: the same key + payload replays the stored result (replayed:true, same approval, nothing new); the key reused for another payload → MRS_IDEMPOTENCY_CONFLICT', async () => {
    const again = await approve('jed', e, tx, { version: rv.version, idempotencyKey: K });
    const n = await num(`SELECT count(*) n FROM public.declaration_approvals WHERE extraction_id = $1`, [e]);
    const other = await code(() => approve('jed', e, tx, { version: rv.version, idempotencyKey: K, notes: 'x' }));
    return (again.replayed === true && again.approval_id === R.approval_id && n === 1 && other === 'MRS_IDEMPOTENCY_CONFLICT idempotency_key') || J({ again, n, other });
  });
  await check('a reading approved once → MRS_DECL_ALREADY_APPROVED (a fresh key, a fresh version); the review shows the approval', async () => {
    const r2 = await review('jed', e, tx);
    const c = await code(() => approve('jed', e, tx, { version: r2.version }));
    return (c === 'MRS_DECL_ALREADY_APPROVED' && r2.approval && r2.approval.id === R.approval_id) || J({ c, a: r2.approval });
  });

  await check('required: no declaration number / type / Gregorian date / status → MRS_REQUIRED <field>; no container → MRS_REQUIRED containers', async () => {
    const t2 = await mkTx();
    const r = [];
    for (const o of [{ no: null }, { type: null }, { date: null, hijri: null }, { status: 'حالة غير معروفة' }, { ctrs: [] }]) {
      const ex = await declExt(Object.assign({ extra: {} }, o, o.no === null ? { extra: { declaration_number: null } } : {}));
      r.push(await code(() => approveNow('jed', ex, t2)));
    }
    return J(r) === J(['MRS_REQUIRED declaration_no', 'MRS_REQUIRED declaration_type', 'MRS_REQUIRED declaration_date', 'MRS_REQUIRED status', 'MRS_REQUIRED containers']) || J(r);
  });
  await check('bad reviewer values: type / status / Hijri / container / HS / unknown key → MRS_INVALID; nothing approved', async () => {
    const t2 = await mkTx();
    const ex = await declExt();
    const r = [];
    for (const p of [{ declaration_type: 'شحن' }, { status: 'غير' }, { declaration_date_hijri: '1447/13/01' }, { containers: [{ container_number: 'ABC' }] },
      { items: [{ hs_code: 'X', description: 'y' }] }, { colour: 'red' }, { declaration_date: '2026-02-30' }]) r.push(await code(() => approveNow('jed', ex, t2, p)));
    const n = await num(`SELECT count(*) n FROM public.declaration_approvals WHERE extraction_id = $1`, [ex]);
    return (J(r) === J(['MRS_INVALID declaration_type', 'MRS_INVALID status', 'MRS_INVALID declaration_date_hijri', 'MRS_INVALID container_number',
      'MRS_INVALID hs_code', 'MRS_INVALID unknown_key', 'MRS_INVALID declaration_date']) && n === 0) || J(r);
  });
  await check('reviewer values win: type in Arabic, status text normalised, edited containers / items, the Gregorian date from the payload', async () => {
    const t2 = await mkTx();
    const ex = await declExt({ type: null });
    const cx = nextCtr();
    const r = await approveNow('jed', ex, t2, { declaration_type: 'بيان تصدير', status: 'بانتظار السداد', declaration_date: '2025-09-08',
      containers: [{ container_number: cx.toLowerCase(), seal_number: 'S9' }], items: [{ hs_code: '0901.11', description: 'بن', value: 10 }] });
    const d = await one(`SELECT declaration_type_code t, status, declaration_date::text dd FROM public.customs_declarations WHERE id = $1`, [r.declaration.id]);
    return (d.t === 'export' && d.status === 'awaiting_duty_payment' && d.dd === '2025-09-08' && J(r.containers.added) === J([cx]) && r.items === 1) || J({ d, r });
  });
  await check('stale: a container added after the review → MRS_DECL_STALE (nothing approved); a fresh review then approves', async () => {
    const t2 = await mkTx();
    const ex = await declExt();
    const r1 = await review('jed', ex, t2);
    await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, t2, nextCtr()]);
    const a = await code(() => approve('jed', ex, t2, { version: r1.version }));
    const b = await code(() => approveNow('jed', ex, t2));
    return (a === 'MRS_DECL_STALE' && b === 'ok') || J({ a, b });
  });
  await check('B/L: not token-equivalent → MRS_DECL_BL_MISMATCH; confirmed → approved (bl mismatch_confirmed, the transaction B/L unchanged, a note); no B/L on the transaction → no_transaction_bl', async () => {
    const t2 = await mkTx({ bl: 'MAEU11112222' });
    const ex = await declExt({ bl: 'MAEU11113333' });
    const a = await code(() => approveNow('jed', ex, t2));
    const b = await approveNow('jed', ex, t2, { confirm_bl_mismatch: true });
    const t = await one(`SELECT bl_number FROM public.transactions WHERE id = $1`, [t2]);
    const ap = await one(`SELECT bl_status FROM public.declaration_approvals WHERE id = $1`, [b.approval_id]);
    const t3 = await mkTx({ bl: null });
    const c = await approveNow('jed', await declExt({ bl: 'ANY123' }), t3);
    return (a === 'MRS_DECL_BL_MISMATCH' && b.bl.status === 'mismatch_confirmed' && ap.bl_status === 'mismatch_confirmed' && t.bl_number === 'MAEU11112222'
      && /أكد الموظف/.test(b.declaration.notes || '') && c.bl.status === 'no_transaction_bl') || J({ a, b: b.bl, t, c: c.bl });
  });
  await check('existing declaration, same number: empty fields filled, a differing reviewed date REPLACED through correct_declaration (review fix, legacy wrote the reviewed values: declaration_replaced + the corrected event before / after), status moved forward', async () => {
    const t2 = await mkTx();
    const add = await rpc('jed', `SELECT public.add_declaration($1, $2, NULL) r`, [t2, { declaration_no: 'SAME001', declaration_date: '2025-09-01', status: 'submitted' }]);
    const ex = await declExt({ no: 'SAME001', status: 'release_ready' });
    const r = await approveNow('jed', ex, t2);
    const d = await one(`SELECT declaration_type_code t, status, declaration_date::text dd, declaration_date_hijri h FROM public.customs_declarations WHERE id = $1`, [add.id]);
    const ev = await q(`SELECT payload FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'declaration' AND payload ->> 'op' = 'corrected'`, [t2]);
    const evOk = ev.some(x => J(x.payload).includes('2025-09-01') && J(x.payload).includes('2025-09-07'));
    return (r.declaration_action === 'corrected' && r.status_action === 'forward' && d.t === 'import' && d.h === '1447/03/15' && d.dd === '2025-09-07'
      && d.status === 'release_ready' && r.tx_filled.includes('declaration_type') && J(r.declaration_replaced) === J(['declaration_date']) && !r.tx_kept.includes('declaration_date')
      && r.declaration.id === add.id && evOk) || J({ r, d, ev });
  });
  await check('existing declaration, same number: a reviewed type / Hijri that differ are replaced; the notes of a second reading are MERGED (legacy mergeNotes_), the transaction declaration notes too', async () => {
    const t2 = await mkTx({ bl: 'MERGEBL001' });
    const r1 = await approveNow('jed', await declExt({ no: 'MERGE01', bl: '001 MERGEBL', rtl: true }), t2);
    const r2 = await approveNow('jed', await declExt({ no: 'MERGE01', status: 'released', bl: 'MERGEBL001', hijri: '1447/03/16', date: '2025-09-08' }), t2,
      { declaration_type: 'export', notes: 'ملاحظة المراجع الثانية' });
    const d = await one(`SELECT declaration_type_code t, declaration_date::text dd, declaration_date_hijri h, notes FROM public.customs_declarations WHERE id = $1`, [r1.declaration.id]);
    const t = await one(`SELECT declaration_notes n FROM public.transactions WHERE id = $1`, [t2]);
    return (r2.declaration.id === r1.declaration.id && d.t === 'export' && d.dd === '2025-09-08' && d.h === '1447/03/16'
      && J(r2.declaration_replaced.slice().sort()) === J(['declaration_date', 'declaration_date_hijri', 'declaration_type'])
      && /RTL/.test(d.notes) && /ملاحظة المراجع الثانية/.test(d.notes) && /RTL/.test(t.n) && /ملاحظة المراجع الثانية/.test(t.n)
      && (d.notes.match(/RTL/g) || []).length === 1 && r2.tx_filled.includes('declaration_notes')) || J({ r2, d, t });
  });
  await check('date notes (legacy normalizeDeclarationDraft_): the Gregorian date recomputed from the Hijri is noted; a Hijri the reader could not convert is noted', async () => {
    const t2 = await mkTx();
    const ex = await ext({ fields: { declaration_number: 'DNOTE01', declaration_type: 'import', declaration_status: 'accepted', declaration_date: '2025-09-07',
      declaration_date_hijri: '1447/03/15', container_numbers: nextCtr() },
      detail: det([], { date_printed: '2025-09-08', date_from_hijri: '2025-09-07', hijri_supported: true }) });
    const a = await approveNow('jed', ex, t2);
    const t3 = await mkTx();
    const ex2 = await ext({ fields: { declaration_number: 'DNOTE02', declaration_type: 'import', declaration_status: 'accepted', declaration_date: '2025-03-30',
      declaration_date_hijri: '1446/09/30', container_numbers: nextCtr() },
      detail: det([], { date_printed: '2025-03-30', date_from_hijri: null, hijri_supported: true }) });
    const b = await approveNow('jed', ex2, t3);
    return (/تم تصحيح التاريخ الميلادي من 2025-09-08 إلى 2025-09-07 بناءً على التاريخ الهجري 1447\/03\/15/.test(a.declaration.notes || '')
      && /تعذر التحقق الآلي من تحويل التاريخ الهجري/.test(b.declaration.notes || '')) || J({ a: a.declaration.notes, b: b.declaration.notes });
  });
  await check('existing declaration: a status behind the recorded one is kept (kept_backward + warning, nothing moved back)', async () => {
    const t2 = await mkTx();
    const add = await rpc('jed', `SELECT public.add_declaration($1, $2, NULL) r`, [t2, { declaration_no: 'BACK001', declaration_type: 'import', declaration_date: '2025-09-07',
      declaration_date_hijri: '1447/03/15', status: 'released' }]);
    const r = await approveNow('jed', await declExt({ no: 'BACK001', status: 'accepted' }), t2);
    const d = await one(`SELECT status FROM public.customs_declarations WHERE id = $1`, [add.id]);
    return (r.status_action === 'kept_backward' && r.warnings.includes('status_backward') && d.status === 'released' && r.declaration_action === 'unchanged') || J({ r, d });
  });
  await check('another active number on the transaction → MRS_DECL_NUMBER_CONFLICT; a number of another transaction → MRS_INVALID declaration_no_taken', async () => {
    const t2 = await mkTx();
    await rpc('jed', `SELECT public.add_declaration($1, $2, NULL) r`, [t2, { declaration_no: 'OTHER001' }]);
    const ea = await declExt({ no: 'OTHER002' });
    const a = await code(() => approveNow('jed', ea, t2));
    const t3 = await mkTx();
    const eb = await declExt({ no: 'OTHER001' });
    const b = await code(() => approveNow('jed', eb, t3));
    return (a === 'MRS_DECL_NUMBER_CONFLICT' && b === 'MRS_INVALID declaration_no_taken') || J({ a, b });
  });
  await check('the step-2 duplicate guard: a container already on another open transaction with the same B/L → MRS_DUPLICATE_TX and everything rolled back', async () => {
    const shared = nextCtr();
    const t1 = await mkTx({ bl: 'DUPBL0001' });
    await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, t1, shared]);
    const t2 = await mkTx({ bl: null });
    await q(`UPDATE public.transactions SET bl_number = 'DUPBL0001' WHERE id = $1`, [t2]);
    const ex = await declExt({ bl: 'DUPBL0001', ctrs: [shared] });
    const before = await one(`SELECT (SELECT count(*) FROM public.customs_declarations WHERE transaction_id = $1)::int d,
                                     (SELECT count(*) FROM public.hs_reference)::int h`, [t2]);
    const r = await code(() => approveNow('jed', ex, t2));
    const after = await one(`SELECT (SELECT count(*) FROM public.customs_declarations WHERE transaction_id = $1)::int d,
                                    (SELECT count(*) FROM public.hs_reference)::int h,
                                    (SELECT review_status FROM public.document_extractions WHERE id = $2) s`, [t2, ex]);
    return (/^MRS_DUPLICATE_TX/.test(r) && after.d === before.d && after.h === before.h && after.s === 'unreviewed') || J({ r, before, after });
  });
  await check('review fix — the duplicate rule under the DECLARATION\'s B/L: target without B/L + a container of another live transaction under the declaration B/L → review conflict shipment_on_other_tx (blocking, not confirmable, on_other_tx lists the container only), approval MRS_DUPLICATE_TX container, nothing written', async () => {
    const shared = nextCtr();
    const t1 = await mkTx({ bl: 'OWNBL0001' });
    await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, t1, shared]);
    const t2 = await mkTx({ bl: null });
    const ex = await declExt({ bl: 'OWNBL0001', ctrs: [shared, nextCtr()] });
    const rv = await review('jed', ex, t2);
    const c = rv.comparison;
    const r = await code(() => approve('jed', ex, t2, { version: rv.version }));
    const after = await one(`SELECT (SELECT count(*) FROM public.containers WHERE transaction_id = $1)::int c, (SELECT count(*) FROM public.customs_declarations WHERE transaction_id = $1)::int d,
                                    (SELECT review_status FROM public.document_extractions WHERE id = $2) s`, [t2, ex]);
    const conf = c.conflicts.filter(x => x.code === 'shipment_on_other_tx');
    return (c.bl.status === 'no_transaction_bl' && conf.length === 1 && conf[0].blocking && !conf[0].confirmable && J(c.containers.on_other_tx) === J([shared])
      && c.can_approve === false && !J(c).includes(t1) && r === 'MRS_DUPLICATE_TX container' && after.c === 0 && after.d === 0 && after.s === 'unreviewed') || J({ c, r, after });
  });
  await check('review fix — the same with a confirmed B/L mismatch (the target has another B/L): the declaration B/L + container twin → MRS_DUPLICATE_TX container even with confirm_bl_mismatch; a candidate reading (RTL order) is checked too; another B/L → approved', async () => {
    const shared = nextCtr();
    const t3 = await mkTx({ bl: 'OWNBL0002' });
    await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, t3, shared]);
    const t4 = await mkTx({ bl: 'OTHERBL9' });
    const ea = await declExt({ bl: 'OWNBL0002', ctrs: [shared] });
    const eb = await declExt({ bl: '0002 OWNBL', cands: ['0002 OWNBL', 'OWNBL0002'], ctrs: [shared] });
    const a = await code(() => approveNow('jed', ea, t4, { confirm_bl_mismatch: true }));
    const b = await code(() => approveNow('jed', eb, t4, { confirm_bl_mismatch: true }));
    const ok = await approveNow('jed', await declExt({ bl: 'UNRELATED77', ctrs: [shared] }), t4, { confirm_bl_mismatch: true });
    return (a === 'MRS_DUPLICATE_TX container' && b === 'MRS_DUPLICATE_TX container' && J(ok.containers.added) === J([shared])) || J({ a, b, ok: ok.containers });
  });
  await check('Ro-Ro: containers on the declaration → MRS_INVALID containers_roro; without containers it is approved', async () => {
    const t2 = await mkTx({ roro: true });
    const ea = await declExt();
    const a = await code(() => approveNow('jed', ea, t2));
    const b = await approveNow('jed', await declExt({ ctrs: [] }), t2);
    return (a === 'MRS_INVALID containers_roro' && b.declaration_action === 'added' && b.containers.added.length === 0) || J({ a, b });
  });
  await check('the declaration of a step-3 doc batch slot: approved (batch_id reported); the batch of another transaction → MRS_INVALID transaction_id', async () => {
    const t2 = await mkTx();
    const ex = await declExt();
    const bt = await rpc('jed', `SELECT public.create_doc_batch($1, $2) r`, [A, { transaction_id: t2 }]);
    await rpc('jed', `SELECT public.attach_doc_batch_document($1, $2) r`, [bt.id, { extraction_id: ex, slot: 'customs_declaration' }]);
    const t3 = await mkTx();
    const a = await code(() => approveNow('jed', ex, t3));
    const r = await approveNow('jed', ex, t2);
    const ap = await one(`SELECT batch_id FROM public.declaration_approvals WHERE id = $1`, [r.approval_id]);
    return (a === 'MRS_INVALID transaction_id' && r.batch_id === bt.id && ap.batch_id === bt.id) || J({ a, r });
  });
  await check('a second approved reading of the same declaration replaces its items (void-only) and raises the HS usage count', async () => {
    const t2 = await mkTx();
    const r1 = await approveNow('jed', await declExt({ no: 'REPL001', items: [{ hs_code: '730890', description: 'هياكل حديدية', amount: 100 }] }), t2);
    const r2 = await approveNow('jed', await declExt({ no: 'REPL001', status: 'released', items: [{ hs_code: '730890', description: 'هياكل حديدية', amount: 120 }] }), t2);
    const live = await q(`SELECT approval_id FROM public.declaration_items WHERE declaration_id = $1 AND voided_at IS NULL`, [r1.declaration.id]);
    const all = await num(`SELECT count(*) n FROM public.declaration_items WHERE declaration_id = $1`, [r1.declaration.id]);
    const h = await one(`SELECT usage_count FROM public.hs_reference WHERE org_id = $1 AND hs_code = '730890'`, [A]);
    return (r2.declaration.id === r1.declaration.id && live.length === 1 && live[0].approval_id === r2.approval_id && all === 2 && h.usage_count === 2) || J({ live, all, h });
  });
}

/* ================================================================== 7. HS reference */
async function secHs() {
  section('7. HS reference: learned from approvals only, invoice description, legacy scoring, org scope');
  const search = (who, qq, lim, org) => rpc(who || 'jed', `SELECT public.search_hs_reference($1, $2, $3) r`, [org || A, qq, lim == null ? 10 : lim]);
  await check('nothing is learned from a reading that is not approved (a review / a refused approval writes nothing)', async () => {
    const before = await num(`SELECT count(*) n FROM public.hs_reference WHERE hs_code = '940360'`);
    const t2 = await mkTx({ bl: 'NOLEARN01' });
    const ex = await declExt({ bl: 'NOLEARN02', items: [{ hs_code: '940360', description: 'أثاث خشبي' }] });
    await review('jed', ex, t2);
    await code(() => approveNow('jed', ex, t2));     // B/L mismatch, refused
    return (before === 0 && (await num(`SELECT count(*) n FROM public.hs_reference WHERE hs_code = '940360'`)) === 0) || 'learned';
  });
  await check('invoice description / scientific name come from the approved invoice line at the same position (step-3 shipment_invoice_items)', async () => {
    const t2 = await mkTx();
    const inv = await ext({ kind: 'commercial_invoice', fields: { invoice_number: 'HSINV1' } });
    const bt = await rpc('jed', `SELECT public.create_doc_batch($1, $2) r`, [A, { transaction_id: t2 }]);
    await rpc('jed', `SELECT public.attach_doc_batch_document($1, $2) r`, [bt.id, { extraction_id: inv, slot: 'commercial_invoice' }]);
    const s1 = await rpc('jed', `SELECT public.save_doc_batch_draft($1, $2) r`, [bt.id, { version: bt.version, draft: { invoice: { invoice_number: 'HSINV1',
      items: [{ description: 'FROZEN SHRIMP', scientific_name: 'Penaeus vannamei', quantity: 10 }, { description: 'FROZEN SQUID', quantity: 5 }] } } }]);
    await rpc('jed', `SELECT public.approve_doc_batch($1, $2) r`, [bt.id, { version: s1.version }]);
    const r = await approveNow('jed', await declExt({ items: [{ hs_code: '030617', description: 'روبيان مجمد' }, { hs_code: '030743', description: 'حبار مجمد' }] }), t2);
    const h = await q(`SELECT hs_code, invoice_description, scientific_name FROM public.hs_reference WHERE id = ANY ($1::uuid[]) ORDER BY hs_code`, [r.hs_reference.ids]);
    const it = await q(`SELECT invoice_description FROM public.declaration_items WHERE approval_id = $1 ORDER BY line_no`, [r.approval_id]);
    return (h.length === 2 && h[0].hs_code === '030617' && h[0].invoice_description === 'FROZEN SHRIMP' && h[0].scientific_name === 'Penaeus vannamei'
      && h[1].invoice_description === 'FROZEN SQUID' && it[1].invoice_description === 'FROZEN SQUID') || J({ h, it });
  });
  await check('uniqueness: same org + HS + normalised Arabic description (أ / ا, ة / ه folded) + invoice description = one row (usage 2); another description = another row', async () => {
    const t2 = await mkTx(), t3 = await mkTx();
    await approveNow('jed', await declExt({ items: [{ hs_code: '940161', description: 'كراسي مبطنة' }] }), t2);
    await approveNow('jed', await declExt({ items: [{ hs_code: '940161', description: 'كراسى  مبطنه' }, { hs_code: '940161', description: 'كراسي خشبية' }] }), t3);
    const rows = await q(`SELECT description_ar, usage_count FROM public.hs_reference WHERE org_id = $1 AND hs_code = '940161' ORDER BY usage_count DESC`, [A]);
    return (rows.length === 2 && rows[0].usage_count === 2 && rows[1].usage_count === 1) || J(rows);
  });
  await check('search scoring (legacy): code match 100 + phrase 50 + 10 per word + min(usage, 20); unmatched rows left out; sorted by score', async () => {
    // three rows: usage 1 / 1 / 25 (usage capped at 20)
    await q(`INSERT INTO public.hs_reference (org_id, hs_code, description_ar, invoice_description, usage_count, created_by, last_used_by) VALUES
             ($1, '847130', 'حاسب آلي محمول', 'LAPTOP COMPUTER', 1, $2, $2), ($1, '847150', 'وحدات معالجة', 'PROCESSING UNITS', 1, $2, $2),
             ($1, '852872', 'شاشات تلفزيون', 'LED TV', 25, $2, $2)`, [A, U.admin]);
    const a = await search('jed', '8471');
    const b = await search('jed', 'حاسب محمول');
    const c = await search('jed', 'شاشات تلفزيون');
    const d = await search('jed', 'xyz-none');
    const sc = (r, h) => (r.items.find(x => x.hs_code === h) || {}).score;
    // '8471': code 100 + phrase 50 (the HS is part of the row text) + word 10 + usage 1 = 161 for both 8471xx rows
    // 'حاسب محمول': phrase no (not contiguous), words 2 × 10, usage 1 = 21; 'شاشات تلفزيون': phrase 50 + 2 words 20 + usage min(25, 20) = 90
    return (a.count === 2 && sc(a, '847130') === 161 && sc(a, '847150') === 161 && b.items[0].hs_code === '847130' && sc(b, '847130') === 21
      && c.items[0].hs_code === '852872' && sc(c, '852872') === 90 && d.count === 0 && a.items.every(x => !('desc_key' in x))) || J({ a, b, c, d });
  });
  await check('search: limit clamped to 1..30; an empty query → no items; > 200 characters → MRS_TOO_LONG q', async () => {
    const one1 = await search('jed', '84', 0);
    const e = await search('jed', '   ');
    const long = await code(() => search('jed', 'x'.repeat(201)));
    return (one1.count === 1 && e.count === 0 && long === 'MRS_TOO_LONG q') || J({ one1, e, long });
  });
  await check('review fix — no cross-branch leak: a JED-learned row keeps its code / descriptions for dmm, but last_declaration_no / date / importer are NULL for dmm and set for jed / admin; a direct SELECT of the last_* columns is refused (column grants), the safe columns are readable', async () => {
    const t2 = await mkTx();
    const r = await approveNow('jed', await declExt({ no: '9990001', items: [{ hs_code: '12345678', description: 'بند فرع جدة' }] }), t2);
    const row = (who) => search(who, '12345678').then(x => x.items.find(i => i.hs_code === '12345678') || {});
    const d = await row('dmm'), j = await row('jed'), ad = await row('admin');
    const p1 = await code(() => as('dmm', `SELECT last_declaration_no FROM public.hs_reference`));
    const p2 = await code(() => as('dmm', `SELECT * FROM public.hs_reference`));
    const p3 = await code(() => as('jed', `SELECT last_importer, last_transaction_id FROM public.hs_reference`));
    const safe = await as('dmm', `SELECT id, hs_code, description_ar, usage_count FROM public.hs_reference WHERE hs_code = '12345678'`);
    return (d.description_ar === 'بند فرع جدة' && d.last_declaration_no === null && d.last_declaration_date === null && d.last_importer === null
      && j.last_declaration_no === '9990001' && j.last_importer === 'شركة الاختبار الأولى للتجارة' && ad.last_declaration_no === '9990001'
      && p1 === 'perm' && p2 === 'perm' && p3 === 'perm' && safe.length === 1 && r.hs_reference.saved === 1) || J({ d, j, ad, p1, p2, p3, safe });
  });
  await check('search scope: dmm (any branch of the org) sees the org library; staffB on A / portal / stranger → MRS_FORBIDDEN org; staffB on B sees only B', async () => {
    const dmm = await search('dmm', '8471');
    const r = [await code(() => search('staffB', '8471')), await code(() => search('portal', '8471')), await code(() => search('stranger', '8471'))];
    const b = await search('staffB', '8471', 10, B);
    return (dmm.count === 2 && r.every(x => x === 'MRS_FORBIDDEN org') && b.count === 0) || J({ dmm: dmm.count, r, b });
  });
}

/* ================================================================== 8. transaction declaration, export audit */
async function secTxDecl() {
  section('8. get_transaction_declaration (the Fasah sheet declaration part), the Fasah sheet export audit');
  const tx = await mkTx();
  const r = await approveNow('jed', await declExt({ items: [{ hs_code: '870830', description: 'فحمات' }, { hs_code: '870840', description: 'علب سرعة' }] }), tx);
  await check('get_transaction_declaration: active declaration, its live items in line order, the approvals (no result blob)', async () => {
    const g = await rpc('jed', `SELECT public.get_transaction_declaration($1) r`, [tx]);
    return (g.active.id === r.declaration.id && g.declarations.length === 1 && g.items.length === 2 && g.items[0].line_no === 1 && g.items[1].hs_code === '870840'
      && !('voided_at' in g.items[0]) && g.approvals.length === 1 && !('result' in g.approvals[0]) && g.approvals[0].daftra_hook === 'deferred') || J(g);
  });
  await check('review fix — get_transaction_declaration.containers = the declaration\'s own container list as last approved (added + updated + unchanged, in order), not only the rows it inserted; null without an approval', async () => {
    const t2 = await mkTx();
    const c0 = nextCtr(), c1 = nextCtr();
    await q(`INSERT INTO public.containers (org_id, transaction_id, container_no) VALUES ($1, $2, $3)`, [A, t2, c0]);
    const a = await approveNow('jed', await declExt({ no: 'CTRL001', ctrs: [c0, c1] }), t2);
    const g = await rpc('jed', `SELECT public.get_transaction_declaration($1) r`, [t2]);
    const t3 = await mkTx();
    await rpc('jed', `SELECT public.add_declaration($1, $2, NULL) r`, [t3, { declaration_no: 'CTRL002' }]);
    const g3 = await rpc('jed', `SELECT public.get_transaction_declaration($1) r`, [t3]);
    const src = await q(`SELECT container_no, source FROM public.containers WHERE transaction_id = $1 ORDER BY container_no`, [t2]);
    return (J(g.containers) === J([c0, c1]) && J(a.containers.declared) === J([c0, c1]) && g3.containers === null && src.filter(x => x.source === 'declaration').length === 1) || J({ g: g.containers, g3: g3.containers, src });
  });
  await check('get_transaction_declaration: dmm / staffB / portal → MRS_NOT_FOUND transaction; a transaction without declaration → active null, empty lists', async () => {
    const x = [];
    for (const w of ['dmm', 'staffB', 'portal']) x.push(await code(() => rpc(w, `SELECT public.get_transaction_declaration($1) r`, [tx])));
    const e = await rpc('jed', `SELECT public.get_transaction_declaration($1) r`, [await mkTx()]);
    return (x.every(v => v === 'MRS_NOT_FOUND transaction') && e.active === null && e.items.length === 0 && e.declarations.length === 0) || J({ x, e });
  });
  await check('log_report_export: report fasah_sheet with filters {transaction_id} is logged (xlsx / print); an unknown filter → MRS_INVALID filters; portal → refused', async () => {
    const a = await rpc('jed', `SELECT public.log_report_export($1, $2) r`, [A, { report: 'fasah_sheet', format: 'xlsx', filters: { transaction_id: tx }, row_count: 12 }]);
    const b = await rpc('jed', `SELECT public.log_report_export($1, $2) r`, [A, { report: 'fasah_sheet', format: 'print', filters: { transaction_id: tx }, row_count: 12 }]);
    const c = await code(() => rpc('jed', `SELECT public.log_report_export($1, $2) r`, [A, { report: 'fasah_sheet', format: 'xlsx', filters: { client_id: tx }, row_count: 1 }]));
    const p = await code(() => rpc('portal', `SELECT public.log_report_export($1, $2) r`, [A, { report: 'fasah_sheet', format: 'xlsx', filters: {}, row_count: 1 }]));
    const row = await one(`SELECT report, format, filters, row_count FROM public.report_exports WHERE id = $1`, [a.id]);
    return (a.id && b.id && c === 'MRS_INVALID filters' && /^MRS_(FORBIDDEN|NOT_FOUND)/.test(p) && row.report === 'fasah_sheet' && row.filters.transaction_id === tx && row.row_count === 12) || J({ c, p, row });
  });
}

/* ================================================================== 9. RLS, privileges, conversion */
async function secRls() {
  section('9. RLS on the new tables, containers.source, function privileges, conversion lists');
  const T = ['declaration_approvals', 'declaration_items', 'hs_reference'];
  await check('RLS enabled on the 3 tables; only SELECT for authenticated; nothing for anon', async () => {
    const r = await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY ($1) AND relnamespace = 'public'::regnamespace`, [T]);
    const g = await q(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public'
                        AND table_name = ANY ($1) AND grantee IN ('anon','authenticated')`, [T]);
    const cols = (await q(`SELECT column_name c FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'hs_reference'
                            AND grantee = 'authenticated' AND privilege_type = 'SELECT'`)).map(x => x.c);
    const other = await q(`SELECT column_name, grantee, privilege_type FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'hs_reference'
                            AND grantee IN ('anon','authenticated') AND NOT (grantee = 'authenticated' AND privilege_type = 'SELECT')`);
    const hidden = ['last_declaration_id', 'last_declaration_no', 'last_declaration_date', 'last_transaction_id', 'last_importer', 'created_by', 'last_used_by'];
    return (r.length === 3 && r.every(x => x.relrowsecurity) && g.length === 2 && g.every(x => x.grantee === 'authenticated' && x.privilege_type === 'SELECT')
      && !g.some(x => x.table_name === 'hs_reference') && ['id', 'org_id', 'hs_code', 'description_ar', 'usage_count'].every(c => cols.includes(c))
      && hidden.every(c => !cols.includes(c)) && other.length === 0) || J({ r, g, cols, other });
  });
  await check('direct writes are refused (permission denied) for an admin on the 3 tables', async () => {
    const r = [];
    for (const t of T) {
      r.push(await code(() => as('admin', `UPDATE public.${t} SET org_id = org_id`)));
      r.push(await code(() => as('admin', `DELETE FROM public.${t}`)));
    }
    r.push(await code(() => as('admin', `INSERT INTO public.hs_reference (org_id, hs_code, created_by, last_used_by) VALUES ($1, '1234', $2, $2)`, [A, U.admin])));
    return r.every(x => x === 'perm') || J(r);
  });
  await check('owner writes: no DELETE (MRS_APPEND_ONLY); a voided item is frozen; an approval is immutable except its Daftra hook', async () => {
    const a = await code(() => q(`DELETE FROM public.hs_reference WHERE org_id = $1`, [A]));
    const it = await one(`SELECT id FROM public.declaration_items WHERE voided_at IS NOT NULL LIMIT 1`);
    const b = await code(() => q(`UPDATE public.declaration_items SET notes = 'x' WHERE id = $1`, [it.id]));
    const ap = await one(`SELECT id FROM public.declaration_approvals LIMIT 1`);
    const c = await code(() => q(`UPDATE public.declaration_approvals SET bl_status = 'not_read' WHERE id = $1`, [ap.id]));
    const d = await code(() => q(`UPDATE public.declaration_approvals SET daftra_hook = 'pending' WHERE id = $1`, [ap.id]));
    await q(`UPDATE public.declaration_approvals SET daftra_hook = 'deferred' WHERE id = $1`, [ap.id]);
    return (/MRS_APPEND_ONLY/.test(a) && /MRS_IMMUTABLE voided_at/.test(b) && /MRS_IMMUTABLE/.test(c) && d === 'ok') || J({ a, b, c, d });
  });
  await check('SELECT: jed sees the JED rows; dmm none of them; staffB / portal nothing of A; anon permission denied; dmm reads the org HS library', async () => {
    const cnt = async (who, t, w) => Number((await as(who, `SELECT count(*) n FROM public.${t}` + (w || '')))[0].n);
    const jed = await cnt('jed', 'declaration_items'), all = await num(`SELECT count(*) n FROM public.declaration_items`);
    const dmm = await cnt('dmm', 'declaration_items'), dmmA = await cnt('dmm', 'declaration_approvals');
    const others = [];
    for (const t of T) { others.push(await cnt('staffB', t)); others.push(await cnt('portal', t)); }
    const an = await code(() => as('anon', `SELECT 1 FROM public.hs_reference`));
    const hs = await cnt('dmm', 'hs_reference'), hsAll = await num(`SELECT count(*) n FROM public.hs_reference WHERE org_id = $1`, [A]);
    return (jed === all && jed > 0 && dmm === 0 && dmmA === 0 && others.every(x => x === 0) && an === 'perm' && hs === hsAll && hs > 0) || J({ jed, all, dmm, others, an, hs, hsAll });
  });
  await check('containers.source: an API insert is manual whatever is sent; an API update cannot change it', async () => {
    const tx = await mkTx();
    const c = nextCtr();
    await as('jed', `INSERT INTO public.containers (org_id, transaction_id, container_no, source) VALUES ($1, $2, $3, 'declaration')`, [A, tx, c]);
    const s1 = (await one(`SELECT source FROM public.containers WHERE transaction_id = $1`, [tx])).source;
    await as('jed', `UPDATE public.containers SET source = 'declaration', notes = 'n' WHERE transaction_id = $1`, [tx]);
    const s2 = (await one(`SELECT source, notes FROM public.containers WHERE transaction_id = $1`, [tx]));
    const bad = await code(() => q(`UPDATE public.containers SET source = 'robot' WHERE transaction_id = $1`, [tx]));
    return (s1 === 'manual' && s2.source === 'manual' && s2.notes === 'n' && bad === 'chk:containers_source_chk') || J({ s1, s2, bad });
  });
  await check('function privileges: the 4 RPCs executable by authenticated only; internal helpers / triggers by nobody; pure normalisers not by anon', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('anon', p.oid, 'EXECUTE') an,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') sr
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1)`, [RPCS]);
    const h = await q(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
                         AND p.proname IN ('decl_draft_of','decl_compare','decl_review_version','hs_reference_learn','decl_reading','tg_legacy_decl_guard','tg_containers_source','decl_merge_notes')
                         AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))`);
    const n = await q(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname IN ('bl_tokens','bl_equivalent','hs_code_norm','decl_try_date')
                         AND has_function_privilege('anon', p.oid, 'EXECUTE')`);
    return (r.length === RPCS.length && r.every(x => x.au && !x.an && !x.sr) && h.length === 0 && n.length === 0) || J({ r, h, n });
  });
  await check('conversion lists: the 3 tables in app.convert_delete_tables (83 with the 3 tables of 20261121000100, the 4 of 20261122000100 and the 5 of 20261123000100), their no-delete guards in app.convert_delete_guards (44), every table classified', async () => {
    const t = (await one(`SELECT app.convert_delete_tables() t`)).t;
    const g = (await one(`SELECT app.convert_delete_guards() g`)).g;
    const keep = (await one(`SELECT app.convert_keep_tables() k`)).k;
    const all = (await q(`SELECT 'public.' || relname n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`)).map(x => x.n);
    const un = all.filter(x => !t.includes(x) && !keep.includes(x) && !['public.status_labels', 'public.schema_versions', 'public.organizations',
      'public.profiles', 'public.platform_admins', 'public.plans', 'public.customs_ports', 'public.daftra_mock_accounts'].includes(x));
    return (T.every(x => t.includes('public.' + x) && g.includes('public.' + x + ':trg_no_delete')) && g.length === 44 && t.length === 83 && un.length === 0) || J({ g: g.length, t: t.length, un });
  });
  await check('the trail: the approval / items / HS rows are audited without the document content (descriptions, result)', async () => {
    const r = await q(`SELECT table_name, new_data FROM public.audit_log WHERE table_name IN ('declaration_items','hs_reference','declaration_approvals') LIMIT 50`);
    return (r.length > 0 && r.every(x => !('description_ar' in (x.new_data || {})) && !('result' in (x.new_data || {})) && !('invoice_description' in (x.new_data || {})))) || J(r.slice(0, 2));
  });
}

/* ================================================================== 10. front end (static) */
async function secStatic() {
  section('10. supa.js wrappers, i18n, doc-match / ocr-parse / ocr.html');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  await check('supa.js: one exported wrapper per RPC, calling it by name; approval through the idempotent path; logReportExport accepts fasah_sheet', () => {
    const W = { getDeclarationReview: 'get_declaration_review', approveDeclarationExtraction: 'approve_declaration_extraction',
      getTransactionDeclaration: 'get_transaction_declaration', searchHsReference: 'search_hs_reference' };
    const miss = Object.keys(W).filter(f => !new RegExp('function ' + f + '\\(').test(supa) || !new RegExp(f + ': ' + f + '[,\\n]').test(supa) || !supa.includes("'" + W[f] + "'"));
    return (miss.length === 0 && Object.values(W).sort().join() === RPCS.join() && /idemRpc\('approve_declaration_extraction'/.test(supa)
      && /EXPORT_REPORTS = \[[^\]]*'fasah_sheet'/.test(supa)) || 'missing: ' + miss.join(', ');
  });
  await check('ocr-parse.js normalizeDate converts a Hijri date through MarsaNorm (Umm al-Qura); ocr.html loads legacy-norm.js', () => {
    const P = require(path.join(ROOT, 'assets', 'js', 'ocr-parse.js'));
    const html = fs.readFileSync(path.join(ROOT, 'ocr.html'), 'utf8');
    return (P.normalizeDate('15/03/1447هـ') === '2025-09-07' && P.normalizeDate('1447/01/01') === '2025-06-26' && P.normalizeDate('2026-10-15') === '2026-10-15'
      && P.normalizeDate('1447/02/30 هـ') === '' && /assets\/js\/legacy-norm\.js/.test(html)) || 'ocr-parse';
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
  await secHelpers();
  await secReview();
  await secApprove();
  await secHs();
  await secTxDecl();
  await secRls();
  await secStatic();
  await check('no network call was made', () => fetchCalls === 0);
  console.log('\n' + '-'.repeat(70));
  if (nFail) { console.log('FAILED — ' + nPass + ' passed, ' + nFail + ' failed'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('OK — ' + nPass + ' passed, 0 failed');
}
main().catch(e => { console.error(e); process.exit(1); });
