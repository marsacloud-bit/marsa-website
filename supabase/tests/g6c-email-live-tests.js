#!/usr/bin/env node
/*
  Marsa (مرسى) — G6c live e-mail adapter tests (docs/online/G6C_LIVE_EMAIL.md § Tests; design § 6 items 3-7 and 9,
  adversarial review C1-C5, H3-H7, M1-M5, L1, L3). LOCAL TESTS ONLY, no DB.
  The REAL email-live.js + email-mime.js + adapters.js (+ worker.js / pipeline.js / ai-mock.js for runJob) talk to the
  scripted loopback IMAP + SMTP fake server in tests/lib/fake-mail-server.js through a net.connect-based connect().
  No real mailbox, no credential, no network beyond 127.0.0.1.

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g6c-email-live-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const FN = path.join(SUPA, 'functions', 'inbox-sync');

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g6c-email-live-tests'); };

const AD = require(path.join(FN, 'adapters.js'));
const MI = require(path.join(FN, 'email-mime.js'));
const EL = require(path.join(FN, 'email-live.js'));
const AI = require(path.join(FN, 'ai-mock.js'));
const PL = require(path.join(FN, 'pipeline.js'));
const WK = require(path.join(FN, 'worker.js'));
const FMS = require(path.join(SUPA, 'tests', 'lib', 'fake-mail-server.js'));
const DEPS = Object.assign({}, AD, MI, EL);              // what index.ts passes: the merged MarsaInbox API
const WDEPS = Object.assign({}, AD, AI, PL);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + (e && (e.stack || e.message)) ); }
}
const J = x => JSON.stringify(x);
const errOf = async p => { try { await p; return null; } catch (e) { return e; } };
const FIXED = '2026-11-03T09:00:00.000Z';
const clock = () => new Date(FIXED);
const TODAY = Math.floor(Date.parse(FIXED) / 86400000);

/* ------------------------------------------------------------------ fixtures */
const OWNER = 'no-reply@marsacloud.example';          // the IMAP / SMTP login mailbox
const CHANNEL = 'ops@marsacloud.example';             // the alias customers write to (= From of sends)
const PW = 'S3cr3t-"pw"\\x-Zq9';                       // quote + backslash: the quoted-LOGIN escaping path
const AGENT = 'agent@gulf-agent.example';
const AGENT2 = 'desk@port-office.example';
const SECRETS = [PW, Buffer.from(PW).toString('base64'), Buffer.from('\u0000' + OWNER + '\u0000' + PW).toString('base64'),
  '"' + PW.replace(/[\\"]/g, '\\$&') + '"', PW.replace(/[\\"]/g, '\\$&')];
const seen = [];                                       // every result / error the adapter produced (secret scan, item 9)
const keep = x => { seen.push(x); return x; };

function eml(o) {
  const h = [];
  if (o.from !== null) h.push('From: ' + (o.from || '"Gulf Agent" <' + AGENT + '>'));
  h.push('To: ' + (o.to || CHANNEL));
  if (o.cc) h.push('Cc: ' + o.cc);
  h.push('Subject: ' + (o.subject === undefined ? 'D/O ready' : o.subject));
  if (o.date !== null) h.push('Date: ' + (o.date || 'Tue, 03 Nov 2026 08:00:00 +0000'));
  if (o.msgid !== null) h.push('Message-ID: ' + (o.msgid || '<m' + Math.random().toString(36).slice(2) + '@gulf-agent.example>'));
  for (const x of o.headers || []) h.push(x);
  if (o.raw) return h.join('\r\n') + '\r\n' + o.raw;
  h.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8');
  return h.join('\r\n') + '\r\n\r\n' + (o.body === undefined ? 'Hello\r\n' : o.body);
}
// the provider's trusted A-R (authserv mx.fake.example) with dkim=pass by its own signing domain (security review H4 c)
const DSN_AR = 'Authentication-Results: mx.fake.example; spf=none smtp.mailfrom=<>; dkim=pass header.d=smtp.fake.example';
const DSN_CFG = { authservId: 'mx.fake.example', dsnDkimDomain: 'fake.example' };
function dsn(o) {
  const rc = (o.rcpts || [[AGENT, 'failed', '5.1.1']]).map(r => 'Final-Recipient: rfc822; ' + r[0] + '\r\nAction: ' + r[1] + '\r\nStatus: ' + r[2] + '\r\n').join('\r\n');
  return [...(o.auth === null ? [] : [o.auth || DSN_AR]), 'From: MAILER-DAEMON@smtp.fake.example', 'To: ' + OWNER, 'Subject: Undelivered Mail Returned to Sender', 'Date: Tue, 03 Nov 2026 08:30:00 +0000',
    'Message-ID: <dsn' + Math.random().toString(36).slice(2) + '@smtp.fake.example>', 'MIME-Version: 1.0', ...(o.headers || []),
    'Content-Type: multipart/report; report-type=delivery-status; boundary="RB"', '', '--RB', 'Content-Type: text/plain', '', 'Delivery failed.', '',
    '--RB', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; smtp.fake.example' + (o.envid ? '\r\nOriginal-Envelope-Id: ' + o.envid : ''), '', rc,
    '--RB', 'Content-Type: text/rfc822-headers', '', 'From: ' + (o.origFrom || CHANNEL), 'Message-ID: ' + (o.origMid || ('<' + o.envid + '@marsacloud.example>')), '',
    '--RB--', ''].join('\r\n');
}
const sendReq = (id, x) => Object.assign({ request_id: id, from: CHANNEL, to: [AGENT], cc: [], subject: 'Re: D/O ready', body_text: 'Dear agent,\n.\n..leading dots\nRegards',
  in_reply_to: null, references: null, attachments: [] }, x || {});

/* ------------------------------------------------------------------ SQL-side mirror (review C1 / C2) */
const SQL_EMAIL = /^[^\s@<>(),;:"\[\]\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const cpl = s => Array.from(String(s)).length;
function sqlProblems(c) {
  const p = [];
  const strings = [];
  (function walk(x) { if (typeof x === 'string') strings.push(x); else if (x && typeof x === 'object') for (const k of Object.keys(x)) { strings.push(k); walk(x[k]); } })(c);
  if (strings.some(s => s.includes('\u0000'))) p.push('NUL');
  if (strings.some(s => LONE.test(s))) p.push('lone surrogate');
  if (!c.provider_message_id || c.provider_message_id.length > 200 || /[\u0000-\u001f]/.test(c.provider_message_id)) p.push('pid');
  if (!SQL_EMAIL.test(c.from.address.toLowerCase())) p.push('from');
  for (const a of c.to.concat(c.cc)) if (!SQL_EMAIL.test(a.address.toLowerCase()) || (a.name && cpl(a.name) > 160)) p.push('rcpt ' + a.address);
  if (c.to.length > 50 || c.cc.length > 50) p.push('rcpt count');
  if (cpl(c.subject) > 500) p.push('subject');
  if (cpl(c.body_text) > 100000) p.push('body');
  if (c.headers.message_id && cpl(c.headers.message_id) > 998) p.push('mid');
  if (c.headers.references.length > 50 || c.headers.references.some(r => cpl(r) > 998)) p.push('refs');
  for (const a of c.attachments) if (!Number.isInteger(a.size_bytes) || a.size_bytes < 0 || a.size_bytes > 26214400 || cpl(a.mime_type) > 120) p.push('att ' + a.size_bytes);
  if (Number.isNaN(Date.parse(c.sent_at)) || !/^\d{4}-/.test(c.sent_at)) p.push('sent_at');
  return p;
}
function ingestable(raw) {
  const c = AD.normalizeInbound(raw, { kind: 'email', provider: 'imap' });
  const p = sqlProblems(c);
  return p.length ? p.join(',') : c;
}

/* ------------------------------------------------------------------ server + adapter factory */
let srv, ports, connect;
async function freshServer(o) {
  if (srv) await srv.stop();
  srv = FMS.createFakeMailServer(Object.assign({ owner: OWNER, users: { [OWNER]: PW }, clock }, o || {}));
  ports = await srv.start();
  connect = FMS.createNodeConnect();
  return srv;
}
function adapter(x) {
  const o = x || {};
  const rest = Object.assign({}, o);
  delete rest.imap; delete rest.smtp;
  return EL.createImapSmtpEmail(Object.assign({
    deps: DEPS, connect,
    imap: Object.assign({ host: 'imap.fake.test', port: ports.imapPort, user: OWNER, password: PW }, o.imap || {}),
    smtp: Object.assign({ host: 'smtp.fake.test', port: ports.smtpPort, user: OWNER, password: PW }, o.smtp || {}),
    fromAddress: 'Ops@MarsaCloud.example', fromName: 'Marsa Ops', msgidDomain: 'marsacloud.example', authservId: null,
    timeouts: { connect: 2000, cmd: 1500 }, clock
  }, rest));
}
const imapCmds = () => srv.log.imap.map(x => x.cmd);
const smtpLines = () => srv.log.smtp.map(x => x.line);
async function cursorNow(a) { return keep(await a.fetchInbound({ cursor: null, limit: 50 })).next_cursor; }
// the INBOX position right now (a null status cursor scans SINCE day − 2 instead, correctness review M7)
const statusNow = () => { const f = srv.mailbox.folder('INBOX'); return 'v1:' + f.uidvalidity + ':' + (f.uidnext - 1) + ':' + TODAY; };

/* ================================================================== tests */
async function staticChecks() {
  section('0. static: classic script, no network / env, dual export, vm load without TextDecoder');
  await freshServer();
  await check('email-live.js: no import / require / fetch / Deno. / process.env / key literal; G5 dual export', () => {
    const src = fs.readFileSync(path.join(FN, 'email-live.js'), 'utf8');
    const s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    const bad = [];
    if (/\brequire\s*\(|^\s*import\s|^\s*export\s/m.test(s)) bad.push('import/require');
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|Deno\.|process\.env/.test(s)) bad.push('network/env');
    if (/(sk_live|eyJ[A-Za-z0-9_-]{20,}|apikey\s*[:=]\s*['"][^'"]+['"])/i.test(s)) bad.push('key literal');
    if (!/module\.exports = API\) : \(globalThis\.MarsaInbox = Object\.assign\(globalThis\.MarsaInbox \|\| \{\}, API\)\)/.test(src)) bad.push('dual export');
    return bad.length === 0 || bad.join('; ');
  });
  await check('vm sandbox (no TextDecoder): adapters + email-mime + email-live load and fill MarsaInbox at call-time lookup', () => {
    const vm = require('vm');
    const sandbox = { crypto: globalThis.crypto, TextEncoder, console, setTimeout, clearTimeout };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of ['adapters.js', 'email-mime.js', 'email-live.js']) vm.runInContext(fs.readFileSync(path.join(FN, f), 'utf8'), sandbox, { filename: f });
    const M = sandbox.MarsaInbox;
    if (!M || typeof M.createImapSmtpEmail !== 'function' || typeof M.parseMessage !== 'function') return 'MarsaInbox incomplete';
    const a = M.createImapSmtpEmail({ connect: () => null, imap: {}, smtp: {} });     // deps from globalThis.MarsaInbox
    return (a.mode === 'live' && typeof a.send === 'function') || 'no adapter';
  });
  await check('pure-JS sha256 matches node crypto (Deno / Node without crypto.subtle)', () => {
    const c = require('crypto');
    for (const s of ['', 'abc', 'x'.repeat(1000), '<MRSO-0123@d>|a@b.example|Tue, 03 Nov 2026', 'مرحبا']) {
      if (EL.sha256HexPure(s) !== c.createHash('sha256').update(s).digest('hex')) return 'mismatch for length ' + s.length;
    }
    return true;
  });
  await check('config refusals are not_configured (no throw at build): 587, 143, missing creds, bad from', async () => {
    const out = [];
    for (const [cfg, code] of [[{ smtp: { port: 587 } }, 'smtp_port'], [{ smtp: { port: 25 } }, 'smtp_port'], [{ imap: { port: 143 } }, 'imap_port'],
      [{ imap: { password: '' } }, 'config_imap'], [{ fromAddress: 'not an address' }, 'config_from'], [{ connect: 'x' }, 'config_connect']]) {
      const a = adapter(cfg);
      for (const m of AD.CHANNEL_METHODS) { const e = keep(await errOf(a[m]({}))); if (!e || e.kind !== 'not_configured' || e.code !== code || e.applied !== 'no') out.push(m + ':' + J(cfg) + ':' + (e && e.code)); }
    }
    return out.length === 0 || out.join('; ');
  });
}

async function probeTests() {
  section('1. probe (design § 6 item 7, review H4)');
  await freshServer();
  await check('probe: 6 capability keys, account = configured from-address (lowercased), SASL-IR AUTHENTICATE PLAIN, Sent via SPECIAL-USE', async () => {
    const r = keep(await adapter().probe());
    const keys = Object.keys(r.capabilities).sort().join();
    const auth = srv.log.imap.find(x => x.cmd === 'AUTHENTICATE');
    return (keys === AD.CAPABILITY_KEYS.slice().sort().join() && r.account.address === CHANNEL && r.capabilities.send.supported && !r.capabilities.attachments.supported &&
      /INBOX\.Sent/.test(r.capabilities.lookup_send.evidence) && auth && /^M\d+ AUTHENTICATE PLAIN \S+$/.test(auth.line) && !imapCmds().includes('LOGIN') &&
      imapCmds().includes('EXAMINE') && !imapCmds().includes('SELECT') && Object.values(r.capabilities).every(c => c.evidence.length <= 200)) || J([r, srv.log.imap]);
  });
  await check('probe: wrong IMAP password → not_configured auth_failed (NO [AUTHENTICATIONFAILED]); fixed message', async () => {
    srv.reset(); srv.faults.imap.authFail = true;
    const e = keep(await errOf(adapter().probe()));
    return (e && e.kind === 'not_configured' && e.code === 'auth_failed' && e.applied === 'no' && e.message === 'imap login refused [AUTHENTICATIONFAILED]') || J(e);
  });
  await check('probe: SMTP 535 → not_configured auth_failed', async () => {
    srv.reset(); srv.faults.smtp.authFail = true;
    const e = keep(await errOf(adapter().probe()));
    return (e && e.kind === 'not_configured' && e.code === 'auth_failed' && /\(535 5\.7\.8\)/.test(e.message)) || J(e);
  });
  await check('LOGINDISABLED without AUTH=PLAIN → not_configured login_disabled and NO LOGIN command is ever sent (review M4)', async () => {
    srv.reset(); srv.faults.imap.loginDisabled = true;
    const e = keep(await errOf(adapter().probe()));
    return (e && e.kind === 'not_configured' && e.code === 'login_disabled' && !imapCmds().includes('LOGIN') && !imapCmds().includes('AUTHENTICATE')) || J([e, imapCmds()]);
  });
  await check('no SASL-IR: AUTHENTICATE PLAIN answers the "+" continuation; no AUTH=PLAIN: LOGIN with quoted escaping (" and \\) works', async () => {
    srv.reset(); srv.faults.imap.caps = ['IMAP4rev1', 'LITERAL+', 'SPECIAL-USE', 'AUTH=PLAIN'];
    const a = keep(await adapter().probe());
    const auth = srv.log.imap.find(x => x.cmd === 'AUTHENTICATE');
    srv.reset(); srv.faults.imap.caps = ['IMAP4rev1', 'SPECIAL-USE'];
    const b = keep(await adapter().probe());
    const login = srv.log.imap.find(x => x.cmd === 'LOGIN');
    return (a.account && auth && /AUTHENTICATE PLAIN$/.test(auth.line) && b.account && login && login.line.includes('"S3cr3t-\\"pw\\"\\\\x-Zq9"')) || J([auth, login]);
  });
  await check('non-ASCII password, no LITERAL+: LOGIN sends a synchronizing literal (never a quoted 8-bit string)', async () => {
    const pw2 = 'pässwörd-ü1';
    await freshServer({ users: { [OWNER]: pw2 } });
    srv.faults.imap.caps = ['IMAP4rev1', 'SPECIAL-USE'];
    const r = keep(await adapter({ imap: { password: pw2 }, smtp: { password: pw2 } }).probe());
    const login = srv.log.imap.find(x => x.cmd === 'LOGIN');
    await freshServer();
    return (r.account && login && /\{\d+\}$/.test(login.line) && !login.line.includes('pässwörd')) || J(login);
  });
  await check('SMTP AUTH LOGIN when PLAIN is not offered; no AUTH at all → not_configured auth_unsupported', async () => {
    srv.reset(); srv.faults.smtp.ext = ['SIZE 1000000', 'AUTH LOGIN'];
    const r = keep(await adapter().probe());
    const usedLogin = smtpLines().includes('AUTH LOGIN');
    srv.reset(); srv.faults.smtp.ext = ['SIZE 1000000'];
    const e = keep(await errOf(adapter().probe()));
    return (r.account && usedLogin && e && e.kind === 'not_configured' && e.code === 'auth_unsupported') || J([smtpLines(), e]);
  });
  await check('connect refused → network applied no; greeting slower than the command timeout → timeout applied no', async () => {
    srv.reset();
    const dead = adapter({ imap: { port: 1 } });
    const e1 = keep(await errOf(dead.probe()));
    srv.faults.smtp.slow = { stage: 'greeting', ms: 2500 };
    const t0 = Date.now();
    const e2 = keep(await errOf(adapter().probe()));
    srv.reset();
    return (e1 && e1.kind === 'network' && e1.applied === 'no' && e2 && e2.kind === 'timeout' && e2.applied === 'no' && Date.now() - t0 < 2400) || J([e1, e2]);
  });
}

async function cursorTests() {
  section('2. fetchInbound cursor (design § 6 item 3, review H6, H7, M1, M4, L1)');
  await freshServer();
  for (let i = 0; i < 3; i++) srv.mailbox.add('INBOX', eml({ subject: 'old ' + i }));
  const a = adapter();
  let cur;
  await check('first run: empty batch, cursor v1:<UIDVALIDITY>:<UIDNEXT-1>:<epochDay> (no history import)', async () => {
    const r = keep(await a.fetchInbound({ cursor: null, limit: 50 }));
    cur = r.next_cursor;
    const V = srv.mailbox.folder('INBOX').uidvalidity;
    return (r.messages.length === 0 && cur === 'v1:' + V + ':3:' + TODAY && cur.length <= 200) || J(r);
  });
  await check('increment + batch cap 10: 12 new → 10 then 2, cursor = last UID; nothing new → same cursor, empty', async () => {
    for (let i = 0; i < 12; i++) srv.mailbox.add('INBOX', eml({ subject: 'new ' + i }));
    const r1 = keep(await a.fetchInbound({ cursor: cur, limit: 50 }));
    const r2 = keep(await a.fetchInbound({ cursor: r1.next_cursor, limit: 50 }));
    const r3 = keep(await a.fetchInbound({ cursor: r2.next_cursor, limit: 50 }));
    const uids = r1.messages.concat(r2.messages).map(m => m.imap.uid);
    cur = r3.next_cursor;
    return (r1.messages.length === 10 && r2.messages.length === 2 && uids.join() === '4,5,6,7,8,9,10,11,12,13,14,15' && /:13:/.test(r1.next_cursor) &&
      /:15:/.test(r2.next_cursor) && r3.messages.length === 0 && r3.next_cursor === r2.next_cursor &&
      r1.messages.every(m => typeof ingestable(m) === 'object')) || J([r1.next_cursor, r2.next_cursor, r3, uids]);
  });
  await check('read-only: EXAMINE + BODY.PEEK only — no SELECT / STORE / non-PEEK BODY[]; \\Seen untouched on every message', () => {
    const lines = srv.log.imap.map(x => x.line);
    const bad = lines.filter(l => /\b(SELECT|STORE|EXPUNGE)\b/i.test(l) || /\bBODY\[/i.test(l));
    const seenFlags = srv.mailbox.find('INBOX', m => m.flags.has('\\Seen')).length;
    return (bad.length === 0 && seenFlags === 0 && lines.some(l => /BODY\.PEEK\[\]/.test(l))) || J(bad);
  });
  await check('H6: missing UIDNEXT + `UID last+1:*` returning a LOWER uid after an expunge → filtered (uid > last), empty', async () => {
    srv.reset(); srv.faults.imap.noUidnext = true;
    const f = srv.mailbox.folder('INBOX');
    const V = f.uidvalidity;
    srv.mailbox.expunge('INBOX', 15);                                   // highest is now 14, cursor says 15
    const r = keep(await a.fetchInbound({ cursor: 'v1:' + V + ':15:' + TODAY, limit: 50 }));
    const ok1 = r.messages.length === 0 && r.next_cursor === 'v1:' + V + ':15:' + TODAY && srv.log.imap.some(x => /UID SEARCH UID 16:\*/.test(x.line));
    const first = keep(await a.fetchInbound({ cursor: null }));          // first run without UIDNEXT → highest UID present
    srv.reset();
    return (ok1 && first.next_cursor === 'v1:' + V + ':14:' + TODAY) || J([r, first]);
  });
  await check('H6: explicit UID window when UIDNEXT is known (never `*`)', async () => {
    srv.reset();
    srv.mailbox.add('INBOX', eml({ subject: 'w' }));
    const r = keep(await a.fetchInbound({ cursor: cur, limit: 50 }));
    cur = r.next_cursor;
    const s = srv.log.imap.filter(x => x.cmd === 'UID SEARCH').map(x => x.line);
    return (r.messages.length === 1 && s.length === 1 && /UID SEARCH UID 16:\d+$/.test(s[0]) && !/\*/.test(s[0])) || J(s);
  });
  await check('M1: provider_message_id = mid:sha256(lower(msgid)|from|date)[:40]; same Message-ID from another sender ≠; no Message-ID → uid:V:UID', async () => {
    const V = srv.mailbox.folder('INBOX').uidvalidity;
    srv.mailbox.add('INBOX', eml({ msgid: '<Reused@Bulk.example>', date: 'Tue, 03 Nov 2026 07:00:00 +0000' }));
    srv.mailbox.add('INBOX', eml({ msgid: '<Reused@Bulk.example>', from: 'other@bulk-mailer.example', date: 'Tue, 03 Nov 2026 07:00:00 +0000' }));
    const u3 = srv.mailbox.add('INBOX', eml({ msgid: null }));
    const r = keep(await a.fetchInbound({ cursor: cur, limit: 50 }));
    cur = r.next_cursor;
    const want = 'mid:' + require('crypto').createHash('sha256').update('<reused@bulk.example>|' + AGENT + '|Tue, 03 Nov 2026 07:00:00 +0000').digest('hex').slice(0, 40);
    const ids = r.messages.map(m => m.id);
    const c3 = ingestable(r.messages[2]);
    return (ids[0] === want && ids[1] !== ids[0] && /^mid:[0-9a-f]{40}$/.test(ids[1]) && ids[2] === 'uid:' + V + ':' + u3 && typeof c3 === 'object' &&
      c3.headers.message_id === '<uid.' + V + '.' + u3 + '@imap.invalid>') || J(ids);
  });
  await check('DSN and loop-guard copies are skipped and the cursor still passes them; an outsider reusing an MRSO id is NOT skipped (L1)', async () => {
    const d = srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-AAAAAAAAAAAAAAAA' }));
    const lg = srv.mailbox.add('INBOX', eml({ from: '"Marsa Ops" <' + CHANNEL + '>', to: AGENT, msgid: '<MRSO-BBBBBBBBBBBBBBBB@marsacloud.example>' }));
    const out = srv.mailbox.add('INBOX', eml({ from: 'attacker@evil.example', msgid: '<MRSO-BBBBBBBBBBBBBBBB@marsacloud.example>' }));
    const r = keep(await a.fetchInbound({ cursor: cur, limit: 50 }));
    cur = r.next_cursor;
    const reasons = r.skipped.map(s => s.uid + ':' + s.reason).join();
    return (r.messages.length === 1 && r.messages[0].imap.uid === out && reasons === d + ':dsn,' + lg + ':loop_guard' && new RegExp(':' + out + ':').test(r.next_cursor)) || J([r.messages.map(m => m.imap.uid), r.skipped]);
  });
  await check('H7: UIDVALIDITY change → SINCE (cursor day − 2) resync, same mid: ids, raw.imap.resync, cursor on the new UIDVALIDITY', async () => {
    const before = keep(await a.fetchInbound({ cursor: 'v1:' + srv.mailbox.folder('INBOX').uidvalidity + ':0:' + TODAY, limit: 50 })).messages.filter(m => m.id.startsWith('mid:')).map(m => m.id);
    const V2 = srv.mailbox.changeUidValidity('INBOX');
    srv.reset();
    const r = keep(await a.fetchInbound({ cursor: cur, limit: 50 }));
    const s = srv.log.imap.find(x => x.cmd === 'UID SEARCH');
    const d = new Date((TODAY - 2) * 86400000);
    const since = d.getUTCDate() + '-' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + '-' + d.getUTCFullYear();
    const got = r.messages.map(m => m.id);
    cur = r.next_cursor;
    return (s && s.line.endsWith('UID SEARCH SINCE ' + since) && r.messages.length === 10 && r.messages.every(m => m.imap.resync === true && m.imap.uidvalidity === V2) &&
      got.filter(x => x.startsWith('mid:')).every(x => before.includes(x)) && r.next_cursor.startsWith('v1:' + V2 + ':10:')) || J([s, got.length, r.next_cursor]);
  });
  await check('cursor format stays ≤ 200 chars; a legacy v1:V:U cursor (no day) is accepted', async () => {
    const V = srv.mailbox.folder('INBOX').uidvalidity;
    const r = keep(await a.fetchInbound({ cursor: 'v1:' + V + ':' + (srv.mailbox.folder('INBOX').uidnext - 1) }));
    return (r.messages.length === 0 && r.next_cursor.length <= 200 && EL.parseCursor(r.next_cursor).day === TODAY) || J(r);
  });
}

async function sanitizeTests() {
  section('3. every raw passes normalizeInbound AND the SQL rules (review C1, C2, M2, M3)');
  await freshServer();
  const a = adapter();
  let cur = await cursorNow(a);
  const big = 'ب'.repeat(60000) + 'x'.repeat(60000);
  const cases = {
    nul: eml({ subject: 'bad\u0001sub\u0000ject', body: 'a\u0000b\u0007c\r\nok\r\n' }),
    rcpts: eml({ to: 'undisclosed-recipients:;', cc: 'bad@@x, "Grp": g1@grp.example, g2@grp.example;, Ok <ok@fine.example>, weird@localhost, "Doe, J" <J.Doe@Ex.example>' }),
    many: eml({ to: Array.from({ length: 40 }, (_, i) => 't' + i + '@many.example').join(', '), cc: Array.from({ length: 30 }, (_, i) => 'c' + i + '@many.example').join(', ') }),
    body: eml({ body: big }),
    nodate: eml({ date: null }),
    baddate: eml({ date: 'yesterday-ish' }),
    badcs: eml({ raw: 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=x-unknown-cs\r\nContent-Transfer-Encoding: 8bit\r\n\r\n\xff\xfe\xc3 broken utf-8 \xed\xa0\x80\r\n' }),
    nofrom: eml({ from: null }),
    badfrom: eml({ from: 'Nobody <not-an-address>' }),
    refs: eml({ headers: ['In-Reply-To: junk <ok-1@x.example> <ok-2@x.example>', 'References: ' + Array.from({ length: 30 }, (_, i) => '<r' + i + '@x.example>').join(' ') + ' <bad ref> <a\u0001b@x>'] }),
    att: eml({ raw: 'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="Z"\r\n\r\n--Z\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nsee attached\r\n--Z\r\n' +
      'Content-Type: application/pdf; name="DO\u0001.pdf"\r\nContent-Disposition: attachment; filename="DO.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--Z--\r\n' })
  };
  const uidOf = {};
  for (const k of Object.keys(cases)) uidOf[k] = srv.mailbox.add('INBOX', Buffer.from(cases[k], 'latin1'), { internaldate: k === 'nodate' ? '02-Nov-2026 10:00:00 +0300' : (k === 'baddate' ? 'garbage' : undefined) });
  srv.mailbox.folder('INBOX').messages.find(m => m.uid === uidOf.badcs).internaldate = '31-Feb-2026 10:00:00 +0000';
  const r1 = keep(await a.fetchInbound({ cursor: cur, limit: 50 }));
  const r2 = keep(await a.fetchInbound({ cursor: r1.next_cursor, limit: 50 }));
  const msgs = r1.messages.concat(r2.messages);
  const skipped = r1.skipped.concat(r2.skipped);
  const byUid = u => msgs.find(m => m.imap.uid === u);
  await check('C1: every produced raw normalizes and meets the SQL rules (NUL, controls, lone surrogates, sizes, addresses)', () => {
    const bad = msgs.map(m => [m.imap.uid, ingestable(m)]).filter(x => typeof x[1] === 'string');
    return (bad.length === 0 && msgs.length === Object.keys(cases).length - 2) || J([bad, msgs.length, skipped]);
  });
  await check('C1: unusable From → skipped (bad_from), cursor still passes it; no error, no block', () => {
    const r = skipped.map(s => s.reason).sort().join();
    return (r === 'bad_from,bad_from' && /:\d+:/.test(r2.next_cursor) && EL.parseCursor(r2.next_cursor).uid === Math.max(...Object.values(uidOf))) || J([skipped, r2.next_cursor]);
  });
  await check('C1: control characters and NUL stripped from subject + body', () => {
    const m = byUid(uidOf.nul);
    return (m.subject === 'badsubject' && m.text === 'abc\nok\n') || J([m.subject, m.text]);
  });
  await check('C2: group syntax, undisclosed-recipients:; and invalid recipients dropped and counted in raw.imap.dropped_rcpts; names kept', () => {
    const m = byUid(uidOf.rcpts);
    const addrs = m.to.concat(m.cc).map(x => x.address).join();
    return (m.to.length === 0 && addrs === 'ok@fine.example,j.doe@ex.example' && m.cc[1].name === 'Doe, J' && m.imap.dropped_rcpts === 5) || J([m.to, m.cc, m.imap]);
  });
  await check('C2: at most 50 recipients in all (to first), overflow counted', () => {
    const m = byUid(uidOf.many);
    const c = ingestable(m);
    return (m.to.length === 40 && m.cc.length === 10 && m.imap.dropped_rcpts === 20 && typeof c === 'object') || J([m.to.length, m.cc.length, m.imap]);
  });
  await check('M2: a 120000-code-point body is capped at ≤ 100000 code points INCLUDING the truncation marker', () => {
    const m = byUid(uidOf.body);
    const c = ingestable(m);
    return (cpl(m.text) <= 100000 && cpl(m.text) > 99000 && /\[…\]$/.test(m.text) && typeof c === 'object') || cpl(m.text);
  });
  await check('M3: no Date → INTERNALDATE (02-Nov style, +0300); bad Date + bad INTERNALDATE → clock; good Date wins over a bad INTERNALDATE', () => {
    const a1 = byUid(uidOf.nodate), a2 = byUid(uidOf.baddate), a3 = byUid(uidOf.badcs);
    return (a1.date === '2026-11-02T07:00:00.000Z' && a2.date === FIXED && a3.date === '2026-11-03T08:00:00.000Z') || J([a1.date, a2.date, a3.date]);
  });
  await check('unknown charset / broken UTF-8 → replacement characters, still ingestable', () => {
    const m = byUid(uidOf.badcs);
    return (/broken utf-8/.test(m.text) && !LONE.test(m.text) && typeof ingestable(m) === 'object') || J(m.text);
  });
  await check('H3 inbound: only valid msg-ids kept for In-Reply-To / References (≤ 20, newest), junk dropped', () => {
    const m = byUid(uidOf.refs);
    const c = ingestable(m);
    const R = m.headers.References;
    return (m.headers['In-Reply-To'] === '<ok-1@x.example>' && R.length === 20 && R.includes('<r29@x.example>') && !R.includes('<bad ref>') &&
      R.every(x => MI.isMsgId(x)) && typeof c === 'object' && c.headers.references.length === 20) || J(m.headers);
  });
  await check('attachment metadata: clean name, integer size, provider_attachment_id p<part>; raw holds no body', () => {
    const m = byUid(uidOf.att);
    const c = ingestable(m);
    return (m.attachments.length === 1 && m.attachments[0].provider_attachment_id === 'p2' && m.attachments[0].file_name === 'DO.pdf' &&
      Number.isInteger(m.attachments[0].size_bytes) && c.body_text.trim() === 'see attached' && !J(c.raw).includes('see attached') && c.raw.provider === 'imap') || J([m.attachments, c && c.raw]);
  });
  await check('C3: a message above maxMessageBytes is fetched as a partial window; attachment sizes from BODYSTRUCTURE, clamped ≤ 26214400', async () => {
    srv.reset();
    const b = adapter({ maxMessageBytes: 4096 });
    const c0 = await cursorNow(b);
    const huge = 'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="Q"\r\n\r\n--Q\r\nContent-Type: text/plain\r\n\r\nshort text first\r\n--Q\r\n' +
      'Content-Type: application/zip\r\nContent-Disposition: attachment; filename="big.zip"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + 'QUFB'.repeat(5000) + '\r\n--Q--\r\n';
    const u = srv.mailbox.add('INBOX', eml({ raw: huge }));
    srv.mailbox.folder('INBOX').messages.find(m => m.uid === u).bodystructure =
      '(("TEXT" "PLAIN" NIL NIL NIL "7BIT" 18 1 NIL NIL NIL NIL)("APPLICATION" "ZIP" NIL NIL NIL "BASE64" 99999999 NIL ("ATTACHMENT" ("FILENAME" "big.zip")) NIL NIL) "MIXED" ("BOUNDARY" "Q") NIL NIL NIL)';
    const r = keep(await b.fetchInbound({ cursor: c0 }));
    const m = r.messages[0];
    const peek = srv.log.imap.find(x => /BODY\.PEEK\[\]<0\.262144>/.test(x.line));
    return (m && m.imap.partial === true && peek && m.attachments[0].size_bytes === 26214400 && m.attachments[0].file_name === 'big.zip' &&
      /short text first/.test(m.text) && typeof ingestable(m) === 'object') || J([m, srv.log.imap.map(x => x.line)]);
  });
  await check('C3: per-call byte budget — once maxMessageBytes is used, the rest waits for the next call (cursor at the last processed)', async () => {
    srv.reset();
    const b = adapter({ maxMessageBytes: 3000 });
    const c0 = await cursorNow(b);
    const u1 = srv.mailbox.add('INBOX', eml({ body: 'a'.repeat(2000) }));
    srv.mailbox.add('INBOX', eml({ body: 'b'.repeat(2000) }));
    const r = keep(await b.fetchInbound({ cursor: c0 }));
    const r2 = keep(await b.fetchInbound({ cursor: r.next_cursor }));
    return (r.messages.length === 1 && EL.parseCursor(r.next_cursor).uid === u1 && r2.messages.length === 1) || J([r.next_cursor, r2.next_cursor]);
  });
}

async function wireTests() {
  section('4. wire robustness (review M4, M5, C3 deadline)');
  await freshServer();
  const a = adapter();
  let cur = await cursorNow(a);
  for (let i = 0; i < 3; i++) srv.mailbox.add('INBOX', eml({ subject: 'chunk ' + i, body: 'line\r\n'.repeat(50) }));
  await check('M4: replies delivered byte by byte (literals split over hundreds of reads) parse identically', async () => {
    const ref = keep(await a.fetchInbound({ cursor: cur }));
    srv.faults.imap.chunk = 1;
    const reads0 = connect.stats.reads;
    const r = keep(await a.fetchInbound({ cursor: cur }));
    const reads = connect.stats.reads - reads0;
    srv.reset();
    return (J(r.messages) === J(ref.messages) && r.messages.length === 3 && reads > 1000) || J([r.messages.length, reads]);
  });
  await check('M4: unsolicited EXISTS / EXPUNGE / FETCH / OK lines between every reply are ignored', async () => {
    srv.faults.imap.unsolicited = true;
    const r = keep(await a.fetchInbound({ cursor: cur }));
    srv.reset();
    return (r.messages.length === 3 && r.messages.every(m => m.imap.uid !== 999999)) || J(r);
  });
  await check('M5: a 1.5 MB literal over 1000-byte reads is assembled in linear time (chunk list)', async () => {
    const u = srv.mailbox.add('INBOX', eml({ body: ('0123456789abcdef'.repeat(4) + '\r\n').repeat(23000) }));
    srv.faults.imap.chunk = 1000;
    const t0 = Date.now();
    const r = keep(await a.fetchInbound({ cursor: 'v1:' + srv.mailbox.folder('INBOX').uidvalidity + ':' + (u - 1) + ':' + TODAY }));
    const ms = Date.now() - t0;
    srv.reset();
    return (r.messages.length === 1 && cpl(r.messages[0].text) === 100000 && ms < 8000) || J([r.messages.length, ms]);
  });
  await check('C3: the per-method deadline bounds a slow server (timeout applied no, well under the worker timer)', async () => {
    srv.faults.imap.slow = { cmd: 'UID FETCH', ms: 3000 };
    const b = adapter({ deadlineMs: 800, timeouts: { connect: 2000, cmd: 5000 } });
    const t0 = Date.now();
    const e = keep(await errOf(b.fetchInbound({ cursor: cur })));
    const ms = Date.now() - t0;
    srv.reset();
    return (e && e.kind === 'timeout' && e.applied === 'no' && ms < 1500) || J([e, ms]);
  });
  await check('IMAP NO [UNAVAILABLE] on EXAMINE-level failures → http_5xx (retryable); BYE greeting → http_5xx', async () => {
    const r = EL.classifyImapStatus({ status: 'NO', code: 'UNAVAILABLE' }, 'examine');
    const b = EL.classifyImapStatus({ status: 'BYE', code: null }, 'greeting');
    const l = EL.classifyImapStatus({ status: 'NO', code: 'LIMIT' }, 'login', true);
    return (r.kind === 'http_5xx' && b.kind === 'http_5xx' && l.kind === 'rate_limited' && AD.RETRYABLE_KINDS.includes(r.kind)) || J([r, b, l]);
  });
}

async function sendTests() {
  section('5. send (design § 6 item 4, review C3, C4, C5, H3, L3)');
  await freshServer();
  const a = adapter();
  await check('happy path: Message-ID <MRSO-…@domain>, ENVID + NOTIFY, envelope-only Bcc to the login mailbox, dot-stuffing, APPEND to Sent', async () => {
    const r = keep(await a.send(sendReq('MRSO-00000000000000A1', { cc: [{ address_norm: AGENT2 }], in_reply_to: '<orig-1@gulf-agent.example>', references: ['<root@gulf-agent.example>', '<orig-1@gulf-agent.example>'] })));
    const m = srv.smtp.messages[0];
    const hdr = m.data.toString('latin1').split('\r\n\r\n')[0];
    const body = MI.parseMessage(new Uint8Array(m.data)).text;
    const sent = srv.mailbox.find('INBOX.Sent');
    const self = srv.mailbox.find('INBOX', x => x.raw.includes('MRSO-00000000000000A1'));
    const L = smtpLines();
    return (r.provider_message_id === '<MRSO-00000000000000A1@marsacloud.example>' && r.status === 'accepted' && r.appended === true &&
      L.includes('MAIL FROM:<' + CHANNEL + '> RET=HDRS ENVID=MRSO-00000000000000A1') && L.includes('RCPT TO:<' + AGENT + '> NOTIFY=FAILURE,DELAY') &&
      L.includes('RCPT TO:<' + AGENT2 + '> NOTIFY=FAILURE,DELAY') && L.includes('RCPT TO:<' + OWNER + '> NOTIFY=NEVER') &&
      /^Message-ID: <MRSO-00000000000000A1@marsacloud\.example>$/m.test(hdr) && /^In-Reply-To: <orig-1@gulf-agent\.example>$/m.test(hdr) &&
      /^References: <root@gulf-agent\.example> <orig-1@gulf-agent\.example>$/m.test(hdr) && /^From: "Marsa Ops" <ops@marsacloud\.example>$/m.test(hdr) &&
      !new RegExp(OWNER).test(hdr) && /^Auto-Submitted: no$/m.test(hdr) &&
      m.wire.equals(m.data) && /^Content-Transfer-Encoding: base64$/m.test(hdr) &&      // base64 body: no line starts with "."

      body === 'Dear agent,\n.\n..leading dots\nRegards' && sent.length === 1 && sent[0].flags.has('\\Seen') && self.length === 1) || J([r, L, hdr]);
  });
  await check('dot-stuffing on the wire: a body line "." becomes ".." and the server un-stuffs it back exactly', async () => {
    const raw = EL.dotStuff(Buffer.from('a\r\n.\r\n..b\r\n'));
    return Buffer.from(raw).toString() === 'a\r\n..\r\n...b\r\n' && Buffer.from(EL.dotStuff(Buffer.from('.x'))).toString() === '..x\r\n';
  });
  await check('idempotent: a repeat with the same request_id is found (INBOX Bcc copy) and the server sees ZERO DATA', async () => {
    srv.reset();
    const r = keep(await a.send(sendReq('MRSO-00000000000000A1')));
    return (r.provider_message_id === '<MRSO-00000000000000A1@marsacloud.example>' && r.deduped === true && srv.smtp.dataCommands === 0 && !smtpLines().length) || J([r, smtpLines()]);
  });
  await check('idempotent via Sent only: the Bcc copy deleted, the APPENDed Sent copy still prevents a second DATA', async () => {
    srv.reset();
    for (const m of srv.mailbox.find('INBOX', x => x.raw.includes('MRSO-00000000000000A1'))) srv.mailbox.expunge('INBOX', m.uid);
    const r = keep(await a.send(sendReq('MRSO-00000000000000A1')));
    return (r.deduped === true && srv.smtp.dataCommands === 0) || J(r);
  });
  const matrix = [
    ['greeting 421', { failAt: { stage: 'greeting', code: 421 } }, 'rate_limited', 'smtp_421', 'no'],
    ['greeting 554', { failAt: { stage: 'greeting', code: 554 } }, 'validation', 'smtp_554', 'no'],
    ['ehlo 550', { failAt: { stage: 'ehlo', code: 550 } }, 'validation', 'smtp_550', 'no'],
    ['auth 535', { failAt: { stage: 'auth', code: 535 } }, 'not_configured', 'auth_failed', 'no'],
    ['MAIL 451', { failAt: { stage: 'mail', code: 451 } }, 'rate_limited', 'smtp_451', 'no'],
    ['MAIL 553', { failAt: { stage: 'mail', code: 553 } }, 'validation', 'smtp_553', 'no'],
    ['MAIL 552', { failAt: { stage: 'mail', code: 552 } }, 'validation', 'too_large', 'no'],
    ['RCPT 452 (L3: never retried)', { failAt: { stage: 'rcpt', code: 452 } }, 'validation', 'smtp_452', 'no'],
    ['RCPT 450', { failAt: { stage: 'rcpt', code: 450 } }, 'rate_limited', 'smtp_450', 'no'],
    ['DATA 451', { failAt: { stage: 'data', code: 451 } }, 'rate_limited', 'smtp_451', 'no'],
    ['DATA 554', { failAt: { stage: 'data', code: 554 } }, 'validation', 'smtp_554', 'no'],
    ['after "." 554', { failAt: { stage: 'dot', code: 554 } }, 'validation', 'smtp_554', 'no'],
    ['after "." 451', { failAt: { stage: 'dot', code: 451 } }, 'rate_limited', 'smtp_451', 'no'],
    ['dropped after "." (server)', { dropAfterDot: true, deliverOnDrop: false }, 'network', 'connection_lost', 'unknown'],
    ['no reply after "." (timeout)', { slow: { stage: 'dot', ms: 2500 } }, 'timeout', 'reply_timeout', 'unknown'],
    ['slow greeting (timeout before DATA)', { slow: { stage: 'greeting', ms: 2500 } }, 'timeout', 'reply_timeout', 'no']
  ];
  let n = 0;
  for (const [name, f, kind, code, applied] of matrix) {
    await check('§ 2 table: ' + name + ' → ' + kind + '/' + code + ' applied ' + applied, async () => {
      srv.reset();
      Object.assign(srv.faults.smtp, f);
      const id = 'MRSO-00000000000000' + (0xB0 + n++).toString(16).toUpperCase();
      const e = keep(await errOf(a.send(sendReq(id))));
      const pre = ['greeting', 'ehlo', 'auth', 'mail', 'rcpt'].includes(f.failAt && f.failAt.stage);
      const ok = e && AD.isAdapterError(e) && e.kind === kind && e.code === code && e.applied === applied &&
        (!pre || srv.smtp.dataCommands === 0) && (code !== 'smtp_452' || smtpLines().includes('RSET'));
      const w = WK.mapAdapterError(WDEPS, e);
      const expect = applied === 'unknown' ? 'unknown' : (AD.RETRYABLE_KINDS.includes(kind) ? 'retry' : 'failed');
      return (ok && w.outcome === expect && !/RCPT|MAIL FROM|AUTH|ops@|gulf-agent/i.test(e.message.replace(/^smtp (rcpt|mail|auth) refused/, ''))) || J([e, w, srv.smtp.dataCommands, smtpLines()]);
    });
  }
  await check('one RCPT rejected (550 5.1.1) → RSET, no DATA, validation smtp_550, nothing delivered (all or nothing)', async () => {
    srv.reset();
    srv.faults.smtp.rejectRcpt = { [AGENT2]: 550 };
    const e = keep(await errOf(a.send(sendReq('MRSO-00000000000000C1', { cc: [AGENT2] }))));
    return (e && e.code === 'smtp_550' && e.applied === 'no' && e.message === 'smtp rcpt refused (550 5.1.1)' && smtpLines().includes('RSET') && srv.smtp.dataCommands === 0 && srv.smtp.messages.length === 0) || J([e, smtpLines()]);
  });
  await check('C5: staging fault hook drop_after_dot → applied unknown; the server DID accept it; lookupSend finds the INBOX copy (C4)', async () => {
    srv.reset();
    const f = adapter({ fault: 'drop_after_dot' });
    const e = keep(await errOf(f.send(sendReq('MRSO-00000000000000C5'))));
    await new Promise(r => setTimeout(r, 100));
    const lk = keep(await a.lookupSend('MRSO-00000000000000C5'));
    return (e && e.applied === 'unknown' && e.kind === 'network' && srv.smtp.messages.length === 1 && srv.mailbox.find('INBOX.Sent', m => m.raw.includes('MRSO-00000000000000C5')).length === 0 &&
      lk.found === true && lk.found_in === 'inbox' && lk.provider_message_id === '<MRSO-00000000000000C5@marsacloud.example>') || J([e, lk]);
  });
  await check('C3: with < 15 s of budget left, DATA is never started (timeout applied no, RSET, zero DATA)', async () => {
    srv.reset();
    const b = adapter({ deadlineMs: 14000 });
    const e = keep(await errOf(b.send(sendReq('MRSO-00000000000000C3'))));
    return (e && e.kind === 'timeout' && e.code === 'budget' && e.applied === 'no' && srv.smtp.dataCommands === 0 && smtpLines().includes('RSET')) || J([e, smtpLines()]);
  });
  await check('APPEND failure after 250 is swallowed: ok, appended false (the send applied)', async () => {
    srv.reset(); srv.faults.imap.appendFail = true;
    const r = keep(await a.send(sendReq('MRSO-00000000000000D1')));
    return (r.status === 'accepted' && r.appended === false && srv.smtp.messages.length === 1) || J(r);
  });
  await check('validation before any connection: attachments, from mismatch, auto / own recipients, request_id, no recipient', async () => {
    srv.reset();
    const cases = [
      [sendReq('MRSO-00000000000000E1', { attachments: [{ document_id: 'd' }] }), 'attachments_unsupported'],
      [sendReq('MRSO-00000000000000E2', { from: 'other@marsacloud.example' }), 'from_mismatch'],
      [sendReq('MRSO-00000000000000E3', { from: OWNER }), 'from_mismatch'],
      [sendReq('MRSO-00000000000000E4', { to: ['postmaster@gulf-agent.example'] }), 'auto_recipient'],
      [sendReq('MRSO-00000000000000E5', { cc: [CHANNEL] }), 'auto_recipient'],
      [sendReq('MRSO-00000000000000E6', { to: [OWNER] }), 'auto_recipient'],
      [sendReq('MRSO-00000000000000E7', { to: ['noreply@x.example'] }), 'auto_recipient'],
      [sendReq('MRSO-bad'), 'request_id'],
      [sendReq('MRSO-00000000000000E8', { to: [] }), 'recipient'],
      [sendReq('MRSO-00000000000000E9', { to: ['ünï@x.example'] }), 'recipient']
    ];
    const bad = [];
    for (const [req, code] of cases) { const e = keep(await errOf(a.send(req))); if (!e || e.kind !== 'validation' || e.code !== code || e.applied !== 'no') bad.push(code + ':' + (e && e.code)); }
    return (bad.length === 0 && srv.log.imap.length === 0 && smtpLines().length === 0) || bad.join('; ');
  });
  await check('H3: CR/LF in subject is flattened; injected In-Reply-To / References are dropped, never written as headers', async () => {
    srv.reset();
    const r = keep(await a.send(sendReq('MRSO-00000000000000F1', { subject: 'Hi\r\nBcc: victim@evil.example', in_reply_to: '<x@y>\r\nBcc: victim@evil.example', references: ['<ok@y.example>', '<a b@y>', '<x@y>\r\nX-Evil: 1'] })));
    const hdr = srv.smtp.messages[0].data.toString('latin1').split('\r\n\r\n')[0];
    return (r.status === 'accepted' && !/^Bcc:|^X-Evil:/mi.test(hdr) && !/^In-Reply-To:/m.test(hdr) && /^References: <ok@y\.example>$/m.test(hdr) &&
      !srv.smtp.messages[0].rcpts.some(x => x.addr === 'victim@evil.example')) || hdr;
  });
}

async function lookupAndWorkerTests() {
  section('6. lookupSend + worker.runJob (design § 6 item 5, review C4, L1)');
  await freshServer();
  const a = adapter();
  await check('lookupSend: hit → {found:true, provider_message_id, status accepted}; miss → validation unsupported (never found:false)', async () => {
    await a.send(sendReq('MRSO-0000000000000101'));
    const hit = keep(await a.lookupSend('MRSO-0000000000000101'));
    const miss = keep(await errOf(a.lookupSend('MRSO-0000000000000102')));
    const bad = keep(await errOf(a.lookupSend('nope')));
    return (hit.found === true && hit.provider_message_id === '<MRSO-0000000000000101@marsacloud.example>' && hit.status === 'accepted' &&
      miss && miss.kind === 'validation' && miss.code === 'unsupported' && miss.applied === 'no' && bad && bad.code === 'request_id') || J([hit, miss]);
  });
  await check('L1: an outsider message carrying our Message-ID (From ≠ channel) is never taken as proof', async () => {
    srv.mailbox.add('INBOX', eml({ from: 'attacker@evil.example', msgid: '<MRSO-0000000000000103@marsacloud.example>' }));
    const e = keep(await errOf(a.lookupSend('MRSO-0000000000000103')));
    return (e && e.code === 'unsupported') || J(e);
  });
  const sctx = (id, prev) => ({ job: { id: 'j-' + id, org_id: 'o', kind: 'send', previous_status: prev || 'queued' }, channel: { id: 'c', kind: 'email', mode: 'live' },
    send: { outbound_id: 'ob-' + id, provider_request_id: id, from: CHANNEL, to: [AGENT], cc: [], subject: 'Secret subject line', body_text: 'Body MEDUJD481516',
      in_reply_to: null, references: [], attachments: [] } });
  await check('runJob send: ok found_by sent; calls carry no body / subject / address / password', async () => {
    srv.reset();
    const r = keep(await WK.runJob(sctx('MRSO-0000000000000201'), a, { deps: WDEPS, clock: () => FIXED, callTimeoutMs: 60000 }));
    const t = J(r.calls);
    return (r.outcome === 'ok' && r.effects.found_by === 'sent' && r.effects.provider_message_id === '<MRSO-0000000000000201@marsacloud.example>' &&
      !/Secret subject|MEDUJD481516|gulf-agent|marsacloud\.example>?"/.test(t.replace(/<MRSO-[0-9A-F]{16}@marsacloud\.example>/g, '')) && srv.smtp.dataCommands === 1) || J(r);
  });
  await check('runJob send: drop after "." → unknown; then previous_status unknown → lookup adopts (found_by lookup), exactly ONE DATA', async () => {
    srv.reset();
    srv.faults.smtp.dropAfterDot = true;
    const r1 = keep(await WK.runJob(sctx('MRSO-0000000000000202'), a, { deps: WDEPS, clock: () => FIXED }));
    srv.faults.smtp.dropAfterDot = false;
    await new Promise(r => setTimeout(r, 100));
    const r2 = keep(await WK.runJob(sctx('MRSO-0000000000000202', 'unknown'), a, { deps: WDEPS, clock: () => FIXED }));
    return (r1.outcome === 'unknown' && r1.calls[0].applied === 'unknown' && r2.outcome === 'ok' && r2.effects.found_by === 'lookup' &&
      r2.effects.provider_message_id === '<MRSO-0000000000000202@marsacloud.example>' && srv.smtp.dataCommands === 1) || J([r1, r2]);
  });
  await check('runJob send: lost and NOT delivered → lookup miss → unknown lookup_unsupported (human); the second run sends NO DATA (no re-send)', async () => {
    srv.reset();
    srv.faults.smtp.dropAfterDot = true; srv.faults.smtp.deliverOnDrop = false;
    const r1 = keep(await WK.runJob(sctx('MRSO-0000000000000203'), a, { deps: WDEPS, clock: () => FIXED }));
    srv.reset();
    const r2 = keep(await WK.runJob(sctx('MRSO-0000000000000203', 'unknown'), a, { deps: WDEPS, clock: () => FIXED }));
    return (r1.outcome === 'unknown' && r2.outcome === 'unknown' && r2.error.code === 'lookup_unsupported' && srv.smtp.dataCommands === 0 && r2.calls.length === 1) || J([r1, r2]);
  });
  await check('runJob send: 4xx before "." → retry applied no; 5xx → failed applied no; attachments → failed attachments_unsupported', async () => {
    srv.reset(); srv.faults.smtp.failAt = { stage: 'rcpt', code: 451 };
    const r1 = keep(await WK.runJob(sctx('MRSO-0000000000000204'), a, { deps: WDEPS, clock: () => FIXED }));
    srv.reset(); srv.faults.smtp.failAt = { stage: 'dot', code: 550 };
    const r2 = keep(await WK.runJob(sctx('MRSO-0000000000000205'), a, { deps: WDEPS, clock: () => FIXED }));
    const c3 = sctx('MRSO-0000000000000206'); c3.send.attachments = [{ document_id: 'd1', sha256: 'x' }];
    const r3 = keep(await WK.runJob(c3, a, { deps: WDEPS, clock: () => FIXED }));
    return (r1.outcome === 'retry' && r1.effects.applied === 'no' && r2.outcome === 'failed' && r2.effects.applied === 'no' &&
      r3.outcome === 'failed' && r3.error.code === 'attachments_unsupported') || J([r1, r2, r3]);
  });
  await check('runJob poll: first run sets the cursor; next run ingests normalized messages with mid: ids and advances', async () => {
    srv.reset();
    const ch = { id: 'c', kind: 'email', mode: 'live', poll_cursor: null };
    const p1 = keep(await WK.runJob({ job: { id: 'p1', org_id: 'o', kind: 'poll' }, channel: ch }, a, { deps: WDEPS, clock: () => FIXED }));
    srv.mailbox.add('INBOX', eml({ subject: 'طلب إذن تسليم', body: 'السادة مرسى\r\n' }));
    srv.mailbox.add('INBOX', eml({ from: null }));
    const p2 = keep(await WK.runJob({ job: { id: 'p2', org_id: 'o', kind: 'poll' }, channel: Object.assign({}, ch, { poll_cursor: p1.effects.next_cursor }) }, a, { deps: WDEPS, clock: () => FIXED }));
    const m = p2.effects.messages;
    return (p1.outcome === 'ok' && p1.effects.messages.length === 0 && /^v1:\d+:\d+:\d+$/.test(p1.effects.next_cursor) && p2.outcome === 'ok' && m.length === 1 &&
      m[0].subject === 'طلب إذن تسليم' && /^mid:/.test(m[0].provider_message_id) && m[0].raw.provider === 'imap' && sqlProblems(m[0]).length === 0 &&
      EL.parseCursor(p2.effects.next_cursor).uid > EL.parseCursor(p1.effects.next_cursor).uid) || J([p1, p2]);
  });
  await check('runJob probe: capabilities + account = channel address (SQL then checks it against address_norm)', async () => {
    const r = keep(await WK.runJob({ job: { id: 'pr', org_id: 'o', kind: 'probe' }, channel: { id: 'c', kind: 'email' } }, a, { deps: WDEPS, clock: () => FIXED }));
    return (r.outcome === 'ok' && r.effects.account.address === CHANNEL && r.effects.capabilities.lookup_send.supported === true) || J(r);
  });
  await check('runJob probe with a wrong password → failed not_configured auth_failed (not retried)', async () => {
    srv.reset(); srv.faults.imap.authFail = true;
    const r = keep(await WK.runJob({ job: { id: 'pr2', org_id: 'o', kind: 'probe' }, channel: { id: 'c', kind: 'email' } }, a, { deps: WDEPS, clock: () => FIXED }));
    srv.reset();
    return (r.outcome === 'failed' && r.error.kind === 'not_configured' && r.error.code === 'auth_failed') || J(r);
  });
}

async function dsnTests() {
  section('7. DSN status events (design § 6 item 6, review H5, security review H4)');
  await freshServer();
  const a = adapter(DSN_CFG);
  let cur;
  await check('first status run: SINCE (today − 2) scan, an uncorrelated DSN gives no event, cursor past it (independent of the poll cursor)', async () => {
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-00000000000003FF' }));
    const r = keep(await a.fetchStatusEvents({ cursor: null }));
    cur = r.next_cursor;
    return (r.events.length === 0 && /^v1:\d+:1:\d+$/.test(cur)) || J(r);
  });
  await check('5.1.1 for EVERY recipient (correlated by ENVID + original Message-ID) → one bounced event with provider_request_id', async () => {
    await a.send(sendReq('MRSO-0000000000000301', { cc: [AGENT2] }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000301', rcpts: [[AGENT, 'failed', '5.1.1'], [AGENT2, 'failed', '5.2.2']] }));
    const r = keep(await a.fetchStatusEvents({ cursor: cur }));
    cur = r.next_cursor;
    const e = r.events[0];
    return (r.events.length === 1 && e.status === 'bounced' && e.provider_request_id === 'MRSO-0000000000000301' && e.provider_message_id === '<MRSO-0000000000000301@marsacloud.example>' &&
      e.error_code === '5.1.1' && /^dsn:\d+:\d+$/.test(e.provider_event_id) && e.at === '2026-11-03T08:00:00.000Z') || J(r);
  });
  await check('H5: only one of two recipients failed → no event; delayed → no event; recipients split over two DSNs in one scan → bounced', async () => {
    await a.send(sendReq('MRSO-0000000000000302', { cc: [AGENT2] }));
    await a.send(sendReq('MRSO-0000000000000303'));
    await a.send(sendReq('MRSO-0000000000000304', { cc: [AGENT2] }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000302', rcpts: [[AGENT, 'failed', '5.1.1']] }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000303', rcpts: [[AGENT, 'delayed', '4.4.7']] }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000304', rcpts: [[AGENT, 'failed', '5.1.1']] }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000304', rcpts: [[AGENT2, 'failed', '5.1.1']] }));
    const r = keep(await a.fetchStatusEvents({ cursor: cur }));
    cur = r.next_cursor;
    return (r.events.length === 1 && r.events[0].provider_request_id === 'MRSO-0000000000000304') || J(r.events);
  });
  await check('H5: forged / uncorrelated DSNs ignored (unknown id, ENVID ≠ Message-ID, no own copy, no id at all)', async () => {
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000399' }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000301', origMid: '<MRSO-0000000000000302@marsacloud.example>' }));
    srv.mailbox.add('INBOX', dsn({ envid: null, origMid: '<someone@else.example>' }));
    const r = keep(await a.fetchStatusEvents({ cursor: cur }));
    cur = r.next_cursor;
    return r.events.length === 0 || J(r.events);
  });
  await check('security H4 c: a DSN counts only with dkim=pass by the provider domain in the trusted A-R (spf pass / another dkim domain / no A-R → ignored)', async () => {
    await a.send(sendReq('MRSO-0000000000000305'));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000305', auth: 'Authentication-Results: mx.fake.example; spf=pass smtp.mailfrom=evil.example; dkim=none' }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000305', auth: 'Authentication-Results: mx.fake.example; spf=pass smtp.mailfrom=evil.example; dkim=pass header.d=evil.example' }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000305', auth: 'Authentication-Results: mx.fake.example; dkim=pass header.d=fake.example.evil.example' }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000305', auth: null }));
    const r1 = keep(await a.fetchStatusEvents({ cursor: cur }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000305' }));
    const r2 = keep(await a.fetchStatusEvents({ cursor: r1.next_cursor }));
    cur = r2.next_cursor;
    return (r1.events.length === 0 && r2.events.length === 1) || J([r1.events, r2.events]);
  });
  await check('security H4 c: without authservId + dsnDkimDomain no DSN is read at all (no section fetch), probe says status_events unsupported', async () => {
    srv.reset();
    const b = adapter();
    await b.send(sendReq('MRSO-0000000000000307'));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000307' }));
    const r = keep(await b.fetchStatusEvents({ cursor: cur }));
    const p = keep(await b.probe());
    const fetched = srv.log.imap.some(x => x.cmd === 'UID FETCH' && /BODY\.PEEK\[2\]/.test(x.line));
    cur = keep(await a.fetchStatusEvents({ cursor: cur })).next_cursor;
    return (r.events.length === 0 && !fetched && p.capabilities.status_events.supported === false && keep(await a.probe()).capabilities.status_events.supported === true) || J([r, p.capabilities.status_events]);
  });
  await check('DSNs never reach fetchInbound; runJob status keeps the bounced event and the cursor', async () => {
    const c0 = 'v1:' + srv.mailbox.folder('INBOX').uidvalidity + ':0:' + TODAY;
    const p = keep(await a.fetchInbound({ cursor: c0, limit: 50 }));
    const all = [];
    let c = c0;
    for (let i = 0; i < 5; i++) { const x = keep(await a.fetchInbound({ cursor: c })); all.push(...x.skipped); c = x.next_cursor; }
    await a.send(sendReq('MRSO-0000000000000306'));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000306' }));
    const st = keep(await WK.runJob({ job: { id: 's', org_id: 'o', kind: 'status' }, channel: { id: 'c', kind: 'email', status_cursor: cur } }, a, { deps: WDEPS, clock: () => FIXED }));
    const ok = p.messages.every(m => !/Undelivered/.test(m.subject)) && all.some(s => s.reason === 'dsn') && st.outcome === 'ok' && st.effects.events.length === 1 &&
      st.effects.events[0].status === 'bounced' && st.effects.next_cursor !== cur;
    cur = st.effects.next_cursor;
    return ok || J([st, all]);
  });
  await check('UIDVALIDITY change on the status cursor → SINCE (day − 2) re-scan on the new UIDVALIDITY (already-applied bounces repeat with the same event id shape)', async () => {
    const V2 = srv.mailbox.changeUidValidity('INBOX');
    const r = keep(await a.fetchStatusEvents({ cursor: cur }));
    const hi = srv.mailbox.folder('INBOX').messages.slice(-1)[0].uid;
    return (r.next_cursor.startsWith('v1:' + V2 + ':') && EL.parseCursor(r.next_cursor).uid <= hi && r.events.every(e => /^dsn:\d+:\d+$/.test(e.provider_event_id))) || J(r);
  });
}

async function reviewFixTests() {
  section('9. security + correctness review fixes (regressions)');
  await freshServer();
  let a = adapter({ authservId: 'mx.fake.example' });
  const b64w = t => '=?UTF-8?B?' + Buffer.from(t, 'utf8').toString('base64') + '?=';
  const AR = x => 'Authentication-Results: mx.fake.example; ' + x;
  const RCV = 'Received: from relay.example by mx.fake.example; Tue, 03 Nov 2026 08:00:00 +0000';
  async function one(o) {
    const c0 = await cursorNow(a);
    const u = srv.mailbox.add('INBOX', eml(o));
    const r = keep(await a.fetchInbound({ cursor: c0 }));
    return { m: r.messages.find(x => x.imap.uid === u), r, u };
  }
  await check('security C1: a quoted display name holding "<ceo@bank>" never wins over the real angle-addr', async () => {
    const { m } = await one({ from: '"ceo@bank.example <ceo@bank.example>," <attacker@evil.example>', headers: [AR('dmarc=pass header.from=evil.example')] });
    const l1 = EL.parseAddressList('"x <a@b.example>" <c@d.example>').list;
    const l2 = EL.parseAddressList('<a@b.example> <c@d.example>, Name <e@f.example> trailing, ok@g.example');
    return (m && m.from.address === 'attacker@evil.example' && m.from.name === 'ceo@bank.example <ceo@bank.example>,' && m.auth.dmarc === 'pass' &&
      l1.length === 1 && l1[0].address === 'c@d.example' && l2.list.map(x => x.address).join() === 'ok@g.example' && l2.dropped === 2) || J([m && m.from, l1, l2]);
  });
  await check('security C2 / correctness C2: an RFC 2047 word is decoded only in the display name (From spoof, To injection, ":" in a name)', async () => {
    const x1 = await one({ from: b64w('ceo@bank.example <ceo@bank.example>,') + ' <attacker@evil.example>' });
    const x2 = await one({ to: b64w(CHANNEL + ',') + ' <a@b.example>' });
    const x3 = await one({ from: b64w('شركة الخليج: العمليات') + ' <' + AGENT + '>', to: b64w('فريق: مرسى') + ' <' + CHANNEL + '>' });
    const c = ingestable(x3.m);
    return (x1.m && x1.m.from.address === 'attacker@evil.example' && x1.m.from.name === 'ceo@bank.example <ceo@bank.example>,' &&
      x2.m && x2.m.to.map(t => t.address).join() === 'a@b.example' &&
      x3.m && x3.m.from.address === AGENT && x3.m.from.name === 'شركة الخليج: العمليات' && x3.m.to[0].address === CHANNEL && x3.m.to[0].name === 'فريق: مرسى' &&
      typeof c === 'object') || J([x1.m && x1.m.from, x2.m && x2.m.to, x3.m && [x3.m.from, x3.m.to], x3.r.skipped]);
  });
  await check('security H3: dmarc=pass counts only when its header.from is the stored From domain', async () => {
    const ok = await one({ headers: [AR('spf=pass; dkim=pass header.d=gulf-agent.example; dmarc=pass header.from=gulf-agent.example')] });
    const other = await one({ headers: [AR('spf=pass; dkim=pass header.d=evil.example; dmarc=pass header.from=evil.example')] });
    const none = await one({ headers: [AR('spf=pass; dmarc=pass')] });
    return (ok.m.auth.dmarc === 'pass' && other.m.auth.dmarc === 'none' && other.m.auth.dkim === 'pass' && none.m.auth.dmarc === 'none') || J([ok.m.auth, other.m.auth, none.m.auth]);
  });
  await check('security H3: two From headers, two mailboxes in From, or a Sender fallback → auth all none + imap.from_ambiguous', async () => {
    const pass = AR('spf=pass; dkim=pass; dmarc=pass header.from=gulf-agent.example');
    const two = await one({ headers: [pass, 'From: attacker@evil.example'] });
    const multi = await one({ from: AGENT + ', attacker@evil.example', headers: [pass] });
    const sender = await one({ from: 'not an address', headers: [pass, 'Sender: ' + AGENT] });
    const none = J({ spf: 'none', dkim: 'none', dmarc: 'none' });
    return ([two, multi, sender].every(x => x.m && J(x.m.auth) === none && x.m.imap.from_ambiguous === true) && two.m.from.address === AGENT) || J([two.m, multi.m, sender.m].map(m => m && [m.from, m.auth, m.imap]));
  });
  await check('security H5: an A-R below a Received header, or an RFC 2047-encoded A-R, is never trusted', async () => {
    const below = await one({ headers: [RCV, AR('spf=pass; dkim=pass; dmarc=pass header.from=gulf-agent.example')] });
    const above = await one({ headers: [AR('spf=pass; dkim=pass; dmarc=pass header.from=gulf-agent.example'), RCV] });
    const enc = await one({ headers: ['Authentication-Results: ' + b64w('mx.fake.example; spf=pass; dkim=pass; dmarc=pass header.from=gulf-agent.example')] });
    return (below.m.auth.dmarc === 'none' && below.m.auth.spf === 'none' && above.m.auth.dmarc === 'pass' && enc.m.auth.dmarc === 'none') || J([below.m.auth, above.m.auth, enc.m.auth]);
  });
  await check('security H4 a / M6: a look-alike copy <MRSO-…@evil> (From = channel) is no proof; a hit always returns OUR Message-ID', async () => {
    srv.reset();
    srv.mailbox.add('INBOX', eml({ from: '"Marsa Ops" <' + CHANNEL + '>', msgid: '<MRSO-0000000000000901@evil.example>' }));
    const e = keep(await errOf(a.lookupSend('MRSO-0000000000000901')));
    srv.mailbox.add('INBOX', eml({ from: '"Marsa Ops" <' + CHANNEL + '>', msgid: '<mrso-0000000000000902@MarsaCloud.Example>' }));
    const hit = keep(await a.lookupSend('MRSO-0000000000000902'));
    const sends = srv.smtp.dataCommands;
    const d = keep(await a.send(sendReq('MRSO-0000000000000901')));
    return (e && e.code === 'unsupported' && hit.provider_message_id === '<MRSO-0000000000000902@marsacloud.example>' && sends === 0 && !d.deduped && srv.smtp.dataCommands === 1) || J([e, hit, d]);
  });
  await check('security H4 b: a valid provider DSN with NO Sent copy (only the INBOX Bcc copy) produces no event', async () => {
    srv.reset();
    const d = adapter(Object.assign({ appendSent: false }, DSN_CFG));
    const c0 = statusNow();
    await d.send(sendReq('MRSO-0000000000000903'));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000903' }));
    const r = keep(await d.fetchStatusEvents({ cursor: c0 }));
    const inboxCopy = srv.mailbox.find('INBOX', m => m.raw.includes('MRSO-0000000000000903') && !/multipart\/report/.test(m.raw.toString())).length;
    return (r.events.length === 0 && inboxCopy === 1 && srv.mailbox.find('INBOX.Sent', m => m.raw.includes('MRSO-0000000000000903')).length === 0) || J(r);
  });
  await check('correctness C4: the status job fetches only HEADER + DSN sections (≤ 64 KiB each, never BODY[]) and ≤ 10 DSNs per call', async () => {
    srv.reset();
    const d = adapter(DSN_CFG);
    const c0 = statusNow();
    await d.send(sendReq('MRSO-0000000000000904'));
    const first = srv.mailbox.folder('INBOX').uidnext;
    for (let i = 0; i < 12; i++) srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000999' }));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000904' }));
    srv.reset();
    const r1 = keep(await d.fetchStatusEvents({ cursor: c0 }));
    const lines = srv.log.imap.filter(x => x.cmd === 'UID FETCH').map(x => x.line);
    const r2 = keep(await d.fetchStatusEvents({ cursor: r1.next_cursor }));
    return (r1.events.length === 0 && EL.parseCursor(r1.next_cursor).uid === first + 9 && !lines.some(l => /BODY\.PEEK\[\]/.test(l)) &&
      lines.filter(l => /BODY\.PEEK\[HEADER\]<0\.65536> BODY\.PEEK\[2\]<0\.65536> BODY\.PEEK\[3\]<0\.65536>/.test(l)).length === 10 &&
      r2.events.length === 1 && r2.events[0].provider_request_id === 'MRSO-0000000000000904') || J([r1, r2, lines.slice(0, 3)]);
  });
  await check('correctness M8: when the budget ends before correlation, the cursor stays below the uncorrelated DSN', async () => {
    srv.reset();
    const d = adapter(DSN_CFG);
    const c0 = statusNow();
    await d.send(sendReq('MRSO-0000000000000905'));
    const u = srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000905' }));
    srv.faults.imap.slow = { cmd: 'LIST', ms: 1500 };
    const slow = adapter(Object.assign({ deadlineMs: 6000, timeouts: { connect: 2000, cmd: 3000 } }, DSN_CFG));
    const r1 = keep(await slow.fetchStatusEvents({ cursor: c0 }));
    srv.reset();
    const r2 = keep(await d.fetchStatusEvents({ cursor: r1.next_cursor }));
    return (r1.events.length === 0 && EL.parseCursor(r1.next_cursor).uid === u - 1 && r2.events.length === 1) || J([r1, r2]);
  });
  await check('correctness M7: probe returns the INBOX cursor (runJob keeps it); a status run with no cursor still reads an early bounce', async () => {
    await freshServer();
    a = adapter({ authservId: 'mx.fake.example' });
    const d = adapter(DSN_CFG);
    const p = keep(await d.probe());
    const pj = keep(await WK.runJob({ job: { id: 'pr9', org_id: 'o', kind: 'probe' }, channel: { id: 'c', kind: 'email' } }, d, { deps: WDEPS, clock: () => FIXED }));
    const V = srv.mailbox.folder('INBOX').uidvalidity;
    await d.send(sendReq('MRSO-0000000000000906'));
    srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000906' }));
    const r = keep(await d.fetchStatusEvents({ cursor: null }));
    return (p.mailbox.cursor === 'v1:' + V + ':' + (srv.mailbox.folder('INBOX').uidnext - 3) + ':' + TODAY && pj.effects.mailbox.cursor === p.mailbox.cursor &&
      r.events.some(e => e.provider_request_id === 'MRSO-0000000000000906')) || J([p.mailbox, pj.effects, r]);
  });
  await check('correctness M6: a per-message FETCH NO skips the first of a batch (fetch_refused) or ends the call before a later one', async () => {
    srv.reset();
    const c0 = await cursorNow(a);
    const u1 = srv.mailbox.add('INBOX', eml({ subject: 'one' }));
    const u2 = srv.mailbox.add('INBOX', eml({ subject: 'two' }));
    srv.mailbox.add('INBOX', eml({ subject: 'three' }));
    srv.faults.imap.fetchNo = u2;
    const r1 = keep(await a.fetchInbound({ cursor: c0 }));
    const r2 = keep(await a.fetchInbound({ cursor: r1.next_cursor }));
    srv.reset();
    const r3 = keep(await a.fetchInbound({ cursor: r2.next_cursor }));
    return (r1.messages.length === 1 && EL.parseCursor(r1.next_cursor).uid === u1 && r2.messages.length === 0 && r2.skipped[0].uid === u2 && r2.skipped[0].reason === 'fetch_refused' &&
      EL.parseCursor(r2.next_cursor).uid === u2 && r3.messages.length === 1 && r3.messages[0].subject === 'three') || J([r1, r2, r3].map(x => [x.messages.length, x.skipped, x.next_cursor]));
  });
  await check('correctness M5: runJob poll records what the adapter skipped (uid + reason) in the fetchInbound call', async () => {
    srv.reset();
    const c0 = await cursorNow(a);
    const d = srv.mailbox.add('INBOX', dsn({ envid: 'MRSO-0000000000000907' }));
    const bad = srv.mailbox.add('INBOX', eml({ from: 'Nobody <not-an-address>' }));
    const r = keep(await WK.runJob({ job: { id: 'p9', org_id: 'o', kind: 'poll' }, channel: { id: 'c', kind: 'email', poll_cursor: c0 } }, a, { deps: WDEPS, clock: () => FIXED }));
    const sk = r.calls[0].response.skipped;
    return (r.outcome === 'ok' && J(sk) === J([{ uid: d, reason: 'dsn' }, { uid: bad, reason: 'bad_from' }])) || J(r.calls);
  });
  await check('correctness M9: probe proves send-as (MAIL FROM channel then RSET, no RCPT / DATA); a 553 → not_configured send_as_refused', async () => {
    srv.reset();
    const p = keep(await a.probe());
    const L = smtpLines();
    srv.reset(); srv.faults.smtp.rejectFrom = { [CHANNEL]: 553 };
    const e = keep(await errOf(a.probe()));
    return (p.capabilities.send.supported && L.includes('MAIL FROM:<' + CHANNEL + '>') && L.includes('RSET') && !L.some(l => /^RCPT|^DATA/.test(l)) &&
      e && e.kind === 'not_configured' && e.code === 'send_as_refused' && e.applied === 'no' && !/ops@|Sender address/.test(e.message)) || J([L, e]);
  });
  await check('C3 mid-method: DATA is not started once < 15 s are left after slow earlier stages (zero DATA, RSET)', async () => {
    srv.reset(); srv.faults.smtp.slow = { stage: 'rcpt', ms: 600 };
    const d = adapter({ deadlineMs: 16000, timeouts: { connect: 2000, cmd: 3000 } });
    const e = keep(await errOf(d.send(sendReq('MRSO-0000000000000908'))));
    return (e && e.kind === 'timeout' && e.code === 'budget' && e.applied === 'no' && srv.smtp.dataCommands === 0 && smtpLines().includes('RSET') &&
      smtpLines().filter(l => /^RCPT/.test(l)).length === 2) || J([e, smtpLines()]);
  });
  await check('low fixes: 454 at AUTH → rate_limited; a 452 on the mailbox copy → rate_limited; IMAP ≠ SMTP login → config_mailbox; legacy AUTH= EHLO line', async () => {
    const c454 = EL.classifySmtpReply({ code: 454 }, 'auth');
    srv.reset(); srv.faults.smtp.rejectRcpt = { [OWNER]: 452 };
    const e = keep(await errOf(a.send(sendReq('MRSO-0000000000000909'))));
    const m = keep(await errOf(adapter({ imap: { user: 'other@marsacloud.example' } }).probe()));
    srv.reset(); srv.faults.smtp.ext = ['SIZE 1000000', 'AUTH=PLAIN LOGIN'];          // legacy EHLO form only
    const legacy = keep(await a.probe());
    const usedPlain = smtpLines().some(l => /^AUTH PLAIN /.test(l));
    srv.reset();
    return (c454.kind === 'rate_limited' && e && e.kind === 'rate_limited' && e.applied === 'no' && srv.smtp.dataCommands === 0 && m && m.code === 'config_mailbox' &&
      legacy.account && usedPlain) || J([c454, e, m, usedPlain]);
  });
  await check('low fixes: invented <…@imap.invalid> ids never reach In-Reply-To / References of a send', async () => {
    srv.reset();
    await a.send(sendReq('MRSO-000000000000090A', { in_reply_to: '<uid.1.2@imap.invalid>', references: ['<root@gulf-agent.example>', '<uid.1.2@imap.invalid>', '<em-1@mock-mail.invalid>'] }));
    const hdr = srv.smtp.messages[0].data.toString('latin1').split('\r\n\r\n')[0];
    return (!/^In-Reply-To:/m.test(hdr) && /^References: <root@gulf-agent\.example>$/m.test(hdr)) || hdr;
  });
  await check('low fix: an SMTP reply over 200 lines closes the session (network smtp_parse), never desynchronises it', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => '250-x' + i).join('\r\n') + '\r\n250 end\r\n';
    let sent = false, closed = false;
    const sock = { read: async () => { if (sent) return null; sent = true; return new Uint8Array(Buffer.from('220 hi\r\n' + lines)); }, write: async () => {}, close: () => { closed = true; } };
    const E = (kind, message, code) => new AD.AdapterError(kind, message, { code, applied: 'no' });
    const m = new EL.SmtpClient({ E, connect: async () => sock, host: 'x', port: 465, budget: { left: () => 10000 } });
    await m.open();
    const e = await errOf(m.reply());
    return (e && e.kind === 'network' && e.code === 'smtp_parse' && closed) || J(e);
  });
}

async function secretTests() {
  section('8. secrets never leave the adapter (design § 6 item 9, review H4)');
  await check('the password (plain, base64, SASL PLAIN base64, quoted-escaped) appears in no result, error, toJSON or runJob output', () => {
    const blob = seen.map(x => {
      if (x instanceof Error) return J(x.toJSON ? x.toJSON() : {}) + ' ' + x.message + ' ' + (x.code || '') + ' ' + String(x.stack || '').split('\n')[0];
      return J(x);
    }).join('\n');
    const hits = SECRETS.filter(s => blob.includes(s));
    return (seen.length > 100 && hits.length === 0) || ('leaked ' + hits.length + ' forms over ' + seen.length + ' outputs');
  });
  await check('the adapter object exposes no config, host or credential (frozen, methods only)', async () => {
    await freshServer();
    const a = adapter();
    const s = J(a) + Object.keys(a).join() + J(Object.getOwnPropertyNames(a));
    return (Object.isFrozen(a) && !SECRETS.some(x => s.includes(x)) && !s.includes(OWNER) && !s.includes('imap.fake.test')) || s;
  });
  await check('error messages are fixed strings: no client command line, no server reply text', () => {
    const msgs = seen.filter(x => x instanceof Error).map(e => e.message);
    const bad = msgs.filter(m => /AUTH PLAIN [A-Za-z0-9+\/=]{8}|LOGIN "|RCPT TO:|MAIL FROM:|Recipient address rejected|Authentication failed\.|Invalid credentials|queued as|M\d{3} /.test(m));
    return (msgs.length > 20 && bad.length === 0) || J(bad);
  });
  await check('no fetch was ever called', () => fetchCalls === 0 || String(fetchCalls));
}

(async () => {
  console.log('G6c live e-mail adapter tests (loopback fake IMAP + SMTP, no DB, no real mailbox)');
  try {
    await staticChecks();
    await probeTests();
    await cursorTests();
    await sanitizeTests();
    await wireTests();
    await sendTests();
    await lookupAndWorkerTests();
    await dsnTests();
    await reviewFixTests();
    await secretTests();
  } catch (e) { fail('harness', String(e && e.stack)); }
  if (srv) await srv.stop();
  console.log('\n' + nPass + ' passed, ' + nFail + ' failed');
  if (nFail) { console.log(fails.map(f => ' - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})();
