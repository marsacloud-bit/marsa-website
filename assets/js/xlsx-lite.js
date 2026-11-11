/* =====================================================================
   مرسى | MARSA — XlsxLite (assets/js/xlsx-lite.js)
   Tiny, dependency-free spreadsheet I/O for the bulk-upload page.
   Works offline, from file:// and http://, no build step.

   Public API: window.XlsxLite = {
     canRead()                    → boolean (DecompressionStream available)
     sniff(arrayBuffer)           → 'xlsx' | 'xls' | 'html' | 'utf16' | 'text'
     read(arrayBuffer[, limits])  → Promise<{ sheets: [{ name, rows: string[][] }] }>
                                    limits = { maxInflateBytes (whole workbook, default 256 MB), maxRows (default
                                    1 048 576), maxCols (default 2048) } — a zip bomb / a far cell reference stops
                                    with XlsxError 'too_big' / 'too_many_rows' / 'too_wide' before it fills memory
     write(sheets[, opts])        → Blob (.xlsx; sheets = [{ name, rows }])
     writeBytes(sheets[, opts])   → Uint8Array (same bytes as write)
     decodeText(arrayBuffer)      → string (UTF-8 ± BOM, UTF-16 LE/BE BOM, windows-1256 fallback)
     parseDelimited(text[, delim])→ { rows: string[][], delimiter }
     toCSV(rows[, delim])         → string (RFC 4180; prepend "﻿" yourself for Excel)
   }
   Reader notes
   - ZIP central directory parsed with DataView; method 0 (stored) or 8
     (deflate) via DecompressionStream('deflate-raw').
   - Uses DOMParser for XML in browsers; a small built-in XML tokenizer is
     used where DOMParser does not exist (e.g. Node tests).
   - rows[i] is Excel row i+1 (gaps are kept as empty rows); trailing empty
     cells/rows are trimmed. Date-formatted serials → "YYYY-MM-DD".
   ===================================================================== */
(function (root) {
  'use strict';

  var utf8dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  var utf8enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function XlsxError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /* ------------------------------------------------------------------
     Format sniffing
     ------------------------------------------------------------------ */
  function sniff(buf) {
    var b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 512));
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return 'xlsx';
    if (b.length >= 8 && b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0 && b[4] === 0xA1 && b[5] === 0xB1 && b[6] === 0x1A && b[7] === 0xE1) return 'xls';
    if (b.length >= 2 && ((b[0] === 0xFF && b[1] === 0xFE) || (b[0] === 0xFE && b[1] === 0xFF))) return 'utf16';
    var head = '';
    for (var i = 0; i < b.length && head.length < 300; i++) if (b[i] > 0x20 || head) head += String.fromCharCode(b[i]);
    if (/^(﻿|ï»¿)?\s*<(!doctype html|html|table|\?xml[^>]*>\s*<html)/i.test(head) || /<table[\s>]/i.test(head)) return 'html';
    return 'text';
  }

  /* ------------------------------------------------------------------
     Text decoding (CSV / TSV / TXT / JSON)
     ------------------------------------------------------------------ */
  function decodeText(buf) {
    var b = new Uint8Array(buf);
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
    var text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch (e) {
      // Not valid UTF-8: Excel on Arabic Windows saves "CSV" as windows-1256.
      try { text = new TextDecoder('windows-1256').decode(b); }
      catch (e2) { text = new TextDecoder('utf-8').decode(b); }
    }
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  }

  /* ------------------------------------------------------------------
     Delimited text (CSV / TSV / semicolon) — RFC 4180 with quotes
     ------------------------------------------------------------------ */
  function detectDelimiter(text) {
    var cands = [',', ';', '\t', '|'];
    var lines = [];
    var cur = '', inQ = false;
    for (var i = 0; i < text.length && lines.length < 12; i++) {
      var ch = text[i];
      if (ch === '"') inQ = !inQ;
      if (!inQ && (ch === '\n' || ch === '\r')) {
        if (cur.trim()) lines.push(cur);
        cur = '';
        continue;
      }
      if (!inQ || ch !== '"') cur += inQ ? '' : ch; // count delimiters outside quotes only
    }
    if (cur.trim()) lines.push(cur);
    var best = ',', bestScore = -1;
    cands.forEach(function (d) {
      var counts = lines.map(function (l) { return l.split(d).length - 1; });
      if (!counts.length || counts[0] === 0) return;
      var consistent = counts.filter(function (c) { return c === counts[0]; }).length;
      var score = consistent * 100 + counts[0];
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  function parseDelimited(text, delim) {
    text = String(text || '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // Excel "sep=;" hint line
    var m = /^sep=(.)\r?\n/i.exec(text);
    if (m) { delim = delim || m[1]; text = text.slice(m[0].length); }
    delim = delim || detectDelimiter(text);
    var rows = [], row = [], field = '', inQ = false, i = 0, n = text.length;
    while (i < n) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"' && field === '') { inQ = true; i++; continue; }
      if (ch === delim) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return { rows: trimRows(rows), delimiter: delim };
  }

  function toCSV(rows, delim) {
    delim = delim || ',';
    return (rows || []).map(function (r) {
      return (r || []).map(function (v) {
        var s = v == null ? '' : String(v);
        return /["\r\n]/.test(s) || s.indexOf(delim) !== -1 || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(delim);
    }).join('\r\n');
  }

  function trimRows(rows) {
    rows = rows.map(function (r) {
      var k = r.length;
      while (k > 0 && (r[k - 1] == null || String(r[k - 1]).trim() === '')) k--;
      return r.slice(0, k).map(function (v) { return v == null ? '' : String(v); });
    });
    var end = rows.length;
    while (end > 0 && rows[end - 1].length === 0) end--;
    return rows.slice(0, end);
  }

  /* ------------------------------------------------------------------
     Minimal XML → tree  { n: localName, a: {attrs}, c: [children], t: text }
     ------------------------------------------------------------------ */
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, e) {
      if (e[0] === '#') {
        var cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isNaN(cp) ? all : String.fromCodePoint(cp);
      }
      return ENT[e] != null ? ENT[e] : all;
    });
  }
  function localName(q) { var i = q.indexOf(':'); return i === -1 ? q : q.slice(i + 1); }

  function parseXmlFallback(xml) {
    var rootNode = { n: '#root', a: {}, c: [], t: '' };
    var stack = [rootNode];
    var re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    var attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var m;
    while ((m = re.exec(xml))) {
      var top = stack[stack.length - 1];
      if (m[1] != null) { top.c.push({ n: '#text', t: m[1] }); }
      else if (m[2] != null) { if (stack.length > 1) stack.pop(); }
      else if (m[3] != null) {
        var node = { n: localName(m[3]), a: {}, c: [] };
        var am; attrRe.lastIndex = 0;
        while ((am = attrRe.exec(m[4] || ''))) node.a[am[1]] = decodeEntities(am[2] != null ? am[2] : am[3]);
        top.c.push(node);
        if (!m[5]) stack.push(node);
      } else if (m[6] != null) {
        top.c.push({ n: '#text', t: decodeEntities(m[6]) });
      }
    }
    return rootNode;
  }

  function domToTree(el) {
    var node = { n: el.localName || el.nodeName, a: {}, c: [] };
    if (el.attributes) for (var i = 0; i < el.attributes.length; i++) node.a[el.attributes[i].name] = el.attributes[i].value;
    for (var ch = el.firstChild; ch; ch = ch.nextSibling) {
      if (ch.nodeType === 1) node.c.push(domToTree(ch));
      else if (ch.nodeType === 3 || ch.nodeType === 4) node.c.push({ n: '#text', t: ch.nodeValue });
    }
    return node;
  }

  function parseXml(xml) {
    if (typeof DOMParser !== 'undefined') {
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      var err = doc.getElementsByTagName('parsererror');
      if (!err.length && doc.documentElement) return { n: '#root', a: {}, c: [domToTree(doc.documentElement)] };
    }
    return parseXmlFallback(xml);
  }

  function kids(node, name) { return node && node.c ? node.c.filter(function (x) { return x.n === name; }) : []; }
  function kid(node, name) { return kids(node, name)[0] || null; }
  function findAll(node, name, out) {
    out = out || [];
    if (!node || !node.c) return out;
    for (var i = 0; i < node.c.length; i++) {
      var ch = node.c[i];
      if (ch.n === name) out.push(ch);
      if (ch.c) findAll(ch, name, out);
    }
    return out;
  }
  function find(node, name) { return findAll(node, name)[0] || null; }
  function textOf(node, skip) {
    if (!node) return '';
    if (node.n === '#text') return node.t;
    var s = '';
    for (var i = 0; i < (node.c || []).length; i++) {
      var ch = node.c[i];
      if (skip && skip.indexOf(ch.n) !== -1) continue;
      s += textOf(ch, skip);
    }
    return s;
  }
  /* text of a shared/inline string: only <t> runs count (whitespace between
     <r> elements in pretty-printed files and phonetic <rPh> runs are ignored) */
  function runText(node) {
    if (!node || !node.c) return '';
    var s = '';
    for (var i = 0; i < node.c.length; i++) {
      var ch = node.c[i];
      if (ch.n === 't') s += textOf(ch);
      else if (ch.n !== '#text' && ch.n !== 'rPh' && ch.n !== 'phoneticPr' && ch.n !== 'rPr') s += runText(ch);
    }
    return s;
  }
  function attr(node, name) {
    if (!node) return null;
    if (node.a[name] != null) return node.a[name];
    for (var k in node.a) if (localName(k) === name) return node.a[k];
    return null;
  }

  /* ------------------------------------------------------------------
     ZIP reader
     ------------------------------------------------------------------ */
  function readZipDirectory(buf) {
    var dv = new DataView(buf);
    var len = buf.byteLength;
    var eocd = -1;
    for (var i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw XlsxError('zip', 'الملف ليس ملف Excel صالحًا (تعذّر قراءة بنية الملف).');
    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);
    if (cdOffset === 0xFFFFFFFF || count === 0xFFFF) throw XlsxError('zip64', 'حجم الملف كبير جدًا للقراءة داخل المتصفح. احفظه بصيغة CSV.');
    var entries = {};
    var p = cdOffset;
    for (var e = 0; e < count; e++) {
      if (p + 46 > len || dv.getUint32(p, true) !== 0x02014b50) break;
      var flags = dv.getUint16(p + 8, true);
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var usize = dv.getUint32(p + 24, true);
      var nlen = dv.getUint16(p + 28, true);
      var xlen = dv.getUint16(p + 30, true);
      var clen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var nameBytes = new Uint8Array(buf, p + 46, nlen);
      var name = utf8dec.decode(nameBytes); // flag 0x800 = UTF-8; ASCII names decode identically
      entries[name.replace(/^\/+/, '')] = { method: method, csize: csize, usize: usize, offset: lho };
      p += 46 + nlen + xlen + clen;
    }
    return entries;
  }

  function entryData(buf, ent) {
    var dv = new DataView(buf);
    var o = ent.offset;
    if (dv.getUint32(o, true) !== 0x04034b50) throw XlsxError('zip', 'الملف تالف أو غير مكتمل.');
    var nlen = dv.getUint16(o + 26, true);
    var xlen = dv.getUint16(o + 28, true);
    var start = o + 30 + nlen + xlen;
    return new Uint8Array(buf, start, ent.csize);
  }

  var DEFAULT_LIMITS = { maxInflateBytes: 256 * 1024 * 1024, maxRows: 1048576, maxCols: 2048 };
  function tooBig() { return XlsxError('too_big', 'حجم محتوى الملف بعد فك الضغط أكبر من المسموح.'); }
  // budget = { left: bytes } shared by every entry of one workbook; the stream is cancelled as soon as it runs out
  function inflate(bytes, budget) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(XlsxError('nodecompress', 'متصفحك لا يدعم قراءة ملفات Excel مباشرة. حدّث المتصفح أو احفظ الملف بصيغة CSV ثم ارفعه.'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    if (!budget || typeof stream.getReader !== 'function') {
      return new Response(stream).arrayBuffer().then(function (ab) {
        if (budget) { budget.left -= ab.byteLength; if (budget.left < 0) throw tooBig(); }
        return new Uint8Array(ab);
      });
    }
    var reader = stream.getReader(), parts = [], total = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          var out = new Uint8Array(total), o = 0;
          parts.forEach(function (p) { out.set(p, o); o += p.length; });
          return out;
        }
        var chunk = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
        total += chunk.length; budget.left -= chunk.length;
        if (budget.left < 0) { try { reader.cancel(); } catch (e) { /* already closed */ } throw tooBig(); }
        parts.push(chunk);
        return pump();
      });
    }
    return pump();
  }

  function makeZip(buf, budget) {
    var entries = readZipDirectory(buf);
    var lower = {};
    Object.keys(entries).forEach(function (k) { lower[k.toLowerCase()] = k; });
    function has(path) { return !!(entries[path] || lower[path.toLowerCase()]); }
    function bytes(path) {
      var ent = entries[path] || entries[lower[path.toLowerCase()]];
      if (!ent) return Promise.resolve(null);
      var raw = entryData(buf, ent);
      if (ent.method === 0) {
        if (budget) { budget.left -= raw.length; if (budget.left < 0) return Promise.reject(tooBig()); }
        return Promise.resolve(raw);
      }
      if (ent.method === 8) return inflate(raw, budget);
      return Promise.reject(XlsxError('method', 'طريقة ضغط غير مدعومة داخل الملف. احفظه من Excel مرة أخرى أو بصيغة CSV.'));
    }
    function text(path) {
      return bytes(path).then(function (b) { return b ? utf8dec.decode(b) : null; });
    }
    return { has: has, text: text, names: Object.keys(entries) };
  }

  /* ------------------------------------------------------------------
     Helpers for worksheet parsing
     ------------------------------------------------------------------ */
  function colIndex(ref) {
    var m = /^\$?([A-Z]+)/i.exec(ref || '');
    if (!m) return -1;
    var s = m[1].toUpperCase(), n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }
  function rowIndex(ref) {
    var m = /(\d+)$/.exec(ref || '');
    return m ? parseInt(m[1], 10) - 1 : -1;
  }
  function colName(i) {
    var s = '';
    i += 1;
    while (i > 0) { var r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  function resolvePath(base, target) {
    if (!target) return '';
    if (target[0] === '/') return target.slice(1);
    var parts = base.split('/');
    parts.pop();
    target.split('/').forEach(function (seg) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    });
    return parts.join('/');
  }
  function relsPath(path) {
    var i = path.lastIndexOf('/');
    return (i === -1 ? '' : path.slice(0, i + 1)) + '_rels/' + path.slice(i + 1) + '.rels';
  }
  function parseRels(xml, basePath) {
    var out = [];
    if (!xml) return out;
    findAll(parseXml(xml), 'Relationship').forEach(function (r) {
      out.push({ id: attr(r, 'Id'), type: attr(r, 'Type') || '', target: resolvePath(basePath, attr(r, 'Target') || ''), external: attr(r, 'TargetMode') === 'External' });
    });
    return out;
  }
  function cleanNumber(v) {
    var n = Number(v);
    if (!isFinite(n)) return v;
    var s = String(parseFloat(n.toPrecision(15)));
    if (/e/i.test(s) && Math.abs(n) < 1e21 && Math.abs(n) >= 1e-6) s = n.toFixed(Math.max(0, 15 - Math.floor(Math.log10(Math.abs(n))) - 1)).replace(/\.?0+$/, '');
    return s;
  }

  var DATE_IDS = { 14: 'd', 15: 'd', 16: 'd', 17: 'd', 18: 't', 19: 't', 20: 't', 21: 't', 22: 'dt', 27: 'd', 28: 'd', 29: 'd', 30: 'd', 31: 'd', 32: 't', 33: 't', 34: 't', 35: 't', 36: 'd', 45: 't', 46: 't', 47: 't', 50: 'd', 51: 'd', 52: 'd', 53: 'd', 54: 'd', 55: 'd', 56: 'd', 57: 'd', 58: 'd' };
  function classifyFormat(code) {
    var s = String(code || '').replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '').toLowerCase();
    if (!s || /general/.test(s)) return '';
    var hasTime = /[hs]/.test(s);
    var hasDate = /[dy]/.test(s) || (/m/.test(s) && !hasTime);
    if (hasDate && hasTime) return 'dt';
    if (hasDate) return 'd';
    if (hasTime) return 't';
    return '';
  }
  function parseStyles(xml) {
    var kinds = [];
    if (!xml) return kinds;
    var tree = parseXml(xml);
    var custom = {};
    findAll(tree, 'numFmt').forEach(function (f) { custom[attr(f, 'numFmtId')] = attr(f, 'formatCode'); });
    var cellXfs = find(tree, 'cellXfs');
    kids(cellXfs, 'xf').forEach(function (xf, i) {
      var id = parseInt(attr(xf, 'numFmtId') || '0', 10);
      kinds[i] = custom[id] != null ? classifyFormat(custom[id]) : (DATE_IDS[id] || '');
    });
    return kinds;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function serialToDate(serial, kind, date1904) {
    var v = parseFloat(serial);
    if (!isFinite(v)) return serial;
    if (kind === 't' && v < 1) {
      var secs = Math.round(v * 86400);
      return pad(Math.floor(secs / 3600) % 24) + ':' + pad(Math.floor(secs / 60) % 60);
    }
    if (v < 1 || v > 2958465) return cleanNumber(serial);
    if (date1904) v += 1462;
    var ms = Math.round((v - 25569) * 86400000);
    var d = new Date(ms);
    var out = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    if ((kind === 'dt' || kind === 't') && (d.getUTCHours() || d.getUTCMinutes())) out += ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    return out;
  }

  function parseSheet(xml, shared, styleKinds, date1904, lim) {
    lim = lim || DEFAULT_LIMITS;
    var tree = parseXml(xml);
    var data = find(tree, 'sheetData');
    var rows = [];
    var nextRow = 0;
    kids(data, 'row').forEach(function (rowNode) {
      var rAttr = attr(rowNode, 'r');
      var ri = rAttr ? parseInt(rAttr, 10) - 1 : nextRow;
      if (!(ri >= 0)) ri = nextRow;
      if (ri >= lim.maxRows) throw XlsxError('too_many_rows', 'عدد صفوف الورقة أكبر من المسموح.');
      nextRow = ri + 1;
      var row = rows[ri] || (rows[ri] = []);
      var nextCol = 0;
      kids(rowNode, 'c').forEach(function (c) {
        var ref = attr(c, 'r');
        var ci = ref ? colIndex(ref) : nextCol;
        if (ci < 0) ci = nextCol;
        if (ci >= lim.maxCols) throw XlsxError('too_wide', 'عدد أعمدة الورقة أكبر من المسموح.');
        nextCol = ci + 1;
        var t = attr(c, 't') || 'n';
        var vNode = kid(c, 'v');
        var v = vNode ? textOf(vNode) : '';
        var out;
        if (t === 's') out = shared[parseInt(v, 10)] != null ? shared[parseInt(v, 10)] : '';
        else if (t === 'inlineStr') out = runText(kid(c, 'is'));
        else if (t === 'str' || t === 'e') out = v;
        else if (t === 'b') out = v === '1' ? 'TRUE' : (v === '0' ? 'FALSE' : v);
        else if (t === 'd') out = v.slice(0, 10);
        else {
          if (v === '') out = '';
          else {
            var kind = styleKinds[parseInt(attr(c, 's') || '0', 10)] || '';
            out = kind ? serialToDate(v, kind, date1904) : cleanNumber(v);
          }
        }
        row[ci] = out;
      });
    });
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i]) rows[i] = [];
      for (var j = 0; j < rows[i].length; j++) if (rows[i][j] == null) rows[i][j] = '';
    }
    return trimRows(rows);
  }

  /* ------------------------------------------------------------------
     read(arrayBuffer)
     ------------------------------------------------------------------ */
  function read(buf, limits) {
    var lim = {};
    Object.keys(DEFAULT_LIMITS).forEach(function (k) { var v = limits && +limits[k]; lim[k] = v > 0 && v < DEFAULT_LIMITS[k] ? Math.floor(v) : DEFAULT_LIMITS[k]; });
    var budget = { left: lim.maxInflateBytes };
    return Promise.resolve().then(function () {
      if (buf && buf.buffer && !(buf instanceof ArrayBuffer)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      var kind = sniff(buf);
      if (kind === 'xls') throw XlsxError('xls', 'صيغة ‎.xls‎ القديمة غير مدعومة. افتح الملف في Excel واختر «حفظ باسم» بصيغة ‎.xlsx‎ أو CSV ثم ارفعه مرة أخرى.');
      if (kind !== 'xlsx') throw XlsxError('notzip', 'الملف ليس بصيغة Excel ‎(.xlsx)‎ صالحة.');
      var zip = makeZip(buf, budget);
      return zip.text('_rels/.rels').then(function (rootRels) {
        var wbPath = 'xl/workbook.xml';
        parseRels(rootRels, '').forEach(function (r) { if (/officeDocument$/.test(r.type)) wbPath = r.target; });
        if (!zip.has(wbPath)) {
          if (zip.names.some(function (n) { return /^content\.xml$/i.test(n); })) throw XlsxError('ods', 'ملفات ‎.ods‎ غير مدعومة. احفظ الملف بصيغة ‎.xlsx‎ أو CSV.');
          throw XlsxError('noworkbook', 'لم يُعثر على أوراق عمل داخل الملف.');
        }
        return Promise.all([zip.text(wbPath), zip.text(relsPath(wbPath))]).then(function (res) {
          var wbTree = parseXml(res[0] || '');
          var rels = parseRels(res[1], wbPath);
          var relById = {};
          rels.forEach(function (r) { relById[r.id] = r; });
          var pr = find(wbTree, 'workbookPr');
          var date1904 = pr && /^(1|true)$/i.test(attr(pr, 'date1904') || '');
          var ssPath = 'xl/sharedStrings.xml', stPath = 'xl/styles.xml';
          rels.forEach(function (r) {
            if (/\/sharedStrings$/.test(r.type)) ssPath = r.target;
            if (/\/styles$/.test(r.type)) stPath = r.target;
          });
          var sheetDefs = findAll(wbTree, 'sheet').map(function (s, i) {
            var rid = attr(s, 'id');
            var rel = rid && relById[rid];
            return { name: attr(s, 'name') || ('Sheet' + (i + 1)), path: rel ? rel.target : 'xl/worksheets/sheet' + (i + 1) + '.xml', hidden: /hidden/i.test(attr(s, 'state') || ''), chart: rel && /chartsheet/i.test(rel.type) };
          }).filter(function (s) { return !s.chart; });
          return Promise.all([zip.has(ssPath) ? zip.text(ssPath) : null, zip.has(stPath) ? zip.text(stPath) : null]).then(function (r2) {
            var shared = [];
            if (r2[0]) findAll(parseXml(r2[0]), 'si').forEach(function (si) { shared.push(runText(si)); });
            var styleKinds = parseStyles(r2[1]);
            // one sheet after another (each inflated + parsed before the next), all under the same budget
            var out = [];
            return sheetDefs.reduce(function (p, sd) {
              return p.then(function () {
                if (!zip.has(sd.path)) { out.push({ name: sd.name, hidden: sd.hidden, rows: [] }); return; }
                return zip.text(sd.path).then(function (x) { out.push({ name: sd.name, hidden: sd.hidden, rows: parseSheet(x, shared, styleKinds, date1904, lim) }); });
              });
            }, Promise.resolve()).then(function () { return out; });
          });
        });
      }).then(function (sheets) { return { sheets: sheets }; });
    });
  }

  /* ------------------------------------------------------------------
     Writer — STORED zip entries + CRC32
     ------------------------------------------------------------------ */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function encode(s) {
    if (utf8enc) return utf8enc.encode(s);
    var out = unescape(encodeURIComponent(s)), a = new Uint8Array(out.length);
    for (var i = 0; i < out.length; i++) a[i] = out.charCodeAt(i);
    return a;
  }
  function zipStore(files) {
    var now = new Date();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    var locals = [], centrals = [], offset = 0;
    files.forEach(function (f) {
      var name = encode(f.name), data = f.data, crc = crc32(data);
      var lh = new Uint8Array(30 + name.length), dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true); dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true); dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
      lh.set(name, 30);
      var ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      locals.push(lh, data);
      centrals.push(ch);
      offset += lh.length + data.length;
    });
    var cdSize = centrals.reduce(function (n, c) { return n + c.length; }, 0);
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    var parts = locals.concat(centrals, [end]);
    var total = parts.reduce(function (n, p) { return n + p.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function safeSheetNames(sheets) {
    var used = {};
    return sheets.map(function (s, i) {
      var base = String(s.name || ('Sheet' + (i + 1))).replace(/[\[\]:*?\/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || ('Sheet' + (i + 1));
      var name = base, k = 2;
      while (used[name.toLowerCase()]) { var suf = ' (' + k++ + ')'; name = base.slice(0, 31 - suf.length) + suf; }
      used[name.toLowerCase()] = true;
      return name;
    });
  }
  function textWidth(s) { return String(s == null ? '' : s).length; }

  function sheetXml(rows, opts) {
    var rtl = opts.rtl !== false;
    var header = opts.header !== false;
    var widths = [];
    rows.slice(0, 300).forEach(function (r) {
      (r || []).forEach(function (v, i) { widths[i] = Math.max(widths[i] || 6, Math.min(60, textWidth(v) + 3)); });
    });
    var x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetViews><sheetView workbookViewId="0"' + (rtl ? ' rightToLeft="1"' : '') + '>' +
      (header && rows.length > 1 ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '') +
      '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>';
    if (widths.length) {
      x += '<cols>' + widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (w || 10) + '" customWidth="1"/>'; }).join('') + '</cols>';
    }
    x += '<sheetData>';
    rows.forEach(function (r, ri) {
      x += '<row r="' + (ri + 1) + '">';
      (r || []).forEach(function (v, ci) {
        if (v == null || v === '') return;
        var ref = colName(ci) + (ri + 1);
        var style = header && ri === 0 ? ' s="1"' : '';
        if (typeof v === 'number' && isFinite(v)) x += '<c r="' + ref + '"' + style + '><v>' + v + '</v></c>';
        else if (typeof v === 'boolean') x += '<c r="' + ref + '"' + style + ' t="b"><v>' + (v ? 1 : 0) + '</v></c>';
        else x += '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
      });
      x += '</row>';
    });
    x += '</sheetData></worksheet>';
    return x;
  }

  var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF0B3A6E"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
    '</styleSheet>';

  function writeBytes(sheets, opts) {
    opts = opts || {};
    if (!Array.isArray(sheets) || !sheets.length) sheets = [{ name: 'Sheet1', rows: [] }];
    var names = safeSheetNames(sheets);
    var files = [];
    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      names.map(function (n, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
      '</Types>';
    files.push({ name: '[Content_Types].xml', data: encode(ct) });
    files.push({ name: '_rels/.rels', data: encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>') });
    var iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    files.push({ name: 'docProps/core.xml', data: encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + xmlEsc(opts.title || 'MARSA') + '</dc:title><dc:creator>MARSA</dc:creator>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:modified>' +
      '</cp:coreProperties>') });
    files.push({ name: 'docProps/app.xml', data: encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>MARSA XlsxLite</Application></Properties>') });
    files.push({ name: 'xl/workbook.xml', data: encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16000" windowHeight="9000"/></bookViews><sheets>' +
      names.map(function (n, i) { return '<sheet name="' + xmlEsc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
      '</sheets></workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      names.map(function (n, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (names.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>') });
    files.push({ name: 'xl/styles.xml', data: encode(STYLES_XML) });
    sheets.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: encode(sheetXml(s.rows || [], { rtl: s.rtl != null ? s.rtl : opts.rtl, header: s.header != null ? s.header : opts.header })) });
    });
    return zipStore(files);
  }

  function write(sheets, opts) {
    return new Blob([writeBytes(sheets, opts)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function canRead() { return typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined' && typeof Response !== 'undefined'; }

  var api = {
    canRead: canRead,
    sniff: sniff,
    read: read,
    write: write,
    writeBytes: writeBytes,
    decodeText: decodeText,
    parseDelimited: parseDelimited,
    toCSV: toCSV,
    _parseXml: parseXmlFallback,
    _crc32: crc32
  };
  root.XlsxLite = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
