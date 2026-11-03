/*
  Marsa (مرسى) — G6c LIVE e-mail adapter: IMAP (implicit TLS 993) + SMTP (implicit TLS 465), hand-written, no dependency
  (docs/online/G6C_LIVE_EMAIL.md § email-live.js). STAGING ONLY until the owner runbook S0-S7 passes.
  Plain classic script (no import / export, no require), ES2020, no network of its own, no env: the socket is INJECTED
  (index.ts wraps the TLS connect; node tests wrap net.connect against a loopback fake server) and the adapter + MIME API
  is passed as `deps` (the merged API of adapters.js + email-mime.js; falls back to globalThis.MarsaInbox at call time).
  TextEncoder / TextDecoder / crypto are looked up at CALL time only (the vm load-order test has no TextDecoder).

  createImapSmtpEmail(config) → adapter {mode:'live', kind:'email', provider:'imap', probe, fetchInbound, send, lookupSend,
    fetchStatusEvents} — the CHANNEL_METHODS contract of adapters.js:
    config = {connect, deps, imap:{host, port=993, user, password, sentFolder?}, smtp:{host, port=465, user, password},
              fromAddress, fromName?, msgidDomain?, authservId|null, dsnDkimDomain|null, batch=10, maxMessageBytes=2000000, deadlineMs=45000,
              timeouts:{connect=10000, cmd=20000}, appendSent=true, clock() → Date | ISO, fault?}
    connect(host, port, {timeoutMs}) → Promise<{read() → Promise<Uint8Array|null>, write(bytes) → Promise, close()}>
  ImapClient / SmtpClient — the two protocol sessions (also used by the tests directly).

  Binding rules implemented here:
    - read-only mailbox: EXAMINE + BODY.PEEK only, so the owner's \Seen flags never change; no STORE, no EXPUNGE;
    - cursor v1:<UIDVALIDITY>:<lastUID>:<epochDay> (review H7); first run imports nothing (cursor at UIDNEXT-1);
      explicit UID ranges, results always filtered uid > last (review H6); UIDVALIDITY change → SINCE resync;
    - every raw returned already passes normalizeInbound AND the SQL ingest rules (review C1 / C2): bad recipients and
      groups are dropped and counted, text is sanitized and capped, sizes are clamped integers, dates are ISO;
    - From / To / Cc / Message-ID / References come from the RAW headers (RFC 2047 only on display names), the angle-addr
      is found by the tokenizer outside quotes; more than one From header or mailbox (or a Sender fallback) → auth all
      'none' + imap.from_ambiguous; a DMARC pass counts only when its header.from is the stored From domain (security C1-H3);
    - a message the server refuses to FETCH is skipped (first of a batch) or left for the next call (correctness M6);
    - send: never twice — the EXACT Message-ID <MRSO-…@msgidDomain> is searched in Sent, then INBOX (the envelope-only
      Bcc-to-self copy, review C4) first; the stored id is always our own, never the copy's (security review M6);
      'unknown' ONLY when the final "." was written and no reply came (review C3 / C5);
    - DSN: read only with authservId + dsnDkimDomain (dkim=pass by the provider domain in the trusted A-R), only the
      header + delivery-status + original-header sections (≤ 10 per call), correlated against the SENT copy only; the
      cursor never passes an uncorrelated DSN (security review H4, correctness review C4 / M7 / M8);
    - probe: proves MAIL FROM:<channel address> is accepted (then RSET) and returns the INBOX cursor at connect time;
    - lookupSend never returns {found:false}: not found → validation 'unsupported' (a human decides);
    - errors are AdapterError with FIXED messages plus the server's reply code only: no command line, no server text,
      no password (plain, base64 or quoted) ever reaches a message (review H4).
*/
(function () {
  'use strict';

  const EMAIL_LIVE_VERSION = 'g6c-imap-smtp-1.0.0';
  const DEFAULTS = Object.freeze({
    imapPort: 993, smtpPort: 465, batch: 10, maxMessageBytes: 2000000, deadlineMs: 45000, connectMs: 10000, cmdMs: 20000
  });
  const PARTIAL_BYTES = 262144;          // text-only window of a message above maxMessageBytes (review C3)
  const DATA_MIN_MS = 15000;             // never start SMTP DATA with less budget left (review C3)
  const APPEND_MIN_MS = 10000;           // the Sent copy is best effort, only with budget to spare
  const STOP_FETCH_MS = 5000;            // a poll stops early and returns what it has rather than hit the deadline
  const SCAN_SPAN = 1000;                // explicit UID window per SEARCH (IMAP SEARCH has no LIMIT, review H6)
  const STATUS_SCAN = 100;               // BODYSTRUCTURE-only metadata per status call
  const STATUS_DSN_MAX = 10;             // DSN-shaped messages fetched per status call (correctness review C4)
  const DSN_PART_BYTES = 65536;          // each fetched DSN section (top header, delivery-status, original headers) is cut here
  const SMTP_MAX_LINES = 200;
  const MAX_LINE = 1048576;
  const MAX_RCPTS = 50;
  const MAX_ATTACHMENTS = 20;
  const ATTACHMENT_BYTES = 26214400;
  const MRSO_RE = /^MRSO-[0-9A-F]{16}$/;
  const PER_MESSAGE_REFUSALS = ['imap_no', 'imap_literal', 'reply_too_long'];   // a tagged NO / oversized reply for ONE message
  const OUT_MID_RE = /^<MRSO-[0-9A-F]{16}@[^<>\s]+>$/i;
  // mirror of app.msg_norm_address (stricter than adapters.normalizeAddress), ASCII only
  const SQL_EMAIL_RE = /^[^\s@<>(),;:"\[\]\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
  const AUTO_RCPT_RE = /^(mailer-daemon|postmaster|no-?reply)@/;
  const STARTTLS_PORTS = { smtp: [25, 587, 2525], imap: [143] };   // implicit TLS only (587 is blocked on Supabase)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY_MS = 86400000;
  const CRLF = [13, 10];

  /* ---------------------------------------------------------------- bytes */
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  function latin1(u8) {
    let out = '';
    for (let i = 0; i < u8.length; i += 8192) out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 8192)));
    return out;
  }
  function text(u8) { return typeof TextDecoder === 'function' ? new TextDecoder('utf-8').decode(u8) : latin1(u8); }
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const toBytes = x => (x instanceof Uint8Array ? x : (typeof x === 'string' ? utf8(x) : new Uint8Array(0)));
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64(u8) {
    let out = '';
    for (let i = 0; i < u8.length; i += 3) {
      const a = u8[i], b = u8[i + 1], c = u8[i + 2];
      out += B64[a >> 2] + B64[((a & 3) << 4) | ((b || 0) >> 4)] +
        (i + 1 < u8.length ? B64[((b & 15) << 2) | ((c || 0) >> 6)] : '=') + (i + 2 < u8.length ? B64[c & 63] : '=');
    }
    return out;
  }
  // SMTP transparency (RFC 5321 § 4.5.2): a line starting with "." gets one more; the result always ends with CRLF
  function dotStuff(u8) {
    let extra = 0;
    for (let i = 0; i < u8.length; i++) if (u8[i] === 46 && (i === 0 || u8[i - 1] === 10)) extra++;
    const tail = u8.length >= 2 && u8[u8.length - 2] === 13 && u8[u8.length - 1] === 10 ? 0 : 2;
    const out = new Uint8Array(u8.length + extra + tail);
    let o = 0;
    for (let i = 0; i < u8.length; i++) {
      if (u8[i] === 46 && (i === 0 || u8[i - 1] === 10)) out[o++] = 46;
      out[o++] = u8[i];
    }
    if (tail) { out[o++] = 13; out[o++] = 10; }
    return out;
  }

  /* ---------------------------------------------------------------- sha256 (crypto.subtle when present, else pure JS) */
  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function sha256Pure(msg) {
    const l = msg.length;
    const n = ((l + 9 + 63) >> 6) << 6;
    const p = new Uint8Array(n);
    p.set(msg);
    p[l] = 0x80;
    const bits = l * 8;
    p[n - 4] = (bits >>> 24) & 255; p[n - 3] = (bits >>> 16) & 255; p[n - 2] = (bits >>> 8) & 255; p[n - 1] = bits & 255;
    p[n - 5] = Math.floor(bits / 4294967296) & 255;
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const W = new Array(64);
    const rot = (x, r) => (x >>> r) | (x << (32 - r));
    for (let off = 0; off < n; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = (p[off + 4 * i] << 24) | (p[off + 4 * i + 1] << 16) | (p[off + 4 * i + 2] << 8) | p[off + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = rot(W[i - 15], 7) ^ rot(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rot(W[i - 2], 17) ^ rot(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
  async function sha256Hex(s) {
    const u8 = utf8(s);
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (subtle) {
      const buf = await subtle.digest('SHA-256', u8);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return sha256Pure(u8);
  }

  /* ---------------------------------------------------------------- errors (fixed messages + reply codes only) */
  function makeErr(A) {
    return (kind, message, code, applied, status) => new A.AdapterError(kind, message, { code, applied: applied || 'no', http_status: status });
  }
  const safeCode = c => (/^[A-Za-z0-9.-]{1,30}$/.test(String(c || '')) ? String(c).toUpperCase() : null);
  // IMAP tagged NO / BAD / untagged BYE → AdapterError (all applied 'no': reads have no side effect)
  function classifyImapStatus(st, what, isLogin) {
    const code = safeCode(String((st && st.code) || '').split(' ')[0]);
    const tail = code ? ' [' + code + ']' : '';
    if (code === 'AUTHENTICATIONFAILED' || code === 'AUTHORIZATIONFAILED' || code === 'EXPIRED') return { kind: 'not_configured', code: 'auth_failed', message: 'imap ' + what + ' refused' + tail };
    if (code === 'UNAVAILABLE' || code === 'SERVERBUG') return { kind: 'http_5xx', code: 'imap_unavailable', message: 'imap ' + what + ' unavailable' + tail };
    if (code === 'LIMIT' || code === 'INUSE' || code === 'OVERQUOTA') return { kind: 'rate_limited', code: 'imap_limit', message: 'imap ' + what + ' limited' + tail };
    if (st && st.status === 'BYE') return { kind: 'http_5xx', code: 'imap_bye', message: 'imap server closed the session' + tail };
    if (isLogin) return st && st.status === 'BAD' ? { kind: 'not_configured', code: 'auth_unsupported', message: 'imap login not accepted' + tail } :
      { kind: 'not_configured', code: 'auth_failed', message: 'imap login refused' + tail };
    if (st && st.status === 'BAD') return { kind: 'validation', code: 'imap_bad', message: 'imap ' + what + ' rejected as malformed' + tail };
    return { kind: 'http_5xx', code: 'imap_no', message: 'imap ' + what + ' refused' + tail };
  }
  // SMTP reply → {kind, code}; stage ∈ greeting, ehlo, auth, mail, rcpt, data, dot
  function classifySmtpReply(reply, stage) {
    const n = reply && Number(reply.code);
    const enh = reply && reply.enh ? ' ' + reply.enh : '';
    const message = 'smtp ' + stage + ' refused (' + (Number.isInteger(n) ? n : 'no reply') + enh + ')';
    if (stage === 'auth' && n === 454) return { kind: 'rate_limited', code: 'smtp_454', message };     // temporary auth failure
    if (stage === 'auth' && [530, 534, 535, 538].includes(n)) return { kind: 'not_configured', code: 'auth_failed', message };
    if (n === 552 && stage !== 'rcpt') return { kind: 'validation', code: 'too_large', message };
    if (n === 452 && stage === 'rcpt') return { kind: 'validation', code: 'smtp_452', message };   // too many recipients: never retry (review L3)
    if (n >= 500 && n <= 599) return { kind: 'validation', code: 'smtp_' + n, message };
    if (n >= 400 && n <= 499) return { kind: [421, 450, 451, 452].includes(n) ? 'rate_limited' : 'http_5xx', code: 'smtp_' + n, message };
    return { kind: 'network', code: 'smtp_unexpected', message };
  }

  /* ---------------------------------------------------------------- budget + buffered wire (review C3, M5) */
  function budget(ms) {
    const end = Date.now() + ms;
    return { left: () => end - Date.now() };
  }
  async function race(p, ms, onTimeout) {
    let timer = null;
    const t = new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), Math.max(1, ms)); });
    try { return await Promise.race([p, t]); } finally { clearTimeout(timer); }
  }
  async function dial(E, connect, host, port, b, connectMs, what) {
    const ms = Math.min(connectMs, b.left());
    if (ms <= 0) throw E('timeout', what + ' connect: no time left', 'budget');
    let sock;
    try { sock = await race(Promise.resolve().then(() => connect(host, port, { timeoutMs: ms })), ms, () => E('timeout', what + ' connect timed out', 'connect_timeout')); }
    catch (e) { if (e && e.name === 'AdapterError') throw e; throw E('network', what + ' connect failed', 'connect_failed'); }
    if (!sock || typeof sock.read !== 'function' || typeof sock.write !== 'function') throw E('network', what + ' connect failed', 'connect_failed');
    return sock;
  }
  // chunk list + one copy per taken line / literal: linear in the bytes received
  class Wire {
    constructor(sock, E, b, cmdMs, what) {
      this.s = sock; this.E = E; this.b = b; this.cmdMs = cmdMs; this.what = what;
      this.chunks = []; this.off = 0; this.len = 0; this.scanned = 0; this.closed = false; this.reads = 0;
    }
    ms() {
      const left = this.b.left();
      if (left <= 0) { this.close(); throw this.E('timeout', this.what + ': method deadline reached', 'deadline'); }
      return Math.min(this.cmdMs, left);
    }
    async fill() {
      if (this.closed) throw this.E('network', this.what + ' connection closed', 'connection_closed');
      const ms = this.ms();
      let c;
      try { c = await race(Promise.resolve().then(() => this.s.read()), ms, () => this.E('timeout', this.what + ' reply timed out', 'reply_timeout')); }
      catch (e) { this.close(); if (e && e.name === 'AdapterError') throw e; throw this.E('network', this.what + ' read failed', 'read_failed'); }
      if (c === null || c === undefined) { this.close(); throw this.E('network', this.what + ' connection closed', 'connection_closed'); }
      this.reads++;
      if (c.length) { this.chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c)); this.len += c.length; }
    }
    take(n) {
      const out = new Uint8Array(n);
      let o = 0;
      while (o < n) {
        const c = this.chunks[0];
        const k = Math.min(n - o, c.length - this.off);
        out.set(c.subarray(this.off, this.off + k), o);
        o += k; this.off += k;
        if (this.off >= c.length) { this.chunks.shift(); this.off = 0; }
      }
      this.len -= n;
      return out;
    }
    findLF() {
      let pos = 0;
      for (let ci = 0; ci < this.chunks.length; ci++) {
        const c = this.chunks[ci];
        const start = ci === 0 ? this.off : 0;
        const size = c.length - start;
        if (pos + size > this.scanned) {
          for (let i = Math.max(start, start + this.scanned - pos); i < c.length; i++) if (c[i] === 10) return pos + (i - start);
        }
        pos += size;
      }
      this.scanned = pos;
      return -1;
    }
    async line(max) {
      for (;;) {
        const at = this.findLF();
        if (at >= 0) {
          this.scanned = 0;
          let u = this.take(at + 1);
          u = u.subarray(0, u.length - (u.length >= 2 && u[u.length - 2] === 13 ? 2 : 1));
          return text(u);
        }
        if (this.len > (max || MAX_LINE)) { this.close(); throw this.E('validation', this.what + ' reply line too long', 'reply_too_long'); }
        await this.fill();
      }
    }
    async bytes(n) {
      while (this.len < n) await this.fill();
      this.scanned = 0;
      return this.take(n);
    }
    async write(x) {
      if (this.closed) throw this.E('network', this.what + ' connection closed', 'connection_closed');
      const ms = this.ms();
      try { await race(Promise.resolve().then(() => this.s.write(toBytes(x))), ms, () => this.E('timeout', this.what + ' write timed out', 'write_timeout')); }
      catch (e) { this.close(); if (e && e.name === 'AdapterError') throw e; throw this.E('network', this.what + ' write failed', 'write_failed'); }
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      try { const r = this.s.close(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) { /* already closed */ }
    }
  }

  /* ---------------------------------------------------------------- IMAP response lexer (literals split across reads, review M4) */
  function lex(segs) {
    const toks = [];
    for (const seg of segs) {
      if (seg instanceof Uint8Array) { toks.push({ t: 'lit', v: seg }); continue; }
      const s = seg;
      let i = 0;
      while (i < s.length) {
        const c = s[i];
        if (c === ' ') { i++; continue; }
        if (c === '(' || c === ')') { toks.push({ t: c }); i++; continue; }
        if (c === '"') {
          let j = i + 1, out = '';
          while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) j++; out += s[j]; j++; }
          toks.push({ t: 'str', v: out });
          i = j + 1;
          continue;
        }
        let j = i, depth = 0;
        while (j < s.length) {
          const d = s[j];
          if (d === '[') depth++;
          else if (d === ']') depth--;
          else if (depth <= 0 && (d === ' ' || d === '(' || d === ')')) break;
          j++;
        }
        toks.push({ t: 'atom', v: s.slice(i, j) });
        i = j;
      }
    }
    return toks;
  }
  // atoms → string (NIL → null), quoted → string, literal → Uint8Array, (…) → array
  function tree(toks) {
    let i = 0;
    function val() {
      const t = toks[i++];
      if (t.t === '(') {
        const a = [];
        while (i < toks.length && toks[i].t !== ')') a.push(val());
        i++;
        return a;
      }
      if (t.t === 'atom') return t.v.toUpperCase() === 'NIL' ? null : t.v;
      return t.v;
    }
    const out = [];
    while (i < toks.length) { if (toks[i].t === ')') { i++; continue; } out.push(val()); }
    return out;
  }
  function parseStatus(s) {
    const m = /^(OK|NO|BAD|BYE|PREAUTH)\b ?(?:\[([^\]]*)\])?/i.exec(s);
    return m ? { status: m[1].toUpperCase(), code: m[2] ? m[2].trim() : null } : null;
  }
  const quotable = s => /^[\x20-\x7e]*$/.test(s);
  const quote = s => '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';
  const astring = s => (quotable(s) ? quote(s) : utf8(s));        // 8-bit / CR / LF → a literal (review H4)
  const num = v => (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : null);

  /* ================================================================ ImapClient */
  class ImapClient {
    constructor(opts) {
      const o = opts || {};
      this.E = o.E; this.connect = o.connect; this.host = o.host; this.port = o.port; this.b = o.budget;
      this.connectMs = o.connectMs || DEFAULTS.connectMs; this.cmdMs = o.cmdMs || DEFAULTS.cmdMs;
      this.maxLiteral = o.maxLiteral || (DEFAULTS.maxMessageBytes + PARTIAL_BYTES);
      this.w = null; this.caps = new Set(); this.seq = 0; this.selected = null; this.authed = false;
    }
    async open() {
      const sock = await dial(this.E, this.connect, this.host, this.port, this.b, this.connectMs, 'imap');
      this.w = new Wire(sock, this.E, this.b, this.cmdMs, 'imap');
      const g = await this.response();
      const head = g[0];
      const st = head.startsWith('* ') ? parseStatus(head.slice(2)) : null;
      if (!st || (st.status !== 'OK' && st.status !== 'PREAUTH')) { this.close(); const c = classifyImapStatus(st || { status: 'BYE' }, 'greeting'); throw this.E(c.kind, c.message, c.code); }
      if (st.status === 'PREAUTH') this.authed = true;
      if (st.code && /^CAPABILITY /i.test(st.code)) this.setCaps(st.code.slice(11));
      else await this.capability();
      return this;
    }
    setCaps(s) { this.caps = new Set(String(s).trim().split(/\s+/).map(x => x.toUpperCase())); }
    async capability() {
      const r = await this.command(['CAPABILITY']);
      this.ok(r, 'capability');
      const u = r.untagged.find(x => x.type === 'CAPABILITY');
      if (u) this.setCaps(u.text);
      return this.caps;
    }
    // one response: a line plus every {n} literal it announces (the literal may arrive split over many reads)
    async response() {
      const segs = [];
      for (;;) {
        const l = await this.w.line(MAX_LINE);
        const m = /\{(\d{1,10})\+?\}$/.exec(l);
        if (!m) { segs.push(l); return segs; }
        const n = Number(m[1]);
        if (n > this.maxLiteral) { this.close(); throw this.E('validation', 'imap literal too large', 'imap_literal'); }
        segs.push(l.slice(0, m.index));
        segs.push(await this.w.bytes(n));
      }
    }
    untagged(segs) {
      const head = segs[0].slice(2);
      let m = /^(\d+) (EXISTS|EXPUNGE|RECENT|FETCH)\b ?/i.exec(head);
      if (m) {
        const type = m[2].toUpperCase();
        const u = { type, n: Number(m[1]) };
        if (type === 'FETCH') {
          const t = tree(lex([head.slice(m[0].length)].concat(segs.slice(1))));
          const list = Array.isArray(t[0]) ? t[0] : [];
          const items = {};
          for (let i = 0; i + 1 < list.length; i += 2) if (typeof list[i] === 'string') items[list[i].toUpperCase()] = list[i + 1];
          u.items = items;
        }
        return u;
      }
      const st = parseStatus(head);
      if (st) return { type: 'STATUS', status: st.status, code: st.code };
      m = /^([A-Z]+)\b ?/i.exec(head);
      const type = m ? m[1].toUpperCase() : 'UNKNOWN';
      const rest = m ? head.slice(m[0].length) : head;
      if (type === 'LIST' || type === 'LSUB') return { type: 'LIST', data: tree(lex([rest].concat(segs.slice(1)))) };
      return { type, text: rest };
    }
    // parts: strings and Uint8Array literals; LITERAL+ when advertised, else a synchronizing literal (wait for "+")
    async command(parts, opts) {
      const tag = 'M' + String(++this.seq).padStart(3, '0');
      const untagged = [];
      let line = tag + ' ';
      for (const p of parts) {
        if (typeof p === 'string') { line += p; continue; }
        if (this.caps.has('LITERAL+')) { await this.w.write(concat([utf8(line + '{' + p.length + '+}\r\n'), p])); line = ''; continue; }
        await this.w.write(line + '{' + p.length + '}\r\n');
        line = '';
        for (;;) {
          const r = await this.response();
          if (r[0].startsWith('+')) break;
          if (r[0].startsWith('* ')) { untagged.push(this.untagged(r)); continue; }
          if (r[0].startsWith(tag + ' ')) return Object.assign(parseStatus(r[0].slice(tag.length + 1)) || { status: 'BAD', code: null }, { untagged });
        }
        await this.w.write(p);
      }
      await this.w.write(line + '\r\n');
      for (;;) {
        const r = await this.response();
        const head = r[0];
        if (head.startsWith('* ')) {
          const u = this.untagged(r);
          if (u.type === 'STATUS' && u.status === 'BYE') this.bye = true;
          untagged.push(u);
          continue;
        }
        if (head.startsWith('+')) {
          if (opts && typeof opts.onContinue === 'function') { await opts.onContinue(); continue; }
          await this.w.write('*\r\n');      // an unexpected continuation is cancelled, never answered with data
          continue;
        }
        if (head.startsWith(tag + ' ')) {
          const st = parseStatus(head.slice(tag.length + 1));
          if (!st) { this.close(); throw this.E('validation', 'imap reply could not be parsed', 'imap_parse'); }
          return Object.assign(st, { untagged });
        }
      }
    }
    ok(r, what, isLogin) {
      if (r.status === 'OK') return r;
      const c = classifyImapStatus(r, what, isLogin);
      throw this.E(c.kind, c.message, c.code);
    }
    async login(user, password) {
      if (this.authed) return;
      let r;
      if (this.caps.has('AUTH=PLAIN')) {
        const tok = b64(utf8('\u0000' + user + '\u0000' + password));
        if (this.caps.has('SASL-IR')) r = await this.command(['AUTHENTICATE PLAIN ' + tok]);
        else {
          let sent = false;
          r = await this.command(['AUTHENTICATE PLAIN'], { onContinue: async () => { await this.w.write(sent ? '*\r\n' : tok + '\r\n'); sent = true; } });
        }
      } else if (this.caps.has('LOGINDISABLED')) {
        throw this.E('not_configured', 'imap login disabled by the server (no AUTH=PLAIN)', 'login_disabled');
      } else {
        r = await this.command(['LOGIN ', astring(user), ' ', astring(password)]);
      }
      this.ok(r, 'login', true);
      this.authed = true;
      if (r.code && /^CAPABILITY /i.test(r.code)) this.setCaps(r.code.slice(11));
      else await this.capability();
    }
    async list() {
      const r = this.ok(await this.command(['LIST "" "*"']), 'list');
      return r.untagged.filter(u => u.type === 'LIST').map(u => {
        const d = u.data;
        const name = d[2] instanceof Uint8Array ? text(d[2]) : (d[2] === null || d[2] === undefined ? '' : String(d[2]));
        return { flags: Array.isArray(d[0]) ? d[0].map(f => String(f).toUpperCase()) : [], delim: d[1] || null, name };
      }).filter(f => f.name);
    }
    async examine(box) {
      const r = this.ok(await this.command(['EXAMINE ', astring(box)]), 'examine');
      const out = { uidvalidity: null, uidnext: null, exists: 0 };
      for (const u of r.untagged) {
        if (u.type === 'EXISTS') out.exists = u.n;
        if (u.type === 'STATUS' && u.code) {
          const m = /^(UIDVALIDITY|UIDNEXT) (\d{1,10})$/i.exec(u.code);
          if (m) out[m[1].toLowerCase()] = Number(m[2]);
        }
      }
      if (!out.uidvalidity) throw this.E('validation', 'imap examine gave no UIDVALIDITY', 'imap_parse');
      this.selected = box;
      return out;
    }
    async uidSearch(criteria) {
      const r = this.ok(await this.command(['UID SEARCH ' + criteria]), 'search');
      const set = new Set();
      for (const u of r.untagged) if (u.type === 'SEARCH') for (const x of String(u.text || '').split(/\s+/)) { const n = num(x); if (n) set.add(n); }
      return Array.from(set).sort((a, b) => a - b);
    }
    // → Map uid → items (merged; unsolicited FETCH without a requested UID is ignored)
    async uidFetch(uids, items) {
      const want = new Set(uids);
      const r = this.ok(await this.command(['UID FETCH ' + uids.join(',') + ' ' + items]), 'fetch');
      const out = new Map();
      for (const u of r.untagged) {
        if (u.type !== 'FETCH' || !u.items) continue;
        const uid = num(u.items.UID);
        if (!uid || !want.has(uid)) continue;
        out.set(uid, Object.assign(out.get(uid) || {}, u.items));
      }
      return out;
    }
    async append(box, bytes) {
      return this.ok(await this.command(['APPEND ', astring(box), ' (\\Seen) ', bytes]), 'append');
    }
    async logout() {
      if (!this.w || this.w.closed) return;
      try { await this.command(['LOGOUT']); } catch (e) { /* best effort */ }
      this.close();
    }
    close() { if (this.w) this.w.close(); }
  }
  // the bytes of BODY[<section>] in a FETCH item map (servers echo BODY[]<0> for a partial); exact: BODY[2] never BODY[2.1]
  function section(items, sec, exact) {
    if (!items) return null;
    for (const k of Object.keys(items)) {
      const ok = sec === '' || exact ? (k === 'BODY[' + sec + ']' || k.startsWith('BODY[' + sec + ']<')) : k.startsWith('BODY[' + sec);
      if (!ok) continue;
      const v = items[k];
      if (v instanceof Uint8Array) return v;
      if (typeof v === 'string') return utf8(v);
      return null;
    }
    return null;
  }

  /* ================================================================ SmtpClient (implicit TLS only) */
  class SmtpClient {
    constructor(opts) {
      const o = opts || {};
      this.E = o.E; this.connect = o.connect; this.host = o.host; this.port = o.port; this.b = o.budget;
      this.connectMs = o.connectMs || DEFAULTS.connectMs; this.cmdMs = o.cmdMs || DEFAULTS.cmdMs;
      this.w = null; this.ext = { auth: [], dsn: false, size: 0, smtputf8: false };
    }
    async open() {
      const sock = await dial(this.E, this.connect, this.host, this.port, this.b, this.connectMs, 'smtp');
      this.w = new Wire(sock, this.E, this.b, this.cmdMs, 'smtp');
      const g = await this.reply();
      if (g.code !== 220) this.fail(g, 'greeting');
      return this;
    }
    async reply() {
      const lines = [];
      for (;;) {
        const l = await this.w.line(65536);
        const m = /^(\d{3})([ -]?)(.*)$/.exec(l);
        if (!m) { this.close(); throw this.E('network', 'smtp reply could not be parsed', 'smtp_parse'); }
        lines.push(m[3]);
        // a reply longer than this would desynchronise the session (its tail read as the next reply): closed, never resumed
        if (m[2] === '-' && lines.length > SMTP_MAX_LINES) { this.close(); throw this.E('network', 'smtp reply too long', 'smtp_parse'); }
        if (m[2] !== '-') {
          const e = /^([245]\.\d{1,3}\.\d{1,3})\b/.exec(lines[0] || '');
          return { code: Number(m[1]), lines, enh: e ? e[1] : null };
        }
      }
    }
    async cmd(line) { await this.w.write(line + '\r\n'); return this.reply(); }
    fail(reply, stage, applied) {
      const c = classifySmtpReply(reply, stage);
      throw this.E(c.kind, c.message, c.code, applied || 'no', reply && Number.isInteger(reply.code) ? reply.code : undefined);
    }
    async ehlo(name) {
      const r = await this.cmd('EHLO ' + name);
      if (r.code !== 250) this.fail(r, 'ehlo');
      for (const l of r.lines.slice(1)) {
        const p = l.trim().split(/\s+/);
        const k = (p[0] || '').toUpperCase();
        if (k === 'AUTH') this.ext.auth = p.slice(1).map(x => x.toUpperCase());
        else if (/^AUTH=/.test(k) && !this.ext.auth.length) this.ext.auth = [k.slice(5)].concat(p.slice(1)).map(x => x.toUpperCase());   // legacy form
        else if (k === 'DSN') this.ext.dsn = true;
        else if (k === 'SIZE') this.ext.size = Number(p[1]) || 0;
        else if (k === 'SMTPUTF8') this.ext.smtputf8 = true;
      }
      return this.ext;
    }
    async auth(user, password) {
      let r;
      if (this.ext.auth.includes('PLAIN')) {
        r = await this.cmd('AUTH PLAIN ' + b64(utf8('\u0000' + user + '\u0000' + password)));
        if (r.code === 334) r = await this.cmd(b64(utf8('\u0000' + user + '\u0000' + password)));
      } else if (this.ext.auth.includes('LOGIN')) {
        r = await this.cmd('AUTH LOGIN');
        if (r.code === 334) r = await this.cmd(b64(utf8(user)));
        if (r.code === 334) r = await this.cmd(b64(utf8(password)));
      } else {
        throw this.E('not_configured', 'smtp server offers no AUTH PLAIN / LOGIN', 'auth_unsupported');
      }
      if (r.code === 334) await this.cmd('*').catch(() => null);
      if (r.code !== 235) this.fail(r, 'auth');
    }
    async rset() { try { await this.cmd('RSET'); } catch (e) { /* best effort */ } }
    async quit() { try { if (this.w && !this.w.closed) await this.cmd('QUIT'); } catch (e) { /* best effort */ } this.close(); }
    close() { if (this.w) this.w.close(); }
  }

  /* ---------------------------------------------------------------- addresses (review C2) */
  function sqlAddr(s) {
    const a = String(s || '').trim().replace(/^mailto:/i, '').toLowerCase();
    if (!a || a.length > 254 || /[^\x21-\x7e]/.test(a) || !SQL_EMAIL_RE.test(a)) return null;
    return a;
  }
  // RFC 5322 address-list → {list:[{address, name?}], dropped}; groups (incl. undisclosed-recipients:;) are dropped.
  // `value` is the RAW header (never RFC 2047 decoded, security review C2); `decodeName` (email-mime decodeEncodedWords)
  // decodes the display-name phrase only, after the split. The angle-addr is located by the tokenizer itself, outside
  // quoted strings and comments: a "<x@y>" inside a quoted name never wins, and an item with a second angle-addr or
  // anything but blanks after ">" is refused (dropped), never guessed (security review C1).
  function parseAddressList(value, sanitize, decodeName) {
    const san = typeof sanitize === 'function' ? sanitize : (s, n) => String(s).slice(0, n);
    const items = [];
    let dropped = 0, cur = '', q = false, ang = 0, cm = 0, grp = false, grpN = 0, lt = -1, gt = -1, nAng = 0;
    const push = () => {
      const raw = cur, a = lt, b = gt, n = nAng;
      cur = ''; lt = gt = -1; nAng = 0;
      if (!raw.trim()) return;
      if (grp) { grpN++; dropped++; return; }
      if (n > 1 || ang > 0 || (a >= 0 && b < 0) || (b >= 0 && raw.slice(b + 1).trim())) { dropped++; return; }
      items.push(a >= 0 ? { addr: raw.slice(a + 1, b), name: raw.slice(0, a) } : { addr: raw.trim(), name: null });
    };
    const s = String(value || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === '\\' && i + 1 < s.length) cur += s[++i]; else if (c === '"') q = false; continue; }
      if (cm > 0) { if (c === '(') cm++; else if (c === ')') cm--; continue; }
      if (c === '"') { q = true; cur += c; continue; }
      if (c === '(') { cm = 1; continue; }
      if (c === '<') { if (ang === 0) { nAng++; lt = cur.length; } ang++; }
      else if (c === '>' && ang > 0) { ang--; if (ang === 0) gt = cur.length; }
      if (c === ':' && ang === 0 && !grp) { grp = true; grpN = 0; cur = ''; lt = gt = -1; nAng = 0; continue; }
      if (c === ';' && ang === 0 && grp) { push(); if (grpN === 0) dropped++; grp = false; continue; }
      if (c === ',' && ang === 0) { push(); continue; }
      cur += c;
    }
    push();
    if (grp && grpN === 0) dropped++;
    const list = [];
    const seen = new Set();
    for (const it of items) {
      const address = sqlAddr(it.addr);
      if (!address) { dropped++; continue; }
      if (seen.has(address)) continue;
      seen.add(address);
      const o = { address };
      if (it.name !== null) {
        let name = it.name.trim();
        if (/^".*"$/.test(name)) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
        if (typeof decodeName === 'function') name = decodeName(name);
        name = san(name.replace(/\s+/g, ' ').trim(), 160).trim();
        if (name) o.name = name;
      }
      list.push(o);
    }
    return { list, dropped };
  }
  function firstMsgId(A, v) {
    const m = /<[^<>]*>/.exec(String(v || ''));
    return m && A.isMsgId(m[0]) ? m[0] : null;
  }
  function allMsgIds(A, v) {
    return (String(v || '').match(/<[^<>]*>/g) || []).filter(x => A.isMsgId(x));
  }

  /* ---------------------------------------------------------------- BODYSTRUCTURE (attachment metadata without bodies) */
  function plist(x) {
    const o = {};
    if (Array.isArray(x)) for (let i = 0; i + 1 < x.length; i += 2) if (typeof x[i] === 'string') o[x[i].toLowerCase()] = x[i + 1] instanceof Uint8Array ? text(x[i + 1]) : x[i + 1];
    return o;
  }
  function walkStructure(bs, prefix, out, depth) {
    if (!Array.isArray(bs) || depth > 8 || out.leaves.length > 100) return out;
    if (Array.isArray(bs[0])) {
      let i = 0;
      for (; i < bs.length && Array.isArray(bs[i]); i++) walkStructure(bs[i], prefix ? prefix + '.' + (i + 1) : String(i + 1), out, depth + 1);
      out.multi.push({ part: prefix, subtype: String(bs[i] || '').toLowerCase(), params: plist(bs[i + 1]) });
      return out;
    }
    const type = String(bs[0] || '').toLowerCase(), sub = String(bs[1] || '').toLowerCase();
    const params = plist(bs[2]);
    const ext = type === 'text' ? 8 : (type === 'message' && sub === 'rfc822' ? 10 : 7);
    const disp = Array.isArray(bs[ext + 1]) ? bs[ext + 1] : null;
    const dparams = disp ? plist(disp[1]) : {};
    out.leaves.push({
      part: prefix || '1', type: type + '/' + sub, enc: String(bs[5] || '').toLowerCase(), size: Number(bs[6]) || 0,
      disposition: disp ? String(disp[0] || '').toLowerCase() : null, file_name: dparams.filename || params.name || null
    });
    return out;
  }
  function structureOf(bs) {
    const s = walkStructure(bs, '', { leaves: [], multi: [] }, 0);
    const top = s.multi.find(m => m.part === '');
    s.isDsn = !!(top && top.subtype === 'report' && String(top.params['report-type'] || '').toLowerCase() === 'delivery-status');
    s.attachments = s.leaves.filter(l => l.disposition === 'attachment' || l.file_name || !/^text\/(plain|html)$/.test(l.type)).map(l => ({
      part: l.part, file_name: l.file_name || (l.type === 'message/rfc822' ? 'message.eml' : 'attachment'), mime_type: l.type,
      size_bytes: Math.min(ATTACHMENT_BYTES, Math.max(0, Math.floor(l.enc === 'base64' ? l.size * 3 / 4 : l.size)))
    }));
    return s;
  }

  /* ---------------------------------------------------------------- cursor v1:<UIDVALIDITY>:<lastUID>:<epochDay> (review H7) */
  function parseCursor(c) {
    const m = /^v1:(\d{1,10}):(\d{1,10})(?::(\d{1,6}))?$/.exec(String(c || ''));
    return m ? { v: Number(m[1]), uid: Number(m[2]), day: m[3] === undefined ? null : Number(m[3]) } : null;
  }
  const formatCursor = (v, uid, day) => 'v1:' + v + ':' + uid + ':' + day;
  function imapDate(day) {
    const d = new Date(day * DAY_MS);
    return d.getUTCDate() + '-' + MONTHS[d.getUTCMonth()] + '-' + d.getUTCFullYear();
  }

  /* ================================================================ the adapter */
  function createImapSmtpEmail(config) {
    const c = config || {};
    const A = c.deps || globalThis.MarsaInbox;
    if (!A || typeof A.AdapterError !== 'function') throw new Error('createImapSmtpEmail: deps (adapter API) required');
    const E = makeErr(A);
    const NEED = ['parseMessage', 'parseAuthResults', 'parseDsn', 'parseDate', 'isMsgId', 'sanitizeText', 'buildMessage'];
    const imap = c.imap || {}, smtp = c.smtp || {};
    const T = c.timeouts || {};
    const fromAddress = sqlAddr(c.fromAddress);
    const intOr = (v, d, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
    const S = {
      imapHost: String(imap.host || ''), imapPort: intOr(imap.port, DEFAULTS.imapPort, 1, 65535),
      smtpHost: String(smtp.host || ''), smtpPort: intOr(smtp.port, DEFAULTS.smtpPort, 1, 65535),
      sentFolder: imap.sentFolder ? String(imap.sentFolder) : null,
      fromName: c.fromName ? String(c.fromName) : null,
      msgidDomain: String(c.msgidDomain || (fromAddress ? fromAddress.split('@')[1] : '')).toLowerCase(),
      authservId: c.authservId ? String(c.authservId) : null,
      dsnDkimDomain: c.dsnDkimDomain ? String(c.dsnDkimDomain).trim().toLowerCase() : null,
      batch: intOr(c.batch, DEFAULTS.batch, 1, 50),
      maxMessageBytes: intOr(c.maxMessageBytes, DEFAULTS.maxMessageBytes, 1024, 20000000),
      deadlineMs: intOr(c.deadlineMs, DEFAULTS.deadlineMs, 1, 600000),
      connectMs: intOr(T.connect, DEFAULTS.connectMs, 1, 120000), cmdMs: intOr(T.cmd, DEFAULTS.cmdMs, 1, 120000),
      appendSent: c.appendSent !== false, fault: c.fault === 'drop_after_dot' ? 'drop_after_dot' : null
    };
    // credentials stay in this closure only: never on the adapter object, never in a result or an error
    const cred = Object.freeze({ imapUser: String(imap.user || ''), imapPw: String(imap.password || ''), smtpUser: String(smtp.user || ''), smtpPw: String(smtp.password || '') });
    const selfRcpt = sqlAddr(cred.smtpUser);
    const clock = typeof c.clock === 'function' ? c.clock : () => new Date();
    const now = () => { const v = clock(); const d = v instanceof Date ? v : new Date(String(v)); return Number.isNaN(d.getTime()) ? new Date() : d; };

    let problem = null;
    if (typeof c.connect !== 'function') problem = 'config_connect';
    else if (NEED.some(k => typeof A[k] !== 'function')) problem = 'config_deps';
    else if (!S.imapHost || !cred.imapUser || !cred.imapPw) problem = 'config_imap';
    else if (!S.smtpHost || !cred.smtpUser || !cred.smtpPw || !selfRcpt) problem = 'config_smtp';
    else if (sqlAddr(cred.imapUser) !== selfRcpt) problem = 'config_mailbox';     // the Bcc-to-self copy must land in the mailbox searched
    else if (STARTTLS_PORTS.smtp.includes(S.smtpPort)) problem = 'smtp_port';
    else if (STARTTLS_PORTS.imap.includes(S.imapPort)) problem = 'imap_port';
    else if (!fromAddress) problem = 'config_from';
    else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(S.msgidDomain)) problem = 'config_msgid_domain';
    else if (S.dsnDkimDomain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(S.dsnDkimDomain)) problem = 'config_dsn_domain';
    if (problem) {
      const a = { mode: 'live', kind: 'email', provider: 'imap' };
      for (const m of A.CHANNEL_METHODS || ['probe', 'fetchInbound', 'send', 'lookupSend', 'fetchStatusEvents']) {
        a[m] = async function () { throw E('not_configured', 'live e-mail adapter not configured', problem); };
      }
      return Object.freeze(a);
    }
    const outMid = id => '<' + id + '@' + S.msgidDomain + '>';
    const NO_AUTH = () => ({ spf: 'none', dkim: 'none', dmarc: 'none' });
    // a DSN counts only when the trusted Authentication-Results shows dkim=pass by the provider's own signing domain
    // (MARSA_EMAIL_DSN_DKIM_DOMAIN, owner-verified, or a subdomain of it): any sender can mail a multipart/report
    // (security review H4 c). Without authservId + dsnDkimDomain no DSN is trusted and no status event is produced.
    const dsnTrusted = !!(S.authservId && S.dsnDkimDomain);
    function dsnFromProvider(P) {
      const d = A.parseAuthResults(P, S.authservId).dkim_pass_domains || [];
      return d.some(x => x === S.dsnDkimDomain || x.endsWith('.' + S.dsnDkimDomain));
    }

    async function imapSession(b) {
      const s = new ImapClient({ E, connect: c.connect, host: S.imapHost, port: S.imapPort, budget: b, connectMs: S.connectMs, cmdMs: S.cmdMs,
        maxLiteral: S.maxMessageBytes + PARTIAL_BYTES + 65536 });
      try { await s.open(); await s.login(cred.imapUser, cred.imapPw); }
      catch (e) { s.close(); throw e; }
      return s;
    }
    async function sentFolderOf(s) {
      const boxes = await s.list();
      const special = boxes.find(x => x.flags.includes('\\SENT'));
      if (special) return special.name;
      if (S.sentFolder && boxes.some(x => x.name === S.sentFolder)) return S.sentFolder;
      const named = boxes.find(x => /^(INBOX[./])?Sent( Items| Messages)?$/i.test(x.name));
      return named ? named.name : null;
    }
    // any non-AdapterError becomes a fixed-message AdapterError (applied as given)
    async function guarded(op, fn, appliedOnCrash) {
      try { return await fn(); }
      catch (e) {
        if (A.isAdapterError(e)) throw e;
        throw E('network', op + ' failed (internal error)', 'internal', appliedOnCrash || 'no');
      }
    }
    // the last UID present when UIDNEXT is missing (review M4)
    async function highestUid(s, ex) {
      if (ex.uidnext) return ex.uidnext - 1;
      if (!ex.exists) return 0;
      const u = await s.uidSearch('UID *');
      return u.length ? u[u.length - 1] : 0;
    }
    // explicit UID window after `last`, always filtered uid > last (review H6) → {uids, end}
    async function newUids(s, ex, last) {
      if (ex.uidnext) {
        const hi = ex.uidnext - 1;
        if (hi <= last) return { uids: [], end: last };
        const end = Math.min(hi, last + SCAN_SPAN);
        return { uids: (await s.uidSearch('UID ' + (last + 1) + ':' + end)).filter(u => u > last && u <= end), end };
      }
      return { uids: (await s.uidSearch('UID ' + (last + 1) + ':*')).filter(u => u > last), end: null };
    }
    // our own copy of an outbound (Sent first — only our APPEND / the provider's submission copy writes there — then the
    // INBOX Bcc-to-self): the EXACT Message-ID <id@msgidDomain> AND From must both match (review L1, security review H4 a / M6).
    // `boxes` limits the search (the DSN correlation reads the Sent copy only, security review H4 b).
    async function findOwnCopy(s, requestId, sent, withRcpts, boxes) {
      const want = outMid(requestId).toLowerCase();
      for (const box of (boxes || [sent, 'INBOX']).filter((x, i, a) => x && a.indexOf(x) === i)) {
        await s.examine(box);
        const uids = (await s.uidSearch('HEADER Message-ID ' + quote(requestId))).slice(-5);
        if (!uids.length) continue;
        const f = await s.uidFetch(uids, '(UID BODY.PEEK[HEADER.FIELDS (FROM TO CC MESSAGE-ID)])');
        for (const u of uids) {
          const h = section(f.get(u), 'HEADER.FIELDS');
          if (!h) continue;
          const P = A.parseMessage(concat([h, Uint8Array.from(CRLF)]), { maxBody: 10 });
          const mids = P.rawHeaderAll('Message-ID');
          const mid = mids.length === 1 ? firstMsgId(A, mids[0]) : null;
          const fl = parseAddressList(P.rawHeaderAll('From').length === 1 ? P.rawHeader('From') : '', A.sanitizeText);
          if (!mid || mid.toLowerCase() !== want || fl.list.length !== 1 || fl.dropped || fl.list[0].address !== fromAddress) continue;
          const out = { message_id: outMid(requestId), box };
          if (withRcpts) out.rcpts = parseAddressList(P.rawHeaderAll('To').join(', ')).list.concat(parseAddressList(P.rawHeaderAll('Cc').join(', ')).list).map(x => x.address);
          return out;
        }
      }
      return null;
    }

    /* ------------------------------------------------------------ probe */
    async function probe() {
      return guarded('probe', async () => {
        const b = budget(S.deadlineMs);
        const today = Math.floor(now().getTime() / DAY_MS);
        const s = await imapSession(b);
        let sent, ex, hi;
        try { sent = await sentFolderOf(s); ex = await s.examine('INBOX'); hi = await highestUid(s, ex); }
        finally { await s.logout(); }
        const m = new SmtpClient({ E, connect: c.connect, host: S.smtpHost, port: S.smtpPort, budget: b, connectMs: S.connectMs, cmdMs: S.cmdMs });
        let ext;
        try {
          await m.open(); ext = await m.ehlo(S.msgidDomain); await m.auth(cred.smtpUser, cred.smtpPw);
          // the login may send AS the channel address (an alias of the mailbox): MAIL FROM then RSET, no RCPT, no DATA
          // (correctness review M9); a 5xx means every send would fail → not_configured
          const r = await m.cmd('MAIL FROM:<' + fromAddress + '>');
          if (r.code >= 500 && r.code <= 599) throw E('not_configured', 'smtp refused the channel address as sender (' + r.code + (r.enh ? ' ' + r.enh : '') + ')', 'send_as_refused');
          if (r.code !== 250) m.fail(r, 'mail');
          await m.rset();
        } finally { await m.quit(); }
        const clip = x => A.sanitizeText(x, 200);
        return {
          capabilities: {
            send: { supported: true, evidence: clip('smtp implicit tls :' + S.smtpPort + ' auth ok; send-as channel address ok' + (ext.size ? '; SIZE ' + ext.size : '') + (ext.dsn ? '; DSN' : '; no DSN')) },
            lookup_send: { supported: true, evidence: clip('Message-ID search in INBOX (bcc-to-self) and ' + (sent ? '"' + sent + '"' : 'no Sent folder') + '; not found => human') },
            status_events: dsnTrusted
              ? { supported: true, evidence: clip('DSN scan in INBOX, dkim=pass ' + S.dsnDkimDomain + ' required' + (ext.dsn ? ' (ENVID + NOTIFY=FAILURE,DELAY)' : ' (no DSN extension: Message-ID only)')) }
              : { supported: false, evidence: 'DSN scan off: MARSA_EMAIL_AUTHSERV_ID + MARSA_EMAIL_DSN_DKIM_DOMAIN not set (no bounce is trusted)' },
            attachments: { supported: false, evidence: 'inbound metadata only; outbound attachments refused' },
            threading: { supported: true, evidence: 'Message-ID / In-Reply-To / References' },
            templates: { supported: false, evidence: 'e-mail has no provider templates' }
          },
          account: { address: fromAddress },
          // cursor = the INBOX position at connect time: SQL seeds empty poll / status cursors with it, so mail and bounces
          // arriving between the probe and the first poll are never passed (correctness review M7)
          mailbox: { uidvalidity: ex.uidvalidity, uidnext: ex.uidnext, cursor: formatCursor(ex.uidvalidity, hi, today) }
        };
      });
    }

    /* ------------------------------------------------------------ inbound: one raw that passes normalizeInbound + SQL (C1/C2) */
    function saneIso(iso) {
      if (!iso) return null;
      const y = Number(String(iso).slice(0, 4));
      return /^\d{4}-/.test(iso) && y >= 1970 && y <= 9999 ? iso : null;
    }
    async function toRaw(P, meta, ctx) {
      const st = ctx.structure;
      if (P.isDsn || (st && st.isDsn)) return { skip: 'dsn' };
      // every structured header is parsed from its RAW value; RFC 2047 only on display names (security review C2)
      const msgid = firstMsgId(A, P.rawHeader('Message-ID'));
      const fromHdrs = P.rawHeaderAll('From');
      const fromList = parseAddressList(fromHdrs[0] || '', A.sanitizeText, A.decodeEncodedWords);
      let from = fromList.list[0], viaSender = false;
      if (!from) { from = parseAddressList(P.rawHeader('Sender'), A.sanitizeText, A.decodeEncodedWords).list[0]; viaSender = !!from; }
      if (!from) return { skip: 'bad_from' };
      if (from.address === fromAddress && msgid && /^<MRSO-[0-9A-F]{16}@/i.test(msgid)) return { skip: 'loop_guard' };
      // one From header with exactly one mailbox, or no authentication result counts (security review H3)
      const ambiguous = fromHdrs.length !== 1 || fromList.list.length !== 1 || fromList.dropped > 0 || viaSender;
      let auth = NO_AUTH();
      if (!ambiguous) {
        const au = A.parseAuthResults(P, S.authservId);
        auth = { spf: au.spf, dkim: au.dkim, dmarc: au.dmarc };
        // a DMARC pass is about one header.from domain: it counts only for the From we store (security review H3)
        if (auth.dmarc === 'pass' && au.dmarc_header_from !== from.address.split('@')[1]) auth.dmarc = 'none';
      }
      const to = parseAddressList(P.rawHeaderAll('To').join(', '), A.sanitizeText, A.decodeEncodedWords);
      const cc = parseAddressList(P.rawHeaderAll('Cc').join(', '), A.sanitizeText, A.decodeEncodedWords);
      // at most 50 recipients in all (to first); unparseable entries, groups and the overflow are only counted
      const toL = to.list.slice(0, MAX_RCPTS);
      const ccAll = cc.list.filter(x => !toL.some(y => y.address === x.address));
      const ccL = ccAll.slice(0, Math.max(0, MAX_RCPTS - toL.length));
      const dropped = to.dropped + cc.dropped + (to.list.length - toL.length) + (ccAll.length - ccL.length);
      const dateHdr = A.sanitizeText(P.header('Date') || '', 200).trim();
      const sent = saneIso(A.parseDate(dateHdr)) || saneIso(A.parseDate(String(meta.INTERNALDATE || ''))) || now().toISOString();
      const pid = msgid
        ? 'mid:' + (await sha256Hex(msgid.toLowerCase() + '|' + from.address + '|' + dateHdr)).slice(0, 40)   // review M1
        : 'uid:' + ctx.v + ':' + ctx.uid;
      const srcAtt = ctx.partial && st ? st.attachments : (Array.isArray(P.attachments) ? P.attachments : []);
      const seen = new Set();
      const attachments = [];
      for (const a of srcAtt) {
        const id = 'p' + String(a.part || attachments.length + 1).replace(/[^0-9.]/g, '').slice(0, 60);
        if (seen.has(id) || attachments.length >= MAX_ATTACHMENTS) continue;
        seen.add(id);
        attachments.push({
          provider_attachment_id: id,
          file_name: A.sanitizeText(String(a.file_name || 'attachment').replace(/[\u0000-\u001f\u007f]/g, ''), 255).trim() || 'attachment',
          mime_type: A.sanitizeText(String(a.mime_type || 'application/octet-stream').toLowerCase(), 120) || 'application/octet-stream',
          size_bytes: Math.min(ATTACHMENT_BYTES, Math.max(0, Math.floor(Number(a.size_bytes) || 0)))
        });
      }
      let body = A.sanitizeText(P.text || '', 100000);
      const marker = '\n[…]';
      if (Array.from(body).length > 100000) body = Array.from(body).slice(0, 100000 - Array.from(marker).length).join('') + marker;
      const refs = allMsgIds(A, P.rawHeaderAll('References').join(' ')).slice(-20);
      const irt = firstMsgId(A, P.rawHeader('In-Reply-To'));
      const imapInfo = { uidvalidity: ctx.v, uid: ctx.uid, size: Number(meta['RFC822.SIZE']) || 0 };
      if (dropped) imapInfo.dropped_rcpts = dropped;
      if (srcAtt.length > attachments.length) imapInfo.dropped_attachments = srcAtt.length - attachments.length;
      if (P.htmlOnly) imapInfo.html_only = true;        // review L2: CSS-hidden text became visible, flag it for the reviewer
      if (ctx.partial) imapInfo.partial = true;
      if (ctx.resync) imapInfo.resync = true;
      if (ambiguous) imapInfo.from_ambiguous = true;
      const headers = { 'Message-ID': msgid || ('<' + pid.replace(/:/g, '.') + '@imap.invalid>') };
      if (irt) headers['In-Reply-To'] = irt;
      if (refs.length) headers.References = refs;
      return {
        raw: {
          id: pid, provider: 'imap', from, to: toL, cc: ccL, subject: A.sanitizeText(P.header('Subject') || '', 500), text: body,
          headers, auth, attachments, date: sent, imap: imapInfo
        }
      };
    }

    /* ------------------------------------------------------------ fetchInbound */
    async function fetchInbound(a) {
      return guarded('fetchInbound', async () => {
        const b = budget(S.deadlineMs);
        const limit = Math.max(1, Math.min(S.batch, Number(a && a.limit) || S.batch));
        const cur = parseCursor(a && a.cursor);
        const today = Math.floor(now().getTime() / DAY_MS);
        const s = await imapSession(b);
        try {
          const ex = await s.examine('INBOX');
          const V = ex.uidvalidity;
          if (!cur) return { messages: [], next_cursor: formatCursor(V, await highestUid(s, ex), today) };   // first run: no history import
          let uids, end = null, resync = false, last = cur.uid;
          if (cur.v !== V) {
            resync = true;
            const since = (cur.day === null ? today : Math.min(cur.day, today)) - 2;
            uids = await s.uidSearch('SINCE ' + imapDate(since));
            last = 0;
            end = ex.uidnext ? ex.uidnext - 1 : null;
          } else {
            const r = await newUids(s, ex, last);
            uids = r.uids; end = r.end;
          }
          const take = uids.slice(0, limit);
          const meta = take.length ? await s.uidFetch(take, '(UID RFC822.SIZE INTERNALDATE BODYSTRUCTURE)') : new Map();
          const messages = [], skipped = [];
          let done = 0, bytesUsed = 0, maxDone = last;
          for (const uid of take) {
            if (b.left() < STOP_FETCH_MS) break;
            const m = meta.get(uid);
            if (!m) { skipped.push({ uid, reason: 'expunged' }); done++; maxDone = uid; continue; }
            const size = Number(m['RFC822.SIZE']) || 0;
            const partial = size > S.maxMessageBytes;
            if (!partial && bytesUsed > 0 && bytesUsed + size > S.maxMessageBytes) break;     // the next call starts with it
            const want = partial ? 'BODY.PEEK[]<0.' + PARTIAL_BYTES + '>' : 'BODY.PEEK[]';
            let f;
            try { f = await s.uidFetch([uid], '(UID ' + want + ')'); }
            catch (e) {
              // one message the server deterministically refuses never blocks the mailbox (correctness review M6): the
              // first of a batch is skipped, a later one ends the call so the next poll starts with it
              if (!A.isAdapterError(e) || !PER_MESSAGE_REFUSALS.includes(e.code)) throw e;
              if (done === 0) { skipped.push({ uid, reason: 'fetch_refused' }); done++; maxDone = uid; }
              break;
            }
            const bytes = section(f.get(uid), '') || new Uint8Array(0);
            bytesUsed += bytes.length;
            let st = null;
            try { st = Array.isArray(m.BODYSTRUCTURE) ? structureOf(m.BODYSTRUCTURE) : null; } catch (e) { st = null; }
            let r;
            try {
              const P = A.parseMessage(bytes, { maxBody: 100000 });
              r = await toRaw(P, m, { v: V, uid, partial, resync, structure: st });
            } catch (e) { r = { skip: 'parse_error' }; }        // one bad message never blocks the mailbox (review C1)
            if (r.raw) messages.push(r.raw); else skipped.push({ uid, reason: r.skip });
            done++; maxDone = uid;
          }
          let next;
          if (done === take.length && uids.length <= take.length) next = end !== null ? Math.max(end, maxDone) : maxDone;
          else next = maxDone;
          if (resync && !take.length) next = await highestUid(s, ex);
          return { messages, next_cursor: formatCursor(V, next, today), skipped };
        } finally { await s.logout(); }
      });
    }

    /* ------------------------------------------------------------ send */
    function recipients(req) {
      const norm = x => sqlAddr(typeof x === 'string' ? x : (x && (x.address_norm || x.address)));
      const list = (Array.isArray(req.to) ? req.to : []).concat(Array.isArray(req.cc) ? req.cc : []);
      const to = [], cc = [], all = [];
      (Array.isArray(req.to) ? req.to : []).forEach(x => { const a = norm(x); if (!a) throw E('validation', 'invalid recipient', 'recipient'); if (!all.includes(a)) { to.push(a); all.push(a); } });
      (Array.isArray(req.cc) ? req.cc : []).forEach(x => { const a = norm(x); if (!a) throw E('validation', 'invalid recipient', 'recipient'); if (!all.includes(a)) { cc.push(a); all.push(a); } });
      if (!to.length || list.length > MAX_RCPTS) throw E('validation', 'recipient count', 'recipient');
      for (const a of all) {
        if (a === fromAddress || a === selfRcpt || a === sqlAddr(cred.imapUser) || AUTO_RCPT_RE.test(a)) throw E('validation', 'automatic / own mailbox recipient refused', 'auto_recipient');
      }
      return { to, cc, all };
    }
    async function smtpSend(b, rc, id, bytes) {
      let phase = 'pre';
      const m = new SmtpClient({ E, connect: c.connect, host: S.smtpHost, port: S.smtpPort, budget: b, connectMs: S.connectMs, cmdMs: S.cmdMs });
      try {
        await m.open();
        const ext = await m.ehlo(S.msgidDomain);
        await m.auth(cred.smtpUser, cred.smtpPw);
        const body = dotStuff(bytes);
        if (ext.size && body.length > ext.size) { await m.quit(); throw E('validation', 'message larger than the server SIZE', 'too_large'); }
        let r = await m.cmd('MAIL FROM:<' + fromAddress + '>' + (ext.dsn ? ' RET=HDRS ENVID=' + id : ''));
        if (r.code !== 250) m.fail(r, 'mail');
        const rcpts = rc.all.map(x => ({ a: x, notify: ' NOTIFY=FAILURE,DELAY' }));
        rcpts.push({ a: selfRcpt, notify: ' NOTIFY=NEVER', self: true });   // envelope-only Bcc to the login mailbox (review C4)
        for (const x of rcpts) {
          r = await m.cmd('RCPT TO:<' + x.a + '>' + (ext.dsn ? x.notify : ''));
          if (r.code === 250 || r.code === 251) continue;
          await m.rset();                                                 // all or nothing: no partial send
          // the owner mailbox temporarily refusing its own copy (full, 452) is a retry, not a bad recipient (correctness review L15)
          if (x.self && r.code >= 400 && r.code <= 499) throw E('rate_limited', 'smtp rcpt refused for the mailbox copy (' + r.code + (r.enh ? ' ' + r.enh : '') + ')', 'smtp_' + r.code, 'no', r.code);
          m.fail(r, 'rcpt');
        }
        if (b.left() < DATA_MIN_MS) { await m.rset(); throw E('timeout', 'not enough time left to start DATA', 'budget'); }
        r = await m.cmd('DATA');
        if (r.code !== 354) m.fail(r, 'data');
        await m.w.write(body);
        phase = 'dot';                                                  // from here a lost reply is 'unknown'
        await m.w.write('.\r\n');
        if (S.fault === 'drop_after_dot') m.close();                    // staging fault hook (review C5)
        r = await m.reply();
        phase = 'done';
        if (r.code !== 250) m.fail(r, 'dot');                           // the server refused it: not applied
        await m.quit();
        return true;
      } catch (e) {
        if (phase === 'dot') {
          const kind = A.isAdapterError(e) && e.kind === 'timeout' ? 'timeout' : 'network';
          throw E(kind, 'smtp reply to the final "." was lost: the message may have been accepted', kind === 'timeout' ? 'reply_timeout' : 'connection_lost', 'unknown');
        }
        if (A.isAdapterError(e)) throw e;
        throw E('network', 'smtp failed (internal error)', 'internal', 'no');
      } finally { m.close(); }
    }
    async function send(req) {
      const r = req || {};
      if (typeof r.request_id !== 'string' || !MRSO_RE.test(r.request_id)) throw E('validation', 'request_id', 'request_id');
      if (sqlAddr(r.from) !== fromAddress) throw E('validation', 'from is not the channel address', 'from_mismatch');
      if (Array.isArray(r.attachments) && r.attachments.length) throw E('validation', 'outbound attachments are not supported', 'attachments_unsupported');
      const rc = recipients(r);
      const id = r.request_id;
      const mid = outMid(id);
      let bytes;
      try {
        // ids this side invented for messages without a Message-ID never reach a real header (correctness review L12)
        const realId = x => A.isMsgId(x) && !/@(imap|mock-mail)\.invalid>$/i.test(x);
        const refs = (Array.isArray(r.references) ? r.references : (typeof r.references === 'string' ? r.references.split(/\s+/) : []))
          .map(x => String(x || '').trim()).filter(realId);
        const irt = String(r.in_reply_to || '').trim();
        bytes = A.buildMessage({
          from: fromAddress, from_name: S.fromName ? S.fromName.replace(/[\r\n\u0000]+/g, ' ') : null, to: rc.to, cc: rc.cc,
          subject: String(r.subject || '').replace(/[\r\n\u0000]+/g, ' '), body_text: String(r.body_text || ''),
          in_reply_to: realId(irt) ? irt : null, references: refs
        }, { messageId: mid, date: now(), envelopeId: id });
      } catch (e) { throw E('validation', 'message could not be built', 'message_invalid'); }
      const b = budget(S.deadlineMs);
      let accepted = false, appended = false;
      const s = await guarded('send', () => imapSession(b));
      try {
        const sent = await guarded('send', () => sentFolderOf(s));
        const hit = await guarded('send', () => findOwnCopy(s, id, sent, false));     // pre-send dedupe: never twice
        if (hit) return { provider_message_id: mid, status: 'accepted', deduped: true };
        accepted = await smtpSend(b, rc, id, bytes);
        if (S.appendSent && sent && b.left() > APPEND_MIN_MS) {
          try { await s.append(sent, bytes); appended = true; } catch (e) { appended = false; }   // best effort: already applied
        }
        return { provider_message_id: mid, status: 'accepted', appended };
      } catch (e) {
        if (accepted) return { provider_message_id: mid, status: 'accepted', appended };
        throw e;
      } finally { try { await s.logout(); } catch (e) { /* best effort */ } }
    }

    /* ------------------------------------------------------------ lookupSend */
    async function lookupSend(requestId) {
      if (typeof requestId !== 'string' || !MRSO_RE.test(requestId)) throw E('validation', 'request_id', 'request_id');
      return guarded('lookupSend', async () => {
        const b = budget(S.deadlineMs);
        const s = await imapSession(b);
        try {
          const hit = await findOwnCopy(s, requestId, await sentFolderOf(s), false);
          if (hit) return { found: true, provider_message_id: outMid(requestId), status: 'accepted', found_in: hit.box === 'INBOX' ? 'inbox' : 'sent' };
        } finally { await s.logout(); }
        // SMTP cannot prove "not sent": never {found:false}
        throw E('validation', 'send not provable from the mailbox: human resolution required', 'unsupported');
      });
    }

    /* ------------------------------------------------------------ fetchStatusEvents (DSN, own cursor, review H5) */
    // the BODYSTRUCTURE leaves a DSN is read from: the delivery-status part and the original headers (correctness review C4)
    function dsnSections(st) {
      const status = st.leaves.find(l => l.type === 'message/delivery-status' || l.type === 'message/global-delivery-status');
      const orig = st.leaves.find(l => /^(text\/rfc822-headers|message\/rfc822|message\/global-headers|message\/global)$/.test(l.type));
      if (!status || !/^[0-9]+(\.[0-9]+)*$/.test(status.part)) return null;
      const o = orig && /^[0-9]+(\.[0-9]+)*$/.test(orig.part) ? orig : null;
      return { status, orig: o, origSec: o ? (/^message\/(rfc822|global)$/.test(o.type) ? o.part + '.HEADER' : o.part) : null };
    }
    async function fetchStatusEvents(a) {
      return guarded('fetchStatusEvents', async () => {
        const b = budget(S.deadlineMs);
        const cur = parseCursor(a && a.cursor);
        const today = Math.floor(now().getTime() / DAY_MS);
        const s = await imapSession(b);
        try {
          const ex = await s.examine('INBOX');
          const V = ex.uidvalidity;
          // no trusted DSN origin configured: nothing is read, nothing can be forged (security review H4 c)
          if (!dsnTrusted) return { events: [], next_cursor: formatCursor(V, await highestUid(s, ex), today) };
          let last = cur && cur.v === V ? cur.uid : null;
          if (last === null) {
            // no / stale cursor: start at SINCE (day − 2), so a bounce that arrived before the first status run is still read
            // (correctness review M7; SQL normally seeds the cursor from the probe)
            const day = cur && cur.day !== null ? Math.min(cur.day, today) : today;
            const since = await s.uidSearch('SINCE ' + imapDate(day - 2));
            last = since.length ? since[0] - 1 : await highestUid(s, ex);
          }
          const r = await newUids(s, ex, last);
          const take = r.uids.slice(0, STATUS_SCAN);
          const meta = take.length ? await s.uidFetch(take, '(UID INTERNALDATE BODYSTRUCTURE)') : new Map();
          const dsns = [];
          let maxDone = last, stopped = false, nDsn = 0, bytesUsed = 0;
          for (const uid of take) {
            if (b.left() < STOP_FETCH_MS || nDsn >= STATUS_DSN_MAX || bytesUsed >= S.maxMessageBytes) { stopped = true; break; }
            const m = meta.get(uid);
            let st = null;
            try { st = m && Array.isArray(m.BODYSTRUCTURE) ? structureOf(m.BODYSTRUCTURE) : null; } catch (e) { st = null; }
            const sec = st && st.isDsn ? dsnSections(st) : null;
            if (!sec) { maxDone = uid; continue; }
            nDsn++;
            // only the top header and the two DSN sections, each cut at DSN_PART_BYTES: never the full message (C4)
            const cut = '<0.' + DSN_PART_BYTES + '>';
            const items = 'BODY.PEEK[HEADER]' + cut + ' BODY.PEEK[' + sec.status.part + ']' + cut + (sec.origSec ? ' BODY.PEEK[' + sec.origSec + ']' + cut : '');
            const f = await s.uidFetch([uid], '(UID ' + items + ')');
            maxDone = uid;
            const it = f.get(uid);
            const hb = section(it, 'HEADER', true) || new Uint8Array(0);
            const sb = section(it, sec.status.part, true) || new Uint8Array(0);
            const ob = sec.origSec ? section(it, sec.origSec, true) : null;
            bytesUsed += hb.length + sb.length + (ob ? ob.length : 0);
            try {
              const P = A.parseMessage(concat([hb, Uint8Array.from(CRLF)]), { maxBody: 10 });
              if (!dsnFromProvider(P)) continue;
              const parts = [{ type: sec.status.type, body: latin1(sb), cte: sec.status.enc }];
              if (ob) parts.push({ type: 'text/rfc822-headers', body: latin1(ob), cte: sec.origSec.endsWith('.HEADER') ? '' : sec.orig.enc });   // headers only
              const d = A.parseDsn({ parts });
              if (!d) continue;
              const env = d.envelope_id && MRSO_RE.test(d.envelope_id.trim()) ? d.envelope_id.trim() : null;
              const om = d.original_message_id && OUT_MID_RE.test(d.original_message_id) ? d.original_message_id.slice(1, 22).toUpperCase() : null;
              if ((env && om && env !== om) || !(env || om)) continue;
              dsns.push({ uid, id: env || om, at: saneIso(A.parseDate(String((m && m.INTERNALDATE) || ''))) || now().toISOString(), recipients: d.recipients || [] });
            } catch (e) { /* an unparseable report is ignored */ }
          }
          // correlate: bounced ONLY when every recipient of our own SENT copy failed (aggregated over this scan)
          const byId = new Map();
          for (const d of dsns) {
            const g = byId.get(d.id) || { failed: new Set(), other: new Set(), last: d, first: d.uid, code: null };
            for (const x of d.recipients) {
              const addr = sqlAddr(x.final_recipient);
              if (!addr) continue;
              if (x.action === 'failed') { g.failed.add(addr); if (!g.code && x.status) g.code = x.status; } else g.other.add(addr);
            }
            g.last = d;
            byId.set(d.id, g);
          }
          const events = [];
          let pending = null;           // the first DSN uid not correlated in this call: the cursor stays below it (review M8)
          if (byId.size) {
            const sent = await sentFolderOf(s);
            for (const [id, g] of byId) {
              if (b.left() < STOP_FETCH_MS) { pending = pending === null ? g.first : Math.min(pending, g.first); continue; }
              // the Sent copy only: anyone can deliver a look-alike "own copy" to INBOX (security review H4 b)
              const own = sent ? await findOwnCopy(s, id, sent, true, [sent]) : null;
              const want = own ? own.rcpts.filter(x => x !== selfRcpt) : [];
              if (!own || !want.length || !want.every(x => g.failed.has(x) && !g.other.has(x))) continue;
              const ev = { provider_event_id: 'dsn:' + V + ':' + g.last.uid, provider_request_id: id, provider_message_id: own.message_id, status: 'bounced', at: g.last.at };
              if (g.code && /^[245]\.\d{1,3}\.\d{1,3}$/.test(g.code)) ev.error_code = g.code;
              events.push(ev);
            }
          }
          let next = !stopped && r.uids.length <= take.length ? (r.end !== null ? Math.max(r.end, maxDone) : maxDone) : maxDone;
          if (pending !== null) next = Math.min(next, pending - 1);
          return { events, next_cursor: formatCursor(V, Math.max(next, last), today) };
        } finally { await s.logout(); }
      });
    }

    return Object.freeze({ mode: 'live', kind: 'email', provider: 'imap', version: EMAIL_LIVE_VERSION, probe, fetchInbound, send, lookupSend, fetchStatusEvents });
  }

  const API = {
    EMAIL_LIVE_VERSION, createImapSmtpEmail, ImapClient, SmtpClient, classifySmtpReply, classifyImapStatus,
    parseAddressList, parseCursor, formatCursor, dotStuff, sha256HexPure: s => sha256Pure(utf8(s))
  };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaInbox = Object.assign(globalThis.MarsaInbox || {}, API));
})();
