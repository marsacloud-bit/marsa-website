#!/usr/bin/env node
/*
  Marsa (مرسى) — migration 20261208000100_ai_providers.sql + the ai-extract provider chain (owner, 21 Nov 2026: the AI
  reading tries the providers in the order each organisation chooses — e.g. OpenAI, then Gemini, then Claude).
  LOCAL TESTS ONLY. PGlite (in-memory Postgres), mocked providers, no network.
  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea", org B).

  Covers: file conventions + all_migrations.sql; preflight refusal; re-run keeps tuned model ids; the providers table
  (RLS, no API role); the order setting (default Claude only, validation, consent per provider, audit row); the chain
  in ai_access (order, consent, inactive provider); ai_settle keeps provider + attempts (codes and numbers only); an
  OpenAI / Gemini reading can be saved (engine = its model id, still bound to its usage row); the request / answer
  shapes of OpenAI and Gemini; the handler: fallback in order, every attempt settled at its own model, a provider
  without its key skipped, an older database (no providers list) = Claude only; index.ts keeps the keys.

  usage:
    node supabase/tests/ai-providers-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const MIG = '20261208000100_ai_providers.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const FN_DIR = path.join(SUPA, 'functions', 'ai-extract');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in ai-providers-tests'); };

const A = '0b5e0000-0000-4000-8000-000000000001';
const B = 'deca0000-0000-4000-8000-0000000000f0';
const U = {
  admin: 'deca0000-0000-4000-8000-000000000041',   // admin of A
  staff: 'deca0000-0000-4000-8000-000000000042',   // accountant of A
  adminB: 'deca0000-0000-4000-8000-000000000043'   // admin of B
};

let db;
async function asRole(who, fn) {
  if (who === 'anon') await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  else if (who === 'service') await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  else {
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[who], role: 'authenticated', aal: 'aal2' })]);
    await db.exec(`SET ROLE authenticated;`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const one = async (sql, params) => (await q(sql, params))[0];
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const J = x => JSON.stringify(x);
async function check(name, fn) {
  try {
    const r = await fn();
    if (typeof r === 'string') fail(name, r);
    else if (r === false || r === null || r === 0 || r === undefined) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + errText(e)); }
}
async function code(fn) {
  try { await fn(); return 'ok'; } catch (e) {
    const m = e.message || '';
    if (/^MRS_/.test(m)) return m + (e.detail ? ' ' + e.detail : '');
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
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@prov.example.com', now()), ('${U.staff}', 'staff@prov.example.com', now()),
    ('${U.adminB}', 'adminb@prov.example.com', now());
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'prov-org-b', 'مؤسسة ب', 'Providers org B', 'PVB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.staff}', '${A}', NULL, 'accountant'), ('${U.adminB}', '${B}', NULL, 'admin');
`;
const saveS = (who, p, org) => as(who, `SELECT public.ai_save_settings($1, $2) r`, [org || A, J(p)]).then(r => r[0].r);
const access = (who, org) => as(who, `SELECT public.ai_access($1) r`, [org || A]).then(r => r[0].r);

/* ------------------------------------------------------------------ 1. the file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('preflight on driver_classes, its schema_versions row, no BEGIN / COMMIT, no key, no endpoint', () =>
    (/version = '20261207000100'/.test(s) && /VALUES \('20261208000100', 'ai_providers'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s)
      && !/sk-ant|sk-[A-Za-z0-9]{20}|AIza|_API_KEY|api\.openai\.com|googleapis\.com|api\.anthropic\.com/.test(s)) || 'conventions');
  await check('all_migrations.sql: this file verbatim, last, in order', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    return (i > 0 && (body === s || body + '\n' === s) && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles())) || 'bundle';
  });
  const LATER_PHASES = ['20261209000100_ai_keys.sql', '20261210000100_org_served_ports.sql'];
  await check('this file is the latest migration (later phases excepted)', () => JSON.stringify(migFiles().filter(f => f > MIG)) === JSON.stringify(LATER_PHASES) || 'later ' + JSON.stringify(migFiles().filter(f => f > MIG)));
  await check('the extraction trigger is the 20261119000100 body with the engine check only changed', () => {
    const old = fs.readFileSync(path.join(MIG_DIR, '20261119000100_legacy_docs.sql'), 'utf8');
    const cut = t => { const a = t.indexOf('CREATE OR REPLACE FUNCTION app.tg_document_extractions_before()'); return t.slice(a, t.indexOf('END $$;', a)); };
    const norm = t => cut(t).replace(/IF NEW\.ai_usage_id IS NOT NULL OR app\.ai_is_engine\(NEW\.engine\) THEN\s+-- PROVIDERS/, 'IF NEW.ai_usage_id IS NOT NULL OR NEW.engine = app.ai_model() THEN')
      .replace(/IF NEW\.ai_usage_id IS NULL OR NOT app\.ai_is_engine\(NEW\.engine\)\s+-- PROVIDERS/, 'IF NEW.ai_usage_id IS NULL OR NEW.engine IS DISTINCT FROM app.ai_model()');
    return (norm(s) === cut(old) && (s.match(/-- PROVIDERS/g) || []).length >= 8) || 'trigger body differs';
  });
}

async function secRerun() {
  section('2. preflight + re-run');
  const d = await freshDb(MIG);
  await d.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  const saved = db; db = d;
  try {
    await check('preflight: refused without driver_classes (schema_versions row removed)', async () => {
      await q(`DELETE FROM public.schema_versions WHERE version = '20261207000100'`);
      const r = await code(() => db.exec(fs.readFileSync(MIG_FILE, 'utf8')));
      await q(`INSERT INTO public.schema_versions (version, name) VALUES ('20261207000100', 'driver_classes')`);
      return /AI PROVIDERS preflight/.test(r) || r;
    });
    await check('applies, then re-runs; a tuned model id and an existing order are kept', async () => {
      await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      await q(`UPDATE app.ai_providers SET model = 'gpt-tuned-1' WHERE provider = 'openai'`);
      await q(`INSERT INTO app.ai_settings (org_id, enabled, consent_ack_at, consent_ack_by, consent_version, provider_order, consent_providers)
               VALUES ($1, true, now(), $2, 'ai-doc-inbox-v2', ARRAY['openai','anthropic'], ARRAY['openai','anthropic'])`, [A, '00000000-0000-0000-0000-000000000001']);
      await db.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      const r = await one(`SELECT (SELECT model FROM app.ai_providers WHERE provider = 'openai') m, (SELECT count(*)::int FROM app.ai_providers) n,
                                  (SELECT provider_order FROM app.ai_settings WHERE org_id = $1) o`, [A]);
      return (r.m === 'gpt-tuned-1' && r.n === 3 && J(r.o) === J(['openai', 'anthropic'])) || J(r);
    });
    await check('an existing consent (given before this file) is recorded as naming Anthropic only', async () => {
      const d2 = await freshDb(MIG);
      await d2.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
      try {
        await d2.query(`INSERT INTO app.ai_settings (org_id, enabled, consent_ack_at, consent_ack_by, consent_version) VALUES ($1, true, now(), $2, 'ai-doc-inbox-v2')`,
          [A, '00000000-0000-0000-0000-000000000001']);
        await d2.exec(fs.readFileSync(MIG_FILE, 'utf8'));
        const r = (await d2.query(`SELECT provider_order o, consent_providers c FROM app.ai_settings WHERE org_id = $1`, [A])).rows[0];
        return (J(r.o) === J(['anthropic']) && J(r.c) === J(['anthropic'])) || J(r);
      } finally { await d2.close(); }
    });
  } finally { db = saved; await d.close(); }
}

/* ------------------------------------------------------------------ 3. SQL */
async function secSql() {
  section('3. providers, the order, the consent, the chain, the ledger');
  await check('app.ai_providers: anthropic / openai / gemini seeded, RLS on, no API role can read it', async () => {
    const r = await q(`SELECT provider, model FROM app.ai_providers ORDER BY sort`);
    const k = await one(`SELECT c.relrowsecurity rls, has_table_privilege('anon', c.oid, 'SELECT') a, has_table_privilege('authenticated', c.oid, 'SELECT') u,
                                has_table_privilege('service_role', c.oid, 'SELECT') s FROM pg_class c WHERE c.oid = 'app.ai_providers'::regclass`);
    return (J(r.map(x => x.provider)) === J(['anthropic', 'openai', 'gemini']) && r[0].model === 'claude-opus-5-5' && k.rls && !k.a && !k.u && !k.s) || J({ r, k });
  });
  await check('default: off, order {anthropic}, no chain; the settings list the active providers with their models', async () => {
    const s = await as('admin', `SELECT public.ai_get_settings($1) r`, [A]).then(r => r[0].r);
    const a = await access('staff');
    return (s.enabled === false && J(s.provider_order) === J(['anthropic']) && J(s.consent_providers) === J([])
      && J(s.providers.map(p => p.provider)) === J(['anthropic', 'openai', 'gemini']) && J(a.providers) === J([])) || J({ s, a });
  });
  await check('switching on with the default order: consent required; then the chain is Claude alone', async () => {
    const no = await code(() => saveS('admin', { enabled: true }));
    const s = await saveS('admin', { enabled: true, consent_ack: true });
    const a = await access('staff');
    return (no === 'MRS_REQUIRED ai_consent' && J(s.consent_providers) === J(['anthropic'])
      && J(a.providers.map(p => p.provider + '/' + p.model)) === J(['anthropic/claude-opus-5-5'])) || J({ no, s: s.consent_providers, a: a.providers });
  });
  await check('order OpenAI → Gemini → Claude while on: a provider the consent did not name needs consent again; then the chain follows the order', async () => {
    const no = await code(() => saveS('admin', { provider_order: ['openai', 'gemini', 'anthropic'] }));
    const still = await access('staff');
    const s = await saveS('admin', { provider_order: ['openai', 'gemini', 'anthropic'], consent_ack: true });
    const a = await access('staff');
    return (no === 'MRS_REQUIRED ai_consent' && J(still.providers.map(p => p.provider)) === J(['anthropic'])
      && J(s.provider_order) === J(['openai', 'gemini', 'anthropic']) && J(s.consent_providers) === J(['openai', 'gemini', 'anthropic'])
      && J(a.providers.map(p => p.provider + '/' + p.model)) === J(['openai/gpt-6.2-astra', 'gemini/gemini-3.8-flash', 'anthropic/claude-opus-5-5']))
      || J({ no, still: still.providers, s, a: a.providers });
  });
  await check('re-ordering within the consented providers needs no new consent; the change is in the audit log', async () => {
    const s = await saveS('admin', { provider_order: ['gemini', 'openai'] });
    const a = await access('staff');
    const l = await one(`SELECT changed_fields f FROM public.audit_log WHERE table_name = 'ai_settings' AND org_id = $1 ORDER BY id DESC LIMIT 1`, [A]);
    return (J(s.provider_order) === J(['gemini', 'openai']) && J(a.providers.map(p => p.provider)) === J(['gemini', 'openai']) && l.f.includes('provider_order')) || J({ s: s.provider_order, a: a.providers, l });
  });
  await check('invalid orders refused (empty, 4 items, duplicate, unknown, not a string, not an array)', async () => {
    const r = [];
    for (const o of [[], ['openai', 'gemini', 'anthropic', 'openai'], ['openai', 'openai'], ['mistral'], ['openai', 3], 'openai']) r.push(await code(() => saveS('admin', { provider_order: o })));
    return r.every(x => x === 'MRS_INVALID provider_order') || J(r);
  });
  await check('only an org admin saves the order; another org\'s admin cannot; anon cannot', async () => {
    const r = [await code(() => saveS('staff', { provider_order: ['anthropic'] })), await code(() => saveS('adminB', { provider_order: ['anthropic'] }, A)),
      await code(() => as('anon', `SELECT public.ai_save_settings($1, $2)`, [A, J({ provider_order: ['anthropic'] })]))];
    return J(r) === J(['MRS_FORBIDDEN', 'MRS_FORBIDDEN', 'perm']) || J(r);
  });
  await check('an inactive provider drops out of the chain (and cannot be chosen); back when active again', async () => {
    await q(`UPDATE app.ai_providers SET is_active = false WHERE provider = 'gemini'`);
    const a = await access('staff');
    const no = await code(() => saveS('admin', { provider_order: ['gemini'] }));
    await q(`UPDATE app.ai_providers SET is_active = true WHERE provider = 'gemini'`);
    const b = await access('staff');
    return (J(a.providers.map(p => p.provider)) === J(['openai']) && no === 'MRS_INVALID provider_order' && J(b.providers.map(p => p.provider)) === J(['gemini', 'openai'])) || J({ a, no, b });
  });
  await check('switching off empties the chain; switching on again stamps the consent for the whole order', async () => {
    await saveS('admin', { enabled: false });
    const off = await access('staff');
    const s = await saveS('admin', { enabled: true, consent_ack: true, provider_order: ['openai', 'anthropic'] });
    const a = await access('staff');
    return (J(off.providers) === J([]) && J(s.consent_providers) === J(['openai', 'anthropic']) && J(a.providers.map(p => p.provider)) === J(['openai', 'anthropic'])) || J({ off, s, a });
  });
  let usage;
  await check('ai_settle keeps the provider and each attempt (codes and numbers only), prices each attempt at its own model', async () => {
    await q(`INSERT INTO app.ai_prices (model, input_usd_per_mtok, output_usd_per_mtok) VALUES ('gpt-6.2-astra', 2, 8) ON CONFLICT (model) DO NOTHING`);
    usage = await as('service', `SELECT public.ai_reserve($1, $2, 'doc_extract', 1.5) r`, [A, U.staff]).then(r => r[0].r);
    const st = await as('service', `SELECT public.ai_settle($1, 0, 0, 'ok', 'claude-opus-5-5', $2) r`, [usage, J([
      { model: 'gpt-6.2-astra', input_tokens: 1000, output_tokens: 0, provider: 'openai', outcome: 'bad_output', ms: 4200.4, junk: 'x' },
      { model: 'claude-opus-5-5', input_tokens: 2000, output_tokens: 500, provider: 'anthropic', outcome: 'ok', ms: 9000 }])]).then(r => r[0].r);
    const u = await one(`SELECT provider, call_meta m, cost_usd::float c FROM app.ai_usage WHERE id = $1`, [usage]);
    return (u.provider === 'anthropic' && J(u.m) === J([{ ms: 4200, model: 'gpt-6.2-astra', outcome: 'bad_output', provider: 'openai' },
      { ms: 9000, model: 'claude-opus-5-5', outcome: 'ok', provider: 'anthropic' }]) && u.c === (1000 * 2 + 2000 * 4 + 500 * 20) / 1e6 && st.status === 'ok') || J({ u, st });
  });
  await check('a failed reading keeps its attempts but no provider; a bad provider code / outcome is dropped, not stored', async () => {
    const id = await as('service', `SELECT public.ai_reserve($1, $2, 'doc_extract', 1.5) r`, [A, U.staff]).then(r => r[0].r);
    await as('service', `SELECT public.ai_settle($1, 0, 0, 'error', NULL, $2)`, [id, J([{ model: 'gpt-6.2-astra', input_tokens: 0, output_tokens: 0, provider: 'openai', outcome: 'upstream busy!' },
      { model: 'gemini-3.8-flash', input_tokens: 0, output_tokens: 0, provider: 'Gemini<script>', outcome: 'x' }])]);
    const u = await one(`SELECT provider, call_meta m FROM app.ai_usage WHERE id = $1`, [id]);
    return (u.provider === null && J(u.m) === J([{ model: 'gpt-6.2-astra', provider: 'openai' }])) || J(u);
  });
  await check('usage by provider + fallbacks in the settings', async () => {
    const s = await as('admin', `SELECT public.ai_get_settings($1) r`, [A]).then(r => r[0].r);
    return (s.usage.month.by_provider.anthropic === 1 && s.usage.month.fell_back === 1) || J(s.usage.month);
  });
  await check('an OpenAI reading is saved with engine = its model id and its usage row; a model id without a usage row, or an unknown engine with one, is refused', async () => {
    const id = await as('service', `SELECT public.ai_reserve($1, $2, 'doc_extract', 1.5) r`, [A, U.staff]).then(r => r[0].r);
    await as('service', `SELECT public.ai_settle($1, 100, 50, 'ok', 'gpt-6.2-astra', NULL)`, [id]);
    const ins = (engine, uid) => code(() => as('staff', `INSERT INTO public.document_extractions (org_id, doc_type, source_name, source_sha256, engine, languages, raw_text,
          extracted_fields, line_items, created_by, ai_usage_id) VALUES ($1, 'bill_of_lading', 'bl.pdf', $2, $3, 'auto', '', '{"bl_number":"MEDU1234567"}', '[]', $4, $5)`,
      [A, (Math.random().toString(16).slice(2) + '0'.repeat(64)).slice(0, 64), engine, U.staff, uid]));
    const r = [await ins('gpt-6.2-astra', id), await ins('gpt-6.2-astra', null), await ins('made-up-model', usage)];
    return J(r) === J(['ok', 'MRS_INVALID ai_usage_id', 'MRS_INVALID ai_usage_id']) || J(r);
  });
  await check('helpers: ai_provider_chain no API role; ai_is_engine authenticated only (the trigger)', async () => {
    const r = await q(`SELECT p.proname n, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') s, p.prosecdef d
                         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname IN ('ai_provider_chain', 'ai_is_engine') ORDER BY 1`);
    return J(r) === J([{ n: 'ai_is_engine', a: false, u: true, s: false, d: true }, { n: 'ai_provider_chain', a: false, u: false, s: false, d: true }]) || J(r);
  });
}

/* ------------------------------------------------------------------ 4. extract.js: request / answer shapes */
const X = require(path.join(FN_DIR, 'extract.js'));
const H = require(path.join(FN_DIR, 'handler.js'));
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64');
const PDF = Buffer.from('%PDF-1.7\n%test only\n').toString('base64');
const modelOut = () => ({ doc_type: 'bill_of_lading', fields: [{ name: 'bl_number', value: 'MEDUJD123456', confidence: 0.97, page: null },
  { name: 'vessel', value: 'MSC TEST', confidence: 0.88, page: null }], line_items: [], warnings: [] });
const vReq = o => X.validateRequest(Object.assign({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }, o || {}));

async function secShapes() {
  section('4. extract.js: OpenAI / Gemini request and answer shapes');
  await check('OpenAI body: the same system prompt, the file first (image / PDF), JSON mode with the schema in the text, nothing stored, max tokens + effort', () => {
    const p = X.buildRequest(vReq());
    const b = X.buildOpenAi(p, 'gpt-6.2-astra');
    const bp = X.buildOpenAi(X.buildRequest(vReq({ file: { media_type: 'application/pdf', data_b64: PDF } })), 'gpt-6.2-astra');
    const c = b.input[0].content;
    return (b.model === 'gpt-6.2-astra' && b.instructions === p.system && b.store === false && b.max_output_tokens === p.max_tokens
      && b.reasoning.effort === 'medium' && b.text.format.type === 'json_object' && c[0].type === 'input_image' && c[0].image_url === 'data:image/png;base64,' + PNG
      && c[1].type === 'input_text' && c[1].text.includes(J(p.output_config.format.schema)) && /JSON/.test(c[1].text)
      && bp.input[0].content[0].type === 'input_file' && bp.input[0].content[0].file_data === 'data:application/pdf;base64,' + PDF) || J(b).slice(0, 400);
  });
  await check('Gemini body: systemInstruction, inline file first, JSON response, max output tokens', () => {
    const p = X.buildRequest(vReq());
    const b = X.buildGemini(p);
    const parts = b.contents[0].parts;
    return (b.systemInstruction.parts[0].text === p.system && parts[0].inlineData.mimeType === 'image/png' && parts[0].inlineData.data === PNG
      && parts[1].text.includes(J(p.output_config.format.schema)) && b.generationConfig.responseMimeType === 'application/json'
      && b.generationConfig.maxOutputTokens === p.max_tokens) || J(b).slice(0, 400);
  });
  await check('OpenAI answer: completed → text (code fence removed), tokens, served model; refusal / max_output_tokens / content_filter mapped', () => {
    const ok = X.normOpenAi({ status: 'completed', model: 'gpt-6.2-astra-2026-10', usage: { input_tokens: 1200, output_tokens: 300 },
      output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '```json\n' + J(modelOut()) + '\n```' }] }] }, 'gpt-6.2-astra');
    const a = X.parseAnswer(ok, 'ai-doc-v2', 'bill_of_lading');
    const r = [X.normOpenAi({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, 'm').stop,
      X.normOpenAi({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'm').stop,
      X.normOpenAi({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'm').stop, X.normOpenAi(null, 'm').stop];
    return (a.ok && a.data.fields[0].value === 'MEDUJD123456' && a.model === 'gpt-6.2-astra-2026-10' && J(a.usage.attempts) === J([{ model: 'gpt-6.2-astra-2026-10', input_tokens: 1200, output_tokens: 300 }])
      && J(r) === J(['refusal', 'max_tokens', 'refusal', 'other'])) || J({ a, r });
  });
  await check('Gemini answer: STOP → text without thought parts; thinking tokens count as output; block / safety / MAX_TOKENS mapped', () => {
    const ok = X.normGemini({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'thinking…' }, { text: J(modelOut()) }] } }],
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 400, thoughtsTokenCount: 600 }, modelVersion: 'gemini-3.8-flash' }, 'gemini-3.8-flash');
    const a = X.parseAnswer(ok, 'ai-doc-v2', 'bill_of_lading');
    const r = [X.normGemini({ promptFeedback: { blockReason: 'SAFETY' } }, 'm').stop, X.normGemini({ candidates: [{ finishReason: 'SAFETY' }] }, 'm').stop,
      X.normGemini({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'm').stop, X.normGemini({ candidates: [{ finishReason: 'OTHER' }] }, 'm').stop];
    return (a.ok && a.usage.output_tokens === 1000 && a.usage.input_tokens === 1500 && J(r) === J(['refusal', 'refusal', 'max_tokens', 'other'])) || J({ a, r });
  });
  await check('an answer that is not the expected shape is bad_output (the next provider reads)', () => {
    const n = { stop: 'end_turn', text: J({ doc_type: 'bill_of_lading', fields: 'x' }), usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' };
    const n2 = Object.assign({}, n, { text: 'not json' });
    return (X.parseAnswer(n, 'ai-doc-v2', 'bill_of_lading').code === 'bad_output' && X.parseAnswer(n2, 'ai-doc-v2', 'bill_of_lading').code === 'bad_output') || 'shape';
  });
  await check('HTTP errors: 429 busy (nothing billed), 401 / 403 not configured, 5xx / lost connection unknown (may have run), not sent → no charge', () => {
    const r = [{ status: 429 }, { status: 401 }, { status: 400 }, { status: 500 }, { status: 503 }, new Error('reset'), { notSent: true }].map(e => {
      const c = X.classifyHttpError(e); return c.code + '/' + c.settle; });
    return J(r) === J(['upstream_busy/error', 'not_configured/error', 'upstream_error/error', 'upstream_error/unknown', 'upstream_busy/unknown',
      'upstream_error/unknown', 'not_configured/error']) || J(r);
  });
  await check('providerChain: the order kept, unknown / duplicate / keyless providers skipped, a bad model id skipped; no list = Claude alone', () => {
    const acc = { providers: [{ provider: 'openai', model: 'gpt-6.2-astra' }, { provider: 'mistral', model: 'x' }, { provider: 'openai', model: 'gpt-2' },
      { provider: 'gemini', model: 'Bad Model!' }, { provider: 'anthropic', model: 'anything' }] };
    const r1 = X.providerChain(acc, { anthropic: true, openai: true, gemini: true });
    const r2 = X.providerChain(acc, { anthropic: false, openai: true });
    const r3 = X.providerChain({}, { anthropic: true, openai: true });
    return (J(r1) === J([{ provider: 'openai', model: 'gpt-6.2-astra' }, { provider: 'anthropic', model: 'claude-opus-5-5' }])
      && J(r2) === J([{ provider: 'openai', model: 'gpt-6.2-astra' }]) && J(r3) === J([{ provider: 'anthropic', model: 'claude-opus-5-5' }])) || J({ r1, r2, r3 });
  });
}

/* ------------------------------------------------------------------ 5. handler.js with mocked providers */
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
    calls, X, sdk: {}, configured: true, modelConfigured: x.claudeKey !== false,
    ready: { openai: x.openaiKey !== false, gemini: x.geminiKey !== false },
    isAnonKey: t => t === 'anon-key', log: t => calls.push('log:' + t),
    userClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: U.staff } }, error: null }) },
      rpc: (name, args) => { calls.push('user:' + name); return x.oldAccess ? sqlRpc('staff', name, args).then(r => { if (r.data) delete r.data.providers; return r; }) : sqlRpc('staff', name, args); },
      from: () => { const q2 = { select: () => q2, eq: () => q2, maybeSingle: async () => ({ data: null, error: null }) }; return q2; }
    }),
    serviceClient: () => ({ rpc: (name, args) => { calls.push(name); d.last = d.last || {}; d.last[name] = args; return sqlRpc('service', name, args); } }),
    send: async (provider, model, body, opts) => {
      calls.push(provider); d.sent = (d.sent || []).concat([{ provider, model, body, opts }]);
      const r = x[provider];
      if (typeof r === 'function') return r(body, opts);
      if (r instanceof Error) throw r;
      return r;
    },
    claudeClient: () => ({ beta: { messages: { stream: (params) => { calls.push('anthropic'); d.claudeParams = params;
      return { finalMessage: () => x.claude instanceof Error ? Promise.reject(x.claude) : Promise.resolve(x.claude || {
        id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: J(modelOut()) }],
        usage: { input_tokens: 2100, output_tokens: 900 } }) }; } } } })
  };
  return d;
}
const hReq = body => new Request('https://edge.example/functions/v1/ai-extract', { method: 'POST',
  headers: { origin: 'https://marsacloud.com', authorization: 'Bearer user-token', 'content-type': 'application/json' }, body: J(body) });
const v3Body = () => ({ org_id: A, doc_type: 'bill_of_lading', prompt_version: 'ai-doc-v3', file: { media_type: 'image/png', data_b64: PNG } });
const v3Out = () => ({ doc_type: 'bill_of_lading', detected_documents: ['bill_of_lading'], fields: [{ name: 'bl_number', value: 'MEDUJD123456', confidence: 0.97, page: null, document: 'bill_of_lading' }],
  line_items: [], containers: [], warnings: [] });
const openaiOk = (out, model) => ({ status: 200, json: { status: 'completed', model: model || 'gpt-6.2-astra', usage: { input_tokens: 1000, output_tokens: 200 },
  output: [{ type: 'message', content: [{ type: 'output_text', text: J(out || modelOut()) }] }] } });
const geminiOk = out => ({ status: 200, json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: J(out || modelOut()) }] } }],
  usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 100, thoughtsTokenCount: 50 } } });
const lastUsage = () => one(`SELECT status, provider, call_meta m, model, input_tokens i, output_tokens o, reserved_usd::float h FROM app.ai_usage ORDER BY created_at DESC, id DESC LIMIT 1`);
const order = d => d.calls.filter(c => !/^log:/.test(c));

async function secHandler() {
  section('5. handler.js: the providers in the organisation\'s order (mocked)');
  await q(`UPDATE app.ai_settings SET daily_request_cap = 1000, monthly_budget_usd = 1000 WHERE org_id = $1`, [A]);
  await saveS('admin', { provider_order: ['openai', 'gemini', 'anthropic'], consent_ack: true });
  await check('OpenAI first answers: 200 from OpenAI, engine = the model id asked for (model = the dated id served), Gemini / Claude not called, settled at OpenAI\'s tokens; the hold covers 3 providers', async () => {
    const d = hDeps({ openai: openaiOk(null, 'gpt-6.2-astra-2026-10-01') });
    const r = await H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }), d);
    const b = JSON.parse(r.body); const u = await lastUsage();
    return (r.status === 200 && J(order(d)) === J(['user:ai_access', 'ai_reserve', 'openai', 'ai_settle']) && b.engine === 'gpt-6.2-astra' && b.model === 'gpt-6.2-astra-2026-10-01'
      && b.extracted_fields.vessel === 'MSC TEST' && u.status === 'ok' && u.provider === 'openai' && u.i === 1000 && u.o === 200 && u.h === Math.round(0.88 * 3 * 1e4) / 1e4
      && d.sent[0].opts.deadlineMs > 0 && d.sent[0].opts.deadlineMs <= X.PROVIDER_DEADLINE_MS) || J({ s: r.status, b, u, o: order(d) });
  });
  await check('OpenAI down (500) → Gemini answers: 200 from Gemini; both attempts in the ledger; fell_back + tried in the v3 answer', async () => {
    const d = hDeps({ openai: { status: 500, json: null }, gemini: geminiOk(v3Out()) });
    const r = await H.handleRequest(hReq(v3Body()), d);
    const b = JSON.parse(r.body); const u = await lastUsage();
    return (r.status === 200 && J(order(d)) === J(['user:ai_access', 'ai_reserve', 'ai_bind_source', 'openai', 'gemini', 'ai_settle']) && b.provider === 'gemini' && b.fell_back === true
      && J(b.tried.map(t => t.provider + ':' + t.outcome)) === J(['openai:upstream_error', 'gemini:ok']) && b.engine === 'gemini-3.8-flash'
      && u.status === 'ok' && u.provider === 'gemini' && J(u.m.map(m => m.provider + ':' + m.outcome)) === J(['openai:upstream_error', 'gemini:ok']) && u.o === 150) || J({ s: r.status, b, u });
  });
  await check('OpenAI answers the wrong shape, Gemini refuses → Claude reads; every attempt priced (tokens summed)', async () => {
    const d = hDeps({ openai: { status: 200, json: { status: 'completed', usage: { input_tokens: 500, output_tokens: 20 }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"x":1}' }] }] } },
      gemini: { status: 200, json: { candidates: [{ finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 700 } } } });
    const r = await H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }), d);
    const b = JSON.parse(r.body); const u = await lastUsage();
    return (r.status === 200 && J(order(d).slice(2, 5)) === J(['openai', 'gemini', 'anthropic']) && b.engine === 'claude-opus-5-5' && u.provider === 'anthropic'
      && J(u.m.map(m => m.provider + ':' + m.outcome)) === J(['openai:bad_output', 'gemini:refused', 'anthropic:ok']) && u.i === 500 + 700 + 2100 && u.o === 20 + 0 + 900) || J({ s: r.status, b, u });
  });
  await check('all three fail (429 / 429 / Claude busy): 503 upstream_busy, settled error at no cost, nothing returned', async () => {
    const busy = Object.assign(new Error('busy'), { status: 429 });
    const d = hDeps({ openai: { status: 429, json: null }, gemini: { status: 429, json: null }, claude: busy });
    const r = await H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }), d);
    const u = await lastUsage();
    return (r.status === 503 && JSON.parse(r.body).error === 'upstream_busy' && u.status === 'error' && u.provider === null && u.m.length === 3) || J({ s: r.status, b: r.body, u });
  });
  await check('a lost connection may have run: the next provider still reads, and the reading is settled ok (its tokens)', async () => {
    const d = hDeps({ openai: new Error('connection reset'), gemini: geminiOk() });
    const r = await H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }), d);
    const u = await lastUsage();
    return (r.status === 200 && u.status === 'ok' && u.provider === 'gemini') || J({ s: r.status, u });
  });
  await check('all fail and one may have run → settled unknown (the hold is charged)', async () => {
    const d = hDeps({ openai: { status: 500, json: null }, gemini: { status: 400, json: null }, claude: Object.assign(new Error('bad'), { status: 400 }) });
    const r = await H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }), d);
    const u = await one(`SELECT status, unknown_outcome uo, cost_usd::float c, reserved_usd::float h FROM app.ai_usage ORDER BY created_at DESC, id DESC LIMIT 1`);
    return (r.status >= 500 && u.status === 'error' && u.uo === true && u.c === u.h) || J({ s: r.status, u });
  });
  await check('a provider without its key is skipped (no OpenAI key → Gemini first); the hold covers the providers left', async () => {
    const d = hDeps({ openaiKey: false, gemini: geminiOk() });
    const r = await H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }), d);
    const u = await lastUsage();
    return (r.status === 200 && !order(d).includes('openai') && order(d).includes('gemini') && u.h === Math.round(0.88 * 2 * 1e4) / 1e4) || J({ s: r.status, o: order(d), u });
  });
  await check('no key for any provider in the order → 503 not_configured, nothing reserved', async () => {
    const n0 = (await one(`SELECT count(*)::int n FROM app.ai_usage`)).n;
    const d = hDeps({ openaiKey: false, geminiKey: false, claudeKey: false });
    const r = await H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }), d);
    const n1 = (await one(`SELECT count(*)::int n FROM app.ai_usage`)).n;
    return (r.status === 503 && JSON.parse(r.body).error === 'not_configured' && n0 === n1) || J({ s: r.status, n0, n1 });
  });
  await check('an older database (ai_access without providers) → Claude alone, as before (OpenAI never called)', async () => {
    const d = hDeps({ oldAccess: true, openai: openaiOk() });
    const r = await H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }), d);
    return (r.status === 200 && J(order(d)) === J(['user:ai_access', 'ai_reserve', 'anthropic', 'ai_settle']) && d.last.ai_settle.p_attempts.every(a => !('provider' in a))) || J({ s: r.status, o: order(d) });
  });
  await check('a slow provider that is not the last leaves time for the next: OpenAI is given at most PROVIDER_DEADLINE_MS; no time left → the next is not tried', async () => {
    let t = 0;
    const d = hDeps({ openai: () => { t += 140000; throw new Error('aborted'); }, gemini: geminiOk() });
    d.now = () => t;
    const r = await H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }), d);
    return (r.status >= 500 && !order(d).includes('gemini') && d.calls.includes('log:ai-extract: no time left for the next provider') && d.sent[0].opts.deadlineMs === X.PROVIDER_DEADLINE_MS) || J({ s: r.status, o: order(d) });
  });
}

/* ------------------------------------------------------------------ 6. static: keys stay in index.ts */
async function secStatic() {
  section('6. static: the keys and the network stay in index.ts');
  const idx = fs.readFileSync(path.join(FN_DIR, 'index.ts'), 'utf8');
  await check('index.ts: each key read once from Deno.env and used only in that provider\'s request header; never logged or returned', () => {
    // 20261209000100: the request's `keys` (the page key from Vault, else the secret); used in that provider's headers only
    const r = ['OPENAI_API_KEY', 'GEMINI_API_KEY'].map(k => (idx.match(new RegExp("Deno\\.env\\.get\\('" + k + "'\\)", 'g')) || []).length);
    const o = idx.match(/keys\.openai\b/g) || [], g = idx.match(/keys\.gemini\b/g) || [];
    return (J(r) === J([1, 1]) && o.length === 6 && g.length === 6 && (idx.match(/headers\['authorization'\] = 'Bearer ' \+ keys\.openai;/g) || []).length === 2
      && (idx.match(/headers\['x-goog-api-key'\] = keys\.gemini;/g) || []).length === 2 && /ready: \{ openai: keys\.openai !== '', gemini: keys\.gemini !== '' \},/.test(idx)
      && /const r = await service\(\)\.rpc\('ai_provider_keys', \{ p_org: org \}\);/.test(idx) && /return ready\(\);/.test(idx)
      && J(idx.match(/console\.\w+\([^)]*\)/g)) === J(['console.error(text)'])) || J({ r, o: o.length, g: g.length });
  });
  await check('index.ts send(): the model id is checked before it goes into the Gemini address; a deadline aborts the call; the answer is never logged', () =>
    (/if \(!MODEL_ID\.test\(model\) \|\| !\(Number\.isFinite\(o\.deadlineMs\) && o\.deadlineMs > 0\)\) throw \{ notSent: true \};/.test(idx)
      && /setTimeout\(\(\) => ctl\.abort\(\), ms\)/.test(idx) && /clearTimeout\(timer\)/.test(idx) && /await httpJson\(target, \{ method: 'POST', headers, body: JSON\.stringify\(body\) \}, o\.deadlineMs\)/.test(idx)
      && !/log\(.*text/.test(idx)) || 'send');
  await check('front end: ocr.js isAiJob (Claude engine name or a usage row) runs and answers right', () => {
    const vm = require('vm');
    const src = fs.readFileSync(path.join(ROOT, 'assets/js/ocr.js'), 'utf8');
    const m = src.match(/function isAiJob\(j\) \{[^\n]*\}/);
    if (!m) return 'isAiJob missing';
    const box = { ENGINE_AI: 'claude-opus-5-5' }; vm.createContext(box);
    vm.runInContext(m[0] + '\nthis.f = isAiJob;', box);
    const r = [box.f({ engine: 'claude-opus-5-5' }), box.f({ engine: 'gpt-6.2-astra', ai: { usageId: 'u' } }), box.f({ engine: 'tesseract', ai: { usageId: null } }), box.f(null)];
    return J(r) === J([true, true, false, false]) || J(r);
  });
  await check('front end: every screen that saves a reading uses the engine the server names (res.engine), not a fixed Claude name', () => {
    const want = { 'assets/js/appt-cards.js': "engine: res.engine || 'claude-opus-5-5'", 'assets/js/decl-review.js': "engine: res.engine || 'claude-opus-5-5'",
      'assets/js/ops/tx-return.js': "engine: res.engine || 'claude-opus-5-5'", 'assets/js/doc-batch.js': "engine: o.engine || res.engine || 'claude-opus-5-5'",
      'assets/js/ocr-match.js': 'engine: res.engine || ENGINE_AI,', 'assets/js/ocr.js': 'j.engine = res.engine ? String(res.engine) : ENGINE_AI;' };
    const bad = Object.keys(want).filter(f => !fs.readFileSync(path.join(ROOT, f), 'utf8').includes(want[f]));
    return bad.length === 0 || bad.join(', ');
  });
  await check('handler / extract: no key, no fetch (the providers are reached through send())', () => {
    const bad = ['handler.js', 'extract.js'].filter(f => {
      const s = fs.readFileSync(path.join(FN_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      return /_API_KEY|apiKey|openaiKey|geminiKey|\bfetch\s*\(|Deno|process\.env/.test(s);
    });
    return bad.length === 0 || bad.join(', ');
  });
}

(async () => {
  console.log('Marsa — AI reading providers (20261208000100) tests (PGlite; local only)');
  await secFile();
  await secRerun();
  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  await secSql();
  await secShapes();
  await secHandler();
  await secStatic();
  await check('no network call was attempted', () => fetchCalls === 0);
  await db.close();
  console.log('\n' + '-'.repeat(70));
  if (nFail) {
    console.log('FAILURES:');
    fails.forEach(f => console.log('  - ' + f));
    console.log(`FAILED — ${nPass} passed, ${nFail} failed`);
    process.exit(1);
  }
  console.log(`OK — ${nPass} passed, ${nFail} failed`);
})().catch(e => { console.error(e); process.exit(1); });
