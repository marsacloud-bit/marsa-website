/*
  Marsa (مرسى) — G6c scripted IMAP + SMTP fake server (docs/online/G6C_LIVE_EMAIL.md § Tests). LOCAL TESTS ONLY.
  Plain TCP on 127.0.0.1 (TLS is irrelevant to the protocol logic), driven by an in-memory mailbox. No real mailbox,
  no credential, no network beyond the loopback interface.

  createFakeMailServer({users, owner, uidvalidity, imapCaps, smtpExt, clock}) → server
    server.start() → {imapPort, smtpPort};  server.stop()
    server.mailbox                         → Mailbox: add(folder, raw, {internaldate, flags}) → uid, changeUidValidity(folder),
                                             expunge(folder, uid), find(folder, pred), folder(name)
    server.faults.imap  {authFail, loginDisabled, chunk (bytes per write; 1 = byte by byte), unsolicited, noUidnext,
                         slow:{cmd, ms}, caps (override list), fetchNo (a UID whose BODY fetch gets a tagged NO)}
    UID FETCH serves BODY[], HEADER, TEXT, HEADER.FIELDS and numeric part sections (2, 1.2, 3.HEADER) with <start.len> partials
    server.faults.smtp  {failAt:{stage, code}, rejectRcpt:{addr: code}, dropAfterDot, deliverOnDrop (default true), slow:{stage, ms},
                         ext (override list), authFail, rejectFrom:{addr: code} (MAIL FROM refused for that sender)}
    server.log.imap     [{conn, tag, cmd, line}]   every command received (literals shown as {n})
    server.log.smtp     [{conn, line}]             every command line received (DATA content excluded)
    server.smtp         {dataCommands, dots, messages:[{from, mailParams, rcpts:[{addr, params}], data}]}
    server.reset()      clears faults, logs and counters (the mailbox stays)
  createNodeConnect() → connect(host, port, {timeoutMs}) for the adapter (net.connect to 127.0.0.1:port) + .stats {connects, reads}

  Stages for SMTP faults: greeting, ehlo, auth, mail, rcpt, data, dot.
*/
'use strict';
const net = require('net');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = n => String(n).padStart(2, '0');
function internalDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  return p2(x.getUTCDate()) + '-' + MONTHS[x.getUTCMonth()] + '-' + x.getUTCFullYear() + ' ' + p2(x.getUTCHours()) + ':' + p2(x.getUTCMinutes()) + ':' + p2(x.getUTCSeconds()) + ' +0000';
}
function parseImapDate(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(s));
  return m ? Date.UTC(+m[3], MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()), +m[1]) : NaN;
}
const iq = s => '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';

/* ------------------------------------------------------------------ minimal MIME → BODYSTRUCTURE */
function splitHB(buf) {
  const s = buf.toString('latin1');
  let i = s.indexOf('\r\n\r\n'), k = 4;
  if (i < 0) { i = s.indexOf('\n\n'); k = 2; }
  if (i < 0) return { head: s, body: Buffer.alloc(0), headBuf: buf };
  return { head: s.slice(0, i + 2), body: buf.subarray(i + k), headBuf: buf.subarray(0, i + k) };
}
function headerMap(head) {
  const out = {};
  const unf = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const l of unf.split(/\r?\n/)) {
    const m = /^([^:\s]+):\s*(.*)$/.exec(l);
    if (m && !(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}
function ctParse(v, dflt) {
  const parts = String(v || dflt).split(';');
  const params = {};
  for (const p of parts.slice(1)) {
    const m = /^\s*([^=\s]+)\s*=\s*("([^"]*)"|[^;\s]*)/.exec(p);
    if (m) params[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2];
  }
  return { value: parts[0].trim().toLowerCase(), params };
}
function plistStr(o) {
  const k = Object.keys(o);
  return k.length ? '(' + k.map(x => iq(x.toUpperCase()) + ' ' + iq(o[x])).join(' ') + ')' : 'NIL';
}
function bodystructure(buf, depth) {
  const { head, body } = splitHB(buf);
  const h = headerMap(head);
  const ct = ctParse(h['content-type'], 'text/plain; charset=us-ascii');
  const [type, sub] = ct.value.split('/');
  if (type === 'multipart' && ct.params.boundary && (depth || 0) < 6) {
    const b = '--' + ct.params.boundary;
    const s = body.toString('latin1');
    const segs = s.split(new RegExp('\\r?\\n?' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:--)?[ \\t]*\\r?\\n?'));
    const parts = segs.slice(1, -1).filter(x => x.length);
    const kids = parts.map(p => bodystructure(Buffer.from(p, 'latin1'), (depth || 0) + 1)).join('');
    return '(' + kids + ' ' + iq(sub.toUpperCase()) + ' ' + plistStr(ct.params) + ' NIL NIL NIL)';
  }
  const enc = (h['content-transfer-encoding'] || '7bit').trim().toUpperCase();
  const cd = h['content-disposition'] ? ctParse(h['content-disposition'], '') : null;
  const disp = cd ? '(' + iq(cd.value.toUpperCase()) + ' ' + plistStr(cd.params) + ')' : 'NIL';
  const size = body.length;
  const base = iq((type || 'text').toUpperCase()) + ' ' + iq((sub || 'plain').toUpperCase()) + ' ' + plistStr(ct.params) + ' NIL NIL ' + iq(enc) + ' ' + size;
  if (type === 'text') return '(' + base + ' ' + (body.toString('latin1').split('\n').length) + ' NIL ' + disp + ' NIL NIL)';
  if (type === 'message' && sub === 'rfc822') return '(' + base + ' NIL ' + bodystructure(body, (depth || 0) + 1) + ' 0 NIL ' + disp + ' NIL NIL)';
  return '(' + base + ' NIL ' + disp + ' NIL NIL)';
}

// the children of a multipart (same split as bodystructure), or null
function mimeKids(buf) {
  const { head, body } = splitHB(buf);
  const ct = ctParse(headerMap(head)['content-type'], 'text/plain');
  if (!ct.value.startsWith('multipart/') || !ct.params.boundary) return null;
  const b = '--' + ct.params.boundary;
  const segs = body.toString('latin1').split(new RegExp('\\r?\\n?' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:--)?[ \\t]*\\r?\\n?'));
  return segs.slice(1, -1).filter(x => x.length).map(x => Buffer.from(x, 'latin1'));
}
// BODY[<n>(.<n>)*[.HEADER|.TEXT]] (RFC 3501 § 6.4.5): a part's body; n.HEADER of a message/rfc822 part = the embedded header
function partSection(raw, spec) {
  const toks = spec.split('.');
  let cur = raw;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'HEADER') return splitHB(cur).headBuf;
    if (t === 'TEXT') return splitHB(cur).body;
    const kids = mimeKids(cur);
    const part = kids ? kids[Number(t) - 1] : (Number(t) === 1 ? cur : null);
    if (!part) return Buffer.alloc(0);
    const ph = splitHB(part);
    if (i === toks.length - 1) return kids ? ph.body : splitHB(cur).body;
    cur = ctParse(headerMap(ph.head)['content-type'], 'text/plain').value === 'message/rfc822' ? ph.body : part;
  }
  return Buffer.alloc(0);
}

/* ------------------------------------------------------------------ mailbox */
class Mailbox {
  constructor(o) {
    const x = o || {};
    this.folders = new Map();
    this.nextV = x.uidvalidity || 3857529045;
    for (const f of x.folders || [{ name: 'INBOX' }, { name: 'INBOX.Sent', special: '\\Sent' }, { name: 'INBOX.Junk', special: '\\Junk' }]) this.create(f.name, f.special);
  }
  create(name, special) { this.folders.set(name, { name, special: special || null, uidvalidity: this.nextV++, uidnext: 1, messages: [] }); }
  folder(name) {
    if (this.folders.has(name)) return this.folders.get(name);
    for (const f of this.folders.values()) if (f.name.toUpperCase() === String(name).toUpperCase() && f.name.toUpperCase() === 'INBOX') return f;
    return null;
  }
  add(folder, raw, o) {
    const f = this.folder(folder);
    const x = o || {};
    const m = { uid: f.uidnext++, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw).replace(/\r?\n/g, '\r\n'), 'utf8'), flags: new Set(x.flags || []),
      internaldate: x.internaldate || internalDate(x.date || '2026-11-03T08:00:00Z'), bodystructure: x.bodystructure || null };
    f.messages.push(m);
    return m.uid;
  }
  changeUidValidity(folder) {
    const f = this.folder(folder || 'INBOX');
    f.uidvalidity = this.nextV++;
    f.uidnext = 1;
    for (const m of f.messages) m.uid = f.uidnext++;
    f.uidnext += 5;
    return f.uidvalidity;
  }
  expunge(folder, uid) { const f = this.folder(folder); f.messages = f.messages.filter(m => m.uid !== uid); }
  find(folder, pred) { return this.folder(folder).messages.filter(pred || (() => true)); }
}

/* ------------------------------------------------------------------ command lexer */
function lexCmd(segs) {
  const toks = [];
  for (const seg of segs) {
    if (Buffer.isBuffer(seg)) { toks.push(seg); continue; }
    const s = seg;
    let i = 0;
    const stack = [toks];
    while (i < s.length) {
      const c = s[i];
      const top = stack[stack.length - 1];
      if (c === ' ') { i++; continue; }
      if (c === '(') { const a = []; top.push(a); stack.push(a); i++; continue; }
      if (c === ')') { stack.pop(); i++; continue; }
      if (c === '"') {
        let j = i + 1, out = '';
        while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; out += s[j]; j++; }
        top.push(out); i = j + 1; continue;
      }
      let j = i, depth = 0;
      while (j < s.length) { const d = s[j]; if (d === '[') depth++; else if (d === ']') depth--; else if (depth <= 0 && (d === ' ' || d === '(' || d === ')')) break; j++; }
      top.push(s.slice(i, j)); i = j;
    }
  }
  return toks;
}
function uidSet(spec, f) {
  const max = f.messages.length ? f.messages[f.messages.length - 1].uid : 0;
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split(':');
    const va = a === '*' ? max : Number(a);
    const vb = b === undefined ? va : (b === '*' ? max : Number(b));
    const lo = Math.min(va, vb), hi = Math.max(va, vb);
    for (const m of f.messages) if (m.uid >= lo && m.uid <= hi) out.add(m.uid);
    if (a === '*' && b === undefined && !f.messages.length) { /* empty */ }
  }
  return out;
}
function headerFields(raw, names) {
  const { head } = splitHB(raw);
  const lines = head.split('\r\n');
  const want = new Set(names.map(n => n.toLowerCase()));
  const out = [];
  let keep = false;
  for (const l of lines) {
    if (/^[ \t]/.test(l)) { if (keep) out.push(l); continue; }
    const m = /^([^:\s]+):/.exec(l);
    keep = !!(m && want.has(m[1].toLowerCase()));
    if (keep) out.push(l);
  }
  return Buffer.from(out.join('\r\n') + (out.length ? '\r\n' : '') + '\r\n', 'latin1');
}

/* ------------------------------------------------------------------ server */
function createFakeMailServer(opts) {
  const o = opts || {};
  const owner = (o.owner || 'no-reply@marsacloud.example').toLowerCase();
  const users = o.users || { [owner]: 'S3cr3t-"pw"\\x' };
  const mailbox = new Mailbox({ uidvalidity: o.uidvalidity });
  const BASE_CAPS = o.imapCaps || ['IMAP4rev1', 'SASL-IR', 'LOGIN-REFERRALS', 'ID', 'ENABLE', 'IDLE', 'LITERAL+', 'SPECIAL-USE', 'AUTH=PLAIN'];
  const BASE_EXT = o.smtpExt || ['PIPELINING', 'SIZE 52428800', 'AUTH PLAIN LOGIN', 'DSN', '8BITMIME', 'ENHANCEDSTATUSCODES'];
  const faults = { imap: {}, smtp: {} };
  const log = { imap: [], smtp: [] };
  const smtpState = { dataCommands: 0, dots: 0, messages: [] };
  const sockets = new Set();
  let connSeq = 0;
  let imapSrv = null, smtpSrv = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function writer(sock, chunkFn) {
    let chain = Promise.resolve();
    return data => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      chain = chain.then(async () => {
        if (sock.destroyed) return;
        const n = chunkFn();
        if (!n || n >= buf.length) { sock.write(buf); return; }
        for (let i = 0; i < buf.length; i += n) {
          if (sock.destroyed) return;
          sock.write(buf.subarray(i, i + n));
          await new Promise(r => setImmediate(r));
        }
      });
      return chain;
    };
  }

  /* ---------------------------------------------------------------- IMAP */
  function caps() {
    let c = (faults.imap.caps || BASE_CAPS).slice();
    if (faults.imap.loginDisabled) c = c.filter(x => !/^AUTH=/i.test(x)).concat(['LOGINDISABLED']);
    return c;
  }
  function checkUser(u, p) { return !faults.imap.authFail && Object.prototype.hasOwnProperty.call(users, String(u).toLowerCase()) && users[String(u).toLowerCase()] === p; }

  function onImap(sock) {
    sockets.add(sock);
    sock.setNoDelay(true);
    const conn = ++connSeq;
    const out = writer(sock, () => faults.imap.chunk || 0);
    let buf = Buffer.alloc(0);
    let segs = [];
    let need = 0;              // literal bytes still expected
    let authWait = null;       // tag awaiting a SASL continuation line
    let authed = false, selected = null;
    let queue = Promise.resolve();
    out('* OK [CAPABILITY ' + caps().join(' ') + '] fake IMAP ready\r\n');

    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (need > 0) {
          if (buf.length < need) return;
          segs.push(buf.subarray(0, need));
          buf = buf.subarray(need);
          need = 0;
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.subarray(0, i).toString('utf8');
        buf = buf.subarray(i + 2);
        if (authWait) { const t = authWait; authWait = null; queue = queue.then(() => finishAuth(t, line)); continue; }
        const m = /\{(\d+)(\+?)\}$/.exec(line);
        if (m) {
          segs.push(line.slice(0, m.index));
          need = Number(m[1]);
          if (!m[2]) out('+ Ready for literal data\r\n');
          if (need === 0) { segs.push(Buffer.alloc(0)); }
          continue;
        }
        segs.push(line);
        const cmd = segs;
        segs = [];
        queue = queue.then(() => handle(cmd)).catch(e => { out('* BAD internal ' + String(e.message).replace(/\s+/g, ' ').slice(0, 80) + '\r\n'); });
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));

    function unsolicited() {
      if (faults.imap.unsolicited) out('* 9 EXISTS\r\n* 1 EXPUNGE\r\n* 1 FETCH (FLAGS (\\Seen))\r\n* 2 FETCH (UID 999999 FLAGS ())\r\n* OK [ALERT] unsolicited\r\n');
    }
    function done(tag, text) { unsolicited(); return out(tag + ' ' + text + '\r\n'); }
    async function finishAuth(tag, line) {
      if (line === '*') return done(tag, 'BAD authentication cancelled');
      return plainAuth(tag, line);
    }
    function plainAuth(tag, b64) {
      const p = Buffer.from(b64, 'base64').toString('utf8').split('\u0000');
      if (p.length === 3 && checkUser(p[1], p[2])) { authed = true; return done(tag, 'OK [CAPABILITY ' + caps().join(' ') + '] Logged in'); }
      return done(tag, 'NO [AUTHENTICATIONFAILED] Authentication failed.');
    }
    async function handle(cmd) {
      const toks = lexCmd(cmd);
      const tag = String(toks[0] || '*');
      let verb = String(toks[1] || '').toUpperCase();
      let args = toks.slice(2);
      if (verb === 'UID') { verb = 'UID ' + String(args[0] || '').toUpperCase(); args = args.slice(1); }
      log.imap.push({ conn, tag, cmd: verb, line: cmd.map(x => (Buffer.isBuffer(x) ? '{' + x.length + '}' : x)).join('') });
      const sl = faults.imap.slow;
      if (sl && (sl.cmd === verb || sl.cmd === '*')) await sleep(sl.ms);
      if (sock.destroyed) return;
      const str = x => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x));
      switch (verb) {
        case 'CAPABILITY': out('* CAPABILITY ' + caps().join(' ') + '\r\n'); return done(tag, 'OK done');
        case 'NOOP': return done(tag, 'OK done');
        case 'LOGOUT': out('* BYE logging out\r\n'); await out(tag + ' OK bye\r\n'); sock.end(); return;
        case 'LOGIN':
          if (faults.imap.loginDisabled) return done(tag, 'NO [PRIVACYREQUIRED] Plaintext authentication disallowed');
          if (checkUser(str(args[0]), str(args[1]))) { authed = true; return done(tag, 'OK Logged in'); }
          return done(tag, 'NO [AUTHENTICATIONFAILED] Authentication failed.');
        case 'AUTHENTICATE':
          if (String(args[0]).toUpperCase() !== 'PLAIN' || faults.imap.loginDisabled) return done(tag, 'NO unsupported mechanism');
          if (args[1] !== undefined) return plainAuth(tag, str(args[1]));
          authWait = tag;
          return out('+ \r\n');
        default: break;
      }
      if (!authed) return done(tag, 'BAD not authenticated');
      if (verb === 'LIST') {
        for (const f of mailbox.folders.values()) out('* LIST (\\HasNoChildren' + (f.special && caps().includes('SPECIAL-USE') ? ' ' + f.special : '') + ') "." ' + iq(f.name) + '\r\n');
        return done(tag, 'OK List completed');
      }
      if (verb === 'EXAMINE' || verb === 'SELECT') {
        const f = mailbox.folder(str(args[0]));
        if (!f) return done(tag, 'NO [NONEXISTENT] Mailbox does not exist');
        selected = f;
        out('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* ' + f.messages.length + ' EXISTS\r\n* 0 RECENT\r\n');
        out('* OK [UIDVALIDITY ' + f.uidvalidity + '] UIDs valid\r\n');
        if (!faults.imap.noUidnext) out('* OK [UIDNEXT ' + f.uidnext + '] Predicted next UID\r\n');
        return done(tag, verb === 'EXAMINE' ? 'OK [READ-ONLY] Examine completed' : 'OK [READ-WRITE] Select completed');
      }
      if (verb === 'APPEND') {
        const f = mailbox.folder(str(args[0]));
        if (!f) return done(tag, 'NO [TRYCREATE] no such mailbox');
        const lit = args.find(Buffer.isBuffer);
        const flags = Array.isArray(args[1]) ? args[1] : [];
        if (faults.imap.appendFail) return done(tag, 'NO [OVERQUOTA] quota exceeded');
        const uid = mailbox.add(f.name, Buffer.from(lit), { flags, internaldate: internalDate(o.clock ? o.clock() : new Date()) });
        return done(tag, 'OK [APPENDUID ' + f.uidvalidity + ' ' + uid + '] Append completed');
      }
      if (!selected) return done(tag, 'BAD no mailbox selected');
      if (verb === 'UID SEARCH') return search(tag, args);
      if (verb === 'UID FETCH') return fetch(tag, args, true);
      if (verb === 'FETCH') return done(tag, 'OK seq fetch ignored');
      if (verb === 'UID STORE' || verb === 'STORE') {
        for (const m of selected.messages) if (uidSet(str(args[0]), selected).has(m.uid)) for (const fl of (Array.isArray(args[2]) ? args[2] : [args[2]])) m.flags.add(String(fl));
        return done(tag, 'OK Store completed');
      }
      return done(tag, 'BAD unknown command');
    }
    function search(tag, args) {
      const f = selected;
      let set = new Set(f.messages.map(m => m.uid));
      const str = x => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x));
      for (let i = 0; i < args.length; i++) {
        const a = String(args[i]).toUpperCase();
        if (a === 'ALL') continue;
        if (a === 'UID') { const s = uidSet(str(args[++i]), f); set = new Set([...set].filter(u => s.has(u))); continue; }
        if (a === 'HEADER') {
          const name = str(args[++i]).toLowerCase(), val = str(args[++i]).toLowerCase();
          set = new Set([...set].filter(u => { const m = f.messages.find(x => x.uid === u); const h = headerMap(splitHB(m.raw).head); return h[name] !== undefined && h[name].toLowerCase().includes(val); }));
          continue;
        }
        if (a === 'SINCE') {
          const d = parseImapDate(str(args[++i]));
          set = new Set([...set].filter(u => { const m = f.messages.find(x => x.uid === u); return parseImapDate(m.internaldate) >= d; }));
          continue;
        }
        return done(tag, 'BAD unsupported search key');
      }
      out('* SEARCH' + [...set].sort((x, y) => x - y).map(u => ' ' + u).join('') + '\r\n');
      return done(tag, 'OK Search completed');
    }
    function fetch(tag, args) {
      const f = selected;
      const set = uidSet(String(args[0]), f);
      const items = Array.isArray(args[1]) ? args[1].map(String) : [String(args[1])];
      const glued = items;      // the lexer keeps BODY.PEEK[HEADER.FIELDS (A B)] as one atom (bracket depth)
      if (faults.imap.fetchNo && set.has(faults.imap.fetchNo) && glued.some(x => /^BODY(\.PEEK)?\[/i.test(x))) return done(tag, 'NO Fetch refused for this message');
      f.messages.forEach((m, idx) => {
        if (!set.has(m.uid)) return;
        const parts = [Buffer.from('* ' + (idx + 1) + ' FETCH (UID ' + m.uid)];
        let setSeen = false;
        for (const it of glued) {
          const u = it.toUpperCase();
          if (u === 'UID') continue;
          if (u === 'FLAGS') parts.push(Buffer.from(' FLAGS (' + [...m.flags].join(' ') + ')'));
          else if (u === 'RFC822.SIZE') parts.push(Buffer.from(' RFC822.SIZE ' + m.raw.length));
          else if (u === 'INTERNALDATE') parts.push(Buffer.from(' INTERNALDATE ' + iq(m.internaldate)));
          else if (u === 'BODYSTRUCTURE') parts.push(Buffer.from(' BODYSTRUCTURE ' + (m.bodystructure || bodystructure(m.raw))));
          else {
            const b = /^BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?$/i.exec(it);
            if (!b) continue;
            if (!b[1]) setSeen = true;
            const sec = b[2].toUpperCase();
            let data;
            if (sec === '') data = m.raw;
            else if (sec === 'HEADER') data = splitHB(m.raw).headBuf;
            else if (sec === 'TEXT') data = splitHB(m.raw).body;
            else if (sec.startsWith('HEADER.FIELDS')) data = headerFields(m.raw, (/\(([^)]*)\)/.exec(b[2]) || ['', ''])[1].trim().split(/\s+/));
            else if (/^[0-9]+(\.[0-9]+)*(\.(HEADER|TEXT))?$/.test(sec)) data = partSection(m.raw, sec);
            else data = Buffer.alloc(0);
            let key = 'BODY[' + b[2] + ']';
            if (b[3] !== undefined) { const st = Number(b[3]); data = data.subarray(st, b[4] !== undefined ? st + Number(b[4]) : undefined); key += '<' + st + '>'; }
            parts.push(Buffer.from(' ' + key + ' {' + data.length + '}\r\n'), Buffer.from(data));
          }
        }
        if (setSeen) { m.flags.add('\\Seen'); parts.push(Buffer.from(' FLAGS (' + [...m.flags].join(' ') + ')')); }
        parts.push(Buffer.from(')\r\n'));
        out(Buffer.concat(parts));
      });
      return done(tag, 'OK Fetch completed');
    }
  }

  /* ---------------------------------------------------------------- SMTP */
  function onSmtp(sock) {
    sockets.add(sock);
    sock.setNoDelay(true);
    const conn = ++connSeq;
    const out = writer(sock, () => faults.smtp.chunk || 0);
    let buf = Buffer.alloc(0);
    let inData = false, authStep = null, authUser = null, authed = false;
    let tx = null;
    let queue = Promise.resolve();
    const F = () => faults.smtp;
    const failAt = stage => (F().failAt && F().failAt.stage === stage ? F().failAt.code : null);
    async function slow(stage) { const s = F().slow; if (s && s.stage === stage) await sleep(s.ms); }
    const reply = (code, text) => out(code + ' ' + text + '\r\n');

    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
    queue = queue.then(async () => {
      await slow('greeting');
      const c = failAt('greeting');
      if (c) { await reply(c, 'service not available'); if (c === 421) sock.end(); return; }
      await reply(220, 'ESMTP fake.smtp.example');
    });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (inData) {
          const s = buf.toString('latin1');
          const end = s.startsWith('.\r\n') ? 0 : s.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = end === 0 ? '' : s.slice(0, end + 2);
          buf = buf.subarray(end === 0 ? 3 : end + 5);
          inData = false;
          const data = Buffer.from(raw.replace(/(^|\r\n)\./g, '$1'), 'latin1');     // RFC 5321 § 4.5.2 un-stuffing
          const wire = Buffer.from(raw, 'latin1');
          queue = queue.then(() => endData(data, wire));
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.subarray(0, i).toString('utf8');
        buf = buf.subarray(i + 2);
        log.smtp.push({ conn, line });
        queue = queue.then(() => handle(line));
        if (/^DATA$/i.test(line) && tx && tx.rcpts.length && !failAt('data')) inData = true;
      }
    });
    async function endData(data, wire) {
      smtpState.dots++;
      const msg = { from: tx.from, mailParams: tx.params, rcpts: tx.rcpts, data, wire };
      const deliver = () => {
        smtpState.messages.push(msg);
        if (msg.rcpts.some(r => r.addr === owner)) mailbox.add('INBOX', data, { internaldate: internalDate(o.clock ? o.clock() : new Date()) });
        if (F().autoSaveSent) mailbox.add('INBOX.Sent', data, { flags: ['\\Seen'] });
      };
      tx = null;
      if (F().dropAfterDot) { if (F().deliverOnDrop !== false) deliver(); sock.destroy(); return; }
      await slow('dot');
      const c = failAt('dot');
      if (c) return reply(c, c >= 500 ? '5.7.1 message rejected' : '4.3.0 try again later');
      deliver();
      return reply(250, '2.0.0 Ok: queued as FAKE' + smtpState.messages.length);
    }
    async function handle(line) {
      if (sock.destroyed) return;
      if (authStep) {
        if (line === '*') { authStep = null; return reply(501, '5.7.0 auth cancelled'); }
        const v = Buffer.from(line, 'base64').toString('utf8');
        if (authStep === 'plain') { authStep = null; return finishAuth(v.split('\u0000')[1], v.split('\u0000')[2]); }
        if (authStep === 'login-user') { authUser = v; authStep = 'login-pw'; return reply(334, 'UGFzc3dvcmQ6'); }
        if (authStep === 'login-pw') { authStep = null; return finishAuth(authUser, v); }
      }
      const verb = (/^(\S+)/.exec(line) || ['', ''])[1].toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') {
        await slow('ehlo');
        const c = failAt('ehlo');
        if (c) return reply(c, 'ehlo refused');
        const ext = F().ext || BASE_EXT;
        const lines = ['fake.smtp.example'].concat(ext);
        return out(lines.map((x, i) => (i === lines.length - 1 ? '250 ' : '250-') + x).join('\r\n') + '\r\n');
      }
      if (verb === 'AUTH') {
        await slow('auth');
        const c = failAt('auth');
        if (c) return reply(c, '5.7.8 Error: authentication failed');
        const p = line.split(/\s+/);
        const mech = String(p[1] || '').toUpperCase();
        if (mech === 'PLAIN') {
          if (p[2]) { const v = Buffer.from(p[2], 'base64').toString('utf8').split('\u0000'); return finishAuth(v[1], v[2]); }
          authStep = 'plain'; return reply(334, '');
        }
        if (mech === 'LOGIN') { authStep = 'login-user'; return reply(334, 'VXNlcm5hbWU6'); }
        return reply(504, '5.5.4 unrecognized mechanism');
      }
      if (verb === 'QUIT') { await reply(221, '2.0.0 Bye'); sock.end(); return; }
      if (verb === 'RSET') { tx = null; return reply(250, '2.0.0 Ok'); }
      if (verb === 'NOOP') return reply(250, '2.0.0 Ok');
      if (verb === 'MAIL') {
        if (!authed) return reply(530, '5.7.0 Authentication required');
        await slow('mail');
        const c = failAt('mail');
        if (c) return reply(c, 'sender refused');
        const m = /^MAIL FROM:<([^>]*)>(.*)$/i.exec(line);
        if (!m) return reply(501, '5.5.4 syntax');
        const rf = (F().rejectFrom || {})[m[1].toLowerCase()];
        if (rf) return reply(rf, rf >= 500 ? '5.7.1 Sender address rejected: not owned by user' : '4.7.1 try later');
        tx = { from: m[1], params: m[2].trim(), rcpts: [] };
        return reply(250, '2.1.0 Ok');
      }
      if (verb === 'RCPT') {
        if (!tx) return reply(503, '5.5.1 need MAIL');
        const m = /^RCPT TO:<([^>]*)>(.*)$/i.exec(line);
        if (!m) return reply(501, '5.5.4 syntax');
        await slow('rcpt');
        const addr = m[1].toLowerCase();
        const rj = (F().rejectRcpt || {})[addr] || failAt('rcpt');
        if (rj) return reply(rj, rj >= 500 ? '5.1.1 <' + addr + '>: Recipient address rejected' : '4.5.3 Too many recipients');
        tx.rcpts.push({ addr, params: m[2].trim() });
        return reply(250, '2.1.5 Ok');
      }
      if (verb === 'DATA') {
        smtpState.dataCommands++;
        if (!tx || !tx.rcpts.length) return reply(554, '5.5.1 no valid recipients');
        await slow('data');
        const c = failAt('data');
        if (c) return reply(c, 'data refused');
        return reply(354, 'End data with <CR><LF>.<CR><LF>');
      }
      return reply(502, '5.5.2 command not recognized');
    }
    function finishAuth(u, p) {
      if (!F().authFail && Object.prototype.hasOwnProperty.call(users, String(u || '').toLowerCase()) && users[String(u).toLowerCase()] === p) { authed = true; return reply(235, '2.7.0 Authentication successful'); }
      return reply(535, '5.7.8 Error: authentication failed');
    }
  }

  return {
    mailbox, faults, log, smtp: smtpState, owner, users,
    async start() {
      imapSrv = net.createServer(onImap);
      smtpSrv = net.createServer(onSmtp);
      await new Promise(r => imapSrv.listen(0, '127.0.0.1', r));
      await new Promise(r => smtpSrv.listen(0, '127.0.0.1', r));
      return { imapPort: imapSrv.address().port, smtpPort: smtpSrv.address().port };
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await Promise.all([imapSrv, smtpSrv].filter(Boolean).map(s => new Promise(r => s.close(() => r()))));
    },
    reset() {
      for (const k of Object.keys(faults.imap)) delete faults.imap[k];
      for (const k of Object.keys(faults.smtp)) delete faults.smtp[k];
      log.imap.length = 0; log.smtp.length = 0;
      smtpState.dataCommands = 0; smtpState.dots = 0; smtpState.messages.length = 0;
    }
  };
}

/* ------------------------------------------------------------------ the adapter's connect() over net (loopback only) */
function createNodeConnect() {
  const stats = { connects: 0, reads: 0 };
  function connect(host, port, opts) {
    void host;
    const timeoutMs = (opts && opts.timeoutMs) || 10000;
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.setNoDelay(true);
      const q = [], waiters = [];
      let ended = false;
      const flush = () => { while (waiters.length) waiters.shift()(null); };
      const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
      s.on('data', d => {
        stats.reads++;
        const u = new Uint8Array(d.length);
        u.set(d);
        if (waiters.length) waiters.shift()(u); else q.push(u);
      });
      s.on('end', () => { ended = true; flush(); });
      s.on('close', () => { ended = true; flush(); });
      s.on('error', e => { ended = true; flush(); clearTimeout(t); reject(e); });
      s.once('connect', () => {
        clearTimeout(t);
        stats.connects++;
        resolve({
          read: () => (q.length ? Promise.resolve(q.shift()) : (ended ? Promise.resolve(null) : new Promise(r => waiters.push(r)))),
          write: b => new Promise((res, rej) => { if (s.destroyed) { rej(new Error('closed')); return; } s.write(Buffer.from(b), e => (e ? rej(e) : res())); }),
          close: () => { ended = true; s.destroy(); flush(); }
        });
      });
    });
  }
  connect.stats = stats;
  return connect;
}

module.exports = { createFakeMailServer, createNodeConnect, Mailbox, bodystructure, internalDate };
