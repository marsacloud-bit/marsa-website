/* ==========================================================================
   مرسى | MARSA — legacy step 8: transactions register + follow-up  →  #register (MarsaOps.views.register)
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_REPORTS_AR.md §2–§3 (report_transactions / tx_attention, 20261124000100).
   Legacy: الرمز.js listTransactions / applyTransactionFilters_ (23-field search), Index.html renderTransactionsR12120,
   transactionQuickFiltersR12120, TRANSACTION_ATTENTION_RULES_R12120, buildTransactionsExportSheet_.

   * Filters (server, report_transactions keys): q (the 23 legacy fields), client / client code / category, port code,
     declaration stage(s), operational status(es), vessel, operator, agent, employee, unit-count range, unit type,
     transaction type, Daftra state (finance readers only), attention, date field + range, branch, sort.
     A hash query (#register?status=…, ?stage=…, ?daftra_state=draft, ?attention=any — the dashboard tiles and
     admin.js' #transactions?… redirect) replaces the filters once; the filters then live in the hash.
   * Quick filters «المتأخرة فقط» (attention any), «الحرجة فقط», «مسودات دفترة فقط» (finRead), re-export, Ro-Ro.
   * Attention banner: tx_attention totals of the SAME filters (critical / warning by reason) + the «المتأخرة فقط» toggle.
   * Table: stage row tones, the attention badge, a container tooltip (≤ 50 numbers), the Daftra state column for
     finance readers only (owner decision 2026-11-11 (5)), Excel-style column filters (rpt/colfilter.js) on the page.
   * Export: the 14-column follow-up file (MarsaExport defs.tx_followup) — XLSX / CSV / print A4 landscape, audited by
     logReportExport, exactly the filtered rows (server filters + the column filters), attention tones on the status cell.
   * Read only. Strings: 'lrpt' (assets/i18n/lrpt.js). Data → textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var PAGE = 200;
  var DECL = ['draft', 'submitted', 'accepted', 'under_inspection', 'cco_review_done', 'awaiting_duty_payment', 'release_ready', 'released', 'cancelled', 'replaced'];
  var STAGE_TONE = { draft: 'neutral', submitted: 'info', accepted: 'info', under_inspection: 'warning', cco_review_done: 'info', awaiting_duty_payment: 'warning',
    release_ready: 'brand', released: 'success', cancelled: 'neutral', replaced: 'neutral' };
  var DATE_FIELDS = ['created', 'eta', 'declaration', 'status_changed', 'updated'];
  var SORTS = ['created_desc', 'created_asc', 'ref', 'ref_desc', 'eta', 'status_changed_desc', 'declaration_date_desc', 'declaration_date_asc', 'updated_desc'];
  var PORTS = ['SAJED', 'SADMM', 'SAKAC', 'SARUH', 'SAJED-AIR', 'SADMM-AIR', 'SARUH-AIR'];
  var CATEGORIES = ['airport', 'port', 'shared'];
  var DAFTRA_STATES = ['none', 'draft', 'issued', 'cancelled_review'];
  var ATTENTION = ['any', 'warning', 'critical'];
  var SCHEMA = {
    q: 'text', declaration_no: 'text', bl_number: 'text', container_no: 'text', client_id: 'uuid', client_q: 'text', client_code: 'text', client_category: 'code',
    port_code: 'pcode', declaration_status: 'codes', operational_status: 'codes', vessel: 'text', operator_q: 'text', agent_q: 'text', employee_id: 'uuid',
    containers_min: 'count', containers_max: 'count', cargo_unit_type: 'code', transaction_type: 'code', daftra_state: 'code', attention: 'code',
    date_field: 'code', from: 'day', to: 'day', branch_id: 'uuid', sort: 'code'
  };
  // the dashboard tiles / admin.js redirect speak status / stage / daftra / branchId
  var ALIAS = { status: 'operational_status', stage: 'declaration_status', daftra: 'daftra_state', branchId: 'branch_id' };
  var ST = null, CF_STATE = null, ST_ORG = null;   // the filters belong to the org they were set in (ST_ORG)

  function count(v) { var s = String(v == null ? '' : v).trim(); return /^\d{1,4}$/.test(s) ? s : ''; }
  function fromQuery(K, q) {
    var s = {}, any = false;
    Object.keys(q || {}).forEach(function (k0) {
      var k = ALIAS[k0] || k0, type = SCHEMA[k], v = q[k0];
      if (!type) return;
      v = Array.isArray(v) ? v.join(',') : v;
      var val = type === 'count' ? count(v) : K.Q[type](v);
      if (type === 'codes' ? val.length : val !== '') { s[k] = val; any = true; }
    });
    if (q && q.offset) s.offset = K.Q.int(q.offset);
    return any ? s : null;
  }
  function toQuery(S) {
    var o = {};
    Object.keys(SCHEMA).forEach(function (k) {
      var v = S[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      o[k === 'operational_status' ? 'status' : k === 'declaration_status' ? 'stage' : k] = v;
    });
    if (S.offset) o.offset = S.offset;
    return o;
  }
  function toFilters(S, finRead) {
    var f = {};
    Object.keys(SCHEMA).forEach(function (k) {
      var v = S[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      if (SCHEMA[k] === 'text') { v = String(v).trim(); if (!v) return; }
      if (SCHEMA[k] === 'count') v = +v;
      f[k] = Array.isArray(v) && v.length === 1 ? v[0] : v;
    });
    if (!finRead) delete f.daftra_state;           // a finance-only filter (it would match nothing for others)
    if (!f.from && !f.to) delete f.date_field;
    if (f.sort === 'created_desc') delete f.sort;  // the server default
    return f;
  }
  function validate(K, S) {
    if (S.q && S.q.length < 2) return K.t('err_q_short');
    if (S.from && S.to && S.from > S.to) return K.t('err_range');
    if (S.containers_min !== '' && S.containers_min != null && S.containers_max !== '' && S.containers_max != null && +S.containers_min > +S.containers_max) return K.lt('err_containers_range');
    return null;
  }

  function render(root, api) {
    var U = Ops.ui, K = window.MarsaExport && window.MarsaExport.kit && window.MarsaExport.kit();
    if (!U || !K) { while (root.firstChild) root.removeChild(root.firstChild); var d0 = document.createElement('div'); d0.className = 'alert alert-danger'; d0.setAttribute('role', 'alert'); d0.textContent = 'MarsaOps.ui / MarsaExport missing'; root.appendChild(d0); return; }
    K.use(api);
    var lt = K.lt, t = K.t, el = U.el, sc = U.scope(root);
    var finRead = U.can(api, 'finRead');
    var q = typeof api.hashQuery === 'function' ? api.hashQuery() : {};
    if (ST_ORG !== (api && api.orgId)) { ST = null; CF_STATE = null; ST_ORG = api && api.orgId; }
    var fromHash = fromQuery(K, q);
    if (fromHash) { ST = Object.assign({ offset: 0 }, fromHash); CF_STATE = null; }
    if (!ST) ST = { offset: 0 };
    var S = ST;
    var ctx = { finRead: finRead, clients: [], members: [] };

    U.clear(root);
    root.classList.add('ops-view', 'rpt-view', 'lrpt-register');
    root.appendChild(U.head(lt('reg_title'), lt('reg_sub'), [el('a', { class: 'btn btn-sm btn-ghost', href: '#attention_rules', text: lt('rules_link') })]));
    if (!K.hasFn(api, 'reportTransactions')) { root.appendChild(U.alertBox('warning', t('api_missing', { fn: 'reportTransactions' }))); return; }
    var bannerBox = el('div', { class: 'lrpt-banner-box', 'aria-live': 'polite' });
    var quickBox = el('div', { class: 'lrpt-quick', role: 'group', 'aria-label': lt('quick_label') });
    var formBox = el('div'), body = el('div', { class: 'app-stack rpt-results' });
    root.appendChild(bannerBox); root.appendChild(quickBox); root.appendChild(formBox); root.appendChild(body);

    function nameOf(x) { return (K.isEn() && x.name_en) || x.name_ar || x.name_en || String(x.id).slice(0, 8); }
    function lookups() {
      var M = api && api.MarsaApi;
      return Promise.all([
        U.call(api, 'listClients', { orgId: api && api.orgId, limit: 500 }),
        M && typeof M.listMemberships === 'function' ? U.call(api, 'listMemberships', api && api.orgId) : null
      ]).then(function (res) {
        ctx.clients = res[0] && !res[0].error ? U.rowsOf(res[0].data) : [];
        var seen = {};
        ctx.members = res[1] && !res[1].error ? U.rowsOf(res[1].data).filter(function (m) {
          if (!m || !m.user_id || seen[m.user_id] || m.role === 'client') return false; seen[m.user_id] = 1; return true;
        }).map(function (m) { return { id: m.user_id, name: (m.profiles && m.profiles.full_name) || String(m.user_id).slice(0, 8) }; }) : [];
        // an id from the address / another org that this org's complete lists do not contain is dropped, never sent
        var clientsComplete = !!(res[0] && !res[0].error) && ctx.clients.length < 500;
        if (S.client_id && !ctx.clients.some(function (c) { return c.id === S.client_id; })) {
          if (clientsComplete) S.client_id = ''; else ctx.clients.push({ id: S.client_id, name_ar: String(S.client_id).slice(0, 8) });
        }
        if (S.employee_id && res[1] && !res[1].error && !ctx.members.some(function (m) { return m.id === S.employee_id; })) S.employee_id = '';
        if (S.branch_id && !(api.branches || []).some(function (b) { return b.id === S.branch_id; })) S.branch_id = '';
      });
    }

    /* ---- quick filters ---- */
    var QUICK = [
      { id: 'late', key: 'attention', value: 'any', label: 'q_late' },
      { id: 'critical', key: 'attention', value: 'critical', label: 'q_critical' },
      { id: 'daftra_draft', key: 'daftra_state', value: 'draft', label: 'q_daftra_draft', fin: true },
      { id: 're_export', key: 'transaction_type', value: 're_export', label: 'q_re_export' },
      { id: 'roro', key: 'cargo_unit_type', value: 'roro', label: 'q_roro' }
    ];
    function drawQuick() {
      U.clear(quickBox);
      var anyOn = QUICK.some(function (x) { return S[x.key] === x.value; });
      var all = el('button', { type: 'button', class: 'chip lrpt-chip' + (anyOn ? '' : ' is-active'), 'aria-pressed': String(!anyOn), 'data-quick': 'all', text: lt('q_all') });
      all.addEventListener('click', function (e) { e.preventDefault(); QUICK.forEach(function (x) { if (S[x.key] === x.value) S[x.key] = ''; }); S.offset = 0; drawAll(); });
      quickBox.appendChild(all);
      QUICK.filter(function (x) { return !x.fin || finRead; }).forEach(function (x) {
        var on = S[x.key] === x.value;
        var b = el('button', { type: 'button', class: 'chip lrpt-chip' + (on ? ' is-active' : ''), 'aria-pressed': String(on), 'data-quick': x.id, text: lt(x.label) });
        b.addEventListener('click', function (e) { e.preventDefault(); S[x.key] = on ? '' : x.value; S.offset = 0; drawAll(); });
        quickBox.appendChild(b);
      });
    }

    /* ---- advanced filters ---- */
    function opt(list, fn) { return list.map(function (c) { return [c, fn(c)]; }); }
    function drawForm() {
      U.clear(formBox);
      var F = [];
      var cl = [['', t('all')]].concat(ctx.clients.map(function (c) { return [c.id, nameOf(c)]; }));
      F.push(K.field(t('f_q'), K.input('q', S.q, { placeholder: lt('f_q_reg_ph') }), 'is-wide'),
        K.field(t('f_declaration_no'), K.input('declaration_no', S.declaration_no, { ltr: true })),
        K.field(t('f_bl_number'), K.input('bl_number', S.bl_number, { ltr: true })),
        K.field(t('f_container_no'), K.input('container_no', S.container_no, { ltr: true })),
        K.field(t('f_client'), K.select('client_id', cl, S.client_id)),
        K.field(t('f_client_q'), K.input('client_q', S.client_q)),
        K.field(lt('f_client_code'), K.input('client_code', S.client_code, { ltr: true })),
        K.field(lt('f_client_category'), K.select('client_category', [['', t('all')]].concat(opt(CATEGORIES, function (c) { return lt('cat_' + c); })), S.client_category)),
        K.field(lt('f_port_code'), K.select('port_code', [['', t('all')]].concat(opt(PORTS, function (c) { return lt('port_' + c.replace('-', '_')); })), S.port_code)),
        K.field(lt('f_vessel'), K.input('vessel', S.vessel)),
        K.field(lt('f_operator_q'), K.input('operator_q', S.operator_q)),
        K.field(lt('f_agent_q'), K.input('agent_q', S.agent_q)),
        K.field(lt('f_employee'), K.select('employee_id', [['', t('all')]].concat(ctx.members.map(function (m) { return [m.id, m.name]; })), S.employee_id)),
        K.field(lt('f_containers_min'), K.input('containers_min', S.containers_min, { ltr: true, inputmode: 'numeric', max: 4 })),
        K.field(lt('f_containers_max'), K.input('containers_max', S.containers_max, { ltr: true, inputmode: 'numeric', max: 4 })),
        K.field(lt('f_unit'), K.select('cargo_unit_type', [['', t('all')], ['container', K.lab('cargo_unit_type', 'container', api)], ['roro', K.lab('cargo_unit_type', 'roro', api)]], S.cargo_unit_type)),
        K.field(lt('f_tx_type'), K.select('transaction_type', [['', t('all')], ['normal', K.lab('transaction_type', 'normal', api)], ['re_export', K.lab('transaction_type', 're_export', api)]], S.transaction_type)));
      if (finRead) F.push(K.field(lt('f_daftra_state'), K.select('daftra_state', [['', t('all')]].concat(opt(DAFTRA_STATES, function (c) { return K.famLab('tx_daftra_state', 'lrpt', 'dft_state', c); })), S.daftra_state)));
      F.push(K.field(lt('f_attention'), K.select('attention', [['', t('all')]].concat(opt(ATTENTION, function (c) { return lt('att_filter_' + c); })), S.attention)),
        K.field(t('f_date_field'), K.select('date_field', opt(DATE_FIELDS, function (c) { return K.lab('search_date_field', c, api) !== c ? K.lab('search_date_field', c, api) : lt('sdf_' + c); }), S.date_field || 'created')),
        K.field(t('f_from'), K.input('from', S.from, { type: 'date' })),
        K.field(t('f_to'), K.input('to', S.to, { type: 'date' })),
        K.field(t('f_branch'), K.select('branch_id', K.branchOptions(api), S.branch_id)),
        K.field(t('f_sort'), K.select('sort', opt(SORTS, function (c) { return K.has('sort_' + c) ? t('sort_' + c) : lt('sort_' + c); }), S.sort || 'created_desc')));
      var form = el('form', { class: 'rpt-filters', novalidate: true, role: 'search', 'aria-label': lt('reg_title') });
      var err = el('p', { class: 'rpt-form-error', role: 'alert', hidden: true });
      form.appendChild(el('div', { class: 'rpt-grid' }, F));
      form.appendChild(el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: lt('f_declaration_status') }),
        K.checks('declaration_status', opt(DECL, function (c) { return K.lab('declaration_status', c, api); }), [].concat(S.declaration_status || []))]));
      form.appendChild(el('fieldset', { class: 'rpt-fieldset' }, [el('legend', { class: 'form-label', text: t('f_status') }),
        K.checks('operational_status', opt(K.STAGES, function (c) { return K.lab('operational_status', c, api); }), [].concat(S.operational_status || []))]));
      form.appendChild(err);
      var apply = el('button', { type: 'submit', class: 'btn btn-primary btn-sm rpt-go', text: t('apply') });
      var reset = el('button', { type: 'button', class: 'btn btn-subtle btn-sm rpt-clear', text: t('clear') });
      reset.addEventListener('click', function (e) { e.preventDefault(); ST = S = { offset: 0 }; CF_STATE = null; drawAll(); });
      form.appendChild(el('div', { class: 'rpt-form-actions' }, [apply, reset]));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var s = { offset: 0 }, E = form.elements;
        Object.keys(SCHEMA).forEach(function (k) {
          var type = SCHEMA[k];
          if (type === 'codes') { s[k] = K.checkedValues(form, k); return; }
          var c = E[k];
          if (!c) { if (S[k] != null) s[k] = S[k]; return; }
          var v = String(c.value || '').trim();
          s[k] = type === 'text' ? v.slice(0, 80) : type === 'count' ? count(v) : type === 'pcode' ? K.Q.pcode(v) : v;
        });
        var badCount = ['containers_min', 'containers_max'].filter(function (k) { var c = E[k]; return c && String(c.value || '').trim() && !s[k]; })[0];
        var msg = badCount ? lt('err_count') : validate(K, s);
        err.hidden = !msg; err.textContent = msg || '';
        if (msg) return;
        ST = S = s;
        drawQuick();
        load();
      });
      var open = ['client_code', 'client_category', 'port_code', 'vessel', 'operator_q', 'agent_q', 'employee_id', 'containers_min', 'containers_max', 'declaration_status', 'operational_status',
        'from', 'to', 'q', 'declaration_no', 'bl_number', 'container_no', 'client_id', 'client_q'].some(function (k) { var v = S[k]; return v != null && v !== '' && !(Array.isArray(v) && !v.length); });
      var det = el('details', { class: 'app-card ops-card lrpt-adv' }, [el('summary', { class: 'lrpt-adv-sum', text: lt('adv_filters') }), el('div', { class: 'app-card-body' }, form)]);
      det.open = !!open;
      formBox.appendChild(det);
    }

    /* ---- columns (screen) ---- */
    function stagePill(x) {
      if (!x.declaration_status) return el('span', { class: 'text-muted text-xs', text: lt('no_declaration') });
      return U.pill(STAGE_TONE[x.declaration_status] || 'neutral', K.lab('declaration_status', x.declaration_status, api));
    }
    function attentionNode(x) {
      var a = x.attention;
      if (!a || !a.level) return K.NONE;
      var reasons = (a.reasons || []).map(function (r) {
        var why = K.famLab('attention_reason', 'lrpt', 'att_reason', r.code);
        return r.container_no ? why + ' (' + r.container_no + ')' : why;
      });
      var tip = reasons.join(' · ');
      return el('span', { class: 'lrpt-att lrpt-att-' + a.level, title: tip || null }, [
        U.pill(a.level === 'critical' ? 'danger' : 'warning', K.attentionText(a)),
        tip ? el('span', { class: 'ops-sr', text: ' — ' + tip }) : null
      ]);
    }
    function containersNode(x) {
      var n = x.unit_count != null ? x.unit_count : x.container_count, list = (x.containers || []).map(K.ctrNo).filter(Boolean);
      var text = K.fmtNum(n == null ? 0 : n, 0);
      if (!list.length) return U.ltr(text);
      var tip = list.slice(0, 50).join('، ') + (list.length > 50 ? ' …' : '');
      return el('span', { class: 'lrpt-ctr', tabindex: '0', title: tip, 'aria-label': lt('ctr_tip', { n: text, list: tip }) }, [el('bdi', { dir: 'ltr', class: 'num', text: text }), el('span', { class: 'lrpt-ctr-dot', 'aria-hidden': 'true', text: 'ⓘ' })]);
    }
    function daftraNode(x) {
      var d = x.daftra;
      if (!d || !d.state) return K.NONE;
      var tone = { none: 'neutral', draft: 'info', issued: 'success', cancelled_review: 'danger' }[d.state] || 'neutral';
      return el('span', { class: 'lrpt-dft' }, [U.pill(tone, K.famLab('tx_daftra_state', 'lrpt', 'dft_state', d.state)), d.number ? el('bdi', { dir: 'ltr', class: 'cell-sub', text: d.number }) : null]);
    }
    function columns() {
      var cols = [
        { key: 'ref', label: lt('c_ref'), type: 'text', value: function (x) { return x.ref; }, cell: function (x) {
          return el('span', { class: 'lrpt-refcell' }, [K.txLinkCell(x.id, x.ref),
            x.cancelled_at ? U.pill('danger', K.lab('transaction_state', 'cancelled', api)) : null,
            x.transaction_type === 're_export' ? U.pill('warning', K.lab('transaction_type', 're_export', api)) : null,
            x.cargo_unit_type === 'roro' ? U.pill('info', 'Ro-Ro') : null]);
        } },
        { key: 'client', label: lt('c_importer'), type: 'text', value: K.clientName, cell: function (x) { return U.twoLine(K.clientName(x) || K.NONE, x.client_code ? lt('client_code_n', { c: x.client_code }) : null); } },
        { key: 'declaration_no', label: lt('c_declaration_no'), type: 'text', value: function (x) { return x.declaration_no; },
          cell: function (x) { return x.declaration_no ? U.twoLine(x.declaration_no, x.declaration_date ? K.riyadhDay(x.declaration_date) : null, true) : K.NONE; } },
        { key: 'declaration_date', label: lt('c_declaration_date'), type: 'date', value: function (x) { return x.declaration_date || null; }, hidden: true },
        { key: 'bl_number', label: lt('c_bl_number'), type: 'text', value: function (x) { return x.bl_number; }, cell: function (x) { return x.bl_number ? el('bdi', { dir: 'ltr', text: x.bl_number }) : K.NONE; } },
        { key: 'unit_count', label: lt('c_unit_count'), type: 'int', value: function (x) { var n = x.unit_count != null ? x.unit_count : x.container_count; return n == null ? null : +n; }, cell: containersNode },
        { key: 'port', label: lt('c_port'), type: 'text', value: function (x) { return K.portName(x) || x.port_of_discharge || ''; } },
        { key: 'operator_name', label: lt('c_operator'), type: 'text', value: function (x) { return x.operator_name; } },
        { key: 'agent_name', label: lt('c_agent'), type: 'text', value: function (x) { return x.agent_name || x.shipping_line; } },
        { key: 'vessel', label: lt('c_vessel'), type: 'text', value: function (x) { return x.vessel; } },
        { key: 'declaration_status', label: lt('c_stage'), type: 'text', value: function (x) { return x.declaration_status ? K.lab('declaration_status', x.declaration_status, api) : ''; }, cell: stagePill },
        { key: 'operational_status', label: lt('c_tx_status'), type: 'text', value: function (x) { return x.cancelled_at ? K.lab('transaction_state', 'cancelled', api) : K.lab('operational_status', x.operational_status, api); },
          cell: function (x) { return x.cancelled_at ? U.pill('danger', K.lab('transaction_state', 'cancelled', api)) : U.pill('brand', K.lab('operational_status', x.operational_status, api)); } },
        { key: 'attention', label: lt('c_attention'), type: 'text', value: function (x) { return x.attention && x.attention.level ? K.famLab('attention_level', 'lrpt', 'att_level', x.attention.level) : ''; }, cell: attentionNode }
      ];
      if (finRead) cols.push({ key: 'daftra', label: lt('c_daftra'), type: 'text', value: function (x) { return x.daftra && x.daftra.state ? K.famLab('tx_daftra_state', 'lrpt', 'dft_state', x.daftra.state) : ''; }, cell: daftraNode });
      cols.push(
        { key: 'employee_name', label: lt('c_employee'), type: 'text', value: function (x) { return x.employee_name; } },
        { key: 'updated_at', label: lt('c_updated_at'), type: 'datetime', value: function (x) { return x.updated_at || null; },
          cell: function (x) { return x.updated_at ? el('span', { class: 'is-nowrap', text: K.riyadhDateTime(x.updated_at) }) : K.NONE; } });
      return cols.filter(function (c) { return !c.hidden; });
    }
    function rowClass(x) {
      var c = 'lrpt-row' + (x.declaration_status ? ' lrpt-stage-' + x.declaration_status : '');
      if (x.attention && x.attention.level) c += ' lrpt-row-' + x.attention.level;
      if (x.cancelled_at) c += ' is-cancelled';
      return c;
    }

    /* ---- banner ---- */
    function drawBanner(r) {
      U.clear(bannerBox);
      if (!r || r.error || !r.data) return;
      var tt = r.data.totals || {}, c = +tt.critical || 0, w = +tt.warning || 0, br = tt.by_reason || {};
      var on = S.attention === 'any';
      var toggle = el('button', { type: 'button', class: 'btn btn-sm ' + (on ? 'btn-primary' : 'btn-secondary') + ' lrpt-late-toggle', 'aria-pressed': String(on), text: lt('q_late') });
      toggle.addEventListener('click', function (e) { e.preventDefault(); S.attention = on ? '' : 'any'; S.offset = 0; drawAll(); });
      if (!c && !w) {
        bannerBox.appendChild(el('div', { class: 'alert alert-success lrpt-banner', role: 'status' }, [el('div', { class: 'ops-alert-text', text: lt('banner_none') }), on ? toggle : null]));
        return;
      }
      var parts = Object.keys(br).filter(function (k) { return +br[k]; }).map(function (k) { return K.famLab('attention_reason', 'lrpt', 'att_reason', k) + ': ' + K.fmtNum(br[k], 0); });
      bannerBox.appendChild(el('div', { class: 'alert ' + (c ? 'alert-danger' : 'alert-warning') + ' lrpt-banner', role: 'status' }, [
        el('div', { class: 'ops-alert-text' }, [el('strong', { text: lt('banner_counts', { c: K.fmtNum(c, 0), w: K.fmtNum(w, 0) }) }),
          parts.length ? el('span', { class: 'lrpt-banner-why', text: ' — ' + parts.join(' · ') }) : null,
          r.data.truncated ? el('span', { class: 'lrpt-banner-why', text: ' ' + lt('banner_truncated') }) : null]),
        el('div', { class: 'ops-alert-actions' }, [toggle])
      ]));
    }

    /* ---- data ---- */
    var lastFilters = {};
    function load() {
      K.setHash('register', toQuery(S));
      var f = toFilters(S, finRead);
      lastFilters = K.deepCopy(f);
      U.loadingInto(body);
      var P = window.MarsaShell && window.MarsaShell.progress;
      var job = Promise.all([
        U.call(api, 'reportTransactions', Object.assign({}, f, { limit: PAGE, offset: S.offset || 0 })),
        K.hasFn(api, 'txAttention') ? U.call(api, 'txAttention', f) : null
      ]);
      var wait = P && typeof P.track === 'function' ? P.track('register', job, { label: lt('loading_register') }) : job;
      return wait.then(function (res) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        drawBanner(res && res[1]);
        var r = res && res[0];
        if (!r) return;   // cancelled: the page stays as it was
        if (r.error) { body.appendChild(U.errorState(api, r.error, load)); return; }
        draw(r.data || {});
      }, function (e) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (e && e.cancelled) { body.appendChild(U.alertBox('info', lt('cancelled_load'), [U.btn(U.t('retry'), 'btn-secondary', load)])); return; }
        body.appendChild(U.errorState(api, e, load));
      });
    }
    function draw(d) {
      var items = Array.isArray(d.items) ? d.items : [], total = d.total != null ? +d.total : items.length, tt = d.totals || {};
      if (!items.length) {
        body.appendChild(U.card(null, U.emptyState('search', t('rpt_empty_title'), t('rpt_empty_text'),
          [U.btn(t('clear'), 'btn-secondary', function () { ST = S = { offset: 0 }; CF_STATE = null; drawAll(); })])));
        return;
      }
      var cols = columns(), CFm = window.MarsaColFilter, cf = null;
      if (CFm) {
        cf = CFm.create({ id: 'reg', columns: cols.map(function (c) { return { key: c.key, label: c.label, type: c.type, value: function (x) { return c.value(x); } }; }),
          onChange: function () { CF_STATE = cf.state(); paint(); } });
        cf.setRows(items);
        if (CF_STATE) cf.setState(CF_STATE).setRows(items);
      }
      var def = K.defs.tx_followup;
      var countP = el('p', { class: 'rpt-count', 'aria-live': 'polite' });
      var clearCf = el('button', { type: 'button', class: 'btn btn-sm btn-ghost rpt-cf-clear', text: lt('cf_clear_all'), hidden: true });
      clearCf.addEventListener('click', function (e) { e.preventDefault(); if (cf) cf.clearAll(); });
      var bar = K.exportBar({ api: api, def: def, ctx: { finRead: finRead }, total: total, getFilters: function () { return lastFilters; },
        getRowFilter: function () { return cf && cf.active() ? cf.apply : null; },
        getCriteria: function () { return cf && cf.active() ? cf.describe().map(function (p) { return [lt('cf_crit', { c: p[0] }), p[1]]; }) : null; } });
      body.appendChild(el('div', { class: 'rpt-result-head' }, [el('div', { class: 'rpt-count-box' }, [countP, clearCf]),
        el('div', { class: 'lrpt-export' }, [el('span', { class: 'lrpt-export-title text-xs text-muted', text: lt('followup_export') }), bar])]));
      var tableBox = el('div');
      body.appendChild(tableBox);
      function paint() {
        U.clear(tableBox);
        var shown = cf ? cf.apply(items) : items, on = cf ? cf.active() : 0;
        countP.textContent = on ? lt('cf_shown', { n: K.fmtNum(shown.length, 0), m: K.fmtNum(items.length, 0), total: K.fmtNum(total, 0) }) : t('results_n', { n: K.fmtNum(total, 0) });
        clearCf.hidden = !on;
        var totals = on ? [] : [{ ref: K.t('total_n', { n: K.fmtNum(tt.count != null ? tt.count : total, 0) }), unit_count: tt.units != null ? +tt.units : null,
          attention: lt('att_totals', { c: K.fmtNum((tt.attention || {}).critical || 0, 0), w: K.fmtNum((tt.attention || {}).warning || 0, 0) }) }];
        tableBox.appendChild(U.card(null, K.reportTable(cols, shown, totals, ctx, { caption: lt('reg_title'), rowId: function (x) { return x.id; }, rowClass: rowClass,
          thExtra: cf ? function (c) { return cf.button(c.key); } : null }), null, { flush: true, cls: 'lrpt-table-card' }));
      }
      paint();
      var pg = K.pager(total, PAGE, S.offset || 0, function (o) { S.offset = o; load(); });
      if (pg) body.appendChild(pg);
      if (total > PAGE) body.appendChild(el('p', { class: 'text-xs text-muted lrpt-page-note', text: lt('cf_page_note', { n: K.fmtNum(PAGE, 0) }) }));
    }
    function drawAll() { drawQuick(); drawForm(); return load(); }

    U.loadingInto(body);
    return lookups().then(function () { if (!sc.alive()) return; return drawAll(); });
  }

  Ops.views.register = {
    allow: 'staff', titleKey: 'lrpt.nav_register', icon: 'list',
    render: function (root, api) { return render(root, api); },
    // test hooks
    _state: function () { return ST; }, _reset: function () { ST = null; CF_STATE = null; ST_ORG = null; },
    _pure: { fromQuery: fromQuery, toQuery: toQuery, toFilters: toFilters, SCHEMA: SCHEMA, ALIAS: ALIAS }
  };
})();
