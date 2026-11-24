#!/usr/bin/env node
/*
  Marsa (مرسى) — re-conversion of an already converted (production) organisation: migration 20261211000100_reconvert.sql
  (public.reconvert_org_preview / public.reconvert_org, per-org PAY- / CUS- numbering, the generalised mail transaction
  reference), the Edge Function extractors (inbox-sync ai-mock.js / llm-provider.js) and the two runbooks
  (docs/online/CONVERT_IN_PLACE_AR.md, docs/owner/convert-plan-simple.md).
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network.

  Databases:
    FRESH  shim → migrations before this file → seed.sql → two staging orgs with payments / custody entries on the global
           sequences → this file (preflight, re-run, catalog delta, counters start at each org's highest number)
    MAIN   shim → every migration → seed.sql → owner (platform admin, NO TOTP factor: MFA is off) + staff → the FIRST
           conversion (convert_org_to_production) → org B created in production → business data in both orgs
           (transactions, payments, custody, storage override, contact message, channels, accounting link, AI settings)
           → refusals → preview (read-only) → re-conversion → numbering → a second re-conversion
    SIDE   shim → every migration → seed.sql (a staging org: refused, it takes the first conversion)
  The SQL Editor is the superuser with no JWT claims; API roles run as anon / authenticated / service_role.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/reconvert-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261211000100_reconvert.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);
const FN = path.join(SUPA, 'functions', 'inbox-sync');
const DOC_RUNBOOK = path.join(ROOT, 'docs', 'online', 'CONVERT_IN_PLACE_AR.md');
const DOC_SIMPLE = path.join(ROOT, 'docs', 'owner', 'convert-plan-simple.md');

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in reconvert-tests'); };

/* ------------------------------------------------------------------ harness */
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
async function step(name, fn) {
  try { const r = await fn(); pass(name); return r; }
  catch (e) { fail(name, errText(e)); throw new Error('aborted at: ' + name); }
}

const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const B = 'b0b00000-0000-4000-8000-000000000001';
const B_BR = 'b0b00000-0000-4000-8000-000000000011';
const C = 'c0c00000-0000-4000-8000-000000000001';
const C_BR = 'c0c00000-0000-4000-8000-000000000011';
const U = {
  owner: 'e0e00000-0000-4000-8000-000000000001', A_acc: 'e0e00000-0000-4000-8000-000000000002', A_mgr: 'e0e00000-0000-4000-8000-000000000003',
  A_clr: 'e0e00000-0000-4000-8000-000000000004', A_ops: 'e0e00000-0000-4000-8000-000000000005',
  B_admin: 'e0e00000-0000-4000-8000-000000000011', B_acc: 'e0e00000-0000-4000-8000-000000000012',
  C_acc: 'e0e00000-0000-4000-8000-000000000021'
};
let db;
async function asRole(who, fn) {
  if (who === 'anon') await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  else if (who === 'service') await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const one = async (sql, params) => (await q(sql, params))[0];
const num = async (sql, params) => Number((await q(sql, params))[0].n);
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
async function withDb(d, fn) { const saved = db; db = d; try { return await fn(); } finally { db = saved; } }
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
async function freshDb(opts) {
  const d = new PGlite();
  await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles().filter(f => !opts.before || f < opts.before)) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  if (opts.seed) await d.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  return d;
}
let seqN = 0;
const sadadNo = () => String(7100000000 + (++seqN));
const year = async () => (await one(`SELECT extract(year FROM (now() AT TIME ZONE 'Asia/Riyadh'))::int y`)).y;
async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d, coalesce(p.proconfig::text, '') c
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const cols = (await q(`SELECT table_schema || '.' || table_name || '.' || column_name || ':' || data_type c
                           FROM information_schema.columns WHERE table_schema IN ('public','app') ORDER BY 1`)).map(x => x.c);
  const trg = (await q(`SELECT c.relname || '.' || t.tgname || ':' || t.tgenabled::text x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                          WHERE NOT t.tgisinternal ORDER BY 1`)).map(x => x.x);
  const con = (await q(`SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) x FROM pg_constraint
                         WHERE connamespace IN ('public'::regnamespace, 'app'::regnamespace) ORDER BY 1`)).map(x => x.x);
  return { fns, cols, trg, con };
}
// every table of public / app with an org_id column (+ organizations by id)
async function orgTables() {
  return (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'p')
                      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)
                    ORDER BY 1`)).map(x => x.t);
}
async function globalTables() {
  return (await q(`SELECT n.nspname || '.' || c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname IN ('public', 'app', 'auth', 'storage') AND c.relkind IN ('r', 'p')
                      AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)
                      AND c.relname <> 'organizations'
                    ORDER BY 1`)).map(x => x.t);
}
const hashOf = async (sql, p) => { const r = await one(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM (${sql}) x`, p); return r.n + ':' + r.h; };
// the full state of one org: every org-scoped table + the org row
async function orgState(org) {
  const out = { organizations: await hashOf(`SELECT * FROM public.organizations WHERE id = $1`, [org]) };
  for (const t of await orgTables()) out[t] = await hashOf(`SELECT * FROM ${t} WHERE org_id = $1`, [org]);
  return out;
}
async function globalState() {
  const out = {};
  for (const t of await globalTables()) out[t] = await hashOf(`SELECT * FROM ${t}`);
  return out;
}
const diff = (a, b) => Object.keys(Object.assign({}, a, b)).filter(k => a[k] !== b[k]).map(k => k + ' ' + String(a[k]).split(':')[0] + '→' + String(b[k]).split(':')[0]);

/* ------------------------------------------------------------------ business data of one org (the RPCs the pages call) */
async function addUsers(rows) {
  await q(`INSERT INTO auth.users (id, email, email_confirmed_at) SELECT x.id::uuid, x.e, now() FROM jsonb_to_recordset($1::jsonb) x(id text, e text)`,
    [J(rows.map(([k, e]) => ({ id: U[k], e })))]);
}
async function addOrgData(o) {
  // o: {org, br, acc, tag}
  const cl = (await one(`INSERT INTO public.clients (org_id, client_type, name_ar, phone) VALUES ($1, 'business', $2, $3) RETURNING id`,
    [o.org, 'عميل تجريبي ' + o.tag, '05099' + String(10000 + (++seqN)).slice(-5)])).id;
  const tx = await one(`INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, container_count, bl_number)
                         VALUES ($1, $2, $3, 'import', 'sea', 0, $4) RETURNING id, ref`, [o.org, o.br, cl, 'TESTBL' + o.tag + (++seqN)]);
  const sup = (await one(`INSERT INTO public.parties (org_id, kinds, name_ar) VALUES ($1, ARRAY['supplier'], $2) RETURNING id`, [o.org, 'جهة ' + o.tag + ' ' + (++seqN)])).id;
  const pay = await rpc(o.acc, `SELECT public.record_payment_bundle($1, $2) r`, [{ movement_type: 'org_paid', pattern: 'single', service_code: 'port_charges',
    transaction_id: tx.id, paid_amount: 100, paid_at: '2026-11-01', funding_source: 'org_account', method: 'sadad', paying_account: 'Test Bank 01',
    sadad_number: sadadNo(), beneficiary_party_id: sup }, null]);
  const cus = await rpc(o.acc, `SELECT public.save_custody_entry($1, $2) r`, [{ client_id: cl, kind: 'deposit', amount: 50, entry_date: '2026-11-01', branch_id: o.br }, null]);
  return { cl, tx, sup, pay, cus };
}

/* ================================================================== 1. files */
async function secFiles() {
  section('1. files: migration conventions, all_migrations.sql, docs, the Edge Function extractors');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const code = src.replace(/--.*$/gm, '');
  await check('conventions: encoding guard, preflight on 20261209000100 + 20261115000100, schema_versions row, search_path = \'\' on every function', () => {
    const heads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = heads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261209000100'/.test(src) && /version = '20261115000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261211000100', 'reconvert'\)/.test(src)
      && heads.length === 12 && bad.length === 0) || J({ n: heads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('refusals only through app.fail(\'MRS_*\'); both public functions refuse JWT claims; revoked from every API role incl. service_role', () => {
    const raises = (src.match(/RAISE EXCEPTION[^;]*;/g) || []).filter(r => !/ENCODING ERROR|RECONVERT preflight/.test(r));
    const codes = code.match(/app\.fail\('([A-Z_]+)'/g) || [];
    return (raises.length === 0 && codes.length >= 8 && codes.every(c => /app\.fail\('MRS_[A-Z_]+'/.test(c))
      && (code.match(/IF nullif\(current_setting\('request\.jwt\.claims', true\), ''\) IS NOT NULL THEN\s+PERFORM app\.fail\('MRS_FORBIDDEN', 'sql_editor_only'\)/g) || []).length === 3
      && /REVOKE EXECUTE ON FUNCTION public\.reconvert_org_preview\(uuid, text, text\),\s+public\.reconvert_org\(uuid, text, text, text, text, text\)\s+FROM PUBLIC, anon, authenticated, service_role;/.test(code)
      && (code.match(/\bGRANT\b/g) || []).length === 1 && /GRANT EXECUTE ON FUNCTION public\.review_msg_extraction\(uuid, text, text, text\) TO authenticated;/.test(code))
      || J({ raises, codes: codes.length });
  });
  await check('the wipe reuses the first conversion\'s lists (convert_delete_tables / convert_delete_guards / convert_check); no TRUNCATE / DROP TABLE / session_replication_role', () =>
    (/FOREACH v_t IN ARRAY app\.convert_delete_tables\(\) LOOP/.test(code) && /FOREACH v_g IN ARRAY app\.convert_delete_guards\(\) LOOP\s+EXECUTE format\('ALTER TABLE %s DISABLE TRIGGER %I'/.test(code)
      && (code.match(/DISABLE TRIGGER/g) || []).length === 1 && /unnest\(app\.convert_check\(p_org\)\)/.test(code)
      && !/CREATE OR REPLACE FUNCTION app\.convert_(delete|keep)_tables/.test(code) && !/\bTRUNCATE\b/i.test(code)
      && !/\bDROP\s+(TABLE|FUNCTION|SCHEMA)/i.test(code) && !/session_replication_role/.test(code)) || 'body');
  await check('confirm phrase WIPE-ALL-DATA-<current-slug>-TO-<slug>-<PREFIX> (run and preview); never_converted blocker; no seed slug / seed id literal; no TOTP / mfa_factors condition (MFA is off)', () =>
    (/p_confirm IS DISTINCT FROM 'WIPE-ALL-DATA-' \|\| o\.slug \|\| '-TO-' \|\| v_slug \|\| '-' \|\| v_prefix/.test(code)
      && /'confirm_phrase', CASE WHEN cardinality\(v_err\) = 0 THEN 'WIPE-ALL-DATA-' \|\| o\.slug \|\| '-TO-' \|\| v_slug \|\| '-' \|\| v_pfx END/.test(code)
      && /NOT EXISTS \(SELECT 1 FROM app\.org_conversions c WHERE c\.org_id = p_org\) THEN\s+v_out := v_out \|\| 'never_converted'/.test(code)
      && !code.includes('blue-sea') && !code.includes('0b5e0000-')
      && !/mfa_factors|totp|aal2/i.test(code)) || 'body');
  const LATER = ['20261213000100_site_profile.sql', '20261214000100_org_ai_keys.sql'];
  await check('this file is the last migration (or followed only by listed later phases)', () => {
    const later = migFiles().filter(f => f > MIG);
    return (migFiles().includes(MIG) && later.every(f => LATER.includes(f))) || 'unexpected later files: ' + later.join(', ');
  });
  await check('all_migrations.sql holds this file verbatim + a header line', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    const next = all.indexOf('\n-- ===== migrations/', i + marker.length);
    const body = all.slice(i + marker.length, next < 0 ? undefined : next);
    return (i > 0 && body.replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0
      && all.slice(0, 20000).includes('supabase/migrations/' + MIG)) || 'not appended verbatim / no header line';
  });
  await check('docs: the runbook and the simple plan name both steps, the confirm phrase, the prefix rule, the backup and what is kept', () => {
    const r = fs.readFileSync(DOC_RUNBOOK, 'utf8'), s = fs.readFileSync(DOC_SIMPLE, 'utf8');
    const both = [r, s].every(t => /reconvert_org_preview/.test(t) && /reconvert_org\(/.test(t) && /WIPE-ALL-DATA-/.test(t) && /نسخة احتياطية/.test(t));
    return (both && /20261211000100/.test(r) && /PAY-000001/.test(r) && /platform_admin_without_totp/.test(r) && /ref_prefix_used/.test(r)
      && /الفروع/.test(s) && /دفترة|الربط المحاسبي/.test(s) && !/sb_secret_|service_role key|eyJhbGci/.test(r + s)) || 'docs';
  });
  await check('Edge Function extractors: no hard-coded ^MRS- tx_ref pattern left; node --check clean', () => {
    const am = fs.readFileSync(path.join(FN, 'ai-mock.js'), 'utf8'), lp = fs.readFileSync(path.join(FN, 'llm-provider.js'), 'utf8');
    let ok = true;
    for (const f of ['ai-mock.js', 'llm-provider.js']) { try { new (require('vm').Script)(fs.readFileSync(path.join(FN, f), 'utf8')); } catch (e) { ok = false; } }
    return (ok && !/MRS-\\d\{4\}/.test(am) && !/MRS-\\d\{4\}/.test(lp) && !/MRS-YYYY/.test(lp) && /\[A-Z\]\{2,5\}-\\d\{4\}-\\d\{6\}/.test(am)
      && /\[A-Z\]\{2,5\}-\\d\{4\}-\\d\{6\}/.test(lp)) || 'extractors';
  });
}

/* ================================================================== 2. FRESH: preflight, re-run, catalog delta, PAY / CUS counters */
async function secFresh() {
  section('2. FRESH: preflight, re-run, catalog delta; PAY- / CUS- counters start at each org\'s highest number');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  const d = await freshDb({ before: MIG, seed: true });
  try {
    await withDb(d, async () => {
      await addUsers([['A_acc', 'acc.a@reconvert.example.com'], ['C_acc', 'acc.c@reconvert.example.com']]);
      await q(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix) VALUES ($1, 'org-c-fresh', 'مؤسسة ج', 'CCC')`, [C]);
      await q(`INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ($1, $2, 'RUH', 'فرع الرياض')`, [C_BR, C]);
      await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'accountant'), ($3, $4, NULL, 'accountant')`,
        [U.A_acc, A, U.C_acc, C]);
      const a1 = await addOrgData({ org: A, br: JED, acc: 'A_acc', tag: 'FA' });
      const c1 = await addOrgData({ org: C, br: C_BR, acc: 'C_acc', tag: 'FC' });
      const a2 = await addOrgData({ org: A, br: JED, acc: 'A_acc', tag: 'FA' });
      await check('before this file: PAY- / CUS- come from ONE global sequence (A 1, C 2, A 3)', () =>
        (J([a1.pay.ref, c1.pay.ref, a2.pay.ref, a1.cus.ref, c1.cus.ref, a2.cus.ref])
          === J(['PAY-000001', 'PAY-000002', 'PAY-000003', 'CUS-000001', 'CUS-000002', 'CUS-000003'])) || J([a1.pay.ref, c1.pay.ref, a2.pay.ref]));
      const C0 = await catalog();
      await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261209000100'`);
      const msg = await tryErr(() => db.exec(src));
      await check('without ai_keys: exact preflight message; nothing created', async () =>
        (msg.startsWith('RECONVERT preflight: apply ai_keys first (schema_versions lacks 20261209000100)') && J(C0) === J(await catalog())) || 'got: ' + msg);
      await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261209000100', 'ai_keys')`);
      const rows = async () => J(await q(`SELECT (SELECT count(*) FROM public.organizations) o, (SELECT count(*) FROM public.transactions) t,
          (SELECT string_agg(ref, ',' ORDER BY ref) FROM public.client_disbursements) p, (SELECT string_agg(ref, ',' ORDER BY ref) FROM public.client_custody_entries) c,
          (SELECT count(*) FROM public.org_counters WHERE scope IN ('transaction','request','message','import')) k, (SELECT environment FROM app.deploy_settings) e,
          (SELECT count(*) FROM app.org_conversions) v`));
      const before = await rows();
      const r1 = await tryErr(() => db.exec(src));
      const C1 = await catalog();
      const r2 = await tryErr(() => db.exec(src));
      await check('applies, and re-runs on top of itself with an identical catalog', async () => (r1 === 'ok' && r2 === 'ok' && J(C1) === J(await catalog())) || J({ r1, r2 }));
      await check('applying the file changed no business data (orgs, transactions, every PAY- / CUS- reference, yearly counters, environment)', async () =>
        (await rows()) === before || 'data changed');
      await check('catalog delta: the 12 functions of the file (review_msg_extraction re-created); 2 triggers trg_org_seq; org_conversions + run_no / kind', () => {
        const m0 = new Map(C0.fns.map(f => [f.sig, f]));
        const added = C1.fns.filter(f => !m0.has(f.sig)).map(f => f.sig.replace(/\(.*$/, '')).sort();
        const changed = C1.fns.filter(f => m0.has(f.sig) && J(m0.get(f.sig)) !== J(f)).map(f => f.sig.replace(/\(.*$/, ''));
        const trAdd = C1.trg.filter(x => !C0.trg.includes(x)).sort();
        const colAdd = C1.cols.filter(x => !C0.cols.includes(x)).sort();
        return (J(added) === J(['app.msg_tx_ref_ok', 'app.next_org_seq', 'app.reconvert_check', 'app.reconvert_input_errors', 'app.reconvert_ready',
          'app.reconvert_reserved_prefixes', 'app.reconvert_used_prefixes', 'app.reconvert_wipe', 'app.tg_org_seq', 'public.reconvert_org',
          'public.reconvert_org_preview']) && J(changed) === J(['public.review_msg_extraction'])
          && J(trAdd) === J(['client_custody_entries.trg_org_seq:O', 'client_disbursements.trg_org_seq:O'])
          && J(colAdd) === J(['app.org_conversions.kind:text', 'app.org_conversions.run_no:integer'])
          && C0.cols.every(x => C1.cols.includes(x))) || J({ added, changed, trAdd, colAdd });
      });
      await check('constraints: (org_id, ref) unique on both tables, org_counters scopes + payment / custody, org_conversions key (org_id, run_no)', () => {
        const has = x => C1.con.includes(x);
        return (has('client_disbursements.client_disbursements_ref_uniq:UNIQUE (org_id, ref)') && has('client_custody_entries.client_custody_entries_ref_uniq:UNIQUE (org_id, ref)')
          && C1.con.some(x => x.startsWith('org_counters.org_counters_scope_check:') && /custody/.test(x) && /payment/.test(x) && /transaction/.test(x))
          && has('app.org_conversions.org_conversions_pkey:PRIMARY KEY (org_id, run_no)')) || J(C1.con.filter(x => /ref_uniq|scope_check|org_conversions/.test(x)));
      });
      await check('the counters start at each org\'s highest number (A 3 / C 2), year 0', async () =>
        J(await q(`SELECT org_id::text o, scope, year, last_value::int v FROM public.org_counters WHERE scope IN ('payment','custody') ORDER BY 2, 1`))
          === J([{ o: A, scope: 'custody', year: 0, v: 3 }, { o: C, scope: 'custody', year: 0, v: 2 }, { o: A, scope: 'payment', year: 0, v: 3 }, { o: C, scope: 'payment', year: 0, v: 2 }])
        || J(await q(`SELECT * FROM public.org_counters WHERE scope IN ('payment','custody')`)));
      const a3 = await addOrgData({ org: A, br: JED, acc: 'A_acc', tag: 'FA' });
      const c3 = await addOrgData({ org: C, br: C_BR, acc: 'C_acc', tag: 'FC' });
      await check('after the file: numbering per org — A PAY-000004 / CUS-000004, C PAY-000003 / CUS-000003 (C may reuse a number A once had: unique per org)', () =>
        (J([a3.pay.ref, a3.cus.ref, c3.pay.ref, c3.cus.ref]) === J(['PAY-000004', 'CUS-000004', 'PAY-000003', 'CUS-000003'])
          && Number(a3.pay.seq || 4) === 4) || J([a3.pay.ref, a3.cus.ref, c3.pay.ref, c3.cus.ref]));
      await check('a direct insert cannot choose its own number: trg_org_seq overrides seq / ref (then the matrix CHECK still applies)', async () => {
        const svc = (await one(`SELECT id FROM public.org_service_items WHERE org_id = $1 AND code = 'port_charges'`, [C])).id;
        const r = await tryErr(() => q(`INSERT INTO public.client_disbursements (org_id, branch_id, seq, ref, movement_type, pattern, service_item_id, service_code,
            expected_amount, paid_amount, paid_at, funding_source, method, payer_name, beneficiary_party_id, beneficiary_name, receipt_no, created_by)
          VALUES ($1, $2, 999999, 'PAY-999999', 'org_paid', 'single', $3, 'x1', 1, 1, current_date, 'cash_box', 'mada', 'x', $4, 'x', 'R1', $5)`,
          [C, C_BR, svc, c3.sup, U.C_acc]));
        const v = await num(`SELECT last_value n FROM public.org_counters WHERE org_id = $1 AND scope = 'payment'`, [C]);
        return (/client_disbursements_matrix_chk/.test(r) && v === 3) || J({ r, v });
      });
      const pre = await one(`SELECT app.reconvert_check($1) b`, [A]);
      await check('a staging org (not converted) is refused by the re-conversion check: not_production', () =>
        (pre.b.includes('not_production')) || J(pre));
    });
  } finally { await d.close(); }
}

/* ================================================================== 3. MAIN: build */
let MAINDB;
const OWNER_SLUG_1 = 'marsa-ksa';
async function build() {
  section('3. MAIN: owner without TOTP, the FIRST conversion, org B in production, business data in both orgs');
  await step('fixtures: owner = platform admin (no TOTP factor) + admin of A; A staff; first conversion of the seed org', async () => {
    await addUsers([['owner', 'owner@reconvert.example.com'], ['A_acc', 'acc.a@reconvert.example.com'], ['A_mgr', 'mgr.a@reconvert.example.com'],
      ['A_clr', 'clr.a@reconvert.example.com'], ['A_ops', 'ops.a@reconvert.example.com'], ['B_admin', 'admin.b@reconvert.example.com'],
      ['B_acc', 'acc.b@reconvert.example.com']]);
    await q(`INSERT INTO public.platform_admins (user_id, note) VALUES ($1, 'owner')`, [U.owner]);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'admin')`, [U.owner, A]);
    const r = (await one(`SELECT public.convert_org_to_production($1, $2, $3, $4, $5) r`,
      [A, OWNER_SLUG_1, 'مؤسسة البحر الأزرق', 'Blue Sea Est.', 'DELETE-TEST-DATA-' + OWNER_SLUG_1])).r;
    if (r.environment !== 'production') throw new Error(J(r));
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
               ($1, $5, NULL, 'accountant'), ($2, $5, NULL, 'accounts_manager'), ($3, $5, $6, 'clearance_staff'), ($4, $5, NULL, 'operations_manager')`,
      [U.A_acc, U.A_mgr, U.A_clr, U.A_ops, A, JED]);
  });
  await check('the first conversion left one row in app.org_conversions (run_no 1, kind convert); deploy environment production', async () => {
    const r = await q(`SELECT run_no, kind, to_slug FROM app.org_conversions`);
    return (J(r) === J([{ run_no: 1, kind: 'convert', to_slug: OWNER_SLUG_1 }]) && (await one(`SELECT environment e FROM app.deploy_settings`)).e === 'production') || J(r);
  });
  await step('org B created in production (another office on the same database) with its own staff', async () => {
    await q(`INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix) VALUES ($1, 'org-b-prod', 'مؤسسة ب', 'Org B', 'BBB')`, [B]);
    await q(`INSERT INTO public.branches (id, org_id, code, name_ar) VALUES ($1, $2, 'RUH', 'فرع الرياض')`, [B_BR, B]);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $3, NULL, 'admin'), ($2, $3, NULL, 'accountant')`, [U.B_admin, U.B_acc, B]);
    const e = (await one(`SELECT environment e FROM public.organizations WHERE id = $1`, [B])).e;
    if (e !== 'production') throw new Error(e);
  });
  const D = {};
  await step('business data in A (2 rounds) and B: clients, transactions, payments, custody, storage override; A: contact message, channels, accounting link, AI settings', async () => {
    D.a1 = await addOrgData({ org: A, br: JED, acc: 'A_acc', tag: 'MA' });
    D.b1 = await addOrgData({ org: B, br: B_BR, acc: 'B_acc', tag: 'MB' });
    D.a2 = await addOrgData({ org: A, br: DMM, acc: 'A_acc', tag: 'MA' });
    await q(`INSERT INTO public.tx_storage_overrides (org_id, transaction_id, reason, approved_by) VALUES ($1, $2, 'موافقة مدير للاختبار', $3), ($4, $5, 'موافقة ب', $6)`,
      [A, D.a1.tx.id, U.A_ops, B, D.b1.tx.id, U.B_admin]);
    const m = await rpc('anon', `SELECT public.submit_contact_message($1) r`, [{ orgSlug: OWNER_SLUG_1, name: 'زائر تجريبي', phone: '0126100001',
      email: 'v@example.com', subject: 'quote', message: 'رسالة اختبار طويلة بما يكفي للتحقق', consent: true, antispam: { hp: '', elapsedMs: 4000 } }]);
    D.msg = m.ref;
    D.live = (await one(`INSERT INTO public.msg_channels (org_id, kind, name, address, address_norm, default_branch_id, mode, status, ingest_enabled,
                                                        send_enabled, provider_terms_ack_by, provider_terms_ack_at, poll_cursor)
                         VALUES ($1, 'email', 'بريد العمليات', 'ops@marsacloud.example', 'ops@marsacloud.example', $2, 'live_pending', 'connected', true, true,
                                 $3, now(), 'uid:4242') RETURNING id`, [A, JED, U.owner])).id;
    D.mock = await rpc('owner', `SELECT public.save_msg_channel($1, $2, $3) r`, [A, { kind: 'email', name: 'بريد تجريبي', address: 'mock@reconvert.example',
      default_branch_id: JED, mode: 'mock', ingest_enabled: true, send_enabled: true, provider_terms_ack: true }, null]);
    await rpc('A_mgr', `SELECT public.save_daftra_connection($1, $2) r`, [A, { mode: 'mock', subdomain: 'reconvert-a', sync_enabled: true }]);
    await rpc('owner', `SELECT public.ai_save_settings($1, $2) r`, [A, { enabled: true, consent_ack: true, daily_request_cap: 50, monthly_budget_usd: 20 }]);
  });
  await check('numbering before the re-conversion: A transactions MRS-<year>-…, PAY- per org (A 1 + 2, B 1), contact MSG-', async () => {
    const y = await year();
    return (D.a1.tx.ref === 'MRS-' + y + '-000001' && D.a2.tx.ref === 'MRS-' + y + '-000002' && D.b1.tx.ref === 'BBB-' + y + '-000001'
      && J([D.a1.pay.ref, D.a2.pay.ref, D.b1.pay.ref]) === J(['PAY-000001', 'PAY-000002', 'PAY-000001']) && /^MSG-\d{4}-\d{6}$/.test(D.msg || '')) || J(D);
  });
  return D;
}

/* ================================================================== 4. privileges + refusals */
// the confirm phrase names the org being wiped (its current slug) and the new slug / prefix
const phrase = (fromSlug, slug, pfx) => 'WIPE-ALL-DATA-' + fromSlug + '-TO-' + slug + '-' + pfx;
const SLUG2 = 'marsa-new', PFX2 = 'NEW', CONFIRM2 = phrase(OWNER_SLUG_1, SLUG2, PFX2);
const SQL_RUN = `SELECT public.reconvert_org($1, $2, $3, $4, $5, $6) r`;
const run = (org, slug, pfx, confirm, ar, en) => one(SQL_RUN, [org, slug, pfx, confirm, ar === undefined ? null : ar, en === undefined ? null : en]).then(x => x.r);
const preview = (org, slug, pfx) => one(`SELECT public.reconvert_org_preview($1, $2, $3) r`, [org, slug || null, pfx || null]).then(x => x.r);
async function secRefusals() {
  section('4. privileges (SQL Editor only) + refusals (each leaves every org exactly as it was)');
  await check('no API role may execute reconvert_org / reconvert_org_preview / any app.reconvert_* helper / the counter + ref helpers', async () => {
    const r = await q(`SELECT p.oid::regprocedure::text f, r.rolname FROM pg_proc p CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) r(rolname)
                        WHERE ((p.proname LIKE 'reconvert\\_%' AND p.pronamespace IN ('app'::regnamespace, 'public'::regnamespace))
                               OR (p.proname IN ('next_org_seq', 'tg_org_seq', 'msg_tx_ref_ok') AND p.pronamespace = 'app'::regnamespace))
                          AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')`);
    const n = await num(`SELECT count(*) n FROM pg_proc WHERE proname LIKE 'reconvert\\_%' OR proname IN ('next_org_seq', 'tg_org_seq', 'msg_tx_ref_ok')`);
    const rev = await one(`SELECT has_function_privilege('authenticated', 'public.review_msg_extraction(uuid, text, text, text)', 'EXECUTE') a,
                                  has_function_privilege('anon', 'public.review_msg_extraction(uuid, text, text, text)', 'EXECUTE') n`);
    return (r.length === 0 && n === 11 && rev.a && !rev.n) || J({ r, n, rev });
  });
  const SA = await orgState(A), SB = await orgState(B), SG = await globalState();
  const same = async () => {
    const a = diff(SA, await orgState(A)), b = diff(SB, await orgState(B)), g = diff(SG, await globalState());
    return (a.length + b.length + g.length === 0) || J({ a, b, g });
  };
  await check('authenticated (even the owner) cannot call either function: permission denied', async () => {
    const r = [await tryErr(() => as('owner', SQL_RUN, [A, SLUG2, PFX2, CONFIRM2, null, null])),
      await tryErr(() => as('owner', `SELECT public.reconvert_org_preview($1, $2, $3) r`, [A, SLUG2, PFX2])),
      await tryErr(() => as('service', SQL_RUN, [A, SLUG2, PFX2, CONFIRM2, null, null]))];
    return r.every(x => /permission denied/.test(x)) || J(r);
  });
  await check('the SQL Editor role with JWT claims set is refused: sql_editor_only (preview and run)', async () => {
    await db.exec(`SELECT set_config('request.jwt.claims', '{"sub":"${U.owner}","role":"authenticated"}', false)`);
    try {
      const r = [await tryErr(() => run(A, SLUG2, PFX2, CONFIRM2)), await tryErr(() => preview(A, SLUG2, PFX2))];
      return r.every(x => /MRS_FORBIDDEN sql_editor_only/.test(x)) || J(r);
    } finally { await db.exec(`SELECT set_config('request.jwt.claims', '', false)`); }
  });
  const cases = [
    ['prefix one letter', [A, SLUG2, 'N', 'WIPE-ALL-DATA-' + SLUG2 + '-N'], /MRS_INVALID ref_prefix/],
    ['prefix six letters', [A, SLUG2, 'ABCDEF', 'WIPE-ALL-DATA-' + SLUG2 + '-ABCDEF'], /MRS_INVALID ref_prefix/],
    ['prefix with a digit', [A, SLUG2, 'AB1', 'WIPE-ALL-DATA-' + SLUG2 + '-AB1'], /MRS_INVALID ref_prefix/],
    ['prefix empty', [A, SLUG2, '', 'WIPE-ALL-DATA-' + SLUG2 + '-'], /MRS_INVALID ref_prefix/],
    ['prefix reserved (REQ / PAY / MRSC)', [A, SLUG2, 'REQ', 'WIPE-ALL-DATA-' + SLUG2 + '-REQ'], /MRS_INVALID ref_prefix_reserved/],
    ['prefix reserved PAY', [A, SLUG2, 'pay', 'WIPE-ALL-DATA-' + SLUG2 + '-PAY'], /MRS_INVALID ref_prefix_reserved/],
    ['prefix = the current one (MRS)', [A, SLUG2, 'MRS', 'WIPE-ALL-DATA-' + SLUG2 + '-MRS'], /MRS_INVALID ref_prefix_used/],
    ['slug taken by another org', [A, 'org-b-prod', PFX2, 'WIPE-ALL-DATA-org-b-prod-' + PFX2], /MRS_INVALID slug_taken/],
    ['slug = the seed demo slug', [A, 'blue-sea', PFX2, 'WIPE-ALL-DATA-blue-sea-' + PFX2], /MRS_INVALID slug_demo/],
    ['slug malformed', [A, '-x', PFX2, 'WIPE-ALL-DATA--x-' + PFX2], /MRS_INVALID slug/],
    ['Arabic name with a test word', [A, SLUG2, PFX2, CONFIRM2, 'مؤسسة تجريبية للاختبار'], /MRS_INVALID name_ar/],
    ['English name with demo', [A, SLUG2, PFX2, CONFIRM2, null, 'Demo Co'], /MRS_INVALID name_en/],
    ['confirm phrase missing', [A, SLUG2, PFX2, null], /MRS_INVALID confirm/],
    ['confirm phrase of the first conversion', [A, SLUG2, PFX2, 'DELETE-TEST-DATA-' + SLUG2], /MRS_INVALID confirm/],
    ['confirm phrase with another prefix', [A, SLUG2, PFX2, phrase(OWNER_SLUG_1, SLUG2, 'ABC')], /MRS_INVALID confirm/],
    ['confirm phrase without the current slug (new slug + prefix only)', [A, SLUG2, PFX2, 'WIPE-ALL-DATA-' + SLUG2 + '-' + PFX2], /MRS_INVALID confirm/],
    ['confirm phrase naming another org\'s slug (wrong org uuid pasted)', [A, SLUG2, PFX2, phrase('org-b-prod', SLUG2, PFX2)], /MRS_INVALID confirm/],
    ['org B (wrong uuid) with the phrase meant for A', [B, SLUG2, PFX2, CONFIRM2], /MRS_INVALID confirm/],
    ['unknown org', ['ffffffff-0000-4000-8000-000000000000', SLUG2, PFX2, CONFIRM2], /MRS_NOT_FOUND organization/],
    ['org B: no platform-admin admin membership, never converted', [B, 'org-b-new', 'BBN', phrase('org-b-prod', 'org-b-new', 'BBN')], /MRS_FORBIDDEN owner_admin_membership_missing never_converted\s*$/]
  ];
  for (const [name, p, re] of cases) {
    await check('refused: ' + name, async () => {
      const r = await tryErr(() => run(p[0], p[1], p[2], p[3], p[4], p[5]));
      return re.test(r) || 'got: ' + r;
    });
  }
  await check('the first conversion cannot run a second time (already_production): a second run is only reconvert_org', async () => {
    const r = await tryErr(() => one(`SELECT public.convert_org_to_production($1, $2, $3, $4, $5) r`, [A, SLUG2, 'مؤسسة', 'Org', 'DELETE-TEST-DATA-' + SLUG2]));
    return /MRS_BAD_TRANSITION already_production/.test(r) || r;
  });
  await check('a new BEFORE DELETE guard on a deleted table blocks the run (unexpected_delete_guards), never bypassed silently', async () => {
    await db.exec(`CREATE TRIGGER trg_zz_guard BEFORE DELETE ON public.clients FOR EACH ROW EXECUTE FUNCTION app.tg_org_conversions_guard()`);
    try {
      const r = await tryErr(() => run(A, SLUG2, PFX2, CONFIRM2));
      const p = await preview(A, SLUG2, PFX2);
      return (/MRS_FORBIDDEN unexpected_delete_guards:public\.clients:trg_zz_guard/.test(r) && J(p.blockers) === J(['unexpected_delete_guards:public.clients:trg_zz_guard'])) || J({ r, b: p.blockers });
    } finally { await db.exec(`DROP TRIGGER trg_zz_guard ON public.clients`); }
  });
  await check('a new org-scoped table not classified blocks the run (unclassified_tables)', async () => {
    await db.exec(`CREATE TABLE public.zz_new_tenant (id int PRIMARY KEY, org_id uuid); ALTER TABLE public.zz_new_tenant ENABLE ROW LEVEL SECURITY;`);
    try {
      const r = await tryErr(() => run(A, SLUG2, PFX2, CONFIRM2));
      return /MRS_FORBIDDEN unclassified_tables:public\.zz_new_tenant/.test(r) || r;
    } finally { await db.exec(`DROP TABLE public.zz_new_tenant`); }
  });
  await check('after every refusal: org A, org B and every global table are exactly as before', same);
  await check('org B created directly in production, the owner admin of it too (last: it adds a membership): refused never_converted (only a converted org is wiped by this path)', async () => {
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'admin')`, [U.owner, B]);
    try {
      const r = await tryErr(() => run(B, 'org-b-new', 'BBN', phrase('org-b-prod', 'org-b-new', 'BBN')));
      const p = await preview(B, 'org-b-new', 'BBN');
      return (/MRS_FORBIDDEN never_converted\s*$/.test(r) && J(p.blockers) === J(['never_converted'])
        && p.confirm_phrase === phrase('org-b-prod', 'org-b-new', 'BBN')) || J({ r, b: p.blockers, c: p.confirm_phrase });
    } finally { await q(`DELETE FROM public.memberships WHERE user_id = $1 AND org_id = $2`, [U.owner, B]); }
  });
  return { same };
}

/* ================================================================== 5. preview */
let PRE;
async function secPreview() {
  section('5. preview (read-only)');
  const SA = await orgState(A), SB = await orgState(B), SG = await globalState();
  await db.exec('BEGIN READ ONLY');
  try { PRE = await preview(A, ' Marsa-New ', 'new'); }
  finally { await db.exec('ROLLBACK'); }
  await check('runs inside a READ ONLY transaction; nothing changed anywhere', async () => {
    const a = diff(SA, await orgState(A)), b = diff(SB, await orgState(B)), g = diff(SG, await globalState());
    return (PRE && a.length + b.length + g.length === 0) || J({ a, b, g });
  });
  const y = await year();
  await check('normalises the inputs, gives the confirm phrase, the first new reference, no input errors, no blockers, no warnings', () =>
    (PRE.new_slug === SLUG2 && PRE.new_ref_prefix === PFX2 && PRE.confirm_phrase === CONFIRM2 && PRE.first_transaction_ref_after === PFX2 + '-' + y + '-000001'
      && J(PRE.input_errors) === '[]' && J(PRE.blockers) === '[]' && J(PRE.warnings) === '[]' && PRE.ref_prefix === 'MRS' && PRE.slug === OWNER_SLUG_1
      && J(PRE.used_prefixes) === J(['MRS']) && J(PRE.runs_before.map(r => r.kind)) === J(['convert'])) || J(PRE));
  await check('would_delete = the real rows per deleted table (every table of app.convert_delete_tables, incl. 20261204–20261209 tx_storage_overrides)', async () => {
    const tables = (await one(`SELECT app.convert_delete_tables() t`)).t;
    const bad = [];
    let total = 0;
    for (const t of tables) {
      const n = await num(`SELECT count(*) n FROM ${t} WHERE org_id = $1`, [A]);
      total += n;
      if (PRE.would_delete[t.split('.')[1]] !== n) bad.push(t + ' ' + PRE.would_delete[t.split('.')[1]] + '≠' + n);
    }
    return (bad.length === 0 && PRE.would_delete_total === total && total > 20 && PRE.would_delete.tx_storage_overrides === 1
      && PRE.would_delete.client_disbursements === 2 && PRE.would_delete.client_custody_entries === 2 && PRE.would_delete.transactions === 2) || J({ bad, total, t: PRE.would_delete_total });
  });
  await check('kept: per kept table (branches 2, channels 2, accounting link 1, AI settings, stage sets, storage-gate ports, service items); memberships kept / removed; counters to reset', () =>
    (PRE.kept['public.branches'] === 2 && PRE.kept['public.msg_channels'] === 2 && PRE.kept['public.daftra_connections'] === 1 && PRE.kept['app.ai_settings'] === 1
      && PRE.kept['public.tx_stage_sets'] !== undefined && PRE.kept['public.storage_gate_ports'] >= 1 && PRE.kept['public.org_service_items'] >= 1
      && PRE.ai_settings_kept === true && PRE.accounting_link && PRE.accounting_link.mode === 'mock'
      && PRE.memberships_kept.length === 1 && PRE.memberships_kept[0].role === 'admin' && PRE.memberships_removed.length === 4
      && PRE.counters_reset.some(c => c.scope === 'payment' && c.last_value === 2) && PRE.counters_reset.some(c => c.scope === 'transaction')
      && J(PRE.branches) === J(['DMM', 'JED'])) || J({ kept: PRE.kept, mk: PRE.memberships_kept, mr: PRE.memberships_removed, c: PRE.counters_reset }));
  await check('input errors are listed (no confirm phrase) for a used / reserved / malformed prefix and a taken slug', async () => {
    const r = [await preview(A, SLUG2, 'MRS'), await preview(A, 'org-b-prod', 'TAS'), await preview(A, 'x', 'Q'), await preview(A)];
    return (J(r.map(x => x.input_errors)) === J([['ref_prefix_used'], ['slug_taken', 'ref_prefix_reserved'], ['slug', 'ref_prefix'], ['slug_and_prefix_not_given']])
      && r.every(x => x.confirm_phrase === null)) || J(r.map(x => x.input_errors));
  });
  await check('preview of B lists its blockers (owner_admin_membership_missing, never_converted); a prefix another org uses is only a warning', async () => {
    const r = await preview(B, 'org-b-new', 'BBN');
    const w = await preview(A, SLUG2, 'BBB');
    return (J(r.blockers) === J(['owner_admin_membership_missing', 'never_converted']) && J(w.warnings) === J(['ref_prefix_used_by_another_org']) && J(w.input_errors) === '[]') || J({ r: r.blockers, w: w.warnings });
  });
}

/* ================================================================== 6. the run */
let RES;
async function secRun(D) {
  section('6. the re-conversion of A (new slug + prefix, names kept)');
  const SB = await orgState(B), SG = await globalState();
  const keepTables = (await one(`SELECT app.convert_keep_tables() t`)).t.filter(t => !['public.memberships', 'public.org_counters', 'public.org_usage_counters', 'public.audit_log'].includes(t));
  const keepBefore = {};
  for (const t of keepTables) keepBefore[t] = await hashOf(`SELECT * FROM ${t} WHERE org_id = $1 ${t === 'public.msg_channels' ? "AND mode <> 'mock'" : ''}`, [A]);
  const orgBefore = await one(`SELECT * FROM public.organizations WHERE id = $1`, [A]);
  const auditB = await num(`SELECT count(*) n FROM public.audit_log WHERE org_id = $1`, [A]);
  RES = await step('reconvert_org(A, ' + SLUG2 + ', ' + PFX2 + ', ' + CONFIRM2 + ')', () => run(A, SLUG2, PFX2.toLowerCase(), CONFIRM2));
  await check('summary: run 2, kind reconvert, from MRS / ' + OWNER_SLUG_1 + ' to NEW / ' + SLUG2 + '; deleted = the preview counts (+ memberships 4)', () => {
    const del = Object.assign({}, RES.deleted); delete del.memberships;
    return (RES.run_no === 2 && RES.kind === 'reconvert' && RES.from_ref_prefix === 'MRS' && RES.ref_prefix === PFX2 && RES.from_slug === OWNER_SLUG_1 && RES.slug === SLUG2
      && J(del) === J(PRE.would_delete) && RES.deleted.memberships === 4 && RES.deleted_total === PRE.would_delete_total + 4
      && RES.mock_channels_disabled === 1 && RES.reset.org_counters >= 4 && RES.environment === 'production') || J(RES);
  });
  await check('every deleted table is empty for A; the guards are enabled again', async () => {
    const tables = (await one(`SELECT app.convert_delete_tables() t`)).t;
    const left = [];
    for (const t of tables) { const n = await num(`SELECT count(*) n FROM ${t} WHERE org_id = $1`, [A]); if (n) left.push(t + ':' + n); }
    const off = await num(`SELECT count(*) n FROM unnest(app.convert_delete_guards()) g JOIN pg_trigger t ON t.tgrelid = split_part(g, ':', 1)::regclass
                             AND t.tgname = split_part(g, ':', 2) WHERE t.tgenabled <> 'O'`);
    return (left.length === 0 && off === 0) || J({ left, off });
  });
  await check('kept unchanged: branches, the live mail channel (cursor kept), accounting link, AI settings, stage sets, storage-gate ports, service items, subscription …', async () => {
    const changed = [];
    for (const t of keepTables) {
      const h = await hashOf(`SELECT * FROM ${t} WHERE org_id = $1 ${t === 'public.msg_channels' ? "AND mode <> 'mock'" : ''}`, [A]);
      if (h !== keepBefore[t]) changed.push(t);
    }
    const live = await one(`SELECT status, ingest_enabled, send_enabled, poll_cursor FROM public.msg_channels WHERE id = $1`, [D.live]);
    const mock = await one(`SELECT status, ingest_enabled, send_enabled FROM public.msg_channels WHERE id = $1`, [D.mock.id]);
    return (changed.length === 0 && live.status === 'connected' && live.ingest_enabled && live.poll_cursor === 'uid:4242'
      && mock.status === 'disabled' && !mock.ingest_enabled && !mock.send_enabled) || J({ changed, live, mock });
  });
  await check('memberships: only the owner\'s admin membership; the owner keeps working without a TOTP factor', async () => {
    const r = await q(`SELECT user_id::text u, role FROM public.memberships WHERE org_id = $1`, [A]);
    const f = await num(`SELECT count(*) n FROM auth.mfa_factors WHERE user_id = $1`, [U.owner]);
    const ctx = await tryErr(() => as('owner', `SELECT public.reconvert_org_preview($1) r`, [A]));
    return (J(r) === J([{ u: U.owner, role: 'admin' }]) && f === 0 && /permission denied/.test(ctx)) || J({ r, f });
  });
  await check('org row: new slug + prefix, names / settings / environment unchanged', async () => {
    const o = await one(`SELECT * FROM public.organizations WHERE id = $1`, [A]);
    return (o.slug === SLUG2 && o.ref_prefix === PFX2 && o.name_ar === orgBefore.name_ar && o.name_en === orgBefore.name_en && J(o.settings) === J(orgBefore.settings)
      && o.environment === 'production' && o.is_active === orgBefore.is_active) || J(o);
  });
  await check('ready: ok, no blockers, no TOTP item (mfa_required false); counters of A gone; usage recounted to 0', async () => {
    const c = await num(`SELECT count(*) n FROM public.org_counters WHERE org_id = $1`, [A]);
    const u = await num(`SELECT coalesce(sum(value), 0) n FROM public.org_usage_counters WHERE org_id = $1 AND metric <> 'storage_bytes'`, [A]);
    return (RES.ready.ok === true && J(RES.ready.blockers) === '[]' && Array.isArray(RES.ready.todo) && RES.ready.mfa_required === false && !/totp/i.test(J(RES.ready))
      && RES.ready.next_transaction_ref === PFX2 + '-' + (await year()) + '-000001' && c === 0 && u === 0 && RES.health_check.ok) || J({ ready: RES.ready, c, u });
  });
  await check('app.org_conversions: 2 rows for A (convert, reconvert) with the summary; still append-only', async () => {
    const r = await q(`SELECT run_no, kind, from_slug, to_slug, summary ->> 'ref_prefix' p FROM app.org_conversions WHERE org_id = $1 ORDER BY run_no`, [A]);
    const u = await tryErr(() => q(`UPDATE app.org_conversions SET to_slug = 'x' WHERE org_id = $1`, [A]));
    const d = await tryErr(() => q(`DELETE FROM app.org_conversions WHERE org_id = $1`, [A]));
    return (J(r) === J([{ run_no: 1, kind: 'convert', from_slug: 'blue-sea', to_slug: OWNER_SLUG_1, p: null }, { run_no: 2, kind: 'reconvert', from_slug: OWNER_SLUG_1, to_slug: SLUG2, p: PFX2 }])
      && /MRS_APPEND_ONLY/.test(u) && /MRS_APPEND_ONLY/.test(d)) || J({ r, u, d });
  });
  await check('NOTHING outside A touched: every org-scoped table of B, every global table (auth, storage, platform, settings) identical', async () => {
    const b = diff(SB, await orgState(B)), g = diff(SG, await globalState());
    return (b.length + g.length === 0) || J({ b, g });
  });
  await check('ready.todo lists storage_objects_left:<org>/ while a file is left in A\'s folder (not a blocker); empty again once the folder is emptied', async () => {
    const t0 = (await one(`SELECT app.reconvert_ready($1) r`, [A])).r.todo;
    await q(`INSERT INTO storage.buckets (id, name) VALUES ('documents', 'documents') ON CONFLICT DO NOTHING`);
    const id = (await one(`INSERT INTO storage.objects (bucket_id, name) VALUES ('documents', $1) RETURNING id`, [A + '/zz-left.pdf'])).id;
    try {
      const r = (await one(`SELECT app.reconvert_ready($1) r`, [A])).r;
      return (J(t0) === '[]' && J(r.todo) === J(['storage_objects_left:' + A + '/']) && r.ok === true && J(r.blockers) === '[]') || J({ t0, r });
    } finally { await q(`DELETE FROM storage.objects WHERE id = $1`, [id]); }
  });
  await check('the deleted rows left their audit rows (A only); B\'s audit untouched', async () =>
    ((await num(`SELECT count(*) n FROM public.audit_log WHERE org_id = $1`, [A])) > auditB) || 'audit');
}

/* ================================================================== 7. numbering after */
async function secAfter(D) {
  section('7. after the run: every number of A restarts, B continues');
  await check('A transaction NEW-<year>-000001; contact MSG-<year>-000001; PAY-000001 / CUS-000001; B continues (PAY-000002, BBB-…-000002)', async () => {
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'accountant')`, [U.A_acc, A]);
    const a = await addOrgData({ org: A, br: JED, acc: 'A_acc', tag: 'NA' });
    const b = await addOrgData({ org: B, br: B_BR, acc: 'B_acc', tag: 'NB' });
    const m = await rpc('anon', `SELECT public.submit_contact_message($1) r`, [{ orgSlug: SLUG2, name: 'زائر', phone: '0126100002', email: 'w@example.com',
      subject: 'quote', message: 'رسالة اختبار طويلة بما يكفي للتحقق', consent: true, antispam: { hp: '', elapsedMs: 4000 } }]);
    const y = await year();
    return (a.tx.ref === PFX2 + '-' + y + '-000001' && a.pay.ref === 'PAY-000001' && a.cus.ref === 'CUS-000001' && m.ref === 'MSG-' + y + '-000001'
      && b.pay.ref === 'PAY-000002' && b.cus.ref === 'CUS-000002' && b.tx.ref === 'BBB-' + y + '-000002') || J({ a: [a.tx.ref, a.pay.ref, a.cus.ref], m: m.ref, b: [b.tx.ref, b.pay.ref, b.cus.ref] });
  });
  await check('the old slug no longer reaches A (public intake by slug)', async () => {
    const r = await tryErr(() => rpc('anon', `SELECT public.submit_contact_message($1) r`, [{ orgSlug: OWNER_SLUG_1, name: 'زائر', phone: '0126100003', email: 'z@example.com',
      subject: 'quote', message: 'رسالة اختبار طويلة بما يكفي للتحقق', consent: true, antispam: { hp: '', elapsedMs: 4000 } }]));
    return r !== 'ok' || 'old slug still accepted';
  });
  await check('a second re-conversion: NEW and MRS are now "used"; ABC runs (run 3) with new names; history keeps all three runs', async () => {
    const e1 = await tryErr(() => run(A, 'marsa-3', 'NEW', phrase(SLUG2, 'marsa-3', 'NEW')));
    const e2 = await tryErr(() => run(A, 'marsa-3', 'MRS', phrase(SLUG2, 'marsa-3', 'MRS')));
    const p = await preview(A, 'marsa-3', 'ABC');
    const e3 = await tryErr(() => run(A, 'marsa-3', 'ABC', phrase(OWNER_SLUG_1, 'marsa-3', 'ABC')));   // the slug before the last run
    const r = await run(A, 'marsa-3', 'ABC', phrase(SLUG2, 'marsa-3', 'ABC'), 'مؤسسة البحر الأزرق للتخليص', 'Blue Sea Customs');
    const o = await one(`SELECT slug, ref_prefix, name_ar, name_en FROM public.organizations WHERE id = $1`, [A]);
    const h = await q(`SELECT run_no, kind FROM app.org_conversions WHERE org_id = $1 ORDER BY run_no`, [A]);
    return (/ref_prefix_used/.test(e1) && /ref_prefix_used/.test(e2) && /MRS_INVALID confirm/.test(e3) && p.confirm_phrase === phrase(SLUG2, 'marsa-3', 'ABC')
      && J(p.used_prefixes) === J(['MRS', 'NEW']) && r.run_no === 3
      && r.deleted.transactions === 1 && r.deleted.client_disbursements === 1 && r.deleted.memberships === 1
      && J(o) === J({ slug: 'marsa-3', ref_prefix: 'ABC', name_ar: 'مؤسسة البحر الأزرق للتخليص', name_en: 'Blue Sea Customs' })
      && J(h.map(x => x.run_no + x.kind)) === J(['1convert', '2reconvert', '3reconvert'])) || J({ e1, e2, e3, r, o, h });
  });
}

/* ================================================================== 8. mail transaction reference */
async function secMail() {
  section('8. mail: the transaction reference of any org prefix (SQL review + the two extractors)');
  await check('app.msg_tx_ref_ok: NEW / MRS / ABCDE accepted; REQ- / MSG- / IMP-, 1 or 6 letters, short numbers, lower case refused', async () => {
    const vals = ['NEW-2026-000001', 'MRS-2026-000123', 'ABCDE-2027-999999', 'AB-2026-000001', 'REQ-2026-000001', 'MSG-2026-000001', 'IMP-2026-000001',
      'A-2026-000001', 'ABCDEF-2026-000001', 'NEW-2026-00001', 'new-2026-000001', 'NEW2026000001', null];
    const r = await q(`SELECT x, app.msg_tx_ref_ok(x) ok FROM unnest($1::text[]) WITH ORDINALITY u(x, i) ORDER BY i`, [vals]);
    return J(r.map(x => x.ok)) === J([true, true, true, true, false, false, false, false, false, false, false, false, false]) || J(r);
  });
  await check('review_msg_extraction uses it (no hard-coded ^MRS-); its other checks unchanged', async () => {
    const s = (await one(`SELECT prosrc s FROM pg_proc WHERE proname = 'review_msg_extraction'`)).s;
    return (/app\.msg_tx_ref_ok\(v_val\)/.test(s) && !/MRS-\[0-9\]/.test(s) && /app\.msg_iso6346_ok\(v_val\)/.test(s) && /\^\[A-Z0-9\/-\]\{3,40\}\$/.test(s)) || 'body';
  });
  const AI = require(path.join(FN, 'ai-mock.js'));
  const RULE = AI.createRuleProvider({ clock: () => '2026-11-02T09:00:00.000Z' });
  await check('rule extractor (ai-mock.js): finds NEW- / MRS- / ABCDE- references; skips REQ- / MSG- / IMP- and 6-letter / glued prefixes', () => {
    const text = 'Our ref NEW-2026-000001 (old MRS-2026-000123), also ABCDE-2026-000777. Request REQ-2026-000005, MSG-2026-000002, IMP-2026-000003, ' +
      'bad XABCDEF-2026-000001 and ZZNEW-2026-0000011.';
    const got = RULE.extract(text, { source: 'body' }).filter(e => e.kind === 'tx_ref').map(e => e.normalized);
    return J(got) === J(['NEW-2026-000001', 'MRS-2026-000123', 'ABCDE-2026-000777']) || J(got);
  });
  await check('model extractor (llm-provider.js): a model tx_ref with any 2–5 letter prefix present in the text is kept; REQ- / invented ones dropped', async () => {
    const AD = require(path.join(FN, 'adapters.js'));
    const PL = require(path.join(FN, 'pipeline.js'));
    const LP = require(path.join(FN, 'llm-provider.js'));
    const DEPS = Object.assign({}, AD, AI, PL, LP);
    const text = 'Please see transaction  NEW-2026-000042 and request REQ-2026-000009';
    const it = (raw, normalized) => ({ kind: 'tx_ref', raw, normalized, ambiguous: false, deadline_phrase: false, appointment_phrase: false });
    const callModel = async () => ({ json: { items: [it('NEW-2026-000042', 'NEW-2026-000042'), it('REQ-2026-000009', 'REQ-2026-000009'), it('QQQ-2026-000001', 'QQQ-2026-000001')] },
      stop_reason: 'end_turn', model: 'claude-opus-5-5', fallback_ran: false, usage: { input_tokens: 100, output_tokens: 50 } });
    const P = AD.createLlmProvider({ impl: LP.createModelProvider, callModel, deps: DEPS, clock: () => '2026-11-02T09:00:00.000Z',
      settings: { ai_provider: 'claude', default_lang: 'ar', ai_monthly_budget_usd: 50, month_to_date_usd: 0 } });
    const ex = await P.extract(text, { source: 'body' });
    const refs = ex.filter(e => e.kind === 'tx_ref').map(e => e.normalized);
    return J(refs) === J(['NEW-2026-000042']) || J(refs);
  });
}

/* ================================================================== 9. SIDE: a staging org takes the first conversion */
async function secSide() {
  section('9. SIDE: a staging org is refused (not_production) — it uses convert_org_to_production');
  const d = await freshDb({ seed: true });
  try {
    await withDb(d, async () => {
      await addUsers([['owner', 'owner@reconvert.example.com']]);
      await q(`INSERT INTO public.platform_admins (user_id, note) VALUES ($1, 'owner')`, [U.owner]);
      await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'admin')`, [U.owner, A]);
      const before = await orgState(A);
      const r = await tryErr(() => run(A, SLUG2, PFX2, phrase('blue-sea', SLUG2, PFX2)));
      const p = await preview(A, SLUG2, PFX2);
      await check('refused MRS_FORBIDDEN not_production (+ never_converted); preview lists both; nothing changed', async () =>
        (/MRS_FORBIDDEN not_production never_converted/.test(r) && J(p.blockers) === J(['not_production', 'never_converted']) && diff(before, await orgState(A)).length === 0) || J({ r, b: p.blockers }));
    });
  } finally { await d.close(); }
}

/* ================================================================== main */
async function main() {
  console.log('Marsa — re-conversion (20261211000100) tests (PGlite; local only)');
  await secFiles();
  await secFresh();
  MAINDB = await freshDb({ seed: true });
  db = MAINDB;
  try {
    const D = await build();
    await secRefusals();
    await secPreview();
    await secRun(D);
    await secAfter(D);
    await secMail();
  } catch (e) { if (!/^aborted at:/.test(e.message)) fail('main', errText(e)); else console.log(e.message); }
  finally { await MAINDB.close(); }
  await secSide();
  await check('no network call was made', () => fetchCalls === 0 || 'fetch called ' + fetchCalls + ' times');
  console.log('\n' + nPass + ' passed, ' + nFail + ' failed');
  if (nFail) { console.log('\nFailures:\n  ' + fails.join('\n  ')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
