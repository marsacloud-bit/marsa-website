/* ==========================================================================
   مرسى | MARSA — G5 transaction-detail section (#tx/<id>)  →  MarsaOps.txSections
   --------------------------------------------------------------------------
   Contract: docs/online/G5_SPEC.md ("Front end → Transaction-detail section").
   Loaded after assets/js/fin/*.js and before admin.js, which renders every
   section after its own cards as  section.render(root, tx, api)
   Section:
     90 bill-invoices «الفواتير ودفترة» — tx_billing: billing intents (status,
        sync state, Daftra number / status, payment from Daftra), their lines,
        approved charges not yet on an invoice («غير مفوترة»), review items and
        the transaction's financial_status. Actions: create intent, add eligible,
        push to Daftra, pull status, open #billing/<id>.
   * Renders nothing unless api.can('finRead', tx.branch_id); write buttons need
     finWrite at the transaction branch. The server decides in every case.
   * Marsa only prepares DRAFTS; the accountant issues inside Daftra (G5-4).
     Daftra is the source of truth for the official figures (G5-5): they are shown
     next to Marsa's line totals, never merged or "fixed".
   * No real Daftra in staging: a queued job stays queued until the sync worker
     (supabase/functions/daftra-sync, not deployed) runs — the section says so.
   * Strings: own namespace 'billtx' (ar + en) registered below; labels of the
     daftra_* / bill_* domains come from 'bill.<domain>_<code>' (assets/i18n/bill.js)
     when present, else from 'billtx.lbl_<domain>_<code>', else admin.js labels.
   * Server and user data are inserted with textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  if (!Array.isArray(OPS.txSections)) OPS.txSections = [];

  /* ------------------------------------------------------------------
     Strings ('billtx.<k>'; labels 'billtx.lbl_<domain>_<code>')
     ------------------------------------------------------------------ */
  if (I && typeof I.register === 'function') {
    I.register('billtx', {
      ar: {
        none: '—', loading: 'جارٍ التحميل…', load_failed: 'تعذّر تحميل هذا القسم: {e}', saved: 'تم الحفظ.', required: 'أكمل الحقول المطلوبة.',
        title: 'الفواتير ودفترة',
        hint: 'مرسى يجهّز مسودات الفواتير في دفترة من المبالغ المعتمدة فقط، والمحاسب يُصدر الفاتورة داخل دفترة. الأرقام الرسمية (الرقم والإجمالي والسداد) من دفترة.',
        mock_banner: 'وضع المحاكاة — لا اتصال بدفترة حقيقية',
        not_connected: 'الاتصال بدفترة غير جاهز ({s}). الإرسال يتطلب اتصالًا مفحوصًا ومزامنة مفعّلة من «إعداد دفترة».',
        sync_disabled: 'المزامنة مع دفترة موقوفة في «إعداد دفترة».',
        open_settings: 'إعداد دفترة',
        conn: 'الاتصال', fin_status: 'الحالة المالية',
        recommend: 'المعاملة مكتملة تشغيليًا: يمكن إنشاء غرض الفوترة الآن. (الفاتورة قد تسبق إعادة الفارغ؛ لا يُشترط إرجاع الحاويات.)',
        // intents
        intents: 'أغراض الفوترة', intents_empty: 'لا توجد أغراض فوترة لهذه المعاملة بعد.',
        col_ref: 'المرجع التشغيلي', col_purpose: 'الغرض', col_currency: 'العملة', col_status: 'الحالة', col_sync: 'المزامنة',
        col_marsa_total: 'إجمالي مرسى', col_daftra: 'رقم دفترة / حالتها', col_daftra_total: 'إجمالي دفترة', col_payment: 'السداد (من دفترة)',
        col_last_sync: 'آخر مزامنة', col_actions: 'إجراءات',
        paid_of: 'مدفوع {a}', remaining: 'المتبقي {a}', total_diff: 'يختلف عن إجمالي مرسى (الرسمي من دفترة)',
        last_error: 'آخر خطأ: {e}', queued_hint: 'في الانتظار — لم يُشغَّل العامل',
        open: 'فتح', push: 'إرسال إلى دفترة', pull: 'تحديث الحالة من دفترة', add_eligible: 'إضافة غير المفوتر ({n})',
        pushed: 'طُلب الإرسال إلى دفترة. المهمة في الانتظار حتى يعمل عامل المزامنة.', push_dedup: 'طلب الإرسال قائم من قبل (المهمة نفسها).',
        pulled: 'طُلب تحديث الحالة من دفترة.', added: 'أُضيفت البنود غير المفوترة ({n}).',
        why_issued: 'الفاتورة صادرة ومجمّدة.', why_cancelled: 'الغرض ملغى.', why_conflict: 'يوجد تعارض مع دفترة؛ عالجه من صفحة الفاتورة.',
        why_flight: 'مزامنة قيد التنفيذ أو نتيجتها غير معروفة بعد.', why_conn: 'الاتصال بدفترة غير جاهز.', why_lines: 'لا توجد بنود في الفاتورة.',
        why_role: 'يتطلب صلاحية الكتابة المالية في فرع المعاملة.', why_no_remote: 'لم تُرسل إلى دفترة بعد.',
        // lines
        lines: 'البنود ({n})', lines_empty: 'لا توجد بنود.', col_line_ref: 'مرجع البند', col_desc: 'الوصف', col_qty: 'الكمية', col_price: 'السعر',
        col_vat: 'الضريبة ٪', col_total: 'الإجمالي', col_state: 'الحالة', override: 'قيم المحاسب في دفترة محفوظة',
        // eligible
        eligible: 'مبالغ معتمدة غير مفوترة', eligible_empty: 'لا توجد مبالغ معتمدة خارج الفواتير.', col_kind: 'النوع', col_service: 'الخدمة',
        no_intent_cur: 'لا يوجد غرض فوترة مفتوح بهذه العملة',
        // review
        review: 'بنود المراجعة', review_open_queue: 'طابور المراجعة',
        // create
        create: 'غرض فوترة جديد', create_title: 'غرض فوترة جديد — {r}', f_purpose: 'الغرض', f_currency: 'العملة', f_note: 'ملاحظة',
        f_add_eligible: 'إضافة كل المبالغ المعتمدة بهذه العملة', created: 'أُنشئ غرض الفوترة.',
        create_hint: 'فاتورة واحدة لكل معاملة وعملة (نهائية). المبالغ اللاحقة بعد الإصدار تذهب إلى فاتورة إضافية. لا تحويل عملات.',
        // labels (fallback when assets/i18n/bill.js has no entry)
        lbl_bill_purpose_final: 'فاتورة نهائية', lbl_bill_purpose_interim: 'فاتورة مرحلية', lbl_bill_purpose_supplementary: 'فاتورة إضافية',
        lbl_bill_intent_status_open: 'قيد الإعداد', lbl_bill_intent_status_draft: 'مسودة في دفترة', lbl_bill_intent_status_issued: 'صادرة', lbl_bill_intent_status_cancelled: 'ملغاة',
        lbl_bill_sync_state_idle: 'لم تُرسل', lbl_bill_sync_state_pending: 'تغييرات بانتظار الإرسال', lbl_bill_sync_state_in_flight: 'قيد الإرسال',
        lbl_bill_sync_state_synced: 'متزامنة', lbl_bill_sync_state_unknown: 'نتيجة غير معروفة', lbl_bill_sync_state_conflict: 'تعارض', lbl_bill_sync_state_error: 'خطأ',
        lbl_bill_line_state_pending_add: 'بانتظار الإضافة', lbl_bill_line_state_synced: 'في المسودة', lbl_bill_line_state_pending_remove: 'بانتظار الحذف', lbl_bill_line_state_removed: 'محذوف',
        lbl_bill_review_kind_late_charge: 'مبلغ لاحق بعد الإصدار', lbl_bill_review_kind_issued_mismatch: 'الفاتورة الصادرة تختلف', lbl_bill_review_kind_issued_cancelled: 'أُلغيت الفاتورة في دفترة',
        lbl_bill_review_status_open: 'مفتوح', lbl_bill_review_status_resolved: 'تمت المعالجة', lbl_bill_review_status_dismissed: 'مستبعد',
        lbl_daftra_payment_status_unknown: 'غير معروف', lbl_daftra_payment_status_unpaid: 'غير مسددة', lbl_daftra_payment_status_partial: 'مسددة جزئيًا', lbl_daftra_payment_status_paid: 'مسددة',
        lbl_daftra_mode_mock: 'محاكاة تجريبية', lbl_daftra_mode_live_pending: 'حساب حقيقي — غير مُعدّ',
        lbl_daftra_conn_status_not_connected: 'غير متصل', lbl_daftra_conn_status_connected: 'متصل', lbl_daftra_conn_status_error: 'خطأ', lbl_daftra_conn_status_disabled: 'موقوف',
        lbl_fin_charge_kind_service: 'خدمة', lbl_fin_charge_kind_internal_service: 'خدمة داخلية', lbl_fin_charge_kind_reimbursable: 'مبلغ مسترد (تمرير)'
      },
      en: {
        none: '—', loading: 'Loading…', load_failed: 'This section could not be loaded: {e}', saved: 'Saved.', required: 'Complete the required fields.',
        title: 'Invoices & Daftra',
        hint: 'Marsa prepares invoice drafts in Daftra from approved charges only; the accountant issues the invoice inside Daftra. The official figures (number, total, payment) come from Daftra.',
        mock_banner: 'Mock mode — no connection to a real Daftra account',
        not_connected: 'The Daftra connection is not ready ({s}). Pushing needs a checked connection with sync enabled in "Daftra settings".',
        sync_disabled: 'Sync with Daftra is disabled in "Daftra settings".',
        open_settings: 'Daftra settings',
        conn: 'Connection', fin_status: 'Financial status',
        recommend: 'The transaction is operationally complete: a billing intent can be created now. (The invoice may precede the empty return; container returns are not required.)',
        intents: 'Billing intents', intents_empty: 'No billing intents for this transaction yet.',
        col_ref: 'Operational ref', col_purpose: 'Purpose', col_currency: 'Currency', col_status: 'Status', col_sync: 'Sync',
        col_marsa_total: 'Marsa total', col_daftra: 'Daftra no. / status', col_daftra_total: 'Daftra total', col_payment: 'Payment (from Daftra)',
        col_last_sync: 'Last sync', col_actions: 'Actions',
        paid_of: 'Paid {a}', remaining: 'Remaining {a}', total_diff: 'Differs from the Marsa total (Daftra is official)',
        last_error: 'Last error: {e}', queued_hint: 'Queued — the worker has not run',
        open: 'Open', push: 'Push to Daftra', pull: 'Refresh status from Daftra', add_eligible: 'Add unbilled ({n})',
        pushed: 'Push to Daftra requested. The job stays queued until the sync worker runs.', push_dedup: 'A push request already exists (same job).',
        pulled: 'Status refresh from Daftra requested.', added: 'Unbilled charges added ({n}).',
        why_issued: 'The invoice is issued and frozen.', why_cancelled: 'The intent is cancelled.', why_conflict: 'There is a conflict with Daftra; resolve it on the invoice page.',
        why_flight: 'A sync is running or its result is still unknown.', why_conn: 'The Daftra connection is not ready.', why_lines: 'The invoice has no lines.',
        why_role: 'Needs finance write access at the transaction branch.', why_no_remote: 'Not pushed to Daftra yet.',
        lines: 'Lines ({n})', lines_empty: 'No lines.', col_line_ref: 'Line ref', col_desc: 'Description', col_qty: 'Qty', col_price: 'Price',
        col_vat: 'VAT %', col_total: 'Total', col_state: 'State', override: 'Accountant values in Daftra kept',
        eligible: 'Approved charges not yet invoiced', eligible_empty: 'No approved charges outside invoices.', col_kind: 'Kind', col_service: 'Service',
        no_intent_cur: 'No open billing intent in this currency',
        review: 'Review items', review_open_queue: 'Review queue',
        create: 'New billing intent', create_title: 'New billing intent — {r}', f_purpose: 'Purpose', f_currency: 'Currency', f_note: 'Note',
        f_add_eligible: 'Add every approved charge in this currency', created: 'Billing intent created.',
        create_hint: 'One invoice per transaction and currency (final). Charges after issue go to a supplementary invoice. No currency conversion.',
        lbl_bill_purpose_final: 'Final invoice', lbl_bill_purpose_interim: 'Interim invoice', lbl_bill_purpose_supplementary: 'Supplementary invoice',
        lbl_bill_intent_status_open: 'Being prepared', lbl_bill_intent_status_draft: 'Draft in Daftra', lbl_bill_intent_status_issued: 'Issued', lbl_bill_intent_status_cancelled: 'Cancelled',
        lbl_bill_sync_state_idle: 'Not sent', lbl_bill_sync_state_pending: 'Changes pending', lbl_bill_sync_state_in_flight: 'Sending',
        lbl_bill_sync_state_synced: 'Synced', lbl_bill_sync_state_unknown: 'Unknown result', lbl_bill_sync_state_conflict: 'Conflict', lbl_bill_sync_state_error: 'Error',
        lbl_bill_line_state_pending_add: 'Pending add', lbl_bill_line_state_synced: 'In draft', lbl_bill_line_state_pending_remove: 'Pending removal', lbl_bill_line_state_removed: 'Removed',
        lbl_bill_review_kind_late_charge: 'Late charge after issue', lbl_bill_review_kind_issued_mismatch: 'Issued invoice differs', lbl_bill_review_kind_issued_cancelled: 'Cancelled in Daftra',
        lbl_bill_review_status_open: 'Open', lbl_bill_review_status_resolved: 'Resolved', lbl_bill_review_status_dismissed: 'Dismissed',
        lbl_daftra_payment_status_unknown: 'Unknown', lbl_daftra_payment_status_unpaid: 'Unpaid', lbl_daftra_payment_status_partial: 'Partly paid', lbl_daftra_payment_status_paid: 'Paid',
        lbl_daftra_mode_mock: 'Mock (test)', lbl_daftra_mode_live_pending: 'Real account — not configured',
        lbl_daftra_conn_status_not_connected: 'Not connected', lbl_daftra_conn_status_connected: 'Connected', lbl_daftra_conn_status_error: 'Error', lbl_daftra_conn_status_disabled: 'Disabled',
        lbl_fin_charge_kind_service: 'Service', lbl_fin_charge_kind_internal_service: 'Internal service', lbl_fin_charge_kind_reimbursable: 'Reimbursable (pass-through)'
      }
    });
  }

  /* ------------------------------------------------------------------
     Constants (mirror the CHECK lists of 20261105000100_g5_daftra.sql)
     ------------------------------------------------------------------ */
  var PURPOSES = ['final', 'interim', 'supplementary'];
  var CURRENCIES = ['SAR', 'USD', 'EUR', 'AED'];
  var COMPLETE_STAGES = ['operationally_complete', 'under_billing', 'billed', 'closed'];
  var TONES = {
    bill_intent_status: { open: 'info', draft: 'brand', issued: 'success', cancelled: 'neutral' },
    bill_sync_state: { idle: 'neutral', pending: 'warning', in_flight: 'info', synced: 'success', unknown: 'warning', conflict: 'danger', error: 'danger' },
    bill_line_state: { pending_add: 'warning', synced: 'success', pending_remove: 'warning', removed: 'neutral' },
    bill_review_kind: { late_charge: 'warning', issued_mismatch: 'danger', issued_cancelled: 'danger' },
    bill_review_status: { open: 'warning', resolved: 'success', dismissed: 'neutral' },
    daftra_payment_status: { unknown: 'neutral', unpaid: 'warning', partial: 'info', paid: 'success' },
    daftra_conn_status: { not_connected: 'neutral', connected: 'success', error: 'danger', disabled: 'neutral' },
    daftra_mode: { mock: 'warning', live_pending: 'neutral' },
    fin_charge_kind: { service: 'info', internal_service: 'info', reimbursable: 'neutral' },
    financial_status: { not_started: 'info', estimate_only: 'info', draft_pending: 'warning', invoiced: 'brand', settled: 'success' }
  };
  var FLIGHT = ['in_flight', 'unknown'];

  /* ------------------------------------------------------------------
     Toolkit — one per render (closes over the api object)
     ------------------------------------------------------------------ */
  function kit(api) {
    var el = api.el;
    function t(k, vars) { var key = 'billtx.' + k, s = api.t(key, vars); return s === key ? k : s; }
    // bill.js (views dictionary) first, then fin.js for G4 domains, then the own fallback, then admin.js' labels
    function L(domain, code) {
      if (code == null || code === '') return t('none');
      var keys = ['bill.' + domain + '_' + code, 'fin.' + domain + '_' + code, 'fin.' + domain.replace(/^fin_/, '') + '_' + code, 'billtx.lbl_' + domain + '_' + code];
      for (var i = 0; i < keys.length; i++) { var s = api.t(keys[i]); if (s && s !== keys[i]) return s; }
      return api.label ? api.label(domain, code) : String(code);
    }
    var BADGE_CLS = { success: 'success', warning: 'warning', danger: 'danger', info: 'blue', brand: 'teal', neutral: 'muted' };
    function pill(tone, text) { return el('span', { class: 'badge badge-' + (BADGE_CLS[tone] || 'muted'), 'data-tone': tone || 'neutral', text: text }); }
    function badge(domain, code) {
      var b = pill((TONES[domain] || {})[code] || 'neutral', L(domain, code));
      b.setAttribute('data-code', code == null ? '' : String(code));
      return b;
    }
    function money(n, cur) { return n == null || n === '' || isNaN(+n) ? t('none') : api.fmtMoney(+n, cur || 'SAR'); }
    function moneyCell(n, cur, cls) { return el('td', { class: 'num' + (cls ? ' ' + cls : '') }, el('bdi', { dir: 'ltr', text: money(n, cur) })); }
    function ltr(v, cls) { return v ? el('bdi', { dir: 'ltr', class: 'num bill-ref' + (cls ? ' ' + cls : ''), text: String(v) }) : el('span', { text: t('none') }); }
    function when(v) { return v ? api.fmtDate(v, true) : t('none'); }
    function btn(label, cls, onClick, attrs) {
      var b = el('button', Object.assign({ class: 'btn btn-sm ' + (cls || 'btn-ghost'), type: 'button' }, attrs || {}), label);
      if (onClick) b.addEventListener('click', function (e) { e.preventDefault(); if (!b.disabled) onClick(b, e); });
      return b;
    }
    function alertBox(type, text, kids) {
      return el('div', { class: 'alert alert-' + type, role: type === 'danger' ? 'alert' : 'status' }, [el('div', { text: text })].concat(kids || []));
    }
    function card(title, body, actions, cls) {
      return el('section', { class: 'app-card adm-card ops-tx-card bill-tx-card' + (cls ? ' ' + cls : '') }, [
        el('header', { class: 'app-card-head adm-card-head' }, [el('h3', { class: 'app-card-title', text: title }),
          actions && actions.filter(Boolean).length ? el('div', { class: 'adm-card-actions' }, actions.filter(Boolean)) : null]),
        el('div', { class: 'app-card-body adm-card-body' }, body)
      ]);
    }
    function subHead(text, actions) {
      return el('div', { class: 'fin-tx-subhead bill-tx-subhead' }, [el('h4', { class: 'ops-sub-title', text: text }),
        actions && actions.filter(Boolean).length ? el('div', { class: 'adm-row-actions' }, actions.filter(Boolean)) : null]);
    }
    function empty(text) { return el('div', { class: 'empty-state is-compact' }, el('p', { text: text })); }
    function table(headers, rows, emptyText, cls) {
      var body = el('tbody', null, rows.length ? rows : el('tr', { class: 'adm-empty-row' }, el('td', { colspan: headers.length }, empty(emptyText || t('none')))));
      return el('div', { class: 'table-wrap adm-table-wrap' }, el('table', { class: 'table table-striped adm-table' + (cls ? ' ' + cls : '') }, [
        el('thead', null, el('tr', null, headers.map(function (h) {
          h = typeof h === 'string' ? { label: h } : h;
          return el('th', { scope: 'col', class: h.num ? 'num' : null, text: h.label });
        }))), body
      ]));
    }
    function actions(list) { list = list.filter(Boolean); return list.length ? el('div', { class: 'adm-row-actions' }, list) : null; }
    function field(o) {
      var id = 'bltx-' + o.name, ctl;
      var common = { class: 'form-control', id: id, name: o.name, required: !!o.req, dir: o.ltr ? 'ltr' : null };
      if (o.type === 'select') {
        ctl = el('select', common, (o.options || []).map(function (p) { return el('option', { value: p[0], text: p[1] }); }));
        ctl.value = o.value == null ? '' : String(o.value);
      } else if (o.type === 'textarea') {
        ctl = el('textarea', Object.assign(common, { rows: o.rows || 2, maxlength: o.max || null }));
        ctl.value = o.value == null ? '' : String(o.value);
      } else if (o.type === 'checkbox') {
        ctl = el('input', { class: 'form-check-input', id: id, name: o.name, type: 'checkbox' });
        ctl.checked = !!o.value;
        return el('div', { class: 'form-group form-check' + (o.full ? ' adm-full' : ''), 'data-field': o.name }, [
          ctl, el('label', { class: 'form-check-label', for: id, text: ' ' + o.label })]);
      } else {
        ctl = el('input', Object.assign(common, { type: o.type || 'text', maxlength: o.max || null, autocomplete: 'off', value: o.value == null ? '' : o.value }));
      }
      return el('div', { class: 'form-group' + (o.full ? ' adm-full' : ''), 'data-field': o.name }, [
        el('label', { class: 'form-label', for: id }, [o.label, o.req ? el('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null]),
        ctl, o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null
      ]);
    }
    function grid(kids) { return el('div', { class: 'adm-form-grid' }, kids); }
    function val(form, name) { var e = form.elements[name]; if (!e) return null; var v = String(e.value == null ? '' : e.value).trim(); return v === '' ? null : v; }
    function idem() {
      var c = null;
      return function (payload) {
        var sig; try { sig = JSON.stringify(payload); } catch (e) { sig = String(Math.random()); }
        if (!c || c.sig !== sig) c = { sig: sig, key: api.newIdemKey ? api.newIdemKey() : null };
        return c.key;
      };
    }
    return { el: el, t: t, L: L, pill: pill, badge: badge, money: money, moneyCell: moneyCell, ltr: ltr, when: when, btn: btn,
      alert: alertBox, card: card, subHead: subHead, empty: empty, table: table, actions: actions, field: field, grid: grid, val: val, idem: idem };
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
  function arr(v) { return Array.isArray(v) ? v : []; }
  function live(i) { return i && i.status !== 'cancelled'; }
  function liveLines(i) { return arr(i && i.lines).filter(function (l) { return l && l.state !== 'removed'; }); }

  /* ==================================================================
     90 — invoices & Daftra
     ================================================================== */
  function renderBilling(root, tx, api) {
    if (!tx || !api.can('finRead', tx.branch_id)) return null;
    var k = kit(api), el = k.el;
    var canWrite = api.can('finWrite', tx.branch_id);
    var body = el('div', { class: 'ops-tx-body' }, el('p', { class: 'text-sm text-muted adm-loading', text: k.t('loading') }));
    var createBtn = canWrite ? k.btn(k.t('create'), 'btn-primary', function () { createDialog(lastData); }, { 'data-act': 'bill-create', disabled: true }) : null;
    root.appendChild(k.card(k.t('title'), body, [createBtn], 'bill-tx-invoices'));
    var lastData = null;

    function fill(kids) {
      body.textContent = '';
      (Array.isArray(kids) ? kids : [kids]).forEach(function (n) { if (n) body.appendChild(n); });
    }

    // ---- connection / status strip -----------------------------------
    function connectionNodes(conn, finStatus) {
      conn = conn || {};
      var status = conn.status || 'not_connected', mode = conn.mode || 'mock';
      var out = [];
      if (mode === 'mock') out.push(el('div', { class: 'alert alert-warning bill-mock-banner', role: 'note', 'data-bill': 'mock-banner' }, el('div', { text: k.t('mock_banner') })));
      var settings = el('a', { class: 'btn btn-sm btn-ghost', href: '#daftra', text: k.t('open_settings') });
      if (status !== 'connected') out.push(k.alert('info', k.t('not_connected', { s: k.L('daftra_conn_status', status) }), [settings]));
      else if (conn.sync_enabled === false) out.push(k.alert('info', k.t('sync_disabled'), [settings]));
      out.push(el('div', { class: 'bill-tx-strip adm-meta' }, [
        el('span', { class: 'text-sm', text: k.t('conn') + ': ' }), k.badge('daftra_mode', mode), ' ', k.badge('daftra_conn_status', status),
        el('span', { class: 'text-sm', text: ' · ' + k.t('fin_status') + ': ' }), k.badge('financial_status', finStatus || tx.financial_status || 'not_started')
      ]));
      return out;
    }

    // ---- why push / pull are not offered -------------------------------
    function pushBlock(i, conn) {
      if (!canWrite) return k.t('why_role');
      if (i.status === 'issued') return k.t('why_issued');
      if (i.status === 'cancelled') return k.t('why_cancelled');
      if (i.sync_state === 'conflict') return k.t('why_conflict');
      if (FLIGHT.indexOf(i.sync_state) !== -1) return k.t('why_flight');
      if (!conn || conn.status !== 'connected' || conn.sync_enabled === false) return k.t('why_conn');
      if (!liveLines(i).length && !(+i.line_count > 0)) return k.t('why_lines');
      return null;
    }
    function pullBlock(i) {
      if (!canWrite) return k.t('why_role');
      if (!i.external_invoice_id) return k.t('why_no_remote');
      if (i.status === 'cancelled') return k.t('why_cancelled');
      return null;
    }
    // the intent's latest push job, when the server reports it (staging: no deployed worker → it stays queued)
    function queued(i) {
      var js = i.job_status || (i.job && i.job.status) || (i.last_job && i.last_job.status);
      return js === 'queued';
    }

    function intentActions(i, conn, eligibleSameCur) {
      var list = [el('a', { class: 'btn btn-sm btn-ghost', href: '#billing/' + i.id, 'data-act': 'bill-open', text: k.t('open') })];
      if (!canWrite || !live(i)) return list;
      var pb = pushBlock(i, conn), plb = pullBlock(i);
      var push = k.btn(k.t('push'), 'btn-primary', function (b) {
        b.disabled = true;
        M(api, 'requestBillingPush')(i.id, { idemKey: pushKey(i.id) }).then(function (r) {
          if (r.error) { b.disabled = false; api.toast(api.errText(r.error), 'error'); return; }
          var d = r.data || {};
          api.toast(d.deduplicated ? k.t('push_dedup') : k.t('pushed'), 'success');
          api.refresh();
        });
      }, { 'data-act': 'bill-push', disabled: !!pb, title: pb || null });
      list.push(push);
      if (i.external_invoice_id) {
        list.push(k.btn(k.t('pull'), 'btn-ghost', function (b) {
          b.disabled = true;
          M(api, 'requestBillingPull')(i.id).then(function (r) {
            if (r.error) { b.disabled = false; api.toast(api.errText(r.error), 'error'); return; }
            api.toast(k.t('pulled'), 'success'); api.refresh();
          });
        }, { 'data-act': 'bill-pull', disabled: !!plb, title: plb || null }));
      }
      if ((i.status === 'open' || i.status === 'draft') && eligibleSameCur > 0) {
        list.push(k.btn(k.t('add_eligible', { n: eligibleSameCur }), 'btn-ghost', function (b) {
          b.disabled = true;
          M(api, 'addBillingLines')(i.id, null, { idemKey: addKey(i.id) }).then(function (r) {
            if (r.error) { b.disabled = false; api.toast(api.errText(r.error), 'error'); return; }
            api.toast(k.t('added', { n: arr(r.data && r.data.added).length || eligibleSameCur }), 'success'); api.refresh();
          });
        }, { 'data-act': 'bill-add-eligible' }));
      }
      return list;
    }
    // one idempotency key per intent and action while this render lives (a double click replays)
    var keys = {};
    function keyFor(kind, id) { var n = kind + ':' + id; if (!keys[n]) keys[n] = api.newIdemKey ? api.newIdemKey() : null; return keys[n]; }
    function pushKey(id) { return keyFor('push', id); }
    function addKey(id) { return keyFor('add', id); }

    function intentRow(i, conn, eligible) {
      var cur = i.currency || 'SAR';
      var sameCur = eligible.filter(function (c) { return (c.currency || 'SAR') === cur; }).length;
      var remoteTotal = i.remote_total, marsaTotal = i.lines_total;
      var diff = remoteTotal != null && marsaTotal != null && Math.abs(+remoteTotal - +marsaTotal) >= 0.005;
      var pay = [k.badge('daftra_payment_status', i.payment_status || 'unknown')];
      if (i.paid_amount != null && +i.paid_amount > 0) pay.push(el('span', { class: 'adm-sub', text: k.t('paid_of', { a: k.money(i.paid_amount, cur) }) }));
      if (remoteTotal != null && i.paid_amount != null && i.payment_status !== 'paid') {
        pay.push(el('span', { class: 'adm-sub', text: k.t('remaining', { a: k.money(Math.max(0, +remoteTotal - +i.paid_amount), cur) }) }));
      }
      var syncCell = [k.badge('bill_sync_state', i.sync_state || 'idle')];
      if (queued(i)) syncCell.push(el('span', { class: 'adm-sub bill-queued', text: k.t('queued_hint') }));
      if (i.last_error_message || i.last_error_code) syncCell.push(el('span', { class: 'adm-sub text-danger', text: k.t('last_error', { e: i.last_error_message || i.last_error_code }) }));
      var tr = el('tr', { 'data-intent': i.id, 'data-status': i.status || null, 'data-sync': i.sync_state || null, class: i.sync_state === 'conflict' ? 'bill-row-conflict' : null }, [
        el('td', null, k.ltr(i.operational_ref)),
        el('td', null, k.L('bill_purpose', i.purpose || 'final')),
        el('td', null, el('bdi', { dir: 'ltr', text: cur })),
        el('td', null, k.badge('bill_intent_status', i.status || 'open')),
        el('td', null, syncCell),
        k.moneyCell(marsaTotal, cur),
        el('td', null, [i.daftra_number ? k.ltr(i.daftra_number) : el('span', { text: k.t('none') }),
          i.daftra_status ? el('span', { class: 'adm-sub', dir: 'ltr', text: String(i.daftra_status) }) : null]),
        el('td', { class: 'num' + (diff ? ' bill-total-diff' : '') }, [el('bdi', { dir: 'ltr', text: k.money(remoteTotal, cur) }),
          diff ? el('span', { class: 'adm-sub text-warning', text: k.t('total_diff') }) : null]),
        el('td', null, pay),
        el('td', null, k.when(i.last_synced_at)),
        el('td', null, k.actions(intentActions(i, conn, sameCur)))
      ]);
      return tr;
    }

    function linesBlock(i) {
      var lines = arr(i.lines);
      if (!lines.length) return null;
      var cur = i.currency || 'SAR';
      var rows = lines.map(function (l) {
        return el('tr', { 'data-line': l.id || null, 'data-state': l.state || null, class: l.state === 'removed' ? 'bill-line-removed' : null }, [
          el('td', null, k.ltr(l.line_ref)),
          el('td', null, [el('span', { text: l.description || k.t('none') }), l.remote_override ? el('span', { class: 'adm-sub', text: k.t('override') }) : null]),
          el('td', { class: 'num' }, el('bdi', { dir: 'ltr', text: l.quantity == null ? k.t('none') : String(l.quantity) })),
          k.moneyCell(l.unit_price, l.currency || cur),
          el('td', { class: 'num' }, el('bdi', { dir: 'ltr', text: l.vat_rate == null ? k.t('none') : String(l.vat_rate) })),
          k.moneyCell(l.total_amount, l.currency || cur),
          el('td', null, k.badge('bill_line_state', l.state || 'pending_add'))
        ]);
      });
      return el('div', { class: 'bill-tx-lines', 'data-lines-of': i.id }, [
        k.subHead(k.t('lines', { n: liveLines(i).length }) + ' — ' + (i.operational_ref || '')),
        k.table([k.t('col_line_ref'), k.t('col_desc'), { label: k.t('col_qty'), num: true }, { label: k.t('col_price'), num: true },
          { label: k.t('col_vat'), num: true }, { label: k.t('col_total'), num: true }, k.t('col_state')], rows, k.t('lines_empty'))
      ]);
    }

    function eligibleBlock(eligible, intents) {
      var openCurs = {};
      intents.forEach(function (i) { if (i.status === 'open' || i.status === 'draft') openCurs[i.currency || 'SAR'] = true; });
      var rows = eligible.map(function (c) {
        var cur = c.currency || 'SAR';
        return el('tr', { 'data-charge': c.id || null }, [
          el('td', null, c.description || k.t('none')),
          el('td', null, k.badge('fin_charge_kind', c.kind)),
          el('td', null, c.service_code ? k.L('fin_service', c.service_code) : k.t('none')),
          el('td', null, [el('bdi', { dir: 'ltr', text: cur }), openCurs[cur] ? null : el('span', { class: 'adm-sub', text: k.t('no_intent_cur') })]),
          k.moneyCell(c.total_amount, cur)
        ]);
      });
      return el('div', { class: 'bill-tx-eligible' }, [
        k.subHead(k.t('eligible')),
        k.table([k.t('col_desc'), k.t('col_kind'), k.t('col_service'), k.t('col_currency'), { label: k.t('col_total'), num: true }], rows, k.t('eligible_empty'))
      ]);
    }

    function reviewBlock(items) {
      if (!items.length) return null;
      return el('div', { class: 'bill-tx-review' }, [
        k.subHead(k.t('review'), [el('a', { class: 'btn btn-sm btn-ghost', href: '#billing/queue', text: k.t('review_open_queue') })]),
        el('ul', { class: 'adm-list' }, items.map(function (r) {
          return el('li', { 'data-review': r.id || null }, [k.badge('bill_review_kind', r.kind), ' ', k.badge('bill_review_status', r.status || 'open'),
            r.intent_id ? el('a', { class: 'adm-sub', href: '#billing/' + r.intent_id, text: ' ' + k.t('open') }) : null]);
        }))
      ]);
    }

    // ---- create intent dialog --------------------------------------------
    function createDialog(d) {
      d = d || {};
      var key = k.idem();
      var curs = [];
      arr(d.eligible_charges).forEach(function (c) { var x = c.currency || 'SAR'; if (curs.indexOf(x) === -1) curs.push(x); });
      CURRENCIES.forEach(function (c) { if (curs.indexOf(c) === -1) curs.push(c); });
      var hasFinal = arr(d.intents).some(function (i) { return live(i) && i.purpose === 'final'; });
      var issuedFinal = arr(d.intents).some(function (i) { return i.purpose === 'final' && i.status === 'issued'; });
      var purpose = issuedFinal ? 'supplementary' : (hasFinal ? 'interim' : 'final');
      api.modal({
        title: k.t('create_title', { r: tx.ref || '' }), submitText: k.t('create'),
        body: [
          el('p', { class: 'text-sm text-muted', text: k.t('create_hint') }),
          k.grid([
            k.field({ name: 'purpose', label: k.t('f_purpose'), type: 'select', req: true, value: purpose,
              options: PURPOSES.map(function (p) { return [p, k.L('bill_purpose', p)]; }) }),
            k.field({ name: 'currency', label: k.t('f_currency'), type: 'select', req: true, value: curs[0], ltr: true,
              options: curs.map(function (c) { return [c, c]; }) }),
            k.field({ name: 'note', label: k.t('f_note'), type: 'textarea', max: 2000, full: true }),
            k.field({ name: 'add_eligible', label: k.t('f_add_eligible'), type: 'checkbox', value: true, full: true })
          ])
        ],
        onSubmit: function (form) {
          var p = { transaction_id: tx.id, purpose: k.val(form, 'purpose'), currency: k.val(form, 'currency'), note: k.val(form, 'note'),
            add_eligible: !!(form.elements.add_eligible && form.elements.add_eligible.checked) };
          if (!p.purpose || !p.currency) return k.t('required');
          return M(api, 'createBillingIntent')(p, { idemKey: key(p) }).then(function (r) {
            if (r.error) return api.errText(r.error);
            api.toast(k.t('created'), 'success');
            var id = r.data && (r.data.id || (r.data.intent && r.data.intent.id));
            if (id && api.go) api.go('#billing/' + id); else api.refresh();
            return true;
          });
        }
      });
    }

    return M(api, 'txBilling')(tx.id).then(function (r) {
      if (r.error) {
        // finance hidden for this role at this branch: the server has the last word, show nothing more
        if (r.error.code === 'MRS_FORBIDDEN' && r.error.field === 'finance') { root.textContent = ''; return; }
        fill(k.alert('warning', k.t('load_failed', { e: api.errText(r.error) })));
        return;
      }
      var d = lastData = r.data || {};
      var intents = arr(d.intents), eligible = arr(d.eligible_charges), reviews = arr(d.review_items);
      var conn = d.connection || {};
      if (createBtn) createBtn.disabled = false;
      var kids = [el('p', { class: 'text-sm text-muted', text: k.t('hint') })].concat(connectionNodes(conn, d.financial_status));
      if (!intents.filter(live).length && eligible.length && COMPLETE_STAGES.indexOf(tx.operational_status) !== -1) {
        kids.push(k.alert('info', k.t('recommend')));
      }
      kids.push(k.subHead(k.t('intents')));
      kids.push(k.table([k.t('col_ref'), k.t('col_purpose'), k.t('col_currency'), k.t('col_status'), k.t('col_sync'),
        { label: k.t('col_marsa_total'), num: true }, k.t('col_daftra'), { label: k.t('col_daftra_total'), num: true }, k.t('col_payment'),
        k.t('col_last_sync'), k.t('col_actions')], intents.map(function (i) { return intentRow(i, conn, eligible); }), k.t('intents_empty'), 'bill-intents-table'));
      intents.filter(live).forEach(function (i) { var b = linesBlock(i); if (b) kids.push(b); });
      kids.push(eligibleBlock(eligible, intents));
      var rv = reviewBlock(reviews); if (rv) kids.push(rv);
      fill(kids);
    }, function (e) { fill(k.alert('danger', k.t('load_failed', { e: String(e && e.message || e) }))); });
  }

  var MINE = [{ id: 'bill-invoices', order: 90, render: renderBilling }];
  var have = {};
  OPS.txSections.forEach(function (s) { if (s && s.id) have[s.id] = true; });
  MINE.forEach(function (s) { if (!have[s.id]) OPS.txSections.push(s); });
})();
