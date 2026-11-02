/* ==========================================================================
   مرسى | MARSA — G4 operating costs: #payables (المستحقات والمدفوعات)
   --------------------------------------------------------------------------
   Contract: docs/online/G4_SPEC.md ("supplier_payments", "Front end" → #payables).
   Uses MarsaOps.ui + MarsaOps.finUi (assets/js/fin/invoices.js).

   «المدفوع ≠ المستحق ≠ الإيراد»: three separate tiles that are never added up —
   due (approved, unpaid), paid by the company, paid directly by the client (the
   last one is evidence that the client paid the supplier, not company cash-out).
   A payment is evidence only (reference or file); it never creates a charge,
   a collection, an accrual or an allocation. Voiding needs finApprove + reason.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var PAGE = 50;
  var PF = { tab: 'due', supplier_id: '', branch_id: '', payer: '', status: 'recorded', from: '', to: '', offset: 0 };

  function noKit(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
    var d = document.createElement('div');
    d.className = 'alert alert-danger';
    d.setAttribute('role', 'alert');
    d.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing';
    root.appendChild(d);
  }

  function render(root, api) {
    var F = Ops.finKit && Ops.finKit();
    if (!F) return noKit(root);
    var U = F.U, el = U.el, t = F.t, sc = U.scope(root);
    var suppliers = [];
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'fin-payables');
    root.appendChild(U.head(t('pay_title'), t('pay_sub')));
    var tiles = el('div', { class: 'adm-tiles ops-kpis fin-kpis fin-pay-tiles', 'aria-live': 'polite' });
    var note = el('p', { class: 'form-hint fin-card-note', text: t('pay_tiles_note') });
    var tabBox = el('div'), bar = el('div'), body = el('div');
    root.appendChild(tiles); root.appendChild(note); root.appendChild(tabBox); root.appendChild(bar); root.appendChild(body);

    // list filters: the payer / status / date controls exist only on the payments tab, so they apply only there
    function payFilters(withPage) {
      var f = {};
      ['supplier_id', 'branch_id'].concat(PF.tab === 'payments' ? ['payer', 'from', 'to'] : []).forEach(function (k) { if (PF[k]) f[k] = PF[k]; });
      if (PF.tab === 'payments' && PF.status) f.status = PF.status;
      if (withPage) { f.limit = PAGE; f.offset = PF.offset; }
      return f;
    }
    // the three headline tiles never follow the payer / status filters (company cash-out stays company cash-out)
    function tileFilters() {
      var f = { limit: 1 };
      if (PF.supplier_id) f.supplier_id = PF.supplier_id;
      if (PF.branch_id) f.branch_id = PF.branch_id;
      return f;
    }
    function load() {
      U.loadingInto(body);
      drawTabs(); drawBar();
      var calls = [PF.tab === 'payments' ? U.call(api, 'listSupplierPayments', payFilters(true)) : null,
        PF.tab === 'due' ? U.call(api, 'listSupplierInvoices', dueFilters()) : null,
        suppliers.length ? null : F.parties(api),
        U.call(api, 'listSupplierPayments', tileFilters())];
      return Promise.all(calls).then(function (res) {
        if (!sc.alive()) return;
        if (res[2]) { suppliers = res[2].rows; drawBar(); }
        U.doneLoading(body);
        var pr = res[0], tr = res[3];
        drawTiles(tr.error ? null : F.dataOf(tr).totals_by_currency, tr.error);
        if (PF.tab === 'due') {
          if (res[1].error) { body.appendChild(U.errorState(api, res[1].error, load)); return; }
          drawDue(U.rowsOf(res[1].data), F.dataOf(res[1]));
        } else {
          if (pr.error) { body.appendChild(U.errorState(api, pr.error, load)); return; }
          drawPayments(U.rowsOf(pr.data), F.dataOf(pr));
        }
      });
    }
    function dueFilters() {
      var f = { status: 'approved', limit: 200, offset: 0 };
      if (PF.supplier_id) f.supplier_id = PF.supplier_id;
      if (PF.branch_id) f.branch_id = PF.branch_id;
      return f;
    }
    // one tile per figure; the value is the SAR (or first) currency, the foot lists the others
    function drawTiles(tbc, err) {
      U.clear(tiles);
      var rows = F.byCurrency(tbc);
      [['due_approved_unpaid', 'warning'], ['paid_by_company', 'neutral'], ['paid_by_client_direct', 'neutral']].forEach(function (k) {
        var main = rows.filter(function (r) { return r.currency === 'SAR'; })[0] || rows[0];
        var others = rows.filter(function (r) { return r !== main && F.nz(r[k[0]]) !== 0; }).map(function (r) { return F.moneyTxt(r[k[0]], r.currency, api); });
        var v = err ? U.NONE : main ? F.moneyTxt(main[k[0]] || 0, main.currency, api) : F.moneyTxt(0, 'SAR', api);
        var tile = U.kpi(t('tile_' + k[0]), v, main && F.nz(main[k[0]]) ? k[1] : 'neutral', { foot: others.length ? others.join(' · ') : t('tile_' + k[0] + '_foot') });
        tile.classList.add('fin-tile-' + k[0]);
        tiles.appendChild(tile);
      });
    }
    function drawTabs() {
      U.clear(tabBox);
      tabBox.appendChild(F.tabs([['due', t('tab_due')], ['payments', t('tab_payments')]], PF.tab, function (v) { PF.tab = v; PF.offset = 0; load(); }, t('pay_title')));
    }
    function drawBar(total) {
      U.clear(bar);
      var fl = [U.select('supplier_id', t('f_supplier'), [['', t('f_supplier') + ': ' + t('all')]].concat(suppliers.map(function (p) { return [p.id, U.partyName(p)]; })), PF.supplier_id, function (v) { PF.supplier_id = v; PF.offset = 0; load(); })];
      var bo = F.branchOptions(api, 'finRead', true);
      if (bo.length > 2) fl.push(U.select('branch_id', t('f_branch'), bo, PF.branch_id, function (v) { PF.branch_id = v; PF.offset = 0; load(); }));
      if (PF.tab === 'payments') {
        fl.push(U.select('payer', t('f_payer'), [['', t('f_payer') + ': ' + t('all')], ['company', F.lab('fin_payer', 'company')], ['client', F.lab('fin_payer', 'client')]], PF.payer, function (v) { PF.payer = v; PF.offset = 0; load(); }));
        fl.push(U.select('status', t('f_status'), [['recorded', F.lab('pay_row', 'recorded')], ['void', F.lab('pay_row', 'void')], ['', t('f_status') + ': ' + t('all')]], PF.status, function (v) { PF.status = v; PF.offset = 0; load(); }));
        fl.push(F.dateInput('from', t('from'), PF.from, function (v) { PF.from = v; PF.offset = 0; load(); }));
        fl.push(F.dateInput('to', t('to'), PF.to, function (v) { PF.to = v; PF.offset = 0; load(); }));
      }
      var acts = [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })];
      bar.appendChild(U.toolbar(null, fl, acts, total != null ? t('count_n', { n: total }) : null));
    }
    // what is owed = payable (total − approved credit notes, server) − paid
    function remainingOf(x) { return F.r2(F.nz(x.payable_amount != null ? x.payable_amount : x.total_amount) - F.nz(x.company_paid_amount) - F.nz(x.client_paid_amount)); }
    function drawDue(rows, d) {
      // approved invoices that still owe something, by due date (no due date last)
      var list = rows.filter(function (x) { return x.status === 'approved' && x.doc_type !== 'credit_note' && x.payment_status !== 'paid' && x.payment_status !== 'paid_directly_by_client' && remainingOf(x) > 0; })
        .sort(function (a, b) { return String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')); });
      drawBar(list.length);
      U.clear(body);
      if (d.total != null && +d.total > rows.length) body.appendChild(U.alertBox('info', t('due_partial', { n: rows.length, total: d.total })));
      if (!list.length) { body.appendChild(U.card(null, U.emptyState('check', t('due_empty_title'), t('due_empty_text')))); return; }
      body.appendChild(U.card(t('tab_due') + ' (' + list.length + ')', U.table([t('col_invoice'), t('f_supplier'), t('f_due_date'), { label: t('f_total'), num: true }, { label: t('paid_company'), num: true }, { label: t('paid_client'), num: true }, { label: t('pay_remaining_lbl'), num: true }, t('f_payment_status'), { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(function (x) {
          var cur = x.currency || 'SAR';
          var acts = el('div', { class: 'ops-row-actions' });
          if (F.canAt(api, 'finWrite', x.branch_id)) acts.appendChild(U.btn(t('pay_record'), 'btn-secondary', function () {
            F.paymentDialog(api, x).then(function (res) { if (res && sc.alive()) { U.toast(api, t('pay_recorded'), 'success'); load(); } });
          }));
          return el('tr', { 'data-id': x.id }, [
            U.td([F.invLink(x.id, x.invoice_number), el('span', { class: 'cell-sub', text: U.fmtDate(x.invoice_date) })]),
            U.td([el('span', { class: 'cell-main', text: F.supplierName(x) }), el('span', { class: 'cell-sub', text: F.branchName(api, x.branch_id) })]),
            U.td(x.due_date ? U.dueNode(x.due_date, false) : el('span', { class: 'ops-muted', text: t('no_due_date') })),
            U.td(F.money(x.total_amount, cur, api), 'num'), U.td(F.money(x.company_paid_amount || 0, cur, api), 'num'), U.td(F.money(x.client_paid_amount || 0, cur, api), 'num'),
            U.td(F.money(remainingOf(x), cur, api), 'num fin-strong'), U.td(F.pill('fin_payment_status', x.payment_status || 'unpaid', api)), U.td(acts, 'ops-col-actions')
          ]);
        }), { caption: t('tab_due') }), null, { flush: true, sub: t('due_sub') }));
    }
    function drawPayments(rows, d) {
      var total = d.total != null ? +d.total : rows.length;
      drawBar(total);
      U.clear(body);
      if (!rows.length) { body.appendChild(U.card(null, U.emptyState('inbox', t('payments_empty_title'), t('payments_empty_text')))); return; }
      body.appendChild(U.card(null, U.table([t('f_paid_at'), t('col_invoice'), t('f_supplier'), { label: t('f_amount'), num: true }, t('f_payer'), t('f_reference'), t('f_status'), { label: t('actions'), cls: 'ops-col-actions' }],
        rows.map(function (p) {
          var path = U.pick(p, ['evidence_path', 'evidence_document.storage_path']);
          var acts = el('div', { class: 'ops-row-actions' });
          if (path) acts.appendChild(F.fileLink(api, path, 'finance', t('evidence')));
          if (p.status === 'recorded' && F.canAt(api, 'finApprove', p.branch_id)) acts.appendChild(U.btn(t('void'), 'btn-subtle', function () {
            F.noteDialog(api, { title: t('pay_void'), noteLabel: t('reason'), danger: true, warn: t('pay_void_warn'), submitText: t('void'), submit: function (note) { return U.call(api, 'voidSupplierPayment', p.id, note); } })
              .then(function (res) { if (res && sc.alive()) { U.toast(api, t('pay_voided'), 'success'); load(); } });
          }));
          return el('tr', { 'data-id': p.id, class: p.status === 'void' ? 'is-muted' : null }, [
            U.td(U.fmtDate(p.paid_at), 'is-nowrap'),
            U.td(F.invLink(p.supplier_invoice_id, p.invoice_number)),
            U.td(el('span', { class: 'cell-main', text: F.supplierName(p) })),
            U.td(F.money(p.amount, p.currency, api), 'num'),
            U.td([el('span', { class: p.payer === 'client' ? 'badge badge-teal' : null, text: F.lab('fin_payer', p.payer) }), el('span', { class: 'cell-sub', text: F.lab('fin_payment_method', p.method) + (p.client_name ? ' · ' + p.client_name : '') })]),
            U.td(p.reference ? U.ltr(p.reference) : null),
            U.td([F.pill('pay_row', p.status, api), p.void_reason ? el('span', { class: 'cell-sub', text: p.void_reason }) : null]),
            U.td(acts, 'ops-col-actions')
          ]);
        }), { caption: t('tab_payments') }), null, { flush: true }));
      var pg = F.pager(total, PAGE, PF.offset, function (o) { PF.offset = o; load(); });
      if (pg) body.appendChild(pg);
    }
    return load();
  }

  Ops.views.payables = {
    allow: 'finRead', titleKey: 'fin.nav_payables', icon: 'wallet',
    render: function (root, api) { return render(root, api); }
  };
})();
