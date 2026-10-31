/* =====================================================================
   مرسى | MARSA — tracking.html
   Search by reference / B/L / container / customs declaration number. Reads ?id= on load.
   نسخة عرض تجريبية: 3 sample shipments (illustrative only) + requests saved
   locally by request.html / bulk-upload.html (localStorage "marsa_requests").
   Local records show ONLY ref, status, port, container numbers and the list of
   attached files ("مرفوع (غير مُراجَع)"). No client data, HS, value or fees.
   Document status is never inferred from file names (arch-07).
   ===================================================================== */
(function () {
  'use strict';

  var M = window.Marsa || {};
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) { return String(s || '').toUpperCase().replace(/[\s\-_/.]/g, ''); }
  function svg(paths) { return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + paths + '</svg>'; }

  /* ---------- icons ---------- */
  var IC = {
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
    cloud: '<path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8a4 4 0 0 1 0 10z"/><path d="m9.5 13 2 2 3.5-3.5"/>',
    anchor: '<circle cx="12" cy="5" r="2"/><path d="M12 7v14M5 13H3a9 9 0 0 0 18 0h-2M8 11h8"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
    truck: '<path d="M2 6h11v10H2zM13 9h4l4 4v3h-8z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    ship: '<path d="M3 17c1.5 1.5 3 2 4.5 2s3-.5 4.5-2c1.5 1.5 3 2 4.5 2s3-.5 4.5-2"/><path d="M5 14 4 10h16l-1 4M8 10V6h8v4M12 3v3"/>',
    plane: '<path d="M10.5 13.5 3 11l1.5-1.5 8 1 4-4.5a2 2 0 0 1 3 3L15 13l1 8-1.5 1.5-2.5-7.5-3 3v3L7.5 22l-1-3.5L3 17.5 4.5 16h3z"/>',
    print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    alert: '<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="M12 8v5M12 16h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
    arrow: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    spinner: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>'
  };

  /* ---------- the 8 operational stages (illustrative; no financial stage) ---------- */
  var STAGES = [
    { name: 'تم استلام الطلب', icon: IC.inbox },
    { name: 'تقديم البيان المسبق عبر فسح', icon: IC.cloud },
    { name: 'وصول الشحنة للميناء', icon: IC.anchor },
    { name: 'تقديم البيان الجمركي', icon: IC.file },
    { name: 'الفحص والمعاينة', icon: IC.search },
    { name: 'استيفاء متطلبات الإفراج', icon: IC.card },
    { name: 'الإفراج', icon: IC.unlock },
    { name: 'التسليم', icon: IC.truck }
  ];

  var DOC_STATUS = {
    ok: { label: 'معتمد', cls: 'badge-success' },
    review: { label: 'قيد المراجعة', cls: 'badge-warning' },
    missing: { label: 'مطلوب', cls: 'badge-danger' },
    pending: { label: 'لم يصدر بعد', cls: 'badge-muted' },
    uploaded: { label: 'مرفوع (غير مُراجَع)', cls: 'badge-blue' }
  };

  /* ---------- demo shipments ---------- */
  var SAMPLES = [
    {
      ref: 'MRS-2026-104582',
      client: 'شركة الخليج لقطع غيار السيارات',
      mode: 'sea', modeLabel: 'شحن بحري — حاوية كاملة FCL 40 قدم',
      origin: { city: 'شنغهاي', country: 'الصين' },
      dest: { port: 'ميناء جدة الإسلامي', sub: 'محطة الحاويات الجنوبية – جدة' },
      container: 'MSCU 482917-3', bl: 'MEDUSH2610458', decl: '2026-0301-458213',
      goods: 'قطع غيار سيارات (فلاتر وأقمشة فرامل)', hs: '8708.30', weight: '18,420 كجم', packages: '1,260 كرتونة',
      incoterm: 'FOB شنغهاي', eta: 'وصلت في 21 أكتوبر 2026',
      updated: '29 أكتوبر 2026 · 11:20 ص',
      stage: 4, delivered: false,
      stageDates: ['02 أكتوبر', '18 أكتوبر', '21 أكتوبر', '24 أكتوبر', 'جارية الآن', null, null, null],
      alert: { type: 'info', text: 'حُدِّد مسار «الفحص الفعلي» للشحنة، والمعاينة مجدولة اليوم بحضور مندوب مرسى. لا يلزمك أي إجراء حاليًا، وستظهر النتيجة هنا بعد صدورها.' },
      events: [
        { date: '29 أكتوبر 2026', time: '11:20 ص', title: 'بدء الفحص الفعلي للحاوية', place: 'ساحة الفحص – ميناء جدة الإسلامي', desc: 'سُحبت عينة من أقمشة الفرامل للتحقق من مطابقتها للمواصفات القياسية السعودية وشهادة المطابقة الصادرة عبر منصة سابر.' },
        { date: '27 أكتوبر 2026', time: '02:05 م', title: 'تحديد مسار الفحص', place: 'جمارك ميناء جدة الإسلامي', desc: 'وفقًا لنظام إدارة المخاطر وُجِّه البيان للفحص الفعلي.' },
        { date: '24 أكتوبر 2026', time: '10:40 ص', title: 'تقديم البيان الجمركي', place: 'منصة فسح', desc: 'بند التعريفة HS 8708.30، مرفقًا بالفاتورة التجارية وقائمة التعبئة وشهادة المنشأ وشهادة المطابقة (سابر).' },
        { date: '22 أكتوبر 2026', time: '09:15 ص', title: 'استلام إذن التسليم D/O من الخط الملاحي', place: 'جدة', desc: '' },
        { date: '21 أكتوبر 2026', time: '06:30 ص', title: 'رسو السفينة وتفريغ الحاوية', place: 'ميناء جدة الإسلامي', desc: 'السفينة MSC AURORA – رحلة 642W.' },
        { date: '18 أكتوبر 2026', time: '12:10 م', title: 'تقديم البيان الجمركي المسبق', place: 'منصة فسح', desc: 'قُدِّم البيان المسبق قبل وصول السفينة، وصدر رقم البيان الجمركي.' },
        { date: '05 أكتوبر 2026', time: '04:00 م', title: 'إبحار السفينة من ميناء الشحن', place: 'ميناء شنغهاي – الصين', desc: '' },
        { date: '02 أكتوبر 2026', time: '10:00 ص', title: 'استلام طلب التخليص', place: 'مرسى أونلاين', desc: 'عُيِّن مخلّص مسؤول لمتابعة الملف.' }
      ],
      docs: [
        { name: 'الفاتورة التجارية', sub: 'Commercial Invoice', status: 'ok' },
        { name: 'قائمة التعبئة', sub: 'Packing List', status: 'ok' },
        { name: 'بوليصة الشحن B/L', sub: 'أصل البوليصة – MEDUSH2610458', status: 'ok' },
        { name: 'شهادة المنشأ', sub: 'Certificate of Origin', status: 'ok' },
        { name: 'شهادة المطابقة (سابر)', sub: 'منصة سابر – SASO', status: 'ok' },
        { name: 'البيان الجمركي المسبق', sub: 'مقدَّم عبر منصة فسح', status: 'ok' },
        { name: 'البيان الجمركي', sub: 'مقدَّم – بانتظار نتيجة الفحص', status: 'review' },
        { name: 'الفسح الجمركي', sub: 'يصدر بعد استيفاء متطلبات الإفراج', status: 'pending' }
      ]
    },
    {
      ref: 'MRS-2026-209311',
      client: 'مستشفى النور التخصصي',
      mode: 'air', modeLabel: 'شحن جوي',
      origin: { city: 'فرانكفورت', country: 'ألمانيا' },
      dest: { port: 'مطار الملك خالد الدولي بالرياض', sub: 'مبنى الشحن الجوي' },
      container: 'لا ينطبق (شحن جوي)', bl: 'AWB 020-48213376', decl: '2026-0102-209311',
      goods: 'أجهزة ومستلزمات طبية (أجهزة مراقبة مرضى)', hs: '9018.19', weight: '640 كجم', packages: '14 طردًا',
      incoterm: 'CPT الرياض', eta: 'تم التسليم في 19 أكتوبر 2026',
      updated: '19 أكتوبر 2026 · 03:45 م',
      stage: 7, delivered: true,
      stageDates: ['06 أكتوبر', '10 أكتوبر', '12 أكتوبر', '13 أكتوبر', '14 أكتوبر', '15 أكتوبر', '16 أكتوبر', '19 أكتوبر'],
      alert: { type: 'success', text: 'سُلِّمت البضاعة إلى موقع العميل. التسليم لا يعني إغلاق المعاملة، وأي متابعات لاحقة تُعرض في بوابة العميل في المنصة الفعلية.' },
      events: [
        { date: '19 أكتوبر 2026', time: '03:45 م', title: 'تسليم الشحنة للعميل', place: 'حي الملقا – الرياض', desc: 'استلمها قسم المستودعات بالمستشفى، ووُقِّع محضر الاستلام.' },
        { date: '16 أكتوبر 2026', time: '01:30 م', title: 'صدور الفسح الجمركي', place: 'جمارك مطار الملك خالد الدولي', desc: '' },
        { date: '15 أكتوبر 2026', time: '11:00 ص', title: 'استيفاء متطلبات الإفراج', place: 'جمارك مطار الملك خالد الدولي', desc: '' },
        { date: '14 أكتوبر 2026', time: '12:20 م', title: 'فحص مستندي وموافقة الهيئة العامة للغذاء والدواء', place: 'مبنى الشحن الجوي – مطار الملك خالد الدولي', desc: '' },
        { date: '13 أكتوبر 2026', time: '10:05 ص', title: 'تقديم البيان الجمركي', place: 'منصة فسح', desc: 'بند التعريفة HS 9018.19.' },
        { date: '12 أكتوبر 2026', time: '07:50 ص', title: 'هبوط الطائرة واستلام الشحنة في مبنى الشحن', place: 'مطار الملك خالد الدولي بالرياض', desc: 'رحلة LH 8270.' },
        { date: '10 أكتوبر 2026', time: '05:15 م', title: 'تقديم البيان الجمركي المسبق', place: 'منصة فسح', desc: '' },
        { date: '06 أكتوبر 2026', time: '09:30 ص', title: 'استلام طلب التخليص', place: 'مرسى أونلاين', desc: '' }
      ],
      docs: [
        { name: 'الفاتورة التجارية', sub: 'Commercial Invoice', status: 'ok' },
        { name: 'قائمة التعبئة', sub: 'Packing List', status: 'ok' },
        { name: 'بوليصة الشحن الجوي AWB', sub: '020-48213376', status: 'ok' },
        { name: 'شهادة المنشأ', sub: 'مصدّقة – ألمانيا', status: 'ok' },
        { name: 'إذن الهيئة العامة للغذاء والدواء', sub: 'أجهزة طبية', status: 'ok' },
        { name: 'البيان الجمركي المسبق', sub: 'مقدَّم عبر منصة فسح', status: 'ok' },
        { name: 'البيان الجمركي', sub: 'مُنهى', status: 'ok' },
        { name: 'الفسح الجمركي', sub: 'صدر في 16 أكتوبر 2026', status: 'ok' }
      ]
    },
    {
      ref: 'MRS-2026-330745',
      client: 'مصنع الشروق للملابس الجاهزة',
      mode: 'sea', modeLabel: 'شحن بحري — حاوية 20 قدم',
      origin: { city: 'إسطنبول', country: 'تركيا' },
      dest: { port: 'ميناء الملك عبدالعزيز بالدمام', sub: 'الدمام' },
      container: 'TGHU 730418-6', bl: 'ARKISTDMM330745', decl: 'قيد الإعداد عبر منصة فسح',
      goods: 'أقمشة قطنية منسوجة مصبوغة', hs: '5208.32', weight: '9,850 كجم', packages: '312 لفة',
      incoterm: 'CFR الدمام', eta: 'الوصول المتوقع 14 نوفمبر 2026',
      updated: '28 أكتوبر 2026 · 08:10 م',
      stage: 1, delivered: false,
      stageDates: ['20 أكتوبر', 'جارية الآن', 'متوقع 14 نوفمبر', null, null, null, null, null],
      alert: { type: 'warning', text: 'مطلوب: أصل شهادة المنشأ مصدّقة من الغرفة التجارية لاستكمال البيان الجمركي المسبق قبل وصول السفينة. يرجى إرسالها إلى مسؤول حسابك.' },
      events: [
        { date: '28 أكتوبر 2026', time: '08:10 م', title: 'السفينة في طريقها إلى ميناء الملك عبدالعزيز بالدمام', place: 'البحر الأحمر', desc: 'الوصول المتوقع 14 نوفمبر 2026 وفق آخر تحديث من الخط الملاحي.' },
        { date: '25 أكتوبر 2026', time: '03:00 م', title: 'إبحار السفينة من ميناء الشحن', place: 'ميناء أمبارلي – إسطنبول', desc: 'السفينة ARKAS MARMARA.' },
        { date: '23 أكتوبر 2026', time: '11:30 ص', title: 'طلب أصل شهادة المنشأ', place: 'مرسى أونلاين', desc: 'أُبلغ العميل والمورد بالمستند المطلوب.' },
        { date: '21 أكتوبر 2026', time: '01:45 م', title: 'بدء إعداد البيان الجمركي المسبق', place: 'منصة فسح', desc: 'التحقق من السجل التجاري والرقم الضريبي ورمز المستورد، ومراجعة متطلبات شهادة المطابقة عبر منصة سابر.' },
        { date: '20 أكتوبر 2026', time: '10:20 ص', title: 'استلام طلب التخليص', place: 'مرسى أونلاين', desc: '' }
      ],
      docs: [
        { name: 'الفاتورة التجارية', sub: 'Commercial Invoice', status: 'ok' },
        { name: 'قائمة التعبئة', sub: 'Packing List', status: 'ok' },
        { name: 'بوليصة الشحن B/L', sub: 'نسخة مبدئية – بانتظار الأصل', status: 'review' },
        { name: 'شهادة المنشأ', sub: 'مصدّقة – تركيا', status: 'missing' },
        { name: 'شهادة المطابقة (سابر)', sub: 'منصة سابر – SASO', status: 'review' },
        { name: 'البيان الجمركي المسبق', sub: 'قيد الإعداد عبر منصة فسح', status: 'review' },
        { name: 'البيان الجمركي', sub: 'يُستكمل بعد وصول الشحنة', status: 'pending' },
        { name: 'الفسح الجمركي', sub: '—', status: 'pending' }
      ]
    }
  ];

  /* ---------- locally saved requests (from request.html) ---------- */
  function pick(o, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = o[keys[i]];
      if (v != null && String(v).trim() !== '') return v;
    }
    return '';
  }
  function fmtDate(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h < 12 ? 'ص' : 'م';
    var h12 = h % 12 || 12;
    return {
      full: d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear(),
      short: d.getDate() + ' ' + months[d.getMonth()],
      time: (h12 < 10 ? '0' : '') + h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm
    };
  }
  function modeOf(v) {
    var s = String(v || '').toLowerCase();
    if (/air|جو/.test(s)) return { mode: 'air', label: 'شحن جوي' };
    if (/land|road|truck|بر/.test(s)) return { mode: 'land', label: 'شحن بري' };
    return { mode: 'sea', label: s ? (/lcl|مجمع|جزئ/.test(s) ? 'شحن بحري — بضائع مجمعة LCL' : 'شحن بحري') : 'شحن بحري' };
  }
  function textOf(v) {
    if (v && typeof v === 'object') return v.label || v.name || v.text || '';
    return v;
  }

  function fmtSize(b) {
    var n = Number(b);
    if (!isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' بايت';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(/\.0$/, '') + ' ك.ب';
    return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' م.ب';
  }
  // containerNumbers: new field from request/bulk (array or comma/newline separated string).
  // Older records may only have container / containerNo / containerNumber.
  function containerList(r) {
    var v = r.containerNumbers;
    var arr = [];
    if (Array.isArray(v)) arr = v;
    else if (v != null && String(v).trim() !== '') arr = String(v).split(/[,،;\n]+/);
    if (!arr.length) {
      var one = pick(r, ['container', 'containerNo', 'containerNumber']);
      if (one) arr = [one];
    }
    return arr.map(function (x) { return String(textOf(x) || '').trim(); }).filter(Boolean);
  }

  function fromLocal(r) {
    // request.js / bulk-upload.js nest data under client / shipment and store documents as
    // { invoice:[{name,size}], bl:[...] }. Flatten (older flat records still work).
    if (r && (r.client || r.shipment)) {
      var flat = Object.assign({}, r.client || {}, r.shipment || {}, r);
      delete flat.client; delete flat.shipment;
      r = flat;
    }
    // Attached files: name + size only. The slot key / file name is NEVER used to infer a document status (arch-07).
    var files = [];
    var rawDocs = r.documents || r.files || r.docs;
    function addFile(f) {
      if (!f) return;
      var nm = typeof f === 'object' ? (f.name || f.label || '') : String(f);
      if (String(nm).trim() === '') return;
      files.push({ name: String(nm), size: typeof f === 'object' ? f.size : null });
    }
    if (Array.isArray(rawDocs)) rawDocs.forEach(addFile);
    else if (rawDocs && typeof rawDocs === 'object') {
      Object.keys(rawDocs).forEach(function (k) { (Array.isArray(rawDocs[k]) ? rawDocs[k] : []).forEach(addFile); });
    }

    var ref = String(pick(r, ['ref', 'reference', 'refNo', 'refCode', 'id', 'requestId'])).trim();
    if (!ref) return null;
    var d = fmtDate(r.savedAt || r.createdAt || r.date);
    var md = modeOf(textOf(pick(r, ['mode', 'shipMode', 'shippingMode', 'transport', 'transportMode'])));
    var port = textOf(pick(r, ['port', 'destPort', 'destinationPort', 'arrivalPort', 'pod'])) || 'لم يُحدَّد';

    // Only non-personal fields are kept: no client name/phone/email/IDs, no HS, goods, value, weight or fees (website-03, arch-08).
    return {
      ref: ref.toUpperCase(),
      local: true,
      mode: md.mode, modeLabel: md.label,
      dest: { port: port },
      containers: containerList(r),
      updated: d.full + ' · ' + d.time,
      stage: 0, delivered: false,
      stageDates: [d.short, null, null, null, null, null, null, null],
      alert: { type: 'info', text: 'نسخة عرض تجريبية: هذا الطلب محفوظ في متصفحك على هذا الجهاز فقط، ولم يُرسَل إلى أي جهة ولا يراجعه أي فريق، ولن تتغير حالته.' },
      events: [
        { date: d.full, time: d.time, title: 'حفظ الطلب على هذا الجهاز', place: 'نسخة عرض تجريبية', desc: files.length ? ('أُرفق ' + files.length + (files.length === 1 ? ' ملف' : files.length === 2 ? ' ملفان' : ' ملفات') + ' مع الطلب، ولم يُراجَع أي منها.') : 'لم تُرفق ملفات مع الطلب.' }
      ],
      files: files
    };
  }
  function localShipments() {
    var list = (M.readLocal ? M.readLocal('marsa_requests') : []) || [];
    var out = [];
    list.forEach(function (r) { if (r && typeof r === 'object') { var s = fromLocal(r); if (s) out.push(s); } });
    return out.reverse(); // newest first
  }

  function find(q) {
    var key = norm(q);
    if (!key) return null;
    // local records carry no B/L or declaration number, so they match by reference only
    var all = localShipments().concat(SAMPLES);
    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      if (norm(s.ref) === key || norm(s.bl) === key || norm(s.container) === key || norm(s.decl) === key) return s;
    }
    // allow searching the short numeric tail, e.g. "104582"
    if (/^\d{6}$/.test(key)) {
      for (var j = 0; j < all.length; j++) { if (norm(all[j].ref).slice(-6) === key) return all[j]; }
    }
    return null;
  }

  /* ---------- rendering ---------- */
  function statusBadge(s) {
    if (s.delivered) return '<span class="badge badge-success"><span class="dot"></span>تم التسليم</span>';
    if (s.local) return '<span class="badge badge-blue"><span class="dot"></span>محفوظ على هذا الجهاز</span>';
    return '<span class="badge badge-teal"><span class="dot dot-pulse"></span>' + esc(STAGES[s.stage].name) + '</span>';
  }
  function progressPct(s) { return s.delivered ? 100 : Math.round(((s.stage + 0.5) / STAGES.length) * 100); }

  function renderSummary(s) {
    var modeIcon = s.mode === 'air' ? IC.plane : (s.mode === 'land' ? IC.truck : IC.ship);
    var pct = progressPct(s);
    return '' +
      '<article class="card card-flush shadow" aria-labelledby="ts-title">' +
        '<div class="card-header ts-head">' +
          '<div class="ts-ref">' +
            '<span class="icon-box icon-box-sm">' + svg(modeIcon) + '</span>' +
            '<div><span class="ts-sub">رقم المرجع</span><h2 id="ts-title" class="num" tabindex="-1">' + esc(s.ref) + '</h2></div>' +
          '</div>' +
          '<div class="ts-actions">' + statusBadge(s) +
            '<button class="btn btn-ghost btn-sm" type="button" data-act="copy" data-ref="' + esc(s.ref) + '">' + svg(IC.copy) + 'نسخ الرقم</button>' +
            '<button class="btn btn-ghost btn-sm" type="button" data-act="print">' + svg(IC.print) + 'طباعة</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="sc-route ts-route">' +
            '<div class="port"><small>من</small>' + esc(s.origin.city) + '، ' + esc(s.origin.country) + '</div>' +
            '<div class="line">' + svg(modeIcon) + '</div>' +
            '<div class="port"><small>إلى</small>' + esc(s.dest.port) + '</div>' +
          '</div>' +
          (s.alert ? '<div class="alert' + (s.alert.type === 'info' ? '' : ' alert-' + esc(s.alert.type)) + ' mb-3">' + svg(s.alert.type === 'success' ? IC.check : IC.alert) + '<span>' + esc(s.alert.text) + '</span></div>' : '') +
          '<div class="ts-grid">' +
            '<ul class="kv">' +
              '<li><span class="k">العميل</span><span class="v">' + esc(s.client) + '</span></li>' +
              '<li><span class="k">وسيلة الشحن</span><span class="v">' + esc(s.modeLabel) + '</span></li>' +
              '<li><span class="k">رقم الحاوية</span><span class="v num">' + esc(s.container) + '</span></li>' +
              '<li><span class="k">' + (s.mode === 'air' ? 'بوليصة الشحن الجوي AWB' : 'بوليصة الشحن B/L') + '</span><span class="v num">' + esc(s.bl) + '</span></li>' +
              '<li><span class="k">رقم البيان الجمركي</span><span class="v num">' + esc(s.decl) + '</span></li>' +
              '<li><span class="k">منفذ الوصول</span><span class="v">' + esc(s.dest.port) + '</span></li>' +
            '</ul>' +
            '<ul class="kv">' +
              '<li><span class="k">البضاعة</span><span class="v">' + esc(s.goods) + '</span></li>' +
              '<li><span class="k">رمز HS Code</span><span class="v num">' + esc(s.hs) + '</span></li>' +
              '<li><span class="k">الوزن / العدد</span><span class="v">' + esc(s.weight) + ' · ' + esc(s.packages) + '</span></li>' +
              '<li><span class="k">شروط التسليم</span><span class="v num">' + esc(s.incoterm) + '</span></li>' +
              '<li><span class="k">موعد الوصول / التسليم</span><span class="v">' + esc(s.eta) + '</span></li>' +
            '</ul>' +
          '</div>' +
          '<div class="ts-progress">' +
            '<div class="progress-meta"><span>تقدّم المراحل التشغيلية (توضيحي)</span><span class="num">' + pct + '%</span></div>' +
            '<div class="progress" role="progressbar" aria-label="تقدّم المراحل التشغيلية" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><div class="progress-bar" data-pct="' + pct + '"></div></div>' +
          '</div>' +
        '</div>' +
        '<div class="card-footer text-xs text-muted">شحنة نموذجية — بيانات توضيحية · آخر تحديث: <span class="fw-bold">' + esc(s.updated) + '</span></div>' +
      '</article>';
  }

  function containersRow(s) {
    if (!s.containers || !s.containers.length) return '';
    return '<li><span class="k">' + (s.containers.length > 1 ? 'أرقام الحاويات' : 'رقم الحاوية') + '</span><span class="v num ts-containers">' +
      s.containers.map(function (c) { return '<span dir="ltr">' + esc(c) + '</span>'; }).join('') + '</span></li>';
  }

  // Locally saved record: reference, status, port (+ container numbers) only — no personal or financial data.
  function renderLocalSummary(s) {
    var modeIcon = s.mode === 'air' ? IC.plane : (s.mode === 'land' ? IC.truck : IC.ship);
    return '' +
      '<article class="card card-flush shadow" aria-labelledby="ts-title">' +
        '<div class="card-header ts-head">' +
          '<div class="ts-ref">' +
            '<span class="icon-box icon-box-sm">' + svg(modeIcon) + '</span>' +
            '<div><span class="ts-sub">رقم المرجع</span><h2 id="ts-title" class="num" tabindex="-1">' + esc(s.ref) + '</h2></div>' +
          '</div>' +
          '<div class="ts-actions">' + statusBadge(s) +
            '<button class="btn btn-ghost btn-sm" type="button" data-act="copy" data-ref="' + esc(s.ref) + '">' + svg(IC.copy) + 'نسخ الرقم</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="alert mb-3">' + svg(IC.alert) + '<span>' + esc(s.alert.text) + '</span></div>' +
          '<ul class="kv ts-local-kv">' +
            '<li><span class="k">الحالة</span><span class="v">محفوظ على هذا الجهاز (لم يُرسَل)</span></li>' +
            '<li><span class="k">منفذ الوصول</span><span class="v">' + esc(s.dest.port) + '</span></li>' +
            containersRow(s) +
          '</ul>' +
          '<p class="demo-note mt-3 mb-0">' + svg('<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="M12 16v-4M12 8h.01"/>') +
            '<span>تفاصيل العميل متاحة في بوابة العميل (قريبًا). لا تعرض هذه الصفحة الاسم أو الجوال أو رمز HS أو القيمة.</span></p>' +
        '</div>' +
        '<div class="card-footer text-xs text-muted">تاريخ الحفظ: <span class="fw-bold">' + esc(s.updated) + '</span></div>' +
      '</article>';
  }

  function renderLocalDocs(s) {
    var files = s.files || [];
    var lis = files.map(function (f) {
      var size = fmtSize(f.size);
      return '<li>' +
        '<span class="doc-icon">' + svg(IC.file) + '</span>' +
        '<span class="doc-body"><span class="doc-name" dir="auto">' + esc(f.name) + '</span>' + (size ? '<span class="doc-sub num">' + esc(size) + '</span>' : '') + '</span>' +
        '<span class="badge ' + DOC_STATUS.uploaded.cls + '">' + DOC_STATUS.uploaded.label + '</span>' +
      '</li>';
    }).join('');
    return '<section class="card" aria-labelledby="docs-h">' +
      '<h2 id="docs-h" class="mb-1" style="font-size:var(--fs-lg)">الملفات المرفقة</h2>' +
      '<p class="text-xs text-muted mb-3">' + (files.length ? 'قائمة بالملفات كما أُرفقت (الاسم والحجم فقط). لم يُراجَع أي ملف ولم يُصنَّف.' : 'لم تُرفق ملفات مع هذا الطلب.') + '</p>' +
      (files.length ? '<ul class="doc-list">' + lis + '</ul>' : '') +
    '</section>';
  }

  function renderStages(s) {
    var items = STAGES.map(function (st, i) {
      var cls = '', state = 'لم تبدأ';
      if (s.delivered || i < s.stage) { cls = 'is-done'; state = 'مكتملة'; }
      else if (i === s.stage) { cls = 'is-current'; state = 'المرحلة الحالية'; }
      var date = s.stageDates && s.stageDates[i];
      return '<li class="stage ' + cls + '"' + (cls === 'is-current' ? ' aria-current="step"' : '') + '>' +
        '<span class="stage-dot">' + svg(cls === 'is-done' ? IC.check : st.icon) + '</span>' +
        '<span class="stage-name">' + esc(st.name) + '<span class="sr-only"> — ' + state + '</span></span>' +
        '<span class="stage-date">' + (date ? esc(date) : '—') + '</span>' +
      '</li>';
    }).join('');
    var doneCount = s.delivered ? STAGES.length : s.stage;
    return '<section class="card" aria-labelledby="stages-h">' +
      '<div class="flex flex-wrap items-center justify-between mb-3">' +
        '<h2 id="stages-h" class="mb-0" style="font-size:var(--fs-lg)">مراحل التخليص</h2>' +
        '<span class="text-sm text-muted">' + doneCount + ' من ' + STAGES.length + ' مراحل مكتملة</span>' +
      '</div>' +
      '<ol class="stages">' + items + '</ol>' +
      '<p class="demo-note mt-3 mb-0">' + svg('<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="M12 16v-4M12 8h.01"/>') +
        '<span>«التسليم» يعني وصول البضاعة إلى موقع العميل ولا يعني إغلاق المعاملة. متابعة إعادة الحاوية الفارغة (في الشحن البحري) إجراء منفصل لا يظهر في هذه المراحل.</span></p>' +
    '</section>';
  }

  function renderEvents(s) {
    var lis = s.events.map(function (e, i) {
      var cls = (i === 0 && !s.delivered) ? 'is-current' : 'is-done';
      return '<li class="' + cls + '">' +
        '<span class="tl-dot"></span>' +
        '<span class="tl-title">' + esc(e.title) + '</span>' +
        '<span class="tl-meta">' + esc(e.date) + ' · <span class="num">' + esc(e.time) + '</span> — ' + esc(e.place) + '</span>' +
        (e.desc ? '<span class="tl-desc">' + esc(e.desc) + '</span>' : '') +
      '</li>';
    }).join('');
    return '<section class="card" aria-labelledby="events-h">' +
      '<h2 id="events-h" class="mb-3" style="font-size:var(--fs-lg)">سجل الأحداث</h2>' +
      '<ol class="timeline">' + lis + '</ol>' +
    '</section>';
  }

  function renderDocs(s) {
    var lis = s.docs.map(function (d) {
      var st = DOC_STATUS[d.status] || DOC_STATUS.pending;
      return '<li>' +
        '<span class="doc-icon">' + svg(IC.file) + '</span>' +
        '<span class="doc-body"><span class="doc-name">' + esc(d.name) + '</span><span class="doc-sub">' + esc(d.sub) + '</span></span>' +
        '<span class="badge ' + st.cls + '">' + st.label + '</span>' +
      '</li>';
    }).join('');
    var missing = s.docs.filter(function (d) { return d.status === 'missing'; }).length;
    return '<section class="card" aria-labelledby="docs-h">' +
      '<h2 id="docs-h" class="mb-1" style="font-size:var(--fs-lg)">حالة المستندات</h2>' +
      '<p class="text-xs text-muted mb-3">' + (missing ? (missing === 1 ? 'يوجد مستند واحد مطلوب لاستكمال الملف.' : missing === 2 ? 'يوجد مستندان مطلوبان لاستكمال الملف.' : 'يوجد ' + missing + (missing <= 10 ? ' مستندات مطلوبة' : ' مستندًا مطلوبًا') + ' لاستكمال الملف.') : 'كل المستندات المطلوبة حتى الآن مستوفاة أو قيد الإجراء.') + '</p>' +
      '<ul class="doc-list">' + lis + '</ul>' +
    '</section>';
  }

  function renderContact() {
    return '<section class="card ts-contact" aria-labelledby="help-h">' +
      '<h3 id="help-h">هل لديك استفسار عن الشحنة؟</h3>' +
      '<p>فريق المتابعة متاح من الأحد إلى الخميس، 8 ص – 5 م. يرجى ذكر رقم المرجع عند التواصل.</p>' +
      '<p class="mb-2">' + svg(IC.phone) + ' <a class="tel" href="tel:+966126143270" dir="ltr">+966 12 614 3270</a></p>' +
      '<p class="mb-2">واتساب: <a class="tel" href="https://wa.me/966554821937" target="_blank" rel="noopener" dir="ltr">+966 55 482 1937</a></p>' +
      '<a class="btn btn-white btn-sm" href="contact.html">راسلنا ' + svg(IC.arrow) + '</a>' +
    '</section>';
  }

  function renderResult(s) {
    if (s.local) {
      return renderLocalSummary(s) +
        renderStages(s) +
        '<div class="sidebar-layout">' +
          '<div>' + renderEvents(s) + '</div>' +
          '<aside class="stack" aria-label="الملفات والمساعدة">' + renderLocalDocs(s) + renderContact() + '</aside>' +
        '</div>';
    }
    return renderSummary(s) +
      renderStages(s) +
      '<div class="sidebar-layout">' +
        '<div>' + renderEvents(s) + '</div>' +
        '<aside class="stack" aria-label="المستندات والمساعدة">' + renderDocs(s) + renderContact() + '</aside>' +
      '</div>';
  }

  function sampleChips() {
    return SAMPLES.map(function (s) {
      return '<button class="chip num" type="button" data-sample="' + esc(s.ref) + '">' + esc(s.ref) + '</button>';
    }).join('');
  }

  function renderNotFound(q) {
    var li = function (t) { return '<li>' + svg(IC.check) + '<span>' + t + '</span></li>'; };
    return '<div class="card shadow track-empty" role="alert">' +
      '<div class="empty-icon">' + svg(IC.search) + '</div>' +
      '<h2 tabindex="-1" id="empty-h">لم نعثر على شحنة بهذا الرقم</h2>' +
      '<p class="text-muted mb-0">بحثتَ عن: <span class="searched">' + esc(q) + '</span></p>' +
      '<ul>' +
        li('تأكد من كتابة رقم المرجع كاملًا بالصيغة <span class="num">MRS-2026-XXXXXX</span>.') +
        li('يمكنك البحث أيضًا برقم بوليصة الشحن B/L أو رقم الحاوية أو رقم البيان الجمركي.') +
        li('في نسخة العرض التجريبية تظهر الطلبات المحفوظة على نفس الجهاز والمتصفح فقط، ويُبحث عنها برقم المرجع.') +
      '</ul>' +
      '<p class="text-sm fw-bold mb-1">جرّب أحد الأرقام التجريبية:</p>' +
      '<div class="sample-row">' + sampleChips() + '</div>' +
      '<div class="btn-group">' +
        '<a class="btn btn-primary" href="request.html">ابدأ طلب تخليص جديد</a>' +
        '<a class="btn btn-ghost" href="contact.html">تواصل مع فريق المتابعة</a>' +
      '</div>' +
    '</div>';
  }

  /* ---------- online (staging): public_track(ref, token) — minimal view only ---------- */
  var API = window.MarsaApi || null;
  var ONLINE = !!(API && API.isOnline && API.isOnline());
  var OSTR = {
    reqHead: 'حالة الطلب',
    txHead: 'حالة المعاملة',
    kindRequest: 'طلب تخليص',
    kindTx: 'معاملة تخليص',
    status: 'الحالة',
    received: 'تاريخ الاستلام',
    reviewed: 'تاريخ المراجعة',
    notReviewed: 'لم تتم المراجعة بعد',
    operation: 'نوع العملية',
    mode: 'وسيلة الشحن',
    changed: 'آخر تغيير في الحالة',
    containers: 'إرجاع الحاويات الفارغة',
    containersVal: '{r} من {t} موثّقة',
    timeline: 'سجل المراحل',
    noTimeline: 'لا توجد مراحل معروضة بعد.',
    progress: 'تقدّم المراحل التشغيلية',
    reviewNote: 'سيراجع فريق مرسى طلبك ويتواصل معك. لا يعني ظهور الطلب هنا قبوله أو بدء العمل عليه.',
    privacyNote: 'يعرض التتبع العام الحالة والمراحل فقط. لا تُعرض هنا الأسماء أو أرقام التواصل أو قيم البضاعة أو المستندات.',
    staging: 'بيئة تجريبية متصلة (Staging) — بيانات اختبار',
    notFoundH: 'لم نعثر على بيانات مطابقة',
    notFound1: 'تحقّق من رقم المرجع كاملًا (مثل <span class="num">REQ-2026-000123</span>).',
    notFound2: 'تحقّق من رمز التتبع كما ظهر لك عند إرسال الطلب، دون مسافات.',
    notFound3: 'إن فقدت رمز التتبع فتواصل مع فريق مرسى لإصدار رمز جديد بعد التحقق من هويتك.',
    tokenRequired: 'أدخل رمز التتبع',
    searching: 'جارٍ البحث…',
    errToast: 'لم نعثر على بيانات مطابقة'
  };
  var DIR_LABEL = { import: 'استيراد', export: 'تصدير' };
  var MODE_LABEL = { sea: 'شحن بحري', air: 'شحن جوي', land: 'شحن بري' };

  function applyMode() {
    $$('[data-show-mode]').forEach(function (el) {
      el.hidden = el.getAttribute('data-show-mode') !== (ONLINE ? 'online' : 'demo');
    });
    if (ONLINE) {
      var inp = $('#track-id');
      if (inp) inp.setAttribute('placeholder', 'مثال: REQ-2026-000123');
      var err = $('#track-error');
      if (err) err.textContent = 'أدخل رقم المرجع كاملًا (مثل REQ-2026-000123).';
    }
  }

  function kvLi(k, v, isNum) {
    if (v == null || v === '') return '';
    return '<li><span class="k">' + esc(k) + '</span><span class="v' + (isNum ? ' num' : '') + '">' + esc(v) + '</span></li>';
  }
  function dt(iso) { if (!iso) return ''; var f = fmtDate(iso); return f.full + ' · ' + f.time; }

  function renderOnline(d) {
    var tx = d.transaction || null, rq = d.request || null;
    var ref = (tx && tx.ref) || (rq && rq.ref) || d.ref;
    var mode = (tx && tx.mode) || (rq && rq.mode) || '';
    var modeIcon = mode === 'air' ? IC.plane : (mode === 'land' ? IC.truck : IC.ship);
    var label = tx ? (tx.status_label_ar || tx.operational_status) : (rq ? (rq.status_label_ar || rq.status) : '');
    var rows = '';
    if (rq) {
      rows += kvLi(OSTR.received, dt(rq.created_at));
      rows += kvLi(OSTR.reviewed, rq.reviewed_at ? dt(rq.reviewed_at) : OSTR.notReviewed);
      rows += kvLi(OSTR.operation, DIR_LABEL[rq.direction] || '');
    }
    if (tx) {
      if (rq && rq.ref && tx.ref && rq.ref !== tx.ref) rows += kvLi('رقم المعاملة', tx.ref, true);
      if (!rq) rows += kvLi(OSTR.operation, DIR_LABEL[tx.operation] || '');
      rows += kvLi(OSTR.changed, dt(tx.status_changed_at));
      if (tx.containers && tx.containers.total > 0) {
        rows += kvLi(OSTR.containers, OSTR.containersVal.replace('{r}', String(tx.containers.returned || 0)).replace('{t}', String(tx.containers.total)));
      }
    }
    rows += kvLi(OSTR.mode, MODE_LABEL[mode] || '');

    var progress = '';
    if (tx && tx.stage_index != null && tx.stage_total) {
      var pct = Math.max(0, Math.min(100, Math.round((Number(tx.stage_index) / Number(tx.stage_total)) * 100)));
      progress = '<div class="ts-progress">' +
        '<div class="progress-meta"><span>' + esc(OSTR.progress) + '</span><span class="num">' + pct + '%</span></div>' +
        '<div class="progress" role="progressbar" aria-label="' + esc(OSTR.progress) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><div class="progress-bar" data-pct="' + pct + '"></div></div>' +
      '</div>';
    }

    var summary = '<article class="card card-flush shadow" aria-labelledby="ts-title">' +
      '<div class="card-header ts-head">' +
        '<div class="ts-ref">' +
          '<span class="icon-box icon-box-sm">' + svg(modeIcon) + '</span>' +
          '<div><span class="ts-sub">' + esc(tx ? OSTR.kindTx : OSTR.kindRequest) + ' — رقم المرجع</span><h2 id="ts-title" class="num" tabindex="-1" dir="ltr">' + esc(ref) + '</h2></div>' +
        '</div>' +
        '<div class="ts-actions"><span class="badge badge-teal"><span class="dot"></span>' + esc(label) + '</span>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="copy" data-ref="' + esc(ref) + '">' + svg(IC.copy) + 'نسخ الرقم</button>' +
        '</div>' +
      '</div>' +
      '<div class="card-body">' +
        (!tx ? '<div class="alert mb-3">' + svg(IC.alert) + '<span>' + esc(OSTR.reviewNote) + '</span></div>' : '') +
        '<ul class="kv ts-local-kv">' + kvLi(OSTR.status, label) + rows + '</ul>' +
        progress +
        '<p class="demo-note mt-3 mb-0">' + svg('<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="M12 16v-4M12 8h.01"/>') +
          '<span>' + esc(OSTR.privacyNote) + '</span></p>' +
      '</div>' +
      '<div class="card-footer text-xs text-muted">' + esc(OSTR.staging) + '</div>' +
    '</article>';

    var timeline = '';
    if (tx) {
      var tl = Array.isArray(tx.timeline) ? tx.timeline.slice().reverse() : [];
      var lis = tl.map(function (e, i) {
        return '<li class="' + (i === 0 ? 'is-current' : 'is-done') + '">' +
          '<span class="tl-dot"></span>' +
          '<span class="tl-title">' + esc(e.label_ar || e.status) + '</span>' +
          '<span class="tl-meta">' + esc(dt(e.at)) + '</span>' +
        '</li>';
      }).join('');
      timeline = '<section class="card" aria-labelledby="events-h">' +
        '<h2 id="events-h" class="mb-3" style="font-size:var(--fs-lg)">' + esc(OSTR.timeline) + '</h2>' +
        (lis ? '<ol class="timeline">' + lis + '</ol>' : '<p class="text-sm text-muted mb-0">' + esc(OSTR.noTimeline) + '</p>') +
      '</section>';
    }
    return summary +
      '<div class="sidebar-layout">' +
        '<div>' + timeline + '</div>' +
        '<aside class="stack" aria-label="المساعدة">' + renderContact() + '</aside>' +
      '</div>';
  }

  function renderOnlineNotFound(err) {
    var li = function (t) { return '<li>' + svg(IC.check) + '<span>' + t + '</span></li>'; };
    var generic = !err || err.code === 'MRS_NOT_FOUND';
    return '<div class="card shadow track-empty" role="alert">' +
      '<div class="empty-icon">' + svg(IC.search) + '</div>' +
      '<h2 tabindex="-1" id="empty-h">' + esc(generic ? OSTR.notFoundH : (err.message || OSTR.notFoundH)) + '</h2>' +
      '<ul>' + li(OSTR.notFound1) + li(OSTR.notFound2) + li(OSTR.notFound3) + '</ul>' +
      '<div class="btn-group">' +
        '<a class="btn btn-primary" href="request.html">ابدأ طلب تخليص جديد</a>' +
        '<a class="btn btn-ghost" href="contact.html">تواصل مع فريق المتابعة</a>' +
      '</div>' +
    '</div>';
  }

  /* ---------- controller ---------- */
  var form = $('#track-form');
  var input = $('#track-id');
  var result = $('#track-result');
  var submitBtn = $('#track-submit');
  if (!form || !input || !result) return;
  var group = input.closest('.form-group');
  var tokenInput = $('#track-token');
  var tokenGroup = $('#track-token-group');
  var timer = null;
  var seq = 0;
  applyMode();

  function setUrl(q) {
    try {
      var url = location.pathname + (q ? '?id=' + encodeURIComponent(q) : '');
      history.replaceState(null, '', url);
    } catch (e) { /* file:// in some browsers — ignore */ }
  }

  function search(raw, opts) {
    opts = opts || {};
    var q = String(raw || '').trim().toUpperCase();
    if (q.length < 4) {
      if (group) group.classList.add('has-error');
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    if (group) group.classList.remove('has-error');
    input.removeAttribute('aria-invalid');
    input.value = q;
    setUrl(q);   // reference only — the tracking token never goes into the URL

    if (ONLINE) { searchOnline(q, opts); return; }

    clearTimeout(timer);
    result.setAttribute('aria-busy', 'true');
    result.innerHTML = '<div class="card track-loading">' + svg(IC.spinner).replace('class="icon"', 'class="icon spin"') + '<span>جارٍ البحث عن الشحنة…</span></div>';
    if (submitBtn) submitBtn.disabled = true;

    timer = setTimeout(function () {
      var s = find(q);
      result.innerHTML = s ? renderResult(s) : renderNotFound(q);
      result.removeAttribute('aria-busy');
      if (submitBtn) submitBtn.disabled = false;

      // animate progress bar (dynamic content isn't watched by main.js)
      var bar = $('.progress-bar[data-pct]', result);
      if (bar) requestAnimationFrame(function () { requestAnimationFrame(function () { bar.style.width = bar.getAttribute('data-pct') + '%'; }); });

      var heading = $('#ts-title, #empty-h', result);
      if (!opts.silent && heading) {
        heading.focus({ preventScroll: true });
        var top = result.getBoundingClientRect().top + window.pageYOffset - 100;
        window.scrollTo({ top: top, behavior: reduceMotion ? 'auto' : 'smooth' });
      }
      if (!s && M.toast && !opts.silent) M.toast('لم نعثر على شحنة بهذا الرقم', 'warning');
    }, reduceMotion ? 80 : 520);
  }

  function finishRender(html, found, opts) {
    result.innerHTML = html;
    result.removeAttribute('aria-busy');
    if (submitBtn) submitBtn.disabled = false;
    var bar = $('.progress-bar[data-pct]', result);
    if (bar) requestAnimationFrame(function () { requestAnimationFrame(function () { bar.style.width = bar.getAttribute('data-pct') + '%'; }); });
    var heading = $('#ts-title, #empty-h', result);
    if (!opts.silent && heading) {
      heading.focus({ preventScroll: true });
      var top = result.getBoundingClientRect().top + window.pageYOffset - 100;
      window.scrollTo({ top: top, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    if (!found && M.toast && !opts.silent) M.toast(OSTR.errToast, 'warning');
  }

  function searchOnline(q, opts) {
    var tok = tokenInput ? String(tokenInput.value || '').replace(/\s+/g, '').toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(tok)) {
      if (tokenGroup) tokenGroup.classList.add('has-error');
      if (tokenInput) { tokenInput.setAttribute('aria-invalid', 'true'); tokenInput.focus(); }
      return;
    }
    if (tokenGroup) tokenGroup.classList.remove('has-error');
    if (tokenInput) tokenInput.removeAttribute('aria-invalid');
    var mine = ++seq;
    result.setAttribute('aria-busy', 'true');
    result.innerHTML = '<div class="card track-loading">' + svg(IC.spinner).replace('class="icon"', 'class="icon spin"') + '<span>' + esc(OSTR.searching) + '</span></div>';
    if (submitBtn) submitBtn.disabled = true;
    API.publicTrack(q, tok).then(function (res) {
      if (mine !== seq) return;
      if (res && !res.error && res.data) finishRender(renderOnline(res.data), true, opts);
      else finishRender(renderOnlineNotFound(res && res.error), false, opts);
    }, function () {
      if (mine !== seq) return;
      finishRender(renderOnlineNotFound(null), false, opts);
    });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); search(input.value); });
  if (tokenInput) tokenInput.addEventListener('input', function () {
    if (tokenGroup && tokenGroup.classList.contains('has-error')) {
      tokenGroup.classList.remove('has-error'); tokenInput.removeAttribute('aria-invalid');
    }
  });
  input.addEventListener('input', function () {
    if (group && group.classList.contains('has-error') && input.value.trim().length >= 4) {
      group.classList.remove('has-error'); input.removeAttribute('aria-invalid');
    }
  });

  // delegated clicks: sample chips (search card + not-found), copy, print
  document.addEventListener('click', function (e) {
    var chip = ONLINE ? null : e.target.closest('[data-sample]');
    if (chip) { input.value = chip.getAttribute('data-sample'); search(input.value); return; }
    var act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.getAttribute('data-act') === 'print') { window.print(); return; }
    if (act.getAttribute('data-act') === 'copy') {
      var ref = act.getAttribute('data-ref');
      var done = function () { if (M.toast) M.toast('تم نسخ رقم المرجع ' + ref, 'success'); };
      var fallback = function () {
        var ta = document.createElement('textarea');
        ta.value = ref; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (err) { if (M.toast) M.toast('تعذّر النسخ، انسخ الرقم يدويًا', 'error'); }
        document.body.removeChild(ta);
      };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(ref).then(done, fallback);
      else fallback();
    }
  });

  // chips for requests saved on this device
  var locals = ONLINE ? [] : localShipments();   // local/demo records only in demo mode
  var localWrap = $('#local-requests');
  var localChips = $('#local-chips');
  if (locals.length && localWrap && localChips) {
    localChips.innerHTML = locals.slice(0, 6).map(function (s) {
      return '<button class="chip num" type="button" data-sample="' + esc(s.ref) + '">' + esc(s.ref) + '</button>';
    }).join('');
    localWrap.hidden = false;
  }

  // auto-search from ?id=
  var id = '';
  try { id = new URLSearchParams(location.search).get('id') || ''; }
  catch (e) {
    var m = /[?&]id=([^&]+)/.exec(location.search);
    id = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }
  if (id && ONLINE) {
    // online: prefill the reference only; the visitor types the token (never read from the URL)
    input.value = String(id).trim().toUpperCase().slice(0, 40);
    if (tokenInput) tokenInput.focus();
  } else if (id) { input.value = id; search(id, { silent: false }); }
})();
