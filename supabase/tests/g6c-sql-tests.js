#!/usr/bin/env node
/*
  Marsa (مرسى) — G6c live e-mail: SQL side of migration 20261110000100_g6c_live_email.sql (docs/online/G6C_LIVE_EMAIL.md).
  LOCAL TESTS ONLY. Runs on PGlite (real Postgres 16 in memory). Never point it at Supabase. No network, no mailbox:
  worker results are HANDCRAFTED here (the real IMAP / SMTP adapter runs against a loopback fake in g6c-email-live-tests.js).

  Loads: supabase/tests/shim.sql → supabase/migrations/*.sql (sorted) → supabase/seed.sql → fixtures (superuser).
  Staff RPCs run as 'authenticated' with request.jwt.claims (the shim injects aal2 unless told otherwise); worker RPCs as
  service_role.

  Covers: preflight + re-run; 'live' for e-mail only and only through the admin gate of save_msg_channel (aal2);
  a live job is claimed (not failed), live_pending still fails not_configured; msg_schedule polls live channels at > 100 s
  (review M8); a live poll completion skips + records a message the SQL rules refuse and still advances the cursor
  (review C1) while a non-data error still fails the job; the stored outbound Message-ID of a live send is the bracketed
  provider id (review H2) and threads the counterpart's reply; DMARC downgrade verified → known on live channels;
  every mock path unchanged (atomic poll, 1 min interval, <MRSO-…@marsa.invalid>, no downgrade, webhook mock only).

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g6c-sql-tests.js [/path/to/marsa-website] [--quiet]
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
const MIG = '20261110000100_g6c_live_email.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }

// No network anywhere
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g6c-sql-tests'); };

/* ------------------------------------------------------------------ ids */
const A = '0b5e0000-0000-4000-8000-000000000001';           // seed org "blue-sea"
const JED = '0b5e0000-0000-4000-8000-000000000011';
const U = {
  adminA: 'a6c60000-0000-4000-8000-000000000001', opsA: 'a6c60000-0000-4000-8000-000000000002',
  clrJ: 'a6c60000-0000-4000-8000-000000000003', bmJ: 'a6c60000-0000-4000-8000-000000000004'
};
const CH_LIVE = 'ops@marsacloud.example';        // the alias customers write to (= From of live sends)
const CH_MOCK = 'inbox@a-clear.example';
const AG = 'agent@agent-line.example';
const MSGID_DOMAIN = 'marsacloud.example';

/* ------------------------------------------------------------------ helpers */
let db;
async function asRole(who, fn) {
  if (who === 'anon') {
    await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  } else if (who === 'service') {
    await db.exec(`SET ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);`);
  } else {
    if (!U[who]) throw new Error('unknown user ' + who);
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${U[who]}","role":"authenticated"}', false);`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const rpc = async (who, sql, params) => (await as(who, sql, params))[0].r;
const svc = async (sql, params) => (await as('service', sql, params))[0];
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const one = async (sql, params) => (await q(sql, params))[0];
const count = async (sql, params) => (await q(sql, params))[0].n;
const J = x => JSON.stringify(x);
async function expectErr(name, promiseFn, re) {
  try { await promiseFn(); fail(name, 'expected error /' + re.source + '/ but it succeeded'); }
  catch (e) { re.test(errText(e)) ? pass(name) : fail(name, 'wrong error: ' + errText(e)); }
}
async function check(name, fn) {
  try {
    const r = await fn();
    if (typeof r === 'string') fail(name, r);
    else if (r === false || r === null || r === 0 || r === undefined) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + errText(e) + '\n        ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')); }
}
async function tryErr(fn) { try { await fn(); return 'ok'; } catch (e) { return errText(e); } }
async function runFile(dbx, file) {
  const sql = fs.readFileSync(file, 'utf8');
  try { await dbx.exec(sql); if (!QUIET) console.log('  loaded ' + path.relative(ROOT, file)); return true; }
  catch (e) { fail('load ' + path.relative(ROOT, file), errText(e) + (e.position ? ' @line ' + sql.slice(0, +e.position).split('\n').length : '')); return false; }
}
const uuid = () => crypto.randomUUID();

const R = {
  saveChannel: (who, p, org) => rpc(who, `SELECT public.save_msg_channel($1, $2, $3) r`, [org || A, p, null]),
  probe: (who, ch) => rpc(who, `SELECT public.request_msg_channel_probe($1, $2) r`, [ch, null]),
  saveReply: (who, r, p) => rpc(who, `SELECT public.save_msg_reply($1, $2, $3) r`, [r || null, p, null]),
  submit: (who, r) => rpc(who, `SELECT public.submit_msg_reply($1) r`, [r]),
  decide: (who, r, v, d, n) => rpc(who, `SELECT public.decide_msg_reply($1, $2, $3, $4, $5) r`, [r, v, d, n || null, false]),
  send: (who, r) => rpc(who, `SELECT public.send_msg_reply($1, $2) r`, [r, null])
};
const ingest = async (ch, msgs) => (await svc(`SELECT public.msg_ingest_messages($1, $2) r`, [ch, JSON.stringify(msgs)])).r;
const claim = async (limit) => (await svc(`SELECT public.msg_claim_jobs('w-g6c', $1) r`, [limit || 20])).r;
const complete = async (att, res) => (await svc(`SELECT public.msg_complete_job($1, $2) r`, [att, JSON.stringify(res)])).r;
const schedule = async () => (await svc(`SELECT public.msg_schedule(50) r`)).r;
const due = () => db.exec(`UPDATE public.msg_jobs SET next_run_at = now() WHERE status IN ('queued','unknown')`);
const chRow = id => one(`SELECT * FROM public.msg_channels WHERE id = $1`, [id]);

const CAPS = { send: { supported: true, evidence: 'smtp 465 auth ok' }, lookup_send: { supported: true, evidence: 'INBOX + Sent by Message-ID' },
  status_events: { supported: true, evidence: 'DSN in INBOX' }, attachments: { supported: false, evidence: 'inbound metadata only' },
  threading: { supported: true, evidence: 'In-Reply-To / References' }, templates: { supported: false, evidence: 'n/a' } };
let nMsg = 0;
// a canonical inbound as the worker hands it to SQL (what normalizeInbound produces from the live adapter's raw)
function email(o) {
  nMsg++;
  return {
    provider_message_id: o.pid || ('mid:' + crypto.createHash('sha256').update('m' + nMsg).digest('hex').slice(0, 40)), kind: 'email',
    from: { address: o.from || AG }, to: o.to || [{ address: CH_LIVE }], cc: o.cc || [], sent_at: o.sent_at || new Date().toISOString(),
    subject: o.subject || ('Subject ' + nMsg), body_text: o.body === undefined ? 'Hello' : o.body,
    headers: o.headers || { message_id: '<g6c' + nMsg + '@agent-line.example>', in_reply_to: null, references: [] },
    auth: o.auth || { spf: 'none', dkim: 'none', dmarc: 'none' }, attachments: o.attachments || [], raw: { provider: 'imap-hostinger' }
  };
}
// claim the due jobs; complete the matching one with `res(ctx)`; others are completed with a harmless default
// (AI process / draft jobs are not this suite's subject: they are cancelled first; one job per channel per claim → rounds)
async function runKind(kind, channelId, res) {
  const out = [];
  for (let round = 0; round < 6 && !out.length; round++) {
    await db.exec(`UPDATE public.msg_jobs SET status = 'cancelled', finished_at = now() WHERE kind IN ('process','draft') AND status IN ('queued','unknown')`);
    await due();
    const ctxs = await claim(20);
    if (!ctxs.length) break;
    for (const c of ctxs) {
      if (c.job.kind === kind && (!channelId || c.channel.id === channelId)) out.push({ ctx: c, done: await complete(c.attempt_id, res(c)) });
      else await complete(c.attempt_id, defaultResult(c));
    }
  }
  return out;
}
function defaultResult(c) {
  switch (c.job.kind) {
    case 'probe': return { outcome: 'ok', effects: { capabilities: CAPS, account: { address: c.channel.address_norm } }, calls: [{ op: 'probe', applied: 'no' }] };
    case 'poll': return { outcome: 'ok', effects: { messages: [], next_cursor: c.channel.poll_cursor || 'c0' } };
    case 'status': return { outcome: 'ok', effects: { events: [], next_cursor: c.channel.status_cursor || 's0' } };
    case 'process': return { outcome: 'retry', error: { kind: 'network', code: 'not_in_this_suite', applied: 'no' } };
  }
  return { outcome: 'retry', error: { kind: 'network', code: 'not_in_this_suite', applied: 'no' } };
}

const S = {};

/* ------------------------------------------------------------------ fixtures (superuser) */
async function fixtures() {
  const users = Object.keys(U).map(k => `('${U[k]}', '${k.toLowerCase()}@g6c.example.com', now())`).join(', ');
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ${users};
    INSERT INTO public.profiles (id, full_name) SELECT u.id, split_part(u.email, '@', 1) FROM auth.users u
      WHERE u.email LIKE '%@g6c.example.com' ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
    INSERT INTO public.memberships (user_id, org_id, branch_id, role) VALUES
      ('${U.adminA}', '${A}', NULL, 'admin'), ('${U.opsA}', '${A}', NULL, 'operations_manager'),
      ('${U.clrJ}', '${A}', '${JED}', 'clearance_staff'), ('${U.bmJ}', '${A}', '${JED}', 'branch_manager');
    INSERT INTO public.msg_contacts (id, org_id, display_name, entity_type) VALUES ('a6c60000-0000-4000-8000-0000000000c1', '${A}', 'Agent Line', 'other');
    INSERT INTO public.msg_contact_addresses (org_id, contact_id, kind, address, address_norm, verified_at, verification_method, verification_note)
      VALUES ('${A}', 'a6c60000-0000-4000-8000-0000000000c1', 'email', '${AG}', '${AG}', now(), 'callback', 'phoned the agent');
  `);
}

/* ================================================================== sections */
async function secMigration() {
  section('1. migration: preflight, schema_versions, constraints, label, re-run, all_migrations.sql');
  const src = fs.readFileSync(MIG_FILE, 'utf8');
  await check('file conventions: encoding guard, preflight on 20261109000100, schema_versions row, search_path = \'\' on every function', () => {
    const fnHeads = src.match(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$/g) || [];
    const bad = fnHeads.filter(h => !/SET search_path = ''/.test(h));
    return (/ENCODING ERROR: Arabic text was pasted incorrectly/.test(src) && /version = '20261109000100'/.test(src)
      && /INSERT INTO public\.schema_versions \(version, name\) VALUES \('20261110000100', 'g6c_live_email'\)/.test(src)
      && fnHeads.length === 7 && bad.length === 0) || J({ n: fnHeads.length, bad: bad.map(b => b.slice(0, 80)) });
  });
  await check('schema_versions has 20261110000100 g6c_live_email', async () =>
    (await count(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261110000100' AND name = 'g6c_live_email'`)) === 1);
  await check('msg_channels CHECKs: mode IN (mock, live_pending, live) + live only for e-mail', async () => {
    const r = await q(`SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = 'public.msg_channels'::regclass
                         AND conname IN ('msg_channels_mode_check','msg_channels_live_kind_chk') ORDER BY 1`);
    return (r.length === 2 && /'live'/.test(r[1].d) && /'live_pending'/.test(r[1].d) && /mode <> 'live'/.test(r[0].d) && /kind = 'email'/.test(r[0].d)) || J(r);
  });
  await check('label msg_channel_mode live (ar + en, internal)', async () => {
    const r = await one(`SELECT label_ar, label_en, client_visible FROM public.status_labels WHERE domain = 'msg_channel_mode' AND code = 'live'`);
    return (r && /IMAP/.test(r.label_en) && r.label_ar.length > 3 && r.client_visible === false) || J(r);
  });
  await check('all_migrations.sql ends with this file verbatim (appended like the earlier phases)', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const marker = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(marker);
    return (i > 0 && all.slice(i + marker.length).replace(/\n+$/, '') === src.replace(/\n+$/, '') && all.indexOf(marker, i + 1) < 0) || 'not appended verbatim';
  });

  // a separate database: everything before G6c, then the preflight, then twice
  const saved = db;
  db = new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
    for (const f of fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f) && f < MIG).sort()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    const fp = async () => J(await q(`SELECT p.oid::regprocedure::text s, md5(p.prosrc) h FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                       WHERE n.nspname IN ('app','public') ORDER BY 1`)) +
      J(await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = 'public.msg_channels'::regclass ORDER BY conname`));
    await db.exec(`DELETE FROM public.schema_versions WHERE version = '20261109000100'`);
    const before = await fp();
    const msg = await tryErr(() => db.exec(src));
    await check('without MFA: exact preflight message', () => msg.startsWith('G6c preflight: apply MFA first (schema_versions lacks 20261109000100 mfa)') || 'got: ' + msg);
    await check('without MFA: nothing created or re-created (functions, constraints, schema_versions)', async () =>
      (before === await fp() && (await count(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261110000100'`)) === 0) || 'catalog changed');
    await db.exec(`INSERT INTO public.schema_versions (version, name) VALUES ('20261109000100', 'mfa')`);
    const r1 = await tryErr(() => db.exec(src));
    const after1 = await fp();
    const r2 = await tryErr(() => db.exec(src));
    await check('applies, and re-runs on top of itself with an identical catalog', async () =>
      (r1 === 'ok' && r2 === 'ok' && after1 === await fp() && (await count(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261110000100'`)) === 1) || J({ r1, r2 }));
  } finally { await db.close(); db = saved; }
}

async function secPrivileges() {
  section('2. privileges: helpers owner-only, staff RPC authenticated, worker RPC service_role');
  await check('app.msg_live_message_id / msg_ingest_one / msg_outbound_accepted / msg_apply_delivery / msg_complete: no EXECUTE for anon / authenticated / service_role', async () => {
    const r = await q(`SELECT p.oid::regprocedure::text s, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
                              has_function_privilege('service_role', p.oid, 'EXECUTE') sr
                         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname IN ('msg_live_message_id','msg_ingest_one','msg_outbound_accepted','msg_apply_delivery','msg_complete')`);
    return (r.length === 5 && r.every(x => !x.a && !x.u && !x.sr)) || J(r);
  });
  await check('save_msg_channel: authenticated only; msg_schedule: service_role only', async () => {
    const r = await one(`SELECT has_function_privilege('anon', 'public.save_msg_channel(uuid, jsonb, uuid)', 'EXECUTE') sa,
                                has_function_privilege('authenticated', 'public.save_msg_channel(uuid, jsonb, uuid)', 'EXECUTE') su,
                                has_function_privilege('anon', 'public.msg_schedule(int)', 'EXECUTE') ma,
                                has_function_privilege('authenticated', 'public.msg_schedule(int)', 'EXECUTE') mu,
                                has_function_privilege('service_role', 'public.msg_schedule(int)', 'EXECUTE') ms`);
    return (!r.sa && r.su && !r.ma && !r.mu && r.ms) || J(r);
  });
  await check('app.msg_live_message_id: one bracketed form; anything else NULL', async () => {
    const r = await one(`SELECT app.msg_live_message_id('MRSO-0123456789ABCDEF@marsacloud.example') a, app.msg_live_message_id('<MRSO-0123456789ABCDEF@marsacloud.example>') b,
                                app.msg_live_message_id('prov-MRSO-0123456789ABCDEF') c, app.msg_live_message_id(NULL) d,
                                app.msg_live_message_id('<MRSO-0123456789abcdef@x.example>') e, app.msg_live_message_id('<MRSO-0123456789ABCDEF@a b>') f`);
    return (r.a === '<MRSO-0123456789ABCDEF@marsacloud.example>' && r.b === r.a && r.c === null && r.d === null && r.e === null && r.f === null) || J(r);
  });
}

async function secChannels() {
  section('3. save_msg_channel: live for e-mail only, admin gate (aal2), reset on switch; claim; live_pending unchanged');
  await expectErr('WhatsApp channel with mode live → MRS_INVALID mode',
    () => R.saveChannel('adminA', { kind: 'whatsapp', name: 'WA live', address: '+966500000009', mode: 'live' }), /MRS_INVALID mode/);
  await expectErr('operations manager (not admin) cannot create a live channel → MRS_FORBIDDEN role',
    () => R.saveChannel('opsA', { kind: 'email', name: 'Live', address: CH_LIVE, mode: 'live' }), /MRS_FORBIDDEN role/);
  await check('org admin at aal1 (MFA pending) cannot create a live channel → MRS_MFA_REQUIRED', async () => {
    await db.exec(`SELECT set_config('marsa_test.default_aal', 'aal1', false)`);
    try {
      const e = await tryErr(() => R.saveChannel('adminA', { kind: 'email', name: 'Live', address: CH_LIVE, mode: 'live' }));
      return /MRS_MFA_REQUIRED/.test(e) || e;
    } finally { await db.exec(`SELECT set_config('marsa_test.default_aal', '', false)`); }
  });
  await expectErr('unknown mode value still refused → MRS_INVALID mode',
    () => R.saveChannel('adminA', { kind: 'email', name: 'Xy', address: 'x@a-clear.example', mode: 'imap' }), /MRS_INVALID mode/);
  S.live = await R.saveChannel('adminA', { kind: 'email', name: 'Ops (live)', address: 'Ops@MarsaCloud.example', default_branch_id: JED,
    mode: 'live', ingest_enabled: true, send_enabled: true, provider_terms_ack: true });
  await check('org admin (aal2): e-mail channel mode live, address normalized, not_connected, no secret', async () =>
    (S.live.mode === 'live' && S.live.address_norm === CH_LIVE && S.live.status === 'not_connected' && S.live.secrets_stored === false) || J(S.live));
  await check('a superuser UPDATE cannot make a WhatsApp channel live (CHECK msg_channels_live_kind_chk)', async () => {
    const w = await R.saveChannel('adminA', { kind: 'whatsapp', name: 'WA', address: '+966500000008' });
    const e = await tryErr(() => db.query(`UPDATE public.msg_channels SET mode = 'live' WHERE id = $1`, [w.id]));
    S.wa = w;
    return /msg_channels_live_kind_chk/.test(e) || e;
  });
  S.mock = await R.saveChannel('adminA', { kind: 'email', name: 'Mock inbox', address: CH_MOCK, default_branch_id: JED,
    ingest_enabled: true, send_enabled: true, provider_terms_ack: true });
  // probes: both claimed (live is NOT refused at claim), ok → connected; source live vs mock
  const pl = await R.probe('adminA', S.live.id);
  await R.probe('adminA', S.mock.id);
  let liveCtx = null, attemptMode = null;
  await due();
  for (const c of await claim(20)) {
    if (c.job.id === pl.id) {
      liveCtx = c;
      attemptMode = (await one(`SELECT adapter_mode FROM public.msg_job_attempts WHERE id = $1`, [c.attempt_id])).adapter_mode;
    }
    await complete(c.attempt_id, defaultResult(c));
  }
  await check('live probe job: claimed and handed to the worker (channel mode live, attempt adapter_mode live), not failed', async () => {
    const j = await one(`SELECT status, last_error_code FROM public.msg_jobs WHERE id = $1`, [pl.id]);
    return (liveCtx && liveCtx.channel.mode === 'live' && liveCtx.channel.address_norm === CH_LIVE && attemptMode === 'live'
      && j.status === 'done' && !JSON.stringify(liveCtx).match(/password|secret/i)) || J({ j, attemptMode });
  });
  await check('live probe ok → connected, capabilities_source live; mock probe → source mock', async () => {
    const l = await chRow(S.live.id), m = await chRow(S.mock.id);
    return (l.status === 'connected' && l.capabilities_source === 'live' && l.capabilities.send.supported === true
      && m.status === 'connected' && m.capabilities_source === 'mock') || J([l.status, l.capabilities_source, m.status, m.capabilities_source]);
  });
  await check('live probe of another account (the IMAP login, not the alias) → failed account_mismatch, channel error (unchanged rule)', async () => {
    const p = await R.probe('adminA', S.live.id);
    await runKind('probe', S.live.id, c => ({ outcome: 'ok', effects: { capabilities: CAPS, account: { address: 'no-reply@marsacloud.example' } } }));
    const j = await one(`SELECT status, last_error_code FROM public.msg_jobs WHERE id = $1`, [p.id]);
    const l = await chRow(S.live.id);
    const ok = j.status === 'failed' && j.last_error_code === 'account_mismatch' && l.status === 'error';
    await R.probe('adminA', S.live.id);
    await runKind('probe', S.live.id, defaultResult);
    return (ok && (await chRow(S.live.id)).status === 'connected') || J({ j, s: l.status });
  });
  await check('switching mock → live resets the channel to not_connected with no capabilities (existing behaviour); back to mock likewise', async () => {
    const x = await R.saveChannel('adminA', { kind: 'email', name: 'Switch', address: 'switch@a-clear.example' });
    await R.probe('adminA', x.id);
    await runKind('probe', x.id, defaultResult);
    const c0 = await chRow(x.id);
    const a = await R.saveChannel('adminA', { id: x.id, mode: 'live' });
    const b = await R.saveChannel('adminA', { id: x.id, mode: 'mock' });
    return (c0.status === 'connected' && a.mode === 'live' && a.status === 'not_connected' && J(a.capabilities) === '{}' && a.from === 'connected'
      && b.mode === 'mock' && b.status === 'not_connected') || J({ c0: c0.status, a, b });
  });
  await check('live_pending unchanged: its probe fails not_configured at claim and never reaches the worker', async () => {
    const lp = await R.saveChannel('adminA', { kind: 'email', name: 'Pending', address: 'pending@a-clear.example', mode: 'live_pending' });
    const j0 = await R.probe('adminA', lp.id);
    await due();
    const ctxs = await claim(20);
    for (const c of ctxs) await complete(c.attempt_id, defaultResult(c));
    const j = await one(`SELECT status, last_error_code FROM public.msg_jobs WHERE id = $1`, [j0.id]);
    return (!ctxs.some(c => c.job.id === j0.id) && j.status === 'failed' && j.last_error_code === 'not_configured') || J(j);
  });
  await expectErr('webhook ingest stays mock only: a live channel → MRS_BAD_TRANSITION not_configured', () => ingest(S.live.id, [email({})]), /MRS_BAD_TRANSITION.*not_configured/);
}

async function secSchedule() {
  section('4. msg_schedule: live polled at > 100 s (review M8), mock at > 1 min (unchanged), status jobs for both');
  const queuedPolls = id => count(`SELECT count(*)::int n FROM public.msg_jobs WHERE channel_id = $1 AND kind = 'poll' AND status IN ('queued','unknown','running')`, [id]);
  // drain anything queued so far
  await db.exec(`UPDATE public.msg_jobs SET status = 'cancelled', finished_at = now() WHERE kind IN ('poll','status') AND status IN ('queued','unknown')`);
  await db.exec(`UPDATE public.msg_channels SET last_poll_at = now() - interval '70 seconds' WHERE id IN ('${S.live.id}', '${S.mock.id}')`);
  await schedule();
  await check('last poll 70 s ago: mock enqueued (> 1 min), live not (> 100 s)', async () =>
    ((await queuedPolls(S.mock.id)) === 1 && (await queuedPolls(S.live.id)) === 0) || J([await queuedPolls(S.mock.id), await queuedPolls(S.live.id)]));
  await db.exec(`UPDATE public.msg_channels SET last_poll_at = now() - interval '110 seconds' WHERE id = '${S.live.id}'`);
  const r = await schedule();
  await check('last poll 110 s ago: live poll enqueued (one job, deduplicated on a second run)', async () => {
    const again = await schedule();
    return ((await queuedPolls(S.live.id)) === 1 && r.enqueued >= 1 && again.enqueued === 0) || J({ r, again, n: await queuedPolls(S.live.id) });
  });
  await check('never polled (last_poll_at NULL) → enqueued; ingest off → not enqueued', async () => {
    await db.exec(`UPDATE public.msg_jobs SET status = 'cancelled', finished_at = now() WHERE channel_id = '${S.live.id}' AND kind = 'poll' AND status = 'queued'`);
    await db.exec(`UPDATE public.msg_channels SET last_poll_at = NULL WHERE id = '${S.live.id}'`);
    await schedule();
    const a = await queuedPolls(S.live.id);
    await db.exec(`UPDATE public.msg_jobs SET status = 'cancelled', finished_at = now() WHERE channel_id = '${S.live.id}' AND kind = 'poll' AND status = 'queued'`);
    await R.saveChannel('adminA', { id: S.live.id, ingest_enabled: false });
    await schedule();
    const b = await queuedPolls(S.live.id);
    await R.saveChannel('adminA', { id: S.live.id, ingest_enabled: true });
    return (a === 1 && b === 0) || J({ a, b });
  });
  await db.exec(`UPDATE public.msg_jobs SET status = 'cancelled', finished_at = now() WHERE kind IN ('poll','status') AND status IN ('queued','unknown')`);
}

async function secPoll() {
  section('5. live poll completion: a refused message is skipped + recorded, the cursor still advances (review C1)');
  const good = email({ subject: 'Good one' });
  const badFrom = email({ from: 'not-an-address' });
  const badBody = email({ body: 'x'.repeat(100001) });
  const badAtt = email({ attachments: [{ provider_attachment_id: 'p2', file_name: 'big.bin', mime_type: 'application/octet-stream', size_bytes: 30000000 }] });
  const badKey = Object.assign(email({}), { html: '<p>x</p>' });
  const batch = [badFrom, good, badBody, badAtt, badKey];
  const threads0 = await count(`SELECT count(*)::int n FROM public.msg_threads WHERE channel_id = $1`, [S.live.id]);
  await db.exec(`UPDATE public.msg_channels SET poll_cursor = 'v1:7:100:20395', last_poll_at = NULL WHERE id = '${S.live.id}'`);
  await schedule();
  const [r] = await runKind('poll', S.live.id, () => ({ outcome: 'ok', effects: { messages: batch, next_cursor: 'v1:7:105:20395' },
    calls: [{ op: 'fetchInbound', applied: 'no', response: { messages: 5 } }] }));
  await check('job done; 1 ingested, 4 skipped (items carry skipped + a fixed code, never the data)', async () => {
    const it = r && r.done.items;
    const sk = it.filter(x => x.skipped);
    return (r.done.job_status === 'done' && r.done.ingested === 1 && r.done.skipped === 4 && it.length === 5 && sk.length === 4
      && sk.map(x => x.code).join('|') === 'MRS_INVALID from|MRS_INVALID body_text|MRS_INVALID attachments|MRS_INVALID unknown_key'
      && sk[0].provider_message_id === badFrom.provider_message_id && !JSON.stringify(it).includes('xxxxxxxx')) || J(r && r.done);
  });
  await check('cursor advanced to the batch cursor and last_poll_at set', async () => {
    const c = await chRow(S.live.id);
    return (c.poll_cursor === 'v1:7:105:20395' && c.last_poll_at !== null) || J(c.poll_cursor);
  });
  await check('only the good message (and its thread) exists: skipped ones left nothing behind (no thread, attachment or job)', async () => {
    const pids = batch.map(m => m.provider_message_id);
    const msgs = await q(`SELECT provider_message_id p FROM public.msg_messages WHERE provider_message_id = ANY ($1)`, [pids]);
    const threads = await count(`SELECT count(*)::int n FROM public.msg_threads WHERE channel_id = $1`, [S.live.id]);
    const atts = await count(`SELECT count(*)::int n FROM public.msg_attachments a JOIN public.msg_messages m ON m.id = a.message_id WHERE m.provider_message_id = $1`, [badAtt.provider_message_id]);
    return (msgs.length === 1 && msgs[0].p === good.provider_message_id && threads === threads0 + 1 && atts === 0) || J({ msgs, threads, threads0, atts });
  });
  await check('the attempt records an ingest_skip call (count + provider ids + codes) after the worker calls', async () => {
    const a = await one(`SELECT outcome, calls FROM public.msg_job_attempts WHERE id = $1`, [r.ctx.attempt_id]);
    const s = a.calls.find(c => c.op === 'ingest_skip');
    return (a.outcome === 'ok' && a.calls[0].op === 'fetchInbound' && s && s.applied === 'no' && s.request.skipped === 4 && s.response.skipped.length === 4
      && s.response.skipped[1].code === 'MRS_INVALID body_text') || J(a.calls);
  });
  await check('re-delivery of the same batch: the good one is a duplicate, the bad ones are skipped again, no new rows', async () => {
    await db.exec(`UPDATE public.msg_channels SET last_poll_at = NULL WHERE id = '${S.live.id}'`);
    await schedule();
    const [r2] = await runKind('poll', S.live.id, () => ({ outcome: 'ok', effects: { messages: batch, next_cursor: 'v1:7:105:20395' } }));
    return (r2.done.job_status === 'done' && r2.done.ingested === 0 && r2.done.skipped === 4 && r2.done.items[1].duplicate === true
      && (await count(`SELECT count(*)::int n FROM public.msg_messages WHERE channel_id = $1`, [S.live.id])) === 1) || J(r2.done);
  });
  await check('a NON-data error (e.g. a plan / infrastructure error) is never skipped: the live completion fails, cursor unchanged, nothing ingested', async () => {
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.g6c_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.provider_message_id = 'boom' THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_PLAN_LIMIT', DETAIL = 'messages_month'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER g6c_test_boom BEFORE INSERT ON public.msg_messages FOR EACH ROW EXECUTE FUNCTION public.g6c_test_boom();`);
    try {
      await db.exec(`UPDATE public.msg_channels SET last_poll_at = NULL WHERE id = '${S.live.id}'`);
      await schedule();
      const ok2 = email({ subject: 'would be fine' });
      const [r3] = await runKind('poll', S.live.id, () => ({ outcome: 'ok', effects: { messages: [ok2, email({ pid: 'boom' })], next_cursor: 'v1:7:999:20395' } }));
      const c = await chRow(S.live.id);
      return (r3.done.job_status === 'failed' && /MRS_PLAN_LIMIT/.test(r3.done.error.code) && c.poll_cursor === 'v1:7:105:20395'
        && (await count(`SELECT count(*)::int n FROM public.msg_messages WHERE provider_message_id = $1`, [ok2.provider_message_id])) === 0) || J({ d: r3.done, cur: c.poll_cursor });
    } finally { await db.exec(`DROP TRIGGER g6c_test_boom ON public.msg_messages; DROP FUNCTION public.g6c_test_boom();`); }
  });
  await check('mock unchanged: the same refused message fails the whole mock completion (atomic), cursor and messages untouched', async () => {
    await db.exec(`UPDATE public.msg_channels SET poll_cursor = 'm1', last_poll_at = NULL WHERE id = '${S.mock.id}'`);
    await schedule();
    const g = email({ to: [{ address: CH_MOCK }] }), b = email({ to: [{ address: CH_MOCK }], from: 'not-an-address' });
    const [rm] = await runKind('poll', S.mock.id, () => ({ outcome: 'ok', effects: { messages: [g, b], next_cursor: 'm2' } }));
    const c = await chRow(S.mock.id);
    return (rm.done.job_status === 'failed' && rm.done.skipped === undefined && c.poll_cursor === 'm1'
      && (await count(`SELECT count(*)::int n FROM public.msg_messages WHERE provider_message_id = $1`, [g.provider_message_id])) === 0) || J({ d: rm.done, c: c.poll_cursor });
  });
  await check('mock poll ok: result shape unchanged (no skipped key), cursor advanced', async () => {
    await db.exec(`UPDATE public.msg_channels SET last_poll_at = NULL WHERE id = '${S.mock.id}'`);
    await schedule();
    const [rm] = await runKind('poll', S.mock.id, () => ({ outcome: 'ok', effects: { messages: [email({ to: [{ address: CH_MOCK }] })], next_cursor: 'm3' } }));
    return (rm.done.job_status === 'done' && rm.done.ingested === 1 && !('skipped' in rm.done) && (await chRow(S.mock.id)).poll_cursor === 'm3') || J(rm.done);
  });
}

async function secDmarc() {
  section('6. sender verification: live → verified only with DMARC pass (design § 4); mock unchanged');
  const pollLive = async (msgs) => {
    await db.exec(`UPDATE public.msg_channels SET last_poll_at = NULL WHERE id = '${S.live.id}'`);
    await schedule();
    const [r] = await runKind('poll', S.live.id, () => ({ outcome: 'ok', effects: { messages: msgs, next_cursor: 'v1:7:200:20395' } }));
    return r.done;
  };
  const none = email({ auth: { spf: 'pass', dkim: 'pass', dmarc: 'none' } });
  const passM = email({ auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } });
  const failM = email({ auth: { spf: 'fail', dkim: 'none', dmarc: 'fail' } });
  const d = await pollLive([none, passM, failM]);
  const st = async pid => one(`SELECT sender_status s, sender_signals g, risk_flags f FROM public.msg_messages WHERE provider_message_id = $1`, [pid]);
  await check('live, verified contact, dmarc none → known + sender_unverified + signal dmarc_not_pass', async () => {
    const m = await st(none.provider_message_id);
    return (d.ingested === 3 && m.s === 'known' && m.f.includes('sender_unverified') && m.g.dmarc_not_pass === true) || J({ d, m });
  });
  await check('live, verified contact, dmarc pass → verified (no flag, no signal)', async () => {
    const m = await st(passM.provider_message_id);
    return (m.s === 'verified' && !m.f.includes('sender_unverified') && !m.g.dmarc_not_pass) || J(m);
  });
  await check('live, auth fail → mismatch + auth_fail (the existing rule wins, no downgrade on top)', async () => {
    const m = await st(failM.provider_message_id);
    return (m.s === 'mismatch' && m.g.auth_fail === true && !m.g.dmarc_not_pass) || J(m);
  });
  await check('mock unchanged: verified contact with dmarc none stays verified (webhook ingest)', async () => {
    const m0 = email({ to: [{ address: CH_MOCK }], auth: { spf: 'none', dkim: 'none', dmarc: 'none' } });
    await ingest(S.mock.id, [m0]);
    const m = await st(m0.provider_message_id);
    return (m.s === 'verified' && !m.g.dmarc_not_pass) || J(m);
  });
}

async function secOutbound() {
  section('7. live send: stored outbound Message-ID = bracketed provider id (review H2); threading; mock unchanged');
  const sendOn = async (channelId, inboundTo, providerId) => {
    const m0 = email({ to: [{ address: inboundTo }], subject: 'Need D/O', auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } });
    if (channelId === S.live.id) {
      await db.exec(`UPDATE public.msg_channels SET last_poll_at = NULL WHERE id = '${S.live.id}'`);
      await schedule();
      await runKind('poll', S.live.id, () => ({ outcome: 'ok', effects: { messages: [m0], next_cursor: 'v1:7:300:20395' } }));
    } else {
      await ingest(channelId, [m0]);
    }
    const inb = await one(`SELECT id, thread_id FROM public.msg_messages WHERE provider_message_id = $1`, [m0.provider_message_id]);
    const v = await R.saveReply('clrJ', null, { thread_id: inb.thread_id, reply_to_message_id: inb.id, body_text: 'Dear agent, please issue the D/O.' });
    const reply = v.reply_id ? v : (v.reply || v);
    const rid = reply.reply_id || reply.id;
    const sub = await R.submit('clrJ', rid);
    await R.decide('bmJ', rid, sub.current_version_id, 'approve', 'ok');
    const s = await R.send('clrJ', rid);
    let sctx = null;
    await runKind('send', channelId, c => { sctx = c; return { outcome: 'ok', effects: { outbound_id: c.send.outbound_id, provider_message_id: providerId(c), status: 'accepted', found_by: 'sent' },
      calls: [{ op: 'send', applied: 'yes' }] }; });
    return { inb, m0, s, sctx, thread: inb.thread_id };
  };
  let L;
  try { L = await sendOn(S.live.id, CH_LIVE, c => '<' + c.send.provider_request_id + '@' + MSGID_DOMAIN + '>'); }
  catch (e) { fail('live send flow', errText(e)); return; }
  await check('live send context: from = the channel alias, request id MRSO, in_reply_to = the inbound Message-ID', async () =>
    (L.sctx && L.sctx.send.from === CH_LIVE && /^MRSO-[0-9A-F]{16}$/.test(L.sctx.send.provider_request_id) && L.sctx.send.in_reply_to === L.m0.headers.message_id) || J(L.sctx && L.sctx.send));
  await check('live outbound copy: provider_message_id AND headers.message_id = <MRSO-…@marsacloud.example> (not @marsa.invalid)', async () => {
    const o = await one(`SELECT state, provider_request_id, provider_message_id FROM public.msg_outbound WHERE id = $1`, [L.sctx.send.outbound_id]);
    const m = await one(`SELECT provider_message_id p, headers h FROM public.msg_messages WHERE outbound_id = $1`, [L.sctx.send.outbound_id]);
    const want = '<' + o.provider_request_id + '@' + MSGID_DOMAIN + '>';
    return (o.state === 'accepted' && o.provider_message_id === want && m.p === want && m.h.message_id === want && m.h.in_reply_to === L.m0.headers.message_id) || J({ o, m });
  });
  await check('the counterpart\'s reply (In-Reply-To = our Message-ID) lands in the same thread', async () => {
    const o = await one(`SELECT provider_message_id p FROM public.msg_outbound WHERE id = $1`, [L.sctx.send.outbound_id]);
    const back = email({ subject: 'Re: Need D/O', headers: { message_id: '<back1@agent-line.example>', in_reply_to: o.p, references: [L.m0.headers.message_id, o.p] } });
    await db.exec(`UPDATE public.msg_channels SET last_poll_at = NULL WHERE id = '${S.live.id}'`);
    await schedule();
    await runKind('poll', S.live.id, () => ({ outcome: 'ok', effects: { messages: [back], next_cursor: 'v1:7:301:20395' } }));
    const m = await one(`SELECT thread_id FROM public.msg_messages WHERE provider_message_id = $1`, [back.provider_message_id]);
    return (m && m.thread_id === L.thread) || J(m);
  });
  await check('live status job enqueued for the accepted live outbound (DSN scan)', async () => {
    await schedule();
    return (await count(`SELECT count(*)::int n FROM public.msg_jobs WHERE channel_id = $1 AND kind = 'status' AND status = 'queued'`, [S.live.id])) === 1;
  });
  await check('live send with a provider id that is not an MRSO Message-ID → the stored header falls back to <MRSO-…@marsa.invalid>', async () => {
    const x = await sendOn(S.live.id, CH_LIVE, () => 'weird-id');
    const m = await one(`SELECT headers h FROM public.msg_messages WHERE outbound_id = $1`, [x.sctx.send.outbound_id]);
    return m.h.message_id === '<' + x.sctx.send.provider_request_id + '@marsa.invalid>' || J(m);
  });
  let Mk;
  try { Mk = await sendOn(S.mock.id, CH_MOCK, c => 'prov-' + c.send.provider_request_id); }
  catch (e) { fail('mock send flow', errText(e)); return; }
  await check('mock unchanged: outbound copy headers.message_id = <MRSO-…@marsa.invalid>, provider id as returned', async () => {
    const m = await one(`SELECT provider_message_id p, headers h FROM public.msg_messages WHERE outbound_id = $1`, [Mk.sctx.send.outbound_id]);
    return (m.h.message_id === '<' + Mk.sctx.send.provider_request_id + '@marsa.invalid>' && m.p === 'prov-' + Mk.sctx.send.provider_request_id) || J(m);
  });
  await check('mock channel even with an MRSO-shaped provider id keeps the @marsa.invalid header (live-only rule)', async () => {
    const x = await sendOn(S.mock.id, CH_MOCK, c => '<' + c.send.provider_request_id + '@' + MSGID_DOMAIN + '>');
    const m = await one(`SELECT headers h FROM public.msg_messages WHERE outbound_id = $1`, [x.sctx.send.outbound_id]);
    return m.h.message_id === '<' + x.sctx.send.provider_request_id + '@marsa.invalid>' || J(m);
  });
}

async function secReviewFixes() {
  section('8. review fixes: foreign sender on a thread reference (security M7), live DSN never settles unknown (security H4 d), probe seeds cursors (correctness M7)');
  const pollLive = async (msgs, cursor) => {
    await db.exec(`UPDATE public.msg_channels SET last_poll_at = NULL WHERE id = '${S.live.id}'`);
    await schedule();
    const [r] = await runKind('poll', S.live.id, () => ({ outcome: 'ok', effects: { messages: msgs, next_cursor: cursor || 'v1:7:400:20395' } }));
    return r && r.done;
  };
  const msgOf = pid => one(`SELECT thread_id, sender_status s, sender_signals g, risk_flags f FROM public.msg_messages WHERE provider_message_id = $1`, [pid]);
  // an inbound on the live channel with a CC'd third party, then the threads it opened
  const root = email({ subject: 'Root', cc: [{ address: 'cc@agent-line.example' }], auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    headers: { message_id: '<root-m7@agent-line.example>', in_reply_to: null, references: [] } });
  await pollLive([root]);
  const r0 = await msgOf(root.provider_message_id);
  const ref = { message_id: null, in_reply_to: '<root-m7@agent-line.example>', references: ['<root-m7@agent-line.example>'] };
  const foreign = email({ from: 'attacker@evil.example', subject: 'Re: Root', headers: Object.assign({}, ref, { message_id: '<f1@evil.example>' }) });
  const ccReply = email({ from: 'cc@agent-line.example', subject: 'Re: Root', headers: Object.assign({}, ref, { message_id: '<c1@agent-line.example>' }) });
  const own = email({ subject: 'Re: Root', auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, headers: Object.assign({}, ref, { message_id: '<o1@agent-line.example>' }) });
  await pollLive([foreign, ccReply, own]);
  await check('security M7 (live): a sender the thread does not know, holding its Message-ID, opens a NEW thread + thread_ref_foreign_sender + sender_unverified', async () => {
    const m = await msgOf(foreign.provider_message_id);
    const t = await one(`SELECT counterpart_address_norm c, risk_flags f FROM public.msg_threads WHERE id = $1`, [m.thread_id]);
    return (m.thread_id !== r0.thread_id && m.g.thread_ref_foreign_sender === true && m.f.filter(x => x === 'sender_unverified').length === 1 &&
      t.c === 'attacker@evil.example' && t.f.includes('sender_unverified')) || J({ m, t, r0 });
  });
  await check('security M7 (live): the counterpart and a party CC\'d on the thread still join it by reference', async () => {
    const c = await msgOf(ccReply.provider_message_id), o = await msgOf(own.provider_message_id);
    return (c.thread_id === r0.thread_id && o.thread_id === r0.thread_id && !c.g.thread_ref_foreign_sender && !o.g.thread_ref_foreign_sender) || J({ c, o, r0 });
  });
  await check('security M7: mock unchanged — a foreign sender with a reference still joins the mock thread', async () => {
    const mr = email({ to: [{ address: CH_MOCK }], headers: { message_id: '<mroot-m7@agent-line.example>', in_reply_to: null, references: [] } });
    await ingest(S.mock.id, [mr]);
    const mf = email({ to: [{ address: CH_MOCK }], from: 'attacker@evil.example', headers: { message_id: '<mf1@evil.example>', in_reply_to: '<mroot-m7@agent-line.example>', references: [] } });
    await ingest(S.mock.id, [mf]);
    const a = await msgOf(mr.provider_message_id), b = await msgOf(mf.provider_message_id);
    return (a.thread_id === b.thread_id && !b.g.thread_ref_foreign_sender) || J({ a, b });
  });

  // an outbound left 'unknown' by a lost send response, then a DSN for it from the status poll
  const unknownOutbound = async (channelId, inboundTo) => {
    const m0 = email({ to: [{ address: inboundTo }], subject: 'H4d', auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } });
    if (channelId === S.live.id) await pollLive([m0]); else await ingest(channelId, [m0]);
    const inb = await one(`SELECT id, thread_id FROM public.msg_messages WHERE provider_message_id = $1`, [m0.provider_message_id]);
    const v = await R.saveReply('clrJ', null, { thread_id: inb.thread_id, reply_to_message_id: inb.id, body_text: 'Dear agent, H4d.' });
    const reply = v.reply_id ? v : (v.reply || v);
    const rid = reply.reply_id || reply.id;
    const sub = await R.submit('clrJ', rid);
    await R.decide('bmJ', rid, sub.current_version_id, 'approve', 'ok');
    await R.send('clrJ', rid);
    let ctx = null;
    await runKind('send', channelId, c => { ctx = c; return { outcome: 'unknown', effects: { outbound_id: c.send.outbound_id },
      error: { kind: 'network', code: 'connection_lost', message: 'lost after the final dot', applied: 'unknown' }, calls: [{ op: 'send', applied: 'unknown' }] }; });
    return ctx.send;
  };
  const statusRun = async (channelId, events, cursor) => {
    await schedule();
    await db.exec(`INSERT INTO public.msg_jobs (org_id, kind, channel_id, status, next_run_at) SELECT org_id, 'status', id, 'queued', now() FROM public.msg_channels c
                    WHERE c.id = '${channelId}' AND NOT EXISTS (SELECT 1 FROM public.msg_jobs j WHERE j.channel_id = c.id AND j.kind = 'status' AND j.status = 'queued')`);
    const [r] = await runKind('status', channelId, () => ({ outcome: 'ok', effects: { events, next_cursor: cursor } }));
    return r && r.done;
  };
  let LU = null, MU = null;
  try { LU = await unknownOutbound(S.live.id, CH_LIVE); MU = await unknownOutbound(S.mock.id, CH_MOCK); }
  catch (e) { fail('H4 d setup', errText(e)); }
  if (LU && MU) {
    await check('security H4 d (live): a status-poll bounce for an UNKNOWN outbound is recorded, the state stays unknown (a human decides), the reply is not send_failed', async () => {
      const d = await statusRun(S.live.id, [{ provider_event_id: 'dsn:7:501', provider_request_id: LU.provider_request_id, status: 'bounced', error_code: '5.1.1' }], 'v1:7:501:20395');
      const o = await one(`SELECT state, reply_id FROM public.msg_outbound WHERE id = $1`, [LU.outbound_id]);
      const ev = await count(`SELECT count(*)::int n FROM public.msg_delivery_events WHERE outbound_id = $1 AND status = 'bounced' AND source = 'status_poll'`, [LU.outbound_id]);
      const rp = await one(`SELECT status FROM public.msg_replies WHERE id = $1`, [o.reply_id]);
      return (d && d.applied === 1 && o.state === 'unknown' && ev === 1 && rp.status !== 'send_failed' && (await chRow(S.live.id)).status_cursor === 'v1:7:501:20395') || J({ d, o, ev, rp });
    });
    await check('security H4 d: mock unchanged — the same bounce fails an unknown mock outbound', async () => {
      const d = await statusRun(S.mock.id, [{ provider_event_id: 'b-1', provider_request_id: MU.provider_request_id, status: 'bounced', error_code: 'mailbox_unavailable' }], 's1');
      const o = await one(`SELECT state FROM public.msg_outbound WHERE id = $1`, [MU.outbound_id]);
      return (d && d.applied === 1 && o.state === 'failed') || J({ d, o });
    });
    await check('security H4 d (live): an ACCEPTED outbound still becomes failed on a (provider-signed) bounce', async () => {
      const acc = await one(`SELECT o.id, o.provider_request_id FROM public.msg_outbound o WHERE o.channel_id = $1 AND o.state = 'accepted' ORDER BY o.created_at LIMIT 1`, [S.live.id]);
      const d = await statusRun(S.live.id, [{ provider_event_id: 'dsn:7:502', provider_request_id: acc.provider_request_id, status: 'bounced', error_code: '5.1.1' }], 'v1:7:502:20395');
      return (d && d.applied === 1 && (await one(`SELECT state FROM public.msg_outbound WHERE id = $1`, [acc.id])).state === 'failed') || J(d);
    });
  }

  const probeWith = async (channelId, eff) => {
    await R.probe('adminA', channelId);
    const [r] = await runKind('probe', channelId, () => ({ outcome: 'ok', effects: eff }));
    return r && r.done;
  };
  await check('correctness M7 (live): an ok probe seeds a missing / non-v1 poll and status cursor with the probe\'s INBOX position', async () => {
    await db.exec(`UPDATE public.msg_channels SET poll_cursor = 'c0', status_cursor = NULL WHERE id = '${S.live.id}'`);
    const d = await probeWith(S.live.id, { capabilities: CAPS, account: { address: CH_LIVE }, mailbox: { cursor: 'v1:9:777:20760' } });
    const c = await chRow(S.live.id);
    return (d.job_status === 'done' && c.status === 'connected' && c.poll_cursor === 'v1:9:777:20760' && c.status_cursor === 'v1:9:777:20760') || J({ d, p: c.poll_cursor, s: c.status_cursor });
  });
  await check('correctness M7 (live): an existing v1 cursor is kept; a malformed seed is ignored; the probe still connects', async () => {
    await db.exec(`UPDATE public.msg_channels SET poll_cursor = 'v1:9:800:20760', status_cursor = NULL WHERE id = '${S.live.id}'`);
    const d1 = await probeWith(S.live.id, { capabilities: CAPS, account: { address: CH_LIVE }, mailbox: { cursor: 'v1:9:900:20760' } });
    const c1 = await chRow(S.live.id);
    await db.exec(`UPDATE public.msg_channels SET status_cursor = NULL WHERE id = '${S.live.id}'`);
    const d2 = await probeWith(S.live.id, { capabilities: CAPS, account: { address: CH_LIVE }, mailbox: { cursor: "v1:9:1:2'; DROP" } });
    const c2 = await chRow(S.live.id);
    return (d1.job_status === 'done' && c1.poll_cursor === 'v1:9:800:20760' && c1.status_cursor === 'v1:9:900:20760' && d2.job_status === 'done' && c2.status_cursor === null && c2.status === 'connected') || J({ d1, d2, c1: [c1.poll_cursor, c1.status_cursor], c2: c2.status_cursor });
  });
  await check('correctness M7: a mock probe never seeds (the key is dropped before msg_apply_probe, which is unchanged)', async () => {
    await db.exec(`UPDATE public.msg_channels SET poll_cursor = NULL, status_cursor = NULL WHERE id = '${S.mock.id}'`);
    const d = await probeWith(S.mock.id, { capabilities: CAPS, account: { address: CH_MOCK }, mailbox: { cursor: 'v1:9:777:20760' } });
    const c = await chRow(S.mock.id);
    return (d.job_status === 'done' && c.status === 'connected' && c.poll_cursor === null && c.status_cursor === null) || J({ d, p: c.poll_cursor });
  });
}

/* ------------------------------------------------------------------ main */
const SECTIONS = [secMigration, secPrivileges, secChannels, secSchedule, secPoll, secDmarc, secOutbound, secReviewFixes];
async function main() {
  db = new PGlite();
  section('load shim + migrations + seed');
  const migFiles = fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!migFiles.includes(MIG)) { fail('G6c migration present', MIG + ' not found'); return finish(); }
  if (!await runFile(db, path.join(SUPA, 'tests', 'shim.sql'))) return finish();
  for (const m of migFiles) if (!await runFile(db, path.join(MIG_DIR, m))) return finish();
  if (!await runFile(db, path.join(SUPA, 'seed.sql'))) return finish();
  try { await fixtures(); pass('fixtures: org A admin / ops / clearance JED / branch manager JED, a verified agent contact'); }
  catch (e) { fail('fixtures', errText(e)); return finish(); }
  for (const s of SECTIONS) {
    try { await s(); }
    catch (e) { fail('section ' + s.name + ' aborted', errText(e) + '\n' + (e.stack || '').split('\n').slice(0, 4).join(' | ')); }
  }
  finish();
}
function finish() {
  console.log('\n' + '-'.repeat(70));
  if (fetchCalls) fail('no network', fetchCalls + ' fetch call(s)');
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
