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
   Legacy step 8 (docs/online/LEGACY_REPORTS_AR.md): movements «المواعيد والنقل» (report_movements, the legacy filters
   and totals, 19-column file; value / revenue only for trip finance), payments «كشف السدادات» (report_payments, finance
   readers), trips by carrier / by driver summaries + driver / party / q filters, and the Excel-style column filters of
   rpt/colfilter.js on every table (the file keeps the same rows: MarsaExport rowFilter).
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var PAGE = 100, PAGE_MARGIN = 100, PAGE_LOG = 50;
  var TABS = ['transactions', 'containers', 'trips', 'movements', 'payments', 'margins', 'costs', 'exports'];
  var FIN_TABS = { margins: 1, costs: 1 };
  var FIN_READ_TABS = { margins: 1, costs: 1, payments: 1 };   // finance readers only (payments: owner decision 2026-11-11 (5))
  var MV_DATE_FIELDS = ['appointment', 'return_deadline', 'returned', 'delivered', 'created', 'updated'];
  var MV_SORTS = ['appointment_desc', 'appointment_asc', 'deadline_asc', 'updated_desc'];
  var MV_STATUSES = ['registered', 'incomplete', 'delivered', 'cancelled'];
  var PARTY_TYPES = ['supplier', 'company', 'direct'];
  var RETURN_SCOPES = ['overdue', 'pending', 'returned'];
  var PORT_CODES = ['SAJED', 'SADMM', 'SAKAC', 'SARUH', 'SAJED-AIR', 'SADMM-AIR', 'SARUH-AIR'];
  var PAY_SORTS = ['paid_desc', 'paid_asc', 'amount_desc', 'created_desc'];
  var PAY_MOVEMENTS = ['org_paid', 'received_from_client', 'client_direct'];
  var PAY_SOURCES = ['org_account', 'cash_box', 'fasah_wallet', 'dry_port_wallet_org', 'client_custody', 'client_custody_dry_port', 'personal_account', 'client_direct', 'not_applicable_receipt'];
  var PAY_METHODS = ['sadad', 'mada', 'fasah_wallet', 'dry_port_wallet', 'bank_transfer', 'cash', 'cheque', 'other'];
  var PAY_REVIEW = ['draft', 'pending', 'approved', 'rejected'];
  var TRIP_FIN = ['accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'];
  var AUDIT = ['admin', 'supervisor'];
  var TX_DATE_FIELDS = ['created', 'eta', 'declaration', 'status_changed'];
  var CT_DATE_FIELDS = ['created', 'return_deadline', 'returned_at', 'gate_out'];
  var REPORT_KINDS = ['search', 'transactions', 'containers', 'trips', 'margins', 'costs', 'movements', 'payments', 'tx_followup', 'fasah_recon'];
  var TX_SORTS = ['created_desc', 'created_asc', 'ref', 'eta', 'status_changed_desc'];

  // per tab: filter schema (query type), defaults (last 30 days), the date keys
  var SCHEMA = {
    transactions: { q: 'text', declaration_no: 'text', bl_number: 'text', container_no: 'text', client_id: 'uuid', client_q: 'text', carrier_id: 'uuid', carrier_q: 'text',
      port: 'text', date_field: 'code', from: 'day', to: 'day', branch_id: 'uuid', operational_status: 'codes', sort: 'code' },
    containers: { branch_id: 'uuid', client_id: 'uuid', container_no: 'text', date_field: 'code', from: 'day', to: 'day', return_status: 'codes', operational_state: 'codes', overdue: 'bool', sort: 'code' },
    trips: { branch_id: 'uuid', client_id: 'uuid', carrier_id: 'uuid', status: 'codes', from: 'day', to: 'day', late: 'bool', include_finance: 'bool', sort: 'code',
      driver_q: 'text', party_type: 'code', party_q: 'text', q: 'text' },
    movements: { q: 'text', branch_id: 'uuid', client_id: 'uuid', client_q: 'text', driver_q: 'text', truck_q: 'text', carrier_id: 'uuid', party_type: 'code', party_q: 'text',
      movement_status: 'codes', bl_number: 'text', declaration_no: 'text', container_no: 'text', port_code: 'pcode', return_scope: 'code', destination_q: 'text',
      booking_q: 'text', operator_q: 'text', employee_id: 'uuid', return_status: 'codes', date_field: 'code', from: 'day', to: 'day', value_min: 'num', value_max: 'num', revenue_min: 'num', revenue_max: 'num', sort: 'code' },
    payments: { q: 'text', branch_id: 'uuid', client_id: 'uuid', client_q: 'text', service_code: 'text', funding_source: 'codes', method: 'codes', review_status: 'codes',
      movement_type: 'codes', status: 'code', date_field: 'code', from: 'day', to: 'day', sort: 'code' },
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
    if (kind === 'movements') base.date_field = 'appointment';
    if (kind === 'payments') { base.date_field = 'paid'; base.status = 'recorded'; }
    if (kind === 'costs') { base.group_by = 'transaction'; base.include_overhead = true; }
    return base;
  }
  var ST = {};          // per-tab state, survives navigation
  var CF_STATE = {};    // per-tab column filters (legacy step 8), survive a reload of the same tab
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
    if ((kind === 'transactions' || kind === 'containers' || kind === 'movements' || kind === 'payments') && !f.from && !f.to) delete f.date_field;
    // amount bounds travel as numbers; without trip finance they are never sent (the server would answer MRS_FORBIDDEN cost)
    ['value_min', 'value_max', 'revenue_min', 'revenue_max'].forEach(function (k) { if (f[k] != null) { if (kind !== 'movements' || !(api && api.__tripFin)) delete f[k]; else f[k] = +f[k]; } });
    if (kind === 'payments' && f.status === 'recorded') delete f.status;   // the server default
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
    var allowed = TABS.filter(function (k) { return !FIN_READ_TABS[k] || finRead; });
    // the movements tab needs the step-8 reader; an older data layer hides it (and payments) instead of failing
    allowed = allowed.filter(function (k) { return (k !== 'movements' || K.hasFn(api, 'reportMovements')) && (k !== 'payments' || K.hasFn(api, 'reportPayments')); });
    if (api) api.__tripFin = tripFin;
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
    var ctx = { finRead: finRead, includeFinance: kind === 'trips' && !!S.include_finance && tripFin, groupBy: S.group_by, clients: [], carriers: [], finance: kind === 'movements' && tripFin };
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
        kind === 'transactions' || kind === 'trips' || kind === 'movements' ? U.call(api, 'listParties', { kind: 'carrier', limit: 500 }) : null,
        // legacy applyMovementFilters_ filters.employee: the org's staff members (never client-portal users)
        kind === 'movements' && api && api.MarsaApi && typeof api.MarsaApi.listMemberships === 'function' ? U.call(api, 'listMemberships', api && api.orgId) : null
      ]).then(function (res) {
        ctx.clients = res[0] && !res[0].error ? U.rowsOf(res[0].data) : [];
        ctx.carriers = res[1] && !res[1].error ? U.rowsOf(res[1].data) : [];
        var seenM = {};
        ctx.members = res[2] && !res[2].error ? U.rowsOf(res[2].data).filter(function (m) {
          if (!m || !m.user_id || seenM[m.user_id] || m.role === 'client') return false; seenM[m.user_id] = 1; return true;
        }).map(function (m) { return { id: m.user_id, name: (m.profiles && m.profiles.full_name) || String(m.user_id).slice(0, 8) }; }) : [];
        // an employee id that is not a member of this org (stale / another org's) is dropped, never sent
        if (kind === 'movements' && S.employee_id && res[2] && !res[2].error && !ctx.members.some(function (m) { return m.id === S.employee_id; })) S.employee_id = '';
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
        F.push(K.field(K.lt('f_driver_q'), K.input('driver_q', S.driver_q)),
          K.field(K.lt('f_party_type'), K.select('party_type', [['', t('all')]].concat(opt(PARTY_TYPES, function (c) { return K.lt('party_type_' + c); })), S.party_type)),
          K.field(K.lt('f_party_q'), K.input('party_q', S.party_q)),
          K.field(t('f_q'), K.input('q', S.q, { placeholder: K.lt('f_q_trips_ph') }), 'is-wide'));
        var late = el('input', { type: 'checkbox', name: 'late' }); late.checked = !!S.late;
        extra.push(el('label', { class: 'ops-inline-check rpt-check' }, [late, el('span', { text: t('f_late') })]),
          el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: t('f_trip_status') }),
          K.checks('status', opt(K.TRIP_STATUSES, function (c) { return K.lab('trip_status', c, api); }), [].concat(S.status || []))]));
        if (tripFin) {
          var fin = el('input', { type: 'checkbox', name: 'include_finance', class: 'rpt-include-finance' }); fin.checked = !!S.include_finance;
          extra.push(el('label', { class: 'ops-inline-check rpt-check' }, [fin, el('span', { text: t('f_include_finance') })]));
        }
      } else if (kind === 'movements') {
        F.push(K.field(t('f_q'), K.input('q', S.q, { placeholder: K.lt('f_q_mv_ph') }), 'is-wide'),
          K.field(t('f_client'), K.select('client_id', cl, S.client_id)),
          K.field(t('f_client_q'), K.input('client_q', S.client_q)),
          K.field(K.lt('f_driver_q'), K.input('driver_q', S.driver_q)),
          K.field(K.lt('f_truck_q'), K.input('truck_q', S.truck_q, { ltr: true })),
          K.field(t('f_carrier'), K.select('carrier_id', ca, S.carrier_id)),
          K.field(K.lt('f_party_type'), K.select('party_type', [['', t('all')]].concat(opt(PARTY_TYPES, function (c) { return K.lt('party_type_' + c); })), S.party_type)),
          K.field(K.lt('f_party_q'), K.input('party_q', S.party_q)),
          K.field(t('f_container_no'), K.input('container_no', S.container_no, { ltr: true })),
          K.field(t('f_declaration_no'), K.input('declaration_no', S.declaration_no, { ltr: true })),
          K.field(t('f_bl_number'), K.input('bl_number', S.bl_number, { ltr: true })),
          K.field(K.lt('f_port_code'), K.select('port_code', [['', t('all')]].concat(opt(PORT_CODES, function (c) { return K.lt('port_' + c.replace('-', '_')); })), S.port_code)),
          K.field(K.lt('f_destination_q'), K.input('destination_q', S.destination_q)),
          K.field(K.lt('f_booking_q'), K.input('booking_q', S.booking_q, { ltr: true })),
          K.field(K.lt('f_operator_q'), K.input('operator_q', S.operator_q)),
          K.field(K.lt('f_employee'), K.select('employee_id', [['', t('all')]].concat((ctx.members || []).map(function (m) { return [m.id, m.name]; })), S.employee_id)),
          K.field(K.lt('f_return_scope'), K.select('return_scope', [['', t('all')]].concat(opt(RETURN_SCOPES, function (c) { return K.famLab('return_scope', 'lrpt', 'return_scope', c); })), S.return_scope)),
          K.field(t('f_date_field'), K.select('date_field', opt(MV_DATE_FIELDS, function (c) { return K.famLab('movement_date_field', 'lrpt', 'movement_date_field', c); }), S.date_field || 'appointment')),
          K.field(t('f_sort'), K.select('sort', [['', K.lt('sort_appointment_desc')]].concat(opt(MV_SORTS.slice(1), function (c) { return K.lt('sort_' + c); })), S.sort)));
        if (tripFin) F.push(K.field(K.lt('f_value_min'), K.input('value_min', S.value_min, { ltr: true, inputmode: 'decimal', max: 15 })),
          K.field(K.lt('f_value_max'), K.input('value_max', S.value_max, { ltr: true, inputmode: 'decimal', max: 15 })),
          K.field(K.lt('f_revenue_min'), K.input('revenue_min', S.revenue_min, { ltr: true, inputmode: 'decimal', max: 15 })),
          K.field(K.lt('f_revenue_max'), K.input('revenue_max', S.revenue_max, { ltr: true, inputmode: 'decimal', max: 15 })));
        extra.push(el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: K.lt('f_movement_status') }),
          K.checks('movement_status', opt(MV_STATUSES, function (c) { return K.lab('movement_status', c, api); }), [].concat(S.movement_status || []))]),
          // legacy filters.emptyReturnStatus
          el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: t('f_return_status') }),
            K.checks('return_status', opt(K.RETURN_STATUSES, function (c) { return K.lab('container_return_status', c, api); }), [].concat(S.return_status || []))]));
      } else if (kind === 'payments') {
        var famOpts = function (list, dom, fam) { return opt(list, function (c) { return K.famLab(dom, 'pay', fam, c); }); };
        F.push(K.field(t('f_q'), K.input('q', S.q, { placeholder: K.lt('f_q_pay_ph') }), 'is-wide'),
          K.field(t('f_client'), K.select('client_id', cl, S.client_id)),
          K.field(t('f_client_q'), K.input('client_q', S.client_q)),
          K.field(K.lt('f_service'), K.input('service_code', S.service_code, { ltr: true, placeholder: K.lt('f_service_ph') })),
          K.field(K.lt('f_pay_status'), K.select('status', [['recorded', K.famLab('pay_status', 'pay', 'status', 'recorded')], ['void', K.famLab('pay_status', 'pay', 'status', 'void')], ['all', t('all')]], S.status || 'recorded')),
          K.field(t('f_date_field'), K.select('date_field', opt(['paid', 'created'], function (c) { return K.famLab('payment_date_field', 'lrpt', 'payment_date_field', c); }), S.date_field || 'paid')),
          K.field(t('f_sort'), K.select('sort', [['', K.lt('sort_paid_desc')]].concat(opt(PAY_SORTS.slice(1), function (c) { return K.lt('sort_' + c); })), S.sort)));
        extra.push(
          el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: K.lt('f_movement_type') }), K.checks('movement_type', famOpts(PAY_MOVEMENTS, 'pay_movement_type', 'mt'), [].concat(S.movement_type || []))]),
          el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: K.lt('f_funding_source') }), K.checks('funding_source', famOpts(PAY_SOURCES, 'pay_funding_source', 'source'), [].concat(S.funding_source || []))]),
          el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: K.lt('f_method') }), K.checks('method', famOpts(PAY_METHODS, 'pay_method', 'method'), [].concat(S.method || []))]),
          el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: K.lt('f_review_status') }), K.checks('review_status', famOpts(PAY_REVIEW, 'pay_review_status', 'review'), [].concat(S.review_status || []))]));
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
          s[k] = type === 'bool' ? !!c.checked : type === 'text' ? String(c.value || '').trim().slice(0, 80) : type === 'num' ? K.Q.num(c.value) : type === 'pcode' ? K.Q.pcode(c.value) : c.value;
        });
        // a typed amount that is not a number is shown as an error instead of being dropped silently
        var badNum = ['value_min', 'value_max', 'revenue_min', 'revenue_max'].filter(function (k) { var c = E[k]; return c && String(c.value || '').trim() && !s[k]; })[0];
        var badRange = (s.value_min && s.value_max && +s.value_min > +s.value_max) || (s.revenue_min && s.revenue_max && +s.revenue_min > +s.revenue_max);
        if (kind === 'transactions' && s.sort === 'created_desc') s.sort = '';   // the server default; keeps the hash short
        var msg = badNum ? K.lt('err_amount') : badRange ? K.lt('err_amount_range') : s.q && s.q.length < 2 ? t('err_q_short') : s.from && s.to && s.from > s.to ? t('err_range') :
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
      } else if (kind === 'movements') {
        tile(K.lt('k_mv_count'), tt.count != null ? tt.count : d.total);
        tile(K.lt('k_mv_appointments'), tt.appointments);
        tile(K.lt('k_mv_cancelled'), tt.cancelled, 'warning');
        tile(K.lt('k_mv_delivered'), tt.delivered_containers);
        tile(K.lt('k_mv_overdue'), tt.overdue_returns, 'danger', function () { S.return_scope = S.return_scope === 'overdue' ? '' : 'overdue'; S.offset = 0; drawForm(); load(); }, S.return_scope === 'overdue');
        if (ctx.finance) {
          Object.keys(tt.transport_value || {}).sort().slice(0, 3).forEach(function (c) { moneyTile(K.lt('k_mv_value'), tt.transport_value[c], c); });
          Object.keys(tt.revenue || {}).sort().slice(0, 3).forEach(function (c) { moneyTile(K.lt('k_mv_revenue'), tt.revenue[c], c); });
        }
      } else if (kind === 'payments') {
        tile(K.lt('k_pay_count'), tt.count != null ? tt.count : d.total);
        Object.keys(tt.paid || {}).sort().slice(0, 4).forEach(function (c) { moneyTile(K.lt('k_pay_paid'), tt.paid[c], c); });
        tile(K.famLab('pay_review_status', 'pay', 'review', 'pending'), (tt.by_review_status || {}).pending || 0, 'warning');
      } else if (kind === 'margins' || kind === 'costs') {
        var tb = d.totals_by_currency || {}, key = kind === 'margins' ? 'margin_expected' : 'confirmed';
        if (kind === 'margins') tile(t('k_count'), d.total);
        Object.keys(tb).sort().slice(0, 4).forEach(function (c) { moneyTile(t(kind === 'margins' ? 'k_margin_expected' : 'k_cost_confirmed'), tb[c][key], c); });
      }
    }
    function draw(d, size) {
      if (kind === 'movements') ctx.finance = tripFin && d.finance !== false;
      drawTiles(d);
      var items = def.items(d), total = kind === 'costs' ? items.length : d.total != null ? +d.total : items.length;
      if (!items.length) {
        body.appendChild(U.card(null, U.emptyState('search', t('rpt_empty_title'), t('rpt_empty_text'),
          [U.btn(t('clear'), 'btn-secondary', function () { ST[kind] = S = defaults(K, kind); ctx.includeFinance = false; drawForm(); load(); })])));
        return;
      }
      var cols = def.columns(ctx);
      // legacy step 8: Excel-style column filters over the loaded page (rpt/colfilter.js); the file keeps the same rows
      var CFm = window.MarsaColFilter, cf = null;
      if (CFm && kind !== 'costs') {
        var prev = CF_STATE[kind] || null;
        cf = CFm.create({ id: 'rpt-' + kind, columns: cols.map(function (c) { return { key: c.key, label: c.label, type: c.type, value: function (x) { return c.value ? c.value(x, ctx) : x[c.key]; } }; }),
          onChange: function () { CF_STATE[kind] = cf.state(); paintTable(); } });
        cf.setRows(items);
        if (prev) cf.setState(prev).setRows(items);
      }
      var countP = el('p', { class: 'rpt-count', 'aria-live': 'polite' }), tableBox = el('div');
      var clearCf = el('button', { type: 'button', class: 'btn btn-sm btn-ghost rpt-cf-clear', text: K.lt('cf_clear_all'), hidden: true });
      clearCf.addEventListener('click', function (e) { e.preventDefault(); if (cf) cf.clearAll(); });
      body.appendChild(el('div', { class: 'rpt-result-head' }, [
        el('div', { class: 'rpt-count-box' }, [countP, clearCf]),
        K.exportBar({ api: api, def: def, ctx: ctx, total: total, getFilters: function () { return lastFilters; },
          getRowFilter: function () { return cf && cf.active() ? cf.apply : null; },
          getCriteria: function () { return cf && cf.active() ? cf.describe().map(function (p) { return [K.lt('cf_crit', { c: p[0] }), p[1]]; }) : null; } })
      ]));
      body.appendChild(tableBox);
      function paintTable() {
        U.clear(tableBox);
        var shown = cf ? cf.apply(items) : items, on = cf ? cf.active() : 0;
        countP.textContent = on ? K.lt('cf_shown', { n: K.fmtNum(shown.length, 0), m: K.fmtNum(items.length, 0), total: K.fmtNum(total, 0) }) : t('results_n', { n: K.fmtNum(total, 0) });
        clearCf.hidden = !on;
        tableBox.appendChild(U.card(null, K.reportTable(cols, shown, on ? [] : def.totalsRows(d, ctx), ctx, { caption: def.title(ctx), rowId: def.rowId,
          thExtra: cf ? function (c) { return cf.button(c.key); } : null }), null, { flush: true, sub: def.title(ctx) }));
      }
      paintTable();
      if (kind === 'trips') drawGroups(d);
      if (kind !== 'costs') {
        var pg = K.pager(total, size, S.offset || 0, function (o) { S.offset = o; load(); });
        if (pg) body.appendChild(pg);
      }
    }
    // trips grouped by carrier / party and by driver (legacy getTransportReportR12 / r12RenderReport)
    function drawGroups(d) {
      var tt = d.totals || {}, fin = ctx.includeFinance;
      function valueText(m) { var o = m || {}; var k = Object.keys(o).sort(); return k.length ? k.map(function (c) { return K.fmtNum(o[c], 2) + ' ' + c; }).join(' · ') : '—'; }
      var byC = Array.isArray(tt.by_carrier) ? tt.by_carrier : [], byD = Array.isArray(tt.by_driver) ? tt.by_driver : [];
      if (!byC.length && !byD.length) return;
      var grid = el('div', { class: 'lrpt-groups' });
      if (byC.length) grid.appendChild(U.card(K.lt('grp_by_carrier'), U.table([K.lt('c_party'), K.lt('c_party_type'), { label: K.lt('c_trips'), num: true }].concat(fin ? [{ label: K.lt('c_transport_value'), num: true }] : []),
        byC.map(function (g) {
          return el('tr', null, [U.td(g.party_name || '—'), U.td(g.party_type ? K.lt('party_type_' + g.party_type) : '—'), U.td(U.ltr(K.fmtNum(g.trips, 0)), 'num')]
            .concat(fin ? [U.td(U.ltr(valueText(g.value_by_currency)), 'num')] : []));
        }), { caption: K.lt('grp_by_carrier') }), null, { flush: true, cls: 'lrpt-group-card' }));
      if (byD.length) grid.appendChild(U.card(K.lt('grp_by_driver'), U.table([K.lt('c_driver'), { label: K.lt('c_trips'), num: true }].concat(fin ? [{ label: K.lt('c_transport_value'), num: true }] : []),
        byD.map(function (g) {
          return el('tr', null, [U.td(g.driver_name || K.lt('no_driver')), U.td(U.ltr(K.fmtNum(g.trips, 0)), 'num')].concat(fin ? [U.td(U.ltr(valueText(g.value_by_currency)), 'num')] : []));
        }), { caption: K.lt('grp_by_driver') }), null, { flush: true, cls: 'lrpt-group-card' }));
      body.appendChild(grid);
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
    _state: function () { return ST; }, _reset: function () { ST = {}; CF_STATE = {}; LAST_TAB = 'transactions'; }   // test hooks
  };
})();
