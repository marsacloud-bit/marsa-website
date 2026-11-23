/* ==========================================================================
   مرسى | MARSA — owner stage 3ج: storage (groundage) invoice per container + the appointment gate on the transaction
   page (#tx/<id>)  →  MarsaOps.txStorage
   --------------------------------------------------------------------------
   Contract: migration 20261206000100_storage_gate.sql. Section 'storage' (order 45: after «الحاويات», before the
   appointments), shown only where the gate applies (an active storage_gate_ports row for the transaction's port — Jeddah
   today — on a container transaction):
     * a banner: red «لا يُحجز الموعد قبل سداد فاتورة الأرضيات» while a container is not settled (NULL / issued / sent and
       no manager approval), green once every container is «لا توجد أرضيات» / «سُددت» or a manager approved;
     * one row per container: the state (status_labels container_storage_state), the invoice number, the amount, a save
       button (MarsaApi.updateContainerStorage; RLS: transport writers); the reminder for issued / sent;
     * the manager approval (MarsaApi.approveStorageOverride) for senior ops while blocked: a reason, then «وافق … على حجز
       الموعد قبل السداد» stays shown (who / when / why).
   The server refuses every new appointment while blocked (MRS_STORAGE_UNPAID); this section only guides.
   Read side: MarsaApi.txStorageGate (one call). Strings: namespace 'ops' (stg_*), ar + en.
   Server data only via textContent / createElement (api.el). ES5, no library.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  if (!Array.isArray(OPS.txSections)) OPS.txSections = [];
  var STATES = ['none', 'issued', 'sent', 'paid'];

  function T(k, vars) {
    var key = 'ops.' + k;
    if (!I || typeof I.t !== 'function') return k;
    var s = I.t(key, vars);
    return s === key ? k : s;
  }
  // pure: the view of a gate result → { show, blocked, tone, rows [{ id, no, state, settled, remind }], override }
  function gateView(g) {
    g = g || {};
    if (!g.applies) return { show: false };
    var rows = (Array.isArray(g.containers) ? g.containers : []).map(function (c) {
      var st = STATES.indexOf(c.storage_state) !== -1 ? c.storage_state : null;
      return { id: c.id, no: c.container_no || '', state: st, settled: st === 'none' || st === 'paid',
        remind: st === 'issued' ? 'stg_remind_issued' : st === 'sent' ? 'stg_remind_sent' : null,
        invoice: c.storage_invoice_no || '', amount: c.storage_amount == null ? '' : String(Number(c.storage_amount)),
        sentAt: c.storage_sent_at || null, paidAt: c.storage_paid_at || null };
    });
    var blocked = !!g.blocked, unsettled = rows.some(function (r) { return !r.settled; });
    // open by a manager approval while a container is still unsettled: yellow, the follow-up goes on
    var byOverride = !blocked && !!g.override && unsettled;
    return { show: true, blocked: blocked, byOverride: byOverride, tone: blocked ? 'danger' : byOverride ? 'warning' : 'success', rows: rows, override: g.override || null,
      canOverride: !!g.can_override && blocked && !g.override };
  }
  // pure: the patch of a row form → { patch } | { error }
  function rowPatch(form) {
    form = form || {};
    var st = form.state === '' || form.state == null ? null : String(form.state);
    if (st !== null && STATES.indexOf(st) === -1) return { error: 'state' };
    var amt = String(form.amount == null ? '' : form.amount).trim().replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); }).replace(/[٫,]/g, '.');
    if (amt !== '' && !/^\d+(\.\d{1,2})?$/.test(amt)) return { error: 'amount' };
    var inv = String(form.invoice == null ? '' : form.invoice).trim().slice(0, 60);
    return { patch: { storage_state: st, storage_invoice_no: inv || null, storage_amount: amt === '' ? null : Number(amt) } };
  }

  function call(api, name) {
    var A = api && (api.MarsaApi || api), f = A && A[name];
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof f !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', message: name } });
    return Promise.resolve().then(function () { return f.apply(A, args); })
      .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
  }
  function errText(api, e) { return api && typeof api.errText === 'function' ? api.errText(e) : ((e && e.message) || String(e)); }
  function fmt(api, d) { return api && api.fmtDate ? api.fmtDate(d, true) : String(d || ''); }

  function renderStorage(root, tx, api) {
    if (!tx || tx.cargo_unit_type === 'roro') return null;
    var el = api.el;
    var A = api.MarsaApi || api;
    if (!A || typeof A.txStorageGate !== 'function') return null;
    var card = el('section', { class: 'app-card adm-card ops-tx-card stg-card', 'aria-live': 'polite', hidden: true });
    root.appendChild(card);
    var canWrite = !api.cancelled && !tx.cancelled_at && (typeof api.can !== 'function' || api.can('transportWriter', tx.branch_id) || api.can('opsWriter', tx.branch_id));
    function load() {
      return call(api, 'txStorageGate', tx.id).then(function (r) {
        card.textContent = '';
        // before the migration (no function yet) or no right: nothing to show
        if (r.error) { card.hidden = true; return; }
        paint(gateView(r.data));
      });
    }
    function paint(v) {
      if (!v.show) { card.hidden = true; return; }
      card.hidden = false;
      // the transaction tabs (admin.js txTabs) mark «الحاويات والأرضيات» from this
      if (v.blocked || v.byOverride) card.setAttribute('data-tab-flag', v.blocked ? 'danger' : 'warning'); else card.removeAttribute('data-tab-flag');
      card.appendChild(el('header', { class: 'app-card-head adm-card-head' }, [el('h3', { class: 'app-card-title', text: T('stg_title') })]));
      var body = el('div', { class: 'app-card-body adm-card-body' });
      card.appendChild(body);
      body.appendChild(el('div', { class: 'alert alert-' + v.tone + ' stg-banner', role: v.blocked ? 'alert' : 'status' },
        el('div', { text: (v.blocked ? '✗ ' : v.byOverride ? '! ' : '✓ ') + T(v.blocked ? 'stg_blocked' : v.byOverride ? 'stg_open_override' : 'stg_open') })));
      body.appendChild(el('p', { class: 'text-sm text-muted', text: T('stg_lead') }));
      if (!v.rows.length) body.appendChild(el('p', { class: 'text-sm', text: T('stg_none_ctr') }));
      v.rows.forEach(function (row) { body.appendChild(rowNode(row)); });
      if (v.override) {
        body.appendChild(el('p', { class: 'stg-override-done' }, el('bdi', { dir: 'auto', text: T('stg_override_done', {
          who: v.override.approved_by_name || '—', d: fmt(api, v.override.approved_at), reason: v.override.reason || '' }) })));
      }
      if (v.canOverride) body.appendChild(overrideForm());
    }
    function rowNode(row) {
      var sid = 'stg-s-' + row.id, iid = 'stg-i-' + row.id, aid = 'stg-a-' + row.id;
      var sel = el('select', { class: 'form-control', id: sid });
      [''].concat(STATES).forEach(function (s) {
        var o = el('option', { value: s, text: T(s ? 'stg_state_' + s : 'stg_state_null') });
        if ((row.state || '') === s) o.selected = true;
        sel.appendChild(o);
      });
      var inv = el('input', { class: 'form-control', id: iid, type: 'text', maxlength: '60', dir: 'ltr', lang: 'en', autocomplete: 'off', value: row.invoice });
      var amt = el('input', { class: 'form-control num', id: aid, type: 'text', maxlength: '14', dir: 'ltr', lang: 'en', inputmode: 'decimal', autocomplete: 'off', value: row.amount });
      var msg = el('p', { class: 'form-hint', role: 'status' });
      var btn = canWrite ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: T('stg_save') }) : null;
      sel.disabled = inv.disabled = amt.disabled = !canWrite;
      var tone = row.settled ? 'is-ok' : row.state ? 'is-warn' : 'is-bad';
      var head = el('div', { class: 'stg-row-head' }, [
        el('span', { class: 'stg-dot ' + tone, 'aria-hidden': 'true', text: row.settled ? '✓' : row.state ? '!' : '✗' }),
        el('bdi', { dir: 'ltr', class: 'stg-no', text: row.no }),
        row.paidAt ? el('span', { class: 'cell-sub', text: T('stg_paid_on', { d: fmt(api, row.paidAt) }) })
          : row.sentAt ? el('span', { class: 'cell-sub', text: T('stg_sent_on', { d: fmt(api, row.sentAt) }) }) : null
      ]);
      var grid = el('div', { class: 'stg-row-grid' }, [
        el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: sid, text: T('stg_state') }), sel]),
        el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: iid, text: T('stg_invoice') }), inv]),
        el('div', { class: 'form-group' }, [el('label', { class: 'form-label', for: aid, text: T('stg_amount') }), amt])
      ]);
      var box = el('div', { class: 'stg-row' }, [head, grid,
        row.remind ? el('p', { class: 'stg-remind', role: 'note', text: '! ' + T(row.remind) }) : null,
        btn ? el('div', { class: 'adm-card-actions' }, [btn]) : null, msg]);
      if (btn) btn.addEventListener('click', function () {
        var p = rowPatch({ state: sel.value, invoice: inv.value, amount: amt.value });
        if (p.error) { msg.textContent = T('stg_err_' + p.error); return; }
        btn.disabled = true; msg.textContent = '';
        call(api, 'updateContainerStorage', row.id, p.patch).then(function (r) {
          btn.disabled = false;
          if (r.error) { msg.textContent = errText(api, r.error); return; }
          if (api.toast) api.toast(T('stg_saved'), 'success');
          load();
        });
      });
      return box;
    }
    function overrideForm() {
      var id = 'stg-reason-' + tx.id;
      var ta = el('textarea', { class: 'form-control', id: id, rows: '2', maxlength: '500', dir: 'auto' });
      var msg = el('p', { class: 'form-hint', role: 'status' });
      var btn = el('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: T('stg_override_btn') });
      btn.addEventListener('click', function () {
        var reason = String(ta.value || '').trim();
        if (reason.length < 3) { msg.textContent = T('stg_override_short'); return; }
        btn.disabled = true; msg.textContent = '';
        call(api, 'approveStorageOverride', tx.id, reason).then(function (r) {
          btn.disabled = false;
          if (r.error) { msg.textContent = errText(api, r.error); return; }
          if (api.toast) api.toast(T('stg_override_ok'), 'success');
          load();
        });
      });
      return el('div', { class: 'stg-override' }, [
        el('h4', { class: 'stg-override-title', text: T('stg_override_title') }),
        el('label', { class: 'form-label', for: id, text: T('stg_override_reason') }), ta,
        el('span', { class: 'form-hint', text: T('stg_override_hint') }),
        el('div', { class: 'adm-card-actions' }, [btn]), msg
      ]);
    }
    return load();
  }

  OPS.txStorage = { VERSION: 'stg-1', t: T, pure: { gateView: gateView, rowPatch: rowPatch } };
  var MINE = [{ id: 'storage', order: 45, render: renderStorage }];
  var ids = MINE.map(function (s) { return s.id; });
  for (var i = OPS.txSections.length - 1; i >= 0; i--) {
    if (OPS.txSections[i] && ids.indexOf(OPS.txSections[i].id) !== -1) OPS.txSections.splice(i, 1);
  }
  MINE.forEach(function (s) { OPS.txSections.push(s); });
})();
