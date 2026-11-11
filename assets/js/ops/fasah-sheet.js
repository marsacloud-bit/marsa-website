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

  // the model → rows of [section, field, value] (the main sheet / the CSV) with the tables flattened after their section
  function flatRows(m, t) {
    var out = [];
    m.strip.forEach(function (p) { out.push({ section: t('sec_summary'), field: t(p[0]), value: p[1] }); });
    m.sections.forEach(function (s) {
      var title = t('fsec_' + s.id);
      s.pairs.forEach(function (p) { out.push({ section: title, field: t(p[0]), value: p[1] }); });
      s.tables.forEach(function (tb) {
        tb.rows.forEach(function (r, i) {
          out.push({ section: t('ftab_' + tb.id), field: '#' + (i + 1), value: tb.cols.map(function (c) {
            var v = r[c.key]; return blank(v) ? null : t('fc_' + c.key) + ': ' + str(v);
          }).filter(Boolean).join(' | ') });
        });
      });
    });
    m.common.forEach(function (r) {
      out.push({ section: t('sec_common'), field: t('cm_' + r.key), value: ['bl', 'invoice', 'packing', 'declaration'].map(function (c) {
        return blank(r[c]) ? null : t('col_' + c) + ': ' + r[c];
      }).filter(Boolean).join(' | ') + ' → ' + t('cs_' + r.status) });
    });
    m.alerts.forEach(function (a) {
      out.push({ section: t('sec_alerts'), field: t('ak_' + a.kind) + ': ' + t(a.field), value: [a.bl, a.invoice, a.packing, a.note].filter(function (x) { return !blank(x); }).join(' | ') });
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
    var main = flatRows({ strip: m.strip, sections: m.sections.map(function (s) { return { id: s.id, pairs: s.pairs, tables: [] }; }), common: [], alerts: [] }, t);
    var sheets = [{ name: t('sheet_main'), rtl: lang !== 'en', columns: [{ key: 'section', label: t('col_section'), type: 'text', width: 26 },
      { key: 'field', label: t('col_field'), type: 'text', width: 28 }, { key: 'value', label: t('col_value'), type: 'text', width: 50 }], rows: main, totals: null }];
    m.sections.forEach(function (s) { s.tables.forEach(function (tb) { sheets.push(typed(tb)); }); });
    sheets.push({ name: t('sec_common'), rtl: lang !== 'en', columns: [{ key: 'field', label: t('col_field'), type: 'text', width: 24 },
      { key: 'bl', label: t('col_bl'), type: 'text', width: 26 }, { key: 'invoice', label: t('col_invoice'), type: 'text', width: 26 },
      { key: 'packing', label: t('col_packing'), type: 'text', width: 26 }, { key: 'declaration', label: t('col_declaration'), type: 'text', width: 26 },
      { key: 'result', label: t('col_result'), type: 'text', width: 18 }],
      rows: m.common.map(function (r) { return { field: t('cm_' + r.key), bl: r.bl, invoice: r.invoice + (r.lines ? ' / ' + r.lines : ''), packing: r.packing, declaration: r.declaration, result: t('cs_' + r.status) }; }), totals: null });
    sheets.push({ name: t('sec_alerts'), rtl: lang !== 'en', columns: [{ key: 'kind', label: t('col_kind'), type: 'text', width: 16 },
      { key: 'field', label: t('col_field'), type: 'text', width: 26 }, { key: 'bl', label: t('col_bl'), type: 'text', width: 22 },
      { key: 'invoice', label: t('col_invoice'), type: 'text', width: 22 }, { key: 'packing', label: t('col_packing'), type: 'text', width: 22 },
      { key: 'note', label: t('col_note'), type: 'text', width: 30 }],
      rows: m.alerts.map(function (a) { return { kind: t('ak_' + a.kind), field: t(a.field), bl: a.bl, invoice: a.invoice, packing: a.packing, note: a.note }; }), totals: null });
    return { title: t('sheet_title'), generatedAt: new Date(), sheets: sheets,
      meta: [[t('s_tx'), m.seq], [t('s_prepared'), m.prepared.text], [t('meta_note'), t('foot_note')]], metaName: t('sheet_meta') };
  }
  function rowCount(m) {
    var n = m.strip.length + m.common.length + m.alerts.length;
    m.sections.forEach(function (s) { n += s.pairs.length; s.tables.forEach(function (tb) { n += tb.rows.length; }); });
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
    function exp(format) {
      if (!model) return;
      var A = api && (api.MarsaApi || api);
      var n = rowCount(model);
      status.textContent = t('exporting');
      call(api, 'logReportExport', { report: 'fasah_sheet', format: format, filters: { transaction_id: model.txId }, row_count: n, orgId: api && api.orgId || undefined })
        .then(function (r) {
          if (r.error) { status.textContent = t('export_failed') + ' ' + (api && api.errText ? api.errText(r.error) : (A && A.errorMessage ? A.errorMessage(r.error) : r.error.message || '')); return; }
          var X = root.MarsaExport, XL = root.MarsaXlsx;
          try {
            if (format === 'print') { status.textContent = ''; if (typeof root.print === 'function') root.print(); return; }
            if (!X || typeof X.download !== 'function') throw new Error('download');
            if (format === 'xlsx') {
              if (!XL || typeof XL.blob !== 'function') throw new Error('xlsx');
              X.download(XL.blob(xlsxSpec(model, t, lang)), fileName(model.seq || model.txId, new Date(), 'xlsx'));
            } else {
              var rows = flatRows(model, t);
              var csv = X.toCsv([{ key: 'section', label: t('col_section'), type: 'text' }, { key: 'field', label: t('col_field'), type: 'text' },
                { key: 'value', label: t('col_value'), type: 'text' }], rows, null);
              X.download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), fileName(model.seq || model.txId, new Date(), 'csv'));
            }
            status.textContent = t('exported', { n: n });
          } catch (e) { status.textContent = t('export_failed'); }
        });
    }
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
      head.appendChild(el('span', null, (i + 1) + ' — ' + t('fsec_' + s.id)));
      head.appendChild(el('small', null, t('fsub_' + s.id)));
      sec.appendChild(head);
      if (s.pairs.length) {
        var g = el('dl', 'fsh-grid');
        s.pairs.forEach(function (p) { var d = el('div', 'fsh-cell' + (p[0] === 'f_goods' ? ' is-full' : '')); d.appendChild(el('dt', null, t(p[0]))); var dd = el('dd'); dd.appendChild(v(p[1], p[2])); d.appendChild(dd); g.appendChild(d); });
        sec.appendChild(g);
      }
      s.tables.forEach(function (tb) {
        sec.appendChild(el('h3', 'fsh-sub', t('ftab_' + tb.id) + ' (' + tb.rows.length + ')'));
        sec.appendChild(table(tb.cols.map(function (c) { return { key: c.key, label: t('fc_' + c.key), ltr: c.type !== 'text' }; }), tb.rows, t('rows_empty')));
      });
      sheet.appendChild(sec);
    });
    var cs = el('section', 'fsh-sec fsh-common');
    var ch = el('div', 'fsh-sec-title'); ch.appendChild(el('span', null, t('sec_common'))); ch.appendChild(el('small', null, t('common_sub'))); cs.appendChild(ch);
    cs.appendChild(table([{ key: 'k', label: t('col_field'), render: function (td, r) { td.textContent = t('cm_' + r.key); } },
      { key: 'bl', label: t('col_bl') }, { key: 'invoice', label: t('col_invoice'), render: function (td, r) { td.appendChild(v(r.invoice + (r.lines ? ' / ' + t('lines_sum') + ' ' + r.lines : ''))); } },
      { key: 'packing', label: t('col_packing') }, { key: 'declaration', label: t('col_declaration') },
      { key: 's', label: t('col_result'), render: function (td, r) { td.appendChild(el('span', 'fsh-result is-' + r.status, t('cs_' + r.status))); } }], m.common, t('rows_empty')));
    sheet.appendChild(cs);
    var as = el('section', 'fsh-sec fsh-alerts');
    var ah = el('div', 'fsh-sec-title'); ah.appendChild(el('span', null, t('sec_alerts'))); ah.appendChild(el('small', null, t('alerts_sub'))); as.appendChild(ah);
    as.appendChild(table([{ key: 'kind', label: t('col_kind'), render: function (td, a) { td.appendChild(el('span', 'fsh-result is-' + (a.kind === 'missing' ? 'missing' : 'diff'), t('ak_' + a.kind))); } },
      { key: 'field', label: t('col_field'), render: function (td, a) { td.textContent = t(a.field); } },
      { key: 'bl', label: t('col_bl'), ltr: true }, { key: 'invoice', label: t('col_invoice'), ltr: true }, { key: 'packing', label: t('col_packing'), ltr: true },
      { key: 'note', label: t('col_note') }], m.alerts, t('alerts_none')));
    sheet.appendChild(as);
    sheet.appendChild(el('p', 'fsh-foot text-sm text-muted', t('foot_note')));
  }

  root.MarsaFasahSheet = {
    VERSION: 'fasah-sheet-1', open: open, close: close,
    pure: { numEquivalent: numEquivalent, currencyName: currencyName, fileName: fileName, riyadhStamp: riyadhStamp, buildModel: buildModel,
      commonRow: commonRow, flatRows: flatRows, xlsxSpec: xlsxSpec, rowCount: rowCount, searchKey: searchKey, toNum: toNum, CURRENCIES: CURRENCIES }
  };
})(typeof window !== 'undefined' ? window : this);
