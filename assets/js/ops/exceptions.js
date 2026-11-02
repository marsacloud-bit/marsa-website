/* ==========================================================================
   مرسى | MARSA — G3 operations: #exceptions (operational exceptions list)
   --------------------------------------------------------------------------
   Contract: docs/online/G3_SPEC.md ("Data model" 11, "UI scope" → #exceptions).
   Uses MarsaOps.ui (assets/js/ops/alerts.js).

   Every exception carries a source, a date and a reason; they are created from
   the transaction detail (tx-sections.js), and cancel_declaration creates one
   automatically. Here: KPIs, filters (status / kind / source / period / text),
   and moving an exception to in_progress / resolved / waived with a note
   (resolveException). Exceptions never reach the client portal.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var KINDS = ['declaration_cancelled', 'demurrage', 'detention_extension', 'customs_rejection', 'inspection', 'repair_fee', 'cleaning_fee',
    'appointment_change', 'transport_change', 'other'];
  var STATUSES = ['open', 'in_progress', 'resolved', 'waived'];
  var SOURCES = ['manual', 'document', 'email', 'system'];
  var EF = { status: 'active', kind: '', source: '', from: '', to: '', q: '' };

  function noKit(root) { root.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing'; }
  function statusOk(s, row) {
    if (s === 'all') return true;
    if (s === 'active') return row.status === 'open' || row.status === 'in_progress';
    return row.status === s;
  }

  function render(root, api) {
    var U = Ops.ui;
    if (!U) return noKit(root);
    var el = U.el, t = U.t, sc = U.scope(root);
    var writer = U.can(api, 'opsWriter') || U.can(api, 'transportWriter');
    var rows = [];
    U.clear(root);
    root.classList.add('ops-view', 'ops-exceptions');
    root.appendChild(U.head(t('ex_title'), t('ex_sub')));
    var kpis = el('div', { class: 'adm-tiles ops-kpis', 'aria-live': 'polite' }), bar = el('div'), body = el('div');
    root.appendChild(kpis); root.appendChild(bar); root.appendChild(body);

    function load() {
      U.loadingInto(body, 6, false);
      var f = { limit: 500 };
      if (EF.status === 'active') f.status = ['open', 'in_progress'];
      else if (EF.status !== 'all') f.status = EF.status;
      if (EF.kind) f.kind = EF.kind;
      if (EF.source) f.source = EF.source;
      // the period is in local days; the reader takes ISO bounds (to = exclusive)
      var fromD = EF.from ? U.toDate(EF.from + 'T00:00:00') : null, toD = EF.to ? U.toDate(EF.to + 'T00:00:00') : null;
      if (fromD) f.from = fromD.toISOString();
      if (toD) f.to = U.addDays(toD, 1).toISOString();
      drawBar();
      return U.call(api, 'listExceptions', f).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { U.clear(kpis); body.appendChild(U.errorState(api, r.error, load)); return; }
        rows = U.rowsOf(r.data);
        draw();
      });
    }
    function inPeriod(x) {
      var d = U.toDate(x.occurred_at || x.created_at);
      if (!d) return !EF.from && !EF.to;
      var day = U.isoDay(d);
      return (!EF.from || day >= EF.from) && (!EF.to || day <= EF.to);
    }
    function filtered() {
      return rows.filter(function (x) {
        return statusOk(EF.status, x) && (!EF.kind || x.kind === EF.kind) && (!EF.source || x.source === EF.source) && inPeriod(x) &&
          U.matches(EF.q, [x.reason, U.txRef(x), U.pick(x, ['container_no', 'container.container_no']), U.lab('exception_kind', x.kind), x.resolution_note]);
      }).sort(function (a, b) { return String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')); });
    }
    function drawKpis() {
      U.clear(kpis);
      var open = rows.filter(function (x) { return x.status === 'open'; }), prog = rows.filter(function (x) { return x.status === 'in_progress'; });
      kpis.appendChild(U.kpi(t('ex_kpi_open'), open.length, 'danger', { active: EF.status === 'open', onClick: function () { EF.status = EF.status === 'open' ? 'active' : 'open'; load(); } }));
      kpis.appendChild(U.kpi(t('ex_kpi_progress'), prog.length, 'warning', { active: EF.status === 'in_progress', onClick: function () { EF.status = EF.status === 'in_progress' ? 'active' : 'in_progress'; load(); } }));
      // amounts on open items, per currency (no conversion)
      var sums = {};
      open.concat(prog).forEach(function (x) { if (x.amount != null && !isNaN(+x.amount)) { var c = x.currency || 'SAR'; sums[c] = (sums[c] || 0) + (+x.amount); } });
      var cur = Object.keys(sums);
      kpis.appendChild(U.kpi(t('ex_kpi_amount'), cur.length ? U.fmtMoney(sums[cur[0]], cur[0], api) : U.fmtMoney(0, 'SAR', api), 'neutral',
        { foot: cur.length > 1 ? cur.slice(1).map(function (c) { return U.fmtMoney(sums[c], c, api); }).join(' · ') : null }));
    }
    function dateInput(name, label, value) {
      var i = el('input', { class: 'form-control is-sm ops-date', type: 'date', name: name, value: value || '', 'aria-label': label, title: label });
      i.addEventListener('change', function () { EF[name] = i.value; load(); });
      return i;
    }
    function drawBar() {
      U.clear(bar);
      var filters = [
        U.select('status', t('ex_f_status'), [['active', t('ex_status_active')]].concat(STATUSES.map(function (s) { return [s, U.lab('exception_status', s)]; })).concat([['all', t('all')]]), EF.status, function (v) { EF.status = v; load(); }),
        U.select('kind', t('ex_f_kind'), [['', t('ex_f_kind') + ': ' + t('all')]].concat(KINDS.map(function (k) { return [k, U.lab('exception_kind', k)]; })), EF.kind, function (v) { EF.kind = v; draw(); }),
        U.select('source', t('ex_f_source'), [['', t('ex_f_source') + ': ' + t('all')]].concat(SOURCES.map(function (s) { return [s, U.lab('exception_source', s)]; })), EF.source, function (v) { EF.source = v; draw(); }),
        el('span', { class: 'ops-range' }, [dateInput('from', t('from'), EF.from), el('span', { class: 'ops-muted', 'aria-hidden': 'true', text: '–' }), dateInput('to', t('to'), EF.to)])
      ];
      var acts = [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })];
      if (EF.kind || EF.source || EF.from || EF.to || EF.q || EF.status !== 'active') acts.unshift(U.btn(t('clear_filters'), 'btn-subtle', function () { EF = { status: 'active', kind: '', source: '', from: '', to: '', q: '' }; load(); }));
      bar.appendChild(U.toolbar(U.searchBox(EF.q, t('search'), function (v) { EF.q = v; draw(true); }), filters, acts, ''));
    }
    function draw(fromSearch) {
      if (!sc.alive()) return;
      var list = filtered();
      drawKpis();
      if (!fromSearch) drawBar();
      var cnt = bar.querySelector('.toolbar-count');
      if (cnt) cnt.textContent = t('shown_of', { n: list.length, total: rows.length });
      U.clear(body);
      if (!rows.length) { body.appendChild(U.card(null, U.emptyState('flag', t('ex_empty_title'), t('ex_empty_text')))); return; }
      if (!list.length) { body.appendChild(U.card(null, U.emptyState('search', null, t('no_match'), null, true))); return; }
      body.appendChild(U.table([t('ex_col_when'), t('ex_col_kind'), t('tx'), t('ex_col_reason'), { label: t('ex_col_amount'), num: true }, t('ex_col_source'), t('ex_col_status'), { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(rowNode), { caption: t('ex_title') }));
    }
    function rowNode(x) {
      var ctr = U.pick(x, ['container_no', 'container.container_no']);
      var closed = x.status === 'resolved' || x.status === 'waived';
      var acts = el('div', { class: 'ops-row-actions' });
      if (writer && x.status === 'open') acts.appendChild(U.btn(t('ex_progress'), 'btn-subtle', function () { act(x, 'progress'); }));
      if (writer && !closed) acts.appendChild(U.btn([U.icon('check'), el('span', { text: t('ex_resolve') })], 'btn-secondary', function () { act(x, 'close'); }));
      return el('tr', { 'data-id': x.id, class: closed ? 'is-muted' : null }, [
        U.td([el('span', { text: U.fmtDate(x.occurred_at) }), x.created_at ? el('span', { class: 'cell-sub', text: U.fmtDate(x.created_at, true) }) : null], 'is-nowrap'),
        U.td(el('span', { class: 'cell-main', text: U.lab('exception_kind', x.kind) })),
        U.td([U.txLink(x), ctr ? el('span', { class: 'cell-sub' }, [t('container') + ': ', U.ltr(ctr)]) : null], 'is-nowrap'),
        U.td([el('span', { class: 'ops-reason', text: x.reason || U.NONE }), x.document_id ? el('span', { class: 'cell-sub ops-doc' }, [U.icon('file'), el('span', { text: t('ex_doc') })]) : null,
          x.resolution_note ? el('span', { class: 'cell-sub ops-note', text: x.resolution_note }) : null]),
        U.td(x.amount != null && x.amount !== '' ? U.fmtMoney(x.amount, x.currency || 'SAR', api) : null, 'num is-nowrap'),
        U.td(U.lab('exception_source', x.source)),
        U.td([U.statusPill('exception_status', x.status), closed && x.resolved_at ? el('span', { class: 'cell-sub', text: t('ex_closed_at', { d: U.fmtDate(x.resolved_at) }) }) : null]),
        U.td(acts, 'ops-col-actions')
      ]);
    }
    function act(x, mode) {
      var closing = mode === 'close';
      var fields = closing ? [{ name: 'status', label: t('ex_outcome'), type: 'select', required: true, value: 'resolved',
        options: [['resolved', U.lab('exception_status', 'resolved')], ['waived', U.lab('exception_status', 'waived')]] }] : [];
      fields.push({ name: 'note', label: t('ex_note_label'), type: 'textarea', required: closing, max: 1000, rows: 3, hint: t('ex_note_hint') });
      U.formModal({
        title: t(closing ? 'ex_resolve_title' : 'ex_progress_title'), size: 'sm',
        intro: U.lab('exception_kind', x.kind) + ' — ' + (x.reason || ''),
        warn: closing ? t('ex_waive_warn') : null,
        submitText: closing ? t('ex_resolve') : t('ex_progress'),
        fields: fields,
        submit: function (v) { return U.call(api, 'resolveException', x.id, closing ? v.status : 'in_progress', U.nn(v.note)); }
      }).then(function (res) {
        if (!res || !sc.alive()) return;
        U.toast(api, t('ex_done'), 'success');
        if (Ops.alertsChanged) Ops.alertsChanged();   // exception_open alerts follow
        load();
      });
    }
    return load();
  }

  Ops.views.exceptions = {
    allow: 'staff', titleKey: 'ops.nav_exceptions', icon: 'flag',
    render: function (root, api) { return render(root, api); }
  };
})();
