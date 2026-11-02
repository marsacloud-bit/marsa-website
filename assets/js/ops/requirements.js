/* ==========================================================================
   مرسى | MARSA — G3 operations: #requirements (document rules per stage)
   --------------------------------------------------------------------------
   Contract: docs/online/G3_SPEC.md ("Data model" 7, "UI scope" → #requirements).
   Uses MarsaOps.ui (assets/js/ops/alerts.js).

   document_requirements(operation / mode / port NULL = any, document_kind,
   required_for_stage, is_optional (listed, never blocks), is_active, note),
   grouped by the stage they gate. "Any" stays NULL on save (an edit never
   narrows an any-mode rule to one mode). The org
   admin adds / edits / deactivates rules (saveRequirement takes the row with its
   id for an update); rules are never deleted. set_transaction_status refuses a
   forward move into a stage while one of its rules is missing (MRS_DOCS_MISSING).
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};

  var STAGES = ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return', 'operationally_complete', 'under_billing', 'billed', 'closed'];
  var GATED = STAGES.slice(1);   // a rule gates the move INTO a stage; nothing moves into "new"
  var OPERATIONS = ['import', 'export'];
  var MODES = ['sea', 'air', 'land'];
  var DOC_KINDS = ['bill_of_lading', 'commercial_invoice', 'packing_list', 'certificate_of_origin', 'saber_certificate', 'customs_declaration',
    'delivery_order', 'appointment', 'container_delivery_eir', 'empty_return_note', 'empty_return_receipt', 'operator_invoice', 'government_doc', 'import_file', 'other'];
  var RF = { operation: '', mode: '', stage: '', inactive: false };

  function noKit(root) { root.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing'; }
  function portKey(p) { return String(p || '').trim().toLowerCase(); }
  // NULL operation / mode = any: an "any" rule also applies under a mode / operation filter
  function scopeMatch(v, f) { return !f || v == null || v === f; }

  function render(root, api) {
    var U = Ops.ui;
    if (!U) return noKit(root);
    var el = U.el, t = U.t, sc = U.scope(root);
    var admin = U.can(api, 'orgAdmin');
    var rows = [];
    U.clear(root);
    root.classList.add('ops-view', 'ops-requirements');
    var addB = admin ? U.btn([U.icon('plus'), el('span', { text: t('rq_add') })], 'btn-primary', function () { edit(null); }) : null;
    root.appendChild(U.head(t('rq_title'), t('rq_sub'), addB ? [addB] : []));
    if (!admin) root.appendChild(U.alertBox('info', t('rq_read_only')));
    var bar = el('div'), body = el('div', { class: 'ops-groups' });
    root.appendChild(bar); root.appendChild(body);

    function load() {
      U.loadingInto(body, 8, false);
      return U.call(api, 'listRequirements').then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { drawBar(); body.appendChild(U.errorState(api, r.error, load)); return; }
        rows = U.rowsOf(r.data);
        drawBar(); draw();
      });
    }
    function drawBar() {
      U.clear(bar);
      var inact = el('label', { class: 'check ops-check ops-inline-check' }, [el('input', { type: 'checkbox', checked: RF.inactive, onchange: function (e) { RF.inactive = e.target.checked; draw(); } }), el('span', { text: t('show_inactive') })]);
      bar.appendChild(U.toolbar(null, [
        U.select('operation', t('f_operation'), [['', t('f_operation') + ': ' + t('all')]].concat(OPERATIONS.map(function (o) { return [o, U.lab('op', o)]; })), RF.operation, function (v) { RF.operation = v; draw(); }),
        U.select('mode', t('f_mode'), [['', t('f_mode') + ': ' + t('all')]].concat(MODES.map(function (m) { return [m, U.lab('mode', m)]; })), RF.mode, function (v) { RF.mode = v; draw(); }),
        U.select('stage', t('rq_f_stage'), [['', t('rq_f_stage') + ': ' + t('all')]].concat(GATED.map(function (s) { return [s, U.lab('operational_status', s, api)]; })), RF.stage, function (v) { RF.stage = v; draw(); }),
        inact
      ], [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })], ''));
    }
    function filtered() {
      return rows.filter(function (r) {
        return (RF.inactive || r.is_active !== false) && scopeMatch(r.operation, RF.operation) && scopeMatch(r.mode, RF.mode) &&
          (!RF.stage || r.required_for_stage === RF.stage);
      });
    }
    function draw() {
      if (!sc.alive()) return;
      var list = filtered();
      var cnt = bar.querySelector('.toolbar-count');
      if (cnt) cnt.textContent = t('shown_of', { n: list.length, total: rows.length });
      U.clear(body);
      if (!rows.length) {
        body.appendChild(U.card(null, U.emptyState('list', t('rq_empty_title'), t('rq_empty_text'), admin ? [U.btn(t('rq_add'), 'btn-primary', function () { edit(null); })] : null)));
        return;
      }
      if (!list.length) { body.appendChild(U.card(null, U.emptyState('search', null, t('no_match'), null, true))); return; }
      var stages = STAGES.concat(list.map(function (r) { return r.required_for_stage; }).filter(function (s, i, a) { return STAGES.indexOf(s) === -1 && a.indexOf(s) === i; }));
      stages.forEach(function (s) {
        var g = list.filter(function (r) { return r.required_for_stage === s; });
        if (!g.length) return;
        g.sort(function (a, b) {
          // "any" (NULL → -1) first
          return OPERATIONS.indexOf(a.operation) - OPERATIONS.indexOf(b.operation) || MODES.indexOf(a.mode) - MODES.indexOf(b.mode) ||
            DOC_KINDS.indexOf(a.document_kind) - DOC_KINDS.indexOf(b.document_kind) || portKey(a.port).localeCompare(portKey(b.port));
        });
        var title = t('rq_group', { stage: U.lab('operational_status', s, api) });
        body.appendChild(U.card(title + ' (' + g.length + ')', U.table([t('rq_col_doc'), t('rq_col_scope'), t('f_port'), t('rq_col_note'), t('rq_col_status'), { label: t('actions'), cls: 'ops-col-actions' }],
          g.map(rowNode), { compact: true, caption: title }), null, { flush: true, cls: 'ops-group' }));
      });
    }
    function rowNode(r) {
      var acts = el('div', { class: 'ops-row-actions' });
      if (admin) {
        acts.appendChild(U.btn(t('edit'), 'btn-secondary', function () { edit(r); }));
        acts.appendChild(U.btn(t(r.is_active === false ? 'activate' : 'deactivate'), 'btn-subtle', function () { toggle(r); }));
      }
      return el('tr', { 'data-id': r.id, class: r.is_active === false ? 'is-muted' : null }, [
        U.td(el('span', { class: 'cell-main', text: U.lab('document_kind', r.document_kind, api) })),
        U.td(el('div', { class: 'ops-pills' }, [
          U.pill('info', r.operation ? U.lab('op', r.operation) : t('f_operation') + ': ' + t('rq_any')),
          U.pill('neutral', r.mode ? U.lab('mode', r.mode) : t('f_mode') + ': ' + t('rq_any')),
          r.is_optional ? U.pill('warning', t('rq_optional_pill')) : null].filter(Boolean))),
        U.td(r.port ? U.ltr(r.port) : el('span', { class: 'ops-muted', text: t('port_any') })),
        U.td(r.note ? el('span', { class: 'ops-note', text: r.note }) : null),
        U.td(r.is_active === false ? U.pill('neutral', t('inactive')) : U.pill('success', t('active'))),
        U.td(acts, 'ops-col-actions')
      ]);
    }
    function rowOf(v, base) {
      // '' (any) → null, never a default mode / operation
      var out = { operation: U.nn(v.operation), mode: U.nn(v.mode), port: U.nn(v.port), document_kind: v.document_kind, required_for_stage: v.required_for_stage,
        is_optional: !!v.is_optional, is_active: v.is_active, note: U.nn(v.note) };
      if (base && base.id) out.id = base.id;
      return out;
    }
    function duplicateOf(v, selfId) {
      return rows.filter(function (r) {
        return r.id !== selfId && r.is_active !== false && (r.operation || null) === (U.nn(v.operation) || null) && (r.mode || null) === (U.nn(v.mode) || null) && r.document_kind === v.document_kind &&
          r.required_for_stage === v.required_for_stage && portKey(r.port) === portKey(v.port);
      })[0] || null;
    }
    function edit(r) {
      r = r || {};
      U.formModal({
        title: r.id ? t('rq_edit') : t('rq_add'),
        uniqueField: 'document_kind', uniqueMsg: t('rq_dup'),
        fields: [
          // an existing "any" rule keeps '' (NULL); a new rule starts as import / sea
          { name: 'operation', label: t('f_operation'), type: 'select', value: r.id ? (r.operation || '') : 'import', options: [['', t('rq_any')]].concat(OPERATIONS.map(function (o) { return [o, U.lab('op', o)]; })) },
          { name: 'mode', label: t('f_mode'), type: 'select', value: r.id ? (r.mode || '') : 'sea', options: [['', t('rq_any')]].concat(MODES.map(function (m) { return [m, U.lab('mode', m)]; })) },
          { name: 'document_kind', label: t('f_doc_kind'), type: 'select', required: true, value: r.document_kind || '', options: [['', U.NONE]].concat(DOC_KINDS.map(function (k) { return [k, U.lab('document_kind', k, api)]; })) },
          { name: 'required_for_stage', label: t('f_stage'), type: 'select', required: true, value: r.required_for_stage || '', options: [['', U.NONE]].concat(GATED.map(function (s) { return [s, U.lab('operational_status', s, api)]; })) },
          { name: 'port', label: t('f_port'), max: 80, value: r.port, hint: t('port_hint'), placeholder: t('port_any') },
          { name: 'is_optional', label: t('f_rule_optional'), type: 'checkbox', value: r.is_optional === true, hint: t('f_rule_optional_hint') },
          { name: 'is_active', label: t('f_rule_active'), type: 'checkbox', value: r.id ? r.is_active !== false : true },
          { name: 'note', label: t('note'), type: 'textarea', max: 500, rows: 2, value: r.note }
        ],
        validate: function (v) { return v.is_active && duplicateOf(v, r.id) ? { document_kind: t('rq_dup') } : null; },
        submit: function (v) { return U.call(api, 'saveRequirement', rowOf(v, r)); }
      }).then(function (res) {
        if (!res || !sc.alive()) return;
        U.toast(api, t('rq_saved'), 'success');
        load();
      });
    }
    function toggle(r) {
      var off = r.is_active !== false;
      var stage = U.lab('operational_status', r.required_for_stage, api);
      (off ? U.confirm(api, { title: t('rq_deact_title'), text: t('rq_deact_text', { stage: stage }), okText: t('deactivate'), danger: true }) : Promise.resolve(true)).then(function (yes) {
        if (!yes) return;
        if (!off && duplicateOf(r, r.id)) { U.toast(api, t('rq_dup'), 'warning'); return; }
        var row = rowOf({ operation: r.operation, mode: r.mode, port: r.port, document_kind: r.document_kind, required_for_stage: r.required_for_stage,
          is_optional: r.is_optional === true, note: r.note, is_active: !off }, r);
        U.call(api, 'saveRequirement', row).then(function (res) {
          if (!sc.alive()) return;
          if (res.error) { U.toast(api, U.errMsg(res.error, api), U.errCode(res.error) === 'MRS_UNKNOWN_RESULT' ? 'warning' : 'error'); return; }
          U.toast(api, t(off ? 'deactivated' : 'activated'), 'success');
          load();
        });
      });
    }
    return load();
  }

  Ops.views.requirements = {
    allow: 'orgAdmin', titleKey: 'ops.nav_requirements', icon: 'list',
    render: function (root, api) { return render(root, api); }
  };
})();
