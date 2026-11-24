#!/usr/bin/env node
/*
  Marsa (مرسى) — migration 20261209000100_ai_keys.sql + the platform page «مفاتيح الذكاء الاصطناعي» (owner, 22 Nov 2026:
  the AI providers' keys are entered from the site's settings, not in code or in the hosting dashboard).
  LOCAL TESTS ONLY. PGlite (in-memory Postgres) with the Vault stand-in of supabase/tests/shim.sql, mocked providers,
  no network.

  Covers: file conventions + all_migrations.sql; preflight (ai_providers, Vault); the keys table (RLS, no API role) and
  Vault untouched by API roles; platform admins only (staff / another user / anon refused); save → Vault + last 4 only,
  never the key in a return value, in platform_ai_providers or in the audit log; replace keeps the Vault secret and
  clears the last test; bad keys refused; delete removes the Vault secret; model id + prices (ai_prices, the chain in
  ai_access follows); ai_provider_keys service-only (platform key for an org); ai_record_key_test (codes, model ids
  only); the Edge Function key test (handler providerTest) and the reading path using the saved keys (loadKeys);
  the platform page / supa.js / i18n (static).
  23 Nov 2026 fixes: the key source (vault / env / none) — a provider saved or deleted on the page never falls back to
  the Edge Function secret, a failed lookup uses no key; the key test uses the Vault key only (no_key / lookup_failed,
  never the secret); a model id used by another provider refused, Claude's model locked to app.ai_model(), price 0
  refused; an orphan Vault secret of the same name removed before create_secret (extract.js keySources unit-tested).

  usage:
    node supabase/tests/ai-keys-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261209000100_ai_keys.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const FN_DIR = path.join(SUPA, 'functions', 'ai-extract');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in ai-keys-tests'); };

const A = '0b5e0000-0000-4000-8000-000000000001';
const U = {
  owner: 'deca0000-0000-4000-8000-000000000051',   // platform admin
  admin: 'deca0000-0000-4000-8000-000000000052',   // org admin of A (not a platform admin)
  staff: 'deca0000-0000-4000-8000-000000000053'    // accountant of A
};
const KEY1 = 'sk-test-ONLYFORTESTS-aaaaaaaaaaaaaaaa1234';
const KEY2 = 'sk-test-ONLYFORTESTS-bbbbbbbbbbbbbbbb9876';

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
    ('${U.owner}', 'owner@keys.example.com', now()), ('${U.admin}', 'admin@keys.example.com', now()), ('${U.staff}', 'staff@keys.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.owner}', 'مالك المنصة'), ('${U.admin}', 'admin'), ('${U.staff}', 'staff') ON CONFLICT (id) DO NOTHING;
  UPDATE public.profiles SET full_name = 'مالك المنصة' WHERE id = '${U.owner}';
  INSERT INTO public.platform_admins (user_id) VALUES ('${U.owner}');
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ('${U.admin}', '${A}', NULL, 'admin'), ('${U.staff}', '${A}', NULL, 'accountant');
`;
const setKey = (who, p, k) => as(who, `SELECT public.platform_ai_set_key($1, $2) r`, [p, k]).then(r => r[0].r);
const providers = who => as(who, `SELECT public.platform_ai_providers() r`).then(r => r[0].r);
const keysFor = org => as('service', `SELECT public.ai_provider_keys($1) r`, [org]).then(r => r[0].r);

/* ------------------------------------------------------------------ 1. the file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('preflight on ai_providers + Vault, its schema_versions row, no BEGIN / COMMIT, no key-like text, no endpoint', () =>
    (/version = '20261208000100'/.test(s) && /to_regclass\('vault\.secrets'\)/.test(s) && /VALUES \('20261209000100', 'ai_keys'\)/.test(s)
      && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s) && !/sk-ant|sk-[A-Za-z0-9]{20}|AIza|api\.openai\.com|googleapis\.com|api\.anthropic\.com/.test(s)) || 'conventions');
  await check('all_migrations.sql: this file verbatim, in order', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    return (i > 0 && (body === s || body + '\n' === s) && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles())) || 'bundle';
  });
  const LATER_PHASES = ['20261210000100_org_served_ports.sql', '20261211000100_reconvert.sql', '20261213000100_site_profile.sql', '20261214000100_org_ai_keys.sql'];
  await check('this file is the latest migration (later phases excepted)', () => J(migFiles().filter(f => f > MIG)) === J(LATER_PHASES) || 'later ' + J(migFiles().filter(f => f > MIG)));
  await check('the key is never written to a log, a notice or the audit trail by the SQL (only last 4 characters)', () =>
    (!/RAISE\s+(NOTICE|LOG|INFO|WARNING)/i.test(s) && /'last4', v_last4/.test(s) && !/'key', v_key|jsonb_build_object\([^)]*p_key/.test(s) && /v_key := NULL;/.test(s)) || 'logging');
}

async function secPreflight() {
  section('2. preflight + re-run');
  const d = await freshDb(MIG);
  try {
    await check('refused without ai_providers (schema_versions row removed)', async () => {
      await d.query(`DELETE FROM public.schema_versions WHERE version = '20261208000100'`);
      let r = 'ok'; try { await d.exec(fs.readFileSync(MIG_FILE, 'utf8')); } catch (e) { r = e.message; }
      await d.query(`INSERT INTO public.schema_versions (version, name) VALUES ('20261208000100', 'ai_providers')`);
      return /AI KEYS preflight: apply ai_providers first/.test(r) || r;
    });
    await check('refused without Supabase Vault', async () => {
      await d.exec(`ALTER SCHEMA vault RENAME TO vault_off;`);
      let r = 'ok'; try { await d.exec(fs.readFileSync(MIG_FILE, 'utf8')); } catch (e) { r = e.message; }
      await d.exec(`ALTER SCHEMA vault_off RENAME TO vault;`);
      return /Supabase Vault is not enabled/.test(r) || r;
    });
    await check('applies, then re-runs without touching a saved key', async () => {
      await d.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      const sid = (await d.query(`SELECT vault.create_secret('x-secret-value-for-rerun-test-0000', 'ai_key:platform:openai') id`)).rows[0].id;
      await d.query(`INSERT INTO app.ai_provider_keys (provider, secret_id, key_last4) VALUES ('openai', $1, '0000')`, [sid]);
      await d.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      const r = (await d.query(`SELECT (SELECT count(*)::int FROM app.ai_provider_keys) n, (SELECT count(*)::int FROM vault.secrets) v`)).rows[0];
      return (r.n === 1 && r.v === 1) || J(r);
    });
  } finally { await d.close(); }
}

/* ------------------------------------------------------------------ 3. SQL */
async function secSql() {
  section('3. keys, Vault, platform admins only');
  await check('app.ai_provider_keys: RLS on, no API role reads it; Vault not reachable by any API role', async () => {
    const k = await one(`SELECT c.relrowsecurity rls, has_table_privilege('anon', c.oid, 'SELECT') a, has_table_privilege('authenticated', c.oid, 'SELECT') u,
                                has_table_privilege('service_role', c.oid, 'SELECT') s FROM pg_class c WHERE c.oid = 'app.ai_provider_keys'::regclass`);
    const v = [await code(() => as('authenticated' in U ? 'staff' : 'staff', `SELECT * FROM vault.secrets`)), await code(() => as('anon', `SELECT * FROM vault.decrypted_secrets`)),
      await code(() => as('service', `SELECT * FROM vault.decrypted_secrets`))];
    return (k.rls && !k.a && !k.u && !k.s && v.every(x => x === 'perm')) || J({ k, v });
  });
  await check('only a platform admin lists / saves / deletes keys and models (org admin, staff: MRS_FORBIDDEN; anon: refused)', async () => {
    const r = [await code(() => providers('admin')), await code(() => setKey('admin', 'openai', KEY1)), await code(() => setKey('staff', 'openai', KEY1)),
      await code(() => as('admin', `SELECT public.platform_ai_clear_key('openai')`)), await code(() => as('admin', `SELECT public.platform_ai_save_provider('openai', '{"model":"gpt-x"}')`)),
      await code(() => as('anon', `SELECT public.platform_ai_providers()`))];
    return J(r) === J(['MRS_FORBIDDEN', 'MRS_FORBIDDEN', 'MRS_FORBIDDEN', 'MRS_FORBIDDEN', 'MRS_FORBIDDEN', 'perm']) || J(r);
  });
  await check('the page lists the three providers, no key saved yet', async () => {
    const p = await providers('owner');
    return (J(p.map(x => x.provider)) === J(['anthropic', 'openai', 'gemini']) && p.every(x => x.key === null)) || J(p);
  });
  let sid;
  await check('save: the key goes to Vault; the answer and the list carry the last 4 characters only, never the key or the Vault id', async () => {
    const r = await setKey('owner', 'openai', '  ' + KEY1 + '  ');
    const row = await one(`SELECT secret_id, key_last4 FROM app.ai_provider_keys WHERE provider = 'openai' AND org_id IS NULL`);
    sid = row.secret_id;
    const v = await one(`SELECT decrypted_secret s, name FROM vault.decrypted_secrets WHERE id = $1`, [sid]);
    const list = await providers('owner');
    const text = J(r) + J(list);
    return (v.s === KEY1 && v.name === 'ai_key:platform:openai' && row.key_last4 === '1234' && r.last4 === '1234' && r.set_by_name === 'مالك المنصة'
      && !text.includes(KEY1) && !text.includes(sid) && list[1].key.last4 === '1234') || J({ r, v, row });
  });
  await check('the audit row names the provider and the last 4 characters, never the key', async () => {
    const a = await one(`SELECT table_name t, action, new_data n, old_data o FROM public.audit_log WHERE table_name = 'ai_provider_keys' ORDER BY id DESC LIMIT 1`);
    return (a.action === 'UPDATE' && a.n.provider === 'openai' && a.n.last4 === '1234' && !J(a).includes(KEY1)) || J(a);
  });
  await check('replace: the same Vault secret holds the new key; the last test is cleared', async () => {
    await as('service', `SELECT public.ai_record_key_test('openai', true, 'ok', '["gpt-a"]')`);
    const r = await setKey('owner', 'openai', KEY2);
    const row = await one(`SELECT secret_id, key_last4, tested_at FROM app.ai_provider_keys WHERE provider = 'openai'`);
    const v = await one(`SELECT decrypted_secret s FROM vault.decrypted_secrets WHERE id = $1`, [row.secret_id]);
    const n = await one(`SELECT count(*)::int n FROM vault.secrets`);
    return (row.secret_id === sid && v.s === KEY2 && r.last4 === '9876' && r.tested_at === null && n.n === 1) || J({ row, r, n });
  });
  await check('bad keys refused (too short, spaces inside, too long, not printable); unknown provider refused', async () => {
    const r = [await code(() => setKey('owner', 'openai', 'short')), await code(() => setKey('owner', 'openai', 'sk-test with spaces inside 123456')),
      await code(() => setKey('owner', 'openai', 'x'.repeat(401))), await code(() => setKey('owner', 'openai', 'sk-test-' + 'é'.repeat(20))),
      await code(() => setKey('owner', 'mistral', KEY1))];
    return J(r) === J(['MRS_INVALID key', 'MRS_INVALID key', 'MRS_INVALID key', 'MRS_INVALID key', 'MRS_INVALID provider']) || J(r);
  });
  await check('ai_provider_keys: service role only; an org gets the platform key; an inactive provider gets none', async () => {
    const no = [await code(() => as('owner', `SELECT public.ai_provider_keys(NULL)`)), await code(() => as('anon', `SELECT public.ai_provider_keys(NULL)`))];
    const k = await keysFor(A);
    const k0 = await keysFor(null);
    await q(`UPDATE app.ai_providers SET is_active = false WHERE provider = 'openai'`);
    const off = await keysFor(A);
    const off0 = await keysFor(null);
    await q(`UPDATE app.ai_providers SET is_active = true WHERE provider = 'openai'`);
    return (J(no) === J(['perm', 'perm']) && J(k.openai) === J({ key: KEY2, source: 'vault' }) && J(k.anthropic) === J({ source: 'env' })
      && J(k.gemini) === J({ source: 'env' }) && k0.openai.key === KEY2 && !('openai' in off) && off0.openai.source === 'vault')
      || J({ no, k, off, off0 });
  });
  await check('ai_record_key_test: service role only; codes and model ids only (bad ids dropped, sorted, distinct)', async () => {
    const no = await code(() => as('owner', `SELECT public.ai_record_key_test('openai', true, 'ok', NULL)`));
    const bad = await code(() => as('service', `SELECT public.ai_record_key_test('openai', true, 'Not A Code', NULL)`));
    await as('service', `SELECT public.ai_record_key_test('openai', true, 'ok', $1)`, [J(['gpt-b', 'gpt-a', 'gpt-a', 'GPT<script>', 7, 'gpt-6.2-astra'])]);
    const p = (await providers('owner')).find(x => x.provider === 'openai');
    return (no === 'perm' && bad === 'MRS_INVALID test' && p.key.test_ok === true && p.key.test_note === 'ok' && J(p.key.test_models) === J(['gpt-6.2-astra', 'gpt-a', 'gpt-b'])) || J({ no, bad, k: p.key });
  });
  await check('model + prices from the page: ai_providers + ai_prices; the org chain in ai_access asks for the new model', async () => {
    const r = await as('owner', `SELECT public.platform_ai_save_provider('openai', $1) r`, [J({ model: 'gpt-a', price_in: 1.25, price_out: 10 })]).then(x => x[0].r);
    const pr = await one(`SELECT input_usd_per_mtok::float i, output_usd_per_mtok::float o FROM app.ai_prices WHERE model = 'gpt-a'`);
    await q(`INSERT INTO app.ai_settings (org_id, enabled, consent_ack_at, consent_ack_by, consent_version, provider_order, consent_providers)
             VALUES ($1, true, now(), $2, 'ai-doc-inbox-v2', ARRAY['openai'], ARRAY['openai']) ON CONFLICT (org_id) DO UPDATE SET enabled = true,
             consent_ack_at = now(), provider_order = ARRAY['openai'], consent_providers = ARRAY['openai']`, [A, U.admin]);
    const acc = await as('staff', `SELECT public.ai_access($1) r`, [A]).then(x => x[0].r);
    return (r.model === 'gpt-a' && Number(r.price_in) === 1.25 && pr.i === 1.25 && pr.o === 10 && J(acc.providers) === J([{ model: 'gpt-a', provider: 'openai' }])) || J({ r, pr, acc });
  });
  await check('model / price validation: bad id, one price only, negative, a 0 price, unknown key refused', async () => {
    const sp = p => code(() => as('owner', `SELECT public.platform_ai_save_provider('openai', $1)`, [J(p)]));
    const r = [await sp({ model: 'GPT A' }), await sp({ price_in: 1 }), await sp({ price_in: -1, price_out: 2 }), await sp({ secret: 'x' }),
      await sp({ price_in: 0, price_out: 2 }), await sp({ price_in: 1, price_out: 0 })];
    const pr = await one(`SELECT input_usd_per_mtok::float i FROM app.ai_prices WHERE model = 'gpt-a'`);
    return (J(r) === J(['MRS_INVALID model', 'MRS_INVALID price', 'MRS_INVALID price', 'MRS_INVALID unknown_key', 'MRS_INVALID price', 'MRS_INVALID price'])
      && pr.i === 1.25) || J({ r, pr });
  });
  await check('a model id another provider already asks for is refused (MRS_CONFLICT model_taken), Claude\'s included; the table has a unique index too', async () => {
    const sp = (p, b) => code(() => as('owner', `SELECT public.platform_ai_save_provider($1, $2)`, [p, J(b)]));
    const r = [await sp('gemini', { model: 'gpt-a' }), await sp('gemini', { model: 'claude-opus-5-5' }), await sp('gemini', { model: 'gemini-3.8-flash', is_active: true })];
    const g = await one(`SELECT model FROM app.ai_providers WHERE provider = 'gemini'`);
    const ix = await code(() => q(`UPDATE app.ai_providers SET model = 'gpt-a' WHERE provider = 'gemini'`));
    return (J(r) === J(['MRS_CONFLICT model_taken', 'MRS_CONFLICT model_taken', 'ok']) && g.model === 'gemini-3.8-flash' && /duplicate key|ai_providers_model_uidx/.test(ix)) || J({ r, g, ix });
  });
  await check('Claude\'s model is locked to app.ai_model() (another id: MRS_INVALID model_locked); its price is saved under that id; the page says model_locked', async () => {
    const sp = b => code(() => as('owner', `SELECT public.platform_ai_save_provider('anthropic', $1)`, [J(b)]));
    const r = [await sp({ model: 'claude-other-1' }), await sp({ model: 'claude-opus-5-5', price_in: 5, price_out: 25 }), await sp({ price_in: 6, price_out: 30 })];
    await q(`UPDATE app.ai_providers SET model = 'claude-drifted-1' WHERE provider = 'anthropic'`);       // a row tuned by hand
    const p = (await providers('owner')).find(x => x.provider === 'anthropic');
    const r2 = await sp({ is_active: true });
    const m = await one(`SELECT model, (SELECT input_usd_per_mtok::float FROM app.ai_prices WHERE model = app.ai_model()) i FROM app.ai_providers WHERE provider = 'anthropic'`);
    const o = (await providers('owner')).find(x => x.provider === 'openai');
    return (J(r) === J(['MRS_INVALID model_locked', 'ok', 'ok']) && p.model === 'claude-opus-5-5' && p.model_locked === true && Number(p.price_in) === 6
      && r2 === 'ok' && m.model === 'claude-opus-5-5' && m.i === 6 && o.model_locked === false) || J({ r, p, r2, m });
  });
  await check('key source on the page: vault (saved here) / env (never saved here) before any delete', async () => {
    const p = await providers('owner');
    return J(p.map(x => x.key_source)) === J(['env', 'vault', 'env']) || J(p.map(x => x.key_source));
  });
  await check('delete: the Vault secret is removed, the row stays without a secret (source none: no secret fallback), an audit row without the key; a second delete is harmless', async () => {
    const r = await as('owner', `SELECT public.platform_ai_clear_key('openai') r`).then(x => x[0].r);
    const n = await one(`SELECT (SELECT count(*)::int FROM vault.secrets) v, (SELECT count(*)::int FROM app.ai_provider_keys WHERE secret_id IS NULL AND key_last4 IS NULL) k`);
    const a = await one(`SELECT action, old_data o FROM public.audit_log WHERE table_name = 'ai_provider_keys' ORDER BY id DESC LIMIT 1`);
    const nA = await one(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'ai_provider_keys'`);
    const again = await as('owner', `SELECT public.platform_ai_clear_key('openai') r`).then(x => x[0].r);
    const nB = await one(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'ai_provider_keys'`);
    const p = (await providers('owner')).find(x => x.provider === 'openai');
    const k = await keysFor(A);
    return (r.removed === true && n.v === 0 && n.k === 1 && a.action === 'DELETE' && a.o.last4 === '9876' && !J(a).includes(KEY2) && again.removed === false
      && nB.n === nA.n && p.key === null && p.key_source === 'none' && J(k.openai) === J({ source: 'none' })) || J({ r, n, a, again, p, k });
  });
  await check('delete on a provider never saved here: a row without a secret (the secret fallback stops), audit INSERT; unknown provider refused', async () => {
    const r = await as('owner', `SELECT public.platform_ai_clear_key('gemini') r`).then(x => x[0].r);
    const a = await one(`SELECT action, new_data n FROM public.audit_log WHERE table_name = 'ai_provider_keys' ORDER BY id DESC LIMIT 1`);
    const p = (await providers('owner')).find(x => x.provider === 'gemini');
    const bad = await code(() => as('owner', `SELECT public.platform_ai_clear_key('mistral')`));
    await q(`DELETE FROM app.ai_provider_keys WHERE provider = 'gemini'`);                                // back to «never saved here»
    const p2 = (await providers('owner')).find(x => x.provider === 'gemini');
    return (r.removed === false && a.action === 'INSERT' && a.n.key_source === 'none' && p.key_source === 'none' && bad === 'MRS_INVALID provider' && p2.key_source === 'env')
      || J({ r, a, p, bad, p2 });
  });
  await check('save after a delete: a new Vault secret; an orphan secret of the same name is removed first (unique name in Vault)', async () => {
    const orphan = (await q(`SELECT vault.create_secret('orphan-left-behind-000000000000', 'ai_key:platform:openai') id`))[0].id;
    const r = await setKey('owner', 'openai', KEY2);
    const v = await q(`SELECT id, decrypted_secret s FROM vault.decrypted_secrets WHERE name = 'ai_key:platform:openai'`);
    const row = await one(`SELECT secret_id FROM app.ai_provider_keys WHERE provider = 'openai' AND org_id IS NULL`);
    // a row whose secret vanished: the next save creates a new one (no silent update of a missing secret)
    const orphan2 = (await q(`SELECT vault.create_secret('orphan-gemini-00000000000000000000', 'ai_key:platform:gemini') id`))[0].id;
    const g = await setKey('owner', 'gemini', KEY1);
    const gv = await q(`SELECT id FROM vault.secrets WHERE name = 'ai_key:platform:gemini'`);
    await q(`DELETE FROM vault.secrets WHERE name = 'ai_key:platform:gemini'`);
    const gp = (await providers('owner')).find(x => x.provider === 'gemini');
    const gk = await keysFor(null);
    const g2 = await setKey('owner', 'gemini', KEY1);
    const gv2 = await q(`SELECT s.id FROM vault.secrets s JOIN app.ai_provider_keys k ON k.secret_id = s.id WHERE k.provider = 'gemini'`);
    await as('owner', `SELECT public.platform_ai_clear_key('gemini')`);
    await q(`DELETE FROM app.ai_provider_keys WHERE provider = 'gemini'`);
    return (r.last4 === '9876' && v.length === 1 && v[0].s === KEY2 && v[0].id !== orphan && row.secret_id === v[0].id
      && g.last4 === '1234' && gv.length === 1 && gv[0].id !== orphan2 && gp.key_source === 'none' && J(gk.gemini) === J({ source: 'none' })
      && g2.last4 === '1234' && gv2.length === 1) || J({ r, v, row, g, gv, gp, gk, gv2 });
  });
}

/* ------------------------------------------------------------------ 4. handler */
const X = require(path.join(FN_DIR, 'extract.js'));
const H = require(path.join(FN_DIR, 'handler.js'));
function hDeps(o) {
  const x = o || {};
  const calls = [];
  const who = x.who || 'owner';
  const sqlRpc = (role, name, a) => {
    const keys = Object.keys(a || {});
    const vals = keys.map(k => (a[k] !== null && typeof a[k] === 'object' ? J(a[k]) : a[k]));
    return as(role, `SELECT public.${name}(${keys.map((k, i) => k + ' => $' + (i + 1)).join(', ')}) r`, vals)
      .then(r => ({ data: r[0].r, error: null }), e => ({ data: null, error: { message: e.message } }));
  };
  const d = {
    calls, X, sdk: {}, configured: true, modelConfigured: false, ready: { openai: false, gemini: false },
    isAnonKey: () => false, log: t => calls.push('log:' + t),
    userClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: U[who] } }, error: null }) },
      rpc: (name, a) => { calls.push('user:' + name); return sqlRpc(who, name, a); },
      from: () => { const q2 = { select: () => q2, eq: () => q2, maybeSingle: async () => ({ data: null, error: null }) }; return q2; }
    }),
    serviceClient: () => ({ rpc: (name, a) => { calls.push(name); return sqlRpc('service', name, a); } }),
    // as index.ts loadKeys: extract.js keySources on the RPC answer; x.env = the Edge Function secrets that are set
    loadKeys: async org => { calls.push('loadKeys:' + org);
      const res = x.rpc ? x.rpc : await sqlRpc('service', 'ai_provider_keys', { p_org: org });
      const s = X.keySources(res), env = x.env || {};
      const out = { sources: s.sources, failed: s.failed === true };
      X.PROVIDERS.forEach(p => { out[p] = s.sources[p] === 'vault' || (s.sources[p] === 'env' && !!env[p]); });
      d.loaded = out; return out; },
    listModels: async p => { calls.push('listModels:' + p); return x.models || { status: 200, models: ['gpt-a', 'gpt-b', 'Bad Id'] }; },
    send: async (p, m, body) => { calls.push('send:' + p); return { status: 200, json: { status: 'completed', model: m, usage: { input_tokens: 10, output_tokens: 5 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: J({ doc_type: 'bill_of_lading', fields: [], line_items: [], warnings: [] }) }] }] } }; },
    claudeClient: () => { throw new Error('claude must not be called'); }
  };
  return d;
}
const hReq = body => new Request('https://edge.example/functions/v1/ai-extract', { method: 'POST',
  headers: { origin: 'https://marsacloud.com', authorization: 'Bearer user-token', 'content-type': 'application/json' }, body: J(body) });

async function secHandler() {
  section('4. the Edge Function: key test, reading with the saved keys (mocked)');
  await setKey('owner', 'openai', KEY1);
  await check('key test (platform admin): the model list with the saved key; ids filtered; the result recorded; the key never in the answer', async () => {
    const d = hDeps();
    const r = await H.handleRequest(hReq({ action: 'provider_test', provider: 'openai' }), d);
    const b = JSON.parse(r.body);
    const k = (await providers('owner')).find(x => x.provider === 'openai').key;
    return (r.status === 200 && b.ok === true && b.note === 'ok' && J(b.models) === J(['gpt-a', 'gpt-b']) && !r.body.includes(KEY1)
      && J(d.calls.filter(c => !/^log:/.test(c))) === J(['user:platform_ai_providers', 'loadKeys:null', 'listModels:openai', 'ai_record_key_test'])
      && k.test_ok === true && J(k.test_models) === J(['gpt-a', 'gpt-b'])) || J({ s: r.status, b, calls: d.calls, k });
  });
  await check('key test: a rejected key → ok false, note key_rejected (recorded); no key → no_key', async () => {
    const r1 = JSON.parse((await H.handleRequest(hReq({ action: 'provider_test', provider: 'openai' }), hDeps({ models: { status: 401, models: [] } }))).body);
    const k = (await providers('owner')).find(x => x.provider === 'openai').key;
    const r2 = JSON.parse((await H.handleRequest(hReq({ action: 'provider_test', provider: 'gemini' }), hDeps({ models: { status: 0, models: [] } }))).body);
    return (r1.ok === false && r1.note === 'key_rejected' && k.test_ok === false && k.test_note === 'key_rejected' && r2.note === 'no_key') || J({ r1, k, r2 });
  });
  await check('key test: not a platform admin → 403, nothing listed; an unknown provider → 400', async () => {
    const d = hDeps({ who: 'admin' });
    const r = await H.handleRequest(hReq({ action: 'provider_test', provider: 'openai' }), d);
    const r2 = await H.handleRequest(hReq({ action: 'provider_test', provider: 'mistral' }), hDeps());
    return (r.status === 403 && JSON.parse(r.body).error === 'forbidden' && !d.calls.some(c => /^listModels|^loadKeys/.test(c)) && r2.status === 400) || J({ s: r.status, calls: d.calls, s2: r2.status });
  });
  await check('reading: the key saved on the page makes OpenAI usable although no secret is set (loadKeys for the org)', async () => {
    const d = hDeps({ who: 'staff' });
    const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64');
    const r = await H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG } }), d);
    return (r.status === 200 && d.calls.includes('loadKeys:' + A) && d.calls.includes('send:openai') && JSON.parse(r.body).engine === 'gpt-a') || J({ s: r.status, b: r.body, calls: d.calls });
  });
  const PNG2 = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 73, 72, 68, 82, 1]).toString('base64');
  const read = d => H.handleRequest(hReq({ org_id: A, doc_type: 'bill_of_lading', file: { media_type: 'image/png', data_b64: PNG2 } }), d);
  await check('key test: the Edge Function secret is never tested — a provider without a Vault key (env only) → no_key, nothing listed', async () => {
    const d = hDeps({ env: { anthropic: true, openai: true, gemini: true } });
    const r = JSON.parse((await H.handleRequest(hReq({ action: 'provider_test', provider: 'gemini' }), d)).body);
    return (r.ok === false && r.note === 'no_key' && !d.calls.some(c => /^listModels/.test(c))) || J({ r, calls: d.calls });
  });
  await check('key test: the key lookup failed (RPC error) → lookup_failed recorded, nothing listed, never the secret', async () => {
    const d = hDeps({ env: { openai: true }, rpc: { data: null, error: { code: 'XX000', message: 'down' } } });
    const r = JSON.parse((await H.handleRequest(hReq({ action: 'provider_test', provider: 'openai' }), d)).body);
    const k = (await providers('owner')).find(x => x.provider === 'openai').key;
    return (r.ok === false && r.note === 'lookup_failed' && !d.calls.some(c => /^listModels/.test(c)) && d.calls.includes('ai_record_key_test')
      && k.test_note === 'lookup_failed' && d.calls.includes('log:ai-extract: key lookup failed')) || J({ r, calls: d.calls, k });
  });
  await check('reading: a key lookup that failed uses no key at all (no silent fallback to the secrets) → not_configured, nothing sent', async () => {
    const d = hDeps({ who: 'staff', env: { anthropic: true, openai: true, gemini: true }, rpc: { data: null, error: { code: 'XX000', message: 'down' } } });
    const r = await read(d);
    return (r.status === 503 && JSON.parse(r.body).error === 'not_configured' && !d.calls.some(c => /^send:/.test(c))) || J({ s: r.status, b: r.body, calls: d.calls });
  });
  await check('reading: a database without the key RPC yet (PGRST202, before 20261209000100) keeps the secrets, as before', async () => {
    const d = hDeps({ who: 'staff', env: { openai: true }, rpc: { data: null, error: { code: 'PGRST202', message: 'not found' } } });
    const r = await read(d);
    return (r.status === 200 && d.calls.includes('send:openai')) || J({ s: r.status, calls: d.calls });
  });
  await check('reading: a key deleted on the page is NOT replaced by the OPENAI_API_KEY secret (source none) → not_configured, nothing sent', async () => {
    await as('owner', `SELECT public.platform_ai_clear_key('openai')`);
    const d = hDeps({ who: 'staff', env: { openai: true } });
    const r = await read(d);
    return (r.status === 503 && !d.calls.some(c => /^send:/.test(c)) && d.loaded.sources.openai === 'none' && d.loaded.openai === false) || J({ s: r.status, calls: d.calls, l: d.loaded });
  });
  await check('reading: a provider never saved on the page still uses its Edge Function secret (source env)', async () => {
    await q(`UPDATE app.ai_settings SET provider_order = ARRAY['gemini'], consent_providers = ARRAY['gemini'] WHERE org_id = $1`, [A]);
    const d = hDeps({ who: 'staff', env: { gemini: true } });
    await read(d);
    const d2 = hDeps({ who: 'staff' });
    const r2 = await read(d2);
    await q(`UPDATE app.ai_settings SET provider_order = ARRAY['openai'], consent_providers = ARRAY['openai'] WHERE org_id = $1`, [A]);
    return (d.loaded.sources.gemini === 'env' && d.calls.includes('send:gemini') && r2.status === 503 && !d2.calls.some(c => /^send:/.test(c))) || J({ calls: d.calls, r2: r2.status });
  });
  await check('extract.js keySources: vault / env / none per provider; an RPC error → all none + failed; PGRST202 / 42883 → env; never returns a key', () => {
    const a = X.keySources({ data: { anthropic: { source: 'vault', key: KEY1 }, openai: { source: 'none' }, gemini: { source: 'env' } }, error: null });
    const b = X.keySources({ data: null, error: { code: '57014' } });
    const c = X.keySources({ data: null, error: { code: 'PGRST202' } }), c2 = X.keySources({ data: null, error: { code: '42883' } });
    const e = [X.keySources(null), X.keySources({ data: { anthropic: KEY1 }, error: null }), X.keySources({ data: { anthropic: { source: 'vault', key: '' } }, error: null })];
    return (J(a) === J({ failed: false, sources: { anthropic: 'vault', openai: 'none', gemini: 'env' } }) && !J(a).includes(KEY1)
      && J(b) === J({ failed: true, sources: { anthropic: 'none', openai: 'none', gemini: 'none' } })
      && J(c.sources) === J({ anthropic: 'env', openai: 'env', gemini: 'env' }) && c.failed === false && J(c2) === J(c)
      && e[0].failed === true && e[1].sources.anthropic === 'none' && e[1].sources.openai === 'none' && e[2].sources.anthropic === 'none') || J({ a, b, c, e });
  });
}

/* ------------------------------------------------------------------ 5. static: page, supa.js, i18n, index.ts */
async function secStatic() {
  section('5. static: the platform page, supa.js, i18n, index.ts');
  const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const pf = rd('assets/js/platform.js'), html = rd('platform.html'), supa = rd('assets/js/supa.js'), idx = rd('supabase/functions/ai-extract/index.ts');
  await check('platform.html: the «مفاتيح الذكاء الاصطناعي» card with its table body and reload button', () =>
    (/data-pf-ai-card/.test(html) && /<tbody data-pf-ai><\/tbody>/.test(html) && /data-pf-ai-reload/.test(html) && /data-i18n="platform\.aiTitle"/.test(html)) || 'html');
  await check('platform.js: the key field is a password field, cleared after the save, never put back on the page; text only (no innerHTML)', () => {
    const seg = pf.slice(pf.indexOf('AI PROVIDER KEYS'), pf.indexOf('TOP BAR + BOOT'));
    return (/type: 'password'/.test(seg) && /f\.input\.value = '';/.test(seg) && /'autocomplete', 'new-password'/.test(seg) && !/innerHTML/.test(seg)
      && /'•••• ' \+ k\.last4/.test(seg) && !/\.key\.(value|secret)|secret_id/.test(seg) && /loadAi\(\)\]\); \}/.test(pf)) || 'platform.js';
  });
  await check('platform.js: the key source shown on every row; lookup_failed has its text; Claude\'s model read-only and not sent; a 0 price refused; model_taken / model_locked explained', () => {
    const seg = pf.slice(pf.indexOf('AI PROVIDER KEYS'), pf.indexOf('TOP BAR + BOOT'));
    return (/var AI_SRC_KEYS = \{ vault: 'aiSrcVault', env: 'aiSrcEnv', none: 'aiSrcNone' \};/.test(seg) && /keyCell\.push\(h\('span', \{ class: 'pf-sub', 'data-pf-ai-src': src/.test(seg)
      && /lookup_failed: 'aiTestLookupFailed'/.test(seg) && /if \(locked\) fm\.input\.readOnly = true;/.test(seg) && /if \(!locked\) payload\.model = model;/.test(seg)
      && /a <= 0 \|\| b <= 0/.test(seg) && /model_taken: 'aiModelTaken', model_locked: 'aiModelLocked'/.test(seg) && /AI_SAVE_ERR\[r\.error\.field\]/.test(seg)) || 'platform.js';
  });
  await check('supa.js: the five platformAi* calls (the key trimmed and checked before it is sent; the test through the Edge Function)', () =>
    (['platformAiProviders', 'platformAiSetKey', 'platformAiClearKey', 'platformAiSaveProvider', 'platformAiTestKey'].every(n => new RegExp(n + ': ' + n).test(supa))
      && /rpc\('platform_ai_set_key', \{ p_provider: provider, p_key: k \}\)/.test(supa) && /k\.length > 400 \|\| \/\\s\/\.test\(k\)/.test(supa)
      && /action: 'provider_test', provider: provider/.test(supa)) || 'supa.js');
  await check('i18n: every ai* key of the platform dictionary in Arabic AND English', () => {
    const vm = require('vm');
    let dict = null;
    const box = { window: { MarsaI18n: { register: (ns, d) => { dict = d; } } } }; vm.createContext(box); vm.runInContext(rd('assets/i18n/platform.js'), box);
    const ar = Object.keys(dict.ar).filter(k => /^ai/.test(k)), en = Object.keys(dict.en).filter(k => /^ai/.test(k));
    const miss = ar.filter(k => !dict.en[k]).concat(en.filter(k => !dict.ar[k]));
    const need = ['aiSrcVault', 'aiSrcEnv', 'aiSrcNone', 'aiTestLookupFailed', 'aiModelTaken', 'aiModelLocked', 'aiModelLockedHint'].filter(k => !dict.ar[k] || !dict.en[k]);
    // the delete dialog says the server secret is not used either (true since 23 Nov 2026)
    const del = /Edge Function/.test(dict.ar.aiKeyDeleteText) && /Edge Function/.test(dict.en.aiKeyDeleteText);
    return (ar.length >= 47 && miss.length === 0 && need.length === 0 && del) || J({ n: ar.length, miss, need, del });
  });
  await check('index.ts: the keys come from the service RPC into the request scope; handler.js gets booleans (loadKeys) and never a key', () => {
    const h = rd('supabase/functions/ai-extract/handler.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return (/const keys: Record<string, string> = \{/.test(idx) && /loadKeys,/.test(idx) && /listModels,/.test(idx)
      && /return \{ \.\.\.ready\(\), sources: \{ \.\.\.source \}, failed: s\.failed === true \};/.test(idx) && /const s = X\.keySources\(r\);/.test(idx)
      && /if \(source\[p\] === 'vault'\) keys\[p\] = r\.data\[p\]\.key;/.test(idx) && /else if \(source\[p\] !== 'env'\) keys\[p\] = '';/.test(idx)
      && /if \(source\[provider\] !== 'vault'\) return \{ status: 0, models: \[\] \};/.test(idx)
      && !/keys\.(anthropic|openai|gemini)|apiKey|_API_KEY|decrypted_secret/.test(h)) || 'index.ts';
  });
}

(async () => {
  console.log('Marsa — AI provider keys (20261209000100) tests (PGlite; local only)');
  await secFile();
  await secPreflight();
  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  await secSql();
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
