#!/usr/bin/env node
/*
  Marsa (مرسى) — in-place conversion staging → production: migration 20261115000100_convert_in_place.sql
  (public.convert_org_preview / public.convert_org_to_production), supabase/production/post_install_checks.sql on a
  converted database, and the planned site files deploy/convert/* (docs/online/CONVERT_IN_PLACE_AR.md).
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network.

  Databases:
    MAIN  shim → every migration → seed.sql → org A staff (seed-style) + the owner (platform admin, verified TOTP,
          admin membership) → the G7 operating cycle (lib/g7-cycle.js: request … billing push / issue … inbound e-mail
          … portal, real daftra-sync + inbox-sync workers on mocks) → extras (contact message, AI reading with its
          usage row, invitation, client error, storage objects, a live e-mail channel) → conversion
    SIDE  shim → every migration → seed.sql (org-level refusals: no owner membership, a second staging org, slug taken)
    FRESH shim → migrations before this file (preflight, re-run, catalog delta)
  The SQL Editor is the superuser with no JWT claims; API roles run as anon / authenticated / service_role.
  Review regressions: [D1] test invoices / clients pushed to Daftra block the conversion until acknowledged with the
  exact counts (marsa.convert_daftra_ack); [D2] accounts left without access are listed (preview, summary,
  post_install_checks.sql auth_users_without_access / warnings); [D5] kept configuration counted for review.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/convert-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261115000100_convert_in_place.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const CHECKS_FILE = path.join(SUPA, 'production', 'post_install_checks.sql');
const CRON_BLOCKERS = ['pg_cron_missing', 'cron_job_missing:marsa_idem_purge', 'cron_job_missing:marsa_client_errors_purge',
  'cron_job_missing:marsa_refresh_alerts'];

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in convert-tests'); };

const L = require(path.join(SUPA, 'tests', 'lib', 'g7-cycle.js'));

/* ------------------------------------------------------------------ harness (g7-e2e-tests.js) */
let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const J = x => JSON.stringify(x);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false: ' + J(r));
  } catch (e) { fail(name, 'threw: ' + errText(e) + (e && e.stack ? '\n        ' + e.stack.split('\n').slice(1, 3).join(' | ') : '')); }
}
async function tryErr(fn) { try { await fn(); return 'ok'; } catch (e) { return errText(e); } }

const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const SEED_TOKEN = 'deadbeef'.repeat(8);
const U = {
  A_admin: 'c0e00000-0000-4000-8000-000000000001', A_ops: 'c0e00000-0000-4000-8000-000000000002', A_clr: 'c0e00000-0000-4000-8000-000000000003',
  A_trn: 'c0e00000-0000-4000-8000-000000000004', A_acc: 'c0e00000-0000-4000-8000-000000000005', A_mgr: 'c0e00000-0000-4000-8000-000000000006',
  A_bm: 'c0e00000-0000-4000-8000-000000000007', A_client: 'c0e00000-0000-4000-8000-000000000008'
};
const OWNER = 'A_admin';
let keySeq = 0;
const newKey = () => `c0e0e000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;

let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else if (who === 'service') {
    await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function asService(fn) { return asRole('service', fn); }
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
const H = { q, one, num, rpc, as, asService, step, check, expectErr, pass, fail, section, errText, J, newKey, users: U };
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
async function freshDb(opts) {
  const d = new PGlite();
  await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles().filter(f => !opts.before || f < opts.before)) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  if (opts.seed) await d.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  return d;
}
const SQL_CONVERT = `SELECT public.convert_org_to_production($1, $2, $3, $4, $5) r`;
const setAck = v => q(`SELECT set_config('marsa.convert_daftra_ack', $1, false)`, [v]);
const getAck = async () => (await one(`SELECT coalesce(current_setting('marsa.convert_daftra_ack', true), '') v`)).v;
const NEW_SLUG = 'marsa-ksa';
const NAME_AR = 'مؤسسة مرسى للتخليص الجمركي';
const NAME_EN = 'Marsa Customs Clearance Est.';
const CONFIRM = 'DELETE-TEST-DATA-' + NEW_SLUG;
const convert = (org, slug, ar, en, confirm) => one(SQL_CONVERT, [org, slug, ar, en, confirm]).then(x => x.r);
const preview = org => one(`SELECT public.convert_org_preview($1) r`, [org]).then(x => x.r);
const env = async () => (await one(`SELECT environment e FROM app.deploy_settings`)).e;
const riyadhYear = async () => (await one(`SELECT extract(year FROM (now() AT TIME ZONE 'Asia/Riyadh'))::int y`)).y;
async function runChecks() {
  await db.exec('BEGIN READ ONLY');
  try { return (await q(fs.readFileSync(CHECKS_FILE, 'utf8')))[0].checks; }
  finally { await db.exec('ROLLBACK'); }
}
async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind = 'r' ORDER BY 1`)).map(x => x.t);
  const cols = (await q(`SELECT table_schema || '.' || table_name || '.' || column_name || ':' || data_type c
                           FROM information_schema.columns WHERE table_schema IN ('public','app') ORDER BY 1`)).map(x => x.c);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname || ':' || t.tgenabled::text x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                          WHERE NOT t.tgisinternal ORDER BY 1`)).map(x => x.x);
  return { fns, tables, cols, trg };
}
const DELETE_TABLES = async () => (await one(`SELECT app.convert_delete_tables() t`)).t;
async function countsOf(org, tables) {
  const out = {};
  for (const t of tables) out[t.split('.')[1]] = await num(`SELECT count(*) n FROM ${t} WHERE org_id = $1`, [org]);
  return out;
}
const orgState = async () => J([await one(`SELECT slug, name_ar, name_en, environment, settings FROM public.organizations WHERE id = $1`, [A]),
  await env(), await num(`SELECT count(*) n FROM app.org_conversions`)]);

/* ================================================================== 1. file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql, privileges in the file');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261114000100, schema_versions row, search_path = \'\' on every function', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261114000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261115000100', 'convert_in_place'\)/.test(src)
      && heads.length === 10 && bad.length === 0) || J({ n: heads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('SECURITY DEFINER on both public functions + convert_check / convert_storage_objects; every refusal goes through app.fail(\'MRS_*\')', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const definer = heads.filter(h => /SECURITY DEFINER/.test(h)).map(h => (h.match(/FUNCTION ([a-z_.]+)\(/) || [])[1]).sort();
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|CONVERT preflight/.test(r));
    const codes = src.match(/app\.fail\('([A-Z_]+)'/g) || [];
    return (J(definer) === J(['app.convert_accounts_without_access', 'app.convert_check', 'app.convert_daftra_pushed', 'app.convert_storage_objects',
      'public.convert_org_preview', 'public.convert_org_to_production'])
      && raises.length === 0 && codes.length >= 10 && codes.every(c => /app\.fail\('MRS_[A-Z_]+'/.test(c))) || J({ definer, raises });
  });
  await check('both public functions refuse a request with JWT claims; the file revokes them from every API role incl. service_role', () =>
    ((src.match(/IF nullif\(current_setting\('request\.jwt\.claims', true\), ''\) IS NOT NULL THEN\s+PERFORM app\.fail\('MRS_FORBIDDEN', 'sql_editor_only'\)/g) || []).length === 2
      && /REVOKE EXECUTE ON FUNCTION public\.convert_org_preview\(uuid\),\s+public\.convert_org_to_production\(uuid, text, text, text, text\)\s+FROM PUBLIC, anon, authenticated, service_role;/.test(src)
      && !/\bGRANT\b/.test(src.replace(/--.*$/gm, ''))) || 'jwt / revoke');
  await check('the confirm phrase is DELETE-TEST-DATA-<slug>; no TRUNCATE, no DROP, no session_replication_role; DISABLE only for the listed guards', () => {
    const code = src.replace(/--.*$/gm, '');
    return (/p_confirm IS DISTINCT FROM 'DELETE-TEST-DATA-' \|\| v_slug/.test(code) && !/\bTRUNCATE\s+(TABLE\s+)?(public|app)\./i.test(code)
      && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA)/i.test(code) && !/session_replication_role/.test(code)
      && (code.match(/DISABLE TRIGGER/g) || []).length === 1 && /FOREACH v_g IN ARRAY app\.convert_delete_guards\(\) LOOP\s+EXECUTE format\('ALTER TABLE %s DISABLE TRIGGER %I'/.test(code)) || 'body';
  });
  // later phases may follow this file (20261116000100 doc_match: re-creates convert_delete_tables / convert_delete_guards
  // with public.document_matches); none may sort before it unnoticed
  const LATER_PHASES = ['20261116000100_doc_match.sql', '20261117000100_legacy_core.sql', '20261118000100_legacy_tx.sql', '20261119000100_legacy_docs.sql', '20261120000100_legacy_decl.sql', '20261121000100_legacy_appt.sql', '20261122000100_legacy_pay.sql', '20261123000100_legacy_daftra.sql', '20261124000100_legacy_reports.sql', '20261125000100_legacy_import.sql'];
  await check('this file is present; only the listed later phases follow it', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER_PHASES.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (followed only by the listed later phases) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    const after = next < 0 ? [] : (all.slice(next).match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && after.every(f => LATER_PHASES.includes(f)) && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 6000).includes(MIG)) || 'not appended verbatim / no header line';
  });
}

/* ================================================================== 2. preflight, re-run, catalog delta */
const NEW_FNS = ['app.convert_accounts_without_access(p_org uuid)', 'app.convert_check(p_org uuid)', 'app.convert_daftra_pushed(p_org uuid)', 'app.convert_delete_guards()', 'app.convert_delete_tables()', 'app.convert_keep_tables()',
  'app.convert_storage_objects(p_org uuid)', 'app.tg_org_conversions_guard()', 'public.convert_org_preview(p_org uuid)',
  'public.convert_org_to_production(p_org uuid, p_slug text, p_name_ar text, p_name_en text, p_confirm text)'];
async function secPreflight() {
  section('2. preflight, re-run, catalog delta (separate database, seed loaded: the file changes no data)');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const d = await freshDb({ before: MIG, seed: true });
  try {
    await withDb(d, async () => {
      const C0 = await catalog();
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261114000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without ai_documents: exact preflight message', () =>
        msg.startsWith('CONVERT preflight: apply ai_documents first (schema_versions lacks 20261114000100 ai_documents)') || 'got: ' + msg);
      await check('without ai_documents: nothing created (catalog identical, no schema_versions row)', async () =>
        (J(C0) === J(await catalog()) && (await num(`SELECT count(*) n FROM public.schema_versions WHERE version = '20261115000100'`)) === 0) || 'catalog changed');
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261114000100', 'ai_documents')`);
      const rows = async () => J(await q(`SELECT (SELECT count(*) FROM public.organizations) o, (SELECT count(*) FROM public.transactions) t,
                                                (SELECT count(*) FROM public.audit_log) a, (SELECT count(*) FROM public.org_counters) c,
                                                (SELECT environment FROM app.deploy_settings) e, (SELECT slug FROM public.organizations LIMIT 1) s`));
      const before = await rows();
      const r1 = await tryErr(() => db.exec(src));
      const C1 = await catalog();
      const r2 = await tryErr(() => db.exec(src));
      await check('applies, and re-runs on top of itself with an identical catalog', async () =>
        (r1 === 'ok' && r2 === 'ok' && J(C1) === J(await catalog())) || J({ r1, r2 }));
      await check('applying the file changed no data (org, transactions, audit, counters, environment, slug)', async () => (await rows()) === before || 'data changed');
      const m0 = new Map(C0.fns.map(f => [f.sig, f]));
      await check('exactly the 10 new functions; no existing function body / ACL / config changed (set_deploy_environment untouched)', () => {
        const added = C1.fns.filter(f => !m0.has(f.sig)).map(f => f.sig).sort();
        const changed = C1.fns.filter(f => m0.has(f.sig) && J(m0.get(f.sig)) !== J(f)).map(f => f.sig);
        return (J(added) === J(NEW_FNS.slice().sort()) && changed.length === 0) || J({ added, changed });
      });
      await check('tables: + app.org_conversions only; no column of an existing table changed; + its 2 guard triggers', () => {
        const dl = (a, b) => ({ add: b.filter(x => !a.includes(x)), del: a.filter(x => !b.includes(x)) });
        const t = dl(C0.tables, C1.tables), c = dl(C0.cols, C1.cols), tr = dl(C0.trg, C1.trg);
        return (J(t) === J({ add: ['app.org_conversions'], del: [] }) && c.del.length === 0 && c.add.every(x => x.startsWith('app.org_conversions.'))
          && J(tr.add.sort()) === J(['org_conversions.trg_append_only:O', 'org_conversions.trg_append_only_trunc:O']) && tr.del.length === 0) || J({ t, c, tr });
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. populate MAIN */
const ORG = {
  key: 'A', id: A, slug: 'blue-sea', prefix: 'MRS', br1: JED, br2: DMM, tag: 'c0e',
  users: { admin: 'A_admin', ops: 'A_ops', clr: 'A_clr', trn: 'A_trn', acc: 'A_acc', mgr: 'A_mgr', bm: 'A_bm', client: 'A_client' },
  email: 'inbox@convert-a.example', wa: '0500000801', waNorm: '+966500000801', phone: '0501118001', vat: '300000000800003', cr: '7000000801',
  bl: 'MEDUC0E0001', containers: [L.isoContainer('MSCU', 800001), L.isoContainer('MSCU', 800002), L.isoContainer('MSCU', 800003)],
  attachClient: async (clientId) => {
    await q(`INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [A, clientId, U.A_client]);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'client')`, [U.A_client, A]);
  },
  d: {}
};
let LIVE_CH = null;
const DAFTRA_ACK = () => PRE.ack;
async function populate() {
  section('3. MAIN: seed + staff + owner + operating cycle + extras (test data of every kind)');
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase().replace('_', '.')}@convert.example.com', now())`).join(', ');
  await step('fixtures: staff users (seed-style), the owner = platform admin with a verified TOTP factor + admin membership', async () => {
    await db.exec(`
      INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
      INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.A_admin}', 'owner');
      INSERT INTO auth.mfa_factors (user_id, factor_type, status) VALUES ('${U.A_admin}', 'totp', 'verified');
      INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
        ('${U.A_admin}', '${A}', NULL, 'admin'), ('${U.A_ops}', '${A}', NULL, 'operations_manager'), ('${U.A_clr}', '${A}', '${JED}', 'clearance_staff'),
        ('${U.A_trn}', '${A}', '${JED}', 'transport_staff'), ('${U.A_acc}', '${A}', NULL, 'accountant'), ('${U.A_mgr}', '${A}', NULL, 'accounts_manager'),
        ('${U.A_bm}', '${A}', '${JED}', 'branch_manager'), ('${U.A_admin}', '${A}', '${DMM}', 'clearance_staff');`);
    const n = (await one(`SELECT app.seed_document_requirements($1) n`, [A])).n;
    if (!(n > 0)) throw new Error('document requirements ' + n);
  });
  const W = L.createWorkers(H, ROOT);
  await L.setupOrg(H, W, ORG);
  const steps = L.cycleSteps(H, W, ORG);
  for (const s of steps) await step(s.title, s.run);
  await step('[A] extras: contact message (anon), invitation (admin), client error (staff), AI reading + usage row, storage objects', async () => {
    const m = await rpc('anon', `SELECT public.submit_contact_message($1) r`, [{ orgSlug: 'blue-sea', name: 'زائر تجريبي', phone: '0126100001',
      email: 'v@example.com', subject: 'quote', message: 'رسالة اختبار طويلة بما يكفي للتحقق', consent: true, antispam: { hp: '', elapsedMs: 4000 } }]);
    if (!/^MSG-\d{4}-\d{6}$/.test(m.ref || '')) throw new Error('contact ' + J(m));
    const inv = await rpc('A_admin', `SELECT public.admin_invite($1, $2) r`, [A, { email: 'new.staff@convert.example.com', role: 'accountant', idempotencyKey: newKey() }]);
    if (!inv.invitation_id && !inv.id) throw new Error('invite ' + J(inv));
    await rpc('A_ops', `SELECT public.log_client_error($1) r`, [{ page: '/admin.html', code: 'TypeError', message: 'test error', ua: 'test' }]);
    await rpc('A_admin', `SELECT public.ai_save_settings($1, $2) r`, [A, { enabled: true, consent_ack: true, daily_request_cap: 50, monthly_budget_usd: 20 }]);
    const res = await asService(() => q(`SELECT public.ai_reserve($1, $2, 'doc_extract', NULL) r`, [A, U.A_ops])).then(r => r[0].r);
    const rid = res.reservation_id || res.id || res;
    await asService(() => q(`SELECT public.ai_settle($1, 1200, 300, 'ok', 'claude-opus-5-5', NULL) r`, [rid]));
    await as('A_ops', `INSERT INTO public.document_extractions (org_id, doc_type, source_name, source_sha256, engine, languages, raw_text,
                        extracted_fields, line_items, created_by, ai_usage_id)
                       VALUES ($1, 'bill_of_lading', 'bl.pdf', $2, 'claude-opus-5-5', 'auto', '[claude-opus-5-5] bill_of_lading',
                               '{"bl_number":"MEDU1234567"}', '[]', $3, $4)`, [A, 'c0e'.padEnd(64, 'a'), U.A_ops, rid]);
    // a saved invoice ↔ B/L match (20261116000100 doc_match) on that reading + an invoice reading
    const mx = await as('A_ops', `INSERT INTO public.document_extractions (org_id, doc_type, source_name, source_sha256, engine, languages, raw_text,
                        extracted_fields, line_items, created_by)
                       VALUES ($1, 'commercial_invoice', 'inv.pdf', $2, 'tesseract.js@5.1.1', 'ara+eng', 'فاتورة', '{"bl_number":"MEDU1234567"}', '[]', $3)
                       RETURNING id`, [A, 'c0e'.padEnd(64, 'b'), U.A_ops]);
    const bx = await one(`SELECT id FROM public.document_extractions WHERE org_id = $1 AND ai_usage_id = $2`, [A, rid]);
    await rpc('A_ops', `SELECT public.save_document_match($1, $2) r`, [A, { invoice_extraction_id: mx[0].id, bl_extraction_id: bx.id, mode: 'two_way',
      engine_version: 'match-v1', overall: 'match', counts: { match: 1 }, rows: [{ key: 'bl_number', status: 'match', critical: true,
      values: { invoice: 'MEDU1234567', bl: 'MEDU1234567' } }] }]);
    await q(`INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
               ('documents', $1 || '/tx/doc/bl.pdf', '{"size": 1000}'), ('finance', $1 || '/fin/inv.pdf', '{"size": 2000}'),
               ('messages', $1 || '/m/a/b/x.pdf', '{"size": 10}'), ('documents', 'ffffffff-0000-4000-8000-000000000000/x/y/z.pdf', '{"size": 1}')`, [A]);
    const ct = await rpc('A_ops', `SELECT public.save_msg_contact($1, $2, $3) r`, [A, { display_name: 'وكيل الشحن التجريبي', entity_type: 'other' }, newKey()]);
    await rpc('A_ops', `SELECT public.add_msg_contact_address($1, $2, $3) r`, [ct.id, { kind: 'email', address: 'agent@convert-a.example' }, newKey()]);
    // the live e-mail channel of the owner (ops@marsacloud.com): kept as it is
    LIVE_CH = (await one(`INSERT INTO public.msg_channels (org_id, kind, name, address, address_norm, default_branch_id, mode, status, ingest_enabled,
                                                           send_enabled, provider_terms_ack_by, provider_terms_ack_at, poll_cursor)
                          VALUES ($1, 'email', 'بريد العمليات', 'ops@marsacloud.com', 'ops@marsacloud.com', $2, 'live_pending', 'connected', true, true,
                                  $3, now(), 'uid:4242') RETURNING id`, [A, JED, U.A_admin])).id;
  });
}

/* ================================================================== 4. privileges + preview */
async function secPrivileges() {
  section('4. privileges (SQL Editor only) + preview');
  await check('no API role (anon / authenticated / service_role) may execute the conversion, the preview or any app.convert_* helper', async () => {
    const r = await q(`SELECT p.oid::regprocedure::text f, r.rolname FROM pg_proc p CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) r(rolname)
                        WHERE (p.proname IN ('convert_org_preview','convert_org_to_production') AND p.pronamespace = 'public'::regnamespace
                               OR p.proname LIKE 'convert\\_%' AND p.pronamespace = 'app'::regnamespace OR p.proname = 'tg_org_conversions_guard')
                          AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')`);
    const n = await num(`SELECT count(*) n FROM pg_proc WHERE proname IN ('convert_org_preview','convert_org_to_production','convert_check','convert_delete_tables',
                          'convert_keep_tables','convert_delete_guards','convert_storage_objects','tg_org_conversions_guard','convert_daftra_pushed',
                          'convert_accounts_without_access')`);
    return (r.length === 0 && n === 10) || J({ r, n });
  });
  await check('app.org_conversions: RLS on, no grant to any API role', async () => {
    const r = await one(`SELECT c.relrowsecurity rls, has_table_privilege('authenticated', 'app.org_conversions', 'SELECT') a,
                                has_table_privilege('service_role', 'app.org_conversions', 'SELECT') s, has_table_privilege('anon', 'app.org_conversions', 'SELECT') n
                           FROM pg_class c WHERE c.oid = 'app.org_conversions'::regclass`);
    return (r.rls && !r.a && !r.s && !r.n) || J(r);
  });
  for (const who of ['anon', 'A_admin', 'service']) {
    await expectErr(`${who}: convert_org_to_production → permission denied`, () => as(who, SQL_CONVERT, [A, NEW_SLUG, NAME_AR, NAME_EN, CONFIRM]), /permission denied/);
  }
  await expectErr('service_role: convert_org_preview → permission denied', () => as('service', `SELECT public.convert_org_preview($1)`, [A]), /permission denied/);
  await expectErr('the SQL Editor role WITH JWT claims (a request through the API) → MRS_FORBIDDEN sql_editor_only', async () => {
    await db.exec(`SELECT set_config('request.jwt.claims', '{"sub":"${U.A_admin}","role":"authenticated"}', false)`);
    try { await convert(A, NEW_SLUG, NAME_AR, NAME_EN, CONFIRM); } finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false)`); }
  }, /MRS_FORBIDDEN.*sql_editor_only/);
  await expectErr('preview with JWT claims → MRS_FORBIDDEN sql_editor_only', async () => {
    await db.exec(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    try { await preview(A); } finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false)`); }
  }, /MRS_FORBIDDEN.*sql_editor_only/);
  const tables = await DELETE_TABLES();
  const counts = await countsOf(A, tables);
  let p;
  PRE.ack = 'DAFTRA-CLEARED-' + (await num(`SELECT count(*) n FROM public.billing_intents WHERE org_id = $1 AND (external_invoice_id IS NOT NULL
      OR daftra_number IS NOT NULL OR pushed_at IS NOT NULL OR sync_state <> 'idle')`, [A]))
    + '-' + (await num(`SELECT count(*) n FROM public.daftra_client_links WHERE org_id = $1`, [A]));
  await check('preview: read-only, only blocker = daftra_not_cleared:<ack> (test invoices / clients pushed), would_delete = the real row counts', async () => {
    const before = await orgState();
    p = await preview(A);
    const diff = Object.keys(counts).filter(k => p.would_delete[k] !== counts[k]);
    return (J(p.blockers) === J(['daftra_not_cleared:' + DAFTRA_ACK()]) && diff.length === 0 && p.would_delete_total === Object.values(counts).reduce((a, b) => a + b, 0)
      && p.environment === 'staging' && p.deploy_environment === 'staging' && before === await orgState()) || J({ blockers: p.blockers, diff });
  });
  if (!p) return;
  await check('preview: memberships kept = the owner admin only; removed = the 7 test staff / client roles + the owner\'s extra role', () =>
    (p.memberships_kept.length === 1 && p.memberships_kept[0].role === 'admin' && p.memberships_kept[0].email === 'a***@convert.example.com'
      && p.memberships_removed.length === 8) || J({ kept: p.memberships_kept, removed: p.memberships_removed }));
  await check('[D1] preview: daftra_pushed lists every pushed test invoice (operational_ref + external id) and every Daftra client link; ack = counts', async () => {
    const inv = await q(`SELECT operational_ref, external_invoice_id FROM public.billing_intents WHERE org_id = $1
                          AND (external_invoice_id IS NOT NULL OR daftra_number IS NOT NULL OR pushed_at IS NOT NULL OR sync_state <> 'idle')
                          ORDER BY operational_ref, revision`, [A]);
    const cli = await q(`SELECT l.external_id, c.vat_number FROM public.daftra_client_links l JOIN public.clients c ON c.id = l.client_id
                          WHERE l.org_id = $1 ORDER BY l.client_ref`, [A]);
    const d = p.daftra_pushed;
    return (inv.length >= 1 && cli.length >= 1 && d.invoices === inv.length && d.clients === cli.length
      && d.ack === `DAFTRA-CLEARED-${inv.length}-${cli.length}`
      && J(d.invoice_list.map(x => [x.operational_ref, x.external_invoice_id])) === J(inv.map(x => [x.operational_ref, x.external_invoice_id]))
      && d.invoice_list.every(x => /^MRS-\d{4}-\d{6}\//.test(x.operational_ref)) && inv.some(x => x.external_invoice_id)
      && J(d.client_list.map(x => [x.external_id, x.vat_number])) === J(cli.map(x => [x.external_id, x.vat_number]))
      && !!(d.connection && d.connection.mode)) || J({ d, inv, cli });
  });
  await check('[D2] preview: accounts_without_access_after = every non-admin account whose only memberships are in this org (masked)', async () => {
    const n = await num(`SELECT count(*) n FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = u.id)
                           AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id AND m.org_id <> $1 AND m.is_active)`, [A]);
    const a = p.accounts_without_access_after;
    PRE.noacc = n;
    return (n >= 7 && a.count === n && a.emails.length === n && a.emails.includes('a***@convert.example.com')
      && a.emails.every(e => /\*\*\*@/.test(e)) && J(p.platform_admins) === J(['a***@convert.example.com'])) || J({ n, a, pa: p.platform_admins });
  });
  await check('[D5] preview: kept_config_review counts the kept configuration; warnings [] (one platform admin, one kept admin membership)', async () => {
    const k = p.kept_config_review;
    const rq = await num(`SELECT count(*) n FROM public.document_requirements WHERE org_id = $1`, [A]);
    return (J(Object.keys(k).sort()) === J(['daftra_item_links', 'document_requirements', 'msg_auto_reply_policies', 'msg_instructions', 'msg_templates'])
      && k.document_requirements === rq && J(p.warnings) === '[]') || J({ k, w: p.warnings });
  });
  await check('preview: branches DMM + JED, 3 channels, storage objects of the org folder (3: documents / finance / messages)', () =>
    (J(p.branches) === J(['DMM', 'JED']) && p.msg_channels.length === 3
      && J([p.storage_objects.documents, p.storage_objects.finance, p.storage_objects.messages]) === J([1, 1, 1])) || J({ b: p.branches, s: p.storage_objects }));
}

/* ================================================================== 5. refusals (nothing changes) */
async function secRefusals() {
  section('5. refusals on MAIN: wrong confirm, bad slug / names, unclassified table, unknown delete guard — nothing changes');
  const tt = await L.tenantTables(H);
  const hash0 = await L.stateHash(H, A, tt);
  const st0 = await orgState();
  const bad = [
    ['wrong confirm', [A, NEW_SLUG, NAME_AR, NAME_EN, 'DELETE-TEST-DATA-other'], /MRS_INVALID.*confirm/],
    ['confirm missing', [A, NEW_SLUG, NAME_AR, NAME_EN, null], /MRS_INVALID.*confirm/],
    ['confirm of the old slug', [A, NEW_SLUG, NAME_AR, NAME_EN, 'DELETE-TEST-DATA-blue-sea'], /MRS_INVALID.*confirm/],
    ['slug with upper case / underscore', [A, 'Marsa_KSA', NAME_AR, NAME_EN, 'DELETE-TEST-DATA-marsa_ksa'], /MRS_INVALID.*slug/],
    ['slug too short', [A, 'ab', NAME_AR, NAME_EN, 'DELETE-TEST-DATA-ab'], /MRS_INVALID.*slug/],
    ['slug too long (41)', [A, 'a'.repeat(41), NAME_AR, NAME_EN, 'DELETE-TEST-DATA-' + 'a'.repeat(41)], /MRS_INVALID.*slug/],
    ['slug starting with a dash', [A, '-marsa', NAME_AR, NAME_EN, 'DELETE-TEST-DATA--marsa'], /MRS_INVALID.*slug/],
    ['slug with a space', [A, 'marsa ksa', NAME_AR, NAME_EN, 'DELETE-TEST-DATA-marsa ksa'], /MRS_INVALID.*slug/],
    ['the seed slug blue-sea', [A, 'blue-sea', NAME_AR, NAME_EN, 'DELETE-TEST-DATA-blue-sea'], /MRS_INVALID.*slug_demo/],
    ['Arabic name still marked test (تجريبية)', [A, NEW_SLUG, 'مؤسسة مرسى (بيئة تجريبية)', NAME_EN, CONFIRM], /MRS_INVALID.*name_ar/],
    ['Arabic name too short', [A, NEW_SLUG, 'م', NAME_EN, CONFIRM], /MRS_INVALID.*name_ar/],
    ['English name still marked staging', [A, NEW_SLUG, NAME_AR, 'Marsa (staging)', CONFIRM], /MRS_INVALID.*name_en/],
    ['unknown org', ['0b5e0000-0000-4000-8000-0000000000ff', NEW_SLUG, NAME_AR, NAME_EN, CONFIRM], /MRS_NOT_FOUND/]
  ];
  for (const [label, a, re] of bad) await expectErr('refused: ' + label, () => convert(...a), re);
  // D1: test invoices / clients pushed to Daftra must be removed there and acknowledged with the exact current counts
  await expectErr('[D1] refused: test documents pushed to Daftra, no acknowledgement → MRS_FORBIDDEN daftra_not_cleared:<ack>',
    () => convert(A, NEW_SLUG, NAME_AR, NAME_EN, CONFIRM), new RegExp('MRS_FORBIDDEN.*daftra_not_cleared:' + PRE.ack + '(\\s|$)'));
  for (const [label, v] of [['a stale acknowledgement (other counts)', 'DAFTRA-CLEARED-0-0'], ['the acknowledgement in lower case', PRE.ack.toLowerCase()],
                            ['the acknowledgement with a trailing space', PRE.ack + ' ']]) {
    await expectErr('[D1] refused: ' + label + ' → MRS_FORBIDDEN daftra_not_cleared', async () => {
      await setAck(v);
      try { await convert(A, NEW_SLUG, NAME_AR, NAME_EN, CONFIRM); } finally { await setAck(''); }
    }, /MRS_FORBIDDEN.*daftra_not_cleared/);
  }
  await check('[D1] the preview with the exact acknowledgement has no blocker (and stays read-only)', async () => {
    await setAck(PRE.ack);
    try { const p = await preview(A); return J(p.blockers) === '[]' || J(p.blockers); } finally { await setAck(''); }
  });
  await expectErr('refused: an org-scoped table that is not classified (added later) → MRS_FORBIDDEN unclassified_tables (rolled back)', async () => {
    await db.exec(`BEGIN; CREATE TABLE public.zz_new_org_table (id int, org_id uuid);`);
    try { await convert(A, NEW_SLUG, NAME_AR, NAME_EN, CONFIRM); } finally { await db.exec('ROLLBACK'); }
  }, /MRS_FORBIDDEN.*unclassified_tables:public\.zz_new_org_table/);
  await expectErr('refused: a BEFORE DELETE trigger on a deleted table that is not a listed guard → MRS_FORBIDDEN unexpected_delete_guards', async () => {
    await db.exec(`BEGIN; CREATE TRIGGER zz_guard BEFORE DELETE ON public.clients FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();`);
    try { await convert(A, NEW_SLUG, NAME_AR, NAME_EN, CONFIRM); } finally { await db.exec('ROLLBACK'); }
  }, /MRS_FORBIDDEN.*unexpected_delete_guards:public\.clients:zz_guard/);
  await check('after every refusal: every tenant table of the org, the org row, the deployment environment unchanged; no conversion row', async () => {
    const d = L.hashDiff(hash0, await L.stateHash(H, A, tt));
    return (d.length === 0 && st0 === await orgState()) || d.join(', ');
  });
  await check('every listed guard is enabled (no refusal left a guard disabled)', async () =>
    (await num(`SELECT count(*) n FROM unnest(app.convert_delete_guards()) g JOIN pg_trigger t
                  ON t.tgrelid = split_part(g, ':', 1)::regclass AND t.tgname = split_part(g, ':', 2) WHERE t.tgenabled = 'O'`)) === 44);   // 23 + document_matches (20261116000100) + 5 legacy docs tables (20261119000100) + 3 legacy decl tables (20261120000100) + 3 legacy appt tables (20261121000100) + 4 legacy pay tables (20261122000100) + 5 legacy daftra tables (20261123000100)
}

/* ================================================================== 6. org-level refusals (SIDE database) */
async function secSide() {
  section('6. SIDE database: no owner membership, a second staging org, slug taken');
  const d = await freshDb({ seed: true });
  try {
    await withDb(d, async () => {
      await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${U.A_admin}', 'owner@side.example.com');
                     INSERT INTO public.platform_admins (user_id) VALUES ('${U.A_admin}');`);
      await expectErr('no platform admin with an admin membership of the org → MRS_FORBIDDEN owner_admin_membership_missing',
        () => convert(A, NEW_SLUG, NAME_AR, NAME_EN, CONFIRM), /MRS_FORBIDDEN.*owner_admin_membership_missing/);
      await db.exec(`INSERT INTO public.memberships (user_id, org_id, role) VALUES ('${U.A_admin}', '${A}', 'admin');
                     INSERT INTO public.organizations (slug, name_ar, ref_prefix) VALUES ('other-test', 'مؤسسة أخرى', 'OTH');`);
      await expectErr('a second (staging) org exists → MRS_FORBIDDEN other_staging_orgs:other-test',
        () => convert(A, NEW_SLUG, NAME_AR, NAME_EN, CONFIRM), /MRS_FORBIDDEN.*other_staging_orgs:other-test/);
      await expectErr('the new slug is another org\'s slug → MRS_INVALID slug_taken',
        () => convert(A, 'other-test', NAME_AR, NAME_EN, 'DELETE-TEST-DATA-other-test'), /MRS_INVALID.*slug_taken/);
      await check('SIDE: still staging, the seed org untouched, no conversion row', async () =>
        ((await env()) === 'staging' && (await one(`SELECT slug FROM public.organizations WHERE id = $1`, [A])).slug === 'blue-sea'
          && (await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1`, [A])) === 3
          && (await num(`SELECT count(*) n FROM app.org_conversions`)) === 0) || 'changed');
      await check('SIDE preview lists the other staging org as the blocker', async () => {
        const p = await preview(A);
        return (p.blockers.length === 1 && /^other_staging_orgs:other-test$/.test(p.blockers[0])) || J(p.blockers);
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 7. the conversion (MAIN) */
let R = null;
const PRE = {};
async function secConvert() {
  section('7. the conversion on MAIN');
  const tables = await DELETE_TABLES();
  PRE.counts = await countsOf(A, tables);
  PRE.auditMax = Number((await one(`SELECT max(id) m FROM public.audit_log`)).m);
  PRE.audit = await num(`SELECT count(*) n FROM public.audit_log`);
  PRE.aiUsage = await num(`SELECT count(*) n FROM app.ai_usage WHERE org_id = $1`, [A]);
  PRE.subEvents = await num(`SELECT count(*) n FROM public.subscription_events WHERE org_id = $1`, [A]);
  PRE.reports = await num(`SELECT count(*) n FROM public.report_exports WHERE org_id = $1`, [A]);
  PRE.requirements = await num(`SELECT count(*) n FROM public.document_requirements WHERE org_id = $1`, [A]);
  PRE.daftra = await one(`SELECT mode, status, subdomain FROM public.daftra_connections WHERE org_id = $1`, [A]);
  PRE.ai = await one(`SELECT enabled, consent_ack_at IS NOT NULL ack FROM app.ai_settings WHERE org_id = $1`, [A]);
  PRE.live = await one(`SELECT * FROM public.msg_channels WHERE id = $1`, [LIVE_CH]);
  PRE.catalog = await L.catalogFingerprint(H);
  PRE.sub = await one(`SELECT plan_code, status FROM public.org_subscriptions WHERE org_id = $1`, [A]);
  const must = ['service_requests', 'clients', 'client_users', 'invitations', 'idempotency_keys', 'contact_messages', 'transactions', 'transaction_events',
    'transaction_bls', 'bills_of_lading', 'customs_declarations', 'containers', 'documents', 'document_extractions', 'document_matches', 'parties', 'drivers',
    'trucks', 'transport_trips', 'port_appointments', 'supplier_invoices', 'supplier_invoice_lines', 'cost_allocations', 'client_charges', 'finance_documents',
    'billing_intents', 'billing_intent_lines', 'billing_sync_jobs', 'billing_sync_attempts', 'daftra_client_links',
    'msg_threads', 'msg_messages', 'msg_jobs', 'msg_job_attempts', 'msg_thread_links', 'msg_contacts', 'msg_contact_addresses'];
  await check('the populated org holds test rows in every core business table (' + must.length + ' tables)', () => {
    const empty = must.filter(t => !(PRE.counts[t] > 0));
    return empty.length === 0 || 'empty: ' + empty.join(', ');
  });
  if (!QUIET) console.log('  rows before: ' + Object.entries(PRE.counts).filter(([, n]) => n).map(([t, n]) => t + '=' + n).join(' '));
  const t0 = Date.now();
  await setAck(PRE.ack);
  try { R = await convert(A, NEW_SLUG, NAME_AR, NAME_EN, CONFIRM); pass('convert_org_to_production runs (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { fail('convert_org_to_production runs', errText(e)); return; }
  await check('summary: deleted per table = the rows the org had; total; memberships 8; counters reset; 2 mock channels switched off; 44 guards (23 + document_matches + 5 legacy docs tables + 3 legacy decl tables + 3 legacy appt tables + 4 legacy pay tables + 5 legacy daftra tables)', () => {
    const diff = Object.keys(PRE.counts).filter(k => R.deleted[k] !== PRE.counts[k]);
    const total = Object.values(PRE.counts).reduce((a, b) => a + b, 0) + 8;
    return (diff.length === 0 && R.deleted.memberships === 8 && R.deleted_total === total && R.reset.org_counters >= 3 && R.reset.org_usage_counters >= 1
      && R.mock_channels_disabled === 2 && R.guards_bypassed === 44 && R.from_slug === 'blue-sea' && R.slug === NEW_SLUG) || J({ diff, R: Object.assign({}, R, { deleted: undefined }) });
  });
  await check('[D1] summary.daftra_cleared = the acknowledged list (counts, ack, invoice / client lists); the acknowledgement setting is cleared', async () => {
    const d = R.daftra_cleared;
    return (d.ack === PRE.ack && `DAFTRA-CLEARED-${d.invoices}-${d.clients}` === PRE.ack && d.invoice_list.length === d.invoices
      && d.client_list.length === d.clients && !('connection' in d) && (await getAck()) === '') || J({ d, ack: await getAck() });
  });
  await check('[D2] summary.accounts_without_access = the accounts the owner must delete (count + masked e-mails)', () =>
    (R.accounts_without_access.count === PRE.noacc && R.accounts_without_access.emails.length === PRE.noacc
      && R.accounts_without_access.emails.every(e => /\*\*\*@/.test(e))) || J(R.accounts_without_access));
  await check('[D1] after the conversion the Daftra list is empty: no ack needed any more, preview daftra_pushed 0 / 0', async () => {
    const d = (await preview(A)).daftra_pushed;
    return (d.invoices === 0 && d.clients === 0 && d.ack === null) || J(d);
  });
  await check('every deleted table is empty for the org', async () => {
    const left = Object.entries(await countsOf(A, tables)).filter(([, n]) => n > 0);
    return left.length === 0 || J(left);
  });
  await check('memberships: only the owner\'s admin membership; branches JED + DMM kept (same ids)', async () => {
    const m = await q(`SELECT user_id, role FROM public.memberships WHERE org_id = $1`, [A]);
    const b = await q(`SELECT id, code FROM public.branches WHERE org_id = $1 ORDER BY code`, [A]);
    return (m.length === 1 && m[0].user_id === U.A_admin && m[0].role === 'admin' && J(b.map(x => x.id)) === J([DMM, JED])) || J({ m, b });
  });
  await check('the live channel ops@marsacloud.com is unchanged (connected, ingest / send on, poll cursor kept); mock channels kept, disabled', async () => {
    const live = await one(`SELECT * FROM public.msg_channels WHERE id = $1`, [LIVE_CH]);
    const mock = await q(`SELECT status, ingest_enabled i, send_enabled s FROM public.msg_channels WHERE org_id = $1 AND mode = 'mock'`, [A]);
    return (J(live) === J(PRE.live) && mock.length === 2 && mock.every(x => x.status === 'disabled' && !x.i && !x.s)) || J({ live, mock });
  });
  await check('configuration kept: Daftra connection, AI settings, document requirements, subscription', async () => {
    const dc = await one(`SELECT mode, status, subdomain FROM public.daftra_connections WHERE org_id = $1`, [A]);
    const ai = await one(`SELECT enabled, consent_ack_at IS NOT NULL ack FROM app.ai_settings WHERE org_id = $1`, [A]);
    const rq = await num(`SELECT count(*) n FROM public.document_requirements WHERE org_id = $1`, [A]);
    const sub = await one(`SELECT plan_code, status FROM public.org_subscriptions WHERE org_id = $1`, [A]);
    return (J(dc) === J(PRE.daftra) && J(ai) === J(PRE.ai) && rq === PRE.requirements && rq > 0 && J(sub) === J(PRE.sub)) || J({ dc, ai, rq, sub });
  });
  await check('append-only logs kept: every audit row still there (+ one DELETE row per deleted audited row), ai_usage, subscription events, report exports', async () => {
    const old = await num(`SELECT count(*) n FROM public.audit_log WHERE id <= $1`, [PRE.auditMax]);
    const dels = await num(`SELECT count(*) n FROM public.audit_log WHERE id > $1 AND action = 'DELETE' AND org_id = $2`, [PRE.auditMax, A]);
    const ai = await num(`SELECT count(*) n FROM app.ai_usage WHERE org_id = $1`, [A]);
    const se = await num(`SELECT count(*) n FROM public.subscription_events WHERE org_id = $1`, [A]);
    const re = await num(`SELECT count(*) n FROM public.report_exports WHERE org_id = $1`, [A]);
    return (old === PRE.audit && dels >= PRE.counts.transactions + PRE.counts.clients && ai === PRE.aiUsage && ai >= 1 && se === PRE.subEvents
      && re === PRE.reports && re >= 1) || J({ old, pre: PRE.audit, dels, ai, se, re });
  });
  await check('org: new slug / names, environment production, settings without staging / demo / note', async () => {
    const o = await one(`SELECT slug, name_ar, name_en, environment, settings FROM public.organizations WHERE id = $1`, [A]);
    return (o.slug === NEW_SLUG && o.name_ar === NAME_AR && o.name_en === NAME_EN && o.environment === 'production'
      && !('staging' in o.settings) && !('demo' in o.settings) && !('note' in o.settings)) || J(o);
  });
  await check('deployment environment production (set_deploy_environment passed); health_check reports production', async () => {
    const h = (await one(`SELECT public.health_check() h`)).h;
    const h2 = await rpc('anon', `SELECT public.health_check() r`);
    return ((await env()) === 'production' && R.deploy.changed === true && R.deploy.environment === 'production' && h.environment === 'production'
      && h2.environment === 'production' && R.health_check.environment === 'production') || J({ h, deploy: R.deploy });
  });
  await check('usage counters recounted from the empty tables (transactions / messages / AI runs / storage = 0)', async () => {
    const u = await rpc(OWNER, `SELECT public.org_subscription($1) r`, [A]).catch(() => null);
    const n = await num(`SELECT coalesce(sum(value), 0) n FROM public.org_usage_counters WHERE org_id = $1`, [A]);
    return (n === 0 && (await num(`SELECT count(*) n FROM public.org_counters WHERE org_id = $1`, [A])) === 0) || J({ n, u });
  });
  await check('storage objects reported, not deleted (3 under the org folder; another folder not counted)', async () =>
    (J([R.storage_objects_left.documents, R.storage_objects_left.finance, R.storage_objects_left.messages]) === J([1, 1, 1])
      && R.storage_objects_left.folder === A + '/' && (await num(`SELECT count(*) n FROM storage.objects`)) === 4) || J(R.storage_objects_left));
  await check('no DDL left behind: catalog fingerprint (functions, policies, triggers incl. enabled state, columns) identical', async () => {
    const c = await L.catalogFingerprint(H);
    return J(c) === J(PRE.catalog) || J({ before: PRE.catalog, after: c });
  });
  await check('app.org_conversions: one row (blue-sea → new slug, postgres, the summary)', async () => {
    const r = await q(`SELECT from_slug, to_slug, converted_by, summary ->> 'deleted_total' t FROM app.org_conversions`);
    return (r.length === 1 && r[0].from_slug === 'blue-sea' && r[0].to_slug === NEW_SLUG && r[0].converted_by.length > 0 && Number(r[0].t) === R.deleted_total) || J(r);
  });
}

/* ================================================================== 8. after: production behaviour */
async function secAfter() {
  section('8. after the conversion: refusals, guards, references restart, post-install checks');
  if (!R) return;
  await expectErr('a second call → MRS_BAD_TRANSITION already_production', () => convert(A, NEW_SLUG, NAME_AR, NAME_EN, CONFIRM), /MRS_BAD_TRANSITION.*already_production/);
  await expectErr('a second call with another slug → MRS_BAD_TRANSITION already_production', () => convert(A, 'marsa2', NAME_AR, NAME_EN, 'DELETE-TEST-DATA-marsa2'), /MRS_BAD_TRANSITION.*already_production/);
  await check('preview now reports already_production', async () => (await preview(A)).blockers.includes('already_production'));
  await expectErr('production → staging refused (one-way)', () => one(`SELECT public.set_deploy_environment('staging')`), /MRS_BAD_TRANSITION.*production_is_one_way/);
  await expectErr('the org cannot be renamed back to the seed slug (demo org in production)', () =>
    q(`UPDATE public.organizations SET slug = 'blue-sea' WHERE id = $1`, [A]), /MRS_FORBIDDEN.*demo_org_in_production/);
  await expectErr('the org cannot be flagged demo again', () =>
    q(`UPDATE public.organizations SET settings = settings || '{"demo": true}' WHERE id = $1`, [A]), /MRS_FORBIDDEN.*demo_org_in_production/);
  await expectErr('seed.sql is refused now (demo org in production)', () => db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8')), /demo_org_in_production|duplicate key|MRS_/);
  await expectErr('app.org_conversions is append-only (UPDATE)', () => q(`UPDATE app.org_conversions SET to_slug = 'x'`), /MRS_APPEND_ONLY/);
  await expectErr('app.org_conversions is append-only (DELETE)', () => q(`DELETE FROM app.org_conversions`), /MRS_APPEND_ONLY/);
  await expectErr('guards active again: deleting a message channel → MRS_APPEND_ONLY', () => q(`DELETE FROM public.msg_channels WHERE id = $1`, [LIVE_CH]), /MRS_APPEND_ONLY/);
  await expectErr('guards active again: deleting an audit row → MRS_APPEND_ONLY', () => q(`DELETE FROM public.audit_log WHERE id = (SELECT min(id) FROM public.audit_log)`), /MRS_APPEND_ONLY/);

  const y = await riyadhYear();
  let req = null;
  await check(`references restart: the first public request of the new slug is REQ-${y}-000001 (and the old seed token no longer tracks)`, async () => {
    req = await rpc('anon', `SELECT public.submit_service_request($1) r`, [{ orgSlug: NEW_SLUG, fullName: 'عميل حقيقي', phone: '0551230001',
      email: 'real@client.example', company: 'شركة عميل', clientType: 'business', crNumber: '7001230001', direction: 'import', service: 'clearance',
      mode: 'sea', country: 'الصين', port: 'ميناء جدة الإسلامي', goods: 'بضاعة', containerType: '40ft', containerNumbers: L.isoContainer('MSCU', 900001),
      count: 1, blNumber: 'MEDU9000001', terms: true, antispam: { hp: '', elapsedMs: 4000 }, idempotencyKey: newKey() }]);
    const old = await rpc('anon', `SELECT public.public_track($1, $2) r`, [`REQ-${y}-000001`, SEED_TOKEN]);
    const mine = await rpc('anon', `SELECT public.public_track($1, $2) r`, [req.ref, req.tracking_token]);
    return (req.ref === `REQ-${y}-000001` && old.not_found === true && mine.environment === 'production' && mine.kind === 'request') || J({ req, old, mine });
  });
  await check(`references restart: the first transaction is MRS-${y}-000001 (owner converts the request)`, async () => {
    const id = (await one(`SELECT id FROM public.service_requests WHERE ref = $1`, [req.ref])).id;
    const r = await rpc(OWNER, `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [id, JED, newKey()]);
    const t = await one(`SELECT ref FROM public.transactions WHERE id = $1`, [r.transaction_id]);
    return t.ref === `MRS-${y}-000001` || t.ref;
  });
  await check(`references restart: the first contact message is MSG-${y}-000001`, async () => {
    const m = await rpc('anon', `SELECT public.submit_contact_message($1) r`, [{ orgSlug: NEW_SLUG, name: 'زائر حقيقي', phone: '0126100009',
      email: 'v2@example.com', subject: 'quote', message: 'طلب عرض سعر للتخليص الجمركي', consent: true, antispam: { hp: '', elapsedMs: 4000 } }]);
    return m.ref === `MSG-${y}-000001` || J(m);
  });
  await check('the owner still signs in to the org (my_context: admin of the production org); a removed test user has no org', async () => {
    const me = await rpc(OWNER, `SELECT public.my_context() r`);
    const ex = await rpc('A_ops', `SELECT public.my_context() r`);
    const s = J(me);
    return (s.includes(NEW_SLUG) && s.includes('production') && !J(ex).includes(A)) || J({ me, ex });
  });
  await check('the new transaction event is append-only (guard re-enabled)', async () =>
    /MRS_APPEND_ONLY/.test(await tryErr(() => q(`DELETE FROM public.transaction_events WHERE org_id = $1`, [A]))));
  await check('platform_create_org now creates production orgs (new tenants are production too)', async () => {
    await q(`INSERT INTO public.platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [U.A_admin]);
    const r = await rpc(OWNER, `SELECT public.platform_create_org($1) r`, [{ slug: 'second-real', name_ar: 'مؤسسة ثانية', ref_prefix: 'SEC',
      branch: { code: 'ruh', name_ar: 'فرع الرياض' }, admin_email: 'admin@second.example.com', idempotencyKey: newKey() }]);
    const o = await one(`SELECT environment, settings FROM public.organizations WHERE id = $1`, [r.org_id]);
    return (o.environment === 'production' && !('staging' in o.settings)) || J(o);
  });
  await check('post_install_checks.sql: production, converted org listed, no demo / seed / staging blockers — only pg_cron (absent in PGlite)', async () => {
    const c = await runChecks();
    return (c.deploy_environment === 'production' && c.demo_org_present === false && c.seed_rows === 0
      && c.converted_orgs.length === 1 && c.converted_orgs[0].org_id === A && c.converted_orgs[0].to_slug === NEW_SLUG
      && J(c.blockers) === J(CRON_BLOCKERS) && J(c.orgs_by_environment) === J({ production: 2 })
      && c.auth_users_without_access === PRE.noacc && J(c.warnings) === J(['auth_users_without_access:' + PRE.noacc])) || J(c);
  });
  await check('[D2] after the owner deletes the listed test accounts (Authentication → Users): auth_users_without_access 0, warnings [], owner kept', async () => {
    await q(`DELETE FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = u.id)
               AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id AND m.is_active)`);
    const c = await runChecks();
    const me = await rpc(OWNER, `SELECT public.my_context() r`);
    return (c.auth_users_without_access === 0 && J(c.warnings) === '[]' && J(c.blockers) === J(CRON_BLOCKERS) && J(me).includes(NEW_SLUG)) || J({ c, me });
  });
}

/* ================================================================== 9. post_install_checks without the conversion record */
async function secChecksSeedId() {
  section('9. post_install_checks.sql: the seed ids still count when the org was NOT converted');
  const d = await freshDb({ seed: true });
  try {
    await withDb(d, async () => {
      await check('staging seed: demo_org_present + seed_rows_present, converted_orgs []', async () => {
        const c = await runChecks();
        return (c.demo_org_present === true && c.seed_rows >= 10 && J(c.converted_orgs) === '[]' && c.blockers.includes('seed_rows_present')) || J(c);
      });
      await check('a renamed seed org (slug changed by hand, no conversion record) is still the demo org and its rows seed rows', async () => {
        await q(`UPDATE public.organizations SET slug = 'renamed-by-hand' WHERE id = $1`, [A]);
        const c = await runChecks();
        return (c.demo_org_present === true && c.seed_rows >= 10) || J(c);
      });
    });
  } finally { await d.close(); }
}

/* ================================================================== 10. planned site files (deploy/convert) */
function secSite() {
  section('10. planned site files: deploy/convert/ (config.js.template, htaccess.production-inplace, robots.txt)');
  const dir = path.join(ROOT, 'deploy', 'convert');
  const rd = f => fs.readFileSync(path.join(dir, f), 'utf8');
  const cfg = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'config.js'), 'utf8');
  const url = (cfg.match(/supabaseUrl:\s*'([^']+)'/) || [])[1];
  const key = (cfg.match(/supabaseAnonKey:\s*'([^']+)'/) || [])[1];
  const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co$/) || [])[1];
  return Promise.resolve().then(async () => {
    await check('assets/js/config.js is still the staging one (not modified yet)', () => /environment: 'staging'/.test(cfg) && /orgSlug: 'blue-sea'/.test(cfg));
    await check('config.js.template: the SAME project URL + publishable key, orgSlug placeholder, environment production, no secret', () => {
      const t = rd('config.js.template');
      return (t.includes(`supabaseUrl: '${url}'`) && t.includes(`supabaseAnonKey: '${key}'`) && /orgSlug: '<NEW_SLUG>'/.test(t)
        && /environment: 'production'/.test(t) && !/sb_secret_|service_role|blue-sea/.test(t.replace(/\/\*[\s\S]*?\*\//g, ''))) || t.slice(-400);
    });
    await check('config.js.template with the slug filled in is valid JS and yields exactly the 4 keys', () => {
      const vm = require('vm');
      const sb = { window: {} };
      vm.runInNewContext(rd('config.js.template').replace("orgSlug: '<NEW_SLUG>'", "orgSlug: '" + NEW_SLUG + "'"), sb);
      const c = sb.window.MARSA_CONFIG;
      return (J(Object.keys(c)) === J(['supabaseUrl', 'supabaseAnonKey', 'orgSlug', 'environment']) && c.orgSlug === NEW_SLUG && c.environment === 'production') || J(c);
    });
    await check('robots.txt: User-agent: * / Allow: / (the build-release.sh production file)', () => rd('robots.txt') === 'User-agent: *\nAllow: /\n' || J(rd('robots.txt')));
    await check('htaccess.production-inplace: no Basic Auth, no site-wide noindex, signed-in pages noindex, www → apex then HTTPS, this project in the CSP', () => {
      const h = rd('htaccess.production-inplace');
      const code = h.replace(/^\s*#.*$/gm, '');
      const www = code.indexOf('RewriteCond %{HTTP_HOST} ^www\\.(.+)$ [NC]'), https = code.indexOf('RewriteCond %{HTTPS} off');
      const robots = code.match(/Header (?:always )?set X-Robots-Tag[^\n]*/g) || [];
      return (!/AuthType|AuthUserFile|Require valid-user/.test(code) && www > 0 && https > www && robots.length === 1
        && /<FilesMatch "\^\(admin\|platform\|portal\|login\|bulk-upload\|ocr\|help\|offline\)\\\.html\$">\s*Header set X-Robots-Tag "noindex, nofollow"/.test(code)
        && code.includes(`connect-src 'self' ${url} wss://${ref}.supabase.co`) && !/__[A-Z_]+__/.test(code)
        && /Strict-Transport-Security/.test(code) && /Options -Indexes/.test(code) && /_headers/.test(code)) || 'htaccess';
    });
    await check('htaccess.production-inplace: the inline-script hashes are those of the current pages (as build-release.sh computes them)', () => {
      const seen = [];
      for (const f of fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort()) {
        const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
        for (const m of s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
          const h = "'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'";
          if (!seen.includes(h)) seen.push(h);
        }
      }
      const h = rd('htaccess.production-inplace');
      return (seen.length >= 2 && h.includes("script-src 'self' " + seen.join(' ') + ' https://cdn.jsdelivr.net')) || J(seen);
    });
    await check('htaccess.production-inplace = deploy/htaccess.production with this project filled in (same headers / rules)', () => {
      const tpl = fs.readFileSync(path.join(ROOT, 'deploy', 'htaccess.production'), 'utf8');
      const h = rd('htaccess.production-inplace');
      const strip = s => s.split('\n').filter(l => !/^\s*#/.test(l) && l.trim()).map(l => l.replace(/'sha256-[A-Za-z0-9+/=]+' ?/g, ''));
      const t = strip(tpl.replace(/__INLINE_SCRIPT_HASHES__ ?/, '').replace(/__SUPABASE_ORIGIN__/g, url).replace(/__SUPABASE_WSS__/g, 'wss://' + ref + '.supabase.co'));
      const got = strip(h);
      return J(t) === J(got) || J({ missing: t.filter(l => !got.includes(l)).slice(0, 3), extra: got.filter(l => !t.includes(l)).slice(0, 3) });
    });
  });
}

/* ================================================================== runner */
async function main() {
  try { await secFile(); } catch (e) { fail('section file', errText(e)); }
  try { await secPreflight(); } catch (e) { fail('section preflight', errText(e)); }
  db = new PGlite();
  section('load shim + migrations + seed (MAIN)');
  try {
    await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
    for (const f of migFiles()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    // legacy step 7 (20261123000100): the owner decisions default to HF5 (no edit of an existing Daftra draft) and resolve-only
    // products; the population pushes G5 drafts through the real worker, so the connections start with the G5 write policy
    await db.exec(`ALTER TABLE public.daftra_connections ALTER COLUMN allow_draft_update SET DEFAULT true, ALTER COLUMN allow_product_create SET DEFAULT true`);
    await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
    pass('MAIN loaded (' + migFiles().length + ' migrations + seed)');
  } catch (e) { fail('MAIN load', errText(e)); return finish(); }
  let ok = true;
  try { await populate(); } catch (e) { ok = false; fail('populate', errText(e)); }
  if (ok) {
    for (const s of [secPrivileges, secRefusals, secSide, secConvert, secAfter]) {
      try { await s(); } catch (e) { fail('section ' + s.name + ' aborted', errText(e) + '\n' + (e.stack || '').split('\n').slice(0, 3).join(' | ')); }
    }
  }
  try { await secChecksSeedId(); } catch (e) { fail('section checks', errText(e)); }
  try { await secSite(); } catch (e) { fail('section site', errText(e)); }
  finish();
}
function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
