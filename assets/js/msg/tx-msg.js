/* ==========================================================================
   مرسى | MARSA — G6b transaction-detail section (#tx/<id>)  →  MarsaOps.txSections
   --------------------------------------------------------------------------
   Contract: docs/online/G6B_SPEC.md ("Front end → Transaction-detail section").
   Loaded after assets/js/msg/*.js views and before admin.js, which renders every
   section after its own cards as  section.render(root, tx, api)
   Section:
     100 msg-thread «المراسلات المرتبطة» — tx_messages: the e-mail / WhatsApp
         conversations linked to this transaction (channel, counterpart, subject,
         category, status, last message, link method auto / staff + its basis as a
         tooltip text) and «فتح» → #inbox/<thread id>.
   * Renders an empty slot unless api.can('msgRead', tx.branch_id); the server
     filters the threads by thread scope (org + branch) in every case.
   * Read only: linking, replies, approvals and sends happen in #inbox.
   * Strings: own namespace 'msgtx' (ar + en) registered below; labels of the
     msg_* domains come from 'msg.<domain>_<code>' (assets/i18n/msg.js) when
     present, else 'msgtx.lbl_<domain>_<code>', else admin.js labels.
   * Subjects, names, addresses, previews and extracted values are untrusted
     message data: textContent / createElement / setAttribute only (no HTML
     string is ever parsed), no link detection.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  if (!Array.isArray(OPS.txSections)) OPS.txSections = [];

  /* ------------------------------------------------------------------
     Strings ('msgtx.<k>'; labels 'msgtx.lbl_<domain>_<code>')
     ------------------------------------------------------------------ */
  var DICT = {
    ar: {
      none: '—', loading: 'جارٍ التحميل…', load_failed: 'تعذّر تحميل هذا القسم: {e}',
      title: 'المراسلات المرتبطة',
      hint: 'محادثات البريد الإلكتروني وواتساب المربوطة بهذه المعاملة. الربط والردود والاعتماد والإرسال من «صندوق المراسلات».',
      empty: 'لا توجد مراسلات مرتبطة',
      col_channel: 'القناة', col_counterpart: 'الطرف الآخر', col_subject: 'الموضوع', col_category: 'التصنيف', col_status: 'الحالة',
      col_last: 'آخر رسالة', col_link: 'الربط', col_actions: 'إجراءات',
      open: 'فتح', open_inbox: 'صندوق المراسلات',
      link_auto: 'ربط آلي', link_staff: 'ربط بتأكيد موظف', basis: 'أساس الربط: {b}', basis_none: 'أساس الربط غير متاح',
      score: 'الدرجة {n}', signal_thread: 'استمرار المحادثة', signal_sender: 'مرسل مرتبط بالمعاملة',
      suggestion: 'اقتراح', counts: 'المحادثات: {n}', unread: 'غير مقروءة: {n}',
      lbl_msg_channel_kind_email: 'بريد إلكتروني', lbl_msg_channel_kind_whatsapp: 'واتساب',
      lbl_msg_thread_status_new: 'جديدة', lbl_msg_thread_status_in_progress: 'قيد المتابعة', lbl_msg_thread_status_awaiting_external: 'بانتظار رد الجهة',
      lbl_msg_thread_status_awaiting_internal: 'بانتظار إجراء داخلي', lbl_msg_thread_status_resolved: 'منتهية', lbl_msg_thread_status_spam: 'غير مرغوب',
      lbl_msg_match_status_unmatched: 'غير مربوطة', lbl_msg_match_status_suggested: 'ربط مقترح', lbl_msg_match_status_auto_linked: 'مربوطة آليًا',
      lbl_msg_match_status_linked: 'مربوطة بتأكيد موظف', lbl_msg_match_status_review: 'تحتاج مراجعة الربط', lbl_msg_match_status_not_related: 'لا تخص معاملة',
      lbl_msg_category_telex_release: 'طلب تلكس / إفراج', lbl_msg_category_delivery_order: 'إذن تسليم', lbl_msg_category_freight_charges: 'رسوم الشحن',
      lbl_msg_category_appointment: 'موعد', lbl_msg_category_missing_documents: 'مستندات ناقصة', lbl_msg_category_violation: 'مخالفة',
      lbl_msg_category_empty_return: 'متابعة إرجاع الفارغ', lbl_msg_category_general_inquiry: 'استفسار عام', lbl_msg_category_unknown: 'غير مصنفة',
      lbl_msg_extraction_kind_bl_number: 'رقم البوليصة', lbl_msg_extraction_kind_container_no: 'رقم الحاوية', lbl_msg_extraction_kind_declaration_no: 'رقم البيان',
      lbl_msg_extraction_kind_invoice_no: 'رقم الفاتورة', lbl_msg_extraction_kind_tx_ref: 'مرجع المعاملة', lbl_msg_extraction_kind_date: 'تاريخ',
      lbl_msg_extraction_kind_appointment_no: 'رقم الموعد', lbl_msg_extraction_kind_thread_continuity: 'استمرار المحادثة', lbl_msg_extraction_kind_sender_related: 'المرسل مرتبط بالمعاملة'
    },
    en: {
      none: '—', loading: 'Loading…', load_failed: 'This section could not be loaded: {e}',
      title: 'Linked messages',
      hint: 'E-mail and WhatsApp conversations linked to this transaction. Linking, replies, approvals and sending happen in the "Inbox".',
      empty: 'No linked messages',
      col_channel: 'Channel', col_counterpart: 'Counterpart', col_subject: 'Subject', col_category: 'Category', col_status: 'Status',
      col_last: 'Last message', col_link: 'Link', col_actions: 'Actions',
      open: 'Open', open_inbox: 'Inbox',
      link_auto: 'Auto-linked', link_staff: 'Linked by staff', basis: 'Link basis: {b}', basis_none: 'Link basis not available',
      score: 'score {n}', signal_thread: 'Thread continuity', signal_sender: 'Sender related to the transaction',
      suggestion: 'Suggestion', counts: 'Conversations: {n}', unread: 'Unread: {n}',
      lbl_msg_channel_kind_email: 'E-mail', lbl_msg_channel_kind_whatsapp: 'WhatsApp',
      lbl_msg_thread_status_new: 'New', lbl_msg_thread_status_in_progress: 'In progress', lbl_msg_thread_status_awaiting_external: 'Awaiting the other party',
      lbl_msg_thread_status_awaiting_internal: 'Awaiting internal action', lbl_msg_thread_status_resolved: 'Resolved', lbl_msg_thread_status_spam: 'Spam',
      lbl_msg_match_status_unmatched: 'Not linked', lbl_msg_match_status_suggested: 'Suggested link', lbl_msg_match_status_auto_linked: 'Auto-linked',
      lbl_msg_match_status_linked: 'Linked by staff', lbl_msg_match_status_review: 'Link needs review', lbl_msg_match_status_not_related: 'Not related to a transaction',
      lbl_msg_category_telex_release: 'Telex / release request', lbl_msg_category_delivery_order: 'Delivery order', lbl_msg_category_freight_charges: 'Freight charges',
      lbl_msg_category_appointment: 'Appointment', lbl_msg_category_missing_documents: 'Missing documents', lbl_msg_category_violation: 'Violation',
      lbl_msg_category_empty_return: 'Empty return follow-up', lbl_msg_category_general_inquiry: 'General inquiry', lbl_msg_category_unknown: 'Unclassified',
      lbl_msg_extraction_kind_bl_number: 'B/L number', lbl_msg_extraction_kind_container_no: 'Container number', lbl_msg_extraction_kind_declaration_no: 'Declaration number',
      lbl_msg_extraction_kind_invoice_no: 'Invoice number', lbl_msg_extraction_kind_tx_ref: 'Transaction reference', lbl_msg_extraction_kind_date: 'Date',
      lbl_msg_extraction_kind_appointment_no: 'Appointment number', lbl_msg_extraction_kind_thread_continuity: 'Thread continuity', lbl_msg_extraction_kind_sender_related: 'Sender related to the transaction'
    }
  };
  if (I && typeof I.register === 'function') { try { I.register('msgtx', DICT); } catch (e) { /* local dictionary below */ } }

  var TONES = {
    msg_thread_status: { 'new': 'info', in_progress: 'brand', awaiting_external: 'warning', awaiting_internal: 'warning', resolved: 'success', spam: 'neutral' },
    msg_match_status: { unmatched: 'neutral', suggested: 'warning', auto_linked: 'brand', linked: 'success', review: 'danger', not_related: 'neutral' },
    msg_category: {}
  };
  var BADGE_CLS = { success: 'success', warning: 'warning', danger: 'danger', info: 'blue', brand: 'teal', neutral: 'muted' };

  function arr(v) { return Array.isArray(v) ? v : []; }
  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '')); }
  function lang(api) { return api.isEn && api.isEn() ? 'en' : 'ar'; }

  function kit(api) {
    var el = api.el;
    function interp(s, vars) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? String(vars[k]) : m; }); }
    function t(k, vars) {
      var key = 'msgtx.' + k, s = api.t(key, vars);
      if (s && s !== key) return s;
      var d = DICT[lang(api)] || DICT.ar;
      return interp(d[k] != null ? d[k] : (DICT.ar[k] != null ? DICT.ar[k] : k), vars);
    }
    // msg.js (views dictionary) first, then the own fallback, then admin.js / status_labels
    function L(domain, code) {
      if (code == null || code === '') return t('none');
      var short = domain.replace(/^msg_/, '');
      var keys = ['msg.' + domain + '_' + code, 'msg.' + short + '_' + code];
      for (var i = 0; i < keys.length; i++) { var s = api.t(keys[i]); if (s && s !== keys[i]) return s; }
      var own = 'lbl_' + domain + '_' + code, o = t(own);
      if (o !== own) return o;
      return api.label ? api.label(domain, code) : String(code);
    }
    function pill(tone, text) { return el('span', { class: 'badge badge-' + (BADGE_CLS[tone] || 'muted'), 'data-tone': tone || 'neutral', text: text }); }
    function badge(domain, code) {
      var b = pill((TONES[domain] || {})[code] || 'neutral', L(domain, code));
      b.setAttribute('data-code', code == null ? '' : String(code));
      return b;
    }
    function ltr(v) { return v ? el('bdi', { dir: 'ltr', text: String(v) }) : el('span', { text: t('none') }); }
    function when(v) { return v ? api.fmtDate(v, true) : t('none'); }
    function card(title, body, actions) {
      return el('section', { class: 'app-card adm-card ops-tx-card msg-tx-card' }, [
        el('header', { class: 'app-card-head adm-card-head' }, [el('h3', { class: 'app-card-title', text: title }),
          actions && actions.length ? el('div', { class: 'adm-card-actions' }, actions) : null]),
        el('div', { class: 'app-card-body adm-card-body' }, body)
      ]);
    }
    function empty(text) { return el('div', { class: 'empty-state is-compact', 'data-msgtx': 'empty' }, el('p', { text: text })); }
    function table(headers, rows) {
      var body = el('tbody', null, rows.length ? rows : el('tr', { class: 'adm-empty-row' }, el('td', { colspan: headers.length }, empty(t('empty')))));
      return el('div', { class: 'table-wrap adm-table-wrap' }, el('table', { class: 'table table-striped adm-table msg-tx-table' }, [
        el('thead', null, el('tr', null, headers.map(function (h) { return el('th', { scope: 'col', text: h }); }))), body
      ]));
    }
    return { el: el, t: t, L: L, pill: pill, badge: badge, ltr: ltr, when: when, card: card, empty: empty, table: table };
  }

  // a MarsaApi name the data layer does not have (yet) → ops.api_missing instead of a throw
  function M(api, name) {
    var f = api.MarsaApi && api.MarsaApi[name];
    if (typeof f !== 'function') {
      return function () {
        var msg = api.t('ops.api_missing', { fn: name });
        return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', fn: name, message: msg === 'ops.api_missing' ? name : msg } });
      };
    }
    return function () {
      var args = arguments;
      return Promise.resolve().then(function () { return f.apply(api.MarsaApi, args); })
        .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
    };
  }

  // basis → one plain text line (kinds + normalized values; values are data, shown as text in a title attribute)
  function basisText(k, th) {
    var b = th.match_basis || th.link_basis || th.basis || null;
    if (!b || typeof b !== 'object') return k.t('basis_none');
    var parts = arr(b.signals).filter(function (s) { return s && typeof s === 'object' && s.kind; }).slice(0, 10).map(function (s) {
      var v = s.value == null ? '' : String(s.value).replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, '').slice(0, 60);
      return k.L('msg_extraction_kind', s.kind) + (v ? ' ' + v : '') + (s.strength ? ' (' + String(s.strength).slice(0, 12) + ')' : '');
    });
    // review fix: tx_messages returns the basis as signal_kinds (codes only) — label them; the score label is translated
    if (!parts.length) {
      parts = arr(b.signal_kinds).filter(function (x) { return typeof x === 'string' && x; }).slice(0, 10).map(function (x) {
        return x === 'thread' || x === 'sender' ? k.t('signal_' + x) : k.L('msg_extraction_kind', x);
      });
    }
    if (b.score != null && !isNaN(+b.score)) parts.push(k.t('score', { n: +b.score }));
    return parts.length ? k.t('basis', { b: parts.join(' · ') }) : k.t('basis_none');
  }
  function linkMethod(th) {
    var m = th.link_method || th.method || null;
    if (m === 'auto' || m === 'staff') return m;
    if (th.match_status === 'auto_linked') return 'auto';
    if (th.match_status === 'linked') return 'staff';
    return null;
  }

  /* ==================================================================
     100 — linked messages
     ================================================================== */
  function renderMessages(root, tx, api) {
    if (!tx || !api || typeof api.can !== 'function' || !api.can('msgRead', tx.branch_id)) return null;
    var k = kit(api), el = k.el;
    var body = el('div', { class: 'ops-tx-body' }, el('p', { class: 'text-sm text-muted adm-loading', text: k.t('loading') }));
    root.appendChild(k.card(k.t('title'), body, [el('a', { class: 'btn btn-sm btn-ghost', href: '#inbox', 'data-act': 'msgtx-inbox', text: k.t('open_inbox') })]));
    function fill(kids) {
      body.textContent = '';
      (Array.isArray(kids) ? kids : [kids]).forEach(function (n) { if (n) body.appendChild(n); });
    }
    return M(api, 'txMessages')(tx.id).then(function (r) {
      if (r.error) {
        fill(el('div', { class: 'alert alert-' + (r.error.code === 'MRS_UNAVAILABLE' ? 'warning' : 'danger'), role: 'alert' },
          el('div', { text: r.error.code === 'MRS_UNAVAILABLE' ? r.error.message : k.t('load_failed', { e: api.errText ? api.errText(r.error) : (r.error.message || '') }) })));
        return;
      }
      var d = r.data || {};
      var threads = arr(d.threads).filter(function (th) { return th && typeof th === 'object' && isUuid(th.id); });
      var rows = threads.map(function (th) {
        var method = linkMethod(th);
        var counterpart = th.contact_name || th.counterpart_name || th.counterpart_address || th.counterpart_address_norm || th.from_address || null;
        var linkCell = [method ? k.pill(method === 'auto' ? 'brand' : 'success', method === 'auto' ? k.t('link_auto') : k.t('link_staff')) : k.badge('msg_match_status', th.match_status || 'unmatched')];
        var tip = basisText(k, th);
        var subj = th.subject || th.last_message_preview || th.preview || null;
        return el('tr', { 'data-thread': th.id, 'data-link-method': method || null, 'data-match': th.match_status || null }, [
          el('td', null, [k.L('msg_channel_kind', th.kind || th.channel_kind), th.channel_name ? el('span', { class: 'adm-sub', text: String(th.channel_name) }) : null]),
          el('td', null, counterpart ? el('bdi', { dir: 'auto', text: String(counterpart) }) : el('span', { text: k.t('none') })),
          el('td', null, [el('span', { class: 'msg-tx-subject', dir: 'auto', text: subj ? String(subj).slice(0, 160) : k.t('none') }),
            th.unread_count > 0 ? el('span', { class: 'adm-sub', text: k.t('unread', { n: +th.unread_count }) }) : null]),
          el('td', null, th.category ? [k.badge('msg_category', th.category), el('span', { class: 'adm-sub', text: k.t('suggestion') })] : k.t('none')),
          el('td', null, k.badge('msg_thread_status', th.status || 'new')),
          el('td', null, k.when(th.last_message_at)),
          el('td', { class: 'msg-tx-link', title: tip, 'data-basis': tip }, linkCell),
          el('td', null, el('a', { class: 'btn btn-sm btn-ghost', href: '#inbox/' + th.id, 'data-act': 'msgtx-open', text: k.t('open') }))
        ]);
      });
      fill([
        el('p', { class: 'text-sm text-muted', text: k.t('hint') }),
        k.table([k.t('col_channel'), k.t('col_counterpart'), k.t('col_subject'), k.t('col_category'), k.t('col_status'), k.t('col_last'), k.t('col_link'), k.t('col_actions')], rows)
      ]);
    }, function (e) { fill(el('div', { class: 'alert alert-danger', role: 'alert' }, el('div', { text: k.t('load_failed', { e: String(e && e.message || e) }) }))); });
  }

  var MINE = [{ id: 'msg-thread', order: 100, render: renderMessages }];
  var have = {};
  OPS.txSections.forEach(function (s) { if (s && s.id) have[s.id] = true; });
  MINE.forEach(function (s) { if (!have[s.id]) OPS.txSections.push(s); });
})();
