/* ==========================================================================
   مرسى | MARSA — G5 billing & Daftra: the shared bill kit (MarsaOps.billKit)
   and the views #billing, #billing/<intentId>, #billing/queue
   --------------------------------------------------------------------------
   Contract: docs/online/G5_SPEC.md ("Front end" → views, MarsaApi names).
   Built on MarsaOps.ui (assets/js/ops/alerts.js) and MarsaOps.finKit()
   (assets/js/fin/invoices.js, loaded before this file). Strings are
   'bill.<k>' (assets/i18n/bill.js, also window.MarsaBillDict), falling back to
   the fin / ops strings.

   * The UI only hides — RLS and the guarded RPCs are the gate. Write buttons
     need can('finWrite', branch), approve buttons can('finApprove', branch),
     settings can('billAdmin').
   * Marsa only prepares Daftra DRAFTS; the accountant issues inside Daftra.
     Daftra is the source of truth for the official document: its figures
     (remote_*) are shown next to Marsa's line totals, a difference is
     highlighted and never "fixed" here.
   * There is no Daftra connection in staging: the adapter is a mock and the
     sync worker is not deployed, so queued jobs stay queued (the UI says so).
   * Server and user data go through textContent / createElement only
     (request / response JSON in <pre> via textContent).
   ========================================================================== */
(function () {
  'use strict';
  // review items carry the charge as {id, kind, status, currency, description, total_amount} (get_billing_intent / billing_review_queue)
  function chargeDesc(it) { return (it && (it.charge_description || (it.charge && it.charge.description))) || ''; }

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};
  Ops.txSections = Ops.txSections || [];

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var PAGE = 50;

  // the fixed capability list (G5 §2) and the ones the push gate needs
  var CAPABILITY_KEYS = ['clients.search_by_ref', 'clients.read', 'clients.create', 'clients.update', 'products.search_by_code',
    'products.search_by_name', 'products.create', 'invoices.create_draft', 'invoices.read', 'invoices.search_by_reference',
    'invoices.update_draft', 'invoices.line_reference_field', 'invoices.version_token', 'invoices.multi_currency', 'invoices.issue',
    'payments.read', 'credit_notes.create'];
  var PUSH_CAPABILITIES = ['invoices.create_draft', 'invoices.read', 'invoices.search_by_reference', 'invoices.update_draft',
    'clients.search_by_ref', 'clients.create', 'products.search_by_code', 'products.create'];
  var NEVER_USED = ['invoices.issue', 'credit_notes.create'];

  /* ==================================================================
     MarsaOps.billKit — strings, labels, badges, shared dialogs
     ================================================================== */
  function buildKit() {
    var F = Ops.finKit && Ops.finKit();
    if (!F) return null;
    var U = F.U, el = U.el;

    function I18N() { return window.MarsaI18n; }
    function interp(s, vars) {
      return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s;
    }
    function dictGet(k) {
      var D = window.MarsaBillDict || {};
      var s = (D[U.lang()] || {})[k];
      return s == null ? (D.ar || {})[k] : s;
    }
    function has(k) {
      var I = I18N();
      if (I && typeof I.has === 'function' && I.has('bill.' + k)) return true;
      return dictGet(k) != null;
    }
    // bill.<k> → MarsaBillDict → fin.<k> → ops.<k> → the key
    function t(k, vars) {
      var I = I18N(), key = 'bill.' + k;
      if (I && typeof I.t === 'function') {
        var s = I.t(key, vars);
        if (s != null && s !== key) return s;
      }
      var d = dictGet(k);
      if (d != null) return interp(d, vars);
      return F.t(k, vars);
    }
    // a code's label: bill.<domain>_<code> → (fin_* domains) the fin kit → server status_labels → code
    var SERVER_FIRST = { financial_status: 1, operational_status: 1 };
    function lab(domain, code, api) {
      if (code == null || code === '') return U.NONE;
      if (SERVER_FIRST[domain] && api && typeof api.label === 'function') {
        try { var s0 = api.label(domain, code); if (s0 && s0 !== code && s0 !== domain + '.' + code) return s0; } catch (e) { /* fall back */ }
      }
      if (has(domain + '_' + code)) return t(domain + '_' + code);
      if (/^fin_/.test(domain)) return F.lab(domain, code, api);
      if (api && typeof api.label === 'function') {
        try { var s = api.label(domain, code); if (s && s !== code && s !== domain + '.' + code) return s; } catch (e) { /* fall back */ }
      }
      return String(code);
    }
    var TONES = {
      daftra_mode: { mock: 'warning', live_pending: 'neutral' },
      daftra_conn_status: { not_connected: 'neutral', connected: 'success', error: 'danger', disabled: 'neutral' },
      daftra_link_status: { pending: 'warning', linked: 'success', drift: 'warning', needs_review: 'danger', error: 'danger', unlinked: 'neutral' },
      daftra_item_status: { pending: 'warning', linked: 'success', needs_review: 'danger', error: 'danger', retired: 'neutral' },
      daftra_payment_status: { unknown: 'neutral', unpaid: 'danger', partial: 'warning', paid: 'success' },
      bill_purpose: { final: 'brand', interim: 'info', supplementary: 'info' },
      bill_intent_status: { open: 'info', draft: 'brand', issued: 'success', cancelled: 'neutral' },
      bill_sync_state: { idle: 'neutral', pending: 'warning', in_flight: 'info', synced: 'success', unknown: 'warning', conflict: 'danger', error: 'danger' },
      bill_line_state: { pending_add: 'warning', synced: 'success', pending_remove: 'warning', removed: 'neutral' },
      bill_job_status: { queued: 'info', running: 'brand', unknown: 'warning', done: 'success', conflict: 'danger', failed: 'danger', dead: 'danger', cancelled: 'neutral' },
      bill_review_kind: { late_charge: 'warning', issued_mismatch: 'danger', issued_cancelled: 'danger' },
      bill_review_status: { open: 'warning', resolved: 'success', dismissed: 'neutral' },
      bill_attempt_outcome: { ok: 'success', retry: 'warning', failed: 'danger', unknown: 'warning', conflict: 'danger', frozen: 'info', abandoned: 'neutral', lease_lost: 'neutral' },
      bill_conflict_reason: { remote_edited: 'danger', remote_missing: 'danger', external_in_use: 'danger' },
      financial_status: { not_started: 'info', estimate_only: 'info', draft_pending: 'warning', invoiced: 'brand', settled: 'success' }
    };
    function tone(domain, code) { return (TONES[domain] || {})[code] || 'neutral'; }
    function pill(domain, code, api) {
      var p = U.pill(tone(domain, code), lab(domain, code, api));
      p.classList.add('bill-st');
      if (domain === 'bill_sync_state') p.classList.add('bill-sync', 'bill-sync-' + (code || 'idle'));
      return p;
    }
    function ref(v, cls) { return v == null || v === '' ? el('span', { class: 'ops-muted', text: U.NONE }) : el('bdi', { dir: 'ltr', class: 'bill-ref' + (cls ? ' ' + cls : ''), text: String(v) }); }
    function intentLink(id, opRef) {
      if (!id) return ref(opRef);
      return el('a', { class: 'ops-ref bill-ref', href: '#billing/' + id }, el('bdi', { dir: 'ltr', text: opRef || String(id).slice(0, 8) }));
    }
    function txLink(id, txRef) {
      if (!id) return ref(txRef);
      return el('a', { class: 'ops-ref', href: '#tx/' + id }, el('bdi', { dir: 'ltr', text: txRef || String(id).slice(0, 8) }));
    }
    function when(v) { return v ? U.fmtDate(v, true) : U.NONE; }
    function clientName(row) {
      return U.pick(row, U.lang() === 'en' ? ['client_name_en', 'client.name_en', 'client_name', 'client_name_ar', 'client.name_ar']
        : ['client_name', 'client_name_ar', 'client.name_ar', 'client_name_en', 'client.name_en']) || U.NONE;
    }
    // item_key 'service:customs_clearance' → «تخليص جمركي» + kind
    function itemLabel(key) {
      var p = String(key || '').split(':'), kind = p[0], svc = p[1];
      var name = !svc || svc === 'none' ? t('item_other_services') : F.lab('fin_service', svc);
      return kind === 'reimbursable' ? name + t('item_suffix_reimbursable') : kind === 'internal_service' ? name + t('item_suffix_internal') : name;
    }
    function list(x) { return Array.isArray(x) ? x : []; }
    function canAdmin(api) {
      try { return !!(api && typeof api.can === 'function' && (api.can('billAdmin') || api.can(['accounts_manager', 'admin']))); } catch (e) { return false; }
    }
    function canOrg(api, set) { try { return !!(api && typeof api.can === 'function' && api.can(set)); } catch (e) { return false; } }
    function mockBanner(conn) {
      if (!conn) return null;
      var c = conn.connection || conn;
      var box = el('div', { class: 'bill-banners' });
      if (!c.mode || c.mode === 'mock') {
        box.appendChild(el('div', { class: 'alert alert-warning bill-mock-banner', role: 'note' }, [U.icon('info'),
          el('div', null, [el('strong', { text: t('mock_banner_title') }), el('span', { class: 'bill-mock-sub', text: ' ' + t('mock_banner_text') })])]));
      }
      if (c.exists === false || !c.status || c.status !== 'connected') {
        box.appendChild(U.alertBox('info', t('not_connected_banner', { status: lab('daftra_conn_status', c.status || 'not_connected') }),
          [el('a', { class: 'btn btn-sm btn-secondary', href: '#daftra', text: t('open_settings') })]));
      } else if (c.sync_enabled === false) {
        box.appendChild(U.alertBox('info', t('sync_disabled_banner'), [el('a', { class: 'btn btn-sm btn-secondary', href: '#daftra', text: t('open_settings') })]));
      }
      return box.childNodes.length ? box : null;
    }
    // { field: value } → "field: value · …" (snapshots / overrides)
    function kv(o) {
      if (!o || typeof o !== 'object') return o == null ? U.NONE : String(o);
      return Object.keys(o).filter(function (k) { return o[k] != null && o[k] !== ''; }).map(function (k) { return lab('bill_field', k) + ': ' + val(o[k]); }).join(' · ') || U.NONE;
    }
    function val(v) {
      if (v == null || v === '') return U.NONE;
      if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
      return String(v);
    }
    function pre(obj) {
      var s; try { s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2); } catch (e) { s = String(obj); }
      return el('pre', { class: 'bill-pre', dir: 'ltr', text: s == null ? 'null' : s });
    }
    function done(api, sc, msg, reload) {
      return function (res) { if (res && sc.alive()) { if (msg) U.toast(api, msg, 'success'); reload(); } };
    }
    function idOf(d) { return d ? (d.id || (d.intent && d.intent.id) || (d.job && d.job.id) || (d.link && d.link.id) || null) : null; }

    /* --- jobs: table + attempts (calls in collapsible <pre>) ------------------ */
    function jobTarget(j) {
      if (j.intent_id) return intentLink(j.intent_id, j.operational_ref);
      if (j.client_link_id) return el('a', { class: 'ops-ref', href: '#daftra/clients', text: j.client_name || t('target_client') });
      if (j.item_link_id) return el('a', { class: 'ops-ref', href: '#daftra/items' }, j.item_key ? itemLabel(j.item_key) : t('target_item'));
      return el('span', { text: t('target_org') });
    }
    function attemptsNode(api, data) {
      var attempts = list(data && data.attempts);
      if (!attempts.length) return U.emptyState('inbox', null, t('attempts_none'), null, true);
      return el('div', { class: 'bill-attempts' }, attempts.map(function (a) {
        var calls = list(a.calls);
        return el('div', { class: 'bill-attempt' }, [
          el('div', { class: 'bill-attempt-head' }, [
            el('strong', { text: t('attempt_n', { n: a.attempt_no != null ? a.attempt_no : '?' }) }), ' ',
            a.outcome ? pill('bill_attempt_outcome', a.outcome, api) : U.pill('info', t('attempt_open')), ' ',
            el('span', { class: 'text-xs text-muted', text: [a.adapter_mode ? lab('daftra_mode', a.adapter_mode) : null, a.worker, when(a.started_at) + (a.finished_at ? ' → ' + when(a.finished_at) : '')].filter(Boolean).join(' · ') })
          ]),
          a.error ? el('p', { class: 'form-error bill-attempt-err' }, [t('attempt_error') + ': ', ref([a.error.kind, a.error.code].filter(Boolean).join(' / ')), a.error.message ? ' ' + a.error.message : '']) : null,
          calls.length ? el('div', { class: 'bill-calls' }, calls.map(function (c) {
            return el('details', { class: 'bill-call' + (c.error ? ' is-error' : '') }, [
              el('summary', null, [ref(c.op || '?'), el('span', { class: 'text-xs text-muted', text: ' · ' + (c.ms != null ? c.ms + ' ms' : '') + ' · ' + t('applied') + ': ' + lab('bill_applied', c.applied || 'no') + (c.error ? ' · ' + (c.error.kind || '') : '') })]),
              el('div', { class: 'bill-call-body' }, [
                el('p', { class: 'text-xs text-muted', text: t('call_request') }), pre(c.request == null ? null : c.request),
                el('p', { class: 'text-xs text-muted', text: t('call_response') }), pre(c.response == null ? null : c.response),
                c.error ? el('p', { class: 'text-xs text-muted', text: t('call_error') }) : null, c.error ? pre(c.error) : null
              ])
            ]);
          })) : el('p', { class: 'text-xs text-muted', text: t('calls_none') })
        ]);
      }));
    }
    // o = { showTarget, canRetry(job) → bool, onChanged() }
    function jobsTable(api, sc, jobs, o) {
      o = o || {};
      var host = el('div', { class: 'bill-job-detail', 'aria-live': 'polite' });
      var rows = jobs.map(function (j) {
        var acts = el('div', { class: 'ops-row-actions' });
        acts.appendChild(U.btn(t('job_attempts'), 'btn-subtle', function () {
          U.loadingInto(host);
          U.call(api, 'getBillingJob', j.id).then(function (r) {
            if (!sc.alive()) return;
            U.doneLoading(host);
            if (r.error) { host.appendChild(U.errorState(api, r.error)); return; }
            var d = F.dataOf(r);
            host.appendChild(U.card(t('job_attempts_of', { kind: lab('bill_job_kind', j.kind) }), attemptsNode(api, d), [U.btn([U.icon('x')], 'btn-subtle btn-icon', function () { U.clear(host); }, { 'aria-label': t('close'), title: t('close') })], { cls: 'bill-attempts-card' }));
          });
        }));
        if ((j.status === 'failed' || j.status === 'dead') && o.canRetry && o.canRetry(j)) acts.appendChild(U.btn(t('job_retry'), 'btn-secondary', function () {
          U.call(api, 'retryBillingJob', j.id).then(function (r) {
            if (!sc.alive()) return;
            if (r.error) { F.toastErr(api, r); return; }
            U.toast(api, t('job_requeued'), 'success');
            if (o.onChanged) o.onChanged();
          });
        }));
        var la = j.last_attempt || null;
        return el('tr', { 'data-id': j.id, class: 'bill-job-' + j.status }, [
          U.td([el('span', { class: 'cell-main', text: lab('bill_job_kind', j.kind) }), j.options && (j.options.overwrite || j.options.recreate || j.options.force_create) ? el('span', { class: 'cell-sub', text: Object.keys(j.options).filter(function (k) { return j.options[k] === true; }).map(function (k) { return lab('bill_job_option', k); }).join(' · ') }) : null]),
          o.showTarget ? U.td(jobTarget(j)) : null,
          U.td([pill('bill_job_status', j.status, api), j.status === 'queued' ? el('span', { class: 'cell-sub', text: t('queued_no_worker_short') }) : null]),
          U.td(el('bdi', { dir: 'ltr', class: 'num', text: (j.attempts || 0) + ' / ' + (j.max_attempts || 0) }), 'num'),
          U.td(la ? [la.outcome ? pill('bill_attempt_outcome', la.outcome, api) : U.pill('info', t('attempt_open')), el('span', { class: 'cell-sub', text: when(la.finished_at || la.started_at) })] : null),
          U.td(j.status === 'queued' || j.status === 'unknown' ? when(j.next_run_at) : when(j.finished_at || j.updated_at), 'is-nowrap'),
          U.td(j.last_error_code || j.last_error_message ? [ref(j.last_error_code || j.last_error_kind), el('span', { class: 'cell-sub', text: j.last_error_message || '' })] : null),
          U.td(acts, 'ops-col-actions')
        ]);
      });
      var heads = [t('col_job_kind')].concat(o.showTarget ? [t('col_target')] : []).concat([t('col_status'), { label: t('col_attempts'), num: true }, t('col_last_attempt'), t('col_when'), t('col_last_error'), { label: t('actions'), cls: 'ops-col-actions' }]);
      return el('div', { class: 'bill-jobs' }, [U.table(heads, rows, { caption: t('jobs') }), host]);
    }

    /* --- review item resolution (detail + queue) ------------------------------ */
    var REVIEW_DECISIONS = { late_charge: ['supplementary', 'dismiss'], issued_mismatch: ['accept', 'credit_note_in_daftra'], issued_cancelled: ['release_charges', 'dismiss'] };
    function reviewDialog(api, item) {
      var decisions = REVIEW_DECISIONS[item.kind] || ['dismiss'];
      var cur = item.currency || (item.charge && item.charge.currency) || (item.details && item.details.currency) || 'SAR';
      var needIntent = item.kind === 'late_charge';
      var load = needIntent && item.transaction_id ? U.call(api, 'listBillingIntents', { transaction_id: item.transaction_id, limit: 50 }) : Promise.resolve({ data: { items: [] }, error: null });
      return load.then(function (lr) {
        var sup = (lr.error ? [] : U.rowsOf(lr.data)).filter(function (x) { return x.purpose === 'supplementary' && (x.status === 'open' || x.status === 'draft') && (!x.currency || x.currency === cur); });
        var opts = sup.map(function (x) { return [x.id, (x.operational_ref || String(x.id).slice(0, 8)) + ' · ' + lab('bill_intent_status', x.status)]; }).concat([['__new', t('review_new_supplementary')]]);
        var fields = [{ name: 'decision', label: t('decision'), type: 'select', required: true, value: decisions[0], options: decisions.map(function (d) { return [d, lab('bill_review_decision', d)]; }) }];
        if (needIntent) fields.push({ name: 'intent_id', label: t('review_target_intent'), type: 'select', value: opts[0][0], options: opts, hint: t('review_target_hint') });
        fields.push({ name: 'note', label: t('note'), type: 'textarea', required: true, max: 2000, rows: 3, hint: t('note_required_hint') });
        var intro = el('div', { class: 'fin-dialog-intro' }, [
          el('p', { class: 'ops-modal-intro', text: lab('bill_review_kind', item.kind) + (chargeDesc(item) ? ' · ' + chargeDesc(item) : '') }),
          el('p', { class: 'form-hint', text: t('review_help_' + item.kind) })
        ]);
        // the supplementary intent created by a first submit is remembered: a retry (resolve failed) never creates a second one
        var createdId = null;
        var pr = U.formModal({
          title: t('review_resolve'), intro: intro, submitText: t('review_resolve'),
          fields: fields,
          validate: function (v) { return needIntent && v.decision === 'supplementary' && !v.intent_id ? { intent_id: t('required') } : null; },
          submit: function (v) {
            var note = U.nn(v.note);
            if (!(needIntent && v.decision === 'supplementary')) return U.call(api, 'resolveBillingReview', item.id, v.decision, note, null);
            var target = v.intent_id === '__new' ? createdId : v.intent_id;
            var scope = 'bill-sup-' + item.id;
            var first = target ? Promise.resolve({ data: { id: target }, error: null }) : (function () {
              var p = { transaction_id: item.transaction_id, purpose: 'supplementary', currency: cur, note: note, add_eligible: false };
              var key = U.idemKey(api, scope, p);
              return U.call(api, 'createBillingIntent', p, { idemKey: key }).then(function (r) {
                if (r.error) U.idemSettle(scope, r.error);           // the key is kept on an unknown result, dropped on a refusal
                else createdId = idOf(F.dataOf(r)) || null;
                return r;
              });
            })();
            return first.then(function (r) {
              if (r.error) return r;
              return U.call(api, 'resolveBillingReview', item.id, 'supplementary', note, idOf(F.dataOf(r)) || target).then(function (rr) {
                if (!rr.error) U.idemSettle(scope, null);             // the whole step succeeded: the create key is released
                return rr;
              });
            });
          }
        });
        var form = intro.closest('form');
        if (form && needIntent) {
          var dec = form.elements.decision, tgt = form.elements.intent_id;
          var sync = function () { if (tgt) tgt.closest('.form-group').hidden = dec.value !== 'supplementary'; };
          dec.addEventListener('change', sync); sync();
        }
        return pr;
      });
    }
    function reviewDetails(item) {
      var d = item.details || {};
      var diff = list(d.diff);
      var held = list(d.removed_on_remote);
      if (held.length) {
        return el('span', { class: 'cell-sub', text: (diff.length ? t('diff_n', { n: diff.length }) + ' · ' : '') +
          t('removed_on_remote', { refs: held.map(function (x) { return x && x.line_ref; }).filter(Boolean).join(', ') }) });
      }
      if (diff.length) return el('span', { class: 'cell-sub', text: t('diff_n', { n: diff.length }) });
      var bits = [];
      if (d.line_ref) bits.push(d.line_ref);
      if (d.daftra_number) bits.push(d.daftra_number);
      return bits.length ? el('bdi', { dir: 'ltr', class: 'cell-sub', text: bits.join(' · ') }) : null;
    }

    return {
      F: F, U: U, el: el, t: t, has: has, lab: lab, tone: tone, pill: pill, ref: ref, intentLink: intentLink, txLink: txLink, when: when,
      clientName: clientName, itemLabel: itemLabel, list: list, canAdmin: canAdmin, canOrg: canOrg, mockBanner: mockBanner, kv: kv, val: val, pre: pre,
      done: done, idOf: idOf, jobsTable: jobsTable, attemptsNode: attemptsNode, reviewDialog: reviewDialog, reviewDetails: reviewDetails,
      CAPABILITY_KEYS: CAPABILITY_KEYS, PUSH_CAPABILITIES: PUSH_CAPABILITIES, NEVER_USED: NEVER_USED, UUID_RE: UUID_RE
    };
  }
  Ops.billKit = function () {
    if (!Ops.billUi && Ops.finKit && Ops.finKit()) Ops.billUi = buildKit();
    return Ops.billUi || null;
  };
  function noKit(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
    var d = document.createElement('div');
    d.className = 'alert alert-danger';
    d.setAttribute('role', 'alert');
    d.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing';
    root.appendChild(d);
  }

  /* ==================================================================
     New billing intent «غرض فوترة جديد»: find tx → purpose → currency → add eligible
     ================================================================== */
  function newIntentDialog(B, api, presetTx) {
    var U = B.U, F = B.F, el = B.el, t = B.t;
    if (!F.branchesFor(api, 'finWrite').length) { U.toast(api, t('no_write_branch'), 'warning'); return Promise.resolve(null); }
    var picked = presetTx || null;
    var info = el('div', { class: 'bill-tx-info', 'aria-live': 'polite' });
    var finder = F.txFinder(api, function (tx) { picked = tx; showTx(); }, presetTx || null);
    var seq = 0;
    function showTx() {
      U.clear(info);
      if (!picked) return;
      if (!F.canAt(api, 'finWrite', picked.branch_id)) { info.appendChild(U.alertBox('warning', t('no_write_tx'))); return; }
      var my = ++seq;
      info.appendChild(U.skeleton());
      U.call(api, 'txBilling', picked.id).then(function (r) {
        if (my !== seq) return;
        U.clear(info);
        if (r.error) { info.appendChild(el('p', { class: 'form-hint', text: t('tx_billing_unavailable', { msg: U.errMsg(r.error, api) }) })); return; }
        var d = F.dataOf(r), elig = B.list(d.eligible_charges), live = B.list(d.intents).filter(function (x) { return x.status !== 'cancelled'; });
        var byCur = {};
        elig.forEach(function (c) { var k = c.currency || 'SAR'; byCur[k] = byCur[k] || { n: 0, sum: 0 }; byCur[k].n++; byCur[k].sum += F.nz(c.total_amount); });
        var curs = Object.keys(byCur);
        info.appendChild(el('p', { class: 'form-hint', text: curs.length ? t('tx_eligible_summary', { list: curs.map(function (k) { return k + ': ' + byCur[k].n + ' (' + F.moneyTxt(F.r2(byCur[k].sum), k, api) + ')'; }).join(' · ') }) : t('tx_no_eligible') }));
        if (live.length) info.appendChild(el('p', { class: 'form-hint', text: t('tx_existing_intents', { list: live.map(function (x) { return (x.operational_ref || '') + ' (' + B.lab('bill_intent_status', x.status) + ')'; }).join(' · ') }) }));
        var form = info.closest('form');
        if (form && curs.length && form.elements.currency && curs.indexOf(form.elements.currency.value) === -1) form.elements.currency.value = curs[0];
        if (form && live.some(function (x) { return x.purpose === 'final' && x.status === 'issued'; }) && form.elements.purpose) form.elements.purpose.value = 'supplementary';
      });
    }
    var intro = el('div', { class: 'fin-dialog-intro' }, [
      el('p', { class: 'form-hint', text: t('new_intent_intro') }),
      F.field(t('tx_find'), finder.node, { hint: t('tx_find_hint'), full: true }),
      info
    ]);
    var pr = U.formModal({
      title: t('new_intent'), intro: intro, submitText: t('new_intent_create'),
      fields: [
        { name: 'purpose', label: t('f_purpose'), type: 'select', required: true, value: 'final', options: ['final', 'interim', 'supplementary'].map(function (p) { return [p, B.lab('bill_purpose', p)]; }), hint: t('purpose_hint') },
        { name: 'currency', label: t('f_currency'), type: 'select', required: true, value: 'SAR', options: F.currencyOptions(), hint: t('currency_hint') },
        { name: 'add_eligible', label: t('f_add_eligible'), type: 'checkbox', value: true },
        { name: 'note', label: t('note'), type: 'textarea', max: 2000, rows: 2 }
      ],
      validate: function () {
        if (!picked) return { _tx: t('pick_tx') };
        if (!F.canAt(api, 'finWrite', picked.branch_id)) return { _tx: t('no_write_tx') };
        return null;
      },
      submit: function (v) {
        var p = { transaction_id: picked.id, purpose: v.purpose, currency: v.currency, note: U.nn(v.note), add_eligible: !!v.add_eligible };
        var scope = 'bill-intent-new', key = U.idemKey(api, scope, p);
        return U.call(api, 'createBillingIntent', p, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
      }
    });
    if (presetTx) showTx();
    return pr.then(function (res) {
      var id = res && B.idOf(res);
      if (id) { U.toast(api, t('intent_created'), 'success'); U.go(api, '#billing/' + id); }
      return res;
    });
  }

  /* ==================================================================
     #billing — intents list
     ================================================================== */
  var LF = { q: '', status: '', sync_state: '', payment_status: '', branch_id: '', offset: 0 };
  function renderList(root, api) {
    var B = Ops.billKit(), U = B.U, F = B.F, el = B.el, t = B.t, sc = U.scope(root);
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'bill-view', 'bill-list');
    var actions = [];
    if (F.branchesFor(api, 'finWrite').length) actions.push(U.btn([U.icon('plus'), el('span', { text: t('new_intent') })], 'btn-primary', function () { newIntentDialog(B, api); }));
    actions.push(el('a', { class: 'btn btn-sm btn-secondary', href: '#billing/queue', text: t('nav_queue') }));
    actions.push(el('a', { class: 'btn btn-sm btn-secondary', href: '#daftra', text: t('nav_daftra') }));
    root.appendChild(U.head(t('billing_title'), t('billing_sub'), actions));
    var banner = el('div'), tiles = el('div', { class: 'adm-tiles ops-kpis fin-kpis bill-kpis', 'aria-live': 'polite' }), bar = el('div'), body = el('div');
    [banner, tiles, bar, body].forEach(function (n) { root.appendChild(n); });

    function filters() {
      var f = { limit: PAGE, offset: LF.offset };
      ['q', 'status', 'sync_state', 'payment_status', 'branch_id'].forEach(function (k) { if (LF[k]) f[k] = LF[k]; });
      return f;
    }
    function load() {
      U.loadingInto(body);
      drawBar();
      return Promise.all([U.call(api, 'listBillingIntents', filters()), U.call(api, 'getDaftraConnection')]).then(function (res) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        U.clear(banner);
        if (!res[1].error) { var bn = B.mockBanner(F.dataOf(res[1])); if (bn) banner.appendChild(bn); }
        var r = res[0];
        if (r.error) { U.clear(tiles); body.appendChild(U.errorState(api, r.error, load)); return; }
        var d = F.dataOf(r), rows = U.rowsOf(r.data);
        drawTiles(d.counts || {});
        draw(rows, d.total != null ? +d.total : rows.length);
      });
    }
    function drawTiles(c) {
      U.clear(tiles);
      var st = c.by_status || {}, sy = c.by_sync_state || {}, pay = c.by_payment_status || {};
      [['tile_open', st.open, 'neutral', ['status', 'open']], ['tile_pending', sy.pending, 'warning', ['sync_state', 'pending']],
        ['tile_conflict', sy.conflict, 'danger', ['sync_state', 'conflict']], ['tile_unknown', sy.unknown, 'warning', ['sync_state', 'unknown']],
        ['tile_issued', st.issued, 'neutral', ['status', 'issued']], ['tile_paid', pay.paid, 'neutral', ['payment_status', 'paid']]].forEach(function (k) {
        var active = LF[k[3][0]] === k[3][1];
        var tile = U.kpi(t(k[0]), +(k[1] || 0), k[2], { active: active, onClick: function () {
          ['status', 'sync_state', 'payment_status'].forEach(function (f) { LF[f] = ''; });
          if (!active) LF[k[3][0]] = k[3][1];
          LF.offset = 0; load();
        } });
        tile.classList.add('bill-' + k[0]);
        tiles.appendChild(tile);
      });
    }
    function drawBar(total) {
      U.clear(bar);
      var all = function (lbl) { return lbl + ': ' + t('all'); };
      var fl = [
        U.select('status', t('f_status'), [['', all(t('f_status'))]].concat(['open', 'draft', 'issued', 'cancelled'].map(function (s) { return [s, B.lab('bill_intent_status', s)]; })), LF.status, function (v) { LF.status = v; LF.offset = 0; load(); }),
        U.select('sync_state', t('f_sync_state'), [['', all(t('f_sync_state'))]].concat(['idle', 'pending', 'in_flight', 'synced', 'unknown', 'conflict', 'error'].map(function (s) { return [s, B.lab('bill_sync_state', s)]; })), LF.sync_state, function (v) { LF.sync_state = v; LF.offset = 0; load(); }),
        U.select('payment_status', t('f_payment'), [['', all(t('f_payment'))]].concat(['unknown', 'unpaid', 'partial', 'paid'].map(function (s) { return [s, B.lab('daftra_payment_status', s)]; })), LF.payment_status, function (v) { LF.payment_status = v; LF.offset = 0; load(); })
      ];
      var bo = F.branchOptions(api, 'finRead', true);
      if (bo.length > 2) fl.push(U.select('branch_id', t('f_branch'), bo, LF.branch_id, function (v) { LF.branch_id = v; LF.offset = 0; load(); }));
      var search = U.searchBox(LF.q, t('search_intents'), function (v) { LF.q = v.trim(); LF.offset = 0; load(); });
      bar.appendChild(U.toolbar(search, fl, [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })], total != null ? t('count_n', { n: total }) : null));
    }
    function draw(rows, total) {
      drawBar(total);
      U.clear(body);
      if (!rows.length) {
        var filtered = LF.q || LF.status || LF.sync_state || LF.payment_status || LF.branch_id;
        body.appendChild(U.card(null, U.emptyState('inbox', t(filtered ? 'intents_empty_filtered' : 'intents_empty_title'), t('intents_empty_text'))));
        return;
      }
      body.appendChild(U.card(null, U.table([t('col_op_ref'), t('col_tx'), t('col_client'), t('f_purpose'), t('col_status'), { label: t('col_marsa_total'), num: true }, t('col_daftra'), t('col_payment'), t('col_sync'), t('col_last_sync')],
        rows.map(function (x) {
          var cur = x.currency || 'SAR';
          return el('tr', { 'data-id': x.id, class: 'bill-row-' + (x.sync_state || 'idle') + (x.status === 'cancelled' ? ' is-muted' : '') }, [
            U.td([B.intentLink(x.id, x.operational_ref), el('span', { class: 'cell-sub', text: cur })]),
            U.td(B.txLink(x.transaction_id, x.transaction_ref || U.txRef(x))),
            U.td([el('span', { class: 'cell-main', text: B.clientName(x) }), x.branch_id ? el('span', { class: 'cell-sub', text: F.branchName(api, x.branch_id) }) : null]),
            U.td(B.lab('bill_purpose', x.purpose)),
            U.td(B.pill('bill_intent_status', x.status, api)),
            U.td([F.money(x.lines_total, cur, api), x.line_count != null ? el('span', { class: 'cell-sub', text: t('lines_n', { n: x.line_count }) }) : null], 'num'),
            U.td([x.daftra_number ? B.ref(x.daftra_number) : el('span', { class: 'ops-muted', text: x.external_invoice_id ? t('draft_no_number') : U.NONE }), x.daftra_status ? el('span', { class: 'cell-sub', text: x.daftra_status }) : null]),
            U.td([B.pill('daftra_payment_status', x.payment_status || 'unknown', api), x.paid_amount != null && +x.paid_amount > 0 ? el('span', { class: 'cell-sub', text: F.moneyTxt(x.paid_amount, cur, api) }) : null]),
            U.td([B.pill('bill_sync_state', x.sync_state || 'idle', api), x.last_error_code ? el('span', { class: 'cell-sub', text: x.last_error_code }) : null]),
            U.td(B.when(x.last_synced_at), 'is-nowrap')
          ]);
        }), { caption: t('billing_title') }), null, { flush: true }));
      var pg = F.pager(total, PAGE, LF.offset, function (o) { LF.offset = o; load(); });
      if (pg) body.appendChild(pg);
    }
    return load();
  }

  /* ==================================================================
     #billing/<intentId> — invoice intent «تفاصيل الفاتورة التشغيلية»
     ================================================================== */
  var CONFLICT_DECISIONS = { remote_edited: ['keep_remote', 'overwrite_remote'], remote_missing: ['recreate', 'release'], external_in_use: ['release'] };
  function renderDetail(root, api, id) {
    var B = Ops.billKit(), U = B.U, F = B.F, el = B.el, t = B.t, sc = U.scope(root);
    var D = null;
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'bill-view', 'bill-detail');
    function load() {
      U.clear(root);
      root.appendChild(U.head(t('intent_title'), null, [el('a', { class: 'btn btn-sm btn-secondary', href: '#billing', text: t('back_list') })]));
      var body = el('div');
      root.appendChild(body);
      U.loadingInto(body);
      return Promise.all([U.call(api, 'getBillingIntent', id), U.call(api, 'getDaftraConnection')]).then(function (res) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (res[0].error) { body.appendChild(U.errorState(api, res[0].error, load)); return; }
        D = F.dataOf(res[0]);
        if (!D.intent) { body.appendChild(U.emptyState('alert', null, t('intent_missing'))); return; }
        draw(body, res[1].error ? null : F.dataOf(res[1]));
      });
    }
    function reload() { load(); }
    function flag(name, fallback) { return D.can && typeof D.can[name] === 'boolean' ? D.can[name] && fallback : fallback; }
    function draw(body, conn) {
      var inv = D.intent, tx = D.transaction || {}, cur = inv.currency || 'SAR';
      var branch = tx.branch_id || inv.branch_id;
      var writer = F.canAt(api, 'finWrite', branch), approver = F.canAt(api, 'finApprove', branch);
      var live = B.list(D.lines).filter(function (l) { return l.state !== 'removed'; });
      var editable = inv.status === 'open' || inv.status === 'draft';
      var bn = B.mockBanner(conn);
      if (bn) body.appendChild(bn);
      body.appendChild(headerCard(inv, tx, cur));
      body.appendChild(figuresCard(inv, cur));
      body.appendChild(checksCard(inv));
      body.appendChild(actionsCard(inv, writer, approver, live, editable));
      if (inv.sync_state === 'conflict' && inv.conflict) body.appendChild(conflictCard(inv, approver));
      body.appendChild(linesCard(inv, cur, writer && editable && flag('edit', true)));
      if (editable) body.appendChild(eligibleCard(inv, cur, writer && flag('edit', true)));
      body.appendChild(reviewCard(approver));
      body.appendChild(jobsCard(writer));
    }
    function headerCard(inv, tx, cur) {
      var cl = D.client || {}, link = cl.link || null;
      var rows = [
        [t('col_op_ref'), B.ref(inv.operational_ref, 'bill-ref-lg')],
        [t('col_tx'), el('span', null, [B.txLink(tx.id || inv.transaction_id, tx.ref), tx.operational_status ? el('span', { class: 'cell-sub', text: ' ' + B.lab('operational_status', tx.operational_status, api) }) : null])],
        [t('col_client'), el('span', null, [el('span', { text: (U.lang() === 'en' && cl.name_en) || cl.name_ar || B.clientName(inv) }), ' ', link ? B.pill('daftra_link_status', link.status, api) : U.pill('neutral', t('client_not_linked'))])],
        [t('f_purpose'), B.lab('bill_purpose', inv.purpose) + (inv.purpose_key ? ' (' + inv.purpose_key + ')' : '')],
        [t('f_currency'), B.ref(cur)],
        [t('col_status'), B.pill('bill_intent_status', inv.status, api)],
        [t('col_sync'), B.pill('bill_sync_state', inv.sync_state || 'idle', api)],
        [t('daftra_number'), inv.daftra_number ? B.ref(inv.daftra_number) : el('span', { class: 'ops-muted', text: inv.external_invoice_id ? t('draft_no_number') : t('not_pushed') })],
        [t('daftra_status'), inv.daftra_status ? el('span', { text: inv.daftra_status }) : null],
        [t('external_invoice_id'), inv.external_invoice_id ? B.ref(inv.external_invoice_id) : null],
        [t('col_payment'), el('span', null, [B.pill('daftra_payment_status', inv.payment_status || 'unknown', api), inv.last_payment_at ? el('span', { class: 'cell-sub', text: ' ' + t('last_payment', { when: B.when(inv.last_payment_at) }) }) : null])],
        [t('financial_status'), tx.financial_status ? B.pill('financial_status', tx.financial_status, api) : null],
        [t('col_last_sync'), B.when(inv.last_synced_at)],
        [t('last_pulled'), inv.last_pulled_at ? B.when(inv.last_pulled_at) : null],
        [t('issued_at'), inv.issued_at ? B.when(inv.issued_at) : null],
        [t('col_last_error'), inv.last_error_code || inv.last_error_message ? el('span', { class: 'fin-text-danger' }, [B.ref(inv.last_error_code), ' ' + (inv.last_error_message || '')]) : null],
        [t('cancel_reason'), inv.status === 'cancelled' && inv.cancel_reason ? inv.cancel_reason : null],
        [t('note'), inv.note || null]
      ];
      return U.card(t('intent_header'), F.dl(rows), null, { cls: 'bill-header-card', sub: inv.status === 'issued' ? t('issued_frozen') : null });
    }
    // Marsa's line totals next to Daftra's official figures; a difference is highlighted, never fixed
    function figuresCard(inv, cur) {
      var hasRemote = inv.remote_total != null;
      var paid = inv.paid_amount != null ? +inv.paid_amount : null;
      var fig = function (label, marsa, remote) {
        var off = hasRemote && remote != null && Math.abs(F.nz(marsa) - F.nz(remote)) > 0.004;
        return el('tr', { class: off ? 'bill-fig-off' : null }, [U.td(label), U.td(F.money(marsa, cur, api), 'num'), U.td(hasRemote ? F.money(remote, cur, api) : el('span', { class: 'ops-muted', text: U.NONE }), 'num'),
          U.td(off ? U.pill('warning', t('fig_differs')) : hasRemote ? U.pill('success', t('fig_same')) : null)]);
      };
      var kids = [U.table([t('col_figure'), { label: t('col_marsa'), num: true }, { label: t('col_daftra_official'), num: true }, ''], [
        fig(t('fig_net'), inv.lines_net, inv.remote_net), fig(t('fig_vat'), inv.lines_vat, inv.remote_vat), fig(t('fig_total'), inv.lines_total, inv.remote_total)
      ], { caption: t('figures') })];
      if (hasRemote || paid != null) {
        var rem = hasRemote && paid != null ? F.r2(F.nz(inv.remote_total) - paid) : null;
        kids.push(F.dl([[t('paid_daftra'), paid != null ? F.money(paid, cur, api) : null], [t('remaining_daftra'), rem != null ? F.money(rem, cur, api) : null]]));
      }
      kids.push(el('p', { class: 'form-hint bill-truth', text: t('daftra_truth') }));
      return U.card(t('figures'), kids, null, { cls: 'bill-figures' });
    }
    function checksCard(inv) {
      var c = D.checks || {}, items = [];
      var add = function (toneName, text, extra) { items.push(el('li', { class: 'bill-check bill-check-' + toneName }, [U.pill(toneName, t('check_' + toneName)), el('span', { class: 'bill-check-text', text: ' ' + text }), extra || null])); };
      var linkSt = typeof c.client_link === 'string' ? c.client_link : c.client_link && c.client_link.status;
      if (!linkSt) linkSt = D.client && D.client.link ? D.client.link.status : null;
      if (linkSt === 'linked') add('success', t('chk_client_linked'));
      else if (linkSt === 'drift') add('warning', t('chk_client_drift'), el('a', { class: 'ops-ref', href: '#daftra/clients', text: ' ' + t('open_clients') }));
      else if (linkSt === 'needs_review') add('danger', t('chk_client_review'), el('a', { class: 'ops-ref', href: '#daftra/clients', text: ' ' + t('open_clients') }));
      else if (linkSt === 'error') add('danger', t('chk_client_error'));
      else add('info', t('chk_client_pending'));
      var unm = B.list(c.items_unmapped);
      if (unm.length) {
        var rev = unm.filter(function (x) { return x && typeof x === 'object' && x.status === 'needs_review'; });
        add(rev.length ? 'danger' : 'info', t(rev.length ? 'chk_items_review' : 'chk_items_unmapped', { list: unm.map(function (x) { return B.itemLabel(typeof x === 'string' ? x : x.item_key); }).join('، ') }),
          el('a', { class: 'ops-ref', href: '#daftra/items', text: ' ' + t('open_items') }));
      } else add('success', t('chk_items_ok'));
      var tax = B.list(c.tax_rate_unmapped);
      if (tax.length) add('danger', t('chk_tax_unmapped', { list: tax.map(function (x) { return typeof x === 'string' ? x : (x.line_ref || x.vat_rate); }).join(', ') }));
      else add('success', t('chk_tax_ok'));
      var rt = B.list(c.reimbursable_taxed);
      if (rt.length) add('warning', t('chk_reimbursable_taxed', { list: rt.map(function (x) { return typeof x === 'string' ? x : (x.line_ref || x.description || ''); }).join(', ') }));
      var oc = B.list(c.other_currency);
      if (oc.length) {
        var curs = {}; oc.forEach(function (x) { var k = (x && x.currency) || '?'; curs[k] = (curs[k] || 0) + 1; });
        add('info', t('chk_other_currency', { list: Object.keys(curs).map(function (k) { return k + ' × ' + curs[k]; }).join(' · ') }));
      }
      var cm = B.list(c.capabilities_missing);
      if (cm.length) add('danger', t('chk_capabilities', { list: cm.map(function (k) { return B.lab('daftra_capability', k); }).join('، ') }), el('a', { class: 'ops-ref', href: '#daftra', text: ' ' + t('open_settings') }));
      return U.card(t('checks'), el('ul', { class: 'bill-checks' }, items), null, { cls: 'bill-checks-card', sub: t('checks_sub') });
    }
    // why «إرسال إلى دفترة» is not available (null = available)
    function pushBlock(inv, writer, live) {
      var c = D.checks || {};
      if (!writer) return t('why_no_role');
      if (inv.status === 'issued') return t('why_issued');
      if (inv.status === 'cancelled') return t('why_cancelled');
      if (inv.sync_state === 'conflict') return t('why_conflict');
      if (inv.sync_state === 'in_flight') return t('why_in_flight');
      if (!live.length) return t('why_no_lines');
      if (B.list(c.capabilities_missing).length) return t('why_capabilities');
      if (B.list(c.tax_rate_unmapped).length) return t('why_tax');
      var linkSt = typeof c.client_link === 'string' ? c.client_link : c.client_link && c.client_link.status;
      if (linkSt === 'needs_review') return t('why_client_review');
      if (B.list(c.items_unmapped).some(function (x) { return x && typeof x === 'object' && x.status === 'needs_review'; })) return t('why_item_review');
      if (D.can && D.can.push === false) return t('why_server');
      return null;
    }
    function actionsCard(inv, writer, approver, live, editable) {
      var jobs = B.list(D.jobs);
      var queuedPush = jobs.filter(function (j) { return j.kind === 'invoice_push' && j.status === 'queued'; })[0];
      var queuedPull = jobs.filter(function (j) { return j.kind === 'invoice_pull' && j.status === 'queued'; })[0];
      var why = pushBlock(inv, writer, live);
      var kids = [], btns = [];
      var pushB = U.btn([U.icon('refresh'), el('span', { text: t('push') })], 'btn-primary bill-push', function (b) {
        b.disabled = true;
        var scope = 'bill-push-' + inv.id, key = U.idemKey(api, scope, { id: inv.id, sync: inv.sync_state, n: live.length });
        U.call(api, 'requestBillingPush', inv.id, { idemKey: key }).then(function (r) {
          U.idemSettle(scope, r.error);
          if (!sc.alive()) return;
          b.disabled = false;
          if (r.error) { F.toastErr(api, r); return; }
          var d = F.dataOf(r);
          U.toast(api, d.deduplicated ? t('push_dedup') : t('push_queued'), d.deduplicated ? 'info' : 'success');
          reload();
        });
      }, { disabled: !!why || !!queuedPush, title: why || (queuedPush ? t('queued_no_worker') : null) });
      btns.push(pushB);
      if (writer && inv.external_invoice_id && inv.status !== 'cancelled' && (!D.can || D.can.pull !== false)) btns.push(U.btn(t('pull'), 'btn-secondary bill-pull', function (b) {
        b.disabled = true;
        U.call(api, 'requestBillingPull', inv.id).then(function (r) {
          if (!sc.alive()) return;
          b.disabled = false;
          if (r.error) { F.toastErr(api, r); return; }
          U.toast(api, F.dataOf(r).deduplicated ? t('push_dedup') : t('pull_queued'), 'success');
          reload();
        });
      }, { disabled: !!queuedPull, title: queuedPull ? t('queued_no_worker') : null }));
      var cancelOk = approver && inv.status === 'open' && !inv.external_invoice_id && inv.sync_state !== 'in_flight' && inv.sync_state !== 'unknown' && (!D.can || D.can.cancel !== false);
      if (cancelOk) btns.push(U.btn(t('cancel_intent'), 'btn-subtle bill-cancel', function () {
        F.noteDialog(api, { title: t('cancel_intent'), noteLabel: t('reason'), danger: true, warn: t('cancel_warn'), submitText: t('cancel_intent'),
          submit: function (note) { return U.call(api, 'cancelBillingIntent', inv.id, note); } }).then(B.done(api, sc, t('intent_cancelled'), reload));
      }));
      kids.push(el('div', { class: 'bill-actions-row' }, btns));
      if (why && editable) kids.push(el('p', { class: 'form-hint bill-why', text: t('push_unavailable', { why: why }) }));
      if (queuedPush || queuedPull) kids.push(U.alertBox('info', t('queued_no_worker')));
      kids.push(el('p', { class: 'form-hint', text: t('push_rule') }));
      return U.card(t('actions_title'), kids, null, { cls: 'bill-actions' });
    }
    function conflictCard(inv, approver) {
      var c = inv.conflict || {}, reason = c.reason || 'remote_edited', diff = B.list(c.diff);
      var kids = [U.alertBox('danger', t('conflict_help_' + reason))];
      if (diff.length) kids.push(U.table([t('col_line_ref'), t('col_field'), t('col_pushed'), t('col_remote')], diff.map(function (x) {
        return el('tr', { class: 'bill-diff-row' }, [U.td(x.line_ref ? B.ref(x.line_ref) : el('span', { class: 'ops-muted', text: t('foreign_line') })), U.td(B.lab('bill_field', x.field)),
          U.td(el('bdi', { class: 'bill-diff-pushed', text: B.val(x.pushed) })), U.td(el('bdi', { class: 'bill-diff-remote', text: B.val(x.remote) }))]);
      }), { caption: t('conflict_diff') }));
      if (c.detected_at) kids.push(el('p', { class: 'text-xs text-muted', text: t('detected_at', { when: B.when(c.detected_at) }) }));
      var acts = [];
      if (approver && (!D.can || D.can.resolve !== false)) (CONFLICT_DECISIONS[reason] || []).forEach(function (dcs) {
        acts.push(U.btn(B.lab('bill_conflict_decision', dcs), dcs === 'release' ? 'btn-subtle' : dcs === 'keep_remote' ? 'btn-primary' : 'btn-secondary', function () {
          F.noteDialog(api, { title: B.lab('bill_conflict_decision', dcs), intro: t('decision_help_' + dcs), danger: dcs === 'release' || dcs === 'overwrite_remote', submitText: B.lab('bill_conflict_decision', dcs),
            submit: function (note) { return U.call(api, 'resolveBillingConflict', inv.id, dcs, note); } }).then(B.done(api, sc, t('conflict_resolved'), reload));
        }));
      });
      else kids.push(el('p', { class: 'form-hint', text: t('conflict_needs_approver') }));
      if (acts.length) kids.push(el('div', { class: 'bill-actions-row bill-conflict-actions' }, acts));
      return U.card(t('conflict_title') + ' · ' + B.lab('bill_conflict_reason', reason), kids, null, { cls: 'bill-conflict' });
    }
    function linesCard(inv, cur, canEdit) {
      var lines = B.list(D.lines);
      if (!lines.length) return U.card(t('lines'), U.emptyState('inbox', null, t('lines_empty'), null, true));
      var rows = lines.map(function (l) {
        var acts = el('div', { class: 'ops-row-actions' });
        if (canEdit && (l.state === 'pending_add' || l.state === 'synced')) acts.appendChild(U.btn(t('line_remove'), 'btn-subtle', function () {
          F.noteDialog(api, { title: t('line_remove'), noteLabel: t('reason'), danger: true, warn: l.pushed ? t('line_remove_pushed') : t('line_remove_local'), submitText: t('line_remove'),
            submit: function (note) { return U.call(api, 'removeBillingLine', l.id, note); } }).then(B.done(api, sc, t('line_removed'), reload));
        }));
        var ov = l.remote_override && typeof l.remote_override === 'object' && Object.keys(l.remote_override).length ? l.remote_override : null;
        return el('tr', { 'data-id': l.id, class: 'bill-line bill-line-' + l.state + (l.state === 'removed' ? ' is-muted' : '') }, [
          U.td(B.ref(l.line_ref)),
          U.td([el('span', { class: 'cell-main', text: l.description || U.NONE }), el('span', { class: 'cell-sub', text: (l.kind ? B.lab('fin_charge_kind', l.kind, api) + ' · ' : '') + B.itemLabel(l.item_key || ((l.kind || 'service') + ':' + (l.service_code || 'none'))) }),
            ov ? el('span', { class: 'cell-sub bill-override', text: t('remote_override', { v: B.kv(ov) }) }) : null]),
          U.td(el('bdi', { dir: 'ltr', class: 'num', text: l.quantity != null ? String(+l.quantity) : U.NONE }), 'num'),
          U.td(F.money(l.unit_price, l.currency || cur, api), 'num'),
          U.td([F.money(l.vat_amount, l.currency || cur, api), el('span', { class: 'cell-sub', text: (l.vat_rate != null ? +l.vat_rate : '?') + '%' })], 'num'),
          U.td(F.money(l.total_amount, l.currency || cur, api), 'num'),
          U.td([B.pill('bill_line_state', l.state, api), l.removed_reason ? el('span', { class: 'cell-sub', text: B.lab('bill_removed_reason', l.removed_reason) }) : null,
            l.pushed && l.state !== 'removed' ? el('span', { class: 'cell-sub', text: t('on_remote') }) : null]),
          U.td(acts, 'ops-col-actions')
        ]);
      });
      return U.card(t('lines') + ' (' + lines.filter(function (l) { return l.state !== 'removed'; }).length + ')', U.table([t('col_line_ref'), t('col_description'), { label: t('col_qty'), num: true }, { label: t('col_price'), num: true }, { label: t('col_vat'), num: true }, { label: t('col_total'), num: true }, t('col_state'), { label: t('actions'), cls: 'ops-col-actions' }], rows, { caption: t('lines') }), null, { flush: true, sub: t('lines_sub') });
    }
    function eligibleCard(inv, cur, canEdit) {
      var list = B.list(D.eligible_charges);
      if (!list.length) return U.card(t('eligible'), U.emptyState('check', null, t('eligible_empty'), null, true), null, { cls: 'bill-eligible' });
      var picked = {};
      var addSel = U.btn(t('add_selected'), 'btn-secondary', function () {
        var ids = Object.keys(picked).filter(function (k) { return picked[k]; });
        if (!ids.length) { U.toast(api, t('pick_some'), 'warning'); return; }
        addLines(ids);
      });
      var addAll = U.btn([U.icon('plus'), el('span', { text: t('add_all') })], 'btn-primary', function () { addLines(null); });
      function addLines(ids) {
        var scope = 'bill-add-' + inv.id, key = U.idemKey(api, scope, ids || 'all');
        U.call(api, 'addBillingLines', inv.id, ids, { idemKey: key }).then(function (r) {
          U.idemSettle(scope, r.error);
          if (!sc.alive()) return;
          if (r.error) { F.toastErr(api, r); return; }
          U.toast(api, t('lines_added', { n: B.list(F.dataOf(r).added).length || (ids ? ids.length : list.length) }), 'success');
          reload();
        });
      }
      var rows = list.map(function (c) {
        var cb = canEdit ? el('input', { type: 'checkbox', 'aria-label': t('select_row') }) : null;
        if (cb) cb.addEventListener('change', function () { picked[c.id] = cb.checked; });
        return el('tr', { 'data-id': c.id }, [
          canEdit ? U.td(el('label', { class: 'check' }, cb)) : null,
          U.td([el('span', { class: 'cell-main', text: c.description || U.NONE }), el('span', { class: 'cell-sub', text: B.lab('fin_charge_kind', c.kind, api) + (c.service_code ? ' · ' + B.lab('fin_service', c.service_code, api) : '') })]),
          U.td(F.money(c.net_amount, c.currency || cur, api), 'num'),
          U.td(el('bdi', { dir: 'ltr', class: 'num', text: (c.vat_rate != null ? +c.vat_rate : '?') + '%' }), 'num'),
          U.td(F.money(c.total_amount, c.currency || cur, api), 'num'),
          U.td(c.kind === 'reimbursable' && +c.vat_rate > 0 ? U.pill('warning', t('reimbursable_taxed')) : null)
        ]);
      });
      var heads = (canEdit ? [''] : []).concat([t('col_description'), { label: t('col_net'), num: true }, { label: t('col_vat_rate'), num: true }, { label: t('col_total'), num: true }, '']);
      return U.card(t('eligible') + ' (' + list.length + ')', U.table(heads, rows, { caption: t('eligible') }), canEdit ? [addSel, addAll] : null, { flush: true, sub: t('eligible_sub'), cls: 'bill-eligible' });
    }
    function reviewCard(approver) {
      var items = B.list(D.review_items);
      if (!items.length) return U.card(t('review_items'), U.emptyState('check', null, t('review_empty'), null, true), null, { cls: 'bill-review' });
      return U.card(t('review_items') + ' (' + items.length + ')', U.table([t('col_kind'), t('col_details'), t('col_status'), t('col_when'), { label: t('actions'), cls: 'ops-col-actions' }], items.map(function (it) {
        return el('tr', { 'data-id': it.id, class: it.status !== 'open' ? 'is-muted' : null }, [
          U.td(B.pill('bill_review_kind', it.kind, api)),
          U.td([el('span', { class: 'cell-main', text: chargeDesc(it) || (it.charge_id ? t('charge') : U.NONE) }), B.reviewDetails(it), it.resolution ? el('span', { class: 'cell-sub', text: B.lab('bill_review_decision', it.resolution) + (it.resolution_note ? ' — ' + it.resolution_note : '') }) : null]),
          U.td(B.pill('bill_review_status', it.status, api)),
          U.td(B.when(it.created_at), 'is-nowrap'),
          U.td(approver && it.status === 'open' ? U.btn(t('review_resolve'), 'btn-secondary', function () { B.reviewDialog(api, it).then(B.done(api, sc, t('review_resolved'), reload)); }) : null, 'ops-col-actions')
        ]);
      }), { caption: t('review_items') }), null, { flush: true, cls: 'bill-review' });
    }
    function jobsCard(writer) {
      var jobs = B.list(D.jobs);
      if (!jobs.length) return U.card(t('jobs'), U.emptyState('inbox', null, t('jobs_empty'), null, true), null, { cls: 'bill-jobs-card' });
      return U.card(t('jobs') + ' (' + jobs.length + ')', B.jobsTable(api, sc, jobs, { canRetry: function () { return writer; }, onChanged: reload }), null, { flush: true, sub: t('jobs_sub'), cls: 'bill-jobs-card' });
    }
    return load();
  }

  /* ==================================================================
     #billing/queue — «طابور المزامنة والمراجعة»
     ================================================================== */
  var QF = { status: '', kind: '', branch_id: '', offset: 0 };
  function renderQueue(root, api) {
    var B = Ops.billKit(), U = B.U, F = B.F, el = B.el, t = B.t, sc = U.scope(root);
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'bill-view', 'bill-queue');
    root.appendChild(U.head(t('queue_title'), t('queue_sub'), [el('a', { class: 'btn btn-sm btn-secondary', href: '#billing', text: t('back_list') })]));
    var tiles = el('div', { class: 'adm-tiles ops-kpis fin-kpis bill-kpis', 'aria-live': 'polite' }), bar = el('div'), jobsBox = el('div'), reviewBox = el('div');
    [tiles, bar, jobsBox, reviewBox].forEach(function (n) { root.appendChild(n); });
    function jf() {
      var f = { limit: PAGE, offset: QF.offset };
      if (QF.status) f.status = QF.status;
      if (QF.kind) f.kind = QF.kind;
      return f;
    }
    function rf() { var f = {}; if (QF.branch_id) f.branch_id = QF.branch_id; return f; }
    function load() {
      U.loadingInto(jobsBox); U.loadingInto(reviewBox);
      drawBar();
      return Promise.all([U.call(api, 'listBillingJobs', jf()), U.call(api, 'billingReviewQueue', rf())]).then(function (res) {
        if (!sc.alive()) return;
        U.doneLoading(jobsBox); U.doneLoading(reviewBox);
        var jr = res[0], rr = res[1];
        drawTiles(jr.error ? null : F.dataOf(jr).counts, rr.error ? null : F.dataOf(rr));
        if (jr.error) jobsBox.appendChild(U.errorState(api, jr.error, load));
        else drawJobs(U.rowsOf(jr.data), F.dataOf(jr));
        if (rr.error) reviewBox.appendChild(U.errorState(api, rr.error, load));
        else drawReview(F.dataOf(rr));
      });
    }
    function drawTiles(jc, rq) {
      U.clear(tiles);
      var by = (jc && (jc.by_status || jc)) || {};
      var n = function (k) { return rq ? B.list(rq[k]).length : null; };
      [['tile_queued', by.queued, 'neutral', 'queued'], ['tile_unknown_jobs', by.unknown, 'warning', 'unknown'], ['tile_failed', F.nz(by.failed) + F.nz(by.dead), 'danger', 'failed']].forEach(function (k) {
        var active = QF.status === k[3];
        tiles.appendChild(U.kpi(t(k[0]), jc ? +(k[1] || 0) : null, k[2], { active: active, onClick: function () { QF.status = active ? '' : k[3]; QF.offset = 0; load(); } }));
      });
      tiles.appendChild(U.kpi(t('tile_conflict'), n('conflicts'), 'danger'));
      tiles.appendChild(U.kpi(t('tile_late'), n('late_charges'), 'warning'));
      tiles.appendChild(U.kpi(t('tile_review_other'), rq ? n('issued_mismatch') + n('issued_cancelled') + n('client_drift') + n('client_review') + n('item_review') : null, 'warning'));
    }
    function drawBar(total) {
      U.clear(bar);
      var all = function (lbl) { return lbl + ': ' + t('all'); };
      var fl = [
        U.select('status', t('f_status'), [['', all(t('f_status'))]].concat(['queued', 'running', 'unknown', 'done', 'conflict', 'failed', 'dead', 'cancelled'].map(function (s) { return [s, B.lab('bill_job_status', s)]; })), QF.status, function (v) { QF.status = v; QF.offset = 0; load(); }),
        U.select('kind', t('col_job_kind'), [['', all(t('col_job_kind'))]].concat(['probe', 'client_ensure', 'client_refresh', 'client_push', 'item_ensure', 'invoice_push', 'invoice_pull'].map(function (s) { return [s, B.lab('bill_job_kind', s)]; })), QF.kind, function (v) { QF.kind = v; QF.offset = 0; load(); })
      ];
      var bo = F.branchOptions(api, 'finRead', true);
      if (bo.length > 2) fl.push(U.select('branch_id', t('f_branch'), bo, QF.branch_id, function (v) { QF.branch_id = v; load(); }));
      bar.appendChild(U.toolbar(null, fl, [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })], total != null ? t('count_n', { n: total }) : null));
    }
    function retryAllowed(j) { return j.branch_id ? F.canAt(api, 'finWrite', j.branch_id) : B.canOrg(api, 'finWrite'); }
    function drawJobs(rows, d) {
      var total = d.total != null ? +d.total : rows.length;
      drawBar(total);
      if (rows.some(function (j) { return j.status === 'queued'; })) jobsBox.appendChild(U.alertBox('info', t('queued_no_worker')));
      if (!rows.length) { jobsBox.appendChild(U.card(t('jobs'), U.emptyState('check', t('jobs_empty_title'), t('jobs_empty')))); return; }
      jobsBox.appendChild(U.card(t('jobs'), B.jobsTable(api, sc, rows, { showTarget: true, canRetry: retryAllowed, onChanged: load }), null, { flush: true }));
      var pg = F.pager(total, PAGE, QF.offset, function (o) { QF.offset = o; load(); });
      if (pg) jobsBox.appendChild(pg);
    }
    function section(title, rows, heads, rowFn, empty) {
      if (!rows.length) return U.card(title, el('p', { class: 'text-sm text-muted', text: empty || t('queue_section_empty') }), null, { cls: 'bill-q-section is-empty' });
      return U.card(title + ' (' + rows.length + ')', U.table(heads, rows.map(rowFn), { caption: title }), null, { flush: true, cls: 'bill-q-section' });
    }
    function drawReview(q) {
      var approverAt = function (b) { return b ? F.canAt(api, 'finApprove', b) : B.canOrg(api, 'finApprove'); };
      var reviewRow = function (it) {
        return el('tr', { 'data-id': it.id }, [
          U.td(B.txLink(it.transaction_id, it.transaction_ref)),
          U.td(B.intentLink(it.intent_id, it.operational_ref)),
          U.td([el('span', { class: 'cell-main', text: chargeDesc(it) || U.NONE }), B.reviewDetails(it)]),
          U.td(B.when(it.created_at), 'is-nowrap'),
          U.td(approverAt(it.branch_id) && it.status !== 'resolved' ? U.btn(t('review_resolve'), 'btn-secondary', function () { B.reviewDialog(api, it).then(B.done(api, sc, t('review_resolved'), load)); }) : null, 'ops-col-actions')
        ]);
      };
      var rHeads = [t('col_tx'), t('col_op_ref'), t('col_details'), t('col_when'), { label: t('actions'), cls: 'ops-col-actions' }];
      var intentRow = function (x) {
        return el('tr', { 'data-id': x.id }, [
          U.td(B.intentLink(x.id, x.operational_ref)), U.td(B.txLink(x.transaction_id, x.transaction_ref)), U.td(B.clientName(x)),
          U.td([B.pill('bill_sync_state', x.sync_state, api), x.conflict && x.conflict.reason ? el('span', { class: 'cell-sub', text: B.lab('bill_conflict_reason', x.conflict.reason) }) : null]),
          U.td(B.when(x.last_synced_at || x.updated_at), 'is-nowrap'),
          U.td(el('a', { class: 'btn btn-sm btn-secondary', href: '#billing/' + x.id, text: t('open') }), 'ops-col-actions')
        ]);
      };
      var iHeads = [t('col_op_ref'), t('col_tx'), t('col_client'), t('col_sync'), t('col_when'), { label: t('actions'), cls: 'ops-col-actions' }];
      var linkRow = function (l) {
        return el('tr', { 'data-id': l.id }, [
          U.td([el('span', { class: 'cell-main', text: B.clientName(l) }), el('span', { class: 'cell-sub' }, B.ref(l.client_ref))]),
          U.td(B.pill('daftra_link_status', l.status, api)),
          U.td(B.list(l.drift).length ? el('span', { class: 'bill-drift' }, B.list(l.drift).map(function (f) { return U.pill('warning', B.lab('bill_drift', f.split(':')[0]) + ': ' + B.lab('bill_field', f.split(':')[1] || f)); })) : B.list(l.candidates).length ? el('span', { class: 'cell-sub', text: t('candidates_n', { n: B.list(l.candidates).length }) }) : null),
          U.td(el('a', { class: 'btn btn-sm btn-secondary', href: '#daftra/clients', text: t('open') }), 'ops-col-actions')
        ]);
      };
      var lHeads = [t('col_client'), t('col_status'), t('col_details'), { label: t('actions'), cls: 'ops-col-actions' }];
      var itemRow = function (it) {
        return el('tr', { 'data-id': it.id || it.item_key }, [
          U.td([el('span', { class: 'cell-main', text: B.itemLabel(it.item_key) }), el('span', { class: 'cell-sub' }, B.ref(it.product_code))]),
          U.td(B.pill('daftra_item_status', it.status, api)),
          U.td(B.list(it.candidates).length ? el('span', { class: 'cell-sub', text: t('candidates_n', { n: B.list(it.candidates).length }) }) : (it.last_error_message || null)),
          U.td(el('a', { class: 'btn btn-sm btn-secondary', href: '#daftra/items', text: t('open') }), 'ops-col-actions')
        ]);
      };
      var failedRow = function (j) {
        return el('tr', { 'data-id': j.id }, [
          U.td(B.lab('bill_job_kind', j.kind)), U.td(B.pill('bill_job_status', j.status, api)),
          U.td([B.ref(j.last_error_code || j.last_error_kind), el('span', { class: 'cell-sub', text: j.last_error_message || '' })]),
          U.td(retryAllowed(j) ? U.btn(t('job_retry'), 'btn-secondary', function () {
            U.call(api, 'retryBillingJob', j.id).then(function (r) { if (!sc.alive()) return; if (r.error) { F.toastErr(api, r); return; } U.toast(api, t('job_requeued'), 'success'); load(); });
          }) : null, 'ops-col-actions')
        ]);
      };
      reviewBox.appendChild(el('h3', { class: 'fin-sub-title bill-q-title', text: t('review_queue') }));
      reviewBox.appendChild(section(t('q_late_charges'), B.list(q.late_charges), rHeads, reviewRow, t('q_late_empty')));
      reviewBox.appendChild(section(t('q_issued_mismatch'), B.list(q.issued_mismatch), rHeads, reviewRow));
      reviewBox.appendChild(section(t('q_issued_cancelled'), B.list(q.issued_cancelled), rHeads, reviewRow));
      reviewBox.appendChild(section(t('q_conflicts'), B.list(q.conflicts), iHeads, intentRow));
      reviewBox.appendChild(section(t('q_unknown'), B.list(q.unknown), iHeads, intentRow, t('q_unknown_empty')));
      reviewBox.appendChild(section(t('q_failed_jobs'), B.list(q.failed_jobs), [t('col_job_kind'), t('col_status'), t('col_last_error'), { label: t('actions'), cls: 'ops-col-actions' }], failedRow));
      reviewBox.appendChild(section(t('q_client_drift'), B.list(q.client_drift), lHeads, linkRow));
      reviewBox.appendChild(section(t('q_client_review'), B.list(q.client_review), lHeads, linkRow));
      reviewBox.appendChild(section(t('q_item_review'), B.list(q.item_review), [t('col_item'), t('col_status'), t('col_details'), { label: t('actions'), cls: 'ops-col-actions' }], itemRow));
    }
    return load();
  }

  Ops.views.billing = {
    allow: 'finRead', titleKey: 'bill.nav_billing', icon: 'sync',
    render: function (root, api, param) {
      if (!Ops.billKit()) return noKit(root);
      if (param === 'queue') return renderQueue(root, api);
      if (param && UUID_RE.test(param)) return renderDetail(root, api, param);
      return renderList(root, api);
    }
  };
  // for the transaction section (bill/tx-bill.js) and tests
  Ops.billing = {
    newIntentDialog: function (api, presetTx) { var B = Ops.billKit(); return B ? newIntentDialog(B, api, presetTx) : Promise.resolve(null); },
    reviewDialog: function (api, item) { var B = Ops.billKit(); return B ? B.reviewDialog(api, item) : Promise.resolve(null); }
  };
})();
