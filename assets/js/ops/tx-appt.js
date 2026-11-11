/* ==========================================================================
   مرسى | MARSA — legacy step 5 UI on the transaction page (#tx/<id>)  →  MarsaOps.txAppt
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_APPT_AR.md (20261121000100). Loaded after tx-decl.js, before admin.js.
   Sections:
     * 'readiness' (order 5, first): the readiness banner (tx_readiness) — the containers still missing a VERIFIED empty
       return, why billing is blocked (the read-only policy empty_return_blocks_billing; under_billing keeps failing with
       MRS_CONTAINERS_NOT_RETURNED), overdue deadlines, proofs waiting for a staff confirmation, a TASTO order that does NOT
       bypass the proof;
     * 'appointment_cards' (order 51, after the appointments): «قراءة بطاقات المواعيد» → ocr.html#appt-tx=<id> (transport
       writers of the branch, a live transaction) and the open card draft of the transaction (get_appointment_draft);
     * 'carrier_order' (order 57): the TASTO transport-company order (company, order no, date) → save_transport_carrier_order,
       with the rule that the empty-return proof is still required.
   * Strings: namespace 'appt' (assets/i18n/appt.js). The UI only hides what a role cannot do; the RPCs decide.
   * Server data only via textContent / createElement (api.el). ES5, no library.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  if (!Array.isArray(OPS.txSections)) OPS.txSections = [];

  function T(k, vars) {
    var key = 'appt.' + k;
    if (!I || typeof I.t !== 'function') return k;
    var s = I.t(key, vars);
    return s === key ? k : s;
  }
  function western(s) {
    return String(s == null ? '' : s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
  }
  function cardsLink(txId) { return 'ocr.html#appt-tx=' + encodeURIComponent(String(txId || '')); }
  // TASTO + digits (app.norm_code: upper case, no spaces)
  function normOrderNo(v) { return western(v).toUpperCase().replace(/\s+/g, ''); }
  function orderNoOk(v) { return /^TASTO[0-9]{1,20}$/.test(normOrderNo(v)); }
  // legacy saveTransportCompanyOrder: not before the customs release («جديد» / «نشطة» = new / in_progress / customs_declaration)
  var NO_TASTO_STAGES = ['new', 'in_progress', 'customs_declaration'];
  // the form values → the saveTransportCarrierOrder options, or {error: key}
  function carrierPayload(v) {
    v = v || {};
    var no = normOrderNo(v.orderNo);
    if (!no) return { error: 'co_e_no_required' };
    if (!orderNoOk(no)) return { error: 'co_e_no' };
    var d = western(v.orderDate).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'co_e_date' };
    var o = { orderNo: no, orderDate: d };
    if (v.partyId && v.partyId !== '__new') o.partyId = v.partyId;
    else if (String(v.companyName || '').trim()) o.companyName = String(v.companyName).trim().slice(0, 160);
    else return { error: 'co_e_company' };
    return o;
  }
  // the readiness banner model: tone + the lines (pure, from tx_readiness)
  function readinessView(r) {
    r = r || {};
    var pend = Array.isArray(r.pending_containers) ? r.pending_containers : [];
    var open = r.billing_gate_open === true;
    return {
      open: open, tone: open ? 'success' : 'warning', blocking: r.blocking || null,
      pending: pend.map(function (c) {
        return { id: c.container_id, no: c.container_no, status: c.return_status || 'pending', deadline: c.return_deadline || null,
          overdue: !!c.overdue, proofs: Number(c.proofs_pending) || 0 };
      }),
      pendingCount: r.pending_count != null ? Number(r.pending_count) : pend.length,
      declaredMissing: Number(r.declared_missing) || 0,
      total: Number(r.containers_total) || 0,
      proofs: r.proofs || {},
      policyLocked: !(r.policy && r.policy.switchable === true),
      blocksBilling: !(r.policy && r.policy.empty_return_blocks_billing === false),
      carrier: r.carrier_order && r.carrier_order.order_no ? r.carrier_order : null
    };
  }

  function call(api, name) {
    var A = api && (api.MarsaApi || api), f = A && A[name];
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof f !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', message: name } });
    return Promise.resolve().then(function () { return f.apply(A, args); })
      .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
  }
  function errText(api, e) { return api && typeof api.errText === 'function' ? api.errText(e) : ((e && e.message) || String(e)); }
  function label(api, domain, code) {
    if (code == null || code === '') return T('none');
    if (api && typeof api.label === 'function') { try { var s = api.label(domain, code); if (s && s !== code) return s; } catch (e) { /* below */ } }
    var k = 'rs_' + code, x = T(k);
    return x === k ? String(code) : x;
  }
  function card(api, cls, title, actions) {
    var el = api.el;
    var head = el('header', { class: 'app-card-head adm-card-head' }, [el('h3', { class: 'app-card-title', text: title }), actions || null]);
    var body = el('div', { class: 'app-card-body adm-card-body' }, el('p', { class: 'text-sm text-muted', text: T('loading') }));
    return { node: el('section', { class: 'app-card adm-card ops-tx-card ' + cls }, [head, body]), body: body };
  }
  function ltr(api, v) { return api.el('bdi', { dir: 'ltr', class: 'num', text: String(v == null ? '' : v) }); }

  /* ---------- the readiness banner ---------- */
  function renderReadiness(root, tx, api) {
    var el = api.el;
    var box = el('div', { class: 'appt-ready', 'data-readiness': '1', role: 'status' }, el('p', { class: 'text-sm text-muted', text: T('loading') }));
    root.appendChild(box);
    return call(api, 'txReadiness', tx.id).then(function (r) {
      box.textContent = '';
      if (r.error) { box.appendChild(el('p', { class: 'text-sm text-muted', text: T('rd_error') + ' ' + errText(api, r.error) })); return; }
      var v = readinessView(r.data);
      var a = el('div', { class: 'alert alert-' + v.tone + ' appt-ready-box' });
      box.appendChild(a);
      if (v.open) {
        a.appendChild(el('strong', { text: v.total ? T('rd_open') : T('rd_open_none') }));
        a.appendChild(el('p', { class: 'appt-ready-line', text: T('rd_policy') }));
        return;
      }
      a.appendChild(el('strong', { class: 'appt-ready-title', text: T('rd_blocked_title') }));
      a.appendChild(el('p', { class: 'appt-ready-line', text: T('rd_blocked_why', { n: v.pendingCount }) }));
      if (v.pending.length) {
        a.appendChild(el('ul', { class: 'appt-ready-list' }, v.pending.map(function (c) {
          return el('li', null, [ltr(api, c.no), ' ',
            el('span', { class: 'badge badge-sm badge-' + (c.status === 'evidence_submitted' ? 'info' : c.status === 'disputed' ? 'danger' : 'warning'), text: label(api, 'container_return_status', c.status) }),
            c.deadline ? el('span', { class: 'adm-sub', text: ' · ' + T('rd_deadline', { d: c.deadline }) }) : null,
            c.overdue ? el('span', { class: 'badge badge-sm badge-danger', text: T('rd_overdue') }) : null,
            c.proofs ? el('span', { class: 'adm-sub', text: ' · ' + T('rd_proofs_pending', { n: c.proofs }) }) : el('span', { class: 'adm-sub', text: ' · ' + T('rd_no_proof') })]);
        })));
      }
      if (v.declaredMissing) a.appendChild(el('p', { class: 'appt-ready-line', text: T('rd_declared_missing', { n: v.declaredMissing }) }));
      if (v.carrier) a.appendChild(el('p', { class: 'appt-ready-line', text: T('rd_carrier', { no: v.carrier.order_no, party: v.carrier.party_name || T('none') }) }));
      a.appendChild(el('p', { class: 'appt-ready-line', text: T('rd_policy') }));
      a.appendChild(el('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: T('rd_go_proofs'), onclick: function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var d = typeof document !== 'undefined' ? document.getElementById('tx-empty-return') : null;
        if (d && d.scrollIntoView) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } }));
    });
  }

  /* ---------- the appointment cards (draft summary + link) ---------- */
  function renderCards(root, tx, api) {
    var el = api.el;
    var canWrite = !api.cancelled && !tx.cancelled_at && api.can('transportWriter', tx.branch_id);
    var c = card(api, 'appt-tx-cards', T('tc_title'),
      el('div', { class: 'adm-card-actions' }, canWrite ? el('a', { class: 'btn btn-sm btn-primary', href: cardsLink(tx.id), text: T('tc_read_link') }) : null));
    root.appendChild(c.node);
    return call(api, 'getAppointmentDraft', tx.id).then(function (r) {
      var body = c.body;
      body.textContent = '';
      if (r.error) { body.appendChild(el('p', { class: 'text-sm text-muted', text: errText(api, r.error) })); return; }
      var b = r.data;
      if (!b) body.appendChild(el('p', { class: 'text-sm text-muted', text: T('tc_none') }));
      else {
        var n = { pending: 0, approved: 0, failed: 0, skipped: 0 };
        (Array.isArray(b.cards) ? b.cards : []).forEach(function (x) { if (Object.prototype.hasOwnProperty.call(n, x.status)) n[x.status]++; });
        body.appendChild(el('p', { class: 'appt-tc-line' }, [
          el('span', { class: 'badge badge-sm badge-' + (b.status === 'partial' ? 'info' : 'warning'), text: T('bst_' + b.status) }), ' ',
          el('span', { text: T('tc_counts', { pending: n.pending, failed: n.failed, approved: n.approved, skipped: n.skipped }) })]));
        body.appendChild(el('a', { href: cardsLink(tx.id), class: 'appt-tc-open', text: canWrite ? T('tc_continue') : T('tc_view') }));
      }
      body.appendChild(el('p', { class: 'form-hint', text: T('tc_hint') }));
    });
  }

  /* ---------- the TASTO carrier order ---------- */
  function renderCarrier(root, tx, api) {
    var el = api.el;
    var canWrite = !api.cancelled && !tx.cancelled_at && api.can('transportWriter', tx.branch_id);
    var c = card(api, 'appt-tx-carrier', T('co_title'));
    root.appendChild(c.node);
    var body = c.body;
    // read-only staff also load the carriers, so the current order shows its company name
    var needParties = canWrite || (tx.transport_mode === 'carrier_order' && tx.transport_party_id);
    var partiesP = needParties ? call(api, 'listParties', { kind: 'carrier', limit: 200 }) : Promise.resolve({ data: [], error: null });
    return partiesP.then(function (pr) {
      var parties = !pr.error && Array.isArray(pr.data) ? pr.data : [];
      body.textContent = '';
      var cur = tx.transport_mode === 'carrier_order' && tx.transport_order_no ? tx : null;
      var curParty = cur ? (parties.filter(function (p) { return p.id === tx.transport_party_id; })[0] || null) : null;
      if (cur) {
        body.appendChild(el('p', { class: 'appt-co-current' }, [el('strong', { text: T('co_current') + ' ' }), ltr(api, cur.transport_order_no),
          el('span', { class: 'adm-sub', text: ' · ' + [cur.transport_order_date, curParty ? curParty.name_ar : null].filter(Boolean).join(' · ') })]));
      } else body.appendChild(el('p', { class: 'text-sm text-muted', text: T('co_none') }));
      // the owner decision (2026-11-11): a carrier order never replaces the empty-return proof
      body.appendChild(el('div', { class: 'alert alert-info appt-co-note', role: 'note' }, el('span', { text: T('co_note') })));
      if (!canWrite) return;
      var stageBlocked = NO_TASTO_STAGES.indexOf(tx.operational_status) !== -1;
      var form = el('div', { class: 'appt-co-form' });
      var sel = el('select', { class: 'form-control', id: 'appt-co-party', 'aria-label': T('co_company') });
      var o0 = el('option', { text: T('choose') }); o0.value = ''; sel.appendChild(o0);
      parties.forEach(function (p) { var o = el('option', { text: p.name_ar || p.name_en || '' }); o.value = p.id; o.selected = !!cur && p.id === tx.transport_party_id; sel.appendChild(o); });
      var oNew = el('option', { text: T('co_new_company') }); oNew.value = '__new'; sel.appendChild(oNew);
      if (!parties.length) oNew.selected = true;
      var nameInp = el('input', { class: 'form-control', id: 'appt-co-name', maxlength: '160', 'aria-label': T('co_company_name') }); nameInp.type = 'text';
      var noInp = el('input', { class: 'form-control', id: 'appt-co-no', maxlength: '30', dir: 'ltr', placeholder: 'TASTO…', 'aria-label': T('co_no') }); noInp.type = 'text';
      noInp.value = cur ? cur.transport_order_no : '';
      var dInp = el('input', { class: 'form-control', id: 'appt-co-date', 'aria-label': T('co_date') }); dInp.type = 'date';
      dInp.value = cur && cur.transport_order_date ? String(cur.transport_order_date).slice(0, 10) : '';
      var nameGroup = grp(api, T('co_company_name'), nameInp);
      function syncName() { nameGroup.hidden = sel.value !== '__new'; }
      sel.addEventListener('change', syncName);
      syncName();
      form.appendChild(grp(api, T('co_company'), sel));
      form.appendChild(nameGroup);
      form.appendChild(grp(api, T('co_no'), noInp, T('co_no_hint')));
      form.appendChild(grp(api, T('co_date'), dInp));
      var msg = el('p', { class: 'appt-error', role: 'alert' }); msg.hidden = true;
      var save = el('button', { class: 'btn btn-sm btn-primary', type: 'button', id: 'appt-co-save', text: cur ? T('co_update') : T('co_save') });
      [sel, nameInp, noInp, dInp, save].forEach(function (n) { n.disabled = stageBlocked; });
      var key = null, keySig = null;
      save.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var o = carrierPayload({ orderNo: noInp.value, orderDate: dInp.value, partyId: sel.value, companyName: nameInp.value });
        if (o.error) { msg.textContent = T(o.error); msg.hidden = false; return; }
        var sig = JSON.stringify(o);
        if (sig !== keySig) { keySig = sig; key = typeof api.newIdemKey === 'function' ? api.newIdemKey() : null; }
        o.idemKey = key;
        msg.hidden = true; save.disabled = true;
        call(api, 'saveTransportCarrierOrder', tx.id, o).then(function (r) {
          save.disabled = false;
          if (r.error) { msg.textContent = errText(api, r.error); msg.hidden = false; return; }
          keySig = null;
          var d = r.data || {};
          if (api.toast) api.toast(d.already_exists ? T('co_same') : T('co_saved', { no: d.order_no || o.orderNo }), 'success');
          if (typeof api.refresh === 'function') api.refresh();
        });
      });
      form.appendChild(msg);
      form.appendChild(el('div', { class: 'appt-actions' }, save));
      if (stageBlocked) form.appendChild(el('p', { class: 'form-hint appt-warn', text: T('co_stage', { s: label(api, 'operational_status', tx.operational_status) }) }));
      body.appendChild(form);
    });
  }
  function grp(api, text, inp, hint) {
    var el = api.el, id = inp.getAttribute('id') || ('appt-g-' + Math.random().toString(36).slice(2));
    var g = el('div', { class: 'form-group appt-field' }, [el('label', { class: 'form-label', for: id, text: text }), inp]);
    if (hint) g.appendChild(el('span', { class: 'form-hint', text: hint }));
    return g;
  }

  OPS.txAppt = { VERSION: 'appt-tx-1', t: T,
    pure: { cardsLink: cardsLink, normOrderNo: normOrderNo, orderNoOk: orderNoOk, carrierPayload: carrierPayload, readinessView: readinessView, NO_TASTO_STAGES: NO_TASTO_STAGES } };
  var MINE = [
    { id: 'readiness', order: 5, placement: 'top', render: renderReadiness },     // admin.js: above the transaction cards
    { id: 'appointment_cards', order: 51, render: renderCards },
    { id: 'carrier_order', order: 57, render: renderCarrier }
  ];
  var ids = MINE.map(function (s) { return s.id; });
  for (var i = OPS.txSections.length - 1; i >= 0; i--) {
    if (OPS.txSections[i] && ids.indexOf(OPS.txSections[i].id) !== -1) OPS.txSections.splice(i, 1);
  }
  MINE.forEach(function (s) { OPS.txSections.push(s); });
})();
