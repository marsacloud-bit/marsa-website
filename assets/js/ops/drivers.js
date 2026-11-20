/* ==========================================================================
   مرسى | MARSA — owner stage 3د: #drivers «السائقون» — one easy place for every driver
   --------------------------------------------------------------------------
   Contract: migration 20261207000100_driver_classes.sql (public.list_drivers / public.save_driver).
   Columns: name · mobile · truck plate · classification (فردي / تابع لمؤسسة أو شركة / تابع لمتعهد) · the company or
   contractor it belongs to (name + mobile + CR, from «الجهات والناقلون») · status. Search over all of them; staff read,
   transport writers add / edit / deactivate (nothing deleted). A company or a contractor is a party with the kind
   «ناقل» in «الجهات والناقلون» — the dialog lists those and links there to add a new one.
   Drivers created from an appointment card show as «غير مصنّف» until classified here.
   Uses MarsaOps.ui (assets/js/ops/alerts.js). Strings: namespace 'ops' (drv2_*), ar + en. ES5, no library.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};
  var CLASSES = ['individual', 'company', 'contractor'];
  var PHONE_RE = /^\+?[0-9 ()-]{6,20}$/;
  var DF = { q: '', cls: '', inactive: false };

  function noKit(root) { root.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing'; }
  // pure: the row a dialog sends to save_driver
  function driverRow(v, id) {
    var cls = CLASSES.indexOf(v.driver_class) !== -1 ? v.driver_class : null;
    var row = { full_name: String(v.full_name || '').trim(), phone: String(v.phone || '').trim(), driver_class: cls,
      carrier_id: cls && cls !== 'individual' && v.carrier_id ? v.carrier_id : null,
      truck_plate: String(v.truck_plate || '').trim() || null, license_no: String(v.license_no || '').trim() || null,
      is_active: v.is_active !== false };
    if (id) row.id = id;
    return row;
  }
  // pure: does a directory row match the filters
  function matches(U, d, f) {
    if (!f.inactive && d.is_active === false) return false;
    if (f.cls === '_none' ? !!d.driver_class : (f.cls && d.driver_class !== f.cls)) return false;
    var p = d.party || {};
    return U.matches(f.q, [d.full_name, d.phone, d.truck_plate, d.license_no, p.name_ar, p.name_en, p.phone]);
  }

  function driverDialog(U, api, carriers, d) {
    d = d || {};
    var t = U.t;
    var carrierOpts = [['', t('drv2_party_pick')]].concat(carriers.map(function (c) { return [c.id, U.partyName(c) + (c.phone ? ' — ' + c.phone : '')]; }));
    return U.formModal({
      title: d.id ? t('drv2_edit') : t('drv2_add'),
      uniqueField: 'phone', uniqueMsg: t('drv2_phone_taken'),
      intro: t('drv2_intro'),
      fields: [
        { name: 'full_name', label: t('f_full_name'), required: true, max: 120, value: d.full_name },
        { name: 'phone', label: t('drv2_phone'), type: 'tel', required: true, max: 20, value: d.phone, ltr: true, pattern: PHONE_RE, patternMsg: t('phone_invalid'), autocomplete: 'off' },
        { name: 'truck_plate', label: t('drv2_plate'), max: 20, value: d.truck_plate, ltr: true, hint: t('drv2_plate_hint') },
        { name: 'driver_class', label: t('drv2_class'), type: 'select', required: true, value: d.driver_class || '',
          options: [['', t('drv2_class_pick')]].concat(CLASSES.map(function (c) { return [c, U.lab('driver_class', c)]; })) },
        { name: 'carrier_id', label: t('drv2_party'), type: 'select', value: d.party ? d.party.id : '', options: carrierOpts, hint: t('drv2_party_hint'), full: true },
        { name: 'license_no', label: t('f_license'), max: 30, value: d.license_no, ltr: true },
        { name: 'is_active', label: t('active'), type: 'checkbox', value: d.id ? d.is_active !== false : true }
      ],
      submit: function (v) { return U.call(api, 'saveDriverEntry', driverRow(v, d.id)); }
    });
  }

  function renderList(root, api) {
    var U = Ops.ui, el = U.el, t = U.t, sc = U.scope(root);
    var writer = U.can(api, 'transportWriter');
    var rows = [], carriers = [];
    U.clear(root);
    root.classList.add('ops-view', 'ops-drivers');
    var addB = writer ? U.btn([U.icon('plus'), el('span', { text: t('drv2_add') })], 'btn-primary', add) : null;
    root.appendChild(U.head(t('drv2_title'), t('drv2_sub'), addB ? [addB] : []));
    var bar = el('div'), body = el('div');
    root.appendChild(bar); root.appendChild(body);

    function load() {
      U.loadingInto(body, 6, false);
      return Promise.all([U.call(api, 'listDriversDirectory', null), U.call(api, 'listParties', { kind: 'carrier', limit: 500 })]).then(function (res) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        var r = res[0];
        if (r.error) { drawBar(); body.appendChild(U.errorState(api, r.error, load)); return; }
        rows = U.rowsOf(r.data);
        carriers = res[1] && !res[1].error ? U.rowsOf(res[1].data) : [];
        drawBar(); draw();
      });
    }
    function drawBar() {
      U.clear(bar);
      var inact = el('label', { class: 'check ops-check ops-inline-check' }, [el('input', { type: 'checkbox', checked: DF.inactive,
        onchange: function (e) { DF.inactive = e.target.checked; draw(); } }), el('span', { text: t('show_inactive') })]);
      bar.appendChild(U.toolbar(U.searchBox(DF.q, t('drv2_search'), function (v) { DF.q = v; draw(); }), [
        U.select('cls', t('drv2_class'), [['', t('drv2_class') + ': ' + t('all')]].concat(CLASSES.map(function (c) { return [c, U.lab('driver_class', c)]; }))
          .concat([['_none', t('drv2_unclassified')]]), DF.cls, function (v) { DF.cls = v; draw(); }),
        inact
      ], [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })], ''));
    }
    function draw() {
      if (!sc.alive()) return;
      var list = rows.filter(function (d) { return matches(U, d, DF); });
      var cnt = bar.querySelector('.toolbar-count');
      if (cnt) cnt.textContent = t('shown_of', { n: list.length, total: rows.length });
      U.clear(body);
      if (!rows.length) {
        body.appendChild(U.card(null, U.emptyState('truck', t('drv2_empty_title'), t('drv2_empty_text'), writer ? [U.btn(t('drv2_add'), 'btn-primary', add)] : null)));
        return;
      }
      if (!list.length) { body.appendChild(U.card(null, U.emptyState('search', null, t('no_match'), null, true))); return; }
      body.appendChild(U.table([t('drv2_col_name'), t('drv2_col_phone'), t('drv2_col_plate'), t('drv2_col_class'), t('drv2_col_party'), t('drv2_col_status'),
        { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(function (d) {
          var p = d.party;
          var acts = el('div', { class: 'ops-row-actions' });
          if (writer) {
            acts.appendChild(U.btn(t('edit'), 'btn-secondary', function () { edit(d); }));
            acts.appendChild(U.btn(t(d.is_active === false ? 'activate' : 'deactivate'), 'btn-subtle', function () { toggle(d); }));
          }
          return el('tr', { 'data-id': d.id, class: d.is_active === false ? 'is-muted' : null }, [
            U.td(el('span', { class: 'cell-main', text: d.full_name || '' })),
            U.td(d.phone ? U.ltr(d.phone) : U.NONE),
            U.td(d.truck_plate ? el('bdi', { dir: 'ltr', class: 'drv2-plate', text: d.truck_plate }) : U.NONE),
            U.td(d.driver_class ? U.pill(d.driver_class === 'individual' ? 'neutral' : 'brand', U.lab('driver_class', d.driver_class)) : U.pill('warning', t('drv2_unclassified'))),
            U.td(p ? [el('a', { class: 'cell-main', href: '#parties/' + p.id, text: U.partyName(p) }),
              p.phone ? el('span', { class: 'cell-sub' }, U.ltr(p.phone)) : null,
              p.cr_number ? el('span', { class: 'cell-sub' }, [t('drv2_cr') + ' ', U.ltr(p.cr_number)]) : null].filter(Boolean) : U.NONE),
            U.td(d.is_active === false ? U.pill('neutral', t('inactive')) : U.pill('success', t('active'))),
            U.td(acts, 'ops-col-actions')
          ]);
        }), { caption: t('drv2_title') }));
    }
    function add() { driverDialog(U, api, carriers, null).then(function (res) { if (!res || !sc.alive()) return; U.toast(api, t('drv2_saved'), 'success'); load(); }); }
    function edit(d) { driverDialog(U, api, carriers, d).then(function (res) { if (!res || !sc.alive()) return; U.toast(api, t('drv2_saved'), 'success'); load(); }); }
    function toggle(d) {
      var off = d.is_active !== false;
      var ask = off ? U.confirm(api, { title: t('drv2_deact_title'), text: t('drv2_deact_text', { name: d.full_name || '' }), okText: t('deactivate'), danger: true }) : Promise.resolve(true);
      ask.then(function (yes) {
        if (!yes) return;
        var row = driverRow({ full_name: d.full_name, phone: d.phone, driver_class: d.driver_class || (d.party ? 'company' : 'individual'), carrier_id: d.party ? d.party.id : null,
          license_no: d.license_no, is_active: !off }, d.id);
        delete row.truck_plate;   // keep the truck as it is
        U.call(api, 'saveDriverEntry', row).then(function (r) {
          if (r.error) { U.toast(api, U.errMsg(r.error, api), 'error'); return; }
          U.toast(api, t(off ? 'deactivated' : 'activated'), 'success');
          if (sc.alive()) load();
        });
      });
    }
    return load();
  }

  // pure: the drivers of this transaction (appointments + trips) that have no classification yet
  function unclassifiedOf(appts, trips, dir) {
    var ids = {};
    (appts || []).concat(trips || []).forEach(function (x) { if (x && x.driver_id) ids[x.driver_id] = true; });
    return (dir || []).filter(function (d) { return d && ids[d.id] && !d.driver_class && d.is_active !== false; });
  }
  // pure: the row a «classify now» line sends → { row } | { error }
  function classifyRow(d, cls, carrierId) {
    if (CLASSES.indexOf(cls) === -1) return { error: 'drv2_err_class' };
    if (cls !== 'individual' && !carrierId) return { error: 'drv2_err_party' };
    var row = driverRow({ full_name: d.full_name, phone: d.phone, driver_class: cls, carrier_id: carrierId, license_no: d.license_no, is_active: true }, d.id);
    delete row.truck_plate;   // keep the truck as it is
    return { row: row };
  }

  /* ---------- #tx: «سائق جديد — اختر تصنيفه» right after the appointment card is read (owner, 20 Nov 2026) ----------
     Shown only to transport writers, only while a driver of this transaction (appointment or trip) is not classified.
     The card does not say whether the driver is individual / company / contractor, so the employee picks it here
     instead of going back to «السائقون» later. */
  function renderTxClassify(root, tx, api) {
    var U = Ops.ui;
    if (!U || !tx || api.cancelled || tx.cancelled_at) return null;
    var A = api.MarsaApi || api;
    if (!A || typeof A.listDriversDirectory !== 'function' || typeof A.saveDriverEntry !== 'function') return null;
    if (typeof api.can === 'function' && !api.can('transportWriter', tx.branch_id)) return null;
    var el = U.el, t = U.t;
    var card = el('section', { class: 'app-card adm-card ops-tx-card drv2-tx-card', 'aria-live': 'polite', hidden: true });
    root.appendChild(card);
    return Promise.all([
      U.call(api, 'listAppointments', { txId: tx.id }), U.call(api, 'listTrips', { txId: tx.id })
    ]).then(function (r) {
      var appts = r[0].error ? [] : U.rowsOf(r[0].data), trips = r[1].error ? [] : U.rowsOf(r[1].data);
      if (!appts.concat(trips).some(function (x) { return x && x.driver_id; })) return;
      return Promise.all([U.call(api, 'listDriversDirectory', null), U.call(api, 'listParties', { kind: 'carrier', limit: 500 })]).then(function (r2) {
        if (r2[0].error) return;   // before the migration: nothing to show
        var list = unclassifiedOf(appts, trips, U.rowsOf(r2[0].data));
        var carriers = r2[1] && !r2[1].error ? U.rowsOf(r2[1].data).filter(function (c) { return c.is_active !== false; }) : [];
        if (!list.length) return;
        paint(list, carriers);
      });
    });
    function paint(list, carriers) {
      card.textContent = '';
      card.hidden = false;
      card.appendChild(el('header', { class: 'app-card-head adm-card-head' }, [el('h3', { class: 'app-card-title', text: t('drv2_tx_title') })]));
      var body = el('div', { class: 'app-card-body adm-card-body' });
      card.appendChild(body);
      body.appendChild(el('p', { class: 'text-sm text-muted', text: t('drv2_tx_lead') }));
      var left = list.length;
      list.forEach(function (d) {
        var sid = 'drv2-c-' + d.id, pid = 'drv2-p-' + d.id;
        var sel = el('select', { class: 'form-control', id: sid });
        [['', t('drv2_class_pick')]].concat(CLASSES.map(function (c) { return [c, U.lab('driver_class', c)]; })).forEach(function (o) {
          sel.appendChild(el('option', { value: o[0], text: o[1] }));
        });
        var party = el('select', { class: 'form-control', id: pid });
        [['', t('drv2_party_pick')]].concat(carriers.map(function (c) { return [c.id, U.partyName(c) + (c.phone ? ' — ' + c.phone : '')]; })).forEach(function (o) {
          party.appendChild(el('option', { value: o[0], text: o[1] }));
        });
        var partyGrp = el('div', { class: 'form-group', hidden: true }, [el('label', { class: 'form-label', for: pid, text: t('drv2_party') }), party,
          el('span', { class: 'form-hint' }, [t('drv2_tx_party_hint') + ' ', el('a', { href: '#parties', text: t('drv2_tx_party_link') })])]);
        sel.addEventListener('change', function () { partyGrp.hidden = !sel.value || sel.value === 'individual'; });
        var msg = el('p', { class: 'form-hint', role: 'status' });
        var btn = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: t('save') });
        var box = el('div', { class: 'drv2-tx-row', 'data-id': d.id }, [
          el('div', { class: 'drv2-tx-who' }, [el('span', { class: 'cell-main', text: d.full_name || '' }), d.phone ? U.ltr(d.phone) : null,
            d.truck_plate ? el('bdi', { dir: 'ltr', class: 'drv2-plate', text: d.truck_plate }) : null, U.pill('warning', t('drv2_unclassified'))].filter(Boolean)),
          el('div', { class: 'drv2-tx-grid' }, [el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: sid, text: t('drv2_class') }), sel]), partyGrp]),
          el('div', { class: 'adm-card-actions' }, [btn]), msg]);
        btn.addEventListener('click', function () {
          var c = classifyRow(d, sel.value, sel.value === 'individual' ? null : party.value);
          if (c.error) { msg.textContent = t(c.error); return; }
          btn.disabled = true; msg.textContent = '';
          U.call(api, 'saveDriverEntry', c.row).then(function (res) {
            btn.disabled = false;
            if (res.error) { msg.textContent = U.errMsg(res.error, api); return; }
            U.toast(api, t('drv2_saved'), 'success');
            box.parentNode.removeChild(box);
            left -= 1;
            if (!left) card.hidden = true;
          });
        });
        body.appendChild(box);
      });
    }
  }
  var TXS = [{ id: 'driver_classify', order: 52, render: renderTxClassify }];
  Ops.txSections = Array.isArray(Ops.txSections) ? Ops.txSections : [];
  for (var i = Ops.txSections.length - 1; i >= 0; i--) { if (Ops.txSections[i] && Ops.txSections[i].id === 'driver_classify') Ops.txSections.splice(i, 1); }
  TXS.forEach(function (s) { Ops.txSections.push(s); });

  Ops.drivers = { VERSION: 'drv2-2', pure: { driverRow: driverRow, matches: matches, unclassifiedOf: unclassifiedOf, classifyRow: classifyRow } };
  Ops.views.drivers = { allow: 'staff', titleKey: 'ops.nav_drivers', icon: 'user',
    render: function (root, api) { if (!Ops.ui) return noKit(root); return renderList(root, api); } };
})();
