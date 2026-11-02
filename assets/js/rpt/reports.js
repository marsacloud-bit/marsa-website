/* ==========================================================================
   مرسى | MARSA — G6a reports: #reports/<kind> (التقارير)
   --------------------------------------------------------------------------
   Contract: docs/online/G6A_SPEC.md §5.1–5.4.
   Tabs: transactions «المعاملات», containers «الحاويات وإرجاع الفارغ», trips «رحلات النقل» (staff);
   margins «الربحية (تحليلي)», costs «التكاليف (تحليلي)» (finRead only); exports «سجل التصدير»
   (everyone: own rows; auditRead: all). Each tab: filter bar → summary tiles from the server
   `totals` → table (page of 100, pager) → <tfoot> totals row(s) from `totals` → export bar.
   The same report definition (MarsaExport.kit().defs) draws the table / tfoot and builds the
   file, so the exported columns and totals are the ones on screen. Trips: «إظهار التكلفة والبيع»
   only for tripFin. Default range: last 30 days (Asia/Riyadh). A hash query
   (#reports/containers?overdue=true) replaces the tab's filters once (dashboard tiles).
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var PAGE = 100, PAGE_MARGIN = 100, PAGE_LOG = 50;
  var TABS = ['transactions', 'containers', 'trips', 'margins', 'costs', 'exports'];
  var FIN_TABS = { margins: 1, costs: 1 };
  var TRIP_FIN = ['accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'];
  var AUDIT = ['admin', 'supervisor'];
  var TX_DATE_FIELDS = ['created', 'eta', 'declaration', 'status_changed'];
  var CT_DATE_FIELDS = ['created', 'return_deadline', 'returned_at', 'gate_out'];
  var REPORT_KINDS = ['search', 'transactions', 'containers', 'trips', 'margins', 'costs'];
  var TX_SORTS = ['created_desc', 'created_asc', 'ref', 'eta', 'status_changed_desc'];

  // per tab: filter schema (query type), defaults (last 30 days), the date keys
  var SCHEMA = {
    transactions: { q: 'text', declaration_no: 'text', bl_number: 'text', container_no: 'text', client_id: 'uuid', client_q: 'text', carrier_id: 'uuid', carrier_q: 'text',
      port: 'text', date_field: 'code', from: 'day', to: 'day', branch_id: 'uuid', operational_status: 'codes', sort: 'code' },
    containers: { branch_id: 'uuid', client_id: 'uuid', container_no: 'text', date_field: 'code', from: 'day', to: 'day', return_status: 'codes', operational_state: 'codes', overdue: 'bool', sort: 'code' },
    trips: { branch_id: 'uuid', client_id: 'uuid', carrier_id: 'uuid', status: 'codes', from: 'day', to: 'day', late: 'bool', include_finance: 'bool', sort: 'code' },
    margins: { branch_id: 'uuid', client_id: 'uuid', from: 'day', to: 'day', operational_status: 'code', level: 'code', currency: 'code' },
    costs: { group_by: 'code', branch_id: 'uuid', client_id: 'uuid', from: 'day', to: 'day', level: 'code', currency: 'code', include_overhead: 'bool' },
    exports: { report: 'code', from: 'day', to: 'day', mine: 'bool' }
  };
  var ALIAS = { transactions: { status: 'operational_status' }, margins: { status: 'operational_status' } };
  function defaults(K, kind) {
    var to = K.today(), from = K.addDays(to, -30);
    var base = { from: from, to: to, offset: 0 };
    if (kind === 'transactions') base.date_field = 'created';
    if (kind === 'containers') { base.date_field = 'created'; base.sort = 'deadline_asc'; }
    if (kind === 'trips') base.sort = 'planned_desc';
    if (kind === 'costs') { base.group_by = 'transaction'; base.include_overhead = true; }
    return base;
  }
  var ST = {};          // per-tab state, survives navigation
  var LAST_TAB = 'transactions';

  function fromQuery(K, kind, q) {
    var s = { offset: 0 }, sch = SCHEMA[kind], al = ALIAS[kind] || {};
    Object.keys(q).forEach(function (k0) {
      var k = al[k0] || k0, type = sch[k], v = q[k0];
      if (!type) return;
      var val = K.Q[type](v);
      if (type === 'codes' ? val.length : type === 'bool' ? true : val !== '') s[k] = val;
    });
    if (kind === 'costs' && K.GROUPS.indexOf(s.group_by) === -1) s.group_by = 'transaction';
    if (kind === 'costs' && s.include_overhead == null) s.include_overhead = true;
    if (q.offset) s.offset = K.Q.int(q.offset);
    return s;
  }
  function toQuery(kind, s) {
    var o = {}, sch = SCHEMA[kind];
    Object.keys(sch).forEach(function (k) { var v = s[k]; if (v == null || v === '' || v === false || (Array.isArray(v) && !v.length)) return; o[kind === 'transactions' && k === 'operational_status' ? 'status' : k] = v; });
    // a bool whose default is true must be written when false (buildQuery drops false), or reload / a shared link flips it back
    if (kind === 'costs' && s.include_overhead === false) o.include_overhead = 'false';
    if (s.offset) o.offset = s.offset;
    return o;
  }
  // the reader's filter object (exactly what the table shows; the export reuses a deep copy)
  function toFilters(kind, s, api) {
    var f = {};
    Object.keys(SCHEMA[kind]).forEach(function (k) {
      var v = s[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      if (SCHEMA[kind][k] === 'text') { v = String(v).trim(); if (!v) return; }
      f[k] = Array.isArray(v) && v.length === 1 ? v[0] : v;
    });
    if (kind === 'trips') { if (!f.include_finance) delete f.include_finance; if (!f.late) delete f.late; }
    if (kind === 'containers' && !f.overdue) delete f.overdue;
    if ((kind === 'transactions' || kind === 'containers') && !f.from && !f.to) delete f.date_field;
    if (kind === 'exports') { if (f.mine) f.actor = api && api.userId; delete f.mine; }
    return f;
  }

  function render(root, api, param) {
    var U = Ops.ui, K = window.MarsaExport && window.MarsaExport.kit && window.MarsaExport.kit();
    if (!U || !K) {
      while (root.firstChild) root.removeChild(root.firstChild);
      var d0 = document.createElement('div');
      d0.className = 'alert alert-danger'; d0.setAttribute('role', 'alert');
      d0.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui / MarsaExport missing';
      root.appendChild(d0);
      return;
    }
    K.use(api);
    var t = K.t, el = U.el, sc = U.scope(root);
    var finRead = U.can(api, 'finRead');
    var tripFin = U.can(api, 'tripFin') || U.can(api, TRIP_FIN);
    var auditRead = U.can(api, 'auditRead') || U.can(api, AUDIT);
    var allowed = TABS.filter(function (k) { return !FIN_TABS[k] || finRead; });
    var pending = K.takeQuery('reports');
    var kind = param && allowed.indexOf(param) !== -1 ? param : null;
    if (!kind && pending) { var pk = pending.path.split('/')[1]; if (allowed.indexOf(pk) !== -1) kind = pk; }
    if (!kind) kind = allowed.indexOf(LAST_TAB) !== -1 && !param ? LAST_TAB : 'transactions';
    LAST_TAB = kind;
    if (pending && (pending.path.split('/')[1] || 'transactions') === kind) ST[kind] = Object.assign(defaults(K, kind), { from: '', to: '' }, fromQuery(K, kind, K.parseQuery(pending.query)));
    if (!ST[kind]) ST[kind] = defaults(K, kind);
    var S = ST[kind];
    if (kind === 'trips' && !tripFin) S.include_finance = false;
    if (kind === 'exports' && !auditRead) S.mine = false;   // non-auditors see only their own rows anyway (server)
    var ctx = { finRead: finRead, includeFinance: kind === 'trips' && !!S.include_finance && tripFin, groupBy: S.group_by, clients: [], carriers: [] };
    var def = K.defs[kind] || null;

    U.clear(root);
    root.classList.add('ops-view', 'rpt-view', 'rpt-reports', 'rpt-kind-' + kind);
    root.appendChild(U.head(t('reports_title'), t('reports_sub')));
    root.appendChild(el('div', { class: 'tab-list rpt-tabs', role: 'tablist', 'aria-label': t('reports_title') }, allowed.map(function (k) {
      var b = el('button', { class: 'tab', type: 'button', role: 'tab', 'data-tab': k, 'aria-selected': String(k === kind), text: t('tab_' + k) });
      b.addEventListener('click', function () { if (k !== kind) U.go(api, '#reports/' + k); });
      return b;
    })));
    if (FIN_TABS[kind]) root.appendChild(U.alertBox('warning', t('analytical_banner')));
    var formBox = el('div'), tiles = el('div', { class: 'adm-tiles ops-kpis rpt-tiles', 'aria-live': 'polite' }), body = el('div', { class: 'app-stack rpt-results' });
    root.appendChild(formBox); root.appendChild(tiles); root.appendChild(body);

    function nameOf(x) { return (K.isEn() && x.name_en) || x.name_ar || x.name_en || String(x.id).slice(0, 8); }
    function lookups() {
      var need = kind !== 'exports' && kind !== 'costs' ? 1 : kind === 'costs' ? 1 : 0;
      return Promise.all([
        need ? U.call(api, 'listClients', { orgId: api && api.orgId, limit: 500 }) : null,
        kind === 'transactions' || kind === 'trips' ? U.call(api, 'listParties', { kind: 'carrier', limit: 500 }) : null
      ]).then(function (res) {
        ctx.clients = res[0] && !res[0].error ? U.rowsOf(res[0].data) : [];
        ctx.carriers = res[1] && !res[1].error ? U.rowsOf(res[1].data) : [];
        // complete lists only (loaded, below the limit): an id not in them is stale / another org's
        ctx.clientsComplete = !!(res[0] && !res[0].error) && ctx.clients.length < 500;
        ctx.carriersComplete = !!(res[1] && !res[1].error) && ctx.carriers.length < 500;
      });
    }

    // ---- filter form ---------------------------------------------------------------
    function opt(list, fn) { return list.map(function (c) { return [c, fn(c)]; }); }
    function drawForm() {
      U.clear(formBox);
      var F = [], extra = [];
      var cl = [['', t('all')]].concat(ctx.clients.map(function (c) { return [c.id, nameOf(c)]; }));
      var ca = [['', t('all')]].concat(ctx.carriers.map(function (c) { return [c.id, nameOf(c)]; }));
      if (kind === 'transactions') {
        F.push(K.field(t('f_q'), K.input('q', S.q, { placeholder: t('f_q_ph') }), 'is-wide'),
          K.field(t('f_declaration_no'), K.input('declaration_no', S.declaration_no, { ltr: true })),
          K.field(t('f_bl_number'), K.input('bl_number', S.bl_number, { ltr: true })),
          K.field(t('f_container_no'), K.input('container_no', S.container_no, { ltr: true })),
          K.field(t('f_client'), K.select('client_id', cl, S.client_id)),
          K.field(t('f_client_q'), K.input('client_q', S.client_q, { placeholder: t('f_client_q_ph') })),
          K.field(t('f_carrier'), K.select('carrier_id', ca, S.carrier_id)),
          K.field(t('f_carrier_q'), K.input('carrier_q', S.carrier_q, { placeholder: t('f_carrier_q_ph') })),
          K.field(t('f_port'), K.input('port', S.port)),
          K.field(t('f_date_field'), K.select('date_field', opt(TX_DATE_FIELDS, function (c) { return K.lab('search_date_field', c); }), S.date_field || 'created')),
          K.field(t('f_sort'), K.select('sort', opt(TX_SORTS, function (c) { return t('sort_' + c); }), TX_SORTS.indexOf(S.sort) !== -1 ? S.sort : 'created_desc')));
        extra.push(el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: t('f_status') }),
          K.checks('operational_status', opt(K.STAGES, function (c) { return K.lab('operational_status', c, api); }), [].concat(S.operational_status || []))]));
      } else if (kind === 'containers') {
        F.push(K.field(t('f_container_no'), K.input('container_no', S.container_no, { ltr: true })),
          K.field(t('f_client'), K.select('client_id', cl, S.client_id)),
          K.field(t('f_date_field'), K.select('date_field', opt(CT_DATE_FIELDS, function (c) { return t('cdf_' + c); }), S.date_field || 'created')),
          K.field(t('f_sort'), K.select('sort', opt(['deadline_asc', 'deadline_desc', 'container_no', 'created_desc'], function (c) { return t('sort_' + c); }), S.sort || 'deadline_asc')));
        var od = el('input', { type: 'checkbox', name: 'overdue' }); od.checked = !!S.overdue;
        extra.push(el('label', { class: 'ops-inline-check rpt-check' }, [od, el('span', { text: t('f_overdue') })]),
          el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: t('f_return_status') }),
            K.checks('return_status', opt(K.RETURN_STATUSES, function (c) { return K.lab('container_return_status', c, api); }), [].concat(S.return_status || []))]),
          el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: t('f_operational_state') }),
            K.checks('operational_state', opt(K.CONTAINER_STATES, function (c) { return K.lab('container_state', c, api); }), [].concat(S.operational_state || []))]));
      } else if (kind === 'trips') {
        F.push(K.field(t('f_client'), K.select('client_id', cl, S.client_id)),
          K.field(t('f_carrier'), K.select('carrier_id', ca, S.carrier_id)),
          K.field(t('f_sort'), K.select('sort', opt(['planned_desc', 'planned_asc'], function (c) { return t('sort_' + c); }), S.sort || 'planned_desc')));
        var late = el('input', { type: 'checkbox', name: 'late' }); late.checked = !!S.late;
        extra.push(el('label', { class: 'ops-inline-check rpt-check' }, [late, el('span', { text: t('f_late') })]),
          el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: t('f_trip_status') }),
          K.checks('status', opt(K.TRIP_STATUSES, function (c) { return K.lab('trip_status', c, api); }), [].concat(S.status || []))]));
        if (tripFin) {
          var fin = el('input', { type: 'checkbox', name: 'include_finance', class: 'rpt-include-finance' }); fin.checked = !!S.include_finance;
          extra.push(el('label', { class: 'ops-inline-check rpt-check' }, [fin, el('span', { text: t('f_include_finance') })]));
        }
      } else if (kind === 'margins') {
        F.push(K.field(t('f_client'), K.select('client_id', cl, S.client_id)),
          K.field(t('f_status'), K.select('operational_status', [['', t('all')]].concat(opt(K.STAGES, function (c) { return K.lab('operational_status', c, api); })), S.operational_status)),
          K.field(t('f_level'), K.select('level', [['', t('all')]].concat(opt(K.LEVELS, function (c) { return K.lab('fin_level', c, api); })), S.level)),
          K.field(t('f_currency'), K.select('currency', [['', t('all')]].concat(opt(K.CURRENCIES, function (c) { return c; })), S.currency)));
      } else if (kind === 'costs') {
        F.push(K.field(t('f_group_by'), K.select('group_by', opt(K.GROUPS, function (c) { return t('grp_' + c); }), S.group_by || 'transaction')),
          K.field(t('f_client'), K.select('client_id', cl, S.client_id)),
          K.field(t('f_level'), K.select('level', [['', t('all')]].concat(opt(K.LEVELS, function (c) { return K.lab('fin_level', c, api); })), S.level)),
          K.field(t('f_currency'), K.select('currency', [['', t('all')]].concat(opt(K.CURRENCIES, function (c) { return c; })), S.currency)));
        var ov = el('input', { type: 'checkbox', name: 'include_overhead' }); ov.checked = S.include_overhead !== false;
        extra.push(el('label', { class: 'ops-inline-check rpt-check' }, [ov, el('span', { text: t('f_include_overhead') })]));
      } else if (kind === 'exports') {
        F.push(K.field(t('f_report'), K.select('report', [['', t('all')]].concat(opt(REPORT_KINDS, function (c) { return K.lab('report_kind', c); })), S.report)));
        if (auditRead) { var mine = el('input', { type: 'checkbox', name: 'mine' }); mine.checked = !!S.mine; extra.push(el('label', { class: 'ops-inline-check rpt-check' }, [mine, el('span', { text: t('f_mine') })])); }
      }
      if (kind !== 'exports') F.push(K.field(t('f_branch'), K.select('branch_id', K.branchOptions(api), S.branch_id)));
      F.push(K.field(kind === 'trips' ? t('f_from_planned') : kind === 'margins' ? t('f_from_created') : kind === 'costs' ? t('f_from_item') : t('f_from'), K.input('from', S.from, { type: 'date' })),
        K.field(t('f_to'), K.input('to', S.to, { type: 'date' })));
      var form = el('form', { class: 'rpt-filters', novalidate: true, role: 'search', 'aria-label': t('tab_' + kind) });
      var err = el('p', { class: 'rpt-form-error', role: 'alert', hidden: true });
      var apply = el('button', { type: 'submit', class: 'btn btn-primary btn-sm rpt-go', text: t('apply') });
      var reset = el('button', { type: 'button', class: 'btn btn-subtle btn-sm rpt-clear', text: t('clear') });
      reset.addEventListener('click', function (e) { e.preventDefault(); ST[kind] = S = defaults(K, kind); ctx.includeFinance = false; ctx.groupBy = S.group_by; drawForm(); load(); });
      form.appendChild(el('div', { class: 'rpt-grid' }, F));
      extra.forEach(function (x) { form.appendChild(x); });
      form.appendChild(err);
      form.appendChild(el('div', { class: 'rpt-form-actions' }, [apply, reset]));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var s = { offset: 0 }, E = form.elements;
        Object.keys(SCHEMA[kind]).forEach(function (k) {
          var type = SCHEMA[kind][k];
          if (type === 'codes') { s[k] = K.checkedValues(form, k); return; }
          var c = E[k];
          if (!c) { if (S[k] != null && type !== 'bool') s[k] = S[k]; return; }
          s[k] = type === 'bool' ? !!c.checked : type === 'text' ? String(c.value || '').trim().slice(0, 80) : c.value;
        });
        if (kind === 'transactions' && s.sort === 'created_desc') s.sort = '';   // the server default; keeps the hash short
        var msg = s.q && s.q.length < 2 ? t('err_q_short') : s.from && s.to && s.from > s.to ? t('err_range') :
          s.from && s.to && (Date.parse(s.to) - Date.parse(s.from)) / 86400000 > 1096 ? t('err_range_wide') : null;
        err.hidden = !msg; err.textContent = msg || '';
        if (msg) return;
        ST[kind] = S = s;
        ctx.includeFinance = kind === 'trips' && !!s.include_finance && tripFin;
        ctx.groupBy = s.group_by;
        load();
      });
      formBox.appendChild(U.card(null, form, null, { cls: 'rpt-filter-card' }));
    }

    // ---- data ------------------------------------------------------------------------
    var lastFilters = {};
    function load() {
      K.setHash('reports/' + kind, toQuery(kind, S));
      var f = toFilters(kind, S, api);
      lastFilters = K.deepCopy(f);
      U.clear(tiles);
      U.loadingInto(body);
      var method = kind === 'exports' ? 'listReportExports' : def.method;
      var size = kind === 'exports' ? PAGE_LOG : kind === 'margins' ? PAGE_MARGIN : PAGE;
      var args = kind === 'costs' ? f : Object.assign({}, f, { limit: size, offset: S.offset || 0 });
      return U.call(api, method, args).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { body.appendChild(U.errorState(api, r.error, load)); return; }
        if (kind === 'exports') drawLog(r.data || {}); else draw(r.data || {}, size);
      });
    }
    function tile(label, value, tone, onClick, active) { tiles.appendChild(U.kpi(label, value == null ? '—' : K.fmtNum(value, 0), tone || 'neutral', { onClick: onClick || null, active: !!active })); }
    function moneyTile(label, v, cur) { tiles.appendChild(U.kpi(label + ' (' + cur + ')', K.fmtNum(v, 2), 'neutral')); }
    function drawTiles(d) {
      var tt = d.totals || {};
      if (kind === 'transactions') {
        tile(t('k_count'), tt.count != null ? tt.count : d.total); tile(t('k_containers'), tt.containers); tile(t('k_open_returns'), tt.open_returns, 'warning');
      } else if (kind === 'containers') {
        tile(t('k_count'), tt.count != null ? tt.count : d.total); tile(t('k_open'), tt.open);
        tile(t('k_overdue'), tt.overdue, 'danger', function () { S.overdue = !S.overdue; S.offset = 0; drawForm(); load(); }, !!S.overdue);
        tile(t('k_due_3d'), tt.due_3d, 'warning');
      } else if (kind === 'trips') {
        tile(t('k_count'), tt.count != null ? tt.count : d.total);
        ['planned', 'dispatched', 'loaded', 'delivered'].forEach(function (s) { tile(K.lab('trip_status', s, api), (tt.by_status || {})[s] || 0); });
      } else if (kind === 'margins' || kind === 'costs') {
        var tb = d.totals_by_currency || {}, key = kind === 'margins' ? 'margin_expected' : 'confirmed';
        if (kind === 'margins') tile(t('k_count'), d.total);
        Object.keys(tb).sort().slice(0, 4).forEach(function (c) { moneyTile(t(kind === 'margins' ? 'k_margin_expected' : 'k_cost_confirmed'), tb[c][key], c); });
      }
    }
    function draw(d, size) {
      drawTiles(d);
      var items = def.items(d), total = kind === 'costs' ? items.length : d.total != null ? +d.total : items.length;
      if (!items.length) {
        body.appendChild(U.card(null, U.emptyState('search', t('rpt_empty_title'), t('rpt_empty_text'),
          [U.btn(t('clear'), 'btn-secondary', function () { ST[kind] = S = defaults(K, kind); ctx.includeFinance = false; drawForm(); load(); })])));
        return;
      }
      var cols = def.columns(ctx);
      body.appendChild(el('div', { class: 'rpt-result-head' }, [
        el('p', { class: 'rpt-count', text: t('results_n', { n: K.fmtNum(total, 0) }) }),
        K.exportBar({ api: api, def: def, ctx: ctx, total: total, getFilters: function () { return lastFilters; } })
      ]));
      body.appendChild(U.card(null, K.reportTable(cols, items, def.totalsRows(d, ctx), ctx, { caption: def.title(ctx), rowId: def.rowId }), null, { flush: true, sub: def.title(ctx) }));
      if (kind !== 'costs') {
        var pg = K.pager(total, size, S.offset || 0, function (o) { S.offset = o; load(); });
        if (pg) body.appendChild(pg);
      }
    }
    function drawLog(d) {
      var items = U.rowsOf(d), total = d.total != null ? +d.total : items.length;
      if (!items.length) { body.appendChild(U.card(null, U.emptyState('file', t('log_empty_title'), t('log_empty_text')))); return; }
      if (!auditRead) body.appendChild(U.alertBox('info', t('log_own_only')));
      body.appendChild(el('p', { class: 'rpt-count', text: t('results_n', { n: K.fmtNum(total, 0) }) }));
      body.appendChild(U.card(null, U.table([t('c_created_at'), t('c_actor'), t('c_report'), t('c_format'), { label: t('c_rows'), num: true }, t('c_filters')],
        items.map(function (x) {
          var fl = x.filters && typeof x.filters === 'object' ? Object.keys(x.filters).map(function (k) { var v = x.filters[k]; return k + '=' + (Array.isArray(v) ? v.join(',') : String(v)); }).join(' · ') : '';
          return el('tr', { 'data-id': x.id }, [
            U.td(el('span', { class: 'is-nowrap', text: K.riyadhDateTime(x.created_at) })),
            U.td(x.actor_name || (api && typeof api.who === 'function' ? api.who(x.actor) : String(x.actor || '').slice(0, 8))),
            U.td(K.lab('report_kind', x.report)), U.td(K.lab('export_format', x.format)),
            U.td(U.ltr(K.fmtNum(x.row_count, 0)), 'num'),
            U.td(fl ? el('bdi', { dir: 'ltr', class: 'rpt-filters-text', text: fl }) : '—')
          ]);
        }), { caption: t('tab_exports') }), null, { flush: true }));
      var pg = K.pager(total, PAGE_LOG, S.offset || 0, function (o) { S.offset = o; load(); });
      if (pg) body.appendChild(pg);
    }

    U.loadingInto(body);
    return lookups().then(function () {
      if (!sc.alive()) return;
      // a hash query (or the remembered state) may name a branch / client / carrier the form cannot show
      if (typeof K.dropUnknownIds === 'function') K.dropUnknownIds(S, api, ctx);
      drawForm();
      if (!def && kind !== 'exports') return;
      return load();
    });
  }

  Ops.views.reports = {
    allow: 'staff', titleKey: 'rpt.nav_reports', icon: 'report',
    render: function (root, api, param) { return render(root, api, param); },
    _state: function () { return ST; }, _reset: function () { ST = {}; LAST_TAB = 'transactions'; }   // test hooks
  };
})();
