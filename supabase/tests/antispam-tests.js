#!/usr/bin/env node
/*
  Marsa (مرسى) — public anti-spam: migration 20261113000100_public_antispam.sql + the public forms that send the
  form signals (request.html / contact.html, supa.js, i18n.js) — docs/online/ANTISPAM_AR.md. LOCAL TESTS ONLY. Runs on
  PGlite (real Postgres 16 in memory). Never point it at Supabase. No network.

  One database: shim → every migration → seed.sql → fixtures. An API request is simulated the way PostgREST does it:
  role anon / authenticated + request.jwt.claims + request.headers (JSON; the visitor IP in cf-connecting-ip — the
  only trusted header by default; x-real-ip / x-forwarded-for opt-in). No request.headers = a direct database session
  (SQL Editor, cron, the older suites).

  Covers: file conventions + all_migrations.sql; preflight + re-run (salt, tuned limits and counters kept); catalog delta
  (exactly the new app objects, the 4 re-created bodies with unchanged signatures / ACL, no new public function);
  grants (no API role reads / writes the limiter tables or runs the helpers; anon still exactly the 6 public RPCs);
  per-IP limits (request / contact 5 per 10 min + 20 per day, independent IPs, independent actions, sliding window,
  the site-wide unknown bucket 15 per 10 min); client IP (cf-connecting-ip only by default, forged x-real-ip /
  X-Forwarded-For ignored, opt-in headers each validated with fall-through, xff_trusted_hops, src recorded, IPv6 /64 +
  /48 bucket, IPv4-mapped); signed-in users (non-member: user bucket + IP × factor; member / client of the org: exempt);
  hashing (salted sha256, no raw IP stored, nothing secret in the stats); form signals (decoy, fill time, bad types —
  one generic refusal identical to the IP limit), stripped from the payload and from the idempotency hash; backward
  compatibility (no signals, no headers, signed-in users, require_form_signals switch); a refusal / a later error
  commits no counter; idempotent replay is never limited; public_track 30 per 10 min counting failed guesses too (a
  miss is the value {"not_found": true}, VOLATILE now); log_client_error on the same trusted-header policy; purge
  through app.client_errors_purge (result unchanged); stats (sources, warnings); the front-end wiring (static + vm).

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/antispam-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261113000100_public_antispam.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

// No network anywhere
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in antispam-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const SEED_TOKEN = 'deadbeef'.repeat(8);                     // seed.sql public request (known TEST token)
// stranger: signed in, no membership / client link anywhere; staff: member of A; portal: client user of A's client 101
const U = { stranger: 'a5a00000-0000-4000-8000-000000000001', staff: 'a5a00000-0000-4000-8000-000000000002',
  portal: 'a5a00000-0000-4000-8000-000000000003' };
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';

/* ------------------------------------------------------------------ helpers */
let db;
// who: 'anon' | 'direct' (anon role, no request.headers) | a U key; headers: object (an API request) or null
async function asRole(who, fn, headers) {
  if (who === 'anon' || who === 'direct') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  if (who !== 'direct' && headers !== null) {
    await db.query(`SELECT set_config('request.headers', $1, false)`, [JSON.stringify(headers || {})]);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false); SELECT set_config('request.headers', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params, headers) => asRole(who, () => q(sql, params), headers);
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
// the exact refusal of every anti-spam check (message + detail): MRS_RATE_LIMITED / try_later
async function refusal(fn) {
  try { await fn(); return 'accepted'; } catch (e) { return e.message === 'MRS_RATE_LIMITED' && e.detail === 'try_later' ? 'refused' : 'other: ' + errText(e); }
}
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
async function freshDb(upTo) {
  const d = new PGlite();
  await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles().filter(f => !upTo || f < upTo)) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  return d;
}
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }

const IP = n => ({ 'cf-connecting-ip': '203.0.113.' + n });    // TEST-NET-3 addresses only (the edge-set header)
const IP6 = s => ({ 'cf-connecting-ip': s });
const OK_SIG = { hp: '', elapsedMs: 4000 };
let phoneSeq = 0;
const reqPayload = o => Object.assign({
  fullName: 'زائر تجريبي', company: 'شركة زائر تجريبية', phone: '0557' + String(100000 + (phoneSeq++)).slice(-6),
  email: 'visitor@example.com', clientType: 'business', crNumber: '7000000011', direction: 'import', service: 'clearance',
  mode: 'sea', country: 'الصين', port: 'ميناء جدة الإسلامي', goods: 'بضاعة اختبار', containerType: '40ft',
  containerNumbers: 'TSTU0000031', count: 1, blNumber: 'TESTBL0031', terms: true, antispam: OK_SIG }, o || {});
const msgPayload = o => Object.assign({
  name: 'زائر تجريبي', phone: '0126' + String(100000 + (phoneSeq++)).slice(-6), email: 'v@example.com', subject: 'quote',
  message: 'رسالة اختبار طويلة بما يكفي للتحقق', consent: true, antispam: OK_SIG }, o || {});
const submitReq = (who, p, headers) => as(who, `SELECT public.submit_service_request($1) r`, [p], headers).then(r => r[0].r);
const submitMsg = (who, p, headers) => as(who, `SELECT public.submit_contact_message($1) r`, [p], headers).then(r => r[0].r);
const hitsOf = async (action, windowSecs) => (await one(`SELECT coalesce(sum(hits), 0)::int n FROM app.rate_hits WHERE action = $1 AND window_secs = $2
                                                            AND window_start > now() - make_interval(secs => $2)`, [action, windowSecs])).n;
// also moves the submissions made so far out of the org-wide 120 / 10 min guard (this suite sends many)
const resetHits = () => db.exec(`DELETE FROM app.rate_hits;
  UPDATE public.service_requests SET created_at = created_at - interval '11 minutes' WHERE created_at > now() - interval '11 minutes';
  UPDATE public.contact_messages SET created_at = created_at - interval '11 minutes' WHERE created_at > now() - interval '11 minutes';`);
// move every current window of an action back by n windows (simulated time passing)
const age = (action, windows) => db.query(`UPDATE app.rate_hits SET window_start = window_start - make_interval(secs => window_secs * $2)
                                            WHERE action = $1`, [action, windows]);
const salt = async () => (await one(`SELECT salt FROM app.antispam_settings`)).salt;
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c,
                              p.provolatile v
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const tables = (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname IN ('app','public') AND c.relkind = 'r' ORDER BY 1`)).map(x => x.t);
  return { fns, tables };
}

const NEW_FNS = ['app.antispam_client_ip(OUT ip text, OUT net48 text, OUT src text)',
  'app.antispam_gate(p_action text, p_signals jsonb, p_org uuid)', 'app.antispam_purge()', 'app.antispam_stats()'];
const NEW_TABLES = ['app.antispam_settings', 'app.rate_hits', 'app.rate_limits'];
const RECREATED = ['app.client_errors_purge(p_days integer)', 'public.log_client_error(p_payload jsonb)',
  'public.public_track(p_ref text, p_token text)', 'public.submit_contact_message(payload jsonb)',
  'public.submit_service_request(payload jsonb)'];

/* ================================================================== sections */
async function secFile() {
  section('1. file: conventions, all_migrations.sql');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261112000100, schema_versions row, search_path = \'\' on every function', () => {
    const fnHeads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = fnHeads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261112000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261113000100', 'public_antispam'\)/.test(src)
      && fnHeads.length === 9 && bad.length === 0) || J({ n: fnHeads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('the gate has one refusal only: MRS_RATE_LIMITED try_later (no check-specific detail word)', () => {
    const i = src.indexOf('CREATE OR REPLACE FUNCTION app.antispam_gate'), j = src.indexOf('END $$;', i);
    const fails = src.slice(i, j).match(/app\.fail\('[A-Z_]+'[^)]*\)/g) || [];
    const lim = fails.filter(f => /MRS_RATE_LIMITED/.test(f));
    return (lim.length === 2 && lim.every(f => f === "app.fail('MRS_RATE_LIMITED', 'try_later')")
      && fails.length === 3 && fails.includes("app.fail('MRS_INVALID', 'action')")) || J(fails);
  });
  // later phases may follow this file (20261114000100 ai_documents, 20261115000100 convert_in_place, 20261116000100 doc_match, 20261117000100 legacy_core, 20261118000100 legacy_tx, 20261119000100 legacy_docs); none may sort before it unnoticed
  await check('this file is present; only the listed later phases follow it', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => ['20261114000100_ai_documents.sql', '20261115000100_convert_in_place.sql', '20261116000100_doc_match.sql',
      '20261117000100_legacy_core.sql', '20261118000100_legacy_tx.sql', '20261119000100_legacy_docs.sql', '20261120000100_legacy_decl.sql', '20261121000100_legacy_appt.sql', '20261122000100_legacy_pay.sql', '20261123000100_legacy_daftra.sql', '20261124000100_legacy_reports.sql', '20261125000100_legacy_import.sql', '20261126000100_doc_match_packing.sql', '20261127000100_tx_draft_approval.sql'].includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim (appended like the earlier phases; later phases follow it) + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    return (i > 0 && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 4000).includes(MIG)) || 'not appended verbatim / no header line';
  });
}

async function secPreflight() {
  section('2. preflight, re-run, catalog delta (separate database, no seed)');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const d = await freshDb(MIG);
  try {
    await withDb(d, async () => {
      const C0 = await catalog();
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261112000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without deploy_env: exact preflight message, nothing created', async () =>
        (msg.startsWith('ANTISPAM preflight: apply deploy_env first (schema_versions lacks 20261112000100 deploy_env)')
          && (await one(`SELECT to_regclass('app.rate_hits') IS NULL x`)).x) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261112000100', 'deploy_env')`);
      await db.exec(src);
      const C1 = await catalog();
      const s0 = new Map(C0.fns.map(f => [f.sig, f])), s1 = new Map(C1.fns.map(f => [f.sig, f]));
      await check('catalog: exactly the 4 new app helpers (gate takes the target org), no new or dropped public function (signatures unchanged)', () => {
        const added = C1.fns.map(f => f.sig).filter(s => !s0.has(s)), dropped = C0.fns.map(f => f.sig).filter(s => !s1.has(s));
        return (J(added.sort()) === J(NEW_FNS) && dropped.length === 0) || J({ added, dropped });
      });
      await check('catalog: exactly the 3 new app tables (no public table)', () => {
        const added = C1.tables.filter(t => !C0.tables.includes(t));
        return J(added) === J(NEW_TABLES) || J(added);
      });
      await check('catalog: exactly the 5 re-created bodies changed (incl. log_client_error); ACL, definer and config identical; public_track STABLE → VOLATILE', () => {
        const changed = C1.fns.filter(f => s0.has(f.sig) && s0.get(f.sig).h !== f.h).map(f => f.sig).sort();
        const same = RECREATED.every(sig => s0.get(sig).acl === s1.get(sig).acl && s0.get(sig).d === s1.get(sig).d && s0.get(sig).c === s1.get(sig).c);
        const vol = s0.get('public.public_track(p_ref text, p_token text)').v === 's' && s1.get('public.public_track(p_ref text, p_token text)').v === 'v';
        const others = RECREATED.filter(s => !/public_track/.test(s)).every(sig => s0.get(sig).v === s1.get(sig).v);
        return (J(changed) === J(RECREATED) && same && vol && others) || J({ changed, same, vol, others });
      });
      // tune + count, then re-run: nothing reset
      await db.exec(`UPDATE app.rate_limits SET max_hits = 7 WHERE action = 'request' AND bucket = 'ip' AND window_secs = 600;
                     UPDATE app.antispam_settings SET min_fill_ms = 3000;`);
      const before = await one(`SELECT salt FROM app.antispam_settings`);
      await db.query(`SELECT set_config('request.headers', $1, false)`, [J(IP(1))]);
      await db.exec(`SELECT app.antispam_gate('track', NULL)`);                                           // as the owner
      await db.exec(`SELECT set_config('request.headers', '', false)`);
      const h0 = (await one(`SELECT count(*)::int n FROM app.rate_hits`)).n;
      await db.exec(src);
      const after = await one(`SELECT s.salt, s.min_fill_ms, (SELECT max_hits FROM app.rate_limits WHERE action = 'request' AND bucket = 'ip' AND window_secs = 600) m,
                                      (SELECT count(*)::int FROM app.rate_hits) h, (SELECT count(*)::int FROM app.rate_limits) n,
                                      (SELECT count(*)::int FROM public.schema_versions WHERE version = '20261113000100') v
                                 FROM app.antispam_settings s`);
      await check('re-run: salt, tuned limit, min_fill_ms and counters kept; 20 limit rows; one schema_versions row', () =>
        (h0 === 1 && after.salt === before.salt && after.min_fill_ms === 3000 && after.m === 7 && after.h === 1 && after.n === 20 && after.v === 1) || J({ h0, after }));
      await check('re-run: catalog identical to the first run', async () => J(await catalog()) === J(C1) || 'catalog changed');
    });
  } finally { await d.close(); }
}

async function secGrants() {
  section('3. grants: the limiter is not reachable through the API');
  for (const t of NEW_TABLES) for (const who of ['anon', 'stranger']) {
    await check(`${who} cannot SELECT / INSERT / UPDATE / DELETE ${t}`, async () => {
      const r = [];
      for (const sql of [`SELECT 1 FROM ${t} LIMIT 1`, `DELETE FROM ${t}`, `UPDATE ${t} SET ${t === 'app.antispam_settings' ? 'min_fill_ms = 0' : 'window_secs = 600'}`,
        t === 'app.rate_hits' ? `INSERT INTO app.rate_hits (action, ip_key, bucket, window_secs, window_start, hits) VALUES ('request', '${'0'.repeat(64)}', 'ip', 600, now(), 0)`
          : t === 'app.rate_limits' ? `INSERT INTO app.rate_limits (action, bucket, window_secs, max_hits) VALUES ('track', 'ip', 60, 1)` : `INSERT INTO app.antispam_settings (id) VALUES (true)`])
        r.push(await tryErr(() => as(who, sql, [], IP(9))));
      return r.every(x => /permission denied/.test(x)) || J(r);
    });
  }
  await check('no API role (anon / authenticated / service_role) has a privilege on the 3 tables; RLS on', async () => {
    const r = await q(`SELECT c.relname, c.relrowsecurity rls,
                              has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') a,
                              has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') u,
                              has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') s
                         FROM pg_class c WHERE c.oid = ANY (ARRAY['app.antispam_settings'::regclass, 'app.rate_limits'::regclass, 'app.rate_hits'::regclass])`);
    return (r.length === 3 && r.every(x => x.rls && !x.a && !x.u && !x.s)) || J(r);
  });
  await check('no API role can execute app.antispam_* (incl. service_role); app.client_errors_purge still not anon / authenticated', async () => {
    const r = await q(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') s
                         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND (p.proname LIKE 'antispam\\_%' OR p.proname = 'client_errors_purge')`);
    const bad = r.filter(x => x.a || x.u || (x.s && x.proname !== 'client_errors_purge'));
    return (r.length === 5 && bad.length === 0) || J(r);
  });
  await check('anon can execute exactly the 6 public RPCs (unchanged)', async () => {
    const r = await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE') ORDER BY 1`);
    return r.map(x => x.proname).join(',') === 'health_check,invitation_preview,log_client_error,public_track,submit_contact_message,submit_service_request' || J(r);
  });
  await check('one function per public name (no overload added): submit_* (jsonb), public_track (text, text)', async () => {
    const r = await q(`SELECT p.proname, count(*)::int n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                        AND p.proname IN ('submit_service_request','submit_contact_message','public_track') GROUP BY 1 ORDER BY 1`);
    return (r.length === 3 && r.every(x => x.n === 1) && (await one(`SELECT to_regprocedure('public.submit_service_request(jsonb)') IS NOT NULL a,
            to_regprocedure('public.submit_contact_message(jsonb)') IS NOT NULL b, to_regprocedure('public.public_track(text,text)') IS NOT NULL c`)).c) || J(r);
  });
  await expectRefusedDirectCall();
}
async function expectRefusedDirectCall() {
  await check('anon cannot call app.antispam_gate / antispam_stats directly (schema app not reachable)', async () => {
    const a = await tryErr(() => as('anon', `SELECT app.antispam_gate('request', NULL)`, [], IP(9)));
    const b = await tryErr(() => as('anon', `SELECT app.antispam_stats()`, [], IP(9)));
    return (/permission denied/.test(a) && /permission denied/.test(b)) || J({ a, b });
  });
}

async function secLimits() {
  section('4. per-IP limits: request / contact, independent IPs and actions, sliding window, daily cap');
  await resetHits();
  await check('request: 5 per IP per 10 minutes, the 6th → MRS_RATE_LIMITED try_later', async () => {
    for (let i = 0; i < 5; i++) await submitReq('anon', reqPayload(), IP(10));
    return (await refusal(() => submitReq('anon', reqPayload(), IP(10)))) === 'refused' || 'not refused';
  });
  await check('a refusal commits no counter (still 5 / 5 in both windows)', async () =>
    ((await hitsOf('request', 600)) === 5 && (await hitsOf('request', 86400)) === 5) || J([await hitsOf('request', 600), await hitsOf('request', 86400)]));
  await check('another IP is independent (accepted)', async () => !!(await submitReq('anon', reqPayload(), IP(11))).ref);
  await check('another action is independent: the same IP can still send a contact message', async () => !!(await submitMsg('anon', msgPayload(), IP(10))).ref);
  await check('an invalid submission is not counted (the error rolls the counter back)', async () => {
    const before = await hitsOf('request', 600);
    const e = await tryErr(() => submitReq('anon', reqPayload({ goods: 'ab' }), IP(12)));
    return (/MRS_INVALID/.test(e) && (await hitsOf('request', 600)) === before) || J({ e, before });
  });
  await age('request', 1);                     // the hits now sit in the previous 10-minute window
  const prevKey = sha((await salt()) + '|203.0.113.10');
  const setPrev = n => db.query(`UPDATE app.rate_hits SET hits = $2 WHERE action = 'request' AND ip_key = $1 AND window_secs = 600`, [prevKey, n]);
  await check('sliding window: a heavy previous window still blocks after the window turned (weighted, not reset)', async () => {
    const frac = +(await one(`SELECT (extract(epoch FROM clock_timestamp()) % 600) / 600 f`)).f;
    if (frac > 0.99) await new Promise(r => setTimeout(r, 7000));       // the last seconds of a window: wait for the next one
    await setPrev(1000);
    return (await refusal(() => submitReq('anon', reqPayload(), IP(10)))) === 'refused' || 'accepted';
  });
  await check('sliding window: a previous window under the limit lets the IP in', async () => {
    await setPrev(4);
    await db.exec(`DELETE FROM app.rate_hits WHERE action = 'request' AND window_secs = 600 AND window_start > now() - interval '10 minutes'`);
    return !!(await submitReq('anon', reqPayload(), IP(10))).ref;
  });
  await check('sliding window: two windows later the IP may submit again', async () => {
    await db.exec(`DELETE FROM app.rate_hits WHERE action = 'request' AND window_secs = 600 AND window_start > now() - interval '10 minutes'`);
    await setPrev(1000);
    await age('request', 1);
    return !!(await submitReq('anon', reqPayload(), IP(10))).ref;
  });
  await check('daily cap: 20 per IP per day (the 10-minute windows aged out)', async () => {
    await resetHits();
    for (let b = 0; b < 4; b++) {
      for (let i = 0; i < 5; i++) await submitReq('anon', reqPayload(), IP(13));
      await db.exec(`DELETE FROM app.rate_hits WHERE window_secs = 600`);     // the 10-minute windows aged out
    }
    const day = await hitsOf('request', 86400);
    // keep the daily window as it is; the 10-minute window is empty again
    const r = await refusal(() => submitReq('anon', reqPayload(), IP(13)));
    return (day === 20 && r === 'refused') || J({ day, r });
  });
  await check('contact: 5 per IP per 10 minutes, the 6th refused with the same error', async () => {
    await resetHits();
    for (let i = 0; i < 5; i++) await submitMsg('anon', msgPayload(), IP(20));
    return (await refusal(() => submitMsg('anon', msgPayload(), IP(20)))) === 'refused' || 'not refused';
  });
  await check('tuning: raising max_hits takes effect at once (6th accepted at max_hits 6)', async () => {
    await db.exec(`UPDATE app.rate_limits SET max_hits = 6 WHERE action = 'contact' AND bucket = 'ip' AND window_secs = 600`);
    try { return !!(await submitMsg('anon', msgPayload(), IP(20))).ref; }
    finally { await db.exec(`UPDATE app.rate_limits SET max_hits = 5 WHERE action = 'contact' AND bucket = 'ip' AND window_secs = 600`); }
  });
  await check('max_hits 0 closes an action for a bucket', async () => {
    await db.exec(`UPDATE app.rate_limits SET max_hits = 0 WHERE action = 'contact' AND bucket = 'ip' AND window_secs = 600`);
    try { return (await refusal(() => submitMsg('anon', msgPayload(), IP(21)))) === 'refused'; }
    finally { await db.exec(`UPDATE app.rate_limits SET max_hits = 5 WHERE action = 'contact' AND bucket = 'ip' AND window_secs = 600`); }
  });
  await check('the old per-phone guard still answers with its own detail (phone), unchanged', async () => {
    await resetHits();
    const p = '0557999001';
    for (let i = 0; i < 5; i++) await submitReq('anon', reqPayload({ phone: p }), IP(30 + i));
    const e = await tryErr(() => submitReq('anon', reqPayload({ phone: p }), IP(40)));
    return /MRS_RATE_LIMITED phone/.test(e) || e;
  });
}

async function secIp() {
  section('5. client IP: trusted header only, opt-in headers, src, unknown bucket, IPv6 /64 + /48');
  // the owner reads it (anon cannot run the helper): set the headers in the owner session
  const addr = async h => {
    await db.query(`SELECT set_config('request.headers', $1, false)`, [h == null ? '' : J(h)]);
    try { const r = await one(`SELECT a.ip, a.net48, a.src FROM app.antispam_client_ip() a`); return r; }
    finally { await db.exec(`SELECT set_config('request.headers', '', false)`); }
  };
  const ipOf = async h => (await addr(h)).ip;
  const setHeaders = (hdrs, hops) => db.query(`UPDATE app.antispam_settings SET ip_headers = $1, xff_trusted_hops = $2`, [hdrs, hops || 0]);
  const DEFAULT_HDRS = ['cf-connecting-ip'];
  await check('default settings: ip_headers = {cf-connecting-ip}, xff_trusted_hops 0, signed_in_ip_factor 4', async () => {
    const s = await one(`SELECT ip_headers, xff_trusted_hops, signed_in_ip_factor FROM app.antispam_settings`);
    return (J(s.ip_headers) === J(DEFAULT_HDRS) && s.xff_trusted_hops === 0 && s.signed_in_ip_factor === 4) || J(s);
  });
  await check('default: cf-connecting-ip is used (src cf); forged x-real-ip / X-Forwarded-For beside it are ignored', async () => {
    const r = await addr({ 'cf-connecting-ip': '198.51.100.7', 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' });
    return (r.ip === '198.51.100.7' && r.src === 'cf' && r.net48 === null) || J(r);
  });
  await check('default: x-real-ip / X-Forwarded-For alone are NOT trusted (client-forgeable / shared edge address) → none', async () => {
    const a = await addr({ 'x-real-ip': '198.51.100.8' }), b = await addr({ 'x-forwarded-for': '1.1.1.1, 198.51.100.9' });
    return (a.ip === null && a.src === 'none' && b.ip === null && b.src === 'none') || J({ a, b });
  });
  await check('opt-in order: {cf, x-real-ip}: a malformed cf value falls through to x-real-ip (src xri), not to unknown', async () => {
    await setHeaders(['cf-connecting-ip', 'x-real-ip']);
    try {
      const a = await addr({ 'cf-connecting-ip': 'garbage', 'x-real-ip': '198.51.100.11' });
      const b = await addr({ 'cf-connecting-ip': '198.51.100.12', 'x-real-ip': '198.51.100.11' });
      return (a.ip === '198.51.100.11' && a.src === 'xri' && b.ip === '198.51.100.12' && b.src === 'cf') || J({ a, b });
    } finally { await setHeaders(DEFAULT_HDRS); }
  });
  await check('opt-in X-Forwarded-For: xff_trusted_hops 0 → right-most hop; 1 → the hop left of one trusted proxy; too many → none', async () => {
    const h = { 'x-forwarded-for': '1.1.1.1, 198.51.100.21 ,198.51.100.22' };
    await setHeaders(['x-forwarded-for'], 0); const a = await addr(h);
    await setHeaders(['x-forwarded-for'], 1); const b = await addr(h);
    await setHeaders(['x-forwarded-for'], 3); const c = await addr(h);
    await setHeaders(DEFAULT_HDRS);
    return (a.ip === '198.51.100.22' && a.src === 'xff' && b.ip === '198.51.100.21' && c.ip === null && c.src === 'none') || J({ a, b, c });
  });
  await check('ip_headers is constrained (unknown header name / empty list refused by CHECK)', async () => {
    const a = await tryErr(() => db.exec(`UPDATE app.antispam_settings SET ip_headers = '{x-client-ip}'`));
    const b = await tryErr(() => db.exec(`UPDATE app.antispam_settings SET ip_headers = '{}'`));
    return (/check constraint/i.test(a) && /check constraint/i.test(b)) || J({ a, b });
  });
  await check('IPv6: ip = /64, net48 = /48; IPv4-mapped IPv6 → the IPv4 address (no /48)', async () => {
    const a = await addr(IP6('2001:db8:1:2::1')), b = await addr(IP6('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    const c = await addr(IP6('2001:db8:1:3::1')), m = await addr(IP6('::ffff:198.51.100.20'));
    return (a.ip === '2001:db8:1:2::/64' && a.net48 === '2001:db8:1::/48' && a.ip === b.ip && c.ip !== a.ip && c.net48 === a.net48
      && m.ip === '198.51.100.20' && m.net48 === null) || J({ a, b, c, m });
  });
  await check('no headers / no address / garbage → NULL ip, src none (the unknown bucket)', async () => {
    const r = [await addr(null), await addr({ 'user-agent': 'x' }), await addr({ 'cf-connecting-ip': 'not-an-ip' }),
      await addr({ 'cf-connecting-ip': "1.2.3.4'; DROP TABLE x" }), await addr({ 'cf-connecting-ip': '999.1.1.1' }), await addr({ 'cf-connecting-ip': '10.0.0.0/8' })];
    return r.every(x => x.ip === null && x.net48 === null && x.src === 'none') || J(r);
  });
  await check('request.headers that is not JSON → NULL, no error', async () => {
    await db.exec(`SELECT set_config('request.headers', 'not json', false)`);
    try { const r = await one(`SELECT a.ip, a.src FROM app.antispam_client_ip() a`); return (r.ip === null && r.src === 'none') || J(r); }
    finally { await db.exec(`SELECT set_config('request.headers', '', false)`); }
  });
  await resetHits();
  await check('unknown bucket = ONE key for the whole site: 15 per 10 minutes shared by every visitor without a usable IP', async () => {
    for (let i = 0; i < 15; i++) await submitReq('anon', reqPayload(), i % 2 ? { 'user-agent': 'bot' } : { 'x-real-ip': '198.51.100.' + i });
    const r = await refusal(() => submitReq('anon', reqPayload(), { 'cf-connecting-ip': 'garbage' }));
    const b = await q(`SELECT bucket, hits, src FROM app.rate_hits WHERE action = 'request' AND window_secs = 600`);
    return (r === 'refused' && b.length === 1 && b[0].bucket === 'unknown' && b[0].hits === 15 && b[0].src === 'none') || J({ r, b });
  });
  await check('the unknown bucket does not touch real IPs (an IP visitor still accepted)', async () => !!(await submitReq('anon', reqPayload(), IP(50))).ref);
  await check('spoof check (doc §3): forged X-Forwarded-For / X-Real-IP rotate, cf-connecting-ip fixed → one bucket (src cf), 6th refused', async () => {
    await resetHits();
    for (let i = 0; i < 5; i++) await submitReq('anon', reqPayload(), { 'cf-connecting-ip': '198.51.100.60', 'x-forwarded-for': `1.2.3.${i}`, 'x-real-ip': `5.6.7.${i}` });
    const r = await refusal(() => submitReq('anon', reqPayload(), { 'cf-connecting-ip': '198.51.100.60', 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' }));
    const rows = await q(`SELECT DISTINCT ip_key, src FROM app.rate_hits WHERE action = 'request'`);
    return (r === 'refused' && rows.length === 1 && rows[0].src === 'cf' && rows[0].ip_key === sha((await salt()) + '|198.51.100.60')) || J({ r, rows });
  });
  await check('rotating addresses inside one IPv6 /64 does not open new buckets', async () => {
    await resetHits();
    for (let i = 0; i < 5; i++) await submitReq('anon', reqPayload(), IP6(`2001:db8:aa:bb::${i + 1}`));
    return (await refusal(() => submitReq('anon', reqPayload(), IP6('2001:db8:aa:bb:1:2:3:4')))) === 'refused';
  });
  await check('IPv6 /48 bucket: rotating /64s inside one /48 → 15 per 10 minutes, then refused; another /48 and IPv4 unaffected', async () => {
    await resetHits();
    let n = 0;
    for (let i = 0; i < 20; i++) {
      const r = await refusal(() => submitReq('anon', reqPayload(), IP6(`2001:db8:cc:${(i + 1).toString(16)}::1`)));
      if (r !== 'accepted') break;
      n++;
    }
    const other = await refusal(() => submitReq('anon', reqPayload(), IP6('2001:db8:cd:1::1')));
    const v4 = await refusal(() => submitReq('anon', reqPayload(), IP(51)));
    const b48 = (await one(`SELECT count(*)::int n FROM app.rate_hits WHERE bucket = 'ip48' AND window_secs = 600`)).n;
    return (n === 15 && other === 'accepted' && v4 === 'accepted' && b48 === 2) || J({ n, other, v4, b48 });
  });
}

async function secUsers() {
  section('5b. signed-in users: non-member limited (user bucket + IP × factor), member / client of the org exempt');
  await resetHits();
  await check('the IP budget of a signed-in non-member is × 4: after 5 visitor requests the IP is closed for visitors, open for the account', async () => {
    for (let i = 0; i < 5; i++) await submitReq('anon', reqPayload(), IP(120));
    const vis = await refusal(() => submitReq('anon', reqPayload(), IP(120)));
    const usr = await refusal(() => submitReq('stranger', reqPayload(), IP(120)));
    return (vis === 'refused' && usr === 'accepted') || J({ vis, usr });
  });
  await check('signed-in non-member from ONE IP: stopped at 20 per 10 minutes (5 × 4, shared with the visitors of that IP)', async () => {
    await resetHits();
    let n = 0;
    for (let i = 0; i < 25; i++) { if ((await refusal(() => submitReq('stranger', reqPayload(), IP(121)))) !== 'accepted') break; n++; }
    return n === 20 || 'accepted ' + n;
  });
  await check('signed-in non-member rotating IPs (and phones): the user bucket stops the account at 20 per 10 minutes', async () => {
    await resetHits();
    let n = 0, last = '';
    for (let i = 0; i < 25; i++) {
      last = await refusal(() => submitReq('stranger', reqPayload(), IP(130 + i)));
      if (last !== 'accepted') break;
      n++;
    }
    const u = await one(`SELECT count(*)::int n, max(hits)::int h FROM app.rate_hits WHERE bucket = 'user' AND action = 'request' AND window_secs = 600`);
    return (n === 20 && last === 'refused' && u.n === 1 && u.h === 20) || J({ n, last, u });
  });
  await check('user bucket: daily 100; key = sha256(salt | u:<uid>) (no uid in clear)', async () => {
    const k = sha((await salt()) + '|u:' + U.stranger);
    const r = await q(`SELECT window_secs, row_to_json(h)::text t FROM app.rate_hits h WHERE bucket = 'user' AND ip_key = $1 ORDER BY 1`, [k]);
    const lim = await one(`SELECT max_hits FROM app.rate_limits WHERE action = 'request' AND bucket = 'user' AND window_secs = 86400`);
    return (r.length === 2 && r.every(x => !x.t.includes(U.stranger)) && lim.max_hits === 100) || J(r);
  });
  await check('signed-in non-member without a usable IP: unknown bucket × 4 + user bucket', async () => {
    await resetHits();
    await submitReq('stranger', reqPayload(), { 'user-agent': 'x' });
    const r = await q(`SELECT bucket FROM app.rate_hits WHERE action = 'request' AND window_secs = 600 ORDER BY 1`);
    return J(r.map(x => x.bucket)) === J(['unknown', 'user']) || J(r);
  });
  await check('signed-in non-member is limited on contact and tracking too (user bucket rows)', async () => {
    await resetHits();
    await submitMsg('stranger', msgPayload(), IP(160));
    await as('stranger', `SELECT public.public_track('MRS-2026-000001', $1)`, [SEED_TOKEN], IP(160));
    const r = await q(`SELECT action, bucket FROM app.rate_hits WHERE window_secs = 600 ORDER BY 1, 2`);
    return J(r.map(x => x.action + ':' + x.bucket)) === J(['contact:ip', 'contact:user', 'track:ip', 'track:user']) || J(r);
  });
  await check('member of the target org (staff): not limited, no counter (25 requests from one IP)', async () => {
    await resetHits();
    for (let i = 0; i < 25; i++) await submitReq('staff', reqPayload(), IP(170));
    return (await one(`SELECT count(*)::int n FROM app.rate_hits`)).n === 0;
  });
  await check('client user of the target org (portal): not limited, no counter; still refused on a filled decoy', async () => {
    await resetHits();
    for (let i = 0; i < 25; i++) await submitReq('portal', reqPayload(), IP(171));
    const bad = await refusal(() => submitReq('portal', reqPayload({ antispam: { hp: 'x', elapsedMs: 9000 } }), IP(171)));
    return (bad === 'refused' && (await one(`SELECT count(*)::int n FROM app.rate_hits`)).n === 0) || bad;
  });
  await check('membership is per org: the staff member of A is limited like a stranger when sending to another org', async () => {
    await resetHits();
    await db.exec(`INSERT INTO public.organizations (id, slug, name_ar, name_en, public_intake_enabled)
                   VALUES ('0b5e0000-0000-4000-8000-0000000000b2', 'antispam-other', 'منشأة أخرى', 'Other org', true) ON CONFLICT DO NOTHING`);
    await submitReq('staff', reqPayload({ orgSlug: 'antispam-other' }), IP(172));
    const r = await q(`SELECT bucket FROM app.rate_hits WHERE action = 'request' AND window_secs = 600 ORDER BY 1`);
    return J(r.map(x => x.bucket)) === J(['ip', 'user']) || J(r);
  });
  await check('an inactive membership no longer exempts', async () => {
    await resetHits();
    await db.exec(`UPDATE public.memberships SET is_active = false WHERE user_id = '${U.staff}'`);
    try {
      await submitReq('staff', reqPayload(), IP(173));
      return (await one(`SELECT count(*)::int n FROM app.rate_hits WHERE bucket = 'user'`)).n === 2;
    } finally { await db.exec(`UPDATE public.memberships SET is_active = true WHERE user_id = '${U.staff}'`); }
  });
  await check('signed_in_ip_factor is tunable (1: a signed-in non-member gets the visitor IP budget)', async () => {
    await resetHits();
    await db.exec(`UPDATE app.antispam_settings SET signed_in_ip_factor = 1`);
    try {
      for (let i = 0; i < 5; i++) await submitReq('stranger', reqPayload(), IP(174));
      return (await refusal(() => submitReq('stranger', reqPayload(), IP(174)))) === 'refused';
    } finally { await db.exec(`UPDATE app.antispam_settings SET signed_in_ip_factor = 4`); }
  });
}

async function secHash() {
  section('6. hashing: salted sha256, no raw IP stored, nothing secret in the stats');
  await resetHits();
  await submitReq('anon', reqPayload(), IP(70));
  await submitReq('anon', reqPayload(), { 'user-agent': 'x' });
  const s = await salt();
  await check('per-install salt: 64 hex, not the hash of a constant', () => /^[0-9a-f]{64}$/.test(s) && s !== sha('') || s);
  await check('ip_key = sha256(salt | IP) and sha256(salt | unknown); no raw IP in any row', async () => {
    const r = await q(`SELECT ip_key, bucket, row_to_json(h)::text t FROM app.rate_hits h WHERE action = 'request'`);
    const keys = new Set(r.map(x => x.ip_key));
    return (keys.has(sha(s + '|203.0.113.70')) && keys.has(sha(s + '|unknown')) && !keys.has(sha('203.0.113.70'))
      && r.every(x => !x.t.includes('203.0.113')) && keys.size === 2) || J(r.map(x => x.t));
  });
  await check('no column anywhere in app / public holds the raw IP (whole-database text scan of the new tables + client_errors)', async () => {
    const r = await one(`SELECT (SELECT count(*) FROM app.rate_hits h WHERE row_to_json(h)::text LIKE '%203.0.113%')
                              + (SELECT count(*) FROM app.antispam_settings s WHERE row_to_json(s)::text LIKE '%203.0.113%')
                              + (SELECT count(*) FROM public.client_errors e WHERE row_to_json(e)::text LIKE '%203.0.113%') n`);
    return +r.n === 0 || J(r);
  });
  await check('a new salt re-buckets every IP (old keys no longer match)', async () => {
    const before = (await one(`SELECT count(*)::int n FROM app.rate_hits WHERE ip_key = $1`, [sha(s + '|203.0.113.70')])).n;
    await db.exec(`UPDATE app.antispam_settings SET salt = app.new_token()`);
    await submitReq('anon', reqPayload(), IP(70));
    const s2 = await salt();
    const after = (await one(`SELECT count(*)::int n FROM app.rate_hits WHERE ip_key = $1`, [sha(s2 + '|203.0.113.70')])).n;
    return (before === 2 && after === 2 && s2 !== s) || J({ before, after });
  });
  await check('app.antispam_stats(): counts per action / bucket, settings, limits — never the salt, a key or an IP', async () => {
    const st = (await one(`SELECT app.antispam_stats() s`)).s;
    const t = J(st), s2 = await salt();
    const keys = (await q(`SELECT ip_key FROM app.rate_hits`)).map(x => x.ip_key);
    const req = st.buckets.find(b => b.action === 'request' && b.bucket === 'ip');
    const srcCf = st.sources.find(x => x.action === 'request' && x.src === 'cf'), srcNone = st.sources.find(x => x.action === 'request' && x.src === 'none');
    return (J(Object.keys(st).sort()) === J(['buckets', 'limits', 'refusals_reported', 'settings', 'since', 'sources', 'warnings']) && !t.includes(s2)
      && keys.every(k => !t.includes(k)) && !t.includes('203.0.113') && st.limits.length === 20 && req && req.ips === 2 && req.actions === 2
      && srcCf && srcCf.actions === 2 && srcNone && srcNone.actions === 1
      && st.settings.min_fill_ms === 2500 && st.settings.require_form_signals === false && J(st.settings.ip_headers) === '["cf-connecting-ip"]'
      && st.settings.signed_in_ip_factor === 4 && st.settings.xff_trusted_hops === 0) || t;
  });
  await check('antispam_stats warnings: unknown_share_high when > 10% of >= 20 actions had no address; spoofable_ip_header when opted in', async () => {
    await resetHits();
    const w0 = (await one(`SELECT app.antispam_stats() s`)).s.warnings;
    for (let i = 0; i < 17; i++) await submitMsg('anon', msgPayload(), IP(180 + i));
    for (let i = 0; i < 3; i++) await submitMsg('anon', msgPayload(), { 'user-agent': 'x' });
    const w1 = (await one(`SELECT app.antispam_stats() s`)).s.warnings;
    await db.exec(`UPDATE app.antispam_settings SET ip_headers = '{cf-connecting-ip,x-real-ip}'`);
    const w2 = (await one(`SELECT app.antispam_stats() s`)).s.warnings;
    await db.exec(`UPDATE app.antispam_settings SET ip_headers = '{cf-connecting-ip}'`);
    await resetHits();
    for (let i = 0; i < 19; i++) await submitMsg('anon', msgPayload(), IP(200 + i));
    await submitMsg('anon', msgPayload(), {});
    const w3 = (await one(`SELECT app.antispam_stats() s`)).s.warnings;           // 1 of 20 = 5%: no warning
    return (J(w0) === '[]' && J(w1) === '["unknown_share_high:contact"]' && J(w2) === '["spoofable_ip_header","unknown_share_high:contact"]'
      && J(w3) === '[]') || J({ w0, w1, w2, w3 });
  });
}

async function secSignals() {
  section('7. form signals: decoy + fill time, one generic refusal');
  await resetHits();
  const variants = [
    ['decoy field filled', { hp: 'http://spam.example', elapsedMs: 9000 }],
    ['fill time under 2500 ms', { hp: '', elapsedMs: 1200 }],
    ['fill time 2499 ms', { hp: '', elapsedMs: 2499 }],
    ['negative fill time', { hp: '', elapsedMs: -5 }],
    ['fill time as a string', { hp: '', elapsedMs: '9000' }],
    ['decoy as a number', { hp: 7, elapsedMs: 9000 }],
    ['decoy as an object', { hp: { a: 1 }, elapsedMs: 9000 }],
    ['antispam not an object', 'x'],
    ['antispam an array', [1, 2]]
  ];
  for (const [name, sig] of variants) {
    await check('request refused: ' + name, async () => (await refusal(() => submitReq('anon', reqPayload({ antispam: sig }), IP(80)))) === 'refused');
    await check('contact refused: ' + name, async () => (await refusal(() => submitMsg('anon', msgPayload({ antispam: sig }), IP(80)))) === 'refused');
  }
  await check('the decoy / fill-time refusal is byte-identical to the IP-limit refusal (message, detail, hint, code)', async () => {
    const grab = async fn => { try { await fn(); return null; } catch (e) { return J([e.message, e.detail, e.hint || null, e.code]); } };
    const hp = await grab(() => submitReq('anon', reqPayload({ antispam: { hp: 'x', elapsedMs: 9000 } }), IP(81)));
    const fast = await grab(() => submitReq('anon', reqPayload({ antispam: { hp: '', elapsedMs: 10 } }), IP(81)));
    for (let i = 0; i < 5; i++) await submitReq('anon', reqPayload(), IP(82));
    const lim = await grab(() => submitReq('anon', reqPayload(), IP(82)));
    return (hp && hp === fast && fast === lim) || J({ hp, fast, lim });
  });
  await check('refused signals count nothing (the bot IP has no counter row)', async () => {
    const k = sha((await salt()) + '|203.0.113.80');
    return (await one(`SELECT count(*)::int n FROM app.rate_hits WHERE ip_key = $1`, [k])).n === 0;
  });
  await check('accepted: empty / whitespace / null decoy, fill time exactly 2500 ms or more, null elapsedMs', async () => {
    const ok = [{ hp: '', elapsedMs: 2500 }, { hp: '   ', elapsedMs: 60000 }, { hp: null, elapsedMs: 3000.7 }, { elapsedMs: 3000 }, { hp: '' }, {}];
    for (const sig of ok) { await resetHits(); if (!(await submitReq('anon', reqPayload({ antispam: sig }), IP(83))).ref) return J(sig); }
    return true;
  });
  await check('min_fill_ms is tunable (3000: 2800 ms refused; 0 disables the check)', async () => {
    await resetHits();
    await db.exec(`UPDATE app.antispam_settings SET min_fill_ms = 3000`);
    const a = await refusal(() => submitReq('anon', reqPayload({ antispam: { hp: '', elapsedMs: 2800 } }), IP(84)));
    await db.exec(`UPDATE app.antispam_settings SET min_fill_ms = 0`);
    const b = await refusal(() => submitReq('anon', reqPayload({ antispam: { hp: '', elapsedMs: 0 } }), IP(84)));
    await db.exec(`UPDATE app.antispam_settings SET min_fill_ms = 2500`);
    return (a === 'refused' && b === 'accepted') || J({ a, b });
  });
  await check('payload.antispam is stripped: not stored on the request, not in the idempotency hash', async () => {
    await resetHits();
    const key = crypto.randomUUID();
    const p = reqPayload({ idempotencyKey: key, antispam: { hp: '', elapsedMs: 5000 }, notes: 'ملاحظة اختبار' });
    const r1 = await submitReq('anon', p, IP(85));
    // the same submission retried later: a new elapsedMs must still replay (not MRS_IDEMPOTENCY_CONFLICT)
    const r2 = await submitReq('anon', Object.assign({}, p, { antispam: { hp: '', elapsedMs: 99999 } }), IP(85));
    const row = await one(`SELECT row_to_json(r)::text t FROM public.service_requests r WHERE r.ref = $1 AND r.org_id = $2`, [r1.ref, A]);
    return (r2.ref === r1.ref && r2.tracking_token === null && !/antispam|elapsedMs/.test(row.t)) || J({ r1, r2 });
  });
  await check('contact: same idempotency key with other signals replays', async () => {
    const key = crypto.randomUUID();
    const p = msgPayload({ idempotencyKey: key });
    const r1 = await submitMsg('anon', p, IP(86));
    const r2 = await submitMsg('anon', Object.assign({}, p, { antispam: { hp: '', elapsedMs: 777777 } }), IP(86));
    return r1.ref === r2.ref || J({ r1, r2 });
  });
  await check('idempotent replay is never rate limited (IP at its limit, the retry of a committed submission replays)', async () => {
    await resetHits();
    const key = crypto.randomUUID();
    const p = reqPayload({ idempotencyKey: key });
    const r1 = await submitReq('anon', p, IP(87));
    for (let i = 0; i < 4; i++) await submitReq('anon', reqPayload(), IP(87));
    const fresh = await refusal(() => submitReq('anon', reqPayload(), IP(87)));
    const r2 = await submitReq('anon', p, IP(87));
    return (fresh === 'refused' && r2.ref === r1.ref) || J({ fresh, r2 });
  });
}

async function secCompat() {
  section('8. backward compatibility: old clients, direct sessions, signed-in users, require_form_signals');
  await resetHits();
  await check('old client (no payload.antispam) through the API: accepted, IP-limited as usual', async () => {
    const p = reqPayload(); delete p.antispam;
    for (let i = 0; i < 5; i++) { const x = reqPayload(); delete x.antispam; await submitReq('anon', x, IP(90)); }
    return (await refusal(() => submitReq('anon', p, IP(90)))) === 'refused';
  });
  await check('direct session (no request.headers: SQL Editor, cron, older suites): no IP limit, no counter', async () => {
    await resetHits();
    for (let i = 0; i < 8; i++) { const x = reqPayload(); delete x.antispam; await submitReq('direct', x); }
    return (await one(`SELECT count(*)::int n FROM app.rate_hits`)).n === 0;
  });
  await check('signed-in non-member: 7 requests from one IP accepted (IP budget × 4), still refused on a filled decoy', async () => {
    await resetHits();
    for (let i = 0; i < 7; i++) await submitReq('stranger', reqPayload(), IP(91));
    const bad = await refusal(() => submitReq('stranger', reqPayload({ antispam: { hp: 'x', elapsedMs: 9000 } }), IP(91)));
    return (bad === 'refused' && (await hitsOf('request', 600)) === 14) || J({ bad, hits: await hitsOf('request', 600) });
  });
  await check('require_form_signals = true: a visitor API request without signals is refused; with signals accepted', async () => {
    await resetHits();
    await db.exec(`UPDATE app.antispam_settings SET require_form_signals = true`);
    try {
      const p = reqPayload(); delete p.antispam;
      const m = msgPayload(); delete m.antispam;
      const a = await refusal(() => submitReq('anon', p, IP(92)));
      const b = await refusal(() => submitMsg('anon', m, IP(92)));
      const c = await refusal(() => submitReq('anon', reqPayload(), IP(92)));
      const p2 = reqPayload(); delete p2.antispam;
      const d = await refusal(() => submitReq('direct', p2));                       // direct session: never required
      const p3 = reqPayload(); delete p3.antispam;
      const e = await refusal(() => submitReq('stranger', p3, IP(92)));             // signed-in: never required
      const f = await tryErr(() => as('anon', `SELECT public.public_track('MRS-2026-000001', $1)`, [SEED_TOKEN], IP(92)));   // tracking: no form
      return (a === 'refused' && b === 'refused' && c === 'accepted' && d === 'accepted' && e === 'accepted' && !/try_later/.test(f)) || J({ a, b, c, d, e, f });
    } finally { await db.exec(`UPDATE app.antispam_settings SET require_form_signals = false`); }
  });
  await check('settings row removed from the SQL Editor: the gate recreates it (new salt), nothing breaks', async () => {
    await db.exec(`DELETE FROM app.antispam_settings`);
    const r = await submitReq('anon', reqPayload(), IP(93));
    return (!!r.ref && (await one(`SELECT count(*)::int n FROM app.antispam_settings`)).n === 1);
  });
}

async function secTrack() {
  section('9. public_track: 30 lookups per IP per 10 minutes — failed guesses counted (a miss is a value, not an error)');
  await resetHits();
  const ref = (await one(`SELECT ref FROM public.service_requests WHERE tracking_token_hash = app.hash_token($1)`, [SEED_TOKEN])).ref;
  const track = (tok, h, r) => as('anon', `SELECT public.public_track($1, $2) r`, [r || ref, tok], h).then(x => x[0].r);
  await check('30 successful lookups from one IP, the 31st → MRS_RATE_LIMITED try_later', async () => {
    for (let i = 0; i < 30; i++) { const r = await track(SEED_TOKEN, IP(100)); if (r.ref !== ref) return J(r); }
    return (await refusal(() => track(SEED_TOKEN, IP(100)))) === 'refused';
  });
  await check('another IP still tracks', async () => (await track(SEED_TOKEN, IP(101))).ref === ref);
  await check('a miss answers exactly {"not_found": true} for every cause (wrong token, unknown ref, bad format, NULL) — no oracle', async () => {
    const r = [await track('0'.repeat(64), IP(102)), await track(SEED_TOKEN, IP(102), 'REQ-2099-999999'),
      await track('x'.repeat(10000), IP(102), "REQ-2026-000001' OR 1=1 --"), await track(null, IP(102))];
    return r.every(x => J(x) === '{"not_found": true}' || J(x) === '{"not_found":true}') || J(r);
  });
  await check('failed guesses ARE counted now (the miss commits its counter): the 4 misses above = 4 hits', async () =>
    (await one(`SELECT hits FROM app.rate_hits WHERE action = 'track' AND window_secs = 600 AND ip_key = $1`, [sha((await salt()) + '|203.0.113.102')])).hits === 4);
  await check('guessing: 30 wrong tokens from one IP, then even the right token is refused (MRS_RATE_LIMITED)', async () => {
    for (let i = 0; i < 30; i++) {
      const r = await track(crypto.randomBytes(32).toString('hex'), IP(103));
      if (!r.not_found) return J(r);
    }
    return (await refusal(() => track(SEED_TOKEN, IP(103)))) === 'refused';
  });
  await check('suspended org: the same {"not_found": true} (no oracle)', async () => {
    const org = (await one(`SELECT org_id FROM public.service_requests WHERE ref = $1`, [ref])).org_id;
    await db.query(`UPDATE public.organizations SET is_active = false WHERE id = $1`, [org]);
    try { const r = await track(SEED_TOKEN, IP(104)); return J(r) === '{"not_found": true}' || J(r) === '{"not_found":true}' || J(r); }
    finally { await db.query(`UPDATE public.organizations SET is_active = true WHERE id = $1`, [org]); }
  });
  await check('unknown bucket for tracking: 60 per 10 minutes (site-wide)', async () => {
    for (let i = 0; i < 60; i++) await track(SEED_TOKEN, {});
    return (await refusal(() => track(SEED_TOKEN, {}))) === 'refused';
  });
  await check('direct session: unlimited (35 lookups)', async () => {
    for (let i = 0; i < 35; i++) await as('direct', `SELECT public.public_track($1, $2)`, [ref, SEED_TOKEN]);
    return true;
  });
  await check('public_track is VOLATILE, SECURITY DEFINER, search_path pinned; still reports the deployment environment; no MRS_NOT_FOUND raise left', async () => {
    const r = await one(`SELECT p.provolatile v, p.prosecdef d, array_to_string(p.proconfig, ',') c, p.prosrc LIKE '%app.deploy_environment()%' e,
                                p.prosrc s FROM pg_proc p WHERE p.oid = 'public.public_track(text,text)'::regprocedure`);
    // the only MRS_NOT_FOUND raise left is the MFA-pending one (app.fail answers MRS_MFA_REQUIRED there)
    const raises = (r.s.match(/app\.fail\('MRS_NOT_FOUND'\)/g) || []).length;
    const mfa = (r.s.match(/IF app\.mfa_pending\(\) THEN PERFORM app\.fail\('MRS_NOT_FOUND'\); END IF;/g) || []).length;
    return (r.v === 'v' && r.d && /search_path=""|search_path=''/.test(r.c) && r.e && raises === 3 && mfa === 3) || J({ v: r.v, d: r.d, c: r.c, e: r.e, raises, mfa });
  });
}

async function secLogErrors() {
  section('9b. log_client_error: same trusted-header policy (forged x-real-ip / X-Forwarded-For cannot rotate past the cap)');
  const log = (msg, h) => as('anon', `SELECT public.log_client_error($1) r`, [{ message: msg }], h).then(r => r[0].r.logged);
  await db.exec(`DELETE FROM public.client_errors`);
  await check('rotating a forged x-real-ip / X-Forwarded-For (no cf-connecting-ip): one shared visitor key, 20 logged of 30', async () => {
    let ok = 0;
    for (let i = 0; i < 30; i++) if (await log('spoof ' + i, { 'x-real-ip': `198.51.100.${i}`, 'x-forwarded-for': `10.0.${i}.1, 10.1.${i}.1` })) ok++;
    return ok === 20 || 'logged ' + ok;
  });
  await check('cf-connecting-ip: a per-visitor key (another visitor still logged); the IP never stored', async () => {
    let ok = 0;
    for (let i = 0; i < 22; i++) if (await log('cf ' + i, IP(140))) ok++;
    const other = await log('other', IP(141));
    const stored = (await one(`SELECT count(*)::int n FROM public.client_errors e WHERE row_to_json(e)::text LIKE '%203.0.113.14%'`)).n;
    return (ok === 20 && other === true && stored === 0) || J({ ok, other, stored });
  });
  await check('log_client_error key = hash of ip:<address from app.antispam_client_ip()> (IPv6 grouped by /64)', async () => {
    await log('v6 a', IP6('2001:db8:77:1::1'));
    const k = (await one(`SELECT app.hash_token('ip:2001:db8:77:1::/64') k`)).k;
    return (await one(`SELECT count(*)::int n FROM public.client_errors WHERE actor_key = $1`, [k])).n === 1;
  });
  await db.exec(`DELETE FROM public.client_errors`);
}

async function secPurge() {
  section('10. purge (existing daily job marsa_client_errors_purge → app.client_errors_purge)');
  await resetHits();
  await submitReq('anon', reqPayload(), IP(110));
  await db.exec(`INSERT INTO app.rate_hits (action, ip_key, bucket, window_secs, window_start, hits) VALUES
                   ('request', '${'a'.repeat(64)}', 'ip', 600, now() - interval '25 minutes', 3),   -- older than 2 windows → purged
                   ('request', '${'b'.repeat(64)}', 'ip', 600, now() - interval '15 minutes', 3),   -- the previous window → kept
                   ('request', '${'c'.repeat(64)}', 'ip', 86400, now() - interval '3 days', 9),     -- old day → purged
                   ('track',   '${'d'.repeat(64)}', 'ip', 600, now() - interval '2 hours', 1);       -- purged
                 INSERT INTO public.client_errors (actor_key, code, message, created_at) VALUES ('${'e'.repeat(64)}', 'X', 'old', now() - interval '40 days');`);
  const before = (await one(`SELECT count(*)::int n FROM app.rate_hits`)).n;
  const r = (await one(`SELECT app.client_errors_purge(30) n`)).n;
  const left = await q(`SELECT ip_key, window_secs FROM app.rate_hits ORDER BY 1, 2`);
  await check('client_errors_purge(30) still returns the client_errors count only (1)', () => r === 1 || 'got ' + r);
  await check('old windows purged; current + previous windows kept', () =>
    (before === 6 && left.length === 3 && !left.some(x => /^[acd]{64}$/.test(x.ip_key)) && left.some(x => x.ip_key === 'b'.repeat(64))) || J({ before, left }));
  await check('app.antispam_purge() alone: idempotent (0 on a second call)', async () => (await one(`SELECT app.antispam_purge() n`)).n === 0);
  await check('no new cron job: the file schedules nothing; the purge rides on marsa_client_errors_purge', () => {
    const src = fs.readFileSync(MIG_FILE, 'utf8').split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
    return !/cron\.schedule/.test(src) && /SELECT app\.antispam_purge\(\);/.test(src);
  });
}

async function secFrontEnd() {
  section('11. front end: decoy field, render time, signals sent, friendly message (static checks)');
  const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const [page, form] of [['request.html', 'request-form'], ['contact.html', 'contact-form']]) {
    await check(`${page}: a [data-hp] decoy inside #${form}, hidden (.hp-field, aria-hidden), not focusable, no autofill`, () => {
      const s = rd(page);
      const i = s.indexOf(`id="${form}"`), end = s.indexOf('</form>', i);
      const inner = s.slice(i, end);
      return (/<div class="hp-field" aria-hidden="true">/.test(inner) && /<input type="text" id="[a-z]+-hp" name="mrs_hp" data-hp tabindex="-1" autocomplete="off" value="">/.test(inner)
        && !/required/.test(inner.slice(inner.indexOf('hp-field'), inner.indexOf('hp-field') + 400))) || 'decoy missing';
    });
  }
  await check('style.css: .hp-field clipped (no display:none, no off-screen offset that scrolls an RTL page)', () => {
    const m = /\.hp-field \{([^}]*)\}/.exec(rd('assets/css/style.css'));
    return (m && /clip: rect\(0 0 0 0\)/.test(m[1]) && /pointer-events: none/.test(m[1]) && !/left:|right:|display: none/.test(m[1])) || 'rule missing';
  });
  await check('request.js / contact.js: armForm at init and on "new", formSignals(form) passed as opts.antispam', () => {
    const r = rd('assets/js/request.js'), c = rd('assets/js/contact.js');
    const ok = s => (s.match(/API\.armForm\(form\)/g) || []).length === 2 && /removeAttribute\('data-rendered-at'\)/.test(s)
      && /\{ antispam: API\.formSignals \? API\.formSignals\(form\) : null \}/.test(s);
    return (ok(r) && ok(c)) || J({ r: ok(r), c: ok(c) });
  });
  await check('supa.js: payload.antispam {hp, elapsedMs}; idempotency fingerprint ignores it; refusals reported (code only)', () => {
    const s = rd('assets/js/supa.js');
    return (/antispam: \{ hp: String/.test(s) && /delete v\.idempotencyKey; delete v\.antispam;/.test(s)
      && /reportError\('MRS_RATE_LIMITED', 'public refusal: ' \+ name/.test(s) && /noteRefusal\('public_track'\)/.test(s)
      && /armForm: armForm, formSignals: formSignals/.test(s)) || 'wiring missing';
  });
  await check('messages: supa.js codeDetails + i18n.js err.cdetail_MRS_RATE_LIMITED_try_later in Arabic and English', () => {
    const s = rd('assets/js/supa.js'), i = rd('assets/js/i18n.js');
    const ar = 'عدد كبير من الطلبات، حاول بعد قليل.';
    return (s.includes(`'MRS_RATE_LIMITED:try_later': '${ar}'`) && i.includes(`cdetail_MRS_RATE_LIMITED_try_later: '${ar}'`)
      && i.includes("cdetail_MRS_RATE_LIMITED_try_later: 'Too many requests. Please try again shortly.'")) || 'keys missing';
  });
  await check('supa.js formSignals / withSignals behave (vm): elapsed from data-rendered-at, decoy value, clamped', () => {
    const vm = require('vm');
    const src = rd('assets/js/supa.js');
    const grab = name => { const i = src.indexOf('  function ' + name + '('); const j = src.indexOf('\n  }\n', i); return src.slice(i, j + 4); };
    const ctx = { Date, Math, String };
    vm.createContext(ctx);
    vm.runInContext(grab('armForm') + grab('formSignals') + grab('withSignals') + ';this.api = { armForm, formSignals, withSignals };', ctx);
    const attrs = {}, decoy = { value: 'bot text' };
    const form = { getAttribute: k => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = v; }, querySelector: () => decoy };
    const unarmed = ctx.api.formSignals(form);                                     // no render time yet
    ctx.api.armForm(form);
    attrs['data-rendered-at'] = String(Date.now() - 5000);
    const s1 = ctx.api.formSignals(form);
    const p = ctx.api.withSignals({ a: 1 }, { antispam: { hp: 'x'.repeat(500), elapsedMs: 1e12 } });
    const none = ctx.api.withSignals({ a: 1 }, null);
    const keepNull = ctx.api.withSignals({ a: 1 }, { antispam: unarmed });
    const junk = ctx.api.withSignals({ a: 1 }, { antispam: { hp: '', elapsedMs: 'abc' } });
    return (s1.hp === 'bot text' && s1.elapsedMs >= 5000 && s1.elapsedMs < 7000 && p.antispam.hp.length === 200
      && p.antispam.elapsedMs === 2000000000 && p.a === 1 && J(none) === '{"a":1}'
      && unarmed.elapsedMs === null && keepNull.antispam.elapsedMs === null && junk.antispam.elapsedMs === null)
      || J({ s1, p, none, unarmed, keepNull, junk });
  });
  await check('regression: an unarmed form sends elapsedMs null and the server accepts it (no false "too fast" refusal)', async () => {
    await resetHits();
    return !!(await submitReq('anon', reqPayload({ antispam: { hp: '', elapsedMs: null } }), IP(230))).ref;
  });
  await check('supa.js publicTrack maps {not_found: true} → MRS_NOT_FOUND (vm), other results unchanged', () => {
    const vm = require('vm');
    const src = rd('assets/js/supa.js');
    const i = src.indexOf('  function trackMiss('), j = src.indexOf('\n  }\n', i);
    if (i < 0 || !/\.then\(trackMiss\)\.then\(noteRefusal\('public_track'\)\)/.test(src)) return 'trackMiss not wired';
    const ctx = { fail: c => ({ data: null, error: { code: c } }) };
    vm.createContext(ctx);
    vm.runInContext(src.slice(i, j + 4) + ';this.trackMiss = trackMiss;', ctx);
    const a = ctx.trackMiss({ data: { not_found: true }, error: null }), b = ctx.trackMiss({ data: { ref: 'X' }, error: null });
    const c = ctx.trackMiss({ data: null, error: { code: 'MRS_RATE_LIMITED' } });
    return (a.error.code === 'MRS_NOT_FOUND' && a.data === null && b.data.ref === 'X' && c.error.code === 'MRS_RATE_LIMITED') || J({ a, b, c });
  });
  await check('tracking.js: on MRS_RATE_LIMITED the "check your reference" hints are not shown', () => {
    const s = rd('assets/js/tracking.js');
    return (/var limited = !!err && err\.code === 'MRS_RATE_LIMITED';/.test(s) && /\(limited \? '' : '<ul>'/.test(s)) || 'not wired';
  });
}

/* ================================================================== main */
(async () => {
  console.log('Marsa — public anti-spam tests (PGlite; local only)');
  await secFile();
  await secPreflight();

  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ('${U.stranger}', 'stranger@antispam.example.com', now()),
      ('${U.staff}', 'staff@antispam.example.com', now()), ('${U.portal}', 'portal@antispam.example.com', now());
    INSERT INTO public.profiles (id, full_name) VALUES ('${U.stranger}', 'stranger'), ('${U.staff}', 'staff'), ('${U.portal}', 'portal')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ('${U.staff}', '${A}', NULL, 'accountant');
    INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ('${A}', '${CLIENT_A}', '${U.portal}', 'owner');
  `);
  if (!QUIET) console.log('  loaded');

  await secGrants();
  await secLimits();
  await secIp();
  await secUsers();
  await secHash();
  await secSignals();
  await secCompat();
  await secTrack();
  await secLogErrors();
  await secPurge();
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
