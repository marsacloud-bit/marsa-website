/* ==========================================================================
   مرسى | MARSA — draft transaction + approval on the transaction page (#tx/<id>)  →  MarsaOps.txDraft
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_DOCS_AR.md + LEGACY_DECL_AR.md (migration 20261127000100_tx_draft_approval.sql).
   Loaded after tx-appt.js, before admin.js. Section 'draft_approval' (order 4, placement 'top': above the readiness
   banner), shown only while the transaction is a DRAFT (tx.is_draft), or as one line «معتمدة بتاريخ …» after its approval:
     * badge «مسودة — بانتظار البيان الجمركي» (no declaration yet: the staff enter it in Fasah, Fasah issues the
       declaration) with «ارفع البيان الجمركي» → ocr.html#decl-tx=<id> and «كشف إدخال فسح» (ops/fasah-sheet.js);
     * badge «مسودة — بانتظار المطابقة والاعتماد» once a declaration reading is approved: «مطابقة البيان مع الفاتورة
       والبوليصة» → ocr.html#match-tx=<id>&decl=<extraction>, the summary of the latest three-way match (overall + counts)
       and «اعتماد المعاملة» (MarsaApi.approveTransaction): disabled until a three-way match on that declaration
       reading exists; a match that is not a clean «match» needs the confirmation checkbox and a note.
   * Read side: MarsaApi.getTransactionApproval (one call). Strings: namespace 'decl' (assets/i18n/decl.js, ar + en).
   * Server data only via textContent / createElement (api.el). ES5, no library.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  if (!Array.isArray(OPS.txSections)) OPS.txSections = [];

  function T(k, vars) {
    var key = 'decl.' + k;
    if (!I || typeof I.t !== 'function') return k;
    var s = I.t(key, vars);
    return s === key ? k : s;
  }
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function uploadLink(txId) { return 'ocr.html#decl-tx=' + encodeURIComponent(String(txId || '')); }
  function matchLink(txId, extId) {
    return 'ocr.html#match-tx=' + encodeURIComponent(String(txId || '')) + (UUID.test(String(extId || '')) ? '&decl=' + encodeURIComponent(String(extId)) : '');
  }
  // the state of the section from get_transaction_approval → { show, stage: 'approved' | 'await_decl' | 'await_match' |
  //   'ready' | 'none', badgeKey, tone, match: {id, overall, counts, clean} | null, needConfirm, canApprove }
  function draftView(a) {
    a = a || {};
    if (!a.is_draft) {
      return a.approved_at ? { show: true, stage: 'approved', badgeKey: 'txd_badge_approved', tone: 'success', match: null, needConfirm: false, canApprove: false }
        : { show: false, stage: 'none', badgeKey: null, tone: 'muted', match: null, needConfirm: false, canApprove: false };
    }
    var appr = a.declaration_approval && UUID.test(String(a.declaration_approval.extraction_id || '')) ? a.declaration_approval : null;
    if (!appr) return { show: true, stage: 'await_decl', badgeKey: 'txd_badge_await_decl', tone: 'warning', match: null, needConfirm: false, canApprove: false };
    var m = a.last_three_way_match && UUID.test(String(a.last_three_way_match.id || '')) ? a.last_three_way_match : null;
    // only a match on THIS declaration reading counts (the server refuses another one: MRS_INVALID match_id)
    if (m && m.declaration_extraction_id && m.declaration_extraction_id !== appr.extraction_id) m = null;
    if (!m) return { show: true, stage: 'await_match', badgeKey: 'txd_badge_await_match', tone: 'info', match: null, needConfirm: false, canApprove: false };
    var c = m.counts || {};
    var clean = m.overall === 'match' && !(Number(c.mismatch) > 0) && !(Number(c.missing) > 0);
    return { show: true, stage: 'ready', badgeKey: 'txd_badge_await_match', tone: 'info',
      match: { id: m.id, overall: m.overall, counts: { match: Number(c.match) || 0, mismatch: Number(c.mismatch) || 0, partial: Number(c.partial) || 0,
        missing: Number(c.missing) || 0 }, clean: clean, created_at: m.created_at || null }, needConfirm: !clean, canApprove: true };
  }
  // the approveTransaction options → { o } | { error: 'match' | 'confirm' | 'note' }
  function approvePayload(view, form) {
    form = form || {};
    if (!view || !view.canApprove || !view.match) return { error: 'match' };
    var note = String(form.note || '').trim().slice(0, 1000);
    var o = { matchId: view.match.id };
    if (view.needConfirm) {
      if (!form.confirm) return { error: 'confirm' };
      if (!note) return { error: 'note' };
      o.confirmMismatch = true;
    }
    if (note) o.note = note;
    if (form.idemKey) o.idemKey = form.idemKey;
    return { o: o };
  }
  var OVERALL_TONE = { match: 'success', review: 'warning', mismatch: 'danger' };

  function call(api, name) {
    var A = api && (api.MarsaApi || api), f = A && A[name];
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof f !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', message: name } });
    return Promise.resolve().then(function () { return f.apply(A, args); })
      .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
  }
  function errText(api, e) { return api && typeof api.errText === 'function' ? api.errText(e) : ((e && e.message) || String(e)); }

  function renderDraft(root, tx, api) {
    // nothing to show for a transaction that was never a draft (the column is false / absent on an older database)
    if (!tx || (!tx.is_draft && !tx.approved_at)) return null;
    var el = api.el;
    var A = api.MarsaApi || api;
    if (!A || typeof A.getTransactionApproval !== 'function') return null;
    var card = el('section', { class: 'app-card adm-card ops-tx-card txd-card', 'aria-live': 'polite' });
    root.appendChild(card);
    var idem = null;
    function load() {
      return call(api, 'getTransactionApproval', tx.id).then(function (r) {
        card.textContent = '';
        if (r.error) { card.appendChild(el('div', { class: 'alert alert-warning', role: 'status' }, el('div', { text: errText(api, r.error) }))); return; }
        paint(r.data || {});
      });
    }
    function paint(a) {
      var v = draftView(a);
      if (!v.show) { card.hidden = true; return; }
      card.hidden = false;
      if (v.stage === 'approved') {
        card.classList.add('txd-approved');
        card.appendChild(el('p', { class: 'txd-line' }, [
          el('span', { class: 'badge badge-sm badge-success', text: T('txd_badge_approved') }), ' ',
          el('span', { text: T('txd_approved_on', { d: api.fmtDate ? api.fmtDate(a.approved_at, true) : String(a.approved_at || ''),
            who: a.approved_by_name || T('none') }) })
        ]));
        if (a.approval_note) card.appendChild(el('p', { class: 'adm-sub' }, el('bdi', { dir: 'auto', text: T('txd_note_saved') + ': ' + a.approval_note })));
        return;
      }
      var canWrite = !api.cancelled && !tx.cancelled_at && api.can('opsWriter', tx.branch_id);
      var acts = el('div', { class: 'adm-card-actions' }, [
        canWrite && v.stage === 'await_decl' ? el('a', { class: 'btn btn-sm btn-primary', href: uploadLink(tx.id), text: T('txd_upload') }) : null,
        canWrite && v.stage !== 'await_decl' ? el('a', { class: 'btn btn-sm ' + (v.stage === 'await_match' ? 'btn-primary' : 'btn-secondary'),
          href: matchLink(tx.id, a.declaration_approval && a.declaration_approval.extraction_id), text: T('match_tx') }) : null,
        el('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: T('tx_fasah_btn'), 'data-fasah-sheet': '1',
          onclick: function (e) { if (e && e.preventDefault) e.preventDefault(); if (window.MarsaFasahSheet) window.MarsaFasahSheet.open(tx, api); } })
      ]);
      card.appendChild(el('header', { class: 'app-card-head adm-card-head' }, [
        el('h3', { class: 'app-card-title' }, [el('span', { class: 'badge badge-' + v.tone + ' txd-badge', text: T(v.badgeKey) })]), acts]));
      var body = el('div', { class: 'app-card-body adm-card-body' });
      card.appendChild(body);
      body.appendChild(el('p', { class: 'text-sm', text: T('txd_lead_' + v.stage) }));
      if (v.stage !== 'ready') return;
      var m = v.match;
      body.appendChild(el('p', { class: 'txd-match' }, [
        el('span', { class: 'badge badge-sm badge-' + (OVERALL_TONE[m.overall] || 'muted'), text: T('txd_overall_' + m.overall) }), ' ',
        el('span', { class: 'num', dir: 'ltr', text: '✓' + m.counts.match + ' ≈' + m.counts.partial + ' ?' + m.counts.missing + ' ✗' + m.counts.mismatch }), ' ',
        m.created_at ? el('span', { class: 'adm-sub', text: api.fmtDate ? api.fmtDate(m.created_at, true) : String(m.created_at) }) : null
      ]));
      if (!canWrite) return;
      var form = el('div', { class: 'form txd-form' });
      var cb = null, note = el('textarea', { class: 'form-control', id: 'txd-note-' + tx.id, rows: '2', maxlength: '1000', dir: 'auto' });
      if (v.needConfirm) {
        form.appendChild(el('div', { class: 'alert alert-warning', role: 'note' }, el('div', { text: T('txd_mismatch_warn') })));
        cb = el('input', { type: 'checkbox', id: 'txd-confirm-' + tx.id });
        form.appendChild(el('label', { class: 'check', 'for': 'txd-confirm-' + tx.id }, [cb, ' ', el('span', { text: T('txd_confirm') })]));
      }
      form.appendChild(el('label', { class: 'form-label', 'for': 'txd-note-' + tx.id, text: T(v.needConfirm ? 'txd_note_required' : 'txd_note') }));
      form.appendChild(note);
      var msg = el('p', { class: 'form-hint txd-msg', role: 'status' });
      var btn = el('button', { class: 'btn btn-primary', type: 'button', text: T('txd_approve') });
      btn.addEventListener('click', function () {
        if (!idem) idem = typeof api.newIdemKey === 'function' ? api.newIdemKey() : null;
        var p = approvePayload(v, { confirm: cb ? cb.checked : false, note: note.value, idemKey: idem });
        if (p.error) { msg.textContent = T('txd_err_' + p.error); return; }
        btn.disabled = true; msg.textContent = T('txd_approving');
        call(api, 'approveTransaction', tx.id, p.o).then(function (r) {
          btn.disabled = false;
          if (r.error) { msg.textContent = errText(api, r.error); idem = null; return; }
          if (api.toast) api.toast(T('txd_approved_toast', { ref: tx.ref || '' }), 'success');
          tx.is_draft = false; tx.approved_at = r.data && r.data.approved_at;
          if (typeof api.refresh === 'function') api.refresh(); else load();
        });
      });
      form.appendChild(el('div', { class: 'adm-card-actions' }, [btn]));
      form.appendChild(msg);
      body.appendChild(form);
    }
    return load();
  }

  OPS.txDraft = { VERSION: 'txd-1', t: T, pure: { draftView: draftView, approvePayload: approvePayload, uploadLink: uploadLink, matchLink: matchLink } };
  var MINE = [{ id: 'draft_approval', order: 4, placement: 'top', render: renderDraft }];
  var ids = MINE.map(function (s) { return s.id; });
  for (var i = OPS.txSections.length - 1; i >= 0; i--) {
    if (OPS.txSections[i] && ids.indexOf(OPS.txSections[i].id) !== -1) OPS.txSections.splice(i, 1);
  }
  MINE.forEach(function (s) { OPS.txSections.push(s); });
})();
