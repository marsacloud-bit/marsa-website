/* =====================================================================
   مرسى | MARSA — OCR text → structured data (assets/js/ocr-parse.js)
   PURE functions only: no DOM, no network, no storage. Used by ocr.js in
   the browser (window.MarsaOcrParse) and by Node tests (module.exports).

   Public API: window.MarsaOcrParse = {
     FIELD_KEYS                       → the field keys of document_extractions.extracted_fields
     normalizeDigits(s)               → "٠-٩" / "۰-۹" → "0-9"
     parseAmount(s)                   → number | null  ("١٬٢٥٠٫٥٠" "1.250,50" "SAR 1,250.50" "(150)")
     formatAmount(n)                  → "1250.50" ('' when not a number)
     normalizeDate(s)                 → "YYYY-MM-DD" | ''  (a Hijri date — هـ / AH, or a year 1300–1600 — is converted
                                        from Umm al-Qura through MarsaNorm.hijriToGregorian (legacy-norm.js, step 4,
                                        20261120000100); '' when MarsaNorm / the calendar is missing or the day does not exist)
     isValidSaudiVat(s)               → 15 digits, starts and ends with 3
     isValidContainer(s)              → ISO 6346 owner code + category + serial + check digit
     isValidIban(s)                   → ISO 13616 mod-97
     normalizeCountry(s)              → Arabic country name as in request.html, or the input
     decodeZatcaQr(base64)            → { seller_name, vat_number, timestamp, total, vat_total } | null
     extractFields(text, docType)     → { fields: { key: { value, confidence, source } }, lineItems: [] }
     mergeQr(result, qr)              → result with the QR values applied (higher trust)
     plainFields(fields, keys?)       → { key: "value" } (what is stored in extracted_fields); keys = the allowed keys
                                        (default FIELD_KEYS; DB_FIELD_KEYS for an AI ai-doc-v3 reading)
     DB_FIELD_KEYS                    → the shipment / declaration keys of app.extraction_field_keys() (20261120000100 —
                                        20261121000100 without the appointment / EIR keys): what an ocr.html save may send
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
    'hs_codes', 'country_of_origin', 'iban',
    // AI reading (Claude, 20261114000100): bill-of-lading voyage / parties (the text parser fills them too since fields v2: shippingFields)
    'vessel', 'voyage', 'port_of_loading', 'port_of_discharge', 'shipper', 'consignee',
    // AI reading v2 (ai-doc-v2, 20261116000100): the fields the invoice ↔ B/L ↔ declaration match compares
    'gross_weight', 'net_weight', 'packages_count', 'package_type', 'goods_description', 'incoterms'];
  // app.extraction_field_keys() of the live schema (20261119000100 DOCS + 20261120000100 DECL): FIELD_KEYS + the ai-doc-v3
  // keys. ocr.html shows every key a reading returns; only these are saved (extracted_fields / reviewed_fields).
  var DB_FIELD_KEYS = FIELD_KEYS.concat(['seal_numbers', 'consignee_name', 'notify_party', 'booking_number', 'place_of_receipt',
    'place_of_delivery', 'freight_terms', 'measurement_cbm', 'temperature_c', 'shipping_line', 'export_country', 'payment_terms',
    'packing_list_number', 'packing_list_date',
    'declaration_type', 'declaration_status', 'declaration_date', 'declaration_date_hijri', 'importer_name_ar', 'broker_name',
    'local_value', 'payment_method']);

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
  // MarsaNorm (assets/js/legacy-norm.js): window.MarsaNorm in the browser, require() in Node; null when absent
  var NORM = null;
  function norm() {
    if (NORM) return NORM;
    if (typeof window !== 'undefined' && window.MarsaNorm) NORM = window.MarsaNorm;
    else if (typeof module === 'object' && module.exports && typeof require === 'function') {
      try { NORM = require('./legacy-norm.js'); } catch (e) { NORM = null; }
    }
    return NORM;
  }
  function normalizeDate(v) {
    var s = normalizeDigits(v).replace(/[\u200e\u200f\u061c]/g, '').trim();
    if (!s) return '';
    var m;
    // Hijri (هـ / AH, or a year 1300–1600 in a numeric date): Umm al-Qura → Gregorian (legacy convertHijriField)
    var marked = /(\d\s*ه(?![\u0600-\u06ff])|هـ|\bAH\b)/i.test(s);
    var hm = /(?:^|\D)(1[3-6]\d\d)[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?!\d)/.exec(s) || /(?:^|\D)(\d{1,2})[\/\-.](\d{1,2})[\/\-.](1[3-6]\d\d)(?!\d)/.exec(s);
    if (hm || (marked && /(?:^|\D)1[3-6]\d\d(?!\d)/.test(s))) {
      var N = norm();
      return hm && N && typeof N.hijriToGregorian === 'function' ? (N.hijriToGregorian(hm[1] + '/' + hm[2] + '/' + hm[3]) || '') : '';
    }
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
  // "15/04/1448هـ الموافق 31/10/2026م": try every date-shaped match (the Hijri one is converted, Umm al-Qura)
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
      rx(['المنشأ', 'المنشا', 'Origin(?![A-Za-z])'])],      // "Origin", not "Number of original Bs/L"
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

    /* shipping data (B/L block + column layouts, invoice "Incoterms : EXW"): fills only the keys still empty */
    shippingFields(t, fields, docType);
    // B/L: a "Shipper   B/L No" label row made the name label read the next label; the block value is the name
    if (isBL) {
      [['supplier_name', 'shipper'], ['buyer_name', 'consignee']].forEach(function (p) {
        var cur = fields[p[0]], src = fields[p[1]];
        if (src && (!cur || isLabelOnly(cur.value, labelHits(cur.value)))) fields[p[0]] = F(src.value, 'medium');
      });
    }

    return { fields: fields, lineItems: items };
  }

  /* ---------------------------------------------------------------
     Shipping data (fields v2): typical bill-of-lading layouts read by
     Tesseract (preserve_interword_spaces keeps the column gaps):
       - block labels: "Shipper" / "Consignee" / "Notify" on their own line,
         the value on the next line(s) until the next label;
       - label rows: several labels on one line, the values on the next line
         in the same order ("Ocean Vessel / Voyage   Port of loading" →
         "MV PAPU / PAP0426E   ALIAGA"), split by 2+ spaces;
       - inline: "Port of loading: JEDDAH", "Incoterms : EXW".
     Only keys of FIELD_KEYS are produced. A label with key null only ends a block.
     --------------------------------------------------------------- */
  var SHIP_LABELS = [
    { key: 'vessel_voyage', re: /(?:ocean\s+)?vessel\s*(?:name\s*)?(?:\/|&|and)\s*voy(?:age)?(?:\s*no)?\.?|(?:السفينة|اسم\s*السفينة)\s*\/\s*(?:الرحلة|رقم\s*الرحلة)/i },
    { key: 'shipper', re: /\b(?:shipper|exporter|consignor)\b(?:\s*\/\s*exporter)?(?:\s*\(\s*(?:complete\s+)?name\s*(?:and|&)\s*address\s*\))?|الشاحن|المصدِّر/i, block: true },
    { key: 'consignee', re: /\bconsignee\b(?:\s*\(\s*(?:complete\s+)?name\s*(?:and|&)\s*address\s*\))?|المرسل\s*[اإ]ليه/i, block: true },
    { key: null, re: /\bnotify(?:\s+(?:party|address))?\b|\balso\s+notify\b|الطرف\s*المخطر/i, block: true },
    { key: 'vessel', re: /(?:ocean\s+)?\bvessel(?:\s*name)?\b|\bname\s+of\s+(?:ship|vessel)\b|اسم\s*السفينة|السفينة/i },
    { key: 'voyage', re: /\bvoy(?:age)?(?:\s*(?:no|number))?\b\.?|رقم\s*الرحلة|الرحلة/i },
    { key: 'port_of_loading', re: /\bport\s+of\s+(?:loading|lading|shipment)\b|\bloading\s+port\b|\bPOL\b|ميناء\s*(?:الشحن|التحميل)/i },
    { key: 'port_of_discharge', re: /\bport\s+of\s+(?:discharge|destination)\b|\bdischarge\s+port\b|\bPOD\b|ميناء\s*(?:التفريغ|الوصول)/i },
    { key: null, re: /\bplace\s+of\s+(?:receipt|delivery|issue)\b|\bfinal\s+destination\b|\bpre-?\s*carriage(?:\s+by)?\b|\bfreight\s+(?:payable|prepaid|collect|charges|and\s+charges)\b|\bnumber\s+of\s+original|\bmarks\s*(?:&|and)?\s*(?:nos?|numbers)?\b\.?|\bcontainer\s*(?:no|number|nos)?\b\.?(?:\s*\/\s*seal(?:\s*no)?\.?)?|\bseal\s*(?:no|number)?\b\.?|\bmeasurement\b|\bvolume\b|\bCBM\b|\bbooking\s*(?:no|number)?\b\.?|\bexport\s+references?\b|\bforwarding\s+agent\b|\bplace\s+and\s+date\s+of\s+issue\b/i },
    { key: 'bl_number', re: /\b(?:B\s*\/\s*L|bill\s+of\s+lading)\s*(?:no|number|#)\b\.?|رقم\s*البوليصة/i },
    { key: 'gross_weight', re: /\bgross\s*(?:weight|wt)\b\.?(?:\s*[,(]?\s*(?:in\s+)?kgs?\.?\s*\)?)?|\bG\.\s?W\.?(?=\s|:|$)|الوزن\s*(?:القائم|الإجمالي|الاجمالي)/i },
    { key: 'net_weight', re: /\bnet\s*(?:weight|wt)\b\.?(?:\s*[,(]?\s*(?:in\s+)?kgs?\.?\s*\)?)?|\bN\.\s?W\.?(?=\s|:|$)|الوزن\s*الصافي/i },
    { key: 'packages_count', re: /\b(?:no\.?|number|total)\s*(?:of|&)?\s*(?:pkgs|packages|packs|cartons|pallets)\b\.?|\bpackages\b|\bpkgs\b\.?|عدد\s*الطرود/i },
    { key: 'package_type', re: /\bkind\s+of\s+packages?\b|\btype\s+of\s+packages?\b|\bpackage\s+type\b|نوع\s*(?:الطرود|العبوات)/i },
    { key: 'goods_description', re: /\bdescription\s+of\s+(?:the\s+)?(?:goods|packages\s+and\s+goods|cargo)\b|\bgoods\s+description\b|\bdescription\b|وصف\s*البضاع[ةه]/i, block: true },
    { key: 'incoterms', re: /\bincoterms?(?:\s*20[12]0)?\b|\b(?:terms|conditions)\s+of\s+(?:delivery|sale)\b|\bdelivery\s+terms?\b|\btrade\s+terms?\b|شرط\s*التسليم|شروط\s*التسليم/i },
    { key: 'country_of_origin', re: /\bcountry\s+of\s+origin\b|\borigin\s+country\b|بلد\s*المنش[أا]/i }
  ];
  var PKG_RE = /(?:^|[^\w.,])(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(PALLETS?|PLTS?|CARTONS?|CTNS?|PACKAGES?|PKGS?|PACKS?|BAGS?|BOXES|BOX|DRUMS?|ROLLS?|BALES?|CRATES?|CASES?|BUNDLES?|SACKS?|CASKS?|TUBES?|COILS?|UNITS?|IBCS?|SKIDS?|طرود|طرد|كرتون|كراتين|طبالي|طبلية|أكياس|اكياس|كيس|صناديق|صندوق|براميل|برميل|لفات|بالات)(?![A-Za-z])/i;
  var NOT_PKG = /\b(?:ORIGINALS?|COP(?:Y|IES)|PAGES?|OF|SHEETS?|B\s*\/\s*L|BS\s*\/\s*L|FREIGHT|PAYABLE)\b|صفح|نسخ|أصل|اصل|من\s+\d/i;
  var INCO_RE = /\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DAT|DDP|DDU|C\s?&\s?F|CNF)\b/i;
  var WEIGHT_RE = /(\d[\d.,]*\d|\d)\s*(KGS?|KILOS?|KILOGRAMS?|K\.G\.?|MT|M\.T\.|TONS?|TONNES?|LBS?|كغ|كجم|كيلو(?:غرام|جرام)?|طن)?(?![A-Za-z])/i;

  // every label occurrence on a raw line: [{ def, start, end }] sorted, non-overlapping (longest first)
  function labelHits(line) {
    var hits = [];
    SHIP_LABELS.forEach(function (d) {
      var g = new RegExp(d.re.source, 'gi'), m;
      while ((m = g.exec(line))) {
        if (!m[0]) { g.lastIndex++; continue; }
        hits.push({ def: d, start: m.index, end: m.index + m[0].length });
      }
    });
    hits.sort(function (a, b) { return a.start - b.start || (b.end - b.start) - (a.end - a.start); });
    var out = [];
    hits.forEach(function (h) {
      var last = out[out.length - 1];
      if (last && h.start < last.end) return;
      out.push(h);
    });
    return out;
  }
  function segmentsOf(line) {   // column segments split by 2+ spaces or a "|" ruling
    var out = [], re = /[^\s|](?:[^|]*?[^\s|])??(?=\s{2,}|\s*\||\s*$)/g, m;
    while ((m = re.exec(line))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out.push({ text: m[0], start: m.index });
    }
    return out;
  }
  function isLabelOnly(line, hits) {
    if (!hits.length) return false;
    var rest = line, k;
    for (k = hits.length - 1; k >= 0; k--) rest = rest.slice(0, hits[k].start) + ' ' + rest.slice(hits[k].end);
    return rest.replace(/[\s:\-–—#.,،|\/\\()&]+/g, '').length <= 2;
  }
  // a label inside running text ("…description of the vessel…") is not a label: line start, after a column gap / "|", or after ":"
  function atBoundary(line, h) {
    var before = line.slice(0, h.start);
    return !before.trim() || /(\s{2,}|\||:\s*)$/.test(before);
  }
  function cleanVal(s) { return stripEdges(String(s || '').replace(/\s{2,}/g, ' ')).slice(0, 255); }

  function putShip(fields, key, value, conf) {
    if (!key || !value || fields[key]) return;
    if (FIELD_KEYS.indexOf(key) === -1) return;
    fields[key] = F(value, conf || 'medium');
  }
  // a weight needs a unit (kg / kgs / kilo / MT / tons / lbs …); without one only a cell that is just a number (the value
  // under a weight label column) is taken — "Number of original Bs/L 3", "Page 1 of 2", "3 ORIGINALS" are not weights
  function weightKg(s) {
    var str = String(s || '');
    var m = WEIGHT_RE.exec(str);
    if (!m) return '';
    if (!m[2] && !/^[\s(\[]*\d[\d.,\s]*[\s)\].:;]*$/.test(str)) return '';
    var n = parseAmount(m[1]);
    if (n == null || !(n > 0)) return '';
    var u = String(m[2] || '').toUpperCase();
    if (/^(MT|M\.T\.|TONS?|TONNES?|طن)$/.test(u)) n = n * 1000;
    else if (/^LBS?$/.test(u)) n = n * 0.45359237;
    return trimNum(n);
  }
  function setShipValue(fields, key, raw, conf, ctx) {
    var v = cleanVal(raw);
    if (!v) return;
    switch (key) {
      case 'vessel_voyage': {
        var slash = v.lastIndexOf('/');
        var left = slash > 0 ? v.slice(0, slash) : v, right = slash > 0 ? v.slice(slash + 1) : '';
        if (/^\s*V\.?\s*[A-Z]/i.test(right) && /M\s*$/i.test(left)) { left = v; right = ''; }      // "M/V NAME" without a voyage
        if (!right) {
          var mv = /^(.*?)\s+(?:V\.?|VOY\.?)?\s*([A-Z0-9-]*\d[A-Z0-9-]*)$/i.exec(v);
          if (mv) { left = mv[1]; right = mv[2]; }
        }
        left = cleanVal(left); right = (cleanVal(right).toUpperCase().split(/\s+/)[0] || '');   // a voyage is one token
        if (/[A-Za-z\u0600-\u06ff]{2,}/.test(left)) putShip(fields, 'vessel', left, conf);
        if (right && /\d/.test(right) && right.length <= 30) putShip(fields, 'voyage', right, conf);
        return;
      }
      case 'vessel':
        if (/[A-Za-z\u0600-\u06ff]{2,}/.test(v)) {
          var vv = /^(.*?)\s*\/\s*([A-Z0-9-]*\d[A-Z0-9-]*)$/i.exec(v);
          if (vv && !/M\s*$/i.test(vv[1])) { putShip(fields, 'vessel', cleanVal(vv[1]), conf); putShip(fields, 'voyage', vv[2].toUpperCase(), conf); }
          else putShip(fields, 'vessel', v, conf);
        }
        return;
      case 'voyage': {
        var t = exBl(v) || exId(v);
        if (t && t.length <= 30) putShip(fields, 'voyage', t, conf);
        return;
      }
      case 'bl_number': { var b = exBl(v); if (b) putShip(fields, 'bl_number', b, conf); return; }
      case 'gross_weight': case 'net_weight': { var w = weightKg(v); if (w) putShip(fields, key, w, conf); return; }
      case 'packages_count': {
        var pm = PKG_RE.exec(' ' + v);
        if (pm) { putShip(fields, 'packages_count', trimNum(parseAmount(pm[1])), conf); putShip(fields, 'package_type', pm[2].toUpperCase(), conf); return; }
        // a bare number: not a page number / copy count ("1 of 2", "3 ORIGINALS", "Page 2", "1/3")
        if (NOT_PKG.test(v) || /^\d+\s*\/\s*\d+$/.test(v)) return;
        var pn = /^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:\s|$)/.exec(v);
        if (pn) {
          putShip(fields, 'packages_count', trimNum(parseAmount(pn[1])), conf);
          var rest = cleanVal(v.slice(pn[0].length));
          if (rest && /^[A-Za-z\u0600-\u06ff]{3,20}$/.test(rest)) putShip(fields, 'package_type', rest.toUpperCase(), conf);
        }
        return;
      }
      case 'package_type':
        if (/^[A-Za-z\u0600-\u06ff .()-]{3,40}$/.test(v)) putShip(fields, 'package_type', v.toUpperCase(), conf);
        return;
      case 'incoterms': {
        var im = INCO_RE.exec(v);
        if (im) {
          var code = im[1].toUpperCase().replace(/\s/g, '');
          if (code === 'C&F' || code === 'CNF') code = 'CFR';
          var place = cleanVal(v.slice(im.index + im[0].length).replace(/^[\s,\-–]+/, '')).split(/\s{2,}|,|\(/)[0];
          putShip(fields, 'incoterms', code + (place && /^[A-Za-z][A-Za-z .'-]{2,30}$/.test(place) && !/^(incoterms?|20[12]0)$/i.test(place) ? ' ' + place.trim().toUpperCase() : ''), conf);
        }
        return;
      }
      case 'country_of_origin': {
        var c = normalizeCountry(v);
        if (c && /[A-Za-z\u0600-\u06ff]{2,}/.test(c)) putShip(fields, 'country_of_origin', c, isKnownCountry(c) ? 'high' : conf);
        return;
      }
      case 'goods_description':
        if (/[A-Za-z\u0600-\u06ff]{3,}/.test(v)) {
          // "19 PALLETS MEDICAL DRESSINGS" in one cell: the count goes to its own fields
          var gp = PKG_RE.exec(' ' + v);
          if (gp && gp.index <= 1) { setShipValue(fields, 'packages_count', gp[0], 'low'); v = cleanVal(v.slice(gp.index + gp[0].length - 1)); }
          v = cleanVal(v.replace(/^(?:S\.?\s?T\.?\s?C\.?|said\s+to\s+contain)\s*:?\s*/i, ''));
          if (v.length >= 3) putShip(fields, 'goods_description', v.slice(0, 255), conf);
        }
        return;
      case 'shipper': case 'consignee':
        if (/[A-Za-z\u0600-\u06ff]{2,}/.test(v) && !/^(?:to\s+order\s+of\s*:?)$/i.test(v)) putShip(fields, key, v.replace(NAME_STOP, '').trim() || v, conf);
        return;
      default:
        if (/[A-Za-z\u0600-\u06ff]{2,}/.test(v)) putShip(fields, key, v, conf);
    }
  }

  // "Gross weight (in KGS): 18,250" on one line: only separators / the unit between the label and the number (another
  // label in between — "Gross weight  Number of original Bs/L 3" — is not this value), and the number ends the cell
  function WEIGHT_FALLBACK(kind) {
    var lbl = kind === 'gross' ? '\\bgross\\s*(?:weight|wt)|\\bG\\.\\s?W\\.?' : '\\bnet\\s*(?:weight|wt)|\\bN\\.\\s?W\\.?';
    return new RegExp('(?:' + lbl + ')[ \\t]*(?:[,(\\[]?[ \\t]*(?:in[ \\t]+)?(?:kgs?|kilos?|kilograms?)\\.?[ \\t]*[)\\]]?)?[ \\t:.\\-–=]{0,6}' +
      '(\\d[\\d.,]*(?:[ \\t]*(?:KGS?|KILOS?|KILOGRAMS?|MT|TONS?|TONNES?|LBS?)\\b)?)(?![\\d.,])', 'ig');
  }
  // the first fallback match whose number has a unit, or ends its cell (line end / a column gap)
  function weightFallback(joined, kind) {
    var re = WEIGHT_FALLBACK(kind), m;
    while ((m = re.exec(joined))) {
      if (/[A-Za-z]/.test(m[1])) return m[1];
      var after = joined.slice(m.index + m[0].length);
      if (/^(?:[ \t]*$|[ \t]*\n|[ \t]{2,}|[ \t]*\|)/.test(after)) return m[1];
    }
    return '';
  }
  function shippingFields(t, fields, docType) {
    var raw = String(t || '').split('\n').map(function (l) { return l.replace(/\s+$/, ''); });
    var isBL = docType === 'bill_of_lading';
    var info = raw.map(function (l) { var h = labelHits(l); return { line: l, hits: h, labelOnly: isLabelOnly(l, h) }; });
    // value lines after line i: skip blank lines (at most 2), stop at a label line
    function nextValueLine(i) {
      for (var k = i + 1, blank = 0; k < info.length && k <= i + 4; k++) {
        if (!info[k].line.trim()) { if (++blank > 2) return -1; continue; }
        if (info[k].labelOnly) return -1;
        if (info[k].hits.length && atBoundary(info[k].line, info[k].hits[0]) && info[k].hits[0].start === info[k].line.search(/\S/)) return -1;
        return k;
      }
      return -1;
    }
    function blockLines(k, max) {      // a block value: k and the following lines until a blank / label line
      var out = [info[k].line.trim()];
      for (var n = k + 1; n < info.length && out.length < max; n++) {
        var x = info[n];
        if (!x.line.trim() || x.labelOnly || (x.hits.length && atBoundary(x.line, x.hits[0]))) break;
        out.push(x.line.trim());
      }
      return out;
    }
    info.forEach(function (row, i) {
      if (!row.hits.length) return;
      var hits = row.labelOnly ? row.hits : row.hits.filter(function (h) { return atBoundary(row.line, h); });
      if (!hits.length) return;
      var needing = [];
      hits.forEach(function (h, n) {
        var end = n + 1 < hits.length ? hits[n + 1].start : row.line.length;
        var inline = row.line.slice(h.end, end);
        if (inline.replace(/[\s:\-–—#.,،|\/\\()]+/g, '').length) {
          if (!h.def.key) return;
          var cellVal = /\s{2,}/.test(inline.trim()) && !/^\s*:/.test(inline) ? inline.trim().split(/\s{2,}/)[0] : inline;
          setShipValue(fields, h.def.key, cellVal, 'medium');
        } else needing.push(h);
      });
      if (!needing.length || !needing.some(function (h) { return h.def.key; })) return;
      var k = nextValueLine(i);
      if (k < 0) return;
      var segs = segmentsOf(info[k].line);
      if (!segs.length) return;
      var pick = function (h) {
        if (needing.length === 1 && hits.length === 1 && segs.length > 1 && h.start <= 2) return segs[0];
        // value cells in label order only when every label of the row waits for a value; otherwise by column
        if (segs.length === needing.length && needing.length === hits.length) return segs[needing.indexOf(h)];
        // one value cell under a row of several labels belongs to the label of its column, never to the only empty one
        // ("Number of original Bs/L     Gross Weight" → "3" is the originals count, not a weight)
        if (needing.length === 1 && segs.length === 1 && hits.length === 1) return segs[0];
        // by column: the value cell whose start is nearest the label start
        var best = null, bd = 1e9;
        segs.forEach(function (s) { var d = Math.abs(s.start - h.start); if (d < bd) { bd = d; best = s; } });
        return bd <= 12 ? best : null;
      };
      needing.forEach(function (h) {
        if (!h.def.key) return;
        var s = pick(h);
        if (!s) return;
        // a cell that starts with a label is a label, not a value ("Number of original Bs/L 3", "Freight payable at")
        var sh = labelHits(s.text);
        if (sh.length && sh[0].start <= 1) return;
        if (h.def.key === 'goods_description' && segs.length === 1) {
          setShipValue(fields, 'goods_description', blockLines(k, 4).join(' '), 'medium');
          return;
        }
        // a block party value is only the first line (the name); the address lines follow
        setShipValue(fields, h.def.key, s.text, h.def.block || needing.length > 1 ? 'medium' : 'medium');
      });
    });

    /* fallbacks on the whole text (low confidence): packages, gross weight, incoterms, "SAID TO CONTAIN" */
    var joined = raw.join('\n');
    if (!fields.packages_count) {
      var best = null;
      raw.forEach(function (l) {
        if (best) return;
        var m = PKG_RE.exec(' ' + l);
        if (m && !/^(UNITS?)$/i.test(m[2]) && (isBL || /\btotal\b|اجمالي|إجمالي|المجموع/i.test(l) || /PALLET|CARTON|CTN|PKG|PACKAGE/i.test(m[2]))) best = m;
      });
      if (best) { putShip(fields, 'packages_count', trimNum(parseAmount(best[1])), 'low'); putShip(fields, 'package_type', best[2].toUpperCase(), 'low'); }
    }
    if (!fields.gross_weight) {
      var gw = weightFallback(joined, 'gross');
      if (gw) { var g = weightKg(gw); if (g) putShip(fields, 'gross_weight', g, 'low'); }
    }
    if (!fields.net_weight) {
      var nw = weightFallback(joined, 'net');
      if (nw) { var nn = weightKg(nw); if (nn) putShip(fields, 'net_weight', nn, 'low'); }
    }
    if (!fields.incoterms) {
      var ic = /\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\s+([A-Z][A-Z]{2,}(?:\s[A-Z]{3,})?)\b/.exec(joined);
      if (ic) putShip(fields, 'incoterms', ic[1] + ' ' + ic[2], 'low');
    }
    if (!fields.goods_description) {
      var stc = /(?:\bS\.\s?T\.\s?C\.?|\bsaid\s+to\s+contain)\s*:?\s*([^\n]{3,200})/i.exec(joined);
      if (stc) setShipValue(fields, 'goods_description', stc[1], 'low');
    }
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
  function plainFields(fields, keys) {
    var out = {}, allow = Array.isArray(keys) ? keys : FIELD_KEYS;
    Object.keys(fields || {}).forEach(function (k) {
      if (allow.indexOf(k) === -1) return;
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
    FIELD_KEYS: FIELD_KEYS, DB_FIELD_KEYS: DB_FIELD_KEYS,
    normalizeDigits: normalizeDigits, parseAmount: parseAmount, formatAmount: formatAmount, normalizeDate: normalizeDate,
    isValidSaudiVat: isValidSaudiVat, isValidContainer: isValidContainer, containerCheckDigit: containerCheckDigit,
    isValidIban: isValidIban, normalizeCountry: normalizeCountry,
    decodeZatcaQr: decodeZatcaQr, extractFields: extractFields, mergeQr: mergeQr, plainFields: plainFields,
    detectCurrency: detectCurrency, parseItemLine: parseItemLine,
    safeCell: safeCell, toDelimited: toDelimited
  };
});
