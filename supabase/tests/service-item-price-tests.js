#!/usr/bin/env node
/*
  Marsa (مرسى) — owner stage 3ب: migration 20261205000100_service_item_price.sql (the opening draft invoice's customs
  clearance line at a set price, 500 SAR by default).
  LOCAL TESTS ONLY. PGlite (in-memory Postgres), no network.
  One database: shim → every migration → seed.sql → fixtures (org A = seed "blue-sea", org B).

  Covers: file conventions + all_migrations.sql (appended verbatim, last, paste note); preflight refusal; re-run on itself
  (identical catalog, a changed price kept); org_service_items.default_price (column, 0 … 1 000 000 check, NULL allowed);
  customs_clearance at 500 for the seed orgs (seeded after the migrations, through the re-created trigger) and for an org
  that existed before the migration (the UPDATE), other items without a price; a manual item is not priced by the trigger;
  app.opening_unit_price (catalogue price of item:<code>, 0 for an unknown / inactive / non-item key, per org; not callable
  by authenticated / anon); RLS of the price (admin / accounts manager update, clearance staff / anon cannot, other org
  cannot); app.bill_job_context and public.test_daftra_custom_fields read the price (no zero opening line left in the
  live functions), and the job context of an opening intent carries opening_line.unit_price = 500 (VAT 15).

  usage:
    node supabase/tests/service-item-price-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261205000100_service_item_price.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in service-item-price-tests'); };

const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const B = 'deca0000-0000-4000-8000-0000000000c0';           // second org (fixture)
const JED = '0b5e0000-0000-4000-8000-000000000011';
const CLIENT_A = '0b5e0000-0000-4000-8000-000000000101';
const U = {
  admin: 'deca0000-0000-4000-8000-000000000011',    // admin of A
  acct: 'deca0000-0000-4000-8000-000000000012',     // accounts_manager of A
  jed: 'deca0000-0000-4000-8000-000000000013',      // clearance_staff of A, JED only
  staffB: 'deca0000-0000-4000-8000-000000000014'    // admin of B
};

let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else {
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
    const x = m.match(/violates check constraint "([^"]+)"/); if (x) return 'chk:' + x[1];
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
async function catalog() {
  const fns = await q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' sig,
                              md5(p.prosrc) h, coalesce(p.proacl::text, '') acl, p.prosecdef d
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app','public') ORDER BY 1`);
  const cols = (await q(`SELECT table_name || '.' || column_name x FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`)).map(x => x.x);
  const cons = (await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'public.org_service_items'::regclass ORDER BY 1`)).map(x => x.conname);
  return { fns, cols, cons };
}
const price = async (org, codeName) => {
  const r = await one(`SELECT default_price p FROM public.org_service_items WHERE org_id = $1 AND code = $2`, [org, codeName]);
  return r ? (r.p === null ? null : Number(r.p)) : 'missing';
};
const FIXTURES = `
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    ('${U.admin}', 'admin@price.example.com', now()), ('${U.acct}', 'acct@price.example.com', now()),
    ('${U.jed}', 'jed@price.example.com', now()), ('${U.staffB}', 'staffb@price.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'admin'), ('${U.acct}', 'acct'), ('${U.jed}', 'jed'), ('${U.staffB}', 'staffB')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, slug, name_ar, name_en, ref_prefix, environment)
    VALUES ('${B}', 'price-org-b', 'مؤسسة ب', 'Price org B', 'PRB', 'staging') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
    ('${U.admin}', '${A}', NULL, 'admin'), ('${U.acct}', '${A}', NULL, 'accounts_manager'),
    ('${U.jed}', '${A}', '${JED}', 'clearance_staff'), ('${U.staffB}', '${B}', NULL, 'admin');
`;

/* ------------------------------------------------------------------ 1. file */
async function secFile() {
  section('1. file + all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: preflight on 20261204000100, schema_versions row, no BEGIN/COMMIT, down-path, re-create notes', () =>
    (/version = '20261204000100'/.test(s) && /VALUES \('20261205000100', 'service_item_price'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s)
      && /Down-path:/.test(s) && /Re-pasting 20261123000100 after this file/.test(s)) || 'conventions');
  await check('only the opening line changed in the two re-created bodies (one 0 → the catalogue price each)', () => {
    const src = fs.readFileSync(path.join(MIG_DIR, '20261123000100_legacy_daftra.sql'), 'utf8');
    const body = (txt, start) => { const i = txt.indexOf(start); return txt.slice(i, txt.indexOf('END $$;', i)); };
    const norm = t => t.replace(/\s+/g, ' ');
    const o1 = body(src, 'CREATE OR REPLACE FUNCTION app.bill_job_context('), n1 = body(s, 'CREATE OR REPLACE FUNCTION app.bill_job_context(');
    const o2 = body(src, 'CREATE OR REPLACE FUNCTION public.test_daftra_custom_fields('), n2 = body(s, 'CREATE OR REPLACE FUNCTION public.test_daftra_custom_fields(');
    const back1 = norm(n1.replace(/ *-- 20261205000100[^\n]*\n/, '').replace(/'quantity', 1,\s+'unit_price', app\.opening_unit_price\(v_i\.org_id, v_conn ->> 'opening_item'\),/, "'quantity', 1, 'unit_price', 0,"));
    const back2 = norm(n2.replace(/'quantity', 1,\s+'unit_price', app\.opening_unit_price\(v_t\.org_id, coalesce\(v_conn\.opening_item, 'item:customs_clearance'\)\)\),\s+-- 20261205000100/, "'quantity', 1, 'unit_price', 0),"));
    return (back1 === norm(o1) && back2 === norm(o2)) || 'bodies differ beyond the opening line';
  });
  const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
  await check('all_migrations.sql: appended verbatim under its header, last; the paste note names it', () => {
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    return (i > 0 && all.slice(i + h.length) === s && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles()))
      || 'not appended verbatim / no note / order';
  });
  await check('this file is the latest migration', () => migFiles().pop() === MIG || 'latest ' + migFiles().pop());
}

/* ------------------------------------------------------------------ 2. preflight + re-run + existing orgs */
async function secRerun() {
  section('2. preflight, an org that existed before, re-run');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  db = await freshDb(MIG);
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await check('preflight: refuses without tx_stage_sets (20261204000100)', async () => {
    await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261204000100'`);
    let msg = '';
    try { await db.exec(s); } catch (e) { msg = e.message; }
    await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261204000100', 'tx_stage_sets')`);
    return /SERVICE ITEM PRICE preflight: apply tx_stage_sets first/.test(msg) || msg;
  });
  await db.exec(s);
  await check('an org that existed before the migration: customs_clearance = 500 (the UPDATE), other items stay without a price', async () =>
    (await price(A, 'customs_clearance')) === 500 && (await price(A, 'port_charges')) === null || J([await price(A, 'customs_clearance'), await price(A, 'port_charges')]));
  await q(`UPDATE public.org_service_items SET default_price = 650 WHERE org_id = $1 AND code = 'customs_clearance'`, [A]);
  const c1 = await catalog();
  await db.exec(s);
  const c2 = await catalog();
  await check('re-run on itself: identical catalog (functions, columns, constraints)', () => J(c1) === J(c2) || 'catalog changed');
  await check('re-run keeps a price the org changed (650 stays)', async () => (await price(A, 'customs_clearance')) === 650 || String(await price(A, 'customs_clearance')));
  await db.close();
}

/* ------------------------------------------------------------------ 3. defaults + function + RLS */
async function secMain() {
  section('3. defaults, opening_unit_price, RLS');
  await check('seed orgs (created after the migrations): customs_clearance = 500 through the trigger', async () =>
    (await price(A, 'customs_clearance')) === 500 && (await price(B, 'customs_clearance')) === 500 || J([await price(A, 'customs_clearance'), await price(B, 'customs_clearance')]));
  await check('the column: 0 … 1 000 000, NULL allowed', async () => {
    const neg = await code(() => q(`UPDATE public.org_service_items SET default_price = -1 WHERE org_id = $1 AND code = 'customs_clearance'`, [A]));
    const big = await code(() => q(`UPDATE public.org_service_items SET default_price = 1000000.01 WHERE org_id = $1 AND code = 'customs_clearance'`, [A]));
    const nul = await code(() => q(`UPDATE public.org_service_items SET default_price = NULL WHERE org_id = $1 AND code = 'port_charges'`, [A]));
    return (neg === 'chk:org_service_items_default_price_check' && big === 'chk:org_service_items_default_price_check' && nul === 'ok') || J([neg, big, nul]);
  });
  await check('a manual item named customs_clearance in a new org is not priced by the trigger (template rows only)', async () => {
    const C = 'deca0000-0000-4000-8000-0000000000c9';
    await q(`INSERT INTO public.organizations (id, slug, name_ar, ref_prefix, environment) VALUES ($1, 'price-org-c', 'مؤسسة ج', 'PRC', 'staging')`, [C]);
    const seeded = await price(C, 'customs_clearance');
    await q(`INSERT INTO public.org_service_items (org_id, code, name_ar, source) VALUES ($1, 'manual_fee', 'رسوم يدوية', 'manual')`, [C]);
    return (seeded === 500 && (await price(C, 'manual_fee')) === null) || J([seeded, await price(C, 'manual_fee')]);
  });
  await check('app.opening_unit_price: item:<code> → the price; unknown / non-item / inactive → 0; per org', async () => {
    await q(`UPDATE public.org_service_items SET default_price = 480 WHERE org_id = $1 AND code = 'customs_clearance'`, [B]);
    await q(`UPDATE public.org_service_items SET default_price = 70 WHERE org_id = $1 AND code = 'port_charges'`, [A]);
    const r = await one(`SELECT app.opening_unit_price($1, 'item:customs_clearance') a, app.opening_unit_price($2, 'item:customs_clearance') b,
                                app.opening_unit_price($1, 'item:nope') c, app.opening_unit_price($1, 'service:customs_clearance') d,
                                app.opening_unit_price($1, 'item:port_charges') e, app.opening_unit_price($1, NULL) f`, [A, B]);
    await q(`UPDATE public.org_service_items SET is_active = false WHERE org_id = $1 AND code = 'port_charges'`, [A]);
    const g = (await one(`SELECT app.opening_unit_price($1, 'item:port_charges') g`, [A])).g;
    await q(`UPDATE public.org_service_items SET is_active = true WHERE org_id = $1 AND code = 'port_charges'`, [A]);
    const got = [r.a, r.b, r.c, r.d, r.e, r.f, g].map(Number);
    return J(got) === J([500, 480, 0, 0, 70, 0, 0]) || J(got);
  });
  await check('app.opening_unit_price is not callable by authenticated / anon', async () => {
    const a = await code(() => as('admin', `SELECT app.opening_unit_price($1, 'item:customs_clearance')`, [A]));
    const b = await code(() => as('anon', `SELECT app.opening_unit_price($1, 'item:customs_clearance')`, [A]));
    return (a === 'perm' && b === 'perm') || J([a, b]);
  });
  await check('RLS: the admin and the accounts manager change the price; clearance staff cannot; another org cannot; anon cannot read', async () => {
    const ad = await as('admin', `UPDATE public.org_service_items SET default_price = 520 WHERE org_id = $1 AND code = 'customs_clearance' RETURNING default_price`, [A]);
    const ac = await as('acct', `UPDATE public.org_service_items SET default_price = 510 WHERE org_id = $1 AND code = 'customs_clearance' RETURNING default_price`, [A]);
    const st = await as('jed', `UPDATE public.org_service_items SET default_price = 1 WHERE org_id = $1 AND code = 'customs_clearance' RETURNING default_price`, [A]);
    const ob = await as('staffB', `UPDATE public.org_service_items SET default_price = 2 WHERE org_id = $1 AND code = 'customs_clearance' RETURNING default_price`, [A]);
    const an = await code(() => as('anon', `SELECT default_price FROM public.org_service_items LIMIT 1`));
    const seen = await as('jed', `SELECT default_price FROM public.org_service_items WHERE org_id = $1 AND code = 'customs_clearance'`, [A]);
    return (ad.length === 1 && ac.length === 1 && st.length === 0 && ob.length === 0 && an === 'perm' && Number(seen[0].default_price) === 510
      && (await price(A, 'customs_clearance')) === 510) || J({ ad, ac, st, ob, an, seen });
  });
  await check('the price change is audited (app.tg_audit on org_service_items)', async () => {
    const r = await q(`SELECT count(*)::int n FROM public.audit_log WHERE table_name = 'org_service_items' AND action = 'UPDATE'`).catch(() => [{ n: -1 }]);
    return r[0].n > 0 || 'audit rows ' + r[0].n;
  });
  await check('live functions: bill_job_context / test_daftra_custom_fields call opening_unit_price; no zero opening line left', async () => {
    const r = await q(`SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE (n.nspname, p.proname) IN (('app','bill_job_context'), ('public','test_daftra_custom_fields'))`);
    return (r.length === 2 && r.every(x => /app\.opening_unit_price\(/.test(x.prosrc) && !/'quantity', 1, 'unit_price', 0/.test(x.prosrc))) || J(r.map(x => x.proname));
  });
  await check('job context of an opening intent: opening_line.unit_price = the catalogue price (510), VAT 15', async () => {
    const tx = (await as('jed', `INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode) VALUES ($1, $2, $3, 'import', 'sea') RETURNING id`,
      [A, JED, CLIENT_A]))[0].id;
    const ref = (await one(`SELECT ref FROM public.transactions WHERE id = $1`, [tx])).ref;
    const it = (await q(`INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose, purpose_key, currency, revision, operational_ref, origin)
                         VALUES ($1, $2, $3, 'final', 'F', 'SAR', 1, $4, 'opening') RETURNING id`, [A, tx, CLIENT_A, ref]))[0].id;
    const job = (await q(`INSERT INTO public.billing_sync_jobs (org_id, kind, intent_id, dedupe_key) VALUES ($1, 'invoice_push', $2, $3) RETURNING *`, [A, it, 'test-opening-' + it]))[0];
    const ctx = (await one(`SELECT app.bill_job_context(j, gen_random_uuid(), NULL) c FROM public.billing_sync_jobs j WHERE j.id = $1`, [job.id])).c;
    const ol = ctx && ctx.intent && ctx.intent.opening_line;
    return (ol && Number(ol.unit_price) === 510 && Number(ol.vat_rate) === 15 && ol.quantity === 1 && ol.item_key === 'item:customs_clearance') || J(ol);
  });
}

/* ------------------------------------------------------------------ 4. the settings card (static) */
async function secUi() {
  section('4. «رسوم التخليص الافتراضية» in the organisation settings');
  const ad = fs.readFileSync(path.join(ROOT, 'assets/js/admin.js'), 'utf8'), su = fs.readFileSync(path.join(ROOT, 'assets/js/supa.js'), 'utf8');
  const ia = fs.readFileSync(path.join(ROOT, 'assets/i18n/admin.js'), 'utf8');
  await check('supa.js: getServiceItemPrice (one item by code, default_price) / setServiceItemPrice (update default_price) exported', () =>
    /function getServiceItemPrice\(f\)/.test(su) && /select\('id,code,name_ar,name_en,default_price'\)\.eq\('org_id', oid\)\.eq\('code'/.test(su)
    && /update\(\{ default_price: price \}\)/.test(su) && /getServiceItemPrice: getServiceItemPrice, setServiceItemPrice: setServiceItemPrice/.test(su)
    && !/select\('id,code,name_ar,name_en,fin_service,sort,is_active,default_price'/.test(su) || 'api (listServiceItems must not ask for the new column)');
  await check('admin.js: the card after the logo, before the AI card; text field with 0-9 (lang en), Arabic-Indic digits accepted; admin / accounts manager edit', () =>
    /return clearancePriceCard\(\)\.then\(function \(pc\) \{ if \(pc\) out\.appendChild\(pc\); \}\)\.then\(function \(\) \{\s+return aiSettingsCard\(\)\.then/.test(ad)
    && /id: 'adg-clearance-price', type: 'text'[^\n]*lang: 'en'/.test(ad) && /replace\(\/\[٠-٩\]\/g/.test(ad)
    && /m\.role === 'admin' \|\| m\.role === 'accounts_manager'\) && !m\.branch_id/.test(ad) || 'card');
  await check('admin.js: before the migration (no column) the card shows «price_not_ready» instead of failing the page', () =>
    /var missing = \/default_price\/\.test\(String\(r\.error\.message \|\| ''\)\) \|\| r\.error\.code === '42703';/.test(ad) && /t\('price_not_ready'\)/.test(ad) || 'not ready');
  await check('i18n/admin.js: price_* labels in Arabic and English', () =>
    ['price_title', 'price_label', 'price_hint', 'price_saved', 'price_invalid', 'price_read_only', 'price_no_item', 'price_not_ready']
      .every(k => ia.split('\n').filter(l => l.indexOf(k + ': \'') !== -1).length === 2) || 'labels');
}

/* ================================================================== main */
(async () => {
  console.log('Marsa — service item price (3ب) SQL tests (PGlite; local only)');
  await secFile();
  await secRerun();
  section('load shim + migrations + seed + fixtures');
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(SUPA, 'seed.sql'), 'utf8'));
  await db.exec(FIXTURES);
  await secMain();
  await secUi();
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
