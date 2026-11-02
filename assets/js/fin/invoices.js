/* ==========================================================================
   مرسى | MARSA — G4 operating costs: the shared finance kit (MarsaOps.finUi)
   and the supplier-invoice views #costs, #costs/review, #costs/<invoiceId>
   --------------------------------------------------------------------------
   Contract: docs/online/G4_SPEC.md ("Front end" → views, MarsaApi names).
   Uses MarsaOps.ui (assets/js/ops/alerts.js) for DOM, tables, tiles, the form
   modal, idempotency keys and errors; strings are 'fin.<k>' (assets/i18n/fin.js,
   also window.MarsaFinDict), falling back to the 'ops.<k>' strings.

   MarsaOps.finUi is defined here and used at render time by the other fin views
   (payables.js, margins.js, demurrage.js), so their load order does not matter.

   * The UI only hides — RLS and the guarded RPCs are the gate. Write buttons
     need can('finWrite', branch), approve buttons can('finApprove', branch).
   * «وجود فاتورة لا يثبت دفعها»: nothing here derives payment from a status.
   * Lines are never removed: a wrong line is reviewed as «مستبعد» with a note.
   * Server and user data go through textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};
  Ops.txSections = Ops.txSections || [];

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var MONEY_RE = /^[0-9٠-٩]{1,12}([.,٫][0-9٠-٩]{1,2})?$/;
  var MAX_MONEY = 999999999999.99;   // numeric(14,2), the server's app.fin_money cap
  var QTY_RE = /^[0-9٠-٩]{1,11}([.,٫][0-9٠-٩]{1,3})?$/;
  var PCT_RE = /^[0-9٠-٩]{1,3}([.,٫][0-9٠-٩]{1,4})?$/;
  var CUR_RE = /^[A-Z]{3}$/;

  /* ==================================================================
     MarsaOps.finUi — the finance kit (built on first use, after MarsaOps.ui exists)
     ================================================================== */
  function buildKit() {
    var U = Ops.ui;
    if (!U) return null;
    var el = U.el;

    function I18N() { return window.MarsaI18n; }
    function interp(s, vars) {
      return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s;
    }
    function dictGet(k) {
      var D = window.MarsaFinDict || {};
      var s = (D[U.lang()] || {})[k];
      return s == null ? (D.ar || {})[k] : s;
    }
    function has(k) {
      var I = I18N();
      if (I && typeof I.has === 'function' && I.has('fin.' + k)) return true;
      return dictGet(k) != null;
    }
    // fin.<k> → MarsaFinDict → the ops strings (generic words: save, cancel, …) → the key
    function t(k, vars) {
      var I = I18N(), key = 'fin.' + k;
      if (I && typeof I.t === 'function') {
        var s = I.t(key, vars);
        if (s != null && s !== key) return s;
      }
      var d = dictGet(k);
      if (d != null) return interp(d, vars);
      return U.has(k) ? U.t(k, vars) : k;
    }
    // label of a code: fin.<domain>_<code> (complete in fin.js) → server status_labels via api.label → code
    function lab(domain, code, api) {
      if (code == null || code === '') return U.NONE;
      var own = domain + '_' + code;
      if (has(own)) return t(own);
      if (api && typeof api.label === 'function') {
        try { var s = api.label(domain, code); if (s && s !== code && s !== domain + '.' + code) return s; } catch (e) { /* fall back */ }
      }
      return String(code);
    }
    var TONES = {
      fin_invoice_status: { received: 'info', under_review: 'warning', approved: 'success', disputed: 'danger', void: 'neutral' },
      fin_payment_status: { unpaid: 'danger', partial: 'warning', paid: 'success', paid_directly_by_client: 'brand' },
      fin_line_review: { pending_review: 'warning', ok: 'success', overhead: 'info', excluded: 'neutral', disputed: 'danger' },
      fin_alloc_status: { proposed: 'warning', approved: 'success', rejected: 'neutral', reversed: 'neutral' },
      fin_accrual_status: { open: 'info', matched: 'success', variance: 'warning', void: 'neutral' },
      fin_charge_status: { draft: 'warning', approved: 'success', invoiced: 'brand', void: 'neutral' },
      fin_demurrage_status: { open: 'warning', closed: 'success', waived: 'neutral', void: 'neutral' },
      fin_adjustment_status: { proposed: 'warning', approved: 'success', rejected: 'neutral' },
      fin_level: { confirmed: 'success', estimated: 'warning', unknown: 'danger', allocated: 'success', none: 'neutral' },
      pay_row: { recorded: 'success', void: 'neutral' }
    };
    function tone(domain, code) { return (TONES[domain] || {})[code] || 'neutral'; }
    function pill(domain, code, api) { return U.pill(tone(domain, code), lab(domain, code, api)); }
    function levelPill(level) {
      var p = U.pill(tone('fin_level', level), lab('fin_level', level));
      p.classList.add('fin-level', 'fin-level-' + (level || 'unknown'));
      return p;
    }

    // --- numbers / money ---------------------------------------------------
    function western(s) {
      return String(s == null ? '' : s).replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
        .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); }).replace(/٫/g, '.').replace(/٬/g, '');
    }
    // '' → null; '1,250.5' / '١٢٥٠٫٥' → 1250.5; garbage → NaN
    function num(s) {
      if (s == null) return null;
      if (typeof s === 'number') return s;
      var v = western(s).trim().replace(/\s+/g, '');
      if (v === '') return null;
      if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) v = v.replace(/,/g, '');
      else v = v.replace(',', '.');
      return /^-?\d+(\.\d+)?$/.test(v) ? +v : NaN;
    }
    function r2(n) { return Math.round((+n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100; }
    function nz(v) { var n = +v; return isNaN(n) ? 0 : n; }
    function money(n, cur, api) {
      if (n == null || n === '' || isNaN(+n)) return el('span', { class: 'ops-muted', text: U.NONE });
      return el('bdi', { dir: 'ltr', class: 'num fin-money' + (+n < 0 ? ' is-neg' : ''), text: U.fmtMoney(+n, cur || 'SAR', api) });
    }
    function moneyTxt(n, cur, api) { return n == null || n === '' || isNaN(+n) ? U.NONE : U.fmtMoney(+n, cur || 'SAR', api); }
    function amountStr(n) { return n == null || n === '' || isNaN(+n) ? '' : r2(+n).toFixed(2); }
    // totals_by_currency: [{currency, …}] or {SAR: {…}} → [{currency, …}]
    function byCurrency(x) {
      if (!x) return [];
      if (Array.isArray(x)) return x.filter(Boolean);
      return Object.keys(x).filter(function (k) { return x[k] && typeof x[k] === 'object'; })
        .map(function (k) { return Object.assign({ currency: k }, x[k]); });
    }

    // --- roles ---------------------------------------------------------------
    function canAt(api, set, branchId) {
      try { return !!(api && typeof api.can === 'function' && api.can(set, branchId || undefined)); } catch (e) { return false; }
    }
    // a per-row decision: the server's flag when present (can_approve / can_review: role at the ROW's branch + four eyes);
    // else the role at the row's own branch (never "any branch") and not on one's own row (admin excepted)
    function rowCan(api, row, flag, set, fallbackBranch) {
      if (row && typeof row[flag] === 'boolean') return row[flag];
      var b = (row && (row.branch_id || row.transaction_branch_id)) || fallbackBranch;
      if (!b || !canAt(api, set, b)) return false;
      if (row && row.created_by && api && api.userId && row.created_by === api.userId && !canAt(api, ['admin'], b)) return false;
      return true;
    }
    function branchesFor(api, set) {
      return (api && Array.isArray(api.branches) ? api.branches : []).filter(function (b) { return b && b.id && b.is_active !== false && canAt(api, set, b.id); });
    }
    function branchName(api, id) {
      if (!id) return U.NONE;
      var b = (api && Array.isArray(api.branches) ? api.branches : []).filter(function (x) { return x && x.id === id; })[0];
      return b ? ((U.lang() === 'en' && b.name_en) || b.name_ar || b.code || U.NONE) : String(id).slice(0, 8);
    }
    function branchOptions(api, set, withAll) {
      var list = set ? branchesFor(api, set) : (api && Array.isArray(api.branches) ? api.branches : []);
      var opts = list.map(function (b) { return [b.id, (U.lang() === 'en' && b.name_en) || b.name_ar || b.code]; });
      return withAll ? [['', t('all_branches')]].concat(opts) : opts;
    }

    // --- misc ------------------------------------------------------------------
    function dataOf(r) { return r && r.data && typeof r.data === 'object' ? r.data : {}; }
    function idOf(d) { return d ? (d.id || (d.invoice && d.invoice.id) || (d.row && d.row.id) || null) : null; }
    function supplierName(row) {
      var n = U.pick(row, U.lang() === 'en' ? ['supplier_name_en', 'supplier.name_en', 'supplier_name', 'supplier.name_ar'] : ['supplier_name', 'supplier_name_ar', 'supplier.name_ar', 'supplier.name_en']);
      return n || U.NONE;
    }
    function invLink(id, number) {
      if (!id) return number ? U.ltr(number) : U.NONE;
      return el('a', { class: 'ops-ref', href: '#costs/' + id }, el('bdi', { dir: 'ltr', text: number || String(id).slice(0, 8) }));
    }
    function toastErr(api, r) { U.toast(api, U.errMsg(r.error, api), U.errCode(r.error) === 'MRS_UNKNOWN_RESULT' ? 'warning' : 'error'); }
    // a toolbar date input
    function dateInput(name, label, value, onChange) {
      var i = el('input', { class: 'form-control is-sm ops-date', type: 'date', name: name, value: value || '', 'aria-label': label, title: label });
      i.addEventListener('change', function () { onChange(i.value); });
      return el('label', { class: 'ops-range' }, [el('span', { class: 'text-xs text-muted', text: label }), i]);
    }
    // the original tab bar (style.css .tab-list / .tab)
    function tabs(items, active, onPick, label) {
      return el('div', { class: 'tab-list fin-tabs', role: 'tablist', 'aria-label': label || null }, items.map(function (it) {
        var b = el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(it[0] === active), text: it[1] });
        b.addEventListener('click', function () { if (it[0] !== active) onPick(it[0]); });
        return b;
      }));
    }
    // analytical banner, always visible on margin figures
    function analyticalBanner() {
      return el('div', { class: 'alert alert-warning fin-analytical', role: 'note' }, [U.icon('info'), el('div', null, [el('strong', { text: t('analytical_title') }), el('span', { class: 'fin-analytical-sub', text: ' ' + t('analytical_text') })])]);
    }
    // allocation meter: allocated / net (original .progress)
    function meter(allocated, net, cur, api) {
      var pct = net > 0 ? Math.max(0, Math.min(100, allocated / net * 100)) : 0;
      var rem = r2(net - allocated);
      var bar = el('div', { class: 'progress-bar' });
      bar.style.width = pct.toFixed(1) + '%';
      return el('div', { class: 'fin-meter' + (rem < 0 ? ' is-over' : rem === 0 ? ' is-full' : '') }, [
        el('div', { class: 'progress-meta' }, [el('span', { text: t('allocated_pct', { n: Math.round(pct) }) }), el('span', { text: t('remaining_amt', { amt: moneyTxt(rem, cur, api) }) })]),
        el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) }, bar)
      ]);
    }
    function dl(rows) {
      var n = el('dl', { class: 'app-dl fin-dl' });
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
      return el('div', { class: 'adm-pager fin-pager' }, [
        el('p', { class: 'adm-count text-sm text-muted', text: t('page_of', { page: page, pages: pages, total: total }) }),
        el('div', { class: 'adm-pager-btns flex gap-1' }, [
          U.btn(t('prev'), 'btn-secondary', function () { onGo(Math.max(0, offset - limit)); }, { disabled: offset <= 0 }),
          U.btn(t('next'), 'btn-secondary', function () { onGo(offset + limit); }, { disabled: offset + limit >= total })
        ])
      ]);
    }
    function currencyOptions(extra) {
      var list = ['SAR', 'USD', 'EUR', 'AED', 'CNY'];
      (extra || []).forEach(function (c) { if (c && list.indexOf(c) === -1) list.push(c); });
      return list.map(function (c) { return [c, c]; });
    }
    var SERVICES = ['customs_clearance', 'transport', 'port_charges', 'delivery_order', 'storage', 'demurrage', 'detention',
      'inspection', 'empty_handling', 'washing', 'repair', 'documentation', 'saber', 'other'];
    function serviceOptions(withNone) {
      var o = SERVICES.map(function (s) { return [s, lab('fin_service', s)]; });
      return withNone ? [['', t('service_none')]].concat(o) : o;
    }
    var METHODS = ['bank_transfer', 'cash', 'cheque', 'card', 'offset', 'other'];

    // --- files -----------------------------------------------------------------
    var ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif';
    function fileField(label, hint) {
      var id = 'fin-f-' + Math.random().toString(36).slice(2, 8);
      var inp = el('input', { type: 'file', id: id, class: 'form-control fin-file', accept: ACCEPT });
      var box = el('div', { class: 'form-group ops-field is-full fin-file-field' }, [
        el('label', { class: 'form-label', for: id, text: label }), inp, hint ? el('span', { class: 'form-hint', text: hint }) : null
      ]);
      return { node: box, input: inp, file: function () { return inp.files && inp.files[0] ? inp.files[0] : null; } };
    }
    // one upload per (file, branch, kind) while the dialog lives: a retry reuses the registered document
    function uploader(api) {
      var done = {};
      return function (file, branchId, kind) {
        if (!file) return Promise.resolve({ data: null, error: null });
        var sig = [file.name, file.size, file.lastModified, branchId, kind].join('|');
        if (done[sig]) return Promise.resolve({ data: done[sig], error: null });
        // the same key until a definite answer: a retry after a lost answer / failed upload replays the registration
        var scope = 'fin-up-' + sig, key = U.idemKey(api, scope, sig);
        return U.call(api, 'uploadFinanceDocument', { file: file, branchId: branchId, kind: kind }, { idemKey: key }).then(function (r) {
          if (!r.error && r.data) done[sig] = r.data;
          if (!r.error || U.errCode(r.error) !== 'MRS_UPLOAD') U.idemSettle(scope, r.error);
          return r;
        });
      };
    }
    function openFile(api, path, bucket) {
      if (!path) return;
      var fn = bucket === 'documents' ? 'documentUrl' : 'financeDocumentUrl';
      U.call(api, fn, path, 300).then(function (r) {
        if (r.error) { toastErr(api, r); return; }
        var u = r.data && (r.data.signedUrl || r.data.url || (typeof r.data === 'string' ? r.data : null));
        if (u) { try { window.open(u, '_blank', 'noopener'); } catch (e) { /* popup blocked */ } }
      });
    }
    function fileLink(api, path, bucket, label) {
      if (!path) return null;
      return U.btn([U.icon('file'), el('span', { text: label || t('open_original') })], 'btn-subtle', function () { openFile(api, path, bucket); });
    }

    // --- pickers -----------------------------------------------------------------
    // transaction finder: type a reference → pick one; onPick(tx)
    function txFinder(api, onPick, initial) {
      var picked = initial || null;
      var inp = el('input', { class: 'form-control', type: 'search', placeholder: t('tx_find_ph'), 'aria-label': t('tx_find'), autocomplete: 'off', dir: 'ltr' });
      var list = el('div', { class: 'fin-finder-list', role: 'listbox', 'aria-label': t('tx_find') });
      var chosen = el('div', { class: 'fin-finder-chosen', 'aria-live': 'polite' });
      var timer = null, seq = 0;
      function showChosen() {
        U.clear(chosen);
        if (!picked) return;
        chosen.appendChild(el('span', { class: 'badge badge-teal' }, [t('tx') + ': ', el('bdi', { dir: 'ltr', text: picked.ref || String(picked.id).slice(0, 8) })]));
        var cl = U.pick(picked, ['clients.name_ar', 'client_name']);
        if (cl) chosen.appendChild(el('span', { class: 'text-xs text-muted', text: ' ' + cl }));
      }
      function search() {
        var q = inp.value.trim(), my = ++seq;
        U.clear(list);
        if (q.length < 2) return;
        U.call(api, 'listTransactions', { orgId: api && api.orgId, search: q, limit: 8 }).then(function (r) {
          if (my !== seq) return;
          U.clear(list);
          if (r.error) { list.appendChild(el('p', { class: 'form-error', text: U.errMsg(r.error, api) })); return; }
          var rows = U.rowsOf(r.data);
          if (!rows.length) { list.appendChild(el('p', { class: 'text-xs text-muted', text: t('tx_none') })); return; }
          rows.forEach(function (x) {
            var b = el('button', { type: 'button', class: 'btn btn-sm btn-secondary fin-finder-item', role: 'option' }, [
              el('bdi', { dir: 'ltr', text: x.ref || String(x.id).slice(0, 8) }),
              el('span', { class: 'text-xs text-muted', text: ' ' + (U.pick(x, ['clients.name_ar', 'client_name']) || '') })
            ]);
            b.addEventListener('click', function () { picked = x; U.clear(list); inp.value = ''; showChosen(); onPick(x); });
            list.appendChild(b);
          });
        });
      }
      inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 250); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(); } });
      showChosen();
      return { node: el('div', { class: 'fin-finder' }, [inp, list, chosen]), get: function () { return picked; } };
    }
    // a plain <select class=form-control> (inside custom dialog bodies)
    function selectEl(name, label, options, value) {
      var s = el('select', { class: 'form-control', name: name, 'aria-label': label }, options.map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      s.value = value == null ? '' : String(value);
      return s;
    }
    function field(label, control, o) {
      o = o || {};
      return el('div', { class: 'form-group ops-field' + (o.full ? ' is-full' : '') }, [
        el('label', { class: 'form-label' }, [label, o.required ? el('span', { class: 'ops-req', 'aria-hidden': 'true', text: ' *' }) : null]),
        control, o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null
      ]);
    }
    function parties(api, kinds) {
      return U.call(api, 'listParties', { limit: 500 }).then(function (r) {
        var rows = r.error ? [] : U.rowsOf(r.data);
        if (kinds && kinds.length) rows = rows.filter(function (p) { return (p.kinds || []).some(function (k) { return kinds.indexOf(k) !== -1; }); });
        return { rows: rows, error: r.error };
      });
    }
    function partyOptions(rows, noneLabel) {
      return [['', noneLabel || U.NONE]].concat(rows.map(function (p) { return [p.id, U.partyName(p)]; }));
    }

    // --- a note / reason dialog --------------------------------------------------
    function noteDialog(api, o) {
      var fields = (o.fields || []).concat([{ name: 'note', label: o.noteLabel || t('note'), type: 'textarea', required: o.required !== false, max: 2000, rows: 3, hint: o.hint }]);
      return U.formModal({ title: o.title, size: 'sm', intro: o.intro, warn: o.warn, submitText: o.submitText, danger: !!o.danger, fields: fields, validate: o.validate,
        submit: function (v) { return o.submit(U.nn(v.note), v); } });
    }

    /* ------------------------------------------------------------------
       Record a supplier payment (invoice detail + #payables).
       inv = { id, branch_id, currency, total_amount, company_paid_amount, client_paid_amount, invoice_number, doc_type }
       ------------------------------------------------------------------ */
    function paymentDialog(api, inv) {
      var cur = inv.currency || 'SAR';
      var due = r2(nz(inv.payable_amount != null ? inv.payable_amount : inv.total_amount) - nz(inv.company_paid_amount) - nz(inv.client_paid_amount));
      var up = uploader(api), file = fileField(t('pay_evidence'), t('pay_evidence_hint'));
      var clientsP = U.call(api, 'listClients', { orgId: api && api.orgId, limit: 500 });
      return clientsP.then(function (cr) {
        var clients = cr.error ? [] : U.rowsOf(cr.data);
        var clientOpts = [['', U.NONE]].concat(clients.map(function (c) { return [c.id, (U.lang() === 'en' && c.name_en) || c.name_ar]; }));
        var intro = el('div', { class: 'fin-dialog-intro' }, [
          el('p', { class: 'ops-modal-intro' }, [t('pay_for') + ' ', el('bdi', { dir: 'ltr', text: inv.invoice_number || '' }), ' · ' + t('pay_remaining', { amt: moneyTxt(due, cur, api) })]),
          el('p', { class: 'form-hint', text: t('pay_rule') })
        ]);
        var o = {
          title: t('pay_record'), intro: intro, submitText: t('pay_record'),
          fields: [
            { name: 'amount', label: t('f_amount') + ' (' + cur + ')', required: true, value: due > 0 ? amountStr(due) : '', ltr: true, inputmode: 'decimal', pattern: MONEY_RE, patternMsg: t('money_invalid') },
            { name: 'paid_at', label: t('f_paid_at'), type: 'date', required: true, value: U.isoDay(new Date()) },
            { name: 'method', label: t('f_method'), type: 'select', required: true, value: 'bank_transfer', options: METHODS.map(function (m) { return [m, lab('fin_payment_method', m)]; }) },
            { name: 'payer', label: t('f_payer'), type: 'select', required: true, value: 'company', options: [['company', lab('fin_payer', 'company')], ['client', lab('fin_payer', 'client')]], hint: t('payer_hint') },
            { name: 'client_id', label: t('f_client'), type: 'select', options: clientOpts, hint: t('client_payer_hint') },
            { name: 'reference', label: t('f_reference'), max: 120, ltr: true }
          ],
          validate: function (v) {
            var bad = {}, a = num(v.amount);
            if (!(a > 0)) bad.amount = t('amount_positive');
            else if (due > 0 && a > due + 0.001) bad.amount = t('overpay_local', { amt: moneyTxt(due, cur, api) });
            if (v.paid_at && v.paid_at > U.isoDay(U.addDays(new Date(), 1))) bad.paid_at = t('date_future');
            if (v.payer === 'client' && !v.client_id) bad.client_id = t('required');
            if (v.payer === 'client' && !file.file()) bad._file = t('client_needs_file');
            if (!U.nn(v.reference) && !file.file()) bad.reference = t('ref_or_file');
            return bad;
          },
          submit: function (v) {
            return up(file.file(), inv.branch_id, 'payment_evidence').then(function (u) {
              if (u.error) return u;
              // currency = the invoice's (server)
              var p = { supplier_invoice_id: inv.id, amount: r2(num(v.amount)), paid_at: v.paid_at, method: v.method, payer: v.payer,
                client_id: v.payer === 'client' ? v.client_id : null, reference: U.nn(v.reference), evidence_document_id: u.data ? u.data.id : null };
              var scope = 'fin-pay-' + inv.id, key = U.idemKey(api, scope, p);
              return U.call(api, 'recordSupplierPayment', p, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
            });
          }
        };
        var pr = U.formModal(o);
        var form = intro.closest('form');
        if (form) {
          var grid = form.querySelector('.ops-form-grid');
          if (grid) grid.appendChild(file.node);
          var payer = form.elements.payer, client = form.elements.client_id;
          var sync = function () { var c = payer && payer.value === 'client'; if (client) { client.closest('.form-group').hidden = !c; } };
          if (payer) payer.addEventListener('change', sync);
          sync();
        }
        return pr;
      });
    }

    return {
      U: U, t: t, has: has, lab: lab, tone: tone, pill: pill, levelPill: levelPill,
      num: num, r2: r2, nz: nz, money: money, moneyTxt: moneyTxt, amountStr: amountStr, byCurrency: byCurrency, western: western,
      canAt: canAt, rowCan: rowCan, branchesFor: branchesFor, branchName: branchName, branchOptions: branchOptions,
      dataOf: dataOf, idOf: idOf, supplierName: supplierName, invLink: invLink, toastErr: toastErr, dateInput: dateInput, tabs: tabs,
      analyticalBanner: analyticalBanner, meter: meter, dl: dl, pager: pager, currencyOptions: currencyOptions,
      SERVICES: SERVICES, serviceOptions: serviceOptions, METHODS: METHODS,
      fileField: fileField, uploader: uploader, openFile: openFile, fileLink: fileLink, txFinder: txFinder, selectEl: selectEl, field: field,
      parties: parties, partyOptions: partyOptions, noteDialog: noteDialog, paymentDialog: paymentDialog,
      MONEY_RE: MONEY_RE, QTY_RE: QTY_RE, PCT_RE: PCT_RE, CUR_RE: CUR_RE, UUID_RE: UUID_RE
    };
  }
  Ops.finKit = function () {
    if (!Ops.finUi && Ops.ui) Ops.finUi = buildKit();
    return Ops.finUi || null;
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
     Line editor (new invoice + add lines): rows of inputs, OCR paste
     ================================================================== */
  var UNREADABLE = '(بند غير مقروء)';
  function linesEditor(F, api, cur) {
    var U = F.U, el = U.el, t = F.t;
    var rows = [];
    var tbody = el('tbody');
    var foot = el('tfoot');
    var err = el('p', { class: 'form-error', hidden: true });
    function inp(r, key, o) {
      o = o || {};
      var i = el('input', { class: 'form-control is-sm fin-line-in fin-in-' + key, type: 'text', value: r[key] == null ? '' : r[key], dir: o.ltr ? 'ltr' : null,
        inputmode: o.decimal ? 'decimal' : null, 'aria-label': o.label, placeholder: o.ph || null, maxlength: o.max || null });
      i.addEventListener('input', function () { r[key] = i.value; if (o.after) o.after(i); drawFoot(); });
      return i;
    }
    function recalc(r, row, which) {
      var q = F.num(r.qty), p = F.num(r.price);
      if ((which === 'qty' || which === 'price') && p != null && !isNaN(p) && q != null && !isNaN(q)) {
        r.net = F.r2(q * p).toFixed(2);
        var ni = row.querySelector('.fin-in-net'); if (ni) ni.value = r.net;
      }
      if (!r.vatTouched) {
        var n = F.num(r.net), rate = F.num(r.rate);
        if (n != null && !isNaN(n) && rate != null && !isNaN(rate)) {
          r.vat = F.r2(n * rate / 100).toFixed(2);
          var vi = row.querySelector('.fin-in-vat'); if (vi) vi.value = r.vat;
        }
      }
    }
    function rowNode(r) {
      var tr = el('tr', { class: r.source === 'ocr' ? 'fin-line-ocr' : null });
      var svc = el('select', { class: 'form-control is-sm fin-line-in', 'aria-label': t('f_service') }, F.serviceOptions(true).map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      svc.value = r.service || '';
      svc.addEventListener('change', function () { r.service = svc.value; });
      var after = function (which) { return function () { recalc(r, tr, which); }; };
      var vatIn = inp(r, 'vat', { label: t('f_vat_amount'), ltr: true, decimal: true, after: function () { r.vatTouched = true; } });
      var rm = U.btn([U.icon('x')], 'btn-subtle btn-icon', function () { rows.splice(rows.indexOf(r), 1); draw(); }, { 'aria-label': t('line_remove'), title: t('line_remove') });
      [
        el('td', { class: 'fin-line-no num', text: String(rows.indexOf(r) + 1) }),
        el('td', null, [inp(r, 'desc', { label: t('f_description'), max: 500, ph: r.source === 'ocr' ? UNREADABLE : null }), r.source === 'ocr' ? el('span', { class: 'badge badge-blue badge-sm', text: t('src_ocr') }) : null]),
        el('td', null, svc),
        el('td', null, inp(r, 'qty', { label: t('f_qty'), ltr: true, decimal: true, after: after('qty') })),
        el('td', null, inp(r, 'price', { label: t('f_unit_price'), ltr: true, decimal: true, after: after('price') })),
        el('td', null, inp(r, 'net', { label: t('f_net'), ltr: true, decimal: true, after: after('net') })),
        el('td', null, inp(r, 'rate', { label: t('f_vat_rate'), ltr: true, decimal: true, after: after('rate') })),
        el('td', null, vatIn),
        el('td', null, inp(r, 'ctr', { label: t('f_container_hint'), ltr: true, max: 20 })),
        el('td', { class: 'ops-col-actions' }, rm)
      ].forEach(function (c) { tr.appendChild(c); });
      return tr;
    }
    function sums() {
      var s = { net: 0, vat: 0 };
      rows.forEach(function (r) { var n = F.num(r.net), v = F.num(r.vat); if (n != null && !isNaN(n)) s.net += n; if (v != null && !isNaN(v)) s.vat += v; });
      s.net = F.r2(s.net); s.vat = F.r2(s.vat); s.total = F.r2(s.net + s.vat);
      return s;
    }
    function drawFoot() {
      U.clear(foot);
      var s = sums();
      foot.appendChild(el('tr', null, [
        el('td', { colspan: '5', text: t('lines_sum', { n: rows.length }) }),
        el('td', { class: 'num' }, F.money(s.net, cur(), api)), el('td'), el('td', { class: 'num' }, F.money(s.vat, cur(), api)),
        el('td', { colspan: '2', class: 'num' }, F.money(s.total, cur(), api))
      ]));
    }
    function draw() {
      U.clear(tbody);
      rows.forEach(function (r) { tbody.appendChild(rowNode(r)); });
      if (!rows.length) tbody.appendChild(el('tr', null, el('td', { colspan: '10', class: 'text-muted text-sm', text: t('lines_none') })));
      drawFoot();
    }
    function add(r) { rows.push(Object.assign({ desc: '', service: '', qty: '1', price: '', net: '', rate: '15', vat: '', ctr: '', source: 'manual' }, r || {})); }
    // OCR text → rows: the last number on each line is its net amount; the rest is the description
    function fromOcr(text) {
      var n = 0, skipped = 0;
      String(text || '').split(/\r?\n/).forEach(function (line) {
        var s = F.western(line).trim();
        if (!s) return;
        var m = s.match(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:SAR|ر\.?س\.?|ريال)?\s*$/i);
        if (!m) { skipped++; return; }
        var amount = F.num(m[1]);
        // a trailing B/L, container or reference number is not an amount (more than 12 integer digits)
        if (amount == null || isNaN(amount) || amount > MAX_MONEY) { skipped++; return; }
        var desc = s.slice(0, m.index).replace(/[\s:|\-–—.]+$/, '').trim();
        add({ desc: desc, net: F.r2(amount).toFixed(2), vat: F.r2(amount * 0.15).toFixed(2), source: 'ocr' });
        n++;
      });
      draw();
      return { added: n, skipped: skipped };
    }
    var ocrBox = el('textarea', { class: 'form-control', rows: '3', 'aria-label': t('ocr_paste'), placeholder: t('ocr_ph') });
    var ocrMsg = el('span', { class: 'form-hint', 'aria-live': 'polite' });
    var ocrB = U.btn(t('ocr_convert'), 'btn-secondary', function () {
      var res = fromOcr(ocrBox.value);
      ocrMsg.textContent = t('ocr_done', { n: res.added, s: res.skipped });
      if (res.added) ocrBox.value = '';
    });
    var addB = U.btn([U.icon('plus'), el('span', { text: t('line_add') })], 'btn-secondary', function () { add(); draw(); var last = tbody.querySelector('tr:last-child .fin-in-desc'); if (last) last.focus(); });
    var node = el('div', { class: 'fin-lines-editor' }, [
      el('div', { class: 'table-wrap fin-lines-wrap' }, el('table', { class: 'table table-striped adm-table fin-lines-table' }, [
        el('thead', null, el('tr', null, ['#', t('f_description'), t('f_service'), t('f_qty'), t('f_unit_price'), t('f_net'), t('f_vat_rate'), t('f_vat_amount'), t('f_container_hint'), ''].map(function (h) { return el('th', { scope: 'col', text: h }); }))),
        tbody, foot
      ])),
      el('div', { class: 'fin-lines-tools' }, [addB]),
      el('details', { class: 'fin-ocr' }, [el('summary', { text: t('ocr_paste') }), el('p', { class: 'form-hint', text: t('ocr_hint') }), ocrBox, el('div', { class: 'fin-lines-tools' }, [ocrB, ocrMsg])]),
      err
    ]);
    add(); draw();
    function validate() {
      var msg = null;
      rows.forEach(function (r, i) {
        if (msg) return;
        var n = F.num(r.net), q = F.num(r.qty), rate = F.num(r.rate), v = F.num(r.vat), p = F.num(r.price);
        if (n == null || isNaN(n) || n < 0 || n > MAX_MONEY || F.r2(n) !== n) msg = t('line_err_net', { n: i + 1 });
        else if (q == null || isNaN(q) || q <= 0) msg = t('line_err_qty', { n: i + 1 });
        else if (rate == null || isNaN(rate) || rate < 0 || rate > 100) msg = t('line_err_rate', { n: i + 1 });
        else if (v == null || isNaN(v) || v < 0 || v > MAX_MONEY) msg = t('line_err_vat', { n: i + 1 });
        else if (p != null && (isNaN(p) || p < 0 || p > MAX_MONEY)) msg = t('line_err_price', { n: i + 1 });
        else if (!String(r.desc || '').trim() && r.source !== 'ocr') msg = t('line_err_desc', { n: i + 1 });
        else if (String(r.desc || '').length > 500) msg = t('line_err_desc', { n: i + 1 });
      });
      err.textContent = msg || ''; err.hidden = !msg;
      return msg;
    }
    function payload(source) {
      return rows.filter(function (r) { return (r.source === 'ocr') === (source === 'ocr'); }).map(function (r) {
        var p = F.num(r.price), d = String(r.desc || '').trim();
        return {
          description: d || null, quantity: F.num(r.qty), unit_price: p == null || isNaN(p) ? null : F.r2(p),
          net_amount: F.r2(F.num(r.net)), vat_rate: F.num(r.rate), vat_amount: F.r2(F.num(r.vat)),
          service_code: r.service || null, container_no_hint: U.nn(r.ctr) ? String(r.ctr).trim().toUpperCase() : null
        };
      });
    }
    return { node: node, validate: validate, sums: sums, count: function () { return rows.length; }, payload: payload };
  }

  /* ==================================================================
     New supplier invoice: original → duplicate check → header + lines
     ================================================================== */
  function newInvoiceDialog(F, api, preset) {
    var U = F.U, el = U.el, t = F.t;
    preset = preset || {};
    var branches = F.branchesFor(api, 'finWrite');
    if (!branches.length) { U.toast(api, t('no_write_branch'), 'warning'); return Promise.resolve(null); }
    return F.parties(api).then(function (pr) {
      var suppliers = pr.rows.filter(function (p) { return p.is_active !== false; });
      var up = F.uploader(api);
      var file = F.fileField(t('inv_original'), t('inv_original_hint'));
      var dupBox = el('div', { class: 'fin-dup-box', 'aria-live': 'polite' });
      var linesHost = el('div', { class: 'fin-lines-host' });
      var state = { exact: [], possible: [], fileDup: [], sha: null };
      var curNow = function () { var f = linesHost.closest('form'); return f && f.elements.currency ? f.elements.currency.value || 'SAR' : 'SAR'; };
      var ed = linesEditor(F, api, curNow);
      linesHost.appendChild(el('h3', { class: 'fin-sub-title', text: t('inv_lines') }));
      linesHost.appendChild(ed.node);
      var intro = el('div', { class: 'fin-dialog-intro' }, [el('p', { class: 'form-hint', text: t('inv_new_intro') }), file.node, dupBox]);
      var o = {
        title: t('inv_new'), size: 'lg', intro: intro, submitText: t('inv_save'),
        fields: [
          { name: 'branch_id', label: t('f_branch'), type: 'select', required: true, value: preset.branch_id || branches[0].id, options: F.branchOptions(api, 'finWrite') },
          { name: 'supplier_id', label: t('f_supplier'), type: 'select', required: true, value: preset.supplier_id || '', options: F.partyOptions(suppliers, t('pick_supplier')), hint: suppliers.length ? null : t('no_suppliers') },
          { name: 'doc_type', label: t('f_doc_type'), type: 'select', required: true, value: preset.doc_type || 'invoice', options: ['invoice', 'credit_note', 'debit_note'].map(function (d) { return [d, F.lab('fin_invoice_doc_type', d)]; }) },
          { name: 'adjusts_invoice_id', label: t('f_adjusts'), type: 'select', options: [['', U.NONE]], hint: t('adjusts_hint') },
          { name: 'invoice_number', label: t('f_invoice_number'), required: true, max: 60, ltr: true },
          { name: 'invoice_date', label: t('f_invoice_date'), type: 'date', required: true, value: U.isoDay(new Date()) },
          { name: 'due_date', label: t('f_due_date'), type: 'date' },
          { name: 'currency', label: t('f_currency'), type: 'select', required: true, value: 'SAR', options: F.currencyOptions() },
          { name: 'subtotal', label: t('f_subtotal'), ltr: true, inputmode: 'decimal', pattern: MONEY_RE, patternMsg: t('money_invalid'), hint: t('from_lines_hint') },
          { name: 'vat_amount', label: t('f_vat_total'), ltr: true, inputmode: 'decimal', pattern: MONEY_RE, patternMsg: t('money_invalid') },
          { name: 'total_amount', label: t('f_total'), ltr: true, inputmode: 'decimal', pattern: MONEY_RE, patternMsg: t('money_invalid') },
          { name: 'reference', label: t('f_inv_reference'), max: 120, ltr: true, hint: t('inv_reference_hint') },
          { name: 'supplier_vat_number', label: t('f_supplier_vat'), max: 15, ltr: true, pattern: /^[0-9]{15}$/, patternMsg: t('vat_no_invalid'), inputmode: 'numeric' },
          { name: 'notes', label: t('f_notes'), type: 'textarea', max: 2000, rows: 2 }
        ],
        validate: function (v) {
          var bad = {};
          if (v.due_date && v.invoice_date && v.due_date < v.invoice_date) bad.due_date = t('due_before_date');
          if (v.doc_type !== 'invoice' && !v.adjusts_invoice_id) bad.adjusts_invoice_id = t('required');
          var lm = ed.validate();
          if (lm) bad._lines = lm;
          var s = ed.sums(), sub = F.num(v.subtotal), vat = F.num(v.vat_amount), tot = F.num(v.total_amount);
          sub = sub == null ? s.net : sub; vat = vat == null ? s.vat : vat; tot = tot == null ? F.r2(sub + vat) : tot;
          if (Math.abs(F.r2(sub + vat) - tot) > 0.004) bad.total_amount = t('total_mismatch');
          if (!ed.count() && F.num(v.subtotal) == null) bad.subtotal = t('required');
          if (state.exact.length) bad._dup = t('dup_exact_block');
          return bad;
        },
        submit: function (v) {
          var s = ed.sums();
          var sub = F.num(v.subtotal), vat = F.num(v.vat_amount), tot = F.num(v.total_amount);
          sub = sub == null ? s.net : F.r2(sub); vat = vat == null ? s.vat : F.r2(vat); tot = tot == null ? F.r2(sub + vat) : F.r2(tot);
          return up(file.file(), v.branch_id, v.doc_type === 'invoice' ? 'supplier_invoice' : 'credit_note').then(function (u) {
            if (u.error) return u;
            var p = {
              branch_id: v.branch_id, supplier_id: v.supplier_id, doc_type: v.doc_type, adjusts_invoice_id: v.doc_type === 'invoice' ? null : (v.adjusts_invoice_id || null),
              invoice_number: v.invoice_number, invoice_date: v.invoice_date, due_date: v.due_date || null, currency: v.currency,
              subtotal: sub, vat_amount: vat, total_amount: tot, reference: U.nn(v.reference), supplier_vat_number: U.nn(v.supplier_vat_number),
              finance_document_id: u.data ? u.data.id : null, notes: U.nn(v.notes)
            };
            var manual = ed.payload('manual'), ocr = ed.payload('ocr');
            if (manual.length) p.lines = manual;
            var scope = 'fin-inv-new', key = U.idemKey(api, scope, p);
            return U.call(api, 'createSupplierInvoice', p, { idemKey: key }).then(function (r) {
              U.idemSettle(scope, r.error);
              if (r.error || !ocr.length) return r;
              var id = F.idOf(r.data);
              var scope2 = 'fin-inv-ocr-' + id, key2 = U.idemKey(api, scope2, ocr);
              return U.call(api, 'addInvoiceLines', id, ocr, 'ocr', { idemKey: key2 }).then(function (r2) {
                U.idemSettle(scope2, r2.error);
                if (r2.error) U.toast(api, t('ocr_lines_failed', { msg: U.errMsg(r2.error, api) }), 'warning');
                return { data: r.data, error: null };
              });
            });
          });
        }
      };
      var p = U.formModal(o);
      var form = intro.closest('form');
      if (form) {
        var grid = form.querySelector('.ops-form-grid');
        if (grid && grid.parentNode) grid.parentNode.insertBefore(linesHost, grid.nextSibling);
        wire(form);
      }
      function wire(form) {
        var E = form.elements, timer = null, seq = 0;
        var adjField = E.adjusts_invoice_id ? E.adjusts_invoice_id.closest('.form-group') : null;
        function syncDocType() {
          var isInv = E.doc_type.value === 'invoice';
          if (adjField) adjField.hidden = isInv;
          if (!isInv) loadAdjustable();
        }
        function loadAdjustable() {
          var sup = E.supplier_id.value, sel = E.adjusts_invoice_id;
          if (!sel) return;
          while (sel.options.length > 1) sel.remove(1);
          if (!sup) return;
          U.call(api, 'listSupplierInvoices', { supplier_id: sup, limit: 200 }).then(function (r) {
            if (r.error) return;
            U.rowsOf(r.data).filter(function (x) { return x.doc_type === 'invoice' && x.status !== 'void'; }).forEach(function (x) {
              sel.appendChild(el('option', { value: x.id, text: (x.invoice_number || '') + ' · ' + U.fmtDate(x.invoice_date) + ' · ' + F.moneyTxt(x.total_amount, x.currency, api) }));
            });
          });
        }
        function supplierVat() {
          var s = suppliers.filter(function (x) { return x.id === E.supplier_id.value; })[0];
          if (s && s.vat_number && /^[0-9]{15}$/.test(s.vat_number) && !E.supplier_vat_number.value) E.supplier_vat_number.value = s.vat_number;
          if (s && s.default_currency && CUR_RE.test(s.default_currency)) E.currency.value = s.default_currency;
        }
        function check() {
          clearTimeout(timer);
          timer = setTimeout(function () {
            var sup = E.supplier_id.value, no = E.invoice_number.value.trim();
            if (!sup || (!no && !state.sha)) { state.exact = []; state.possible = []; state.fileDup = []; drawDup(); return; }
            var s = ed.sums(), tot = F.num(E.total_amount.value);
            var payload = { supplier_id: sup, invoice_number: no || null, invoice_date: E.invoice_date.value || null,
              total_amount: tot == null || isNaN(tot) ? (s.total || null) : tot, doc_type: E.doc_type.value };
            if (state.sha) payload.sha256 = state.sha;
            var my = ++seq;
            U.call(api, 'checkInvoiceDuplicate', payload).then(function (r) {
              if (my !== seq) return;
              if (r.error) { state.exact = []; state.possible = []; state.fileDup = []; drawDup(r.error); return; }
              var d = F.dataOf(r);
              state.exact = d.exact || []; state.possible = d.possible || []; state.fileDup = d.file || [];
              drawDup();
            });
          }, 350);
        }
        function dupList(items) {
          return el('ul', { class: 'fin-dup-list' }, items.map(function (x) {
            if (x.finance_document_id && !x.invoice_number) {
              var invs = x.invoices || [];
              return el('li', null, [el('bdi', { text: x.original_name || U.NONE }),
                x.uploaded_at ? el('span', { class: 'text-xs text-muted', text: ' ' + U.fmtDate(x.uploaded_at) }) : null,
                invs.length ? el('span', null, invs.map(function (i) { return el('span', null, [' · ', F.invLink(i.id, i.invoice_number), ' ', F.pill('fin_invoice_status', i.status, api)]); }))
                            : el('span', { class: 'text-xs text-muted', text: ' · ' + t('dup_file_unused') })]);
            }
            return el('li', null, [F.invLink(x.id, x.invoice_number), x.status ? ' ' : null, x.status ? F.pill('fin_invoice_status', x.status, api) : null,
              x.invoice_date ? el('span', { class: 'text-xs text-muted', text: ' ' + U.fmtDate(x.invoice_date) }) : null,
              x.total_amount != null ? el('span', { class: 'text-xs text-muted', text: ' · ' + F.moneyTxt(x.total_amount, x.currency, api) }) : null,
              x.supplier_name ? el('span', { class: 'text-xs text-muted', text: ' · ' + x.supplier_name }) : null]);
          }));
        }
        function drawDup(e) {
          U.clear(dupBox);
          if (e) { dupBox.appendChild(U.alertBox('info', t('dup_check_failed', { msg: U.errMsg(e, api) }))); return; }
          if (state.exact.length) dupBox.appendChild(el('div', { class: 'alert alert-danger fin-dup', role: 'alert' }, [U.icon('alert'), el('div', null, [el('strong', { text: t('dup_exact') }), dupList(state.exact)])]));
          if (state.fileDup.length) dupBox.appendChild(el('div', { class: 'alert alert-warning fin-dup', role: 'status' }, [U.icon('alert'), el('div', null, [el('strong', { text: t('dup_file') }), dupList(state.fileDup)])]));
          if (state.possible.length) dupBox.appendChild(el('div', { class: 'alert alert-warning fin-dup', role: 'status' }, [U.icon('info'), el('div', null, [el('strong', { text: t('dup_possible') }), dupList(state.possible)])]));
        }
        ['supplier_id', 'invoice_number', 'invoice_date', 'total_amount', 'doc_type'].forEach(function (n) {
          if (E[n]) { E[n].addEventListener('change', check); E[n].addEventListener('input', check); }
        });
        E.supplier_id.addEventListener('change', function () { supplierVat(); if (E.doc_type.value !== 'invoice') loadAdjustable(); });
        E.doc_type.addEventListener('change', syncDocType);
        file.input.addEventListener('change', function () {
          var f = file.file();
          state.sha = null;
          var M = (api && api.MarsaApi) || window.MarsaApi;
          if (!f || !M || !M.util || typeof M.util.sha256Hex !== 'function' || typeof f.arrayBuffer !== 'function') { check(); return; }
          Promise.resolve().then(function () { return f.arrayBuffer(); }).then(function (buf) { return M.util.sha256Hex(buf); })
            .then(function (h) { state.sha = /^[0-9a-f]{64}$/.test(h || '') ? h : null; check(); }, function () { check(); });
        });
        syncDocType();
      }
      return p;
    });
  }

  /* ==================================================================
     #costs — supplier-invoice inbox
     ================================================================== */
  var STATUSES = ['received', 'under_review', 'approved', 'disputed', 'void'];
  var PAY_STATUSES = ['unpaid', 'partial', 'paid', 'paid_directly_by_client'];
  var IF = { status: '', payment_status: '', supplier_id: '', branch_id: '', from: '', to: '', q: '', needs_review: false, offset: 0 };
  var PAGE = 50;

  function renderInbox(root, api) {
    var F = Ops.finKit(); if (!F) return noKit(root);
    var U = F.U, el = U.el, t = F.t, sc = U.scope(root);
    var writer = F.branchesFor(api, 'finWrite').length > 0 || F.canAt(api, 'finWrite');
    var suppliers = [];
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'fin-invoices');
    var acts = [U.btn([U.icon('list'), el('span', { text: t('rq_title') })], 'btn-secondary', function () { U.go(api, '#costs/review'); })];
    if (writer) acts.unshift(U.btn([U.icon('plus'), el('span', { text: t('inv_new') })], 'btn-primary', addNew));
    root.appendChild(U.head(t('inv_title'), t('inv_sub'), acts));
    var kpis = el('div', { class: 'adm-tiles ops-kpis fin-kpis', 'aria-live': 'polite' });
    var kpis2 = el('div', { class: 'adm-tiles ops-kpis fin-kpis', 'aria-live': 'polite' });
    var bar = el('div'), body = el('div');
    root.appendChild(kpis); root.appendChild(kpis2); root.appendChild(bar); root.appendChild(body);

    function addNew() {
      newInvoiceDialog(F, api).then(function (res) {
        if (!res || !sc.alive()) return;
        U.toast(api, t('inv_created'), 'success');
        var id = F.idOf(res);
        if (id) U.go(api, '#costs/' + id); else load();
      });
    }
    function filters() {
      var f = { limit: PAGE, offset: IF.offset };
      ['status', 'payment_status', 'supplier_id', 'branch_id', 'from', 'to'].forEach(function (k) { if (IF[k]) f[k] = IF[k]; });
      if (U.nn(IF.q)) f.q = IF.q.trim();
      if (IF.needs_review) f.needs_review = true;
      return f;
    }
    function load() {
      U.loadingInto(body);
      drawBar();
      return Promise.all([U.call(api, 'listSupplierInvoices', filters()), suppliers.length ? null : F.parties(api)]).then(function (res) {
        if (!sc.alive()) return;
        if (res[1]) { suppliers = res[1].rows; drawBar(); }
        var r = res[0];
        U.doneLoading(body);
        if (r.error) { U.clear(kpis); U.clear(kpis2); body.appendChild(U.errorState(api, r.error, load)); return; }
        draw(F.dataOf(r), U.rowsOf(r.data));
      });
    }
    function drawKpis(counts) {
      U.clear(kpis); U.clear(kpis2);
      var bs = (counts && counts.by_status) || {}, bp = (counts && counts.by_payment_status) || {};
      STATUSES.forEach(function (s) {
        kpis.appendChild(U.kpi(F.lab('fin_invoice_status', s), +bs[s] || 0, s === 'disputed' ? 'danger' : s === 'under_review' || s === 'received' ? 'warning' : 'neutral', {
          active: IF.status === s, onClick: function () { IF.status = IF.status === s ? '' : s; IF.offset = 0; load(); }
        }));
      });
      PAY_STATUSES.forEach(function (s) {
        kpis2.appendChild(U.kpi(F.lab('fin_payment_status', s), +bp[s] || 0, s === 'unpaid' ? 'warning' : 'neutral', {
          active: IF.payment_status === s, onClick: function () { IF.payment_status = IF.payment_status === s ? '' : s; IF.offset = 0; load(); }
        }));
      });
    }
    function drawBar(total) {
      U.clear(bar);
      var fl = [
        U.select('status', t('f_status'), [['', t('f_status') + ': ' + t('all')]].concat(STATUSES.map(function (s) { return [s, F.lab('fin_invoice_status', s)]; })), IF.status, function (v) { IF.status = v; IF.offset = 0; load(); }),
        U.select('payment_status', t('f_payment_status'), [['', t('f_payment_status') + ': ' + t('all')]].concat(PAY_STATUSES.map(function (s) { return [s, F.lab('fin_payment_status', s)]; })), IF.payment_status, function (v) { IF.payment_status = v; IF.offset = 0; load(); }),
        U.select('supplier_id', t('f_supplier'), [['', t('f_supplier') + ': ' + t('all')]].concat(suppliers.map(function (p) { return [p.id, U.partyName(p)]; })), IF.supplier_id, function (v) { IF.supplier_id = v; IF.offset = 0; load(); })
      ];
      var bo = F.branchOptions(api, 'finRead', true);
      if (bo.length > 2) fl.push(U.select('branch_id', t('f_branch'), bo, IF.branch_id, function (v) { IF.branch_id = v; IF.offset = 0; load(); }));
      fl.push(F.dateInput('from', t('from'), IF.from, function (v) { IF.from = v; IF.offset = 0; load(); }));
      fl.push(F.dateInput('to', t('to'), IF.to, function (v) { IF.to = v; IF.offset = 0; load(); }));
      var nr = el('input', { type: 'checkbox', checked: IF.needs_review });
      nr.addEventListener('change', function () { IF.needs_review = nr.checked; IF.offset = 0; load(); });
      fl.push(el('label', { class: 'ops-inline-check' }, [nr, el('span', { text: t('f_needs_review') })]));
      var acts = [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })];
      if (IF.status || IF.payment_status || IF.supplier_id || IF.branch_id || IF.from || IF.to || IF.q || IF.needs_review) {
        acts.unshift(U.btn(t('clear_filters'), 'btn-subtle', function () { IF = { status: '', payment_status: '', supplier_id: '', branch_id: '', from: '', to: '', q: '', needs_review: false, offset: 0 }; load(); }));
      }
      bar.appendChild(U.toolbar(U.searchBox(IF.q, t('inv_search'), function (v) { IF.q = v; IF.offset = 0; load(); }), fl, acts, total != null ? t('count_n', { n: total }) : null));
    }
    function draw(d, rows) {
      drawKpis(d.counts);
      var total = d.total != null ? +d.total : rows.length;
      drawBar(total);
      U.clear(body);
      if (!rows.length) {
        var any = IF.status || IF.payment_status || IF.supplier_id || IF.branch_id || IF.from || IF.to || IF.q || IF.needs_review;
        body.appendChild(U.card(null, any ? U.emptyState('search', null, U.t('no_match'), null, true)
          : U.emptyState('inbox', t('inv_empty_title'), t('inv_empty_text'), writer ? [U.btn(t('inv_new'), 'btn-primary', addNew)] : null)));
        return;
      }
      body.appendChild(U.card(null, U.table([t('col_invoice'), t('f_supplier'), t('col_dates'), { label: t('f_total'), num: true }, t('col_lines'), t('f_status'), t('f_payment_status')],
        rows.map(rowNode), { caption: t('inv_title') }), null, { flush: true }));
      var pg = F.pager(total, PAGE, IF.offset, function (o) { IF.offset = o; load(); });
      if (pg) body.appendChild(pg);
    }
    function rowNode(x) {
      var disc = F.nz(x.discrepancy_total);
      var lines = [el('span', { class: 'cell-main', text: t('n_lines', { n: x.line_count || 0 }) })];
      if (+x.pending_lines > 0) lines.push(el('span', { class: 'badge badge-warning badge-sm', text: t('n_pending', { n: x.pending_lines }) }));
      if (x.allocated_pct != null) lines.push(el('span', { class: 'cell-sub', text: t('allocated_pct', { n: Math.round(+x.allocated_pct) }) }));
      if (Math.abs(disc) > 0.004) lines.push(el('span', { class: 'cell-sub fin-text-danger', text: t('disc_short', { amt: F.moneyTxt(disc, x.currency, api) }) }));
      return el('tr', { 'data-id': x.id, class: x.status === 'void' ? 'is-muted' : null }, [
        U.td([F.invLink(x.id, x.invoice_number), el('span', { class: 'cell-sub', text: F.lab('fin_invoice_doc_type', x.doc_type || 'invoice') + (x.reference ? ' · ' + x.reference : '') })]),
        U.td([el('span', { class: 'cell-main', text: F.supplierName(x) }), el('span', { class: 'cell-sub', text: F.branchName(api, x.branch_id) })]),
        U.td([el('span', { text: U.fmtDate(x.invoice_date) }), x.due_date ? el('span', { class: 'cell-sub', text: t('due_on', { d: U.fmtDate(x.due_date) }) }) : null], 'is-nowrap'),
        U.td([F.money(x.total_amount, x.currency, api), el('span', { class: 'cell-sub', text: t('vat_of', { amt: F.moneyTxt(x.vat_amount, x.currency, api) }) })], 'num'),
        U.td(lines),
        U.td(F.pill('fin_invoice_status', x.status, api)),
        U.td(F.pill('fin_payment_status', x.payment_status || 'unpaid', api))
      ]);
    }
    return load();
  }

  /* ==================================================================
     #costs/review — the cost review queue
     ================================================================== */
  var RF = { branch_id: '' };
  function accrualDecisionDialog(F, api, a) {
    var U = F.U, t = F.t;
    var opts = ['accept', 'keep_open'];
    if (a.pending_amount != null) opts = opts.concat(['accept_new_amount', 'keep_amount']);
    return F.noteDialog(api, {
      title: t('acc_review'), intro: t('acc_review_intro', { amt: F.moneyTxt(a.amount, a.currency, api), matched: F.moneyTxt(a.matched_amount, a.currency, api), pending: a.pending_amount != null ? F.moneyTxt(a.pending_amount, a.currency, api) : U.NONE }),
      fields: [{ name: 'decision', label: t('f_decision'), type: 'select', required: true, value: opts[0], options: opts.map(function (o) { return [o, t('acc_dec_' + o)]; }) }],
      submit: function (note, v) { return U.call(api, 'reviewAccrualVariance', a.id, v.decision, note); }
    });
  }
  function adjustmentReviewDialog(F, api, a) {
    var U = F.U, t = F.t;
    return F.noteDialog(api, {
      title: t('adj_review'), intro: F.lab('fin_adjustment_kind', a.kind) + (a.amount != null ? ' · ' + F.moneyTxt(a.amount, a.currency, api) : '') + (a.reason ? ' — ' + a.reason : ''),
      warn: a.kind === 'duplicate_invoice' ? t('adj_dup_warn') : null,
      fields: [{ name: 'decision', label: t('f_decision'), type: 'select', required: true, value: 'approved', options: [['approved', t('dec_approve')], ['rejected', t('dec_reject')]] }],
      submit: function (note, v) { return U.call(api, 'reviewCostAdjustment', a.id, v.decision, note); }
    });
  }
  // approve a set of proposed allocations; a late one needs the note
  function approveAllocs(F, api, list) {
    var U = F.U, t = F.t;
    var late = list.some(function (a) { return a.is_late; });
    return F.noteDialog(api, {
      title: t('alloc_approve_n', { n: list.length }), required: late, hint: late ? t('late_note_hint') : t('alloc_approve_hint'),
      warn: late ? t('late_warn') : null, submitText: t('dec_approve'),
      submit: function (note) { return U.call(api, 'approveAllocations', list.map(function (a) { return a.id; }), note); }
    });
  }
  function renderReview(root, api) {
    var F = Ops.finKit(); if (!F) return noKit(root);
    var U = F.U, el = U.el, t = F.t, sc = U.scope(root);
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'fin-review');
    root.appendChild(el('p', { class: 'ops-back' }, el('a', { href: '#costs' }, [U.icon('chevronStart', 'icon-flip'), el('span', { text: t('back_invoices') })])));
    root.appendChild(U.head(t('rq_title'), t('rq_sub')));
    var kpis = el('div', { class: 'adm-tiles ops-kpis fin-kpis', 'aria-live': 'polite' }), bar = el('div'), body = el('div', { class: 'app-stack' });
    root.appendChild(kpis); root.appendChild(bar); root.appendChild(body);
    function load() {
      U.loadingInto(body);
      drawBar();
      var f = {};
      if (RF.branch_id) f.branch_id = RF.branch_id;
      return U.call(api, 'costReviewQueue', f).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        if (r.error) { U.clear(kpis); body.appendChild(U.errorState(api, r.error, load)); return; }
        draw(F.dataOf(r));
      });
    }
    function drawBar() {
      U.clear(bar);
      var fl = [], bo = F.branchOptions(api, 'finRead', true);
      if (bo.length > 2) fl.push(U.select('branch_id', t('f_branch'), bo, RF.branch_id, function (v) { RF.branch_id = v; load(); }));
      bar.appendChild(U.toolbar(null, fl, [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': t('refresh'), title: t('refresh') })]));
    }
    var SECTIONS = ['lines_pending', 'invoices_discrepancy', 'allocations_proposed', 'accruals_variance', 'adjustments_proposed'];
    function draw(d) {
      U.clear(kpis); U.clear(body);
      var counts = d.counts || {};
      var total = 0;
      SECTIONS.forEach(function (k) {
        var n = counts[k] != null ? +counts[k] : (d[k] || []).length;
        total += n;
        kpis.appendChild(U.kpi(t('rq_' + k), n, n ? 'warning' : 'neutral', { onClick: function () { var c = body.querySelector('[data-rq="' + k + '"]'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }));
      });
      if (!total) { body.appendChild(U.card(null, U.emptyState('check', t('rq_empty_title'), t('rq_empty_text')))); return; }
      SECTIONS.forEach(function (k) {
        var list = d[k] || [];
        if (!list.length) return;
        var c = ({ lines_pending: linesCard, invoices_discrepancy: discCard, allocations_proposed: allocCard, accruals_variance: accrualCard, adjustments_proposed: adjCard })[k](list);
        c.setAttribute('data-rq', k);
        body.appendChild(c);
      });
    }
    function invCell(x) {
      return [F.invLink(x.supplier_invoice_id || x.invoice_id, x.invoice_number), el('span', { class: 'cell-sub', text: F.supplierName(x) })];
    }
    function linesCard(list) {
      return U.card(t('rq_lines_pending') + ' (' + list.length + ')', U.table([t('col_invoice'), '#', t('f_description'), { label: t('f_net'), num: true }, t('col_review'), { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(function (l) {
          return el('tr', null, [U.td(invCell(l)), U.td(U.ltr(String(l.line_no || ''))), U.td([el('span', { class: 'cell-main', text: l.description || U.NONE }), reasonsNode(F, l.review_reasons)]),
            U.td(F.money(l.net_amount, l.currency, api), 'num'), U.td(F.pill('fin_line_review', l.review_status, api)),
            U.td(U.btn(t('open'), 'btn-secondary', function () { U.go(api, '#costs/' + (l.supplier_invoice_id || l.invoice_id)); }), 'ops-col-actions')]);
        }), { caption: t('rq_lines_pending') }), null, { flush: true });
    }
    function discCard(list) {
      return U.card(t('rq_invoices_discrepancy') + ' (' + list.length + ')', U.table([t('col_invoice'), { label: t('disc_net'), num: true }, { label: t('disc_vat'), num: true }, { label: t('disc_total'), num: true }, t('f_status')],
        list.map(function (x) {
          var dsc = x.discrepancy || {};
          return el('tr', null, [U.td([F.invLink(x.id || x.supplier_invoice_id, x.invoice_number), el('span', { class: 'cell-sub', text: F.supplierName(x) })]),
            U.td(F.money(U.pick(dsc, ['net']) != null ? dsc.net : x.discrepancy_net, x.currency, api), 'num'),
            U.td(F.money(dsc.vat != null ? dsc.vat : x.discrepancy_vat, x.currency, api), 'num'),
            U.td(F.money(dsc.total != null ? dsc.total : x.discrepancy_total, x.currency, api), 'num'),
            U.td(F.pill('fin_invoice_status', x.status, api))]);
        }), { caption: t('rq_invoices_discrepancy') }), null, { flush: true });
    }
    function allocCard(list) {
      var picked = {};
      // only rows this user may decide (server flag: approve role at the TRANSACTION's branch + four eyes), so one own /
      // other-branch row never makes the whole bulk approval fail
      var approvable = list.filter(function (a) { return F.rowCan(api, a, 'can_approve', 'finApprove'); });
      var bulkB = U.btn([U.icon('check'), el('span', { text: t('alloc_approve_sel') })], 'btn-primary', function () {
        var sel = list.filter(function (a) { return picked[a.id]; });
        if (!sel.length) { U.toast(api, t('pick_some'), 'warning'); return; }
        approveAllocs(F, api, sel).then(function (res) { if (res && sc.alive()) { U.toast(api, t('alloc_approved'), 'success'); load(); } });
      }, { disabled: true });
      function sync() { bulkB.disabled = !Object.keys(picked).some(function (k) { return picked[k]; }); }
      var all = el('input', { type: 'checkbox', 'aria-label': t('select_all') });
      all.addEventListener('change', function () {
        approvable.forEach(function (a) { picked[a.id] = all.checked; });
        Array.prototype.forEach.call(card.querySelectorAll('input[data-alloc]'), function (c) { c.checked = all.checked; });
        sync();
      });
      var headers = [{ label: '', cls: 'fin-col-check' }, t('tx'), t('col_invoice'), t('f_description'), { label: t('f_amount'), num: true }, t('col_flags'), { label: t('actions'), cls: 'ops-col-actions' }];
      var tbl = U.table(headers, list.map(function (a) {
        var can = approvable.indexOf(a) !== -1;
        var cb = can ? el('input', { type: 'checkbox', 'data-alloc': a.id, 'aria-label': t('select_row') }) : null;
        if (cb) cb.addEventListener('change', function () { picked[a.id] = cb.checked; sync(); });
        var acts = el('div', { class: 'ops-row-actions' });
        if (can) {
          acts.appendChild(U.btn(t('dec_approve'), 'btn-secondary', function () { approveAllocs(F, api, [a]).then(function (res) { if (res && sc.alive()) { U.toast(api, t('alloc_approved'), 'success'); load(); } }); }));
          acts.appendChild(U.btn(t('dec_reject'), 'btn-subtle', function () {
            F.noteDialog(api, { title: t('alloc_reject'), noteLabel: t('reason'), danger: true, submitText: t('dec_reject'), submit: function (note) { return U.call(api, 'rejectAllocation', a.id, note); } })
              .then(function (res) { if (res && sc.alive()) { U.toast(api, t('alloc_rejected'), 'success'); load(); } });
          }));
        }
        return el('tr', { 'data-id': a.id }, [U.td(cb, 'fin-col-check'), U.td(U.txLink(a), 'is-nowrap'), U.td(invCell(a)),
          U.td([el('span', { class: 'cell-main', text: a.line_description || a.description || U.NONE }), a.service_code ? el('span', { class: 'cell-sub', text: F.lab('fin_service', a.service_code) }) : null]),
          U.td(F.money(a.amount, a.currency, api), 'num'),
          U.td([a.is_late ? el('span', { class: 'badge badge-danger badge-sm', text: t('late') }) : null, a.accrual_id ? el('span', { class: 'badge badge-blue badge-sm', text: t('matches_accrual') }) : null].filter(Boolean)),
          U.td(acts, 'ops-col-actions')]);
      }), { caption: t('rq_allocations_proposed') });
      var thFirst = tbl.querySelector('thead th');
      if (thFirst && approvable.length) thFirst.appendChild(all);
      var card = U.card(t('rq_allocations_proposed') + ' (' + list.length + ')', tbl, approvable.length ? [bulkB] : null, { flush: true, sub: t('four_eyes_hint') });
      return card;
    }
    function accrualCard(list) {
      return U.card(t('rq_accruals_variance') + ' (' + list.length + ')', U.table([t('tx'), t('f_source'), { label: t('acc_expected'), num: true }, { label: t('acc_matched'), num: true }, { label: t('acc_pending'), num: true }, t('col_reason'), { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(function (a) {
          var can = F.rowCan(api, a, 'can_review', 'finApprove');
          return el('tr', null, [U.td(U.txLink(a), 'is-nowrap'), U.td([el('span', { text: F.lab('fin_accrual_source', a.source) }), a.supplier_name ? el('span', { class: 'cell-sub', text: a.supplier_name }) : null]),
            U.td(F.money(a.amount, a.currency, api), 'num'), U.td(F.money(a.matched_amount, a.currency, api), 'num'), U.td(F.money(a.pending_amount, a.currency, api), 'num'),
            U.td([F.pill('fin_accrual_status', a.status, api), a.variance_reason ? el('span', { class: 'cell-sub', text: F.lab('fin_variance_reason', a.variance_reason) }) : null]),
            U.td(can ? U.btn(t('review'), 'btn-secondary', function () { accrualDecisionDialog(F, api, a).then(function (res) { if (res && sc.alive()) { U.toast(api, t('saved'), 'success'); load(); } }); }) : null, 'ops-col-actions')]);
        }), { caption: t('rq_accruals_variance') }), null, { flush: true });
    }
    function adjCard(list) {
      return U.card(t('rq_adjustments_proposed') + ' (' + list.length + ')', U.table([t('f_kind'), t('tx'), t('col_invoice'), { label: t('f_amount'), num: true }, t('reason'), { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(function (a) {
          var can = F.rowCan(api, a, 'can_review', 'finApprove');
          return el('tr', null, [U.td(F.lab('fin_adjustment_kind', a.kind)), U.td(a.transaction_id ? U.txLink(a) : null, 'is-nowrap'), U.td(a.supplier_invoice_id ? F.invLink(a.supplier_invoice_id, a.invoice_number) : null),
            U.td(F.money(a.amount, a.currency, api), 'num'), U.td(el('span', { class: 'ops-reason', text: a.reason || U.NONE })),
            U.td(can ? U.btn(t('review'), 'btn-secondary', function () { adjustmentReviewDialog(F, api, a).then(function (res) { if (res && sc.alive()) { U.toast(api, t('saved'), 'success'); load(); } }); }) : null, 'ops-col-actions')]);
        }), { caption: t('rq_adjustments_proposed') }), null, { flush: true });
    }
    return load();
  }
  function reasonsNode(F, reasons) {
    var U = F.U;
    if (!reasons || !reasons.length) return null;
    return U.el('span', { class: 'fin-reasons' }, reasons.map(function (r) { return U.el('span', { class: 'badge badge-warning badge-sm', text: F.lab('fin_review_reason', r) }); }));
  }

  /* ==================================================================
     #costs/<id> — invoice detail
     ================================================================== */
  var EDITABLE = ['received', 'under_review', 'disputed'];
  var NEXT = { received: ['under_review', 'disputed', 'void'], under_review: ['approved', 'disputed', 'void'], disputed: ['under_review', 'void'], approved: ['disputed'] };
  var ADJ_KINDS = ['late_cost', 'empty_fee', 'washing', 'repair', 'amendment', 'duplicate_invoice', 'other'];

  function renderDetail(root, api, id) {
    var F = Ops.finKit(); if (!F) return noKit(root);
    var U = F.U, el = U.el, t = F.t, sc = U.scope(root);
    var D = null;
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'fin-invoice');
    root.appendChild(el('p', { class: 'ops-back' }, el('a', { href: '#costs' }, [U.icon('chevronStart', 'icon-flip'), el('span', { text: t('back_invoices') })])));
    var headBox = el('div'), body = el('div', { class: 'app-stack' });
    root.appendChild(headBox); root.appendChild(body);

    function load() {
      U.loadingInto(body);
      return U.call(api, 'getSupplierInvoice', id).then(function (r) {
        if (!sc.alive()) return;
        U.doneLoading(body);
        U.clear(headBox);
        if (r.error) {
          if (U.errCode(r.error) === 'MRS_NOT_FOUND') { body.appendChild(U.card(null, U.emptyState('search', null, t('inv_not_found'), [U.btn(t('back_invoices'), 'btn-secondary', function () { U.go(api, '#costs'); })]))); return; }
          body.appendChild(U.errorState(api, r.error, load)); return;
        }
        D = F.dataOf(r);
        if (!D.invoice) { body.appendChild(U.card(null, U.emptyState('search', null, t('inv_not_found')))); return; }
        draw();
      });
    }
    function done(msg) { return function (res) { if (res && sc.alive()) { U.toast(api, msg || t('saved'), 'success'); load(); } }; }
    function draw() {
      var inv = D.invoice, cur = inv.currency || 'SAR', can = D.can || {};
      // the role check and the server's can{} both have to allow a button (either one hides it)
      var writer = F.canAt(api, 'finWrite', inv.branch_id), approver = F.canAt(api, 'finApprove', inv.branch_id);
      var w = writer && can.edit !== false && EDITABLE.indexOf(inv.status) !== -1;
      var acts = [];
      (NEXT[inv.status] || []).forEach(function (s) {
        var needApprove = s === 'approved' || s === 'void';
        if (needApprove ? !approver : !writer) return;
        if (s === 'approved' && can.approve === false) return;
        if (s === 'void' && can.void === false) return;
        acts.push(U.btn(t('to_' + s), s === 'approved' ? 'btn-primary' : s === 'void' ? 'btn-subtle' : 'btn-secondary', function () { statusDialog(s); }));
      });
      var canPay = writer && can.pay !== false && inv.status !== 'void' && inv.doc_type !== 'credit_note' && inv.payment_status !== 'paid' && inv.payment_status !== 'paid_directly_by_client';
      if (canPay) acts.push(U.btn([U.icon('plus'), el('span', { text: t('pay_record') })], 'btn-secondary', function () { F.paymentDialog(api, inv).then(done(t('pay_recorded'))); }));
      var sub = F.supplierName(Object.assign({ supplier: D.supplier }, inv));
      headBox.appendChild(U.head(t('inv_detail_title', { no: inv.invoice_number || '' }), sub, acts));
      // banners
      var disc = D.discrepancy || {};
      var dn = F.nz(disc.net), dv = F.nz(disc.vat), dt = F.nz(disc.total);
      if (Math.abs(dn) > 0.004 || Math.abs(dv) > 0.004 || Math.abs(dt) > 0.004) {
        body.appendChild(el('div', { class: 'alert alert-danger fin-disc', role: 'alert' }, [U.icon('alert'), el('div', null, [
          el('strong', { text: t('disc_title') }),
          el('div', { class: 'fin-disc-figs' }, [discFig(t('disc_net'), dn, cur), discFig(t('disc_vat'), dv, cur), discFig(t('disc_total'), dt, cur)]),
          el('p', { class: 'text-xs', text: inv.discrepancy_note ? t('disc_note_saved', { note: inv.discrepancy_note }) : t('disc_hint') })
        ])]));
      }
      var pd = D.possible_duplicates || [];
      if (pd.length) {
        body.appendChild(el('div', { class: 'alert alert-warning fin-dup', role: 'status' }, [U.icon('info'), el('div', null, [el('strong', { text: t('dup_possible') }),
          el('ul', { class: 'fin-dup-list' }, pd.map(function (x) { return el('li', null, [F.invLink(x.id, x.invoice_number), x.status ? ' ' : null, x.status ? F.pill('fin_invoice_status', x.status, api) : null, x.total_amount != null ? el('span', { class: 'text-xs text-muted', text: ' ' + F.moneyTxt(x.total_amount, x.currency, api) }) : null]); })),
          writer && inv.status !== 'void' ? el('p', { class: 'text-xs', text: t('dup_how') }) : null])]));
      }
      if (inv.status === 'void') body.appendChild(U.alertBox('info', t('inv_void_note', { reason: inv.void_reason || inv.status_note || U.NONE })));
      body.appendChild(headerCard(inv, w));
      body.appendChild(linesCard(inv, w));
      body.appendChild(el('div', { class: 'app-grid-2' }, [paymentsCard(inv, approver), adjustmentsCard(inv, writer)]));
    }
    function discFig(label, v, cur) {
      return el('span', { class: 'fin-disc-fig' + (Math.abs(v) > 0.004 ? ' is-off' : '') }, [el('span', { class: 'text-xs', text: label }), F.money(v, cur, api)]);
    }
    function headerCard(inv, w) {
      var cur = inv.currency || 'SAR';
      var docPath = U.pick(inv, ['finance_document.storage_path', 'finance_document_path', 'original_path']) || U.pick(D, ['finance_document.storage_path', 'original.storage_path']);
      var srcPath = U.pick(inv, ['source_document.storage_path', 'source_document_path']);
      var fileNode = docPath ? F.fileLink(api, docPath, 'finance') : srcPath ? F.fileLink(api, srcPath, 'documents', t('open_source_doc'))
        : (inv.finance_document_id || inv.source_document_id) ? el('span', { class: 'badge badge-success', text: t('original_attached') }) : el('span', { class: 'badge badge-danger', text: t('original_missing') });
      var acts = [];
      if (w) {
        acts.push(U.btn(t('edit'), 'btn-secondary', function () { editHeader(inv); }));
        if (!inv.finance_document_id && !inv.source_document_id) acts.push(U.btn([U.icon('file'), el('span', { text: t('attach_original') })], 'btn-secondary', function () { attachOriginal(inv); }));
      }
      return U.card(t('inv_header'), el('div', { class: 'app-grid-2' }, [
        F.dl([
          [t('f_status'), F.pill('fin_invoice_status', inv.status, api)],
          [t('f_payment_status'), F.pill('fin_payment_status', inv.payment_status || 'unpaid', api)],
          [t('f_doc_type'), F.lab('fin_invoice_doc_type', inv.doc_type || 'invoice')],
          inv.adjusts_invoice_id ? [t('f_adjusts'), F.invLink(inv.adjusts_invoice_id, U.pick(inv, ['adjusts_invoice_number']))] : null,
          [t('f_invoice_number'), U.ltr(inv.invoice_number)],
          [t('f_invoice_date'), U.fmtDate(inv.invoice_date)],
          [t('f_due_date'), inv.due_date ? U.dueNode(inv.due_date, inv.payment_status === 'paid' || inv.payment_status === 'paid_directly_by_client') : null],
          [t('f_branch'), F.branchName(api, inv.branch_id)],
          [t('f_inv_reference'), inv.reference ? U.ltr(inv.reference) : null],
          [t('f_supplier_vat'), inv.supplier_vat_number ? U.ltr(inv.supplier_vat_number) : null],
          [t('inv_original'), fileNode],
          inv.duplicate_of_id ? [t('duplicate_of'), F.invLink(inv.duplicate_of_id)] : null,
          [t('f_notes'), inv.notes ? el('span', { class: 'ops-pre', text: inv.notes }) : null]
        ]),
        el('ul', { class: 'kv fin-kv' }, [
          kv(t('f_subtotal'), F.money(inv.subtotal, cur, api)), kv(t('f_vat_total'), F.money(inv.vat_amount, cur, api)),
          kv(t('f_total'), F.money(inv.total_amount, cur, api), 'total'),
          kv(t('paid_company'), F.money(inv.company_paid_amount || 0, cur, api)), kv(t('paid_client'), F.money(inv.client_paid_amount || 0, cur, api)),
          kv(t('pay_remaining_lbl'), F.money(F.r2(F.nz(inv.total_amount) - F.nz(inv.company_paid_amount) - F.nz(inv.client_paid_amount)), cur, api))
        ])
      ]), acts);
    }
    function kv(k, v, cls) { return el('li', null, [el('span', { class: 'k', text: k }), el('span', { class: 'v' + (cls ? ' ' + cls : '') }, v)]); }
    function editHeader(inv) {
      U.formModal({
        title: t('inv_edit'), size: 'lg',
        fields: [
          { name: 'invoice_number', label: t('f_invoice_number'), required: true, max: 60, ltr: true, value: inv.invoice_number },
          { name: 'invoice_date', label: t('f_invoice_date'), type: 'date', required: true, value: inv.invoice_date },
          { name: 'due_date', label: t('f_due_date'), type: 'date', value: inv.due_date },
          { name: 'currency', label: t('f_currency'), type: 'select', required: true, value: inv.currency || 'SAR', options: F.currencyOptions([inv.currency]) },
          { name: 'subtotal', label: t('f_subtotal'), required: true, ltr: true, inputmode: 'decimal', pattern: MONEY_RE, patternMsg: t('money_invalid'), value: F.amountStr(inv.subtotal) },
          { name: 'vat_amount', label: t('f_vat_total'), required: true, ltr: true, inputmode: 'decimal', pattern: MONEY_RE, patternMsg: t('money_invalid'), value: F.amountStr(inv.vat_amount) },
          { name: 'total_amount', label: t('f_total'), required: true, ltr: true, inputmode: 'decimal', pattern: MONEY_RE, patternMsg: t('money_invalid'), value: F.amountStr(inv.total_amount) },
          { name: 'reference', label: t('f_inv_reference'), max: 120, ltr: true, value: inv.reference },
          { name: 'supplier_vat_number', label: t('f_supplier_vat'), max: 15, ltr: true, pattern: /^[0-9]{15}$/, patternMsg: t('vat_no_invalid'), value: inv.supplier_vat_number },
          { name: 'notes', label: t('f_notes'), type: 'textarea', max: 2000, rows: 2, value: inv.notes }
        ],
        validate: function (v) {
          var bad = {};
          if (v.due_date && v.due_date < v.invoice_date) bad.due_date = t('due_before_date');
          if (Math.abs(F.r2(F.num(v.subtotal) + F.num(v.vat_amount)) - F.num(v.total_amount)) > 0.004) bad.total_amount = t('total_mismatch');
          return bad;
        },
        submit: function (v) {
          return U.call(api, 'updateSupplierInvoice', inv.id, { invoice_number: v.invoice_number, invoice_date: v.invoice_date, due_date: v.due_date || null, currency: v.currency,
            subtotal: F.r2(F.num(v.subtotal)), vat_amount: F.r2(F.num(v.vat_amount)), total_amount: F.r2(F.num(v.total_amount)),
            reference: U.nn(v.reference), supplier_vat_number: U.nn(v.supplier_vat_number), notes: U.nn(v.notes) });
        }
      }).then(done());
    }
    function attachOriginal(inv) {
      var up = F.uploader(api), file = F.fileField(t('inv_original'), t('inv_original_hint'));
      var intro = U.el('div', null, [file.node]);
      U.formModal({
        title: t('attach_original'), size: 'sm', intro: intro, submitText: t('upload'), fields: [],
        validate: function () { return file.file() ? null : { _f: t('pick_file') }; },
        submit: function () {
          return up(file.file(), inv.branch_id, inv.doc_type === 'credit_note' ? 'credit_note' : 'supplier_invoice').then(function (u) {
            if (u.error) return u;
            return U.call(api, 'updateSupplierInvoice', inv.id, { finance_document_id: u.data.id });
          });
        }
      }).then(done());
    }
    function statusDialog(s) {
      var inv = D.invoice, disc = D.discrepancy || {};
      var off = [disc.net, disc.vat, disc.total].some(function (x) { return Math.abs(F.nz(x)) > 0.004; });
      var needNote = s === 'void' || (s === 'disputed' && inv.status === 'approved') || (s === 'approved' && off);
      var warn = s === 'approved' ? (off ? t('approve_disc_warn') : t('approve_warn')) : s === 'void' ? t('void_warn') : s === 'disputed' && inv.status === 'approved' ? t('dispute_approved_warn') : null;
      F.noteDialog(api, {
        title: t('to_' + s), intro: t('status_from_to', { from: F.lab('fin_invoice_status', inv.status), to: F.lab('fin_invoice_status', s) }), warn: warn,
        required: needNote, danger: s === 'void', submitText: t('to_' + s), hint: s === 'approved' && off ? t('disc_note_hint') : null,
        submit: function (note) { return U.call(api, 'setSupplierInvoiceStatus', inv.id, s, note); }
      }).then(done(t('status_changed')));
    }

    // --- lines ------------------------------------------------------------------
    function liveAllocs(l) { return (l.allocations || []).filter(function (a) { return a.status === 'proposed' || a.status === 'approved'; }); }
    function allocatedOf(l) { return F.r2(liveAllocs(l).reduce(function (s, a) { return s + F.nz(a.amount); }, 0)); }
    function linesCard(inv, w) {
      var cur = inv.currency || 'SAR', lines = D.lines || [];
      var writer = F.canAt(api, 'finWrite', inv.branch_id);
      var acts = w ? [U.btn([U.icon('plus'), el('span', { text: t('lines_add') })], 'btn-secondary', function () { addLines(inv); })] : [];
      if (!lines.length) return U.card(t('inv_lines'), U.emptyState('list', null, t('lines_empty'), null, true), acts);
      var trs = [];
      lines.slice().sort(function (a, b) { return (a.line_no || 0) - (b.line_no || 0); }).forEach(function (l) {
        var allocated = allocatedOf(l), net = F.nz(l.net_amount);
        var la = el('div', { class: 'ops-row-actions' });
        if (writer && inv.status !== 'void' && inv.status !== 'approved') la.appendChild(U.btn(t('review'), 'btn-secondary', function () { reviewLine(l); }));
        if (writer && l.review_status === 'ok' && inv.status !== 'void' && inv.status !== 'approved' && F.r2(net - allocated) > 0) la.appendChild(U.btn(t('allocate'), 'btn-primary', function () { allocateDialog(inv, l); }));
        if (w && !liveAllocs(l).length) la.appendChild(U.btn(t('edit'), 'btn-subtle', function () { editLine(l, inv); }));
        trs.push(el('tr', { 'data-id': l.id, class: 'fin-line fin-line-' + (l.review_status || 'ok') }, [
          U.td(U.ltr(String(l.line_no || ''))),
          U.td([el('span', { class: 'cell-main', text: l.description || U.NONE }),
            el('span', { class: 'cell-sub', text: [l.service_code ? F.lab('fin_service', l.service_code) : t('service_none'), l.container_no_hint, l.reference_hint].filter(Boolean).join(' · ') }),
            reasonsNode(F, l.review_reasons), l.review_note ? el('span', { class: 'cell-sub ops-note', text: l.review_note }) : null,
            l.source && l.source !== 'manual' ? el('span', { class: 'badge badge-blue badge-sm', text: F.lab('fin_line_source', l.source) }) : null]),
          U.td([el('bdi', { dir: 'ltr', class: 'num', text: String(l.quantity == null ? 1 : +l.quantity) + (l.unit ? ' ' + l.unit : '') }), l.unit_price != null ? el('span', { class: 'cell-sub', text: '× ' + F.moneyTxt(l.unit_price, cur, api) }) : null], 'num'),
          U.td(F.money(l.net_amount, cur, api), 'num'),
          U.td([F.money(l.vat_amount, cur, api), el('span', { class: 'cell-sub', text: (l.vat_rate != null ? +l.vat_rate : 15) + '%' })], 'num'),
          U.td(F.money(l.total_amount, cur, api), 'num'),
          U.td(F.pill('fin_line_review', l.review_status, api)),
          U.td(l.review_status === 'ok' || allocated > 0 ? F.meter(allocated, net, cur, api) : null, 'fin-col-meter'),
          U.td(la, 'ops-col-actions')
        ]));
        (l.allocations || []).forEach(function (a) { trs.push(allocRow(a, cur, inv)); });
      });
      var tbl = U.table(['#', t('f_description'), { label: t('f_qty'), num: true }, { label: t('f_net'), num: true }, { label: t('f_vat_amount'), num: true }, { label: t('f_total'), num: true }, t('col_review'), t('col_allocation'), { label: t('actions'), cls: 'ops-col-actions' }],
        trs, { caption: t('inv_lines') });
      return U.card(t('inv_lines') + ' (' + lines.length + ')', [tbl, el('p', { class: 'form-hint fin-card-note', text: t('lines_rule') })], acts, { flush: true });
    }
    function allocRow(a, cur, inv) {
      var bid = a.transaction_branch_id || a.branch_id;
      var decider = F.rowCan(api, a, 'can_approve', 'finApprove');          // approve / reject: tx branch + four eyes
      var approver = !!bid && F.canAt(api, 'finApprove', bid);               // reverse: approve role at the tx branch
      var acts = el('div', { class: 'ops-row-actions' });
      if (a.status === 'proposed' && !decider && approver) acts.appendChild(el('span', { class: 'form-hint', text: t('four_eyes_hint') }));
      if (decider && a.status === 'proposed') {
        acts.appendChild(U.btn(t('dec_approve'), 'btn-secondary', function () { approveAllocs(F, api, [a]).then(done(t('alloc_approved'))); }));
        acts.appendChild(U.btn(t('dec_reject'), 'btn-subtle', function () {
          F.noteDialog(api, { title: t('alloc_reject'), noteLabel: t('reason'), danger: true, submitText: t('dec_reject'), submit: function (note) { return U.call(api, 'rejectAllocation', a.id, note); } }).then(done(t('alloc_rejected')));
        }));
      }
      if (approver && a.status === 'approved' && inv.status !== 'approved') {
        acts.appendChild(U.btn(t('alloc_reverse'), 'btn-subtle', function () {
          F.noteDialog(api, { title: t('alloc_reverse'), noteLabel: t('reason'), danger: true, warn: t('reverse_warn'), submitText: t('alloc_reverse'), submit: function (note) { return U.call(api, 'reverseAllocation', a.id, note); } }).then(done(t('alloc_reversed')));
        }));
      }
      var target = [a.container_no ? t('container') + ' ' + a.container_no : null, a.trip_id ? t('trip') + (a.leg_no ? ' ' + a.leg_no : '') : null,
        a.demurrage_case_id ? t('demurrage_case') : null, a.accrual_id ? t('matches_accrual') : null].filter(Boolean).join(' · ');
      return el('tr', { class: 'fin-alloc-row' + (a.status === 'rejected' || a.status === 'reversed' ? ' is-muted' : ''), 'data-alloc': a.id }, [
        el('td'),
        el('td', { colspan: '2' }, [el('span', { class: 'fin-alloc-arrow', 'aria-hidden': 'true', text: '↳ ' }), U.txLink(a), target ? el('span', { class: 'cell-sub', text: target }) : null,
          a.is_late ? el('span', { class: 'badge badge-danger badge-sm', text: t('late') }) : null,
          a.reverse_reason || a.decision_note ? el('span', { class: 'cell-sub ops-note', text: a.reverse_reason || a.decision_note }) : null]),
        el('td', { class: 'num' }, [F.money(a.amount, cur, api), a.share_pct != null ? el('span', { class: 'cell-sub', text: (+a.share_pct) + '%' }) : null]),
        el('td', { colspan: '2' }, a.service_code ? el('span', { class: 'cell-sub', text: F.lab('fin_service', a.service_code) }) : null),
        el('td', null, F.pill('fin_alloc_status', a.status, api)),
        el('td'),
        el('td', { class: 'ops-col-actions' }, acts)
      ]);
    }
    function addLines(inv) {
      var cur = function () { return inv.currency || 'SAR'; };
      var ed = linesEditor(F, api, cur), manualDone = false;
      var savedNote = el('p', { class: 'alert alert-info', role: 'status', hidden: true, text: t('lines_manual_saved') });
      var intro = el('div', null, [el('p', { class: 'form-hint', text: t('lines_add_hint') }), savedNote, ed.node]);
      U.formModal({
        title: t('lines_add'), size: 'lg', intro: intro, fields: [], submitText: t('save'),
        validate: function () { var m = ed.validate(); if (m) return { _l: m }; return ed.count() ? null : { _l: t('lines_none') }; },
        submit: function () {
          var manual = manualDone ? [] : ed.payload('manual'), ocr = ed.payload('ocr');
          var s1 = 'fin-lines-m-' + inv.id, s2 = 'fin-lines-o-' + inv.id;
          var p1 = manual.length ? U.call(api, 'addInvoiceLines', inv.id, manual, 'manual', { idemKey: U.idemKey(api, s1, manual) }).then(function (r) {
            U.idemSettle(s1, r.error);
            // saved: a retry after an OCR-batch error sends only the OCR rows (lines are never deleted)
            if (!r.error && r.data) { manualDone = true; savedNote.hidden = false; }
            return r;
          }) : Promise.resolve({ data: true, error: null });
          return p1.then(function (r) {
            if (r.error || !ocr.length) return r;
            return U.call(api, 'addInvoiceLines', inv.id, ocr, 'ocr', { idemKey: U.idemKey(api, s2, ocr) }).then(function (r2) { U.idemSettle(s2, r2.error); return r2; });
          });
        }
      }).then(done(t('lines_added')));
    }
    function editLine(l, inv) {
      U.formModal({
        title: t('line_edit', { n: l.line_no || '' }), size: 'lg',
        fields: [
          { name: 'description', label: t('f_description'), required: true, max: 500, value: l.description, full: true },
          { name: 'service_code', label: t('f_service'), type: 'select', value: l.service_code || '', options: F.serviceOptions(true) },
          { name: 'quantity', label: t('f_qty'), required: true, ltr: true, pattern: QTY_RE, patternMsg: t('qty_invalid'), value: l.quantity == null ? '1' : String(+l.quantity) },
          { name: 'unit_price', label: t('f_unit_price'), ltr: true, pattern: MONEY_RE, patternMsg: t('money_invalid'), value: F.amountStr(l.unit_price) },
          { name: 'net_amount', label: t('f_net'), required: true, ltr: true, pattern: MONEY_RE, patternMsg: t('money_invalid'), value: F.amountStr(l.net_amount) },
          { name: 'vat_rate', label: t('f_vat_rate'), required: true, ltr: true, pattern: PCT_RE, patternMsg: t('pct_invalid'), value: l.vat_rate == null ? '15' : String(+l.vat_rate) },
          { name: 'vat_amount', label: t('f_vat_amount'), required: true, ltr: true, pattern: MONEY_RE, patternMsg: t('money_invalid'), value: F.amountStr(l.vat_amount) },
          { name: 'container_no_hint', label: t('f_container_hint'), max: 20, ltr: true, value: l.container_no_hint },
          { name: 'reference_hint', label: t('f_reference_hint'), max: 120, ltr: true, value: l.reference_hint }
        ],
        validate: function (v) { return F.num(v.vat_rate) > 100 ? { vat_rate: t('pct_invalid') } : null; },
        submit: function (v) {
          var p = F.num(v.unit_price);
          return U.call(api, 'updateInvoiceLine', l.id, { description: v.description, service_code: v.service_code || null, quantity: F.num(v.quantity),
            unit_price: p == null ? null : F.r2(p), net_amount: F.r2(F.num(v.net_amount)), vat_rate: F.num(v.vat_rate), vat_amount: F.r2(F.num(v.vat_amount)),
            container_no_hint: U.nn(v.container_no_hint), reference_hint: U.nn(v.reference_hint) });
        }
      }).then(done());
    }
    function reviewLine(l) {
      var opts = ['ok', 'overhead', 'excluded', 'disputed'];
      U.formModal({
        title: t('line_review', { n: l.line_no || '' }), size: 'sm', intro: (l.description || U.NONE) + ' — ' + F.moneyTxt(l.net_amount, D.invoice.currency, api),
        fields: [
          { name: 'decision', label: t('f_decision'), type: 'select', required: true, value: l.review_status === 'pending_review' ? 'ok' : l.review_status, options: opts.map(function (o) { return [o, F.lab('fin_line_review', o)]; }), hint: t('review_hint') },
          { name: 'service_code', label: t('f_service'), type: 'select', value: l.service_code || '', options: F.serviceOptions(true) },
          { name: 'note', label: t('note'), type: 'textarea', max: 2000, rows: 3, hint: t('review_note_hint') }
        ],
        validate: function (v) {
          var bad = {};
          if (v.decision !== 'ok' && !U.nn(v.note)) bad.note = t('note_required');
          if (v.decision === 'ok' && !v.service_code) bad.service_code = t('service_required_ok');
          return bad;
        },
        submit: function (v) { return U.call(api, 'reviewInvoiceLine', l.id, v.decision, U.nn(v.note), v.service_code || null); }
      }).then(done(t('line_reviewed')));
    }

    // --- allocation dialog --------------------------------------------------------
    function allocateDialog(inv, l) {
      var cur = inv.currency || 'SAR', net = F.nz(l.net_amount), already = allocatedOf(l);
      var free = F.r2(net - already);
      var targets = [];
      var mode = 'amount';
      var listBox = el('div', { class: 'fin-targets' });
      var remain = el('div', { class: 'fin-remaining', 'aria-live': 'polite' });
      var modeSel = F.selectEl('mode', t('alloc_mode'), [['amount', t('alloc_by_amount')], ['share', t('alloc_by_share')]], mode);
      modeSel.addEventListener('change', function () { mode = modeSel.value; drawTargets(); });
      var finder = F.txFinder(api, function (tx) { addTarget(tx); });
      function addTarget(tx) {
        if (targets.some(function (x) { return x.tx.id === tx.id; }) && targets.length) { /* the same tx twice is allowed (other container / trip) */ }
        var tg = { tx: tx, container_id: '', trip_id: '', demurrage_case_id: '', accrual_id: '', amount: targets.length ? '' : F.amountStr(free), pct: targets.length ? '' : '100', service: l.service_code || '', note: '',
          containers: null, trips: null, costs: null, err: null };
        targets.push(tg);
        drawTargets();
        Promise.all([U.call(api, 'listContainers', tx.id), U.call(api, 'listTrips', { txId: tx.id, limit: 200 }), U.call(api, 'txCosts', tx.id)]).then(function (res) {
          tg.containers = res[0].error ? [] : U.rowsOf(res[0].data);
          tg.trips = res[1].error ? [] : U.rowsOf(res[1].data).filter(function (x) { return x.status !== 'cancelled'; });
          tg.costs = res[2].error ? {} : F.dataOf(res[2]);
          // one open expected cost of this supplier in the invoice currency → preselected (never counted twice)
          var cand = (tg.costs.accruals || []).filter(function (a) {
            return a.status === 'open' && a.supplier_id === inv.supplier_id && (a.currency || 'SAR') === cur
              && (a.amount == null || +a.amount > +(a.matched_amount || 0));
          });
          if (!tg.accrual_id && cand.length === 1 && inv.doc_type !== 'credit_note') {
            tg.accrual_id = cand[0].id; tg.trip_id = cand[0].trip_id || ''; tg.demurrage_case_id = cand[0].demurrage_case_id || '';
            if (cand[0].container_id) tg.container_id = cand[0].container_id;
          }
          tg.err = res[2].error || null;
          drawTargets();
        });
      }
      function amountOf(tg) {
        if (mode === 'amount') return F.num(tg.amount);
        return null;
      }
      // share mode: largest remainder over the line net, so 100 % = net exactly (the server recomputes)
      function shareAmounts() {
        var cents = Math.round(net * 100), parts = targets.map(function (tg) { var p = F.num(tg.pct); return p == null || isNaN(p) ? 0 : p; });
        var raw = parts.map(function (p) { return cents * p / 100; }), base = raw.map(Math.floor);
        var sumP = parts.reduce(function (s, p) { return s + p; }, 0);
        var target = sumP >= 100 - 1e-9 ? cents : Math.round(cents * sumP / 100);
        var left = target - base.reduce(function (s, b) { return s + b; }, 0);
        raw.map(function (r, i) { return { i: i, f: r - base[i] }; }).sort(function (a, b) { return b.f - a.f; }).forEach(function (x) { if (left > 0) { base[x.i]++; left--; } });
        return base.map(function (c) { return c / 100; });
      }
      function totals() {
        if (mode === 'share') {
          var am = shareAmounts();
          return { sum: F.r2(am.reduce(function (s, a) { return s + a; }, 0)), pct: targets.reduce(function (s, tg) { return s + F.nz(F.num(tg.pct)); }, 0), amounts: am };
        }
        return { sum: F.r2(targets.reduce(function (s, tg) { return s + F.nz(amountOf(tg)); }, 0)) };
      }
      function drawRemain() {
        U.clear(remain);
        var tt = totals(), left = F.r2(free - tt.sum);
        remain.appendChild(F.meter(already + tt.sum, net, cur, api));
        remain.appendChild(el('p', { class: 'text-xs ' + (left < 0 ? 'fin-text-danger' : 'text-muted'), text: t('alloc_live', { line: F.moneyTxt(net, cur, api), before: F.moneyTxt(already, cur, api), now: F.moneyTxt(tt.sum, cur, api), left: F.moneyTxt(left, cur, api) }) }));
        if (mode === 'share' && tt.pct > 100) remain.appendChild(el('p', { class: 'form-error', text: t('share_over') }));
      }
      function drawTargets() {
        U.clear(listBox);
        if (!targets.length) { listBox.appendChild(el('p', { class: 'text-sm text-muted', text: t('alloc_pick_tx') })); drawRemain(); return; }
        var am = mode === 'share' ? shareAmounts() : null;
        targets.forEach(function (tg, i) {
          var box = el('fieldset', { class: 'fin-target' }, [el('legend', null, [t('tx') + ' ', el('bdi', { dir: 'ltr', text: tg.tx.ref || String(tg.tx.id).slice(0, 8) })])]);
          if (!tg.containers) { box.appendChild(U.skeleton()); listBox.appendChild(box); return; }
          var grid = el('div', { class: 'ops-form-grid' });
          var cSel = F.selectEl('container_id', t('container'), [['', U.NONE]].concat(tg.containers.map(function (c) { return [c.id, c.container_no || String(c.id).slice(0, 8)]; })), tg.container_id);
          cSel.addEventListener('change', function () { tg.container_id = cSel.value; });
          var tSel = F.selectEl('trip_id', t('trip'), [['', U.NONE]].concat(tg.trips.map(function (x) { return [x.id, t('trip_leg', { n: x.leg_no || '?' }) + (x.origin || x.destination ? ' · ' + (x.origin || '') + ' → ' + (x.destination || '') : '')]; })), tg.trip_id);
          tSel.addEventListener('change', function () { tg.trip_id = tSel.value; });
          var cases = (tg.costs.demurrage || []).filter(function (c) { return c.status !== 'void'; });
          var dSel = F.selectEl('demurrage_case_id', t('demurrage_case'), [['', U.NONE]].concat(cases.map(function (c) { return [c.id, F.lab('fin_demurrage_kind', c.kind) + (c.container_no ? ' · ' + c.container_no : '')]; })), tg.demurrage_case_id);
          dSel.addEventListener('change', function () { tg.demurrage_case_id = dSel.value; });
          var accs = (tg.costs.accruals || []).filter(function (a) { return a.status === 'open' || a.status === 'variance'; });
          // '' = automatic (the server matches the single open expected cost of this supplier), 'none' = explicitly no match
          var aSel = F.selectEl('accrual_id', t('match_accrual'), [['', t('accrual_auto')], ['none', t('no_accrual')]].concat(accs.map(function (a) {
            var bad = a.currency && a.currency !== cur;
            return [a.id, F.lab('fin_accrual_source', a.source) + ' · ' + (a.amount == null ? t('amount_unknown') : F.moneyTxt(a.amount, a.currency, api)) + (a.supplier_name ? ' · ' + a.supplier_name : '') + (bad ? ' · ' + t('other_currency') : '')];
          })), tg.accrual_id);
          aSel.addEventListener('change', function () {
            tg.accrual_id = aSel.value;
            var a = accs.filter(function (x) { return x.id === aSel.value; })[0];
            if (a) {
              if (a.trip_id) { tg.trip_id = a.trip_id; tSel.value = a.trip_id; }
              if (a.container_id) { tg.container_id = a.container_id; cSel.value = a.container_id; }
              if (a.demurrage_case_id) { tg.demurrage_case_id = a.demurrage_case_id; dSel.value = a.demurrage_case_id; }
            }
          });
          var svc = F.selectEl('service_code', t('f_service'), F.serviceOptions(true), tg.service);
          svc.addEventListener('change', function () { tg.service = svc.value; });
          var amt = el('input', { class: 'form-control', type: 'text', dir: 'ltr', inputmode: 'decimal', 'aria-label': mode === 'share' ? t('f_share') : t('f_amount'), value: mode === 'share' ? tg.pct : tg.amount });
          amt.addEventListener('input', function () { if (mode === 'share') tg.pct = amt.value; else tg.amount = amt.value; drawRemainOnly(); });
          var calc = mode === 'share' ? el('span', { class: 'form-hint fin-share-amt', text: '= ' + F.moneyTxt(am[i], cur, api) }) : null;
          grid.appendChild(F.field(mode === 'share' ? t('f_share') + ' %' : t('f_amount') + ' (' + cur + ')', el('div', null, [amt, calc]), { required: true }));
          grid.appendChild(F.field(t('match_accrual'), aSel, { hint: t('match_accrual_hint') }));
          grid.appendChild(F.field(t('container'), cSel));
          grid.appendChild(F.field(t('trip'), tSel));
          grid.appendChild(F.field(t('demurrage_case'), dSel));
          grid.appendChild(F.field(t('f_service'), svc));
          box.appendChild(grid);
          if (tg.err) box.appendChild(el('p', { class: 'form-hint', text: t('costs_unavailable', { msg: U.errMsg(tg.err, api) }) }));
          var late = ['under_billing', 'billed', 'closed'].indexOf(tg.tx.operational_status) !== -1;
          if (late) box.appendChild(U.alertBox('warning', t('late_target')));
          box.appendChild(el('div', { class: 'fin-lines-tools' }, U.btn(t('target_remove'), 'btn-subtle', function () { targets.splice(i, 1); drawTargets(); })));
          listBox.appendChild(box);
        });
        drawRemain();
      }
      function drawRemainOnly() {
        drawRemain();
        if (mode === 'share') {
          var am = shareAmounts();
          Array.prototype.forEach.call(listBox.querySelectorAll('.fin-share-amt'), function (n, i) { n.textContent = '= ' + F.moneyTxt(am[i], cur, api); });
        }
      }
      var intro = el('div', { class: 'fin-alloc' }, [
        el('p', { class: 'ops-modal-intro', text: t('alloc_intro', { n: l.line_no || '', desc: l.description || '', amt: F.moneyTxt(free, cur, api) }) }),
        el('p', { class: 'form-hint', text: t('alloc_rule') }),
        el('div', { class: 'ops-form-grid' }, [F.field(t('tx_find'), finder.node, { hint: t('tx_find_hint') }), F.field(t('alloc_mode'), modeSel)]),
        listBox, remain
      ]);
      drawTargets();
      U.formModal({
        title: t('allocate_line', { n: l.line_no || '' }), size: 'lg', intro: intro, submitText: t('alloc_propose'),
        fields: [{ name: 'note', label: t('note'), type: 'textarea', max: 1000, rows: 2 }],
        validate: function () {
          if (!targets.length) return { _t: t('alloc_pick_tx') };
          if (targets.some(function (tg) { return !tg.containers; })) return { _t: t('loading') };
          var tt = totals();
          if (mode === 'share') {
            if (targets.some(function (tg) { var p = F.num(tg.pct); return p == null || isNaN(p) || p <= 0 || p > 100; })) return { _t: t('share_invalid') };
            if (tt.pct > 100 + 1e-9) return { _t: t('share_over') };
            if (tt.amounts.some(function (a) { return a <= 0; })) return { _t: t('amount_positive') };
          } else if (targets.some(function (tg) { var a = F.num(tg.amount); return a == null || isNaN(a) || a <= 0; })) return { _t: t('amount_positive') };
          if (tt.sum > free + 0.001) return { _t: t('over_allocated_local', { amt: F.moneyTxt(free, cur, api) }) };
          return null;
        },
        submit: function (v) {
          var note = U.nn(v.note);
          var p = targets.map(function (tg) {
            var acc = tg.accrual_id && tg.accrual_id !== 'none' ? tg.accrual_id : null;
            var o = { transaction_id: tg.tx.id, container_id: tg.container_id || null, trip_id: tg.trip_id || null, demurrage_case_id: tg.demurrage_case_id || null,
              accrual_id: acc, service_code: tg.service || null, note: note };
            if (tg.accrual_id === 'none' && !o.trip_id && !o.demurrage_case_id) o.no_accrual = true;
            if (mode === 'share') o.share_pct = F.num(tg.pct); else o.amount = F.r2(F.num(tg.amount));
            return o;
          });
          var scope = 'fin-alloc-' + l.id, key = U.idemKey(api, scope, p);
          return U.call(api, 'allocateInvoiceLine', l.id, p, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
        }
      }).then(done(t('alloc_proposed')));
    }

    // --- payments / adjustments -------------------------------------------------
    function paymentsCard(inv, approver) {
      var cur = inv.currency || 'SAR', list = D.payments || [];
      if (!list.length) return U.card(t('payments'), U.emptyState('inbox', null, t('payments_empty'), null, true), null, { sub: t('pay_rule') });
      return U.card(t('payments') + ' (' + list.length + ')', U.table([t('f_paid_at'), { label: t('f_amount'), num: true }, t('f_payer'), t('f_reference'), t('f_status'), { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(function (p) {
          var path = U.pick(p, ['evidence_path', 'evidence_document.storage_path']);
          var acts = el('div', { class: 'ops-row-actions' });
          if (path) acts.appendChild(F.fileLink(api, path, 'finance', t('evidence')));
          if (approver && p.status === 'recorded') acts.appendChild(U.btn(t('void'), 'btn-subtle', function () {
            F.noteDialog(api, { title: t('pay_void'), noteLabel: t('reason'), danger: true, submitText: t('void'), submit: function (note) { return U.call(api, 'voidSupplierPayment', p.id, note); } }).then(done(t('pay_voided')));
          }));
          return el('tr', { class: p.status === 'void' ? 'is-muted' : null }, [U.td(U.fmtDate(p.paid_at), 'is-nowrap'), U.td(F.money(p.amount, p.currency || cur, api), 'num'),
            U.td([el('span', { text: F.lab('fin_payer', p.payer) }), el('span', { class: 'cell-sub', text: F.lab('fin_payment_method', p.method) })]),
            U.td(p.reference ? U.ltr(p.reference) : null), U.td([F.pill('pay_row', p.status, api), p.void_reason ? el('span', { class: 'cell-sub', text: p.void_reason }) : null]), U.td(acts, 'ops-col-actions')]);
        }), { caption: t('payments') }), null, { flush: true, sub: t('pay_rule') });
    }
    function adjustmentsCard(inv, writer) {
      var list = D.adjustments || [];
      var acts = writer && inv.status !== 'void' ? [U.btn([U.icon('plus'), el('span', { text: t('adj_new') })], 'btn-secondary', function () { newAdjustment(inv); })] : [];
      if (!list.length) return U.card(t('adjustments'), U.emptyState('flag', null, t('adj_empty'), null, true), acts);
      return U.card(t('adjustments') + ' (' + list.length + ')', U.table([t('f_kind'), { label: t('f_amount'), num: true }, t('reason'), t('f_status'), { label: t('actions'), cls: 'ops-col-actions' }],
        list.map(function (a) {
          var can = F.rowCan(api, a, 'can_review', 'finApprove') && a.status === 'proposed';
          return el('tr', { class: a.status === 'rejected' ? 'is-muted' : null }, [U.td(F.lab('fin_adjustment_kind', a.kind)), U.td(F.money(a.amount, a.currency, api), 'num'),
            U.td([el('span', { class: 'ops-reason', text: a.reason || U.NONE }), a.review_note ? el('span', { class: 'cell-sub ops-note', text: a.review_note }) : null]),
            U.td(F.pill('fin_adjustment_status', a.status, api)),
            U.td(can ? U.btn(t('review'), 'btn-secondary', function () { adjustmentReviewDialog(F, api, a).then(done()); }) : null, 'ops-col-actions')]);
        }), { caption: t('adjustments') }), acts, { flush: true });
    }
    function newAdjustment(inv) {
      U.call(api, 'listSupplierInvoices', { supplier_id: inv.supplier_id, limit: 200 }).then(function (r) {
        var same = r.error ? [] : U.rowsOf(r.data).filter(function (x) { return x.id !== inv.id && x.status !== 'void'; });
        (D.possible_duplicates || []).forEach(function (x) { if (x.id !== inv.id && !same.some(function (y) { return y.id === x.id; })) same.unshift(x); });
        var rel = [['', U.NONE]].concat(same.map(function (x) { return [x.id, (x.invoice_number || '') + ' · ' + U.fmtDate(x.invoice_date) + ' · ' + F.moneyTxt(x.total_amount, x.currency, api)]; }));
        var o = {
          title: t('adj_new'), intro: t('adj_intro'),
          fields: [
            { name: 'kind', label: t('f_kind'), type: 'select', required: true, value: (D.possible_duplicates || []).length ? 'duplicate_invoice' : 'amendment', options: ADJ_KINDS.map(function (k) { return [k, F.lab('fin_adjustment_kind', k)]; }) },
            { name: 'related_invoice_id', label: t('f_related_invoice'), type: 'select', options: rel, hint: t('related_hint') },
            { name: 'amount', label: t('f_amount') + ' (' + (inv.currency || 'SAR') + ')', ltr: true, inputmode: 'decimal', pattern: MONEY_RE, patternMsg: t('money_invalid') },
            { name: 'service_code', label: t('f_service'), type: 'select', options: F.serviceOptions(true) },
            { name: 'reason', label: t('reason'), type: 'textarea', required: true, max: 2000, rows: 3 }
          ],
          validate: function (v) { return v.kind === 'duplicate_invoice' && !v.related_invoice_id ? { related_invoice_id: t('related_required') } : null; },
          submit: function (v) {
            var a = F.num(v.amount);
            var p = { kind: v.kind, supplier_invoice_id: inv.id, related_invoice_id: v.kind === 'duplicate_invoice' ? v.related_invoice_id : (v.related_invoice_id || null),
              supplier_id: inv.supplier_id, amount: a == null ? null : F.r2(a), currency: inv.currency || 'SAR', service_code: v.service_code || null, reason: v.reason };
            var scope = 'fin-adj-' + inv.id, key = U.idemKey(api, scope, p);
            return U.call(api, 'createCostAdjustment', p, { idemKey: key }).then(function (r) { U.idemSettle(scope, r.error); return r; });
          }
        };
        var pr = U.formModal(o);
        pr.then(done(t('adj_created')));
      });
    }
    return load();
  }

  Ops.views.costs = {
    allow: 'finRead', titleKey: 'fin.nav_costs', icon: 'receipt',
    render: function (root, api, param) {
      if (!Ops.finKit()) return noKit(root);
      if (param === 'review') return renderReview(root, api);
      if (param && UUID_RE.test(param)) return renderDetail(root, api, param);
      return renderInbox(root, api);
    }
  };
  // for tests / other fin modules
  Ops.finInvoices = { newInvoiceDialog: function (api, preset) { var F = Ops.finKit(); return F ? newInvoiceDialog(F, api, preset) : Promise.resolve(null); } };
})();
