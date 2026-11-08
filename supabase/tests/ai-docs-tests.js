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
  // later phases may follow this file (20261115000100 convert_in_place); none may sort before it unnoticed
  const LATER_PHASES = ['20261115000100_convert_in_place.sql'];
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
  await check('app.ai_* helpers: no API role, except ai_model / ai_usage_claimable for authenticated (the extraction trigger)', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') s
                         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND (p.proname LIKE 'ai\\_%' OR p.proname = 'tg_ai_usage_guard')`);
    const bad = r.filter(x => x.a || x.s || (x.u && !['ai_model', 'ai_usage_claimable'].includes(x.proname)));
    return (r.length === 9 && bad.length === 0) || J(r);
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
  await check('the ledger holds counts and money only (no text column beyond model / purpose / status)', async () => {
    const r = await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'ai_usage' AND data_type = 'text' ORDER BY 1`);
    return J(r.map(x => x.column_name)) === J(['model', 'purpose', 'status']) || J(r);
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
  await check('schema: field name enum per doc type (B/L: vessel / voyage / ports / containers / parties; invoice: VAT / totals; auto: all 22)', () => {
    const en = t => X.outputSchema(t).properties.fields.items.properties.name.enum;
    const bl = en('bill_of_lading'), inv = en('commercial_invoice'), sup = en('supplier_invoice'), cd = en('customs_declaration'), au = en('auto');
    return (['bl_number', 'vessel', 'voyage', 'port_of_loading', 'port_of_discharge', 'container_numbers', 'shipper', 'consignee'].every(k => bl.includes(k))
      && ['invoice_number', 'invoice_date', 'currency', 'subtotal', 'vat_amount', 'total', 'supplier_vat', 'hs_codes'].every(k => inv.includes(k))
      && sup.includes('iban') && cd.includes('declaration_number') && cd.includes('hs_codes') && au.length === 22 && !bl.includes('iban')
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
      { name: 'vessel', value: 'not an invoice field', confidence: 0.9, page: 1 }] }, 'commercial_invoice');
    const c = r.warnings.map(w => w.code);
    const f = Object.fromEntries(r.fields.map(x => [x.name, x]));
    return (f.supplier_vat.value === '300000000000003' && f.supplier_vat.valid && f.buyer_vat.valid === false && c.includes('vat_format')
      && c.includes('date_format') && c.includes('totals_mismatch') && c.includes('vat_rate') && f.currency.value === 'SAR' && f.subtotal.value === '1000'
      && !f.vessel && r.line_items.length === 1 && r.line_items[0].hs_code === '8708.30' && r.kind === 'commercial_invoice') || J({ c, f, items: r.line_items });
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
      && r.raw_text.length <= 200000 && /^\[claude-opus-5-5 · ai-doc-v1\]/.test(r.raw_text)) || J({ keysOk, n: r.line_items.length });
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
    serviceClient: () => ({ rpc: (name, args) => { calls.push(name); d.last = d.last || {}; d.last[name] = args; return x.settleFails && name === 'ai_settle' ? Promise.resolve({ data: null, error: { message: 'down' } }) : sqlRpc('service', name, args); } }),
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
      && /c\.functions\.invoke\('ai-extract', \{ body: body \}\)/.test(supa) && /'ai_usage_id'\];/.test(supa)
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
  await check('ocr.html: the AI engine group is hidden by default and its note names Anthropic; Tesseract checked by default', () =>
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
    return (J(out) === J({ vessel: 'MSC', consignee: 'C' }) && P.FIELD_KEYS.length === 22) || J(out);
  });
  await check('sw.js: cache VERSION bumped for the changed assets', () => /^var VERSION = '2026-11-14\.2';/m.test(rd('sw.js')) || 'VERSION not bumped');
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
