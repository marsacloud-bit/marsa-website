/* =====================================================================
   مرسى | MARSA — OCR text → structured data (assets/js/ocr-parse.js)
   PURE functions only: no DOM, no network, no storage. Used by ocr.js in
   the browser (window.MarsaOcrParse) and by Node tests (module.exports).

   Public API: window.MarsaOcrParse = {
     FIELD_KEYS                       → the field keys of document_extractions.extracted_fields
     normalizeDigits(s)               → "٠-٩" / "۰-۹" → "0-9"
     parseAmount(s)                   → number | null  ("١٬٢٥٠٫٥٠" "1.250,50" "SAR 1,250.50" "(150)")
     formatAmount(n)                  → "1250.50" ('' when not a number)
     normalizeDate(s)                 → "YYYY-MM-DD" | ''  (Gregorian only; Hijri → '')
     isValidSaudiVat(s)               → 15 digits, starts and ends with 3
     isValidContainer(s)              → ISO 6346 owner code + category + serial + check digit
     isValidIban(s)                   → ISO 13616 mod-97
     normalizeCountry(s)              → Arabic country name as in request.html, or the input
     decodeZatcaQr(base64)            → { seller_name, vat_number, timestamp, total, vat_total } | null
     extractFields(text, docType)     → { fields: { key: { value, confidence, source } }, lineItems: [] }
     mergeQr(result, qr)              → result with the QR values applied (higher trust)
     plainFields(fields)              → { key: "value" } (what is stored in extracted_fields)
     safeCell(v) / toDelimited(rows, delim) → CSV/TSV text with formula-injection guard
   }
   confidence: 'high' = label found + value passes its check (or QR),
               'medium' = label found, value not verifiable,
               'low' = guessed without a label / failed its check / derived.
   ===================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MarsaOcrParse = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var FIELD_KEYS = ['invoice_number', 'invoice_date', 'supplier_name', 'supplier_vat', 'buyer_name', 'buyer_vat',
    'currency', 'subtotal', 'vat_amount', 'total', 'bl_number', 'container_numbers', 'declaration_number',
    'hs_codes', 'country_of_origin', 'iban'];

  /* ---------------------------------------------------------------
     Digits, amounts, dates
     --------------------------------------------------------------- */
  function normalizeDigits(s) {
    return String(s == null ? '' : s)
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
  }

  // currency marks that may stick to an amount: "SAR1,250.00" "1,250.00ر.س" "$ 99"
  var CUR_EDGE = /^(?:sar|sr|usd|us\$|eur|cny|rmb|aed|gbp|inr|try|kwd|bhd|qar|omr|egp|jpy|\$|€|£|¥|₹|₺|﷼|ر\.?\s?س\.?|ريال|ريالا|دولار|يورو|درهم)+|(?:sar|sr|usd|eur|cny|rmb|aed|gbp|inr|try|kwd|bhd|qar|omr|egp|jpy|\$|€|£|¥|₹|₺|﷼|ر\.?\s?س\.?|ريال|ريالا|دولار|يورو|درهم)+$/i;

  function parseAmount(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = normalizeDigits(v).trim();
    if (!s) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    s = s.replace(/[:：=]+$/, '').trim();
    for (var i = 0; i < 3; i++) s = s.replace(CUR_EDGE, '').trim();
    if (/^-/.test(s)) { neg = true; s = s.slice(1); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
    s = s.replace(/٫/g, '.').replace(/٬/g, ',').replace(/[\s\u00A0\u202F'’]/g, '');
    if (!s || /[^0-9.,]/.test(s)) return null;
    var hasDot = s.indexOf('.') !== -1, hasComma = s.indexOf(',') !== -1;
    if (hasDot && hasComma) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');   // 1.250,50
      else s = s.replace(/,/g, '');                                                             // 1,250.50
    } else if (hasComma) {
      s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');           // 1,250 | 12,5
    } else if (hasDot && /^\d{1,3}(\.\d{3}){2,}$/.test(s)) {
      s = s.replace(/\./g, '');                                                                 // 1.250.000
    }
    if (!/^\d*\.?\d+$/.test(s)) return null;
    var n = parseFloat(s);
    return isFinite(n) ? (neg ? -n : n) : null;
  }
  function formatAmount(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    return (Math.round(n * 100) / 100).toFixed(2);
  }
  function trimNum(n) {   // quantities: 10 / 2.5 (no trailing zeros)
    if (typeof n !== 'number' || !isFinite(n)) return '';
    return String(Math.round(n * 1000) / 1000);
  }

  var MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12,
    'يناير': 1, 'فبراير': 2, 'مارس': 3, 'ابريل': 4, 'أبريل': 4, 'إبريل': 4, 'مايو': 5, 'يونيو': 6, 'يونيه': 6,
    'يوليو': 7, 'يوليه': 7, 'اغسطس': 8, 'أغسطس': 8, 'سبتمبر': 9, 'اكتوبر': 10, 'أكتوبر': 10,
    'نوفمبر': 11, 'ديسمبر': 12, 'كانون الثاني': 1, 'شباط': 2, 'آذار': 3, 'اذار': 3, 'نيسان': 4, 'أيار': 5, 'ايار': 5,
    'حزيران': 6, 'تموز': 7, 'آب': 8, 'اب': 8, 'أيلول': 9, 'ايلول': 9, 'تشرين الأول': 10, 'تشرين الاول': 10,
    'تشرين الثاني': 11, 'كانون الأول': 12, 'كانون الاول': 12
  };
  var MONTH_RE = Object.keys(MONTHS).sort(function (a, b) { return b.length - a.length; }).join('|');

  function ymd(y, m, d) {
    y = +y; m = +m; d = +d;
    if (!(y >= 1900 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
    return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
  }
  // DD/MM/YYYY is the Saudi convention; swap only when the middle part cannot be a month
  function dmy(a, b, y) {
    a = +a; b = +b;
    if (b > 12 && a <= 12) return ymd(y, a, b);
    return ymd(y, b, a);
  }
  function normalizeDate(v) {
    var s = normalizeDigits(v).replace(/[\u200e\u200f\u061c]/g, '').trim();
    if (!s) return '';
    var m;
    // explicit Hijri (هـ / AH) or a Hijri-range year: not converted (needs the Umm al-Qura table)
    if (/(\d\s*ه(?![\u0600-\u06ff])|هـ|\bAH\b)/i.test(s) && /(?:^|\D)1[3-5]\d\d(?!\d)/.test(s)) return '';
    if ((m = /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/.exec(s))) return ymd(m[1], m[2], m[3]);
    if ((m = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(s))) return dmy(m[1], m[2], m[3]);
    if ((m = /(?:^|[^\d])(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})(?!\d)/.exec(s))) return dmy(m[1], m[2], 2000 + (+m[3]));
    var re1 = new RegExp('(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-\\/.,]*(' + MONTH_RE + ')\\.?[\\s\\-\\/.,]*(\\d{4})', 'i');
    if ((m = re1.exec(s))) return ymd(m[3], MONTHS[m[2].toLowerCase()], m[1]);
    var re2 = new RegExp('(' + MONTH_RE + ')\\.?[\\s\\-]+(\\d{1,2})(?:st|nd|rd|th)?,?[\\s\\-]+(\\d{4})', 'i');
    if ((m = re2.exec(s))) return ymd(m[3], MONTHS[m[1].toLowerCase()], m[2]);
    if ((m = /\b(\d{4})(\d{2})(\d{2})\b/.exec(s))) return ymd(m[1], m[2], m[3]);   // 20261015
    return '';
  }

  /* ---------------------------------------------------------------
     Identifier checks
     --------------------------------------------------------------- */
  function onlyDigits(s) { return normalizeDigits(s).replace(/[\s\-]/g, ''); }
  function isValidSaudiVat(s) { return /^3\d{13}3$/.test(onlyDigits(s)); }

  // ISO 6346: letters A=10 … Z=38 skipping multiples of 11; weights 2^i; (sum mod 11) mod 10
  var ISO_LETTERS = (function () {
    var map = {}, v = 10;
    for (var c = 65; c <= 90; c++) {
      if (v % 11 === 0) v++;
      map[String.fromCharCode(c)] = v++;
    }
    return map;
  })();
  function containerCheckDigit(code10) {
    var sum = 0;
    for (var i = 0; i < 10; i++) {
      var ch = code10.charAt(i);
      var val = i < 4 ? ISO_LETTERS[ch] : +ch;
      sum += val * Math.pow(2, i);
    }
    return (sum % 11) % 10;
  }
  function isValidContainer(s) {
    var c = normalizeDigits(s).toUpperCase().replace(/[\s\-]/g, '');
    if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(c)) return false;
    return containerCheckDigit(c.slice(0, 10)) === +c.charAt(10);
  }
  function isValidIban(s) {
    var c = normalizeDigits(s).toUpperCase().replace(/[\s\-]/g, '');
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(c)) return false;
    if (c.slice(0, 2) === 'SA' && c.length !== 24) return false;
    var r = c.slice(4) + c.slice(0, 4), rem = 0;
    for (var i = 0; i < r.length; i++) {
      var ch = r.charAt(i);
      var part = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
      for (var j = 0; j < part.length; j++) rem = (rem * 10 + (+part.charAt(j))) % 97;
    }
    return rem === 1;
  }

  /* country names → the Arabic labels used by request.html (#f-country) */
  var COUNTRIES = [
    ['الصين', /\b(china|p\.?\s?r\.?\s?c\.?|prc)\b|الصين/i], ['تركيا', /\b(turkey|t[uü]rkiye)\b|تركيا/i],
    ['الإمارات العربية المتحدة', /\b(u\.?a\.?e\.?|united arab emirates|emirates)\b|الإمارات|الامارات/i],
    ['سلطنة عُمان', /\boman\b|عمان|عُمان/i], ['الكويت', /\bkuwait\b|الكويت/i], ['الهند', /\bindia\b|الهند/i],
    ['ألمانيا', /\bgermany\b|ألمانيا|المانيا/i], ['إيطاليا', /\bitaly\b|إيطاليا|ايطاليا/i], ['إسبانيا', /\bspain\b|إسبانيا|اسبانيا/i],
    ['فرنسا', /\bfrance\b|فرنسا/i], ['المملكة المتحدة', /\b(united kingdom|u\.?k\.?|great britain|england)\b|المملكة المتحدة|بريطانيا/i],
    ['الولايات المتحدة الأمريكية', /\b(u\.?s\.?a\.?|united states)\b|الولايات المتحدة|أمريكا|امريكا/i],
    ['كوريا الجنوبية', /\b(south korea|korea)\b|كوريا/i], ['اليابان', /\bjapan\b|اليابان/i], ['فيتنام', /\bviet\s?nam\b|فيتنام/i],
    ['ماليزيا', /\bmalaysia\b|ماليزيا/i], ['الأردن', /\bjordan\b|الأردن|الاردن/i], ['البحرين', /\bbahrain\b|البحرين/i],
    ['قطر', /\bqatar\b|قطر/i], ['باكستان', /\bpakistan\b|باكستان/i], ['إندونيسيا', /\bindonesia\b|إندونيسيا|اندونيسيا/i],
    ['تايلاند', /\bthailand\b|تايلاند/i], ['هولندا', /\b(netherlands|holland)\b|هولندا/i], ['البرازيل', /\bbrazil\b|البرازيل/i],
    ['المملكة العربية السعودية', /\b(saudi arabia|k\.?s\.?a\.?)\b|السعودية/i], ['مصر', /\begypt\b|مصر/i]
  ];
  function normalizeCountry(s) {
    var v = String(s == null ? '' : s).trim();
    if (!v) return '';
    for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i][1].test(v)) return COUNTRIES[i][0];
    return v;
  }
  function isKnownCountry(s) {
    for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i][0] === s) return true;
    return false;
  }

  /* ---------------------------------------------------------------
     ZATCA e-invoice QR (base64 TLV: tag 1 seller, 2 VAT, 3 timestamp,
     4 total incl. VAT, 5 VAT total; phase-2 tags 6-9 are binary → ignored)
     --------------------------------------------------------------- */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64ToBytes(s) {
    var c = String(s == null ? '' : s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (!c || c.length % 4 === 1 || /[^A-Za-z0-9+\/]/.test(c)) return null;
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < c.length; i++) {
      buf = (buf << 6) | B64.indexOf(c.charAt(i)); bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xFF); }
    }
    return out;
  }
  function utf8(bytes) {
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch (e) { return null; }
    }
    try {
      var bin = ''; for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return decodeURIComponent(escape(bin));
    } catch (e2) { return null; }
  }
  function decodeZatcaQr(b64) {
    var bytes = b64ToBytes(b64);
    if (!bytes || bytes.length < 6 || bytes[0] !== 1) return null;
    var tags = {}, i = 0;
    while (i + 2 <= bytes.length) {
      var tag = bytes[i], len = bytes[i + 1];
      i += 2;
      if (i + len > bytes.length) return null;      // truncated / not TLV
      if (tag >= 1 && tag <= 5) {
        var txt = utf8(bytes.slice(i, i + len));
        if (txt == null) return null;
        tags[tag] = txt.trim();
      }
      i += len;
    }
    if (!tags[1] || !tags[2] || !tags[4]) return null;
    if (!/^\d{15}$/.test(onlyDigits(tags[2]))) return null;
    return {
      seller_name: tags[1].slice(0, 255),
      vat_number: onlyDigits(tags[2]),
      timestamp: (tags[3] || '').slice(0, 40),
      total: tags[4].slice(0, 40),
      vat_total: (tags[5] || '').slice(0, 40)
    };
  }

  /* ---------------------------------------------------------------
     Text preparation + label helpers
     --------------------------------------------------------------- */
  function prepText(text) {
    return normalizeDigits(text)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/g, '')   // zero-width + bidi marks
      .replace(/[\u064b-\u065f\u0670]/g, '')                                    // harakat
      .replace(/\u0640/g, '')                                                   // tatweel
      .replace(/٫/g, '.').replace(/٬/g, ',').replace(/[：﹕]/g, ':').replace(/[\t\u00a0]/g, ' ');
  }
  // tolerant Arabic regex source: alef / taa marbuta / yaa variants, flexible spaces
  function ar(label) {
    return label.replace(/[اأإآ]/g, '[اأإآ]').replace(/[ةه](?=\s|$)/g, '[ةه]').replace(/[يى](?=\s|$)/g, '[يى]').replace(/\s+/g, '\\s*');
  }
  function rx(list) {
    return new RegExp('(?:' + list.map(function (l) { return /[\u0600-\u06ff]/.test(l) ? ar(l) : l; }).join('|') + ')', 'i');
  }
  function stripEdges(s) { return String(s || '').replace(/^[\s:\-–—#.،,|/\\]+|[\s:\-–—#،,|/\\]+$/g, ''); }
  function tokens(s) { return String(s || '').split(/\s+/).filter(Boolean); }

  var VAT_LABEL = rx(['الرقم الضريبي', 'رقم التسجيل الضريبي', 'رقم تسجيل ضريبة القيمة المضافة', 'رقم ضريبة القيمة المضافة',
    'الرقم الضريبى', 'VAT\\s*(?:Reg(?:istration)?\\.?\\s*)?(?:No|Number|#|ID)\\.?', 'VAT\\s*Registration', 'TRN', 'Tax\\s*(?:Registration\\s*)?(?:No|Number|ID)\\.?', 'VATIN']);
  var BUYER_KW = rx(['العميل', 'المشتري', 'المستورد', 'المرسل إليه', 'Buyer', 'Customer', 'Client', 'Bill\\s*To', 'Sold\\s*To', 'Ship\\s*To', 'Consignee', 'Importer']);
  var SELLER_KW = rx(['المورد', 'البائع', 'المصدر', 'الشاحن', 'Seller', 'Supplier', 'Vendor', 'Exporter', 'Shipper', 'From\\b']);

  /* value extractors: segment of a line → string | '' */
  function exId(seg) {
    var t = tokens(seg);
    for (var i = 0; i < t.length; i++) {
      var w = stripEdges(t[i]).replace(/^#/, '');
      if (w.length < 2 || w.length > 40 || !/\d/.test(w)) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9\-\/_.]*$/.test(w)) continue;
      if (normalizeDate(w) && /[\/.\-]/.test(w)) continue;      // a date, not a number
      return w.toUpperCase();
    }
    return '';
  }
  // "15/04/1448هـ الموافق 31/10/2026م": try every date-shaped match, the Hijri one gives ''
  function exDate(seg) {
    var re = /(\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})(\s*(?:هـ|ه(?![\u0600-\u06ff])|AH\b))?/gi, m, any = false;
    seg = String(seg || '');
    while ((m = re.exec(seg))) {
      any = true;
      var d = normalizeDate(m[0]);
      if (d) return d;
    }
    return any ? '' : normalizeDate(seg);
  }
  function exVat(seg) {
    var s = String(seg || '');
    var m = /(?:^|\D)(3\d{13}3)(?!\d)/.exec(s);
    if (m) return { v: m[1], ok: true };
    var joined = s.replace(/(\d)[\s\-]+(?=\d)/g, '$1');
    m = /(?:^|\D)(3\d{13}3)(?!\d)/.exec(joined);
    if (m) return { v: m[1], ok: true };
    m = /(?:^|\D)(\d{15})(?!\d)/.exec(joined);
    if (m) return { v: m[1], ok: false };
    return null;
  }
  // every VAT-shaped number on a line, with its position (two-column seller | buyer layouts)
  function exVatAll(seg) {
    var s = String(seg || ''), out = [], m, re = /(?:^|\D)(3\d{13}3)(?!\d)/g;
    while ((m = re.exec(s))) { out.push({ v: m[1], ok: true, idx: m.index + m[0].length - 15 }); re.lastIndex = m.index + m[0].length; }
    if (out.length) return { list: out, str: s };
    var joined = s.replace(/(\d)[\s\-]+(?=\d)/g, '$1');
    re = /(?:^|\D)(3\d{13}3)(?!\d)/g;
    while ((m = re.exec(joined))) { out.push({ v: m[1], ok: true, idx: m.index + m[0].length - 15 }); re.lastIndex = m.index + m[0].length; }
    if (!out.length) {
      re = /(?:^|\D)(\d{15})(?!\d)/g;
      while ((m = re.exec(joined))) { out.push({ v: m[1], ok: false, idx: m.index + m[0].length - 15 }); re.lastIndex = m.index + m[0].length; }
    }
    return { list: out, str: joined };
  }
  function kwPositions(re, s) {
    var g = new RegExp(re.source, 'gi'), out = [], m;
    while ((m = g.exec(s))) { out.push(m.index); if (!m[0]) g.lastIndex++; }
    return out;
  }
  function amountTokens(seg) {
    var t = tokens(seg), out = [];
    for (var i = 0; i < t.length; i++) {
      var w = t[i];
      if (/%/.test(w) || (t[i + 1] && /^%/.test(t[i + 1]))) continue;      // 15% / 15 %
      if (/\d[\/]\d/.test(w) || /^\d{1,2}[\-.]\d{1,2}[\-.]\d{2,4}$/.test(w)) continue;   // dates
      var clean = w.replace(/^[(\[]+(?=\d)/, '').replace(/[)\]:،,;]+$/, '');
      if (/^\(.*\)$/.test(w)) clean = w;
      var n = parseAmount(clean);
      if (n == null) continue;
      if (/^\d{15}$/.test(clean)) continue;                                 // VAT numbers
      out.push({ i: i, n: n, raw: w });
    }
    return out;
  }
  function exAmount(seg, pickMax) {
    var a = amountTokens(seg);
    if (!a.length) return null;
    if (pickMax) return a.reduce(function (m, x) { return Math.abs(x.n) > Math.abs(m.n) ? x : m; }).n;
    return a[a.length - 1].n;
  }
  function exText(seg, before) {
    var parts = String(seg || '').split(/\s*:\s*/).map(stripEdges).filter(Boolean);
    var v = before ? parts[parts.length - 1] : parts[0];
    v = stripEdges(String(v || '').replace(NAME_STOP, '').replace(PARTY_TAIL, ''));
    if (v.length < 2 || v.length > 120) return '';
    if (!/[A-Za-z\u0600-\u06ff]{2,}/.test(v)) return '';
    return v;
  }
  function exDigits(seg) {
    var m = /(?:^|[^\d])(\d{6,20})(?!\d)/.exec(String(seg || '').replace(/(\d)[\s](?=\d)/g, '$1'));
    return m ? m[1] : '';
  }
  function exBl(seg) {
    var t = tokens(seg);
    for (var i = 0; i < t.length; i++) {
      var w = stripEdges(t[i]).replace(/^#/, '').toUpperCase();
      if (/^[A-Z0-9][A-Z0-9\-]{4,39}$/.test(w) && /\d/.test(w) && (w.replace(/\D/g, '').length >= 6 || /[A-Z]/.test(w))) return w;
    }
    return '';
  }
  function exCountry(seg, before) { var v = exText(seg, before); return v ? normalizeCountry(v) : ''; }

  // first line (in label-priority order) whose label matches and yields a value
  function findLabeled(lines, labelGroups, extractor, opts) {
    opts = opts || {};
    for (var g = 0; g < labelGroups.length; g++) {
      var re = labelGroups[g];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (opts.exclude && g >= (opts.excludeFrom || 0) && opts.exclude.test(line)) continue;
        var m = re.exec(line);
        if (!m) continue;
        if (opts.reject && opts.reject(line, m)) continue;
        var after = line.slice(m.index + m[0].length), before = line.slice(0, m.index);
        var v = extractor(after, false);
        if (!v && opts.allowBefore !== false) v = extractor(before, true);
        if (!v && opts.nextLine !== false) {
          for (var k = i + 1; k < Math.min(lines.length, i + 3); k++) {
            if (!lines[k]) continue;
            v = extractor(lines[k], false);
            break;
          }
        }
        if (v) return { value: v, line: i, group: g };
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------
     Field label sets
     --------------------------------------------------------------- */
  var LBL = {
    invoice_number: [rx(['رقم الفاتورة الضريبية', 'رقم الفاتورة', 'رقم فاتورة', 'فاتورة رقم', 'Invoice\\s*(?:No|Number|Num|#)\\.?', 'Inv\\.?\\s*(?:No|#)\\.?', 'Tax\\s*Invoice\\s*(?:No|Number)\\.?']),
      rx(['Bill\\s*No\\.?', 'Document\\s*No\\.?', 'Reference\\s*No\\.?', 'رقم المستند', 'الرقم المرجعي'])],
    invoice_date: [rx(['تاريخ الفاتورة', 'تاريخ إصدار الفاتورة', 'تاريخ الإصدار', 'تاريخ الاصدار', 'Invoice\\s*Date', 'Date\\s*of\\s*Issue', 'Issue\\s*Date', 'Date\\s*of\\s*Invoice']),
      rx(['التاريخ', 'تاريخ التوريد', 'Date\\s*of\\s*Supply', '\\bDate\\b'])],
    supplier_name: [rx(['اسم المورد', 'اسم البائع', 'اسم الشركة البائعة', 'Seller\\s*Name', 'Supplier\\s*Name', 'Vendor\\s*Name']),
      rx(['المورد', 'البائع', 'Seller', 'Supplier', 'Vendor', 'Exporter', 'المصدر'])],
    buyer_name: [rx(['اسم العميل', 'اسم المشتري', 'Buyer\\s*Name', 'Customer\\s*Name', 'Client\\s*Name']),
      rx(['العميل', 'المشتري', 'المستورد', 'Buyer', 'Customer', 'Bill\\s*To', 'Sold\\s*To', 'Importer'])],
    bl_number: [rx(['رقم بوليصة الشحن الجوي', 'رقم بوليصة الشحن', 'رقم البوليصة', 'رقم بوليصة', 'بوليصة الشحن رقم', 'B\\s*\\/\\s*L\\s*(?:No|Number|#)?\\.?', 'BL\\s*(?:No|Number|#)\\.?', 'Bill\\s*of\\s*Lading\\s*(?:No|Number|#)?\\.?', 'BOL\\s*(?:No|#)?\\.?', '[MH]BL\\s*(?:No|#)?\\.?', 'AWB\\s*(?:No|Number|#)?\\.?', 'Air\\s*Waybill\\s*(?:No|Number)?\\.?'])],
    declaration_number: [rx(['رقم البيان الجمركي', 'رقم البيان', 'بيان جمركي رقم', 'رقم بيان', 'Customs\\s*Declaration\\s*(?:No|Number)?\\.?', 'Declaration\\s*(?:No|Number|#)\\.?', 'Bayan\\s*(?:No|Number)?\\.?'])],
    country_of_origin: [rx(['بلد المنشأ', 'دولة المنشأ', 'بلد المنشا', 'منشأ البضاعة', 'Country\\s*of\\s*Origin', 'Origin\\s*Country', 'Made\\s*in']),
      rx(['المنشأ', 'المنشا', 'Origin'])],
    currency: [rx(['العملة', 'عملة الفاتورة', 'Currency'])]
  };
  // "Customer ID" / "رقم العميل" / "الرقم الضريبي للمورد" are not name labels
  function rejectName(line, m) {
    var after = line.slice(m.index + m[0].length, m.index + m[0].length + 16);
    var before = line.slice(Math.max(0, m.index - 24), m.index);
    return /^\s*(No\b|No\.|Number|ID\b|#|Code|VAT|Tax|TRN|Address|Phone|Tel|Mobile|Email|Ref|Account)/i.test(after) ||
      /^\s*(الضريبي|الضريبى|رقم)/.test(after) || /(رقم|ضريبي|ضريبى|عنوان|هاتف|جوال|بريد|حساب)\s*ل?\s*$/.test(before);
  }
  // a name ends where the next label starts ("ABC Co. VAT No …", "شركة … الرقم الضريبي …")
  var NAME_STOP = /\s(?:VAT|TRN|Tax|Tel|Phone|Mobile|CR|C\.R|Address|Email|الرقم|رقم|هاتف|جوال|العنوان|سجل|س\.ت)(?=[\s:.#]|$).*$/i;

  // bilingual "Seller: ABC Trading البائع" / "ABC Trading اسم المورد": the Arabic label trails the value
  var PARTY_TAIL = /\s+(?:[اأ]سم\s+)?(?:ال)?(?:بائع|مورد|عميل|مشتري|مشترى|مستورد|مصدر|شاحن|مرسل\s*[اإ]ليه)\s*:?\s*$/;

  var AMT = {
    total: rx(['الإجمالي شامل الضريبة', 'الإجمالي شامل ضريبة القيمة المضافة', 'المجموع شامل الضريبة', 'الإجمالي مع الضريبة', 'الاجمالي شامل الضريبة',
      'إجمالي المبلغ المستحق', 'المبلغ المستحق', 'الإجمالي المستحق', 'الإجمالي الكلي', 'المجموع الكلي', 'صافي المبلغ المستحق', 'إجمالي الفاتورة',
      'Grand\\s*Total', 'Total\\s*(?:Amount\\s*)?(?:incl\\.?|including|inclusive\\s*of|with)\\s*(?:of\\s*)?(?:VAT|Tax)', 'Total\\s*Due', 'Amount\\s*Due',
      'Balance\\s*Due', 'Net\\s*Payable', 'Total\\s*Payable', 'Invoice\\s*Total', 'Total\\s*Invoice\\s*(?:Amount|Value)']),
    subtotal: rx(['الإجمالي قبل الضريبة', 'المجموع قبل الضريبة', 'الإجمالي غير شامل الضريبة', 'الاجمالي غير شامل ضريبة القيمة المضافة',
      'الإجمالي غير شامل ضريبة القيمة المضافة', 'المجموع بدون الضريبة', 'الإجمالي بدون ضريبة', 'المبلغ الخاضع للضريبة', 'الإجمالي الخاضع للضريبة',
      'إجمالي المبلغ الخاضع للضريبة', 'المجموع الفرعي', 'الإجمالي الفرعي', 'Sub\\s*-?\\s*Total', 'Total\\s*(?:Amount\\s*)?(?:excl\\.?|excluding|before|without|exclusive\\s*of)\\s*(?:of\\s*)?(?:VAT|Tax)',
      'Taxable\\s*Amount', 'Total\\s*Taxable(?:\\s*Amount)?', 'Net\\s*Amount', 'Net\\s*Total']),
    vat: rx(['مبلغ ضريبة القيمة المضافة', 'إجمالي ضريبة القيمة المضافة', 'قيمة ضريبة القيمة المضافة', 'ضريبة القيمة المضافة', 'مبلغ الضريبة', 'قيمة الضريبة',
      'إجمالي الضريبة', 'اجمالي الضريبة', 'الضريبة', 'VAT\\s*Amount', 'Total\\s*VAT', 'VAT\\s*Total', 'Tax\\s*Amount', 'Total\\s*Tax', '\\bVAT\\b', '\\bTax\\b']),
    totalGeneric: rx(['الإجمالي', 'الاجمالي', 'إجمالي', 'اجمالي', 'المجموع', '\\bTotal\\b', '\\bAmount\\b'])
  };
  // payment / page footers under the real total on POS receipts ("Amount Paid 0.00", "Page Total 1 of 2")
  var PAY_EXCLUDE = /(\bPaid\b|\bChange\b|\bCash\b|\bReceived\b|\bRemaining\b|\bBalance\b|\bTendered\b|\bPage\b|\bDiscount\b|\bin\s*words\b|المدفوع|مدفوع|المتبقي|الباقي|نقد|المستلم|صفحة|خصم|كتابة|فقط)/i;
  var AMT_EXCLUDE = /(Qty|Quantity|Weight|Packages|Pallets|Cartons|Pieces|Pcs|CBM|Volume|الكمية|كمية|الوزن|عدد|الطرود|الكراتين|الحجم)/i;

  function lineAmount(lines, i, pickMax) {
    var v = exAmount(lines[i], pickMax);
    if (v != null) return v;
    // label alone on its line → accept the next line only when it is a bare amount
    for (var k = i + 1; k < Math.min(lines.length, i + 2); k++) {
      var t = lines[k];
      if (t && /^[\s\d.,()\-]+(?:\s*(?:SAR|SR|USD|EUR|AED|CNY|ر\.?\s?س\.?|ريال|﷼|\$|€))?$/i.test(t)) return exAmount(t, pickMax);
    }
    return null;
  }
  // "Total (Excluding VAT)" / "الإجمالي (غير شامل الضريبة)" (ZATCA template) → no brackets, no "excl." dot
  var EXCL_RE = /(غير\s*شامل|(?:^|\s)(?:قبل|بدون)(?=\s|$)|\bexcl\b|\bexcluding\b|\bexclusive\b|\bbefore\b|\bwithout\b)/i;
  var INCL_RE = /((?:^|\s)(?:شامل[ةا]?|مع)(?=\s|$)|\bincl\b|\bincluding\b|\binclusive\b|\bwith\b)/i;
  var TAX_RE = /(ضريب|\bVAT\b|\bTax\b)/i;
  var TOT_WORD = /(إجمالي|اجمالي|الإجمالي|الاجمالي|المجموع|مجموع|\bTotal\b|\bAmount\b|المبلغ)/i;
  function classifyAmountLine(raw) {
    var line = String(raw || '').replace(/[()\[\]]/g, ' ').replace(/\b(excl|incl)\./gi, '$1 ');
    if (AMT_EXCLUDE.test(line)) return null;
    if (AMT.subtotal.test(line)) return 'subtotal';
    if (TOT_WORD.test(line) && TAX_RE.test(line) && EXCL_RE.test(line)) return 'subtotal';
    if (AMT.total.test(line)) return 'total';
    if (TOT_WORD.test(line) && TAX_RE.test(line) && INCL_RE.test(line) && !/(مجموع|Total)\s*(?:ال)?(?:ضريب|VAT|Tax)/i.test(line)) return 'total';
    if (AMT.vat.test(line)) {
      if (VAT_LABEL.test(line) || exVat(line)) return null;   // a VAT *number* line, not an amount
      return 'vat';
    }
    if (AMT.totalGeneric.test(line) && !PAY_EXCLUDE.test(line)) return 'totalGeneric';
    return null;
  }

  /* ---------------------------------------------------------------
     Line items: a row is kept only when three of its numbers satisfy
     quantity × unit price ≈ amount (order-independent, so RTL and LTR
     reading orders both work). A leftover HS-shaped number = hs_code.
     --------------------------------------------------------------- */
  var HS_RE = /^\d{4}\.\d{2}(?:\.\d{2,4})?$|^\d{4}\.\d{4,6}$|^\d{8,12}$/;
  function near(a, b) { return Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.005); }
  function parseItemLine(line) {
    var t = tokens(line);
    if (t.length < 4) return null;
    var nums = [], hsOnly = [];
    t.forEach(function (w, i) {
      if (/%/.test(w)) return;
      var clean = w.replace(/[)\]:،,;]+$/, '').replace(/^[(\[]+/, '');
      var isHs = HS_RE.test(clean);
      var n = parseAmount(clean);
      if (n == null && isHs) { hsOnly.push({ i: i, raw: clean, hs: true }); return; }   // "8471.30.00" is not an amount
      if (n == null || n < 0) return;
      nums.push({ i: i, n: n, raw: clean, hs: isHs });
    });
    if (nums.length < 3) return null;
    var best = null, L = Math.min(nums.length, 9);
    var cand = nums.slice(-L);
    for (var a = 0; a < cand.length; a++) for (var b = a + 1; b < cand.length; b++) for (var c = b + 1; c < cand.length; c++) {
      var tri = [cand[a], cand[b], cand[c]];
      for (var r = 0; r < 3; r++) {
        var amt = tri[r], f = tri.filter(function (_, k) { return k !== r; });
        if (!(amt.n > 0) || !near(f[0].n * f[1].n, amt.n)) continue;
        if (f[0].n === 0 || f[1].n === 0) continue;
        var score = c * 10 + (r === 2 || r === 0 ? 5 : 0) - (amt.hs ? 20 : 0) - (f[0].hs || f[1].hs ? 20 : 0);
        if (!best || score > best.score) best = { score: score, amt: amt, f: f };
      }
    }
    if (!best) return null;
    var used = [best.amt.i, best.f[0].i, best.f[1].i];
    var q = best.f[0], p = best.f[1];
    var isInt = function (x) { return Math.abs(x.n - Math.round(x.n)) < 1e-9 && !/[.,]\d/.test(x.raw); };
    if (!isInt(q) && isInt(p)) { var tmp = q; q = p; p = tmp; }
    var hs = '';
    nums.concat(hsOnly).forEach(function (x) { if (!hs && x.hs && used.indexOf(x.i) === -1) { hs = x.raw; used.push(x.i); } });
    var desc = t.filter(function (w, i) {
      if (used.indexOf(i) !== -1) return false;
      if (i === 0 && /^\d{1,3}[.)\-]?$/.test(w)) return false;          // row number
      if (CUR_EDGE.test(w) && w.replace(CUR_EDGE, '') === '') return false;
      return true;
    }).join(' ').replace(/\s*[|]\s*/g, ' ').trim();
    desc = stripEdges(desc);
    if (!/[A-Za-z\u0600-\u06ff]{2,}/.test(desc)) return null;
    return {
      description: desc.slice(0, 300), hs_code: hs, quantity: trimNum(q.n),
      unit_price: formatAmount(p.n), amount: formatAmount(best.amt.n)
    };
  }

  /* ---------------------------------------------------------------
     Main entry
     --------------------------------------------------------------- */
  function F(value, confidence, source) { return { value: String(value), confidence: confidence, source: source || 'text' }; }

  function extractFields(text, docType) {
    var t = prepText(text || '').slice(0, 200000);
    var lines = t.split('\n').map(function (l) { return l.replace(/ {2,}/g, ' ').trim(); });
    var fields = {}, hit;
    var isBL = docType === 'bill_of_lading';

    /* invoice number / date */
    if ((hit = findLabeled(lines, LBL.invoice_number, exId, {}))) fields.invoice_number = F(hit.value, hit.group === 0 ? 'high' : 'medium');
    if ((hit = findLabeled(lines, LBL.invoice_date, exDate, { exclude: /(Due|استحقاق|Expiry|انتهاء|Delivery|تسليم|ميلاد|Birth|Printed|طباعة)/i, excludeFrom: 1 }))) {
      fields.invoice_date = F(hit.value, hit.group === 0 ? 'high' : 'medium');
    } else {
      for (var di = 0; di < lines.length; di++) { var dd = exDate(lines[di]); if (dd) { fields.invoice_date = F(dd, 'low'); break; } }
    }

    /* parties (B/L: shipper / consignee) */
    var supLabels = isBL ? [rx(['Shipper', 'الشاحن', 'المصدر'])].concat(LBL.supplier_name) : LBL.supplier_name;
    var buyLabels = isBL ? [rx(['Consignee', 'المرسل إليه', 'المستلم'])].concat(LBL.buyer_name) : LBL.buyer_name;
    if ((hit = findLabeled(lines, supLabels, exText, { reject: rejectName }))) fields.supplier_name = F(hit.value, 'medium');
    if ((hit = findLabeled(lines, buyLabels, exText, { reject: rejectName }))) fields.buyer_name = F(hit.value, 'medium');

    /* VAT numbers: party from the same line or the nearest party header above */
    var vats = [];
    lines.forEach(function (line, i) {
      var all = exVatAll(line);
      if (!all.list.length) return;
      var labeled = VAT_LABEL.test(line);
      var multi = all.list.length > 1;
      // party = nearest keyword BEFORE each number (two columns merged into one line)
      var kws = kwPositions(SELLER_KW, all.str).map(function (p) { return { p: p, party: 'seller' }; })
        .concat(kwPositions(BUYER_KW, all.str).map(function (p) { return { p: p, party: 'buyer' }; }));
      all.list.forEach(function (v, n) {
        if (!v.ok && !labeled) return;                   // a random 15-digit number
        var party = null, bestP = -1;
        kws.forEach(function (k) { if (k.p < v.idx && k.p > bestP) { bestP = k.p; party = k.party; } });
        if (!party && !multi) party = BUYER_KW.test(line) ? 'buyer' : SELLER_KW.test(line) ? 'seller' : null;
        if (!party && multi) party = n === 0 ? 'seller' : n === 1 ? 'buyer' : null;   // left/first = seller
        for (var k = i - 1; !party && k >= Math.max(0, i - 4); k--) {
          if (BUYER_KW.test(lines[k])) party = 'buyer';
          else if (SELLER_KW.test(lines[k])) party = 'seller';
        }
        if (!vats.some(function (x) { return x.v === v.v; })) vats.push({ v: v.v, ok: v.ok, labeled: labeled, party: party });
      });
    });
    function takeVat(party) {
      var x = vats.filter(function (y) { return y.party === party && !y.used; })[0] || vats.filter(function (y) { return !y.party && !y.used; })[0];
      if (!x) return null;
      x.used = true;
      return F(x.v, !x.ok ? 'low' : (x.labeled && x.party === party) ? 'high' : 'medium');
    }
    var sv = takeVat('seller'); if (sv) fields.supplier_vat = sv;
    var bv = takeVat('buyer'); if (bv) fields.buyer_vat = bv;

    /* amounts */
    var amt = { subtotal: null, vat: null, total: null, totalGeneric: null };
    lines.forEach(function (line, i) {
      var cat = classifyAmountLine(line);
      if (!cat) return;
      var v = lineAmount(lines, i, cat === 'total' || cat === 'totalGeneric');
      if (v == null) return;
      if (cat === 'totalGeneric') { if (amt.totalGeneric == null || Math.abs(v) > Math.abs(amt.totalGeneric)) amt.totalGeneric = v; }   // largest generic "Total"
      else if (amt[cat] == null) amt[cat] = v;
    });
    var total = amt.total != null ? amt.total : amt.totalGeneric;
    var sub = amt.subtotal, vat = amt.vat;
    var tol = function (x) { return Math.max(0.05, Math.abs(x) * 0.002); };
    var consistent = sub != null && vat != null && total != null && Math.abs(sub + vat - total) <= tol(total);
    var vatRateOk = sub != null && vat != null && Math.abs(sub * 0.15 - vat) <= tol(vat);
    if (sub != null) fields.subtotal = F(formatAmount(sub), consistent ? 'high' : 'medium');
    if (vat != null) fields.vat_amount = F(formatAmount(vat), consistent || vatRateOk ? 'high' : 'medium');
    if (total != null) fields.total = F(formatAmount(total), consistent ? 'high' : amt.total != null ? 'medium' : 'low');
    if (sub == null && vat != null && total != null && total > vat) fields.subtotal = F(formatAmount(total - vat), 'low');
    if (total == null && sub != null && vat != null) fields.total = F(formatAmount(sub + vat), 'low');

    /* currency */
    var curHit = findLabeled(lines, LBL.currency, function (seg) { return detectCurrency(seg).code; }, {});
    if (curHit) fields.currency = F(curHit.value, 'high');
    else { var dc = detectCurrency(t); if (dc.code) fields.currency = F(dc.code, dc.count >= 2 ? 'medium' : 'low'); }

    /* shipping / customs references */
    if ((hit = findLabeled(lines, LBL.bl_number, exBl, {}))) fields.bl_number = F(hit.value, 'medium');
    if ((hit = findLabeled(lines, LBL.declaration_number, exDigits, {}))) fields.declaration_number = F(hit.value, 'medium');
    var cont = findContainers(t, fields.bl_number ? fields.bl_number.value : '');
    if (cont.list.length) fields.container_numbers = F(cont.list.join(', '), cont.allValid ? 'high' : 'low');

    /* country of origin */
    if ((hit = findLabeled(lines, LBL.country_of_origin, exCountry, { exclude: /(Port|ميناء|Place|مكان)/i }))) {
      fields.country_of_origin = F(hit.value, isKnownCountry(hit.value) ? 'high' : 'medium');
    }

    /* IBAN */
    var ib = /\b([A-Z]{2}\d{2}(?:[ \-]?[A-Z0-9]{4}){3,7}(?:[ \-]?[A-Z0-9]{1,4})?)\b/.exec(t.toUpperCase());
    if (ib) {
      // the regex may glue a following word ("… 7519 AL RAJHI BANK"): keep the longest prefix that passes mod-97
      var cand = ib[1].replace(/[\s\-]/g, ''), iban = '';
      if (cand.slice(0, 2) === 'SA') { if (isValidIban(cand.slice(0, 24))) iban = cand.slice(0, 24); }
      else for (var L = Math.min(cand.length, 34); L >= 15 && !iban; L--) if (isValidIban(cand.slice(0, L))) iban = cand.slice(0, L);
      if (iban) fields.iban = F(iban, 'high');
      else {
        var sa = cand.slice(0, 2) === 'SA' ? /^SA\d{22}/.exec(cand) : null;
        fields.iban = F(sa ? sa[0] : cand, 'low');
      }
    }

    /* line items (skip totals / label lines) */
    var items = [];
    lines.forEach(function (line) {
      if (items.length >= 200 || !line) return;
      if (classifyAmountLine(line) || VAT_LABEL.test(line)) return;
      var it = parseItemLine(line);
      if (it) items.push(it);
    });

    /* HS codes: labelled lines + item column */
    var hs = [];
    var HS_LBL = /(\bH\.?\s?S\.?\b|\bHS\s*Code|\bHTS\b|Tariff\s*(?:Code|No)|Commodity\s*Code|رمز\s*(?:ال)?نظام\s*المنسق|النظام\s*المنسق|البند\s*الجمركي|بند\s*التعرفة|رمز\s*التعرفة|رمز\s*HS)/i;
    lines.forEach(function (line, i) {
      if (!HS_LBL.test(line)) return;
      [line, lines[i + 1] || ''].forEach(function (seg, k) {
        if (k === 1 && hs.length) return;
        tokens(seg).forEach(function (w) {
          var c = stripEdges(w);
          if (HS_RE.test(c) || /^\d{4}\.\d{2}$/.test(c) || /^\d{6}$/.test(c)) { if (hs.indexOf(c) === -1) hs.push(c); }
        });
      });
    });
    items.forEach(function (it) { if (it.hs_code && hs.indexOf(it.hs_code) === -1) hs.push(it.hs_code); });
    if (hs.length) fields.hs_codes = F(hs.slice(0, 50).join(', '), 'medium');

    return { fields: fields, lineItems: items };
  }

  var CURRENCIES = [
    ['SAR', /\b(SAR|SR)\b|ر\.?\s?س\.?|ريال\s*سعودي|ريال|﷼/gi], ['USD', /\b(USD|US\$)\b|\$|دولار/gi], ['EUR', /\bEUR\b|€|يورو/gi],
    ['CNY', /\b(CNY|RMB)\b|¥|يوان/gi], ['AED', /\bAED\b|درهم/gi], ['GBP', /\bGBP\b|£|جنيه\s*إسترليني/gi],
    ['INR', /\bINR\b|₹|روبية/gi], ['TRY', /\bTRY\b|₺|ليرة\s*تركية/gi], ['KWD', /\bKWD\b|دينار\s*كويتي/gi],
    ['BHD', /\bBHD\b|دينار\s*بحريني/gi], ['QAR', /\bQAR\b|ريال\s*قطري/gi], ['OMR', /\bOMR\b|ريال\s*عماني/gi],
    ['EGP', /\bEGP\b|جنيه\s*مصري/gi], ['JPY', /\bJPY\b|ين\s*ياباني/gi]
  ];
  function detectCurrency(s) {
    var best = { code: '', count: 0 };
    CURRENCIES.forEach(function (c) {
      var m = String(s || '').match(c[1]);
      var n = m ? m.length : 0;
      if (n > best.count) best = { code: c[0], count: n };
    });
    return best;
  }
  function findContainers(t, exclude) {
    var up = t.toUpperCase(), seen = {}, list = [], allValid = true, m;
    var re = /\b([A-Z]{3}[UJZ])[\s\-]?([0-9OIlSB]{3})[\s]?([0-9OIlSB]{3})[\s\-]?([0-9OIlSB])\b/g;
    while ((m = re.exec(up)) && list.length < 100) {
      var digitsPart = (m[2] + m[3] + m[4]).replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
      var raw = m[2] + m[3] + m[4];
      var code = m[1] + digitsPart;
      var valid = isValidContainer(code);
      if (!valid && /[^0-9]/.test(raw)) continue;          // only trust an OCR fix that passes the check digit
      if (code === String(exclude || '').toUpperCase() || seen[code]) continue;
      seen[code] = 1; list.push(code);
      if (!valid) allValid = false;
    }
    return { list: list, allValid: allValid };
  }

  /* ---------------------------------------------------------------
     QR merge: QR values are signed/structured, so they win over OCR text
     --------------------------------------------------------------- */
  function mergeQr(result, qr) {
    if (!result || !qr) return result;
    var f = Object.assign({}, result.fields);
    function put(key, val) {
      if (!val) return;
      var prev = f[key];
      f[key] = { value: String(val), confidence: 'high', source: 'qr' };
      if (prev && prev.value && prev.value !== String(val)) f[key].alt = prev.value;   // what the text said
    }
    put('supplier_name', qr.seller_name);
    if (isValidSaudiVat(qr.vat_number)) put('supplier_vat', qr.vat_number);
    var tot = parseAmount(qr.total), vat = parseAmount(qr.vat_total);
    if (tot != null) put('total', formatAmount(tot));
    if (vat != null) put('vat_amount', formatAmount(vat));
    var d = normalizeDate(String(qr.timestamp || '').slice(0, 10)) || normalizeDate(qr.timestamp);
    if (d) put('invoice_date', d);
    if (tot != null && vat != null) {
      var s = formatAmount(tot - vat);
      if (f.subtotal && f.subtotal.value === s) f.subtotal = { value: s, confidence: 'high', source: f.subtotal.source };
      else if (!f.subtotal || f.subtotal.confidence === 'low') f.subtotal = { value: s, confidence: 'medium', source: 'qr' };
    }
    if (!f.currency) f.currency = { value: 'SAR', confidence: 'medium', source: 'qr' };   // ZATCA amounts are in SAR
    return { fields: f, lineItems: result.lineItems || [] };
  }
  function plainFields(fields) {
    var out = {};
    Object.keys(fields || {}).forEach(function (k) {
      if (FIELD_KEYS.indexOf(k) === -1) return;
      var v = fields[k];
      v = v && typeof v === 'object' ? v.value : v;
      if (v != null && String(v).trim() !== '') out[k] = String(v).trim();
    });
    return out;
  }

  /* ---------------------------------------------------------------
     CSV / TSV export with a spreadsheet formula-injection guard
     --------------------------------------------------------------- */
  function safeCell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^[+\-]?\d+(?:[.,]\d+)?$/.test(s)) s = "'" + s;   // plain numbers stay numbers
    return s;
  }
  function toDelimited(rows, delim) {
    delim = delim || ',';
    return (rows || []).map(function (r) {
      return (r || []).map(function (v) {
        var s = safeCell(v);
        if (delim === '\t') return s.replace(/[\t\r\n]+/g, ' ');
        return /[",\r\n;]/.test(s) || s.indexOf(delim) !== -1 ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(delim);
    }).join('\r\n');
  }

  return {
    FIELD_KEYS: FIELD_KEYS,
    normalizeDigits: normalizeDigits, parseAmount: parseAmount, formatAmount: formatAmount, normalizeDate: normalizeDate,
    isValidSaudiVat: isValidSaudiVat, isValidContainer: isValidContainer, containerCheckDigit: containerCheckDigit,
    isValidIban: isValidIban, normalizeCountry: normalizeCountry,
    decodeZatcaQr: decodeZatcaQr, extractFields: extractFields, mergeQr: mergeQr, plainFields: plainFields,
    detectCurrency: detectCurrency, parseItemLine: parseItemLine,
    safeCell: safeCell, toDelimited: toDelimited
  };
});
