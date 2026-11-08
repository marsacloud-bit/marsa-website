/* ==========================================================================
   مرسى | MARSA — document matching engine (invoice ↔ B/L ↔ customs declaration)
   Pure, deterministic, no DOM. UMD: window.MarsaDocMatch + module.exports.
   Contract: SPEC.md §2 + ADDENDUM (three-way match). Version 'match-v1'.

   compare({invoice:{fields, items}, bl:{fields, items}, declaration?:{fields, items}})
     → { version, mode: 'two_way'|'three_way', rows: [...], items: {...},
         counts: {match, mismatch, partial, missing}, overall: 'match'|'mismatch'|'review' }

   fields = { key: {value, score?} } (a plain string value is accepted too);
   items  = [{description, hs_code, quantity, unit_price, amount}].

   Row = { key, label_ar, label_en, values: {invoice, bl, declaration}, status, detail_ar, detail_en,
           critical, conf: {invoice, bl, declaration}, pairs: {inv_bl, inv_decl, bl_decl}, src: {invoice, bl, declaration} }
     status: match | mismatch | partial | missing | info ('info' is never counted)
     pairs:  match | mismatch | partial | missing | null (document not uploaded / neither side has a value)
     src:    the extraction field key each value came from (a reviewer correction is written back there)
   A document that was not uploaded has value undefined. A row with no value at all is omitted.
   Each field has "expected" documents (they normally carry it) and "optional" ones (used when present):
   one value only → 'missing' when an expected document lacks it, else 'info'; several values that all agree
   but an expected document lacks it → 'missing' too (nothing proves that document agrees).
   overall: a critical row 'mismatch' → 'mismatch'; else a critical row partial / missing, or any mismatch → 'review';
   else 'match'.
   ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.MarsaDocMatch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'match-v1';
  var DOCS = ['invoice', 'bl', 'declaration'];
  var DOC_AR = { invoice: 'الفاتورة', bl: 'البوليصة', declaration: 'البيان' };
  var DOC_EN = { invoice: 'the invoice', bl: 'the B/L', declaration: 'the declaration' };
  var PAIRS = [['inv_bl', 'invoice', 'bl'], ['inv_decl', 'invoice', 'declaration'], ['bl_decl', 'bl', 'declaration']];
  var RANK = { match: 0, partial: 1, mismatch: 2 };

  /* ------------------------------------------------------------------
     Text helpers
     ------------------------------------------------------------------ */
  function str(v) {
    if (v == null) return '';
    if (typeof v === 'object') {
      if (Object.prototype.hasOwnProperty.call(v, 'value')) return str(v.value);
      return '';
    }
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return '';
    return String(v).replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  }
  function digitsLatin(s) {
    return String(s).replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); })
      .replace(/٫/g, '.').replace(/٬/g, ',');
  }
  var LATIN_FOLD = { 'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a', 'æ': 'ae', 'ç': 'c', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
    'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ñ': 'n', 'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ø': 'o', 'ù': 'u', 'ú': 'u',
    'û': 'u', 'ü': 'u', 'ý': 'y', 'ÿ': 'y', 'ß': 'ss', 'ş': 's', 'ğ': 'g', 'ı': 'i', 'İ': 'i', 'œ': 'oe' };
  function fold(s) {
    s = digitsLatin(str(s)).toLowerCase();
    if (typeof s.normalize === 'function') s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    s = s.replace(/[^\u0000-\u007F]/g, function (c) { return LATIN_FOLD[c] || c; });
    // Arabic: alef forms → ا, ة → ه, ى → ي, ؤ → و, ئ → ي; tashkeel + tatweel removed
    s = s.replace(/[آأإٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/[ً-ٰٟـ]/g, '');
    return s;
  }
  // words (letters / digits, Latin + Arabic); everything else is a separator
  function words(s) {
    return fold(s).replace(/[^a-z0-9ء-ي]+/g, ' ').trim().split(' ').filter(Boolean);
  }
  function uniq(list) {
    var seen = {}, out = [];
    list.forEach(function (x) { if (!Object.prototype.hasOwnProperty.call(seen, x)) { seen[x] = 1; out.push(x); } });
    return out;
  }
  function jaccard(a, b) {
    a = uniq(a); b = uniq(b);
    if (!a.length && !b.length) return 1;
    var inter = a.filter(function (x) { return b.indexOf(x) !== -1; }).length;
    return inter / (a.length + b.length - inter);
  }
  function overlap(a, b) {   // overlap coefficient: |A∩B| / min(|A|, |B|)
    a = uniq(a); b = uniq(b);
    if (!a.length || !b.length) return 0;
    var inter = a.filter(function (x) { return b.indexOf(x) !== -1; }).length;
    return inter / Math.min(a.length, b.length);
  }

  /* ------------------------------------------------------------------
     Names (shipper / consignee / supplier / buyer)
     ------------------------------------------------------------------ */
  var LEGAL = ['co', 'company', 'companies', 'ltd', 'limited', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'trading', 'est',
    'establishment', 'plc', 'gmbh', 'ag', 'sa', 'srl', 'spa', 'bv', 'pvt', 'pte', 'pty', 'jsc', 'fze', 'fzco', 'fzc', 'llp', 'lp', 'the',
    'and', 'group', 'intl', 'international', 'imp', 'exp', 'import', 'export', 'industrial', 'industry', 'industries', 'mfg',
    'manufacturing', 'wll', 'spc', 'ksa', 'cjsc', 'ojsc', 'kg', 'oy', 'ab', 'as', 'nv', 'ltda', 'sarl', 'sdn', 'bhd', 'tbk', 'kk',
    // Arabic: company / establishment / limited / LLC / for trading …
    'شركه', 'مؤسسه', 'المحدوده', 'محدوده', 'ذمم', 'ذ', 'م', 'مساهمه', 'مقفله', 'للتجاره', 'التجاريه', 'تجاريه', 'التجاره', 'تجاره',
    'و', 'شركاه', 'شركاؤه', 'مجموعه', 'للاستيراد', 'والتصدير', 'الاستيراد', 'التصدير', 'العالميه', 'الدوليه', 'المحدودة', 'فرع'];
  LEGAL = LEGAL.map(function (x) { return fold(x); });
  function script(s) {
    var t = fold(s), ar = (t.match(/[\u0621-\u064A]/g) || []).length, la = (t.match(/[a-z]/g) || []).length;
    return ar && !la ? 'ar' : (la && !ar ? 'latin' : (ar || la ? 'mixed' : ''));
  }
  function normName(s) {
    var t = fold(s)
      .replace(/\b(co|corp|inc|ltd|est|mfg|intl|pvt|pte|pty)\./g, '$1 ')
      .replace(/ذ\s*\.?\s*م\s*\.?\s*م/g, ' ذمم ')
      .replace(/\b[a-z](\.[a-z])+\.?/g, function (m) { return m.replace(/\./g, ''); });   // L.L.C. → llc, W.L.L → wll
    var w = words(t).filter(function (x) { return LEGAL.indexOf(x) === -1; });
    // Arabic definite article on a lone word: "الشمس" ~ "شمس"
    w = w.map(function (x) { return /^ال[ء-ي]{2,}/.test(x) ? x.slice(2) : x; });
    return w.join(' ');
  }
  function cmpName(a, b) {
    var na = normName(a), nb = normName(b);
    if (!na || !nb) {   // only legal words: compare the folded text
      return fold(a).replace(/\W+/g, '') === fold(b).replace(/\W+/g, '') ? { s: 'match' } : { s: 'mismatch' };
    }
    if (na === nb) return { s: 'match' };
    var ca = na.replace(/ /g, ''), cb = nb.replace(/ /g, '');
    if (ca === cb) return { s: 'match' };
    if ((ca.length >= 4 && cb.indexOf(ca) !== -1) || (cb.length >= 4 && ca.indexOf(cb) !== -1)) return { s: 'partial', why: 'contains' };
    if (jaccard(na.split(' '), nb.split(' ')) >= 0.6) return { s: 'partial', why: 'similar' };
    // one name in Arabic, the other in Latin letters: cannot be decided here — the reviewer checks it
    var sa = script(a), sb = script(b);
    if ((sa === 'ar' && sb === 'latin') || (sa === 'latin' && sb === 'ar')) return { s: 'partial', why: 'script' };
    return { s: 'mismatch' };
  }

  /* ------------------------------------------------------------------
     Identifiers (invoice / B/L / declaration numbers, vessel)
     ------------------------------------------------------------------ */
  function normId(s) {
    // a printed label with a separator ("No. 123", "B/L No: X1", "#55") is dropped; "INV-001" stays as it is
    return digitsLatin(str(s)).toUpperCase().replace(/^(?:(?:INVOICE|INV|B\/L|BL|DECLARATION)\s*)?(?:NO|NUMBER|NUM)?\s*[.:#]+\s*/, '')
      .replace(/[^A-Z0-9ء-ي]+/g, '');
  }
  function cmpId(a, b) {
    var x = normId(a), y = normId(b);
    if (!x || !y) return { s: 'mismatch' };
    if (x === y) return { s: 'match' };
    var lx = x.replace(/^0+/, ''), ly = y.replace(/^0+/, '');
    if (lx && lx === ly) return { s: 'match' };
    // a carrier prefix (MEDU1234567 vs 1234567) or a suffix (-01): the shorter one is part of the longer one
    var short = x.length <= y.length ? x : y, long = x.length <= y.length ? y : x;
    if (short.length >= 5 && (long.slice(-short.length) === short || long.slice(0, short.length) === short)) return { s: 'partial', why: 'prefix' };
    return { s: 'mismatch' };
  }
  function normVessel(s) {
    var t = fold(s).toUpperCase();
    // a voyage written after the name ("MSC ANNA / 234E", "V.234E", "VOY 12W") is dropped first
    t = t.replace(/\s*(\/|\bVOY(AGE)?\b\.?|\bV\.|\bV\b)\s*(NO\.?)?\s*[A-Z0-9-]*\d[A-Z0-9-]*\s*$/, ' ');
    t = t.replace(/(^|\s)(M\s*\/\s*V|M\s*\.\s*V\.?|MV|M\/S|MS|S\s*\/\s*S|SS|M\/T|MT|VESSEL)(?=\s|\.|$)\.?/g, ' ');
    return t.replace(/[^A-Z0-9ء-ي]+/g, ' ').trim();
  }
  function cmpVessel(a, b) {
    var x = normVessel(a), y = normVessel(b);
    if (!x || !y) return { s: 'mismatch' };
    if (x === y || x.replace(/ /g, '') === y.replace(/ /g, '')) return { s: 'match' };
    var cx = x.replace(/ /g, ''), cy = y.replace(/ /g, '');
    if ((cx.length >= 4 && cy.indexOf(cx) !== -1) || (cy.length >= 4 && cx.indexOf(cy) !== -1)) return { s: 'partial', why: 'contains' };
    if (jaccard(x.split(' '), y.split(' ')) >= 0.6) return { s: 'partial', why: 'similar' };
    return { s: 'mismatch' };
  }

  /* ------------------------------------------------------------------
     Containers (ISO 6346)
     ------------------------------------------------------------------ */
  function iso6346Valid(c) {
    if (!/^[A-Z]{3}[UJZR]\d{7}$/.test(c)) return false;
    var map = {}, v = 10;
    for (var i = 0; i < 26; i++) {
      var ch = String.fromCharCode(65 + i);
      if (v % 11 === 0) v++;
      map[ch] = v; v++;
    }
    var sum = 0;
    for (var k = 0; k < 10; k++) {
      var ck = c.charAt(k);
      sum += (/\d/.test(ck) ? Number(ck) : map[ck]) * Math.pow(2, k);
    }
    return (sum % 11) % 10 === Number(c.charAt(10));
  }
  // "MSCU 123456-5, TGHU1234567/40HC" → ['MSCU1234565', 'TGHU1234567'] (sorted, unique)
  function containerSet(v) {
    var s = digitsLatin(str(v)).toUpperCase();
    var out = [];
    var re = /([A-Z]{3}[UJZR])[\s.\-]*(\d{6})[\s.\-\/]*(\d)(?!\d)/g, m;
    while ((m = re.exec(s))) out.push(m[1] + m[2] + m[3]);
    if (!out.length) {
      s.split(/[,;\n\/]+|\s{2,}/).forEach(function (p) {
        var c = p.replace(/[^A-Z0-9]/g, '');
        if (c.length >= 8 && c.length <= 13) out.push(c);
      });
    }
    return uniq(out).sort();
  }
  function cmpContainers(a, b) {
    var x = containerSet(a), y = containerSet(b);
    if (!x.length || !y.length) return { s: 'mismatch', onlyA: x, onlyB: y };
    var onlyA = x.filter(function (c) { return y.indexOf(c) === -1; });
    var onlyB = y.filter(function (c) { return x.indexOf(c) === -1; });
    if (!onlyA.length && !onlyB.length) return { s: 'match' };
    var common = x.length - onlyA.length;
    return { s: common > 0 ? 'partial' : 'mismatch', onlyA: onlyA, onlyB: onlyB };
  }

  /* ------------------------------------------------------------------
     HS codes (first 6 digits)
     ------------------------------------------------------------------ */
  function hs6Set(v) {
    var out = [];
    digitsLatin(str(v)).split(/[,;\s\/|]+/).forEach(function (p) {
      var d = p.replace(/[^0-9]/g, '');
      if (d.length >= 6) out.push(d.slice(0, 6));
      else if (d.length === 4) out.push(d);   // heading only
    });
    return uniq(out).sort();
  }
  function hsEq(a, b) { return a === b || (a.length === 4 && b.slice(0, 4) === a) || (b.length === 4 && a.slice(0, 4) === b); }
  function cmpHs(a, b) {
    var x = hs6Set(a), y = hs6Set(b);
    if (!x.length || !y.length) return { s: 'mismatch', onlyA: x, onlyB: y };
    var onlyA = x.filter(function (c) { return !y.some(function (d) { return hsEq(c, d); }); });
    var onlyB = y.filter(function (c) { return !x.some(function (d) { return hsEq(c, d); }); });
    var exact = x.length === y.length && x.every(function (c, i) { return c === y[i]; });
    if (!onlyA.length && !onlyB.length) return exact ? { s: 'match' } : { s: 'partial', why: 'heading', onlyA: [], onlyB: [] };
    var common = x.some(function (c) { return y.some(function (d) { return hsEq(c, d); }); });
    return { s: common ? 'partial' : 'mismatch', onlyA: onlyA, onlyB: onlyB };
  }

  /* ------------------------------------------------------------------
     Numbers, weights, packages
     ------------------------------------------------------------------ */
  // "12,500.50" "12.500,50" "12 500" "١٢٫٥" → number; null when there is no number
  function parseNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = digitsLatin(str(v)).replace(/ | /g, ' ');
    var m = s.match(/-?\d[\d\s.,']*/);
    if (!m) return null;
    var t = m[0].replace(/[\s']+/g, '').replace(/[.,]+$/, '');
    var neg = t.charAt(0) === '-'; if (neg) t = t.slice(1);
    var lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
    if (lastDot !== -1 && lastComma !== -1) {
      if (lastDot > lastComma) t = t.replace(/,/g, '');
      else t = t.replace(/\./g, '').replace(',', '.');
    } else if (lastComma !== -1) {
      t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(/,/g, '.');
      if ((t.match(/\./g) || []).length > 1) t = t.replace(/\./g, '');
    } else if ((t.match(/\./g) || []).length > 1) {
      t = t.replace(/\./g, '');   // 1.234.567
    }
    var n = Number(t);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }
  // weight in kg; "12.5 MT" / "TONS" → ×1000, "LBS" → ×0.45359237, "G" → ÷1000
  function parseWeight(v) {
    if (typeof v === 'number') return isFinite(v) && v >= 0 ? v : null;
    var s = fold(v);
    var n = parseNum(s);
    if (n == null || n < 0) return null;
    if (/\b(mt|mts|t|ton|tons|tonne|tonnes|metric ton)\b|طن/.test(s) && !/\bkg|كجم|كغ|كيلو/.test(s)) n = n * 1000;
    else if (/\b(lb|lbs|pound|pounds)\b|رطل/.test(s)) n = n * 0.45359237;
    else if (/\d\s*(g|gr|grams?)\b|جرام|غرام/.test(s) && !/\bkg|كجم|كغ|كيلو/.test(s)) n = n / 1000;
    return Math.round(n * 1000) / 1000;
  }
  // |a-b| ≤ max(abs, rel × max(|a|,|b|))
  function numClose(a, b, absTol, relTol) {
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) return false;
    var tol = Math.max(absTol == null ? 0 : absTol, (relTol == null ? 0 : relTol) * Math.max(Math.abs(a), Math.abs(b)));
    return Math.abs(a - b) <= tol + 1e-9;
  }
  function fmtNum(n) {
    if (n == null) return '';
    var r = Math.round(n * 1000) / 1000;
    var p = String(r).split('.');
    return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (p[1] ? '.' + p[1] : '');
  }
  function cmpWeight(a, b) {
    var x = parseWeight(a), y = parseWeight(b);
    if (x == null || y == null) return { s: 'mismatch', why: 'nan' };
    if (numClose(x, y, 1, 0.005)) return { s: 'match', x: x, y: y };
    return { s: 'mismatch', x: x, y: y, diff: Math.round(Math.abs(x - y) * 1000) / 1000 };
  }
  function parseCount(v) {
    var n = parseNum(v);
    return n == null || n < 0 ? null : n;
  }
  function cmpCount(a, b) {
    var x = parseCount(a), y = parseCount(b);
    if (x == null || y == null) return { s: 'mismatch', why: 'nan' };
    return Math.abs(x - y) < 1e-9 ? { s: 'match' } : { s: 'mismatch', x: x, y: y, diff: Math.abs(x - y) };
  }
  var PKG = [
    ['CTN', ['ctn', 'ctns', 'carton', 'cartons', 'cartoon', 'cartoons', 'ct', 'cts', 'كرتون', 'كراتين', 'كرتونه', 'كرتونات']],
    ['PLT', ['plt', 'plts', 'pallet', 'pallets', 'pal', 'pals', 'pk', 'طبليه', 'طبالي', 'منصه', 'منصات', 'بالته', 'بالتات']],
    ['BAG', ['bag', 'bags', 'bg', 'bgs', 'sack', 'sacks', 'كيس', 'اكياس', 'شوال', 'شوالات']],
    ['BOX', ['box', 'boxes', 'bx', 'bxs', 'صندوق', 'صناديق']],
    ['CASE', ['case', 'cases', 'cs', 'cse', 'wooden case', 'wooden cases', 'crate', 'crates', 'صندوق خشبي', 'صناديق خشبيه']],
    ['DRUM', ['drum', 'drums', 'dr', 'drs', 'برميل', 'براميل']],
    ['ROLL', ['roll', 'rolls', 'rl', 'rls', 'لفه', 'لفات']],
    ['BALE', ['bale', 'bales', 'bl', 'bls', 'باله', 'بالات']],
    ['PCS', ['pc', 'pcs', 'piece', 'pieces', 'pce', 'قطعه', 'قطع']],
    ['PKG', ['pkg', 'pkgs', 'package', 'packages', 'pack', 'packs', 'طرد', 'طرود']],
    ['BUNDLE', ['bundle', 'bundles', 'bdl', 'bdls', 'حزمه', 'حزم']],
    ['UNIT', ['unit', 'units', 'وحده', 'وحدات']],
    ['IBC', ['ibc', 'ibcs', 'tote', 'totes']],
    ['BULK', ['bulk', 'سائب', 'صب']],
    ['CONTAINER', ['container', 'containers', 'cntr', 'cntrs', 'حاويه', 'حاويات']]
  ];
  function normPackageType(v) {
    var w = words(v).filter(function (x) { return !/^\d+$/.test(x) && ['x', 'of', 'in', 'only', 'said', 'to', 'contain', 'stc'].indexOf(x) === -1; });
    var t = w.join(' ');
    if (!t) return '';
    for (var i = 0; i < PKG.length; i++) if (PKG[i][1].indexOf(t) !== -1) return PKG[i][0];
    for (var j = 0; j < w.length; j++) for (var k = 0; k < PKG.length; k++) if (PKG[k][1].indexOf(w[j]) !== -1) return PKG[k][0];
    return t.toUpperCase();
  }
  function cmpPackageType(a, b) {
    var x = normPackageType(a), y = normPackageType(b);
    if (!x || !y) return { s: 'mismatch' };
    return x === y ? { s: 'match' } : { s: 'mismatch' };
  }

  /* ------------------------------------------------------------------
     Countries, ports, currencies, incoterms, dates
     ------------------------------------------------------------------ */
  var COUNTRIES = [
    ['CN', ['china', 'cn', 'chn', 'prc', 'peoples republic of china', 'people s republic of china', 'pr china', 'p r china', 'made in china', 'الصين', 'صين', 'جمهوريه الصين الشعبيه']],
    ['SA', ['saudi arabia', 'sa', 'sau', 'ksa', 'kingdom of saudi arabia', 'saudi', 'السعوديه', 'المملكه العربيه السعوديه', 'سعوديه']],
    ['AE', ['united arab emirates', 'uae', 'ae', 'are', 'u a e', 'emirates', 'الامارات', 'الامارات العربيه المتحده', 'امارات']],
    ['IN', ['india', 'in', 'ind', 'republic of india', 'الهند', 'هند']],
    ['TR', ['turkey', 'turkiye', 'tr', 'tur', 'republic of turkey', 'تركيا']],
    ['EG', ['egypt', 'eg', 'egy', 'arab republic of egypt', 'مصر', 'جمهوريه مصر العربيه']],
    ['US', ['united states', 'united states of america', 'usa', 'us', 'u s a', 'america', 'الولايات المتحده', 'الولايات المتحده الامريكيه', 'امريكا']],
    ['DE', ['germany', 'de', 'deu', 'federal republic of germany', 'المانيا']],
    ['IT', ['italy', 'it', 'ita', 'ايطاليا']],
    ['JP', ['japan', 'jp', 'jpn', 'اليابان']],
    ['KR', ['south korea', 'korea', 'republic of korea', 'kr', 'kor', 'korea republic of', 'كوريا', 'كوريا الجنوبيه']],
    ['VN', ['vietnam', 'viet nam', 'vn', 'vnm', 'فيتنام']],
    ['TH', ['thailand', 'th', 'tha', 'تايلاند']],
    ['MY', ['malaysia', 'my', 'mys', 'ماليزيا']],
    ['ID', ['indonesia', 'id', 'idn', 'اندونيسيا']],
    ['PK', ['pakistan', 'pk', 'pak', 'باكستان']],
    ['BD', ['bangladesh', 'bd', 'bgd', 'بنغلاديش']],
    ['GB', ['united kingdom', 'uk', 'gb', 'gbr', 'great britain', 'england', 'britain', 'المملكه المتحده', 'بريطانيا']],
    ['FR', ['france', 'fr', 'fra', 'فرنسا']],
    ['ES', ['spain', 'es', 'esp', 'اسبانيا']],
    ['NL', ['netherlands', 'the netherlands', 'holland', 'nl', 'nld', 'هولندا']],
    ['BR', ['brazil', 'br', 'bra', 'البرازيل']],
    ['JO', ['jordan', 'jo', 'jor', 'الاردن']],
    ['OM', ['oman', 'om', 'omn', 'عمان', 'سلطنه عمان']],
    ['KW', ['kuwait', 'kw', 'kwt', 'الكويت']],
    ['BH', ['bahrain', 'bh', 'bhr', 'البحرين']],
    ['QA', ['qatar', 'qa', 'qat', 'قطر']],
    ['TW', ['taiwan', 'tw', 'twn', 'chinese taipei', 'تايوان']],
    ['HK', ['hong kong', 'hk', 'hkg', 'هونغ كونغ', 'هونج كونج']],
    ['SG', ['singapore', 'sg', 'sgp', 'سنغافوره']],
    ['LK', ['sri lanka', 'lk', 'lka', 'سريلانكا']],
    ['ZA', ['south africa', 'za', 'zaf', 'جنوب افريقيا']],
    ['AU', ['australia', 'au', 'aus', 'استراليا']],
    ['CA', ['canada', 'ca', 'can', 'كندا']],
    ['MX', ['mexico', 'mx', 'mex', 'المكسيك']],
    ['RU', ['russia', 'russian federation', 'ru', 'rus', 'روسيا']],
    ['PL', ['poland', 'pl', 'pol', 'بولندا']],
    ['PT', ['portugal', 'pt', 'prt', 'البرتغال']],
    ['BE', ['belgium', 'be', 'bel', 'بلجيكا']],
    ['CH', ['switzerland', 'ch', 'che', 'سويسرا']],
    ['SE', ['sweden', 'se', 'swe', 'السويد']],
    ['MA', ['morocco', 'ma', 'mar', 'المغرب']],
    ['TN', ['tunisia', 'tn', 'tun', 'تونس']],
    ['LB', ['lebanon', 'lb', 'lbn', 'لبنان']],
    ['SD', ['sudan', 'sd', 'sdn', 'السودان']],
    ['YE', ['yemen', 'ye', 'yem', 'اليمن']],
    ['IQ', ['iraq', 'iq', 'irq', 'العراق']],
    ['IR', ['iran', 'ir', 'irn', 'ايران']],
    ['PH', ['philippines', 'ph', 'phl', 'الفلبين']],
    ['NZ', ['new zealand', 'nz', 'nzl', 'نيوزيلندا']],
    ['AR', ['argentina', 'ar', 'arg', 'الارجنتين']],
    ['UA', ['ukraine', 'ua', 'ukr', 'اوكرانيا']]
  ];
  function normCountry(v) {
    var t = words(v).filter(function (x) { return ['made', 'in', 'origin', 'country', 'of', 'the', 'منشا', 'بلد', 'صنع', 'في'].indexOf(x) === -1 || false; }).join(' ');
    var full = words(v).join(' ');
    for (var i = 0; i < COUNTRIES.length; i++) {
      var al = COUNTRIES[i][1];
      if (al.indexOf(full) !== -1 || al.indexOf(t) !== -1) return COUNTRIES[i][0];
      if (al.indexOf(t.replace(/^ال/, '')) !== -1) return COUNTRIES[i][0];
    }
    // "SHANGHAI, CHINA": the last word(s)
    var w = t.split(' ');
    for (var n = Math.min(3, w.length); n >= 1; n--) {
      var tail = w.slice(-n).join(' ');
      for (var k = 0; k < COUNTRIES.length; k++) if (tail.length > 2 && COUNTRIES[k][1].indexOf(tail) !== -1) return COUNTRIES[k][0];
    }
    return t.toUpperCase();
  }
  function cmpCountry(a, b) {
    var x = normCountry(a), y = normCountry(b);
    if (!x || !y) return { s: 'mismatch' };
    return x === y ? { s: 'match' } : { s: 'mismatch' };
  }

  var PORTS = [
    ['SAJED', ['jeddah', 'jed', 'sajed', 'jiddah', 'jedda', 'jeddah islamic port', 'jeddah islamic', 'jip', 'جده', 'ميناء جده الاسلامي', 'جده الاسلامي']],
    ['SADMM', ['dammam', 'dmm', 'sadmm', 'king abdulaziz port', 'king abdul aziz port', 'king abdulaziz', 'king abdul aziz', 'dammam king abdulaziz',
      'الدمام', 'ميناء الملك عبدالعزيز', 'الملك عبدالعزيز', 'الملك عبد العزيز']],
    ['SARUH', ['riyadh', 'ruh', 'saruh', 'riyadh dry port', 'riyadh dryport', 'dry port riyadh', 'الرياض', 'الميناء الجاف', 'ميناء الرياض الجاف', 'الرياض الجاف']],
    ['SAJUB', ['jubail', 'jub', 'sajub', 'king fahad industrial port', 'jubail commercial port', 'الجبيل']],
    ['SAKAC', ['king abdullah port', 'kap', 'sakac', 'rabigh', 'king abdullah', 'ميناء الملك عبدالله', 'رابغ']],
    ['SAYNB', ['yanbu', 'ynb', 'saynb', 'ينبع']],
    ['SAJIZ', ['jizan', 'jazan', 'giz', 'sagiz', 'sajiz', 'جازان', 'جيزان']],
    ['CNSHA', ['shanghai', 'cnsha', 'sha', 'yangshan', 'شنغهاي', 'شانغهاي']],
    ['CNNGB', ['ningbo', 'cnngb', 'ngb', 'ningbo zhoushan', 'ningbo-zhoushan', 'نينغبو', 'نينجبو']],
    ['CNSZX', ['shenzhen', 'cnszx', 'szx', 'yantian', 'cnytn', 'shekou', 'cnskn', 'chiwan', 'shenzhen yantian', 'شنتشن', 'شينزين', 'يانتيان']],
    ['CNTAO', ['qingdao', 'cntao', 'tao', 'tsingtao', 'تشينغداو', 'كينغداو']],
    ['CNTXG', ['tianjin', 'xingang', 'cntxg', 'cntsn', 'tianjin xingang', 'تيانجين']],
    ['CNXMN', ['xiamen', 'cnxmn', 'xmn', 'شيامن']],
    ['CNCAN', ['guangzhou', 'nansha', 'cncan', 'cngzg', 'huangpu', 'قوانغتشو', 'جوانزو']],
    ['CNDLC', ['dalian', 'cndlc', 'داليان']],
    ['HKHKG', ['hong kong', 'hkhkg', 'hkg', 'هونغ كونغ']],
    ['AEJEA', ['jebel ali', 'aejea', 'jea', 'jabal ali', 'dubai jebel ali', 'جبل علي']],
    ['AEDXB', ['dubai', 'aedxb', 'port rashid', 'dxb', 'دبي', 'ميناء راشد']],
    ['AEKHL', ['khalifa port', 'aekhl', 'abu dhabi', 'aeauh', 'ابوظبي', 'ميناء خليفه']],
    ['INNSA', ['nhava sheva', 'innsa', 'jnpt', 'jawaharlal nehru', 'jawaharlal nehru port', 'mumbai', 'bombay', 'inbom', 'nsa', 'navi mumbai', 'نافا شيفا', 'مومباي']],
    ['INMUN', ['mundra', 'inmun', 'موندرا']],
    ['INMAA', ['chennai', 'madras', 'inmaa', 'تشيناي']],
    ['SGSIN', ['singapore', 'sgsin', 'sin', 'سنغافوره']],
    ['MYPKG', ['port klang', 'klang', 'mypkg', 'بورت كلانج']],
    ['LKCMB', ['colombo', 'lkcmb', 'كولومبو']],
    ['PKKHI', ['karachi', 'pkkhi', 'كراتشي']],
    ['TRIST', ['istanbul', 'trist', 'ambarli', 'tramr', 'اسطنبول']],
    ['TRMER', ['mersin', 'trmer', 'مرسين']],
    ['EGPSD', ['port said', 'egpsd', 'east port said', 'بورسعيد', 'بور سعيد']],
    ['EGALY', ['alexandria', 'egaly', 'الاسكندريه']],
    ['NLRTM', ['rotterdam', 'nlrtm', 'روتردام']],
    ['BEANR', ['antwerp', 'beanr', 'انتويرب', 'انتورب']],
    ['DEHAM', ['hamburg', 'deham', 'هامبورغ']],
    ['ITGOA', ['genoa', 'genova', 'itgoa', 'جنوه']],
    ['ESVLC', ['valencia', 'esvlc', 'فالنسيا']],
    ['KRPUS', ['busan', 'pusan', 'krpus', 'بوسان']],
    ['JPTYO', ['tokyo', 'jptyo', 'طوكيو']],
    ['VNSGN', ['ho chi minh', 'ho chi minh city', 'saigon', 'cat lai', 'vnsgn', 'vncli', 'هوشي منه']],
    ['VNHPH', ['haiphong', 'hai phong', 'vnhph', 'هايفونغ']],
    ['THLCH', ['laem chabang', 'thlch', 'ليم تشابانج']],
    ['IDJKT', ['jakarta', 'tanjung priok', 'idjkt', 'جاكرتا']],
    ['USNYC', ['new york', 'usnyc', 'nyc', 'نيويورك']],
    ['USLAX', ['los angeles', 'uslax', 'لوس انجلوس']],
    ['OMSOH', ['sohar', 'omsoh', 'صحار']],
    ['OMSLL', ['salalah', 'omsll', 'صلاله']],
    ['JOAQJ', ['aqaba', 'joaqj', 'العقبه']],
    ['KWSWK', ['shuwaikh', 'kwswk', 'kuwait', 'الشويخ']],
    ['BHKBS', ['khalifa bin salman', 'bhkbs', 'bahrain', 'خليفه بن سلمان']],
    ['QAHMD', ['hamad port', 'qahmd', 'hamad', 'ميناء حمد']]
  ];
  var PORT_NOISE = ['port', 'of', 'the', 'seaport', 'sea', 'terminal', 'harbour', 'harbor', 'container', 'containers', 'ctr', 'cy', 'cfs',
    'ميناء', 'مرفا', 'محطه', 'saudi', 'arabia', 'ksa', 'sa', 'china', 'cn', 'prc', 'uae', 'ae', 'india', 'in', 'turkey', 'egypt',
    'السعوديه', 'الصين', 'المملكه', 'العربيه', 'الامارات', 'الهند', 'any', 'chinese', 'main'];
  function normPort(v) {
    var full = words(v).join(' ');
    if (!full) return '';
    var t = words(v).filter(function (x) { return PORT_NOISE.indexOf(x) === -1; }).join(' ');
    var cands = [full, t, t.replace(/\bal\s/g, ''), full.replace(/^ميناء\s+/, '')];
    for (var c = 0; c < cands.length; c++) {
      if (!cands[c]) continue;
      for (var i = 0; i < PORTS.length; i++) if (PORTS[i][1].indexOf(cands[c]) !== -1) return PORTS[i][0];
    }
    // the first alias word inside ("JEDDAH ISLAMIC PORT, KSA" / "NINGBO, CHINA")
    var w = t.split(' ');
    for (var n = Math.min(3, w.length); n >= 1; n--) {
      for (var s = 0; s + n <= w.length; s++) {
        var g = w.slice(s, s + n).join(' ');
        if (g.length < 3) continue;
        for (var k = 0; k < PORTS.length; k++) if (PORTS[k][1].indexOf(g) !== -1) return PORTS[k][0];
      }
    }
    // a UN/LOCODE written as is ("SA JED")
    var code = full.replace(/ /g, '').toUpperCase();
    if (/^[A-Z]{5}$/.test(code)) return code;
    return t ? t.toUpperCase() : full.toUpperCase();
  }
  function cmpPort(a, b) {
    var x = normPort(a), y = normPort(b);
    if (!x || !y) return { s: 'mismatch' };
    if (x === y) return { s: 'match' };
    if (x.length > 5 || y.length > 5) {
      var cx = x.replace(/ /g, ''), cy = y.replace(/ /g, '');
      if ((cx.length >= 4 && cy.indexOf(cx) !== -1) || (cy.length >= 4 && cx.indexOf(cy) !== -1)) return { s: 'partial', why: 'contains' };
    }
    return { s: 'mismatch' };
  }

  var CURRENCY = { SR: 'SAR', SAR: 'SAR', 'ريال': 'SAR', 'ر س': 'SAR', 'ريال سعودي': 'SAR', 'رس': 'SAR', US: 'USD', USD: 'USD', 'US$': 'USD', '$': 'USD',
    'دولار': 'USD', 'دولار امريكي': 'USD', DOLLAR: 'USD', DOLLARS: 'USD', 'US DOLLAR': 'USD', 'US DOLLARS': 'USD', RMB: 'CNY', CNY: 'CNY', YUAN: 'CNY',
    '¥': 'CNY', 'يوان': 'CNY', EUR: 'EUR', '€': 'EUR', EURO: 'EUR', EUROS: 'EUR', 'يورو': 'EUR', AED: 'AED', DHS: 'AED', 'درهم': 'AED',
    GBP: 'GBP', '£': 'GBP', 'جنيه استرليني': 'GBP', INR: 'INR', RS: 'INR', 'روبيه': 'INR', JPY: 'JPY', EGP: 'EGP', 'جنيه': 'EGP', 'جنيه مصري': 'EGP',
    TRY: 'TRY', TL: 'TRY', KWD: 'KWD', 'دينار كويتي': 'KWD', BHD: 'BHD', OMR: 'OMR', QAR: 'QAR', JOD: 'JOD', KRW: 'KRW', CHF: 'CHF' };
  function normCurrency(v) {
    var raw = fold(v).toUpperCase().replace(/[.]/g, '').trim();
    if (!raw) return '';
    if (CURRENCY[raw]) return CURRENCY[raw];
    var t = raw.replace(/[^A-Zء-ي$€£¥ ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (CURRENCY[t]) return CURRENCY[t];
    var m = t.match(/\b[A-Z]{3}\b/);
    if (m) return CURRENCY[m[0]] || m[0];
    var sym = raw.match(/US\$|[$€£¥]/);
    if (sym) return CURRENCY[sym[0]];
    return t;
  }
  function cmpCurrency(a, b) {
    var x = normCurrency(a), y = normCurrency(b);
    if (!x || !y) return { s: 'mismatch' };
    return x === y ? { s: 'match' } : { s: 'mismatch' };
  }

  var INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DAT', 'DDP', 'DDU', 'DES', 'DEQ', 'DAF'];
  function incotermCode(v) {
    var t = fold(v).toUpperCase().replace(/C\s*&\s*F|CNF|C AND F/g, 'CFR').replace(/C\.I\.F\.?/g, 'CIF').replace(/F\.O\.B\.?/g, 'FOB');
    var m = t.match(/\b[A-Z]{3}\b/g) || [];
    for (var i = 0; i < m.length; i++) if (INCOTERMS.indexOf(m[i]) !== -1) return m[i];
    return '';
  }
  function cmpIncoterms(a, b) {
    var x = incotermCode(a), y = incotermCode(b);
    if (!x || !y) {
      return fold(a).replace(/\W+/g, '') === fold(b).replace(/\W+/g, '') && fold(a) ? { s: 'match' } : { s: 'mismatch', why: 'nocode' };
    }
    if (x !== y) return { s: 'mismatch' };
    // same term: the named place may differ ("CIF JEDDAH" vs "CIF DAMMAM")
    var pa = normPort(String(str(a)).replace(new RegExp('\\b' + x + '\\b', 'i'), '').replace(/incoterms?\s*\d{4}/i, ''));
    var pb = normPort(String(str(b)).replace(new RegExp('\\b' + y + '\\b', 'i'), '').replace(/incoterms?\s*\d{4}/i, ''));
    if (pa && pb && pa !== pb) return { s: 'partial', why: 'place' };
    return { s: 'match' };
  }

  // → 'YYYY-MM-DD' or ''
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d) {
    y = Number(y); m = Number(m); d = Number(d);
    if (y < 100) y += 2000;
    if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return '';
    return y + '-' + pad(m) + '-' + pad(d);
  }
  function normDate(v) {
    var s = digitsLatin(str(v)).toLowerCase().trim();
    if (!s) return '';
    var m = s.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) return ymd(m[1], m[2], m[3]);
    m = s.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
    if (m) return Number(m[1]) > 12 || Number(m[2]) <= 12 ? ymd(m[3], m[2], m[1]) : ymd(m[3], m[1], m[2]);
    m = s.match(/(\d{1,2})[\s\-.]*([a-z]{3,9})[\s\-.,]*(\d{2,4})/);
    if (m && MONTHS[m[2]]) return ymd(m[3], MONTHS[m[2]], m[1]);
    m = s.match(/([a-z]{3,9})[\s\-.]*(\d{1,2})(?:st|nd|rd|th)?[\s,.\-]*(\d{4})/);
    if (m && MONTHS[m[1]]) return ymd(m[3], MONTHS[m[1]], m[2]);
    return '';
  }
  function cmpDate(a, b) {
    var x = normDate(a), y = normDate(b);
    if (!x || !y) return str(a) === str(b) && str(a) ? { s: 'match' } : { s: 'mismatch', why: x || y ? 'format' : 'nan' };
    return x === y ? { s: 'match' } : { s: 'mismatch' };
  }

  /* goods description: token overlap (stop words removed) */
  var STOP = ['the', 'of', 'and', 'for', 'with', 'in', 'on', 'to', 'a', 'an', 'said', 'contain', 'contains', 'stc', 'pcs', 'pc', 'ctns', 'ctn',
    'cartons', 'carton', 'pallets', 'pallet', 'pkgs', 'packages', 'new', 'goods', 'items', 'item', 'other', 'others', 'etc', 'as', 'per',
    'invoice', 'hs', 'code', 'shipper', 'load', 'count', 'slac', 'من', 'في', 'على', 'الى', 'مع', 'و', 'عدد', 'بضائع', 'حسب', 'الفاتوره'];
  function descTokens(v) {
    return uniq(words(v).filter(function (x) { return STOP.indexOf(x) === -1 && !/^\d+$/.test(x) && x.length > 1; })
      .map(function (x) { return x.length > 3 && /[a-z]s$/.test(x) && !/ss$/.test(x) ? x.slice(0, -1) : x; }));
  }
  function cmpDesc(a, b) {
    var x = descTokens(a), y = descTokens(b);
    if (!x.length || !y.length) return { s: 'mismatch', ratio: 0 };
    var r = Math.round(overlap(x, y) * 100) / 100;
    return { s: r >= 0.6 ? 'match' : (r >= 0.3 ? 'partial' : 'mismatch'), ratio: r };
  }

  /* ------------------------------------------------------------------
     Field table: which extraction keys feed each row, per document
     exp = expected documents (normally carry the field), opt = optional ones
     ------------------------------------------------------------------ */
  var F = [
    { key: 'invoice_number', ar: 'رقم الفاتورة', en: 'Invoice number', cmp: cmpId, crit: 'three',
      keys: { invoice: ['invoice_number'], bl: ['invoice_number'], declaration: ['invoice_number'] }, exp: ['invoice', 'declaration'], opt: ['bl'] },
    { key: 'bl_number', ar: 'رقم البوليصة', en: 'B/L number', cmp: cmpId, crit: 'three',
      keys: { invoice: ['bl_number'], bl: ['bl_number'], declaration: ['bl_number'] }, exp: ['bl', 'declaration'], opt: ['invoice'] },
    { key: 'declaration_number', ar: 'رقم البيان الجمركي', en: 'Declaration number', cmp: cmpId, crit: false, info: true,
      keys: { invoice: ['declaration_number'], bl: ['declaration_number'], declaration: ['declaration_number'] }, exp: ['declaration'], opt: ['invoice', 'bl'] },
    { key: 'container_numbers', ar: 'أرقام الحاويات', en: 'Container numbers', cmp: cmpContainers, crit: true, set: 'containers',
      keys: { invoice: ['container_numbers'], bl: ['container_numbers'], declaration: ['container_numbers'] }, exp: ['bl', 'declaration'], opt: ['invoice'] },
    { key: 'shipper', ar: 'الشاحن / المورد', en: 'Shipper / supplier', cmp: cmpName, crit: false,
      keys: { invoice: ['shipper', 'supplier_name'], bl: ['shipper'], declaration: ['shipper', 'supplier_name'] }, exp: ['invoice', 'bl'], opt: ['declaration'] },
    { key: 'consignee', ar: 'المرسل إليه / المستورد', en: 'Consignee / importer', cmp: cmpName, crit: true,
      keys: { invoice: ['consignee', 'buyer_name'], bl: ['consignee'], declaration: ['consignee', 'buyer_name'] }, exp: ['invoice', 'bl', 'declaration'], opt: [] },
    { key: 'gross_weight', ar: 'الوزن الإجمالي (كجم)', en: 'Gross weight (kg)', cmp: cmpWeight, crit: true, num: 'kg',
      keys: { invoice: ['gross_weight'], bl: ['gross_weight'], declaration: ['gross_weight'] }, exp: ['bl', 'declaration'], opt: ['invoice'] },
    { key: 'net_weight', ar: 'الوزن الصافي (كجم)', en: 'Net weight (kg)', cmp: cmpWeight, crit: false, num: 'kg',
      keys: { invoice: ['net_weight'], bl: ['net_weight'], declaration: ['net_weight'] }, exp: [], opt: ['invoice', 'bl', 'declaration'] },
    { key: 'packages_count', ar: 'عدد الطرود', en: 'Number of packages', cmp: cmpCount, crit: true, num: 'n',
      keys: { invoice: ['packages_count'], bl: ['packages_count'], declaration: ['packages_count'] }, exp: ['bl', 'declaration'], opt: ['invoice'] },
    { key: 'package_type', ar: 'نوع الطرود', en: 'Package type', cmp: cmpPackageType, crit: false,
      keys: { invoice: ['package_type'], bl: ['package_type'], declaration: ['package_type'] }, exp: ['bl'], opt: ['invoice', 'declaration'] },
    { key: 'hs_codes', ar: 'رموز HS (6 خانات)', en: 'HS codes (6 digits)', cmp: cmpHs, crit: true, set: 'hs',
      keys: { invoice: ['hs_codes'], bl: ['hs_codes'], declaration: ['hs_codes'] }, exp: ['invoice', 'declaration'], opt: ['bl'] },
    { key: 'country_of_origin', ar: 'بلد المنشأ', en: 'Country of origin', cmp: cmpCountry, crit: false,
      keys: { invoice: ['country_of_origin'], bl: ['country_of_origin'], declaration: ['country_of_origin'] }, exp: ['invoice', 'declaration'], opt: ['bl'] },
    { key: 'port_of_loading', ar: 'ميناء الشحن', en: 'Port of loading', cmp: cmpPort, crit: false,
      keys: { invoice: ['port_of_loading'], bl: ['port_of_loading'], declaration: ['port_of_loading'] }, exp: ['bl'], opt: ['invoice', 'declaration'] },
    { key: 'port_of_discharge', ar: 'ميناء التفريغ', en: 'Port of discharge', cmp: cmpPort, crit: false,
      keys: { invoice: ['port_of_discharge'], bl: ['port_of_discharge'], declaration: ['port_of_discharge'] }, exp: ['bl'], opt: ['invoice', 'declaration'] },
    { key: 'vessel', ar: 'اسم السفينة', en: 'Vessel', cmp: cmpVessel, crit: false,
      keys: { invoice: ['vessel'], bl: ['vessel'], declaration: ['vessel'] }, exp: ['bl'], opt: ['invoice', 'declaration'] },
    { key: 'incoterms', ar: 'شروط التسليم (Incoterms)', en: 'Incoterms', cmp: cmpIncoterms, crit: false,
      keys: { invoice: ['incoterms'], bl: ['incoterms'], declaration: ['incoterms'] }, exp: ['invoice'], opt: ['bl', 'declaration'] },
    { key: 'goods_description', ar: 'وصف البضاعة', en: 'Goods description', cmp: cmpDesc, crit: false,
      keys: { invoice: ['goods_description'], bl: ['goods_description'], declaration: ['goods_description'] }, exp: ['invoice', 'bl'], opt: ['declaration'] },
    { key: 'invoice_date', ar: 'تاريخ الفاتورة', en: 'Invoice date', cmp: cmpDate, crit: false,
      keys: { invoice: ['invoice_date'], declaration: ['invoice_date'] }, exp: ['invoice', 'declaration'], opt: [] },
    { key: 'currency', ar: 'العملة', en: 'Currency', cmp: cmpCurrency, crit: false,
      keys: { invoice: ['currency'], declaration: ['currency'] }, exp: ['invoice', 'declaration'], opt: [] },
    { key: 'total', ar: 'الإجمالي / القيمة الجمركية', en: 'Total / customs value', cmp: null, crit: true, num: 'money',
      keys: { invoice: ['total', 'subtotal'], declaration: ['total', 'subtotal'] }, exp: ['invoice', 'declaration'], opt: [] }
  ];
  var LABELS = {};
  F.forEach(function (d) { LABELS[d.key] = { ar: d.ar, en: d.en }; });
  LABELS.invoice_totals = { ar: 'مجموع بنود الفاتورة', en: 'Invoice line items total' };
  LABELS.items = { ar: 'البنود والكميات', en: 'Line items and quantities' };
  var ROW_KEYS = F.map(function (d) { return d.key; }).concat(['invoice_totals', 'items']);

  /* ------------------------------------------------------------------
     Input
     ------------------------------------------------------------------ */
  function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }
  function getField(doc, key) {
    if (!doc || !isObj(doc.fields) || !Object.prototype.hasOwnProperty.call(doc.fields, key)) return null;
    var f = doc.fields[key];
    var v = str(f);
    if (!v) return null;
    var sc = isObj(f) && f.score != null && isFinite(Number(f.score)) ? Math.min(1, Math.max(0, Number(f.score))) : null;
    return { value: v, score: sc, corrected: !!(isObj(f) && f.corrected) };
  }
  function pick(doc, keys) {
    for (var i = 0; i < (keys || []).length; i++) {
      var g = getField(doc, keys[i]);
      if (g) { g.key = keys[i]; return g; }
    }
    return null;
  }
  function itemsOf(doc) {
    if (!doc || !Array.isArray(doc.items)) return [];
    return doc.items.slice(0, 500).filter(isObj).map(function (it) {
      return { description: str(it.description), hs_code: str(it.hs_code), quantity: parseNum(it.quantity), unit_price: parseNum(it.unit_price),
        amount: parseNum(it.amount) };
    }).filter(function (it) { return it.description || it.hs_code || it.quantity != null || it.amount != null; });
  }

  /* ------------------------------------------------------------------
     Details (Arabic + English)
     ------------------------------------------------------------------ */
  function docList(list, lang) {
    var names = list.map(function (d) { return lang === 'ar' ? DOC_AR[d] : DOC_EN[d]; });
    if (names.length <= 1) return names.join('');
    if (lang === 'ar') return names.slice(0, -1).join('، ') + ' و' + names[names.length - 1];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function extraDetail(d, r, A, B) {   // comparator-specific note for one pair (A / B = document names)
    var ar = [], en = [];
    if (!r) return { ar: '', en: '' };
    if (d.set && (r.onlyA && r.onlyA.length || r.onlyB && r.onlyB.length)) {
      if (r.onlyA && r.onlyA.length) { ar.push('في ' + DOC_AR[A] + ' فقط: ' + r.onlyA.join('، ')); en.push('Only in ' + DOC_EN[A] + ': ' + r.onlyA.join(', ')); }
      if (r.onlyB && r.onlyB.length) { ar.push('في ' + DOC_AR[B] + ' فقط: ' + r.onlyB.join('، ')); en.push('Only in ' + DOC_EN[B] + ': ' + r.onlyB.join(', ')); }
    }
    if (d.set === 'hs' && r.why === 'heading') { ar.push('التطابق على مستوى البند (4 خانات) فقط'); en.push('Matches at heading (4-digit) level only'); }
    if (d.num && r.diff != null) {
      var u = d.num === 'kg' ? ' كجم' : '', ue = d.num === 'kg' ? ' kg' : '';
      ar.push('الفرق ' + fmtNum(r.diff) + u); en.push('Difference ' + fmtNum(r.diff) + ue);
    }
    if (r.why === 'nan') { ar.push('قيمة غير رقمية'); en.push('Not a number'); }
    if (r.why === 'contains' || r.why === 'similar') { ar.push('الاسمان متقاربان وليسا متطابقين تمامًا'); en.push('Similar but not identical'); }
    if (r.why === 'script') { ar.push('اسم بالعربية وآخر بالإنجليزية؛ تحقّق منه يدويًا'); en.push('One name is in Arabic, the other in Latin script; check manually'); }
    if (r.why === 'prefix') { ar.push('أحد الرقمين جزء من الآخر (بادئة أو لاحقة)'); en.push('One number is part of the other (prefix / suffix)'); }
    if (r.why === 'place') { ar.push('نفس الشرط بمكان تسليم مختلف'); en.push('Same term, different named place'); }
    if (r.why === 'nocode') { ar.push('لم يُتعرّف على رمز Incoterms'); en.push('No Incoterms code recognised'); }
    if (r.why === 'format') { ar.push('تاريخ بصيغة غير مفهومة'); en.push('Date format not recognised'); }
    if (r.why === 'currency') { ar.push('العملتان مختلفتان؛ قارن القيمة يدويًا بعد التحويل'); en.push('Different currencies; compare manually after conversion'); }
    if (r.ratio != null && r.s !== 'match') { ar.push('تشابه الوصف ' + Math.round(r.ratio * 100) + '%'); en.push('Description similarity ' + Math.round(r.ratio * 100) + '%'); }
    return { ar: ar.join('؛ '), en: en.join('; ') };
  }

  /* total / customs value: same currency required */
  function cmpTotal(a, b, curA, curB) {
    var x = parseNum(a), y = parseNum(b);
    if (x == null || y == null) return { s: 'mismatch', why: 'nan' };
    var ca = normCurrency(curA), cb = normCurrency(curB);
    if (ca && cb && ca !== cb) return { s: 'partial', why: 'currency' };
    if (numClose(x, y, 1, 0.005)) return { s: 'match' };
    return { s: 'mismatch', diff: Math.round(Math.abs(x - y) * 100) / 100 };
  }

  function buildRow(d, docs, present, mode) {
    var values = {}, conf = {}, src = {}, have = [], corrected = false;
    DOCS.forEach(function (k) {
      if (present.indexOf(k) === -1 || !d.keys[k]) { values[k] = undefined; conf[k] = null; src[k] = d.keys[k] ? d.keys[k][0] : null; return; }
      var g = pick(docs[k], d.keys[k]);
      values[k] = g ? g.value : null;
      conf[k] = g ? g.score : null;
      src[k] = g ? g.key : d.keys[k][0];
      if (g) { have.push(k); if (g.corrected) corrected = true; }
    });
    var applicable = present.filter(function (k) { return !!d.keys[k]; });
    if (!have.length || applicable.length < 1) return null;
    if (d.key !== 'declaration_number' && applicable.length < 2) return null;
    var critical = d.crit === 'three' ? mode === 'three_way' : !!d.crit;
    var missingExp = applicable.filter(function (k) { return have.indexOf(k) === -1 && d.exp.indexOf(k) !== -1; });
    var missingAny = applicable.filter(function (k) { return have.indexOf(k) === -1; });

    // pairwise comparisons
    var pairs = { inv_bl: null, inv_decl: null, bl_decl: null }, res = {};
    PAIRS.forEach(function (p) {
      var a = p[1], b = p[2];
      if (applicable.indexOf(a) === -1 || applicable.indexOf(b) === -1) return;
      var va = values[a], vb = values[b];
      if (va == null && vb == null) return;
      if (va == null || vb == null) { pairs[p[0]] = 'missing'; return; }
      var r;
      if (d.key === 'total') {
        // the customs value may equal the invoice total or its subtotal (before VAT): the best pairing counts
        var ca = pick(docs[a], ['currency']), cb = pick(docs[b], ['currency']);
        var la = d.keys[a].map(function (k) { return getField(docs[a], k); }).filter(Boolean);
        var lb = d.keys[b].map(function (k) { return getField(docs[b], k); }).filter(Boolean);
        r = null;
        la.forEach(function (x) {
          lb.forEach(function (y) {
            var t = cmpTotal(x.value, y.value, ca && ca.value, cb && cb.value);
            if (!r || RANK[t.s] < RANK[r.s]) r = t;
          });
        });
        if (!r) r = cmpTotal(va, vb, ca && ca.value, cb && cb.value);
      } else {
        try { r = d.cmp(va, vb); } catch (e) { r = { s: 'mismatch' }; }
      }
      res[p[0]] = { r: r, a: a, b: b };
      pairs[p[0]] = r.s;
    });
    var done = Object.keys(res);
    var status, dar = [], den = [];

    if (d.info && have.length === 1) {
      status = 'info';
    } else if (!done.length) {
      // a single value
      if (missingExp.length) {
        status = 'missing';
        dar.push('لا يظهر في ' + docList(missingExp, 'ar') + '؛ ورد في ' + docList(have, 'ar') + ' فقط');
        den.push('Not shown on ' + docList(missingExp, 'en') + '; only on ' + docList(have, 'en'));
      } else {
        status = 'info';
        dar.push('ورد في ' + docList(have, 'ar') + ' فقط (غير مطلوب في ' + docList(missingAny, 'ar') + ')');
        den.push('Only on ' + docList(have, 'en') + ' (not required on ' + docList(missingAny, 'en') + ')');
      }
    } else {
      var worst = 'match';
      done.forEach(function (k) { if (RANK[res[k].r.s] > RANK[worst]) worst = res[k].r.s; });
      status = worst;
      // invoice_number / bl_number in three-way: only the pair of the two expected documents (declaration ↔ invoice,
      // declaration ↔ B/L) is critical; a difference that only involves the optional document (a B/L citing another
      // reference) is shown as partial for the reviewer, not as a critical mismatch
      var critOnly = null;
      if (d.crit === 'three' && mode === 'three_way' && worst === 'mismatch') {
        PAIRS.forEach(function (p) { if (d.exp.indexOf(p[1]) !== -1 && d.exp.indexOf(p[2]) !== -1) critOnly = p[0]; });
        if (critOnly && !(res[critOnly] && res[critOnly].r.s === 'mismatch')) {
          status = 'partial';
          var optDocs = d.opt.filter(function (k) { return have.indexOf(k) !== -1; });
          if (optDocs.length) {
            dar.push('الاختلاف في ' + docList(optDocs, 'ar') + ' فقط (مرجع اختياري) — راجعه');
            den.push('The difference is only on ' + docList(optDocs, 'en') + ' (optional reference) — review it');
          }
        }
      }
      if (worst !== 'match' && have.length === 3) {
        // which document disagrees
        var ok = done.filter(function (k) { return res[k].r.s === 'match'; });
        if (ok.length === 1) {
          var odd = DOCS.filter(function (x) { return x !== res[ok[0]].a && x !== res[ok[0]].b; })[0];
          var both = [res[ok[0]].a, res[ok[0]].b];
          dar.push(DOC_AR[odd] + (odd === 'declaration' ? ' يختلف' : ' تختلف') + ' عن ' + docList(both, 'ar'));
          den.push(cap(DOC_EN[odd]) + ' differs from ' + docList(both, 'en'));
        } else if (!ok.length) {
          dar.push('القيم مختلفة في المستندات الثلاثة'); den.push('The three documents disagree');
        }
      } else if (worst !== 'match' && have.length === 2 && done.length === 1) {
        dar.push(docList(have, 'ar') + (worst === 'partial' ? ': تطابق جزئي' : ': غير متطابقين'));
        den.push(cap(docList(have, 'en')) + (worst === 'partial' ? ': partial match' : ': do not match'));
      }
      done.forEach(function (k) {
        if (res[k].r.s === 'match' && !(res[k].r.why)) return;
        var x = extraDetail(d, res[k].r, res[k].a, res[k].b);
        if (x.ar) { dar.push(x.ar); den.push(x.en); }
      });
      if (missingExp.length) {
        if (status === 'match') status = 'missing';
        dar.push('لا يظهر في ' + docList(missingExp, 'ar')); den.push('Not shown on ' + docList(missingExp, 'en'));
      } else if (missingAny.length && status === 'match') {
        dar.push('لا يظهر في ' + docList(missingAny, 'ar') + ' (غير مطلوب)'); den.push('Not shown on ' + docList(missingAny, 'en') + ' (not required)');
      }
    }
    var row = { key: d.key, label_ar: d.ar, label_en: d.en, values: values, status: status, detail_ar: uniq(dar).join('؛ '),
      detail_en: uniq(den).join('; '), critical: critical, conf: conf, pairs: pairs, src: src };
    if (corrected) row.corrected = true;
    return row;
  }

  /* ------------------------------------------------------------------
     Line items: invoice sum vs subtotal / total; quantities per HS / description
     ------------------------------------------------------------------ */
  function groupKey(it) {
    var hs = hs6Set(it.hs_code)[0];
    if (hs) return 'hs:' + hs;
    var t = descTokens(it.description).slice(0, 3);
    return t.length ? 'd:' + t.join(' ') : '';
  }
  function groupItems(list) {
    var g = {}, order = [];
    list.forEach(function (it) {
      var k = groupKey(it);
      if (!k) return;
      if (!g[k]) { g[k] = { key: k, hs6: k.indexOf('hs:') === 0 ? k.slice(3) : '', description: it.description, quantity: null, amount: null, n: 0 }; order.push(k); }
      if (it.quantity != null) g[k].quantity = (g[k].quantity || 0) + it.quantity;
      if (it.amount != null) g[k].amount = (g[k].amount || 0) + it.amount;
      g[k].n++;
    });
    return { map: g, order: order };
  }
  function findGroup(G, key, desc) {
    if (G.map[key]) return G.map[key];
    // description fallback: best token overlap ≥ 0.6
    var best = null, bestR = 0, t = descTokens(desc);
    G.order.forEach(function (k) { var r = overlap(t, descTokens(G.map[k].description)); if (r > bestR) { bestR = r; best = G.map[k]; } });
    return bestR >= 0.6 ? best : null;
  }
  function compareItems(docs, present) {
    var lists = {};
    DOCS.forEach(function (k) { lists[k] = present.indexOf(k) !== -1 ? itemsOf(docs[k]) : undefined; });
    var out = { invoice: lists.invoice || [], bl: lists.bl || [], declaration: lists.declaration || [], groups: [], totals: null, status: null };
    // internal invoice check
    var inv = lists.invoice || [];
    var withAmt = inv.filter(function (it) { return it.amount != null; });
    if (withAmt.length) {
      var sum = Math.round(withAmt.reduce(function (s, it) { return s + it.amount; }, 0) * 100) / 100;
      var sub = pick(docs.invoice, ['subtotal']), tot = pick(docs.invoice, ['total']);
      var ref = sub ? parseNum(sub.value) : null, refKey = 'subtotal';
      if (ref == null && tot) { ref = parseNum(tot.value); refKey = 'total'; }
      // a subtotal that misses but a total that hits (items listed VAT-inclusive) counts
      var stOk = ref != null && numClose(sum, ref, 0.01, 0.01);
      if (!stOk && refKey === 'subtotal' && tot && numClose(sum, parseNum(tot.value), 0.01, 0.01)) { ref = parseNum(tot.value); refKey = 'total'; stOk = true; }
      out.totals = { items_sum: sum, reference: ref, reference_key: ref == null ? null : refKey, complete: withAmt.length === inv.length,
        status: ref == null ? 'info' : (stOk ? 'match' : 'mismatch') };
    }
    var others = DOCS.filter(function (k) { return k !== 'invoice' && lists[k] && lists[k].length; });
    if (!inv.length || !others.length) return out;
    var GI = groupItems(inv), GO = {};
    others.forEach(function (k) { GO[k] = groupItems(lists[k]); });
    var used = {};
    var worst = 'match';
    GI.order.forEach(function (k) {
      var gi = GI.map[k];
      var row = { key: k, hs6: gi.hs6, description: gi.description, quantity: { invoice: gi.quantity }, amount: { invoice: gi.amount }, status: 'match' };
      others.forEach(function (o) {
        var go = findGroup(GO[o], k, gi.description);
        if (!go) { row.quantity[o] = null; row.status = row.status === 'mismatch' ? 'mismatch' : 'missing'; return; }
        used[o + '|' + go.key] = 1;
        row.quantity[o] = go.quantity;
        if (o === 'declaration') row.amount.declaration = go.amount;
        if (gi.quantity != null && go.quantity != null && !numClose(gi.quantity, go.quantity, 0.001, 0.0005)) row.status = 'mismatch';
      });
      out.groups.push(row);
    });
    others.forEach(function (o) {
      GO[o].order.forEach(function (k) {
        if (used[o + '|' + k]) return;
        var go = GO[o].map[k];
        var row = { key: k, hs6: go.hs6, description: go.description, quantity: { invoice: null }, amount: { invoice: null }, status: 'missing', only: o };
        row.quantity[o] = go.quantity;
        out.groups.push(row);
      });
    });
    out.groups.forEach(function (g) {
      var s = g.status === 'missing' ? 'partial' : g.status;
      if (RANK[s] > RANK[worst]) worst = s;
    });
    out.status = worst;
    return out;
  }

  /* ------------------------------------------------------------------
     compare
     ------------------------------------------------------------------ */
  function compare(input, opts) {
    input = isObj(input) ? input : {};
    opts = isObj(opts) ? opts : {};
    var docs = {}, present = [];
    DOCS.forEach(function (k) {
      var d = input[k];
      if (isObj(d)) { docs[k] = { fields: isObj(d.fields) ? d.fields : {}, items: Array.isArray(d.items) ? d.items : [] }; present.push(k); }
    });
    // invoice and B/L are the basis; a declaration alone with one of them still compares what it can
    var mode = present.indexOf('declaration') !== -1 && present.length === 3 ? 'three_way' : 'two_way';
    var rows = [];
    F.forEach(function (d) {
      if (d.key === 'declaration_number' && present.indexOf('declaration') === -1) return;
      var r = buildRow(d, docs, present, mode);
      if (r) rows.push(r);
    });
    var items = compareItems(docs, present);
    if (items.totals && items.totals.status !== 'info') {
      var t = items.totals, ok = t.status === 'match';
      rows.push({ key: 'invoice_totals', label_ar: LABELS.invoice_totals.ar, label_en: LABELS.invoice_totals.en,
        values: { invoice: fmtNum(t.items_sum), bl: undefined, declaration: undefined }, status: ok ? 'match' : 'mismatch',
        detail_ar: (ok ? 'مجموع البنود يساوي ' : 'مجموع البنود لا يساوي ') + (t.reference_key === 'total' ? 'الإجمالي' : 'المجموع قبل الضريبة') + ' (' + fmtNum(t.reference) + ')'
          + (t.complete ? '' : '؛ بعض البنود بلا مبلغ'),
        detail_en: 'Items sum ' + (ok ? 'equals' : 'does not equal') + ' the ' + (t.reference_key === 'total' ? 'total' : 'subtotal') + ' (' + fmtNum(t.reference) + ')'
          + (t.complete ? '' : '; some items have no amount'),
        critical: false, conf: { invoice: null, bl: null, declaration: null }, pairs: { inv_bl: null, inv_decl: null, bl_decl: null },
        src: { invoice: null, bl: null, declaration: null } });
    }
    if (items.status) {
      var mis = items.groups.filter(function (g) { return g.status !== 'match'; });
      var codes = mis.slice(0, 6).map(function (g) { return g.hs6 || g.description.slice(0, 30); });
      rows.push({ key: 'items', label_ar: LABELS.items.ar, label_en: LABELS.items.en,
        values: { invoice: String(items.invoice.length), bl: present.indexOf('bl') !== -1 ? String(items.bl.length) : undefined,
          declaration: present.indexOf('declaration') !== -1 ? String(items.declaration.length) : undefined },
        status: items.status,
        detail_ar: mis.length ? 'بنود تختلف كمياتها أو لا تظهر في كل المستندات: ' + codes.join('، ') : 'كميات البنود متطابقة',
        detail_en: mis.length ? 'Items whose quantities differ or that are not on every document: ' + codes.join(', ') : 'Item quantities agree',
        critical: false, conf: { invoice: null, bl: null, declaration: null }, pairs: { inv_bl: null, inv_decl: null, bl_decl: null },
        src: { invoice: null, bl: null, declaration: null } });
    }
    var counts = { match: 0, mismatch: 0, partial: 0, missing: 0 };
    rows.forEach(function (r) { if (Object.prototype.hasOwnProperty.call(counts, r.status)) counts[r.status]++; });
    var overall = 'match';
    if (rows.some(function (r) { return r.critical && r.status === 'mismatch'; })) overall = 'mismatch';
    else if (rows.some(function (r) { return (r.critical && (r.status === 'partial' || r.status === 'missing')) || r.status === 'mismatch'; })) overall = 'review';
    else if (!rows.some(function (r) { return r.status === 'match'; })) overall = 'review';   // nothing could be compared
    if (present.indexOf('invoice') === -1 || present.indexOf('bl') === -1) overall = overall === 'mismatch' ? 'mismatch' : 'review';
    return { version: VERSION, mode: mode, rows: rows, items: items, counts: counts, overall: overall,
      documents: present.slice(), generated_at: opts.now ? String(opts.now) : null };
  }

  return {
    VERSION: VERSION, DOCS: DOCS.slice(), ROW_KEYS: ROW_KEYS.slice(), LABELS: LABELS,
    FIELDS: F.map(function (d) { return { key: d.key, label_ar: d.ar, label_en: d.en, keys: d.keys, exp: d.exp.slice(), opt: d.opt.slice(), critical: d.crit }; }),
    compare: compare,
    // helpers (tests / UI)
    normName: normName, cmpName: cmpName, normPort: normPort, cmpPort: cmpPort, normCountry: normCountry, normCurrency: normCurrency,
    containerSet: containerSet, iso6346Valid: iso6346Valid, hs6Set: hs6Set, numClose: numClose, parseNum: parseNum, parseWeight: parseWeight,
    normPackageType: normPackageType, incotermCode: incotermCode, normDate: normDate, normId: normId, cmpId: cmpId, normVessel: normVessel,
    descTokens: descTokens, cmpDesc: cmpDesc, fold: fold, fmtNum: fmtNum
  };
});
