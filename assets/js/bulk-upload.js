/* =====================================================================
   مرسى | MARSA — bulk-upload.html (الرفع الجماعي للبيانات)
   Plain IIFE, no modules, works on file://. Depends on window.Marsa (main.js)
   and window.XlsxLite (xlsx-lite.js). Files are read in the browser only.
   - Type "shipments": one row = one clearance request → localStorage
     "marsa_requests" (same record shape as request.js) + batch metadata in
     "marsa_bulk_batches".
   - Type "items": one row = one invoice line → CIF / duty / VAT 15% estimate,
     export to .xlsx / .csv, optional hand-off to request.html via
     "marsa_calc_draft".
   ===================================================================== */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var M = window.Marsa || {};
    var X = window.XlsxLite;
    var $ = function (id) { return document.getElementById(id); };
    var qsa = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
    var toast = M.toast || function (m) { try { console.log(m); } catch (e) { /* noop */ } };
    var fmtNum = M.formatNum || function (n, d) { return (Number(n) || 0).toFixed(d == null ? 2 : d); };
    var fmtSAR = M.formatSAR || function (n) { return fmtNum(n, 2) + ' ر.س'; };

    var card = $('bu-card');
    if (!card || !X) return;

    /* Mode: online (staging) via window.MarsaApi — staff only; otherwise local demo */
    var API = window.MarsaApi || null;
    var ONLINE = !!(API && API.isOnline && API.isOnline());
    qsa('[data-show-mode]').forEach(function (n) {
      n.hidden = n.getAttribute('data-show-mode') !== (ONLINE ? 'online' : 'demo');
    });

    /* ---------------------------------------------------------------
       Constants (rates kept identical to calculator.html defaults)
       --------------------------------------------------------------- */
    var RATES = { USD: 3.75, EUR: 4.05, CNY: 0.52, AED: 1.02, SAR: 1 };
    var VAT_RATE = 0.15;
    var RENDER_LIMIT = 500;
    var MAX_FILE = 30 * 1024 * 1024;
    var ALLOWED = ['xlsx', 'xls', 'csv', 'tsv', 'txt', 'json'];

    /* ---------------------------------------------------------------
       Text helpers
       --------------------------------------------------------------- */
    function toWestern(s) {
      return String(s == null ? '' : s)
        .replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 0x0660; })
        .replace(/[۰-۹]/g, function (d) { return d.charCodeAt(0) - 0x06F0; });
    }
    function normAr(s) {
      return toWestern(s).toLowerCase()
        .replace(/[ً-ٰٟۖ-ۭ]/g, '')
        .replace(/ـ/g, '')
        .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ').trim();
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function digits(s) { return toWestern(s).replace(/\D/g, ''); }
    function str(v) { return v == null ? '' : String(v).trim(); }
    function fmtSize(b) {
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
      return (b / (1024 * 1024)).toFixed(1) + ' MB';
    }
    /* "12,500.50" "12.500,50" "١٢٬٥٠٠٫٥" "$ 1 200" → number (NaN if not numeric) */
    function parseNum(v) {
      if (typeof v === 'number') return v;
      var s = toWestern(v).replace(/[٬\s  ']/g, '').replace(/٫/g, '.')
        .replace(/^(usd|eur|cny|aed|sar|sr|\$|€|¥|ر\.?س)/i, '').replace(/(usd|eur|cny|aed|sar|sr|\$|€|¥|ر\.?س|%|kg|كجم|كغ)$/i, '');
      if (!s) return NaN;
      var hasDot = s.indexOf('.') !== -1, hasComma = s.indexOf(',') !== -1;
      if (hasDot && hasComma) {
        if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
        else s = s.replace(/,/g, '');
      } else if (hasComma) {
        s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
      } else if (hasDot && /^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) {
        s = s.replace(/\./g, '');
      }
      return /^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(s) ? parseFloat(s) : NaN;
    }
    function lev(a, b) {
      if (a === b) return 0;
      var m = a.length, n = b.length;
      if (!m || !n) return Math.max(m, n);
      var prev = [], cur = [], i, j;
      for (j = 0; j <= n; j++) prev[j] = j;
      for (i = 1; i <= m; i++) {
        cur = [i];
        for (j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
      return prev[n];
    }
    function similarity(a, b) { var l = Math.max(a.length, b.length); return l ? 1 - lev(a, b) / l : 0; }
    function hasWord(hay, needle) { return (' ' + hay + ' ').indexOf(' ' + needle + ' ') !== -1; }

    /* ---------------------------------------------------------------
       Reference data (same ports / services as request.js)
       --------------------------------------------------------------- */
    var PORTS = [
      { name: 'ميناء جدة الإسلامي', mode: 'sea' },
      { name: 'ميناء الملك عبدالعزيز بالدمام', mode: 'sea' },
      { name: 'ميناء الجبيل التجاري', mode: 'sea' },
      { name: 'ميناء الملك عبدالله برابغ', mode: 'sea' },
      { name: 'الميناء الجاف بالرياض', mode: 'sea', alsoLand: true },
      { name: 'مطار الملك خالد الدولي بالرياض', mode: 'air' },
      { name: 'مطار الملك عبدالعزيز الدولي بجدة', mode: 'air' },
      { name: 'منفذ البطحاء البري', mode: 'land' }
    ];
    var P = {}; PORTS.forEach(function (p) { P[p.name] = p; p.norm = normAr(p.name); });
    var CITY = [
      { ar: ['جده'], en: ['jeddah', 'jedda', 'jiddah'], codes: ['jed', 'sajed'], sea: 'ميناء جدة الإسلامي', air: 'مطار الملك عبدالعزيز الدولي بجدة' },
      { ar: ['رياض'], en: ['riyadh', 'riyad'], codes: ['ruh', 'saruh'], sea: 'الميناء الجاف بالرياض', air: 'مطار الملك خالد الدولي بالرياض', land: 'الميناء الجاف بالرياض' },
      { ar: ['دمام'], en: ['dammam'], codes: ['dmm', 'sadmm'], sea: 'ميناء الملك عبدالعزيز بالدمام' },
      { ar: ['جبيل'], en: ['jubail'], codes: ['jub', 'sajub'], sea: 'ميناء الجبيل التجاري' },
      { ar: ['رابغ'], en: ['rabigh'], codes: ['rab', 'sarab', 'kap'], sea: 'ميناء الملك عبدالله برابغ' },
      { ar: ['بطحا'], en: ['batha', 'albatha'], codes: [], land: 'منفذ البطحاء البري' },
      { ar: ['الملك خالد'], en: ['king khalid', 'kkia'], codes: [], air: 'مطار الملك خالد الدولي بالرياض' },
      { ar: ['الملك عبدالله', 'الملك عبد الله'], en: ['king abdullah'], codes: [], sea: 'ميناء الملك عبدالله برابغ' },
      { ar: ['الملك عبدالعزيز', 'الملك عبد العزيز'], en: ['king abdulaziz', 'king abdul aziz', 'kaia'], codes: [], sea: 'ميناء الملك عبدالعزيز بالدمام', air: 'مطار الملك عبدالعزيز الدولي بجدة' },
      { ar: ['الميناء الجاف', 'ميناء جاف'], en: ['dry port'], codes: [], sea: 'الميناء الجاف بالرياض', land: 'الميناء الجاف بالرياض' }
    ];
    var MODE_LABEL = { sea: 'بحري', air: 'جوي', land: 'بري' };
    var DIR_LABEL = { import: 'استيراد', export: 'تصدير' };
    var SERVICES = {
      clearance: { label: 'تخليص جمركي متكامل', keys: ['تخليص', 'تخليص جمركي', 'تخليص متكامل', 'clearance', 'customs', 'customs clearance', 'full', 'takhlees'] },
      aci: { label: 'البيان المسبق ومنصة فسح', keys: ['البيان المسبق', 'فسح', 'منصه فسح', 'سابر', 'aci', 'fasah', 'saber', 'declaration', 'preregistration', 'pre declaration'] },
      hs: { label: 'تصنيف البضائع وتحديد البند الجمركي HS Code', keys: ['تصنيف', 'تصنيف البضائع', 'البند الجمركي', 'hs', 'hscode', 'hs code', 'classification', 'tariff'] },
      inspection: { label: 'متابعة المعاينة والفحص والإفراج', keys: ['معاينه', 'فحص', 'افراج', 'المعاينه والفحص', 'inspection', 'release', 'examination'] },
      door: { label: 'تخليص وتوصيل حتى باب المخزن', keys: ['توصيل', 'باب المخزن', 'من الباب للباب', 'door', 'door to door', 'delivery', 'd2d', 'trucking'] },
      freight: { label: 'شحن دولي بحري وجوي مع التخليص', keys: ['شحن دولي', 'شحن', 'freight', 'shipping', 'forwarding'] },
      export: { label: 'تخليص صادرات وشهادات المنشأ', keys: ['تخليص صادرات', 'صادرات', 'شهادات المنشا', 'شهاده منشا', 'export', 'exports', 'certificate', 'certificate of origin'] },
      consult: { label: 'استشارة جمركية واستيرادية', keys: ['استشاره', 'استشاره جمركيه', 'consult', 'consulting', 'consultation', 'advice'] }
    };
    Object.keys(SERVICES).forEach(function (k) { SERVICES[k].norm = [normAr(SERVICES[k].label)].concat(SERVICES[k].keys.map(normAr)); });
    var COUNTRIES = [
      ['الصين', 'china', 'cn', 'prc', 'صين'], ['تركيا', 'turkey', 'turkiye', 'tr'], ['الإمارات العربية المتحدة', 'الامارات', 'uae', 'united arab emirates', 'ae', 'emirates', 'دبي', 'dubai'],
      ['سلطنة عُمان', 'عمان', 'oman', 'om'], ['الكويت', 'kuwait', 'kw'], ['الهند', 'india', 'in'], ['ألمانيا', 'germany', 'de'], ['إيطاليا', 'italy', 'it'],
      ['إسبانيا', 'spain', 'es'], ['فرنسا', 'france', 'fr'], ['المملكة المتحدة', 'بريطانيا', 'uk', 'united kingdom', 'gb', 'england'], ['الولايات المتحدة الأمريكية', 'امريكا', 'usa', 'us', 'united states'],
      ['كوريا الجنوبية', 'كوريا', 'korea', 'south korea', 'kr'], ['اليابان', 'japan', 'jp'], ['فيتنام', 'vietnam', 'viet nam', 'vn'], ['ماليزيا', 'malaysia', 'my'],
      ['الأردن', 'jordan', 'jo'], ['البحرين', 'bahrain', 'bh'], ['قطر', 'qatar', 'qa'], ['تايلاند', 'thailand', 'th'], ['إندونيسيا', 'indonesia', 'id'], ['باكستان', 'pakistan', 'pk'], ['هولندا', 'netherlands', 'holland', 'nl'], ['البرازيل', 'brazil', 'br']
    ].map(function (a) { return { name: a[0], keys: a.map(normAr) }; });
    var CUR = {
      USD: ['usd', 'us', 'dollar', 'dollars', 'us dollar', 'دولار', 'دولار امريكي', 'دولارات'],
      EUR: ['eur', 'euro', 'euros', 'يورو'],
      CNY: ['cny', 'rmb', 'yuan', 'renminbi', 'يوان', 'يوان صيني', 'رنمينبي'],
      AED: ['aed', 'dhs', 'dh', 'dirham', 'dirhams', 'درهم', 'درهم اماراتي', 'دراهم'],
      SAR: ['sar', 'sr', 's r', 'riyal', 'rial', 'saudi riyal', 'ريال', 'ريال سعودي', 'ر س', 'رس', 'ريالات']
    };
    Object.keys(CUR).forEach(function (k) { CUR[k] = CUR[k].map(normAr); });

    /* ---------------------------------------------------------------
       Target fields per data type (synonyms in Arabic + English)
       --------------------------------------------------------------- */
    var SYN_CURRENCY = ['العملة', 'عملة', 'currency', 'cur', 'ccy', 'curr'];
    var SYN_HS = ['رمز HS', 'HS', 'HS Code', 'hscode', 'hs_code', 'البند الجمركي', 'رمز البند الجمركي', 'رمز النظام المنسق', 'الرمز الجمركي', 'رقم البند', 'tariff code', 'hts', 'hts code', 'commodity code'];
    var SYN_COUNTRY = ['بلد المنشأ', 'المنشأ', 'دولة المنشأ', 'بلد الشحن', 'الدولة', 'origin', 'country', 'country of origin', 'origin country', 'coo', 'made in'];
    var FIELDS = {
      shipments: [
        { key: 'fullName', label: 'اسم العميل', req: true, syn: ['اسم العميل', 'العميل', 'الاسم', 'اسم', 'الاسم بالكامل', 'الاسم الكامل', 'اسم المستورد', 'المستورد', 'اسم المسؤول', 'customer name', 'customer', 'client name', 'client', 'name', 'full name', 'contact name', 'contact person', 'importer', 'importer name'] },
        { key: 'company', label: 'الشركة', syn: ['الشركة', 'اسم الشركة', 'المنشأة', 'اسم المنشأة', 'النشاط', 'الشركة / النشاط', 'company', 'company name', 'organization', 'business', 'firm', 'establishment'] },
        { key: 'clientType', label: 'نوع العميل', syn: ['نوع العميل', 'فئة العميل', 'صفة العميل', 'client type', 'customer type', 'clientType'] },
        { key: 'phone', ltr: true, label: 'رقم الجوال', req: true, syn: ['رقم الجوال', 'الجوال', 'جوال', 'الهاتف', 'رقم الهاتف', 'هاتف', 'موبايل', 'رقم التواصل', 'واتساب', 'phone', 'mobile', 'phone number', 'mobile number', 'mobile no', 'tel', 'telephone', 'contact number', 'whatsapp', 'cell'] },
        { key: 'email', ltr: true, label: 'البريد الإلكتروني', syn: ['البريد الإلكتروني', 'البريد', 'الإيميل', 'ايميل', 'بريد إلكتروني', 'email', 'e-mail', 'mail', 'email address'] },
        { key: 'crNumber', ltr: true, label: 'السجل التجاري', syn: ['السجل التجاري', 'رقم السجل التجاري', 'السجل', 'سجل تجاري', 'رقم السجل', 'cr', 'cr number', 'cr no', 'commercial registration', 'commercial register', 'importerCard'] },
        { key: 'taxId', ltr: true, label: 'الرقم الضريبي', syn: ['الرقم الضريبي', 'رقم ضريبي', 'الرقم الضريبي للقيمة المضافة', 'رقم التسجيل الضريبي', 'vat', 'vat number', 'vat no', 'vatNumber', 'tax id', 'tax number', 'trn'] },
        { key: 'direction', label: 'نوع العملية', req: true, syn: ['نوع العملية', 'العملية', 'الاتجاه', 'استيراد / تصدير', 'استيراد او تصدير', 'direction', 'operation', 'operation type', 'import export', 'import/export', 'type'] },
        { key: 'service', label: 'الخدمة', syn: ['الخدمة', 'نوع الخدمة', 'الخدمة المطلوبة', 'service', 'service type', 'serviceLabel'] },
        { key: 'mode', label: 'وسيلة الشحن', req: true, syn: ['وسيلة الشحن', 'طريقة الشحن', 'نوع الشحن', 'الشحن', 'وسيلة النقل', 'طريقة النقل', 'mode', 'shipping mode', 'transport mode', 'transport', 'shipment mode', 'mode of transport', 'modeLabel'] },
        { key: 'country', label: 'بلد المنشأ', syn: SYN_COUNTRY.concat(['from']) },
        { key: 'port', label: 'منفذ الوصول', req: true, syn: ['منفذ الوصول', 'المنفذ', 'ميناء الوصول', 'الميناء', 'منفذ الدخول', 'جهة الوصول', 'ميناء التفريغ', 'port', 'pod', 'destination port', 'port of discharge', 'port of arrival', 'arrival port', 'entry port', 'destination', 'destPort'] },
        { key: 'goods', label: 'وصف البضاعة', req: true, wide: true, syn: ['وصف البضاعة', 'البضاعة', 'الوصف', 'وصف', 'نوع البضاعة', 'وصف الشحنة', 'وصف السلع', 'goods', 'description', 'goods description', 'commodity', 'cargo', 'product', 'products', 'item'] },
        { key: 'hsCode', ltr: true, label: 'رمز HS', syn: SYN_HS },
        { key: 'value', label: 'القيمة', req: true, num: true, syn: ['القيمة', 'قيمة البضاعة', 'قيمة الفاتورة', 'قيمة الشحنة', 'المبلغ', 'إجمالي القيمة', 'value', 'amount', 'invoice value', 'goods value', 'total value', 'invoice amount', 'total'] },
        { key: 'currency', label: 'العملة', req: true, syn: SYN_CURRENCY },
        { key: 'weightKg', label: 'الوزن (كجم)', num: true, syn: ['الوزن (كجم)', 'الوزن', 'وزن', 'الوزن القائم', 'الوزن بالكيلو', 'weight', 'weight kg', 'weight (kg)', 'gross weight', 'kg', 'gw'] },
        { key: 'count', label: 'عدد الحاويات', num: true, syn: ['عدد الحاويات', 'عدد الطرود', 'عدد الشاحنات', 'العدد', 'عدد', 'count', 'containers', 'no of containers', 'number of containers', 'packages', 'no of packages', 'pieces'] },
        { key: 'containerType', label: 'نوع الحاوية', syn: ['نوع الحاوية', 'حجم الحاوية', 'مقاس الحاوية', 'container type', 'container size', 'equipment', 'equipment type', 'containerType'] },
        // a column titled just "container" / «الحاوية» normally holds container numbers, not the type
        { key: 'containerNumbers', ltr: true, wide: true, label: 'أرقام الحاويات', syn: ['أرقام الحاويات', 'رقم الحاوية', 'ارقام الحاويات', 'أرقام الحاوية', 'الحاوية', 'container', 'container no', 'container number', 'container numbers', 'container nos', 'container #', 'cntr', 'cntr no', 'containerNo', 'containerNumber', 'containerNumbers'] },
        { key: 'blNumber', ltr: true, label: 'رقم البوليصة', syn: ['رقم البوليصة', 'البوليصة', 'رقم بوليصة الشحن', 'بوليصة الشحن', 'bl', 'b/l', 'bl number', 'bl no', 'bill of lading', 'awb', 'awb number', 'mawb', 'cmr'] },
        { key: 'shippingLine', label: 'الخط الملاحي', syn: ['الخط الملاحي', 'الخط الملاحى', 'شركة الشحن', 'الناقل', 'شركة الطيران', 'shipping line', 'carrier', 'ocean carrier', 'airline', 'shippingLine'] },
        { key: 'declarationNo', ltr: true, label: 'رقم البيان الجمركي', syn: ['رقم البيان الجمركي', 'البيان الجمركي', 'رقم البيان', 'رقم البيان المسبق', 'declaration', 'declaration number', 'declaration no', 'customs declaration'] }
      ],
      items: [
        { key: 'hsCode', ltr: true, label: 'رمز HS', syn: SYN_HS },
        { key: 'description', label: 'وصف الصنف', req: true, wide: true, syn: ['وصف الصنف', 'الصنف', 'الوصف', 'وصف', 'اسم الصنف', 'المنتج', 'البيان', 'description', 'item', 'item description', 'product', 'goods', 'item name', 'product name'] },
        { key: 'qty', label: 'الكمية', req: true, num: true, syn: ['الكمية', 'كمية', 'العدد', 'qty', 'quantity', 'pcs', 'units', 'no of units'] },
        { key: 'unit', label: 'الوحدة', syn: ['الوحدة', 'وحدة القياس', 'وحدة', 'unit', 'uom', 'unit of measure'] },
        { key: 'unitPrice', label: 'سعر الوحدة', req: true, num: true, syn: ['سعر الوحدة', 'السعر', 'سعر', 'سعر الصنف', 'unit price', 'price', 'unit cost', 'price per unit', 'rate'] },
        { key: 'currency', label: 'العملة', req: true, syn: SYN_CURRENCY },
        { key: 'country', label: 'بلد المنشأ', syn: SYN_COUNTRY },
        { key: 'weight', label: 'الوزن', num: true, syn: ['الوزن', 'الوزن (كجم)', 'وزن', 'الوزن القائم', 'weight', 'weight kg', 'gross weight', 'net weight', 'kg'] },
        { key: 'dutyRate', label: 'نسبة الرسوم %', num: true, syn: ['نسبة الرسوم %', 'نسبة الرسوم', 'نسبة الرسوم الجمركية', 'الرسوم الجمركية', 'فئة الرسوم', 'نسبة الجمارك', 'duty', 'duty rate', 'duty %', 'customs duty', 'tariff rate', 'duty percent'] }
      ]
    };
    Object.keys(FIELDS).forEach(function (t) {
      FIELDS[t].forEach(function (f) {
        f.nsyn = f.syn.concat([f.key, f.label]).map(normAr).filter(Boolean);
      });
    });

    var TEMPLATES = {
      shipments: [
        ['عبدالله محمد العتيبي', 'شركة الأفق للتجارة', 'منشأة', '0551234567', 'abdullah@alufuq.com.sa', '4030123456', '300123456700003', 'استيراد', 'تخليص جمركي متكامل', 'بحري', 'الصين', 'ميناء جدة الإسلامي', 'أجهزة حاسب محمولة وملحقاتها', '8471.30', 48500, 'USD', 5200, 2, 'حاوية 40 قدم', 'MRSU1234565, MRSU7654320', 'COSU6284519730', 'خط ملاحي تجريبي', ''],
        ['نورة سعد القحطاني', 'مؤسسة نخبة الرياض الطبية', 'منشأة', '+966 50 987 6543', 'noura@nukhba-med.sa', '1010765432', '310765432100003', 'استيراد', 'البيان المسبق ومنصة فسح', 'جوي', 'ألمانيا', 'مطار الملك خالد الدولي بالرياض', 'أجهزة ومستلزمات طبية', '9018.90', 12750, 'EUR', 340, 6, '', '', '176-12345675', 'شركة طيران تجريبية', '']
      ],
      items: [
        ['8471.30.00', 'حاسب محمول 14 بوصة', 120, 'قطعة', 420, 'USD', 'الصين', 240, 5],
        ['6403.99', 'أحذية جلدية رجالية', 300, 'زوج', 18.5, 'EUR', 'إيطاليا', 210, '']
      ]
    };

    /* ---------------------------------------------------------------
       State
       --------------------------------------------------------------- */
    var state = {
      type: 'shipments',
      files: [],          // {id, name, size, status:'loading'|'ok'|'error', error, kind, sheets:[{name, rows}], sheetIdx}
      headers: [],        // [{key, label, sample, files:{fileId:true}, auto, score}]
      userMap: { shipments: {}, items: {} },  // header key → field key | '' (ignore)
      map: {},            // header key → field key ('' = ignored)
      rows: [],
      edits: {},          // rowKey → {field: value}
      deleted: {},        // rowKey → true
      filter: 'all',
      lastBatch: null
    };
    var seq = 0;
    function fields() { return FIELDS[state.type]; }
    function fieldByKey(k) { return fields().filter(function (f) { return f.key === k; })[0]; }

    /* ---------------------------------------------------------------
       Downloads
       --------------------------------------------------------------- */
    function download(blob, name) {
      try {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = name; a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
      } catch (e) { toast('تعذّر تنزيل الملف في هذا المتصفح.', 'error'); }
    }
    function downloadXlsx(rows, sheetName, fileName) {
      download(X.write([{ name: sheetName, rows: rows }], { title: sheetName }), fileName);
    }
    function downloadCsv(rows, fileName) {
      var csv = '﻿' + X.toCSV(rows.map(function (r) { return r.map(function (v) { return v == null ? '' : String(v); }); }));
      download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), fileName);
    }
    function plural(n, one, two, few, many) {
      if (n === 1) return one;
      if (n === 2) return two;
      if (n % 100 >= 3 && n % 100 <= 10) return fmtNum(n, 0) + ' ' + few;
      return fmtNum(n, 0) + ' ' + many;
    }
    function stamp() {
      var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    }

    /* ---------------------------------------------------------------
       Normalisers / validators
       --------------------------------------------------------------- */
    function normPhone(v) {
      var d = digits(v);
      if (d.indexOf('00966') === 0) d = '0' + d.slice(5);
      else if (d.indexOf('966') === 0) d = '0' + d.slice(3);
      if (/^00?5\d{8}$/.test(d)) d = '0' + d.replace(/^0+/, ''); // "+966 0551234567" → 0551234567
      else if (/^5\d{8}$/.test(d)) d = '0' + d;
      return /^05\d{8}$/.test(d) ? d : '';
    }
    function normCurrency(v) {
      var raw = str(v);
      if (!raw) return '';
      if (/^\$|\$$|^us\$/i.test(raw)) return 'USD';
      if (/€/.test(raw)) return 'EUR';
      if (/¥|元/.test(raw)) return 'CNY';
      if (/ر\.?\s?س|﷼/.test(raw)) return 'SAR';
      var n = normAr(raw);
      var found = '';
      Object.keys(CUR).forEach(function (k) { if (!found && CUR[k].indexOf(n) !== -1) found = k; });
      if (found) return found;
      Object.keys(CUR).forEach(function (k) {
        if (!found && CUR[k].some(function (s) { return s.length >= 3 && (hasWord(n, s) || n.indexOf(s) !== -1); })) found = k;
      });
      return found;
    }
    function normDirection(v) {
      var n = normAr(v);
      if (!n) return '';
      if (['import', 'imp', 'im', 'in', 'inbound', 'وارد', 'واردات', 'i'].indexOf(n) !== -1 || /استيراد|import|مستورد/.test(n)) return 'import';
      if (['export', 'exp', 'ex', 'out', 'outbound', 'صادر', 'صادرات', 'e'].indexOf(n) !== -1 || /تصدير|export|مصدر/.test(n)) return 'export';
      return '';
    }
    function normMode(v) {
      var n = normAr(v);
      if (!n) return '';
      if (['بحر', 'sea', 'ocean', 'ship', 'vessel', 'fcl', 'lcl', 'maritime', 's'].indexOf(n) !== -1 || /بحري|بحر|sea|ocean|vessel|fcl|lcl|حاويه/.test(n)) return 'sea';
      if (['جو', 'air', 'plane', 'flight', 'a', 'طائره'].indexOf(n) !== -1 || /جوي|طيران|air|flight|plane|courier/.test(n)) return 'air';
      if (['بر', 'land', 'road', 'truck', 'l'].indexOf(n) !== -1 || /بري|land|road|truck|شاحن/.test(n)) return 'land';
      return '';
    }
    function normService(v) {
      var n = normAr(v);
      if (!n) return '';
      if (SERVICES[n]) return n;
      var best = '', score = 0;
      Object.keys(SERVICES).forEach(function (k) {
        SERVICES[k].norm.forEach(function (s) {
          var sc = 0;
          if (s === n) sc = 1000;
          else if (s.length >= 2 && (hasWord(n, s) || (s.length >= 4 && n.indexOf(s) !== -1))) sc = s.length;
          if (sc > score) { score = sc; best = k; }
        });
      });
      return best;
    }
    function normCountry(v) {
      var n = normAr(v);
      if (!n) return '';
      for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i].keys.indexOf(n) !== -1) return COUNTRIES[i].name;
      for (var j = 0; j < COUNTRIES.length; j++) {
        if (COUNTRIES[j].keys.some(function (k) { return k.length >= 4 && n.indexOf(k) !== -1; })) return COUNTRIES[j].name;
      }
      return str(v);
    }
    function normClientType(v) {
      var n = normAr(v);
      if (!n) return '';
      if (/فرد|شخصي|individual|person|personal/.test(n)) return 'individual';
      if (/منشا|شركه|مؤسسه|business|company|corporate|establishment|firm/.test(n)) return 'business';
      return null;
    }
    /* container numbers: "MSCU 123456-5; TGHU7304186" → ['MSCU1234565', 'TGHU7304186'] */
    function parseContainers(v) {
      var seen = {};
      return toWestern(v).split(/[,،;\n|]+/).reduce(function (acc, x) {
        x = x.replace(/[\s\-\/.]/g, '').toUpperCase();
        if (/^([A-Z]{4}\d{7}){2,}$/.test(x)) return acc.concat(x.match(/[A-Z]{4}\d{7}/g));
        acc.push(x);
        return acc;
      }, []).filter(function (x) { if (!x || seen[x]) return false; seen[x] = true; return true; });
    }
    function isIsoContainer(c) { return /^[A-Z]{4}\d{7}$/.test(c); }
    function looksLikeContainerNo(v) { return isIsoContainer(toWestern(v).replace(/[\s\-\/.]/g, '').toUpperCase().split(/[,،;\n|]/)[0] || ''); }
    function normContainer(v) {
      var n = normAr(v);
      if (!n) return '';
      if (/lcl|مجمع|جزئ/.test(n)) return 'LCL';
      if (/40/.test(n)) return '40ft';
      if (/20/.test(n)) return '20ft';
      return null;
    }
    /* HS code → digits. Excel turns 8471.30 into the number 8471.3 and 0804.10
       into 804.1; HS headings are 4 digits and subheadings 2, so restore the
       dropped zeros (reported as a warning). Returns {code, fixed} or null. */
    function normHs(v) {
      var s = toWestern(v).trim();
      if (/^\d{3,4}(\.\d{1,2})+$/.test(s)) {
        var fixed = false;
        var code = s.split('.').map(function (p, i) {
          if (i === 0 && p.length === 3) { fixed = true; return '0' + p; }
          if (i > 0 && p.length === 1) { fixed = true; return p + '0'; }
          return p;
        }).join('');
        if (/^\d{6,12}$/.test(code)) return { code: code, fixed: fixed };
      }
      var c = s.replace(/[\s.\-_]/g, '');
      return /^\d{6,12}$/.test(c) ? { code: c, fixed: false } : null;
    }
    function checkHs(raw, out, err, warn) {
      out.hsCode = '';
      if (!raw) return;
      var h = normHs(raw);
      if (!h) err.hsCode = 'رمز HS يجب أن يتكون من 6 إلى 12 رقمًا';
      else {
        out.hsCode = h.code;
        if (h.fixed) warn.hsCode = 'تم تصحيح رمز HS إلى «' + h.code + '» (يبدو أن Excel حذف الأصفار) — تأكد من صحته';
      }
    }
    /* returns {name, how:'exact'|'alias'|'fuzzy'} or null */
    function matchPort(v, mode) {
      var n = normAr(v);
      if (!n) return null;
      for (var i = 0; i < PORTS.length; i++) if (PORTS[i].norm === n) return { name: PORTS[i].name, how: 'exact' };
      var kind = null;
      if (/مطار|airport|\bair\b/.test(n)) kind = 'air';
      else if (/جاف|dry/.test(n)) kind = 'sea';
      else if (/منفذ|border/.test(n) || hasWord(n, 'بري') || hasWord(n, 'land')) kind = 'land';
      else if (/ميناء|port|seaport|\bsea\b/.test(n)) kind = 'sea';
      var want = kind || mode || 'sea';
      var tokens = n.split(' ');
      var hit = null, hitLen = 0;
      CITY.forEach(function (c) {
        var len = 0;
        c.ar.forEach(function (a) { var an = normAr(a); if (n.indexOf(an) !== -1 && an.length > len) len = an.length; });
        c.en.forEach(function (a) { if (n.indexOf(a) !== -1 && a.length > len) len = a.length; });
        c.codes.forEach(function (a) { if (tokens.indexOf(a) !== -1 && a.length > len) len = a.length; });
        if (len > hitLen) { hitLen = len; hit = c; }
      });
      if (hit) {
        var name = hit[want] || (want === 'land' ? hit.sea : null) || hit.sea || hit.air || hit.land;
        if (name) return { name: name, how: 'alias' };
      }
      var best = null, bestSim = 0;
      PORTS.forEach(function (p) {
        var s = similarity(n, p.norm);
        if (s > bestSim) { bestSim = s; best = p; }
      });
      if (best && bestSim >= 0.72) return { name: best.name, how: 'fuzzy' };
      return null;
    }

    /* ---------------------------------------------------------------
       Row values + validation
       --------------------------------------------------------------- */
    function rawFor(row, fieldKey) {
      for (var i = 0; i < state.headers.length; i++) {
        var h = state.headers[i];
        if (state.map[h.key] === fieldKey && row.raw[h.key] != null && str(row.raw[h.key]) !== '') return str(row.raw[h.key]);
      }
      return '';
    }
    function valueOf(row, fieldKey) {
      var e = state.edits[row.key];
      if (e && e[fieldKey] != null) return str(e[fieldKey]);
      return rawFor(row, fieldKey);
    }

    function validateShipment(row) {
      var v = function (k) { return valueOf(row, k); };
      var err = {}, warn = {}, out = {};
      fields().forEach(function (f) { if (f.req && !v(f.key)) err[f.key] = '«' + f.label + '» مطلوب'; });

      out.fullName = v('fullName');
      out.company = v('company');
      out.clientType = '';
      if (v('clientType')) {
        var ctp = normClientType(v('clientType'));
        if (ctp === null) warn.clientType = 'نوع العميل غير معروف — اكتب «فرد» أو «منشأة»';
        else out.clientType = ctp;
      }
      if (v('phone')) {
        out.phone = normPhone(v('phone'));
        if (!out.phone) err.phone = 'رقم جوال سعودي غير صالح (مثال: 0551234567 أو ‎+966551234567)';
      }
      out.email = v('email');
      if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out.email)) err.email = 'صيغة البريد الإلكتروني غير صحيحة';
      out.crNumber = digits(v('crNumber'));
      if (v('crNumber') && out.crNumber.length !== 10) warn.crNumber = 'السجل التجاري يتكون عادةً من 10 أرقام';
      out.taxId = digits(v('taxId'));
      if (v('taxId') && !/^3\d{13}3$/.test(out.taxId)) warn.taxId = 'الرقم الضريبي السعودي 15 رقمًا يبدأ وينتهي بالرقم 3';

      if (v('direction')) {
        out.direction = normDirection(v('direction'));
        if (!out.direction) err.direction = 'نوع العملية غير معروف — اكتب «استيراد» أو «تصدير»';
      }
      out.service = '';
      if (v('service')) {
        out.service = normService(v('service'));
        if (!out.service) warn.service = 'خدمة غير معروفة — سيُعتمد «' + (out.direction === 'export' ? SERVICES['export'].label : SERVICES.clearance.label) + '»';
      }
      if (!out.service) out.service = out.direction === 'export' ? 'export' : 'clearance';

      if (v('mode')) {
        out.mode = normMode(v('mode'));
        if (!out.mode) err.mode = 'وسيلة الشحن غير معروفة — اكتب «بحري» أو «جوي» أو «بري»';
      }
      out.country = normCountry(v('country'));

      if (v('port')) {
        var pm = matchPort(v('port'), out.mode);
        if (!pm) err.port = 'منفذ الوصول غير معروف — اختر منفذًا سعوديًا مثل «ميناء جدة الإسلامي» أو «مطار الملك خالد الدولي بالرياض»';
        else {
          out.port = pm.name;
          if (pm.how === 'fuzzy') warn.port = 'تمت مطابقة المنفذ إلى «' + pm.name + '» — تأكد من صحته';
          var pp = P[pm.name];
          if (out.mode && pp && pp.mode !== out.mode && !(pp.alsoLand && out.mode === 'land')) warn.port = 'المنفذ «' + pm.name + '» لا يتوافق عادةً مع الشحن ال' + MODE_LABEL[out.mode];
        }
      }
      out.goods = v('goods');
      if (out.goods && out.goods.length < 3) err.goods = 'وصف البضاعة قصير جدًا';

      checkHs(v('hsCode'), out, err, warn);
      if (v('value')) {
        out.value = parseNum(v('value'));
        if (!(out.value > 0)) err.value = 'القيمة يجب أن تكون رقمًا أكبر من صفر';
      }
      if (v('currency')) {
        out.currency = normCurrency(v('currency'));
        if (!out.currency) err.currency = 'العملة غير مدعومة — المتاح: USD أو EUR أو CNY أو AED أو SAR';
      }
      out.weightKg = 0;
      if (v('weightKg')) {
        out.weightKg = parseNum(v('weightKg'));
        if (!(out.weightKg > 0)) err.weightKg = 'الوزن يجب أن يكون رقمًا أكبر من صفر';
      }
      out.count = 0;
      if (v('count')) {
        var c = parseNum(v('count'));
        if (!(c > 0) || Math.floor(c) !== c) err.count = 'العدد يجب أن يكون رقمًا صحيحًا أكبر من صفر';
        else out.count = c;
      }
      out.containerType = '';
      if (v('containerType') && out.mode === 'sea') {
        var ct = normContainer(v('containerType'));
        if (ct === null) warn.containerType = looksLikeContainerNo(v('containerType'))
          ? 'القيمة تبدو رقم حاوية لا نوعها — اربط هذا العمود بحقل «أرقام الحاويات» في مطابقة الأعمدة'
          : 'نوع الحاوية غير معروف — المتاح: 20 قدم أو 40 قدم أو بضائع مجمّعة LCL';
        else out.containerType = ct;
      }
      out.containerNumbers = [];
      if (v('containerNumbers')) {
        out.containerNumbers = parseContainers(v('containerNumbers'));
        var badCn = out.containerNumbers.filter(function (c) { return !isIsoContainer(c); });
        if (out.mode === 'air') warn.containerNumbers = 'أرقام الحاويات لا تنطبق عادةً على الشحن الجوي — تأكد منها';
        else if (badCn.length) warn.containerNumbers = 'رقم الحاوية «' + badCn.slice(0, 3).join('، ') + '» لا يطابق الشكل المعتاد (4 أحرف ثم 7 أرقام وفق ISO 6346) — تأكد منه';
        if (out.count && out.mode === 'sea' && out.containerType !== 'LCL' && out.containerNumbers.length && out.containerNumbers.length !== out.count && !warn.containerNumbers) {
          warn.containerNumbers = 'عدد أرقام الحاويات (' + out.containerNumbers.length + ') لا يساوي عدد الحاويات (' + out.count + ')';
        }
      }
      out.blNumber = v('blNumber');
      out.shippingLine = v('shippingLine');
      out.declarationNo = '';
      if (v('declarationNo')) {
        if (out.direction === 'export') warn.declarationNo = 'رقم البيان الجمركي لا يُستخدم مع التصدير وسيتم تجاهله';
        else {
          out.declarationNo = digits(v('declarationNo'));
          if (!out.declarationNo) err.declarationNo = 'رقم البيان الجمركي يجب أن يحتوي على أرقام';
        }
      }
      return { err: err, warn: warn, out: out };
    }

    function validateItem(row) {
      var v = function (k) { return valueOf(row, k); };
      var err = {}, warn = {}, out = {};
      fields().forEach(function (f) { if (f.req && !v(f.key)) err[f.key] = '«' + f.label + '» مطلوب'; });
      checkHs(v('hsCode'), out, err, warn);
      out.description = v('description');
      if (v('qty')) { out.qty = parseNum(v('qty')); if (!(out.qty > 0)) err.qty = 'الكمية يجب أن تكون رقمًا أكبر من صفر'; }
      out.unit = v('unit');
      if (v('unitPrice')) { out.unitPrice = parseNum(v('unitPrice')); if (!(out.unitPrice > 0)) err.unitPrice = 'سعر الوحدة يجب أن يكون رقمًا أكبر من صفر'; }
      if (v('currency')) { out.currency = normCurrency(v('currency')); if (!out.currency) err.currency = 'العملة غير مدعومة — المتاح: USD أو EUR أو CNY أو AED أو SAR'; }
      out.country = normCountry(v('country'));
      out.weight = 0;
      if (v('weight')) { out.weight = parseNum(v('weight')); if (!(out.weight > 0)) err.weight = 'الوزن يجب أن يكون رقمًا أكبر من صفر'; }
      out.dutyRate = null;
      if (v('dutyRate')) {
        var d = parseNum(v('dutyRate'));
        if (!(d >= 0) || d > 100) err.dutyRate = 'نسبة الرسوم يجب أن تكون بين 0 و 100';
        else out.dutyRate = d > 0 && d < 1 && /[.,٫]/.test(v('dutyRate')) && !/%/.test(v('dutyRate')) ? d * 100 : d;
      }
      if (out.dutyRate == null && !err.dutyRate) warn.dutyRate = 'لا توجد نسبة رسوم — تُطبَّق النسبة الافتراضية';
      return { err: err, warn: warn, out: out };
    }

    function validateRow(row) {
      var r = state.type === 'items' ? validateItem(row) : validateShipment(row);
      row.err = r.err; row.warn = r.warn; row.out = r.out;
      row.status = Object.keys(r.err).length ? 'error' : (Object.keys(r.warn).length ? 'warn' : 'ok');
    }

    /* invoice items: CIF (SAR) with freight allocation, duty, VAT */
    function settings() {
      var d = parseNum($('it-default-duty').value);
      var f = parseNum($('it-freight').value);
      return { duty: d >= 0 && d <= 100 ? d : 5, freight: f > 0 ? f : 0 };
    }
    function computeItems() {
      if (state.type !== 'items') return null;
      var s = settings();
      var base = 0;
      state.rows.forEach(function (r) {
        r.calc = null;
        if (r.status === 'error') return;
        var o = r.out, rate = RATES[o.currency] || 0;
        var foreign = o.qty * o.unitPrice;
        r.calc = { foreign: foreign, rate: rate, valueSAR: foreign * rate };
        base += r.calc.valueSAR;
      });
      var tot = { lines: 0, valueSAR: 0, freight: 0, cif: 0, duty: 0, vat: 0, taxes: 0, weight: 0 };
      state.rows.forEach(function (r) {
        if (!r.calc) return;
        var c = r.calc;
        c.freight = base ? s.freight * c.valueSAR / base : 0;
        c.cif = c.valueSAR + c.freight;
        c.dutyRate = r.out.dutyRate != null ? r.out.dutyRate : s.duty;
        c.duty = c.cif * c.dutyRate / 100;
        c.vat = (c.cif + c.duty) * VAT_RATE;
        c.taxes = c.duty + c.vat;
        tot.lines++; tot.valueSAR += c.valueSAR; tot.freight += c.freight; tot.cif += c.cif; tot.duty += c.duty; tot.vat += c.vat; tot.taxes += c.taxes; tot.weight += r.out.weight || 0;
      });
      state.totals = tot;
      return tot;
    }

    /* ---------------------------------------------------------------
       File reading
       --------------------------------------------------------------- */
    function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
    function readBuffer(file) {
      if (file.arrayBuffer) return file.arrayBuffer();
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(fr.result); };
        fr.onerror = function () { rej(fr.error); };
        fr.readAsArrayBuffer(file);
      });
    }
    function cellText(v) {
      if (v == null) return '';
      if (typeof v === 'object') return Array.isArray(v) ? v.join('، ') : (v.label || v.name || v.text || JSON.stringify(v));
      return String(v);
    }
    function jsonToRows(data) {
      if (!Array.isArray(data) && data && typeof data === 'object') {
        var arrKey = Object.keys(data).filter(function (k) { return Array.isArray(data[k]); })[0];
        data = arrKey ? data[arrKey] : [data];
      }
      if (!Array.isArray(data)) throw new Error('ملف JSON يجب أن يحتوي على مصفوفة من الكائنات.');
      if (data.every(Array.isArray)) return data.map(function (r) { return r.map(cellText); });
      var heads = [], seen = {};
      var flat = data.filter(function (o) { return o && typeof o === 'object'; }).map(function (o) {
        var f = {};
        Object.keys(o).forEach(function (k) {
          var val = o[k];
          if (val && typeof val === 'object' && !Array.isArray(val) && !val.label && !val.name) {
            Object.keys(val).forEach(function (k2) { if (f[k2] == null) f[k2] = val[k2]; });
          } else f[k] = val;
        });
        Object.keys(f).forEach(function (k) { if (!seen[k]) { seen[k] = true; heads.push(k); } });
        return f;
      });
      return [heads].concat(flat.map(function (o) { return heads.map(function (h) { return cellText(o[h]); }); }));
    }
    function htmlTables(text) {
      var doc = new DOMParser().parseFromString(text, 'text/html');
      return qsa('table', doc).map(function (t, i) {
        return { name: 'جدول ' + (i + 1), rows: qsa('tr', t).map(function (tr) { return qsa('th,td', tr).map(function (td) { return td.textContent.replace(/\s+/g, ' ').trim(); }); }) };
      });
    }
    function firstNonEmpty(sheets) {
      for (var i = 0; i < sheets.length; i++) if (!sheets[i].hidden && sheets[i].rows.some(function (r) { return r.some(function (c) { return str(c); }); })) return i;
      for (var j = 0; j < sheets.length; j++) if (sheets[j].rows.length) return j;
      return 0;
    }

    function parseFile(file) {
      var ext = extOf(file.name);
      return readBuffer(file).then(function (buf) {
        if (!buf.byteLength) throw new Error('الملف فارغ.');
        var kind = X.sniff(buf);
        if (kind === 'xls') throw new Error('صيغة ‎.xls‎ القديمة غير مدعومة. افتح الملف في Excel واختر «حفظ باسم» ثم صيغة ‎.xlsx‎ أو CSV UTF-8، وارفعه مرة أخرى.');
        if (kind === 'xlsx') {
          if (!X.canRead()) throw new Error('متصفحك لا يدعم قراءة ملفات Excel مباشرة. احفظ الملف بصيغة CSV UTF-8 ثم ارفعه، أو حدّث المتصفح.');
          return X.read(buf).then(function (wb) { return { kind: 'Excel', sheets: wb.sheets }; });
        }
        var text = X.decodeText(buf);
        if (kind === 'html') {
          var tables = htmlTables(text);
          if (tables.length) return { kind: 'HTML', sheets: tables };
        }
        var trimmed = text.replace(/^\s+/, '');
        if (ext === 'json' || /^[\[{]/.test(trimmed)) {
          var data;
          try { data = JSON.parse(trimmed); }
          catch (e) {
            if (ext === 'json') throw new Error('ملف JSON غير صالح: تحقق من الأقواس والفواصل.');
            data = null;
          }
          if (data !== null) return { kind: 'JSON', sheets: [{ name: 'JSON', rows: jsonToRows(data) }] };
        }
        var parsed = X.parseDelimited(text, ext === 'tsv' ? '\t' : null);
        var dl = { ',': 'فاصلة', ';': 'فاصلة منقوطة', '\t': 'Tab', '|': 'خط عمودي' }[parsed.delimiter] || parsed.delimiter;
        return { kind: 'CSV · ' + dl, sheets: [{ name: file.name, rows: parsed.rows }] };
      });
    }

    function addFiles(list) {
      var arr = Array.prototype.slice.call(list || []);
      if (!arr.length) return;
      var dupes = [];
      arr.forEach(function (file) {
        var ext = extOf(file.name);
        var lm = file.lastModified || 0;
        if (state.files.some(function (f) { return f.status !== 'error' && f.name === file.name && f.size === file.size && f.lastModified === lm; })) { dupes.push(file.name); return; }
        // the File object is kept (in memory only) so the online upload can fingerprint the original bytes
        var entry = { id: 'f' + (++seq), name: file.name, size: file.size, lastModified: lm, status: 'loading', sheets: [], sheetIdx: 0, file: file };
        state.files.push(entry);
        if (ALLOWED.indexOf(ext) === -1) {
          entry.status = 'error';
          entry.error = 'صيغة غير مدعومة. الصيغ المتاحة: ‎.xlsx‎ و ‎.csv‎ و ‎.tsv‎ و ‎.txt‎ و ‎.json‎.';
          return;
        }
        if (file.size > MAX_FILE) {
          entry.status = 'error';
          entry.error = 'حجم الملف أكبر من ' + fmtSize(MAX_FILE) + '. قسّمه إلى ملفات أصغر.';
          return;
        }
        parseFile(file).then(function (res) {
          entry.kind = res.kind;
          entry.sheets = (res.sheets || []).map(function (s) { return { name: s.name, hidden: !!s.hidden, rows: s.rows || [] }; });
          entry.sheetIdx = firstNonEmpty(entry.sheets);
          var rowsCount = entry.sheets[entry.sheetIdx] ? entry.sheets[entry.sheetIdx].rows.length : 0;
          if (!rowsCount) { entry.status = 'error'; entry.error = 'لم نجد بيانات داخل الملف.'; }
          else entry.status = 'ok';
        }).catch(function (e) {
          entry.status = 'error';
          entry.error = (e && e.message) || 'تعذّرت قراءة الملف.';
        }).then(function () {
          rebuild();
          if (entry.status === 'ok') toast('تمت قراءة «' + entry.name + '»', 'success');
          else toast('«' + entry.name + '»: ' + entry.error, 'error');
        });
      });
      if (dupes.length) toast('تم تجاهل ملف مرفوع مسبقًا: «' + dupes.join('»، «') + '»', 'warning');
      renderFiles();
    }

    /* ---------------------------------------------------------------
       Header detection + auto-mapping
       --------------------------------------------------------------- */
    function scoreHeader(n) {
      var best = null, bestScore = 0;
      fields().forEach(function (f) {
        f.nsyn.forEach(function (s) {
          var sc = 0;
          if (s === n) sc = 1000 + s.length;
          else if (s.length >= 3 && hasWord(n, s)) sc = s.length * 10;
          else if (s.length >= 5 && n.indexOf(s) !== -1) sc = s.length;
          if (sc > bestScore) { bestScore = sc; best = f.key; }
        });
      });
      return { field: best, score: bestScore };
    }
    function detectHeaderRow(rows) {
      var bestIdx = -1, best = 0, firstIdx = -1;
      for (var i = 0; i < Math.min(rows.length, 15); i++) {
        var r = rows[i] || [];
        var filled = r.filter(function (c) { return str(c); });
        if (!filled.length) continue;
        if (firstIdx < 0) firstIdx = i;
        var hits = filled.filter(function (c) { return scoreHeader(normAr(c)).score >= 30; }).length;
        if (hits > best) { best = hits; bestIdx = i; }
      }
      return best >= 2 ? bestIdx : firstIdx;
    }

    function rebuild() {
      var headers = [], hIndex = {}, rows = [];
      state.files.forEach(function (f) {
        if (f.status !== 'ok') return;
        var sheet = f.sheets[f.sheetIdx];
        if (!sheet) return;
        var data = sheet.rows;
        var hr = detectHeaderRow(data);
        if (hr < 0) return;
        var used = {};
        var keys = (data[hr] || []).map(function (h, ci) {
          var label = str(h) || ('عمود ' + (ci + 1));
          var key = normAr(label) || ('col' + (ci + 1));
          if (used[key]) { used[key]++; key = key + ' #' + used[key]; label = label + ' (' + used[key] + ')'; } else used[key] = 1;
          if (!hIndex[key]) { hIndex[key] = { key: key, label: label, sample: '', files: {} }; headers.push(hIndex[key]); }
          hIndex[key].files[f.id] = true;
          return key;
        });
        var count = 0;
        for (var r = hr + 1; r < data.length; r++) {
          var cells = data[r] || [];
          if (!cells.some(function (c) { return str(c); })) continue;
          var rowKey = f.id + '|' + f.sheetIdx + '|' + (r + 1);
          if (state.deleted[rowKey]) continue;
          var raw = {};
          keys.forEach(function (k, ci) {
            raw[k] = cells[ci] == null ? '' : String(cells[ci]);
            if (!hIndex[k].sample && str(raw[k])) hIndex[k].sample = str(raw[k]);
          });
          rows.push({ key: rowKey, fileId: f.id, fileName: f.name, sheet: f.sheets.length > 1 ? sheet.name : '', rowNum: r + 1, raw: raw });
          count++;
        }
        f.dataRows = count;
        f.headerRow = hr + 1;
      });
      state.headers = headers;
      state.rows = rows;
      autoMap();
      validateAll();
      renderAll();
    }

    function autoMap() {
      var um = state.userMap[state.type];
      var map = {};
      state.headers.forEach(function (h) {
        var s = scoreHeader(h.key);
        h.auto = s.score >= 10 ? s.field : '';
        h.score = s.score;
        // content check: a "container" column holding ISO 6346 numbers is container numbers, one holding 20/40/LCL is the type
        if (state.type === 'shipments' && h.sample) {
          if (h.auto === 'containerType' && looksLikeContainerNo(h.sample)) h.auto = 'containerNumbers';
          else if (h.auto === 'containerNumbers' && !looksLikeContainerNo(h.sample) && normContainer(h.sample)) h.auto = 'containerType';
        }
        map[h.key] = Object.prototype.hasOwnProperty.call(um, h.key) ? um[h.key] : h.auto;
      });
      // one field per file: keep the best scoring auto-mapped header
      state.files.forEach(function (f) {
        var byField = {};
        state.headers.forEach(function (h) {
          if (!h.files[f.id] || !map[h.key] || Object.prototype.hasOwnProperty.call(um, h.key)) return;
          var other = byField[map[h.key]];
          if (!other) byField[map[h.key]] = h;
          else if (h.score > other.score) { map[other.key] = ''; byField[map[h.key]] = h; }
          else map[h.key] = '';
        });
      });
      state.map = map;
    }
    function mappedFields() {
      var m = {};
      Object.keys(state.map).forEach(function (k) { if (state.map[k]) m[state.map[k]] = true; });
      return m;
    }
    function validateAll() {
      state.rows.forEach(validateRow);
      computeItems();
    }

    /* ---------------------------------------------------------------
       Rendering
       --------------------------------------------------------------- */
    var ICON_FILE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>';
    var ICON_WARN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/></svg>';
    var ICON_X = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    var ICON_TRASH = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
    var ICON_OK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

    function renderFiles() {
      var ul = $('bu-files');
      ul.innerHTML = state.files.map(function (f) {
        var meta = '';
        if (f.status === 'loading') meta = '<span class="file-loading">جارٍ القراءة…</span>';
        else if (f.status === 'ok') {
          meta = '<span class="file-info">' + esc(f.kind || '') + ' · <span class="num">' + fmtNum(f.dataRows || 0, 0) + '</span> صف</span>';
          if (f.sheets.length > 1) {
            meta += '<label class="bu-sheet">الورقة: <select data-sheet="' + f.id + '" aria-label="اختيار ورقة العمل من ' + esc(f.name) + '">' +
              f.sheets.map(function (s, i) {
                var n = s.rows.filter(function (r) { return r.length; }).length;
                return '<option value="' + i + '"' + (i === f.sheetIdx ? ' selected' : '') + '>' + esc(s.name) + ' (' + n + ')' + (s.hidden ? ' — مخفية' : '') + '</option>';
              }).join('') + '</select></label>';
          }
        }
        return '<li class="file-item' + (f.status === 'error' ? ' is-error' : '') + '">' + (f.status === 'error' ? ICON_WARN : ICON_FILE) +
          '<div class="file-meta"><span class="file-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span><span class="file-size num">' + fmtSize(f.size) + '</span>' + meta + '</div>' +
          '<button type="button" class="file-remove" data-remove="' + f.id + '" aria-label="إزالة الملف ' + esc(f.name) + '">' + ICON_X + '</button>' +
          (f.status === 'error' ? '<p class="file-err" role="alert">' + esc(f.error) + '</p>' : '') + '</li>';
      }).join('');
    }

    var mapToggled = false;
    function renderMapping() {
      var has = state.headers.length > 0;
      $('bu-mapping-block').hidden = !has;
      if (!has) return;
      var opts = function (sel) {
        return '<option value=""' + (sel ? '' : ' selected') + '>— تجاهل —</option>' + fields().map(function (f) {
          return '<option value="' + f.key + '"' + (sel === f.key ? ' selected' : '') + '>' + esc(f.label) + (f.req ? ' *' : '') + '</option>';
        }).join('');
      };
      $('bu-mapping').innerHTML = state.headers.map(function (h, i) {
        var sel = state.map[h.key] || '';
        return '<div class="bu-map' + (sel ? (sel === h.auto ? ' is-auto' : '') : ' is-ignored') + '">' +
          '<div class="bu-map-src"><label for="map-' + i + '" title="' + esc(h.label) + '">' + esc(h.label) + '</label>' +
          (h.sample ? '<span class="bu-map-sample" title="' + esc(h.sample) + '">مثال: ' + esc(h.sample) + '</span>' : '') + '</div>' +
          '<select id="map-' + i + '" data-map="' + esc(h.key) + '">' + opts(sel) + '</select></div>';
      }).join('');
      var mf = mappedFields();
      var missing = fields().filter(function (f) { return f.req && !mf[f.key]; }).length;
      var used = state.headers.filter(function (h) { return state.map[h.key]; }).length;
      $('bu-map-summary').textContent = 'تمت مطابقة ' + used + ' من ' + state.headers.length + ' عمودًا' + (missing ? ' — ' + missing + ' حقل مطلوب غير مربوط' : '') + ' (اضغط للعرض والتعديل)';
      if (!mapToggled) $('bu-map-details').open = missing > 0;
      $('bu-required').innerHTML = '<span class="text-sm text-muted">الحقول المطلوبة:</span> ' + fields().filter(function (f) { return f.req; }).map(function (f) {
        return mf[f.key] ? '<span class="bu-req is-ok">' + ICON_OK + esc(f.label) + '</span>'
          : '<span class="bu-req is-missing">' + ICON_WARN + esc(f.label) + ' — غير مربوط</span>';
      }).join('');
    }

    function displayValue(row, f) { return valueOf(row, f.key); }
    function filteredRows() {
      if (state.filter === 'valid') return state.rows.filter(function (r) { return r.status !== 'error'; });
      if (state.filter === 'error') return state.rows.filter(function (r) { return r.status === 'error'; });
      return state.rows;
    }
    function statusBadge(s) {
      if (s === 'error') return '<span class="badge badge-danger">خطأ</span>';
      if (s === 'warn') return '<span class="badge badge-warning">تحذير</span>';
      return '<span class="badge badge-success">صالح</span>';
    }
    function notesHtml(row) {
      var out = '';
      Object.keys(row.err).forEach(function (k) { out += '<span class="e">• ' + esc(row.err[k]) + '</span>'; });
      Object.keys(row.warn).forEach(function (k) { out += '<span class="w">• ' + esc(row.warn[k]) + '</span>'; });
      return out || '<span class="text-muted">—</span>';
    }
    function calcCells(row) {
      if (state.type !== 'items') return '';
      var c = row.calc;
      var cell = function (v, cls) { return '<td class="num bu-calc' + (cls ? ' ' + cls : '') + '">' + (c ? fmtNum(v, 2) : '—') + '</td>'; };
      return cell(c && c.cif, 'c-cif') + '<td class="num c-rate">' + (c ? fmtNum(c.dutyRate, 2) + '%' : '—') + '</td>' + cell(c && c.duty, 'c-duty') + cell(c && c.vat, 'c-vat') + cell(c && c.taxes, 'c-taxes');
    }
    function rowHtml(row, i) {
      var cls = row.status === 'error' ? 'is-error' : (row.status === 'warn' ? 'is-warn' : '');
      var src = esc(row.fileName) + (row.sheet ? ' / ' + esc(row.sheet) : '') + ' · ص ' + row.rowNum;
      var cells = fields().map(function (f) {
        var e = row.err[f.key], w = row.warn[f.key];
        var c = 'bu-cell' + (f.wide ? ' is-wide' : '') + (f.num || f.ltr ? ' is-num' : '') + (e ? ' has-error' : (w ? ' has-warn' : ''));
        return '<td><input class="' + c + '" type="text" data-f="' + f.key + '" value="' + esc(displayValue(row, f)) + '"' +
          ' aria-label="' + esc(f.label) + ' — صف ' + row.rowNum + ' من ' + esc(row.fileName) + '"' +
          (e ? ' aria-invalid="true" title="' + esc(e) + '"' : (w ? ' title="' + esc(w) + '"' : '')) + '></td>';
      }).join('');
      return '<tr class="' + cls + '" data-key="' + esc(row.key) + '"><td class="num bu-idx">' + (i + 1) + '</td><td class="bu-src" title="' + src + '">' + src + '</td>' +
        '<td class="bu-st">' + statusBadge(row.status) + '</td>' + cells + calcCells(row) +
        '<td class="bu-notes">' + notesHtml(row) + '</td>' +
        '<td><button type="button" class="bu-del" data-del="' + esc(row.key) + '" aria-label="حذف الصف ' + row.rowNum + ' من ' + esc(row.fileName) + '">' + ICON_TRASH + '</button></td></tr>';
    }
    function renderTable() {
      var mf = mappedFields();
      var calcHead = state.type === 'items' ? '<th scope="col" class="num">CIF (ر.س)</th><th scope="col" class="num">نسبة الرسوم</th><th scope="col" class="num">الرسوم الجمركية</th><th scope="col" class="num">ضريبة 15%</th><th scope="col" class="num">إجمالي الضرائب</th>' : '';
      $('bu-thead').innerHTML = '<tr><th scope="col">#</th><th scope="col">المصدر</th><th scope="col">الحالة</th>' +
        fields().map(function (f) {
          return '<th scope="col"' + (f.req && !mf[f.key] ? ' class="is-unmapped" title="هذا الحقل المطلوب غير مربوط بأي عمود"' : '') + '>' + esc(f.label) + (f.req ? ' <span class="req" aria-hidden="true">*</span>' : '') + '</th>';
        }).join('') + calcHead + '<th scope="col">الملاحظات</th><th scope="col"><span class="sr-only">حذف</span></th></tr>';
      var list = filteredRows();
      var shown = list.slice(0, RENDER_LIMIT);
      var colspan = 5 + fields().length + (state.type === 'items' ? 5 : 0);
      $('bu-tbody').innerHTML = shown.length ? shown.map(rowHtml).join('')
        : '<tr><td class="bu-empty" colspan="' + colspan + '">' + (state.rows.length ? 'لا توجد صفوف ضمن هذا التصنيف.' : 'لا توجد صفوف بيانات بعد.') + '</td></tr>';
      var note = $('bu-limit-note');
      note.hidden = list.length <= RENDER_LIMIT;
      if (!note.hidden) note.textContent = 'يُعرض أول ' + fmtNum(RENDER_LIMIT, 0) + ' صف من ' + fmtNum(list.length, 0) + ' للحفاظ على سرعة الصفحة. التحقق والحفظ والتصدير تشمل جميع الصفوف؛ استخدم «الأخطاء» لعرض الصفوف التي تحتاج تصحيحًا.';
      renderFoot();
    }
    function renderFoot() {
      var tf = $('bu-tfoot');
      if (state.type !== 'items' || !state.totals || !state.totals.lines) { tf.innerHTML = ''; return; }
      var t = state.totals;
      var span = 3 + fields().length;
      tf.innerHTML = '<tr><td colspan="' + span + '">الإجمالي (' + plural(t.lines, 'صنف واحد', 'صنفان', 'أصناف', 'صنفًا') + ')</td><td class="num">' + fmtNum(t.cif, 2) + '</td><td></td><td class="num">' + fmtNum(t.duty, 2) + '</td><td class="num">' + fmtNum(t.vat, 2) + '</td><td class="num">' + fmtNum(t.taxes, 2) + '</td><td colspan="2"></td></tr>';
    }
    function renderTotals() {
      if (state.type !== 'items') return;
      var t = state.totals || { lines: 0, valueSAR: 0, freight: 0, cif: 0, duty: 0, vat: 0, taxes: 0 };
      $('bu-totals').innerHTML = [
        ['الأصناف المحتسبة', t.lines ? plural(t.lines, 'صنف واحد', 'صنفان', 'أصناف', 'صنفًا') : 'لا يوجد'],
        ['قيمة البضاعة (بالريال)', fmtSAR(t.valueSAR)],
        ['الشحن والتأمين الموزّع', fmtSAR(t.freight)],
        ['القيمة الجمركية التقديرية CIF', fmtSAR(t.cif)],
        ['الرسوم الجمركية', fmtSAR(t.duty)],
        ['ضريبة القيمة المضافة 15%', fmtSAR(t.vat)],
        ['إجمالي الرسوم والضرائب', fmtSAR(t.taxes), true]
      ].map(function (x) { return '<li><span class="k">' + x[0] + '</span><span class="v' + (x[2] ? ' total' : '') + '">' + x[1] + '</span></li>'; }).join('');
    }
    function counts() {
      var c = { all: state.rows.length, ok: 0, warn: 0, error: 0 };
      state.rows.forEach(function (r) { c[r.status]++; });
      c.valid = c.ok + c.warn;
      return c;
    }
    function renderStats() {
      var c = counts();
      $('st-files').textContent = state.files.filter(function (f) { return f.status === 'ok'; }).length;
      $('st-rows').textContent = fmtNum(c.all, 0);
      $('st-valid').textContent = fmtNum(c.valid, 0);
      $('st-warn').textContent = fmtNum(c.warn, 0);
      $('st-errors').textContent = fmtNum(c.error, 0);
      qsa('[data-n]').forEach(function (s) { s.textContent = fmtNum(c[s.getAttribute('data-n')] || 0, 0); });
      $('submit-count').textContent = '(' + fmtNum(c.valid, 0) + ')';
      $('btn-submit').disabled = !c.valid;
      $('btn-export-errors').disabled = !c.error;
      renderTotals();
    }
    function renderAll() {
      renderFiles();
      renderMapping();
      var has = state.rows.length > 0 || state.headers.length > 0;
      $('bu-preview-block').hidden = !has;
      $('bu-items-panel').hidden = state.type !== 'items';
      $('bu-actions-shipments').hidden = state.type !== 'shipments';
      $('bu-actions-items').hidden = state.type !== 'items';
      if (has) renderTable();
      renderStats();
    }

    /* update a single row in place (keeps focus while tabbing between cells) */
    function updateRowDom(tr, row) {
      tr.className = row.status === 'error' ? 'is-error' : (row.status === 'warn' ? 'is-warn' : '');
      tr.querySelector('.bu-st').innerHTML = statusBadge(row.status);
      tr.querySelector('.bu-notes').innerHTML = notesHtml(row);
      qsa('.bu-cell', tr).forEach(function (inp) {
        var k = inp.getAttribute('data-f'), e = row.err[k], w = row.warn[k];
        inp.classList.toggle('has-error', !!e);
        inp.classList.toggle('has-warn', !e && !!w);
        if (e) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid');
        if (e || w) inp.title = e || w; else inp.removeAttribute('title');
      });
    }
    function refreshCalcDom() {
      if (state.type !== 'items') return;
      qsa('#bu-tbody tr[data-key]').forEach(function (tr) {
        var row = rowByKey(tr.getAttribute('data-key'));
        if (!row) return;
        var c = row.calc;
        var set = function (sel, v) { var td = tr.querySelector(sel); if (td) td.textContent = v; };
        set('.c-cif', c ? fmtNum(c.cif, 2) : '—');
        set('.c-rate', c ? fmtNum(c.dutyRate, 2) + '%' : '—');
        set('.c-duty', c ? fmtNum(c.duty, 2) : '—');
        set('.c-vat', c ? fmtNum(c.vat, 2) : '—');
        set('.c-taxes', c ? fmtNum(c.taxes, 2) : '—');
      });
      renderFoot();
    }
    function rowByKey(k) {
      for (var i = 0; i < state.rows.length; i++) if (state.rows[i].key === k) return state.rows[i];
      return null;
    }

    /* ---------------------------------------------------------------
       Events: type, files, mapping, table
       --------------------------------------------------------------- */
    function syncTypeUI() {
      $('template-desc').textContent = state.type === 'items'
        ? 'أعمدة بنود الفاتورة (رمز HS، الوصف، الكمية، السعر، العملة…) مع صفّين كمثال.'
        : 'أعمدة طلبات التخليص (العميل، الجوال، المنفذ، القيمة…) مع صفّين كمثال.';
    }
    qsa('input[name="bu-type"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        state.type = r.value;
        state.filter = 'all';
        setFilterUI();
        syncTypeUI();
        autoMap();
        validateAll();
        renderAll();
      });
    });

    var dz = $('bu-dropzone'), input = $('bu-file');
    input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-dragover'); });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { if (!dz.contains(e.relatedTarget)) dz.classList.remove('is-dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dz.classList.remove('is-dragover');
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
    // keep browsers from opening a file dropped just outside the zone
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('bu-files').addEventListener('click', function (e) {
      var b = e.target.closest('[data-remove]');
      if (!b) return;
      var id = b.getAttribute('data-remove');
      var f = state.files.filter(function (x) { return x.id === id; })[0];
      state.files = state.files.filter(function (x) { return x.id !== id; });
      rebuild();
      toast('تمت إزالة «' + (f ? f.name : '') + '»', 'info');
      input.focus();
    });
    $('bu-files').addEventListener('change', function (e) {
      var s = e.target.closest('[data-sheet]');
      if (!s) return;
      var f = state.files.filter(function (x) { return x.id === s.getAttribute('data-sheet'); })[0];
      if (f) { f.sheetIdx = parseInt(s.value, 10) || 0; rebuild(); }
    });

    $('bu-map-details').addEventListener('click', function (e) { if (e.target.closest('summary')) mapToggled = true; });
    $('bu-mapping').addEventListener('change', function (e) {
      var s = e.target.closest('[data-map]');
      if (!s) return;
      var key = s.getAttribute('data-map');
      state.userMap[state.type][key] = s.value;
      state.map[key] = s.value;
      validateAll();
      var focusId = s.id;
      renderAll();
      var again = $(focusId);
      if (again) again.focus();
    });

    var tbody = $('bu-tbody');
    function commitCell(e) {
      var inp = e.target;
      if (!inp.classList || !inp.classList.contains('bu-cell')) return;
      var tr = inp.closest('tr'), row = rowByKey(tr.getAttribute('data-key'));
      if (!row) return;
      var k = inp.getAttribute('data-f');
      if (str(inp.value) === valueOf(row, k)) return;
      var ed = state.edits[row.key] || (state.edits[row.key] = {});
      ed[k] = inp.value;
      var before = row.status;
      validateRow(row);
      computeItems();
      updateRowDom(tr, row);
      refreshCalcDom();
      renderStats();
      if (before === 'error' && row.status !== 'error') toast('تم تصحيح الصف ' + row.rowNum + ' من «' + row.fileName + '»', 'success');
    }
    tbody.addEventListener('focusout', commitCell);
    tbody.addEventListener('change', commitCell);
    tbody.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('bu-cell')) { e.preventDefault(); e.target.blur(); }
    });
    tbody.addEventListener('click', function (e) {
      var b = e.target.closest('[data-del]');
      if (!b) return;
      var key = b.getAttribute('data-del');
      state.deleted[key] = true;
      state.rows = state.rows.filter(function (r) { return r.key !== key; });
      computeItems();
      renderTable();
      renderStats();
      toast('تم حذف الصف', 'info');
    });

    function setFilterUI() {
      qsa('.bu-filters .chip').forEach(function (c) {
        var on = c.getAttribute('data-filter') === state.filter;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    qsa('.bu-filters .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        state.filter = c.getAttribute('data-filter');
        setFilterUI();
        renderTable();
      });
    });

    ['it-default-duty', 'it-freight'].forEach(function (id) {
      $(id).addEventListener('input', function () { computeItems(); refreshCalcDom(); renderTotals(); });
    });

    /* ---------------------------------------------------------------
       Templates + exports
       --------------------------------------------------------------- */
    function headerLabels() { return fields().map(function (f) { return f.label; }); }
    $('tpl-xlsx').addEventListener('click', function () {
      var rows = [headerLabels()].concat(TEMPLATES[state.type]);
      downloadXlsx(rows, state.type === 'items' ? 'بنود الفاتورة' : 'طلبات التخليص', 'marsa-template-' + state.type + '.xlsx');
      toast('تم تنزيل نموذج Excel', 'success');
    });
    $('tpl-csv').addEventListener('click', function () {
      downloadCsv([headerLabels()].concat(TEMPLATES[state.type]), 'marsa-template-' + state.type + '.csv');
      toast('تم تنزيل نموذج CSV', 'success');
    });

    $('btn-export-errors').addEventListener('click', function () {
      var bad = state.rows.filter(function (r) { return r.status === 'error'; });
      if (!bad.length) { toast('لا توجد صفوف بها أخطاء.', 'info'); return; }
      var rows = [headerLabels().concat(['سبب الخطأ', 'الملف', 'رقم الصف'])].concat(bad.map(function (r) {
        return fields().map(function (f) { return valueOf(r, f.key); }).concat([
          Object.keys(r.err).map(function (k) { return r.err[k]; }).join(' | '), r.fileName + (r.sheet ? ' / ' + r.sheet : ''), r.rowNum
        ]);
      }));
      downloadXlsx(rows, 'الأخطاء', 'marsa-errors-' + stamp() + '.xlsx');
      toast('تم تصدير ' + plural(bad.length, 'صف واحد', 'صفّين', 'صفوف', 'صفًا') + ' بها أخطاء', 'success');
    });

    function itemsExportRows() {
      var head = headerLabels().concat(['سعر الصرف', 'القيمة (ر.س)', 'الشحن والتأمين (ر.س)', 'CIF (ر.س)', 'نسبة الرسوم المطبقة %', 'الرسوم الجمركية (ر.س)', 'ضريبة القيمة المضافة 15% (ر.س)', 'إجمالي الرسوم والضرائب (ر.س)', 'الحالة', 'الملاحظات', 'الملف', 'رقم الصف']);
      var r2 = function (n) { return Math.round(n * 100) / 100; };
      var body = state.rows.map(function (r) {
        var c = r.calc;
        var vals = fields().map(function (f) {
          var o = r.out[f.key];
          if (r.status !== 'error' && (f.key === 'qty' || f.key === 'unitPrice' || f.key === 'weight') && typeof o === 'number' && o) return o;
          if (f.key === 'currency' && o) return o;
          return valueOf(r, f.key);
        });
        var notes = Object.keys(r.err).map(function (k) { return r.err[k]; }).concat(Object.keys(r.warn).map(function (k) { return r.warn[k]; })).join(' | ');
        return vals.concat(c ? [c.rate, r2(c.valueSAR), r2(c.freight), r2(c.cif), c.dutyRate, r2(c.duty), r2(c.vat), r2(c.taxes)] : ['', '', '', '', '', '', '', ''])
          .concat([r.status === 'error' ? 'خطأ' : (r.status === 'warn' ? 'تحذير' : 'صالح'), notes, r.fileName, r.rowNum]);
      });
      var t = state.totals || {};
      var total = headerLabels().map(function (_, i) { return i === 0 ? 'الإجمالي' : ''; }).concat(['', r2(t.valueSAR || 0), r2(t.freight || 0), r2(t.cif || 0), '', r2(t.duty || 0), r2(t.vat || 0), r2(t.taxes || 0), '', '', '', '']);
      return [head].concat(body, [total]);
    }
    $('btn-items-xlsx').addEventListener('click', function () {
      if (!state.rows.length) return;
      downloadXlsx(itemsExportRows(), 'تقدير الرسوم', 'marsa-items-' + stamp() + '.xlsx');
      toast('تم تصدير النتائج إلى Excel', 'success');
    });
    $('btn-items-csv').addEventListener('click', function () {
      if (!state.rows.length) return;
      downloadCsv(itemsExportRows(), 'marsa-items-' + stamp() + '.csv');
      toast('تم تصدير النتائج إلى CSV', 'success');
    });
    $('btn-items-request').addEventListener('click', function () {
      var t = state.totals;
      if (!t || !t.lines) { toast('لا توجد أصناف صالحة لنقلها.', 'warning'); return; }
      var valid = state.rows.filter(function (r) { return r.calc; });
      var hs = valid.map(function (r) { return r.out.hsCode; }).filter(Boolean)[0] || '';
      var names = valid.slice(0, 3).map(function (r) { return r.out.description; }).join('، ');
      var draft = {
        source: 'bulk-items',
        inputs: {
          value: Math.round(t.cif * 100) / 100, currency: 'SAR', hsCode: hs,
          description: valid.length + ' أصناف: ' + names + (valid.length > 3 ? '…' : '')
        },
        results: { cif: t.cif, duty: t.duty, vat: t.vat, total: t.cif + t.duty + t.vat },
        savedAt: new Date().toISOString()
      };
      try { localStorage.setItem('marsa_calc_draft', JSON.stringify(draft)); }
      catch (e) { toast('تعذّر الحفظ في المتصفح.', 'error'); return; }
      toast('تم تجهيز ملخص الأصناف، جاري فتح طلب التخليص…', 'success');
      setTimeout(function () { window.location.href = 'request.html?from=calculator'; }, 700);
    });

    function clearAll() {
      mapToggled = false;
      state.files = []; state.rows = []; state.headers = []; state.edits = {}; state.deleted = {}; state.filter = 'all';
      setFilterUI();
      rebuild();
    }
    $('btn-clear').addEventListener('click', clearAll);
    $('btn-clear-items').addEventListener('click', clearAll);

    /* ---------------------------------------------------------------
       Submit shipments → marsa_requests (request.js record shape)
       --------------------------------------------------------------- */
    function countLabel(o) {
      if (o.mode === 'sea' && o.containerType !== 'LCL') return 'عدد الحاويات';
      if (o.mode === 'land') return 'عدد الشاحنات';
      return 'عدد الطرود';
    }
    function newRef(taken) {
      var ref;
      do { ref = M.genRef ? M.genRef('MRS') : 'MRS-' + new Date().getFullYear() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase(); }
      while (taken[ref]);
      taken[ref] = true;
      return ref;
    }
    function buildRecord(row, batchId, now, taken) {
      var o = row.out, exp = o.direction === 'export';
      var ref = newRef(taken);
      return {
        savedAt: now,
        ref: ref,
        createdAt: now,
        status: 'received',
        statusLabel: 'محفوظ محليًا (نسخة عرض تجريبية)',
        demo: true, savedLocallyOnly: true,
        client: {
          clientType: o.clientType || '', clientTypeLabel: ({ individual: 'فرد', business: 'منشأة' })[o.clientType] || '',
          fullName: o.fullName, company: o.company, phone: o.phone, email: o.email,
          taxId: o.taxId, vatNumber: o.taxId,
          crNumber: o.crNumber, importerCard: o.crNumber,
          contactPref: ''
        },
        shipment: {
          direction: o.direction, directionLabel: DIR_LABEL[o.direction] || '',
          service: o.service, serviceLabel: SERVICES[o.service] ? SERVICES[o.service].label : '',
          mode: o.mode, modeLabel: MODE_LABEL[o.mode] || '',
          country: o.country, port: o.port, goods: o.goods,
          hsCode: o.hsCode,
          declarationNo: exp ? '' : o.declarationNo, // tracking.js reads declarationNo
          needAci: false,
          value: o.value || 0, currency: o.currency,
          weightKg: o.weightKg || 0,
          containerType: o.mode === 'sea' ? o.containerType : '',
          containerNumbers: o.containerNumbers || [],
          containerNo: (o.containerNumbers || []).join(', '), // display/search string for tracking.js
          count: o.count || 0, countLabel: countLabel(o),
          eta: '',
          blNumber: o.blNumber || '',
          shippingLine: o.shippingLine || ''
        },
        documents: { invoice: [], bl: [], packing: [], origin: [], saber: [], other: [] },
        docsLater: true,
        notes: 'طلب محفوظ محليًا عبر الرفع الجماعي (نسخة عرض تجريبية)',
        calc: null,
        source: 'bulk',
        batchId: batchId,
        sourceFile: row.fileName + (row.sheet ? ' / ' + row.sheet : ''),
        sourceRow: row.rowNum
      };
    }

    $('btn-submit').addEventListener('click', function () {
      if (ONLINE) { submitOnline(); return; }
      var ok = state.rows.filter(function (r) { return r.status !== 'error'; });
      if (!ok.length) { toast('لا توجد صفوف صالحة للحفظ. صحّح الأخطاء أولًا.', 'warning'); return; }
      var errs = state.rows.length - ok.length;
      if (errs && !window.confirm('سيتم حفظ ' + plural(ok.length, 'طلب واحد صالح', 'طلبين صالحين', 'طلبات صالحة', 'طلبًا صالحًا') + ' وتجاهل ' + plural(errs, 'صف واحد', 'صفّين', 'صفوف', 'صفًا') + ' بها أخطاء، على هذا الجهاز فقط (نسخة عرض تجريبية — لا يُرسل شيء). هل تريد المتابعة؟')) return;
      var now = new Date().toISOString();
      var batchId = M.genRef ? M.genRef('BLK') : 'BLK-' + Date.now();
      try {
        var list = JSON.parse(localStorage.getItem('marsa_requests') || '[]');
        if (!Array.isArray(list)) list = [];
        var taken = {};
        list.forEach(function (x) { if (x && x.ref) taken[x.ref] = true; });
        var records = ok.map(function (r) { return buildRecord(r, batchId, now, taken); });
        localStorage.setItem('marsa_requests', JSON.stringify(list.concat(records)));
      } catch (e) {
        showSaveError();
        return;
      }
      $('bu-save-error').hidden = true;
      var meta = {
        batchId: batchId, createdAt: now, type: 'shipments',
        files: state.files.filter(function (f) { return f.status === 'ok'; }).map(function (f) { return { name: f.name, size: f.size, sheet: f.sheets[f.sheetIdx] ? f.sheets[f.sheetIdx].name : '' }; }),
        totalRows: state.rows.length, submitted: records.length, skipped: errs,
        refs: records.map(function (r) { return r.ref; })
      };
      if (M.saveLocal) M.saveLocal('marsa_bulk_batches', meta);
      state.lastBatch = { meta: meta, records: records };
      showSuccess();
    });

    function refsRows() {
      var b = state.lastBatch;
      return [['الرقم المرجعي', 'اسم العميل', 'الشركة', 'رقم الجوال', 'منفذ الوصول', 'وصف البضاعة', 'القيمة', 'العملة', 'الملف', 'رقم الصف', 'رقم الدفعة', 'الحالة']].concat(b.records.map(function (r) {
        return [r.ref, r.client.fullName, r.client.company, r.client.phone, r.shipment.port, r.shipment.goods, r.shipment.value, r.shipment.currency, r.sourceFile, r.sourceRow, r.batchId, r.statusLabel];
      }));
    }
    // saving failed: keep the workspace and data, show no batch number / references
    function showSaveError() {
      var box = $('bu-save-error');
      box.hidden = false;
      if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () { box.focus({ preventScroll: true }); }, 80);
      toast('تعذّر الحفظ على هذا الجهاز — لم يُحفظ أي طلب ولم يُرسل شيء. جرّب دفعة أصغر أو فعّل التخزين المحلي.', 'error');
    }
    function showSuccess() {
      var b = state.lastBatch;
      $('bu-workspace').hidden = true;
      var s = $('bu-success');
      s.hidden = false;
      $('success-title').textContent = 'تم حفظ ' + plural(b.records.length, 'طلب تخليص واحد', 'طلبَي تخليص', 'طلبات تخليص', 'طلب تخليص') + ' محليًا';
      $('success-sub').innerHTML = 'تم الحفظ محليًا على هذا الجهاز (نسخة عرض تجريبية) — لم يُرسل إلى أي جهة. رقم الدفعة المحلي: <span class="num fw-bold">' + esc(b.meta.batchId) + '</span>' + (b.meta.skipped ? ' — تم تجاهل ' + plural(b.meta.skipped, 'صف واحد', 'صفّين', 'صفوف', 'صفًا') + ' بها أخطاء.' : '') + ' يمكنك عرض كل طلب برقمه المرجعي المحلي في صفحة التتبع على هذا المتصفح فقط.';
      $('success-refs').innerHTML = b.records.map(function (r) {
        var href = 'tracking.html?id=' + encodeURIComponent(r.ref);
        return '<tr><td class="num fw-bold">' + esc(r.ref) + '</td><td>' + esc(r.client.company || r.client.fullName) + '</td><td>' + esc(r.shipment.port) + '</td><td class="text-muted">' + esc(r.sourceFile) + ' · ص ' + r.sourceRow + '</td><td><a class="link-arrow" href="' + href + '">تتبع</a></td></tr>';
      }).join('');
      var top = card.getBoundingClientRect().top + window.pageYOffset - 100;
      window.scrollTo({ top: top, behavior: 'smooth' });
      setTimeout(function () { s.focus({ preventScroll: true }); }, 80);
      toast('تم الحفظ محليًا على هذا الجهاز (نسخة عرض تجريبية) — لم يُرسل إلى أي جهة. ' + plural(b.records.length, 'طلب واحد', 'طلبان', 'طلبات', 'طلبًا') + ' — رقم الدفعة ' + b.meta.batchId, 'success');
    }
    $('refs-xlsx').addEventListener('click', function () {
      if (state.lastBatch) downloadXlsx(state.lastBatch.online ? onlineRefsRows() : refsRows(), 'الأرقام المرجعية', 'marsa-refs-' + state.lastBatch.meta.batchId + '.xlsx');
    });
    $('refs-csv').addEventListener('click', function () {
      if (state.lastBatch) downloadCsv(state.lastBatch.online ? onlineRefsRows() : refsRows(), 'marsa-refs-' + state.lastBatch.meta.batchId + '.csv');
    });
    /* ---------------------------------------------------------------
       ONLINE (staging): import_batches + import_rows → import_commit
       One batch per file. Every row keeps its raw cells (as read), the
       normalized payload (after edits) and its source id
       (SHA-256 of the file bytes + sheet + row). Re-uploading the same file
       is rejected by the UNIQUE(org_id, source_fingerprint, sheet_name, row_no)
       constraint and reported here.
       --------------------------------------------------------------- */
    var OSTR = {
      loginTitle: 'سجّل الدخول لرفع الدفعات أونلاين',
      notStaffTitle: 'حسابك لا يملك صلاحية رفع الدفعات',
      notStaffText: 'رفع الدفعات متاح لموظفي التخليص والمشرفين ومديري العمليات. يمكنك متابعة المعاينة والتحقق وتصدير النتائج.',
      checking: 'جارٍ التحقق من تسجيل الدخول…',
      uploading: 'جارٍ رفع الدفعة…',
      noValid: 'لا توجد صفوف صالحة للرفع. صحّح الأخطاء أولًا.',
      confirmErrs: 'سيُرفع {ok} وتُسجَّل {bad} بها أخطاء كصفوف متجاوزة (لا تُنشأ لها طلبات). هل تريد المتابعة؟',
      tooMany: 'الملف «{f}» يحتوي على أكثر من {n} صف. قسّمه إلى ملفات أصغر.',
      noFile: 'تعذّر الوصول إلى الملف «{f}». أعد اختياره.',
      dupFile: 'الملف «{f}» رُفع من قبل{b}، لذلك لم يُرفع مرة أخرى (تكرار).',
      dupFileBatch: ' ضمن الدفعة {r}',
      fileFailed: 'الملف «{f}»: {m}',
      nothing: 'لم يُرفع أي صف.',
      title: 'تم رفع {n} وإنشاء طلباتها',
      titleNone: 'اكتمل الرفع دون إنشاء طلبات جديدة',
      sub: 'أرقام الدفعات: {b}. تم إنشاء {c}{s}{d}{e}.',
      skipped: '، وتجاوز {n}',
      dups: '، و{n} مكررة تحتاج قرارًا من الموظف',
      errs: '، و{n} رفضها الخادم',
      rowIssue: '{f} · ص {r}: {m}',
      dupRow: 'مكرر مع الطلب {ref}',
      skippedRow: 'متجاوز (به أخطاء في الملف)',
      issuesTitle: 'صفوف لم تُنشأ لها طلبات',
      done: 'تم رفع الدفعة. ',
      refTh: 'الرقم المرجعي',
      caption: 'الأرقام المرجعية للطلبات المنشأة'
    };
    var MAX_ONLINE_ROWS = 5000;
    var OPS_WRITER_ROLES = ['clearance_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin'];   // = app.ops_writer_roles()
    var auth = { checked: false, signedIn: false, staff: false };
    var uploading = false;
    function tpl(t, o) { return t.replace(/\{(\w+)\}/g, function (_, k) { return o[k] != null ? o[k] : ''; }); }

    function renderAuthNote() {
      var box = $('bu-auth-note');
      if (!box || !ONLINE) return;
      if (!auth.checked) { box.hidden = true; return; }
      box.hidden = auth.staff;
      if (!auth.signedIn) {
        $('bu-auth-title').textContent = OSTR.loginTitle;
      } else if (!auth.staff) {
        $('bu-auth-title').textContent = OSTR.notStaffTitle;
        $('bu-auth-text').textContent = OSTR.notStaffText;
      }
    }
    function refreshAuth() {
      if (!ONLINE) return Promise.resolve();
      return API.getSession().then(function (r) {
        auth.signedIn = !!(r && !r.error && r.data);
        if (!auth.signedIn) { auth.staff = false; return; }
        return API.hasRole(OPS_WRITER_ROLES).then(function (h) { auth.staff = !!(h && !h.error && h.data); });
      }).then(function () { auth.checked = true; renderAuthNote(); }, function () { auth.checked = true; renderAuthNote(); });
    }

    function nonEmpty(o) {
      var out = {};
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
        if (typeof v === 'number' && !isFinite(v)) return;
        out[k] = v;
      });
      return out;
    }
    // normalized payload = flat submit_service_request keys (see migrations 0400)
    function toNormalized(o) {
      var exp = o.direction === 'export';
      var svc = o.service;
      var notes = 'طلب منشأ عبر الرفع الجماعي';
      // the RPC service list has no "export" key: keep the request as clearance + direction export, and note the original choice
      if (svc === 'export') { svc = 'clearance'; notes += ' — الخدمة المطلوبة: ' + SERVICES['export'].label; }
      return nonEmpty({
        fullName: o.fullName, company: o.company, clientType: o.clientType, phone: o.phone, email: o.email,
        crNumber: o.crNumber, taxId: o.taxId,
        direction: o.direction, service: svc, mode: o.mode, country: o.country, port: o.port, goods: o.goods,
        hsCode: o.hsCode, value: o.value > 0 ? o.value : '', currency: o.currency,
        weight: o.weightKg > 0 ? o.weightKg : '', count: o.count > 0 ? o.count : '',
        containerType: o.mode === 'sea' ? o.containerType : '', containerNumbers: o.mode === 'sea' ? (o.containerNumbers || []) : [],
        blNumber: o.blNumber, shippingLine: o.shippingLine, declarationNo: exp ? '' : o.declarationNo,
        docsLater: true, notes: notes
      });
    }
    // raw cells exactly as read from the file, keyed by the original column titles
    function rawLabeled(row) {
      var labels = {};
      state.headers.forEach(function (h) { labels[h.key] = h.label; });
      var out = {};
      Object.keys(row.raw).forEach(function (k) { out[labels[k] || k] = row.raw[k]; });
      return out;
    }
    function rowErrors(row) {
      return Object.keys(row.err || {}).map(function (k) { return { field: k, message: row.err[k] }; });
    }
    function rowIssueText(ir) {
      if (ir.row_status === 'duplicate') return tpl(OSTR.dupRow, { ref: ir.duplicate_of || '' });
      if (ir.row_status === 'skipped') return OSTR.skippedRow;
      var e = (ir.validation_errors || [])[0] || {};
      if (e.message) return e.message;
      return API.errorMessage({ message: e.code || 'MRS_INVALID', details: e.field || '' });
    }

    // insert rows with an explicit decision for error rows (MarsaApi.addImportRows has no "decision" field)
    function insertRows(batchId, rows) {
      return API.ready().then(function (r) {
        if (r.error || !r.data) return { data: null, error: r.error || { code: 'MRS_CONFIG' } };
        return r.data.from('import_rows').insert(rows.map(function (x) {
          return {
            batch_id: batchId, sheet_name: x.sheet, row_no: x.rowNo, raw: x.raw, normalized: x.normalized,
            row_status: x.status, validation_errors: x.errors, decision: x.decision || null
          };
        })).then(function (res) {
          if (res.error) {
            var dup = res.error.code === '23505';
            return { data: null, error: { code: dup ? 'DUPLICATE' : (res.error.code || 'UNKNOWN'), message: API.errorMessage(res.error), raw: res.error } };
          }
          return { data: true, error: null };
        }, function (e) { return { data: null, error: { code: 'MRS_NETWORK', message: API.errorMessage(e), raw: e } }; });
      });
    }

    function uploadFile(f, rows) {
      var res = { file: f, batch: null, commit: null, issues: [], error: null, duplicate: false };
      if (!f.file) { res.error = tpl(OSTR.noFile, { f: f.name }); return Promise.resolve(res); }
      if (rows.length > MAX_ONLINE_ROWS) { res.error = tpl(OSTR.tooMany, { f: f.name, n: MAX_ONLINE_ROWS }); return Promise.resolve(res); }
      // source id = file bytes + sheet + row. Only workbook sheet names (Excel/HTML tables) are part of the
      // file content; for CSV/TSV/JSON the "sheet" label is derived from the file name, so it is left empty
      // (renaming a file must not bypass duplicate detection).
      var sheetName = (f.kind === 'Excel' || f.kind === 'HTML') && f.sheets[f.sheetIdx] ? String(f.sheets[f.sheetIdx].name || '').slice(0, 120) : '';
      var fp;
      return API.util.sha256Hex(f.file).then(function (hash) {
        fp = hash;
        return API.createImportBatch({ fingerprint: fp, fileName: f.name, fileSize: f.size, sheetNames: sheetName ? [sheetName] : [] });
      }).then(function (b) {
        if (b.error || !b.data) { res.error = tpl(OSTR.fileFailed, { f: f.name, m: b.error ? b.error.message : '' }); return res; }
        res.batch = b.data;
        var payload = rows.map(function (r) {
          var bad = r.status === 'error';
          return {
            sheet: sheetName, rowNo: r.rowNum, raw: rawLabeled(r),
            normalized: bad ? null : toNormalized(r.out),
            status: bad ? 'error' : 'valid', errors: rowErrors(r), decision: bad ? 'skip' : null
          };
        });
        return insertRows(b.data.id, payload).then(function (ins) {
          if (ins.error) {
            // nothing was inserted (single statement) → close the empty draft batch
            return API.cancelImportBatch(b.data.id).then(function () {
              if (ins.error.code !== 'DUPLICATE') { res.error = tpl(OSTR.fileFailed, { f: f.name, m: ins.error.message }); return res; }
              res.duplicate = true;
              return API.findBatchByFingerprint(fp).then(function (prev) {
                var other = (prev && prev.data || []).filter(function (x) { return x.id !== b.data.id && x.status !== 'cancelled'; })[0]
                  || (prev && prev.data || []).filter(function (x) { return x.id !== b.data.id; })[0];
                res.error = tpl(OSTR.dupFile, { f: f.name, b: other && other.ref ? tpl(OSTR.dupFileBatch, { r: other.ref }) : '' });
                return res;
              });
            });
          }
          return API.importCommit(b.data.id).then(function (c) {
            if (c.error) { res.error = tpl(OSTR.fileFailed, { f: f.name, m: c.error.message }); return res; }
            res.commit = c.data;
            if (!c.data.duplicates && !c.data.errors && !c.data.skipped) return res;
            return API.listImportRows(b.data.id).then(function (lr) {
              (lr.data || []).forEach(function (ir) {
                if (ir.row_status === 'committed') return;
                res.issues.push(tpl(OSTR.rowIssue, { f: f.name, r: ir.row_no, m: rowIssueText(ir) }));
              });
              return res;
            });
          });
        });
      }, function () { res.error = tpl(OSTR.noFile, { f: f.name }); return res; });
    }

    function submitOnline() {
      if (uploading) return;
      if (!auth.checked) { toast(OSTR.checking, 'info'); refreshAuth(); return; }
      if (!auth.staff) {
        renderAuthNote();
        var note = $('bu-auth-note');
        if (note && note.scrollIntoView) note.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast($('bu-auth-title').textContent, 'warning');
        return;
      }
      var good = state.rows.filter(function (r) { return r.status !== 'error'; });
      if (!good.length) { toast(OSTR.noValid, 'warning'); return; }
      var errs = state.rows.length - good.length;
      if (errs && !window.confirm(tpl(OSTR.confirmErrs, {
        ok: plural(good.length, 'صف واحد صالح', 'صفّان صالحان', 'صفوف صالحة', 'صفًا صالحًا'),
        bad: plural(errs, 'صف واحد', 'صفّان', 'صفوف', 'صفًا')
      }))) return;

      var byFile = {};
      state.rows.forEach(function (r) { (byFile[r.fileId] = byFile[r.fileId] || []).push(r); });
      var files = state.files.filter(function (f) { return f.status === 'ok' && byFile[f.id]; });

      uploading = true;
      var btn = $('btn-submit'), html = btn.innerHTML;
      btn.disabled = true; btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = '<svg class="icon spin" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg> ' + OSTR.uploading;
      $('bu-save-error').hidden = true;

      var results = [];
      files.reduce(function (p, f) {
        return p.then(function () { return uploadFile(f, byFile[f.id]).then(function (r) { results.push(r); }); });
      }, Promise.resolve()).then(function () {
        uploading = false;
        btn.disabled = false; btn.removeAttribute('aria-busy'); btn.innerHTML = html;
        var done = results.filter(function (r) { return r.commit; });
        if (!done.length) {
          showOnlineError(results.map(function (r) { return r.error; }).filter(Boolean).join(' — ') || OSTR.nothing);
          return;
        }
        showOnlineSuccess(results);
      });
    }

    function showOnlineError(msg) {
      var m = $('bu-save-error-msg');
      if (m) m.textContent = msg;
      var box = $('bu-save-error');
      box.hidden = false;
      if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () { box.focus({ preventScroll: true }); }, 80);
      toast(msg, 'error');
    }

    function showOnlineSuccess(results) {
      var rowsByKey = {};
      state.rows.forEach(function (r) { rowsByKey[r.fileId + '|' + r.rowNum] = r; });
      var records = [], batches = [], issues = [], c = 0, sk = 0, du = 0, er = 0;
      results.forEach(function (res) {
        if (res.error) issues.push(res.error);
        if (!res.commit) return;
        batches.push(res.commit.batch_ref || (res.batch && res.batch.ref) || '');
        c += res.commit.committed || 0; sk += res.commit.skipped || 0; du += res.commit.duplicates || 0; er += res.commit.errors || 0;
        issues = issues.concat(res.issues);
        (res.commit.items || []).forEach(function (it) {
          var src = rowsByKey[res.file.id + '|' + it.row_no] || { out: {} };
          records.push({
            ref: it.ref, token: it.tracking_token || '', batchRef: res.commit.batch_ref || '',
            client: src.out.company || src.out.fullName || '', fullName: src.out.fullName || '', company: src.out.company || '',
            phone: src.out.phone || '', port: src.out.port || '', goods: src.out.goods || '',
            value: src.out.value || '', currency: src.out.currency || '',
            sourceFile: res.file.name + (it.sheet ? ' / ' + it.sheet : ''), sourceRow: it.row_no, sourceRowId: it.source_row_id || ''
          });
        });
      });
      state.lastBatch = { online: true, meta: { batchId: batches.join('_') || 'batch' }, records: records };

      $('bu-workspace').hidden = true;
      var s = $('bu-success');
      s.hidden = false;
      $('success-title').textContent = c ? tpl(OSTR.title, { n: plural(c, 'صف واحد', 'صفّين', 'صفوف', 'صفًا') }) : OSTR.titleNone;
      $('success-sub').textContent = tpl(OSTR.sub, {
        b: batches.join('، '),
        c: plural(c, 'طلب واحد', 'طلبين', 'طلبات', 'طلبًا'),
        s: sk ? tpl(OSTR.skipped, { n: plural(sk, 'صف واحد', 'صفّين', 'صفوف', 'صفًا') }) : '',
        d: du ? tpl(OSTR.dups, { n: plural(du, 'صف واحد', 'صفّان', 'صفوف', 'صفًا') }) : '',
        e: er ? tpl(OSTR.errs, { n: plural(er, 'صف واحد', 'صفّين', 'صفوف', 'صفًا') }) : ''
      });
      var ib = $('bu-online-issues');
      if (ib) {
        ib.hidden = !issues.length;
        $('bu-online-issues-title').textContent = OSTR.issuesTitle;
        $('bu-online-issues-list').innerHTML = issues.slice(0, 200).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
      }
      var th = $('success-ref-th'); if (th) th.textContent = OSTR.refTh;
      var cap = $('success-caption'); if (cap) cap.textContent = OSTR.caption;
      $('success-refs').innerHTML = records.map(function (r) {
        var href = 'tracking.html?id=' + encodeURIComponent(r.ref);   // reference only; never the token
        return '<tr><td class="num fw-bold" dir="ltr">' + esc(r.ref) + '</td><td>' + esc(r.client) + '</td><td>' + esc(r.port) + '</td><td class="text-muted">' + esc(r.sourceFile) + ' · ص ' + esc(r.sourceRow) + '</td><td><a class="link-arrow" href="' + href + '">تتبع</a></td></tr>';
      }).join('');
      var top = card.getBoundingClientRect().top + window.pageYOffset - 100;
      window.scrollTo({ top: top, behavior: 'smooth' });
      setTimeout(function () { s.focus({ preventScroll: true }); }, 80);
      toast(OSTR.done + $('success-sub').textContent, c ? 'success' : 'warning');
    }
    function onlineRefsRows() {
      var b = state.lastBatch;
      return [['الرقم المرجعي', 'رمز التتبع (يظهر مرة واحدة)', 'اسم العميل', 'الشركة', 'منفذ الوصول', 'وصف البضاعة', 'القيمة', 'العملة', 'الملف', 'رقم الصف', 'معرّف صف المصدر', 'رقم الدفعة']].concat(b.records.map(function (r) {
        return [r.ref, r.token, r.fullName, r.company, r.port, r.goods, r.value, r.currency, r.sourceFile, r.sourceRow, r.sourceRowId, r.batchRef];
      }));
    }

    $('btn-new-batch').addEventListener('click', function () {
      $('bu-success').hidden = true;
      $('bu-save-error').hidden = true;
      $('bu-workspace').hidden = false;
      clearAll();
      input.focus();
    });

    /* ---------------------------------------------------------------
       Init
       --------------------------------------------------------------- */
    if (!X.canRead()) $('bu-nodecompress').hidden = false;
    var checked = document.querySelector('input[name="bu-type"]:checked');
    state.type = checked ? checked.value : 'shipments';
    syncTypeUI();
    renderAll();
    if (ONLINE) {
      refreshAuth();
      API.onAuth(function () { refreshAuth(); });
    }

    // test hook (harmless): lets automated checks feed File objects
    window.MarsaBulk = { addFiles: addFiles, state: state, _parseNum: parseNum, _matchPort: matchPort, _normPhone: normPhone, _normCurrency: normCurrency };
  });
})();
