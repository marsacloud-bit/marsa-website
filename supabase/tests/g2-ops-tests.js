#!/usr/bin/env node
/*
  Marsa (مرسى) — G2.9 / G2.12–G2.14 ops test suite: idempotency rollout, client error log,
  health check, audit reader, schema versions.  LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase.

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql
  Org A = seed "blue-sea" (branches JED, DMM). Org B = "org-b" (inserted as owner).
  Users:
    adminA  admin of org A          supA    supervisor of org A     staffA  clearance_staff org A (all branches)
    bmJ     branch_manager A / JED  noisy   clearance_staff org A (rate-limit probe)
    adminB  admin of org B          staffB  clearance_staff org B   plat    platform admin (no membership)

  Prints PASS / FAIL per case; exit code 1 on any FAIL.
  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g2-ops-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const TX1 = '0b5e0000-0000-4000-8000-000000000201'; // JED, customs_declaration, 2 containers
const TX2 = '0b5e0000-0000-4000-8000-000000000202'; // DMM
const TX3 = '0b5e0000-0000-4000-8000-000000000203'; // JED, air, 0 containers, new
const B = 'bbbb0000-0000-4000-8000-000000000001';
const B_BR = 'bbbb0000-0000-4000-8000-000000000011';
const B_CL = 'bbbb0000-0000-4000-8000-000000000101';
const B_TX = 'bbbb0000-0000-4000-8000-000000000201';

const U = {
  adminA: 'abcd0000-0000-4000-8000-000000000001',
  supA: 'abcd0000-0000-4000-8000-000000000002',
  staffA: 'abcd0000-0000-4000-8000-000000000003',
  bmJ: 'abcd0000-0000-4000-8000-000000000004',
  noisy: 'abcd0000-0000-4000-8000-000000000005',
  adminB: 'abcd0000-0000-4000-8000-000000000006',
  staffB: 'abcd0000-0000-4000-8000-000000000007',
  plat: 'abcd0000-0000-4000-8000-000000000008'
};
const EMAIL = k => k.toLowerCase() + '@ops.example.com';
let keySeq = 0;
const newKey = () => {
  const n = (++keySeq).toString(16).padStart(12, '0');
  return `0e0e0000-0000-4000-8000-${n}`;
};

/* ------------------------------------------------------------------ helpers (same style as rls-tests.js) */
let db;
async function asRole(who, fn, headers) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  if (headers) await db.query(`SELECT set_config('request.headers', $1, false)`, [JSON.stringify(headers)]);
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false); SELECT set_config('request.headers', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
const errText = e => (e && (e.message + ' ' + (e.detail || ''))) || String(e);
const count = async (sql, params) => (await q(sql, params))[0].n;

async function expectErr(name, promiseFn, re) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
}
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e)); }
}
async function denied(who, sql, params) {
  try { const r = await as(who, sql, params); return r.length === 0 ? true : 'returned ' + r.length + ' row(s)'; }
  catch (e) { return /permission denied|row-level security|MRS_|violates/.test(errText(e)) ? true : 'unexpected error: ' + errText(e); }
}
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}
// no idempotency row may contain this secret
const keysContain = async secret => count(
  `SELECT count(*)::int n FROM public.idempotency_keys k WHERE position($1 in coalesce(k.response::text, '')) > 0`, [secret]);

/* ------------------------------------------------------------------ fixtures */
const basePayload = {
  fullName: 'زائر تجريبي', company: 'شركة زائر تجريبية', phone: '0550000011', email: 'visitor@example.com',
  clientType: 'business', crNumber: '7000000011', direction: 'import', service: 'clearance', mode: 'sea',
  country: 'الصين', port: 'ميناء جدة الإسلامي', goods: 'بضاعة اختبار', containerType: '40ft',
  containerNumbers: 'TSTU0000021', count: 1, blNumber: 'OPSBL0001', terms: true
};
let phoneSeq = 0;
const freshPhone = () => '0558' + String(100000 + (phoneSeq++)).slice(-6);
const P = over => ({ ...basePayload, phone: freshPhone(), ...over });
const M = over => ({ name: 'زائر اختبار', phone: freshPhone(), email: 'm@example.com', subject: 'quote',
  message: 'رسالة اختبار التكرار الآمن', consent: true, ...over });

async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${EMAIL(k)}', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.plat}', 'ops test operator');
    INSERT INTO public.organizations (id, slug, name_ar) VALUES ('${B}', 'org-b', 'مؤسسة ب التجريبية');
    INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ('${B_BR}', '${B}', 'RUH', 'فرع الرياض ب');
    INSERT INTO public.clients (id, org_id, client_type, name_ar, phone) VALUES ('${B_CL}', '${B}', 'business', 'عميل ب', '0509999999');
    INSERT INTO public.transactions (id, org_id, branch_id, client_id, operation, mode) VALUES ('${B_TX}', '${B}', '${B_BR}', '${B_CL}', 'import', 'sea');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'),
      ('${U.supA}',   '${A}', NULL, 'supervisor'),
      ('${U.staffA}', '${A}', NULL, 'clearance_staff'),
      ('${U.bmJ}',    '${A}', '${JED}', 'branch_manager'),
      ('${U.noisy}',  '${A}', NULL, 'clearance_staff'),
      ('${U.adminB}', '${B}', NULL, 'admin'),
      ('${U.staffB}', '${B}', NULL, 'clearance_staff');
  `);
}

/* ------------------------------------------------------------------ main */
async function main() {
  db = new PGlite();
  section('load shim + migrations + seed');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return finish();
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return finish();
  // re-runnable on top of itself
  if (!await runFile(path.join(migDir, '20261102000300_ops_observability.sql'))) return finish();
  try { await fixtures(); pass('fixtures: two orgs, admin / supervisor / staff / branch_manager / platform admin'); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }

  /* ---------------------------------------------------------------- catalog + privileges */
  section('schema versions, signatures, privileges');
  await check('schema_versions has a row for every migration file', async () => {
    const rows = await q(`SELECT version, name FROM public.schema_versions`);
    const have = new Set(rows.map(r => r.version + '_' + r.name));
    const missing = migFiles.map(f => f.replace(/\.sql$/, '')).filter(v => !have.has(v));
    return missing.length === 0 || 'missing: ' + missing.join(', ');
  });
  await check('schema_versions holds no version without a migration file', async () => {
    const files = new Set(migFiles.map(f => f.split('_')[0]));
    const extra = (await q(`SELECT version FROM public.schema_versions`)).map(r => r.version).filter(v => !files.has(v));
    return extra.length === 0 || 'extra: ' + extra.join(', ');
  });
  for (const [fn, oldSig] of [['convert_request_to_transaction', 'uuid,uuid,uuid'], ['set_transaction_status', 'uuid,text,text'],
    ['set_financial_status', 'uuid,text,text'], ['issue_tracking_token', 'uuid']]) {
    await check(`${fn}: old signature dropped, exactly one overload, last param p_idem_key uuid DEFAULT NULL`, async () => {
      const r = await q(`SELECT p.oid::regprocedure::text sig, pg_get_function_arguments(p.oid) a FROM pg_proc p
                          JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [fn]);
      const old = (await q(`SELECT to_regprocedure($1) IS NOT NULL x`, [`public.${fn}(${oldSig})`]))[0].x;
      return (r.length === 1 && !old && /p_idem_key uuid DEFAULT NULL(::uuid)?$/.test(r[0].a)) || JSON.stringify(r);
    });
  }
  const NEW_RPCS = ['health_check()', 'log_client_error(jsonb)', 'admin_recent_errors(uuid)', 'platform_recent_errors()',
    'admin_audit_log(uuid,jsonb)', 'submit_service_request(jsonb)', 'submit_contact_message(jsonb)',
    'convert_request_to_transaction(uuid,uuid,uuid,uuid)', 'set_transaction_status(uuid,text,text,uuid)',
    'set_financial_status(uuid,text,text,uuid)', 'issue_tracking_token(uuid,uuid)'];
  const ANON_OK = new Set(['health_check()', 'log_client_error(jsonb)', 'submit_service_request(jsonb)', 'submit_contact_message(jsonb)']);
  for (const fn of NEW_RPCS) {
    await check(`public.${fn}: SECURITY DEFINER, search_path pinned, authenticated yes, anon ${ANON_OK.has(fn) ? 'yes' : 'no'}`, async () => {
      const r = (await q(`SELECT p.prosecdef d, coalesce(array_to_string(p.proconfig, ','), '') c,
                                 has_function_privilege('authenticated', p.oid, 'EXECUTE') x,
                                 has_function_privilege('anon', p.oid, 'EXECUTE') an
                            FROM pg_proc p WHERE p.oid = $1::regprocedure`, ['public.' + fn]))[0];
      return (r.d && /search_path=/.test(r.c) && r.x && r.an === ANON_OK.has(fn)) || JSON.stringify(r);
    });
  }
  await check('app.scrub_text / app.client_errors_purge not executable by the API roles', async () => {
    const r = (await q(`SELECT has_function_privilege('authenticated', 'app.scrub_text(text,int)', 'EXECUTE') a,
                               has_function_privilege('anon', 'app.scrub_text(text,int)', 'EXECUTE') b,
                               has_function_privilege('authenticated', 'app.client_errors_purge(int)', 'EXECUTE') c`))[0];
    return (!r.a && !r.b && !r.c) || JSON.stringify(r);
  });
  await check('schema_versions / client_errors: RLS on, no table grant to anon / authenticated', async () => {
    const r = await q(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relname IN ('schema_versions','client_errors')`);
    const g = await q(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
                        WHERE table_schema = 'public' AND table_name IN ('schema_versions','client_errors')
                          AND grantee IN ('anon','authenticated')`);
    return (r.length === 2 && r.every(x => x.relrowsecurity) && g.length === 0) || JSON.stringify({ r, g });
  });
  for (const who of ['anon', 'staffA', 'adminA']) {
    await check(`${who} cannot read client_errors / schema_versions / idempotency_keys directly`, async () => {
      for (const t of ['client_errors', 'schema_versions', 'idempotency_keys']) {
        const d = await denied(who, `SELECT 1 FROM public.${t} LIMIT 1`);
        if (d !== true) return t + ': ' + d;
      }
      return true;
    });
  }
  await check('anon cannot INSERT into client_errors directly', () => denied('anon',
    `INSERT INTO public.client_errors (actor_key, message) VALUES ($1, 'x') RETURNING 1`, ['0'.repeat(64)]));

  /* ---------------------------------------------------------------- health check */
  section('health_check');
  for (const who of ['anon', 'staffB']) {
    await check(`${who}: health_check → ok, staging, latest schema version, nothing tenant-specific`, async () => {
      const r = await rpc(who, `SELECT public.health_check() r`);
      const keys = Object.keys(r).sort().join(',');
      const latest = migFiles[migFiles.length - 1].split('_')[0];
      const txt = JSON.stringify(r);
      if (keys !== 'db_time,environment,ok,schema_version') return 'keys: ' + keys;
      if (r.ok !== true || r.environment !== 'staging' || r.schema_version !== latest) return txt;
      if (/blue-sea|org-b|0b5e0000|bbbb0000/.test(txt)) return 'tenant data in ' + txt;
      return true;
    });
  }

  /* ---------------------------------------------------------------- idempotency: public intake */
  section('idempotency: submit_service_request / submit_contact_message');
  {
    const K = newKey();
    const p = P({ idempotencyKey: K });
    let r1, r2;
    await check('submit_service_request: first call returns the tracking token once', async () => {
      r1 = await rpc('anon', `SELECT public.submit_service_request($1) r`, [p]);
      return (r1.ref && /^[0-9a-f]{64}$/.test(r1.tracking_token) && r1.token_shown === false && !r1.replayed) || JSON.stringify(r1);
    });
    await check('submit_service_request: replay → same ref, replayed, tracking_token null, token_shown true', async () => {
      r2 = await rpc('anon', `SELECT public.submit_service_request($1) r`, [p]);
      return (r2.ref === r1.ref && r2.replayed === true && r2.tracking_token === null && r2.token === null && r2.token_shown === true)
        || JSON.stringify(r2);
    });
    await check('submit_service_request: exactly one row for the replayed key', async () =>
      (await count(`SELECT count(*)::int n FROM public.service_requests WHERE phone = $1`, [p.phone])) === 1);
    await check('submit_service_request: tracking token is not stored in idempotency_keys', async () =>
      (await keysContain(r1.tracking_token)) === 0 || 'token found in idempotency_keys.response');
    await check('submit_service_request: the first token still tracks the request after a replay', async () => {
      const t = await rpc('anon', `SELECT public.public_track($1, $2) r`, [r1.ref, r1.tracking_token]);
      return !!t || 'public_track returned nothing';
    });
    await expectErr('submit_service_request: same key + different payload → MRS_IDEMPOTENCY_CONFLICT',
      () => as('anon', `SELECT public.submit_service_request($1)`, [{ ...p, goods: 'بضاعة مختلفة تماما' }]), /MRS_IDEMPOTENCY_CONFLICT/);
    await expectErr('submit_service_request: another user replaying the key → MRS_IDEMPOTENCY_CONFLICT',
      () => as('staffA', `SELECT public.submit_service_request($1)`, [p]), /MRS_IDEMPOTENCY_CONFLICT/);
    await expectErr('submit_service_request: malformed key → MRS_INVALID',
      () => as('anon', `SELECT public.submit_service_request($1)`, [P({ idempotencyKey: 'not-a-uuid' })]), /MRS_INVALID/);

    const K2 = newKey();
    const bad = P({ idempotencyKey: K2, phone: '123' });
    await expectErr('submit_service_request: a failing call…', () => as('anon', `SELECT public.submit_service_request($1)`, [bad]), /MRS_INVALID/);
    await check('…leaves no idempotency row (rolled back with the work)', async () =>
      (await count(`SELECT count(*)::int n FROM public.idempotency_keys WHERE key = $1`, [K2])) === 0);
    await check('…and a retry with the same key and a corrected payload succeeds once', async () => {
      const good = { ...bad, phone: freshPhone() };
      const a = await rpc('anon', `SELECT public.submit_service_request($1) r`, [good]);
      const b = await rpc('anon', `SELECT public.submit_service_request($1) r`, [good]);
      const n = await count(`SELECT count(*)::int n FROM public.service_requests WHERE phone = $1`, [good.phone]);
      return (a.ref && b.ref === a.ref && b.replayed && n === 1) || JSON.stringify({ a, b, n });
    });
    await check('submit_service_request: a committed submission still replays after intake was closed; a new key is refused', async () => {
      const k = newKey(), x = P({ idempotencyKey: k });
      const a = await rpc('anon', `SELECT public.submit_service_request($1) r`, [x]);
      await q(`UPDATE public.organizations SET public_intake_enabled = false WHERE id = $1`, [A]);
      let b = null, e1 = '';
      try {
        b = await rpc('anon', `SELECT public.submit_service_request($1) r`, [x]);
        try { await as('anon', `SELECT public.submit_service_request($1)`, [P({ idempotencyKey: newKey() })]); } catch (e) { e1 = errText(e); }
      } finally { await q(`UPDATE public.organizations SET public_intake_enabled = true WHERE id = $1`, [A]); }
      return (b && b.ref === a.ref && b.replayed === true && /MRS_INTAKE_CLOSED/.test(e1)) || JSON.stringify({ a, b, e1 });
    });
    await expectErr('submit_service_request: unknown org slug → MRS_INTAKE_CLOSED (with a key too)',
      () => as('anon', `SELECT public.submit_service_request($1)`, [P({ orgSlug: 'no-such-org', idempotencyKey: newKey() })]), /MRS_INTAKE_CLOSED/);
    await check('submit_service_request without a key: old behaviour (two calls → two rows)', async () => {
      const x = P();
      await as('anon', `SELECT public.submit_service_request($1)`, [x]);
      await as('anon', `SELECT public.submit_service_request($1)`, [x]);
      return (await count(`SELECT count(*)::int n FROM public.service_requests WHERE phone = $1`, [x.phone])) === 2;
    });
  }
  {
    const K = newKey();
    const m = M({ idempotencyKey: K });
    let r1;
    await check('submit_contact_message: replay → same ref, replayed, one row', async () => {
      r1 = await rpc('anon', `SELECT public.submit_contact_message($1) r`, [m]);
      const r2 = await rpc('anon', `SELECT public.submit_contact_message($1) r`, [m]);
      const n = await count(`SELECT count(*)::int n FROM public.contact_messages WHERE phone = $1`, [m.phone]);
      return (r1.ref && !r1.replayed && r2.ref === r1.ref && r2.replayed === true && n === 1) || JSON.stringify({ r1, r2, n });
    });
    await expectErr('submit_contact_message: same key + different payload → MRS_IDEMPOTENCY_CONFLICT',
      () => as('anon', `SELECT public.submit_contact_message($1)`, [{ ...m, message: 'رسالة مختلفة لاختبار التعارض' }]), /MRS_IDEMPOTENCY_CONFLICT/);
    await expectErr('submit_contact_message: another user replaying the key → MRS_IDEMPOTENCY_CONFLICT',
      () => as('staffB', `SELECT public.submit_contact_message($1)`, [m]), /MRS_IDEMPOTENCY_CONFLICT/);
    const K2 = newKey();
    await expectErr('submit_contact_message: failing call (no consent)…',
      () => as('anon', `SELECT public.submit_contact_message($1)`, [M({ idempotencyKey: K2, consent: false })]), /MRS_REQUIRED/);
    await check('…rolls back its key; retry with the same key succeeds', async () => {
      const n0 = await count(`SELECT count(*)::int n FROM public.idempotency_keys WHERE key = $1`, [K2]);
      const r = await rpc('anon', `SELECT public.submit_contact_message($1) r`, [M({ idempotencyKey: K2 })]);
      return (n0 === 0 && r.ref && !r.replayed) || JSON.stringify({ n0, r });
    });
    await check('submit_contact_message: replay works after intake was closed; a new key is refused', async () => {
      const x = M({ idempotencyKey: newKey() });
      const a = await rpc('anon', `SELECT public.submit_contact_message($1) r`, [x]);
      await q(`UPDATE public.organizations SET public_intake_enabled = false WHERE id = $1`, [A]);
      let b = null, e1 = '';
      try {
        b = await rpc('anon', `SELECT public.submit_contact_message($1) r`, [x]);
        try { await as('anon', `SELECT public.submit_contact_message($1)`, [M({ idempotencyKey: newKey() })]); } catch (e) { e1 = errText(e); }
      } finally { await q(`UPDATE public.organizations SET public_intake_enabled = true WHERE id = $1`, [A]); }
      return (b && b.ref === a.ref && b.replayed === true && /MRS_INTAKE_CLOSED/.test(e1)) || JSON.stringify({ a, b, e1 });
    });
  }

  /* ---------------------------------------------------------------- idempotency: staff RPCs */
  section('idempotency: convert_request_to_transaction');
  {
    const reqOf = async ref => (await q(`SELECT id::text id FROM public.service_requests WHERE ref = $1`, [ref]))[0].id;
    const ra = await rpc('anon', `SELECT public.submit_service_request($1) r`, [P({ crNumber: '7000000901', blNumber: 'OPSBL0901' })]);
    const rb = await rpc('anon', `SELECT public.submit_service_request($1) r`, [P({ crNumber: '7000000902', blNumber: 'OPSBL0902' })]);
    const REQ1 = await reqOf(ra.ref), REQ2 = await reqOf(rb.ref);
    const K = newKey();
    let c1;
    await check('convert: replay → same transaction, replayed, exactly one transaction', async () => {
      c1 = await rpc('staffA', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [REQ1, JED, K]);
      const c2 = await rpc('staffA', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [REQ1, JED, K]);
      const n = await count(`SELECT count(*)::int n FROM public.transactions WHERE request_id = $1`, [REQ1]);
      return (c1.transaction_id && c2.transaction_id === c1.transaction_id && c2.ref === c1.ref && c2.replayed === true && n === 1)
        || JSON.stringify({ c1, c2, n });
    });
    await expectErr('convert: new key on a converted request → MRS_ALREADY_CONVERTED (unchanged guard)',
      () => as('staffA', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3)`, [REQ1, JED, newKey()]), /MRS_ALREADY_CONVERTED/);
    await expectErr('convert: same key + different arguments → MRS_IDEMPOTENCY_CONFLICT',
      () => as('staffA', `SELECT public.convert_request_to_transaction($1, NULL, NULL, $2)`, [REQ1, K]), /MRS_IDEMPOTENCY_CONFLICT/);
    await expectErr('convert: another user with the same key → MRS_IDEMPOTENCY_CONFLICT',
      () => as('adminA', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3)`, [REQ1, JED, K]), /MRS_IDEMPOTENCY_CONFLICT/);
    await expectErr('convert: org-B staff with the key → MRS_NOT_FOUND (access check before replay)',
      () => as('staffB', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3)`, [REQ1, JED, K]), /MRS_NOT_FOUND/);
    const K2 = newKey();
    await expectErr('convert: failing call (org-B client)…',
      () => as('staffA', `SELECT public.convert_request_to_transaction($1, $2, $3, $4)`, [REQ2, JED, B_CL, K2]), /MRS_NOT_FOUND/);
    await check('…rolls back its key; retry with the same key converts once', async () => {
      const n0 = await count(`SELECT count(*)::int n FROM public.idempotency_keys WHERE key = $1`, [K2]);
      const r = await rpc('staffA', `SELECT public.convert_request_to_transaction($1, $2, NULL, $3) r`, [REQ2, JED, K2]);
      const n = await count(`SELECT count(*)::int n FROM public.transactions WHERE request_id = $1`, [REQ2]);
      return (n0 === 0 && r.transaction_id && n === 1) || JSON.stringify({ n0, r, n });
    });
  }

  section('idempotency: set_transaction_status / set_financial_status');
  {
    const K = newKey();
    const evs = () => count(`SELECT count(*)::int n FROM public.transaction_events
                              WHERE transaction_id = $1 AND event_type = 'operational_status' AND to_status = 'in_progress'`, [TX3]);
    await check('set_transaction_status: replay → same event, replayed, one event', async () => {
      const a = await rpc('staffA', `SELECT public.set_transaction_status($1, 'in_progress', NULL, $2) r`, [TX3, K]);
      const b = await rpc('staffA', `SELECT public.set_transaction_status($1, 'in_progress', NULL, $2) r`, [TX3, K]);
      const n = await evs();
      return (a.event_id && b.event_id === a.event_id && b.replayed === true && !a.replayed && n === 1) || JSON.stringify({ a, b, n });
    });
    await expectErr('set_transaction_status: same key + different note → MRS_IDEMPOTENCY_CONFLICT',
      () => as('staffA', `SELECT public.set_transaction_status($1, 'in_progress', 'x', $2)`, [TX3, K]), /MRS_IDEMPOTENCY_CONFLICT/);
    await expectErr('set_transaction_status: another user with the same key → MRS_IDEMPOTENCY_CONFLICT',
      () => as('bmJ', `SELECT public.set_transaction_status($1, 'in_progress', NULL, $2)`, [TX3, K]), /MRS_IDEMPOTENCY_CONFLICT/);
    await expectErr('set_transaction_status: without a key a repeat is refused as before (same_status)',
      () => as('staffA', `SELECT public.set_transaction_status($1, 'in_progress', NULL)`, [TX3]), /MRS_BAD_TRANSITION/);
    const K2 = newKey();
    await expectErr('set_transaction_status: failing call (unknown status)…',
      () => as('staffA', `SELECT public.set_transaction_status($1, 'bogus', NULL, $2)`, [TX3, K2]), /MRS_INVALID/);
    await check('…rolls back its key; retry with the same key succeeds', async () => {
      const n0 = await count(`SELECT count(*)::int n FROM public.idempotency_keys WHERE key = $1`, [K2]);
      const r = await rpc('staffA', `SELECT public.set_transaction_status($1, 'customs_declaration', NULL, $2) r`, [TX3, K2]);
      return (n0 === 0 && r.to === 'customs_declaration' && !r.replayed) || JSON.stringify({ n0, r });
    });
    await check('set_transaction_status: branch_manager rights from 0200 kept (backward correction with reason)', async () => {
      const r = await rpc('bmJ', `SELECT public.set_transaction_status($1, 'in_progress', 'تصحيح', $2) r`, [TX3, newKey()]);
      return r.to === 'in_progress' || JSON.stringify(r);
    });
    await expectErr('set_transaction_status: branch_manager still limited to its branch',
      () => as('bmJ', `SELECT public.set_transaction_status($1, 'appointment', NULL, $2)`, [TX2, newKey()]), /MRS_NOT_FOUND/);

    const FK = newKey();
    await check('set_financial_status: replay → same event, replayed, one event', async () => {
      const a = await rpc('adminA', `SELECT public.set_financial_status($1, 'estimate_only', NULL, $2) r`, [TX1, FK]);
      const b = await rpc('adminA', `SELECT public.set_financial_status($1, 'estimate_only', NULL, $2) r`, [TX1, FK]);
      const n = await count(`SELECT count(*)::int n FROM public.transaction_events
                              WHERE transaction_id = $1 AND event_type = 'financial_status' AND to_status = 'estimate_only'`, [TX1]);
      return (a.event_id && b.event_id === a.event_id && b.replayed === true && n === 1) || JSON.stringify({ a, b, n });
    });
    await expectErr('set_financial_status: same key + different status → MRS_IDEMPOTENCY_CONFLICT',
      () => as('adminA', `SELECT public.set_financial_status($1, 'draft_pending', NULL, $2)`, [TX1, FK]), /MRS_IDEMPOTENCY_CONFLICT/);
    const FK2 = newKey();
    await expectErr('set_financial_status: failing call (clearance staff)…',
      () => as('staffA', `SELECT public.set_financial_status($1, 'draft_pending', NULL, $2)`, [TX1, FK2]), /MRS_FORBIDDEN/);
    await check('…rolls back its key; adminA can then use a key of its own', async () => {
      const n0 = await count(`SELECT count(*)::int n FROM public.idempotency_keys WHERE key = $1`, [FK2]);
      const r = await rpc('adminA', `SELECT public.set_financial_status($1, 'draft_pending', NULL, $2) r`, [TX1, FK2]);
      return (n0 === 0 && r.to === 'draft_pending') || JSON.stringify({ n0, r });
    });
  }

  section('idempotency: issue_tracking_token (secret never stored)');
  {
    const K = newKey();
    let t1;
    await check('issue_tracking_token: first call returns a token', async () => {
      t1 = await rpc('staffA', `SELECT public.issue_tracking_token($1, $2) r`, [TX1, K]);
      return (/^[0-9a-f]{64}$/.test(t1.tracking_token) && t1.token_shown === false) || JSON.stringify(t1);
    });
    await check('issue_tracking_token: replay → token null, token_shown true, the token was NOT rotated again', async () => {
      const t2 = await rpc('staffA', `SELECT public.issue_tracking_token($1, $2) r`, [TX1, K]);
      const ok = (await q(`SELECT tracking_token_hash = app.hash_token($2) ok FROM public.transactions WHERE id = $1`, [TX1, t1.tracking_token]))[0].ok;
      const n = await count(`SELECT count(*)::int n FROM public.transaction_events WHERE transaction_id = $1 AND event_type = 'tracking_token'`, [TX1]);
      return (t2.replayed === true && t2.tracking_token === null && t2.token === null && t2.token_shown === true && t2.ref === t1.ref && ok && n === 1)
        || JSON.stringify({ t2, ok, n });
    });
    await check('issue_tracking_token: token not present anywhere in idempotency_keys', async () =>
      (await keysContain(t1.tracking_token)) === 0 || 'token found in idempotency_keys.response');
    await expectErr('issue_tracking_token: another user with the same key → MRS_IDEMPOTENCY_CONFLICT',
      () => as('adminA', `SELECT public.issue_tracking_token($1, $2)`, [TX1, K]), /MRS_IDEMPOTENCY_CONFLICT/);
    await check('no idempotency row holds any 64-hex secret', async () =>
      (await count(`SELECT count(*)::int n FROM public.idempotency_keys k WHERE k.response::text ~ '[0-9a-f]{64}'`)) === 0);
  }

  /* ---------------------------------------------------------------- client error log */
  section('log_client_error: scrubbing, limits, attribution');
  const lastErr = async () => (await q(`SELECT * FROM public.client_errors ORDER BY id DESC LIMIT 1`))[0];
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6ImFub24ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const SECRET_HEX = 'ab12'.repeat(16);
  await check('anon: e-mails, phones, long digit runs, JWTs, tokens and query strings are scrubbed', async () => {
    const r = await rpc('anon', `SELECT public.log_client_error($1) r`, [{
      page: '/login.html?invite=' + SECRET_HEX + '#frag',
      code: 'TypeError<script>',
      message: `Failed for ali.saleh@example.com phone +966 55 123 4567 or 0551234567 or ٠٥٥١٢٣٤٥٦٧ cr 7000000001 ` +
               `jwt ${JWT} token=${SECRET_HEX} Bearer abcdefghijklmnop12345 sb_secret_abcdefgh12345678`,
      ua: 'Mozilla/5.0 test@example.org'
    }]);
    const e = await lastErr();
    const all = [e.page, e.code, e.message, e.ua].join(' | ');
    const leaks = ['ali.saleh', 'example.com', '123 4567', '0551234567', '٠٥٥', '7000000001', 'eyJ', SECRET_HEX, 'abcdefghijklmnop', 'sb_secret_abc', 'invite', 'frag', 'test@'];
    const found = leaks.filter(l => all.includes(l));
    if (!r.logged) return 'not logged: ' + JSON.stringify(r);
    if (found.length) return 'leaked ' + found.join(', ') + ' in: ' + all;
    if (e.page !== '/login.html' || e.code !== 'TypeErrorscript' || !/\[email\]/.test(e.message) || !/\[jwt\]/.test(e.message) || !/\[number\]/.test(e.message))
      return 'unexpected scrub result: ' + all;
    if (e.user_id !== null || e.org_id !== null) return 'visitor row attributed: ' + JSON.stringify(e);
    return true;
  });
  await check('fields are truncated (message 500, page 200, ua 200)', async () => {
    await as('anon', `SELECT public.log_client_error($1)`, [{ message: 'م'.repeat(2000), page: '/p' + 'a/'.repeat(300), ua: 'U'.repeat(10) + ' x'.repeat(400) }]);
    const e = await lastErr();
    return (e.message.length === 500 && e.page.length <= 200 && e.ua.length <= 200) || JSON.stringify([e.message.length, e.page.length, e.ua.length]);
  });
  await expectErr('oversized payload → MRS_TOO_LONG', () => as('anon', `SELECT public.log_client_error($1)`, [{ message: 'x'.repeat(9000) }]), /MRS_TOO_LONG/);
  await check('bad input never raises: null / array / string / wrong types / empty → {logged:false}', async () => {
    for (const p of [null, [], 'oops', { message: 42, code: { a: 1 } }, {}, { page: '/x' }]) {
      const r = await rpc('anon', `SELECT public.log_client_error($1::jsonb) r`, [p === null ? null : JSON.stringify(p)]);
      if (r.logged !== false) return 'logged for ' + JSON.stringify(p);
    }
    return true;
  });
  await check('attribution: member → its org; visitor / foreign member → no org', async () => {
    await as('staffA', `SELECT public.log_client_error($1)`, [{ orgId: A, message: 'staffA error', code: 'E1' }]);
    const a = await lastErr();
    await as('staffB', `SELECT public.log_client_error($1)`, [{ orgId: A, message: 'staffB claims org A', code: 'E2' }]);
    const b = await lastErr();
    await as('anon', `SELECT public.log_client_error($1)`, [{ orgId: A, message: 'visitor claims org A', code: 'E3' }]);
    const c = await lastErr();
    await as('staffB', `SELECT public.log_client_error($1)`, [{ orgId: B, message: 'staffB own org error', code: 'E4' }]);
    const d = await lastErr();
    return (a.org_id === A && a.user_id === U.staffA && b.org_id === null && c.org_id === null && c.user_id === null && d.org_id === B)
      || JSON.stringify({ a: [a.org_id, a.user_id], b: b.org_id, c: c.org_id, d: d.org_id });
  });
  await check('rate limit: a signed-in user gets at most 20 rows per 10 minutes, then {logged:false}', async () => {
    let ok = 0, dropped = 0;
    for (let i = 0; i < 25; i++) {
      const r = await rpc('noisy', `SELECT public.log_client_error($1) r`, [{ message: 'noisy ' + i, orgId: A }]);
      r.logged ? ok++ : dropped++;
    }
    const n = await count(`SELECT count(*)::int n FROM public.client_errors WHERE user_id = $1`, [U.noisy]);
    return (ok === 20 && dropped === 5 && n === 20) || JSON.stringify({ ok, dropped, n });
  });
  await check('rate limit: per visitor (forwarded IP), another visitor is unaffected; IP never stored', async () => {
    let ok = 0;
    for (let i = 0; i < 22; i++) {
      const r = await asRole('anon', () => q(`SELECT public.log_client_error($1) r`, [{ message: 'v1 ' + i }]), { 'x-forwarded-for': '10.0.0.1, 203.0.113.7' });
      if (r[0].r.logged) ok++;
    }
    const other = await asRole('anon', () => q(`SELECT public.log_client_error($1) r`, [{ message: 'v2' }]), { 'x-forwarded-for': '198.51.100.9' });
    const ipStored = await count(`SELECT count(*)::int n FROM public.client_errors e WHERE (e.*)::text LIKE '%203.0.113.7%'`);
    return (ok === 20 && other[0].r.logged === true && ipStored === 0) || JSON.stringify({ ok, other: other[0].r, ipStored });
  });
  await check('rate limit: rotating the client-controlled FIRST X-Forwarded-For hop does not bypass the per-visitor cap', async () => {
    let ok = 0;
    for (let i = 0; i < 40; i++) {
      const r = await asRole('anon', () => q(`SELECT public.log_client_error($1) r`, [{ message: 'spoof ' + i }]),
        { 'x-forwarded-for': `10.9.${i}.1, 198.51.100.77` });
      if (r[0].r.logged) ok++;
    }
    return ok === 20 || 'logged ' + ok + ' of 40';
  });
  await check('rate limit: cf-connecting-ip wins over X-Forwarded-For; a non-IP header value is ignored', async () => {
    let ok = 0;
    for (let i = 0; i < 25; i++) {
      const r = await asRole('anon', () => q(`SELECT public.log_client_error($1) r`, [{ message: 'cf ' + i }]),
        { 'cf-connecting-ip': '192.0.2.44', 'x-forwarded-for': `10.8.${i}.1, 10.7.${i}.1` });
      if (r[0].r.logged) ok++;
    }
    const junk = await asRole('anon', () => q(`SELECT public.log_client_error($1) r`, [{ message: 'junk hdr', visitorId: '0f0f0f0f-0000-4000-8000-00000000abcd' }]),
      { 'x-forwarded-for': 'not an ip <script>' });
    return (ok === 20 && junk[0].r.logged === true) || JSON.stringify({ ok, junk: junk[0].r });
  });
  await check('rate limit: visitors share at most 300 rows per 10 min; signed-in errors still logged after that', async () => {
    const anonNow = await count(`SELECT count(*)::int n FROM public.client_errors WHERE user_id IS NULL AND created_at > now() - interval '10 minutes'`);
    let i = 0;
    for (; i < 400 - anonNow; i++) {
      const r = await asRole('anon', () => q(`SELECT public.log_client_error($1) r`, [{ message: 'flood ' + i }]),
        { 'cf-connecting-ip': `198.18.${Math.floor(i / 200)}.${i % 200}` });
      if (!r[0].r.logged) break;
    }
    const anonAfter = await count(`SELECT count(*)::int n FROM public.client_errors WHERE user_id IS NULL AND created_at > now() - interval '10 minutes'`);
    const signed = await rpc('staffA', `SELECT public.log_client_error($1) r`, [{ message: 'signed-in still logged', orgId: A }]);
    // reset the window for the rest of the suite (the flood rows are noise)
    await q(`DELETE FROM public.client_errors WHERE message LIKE 'flood %'`);
    return (anonAfter === 300 && signed.logged === true) || JSON.stringify({ anonNow, i, anonAfter, signed });
  });
  await check('scrub: spaced / dashed cards, spaced mobile, landline, spaced ID, %40 e-mail and IBAN are masked', async () => {
    const msg = 'card 4111 1111 1111 1111 / 4111-1111-1111-1111 phone 05 5000 0011 landline 012 345 6789 ' +
      'id 1 0 2 3 4 5 6 7 8 9 mail ali%40example.com iban SA03 8000 0000 6080 1016 7519 / SA0380000000608010167519 v1.2.3';
    const r = (await q(`SELECT app.scrub_text($1, 500) t`, [msg]))[0].t;
    const leaks = ['4111', '5000 0011', '345 6789', '7 8 9', 'ali', 'example.com', 'SA03', '7519'].filter(l => r.includes(l));
    return (leaks.length === 0 && /\[iban\]/.test(r) && /\[email\]/.test(r) && r.includes('v1.2.3')) || 'leaked ' + leaks.join(', ') + ' in: ' + r;
  });

  section('client error readers: isolation');
  await check('adminA: admin_recent_errors(A) shows org A rows only', async () => {
    const r = await rpc('adminA', `SELECT public.admin_recent_errors($1) r`, [A]);
    const ids = r.map(x => x.id);
    const foreign = await count(`SELECT count(*)::int n FROM public.client_errors WHERE id = ANY ($1::bigint[]) AND org_id IS DISTINCT FROM $2`, [ids, A]);
    const msgs = r.map(x => x.message).join('|');
    return (r.length > 0 && foreign === 0 && msgs.includes('staffA error') && !msgs.includes('staffB') && !msgs.includes('visitor')
      && r.some(x => x.user_email === EMAIL('staffA'))) || JSON.stringify({ n: r.length, foreign, msgs: msgs.slice(0, 200) });
  });
  await check('adminB: admin_recent_errors(B) shows its own row, nothing of org A', async () => {
    const r = await rpc('adminB', `SELECT public.admin_recent_errors($1) r`, [B]);
    return (r.length === 1 && r[0].message === 'staffB own org error') || JSON.stringify(r);
  });
  for (const [who, org] of [['adminA', B], ['adminB', A], ['staffA', A], ['bmJ', A], ['supA', A], ['plat', A]]) {
    await expectErr(`${who} refused: admin_recent_errors(${org === A ? 'A' : 'B'})`,
      () => as(who, `SELECT public.admin_recent_errors($1)`, [org]), /MRS_FORBIDDEN/);
  }
  await expectErr('anon refused: admin_recent_errors', () => as('anon', `SELECT public.admin_recent_errors($1)`, [A]), /permission denied/);
  await check('plat: platform_recent_errors sees all orgs, no user identity', async () => {
    const r = await rpc('plat', `SELECT public.platform_recent_errors() r`);
    const txt = JSON.stringify(r);
    const orgs = new Set(r.map(x => x.org_slug));
    return (r.length > 0 && r.length <= 200 && orgs.has('blue-sea') && orgs.has('org-b') && orgs.has(null)
      && !/user_id|user_email/.test(txt) && !txt.includes(U.staffA)) || txt.slice(0, 300);
  });
  for (const who of ['adminA', 'staffB']) {
    await expectErr(`${who} refused: platform_recent_errors`, () => as(who, `SELECT public.platform_recent_errors()`), /MRS_FORBIDDEN/);
  }
  await check('global limit: ≥ 500 rows in 10 minutes → new errors dropped', async () => {
    await q(`INSERT INTO public.client_errors (actor_key, message)
             SELECT app.hash_token('flood' || g), 'flood' FROM generate_series(1, 500) g`);
    const r = await rpc('adminB', `SELECT public.log_client_error($1) r`, [{ message: 'after flood', orgId: B }]);
    await q(`DELETE FROM public.client_errors WHERE message = 'flood'`);
    return r.logged === false || JSON.stringify(r);
  });

  /* ---------------------------------------------------------------- audit reader */
  section('admin_audit_log');
  await check('adminA: rows of org A only, newest first, actor e-mail present', async () => {
    const r = await rpc('adminA', `SELECT public.admin_audit_log($1, '{}') r`, [A]);
    const ids = r.items.map(x => x.id);
    const foreign = await count(`SELECT count(*)::int n FROM public.audit_log WHERE id = ANY ($1::bigint[]) AND org_id IS DISTINCT FROM $2`, [ids, A]);
    const sorted = ids.every((v, i) => i === 0 || Number(ids[i - 1]) > Number(v));
    return (r.items.length > 0 && r.items.length <= 50 && foreign === 0 && sorted && r.items.some(x => x.actor_email === EMAIL('staffA')))
      || JSON.stringify({ n: r.items.length, foreign, sorted });
  });
  await check('supervisor of org A may read the audit log', async () => {
    const r = await rpc('supA', `SELECT public.admin_audit_log($1, '{"limit": 5}') r`, [A]);
    return r.items.length === 5 || JSON.stringify(r).slice(0, 200);
  });
  await check('filters: actor + table_name', async () => {
    const r = await rpc('adminA', `SELECT public.admin_audit_log($1, $2) r`, [A, { actor: U.staffA, table_name: 'transactions' }]);
    return (r.items.length > 0 && r.items.every(x => x.actor === U.staffA && x.actor_email === EMAIL('staffA') && x.table_name === 'transactions'))
      || JSON.stringify(r).slice(0, 300);
  });
  await check('filters: row_id and a time window in the past → empty', async () => {
    const a = await rpc('adminA', `SELECT public.admin_audit_log($1, $2) r`, [A, { row_id: TX3 }]);
    const b = await rpc('adminA', `SELECT public.admin_audit_log($1, $2) r`, [A, { to: '2000-01-01T00:00:00Z' }]);
    const c = await rpc('adminA', `SELECT public.admin_audit_log($1, $2) r`, [A, { from: '2000-01-01', to: '2999-01-01', limit: 3 }]);
    return (a.items.length > 0 && a.items.every(x => x.row_id === TX3) && b.items.length === 0 && b.next_before_id === null && c.items.length === 3)
      || JSON.stringify({ a: a.items.length, b, c: c.items.length });
  });
  await check('pagination: before_id keyset, no overlap, limit capped at 200', async () => {
    const p1 = await rpc('adminA', `SELECT public.admin_audit_log($1, '{"limit": 3}') r`, [A]);
    const p2 = await rpc('adminA', `SELECT public.admin_audit_log($1, $2) r`, [A, { limit: 3, before_id: p1.next_before_id }]);
    const big = await rpc('adminA', `SELECT public.admin_audit_log($1, '{"limit": 999}') r`, [A]);
    const ids1 = p1.items.map(x => Number(x.id)), ids2 = p2.items.map(x => Number(x.id));
    return (ids1.length === 3 && Number(p1.next_before_id) === Math.min(...ids1) && ids2.length === 3
      && Math.max(...ids2) < Math.min(...ids1) && big.items.length <= 200)
      || JSON.stringify({ ids1, next: p1.next_before_id, ids2, big: big.items.length });
  });
  await expectErr('unknown filter key → MRS_INVALID', () => as('adminA', `SELECT public.admin_audit_log($1, '{"org_id": 1}')`, [A]), /MRS_INVALID.*unknown_key/);
  await expectErr('bad date → MRS_INVALID from', () => as('adminA', `SELECT public.admin_audit_log($1, '{"from": "yesterday-ish"}')`, [A]), /MRS_INVALID.*from/);
  await expectErr('bad table name → MRS_INVALID', () => as('adminA', `SELECT public.admin_audit_log($1, $2)`, [A, { table_name: "x'; drop" }]), /MRS_INVALID/);
  await expectErr('bad before_id → MRS_INVALID', () => as('adminA', `SELECT public.admin_audit_log($1, '{"before_id": "-1"}')`, [A]), /MRS_INVALID/);
  for (const [who, org, lbl] of [['adminA', B, 'org A admin on org B'], ['adminB', A, 'org B admin on org A'], ['staffA', A, 'clearance staff'],
    ['bmJ', A, 'branch_manager'], ['plat', A, 'platform admin'], ['staffB', B, 'org B staff']]) {
    await expectErr(`audit reader refused: ${lbl}`, () => as(who, `SELECT public.admin_audit_log($1, '{}')`, [org]), /MRS_FORBIDDEN/);
  }
  await expectErr('audit reader refused: anon', () => as('anon', `SELECT public.admin_audit_log($1, '{}')`, [A]), /permission denied/);

  finish();
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
