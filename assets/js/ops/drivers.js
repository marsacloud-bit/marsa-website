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

  Ops.drivers = { VERSION: 'drv2-1', pure: { driverRow: driverRow, matches: matches } };
  Ops.views.drivers = { allow: 'staff', titleKey: 'ops.nav_drivers', icon: 'user',
    render: function (root, api) { if (!Ops.ui) return noKit(root); return renderList(root, api); } };
})();
