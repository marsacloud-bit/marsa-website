/* ==========================================================================
   مرسى | MARSA — Fasah entry information sheet (legacy step 4)  →  window.MarsaFasahSheet
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_DECL_AR.md §5 (legacy DocumentAI.js buildFasahExportSheet_ + Index.html
   buildFasahReportBody). Built in the browser from the approved data of a transaction:
     getTransactionShipment (the «بيانات فسح» record + invoice items + packing items), getTransactionDeclaration
     (the active declaration + its items), listContainers (containers + seals) and the transaction row.
   * Order = the Fasah entry order: summary strip · 1 B/L · 2 containers / seals · 3 invoice + items ·
     4 packing list + items · 5 customs declaration + items · common values across the documents ·
     conflicts and missing fields. RTL (dir follows the UI language), numbers / codes LTR.
   * Numeric comparison tolerance max(0.01, 0.01 % of the larger value) (legacy fasahNumericEquivalent);
     currency codes with their Arabic / English names (legacy formatFasahCurrency, extended).
   * Print (PDF through the browser's print dialog, print CSS in decl.css), Excel (MarsaXlsx, rpt/xlsx.js) and
     CSV (MarsaExport.toCsv). Every export is logged FIRST through logReportExport({report: 'fasah_sheet',
     filters: {transaction_id}}) — never the row data — and the file is built only when the log succeeded.
     File name: كشف-إدخال-فسح-{seq}-{yyyymmdd-hhmm} (Asia/Riyadh).
   * Readings draft (2026-11-14, owner: the sheet is the OUTPUT the program makes from the B/L + the commercial invoice,
     read together as the first step): buildReadingsModel turns the readings of the matching report (ocr-match.js:
     B/L / invoice / packing list / declaration fields + items + containers, the engine result of the report in strict
     mode and its exceptions) into the SAME model shape, so render / flatRows / xlsxSpec / the export are shared.
     No transaction yet: strip «مسودة — قبل إنشاء المعاملة», filters {} in the export log (log_report_export accepts a
     fasah_sheet export with no filter key), file كشف-إدخال-فسح-مسودة-{yyyymmdd-hhmm}. Once «إنشاء مسودة معاملة» made a
     draft transaction from these readings (20261127000100), src.tx = {id, ref}: strip «مسودة معاملة MRS-…» and the
     export log sends filters {transaction_id}. A reading that is itself a Fasah
     entry sheet (title / file name) or whose detected type is 'other' never produces the sheet (readingExcluded, a note
     says so). renderDraft(host, src, opts) draws it inline (toolbar + sheet); print = a copy of the sheet in the
     .fsh-overlay, so the print CSS of decl.css applies unchanged.
   * Owner reference (2026-11-14, «ظبّط الكشف عليه بالظبط»): the readings draft follows the owner's reference output —
     centred title · strip رقم المعاملة | المستورد (the linked transaction's client, else the B/L consignee name) | رقم
     البوليصة | تاريخ إعداد الكشف (Arabic-Indic yyyy/m/d، h:mm:ss ص/م) · 1 B/L (8 pairs + the quantities block + all 6
     container columns) · 2 invoice (10 pairs + items, empty item columns hidden) · 3 packing list when read · the 5
     common rows (مطابق / يوجد اختلاف / مراجعة سريعة from the strict engine rows) · the conflicts (differences and
     missing values of those rows + critical numbers that differ / are invalid). renderReadings draws it; the transaction
     sheet (buildModel / render) is unchanged. No declaration part on the draft (the reference has none).
   * Read-only: nothing is written except the export log. Strings: namespace 'decl' (assets/i18n/decl.js).
   * Data only via textContent / createElement. ES5, no library.
   ========================================================================== */
(function (root) {
  'use strict';

  var RIYADH_MS = 3 * 3600 * 1000;
  var NONE = '—';
  var CURRENCIES = {
    SAR: ['ريال سعودي', 'Saudi riyal'], USD: ['دولار أمريكي', 'US dollar'], EUR: ['يورو', 'Euro'], AED: ['درهم إماراتي', 'UAE dirham'],
    GBP: ['جنيه إسترليني', 'Pound sterling'], CNY: ['يوان صيني', 'Chinese yuan'], JPY: ['ين ياباني', 'Japanese yen'],
    KWD: ['دينار كويتي', 'Kuwaiti dinar'], QAR: ['ريال قطري', 'Qatari riyal'], BHD: ['دينار بحريني', 'Bahraini dinar'],
    OMR: ['ريال عُماني', 'Omani rial'], EGP: ['جنيه مصري', 'Egyptian pound'], JOD: ['دينار أردني', 'Jordanian dinar'],
    INR: ['روبية هندية', 'Indian rupee'], TRY: ['ليرة تركية', 'Turkish lira'], KRW: ['وون كوري', 'Korean won'],
    CHF: ['فرنك سويسري', 'Swiss franc'], CAD: ['دولار كندي', 'Canadian dollar'], AUD: ['دولار أسترالي', 'Australian dollar'],
    HKD: ['دولار هونغ كونغ', 'Hong Kong dollar'], SGD: ['دولار سنغافوري', 'Singapore dollar'], MYR: ['رينغيت ماليزي', 'Malaysian ringgit'],
    THB: ['بات تايلندي', 'Thai baht'], IDR: ['روبية إندونيسية', 'Indonesian rupiah'], PKR: ['روبية باكستانية', 'Pakistani rupee'],
    VND: ['دونغ فيتنامي', 'Vietnamese dong']
  };

  function str(v) { return v == null ? '' : String(v); }
  function blank(v) { return v == null || (typeof v === 'string' && !v.replace(/\s+/g, '')) || (Array.isArray(v) && !v.length); }
  function western(s) {
    return String(s == null ? '' : s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
  }
  // legacy normalizeInstantSearch_: lower case, أإآ→ا ة→ه ى→ي, no spaces / punctuation
  function searchKey(v) {
    return western(v).toLowerCase().replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[\s\-_\/\\.,،]+/g, '');
  }
  function toNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = western(v).replace(/[,٬\s]/g, '').replace(/٫/g, '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }
  // legacy fasahNumericEquivalent: null when a side is empty; tolerance max(0.01, 0.01 % of the larger absolute value)
  function numEquivalent(a, b) {
    if (blank(a) || blank(b)) return null;
    var na = toNum(a), nb = toNum(b);
    if (na == null || nb == null) return searchKey(a) === searchKey(b);
    var tol = Math.max(0.01, Math.max(Math.abs(na), Math.abs(nb)) * 0.0001);
    return Math.abs(na - nb) <= tol + 1e-9;
  }
  // 'usd' / '$' / 'دولار' → 'USD — دولار أمريكي' (en: 'USD — US dollar'); unknown codes as written
  function currencyName(v, lang) {
    var raw = str(v).trim();
    if (!raw) return '';
    var k = searchKey(raw), code = raw.toUpperCase();
    if (k === 'usd' || raw === '$' || k.indexOf('دولار') !== -1 || k.indexOf('usdollar') !== -1) code = 'USD';
    else if (k === 'sar' || k.indexOf('ريال') !== -1 && k.indexOf('قطري') === -1 && k.indexOf('عماني') === -1 || k.indexOf('saudiriyal') !== -1) code = 'SAR';
    else if (k === 'eur' || raw === '€' || k.indexOf('يورو') !== -1) code = 'EUR';
    var n = CURRENCIES[code];
    return n ? code + ' — ' + n[lang === 'en' ? 1 : 0] : raw;
  }
  function riyadhStamp(d) {
    var t = d instanceof Date ? d.getTime() : (d ? new Date(d).getTime() : Date.now());
    if (!isFinite(t)) t = Date.now();
    var x = new Date(t + RIYADH_MS);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return { day: x.getUTCFullYear() + '-' + p(x.getUTCMonth() + 1) + '-' + p(x.getUTCDate()),
      file: x.getUTCFullYear() + p(x.getUTCMonth() + 1) + p(x.getUTCDate()) + '-' + p(x.getUTCHours()) + p(x.getUTCMinutes()),
      text: x.getUTCFullYear() + '-' + p(x.getUTCMonth() + 1) + '-' + p(x.getUTCDate()) + ' ' + p(x.getUTCHours()) + ':' + p(x.getUTCMinutes()) };
  }
  // كشف-إدخال-فسح-{seq}-{yyyymmdd-hhmm}.{ext}; the sequence keeps letters / digits / '-' only
  function fileName(seq, when, ext) {
    var s = western(seq).replace(/[\\\/:*?"<>|\s]+/g, '-').replace(/[^\w؀-ۿ-]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'tx';
    return 'كشف-إدخال-فسح-' + s + '-' + riyadhStamp(when).file + (ext ? '.' + ext : '');
  }
  function sum(rows, k) {
    var any = false, t = 0;
    (rows || []).forEach(function (r) { var n = toNum(r && r[k]); if (n != null) { any = true; t += n; } });
    return any ? Math.round(t * 1000) / 1000 : null;
  }
  function list(v) { return Array.isArray(v) ? v : []; }
  function ctrNo(v) { return western(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function setOf(arr) {
    var s = {}, out = [];
    list(arr).forEach(function (x) { var n = ctrNo(x); if (n && !s[n]) { s[n] = 1; out.push(n); } });
    return out.sort();
  }

  // one common-values row (legacy buildFasahCommonReviewRows + the declaration column):
  // status ok (equal) | diff (a difference) | single (one document only) | missing (none) | review (free text)
  function commonRow(key, vals, mode) {
    var cols = ['bl', 'invoice', 'packing', 'declaration'];
    var av = cols.map(function (c) { return vals[c]; }).filter(function (v) { return !blank(v); });
    var status;
    if (!av.length) status = 'missing';
    else if (av.length === 1) status = 'single';
    else if (mode === 'numeric') status = av.slice(1).every(function (v) { return numEquivalent(av[0], v) === true; }) ? 'ok' : 'diff';
    else if (mode === 'exact') status = av.slice(1).every(function (v) { return searchKey(v) === searchKey(av[0]); }) ? 'ok' : 'diff';
    else if (mode === 'set') status = av.slice(1).every(function (v) { return setOf(v).join(',') === setOf(av[0]).join(','); }) ? 'ok' : 'diff';
    else status = 'review';
    var out = { key: key, mode: mode, status: status };
    cols.forEach(function (c) { out[c] = Array.isArray(vals[c]) ? setOf(vals[c]).join(', ') : str(vals[c]); });
    return out;
  }

  /* src = { tx, shipment: getTransactionShipment data, decl: getTransactionDeclaration data, containers: listContainers rows,
             now?, lang?, statusLabel?(code), typeLabel?(code), sourceLabel?(code) }
     → { seq, txId, fileBase, prepared, strip, sections [{ id, pairs [[key, value, ltr]], tables [{ id, cols [{key, type}], rows }] }],
         common [rows], alerts [{ kind, field, bl, invoice, packing, note }], hasData, counts } */
  function buildModel(src) {
    src = src || {};
    var lang = src.lang === 'en' ? 'en' : 'ar';
    var tx = src.tx || {}, sh = src.shipment || {}, sd = sh.shipment_data || {}, de = src.decl || {};
    var act = de.active || null, ditems = list(de.items), inv = list(sh.invoice_items), pk = list(sh.packing_items);
    var ctrRows = list(src.containers);
    var stL = typeof src.statusLabel === 'function' ? src.statusLabel : function (c) { return str(c); };
    var tyL = typeof src.typeLabel === 'function' ? src.typeLabel : function (c) { return str(c); };
    var soL = typeof src.sourceLabel === 'function' ? src.sourceLabel : function (c) { return str(c); };
    var client = tx.clients && (lang === 'en' && tx.clients.name_en ? tx.clients.name_en : tx.clients.name_ar) || '';
    var importer = client || sd.consignee_name || sd.consignee || sd.buyer || '';
    var bl = tx.bl_number || sd.bl_number || '';
    var prepared = riyadhStamp(src.now || new Date());
    var currency = currencyName(sd.currency, lang);
    function P(key, v, ltr) { return [key, blank(v) ? '' : str(v), !!ltr]; }
    var strip = [P('s_tx', tx.ref, 1), P('s_importer', importer), P('s_bl', bl, 1),
      P('s_decl', act ? act.declaration_no : tx.declaration_no, 1), P('s_status', act ? stL(act.status) : ''), P('s_prepared', prepared.text, 1)];

    var ctr;
    if (ctrRows.length) {
      ctr = ctrRows.map(function (c) {
        return { container_no: c.container_no, seal_no: c.seal_no, size_type: c.size_type, packages: c.packages_count != null ? c.packages_count : null,
          gross: c.gross_weight_kg, net: c.net_weight_kg != null ? c.net_weight_kg : null, source: c.source ? soL(c.source) : '' };
      });
    } else {
      ctr = list(sd.containers).map(function (c) {
        return { container_no: c.container_number, seal_no: c.seal_number, size_type: c.size_type, packages: c.packages_count,
          gross: c.gross_weight, net: c.net_weight, source: '' };
      });
    }
    var CT = [{ key: 'container_no', type: 'code' }, { key: 'seal_no', type: 'code' }, { key: 'size_type', type: 'code' }, { key: 'packages', type: 'number' },
      { key: 'gross', type: 'number' }, { key: 'net', type: 'number' }, { key: 'source', type: 'text' }];
    var IT = [{ key: 'line_no', type: 'int' }, { key: 'invoice_number', type: 'code' }, { key: 'description', type: 'text' }, { key: 'supplier_hs_code', type: 'code' },
      { key: 'quantity', type: 'number' }, { key: 'unit', type: 'text' }, { key: 'unit_price', type: 'number' }, { key: 'total', type: 'number' },
      { key: 'origin_country', type: 'text' }, { key: 'scientific_name', type: 'text' }, { key: 'net_weight_kg', type: 'number' }, { key: 'gross_weight_kg', type: 'number' }];
    var PT = [{ key: 'line_no', type: 'int' }, { key: 'packing_list_number', type: 'code' }, { key: 'description', type: 'text' }, { key: 'packages', type: 'number' },
      { key: 'quantity', type: 'number' }, { key: 'unit', type: 'text' }, { key: 'gross_weight_kg', type: 'number' }, { key: 'net_weight_kg', type: 'number' },
      { key: 'container_no', type: 'code' }, { key: 'seal_no', type: 'code' }];
    var DT = [{ key: 'line_no', type: 'int' }, { key: 'hs_code', type: 'code' }, { key: 'description_ar', type: 'text' }, { key: 'quantity', type: 'number' },
      { key: 'unit', type: 'text' }, { key: 'value', type: 'number' }, { key: 'origin_country', type: 'text' }, { key: 'net_weight_kg', type: 'number' },
      { key: 'gross_weight_kg', type: 'number' }];
    var sections = [
      { id: 'bl', pairs: [P('f_bl_number', bl, 1), P('f_shipper', sd.shipper), P('f_consignee', sd.consignee_name || sd.consignee || importer),
        P('f_notify', sd.notify_party), P('f_vessel_voyage', [sd.vessel, sd.voyage].filter(function (x) { return !blank(x); }).join(' / '), 1),
        P('f_shipping_line', sd.shipping_line), P('f_pol', sd.port_of_loading || tx.port_of_loading), P('f_pod', sd.port_of_discharge || tx.port_of_discharge),
        P('f_place_receipt', sd.place_of_receipt), P('f_place_delivery', sd.place_of_delivery), P('f_booking', sd.booking_number, 1),
        P('f_freight_terms', sd.freight_terms), P('f_goods', sd.goods_description || tx.goods_description),
        P('f_packages', sd.packages_count, 1), P('f_package_type', sd.package_type), P('f_gross', sd.gross_weight_kg, 1), P('f_net', sd.net_weight_kg, 1),
        P('f_cbm', sd.measurement_cbm, 1), P('f_temp', sd.temperature_c, 1)], tables: [] },
      { id: 'containers', pairs: [], tables: [{ id: 'containers', cols: CT, rows: ctr }] },
      { id: 'invoice', pairs: [P('f_invoice_no', sd.invoice_number, 1), P('f_invoice_date', sd.invoice_date, 1), P('f_seller', sd.seller), P('f_buyer', sd.buyer),
        P('f_currency', currency, 1), P('f_total', sd.total_value, 1), P('f_origin', sd.country_of_origin), P('f_export_country', sd.export_country),
        P('f_incoterms', sd.incoterms, 1), P('f_payment_terms', sd.payment_terms)], tables: [{ id: 'invoice_items', cols: IT, rows: inv }] },
      { id: 'packing', pairs: [P('f_packing_no', sd.packing_list_number, 1), P('f_packing_date', sd.packing_list_date, 1),
        P('f_packages', sd.packing_total_packages, 1), P('f_package_type', sd.packing_package_type), P('f_gross', sd.packing_gross_weight_kg, 1),
        P('f_net', sd.packing_net_weight_kg, 1)], tables: [{ id: 'packing_items', cols: PT, rows: pk }] },
      { id: 'declaration', pairs: act ? [P('f_decl_no', act.declaration_no, 1), P('f_decl_type', act.declaration_type_code ? tyL(act.declaration_type_code) : act.declaration_type),
        P('f_decl_status', stL(act.status)), P('f_decl_date', act.declaration_date, 1), P('f_decl_hijri', act.declaration_date_hijri, 1),
        P('f_decl_source', act.source ? soL('d_' + act.source) : '')] : [P('f_decl_no', tx.declaration_no, 1), P('f_decl_date', tx.declaration_date, 1)],
        tables: [{ id: 'declaration_items', cols: DT, rows: ditems }] }
    ];

    var invDesc = inv.map(function (x) { return x.description; }).filter(function (x) { return !blank(x); }).join('، ');
    var pkDesc = pk.map(function (x) { return x.description; }).filter(function (x) { return !blank(x); }).join('، ');
    var dDesc = ditems.map(function (x) { return x.description_ar; }).filter(function (x) { return !blank(x); }).join('، ');
    var blCtr = list(sd.containers).map(function (c) { return c.container_number; });
    var pkCtr = pk.map(function (x) { return x.container_no; }).filter(function (x) { return !blank(x); });
    // review fix: the declaration side is the declaration's own container list as last approved (get_transaction_declaration
    // .containers: added + updated + unchanged); containers.source marks only the rows the approval inserted, so it is the
    // fallback for an older answer only
    var declCtr = Array.isArray(de.containers) ? de.containers.filter(function (x) { return !blank(x); }).map(String)
      : ctrRows.filter(function (c) { return c.source === 'declaration'; }).map(function (c) { return c.container_no; });
    var common = [
      commonRow('importer', { bl: sd.consignee_name || sd.consignee, invoice: sd.buyer }, 'exact'),
      commonRow('packages', { bl: sd.packages_count, packing: sd.packing_total_packages }, 'numeric'),
      commonRow('gross', { bl: sd.gross_weight_kg, packing: sd.packing_gross_weight_kg, declaration: sum(ditems, 'gross_weight_kg') }, 'numeric'),
      commonRow('net', { bl: sd.net_weight_kg, invoice: sum(inv, 'net_weight_kg'), packing: sd.packing_net_weight_kg, declaration: sum(ditems, 'net_weight_kg') }, 'numeric'),
      commonRow('invoice_total', { invoice: sd.total_value, packing: null, bl: null, declaration: null }, 'numeric'),
      commonRow('containers', { bl: blCtr, packing: pkCtr, declaration: declCtr }, 'set'),
      commonRow('goods', { bl: sd.goods_description, invoice: invDesc, packing: pkDesc, declaration: dDesc }, 'review')
    ];
    // the invoice total against the sum of its own lines (same document, two places)
    var lines = sum(inv, 'total');
    if (lines != null && !blank(sd.total_value)) {
      common[4] = commonRow('invoice_total', { invoice: sd.total_value, declaration: null, bl: null, packing: null }, 'numeric');
      common[4].lines = String(lines);
      common[4].status = numEquivalent(sd.total_value, lines) ? 'ok' : 'diff';
    }

    var alerts = [];
    list(sd.conflicts).forEach(function (c) {
      if (!c || !c.field) return;
      var v = c.values || {};
      function j(x) { return Array.isArray(x) ? x.join(', ') : str(x); }
      alerts.push({ kind: 'conflict', field: 'cmp_' + c.field, bl: j(v.bl), invoice: j(v.invoice), packing: j(v.packing), note: str(c.note) });
    });
    list(sd.missing_fields).forEach(function (m) { alerts.push({ kind: 'missing', field: 'miss_' + m, bl: '', invoice: '', packing: '', note: '' }); });
    common.forEach(function (r) {
      if (r.status === 'diff') alerts.push({ kind: 'conflict', field: 'cm_' + r.key, bl: r.bl, invoice: r.key === 'invoice_total' && r.lines ? r.invoice + ' / ' + r.lines : r.invoice, packing: r.packing, note: r.declaration ? r.declaration : '' });
    });
    if (!act) alerts.push({ kind: 'missing', field: 'miss_declaration', bl: '', invoice: '', packing: '', note: '' });
    else if (!ditems.length) alerts.push({ kind: 'missing', field: 'miss_declaration_items', bl: '', invoice: '', packing: '', note: '' });
    if (!sh.shipment_data) alerts.push({ kind: 'missing', field: 'miss_shipment_data', bl: '', invoice: '', packing: '', note: '' });

    return {
      seq: str(tx.ref), txId: tx.id || null, prepared: prepared, fileBase: fileName(tx.ref || tx.id || '', src.now || new Date()),
      strip: strip, sections: sections, common: common, alerts: alerts, hasData: !!(sh.shipment_data || act),
      counts: { containers: ctr.length, invoice: inv.length, packing: pk.length, declaration: ditems.length }
    };
  }

  /* ------------------------------------------------------------------
     Readings draft: the matching report's readings → the same model (no transaction yet)
     ------------------------------------------------------------------ */
  var DOCS = ['bl', 'invoice', 'packing', 'declaration'];
  var DRAFT_SEQ = 'مسودة';   // كشف-إدخال-فسح-مسودة-{yyyymmdd-hhmm} in both languages (the file names are Arabic)
  // the document columns of the common values / alerts tables: a readings draft shows the documents it used
  function docCols(m) { return m && Array.isArray(m.docCols) ? m.docCols : DOCS; }
  var AK_CLS = { missing: 'missing', conflict: 'diff', invalid: 'diff', review: 'review' };
  // a Fasah entry sheet (the owner's «كشف إدخال فسح» / «ورقة معلومات الإدخال في منصة فسح», our own file name too)
  var FASAH_RE = /كشف\s*[-_ ]?\s*[إا]دخال\s*[-_ ]?\s*فسح|ورقة\s+معلومات\s+ال[إا]دخال|fasah\s*[-_ ]?\s*entry\s*[-_ ]?\s*(info(rmation)?\s*)?sheet/i;
  /* a reading that must not produce the sheet: 'fasah_sheet' (it IS a Fasah entry sheet: the file name / a value says so)
     or 'other' (the reading's detected type is not a B/L / invoice / packing list / declaration). null = usable.
     d = { label?, fileName?, detected?, parentDetected?, fields? {key: value} } */
  function readingExcluded(d) {
    if (!d || typeof d !== 'object') return null;
    var names = [d.label, d.fileName].map(function (x) { return str(x).replace(/[-_.]+/g, ' '); });
    var vals = [];
    var f = d.fields && typeof d.fields === 'object' ? d.fields : {};
    Object.keys(f).forEach(function (k) { if (typeof f[k] === 'string') vals.push(f[k]); });
    if (names.concat(vals).some(function (x) { return FASAH_RE.test(x); })) return 'fasah_sheet';
    if (d.detected === 'other' || d.parentDetected === 'other') return 'other';
    return null;
  }
  function first(f, keys) {
    for (var i = 0; i < keys.length; i++) { var v = f && f[keys[i]]; if (!blank(v)) return str(v).trim(); }
    return '';
  }
  // container numbers printed in one field (ISO 6346 shaped first, else split on separators)
  function codesOf(v) {
    var s = western(v).toUpperCase();
    var iso = s.match(/[A-Z]{3}[UJZ]\s?-?\s?\d{6}\s?-?\s?\d/g);
    if (iso && iso.length) return iso.map(ctrNo);
    return s.split(/[,;،|\/\n]+|\s{2,}/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function sealsOf(v) { return western(v).split(/[,;،|\/\n\s]+/).map(function (x) { return x.trim(); }).filter(Boolean); }
  // per-container rows: the reading's containers rows; the container_numbers / seal_numbers fields when there are none, or
  // when the (corrected) field lists other containers — the row data is kept for a container that is on both
  function containerRows(d) {
    var f = d.fields || {}, rows = list(d.containers).filter(function (c) { return c && typeof c === 'object' && !blank(c.container_number); });
    var fromRows = rows.map(function (c) {
      return { container_no: str(c.container_number), seal_no: blank(c.seal_number) ? '' : str(c.seal_number), size_type: blank(c.size_type) ? '' : str(c.size_type),
        packages: c.packages_count == null ? '' : c.packages_count, rgross: c.gross_weight == null ? '' : c.gross_weight, net: c.net_weight == null ? '' : c.net_weight };
    });
    var nums = blank(f.container_numbers) ? [] : codesOf(f.container_numbers);
    if (!nums.length) return fromRows;
    var have = setOf(fromRows.map(function (r) { return r.container_no; })).join(','), want = setOf(nums).join(',');
    if (fromRows.length && have === want) return fromRows;
    var seals = blank(f.seal_numbers) ? [] : sealsOf(f.seal_numbers);
    return nums.map(function (n, i) {
      var hit = fromRows.filter(function (r) { return ctrNo(r.container_no) === ctrNo(n); })[0];
      if (hit) return hit;
      return { container_no: n, seal_no: seals.length === nums.length ? seals[i] : (nums.length === 1 ? seals.join(', ') : ''), size_type: '', packages: '', rgross: '', net: '' };
    });
  }
  function itemRows(items, kind) {
    return list(items).filter(function (x) { return x && typeof x === 'object'; }).slice(0, 500).map(function (x) {
      if (kind === 'packing') {
        return { description: x.description, packages: x.packages, quantity: x.quantity, unit: x.unit, rgross_weight_kg: x.gross_weight != null ? x.gross_weight : x.gross_weight_kg,
          net_weight_kg: x.net_weight != null ? x.net_weight : x.net_weight_kg, container_no: x.container_number || x.container_no, seal_no: x.seal_number || x.seal_no };
      }
      return { description: x.description, supplier_hs_code: x.hs_code != null ? x.hs_code : x.supplier_hs_code, quantity: x.quantity, unit: x.unit,
        unit_price: x.unit_price, total: x.amount != null ? x.amount : x.total, origin_country: x.origin_country || x.country_of_origin, scientific_name: x.scientific_name };
    });
  }
  // owner check 2026-11-14: a quick reading has no unit price / origin per line — the unit price is derived (total ÷ quantity,
  // an average when sizes with different prices were merged) and the origin is the invoice's own country of origin
  function numOf(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[,\s]/g, '')); return isFinite(n) ? n : null; }
  function fillInvoiceItems(rows, origin) {
    return rows.map(function (r) {
      var q = numOf(r.quantity), tot = numOf(r.total);
      if (blank(r.unit_price) && q && q > 0 && tot != null) r.unit_price = String(Math.round(tot / q * 10000) / 10000);
      if (blank(r.origin_country) && !blank(origin)) r.origin_country = str(origin);
      return r;
    });
  }
  // a column empty on every row of a table is not shown (nor exported) on the draft sheet
  function dropEmptyCols(sections) {
    sections.forEach(function (sec) {
      (sec.tables || []).forEach(function (tb) {
        if (!tb.rows || !tb.rows.length) return;
        var keep = tb.cols.filter(function (c, i) { return i === 0 || tb.rows.some(function (r) { return !blank(r[c.key]); }); });
        if (keep.length) tb.cols = keep;
      });
    });
    return sections;
  }
  /* owner reference «كشف إدخال فسح» (2026-11-14, «ظبّط الكشف عليه بالظبط»): the draft sheet follows the owner's
     reference output exactly — title · strip (tx | importer | B/L | prepared) · 1 B/L (8 pairs, the quantities block,
     containers & seals with all 6 columns) · 2 invoice (10 pairs, items) · 3 packing list (when read) · the 5 common
     rows · the conflicts (the common rows that are not «مطابق» + the critical numbers that differ / are invalid). */
  var RD_COMMON = [['consignee', 'importer'], ['packages_count', 'packages'], ['gross_weight', 'gross'], ['net_weight', 'net'], ['goods_description', 'goods']];
  var RD_CRIT = ['container_numbers', 'bl_number', 'invoice_number'];
  var RD_CS = { match: 'ok', mismatch: 'diff' };   // anything else → 'review' («مراجعة سريعة»)
  // a party as printed (first line, a leading «CONSIGNEE:» / «SHIPPER:» … label dropped): the name without its address
  function partyName(v) {
    var lines = str(v).split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
    var s = lines[0] || '';
    s = s.replace(/^(consignee|shipper|buyer|seller|sold\s+to|bill\s+to|messrs\.?|to)\s*[:：-]\s*/i, '').trim();
    if (!s && lines.length > 1) s = lines[1];
    return s;
  }
  // «دولار أمريكي — USD» (en «US dollar — USD») as on the reference; unknown codes as written
  function draftCurrency(v, lang) {
    var c = currencyName(v, lang), m = /^([A-Z]{3}) — (.+)$/.exec(c);
    return m ? m[2] + ' — ' + m[1] : c;
  }
  // «FOB PORT ALPHA, SAMPLELAND»: the incoterm with its named place when the reading has it (a bare code takes the port
  // of loading for E / F terms, the port of discharge for C / D terms — the invoice's own, else the B/L's)
  var INCO_E_F = /^(EXW|FCA|FAS|FOB)$/i, INCO_C_D = /^(CFR|CNF|C&F|CIF|CPT|CIP|DAP|DPU|DAT|DDP)$/i;
  function incotermsPlace(iv, b) {
    var inc = first(iv, ['incoterms']);
    if (!inc) return '';
    var code = inc.replace(/\s*\(?incoterms?\s*\d*\)?\s*$/i, '').trim();
    var place = INCO_E_F.test(code) ? first(iv, ['port_of_loading']) || first(b, ['port_of_loading'])
      : INCO_C_D.test(code) ? first(iv, ['port_of_discharge']) || first(b, ['port_of_discharge']) : '';
    return place ? code.toUpperCase() + ' ' + place : inc;
  }
  // «٢٠٢٦/١١/٨، ٩:٣١:١٦ م» (Asia/Riyadh, Arabic-Indic digits); en «2026/11/8, 9:31:16 PM»
  function preparedText(d, lang) {
    var t = d instanceof Date ? d.getTime() : (d ? new Date(d).getTime() : Date.now());
    if (!isFinite(t)) t = Date.now();
    var x = new Date(t + RIYADH_MS), h = x.getUTCHours(), h12 = h % 12 || 12;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var day = x.getUTCFullYear() + '/' + (x.getUTCMonth() + 1) + '/' + x.getUTCDate(), time = h12 + ':' + p(x.getUTCMinutes()) + ':' + p(x.getUTCSeconds());
    if (lang === 'en') return day + ', ' + time + ' ' + (h < 12 ? 'AM' : 'PM');
    return (day + '، ' + time).replace(/\d/g, function (c) { return String.fromCharCode(0x0660 + Number(c)); }) + ' ' + (h < 12 ? 'ص' : 'م');
  }
  /* src = { docs: { bl|invoice|packing: { fields {key: value}, items [], containers [], label?, fileName?, detected?, parentDetected? } },
             result: the report's MarsaDocMatch.compare answer (strict), exceptions?: [{ st, key?, label, values, note }]
             (the report's exceptions table: only its 'invalid' critical numbers are used), now?, lang?, t?(key),
             tx?: {id, ref, client?} (the draft / linked transaction; client = its client's Arabic name) }
     → { ready: false, missing [docs], excluded [{doc, reason, label}] }
     | the buildModel shape + { ready: true, draft: true, docCols, footKey, fileSeq, excluded } */
  function buildReadingsModel(src) {
    src = src || {};
    var lang = src.lang === 'en' ? 'en' : 'ar';
    var t = typeof src.t === 'function' ? src.t : defaultT;
    var docs = src.docs && typeof src.docs === 'object' ? src.docs : {}, R = src.result && typeof src.result === 'object' ? src.result : { rows: [] };
    var use = {}, excluded = [];
    DOCS.forEach(function (k) {
      var d = docs[k];
      if (!d || typeof d !== 'object' || k === 'declaration') return;   // the reference sheet has no declaration part
      var why = readingExcluded(d);
      if (why) excluded.push({ doc: k, reason: why, label: str(d.label || d.fileName) });
      else use[k] = { fields: d.fields && typeof d.fields === 'object' ? d.fields : {}, items: list(d.items), containers: list(d.containers) };
    });
    if (!use.bl || !use.invoice) {
      return { ready: false, excluded: excluded, missing: ['bl', 'invoice'].filter(function (k) { return !use[k]; }) };
    }
    var b = use.bl.fields, iv = use.invoice.fields, pk = use.packing ? use.packing.fields : null;
    var now = src.now || new Date(), prepared = riyadhStamp(now);
    prepared.display = preparedText(now, lang);
    // [key, value, ltr, kind]: kind 'code' (monospace) | 'num' (monospace, regular) | '' (text, bold)
    function P(key, v, ltr, kind) { return [key, blank(v) ? '' : str(v).trim(), !!ltr, kind || '']; }
    var consignee = partyName(first(b, ['consignee_name', 'consignee']));
    var blNo = first(b, ['bl_number']);
    // a draft transaction was created from these readings (20261127000100): «مسودة معاملة MRS-…», the export log names it
    var dtx = src.tx && typeof src.tx === 'object' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(src.tx.id || '')) ? src.tx : null;
    // المستورد: the client of the linked transaction, else the B/L consignee name (no address), else the invoice buyer
    var importer = (dtx && !blank(dtx.client) ? str(dtx.client).trim() : '') || consignee || partyName(first(iv, ['buyer_name', 'consignee_name', 'consignee']));
    var draftText = dtx ? t('rd_draft_tx', { ref: str(dtx.ref || '') }) : t('rd_draft');
    var strip = [P('s_tx', draftText), P('s_importer', importer), P('s_bl', blNo, 1, 'code'), P('s_prepared', prepared.display, lang === 'en', 'date')];
    // containers: the B/L's own rows, else the packing list's / the invoice's
    var ctr = containerRows(use.bl);
    if (!ctr.length && use.packing) ctr = containerRows(use.packing);
    if (!ctr.length) ctr = containerRows(use.invoice);
    // «الوزن الإجمالي» as on the reference sheet (rf_gross / fc_rgross*; the transaction sheet keeps «الوزن القائم»)
    var CT = [{ key: 'container_no', type: 'code' }, { key: 'seal_no', type: 'code' }, { key: 'size_type', type: 'code' }, { key: 'packages', type: 'number' },
      { key: 'rgross', type: 'number' }, { key: 'net', type: 'number' }];
    var IT = [{ key: 'description', type: 'text' }, { key: 'supplier_hs_code', type: 'code' }, { key: 'quantity', type: 'number' }, { key: 'unit', type: 'code' },
      { key: 'unit_price', type: 'number' }, { key: 'total', type: 'number' }, { key: 'origin_country', type: 'text' }, { key: 'scientific_name', type: 'text' }];
    var PT = [{ key: 'description', type: 'text' }, { key: 'packages', type: 'number' }, { key: 'quantity', type: 'number' }, { key: 'unit', type: 'code' },
      { key: 'rgross_weight_kg', type: 'number' }, { key: 'net_weight_kg', type: 'number' }, { key: 'container_no', type: 'code' }, { key: 'seal_no', type: 'code' }];
    var vv = [first(b, ['vessel']), first(b, ['voyage'])].filter(function (x) { return !blank(x); }).join(' / ');
    var goods = P('f_goods', first(b, ['goods_description']));
    goods.brk = true;   // its own row, as on the reference (after «شروط الشحن»)
    var invRows = fillInvoiceItems(itemRows(use.invoice.items), first(iv, ['country_of_origin']));
    var invTable = { id: 'invoice_items', cols: IT, rows: invRows };
    dropEmptyCols([{ tables: [invTable] }]);   // owner-approved for the invoice items only; the other tables keep every column
    var sections = [
      { id: 'bl', titleKey: 'rsec_bl', subKey: 'fsub_bl',
        pairs: [P('f_bl_number', blNo, 1, 'code'), P('f_shipper', partyName(first(b, ['shipper']))), P('rf_consignee', consignee),
          P('f_vessel_voyage', vv, 1, 'code'), P('f_pol', first(b, ['port_of_loading'])), P('f_pod', first(b, ['port_of_discharge'])),
          P('f_freight_terms', first(b, ['freight_terms'])), goods],
        groups: [{ titleKey: 'rg_bl_qty', pairs: [P('f_packages', first(b, ['packages_count']), 1, 'num'), P('f_package_type', first(b, ['package_type'])),
          P('rf_gross', first(b, ['gross_weight']), 1, 'num'), P('rf_net', first(b, ['net_weight']), 1, 'num'), P('f_cbm', first(b, ['measurement_cbm']), 1, 'num'),
          P('f_temp', first(b, ['temperature_c']), 1, 'num')] }],
        tables: [{ id: 'rd_containers', cols: CT, rows: ctr }] },
      { id: 'invoice', titleKey: 'rsec_invoice', subKey: 'fsub_invoice',
        pairs: [P('f_invoice_no', first(iv, ['invoice_number']), 1, 'code'), P('f_invoice_date', first(iv, ['invoice_date']), 1, 'code'),
          P('f_seller', partyName(first(iv, ['supplier_name', 'shipper']))), P('f_buyer', partyName(first(iv, ['buyer_name', 'consignee_name', 'consignee']))),
          P('f_currency', draftCurrency(first(iv, ['currency']), lang), 1, 'code'), P('f_total', first(iv, ['total', 'subtotal']), 1, 'num'),
          P('f_origin', first(iv, ['country_of_origin'])), P('f_export_country', first(iv, ['export_country'])), P('f_incoterms', incotermsPlace(iv, b), 1, 'code'),
          P('f_payment_terms', first(iv, ['payment_terms', 'payment_method']))],
        tables: [invTable] }
    ];
    if (pk) {
      sections.push({ id: 'packing', titleKey: 'rsec_packing', subKey: 'fsub_packing',
        pairs: [P('f_packing_no', first(pk, ['packing_list_number']), 1, 'code'), P('rf_pk_date', first(pk, ['packing_list_date']), 1, 'code'),
          P('rf_pk_total', first(pk, ['packages_count']), 1, 'num'), P('f_package_type', first(pk, ['package_type'])), P('rf_gross', first(pk, ['gross_weight']), 1, 'num'),
          P('rf_net', first(pk, ['net_weight']), 1, 'num')],
        tables: [{ id: 'rd_packing_items', cols: PT, rows: itemRows(use.packing.items, 'packing') }] });
    }
    // document columns: the B/L, the invoice, and the packing list only when it was read (and compared)
    var cols = ['bl', 'invoice'];
    if (use.packing && (!Array.isArray(R.documents) || R.documents.indexOf('packing') !== -1)) cols.push('packing');
    var rowOf = {};
    list(R.rows).forEach(function (r) { if (r && r.key && !rowOf[r.key]) rowOf[r.key] = r; });
    // a text value as read on the document (raw: the engine row's source field, e.g. «FROZEN … (Sample Spp)», a party's
    // first line without its address — as on the reference); numbers / codes and anything else: the engine's own value
    function valsOf(r, party, raw0) {
      var o = {};
      cols.forEach(function (c) {
        var x = r && r.values ? r.values[c] : null;
        if (blank(x)) { o[c] = ''; return; }
        var sk = raw0 && r.src && typeof r.src[c] === 'string' ? r.src[c] : '', raw = sk && use[c] ? first(use[c].fields, [sk]) : '';
        if (raw && typeof use[c].fields[sk] !== 'object') x = raw;
        o[c] = party ? partyName(x) : str(x);
      });
      return o;
    }
    // the 5 common rows, statuses from the SAME strict engine rows: match → مطابق, mismatch → يوجد اختلاف, else مراجعة سريعة
    var common = RD_COMMON.map(function (x) {
      var r = rowOf[x[0]] || null, o = valsOf(r, x[0] === 'consignee', x[0] === 'consignee' || x[0] === 'goods_description');
      // a difference the shortened values would hide (e.g. the address after the name): the engine's own values
      if (r && r.status !== 'match' && setOf(cols.map(function (c) { return o[c]; }).filter(Boolean).map(searchKey)).length === 1
        && setOf(cols.map(function (c) { return blank(r.values && r.values[c]) ? '' : str(r.values[c]); }).filter(Boolean).map(searchKey)).length > 1) o = valsOf(r);
      var n = cols.filter(function (c) { return !!o[c]; }).length;
      o.key = x[0]; o.labelKey = 'rcm_' + x[1]; o.label = t('rcm_' + x[1]); o.engine = r ? r.status : 'missing';
      o.status = r && RD_CS[r.status] || 'review';
      o.missing = !r || r.status === 'missing' || n === 0;
      o.detail = r ? str(lang === 'en' ? r.detail_en || r.detail_ar : r.detail_ar || r.detail_en) : '';
      return o;
    });
    // conflicts: the common rows that differ («⚠ يوجد اختلاف») or lack a value («حقل مفقود») + the critical numbers
    // (containers, B/L, invoice) that differ / are invalid. A row that only needs a quick look («مراجعة سريعة», e.g. a
    // longer description on one document) stays in the common table only — as on the owner's reference sheet.
    var alerts = [];
    common.forEach(function (o) {
      if (o.status === 'ok' || (o.status === 'review' && !o.missing)) return;
      var kind = o.status === 'diff' ? 'conflict' : 'missing';
      var a = { kind: kind, key: o.key, field: '', label: t('rak_' + o.labelKey.slice(4)),
        note: kind === 'conflict' ? t('rnote_diff') : (o.detail || t('rnote_missing')) };
      cols.forEach(function (c) { a[c] = o[c]; });
      alerts.push(a);
    });
    RD_CRIT.forEach(function (k) {
      var r = rowOf[k];
      if (!r || r.status !== 'mismatch') return;
      var a = { kind: 'conflict', key: k, field: '', label: t('rak_' + k), note: t('rnote_diff') };
      var v = valsOf(r);
      cols.forEach(function (c) { a[c] = v[c]; });
      alerts.push(a);
    });
    var critLabels = {};
    RD_CRIT.forEach(function (k) { var r = rowOf[k]; if (r) { critLabels[str(r.label_ar)] = k; critLabels[str(r.label_en)] = k; } critLabels[t('rak_' + k)] = k; });
    list(src.exceptions).forEach(function (x) {
      if (!x || x.st !== 'invalid') return;
      var k = RD_CRIT.indexOf(x.key) !== -1 ? x.key : critLabels[str(x.label)];
      if (!k || alerts.some(function (a) { return a.key === k && a.kind === 'invalid'; })) return;
      var a = { kind: 'invalid', key: k, field: '', label: t('rak_' + k), note: str(x.note) || t('rnote_invalid') };
      cols.forEach(function (c) { var y = x.values ? x.values[c] : null; a[c] = blank(y) ? '' : str(y); });
      alerts.push(a);
    });
    return {
      ready: true, draft: true, seq: dtx ? str(dtx.ref || '') : '', txId: dtx ? String(dtx.id).toLowerCase() : null, prepared: prepared,
      fileSeq: DRAFT_SEQ, fileBase: fileName(DRAFT_SEQ, now),
      strip: strip, sections: sections, common: common, alerts: alerts, hasData: true, docCols: cols, footKey: 'rd_foot_note', excluded: excluded,
      counts: { containers: ctr.length, invoice: invRows.length, packing: pk ? sections[2].tables[0].rows.length : 0, declaration: 0 }
    };
  }
  // the draft (owner reference) words: «مطابق / يوجد اختلاف / مراجعة سريعة», «⚠ يوجد اختلاف / مراجعة سريعة / حقل مفقود»,
  // numbered section titles and the conflicts table's own column names; the transaction sheet keeps its own
  function csLabel(m, t, st) { return t((m.draft ? 'rcs_' : 'cs_') + st); }
  function akLabel(m, t, kind) { return t((m.draft ? 'rak_' : 'ak_') + kind); }
  function secTitle(m, s, i, t) { var x = t(s.titleKey || 'fsec_' + s.id); return m.draft ? (i + 1) + ' — ' + x : x; }
  function alertCols(m) { return m.draft ? docCols(m) : ['bl', 'invoice', 'packing']; }
  function alertColLabel(m, t, c) { return t((m.draft ? 'rcol_' : 'col_') + c); }
  // a table column's name: the draft's own wording where the reference differs (rfc_*, e.g. «HS Code المورد»), else fc_*
  function colLabel(m, t, key) {
    if (m && m.draft) { var k = 'rfc_' + key, x = t(k); if (x && x !== k && x !== 'decl.' + k) return x; }
    return t('fc_' + key);
  }
  // the model → rows of [section, field, value] (the main sheet / the CSV) with the tables flattened after their section
  function flatRows(m, t) {
    var out = [];
    m.strip.forEach(function (p) { out.push({ section: t('sec_summary'), field: t(p[0]), value: p[1] }); });
    m.sections.forEach(function (s, i) {
      var title = secTitle(m, s, i, t);
      s.pairs.forEach(function (p) { out.push({ section: title, field: t(p[0]), value: p[1] }); });
      (s.groups || []).forEach(function (gr) { gr.pairs.forEach(function (p) { out.push({ section: t(gr.titleKey), field: t(p[0]), value: p[1] }); }); });
      s.tables.forEach(function (tb) {
        tb.rows.forEach(function (r, j) {
          out.push({ section: t('ftab_' + tb.id), field: '#' + (j + 1), value: tb.cols.map(function (c) {
            var v = r[c.key]; return blank(v) ? (m.draft ? colLabel(m, t, c.key) + ': ' + NONE : null) : colLabel(m, t, c.key) + ': ' + str(v);
          }).filter(Boolean).join(' | ') });
        });
      });
    });
    m.common.forEach(function (r) {
      out.push({ section: t('sec_common'), field: r.label || t('cm_' + r.key), value: docCols(m).map(function (c) {
        return blank(r[c]) ? (m.draft ? t('col_' + c) + ': ' + NONE : null) : t('col_' + c) + ': ' + r[c];
      }).filter(Boolean).join(' | ') + ' → ' + csLabel(m, t, r.status) });
    });
    m.alerts.forEach(function (a) {
      out.push({ section: t('sec_alerts'), field: akLabel(m, t, a.kind) + ': ' + (a.label || t(a.field)), value: (m.draft ? docCols(m).map(function (c) { return alertColLabel(m, t, c) + ': ' + (blank(a[c]) ? NONE : a[c]); })
        : [a.bl, a.invoice, a.packing]).concat([a.note]).filter(function (x) { return !blank(x); }).join(' | ') });
    });
    if (m.draft && !m.alerts.length) out.push({ section: t('sec_alerts'), field: '', value: t('rd_alerts_none') });
    return out;
  }
  var XTYPE = { code: 'text', text: 'text', number: 'number', int: 'int' };
  // the model → a MarsaXlsx.build spec: the main sheet + one sheet per table + common values + alerts
  function xlsxSpec(m, t, lang) {
    var empty = m.draft ? NONE : '';
    function typed(tb) {
      return { name: t('ftab_' + tb.id), rtl: lang !== 'en', columns: tb.cols.map(function (c) { return { key: c.key, label: colLabel(m, t, c.key), type: XTYPE[c.type] || 'text', width: c.key.indexOf('description') !== -1 ? 40 : 16 }; }),
        rows: tb.rows.map(function (r) {
          var o = {};
          tb.cols.forEach(function (c) { var v = r[c.key]; o[c.key] = (c.type === 'number' || c.type === 'int') ? (toNum(v) == null ? (blank(v) ? null : str(v)) : toNum(v)) : (blank(v) ? empty : str(v)); });
          return o;
        }), totals: null };
    }
    var main = flatRows({ draft: m.draft, docCols: m.docCols, strip: m.strip, sections: m.sections.map(function (s) { return { id: s.id, titleKey: s.titleKey, pairs: s.pairs, groups: s.groups, tables: [] }; }), common: [], alerts: [] }, t)
      .filter(function (r) { return r.section !== t('sec_alerts'); });   // no «لا توجد تعارضات» line on the main sheet
    var DC = docCols(m), AC = alertCols(m);
    var sheets = [{ name: t('sheet_main'), rtl: lang !== 'en', columns: [{ key: 'section', label: t('col_section'), type: 'text', width: 26 },
      { key: 'field', label: t('col_field'), type: 'text', width: 28 }, { key: 'value', label: t('col_value'), type: 'text', width: 50 }], rows: main, totals: null }];
    m.sections.forEach(function (s) { s.tables.forEach(function (tb) { sheets.push(typed(tb)); }); });
    sheets.push({ name: t('sec_common'), rtl: lang !== 'en', columns: [{ key: 'field', label: t('col_field'), type: 'text', width: 24 }]
      .concat(DC.map(function (c) { return { key: c, label: t('col_' + c), type: 'text', width: 26 }; }))
      .concat([{ key: 'result', label: t('col_result'), type: 'text', width: 18 }]),
      rows: m.common.map(function (r) {
        var o = { field: r.label || t('cm_' + r.key), result: csLabel(m, t, r.status) };
        DC.forEach(function (c) { o[c] = c === 'invoice' ? r.invoice + (r.lines ? ' / ' + r.lines : '') : r[c]; if (blank(o[c])) o[c] = empty; });
        return o;
      }), totals: null });
    var arows = m.alerts.map(function (a) {
      var o = { kind: akLabel(m, t, a.kind), field: a.label || t(a.field), note: a.note };
      AC.forEach(function (c) { o[c] = blank(a[c]) ? empty : a[c]; });
      return o;
    });
    if (m.draft && !arows.length) arows.push({ kind: '', field: t('rd_alerts_none'), note: '' });
    sheets.push({ name: t('sec_alerts'), rtl: lang !== 'en', columns: [{ key: 'kind', label: t('col_kind'), type: 'text', width: 16 },
      { key: 'field', label: t(m.draft ? 'rcol_field' : 'col_field'), type: 'text', width: 26 }]
      .concat(AC.map(function (c) { return { key: c, label: alertColLabel(m, t, c), type: 'text', width: 22 }; }))
      .concat([{ key: 'note', label: t(m.draft ? 'rcol_note' : 'col_note'), type: 'text', width: 30 }]),
      rows: arows, totals: null });
    return { title: t('sheet_title'), generatedAt: new Date(), sheets: sheets,
      meta: [[t('s_tx'), m.draft ? m.strip[0][1] : m.seq], [t('s_prepared'), m.draft && m.prepared.display ? m.prepared.display : m.prepared.text], [t('meta_note'), t(m.footKey || 'foot_note')]], metaName: t('sheet_meta') };
  }
  function rowCount(m) {
    var n = m.strip.length + m.common.length + m.alerts.length + (m.draft && !m.alerts.length ? 1 : 0);
    m.sections.forEach(function (s) {
      n += s.pairs.length;
      (s.groups || []).forEach(function (g) { n += g.pairs.length; });
      s.tables.forEach(function (tb) { n += tb.rows.length; });
    });
    return n;
  }

  /* ------------------------------------------------------------------
     UI: an overlay (role dialog) on the transaction page
     ------------------------------------------------------------------ */
  function defaultT(k, vars) {
    var I = root.MarsaI18n, key = 'decl.' + k;
    if (!I || typeof I.t !== 'function') return k;
    var s = I.t(key, vars);
    return s === key ? k : s;
  }
  function call(api, name) {
    var A = api && (api.MarsaApi || api), f = A && A[name];
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof f !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', message: name } });
    return Promise.resolve().then(function () { return f.apply(A, args); })
      .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
  }
  /* every export: logged FIRST through logReportExport({report: 'fasah_sheet', format, filters, row_count}) — never the
     row data — and the file is built only when the log succeeded. filters: {transaction_id} for a transaction's sheet,
     {} for a readings draft (no transaction yet; log_report_export accepts no filter key).
     o = { api, model, format: 'print'|'xlsx'|'csv', t, lang, status (element), orgId?, print?() } → Promise<boolean> */
  function exportSheet(o) {
    var api = o.api, model = o.model, format = o.format, t = o.t, lang = o.lang, status = o.status;
    if (!model) return Promise.resolve(false);
    var A = api && (api.MarsaApi || api);
    var n = rowCount(model);
    var filters = model.txId ? { transaction_id: model.txId } : {};
    status.textContent = t('exporting');
    return call(api, 'logReportExport', { report: 'fasah_sheet', format: format, filters: filters, row_count: n, orgId: o.orgId || api && api.orgId || undefined })
      .then(function (r) {
        if (r.error) { status.textContent = t('export_failed') + ' ' + (api && api.errText ? api.errText(r.error) : (A && A.errorMessage ? A.errorMessage(r.error) : r.error.message || '')); return false; }
        var X = root.MarsaExport, XL = root.MarsaXlsx, seq = model.draft ? model.fileSeq : (model.seq || model.txId);
        try {
          if (format === 'print') { status.textContent = ''; if (typeof o.print === 'function') o.print(); else if (typeof root.print === 'function') root.print(); return true; }
          if (!X || typeof X.download !== 'function') throw new Error('download');
          if (format === 'xlsx') {
            if (!XL || typeof XL.blob !== 'function') throw new Error('xlsx');
            X.download(XL.blob(xlsxSpec(model, t, lang)), fileName(seq, new Date(), 'xlsx'));
          } else {
            var rows = flatRows(model, t);
            var csv = X.toCsv([{ key: 'section', label: t('col_section'), type: 'text' }, { key: 'field', label: t('col_field'), type: 'text' },
              { key: 'value', label: t('col_value'), type: 'text' }], rows, null);
            X.download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), fileName(seq, new Date(), 'csv'));
          }
          status.textContent = t('exported', { n: n });
          return true;
        } catch (e) { status.textContent = t('export_failed'); return false; }
      });
  }
  var current = null;
  function close() {
    if (!current) return;
    var c = current; current = null;
    if (c.node.parentNode) c.node.parentNode.removeChild(c.node);
    c.doc.body.classList.remove('fsh-open');
    if (typeof c.doc.removeEventListener === 'function') c.doc.removeEventListener('keydown', c.onKey);
    if (c.back && c.back.focus) { try { c.back.focus(); } catch (e) { /* gone */ } }
  }
  // open(tx, api, opts?) → Promise<model | null>
  function open(tx, api, opts) {
    opts = opts || {};
    close();
    var doc = (typeof document !== 'undefined' ? document : root.document), t = typeof opts.t === 'function' ? opts.t : defaultT;
    var lang = api && typeof api.isEn === 'function' && api.isEn() ? 'en' : (root.MarsaI18n && root.MarsaI18n.lang && root.MarsaI18n.lang() === 'en' ? 'en' : 'ar');
    function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function btn(text, cls, fn) { var b = el('button', 'btn btn-sm ' + cls, text); b.type = 'button'; b.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); fn(b); }); return b; }
    function v(text, ltr) { var b = el('bdi', ltr ? 'num' : null, blank(text) ? NONE : String(text)); b.dir = ltr ? 'ltr' : 'auto'; return b; }
    var node = el('div', 'fsh-overlay');
    node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-labelledby', 'fsh-title');
    node.dir = lang === 'en' ? 'ltr' : 'rtl'; node.lang = lang;
    var bar = el('div', 'fsh-toolbar');
    var h = el('h2', 'fsh-title', t('sheet_title')); h.id = 'fsh-title';
    bar.appendChild(h);
    var acts = el('div', 'fsh-actions');
    var status = el('p', 'fsh-status text-sm'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    var sheet = el('div', 'fsh-sheet');
    sheet.appendChild(el('p', 'text-sm text-muted', t('loading')));
    var back = doc.activeElement;
    var closeB = btn(t('close'), 'btn-ghost', close);
    var model = null;
    function exp(format) { exportSheet({ api: api, model: model, format: format, t: t, lang: lang, status: status }); }
    var pB = btn(t('print'), 'btn-primary', function () { exp('print'); }), xB = btn(t('excel'), 'btn-secondary', function () { exp('xlsx'); }),
      cB = btn(t('csv'), 'btn-ghost', function () { exp('csv'); });
    [pB, xB, cB].forEach(function (b) { b.disabled = true; acts.appendChild(b); });
    acts.appendChild(closeB);
    bar.appendChild(acts);
    node.appendChild(bar);
    node.appendChild(status);
    node.appendChild(sheet);
    doc.body.appendChild(node);
    doc.body.classList.add('fsh-open');
    var onKey = function (e) { if (e && e.key === 'Escape') close(); };
    doc.addEventListener('keydown', onKey);
    current = { node: node, onKey: onKey, back: back, doc: doc };
    try { closeB.focus(); } catch (e) { /* noop */ }
    var mine = current;
    function label(domain, code, fallbackKey) {
      if (api && typeof api.label === 'function') { try { var s = api.label(domain, code); if (s && s !== code && s !== NONE) return s; } catch (e) { /* below */ } }
      var k = fallbackKey + code, x = t(k);
      return x === k ? String(code) : x;
    }
    return Promise.all([call(api, 'getTransactionShipment', tx.id), call(api, 'getTransactionDeclaration', tx.id), call(api, 'listContainers', tx.id)]).then(function (rs) {
      if (current !== mine) return null;
      sheet.textContent = '';
      // review fix: ANY failed source stops the sheet (a transient error must never print / export as «no declaration» /
      // «no shipment data» / the B/L containers only)
      var err = rs[0].error || rs[1].error || rs[2].error || null;
      if (err) { sheet.appendChild(el('div', 'alert alert-danger', api && api.errText ? api.errText(err) : (err.message || t('err_generic')))); return null; }
      model = buildModel({ tx: tx, shipment: rs[0].data || {}, decl: rs[1].data || {}, containers: Array.isArray(rs[2].data) ? rs[2].data : [], lang: lang,
        statusLabel: function (c) { return label('declaration_status', c, 'st_'); },
        typeLabel: function (c) { return label('declaration_type', c, 'type_'); },
        sourceLabel: function (c) { return /^d_/.test(c) ? label('declaration_source', c.slice(2), 'dsrc_') : label('container_source', c, 'csrc_'); } });
      render(sheet, model, t, el, v);
      [pB, xB, cB].forEach(function (b) { b.disabled = false; });
      if (!model.hasData) status.textContent = t('sheet_empty');
      return model;
    });
  }
  function render(sheet, m, t, el, v) {
    var strip = el('div', 'fsh-strip');
    m.strip.forEach(function (p) { var d = el('div', 'fsh-strip-item'); d.appendChild(el('b', null, t(p[0]))); d.appendChild(v(p[1], p[2])); strip.appendChild(d); });
    sheet.appendChild(strip);
    function table(cols, rows, empty, cls) {
      var wrap = el('div', 'table-wrap fsh-table-wrap');
      var tbl = el('table', 'table fsh-table' + (cls ? ' ' + cls : ''));
      var th = el('thead'), tr = el('tr');
      cols.forEach(function (c) { var x = el('th', null, c.label); x.scope = 'col'; tr.appendChild(x); });
      th.appendChild(tr); tbl.appendChild(th);
      var tb = el('tbody');
      if (!rows.length) { var e = el('tr'); var td = el('td', 'text-muted', empty); td.colSpan = cols.length; e.appendChild(td); tb.appendChild(e); }
      rows.forEach(function (r) {
        var row = el('tr');
        cols.forEach(function (c) {
          var td = el('td', c.ltr ? 'num' : null);
          if (c.render) c.render(td, r); else td.appendChild(v(r[c.key], c.ltr));
          row.appendChild(td);
        });
        tb.appendChild(row);
      });
      tbl.appendChild(tb); wrap.appendChild(tbl);
      return wrap;
    }
    m.sections.forEach(function (s, i) {
      var sec = el('section', 'fsh-sec');
      var head = el('div', 'fsh-sec-title');
      head.appendChild(el('span', null, (i + 1) + ' — ' + t(s.titleKey || 'fsec_' + s.id)));
      head.appendChild(el('small', null, t(s.subKey || 'fsub_' + s.id)));
      sec.appendChild(head);
      if (s.pairs.length) {
        var g = el('dl', 'fsh-grid');
        s.pairs.forEach(function (p) { var d = el('div', 'fsh-cell' + (p[0] === 'f_goods' ? ' is-full' : '')); d.appendChild(el('dt', null, t(p[0]))); var dd = el('dd'); dd.appendChild(v(p[1], p[2])); d.appendChild(dd); g.appendChild(d); });
        sec.appendChild(g);
      }
      // readings draft: a titled group of pairs (e.g. «الكميات والأوزان كما وردت في البوليصة»)
      (s.groups || []).forEach(function (gr) {
        sec.appendChild(el('h3', 'fsh-sub', t(gr.titleKey)));
        var g2 = el('dl', 'fsh-grid');
        gr.pairs.forEach(function (p) { var d = el('div', 'fsh-cell'); d.appendChild(el('dt', null, t(p[0]))); var dd = el('dd'); dd.appendChild(v(p[1], p[2])); d.appendChild(dd); g2.appendChild(d); });
        sec.appendChild(g2);
      });
      s.tables.forEach(function (tb) {
        sec.appendChild(el('h3', 'fsh-sub', t('ftab_' + tb.id) + ' (' + tb.rows.length + ')'));
        sec.appendChild(table(tb.cols.map(function (c) { return { key: c.key, label: t('fc_' + c.key), ltr: c.type !== 'text' }; }), tb.rows, t('rows_empty')));
      });
      sheet.appendChild(sec);
    });
    var cs = el('section', 'fsh-sec fsh-common');
    var ch = el('div', 'fsh-sec-title'); ch.appendChild(el('span', null, t('sec_common'))); ch.appendChild(el('small', null, t('common_sub'))); cs.appendChild(ch);
    var DC = docCols(m);
    cs.appendChild(table([{ key: 'k', label: t('col_field'), render: function (td, r) { td.textContent = r.label || t('cm_' + r.key); } }]
      .concat(DC.map(function (c) {
        return c === 'invoice' ? { key: 'invoice', label: t('col_invoice'), render: function (td, r) { td.appendChild(v(r.invoice + (r.lines ? ' / ' + t('lines_sum') + ' ' + r.lines : ''))); } }
          : { key: c, label: t('col_' + c) };
      }))
      .concat([{ key: 's', label: t('col_result'), render: function (td, r) { td.appendChild(el('span', 'fsh-result is-' + r.status, t('cs_' + r.status))); } }]), m.common, t('rows_empty')));
    sheet.appendChild(cs);
    var as = el('section', 'fsh-sec fsh-alerts');
    var ah = el('div', 'fsh-sec-title'); ah.appendChild(el('span', null, t('sec_alerts'))); ah.appendChild(el('small', null, t('alerts_sub'))); as.appendChild(ah);
    as.appendChild(table([{ key: 'kind', label: t('col_kind'), render: function (td, a) { td.appendChild(el('span', 'fsh-result is-' + (AK_CLS[a.kind] || 'diff'), t('ak_' + a.kind))); } },
      { key: 'field', label: t('col_field'), render: function (td, a) { td.textContent = a.label || t(a.field); } }]
      .concat((m.draft ? DC : ['bl', 'invoice', 'packing']).map(function (c) { return { key: c, label: t('col_' + c), ltr: !m.draft }; }))
      .concat([{ key: 'note', label: t('col_note') }]), m.alerts, t('alerts_none')));
    sheet.appendChild(as);
    sheet.appendChild(el('p', 'fsh-foot text-sm text-muted', t(m.footKey || 'foot_note')));
  }

  /* the readings draft drawn like the owner's reference sheet: centred title, a strip of 4 boxes, light blue section
     heads (number + title on the reading-start side, the English tag on the other), label / value boxes 3 per row,
     light green table rows, the 5 common rows and the conflicts. Screen and print (decl.css .fsh-draft). */
  var RK_CLS = { conflict: 'diff', invalid: 'diff', missing: 'review', review: 'review' };
  function renderReadings(sheet, m, t, el) {
    function val(text, ltr, kind) {
      var cls = kind === 'code' ? 'num fsh-mono' : kind === 'num' ? 'num fsh-mono is-num' : kind === 'date' ? 'fsh-strong' : 'fsh-strong';
      var b = el('bdi', cls, blank(text) ? NONE : String(text));
      b.dir = blank(text) ? 'auto' : (ltr ? 'ltr' : 'auto');
      return b;
    }
    function head(title, tag) {
      var h = el('div', 'fsh-rhead');
      h.appendChild(el('h3', 'fsh-rhead-t', title));
      if (tag) { var g = el('span', 'fsh-rhead-tag', tag); g.dir = 'auto'; h.appendChild(g); }
      return h;
    }
    function grid(pairs) {
      var g = el('div', 'fsh-rgrid');
      pairs.forEach(function (p) {
        var d = el('div', 'fsh-rpair' + (p.brk ? ' is-break' : ''));
        d.appendChild(el('span', 'fsh-rpl', t(p[0])));
        var vv = el('span', 'fsh-rpv'); vv.appendChild(val(p[1], p[2], p[3])); d.appendChild(vv);
        g.appendChild(d);
      });
      return g;
    }
    function table(cols, rows, emptyText, cls) {
      var wrap = el('div', 'table-wrap fsh-rtable-wrap');
      var tbl = el('table', 'fsh-rtable' + (cls ? ' ' + cls : ''));
      var th = el('thead'), tr = el('tr');
      cols.forEach(function (c) { var x = el('th', null, c.label); x.scope = 'col'; tr.appendChild(x); });
      th.appendChild(tr); tbl.appendChild(th);
      var tb = el('tbody');
      if (!rows.length) { var e = el('tr'); var td0 = el('td', 'is-empty', emptyText); td0.colSpan = cols.length; e.appendChild(td0); tb.appendChild(e); }
      rows.forEach(function (r) {
        var row = el('tr');
        cols.forEach(function (c) {
          var td = el('td', c.cls || null);
          if (c.render) c.render(td, r);
          else { var x = r[c.key], b = el('bdi', c.mono ? 'fsh-mono' : null, blank(x) ? NONE : String(x)); b.dir = c.mono && !blank(x) ? 'ltr' : 'auto'; td.appendChild(b); }
          row.appendChild(td);
        });
        tb.appendChild(row);
      });
      tbl.appendChild(tb); wrap.appendChild(tbl);
      return wrap;
    }
    sheet.appendChild(el('h2', 'fsh-doc-title', t('sheet_title')));
    var strip = el('div', 'fsh-rstrip');
    m.strip.forEach(function (p) {
      var d = el('div', 'fsh-rstrip-item');
      d.appendChild(el('span', 'fsh-rl', t(p[0])));
      d.appendChild(val(p[1], p[2], p[3] === 'code' ? 'code' : ''));
      strip.appendChild(d);
    });
    sheet.appendChild(strip);
    m.sections.forEach(function (s, i) {
      var sec = el('section', 'fsh-sec fsh-rsec fsh-rsec-' + s.id);
      sec.appendChild(head(secTitle(m, s, i, t), t(s.subKey || 'fsub_' + s.id)));
      if (s.pairs.length) sec.appendChild(grid(s.pairs));
      (s.groups || []).forEach(function (gr) { sec.appendChild(el('h4', 'fsh-rbar', t(gr.titleKey))); sec.appendChild(grid(gr.pairs)); });
      s.tables.forEach(function (tb) {
        sec.appendChild(el('h4', 'fsh-rbar', t('ftab_' + tb.id)));
        sec.appendChild(table(tb.cols.map(function (c) {
          var mono = c.type !== 'text';
          return { key: c.key, label: colLabel(m, t, c.key), mono: mono, cls: mono ? 'is-c' : (c.key === 'description' ? 'is-s' : 'is-c') };
        }), tb.rows, t('rows_empty'), 'fsh-rtable-items'));
      });
      sheet.appendChild(sec);
    });
    var DC = docCols(m);
    var cs = el('section', 'fsh-sec fsh-rsec fsh-common');
    cs.appendChild(head(t('sec_common'), t('common_sub')));
    cs.appendChild(table([{ key: 'label', label: t('col_field'), cls: 'is-s' }]
      .concat(DC.map(function (c) { return { key: c, label: t('col_' + c), cls: 'is-s' }; }))
      .concat([{ key: 's', label: t('col_result'), cls: 'is-c', render: function (td, r) { td.appendChild(el('span', 'fsh-rres is-' + r.status, csLabel(m, t, r.status))); } }]),
      m.common, t('rows_empty')));
    sheet.appendChild(cs);
    var as = el('section', 'fsh-sec fsh-rsec fsh-alerts');
    as.appendChild(head(t('sec_alerts'), t('rd_alerts_sub')));
    as.appendChild(table([{ key: 'kind', label: t('col_kind'), cls: 'is-c', render: function (td, a) { td.appendChild(el('span', 'fsh-rres is-' + (RK_CLS[a.kind] || 'diff'), akLabel(m, t, a.kind))); } },
      { key: 'label', label: t('rcol_field'), cls: 'is-c fsh-strong' }]
      .concat(DC.map(function (c) { return { key: c, label: alertColLabel(m, t, c), cls: 'is-s fsh-strong', mono: true }; }))
      .concat([{ key: 'note', label: t('rcol_note'), cls: 'is-s' }]), m.alerts, t('rd_alerts_none'), 'fsh-rtable-alerts'));
    sheet.appendChild(as);
    sheet.appendChild(el('p', 'fsh-foot', t(m.footKey || 'foot_note')));
  }

  /* ------------------------------------------------------------------
     UI: the readings draft inline (ocr.html matching report) + print through the overlay
     ------------------------------------------------------------------ */
  // renderDraft(host, src, opts?) → the model (or the not-ready answer). src = buildReadingsModel's input;
  // opts = { api, orgId?, t?(key, vars), docName?(k) }. Rebuilt on every call (the report re-renders after each correction).
  function renderDraft(host, src, opts) {
    opts = opts || {};
    src = src || {};
    var doc = host.ownerDocument || (typeof document !== 'undefined' ? document : root.document);
    var t = typeof opts.t === 'function' ? opts.t : defaultT, lang = src.lang === 'en' ? 'en' : 'ar';
    var docName = typeof opts.docName === 'function' ? opts.docName : function (k) { return t('col_' + k); };
    function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    var m = buildReadingsModel({ docs: src.docs, result: src.result, exceptions: src.exceptions, now: src.now, lang: lang, t: t, tx: src.tx });
    host.textContent = '';
    (m.excluded || []).forEach(function (x) {
      var n = el('div', 'alert alert-warning fsh-note', t('rd_excluded_' + x.reason, { file: x.label || docName(x.doc), doc: docName(x.doc) }));
      n.setAttribute('role', 'note'); n.dir = 'auto'; host.appendChild(n);
    });
    if (!m.ready) {
      // a slot filled by a reading that was left out asks for the original document, not «not read yet»
      var out = (m.excluded || []).map(function (x) { return x.doc; });
      var key = m.missing.every(function (k) { return out.indexOf(k) !== -1; }) ? 'rd_need_original' : 'rd_need';
      host.appendChild(el('p', 'text-sm text-muted fsh-note', t(key, { docs: m.missing.map(docName).join(lang === 'en' ? ', ' : '، ') })));
      return m;
    }
    var bar = el('div', 'fsh-draft-bar');
    bar.appendChild(el('p', 'text-sm text-muted fsh-draft-lead', t('rd_lead')));
    var acts = el('div', 'fsh-actions');
    var status = el('p', 'fsh-status text-sm'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    var sheet = el('div', 'fsh-sheet fsh-draft');
    sheet.dir = lang === 'en' ? 'ltr' : 'rtl'; sheet.lang = lang;
    renderReadings(sheet, m, t, el);
    function go(format) {
      return exportSheet({ api: opts.api, model: m, format: format, t: t, lang: lang, status: status, orgId: opts.orgId,
        print: function () { printSheet(sheet, t, lang); } });
    }
    [['print', 'btn-primary', 'print'], ['excel', 'btn-secondary', 'xlsx'], ['csv', 'btn-ghost', 'csv']].forEach(function (x) {
      var b = el('button', 'btn btn-sm ' + x[1], t(x[0])); b.type = 'button';
      b.setAttribute('data-fsh-export', x[2]);
      b.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); go(x[2]); });
      acts.appendChild(b);
    });
    bar.appendChild(acts);
    host.appendChild(bar);
    host.appendChild(status);
    host.appendChild(sheet);
    m.exportAs = go;
    return m;
  }
  // print / PDF: a copy of the sheet in the overlay (body.fsh-open → decl.css prints the overlay only, A4); removed after
  // the print (afterprint), by its close button or Escape
  function printSheet(sheet, t, lang) {
    close();
    var doc = sheet.ownerDocument || root.document;
    function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    var node = el('div', 'fsh-overlay fsh-print-copy');
    node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-labelledby', 'fsh-title');
    node.dir = lang === 'en' ? 'ltr' : 'rtl'; node.lang = lang;
    var bar = el('div', 'fsh-toolbar');
    // the sheet carries its own centred title (as on the reference): the toolbar one only names the dialog
    var h = el('h2', 'fsh-title fsh-title-sr', t('sheet_title')); h.id = 'fsh-title';
    bar.appendChild(h);
    var acts = el('div', 'fsh-actions');
    var cl = el('button', 'btn btn-sm btn-ghost', t('close')); cl.type = 'button';
    cl.addEventListener('click', function () { close(); });
    acts.appendChild(cl);
    bar.appendChild(acts);
    node.appendChild(bar);
    node.appendChild(sheet.cloneNode(true));
    var back = doc.activeElement;
    doc.body.appendChild(node);
    doc.body.classList.add('fsh-open');
    var onKey = function (e) { if (e && e.key === 'Escape') close(); };
    doc.addEventListener('keydown', onKey);
    current = { node: node, onKey: onKey, back: back, doc: doc };
    var mine = current;
    var done = function () {
      if (typeof root.removeEventListener === 'function') root.removeEventListener('afterprint', done);
      if (current === mine) close();
    };
    if (typeof root.addEventListener === 'function') root.addEventListener('afterprint', done);
    try { cl.focus(); } catch (e) { /* noop */ }
    try { if (typeof root.print === 'function') root.print(); } catch (e) { /* blocked: the close button stays */ }
    return node;
  }

  root.MarsaFasahSheet = {
    VERSION: 'fasah-sheet-3', open: open, close: close, renderDraft: renderDraft, printSheet: printSheet, exportSheet: exportSheet,
    pure: { buildReadingsModel: buildReadingsModel, partyName: partyName, draftCurrency: draftCurrency, incotermsPlace: incotermsPlace, preparedText: preparedText, readingExcluded: readingExcluded, containerRows: containerRows, docCols: docCols, numEquivalent: numEquivalent, currencyName: currencyName, fileName: fileName, riyadhStamp: riyadhStamp, buildModel: buildModel,
      commonRow: commonRow, flatRows: flatRows, xlsxSpec: xlsxSpec, rowCount: rowCount, searchKey: searchKey, toNum: toNum, CURRENCIES: CURRENCIES }
  };
})(typeof window !== 'undefined' ? window : this);
