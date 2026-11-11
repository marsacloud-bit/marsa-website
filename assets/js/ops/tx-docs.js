/* ==========================================================================
   مرسى | MARSA — legacy step 3 UI on the transaction page (#tx/<id>)  →  MarsaOps.txDocs
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_DOCS_AR.md. Loaded after tx-legacy.js, before admin.js.
   Section 'shipment_docs' (order 35, after the bills of lading):
     * the link «قراءة مستندات الشحنة» → ocr.html#tx=<id> (ops writers of the branch;
       the batch page opens the transaction's draft or offers a new batch for it);
     * the approved shipment data (get_transaction_shipment): the «بيانات فسح» header
       (shipment / invoice / packing), the containers snapshot, the live invoice items
       and packing items, and the document batches of the transaction (status + link).
   * Strings: namespace 'docb' (assets/i18n/docb.js, ar + en).
   * Read-only here: values change only through a new batch approval (approve_doc_batch).
   * Server data only via textContent / createElement (api.el). ES5, no library.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  if (!Array.isArray(OPS.txSections)) OPS.txSections = [];

  function T(k, vars) {
    var key = 'docb.' + k;
    if (!I || typeof I.t !== 'function') return k;
    var s = I.t(key, vars);
    return s === key ? k : s;
  }
  // the «بيانات فسح» record → [[label key, value, ltr?]] (empty values left out)
  var SHIP_ROWS = [
    ['f_bl_number', 'bl_number', 1], ['f_shipper', 'shipper'], ['f_consignee', 'consignee'], ['f_consignee_name', 'consignee_name'],
    ['f_notify_party', 'notify_party'], ['f_booking_number', 'booking_number', 1], ['f_shipping_line', 'shipping_line'],
    ['f_vessel', 'vessel'], ['f_voyage', 'voyage', 1], ['f_port_of_loading', 'port_of_loading'], ['f_port_of_discharge', 'port_of_discharge'],
    ['f_place_of_receipt', 'place_of_receipt'], ['f_place_of_delivery', 'place_of_delivery'], ['f_freight_terms', 'freight_terms'],
    ['f_goods_description', 'goods_description'], ['f_packages_count', 'packages_count', 1], ['f_package_type', 'package_type'],
    ['f_net_weight', 'net_weight_kg', 1], ['f_gross_weight', 'gross_weight_kg', 1], ['f_measurement_cbm', 'measurement_cbm', 1],
    ['f_temperature_c', 'temperature_c', 1]
  ];
  var INV_ROWS = [
    ['f_invoice_number', 'invoice_number', 1], ['f_invoice_date', 'invoice_date', 1], ['f_invoice_seller', 'seller'], ['f_invoice_buyer', 'buyer'],
    ['f_currency', 'currency', 1], ['f_invoice_total', 'total_value', 1], ['f_incoterms', 'incoterms'], ['f_payment_terms', 'payment_terms'],
    ['f_country_of_origin', 'country_of_origin'], ['f_export_country', 'export_country']
  ];
  var PACK_ROWS = [
    ['f_packing_list_number', 'packing_list_number', 1], ['f_packing_list_date', 'packing_list_date', 1],
    ['f_packing_total_packages', 'packing_total_packages', 1], ['f_package_type', 'packing_package_type'],
    ['f_packing_total_net_weight', 'packing_net_weight_kg', 1], ['f_packing_total_gross_weight', 'packing_gross_weight_kg', 1]
  ];
  function rowsFrom(d, defs) {
    if (!d || typeof d !== 'object') return [];
    return defs.filter(function (r) { var v = d[r[1]]; return v != null && String(v).trim() !== ''; })
      .map(function (r) { return [r[0], String(d[r[1]]), !!r[2]]; });
  }
  function shipmentRows(d) {
    return { shipment: rowsFrom(d, SHIP_ROWS), invoice: rowsFrom(d, INV_ROWS), packing: rowsFrom(d, PACK_ROWS) };
  }
  function docsLink(txId) { return 'ocr.html#tx=' + encodeURIComponent(String(txId || '')); }
  function batchLink(id) { return 'ocr.html#batch=' + encodeURIComponent(String(id || '')); }
  var TONE = { draft: 'warning', approved: 'success', discarded: 'muted', archived: 'muted' };

  function call(api, name) {
    var A = api && (api.MarsaApi || api), f = A && A[name];
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof f !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', message: name } });
    return Promise.resolve().then(function () { return f.apply(A, args); })
      .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
  }
  function errText(api, e) { return api && typeof api.errText === 'function' ? api.errText(e) : ((e && e.message) || String(e)); }
  // the stored value at its own precision (numeric(18,4) unit prices, numeric(…,3) weights / quantities): the significant
  // decimals are kept (up to 4), never rounded to the 2 of the default number format
  function sigDigits(v) {
    var m = /\.(\d+)$/.exec(String(v).replace(/e.*$/i, ''));
    return m ? Math.min(4, m[1].replace(/0+$/, '').length) : 0;
  }
  function num(api, v) {
    if (v == null || v === '') return T('none');
    var n = +v;
    if (!isFinite(n)) return String(v);
    var dg = sigDigits(v);
    var I = window.MarsaI18n;
    if (I && typeof I.fmtNumber === 'function') { try { return I.fmtNumber(n, { digits: dg }); } catch (e) { /* plain below */ } }
    if (api && typeof api.fmtNumber === 'function' && dg <= 2) return api.fmtNumber(n);
    return n.toFixed(dg);
  }

  function renderShipmentDocs(root, tx, api) {
    var el = api.el;
    var canWrite = !api.cancelled && api.can('opsWriter', tx.branch_id);
    var head = el('header', { class: 'app-card-head adm-card-head' }, [
      el('h3', { class: 'app-card-title', text: T('tx_title') }),
      canWrite ? el('div', { class: 'adm-card-actions' }, el('a', { class: 'btn btn-sm btn-primary', href: docsLink(tx.id), text: T('tx_read_link') })) : null
    ]);
    var body = el('div', { class: 'app-card-body adm-card-body' }, el('p', { class: 'text-sm text-muted', text: T('loading') }));
    root.appendChild(el('section', { class: 'app-card adm-card ops-tx-card docb-tx' }, [head, body]));
    function dl(rows) {
      return el('dl', { class: 'adm-dl docb-tx-dl' }, rows.map(function (r) {
        return el('div', null, [el('dt', { text: T(r[0]) }), el('dd', null, el('bdi', { dir: r[2] ? 'ltr' : 'auto', text: r[1] }))]);
      }));
    }
    function table(headers, trs, empty) {
      var tbody = el('tbody', null, trs.length ? trs : el('tr', null, el('td', { colspan: headers.length, class: 'text-muted', text: empty })));
      return el('div', { class: 'table-wrap adm-table-wrap' }, el('table', { class: 'table table-striped adm-table' }, [
        el('thead', null, el('tr', null, headers.map(function (h) { return el('th', { scope: 'col', text: h }); }))), tbody]));
    }
    function cell(v, ltr) { return el('td', null, v == null || v === '' ? T('none') : el('bdi', { dir: ltr ? 'ltr' : 'auto', text: String(v) })); }
    return call(api, 'getTransactionShipment', tx.id).then(function (r) {
      body.textContent = '';
      if (r.error) { body.appendChild(el('div', { class: 'alert alert-warning', role: 'status' }, el('div', { text: errText(api, r.error) }))); return; }
      var d = r.data || {}, sd = d.shipment_data || null;
      var batches = Array.isArray(d.batches) ? d.batches : [];
      if (!sd) body.appendChild(el('p', { class: 'text-sm text-muted', text: T('tx_none') }));
      else {
        var g = shipmentRows(sd);
        body.appendChild(el('p', { class: 'text-sm text-muted', text: T('tx_approved_at', { d: api.fmtDate ? api.fmtDate(sd.approved_at, true) : String(sd.approved_at || '') }) }));
        [['shipment', 'sec_shipment'], ['invoice', 'sec_invoice'], ['packing', 'sec_packing']].forEach(function (s) {
          if (!g[s[0]].length) return;
          body.appendChild(el('h4', { class: 'docb-tx-h', text: T(s[1]) }));
          body.appendChild(dl(g[s[0]]));
        });
        var ctr = Array.isArray(sd.containers) ? sd.containers : [];
        if (ctr.length) {
          body.appendChild(el('h4', { class: 'docb-tx-h', text: T('containers_title') + ' (' + ctr.length + ')' }));
          body.appendChild(table([T('c_container_number'), T('c_seal_number'), T('c_size_type'), T('c_packages_count'), T('c_net_weight'), T('c_gross_weight')],
            ctr.map(function (c) {
              return el('tr', null, [cell(c.container_number, 1), cell(c.seal_number, 1), cell(c.size_type, 1),
                el('td', { class: 'num', text: num(api, c.packages_count) }), el('td', { class: 'num', text: num(api, c.net_weight) }), el('td', { class: 'num', text: num(api, c.gross_weight) })]);
            }), T('rows_empty')));
        }
        var miss = Array.isArray(sd.missing_fields) ? sd.missing_fields : [], conf = Array.isArray(sd.conflicts) ? sd.conflicts : [];
        if (miss.length || conf.length) {
          body.appendChild(el('p', { class: 'text-sm' }, [
            conf.length ? el('span', { class: 'badge badge-warning', text: T('cmp_conflicts', { n: conf.length }) }) : null, ' ',
            miss.length ? el('span', { class: 'badge badge-muted', text: T('cmp_missing', { n: miss.length }) }) : null
          ]));
        }
      }
      var inv = Array.isArray(d.invoice_items) ? d.invoice_items : [];
      if (inv.length || sd) {
        body.appendChild(el('h4', { class: 'docb-tx-h', text: T('inv_items_title') + ' (' + inv.length + ')' }));
        body.appendChild(table(['#', T('c_invoice_number'), T('c_description'), T('c_scientific_name'), T('c_supplier_hs_code'), T('c_quantity'), T('c_unit'),
          T('c_unit_price'), T('c_total'), T('c_origin_country'), T('c_net_weight'), T('c_gross_weight')],
          inv.map(function (x) {
            return el('tr', null, [el('td', { class: 'num', text: String(x.line_no || '') }), cell(x.invoice_number, 1), cell(x.description), cell(x.scientific_name),
              cell(x.supplier_hs_code, 1), el('td', { class: 'num', text: num(api, x.quantity) }), cell(x.unit), el('td', { class: 'num', text: num(api, x.unit_price) }),
              el('td', { class: 'num', text: num(api, x.total) }), cell(x.origin_country), el('td', { class: 'num', text: num(api, x.net_weight_kg) }),
              el('td', { class: 'num', text: num(api, x.gross_weight_kg) })]);
          }), T('rows_empty')));
        body.appendChild(el('p', { class: 'form-hint', text: T('hs_ref_hint') }));
      }
      var pk = Array.isArray(d.packing_items) ? d.packing_items : [];
      if (pk.length || sd) {
        body.appendChild(el('h4', { class: 'docb-tx-h', text: T('pack_items_title') + ' (' + pk.length + ')' }));
        body.appendChild(table(['#', T('c_packing_list_number'), T('c_description'), T('c_packages'), T('c_quantity'), T('c_unit'), T('c_net_weight'),
          T('c_gross_weight'), T('c_container_number'), T('c_seal_number')],
          pk.map(function (x) {
            return el('tr', null, [el('td', { class: 'num', text: String(x.line_no || '') }), cell(x.packing_list_number, 1), cell(x.description),
              el('td', { class: 'num', text: num(api, x.packages) }), el('td', { class: 'num', text: num(api, x.quantity) }), cell(x.unit),
              el('td', { class: 'num', text: num(api, x.net_weight_kg) }), el('td', { class: 'num', text: num(api, x.gross_weight_kg) }),
              cell(x.container_no, 1), cell(x.seal_no, 1)]);
          }), T('rows_empty')));
      }
      body.appendChild(el('h4', { class: 'docb-tx-h', text: T('tx_batches') + ' (' + batches.length + ')' }));
      if (!batches.length) body.appendChild(el('p', { class: 'text-sm text-muted', text: T('tx_no_batches') }));
      else body.appendChild(el('ul', { class: 'docb-tx-batches' }, batches.map(function (b) {
        return el('li', null, [el('span', { class: 'badge badge-sm badge-' + (TONE[b.status] || 'muted'), text: T('st_' + b.status) }), ' ',
          el('a', { href: batchLink(b.id), text: T('batch_no', { id: String(b.id).slice(0, 8) }) }), ' ',
          el('span', { class: 'adm-sub', text: [b.created_by_name, api.fmtDate ? api.fmtDate(b.approved_at || b.updated_at || b.created_at, true) : ''].filter(Boolean).join(' · ') })]);
      })));
      body.appendChild(el('p', { class: 'form-hint', text: T('tx_hint') }));
    });
  }

  OPS.txDocs = { VERSION: 'docb-tx-1', t: T, pure: { shipmentRows: shipmentRows, docsLink: docsLink, batchLink: batchLink, num: num, sigDigits: sigDigits } };
  var MINE = [{ id: 'shipment_docs', order: 35, render: renderShipmentDocs }];
  var ids = MINE.map(function (s) { return s.id; });
  for (var i = OPS.txSections.length - 1; i >= 0; i--) {
    if (OPS.txSections[i] && ids.indexOf(OPS.txSections[i].id) !== -1) OPS.txSections.splice(i, 1);
  }
  MINE.forEach(function (s) { OPS.txSections.push(s); });
})();
