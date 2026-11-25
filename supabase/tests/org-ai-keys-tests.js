#!/usr/bin/env node
/*
  Marsa (مرسى) — migration 20261214000100_org_ai_keys.sql + «مفتاح الذكاء الاصطناعي الخاص بالمكتب» (owner, 23 Nov 2026:
  an office may keep its own AI key; a free Google key only after a warning and an explicit consent).
  LOCAL TESTS ONLY. PGlite with the Vault stand-in of supabase/tests/shim.sql, mocked providers, no network.

  Covers: file conventions + all_migrations.sql; preflight + re-run; org admins only (staff, another office's admin,
  the platform admin of no office, anon refused); save → Vault + last 4, never the key in a return value, in org_ai_keys
  or in the audit log; the reading keys (ai_provider_keys) use the office key first and keep the platform key for other
  offices / providers; the Gemini tier: free only with consent, free refused for other providers; replace / remove;
  the platform key's tier (platform admins only, free only with consent); service-only RPCs (the office's own key, the
  office test result); the Edge Function office key test (handler orgKeyTest, mocked); pages / supa.js / i18n (static).

  usage:
    node supabase/tests/org-ai-keys-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261214000100_org_ai_keys.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const FN_DIR = path.join(SUPA, 'functions', 'ai-extract');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }
globalThis.fetch = async () => { throw new Error('network forbidden in org-ai-keys-tests'); };

const A = '0b5e0000-0000-4000-8000-0000000000a1';
const B = '0b5e0000-0000-4000-8000-0000000000b2';
const U = {
  owner: 'deca0000-0000-4000-8000-0000000000f1',   // platform admin, member of no office
  admin: 'deca0000-0000-4000-8000-0000000000f2',   // org admin of A
  staff: 'deca0000-0000-4000-8000-0000000000f3',   // accountant of A
  adminB: 'deca0000-0000-4000-8000-0000000000f4'   // org admin of B
};
const PLATFORM_KEY = 'sk-test-ONLYFORTESTS-platformplatform0000';
const OFFICE_KEY = 'sk-test-ONLYFORTESTS-officeofficeoffice1234';
const OFFICE_KEY2 = 'sk-test-ONLYFORTESTS-officeofficeoffice9876';
const GEM_KEY = 'gm-test-ONLYFORTESTS-geminigemini5555';

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
    ('${U.owner}', 'owner@okeys.example.com', now()), ('${U.admin}', 'admin@okeys.example.com', now()),
    ('${U.staff}', 'staff@okeys.example.com', now()), ('${U.adminB}', 'adminb@okeys.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.owner}', 'owner'), ('${U.admin}', 'admin'), ('${U.staff}', 'staff'), ('${U.adminB}', 'adminB')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.platform_admins (user_id) VALUES ('${U.owner}');
  INSERT INTO public.organizations (id, slug, name_ar, ref_prefix, environment) VALUES
    ('${A}', 'okeys-a', 'مكتب أ', 'OKA', 'staging'), ('${B}', 'okeys-b', 'مكتب ب', 'OKB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ('${U.admin}', '${A}', NULL, 'admin'),
    ('${U.staff}', '${A}', NULL, 'accountant'), ('${U.adminB}', '${B}', NULL, 'admin');
  UPDATE app.ai_providers SET is_active = true;
`;
const orgKeys = (who, org) => as(who, `SELECT public.org_ai_keys($1) r`, [org]).then(r => r[0].r);
const orgSet = (who, org, p, k, tier, consent) => as(who, `SELECT public.org_ai_set_key($1, $2, $3, $4, $5) r`, [org, p, k, tier || null, !!consent]).then(r => r[0].r);
// public.ai_provider_keys(org) → {provider: {key, source}} since the 23 Nov review fixes (20261209000100): flattened
// to {provider: key} here, a Vault source required
const keysFor = org => as('service', `SELECT public.ai_provider_keys($1) r`, [org]).then(r => {
  const o = {}, m = r[0].r || {};
  for (const p of Object.keys(m)) o[p] = m[p] && typeof m[p] === 'object' ? (m[p].source === 'vault' ? m[p].key : null) : m[p];
  return o;
});
const row = (list, p) => (list || []).find(x => x.provider === p);

/* ------------------------------------------------------------------ 1. the file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('preflight on site_profile + the keys table, its schema_versions row, no BEGIN / COMMIT, no key-like text, no endpoint', () =>
    (/version = '20261213000100'/.test(s) && /to_regclass\('app\.ai_provider_keys'\)/.test(s) && /VALUES \('20261214000100', 'org_ai_keys'\)/.test(s)
      && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s) && !/sk-ant|sk-[A-Za-z0-9]{20}|AIza|api\.openai\.com|googleapis\.com|api\.anthropic\.com/.test(s)) || 'conventions');
  await check('all_migrations.sql: this file verbatim, in order, with its live-DB note', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    return (i > 0 && (body === s || body + '\n' === s) && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles())) || 'bundle';
  });
  const LATER_PHASES = ['20261215000100_team_tiers.sql'];
  await check('only the known later migrations follow this file', () => {
    const later = migFiles().filter(f => f > MIG);
    return later.every(f => LATER_PHASES.includes(f)) || 'unexpected later files: ' + later.join(', ');
  });
  await check('the key is never logged or audited by the SQL (last 4 only; the variable cleared)', () =>
    (!/RAISE\s+(NOTICE|LOG|INFO|WARNING)/i.test(s) && /'last4', v_last4/.test(s) && !/'key', v_key|jsonb_build_object\([^)]*p_key/.test(s) && /v_key := NULL;/.test(s)) || 'logging');
}

async function secPreflight() {
  section('2. preflight + re-run');
  const d = await freshDb(MIG);
  try {
    await check('refused without site_profile (schema_versions row removed)', async () => {
      await d.query(`DELETE FROM public.schema_versions WHERE version = '20261213000100'`);
      let r = 'ok'; try { await d.exec(fs.readFileSync(MIG_FILE, 'utf8')); } catch (e) { r = e.message; }
      await d.query(`INSERT INTO public.schema_versions (version, name) VALUES ('20261213000100', 'site_profile')`);
      return /ORG AI KEYS preflight: apply site_profile first/.test(r) || r;
    });
    await check('applies, then re-runs (one constraint, one version row)', async () => {
      await d.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      await d.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      const c = (await d.query(`SELECT count(*)::int n FROM pg_constraint WHERE conname = 'ai_provider_keys_free_consent_chk'`)).rows[0].n;
      const v = (await d.query(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261214000100'`)).rows[0].n;
      return (c === 1 && v === 1) || J({ c, v });
    });
  } finally { await d.close(); }
}

/* ------------------------------------------------------------------ 3. the office key */
async function secOffice() {
  section('3. the office key (org admins)');
  await as('owner', `SELECT public.platform_ai_set_key('openai', $1)`, [PLATFORM_KEY]);
  await check('org_ai_keys: no office key yet, the platform key flagged (never a key, never a secret id)', async () => {
    const r = await orgKeys('admin', A);
    const o = row(r, 'openai');
    return (o && o.key === null && o.platform_key === true && !J(r).includes(PLATFORM_KEY) && !/secret/.test(J(r))) || J(r);
  });
  await check('only the office admin: staff, another office admin, the platform admin, anon refused (list, save, remove)', async () => {
    const c = [
      await code(() => orgKeys('staff', A)), await code(() => orgKeys('adminB', A)), await code(() => orgKeys('owner', A)), await code(() => orgKeys('anon', A)),
      await code(() => orgSet('staff', A, 'openai', OFFICE_KEY)), await code(() => orgSet('adminB', A, 'openai', OFFICE_KEY)),
      await code(() => as('adminB', `SELECT public.org_ai_clear_key($1, 'openai')`, [A]))
    ];
    return c.every(x => /MRS_FORBIDDEN|perm/.test(x)) || J(c);
  });
  await check('save → Vault + last 4; the answer, the list and the audit row never hold the key; tier paid by default', async () => {
    const k = await orgSet('admin', A, 'openai', OFFICE_KEY);
    const list = await orgKeys('admin', A);
    const vault = (await q(`SELECT count(*)::int n FROM vault.secrets WHERE secret = $1`, [OFFICE_KEY]))[0].n;
    const audit = J(await q(`SELECT new_data, old_data FROM public.audit_log WHERE table_name = 'ai_provider_keys' AND org_id = $1`, [A]));
    return (k.last4 === '1234' && k.tier === 'paid' && !J(k).includes(OFFICE_KEY) && row(list, 'openai').key.last4 === '1234' && !J(list).includes(OFFICE_KEY)
      && vault === 1 && !audit.includes(OFFICE_KEY) && /"scope":"office"/.test(audit)) || J({ k, vault, audit });
  });
  await check('reading keys: office A gets its own key; office B and other providers keep the platform key', async () => {
    const a = await keysFor(A), b = await keysFor(B);
    return (a.openai === OFFICE_KEY && b.openai === PLATFORM_KEY) || J({ a: a.openai, b: b.openai });
  });
  await check('bad keys refused (short, spaces); an inactive / unknown provider refused', async () => {
    const c = [await code(() => orgSet('admin', A, 'openai', 'short')), await code(() => orgSet('admin', A, 'openai', 'sk-test with spaces in it 1234567')),
      await code(() => orgSet('admin', A, 'nope', OFFICE_KEY))];
    return c.every(x => /MRS_INVALID/.test(x)) || J(c);
  });
  await check('Gemini free: refused without consent (MRS_AI_FREE_CONSENT); saved with consent (tier free, consent time); free refused for OpenAI', async () => {
    const no = await code(() => orgSet('admin', A, 'gemini', GEM_KEY, 'free', false));
    const k = await orgSet('admin', A, 'gemini', GEM_KEY, 'free', true);
    const oa = await code(() => orgSet('admin', A, 'openai', OFFICE_KEY, 'free', true));
    const by = (await q(`SELECT free_consent_by FROM app.ai_provider_keys WHERE org_id = $1 AND provider = 'gemini'`, [A]))[0].free_consent_by;
    return (/MRS_AI_FREE_CONSENT/.test(no) && k.tier === 'free' && !!k.free_consent_at && by === U.admin && /MRS_INVALID tier/.test(oa)) || J({ no, k, oa, by });
  });
  await check('a free key without consent cannot exist (table CHECK)', async () => {
    const r = await code(() => q(`UPDATE app.ai_provider_keys SET free_consent_by = NULL WHERE org_id = $1 AND provider = 'gemini'`, [A]));
    return /ai_provider_keys_free_consent_chk|violates check/.test(r) || r;
  });
  await check('replace: same Vault secret, new last 4, the last test cleared; paid again drops the consent', async () => {
    await q(`UPDATE app.ai_provider_keys SET tested_at = now(), test_ok = true, test_note = 'ok' WHERE org_id = $1 AND provider = 'openai'`, [A]);
    const before = (await q(`SELECT secret_id FROM app.ai_provider_keys WHERE org_id = $1 AND provider = 'openai'`, [A]))[0].secret_id;
    const k = await orgSet('admin', A, 'openai', OFFICE_KEY2);
    const after = (await q(`SELECT secret_id, tested_at FROM app.ai_provider_keys WHERE org_id = $1 AND provider = 'openai'`, [A]))[0];
    const g = await orgSet('admin', A, 'gemini', GEM_KEY, 'paid');
    return (k.last4 === '9876' && after.secret_id === before && after.tested_at === null && g.tier === 'paid' && g.free_consent_at === null) || J({ k, after, g });
  });
  await check('remove: the Vault secret goes, the office falls back to the platform key', async () => {
    const r = await as('admin', `SELECT public.org_ai_clear_key($1, 'openai') r`, [A]).then(x => x[0].r);
    const vault = (await q(`SELECT count(*)::int n FROM vault.secrets WHERE secret = $1`, [OFFICE_KEY2]))[0].n;
    const a = await keysFor(A);
    return (r.removed === true && vault === 0 && a.openai === PLATFORM_KEY) || J({ r, vault, a: a.openai });
  });
}

/* ------------------------------------------------------------------ 4. platform tier + service RPCs */
async function secPlatformAndService() {
  section('4. the platform key tier; service-only RPCs');
  await as('owner', `SELECT public.platform_ai_set_key('gemini', $1)`, [GEM_KEY + 'P']);
  await check('platform tier: platform admin only; free only with consent; the office sees the platform tier', async () => {
    const c1 = await code(() => as('admin', `SELECT public.platform_ai_set_key_tier('gemini', 'free', true)`));
    const c2 = await code(() => as('owner', `SELECT public.platform_ai_set_key_tier('gemini', 'free', false)`));
    const k = await as('owner', `SELECT public.platform_ai_set_key_tier('gemini', 'free', true) r`).then(r => r[0].r);
    const c3 = await code(() => as('owner', `SELECT public.platform_ai_set_key_tier('anthropic', 'paid', false)`));
    await as('admin', `SELECT public.org_ai_clear_key($1, 'gemini')`, [A]);
    const list = await orgKeys('admin', A);
    return (/MRS_FORBIDDEN/.test(c1) && /MRS_AI_FREE_CONSENT/.test(c2) && k.tier === 'free' && /MRS_NOT_FOUND/.test(c3) && row(list, 'gemini').platform_tier === 'free')
      || J({ c1, c2, k, c3, list });
  });
  await check('ai_org_provider_key: service only; the office OWN key only (null when only the platform has one)', async () => {
    await orgSet('admin', A, 'openai', OFFICE_KEY);
    const own = await as('service', `SELECT public.ai_org_provider_key($1, 'openai') r`, [A]).then(r => r[0].r);
    const none = await as('service', `SELECT public.ai_org_provider_key($1, 'openai') r`, [B]).then(r => r[0].r);
    const c = [await code(() => as('admin', `SELECT public.ai_org_provider_key($1, 'openai')`, [A])), await code(() => as('anon', `SELECT public.ai_org_provider_key($1, 'openai')`, [A]))];
    return (own === OFFICE_KEY && none === null && c.every(x => /MRS_FORBIDDEN|perm/.test(x))) || J({ own, none, c });
  });
  await check('ai_record_org_key_test: service only; updates that office key only (model ids filtered)', async () => {
    await as('service', `SELECT public.ai_record_org_key_test($1, 'openai', true, 'ok', $2)`, [A, J(['gpt-a', 'Bad Id'])]);
    const k = row(await orgKeys('admin', A), 'openai').key;
    const pf = (await q(`SELECT test_ok FROM app.ai_provider_keys WHERE org_id IS NULL AND provider = 'openai'`))[0].test_ok;
    const c = await code(() => as('admin', `SELECT public.ai_record_org_key_test($1, 'openai', true, 'ok', NULL)`, [A]));
    return (k.test_ok === true && J(k.test_models) === J(['gpt-a']) && pf === null && /MRS_FORBIDDEN|perm/.test(c)) || J({ k, pf, c });
  });
}

/* ------------------------------------------------------------------ 5. the Edge Function office key test */
const X = require(path.join(FN_DIR, 'extract.js'));
const H = require(path.join(FN_DIR, 'handler.js'));
function hDeps(o) {
  const x = o || {};
  const calls = [];
  const who = x.who || 'admin';
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
      rpc: (name, a) => { calls.push('user:' + name); return sqlRpc(who, name, a); }
    }),
    serviceClient: () => ({ rpc: (name, a) => { calls.push(name); return sqlRpc('service', name, a); } }),
    loadOrgKey: async (org, p) => { calls.push('loadOrgKey:' + p); const r = await sqlRpc('service', 'ai_org_provider_key', { p_org: org, p_provider: p }); d.key = r.data; return !!r.data; },
    listModels: async p => { calls.push('listModels:' + p); return x.models || { status: 200, models: ['gpt-x', 'Bad Id'] }; }
  };
  return d;
}
const hReq = body => new Request('https://edge.example/functions/v1/ai-extract', { method: 'POST',
  headers: { origin: 'https://marsacloud.com', authorization: 'Bearer user-token', 'content-type': 'application/json' }, body: J(body) });
async function secHandler() {
  section('5. the Edge Function: the office key test (mocked)');
  await check('office admin: the office OWN key tested, ids filtered, the result recorded; the key never in the answer', async () => {
    const d = hDeps();
    const r = await H.handleRequest(hReq({ action: 'org_key_test', org_id: A, provider: 'openai' }), d);
    const b = JSON.parse(r.body);
    const k = row(await orgKeys('admin', A), 'openai').key;
    return (r.status === 200 && b.ok === true && J(b.models) === J(['gpt-x']) && !r.body.includes(OFFICE_KEY) && d.key === OFFICE_KEY
      && J(d.calls.filter(c => !/^log:/.test(c))) === J(['user:org_ai_keys', 'loadOrgKey:openai', 'listModels:openai', 'ai_record_org_key_test'])
      && J(k.test_models) === J(['gpt-x'])) || J({ s: r.status, b, calls: d.calls });
  });
  await check('no office key (platform only): no_key, the platform key is NOT tested, nothing recorded', async () => {
    const d = hDeps();
    const r = await H.handleRequest(hReq({ action: 'org_key_test', org_id: A, provider: 'anthropic' }), d);
    const b = JSON.parse(r.body);
    return (r.status === 200 && b.ok === false && b.note === 'no_key' && !d.calls.includes('listModels:anthropic') && !d.calls.includes('ai_record_org_key_test')) || J({ b, calls: d.calls });
  });
  await check('staff / another office admin → 403; a bad org id or provider → 400', async () => {
    const s1 = (await H.handleRequest(hReq({ action: 'org_key_test', org_id: A, provider: 'openai' }), hDeps({ who: 'staff' }))).status;
    const s2 = (await H.handleRequest(hReq({ action: 'org_key_test', org_id: A, provider: 'openai' }), hDeps({ who: 'adminB' }))).status;
    const s3 = (await H.handleRequest(hReq({ action: 'org_key_test', org_id: 'x', provider: 'openai' }), hDeps())).status;
    const s4 = (await H.handleRequest(hReq({ action: 'org_key_test', org_id: A, provider: 'nope' }), hDeps())).status;
    return (s1 === 403 && s2 === 403 && s3 === 400 && s4 === 400) || J({ s1, s2, s3, s4 });
  });
  await check('index.ts: loadOrgKey reads ai_org_provider_key only (no platform fallback) and is handed to the handler', () => {
    const s = fs.readFileSync(path.join(FN_DIR, 'index.ts'), 'utf8');
    return (/async function loadOrgKey/.test(s) && /rpc\('ai_org_provider_key'/.test(s) && /keys\[provider\] = '';/.test(s) && /\n    loadOrgKey,\n/.test(s)) || 'index.ts';
  });
}

/* ------------------------------------------------------------------ 6. pages (static) */
function secFront() {
  section('6. supa.js / admin.js / platform.js / i18n (static)');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'admin.js'), 'utf8');
  const plat = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'platform.js'), 'utf8');
  const card = admin.slice(admin.indexOf('function orgAiKeysCard()'), admin.indexOf('الفروع — list / add / edit'));
  return Promise.all([
    check('supa.js: wrappers + exports; a free key refused without consent before any call', () =>
      (/rpc\('org_ai_set_key'/.test(supa) && /rpc\('org_ai_keys'/.test(supa) && /rpc\('org_ai_clear_key'/.test(supa) && /action: 'org_key_test'/.test(supa)
        && /rpc\('platform_ai_set_key_tier'/.test(supa) && /orgAiSetKey: orgAiSetKey/.test(supa) && /fail\('MRS_AI_FREE_CONSENT'\)/.test(supa)) || 'supa'),
    check('office card: org admins only, a password field cleared after saving, the free warning + consent, no innerHTML', () =>
      (/isOrgAdmin\(\)/.test(card) && /type: 'password'/.test(card) && /keyIn\.value = ''/.test(card) && /okey_free_warning/.test(card)
        && /okey_free_ack/.test(card) && !/innerHTML/.test(card) && /orgAiKeysCard\(\)\.then/.test(admin)) || 'card'),
    check('platform page: Gemini paid / free with the warning and the consent', () =>
      (/aiFreeWarning/.test(plat) && /aiFreeAckNeeded/.test(plat) && /platformAiSetKeyTier/.test(plat)) || 'platform'),
    check('i18n: the office card, the platform tier and MRS_AI_FREE_CONSENT in Arabic and English', () => {
      const a = fs.readFileSync(path.join(ROOT, 'assets', 'i18n', 'admin.js'), 'utf8');
      const p = fs.readFileSync(path.join(ROOT, 'assets', 'i18n', 'platform.js'), 'utf8');
      const g = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'i18n.js'), 'utf8');
      const n = (s, k) => (s.match(new RegExp('\\b' + k + ':', 'g')) || []).length;
      return (['okey_title', 'okey_free_warning', 'okey_free_ack', 'okey_platform_free'].every(k => n(a, k) === 2)
        && ['aiTier', 'aiFreeWarning', 'aiFreeAck'].every(k => n(p, k) === 2) && n(g, 'MRS_AI_FREE_CONSENT') === 2) || 'i18n';
    })
  ]);
}

(async () => {
  await secFile();
  await secPreflight();
  db = await freshDb();
  await db.exec(FIXTURES);
  await secOffice();
  await secPlatformAndService();
  await secHandler();
  await db.close();
  await secFront();
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
  process.exit(nFail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
