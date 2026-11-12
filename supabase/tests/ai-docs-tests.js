#!/usr/bin/env node
/*
  Marsa (مرسى) — AI document reading with Claude: migration 20261114000100_ai_documents.sql, the Edge Function helper
  supabase/functions/ai-extract/extract.js (+ static checks of index.ts) and the front-end wiring (ocr.html / ocr.js,
  supa.js, admin.js, i18n). LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase.
  No network: the Anthropic SDK is never loaded; Claude is a mocked client object; fetch throws.

  One database: shim → every migration → seed.sql → fixtures. A user is simulated the way PostgREST does it (role
  authenticated + request.jwt.claims with an explicit aal); the Edge Function's service client as role service_role.

  Covers: file conventions + all_migrations.sql; preflight + re-run (tuned prices / settings kept) + catalog delta;
  grants (no API role on the app tables / helpers; staff + admin RPCs authenticated only; reserve / settle service_role
  only; anon nothing); settings (off by default, staff-only ai_access, admin + aal2, consent required off → on and again
  after a disable, validation, audit row, cross-org isolation); reserve / settle (service only, staff re-check by uid,
  disabled, daily cap, monthly budget with held estimates, fallback / unknown model pricing, one settle, stale sweep,
  append-only ledger); document_extractions (AI insert needs the caller's own 'ok' reading of the same org, one
  extraction per reading, ai_usage_id immutable, new field keys, Tesseract rows unchanged); the helper (request shape:
  model / effort / structured output / refusal fallbacks, schema rules, request validation, ISO 6346, stop_reason
  handling, response parsing, post-processing warnings, mocked Claude pipeline); static (no key / fetch / Deno outside
  index.ts, SDK pinned, fixed errors, CORS); the front end (static + vm). Review fixes: fallback switch point, per-attempt
  pricing (p_attempts), unknown outcomes charge the hold, 5 MB images, PDF page holds, maxRetries 0 / 100 s, the body read
  with a byte limit, handler.js run with mocked clients against the real reserve / settle, and the inbox Claude jobs in
  the same ledger (no user, shared consent / budget, refusals billed, in-flight holds counted).

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/ai-docs-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261114000100_ai_documents.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const FN_DIR = path.join(SUPA, 'functions', 'ai-extract');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

// No network anywhere
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in ai-docs-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'a1d00000-0000-4000-8000-0000000000b0';           // second org (fixture)
const BR_A = '0b5e0000-0000-4000-8000-000000000011';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const U = {
  admin: 'a1d00000-0000-4000-8000-000000000001',    // admin of A (MFA-gated)
  staff: 'a1d00000-0000-4000-8000-000000000002',    // accountant of A
  staff2: 'a1d00000-0000-4000-8000-000000000003',   // clearance_staff of A (JED)
  portal: 'a1d00000-0000-4000-8000-000000000004',   // client user of A
  stranger: 'a1d00000-0000-4000-8000-000000000005', // no membership
  adminB: 'a1d00000-0000-4000-8000-000000000006',   // admin of B
  gone: 'a1d00000-0000-4000-8000-000000000007'      // deactivated staff of A
};

/* ------------------------------------------------------------------ helpers */
let db;
// who: 'anon' | 'service' | a U key; aal: 'aal1' | 'aal2' (default aal2)
async function asRole(who, fn, aal) {
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
// 'MRS_CODE detail' of an app.fail refusal, 'ok', or the raw error
async function code(fn) { try { await fn(); return 'ok'; } catch (e) { return /^MRS_/.test(e.message || '') ? (e.message + (e.detail ? ' ' + e.detail : '')) : errText(e); } }
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
async function freshDb(upTo) {
  const d = new PGlite();
  await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles().filter(f => !upTo || f < upTo)) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  return d;
}
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind = 'r' ORDER BY 1`)).map(x => x.t);
  const cols = (await q(`SELECT table_name || '.' || column_name c FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'document_extractions' ORDER BY 1`)).map(x => x.c);
  return { fns, tables, cols };
}

const NEW_FNS = ['app.ai_cost_usd(p_model text, p_in integer, p_out integer)', 'app.ai_day_start()', 'app.ai_model()',
  'app.ai_month_start()', 'app.ai_settings_json(p_org uuid)', 'app.ai_settings_of(p_org uuid)',
  'app.ai_usage_claimable(p_usage uuid, p_org uuid)', 'app.ai_usage_json(p_org uuid)', 'app.tg_ai_usage_guard()',
  'public.ai_access(p_org uuid)', 'public.ai_get_settings(p_org uuid)', 'public.ai_reserve(p_org uuid, p_user uuid, p_purpose text, p_est_usd numeric)',
  'public.ai_save_settings(p_org uuid, p_payload jsonb)',
  'public.ai_settle(p_reservation uuid, p_input_tokens integer, p_output_tokens integer, p_status text, p_model text, p_attempts jsonb)'];
const NEW_TABLES = ['app.ai_prices', 'app.ai_settings', 'app.ai_usage'];
const RECREATED = ['app.extraction_field_keys()', 'app.tg_document_extractions_before()'];

// fixtures: users, memberships, second org
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@ai.example.com', now()), ('${U.staff}', 'staff@ai.example.com', now()),
    ('${U.staff2}', 'staff2@ai.example.com', now()), ('${U.portal}', 'portal@ai.example.com', now()),
    ('${U.stranger}', 'stranger@ai.example.com', now()), ('${U.adminB}', 'adminb@ai.example.com', now()),
    ('${U.gone}', 'gone@ai.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.staff}', 'staff'), ('${U.staff2}', 'staff2'),
    ('${U.portal}', 'portal'), ('${U.stranger}', 'stranger'), ('${U.adminB}', 'adminB'), ('${U.gone}', 'gone') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'ai-org-b', 'مؤسسة اختبار ب', 'AI test org B', 'AIB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.staff}', '${A}', NULL, 'accountant'),
    ('${U.staff2}', '${A}', '${BR_A}', 'clearance_staff'), ('${U.adminB}', '${B}', NULL, 'admin'),
    ('${U.gone}', '${A}', NULL, 'accountant');
  UPDATE public.memberships SET is_active = false WHERE user_id = '${U.gone}';
  INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
`;

const accessOf = (who, org, aal) => as(who, `SELECT public.ai_access($1) r`, [org], aal).then(r => r[0].r);
const getSettings = (who, org, aal) => as(who, `SELECT public.ai_get_settings($1) r`, [org], aal).then(r => r[0].r);
const saveSettings = (who, org, p, aal) => as(who, `SELECT public.ai_save_settings($1, $2) r`, [org, p], aal).then(r => r[0].r);
const reserve = (org, user, purpose, est) => as('service', `SELECT public.ai_reserve($1, $2, $3, $4) r`, [org, user, purpose || 'doc_extract', est == null ? null : est]).then(r => r[0].r);
const settle = (id, i, o, st, model, attempts) => as('service', `SELECT public.ai_settle($1, $2, $3, $4, $5, $6) r`,
  [id, i, o, st, model == null ? null : model, attempts == null ? null : J(attempts)]).then(r => r[0].r);
const enableA = () => saveSettings('admin', A, { enabled: true, consent_ack: true, daily_request_cap: 50, monthly_budget_usd: 20 });
const resetUsage = async () => {
  await db.exec(`ALTER TABLE app.ai_usage DISABLE TRIGGER trg_append_only;
                 DELETE FROM public.document_extractions WHERE ai_usage_id IS NOT NULL;
                 DELETE FROM app.ai_usage;
                 ALTER TABLE app.ai_usage ENABLE TRIGGER trg_append_only;`);
};
let shaSeq = 0;
const sha = () => (++shaSeq).toString(16).padStart(64, 'a');
const extRow = o => Object.assign({ org_id: A, doc_type: 'bill_of_lading', source_name: 'bl.pdf', source_sha256: sha(),
  engine: 'claude-opus-5-5', languages: 'auto', raw_text: '[claude-opus-5-5] bill_of_lading', extracted_fields: { bl_number: 'MEDU1234567' },
  line_items: [], created_by: '00000000-0000-0000-0000-000000000000' }, o || {});
async function insertExt(who, row) {
  return as(who, `INSERT INTO public.document_extractions (org_id, doc_type, source_name, source_sha256, engine, languages, raw_text,
                    extracted_fields, line_items, created_by, ai_usage_id)
                  SELECT r.org_id, r.doc_type, r.source_name, r.source_sha256, r.engine, r.languages, r.raw_text, r.extracted_fields,
                         r.line_items, $2::uuid, r.ai_usage_id
                    FROM jsonb_to_record($1::jsonb) AS r(org_id uuid, doc_type text, source_name text, source_sha256 text, engine text,
                         languages text, raw_text text, extracted_fields jsonb, line_items jsonb, ai_usage_id uuid)
                  RETURNING id, ai_usage_id, engine`, [J(row), U[who]]).then(r => r[0]);
}

/* ================================================================== sections */
async function secFile() {
  section('1. file: conventions, all_migrations.sql');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261113000100, schema_versions row, search_path = \'\' on every function', () => {
    const fnHeads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = fnHeads.filter(h => !/SET search_path = ''/.test(h) && !/extraction_field_keys/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261113000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261114000100', 'ai_documents'\)/.test(src)
      && fnHeads.length === 16 && bad.length === 0) || J({ n: fnHeads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('every SECURITY DEFINER function sets search_path = \'\'; every refusal goes through app.fail(\'MRS_*\')', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const definer = heads.filter(h => /SECURITY DEFINER/.test(h));
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|AI preflight/.test(r));
    const fails2 = src.match(/app\.fail\('([A-Z_]+)'/g) || [];
    return (definer.length === 10 && definer.every(h => /SET search_path = ''/.test(h)) && raises.length === 0
      && fails2.every(f => /app\.fail\('MRS_[A-Z_]+'/.test(f))) || J({ definer: definer.length, raises });
  });
  await check('no key, no Anthropic endpoint, no document content in the SQL file', () =>
    (!/sk-ant|ANTHROPIC_API_KEY\s*=|api\.anthropic\.com|x-api-key/i.test(src)) || 'secret-like text found');
  // later phases may follow this file (20261115000100 convert_in_place, 20261116000100 doc_match); none may sort before it unnoticed
  const LATER_PHASES = ['20261115000100_convert_in_place.sql', '20261116000100_doc_match.sql', '20261117000100_legacy_core.sql',
    '20261118000100_legacy_tx.sql', '20261119000100_legacy_docs.sql', '20261120000100_legacy_decl.sql', '20261121000100_legacy_appt.sql',
    '20261122000100_legacy_pay.sql', '20261123000100_legacy_daftra.sql', '20261124000100_legacy_reports.sql', '20261125000100_legacy_import.sql', '20261126000100_doc_match_packing.sql'];
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
      && all.slice(0, 5000).includes(MIG)) || 'not appended verbatim / no header line';
  });
}

async function secPreflight() {
  section('2. preflight, re-run, catalog delta (separate database, no seed)');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const d = await freshDb(MIG);
  try {
    await withDb(d, async () => {
      const C0 = await catalog();
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261113000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without public_antispam: exact preflight message, nothing created', async () =>
        (msg.startsWith('AI preflight: apply public_antispam first (schema_versions lacks 20261113000100 public_antispam)')
          && (await one(`SELECT to_regclass('app.ai_usage') IS NULL x`)).x) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261113000100', 'public_antispam')`);
      await db.exec(src);
      const C1 = await catalog();
      const s0 = new Map(C0.fns.map(f => [f.sig, f])), s1 = new Map(C1.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the 9 new app helpers + 5 new public RPCs, nothing dropped', () => {
        const added = C1.fns.map(f => f.sig).filter(s => !s0.has(s)).sort(), dropped = C0.fns.map(f => f.sig).filter(s => !s1.has(s));
        return (J(added) === J(NEW_FNS) && dropped.length === 0) || J({ added, dropped });
      });
      await check('catalog: exactly the 3 new app tables (no public table); document_extractions + ai_usage_id only', () => {
        const added = C1.tables.filter(t => !C0.tables.includes(t));
        const cols = C1.cols.filter(c => !C0.cols.includes(c));
        return (J(added) === J(NEW_TABLES) && J(cols) === J(['document_extractions.ai_usage_id'])) || J({ added, cols });
      });
      await check('catalog: exactly the 2 re-created bodies changed; ACL, definer and config identical', () => {
        const changed = C1.fns.filter(f => s0.has(f.sig) && s0.get(f.sig).h !== f.h).map(f => f.sig).sort();
        const same = RECREATED.every(sig => s0.get(sig).acl === s1.get(sig).acl && s0.get(sig).d === s1.get(sig).d && s0.get(sig).c === s1.get(sig).c);
        return (J(changed) === J(RECREATED) && same) || J({ changed, same });
      });
      await check('field keys: a superset of the 16 earlier keys + the 6 AI keys', async () => {
        const k = (await one(`SELECT app.extraction_field_keys() k`)).k;
        return (k.length === 22 && ['invoice_number', 'iban', 'vessel', 'voyage', 'port_of_loading', 'port_of_discharge', 'shipper', 'consignee'].every(x => k.includes(x))) || J(k);
      });
      await check('prices seeded: claude-opus-5-5 4 / 20, fallbacks claude-opus-5 and claude-opus-4-8 5 / 25', async () => {
        const r = await q(`SELECT model, input_usd_per_mtok::float i, output_usd_per_mtok::float o FROM app.ai_prices ORDER BY model`);
        return J(r) === J([{ model: 'claude-opus-4-8', i: 5, o: 25 }, { model: 'claude-opus-5', i: 5, o: 25 }, { model: 'claude-opus-5-5', i: 4, o: 20 }]) || J(r);
      });
      // tune, then re-run: nothing reset
      await db.exec(`UPDATE app.ai_prices SET input_usd_per_mtok = 4.5 WHERE model = 'claude-opus-5-5';
                     INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ('${A}', 'blue-sea', 'مؤسسة اختبار', 'MRS');
                     INSERT INTO app.ai_settings (org_id, daily_request_cap) VALUES ('${A}', 7);`);
      await db.exec(src);
      const after = await one(`SELECT (SELECT input_usd_per_mtok::float FROM app.ai_prices WHERE model = 'claude-opus-5-5') p,
                                      (SELECT daily_request_cap FROM app.ai_settings WHERE org_id = '${A}') c,
                                      (SELECT count(*)::int FROM public.schema_versions WHERE version = '20261114000100') v`);
      await check('re-run: tuned price and settings kept; one schema_versions row', () => (after.p === 4.5 && after.c === 7 && after.v === 1) || J(after));
      await check('re-run: catalog identical to the first run', async () => J(await catalog()) === J(C1) || 'catalog changed');
      // an earlier copy of this file was applied (5-argument settle, user_id NOT NULL, no unknown_outcome / user check)
      await db.exec(`DROP FUNCTION public.ai_settle(uuid, int, int, text, text, jsonb);
                     CREATE FUNCTION public.ai_settle(p_reservation uuid, p_input_tokens int, p_output_tokens int, p_status text, p_model text DEFAULT NULL)
                       RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{}'::jsonb $f$;
                     ALTER TABLE app.ai_usage DROP CONSTRAINT ai_usage_user_chk;
                     ALTER TABLE app.ai_usage DROP COLUMN unknown_outcome;
                     ALTER TABLE app.ai_usage ALTER COLUMN user_id SET NOT NULL;`);
      await db.exec(src);
      await check('review fix: re-running over an EARLIER copy of this file converges (6-argument settle only, user_id nullable for inbox, unknown_outcome, user check)', async () => {
        const c = await one(`SELECT to_regprocedure('public.ai_settle(uuid,int,int,text,text)') IS NULL old_gone,
                                    to_regprocedure('public.ai_settle(uuid,int,int,text,text,jsonb)') IS NOT NULL new_there,
                                    (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'ai_usage' AND column_name = 'user_id') n,
                                    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'ai_usage' AND column_name = 'unknown_outcome') u,
                                    EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_user_chk') k`);
        return (c.old_gone && c.new_there && c.n === 'YES' && c.u && c.k && J(await catalog()) === J(C1)) || J(c);
      });
    });
  } finally { await d.close(); }
}

async function secGrants() {
  section('3. grants: app objects not reachable, RPCs per role');
  for (const t of NEW_TABLES) for (const who of ['anon', 'staff', 'service']) {
    await check(`${who} cannot SELECT / UPDATE / DELETE ${t}`, async () => {
      const r = [];
      for (const sql of [`SELECT 1 FROM ${t} LIMIT 1`, `DELETE FROM ${t}`, `UPDATE ${t} SET ${t === 'app.ai_prices' ? 'input_usd_per_mtok = 0' : t === 'app.ai_settings' ? 'enabled = true' : 'cost_usd = 0'}`])
        r.push(await tryErr(() => as(who, sql)));
      return r.every(x => /permission denied/.test(x)) || J(r);
    });
  }
  await check('no API role has a privilege on the 3 tables; RLS on', async () => {
    const r = await q(`SELECT c.relname, c.relrowsecurity rls,
                              has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') a,
                              has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') u,
                              has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') s
                         FROM pg_class c WHERE c.oid = ANY (ARRAY['app.ai_prices'::regclass, 'app.ai_settings'::regclass, 'app.ai_usage'::regclass])`);
    return (r.length === 3 && r.every(x => x.rls && !x.a && !x.u && !x.s)) || J(r);
  });
  await check('app.ai_* helpers: no API role, except ai_model / ai_usage_claimable (+ ai_usage_source_ok of 20261119000100) for authenticated (the extraction trigger)', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') s
                         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND (p.proname LIKE 'ai\\_%' OR p.proname = 'tg_ai_usage_guard')`);
    const bad = r.filter(x => x.a || x.s || (x.u && !['ai_model', 'ai_usage_claimable', 'ai_usage_source_ok'].includes(x.proname)));
    return (r.length === 10 && bad.length === 0) || J(r);
  });
  await check('ai_access / ai_get_settings / ai_save_settings: authenticated only (not anon, not service_role), SECURITY DEFINER', async () => {
    const r = await q(`SELECT p.proname, p.prosecdef d, has_function_privilege('anon', p.oid, 'EXECUTE') a,
                              has_function_privilege('authenticated', p.oid, 'EXECUTE') u, has_function_privilege('service_role', p.oid, 'EXECUTE') s
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('ai_access','ai_get_settings','ai_save_settings')`);
    return (r.length === 3 && r.every(x => x.d && !x.a && x.u && !x.s)) || J(r);
  });
  await check('ai_reserve / ai_settle: service_role only, SECURITY DEFINER', async () => {
    const r = await q(`SELECT p.proname, p.prosecdef d, has_function_privilege('anon', p.oid, 'EXECUTE') a,
                              has_function_privilege('authenticated', p.oid, 'EXECUTE') u, has_function_privilege('service_role', p.oid, 'EXECUTE') s
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('ai_reserve','ai_settle')`);
    return (r.length === 2 && r.every(x => x.d && !x.a && !x.u && x.s)) || J(r);
  });
  await check('anon can execute no ai_* function; the 6 public RPCs unchanged', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname IN ('public','app') AND has_function_privilege('anon', p.oid, 'EXECUTE') ORDER BY 1`);
    const names = r.map(x => x.proname);
    return (!names.some(n => /^ai_/.test(n)) && ['health_check', 'invitation_preview', 'log_client_error', 'public_track',
      'submit_contact_message', 'submit_service_request'].every(n => names.includes(n))) || J(names);
  });
  await check('anon: calling ai_access is refused (permission denied)', async () =>
    /permission denied/.test(await tryErr(() => as('anon', `SELECT public.ai_access($1)`, [A]))));
  await check('a signed-in user cannot call ai_reserve / ai_settle (permission denied)', async () => {
    const a = await tryErr(() => as('admin', `SELECT public.ai_reserve($1, $2, 'doc_extract', NULL)`, [A, U.admin]));
    const b = await tryErr(() => as('admin', `SELECT public.ai_settle(gen_random_uuid(), 1, 1, 'ok', NULL)`));
    return (/permission denied/.test(a) && /permission denied/.test(b)) || J({ a, b });
  });
  await check('service_role role without the service claim is refused inside (MRS_FORBIDDEN service_only)', async () => {
    await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', false);`);
    try { return (await code(() => q(`SELECT public.ai_reserve($1, $2, 'doc_extract', NULL)`, [A, U.staff]))) === 'MRS_FORBIDDEN service_only'; }
    finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
  });
}

async function secSettings() {
  section('4. settings: off by default, staff-only access, admin + aal2, consent');
  await check('default: off for every org (ai_access as staff: enabled false, can_use false, cap 50)', async () => {
    const r = await accessOf('staff', A);
    return (r.enabled === false && r.can_use === false && r.daily_request_cap === 50 && r.model === 'claude-opus-5-5' && r.daily_remaining === 50) || J(r);
  });
  await check('ai_access: a stranger, a client (portal) user and a deactivated member are refused (MRS_FORBIDDEN)', async () => {
    const r = [await code(() => accessOf('stranger', A)), await code(() => accessOf('portal', A)), await code(() => accessOf('gone', A))];
    return r.every(x => x === 'MRS_FORBIDDEN') || J(r);
  });
  await check('ai_access: a branch-scoped clearance_staff member gets it; another org\'s admin does not', async () => {
    const a = await accessOf('staff2', A);
    const b = await code(() => accessOf('adminB', A));
    return (a.enabled === false && b === 'MRS_FORBIDDEN') || J({ a, b });
  });
  await check('ai_access: an admin-only member at aal1 → MRS_MFA_REQUIRED (aal2 works)', async () => {
    const a = await code(() => accessOf('admin', A, 'aal1'));
    const b = await accessOf('admin', A, 'aal2');
    return (a === 'MRS_MFA_REQUIRED aal2' && b.enabled === false) || J({ a, b });
  });
  await check('ai_get_settings: staff (non-admin) refused; admin at aal1 → MRS_MFA_REQUIRED; admin aal2 → defaults (off, 50, 20 USD, no consent)', async () => {
    const a = await code(() => getSettings('staff', A));
    const b = await code(() => getSettings('admin', A, 'aal1'));
    const c = await getSettings('admin', A);
    return (a === 'MRS_FORBIDDEN' && b === 'MRS_MFA_REQUIRED aal2' && c.enabled === false && c.daily_request_cap === 50
      && Number(c.monthly_budget_usd) === 20 && c.consent_ack_at === null && c.exists === false && c.provider === 'anthropic'
      && c.usage && c.usage.today_requests === 0) || J({ a, b, c });
  });
  await check('ai_save_settings: staff refused; admin at aal1 refused (MFA); another org\'s admin refused', async () => {
    const r = [await code(() => saveSettings('staff', A, { daily_request_cap: 5 })), await code(() => saveSettings('admin', A, { daily_request_cap: 5 }, 'aal1')),
      await code(() => saveSettings('adminB', A, { daily_request_cap: 5 }))];
    return J(r) === J(['MRS_FORBIDDEN', 'MRS_MFA_REQUIRED aal2', 'MRS_FORBIDDEN']) || J(r);
  });
  await check('enable without consent → MRS_REQUIRED ai_consent; consent_ack false → refused too; nothing enabled', async () => {
    const a = await code(() => saveSettings('admin', A, { enabled: true }));
    const b = await code(() => saveSettings('admin', A, { enabled: true, consent_ack: false }));
    const s = await getSettings('admin', A);
    return (a === 'MRS_REQUIRED ai_consent' && b === 'MRS_REQUIRED ai_consent' && s.enabled === false) || J({ a, b, s });
  });
  await check('validation: cap 0 / 1001 / 2.5, budget -1 / 10001 / 0.001, unknown key, non-boolean enabled → MRS_INVALID', async () => {
    const bad = [{ daily_request_cap: 0 }, { daily_request_cap: 1001 }, { daily_request_cap: 2.5 }, { monthly_budget_usd: -1 },
      { monthly_budget_usd: 10001 }, { monthly_budget_usd: 0.001 }, { model: 'x' }, { enabled: 'yes' }, { consent_ack: 'yes' }];
    const r = [];
    for (const p of bad) r.push(await code(() => saveSettings('admin', A, p)));
    return r.every(x => /^MRS_INVALID/.test(x)) || J(r);
  });
  await check('enable with consent: enabled, consent_ack_at / _by stamped (version ai-doc-inbox-v2: documents + inbox message text), caps saved', async () => {
    const s = await saveSettings('admin', A, { enabled: true, consent_ack: true, daily_request_cap: 40, monthly_budget_usd: 12.5 });
    return (s.enabled === true && s.consent_ack_by === U.admin && s.consent_ack_at && s.consent_version === 'ai-doc-inbox-v2'
      && s.daily_request_cap === 40 && Number(s.monthly_budget_usd) === 12.5) || J(s);
  });
  await check('staff now sees enabled / can_use; org B stays off', async () => {
    const a = await accessOf('staff', A), b = await accessOf('adminB', B);
    return (a.can_use === true && a.daily_remaining === 40 && b.enabled === false) || J({ a, b });
  });
  await check('caps change without a new consent while on; ack kept', async () => {
    const before = (await getSettings('admin', A)).consent_ack_at;
    const s = await saveSettings('admin', A, { daily_request_cap: 30 });
    return (s.enabled && s.consent_ack_at === before && s.daily_request_cap === 30) || J(s);
  });
  await check('disable, then re-enable needs the consent again (a new ack)', async () => {
    const off = await saveSettings('admin', A, { enabled: false });
    const again = await code(() => saveSettings('admin', A, { enabled: true }));
    await db.exec(`UPDATE app.ai_settings SET consent_ack_at = consent_ack_at - interval '1 hour' WHERE org_id = '${A}'`);
    const old = (await getSettings('admin', A)).consent_ack_at;
    const on = await saveSettings('admin', A, { enabled: true, consent_ack: true });
    return (off.enabled === false && off.consent_ack_at && again === 'MRS_REQUIRED ai_consent' && on.enabled && on.consent_ack_at !== old) || J({ off, again, on });
  });
  await check('table CHECK: enabled without consent cannot be written even by the owner', async () =>
    /ai_settings_consent_chk/.test(await tryErr(() => db.exec(`INSERT INTO app.ai_settings (org_id, enabled) VALUES ('${B}', true)`))));
  await check('audit_log: settings changes are recorded (table ai_settings, actor admin, no content)', async () => {
    const r = await q(`SELECT changed_fields, actor, new_data FROM public.audit_log WHERE table_name = 'ai_settings' AND org_id = $1 ORDER BY id`, [A]);
    const first = r[0];
    return (r.length >= 4 && first.actor === U.admin && first.changed_fields.includes('enabled') && first.changed_fields.includes('consent_ack_at')
      && !J(r).includes('data_b64')) || J(r.map(x => x.changed_fields));
  });
  await check('a no-op save writes no audit row', async () => {
    const n0 = (await one(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'ai_settings'`)).n;
    await saveSettings('admin', A, {});
    const n1 = (await one(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'ai_settings'`)).n;
    return n0 === n1 || J({ n0, n1 });
  });
}

async function secReserve() {
  section('5. reserve / settle: caps, budget, prices, one settle, stale sweep, append-only');
  await enableA();
  await resetUsage();
  await check('reserve: returns a uuid; a reserved row (model claude-opus-5-5, held 0.50 by default)', async () => {
    const id = await reserve(A, U.staff, 'doc_extract');
    const r = await one(`SELECT status, model, reserved_usd::float h, user_id, purpose, settled_at FROM app.ai_usage WHERE id = $1`, [id]);
    return (/^[0-9a-f-]{36}$/.test(id) && r.status === 'reserved' && r.model === 'claude-opus-5-5' && r.h === 0.5 && r.user_id === U.staff
      && r.purpose === 'doc_extract' && r.settled_at === null) || J(r);
  });
  await check('reserve refusals: not staff (stranger, portal, deactivated, org B admin) → MRS_FORBIDDEN not_staff; bad purpose / est → MRS_INVALID', async () => {
    const r = [await code(() => reserve(A, U.stranger)), await code(() => reserve(A, U.portal)), await code(() => reserve(A, U.gone)),
      await code(() => reserve(A, U.adminB)), await code(() => reserve(A, U.staff, 'chat')), await code(() => reserve(A, U.staff, 'doc_extract', 0)),
      await code(() => reserve(A, U.staff, 'doc_extract', 51))];
    return J(r) === J(['MRS_FORBIDDEN not_staff', 'MRS_FORBIDDEN not_staff', 'MRS_FORBIDDEN not_staff', 'MRS_FORBIDDEN not_staff',
      'MRS_INVALID purpose', 'MRS_INVALID est_usd', 'MRS_INVALID est_usd']) || J(r);
  });
  await check('reserve on a disabled org (B, never enabled) → MRS_AI_DISABLED; after disabling A too', async () => {
    const b = await code(() => reserve(B, U.adminB));
    await saveSettings('admin', A, { enabled: false });
    const a = await code(() => reserve(A, U.staff));
    await enableA();
    return (b === 'MRS_AI_DISABLED ai' && a === 'MRS_AI_DISABLED ai') || J({ a, b });
  });
  await check('settle ok: cost = in × $4 + out × $20 per MTok; settled_at stamped; returns cost', async () => {
    const id = await reserve(A, U.staff, 'doc_extract', 0.4);
    const s = await settle(id, 12000, 3000, 'ok');
    const r = await one(`SELECT status, input_tokens i, output_tokens o, cost_usd::float c, settled_at IS NOT NULL st FROM app.ai_usage WHERE id = $1`, [id]);
    const want = (12000 * 4 + 3000 * 20) / 1e6;
    return (Number(s.cost_usd) === want && r.status === 'ok' && r.i === 12000 && r.o === 3000 && r.c === want && r.st) || J({ s, r, want });
  });
  await check('settle a second time → MRS_BAD_TRANSITION settled; unknown id → MRS_NOT_FOUND', async () => {
    const id = await reserve(A, U.staff);
    await settle(id, 1, 1, 'ok');
    const a = await code(() => settle(id, 1, 1, 'error'));
    const b = await code(() => settle('00000000-0000-4000-8000-00000000dead', 1, 1, 'ok'));
    return (a === 'MRS_BAD_TRANSITION settled' && b === 'MRS_NOT_FOUND reservation') || J({ a, b });
  });
  await check('settle validation: status reserved / bogus, negative or NULL tokens, a bad model name → MRS_INVALID', async () => {
    const id = await reserve(A, U.staff);
    const r = [await code(() => settle(id, 1, 1, 'reserved')), await code(() => settle(id, 1, 1, 'done')), await code(() => settle(id, -1, 1, 'ok')),
      await code(() => as('service', `SELECT public.ai_settle($1, NULL, 1, 'ok', NULL)`, [id])), await code(() => settle(id, 1, 1, 'ok', 'Bad Model!'))];
    await settle(id, 0, 0, 'error');
    return r.every(x => /^MRS_INVALID/.test(x)) || J(r);
  });
  await check('fallback model priced from the table (claude-opus-4-8 $5 / $25); an unknown model at the highest row', async () => {
    const a = await reserve(A, U.staff), b = await reserve(A, U.staff);
    const sa = await settle(a, 1000000, 100000, 'ok', 'claude-opus-4-8');
    const sb = await settle(b, 1000000, 100000, 'ok', 'claude-future-9');
    const m = await one(`SELECT model FROM app.ai_usage WHERE id = $1`, [a]);
    return (Number(sa.cost_usd) === 7.5 && Number(sb.cost_usd) === 7.5 && m.model === 'claude-opus-4-8') || J({ sa, sb, m });
  });
  await check('refused / error settle with the reported tokens (refusal billed as reported)', async () => {
    const a = await reserve(A, U.staff), b = await reserve(A, U.staff);
    const sa = await settle(a, 5000, 0, 'refused');
    const sb = await settle(b, 0, 0, 'error');
    return (sa.status === 'refused' && Number(sa.cost_usd) === 0.02 && sb.status === 'error' && Number(sb.cost_usd) === 0) || J({ sa, sb });
  });
  await check('daily cap: the cap counts every request of the org today (any status); the next → MRS_AI_DAILY_CAP', async () => {
    await resetUsage();
    await saveSettings('admin', A, { daily_request_cap: 3, monthly_budget_usd: 100 });
    const ids = [await reserve(A, U.staff), await reserve(A, U.staff2), await reserve(A, U.admin)];
    await settle(ids[0], 1, 1, 'ok'); await settle(ids[1], 1, 1, 'refused');
    const r = await code(() => reserve(A, U.staff));
    const acc = await accessOf('staff', A);
    // yesterday's requests do not count
    await db.exec(`ALTER TABLE app.ai_usage DISABLE TRIGGER trg_append_only;
                   UPDATE app.ai_usage SET created_at = created_at - interval '2 days';
                   ALTER TABLE app.ai_usage ENABLE TRIGGER trg_append_only;`);
    const next = await code(() => reserve(A, U.staff));
    return (r === 'MRS_AI_DAILY_CAP ai' && acc.daily_remaining === 0 && next === 'ok') || J({ r, acc, next });
  });
  await check('monthly budget: settled cost + held estimates + the new estimate > budget → MRS_AI_BUDGET', async () => {
    await resetUsage();
    await saveSettings('admin', A, { daily_request_cap: 1000, monthly_budget_usd: 1 });
    const a = await reserve(A, U.staff, 'doc_extract', 0.4);
    await settle(a, 50000, 10000, 'ok');                                     // 0.20 + 0.20 = 0.40
    const b = await reserve(A, U.staff, 'doc_extract', 0.5);                // 0.40 + 0.50 = 0.90 ≤ 1 (held)
    const c = await code(() => reserve(A, U.staff, 'doc_extract', 0.2));    // 0.40 + 0.50 held + 0.20 > 1
    await settle(b, 10000, 1000, 'ok');                                      // held 0.50 → cost 0.06
    const d = await code(() => reserve(A, U.staff, 'doc_extract', 0.2));    // 0.46 + 0.20 ≤ 1
    await db.exec(`ALTER TABLE app.ai_usage DISABLE TRIGGER trg_append_only;
                   UPDATE app.ai_usage SET created_at = created_at - interval '40 days';
                   ALTER TABLE app.ai_usage ENABLE TRIGGER trg_append_only;`);
    const e = await code(() => reserve(A, U.staff, 'doc_extract', 0.9));    // last month does not count
    const z = await code(() => { return saveSettings('admin', A, { monthly_budget_usd: 0 }).then(() => reserve(A, U.staff, 'doc_extract', 0.01)); });
    return (c === 'MRS_AI_BUDGET ai' && d === 'ok' && e === 'ok' && z === 'MRS_AI_BUDGET ai') || J({ c, d, e, z });
  });
  await check('usage summary (ai_get_settings): month counts by status / purpose, tokens, cost, held, today (document readings)', async () => {
    await resetUsage();
    await saveSettings('admin', A, { daily_request_cap: 100, monthly_budget_usd: 20 });
    const a = await reserve(A, U.staff), b = await reserve(A, U.staff), c = await reserve(A, U.staff, 'inbox', 0.25);
    await settle(a, 1000, 500, 'ok'); await settle(b, 2000, 0, 'refused');
    const u = (await getSettings('admin', A)).usage;
    const m = u.month;
    return (u.today_requests === 2 && m.requests === 3 && m.ok === 1 && m.refused === 1 && m.reserved === 1 && Number(m.input_tokens) === 3000
      && Number(m.output_tokens) === 500 && Number(m.cost_usd) === 0.022 && Number(m.held_usd) === 0.25 && m.by_purpose.doc_extract === 2
      && m.by_purpose.inbox === 1 && !!c) || J(u);
  });
  await check('stale sweep: a reservation older than 15 min is settled error at its held estimate by the next reserve', async () => {
    await resetUsage();
    const a = await reserve(A, U.staff, 'doc_extract', 0.3);
    await db.exec(`ALTER TABLE app.ai_usage DISABLE TRIGGER trg_append_only;
                   UPDATE app.ai_usage SET created_at = now() - interval '16 minutes' WHERE id = '${a}';
                   ALTER TABLE app.ai_usage ENABLE TRIGGER trg_append_only;`);
    await reserve(A, U.staff);
    const r = await one(`SELECT status, stale, cost_usd::float c, settled_at IS NOT NULL st FROM app.ai_usage WHERE id = $1`, [a]);
    const late = await code(() => settle(a, 10, 10, 'ok'));
    return (r.status === 'error' && r.stale === true && r.c === 0.3 && r.st && late === 'MRS_BAD_TRANSITION settled') || J({ r, late });
  });
  await check('append-only ledger: even the owner cannot DELETE, re-settle, or change org / user / held amount', async () => {
    const id = await reserve(A, U.staff);
    const a = await code(() => db.exec(`DELETE FROM app.ai_usage WHERE id = '${id}'`));
    const b = await code(() => db.exec(`UPDATE app.ai_usage SET user_id = '${U.admin}', status = 'ok' WHERE id = '${id}'`));
    const c = await code(() => db.exec(`UPDATE app.ai_usage SET reserved_usd = 1, status = 'ok' WHERE id = '${id}'`));
    await settle(id, 1, 1, 'ok');
    const d = await code(() => db.exec(`UPDATE app.ai_usage SET cost_usd = 0 WHERE id = '${id}'`));
    const e = await code(() => db.exec(`UPDATE app.ai_usage SET status = 'reserved' WHERE id = '${id}'`));
    return (a === 'MRS_APPEND_ONLY ai_usage' && b === 'MRS_IMMUTABLE user_id' && c === 'MRS_IMMUTABLE reserved_usd'
      && d === 'MRS_APPEND_ONLY ai_usage' && e === 'MRS_APPEND_ONLY ai_usage') || J({ a, b, c, d, e });
  });
  await check('the ledger holds counts and money only (no text column beyond model / purpose / status; 20261119000100 adds source_sha256, a 64-hex file hash, no content)', async () => {
    const r = await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'ai_usage' AND data_type = 'text' ORDER BY 1`);
    const k = await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'ai_usage_source_sha256_chk'`);
    return (J(r.map(x => x.column_name)) === J(['model', 'purpose', 'source_sha256', 'status']) && /\^\[0-9a-f\]\{64\}\$/.test(k.d)) || J({ r, k });
  });
}

async function secReviewSql() {
  section('5b. review fixes (SQL): unknown outcome, per-attempt pricing, one ledger for documents + inbox');
  await resetUsage();
  await saveSettings('admin', A, { daily_request_cap: 100, monthly_budget_usd: 20 });
  const row = id => one(`SELECT status, unknown_outcome uo, cost_usd::float c, input_tokens i, output_tokens o, model, user_id, purpose FROM app.ai_usage WHERE id = $1`, [id]);
  await check('review A-3: settle unknown (timeout / connection lost / 5xx after sending) → stored error, unknown_outcome, the HELD amount charged', async () => {
    const id = await reserve(A, U.staff, 'doc_extract', 0.3);
    const s = await settle(id, 0, 0, 'unknown');
    const r = await row(id);
    return (s.status === 'error' && s.unknown_outcome === true && Number(s.cost_usd) === 0.3 && r.status === 'error' && r.uo === true && r.c === 0.3) || J({ s, r });
  });
  await check('review A-3: unknown with reported tokens above the hold keeps the larger cost; a known error (nothing sent) stays $0', async () => {
    const a = await reserve(A, U.staff, 'doc_extract', 0.01), b = await reserve(A, U.staff, 'doc_extract', 0.4);
    const sa = await settle(a, 1000000, 0, 'unknown');
    const sb = await settle(b, 0, 0, 'error');
    const rb = await row(b);
    return (Number(sa.cost_usd) === 4 && Number(sb.cost_usd) === 0 && rb.uo === false) || J({ sa, sb, rb });
  });
  await check('review A-2: p_attempts (usage.iterations) — each attempt priced at its own model; stored tokens are the sums; served model kept', async () => {
    const id = await reserve(A, U.staff, 'doc_extract', 1);
    const s = await settle(id, 0, 0, 'ok', 'claude-opus-4-8', [{ model: 'claude-opus-5-5', input_tokens: 1000000, output_tokens: 0 },
      { model: 'claude-opus-4-8', input_tokens: 1000000, output_tokens: 100000 }]);
    const r = await row(id);
    return (Number(s.cost_usd) === 4 + 5 + 2.5 && r.c === 11.5 && r.i === 2000000 && r.o === 100000 && r.model === 'claude-opus-4-8') || J({ s, r });
  });
  await check('review A-2: an attempt without a model is priced at the reserved model; refused chain billed per attempt too', async () => {
    const id = await reserve(A, U.staff, 'doc_extract', 1);
    const s = await settle(id, 0, 0, 'refused', null, [{ input_tokens: 1000000, output_tokens: 0 }, { model: 'claude-opus-5', input_tokens: 1000000, output_tokens: 0, extra: 1 }]);
    return (Number(s.cost_usd) === 9 && s.status === 'refused') || J(s);
  });
  await check('review A-2: invalid p_attempts → MRS_INVALID attempts (object, [], 11 entries, negative / fractional / text tokens, bad model)', async () => {
    await resetUsage();
    const bad = [{ model: 'x' }, [], Array.from({ length: 11 }, () => ({ input_tokens: 1, output_tokens: 1 })), [{ input_tokens: -1, output_tokens: 1 }],
      [{ input_tokens: 1.5, output_tokens: 1 }], [{ input_tokens: '1', output_tokens: 1 }], [{ model: 'Bad Model', input_tokens: 1, output_tokens: 1 }],
      [{ model: 5, input_tokens: 1, output_tokens: 1 }], ['x']];
    const r = [];
    for (const b of bad) { const id = await reserve(A, U.staff); r.push(await code(() => settle(id, 0, 0, 'ok', null, b))); await settle(id, 0, 0, 'error'); }
    return r.every(x => x === 'MRS_INVALID attempts') || J(r);
  });
  await check('review B-11 / B-15: inbox reservation without a user (p_user NULL); doc_extract still needs a staff user; a non-staff user is refused for inbox too', async () => {
    await resetUsage();
    const id = await as('service', `SELECT public.ai_reserve($1, NULL, 'inbox', 0.2) r`, [A]).then(x => x[0].r);
    const r = await row(id);
    const a = await code(() => as('service', `SELECT public.ai_reserve($1, NULL, 'doc_extract', 0.2) r`, [A]));
    const b = await code(() => reserve(A, U.stranger, 'inbox', 0.2));
    await settle(id, 10, 10, 'ok');
    return (r.user_id === null && r.purpose === 'inbox' && a === 'MRS_REQUIRED user' && b === 'MRS_FORBIDDEN not_staff') || J({ r, a, b });
  });
  await check('review: inbox jobs (triggered by outside senders) do not use up the daily document cap; the cap still stops document reading', async () => {
    await resetUsage();
    await saveSettings('admin', A, { daily_request_cap: 1 });
    const d1 = await code(() => reserve(A, U.staff));
    const ib = [];
    for (let i = 0; i < 3; i++) ib.push(await code(() => as('service', `SELECT public.ai_reserve($1, NULL, 'inbox', 0.1) r`, [A])));
    const d2 = await code(() => reserve(A, U.staff));
    const acc = await accessOf('staff', A);
    await saveSettings('admin', A, { daily_request_cap: 100 });
    return (d1 === 'ok' && ib.every(x => x === 'ok') && d2 === 'MRS_AI_DAILY_CAP ai' && acc.today_requests === 1 && acc.daily_remaining === 0) || J({ d1, ib, d2, acc });
  });
  await check('review B-14: one monthly budget, held amounts of in-flight inbox jobs count (row-locked): a second job / a document reading past it is refused', async () => {
    await resetUsage();
    await saveSettings('admin', A, { monthly_budget_usd: 1 });
    const j1 = await as('service', `SELECT public.ai_reserve($1, NULL, 'inbox', 0.6) r`, [A]).then(x => x[0].r);
    const j2 = await code(() => as('service', `SELECT public.ai_reserve($1, NULL, 'inbox', 0.6) r`, [A]));
    const d = await code(() => reserve(A, U.staff, 'doc_extract', 0.5));
    await settle(j1, 10000, 1000, 'ok');                                      // 0.04 + 0.02 = 0.06
    const j3 = await code(() => as('service', `SELECT public.ai_reserve($1, NULL, 'inbox', 0.6) r`, [A]));
    await saveSettings('admin', A, { monthly_budget_usd: 20 });
    return (j2 === 'MRS_AI_BUDGET ai' && d === 'MRS_AI_BUDGET ai' && j3 === 'ok') || J({ j2, d, j3 });
  });
  await check('review B-15: inbox use needs the consent that names message text (ai-doc-inbox-v2) and the org switch; document reading unaffected by the version', async () => {
    await db.exec(`UPDATE app.ai_settings SET consent_version = 'ai-doc-v1' WHERE org_id = '${A}'`);
    const a = await code(() => as('service', `SELECT public.ai_reserve($1, NULL, 'inbox', 0.1) r`, [A]));
    const b = await code(() => reserve(A, U.staff));
    await db.exec(`UPDATE app.ai_settings SET consent_version = 'ai-doc-inbox-v2' WHERE org_id = '${A}'`);
    await saveSettings('admin', A, { enabled: false });
    const c = await code(() => as('service', `SELECT public.ai_reserve($1, NULL, 'inbox', 0.1) r`, [A]));
    const e = await code(() => as('service', `SELECT public.ai_reserve($1, NULL, 'inbox', 0.1) r`, [B]));
    await enableA();
    return (a === 'MRS_AI_DISABLED consent' && b === 'ok' && c === 'MRS_AI_DISABLED ai' && e === 'MRS_AI_DISABLED ai') || J({ a, b, c, e });
  });
  await check('ledger CHECK: a doc_extract row without a user cannot be written even by the owner; an inbox row can never back an AI extraction', async () => {
    const a = await tryErr(() => db.exec(`INSERT INTO app.ai_usage (org_id, user_id, purpose, model, reserved_usd) VALUES ('${A}', NULL, 'doc_extract', 'claude-opus-5-5', 0.1)`));
    const ib = await as('service', `SELECT public.ai_reserve($1, NULL, 'inbox', 0.1) r`, [A]).then(x => x[0].r);
    await settle(ib, 1, 1, 'ok');
    const b = await code(() => insertExt('staff', extRow({ ai_usage_id: ib })));
    return (/ai_usage_user_chk/.test(a) && b === 'MRS_INVALID ai_usage_id') || J({ a, b });
  });
}

async function secExtractions() {
  section('6. document_extractions: AI readings');
  await resetUsage();
  await saveSettings('admin', A, { daily_request_cap: 100, monthly_budget_usd: 20 });
  const okId = await reserve(A, U.staff); await settle(okId, 1000, 200, 'ok');
  const okId2 = await reserve(A, U.staff); await settle(okId2, 1000, 200, 'ok');
  const otherUser = await reserve(A, U.staff2); await settle(otherUser, 1000, 200, 'ok');
  const refused = await reserve(A, U.staff); await settle(refused, 1000, 0, 'refused');
  const open = await reserve(A, U.staff);
  const inbox = await reserve(A, U.staff, 'inbox'); await settle(inbox, 10, 10, 'ok');
  await check('staff saves an AI reading: engine claude-opus-5-5 + its own ok usage row; new keys (vessel, ports, parties) accepted', async () => {
    const r = await insertExt('staff', extRow({ ai_usage_id: okId, extracted_fields: { bl_number: 'MEDU1234567', vessel: 'MSC TEST', voyage: 'FA123',
      port_of_loading: 'Shanghai', port_of_discharge: 'Jeddah', shipper: 'Shipper Co', consignee: 'Consignee Co', container_numbers: 'CSQU3054383' } }));
    return (r && r.ai_usage_id === okId && r.engine === 'claude-opus-5-5') || J(r);
  });
  await check('the same reading cannot be saved twice (unique ai_usage_id) — even with another file', async () =>
    /duplicate key|23505|document_extractions_ai_usage_uidx/.test(await tryErr(() => insertExt('staff', extRow({ ai_usage_id: okId })))));
  await check('refused: engine claude without a usage id, a usage id with another engine, another user\'s / refused / open / inbox / unknown reading', async () => {
    const r = [
      await code(() => insertExt('staff', extRow({}))),
      await code(() => insertExt('staff', extRow({ engine: 'tesseract.js@5.1.1', ai_usage_id: okId2 }))),
      await code(() => insertExt('staff', extRow({ ai_usage_id: otherUser }))),
      await code(() => insertExt('staff', extRow({ ai_usage_id: refused }))),
      await code(() => insertExt('staff', extRow({ ai_usage_id: open }))),
      await code(() => insertExt('staff', extRow({ ai_usage_id: inbox })))
    ];
    const unknown = await tryErr(() => insertExt('staff', extRow({ ai_usage_id: '00000000-0000-4000-8000-00000000beef' })));
    return (r.every(x => x === 'MRS_INVALID ai_usage_id') && /MRS_INVALID|foreign key|violates/.test(unknown)) || J({ r, unknown });
  });
  await check('a reading of org A cannot be saved into org B (another org\'s admin, or A staff naming org B)', async () => {
    await db.exec(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ('${U.staff}', '${B}', NULL, 'accountant') ON CONFLICT DO NOTHING`);
    const a = await code(() => insertExt('staff', extRow({ org_id: B, ai_usage_id: okId2 })));
    await db.exec(`DELETE FROM public.memberships WHERE user_id = '${U.staff}' AND org_id = '${B}'`);
    return a === 'MRS_INVALID ai_usage_id' || a;
  });
  await check('ai_usage_id is immutable after insert (MRS_IMMUTABLE); review fields still editable', async () => {
    const row = await insertExt('staff', extRow({ ai_usage_id: okId2 }));
    const a = await code(() => as('staff', `UPDATE public.document_extractions SET ai_usage_id = NULL WHERE id = $1`, [row.id]));
    const b = await code(() => as('staff', `UPDATE public.document_extractions SET review_status = 'reviewed', reviewed_fields = '{"vessel":"MSC TEST 2"}' WHERE id = $1`, [row.id]));
    return (a === 'MRS_IMMUTABLE ai_usage_id' && b === 'ok') || J({ a, b });
  });
  await check('Tesseract readings are unchanged (no usage id needed); unknown field keys still refused', async () => {
    const a = await code(() => insertExt('staff', extRow({ engine: 'tesseract.js@5.1.1', languages: 'ara+eng' })));
    const b = await tryErr(() => insertExt('staff', extRow({ engine: 'tesseract.js@5.1.1', languages: 'ara+eng', extracted_fields: { secret: 'x' } })));
    return (a === 'ok' && /document_extractions_fields_chk/.test(b)) || J({ a, b });
  });
  await check('a client (portal) user cannot insert an AI extraction (RLS)', async () =>
    /row-level security|permission denied|MRS_INVALID/.test(await tryErr(() => insertExt('portal', extRow({ ai_usage_id: okId2 })))));
  await check('the audit trail of an AI extraction carries no OCR content (raw_text / fields stripped as before)', async () => {
    const r = await one(`SELECT new_data FROM public.audit_log WHERE table_name = 'document_extractions' ORDER BY id DESC LIMIT 1`);
    return (r && !('raw_text' in r.new_data) && !('extracted_fields' in r.new_data)) || J(r);
  });
}

/* ------------------------------------------------------------------ helper (classic script) */
const X = require(path.join(FN_DIR, 'extract.js'));
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64');
const PDF = Buffer.from('%PDF-1.7\n%test only\n').toString('base64');
const JPG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70, 0, 1]).toString('base64');
const goodBody = o => Object.assign({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }, o || {});
function walk(node, fn, at) {
  if (!node || typeof node !== 'object') return;
  fn(node, at || '$');
  for (const k of Object.keys(node)) walk(node[k], fn, (at || '$') + '.' + k);
}
const msgOf = (data, extra) => Object.assign({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: typeof data === 'string' ? data : J(data) }],
  usage: { input_tokens: 2100, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, extra || {});
const modelOut = o => Object.assign({ doc_type: 'bill_of_lading', fields: [
  { name: 'bl_number', value: 'MEDUJD123456', confidence: 0.97, page: null },
  { name: 'container_numbers', value: 'CSQU3054383', confidence: 0.92, page: null },
  { name: 'container_numbers', value: 'CSQU3054384', confidence: 0.9, page: null },
  { name: 'vessel', value: 'MSC TEST', confidence: 0.88, page: null },
  { name: 'port_of_discharge', value: 'Jeddah Islamic Port', confidence: 1.7, page: 0 },
  { name: 'iban', value: 'SA03 8000 0000 6080 1016 7519', confidence: 0.5, page: null }], line_items: [], warnings: ['ختم غير واضح'] }, o || {});

async function secHelper() {
  section('7. helper extract.js: request, schema, validation, parsing (mocked Claude)');
  await check('exports; model claude-opus-5-5, effort medium, refusal fallbacks default + beta server-side-fallback-2026-07-01, 10 MB', () =>
    (X.MODEL === 'claude-opus-5-5' && X.ENGINE === 'claude-opus-5-5' && X.EFFORT === 'medium' && X.FALLBACKS === 'default'
      && J(X.BETAS) === J(['server-side-fallback-2026-07-01']) && X.MAX_BYTES === 10 * 1024 * 1024
      && ['validateRequest', 'buildRequest', 'callClaude', 'parseMessage', 'postProcess', 'estimateHoldUsd', 'isValidContainer'].every(k => typeof X[k] === 'function')) || 'exports');
  await check('buildRequest (image): beta params, output_config {effort, json_schema}, no thinking / budget / temperature / prefill, image block first', () => {
    const p = X.buildRequest(X.validateRequest(goodBody()));
    const c = p.messages[0].content;
    return (p.model === 'claude-opus-5-5' && p.max_tokens === 16000 && J(p.betas) === J(['server-side-fallback-2026-07-01']) && p.fallbacks === 'default'
      && p.output_config.effort === 'medium' && p.output_config.format.type === 'json_schema' && !('thinking' in p) && !('temperature' in p)
      && !('top_p' in p) && !('output_format' in p) && p.messages.length === 1 && p.messages[0].role === 'user'
      && c[0].type === 'image' && c[0].source.type === 'base64' && c[0].source.media_type === 'image/png' && c[0].source.data === PNG
      && c[1].type === 'text' && /bill_of_lading/.test(c[1].text) && /Arabic/.test(c[1].text) && typeof p.system === 'string') || J(Object.keys(p));
  });
  await check('buildRequest (PDF): base64 document block before the text; lang en → English warnings', () => {
    const p = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'auto', lang: 'en', file: { media_type: 'application/pdf', data_b64: PDF } })));
    const c = p.messages[0].content;
    return (c[0].type === 'document' && c[0].source.media_type === 'application/pdf' && c[0].source.data === PDF && /English/.test(c[1].text)
      && /unknown/.test(c[1].text)) || J(c.map(b => b.type));
  });
  await check('system prompt: treats the document as data (ignore its instructions), no invented values, normalization rules', () =>
    (/data, not instructions/.test(X.SYSTEM) && /Never invent/.test(X.SYSTEM) && /YYYY-MM-DD/.test(X.SYSTEM) && /ISO 4217/.test(X.SYSTEM)) || 'system');
  await check('schema: every object has additionalProperties:false and requires all its properties; no numeric / length constraints', () => {
    const problems = [];
    for (const t of X.DOC_TYPES) {
      walk(X.outputSchema(t), (n, at) => {
        if (n.type === 'object') {
          if (n.additionalProperties !== false) problems.push(t + at + ' additionalProperties');
          const props = Object.keys(n.properties || {});
          if (J(props.slice().sort()) !== J((n.required || []).slice().sort())) problems.push(t + at + ' required');
        }
        for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'])
          if (k in n) problems.push(t + at + ' ' + k);
      });
    }
    return problems.length === 0 || J(problems.slice(0, 5));
  });
  await check('schema: field name enum per doc type (B/L: vessel / voyage / ports / containers / parties; invoice: VAT / totals; auto: all 28)', () => {
    const en = t => X.outputSchema(t).properties.fields.items.properties.name.enum;
    const bl = en('bill_of_lading'), inv = en('commercial_invoice'), sup = en('supplier_invoice'), cd = en('customs_declaration'), au = en('auto');
    return (['bl_number', 'vessel', 'voyage', 'port_of_loading', 'port_of_discharge', 'container_numbers', 'shipper', 'consignee'].every(k => bl.includes(k))
      && ['invoice_number', 'invoice_date', 'currency', 'subtotal', 'vat_amount', 'total', 'supplier_vat', 'hs_codes'].every(k => inv.includes(k))
      && sup.includes('iban') && cd.includes('declaration_number') && cd.includes('hs_codes') && au.length === 28 && !bl.includes('iban')
      && J(X.outputSchema('auto').properties.doc_type.enum) === J(['bill_of_lading', 'commercial_invoice', 'customs_declaration', 'supplier_invoice', 'other'])) || J({ bl, inv });
  });
  await check('schema: line_items {description, hs_code, quantity, unit_price, amount} — the keys app.extraction_items_ok accepts', () =>
    J(Object.keys(X.outputSchema('commercial_invoice').properties.line_items.items.properties)) === J(['description', 'hs_code', 'quantity', 'unit_price', 'amount']));
  await check('validateRequest refusals: bad org, doc type, unknown key, media type, base64, magic bytes, size, transaction id, lang', () => {
    const big = 'A'.repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4 + 8);
    const cases = [
      [null, 'bad_request'], [goodBody({ org_id: 'x' }), 'bad_request'], [goodBody({ doc_type: 'passport' }), 'bad_request'],
      [goodBody({ extra: 1 }), 'bad_request'], [goodBody({ file: { media_type: 'image/bmp', data_b64: PNG } }), 'unsupported_media'],
      [goodBody({ file: { media_type: 'image/png', data_b64: '!!!!notbase64' } }), 'bad_request'],
      [goodBody({ file: { media_type: 'image/jpeg', data_b64: PNG } }), 'unsupported_media'],
      [goodBody({ file: { media_type: 'application/pdf', data_b64: JPG } }), 'unsupported_media'],
      [goodBody({ file: { media_type: 'image/png', data_b64: big } }), 'too_large'],
      [goodBody({ transaction_id: 'nope' }), 'bad_request'], [goodBody({ lang: 'fr' }), 'bad_request'],
      [goodBody({ file: { media_type: 'image/png', data_b64: PNG, name: 'x' } }), 'bad_request']];
    const got = cases.map(([b]) => { try { X.validateRequest(b); return 'ok'; } catch (e) { return e.code + ':' + e.status; } });
    const want = cases.map(([, c]) => c);
    const okCases = [goodBody(), goodBody({ file: { media_type: 'image/jpeg', data_b64: JPG } }), goodBody({ file: { media_type: 'application/pdf', data_b64: PDF }, doc_type: undefined })];
    const oks = okCases.map(b => { try { return X.validateRequest(b).doc_type; } catch (e) { return e.code; } });
    return (got.every((g, i) => g.split(':')[0] === want[i]) && J(oks) === J(['bill_of_lading', 'bill_of_lading', 'auto'])
      && got.find(g => g.startsWith('too_large')) === 'too_large:413') || J({ got, oks });
  });
  await check('ISO 6346: known valid numbers pass, a wrong check digit / format fails', () => {
    const valid = ['CSQU3054383', 'MSKU9070323', 'TGHU9999998'.slice(0, 10) + X.iso6346CheckDigit('TGHU999999')];
    const invalid = ['CSQU3054384', 'CSQ3054383', 'CSQA3054383', '', 'csqu305438'];
    return (valid.every(X.isValidContainer) && invalid.every(c => !X.isValidContainer(c)) && X.isValidContainer('csqu3054383')
      && X.iso6346CheckDigit('CSQU305438') === 3) || J({ v: valid.map(X.isValidContainer), i: invalid.map(X.isValidContainer) });
  });
  await check('validators: Saudi VAT (15 digits, 3…3), HS formats, ISO dates (no Feb 30)', () =>
    (X.isSaudiVat('300000000000003') && !X.isSaudiVat('310000000000002') && !X.isSaudiVat('30000000000003') && X.isHs('8708.30') && X.isHs('870830')
      && !X.isHs('87A8') && X.isIsoDate('2026-02-28') && !X.isIsoDate('2026-02-30') && !X.isIsoDate('28/02/2026')) || 'validators');
  await check('parseMessage: stop_reason refusal → refused (content not read); max_tokens → truncated; pause_turn → bad_output', () => {
    const a = X.parseMessage(msgOf(modelOut(), { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }));
    const b = X.parseMessage(msgOf('{"doc_type":"bill_of', { stop_reason: 'max_tokens' }));
    const c = X.parseMessage(msgOf(modelOut(), { stop_reason: 'pause_turn' }));
    return (a.ok === false && a.code === 'refused' && b.code === 'truncated' && c.code === 'bad_output' && a.usage.input_tokens === 2100) || J({ a, b, c });
  });
  await check('parseMessage: end_turn → JSON of the text blocks (thinking / fallback blocks skipped); bad JSON / shape → bad_output', () => {
    const m = msgOf(modelOut());
    m.content.unshift({ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } });
    m.model = 'claude-opus-4-8';
    const a = X.parseMessage(m);
    const b = X.parseMessage(msgOf('not json'));
    const c = X.parseMessage(msgOf({ doc_type: 'passport', fields: [], line_items: [], warnings: [] }));
    const d = X.parseMessage(msgOf({ doc_type: 'other', fields: [{ name: 'x', value: 1 }], line_items: [], warnings: [] }));
    const e = X.parseMessage({ stop_reason: 'end_turn', content: null });
    return (a.ok && a.model === 'claude-opus-4-8' && a.data.fields.length === 6 && b.code === 'bad_output' && c.code === 'bad_output'
      && d.code === 'bad_output' && e.code === 'bad_output') || J({ a: a.code, b: b.code, c: c.code, d: d.code });
  });
  await check('usage: input = uncached + cache reads + cache writes × 1.25; output tokens; bad values → 0; unknown model name → claude-opus-5-5', () => {
    const u = X.usageOf({ usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 3, output_tokens: 50 } });
    const z = X.usageOf({ usage: { input_tokens: -5, output_tokens: 'x' } });
    const p = X.parseMessage(msgOf(modelOut(), { model: 'Bad Model!' }));
    return (u.input_tokens === 128 && u.output_tokens === 50 && J(u.attempts) === J([{ model: 'claude-opus-5-5', input_tokens: 128, output_tokens: 50 }])
      && z.input_tokens === 0 && z.output_tokens === 0 && p.model === 'claude-opus-5-5') || J({ u, z, p: p.model });
  });
  await check('postProcess: ISO 6346 server check (valid kept, invalid → warning), confidence clamped 0..1, page ≥ 1, IBAN normalized', () => {
    const r = X.postProcess(modelOut(), 'bill_of_lading');
    const f = Object.fromEntries(r.fields.map(x => [x.name, x]));
    return (f.container_numbers.value === 'CSQU3054383' && r.warnings.some(w => w.code === 'container_check_digit' && /CSQU3054384/.test(w.text))
      && f.port_of_discharge.confidence === 1 && f.port_of_discharge.page === null && !f.iban /* not a B/L field */
      && r.warnings.some(w => w.source === 'model' && w.text === 'ختم غير واضح') && r.extracted_fields.vessel === 'MSC TEST'
      && r.kind === 'bill_of_lading' && r.mean_confidence > 0 && r.mean_confidence <= 100) || J(r);
  });
  await check('postProcess: invoice checks — Saudi VAT format, ISO date, amounts, totals mismatch, 15 % VAT, currency', () => {
    const r = X.postProcess({ doc_type: 'commercial_invoice', line_items: [{ description: 'Brake pads', hs_code: '8708.30', quantity: 10, unit_price: 100, amount: 1000 },
      { description: '', hs_code: null, quantity: null, unit_price: null, amount: null }], warnings: [], fields: [
      { name: 'invoice_number', value: 'INV-1', confidence: 0.99, page: 1 }, { name: 'invoice_date', value: '2026-02-30', confidence: 0.9, page: 1 },
      { name: 'supplier_vat', value: '3000 0000 0000 003', confidence: 0.95, page: 1 }, { name: 'buyer_vat', value: '123', confidence: 0.6, page: 1 },
      { name: 'currency', value: 'sar', confidence: 0.99, page: 1 }, { name: 'subtotal', value: '1,000.00', confidence: 0.9, page: 1 },
      { name: 'vat_amount', value: '100', confidence: 0.9, page: 1 }, { name: 'total', value: '1200', confidence: 0.9, page: 1 },
      { name: 'iban', value: 'SA0380000000608010167519', confidence: 0.9, page: 1 }] }, 'commercial_invoice');
    const c = r.warnings.map(w => w.code);
    const f = Object.fromEntries(r.fields.map(x => [x.name, x]));
    return (f.supplier_vat.value === '300000000000003' && f.supplier_vat.valid && f.buyer_vat.valid === false && c.includes('vat_format')
      && c.includes('date_format') && c.includes('totals_mismatch') && c.includes('vat_rate') && f.currency.value === 'SAR' && f.subtotal.value === '1000'
      && !f.iban && r.line_items.length === 1 && r.line_items[0].hs_code === '8708.30' && r.kind === 'commercial_invoice') || J({ c, f, items: r.line_items });
  });
  await check('postProcess: supplier_invoice → kind operator_invoice; auto takes the detected type; mismatch warning; duplicates merged', () => {
    const a = X.postProcess({ doc_type: 'supplier_invoice', fields: [{ name: 'total', value: '5', confidence: 0.9, page: null },
      { name: 'total', value: '6', confidence: 0.5, page: null }], line_items: [], warnings: [] }, 'supplier_invoice');
    const b = X.postProcess({ doc_type: 'customs_declaration', fields: [{ name: 'hs_codes', value: '8708.30, 8708.30 8481', confidence: 0.8, page: 2 }], line_items: [], warnings: [] }, 'auto');
    const c = X.postProcess({ doc_type: 'bill_of_lading', fields: [], line_items: [], warnings: [] }, 'commercial_invoice');
    return (a.kind === 'operator_invoice' && a.extracted_fields.total === '5' && a.warnings.some(w => w.code === 'conflicting_values')
      && b.doc_type === 'customs_declaration' && b.extracted_fields.hs_codes === '8708.30, 8481' && b.fields[0].page === 2
      && c.warnings.some(w => w.code === 'doc_type_mismatch') && c.mean_confidence === null) || J({ a, b, c });
  });
  await check('postProcess output fits document_extractions: field keys known, values ≤ 2000 chars strings, ≤ 500 items, raw_text ≤ 200000', () => {
    const long = 'x'.repeat(5000);
    const r = X.postProcess({ doc_type: 'other', fields: [{ name: 'shipper', value: long, confidence: 0.5, page: null }],
      line_items: Array.from({ length: 700 }, (_, i) => ({ description: 'item ' + i + '\u0007', hs_code: null, quantity: 1, unit_price: 1, amount: 1 })), warnings: [] }, 'auto');
    const keysOk = Object.keys(r.extracted_fields).every(k => X.ALL_KEYS.includes(k));
    return (keysOk && r.extracted_fields.shipper.length === 2000 && r.line_items.length === 500 && !/\u0007/.test(r.line_items[0].description)
      && r.raw_text.length <= 200000 && /^\[claude-opus-5-5 · ai-doc-v2\]/.test(r.raw_text)) || J({ keysOk, n: r.line_items.length });
  });
  // prompt v2 (20261116000100 doc_match): weights / packages / package type / goods / incoterms for the invoice ↔ B/L ↔ declaration match
  await check('v2: PROMPT_VERSION ai-doc-v2; the 6 match keys in ALL_KEYS = app.extraction_field_keys() of the latest migration', () => {
    const keys = ['gross_weight', 'net_weight', 'packages_count', 'package_type', 'goods_description', 'incoterms'];
    const sql = fs.readFileSync(path.join(MIG_DIR, '20261116000100_doc_match.sql'), 'utf8');
    const m = /FUNCTION app\.extraction_field_keys\(\)[\s\S]*?SELECT ARRAY\[([\s\S]*?)\]/.exec(sql);
    const dbKeys = m ? m[1].match(/'([a-z_]+)'/g).map(x => x.slice(1, -1)) : [];
    return (X.PROMPT_VERSION === 'ai-doc-v2' && X.ALL_KEYS.length === 28 && keys.every(k => X.ALL_KEYS.includes(k)) && J(X.MATCH_KEYS) === J(keys)
      && J(dbKeys) === J(X.ALL_KEYS)) || J({ v: X.PROMPT_VERSION, n: X.ALL_KEYS.length, dbKeys: dbKeys.length });
  });
  await check('v2: keys per doc type — B/L + invoice get all 6 match keys, the invoice also the shipping fields; the declaration weights / packages; supplier invoice unchanged', () => {
    const K = X.KEYS_FOR;
    const six = ['gross_weight', 'net_weight', 'packages_count', 'package_type', 'goods_description', 'incoterms'];
    return (six.every(k => K.bill_of_lading.includes(k)) && six.every(k => K.commercial_invoice.includes(k))
      && ['shipper', 'consignee', 'vessel', 'port_of_loading', 'port_of_discharge'].every(k => K.commercial_invoice.includes(k))
      && ['gross_weight', 'net_weight', 'packages_count'].every(k => K.customs_declaration.includes(k)) && !K.customs_declaration.includes('incoterms')
      && !six.some(k => K.supplier_invoice.includes(k)) && Object.values(K).every(list => list.every(k => X.ALL_KEYS.includes(k)))) || J(K);
  });
  await check('v2: the request lists the new keys with their hints (kilograms, convert tonnes / lbs and say so; whole number of packages; Incoterms code + place)', () => {
    const t = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'commercial_invoice' }))).messages[0].content[1].text;
    const d = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'customs_declaration' }))).messages[0].content[1].text;
    return (/- gross_weight: [^\n]*KILOGRAMS[^\n]*tonnes[^\n]*lbs[^\n]*warnings/.test(t) && /- packages_count: [^\n]*whole number/.test(t)
      && /- incoterms: [^\n]*FOB/.test(t) && /- package_type: /.test(t) && /- goods_description: /.test(t) && /- shipper: /.test(t)
      && /- net_weight: /.test(d) && !/- incoterms: /.test(d)) || t;
  });
  await check('v2: the customs declaration prompt asks for the declared customs value as total, not the VAT-inclusive grand total / amount payable', () => {
    const t = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'commercial_invoice' }))).messages[0].content[1].text;
    const d = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'customs_declaration' }))).messages[0].content[1].text;
    const dt = (d.match(/^- total: .*$/m) || [''])[0];
    return (/declared customs value/.test(dt) && /NOT the duties/.test(dt) && !/including VAT/.test(dt)
      && /^- total: grand total including VAT/m.test(t)) || dt;
  });
  await check('v2 postProcess: weights → plain kg (separators / KGS dropped), packages a whole number, incoterms code upper-cased; no warning when sane', () => {
    const r = X.postProcess({ doc_type: 'bill_of_lading', line_items: [], warnings: [], fields: [
      { name: 'gross_weight', value: '18,250.50 KGS', confidence: 0.9, page: 1 }, { name: 'net_weight', value: '17 000', confidence: 0.9, page: 1 },
      { name: 'packages_count', value: '1,200', confidence: 0.9, page: 1 }, { name: 'package_type', value: 'CTNS', confidence: 0.9, page: 1 },
      { name: 'goods_description', value: 'x'.repeat(900), confidence: 0.8, page: 1 }, { name: 'incoterms', value: 'fob Shanghai', confidence: 0.9, page: 1 }] }, 'bill_of_lading');
    const e = r.extracted_fields;
    const server = r.warnings.filter(w => w.source === 'server');
    return (e.gross_weight === '18250.5' && e.net_weight === '17000' && e.packages_count === '1200' && e.package_type === 'CTNS'
      && e.goods_description.length === 500 && e.incoterms === 'FOB Shanghai' && server.length === 0 && r.fields.every(f => f.valid)) || J({ e, server });
  });
  await check('v2 postProcess: bad / out-of-range weights and counts, net > gross, unknown delivery term → warnings (values kept, valid false), never an error', () => {
    const r = X.postProcess({ doc_type: 'commercial_invoice', line_items: [], warnings: [], fields: [
      { name: 'gross_weight', value: '-5', confidence: 0.9, page: 1 }, { name: 'net_weight', value: 'about ten tonnes', confidence: 0.4, page: 1 },
      { name: 'packages_count', value: '12.5', confidence: 0.9, page: 1 }, { name: 'incoterms', value: 'Free delivery', confidence: 0.7, page: 1 }] }, 'commercial_invoice');
    const r2 = X.postProcess({ doc_type: 'bill_of_lading', line_items: [], warnings: [], fields: [
      { name: 'gross_weight', value: '1000', confidence: 0.9, page: 1 }, { name: 'net_weight', value: '1200', confidence: 0.9, page: 1 },
      { name: 'packages_count', value: '99999999', confidence: 0.9, page: 1 }, { name: 'gross_weight', value: '1000', confidence: 0.5, page: 2 }] }, 'bill_of_lading');
    const c = r.warnings.map(w => w.code), c2 = r2.warnings.map(w => w.code);
    const f = Object.fromEntries(r.fields.map(x => [x.name, x]));
    return (J(c.sort()) === J(['incoterms_format', 'packages_format', 'weight_format', 'weight_range']) && f.gross_weight.value === '-5' && !f.gross_weight.valid
      && f.net_weight.value === 'about ten tonnes' && !f.incoterms.valid && J(c2.sort()) === J(['net_over_gross', 'packages_range'])
      && r2.extracted_fields.gross_weight === '1000') || J({ c, c2 });
  });
  await check('v2 postProcess: the declaration drops package_type / incoterms (not its keys); auto keeps all; helpers measure / incotermCode', () => {
    const fields = [{ name: 'package_type', value: 'BAGS', confidence: 0.9, page: 1 }, { name: 'incoterms', value: 'CIF Jeddah', confidence: 0.9, page: 1 },
      { name: 'packages_count', value: '40', confidence: 0.9, page: 1 }];
    const d = X.postProcess({ doc_type: 'customs_declaration', line_items: [], warnings: [], fields }, 'customs_declaration');
    const a = X.postProcess({ doc_type: 'customs_declaration', line_items: [], warnings: [], fields }, 'auto');
    return (J(Object.keys(d.extracted_fields)) === J(['packages_count']) && J(Object.keys(a.extracted_fields).sort()) === J(['incoterms', 'package_type', 'packages_count'])
      && X.measure('1,234.5 kg') === 1234.5 && X.measure('12 t') === null && X.incotermCode('C&F Dammam') === 'C&F' && X.incotermCode('CIFX') === null
      && X.incotermCode('ddp') === 'DDP') || J({ d: d.extracted_fields, a: a.extracted_fields });
  });
  await check('v2 postProcess output with every new key is accepted by document_extractions (field keys of the latest migration)', async () => {
    const out = X.postProcess({ doc_type: 'bill_of_lading', line_items: [], warnings: [], fields: [
      { name: 'gross_weight', value: '100', confidence: 0.9, page: 1 }, { name: 'net_weight', value: '90', confidence: 0.9, page: 1 },
      { name: 'packages_count', value: '4', confidence: 0.9, page: 1 }, { name: 'package_type', value: 'PALLETS', confidence: 0.9, page: 1 },
      { name: 'goods_description', value: 'Brake pads', confidence: 0.9, page: 1 }, { name: 'incoterms', value: 'CFR Dammam', confidence: 0.9, page: 1 }] }, 'bill_of_lading');
    const r = await tryErr(() => insertExt('staff', extRow({ engine: 'tesseract.js@5.1.1', languages: 'eng', extracted_fields: out.extracted_fields })));
    return (r === 'ok' && Object.keys(out.extracted_fields).length === 6) || r;
  });
  await check('estimateHoldUsd: at the highest fallback price ($5 / $25), input × 2: image = $0.48; PDF grows with size and pages; capped ≤ $50', () => {
    const img = X.estimateHoldUsd('image/png', 2e6), small = X.estimateHoldUsd('application/pdf', 100000), large = X.estimateHoldUsd('application/pdf', 10 * 1024 * 1024);
    const paged = X.estimateHoldUsd('application/pdf', 100000, 200), huge = X.estimateHoldUsd('application/pdf', 100000, 100000);
    return (img === 0.48 && large > small && paged > large && huge <= 50 && small > 0 && paged === Math.round((2 * (3000 + 200 * 4000) * 5 + 16000 * 25) / 1e6 * 1e4) / 1e4)
      || J({ img, small, large, paged, huge });
  });
  await check('callClaude: uses only the injected client (client.beta.messages.create with the params); no client → not_configured', async () => {
    const calls = [];
    const client = { beta: { messages: { create: async (params, opts) => { calls.push({ params, opts }); return msgOf(modelOut()); } } } };
    const params = X.buildRequest(X.validateRequest(goodBody()));
    const m = await X.callClaude(client, params, { timeout: 5 });
    let e = null;
    try { await X.callClaude(null, params); } catch (err) { e = err; }
    return (calls.length === 1 && calls[0].params === params && calls[0].opts.timeout === 5 && m.stop_reason === 'end_turn'
      && e && e.code === 'not_configured' && e.status === 503 && fetchCalls === 0) || J({ calls: calls.length, e: e && e.code });
  });
  await check('mocked pipeline: validate → build → mocked Claude → parse → postProcess → a row the database accepts', async () => {
    const v = X.validateRequest(goodBody({ file: { media_type: 'application/pdf', data_b64: PDF } }));
    const client = { beta: { messages: { create: async () => msgOf(modelOut()) } } };
    const parsed = X.parseMessage(await X.callClaude(client, X.buildRequest(v)));
    const out = X.postProcess(parsed.data, v.doc_type);
    const id = await reserve(A, U.staff); await settle(id, parsed.usage.input_tokens, parsed.usage.output_tokens, 'ok', parsed.model);
    const row = await insertExt('staff', extRow({ ai_usage_id: id, doc_type: out.kind, extracted_fields: out.extracted_fields, raw_text: out.raw_text,
      line_items: out.line_items }));
    const cost = await one(`SELECT cost_usd::float c FROM app.ai_usage WHERE id = $1`, [id]);
    return (row && row.ai_usage_id === id && cost.c === (2100 * 4 + 900 * 20) / 1e6) || J({ row, cost });
  });
}

async function secReviewHelper() {
  section('7b. review fixes (helper): fallback switch point, per-attempt usage, image limit, PDF pages, SDK error classes');
  await check('review A-1: a declined attempt\'s partial text BEFORE the fallback block is ignored; the rescued JSON parses', () => {
    const m = msgOf(modelOut(), { model: 'claude-opus-4-8' });
    m.content = [{ type: 'text', text: '{"doc_type":"bill_of_lading","fie' }, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'thinking', thinking: '', signature: 'y' }, { type: 'text', text: J(modelOut()) }];
    const a = X.parseMessage(m);
    const two = msgOf(modelOut());
    two.content = [{ type: 'text', text: 'x' }, { type: 'fallback', from: {}, to: {} }, { type: 'text', text: 'y' }, { type: 'fallback', from: {}, to: {} }, { type: 'text', text: J(modelOut()) }];
    const b = X.parseMessage(two);
    return (a.ok && a.model === 'claude-opus-4-8' && a.data.fields.length === 6 && b.ok) || J({ a: a.code, b: b.code });
  });
  await check('review A-2: usage.iterations → one attempt each (declined claude-opus-5-5 + claude-opus-4-8 rescue), sums; model null → requested / served', () => {
    const u = X.usageOf({ model: 'claude-opus-4-8', usage: { input_tokens: 2100, output_tokens: 900, iterations: [
      { type: 'message', model: null, input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'fallback_message', model: null, input_tokens: 2100, output_tokens: 900, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }] } });
    return (J(u.attempts) === J([{ model: 'claude-opus-5-5', input_tokens: 2000, output_tokens: 300 }, { model: 'claude-opus-4-8', input_tokens: 2110, output_tokens: 900 }])
      && u.input_tokens === 4110 && u.output_tokens === 1200) || J(u);
  });
  await check('review A-5: images over 5 MB → too_large 413 (the API limit); a PDF of 6 MB is accepted; MAX_IMAGE_BYTES 5 MB', () => {
    const big = n => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(n)]).toString('base64');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(6 * 1024 * 1024)]).toString('base64');
    let a; try { X.validateRequest(goodBody({ file: { media_type: 'image/png', data_b64: big(5 * 1024 * 1024 + 10) } })); a = 'ok'; } catch (e) { a = e.code + ':' + e.status; }
    const b = X.validateRequest(goodBody({ file: { media_type: 'image/png', data_b64: big(5 * 1024 * 1024 - 100) } })).bytes;
    const c = X.validateRequest(goodBody({ file: { media_type: 'application/pdf', data_b64: pdf } }));
    return (a === 'too_large:413' && b <= 5 * 1024 * 1024 && c.media_type === 'application/pdf' && X.MAX_IMAGE_BYTES === 5 * 1024 * 1024) || J({ a, b });
  });
  await check('review A-8: PDF page objects are counted (/Type /Page, not /Pages) and raise the hold; compressed / unreadable → 0 (byte estimate applies)', () => {
    const doc = '%PDF-1.7\n1 0 obj <</Type /Pages /Count 3>> endobj\n' + Array.from({ length: 40 }, (_, i) => (i + 2) + ' 0 obj <</Type/Page /Parent 1 0 R>> endobj\n').join('');
    const b64 = Buffer.from(doc).toString('base64');
    const v = X.validateRequest(goodBody({ file: { media_type: 'application/pdf', data_b64: b64 } }));
    return (X.pdfPageCount(b64) === 40 && v.pages === 40 && X.pdfPageCount('!!!!') === 0 && X.pdfPageCount(PDF) === 0
      && X.estimateHoldUsd('application/pdf', v.bytes, v.pages) > X.estimateHoldUsd('application/pdf', v.bytes, 0)) || J({ n: X.pdfPageCount(b64), p: v.pages });
  });
  await check('review A-3: classifyCallError — 429 / other 4xx settle error ($0); timeout, connection lost, abort, 5xx, 529, unexpected → unknown (hold charged)', () => {
    const r = [
      X.classifyCallError(new SDK.RateLimitError(), SDK), X.classifyCallError(new SDK.APIError(400), SDK), X.classifyCallError(new SDK.APIError(401), SDK),
      X.classifyCallError(new SDK.APIConnectionTimeoutError(), SDK), X.classifyCallError(new SDK.APIConnectionError(), SDK), X.classifyCallError(new SDK.APIUserAbortError(), SDK),
      X.classifyCallError(new SDK.APIError(500), SDK), X.classifyCallError(new SDK.APIError(529), SDK), X.classifyCallError(new TypeError('x'), SDK),
      X.classifyCallError(new X.AiError('not_configured', 503), SDK)].map(c => c.code + '/' + c.status + '/' + c.settle);
    return J(r) === J(['upstream_busy/503/error', 'upstream_error/502/error', 'upstream_error/502/error', 'upstream_error/502/unknown', 'upstream_error/502/unknown',
      'upstream_error/502/unknown', 'upstream_error/502/unknown', 'upstream_busy/503/unknown', 'internal/500/unknown', 'not_configured/503/error']) || J(r);
  });
}

/* mocked Anthropic SDK error classes (the shape of @anthropic-ai/sdk 1.5.0: APIConnectionTimeoutError extends APIConnectionError) */
class MockAPIError extends Error { constructor(status) { super('upstream said sk-ant-SECRET and more'); this.status = status; } }
class MockRateLimitError extends MockAPIError { constructor() { super(429); } }
class MockAPIConnectionError extends MockAPIError { constructor() { super(undefined); } }
class MockAPIConnectionTimeoutError extends MockAPIConnectionError {}
class MockAPIUserAbortError extends MockAPIError { constructor() { super(undefined); } }
const SDK = { APIError: MockAPIError, RateLimitError: MockRateLimitError, APIConnectionError: MockAPIConnectionError,
  APIConnectionTimeoutError: MockAPIConnectionTimeoutError, APIUserAbortError: MockAPIUserAbortError };

const H = require(path.join(FN_DIR, 'handler.js'));
// handler deps: the service client runs the real ai_reserve / ai_settle on PGlite as service_role; the user client runs
// ai_access as the staff member; Claude is a mocked client
function hDeps(o) {
  const x = o || {};
  const calls = [];
  const sqlRpc = (who, name, args) => {
    const keys = Object.keys(args);
    const vals = keys.map(k => (args[k] !== null && typeof args[k] === 'object' ? J(args[k]) : args[k]));
    return as(who, `SELECT public.${name}(${keys.map((k, i) => k + ' => $' + (i + 1)).join(', ')}) r`, vals)
      .then(r => ({ data: r[0].r, error: null }), e => ({ data: null, error: { message: e.message } }));
  };
  const d = {
    calls, X, sdk: SDK, configured: x.configured !== false, modelConfigured: x.modelConfigured !== false,
    isAnonKey: t => t === 'anon-key', log: t => calls.push('log:' + t),
    userClient: () => ({
      auth: { getUser: async () => (x.noUser ? { data: { user: null }, error: { message: 'bad jwt' } } : { data: { user: { id: U.staff } }, error: null }) },
      rpc: (name, args) => { calls.push('user:' + name); return sqlRpc('staff', name, args); },
      from: () => { const q2 = { select: () => q2, eq: () => q2, maybeSingle: async () => ({ data: x.tx ? { id: 'tx' } : null, error: null }) }; return q2; }
    }),
    serviceClient: () => ({ rpc: (name, args) => { calls.push(name); d.last = d.last || {}; d.last[name] = args; return (x.settleFails && name === 'ai_settle') || (x.bindFails && name === 'ai_bind_source') ? Promise.resolve({ data: null, error: { message: 'down' } }) : sqlRpc('service', name, args); } }),
    claudeClient: () => ({ beta: { messages: { create: async (params, opts) => { calls.push('claude'); d.params = params; d.opts = opts; if (x.throws) throw x.throws; return x.msg || msgOf(modelOut()); } } } })
  };
  return d;
}
const hReq = (body, o) => {
  const y = o || {};
  const headers = Object.assign({ origin: 'https://marsacloud.com', authorization: 'Bearer user-token', 'content-type': 'application/json' }, y.headers || {});
  const init = { method: y.method || 'POST', headers };
  if (y.stream) { init.body = y.stream; init.duplex = 'half'; } else if (body !== undefined && init.method === 'POST') init.body = typeof body === 'string' ? body : J(body);
  return new Request('https://edge.example/functions/v1/ai-extract', init);
};
const usageRow = id => one(`SELECT status, unknown_outcome uo, cost_usd::float c, reserved_usd::float h, input_tokens i, output_tokens o, model FROM app.ai_usage WHERE id = $1`, [id]);
const lastUsage = () => one(`SELECT id, status, unknown_outcome uo, cost_usd::float c, reserved_usd::float h, input_tokens i, output_tokens o, model FROM app.ai_usage ORDER BY created_at DESC, id LIMIT 1`);

async function secHandler() {
  section('7c. handler.js: the request path with mocked clients (review A-10), PGlite reserve / settle');
  await resetUsage();
  await saveSettings('admin', A, { daily_request_cap: 100, monthly_budget_usd: 20 });
  await check('happy path: getUser → ai_access → ai_reserve → Claude → ai_settle(ok); 200 with the reading; cost from the real tokens', async () => {
    const d = hDeps();
    const r = await H.handleRequest(hReq(goodBody()), d);
    const b = JSON.parse(r.body);
    const u = await usageRow(b.usage_id);
    const order = d.calls.filter(c => !/^log:/.test(c));
    return (r.status === 200 && J(order) === J(['user:ai_access', 'ai_reserve', 'claude', 'ai_settle']) && u.status === 'ok' && u.c === (2100 * 4 + 900 * 20) / 1e6
      && u.h === 0.48 && b.engine === 'claude-opus-5-5' && b.extracted_fields.vessel === 'MSC TEST' && d.params.fallbacks === 'default'
      && J(d.last.ai_settle.p_attempts) === J([{ model: 'claude-opus-5-5', input_tokens: 2100, output_tokens: 900 }]) && r.headers['access-control-allow-origin'] === 'https://marsacloud.com') || J({ r, order, u });
  });
  await check('review A-1 + A-2 end to end: partial text before a fallback block → 200; settle prices the declined claude-opus-5-5 attempt and the claude-opus-4-8 rescue', async () => {
    const m = msgOf(modelOut(), { model: 'claude-opus-4-8', usage: { input_tokens: 2100, output_tokens: 900, iterations: [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 2000, output_tokens: 300 }, { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 2100, output_tokens: 900 }] } });
    m.content = [{ type: 'text', text: '{"doc_type":"bill_of' }, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: J(modelOut()) }];
    const d = hDeps({ msg: m });
    const r = await H.handleRequest(hReq(goodBody()), d);
    const b = JSON.parse(r.body);
    const u = await usageRow(b.usage_id);
    const want = Math.round((2000 * 4 + 300 * 20 + 2100 * 5 + 900 * 25) / 1e6 * 1e6) / 1e6;
    return (r.status === 200 && b.model === 'claude-opus-4-8' && u.model === 'claude-opus-4-8' && u.c === want && u.i === 4100 && u.o === 1200) || J({ s: r.status, b: b.error, u, want });
  });
  await check('review A-3: timeout / connection lost / 5xx / 529 after sending → settled unknown: the held amount is charged; the error is a fixed code', async () => {
    const res = [];
    for (const [e, st, codeWant] of [[new SDK.APIConnectionTimeoutError(), 502, 'upstream_error'], [new SDK.APIConnectionError(), 502, 'upstream_error'],
      [new SDK.APIError(500), 502, 'upstream_error'], [new SDK.APIError(529), 503, 'upstream_busy']]) {
      const d = hDeps({ throws: e });
      const r = await H.handleRequest(hReq(goodBody()), d);
      const u = await lastUsage();
      if (!(r.status === st && J(JSON.parse(r.body)) === J({ error: codeWant }) && u.status === 'error' && u.uo === true && u.c === u.h && u.h === 0.48
        && !/sk-ant|upstream said/.test(r.body + d.calls.join(' ')))) res.push(e.constructor.name + ' ' + J({ r, u }));
    }
    return res.length === 0 || res.join(' | ');
  });
  await check('review A-3: 429 / 400 (rejected before the model ran) → settled error at $0; refusal → 422 refused with its tokens billed', async () => {
    const res = [];
    for (const [e, st] of [[new SDK.RateLimitError(), 503], [new SDK.APIError(400), 502]]) {
      const r = await H.handleRequest(hReq(goodBody()), hDeps({ throws: e }));
      const u = await lastUsage();
      if (!(r.status === st && u.status === 'error' && u.uo === false && u.c === 0)) res.push(st + ' ' + J({ r, u }));
    }
    const r = await H.handleRequest(hReq(goodBody()), hDeps({ msg: msgOf(modelOut(), { stop_reason: 'refusal', usage: { input_tokens: 5000, output_tokens: 0 } }) }));
    const u = await lastUsage();
    if (!(r.status === 422 && JSON.parse(r.body).error === 'refused' && u.status === 'refused' && u.c === 0.02)) res.push('refusal ' + J({ r, u }));
    const t = await H.handleRequest(hReq(goodBody()), hDeps({ msg: msgOf('{"doc', { stop_reason: 'max_tokens', usage: { input_tokens: 1000, output_tokens: 16000 } }) }));
    const ut = await lastUsage();
    if (!(t.status === 422 && JSON.parse(t.body).error === 'truncated' && ut.status === 'error' && ut.o === 16000 && ut.uo === false)) res.push('truncated ' + J({ t, ut }));
    return res.length === 0 || res.join(' | ');
  });
  await check('review A-6: a chunked body (no content-length) past the limit is cut off while reading → 413, stream cancelled, nothing reserved', async () => {
    await resetUsage();
    let cancelled = false, pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(65);
    const stream = new ReadableStream({ pull(c) { pulled++; if (pulled > 40) { c.close(); return; } c.enqueue(chunk); }, cancel() { cancelled = true; } });
    const d = hDeps();
    const r = await H.handleRequest(hReq(undefined, { stream }), d);
    const n = (await one(`SELECT count(*)::int n FROM app.ai_usage`)).n;
    return (r.status === 413 && JSON.parse(r.body).error === 'too_large' && cancelled && pulled <= 16 && n === 0 && !d.calls.includes('ai_reserve')) || J({ r, cancelled, pulled, n });
  });
  await check('size: content-length over the PDF envelope → 413 before the user is looked up; an image body over the 5 MB envelope → 413, nothing reserved', async () => {
    const d1 = hDeps();
    const a = await H.handleRequest(hReq('{}', { headers: { 'content-length': String(20 * 1024 * 1024) } }), d1);
    const img = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(6 * 1024 * 1024)]).toString('base64');
    const d2 = hDeps();
    const b = await H.handleRequest(hReq(goodBody({ file: { media_type: 'image/png', data_b64: img } })), d2);
    return (a.status === 413 && d1.calls.length === 0 && b.status === 413 && JSON.parse(b.body).error === 'too_large' && !d2.calls.includes('ai_reserve')) || J({ a, b: b.status, c: d2.calls });
  });
  await check('gates: bad origin 403, OPTIONS 204, GET 405, not configured 503, anon key / bad JWT 401, AI off 403 ai_disabled, no model key 503 — none reaches ai_reserve or Claude', async () => {
    const res = [];
    const t = async (req, o, st, err) => {
      const d = hDeps(o);
      const r = await H.handleRequest(req, d);
      if (r.status !== st || (err && JSON.parse(r.body).error !== err) || d.calls.includes('ai_reserve') || d.calls.includes('claude')) res.push(st + '/' + err + ' got ' + r.status + ' ' + r.body);
    };
    await t(hReq(goodBody(), { headers: { origin: 'https://evil.example' } }), {}, 403, 'origin_not_allowed');
    await t(hReq(undefined, { method: 'OPTIONS' }), {}, 204, null);
    await t(hReq(undefined, { method: 'GET' }), {}, 405, 'method_not_allowed');
    await t(hReq(goodBody()), { configured: false }, 503, 'not_configured');
    await t(hReq(goodBody(), { headers: { authorization: 'Bearer anon-key' } }), {}, 401, 'unauthorized');
    await t(hReq(goodBody()), { noUser: true }, 401, 'unauthorized');
    await t(hReq(goodBody({ transaction_id: '0b5e0000-0000-4000-8000-00000000ffff' })), {}, 404, 'transaction_not_found');
    await t(hReq(goodBody()), { modelConfigured: false }, 503, 'not_configured');
    await saveSettings('admin', A, { enabled: false });
    await t(hReq(goodBody()), {}, 403, 'ai_disabled');
    await enableA();
    return res.length === 0 || res.join(' | ');
  });
  await check('a failing ai_settle never breaks the answer (logged with a fixed text; the 15-minute sweep charges the hold)', async () => {
    const d = hDeps({ settleFails: true });
    const r = await H.handleRequest(hReq(goodBody()), d);
    return (r.status === 200 && d.calls.includes('log:ai-extract: settle failed') && JSON.parse(r.body).usage.cost_usd === null) || J({ r: r.status, c: d.calls });
  });
}

/* prompt ai-doc-v3 (20261119000100 legacy_docs): packing_list, extended keys, containers, dedupe-before-call */
const v3Out = o => Object.assign({ doc_type: 'packing_list', fields: [
  { name: 'packing_list_number', value: 'PL-77', confidence: 0.95, page: 1 }, { name: 'packing_list_date', value: '2026-10-02', confidence: 0.9, page: 1 },
  { name: 'packages_count', value: '40', confidence: 0.9, page: 1 }, { name: 'net_weight', value: '1,000 KGS', confidence: 0.9, page: 1 },
  { name: 'gross_weight', value: '1200', confidence: 0.9, page: 1 }, { name: 'measurement_cbm', value: '28.5 CBM', confidence: 0.8, page: 1 },
  { name: 'consignee', value: 'CONSIGNEE: TEST TRADING CO. ONE\nP.O. BOX 1 JEDDAH\nVAT 300000000000003', confidence: 0.9, page: 1 },
  { name: 'seal_numbers', value: 'SL1001; sl 1002', confidence: 0.85, page: 1 }, { name: 'iban', value: 'SA03', confidence: 0.9, page: 1 }],
  line_items: [{ description: 'Brake pads', hs_code: '870830', quantity: 400, unit_price: null, amount: null, unit: 'PCS', scientific_name: null,
    origin_country: 'China', net_weight: 600, gross_weight: 700, packages: 30, container_number: 'csqu3054383', seal_number: 'SL1001', notes: null },
    { description: 'Clutch discs', hs_code: null, quantity: 100, unit_price: null, amount: null, unit: 'PCS', scientific_name: null, origin_country: null,
      net_weight: 400, gross_weight: 500, packages: 10, container_number: null, seal_number: null, notes: 'fragile' }],
  containers: [{ container_number: 'CSQU 305438-3', seal_number: 'SL1001', size_type: '40hc', packages_count: 40, net_weight: 1000, gross_weight: 1200 },
    { container_number: 'CSQU3054384', seal_number: null, size_type: null, packages_count: null, net_weight: null, gross_weight: null }],
  warnings: [] }, o || {});
async function secV3() {
  section('7e. prompt ai-doc-v3: packing_list, extended keys, containers, compatibility, dedupe-before-call (mocked Claude)');
  await check('v3 exports; the default stays ai-doc-v2 (v2 callers unchanged): DOC_TYPES / ALL_KEYS / SYSTEM untouched', () =>
    (X.PROMPT_VERSION === 'ai-doc-v2' && X.PROMPT_VERSION_V3 === 'ai-doc-v3' && J(X.PROMPT_VERSIONS) === J(['ai-doc-v2', 'ai-doc-v3'])
      && !X.DOC_TYPES.includes('packing_list') && X.DOC_TYPES_V3.includes('packing_list') && X.ALL_KEYS.length === 28 && X.ALL_KEYS_V3.length === 66 /* 42 + the 8 declaration keys (20261120000100) + the 16 card / EIR keys (20261121000100) */ && X.SHIP_KEYS_V3.length === 50
      && J(X.ALL_KEYS_V3.slice(0, 28)) === J(X.ALL_KEYS) && X.KIND_OF.packing_list === 'packing_list' && X.SYSTEM_V3.startsWith(X.SYSTEM)) || 'exports');
  await check('validateRequest: packing_list only with prompt_version ai-doc-v3; an unknown version → bad_request; no version → ai-doc-v2', () => {
    const t = b => { try { return X.validateRequest(b).prompt_version + ':' + X.validateRequest(b).doc_type; } catch (e) { return e.code; } };
    const r = [t(goodBody({ doc_type: 'packing_list' })), t(goodBody({ doc_type: 'packing_list', prompt_version: 'ai-doc-v3' })),
      t(goodBody({ prompt_version: 'ai-doc-v9' })), t(goodBody()), t(goodBody({ prompt_version: 'ai-doc-v2' }))];
    return J(r) === J(['bad_request', 'ai-doc-v3:packing_list', 'bad_request', 'ai-doc-v2:bill_of_lading', 'ai-doc-v2:bill_of_lading']) || J(r);
  });
  await check('buildRequest v2 is unchanged by v3 (same system prompt, no containers in the schema, same keys)', () => {
    const p = X.buildRequest(X.validateRequest(goodBody()));
    const sc = p.output_config.format.schema;
    return (p.system === X.SYSTEM && !('containers' in sc.properties) && J(sc.required) === J(['doc_type', 'fields', 'line_items', 'warnings'])
      && J(sc.properties.fields.items.properties.name.enum) === J(X.KEYS_FOR.bill_of_lading) && !/containers \(one row/.test(p.messages[0].content[1].text)) || J(sc.required);
  });
  await check('buildRequest v3: the same SDK call shape (model, effort, betas, fallbacks, json_schema), SYSTEM_V3 (content-based classification), containers required', () => {
    const p = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'packing_list', prompt_version: 'ai-doc-v3' })));
    const sc = p.output_config.format.schema;
    const en = sc.properties.fields.items.properties.name.enum;
    return (p.model === 'claude-opus-5-5' && p.max_tokens === 16000 && p.output_config.effort === 'medium' && p.fallbacks === 'default'
      && J(p.betas) === J(['server-side-fallback-2026-07-01']) && p.output_config.format.type === 'json_schema' && !('thinking' in p) && p.system === X.SYSTEM_V3
      && /content only, never by the file name/.test(p.system) && /reference only/.test(p.system) && J(sc.required) === J(['doc_type', 'detected_documents', 'fields', 'line_items', 'containers', 'warnings'])
      && sc.properties.doc_type.enum.includes('packing_list') && J(sc.properties.detected_documents.items.enum) === J(X.DETECTED_TYPES_V3)
      && /several documents/.test(p.system) && ['packing_list_number', 'seal_numbers', 'consignee_name', 'measurement_cbm'].every(k => en.includes(k))
      && J(Object.keys(sc.properties.line_items.items.properties)) === J(X.ITEM_KEYS_V3) && /- seal_numbers: ONE container seal/.test(p.messages[0].content[1].text)) || J(sc.required);
  });
  await check('v3 schema: every object additionalProperties:false and requires all its properties; no numeric / length constraints (all v3 doc types)', () => {
    const problems = [];
    for (const t of X.DOC_TYPES_V3) {
      walk(X.outputSchema(t, 'ai-doc-v3'), (n, at) => {
        if (n.type === 'object') {
          if (n.additionalProperties !== false) problems.push(t + at + ' additionalProperties');
          if (J(Object.keys(n.properties || {}).sort()) !== J((n.required || []).slice().sort())) problems.push(t + at + ' required');
        }
        for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern']) if (k in n) problems.push(t + at + ' ' + k);
      });
    }
    return problems.length === 0 || J(problems.slice(0, 5));
  });
  await check('v3 keys per doc type: B/L + seals / notify / booking / places / freight / CBM / temperature / shipping line; invoice + export country / payment terms; every key known', () => {
    const K = X.KEYS_FOR_V3;
    return (['seal_numbers', 'notify_party', 'booking_number', 'place_of_receipt', 'place_of_delivery', 'freight_terms', 'measurement_cbm', 'temperature_c', 'shipping_line', 'consignee_name'].every(k => K.bill_of_lading.includes(k))
      && ['export_country', 'payment_terms', 'seal_numbers', 'consignee_name'].every(k => K.commercial_invoice.includes(k)) && K.packing_list.includes('packing_list_date')
      && J(K.supplier_invoice) === J(X.KEYS_FOR.supplier_invoice) && Object.values(K).every(l => l.every(k => X.ALL_KEYS_V3.includes(k)))) || J(K);
  });
  let P;
  await check('v3 postProcess (packing list): containers normalised + ISO 6346 checked (bad one dropped with a warning), seals unioned, identity name derived from the consignee block', () => {
    P = X.postProcess(v3Out(), 'packing_list', 'ai-doc-v3');
    const e = P.extracted_fields;
    return (P.kind === 'packing_list' && P.doc_type === 'packing_list' && P.prompt_version === 'ai-doc-v3' && P.containers.length === 1
      && P.containers[0].container_number === 'CSQU3054383' && P.containers[0].size_type === '40HC' && P.containers[0].seal_number === 'SL1001'
      && P.warnings.some(w => w.code === 'container_check_digit' && /CSQU3054384/.test(w.text)) && e.container_numbers === 'CSQU3054383'
      && e.seal_numbers === 'SL1001, SL1002' && e.consignee_name === 'TEST TRADING CO. ONE' && e.measurement_cbm === '28.5' && e.net_weight === '1000'
      && e.packing_list_date === '2026-10-02' && !('iban' in e)) || J({ e, c: P.containers, w: P.warnings });
  });
  await check('v3 postProcess: the wider items (unit, weights, packages, container normalised, seal, notes) and the totals check', () => {
    const it = P.line_items;
    const bad = X.postProcess(v3Out({ fields: [{ name: 'packages_count', value: '50', confidence: 0.9, page: 1 }] }), 'packing_list', 'ai-doc-v3');
    const tb = X.postProcess(v3Out({ doc_type: 'bill_of_lading', line_items: [], fields: [{ name: 'temperature_c', value: '+120 °C', confidence: 0.9, page: 1 },
      { name: 'temperature_c', value: '-18', confidence: 0.5, page: 1 }] }), 'bill_of_lading', 'ai-doc-v3');
    return (it.length === 2 && it[0].unit === 'PCS' && it[0].packages === 30 && it[0].container_number === 'CSQU3054383' && it[0].seal_number === 'SL1001'
      && it[1].notes === 'fragile' && !P.warnings.some(w => w.code === 'items_total_mismatch')
      && bad.warnings.some(w => w.code === 'items_total_mismatch' && w.field === 'packages_count') && tb.warnings.some(w => w.code === 'temperature_range')
      && tb.extracted_fields.temperature_c === '120' && tb.warnings.some(w => w.code === 'conflicting_values')) || J({ it, w: bad.warnings, t: tb.warnings });
  });
  await check('v3 ai_detail: {prompt_version, detected_type, doc_type, containers, fields (no values), warnings}; raw_text header ai-doc-v3 with the containers', () => {
    const d = P.ai_detail;
    return (J(Object.keys(d)) === J(['prompt_version', 'detected_type', 'doc_type', 'detected_documents', 'containers', 'fields', 'warnings']) && d.detected_type === 'packing_list'
      && J(d.detected_documents) === J(['packing_list'])
      && d.fields.every(f => !('value' in f)) && d.containers.length === 1 && /^\[claude-opus-5-5 · ai-doc-v3\] packing_list/.test(P.raw_text) && /containers:/.test(P.raw_text)) || J(d);
  });
  await check('v3 detected type: a B/L read in the packing-list slot keeps the requested type, reports doc_type_mismatch and detected_type bill_of_lading (the wrong-slot guard input)', () => {
    const r = X.postProcess(v3Out({ doc_type: 'bill_of_lading' }), 'packing_list', 'ai-doc-v3');
    return (r.doc_type === 'packing_list' && r.detected_type === 'bill_of_lading' && r.ai_detail.detected_type === 'bill_of_lading'
      && r.warnings.some(w => w.code === 'doc_type_mismatch')) || J({ d: r.doc_type, t: r.detected_type });
  });
  await check('parseMessage: v3 accepts doc_type packing_list + containers; v2 refuses packing_list (bad_output); a non-array containers → bad_output', () => {
    const a = X.parseMessage(msgOf(v3Out()), 'ai-doc-v3');
    const b = X.parseMessage(msgOf(v3Out()));
    const c = X.parseMessage(msgOf(v3Out({ containers: 'x' })), 'ai-doc-v3');
    return (a.ok && b.code === 'bad_output' && c.code === 'bad_output') || J({ a: a.code, b: b.code, c: c.code });
  });
  await check('identityName (legacy extractCustomerIdentityName_): labels / address / CR / VAT / NOTIFY dropped, ≤ 16 words', () =>
    (X.identityName('BUYER: AL NOOR EST.\nP.O. BOX 12 RIYADH') === 'AL NOOR EST.' && X.identityName('BUYER: AL NOOR EST.\nKING ROAD 12') === 'AL NOOR EST. KING' && X.identityName('SOLD TO - X CO\nNOTIFY: Y') === 'X CO'
      && X.identityName('ABC LLC CR NO 7000000001') === 'ABC LLC' && X.identityName('') === '' && X.identityName(Array(30).fill('W').join(' ')).split(' ').length === 16) || 'identity');
  await check('a v3 reading is saved with its ai_detail through the API (real ai_reserve / ai_bind_source / ai_settle usage), only under the bound hash', async () => {
    const id = await reserve(A, U.staff);
    const h = sha();
    await as('service', `SELECT public.ai_bind_source($1, $2)`, [id, h]);
    await settle(id, 100, 100, 'ok');
    const ins = x => tryErr(() => as('staff', `INSERT INTO public.document_extractions (org_id, doc_type, source_name, source_sha256, engine, languages, raw_text,
        extracted_fields, line_items, created_by, ai_usage_id, ai_detail) VALUES ($1, 'packing_list', 'pl.pdf', $2, 'claude-opus-5-5', 'auto', $3, $4, $5, $6, $7, $8)`,
      [A, x, P.raw_text, J(P.extracted_fields), J(P.line_items), U.staff, id, J(P.ai_detail)]));
    const other = await ins(sha());
    const r = await ins(h);
    return (/MRS_INVALID/.test(other) && r === 'ok') || J({ other, r });
  });

  // handler: v3 response + dedupe-before-call (the stored reading of the same bytes is returned, nothing reserved / charged)
  const PDF3 = Buffer.from('%PDF-1.7\n%v3 dedupe test\n').toString('base64');
  const SHA3 = require('crypto').createHash('sha256').update(Buffer.from(PDF3, 'base64')).digest('hex');
  const body3 = o => goodBody(Object.assign({ doc_type: 'packing_list', prompt_version: 'ai-doc-v3', file: { media_type: 'application/pdf', data_b64: PDF3 } }, o || {}));
  const stored = o => Object.assign({ id: 'e-1', org_id: A, transaction_id: null, doc_type: 'packing_list', engine: 'claude-opus-5-5', ai_usage_id: 'u-1',
    ai_detail: Object.assign({}, P.ai_detail), extracted_fields: P.extracted_fields, line_items: P.line_items, raw_text: P.raw_text, mean_confidence: 88.5,
    review_status: 'reviewed', source_sha256: SHA3, created_at: '2026-11-10T10:00:00Z' }, o || {});
  // deps whose user client answers the dedupe lookup with `rows` (or an error) and records the filters
  const v3Deps = (rows, o) => {
    const d = hDeps(Object.assign({ msg: msgOf(v3Out()) }, o || {}));
    const base = d.userClient;
    d.lookups = [];
    d.userClient = t => {
      const u = base(t);
      const orig = u.from;
      u.from = table => {
        if (table !== 'document_extractions') return orig(table);
        const f = { table, eq: {}, is: {}, order: null, limit: null };
        d.lookups.push(f);
        const qb = { select: c => { f.cols = c; return qb; }, eq: (k, v) => { f.eq[k] = v; return qb; }, is: (k, v) => { f.is[k] = v; return qb; },
          order: (k, opt) => { f.order = [k, opt]; return qb; }, limit: n => { f.limit = n; return Promise.resolve(rows instanceof Error ? { data: null, error: { message: 'x' } } : { data: rows, error: null }); } };
        return qb;
      };
      return u;
    };
    return d;
  };
  await check('handler v3, no earlier reading: lookup by org + sha256 + not voided BEFORE ai_reserve; the hash bound to the reservation (ai_bind_source) before Claude; the response adds containers, ai_detail, source_sha256, reused:false', async () => {
    const d = v3Deps([]);
    const r = await H.handleRequest(hReq(body3()), d);
    const b = JSON.parse(r.body);
    const order = d.calls.filter(c => !/^log:/.test(c));
    const f = d.lookups[0] || {};
    const u = await one(`SELECT source_sha256 FROM app.ai_usage WHERE id = $1`, [b.usage_id]);
    return (r.status === 200 && J(order) === J(['user:ai_access', 'ai_reserve', 'ai_bind_source', 'claude', 'ai_settle']) && d.lookups.length === 1 && f.eq.org_id === A
      && f.eq.source_sha256 === SHA3 && !('engine' in f.eq) && f.is.voided_at === null && u.source_sha256 === SHA3 && J(b.detected_documents) === J(['packing_list']) && b.prompt_version === 'ai-doc-v3' && b.reused === false
      && b.source_sha256 === SHA3 && b.containers.length === 1 && b.ai_detail.prompt_version === 'ai-doc-v3' && b.kind === 'packing_list'
      && d.params.system === X.SYSTEM_V3) || J({ s: r.status, order, f, keys: Object.keys(b) });
  });
  await check('handler v3, the same file already read and saved: reused:true with extraction_id, NO ai_reserve, NO Claude call, NO charge; fields rebuilt with their confidences', async () => {
    await resetUsage();
    const d = v3Deps([stored()]);
    const r = await H.handleRequest(hReq(body3()), d);
    const b = JSON.parse(r.body);
    const n = (await one(`SELECT count(*)::int n FROM app.ai_usage`)).n;
    const f = b.fields.find(x => x.name === 'packing_list_number');
    return (r.status === 200 && b.reused === true && b.extraction_id === 'e-1' && b.usage_id === 'u-1' && !d.calls.includes('ai_reserve') && !d.calls.includes('claude')
      && n === 0 && b.usage.cost_usd === 0 && f.value === 'PL-77' && f.confidence === 0.95 && b.containers.length === 1 && b.review_status === 'reviewed'
      && d.calls.includes('log:ai-extract: reading reused (no charge)')) || J({ s: r.status, b: Object.keys(b), calls: d.calls, n });
  });
  await check('handler v3 dedupe picks the requested transaction\'s reading, then an unlinked one; a v2 / OCR reading of the same bytes is reused AS ITSELF only in the scope a save would collide with (no charge), else read again with v3', async () => {
    const TXA = '0b5e0000-0000-4000-8000-000000000201';
    const d1 = v3Deps([stored({ id: 'e-other', transaction_id: '0b5e0000-0000-4000-8000-0000000000aa' }), stored({ id: 'e-free' }), stored({ id: 'e-mine', transaction_id: TXA })], { tx: true });
    const b1 = JSON.parse((await H.handleRequest(hReq(body3({ transaction_id: TXA })), d1)).body);
    const d2 = v3Deps([stored({ id: 'e-other', transaction_id: '0b5e0000-0000-4000-8000-0000000000aa' }), stored({ id: 'e-free' })], { tx: true });
    const b2 = JSON.parse((await H.handleRequest(hReq(body3({ transaction_id: TXA })), d2)).body);
    const d3 = v3Deps([stored({ id: 'e-v2', ai_detail: null, transaction_id: '0b5e0000-0000-4000-8000-0000000000aa' }),
      stored({ id: 'e-v2b', ai_detail: { prompt_version: 'ai-doc-v2' }, transaction_id: '0b5e0000-0000-4000-8000-0000000000aa' })]);
    const r3 = await H.handleRequest(hReq(body3()), d3);
    const b3 = JSON.parse(r3.body);
    await resetUsage();
    const d4 = v3Deps([stored({ id: 'e-ocr', engine: 'tesseract.js@5.1.1', ai_usage_id: null, ai_detail: null, doc_type: 'packing_list' })]);
    const b4 = JSON.parse((await H.handleRequest(hReq(body3()), d4)).body);
    const n4 = (await one(`SELECT count(*)::int n FROM app.ai_usage`)).n;
    return (b1.extraction_id === 'e-mine' && b2.extraction_id === 'e-free' && r3.status === 200 && b3.reused === false && d3.calls.includes('claude')
      && b4.reused === true && b4.extraction_id === 'e-ocr' && b4.engine === 'tesseract.js@5.1.1' && b4.prompt_version === null && b4.model === null
      && !d4.calls.includes('ai_reserve') && !d4.calls.includes('claude') && n4 === 0) || J({ b1: b1.extraction_id, b2: b2.extraction_id, b3: b3.reused, b4 });
  });
  await check('handler v3: a failing lookup never blocks the read (it goes ahead and is charged normally); the AI-off / forbidden gates still come first', async () => {
    const d = v3Deps(new Error('down'));
    const r = await H.handleRequest(hReq(body3()), d);
    await saveSettings('admin', A, { enabled: false });
    const d2 = v3Deps([stored()]);
    const r2 = await H.handleRequest(hReq(body3()), d2);
    await enableA();
    return (r.status === 200 && JSON.parse(r.body).reused === false && d.calls.includes('claude') && r2.status === 403 && JSON.parse(r2.body).error === 'ai_disabled'
      && d2.lookups.length === 0) || J({ r: r.status, r2: r2.status, l: d2.lookups.length });
  });
  await check('handler v2 (no prompt_version): no dedupe lookup at all, the v2 response keys unchanged (no containers / ai_detail / reused)', async () => {
    const d = v3Deps([stored()], { msg: msgOf(modelOut()) });
    const r = await H.handleRequest(hReq(goodBody()), d);
    const b = JSON.parse(r.body);
    return (r.status === 200 && d.lookups.length === 0 && b.prompt_version === 'ai-doc-v2' && !('containers' in b) && !('ai_detail' in b) && !('reused' in b)
      && J(Object.keys(b)) === J(['usage_id', 'engine', 'model', 'prompt_version', 'doc_type', 'detected_type', 'kind', 'transaction_id', 'fields',
        'extracted_fields', 'line_items', 'warnings', 'mean_confidence', 'raw_text', 'usage'])) || J(Object.keys(b));
  });
  await check('review: handler v3, the hash cannot be bound → nothing sent to Claude, the reservation settled at no cost (error), 500 internal', async () => {
    await resetUsage();
    const d = v3Deps([], { bindFails: true });
    const r = await H.handleRequest(hReq(body3()), d);
    const u = await one(`SELECT status, cost_usd::float c FROM app.ai_usage ORDER BY created_at DESC LIMIT 1`);
    return (r.status === 500 && JSON.parse(r.body).error === 'internal' && !d.calls.includes('claude') && d.calls.includes('ai_settle')
      && u.status === 'error' && u.c === 0 && d.calls.includes('log:ai-extract: source bind failed')) || J({ r: r.status, calls: d.calls, u });
  });
  await check('review: v3 combined file — detected_documents (main type first, unknown / other dropped) in the result and ai_detail; no doc_type_mismatch when the slot type is in the file', () => {
    const r = X.postProcess(v3Out({ doc_type: 'bill_of_lading', detected_documents: ['commercial_invoice', 'packing_list', 'passport', 'other', 'commercial_invoice'] }), 'packing_list', 'ai-doc-v3');
    const lone = X.postProcess(v3Out({ doc_type: 'bill_of_lading', detected_documents: [] }), 'packing_list', 'ai-doc-v3');
    return (J(r.detected_documents) === J(['bill_of_lading', 'commercial_invoice', 'packing_list']) && J(r.ai_detail.detected_documents) === J(r.detected_documents)
      && !r.warnings.some(w => w.code === 'doc_type_mismatch') && lone.warnings.some(w => w.code === 'doc_type_mismatch')
      && J(lone.detected_documents) === J(['bill_of_lading'])) || J({ r: r.detected_documents, w: r.warnings.map(w => w.code) });
  });
  await check('handler sha256Hex = node crypto SHA-256 of the decoded bytes (the source_sha256 the browser saves)', async () =>
    (await H.sha256Hex(PDF3)) === SHA3);

  await secDeclV3(v3Deps, body3, stored);
  await secOpsV3(v3Deps, body3, stored);
  await secPayV3(v3Deps, body3, stored);
}

/* ai-doc-v3 customs declaration reading (20261120000100 legacy_decl): legacy DocumentAI analyzeDeclarationDocument /
   getDeclarationSchema_ / normalizeDeclarationDraft_ + R11Automation detectDeclarationTypeFromBlobR11_ (mocked Claude) */
const DC1 = 'MSCU3054389', DC2 = 'MSKU9070323';
const declOut = o => Object.assign({ doc_type: 'customs_declaration', detected_documents: ['customs_declaration'], fields: [
  { name: 'declaration_number', value: '3012345', confidence: 0.95, page: 1 }, { name: 'declaration_type', value: 'استيراد', confidence: 0.9, page: 1 },
  { name: 'declaration_status', value: 'تم الفسح', confidence: 0.9, page: 1 }, { name: 'declaration_date_hijri', value: '١٥/٣/١٤٤٧', confidence: 0.9, page: 1 },
  { name: 'declaration_date', value: '2025-09-08', confidence: 0.8, page: 1 }, { name: 'bl_number', value: '123456 MEDU', confidence: 0.7, page: 1 },
  { name: 'importer_name_ar', value: 'شركة   الاختبار الأولى', confidence: 0.9, page: 1 }, { name: 'broker_name', value: 'مكتب التخليص التجريبي', confidence: 0.9, page: 1 },
  { name: 'vessel', value: 'MSC TEST', confidence: 0.9, page: 1 }, { name: 'country_of_origin', value: 'الصين', confidence: 0.9, page: 1 },
  { name: 'total', value: '5,000.00', confidence: 0.9, page: 1 }, { name: 'currency', value: 'usd', confidence: 0.9, page: 1 },
  { name: 'local_value', value: '18,750.00', confidence: 0.9, page: 1 }],
  line_items: [{ description: 'فحمات فرامل', hs_code: '870830', quantity: 40, unit_price: null, amount: 5000, unit: 'كرتون', scientific_name: null,
    origin_country: 'الصين', net_weight: 1000, gross_weight: 1200, packages: null, container_number: null, seal_number: null, notes: null }],
  containers: [{ container_number: DC1, seal_number: 'SL1', size_type: '40HC', packages_count: 40, net_weight: 1000, gross_weight: 1200 },
    { container_number: DC2, seal_number: null, size_type: '20GP', packages_count: null, net_weight: null, gross_weight: null }],
  warnings: [], declaration: { declaration_type_evidence: 'بيان استيراد', bl_candidates: ['MEDU 123456', '123456 MEDU', 'MEDU 123456'], bl_rtl_affected: true } }, o || {});
const setF = (out, name, value) => Object.assign({}, out, { fields: out.fields.filter(f => f.name !== name).concat(value == null ? [] : [{ name, value, confidence: 0.9, page: 1 }]) });
async function secDeclV3(v3Deps, body3, stored) {
  section('7f. prompt ai-doc-v3 customs declaration: type from the title, Fasah stage, Hijri → Gregorian (Umm al-Qura), B/L candidates + RTL, items (mocked Claude)');
  const V2_DECL_KEYS = ['declaration_number', 'bl_number', 'container_numbers', 'hs_codes', 'country_of_origin', 'invoice_number', 'invoice_date', 'currency',
    'total', 'vat_amount', 'vessel', 'port_of_loading', 'port_of_discharge', 'consignee', 'shipper', 'gross_weight', 'net_weight', 'packages_count'];
  await check('keys: DECL_KEYS (8) are the tail of ALL_KEYS_V3; v3 customs_declaration asks them; the v2 customs_declaration key list is unchanged', () =>
    (J(X.DECL_KEYS) === J(['declaration_type', 'declaration_status', 'declaration_date', 'declaration_date_hijri', 'importer_name_ar', 'broker_name', 'local_value', 'payment_method'])
      && J(X.ALL_KEYS_V3.slice(42, 50)) === J(X.DECL_KEYS) && X.DECL_KEYS.every(k => X.KEYS_FOR_V3.customs_declaration.includes(k) && X.KEYS_FOR_V3.auto.includes(k))
      && J(X.KEYS_FOR.customs_declaration) === J(V2_DECL_KEYS) && !X.DECL_KEYS.some(k => X.KEYS_FOR_V3.packing_list.includes(k) || X.KEYS_FOR_V3.bill_of_lading.includes(k))) || J(X.KEYS_FOR_V3.customs_declaration));
  await check('buildRequest v2 customs_declaration is unchanged by step 4 (no declaration object in the schema, no RTL / candidates hint, same keys)', () => {
    const p = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'customs_declaration' })));
    const sc = p.output_config.format.schema, t = p.messages[0].content[1].text;
    return (!('declaration' in sc.properties) && J(sc.required) === J(['doc_type', 'fields', 'line_items', 'warnings']) && J(sc.properties.fields.items.properties.name.enum) === J(V2_DECL_KEYS)
      && !/bl_candidates|بيان استيراد|EXACTLY as printed/.test(t) && p.system === X.SYSTEM) || t;
  });
  await check('buildRequest v3 customs_declaration: the same SDK call shape; schema + declaration {declaration_type_evidence, bl_candidates, bl_rtl_affected} (required, strict); the title / RTL / all-containers rules in the prompt', () => {
    const p = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'customs_declaration', prompt_version: 'ai-doc-v3' })));
    const sc = p.output_config.format.schema, t = p.messages[0].content[1].text, dd = sc.properties.declaration;
    const auto = X.outputSchema('auto', 'ai-doc-v3'), pl = X.outputSchema('packing_list', 'ai-doc-v3');
    return (p.model === 'claude-opus-5-5' && p.output_config.effort === 'medium' && p.fallbacks === 'default' && J(p.betas) === J(['server-side-fallback-2026-07-01'])
      && p.output_config.format.type === 'json_schema' && !('thinking' in p) && sc.required.includes('declaration') && dd.additionalProperties === false
      && J(dd.required) === J(['declaration_type_evidence', 'bl_candidates', 'bl_rtl_affected']) && dd.properties.bl_rtl_affected.type === 'boolean'
      && /«بيان استيراد» is\nimport|«بيان استيراد» is/.test(t) && /Never infer the type/.test(t) && /never only the first/.test(t) && /bl_rtl_affected true/.test(t)
      && /- bl_number: bill of lading number EXACTLY as printed/.test(t) && /- declaration_date_hijri: /.test(t) && 'declaration' in auto.properties && !('declaration' in pl.properties)) || t;
  });
  let R;
  await check('postProcess: type kept (title evidence agrees) as a code; تم الفسح → released; Hijri ١٥/٣/١٤٤٧ → 1447/03/15; the Gregorian date RECOMPUTED (2025-09-08 → 2025-09-07, decl_date_corrected)', () => {
    R = X.postProcess(declOut(), 'customs_declaration', 'ai-doc-v3');
    const e = R.extracted_fields;
    return (e.declaration_type === 'import' && e.declaration_status === 'released' && e.declaration_date_hijri === '1447/03/15' && e.declaration_date === '2025-09-07'
      && R.warnings.some(w => w.code === 'decl_date_corrected' && /2025-09-08/.test(w.text)) && R.declaration.date_printed === '2025-09-08'
      && R.declaration.date_from_hijri === '2025-09-07' && R.declaration.status_raw === 'تم الفسح' && R.declaration.type_read === 'استيراد') || J({ e, d: R.declaration });
  });
  await check('postProcess: the B/L stays EXACTLY as printed; candidates (printed first, each once); RTL flag → bl_rtl warning; importer / broker / local value cleaned; all containers kept', () => {
    const e = R.extracted_fields, d = R.declaration;
    return (e.bl_number === '123456 MEDU' && J(d.bl_candidates) === J(['123456 MEDU', 'MEDU 123456']) && d.bl_raw === '123456 MEDU' && d.bl_rtl_affected === true
      && R.warnings.some(w => w.code === 'bl_rtl') && e.importer_name_ar === 'شركة الاختبار الأولى' && e.local_value === '18750' && e.currency === 'USD'
      && R.containers.length === 2 && e.container_numbers === DC1 + ', ' + DC2 && R.line_items[0].hs_code === '870830' && R.line_items[0].amount === 5000
      && R.line_items[0].description === 'فحمات فرامل' && !R.warnings.some(w => w.code === 'decl_no_containers')) || J({ e, d, w: R.warnings });
  });
  await check('postProcess: the type is dropped (decl_type_unverified) when the title evidence is missing or names another type; evidence alone gives the type', () => {
    const a = X.postProcess(declOut({ declaration: { declaration_type_evidence: null, bl_candidates: [], bl_rtl_affected: false } }), 'customs_declaration', 'ai-doc-v3');
    const b = X.postProcess(declOut({ declaration: { declaration_type_evidence: 'بيان تصدير', bl_candidates: [], bl_rtl_affected: false } }), 'customs_declaration', 'ai-doc-v3');
    const c = X.postProcess(setF(declOut({ declaration: { declaration_type_evidence: 'بيان تصفية', bl_candidates: [], bl_rtl_affected: false } }), 'declaration_type', null), 'customs_declaration', 'ai-doc-v3');
    return (!('declaration_type' in a.extracted_fields) && a.warnings.some(w => w.code === 'decl_type_unverified') && !('declaration_type' in b.extracted_fields)
      && b.warnings.some(w => w.code === 'decl_type_unverified') && c.extracted_fields.declaration_type === 'clearance') || J({ a: a.extracted_fields, b: b.extracted_fields, c: c.extracted_fields });
  });
  await check('postProcess: an unknown status is dropped (decl_status_unknown, the raw text kept in declaration.status_raw); a bad Hijri date → hijri_format, the printed Gregorian kept', () => {
    const a = X.postProcess(setF(declOut(), 'declaration_status', 'قيد المعالجة الخاصة'), 'customs_declaration', 'ai-doc-v3');
    const b = X.postProcess(setF(declOut(), 'declaration_date_hijri', '1447/13/40'), 'customs_declaration', 'ai-doc-v3');
    return (!('declaration_status' in a.extracted_fields) && a.warnings.some(w => w.code === 'decl_status_unknown') && a.declaration.status_raw === 'قيد المعالجة الخاصة'
      && !('declaration_date_hijri' in b.extracted_fields) && b.warnings.some(w => w.code === 'hijri_format') && b.extracted_fields.declaration_date === '2025-09-08'
      && b.declaration.date_from_hijri === null) || J({ a: a.extracted_fields, b: b.extracted_fields });
  });
  await check('postProcess: a Hijri date the Umm al-Qura month does not have (30 Safar 1447) → hijri_unverified, the printed date kept; no container → decl_no_containers', () => {
    const a = X.postProcess(setF(declOut({ containers: [] }), 'declaration_date_hijri', '1447/02/30'), 'customs_declaration', 'ai-doc-v3');
    return (a.extracted_fields.declaration_date_hijri === '1447/02/30' && a.extracted_fields.declaration_date === '2025-09-08' && a.warnings.some(w => w.code === 'hijri_unverified')
      && a.warnings.some(w => w.code === 'decl_no_containers')) || J({ e: a.extracted_fields, w: a.warnings.map(w => w.code) });
  });
  await check('ai_detail carries declaration {type_evidence, type_read, status_raw, bl_raw, bl_candidates, bl_rtl_affected, date_printed, date_from_hijri, hijri_supported} (no field values); raw_text has a declaration block', () =>
    (J(Object.keys(R.ai_detail)) === J(['prompt_version', 'detected_type', 'doc_type', 'detected_documents', 'containers', 'fields', 'warnings', 'declaration'])
      && J(Object.keys(R.ai_detail.declaration)) === J(['type_evidence', 'type_read', 'status_raw', 'bl_raw', 'bl_candidates', 'bl_rtl_affected', 'date_printed', 'date_from_hijri', 'hijri_supported'])
      && R.ai_detail.fields.every(f => !('value' in f)) && /\ndeclaration:\n/.test(R.raw_text) && /B\/L candidates: 123456 MEDU \| MEDU 123456  \(RTL\)/.test(R.raw_text)) || J(Object.keys(R.ai_detail)));
  await check('the saved reading passes the database checks (extraction_field_keys + extraction_detail_ok of 20261120000100)', async () => {
    const r = await one(`SELECT app.extraction_fields_ok($1) f, app.extraction_detail_ok($2) d`, [J(R.extracted_fields), J(R.ai_detail)]);
    return (r.f === true && r.d === true) || J(r);
  });
  await check('v3 non-declaration readings: the declaration keys are dropped (auto read as an invoice); a combined file that contains a declaration keeps them; v2 never has a declaration object', () => {
    const inv = X.postProcess(declOut({ doc_type: 'commercial_invoice', detected_documents: ['commercial_invoice'] }), 'auto', 'ai-doc-v3');
    const comb = X.postProcess(declOut({ doc_type: 'commercial_invoice', detected_documents: ['commercial_invoice', 'customs_declaration'] }), 'auto', 'ai-doc-v3');
    const v2 = X.postProcess(declOut(), 'customs_declaration');
    return (!X.DECL_KEYS.some(k => k in inv.extracted_fields) && !inv.declaration && !('declaration' in inv.ai_detail)
      && comb.extracted_fields.declaration_status === 'released' && comb.declaration && !v2.declaration && !('ai_detail' in v2) && !('declaration_status' in v2.extracted_fields)) || J({ inv: inv.extracted_fields, comb: comb.extracted_fields });
  });
  await check('parseMessage v3: a declaration object of the wrong shape → bad_output; the good one parses', () => {
    const ok = X.parseMessage(msgOf(declOut()), 'ai-doc-v3');
    const bad = [{ bl_candidates: 'x', bl_rtl_affected: false, declaration_type_evidence: null }, { bl_candidates: [], bl_rtl_affected: 'yes', declaration_type_evidence: null },
      { bl_candidates: [], bl_rtl_affected: false, declaration_type_evidence: 7 }, ['x']].map(dd => X.parseMessage(msgOf(declOut({ declaration: dd })), 'ai-doc-v3').code);
    return (ok.ok && bad.every(c => c === 'bad_output')) || J({ ok: ok.code, bad });
  });
  await check('handler v3 customs_declaration (mocked Claude, real ai_reserve / ai_bind_source / ai_settle): the response adds declaration + ai_detail.declaration; same quota / bind order as step 3', async () => {
    const d = v3Deps([], { msg: msgOf(declOut()) });
    const r = await H.handleRequest(hReq(body3({ doc_type: 'customs_declaration' })), d);
    const b = JSON.parse(r.body);
    const order = d.calls.filter(c => !/^log:/.test(c));
    return (r.status === 200 && J(order) === J(['user:ai_access', 'ai_reserve', 'ai_bind_source', 'claude', 'ai_settle']) && b.kind === 'customs_declaration'
      && b.declaration && J(b.declaration.bl_candidates) === J(['123456 MEDU', 'MEDU 123456']) && b.ai_detail.declaration.bl_rtl_affected === true
      && b.extracted_fields.declaration_date === '2025-09-07' && 'declaration' in d.params.output_config.format.schema.properties && d.params.model === 'claude-opus-5-5') || J({ s: r.status, order, b: Object.keys(b) });
  });
  await check('handler v3 customs_declaration reused: the stored reading\'s declaration detail comes back (no charge); a packing-list reading → declaration null', async () => {
    const det = Object.assign({}, R.ai_detail);
    const d = v3Deps([stored({ doc_type: 'customs_declaration', ai_detail: det, extracted_fields: R.extracted_fields })]);
    const b = JSON.parse((await H.handleRequest(hReq(body3({ doc_type: 'customs_declaration' })), d)).body);
    const d2 = v3Deps([]);
    const b2 = JSON.parse((await H.handleRequest(hReq(body3()), d2)).body);
    return (b.reused === true && !d.calls.includes('claude') && b.declaration && b.declaration.status_raw === 'تم الفسح' && b2.declaration === null) || J({ b: b.declaration, b2: b2.declaration });
  });
}

/* appointment card / EIR readings (20261121000100) */
const OPS_TX = '0b5e0000-0000-4000-8000-000000000201';
const OC1 = 'CSQU3054383';
const cardOut = o => Object.assign({ doc_type: 'appointment_ticket', document_title: 'Appointment Confirmation Ticket', invoice_signals: [],
  fields: [{ name: 'appointment_booking_ref', value: 'TAS - 2026 1115 0042', confidence: 0.95, page: null },
    { name: 'appointment_ticket_no', value: 'op 7781', confidence: 0.9, page: null }, { name: 'appointment_operator', value: 'Test Terminal Operator', confidence: 0.9, page: null },
    { name: 'appointment_at', value: '15/11/2026 02:30 PM', confidence: 0.93, page: null }, { name: 'vehicle_plate', value: 'أ ب ج - ١٢٣٤', confidence: 0.8, page: null },
    { name: 'driver_name', value: 'Test Driver', confidence: 0.9, page: null }, { name: 'driver_phone', value: '+966 5X'.replace('X', '00000001'), confidence: 0.9, page: null },
    { name: 'appointment_zone_gate', value: 'Zone B / Gate 4', confidence: 0.8, page: null }, { name: 'appointment_barcode', value: 'BC 0099', confidence: 0.7, page: null },
    { name: 'appointment_movement_type', value: 'empty_entry', confidence: 0.6, page: null }],
  entry: { location: null, bl_number: null, declaration_number: null, container_number: null, cargo_type: null, purpose: null },
  exit: { location: 'Terminal 1', bl_number: 'medu 123456', declaration_number: '3012345', container_number: 'csqu 305438-3', cargo_type: 'FCL', purpose: 'Import' },
  warnings: [] }, o || {});
const eirOut = o => Object.assign({ doc_type: 'empty_return_receipt', document_title: 'EIR', movement: 'empty_return', time_printed: true,
  fields: [{ name: 'container_numbers', value: 'CSQU 3054383', confidence: 0.96, page: null },
    { name: 'return_delivered_at', value: '2026-11-16 09:15', confidence: 0.82, page: null }, { name: 'return_depot', value: 'Test Empty Depot', confidence: 0.9, page: null }],
  warnings: [] }, o || {});
async function secOpsV3(v3Deps, body3, stored) {
  section('7g. ai-doc-v3 appointment card + empty-return receipt (EIR): schemas, normalisation, structure check, wrong document type (mocked Claude)');
  await check('exports: OPS_TYPES are v3 doc types only; ALL_KEYS_V3 = the 50 shipment keys + APPT_KEYS (14) + EIR_KEYS (2); auto keeps the 50; kinds appointment / empty_return_receipt', () =>
    (J(X.OPS_TYPES) === J(['appointment_ticket', 'empty_return_receipt']) && X.OPS_TYPES.every(t => X.DOC_TYPES_V3.includes(t) && !X.DOC_TYPES.includes(t))
      && J(X.ALL_KEYS_V3.slice(50)) === J(X.APPT_KEYS.concat(X.EIR_KEYS)) && X.APPT_KEYS.length === 14 && X.EIR_KEYS.length === 2
      && J(X.KEYS_FOR_V3.auto) === J(X.SHIP_KEYS_V3) && X.KIND_OF.appointment_ticket === 'appointment' && X.KIND_OF.empty_return_receipt === 'empty_return_receipt'
      && !X.APPT_KEYS.some(k => X.KEYS_FOR_V3.bill_of_lading.includes(k))) || 'exports');
  await check('validateRequest: appointment_ticket / empty_return_receipt only with ai-doc-v3; a card needs transaction_id (transaction_required); an EIR above 8 MB → too_large', () => {
    const t = b => { try { const v = X.validateRequest(b); return v.prompt_version + ':' + v.doc_type; } catch (e) { return e.code; } };
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(8.5 * 1024 * 1024, 32)]).toString('base64');
    const r = [t(goodBody({ doc_type: 'appointment_ticket' })), t(goodBody({ doc_type: 'appointment_ticket', prompt_version: 'ai-doc-v3' })),
      t(goodBody({ doc_type: 'appointment_ticket', prompt_version: 'ai-doc-v3', transaction_id: OPS_TX })), t(goodBody({ doc_type: 'empty_return_receipt', prompt_version: 'ai-doc-v3' })),
      t(goodBody({ doc_type: 'empty_return_receipt', prompt_version: 'ai-doc-v3', file: { media_type: 'application/pdf', data_b64: big } })),
      t(goodBody({ doc_type: 'packing_list', prompt_version: 'ai-doc-v3', file: { media_type: 'application/pdf', data_b64: big } }))];
    return J(r) === J(['bad_request', 'transaction_required', 'ai-doc-v3:appointment_ticket', 'ai-doc-v3:empty_return_receipt', 'too_large', 'ai-doc-v3:packing_list']) || J(r);
  });
  await check('buildRequest card: the same SDK call shape (model, effort, max_tokens, betas, fallbacks, json_schema, no thinking); SYSTEM_OPS; strict schema with entry / exit / invoice_signals; the invoice and never-guess rules', () => {
    const p = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'appointment_ticket', prompt_version: 'ai-doc-v3', transaction_id: OPS_TX })));
    const sc = p.output_config.format.schema, t = p.messages[0].content[1].text;
    return (p.model === 'claude-opus-5-5' && p.max_tokens === 16000 && p.output_config.effort === 'medium' && p.fallbacks === 'default'
      && J(p.betas) === J(['server-side-fallback-2026-07-01']) && p.output_config.format.type === 'json_schema' && !('thinking' in p) && p.system === X.SYSTEM_OPS
      && p.system.startsWith(X.SYSTEM) && J(sc.required) === J(['doc_type', 'document_title', 'invoice_signals', 'fields', 'entry', 'exit', 'warnings'])
      && J(sc.properties.doc_type.enum) === J(X.OPS_DETECTED) && J(sc.properties.exit.required) === J(X.APPT_SECTION_KEYS)
      && J(sc.properties.fields.items.properties.name.enum) === J(X.KEYS_FOR_V3.appointment_ticket) && /appointment_invoice even when it shows an Appointment No/.test(t)
      && /Never guess the customer destination, the transport price/.test(t) && /- appointment_at: the appointment date AND time/.test(t)
      && p.messages[0].content[0].type === 'image' && !/containers \(one row/.test(t)) || t;
  });
  await check('buildRequest EIR: strict schema {doc_type, document_title, movement, time_printed, fields, warnings}; the empty-return / date-only rule', () => {
    const p = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'empty_return_receipt', prompt_version: 'ai-doc-v3' })));
    const sc = p.output_config.format.schema, t = p.messages[0].content[1].text;
    return (J(sc.required) === J(['doc_type', 'document_title', 'movement', 'time_printed', 'fields', 'warnings']) && sc.properties.time_printed.type === 'boolean'
      && J(sc.properties.movement.enum) === J(['empty_return', 'full_out', 'other']) && J(sc.properties.fields.items.properties.name.enum) === J(['container_numbers', 'return_delivered_at', 'return_depot'])
      && /give the date only and set time_printed false/.test(t) && /EMPTY container delivered/.test(t) && p.system === X.SYSTEM_OPS) || t;
  });
  let C;
  await check('postProcess card: TAS ref normalised, local time → +03:00, plate / phone (05…) normalised, full_exit from the Exit section (model said empty_entry: corrected), container ISO 6346, structure ok, not rejected', () => {
    C = X.postProcess(cardOut(), 'appointment_ticket', 'ai-doc-v3');
    const a = C.appointment, e = C.extracted_fields;
    return (C.rejected === null && C.kind === 'appointment' && C.doc_type === 'appointment_ticket' && a.booking_ref === 'TAS20261115' + '0042' && a.operator_ticket_no === 'OP7781'
      && a.appointment_at === '2026-11-15T14:30:00+03:00' && a.appointment_local === '2026-11-15T14:30' && a.driver_phone === '0500000001' && a.truck_plate === 'ابج1234'
      && a.movement_type === 'full_exit' && a.container_no === OC1 && a.exit.container_number === OC1 && a.exit.bl_number === 'MEDU123456' && a.structural.ok === true
      && a.structural.signals >= 3 && e.appointment_movement_type === 'full_exit' && e.container_numbers === OC1 && e.declaration_number === '3012345'
      && C.warnings.some(w => w.code === 'movement_type_corrected') && C.line_items.length === 0 && C.ai_detail.appointment && /\nappointment:\n/.test(C.raw_text)) || J({ a: C.appointment, e: C.extracted_fields, r: C.rejected });
  });
  await check('the saved card reading passes the database checks (extraction_field_keys + extraction_detail_ok of 20261121000100); a bad detail is refused', async () => {
    const r = await one(`SELECT app.extraction_fields_ok($1) f, app.extraction_detail_ok($2) d, app.extraction_detail_ok($3) bad1, app.extraction_detail_ok($4) bad2`,
      [J(C.extracted_fields), J(C.ai_detail), J(Object.assign({}, C.ai_detail, { appointment: { movement_type: 'sideways' } })),
        J(Object.assign({}, C.ai_detail, { appointment: { entry: { x: 1 } } }))]);
    return (r.f === true && r.d === true && r.bad1 === false && r.bad2 === false) || J(r);
  });
  await check('postProcess card: gate instructions, driver licence, vehicle ref / serial IDs read (legacy getAppointmentSchema_) and kept in the detail; a vehicle ID alone is an operational signal; the fields pass the database keys', async () => {
    const o = cardOut(); o.fields = o.fields.concat([{ name: 'appointment_gate_instructions', value: '  Gate 4 only ', confidence: 0.9, page: 1 },
      { name: 'driver_license', value: 'L 55', confidence: 0.9, page: 1 }, { name: 'vehicle_ref_id', value: 'vr 1', confidence: 0.9, page: 1 }, { name: 'vehicle_serial_id', value: 's-2', confidence: 0.9, page: 1 }]);
    const R = X.postProcess(o, 'appointment_ticket', 'ai-doc-v3'), a = R.appointment;
    const only = cardOut({ fields: cardOut().fields.filter(f => ['appointment_booking_ref', 'appointment_at'].includes(f.name)).concat([{ name: 'vehicle_serial_id', value: 'S9', confidence: 0.9, page: 1 }]),
      exit: { location: 'T1', bl_number: 'B1', declaration_number: null, container_number: null, cargo_type: null, purpose: null } });
    const R2 = X.postProcess(only, 'appointment_ticket', 'ai-doc-v3');
    const db = await one(`SELECT app.extraction_fields_ok($1) f, app.extraction_detail_ok($2) d`, [J(R.extracted_fields), J(R.ai_detail)]);
    const p = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'appointment_ticket', prompt_version: 'ai-doc-v3', transaction_id: OPS_TX })));
    const en = p.output_config.format.schema.properties.fields.items.properties.name.enum;
    return (a.gate_instructions === 'Gate 4 only' && a.driver_license === 'L55' && a.vehicle_ref_id === 'VR1' && a.vehicle_serial_id === 'S-2'
      && R.extracted_fields.vehicle_ref_id === 'VR1' && R2.rejected === null && R2.appointment.structural.ok === true && db.f === true && db.d === true
      && ['appointment_gate_instructions', 'driver_license', 'vehicle_ref_id', 'vehicle_serial_id'].every(k => en.includes(k)) && p.model === 'claude-opus-5-5')
      || J({ a, r2: R2.rejected, db });
  });
  await check('postProcess card rejections: an appointment INVOICE (doc_type or invoice signals), another document, no time / no booking ref / no operational signal → wrong_document_type with the reason', () => {
    const rs = [X.postProcess(cardOut({ doc_type: 'appointment_invoice' }), 'appointment_ticket', 'ai-doc-v3'),
      X.postProcess(cardOut({ invoice_signals: ['Internal Invoice No', 'VAT'] }), 'appointment_ticket', 'ai-doc-v3'),
      X.postProcess(cardOut({ doc_type: 'bill_of_lading' }), 'appointment_ticket', 'ai-doc-v3'),
      X.postProcess(cardOut({ fields: cardOut().fields.map(f => f.name === 'appointment_at' ? Object.assign({}, f, { value: '2026-11-15' }) : f) }), 'appointment_ticket', 'ai-doc-v3'),
      X.postProcess(cardOut({ fields: cardOut().fields.filter(f => f.name !== 'appointment_booking_ref') }), 'appointment_ticket', 'ai-doc-v3'),
      X.postProcess(cardOut({ fields: cardOut().fields.filter(f => ['appointment_booking_ref', 'appointment_at'].includes(f.name)),
        exit: { location: 'T1', bl_number: 'B1', declaration_number: null, container_number: null, cargo_type: null, purpose: null } }), 'appointment_ticket', 'ai-doc-v3')];
    const got = rs.map(r => r.rejected && r.rejected.code + ':' + r.rejected.reason);
    return (J(got) === J(['wrong_document_type:appointment_invoice', 'wrong_document_type:appointment_invoice', 'wrong_document_type:not_appointment_ticket',
      'wrong_document_type:not_ticket_structure', 'wrong_document_type:not_ticket_structure', 'wrong_document_type:not_ticket_structure'])
      && rs[3].appointment.structural.reason === 'no_time' && rs[3].warnings.some(w => w.code === 'appointment_time_missing') && rs[4].appointment.structural.reason === 'no_booking_ref'
      && rs[5].appointment.structural.reason === 'no_operational_signal') || J(got);
  });
  await check('postProcess card: entry data only → empty_entry (the entry container); a bad phone → kept invalid with phone_format; a bad container → null + container_check_digit', () => {
    const a = X.postProcess(cardOut({ exit: { location: null, bl_number: null, declaration_number: null, container_number: null, cargo_type: null, purpose: null },
      entry: { location: 'Depot', bl_number: null, declaration_number: null, container_number: OC1, cargo_type: 'MT', purpose: 'Return' } }), 'appointment_ticket', 'ai-doc-v3');
    const b = X.postProcess(cardOut({ fields: cardOut().fields.map(f => f.name === 'driver_phone' ? Object.assign({}, f, { value: '12345' }) : f),
      exit: Object.assign({}, cardOut().exit, { container_number: 'CSQU3054384' }) }), 'appointment_ticket', 'ai-doc-v3');
    const ph = b.fields.find(f => f.name === 'driver_phone');
    return (a.appointment.movement_type === 'empty_entry' && a.appointment.container_no === OC1 && a.rejected === null && b.appointment.driver_phone === null
      && ph.valid === false && b.warnings.some(w => w.code === 'phone_format') && b.appointment.exit.container_number === null && b.warnings.some(w => w.code === 'container_check_digit')
      && b.appointment.movement_type === 'full_exit') || J({ a: a.appointment, b: b.appointment });
  });
  await check('postProcess EIR: container, delivered_at with +03:00, depot, confidence = the lowest field confidence; passes the database checks', async () => {
    const E = X.postProcess(eirOut(), 'empty_return_receipt', 'ai-doc-v3');
    const r = await one(`SELECT app.extraction_fields_ok($1) f, app.extraction_detail_ok($2) d`, [J(E.extracted_fields), J(E.ai_detail)]);
    const e = E.empty_return;
    return (E.rejected === null && E.kind === 'empty_return_receipt' && e.container_no === OC1 && e.delivered_at === '2026-11-16T09:15:00+03:00' && e.delivery_date === '2026-11-16'
      && e.time_printed === true && e.depot === 'Test Empty Depot' && e.confidence === 0.82 && e.movement === 'empty_return' && E.extracted_fields.return_delivered_at === '2026-11-16T09:15'
      && r.f === true && r.d === true && /\nempty return:\n/.test(E.raw_text)) || J({ e, r });
  });
  await check('postProcess EIR: a date without a time (or time_printed false) is never a complete proof (delivered_at null, eir_time_missing); full_out / another document → wrong_document_type; a bad container → null', () => {
    const a = X.postProcess(eirOut({ fields: eirOut().fields.map(f => f.name === 'return_delivered_at' ? Object.assign({}, f, { value: '16/11/2026' }) : f) }), 'empty_return_receipt', 'ai-doc-v3');
    const b = X.postProcess(eirOut({ time_printed: false }), 'empty_return_receipt', 'ai-doc-v3');
    const c = X.postProcess(eirOut({ movement: 'full_out' }), 'empty_return_receipt', 'ai-doc-v3');
    const d = X.postProcess(eirOut({ doc_type: 'appointment_ticket' }), 'empty_return_receipt', 'ai-doc-v3');
    const e = X.postProcess(eirOut({ fields: [{ name: 'container_numbers', value: 'CSQU3054384', confidence: 0.9, page: null }] }), 'empty_return_receipt', 'ai-doc-v3');
    return (a.empty_return.delivered_at === null && a.empty_return.delivery_date === '2026-11-16' && a.warnings.some(w => w.code === 'eir_time_missing')
      && a.fields.find(f => f.name === 'return_delivered_at').valid === false && b.empty_return.delivered_at === null && b.empty_return.time_printed === false
      && c.rejected.reason === 'not_empty_return' && d.rejected.reason === 'not_empty_return_receipt' && e.empty_return.container_no === null
      && e.empty_return.confidence === 0 && e.warnings.some(w => w.code === 'container_check_digit')) || J({ a: a.empty_return, b: b.empty_return, c: c.rejected, d: d.rejected });
  });
  await check('parseMessage (doc type given): the card / EIR shape is checked (bad section / movement / time_printed → bad_output); the v3 shipment shape is not required', () => {
    const ok1 = X.parseMessage(msgOf(cardOut()), 'ai-doc-v3', 'appointment_ticket').ok, ok2 = X.parseMessage(msgOf(eirOut()), 'ai-doc-v3', 'empty_return_receipt').ok;
    const bad = [X.parseMessage(msgOf(cardOut({ exit: { location: 5 } })), 'ai-doc-v3', 'appointment_ticket').code,
      X.parseMessage(msgOf(cardOut({ doc_type: 'ticket' })), 'ai-doc-v3', 'appointment_ticket').code,
      X.parseMessage(msgOf(eirOut({ time_printed: 'yes' })), 'ai-doc-v3', 'empty_return_receipt').code,
      X.parseMessage(msgOf(cardOut()), 'ai-doc-v3').code];
    return (ok1 && ok2 && bad.every(c => c === 'bad_output')) || J({ ok1, ok2, bad });
  });
  const bodyC = o => body3(Object.assign({ doc_type: 'appointment_ticket', transaction_id: OPS_TX }, o || {}));
  await check('handler card (mocked Claude, real ai_reserve / ai_bind_source / ai_settle): 200 with appointment + ai_detail.appointment, kind appointment; one reserve per call', async () => {
    const d = v3Deps([], { msg: msgOf(cardOut()), tx: true });
    const r = await H.handleRequest(hReq(bodyC()), d);
    const b = JSON.parse(r.body);
    const order = d.calls.filter(c => !/^log:/.test(c));
    const u = await usageRow(b.usage_id);
    return (r.status === 200 && J(order) === J(['user:ai_access', 'ai_reserve', 'ai_bind_source', 'claude', 'ai_settle']) && b.kind === 'appointment'
      && b.appointment && b.appointment.booking_ref === 'TAS202611150042' && b.ai_detail.appointment.movement_type === 'full_exit' && b.empty_return === null
      && b.declaration === null && u.status === 'ok' && d.params.system === X.SYSTEM_OPS) || J({ s: r.status, order, keys: Object.keys(b) });
  });
  await check('handler card: a Fasah appointment INVOICE → 422 wrong_document_type (reason appointment_invoice); the call is still settled (ok, billed); nothing to save', async () => {
    const d = v3Deps([], { msg: msgOf(cardOut({ doc_type: 'appointment_invoice' })), tx: true });
    const r = await H.handleRequest(hReq(bodyC()), d);
    const b = JSON.parse(r.body);
    const u = await usageRow(b.usage_id);
    return (r.status === 422 && b.error === 'wrong_document_type' && b.reason === 'appointment_invoice' && b.detected_type === 'appointment_invoice' && !('fields' in b)
      && d.calls.includes('ai_settle') && u.status === 'ok') || J({ s: r.status, b });
  });
  await check('handler card without transaction_id → 400 transaction_required before any reserve; EIR → 200 with empty_return', async () => {
    const d = v3Deps([]);
    const r = await H.handleRequest(hReq(body3({ doc_type: 'appointment_ticket' })), d);
    const d2 = v3Deps([], { msg: msgOf(eirOut()) });
    const r2 = await H.handleRequest(hReq(body3({ doc_type: 'empty_return_receipt' })), d2);
    const b2 = JSON.parse(r2.body);
    return (r.status === 400 && JSON.parse(r.body).error === 'transaction_required' && !d.calls.includes('ai_reserve') && r2.status === 200
      && b2.kind === 'empty_return_receipt' && b2.empty_return.delivered_at === '2026-11-16T09:15:00+03:00' && b2.appointment === null) || J({ s: r.status, s2: r2.status, b2: Object.keys(b2) });
  });
  await check('handler reuse: a stored reading of the same file but another kind (packing list) is NOT served for a card read (Claude called); a stored card reading is (no charge, appointment restored)', async () => {
    const d = v3Deps([stored()], { msg: msgOf(cardOut()), tx: true });
    const b = JSON.parse((await H.handleRequest(hReq(bodyC()), d)).body);
    const det = Object.assign({}, C.ai_detail);
    const d2 = v3Deps([stored({ doc_type: 'appointment', ai_detail: det, extracted_fields: C.extracted_fields, transaction_id: OPS_TX })], { tx: true });
    const b2 = JSON.parse((await H.handleRequest(hReq(bodyC()), d2)).body);
    return (d.calls.includes('claude') && b.reused === false && b2.reused === true && !d2.calls.includes('claude') && !d2.calls.includes('ai_reserve')
      && b2.appointment && b2.appointment.container_no === OC1 && b2.kind === 'appointment') || J({ b: b.reused, b2: b2.reused, c: d2.calls });
  });
}

/* payment documents (20261122000100 legacy_pay): the entity invoice (Fasah TAS appointment invoice) and the payment proof,
   plus the client merge / fill-empty helper assets/js/fin/pay-ai.js */
const PAYAI = require(path.join(ROOT, 'assets', 'js', 'fin', 'pay-ai.js'));
const PC1 = 'CSQU3054383';
const invOut = o => Object.assign({ doc_type: 'appointment_invoice', document_title: 'TAS Appointments invoice', is_fasah_appointment: true,
  component_amounts: [{ page: 1, amount_after_vat: 34.5 }, { page: 2, amount_after_vat: 19.55 }],
  fields: [{ name: 'issuer_name', value: 'Tabadul Test Issuer', confidence: 0.9, page: 1 }, { name: 'invoice_number', value: 'FP00123456', confidence: 0.8, page: 1 },
    { name: 'reference_no', value: '260809154618646', confidence: 0.95, page: 1 }, { name: 'internal_invoice_no', value: 'FP00123456', confidence: 0.9, page: 1 },
    { name: 'appointment_no', value: '\u200f20260811122969874TAS', confidence: 0.9, page: 1 }, { name: 'payment_date', value: '11/08/2026', confidence: 0.9, page: 1 },
    { name: 'invoice_date', value: '2026-08-10', confidence: 0.9, page: 1 }, { name: 'total', value: '34.50', confidence: 0.7, page: 1 },
    { name: 'container_numbers', value: 'csqu 305438-3', confidence: 0.9, page: 1 }, { name: 'bl_number', value: '--', confidence: 0.5, page: 1 }],
  warnings: [] }, o || {});
const proofOut = o => Object.assign({ doc_type: 'payment_proof', document_title: 'Payment receipt',
  fields: [{ name: 'beneficiary_name', value: 'SADAD', confidence: 0.8, page: null }, { name: 'payment_method', value: 'سداد', confidence: 0.9, page: null },
    { name: 'sadad_number', value: '٧٧١ 234', confidence: 0.9, page: null }, { name: 'bank_reference', value: 'SA0380000000608010167519', confidence: 0.6, page: null },
    { name: 'iban', value: 'SA03 8000 0000 6080 1016 7519', confidence: 0.9, page: null }, { name: 'amount', value: '54.05 SAR', confidence: 0.9, page: null },
    { name: 'payment_date', value: '2026/08/11', confidence: 0.9, page: null }, { name: 'payer_name', value: 'Test Payer', confidence: 0.9, page: null }],
  warnings: [] }, o || {});
async function secPayV3(v3Deps, body3, stored) {
  section('7h. ai-doc-v3 payment documents: entity / appointment invoice + payment proof (schemas, Fasah rules, channels, wrong document, merge / fill-empty; mocked Claude)');
  await check('exports: PAY_TYPES are v3 doc types only; ALL_KEYS_V3 / KEYS_FOR_V3 unchanged (the readings are not saved as extractions); 4 MB, 6 docs, 12 MB', () =>
    (J(X.PAY_TYPES) === J(['appointment_invoice', 'payment_proof']) && X.PAY_TYPES.every(t => X.DOC_TYPES_V3.includes(t) && !X.DOC_TYPES.includes(t))
      && X.ALL_KEYS_V3.length === 66 && !X.KEYS_FOR_V3.payment_proof && X.MAX_PAY_BYTES === 4 * 1024 * 1024 && X.PAY_MAX_DOCS === 6
      && X.PAY_MAX_TOTAL_BYTES === 12 * 1024 * 1024 && J(X.PAY_METHODS) === J(['sadad', 'mada', 'fasah_wallet', 'dry_port_wallet', 'bank_transfer', 'cash', 'cheque', 'other'])
      && PAYAI.MAX_DOCS === 6 && PAYAI.MAX_BYTES === X.MAX_PAY_BYTES && PAYAI.MAX_TOTAL_BYTES === X.PAY_MAX_TOTAL_BYTES) || 'exports');
  await check('validateRequest: payment types only with ai-doc-v3; above 4 MB → too_large; no transaction needed', () => {
    const t = b => { try { const v = X.validateRequest(b); return v.prompt_version + ':' + v.doc_type; } catch (e) { return e.code; } };
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4.2 * 1024 * 1024, 32)]).toString('base64');
    const r = [t(goodBody({ doc_type: 'payment_proof' })), t(goodBody({ doc_type: 'payment_proof', prompt_version: 'ai-doc-v3' })),
      t(goodBody({ doc_type: 'appointment_invoice', prompt_version: 'ai-doc-v3' })),
      t(goodBody({ doc_type: 'appointment_invoice', prompt_version: 'ai-doc-v3', file: { media_type: 'application/pdf', data_b64: big } })),
      t(goodBody({ doc_type: 'packing_list', prompt_version: 'ai-doc-v3', file: { media_type: 'application/pdf', data_b64: big } }))];
    return J(r) === J(['bad_request', 'ai-doc-v3:payment_proof', 'ai-doc-v3:appointment_invoice', 'too_large', 'ai-doc-v3:packing_list']) || J(r);
  });
  await check('buildRequest invoice: the same SDK call shape (claude-opus-5-5, effort medium, 16000, server-side fallback beta + fallbacks default, json_schema, no thinking); SYSTEM_PAY; strict schema with is_fasah_appointment / component_amounts; the Reference No / FP / Date of Payment / page-sum rules', () => {
    const p = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'appointment_invoice', prompt_version: 'ai-doc-v3' })));
    const sc = p.output_config.format.schema, t = p.messages[0].content[1].text;
    return (p.model === 'claude-opus-5-5' && p.max_tokens === 16000 && p.output_config.effort === 'medium' && p.fallbacks === 'default'
      && J(p.betas) === J(['server-side-fallback-2026-07-01']) && p.output_config.format.type === 'json_schema' && !('thinking' in p) && p.system === X.SYSTEM_PAY
      && p.system.startsWith(X.SYSTEM) && J(sc.required) === J(['doc_type', 'document_title', 'fields', 'warnings', 'is_fasah_appointment', 'component_amounts'])
      && sc.additionalProperties === false && J(sc.properties.fields.items.properties.name.enum) === J(X.PAY_INVOICE_KEYS) && J(sc.properties.doc_type.enum) === J(X.PAY_DETECTED)
      && /never used as invoice_number or appointment_no/.test(t) && /Date of Payment/.test(t) && /list EVERY page value in component_amounts/.test(t)
      && /reversed right-to-left/.test(t) && p.messages[0].content[0].type === 'image') || t;
  });
  await check('buildRequest proof: strict schema {doc_type, document_title, fields, warnings}; the channel / bank / IBAN rules', () => {
    const p = X.buildRequest(X.validateRequest(goodBody({ doc_type: 'payment_proof', prompt_version: 'ai-doc-v3' })));
    const sc = p.output_config.format.schema, t = p.messages[0].content[1].text;
    return (J(sc.required) === J(['doc_type', 'document_title', 'fields', 'warnings']) && J(sc.properties.fields.items.properties.name.enum) === J(X.PAY_PROOF_KEYS)
      && /Fasah \/ فسح \/ Fasah Pay, Tabadul \/ تبادل, SADAD/.test(t) && /urpay are payment platforms or channels/.test(t) && /never the bank reference/.test(t)
      && p.system === X.SYSTEM_PAY) || t;
  });
  let I;
  await check('postProcess invoice (Fasah TAS appointment invoice): number = Reference No (never FP…), internal FP kept apart, TAS normalised (bidi + reversed), date = Date of Payment, the page amounts summed (34.50 + 19.55 = 54.05), gate_in from the container only → gate_in_appointment; containers ISO 6346', () => {
    I = X.postProcess(invOut(), 'appointment_invoice', 'ai-doc-v3');
    const p = I.payment, c = I.warnings.map(w => w.code);
    return (I.rejected === null && I.doc_type === 'appointment_invoice' && p.kind === 'invoice' && p.invoice_no === '260809154618646' && p.internal_invoice_no === 'FP00123456'
      && p.appointment_no === 'TAS20260811122969874' && p.invoice_date === '2026-08-11' && p.total === 54.05 && J(p.components.map(x => x.amount)) === J([34.5, 19.55])
      && p.appointment_type === 'gate_in' && p.service_code === 'gate_in_appointment' && J(p.container_numbers) === J([PC1]) && p.bl_number === null
      && p.is_fasah_appointment === true && p.issuer_name === 'Tabadul Test Issuer' && I.ai_detail === null && c.includes('fp_not_invoice_no')
      && c.includes('components_summed') && c.includes('components_total_mismatch') && I.extracted_fields.invoice_number === '260809154618646' && /\npayment invoice:\n/.test(I.raw_text)) || J({ p, c });
  });
  await check('postProcess invoice: container + B/L + declaration → gate_out (gate_out_appointment); no TAS → tas_missing (no FP used instead); no Reference No → reference_missing; a plain supplier invoice keeps its number and total', () => {
    const a = X.postProcess(invOut({ fields: invOut().fields.filter(f => f.name !== 'bl_number').concat([{ name: 'bl_number', value: 'MEDU123456', confidence: 0.9, page: 1 },
      { name: 'declaration_number', value: '3012345', confidence: 0.9, page: 1 }]) }), 'appointment_invoice', 'ai-doc-v3');
    const b = X.postProcess(invOut({ fields: invOut().fields.filter(f => !['appointment_no', 'reference_no'].includes(f.name)) }), 'appointment_invoice', 'ai-doc-v3');
    const c = X.postProcess({ doc_type: 'supplier_invoice', document_title: 'Tax invoice', is_fasah_appointment: false, component_amounts: [],
      fields: [{ name: 'issuer_name', value: 'Test Port Co', confidence: 0.9, page: 1 }, { name: 'invoice_number', value: 'INV-0012', confidence: 0.9, page: 1 },
        { name: 'total', value: '1,150.00', confidence: 0.9, page: 1 }, { name: 'vat_amount', value: '150', confidence: 0.9, page: 1 }, { name: 'invoice_date', value: '2026-11-02', confidence: 0.9, page: 1 }],
      warnings: [] }, 'appointment_invoice', 'ai-doc-v3');
    const bw = b.warnings.map(w => w.code);
    return (a.payment.appointment_type === 'gate_out' && a.payment.service_code === 'gate_out_appointment' && b.payment.appointment_no === null && bw.includes('tas_missing')
      && bw.includes('reference_missing') && b.payment.invoice_no === null && c.payment.invoice_no === 'INV-0012' && c.payment.total === 1150 && c.payment.vat_amount === 150
      && c.payment.is_fasah_appointment === false && c.payment.service_code === null && c.payment.invoice_date === '2026-11-02' && c.rejected === null) || J({ a: a.payment, b: b.payment, bw, c: c.payment });
  });
  let Q;
  await check('postProcess proof: a channel (SADAD) is never the beneficiary (moved to payment_channel, warning); method → sadad; SADAD no digits only (Arabic digits); the IBAN is never the bank reference; amount 54.05', () => {
    Q = X.postProcess(proofOut(), 'payment_proof', 'ai-doc-v3');
    const p = Q.payment, c = Q.warnings.map(w => w.code);
    return (Q.rejected === null && p.kind === 'proof' && p.beneficiary_name === null && p.beneficiary_raw === 'SADAD' && p.payment_channel === 'SADAD' && p.method === 'sadad'
      && p.sadad_number === '771234' && p.bank_reference === null && p.amount === 54.05 && p.paid_at === '2026-08-11' && p.payer_name === 'Test Payer'
      && c.includes('beneficiary_is_channel') && c.includes('beneficiary_missing') && c.includes('bank_ref_is_iban') && !('beneficiary_name' in Q.extracted_fields)) || J({ p, c });
  });
  await check('payment channels (Fasah, فسح, Tabadul, تبادل, SADAD, سداد, mada, مدى, Visa, Mastercard, Apple Pay, STC Pay, urpay) are recognised; a real company is not; methods map to the register codes', () => {
    const ch = ['Fasah', 'فسح', 'Fasah Pay', 'Tabadul', 'تبادل', 'SADAD', 'سداد', 'mada', 'مدى', 'Visa', 'Mastercard', 'Apple Pay', 'STC Pay', 'urpay'];
    const m = ['SADAD', 'mada card', 'محفظة فسح', 'Dry port wallet', 'Bank transfer', 'نقدي', 'شيك', 'Visa', 'something'].map(X.payMethod);
    return (ch.every(x => X.isPaymentChannel(x) && PAYAI.isChannel(x)) && !X.isPaymentChannel('Test Port Co') && !PAYAI.isChannel('شركة الميناء')
      && J(m) === J(['sadad', 'mada', 'fasah_wallet', 'dry_port_wallet', 'bank_transfer', 'cash', 'cheque', 'mada', 'other'])) || J(m);
  });
  await check('wrong document: a proof read in the invoice slot → not_entity_invoice; an invoice read in the proof slot → not_payment_proof; "other" only warns', () => {
    const a = X.postProcess(invOut({ doc_type: 'payment_proof' }), 'appointment_invoice', 'ai-doc-v3');
    const b = X.postProcess(proofOut({ doc_type: 'supplier_invoice' }), 'payment_proof', 'ai-doc-v3');
    const c = X.postProcess(proofOut({ doc_type: 'other' }), 'payment_proof', 'ai-doc-v3');
    return (J(a.rejected) === J({ code: 'wrong_document_type', reason: 'not_entity_invoice' }) && J(b.rejected) === J({ code: 'wrong_document_type', reason: 'not_payment_proof' })
      && c.rejected === null) || J({ a: a.rejected, b: b.rejected, c: c.rejected });
  });
  await check('parseMessage (payment doc types): the payment shape is checked (bad doc type / component / is_fasah → bad_output)', () => {
    const ok1 = X.parseMessage(msgOf(invOut()), 'ai-doc-v3', 'appointment_invoice').ok, ok2 = X.parseMessage(msgOf(proofOut()), 'ai-doc-v3', 'payment_proof').ok;
    const bad = [X.parseMessage(msgOf(invOut({ doc_type: 'receipt' })), 'ai-doc-v3', 'appointment_invoice').code,
      X.parseMessage(msgOf(invOut({ component_amounts: [{ page: 1, amount_after_vat: '3' }] })), 'ai-doc-v3', 'appointment_invoice').code,
      X.parseMessage(msgOf(invOut({ is_fasah_appointment: 'yes' })), 'ai-doc-v3', 'appointment_invoice').code];
    return (ok1 && ok2 && bad.every(c => c === 'bad_output')) || J({ ok1, ok2, bad });
  });
  const bodyP = o => body3(Object.assign({ doc_type: 'payment_proof' }, o || {}));
  await check('handler proof (mocked Claude, real ai_reserve / ai_bind_source / ai_settle): 200 with payment, no stored-reading lookup (never reused), one reserve, settled ok', async () => {
    const d = v3Deps([stored({ doc_type: 'other' })], { msg: msgOf(proofOut()) });
    const r = await H.handleRequest(hReq(bodyP()), d);
    const b = JSON.parse(r.body);
    const order = d.calls.filter(c => !/^log:/.test(c));
    const u = await usageRow(b.usage_id);
    return (r.status === 200 && J(order) === J(['user:ai_access', 'ai_reserve', 'ai_bind_source', 'claude', 'ai_settle']) && d.lookups.length === 0
      && b.payment && b.payment.method === 'sadad' && b.reused === false && b.ai_detail === null && b.appointment === null && u.status === 'ok'
      && d.params.system === X.SYSTEM_PAY && d.params.model === 'claude-opus-5-5') || J({ s: r.status, order, keys: Object.keys(b) });
  });
  await check('handler invoice: an invoice read in the proof slot → 422 wrong_document_type (not_payment_proof), still settled; an invoice in its slot → 200 with payment.invoice_no', async () => {
    const d = v3Deps([], { msg: msgOf(invOut({ doc_type: 'appointment_invoice' })) });
    const r = await H.handleRequest(hReq(bodyP()), d);
    const b = JSON.parse(r.body);
    const d2 = v3Deps([], { msg: msgOf(invOut()) });
    const r2 = await H.handleRequest(hReq(body3({ doc_type: 'appointment_invoice' })), d2);
    const b2 = JSON.parse(r2.body);
    return (r.status === 422 && b.error === 'wrong_document_type' && b.reason === 'not_payment_proof' && d.calls.includes('ai_settle') && r2.status === 200
      && b2.payment.invoice_no === '260809154618646' && b2.kind === 'operator_invoice') || J({ s: r.status, b, s2: r2.status });
  });
  await check('pay-ai.js merge: issuer → beneficiary (never the channel), Σ invoice totals vs the proof amount, the proof\'s method + its reference only, the TAS / service code, hints for match_payment_transaction', () => {
    const m = PAYAI.merge([{ payment: I.payment }, { payment: Q.payment }]);
    const s = m.suggestion;
    return (m.invoices.length === 1 && m.proofs.length === 1 && s.beneficiary_name === 'Tabadul Test Issuer' && s.claim_no === '260809154618646'
      && s.internal_invoice_no === 'FP00123456' && s.appointment_no === 'TAS20260811122969874' && s.service_code === 'gate_in_appointment' && s.expected_amount === 54.05
      && s.paid_amount === 54.05 && s.method === 'sadad' && s.sadad_number === '771234' && !('receipt_no' in s) && s.paid_at === '2026-08-11'
      && J(m.hints.container_numbers) === J([PC1]) && m.hints.appointment_no === 'TAS20260811122969874' && !m.warnings.some(w => w.code === 'amount_mismatch')
      && m.warnings.some(w => w.code === 'beneficiary_from_issuer')) || J(m);
  });
  await check('pay-ai.js merge warnings: different issuers, beneficiary ≠ issuer, amount mismatch; ≥ 2 invoices → suggested allocations (no top-level claim); > 6 documents refused', () => {
    const i2 = Object.assign({}, I.payment, { issuer_name: 'Another Test Entity', invoice_no: 'X-1', total: 10 });
    const q2 = Object.assign({}, Q.payment, { beneficiary_name: 'Unrelated Test Merchant', amount: 70 });
    const m = PAYAI.merge([{ payment: I.payment }, { payment: i2 }, { payment: q2 }]);
    const many = PAYAI.merge(new Array(7).fill({ payment: Q.payment }));
    const codes = m.warnings.map(w => w.code);
    return (codes.includes('issuers_differ') && codes.includes('beneficiary_issuer_mismatch') && codes.includes('amount_mismatch') && !('claim_no' in m.suggestion)
      && m.allocations_suggested.length === 2 && m.allocations_suggested[1].claim_no === 'X-1' && m.warnings.every(w => w.text_ar && w.text_en)
      && many.error && many.error.field === 'count' && many.proofs.length === 6) || J({ codes, a: m.allocations_suggested });
  });
  await check('pay-ai.js fillEmpty: only EMPTY form fields are filled (a typed value is never overwritten); review / movement / pattern never filled; checkFiles 6 / 4 MB / 12 MB / PDF-image', () => {
    const m = PAYAI.merge([{ payment: I.payment }, { payment: Q.payment }]);
    const r = PAYAI.fillEmpty({ claim_no: 'TYPED-1', paid_amount: '', method: null, review_status: '', movement_type: 'org_paid' }, Object.assign({ review_status: 'approved', movement_type: 'x' }, m.suggestion));
    const f = [PAYAI.checkFiles(new Array(7).fill({ size: 1, type: 'application/pdf' })), PAYAI.checkFiles([{ size: 4 * 1024 * 1024 + 1, type: 'image/png' }]),
      PAYAI.checkFiles([1, 2, 3, 4].map(() => ({ size: 3.5 * 1024 * 1024, type: 'image/jpeg' }))), PAYAI.checkFiles([{ size: 10, type: 'text/plain' }]),
      PAYAI.checkFiles([{ size: 10, type: 'application/pdf' }])];
    return (r.form.claim_no === 'TYPED-1' && r.form.paid_amount === 54.05 && r.form.method === 'sadad' && r.form.review_status === '' && r.form.movement_type === 'org_paid'
      && !r.filled.includes('claim_no') && r.filled.includes('paid_amount') && J(f.map(x => x.ok ? 'ok' : x.field)) === J(['count', 'size', 'total', 'type', 'ok'])) || J({ r, f });
  });
}

/* inbox-sync worker + the Claude provider, with the shared ledger bound to the real ai_reserve / ai_settle (review B-11 / B-14 / B-15) */
const INB = path.join(SUPA, 'functions', 'inbox-sync');
const IDEPS = Object.assign({}, require(path.join(INB, 'adapters.js')), require(path.join(INB, 'ai-mock.js')), require(path.join(INB, 'pipeline.js')),
  require(path.join(INB, 'llm-provider.js')));
const IWK = require(path.join(INB, 'worker.js'));
const IRULE = IDEPS.createRuleProvider({ clock: () => '2026-11-08T09:00:00.000Z' });
const inboxCtx = (org, settings) => ({ job: { id: 'j-ai', org_id: org || A, kind: 'process' },
  settings: Object.assign({ ai_provider: 'claude', default_lang: 'ar', ai_monthly_budget_usd: 50, month_to_date_usd: 0 }, settings || {}),
  channel: { id: 'c', kind: 'email', address_norm: 'inbox@ai.example.com' },
  message: { id: 'm-ai', thread_id: 't', direction: 'inbound', subject: 'D/O request', body_text: 'Please issue the delivery order for container MSKU7712050.',
    sent_at: '2026-11-08T08:00:00Z', from: { address_norm: 'ops@agent.example', name: null }, to: ['inbox@ai.example.com'], participants: [],
    directory_addresses: ['ops@agent.example'], sender: { display_name: 'Agent Ops', status: 'verified' }, attachments: [] } });
function inboxModel(o) {
  const x = o || {};
  const fn = async req => {
    fn.calls++;
    const sc = req.schema;
    const json = sc === IDEPS.LLM_SCHEMAS.extract ? { items: [] } : sc === IDEPS.LLM_SCHEMAS.summarize ? { summary_ar: 'طلب أمر تسليم.', summary_en: 'A delivery order request.' }
      : { category: 'delivery_order', confidence: 0.9, message_contains_instructions: false };
    return { json, stop_reason: x.stop_reason || 'end_turn', model: 'claude-opus-5-5', fallback_ran: false, usage: { input_tokens: 1000, output_tokens: 200 } };
  };
  fn.calls = 0;
  return fn;
}
const dbLedger = {
  reserve: async (ctx, est) => {
    try { return (await as('service', `SELECT public.ai_reserve($1, NULL, 'inbox', $2) r`, [ctx.job.org_id, est]))[0].r; }
    catch (e) { throw IDEPS.mapLedgerError(IDEPS, e.message); }
  },
  settle: async (id, status, usage) => {
    const a = IDEPS.ledgerSettleArgs(id, status, usage);
    await as('service', `SELECT public.ai_settle($1, $2, $3, $4, $5, $6) r`, [a.p_reservation, a.p_input_tokens, a.p_output_tokens, a.p_status, a.p_model, a.p_attempts ? J(a.p_attempts) : null]);
  }
};
const inboxRun = (ctx, cm) => IWK.runJob(ctx, null, { deps: IDEPS, provider: IRULE, clock: () => '2026-11-08T09:00:00.000Z', aiLedger: dbLedger,
  llmFactory: (c, e) => IDEPS.createLlmProvider({ impl: IDEPS.createModelProvider, callModel: cm, deps: IDEPS, settings: c.settings, holdUsd: e.holdUsd }) });

async function secInboxLedger() {
  section('7d. inbox Claude jobs in the shared ledger (worker + provider + real ai_reserve / ai_settle)');
  await resetUsage();
  await saveSettings('admin', A, { daily_request_cap: 100, monthly_budget_usd: 20 });
  await check('an ok inbox job: one inbox row (no user), settled ok with the calls\' real tokens, cost at claude-opus-5-5 prices', async () => {
    const cm = inboxModel();
    const out = await inboxRun(inboxCtx(), cm);
    const u = await one(`SELECT purpose, user_id, status, input_tokens i, output_tokens o, cost_usd::float c, reserved_usd::float h FROM app.ai_usage`);
    return (out.outcome === 'ok' && cm.calls === 4 && u.purpose === 'inbox' && u.user_id === null && u.status === 'ok' && u.i === 4000 && u.o === 800
      && u.c === (4000 * 4 + 800 * 20) / 1e6 && u.h > u.c) || J({ out: out.outcome, calls: cm.calls, u });
  });
  await check('review B-11: a refused inbox job is still billed in the ledger (refused, its tokens, its cost) — spend never escapes the budget', async () => {
    await resetUsage();
    const cm = inboxModel({ stop_reason: 'refusal' });
    const out = await inboxRun(inboxCtx(), cm);
    const u = await one(`SELECT status, input_tokens i, cost_usd::float c FROM app.ai_usage`);
    return (out.outcome === 'failed' && out.error.code === 'ai_refusal' && u.status === 'refused' && u.i === 1000 && u.c === (1000 * 4 + 200 * 20) / 1e6) || J({ out, u });
  });
  await check('review B-15: org AI switched off → the inbox job fails not_configured ai_disabled with NO model call; another org (never enabled) the same', async () => {
    await saveSettings('admin', A, { enabled: false });
    const cm = inboxModel();
    const a = await inboxRun(inboxCtx(), cm);
    await enableA();
    const b = await inboxRun(inboxCtx(B), cm);
    return (a.outcome === 'failed' && a.error.code === 'ai_disabled' && b.error.code === 'ai_disabled' && cm.calls === 0) || J({ a, b, calls: cm.calls });
  });
  await check('review B-14: an in-flight job\'s hold counts — the next job past the monthly budget is refused (ai_budget) before any call', async () => {
    await resetUsage();
    const hold = IDEPS.estimateJobHoldUsd(IDEPS, inboxCtx());
    await saveSettings('admin', A, { monthly_budget_usd: Math.ceil(hold * 1.5 * 100) / 100 });
    const inflight = await dbLedger.reserve(inboxCtx(), hold);
    const cm = inboxModel();
    const out = await inboxRun(inboxCtx(), cm);
    await as('service', `SELECT public.ai_settle($1, 0, 0, 'error', NULL, NULL)`, [inflight]);
    const after = await inboxRun(inboxCtx(), cm);
    await saveSettings('admin', A, { monthly_budget_usd: 20 });
    return (out.outcome === 'failed' && out.error.code === 'ai_budget' && cm.calls === 4 && after.outcome === 'ok') || J({ out, calls: cm.calls, after: after.outcome });
  });
}

async function secStatic() {
  section('8. static: the key and the network stay in index.ts');
  const files = fs.readdirSync(FN_DIR);
  const idx = fs.readFileSync(path.join(FN_DIR, 'index.ts'), 'utf8');
  await check('ai-extract holds index.ts + classic helper(s) only', () => (files.includes('index.ts') && files.includes('extract.js') && files.every(f => /\.(ts|js)$/.test(f))) || J(files));
  await check('no file other than index.ts references the key, fetch, XHR, WebSocket, Deno, process.env, require / import / export', () => {
    const bad = [];
    for (const f of files.filter(f => f !== 'index.ts')) {
      const s = fs.readFileSync(path.join(FN_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/ANTHROPIC_API_KEY|apiKey|x-api-key|\bfetch\s*\(|XMLHttpRequest|WebSocket|\bDeno\b|process\.env|\brequire\s*\(|^\s*import\s|^\s*export\s/m.test(s)) bad.push(f);
    }
    return bad.length === 0 || 'found in ' + bad.join(', ');
  });
  await check('index.ts: the key is read once from Deno.env ANTHROPIC_API_KEY and only handed to the SDK constructor; never logged / returned', () => {
    const reads = idx.match(/Deno\.env\.get\('ANTHROPIC_API_KEY'\)/g) || [];
    const uses = idx.match(/\bapiKey\b/g) || [];
    const logs = idx.match(/console\.\w+\([^)]*\)/g) || [];
    return (reads.length === 1 && /const apiKey = Deno\.env\.get\('ANTHROPIC_API_KEY'\) \?\? '';/.test(idx)
      && /claudeClient: \(\) => new Anthropic\(\{ apiKey, maxRetries: 0, timeout: CLAUDE_TIMEOUT_MS \}\)/.test(idx) && /modelConfigured: apiKey !== ''/.test(idx)
      && uses.length === 3 && J(logs) === J(['console.error(text)']) && !/json\([^)]*apiKey/.test(idx)) || J({ reads: reads.length, uses: uses.length, logs });
  });
  await check('review A-4: index.ts — one attempt (maxRetries 0) with a 100 s timeout: the call + settle end inside the 150 s wall clock', () =>
    (/const CLAUDE_TIMEOUT_MS = 100000;/.test(idx) && !/maxRetries: [1-9]/.test(idx)) || 'timeout / retries');
  await check('index.ts: official SDK pinned (npm:@anthropic-ai/sdk@1.5.0), supabase-js 2.45.4, extract.js + handler.js loaded, no raw fetch to Anthropic', () =>
    (/import Anthropic from 'npm:@anthropic-ai\/sdk@1\.5\.0';/.test(idx) && /from 'npm:@supabase\/supabase-js@2\.45\.4'/.test(idx)
      && /import '\.\/extract\.js';/.test(idx) && /import '\.\/handler\.js';/.test(idx) && !/\bfetch\s*\(/.test(idx) && !/api\.anthropic\.com/.test(idx)) || 'imports');
  await check('index.ts: user client = anon key + the caller\'s bearer; service client = service key; the handler gets clients, never a key', () =>
    (/userClient: \(token: string\) => createClient\(url, anonKey, \{ \.\.\.opts, global: \{ headers: \{ Authorization: `Bearer \$\{token\}` \} \} \}\)/.test(idx)
      && /serviceClient: \(\) => createClient\(url, serviceKey, opts\)/.test(idx) && /isAnonKey: \(t: string\) => t === anonKey/.test(idx)
      && !/^\s*(apiKey|serviceKey|anonKey|key)\s*[,:]/m.test(idx.slice(idx.indexOf('X.handleRequest(req, {')))) || 'wiring');
  const hsrc = fs.readFileSync(path.join(FN_DIR, 'handler.js'), 'utf8');
  await check('handler.js: CORS https://marsacloud.com + http://127.0.0.1 dev only, no wildcard; errors are fixed codes, SDK errors never echoed', () => {
    const errs = hsrc.match(/fail\('([a-z_]+)'/g) || [];
    return (/const PROD_ORIGIN = 'https:\/\/marsacloud\.com';/.test(hsrc) && /DEV_ORIGIN_RE = \/\^http:\\\/\\\/127\\\.0\\\.0\\\.1\(:\\d\{1,5\}\)\?\$\//.test(hsrc)
      && !/allow-origin': '\*'/.test(hsrc) && errs.length >= 15 && !/e\.message|String\(e\)/.test(hsrc.replace(/function mrs[\s\S]*?\n  }\n/, ''))) || J(errs);
  });
  await check('no Anthropic key name / endpoint / secret-looking value in the front end or the database files', () => {
    const fe = fs.readdirSync(path.join(ROOT, 'assets', 'js')).filter(f => f.endsWith('.js')).map(f => 'assets/js/' + f)
      .concat(fs.readdirSync(path.join(ROOT, 'assets', 'i18n')).map(f => 'assets/i18n/' + f))
      .concat(fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))).concat(['supabase/all_migrations.sql', 'sw.js']);
    const bad = fe.filter(f => /ANTHROPIC_API_KEY|api\.anthropic\.com|sk-ant-|x-api-key/i.test(rd(f)));
    return bad.length === 0 || bad.join(', ');
  });
}

async function secFrontEnd() {
  section('9. front end: ocr.html / ocr.js, supa.js, admin.js, i18n (static + vm)');
  const supa = rd('assets/js/supa.js'), ocr = rd('assets/js/ocr.js'), html = rd('ocr.html'), adm = rd('assets/js/admin.js');
  await check('supa.js exports aiAccess / aiExtract / aiGetSettings / aiSaveSettings; ai_usage_id insertable; Edge call via functions.invoke', () =>
    (/aiAccess: aiAccess, aiExtract: aiExtract, aiGetSettings: aiGetSettings, aiSaveSettings: aiSaveSettings/.test(supa)
      && /c\.functions\.invoke\('ai-extract', \{ body: body \}\)/.test(supa) && /'ai_usage_id',/.test(supa) && /'ai_detail'\];/.test(supa)
      && /rpc\('ai_access'/.test(supa) && /rpc\('ai_get_settings'/.test(supa) && /rpc\('ai_save_settings'/.test(supa)) || 'supa.js');
  // run supa.js in a vm with a fake supabase client: aiExtract → functions.invoke, edge error codes → MRS_*
  const invoked = [];
  let next = null;
  const fakeClient = {
    rpc: (name, a) => Promise.resolve({ data: { name, a }, error: null }),
    functions: { invoke: (name, o) => { invoked.push({ name, o }); return Promise.resolve(next); } },
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: () => Promise.resolve({ data: { session: null } }) }
  };
  const store = {};
  const win = {
    MARSA_CONFIG: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'test-anon-key-not-real', orgSlug: 'blue-sea' },
    supabase: { createClient: () => fakeClient }, addEventListener() {}, dispatchEvent() {},
    location: { origin: 'http://127.0.0.1:8000', pathname: '/ocr.html', hostname: '127.0.0.1', href: 'http://127.0.0.1:8000/ocr.html' }
  };
  const ctx = { window: win, document: { currentScript: null, head: { appendChild() {} }, createElement: () => ({}), addEventListener() {},
      documentElement: { setAttribute() {}, getAttribute: () => null, hasAttribute: () => false }, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: { onLine: true }, location: win.location,
    console, setTimeout, clearTimeout, Promise, CustomEvent: function () {}, crypto: require('crypto').webcrypto, URL, Date, Math, JSON };
  win.window = win;
  let vmErr = null;
  try { vm.createContext(ctx); vm.runInContext(supa, ctx); } catch (e) { vmErr = e; }
  const api = win.MarsaApi;
  await check('supa.js (vm): aiExtract sends {org_id, doc_type, file, lang} to the ai-extract function and returns the reading', async () => {
    if (vmErr || !api) return 'vm: ' + (vmErr && vmErr.message);
    next = { data: { usage_id: 'u1', fields: [] }, error: null };
    const r = await api.aiExtract({ orgId: A, docType: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } });
    const c = invoked[0];
    return (r.data && r.data.usage_id === 'u1' && c.name === 'ai-extract' && c.o.body.org_id === A && c.o.body.doc_type === 'bill_of_lading'
      && c.o.body.file.media_type === 'image/png' && c.o.body.lang === 'ar' && !('transaction_id' in c.o.body)) || J({ r, c });
  });
  await check('supa.js (vm): edge error codes → MRS_AI_*; unknown → MRS_AI_FAILED; refused before the call: bad media / too large', async () => {
    const codes = {};
    for (const e of ['daily_cap', 'budget', 'ai_disabled', 'refused', 'truncated', 'mfa_required', 'not_configured', 'something_else']) {
      next = { data: null, error: { name: 'FunctionsHttpError', context: { json: () => Promise.resolve({ error: e }) } } };
      codes[e] = (await api.aiExtract({ orgId: A, file: { media_type: 'application/pdf', data_b64: PDF } })).error.code;
    }
    next = { data: null, error: { name: 'FunctionsFetchError', context: {} } };
    codes.net = (await api.aiExtract({ orgId: A, file: { media_type: 'application/pdf', data_b64: PDF } })).error.code;
    const n0 = invoked.length;
    const bad = (await api.aiExtract({ orgId: A, file: { media_type: 'image/bmp', data_b64: PNG } })).error.code;
    const big = (await api.aiExtract({ orgId: A, file: { media_type: 'image/png', data_b64: 'A'.repeat(14 * 1024 * 1024 + 8) } })).error.code;
    return (J(codes) === J({ daily_cap: 'MRS_AI_DAILY_CAP', budget: 'MRS_AI_BUDGET', ai_disabled: 'MRS_AI_DISABLED', refused: 'MRS_AI_REFUSED',
      truncated: 'MRS_AI_TRUNCATED', mfa_required: 'MRS_MFA_REQUIRED', not_configured: 'MRS_AI_UNAVAILABLE', something_else: 'MRS_AI_FAILED', net: 'MRS_NETWORK' })
      && bad === 'MRS_AI_UNSUPPORTED' && big === 'MRS_AI_TOO_LARGE' && invoked.length === n0) || J({ codes, bad, big });
  });
  await check('review A-5 (front end): supa.js refuses an image over 5 MB before any call, lets a 6 MB PDF through; ocr.js checks 5 MB images / 10 MB PDFs', async () => {
    const n0 = invoked.length;
    const img = (await api.aiExtract({ orgId: A, file: { media_type: 'image/jpeg', data_b64: 'A'.repeat(Math.ceil(5.5 * 1024 * 1024 / 3) * 4) } })).error.code;
    const n1 = invoked.length;
    next = { data: { usage_id: 'u1' }, error: null };
    await api.aiExtract({ orgId: A, file: { media_type: 'application/pdf', data_b64: 'A'.repeat(Math.ceil(6 * 1024 * 1024 / 3) * 4) } });
    return (img === 'MRS_AI_TOO_LARGE' && n1 === n0 && invoked.length === n0 + 1 && /var AI_MAX_IMAGE = 5 \* 1024 \* 1024;/.test(ocr)
      && /j\.file\.size > \(mt === 'application\/pdf' \? AI_MAX_FILE : AI_MAX_IMAGE\)/.test(ocr)) || J({ img, n0, n1, n: invoked.length });
  });
  await check('supa.js (vm): aiAccess / aiGetSettings / aiSaveSettings call the RPCs with p_org (+ p_payload)', async () => {
    const a = await api.aiAccess(A), b = await api.aiGetSettings(A), c = await api.aiSaveSettings(A, { enabled: true, consent_ack: true });
    return (a.data.name === 'ai_access' && a.data.a.p_org === A && b.data.name === 'ai_get_settings' && c.data.name === 'ai_save_settings'
      && c.data.a.p_payload.consent_ack === true) || J({ a, b, c });
  });
  await check('ocr.html: the AI engine group is hidden by default and its note names Anthropic; Tesseract checked in the markup (the fallback — ocr.js selects AI when available)', () =>
    (/<fieldset class="fieldset ocr-engine" id="ocr-engine-group" hidden>/.test(html) && /id="ocr-engine-tesseract" value="tesseract" checked/.test(html)
      && /id="ocr-ai-note" role="note" hidden/.test(html) && /Anthropic/.test(html.slice(html.indexOf('ocr-ai-note')))) || 'ocr.html');
  await check('ocr.js: AI mode only online + staff + ai_access can_use; aiExtract; engine claude-opus-5-5 + ai_usage_id on save; warnings as textContent', () =>
    (/return ONLINE && STAFF && AI\.enabled && r && r\.checked \? 'ai' : 'tesseract';/.test(ocr) && /AI\.enabled = !!\(r && !r\.error && r\.data && r\.data\.can_use === true\);/.test(ocr)
      && /API\.aiExtract\(/.test(ocr) && /var ENGINE_AI = 'claude-opus-5-5';/.test(ocr) && /ai_usage_id: j\.ai\.usageId/.test(ocr)
      && !/innerHTML\s*=\s*[^'"]*(warn|res\.|f\.value)/.test(ocr) && /var show = ONLINE && STAFF && AI\.enabled;/.test(ocr)) || 'ocr.js');
  await check('ocr.js (vm): finishAiJob maps the reading (confidence levels, kind for an unknown type, cost) — run in isolation', () => {
    const i = ocr.indexOf('    function aiLevel('), j = ocr.indexOf('\n', ocr.indexOf('    function aiLevel('));
    const k = ocr.indexOf('    function finishAiJob('), l = ocr.indexOf('\n    }\n', k);
    const c2 = { MAX_TEXT: 200000, ENGINE_AI: 'claude-opus-5-5', AI_DOC: { bill_of_lading: 'bill_of_lading' },
      DOC_TYPES: [['bill_of_lading', ''], ['operator_invoice', ''], ['other', '']], P: { plainFields: f => Object.fromEntries(Object.entries(f).map(([a, b]) => [a, b.value])) } };
    vm.createContext(c2);
    vm.runInContext(ocr.slice(i, j) + '\n' + ocr.slice(k, l + 7) + ';this.finishAiJob = finishAiJob;', c2);
    const job = { docType: 'other' };
    c2.finishAiJob(job, { usage_id: 'u9', kind: 'operator_invoice', mean_confidence: 91.5, raw_text: 'x', usage: { cost_usd: 0.0123 },
      fields: [{ name: 'total', value: '10', confidence: 0.95, page: 2 }, { name: 'iban', value: 'SA00', confidence: 0.4, page: null }], line_items: [{ amount: 10 }], warnings: [{ text: 'w' }] });
    return (job.fields.total.confidence === 'high' && job.fields.iban.confidence === 'low' && job.fields.total.source === 'ai' && job.docType === 'operator_invoice'
      && job.engine === 'claude-opus-5-5' && job.langs === 'auto' && job.ai.usageId === 'u9' && job.ai.costUsd === 0.0123 && job.pages === 2
      && job.extracted.total === '10' && job.status === 'done') || J(job);
  });
  // 2026-11-12 (owner: «انا عايز كل حاجه تتقرا»): AI is the default engine when available; ai-doc-v3 + 'auto'; every field shown
  await check('ocr.js (vm): syncEngineUi selects the AI engine by default when available (online + staff + enabled + quota), keeps a Tesseract pick, falls back on quota 0', () => {
    const i = ocr.indexOf('    var userEngine = '), j = ocr.indexOf('    // the AI mode exists only for staff');
    if (i < 0 || j < i) return 'markers';
    const mk = id => ({ id, checked: id === 'ocr-engine-tesseract', hidden: true, value: id === 'ocr-engine-ai' ? 'ai' : 'tesseract', on: {}, addEventListener(e, f) { this.on[e] = f; } });
    const nodes = { 'ocr-engine-group': { hidden: true }, 'ocr-engine-ai': mk('ocr-engine-ai'), 'ocr-engine-tesseract': mk('ocr-engine-tesseract'), 'ocr-ai-note': { hidden: true } };
    const radio = (id, on) => { nodes['ocr-engine-ai'].checked = id === 'ocr-engine-ai' ? on : !on; nodes['ocr-engine-tesseract'].checked = !nodes['ocr-engine-ai'].checked; };
    const c = { ONLINE: true, STAFF: true, AI: { enabled: true, remaining: 50 }, $: id => nodes[id] || null, showAiRemaining() {},
      qsa: () => [nodes['ocr-engine-tesseract'], nodes['ocr-engine-ai']] };
    vm.createContext(c);
    vm.runInContext(ocr.slice(i, j) + ';this.syncEngineUi = syncEngineUi;', c);
    c.syncEngineUi();
    const def = nodes['ocr-engine-ai'].checked && !nodes['ocr-engine-group'].hidden && !nodes['ocr-ai-note'].hidden;
    radio('ocr-engine-tesseract', true); nodes['ocr-engine-tesseract'].on.change();       // the user picks Tesseract
    c.syncEngineUi();                                                                        // e.g. an org change
    const kept = nodes['ocr-engine-tesseract'].checked && nodes['ocr-ai-note'].hidden;
    radio('ocr-engine-ai', true); nodes['ocr-engine-ai'].on.change();
    c.AI.remaining = 0; c.syncEngineUi();
    const quota = nodes['ocr-engine-tesseract'].checked;
    c.AI.remaining = null; c.AI.enabled = true; c.syncEngineUi();
    const unlimited = nodes['ocr-engine-ai'].checked;
    c.AI.enabled = false; c.syncEngineUi();
    const off = nodes['ocr-engine-tesseract'].checked && nodes['ocr-engine-group'].hidden && nodes['ocr-ai-note'].hidden;
    return (def && kept && quota && unlimited && off) || J({ def, kept, quota, unlimited, off });
  });
  await check('ocr.js: the reading is sent as ai-doc-v3 with doc type auto (customs declaration typed) — extract.js: a typed invoice request drops the B/L keys, auto asks for all', () => {
    const i = ocr.indexOf('    function aiRequestType('), j = ocr.indexOf('\n', i);
    const c = {}; vm.createContext(c); vm.runInContext(ocr.slice(i, j) + ';this.f = aiRequestType;', c);
    const types = ['commercial_invoice', 'operator_invoice', 'bill_of_lading', 'packing_list', 'certificate_of_origin', 'other'];
    const blOnly = ['notify_party', 'booking_number', 'place_of_receipt', 'freight_terms', 'measurement_cbm', 'shipping_line'];
    const lost = blOnly.filter(k => X.KEYS_FOR_V3.commercial_invoice.indexOf(k) === -1);
    const autoAll = ['bill_of_lading', 'commercial_invoice', 'packing_list', 'supplier_invoice'].every(t => X.KEYS_FOR_V3[t].every(k => X.KEYS_FOR_V3.auto.indexOf(k) !== -1));
    return (types.every(t => c.f(t) === 'auto') && c.f('customs_declaration') === 'customs_declaration' && /var AI_PROMPT = 'ai-doc-v3';/.test(ocr)
      && /docType: aiRequestType\(j\.docType\), promptVersion: AI_PROMPT,/.test(ocr) && lost.length === blOnly.length && autoAll) || J({ lost, autoAll });
  });
  await check('ocr.js (vm): finishAiJob (v3) — a B/L picked as «فاتورة تجارية» becomes a B/L; every field kept, only DB keys in extracted; containers kept', () => {
    const i = ocr.indexOf('    function aiLevel('), j = ocr.indexOf('\n', ocr.indexOf('    function aiLevel('));
    const k = ocr.indexOf('    function finishAiJob('), l = ocr.indexOf('\n    }\n', k);
    const P = require(path.join(ROOT, 'assets', 'js', 'ocr-parse.js'));
    const c2 = { MAX_TEXT: 200000, ENGINE_AI: 'claude-opus-5-5', AI_DOC: {}, P,
      DOC_TYPES: [['commercial_invoice', ''], ['operator_invoice', ''], ['bill_of_lading', ''], ['customs_declaration', ''], ['packing_list', ''], ['other', '']] };
    vm.createContext(c2);
    vm.runInContext(ocr.slice(i, j) + '\n' + ocr.slice(k, l + 7) + ';this.finishAiJob = finishAiJob;', c2);
    const job = { docType: 'commercial_invoice' };
    c2.finishAiJob(job, { usage_id: 'u3', kind: 'bill_of_lading', doc_type: 'bill_of_lading', detected_type: 'bill_of_lading', detected_documents: ['bill_of_lading'],
      mean_confidence: 90, raw_text: 'x', usage: { cost_usd: 0.02 }, ai_detail: { prompt_version: 'ai-doc-v3' },
      fields: [{ name: 'bl_number', value: 'SYNBL1', confidence: 0.98, page: 1 }, { name: 'seal_numbers', value: 'SL1, SL2', confidence: 0.9, page: 1 },
        { name: 'notify_party', value: 'SAME AS CONSIGNEE', confidence: 0.9, page: 1 }, { name: 'gross_weight', value: '18250', confidence: 0.9, page: 1 },
        { name: 'mystery_key', value: 'v', confidence: 0.5, page: 1 }, { name: 'Bad Key!', value: 'x', confidence: 1, page: 1 }],
      line_items: [{ description: 'GAUZE', packages: 19, gross_weight: 4040, container_number: 'MSCU1234566' }],
      containers: [{ container_number: 'MSCU1234566', seal_number: 'SL1', size_type: '40HC', packages_count: 19, net_weight: 3900, gross_weight: 4040 }], warnings: [] });
    const decl = { docType: 'customs_declaration' };
    c2.finishAiJob(decl, { usage_id: 'u4', kind: 'customs_declaration', doc_type: 'customs_declaration', detected_type: 'customs_declaration',
      detected_documents: ['customs_declaration', 'bill_of_lading'], fields: [{ name: 'declaration_type', value: 'import', confidence: 0.9 }], line_items: [], containers: [], warnings: [] });
    return (job.docType === 'bill_of_lading' && job.ai.typeFrom === 'commercial_invoice' && job.fields.mystery_key && !job.fields['Bad Key!']
      && job.extracted.seal_numbers === 'SL1, SL2' && job.extracted.notify_party === 'SAME AS CONSIGNEE' && !('mystery_key' in job.extracted)
      && job.containers.length === 1 && job.containers[0].size_type === '40HC' && job.items[0].packages === 19 && job.ai.detail.prompt_version === 'ai-doc-v3'
      && decl.docType === 'customs_declaration' && decl.ai.typeFrom === null && decl.extracted.declaration_type === 'import') || J({ job, decl });
  });
  await check('ocr.js (vm): finishAiJob — a reused stored reading keeps the saved type and opens with its reviewed values (no machine values over corrections)', () => {
    const i = ocr.indexOf('    function aiLevel('), j = ocr.indexOf('\n', ocr.indexOf('    function aiLevel('));
    const k = ocr.indexOf('    function finishAiJob('), l = ocr.indexOf('\n    }\n', k);
    const P = require(path.join(ROOT, 'assets', 'js', 'ocr-parse.js'));
    const c4 = { MAX_TEXT: 200000, ENGINE_AI: 'claude-opus-5-5', AI_DOC: {}, P, SAVE_KEYS: P.DB_FIELD_KEYS,
      DOC_TYPES: [['commercial_invoice', ''], ['operator_invoice', ''], ['bill_of_lading', ''], ['customs_declaration', ''], ['packing_list', ''], ['other', '']] };
    vm.createContext(c4);
    vm.runInContext(ocr.slice(i, j) + '\n' + ocr.slice(k, l + 7) + ';this.finishAiJob = finishAiJob;', c4);
    const job = { docType: 'commercial_invoice' };
    const row = { id: 'e1', doc_type: 'packing_list', reviewed_fields: { bl_number: 'FIXEDBL', notify_party: 'NP' }, line_items: [{ description: 'REVIEWED' }] };
    c4.finishAiJob(job, { usage_id: 'u5', reused: true, engine: 'claude-opus-5-5', extraction_id: 'e1', kind: 'packing_list', doc_type: 'bill_of_lading',
      detected_type: 'bill_of_lading', detected_documents: ['bill_of_lading'], savedRow: row, ai_detail: { prompt_version: 'ai-doc-v3' },
      fields: [{ name: 'bl_number', value: 'MACHINEBL', confidence: 0.9 }, { name: 'vessel', value: 'GONE', confidence: 0.9 }],
      line_items: [{ description: 'MACHINE' }], containers: [], warnings: [] });
    return (job.docType === 'packing_list' && job.fields.bl_number.value === 'FIXEDBL' && job.fields.bl_number.source === 'manual'
      && !job.fields.vessel && job.fields.notify_party.value === 'NP' && job.items[0].description === 'REVIEWED' && job.saved.id === 'e1'
      && job.ai.detail === null && job.ai.reused === true && job.extracted.bl_number === 'MACHINEBL') || J(job);
  });
  await check('ocr.js: «حقول أخرى» section for unknown keys; FIELD_DEFS cover every v3 / declaration key (extract.js) with ar + en labels; saves send DB keys only (+ ai_detail)', () => {
    const dicts = {};
    const reg = { register: (ns, d) => { dicts[ns] = d; } };
    { const c3 = { window: { MarsaI18n: reg } }; vm.createContext(c3); vm.runInContext(rd('assets/i18n/ocr.js'), c3); }
    const want = X.V3_KEYS.concat(X.DECL_KEYS);
    const noDef = want.filter(k => ocr.indexOf("{ key: '" + k + "'") === -1);
    const noLbl = want.filter(k => !dicts.ocr.ar['f_' + k] || !dicts.ocr.en['f_' + k]);
    const P = require(path.join(ROOT, 'assets', 'js', 'ocr-parse.js'));
    const dbOk = X.SHIP_KEYS_V3.every(k => P.DB_FIELD_KEYS.indexOf(k) !== -1) && P.DB_FIELD_KEYS.every(k => X.SHIP_KEYS_V3.indexOf(k) !== -1);
    return (noDef.length === 0 && noLbl.length === 0 && dbOk && /plan\.push\(\{ id: 'other', keys: rest \}\);/.test(ocr) && dicts.ocr.ar.fx_sec_other && dicts.ocr.en.fx_sec_other
      && /extracted_fields: P\.plainFields\(j\.extracted \|\| \{\}, SAVE_KEYS\)/.test(ocr) && /rf = savedFields\(j\)/.test(ocr) && /\{ ai_detail: j\.ai\.detail \}/.test(ocr)
      && /id="ocr-containers" hidden/.test(html) && /id="ocr-items-head"/.test(html)) || J({ noDef, noLbl, dbOk });
  });
  await check('ocr-match.js: every slot is read with ai-doc-v3', () =>
    /var PROMPT = \{ invoice: 'ai-doc-v3', bl: 'ai-doc-v3', declaration: 'ai-doc-v3', packing: 'ai-doc-v3' \};/.test(rd('assets/js/ocr-match.js')) || 'PROMPT');
  await check('admin.js: AI card in the org view (admin), consent checkbox only when switching on, consent_ack sent only off → on', () =>
    (/return aiSettingsCard\(\)\.then/.test(adm) && /call\('aiGetSettings', S\.orgId\)/.test(adm) && /call\('aiSaveSettings', S\.orgId, payload\)/.test(adm)
      && /if \(on && !a\.enabled\) payload\.consent_ack = true;/.test(adm) && /consent\.hidden = !!a\.enabled \|\| !form\.elements\.ai_enabled\.checked;/.test(adm)
      && /on && !a\.enabled && !ack \? t\('ai_consent_required'\)/.test(adm)) || 'admin.js');
  await check('i18n: every ai key of the ocr / admin dictionaries exists in Arabic AND English; consent text names Anthropic in both', () => {
    const dicts = {};
    const reg = { register: (ns, d) => { dicts[ns] = d; } };
    for (const f of ['assets/i18n/ocr.js', 'assets/i18n/admin.js']) { const c3 = { window: { MarsaI18n: reg } }; vm.createContext(c3); vm.runInContext(rd(f), c3); }
    const miss = [];
    for (const ns of ['ocr', 'admin']) {
      const ar = dicts[ns].ar, en = dicts[ns].en;
      Object.keys(ar).filter(k => /^(ai_|engine_|f_vessel|f_voyage|f_port|f_shipper|f_consignee)/.test(k)).forEach(k => { if (!en[k]) miss.push(ns + '.' + k + ':en'); });
      Object.keys(en).filter(k => /^(ai_|engine_)/.test(k)).forEach(k => { if (!ar[k]) miss.push(ns + '.' + k + ':ar'); });
    }
    const consentOk = /Anthropic/.test(dicts.admin.ar.ai_consent) && /Anthropic/.test(dicts.admin.en.ai_consent)
      && /Anthropic/.test(dicts.ocr.ar.ai_note) && /Anthropic/.test(dicts.ocr.en.ai_note);
    return (miss.length === 0 && consentOk && Object.keys(dicts.admin.ar).filter(k => /^ai_/.test(k)).length >= 25) || J({ miss, consentOk });
  });
  await check('error strings: every MRS_AI_* code has Arabic (supa.js + i18n.js) and English (supa.js + i18n.js) text', () => {
    const i18 = rd('assets/js/i18n.js');
    const codes = ['MRS_AI_DISABLED', 'MRS_AI_DAILY_CAP', 'MRS_AI_BUDGET', 'MRS_AI_REFUSED', 'MRS_AI_TRUNCATED', 'MRS_AI_TOO_LARGE', 'MRS_AI_UNSUPPORTED', 'MRS_AI_UNAVAILABLE', 'MRS_AI_FAILED'];
    const bad = codes.filter(c => (supa.match(new RegExp(c + ':', 'g')) || []).length !== 2 || (i18.match(new RegExp(c + ':', 'g')) || []).length !== 2);
    return bad.length === 0 || bad.join(', ');
  });
  await check('ocr-parse.js: the 6 AI keys are known field keys (plainFields keeps them)', () => {
    const P = require(path.join(ROOT, 'assets', 'js', 'ocr-parse.js'));
    const out = P.plainFields({ vessel: { value: 'MSC' }, consignee: { value: 'C' }, secret: { value: 'x' } });
    return (J(out) === J({ vessel: 'MSC', consignee: 'C' }) && P.FIELD_KEYS.length >= 22 && P.FIELD_KEYS.every(k => X.ALL_KEYS.includes(k))) || J(out);
  });
  await check('sw.js: cache VERSION bumped for the changed assets (2026-11-14.2 or a later release)', () => {
    const v = (/^var VERSION = '(\d{4}-\d{2}-\d{2}\.\d+)';/m.exec(rd('sw.js')) || [])[1] || '';
    return v.localeCompare('2026-11-14.2', 'en', { numeric: true }) >= 0 || 'VERSION ' + v;
  });
}

/* ================================================================== main */
(async () => {
  console.log('Marsa — AI document reading tests (PGlite + mocked Claude; local only)');
  await secFile();
  await secPreflight();

  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  if (!QUIET) console.log('  loaded');

  await secGrants();
  await secSettings();
  await secReserve();
  await secReviewSql();
  await secExtractions();
  await secHelper();
  await secReviewHelper();
  await secHandler();
  await secV3();
  await secInboxLedger();
  await secStatic();
  await secFrontEnd();
  await check('no network call was attempted', () => fetchCalls === 0);
  await db.close();

  console.log('\n' + '-'.repeat(70));
  if (nFail) {
    console.log('FAILURES:');
    for (const f of fails) console.log('  - ' + f);
    console.log(`FAILED — ${nPass} passed, ${nFail} failed`);
    process.exit(1);
  }
  console.log(`OK — ${nPass} passed, 0 failed`);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
