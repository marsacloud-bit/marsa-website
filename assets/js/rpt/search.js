/* ==========================================================================
   مرسى | MARSA — G6a advanced search: #search (البحث المتقدم)
   --------------------------------------------------------------------------
   Contract: docs/online/G6A_SPEC.md §4 (search_records) + §5.3 (export).
   Filter form (original .form-control): نص عام، رقم البيان، رقم البوليصة، رقم الحاوية،
   العميل (select + text)، الناقل (select + text)، المنفذ، نوع التاريخ + من / إلى، الفرع،
   الحالة (checkboxes), الترتيب. Results: .table.table-striped.adm-table in .table-wrap,
   ref links #tx/<id>, matched chips, pager (25), export bar for the current filters.
   Filters live in the hash query (#search?container_no=MSCU…&status=transport), so back /
   reload keep them. The server filters by org, branch scope and role — the UI never does.
   Uses MarsaOps.ui (ops/alerts.js) + MarsaExport.kit() (rpt/export.js).
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var PAGE = 25;
  var DATE_FIELDS = ['created', 'eta', 'declaration', 'status_changed'];
  var SORTS = ['created_desc', 'created_asc', 'ref', 'eta', 'status_changed_desc'];
  var TEXT_KEYS = ['q', 'declaration_no', 'bl_number', 'container_no', 'client_q', 'carrier_q', 'port'];
  function blank() {
    return { q: '', declaration_no: '', bl_number: '', container_no: '', client_id: '', client_q: '', carrier_id: '', carrier_q: '', port: '',
      date_field: 'created', from: '', to: '', branch_id: '', operational_status: [], sort: 'created_desc', offset: 0 };
  }
  var SF = blank();   // survives navigation (and is mirrored in the hash query)

  // hash query ⇄ state ('status' is the short name of operational_status)
  function fromQuery(K, q) {
    var s = blank(), Q = K.Q;
    TEXT_KEYS.forEach(function (k) { if (q[k] != null) s[k] = Q.text(q[k]); });
    if (q.client_id) s.client_id = Q.uuid(q.client_id);
    if (q.carrier_id) s.carrier_id = Q.uuid(q.carrier_id);
    if (q.branch_id) s.branch_id = Q.uuid(q.branch_id);
    if (q.date_field && DATE_FIELDS.indexOf(q.date_field) !== -1) s.date_field = q.date_field;
    if (q.from) s.from = Q.day(q.from);
    if (q.to) s.to = Q.day(q.to);
    var st = q.status != null ? q.status : q.operational_status;
    if (st) s.operational_status = Q.codes(st).filter(function (c) { return K.STAGES.indexOf(c) !== -1; });
    if (q.sort && SORTS.indexOf(q.sort) !== -1) s.sort = q.sort;
    if (q.offset) s.offset = Q.int(q.offset);
    return s;
  }
  function toQuery(s) {
    var o = {};
    TEXT_KEYS.concat(['client_id', 'carrier_id', 'branch_id', 'from', 'to']).forEach(function (k) { if (s[k]) o[k] = s[k]; });
    if ((s.from || s.to) && s.date_field !== 'created') o.date_field = s.date_field;
    if (s.operational_status.length) o.status = s.operational_status.slice();
    if (s.sort !== 'created_desc') o.sort = s.sort;
    if (s.offset) o.offset = s.offset;
    return o;
  }
  // the filter object sent to search_records (and audited on export), without paging
  function toFilters(s) {
    var f = {};
    TEXT_KEYS.forEach(function (k) { var v = String(s[k] || '').trim(); if (v) f[k] = v; });
    ['client_id', 'carrier_id', 'branch_id', 'from', 'to'].forEach(function (k) { if (s[k]) f[k] = s[k]; });
    if (s.from || s.to) f.date_field = s.date_field || 'created';
    if (s.operational_status.length) f.operational_status = s.operational_status.length === 1 ? s.operational_status[0] : s.operational_status.slice();
    if (s.sort && s.sort !== 'created_desc') f.sort = s.sort;
    return f;
  }

  function render(root, api) {
    var U = Ops.ui, K = window.MarsaExport && window.MarsaExport.kit && window.MarsaExport.kit();
    if (!U || !K) {
      while (root.firstChild) root.removeChild(root.firstChild);
      var d = document.createElement('div');
      d.className = 'alert alert-danger'; d.setAttribute('role', 'alert');
      d.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui / MarsaExport missing';
      root.appendChild(d);
      return;
    }
    K.use(api);
    var t = K.t, el = U.el, sc = U.scope(root);
    var pending = K.takeQuery('search');
    if (pending) SF = fromQuery(K, K.parseQuery(pending.query));
    var ctx = { finRead: U.can(api, 'finRead'), clients: [], carriers: [] };
    var def = K.defs.search;

    U.clear(root);
    root.classList.add('ops-view', 'rpt-view', 'rpt-search');
    root.appendChild(U.head(t('search_title'), t('search_sub')));
    var formBox = el('div'), body = el('div', { class: 'app-stack rpt-results', 'aria-live': 'polite' });
    root.appendChild(formBox); root.appendChild(body);

    function lookups() {
      return Promise.all([
        U.call(api, 'listClients', { orgId: api && api.orgId, limit: 500 }),
        U.call(api, 'listParties', { kind: 'carrier', limit: 500 })
      ]).then(function (res) {
        ctx.clients = res[0].error ? [] : U.rowsOf(res[0].data);
        ctx.carriers = res[1].error ? [] : U.rowsOf(res[1].data);
        // complete lists only (no error, below the limit): an id not in them is stale / another org's
        ctx.clientsComplete = !res[0].error && ctx.clients.length < 500;
        ctx.carriersComplete = !res[1].error && ctx.carriers.length < 500;
      });
    }
    function nameOf(x) { return (K.isEn() && x.name_en) || x.name_ar || x.name_en || String(x.id).slice(0, 8); }

    var form;
    function drawForm() {
      U.clear(formBox);
      var stageOpts = K.STAGES.map(function (s) { return [s, K.lab('operational_status', s, api)]; });
      form = el('form', { class: 'rpt-filters rpt-search-form', novalidate: true, role: 'search', 'aria-label': t('search_title') });
      var grid = el('div', { class: 'rpt-grid' }, [
        K.field(t('f_q'), K.input('q', SF.q, { placeholder: t('f_q_ph') }), 'is-wide'),
        K.field(t('f_declaration_no'), K.input('declaration_no', SF.declaration_no, { ltr: true })),
        K.field(t('f_bl_number'), K.input('bl_number', SF.bl_number, { ltr: true })),
        K.field(t('f_container_no'), K.input('container_no', SF.container_no, { ltr: true, placeholder: 'MSCU1234567' })),
        K.field(t('f_client'), K.select('client_id', [['', t('all')]].concat(ctx.clients.map(function (c) { return [c.id, nameOf(c)]; })), SF.client_id)),
        K.field(t('f_client_q'), K.input('client_q', SF.client_q, { placeholder: t('f_client_q_ph') })),
        K.field(t('f_carrier'), K.select('carrier_id', [['', t('all')]].concat(ctx.carriers.map(function (c) { return [c.id, nameOf(c)]; })), SF.carrier_id)),
        K.field(t('f_carrier_q'), K.input('carrier_q', SF.carrier_q, { placeholder: t('f_carrier_q_ph') })),
        K.field(t('f_port'), K.input('port', SF.port)),
        K.field(t('f_date_field'), K.select('date_field', DATE_FIELDS.map(function (f) { return [f, K.lab('search_date_field', f)]; }), SF.date_field)),
        K.field(t('f_from'), K.input('from', SF.from, { type: 'date' })),
        K.field(t('f_to'), K.input('to', SF.to, { type: 'date' })),
        K.field(t('f_branch'), K.select('branch_id', K.branchOptions(api), SF.branch_id)),
        K.field(t('f_sort'), K.select('sort', SORTS.map(function (s) { return [s, t('sort_' + s)]; }), SF.sort))
      ]);
      var status = el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: t('f_status') }), K.checks('operational_status', stageOpts, SF.operational_status)]);
      var err = el('p', { class: 'rpt-form-error', role: 'alert', hidden: true });
      var go = el('button', { type: 'submit', class: 'btn btn-primary btn-sm rpt-go' }, [U.icon('search'), el('span', { text: t('do_search') })]);
      var reset = el('button', { type: 'button', class: 'btn btn-subtle btn-sm rpt-clear', text: t('clear') });
      reset.addEventListener('click', function (e) { e.preventDefault(); SF = blank(); drawForm(); runSearch(); });
      form.appendChild(grid); form.appendChild(status); form.appendChild(err);
      form.appendChild(el('div', { class: 'rpt-form-actions' }, [go, reset]));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var s = blank(), E = form.elements;
        TEXT_KEYS.forEach(function (k) { s[k] = String(E[k].value || '').trim().slice(0, 80); });
        ['client_id', 'carrier_id', 'branch_id', 'date_field', 'from', 'to', 'sort'].forEach(function (k) { s[k] = E[k].value || (k === 'date_field' ? 'created' : k === 'sort' ? 'created_desc' : ''); });
        s.operational_status = K.checkedValues(form, 'operational_status');
        var msg = check(s);
        err.hidden = !msg; err.textContent = msg || '';
        if (msg) return;
        SF = s; runSearch();
      });
      formBox.appendChild(U.card(null, form, null, { cls: 'rpt-filter-card' }));
    }
    function check(s) {
      if (s.q && s.q.length < 2) return t('err_q_short');
      if (s.from && s.to && s.from > s.to) return t('err_range');
      if (s.from && s.to && (Date.parse(s.to) - Date.parse(s.from)) / 86400000 > 1096) return t('err_range_wide');
      return null;
    }

    var lastFilters = {};
    function runSearch() {
      K.setHash('search', toQuery(SF));
      var f = toFilters(SF);
      lastFilters = K.deepCopy(f);
      U.loadingInto(body);
      return U.call(api, 'searchRecords', Object.assign({}, f, { limit: PAGE, offset: SF.offset || 0 })).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, runSearch)); return; }
        draw(r.data || {});
      });
    }
    function draw(d) {
      var items = def.items(d), total = d.total != null ? +d.total : items.length;
      if (!items.length) {
        body.appendChild(U.card(null, U.emptyState('search', t('search_empty_title'), t('search_empty_text'),
          [U.btn(t('clear'), 'btn-secondary', function () { SF = blank(); drawForm(); runSearch(); })])));
        return;
      }
      var cols = def.columns(ctx);
      var head = el('div', { class: 'rpt-result-head' }, [
        el('p', { class: 'rpt-count', text: t('results_n', { n: K.fmtNum(total, 0) }) }),
        K.exportBar({ api: api, def: def, ctx: ctx, total: total, getFilters: function () { return lastFilters; } })
      ]);
      body.appendChild(head);
      body.appendChild(U.card(null, K.reportTable(cols, items, def.totalsRows(d, ctx), ctx, { caption: t('search_title') }), null, { flush: true }));
      var pg = K.pager(total, PAGE, SF.offset || 0, function (o) { SF.offset = o; runSearch(); });
      if (pg) body.appendChild(pg);
    }

    U.loadingInto(body);
    return lookups().then(function () {
      if (!sc.alive()) return;
      // a hash query (or the remembered state) may name a branch / client / carrier the form cannot show
      if (typeof K.dropUnknownIds === 'function') K.dropUnknownIds(SF, api, ctx);
      drawForm();
      var msg = check(SF);
      if (msg) { U.doneLoading(body); body.appendChild(U.alertBox('warning', msg)); return; }
      return runSearch();
    });
  }

  Ops.views.search = {
    allow: 'staff', titleKey: 'rpt.nav_search', icon: 'search',
    render: function (root, api) { return render(root, api); },
    _state: function () { return SF; }, _reset: function () { SF = blank(); }   // test hooks
  };
})();
