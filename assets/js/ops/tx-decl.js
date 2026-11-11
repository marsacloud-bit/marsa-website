/* ==========================================================================
   مرسى | MARSA — legacy step 4 UI on the transaction page (#tx/<id>)  →  MarsaOps.txDecl
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_DECL_AR.md. Loaded after tx-docs.js, before admin.js.
   Section 'declaration_reading' (order 21, right after the customs declarations of tx-sections.js):
     * «قراءة بيان جمركي» → ocr.html#decl-tx=<id> (ops writers of the branch, a saved, not cancelled transaction):
       one declaration file, read by Claude, reviewed and approved by staff on ocr.html (assets/js/decl-review.js);
     * «كشف إدخال فسح» → the Fasah entry information sheet (assets/js/ops/fasah-sheet.js: print / Excel / CSV,
       every export logged as report 'fasah_sheet');
     * the approved declaration (get_transaction_declaration): the active declaration with its Fasah stage, its
       items (HS code, Arabic description, quantity, unit, value, origin, weights), the approvals (each links to its
       review) and the declaration readings of the transaction still waiting for a staff approval;
     * the HS reference library search (MarsaHsPicker, a suggestion only — nothing is written).
   * Strings: namespace 'decl' (assets/i18n/decl.js, ar + en). Read-only here: values change only through an approval.
   * Server data only via textContent / createElement (api.el). ES5, no library.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  if (!Array.isArray(OPS.txSections)) OPS.txSections = [];

  function T(k, vars) {
    var key = 'decl.' + k;
    if (!I || typeof I.t !== 'function') return k;
    var s = I.t(key, vars);
    return s === key ? k : s;
  }
  function uploadLink(txId) { return 'ocr.html#decl-tx=' + encodeURIComponent(String(txId || '')); }
  function reviewLink(extId, txId) { return 'ocr.html#decl=' + encodeURIComponent(String(extId || '')) + '&tx=' + encodeURIComponent(String(txId || '')); }
  // the declaration readings of the transaction not approved yet (newest first)
  function pendingReadings(extractions, approvals) {
    var done = {};
    (Array.isArray(approvals) ? approvals : []).forEach(function (a) { if (a && a.extraction_id) done[a.extraction_id] = 1; });
    return (Array.isArray(extractions) ? extractions : []).filter(function (x) {
      return x && x.doc_type === 'customs_declaration' && !x.voided_at && !done[x.id];
    }).sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
  }
  var ITEM_COLS = ['line_no', 'hs_code', 'description_ar', 'invoice_description', 'quantity', 'unit', 'value', 'origin_country', 'net_weight_kg', 'gross_weight_kg'];
  var NUM_COLS = ['line_no', 'quantity', 'value', 'net_weight_kg', 'gross_weight_kg'];
  // the status badge tone of a declaration stage (tx-sections.js TONES.declaration_status)
  var TONE = { draft: 'muted', submitted: 'info', accepted: 'info', under_inspection: 'warning', cco_review_done: 'info',
    awaiting_duty_payment: 'warning', release_ready: 'success', released: 'success', cancelled: 'danger', replaced: 'muted' };

  function call(api, name) {
    var A = api && (api.MarsaApi || api), f = A && A[name];
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof f !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', message: name } });
    return Promise.resolve().then(function () { return f.apply(A, args); })
      .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
  }
  function errText(api, e) { return api && typeof api.errText === 'function' ? api.errText(e) : ((e && e.message) || String(e)); }
  function label(api, domain, code, fb) {
    if (code == null || code === '') return T('none');
    if (api && typeof api.label === 'function') { try { var s = api.label(domain, code); if (s && s !== code) return s; } catch (e) { /* below */ } }
    var k = fb + code, x = T(k);
    return x === k ? String(code) : x;
  }

  function renderDeclReading(root, tx, api) {
    var el = api.el;
    var canWrite = !api.cancelled && !tx.cancelled_at && api.can('opsWriter', tx.branch_id);
    var acts = el('div', { class: 'adm-card-actions' }, [
      canWrite ? el('a', { class: 'btn btn-sm btn-primary', href: uploadLink(tx.id), text: T('tx_read_link') }) : null,
      el('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: T('tx_fasah_btn'), 'data-fasah-sheet': '1',
        onclick: function (e) { if (e && e.preventDefault) e.preventDefault(); if (window.MarsaFasahSheet) window.MarsaFasahSheet.open(tx, api); } })
    ]);
    var head = el('header', { class: 'app-card-head adm-card-head' }, [el('h3', { class: 'app-card-title', text: T('tx_title') }), acts]);
    var body = el('div', { class: 'app-card-body adm-card-body' }, el('p', { class: 'text-sm text-muted', text: T('loading') }));
    root.appendChild(el('section', { class: 'app-card adm-card ops-tx-card decl-tx' }, [head, body]));
    function cell(v, ltr) { return el('td', { class: ltr ? 'num' : null }, v == null || v === '' ? T('none') : el('bdi', { dir: ltr ? 'ltr' : 'auto', text: String(v) })); }
    var A = api.MarsaApi || api;
    var listP = A && typeof A.listExtractions === 'function'
      ? call(api, 'listExtractions', { transactionId: tx.id, limit: 50 }) : Promise.resolve({ data: [], error: null });
    return Promise.all([call(api, 'getTransactionDeclaration', tx.id), listP]).then(function (rs) {
      var r = rs[0];
      body.textContent = '';
      if (r.error) { body.appendChild(el('div', { class: 'alert alert-warning', role: 'status' }, el('div', { text: errText(api, r.error) }))); return; }
      var d = r.data || {}, act = d.active || null, items = Array.isArray(d.items) ? d.items : [], appr = Array.isArray(d.approvals) ? d.approvals : [];
      if (!act) body.appendChild(el('p', { class: 'text-sm text-muted', text: T('tx_no_active') }));
      else {
        body.appendChild(el('p', { class: 'decl-tx-active' }, [
          el('bdi', { dir: 'ltr', class: 'num', text: act.declaration_no || '' }), ' ',
          el('span', { class: 'badge badge-sm badge-' + (TONE[act.status] || 'muted'), text: label(api, 'declaration_status', act.status, 'st_') }), ' ',
          el('span', { class: 'adm-sub', text: [act.declaration_type_code ? label(api, 'declaration_type', act.declaration_type_code, 'type_') : act.declaration_type,
            act.declaration_date, act.declaration_date_hijri ? act.declaration_date_hijri + (api.isEn && api.isEn() ? ' AH' : ' هـ') : null,
            label(api, 'declaration_source', act.source, 'dsrc_')].filter(Boolean).join(' · ') })
        ]));
      }
      body.appendChild(el('h4', { class: 'docb-tx-h', text: T('tx_items') + ' (' + items.length + ')' }));
      body.appendChild(el('div', { class: 'table-wrap adm-table-wrap' }, el('table', { class: 'table table-striped adm-table' }, [
        el('thead', null, el('tr', null, ITEM_COLS.map(function (c) { return el('th', { scope: 'col', text: T('fc_' + c) }); }))),
        el('tbody', null, items.length ? items.map(function (x) {
          return el('tr', null, ITEM_COLS.map(function (c) { return cell(x[c], NUM_COLS.indexOf(c) !== -1 || c === 'hs_code'); }));
        }) : el('tr', null, el('td', { colspan: ITEM_COLS.length, class: 'text-muted', text: T('tx_items_none') })))
      ])));
      if (appr.length) {
        body.appendChild(el('h4', { class: 'docb-tx-h', text: T('tx_approvals') + ' (' + appr.length + ')' }));
        body.appendChild(el('ul', { class: 'docb-tx-batches' }, appr.map(function (a) {
          return el('li', null, [el('span', { class: 'badge badge-sm badge-success', text: T('rb_' + (a.bl_status || 'not_read')) }), ' ',
            el('a', { href: reviewLink(a.extraction_id, tx.id), text: T('tx_approval_link', { d: api.fmtDate ? api.fmtDate(a.approved_at, true) : String(a.approved_at || '') }) }),
            a.daftra_hook ? el('span', { class: 'adm-sub', text: ' · ' + T('daftra_' + a.daftra_hook) }) : null]);
        })));
      }
      var pend = pendingReadings(rs[1] && !rs[1].error ? rs[1].data : [], appr);
      if (pend.length) {
        body.appendChild(el('h4', { class: 'docb-tx-h', text: T('tx_pending') + ' (' + pend.length + ')' }));
        body.appendChild(el('ul', { class: 'docb-tx-batches' }, pend.map(function (x) {
          return el('li', null, [el('span', { class: 'badge badge-sm badge-warning', text: T('tx_pending_badge') }), ' ',
            el('a', { href: reviewLink(x.id, tx.id), text: x.source_name || T('tx_pending_reading') }), ' ',
            el('span', { class: 'adm-sub', text: api.fmtDate ? api.fmtDate(x.created_at, true) : String(x.created_at || '') })]);
        })));
      }
      if (window.MarsaHsPicker) {
        body.appendChild(el('h4', { class: 'docb-tx-h', text: T('hs_title') }));
        body.appendChild(window.MarsaHsPicker.panel({ api: api, orgId: api.orgId, t: T, closable: false }).el);
      }
      body.appendChild(el('p', { class: 'form-hint', text: T('tx_hint') }));
    });
  }

  OPS.txDecl = { VERSION: 'decl-tx-1', t: T, pure: { uploadLink: uploadLink, reviewLink: reviewLink, pendingReadings: pendingReadings, ITEM_COLS: ITEM_COLS, TONE: TONE } };
  var MINE = [{ id: 'declaration_reading', order: 21, render: renderDeclReading }];
  var ids = MINE.map(function (s) { return s.id; });
  for (var i = OPS.txSections.length - 1; i >= 0; i--) {
    if (OPS.txSections[i] && ids.indexOf(OPS.txSections[i].id) !== -1) OPS.txSections.splice(i, 1);
  }
  MINE.forEach(function (s) { OPS.txSections.push(s); });
})();
