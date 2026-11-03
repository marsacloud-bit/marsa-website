/*
  Marsa (مرسى) — G6c live e-mail: dependency-free MIME parser / builder (docs/online/G6C_LIVE_EMAIL.md § email-mime.js).
  STAGING ONLY. Plain classic script (no import / export, no require), ES2020, no dependencies, no network, no env:
  node tests require() it, Deno loads it by side-effect import and reads globalThis.MarsaInbox.
  TextDecoder / TextEncoder are looked up at CALL time only (the vm load-order test has no TextDecoder); built-in tables
  cover utf-8, us-ascii, iso-8859-1, iso-8859-6, windows-1252 and windows-1256 when TextDecoder is missing.

  This file defines:
    - parseMessage(bytes, {maxBody=100000, maxParts=50, maxDepth=5}) → {headers[{name,value}], header(n), headerAll(n),
        rawHeader(n), rawHeaderAll(n), text, html, htmlOnly, attachments[{part, file_name, mime_type, size_bytes, content_id}], isDsn}
      headers are unfolded + RFC 2047 decoded, top first; rawHeader / rawHeaderAll (and the NON-enumerable rawHeaders
      [{name, raw}]) are the same values WITHOUT RFC 2047 decoding: addresses, Message-IDs and Authentication-Results are
      parsed from them only (RFC 2047 § 6.1, security review C2 / H5); every regex runs on linear patterns over text cut
      to 4 × maxBody first (correctness review C1); text is the best text/plain (else htmlToText of the html),
      control-stripped and capped so the final length INCLUDING the truncation marker is <= maxBody (review M2);
      attachment sizes are integers estimated from the encoded size, clamped to 26214400 (review C1);
      the decoded leaf parts are kept on a NON-enumerable `parts` property (parseDsn reads it; JSON never sees bodies);
    - parseAuthResults(parsed, authservId) → {spf, dkim, dmarc}: ONLY the topmost Authentication-Results header, read RAW,
      only when it sits above every Received header (added on this hop) and its authserv-id equals authservId
      (case-insensitive); anything else → all 'none' (design § 4, security review H5). Non-enumerable extras:
      dmarc_header_from (the domain the dmarc result is about) and dkim_pass_domains (security review H3 / H4);
    - parseDsn(parsed) → null | {envelope_id, original_message_id, recipients[{final_recipient, action, status}]} (RFC 3464);
      the original Message-ID comes from the text/rfc822-headers or message/rfc822 part only, never from free text;
    - parseDate(str) → ISO string | null: RFC 5322 (incl. obsolete zones, 2-digit years), IMAP INTERNALDATE, ISO 8601 (review M3);
    - isMsgId(s) — ^<[^\s<>()\x00-\x1f]{1,250}>$ (review H3);
    - sanitizeText(s, maxCodePoints) — strip U+0000 + C0 controls except \t \n \r, drop lone surrogates, cut by code points (review C1);
    - buildMessage(req, cfg) → Uint8Array RFC 5322 message (CRLF, base64 text/plain utf-8, RFC 2047 B words <= 75 chars that
      never split a UTF-8 sequence, In-Reply-To / References only for valid msg-ids, References folded at 78) (review H3, L4).
      Throws MimeError (fixed message + code, never the input) on CR / LF / NUL in any header input or a non-ASCII address.
      Dot-stuffing is the SMTP client's job, not this file's. cfg.envelopeId is SMTP-only (MAIL FROM ENVID=), never a header.
    - MimeError, mimeHtmlToText (exported under its own name so adapters.js htmlToText is never overwritten on
      globalThis.MarsaInbox), decodeHeaderValue, decodeEncodedWords (RFC 2047 on an already-decoded phrase),
      rawHeaderText, decodeCharset, base64Encode / base64Decode, MIME_LIMITS.
*/
(function () {
  'use strict';

  const MIME_LIMITS = Object.freeze({
    maxBody: 100000, maxParts: 50, maxDepth: 5, headers: 1000, header_value: 16384,
    attachment_bytes: 26214400, file_name: 255, mime_type: 120, content_id: 250, dsn_recipients: 50, envelope_id: 100, references: 20
  });
  const TRUNC_MARKER = '\n[…]';

  class MimeError extends Error {
    constructor(code, message) {
      super(message || code);
      this.name = 'MimeError';
      this.code = String(code || 'mime').slice(0, 60);
    }
    toJSON() { return { name: this.name, code: this.code, message: this.message }; }
  }

  /* ---------------------------------------------------------------- bytes <-> binary strings (1 char = 1 byte) */
  function bytesToBin(u8) {
    let out = '';
    for (let i = 0; i < u8.length; i += 8192) out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 8192)));
    return out;
  }
  function binToBytes(s) {
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
    return u8;
  }
  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x && typeof x === 'object' && typeof x.byteLength === 'number' && !ArrayBuffer.isView(x)) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (typeof x === 'string') return binToBytes(x);
    return new Uint8Array(0);
  }

  /* ---------------------------------------------------------------- UTF-8 (manual fallback when TextEncoder / TextDecoder are absent) */
  function utf8Encode(s) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
    const out = [];
    for (const ch of String(s)) {
      let c = ch.codePointAt(0);
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  }
  // WHATWG UTF-8 decoder (maximal-subpart replacement) → {text, bad}: bad = number of U+FFFD emitted for invalid input
  function utf8DecodeManual(u8) {
    let out = '', bad = 0, cp = 0, need = 0, seen = 0, lo = 0x80, hi = 0xbf;
    for (let i = 0; i < u8.length; i++) {
      const b = u8[i];
      if (need === 0) {
        if (b < 0x80) out += String.fromCharCode(b);
        else if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; }
        else if (b >= 0xe0 && b <= 0xef) { if (b === 0xe0) lo = 0xa0; if (b === 0xed) hi = 0x9f; need = 2; cp = b & 0x0f; }
        else if (b >= 0xf0 && b <= 0xf4) { if (b === 0xf0) lo = 0x90; if (b === 0xf4) hi = 0x8f; need = 3; cp = b & 0x07; }
        else { out += '\ufffd'; bad++; }
        continue;
      }
      if (b < lo || b > hi) {           // invalid continuation: one U+FFFD, then re-read this byte as a lead
        cp = need = seen = 0; lo = 0x80; hi = 0xbf; out += '\ufffd'; bad++; i--; continue;
      }
      lo = 0x80; hi = 0xbf; cp = (cp << 6) | (b & 0x3f); seen++;
      if (seen === need) { out += String.fromCodePoint(cp); cp = need = seen = 0; }
    }
    if (need) { out += '\ufffd'; bad++; }
    return { text: out, bad };
  }
  function utf8Decode(u8, fatal) {
    if (typeof TextDecoder === 'function') {
      try { return new TextDecoder('utf-8', { fatal: !!fatal }).decode(u8); }
      catch (e) { if (fatal) return null; }
    }
    const r = utf8DecodeManual(u8);
    return fatal && r.bad ? null : r.text;
  }

  /* ---------------------------------------------------------------- single-byte charsets (WHATWG tables, high half) */
  const CP1252_80 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f' +
    '\u0090‘’“”•–—˜™š›œ\u009džŸ';
  const CP1256_80 = '€پ‚ƒ„…†‡ˆ‰ٹ‹Œچژڈ' +
    'گ‘’“”•–—ک™ڑ›œ‌‍ں' +
    ' ،¢£¤¥¦§¨©ھ«¬­®¯' +
    '°±²³´µ¶·¸¹؛»¼½¾؟' +
    'ہءآأؤإئابةتثجحخد' +
    'ذرزسشصض×طظعغـفقك' +
    'àلâمنهوçèéêëىيîï' +
    'ًٌٍَôُِ÷ّùْûü‎‏ے';
  const R = '�';
  const ISO8859_6_A0 = ' ' + R + R + R + '¤' + R.repeat(7) + '،­' + R.repeat(13) + '؛' + R + R + R + '؟' +
    R + 'ءآأؤإئابةتثجحخد' +
    'ذرزسشصضطظعغ' + R.repeat(5) +
    'ـفقكلمنهوىيًٌٍَُ' +
    'ِّْ' + R.repeat(13);
  function singleByte(u8, high) {   // high: function(byte >= 0x80) → char
    let out = '';
    for (let i = 0; i < u8.length; i++) { const b = u8[i]; out += b < 0x80 ? String.fromCharCode(b) : high(b); }
    return out;
  }
  const BUILTIN = {
    'utf-8': u8 => utf8Decode(u8, false),
    'iso-8859-1': u8 => singleByte(u8, b => (b < 0xa0 ? CP1252_80[b - 0x80] : String.fromCharCode(b))),   // WHATWG: latin1 = 1252
    'windows-1252': u8 => singleByte(u8, b => (b < 0xa0 ? CP1252_80[b - 0x80] : String.fromCharCode(b))),
    'us-ascii': u8 => singleByte(u8, b => (b < 0xa0 ? CP1252_80[b - 0x80] : String.fromCharCode(b))),
    'windows-1256': u8 => singleByte(u8, b => CP1256_80[b - 0x80]),
    'iso-8859-6': u8 => singleByte(u8, b => (b < 0xa0 ? String.fromCharCode(b) : ISO8859_6_A0[b - 0xa0]))
  };
  const CHARSET_ALIASES = {
    utf8: 'utf-8', 'utf-8': 'utf-8', 'unicode-1-1-utf-8': 'utf-8',
    ascii: 'us-ascii', 'us-ascii': 'us-ascii', 'ansi_x3.4-1968': 'us-ascii', 'iso646-us': 'us-ascii',
    latin1: 'iso-8859-1', 'iso-8859-1': 'iso-8859-1', iso8859_1: 'iso-8859-1', 'iso8859-1': 'iso-8859-1', 'iso_8859-1': 'iso-8859-1', l1: 'iso-8859-1',
    'iso-8859-6': 'iso-8859-6', 'iso8859-6': 'iso-8859-6', iso8859_6: 'iso-8859-6', 'iso_8859-6': 'iso-8859-6', arabic: 'iso-8859-6',
    'iso-8859-6-i': 'iso-8859-6', 'iso-8859-6-e': 'iso-8859-6', 'asmo-708': 'iso-8859-6',
    'windows-1252': 'windows-1252', cp1252: 'windows-1252', 'x-cp1252': 'windows-1252',
    'windows-1256': 'windows-1256', cp1256: 'windows-1256', 'x-cp1256': 'windows-1256'
  };
  function normCharset(cs) {
    const s = String(cs || '').trim().replace(/^["']|["']$/g, '').replace(/\*.*$/, '').toLowerCase();
    return CHARSET_ALIASES[s] || s;
  }
  // undeclared / us-ascii with 8-bit bytes: valid UTF-8 wins, else windows-1252
  function decodeGuess(u8) {
    let hi = false;
    for (let i = 0; i < u8.length; i++) if (u8[i] >= 0x80) { hi = true; break; }
    if (!hi) return BUILTIN['us-ascii'](u8);
    const t = utf8Decode(u8, true);
    return t === null ? decodeLabel(u8, 'windows-1252') : t;
  }
  function decodeLabel(u8, label) {
    if (typeof TextDecoder === 'function' && label) {
      try { return new TextDecoder(label).decode(u8); } catch (e) { /* label unknown to this engine → built-in table */ }
    }
    return BUILTIN[label] ? BUILTIN[label](u8) : utf8Decode(u8, false);
  }
  // bytes (Uint8Array or binary string) + charset label → JS string; unknown charset → utf-8 with replacement
  function decodeCharset(bytes, charset) {
    const u8 = typeof bytes === 'string' ? binToBytes(bytes) : toBytes(bytes);
    const label = normCharset(charset);
    if (!label || label === 'us-ascii') return decodeGuess(u8);
    if (label === 'utf-8') return utf8Decode(u8, false);
    return decodeLabel(u8, label);
  }

  /* ---------------------------------------------------------------- base64 / quoted-printable */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_REV = (() => { const t = new Int16Array(256).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; return t; })();
  function base64Encode(u8) {
    let out = '';
    for (let i = 0; i < u8.length; i += 3) {
      const a = u8[i], b = u8[i + 1], c = u8[i + 2];
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < u8.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < u8.length ? B64[n & 63] : '=');
    }
    return out;
  }
  // lenient: skips anything outside the alphabet, stops at '=' → binary string
  function base64Decode(s) {
    const out = [];
    let acc = 0, bits = 0, chunk = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 61) break;
      const v = c < 256 ? B64_REV[c] : -1;
      if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
      if (out.length >= 8192) { chunk += String.fromCharCode.apply(null, out); out.length = 0; }
    }
    return chunk + String.fromCharCode.apply(null, out);
  }
  const b64Count = s => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c === 61) break; if (c < 256 && B64_REV[c] >= 0) n++; } return n; };
  // trailing blanks cut with a char-code loop (a [ \t]+ regex is quadratic on a long blank run, correctness review C1)
  function trimEndWs(l) {
    let e = l.length;
    while (e > 0 && (l.charCodeAt(e - 1) === 32 || l.charCodeAt(e - 1) === 9)) e--;
    return e === l.length ? l : l.slice(0, e);
  }
  // quoted-printable, line by line (linear): trailing blanks dropped, soft breaks "=" + EOL joined, =XX decoded
  function qpDecode(s) {
    const lines = s.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      if (i === lines.length - 1) { out.push(l); break; }
      const cr = l.charCodeAt(l.length - 1) === 13;
      l = trimEndWs(cr ? l.slice(0, -1) : l);
      if (l.charCodeAt(l.length - 1) === 61) out.push(l.slice(0, -1));
      else out.push(l + (cr ? '\r\n' : '\n'));
    }
    return out.join('').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  function decodeCte(bin, cte) {
    const e = String(cte || '').trim().toLowerCase();
    if (e === 'base64') return base64Decode(bin);
    if (e === 'quoted-printable') return qpDecode(bin);
    return bin;   // 7bit / 8bit / binary / unknown
  }

  /* ---------------------------------------------------------------- text helpers */
  const cpLen = s => Array.from(String(s === null || s === undefined ? '' : s)).length;
  const cpSlice = (s, n) => Array.from(String(s)).slice(0, n).join('');
  const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
  // strip U+0000 + C0 controls except \t \n \r, drop lone surrogates, cut by code points (review C1)
  function sanitizeText(s, maxCodePoints) {
    if (s === null || s === undefined) return '';
    let t = String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(LONE_SURROGATE_RE, '');
    const max = Number(maxCodePoints);
    if (Number.isFinite(max) && max >= 0 && t.length > max) t = cpSlice(t, Math.floor(max));
    return t;
  }
  // single-line header text: tabs / newlines → space, every other control dropped
  function cleanLine(s, max) {
    return sanitizeText(String(s).replace(/[\t\r\n]+/g, ' ').replace(/\u007f/g, ''), max || MIME_LIMITS.header_value).trim();
  }
  // cap so that the FINAL length including the marker is <= max code points (review M2)
  function capBody(t, max) {
    if (t.length <= max || cpLen(t) <= max) return t;
    return cpSlice(t, Math.max(0, max - cpLen(TRUNC_MARKER))) + TRUNC_MARKER;
  }
  const decodeEntity = (m, dec, hex) => {
    const n = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  };
  // comments and <script> / <style> / <head> blocks removed with an indexOf scan (linear: the lazy regexes were quadratic
  // on unclosed openers, correctness review C1); a closer that is absent once is never searched for again
  function stripBlocks(s) {
    const lc = s.replace(/[A-Z]+/g, x => x.toLowerCase());          // ASCII only: same length, indexes stay valid
    const none = {};
    const find = (what, from) => { if (none[what] !== undefined && none[what] <= from) return -1; const k = lc.indexOf(what, from); if (k < 0) none[what] = from; return k; };
    let out = '', i = 0;
    for (;;) {
      const lt = lc.indexOf('<', i);
      if (lt < 0) return out + s.slice(i);
      if (lc.startsWith('<!--', lt)) {
        const end = find('-->', lt + 4);
        if (end >= 0) { out += s.slice(i, lt); i = end + 3; continue; }
      } else {
        const m = /^<(script|style|head)(?=[\s\/>])/.exec(lc.slice(lt, lt + 8));
        const gt = m ? find('>', lt) : -1;
        const end = gt >= 0 ? find('</' + m[1] + '>', gt + 1) : -1;
        if (end >= 0) { out += s.slice(i, lt); i = end + m[1].length + 3; continue; }
      }
      out += s.slice(i, lt + 1);
      i = lt + 1;
    }
  }
  // HTML → plain text: the same rules as adapters.js htmlToText, plus comments / <head> removal and numeric entities
  function htmlToText(html) {
    const t = stripBlocks(String(html))
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^<>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&#(\d{1,7});|&#x([0-9a-f]{1,6});/gi, decodeEntity).replace(/&amp;/g, '&')
      .replace(/\r\n/g, '\n');
    return t.split('\n').map(trimEndWs).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------------------------------------------------------------- headers */
  // RFC 2047 encoded words; adjacent words (whitespace only between them) are joined, same-charset bytes decoded together
  const EW_RE = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;
  function decode2047(s) {
    if (s.indexOf('=?') < 0) return s;
    let out = '', last = 0, pend = null, m;
    const flush = () => { if (pend) { out += decodeCharset(pend.bytes, pend.cs); pend = null; } };
    EW_RE.lastIndex = 0;
    while ((m = EW_RE.exec(s)) !== null) {
      const gap = s.slice(last, m.index);
      if (!(pend && /^[ \t\r\n]*$/.test(gap))) { flush(); out += gap; }
      const cs = normCharset(m[1]);
      const bytes = /b/i.test(m[2]) ? base64Decode(m[3]) : m[3].replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16)));
      if (pend && pend.cs === cs) pend.bytes += bytes;
      else { flush(); pend = { cs, bytes }; }
      last = EW_RE.lastIndex;
    }
    flush();
    return out + s.slice(last);
  }
  // raw (binary) header value → structured text: raw 8-bit = UTF-8 (RFC 6532) else windows-1252, then cleanLine; NO RFC 2047
  // (addresses, Message-IDs and Authentication-Results are parsed from this form, RFC 2047 § 6.1 / security review C2)
  function rawHeaderText(raw) {
    let s = String(raw === null || raw === undefined ? '' : raw);
    if (/[\x80-\xff]/.test(s)) s = decodeGuess(binToBytes(s));
    return cleanLine(s);
  }
  // raw (binary) header value → display text: rawHeaderText, then RFC 2047, then cleanLine
  function decodeHeaderValue(raw) {
    let s = String(raw === null || raw === undefined ? '' : raw);
    if (/[\x80-\xff]/.test(s)) s = decodeGuess(binToBytes(s));
    return cleanLine(decode2047(s));
  }
  // an already-decoded JS string (e.g. a display-name phrase cut from rawHeaderText) → RFC 2047 decoded, cleanLine
  const decodeEncodedWords = s => cleanLine(decode2047(String(s === null || s === undefined ? '' : s)));
  function splitHeadBody(bin) {
    if (/^\r?\n/.test(bin)) return { head: '', body: bin.replace(/^\r?\n/, '') };
    const m = /\r?\n\r?\n/.exec(bin);
    if (!m) return { head: bin, body: '' };
    return { head: bin.slice(0, m.index), body: bin.slice(m.index + m[0].length) };
  }
  // → [{name, raw}] in order; folded lines unfolded (CRLF removed, the WSP kept); invalid lines ignored
  function parseHeaderBlock(head) {
    const fields = [];
    const lines = head.split(/\r?\n/);
    for (const line of lines) {
      if (/^[ \t]/.test(line)) { if (fields.length) fields[fields.length - 1].raw += line; continue; }
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const name = line.slice(0, i).trim();
      if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
      if (fields.length >= MIME_LIMITS.headers) break;
      fields.push({ name, raw: line.slice(i + 1) });
    }
    for (const f of fields) f.raw = trimEndWs(f.raw.replace(/^[ \t]+/, ''));      // loop trim: linear (correctness review C1)
    return fields;
  }
  const firstRaw = (fields, name) => { const n = name.toLowerCase(); const f = fields.find(x => x.name.toLowerCase() === n); return f ? f.raw : null; };

  // RFC 2045 structured value + RFC 2231 parameters → {value, params:{name:string}, decoded:Set(names already decoded)}
  function stripComments(s) {
    let out = '', depth = 0, q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { out += c; if (c === '\\' && i + 1 < s.length) out += s[++i]; else if (c === '"') q = false; continue; }
      if (c === '"' && depth === 0) { q = true; out += c; continue; }
      if (c === '(') { depth++; continue; }
      if (c === ')' && depth > 0) { depth--; continue; }
      if (c === '\\' && depth > 0) { i++; continue; }
      if (depth === 0) out += c;
    }
    return out;
  }
  function splitSemi(s) {   // split at ';' outside quoted strings
    const parts = [];
    let cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === '\\' && i + 1 < s.length) cur += s[++i]; else if (c === '"') q = false; continue; }
      if (c === '"') { q = true; cur += c; continue; }
      if (c === ';') { parts.push(cur); cur = ''; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts;
  }
  const unquote = v => { const t = v.trim(); return t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"' ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t; };
  function parseStructured(raw, dflt) {
    const segs = splitSemi(stripComments(String(raw || '')));
    const value = (segs[0] || '').trim().toLowerCase() || dflt || '';
    const params = {}, decoded = new Set(), cont = {};
    for (const seg of segs.slice(1)) {
      const i = seg.indexOf('=');
      if (i <= 0) continue;
      const key = seg.slice(0, i).trim().toLowerCase();
      const val = unquote(seg.slice(i + 1));
      const m = /^([^*]+)\*(?:(\d+)\*?|)$/.exec(key);
      if (m && key.indexOf('*') > 0) {
        const base = m[1], idx = m[2] === undefined ? 0 : parseInt(m[2], 10), enc = /\*$/.test(key);
        (cont[base] = cont[base] || []).push({ idx, enc, val });
      } else if (!(key in params)) params[key] = val;
    }
    for (const base of Object.keys(cont)) {
      const list = cont[base].sort((a, b) => a.idx - b.idx);
      let cs = 'utf-8', bin = '';
      list.forEach((p, k) => {
        let v = p.val;
        if (p.enc && k === 0) { const q = /^([^']*)'[^']*'([\s\S]*)$/.exec(v); if (q) { cs = q[1] || 'utf-8'; v = q[2]; } }
        bin += p.enc ? v.replace(/%([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16))) : v;
      });
      params[base] = cleanLine(decodeCharset(bin, cs));
      decoded.add(base);
    }
    return { value, params, decoded };
  }
  const paramText = (st, name) => {
    if (!st || st.params[name] === undefined) return '';
    return st.decoded.has(name) ? st.params[name] : decodeHeaderValue(st.params[name]);
  };

  /* ---------------------------------------------------------------- multipart walk */
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }
  function splitMultipart(body, boundary) {
    const re = new RegExp('(?:^|\\r?\\n)--' + escRe(boundary) + '(--)?[ \\t]*(?=\\r?\\n|$)', 'g');
    const out = [];
    let m, start = -1;
    while ((m = re.exec(body)) !== null) {
      if (start >= 0) out.push(body.slice(start, m.index));
      if (m[1]) { start = -1; break; }
      start = re.lastIndex;
      const nl = /^\r?\n/.exec(body.slice(start, start + 2));
      if (nl) start += nl[0].length;
    }
    if (start >= 0 && start <= body.length) out.push(body.slice(start));   // no close delimiter (truncated) → keep the tail
    return out;
  }
  function walk(bin, partId, depth, ctx, pre) {
    if (ctx.count >= ctx.maxParts) { ctx.truncated = true; return; }
    ctx.count++;
    const hb = pre || splitHeadBody(bin);
    const fields = pre ? pre.fields : parseHeaderBlock(hb.head);
    const ct = parseStructured(firstRaw(fields, 'content-type'), 'text/plain');
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(ct.value)) ct.value = 'text/plain';
    if (ct.value.startsWith('multipart/')) {
      const boundary = ct.params.boundary;
      if (!boundary || depth >= ctx.maxDepth) { ctx.truncated = true; return; }
      if (depth === 0 && ct.value === 'multipart/report' && String(ct.params['report-type'] || '').toLowerCase() === 'delivery-status') ctx.isDsn = true;
      const kids = splitMultipart(hb.body, boundary);
      kids.forEach((k, i) => walk(k, partId ? partId + '.' + (i + 1) : String(i + 1), depth + 1, ctx, null));
      return;
    }
    const cdRaw = firstRaw(fields, 'content-disposition');
    ctx.leaves.push({
      part: partId || '1', type: ct.value, ct, cd: cdRaw === null ? null : parseStructured(cdRaw, ''),
      cte: String(firstRaw(fields, 'content-transfer-encoding') || '').trim().toLowerCase(),
      cid: firstRaw(fields, 'content-id'), body: hb.body
    });
  }
  const leafFileName = l => paramText(l.cd, 'filename') || paramText(l.ct, 'name');
  const isAttachmentLike = l => !!((l.cd && l.cd.value === 'attachment') || leafFileName(l));
  function leafText(l) {
    return decodeCharset(decodeCte(l.body, l.cte), l.ct.params.charset || '');
  }
  function estimateSize(l) {
    let n;
    if (l.cte === 'base64') n = Math.floor(b64Count(l.body) * 3 / 4);
    else if (l.cte === 'quoted-printable') n = qpDecode(l.body).length;
    else n = l.body.length;
    return Math.max(0, Math.min(MIME_LIMITS.attachment_bytes, Math.floor(n) || 0));
  }
  function safeFileName(name, type) {
    let s = cleanLine(name || '', 2000).replace(/^.*[\/\\]/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!s) s = type === 'message/rfc822' ? 'message.eml' : 'attachment';
    return cpSlice(s, MIME_LIMITS.file_name);
  }
  const normNl = s => s.replace(/\r\n?/g, '\n');

  /* ---------------------------------------------------------------- parseMessage */
  function parseMessage(bytes, opts) {
    const o = opts || {};
    const maxBody = Number.isInteger(o.maxBody) && o.maxBody > 0 ? o.maxBody : MIME_LIMITS.maxBody;
    const ctx = {
      leaves: [], count: 0, truncated: false, isDsn: false,
      maxParts: Number.isInteger(o.maxParts) && o.maxParts > 0 ? o.maxParts : MIME_LIMITS.maxParts,
      maxDepth: Number.isInteger(o.maxDepth) && o.maxDepth > 0 ? o.maxDepth : MIME_LIMITS.maxDepth
    };
    const bin = bytesToBin(toBytes(bytes));
    const hb = splitHeadBody(bin);
    const fields = parseHeaderBlock(hb.head);
    const headers = fields.map(f => ({ name: f.name, value: decodeHeaderValue(f.raw) }));
    const rawHeaders = fields.map(f => ({ name: f.name, raw: rawHeaderText(f.raw) }));
    walk(bin, '', 0, ctx, { head: hb.head, body: hb.body, fields });

    const textLeaf = ctx.leaves.find(l => l.type === 'text/plain' && !isAttachmentLike(l)) || null;
    const htmlLeaf = ctx.leaves.find(l => l.type === 'text/html' && !isAttachmentLike(l)) || null;
    const html = htmlLeaf ? sanitizeText(leafText(htmlLeaf)) : null;
    const pre = 4 * maxBody;     // decoded text / html cut BEFORE any regex work (correctness review C1); capBody marks the cut
    let text = textLeaf ? sanitizeText(normNl(leafText(textLeaf).slice(0, pre))) : (html !== null ? sanitizeText(htmlToText(normNl(html.slice(0, pre)))) : '');
    text = capBody(text, maxBody);

    const attachments = ctx.leaves
      .filter(l => l !== textLeaf && l !== htmlLeaf && !(/^text\/(plain|html)$/.test(l.type) && !isAttachmentLike(l)))
      .map(l => {
        const cid = l.cid === null ? '' : cleanLine(l.cid, MIME_LIMITS.content_id);
        return {
          part: l.part, file_name: safeFileName(leafFileName(l), l.type), mime_type: cpSlice(l.type, MIME_LIMITS.mime_type),
          size_bytes: estimateSize(l), content_id: cid || null
        };
      });

    const out = {
      headers,
      header(name) { const n = String(name).toLowerCase(); const h = headers.find(x => x.name.toLowerCase() === n); return h ? h.value : null; },
      headerAll(name) { const n = String(name).toLowerCase(); return headers.filter(x => x.name.toLowerCase() === n).map(x => x.value); },
      rawHeader(name) { const n = String(name).toLowerCase(); const h = rawHeaders.find(x => x.name.toLowerCase() === n); return h ? h.raw : null; },
      rawHeaderAll(name) { const n = String(name).toLowerCase(); return rawHeaders.filter(x => x.name.toLowerCase() === n).map(x => x.raw); },
      text, html, htmlOnly: !textLeaf && htmlLeaf !== null, attachments, isDsn: ctx.isDsn
    };
    Object.defineProperty(out, 'parts', { enumerable: false, value: ctx.leaves });
    Object.defineProperty(out, 'rawHeaders', { enumerable: false, value: rawHeaders });
    Object.defineProperty(out, 'truncated', { enumerable: false, value: ctx.truncated });
    return out;
  }

  /* ---------------------------------------------------------------- Authentication-Results (RFC 8601, design § 4) */
  // {spf, dkim, dmarc} plus two NON-enumerable properties (JSON keeps the three keys): dmarc_header_from (the header.from
  // the first dmarc result is about, lowercased, or null) and dkim_pass_domains (header.d / header.i domains of dkim=pass)
  function authOut(spf, dkim, dmarc, headerFrom, dkimDomains) {
    const o = { spf, dkim, dmarc };
    Object.defineProperty(o, 'dmarc_header_from', { enumerable: false, value: headerFrom || null });
    Object.defineProperty(o, 'dkim_pass_domains', { enumerable: false, value: Object.freeze((dkimDomains || []).slice()) });
    return o;
  }
  const NONE_AUTH = () => authOut('none', 'none', 'none', null, []);
  const propDomain = (seg, re) => { const m = re.exec(seg); return m ? m[1].replace(/^.*@/, '').replace(/\.$/, '').toLowerCase() : null; };
  function parseAuthResults(parsed, authservId) {
    const id = String(authservId || '').trim().toLowerCase();
    if (!id) return NONE_AUTH();
    // the RAW header values when parseMessage produced them: an RFC 2047 word is never decoded here (security review H5)
    const headers = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.rawHeaders) ? parsed.rawHeaders : (parsed && Array.isArray(parsed.headers) ? parsed.headers : []));
    const isName = n => h => h && String(h.name).toLowerCase() === n;
    const at = headers.findIndex(isName('authentication-results'));   // ONLY the topmost one
    if (at < 0) return NONE_AUTH();
    // trusted only when our MTA added it on this hop: above every Received header (security review H5; no Received at all
    // = never crossed SMTP, i.e. APPENDed by a mailbox login)
    const rcv = headers.findIndex(isName('received'));
    if (rcv >= 0 && rcv < at) return NONE_AUTH();
    const top = headers[at];
    const segs = splitSemi(stripComments(String((top.raw !== undefined ? top.raw : top.value) || '')));
    const serv = (segs[0] || '').trim().split(/\s+/)[0].toLowerCase();
    if (serv !== id) return NONE_AUTH();
    const res = { spf: [], dkim: [], dmarc: [] };
    let headerFrom, dmarcSeen = false;
    const dkimDomains = [];
    for (const seg of segs.slice(1)) {
      const m = /^\s*([a-z0-9_-]+)\s*=\s*([a-z]+)/i.exec(seg);
      if (!m || !res[m[1].toLowerCase()]) continue;
      const method = m[1].toLowerCase(), result = m[2].toLowerCase();
      res[method].push(result);
      if (method === 'dmarc' && !dmarcSeen) { dmarcSeen = true; headerFrom = propDomain(seg, /\bheader\.from\s*=\s*([^\s;]+)/i); }
      if (method === 'dkim' && result === 'pass') {
        const d = propDomain(seg, /\bheader\.d\s*=\s*([^\s;]+)/i) || propDomain(seg, /\bheader\.i\s*=\s*([^\s;]+)/i);
        if (d && !dkimDomains.includes(d)) dkimDomains.push(d);
      }
    }
    const pf = v => (v === 'pass' || v === 'fail' ? v : 'none');
    return authOut(pf(res.spf[0]), res.dkim.includes('pass') ? 'pass' : (res.dkim.includes('fail') ? 'fail' : 'none'), pf(res.dmarc[0]), headerFrom, dkimDomains);
  }

  /* ---------------------------------------------------------------- DSN (RFC 3464) */
  function dsnGroups(text) {
    return normNl(text).split(/\n[ \t]*\n/).map(g => {
      const f = {};
      for (const x of parseHeaderBlock(g)) { const k = x.name.toLowerCase(); if (!(k in f)) f[k] = cleanLine(x.raw, 1000); }
      return f;
    }).filter(f => Object.keys(f).length);
  }
  const xtextDecode = s => s.replace(/\+([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  function parseDsn(parsed) {
    const leaves = (parsed && parsed.parts) || [];
    const st = leaves.find(l => l.type === 'message/delivery-status' || l.type === 'message/global-delivery-status');
    if (!st) return null;
    const groups = dsnGroups(decodeCharset(decodeCte(st.body, st.cte), 'utf-8'));
    let envelope_id = null;
    const recipients = [];
    for (const g of groups) {
      const rcpt = g['final-recipient'] || g['original-recipient'];
      if (rcpt) {
        if (recipients.length >= MIME_LIMITS.dsn_recipients) continue;
        const addr = rcpt.indexOf(';') >= 0 ? rcpt.slice(rcpt.indexOf(';') + 1) : rcpt;
        const sm = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(g.status || '');
        recipients.push({
          final_recipient: cpSlice(addr.trim().replace(/^<|>$/g, '').trim().toLowerCase(), 254) || null,
          action: g.action ? g.action.trim().split(/\s+/)[0].toLowerCase().slice(0, 20) : null,
          status: sm ? sm[1] + '.' + sm[2] + '.' + sm[3] : null
        });
      } else if (envelope_id === null && g['original-envelope-id']) {
        envelope_id = cleanLine(xtextDecode(g['original-envelope-id']), MIME_LIMITS.envelope_id) || null;
      }
    }
    let original_message_id = null;
    const orig = leaves.find(l => /^(text\/rfc822-headers|message\/rfc822|message\/global-headers|message\/global)$/.test(l.type));
    if (orig) {
      const fields = parseHeaderBlock(splitHeadBody(decodeCte(orig.body, orig.cte)).head);
      const mid = firstRaw(fields, 'message-id');
      const v = mid === null ? '' : mid.trim();
      original_message_id = isMsgId(v) ? v : null;
    }
    return { envelope_id, original_message_id, recipients };
  }

  /* ---------------------------------------------------------------- dates */
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const ZONES = { ut: 0, utc: 0, gmt: 0, z: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420 };
  function zoneMinutes(z) {
    if (!z) return 0;
    const m = /^([+-])(\d{2})(\d{2})$/.exec(z);
    if (m) { const h = +m[2], mi = +m[3]; if (h > 23 || mi > 59) return null; return (m[1] === '-' ? -1 : 1) * (h * 60 + mi); }
    const k = z.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ZONES, k) ? ZONES[k] : 0;   // military / unknown alpha zone → -0000 (RFC 5322 § 4.3)
  }
  function mkDate(y, mon, d, h, mi, s, zone) {
    const off = zoneMinutes(zone);
    if (off === null || mon < 0 || y < 1900 || y > 9999 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
    const t = Date.UTC(y, mon, d, h, mi, Math.min(s, 59));
    const chk = new Date(Date.UTC(y, mon, d));
    if (chk.getUTCDate() !== d || chk.getUTCMonth() !== mon) return null;
    const r = new Date(t - off * 60000);
    return Number.isNaN(r.getTime()) ? null : r.toISOString();
  }
  // RFC 5322 date, IMAP INTERNALDATE, asctime or ISO 8601 → ISO string; anything else → null
  function parseDate(str) {
    if (str instanceof Date) return Number.isNaN(str.getTime()) ? null : str.toISOString();
    if (typeof str !== 'string') return null;
    const s = stripComments(str).replace(/\s+/g, ' ').trim();
    if (!s || s.length > 200) return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.exec(s);
    if (m) return mkDate(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), m[7].toUpperCase() === 'Z' ? 'Z' : m[7].replace(':', ''));
    m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(s);                 // INTERNALDATE
    if (m) return mkDate(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1], +m[4], +m[5], +m[6], m[7]);
    m = /^(?:[A-Za-z]{2,},? ?)?(\d{1,2}) ([A-Za-z]{3,})\.? (\d{2,4}) (\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)? ?([+-]\d{4}|[A-Za-z]{1,5})?$/.exec(s);
    if (m) {
      let y = +m[3];
      if (m[3].length === 2) y += y < 50 ? 2000 : 1900; else if (m[3].length === 3) y += 1900;
      return mkDate(y, MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1], +m[4], +m[5], +(m[6] || 0), m[7] || '');
    }
    m = /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(s);                    // asctime (UTC)
    if (m) return mkDate(+m[6], MONTHS.indexOf(m[1].toLowerCase()), +m[2], +m[3], +m[4], +m[5], '');
    return null;
  }
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const p2 = n => String(n).padStart(2, '0');
  function rfc5322Date(d) {
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return DAYS[d.getUTCDay()] + ', ' + p2(d.getUTCDate()) + ' ' + M[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' +
      p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + ' +0000';
  }

  /* ---------------------------------------------------------------- msg-ids */
  const MSGID_RE = /^<[^\s<>()\x00-\x1f]{1,250}>$/;
  const isMsgId = s => typeof s === 'string' && MSGID_RE.test(s);

  /* ---------------------------------------------------------------- buildMessage */
  const ADDR_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
  const OUT_MSGID_RE = /^<MRSO-[0-9A-F]{16}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,250}[A-Za-z0-9])?>$/;
  function noBreaks(v) {   // header input: CR / LF / NUL are refused, never cleaned
    if (v !== null && v !== undefined && /[\r\n\u0000]/.test(String(v))) throw new MimeError('header_injection', 'header input contains a line break');
  }
  function checkAddr(a) {
    noBreaks(a);
    const s = typeof a === 'string' ? a.trim() : '';
    if (/[^\x00-\x7f]/.test(s)) throw new MimeError('non_ascii_address', 'non-ASCII address (no SMTPUTF8)');
    if (s.length > 254 || !ADDR_RE.test(s)) throw new MimeError('bad_address', 'invalid address');
    return s;
  }
  // RFC 2047 B words of <= 45 UTF-8 bytes (→ 72 chars <= 75), split on code points so no UTF-8 sequence is cut (review L4)
  function encodeWords(s) {
    const words = [];
    let cur = [];
    for (const ch of s) {
      const b = utf8Encode(ch);
      if (cur.length + b.length > 45) { words.push(cur); cur = []; }
      for (const x of b) cur.push(x);
    }
    if (cur.length || !words.length) words.push(cur);
    return words.map(w => '=?UTF-8?B?' + base64Encode(Uint8Array.from(w)) + '?=');
  }
  const isPlainAscii = s => /^[\x20-\x7e]*$/.test(s) && s.indexOf('=?') < 0;
  // unstructured text after "Name: " → folded value; plain ASCII is folded at spaces, everything else becomes B words
  function unstructured(prefixLen, s) {
    if (s === '') return '';
    if (isPlainAscii(s) && !/^ | $|  /.test(s)) {
      const words = s.split(' ');
      if (words.every(w => w.length + 1 <= 998 - prefixLen)) {
        const lines = [];
        let line = words[0], len = prefixLen + words[0].length;
        for (const w of words.slice(1)) {
          if (len + 1 + w.length > 78) { lines.push(line); line = w; len = 1 + w.length; }
          else { line += ' ' + w; len += 1 + w.length; }
        }
        lines.push(line);
        return lines.join('\r\n ');
      }
    }
    return encodeWords(s).join('\r\n ');
  }
  function displayName(name) {
    const n = cleanLine(name, 160);
    if (!n) return '';
    if (isPlainAscii(n)) return '"' + n.replace(/[\\"]/g, '\\$&') + '"';
    return encodeWords(n).join('\r\n ');
  }
  function foldList(prefixLen, items, sep) {   // items joined by sep (', ' or ' '), folded before an item that would pass 78
    let out = '', len = prefixLen;
    items.forEach((it, i) => {
      if (i === 0) { out = it; len += it.length; return; }
      if (len + sep.length + it.length > 78) { out += sep.trimEnd() + '\r\n ' + it; len = 1 + it.length; }
      else { out += sep + it; len += sep.length + it.length; }
    });
    return out;
  }
  function buildMessage(req, cfg) {
    const r = req || {};
    const c = cfg || {};
    const list = v => (Array.isArray(v) ? v : (v === null || v === undefined || v === '' ? [] : [v]));
    // every header input is checked for CR / LF / NUL first
    [r.from, r.from_name, r.subject, r.in_reply_to, c.messageId, c.envelopeId].forEach(noBreaks);
    list(r.to).concat(list(r.cc)).forEach(noBreaks);
    (Array.isArray(r.references) ? r.references : list(r.references)).forEach(noBreaks);

    const from = checkAddr(r.from);
    const to = list(r.to).map(checkAddr);
    const cc = list(r.cc).map(checkAddr);
    if (!to.length) throw new MimeError('no_recipient', 'no recipient');
    if (to.length + cc.length > 100) throw new MimeError('too_many_recipients', 'too many recipients');
    if (!OUT_MSGID_RE.test(String(c.messageId || '')) || !isMsgId(c.messageId)) throw new MimeError('bad_message_id', 'invalid Message-ID');
    const d = c.date instanceof Date ? c.date : new Date(String(c.date || ''));
    if (Number.isNaN(d.getTime())) throw new MimeError('bad_date', 'invalid date');

    const H = [];
    const dn = displayName(r.from_name || '');
    H.push('From: ' + (dn ? dn + ' <' + from + '>' : from));
    H.push('To: ' + foldList(4, to, ', '));
    if (cc.length) H.push('Cc: ' + foldList(4, cc, ', '));
    H.push('Subject: ' + unstructured(9, sanitizeText(r.subject === null || r.subject === undefined ? '' : String(r.subject)).replace(/\t/g, ' ')));
    H.push('Date: ' + rfc5322Date(d));
    H.push('Message-ID: ' + c.messageId);
    const irt = typeof r.in_reply_to === 'string' ? r.in_reply_to.trim() : '';
    if (isMsgId(irt)) H.push('In-Reply-To: ' + irt);
    let refs = (Array.isArray(r.references) ? r.references : (typeof r.references === 'string' ? r.references.split(/\s+/) : []))
      .map(x => (typeof x === 'string' ? x.trim() : '')).filter(isMsgId);
    if (refs.length > MIME_LIMITS.references) refs = [refs[0]].concat(refs.slice(refs.length - (MIME_LIMITS.references - 1)));   // keep root + newest
    if (refs.length) H.push('References: ' + foldList(12, refs, ' '));
    H.push('MIME-Version: 1.0');
    H.push('Content-Type: text/plain; charset=utf-8');
    H.push('Content-Transfer-Encoding: base64');
    H.push('Auto-Submitted: no');

    const body = sanitizeText(r.body_text === null || r.body_text === undefined ? '' : String(r.body_text)).replace(/\r\n?|\n/g, '\r\n');
    const b64 = base64Encode(utf8Encode(body));
    const lines = [];
    for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
    const msg = H.join('\r\n') + '\r\n\r\n' + (lines.length ? lines.join('\r\n') + '\r\n' : '');
    if (msg.split('\r\n').some(l => l.length > 998) || /[^\x00-\x7f]/.test(msg)) throw new MimeError('line_too_long', 'header line too long');
    return binToBytes(msg);
  }

  const API = {
    MIME_LIMITS, MimeError,
    parseMessage, parseAuthResults, parseDsn, parseDate, isMsgId, sanitizeText, buildMessage,
    mimeHtmlToText: htmlToText, decodeHeaderValue, decodeEncodedWords, rawHeaderText, decodeCharset, base64Encode, base64Decode
  };
  (typeof module === 'object' && module.exports) ? (module.exports = API) : (globalThis.MarsaInbox = Object.assign(globalThis.MarsaInbox || {}, API));
})();
