#!/usr/bin/env node
/*
  Marsa (مرسى) — G6c live e-mail: email-mime.js unit tests (docs/online/G6C_LIVE_EMAIL.md § Tests). LOCAL TESTS ONLY.
  No DB, no network, no mailbox, no keys: parses the .eml fixtures in supabase/tests/fixtures/email/ and round-trips
  buildMessage() output through parseMessage(). Also loads email-mime.js as a classic script in a vm sandbox WITHOUT
  TextDecoder (the g6b-cycle-tests load-order sandbox) to prove the built-in charset tables match TextDecoder.

  Covers: parseMessage (headers, RFC 2047, charsets, base64 / QP / 7bit / 8bit, nesting, attachments, limits, body cap
  incl. marker = review M2, control stripping = review C1), parseAuthResults (topmost-only rule), parseDsn (RFC 3464),
  parseDate (RFC 5322 / INTERNALDATE = review M3), isMsgId (review H3), sanitizeText (review C1), buildMessage
  (round-trip, encoded words <= 75 chars without split UTF-8 = review L4, References folding, header-injection refusal).

  usage:
    NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/g6c-mime-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const FN = path.join(SUPA, 'functions', 'inbox-sync');
const FIX = path.join(SUPA, 'tests', 'fixtures', 'email');

// No network anywhere: any fetch is a test failure.
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network forbidden in g6c-mime-tests'); };

const MM = require(path.join(FN, 'email-mime.js'));
const AD = require(path.join(FN, 'adapters.js'));

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
const errText = e => (e && (e.message + ' ' + (e.code || ''))) || String(e);
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) pass(name);
    else fail(name, typeof r === 'string' ? r : 'assertion false');
  } catch (e) { fail(name, 'threw: ' + errText(e) + (e && e.stack && !QUIET ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : '')); }
}
function throwsCode(fn, code) {
  try { fn(); return 'did not throw'; }
  catch (e) { return (e && e.name === 'MimeError' && e.code === code) || ('wrong error: ' + (e && e.name) + ' ' + (e && e.code)); }
}
const J = x => JSON.stringify(x);
const fx = name => fs.readFileSync(path.join(FIX, name));
const parse = (name, o) => MM.parseMessage(new Uint8Array(fx(name)), o);
const str = u8 => Buffer.from(u8).toString('latin1');
const enc = s => new Uint8Array(Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8'));

const REQ = () => ({
  from: 'ops@marsa.example', from_name: 'مرسى — فريق العمليات', to: ['agent@gulf-agent.example', 'b@outside.example'], cc: ['docs@gulf-agent.example'],
  subject: 'رد: إذن تسليم البوليصة MEDUJD481516 للحاويتين MSKU7712050 و TGHU4829131 — عاجل جداً 🚢',
  body_text: 'السادة الكرام،\n.\n.leading dot line\nتم استلام الطلب.\r\nRegards',
  in_reply_to: '<plain-0001@gulf-agent.example>',
  references: ['<root-0001@gulf-agent.example>', 'not-a-msgid', '<bad id@x.example>', '<plain-0001@gulf-agent.example>']
});
const CFG = () => ({ messageId: '<MRSO-0123456789ABCDEF@marsa.example>', date: '2026-11-03T07:00:00.000Z', envelopeId: 'MRSO-0123456789ABCDEF' });

async function main() {
  /* ================================================================ 0. module shape */
  section('0. module shape, static rules, vm load without TextDecoder');
  await check('email-mime.js exposes the spec API', () => {
    const need = ['parseMessage', 'parseAuthResults', 'parseDsn', 'parseDate', 'isMsgId', 'sanitizeText', 'buildMessage', 'MimeError', 'MIME_LIMITS'];
    const miss = need.filter(n => !(n in MM));
    return miss.length === 0 || 'missing ' + miss.join(', ');
  });
  await check('classic script: no import / require, no fetch / Deno. / process.env, G5 dual export, no htmlToText overwrite', () => {
    const src = fs.readFileSync(path.join(FN, 'email-mime.js'), 'utf8');
    const s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    const bad = [];
    if (/\brequire\s*\(|^\s*import\s|^\s*export\s/m.test(s)) bad.push('import/require');
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|Deno\.|process\.env/.test(s)) bad.push('network/env');
    if (!/module\.exports = API\) : \(globalThis\.MarsaInbox = Object\.assign\(globalThis\.MarsaInbox \|\| \{\}, API\)\)/.test(src)) bad.push('dual export');
    if ('htmlToText' in MM) bad.push('exports htmlToText (would overwrite adapters.js on globalThis.MarsaInbox)');
    return bad.length === 0 || bad.join('; ');
  });
  const sandbox = { crypto: globalThis.crypto, TextEncoder, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  await check('vm sandbox (no TextDecoder): adapters.js + email-mime.js load, MarsaInbox merged, adapters htmlToText kept', () => {
    vm.runInContext(fs.readFileSync(path.join(FN, 'adapters.js'), 'utf8'), sandbox, { filename: 'adapters.js' });
    const before = sandbox.MarsaInbox.htmlToText;
    vm.runInContext(fs.readFileSync(path.join(FN, 'email-mime.js'), 'utf8'), sandbox, { filename: 'email-mime.js' });
    const M = sandbox.MarsaInbox;
    return (typeof sandbox.TextDecoder === 'undefined' && typeof M.parseMessage === 'function' && typeof M.normalizeInbound === 'function' &&
      M.htmlToText === before) || 'MarsaInbox incomplete or htmlToText replaced';
  });
  await check('built-in charset tables == TextDecoder for all 256 bytes (utf-8 sample, us-ascii, iso-8859-1/-6, windows-1252/-1256)', () => {
    const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;
    const bad = [];
    for (const cs of ['iso-8859-1', 'iso-8859-6', 'windows-1252', 'windows-1256']) {
      const a = sandbox.MarsaInbox.decodeCharset(all, cs);
      const b = new TextDecoder(cs).decode(all);
      if (a !== b) bad.push(cs);
    }
    const u = new Uint8Array(Buffer.from('مرسى 🚢 ok', 'utf8'));
    const broken = Uint8Array.from([0x61, 0xd9, 0x62, 0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x9a, 0x63]);
    if (sandbox.MarsaInbox.decodeCharset(u, 'utf-8') !== 'مرسى 🚢 ok') bad.push('utf-8');
    if (sandbox.MarsaInbox.decodeCharset(broken, 'utf-8') !== new TextDecoder('utf-8').decode(broken)) bad.push('utf-8 replacement');
    if (MM.decodeCharset(Uint8Array.from([0x41, 0xe9]), 'x-unknown-charset') !== 'A\ufffd') bad.push('unknown → utf-8 replacement');
    if (MM.decodeCharset(Uint8Array.from([0x41, 0xe9]), 'us-ascii') !== 'Aé') bad.push('us-ascii 8-bit → 1252');
    if (MM.decodeCharset(new Uint8Array(Buffer.from('é', 'utf8')), '') !== 'é') bad.push('undeclared valid utf-8');
    return bad.length === 0 || bad.join(', ');
  });
  await check('vm parse (built-in tables) == node parse (TextDecoder) for every fixture', () => {
    const bad = [];
    for (const f of fs.readdirSync(FIX).filter(x => x.endsWith('.eml'))) {
      const a = sandbox.MarsaInbox.parseMessage(new Uint8Array(fx(f)));
      const b = MM.parseMessage(new Uint8Array(fx(f)));
      if (J(a) !== J(b)) bad.push(f);
    }
    return bad.length === 0 || bad.join(', ');
  });

  /* ================================================================ 1. fixtures */
  section('1. parseMessage over the fixtures');
  await check('plain: headers unfolded + top first, header()/headerAll() case-insensitive, 7bit text, no attachments', () => {
    const p = parse('plain.eml');
    const rec = p.headerAll('RECEIVED');
    return (p.headers[0].name === 'Return-Path' && p.header('subject') === 'D/O ready - B/L MEDUJD481516' && p.header('x-none') === null &&
      p.headerAll('x-none').length === 0 && rec.length === 1 && !/[\r\n\t]/.test(rec[0]) && /by mx\.marsa-mail\.example with ESMTPS/.test(rec[0]) &&
      p.header('references') === '<root-0001@gulf-agent.example> <MRSO-0123456789ABCDEF@marsa.example>' &&
      p.header('cc') === '"Docs, Team" <docs@gulf-agent.example>' && p.text.startsWith('Dear Marsa team,\n\nThe delivery') && !p.text.includes('\r') &&
      p.html === null && p.htmlOnly === false && p.attachments.length === 0 && p.isDsn === false) || J(p);
  });
  await check('html-only: QP decoded, htmlToText (script/style/head dropped, entities), htmlOnly=true, html kept raw', () => {
    const p = parse('html-only.eml');
    return (p.htmlOnly === true && typeof p.html === 'string' && p.html.includes('<div style="display:none">') &&
      p.text === 'A violation was recorded for container CAIU5603185.\nhidden reviewer text\nFine & fees — ref V-2026-1023' &&
      !/alert|color:red|Notice/.test(p.text) && p.attachments.length === 0) || J({ text: p.text, htmlOnly: p.htmlOnly });
  });
  await check('Arabic windows-1256: 8bit body, B-encoded From name and Q-encoded subject in windows-1256', () => {
    const p = parse('arabic-1256.eml');
    return (p.text === 'السادة مرسى،\nنرجو العلم بأن إذن تسليم البوليصة رقم MEDUJD481516 جاهز.\nمع التحية\n' &&
      p.header('subject') === 'إذن تسليم' && p.header('from') === 'وكالة الخليج <ops@gulf-agent.example>') || J({ t: p.text, s: p.header('subject'), f: p.header('from') });
  });
  await check('RFC 2047 Arabic subject: words split mid-UTF-8 joined, folded words + plain text + lowercase q word, QP body soft breaks', () => {
    const p = parse('rfc2047-subject.eml');
    const want = fs.readFileSync(path.join(FIX, 'rfc2047-subject.expected.txt'), 'utf8');
    return (p.header('subject') === want && p.header('from') === 'مرسى Agent <agent@gulf-agent.example>' &&
      p.text === 'نرجو الإفادة. \nSecond line with a soft break.\n') || J({ s: p.header('subject'), want, t: p.text });
  });
  await check('nested multipart (mixed > related > alternative): text/plain base64 utf-8 chosen, html kept, 2 attachments', () => {
    const p = parse('nested-attachments.eml');
    const [img, pdf] = p.attachments;
    return (p.text === 'Please find the documents attached.\nشكرا' && /<b>attached<\/b>/.test(p.html) && p.htmlOnly === false && p.attachments.length === 2 &&
      img.part === '1.2' && img.file_name === 'شعار.png' && img.mime_type === 'image/png' && img.size_bytes === 301 && img.content_id === '<logo-1@gulf-agent.example>' &&
      pdf.part === '2' && pdf.file_name === 'Bill of Lading MEDUJD481516.pdf' && pdf.mime_type === 'application/pdf' && pdf.size_bytes === 3000 && pdf.content_id === null &&
      p.attachments.every(a => Number.isInteger(a.size_bytes))) || J(p.attachments);
  });
  await check('nested: RFC 2231 continuation filename wins over the RFC 2047 name=; JSON of the parse carries no attachment bytes', () => {
    const p = parse('nested-attachments.eml');
    const s = J(p);
    return (!s.includes('JVBERi0') && !s.includes('%PDF') && Array.isArray(p.parts) && !Object.keys(p).includes('parts')) || 'parts leaked into JSON';
  });
  await check('forged Authentication-Results: both headers kept in order; only the topmost is used', () => {
    const p = parse('forged-auth.eml');
    const all = p.headerAll('authentication-results');
    const a = MM.parseAuthResults(p, 'mx.marsa-mail.example');
    return (all.length === 2 && /softfail/.test(all[0]) && a.spf === 'none' && a.dkim === 'pass' && a.dmarc === 'fail') || J({ all, a });
  });
  await check('DSN fixture: isDsn, parseDsn → envelope id, original Message-ID from text/rfc822-headers (not the free text), recipients', () => {
    const p = parse('dsn-5.1.1.eml');
    const d = MM.parseDsn(p);
    return (p.isDsn === true && d && d.envelope_id === 'MRSO-0123456789ABCDEF' && d.original_message_id === '<MRSO-0123456789ABCDEF@marsa.example>' &&
      d.recipients.length === 2 && J(d.recipients[0]) === J({ final_recipient: 'nobody@outside.example', action: 'failed', status: '5.1.1' }) &&
      d.recipients[1].action === 'delayed' && d.recipients[1].status === '4.4.1') || J(d);
  });
  await check('no Message-ID: header() is null, the rest parses', () => {
    const p = parse('no-message-id.eml');
    return (p.header('message-id') === null && p.text === 'Hello, please send the pending documents.\n' && MM.parseDate(p.header('date')) === '2026-11-03T04:00:00.000Z') || J(p);
  });
  await check('oversized body (>100k): text capped at exactly 100000 code points INCLUDING the marker (review M2)', () => {
    const p = parse('oversized.eml');
    const n = Array.from(p.text).length;
    return (n === 100000 && p.text.endsWith('\n[…]') && fx('oversized.eml').length > 100000) || ('len ' + n);
  });
  await check('body cap counts code points (emoji never split), custom maxBody', () => {
    const body = '🚢'.repeat(40);
    const p = MM.parseMessage(enc('Subject: x\n\n' + body), { maxBody: 20 });
    const c = Array.from(p.text);
    return (c.length === 20 && p.text.endsWith('\n[…]') && c.slice(0, 16).every(x => x === '🚢') && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(p.text)) || p.text;
  });
  await check('odd Date (weekday name, 2-digit year, EST, comment) → parseDate ISO; missing Date → header null', () => {
    const a = parse('odd-date.eml'), b = parse('missing-date.eml');
    return (MM.parseDate(a.header('date')) === '2026-11-03T15:00:00.000Z' && b.header('date') === null && MM.parseDate(b.header('date')) === null) ||
      J([a.header('date'), MM.parseDate(a.header('date'))]);
  });
  await check('undisclosed-recipients To: kept verbatim, parse does not throw', () => {
    const p = parse('undisclosed.eml');
    return (p.header('to') === 'undisclosed-recipients:;' && p.header('bcc') === 'ops@marsa.example' && p.text === 'Circular.\n') || J(p.headers);
  });
  await check('NUL / C0 controls stripped from the body, tab + newline kept, bad UTF-8 → U+FFFD (no lone surrogate) (review C1)', () => {
    const p = parse('nul-byte.eml');
    return (!/[\u0000-\u0008\u000b-\u001f]/.test(p.text) && p.text === 'beforeafter\ttab\n\ufffd\ufffd\ufffdend\n' && !/[\ud800-\udfff]/.test(p.text)) || J(p.text);
  });
  await check('every fixture: canonical fields, integer sizes <= 26214400, text NUL-free and <= 100000 code points', () => {
    const bad = [];
    for (const f of fs.readdirSync(FIX).filter(x => x.endsWith('.eml'))) {
      const p = parse(f);
      if (!Array.isArray(p.headers) || typeof p.text !== 'string' || typeof p.htmlOnly !== 'boolean' || typeof p.isDsn !== 'boolean') bad.push(f + ' shape');
      if (/\u0000/.test(p.text) || Array.from(p.text).length > 100000) bad.push(f + ' text');
      for (const a of p.attachments) if (!Number.isInteger(a.size_bytes) || a.size_bytes < 0 || a.size_bytes > 26214400 || !a.file_name || !a.mime_type) bad.push(f + ' att');
      for (const h of p.headers) if (/[\r\n\u0000]/.test(h.value)) bad.push(f + ' header ' + h.name);
    }
    return bad.length === 0 || bad.join(', ');
  });
  await check('parsed fixtures feed normalizeInbound (adapters.js) without a rejection; raw keeps no body', () => {
    const bad = [];
    for (const f of ['plain.eml', 'html-only.eml', 'arabic-1256.eml', 'rfc2047-subject.eml', 'nested-attachments.eml', 'oversized.eml', 'nul-byte.eml']) {
      const p = parse(f);
      const from = /<([^>]+)>/.exec(p.header('from')) || [null, p.header('from')];
      const raw = {
        id: 'mid:' + f, provider: 'imap-test', from: { address: from[1] }, to: ['ops@marsa.example'], subject: p.header('subject'), text: p.text,
        headers: { 'Message-ID': p.header('message-id') }, auth: MM.parseAuthResults(p, null), date: MM.parseDate(p.header('date')),
        attachments: p.attachments.map(a => ({ provider_attachment_id: 'p' + a.part, file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes }))
      };
      try {
        const c = AD.normalizeInbound(raw);
        if (J(c.raw).includes(p.text.slice(0, 30))) bad.push(f + ' raw has body');
      } catch (e) { bad.push(f + ': ' + errText(e)); }
    }
    return bad.length === 0 || bad.join('; ');
  });

  /* ================================================================ 2. structure limits */
  section('2. parseMessage structure, limits and encodings');
  const nest = (depth) => {
    let m = 'Content-Type: text/plain\n\ndeep text\n';
    for (let i = depth; i >= 1; i--) m = 'Content-Type: multipart/mixed; boundary="b' + i + '"\n\n--b' + i + '\n' + m + '--b' + i + '--\n';
    return 'Subject: deep\n' + m;
  };
  await check('maxDepth: 4 levels parse, 6 levels stop (no text, no throw)', () => {
    const a = MM.parseMessage(enc(nest(4))), b = MM.parseMessage(enc(nest(6)));
    return (a.text === 'deep text' && b.text === '' && b.truncated === true) || J([a.text, b.text]);
  });
  await check('maxParts: 60 parts → at most 50 visited, no throw', () => {
    let m = 'Subject: many\nContent-Type: multipart/mixed; boundary=zz\n\n';
    for (let i = 0; i < 60; i++) m += '--zz\nContent-Type: application/octet-stream; name="f' + i + '.bin"\n\nxx\n';
    m += '--zz--\n';
    const p = MM.parseMessage(enc(m));
    const q = MM.parseMessage(enc(m), { maxParts: 5 });
    return (p.attachments.length === 49 && q.attachments.length === 4 && p.truncated) || (p.attachments.length + ' / ' + q.attachments.length);
  });
  await check('attachment size_bytes clamped to 26214400 and integer (estimate from encoded size, review C1)', () => {
    const head = 'Subject: big\nContent-Type: multipart/mixed; boundary=q\n\n--q\nContent-Type: text/plain\n\nhi\n--q\nContent-Type: application/zip; name=a.zip\nContent-Transfer-Encoding: 8bit\n\n';
    const buf = Buffer.concat([Buffer.from(head.replace(/\n/g, '\r\n')), Buffer.alloc(26214400 + 1000, 0x41), Buffer.from('\r\n--q\r\nContent-Type: application/pdf; name=b.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nQUJD\r\nRA==\r\n--q--\r\n')]);
    const p = MM.parseMessage(new Uint8Array(buf));
    return (p.attachments[0].size_bytes === 26214400 && p.attachments[1].size_bytes === 4 && p.text === 'hi') || J(p.attachments);
  });
  await check('single-part message: an attachment leaf is part "1"; a missing close delimiter keeps the tail', () => {
    const a = MM.parseMessage(enc('Content-Type: application/pdf\nContent-Disposition: attachment; filename="../../etc/x.pdf"\nContent-Transfer-Encoding: base64\n\nQUJDRA==\n'));
    const b = MM.parseMessage(enc('Content-Type: multipart/alternative; boundary=t\n\n--t\nContent-Type: text/plain\n\ntail text'));
    return (a.attachments.length === 1 && a.attachments[0].part === '1' && a.attachments[0].file_name === 'x.pdf' && a.attachments[0].size_bytes === 4 &&
      a.text === '' && b.text === 'tail text') || J([a.attachments, b.text]);
  });
  await check('decodeHeaderValue: raw 8-bit UTF-8 header, encoded word with CRLF payload cannot inject a line break', () => {
    const p = MM.parseMessage(new Uint8Array(Buffer.from('Subject: =?UTF-8?B?' + Buffer.from('a\r\nBcc: x@evil.example').toString('base64') + '?=\r\nX-Raw: مرسى\r\n\r\nb', 'utf8')));
    return (p.header('subject') === 'a Bcc: x@evil.example' && p.header('x-raw') === 'مرسى') || J(p.headers);
  });
  await check('base64Encode / base64Decode round trip (all byte values), lenient decode skips junk', () => {
    const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;
    const e = MM.base64Encode(all);
    return (e === Buffer.from(all).toString('base64') && str(Buffer.from(MM.base64Decode(e), 'latin1')) === str(all) && MM.base64Decode('QU\r\n J*D') === 'ABC') || 'mismatch';
  });

  /* ================================================================ 3. auth results */
  section('3. parseAuthResults (topmost-only, design § 4)');
  const ar = (...vals) => MM.parseMessage(enc(vals.map(v => 'Authentication-Results: ' + v).join('\n') + '\nSubject: x\n\nb'));
  await check('authservId null / empty → all none even with a pass header', () => {
    const p = ar('mx.example; spf=pass; dkim=pass; dmarc=pass');
    return (J(MM.parseAuthResults(p, null)) === J({ spf: 'none', dkim: 'none', dmarc: 'none' }) && J(MM.parseAuthResults(p, '')) === J(MM.parseAuthResults(p, null))) || 'not none';
  });
  await check('topmost authserv-id differs → all none, even when a LOWER header has the right id', () => {
    const p = ar('other.example; spf=fail', 'mx.example; spf=pass; dkim=pass; dmarc=pass');
    return J(MM.parseAuthResults(p, 'mx.example')) === J({ spf: 'none', dkim: 'none', dmarc: 'none' }) || J(MM.parseAuthResults(p, 'mx.example'));
  });
  await check('case-insensitive id, version token and comments ignored, softfail/neutral/temperror → none', () => {
    const a = MM.parseAuthResults(ar('MX.Example 1 (the mx); spf=softfail (sender not designated) smtp.mailfrom=a.example; dkim=neutral; dmarc=temperror'), 'mx.example');
    const b = MM.parseAuthResults(ar('mx.example; spf=pass; dkim=permerror; dmarc=pass'), 'MX.EXAMPLE');
    return (J(a) === J({ spf: 'none', dkim: 'none', dmarc: 'none' }) && J(b) === J({ spf: 'pass', dkim: 'none', dmarc: 'pass' })) || J([a, b]);
  });
  await check('dkim mix: any pass → pass; fail without pass → fail; spf fail / dmarc fail map to fail; "none" result header', () => {
    const a = MM.parseAuthResults(ar('mx.example; dkim=fail header.d=x; dkim=pass header.d=y'), 'mx.example');
    const b = MM.parseAuthResults(ar('mx.example; dkim=fail; dkim=policy; spf=fail; dmarc=fail'), 'mx.example');
    const c = MM.parseAuthResults(ar('mx.example; none'), 'mx.example');
    return (a.dkim === 'pass' && J(b) === J({ spf: 'fail', dkim: 'fail', dmarc: 'fail' }) && J(c) === J({ spf: 'none', dkim: 'none', dmarc: 'none' })) || J([a, b, c]);
  });
  await check('accepts a headers array too; plain fixture all pass with the right id', () => {
    const p = parse('plain.eml');
    return (J(MM.parseAuthResults(p.headers, 'mx.marsa-mail.example')) === J({ spf: 'pass', dkim: 'pass', dmarc: 'pass' }) &&
      J(MM.parseAuthResults(p, 'mx.other.example')) === J({ spf: 'none', dkim: 'none', dmarc: 'none' })) || 'bad';
  });

  /* ================================================================ 4. DSN */
  section('4. parseDsn (RFC 3464)');
  await check('non-DSN → null; multipart/report without a delivery-status part → null', () => {
    const r = MM.parseMessage(enc('Content-Type: multipart/report; report-type=disposition-notification; boundary=r\n\n--r\nContent-Type: text/plain\n\nread\n--r--\n'));
    return (MM.parseDsn(parse('plain.eml')) === null && MM.parseDsn(r) === null && r.isDsn === false && MM.parseDsn(null) === null) || 'not null';
  });
  await check('message/rfc822 original + xtext ENVID + invalid Message-ID in the original → null id', () => {
    const m = 'Content-Type: multipart/report; report-type="Delivery-Status"; boundary=d\n\n--d\nContent-Type: text/plain\n\nx\n--d\n' +
      'Content-Type: message/delivery-status\n\nOriginal-Envelope-Id: MRSO+2D0123456789ABCDEF\n\nFinal-Recipient: rfc822;<A@B.example>\nAction: Failed\nStatus: 5.2.2\n' +
      '--d\nContent-Type: message/rfc822\n\nMessage-ID: <bad id@x>\nSubject: s\n\nbody\n--d--\n';
    const p = MM.parseMessage(enc(m));
    const d = MM.parseDsn(p);
    return (p.isDsn && d.envelope_id === 'MRSO-0123456789ABCDEF' && d.original_message_id === null &&
      J(d.recipients) === J([{ final_recipient: 'a@b.example', action: 'failed', status: '5.2.2' }])) || J(d);
  });

  /* ================================================================ 5. dates, msg-ids, sanitize */
  section('5. parseDate, isMsgId, sanitizeText');
  await check('parseDate: RFC 5322, obsolete zones, 2-digit year, no seconds, INTERNALDATE (incl. space-padded), ISO, asctime', () => {
    const cases = [
      ['Tue, 03 Nov 2026 10:00:00 +0300', '2026-11-03T07:00:00.000Z'],
      ['3 Nov 2026 10:00 GMT', '2026-11-03T10:00:00.000Z'],
      ['Tue, 3 Nov 26 10:00:00 PDT', '2026-11-03T17:00:00.000Z'],
      ['Tue,  3 Nov 2026 10:00:00 -0000 (UTC)', '2026-11-03T10:00:00.000Z'],
      ['Tue, 03 Nov 2026 10:00:00 Z', '2026-11-03T10:00:00.000Z'],
      ['03-Nov-2026 10:00:00 +0300', '2026-11-03T07:00:00.000Z'],
      [' 3-Nov-2026 01:00:00 +0300', '2026-11-02T22:00:00.000Z'],
      ['2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.000Z'],
      ['2026-11-03T10:00:00+03:00', '2026-11-03T07:00:00.000Z'],
      ['Tue Nov  3 10:00:00 2026', '2026-11-03T10:00:00.000Z'],
      ['Mon, 31 Dec 99 23:59:60 +0000', '1999-12-31T23:59:59.000Z']
    ];
    const bad = cases.filter(([i, o]) => MM.parseDate(i) !== o).map(([i, o]) => i + ' → ' + MM.parseDate(i) + ' (want ' + o + ')');
    return bad.length === 0 || bad.join('; ');
  });
  await check('parseDate: invalid → null (garbage, empty, null, 30 Feb, 32 Nov, hour 25, bad zone, number)', () => {
    const bad = ['garbage', '', null, undefined, 'Mon, 30 Feb 2026 10:00:00 +0000', '32 Nov 2026 10:00:00 +0000', '3 Nov 2026 25:00:00 +0000',
      '3 Nov 2026 10:00:00 +9960', '3 Foo 2026 10:00:00 +0000', 1730000000, '03-Nov-2026 10:00:00'].filter(x => MM.parseDate(x) !== null);
    return bad.length === 0 || J(bad);
  });
  await check('isMsgId: ^<[^\\s<>()\\x00-\\x1f]{1,250}>$', () => {
    const yes = ['<a@b>', '<MRSO-0123456789ABCDEF@marsa.example>', '<' + 'x'.repeat(250) + '>'];
    const no = ['a@b', '<>', '<a b@c>', '<a\r\n@b>', '<a<b>', '<a(b)>', '<' + 'x'.repeat(251) + '>', '<a@b> ', null, 42, '<a\u0000b>'];
    const bad = yes.filter(x => !MM.isMsgId(x)).concat(no.filter(x => MM.isMsgId(x)));
    return bad.length === 0 || J(bad);
  });
  await check('sanitizeText: NUL + C0 stripped, \\t \\n \\r kept, lone surrogates dropped, pair kept, cut by code points', () => {
    const s = 'a\u0000b\u0001c\u001fd\te\nf\rg\u007f' + '\ud800x\udc00y' + '🚢🚢🚢';
    const r = MM.sanitizeText(s);
    const cut = MM.sanitizeText('🚢🚢🚢abc', 2);
    return (r === 'abcd\te\nf\rg\u007fxy🚢🚢🚢' && cut === '🚢🚢' && MM.sanitizeText(null) === '' && MM.sanitizeText(12, 1) === '1' && MM.sanitizeText('abc', 0) === '') || J([r, cut]);
  });

  /* ================================================================ 6. buildMessage */
  section('6. buildMessage (RFC 5322 output) + round trip');
  const out = MM.buildMessage(REQ(), CFG());
  const outS = str(out);
  await check('returns Uint8Array, pure ASCII, CRLF only (no bare LF / CR), lines <= 998, ends with CRLF', () => {
    return (out instanceof Uint8Array && !/[^\x00-\x7f]/.test(outS) && !/[^\r]\n/.test(outS) && !/\r(?!\n)/.test(outS) &&
      outS.split('\r\n').every(l => l.length <= 998) && outS.endsWith('\r\n')) || 'format';
  });
  const headBlock = outS.split('\r\n\r\n')[0];
  const words = headBlock.match(/=\?UTF-8\?B\?[^?]*\?=/g) || [];
  await check('headers present in order; Content-Type / CTE / MIME-Version / Auto-Submitted / Date / Message-ID exact', () => {
    const names = headBlock.split('\r\n').filter(l => !/^[ \t]/.test(l)).map(l => l.split(':')[0]);
    return (J(names) === J(['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding', 'Auto-Submitted']) &&
      headBlock.includes('\r\nDate: Tue, 03 Nov 2026 07:00:00 +0000\r\n') && headBlock.includes('\r\nMessage-ID: <MRSO-0123456789ABCDEF@marsa.example>\r\n') &&
      headBlock.includes('\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\nAuto-Submitted: no') &&
      !/envelope/i.test(headBlock)) || J(names);
  });
  await check('RFC 2047: every encoded word <= 75 chars and decodes as complete UTF-8 on its own (review L4)', () => {
    const bad = words.filter(w => w.length > 75 || new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(w.slice(10, -2), 'base64')).includes('\ufffd'));
    let fatalOk = true;
    for (const w of words) { try { new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(w.slice(10, -2), 'base64')); } catch (e) { fatalOk = false; } }
    return (words.length >= 3 && bad.length === 0 && fatalOk) || J(bad);
  });
  await check('body: base64 lines <= 76 chars; dot-leading lines NOT stuffed (SMTP client job)', () => {
    const body = outS.split('\r\n\r\n')[1];
    const lines = body.split('\r\n').filter(Boolean);
    const dec = Buffer.from(lines.join(''), 'base64').toString('utf8');
    return (lines.every(l => l.length <= 76 && /^[A-Za-z0-9+/=]+$/.test(l)) && dec.includes('\r\n.\r\n.leading dot line\r\n') && !dec.includes('..')) || dec;
  });
  await check('round trip through parseMessage: From name, To, Cc, Subject, body text, In-Reply-To, References (invalid dropped)', () => {
    const p = MM.parseMessage(out);
    const r = REQ();
    return (p.header('from') === r.from_name + ' <ops@marsa.example>' && p.header('to') === 'agent@gulf-agent.example, b@outside.example' &&
      p.header('cc') === 'docs@gulf-agent.example' && p.header('subject') === r.subject &&
      p.text === 'السادة الكرام،\n.\n.leading dot line\nتم استلام الطلب.\nRegards' && p.header('in-reply-to') === '<plain-0001@gulf-agent.example>' &&
      p.header('references') === '<root-0001@gulf-agent.example> <plain-0001@gulf-agent.example>' && p.header('auto-submitted') === 'no' &&
      MM.parseDate(p.header('date')) === '2026-11-03T07:00:00.000Z' && p.header('message-id') === '<MRSO-0123456789ABCDEF@marsa.example>' && p.attachments.length === 0) ||
      J({ f: p.header('from'), s: p.header('subject'), t: p.text, refs: p.header('references') });
  });
  await check('References: 25 ids → root + newest 19, folded at 78 chars per line; invalid In-Reply-To dropped; string form accepted', () => {
    const ids = Array.from({ length: 25 }, (_, i) => '<ref-' + String(i).padStart(2, '0') + '-abcdefghij@gulf-agent.example>');
    const s = str(MM.buildMessage(Object.assign(REQ(), { references: ids.join(' '), in_reply_to: 'no-brackets@x' }), CFG()));
    const h = s.split('\r\n\r\n')[0];
    const refLines = h.slice(h.indexOf('References:')).split('\r\n');
    const block = [refLines[0]].concat(refLines.slice(1).filter((l, i, a) => /^ /.test(l) && a.slice(0, i).every(x => /^ /.test(x))));
    const p = MM.parseMessage(new Uint8Array(Buffer.from(s, 'latin1')));
    const got = p.header('references').split(' ');
    return (!/In-Reply-To/.test(h) && block.length > 1 && block.every(l => l.length <= 78) && got.length === 20 && got[0] === ids[0] && got[1] === ids[6] && got[19] === ids[24]) ||
      J({ block, got: got.length });
  });
  await check('plain ASCII subject: folded at spaces (<= 78 per line), unfolds back; empty subject; ASCII display name quoted', () => {
    const subj = 'Re: Delivery order for B/L MEDUJD481516 containers MSKU7712050 and TGHU4829131 ready for collection today';
    const s = str(MM.buildMessage(Object.assign(REQ(), { subject: subj, from_name: 'Marsa "Ops" \\ Team' }), CFG()));
    const h = s.split('\r\n\r\n')[0];
    const lines = h.slice(h.indexOf('Subject:')).split('\r\n');
    const p = MM.parseMessage(new Uint8Array(Buffer.from(s, 'latin1')));
    const e = MM.parseMessage(MM.buildMessage(Object.assign(REQ(), { subject: '', from_name: null, cc: null }), CFG()));
    return (!h.includes('=?') && lines[0].length <= 78 && /^ /.test(lines[1]) && p.header('subject') === subj && /^From: "Marsa \\"Ops\\" \\\\ Team" <ops@marsa\.example>/m.test(h) &&
      e.header('subject') === '' && e.header('from') === 'ops@marsa.example' && e.header('cc') === null) || J({ lines: lines.slice(0, 3), s: p.header('subject') });
  });
  await check('header injection: CR / LF / NUL in any header input → MimeError header_injection (fixed message, input not echoed)', () => {
    const evil = 'x\r\nBcc: victim@evil.example';
    const muts = [
      r => { r.subject = evil; }, r => { r.subject = 'a\nb'; }, r => { r.from_name = evil; }, r => { r.from = 'ops@marsa.example\r\nBcc: v@evil.example'; },
      r => { r.to = ['a@b.example', evil]; }, r => { r.cc = [evil]; }, r => { r.in_reply_to = '<a@b>\r\nBcc: v@evil.example'; },
      r => { r.references = ['<a@b>', '<c@d>\nX: y']; }, r => { r.references = '<a@b>\r\n<c@d>'; }, r => { r.subject = 'a\u0000b'; }
    ];
    const bad = [];
    muts.forEach((m, i) => {
      const r = REQ(); m(r);
      try { MM.buildMessage(r, CFG()); bad.push('#' + i + ' no throw'); }
      catch (e) { if (e.name !== 'MimeError' || e.code !== 'header_injection' || /evil|victim|Bcc/.test(e.message + J(e))) bad.push('#' + i + ' ' + e.code); }
    });
    const c = CFG(); c.messageId = '<MRSO-0123456789ABCDEF@marsa.example>\r\nBcc: v@evil.example';
    const r1 = throwsCode(() => MM.buildMessage(REQ(), c), 'header_injection');
    if (r1 !== true) bad.push('messageId ' + r1);
    return bad.length === 0 || bad.join('; ');
  });
  await check('addresses: non-ASCII → non_ascii_address; malformed → bad_address; no To → no_recipient', () => {
    const t = [
      throwsCode(() => MM.buildMessage(Object.assign(REQ(), { to: ['مرسى@example.com'] }), CFG()), 'non_ascii_address'),
      throwsCode(() => MM.buildMessage(Object.assign(REQ(), { cc: ['ops@exämple.com'] }), CFG()), 'non_ascii_address'),
      throwsCode(() => MM.buildMessage(Object.assign(REQ(), { from: 'Marsa <ops@marsa.example>' }), CFG()), 'bad_address'),
      throwsCode(() => MM.buildMessage(Object.assign(REQ(), { to: ['a@b.example, c@d.example'] }), CFG()), 'bad_address'),
      throwsCode(() => MM.buildMessage(Object.assign(REQ(), { to: ['undisclosed-recipients:;'] }), CFG()), 'bad_address'),
      throwsCode(() => MM.buildMessage(Object.assign(REQ(), { to: [{ address: 'a@b.example' }] }), CFG()), 'bad_address'),
      throwsCode(() => MM.buildMessage(Object.assign(REQ(), { to: [] }), CFG()), 'no_recipient')
    ].filter(x => x !== true);
    return t.length === 0 || J(t);
  });
  await check('cfg: non-MRSO / malformed Message-ID → bad_message_id; invalid date → bad_date; Date object accepted', () => {
    const t = [
      throwsCode(() => MM.buildMessage(REQ(), Object.assign(CFG(), { messageId: '<abc@marsa.example>' })), 'bad_message_id'),
      throwsCode(() => MM.buildMessage(REQ(), Object.assign(CFG(), { messageId: 'MRSO-0123456789ABCDEF@marsa.example' })), 'bad_message_id'),
      throwsCode(() => MM.buildMessage(REQ(), Object.assign(CFG(), { messageId: '<MRSO-0123456789abcdef@marsa.example>' })), 'bad_message_id'),
      throwsCode(() => MM.buildMessage(REQ(), Object.assign(CFG(), { date: 'not a date' })), 'bad_date')
    ].filter(x => x !== true);
    const d = str(MM.buildMessage(REQ(), Object.assign(CFG(), { date: new Date(Date.UTC(2026, 0, 5, 3, 4, 5)) })));
    return (t.length === 0 && d.includes('\r\nDate: Mon, 05 Jan 2026 03:04:05 +0000\r\n')) || J(t);
  });
  await check('body: NUL / controls stripped, CR / LF normalised to CRLF, lone surrogate dropped; long Arabic display name folds', () => {
    const r = Object.assign(REQ(), { body_text: 'a\u0000b\rc\nd\r\ne\ud800f', from_name: 'شركة مرسى للخدمات اللوجستية والتخليص الجمركي والشحن البحري' });
    const s = str(MM.buildMessage(r, CFG()));
    const p = MM.parseMessage(new Uint8Array(Buffer.from(s, 'latin1')));
    const fromLines = s.slice(0, s.indexOf('\r\nTo:')).split('\r\n');
    return (p.text === 'ab\nc\nd\ne' + 'f' && fromLines.length > 1 && fromLines.every(l => l.length <= 998) &&
      p.header('from') === r.from_name + ' <ops@marsa.example>') || J({ t: p.text, f: p.header('from') });
  });
  await check('MimeError: toJSON has name/code/message only; fixed message', () => {
    try { MM.buildMessage(Object.assign(REQ(), { subject: 'secret-subject\r\n' }), CFG()); return 'no throw'; }
    catch (e) { return (J(e) === J({ name: 'MimeError', code: 'header_injection', message: 'header input contains a line break' })) || J(e); }
  });

  /* ================================================================ 7. review fixes */
  section('7. review fixes: linear MIME work (correctness C1), raw headers (security C2), A-R trust (security H3 / H5)');
  const cpuMs = fn => { const t = process.cpuUsage(); fn(); const u = process.cpuUsage(t); return (u.user + u.system) / 1000; };
  const HDR = 'From: a@b.example\r\nTo: c@d.example\r\nSubject: x\r\nMIME-Version: 1.0\r\n';
  const bad = {
    qp_blank_run: HDR + 'Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' + ' '.repeat(200000) + 'x\r\n',
    html_lt_run: HDR + 'Content-Type: text/html\r\n\r\n' + '<'.repeat(200000),
    html_unclosed_style: HDR + 'Content-Type: text/html\r\n\r\n' + '<style>'.repeat(30000),
    html_unclosed_comment: HDR + 'Content-Type: text/html\r\n\r\n' + '<!--'.repeat(50000),
    html_script_no_gt: HDR + 'Content-Type: text/html\r\n\r\n' + '<script'.repeat(30000),
    html_blank_run: HDR + 'Content-Type: text/html\r\n\r\n' + ' '.repeat(200000) + 'x',
    header_blank_run: 'From: a@b.example\r\nSubject: a' + ' '.repeat(200000) + 'b\r\n\r\nbody',
    qp_attachment_blank_run: HDR + 'Content-Type: multipart/mixed; boundary="Z"\r\n\r\n--Z\r\nContent-Type: text/plain\r\n\r\nhi\r\n--Z\r\n' +
      'Content-Type: application/octet-stream; name="a.bin"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' + ' '.repeat(200000) + 'x\r\n--Z--\r\n'
  };
  for (const [k, v] of Object.entries(bad)) {
    await check('C1 linear: ' + k + ' (~200 KB adversarial) parses in < 400 ms CPU (was seconds: quadratic regexes)', () => {
      let p;
      const ms = cpuMs(() => { p = MM.parseMessage(new Uint8Array(Buffer.from(v, 'latin1'))); });
      return (ms < 400 && typeof p.text === 'string' && Array.from(p.text).length <= 100000) || ('cpu ' + ms.toFixed(0) + ' ms');
    });
  }
  await check('C1 semantics kept: QP soft breaks / trailing blanks / =XX, comments + script / style / head removed, <header> kept', () => {
    const qp = MM.parseMessage(enc('Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nab=  \ncd  \n=D9=85x\nlast  '));
    const h = MM.mimeHtmlToText('<head><title>t</title></head><header>Top</header><!-- c --><p>A</p><script>x()</script><STYLE>p{}</STYLE>B <b>c</b>&amp;  \n\n\n\nd<!-- open');
    return (qp.text === 'abcd\nمx\nlast  ' && h === 'TopA\nB c&\n\nd<!-- open') || J([qp.text, h]);
  });
  await check('security C2: rawHeader / rawHeaderAll keep RFC 2047 words undecoded (8-bit still decoded); header() still decodes', () => {
    const w = '=?UTF-8?B?' + Buffer.from('ceo@bank.example <ceo@bank.example>,', 'utf8').toString('base64') + '?=';
    const p = MM.parseMessage(new Uint8Array(Buffer.concat([Buffer.from('From: ' + w + ' <attacker@evil.example>\r\nTo: a@b.example\r\nTo: '), Buffer.from('مرسى <c@d.example>', 'utf8'), Buffer.from('\r\n\r\nx')])));
    return (p.rawHeader('from') === w + ' <attacker@evil.example>' && p.header('from') === 'ceo@bank.example <ceo@bank.example>, <attacker@evil.example>' &&
      J(p.rawHeaderAll('to')) === J(['a@b.example', 'مرسى <c@d.example>']) && !Object.keys(p).includes('rawHeaders') && !J(p).includes('rawHeaders') &&
      MM.decodeEncodedWords(w) === 'ceo@bank.example <ceo@bank.example>,') || J([p.rawHeader('from'), p.rawHeaderAll('to')]);
  });
  await check('security H5: the topmost A-R counts only above every Received; an RFC 2047-encoded A-R is never decoded', () => {
    const m = h => MM.parseMessage(enc(h.join('\n') + '\nFrom: a@b.example\n\nx'));
    const ar = 'Authentication-Results: mx.example; spf=pass; dkim=pass header.d=b.example; dmarc=pass header.from=b.example';
    const rcv = 'Received: from x by mx.example; Tue, 03 Nov 2026 08:00:00 +0000';
    const above = MM.parseAuthResults(m([ar, rcv]), 'mx.example');
    const below = MM.parseAuthResults(m([rcv, ar]), 'mx.example');
    const encd = MM.parseAuthResults(m(['Authentication-Results: =?UTF-8?B?' + Buffer.from('mx.example; spf=pass; dmarc=pass').toString('base64') + '?=']), 'mx.example');
    return (above.dmarc === 'pass' && above.spf === 'pass' && J(below) === J({ spf: 'none', dkim: 'none', dmarc: 'none' }) && encd.dmarc === 'none') || J([above, below, encd]);
  });
  await check('security H3 / H4: dmarc_header_from and dkim_pass_domains are returned (non-enumerable: JSON keeps three keys)', () => {
    const r = MM.parseAuthResults([{ name: 'Authentication-Results', value: 'mx.example; dkim=fail header.d=x.example; dkim=pass header.d=Sig.Example; dkim=pass header.i=@other.example; dmarc=pass (p=none) header.from=Bank.Example' }], 'mx.example');
    return (r.dmarc_header_from === 'bank.example' && J(r.dkim_pass_domains) === J(['sig.example', 'other.example']) && J(r) === J({ spf: 'none', dkim: 'pass', dmarc: 'pass' }) &&
      MM.parseAuthResults([], 'mx.example').dmarc_header_from === null) || J([r, r.dmarc_header_from, r.dkim_pass_domains]);
  });

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
