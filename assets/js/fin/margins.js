/* ==========================================================================
   مرسى | MARSA — G4 operating costs: #margins (الهامش والتكاليف)
   --------------------------------------------------------------------------
   Contract: docs/online/G4_SPEC.md ("Cost items, margin, reports", #margins).
   Uses MarsaOps.ui + MarsaOps.finUi (assets/js/fin/invoices.js).

   A permanent banner says the figures are analytical, not accounting profit.
   Tab 1: margin_report (per transaction and currency, level badge مؤكد /
   تقديري / غير معروف, pending count). Tab 2: cost_report grouped by
   transaction / client / supplier / service / branch / level, per currency.
   No FX: every sum stays in its own currency. Due / paid / revenue are never
   mixed here (payables live in #payables).
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var PAGE = 50;
  var LEVELS = ['confirmed', 'estimated', 'unknown'];
  var STAGES = ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return', 'operationally_complete', 'under_billing', 'billed', 'closed'];
  var GROUPS = ['transaction', 'client', 'supplier', 'service', 'branch', 'level'];
  var MF = { tab: 'margin', branch_id: '', client_id: '', from: '', to: '', operational_status: '', level: '', currency: '', offset: 0 };
  var CF = { group_by: 'transaction', branch_id: '', client_id: '', supplier_id: '', service_code: '', from: '', to: '', level: '', currency: '', include_overhead: true };

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
    var clients = null, suppliers = null;
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'fin-margins');
    root.appendChild(U.head(t('mg_title'), t('mg_sub')));
    root.appendChild(F.analyticalBanner());
    var tabBox = el('div'), bar = el('div'), body = el('div', { class: 'app-stack' });
    root.appendChild(tabBox); root.appendChild(bar); root.appendChild(body);

    function lookups() {
      var calls = [];
      calls.push(clients ? null : U.call(api, 'listClients', { orgId: api && api.orgId, limit: 500 }));
      calls.push(suppliers ? null : F.parties(api));
      return Promise.all(calls).then(function (res) {
        if (res[0]) clients = res[0].error ? [] : U.rowsOf(res[0].data);
        if (res[1]) suppliers = res[1].rows;
      });
    }
    function load() {
      U.loadingInto(body);
      drawTabs();
      return lookups().then(function () {
        if (!sc.alive()) return;
        drawBar();
        return MF.tab === 'margin' ? loadMargin() : loadCost();
      });
    }
    function drawTabs() {
      U.clear(tabBox);
      tabBox.appendChild(F.tabs([['margin', t('mg_tab_margin')], ['cost', t('mg_tab_cost')]], MF.tab, function (v) { MF.tab = v; load(); }, t('mg_title')));
    }
    function clientOpts() { return [['', t('f_client') + ': ' + t('all')]].concat((clients || []).map(function (c) { return [c.id, (U.lang() === 'en' && c.name_en) || c.name_ar]; })); }
    function levelOpts() { return [['', t('f_level') + ': ' + t('all')]].concat(LEVELS.map(function (l) { return [l, F.lab('fin_level', l)]; })); }
    function curOpts() { return [['', t('f_currency') + ': ' + t('all')]].concat(F.currencyOptions()); }
    function drawBar() {
      U.clear(bar);
      var S = MF.tab === 'margin' ? MF : CF, re = MF.tab === 'margin' ? function () { MF.offset = 0; loadMargin(); } : loadCost;
      var set = function (k) { return function (v) { S[k] = v; re(); }; };
      var fl = [];
      if (MF.tab === 'cost') {
        fl.push(U.select('group_by', t('f_group_by'), GROUPS.map(function (g) { return [g, t('grp_' + g)]; }), CF.group_by, set('group_by')));
      }
      var bo = F.branchOptions(api, 'finRead', true);
      if (bo.length > 2) fl.push(U.select('branch_id', t('f_branch'), bo, S.branch_id, set('branch_id')));
      fl.push(U.select('client_id', t('f_client'), clientOpts(), S.client_id, set('client_id')));
      if (MF.tab === 'margin') {
        fl.push(U.select('operational_status', t('f_stage'), [['', t('f_stage') + ': ' + t('all')]].concat(STAGES.map(function (s) { return [s, U.lab('operational_status', s, api)]; })), MF.operational_status, set('operational_status')));
      } else {
        fl.push(U.select('supplier_id', t('f_supplier'), [['', t('f_supplier') + ': ' + t('all')]].concat((suppliers || []).map(function (p) { return [p.id, U.partyName(p)]; })), CF.supplier_id, set('supplier_id')));
        fl.push(U.select('service_code', t('f_service'), [['', t('f_service') + ': ' + t('all')]].concat(F.serviceOptions(false)), CF.service_code, set('service_code')));
      }
      fl.push(U.select('level', t('f_level'), levelOpts(), S.level, set('level')));
      fl.push(U.select('currency', t('f_currency'), curOpts(), S.currency, set('currency')));
      fl.push(F.dateInput('from', MF.tab === 'margin' ? t('from_tx') : t('from'), S.from, set('from')));
      fl.push(F.dateInput('to', t('to'), S.to, set('to')));
      if (MF.tab === 'cost') {
        var ov = el('input', { type: 'checkbox', checked: CF.include_overhead });
        ov.addEventListener('change', function () { CF.include_overhead = ov.checked; loadCost(); });
        fl.push(el('label', { class: 'ops-inline-check' }, [ov, el('span', { text: t('f_include_overhead') })]));
      }
      bar.appendChild(U.toolbar(null, fl, [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })]));
    }
    function pick(S, keys) { var f = {}; keys.forEach(function (k) { if (S[k] !== '' && S[k] != null) f[k] = S[k]; }); return f; }

    // --- tab 1: margin report ---------------------------------------------------
    function loadMargin() {
      U.loadingInto(body);
      var f = pick(MF, ['branch_id', 'client_id', 'from', 'to', 'operational_status', 'level', 'currency']);
      f.limit = PAGE; f.offset = MF.offset;
      return U.call(api, 'marginReport', f).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, loadMargin)); return; }
        drawMargin(F.dataOf(r), U.rowsOf(r.data));
      });
    }
    function totalsCard(tbc, cols, title) {
      var rows = F.byCurrency(tbc);
      if (!rows.length) return null;
      return U.card(title, U.table([t('f_currency')].concat(cols.map(function (c) { return { label: t('m_' + c), num: true }; })),
        rows.map(function (r) {
          return el('tr', null, [U.td(U.ltr(r.currency))].concat(cols.map(function (c) {
            return c === 'unknown_count' ? U.td(U.ltr(String(r[c] || 0)), 'num') : U.td(F.money(r[c] == null ? 0 : r[c], r.currency, api), 'num' + (/^margin/.test(c) ? ' fin-strong' : ''));
          })));
        }), { caption: title }), null, { flush: true });
    }
    function drawMargin(d, rows) {
      U.clear(body);
      var total = d.total != null ? +d.total : rows.length;
      var tc = totalsCard(d.totals_by_currency, ['charges_service', 'cost_confirmed', 'cost_estimated', 'margin_confirmed', 'margin_expected'], t('totals_by_currency'));
      if (tc) body.appendChild(tc);
      if (!rows.length) { body.appendChild(U.card(null, U.emptyState('search', t('mg_empty_title'), t('mg_empty_text')))); return; }
      body.appendChild(U.card(t('mg_rows', { n: total }), U.table([t('tx'), t('f_client'), t('f_currency'), { label: t('m_charges_service'), num: true }, { label: t('m_cost_confirmed'), num: true }, { label: t('m_cost_estimated'), num: true },
        { label: t('m_margin_confirmed'), num: true }, { label: t('m_margin_expected'), num: true }, t('f_level'), { label: t('m_pending'), num: true }],
        rows.map(function (x) {
          var cur = x.currency || 'SAR';
          return el('tr', { 'data-id': x.transaction_id, class: 'fin-level-row-' + (x.level || 'unknown') }, [
            U.td([U.txLink(Object.assign({ transaction_ref: x.ref }, x)), el('span', { class: 'cell-sub', text: F.branchName(api, x.branch_id) })], 'is-nowrap'),
            U.td(el('span', { text: (U.lang() === 'en' && x.client_name_en) || x.client_name || x.client_name_en || U.NONE })),
            U.td(U.ltr(cur)),
            U.td(F.money(x.charges_service, cur, api), 'num'), U.td(F.money(x.cost_confirmed, cur, api), 'num'), U.td(F.money(x.cost_estimated, cur, api), 'num'),
            U.td(F.money(x.margin_confirmed, cur, api), 'num fin-strong'), U.td(F.money(x.margin_expected, cur, api), 'num'),
            U.td(F.levelPill(x.level)),
            U.td(+x.pending_count ? el('span', { class: 'badge badge-warning', text: String(x.pending_count) }) : U.ltr('0'), 'num')
          ]);
        }), { caption: t('mg_tab_margin') }), null, { flush: true, sub: t('mg_rows_sub') }));
      var pg = F.pager(total, PAGE, MF.offset, function (o) { MF.offset = o; loadMargin(); });
      if (pg) body.appendChild(pg);
    }

    // --- tab 2: cost report ------------------------------------------------------
    function loadCost() {
      U.loadingInto(body);
      var f = pick(CF, ['group_by', 'branch_id', 'client_id', 'supplier_id', 'service_code', 'from', 'to', 'level', 'currency']);
      f.include_overhead = !!CF.include_overhead;
      return U.call(api, 'costReport', f).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, loadCost)); return; }
        drawCost(F.dataOf(r), U.rowsOf(r.data));
      });
    }
    function keyLabel(g, x) {
      var own = U.lang() === 'en' ? (x.label_en || x.label_ar) : (x.label_ar || x.label_en);
      if (g === 'level') return F.lab('fin_level', x.key);
      if (g === 'service') return x.key ? F.lab('fin_service', x.key) : (own || t('service_none'));
      if (g === 'branch' && !own) return F.branchName(api, x.key);
      if (!x.key && !own) return t('key_none_' + g);
      return own || String(x.key);
    }
    function drawCost(d, rows) {
      U.clear(body);
      var g = d.group_by || CF.group_by;
      var tc = totalsCard(d.totals_by_currency, ['confirmed', 'estimated', 'unknown_count', 'pass_through', 'client_paid_direct'], t('totals_by_currency'));
      if (tc) body.appendChild(tc);
      if (!rows.length) { body.appendChild(U.card(null, U.emptyState('search', t('cr_empty_title'), t('cr_empty_text')))); return; }
      body.appendChild(U.card(t('cr_rows', { g: t('grp_' + g), n: rows.length }), U.table([t('grp_' + g), t('f_currency'), { label: t('m_confirmed'), num: true }, { label: t('m_estimated'), num: true },
        { label: t('m_unknown_count'), num: true }, { label: t('m_pass_through'), num: true }, { label: t('m_client_paid_direct'), num: true }, { label: t('m_items'), num: true }],
        rows.map(function (x) {
          var cur = x.currency || 'SAR', label = keyLabel(g, x);
          var keyNode = g === 'transaction' && x.key && F.UUID_RE.test(x.key) ? el('a', { class: 'ops-ref', href: '#tx/' + x.key }, el('bdi', { dir: 'ltr', text: label }))
            : g === 'level' ? F.levelPill(x.key) : el('span', { class: 'cell-main', text: label });
          return el('tr', null, [U.td(keyNode), U.td(U.ltr(cur)), U.td(F.money(x.confirmed, cur, api), 'num fin-strong'), U.td(F.money(x.estimated, cur, api), 'num'),
            U.td(+x.unknown_count ? el('span', { class: 'badge badge-danger', text: String(x.unknown_count) }) : U.ltr('0'), 'num'),
            U.td(F.money(x.pass_through, cur, api), 'num'), U.td(F.money(x.client_paid_direct, cur, api), 'num'), U.td(U.ltr(String(x.items == null ? '' : x.items)), 'num')]);
        }), { caption: t('mg_tab_cost') }), null, { flush: true, sub: t('cr_rows_sub') }));
    }
    return load();
  }

  Ops.views.margins = {
    allow: 'finRead', titleKey: 'fin.nav_margins', icon: 'chart',
    render: function (root, api) { return render(root, api); }
  };
})();
