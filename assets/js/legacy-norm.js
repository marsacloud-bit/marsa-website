/* ==========================================================================
   مرسى | MARSA — legacy value normalisation (port of the old Apps Script helpers)
   Pure, deterministic, no DOM, no network. ES5. UMD: window.MarsaNorm + module.exports.
   Version 'norm-v1'. Not wired into pages yet (step 2).

   SHARED SPEC (the SQL helpers app.norm_* must give the same answers; JS '' == SQL NULL)
   --------------------------------------------------------------------------------------
   Common steps
     clean     = String(v).trim()  (null / undefined → '')
     western   = Arabic-Indic ٠-٩ and Persian ۰-۹ digits → 0-9            (= app.to_western)
     searchKey = legacy normalizeSearch_: lower-case; أ إ آ → ا; ة → ه; ى → ي;
                 remove whitespace, '-', '_', '/', '\', '.'                  (MarsaNorm.searchKey)

   normDeclarationStatus(v) → code | ''                         (= app.norm_declaration_status)
     1. k = lower(clean(v)); if k is one of the codes below → k (identity).
     2. key = searchKey(v); the first group whose pattern P satisfies key = P or key contains P wins
        (groups in this order, patterns as written, each passed through searchKey):
          accepted              قبول البيان | تفتيش ومعاينة | مرحلة تفتيش ومعاينة البضاعة
          cco_review_done       انتهاء مراجعة مركز العمليات الجمركية | انتهت مراجعة مركز العمليات الجمركية
          awaiting_duty_payment انتظار تحصيل الرسوم الجمركية | بانتظار السداد | انتظار السداد | الرسوم الجمركية غير مسددة
          release_ready         جاهز لطباعة اشعار الفسح الالكتروني | طباعة اشعار الفسح
          released              فسح كلي | تم الفسح | مفسوح | تم الفسح كليا
     3. otherwise '' (legacy kept the raw text; Marsa stores codes only).
     codes: draft submitted under_inspection accepted cco_review_done awaiting_duty_payment
            release_ready released cancelled replaced
   normDeclarationType(v) → import | export | clearance | ''
     key = searchKey(v): contains استيراد or = 'import' → import; contains تصدير / تصدر or = 'export' → export;
     contains تصفيه or = 'clearance' → clearance (checked in that order).
   normTas(v) → 'TAS' + digits | ''                                         (= app.norm_tas)
     western, upper-case, remove bidi marks U+200E U+200F U+202A-U+202E U+2066-U+2069,
     remove whitespace - _ / \ . ; first match of TAS(\d{8,}) wins, else (\d{8,})TAS (RTL-reversed);
     the digits are kept as read (never reversed).
   normSaPhone(v, allowLandline) → '05XXXXXXXX' (or '01[1-7]XXXXXXX' when allowed) | ''   (= app.norm_sa_phone)
     western, keep only 0-9 and '+'; '+966…' / '00966…' → '0…'; '966…' of length 11-12 → '0…';
     '5XXXXXXXX' → '05XXXXXXXX'; result must be ^05\d{8}$ (or the landline form). Same canonical
     form as the existing app.norm_phone (legacy kept '+966…' as typed; Marsa stores 05…).
   normChassis(v) → [A-Z0-9]* | ''                                          (= app.norm_chassis)
     western, upper-case, remove everything outside A-Z 0-9.
   normContainerNo(v) → 'ABCD1234567' | ''  (stored form, matches containers.container_no CHECK)
     western, upper-case, remove everything outside A-Z 0-9, must be ^[A-Z]{4}\d{7}$.
     formatContainerNo(v) → 'ABCD 1234567' for display (legacy formatContainerNumberText_).
   normalizeHijri(v) → 'yyyy/mm/dd' | ''  (the customs_declarations.declaration_date_hijri CHECK)
     western; trailing هـ / ه / AH marker dropped; legacy JS-date text ("Thu Jun 03 1447 …") read;
     separators . - → /; whitespace removed; 3 parts; yyyy/m/d or d/m/yyyy; year 1300-1700,
     month 1-12, day 1-30. A Date whose year is 1300-1700 (sheet cell) is read in Asia/Riyadh.
   hijriToGregorian / gregorianToHijri: Umm al-Qura through Intl 'en-u-ca-islamic-umalqura'
     (binary search over the day number, every candidate verified, a day 30 that the month
     does not have → ''). '' when the runtime has no Umm al-Qura calendar.
   normPortCode(v) → one of the 7 approved ports (PORTS) | ''  (names, Daftra values, aliases,
     the code itself). Documents can never add a port: unknown → ''.
   normShippingAgentShort(v): the legacy 15-agent dictionary; unknown agents only lose legal
     suffixes (LTD, CO. LTD, LLC, FZE, INC, …), never get an invented abbreviation.
   ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.MarsaNorm = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'norm-v1';
  var DAY = 86400000;

  /* ------------------------------------------------------------- basics */
  function clean(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/^\s+|\s+$/g, '');
  }
  function western(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
  }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function pad4(n) { n = String(n); while (n.length < 4) n = '0' + n; return n; }

  // legacy normalizeSearch_ (exact)
  function searchKey(v) {
    return clean(v).toLowerCase()
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/[\s\-_\/\\.]+/g, '');
  }

  // stronger Arabic folding for matching: digits, alef forms, ة ى ؤ ئ, tashkeel + tatweel, spaces collapsed
  function foldArabic(v) {
    return western(clean(v)).toLowerCase()
      .replace(/[ً-ٰٟـ]/g, '')
      .replace(/[آأإٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
      .replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  // mirror of app.norm_name (registry name key): stop words dropped, '' when empty
  var NAME_STOP = { co: 1, ltd: 1, llc: 1, est: 1, inc: 1, company: 1, limited: 1, 'مؤسسه': 1, 'شركه': 1 };
  function normName(v) {
    if (v === null || v === undefined) return '';
    var s = western(String(v)).toLowerCase()
      .replace(/[ً-ٰٟـ]/g, '');
    s = s.replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
    s = s.replace(/[^0-9a-zء-ي]+/g, ' ').replace(/^ +| +$/g, '');
    var out = [];
    var parts = s ? s.split(' ') : [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && !Object.prototype.hasOwnProperty.call(NAME_STOP, parts[i])) out.push(parts[i]);
    }
    return out.join(' ');
  }

  /* ------------------------------------------------- declaration status / type */
  var DECL_STATUS_CODES = ['draft', 'submitted', 'under_inspection', 'accepted', 'cco_review_done',
    'awaiting_duty_payment', 'release_ready', 'released', 'cancelled', 'replaced'];
  var DECL_STATUS_GROUPS = [
    { code: 'accepted', ar: 'قبول البيان ـ مرحلة تفتيش ومعاينة البضاعة',
      patterns: ['قبول البيان', 'تفتيش ومعاينة', 'مرحلة تفتيش ومعاينة البضاعة'] },
    { code: 'cco_review_done', ar: 'انتهاء مراجعة مركز العمليات الجمركية',
      patterns: ['انتهاء مراجعة مركز العمليات الجمركية', 'انتهت مراجعة مركز العمليات الجمركية'] },
    { code: 'awaiting_duty_payment', ar: 'مرحلة انتظار تحصيل الرسوم الجمركية',
      patterns: ['انتظار تحصيل الرسوم الجمركية', 'بانتظار السداد', 'انتظار السداد', 'الرسوم الجمركية غير مسددة'] },
    { code: 'release_ready', ar: 'جاهز لطباعة إشعار الفسح الإلكتروني',
      patterns: ['جاهز لطباعة اشعار الفسح الالكتروني', 'طباعة اشعار الفسح'] },
    { code: 'released', ar: 'فسح كلي',
      patterns: ['فسح كلي', 'تم الفسح', 'مفسوح', 'تم الفسح كليا'] }
  ];
  for (var gi = 0; gi < DECL_STATUS_GROUPS.length; gi++) {
    DECL_STATUS_GROUPS[gi].keys = DECL_STATUS_GROUPS[gi].patterns.map(searchKey);
  }
  function normDeclarationStatus(v) {
    var c = clean(v);
    if (!c) return '';
    var low = c.toLowerCase();
    if (DECL_STATUS_CODES.indexOf(low) !== -1) return low;
    var key = searchKey(c);
    if (!key) return '';
    for (var i = 0; i < DECL_STATUS_GROUPS.length; i++) {
      var ks = DECL_STATUS_GROUPS[i].keys;
      for (var j = 0; j < ks.length; j++) if (key === ks[j] || key.indexOf(ks[j]) !== -1) return DECL_STATUS_GROUPS[i].code;
    }
    return '';
  }
  function isReleasedStatus(v) { return normDeclarationStatus(v) === 'released'; }

  var DECL_TYPE_AR = { 'import': 'استيراد', 'export': 'تصدير', 'clearance': 'تصفية' };
  function normDeclarationType(v) {
    var key = searchKey(v);
    if (!key) return '';
    if (key.indexOf('استيراد') !== -1 || key === 'import') return 'import';
    if (key.indexOf('تصدير') !== -1 || key.indexOf('تصدر') !== -1 || key === 'export') return 'export';
    if (key.indexOf('تصفيه') !== -1 || key === 'clearance') return 'clearance';
    return '';
  }

  /* ---------------------------------------------- transaction field domains */
  function normTransactionType(v) {
    var k = searchKey(v);
    if (k === 're_export' || k === 'reexport' || k.indexOf('اعادهتصدير') !== -1 || k.indexOf('اعادهصادر') !== -1) return 're_export';
    return 'normal';
  }
  function normCargoUnitType(v) {
    var k = clean(v).toLowerCase();
    if (!k) return 'container';
    if (k.indexOf('ro-ro') !== -1 || k.indexOf('roro') !== -1 || k.indexOf('مركبة') !== -1 || k.indexOf('مركبه') !== -1 ||
        k.indexOf('شاحنة') !== -1 || k.indexOf('شاحنه') !== -1 || k.indexOf('براد') !== -1) return 'roro';
    return 'container';
  }
  function normTransportMode(v) {
    var t = clean(v);
    if (t === 'شركة نقل' || t === 'أمر نقل لشركة نقل' || t === 'company' || t === 'carrier_order') return 'carrier_order';
    if (t === 'نقل بالسائق' || t === 'موعد ونقل بواسطة سائق' || t === 'driver') return 'driver';
    return '';
  }
  function normTransportOrderNo(v) { return western(clean(v)).replace(/\s+/g, '').toUpperCase(); }
  function isTransportOrderNo(v) { return /^TASTO\d+$/.test(normTransportOrderNo(v)); }

  /* -------------------------------------------------------- identifiers */
  var BIDI = /[‎‏‪-‮⁦-⁩]/g;
  function normTas(v) {
    var t = western(v === null || v === undefined ? '' : v).toUpperCase()
      .replace(BIDI, '')
      .replace(/[\s\-_\/\\.]+/g, '');
    if (!t) return '';
    var m = t.match(/TAS(\d{8,})/);
    if (m) return 'TAS' + m[1];
    m = t.match(/(\d{8,})TAS/);
    if (m) return 'TAS' + m[1];
    return '';
  }

  function normSaPhone(v, allowLandline) {
    var s = western(v === null || v === undefined ? '' : v).replace(/[^0-9+]/g, '');
    if (!s) return '';
    if (s.indexOf('+966') === 0) s = '0' + s.substring(4);
    else if (s.indexOf('00966') === 0) s = '0' + s.substring(5);
    else if (s.indexOf('966') === 0 && (s.length === 11 || s.length === 12)) s = '0' + s.substring(3);
    if (/^5\d{8}$/.test(s)) s = '0' + s;
    if (/^05\d{8}$/.test(s)) return s;
    if (allowLandline && /^01[1-7]\d{7}$/.test(s)) return s;
    return '';
  }
  function phoneE164(v) { var p = normSaPhone(v, true); return p ? '+966' + p.substring(1) : ''; }

  function normChassis(v) {
    return western(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function containerCompact(v) {
    return western(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function normContainerNo(v) {
    var c = containerCompact(v);
    return /^[A-Z]{4}\d{7}$/.test(c) ? c : '';
  }
  // legacy formatContainerNumberText_: valid → 'ABCD 1234567', else the compact text
  function formatContainerNo(v) {
    var c = containerCompact(v);
    var m = c.match(/^([A-Z]{4})(\d{7})$/);
    return m ? m[1] + ' ' + m[2] : c;
  }
  // ISO 6346 check digit (informative: Marsa does not reject a wrong check digit)
  function containerCheckDigitOk(v) {
    var c = normContainerNo(v);
    if (!c) return false;
    var sum = 0;
    for (var i = 0; i < 10; i++) {
      var ch = c.charAt(i), val;
      if (i < 4) {
        val = ch.charCodeAt(0) - 55; // A=10
        val += Math.floor((val - 1) / 10); // skip 11, 22, 33
      } else val = +ch;
      sum += val * Math.pow(2, i);
    }
    return (sum % 11) % 10 === +c.charAt(10);
  }
  function containerList(list) {
    var src = Object.prototype.toString.call(list) === '[object Array]' ? list : String(list || '').split(/[\s,،;|\n]+(?=[A-Za-z]{4})/);
    var seen = {}, out = [];
    for (var i = 0; i < src.length; i++) {
      var x = src[i];
      var n = normContainerNo(x && typeof x === 'object' ? x.containerNo || x.container_no : x);
      if (n && !seen[n]) { seen[n] = 1; out.push(n); }
    }
    return out;
  }

  /* -------------------------------------------------------------- ports */
  // The 7 approved legacy ports. code = UN/LOCODE of the location; the three airports share their
  // city's LOCODE, so they are told apart by the IATA airport code after the country (SA + IATA).
  var PORTS = [
    { code: 'SAJED', kind: 'sea', name_ar: 'ميناء جدة الإسلامي', name_en: 'Jeddah Islamic Port',
      daftra_value: 'جمرك ميناء جدة الإسلامي',
      aliases: ['jeddah', 'jeddah islamic port', 'jeddah islamic', 'jiddah', 'jedda', 'jip', 'jed', 'sa jed', 'جدة', 'جده', 'ميناء جدة', 'جمرك جدة الاسلامي', 'جدة الاسلامي'] },
    { code: 'SADMM', kind: 'sea', name_ar: 'ميناء الملك عبدالعزيز بالدمام', name_en: 'King Abdulaziz Port, Dammam',
      daftra_value: 'جمرك ميناء الملك عبدالعزيز',
      aliases: ['dammam', 'king abdulaziz port', 'king abdul aziz port', 'king abdulaziz port dammam', 'dammam port', 'dmm', 'sa dmm',
        'الدمام', 'ميناء الدمام', 'ميناء الملك عبدالعزيز', 'ميناء الملك عبد العزيز', 'ميناء الملك عبدالعزيز الدمام'] },
    { code: 'SAKAC', kind: 'sea', name_ar: 'ميناء الملك عبدالله (رابغ)', name_en: 'King Abdullah Port, Rabigh',
      daftra_value: null,
      aliases: ['king abdullah port', 'kap', 'rabigh', 'king abdullah port rabigh', 'king abdullah city', 'رابغ', 'ميناء رابغ', 'ميناء الملك عبدالله', 'ميناء الملك عبد الله', 'ميناء الملك عبدالله برابغ'] },
    { code: 'SARUH', kind: 'dry', name_ar: 'ميناء الرياض الجاف', name_en: 'Riyadh Dry Port',
      daftra_value: 'جمرك الرياض - الميناء الجاف',
      aliases: ['riyadh dry port', 'riyadh dryport', 'dry port riyadh', 'dry port', 'riyadh', 'ruh', 'sa ruh', 'الرياض الجاف', 'الميناء الجاف', 'الميناء الجاف بالرياض', 'الرياض', 'جمرك الرياض الميناء الجاف'] },
    { code: 'SAJED-AIR', kind: 'air', name_ar: 'مطار الملك عبدالعزيز الدولي بجدة', name_en: 'King Abdulaziz International Airport, Jeddah',
      daftra_value: 'جمرك مطار الملك عبدالعزيز الدولي',
      aliases: ['king abdulaziz international airport', 'king abdulaziz airport', 'jeddah airport', 'jed airport', 'kaia',
        'مطار جدة', 'مطار الملك عبدالعزيز', 'مطار الملك عبد العزيز', 'مطار الملك عبدالعزيز الدولي', 'جمرك مطار الملك عبدالعزيز'] },
    { code: 'SADMM-AIR', kind: 'air', name_ar: 'مطار الملك فهد الدولي بالدمام', name_en: 'King Fahd International Airport, Dammam',
      daftra_value: 'جمرك مطار الملك فهد الدولي',
      aliases: ['king fahd international airport', 'king fahd airport', 'king fahad international airport', 'king fahad airport', 'dammam airport', 'dmm airport', 'kfia',
        'مطار الدمام', 'مطار الملك فهد', 'مطار الملك فهد الدولي', 'جمرك مطار الملك فهد'] },
    { code: 'SARUH-AIR', kind: 'air', name_ar: 'مطار الملك خالد الدولي بالرياض', name_en: 'King Khalid International Airport, Riyadh',
      daftra_value: 'جمرك مطار الملك خالد الدولي',
      aliases: ['king khalid international airport', 'king khalid airport', 'riyadh airport', 'ruh airport', 'kkia',
        'مطار الرياض', 'مطار الملك خالد', 'مطار الملك خالد الدولي', 'جمرك مطار الملك خالد'] }
  ];
  function portKey(v) { return foldArabic(v).replace(/[^0-9a-zء-ي]+/g, ''); }
  var PORT_INDEX = {};
  (function () {
    for (var i = 0; i < PORTS.length; i++) {
      var p = PORTS[i];
      var names = [p.code, p.name_ar, p.name_en].concat(p.daftra_value ? [p.daftra_value] : [], p.aliases);
      for (var j = 0; j < names.length; j++) {
        var k = portKey(names[j]);
        if (k && !Object.prototype.hasOwnProperty.call(PORT_INDEX, k)) PORT_INDEX[k] = p.code;
      }
    }
  })();
  function hasAny(s, list) { for (var i = 0; i < list.length; i++) if (s.indexOf(list[i]) !== -1) return true; return false; }
  function normPortCode(v) {
    var c = clean(v);
    if (!c) return '';
    var up = c.toUpperCase().replace(/\s+/g, '');
    for (var i = 0; i < PORTS.length; i++) if (up === PORTS[i].code) return PORTS[i].code;
    var k = portKey(c);
    if (!k) return '';
    if (Object.prototype.hasOwnProperty.call(PORT_INDEX, k)) return PORT_INDEX[k];
    // without a trailing country («, KSA» / «Saudi Arabia» / «السعودية»)
    var k0 = k.replace(/(?:kingdomofsaudiarabia|saudiarabia|ksa|المملكهالعربيهالسعوديه|السعوديه)$/, '');
    if (k0 && k0 !== k && Object.prototype.hasOwnProperty.call(PORT_INDEX, k0)) return PORT_INDEX[k0];
    if (k0) k = k0;
    // without the leading «جمرك» / «customs»
    var k2 = k.replace(/^جمرك/, '').replace(/^customs/, '').replace(/customs$/, '');
    if (k2 !== k && Object.prototype.hasOwnProperty.call(PORT_INDEX, k2)) return PORT_INDEX[k2];
    // legacy fasahR116MapPort_ containment rules (airport keywords checked before the city words)
    var air = hasAny(k, ['مطار', 'جوي', 'airport']);
    if (air) {
      if (hasAny(k, ['الملكفهد', 'kingfahd', 'kingfahad'])) return 'SADMM-AIR';
      if (hasAny(k, ['الملكخالد', 'kingkhalid'])) return 'SARUH-AIR';
      if (hasAny(k, ['الملكعبدالعزيز', 'kingabdulaziz', 'جده', 'jeddah'])) return 'SAJED-AIR';
      if (hasAny(k, ['الدمام', 'dammam'])) return 'SADMM-AIR';
      if (hasAny(k, ['الرياض', 'riyadh'])) return 'SARUH-AIR';
      return '';
    }
    if (hasAny(k, ['ميناءجدهالاسلامي', 'جمركجدهالاسلامي', 'جدهالاسلامي', 'jeddahislamic'])) return 'SAJED';
    if (hasAny(k, ['الملكعبدالعزيز', 'kingabdulaziz']) && hasAny(k, ['الدمام', 'dammam', 'ميناء', 'بحري', 'port'])) return 'SADMM';
    if (hasAny(k, ['ميناءالملكعبدالله', 'kingabdullahport']) || (hasAny(k, ['الملكعبدالله', 'kingabdullah']) && hasAny(k, ['رابغ', 'rabigh'])) || hasAny(k, ['رابغ', 'rabigh'])) return 'SAKAC';
    if (hasAny(k, ['الرياضالجاف', 'ميناءالرياضالجاف', 'الميناءالجاف', 'riyadhdryport', 'dryportriyadh'])) return 'SARUH';
    return '';
  }
  function portByCode(code) {
    var c = normPortCode(code);
    for (var i = 0; i < PORTS.length; i++) if (PORTS[i].code === c) return PORTS[i];
    return null;
  }

  /* ----------------------------------------------------- shipping agents */
  var AGENTS = ['Hapag-Lloyd', 'MSC', 'ONE', 'Wan Hai', 'OOCL', 'CMA CGM', 'Maersk', 'PIL', 'Milaha', 'RCL',
    'T.S. Lines', 'Yang Ming', 'Messina Line', 'ESL', 'Kenzy'];
  function normShippingAgentShort(v) {
    var text = clean(v);
    var key = searchKey(text);
    if (!key) return '';
    if (/hapag|lloyd|هابا?غ|هباج/.test(key)) return 'Hapag-Lloyd';
    if (/mediterraneanshipping|^msc$|اماسسي/.test(key)) return 'MSC';
    if (/oceannetworkexpress|^one$/.test(key)) return 'ONE';
    if (/wanhai|wanhailines/.test(key)) return 'Wan Hai';
    if (/orientoverseas|^oocl$|اواوسيال/.test(key)) return 'OOCL';
    if (/cmacgm|^cma$/.test(key)) return 'CMA CGM';
    if (/maersk|ميرسك/.test(key)) return 'Maersk';
    if (/pacificinternational|^pil$/.test(key)) return 'PIL';
    // legacy pattern kept as is: the search key turns ة into ه, so only the Latin name matches
    if (/milaha|ملاحة/.test(key)) return 'Milaha';
    if (/regionalcontainer|^rcl$/.test(key)) return 'RCL';
    if (/tslines?|^tsl$/.test(key)) return 'T.S. Lines';
    if (/yangming|yangmingmarine/.test(key)) return 'Yang Ming';
    if (/ignaziomessina|messinaline|^messina$/.test(key)) return 'Messina Line';
    if (/emiratesshippingline|^esl$/.test(key)) return 'ESL';
    if (/kenzyinternationalmarine|kenzymarine|^kenzy$/.test(key)) return 'Kenzy';
    // unknown: strip common legal suffixes only, never invent an abbreviation
    var compact = text
      .replace(/\b(?:PTE\.?\s*LTD\.?|CO\.?\s*LTD\.?|COMPANY\s+LIMITED|LTD\.?|LIMITED|LLC|L\.L\.C\.?|FZE|S\.P\.A\.?|INC\.?|CORP\.?|CORPORATION)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/[,.\s]+$/g, '')
      .replace(/^\s+|\s+$/g, '');
    return compact || text;
  }

  /* ---------------------------------------------------------------- Hijri */
  var HIJRI_MIN_YEAR = 1300, HIJRI_MAX_YEAR = 1700;
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function hijriParts(str) {
    var m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(String(str || ''));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function fmtHijri(y, m, d) { return pad4(y) + '/' + pad2(m) + '/' + pad2(d); }
  function inRange(y, m, d) {
    return y >= HIJRI_MIN_YEAR && y <= HIJRI_MAX_YEAR && m >= 1 && m <= 12 && d >= 1 && d <= 30;
  }

  function normalizeHijri(v) {
    if (v === null || v === undefined || v === '') return '';
    if (Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return '';
      var r = new Date(v.getTime() + 3 * 3600000); // Asia/Riyadh (UTC+3, no DST)
      var yy = r.getUTCFullYear();
      return inRange(yy, r.getUTCMonth() + 1, r.getUTCDate()) ? fmtHijri(yy, r.getUTCMonth() + 1, r.getUTCDate()) : '';
    }
    var text = western(clean(v));
    if (!text) return '';
    var js = text.match(/(?:sun|mon|tue|wed|thu|fri|sat)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})\s+(\d{4})/i) ||
      text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})\s+(\d{4})\b/i);
    if (js) {
      var jm = MONTHS[js[1].toLowerCase()], jd = +js[2], jy = +js[3];
      return inRange(jy, jm, jd) ? fmtHijri(jy, jm, jd) : '';
    }
    text = text.replace(/\s*(?:هـ|ه|ھ|AH|A\.H\.?)\s*\.?$/i, '').replace(/[.\-]/g, '/').replace(/\s+/g, '');
    var parts = text.split('/');
    if (parts.length !== 3) return '';
    var y = parts[0], m = parts[1], d = parts[2];
    if (parts[2].length === 4) { d = parts[0]; m = parts[1]; y = parts[2]; }
    if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return '';
    return inRange(+y, +m, +d) ? fmtHijri(+y, +m, +d) : '';
  }
  function isHijriFormat(v) {
    var p = hijriParts(v);
    return !!p && inRange(p.y, p.m, p.d);
  }

  var FMT = null, FMT_TRIED = false;
  function umalqura() {
    if (FMT_TRIED) return FMT;
    FMT_TRIED = true;
    try {
      if (typeof Intl !== 'object' || !Intl.DateTimeFormat) return null;
      var f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
      if (!f.resolvedOptions || f.resolvedOptions().calendar !== 'islamic-umalqura' || typeof f.formatToParts !== 'function') return null;
      FMT = f;
    } catch (e) { FMT = null; }
    return FMT;
  }
  function hijriSupported() { return !!umalqura(); }
  // Hijri {y,m,d} of a day number (days since 1970-01-01, read at 12:00 UTC)
  function hijriOfDay(dn) {
    var parts = umalqura().formatToParts(new Date(dn * DAY + 12 * 3600000));
    var o = {};
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].type;
      if (t === 'year' || t === 'month' || t === 'day') o[t.charAt(0)] = parseInt(western(parts[i].value), 10);
    }
    return o;
  }
  function cmp(a, b) { return a.y !== b.y ? a.y - b.y : (a.m !== b.m ? a.m - b.m : a.d - b.d); }
  var DN_LO = Math.floor(Date.UTC(1882, 0, 1) / DAY), DN_HI = Math.floor(Date.UTC(2280, 0, 1) / DAY);
  function isoOfDay(dn) {
    var d = new Date(dn * DAY);
    return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  // 'yyyy/mm/dd' (any form normalizeHijri accepts) → 'YYYY-MM-DD' | ''
  function hijriToGregorian(v) {
    var p = hijriParts(normalizeHijri(v));
    if (!p || !umalqura()) return '';
    var lo = DN_LO, hi = DN_HI;
    while (lo < hi) { // first day whose Hijri date >= target
      var mid = Math.floor((lo + hi) / 2);
      if (cmp(hijriOfDay(mid), p) < 0) lo = mid + 1; else hi = mid;
    }
    return cmp(hijriOfDay(lo), p) === 0 ? isoOfDay(lo) : '';
  }

  // Date (calendar day in Asia/Riyadh) or 'YYYY-MM-DD' / 'DD/MM/YYYY' text → 'yyyy/mm/dd' | ''
  function gregorianDay(v) {
    if (v === null || v === undefined || v === '') return null;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return null;
      return Math.floor((v.getTime() + 3 * 3600000) / DAY);
    }
    if (typeof v === 'number') return isFinite(v) ? Math.floor((v + 3 * 3600000) / DAY) : null;
    var t = western(clean(v));
    var m = /^(\d{4})[\-\/.](\d{1,2})[\-\/.](\d{1,2})(?:[T\s].*)?$/.exec(t), y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; } else {
      m = /^(\d{1,2})[\-\/.](\d{1,2})[\-\/.](\d{4})$/.exec(t);
      if (!m) return null;
      d = +m[1]; mo = +m[2]; y = +m[3];
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var ms = Date.UTC(y, mo - 1, d);
    var chk = new Date(ms);
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
    return Math.floor(ms / DAY);
  }
  function gregorianToHijri(v) {
    var dn = gregorianDay(v);
    if (dn === null || dn < DN_LO || dn > DN_HI || !umalqura()) return '';
    var h = hijriOfDay(dn);
    return inRange(h.y, h.m, h.d) ? fmtHijri(h.y, h.m, h.d) : '';
  }
  function isValidHijri(v) { return hijriToGregorian(v) !== ''; }

  return {
    VERSION: VERSION,
    DECL_STATUS_CODES: DECL_STATUS_CODES.slice(),
    DECL_STATUS_AR: (function () { var o = {}; for (var i = 0; i < DECL_STATUS_GROUPS.length; i++) o[DECL_STATUS_GROUPS[i].code] = DECL_STATUS_GROUPS[i].ar; return o; })(),
    DECL_TYPE_AR: DECL_TYPE_AR,
    // frozen copies: one shared object for every caller of the page, so nobody can change it for the others
    PORTS: Object.freeze(PORTS.map(function (p) {
      return Object.freeze({ code: p.code, kind: p.kind, name_ar: p.name_ar, name_en: p.name_en, daftra_value: p.daftra_value,
        aliases: Object.freeze(p.aliases.slice()) });
    })),
    AGENTS: Object.freeze(AGENTS.slice()),
    HIJRI_MIN_YEAR: HIJRI_MIN_YEAR, HIJRI_MAX_YEAR: HIJRI_MAX_YEAR,
    // text
    clean: clean, western: western, searchKey: searchKey, foldArabic: foldArabic, normName: normName,
    // declaration
    normDeclarationStatus: normDeclarationStatus, isReleasedStatus: isReleasedStatus, normDeclarationType: normDeclarationType,
    // transaction domains
    normTransactionType: normTransactionType, normCargoUnitType: normCargoUnitType, normTransportMode: normTransportMode,
    normTransportOrderNo: normTransportOrderNo, isTransportOrderNo: isTransportOrderNo,
    // identifiers
    normTas: normTas, normSaPhone: normSaPhone, phoneE164: phoneE164, normChassis: normChassis,
    normContainerNo: normContainerNo, formatContainerNo: formatContainerNo, containerCheckDigitOk: containerCheckDigitOk, containerList: containerList,
    // ports / agents
    normPortCode: normPortCode, portByCode: portByCode, normShippingAgentShort: normShippingAgentShort,
    // Hijri
    normalizeHijri: normalizeHijri, isHijriFormat: isHijriFormat, hijriSupported: hijriSupported,
    hijriToGregorian: hijriToGregorian, gregorianToHijri: gregorianToHijri, isValidHijri: isValidHijri
  };
});
