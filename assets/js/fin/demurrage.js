/* ==========================================================================
   مرسى | MARSA — G4 operating costs: #demurrage (الأرضيات والغرامات)
   --------------------------------------------------------------------------
   Contract: docs/online/G4_SPEC.md ("demurrage_cases", #demurrage).
   Uses MarsaOps.ui + MarsaOps.finUi (assets/js/fin/invoices.js).

   Storage / demurrage / detention cases with four separate figures, each from
   its own records (gross, incl. VAT):
     ١ charged to client · ٢ collected from client · ٣ paid to operator
     (and, apart, paid by the client directly to the operator) · ٤ remaining.
   «التحصيل من العميل لا يعني سداد المشغل»: no figure is derived from another.
   Create / edit a case (optionally linked to a G3 exception), record a client
   collection on an approved charge of the case, change the status.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var PAGE = 50;
  var KINDS = ['storage', 'demurrage', 'detention'];
  var STATUSES = ['open', 'closed', 'waived', 'void'];
  var OPERATOR_KINDS = ['terminal_operator', 'shipping_agent', 'yard'];
  var NEXT = { open: ['closed', 'waived', 'void'], closed: ['open'], waived: ['open'], void: [] };
  var DF = { status: 'open', kind: '', operator_id: '', offset: 0 };

  function noKit(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
    var d = document.createElement('div');
    d.className = 'alert alert-danger';
    d.setAttribute('role', 'alert');
    d.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing';
    root.appendChild(d);
  }

  function render(root, api, param) {
    var F = Ops.finKit && Ops.finKit();
    if (!F) return noKit(root);
    var U = F.U, el = U.el, t = F.t, sc = U.scope(root);
    var MONEY_RE = F.MONEY_RE, PCT_RE = F.PCT_RE;
    var operators = null;
    var txFilter = param && F.UUID_RE.test(param) ? param : null;
    var writer = F.branchesFor(api, 'finWrite').length > 0 || F.canAt(api, 'finWrite');
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'fin-demurrage');
    root.appendChild(U.head(t('dm_title'), t('dm_sub'), writer ? [U.btn([U.icon('plus'), el('span', { text: t('dm_new') })], 'btn-primary', function () { caseDialog(null); })] : []));
    root.appendChild(el('p', { class: 'form-hint fin-card-note', text: t('dm_rule') }));
    var kpis = el('div', { class: 'adm-tiles ops-kpis fin-kpis', 'aria-live': 'polite' }), bar = el('div'), body = el('div');
    root.appendChild(kpis); root.appendChild(bar); root.appendChild(body);

    function fig(x, k) { var v = U.pick(x, [k, 'figures.' + k]); return v == null ? null : v; }
    function rem(x, k) { var v = U.pick(x, ['remaining.' + k, 'figures.remaining.' + k, 'remaining_' + k]); return v == null ? null : v; }
    function load() {
      U.loadingInto(body);
      var f = { limit: PAGE, offset: DF.offset };
      if (DF.status) f.status = DF.status;
      if (DF.kind) f.kind = DF.kind;
      if (DF.operator_id) f.operator_id = DF.operator_id;
      if (txFilter) f.transaction_id = txFilter;
      return Promise.all([U.call(api, 'listDemurrage', f), operators ? null : F.parties(api, OPERATOR_KINDS)]).then(function (res) {
        if (!sc.alive()) return;
        if (res[1]) operators = res[1].rows;
        drawBar();
        U.doneLoading(body);
        var r = res[0];
        if (r.error) { U.clear(kpis); body.appendChild(U.errorState(api, r.error, load)); return; }
        draw(F.dataOf(r), U.rowsOf(r.data));
      });
    }
    function drawBar(total) {
      U.clear(bar);
      var fl = [
        U.select('status', t('f_status'), [['', t('f_status') + ': ' + t('all')]].concat(STATUSES.map(function (s) { return [s, F.lab('fin_demurrage_status', s)]; })), DF.status, function (v) { DF.status = v; DF.offset = 0; load(); }),
        U.select('kind', t('f_kind'), [['', t('f_kind') + ': ' + t('all')]].concat(KINDS.map(function (k) { return [k, F.lab('fin_demurrage_kind', k)]; })), DF.kind, function (v) { DF.kind = v; DF.offset = 0; load(); }),
        U.select('operator_id', t('f_operator'), [['', t('f_operator') + ': ' + t('all')]].concat((operators || []).map(function (p) { return [p.id, U.partyName(p)]; })), DF.operator_id, function (v) { DF.operator_id = v; DF.offset = 0; load(); })
      ];
      var acts = [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })];
      if (txFilter) acts.unshift(U.btn(t('dm_all_tx'), 'btn-subtle', function () { U.go(api, '#demurrage'); }));
      bar.appendChild(U.toolbar(null, fl, acts, total != null ? t('count_n', { n: total }) : null));
    }
    // per-currency sums of the loaded rows (no FX)
    function drawKpis(rows) {
      U.clear(kpis);
      var by = {};
      rows.forEach(function (x) {
        if (x.status === 'void') return;
        var c = x.currency || 'SAR', s = by[c] = by[c] || { n: 0, charged: 0, collected: 0, to_collect: 0, to_pay: 0 };
        s.n++; s.charged += F.nz(fig(x, 'charged_to_client')); s.collected += F.nz(fig(x, 'collected_from_client'));
        s.to_collect += F.nz(rem(x, 'to_collect')); s.to_pay += F.nz(rem(x, 'to_pay_operator'));
      });
      var cur = by.SAR ? 'SAR' : Object.keys(by)[0];
      var s = cur ? by[cur] : { n: 0, charged: 0, collected: 0, to_collect: 0, to_pay: 0 };
      var foot = Object.keys(by).length > 1 ? t('dm_kpi_other_cur') : t('dm_kpi_loaded');
      kpis.appendChild(U.kpi(t('dm_kpi_cases'), s.n, 'neutral'));
      kpis.appendChild(U.kpi(t('dm_fig_charged'), F.moneyTxt(s.charged, cur || 'SAR', api), 'neutral', { foot: foot }));
      kpis.appendChild(U.kpi(t('dm_fig_collected'), F.moneyTxt(s.collected, cur || 'SAR', api), 'neutral', { foot: foot }));
      kpis.appendChild(U.kpi(t('dm_rem_collect'), F.moneyTxt(s.to_collect, cur || 'SAR', api), s.to_collect > 0 ? 'warning' : 'neutral', { foot: foot }));
      kpis.appendChild(U.kpi(t('dm_rem_pay'), F.moneyTxt(s.to_pay, cur || 'SAR', api), s.to_pay > 0 ? 'warning' : 'neutral', { foot: foot }));
    }
    function draw(d, rows) {
      var total = d.total != null ? +d.total : rows.length;
      drawKpis(rows); drawBar(total);
      U.clear(body);
      if (!rows.length) {
        body.appendChild(U.card(null, U.emptyState('clock', t('dm_empty_title'), t('dm_empty_text'), writer ? [U.btn(t('dm_new'), 'btn-primary', function () { caseDialog(null); })] : null)));
        return;
      }
      body.appendChild(U.card(null, U.table([t('tx'), t('f_kind'), t('dm_col_period'), { label: t('dm_estimated'), num: true }, t('dm_col_figures'), t('f_status'), { label: t('actions'), cls: 'ops-col-actions' }],
        rows.map(rowNode), { caption: t('dm_title') }), null, { flush: true }));
      var pg = F.pager(total, PAGE, DF.offset, function (o) { DF.offset = o; load(); });
      if (pg) body.appendChild(pg);
    }
    function figLabel(no, label) { return el('span', { class: 'fin-four-label' }, [el('span', { class: 'fin-four-no', 'aria-hidden': 'true', text: String(no) }), label]); }
    function figBox(no, label, v, cur, cls, sub) {
      return el('div', { class: 'fin-four-fig' + (cls ? ' ' + cls : '') }, [figLabel(no, label), F.money(v == null ? 0 : v, cur, api), sub ? el('span', { class: 'fin-four-sub', text: sub }) : null]);
    }
    function strip(x) {
      var cur = x.currency || 'SAR';
      var byClient = fig(x, 'paid_by_client_to_operator');
      var lvl = fig(x, 'operator_due_level');
      var due = fig(x, 'operator_due');
      return el('div', { class: 'fin-four' }, [
        figBox(1, t('dm_fig_charged'), fig(x, 'charged_to_client'), cur),
        figBox(2, t('dm_fig_collected'), fig(x, 'collected_from_client'), cur),
        figBox(3, t('dm_fig_paid_op'), fig(x, 'paid_to_operator'), cur, null, F.nz(byClient) ? t('dm_fig_paid_by_client', { amt: F.moneyTxt(byClient, cur, api) }) : null),
        el('div', { class: 'fin-four-fig is-remaining' }, [
          figLabel(4, t('dm_fig_remaining')),
          el('span', { class: 'fin-four-sub' }, [t('dm_rem_collect') + ': ', F.money(rem(x, 'to_collect'), cur, api)]),
          el('span', { class: 'fin-four-sub' }, [t('dm_rem_pay') + ': ', F.money(rem(x, 'to_pay_operator'), cur, api)]),
          due != null ? el('span', { class: 'fin-four-sub' }, [t('dm_operator_due') + ': ', F.money(due, cur, api), ' ', lvl ? F.levelPill(lvl) : null]) : null
        ])
      ]);
    }
    function rowNode(x) {
      var acts = el('div', { class: 'ops-row-actions' });
      // the case's transaction branch (server: branch_id); unknown branch → no write action (never "any branch")
      var bid = x.branch_id || x.transaction_branch_id;
      var w = !!bid && F.canAt(api, 'finWrite', bid), ap = !!bid && F.canAt(api, 'finApprove', bid);
      if (w && x.status === 'open') acts.appendChild(U.btn(t('edit'), 'btn-secondary', function () { caseDialog(x); }));
      if (w && x.status !== 'void') acts.appendChild(U.btn(t('dm_collect'), 'btn-secondary', function () { collectDialog(x); }));
      var nexts = (NEXT[x.status] || []).filter(function (s) { return s === 'waived' || s === 'void' ? ap : w; });
      if (nexts.length) acts.appendChild(U.btn(t('dm_status'), 'btn-subtle', function () { statusDialog(x, nexts); }));
      var ctr = U.pick(x, ['container_no', 'container.container_no']);
      var op = U.pick(x, U.lang() === 'en' ? ['operator_name_en', 'operator_name', 'operator.name_ar'] : ['operator_name', 'operator.name_ar', 'operator_name_en']);
      var period = [x.free_until ? t('dm_free_until', { d: U.fmtDate(x.free_until) }) : null, x.charged_until ? t('dm_charged_until', { d: U.fmtDate(x.charged_until) }) : null].filter(Boolean);
      return el('tr', { 'data-id': x.id, class: x.status === 'void' ? 'is-muted' : null }, [
        U.td([U.txLink(x), ctr ? el('span', { class: 'cell-sub' }, [U.t('container') + ': ', U.ltr(ctr)]) : el('span', { class: 'cell-sub', text: t('dm_lcl') })], 'is-nowrap'),
        U.td([el('span', { class: 'cell-main', text: F.lab('fin_demurrage_kind', x.kind) }), op ? el('span', { class: 'cell-sub', text: op }) : null,
          x.exception_id ? el('span', { class: 'badge badge-blue badge-sm', text: t('dm_has_exception') }) : null]),
        U.td([period.length ? el('span', { text: period.join(' · ') }) : el('span', { class: 'ops-muted', text: U.NONE }), x.days != null ? el('span', { class: 'cell-sub', text: t('dm_days', { n: x.days }) }) : null]),
        U.td([F.money(x.estimated_amount, x.currency, api), x.estimated_amount != null ? el('span', { class: 'cell-sub', text: t('dm_net_vat', { r: x.estimated_vat_rate == null ? 15 : +x.estimated_vat_rate }) }) : null], 'num'),
        U.td(strip(x), 'fin-col-four'),
        U.td([F.pill('fin_demurrage_status', x.status, api), x.status_note ? el('span', { class: 'cell-sub ops-note', text: x.status_note }) : null]),
        U.td(acts, 'ops-col-actions')
      ]);
    }
    function reload(msg) { return function (res) { if (res && sc.alive()) { U.toast(api, msg || t('saved'), 'success'); load(); } }; }

    // --- create / edit ----------------------------------------------------------
    function caseDialog(x) {
      var editing = !!x;
      var tx = editing ? { id: x.transaction_id, ref: U.txRef(x), branch_id: x.branch_id } : null;
      var finder = editing ? null : F.txFinder(api, function (picked) { tx = picked; fillTx(); });
      var intro = el('div', { class: 'fin-dialog-intro' }, editing
        ? [el('p', { class: 'ops-modal-intro' }, [t('tx') + ': ', el('bdi', { dir: 'ltr', text: tx.ref || String(tx.id).slice(0, 8) })])]
        : [F.field(t('tx_find'), finder.node, { required: true, hint: t('tx_find_hint') })]);
      var opOpts = F.partyOptions(operators || [], t('dm_operator_none'));
      var pr = U.formModal({
        title: editing ? t('dm_edit') : t('dm_new'), size: 'lg', intro: intro,
        fields: [
          { name: 'kind', label: t('f_kind'), type: 'select', required: true, value: editing ? x.kind : 'storage', options: KINDS.map(function (k) { return [k, F.lab('fin_demurrage_kind', k)]; }) },
          { name: 'container_id', label: U.t('container'), type: 'select', value: editing ? x.container_id || '' : '', options: [['', t('dm_lcl')]], hint: t('dm_container_hint') },
          { name: 'operator_id', label: t('f_operator'), type: 'select', value: editing ? x.operator_id || '' : '', options: opOpts },
          { name: 'exception_id', label: t('f_exception'), type: 'select', value: editing ? x.exception_id || '' : '', options: [['', U.NONE]], hint: t('dm_exception_hint') },
          { name: 'free_until', label: t('f_free_until'), type: 'date', value: editing ? x.free_until : '' },
          { name: 'charged_until', label: t('f_charged_until'), type: 'date', value: editing ? x.charged_until : '' },
          { name: 'days', label: t('f_days'), ltr: true, inputmode: 'numeric', pattern: /^[0-9٠-٩]{1,4}$/, patternMsg: t('days_invalid'), value: editing && x.days != null ? String(x.days) : '' },
          { name: 'currency', label: t('f_currency'), type: 'select', required: true, value: editing ? x.currency || 'SAR' : 'SAR', options: F.currencyOptions(editing ? [x.currency] : null) },
          { name: 'estimated_amount', label: t('f_estimated_net'), ltr: true, inputmode: 'decimal', pattern: MONEY_RE, patternMsg: t('money_invalid'), value: editing ? F.amountStr(x.estimated_amount) : '', hint: t('dm_estimated_hint') },
          { name: 'estimated_vat_rate', label: t('f_vat_rate'), ltr: true, inputmode: 'decimal', pattern: PCT_RE, patternMsg: t('pct_invalid'), value: editing && x.estimated_vat_rate != null ? String(+x.estimated_vat_rate) : '15' }
        ],
        validate: function (v) {
          var bad = {};
          if (!tx) bad._tx = t('dm_pick_tx');
          if (v.free_until && v.charged_until && v.charged_until < v.free_until) bad.charged_until = t('dm_dates_order');
          if (F.num(v.estimated_vat_rate) > 100) bad.estimated_vat_rate = t('pct_invalid');
          return bad;
        },
        submit: function (v) {
          var est = F.num(v.estimated_amount), rate = F.num(v.estimated_vat_rate), days = F.num(v.days);
          var p = { kind: v.kind, container_id: v.container_id || null, operator_id: v.operator_id || null, exception_id: v.exception_id || null,
            free_until: v.free_until || null, charged_until: v.charged_until || null, days: days == null ? null : Math.round(days),
            estimated_amount: est == null ? null : F.r2(est), estimated_vat_rate: rate == null ? 15 : rate, currency: v.currency };
          if (editing) return U.call(api, 'updateDemurrageCase', x.id, p);
          p.transaction_id = tx.id;
          var scope = 'fin-dm-new', key = U.idemKey(api, scope, p);
          return U.call(api, 'createDemurrageCase', p, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
        }
      });
      var form = intro.closest('form');
      function fillTx() {
        if (!form || !tx) return;
        var cSel = form.elements.container_id, eSel = form.elements.exception_id;
        Promise.all([U.call(api, 'listContainers', tx.id), U.call(api, 'listExceptions', { txId: tx.id, limit: 200 })]).then(function (res) {
          var keepC = editing ? x.container_id : cSel.value, keepE = editing ? x.exception_id : eSel.value;
          while (cSel.options.length > 1) cSel.remove(1);
          while (eSel.options.length > 1) eSel.remove(1);
          (res[0].error ? [] : U.rowsOf(res[0].data)).forEach(function (c) { cSel.appendChild(el('option', { value: c.id, text: c.container_no || String(c.id).slice(0, 8) })); });
          (res[1].error ? [] : U.rowsOf(res[1].data)).forEach(function (e) {
            eSel.appendChild(el('option', { value: e.id, text: U.lab('exception_kind', e.kind) + ' · ' + U.fmtDate(e.occurred_at) + (e.status ? ' · ' + U.lab('exception_status', e.status) : '') }));
          });
          if (keepC) cSel.value = keepC;
          if (keepE) eSel.value = keepE;
        });
      }
      if (editing) fillTx();
      pr.then(reload(editing ? t('saved') : t('dm_created')));
    }

    // --- client collection on an approved charge of the case ------------------------
    function collectDialog(x) {
      U.call(api, 'listClientCharges', x.transaction_id).then(function (r) {
        if (!sc.alive()) return;
        if (r.error) { F.toastErr(api, r); return; }
        var charges = U.rowsOf(r.data).filter(function (c) { return c.demurrage_case_id === x.id && c.status === 'approved'; });
        if (!charges.length) {
          U.formModal({ title: t('dm_collect'), size: 'sm', intro: el('div', null, [el('p', { text: t('dm_no_charge') }), el('a', { href: '#tx/' + x.transaction_id, text: U.t('open_tx') })]),
            fields: [], submitText: U.t('close'), submit: function () { return Promise.resolve({ data: true, error: null }); } });
          return;
        }
        var left = function (c) { return F.r2(F.nz(c.total_amount) - F.nz(c.collected_amount)); };
        var up = F.uploader(api), file = F.fileField(t('pay_evidence'), t('collect_evidence_hint'));
        var intro = el('div', null, [el('p', { class: 'form-hint', text: t('collect_rule') })]);
        var first = charges[0];
        var pr = U.formModal({
          title: t('dm_collect'), intro: intro, submitText: t('collect_record'),
          fields: [
            { name: 'charge_id', label: t('f_charge'), type: 'select', required: true, value: first.id, options: charges.map(function (c) { return [c.id, (c.description || F.lab('fin_charge_kind', c.kind)) + ' · ' + t('collect_left', { amt: F.moneyTxt(left(c), c.currency, api) })]; }) },
            { name: 'amount', label: t('f_amount'), required: true, ltr: true, inputmode: 'decimal', pattern: MONEY_RE, patternMsg: t('money_invalid'), value: left(first) > 0 ? F.amountStr(left(first)) : '' },
            { name: 'collected_at', label: t('f_collected_at'), type: 'date', required: true, value: U.isoDay(new Date()) },
            { name: 'method', label: t('f_method'), type: 'select', required: true, value: 'bank_transfer', options: F.METHODS.map(function (m) { return [m, F.lab('fin_payment_method', m)]; }) },
            { name: 'reference', label: t('f_reference'), max: 120, ltr: true }
          ],
          validate: function (v) {
            var bad = {}, c = charges.filter(function (z) { return z.id === v.charge_id; })[0], a = F.num(v.amount);
            if (!(a > 0)) bad.amount = t('amount_positive');
            else if (c && a > left(c) + 0.001) bad.amount = t('overpay_local', { amt: F.moneyTxt(left(c), c.currency, api) });
            if (!U.nn(v.reference) && !file.file()) bad.reference = t('ref_or_file');
            return bad;
          },
          submit: function (v) {
            var c = charges.filter(function (z) { return z.id === v.charge_id; })[0];
            // evidence is registered at the transaction's branch (the server refuses a file of another branch)
            var bid = x.branch_id || x.transaction_branch_id || (r.data && r.data.branch_id) || c.branch_id;
            return up(file.file(), bid, 'collection_evidence').then(function (u) {
              if (u.error) return u;
              // transaction / currency come from the charge (server)
              var p = { charge_id: c.id, amount: F.r2(F.num(v.amount)), collected_at: v.collected_at,
                method: v.method, reference: U.nn(v.reference), evidence_document_id: u.data ? u.data.id : null };
              var scope = 'fin-coll-' + c.id, key = U.idemKey(api, scope, p);
              return U.call(api, 'recordChargeCollection', p, { idemKey: key }).then(function (r2) { U.idemSettle(scope, r2.error); return r2; });
            });
          }
        });
        var form = intro.closest('form');
        if (form) {
          var grid = form.querySelector('.ops-form-grid');
          if (grid) grid.appendChild(file.node);
          form.elements.charge_id.addEventListener('change', function () {
            var c = charges.filter(function (z) { return z.id === form.elements.charge_id.value; })[0];
            if (c) form.elements.amount.value = left(c) > 0 ? F.amountStr(left(c)) : '';
          });
        }
        pr.then(reload(t('collect_recorded')));
      });
    }
    function statusDialog(x, nexts) {
      F.noteDialog(api, {
        title: t('dm_status'), intro: t('status_from', { from: F.lab('fin_demurrage_status', x.status) }),
        fields: [{ name: 'status', label: t('f_status_new'), type: 'select', required: true, value: nexts[0], options: nexts.map(function (s) { return [s, F.lab('fin_demurrage_status', s)]; }) }],
        hint: t('dm_status_hint'),
        submit: function (note, v) { return U.call(api, 'setDemurrageStatus', x.id, v.status, note); }
      }).then(reload(t('status_changed')));
    }
    return load();
  }

  Ops.views.demurrage = {
    allow: 'finRead', titleKey: 'fin.nav_demurrage', icon: 'clock',
    render: function (root, api, param) { return render(root, api, param); }
  };
})();
