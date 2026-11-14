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
  var ENGINE_CS = { match: 'ok', mismatch: 'diff', partial: 'review', info: 'review' };
  var EXC_KIND = { mismatch: 'conflict', invalid: 'invalid', missing: 'missing', partial: 'review' };
  /* src = { docs: { bl|invoice|packing|declaration: { fields {key: value}, items [], containers [], label?, fileName?, detected?,
             parentDetected? } }, result: the report's MarsaDocMatch.compare answer (strict), exceptions?: [{ st, label, values, note }]
             (the report's exceptions table), now?, lang?, t?(key), tx?: {id, ref} (the draft transaction made from them) }
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
      if (!d || typeof d !== 'object') return;
      var why = readingExcluded(d);
      if (why) excluded.push({ doc: k, reason: why, label: str(d.label || d.fileName) });
      else use[k] = { fields: d.fields && typeof d.fields === 'object' ? d.fields : {}, items: list(d.items), containers: list(d.containers) };
    });
    if (!use.bl || !use.invoice) {
      return { ready: false, excluded: excluded, missing: ['bl', 'invoice'].filter(function (k) { return !use[k]; }) };
    }
    var b = use.bl.fields, iv = use.invoice.fields, pk = use.packing ? use.packing.fields : null, de = use.declaration ? use.declaration.fields : null;
    var prepared = riyadhStamp(src.now || new Date());
    function P(key, v, ltr) { return [key, blank(v) ? '' : str(v).trim(), !!ltr]; }
    var importer = first(b, ['consignee_name', 'consignee']) || first(iv, ['buyer_name', 'consignee_name', 'consignee']);
    var blNo = first(b, ['bl_number']);
    // a draft transaction was created from these readings (20261127000100): «مسودة معاملة MRS-…», the export log names it
    var dtx = src.tx && typeof src.tx === 'object' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(src.tx.id || '')) ? src.tx : null;
    var draftText = dtx ? t('rd_draft_tx', { ref: str(dtx.ref || '') }) : t('rd_draft');
    var strip = [P('s_tx', draftText), P('s_importer', importer), P('s_bl', blNo, 1), P('s_prepared', prepared.text, 1)];
    // containers: the B/L's own rows, else the packing list's / the invoice's
    var ctr = containerRows(use.bl);
    if (!ctr.length && use.packing) ctr = containerRows(use.packing);
    if (!ctr.length) ctr = containerRows(use.invoice);
    // «الوزن الإجمالي» as on the reference sheet (rf_gross / fc_rgross*; the transaction sheet keeps «الوزن القائم»)
    var CT = [{ key: 'container_no', type: 'code' }, { key: 'seal_no', type: 'code' }, { key: 'size_type', type: 'code' }, { key: 'packages', type: 'number' },
      { key: 'rgross', type: 'number' }, { key: 'net', type: 'number' }];
    var IT = [{ key: 'description', type: 'text' }, { key: 'supplier_hs_code', type: 'code' }, { key: 'quantity', type: 'number' }, { key: 'unit', type: 'text' },
      { key: 'unit_price', type: 'number' }, { key: 'total', type: 'number' }, { key: 'origin_country', type: 'text' }, { key: 'scientific_name', type: 'text' }];
    var PT = [{ key: 'description', type: 'text' }, { key: 'packages', type: 'number' }, { key: 'quantity', type: 'number' }, { key: 'unit', type: 'text' },
      { key: 'rgross_weight_kg', type: 'number' }, { key: 'net_weight_kg', type: 'number' }, { key: 'container_no', type: 'code' }, { key: 'seal_no', type: 'code' }];
    var vv = [first(b, ['vessel']), first(b, ['voyage'])].filter(function (x) { return !blank(x); }).join(' / ');
    var blPairs = [P('f_bl_number', blNo, 1), P('f_shipper', first(b, ['shipper'])), P('rf_consignee', first(b, ['consignee_name', 'consignee'])),
      P('f_vessel_voyage', vv, 1), P('f_pol', first(b, ['port_of_loading'])), P('f_pod', first(b, ['port_of_discharge'])),
      P('f_freight_terms', first(b, ['freight_terms'])), P('f_goods', first(b, ['goods_description']))];
    // printed on the B/L but not on the reference sheet: listed only when the reading returned them
    [['f_notify', 'notify_party'], ['f_shipping_line', 'shipping_line'], ['f_booking', 'booking_number', 1], ['f_place_receipt', 'place_of_receipt'],
      ['f_place_delivery', 'place_of_delivery']].forEach(function (x) { var v = first(b, [x[1]]); if (v) blPairs.splice(blPairs.length - 1, 0, P(x[0], v, x[2])); });
    var sections = [
      { id: 'bl', titleKey: 'rsec_bl', pairs: blPairs,
        groups: [{ titleKey: 'rg_bl_qty', pairs: [P('f_packages', first(b, ['packages_count']), 1), P('f_package_type', first(b, ['package_type'])),
          P('rf_gross', first(b, ['gross_weight']), 1), P('f_net', first(b, ['net_weight']), 1), P('f_cbm', first(b, ['measurement_cbm']), 1), P('f_temp', first(b, ['temperature_c']), 1)] }],
        tables: [{ id: 'rd_containers', cols: CT, rows: ctr }] },
      { id: 'invoice', titleKey: 'rsec_invoice', pairs: [P('f_invoice_no', first(iv, ['invoice_number']), 1), P('f_invoice_date', first(iv, ['invoice_date']), 1),
        P('f_seller', first(iv, ['supplier_name', 'shipper'])), P('f_buyer', first(iv, ['buyer_name', 'consignee_name', 'consignee'])),
        P('f_currency', currencyName(first(iv, ['currency']), lang), 1), P('f_total', first(iv, ['total', 'subtotal']), 1),
        P('f_origin', first(iv, ['country_of_origin'])), P('f_export_country', first(iv, ['export_country'])), P('f_incoterms', first(iv, ['incoterms']), 1),
        P('f_payment_terms', first(iv, ['payment_terms', 'payment_method']))], tables: [{ id: 'invoice_items', cols: IT, rows: fillInvoiceItems(itemRows(use.invoice.items), first(iv, ['country_of_origin'])) }] }
    ];
    if (pk) {
      sections.push({ id: 'packing', titleKey: 'rsec_packing', pairs: [P('f_packing_no', first(pk, ['packing_list_number']), 1), P('f_packing_date', first(pk, ['packing_list_date']), 1),
        P('rf_pk_total', first(pk, ['packages_count']), 1), P('f_package_type', first(pk, ['package_type'])), P('rf_gross', first(pk, ['gross_weight']), 1),
        P('f_net', first(pk, ['net_weight']), 1)], tables: [{ id: 'rd_packing_items', cols: PT, rows: itemRows(use.packing.items, 'packing') }] });
    }
    if (de) {
      sections.push({ id: 'declaration', titleKey: 'rsec_declaration', pairs: [P('f_decl_no', first(de, ['declaration_number']), 1), P('f_decl_type', first(de, ['declaration_type'])),
        P('f_decl_date', first(de, ['declaration_date']), 1), P('f_decl_hijri', first(de, ['declaration_date_hijri']), 1)], tables: [] });
    }
    var cols = DOCS.filter(function (k) { return !!use[k] && list(R.documents).indexOf(k) !== -1; });
    if (cols.indexOf('bl') === -1 || cols.indexOf('invoice') === -1) cols = DOCS.filter(function (k) { return !!use[k]; });
    // common values: the report's own rows (same statuses: match → متطابق, mismatch → يوجد اختلاف, partial / missing →
    // مراجعة سريعة, info on one document → متوفر في مستند واحد)
    var common = list(R.rows).filter(function (r) { return r && r.key; }).map(function (r) {
      var o = { key: r.key, label: str(lang === 'en' ? r.label_en || r.label_ar : r.label_ar || r.label_en), engine: r.status };
      var n = 0;
      DOCS.forEach(function (c) { var x = r.values ? r.values[c] : null; o[c] = cols.indexOf(c) !== -1 && !blank(x) ? str(x) : ''; if (o[c]) n++; });
      // info (for the record: a value on one document only) → «متوفر في مستند واحد»; missing (an expected document lacks
      // the value — the report flags it «ناقص») → «مراجعة سريعة», never the neutral «متوفر في مستند واحد»
      o.status = r.status === 'info' && n <= 1 ? (n ? 'single' : 'missing') : r.status === 'missing' ? (n ? 'review' : 'missing')
        : ENGINE_CS[r.status] || (n === 0 ? 'missing' : n === 1 ? 'single' : 'review');
      return o;
    });
    // conflicts and missing fields: the report's exceptions (or, without them, its mismatch / partial / critical missing rows)
    var ex = Array.isArray(src.exceptions) ? src.exceptions : list(R.rows).filter(function (r) {
      return r && (r.status === 'mismatch' || r.status === 'partial' || (r.status === 'missing' && r.critical));
    }).map(function (r) { return { st: r.status, label: lang === 'en' ? r.label_en : r.label_ar, values: r.values, note: lang === 'en' ? r.detail_en : r.detail_ar }; });
    var alerts = ex.filter(function (x) { return x && EXC_KIND[x.st]; }).map(function (x) {
      var a = { kind: EXC_KIND[x.st], field: '', label: str(x.label), note: str(x.note) };
      DOCS.forEach(function (c) { var y = x.values ? x.values[c] : null; a[c] = cols.indexOf(c) !== -1 && !blank(y) ? str(y) : ''; });
      return a;
    });
    return {
      ready: true, draft: true, seq: dtx ? str(dtx.ref || '') : '', txId: dtx ? String(dtx.id).toLowerCase() : null, prepared: prepared,
      fileSeq: DRAFT_SEQ, fileBase: fileName(DRAFT_SEQ, src.now || new Date()),
      strip: strip, sections: dropEmptyCols(sections), common: common, alerts: alerts, hasData: true, docCols: cols, footKey: 'rd_foot_note', excluded: excluded,
      counts: { containers: ctr.length, invoice: sections[1].tables[0].rows.length, packing: pk ? sections[2].tables[0].rows.length : 0, declaration: 0 }
    };
  }

  // the model → rows of [section, field, value] (the main sheet / the CSV) with the tables flattened after their section
  function flatRows(m, t) {
    var out = [];
    m.strip.forEach(function (p) { out.push({ section: t('sec_summary'), field: t(p[0]), value: p[1] }); });
    m.sections.forEach(function (s) {
      var title = t(s.titleKey || 'fsec_' + s.id);
      s.pairs.forEach(function (p) { out.push({ section: title, field: t(p[0]), value: p[1] }); });
      (s.groups || []).forEach(function (gr) { gr.pairs.forEach(function (p) { out.push({ section: t(gr.titleKey), field: t(p[0]), value: p[1] }); }); });
      s.tables.forEach(function (tb) {
        tb.rows.forEach(function (r, i) {
          out.push({ section: t('ftab_' + tb.id), field: '#' + (i + 1), value: tb.cols.map(function (c) {
            var v = r[c.key]; return blank(v) ? null : t('fc_' + c.key) + ': ' + str(v);
          }).filter(Boolean).join(' | ') });
        });
      });
    });
    m.common.forEach(function (r) {
      out.push({ section: t('sec_common'), field: r.label || t('cm_' + r.key), value: docCols(m).map(function (c) {
        return blank(r[c]) ? null : t('col_' + c) + ': ' + r[c];
      }).filter(Boolean).join(' | ') + ' → ' + t('cs_' + r.status) });
    });
    m.alerts.forEach(function (a) {
      out.push({ section: t('sec_alerts'), field: t('ak_' + a.kind) + ': ' + (a.label || t(a.field)), value: (m.draft ? docCols(m).map(function (c) { return blank(a[c]) ? null : t('col_' + c) + ': ' + a[c]; })
        : [a.bl, a.invoice, a.packing]).concat([a.note]).filter(function (x) { return !blank(x); }).join(' | ') });
    });
    return out;
  }
  var XTYPE = { code: 'text', text: 'text', number: 'number', int: 'int' };
  // the model → a MarsaXlsx.build spec: the main sheet + one sheet per table + common values + alerts
  function xlsxSpec(m, t, lang) {
    function typed(tb) {
      return { name: t('ftab_' + tb.id), rtl: lang !== 'en', columns: tb.cols.map(function (c) { return { key: c.key, label: t('fc_' + c.key), type: XTYPE[c.type] || 'text', width: c.key.indexOf('description') !== -1 ? 40 : 16 }; }),
        rows: tb.rows.map(function (r) {
          var o = {};
          tb.cols.forEach(function (c) { var v = r[c.key]; o[c.key] = (c.type === 'number' || c.type === 'int') ? (toNum(v) == null ? (blank(v) ? null : str(v)) : toNum(v)) : (blank(v) ? '' : str(v)); });
          return o;
        }), totals: null };
    }
    var main = flatRows({ strip: m.strip, sections: m.sections.map(function (s) { return { id: s.id, titleKey: s.titleKey, pairs: s.pairs, groups: s.groups, tables: [] }; }), common: [], alerts: [] }, t);
    var DC = docCols(m), AC = m.draft ? DC : ['bl', 'invoice', 'packing'];
    var sheets = [{ name: t('sheet_main'), rtl: lang !== 'en', columns: [{ key: 'section', label: t('col_section'), type: 'text', width: 26 },
      { key: 'field', label: t('col_field'), type: 'text', width: 28 }, { key: 'value', label: t('col_value'), type: 'text', width: 50 }], rows: main, totals: null }];
    m.sections.forEach(function (s) { s.tables.forEach(function (tb) { sheets.push(typed(tb)); }); });
    sheets.push({ name: t('sec_common'), rtl: lang !== 'en', columns: [{ key: 'field', label: t('col_field'), type: 'text', width: 24 }]
      .concat(DC.map(function (c) { return { key: c, label: t('col_' + c), type: 'text', width: 26 }; }))
      .concat([{ key: 'result', label: t('col_result'), type: 'text', width: 18 }]),
      rows: m.common.map(function (r) {
        var o = { field: r.label || t('cm_' + r.key), result: t('cs_' + r.status) };
        DC.forEach(function (c) { o[c] = c === 'invoice' ? r.invoice + (r.lines ? ' / ' + r.lines : '') : r[c]; });
        return o;
      }), totals: null });
    sheets.push({ name: t('sec_alerts'), rtl: lang !== 'en', columns: [{ key: 'kind', label: t('col_kind'), type: 'text', width: 16 },
      { key: 'field', label: t('col_field'), type: 'text', width: 26 }]
      .concat(AC.map(function (c) { return { key: c, label: t('col_' + c), type: 'text', width: 22 }; }))
      .concat([{ key: 'note', label: t('col_note'), type: 'text', width: 30 }]),
      rows: m.alerts.map(function (a) {
        var o = { kind: t('ak_' + a.kind), field: a.label || t(a.field), note: a.note };
        AC.forEach(function (c) { o[c] = a[c]; });
        return o;
      }), totals: null });
    return { title: t('sheet_title'), generatedAt: new Date(), sheets: sheets,
      meta: [[t('s_tx'), m.draft ? m.strip[0][1] : m.seq], [t('s_prepared'), m.prepared.text], [t('meta_note'), t(m.footKey || 'foot_note')]], metaName: t('sheet_meta') };
  }
  function rowCount(m) {
    var n = m.strip.length + m.common.length + m.alerts.length;
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
    function v(text, ltr) { var b = el('bdi', ltr ? 'num' : null, blank(text) ? NONE : String(text)); b.dir = ltr ? 'ltr' : 'auto'; return b; }
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
    render(sheet, m, t, el, v);
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
    var h = el('h2', 'fsh-title', t('sheet_title')); h.id = 'fsh-title';
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
    VERSION: 'fasah-sheet-2', open: open, close: close, renderDraft: renderDraft, printSheet: printSheet, exportSheet: exportSheet,
    pure: { buildReadingsModel: buildReadingsModel, readingExcluded: readingExcluded, containerRows: containerRows, docCols: docCols, numEquivalent: numEquivalent, currencyName: currencyName, fileName: fileName, riyadhStamp: riyadhStamp, buildModel: buildModel,
      commonRow: commonRow, flatRows: flatRows, xlsxSpec: xlsxSpec, rowCount: rowCount, searchKey: searchKey, toNum: toNum, CURRENCIES: CURRENCIES }
  };
})(typeof window !== 'undefined' ? window : this);
