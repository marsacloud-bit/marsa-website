#!/usr/bin/env node
/*
  Marsa (مرسى) — G7 step ٢: a second, independent organization with NO code change
  (docs/online/G7_SPEC.md § Tests "g7-second-org-tests.js"). LOCAL TESTS ONLY.
  Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network, no Daftra, no mailbox, no keys.

  Org A = seed "blue-sea" (prefix MRS). Org B = synthetic «مؤسسة تجريبية ب» (slug org-g7b, prefix TSB), built ONLY
  through RPCs (platform_create_org → accept_invitation → admin_create_branch → admin_invite / accept_invitation …,
  save_daftra_connection mock, save_msg_channel mock, platform_set_org_plan basic) plus seed-style SQL for the auth users
  (auth.users rows = what Supabase Auth sign-up creates). The suite adds no DDL; no code path knows B's id.

  Proofs:
    1. catalog fingerprint (functions, policies, triggers, tables / columns) identical before / after creating B
    2. static scan: no file under assets/js, supabase/functions, supabase/migrations names the seed org id or slug,
       except the listed legacy public-intake defaults (reported, never silently skipped)
    3. the full cycle (lib/g7-cycle.js) runs in BOTH orgs interleaved (A step, B step, …); after every step the OTHER
       org's state hash (count + md5 of every tenant table filtered by org) is unchanged
    4. MRS-… vs TSB-… numbering independent; Daftra mocks and mailboxes separate; A's channel address refused for B
       without naming A; B's plan limits refuse B only

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g7-second-org-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const G7_MIGRATION = '20261108000100_g7_subscriptions.sql';

// No network anywhere: any fetch is a test failure (the workers are given no fetch).
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g7-second-org-tests'); };

const L = require(path.join(SUPA, 'tests', 'lib', 'g7-cycle.js'));

/* ------------------------------------------------------------------ helper block (g6b-cycle-tests.js) */
let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e) + (e && e.stack && !QUIET ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : '')); }
}
const J = x => JSON.stringify(x);

/* ------------------------------------------------------------------ ids (prefix c7b0…) */
const A = '0b5e0000-0000-4000-8000-000000000001';
const JED = '0b5e0000-0000-4000-8000-000000000011';
const DMM = '0b5e0000-0000-4000-8000-000000000012';
const U = {
  P: 'c7b00000-0000-4000-8000-0000000000f1',
  A_admin: 'c7b00000-0000-4000-8000-000000000001', A_ops: 'c7b00000-0000-4000-8000-000000000002', A_clr: 'c7b00000-0000-4000-8000-000000000003',
  A_trn: 'c7b00000-0000-4000-8000-000000000004', A_acc: 'c7b00000-0000-4000-8000-000000000005', A_mgr: 'c7b00000-0000-4000-8000-000000000006',
  A_bm: 'c7b00000-0000-4000-8000-000000000007', A_client: 'c7b00000-0000-4000-8000-000000000008',
  B_admin: 'c7b00000-0000-4000-8000-000000000011', B_ops: 'c7b00000-0000-4000-8000-000000000012', B_clr: 'c7b00000-0000-4000-8000-000000000013',
  B_trn: 'c7b00000-0000-4000-8000-000000000014', B_acc: 'c7b00000-0000-4000-8000-000000000015', B_mgr: 'c7b00000-0000-4000-8000-000000000016',
  B_bm: 'c7b00000-0000-4000-8000-000000000017', B_client: 'c7b00000-0000-4000-8000-000000000018', B_extra: 'c7b00000-0000-4000-8000-000000000019'
};
const EMAIL = k => k.toLowerCase().replace('_', '.') + '@g7second.example.com';
let keySeq = 0;
const newKey = () => `c7b0e000-0000-4000-8000-${(++keySeq).toString(16).padStart(12, '0')}`;

let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function asService(fn) {
  await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
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
  catch (e) { fail(name, errText(e)); throw new Error('cycle aborted at: ' + name); }
}
async function runFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await db.exec(sql); console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @pos ' + e.position : '')); return false; }
}
const H = { q, one, num, rpc, as, asService, step, check, expectErr, pass, fail, section, errText, J, newKey, users: U };

/* ================================================================== org contexts */
const ORG_A = {
  key: 'A', id: A, slug: 'blue-sea', prefix: 'MRS', br1: JED, br2: DMM, tag: 'a7b',
  users: { admin: 'A_admin', ops: 'A_ops', clr: 'A_clr', trn: 'A_trn', acc: 'A_acc', mgr: 'A_mgr', bm: 'A_bm', client: 'A_client' },
  email: 'inbox@g7-a-second.example', wa: '0500000711', waNorm: '+966500000711', phone: '0501117101', vat: '300000000710003', cr: '7000000711',
  bl: 'MEDUA7B0001', containers: [L.isoContainer('MSCU', 710001), L.isoContainer('MSCU', 710002)],
  attachClient: async (clientId) => {
    await q(`INSERT INTO public.client_users (org_id, client_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [A, clientId, U.A_client]);
    await q(`INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES ($1, $2, NULL, 'client')`, [U.A_client, A]);
  },
  d: {}
};
// org B: ids are learned from the RPC results (no code path knows them in advance)
const ORG_B = {
  key: 'B', id: null, slug: 'org-g7b', prefix: 'TSB', br1: null, br2: null, tag: 'b7b',
  users: { admin: 'B_admin', ops: 'B_ops', clr: 'B_clr', trn: 'B_trn', acc: 'B_acc', mgr: 'B_mgr', bm: 'B_bm', client: 'B_client' },
  email: 'inbox@org-g7b.example', wa: '0500000722', waNorm: '+966500000722', phone: '0501117202', vat: '300000000720003', cr: '7000000722',
  // the SAME B/L and container numbers as org A: numbers are unique per org, never across orgs
  bl: 'MEDUA7B0001', containers: [L.isoContainer('MSCU', 710001), L.isoContainer('MSCU', 710002)],
  attachClient: async (clientId) => {
    const inv = await rpc('B_admin', `SELECT public.admin_invite($1, $2) r`, [ORG_B.id, { email: EMAIL('B_client'), role: 'client', client_id: clientId, idempotencyKey: newKey() }]);
    const acc = await rpc('B_client', `SELECT public.accept_invitation($1) r`, [inv.token]);
    if (acc.org_id !== ORG_B.id || acc.role !== 'client') throw new Error('client accept ' + J(acc));
  },
  d: {}
};

/* ================================================================== fixtures (auth users = sign-up rows; A memberships seed-style) */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${EMAIL(k)}', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.platform_admins (user_id, note) VALUES ('${U.P}', 'G7 test operator');
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.A_admin}', '${A}', NULL, 'admin'), ('${U.A_ops}', '${A}', NULL, 'operations_manager'), ('${U.A_clr}', '${A}', '${JED}', 'clearance_staff'),
      ('${U.A_trn}', '${A}', '${JED}', 'transport_staff'), ('${U.A_acc}', '${A}', NULL, 'accountant'), ('${U.A_mgr}', '${A}', NULL, 'accounts_manager'),
      ('${U.A_bm}', '${A}', '${JED}', 'branch_manager');
  `);
  return one(`SELECT app.seed_document_requirements($1) n`, [A]);
}

/* ================================================================== B creation through RPCs only */
async function createOrgB() {
  section('2. org B «مؤسسة تجريبية ب» through RPCs only');
  await L.createOrgViaRpcs(H, ORG_B, { platform: 'P', email: EMAIL, name_ar: 'مؤسسة تجريبية ب', name_en: 'Test Org B',
    branch1: { code: 'RUH', name_ar: 'فرع الرياض', name_en: 'Riyadh branch', city: 'الرياض' }, branch2: { code: 'KHB', name_ar: 'فرع الخبر', name_en: 'Khobar branch', city: 'الخبر' } });
  await check('A: branch codes of A unchanged (B may use any code; A untouched)', async () =>
    (await num(`SELECT count(*) n FROM public.branches WHERE org_id = $1`, [A])) === 2);
}

/* ================================================================== interleaved cycle with cross-org hashes */
async function interleaved(W, tables) {
  section('4. full cycle in both orgs, interleaved (A step, B step); the other org\'s state hash unchanged after every step');
  const sa = L.cycleSteps(H, W, ORG_A), sb = L.cycleSteps(H, W, ORG_B);
  let crossBad = 0;
  for (let i = 0; i < sa.length; i++) {
    for (const [s, me, other] of [[sa[i], ORG_A, ORG_B], [sb[i], ORG_B, ORG_A]]) {
      const before = await L.stateHash(H, other.id, tables);
      await step(s.title, s.run);
      const after = await L.stateHash(H, other.id, tables);
      const diff = L.hashDiff(before, after);
      if (diff.length) crossBad++;
      await check(`  └ ${other.key} state hash unchanged by ${me.key}:${s.id} (${tables.length} tenant tables)`, () => diff.length === 0 || diff.join(', '));
    }
  }
  return crossBad;
}

/* ================================================================== main */
async function dbMain() {
  const { PGlite } = require('@electric-sql/pglite');
  db = new PGlite();
  section('load shim + migrations + seed (repo files only, no DDL added by this suite)');
  const migDir = path.join(SUPA, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!await runFile(path.join(SUPA, 'tests', 'shim.sql'))) return;
  for (const m of migFiles) if (!await runFile(path.join(migDir, m))) return;
  if (!await runFile(path.join(SUPA, 'seed.sql'))) return;
  try { const r = await fixtures(); r.n === 15 ? pass('fixtures: auth users (sign-up rows), platform admin, org A staff (seed-style)') : fail('fixtures', 'requirements ' + r.n); }
  catch (e) { fail('fixtures', errText(e)); return; }

  section('1. G7 objects present (subscriptions migration)');
  const g7 = migFiles.includes(G7_MIGRATION) && !!(await one(`SELECT to_regclass('public.org_subscriptions') t, to_regprocedure('public.platform_set_org_plan(uuid,jsonb,uuid)') p`).then(r => r.t && r.p));
  await check('G7 migration ' + G7_MIGRATION + ' loaded (org_subscriptions + platform_set_org_plan)', () => g7 || 'absent — plan-limit checks of this suite cannot run (DB agent deliverable)');

  const tables = await L.tenantTables(H);
  const fp0 = await L.catalogFingerprint(H);
  const hashA0 = await L.stateHash(H, A, tables);
  const W = L.createWorkers(H, ROOT);
  try {
    await createOrgB();
    section('3. setup of both orgs (Daftra mock, channels, directory) + plan basic for B');
    await L.setupOrg(H, W, ORG_A);
    const hashA1 = await L.stateHash(H, A, tables);
    await L.setupOrg(H, W, ORG_B);
    await check('A state hash unchanged by the whole B setup (after A\'s own setup)', async () => {
      const d = L.hashDiff(hashA1, await L.stateHash(H, A, tables)); return d.length === 0 || d.join(', ');
    });
    await check('A state hash: only A\'s own setup changed A (B creation touched nothing of A)', () => {
      const d = L.hashDiff(hashA0, hashA1);
      return d.every(x => /^(daftra_|msg_|parties|drivers|trucks|audit_log|billing_sync|idempotency_keys)/.test(x)) || d.join(', ');
    });
    await expectErr('A\'s channel address refused for B (MRS_INVALID address_taken)', () => rpc('B_admin', `SELECT public.save_msg_channel($1, $2, $3) r`,
      [ORG_B.id, { kind: 'email', name: 'نسخة', address: ORG_A.email.toUpperCase(), mode: 'mock' }, newKey()]), /MRS_INVALID.*address_taken/);
    await check('the address_taken refusal names nothing of A (no id, slug, name, prefix)', async () => {
      try { await rpc('B_admin', `SELECT public.save_msg_channel($1, $2, $3) r`, [ORG_B.id, { kind: 'email', name: 'نسخة', address: ORG_A.email, mode: 'mock' }, newKey()]); return 'accepted'; }
      catch (e) { const t = errText(e); return !/blue-sea|0b5e0000|البحر|Blue Sea|MRS-|g7-a-second/.test(t) || t; }
    });
    if (g7) {
      await step('platform admin: platform_set_org_plan B → basic (active, reason)', async () => {
        const r = await rpc('P', `SELECT public.platform_set_org_plan($1, $2, $3) r`, [ORG_B.id, { plan_code: 'basic', status: 'active', period_start: L.day(0), reason: 'خطة تجريبية للمؤسسة الثانية' }, newKey()]);
        if (!r.subscription || r.subscription.plan_code !== 'basic') throw new Error(J(r));
        ORG_B.d.planResult = r;
      });
      await check('B over its basic limits right after the switch (7 staff > 5, 2 branches > 1) — allowed, reported, nothing deleted', async () => {
        const ol = ORG_B.d.planResult.over_limit || [];
        const m = await num(`SELECT count(*) n FROM public.memberships WHERE org_id = $1 AND is_active`, [ORG_B.id]);
        return (ol.includes('users') && ol.includes('branches') && m === 7) || J({ ol, m });
      });
    }
    const fp1 = await L.catalogFingerprint(H);
    await check('"no code change" (a): catalog fingerprint identical before / after creating and configuring B (functions, policies, triggers, columns)', () =>
      J(fp0) === J(fp1) || J({ before: fp0, after: fp1 }));

    const crossBad = await interleaved(W, tables);
    await check('interleaved cycle: zero cross-org state changes over ' + (2 * L.cycleSteps(H, W, ORG_A).length) + ' steps', () => crossBad === 0 || crossBad + ' step(s) changed the other org');
    await afterCycle(W, g7);
  } catch (e) { fail('second-org run', errText(e)); }
}

async function afterCycle(W, g7) {
  section('5. numbering, Daftra mocks, mailboxes, plan limits');
  const a = ORG_A.d.cycle, b = ORG_B.d.cycle;
  await check('numbering independent: A transaction MRS-YYYY-…, B TSB-YYYY-000001 (B\'s first)', () =>
    (/^MRS-\d{4}-\d{6}$/.test(a.txRef) && /^TSB-\d{4}-000001$/.test(b.txRef) && a.txRef.slice(-6) !== '000001') || J([a.txRef, b.txRef]));
  await check('request refs: one sequence per org (B\'s first request is REQ-YYYY-000001 even though A already has that text)', async () => {
    const r = await q(`SELECT org_id, ref FROM public.service_requests WHERE ref = ANY ($1::text[]) ORDER BY org_id, ref`, [[a.reqRef, b.reqRef]]);
    const rb = r.filter(x => x.org_id === ORG_B.id);
    return (/^REQ-\d{4}-000001$/.test(b.reqRef) && rb.length === 1 && rb[0].ref === b.reqRef && r.some(x => x.org_id === A && x.ref === a.reqRef)) || J(r);
  });
  await check('public_track disambiguates equal request refs across orgs by the token (B ref + B token → B; B ref + A seed token → A seed row, never B)', async () => {
    const tb = await rpc('anon', `SELECT public.public_track($1, $2) r`, [b.reqRef, b.token]);
    const seedTok = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    let ta = null; try { ta = await rpc('anon', `SELECT public.public_track($1, $2) r`, [b.reqRef, seedTok]); } catch (e) { ta = { err: errText(e) }; }
    let bad = null; try { await rpc('anon', `SELECT public.public_track($1, $2) r`, [b.reqRef, 'ab'.repeat(32)]); bad = 'accepted'; } catch (e) { bad = /MRS_NOT_FOUND/.test(errText(e)) ? null : errText(e); }
    const tbs = J(tb), tas = J(ta);
    return (!bad && tbs.includes(b.txRef) && !tbs.includes(a.txRef) && !tas.includes(b.txRef)) || J({ tb, ta, bad });
  });
  await check('same B/L + container numbers in both orgs: one B/L row per org, containers per org', async () => {
    const r = await q(`SELECT org_id, count(*)::int n FROM public.bills_of_lading WHERE bl_number = $1 GROUP BY 1`, [ORG_A.bl]);
    return (r.length === 2 && r.every(x => x.n === 1)) || J(r);
  });
  await check('Daftra mocks separate: A mock holds no B client ref / reference, B mock none of A', () => {
    const sa = J(W.dmocks[A].control.state()), sb = J(W.dmocks[ORG_B.id].control.state());
    return (sa.includes(a.opRef) && sb.includes(b.opRef) && !sa.includes(b.client) && !sb.includes(a.client) && !sa.includes(b.opRef) && !sb.includes(a.opRef)) || 'mock state mixed';
  });
  await check('Daftra: every adapter call used the job org', () => (W.dUse.length > 0 && W.dUse.every(x => x.job_org === x.adapter_org)) || J(W.dUse.filter(x => x.job_org !== x.adapter_org)));
  await check('mock mailboxes separate: each mailbox delivered only its own org\'s inbound; messages stored under the channel org', async () => {
    const r = await q(`SELECT m.org_id, c.org_id corg FROM public.msg_messages m JOIN public.msg_channels c ON c.id = m.channel_id`);
    const aIn = ORG_A.d.ME.control.state().inbound.length, bIn = ORG_B.d.ME.control.state().inbound.length;
    return (r.length >= 2 && r.every(x => x.org_id === x.corg) && aIn === 1 && bIn === 1 && W.iUse.every(x => x.job_org === x.channel_org)) || J({ r, aIn, bIn });
  });
  await check('B worker contexts contain no A id (inbox)', () => {
    const bCtx = J(W.claimed.filter(c => c.job.org_id === ORG_B.id));
    return (bCtx.length > 2 && ![A, a.tx, JED, DMM, ORG_A.d.chE.id].some(id => bCtx.includes(id))) || 'leak';
  });
  await check('threads linked to their own org\'s transaction only', async () => {
    const r = await q(`SELECT t.org_id, x.org_id txorg FROM public.msg_threads t JOIN public.transactions x ON x.id = t.transaction_id`);
    return (r.length === 2 && r.every(z => z.org_id === z.txorg)) || J(r);
  });
  await check('B client portal user sees only B\'s transaction; A client only A\'s', async () => {
    const rb = await as('B_client', `SELECT org_id FROM public.transactions`), ra = await as('A_client', `SELECT org_id FROM public.transactions`);
    return (rb.length === 1 && rb[0].org_id === ORG_B.id && ra.length === 1 && ra[0].org_id === A) || J({ ra, rb });
  });
  await expectErr('B admin cannot read A reports (report_transactions on A)', () => rpc('B_admin', `SELECT public.report_transactions($1, '{}') r`, [A]), /MRS_FORBIDDEN|MRS_NOT_FOUND/);
  await expectErr('A admin cannot open B\'s billing intent', () => rpc('A_admin', `SELECT public.get_billing_intent($1) r`, [b.intent]), /MRS_FORBIDDEN|MRS_NOT_FOUND/);

  if (!g7) { fail('plan limits (B only)', 'G7 migration absent — skipped'); return; }
  const hashA = await L.stateHash(H, A, await L.tenantTables(H));
  await expectErr('B plan basic: a third branch refused (MRS_PLAN_LIMIT branches)', () => rpc('B_admin', `SELECT public.admin_create_branch($1, $2) r`,
    [ORG_B.id, { code: 'DMM', name_ar: 'فرع الدمام ب' }]), /MRS_PLAN_LIMIT[\s\S]*branches/);
  await expectErr('B plan basic: a new staff invitation refused (MRS_PLAN_LIMIT users)', () => rpc('B_admin', `SELECT public.admin_invite($1, $2) r`,
    [ORG_B.id, { email: EMAIL('B_extra'), role: 'accountant', idempotencyKey: newKey() }]), /MRS_PLAN_LIMIT[\s\S]*users/);
  await check('the refused B creates changed nothing of A', async () => { const d = L.hashDiff(hashA, await L.stateHash(H, A, await L.tenantTables(H))); return d.length === 0 || d.join(', '); });
  await check('A (pilot, unlimited) is not limited: A admin creates a third branch', async () => {
    const r = await rpc('A_admin', `SELECT public.admin_create_branch($1, $2) r`, [A, { code: 'RUH', name_ar: 'فرع الرياض أ' }]);
    return !!r.id || J(r);
  });
  await check('platform_list_subscriptions: A pilot (no over_limit), B basic over users + branches — counts only', async () => {
    const r = await rpc('P', `SELECT public.platform_list_subscriptions() r`);
    const ra = r.find(x => x.org_id === A), rb = r.find(x => x.org_id === ORG_B.id);
    const leak = [a.txRef, b.txRef, ORG_A.bl, 'مستورد', a.reqRef].filter(s => J(r).includes(s));
    return (ra.plan_code === 'pilot' && (ra.over_limit || []).length === 0 && rb.plan_code === 'basic' && rb.over_limit.includes('users') && rb.over_limit.includes('branches') &&
      leak.length === 0) || J({ ra: [ra.plan_code, ra.over_limit], rb: [rb.plan_code, rb.over_limit], leak });
  });
  await check('B usage counters: 1 transaction this month (counted by the trigger), A counter independent', async () => {
    const r = await q(`SELECT org_id, value FROM public.org_usage_counters WHERE metric = 'transactions_month' AND period_start = app.g7_period(now())`);
    const vb = r.find(x => x.org_id === ORG_B.id), va = r.find(x => x.org_id === A);
    const ta = await num(`SELECT count(*) n FROM public.transactions WHERE org_id = $1 AND app.g7_period(created_at) = app.g7_period(now())`, [A]);
    return (vb && Number(vb.value) === 1 && va && Number(va.value) === ta) || J({ r, ta });
  });
}

async function staticScan() {
  section('6. "no code change" (b): static scan for the seed org id / slug in assets/js, supabase/functions, supabase/migrations');
  const r = L.scanSeedOrg(ROOT, A, 'blue-sea');
  for (const k of r.known) console.log(`  known legacy default (reported): ${k.file}:${k.line} — ${k.why}`);
  await check('no code path names the seed org (id ' + A.slice(0, 8) + '… or slug blue-sea) except the listed public-intake defaults', () =>
    r.unknown.length === 0 || r.unknown.map(h => h.file + ':' + h.line + ' ' + h.text).join(' | '));
  await check('the seed org UUID appears in no code file at all (assets/js, functions, migrations)', () => {
    const idHits = r.hits.filter(h => h.text.includes(A));
    return idHits.length === 0 || idHits.map(h => h.file + ':' + h.line).join(', ');
  });
  await check('every listed legacy default is still a fallback only (coalesce / || on a caller-given orgSlug)', () => {
    const bad = r.known.filter(k => !/coalesce\(nullif\(payload ->> 'orgSlug'|cfg\.orgSlug \|\||orgSlug:|^\s*(\/\/|\*)/.test(k.text));
    return bad.length === 0 || J(bad);
  });
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}

async function main() {
  await staticScan();
  await dbMain();
  finish();
}

main().catch(e => { console.error(e); process.exit(1); });
