/* ==========================================================================
   مرسى | MARSA — G6a report export: minimal .xlsx writer (window.MarsaXlsx)
   --------------------------------------------------------------------------
   Contract: docs/online/G6A_SPEC.md §5.3 item 6 (G6a-7). Plain JS, no library,
   no CDN; also usable from node (module.exports) for the unit tests.

     MarsaXlsx.build({ title, generatedAt?, sheets: [{ name, rtl: true,
         columns: [{ key, label, type: 'text'|'int'|'money'|'number'|'date'|'datetime', width? }],
         rows: [{ key: value }], totals: { key: value } | [{ key: value }] | null }],
       meta: [[label, value], …], metaName? }) → Uint8Array
     MarsaXlsx.blob(spec) → Blob (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)

   * OOXML parts: [Content_Types].xml, _rels/.rels, docProps/core.xml, docProps/app.xml,
     xl/workbook.xml, xl/_rels/workbook.xml.rels, xl/styles.xml, xl/worksheets/sheetN.xml.
   * ZIP: every entry STORED (method 0) with its CRC-32, UTF-8 names (flag bit 11).
   * Sheets: <sheetView rightToLeft="1"> (unless rtl === false), frozen header row, bold header,
     bold totals row(s) at the bottom. Numbers are <c><v> (no t): money #,##0.00, int #,##0,
     number General; date yyyy-mm-dd / datetime yyyy-mm-dd hh:mm are Excel serials in
     Asia/Riyadh wall time (UTC+3, no DST). Text is always t="inlineStr" — never a formula —
     with XML-invalid characters stripped. Sheet names ≤ 31 chars, []:*?/\ removed, unique.
   * The "meta" list becomes a last sheet (default name «معايير التقرير»): two text columns.
   ========================================================================== */
(function (root) {
  'use strict';

  var RIYADH_MS = 3 * 3600 * 1000;           // Asia/Riyadh is UTC+3 all year
  var EXCEL_EPOCH_DAYS = 25569;              // 1970-01-01 as an Excel (1900) serial
  var MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  /* --- UTF-8 + CRC-32 ---------------------------------------------------- */
  function utf8(s) {
    s = String(s);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { c = 0x10000 + ((c - 0xD800) << 10) + (s.charCodeAt(++i) - 0xDC00); }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256), c, n, k;
    for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* --- ZIP (stored) ------------------------------------------------------ */
  function dosTime(d) {
    return { time: ((d.getUTCHours() & 31) << 11) | ((d.getUTCMinutes() & 63) << 5) | ((d.getUTCSeconds() / 2) & 31),
      date: (((Math.max(1980, d.getUTCFullYear()) - 1980) & 127) << 9) | (((d.getUTCMonth() + 1) & 15) << 5) | (d.getUTCDate() & 31) };
  }
  function zip(files, when) {
    // files: [{ name, data: Uint8Array }] → Uint8Array
    var dt = dosTime(new Date(when.getTime() + RIYADH_MS));   // the ZIP stamp is local (Riyadh) time
    var locals = [], centrals = [], offset = 0, size = 0;
    files.forEach(function (f) {
      var name = utf8(f.name), data = f.data, crc = crc32(data);
      var lh = new Uint8Array(30 + name.length), v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
      v.setUint16(10, dt.time, true); v.setUint16(12, dt.date, true); v.setUint32(14, crc, true);
      v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
      lh.set(name, 30);
      var ch = new Uint8Array(46 + name.length), w = new DataView(ch.buffer);
      w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true); w.setUint16(10, 0, true);
      w.setUint16(12, dt.time, true); w.setUint16(14, dt.date, true); w.setUint32(16, crc, true);
      w.setUint32(20, data.length, true); w.setUint32(24, data.length, true); w.setUint16(28, name.length, true);
      w.setUint16(30, 0, true); w.setUint16(32, 0, true); w.setUint16(34, 0, true); w.setUint16(36, 0, true); w.setUint32(38, 0, true);
      w.setUint32(42, offset, true);
      ch.set(name, 46);
      locals.push(lh, data); centrals.push(ch);
      offset += lh.length + data.length;
    });
    var cdSize = centrals.reduce(function (n, c) { return n + c.length; }, 0);
    var end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(4, 0, true); e.setUint16(6, 0, true);
    e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true); e.setUint16(20, 0, true);
    var parts = locals.concat(centrals, [end]);
    size = parts.reduce(function (n, p) { return n + p.length; }, 0);
    var out = new Uint8Array(size), at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  /* --- XML helpers ------------------------------------------------------- */
  // XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
  function cleanText(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
  }
  function esc(s) {
    return cleanText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colName(i) {
    var s = ''; i += 1;
    while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  function sheetName(n, used) {
    var s = cleanText(n).replace(/[\[\]:*?\/\\]/g, '').replace(/^'+|'+$/g, '').trim() || 'Sheet';
    s = s.slice(0, 31);
    var base = s, k = 2;
    while (used[s.toLowerCase()]) { var suf = ' (' + k++ + ')'; s = base.slice(0, 31 - suf.length) + suf; }
    used[s.toLowerCase()] = true;
    return s;
  }

  /* --- values ------------------------------------------------------------ */
  var NUMERIC = { int: 1, money: 1, number: 1, date: 1, datetime: 1 };
  function num(v) {
    if (v == null || v === '' || typeof v === 'boolean') return null;
    var n = typeof v === 'number' ? v : Number(String(v).trim());
    return isFinite(n) ? n : null;
  }
  // 'YYYY-MM-DD' (a calendar day) or an ISO timestamp → Excel serial in Riyadh wall time
  function serial(v, withTime) {
    if (v == null || v === '') return null;
    var m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    var ms;
    if (m) ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    else {
      var d = v instanceof Date ? v : new Date(v);
      if (isNaN(d.getTime())) return null;
      ms = d.getTime() + RIYADH_MS;
      if (!withTime) { var x = new Date(ms); ms = Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()); }
      else ms = Math.round(ms / 60000) * 60000;   // minutes (the format shows hh:mm)
    }
    return ms / 86400000 + EXCEL_EPOCH_DAYS;
  }
  function numText(n) {
    // shortest round-trip text, never exponent for the ranges we write
    var s = String(n);
    if (/e/i.test(s)) s = n.toFixed(Math.abs(n) < 1 ? 15 : 2).replace(/\.?0+$/, '');
    return s;
  }
  // styles: 0 default · 1 header bold · 2 int · 3 money · 4 date · 5 datetime · 6 total text bold ·
  //         7 total int · 8 total money · 9 number · 10 total number · 11 total date · 12 total datetime ·
  //         13 / 14 text with the warning / danger fill (legacy step 8)
  var STYLE = { text: 0, int: 2, money: 3, date: 4, datetime: 5, number: 9 };
  var STYLE_TOTAL = { text: 6, int: 7, money: 8, date: 11, datetime: 12, number: 10 };
  // legacy step 8: a tone fill on a text cell (the follow-up export's attention colours): 13 warning · 14 danger
  var STYLE_TONE = { warning: 13, danger: 14 };
  // a multi-line text cell (container numbers one per line): 15 wrap · 16 warning + wrap · 17 danger + wrap
  var STYLE_WRAP = { 0: 15, 13: 16, 14: 17 };
  function cell(ref, type, v, bold, tone) {
    type = NUMERIC[type] ? type : 'text';
    var s = (bold ? STYLE_TOTAL : STYLE)[type];
    if (!bold && type === 'text' && STYLE_TONE[tone]) s = STYLE_TONE[tone];
    if (type !== 'text') {
      var n = type === 'date' ? serial(v, false) : type === 'datetime' ? serial(v, true) : num(v);
      if (type === 'money' && n != null) n = Math.round(n * 100) / 100;
      if (type === 'int' && n != null) n = Math.round(n);
      if (n != null) return '<c r="' + ref + '"' + (s ? ' s="' + s + '"' : '') + '><v>' + numText(n) + '</v></c>';
      if (v == null || v === '') return bold ? '<c r="' + ref + '" s="' + s + '"/>' : '';
      // not a number (e.g. "—"): keep it as text, never as a formula
    }
    var txt = v == null ? '' : String(v);
    if (txt === '') return bold ? '<c r="' + ref + '" s="' + STYLE_TOTAL.text + '"/>' : '';
    if (!bold && txt.indexOf('\n') >= 0 && STYLE_WRAP[s || 0]) s = STYLE_WRAP[s || 0];
    return '<c r="' + ref + '"' + (bold ? ' s="' + STYLE_TOTAL.text + '"' : s ? ' s="' + s + '"' : '') + ' t="inlineStr"><is><t xml:space="preserve">' + esc(txt) + '</t></is></c>';
  }
  function headerCell(ref, label) {
    return '<c r="' + ref + '" s="1" t="inlineStr"><is><t xml:space="preserve">' + esc(label) + '</t></is></c>';
  }

  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  var NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  function sheetXml(sh) {
    var cols = sh.columns || [], rows = sh.rows || [];
    var totals = sh.totals == null ? [] : Array.isArray(sh.totals) ? sh.totals : [sh.totals];
    var nCols = Math.max(1, cols.length), nRows = 1 + rows.length + totals.length;
    var out = [XML_HEAD, '<worksheet xmlns="', NS_MAIN, '" xmlns:r="', NS_R, '">',
      '<dimension ref="A1:', colName(nCols - 1), nRows, '"/>',
      '<sheetViews><sheetView', sh.rtl === false ? '' : ' rightToLeft="1"', ' workbookViewId="0">',
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>',
      '<sheetFormatPr defaultRowHeight="15"/>'];
    if (cols.length) {
      out.push('<cols>');
      cols.forEach(function (c, i) {
        var w = +c.width || (c.type === 'datetime' ? 18 : c.type === 'date' ? 12 : c.type === 'money' ? 15 : c.type === 'int' ? 10 : 22);
        out.push('<col min="', i + 1, '" max="', i + 1, '" width="', Math.max(4, Math.min(80, w)), '" customWidth="1"/>');
      });
      out.push('</cols>');
    }
    out.push('<sheetData>');
    out.push('<row r="1">');
    cols.forEach(function (c, i) { out.push(headerCell(colName(i) + 1, c.label == null ? c.key : c.label)); });
    out.push('</row>');
    function line(r, obj, bold) {
      out.push('<row r="', r, '">');
      cols.forEach(function (c, i) { out.push(cell(colName(i) + r, c.type, obj ? obj[c.key] : null, bold, obj ? obj[c.key + '__tone'] : null)); });
      out.push('</row>');
    }
    rows.forEach(function (row, i) { line(i + 2, row, false); });
    totals.forEach(function (tot, i) { line(rows.length + 2 + i, tot, true); });
    out.push('</sheetData>');
    out.push('<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>');
    out.push('<pageSetup orientation="landscape" paperSize="9"/>');
    out.push('</worksheet>');
    return out.join('');
  }

  function stylesXml() {
    return XML_HEAD + '<styleSheet xmlns="' + NS_MAIN + '">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
      '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF2"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF8D7DA"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top style="thin"><color auto="1"/></top><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="18">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +                                             // 0
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +                   // 1 header
        '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +                         // 2 int
        '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +                         // 3 money
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +                       // 4 date
        '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +                       // 5 datetime
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +                 // 6 total text
        '<xf numFmtId="3" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +   // 7
        '<xf numFmtId="4" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +   // 8
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +                                             // 9 number
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +                 // 10
        '<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' + // 11
        '<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' + // 12
        '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>' +                                   // 13 tone warning
        '<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>' +                                   // 14 tone danger
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +   // 15 wrap
        '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' + // 16
        '<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' + // 17
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  function build(spec) {
    spec = spec || {};
    var when = spec.generatedAt ? new Date(spec.generatedAt) : new Date();
    if (isNaN(when.getTime())) when = new Date();
    var used = {};
    var sheets = (spec.sheets || []).map(function (s) {
      return { name: sheetName(s.name || 'Sheet', used), rtl: s.rtl, columns: s.columns || [], rows: s.rows || [], totals: s.totals == null ? null : s.totals };
    });
    if (spec.meta && spec.meta.length) {
      sheets.push({ name: sheetName(spec.metaName || 'معايير التقرير', used), rtl: spec.metaRtl !== false,
        columns: [{ key: 'k', label: spec.metaLabels ? spec.metaLabels[0] : 'البند', type: 'text', width: 28 }, { key: 'v', label: spec.metaLabels ? spec.metaLabels[1] : 'القيمة', type: 'text', width: 60 }],
        rows: spec.meta.map(function (p) { return { k: p[0], v: p[1] == null ? '' : p[1] }; }), totals: null });
    }
    if (!sheets.length) sheets.push({ name: 'Sheet1', columns: [], rows: [], totals: null });
    var iso = new Date(Math.floor(when.getTime() / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
    var title = esc(spec.title || 'Marsa report');
    var files = [];
    files.push({ name: '[Content_Types].xml', data: utf8(XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>') });
    files.push({ name: '_rels/.rels', data: utf8(XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>') });
    files.push({ name: 'docProps/core.xml', data: utf8(XML_HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + title + '</dc:title><dc:creator>MARSA</dc:creator>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:modified>' +
      '</cp:coreProperties>') });
    files.push({ name: 'docProps/app.xml', data: utf8(XML_HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>MARSA</Application>' +
      '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>' + sheets.length + '</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
      '<TitlesOfParts><vt:vector size="' + sheets.length + '" baseType="lpstr">' + sheets.map(function (s) { return '<vt:lpstr>' + esc(s.name) + '</vt:lpstr>'; }).join('') + '</vt:vector></TitlesOfParts>' +
      '</Properties>') });
    files.push({ name: 'xl/workbook.xml', data: utf8(XML_HEAD + '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_R + '">' +
      // CT_BookView has no rightToLeft attribute (sml.xsd): sheet direction lives on each <sheetView rightToLeft="1">
      '<workbookPr/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16000" windowHeight="9000"/></bookViews><sheets>' +
      sheets.map(function (s, i) { return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
      '</sheets></workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8(XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>') });
    files.push({ name: 'xl/styles.xml', data: utf8(stylesXml()) });
    sheets.forEach(function (s, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXml(s)) }); });
    return zip(files, when);
  }
  function blob(spec) {
    if (typeof Blob === 'undefined') throw new Error('Blob unavailable');
    return new Blob([build(spec)], { type: MIME });
  }

  var api = { build: build, blob: blob, MIME: MIME, crc32: crc32, serial: serial, colName: colName, sheetName: function (n) { return sheetName(n, {}); } };
  root.MarsaXlsx = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
