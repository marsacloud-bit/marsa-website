/* ==========================================================================
   مرسى | MARSA — G6b messaging: the shared kit (window.MarsaMsgKit, MarsaOps.msgKit)
   --------------------------------------------------------------------------
   Contract: docs/online/G6B_SPEC.md ("Front end"). Loaded after rpt/*.js and before
   msg/inbox.js, channels.js, contacts.js, templates.js, tx-msg.js and admin.js.
   Builds on MarsaOps.ui (assets/js/ops/alerts.js).

   * Message bodies, subjects, names, addresses, file names and extracted values are
     UNTRUSTED. Everything here is built with createElement / textContent only — this
     file never assigns markup strings (no inner-HTML), never auto-detects links, never renders HTML and never
     loads a remote image. Bodies go into <pre class="msg-body" dir="auto">; extracted
     spans are highlighted by slicing the stored text by Unicode CODE POINTS (as the
     server counts them) into text nodes + <mark class="msg-span"> elements.
   * Short untrusted strings (file names, addresses, display names) are shown inside
     <bdi> and bidi control characters (U+202A–U+202E, U+2066–U+2069, U+200E/F) are made
     visible («⟦U+202E⟧») so "invoice‮fdp.exe" cannot pass for a PDF.
   * The UI only hides — RLS and the guarded RPCs decide. Role sets mirror §Roles.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};
  Ops.txSections = Ops.txSections || [];

  // §Roles (exact lists; admin.js / app-shell.js R.msg* mirror them)
  var STAFF = ['clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'];
  var ROLES = {
    msgRead: STAFF,
    msgTriage: ['clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'admin'],
    msgApprove: ['operations_manager', 'branch_manager', 'supervisor', 'admin'],
    msgSend: ['clearance_staff', 'operations_manager', 'branch_manager', 'admin'],
    msgVerify: ['operations_manager', 'branch_manager', 'supervisor', 'admin'],
    msgLib: ['admin', 'operations_manager'],
    msgAdmin: ['admin']
  };
  // §16 approval levels
  var LEVEL_ROLES = { standard: ROLES.msgApprove, finance: ['accounts_manager', 'branch_manager', 'admin'], management: ['branch_manager', 'admin'] };
  var DEFAULT_LEVEL = { freight_charges: 'finance', violation: 'management' };

  // Section 0 dictionaries
  var CODES = {
    msg_channel_kind: ['email', 'whatsapp'],
    msg_channel_mode: ['mock', 'live_pending'],
    msg_channel_status: ['not_connected', 'connected', 'error', 'disabled'],
    msg_thread_status: ['new', 'in_progress', 'awaiting_external', 'awaiting_internal', 'resolved', 'spam'],
    msg_priority: ['low', 'normal', 'high', 'urgent'],
    msg_match_status: ['unmatched', 'suggested', 'auto_linked', 'linked', 'review', 'not_related'],
    msg_category: ['telex_release', 'delivery_order', 'freight_charges', 'appointment', 'missing_documents', 'violation', 'empty_return', 'general_inquiry', 'unknown'],
    msg_sender_status: ['unknown', 'known', 'verified', 'mismatch', 'spoof_suspected'],
    msg_extraction_kind: ['bl_number', 'container_no', 'declaration_no', 'invoice_no', 'tx_ref', 'date', 'appointment_no'],
    msg_extraction_status: ['suggested', 'confirmed', 'corrected', 'rejected'],
    msg_reply_status: ['draft', 'pending_approval', 'approved', 'rejected', 'sending', 'sent', 'send_failed', 'send_unknown', 'cancelled'],
    msg_outbound_state: ['queued', 'sending', 'accepted', 'delivered', 'read', 'failed', 'unknown'],
    msg_job_kind: ['probe', 'poll', 'process', 'draft', 'send', 'status'],
    msg_job_status: ['queued', 'running', 'unknown', 'done', 'conflict', 'failed', 'dead', 'cancelled'],
    msg_instruction_kind: ['style', 'language', 'party_rule', 'topic_rule', 'approval_level', 'signature'],
    msg_lib_status: ['draft', 'approved', 'retired'],
    msg_template_key: ['telex_release', 'delivery_order', 'freight_charges', 'empty_return_instructions', 'missing_documents', 'violation_response', 'clarification', 'ack_receipt'],
    msg_risk_flag: ['injection_suspected', 'foreign_address', 'urgency_claim', 'repeated_violation', 'sender_unverified', 'not_addressed_to_channel', 'invalid_check_digit', 'ambiguous_date'],
    msg_auto_reply_kind: ['ack_receipt', 'status_update'],
    msg_approval_level: ['standard', 'finance', 'management'],
    msg_action: ['send_telex', 'issue_do', 'pay_or_query_charges', 'book_or_confirm_appointment', 'provide_documents', 'respond_violation', 'arrange_empty_return', 'answer_inquiry', 'review_manually'],
    msg_verification_method: ['callback', 'known_domain', 'in_person', 'signed_document', 'provider_verified'],
    msg_entity_type: ['client', 'party', 'internal', 'other'],
    msg_scope_type: ['client', 'party', 'transaction'],
    msg_share_reason: ['no_link', 'doc_other_tx', 'doc_voided', 'recipient_unverified', 'recipient_unauthorized', 'kind_not_authorized'],
    msg_missing: ['bl_number', 'container_no', 'transaction', 'appointment_date', 'documents_list', 'recipient_verification'],
    msg_match_reason: ['conflict', 'multiple', 'single_signal', 'unverified_sender', 'no_signal'],
    msg_link_action: ['auto_link', 'link', 'unlink', 'not_related', 'review'],
    msg_signal_kind: ['tx_ref', 'bl_number', 'container_no', 'declaration_no', 'invoice_no', 'appointment_no', 'thread_continuity', 'sender_related'],
    msg_storage_status: ['not_fetched', 'stored', 'too_large', 'blocked'],
    msg_scan_status: ['not_scanned', 'clean', 'infected', 'skipped'],
    msg_delivery_status: ['accepted', 'sent', 'delivered', 'read', 'failed', 'bounced'],
    msg_operation: ['import', 'export', 'any'],
    msg_instruction_scope: ['all', 'party_kind', 'contact', 'category']
  };
  var SENSITIVE_KINDS = ['commercial_invoice', 'customs_declaration', 'bill_of_lading', 'certificate_of_origin', 'saber_certificate', 'operator_invoice', 'government_doc', 'import_file', 'packing_list'];
  var STANDARD_KINDS = ['delivery_order', 'appointment', 'container_delivery_eir', 'empty_return_note', 'empty_return_receipt', 'other'];
  var DOC_KINDS = SENSITIVE_KINDS.concat(STANDARD_KINDS);
  var PARTY_KINDS = ['shipping_agent', 'terminal_operator', 'carrier', 'yard', 'customs_broker', 'supplier', 'other'];
  var PLACEHOLDERS = ['tx_ref', 'bl_number', 'declaration_no', 'container_list', 'client_name', 'counterpart_name', 'operation_label', 'appointment_at', 'terminal_name',
    'return_deadline_list', 'missing_documents_list', 'org_name', 'signature', 'today'];
  var LIVE_REPLY = ['draft', 'pending_approval', 'approved', 'sending', 'send_unknown'];

  var TONES = {
    msg_channel_mode: { mock: 'warning', live_pending: 'neutral' },
    msg_channel_status: { not_connected: 'neutral', connected: 'success', error: 'danger', disabled: 'neutral' },
    msg_thread_status: { 'new': 'info', in_progress: 'brand', awaiting_external: 'warning', awaiting_internal: 'warning', resolved: 'success', spam: 'neutral' },
    msg_priority: { low: 'neutral', normal: 'neutral', high: 'warning', urgent: 'danger' },
    msg_match_status: { unmatched: 'neutral', suggested: 'info', auto_linked: 'success', linked: 'success', review: 'danger', not_related: 'neutral' },
    msg_sender_status: { unknown: 'warning', known: 'info', verified: 'success', mismatch: 'danger', spoof_suspected: 'danger' },
    msg_extraction_status: { suggested: 'info', confirmed: 'success', corrected: 'brand', rejected: 'neutral' },
    msg_reply_status: { draft: 'neutral', pending_approval: 'warning', approved: 'brand', rejected: 'danger', sending: 'info', sent: 'success', send_failed: 'danger', send_unknown: 'warning', cancelled: 'neutral' },
    msg_outbound_state: { queued: 'neutral', sending: 'info', accepted: 'info', delivered: 'success', read: 'success', failed: 'danger', unknown: 'warning' },
    msg_job_status: { queued: 'info', running: 'brand', unknown: 'warning', done: 'success', conflict: 'danger', failed: 'danger', dead: 'danger', cancelled: 'neutral' },
    msg_lib_status: { draft: 'warning', approved: 'success', retired: 'neutral' },
    msg_risk_flag: { injection_suspected: 'danger', foreign_address: 'danger', urgency_claim: 'warning', repeated_violation: 'danger', sender_unverified: 'warning',
      not_addressed_to_channel: 'warning', invalid_check_digit: 'warning', ambiguous_date: 'warning', deadline_soon: 'warning' },
    msg_approval_level: { standard: 'info', finance: 'warning', management: 'danger' },
    msg_storage_status: { not_fetched: 'neutral', stored: 'success', too_large: 'warning', blocked: 'danger' },
    msg_scan_status: { not_scanned: 'neutral', clean: 'success', infected: 'danger', skipped: 'neutral' },
    msg_delivery_status: { accepted: 'info', sent: 'info', delivered: 'success', read: 'success', failed: 'danger', bounced: 'danger' },
    msg_category: { violation: 'danger', freight_charges: 'warning', unknown: 'neutral' }
  };

  // bidi controls that can disguise a file name / address: shown as visible markers
  var BIDI_RE = /[‎‏‪-‮⁦-⁩]/g;
  function visibleBidi(s) {
    return String(s == null ? '' : s).replace(BIDI_RE, function (c) { return '⟦U+' + c.charCodeAt(0).toString(16).toUpperCase() + '⟧'; });
  }
  // code point helpers (the server counts spans in code points, never UTF-16 units)
  function cps(text) { return Array.from(String(text == null ? '' : text)); }
  function cpSlice(text, start, end) { return cps(text).slice(start, end).join(''); }
  function cpLen(text) { return cps(text).length; }

  function buildKit() {
    var U = Ops.ui;
    if (!U) return null;
    var el = U.el;

    function I18N() { return window.MarsaI18n; }
    function interp(s, vars) {
      return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s;
    }
    function dictGet(k) {
      var D = window.MarsaMsgDict || {};
      var s = (D[U.lang()] || {})[k];
      return s == null ? (D.ar || {})[k] : s;
    }
    function has(k) {
      var I = I18N();
      if (I && typeof I.has === 'function' && I.has('msg.' + k)) return true;
      return dictGet(k) != null;
    }
    // msg.<k> → MarsaMsgDict → ops.<k> (generic words) → the key
    function t(k, vars) {
      var I = I18N(), key = 'msg.' + k;
      if (I && typeof I.t === 'function') {
        var s = I.t(key, vars);
        if (s != null && s !== key) return s;
      }
      var d = dictGet(k);
      if (d != null) return interp(d, vars);
      return U.has(k) ? U.t(k, vars) : k;
    }
    // a dynamic key with a plain fallback (unknown codes from the server stay readable)
    function tOr(k, fallback) { return has(k) ? t(k) : String(fallback == null ? k : fallback); }
    // a code's label: msg.<domain>_<code> (complete in i18n/msg.js) → server status_labels → code
    function lab(domain, code, api) {
      if (code == null || code === '') return U.NONE;
      if (has(domain + '_' + code)) return t(domain + '_' + code);
      if (domain === 'document_kind' || domain === 'role' || domain === 'operational_status') {
        var a = api || CUR_API;
        if (a && typeof a.label === 'function') {
          try { var s = a.label(domain, code); if (s && s !== code && s !== domain + '.' + code) return s; } catch (e) { /* fall back */ }
        }
        if (domain === 'document_kind') return U.lab('document_kind', code, a);
      }
      return String(code);
    }
    function tone(domain, code) { return (TONES[domain] || {})[code] || (domain === 'msg_category' ? 'brand' : 'neutral'); }
    function pill(domain, code, api) {
      var p = U.pill(tone(domain, code), lab(domain, code, api));
      p.classList.add('msg-st');
      p.setAttribute('data-code', String(code == null ? '' : code));
      return p;
    }
    function options(domain, withAll, allLabel) {
      var o = (CODES[domain] || []).map(function (c) { return [c, lab(domain, c)]; });
      return withAll ? [['', allLabel || t('all')]].concat(o) : o;
    }
    var CUR_API = null;
    function use(api) { CUR_API = api || null; }

    // --- safe text nodes ----------------------------------------------------------------
    // an untrusted short string (name, address, file name, reference): <bdi>, visible bidi controls
    function safe(v, o) {
      o = o || {};
      if (v == null || v === '') return el('span', { class: 'ops-muted', text: U.NONE });
      return el('bdi', { class: (o.ltr ? 'msg-ltr ' : '') + (o.cls || 'msg-safe'), dir: o.ltr ? 'ltr' : 'auto', text: visibleBidi(v) });
    }
    function addr(v) { return safe(v, { ltr: true, cls: 'msg-addr' }); }
    function ref(v) { return safe(v, { ltr: true, cls: 'msg-ref' }); }
    function preview(v, n) {
      var s = visibleBidi(String(v == null ? '' : v).replace(/\s+/g, ' ').trim());
      var c = cps(s);
      return c.length > (n || 160) ? c.slice(0, n || 160).join('') + '…' : s;
    }
    function when(v) { return v ? U.fmtDate(v, true) : U.NONE; }
    function day(v) { return v ? U.fmtDate(v, false) : U.NONE; }
    function list(x) { return Array.isArray(x) ? x : []; }
    function dataOf(r) { return r && r.data && typeof r.data === 'object' ? r.data : {}; }
    function itemsOf(r) { var d = r && r.data; return Array.isArray(d) ? d : list(d && (d.items || d.rows)); }
    function toastErr(api, r) { U.toast(api, U.errMsg(r.error, api), U.errCode(r.error) === 'MRS_UNKNOWN_RESULT' ? 'warning' : 'error'); }
    // review fix: every successful inbox change tells the shell (NAV badge 'inbox' refreshes on 'marsa:inboxchange')
    function changed() {
      try { if (typeof window.CustomEvent === 'function') window.dispatchEvent(new window.CustomEvent('marsa:inboxchange')); } catch (e) { /* no shell */ }
    }
    function done(api, sc, msg, reload) {
      return function (res) { if (res) changed(); if (res && sc.alive()) { if (msg) U.toast(api, msg, 'success'); reload(); } };
    }
    function fmtSize(n) {
      n = +n; if (!isFinite(n) || n < 0) return U.NONE;
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    }

    // --- roles -----------------------------------------------------------------------
    // can(api, 'msgTriage', branchId): the set name first (admin.js R), then the exact list
    function can(api, set, branchId) {
      if (!api || typeof api.can !== 'function') return false;
      try {
        if (api.can(set, branchId || undefined)) return true;
        return ROLES[set] ? !!api.can(ROLES[set], branchId || undefined) : false;
      } catch (e) { return false; }
    }
    // a thread-scoped action: the server's can.<flag> when present, else the role at the thread branch
    // (a NULL branch = org-wide: any branch passes api.can(set) only for org-wide holders on the server)
    function canFlag(api, serverCan, flag, set, branchId) {
      if (serverCan && typeof serverCan[flag] === 'boolean') return serverCan[flag];
      return can(api, set, branchId);
    }
    function branchName(api, id) {
      if (!id) return t('org_wide');
      var b = (api && Array.isArray(api.branches) ? api.branches : []).filter(function (x) { return x && x.id === id; })[0];
      return b ? ((U.lang() === 'en' && b.name_en) || b.name_ar || b.code || U.NONE) : String(id).slice(0, 8);
    }
    function branchOptions(api, withAll) {
      var opts = (api && Array.isArray(api.branches) ? api.branches : []).filter(function (b) { return b && b.id && b.is_active !== false; })
        .map(function (b) { return [b.id, (U.lang() === 'en' && b.name_en) || b.name_ar || b.code]; });
      return withAll ? [['', t('all_branches')]].concat(opts) : opts;
    }
    function hasApi(api, name) { var M = (api && api.MarsaApi) || window.MarsaApi; return !!(M && typeof M[name] === 'function'); }
    function apiMissing(name) { return U.alertBox('warning', U.t('api_missing', { fn: name })); }

    // --- layout bits (original classes) ----------------------------------------------
    function tabs(items, active, onPick, label) {
      return el('div', { class: 'tab-list msg-tabs', role: 'tablist', 'aria-label': label || null }, items.map(function (it) {
        var b = el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(it[0] === active), 'data-tab': it[0] }, [
          el('span', { text: it[1] }), it[2] != null ? el('span', { class: 'badge badge-sm badge-muted msg-tab-n', text: String(it[2]) }) : null]);
        b.addEventListener('click', function () { if (it[0] !== active) onPick(it[0]); });
        return b;
      }));
    }
    function dl(rows) {
      var n = el('dl', { class: 'app-dl msg-dl' });
      rows.forEach(function (r) {
        if (!r || r[1] == null || r[1] === '') return;
        n.appendChild(el('dt', { text: r[0] }));
        n.appendChild(el('dd', null, r[1]));
      });
      return n;
    }
    function pager(total, limit, offset, onGo) {
      if (!total || total <= limit) return null;
      var page = Math.floor(offset / limit) + 1, pages = Math.ceil(total / limit);
      return el('div', { class: 'adm-pager msg-pager' }, [
        el('p', { class: 'adm-count text-sm text-muted', text: t('page_of', { page: page, pages: pages, total: total }) }),
        el('div', { class: 'adm-pager-btns flex gap-1' }, [
          U.btn(t('prev'), 'btn-secondary', function () { onGo(Math.max(0, offset - limit)); }, { disabled: offset <= 0 }),
          U.btn(t('next'), 'btn-secondary', function () { onGo(offset + limit); }, { disabled: offset + limit >= total })
        ])
      ]);
    }
    function note(type, title, text) {
      return el('div', { class: 'alert alert-' + type + ' msg-note', role: 'note' }, [U.icon(type === 'danger' || type === 'warning' ? 'alert' : 'info'),
        el('div', null, [title ? el('strong', { text: title }) : null, text ? el('span', { text: (title ? ' ' : '') + text }) : null])]);
    }
    // «وضع المحاكاة — لا بريد أو واتساب حقيقي»
    function mockBanner() {
      return el('div', { class: 'alert alert-warning msg-mock-banner', role: 'note', 'data-msg-banner': 'mock' }, [U.icon('info'),
        el('div', null, [el('strong', { text: t('mock_banner_title') }), el('span', { text: ' ' + t('mock_banner_text') })])]);
    }
    function workerNote() { return note('info', null, t('worker_not_deployed')); }
    function riskBadges(flags) {
      var f = list(flags);
      if (!f.length) return null;
      return el('span', { class: 'msg-risks' }, f.map(function (x) { var p = pill('msg_risk_flag', x); p.classList.add('msg-risk'); return p; }));
    }
    // banners for the thread / review screen (injection first)
    function riskBanners(flags) {
      var f = list(flags), out = [];
      if (f.indexOf('injection_suspected') !== -1) out.push(el('div', { class: 'alert alert-danger msg-risk-banner', role: 'alert', 'data-risk': 'injection_suspected' }, [U.icon('alert'),
        el('div', null, [el('strong', { text: lab('msg_risk_flag', 'injection_suspected') }), el('span', { text: ' ' + t('injection_text') })])]));
      if (f.indexOf('foreign_address') !== -1) out.push(el('div', { class: 'alert alert-danger msg-risk-banner', role: 'alert', 'data-risk': 'foreign_address' }, [U.icon('alert'),
        el('div', null, [el('strong', { text: lab('msg_risk_flag', 'foreign_address') }), el('span', { text: ' ' + t('foreign_address_text') })])]));
      f.filter(function (x) { return x !== 'injection_suspected' && x !== 'foreign_address'; }).forEach(function (x) {
        out.push(el('div', { class: 'alert alert-warning msg-risk-banner', role: 'note', 'data-risk': x }, [U.icon('alert'), el('div', { text: lab('msg_risk_flag', x) })]));
      });
      return out;
    }
    function senderBadge(status) { var p = pill('msg_sender_status', status || 'unknown'); p.classList.add('msg-sender'); return p; }
    function kindIcon(kind) {
      return el('span', { class: 'msg-kind msg-kind-' + (kind === 'whatsapp' ? 'whatsapp' : 'email'), title: lab('msg_channel_kind', kind) }, [
        el('span', { class: 'msg-kind-dot', 'aria-hidden': 'true' }), el('span', { class: 'msg-kind-txt', text: lab('msg_channel_kind', kind) })]);
    }
    function aiTag() { return el('span', { class: 'badge badge-sm badge-blue msg-ai-tag', text: t('suggestion') }); }

    // --- body + span highlight ---------------------------------------------------------
    // spans: [{start, end, id, kind, cls}] in code points; overlapping / out-of-range spans are skipped
    function bodyNode(text, spans, o) {
      o = o || {};
      var c = cps(text), pre = el('pre', { class: 'msg-body' + (o.cls ? ' ' + o.cls : ''), dir: 'auto' });
      var ok = list(spans).filter(function (s) { return s && isFinite(s.start) && isFinite(s.end) && s.start >= 0 && s.end > s.start && s.end <= c.length; })
        .slice().sort(function (a, b) { return a.start - b.start || b.end - a.end; });
      var pos = 0;
      ok.forEach(function (s) {
        if (s.start < pos) return;
        if (s.start > pos) pre.appendChild(document.createTextNode(c.slice(pos, s.start).join('')));
        pre.appendChild(el('mark', { class: 'msg-span' + (s.cls ? ' ' + s.cls : ''), 'data-ext-id': s.id || null, 'data-kind': s.kind || null,
          title: s.kind ? lab('msg_extraction_kind', s.kind) : null, text: c.slice(s.start, s.end).join('') }));
        pos = s.end;
      });
      if (pos < c.length) pre.appendChild(document.createTextNode(c.slice(pos).join('')));
      if (!c.length) pre.appendChild(el('span', { class: 'ops-muted', text: t('empty_body') }));
      if (c.length > 1200 && o.expand !== false) {
        pre.classList.add('is-collapsed');
        var wrap = el('div', { class: 'msg-body-wrap' }, pre);
        wrap.appendChild(U.btn(t('expand'), 'btn-ghost msg-expand', function (b) {
          var col = pre.classList.toggle('is-collapsed');
          b.textContent = col ? t('expand') : t('collapse');
        }));
        return wrap;
      }
      return pre;
    }
    // a short context snippet around one span: «… before [mark] after …» (code points)
    function spanSnippet(text, start, end, raw) {
      var c = cps(text);
      if (!(start >= 0 && end > start && end <= c.length)) return el('span', { class: 'ops-muted msg-span-bad', text: t('span_unavailable') });
      var slice = c.slice(start, end).join('');
      var a = Math.max(0, start - 24), b = Math.min(c.length, end + 24);
      return el('span', { class: 'msg-snippet', dir: 'auto', 'data-span-ok': raw == null || raw === slice ? 'true' : 'false' }, [
        a > 0 ? '…' : null, c.slice(a, start).join('').replace(/\s+/g, ' '),
        el('mark', { class: 'msg-span', text: slice }),
        c.slice(end, b).join('').replace(/\s+/g, ' '), b < c.length ? '…' : null
      ]);
    }

    // --- recipients / attachments widgets ------------------------------------------------
    // recipient row {address_norm|address, contact_id, contact_display_name|name, verified, authorized}
    function recipientNode(r) {
      r = r || {};
      var a = r.address_norm || r.address || '';
      var badges = [];
      if (r.verified === true) badges.push(U.pill('success', t('rcpt_verified')));
      else if (r.verified === false) badges.push(U.pill('warning', t('rcpt_unverified')));
      if (r.authorized === true) badges.push(U.pill('success', t('rcpt_authorized')));
      else if (r.authorized === false) badges.push(U.pill('danger', t('rcpt_unauthorized')));
      if (!r.contact_id && r.in_directory === false) badges.push(U.pill('danger', t('rcpt_not_in_directory')));
      var name = r.contact_display_name || r.display_name || r.name;
      return el('li', { class: 'msg-rcpt', 'data-address': a }, [addr(a), name ? el('span', { class: 'cell-sub' }, safe(name)) : null, badges.length ? el('span', { class: 'msg-rcpt-badges' }, badges) : null]);
    }
    function recipientList(to, cc) {
      var box = el('div', { class: 'msg-rcpts' });
      box.appendChild(el('div', { class: 'msg-rcpt-group' }, [el('span', { class: 'text-xs text-muted', text: t('to') }),
        list(to).length ? el('ul', { class: 'msg-rcpt-list' }, list(to).map(recipientNode)) : el('span', { class: 'msg-text-danger', text: t('no_recipient') })]));
      if (list(cc).length) box.appendChild(el('div', { class: 'msg-rcpt-group' }, [el('span', { class: 'text-xs text-muted', text: t('cc') }), el('ul', { class: 'msg-rcpt-list' }, list(cc).map(recipientNode))]));
      return box;
    }
    function reasonsNode(reasons) {
      var r = list(reasons);
      if (!r.length) return null;
      return el('ul', { class: 'msg-reasons' }, r.map(function (x) { return el('li', { text: lab('msg_share_reason', x) }); }));
    }
    function isSensitive(a) {
      if (a && typeof a.sensitive === 'boolean') return a.sensitive;
      return SENSITIVE_KINDS.indexOf(a && (a.classification || a.kind)) !== -1;
    }
    function sensitiveBadge(a) { return isSensitive(a) ? U.pill('danger', t('sensitive')) : U.pill('neutral', t('standard_doc')); }
    // reply attachments (version.attachments: [{document_id, kind, sensitive, sha256, name}])
    function attachmentList(items) {
      var a = list(items);
      if (!a.length) return el('p', { class: 'ops-muted msg-none', text: t('no_attachments') });
      return el('ul', { class: 'msg-att-list' }, a.map(function (x) {
        return el('li', { class: 'msg-att' + (isSensitive(x) ? ' is-sensitive' : ''), 'data-doc': x.document_id || null }, [
          U.icon('file'), safe(x.name || x.file_name || lab('document_kind', x.classification || x.kind)),
          el('span', { class: 'cell-sub', text: lab('document_kind', x.classification || x.kind) }), sensitiveBadge(x),
          x.can_share === false ? U.pill('danger', t('cannot_share')) : null, reasonsNode(x.reasons)
        ]);
      }));
    }
    function catLabel(c) { return lab('msg_category', c || 'unknown'); }
    function levelOf(category, instructions) {
      var found = null;
      list(instructions).forEach(function (i) {
        if (i && i.kind === 'approval_level' && i.status === 'approved' && i.params && i.params.category === category && LEVEL_ROLES[i.params.level]) found = i.params.level;
      });
      return found || DEFAULT_LEVEL[category] || 'standard';
    }

    return {
      U: U, el: el, t: t, tOr: tOr, has: has, lab: lab, tone: tone, pill: pill, options: options, use: use,
      safe: safe, addr: addr, ref: ref, preview: preview, visibleBidi: visibleBidi, when: when, day: day, list: list,
      dataOf: dataOf, itemsOf: itemsOf, toastErr: toastErr, done: done, fmtSize: fmtSize,
      can: can, canFlag: canFlag, branchName: branchName, branchOptions: branchOptions, hasApi: hasApi, apiMissing: apiMissing,
      tabs: tabs, dl: dl, pager: pager, note: note, mockBanner: mockBanner, workerNote: workerNote,
      riskBadges: riskBadges, riskBanners: riskBanners, senderBadge: senderBadge, kindIcon: kindIcon, aiTag: aiTag,
      bodyNode: bodyNode, spanSnippet: spanSnippet, cps: cps, cpSlice: cpSlice, cpLen: cpLen,
      changed: changed, recipientNode: recipientNode, recipientList: recipientList, reasonsNode: reasonsNode, attachmentList: attachmentList,
      isSensitive: isSensitive, sensitiveBadge: sensitiveBadge, catLabel: catLabel, levelOf: levelOf,
      ROLES: ROLES, LEVEL_ROLES: LEVEL_ROLES, DEFAULT_LEVEL: DEFAULT_LEVEL, CODES: CODES, DOC_KINDS: DOC_KINDS, SENSITIVE_KINDS: SENSITIVE_KINDS,
      PARTY_KINDS: PARTY_KINDS, PLACEHOLDERS: PLACEHOLDERS, LIVE_REPLY: LIVE_REPLY
    };
  }

  var KIT = null;
  function kit() { if (!KIT) KIT = buildKit(); return KIT; }
  function noKit(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
    var d = document.createElement('div');
    d.className = 'alert alert-danger';
    d.setAttribute('role', 'alert');
    d.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing';
    root.appendChild(d);
  }
  Ops.msgKit = kit;
  window.MarsaMsgKit = { kit: kit, noKit: noKit, ROLES: ROLES, cps: cps, cpSlice: cpSlice, cpLen: cpLen, visibleBidi: visibleBidi };
})();
