/* ==========================================================================
   مرسى | MARSA — legacy step 6: client custody «عهدة العملاء» (#custody) + the custody balance on the client page
   --------------------------------------------------------------------------
   Contract: docs/online/LEGACY_PAY_AR.md («عهدة العملاء»), migration 20261122000100_legacy_pay.sql
   (save_custody_entry, void_custody_entry, list_custody_entries, custody_balances, client_custody_balance).
   Uses MarsaOps.ui + MarsaOps.finUi, MarsaDraft (the unsaved entry form, per user, sessionStorage) and
   MarsaOps.finPay.pure (Riyadh dates). Strings: 'pay.cu_<k>' (assets/i18n/pay.js).

   * Deposit / deduction / refund. A deduction belongs to a transaction of THE SAME client and to one of its
     recorded payments; it can never exceed that payment's share in the transaction (the maximum is shown), and
     one payment is deducted once per client + transaction (already deducted payments are marked).
   * The balance can never go negative: the form shows the current balance and refuses a refund / deduction above
     it; the server re-checks under a per-client lock, and refuses voiding a deposit that would make it negative
     (MRS_CUSTODY_NEGATIVE void_deposit — the legacy bug, fixed) — the page explains that refusal clearly.
   * Void needs a finance approver and a reason of at least 3 characters. Wallet balances are a later phase.
   * Entry dates are DATES in Asia/Riyadh (no time, never shifted by the device zone).
   * Server and user data go through textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var Ops = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  Ops.views = Ops.views || {};
  if (!Array.isArray(Ops.clientSections)) Ops.clientSections = [];

  var KINDS = ['deposit', 'deduction', 'refund'];
  var ENTRY_STATUS = ['active', 'void'];
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var PAGE = 100;

  function T(k, vars) {
    var I = window.MarsaI18n, key = 'pay.cu_' + k;
    if (I && typeof I.t === 'function') { var s = I.t(key, vars); if (s != null && s !== key) return s; }
    return k;
  }
  function P() { return (Ops.finPay && Ops.finPay.pure) || null; }
  function str(v) { return v == null ? '' : String(v).replace(/^\s+|\s+$/g, ''); }
  function num(v) {
    var p = P();
    if (p) return p.num(v);
    var n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }
  function r2(n) { return Math.round((+n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100; }
  function today() { var p = P(); return p ? p.riyadhToday() : new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10); }
  function day(v) { var p = P(); return p ? p.fmtDay(v) : String(v || '').slice(0, 10); }
  function moneyOk(v) { var n = num(v); return n != null && !isNaN(n) && n > 0 && n < 1e12 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6; }

  /* ------------------------------------------------------------------
     Pure (MarsaOps.finCustody.pure)
     ------------------------------------------------------------------ */
  function emptyEntry() {
    return { client_id: '', kind: 'deposit', amount: '', entry_date: today(), transaction_id: '', disbursement_id: '', branch_id: '', reference: '', notes: '' };
  }
  // the most this entry may be: a deduction ≤ the payment's share in the transaction AND ≤ the balance; a refund ≤ the balance
  function maxFor(kind, balance, share) {
    var b = balance == null || isNaN(+balance) ? null : r2(+balance);
    if (kind === 'deposit') return null;
    if (kind === 'refund') return b;
    var s = share == null || isNaN(+share) ? null : r2(+share);
    if (s == null) return b;
    if (b == null) return s;
    return Math.min(s, b);
  }
  function signed(kind, amount) { var n = +amount || 0; return kind === 'deposit' ? n : -n; }
  // → {field: message key}; ctx = { balance, share, branches (count of writable branches) }
  function validateEntry(s, ctx) {
    ctx = ctx || {};
    var e = {}, t = ctx.today || today();
    if (!s.client_id) e.client_id = 'required';
    if (KINDS.indexOf(s.kind) === -1) e.kind = 'required';
    if (!str(s.amount)) e.amount = 'required'; else if (!moneyOk(s.amount)) e.amount = 'money';
    if (!str(s.entry_date)) e.entry_date = 'required';
    else if (!DATE_RE.test(s.entry_date) || s.entry_date < '2000-01-01') e.entry_date = 'date_bad';
    else if (s.entry_date > t) e.entry_date = 'date_future';
    if (s.kind === 'deduction') {
      if (!s.transaction_id) e.transaction_id = 'tx_required';
      if (!s.disbursement_id) e.disbursement_id = 'payment_required';
    }
    if (!s.transaction_id && !s.branch_id) e.branch_id = 'required';
    var mx = maxFor(s.kind, ctx.balance, s.kind === 'deduction' ? ctx.share : null);
    if (!e.amount && mx != null && num(s.amount) > mx + 0.0001) e.amount = s.kind === 'deduction' && ctx.share != null && +ctx.share <= (ctx.balance == null ? Infinity : +ctx.balance) ? 'over_share' : 'over_balance';
    return e;
  }
  function buildEntryPayload(s) {
    var p = { client_id: s.client_id, kind: s.kind, amount: r2(num(s.amount)), entry_date: s.entry_date };
    if (s.transaction_id) p.transaction_id = s.transaction_id;
    else if (s.branch_id) p.branch_id = s.branch_id;
    if (s.kind === 'deduction' && s.disbursement_id) p.disbursement_id = s.disbursement_id;
    if (str(s.reference)) p.reference = str(s.reference);
    if (str(s.notes)) p.notes = str(s.notes);
    return p;
  }
  // a custody error → its clear text (the void of a deposit that would go negative is explained)
  function errText(U, api, e) {
    var c = U.errCode(e), f = e && e.field;
    if (c === 'MRS_CUSTODY_NEGATIVE' && /^void_/.test(f || '')) return T('void_negative', { x: e.extra != null ? e.extra : '' });
    if (c === 'MRS_FORBIDDEN') return T('forbidden');
    return U.errMsg(e, api);
  }
  var PURE = { KINDS: KINDS, emptyEntry: emptyEntry, maxFor: maxFor, signed: signed, validateEntry: validateEntry, buildEntryPayload: buildEntryPayload };

  function noKit(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
    var d = document.createElement('div');
    d.className = 'alert alert-danger';
    d.setAttribute('role', 'alert');
    d.textContent = ((window.MarsaOpsDict || {}).ar || {}).kit_missing || 'MarsaOps.ui missing';
    root.appendChild(d);
  }
  function money(U, n) {
    if (n == null || n === '' || isNaN(+n)) return U.el('span', { class: 'ops-muted', text: '—' });
    return U.el('bdi', { dir: 'ltr', class: 'num fin-money' + (+n < 0 ? ' is-neg' : ''), text: U.fmtMoney(+n, 'SAR') });
  }
  function kindPill(U, k) { return U.pill(k === 'deposit' ? 'success' : k === 'deduction' ? 'warning' : 'info', T('kind_' + k)); }

  /* ==================================================================
     #custody[?client=<id>]
     ================================================================== */
  var CF = { tab: 'balances', q: '', nonzero: true, client_id: '', kind: '', status: 'all', date_from: '', date_to: '', lq: '', offset: 0 };
  function render(root, api) {
    var F = Ops.finKit && Ops.finKit();
    if (!F) return noKit(root);
    var U = F.U, el = U.el, sc = U.scope(root), D = window.MarsaDraft;
    var q = {};
    try { q = typeof api.hashQuery === 'function' ? api.hashQuery() || {} : {}; } catch (e) { q = {}; }
    if (q.client && UUID_RE.test(q.client)) { CF.tab = 'ledger'; CF.client_id = q.client; CF.offset = 0; CF.client_from_url = true; }
    else if (CF.client_from_url) { CF.tab = 'balances'; CF.client_id = ''; CF.offset = 0; CF.client_from_url = false; } // a plain #custody drops the ?client= filter
    U.clear(root);
    root.classList.add('ops-view', 'fin-view', 'pay-view', 'cu-view');
    var canW = api.can('finWrite');
    var newB = canW ? U.btn([U.icon('plus'), el('span', { text: T('new_entry') })], 'btn-primary', function () { openForm(null); }, { 'data-act': 'cu-new' }) : null;
    root.appendChild(U.head(T('title'), T('sub'), newB ? [newB] : null));
    var tiles = el('div', { class: 'adm-tiles ops-kpis fin-kpis cu-tiles', 'aria-live': 'polite' });
    var formHost = el('div', { class: 'cu-form-host' });
    var tabBox = el('div'), bar = el('div', { class: 'pay-bar' }), body = el('div', { class: 'pay-body' });
    root.appendChild(tiles); root.appendChild(formHost);
    root.appendChild(el('p', { class: 'form-hint', text: T('rule_note') }));
    root.appendChild(tabBox); root.appendChild(bar); root.appendChild(body);
    var clients = null, seq = 0, barTab = null;

    function clientsP() {
      if (clients) return Promise.resolve(clients);
      return U.call(api, 'listClients', { orgId: api.orgId, limit: 500 }).then(function (r) { clients = r.error ? [] : U.rowsOf(r.data); return clients; });
    }
    function clientName(id) { var c = (clients || []).filter(function (x) { return x.id === id; })[0]; return c ? ((U.lang() === 'en' && c.name_en) || c.name_ar) : ''; }
    function drawTabs() {
      U.clear(tabBox);
      tabBox.appendChild(F.tabs([['balances', T('tab_balances')], ['ledger', T('tab_ledger')]], CF.tab, function (v) { CF.tab = v; CF.offset = 0; load(); }, T('title')));
    }
    function load() {
      var my = ++seq;
      drawTabs();
      U.loadingInto(body);
      var calls = [U.call(api, 'custodyBalances', api.orgId, CF.tab === 'balances' ? { q: CF.q || undefined, nonzero: CF.nonzero } : {}), clientsP()];
      if (CF.tab === 'ledger') calls.push(U.call(api, 'listCustodyEntries', api.orgId, ledgerFilters()));
      return Promise.all(calls).then(function (res) {
        if (!sc.alive() || my !== seq) return;
        U.doneLoading(body);
        var br = res[0];
        drawTiles(br.error ? null : br.data);
        // the filter bar is built once per tab: a search reload never replaces the input being typed in (focus kept)
        if (barTab !== CF.tab) { drawBar(); barTab = CF.tab; }
        if (CF.tab === 'balances') {
          if (br.error) { body.appendChild(U.errorState(api, br.error, load)); return; }
          drawBalances(U.rowsOf(br.data));
        } else {
          var lr = res[2];
          if (lr.error) { body.appendChild(U.errorState(api, lr.error, load)); return; }
          drawLedger(U.rowsOf(lr.data), lr.data && lr.data.total != null ? +lr.data.total : U.rowsOf(lr.data).length);
        }
      });
    }
    function ledgerFilters() {
      var f = { status: CF.status || 'all', limit: PAGE, offset: CF.offset };
      ['client_id', 'kind', 'date_from', 'date_to'].forEach(function (k) { if (CF[k]) f[k] = CF[k]; });
      if (str(CF.lq)) f.q = str(CF.lq);
      return f;
    }
    function drawTiles(d) {
      U.clear(tiles);
      var rows = d ? U.rowsOf(d) : [];
      tiles.appendChild(U.kpi(T('tile_total'), d ? U.fmtMoney(+d.total_balance || 0, 'SAR') : '—', 'neutral', { foot: T('tile_total_foot') }));
      tiles.appendChild(U.kpi(T('tile_clients'), d ? String(rows.filter(function (x) { return Math.abs(+x.balance || 0) >= 0.005; }).length) : '—', 'neutral'));
    }
    function drawBar() {
      U.clear(bar);
      if (CF.tab === 'balances') {
        var s = U.searchBox(CF.q, T('search_client'), function (v) { CF.q = v; load(); });
        var nz = el('label', { class: 'check ops-check' }, [el('input', { type: 'checkbox', checked: !!CF.nonzero, 'data-filter': 'nonzero' }), el('span', { text: T('only_nonzero') })]);
        nz.firstChild.addEventListener('change', function () { CF.nonzero = !!nz.firstChild.checked; load(); });
        bar.appendChild(U.toolbar(s, [nz], [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': T('refresh'), title: T('refresh') })], null));
        return;
      }
      var s2 = U.searchBox(CF.lq, T('search_ledger'), function (v) { CF.lq = v; CF.offset = 0; load(); });
      var fl = [
        U.select('client_id', T('f_client'), [['', T('f_client') + ': ' + T('all')]].concat((clients || []).map(function (c) { return [c.id, (U.lang() === 'en' && c.name_en) || c.name_ar]; })), CF.client_id, function (v) { CF.client_id = v; CF.offset = 0; load(); }),
        U.select('kind', T('f_kind'), [['', T('f_kind') + ': ' + T('all')]].concat(KINDS.map(function (k) { return [k, T('kind_' + k)]; })), CF.kind, function (v) { CF.kind = v; CF.offset = 0; load(); }),
        U.select('status', T('f_status'), [['all', T('f_status') + ': ' + T('all')]].concat(ENTRY_STATUS.map(function (k) { return [k, T('st_' + k)]; })), CF.status, function (v) { CF.status = v; CF.offset = 0; load(); }),
        F.dateInput('date_from', T('date_from'), CF.date_from, function (v) { CF.date_from = v; CF.offset = 0; load(); }),
        F.dateInput('date_to', T('date_to'), CF.date_to, function (v) { CF.date_to = v; CF.offset = 0; load(); })
      ];
      bar.appendChild(U.toolbar(s2, fl, [U.btn([U.icon('refresh')], 'btn-subtle btn-icon', load, { 'aria-label': T('refresh'), title: T('refresh') })], null));
    }
    function drawBalances(rows) {
      U.clear(body);
      if (!rows.length) { body.appendChild(U.card(null, U.emptyState('inbox', T('bal_empty_title'), T('bal_empty_text')))); return; }
      var tbl = U.table([T('c_client'), { label: T('c_balance'), num: true }, { label: T('c_deposits'), num: true }, { label: T('c_deductions'), num: true },
        { label: T('c_refunds'), num: true }, T('c_last'), { label: T('actions'), cls: 'ops-col-actions' }],
        rows.map(function (b) {
          var acts = el('div', { class: 'ops-row-actions' }, [
            U.btn(T('open_ledger'), 'btn-subtle', function () { CF.tab = 'ledger'; CF.client_id = b.client_id; CF.offset = 0; load(); }, { 'data-ledger': b.client_id }),
            canW ? U.btn(T('new_for_client'), 'btn-secondary', function () { openForm({ client_id: b.client_id }); }, { 'data-new-for': b.client_id }) : null]);
          return el('tr', { 'data-client': b.client_id }, [
            U.td(el('a', { class: 'ops-ref', href: '#client/' + b.client_id, text: b.client_name || '' })),
            U.td(money(U, b.balance), 'num fin-strong'), U.td(money(U, b.total_deposits), 'num'), U.td(money(U, b.total_deductions), 'num'), U.td(money(U, b.total_refunds), 'num'),
            U.td([el('span', { text: b.last_entry_date ? day(b.last_entry_date) : '—' }), el('span', { class: 'cell-sub', text: T('entries_n', { n: b.entry_count || 0 }) })]),
            U.td(acts, 'ops-col-actions')]);
        }), { caption: T('tab_balances') });
      tbl.classList.add('pay-scroll');
      body.appendChild(U.card(null, tbl, null, { flush: true, sub: T('bal_note') }));
    }
    function drawLedger(rows, total) {
      U.clear(body);
      var panel = el('div', { class: 'pay-panel', 'aria-live': 'polite' });
      body.appendChild(panel);
      if (CF.client_id) body.appendChild(el('p', { class: 'text-sm' }, [T('ledger_of') + ' ', el('strong', { text: clientName(CF.client_id) || '—' })]));
      if (!rows.length) { body.appendChild(U.card(null, U.emptyState('inbox', T('led_empty_title'), T('led_empty_text')))); return; }
      var tbl = U.table([T('c_ref'), T('c_client'), T('c_kind'), { label: T('c_amount'), num: true }, T('c_link'), T('c_reference'), T('c_status'), { label: T('actions'), cls: 'ops-col-actions' }],
        rows.map(function (x) {
          var acts = el('div', { class: 'ops-row-actions' });
          if (x.status === 'active' && F.canAt(api, 'finApprove', x.branch_id)) acts.appendChild(U.btn(T('void'), 'btn-subtle', function () { voidPanel(panel, x); }, { 'data-void': x.id }));
          return el('tr', { 'data-entry': x.id, class: x.status === 'void' ? 'is-muted' : null }, [
            U.td([el('bdi', { dir: 'ltr', class: 'cell-main', text: x.ref || '' }), el('span', { class: 'cell-sub', text: day(x.entry_date) })]),
            U.td(el('span', { text: x.client_name || '' })),
            U.td(kindPill(U, x.kind)),
            U.td(money(U, x.signed_amount != null ? x.signed_amount : signed(x.kind, x.amount)), 'num'),
            U.td([x.transaction_id ? el('a', { class: 'ops-ref', href: '#tx/' + x.transaction_id }, el('bdi', { dir: 'ltr', text: x.transaction_ref || '' })) : null,
              x.disbursement_id ? el('a', { class: 'ops-ref cell-sub', href: '#payments/' + x.disbursement_id }, el('bdi', { dir: 'ltr', text: x.payment_ref || '' })) : null]),
            U.td([x.reference ? U.ltr(x.reference) : null, x.notes ? el('span', { class: 'cell-sub', text: x.notes }) : null]),
            U.td([U.pill(x.status === 'active' ? 'success' : 'neutral', T('st_' + x.status)), x.void_reason ? el('span', { class: 'cell-sub', text: x.void_reason }) : null]),
            U.td(acts, 'ops-col-actions')]);
        }), { caption: T('tab_ledger') });
      tbl.classList.add('pay-scroll');
      body.appendChild(U.card(null, tbl, null, { flush: true }));
      var pg = F.pager(total, PAGE, CF.offset, function (o) { CF.offset = o; load(); });
      if (pg) body.appendChild(pg);
    }
    function voidPanel(panel, x) {
      U.clear(panel);
      var id = 'cu-void-' + x.id;
      var ta = el('textarea', { class: 'form-control', id: id, rows: 2, maxlength: 500 });
      var err = el('div', { class: 'cu-void-error', role: 'alert' });
      var go = U.btn(T('void_go'), 'btn-danger', function () {
        U.clear(err);
        var v = str(ta.value);
        if (v.length < 3) { err.appendChild(el('p', { class: 'form-error', text: T('reason_min') })); return; }
        go.disabled = true;
        U.call(api, 'voidCustodyEntry', x.id, v).then(function (r) {
          go.disabled = false;
          if (r.error) {
            var neg = U.errCode(r.error) === 'MRS_CUSTODY_NEGATIVE';
            err.appendChild(U.alertBox(neg ? 'danger' : 'danger', errText(U, api, r.error)));
            if (neg) err.appendChild(el('p', { class: 'form-hint', text: T('void_negative_hint') }));
            return;
          }
          U.clear(panel);
          U.toast(api, T('voided', { balance: U.fmtMoney(+(r.data && r.data.balance) || 0, 'SAR') }), 'success');
          load();
        });
      }, { 'data-void-go': x.id });
      panel.appendChild(el('div', { class: 'pay-reason card' }, [
        el('strong', { class: 'pay-reason-title', text: T('void_title', { ref: x.ref || '' }) }),
        el('p', { class: 'form-hint', text: x.kind === 'deposit' ? T('void_deposit_text') : T('void_text') }),
        el('label', { class: 'form-label', for: id, text: T('reason') }), ta, err,
        el('div', { class: 'pay-actions' }, [go, U.btn(T('cancel'), 'btn-ghost', function () { U.clear(panel); })])
      ]));
    }

    /* ---- the entry form (inline; autosaved draft, per user) ---- */
    function openForm(preset) {
      var scope = 'custody-form', uid = api.userId;
      var dr = !preset && D ? D.load(scope, uid) : null;
      var st = Object.assign(emptyEntry(), dr && dr.data && dr.data.entry ? dr.data.entry : {}, preset || {});
      var saver = D ? D.autosave(scope, uid, function () { return { entry: st }; }, 400) : null;
      var ctx = { balance: null, share: null, txs: [], pays: [], deducted: {} };
      var errs = {}, busy = false;
      var wb = F.branchesFor(api, 'finWrite');
      if (!st.branch_id && wb.length === 1) st.branch_id = wb[0].id;
      var box = el('section', { class: 'app-card ops-card cu-form', 'aria-label': T('form_title') });
      U.clear(formHost);
      formHost.appendChild(box);
      function changed() { if (saver) saver.schedule(); }
      function fieldNode(name, label, control, o) {
        o = o || {};
        var id = 'cu-f-' + name;
        control.setAttribute('id', id);
        control.setAttribute('data-name', name);
        var e = el('span', { class: 'form-error', hidden: true });
        errs[name] = e;
        return el('div', { class: 'form-group pay-field' + (o.full ? ' is-full' : '') }, [
          el('label', { class: 'form-label', for: id }, [label, o.req ? el('span', { class: 'ops-req', 'aria-hidden': 'true', text: ' *' }) : null]),
          control, o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null, e]);
      }
      function sel(name, opts, onChange) {
        var s = el('select', { class: 'form-control' }, opts.map(function (o) { return el('option', { value: o[0], text: o[1], disabled: !!o[2] }); }));
        s.value = st[name] || '';
        s.addEventListener('change', function () { st[name] = s.value; if (onChange) onChange(s.value); changed(); });
        return s;
      }
      function inp(name, o) {
        o = o || {};
        var i = el('input', { class: 'form-control', type: o.type || 'text', dir: o.ltr ? 'ltr' : null, inputmode: o.inputmode || null, maxlength: o.max || null, max: o.maxDate || null, autocomplete: 'off' });
        i.value = st[name] || '';
        i.addEventListener('input', function () { st[name] = i.value; if (errs[name]) errs[name].hidden = true; changed(); if (o.onInput) o.onInput(); });
        return i;
      }
      var balNode = el('div', { class: 'cu-balance', 'aria-live': 'polite' });
      var maxNode = el('p', { class: 'form-hint cu-max', 'aria-live': 'polite' });
      var formErr = el('div', { class: 'pay-form-error', 'aria-live': 'assertive' });
      function drawMax() {
        U.clear(balNode);
        if (st.client_id && ctx.balance != null) balNode.appendChild(el('span', null, [T('current_balance') + ': ', money(U, ctx.balance)]));
        var mx = maxFor(st.kind, ctx.balance, st.kind === 'deduction' ? ctx.share : null);
        maxNode.textContent = mx == null ? '' : st.kind === 'deduction' && ctx.share != null
          ? T('max_deduction', { max: U.fmtMoney(mx, 'SAR'), share: U.fmtMoney(+ctx.share, 'SAR'), balance: U.fmtMoney(+(ctx.balance || 0), 'SAR') })
          : T('max_balance', { max: U.fmtMoney(mx, 'SAR') });
      }
      function loadClient() {
        ctx.balance = null; ctx.txs = []; ctx.pays = []; ctx.share = null; ctx.deducted = {};
        if (!st.client_id) { draw(); return Promise.resolve(); }
        return Promise.all([U.call(api, 'clientCustodyBalance', st.client_id),
          U.call(api, 'listTransactions', { orgId: api.orgId, clientId: st.client_id, cancelled: 'exclude', limit: 100 })]).then(function (res) {
          ctx.balance = res[0].error ? null : +(res[0].data && res[0].data.balance) || 0;
          ctx.txs = res[1].error ? [] : U.rowsOf(res[1].data);
          if (st.transaction_id && !ctx.txs.some(function (t) { return t.id === st.transaction_id; })) { st.transaction_id = ''; st.disbursement_id = ''; }
          return st.transaction_id ? loadPays() : null;
        }).then(function () { draw(); });
      }
      function loadPays() {
        ctx.pays = []; ctx.share = null; ctx.deducted = {};
        if (!st.transaction_id) return Promise.resolve();
        return Promise.all([U.call(api, 'txDisbursements', st.transaction_id),
          U.call(api, 'listCustodyEntries', api.orgId, { client_id: st.client_id, transaction_id: st.transaction_id, kind: 'deduction', status: 'active', limit: 500 })]).then(function (res) {
          ctx.pays = res[0].error ? [] : ((res[0].data && res[0].data.items) || []);
          U.rowsOf(res[1].error ? [] : res[1].data).forEach(function (x) { if (x.disbursement_id) ctx.deducted[x.disbursement_id] = x.ref || true; });
          var p = ctx.pays.filter(function (x) { return x.id === st.disbursement_id; })[0];
          if (st.disbursement_id && (!p || ctx.deducted[st.disbursement_id])) { st.disbursement_id = ''; p = null; }
          ctx.share = p ? shareOf(p.id) : null;
        });
      }
      // a payment may appear once per allocation of this transaction: its share = Σ of those
      function shareOf(pid) { return r2(ctx.pays.filter(function (x) { return x.id === pid; }).reduce(function (n, x) { return n + (+x.share || 0); }, 0)); }
      function draw() {
        errs = {};
        U.clear(box);
        box.appendChild(el('header', { class: 'app-card-head' }, [el('h3', { class: 'app-card-title', text: T('form_title') }),
          U.btn([U.icon('x')], 'btn-subtle btn-icon', function () { if (saver) saver.cancel(); U.clear(formHost); }, { 'aria-label': T('close'), title: T('close') })]));
        var kids = [];
        if (dr) kids.push(el('div', { class: 'alert alert-info', role: 'status' }, [el('div', { class: 'ops-alert-text', text: T('draft_restored') }),
          U.btn(T('draft_discard'), 'btn-ghost', function () { if (D) D.clear(scope, uid); dr = null; st = emptyEntry(); if (wb.length === 1) st.branch_id = wb[0].id; loadClient(); }, { 'data-act': 'cu-discard' })]));
        kids.push(fieldNode('client_id', T('f_client'), sel('client_id', [['', T('choose')]].concat((clients || []).map(function (c) { return [c.id, (U.lang() === 'en' && c.name_en) || c.name_ar]; })), function () {
          st.transaction_id = ''; st.disbursement_id = ''; loadClient();
        }), { req: true }));
        kids.push(fieldNode('kind', T('f_kind'), sel('kind', KINDS.map(function (k) { return [k, T('kind_' + k)]; }), function () {
          if (st.kind !== 'deduction') { st.disbursement_id = ''; ctx.share = null; }
          draw();
        }), { req: true, hint: T('kind_hint_' + st.kind) }));
        kids.push(fieldNode('amount', T('f_amount'), inp('amount', { ltr: true, inputmode: 'decimal', max: 16 }), { req: true }));
        kids.push(fieldNode('entry_date', T('f_date'), inp('entry_date', { type: 'date', maxDate: today() }), { req: true, hint: T('date_hint') }));
        var txOpts = [['', st.kind === 'deduction' ? T('choose') : T('tx_none')]].concat(ctx.txs.map(function (t) { return [t.id, t.ref || String(t.id).slice(0, 8)]; }));
        kids.push(fieldNode('transaction_id', T('f_tx'), sel('transaction_id', txOpts, function () {
          st.disbursement_id = ''; ctx.share = null;
          var t = ctx.txs.filter(function (x) { return x.id === st.transaction_id; })[0];
          if (t) st.branch_id = t.branch_id || st.branch_id;
          loadPays().then(draw);
        }), { req: st.kind === 'deduction', hint: !st.client_id ? T('tx_pick_client') : st.kind === 'deduction' ? T('tx_hint_deduction') : T('tx_hint_optional') }));
        if (st.kind === 'deduction') {
          var seen = {};
          var payOpts = [['', ctx.pays.length ? T('choose') : T('pay_none')]].concat(ctx.pays.filter(function (p) { if (seen[p.id]) return false; seen[p.id] = true; return true; }).map(function (p) {
            var used = ctx.deducted[p.id];
            return [p.id, (p.ref || '') + ' · ' + (p.service_name_ar || p.service_code || '') + ' · ' + U.fmtMoney(shareOf(p.id), 'SAR') + (used ? ' · ' + T('already_deducted') : ''), !!used];
          }));
          kids.push(fieldNode('disbursement_id', T('f_payment'), sel('disbursement_id', payOpts, function () { ctx.share = st.disbursement_id ? shareOf(st.disbursement_id) : null; drawMax(); }),
            { req: true, hint: T('payment_hint') }));
        }
        if (!st.transaction_id) {
          kids.push(fieldNode('branch_id', T('f_branch'), sel('branch_id', [['', T('choose')]].concat(wb.map(function (b) { return [b.id, (U.lang() === 'en' && b.name_en) || b.name_ar || b.code]; }))), { req: true, hint: T('branch_hint') }));
        }
        kids.push(fieldNode('reference', T('f_reference'), inp('reference', { max: 120, ltr: true })));
        kids.push(fieldNode('notes', T('f_notes'), inp('notes', { max: 2000 }), { full: true }));
        var saveB = U.btn(T('save'), 'btn-primary', function () { save(saveB); }, { 'data-act': 'cu-save' });
        box.appendChild(el('div', { class: 'app-card-body' }, [balNode, el('div', { class: 'pay-grid' }, kids), maxNode,
          el('p', { class: 'form-hint text-xs', text: T('never_negative') }), formErr,
          el('div', { class: 'pay-actions' }, [saveB, U.btn(T('cancel'), 'btn-ghost', function () { if (saver) saver.cancel(); U.clear(formHost); })])]));
        drawMax();
      }
      function save(saveB) {
        if (busy) return;
        Object.keys(errs).forEach(function (k) { errs[k].hidden = true; });
        U.clear(formErr);
        var bad = validateEntry(st, { balance: ctx.balance, share: ctx.share });
        var names = Object.keys(bad);
        if (names.length) {
          names.forEach(function (k) {
            var msg = T('e_' + bad[k], { max: U.fmtMoney(maxFor(st.kind, ctx.balance, ctx.share) || 0, 'SAR') });
            if (errs[k]) { errs[k].textContent = msg; errs[k].hidden = false; } else formErr.appendChild(U.alertBox('danger', msg));
          });
          if (names.length > 1) formErr.appendChild(U.alertBox('danger', T('form_errors')));
          return;
        }
        busy = true; saveB.disabled = true;
        var payload = buildEntryPayload(st), sk = 'cu-save', key = U.idemKey(api, sk, payload);
        U.call(api, 'saveCustodyEntry', payload, { idemKey: key }).then(function (r) {
          U.idemSettle(sk, r.error);
          busy = false; saveB.disabled = false;
          if (!sc.alive()) return;
          if (r.error) {
            var f = r.error.field, map = { client: 'client_id', transaction: 'transaction_id', amount: 'amount', entry_date: 'entry_date', branch_id: 'branch_id' };
            var msg = errText(U, api, r.error);
            formErr.appendChild(U.alertBox('danger', msg));
            var c = U.errCode(r.error);
            if (c === 'MRS_CUSTODY_LINK') { var ff = /transaction|client_mismatch/.test(f || '') ? 'transaction_id' : 'disbursement_id'; if (f === 'exceeds_payment') ff = 'amount'; if (errs[ff]) { errs[ff].textContent = msg; errs[ff].hidden = false; } }
            else if (c === 'MRS_CUSTODY_NEGATIVE' && errs.amount) { errs.amount.textContent = msg; errs.amount.hidden = false; }
            else if (map[f] && errs[map[f]]) { errs[map[f]].textContent = msg; errs[map[f]].hidden = false; }
            return;
          }
          if (saver) saver.cancel();
          if (D) D.clear(scope, uid);
          U.toast(api, T('saved', { ref: (r.data && r.data.ref) || '', balance: U.fmtMoney(+(r.data && r.data.balance) || 0, 'SAR') }), 'success');
          U.clear(formHost);
          load();
        });
      }
      return clientsP().then(function () { if (!sc.alive()) return null; return loadClient(); });
    }
    var first = load();
    // a draft left in this tab reopens the form
    if (canW && D && D.load('custody-form', api.userId)) first = first.then(function () { return sc.alive() ? openForm(null) : null; });
    return first;
  }

  /* ==================================================================
     The client page (#client/<id>): the custody balance (finance readers only)
     ================================================================== */
  function renderClientBalance(root, client, api) {
    if (!client || !client.id || !api.can('finRead')) return null;
    var F = Ops.finKit && Ops.finKit();
    if (!F) return null;
    var U = F.U, el = U.el;
    var body = el('div', { class: 'app-card-body' }, el('p', { class: 'text-sm text-muted', text: T('loading') }));
    root.appendChild(el('section', { class: 'app-card ops-card cu-client-card' }, [
      el('header', { class: 'app-card-head' }, [el('h3', { class: 'app-card-title', text: T('client_card') }),
        el('a', { class: 'btn btn-sm btn-ghost', href: '#custody?client=' + client.id, 'data-act': 'cu-ledger' }, T('open_ledger'))]), body]));
    return U.call(api, 'clientCustodyBalance', client.id).then(function (r) {
      U.clear(body);
      if (r.error) { body.appendChild(U.alertBox('warning', errText(U, api, r.error))); return; }
      var d = r.data || {};
      body.appendChild(F.dl([[T('c_balance'), money(U, d.balance || 0)], [T('c_deposits'), money(U, d.total_deposits || 0)],
        [T('c_deductions'), money(U, d.total_deductions || 0)], [T('c_refunds'), money(U, d.total_refunds || 0)],
        [T('c_last'), d.last_entry_date ? day(d.last_entry_date) : T('none')]]));
      body.appendChild(el('p', { class: 'form-hint', text: T('never_negative') }));
    });
  }

  Ops.finCustody = { pure: PURE, render: render, renderClientBalance: renderClientBalance };
  Ops.views.custody = {
    allow: 'finRead', titleKey: 'pay.nav_custody', icon: 'wallet',
    render: function (root, api) { return render(root, api); }
  };
  if (!Ops.clientSections.some(function (s) { return s && s.id === 'custody'; })) Ops.clientSections.push({ id: 'custody', order: 50, render: renderClientBalance });
})();
