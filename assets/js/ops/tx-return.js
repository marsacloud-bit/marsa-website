/* ==========================================================================
   مرسى | MARSA — legacy step 5 UI: empty-return proofs on the transaction page (#tx/<id>)  →  MarsaOps.txReturn
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_APPT_AR.md §5 (20261121000100). Loaded after tx-appt.js, before admin.js.
   Section 'empty_return' (order 56, anchor #tx-empty-return):
     * the containers with their return status and the return deadline (deadline-only save: save_empty_return_deadline);
     * «قراءة إيصال إعادة الفارغ»: an EIR (PDF / image ≤ 8 MB) read by Claude (aiExtract empty_return_receipt) becomes a
       PENDING proof (create_empty_return_proof source ai) with the values read + the confidence. A reading is NEVER applied:
       the container is untouched until a staff member confirms (owner decision 2026-11-10);
     * a manual proof (file + container + delivery date AND time + depot, or «غير مقروء»);
     * the register (list_empty_return_proofs): status, container, delivery time, depot, confidence, notes;
     * «تأكيد إعادة الفارغ» (transport writers of the branch only, behind a confirm dialog) → verify_empty_return_proof, which
       writes the container return through the existing evidence path; «إلغاء الإثبات» with a reason → void_empty_return_proof.
   * «طلب تمديد المهلة» (20261128000100, docs/online/LEGACY_APPT_AR.md §5b): the program PREPARES the extension request e-mail to
     the shipping agent (prepare_return_extension: containers due / overdue, the agent of the B/L, its e-mail, Arabic + English
     text); the user edits it, opens it in their own mail program («فتح في البريد», mailto:) or copies it, SENDS it themselves and
     presses «تم الإرسال» (mark_return_extension_sent — the program sends nothing); the agent's answer («تسجيل رد الوكيل»,
     decide_return_extension) moves the return deadline; «إلغاء الطلب» with a reason. #alerts opens this block through
     MarsaOps.pendingFocus = {tx, section: 'empty_return', open: 'rx'}.
   * Strings: namespace 'appt' (assets/i18n/appt.js). Server data only via textContent / createElement. ES5, no library.
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

  /* ---------- pure helpers ---------- */
  var PROOF_STATUSES = ['pending_review', 'unreadable', 'approved', 'voided'];
  var MATCH_NOTES = ['container_not_read', 'container_not_in_transaction', 'container_format', 'delivery_time_missing', 'depot_missing', 'ai_read_failed'];
  // the AI ran on the file but produced no usable reading: legacy analyzeAndSaveEmptyReturnProofR12110 still keeps the file
  // and records an «تعذر القراءة» proof for staff to complete (a wrong document, the quota, a file too large: no proof)
  var READ_FAIL_SAVES = ['MRS_AI_FAILED', 'MRS_AI_REFUSED', 'MRS_AI_TRUNCATED', 'MRS_AI_UNSUPPORTED'];
  function readFailSaves(e) { return !!e && READ_FAIL_SAVES.indexOf(e.code) !== -1; }
  var EIR_MAX = 8388608, IMAGE_MAX = 5242880;
  var MEDIA = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };
  var EIR_REJECT = ['not_empty_return_receipt', 'not_empty_return'];
  var CLOSED_RETURN = ['returned_verified', 'waived'];
  function western(s) {
    return String(s == null ? '' : s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
  }
  function mediaType(f) {
    var t = String(f && f.type || '').toLowerCase();
    if (['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].indexOf(t) !== -1) return t;
    var n = String(f && f.name || ''), i = n.lastIndexOf('.');
    return i > 0 ? MEDIA[n.slice(i + 1).toLowerCase()] || null : null;
  }
  // the proof file: PDF / image ≤ 8 MB (MRS_EMPTY_RETURN_FILE); for the AI reading an image ≤ 5 MB (the per-image limit)
  function fileProblem(f, forAi) {
    var m = mediaType(f);
    if (!f) return 'required';
    if (!m) return 'unsupported';
    if (Number(f.size) > EIR_MAX) return 'too_large';
    if (forAi && m !== 'application/pdf' && Number(f.size) > IMAGE_MAX) return 'too_large_image';
    return null;
  }
  function dateTimeState(v) {
    var s = western(v).trim();
    if (!s) return 'empty';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date_only';
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? 'ok' : 'invalid';
  }
  // an ISO time → 'YYYY-MM-DDTHH:mm' in Riyadh (UTC+3) for a datetime-local input
  function riyadhLocal(v) {
    var s = western(v).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return s.replace(' ', 'T').slice(0, 16);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';      // a date without a time: never invent one (MRS_DATETIME_REQUIRED)
    var d = new Date(s);
    return isNaN(d.getTime()) ? '' : new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 16);
  }
  // 'container_not_read | depot_missing | free text' → [{token} | {text}]
  function notesOf(s) {
    return String(s || '').split(' | ').map(function (x) { return x.trim(); }).filter(Boolean)
      .map(function (x) { return MATCH_NOTES.indexOf(x) !== -1 ? { token: x } : { text: x }; });
  }
  function confPct(c) { return c == null || c === '' || !isFinite(Number(c)) ? null : Math.round(Number(c) * 100); }
  function confTone(c) { var p = confPct(c); return p == null ? 'muted' : p >= 85 ? 'success' : p >= 60 ? 'warning' : 'danger'; }
  function openProof(p) { return !!p && (p.status === 'pending_review' || p.status === 'unreadable'); }
  // the staff confirmation: container + delivery date AND time + depot (verify_empty_return_proof) → options or {error}
  function verifyPayload(v) {
    v = v || {};
    if (!v.containerId) return { error: 'v_e_container' };
    var st = dateTimeState(v.deliveredAt);
    if (st === 'empty' || st === 'date_only') return { error: 'v_e_time' };
    if (st !== 'ok') return { error: 'v_e_time_format' };
    if (!String(v.depot || '').trim()) return { error: 'v_e_depot' };
    return { containerId: v.containerId, deliveredAt: western(v.deliveredAt).trim(), depot: String(v.depot).trim().slice(0, 160) };
  }
  // the manual proof → createEmptyReturnProof options (without documentId) or {error}
  function manualPayload(v) {
    v = v || {};
    var o = { source: 'manual' };
    var st = dateTimeState(v.deliveredAt);
    if (st === 'date_only') return { error: 'v_e_time' };
    if (st === 'invalid') return { error: 'v_e_time_format' };
    if (st === 'ok') o.deliveredAt = western(v.deliveredAt).trim();
    if (v.containerId) o.containerId = v.containerId;
    if (String(v.depot || '').trim()) o.depot = String(v.depot).trim().slice(0, 160);
    if (String(v.notes || '').trim()) o.matchNotes = String(v.notes).trim().slice(0, 1500);
    if (v.unreadable) o.unreadable = true;
    else if (!o.containerId && !o.deliveredAt && !o.depot) return { error: 'm_e_empty' };
    return o;
  }
  // the saved EIR reading (document_extractions, ⊆ supa.js EXT_INSERT)
  function extractionRow(o) {
    var res = o.res || {}, file = o.file || {};
    var row = { doc_type: 'empty_return_receipt', source_name: String(file.name || 'eir').slice(0, 255), source_sha256: o.sha256 || res.source_sha256 || '',
      source_mime: o.mime || null, source_size: file.size != null ? file.size : null, source_pages: null, engine: res.model || 'claude-opus-5-5', languages: 'auto',
      mean_confidence: res.mean_confidence == null ? null : Math.min(100, Math.max(0, Number(res.mean_confidence))), raw_text: String(res.raw_text || '').slice(0, 200000),
      extracted_fields: res.extracted_fields && typeof res.extracted_fields === 'object' ? res.extracted_fields : {}, qr_payload: null, line_items: [],
      ai_usage_id: res.usage_id };
    if (res.ai_detail && typeof res.ai_detail === 'object') row.ai_detail = res.ai_detail;
    if (o.orgId) row.org_id = o.orgId;
    if (o.transactionId) row.transaction_id = o.transactionId;
    if (o.documentId) row.document_id = o.documentId;
    return row;
  }
  function eirReject(e) {
    if (!e || e.code !== 'MRS_AI_WRONG_DOCUMENT') return null;
    var r = e.field || e.detail || '';
    return EIR_REJECT.indexOf(r) !== -1 ? r : 'not_empty_return_receipt';
  }

  /* ---------- extension request (20261128000100): pure helpers ---------- */
  var RX_STATUSES = ['draft', 'sent', 'approved', 'partially_approved', 'rejected', 'cancelled'];
  var RX_ACTIVE = ['draft', 'sent'];
  var RX_OUTCOMES = ['approved', 'partially_approved', 'rejected'];
  var MAILTO_MAX = 1800;   // encoded characters: longer mailto: links are cut by some mail programs → open with the subject, copy the body
  function rxActive(r) { return !!r && RX_ACTIVE.indexOf(r.status) !== -1; }
  function isEmail(v) { var s = String(v == null ? '' : v).trim(); return s.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s); }
  function crlf(s) { return String(s == null ? '' : s).replace(/\r\n|\r|\n/g, '\r\n'); }
  // → { href, full } — the address keeps a literal @ (some mail programs do not decode %40 in the address); full false: the body did not fit (the link carries the subject only; the page copies the body)
  function mailtoHref(to, subject, body, max) {
    var lim = max || MAILTO_MAX;
    var base = 'mailto:' + encodeURIComponent(String(to || '').trim()).replace(/%40/g, '@') + '?subject=' + encodeURIComponent(String(subject || '').replace(/[\r\n]+/g, ' '));
    var full = base + '&body=' + encodeURIComponent(crlf(body));
    return full.length <= lim ? { href: full, full: true } : { href: base, full: false };
  }
  function ymd(v) { var s = western(v).trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }
  // the new-request form → prepareReturnExtension options or {error}
  function rxPreparePayload(v) {
    v = v || {};
    var o = {};
    var ids = (v.containerIds || []).filter(Boolean);
    if (!ids.length) return { error: 'rx_e_containers' };
    if (!v.allDefault) o.containerIds = ids;
    var d = western(v.days).trim(), u = western(v.until).trim();
    if (u) { if (!ymd(u)) return { error: 'rx_e_until' }; o.requestedUntil = u; }
    else if (d) { if (!/^\d{1,2}$/.test(d) || +d < 1 || +d > 60) return { error: 'rx_e_days' }; o.requestedDays = +d; }
    var to = String(v.to || '').trim();
    if (to) { if (!isEmail(to)) return { error: 'rx_e_email' }; o.toAddress = to.toLowerCase(); }
    if (v.agentPartyId) o.agentPartyId = v.agentPartyId;
    return o;
  }
  // the answer form → decideReturnExtension options or {error}
  function rxDecidePayload(v, req) {
    v = v || {}; req = req || {};
    if (RX_OUTCOMES.indexOf(v.outcome) === -1) return { error: 'rx_e_outcome' };
    var note = String(v.note || '').trim();
    var o = { outcome: v.outcome };
    if (v.outcome === 'rejected') { if (!note) return { error: 'rx_e_note' }; }
    else {
      var u = ymd(v.until);
      if (!u) return { error: 'rx_e_new_date' };
      if (req.current_deadline && u <= String(req.current_deadline).slice(0, 10)) return { error: 'rx_e_new_date_after' };
      o.decidedUntil = u;
    }
    if (req.status === 'draft' && !note) return { error: 'rx_e_note_phone' };
    if (note) o.note = note.slice(0, 1000);
    return o;
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
  function fileB64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result || ''); var i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : ''); };
      fr.onerror = function () { reject(new Error('read')); };
      fr.readAsDataURL(file);
    });
  }

  function renderReturn(root, tx, api) {
    var el = api.el, A = api.MarsaApi || api;
    var canWrite = !api.cancelled && !tx.cancelled_at && api.can('transportWriter', tx.branch_id);
    var head = el('header', { class: 'app-card-head adm-card-head' }, [el('h3', { class: 'app-card-title', text: T('er_title') })]);
    var body = el('div', { class: 'app-card-body adm-card-body' }, el('p', { class: 'text-sm text-muted', text: T('loading') }));
    root.appendChild(el('section', { class: 'app-card adm-card ops-tx-card appt-er', id: 'tx-empty-return' }, [head, body]));
    var U = { proofs: [], readiness: null, containers: [], docs: {}, ai: false, open: {}, busy: false, msg: null, key: {}, error: null,
      fileInp: null, mv: { ctr: '', at: '', depot: '', notes: '', unr: false },
      rx: { available: false, items: [], open: null, form: null, agents: null, needAgent: false, act: {}, edit: {}, busy: false, focus: false } };
    function uuid() { return typeof api.newIdemKey === 'function' ? api.newIdemKey() : null; }
    function sha(file) { return A && A.util && A.util.sha256Hex ? Promise.resolve(A.util.sha256Hex(file)).catch(function () { return ''; }) : Promise.resolve(''); }
    function ltr(v) { return el('bdi', { dir: 'ltr', class: 'num', text: String(v == null ? '' : v) }); }
    function grp(text, inp, hint) {
      var id = inp.getAttribute('id') || ('appt-er-' + Math.random().toString(36).slice(2));
      inp.setAttribute('id', id);
      var g = el('div', { class: 'form-group appt-field' }, [el('label', { class: 'form-label', for: id, text: text }), inp]);
      if (hint) g.appendChild(el('span', { class: 'form-hint', text: hint }));
      return g;
    }
    function input(type, id, attrs) { var n = el('input', Object.assign({ class: 'form-control', id: id }, attrs || {})); n.type = type; return n; }
    function ctrSelect(id, cur) {
      var s = el('select', { class: 'form-control', id: id });
      var o0 = el('option', { text: T('choose') }); o0.value = ''; s.appendChild(o0);
      U.containers.forEach(function (c) { var o = el('option', { text: c.container_no }); o.value = c.id; o.selected = c.id === cur; s.appendChild(o); });
      if (!cur) o0.selected = true;
      return s;
    }
    function fmt(v) { return v ? (api.fmtDate ? api.fmtDate(v, true) : String(v)) : T('none'); }
    // operational times (delivery / return) are entered in Riyadh time, so they are shown in Riyadh time too, whatever the device zone
    function fmtRiy(v) { var x = riyadhLocal(v); return x ? x.replace('T', ' ') + ' ' + T('er_riyadh') : fmt(v); }
    function message(type, text) { U.msg = { type: type, text: text }; }

    function load() {
      return Promise.all([call(api, 'listEmptyReturnProofs', tx.id), call(api, 'listContainers', tx.id),
        canWrite && A && typeof A.aiAccess === 'function' ? call(api, 'aiAccess', api.orgId || undefined) : Promise.resolve({ data: null }),
        call(api, 'listDocuments', { transactionId: tx.id }), call(api, 'listReturnExtensions', { transactionId: tx.id })]).then(function (rs) {
        U.error = rs[0].error || null;
        var d = rs[0].data || {};
        U.proofs = Array.isArray(d.proofs) ? d.proofs : [];
        U.readiness = d.readiness || null;
        U.containers = !rs[1].error && Array.isArray(rs[1].data) ? rs[1].data : [];
        U.ai = !!(rs[2] && rs[2].data && rs[2].data.can_use === true);
        U.docs = {};
        (!rs[3].error && Array.isArray(rs[3].data) ? rs[3].data : []).forEach(function (x) { if (x && !x.voided_at) U.docs[x.id] = x; });
        // the extension block shows only when the server has 20261128000100 (MRS_UNAVAILABLE / a missing RPC: hidden)
        U.rx.available = !rs[4].error;
        U.rx.items = !rs[4].error && rs[4].data && Array.isArray(rs[4].data.items) ? rs[4].data.items : [];
        var pf = OPS.pendingFocus;
        if (pf && pf.tx === tx.id && pf.section === 'empty_return') {
          OPS.pendingFocus = null;
          if (U.rx.available && canWrite && !U.rx.items.some(rxActive)) U.rx.open = 'new';
          U.rx.focus = true;
        }
        paint();
        if (U.rx.focus) {
          U.rx.focus = false;
          var node = body.querySelector ? body.querySelector('#tx-rx') : null;
          if (node && typeof node.scrollIntoView === 'function') { try { node.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (x) { /* old browsers */ } }
        }
      });
    }
    function after(text) {
      if (api.toast) api.toast(text, 'success');
      if (typeof api.refresh === 'function') api.refresh();
      else load();
    }
    function paint() {
      body.textContent = '';
      if (U.error) { body.appendChild(el('div', { class: 'alert alert-warning', role: 'status' }, el('span', { text: errText(api, U.error) }))); return; }
      body.appendChild(el('p', { class: 'form-hint appt-er-rule', text: T('er_rule') }));
      if (U.msg) body.appendChild(el('div', { class: 'alert alert-' + U.msg.type + ' appt-alert', role: U.msg.type === 'danger' ? 'alert' : 'status' }, el('span', { text: U.msg.text })));
      body.appendChild(containersBox());
      if (U.rx.available) body.appendChild(rxBox());
      if (canWrite) body.appendChild(uploadBox());
      body.appendChild(proofsBox());
    }

    /* the containers + deadline-only save */
    function containersBox() {
      var box = el('div', { class: 'appt-er-ctrs' }, el('h4', { class: 'docb-tx-h', text: T('er_ctr_title') + ' (' + U.containers.length + ')' }));
      if (!U.containers.length) { box.appendChild(el('p', { class: 'text-sm text-muted', text: T('er_ctr_none') })); return box; }
      var rows = U.containers.map(function (c) {
        var st = c.return_status || 'pending', closed = CLOSED_RETURN.indexOf(st) !== -1;
        var pending = U.proofs.filter(function (p) { return p.container_id === c.id && openProof(p); }).length;
        var dl = null;
        if (canWrite && !closed) {
          var d = input('date', 'appt-er-dl-' + c.id, { 'aria-label': T('er_deadline_aria', { no: c.container_no }) });
          d.value = c.return_deadline ? String(c.return_deadline).slice(0, 10) : '';
          var b = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: T('er_deadline_save'), 'data-deadline': c.id });
          b.addEventListener('click', function (e) {
            if (e && e.preventDefault) e.preventDefault();
            b.disabled = true;
            call(api, 'saveEmptyReturnDeadline', c.id, d.value || null).then(function (r) {
              b.disabled = false;
              if (r.error) { message('danger', errText(api, r.error)); paint(); return; }
              c.return_deadline = d.value || null;
              // reload: the extension request section and the alerts depend on the deadline
              after(d.value ? T('er_deadline_saved', { no: c.container_no }) : T('er_deadline_cleared', { no: c.container_no }));
            });
          });
          dl = el('div', { class: 'appt-er-dl' }, [d, b]);
        } else dl = el('span', { text: c.return_deadline ? String(c.return_deadline).slice(0, 10) : T('none') });
        return el('tr', null, [el('td', null, ltr(c.container_no)),
          el('td', null, el('span', { class: 'badge badge-sm badge-' + (st === 'returned_verified' ? 'success' : st === 'waived' ? 'muted' : st === 'disputed' ? 'danger' : 'warning'), text: label(api, 'container_return_status', st) })),
          el('td', { text: c.returned_at ? fmtRiy(c.returned_at) : T('none') }), el('td', null, dl),
          el('td', { class: 'num', text: pending ? String(pending) : T('none') })]);
      });
      box.appendChild(el('div', { class: 'table-wrap adm-table-wrap appt-table-wrap' }, el('table', { class: 'table table-striped adm-table appt-er-table' }, [
        el('thead', null, el('tr', null, ['er_c_container', 'er_c_status', 'er_c_returned', 'er_c_deadline', 'er_c_pending'].map(function (k) { return el('th', { scope: 'col', text: T(k) }); }))),
        el('tbody', null, rows)])));
      return box;
    }

    /* the EIR reading (AI) and the manual proof */
    function uploadBox() {
      var box = el('div', { class: 'appt-er-up' }, el('h4', { class: 'docb-tx-h', text: T('er_up_title') }));
      // one file input for the life of the section: a repaint (an error, the manual toggle) keeps the chosen file
      var f = U.fileInp || (U.fileInp = input('file', 'appt-er-file', { accept: '.pdf,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/jpeg,image/png,image/webp,image/gif', 'aria-label': T('er_file') }));
      box.appendChild(grp(T('er_file'), f, T('er_file_hint')));
      var acts = el('div', { class: 'appt-actions' });
      var readBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button', id: 'appt-er-read', text: U.busy === 'read' ? T('er_reading') : T('er_read') });
      readBtn.disabled = !U.ai || !!U.busy;
      readBtn.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); readEir(f.files && f.files[0]); });
      acts.appendChild(readBtn);
      var manBtn = el('button', { class: 'btn btn-sm btn-secondary', type: 'button', id: 'appt-er-manual-toggle', text: U.open.manual ? T('er_manual_hide') : T('er_manual') });
      manBtn.setAttribute('aria-expanded', U.open.manual ? 'true' : 'false');
      manBtn.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); U.open.manual = !U.open.manual; paint(); });
      acts.appendChild(manBtn);
      box.appendChild(acts);
      if (!U.ai) box.appendChild(el('p', { class: 'form-hint', text: T('er_ai_off') }));
      if (U.open.manual) box.appendChild(manualForm(f));
      return box;
    }
    function ensureDoc(file, hash) {
      var hit = null;
      Object.keys(U.docs).forEach(function (id) { if (!hit && U.docs[id].sha256 && U.docs[id].sha256 === hash) hit = id; });
      if (hit) return Promise.resolve(hit);
      return call(api, 'uploadDocument', { file: file, transactionId: tx.id, kind: 'empty_return_receipt', source: 'upload' }).then(function (r) {
        if (r.error || !r.data || !r.data.id) throw r.error || { code: 'MRS_UPLOAD' };
        U.docs[r.data.id] = r.data;
        return r.data.id;
      });
    }
    function readEir(file) {
      var why = fileProblem(file, true);
      if (why) { message('danger', T('er_f_' + why)); paint(); return; }
      var mime = mediaType(file), hash = '', res = null, docId = null;
      U.busy = 'read'; U.msg = null; paint();
      sha(file).then(function (h) { hash = String(h || '').toLowerCase(); return fileB64(file); }).then(function (b64) {
        return call(api, 'aiExtract', { orgId: api.orgId || undefined, docType: 'empty_return_receipt', file: { media_type: mime, data_b64: b64 },
          transactionId: tx.id, lang: api.isEn && api.isEn() ? 'en' : 'ar', promptVersion: 'ai-doc-v3' });
      }).then(function (r) {
        if (r.error) {
          var rj = eirReject(r.error); if (rj) throw { local: T('er_rj_' + rj) };
          if (readFailSaves(r.error)) return saveUnreadable(file, hash, r.error);
          throw r.error;
        }
        res = r.data || {};
        return ensureDoc(file, hash);
      }).then(function (id) {
        if (id && id.unreadable) return id;
        docId = id;
        if (res.reused && res.extraction_id) return res.extraction_id;
        var row = extractionRow({ res: res, file: file, sha256: hash, mime: mime, orgId: api.orgId, transactionId: tx.id, documentId: docId });
        return call(api, 'saveExtraction', row).then(function (s) {
          if (!s.error && s.data) return s.data.id;
          if (!s.error || s.error.code !== 'MRS_EXTRACTION_DUPLICATE') throw s.error || { code: 'MRS_AI_FAILED' };
          return call(api, 'findExtractionBySource', { orgId: api.orgId || undefined, sha256: hash, transactionId: tx.id }).then(function (x) {
            if (x.error || !x.data || x.data.doc_type !== 'empty_return_receipt') return null;
            return x.data.id;
          });
        });
      }).then(function (extId) {
        if (extId && extId.unreadable) return extId;
        U.key.read = U.key.read && U.key.read.doc === docId ? U.key.read : { doc: docId, key: uuid() };
        var o = { documentId: docId, source: 'ai', idemKey: U.key.read.key };
        if (extId) o.extractionId = extId;
        return call(api, 'createEmptyReturnProof', tx.id, o);
      }).then(function (r) {
        U.busy = false;
        if (r && r.unreadable) { U.key.unr = null; clearFile(); after(T('er_read_failed_saved')); return; }
        if (r.error) throw r.error;
        U.key.read = null;
        clearFile();
        var p = r.data || {};
        after(p.container_matched ? T('er_read_done', { no: p.container_no || '' }) : T('er_read_done_nomatch'));
      }).then(null, function (e) {
        U.busy = false;
        message('danger', e && e.local ? e.local : errText(api, e));
        paint();
      });
    }
    function clearFile() { if (U.fileInp) { try { U.fileInp.value = ''; } catch (x) { /* read-only in old browsers */ } } }
    // the AI read failed: the file is kept as the transaction document and an «unreadable» proof is recorded (pending
    // staff completion, never applied) → {unreadable: true}
    function saveUnreadable(file, hash, err) {
      return ensureDoc(file, hash).then(function (docId) {
        U.key.unr = U.key.unr && U.key.unr.doc === docId ? U.key.unr : { doc: docId, key: uuid() };
        var o = { documentId: docId, source: 'ai', unreadable: true, matchNotes: 'ai_read_failed', idemKey: U.key.unr.key };
        return call(api, 'createEmptyReturnProof', tx.id, o).then(function (r) {
          if (r.error) throw r.error;
          return { unreadable: true, proof: r.data, cause: err };
        });
      });
    }
    function manualForm(fileInp) {
      var box = el('div', { class: 'appt-er-manual' });
      // the values typed are kept in U.mv: a repaint never wipes them; errors show inline (no repaint)
      var ctr = ctrSelect('appt-er-m-ctr', U.mv.ctr || null);
      var at = input('datetime-local', 'appt-er-m-at', { dir: 'ltr' }); at.value = U.mv.at || '';
      var depot = input('text', 'appt-er-m-depot', { maxlength: '160' }); depot.value = U.mv.depot || '';
      var notes = input('text', 'appt-er-m-notes', { maxlength: '500' }); notes.value = U.mv.notes || '';
      var unr = input('checkbox', 'appt-er-m-unreadable', null); unr.checked = !!U.mv.unr;
      function keep() { U.mv = { ctr: ctr.value, at: at.value, depot: depot.value, notes: notes.value, unr: !!unr.checked }; }
      [ctr, at, depot, notes, unr].forEach(function (n) { n.addEventListener('input', keep); n.addEventListener('change', keep); });
      var err = el('p', { class: 'appt-error', role: 'alert', id: 'appt-er-m-err' }); err.hidden = true;
      function showErr(text) { err.textContent = text; err.hidden = false; save.disabled = false; try { err.focus && err.focus(); } catch (x) { /* noop */ } }
      box.appendChild(el('div', { class: 'appt-grid' }, [grp(T('er_m_container'), ctr), grp(T('er_m_at'), at, T('er_m_at_hint')), grp(T('er_m_depot'), depot), grp(T('er_m_notes'), notes)]));
      box.appendChild(el('label', { class: 'appt-check', for: 'appt-er-m-unreadable' }, [unr, el('span', { text: ' ' + T('er_m_unreadable') })]));
      var save = el('button', { class: 'btn btn-sm btn-primary', type: 'button', id: 'appt-er-m-save', text: T('er_m_save') });
      save.disabled = !!U.busy;
      save.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var file = fileInp.files && fileInp.files[0];
        var why = fileProblem(file, false);
        keep();
        if (why) { showErr(T('er_f_' + why)); return; }
        var o = manualPayload({ containerId: ctr.value, deliveredAt: at.value, depot: depot.value, notes: notes.value, unreadable: unr.checked });
        if (o.error) { showErr(T(o.error)); return; }
        U.busy = 'manual'; U.msg = null; save.disabled = true; err.hidden = true;
        sha(file).then(function (h) { return ensureDoc(file, String(h || '').toLowerCase()); }).then(function (docId) {
          o.documentId = docId;
          var sig = JSON.stringify(o);
          U.key.manual = U.key.manual && U.key.manual.sig === sig ? U.key.manual : { sig: sig, key: uuid() };
          o.idemKey = U.key.manual.key;
          return call(api, 'createEmptyReturnProof', tx.id, o);
        }).then(function (r) {
          U.busy = false;
          if (r.error) throw r.error;
          U.key.manual = null; U.open.manual = false;
          U.mv = { ctr: '', at: '', depot: '', notes: '', unr: false };
          clearFile();
          after(T('er_m_done'));
        }).then(null, function (e2) { U.busy = false; showErr(errText(api, e2)); });
      });
      box.appendChild(err);
      box.appendChild(el('div', { class: 'appt-actions' }, save));
      box.appendChild(el('p', { class: 'form-hint', text: T('er_m_rule') }));
      return box;
    }

    /* the register */
    function proofsBox() {
      var box = el('div', { class: 'appt-er-list' }, el('h4', { class: 'docb-tx-h', text: T('er_list_title') + ' (' + U.proofs.length + ')' }));
      if (!U.proofs.length) { box.appendChild(el('p', { class: 'text-sm text-muted', text: T('er_list_none') })); return box; }
      var ul = el('ul', { class: 'appt-er-proofs' });
      U.proofs.forEach(function (p) { ul.appendChild(proofItem(p)); });
      box.appendChild(ul);
      return box;
    }
    function proofItem(p) {
      var li = el('li', { class: 'appt-er-proof is-' + p.status, 'data-proof': p.id });
      var pct = confPct(p.confidence);
      li.appendChild(el('div', { class: 'appt-er-proof-head' }, [
        el('span', { class: 'badge badge-sm badge-' + ({ pending_review: 'warning', unreadable: 'danger', approved: 'success', voided: 'muted' }[p.status] || 'muted'), text: T('ps_' + p.status) }), ' ',
        p.container_no ? ltr(p.container_no) : el('span', { class: 'text-muted', text: T('er_no_container') }),
        p.container_no && !p.container_id ? el('span', { class: 'badge badge-sm badge-danger', text: T('er_not_in_tx') }) : null,
        el('span', { class: 'adm-sub', text: ' · ' + T(p.source === 'ai' ? 'er_src_ai' : 'er_src_manual') })]));
      var dl = el('dl', { class: 'appt-dl' });
      function row(k, node) { dl.appendChild(el('div', null, [el('dt', { text: T(k) }), el('dd', null, node)])); }
      row('er_p_at', el('span', { text: p.delivered_at ? fmtRiy(p.delivered_at) : T('er_p_at_missing') }));
      row('er_p_depot', el('span', { text: p.depot || T('none') }));
      row('er_p_conf', pct == null ? el('span', { text: T('none') }) : el('span', { class: 'badge badge-sm badge-' + confTone(p.confidence), text: pct + '%' }));
      row('er_p_created', el('span', { text: fmt(p.created_at) }));
      if (p.verified_at) row('er_p_verified', el('span', { text: fmt(p.verified_at) }));
      if (p.voided_at) row('er_p_voided', el('span', { text: fmt(p.voided_at) + (p.void_reason ? ' — ' + p.void_reason : '') }));
      li.appendChild(dl);
      var notes = notesOf(p.match_notes);
      if (notes.length) {
        li.appendChild(el('p', { class: 'appt-hints' }, notes.map(function (n) {
          return el('span', { class: 'appt-chip is-' + (n.token ? 'warn' : 'info'), text: n.token ? T('mn_' + n.token) : n.text });
        })));
      }
      var acts = el('div', { class: 'appt-actions' });
      var doc = p.document_id ? U.docs[p.document_id] : null;
      var A2 = api.MarsaApi || api;
      if (doc && A2 && typeof A2.documentUrl === 'function') {
        acts.appendChild(el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: T('er_open_file'), onclick: function (e) {
          if (e && e.preventDefault) e.preventDefault();
          call(api, 'documentUrl', doc).then(function (r) { if (!r.error && r.data && typeof window !== 'undefined' && window.open) window.open(r.data, '_blank', 'noopener'); });
        } }));
      }
      if (canWrite && openProof(p)) {
        acts.appendChild(el('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-verify': p.id, text: T('er_verify'),
          onclick: function (e) { if (e && e.preventDefault) e.preventDefault(); U.open[p.id] = U.open[p.id] === 'verify' ? null : 'verify'; U.msg = null; paint(); } }));
      }
      if (canWrite && p.status !== 'voided') {
        acts.appendChild(el('button', { class: 'btn btn-sm btn-ghost appt-danger', type: 'button', 'data-void': p.id, text: T('er_void'),
          onclick: function (e) { if (e && e.preventDefault) e.preventDefault(); U.open[p.id] = U.open[p.id] === 'void' ? null : 'void'; U.msg = null; paint(); } }));
      }
      if (acts.children.length) li.appendChild(acts);
      if (U.open[p.id] === 'verify' && canWrite && openProof(p)) li.appendChild(verifyForm(p));
      if (U.open[p.id] === 'void' && canWrite && p.status !== 'voided') li.appendChild(voidForm(p));
      return li;
    }
    function verifyForm(p) {
      var box = el('div', { class: 'appt-er-verify' });
      var ctr = ctrSelect('appt-er-v-ctr-' + p.id, p.container_id || null);
      var at = input('datetime-local', 'appt-er-v-at-' + p.id, { dir: 'ltr' }); at.value = riyadhLocal(p.delivered_at);
      var depot = input('text', 'appt-er-v-depot-' + p.id, { maxlength: '160' }); depot.value = p.depot || '';
      box.appendChild(el('div', { class: 'appt-grid' }, [grp(T('er_m_container'), ctr), grp(T('er_m_at'), at, T('er_m_at_hint')), grp(T('er_m_depot'), depot)]));
      var err = el('p', { class: 'appt-error', role: 'alert' }); err.hidden = true;
      var go = el('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-verify-go': p.id, text: T('er_verify_go') });
      go.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var o = verifyPayload({ containerId: ctr.value, deliveredAt: at.value, depot: depot.value });
        if (o.error) { err.textContent = T(o.error); err.hidden = false; return; }
        var no = (U.containers.filter(function (c) { return c.id === o.containerId; })[0] || {}).container_no || '';
        var ask = typeof api.confirm === 'function' ? api.confirm({ title: T('er_cf_title'), text: T('er_cf_text', { no: no, at: o.deliveredAt.replace('T', ' '), depot: o.depot }), okText: T('er_cf_ok') })
          : Promise.resolve(false);
        Promise.resolve(ask).then(function (yes) {
          if (!yes) return;
          var sig = JSON.stringify(o);
          U.key[p.id] = U.key[p.id] && U.key[p.id].sig === sig ? U.key[p.id] : { sig: sig, key: uuid() };
          o.idemKey = U.key[p.id].key;
          go.disabled = true;
          return call(api, 'verifyEmptyReturnProof', p.id, o).then(function (r) {
            go.disabled = false;
            if (r.error) { err.textContent = errText(api, r.error); err.hidden = false; return; }
            U.key[p.id] = null; U.open[p.id] = null;
            var d = r.data || {};
            after(d.container_already_returned ? T('er_verified_already', { no: no }) : T('er_verified', { no: no }));
          });
        });
      });
      box.appendChild(err);
      box.appendChild(el('div', { class: 'appt-actions' }, go));
      box.appendChild(el('p', { class: 'form-hint', text: T('er_verify_rule') }));
      return box;
    }
    function voidForm(p) {
      var box = el('div', { class: 'appt-er-void' });
      var why = input('text', 'appt-er-void-' + p.id, { maxlength: '500' });
      box.appendChild(grp(T('er_void_reason'), why));
      var err = el('p', { class: 'appt-error', role: 'alert' }); err.hidden = true;
      var go = el('button', { class: 'btn btn-sm btn-ghost appt-danger', type: 'button', 'data-void-go': p.id, text: T('er_void_go') });
      go.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var reason = String(why.value || '').trim();
        if (!reason) { err.textContent = T('er_void_need'); err.hidden = false; return; }
        var ask = typeof api.confirm === 'function' ? api.confirm({ title: T('er_void_title'), text: p.status === 'approved' ? T('er_void_text_approved') : T('er_void_text'), okText: T('er_void_ok'), danger: true })
          : Promise.resolve(false);
        Promise.resolve(ask).then(function (yes) {
          if (!yes) return;
          go.disabled = true;
          return call(api, 'voidEmptyReturnProof', p.id, reason).then(function (r) {
            go.disabled = false;
            if (r.error) { err.textContent = errText(api, r.error); err.hidden = false; return; }
            U.open[p.id] = null;
            var d = r.data || {};
            after(d.container_reverted ? T('er_voided_reverted') : d.replaced_by_proof_id ? T('er_voided_replaced') : T('er_voided'));
          });
        });
      });
      box.appendChild(err);
      box.appendChild(el('div', { class: 'appt-actions' }, go));
      return box;
    }

    /* the extension request to the shipping agent (20261128000100): prepared here, sent by the user from their own mail program */
    function rxLabel(st) {
      var k = 'rxs_' + st, x = T(k);
      if (api && typeof api.label === 'function') { try { var s = api.label('return_extension_status', st); if (s && s !== st) return s; } catch (e) { /* below */ } }
      return x === k ? String(st) : x;
    }
    function rxTone(st) { return { draft: 'warning', sent: 'info', approved: 'success', partially_approved: 'success', rejected: 'danger', cancelled: 'muted' }[st] || 'muted'; }
    function rxErr(text) { var p = el('p', { class: 'appt-error', role: 'alert' }); p.textContent = text || ''; p.hidden = !text; return p; }
    function copyText(text) {
      var nav = typeof navigator !== 'undefined' ? navigator : (typeof window !== 'undefined' ? window.navigator : null);
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        return Promise.resolve(nav.clipboard.writeText(String(text))).then(function () { return true; }, function () { return false; });
      }
      try {
        var ta = document.createElement('textarea'); ta.value = String(text); ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
        if (typeof ta.select === 'function') ta.select();
        var okc = typeof document.execCommand === 'function' && document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve(!!okc);
      } catch (e) { return Promise.resolve(false); }
    }
    function rxOpenCtrs() {
      var busy = {};
      U.rx.items.filter(rxActive).forEach(function (r) { (r.container_ids || []).forEach(function (id) { busy[id] = true; }); });
      return U.containers.filter(function (c) { return CLOSED_RETURN.indexOf(c.return_status || 'pending') === -1 && c.return_deadline && !busy[c.id]; });
    }
    function rxBox() {
      var box = el('div', { class: 'appt-er-rx', id: 'tx-rx' }, el('h4', { class: 'docb-tx-h', text: T('rx_title') }));
      box.appendChild(el('p', { class: 'form-hint', text: T('rx_rule') }));
      var items = U.rx.items;
      if (!items.length) box.appendChild(el('p', { class: 'text-sm text-muted', text: T('rx_none') }));
      else {
        var ul = el('ul', { class: 'appt-er-rx-list' });
        items.forEach(function (r) { ul.appendChild(rxItem(r)); });
        box.appendChild(ul);
      }
      var free = rxOpenCtrs();
      if (canWrite) {
        if (free.length) {
          var nb = el('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-rx-new': '1', text: U.rx.open === 'new' ? T('rx_new_hide') : T('rx_new') });
          nb.setAttribute('aria-expanded', U.rx.open === 'new' ? 'true' : 'false');
          nb.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); U.rx.open = U.rx.open === 'new' ? null : 'new'; U.msg = null; paint(); });
          box.appendChild(el('div', { class: 'appt-actions' }, nb));
          if (U.rx.open === 'new') box.appendChild(rxNewForm(free));
        } else if (!items.some(rxActive)) box.appendChild(el('p', { class: 'form-hint', text: T('rx_no_deadline') }));
      }
      return box;
    }
    function rxNewForm(free) {
      var f = U.rx.form || (U.rx.form = { ids: free.map(function (c) { return c.id; }), days: '', until: '', to: '', agent: '' });
      var box = el('div', { class: 'appt-er-rx-new' });
      var list = el('div', { class: 'appt-er-rx-ctrs', role: 'group', 'aria-label': T('rx_f_containers') });
      free.forEach(function (c) {
        var cb = input('checkbox', 'appt-rx-c-' + c.id, { 'data-rx-ctr': c.id }); cb.checked = f.ids.indexOf(c.id) !== -1;
        cb.addEventListener('change', function () {
          f.ids = f.ids.filter(function (x) { return x !== c.id; });
          if (cb.checked) f.ids.push(c.id);
        });
        list.appendChild(el('label', { class: 'appt-check', for: 'appt-rx-c-' + c.id }, [cb, ' ', ltr(c.container_no), el('span', { class: 'adm-sub', text: ' · ' + T('rx_deadline_of', { d: String(c.return_deadline).slice(0, 10) }) })]));
      });
      box.appendChild(el('div', { class: 'form-group' }, [el('span', { class: 'form-label', text: T('rx_f_containers') }), list]));
      var days = input('number', 'appt-rx-days', { min: '1', max: '60', dir: 'ltr', inputmode: 'numeric' }); days.value = f.days;
      var until = input('date', 'appt-rx-until', { dir: 'ltr' }); until.value = f.until;
      var to = input('email', 'appt-rx-to', { dir: 'ltr', maxlength: '160', autocomplete: 'off' }); to.value = f.to;
      [[days, 'days'], [until, 'until'], [to, 'to']].forEach(function (x) { x[0].addEventListener('input', function () { f[x[1]] = x[0].value; }); x[0].addEventListener('change', function () { f[x[1]] = x[0].value; }); });
      var kids = [grp(T('rx_f_days'), days, T('rx_f_days_hint')), grp(T('rx_f_until'), until, T('rx_f_until_hint')), grp(T('rx_f_to'), to, T('rx_f_to_hint'))];
      var agentSel = null;
      if (U.rx.needAgent) {
        agentSel = el('select', { class: 'form-control', id: 'appt-rx-agent' });
        var o0 = el('option', { text: T('choose') }); o0.value = ''; agentSel.appendChild(o0);
        (U.rx.agents || []).forEach(function (a) { var o = el('option', { text: a.name_ar || a.name_en || a.id }); o.value = a.id; o.selected = a.id === f.agent; agentSel.appendChild(o); });
        agentSel.addEventListener('change', function () { f.agent = agentSel.value; });
        kids.push(grp(T('rx_f_agent'), agentSel, T('rx_f_agent_hint')));
      }
      box.appendChild(el('div', { class: 'appt-grid' }, kids));
      var err = rxErr(null);
      var go = el('button', { class: 'btn btn-sm btn-primary', type: 'button', id: 'appt-rx-prepare', text: U.rx.busy ? T('rx_preparing') : T('rx_prepare') });
      go.disabled = !!U.rx.busy;
      go.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        f.days = days.value; f.until = until.value; f.to = to.value;
        var o = rxPreparePayload({ containerIds: f.ids, allDefault: false, days: days.value, until: until.value, to: to.value, agentPartyId: agentSel ? agentSel.value : null });
        if (o.error) { err.textContent = T(o.error); err.hidden = false; return; }
        if (U.rx.needAgent && !o.agentPartyId) { err.textContent = T('rx_e_agent'); err.hidden = false; return; }
        var sig = JSON.stringify(o);
        U.key.rx = U.key.rx && U.key.rx.sig === sig ? U.key.rx : { sig: sig, key: uuid() };
        o.idemKey = U.key.rx.key;
        U.rx.busy = true; go.disabled = true; err.hidden = true;
        call(api, 'prepareReturnExtension', tx.id, o).then(function (r) {
          U.rx.busy = false;
          if (r.error) {
            if (r.error.code === 'MRS_REQUIRED' && (r.error.field || r.error.detail) === 'bl_id') {
              return call(api, 'listParties', { kind: 'shipping_agent' }).then(function (pr) {
                U.rx.agents = !pr.error && Array.isArray(pr.data) ? pr.data : [];
                U.rx.needAgent = true; U.key.rx = null;
                message('warning', T('rx_need_agent')); paint();
              });
            }
            go.disabled = false; err.textContent = errText(api, r.error); err.hidden = false; return;
          }
          U.key.rx = null; U.rx.form = null; U.rx.open = null; U.rx.needAgent = false;
          var d = r.data || {};
          U.rx.items = [d].concat(U.rx.items.filter(function (x) { return x.id !== d.id; }));
          U.rx.edit[d.id] = true;
          message(d.missing_email ? 'warning' : 'success', d.missing_email ? T('rx_prepared_no_email') : T('rx_prepared'));
          paint();
        });
      });
      box.appendChild(err);
      box.appendChild(el('div', { class: 'appt-actions' }, go));
      return box;
    }
    function rxItem(r) {
      var li = el('li', { class: 'appt-er-rx-item is-' + r.status, 'data-rx': r.id });
      var nos = (r.containers || []).map(function (c) { return c.container_no; });
      li.appendChild(el('div', { class: 'appt-er-proof-head' }, [
        el('span', { class: 'badge badge-sm badge-' + rxTone(r.status), text: rxLabel(r.status) }), ' ',
        el('span', { text: T('rx_ctrs', { n: nos.length }) + ' ' }), ltr(nos.join(' · ')),
        r.agent_name ? el('span', { class: 'adm-sub', text: ' · ' + r.agent_name }) : null]));
      var dl = el('dl', { class: 'appt-dl' });
      function row(k, node) { dl.appendChild(el('div', null, [el('dt', { text: T(k) }), el('dd', null, node)])); }
      row('rx_p_period', el('span', { text: T('rx_period', { cur: String(r.current_deadline || '').slice(0, 10), until: String(r.requested_until || '').slice(0, 10), n: r.requested_days }) }));
      row('rx_p_to', r.to_address ? ltr(r.to_address) : el('span', { class: 'text-muted', text: T('rx_no_email') }));
      if (r.sent_at) row('rx_p_sent', el('span', { text: fmt(r.sent_at) + (r.sent_by_name ? ' — ' + r.sent_by_name : '') }));
      if (r.decided_at) row('rx_p_decided', el('span', { text: (r.decided_until ? T('rx_new_deadline', { d: String(r.decided_until).slice(0, 10) }) : T('rx_deadline_kept')) + (r.decision_note ? ' — ' + r.decision_note : '') }));
      if (r.cancelled_at) row('rx_p_cancelled', el('span', { text: fmt(r.cancelled_at) + (r.cancel_reason ? ' — ' + r.cancel_reason : '') }));
      li.appendChild(dl);
      if (!rxActive(r)) return li;
      var draft = r.status === 'draft';
      var ed = { to: null, subject: null, body: null, save: null };
      if (draft && canWrite) {
        var to = input('email', 'appt-rx-to-' + r.id, { dir: 'ltr', maxlength: '160' }); to.value = r.to_address || '';
        var subj = input('text', 'appt-rx-subj-' + r.id, { maxlength: '300', dir: 'auto' }); subj.value = r.subject || '';
        var bodyT = el('textarea', { class: 'form-control appt-rx-body', id: 'appt-rx-body-' + r.id, rows: '12', maxlength: '8000', dir: 'auto' }); bodyT.value = r.body || '';
        ed.to = to; ed.subject = subj; ed.body = bodyT;
        var kids = [grp(T('rx_f_to'), to, r.to_address ? null : T('rx_f_to_missing'))];
        if (r.agent_party_id && !r.agent_email) {
          var keep = input('checkbox', 'appt-rx-keep-' + r.id, null);
          ed.save = keep;
          kids.push(el('label', { class: 'appt-check', for: 'appt-rx-keep-' + r.id }, [keep, el('span', { text: ' ' + T('rx_save_agent_email', { name: r.agent_name || '' }) })]));
        }
        kids.push(grp(T('rx_f_subject'), subj), grp(T('rx_f_body'), bodyT, T('rx_f_body_hint')));
        li.appendChild(el('div', { class: 'appt-er-rx-edit' }, kids));
      } else {
        li.appendChild(el('p', { class: 'appt-rx-subject text-sm', text: r.subject || '' }));
        var pre = el('pre', { class: 'appt-rx-preview', dir: 'auto' }); pre.textContent = r.body || ''; li.appendChild(pre);
      }
      function cur() { return { to: ed.to ? String(ed.to.value || '').trim() : (r.to_address || ''), subject: ed.subject ? ed.subject.value : r.subject, body: ed.body ? ed.body.value : r.body }; }
      var err = rxErr(null);
      function showErr(text) { err.textContent = text; err.hidden = false; }
      var acts = el('div', { class: 'appt-actions' });
      // «فتح في البريد»: a real mailto: link (the user's own mail program); a long body is copied, the link carries the subject
      var mail = el('a', { class: 'btn btn-sm btn-primary', 'data-rx-mail': r.id, text: T('rx_mail') });
      function refreshMail() { var c = cur(); var m = mailtoHref(c.to, c.subject, c.body); mail.setAttribute('href', m.href); mail.setAttribute('data-full', m.full ? '1' : '0'); return m; }
      refreshMail();
      [ed.to, ed.subject, ed.body].forEach(function (n) { if (n) n.addEventListener('input', refreshMail); });
      mail.addEventListener('click', function () {
        var c = cur(), m = refreshMail();
        if (!isEmail(c.to)) { showErr(T('rx_e_email')); }
        if (!m.full) copyText(c.body).then(function (okc) { if (api.toast) api.toast(okc ? T('rx_long_copied') : T('rx_long_copy_failed'), okc ? 'warning' : 'danger'); });
      });
      acts.appendChild(mail);
      acts.appendChild(el('button', { class: 'btn btn-sm btn-secondary', type: 'button', 'data-rx-copy': r.id, text: T('rx_copy'), onclick: function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var c = cur();
        copyText(T('rx_copy_fmt', { to: c.to || '—', subject: c.subject || '', body: c.body || '' })).then(function (okc) { if (api.toast) api.toast(okc ? T('rx_copied') : T('rx_copy_failed'), okc ? 'success' : 'danger'); });
      } }));
      if (canWrite) {
        if (draft) {
          acts.appendChild(el('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-rx-save': r.id, text: T('rx_save'), onclick: function (e) {
            if (e && e.preventDefault) e.preventDefault();
            err.hidden = true;
            saveDraft(r, ed, cur()).then(function (x) { if (x && x.error) showErr(x.error); else if (x) after(T('rx_saved')); });
          } }));
          acts.appendChild(el('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-rx-sent': r.id, text: T('rx_sent'), onclick: function (e) {
            if (e && e.preventDefault) e.preventDefault();
            err.hidden = true;
            var c = cur();
            if (!isEmail(c.to)) { showErr(T('rx_e_email_sent')); return; }
            var ask = typeof api.confirm === 'function' ? api.confirm({ title: T('rx_sent_title'), text: T('rx_sent_text', { to: '\u2066' + c.to + '\u2069' }), okText: T('rx_sent_ok') }) : Promise.resolve(false);
            Promise.resolve(ask).then(function (yes) {
              if (!yes) return;
              return saveDraft(r, ed, c).then(function (x) {
                if (x && x.error) { showErr(x.error); return; }
                return call(api, 'markReturnExtensionSent', r.id, null).then(function (m) {
                  if (m.error) { showErr(errText(api, m.error)); return; }
                  after(T('rx_marked_sent'));
                });
              });
            });
          } }));
        }
        acts.appendChild(el('button', { class: 'btn btn-sm btn-secondary', type: 'button', 'data-rx-decide': r.id, text: T('rx_decide'), onclick: function (e) {
          if (e && e.preventDefault) e.preventDefault(); U.rx.act[r.id] = U.rx.act[r.id] === 'decide' ? null : 'decide'; paint();
        } }));
        acts.appendChild(el('button', { class: 'btn btn-sm btn-ghost appt-danger', type: 'button', 'data-rx-cancel': r.id, text: T('rx_cancel'), onclick: function (e) {
          if (e && e.preventDefault) e.preventDefault(); U.rx.act[r.id] = U.rx.act[r.id] === 'cancel' ? null : 'cancel'; paint();
        } }));
      }
      li.appendChild(err);
      li.appendChild(acts);
      if (draft) li.appendChild(el('p', { class: 'form-hint', text: T('rx_send_hint') }));
      if (canWrite && U.rx.act[r.id] === 'decide') li.appendChild(rxDecideForm(r));
      if (canWrite && U.rx.act[r.id] === 'cancel') li.appendChild(rxCancelForm(r));
      return li;
    }
    // the edited draft → updateReturnExtension (only what changed) + the agent e-mail into the registry (behind a confirm)
    // → Promise of null (nothing to save) | {ok} | {error: text}
    function saveDraft(r, ed, c) {
      if (!ed.to) return Promise.resolve(null);
      var o = {};
      if (c.to !== (r.to_address || '')) { if (c.to && !isEmail(c.to)) return Promise.resolve({ error: T('rx_e_email') }); o.toAddress = c.to ? c.to.toLowerCase() : null; }
      if (c.subject !== r.subject) { if (!String(c.subject || '').trim()) return Promise.resolve({ error: T('rx_e_subject') }); o.subject = c.subject; }
      if (c.body !== r.body) { if (!String(c.body || '').trim()) return Promise.resolve({ error: T('rx_e_body') }); o.body = c.body; }
      var keep = ed.save && ed.save.checked && c.to && isEmail(c.to);
      var first = Object.keys(o).length ? call(api, 'updateReturnExtension', r.id, o) : Promise.resolve({ data: r, error: null });
      return first.then(function (u) {
        if (u.error) return { error: errText(api, u.error) };
        if (u.data) { r.to_address = u.data.to_address; r.subject = u.data.subject; r.body = u.data.body; }
        if (!keep) return { ok: true };
        var ask = typeof api.confirm === 'function' ? api.confirm({ title: T('rx_keep_title'), text: T('rx_keep_text', { name: r.agent_name || '', to: '\u2066' + c.to + '\u2069' }), okText: T('rx_keep_ok') }) : Promise.resolve(false);
        return Promise.resolve(ask).then(function (yes) {
          if (!yes) return { ok: true };
          return call(api, 'saveParty', { id: r.agent_party_id, email: c.to.toLowerCase() }).then(function (pr) {
            if (pr.error) return { error: T('rx_keep_failed', { e: errText(api, pr.error) }) };
            r.agent_email = c.to.toLowerCase();
            if (api.toast) api.toast(T('rx_kept', { name: r.agent_name || '' }), 'success');
            return { ok: true };
          });
        });
      });
    }
    function rxDecideForm(r) {
      var box = el('div', { class: 'appt-er-rx-decide' });
      var out = el('select', { class: 'form-control', id: 'appt-rx-out-' + r.id });
      var o0 = el('option', { text: T('choose') }); o0.value = ''; out.appendChild(o0);
      RX_OUTCOMES.forEach(function (k) { var o = el('option', { text: T('rxo_' + k) }); o.value = k; out.appendChild(o); });
      var until = input('date', 'appt-rx-new-' + r.id, { dir: 'ltr' }); until.value = String(r.requested_until || '').slice(0, 10);
      var note = input('text', 'appt-rx-note-' + r.id, { maxlength: '1000' });
      box.appendChild(el('div', { class: 'appt-grid' }, [grp(T('rx_f_outcome'), out), grp(T('rx_f_new_date'), until, T('rx_f_new_date_hint')),
        grp(T('rx_f_note'), note, r.status === 'draft' ? T('rx_f_note_phone') : null)]));
      var err = rxErr(null);
      var go = el('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-rx-decide-go': r.id, text: T('rx_decide_go') });
      go.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var o = rxDecidePayload({ outcome: out.value, until: until.value, note: note.value }, r);
        if (o.error) { err.textContent = T(o.error); err.hidden = false; return; }
        var ask = typeof api.confirm === 'function' ? api.confirm({ title: T('rx_decide_title'),
          text: o.outcome === 'rejected' ? T('rx_decide_text_rejected') : T('rx_decide_text', { d: o.decidedUntil }), okText: T('rx_decide_ok') }) : Promise.resolve(false);
        Promise.resolve(ask).then(function (yes) {
          if (!yes) return;
          var sig = JSON.stringify(o);
          U.key['rxd' + r.id] = U.key['rxd' + r.id] && U.key['rxd' + r.id].sig === sig ? U.key['rxd' + r.id] : { sig: sig, key: uuid() };
          o.idemKey = U.key['rxd' + r.id].key;
          go.disabled = true;
          return call(api, 'decideReturnExtension', r.id, o).then(function (x) {
            go.disabled = false;
            if (x.error) { err.textContent = errText(api, x.error); err.hidden = false; return; }
            U.key['rxd' + r.id] = null; U.rx.act[r.id] = null;
            var d = x.data || {}, n = (d.updated || []).length, sk = (d.skipped || []).length;
            var text = o.outcome === 'rejected' ? T('rx_decided_rejected') : T('rx_decided', { n: n, d: o.decidedUntil }) + (sk ? ' ' + T('rx_decided_skipped', { n: sk }) : '');
            if (d.demurrage_hint) text += ' ' + T('rx_demurrage_hint');
            after(text);
          });
        });
      });
      box.appendChild(err);
      box.appendChild(el('div', { class: 'appt-actions' }, go));
      return box;
    }
    function rxCancelForm(r) {
      var box = el('div', { class: 'appt-er-rx-cancel' });
      var why = input('text', 'appt-rx-why-' + r.id, { maxlength: '500' });
      box.appendChild(grp(T('rx_f_cancel_reason'), why));
      var err = rxErr(null);
      var go = el('button', { class: 'btn btn-sm btn-ghost appt-danger', type: 'button', 'data-rx-cancel-go': r.id, text: T('rx_cancel_go') });
      go.addEventListener('click', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var reason = String(why.value || '').trim();
        if (!reason) { err.textContent = T('rx_e_reason'); err.hidden = false; return; }
        go.disabled = true;
        call(api, 'cancelReturnExtension', r.id, reason).then(function (x) {
          go.disabled = false;
          if (x.error) { err.textContent = errText(api, x.error); err.hidden = false; return; }
          U.rx.act[r.id] = null;
          after(T('rx_cancelled'));
        });
      });
      box.appendChild(err);
      box.appendChild(el('div', { class: 'appt-actions' }, go));
      return box;
    }

    return load();
  }

  OPS.txReturn = { VERSION: 'appt-er-2', t: T,
    pure: { PROOF_STATUSES: PROOF_STATUSES, MATCH_NOTES: MATCH_NOTES, EIR_REJECT: EIR_REJECT, mediaType: mediaType, fileProblem: fileProblem,
      dateTimeState: dateTimeState, riyadhLocal: riyadhLocal, notesOf: notesOf, confPct: confPct, confTone: confTone, openProof: openProof,
      verifyPayload: verifyPayload, manualPayload: manualPayload, extractionRow: extractionRow, eirReject: eirReject,
      READ_FAIL_SAVES: READ_FAIL_SAVES, readFailSaves: readFailSaves,
      // 20261128000100
      RX_STATUSES: RX_STATUSES, RX_ACTIVE: RX_ACTIVE, RX_OUTCOMES: RX_OUTCOMES, MAILTO_MAX: MAILTO_MAX, rxActive: rxActive, isEmail: isEmail, crlf: crlf,
      mailtoHref: mailtoHref, rxPreparePayload: rxPreparePayload, rxDecidePayload: rxDecidePayload } };
  var MINE = [{ id: 'empty_return', order: 56, render: renderReturn }];
  var ids = MINE.map(function (s) { return s.id; });
  for (var i = OPS.txSections.length - 1; i >= 0; i--) {
    if (OPS.txSections[i] && ids.indexOf(OPS.txSections[i].id) !== -1) OPS.txSections.splice(i, 1);
  }
  MINE.forEach(function (s) { OPS.txSections.push(s); });
})();
