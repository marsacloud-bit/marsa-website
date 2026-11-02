/* ==========================================================================
   مرسى | MARSA — G3 operations: #parties (directory) and #parties/<id>
   (party details + a carrier's drivers and trucks)
   --------------------------------------------------------------------------
   Contract: docs/online/G3_SPEC.md ("Data model" 1, "UI scope" → #parties).
   Uses MarsaOps.ui (assets/js/ops/alerts.js).

   Staff read; transport writers add / edit / deactivate (simple directories:
   RLS-guarded direct writes behind MarsaApi.saveParty / saveDriver / saveTruck,
   which take the row with its id for an update). Nothing is deleted: a
   deactivated row disappears from new pickers and keeps its history.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var KINDS = ['shipping_agent', 'terminal_operator', 'carrier', 'yard', 'customs_broker', 'supplier', 'other'];
  var PLATE_TYPES = ['private_transport', 'public_transport', 'private', 'trailer', 'other'];
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var PHONE_RE = /^\+?[0-9 ()-]{6,20}$/;
  var IDS_RE = /^[0-9A-Za-z-]{5,20}$/;
  var PF = { q: '', kind: '', inactive: false };

  function noKit(root) { root.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing'; }

  /* ------------------------------------------------------------------
     Shared dialogs
     ------------------------------------------------------------------ */
  function partyDialog(U, api, p) {
    p = p || {};
    var t = U.t;
    return U.formModal({
      title: p.id ? t('pt_edit') : t('pt_new'), size: 'lg',
      uniqueField: 'name_ar', uniqueMsg: t('pt_name_taken'),
      fields: [
        { name: 'name_ar', label: t('f_name_ar'), required: true, max: 160, value: p.name_ar },
        { name: 'name_en', label: t('f_name_en'), max: 160, value: p.name_en, ltr: true },
        { name: 'kinds', label: t('f_kinds'), type: 'checks', required: true, requiredMsg: t('kinds_req'), full: true, hint: t('kinds_hint'),
          value: p.kinds || [], options: KINDS.map(function (k) { return [k, U.lab('party_kind', k)]; }) },
        { name: 'cr_number', label: t('f_cr'), max: 20, value: p.cr_number, ltr: true, pattern: IDS_RE, patternMsg: t('ids_invalid'), inputmode: 'numeric' },
        { name: 'vat_number', label: t('f_vat'), max: 20, value: p.vat_number, ltr: true, pattern: IDS_RE, patternMsg: t('ids_invalid'), inputmode: 'numeric' },
        { name: 'phone', label: t('f_phone'), type: 'tel', max: 20, value: p.phone, ltr: true, pattern: PHONE_RE, patternMsg: t('phone_invalid'), autocomplete: 'off' },
        { name: 'email', label: t('f_email'), type: 'email', max: 160, value: p.email, ltr: true },
        { name: 'notes', label: t('f_notes'), type: 'textarea', max: 1000, value: p.notes, rows: 2 },
        { name: 'is_active', label: t('f_active'), type: 'checkbox', value: p.id ? p.is_active !== false : true }
      ],
      submit: function (v) {
        var row = { name_ar: v.name_ar, name_en: U.nn(v.name_en), kinds: v.kinds, cr_number: U.nn(v.cr_number), vat_number: U.nn(v.vat_number),
          phone: U.nn(v.phone), email: U.nn(v.email) ? v.email.toLowerCase() : null, notes: U.nn(v.notes), is_active: v.is_active };
        if (p.id) row.id = p.id;
        return U.call(api, 'saveParty', row);
      }
    });
  }
  function driverDialog(U, api, carrierId, d) {
    d = d || {};
    var t = U.t;
    return U.formModal({
      title: d.id ? t('drv_edit') : t('drv_add'),
      fields: [
        { name: 'full_name', label: t('f_full_name'), required: true, max: 120, value: d.full_name },
        { name: 'phone', label: t('f_phone'), type: 'tel', max: 20, value: d.phone, ltr: true, pattern: PHONE_RE, patternMsg: t('phone_invalid') },
        { name: 'national_id_last4', label: t('f_nid4'), max: 4, value: d.national_id_last4, ltr: true, pattern: /^[0-9]{4}$/, patternMsg: t('nid4_invalid'), hint: t('nid4_hint'), inputmode: 'numeric' },
        { name: 'license_no', label: t('f_license'), max: 30, value: d.license_no, ltr: true },
        { name: 'is_active', label: t('active'), type: 'checkbox', value: d.id ? d.is_active !== false : true }
      ],
      submit: function (v) {
        var row = { carrier_id: carrierId, full_name: v.full_name, phone: U.nn(v.phone), national_id_last4: U.nn(v.national_id_last4),
          license_no: U.nn(v.license_no), is_active: v.is_active };
        if (d.id) row.id = d.id;
        return U.call(api, 'saveDriver', row);
      }
    });
  }
  function normPlate(s) { return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase(); }
  function truckDialog(U, api, carrierId, k) {
    k = k || {};
    var t = U.t;
    return U.formModal({
      title: k.id ? t('trk_edit') : t('trk_add'), size: 'sm',
      uniqueField: 'plate_no', uniqueMsg: t('plate_taken'),
      fields: [
        { name: 'plate_no', label: t('f_plate'), required: true, max: 20, value: k.plate_no, hint: t('plate_hint') },
        { name: 'plate_type', label: t('f_plate_type'), type: 'select', value: k.plate_type || '',
          options: [['', U.NONE]].concat(PLATE_TYPES.map(function (p) { return [p, U.lab('plate_type', p)]; })) },
        { name: 'is_active', label: t('active'), type: 'checkbox', value: k.id ? k.is_active !== false : true }
      ],
      submit: function (v) {
        var row = { carrier_id: carrierId, plate_no: normPlate(v.plate_no), plate_type: U.nn(v.plate_type), is_active: v.is_active };
        if (k.id) row.id = k.id;
        return U.call(api, 'saveTruck', row);
      }
    });
  }
  // the editable columns of each directory (a save sends the whole row, never a partial one)
  var FIELDS = {
    saveParty: ['name_ar', 'name_en', 'kinds', 'cr_number', 'vat_number', 'phone', 'email', 'notes'],
    saveDriver: ['carrier_id', 'full_name', 'phone', 'national_id_last4', 'license_no'],
    saveTruck: ['carrier_id', 'plate_no', 'plate_type']
  };
  function editable(fn, row) {
    var out = {};
    (FIELDS[fn] || []).forEach(function (k) { if (row[k] !== undefined) out[k] = row[k]; });
    return out;
  }
  // activate / deactivate a row through its save call; deactivation asks first
  function toggleActive(U, api, o) {
    var off = o.row.is_active !== false;
    var ask = off ? U.confirm(api, { title: o.title, text: o.text, okText: U.t('deactivate'), danger: true }) : Promise.resolve(true);
    return ask.then(function (yes) {
      if (!yes) return false;
      var patch = Object.assign(editable(o.fn, o.row), o.base || {}, { id: o.row.id, is_active: !off });
      return U.call(api, o.fn, patch).then(function (r) {
        if (r.error) { U.toast(api, U.errMsg(r.error, api), U.errCode(r.error) === 'MRS_UNKNOWN_RESULT' ? 'warning' : 'error'); return false; }
        U.toast(api, U.t(off ? 'deactivated' : 'activated'), 'success');
        return true;
      });
    });
  }
  function activePill(U, row) { return row.is_active === false ? U.pill('neutral', U.t('inactive')) : U.pill('success', U.t('active')); }
  function kindPills(U, kinds) {
    return U.el('div', { class: 'ops-pills' }, (kinds || []).map(function (k) { return U.pill(k === 'carrier' ? 'brand' : 'neutral', U.lab('party_kind', k)); }));
  }

  /* ------------------------------------------------------------------
     #parties — the directory
     ------------------------------------------------------------------ */
  function renderList(root, api) {
    var U = Ops.ui, el = U.el, t = U.t, sc = U.scope(root);
    var writer = U.can(api, 'transportWriter');
    var rows = [];
    U.clear(root);
    root.classList.add('ops-view', 'ops-parties');
    var addB = writer ? U.btn([U.icon('plus'), el('span', { text: t('pt_add') })], 'btn-primary', add) : null;
    root.appendChild(U.head(t('pt_title'), t('pt_sub'), addB ? [addB] : []));
    var bar = el('div'), body = el('div');
    root.appendChild(bar); root.appendChild(body);

    function load() {
      U.loadingInto(body, 6, false);
      return U.call(api, 'listParties', { active: false, limit: 500 }).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { drawBar(0); body.appendChild(U.errorState(api, r.error, load)); return; }
        rows = U.rowsOf(r.data);
        drawBar(); draw();
      });
    }
    function filtered() {
      return rows.filter(function (p) {
        return (PF.inactive || p.is_active !== false) && (!PF.kind || (p.kinds || []).indexOf(PF.kind) !== -1) &&
          U.matches(PF.q, [p.name_ar, p.name_en, p.cr_number, p.vat_number, p.phone, p.email]);
      }).sort(function (a, b) { return String(U.partyName(a)).localeCompare(String(U.partyName(b)), U.lang()); });
    }
    function drawBar() {
      U.clear(bar);
      var inact = el('label', { class: 'check ops-check ops-inline-check' }, [el('input', { type: 'checkbox', checked: PF.inactive, onchange: function (e) { PF.inactive = e.target.checked; draw(); } }), el('span', { text: t('show_inactive') })]);
      bar.appendChild(U.toolbar(U.searchBox(PF.q, t('search'), function (v) { PF.q = v; draw(); }), [
        U.select('kind', t('pt_kind_filter'), [['', t('pt_kind_filter') + ': ' + t('all')]].concat(KINDS.map(function (k) { return [k, U.lab('party_kind', k)]; })), PF.kind, function (v) { PF.kind = v; draw(); }),
        inact
      ], [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })], ''));
    }
    function draw() {
      if (!sc.alive()) return;
      var list = filtered();
      var cnt = bar.querySelector('.toolbar-count');
      if (cnt) cnt.textContent = t('shown_of', { n: list.length, total: rows.length });
      U.clear(body);
      if (!rows.length) {
        body.appendChild(U.card(null, U.emptyState('building', t('pt_empty_title'), t('pt_empty_text'), writer ? [U.btn(t('pt_add'), 'btn-primary', add)] : null)));
        return;
      }
      if (!list.length) { body.appendChild(U.card(null, U.emptyState('search', null, t('no_match'), null, true))); return; }
      body.appendChild(U.table([t('pt_col_name'), t('pt_col_kinds'), t('pt_col_ids'), t('pt_col_contact'), t('pt_col_status'), { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(function (p) {
          var acts = el('div', { class: 'ops-row-actions' });
          if (writer) {
            acts.appendChild(U.btn(t('edit'), 'btn-secondary', function () { edit(p); }));
            acts.appendChild(U.btn(t(p.is_active === false ? 'activate' : 'deactivate'), 'btn-subtle', function () {
              toggleActive(U, api, { row: p, fn: 'saveParty', title: t('pt_deact_title'), text: t('pt_deact_text', { name: U.partyName(p) }) }).then(function (ok) { if (ok && sc.alive()) load(); });
            }));
          }
          var nameA = el('a', { class: 'cell-main', href: '#parties/' + p.id, text: U.partyName(p) });
          var other = U.lang() === 'en' ? p.name_ar : p.name_en;
          return el('tr', { 'data-id': p.id, class: p.is_active === false ? 'is-muted' : null }, [
            U.td([nameA, other && other !== U.partyName(p) ? el('span', { class: 'cell-sub', text: other }) : null]),
            U.td(kindPills(U, p.kinds)),
            U.td([p.cr_number ? el('span', null, U.ltr(p.cr_number)) : null, p.vat_number ? el('span', { class: 'cell-sub' }, U.ltr(p.vat_number)) : null].filter(Boolean)),
            U.td([p.phone ? el('span', null, U.ltr(p.phone)) : null, p.email ? el('span', { class: 'cell-sub' }, U.ltr(p.email)) : null].filter(Boolean)),
            U.td(activePill(U, p)),
            U.td(acts, 'ops-col-actions')
          ]);
        }), { caption: t('pt_title') }));
    }
    function add() { partyDialog(U, api, null).then(function (res) { if (!res || !sc.alive()) return; U.toast(api, t('pt_saved'), 'success'); if (res && res.id) U.go(api, '#parties/' + res.id); else load(); }); }
    function edit(p) { partyDialog(U, api, p).then(function (res) { if (!res || !sc.alive()) return; U.toast(api, t('pt_saved'), 'success'); load(); }); }
    return load();
  }

  /* ------------------------------------------------------------------
     #parties/<id> — details, drivers, trucks
     ------------------------------------------------------------------ */
  function renderDetail(root, api, id) {
    var U = Ops.ui, el = U.el, t = U.t, sc = U.scope(root);
    var writer = U.can(api, 'transportWriter');
    var party = null;
    U.clear(root);
    root.classList.add('ops-view', 'ops-party');
    var headBox = el('div'), body = el('div', { class: 'app-stack ops-party-body' });
    root.appendChild(el('p', { class: 'ops-back' }, el('a', { href: '#parties' }, [U.icon('chevronStart', 'icon-flip ops-back-icon'), el('span', { text: t('pt_back') })])));
    root.appendChild(headBox); root.appendChild(body);

    function load() {
      U.loadingInto(body, 6, false);
      return U.call(api, 'listParties', { active: false, limit: 500 }).then(function (r) {
        if (!sc.alive()) return;
        if (r.error) { U.doneLoading(body); body.appendChild(U.errorState(api, r.error, load)); return; }
        party = U.rowsOf(r.data).filter(function (p) { return p.id === id; })[0] || null;
        if (!party) { U.doneLoading(body); body.appendChild(U.card(null, U.emptyState('search', null, t('pt_not_found'), [U.btn(t('pt_back'), 'btn-secondary', function () { U.go(api, '#parties'); })]))); return; }
        var isCarrier = (party.kinds || []).indexOf('carrier') !== -1;
        return Promise.all(isCarrier ? [U.call(api, 'listDrivers', id), U.call(api, 'listTrucks', id)] : []).then(function (res) {
          if (!sc.alive()) return;
          U.doneLoading(body);
          draw(isCarrier, res[0], res[1]);
        });
      });
    }
    function draw(isCarrier, dr, tr) {
      U.clear(headBox);
      var acts = [];
      if (writer) {
        acts.push(U.btn(t('edit'), 'btn-secondary', function () { partyDialog(U, api, party).then(function (res) { if (res && sc.alive()) { U.toast(api, t('pt_saved'), 'success'); load(); } }); }));
        acts.push(U.btn(t(party.is_active === false ? 'activate' : 'deactivate'), 'btn-subtle', function () {
          toggleActive(U, api, { row: party, fn: 'saveParty', title: t('pt_deact_title'), text: t('pt_deact_text', { name: U.partyName(party) }) }).then(function (ok) { if (ok && sc.alive()) load(); });
        }));
      }
      headBox.appendChild(U.head(U.partyName(party), U.lang() === 'en' ? party.name_ar : party.name_en, acts));
      var dl = el('dl', { class: 'app-dl' });
      function row(k, v) { if (v == null || v === '') return; dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', null, v)); }
      row(t('f_kinds'), kindPills(U, party.kinds));
      row(t('pt_col_status'), activePill(U, party));
      row(t('f_cr'), party.cr_number ? U.ltr(party.cr_number) : null);
      row(t('f_vat'), party.vat_number ? U.ltr(party.vat_number) : null);
      row(t('f_phone'), party.phone ? U.ltr(party.phone) : null);
      row(t('f_email'), party.email ? el('a', { href: 'mailto:' + party.email }, U.ltr(party.email)) : null);
      row(t('f_notes'), party.notes ? el('span', { class: 'ops-pre', text: party.notes }) : null);
      body.appendChild(U.card(t('pt_details'), dl));
      if (!isCarrier) { body.appendChild(U.alertBox('info', t('pt_not_carrier'))); return; }
      body.appendChild(el('div', { class: 'app-grid-2 ops-carrier-grid' }, [driversCard(dr), trucksCard(tr)]));
    }
    function subErr(r) { return r && r.error ? U.errorState(api, r.error, load) : null; }
    function driversCard(r) {
      var list = r && !r.error ? U.rowsOf(r.data) : [];
      var addB = writer ? [U.btn([U.icon('plus'), el('span', { text: t('drv_add') })], 'btn-secondary', function () { dlg(null); })] : [];
      function dlg(d) { driverDialog(U, api, id, d).then(function (res) { if (res && sc.alive()) { U.toast(api, t('drv_saved'), 'success'); load(); } }); }
      var content = subErr(r) || (list.length ? U.table([t('drv_col_name'), t('f_phone'), t('drv_col_id'), t('drv_col_license'), t('pt_col_status'), { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(function (d) {
          var acts = el('div', { class: 'ops-row-actions' });
          if (writer) {
            acts.appendChild(U.btn(t('edit'), 'btn-secondary', function () { dlg(d); }));
            acts.appendChild(U.btn(t(d.is_active === false ? 'activate' : 'deactivate'), 'btn-subtle', function () {
              toggleActive(U, api, { row: d, fn: 'saveDriver', base: { carrier_id: id }, title: t('drv_deact_title'), text: t('drv_deact_text', { name: d.full_name }) }).then(function (ok) { if (ok && sc.alive()) load(); });
            }));
          }
          return el('tr', { 'data-id': d.id, class: d.is_active === false ? 'is-muted' : null }, [
            U.td(el('span', { class: 'cell-main', text: d.full_name })), U.td(d.phone ? U.ltr(d.phone) : null),
            U.td(d.national_id_last4 ? U.ltr('•••• ' + d.national_id_last4) : null), U.td(d.license_no ? U.ltr(d.license_no) : null),
            U.td(activePill(U, d)), U.td(acts, 'ops-col-actions')
          ]);
        }), { compact: true, caption: t('pt_drivers') }) : U.emptyState('user', null, t('drv_empty'), null, true));
      return U.card(t('pt_drivers') + (list.length ? ' (' + list.length + ')' : ''), content, addB, { flush: true });
    }
    function trucksCard(r) {
      var list = r && !r.error ? U.rowsOf(r.data) : [];
      var addB = writer ? [U.btn([U.icon('plus'), el('span', { text: t('trk_add') })], 'btn-secondary', function () { dlg(null); })] : [];
      function dlg(k) { truckDialog(U, api, id, k).then(function (res) { if (res && sc.alive()) { U.toast(api, t('trk_saved'), 'success'); load(); } }); }
      var content = subErr(r) || (list.length ? U.table([t('trk_col_plate'), t('trk_col_type'), t('pt_col_status'), { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(function (k) {
          var acts = el('div', { class: 'ops-row-actions' });
          if (writer) {
            acts.appendChild(U.btn(t('edit'), 'btn-secondary', function () { dlg(k); }));
            acts.appendChild(U.btn(t(k.is_active === false ? 'activate' : 'deactivate'), 'btn-subtle', function () {
              toggleActive(U, api, { row: k, fn: 'saveTruck', base: { carrier_id: id }, title: t('trk_deact_title'), text: t('trk_deact_text', { name: k.plate_no }) }).then(function (ok) { if (ok && sc.alive()) load(); });
            }));
          }
          return el('tr', { 'data-id': k.id, class: k.is_active === false ? 'is-muted' : null }, [
            U.td(U.ltr(k.plate_no)), U.td(k.plate_type ? U.lab('plate_type', k.plate_type) : null), U.td(activePill(U, k)), U.td(acts, 'ops-col-actions')
          ]);
        }), { compact: true, caption: t('pt_trucks') }) : U.emptyState('truck', null, t('trk_empty'), null, true));
      return U.card(t('pt_trucks') + (list.length ? ' (' + list.length + ')' : ''), content, addB, { flush: true });
    }
    return load();
  }

  Ops.views.parties = {
    allow: 'staff', titleKey: 'ops.nav_parties', icon: 'truck',
    render: function (root, api, param) {
      if (!Ops.ui) return noKit(root);
      return param && UUID_RE.test(param) ? renderDetail(root, api, param) : renderList(root, api);
    }
  };
})();
