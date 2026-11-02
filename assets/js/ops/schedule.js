/* ==========================================================================
   مرسى | MARSA — G3 operations: #schedule (port appointments + transport trips)
   --------------------------------------------------------------------------
   Contract: docs/online/G3_SPEC.md ("UI scope" → #schedule). Uses MarsaOps.ui
   (assets/js/ops/alerts.js). Route: #schedule, #schedule/today, #schedule/week.

   A today / week board (one column per day) of appointments (appointment_at) and
   trips (planned_at, else loaded_at), filtered by terminal, carrier and status.
   Transport writers change a status in place (reason required for missed /
   cancelled); rescheduling and creation stay in the transaction detail, where
   the chain of rescheduled appointments is shown.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var APPT_STATUSES = ['requested', 'confirmed', 'completed', 'missed', 'cancelled', 'rescheduled'];
  var TRIP_STATUSES = ['planned', 'dispatched', 'loaded', 'delivered', 'cancelled'];
  // forward moves offered here (the RPCs are the gate)
  // (a missed slot may still be cancelled here; rebooking it stays in the transaction detail)
  var APPT_NEXT = { requested: ['confirmed', 'missed', 'cancelled'], confirmed: ['completed', 'missed', 'cancelled'], missed: ['cancelled'] };
  var TRIP_NEXT = { planned: ['dispatched', 'cancelled'], dispatched: ['loaded', 'cancelled'], loaded: ['delivered', 'cancelled'] };
  var NEEDS_REASON = { missed: 1, cancelled: 1 };

  // board state survives navigation within the page
  var SF = { range: 'today', anchor: null, type: 'all', terminal: '', carrier: '', status: '' };

  function render(root, api, param) {
    var U = Ops.ui;
    if (!U) { root.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing'; return; }
    var sc = U.scope(root), el = U.el, t = U.t;
    var writer = U.can(api, 'transportWriter');
    if (param === 'today' || param === 'week') SF.range = param;
    if (!SF.anchor) SF.anchor = U.startOfDay(new Date());
    var parties = [], drivers = {}, trucks = {}, refs = null, appts = [], trips = [];

    U.clear(root);
    root.classList.add('ops-view', 'ops-schedule');
    root.appendChild(U.head(t('sc_title'), t('sc_sub')));
    var nav = el('div', { class: 'ops-sched-nav' });
    var bar = el('div');
    var body = el('div', { class: 'ops-sched-body' });
    root.appendChild(nav); root.appendChild(bar); root.appendChild(body);

    function days() {
      var n = SF.range === 'week' ? 7 : 1, out = [];
      for (var i = 0; i < n; i++) out.push(U.addDays(SF.anchor, i));
      return out;
    }
    function window_() { var d = days(); return { from: d[0], to: U.addDays(d[d.length - 1], 1) }; }
    function apptAt(a) { return U.toDate(a.appointment_at); }
    function tripAt(x) { return U.toDate(x.planned_at || x.loaded_at || x.unloaded_at); }

    function drawNav() {
      U.clear(nav);
      var w = window_(), isToday = U.isoDay(SF.anchor) === U.isoDay(new Date());
      var tabs = el('div', { class: 'tabs ops-tabs', role: 'tablist', 'aria-label': t('sc_range') }, ['today', 'week'].map(function (r) {
        var b = el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(SF.range === r), text: t('sc_' + r) });
        b.addEventListener('click', function () { if (SF.range === r) return; SF.range = r; load(); });
        return b;
      }));
      var step = SF.range === 'week' ? 7 : 1;
      var prev = U.btn([U.icon('chevronStart', 'icon-flip')], 'btn-secondary btn-icon', function () { SF.anchor = U.addDays(SF.anchor, -step); load(); }, { 'aria-label': t('sc_prev'), title: t('sc_prev') });
      var next = U.btn([U.icon('chevronEnd', 'icon-flip')], 'btn-secondary btn-icon', function () { SF.anchor = U.addDays(SF.anchor, step); load(); }, { 'aria-label': t('sc_next'), title: t('sc_next') });
      var label = SF.range === 'week' ? U.fmtDate(w.from) + ' – ' + U.fmtDate(U.addDays(w.to, -1)) : U.fmtDay(SF.anchor);
      var date = el('input', { class: 'form-control is-sm ops-date', type: 'date', value: U.isoDay(SF.anchor), 'aria-label': t('sc_range') });
      date.addEventListener('change', function () { var d = U.toDate(date.value + 'T00:00:00'); if (d) { SF.anchor = U.startOfDay(d); load(); } });
      nav.appendChild(el('div', { class: 'ops-sched-nav-row' }, [
        tabs,
        el('div', { class: 'ops-sched-step' }, [prev, el('strong', { class: 'ops-sched-label', 'aria-live': 'polite', text: label }), next, date,
          isToday ? null : U.btn(t('sc_jump'), 'btn-subtle', function () { SF.anchor = U.startOfDay(new Date()); load(); })])
      ]));
    }
    function drawBar() {
      U.clear(bar);
      var terms = parties.filter(function (p) { return (p.kinds || []).indexOf('terminal_operator') !== -1; });
      var carriers = parties.filter(function (p) { return (p.kinds || []).indexOf('carrier') !== -1; });
      if (SF.terminal && !terms.some(function (p) { return p.id === SF.terminal; })) SF.terminal = '';   // other org
      if (SF.carrier && !carriers.some(function (p) { return p.id === SF.carrier; })) SF.carrier = '';
      var statusOpts = [['', t('sc_f_status') + ': ' + t('all')]];
      if (SF.type !== 'trip') statusOpts.push({ group: t('sc_status_group_appt'), options: APPT_STATUSES.map(function (s) { return ['a:' + s, U.lab('appt_status', s)]; }) });
      if (SF.type !== 'appt') statusOpts.push({ group: t('sc_status_group_trip'), options: TRIP_STATUSES.map(function (s) { return ['t:' + s, U.lab('trip_status', s)]; }) });
      if (SF.status && ((SF.type === 'trip' && SF.status[0] === 'a') || (SF.type === 'appt' && SF.status[0] === 't'))) SF.status = '';
      var filters = [
        U.select('type', t('sc_f_type'), [['all', t('sc_type_all')], ['appt', t('sc_type_appt')], ['trip', t('sc_type_trip')]], SF.type, function (v) { SF.type = v; drawBar(); draw(); }),
        SF.type !== 'trip' ? U.select('terminal', t('sc_f_terminal'), [['', t('sc_f_terminal') + ': ' + t('all')]].concat(terms.map(function (p) { return [p.id, U.partyName(p)]; })), SF.terminal, function (v) { SF.terminal = v; load(); }) : null,
        SF.type !== 'appt' ? U.select('carrier', t('sc_f_carrier'), [['', t('sc_f_carrier') + ': ' + t('all')]].concat(carriers.map(function (p) { return [p.id, U.partyName(p)]; })), SF.carrier, function (v) { SF.carrier = v; load(); }) : null,
        U.select('status', t('sc_f_status'), statusOpts, SF.status, function (v) { SF.status = v; load(); })
      ].filter(Boolean);
      var acts = [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })];
      if (SF.terminal || SF.carrier || SF.status || SF.type !== 'all') acts.unshift(U.btn(t('clear_filters'), 'btn-subtle', function () { SF.type = 'all'; SF.terminal = ''; SF.carrier = ''; SF.status = ''; load(); }));
      bar.appendChild(U.toolbar(null, filters, acts, null));
    }
    function partyById(id) { return parties.filter(function (p) { return p.id === id; })[0] || null; }
    function driverName(r) { return U.pick(r, ['driver_name', 'driver.full_name', 'drivers.full_name']) || (drivers[r.driver_id] || {}).full_name || null; }
    function plateOf(r) { return U.pick(r, ['plate_no', 'truck_plate', 'truck.plate_no', 'trucks.plate_no']) || (trucks[r.truck_id] || {}).plate_no || null; }
    function load() {
      drawNav();
      U.loadingInto(body, 5, false);
      var w = window_();
      var st = SF.status ? SF.status.slice(2) : '';
      // trips: planned_at, else loaded_at / unloaded_at (anyAt) — the same order as tripAt below
      var fa = { from: w.from.toISOString(), to: w.to.toISOString() }, ft = { from: w.from.toISOString(), to: w.to.toISOString(), anyAt: true };
      if (SF.terminal) fa.terminalId = SF.terminal;
      if (SF.carrier) ft.carrierId = SF.carrier;
      if (st && SF.status[0] === 'a') fa.status = st;
      if (st && SF.status[0] === 't') ft.status = st;
      var wantA = SF.type !== 'trip' && !(st && SF.status[0] === 't');
      var wantT = SF.type !== 'appt' && !(st && SF.status[0] === 'a');
      // directories (terminal / carrier names, drivers, plates) once per render; the rows carry ids only
      if (!refs) refs = Promise.all([U.call(api, 'listParties', { active: false, limit: 500 }), U.call(api, 'listDrivers'), U.call(api, 'listTrucks')]).then(function (r) {
        if (!r[0].error) parties = U.rowsOf(r[0].data);
        if (!r[1].error) U.rowsOf(r[1].data).forEach(function (d) { drivers[d.id] = d; });
        if (!r[2].error) U.rowsOf(r[2].data).forEach(function (k) { trucks[k.id] = k; });
        return { data: parties };
      });
      return Promise.all([
        refs,
        wantA ? U.call(api, 'listAppointments', fa) : Promise.resolve({ data: [] }),
        wantT ? U.call(api, 'listTrips', ft) : Promise.resolve({ data: [] })
      ]).then(function (res) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        var err = res[1].error || res[2].error;
        drawBar();
        if (err) { body.appendChild(U.errorState(api, err, load)); return; }
        appts = U.rowsOf(res[1].data); trips = U.rowsOf(res[2].data);
        draw();
      });
    }
    // client-side guard: the same window / filters even if the server ignores one
    function visible() {
      var w = window_(), st = SF.status ? SF.status.slice(2) : '';
      function inWin(d) { return d && d >= w.from && d < w.to; }
      var a = SF.type === 'trip' || (st && SF.status[0] === 't') ? [] : appts.filter(function (x) {
        return inWin(apptAt(x)) && (!SF.terminal || x.terminal_party_id === SF.terminal) && (!st || x.status === st);
      });
      var tr = SF.type === 'appt' || (st && SF.status[0] === 'a') ? [] : trips.filter(function (x) {
        return inWin(tripAt(x)) && (!SF.carrier || x.carrier_id === SF.carrier) && (!st || x.status === st);
      });
      return { a: a, t: tr };
    }
    function draw() {
      if (!sc.alive()) return;
      U.clear(body);
      var v = visible();
      var cnt = el('p', { class: 'ops-sched-summary toolbar-count', 'aria-live': 'polite', text: t('sc_summary', { a: v.a.length, t: v.t.length }) });
      body.appendChild(cnt);
      if (!v.a.length && !v.t.length) {
        body.appendChild(U.card(null, U.emptyState('calendar', t('sc_empty_title'), t('sc_empty_text'))));
        return;
      }
      var items = v.a.map(function (x) { return { kind: 'appt', at: apptAt(x), row: x }; })
        .concat(v.t.map(function (x) { return { kind: 'trip', at: tripAt(x), row: x }; }))
        .sort(function (p, q) { return p.at - q.at; });
      var board = el('div', { class: 'ops-board' + (SF.range === 'week' ? ' is-week' : ' is-day') });
      days().forEach(function (d) {
        var key = U.isoDay(d), list = items.filter(function (it) { return U.isoDay(it.at) === key; });
        var isToday = key === U.isoDay(new Date());
        var col = el('section', { class: 'ops-day' + (isToday ? ' is-today' : ''), 'aria-label': U.fmtDay(d) }, [
          el('header', { class: 'ops-day-head' }, [el('h3', { class: 'ops-day-title', text: U.fmtDay(d) }), el('span', { class: 'badge badge-muted', text: String(list.length) })]),
          list.length ? el('ol', { class: 'ops-day-list' }, list.map(function (it) { return el('li', null, it.kind === 'appt' ? apptCard(it.row) : tripCard(it.row)); }))
            : el('p', { class: 'ops-day-empty', text: t('sc_no_day') })
        ]);
        board.appendChild(col);
      });
      body.appendChild(board);
    }
    function meta(label, value) { return value == null || value === '' ? null : el('div', { class: 'ops-item-meta' }, [el('dt', { text: label }), el('dd', null, value)]); }
    function apptCard(a) {
      var term = (U.lang() === 'en' && U.pick(a, ['terminal_name_en', 'terminal.name_en'])) || U.pick(a, ['terminal_name', 'terminal.name_ar']) ||
        U.partyName(partyById(a.terminal_party_id));
      var ctr = U.pick(a, ['container_no', 'containers.container_no', 'container.container_no']);
      var drv = driverName(a), plate = plateOf(a);
      return el('article', { class: 'ops-item is-appt', 'data-id': a.id, 'data-status': a.status }, [
        el('div', { class: 'ops-item-top' }, [
          el('span', { class: 'ops-item-time num', text: U.fmtTime(a.appointment_at), title: a.window_minutes ? t('sc_window', { n: a.window_minutes }) : null }),
          el('span', { class: 'ops-item-kind' }, [U.icon('clock'), el('span', { text: t('sc_appt') })]),
          U.statusPill('appt_status', a.status)
        ]),
        el('dl', { class: 'ops-item-dl' }, [
          meta(t('tx'), U.txLink(a)),
          meta(t('sc_f_terminal'), term !== U.NONE ? term : null),
          meta(t('container'), ctr ? U.ltr(ctr) : null),
          meta(t('sc_appt_no'), a.appointment_no ? U.ltr(a.appointment_no) : null),
          meta(t('sc_driver'), drv), meta(t('sc_truck'), plate ? U.ltr(plate) : null),
          a.window_minutes ? meta(t('sc_range'), t('sc_window', { n: a.window_minutes })) : null,
          a.status_reason ? meta(t('reason'), a.status_reason) : null
        ]),
        actions('appt', a)
      ]);
    }
    function tripCard(x) {
      var carrier = (U.lang() === 'en' && U.pick(x, ['carrier_name_en', 'carrier.name_en'])) || U.pick(x, ['carrier_name', 'carrier.name_ar']) ||
        U.partyName(partyById(x.carrier_id));
      var ctr = U.pick(x, ['container_no', 'containers.container_no', 'container.container_no']);
      var drv = driverName(x), plate = plateOf(x);
      var route = x.origin || x.destination ? t('sc_route', { from: x.origin || U.NONE, to: x.destination || U.NONE }) : null;
      return el('article', { class: 'ops-item is-trip', 'data-id': x.id, 'data-status': x.status }, [
        el('div', { class: 'ops-item-top' }, [
          el('span', { class: 'ops-item-time num', text: U.fmtTime(x.planned_at || x.loaded_at || x.unloaded_at) }),
          el('span', { class: 'ops-item-kind' }, [U.icon('truck'), el('span', { text: t('sc_trip') + (x.leg_no ? ' · ' + t('sc_leg', { n: x.leg_no }) : '') })]),
          U.statusPill('trip_status', x.status)
        ]),
        route ? el('p', { class: 'ops-item-route', text: route }) : null,
        el('dl', { class: 'ops-item-dl' }, [
          meta(t('tx'), U.txLink(x)),
          meta(t('sc_f_carrier'), carrier !== U.NONE ? carrier : null),
          meta(t('container'), ctr ? U.ltr(ctr) : null),
          meta(t('sc_driver'), drv), meta(t('sc_truck'), plate ? U.ltr(plate) : null)
        ]),
        actions('trip', x)
      ]);
    }
    function actions(kind, row) {
      var next = (kind === 'appt' ? APPT_NEXT : TRIP_NEXT)[row.status] || [];
      if (!writer || !next.length) return null;
      var wrap = el('div', { class: 'ops-item-actions' });
      // the main forward move as a one-click button, everything else in the dialog
      var primary = next[0];
      wrap.appendChild(U.btn(U.lab(kind === 'appt' ? 'appt_status' : 'trip_status', primary), 'btn-secondary', function () { changeStatus(kind, row, primary); }));
      wrap.appendChild(U.btn(t('sc_set_status'), 'btn-subtle', function () { changeStatus(kind, row, null); }));
      return wrap;
    }
    function changeStatus(kind, row, preset) {
      var domain = kind === 'appt' ? 'appt_status' : 'trip_status';
      var next = (kind === 'appt' ? APPT_NEXT : TRIP_NEXT)[row.status] || [];
      if (!next.length) { U.toast(api, t('sc_no_next'), 'info'); return; }
      var fields = [{ name: 'status', label: t('sc_status_new'), type: 'select', required: true, value: preset || next[0], options: next.map(function (s) { return [s, U.lab(domain, s)]; }) }];
      if (kind === 'trip') fields.push({ name: 'at', label: t('sc_status_at'), type: 'datetime-local', value: U.localInput(new Date()), ltr: true });
      fields.push({ name: 'reason', label: kind === 'appt' ? t('reason') : t('note'), type: 'textarea', max: 500, rows: 2 });
      U.formModal({
        title: t(kind === 'appt' ? 'sc_status_title_appt' : 'sc_status_title_trip'), size: 'sm',
        intro: kind === 'appt' ? t('sc_reschedule_hint') : null,
        warn: preset === 'cancelled' ? t('sc_cancel_warn') : null,
        fields: fields,
        validate: function (v) { return NEEDS_REASON[v.status] && !v.reason ? { reason: t('sc_reason_req') } : null; },
        submit: function (v) {
          if (kind === 'appt') return U.call(api, 'setAppointmentStatus', row.id, v.status, v.reason || null);
          return U.call(api, 'setTripStatus', row.id, v.status, U.fromLocalInput(v.at) || new Date().toISOString(), v.reason || null);
        }
      }).then(function (res) {
        if (!res || !sc.alive()) return;
        U.toast(api, t('sc_updated'), 'success');
        if (Ops.alertsChanged) Ops.alertsChanged();
        load();
      });
    }
    return load();
  }

  Ops.views.schedule = {
    allow: 'staff', titleKey: 'ops.nav_schedule', icon: 'calendar',
    render: function (root, api, param) { return render(root, api, param); }
  };
})();
