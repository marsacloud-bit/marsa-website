/* ==========================================================================
   مرسى | MARSA — portal.html  (client portal, STAGING)
   Load order: config.js → i18n.js → assets/i18n/portal.js → assets/i18n/app.js → main.js
               → supa.js → app-shell.js → pwa.js → portal.js  (plain <script defer>)

   * Classic layout (marketing header + page hero + .portal-card + tabs). The
     optional window.MarsaShell helper (app-shell.js) only sets the title,
     fills the hero's [data-shell-org] / [data-shell-search] slots and shows
     toasts (Marsa.toast without it); it never moves the page's DOM.

   * Demo mode: shows a notice (login needs the online setup); no network, the
     online tabs never render.
   * Online: guard → login.html when there is no session. Everything shown is
     what RLS lets this user read: requests they submitted while signed in,
     and transactions / containers / documents / client-visible events of
     the client files staff linked to them (client_users, decision D-02).
     G3: the transaction detail also shows the declaration number + status,
     the B/L numbers, container operational states / return deadlines and
     the times of confirmed port appointments (nothing internal: no costs,
     drivers, notes, exceptions or alerts).
   * G6a (docs/online/G6A_SPEC.md §2):
       - tabs tx · containers · invoices · req · link · profile, with deep links
         #tx/<uuid>, #containers, #invoices, #req/<uuid> (also #tx #req #link #profile).
         An id the RLS read does not return shows only «not found» (no ref, no
         partial row); a malformed id falls back to the list.
       - «حاوياتي»: MarsaApi.listMyContainers({openOnly}) (plain RLS read).
       - «فواتيري» + the tx-detail section «الفواتير الصادرة»: MarsaApi.portalInvoices(txId?)
         → issued Daftra invoices of the client's own transactions only (G6a-1:
         Daftra number, issue date, currency, net / VAT / total, payment status,
         paid amount). Never drafts, lines, costs or margins.
       - both readers guarded: a missing function / RPC → «غير متاح بعد».
       - strings: namespace 'portal' (assets/i18n/portal.js), Arabic default + English;
         dates in Asia/Riyadh through Intl, numbers through MarsaI18n.fmtNumber.
   * All user/DB text is inserted with textContent (no innerHTML of data).
   ========================================================================== */
(function () {
  'use strict';

  var api = window.MarsaApi;
  var M = window.Marsa || {};
  var Shell = window.MarsaShell || null;
  var I = window.MarsaI18n || null;

  /* ---- i18n ---- */
  // msg('key', {vars}) → 'portal.key' in the current language (ar fallback, then the key itself)
  function msg(k, vars) {
    var key = 'portal.' + k;
    if (!I || typeof I.t !== 'function') return k;
    var v = I.t(key, vars);
    return v === key ? k : v;
  }
  function lang() { return I && typeof I.lang === 'function' ? I.lang() : 'ar'; }
  function locale() { return I && typeof I.locale === 'function' ? I.locale() : 'ar-SA-u-nu-latn-ca-gregory'; }
  // code dictionaries: portal.<prefix>.<code>; unknown codes are shown as they are
  function codeText(prefix, c) {
    if (c == null || c === '') return '—';
    var key = 'portal.' + prefix + '.' + c;
    return I && typeof I.has === 'function' && I.has(key) ? I.t(key) : String(c);
  }

  function setShellTitle() {
    if (!Shell) return;
    // no extra crumbs: the hero breadcrumb stays «الرئيسية ‹ بوابة العميل» as in the original page
    if (typeof Shell.setTitle === 'function') Shell.setTitle(msg('title'));
    if (typeof Shell.setActive === 'function') Shell.setActive('portal');
  }
  setShellTitle();
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // code order of the fallback lists (labels come from the dictionary: portal.lbl.<domain>.<code>)
  var FALLBACK = {
    operational_status: ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return',
      'operationally_complete', 'under_billing', 'billed', 'closed'],
    request_status: ['new', 'under_review', 'converted', 'rejected'],
    container_return_status: ['pending', 'evidence_submitted', 'returned_verified', 'disputed', 'waived'],
    document_kind: ['bill_of_lading', 'commercial_invoice', 'packing_list', 'certificate_of_origin', 'saber_certificate', 'government_doc', 'other'],
    portal_payment_status: ['unknown', 'unpaid', 'partial', 'paid']
  };
  // kinds a client may declare when uploading (staff verify/classify afterwards)
  var CLIENT_KINDS = ['bill_of_lading', 'commercial_invoice', 'packing_list', 'certificate_of_origin', 'saber_certificate', 'government_doc', 'other'];
  var ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'];
  var EXT_MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' };
  var MAX_BYTES = 26214400;
  var OPEN_RETURNS = ['pending', 'evidence_submitted', 'disputed'];
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var TABS = ['tx', 'containers', 'invoices', 'req', 'link', 'profile'];

  /* ---- tiny DOM builder (text only) ---- */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  }
  function svgIcon(paths) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('class', 'icon'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    [].concat(paths).forEach(function (d) { var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }

  /* ---- dates (Asia/Riyadh) / numbers ---- */
  var DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  function fmtDate(v, withTime) {
    if (!v) return '—';
    var s = String(v), dOnly = DATE_ONLY.test(s);
    var d = new Date(dOnly ? s + 'T00:00:00Z' : s);
    if (isNaN(d.getTime())) return s;
    var o = { year: 'numeric', month: 'short', day: 'numeric', timeZone: dOnly ? 'UTC' : 'Asia/Riyadh' };
    if (withTime && !dOnly) { o.hour = '2-digit'; o.minute = '2-digit'; }
    try { return new Intl.DateTimeFormat(locale(), o).format(d); }
    catch (e) { return d.toISOString().slice(0, withTime && !dOnly ? 16 : 10).replace('T', ' '); }
  }
  // Riyadh calendar day (UTC+3, no DST) of a date or timestamp → 'YYYY-MM-DD'
  function riyadhDay(v) {
    if (v == null || v === '') return null;
    var s = String(v);
    if (DATE_ONLY.test(s)) return s;
    var d = v instanceof Date ? v : new Date(s);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 10);
  }
  function dayNo(day) { var p = day.split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000); }
  function money(n) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    if (I && typeof I.fmtNumber === 'function') return I.fmtNumber(Number(n), { digits: 2 });
    return Number(n).toFixed(2);
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function num(text) { return h('span', { class: 'num', dir: 'ltr', text: text == null || text === '' ? '—' : String(text) }); }
  function errText(err) { return (err && err.message) || msg('unexpected'); }
  // the RPC / table is not deployed yet (PostgREST: unknown function / relation)
  function isMissing(err) {
    var raw = err && (err.raw || err);
    var c = raw && raw.code;
    return c === 'PGRST202' || c === '42883' || c === 'PGRST205' || c === '42P01';
  }
  function alertBox(type, text) {
    return h('div', { class: 'alert alert-' + type, role: type === 'danger' ? 'alert' : 'status' }, [
      svgIcon(['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 16v-4M12 8h.01']), h('span', { text: text })]);
  }
  function loadingBox() { return h('p', { class: 'portal-loading', role: 'status' }, [h('span', { class: 'dot dot-pulse' }), msg('loading')]); }
  // original card section: <section class="card"><h4>title</h4>…</section>; sec.body is the section itself
  function panel(id, title, kids) {
    var sec = h('section', { class: 'card', 'aria-labelledby': id }, [h('h4', { id: id, text: title })].concat(kids || []));
    sec.body = sec;   // callers append later content to sec.body
    return sec;
  }
  function errorBox(err, retryFn) {
    var box = alertBox('danger', msg('loadFail') + ' ' + errText(err));
    if (retryFn) box.appendChild(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: msg('retry'), onclick: retryFn }));
    return box;
  }
  function unavailableBox() { return alertBox('info', msg('unavailable')); }
  function kvList(rows) {
    return h('ul', { class: 'kv' }, rows.filter(function (r) { return r; }).map(function (r) {
      var v = r[1];
      return h('li', null, [h('span', { class: 'k', text: r[0] }), h('span', { class: 'v' }, [v == null || v === '' ? '—' : (typeof v === 'object' ? v : String(v))])]);
    }));
  }
  function table(cls, caption, heads, tbody) {
    return h('div', { class: 'table-wrap' }, [h('table', { class: cls }, [
      caption ? h('caption', { class: 'sr-only', text: caption }) : null,
      h('thead', null, [h('tr', null, heads.map(function (x) { return h('th', { scope: 'col', text: x }); }))]),
      tbody])]);
  }
  function normDigits(s) {
    return String(s || '').replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 1632); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 1776); });
  }
  function normPhone(s) {
    var v = normDigits(s).replace(/[\s().-]/g, '');
    if (v.indexOf('+966') === 0) v = '0' + v.slice(4);
    else if (v.indexOf('00966') === 0) v = '0' + v.slice(5);
    else if (/^966\d{9}$/.test(v)) v = '0' + v.slice(3);
    if (/^5\d{8}$/.test(v)) v = '0' + v;
    return /^05\d{8}$/.test(v) ? v : null;
  }
  function fieldError(input, text) {
    var g = input.closest('.form-group');
    if (!g) return;
    var err = g.querySelector('.form-error');
    if (text) { g.classList.add('has-error'); input.setAttribute('aria-invalid', 'true'); if (err) err.textContent = text; }
    else { g.classList.remove('has-error'); input.removeAttribute('aria-invalid'); }
  }
  function toast(text, type) {
    if (Shell && typeof Shell.toast === 'function') Shell.toast(text, type);
    else if (M.toast) M.toast(text, type);
  }

  /* ---- views ---- */
  function showView(name) {
    $$('[data-portal-view]').forEach(function (el) { el.hidden = el.getAttribute('data-portal-view') !== name; });
  }

  /* ======================================================================
     DEMO MODE
     ====================================================================== */
  if (!api || !api.isOnline()) {
    showView('demo');
    return;
  }

  /* ======================================================================
     ONLINE MODE
     ====================================================================== */
  var state = { user: null, ctx: null, labels: {}, reqCache: {}, booted: false,
    ctr: { loaded: false, openOnly: true }, inv: { loaded: false } };
  showView('loading');

  /* ---- routing: #tx[/<uuid>] #containers #invoices #req[/<uuid>] #link #profile ---- */
  function parseHash() {
    var raw = String(location.hash || '').replace(/^#/, '');
    var parts = raw.split('/');
    var tab = parts[0];
    if (TABS.indexOf(tab) === -1) return { tab: 'tx', id: null };   // '' / #client / anything else → transactions list
    var id = (tab === 'tx' || tab === 'req') && parts.length === 2 && UUID.test(parts[1]) ? parts[1].toLowerCase() : null;
    return { tab: tab, id: id };
  }
  function goLogin() {
    // keep a portal deep link through the sign-in (auth.js accepts portal.html#<plain route>)
    var r = parseHash(), hash = '';
    if (/^#/.test(location.hash) && TABS.indexOf(String(location.hash).slice(1).split('/')[0]) !== -1) hash = '#' + r.tab + (r.id ? '/' + r.id : '');
    location.replace('login.html?next=' + (hash ? encodeURIComponent('portal.html' + hash) : 'portal.html') + '#client');
  }
  function go(route) {
    var target = '#' + route;
    if (location.hash === target) doRoute();
    else location.hash = target;   // → hashchange → doRoute
  }
  function selectTab(name) {
    $$('[data-portal-tab]').forEach(function (b) {
      var on = b.getAttribute('data-portal-tab') === name;
      b.setAttribute('aria-selected', String(on));
      b.setAttribute('tabindex', on ? '0' : '-1');
      var p = document.getElementById(b.getAttribute('aria-controls'));
      if (p) p.hidden = !on;
    });
  }
  function doRoute() {
    if (!state.booted) return;
    var r = parseHash();
    selectTab(r.tab);
    if (r.tab === 'tx') { if (r.id) openTransaction(r.id); else showTxList(); }
    else if (r.tab === 'req') { if (r.id) openRequest(r.id); else showReqList(); }
    else if (r.tab === 'containers') { if (!state.ctr.loaded) loadContainers(); }
    else if (r.tab === 'invoices') { if (!state.inv.loaded) loadInvoices(); }
  }
  window.addEventListener('hashchange', doRoute);
  $$('[data-portal-tab]').forEach(function (b) {
    var name = b.getAttribute('data-portal-tab');
    b.addEventListener('click', function () { go(name); });
    // main.js moves the selection with the arrow keys (focus, no click): follow it
    b.addEventListener('focus', function () {
      if (b.getAttribute('aria-selected') === 'true' && parseHash().tab !== name) go(name);
    });
  });
  function backBtn(tab) {
    var d = lang() === 'en' ? 'M19 12H5M11 6l-6 6 6 6' : 'M5 12h14M13 6l6 6-6 6';
    return h('button', { class: 'btn btn-sm btn-ghost mb-3', type: 'button', onclick: function () { go(tab); } }, [svgIcon(d), msg('back')]);
  }

  /* ---- status labels (status_labels rows, else the dictionary fallback) ---- */
  function labelRow(domain, code) {
    var list = state.labels[domain] || [];
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }
  function label(domain, code) {
    if (code == null || code === '') return '—';
    var row = labelRow(domain, code);
    var v = row && (row['label_' + lang()] || row.label_ar);
    return v || codeText('lbl.' + domain, code);
  }
  function sortOf(domain, code) { var row = labelRow(domain, code); return row ? row.sort : 0; }
  function loadLabels() {
    var domains = Object.keys(FALLBACK);
    return Promise.all(domains.map(function (d) { return api.statusLabels(d); })).then(function (rs) {
      rs.forEach(function (r, i) {
        var d = domains[i];
        if (!r.error && r.data && r.data.length) state.labels[d] = r.data;
        else state.labels[d] = FALLBACK[d].map(function (c, j) { return { code: c, sort: j + 1 }; });
      });
    });
  }
  var BADGE = {
    request_status: { new: 'badge-blue', under_review: 'badge-warning', converted: 'badge-success', rejected: 'badge-danger' },
    operational_status: { operationally_complete: 'badge-success', under_billing: 'badge-teal', billed: 'badge-teal', closed: 'badge-navy' },
    container_return_status: { pending: 'badge-warning', evidence_submitted: 'badge-blue', returned_verified: 'badge-success', disputed: 'badge-danger', waived: 'badge-teal' },
    portal_payment_status: { unpaid: 'badge-warning', partial: 'badge-blue', paid: 'badge-success', unknown: 'badge-muted' }
  };
  function statusBadge(domain, code) {
    var cls = (BADGE[domain] && BADGE[domain][code]) || 'badge-blue';
    return h('span', { class: 'badge ' + cls, text: label(domain, code) });
  }
  function opText(op, mode) {
    return [op ? codeText('dir', op) : '', mode ? codeText('mode', mode) : ''].filter(Boolean).join(' · ') || '—';
  }

  /* ---- header: user + sign-out ---- */
  function renderUser() {
    var p = (state.ctx && state.ctx.profile) || {};
    var nameEl = $('[data-portal-name]');
    if (nameEl) nameEl.textContent = p.full_name || (state.user && state.user.email) || '';
    var emEl = $('[data-portal-email]');
    if (emEl) emEl.textContent = (state.user && state.user.email) || '';
    var mships = (state.ctx && state.ctx.memberships) || [];
    var staff = mships.some(function (m) { return m.org_slug === api.orgSlug && m.role !== 'client'; });
    var sn = $('[data-staff-note]'); if (sn) sn.hidden = !staff;
    var nl = $('[data-notlinked-note]'); if (nl) nl.hidden = ((state.ctx && state.ctx.clients) || []).length > 0;
  }
  $$('[data-sign-out]').forEach(function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      api.signOut().then(function () { toast(msg('signOutDone'), 'info'); location.replace('login.html#client'); });
    });
  });
  // revokes the sessions on every device (Supabase scope 'global'), then leaves the portal
  $$('[data-sign-out-all]').forEach(function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      api.signOutEverywhere().then(function (r) {
        b.disabled = false;
        if (r.error) { toast(r.error.message, 'error'); return; }
        toast(msg('signOutAllDone'), 'info'); location.replace('login.html#client');
      });
    });
  });
  function setCount(name, n) {
    var cnt = $('[data-count="' + name + '"]');
    if (!cnt) return;
    cnt.textContent = String(n);
    cnt.hidden = false;
  }
  function txLink(id, ref) {
    if (!id || !UUID.test(String(id))) return num(ref);
    return h('a', { href: '#tx/' + String(id).toLowerCase() }, [num(ref)]);
  }

  /* ======================================================================
     TRANSACTIONS
     ====================================================================== */
  var txList = $('[data-tx-list]'), txDetail = $('[data-tx-detail]');
  var txSeq = 0;
  function showTxList() {
    txSeq++;   // drops a detail still loading
    clear(txDetail); txDetail.hidden = true; txList.hidden = false;
  }
  function loadTransactions() {
    clear(txList).appendChild(loadingBox());
    return api.listTransactions({ limit: 100 }).then(function (r) {
      clear(txList);
      if (r.error) { txList.appendChild(errorBox(r.error, loadTransactions)); return; }
      var rows = r.data || [];
      setCount('tx', rows.length);
      if (!rows.length) { txList.appendChild(alertBox('info', msg('noTx'))); return; }
      var tbody = h('tbody');
      rows.forEach(function (tx) {
        tbody.appendChild(h('tr', null, [
          h('td', null, [num(tx.ref)]),
          h('td', { text: opText(tx.operation, tx.mode) }),
          h('td', null, [tx.bl_number ? num(tx.bl_number) : '—']),
          h('td', null, [statusBadge('operational_status', tx.operational_status)]),
          h('td', { text: fmtDate(tx.status_changed_at || tx.updated_at) }),
          h('td', null, [h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: msg('details'),
            'aria-label': msg('details') + ' ' + (tx.ref || ''), onclick: function () { go('tx/' + tx.id); } })])
        ]));
      });
      txList.appendChild(table('table table-striped', msg('tabTx'),
        [msg('colRef'), msg('colOperation'), msg('colBl'), msg('colStage'), msg('colUpdated'), ''], tbody));
    });
  }

  // G3 / G6a reads are optional: an older data layer (or a missing table / RPC) leaves those parts empty
  function opt(name, a, b) { return typeof api[name] === 'function' ? api[name](a, b) : Promise.resolve({ data: [], error: null }); }
  function invoicesOf(txId) {
    if (typeof api.portalInvoices !== 'function') return Promise.resolve({ unavailable: true });
    return api.portalInvoices(txId).then(function (r) {
      if (r && r.error && isMissing(r.error)) return { unavailable: true };
      return r;
    }, function () { return { unavailable: true }; });
  }

  function openTransaction(id) {
    var seq = ++txSeq;
    txList.hidden = true; txDetail.hidden = false;
    clear(txDetail).appendChild(loadingBox());
    // the transaction first: when RLS does not return it nothing else is read or shown
    api.getTransaction(id).then(function (r) {
      if (seq !== txSeq) return null;
      if (r.error || !r.data) {
        clear(txDetail);
        txDetail.appendChild(backBtn('tx'));
        txDetail.appendChild(r.error ? errorBox(r.error, function () { openTransaction(id); }) : alertBox('warning', msg('txNotFound')));
        return null;
      }
      var tx = r.data;
      return Promise.all([api.listEvents(id), api.listDocuments({ transactionId: id }),
        opt('listDeclarations', id, { minimal: true }), opt('listBLs', id, { minimal: true }),
        opt('listAppointments', { txId: id, status: 'confirmed', minimal: true }), invoicesOf(id)]).then(function (rs) {
        if (seq !== txSeq) return;
        paintTransaction(tx, rs);
      });
    });
  }

  function paintTransaction(tx, rs) {
    clear(txDetail);
    txDetail.appendChild(backBtn('tx'));
    var ev = rs[0], dr = rs[1];
    var decls = rs[2].error ? [] : (rs[2].data || []), bls = rs[3].error ? [] : (rs[3].data || []);
    var appts = rs[4].error ? [] : (rs[4].data || []).filter(function (a) { return a && a.status === 'confirmed'; });
    // clients do not read port_appointments (RLS): confirmed slots reach them as client-visible 'appointment'
    // events { op: confirmed | withdrawn | completed, appointment_ref, appointment_at, window_minutes, container_no }.
    // Events come in time order: a later withdrawal (rescheduled / cancelled / missed) or completion drops the
    // slot. Older events carry no ref (confirmed only) and are keyed by their time.
    if (!appts.length && !ev.error) {
      var slots = {}, order = [];
      (ev.data || []).forEach(function (e) {
        var pl = e && e.event_type === 'appointment' && e.payload;
        if (!pl || !pl.appointment_at) return;
        var key = pl.appointment_ref ? 'ref:' + pl.appointment_ref : 'at:' + pl.appointment_at;
        if (pl.op === 'confirmed') {
          if (!slots[key]) order.push(key);
          slots[key] = { appointment_at: pl.appointment_at, window_minutes: pl.window_minutes || null, container_no: pl.container_no || null, status: 'confirmed' };
        } else if (pl.op === 'withdrawn' || pl.op === 'completed') {
          slots[key] = null;
        }
      });
      order.forEach(function (k) { if (slots[k]) appts.push(slots[k]); });
    }
    // the active declaration (not cancelled / replaced) first, else the newest
    var decl = decls.filter(function (d) { return d.status !== 'cancelled' && d.status !== 'replaced'; })[0] || decls[0] || null;
    var blNos = bls.map(function (b) { return b.bl_number; }).filter(Boolean);
    txDetail.appendChild(h('div', { class: 'portal-detail-head' }, [
      h('div', null, [h('p', { class: 'eyebrow mb-1', text: msg('eyebrowTx') }), h('h3', { class: 'mb-0' }, [num(tx.ref)])]),
      statusBadge('operational_status', tx.operational_status)
    ]));

    var grid = h('div', { class: 'portal-detail-grid' });
    txDetail.appendChild(grid);
    var main = h('div', { class: 'stack' }), side = h('div', { class: 'stack' });
    grid.appendChild(main); grid.appendChild(side);

    var en = lang() === 'en';
    main.appendChild(panel('tx-sum-h', msg('secSummary'), [
      kvList([
        [msg('kClient'), tx.clients && ((en && tx.clients.name_en) || tx.clients.name_ar)],
        [msg('kBranch'), tx.branches && ((en && tx.branches.name_en) || tx.branches.name_ar)],
        [msg('kOperation'), tx.operation ? codeText('dir', tx.operation) : null],
        [msg('kMode'), tx.mode ? codeText('mode', tx.mode) : null],
        [msg('kPod'), tx.port_of_discharge],
        [msg('kCountry'), tx.country],
        [msg('kGoods'), tx.goods_description],
        [msg('kHs'), tx.hs_code ? num(tx.hs_code) : null],
        [msg('kLine'), tx.shipping_line],
        [blNos.length > 1 ? msg('kBls') : msg('kBl'), blNos.length ? blList(blNos) : (tx.bl_number ? num(tx.bl_number) : null)],
        [msg('kDecl'), decl ? num(decl.declaration_no) : (tx.declaration_no ? num(tx.declaration_no) : null)],
        decl ? [msg('kDeclStatus'), codeText('decl', decl.status)] : null,
        [msg('kEta'), tx.eta ? fmtDate(tx.eta) : null],
        [msg('kCtrCount'), tx.container_count != null ? num(tx.container_count) : null]
      ])
    ]));

    main.appendChild(renderContainers(tx.containers || []));
    main.appendChild(renderAppointments(appts, tx.containers || []));
    main.appendChild(renderTxInvoices(rs[5]));
    main.appendChild(renderDocuments(tx, dr));
    side.appendChild(renderStages(tx));
    side.appendChild(renderEvents(ev));
    try { txDetail.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignore */ }
  }

  function renderStages(tx) {
    var cur = sortOf('operational_status', tx.operational_status);
    var ol = h('ol', { class: 'timeline' });
    (state.labels.operational_status || []).forEach(function (s) {
      var cls = s.sort < cur ? 'is-done' : (s.sort === cur ? 'is-current' : '');
      ol.appendChild(h('li', { class: cls, 'aria-current': s.sort === cur ? 'step' : null }, [
        h('span', { class: 'tl-dot' }), h('span', { class: 'tl-title', text: label('operational_status', s.code) }),
        s.sort === cur ? h('span', { class: 'tl-meta', text: msg('since', { d: fmtDate(tx.status_changed_at, true) }) }) : null
      ]));
    });
    return panel('tx-stage-h', msg('stagesTitle'), [
      h('p', { class: 'text-xs text-muted', text: msg('stagesNote') }),
      ol]);
  }

  function renderEvents(ev) {
    var sec = panel('tx-ev-h', msg('eventsTitle'));
    if (ev.error) { sec.body.appendChild(errorBox(ev.error)); return sec; }
    var rows = ev.data || [];
    if (!rows.length) { sec.body.appendChild(h('p', { class: 'text-muted text-sm', text: msg('noEvents') })); return sec; }
    var arrow = lang() === 'en' ? ' → ' : ' ← ';
    var ol = h('ol', { class: 'timeline' });
    rows.slice().reverse().forEach(function (e, i) {
      var title = codeText('ev', e.event_type);
      var detail = '';
      if (e.event_type === 'operational_status' || e.event_type === 'created' || e.event_type === 'request_converted') {
        if (e.to_status) detail = (e.from_status ? label('operational_status', e.from_status) + arrow : '') + label('operational_status', e.to_status);
      } else if (e.event_type === 'container_return') {
        detail = ((e.payload && e.payload.container_no) ? e.payload.container_no + ': ' : '') + label('container_return_status', e.to_status);
      } else if (e.event_type === 'document' && e.payload) {
        detail = label('document_kind', e.payload.kind);
      } else if (e.event_type === 'appointment' && e.payload && e.payload.appointment_at) {
        if (e.payload.op === 'withdrawn' || e.payload.op === 'completed') title = codeText('appt', e.payload.op);
        detail = (e.payload.container_no ? e.payload.container_no + ': ' : '') + fmtDate(e.payload.appointment_at, true);
      }
      ol.appendChild(h('li', { class: i === 0 ? 'is-current' : 'is-done' }, [
        h('span', { class: 'tl-dot' }),
        h('span', { class: 'tl-title', text: title + (detail ? ' — ' + detail : '') }),
        e.note ? h('span', { class: 'tl-meta d-block', text: e.note }) : null,
        h('span', { class: 'tl-meta', text: fmtDate(e.created_at, true) })
      ]));
    });
    sec.body.appendChild(ol);
    sec.body.appendChild(h('p', { class: 'text-xs text-muted mt-2', text: msg('eventsNote') }));
    return sec;
  }

  function renderContainers(list) {
    var sec = panel('tx-ct-h', msg('secContainers'));
    if (!list.length) { sec.body.appendChild(h('p', { class: 'text-muted text-sm', text: msg('noContainers') })); return sec; }
    list = list.slice().sort(function (a, b) { return String(a.container_no).localeCompare(String(b.container_no)); });
    var tbody = h('tbody');
    list.forEach(function (c) {
      tbody.appendChild(h('tr', null, [
        h('td', null, [num(c.container_no)]),
        h('td', null, [num(c.size_type || c.container_type)]),
        h('td', { text: c.operational_state ? codeText('ctr', c.operational_state) : '—' }),
        h('td', null, [statusBadge('container_return_status', c.return_status)]),
        h('td', { text: c.return_deadline ? fmtDate(c.return_deadline) : '—' }),
        h('td', { text: c.returned_at ? fmtDate(c.returned_at) : '—' })
      ]));
    });
    sec.body.appendChild(table('table', null,
      [msg('colCtrNo'), msg('colCtrType'), msg('colOpState'), msg('colReturn'), msg('colDeadline'), msg('colReturnedAt')], tbody));
    sec.body.appendChild(h('p', { class: 'text-xs text-muted mt-2', text: msg('ctrNote') }));
    return sec;
  }

  function blList(nos) {
    var kids = [];
    nos.forEach(function (n, i) { if (i) kids.push(msg('listSep')); kids.push(num(n)); });
    return h('span', null, kids);
  }
  function renderAppointments(list, containers) {
    var sec = panel('tx-ap-h', msg('secAppts'));
    if (!list.length) { sec.body.appendChild(h('p', { class: 'text-muted text-sm', text: msg('noAppointments') })); return sec; }
    var byId = {};
    containers.forEach(function (c) { byId[c.id] = c.container_no; });
    var ul = h('ul', { class: 'kv' });
    list.slice().sort(function (a, b) { return String(a.appointment_at).localeCompare(String(b.appointment_at)); }).forEach(function (a) {
      ul.appendChild(h('li', null, [
        h('span', { class: 'k' }, [a.container_no ? num(a.container_no) : (a.container_id && byId[a.container_id] ? num(byId[a.container_id]) : msg('apptWhole'))]),
        h('span', { class: 'v', text: fmtDate(a.appointment_at, true) + (a.window_minutes ? ' ' + msg('apptWindow', { n: a.window_minutes }) : '') })
      ]));
    });
    sec.body.appendChild(ul);
    sec.body.appendChild(h('p', { class: 'text-xs text-muted mt-2', text: msg('appointmentsHint') }));
    return sec;
  }

  /* ---- issued invoices (G6a-1): Daftra-synced fields of the client's own transactions ---- */
  function invoiceItems(r) {
    var d = r && r.data;
    if (!d) return [];
    return Array.isArray(d) ? d : (Array.isArray(d.items) ? d.items : []);
  }
  function invoiceTable(items, withTx) {
    var tbody = h('tbody');
    items.forEach(function (v) {
      tbody.appendChild(h('tr', { 'data-invoice': v.id || null }, [
        h('td', null, [num(v.daftra_number),
          v.remote_state === 'cancelled' ? h('span', { class: 'badge badge-danger badge-sm portal-inv-cancel', text: msg('invCancelled') }) : null]),
        withTx ? h('td', null, [txLink(v.transaction_id, v.transaction_ref)]) : null,
        h('td', { text: fmtDate(v.issued_at) }),
        h('td', null, [num(v.currency)]),
        h('td', { class: 'portal-money' }, [num(money(v.net))]),
        h('td', { class: 'portal-money' }, [num(money(v.vat))]),
        h('td', { class: 'portal-money' }, [num(money(v.total))]),
        h('td', null, [statusBadge('portal_payment_status', v.payment_status || 'unknown')]),
        h('td', { class: 'portal-money' }, [num(money(v.paid_amount))])
      ]));
    });
    var heads = [msg('colDaftraNo')].concat(withTx ? [msg('colTx')] : []).concat([msg('colIssued'), msg('colCurrency'),
      msg('colNet'), msg('colVat'), msg('colTotal'), msg('colPayStatus'), msg('colPaid')]);
    return table('table table-striped portal-inv-table', msg('invTabTitle'), heads, tbody);
  }
  function renderTxInvoices(r) {
    var sec = panel('tx-inv-h', msg('secInvoices'));
    if (!r || r.unavailable) { sec.body.appendChild(h('p', { class: 'text-muted text-sm', text: msg('unavailable') })); return sec; }
    if (r.error) { sec.body.appendChild(errorBox(r.error)); return sec; }
    var items = invoiceItems(r);
    if (!items.length) { sec.body.appendChild(h('p', { class: 'text-muted text-sm', text: msg('noInvoices') })); return sec; }
    sec.body.appendChild(invoiceTable(items, false));
    sec.body.appendChild(h('p', { class: 'text-xs text-muted mt-2', text: msg('invNote') }));
    return sec;
  }

  function renderDocuments(tx, dr) {
    var sec = panel('tx-doc-h', msg('secDocs'));
    var listWrap = h('div');
    sec.body.appendChild(listWrap);
    function paint(res) {
      clear(listWrap);
      if (res.error) { listWrap.appendChild(errorBox(res.error)); return; }
      var docs = res.data || [];
      if (!docs.length) { listWrap.appendChild(h('p', { class: 'text-muted text-sm', text: msg('noDocs') })); return; }
      var ul = h('ul', { class: 'file-list portal-docs' });
      docs.forEach(function (d) {
        var btn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': msg('download') + ' ' + d.original_name }, [
          svgIcon(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5M12 15V3']), msg('download')]);
        btn.addEventListener('click', function () { download(d, btn); });
        ul.appendChild(h('li', { class: 'file-item' }, [
          svgIcon(['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5']),
          h('span', { class: 'file-name' }, [
            h('bdi', { text: d.original_name }),
            h('span', { class: 'text-xs text-muted d-block' }, [
              label('document_kind', d.classification || d.kind) + (d.classification ? '' : msg('byUploader')) +
              ' · ' + fmtDate(d.uploaded_at) + (d.version > 1 ? ' · ' + msg('docVersion', { n: d.version }) : '') + ' · SHA-256 ',
              h('span', { class: 'num', dir: 'ltr', title: d.sha256, text: String(d.sha256 || '').slice(0, 12) + '…' })
            ])
          ]),
          h('span', { class: 'file-size num', dir: 'ltr', text: fmtSize(d.size_bytes) }),
          btn
        ]));
      });
      listWrap.appendChild(ul);
    }
    paint(dr);
    sec.body.appendChild(uploadForm(tx, function () { api.listDocuments({ transactionId: tx.id }).then(paint); }));
    return sec;
  }

  // download only through a short-lived signed URL minted by MarsaApi.documentUrl (no storage path is built here)
  function download(d, btn) {
    var label0 = btn.lastChild.textContent;
    btn.disabled = true; btn.lastChild.textContent = msg('preparing');
    // open the tab synchronously (popup blockers), then point it at the short-lived signed URL
    var w = null;
    try { w = window.open('', '_blank'); if (w) w.opener = null; } catch (e) { w = null; }
    api.documentUrl(d, 120).then(function (r) {
      btn.disabled = false; btn.lastChild.textContent = label0;
      if (r.error || !r.data) { if (w) w.close(); toast(msg('downloadFail'), 'error'); return; }
      if (w) w.location.href = r.data; else location.assign(r.data);
    });
  }

  var uploadSeq = 0;
  function uploadForm(tx, onDone) {
    var n = ++uploadSeq;
    var kindSel = h('select', { class: 'form-control', id: 'up-kind-' + n, name: 'kind', required: true },
      CLIENT_KINDS.map(function (k) { return h('option', { value: k, text: label('document_kind', k) }); }));
    var fileIn = h('input', { class: 'form-control', id: 'up-file-' + n, name: 'file', type: 'file', required: true,
      accept: '.pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.csv,' + ALLOWED_MIME.join(','), 'aria-describedby': 'up-hint-' + n });
    var status = h('div', { class: 'mt-2', 'aria-live': 'polite' });
    var submit = h('button', { class: 'btn btn-primary', type: 'submit' }, [
      svgIcon(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5M12 3v12']), msg('upload')]);
    var form = h('form', { class: 'form portal-upload mt-3', novalidate: true }, [
      h('h5', { class: 'mb-0', text: msg('uploadTitle') }),
      h('div', { class: 'form-row' }, [
        h('div', { class: 'form-group' }, [h('label', { class: 'form-label', for: 'up-kind-' + n, text: msg('docKind') }), kindSel]),
        h('div', { class: 'form-group' }, [
          h('label', { class: 'form-label', for: 'up-file-' + n }, [msg('docFile') + ' ', h('span', { class: 'req', text: '*' })]), fileIn,
          h('span', { class: 'form-hint', id: 'up-hint-' + n, text: msg('docFileHint') }),
          h('span', { class: 'form-error' })
        ])
      ]),
      h('div', null, [submit]),
      status
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clear(status); fieldError(fileIn, null);
      var f = fileIn.files && fileIn.files[0];
      if (!f) { fieldError(fileIn, msg('pickFile')); fileIn.focus(); return; }
      var ext = (String(f.name).split('.').pop() || '').toLowerCase();
      var mime = f.type || EXT_MIME[ext] || '';
      if (ALLOWED_MIME.indexOf(mime) === -1 || !EXT_MIME[ext]) { fieldError(fileIn, msg('badType')); fileIn.focus(); return; }
      if (f.size <= 0 || f.size > MAX_BYTES) { fieldError(fileIn, msg('tooBig')); fileIn.focus(); return; }
      var file = f.type ? f : new File([f], f.name, { type: mime });
      submit.disabled = true; fileIn.disabled = true; kindSel.disabled = true;
      status.appendChild(h('p', { class: 'portal-loading', role: 'status' }, [h('span', { class: 'dot dot-pulse' }), msg('uploading')]));
      api.uploadDocument({ file: file, transactionId: tx.id, kind: kindSel.value, source: 'upload' }).then(function (r) {
        submit.disabled = false; fileIn.disabled = false; kindSel.disabled = false;
        clear(status);
        if (r.error && r.data) { status.appendChild(alertBox('warning', msg('uploadPartial'))); onDone(); return; }
        if (r.error) { status.appendChild(alertBox('danger', errText(r.error))); return; }
        form.reset();
        status.appendChild(alertBox('success', msg('uploadOk')));
        toast(msg('uploadOk'), 'success');
        onDone();
      });
    });
    return form;
  }

  /* ======================================================================
     MY CONTAINERS (G6a §2.1) — RLS read of the client's transactions' containers
     ====================================================================== */
  var ctrPanel = $('[data-ctr-panel]');
  var ctrSeq = 0;
  function dueBadge(c) {
    if (!c || OPEN_RETURNS.indexOf(c.return_status) === -1 || !c.return_deadline) return null;
    var dl = riyadhDay(c.return_deadline), today = riyadhDay(new Date());
    if (!dl || !today) return null;
    var left = dayNo(dl) - dayNo(today);
    if (left < 0) return h('span', { class: 'badge badge-danger', 'data-due': 'overdue', text: msg('dueOverdue', { n: -left }) });
    if (left === 0) return h('span', { class: 'badge badge-warning', 'data-due': 'today', text: msg('dueToday') });
    if (left <= 3) return h('span', { class: 'badge badge-warning', 'data-due': 'soon', text: msg('dueSoon', { n: left }) });
    return null;
  }
  function loadContainers() {
    if (!ctrPanel) return;
    var seq = ++ctrSeq;
    state.ctr.loaded = true;
    clear(ctrPanel);
    var chk = h('input', { type: 'checkbox', id: 'ctr-open-only', 'data-ctr-open-only': '' });
    chk.checked = !!state.ctr.openOnly;
    chk.addEventListener('change', function () { state.ctr.openOnly = chk.checked; loadContainers(); });
    ctrPanel.appendChild(h('div', { class: 'portal-toolbar' }, [
      h('div', null, [h('h3', { class: 'portal-h', text: msg('ctrTabTitle') }), h('p', { class: 'text-muted text-sm mb-0', text: msg('ctrTabIntro') })]),
      h('label', { class: 'check', for: 'ctr-open-only' }, [chk, ' ', h('span', { text: msg('openOnly') })])
    ]));
    var body = h('div', { 'data-ctr-body': '' });
    ctrPanel.appendChild(body);
    if (typeof api.listMyContainers !== 'function') { chk.disabled = true; body.appendChild(unavailableBox()); return; }
    body.appendChild(loadingBox());
    api.listMyContainers({ openOnly: !!state.ctr.openOnly }).then(function (r) {
      if (seq !== ctrSeq) return;
      clear(body);
      if (r.error) {
        if (isMissing(r.error)) { chk.disabled = true; body.appendChild(unavailableBox()); }
        else body.appendChild(errorBox(r.error, loadContainers));
        return;
      }
      var rows = (r.data || []).slice();
      setCount('containers', rows.length);   // what the table shows (open returns only, by default)
      if (!rows.length) { body.appendChild(alertBox('info', msg(state.ctr.openOnly ? 'noOpenContainers' : 'noMyContainers'))); return; }
      // nearest deadline first, no deadline last (the API orders the same way; kept stable here)
      rows.sort(function (a, b) {
        var x = riyadhDay(a.return_deadline), y = riyadhDay(b.return_deadline);
        if (x !== y) { if (!x) return 1; if (!y) return -1; return x < y ? -1 : 1; }
        return String(a.container_no).localeCompare(String(b.container_no));
      });
      var tbody = h('tbody');
      rows.forEach(function (c) {
        var ref = c.transactions && c.transactions.ref;
        tbody.appendChild(h('tr', { 'data-container': c.id || null }, [
          h('td', null, [num(c.container_no)]),
          h('td', null, [txLink(c.transaction_id, ref)]),
          h('td', null, [num(c.container_type)]),
          h('td', { text: c.operational_state ? codeText('ctr', c.operational_state) : '—' }),
          h('td', null, [statusBadge('container_return_status', c.return_status)]),
          h('td', { text: c.return_deadline ? fmtDate(c.return_deadline) : '—' }),
          h('td', null, [dueBadge(c) || '—']),
          h('td', { text: c.returned_at ? fmtDate(c.returned_at) : '—' })
        ]));
      });
      body.appendChild(table('table table-striped portal-ctr-table', msg('tabContainers'),
        [msg('colCtrNo'), msg('colTx'), msg('colCtrType'), msg('colOpState'), msg('colReturn'), msg('colDeadline'), msg('colDue'), msg('colReturnedAt')], tbody));
      body.appendChild(h('p', { class: 'text-xs text-muted mt-2', text: msg('ctrNote') }));
    });
  }

  /* ======================================================================
     MY INVOICES (G6a §2.1 / G6a-1)
     ====================================================================== */
  var invPanel = $('[data-inv-panel]');
  var invSeq = 0;
  function loadInvoices() {
    if (!invPanel) return;
    var seq = ++invSeq;
    state.inv.loaded = true;
    clear(invPanel);
    invPanel.appendChild(h('h3', { class: 'portal-h', text: msg('invTabTitle') }));
    invPanel.appendChild(h('p', { class: 'text-muted text-sm', text: msg('invNote') }));
    var body = h('div', { 'data-inv-body': '' });
    invPanel.appendChild(body);
    body.appendChild(loadingBox());
    invoicesOf().then(function (r) {
      if (seq !== invSeq) return;
      clear(body);
      if (!r || r.unavailable) { body.appendChild(unavailableBox()); return; }
      if (r.error) { body.appendChild(errorBox(r.error, loadInvoices)); return; }
      var items = invoiceItems(r);
      setCount('invoices', items.length);
      if (!items.length) { body.appendChild(alertBox('info', msg('noInvoices'))); return; }
      body.appendChild(invoiceTable(items, true));
    });
  }

  /* ======================================================================
     SERVICE REQUESTS
     ====================================================================== */
  var reqList = $('[data-req-list]'), reqDetail = $('[data-req-detail]');
  var reqSeq = 0;
  function showReqList() {
    reqSeq++;
    clear(reqDetail); reqDetail.hidden = true; reqList.hidden = false;
  }
  function newRequestBtn() { return h('p', { class: 'mt-2' }, [h('a', { class: 'btn btn-primary btn-sm', href: 'request.html', text: msg('newRequest') })]); }
  function loadRequests() {
    clear(reqList).appendChild(loadingBox());
    return api.listRequests({ limit: 100 }).then(function (r) {
      clear(reqList);
      if (r.error) { reqList.appendChild(errorBox(r.error, loadRequests)); return; }
      var rows = r.data || [];
      setCount('req', rows.length);
      if (!rows.length) {
        reqList.appendChild(alertBox('info', msg('noReq')));
        reqList.appendChild(newRequestBtn());
        return;
      }
      var tbody = h('tbody');
      rows.forEach(function (q) {
        state.reqCache[q.id] = q;
        tbody.appendChild(h('tr', null, [
          h('td', null, [num(q.ref)]),
          h('td', { text: fmtDate(q.created_at) }),
          h('td', { text: opText(q.direction, q.mode) }),
          h('td', { text: q.port || '—' }),
          h('td', null, [statusBadge('request_status', q.status)]),
          h('td', null, [h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: msg('details'),
            'aria-label': msg('details') + ' ' + (q.ref || ''), onclick: function () { go('req/' + q.id); } })])
        ]));
      });
      reqList.appendChild(table('table table-striped', msg('tabReq'),
        [msg('colReqRef'), msg('colSent'), msg('colOperation'), msg('colPort'), msg('colStatus'), ''], tbody));
      reqList.appendChild(newRequestBtn());
    });
  }
  function openRequest(id) {
    var seq = ++reqSeq;
    reqList.hidden = true; reqDetail.hidden = false;
    clear(reqDetail).appendChild(loadingBox());
    var cached = state.reqCache[id];
    var p = cached ? Promise.resolve({ data: cached, error: null })
      : (typeof api.getRequest === 'function' ? api.getRequest(id) : Promise.resolve({ data: null, error: null }));
    p.then(function (r) {
      if (seq !== reqSeq) return;
      clear(reqDetail);
      reqDetail.appendChild(backBtn('req'));
      if (r.error) { reqDetail.appendChild(errorBox(r.error, function () { openRequest(id); })); return; }
      if (!r.data) { reqDetail.appendChild(alertBox('warning', msg('reqNotFound'))); return; }
      paintRequest(r.data);
    });
  }
  function paintRequest(q) {
    reqDetail.appendChild(h('div', { class: 'portal-detail-head' }, [
      h('div', null, [h('p', { class: 'eyebrow mb-1', text: msg('eyebrowReq') }), h('h3', { class: 'mb-0' }, [num(q.ref)])]),
      statusBadge('request_status', q.status)
    ]));
    var docs = (q.declared_documents || []).map(function (d) { return d && d.name; }).filter(Boolean);
    reqDetail.appendChild(h('section', { class: 'card' }, [
      kvList([
        [msg('kSent'), fmtDate(q.created_at, true)],
        [msg('kRequester'), q.full_name], [msg('kCompany'), q.company],
        [msg('kOperation'), q.direction ? codeText('dir', q.direction) : null], [msg('kMode'), q.mode ? codeText('mode', q.mode) : null],
        [msg('kService'), q.service], [msg('kReqCountry'), q.country], [msg('kPort'), q.port], [msg('kGoods'), q.goods],
        [msg('kBl'), q.bl_number ? num(q.bl_number) : null], [msg('kEta'), q.eta ? fmtDate(q.eta) : null],
        [msg('kDeclaredDocs'), docs.length ? docs.join(msg('listSep')) : null],
        q.status_note ? [msg('kTeamNote'), q.status_note] : null,
        q.reviewed_at ? [msg('kReviewed'), fmtDate(q.reviewed_at, true)] : null
      ]),
      q.status === 'converted' ? h('p', { class: 'text-sm mt-2', text: msg('convertedNote') }) : null,
      h('p', { class: 'text-xs text-muted mt-2', text: msg('declaredNote') })
    ]));
  }

  /* ======================================================================
     LINK A REQUEST (ref + token) — verification + staff-reviewed link request
     ====================================================================== */
  var linkForm = $('#link-form'), linkResult = $('[data-link-result]');
  if (linkForm) linkForm.addEventListener('submit', function (e) {
    e.preventDefault();
    clear(linkResult);
    var refIn = $('#lk-ref'), tokIn = $('#lk-token');
    var ref = normDigits(refIn.value).trim().toUpperCase(), tok = normDigits(tokIn.value).trim().toLowerCase();
    var bad = false;
    fieldError(refIn, null); fieldError(tokIn, null);
    if (!/^[A-Z]{2,5}-\d{4}-\d{6,}$/.test(ref)) { fieldError(refIn, msg('refBad')); bad = true; }
    if (!/^[0-9a-f]{64}$/.test(tok)) { fieldError(tokIn, msg('tokenBad')); bad = true; }
    if (bad) { (linkForm.querySelector('[aria-invalid="true"]') || refIn).focus(); return; }
    var btn = linkForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    api.publicTrack(ref, tok).then(function (r) {
      btn.disabled = false;
      tokIn.value = '';   // never keep the secret in the DOM longer than needed
      if (r.error) { linkResult.appendChild(alertBox('danger', errText(r.error))); return; }
      var d = r.data || {};
      var en = lang() === 'en';
      var info = d.kind === 'transaction' && d.transaction
        ? [[msg('lkType'), msg('lkTypeTx')], [msg('colRef'), num(d.transaction.ref)],
           [msg('lkStage'), (en && d.transaction.status_label_en) || d.transaction.status_label_ar]]
        : [[msg('lkType'), msg('lkTypeReq')], [msg('colRef'), num(d.request && d.request.ref)],
           [msg('lkStatus'), d.request && ((en && d.request.status_label_en) || d.request.status_label_ar)],
           [msg('kSent'), d.request ? fmtDate(d.request.created_at) : null]];
      var send = h('button', { class: 'btn btn-primary mt-3', type: 'button', text: msg('lkSend') });
      send.addEventListener('click', function () { requestLink(ref, send); });
      linkResult.appendChild(h('div', { class: 'card card-muted' }, [
        alertBox('success', msg('lkVerified')),
        h('div', { class: 'mt-2' }, [kvList(info)]),
        h('p', { class: 'text-sm mt-2', text: msg('lkExplain') }),
        send
      ]));
    });
  });
  function requestLink(ref, btn) {
    var p = (state.ctx && state.ctx.profile) || {};
    var phone = normPhone(p.phone);
    if (!phone) {
      linkResult.appendChild(alertBox('warning', msg('lkNeedPhone')));
      return;
    }
    btn.disabled = true;
    api.submitContactMessage({
      name: p.full_name || (state.user && state.user.email) || '', company: '', phone: phone,
      email: state.user && state.user.email, subject: 'tracking', reference: ref, preferred: 'email', consent: true,
      // read by the staff inbox: always Arabic
      message: 'طلب ربط من بوابة العميل: أرجو ربط ' + ref + ' بحسابي في البوابة. تحقّق صاحب الحساب من الرقم المرجعي ورمز التتبع في البوابة.'
    }).then(function (r) {
      if (r.error) { btn.disabled = false; linkResult.appendChild(alertBox('danger', errText(r.error))); return; }
      btn.hidden = true;
      linkResult.appendChild(h('div', { class: 'mt-2' }, [alertBox('success', msg('linkSent')),
        r.data && r.data.ref ? h('p', { class: 'text-sm mt-2' }, [msg('lkMsgRef'), num(r.data.ref)]) : null]));
    });
  }

  /* ======================================================================
     PROFILE
     ====================================================================== */
  // MarsaApi has no updateProfile(): implemented here (RLS: profiles_update id = auth.uid())
  function updateProfile(patch) {
    return api.ready().then(function (r) {
      if (r.error || !r.data) return { data: null, error: r.error };
      return r.data.from('profiles').update(patch).eq('id', state.user.id).select('id,full_name,phone,locale').single()
        .then(function (res) { return res.error ? { data: null, error: { message: api.errorMessage(res.error) } } : { data: res.data, error: null }; },
              function (e) { return { data: null, error: { message: api.errorMessage(e) } }; });
    });
  }
  function renderProfile() {
    var p = (state.ctx && state.ctx.profile) || {};
    var nm = $('#pf-name'), ph = $('#pf-phone'), em = $('#pf-email');
    if (nm && !nm.value) nm.value = p.full_name || '';
    if (ph && !ph.value) ph.value = p.phone || '';
    if (em) em.value = (state.user && state.user.email) || '';
    var links = $('[data-profile-links]');
    if (!links) return;
    clear(links);
    var en = lang() === 'en';
    var clients = (state.ctx && state.ctx.clients) || [];
    var mships = (state.ctx && state.ctx.memberships) || [];
    links.appendChild(kvList([
      [msg('kLinkedClients'), clients.length ? clients.map(function (c) { return (en && c.name_en) || c.name_ar; }).join(msg('listSep')) : msg('noneYet')],
      [msg('kMemberships'), mships.length ? mships.map(function (m) {
        var org = (en && m.org_name_en) || m.org_name_ar || m.org_slug;
        var role = (en && m.role_label_en) || m.role_label_ar || m.role;
        var br = (en && m.branch_name_en) || m.branch_name_ar;
        return org + ' — ' + role + (br ? ' (' + br + ')' : '');
      }).join(msg('listSep')) : msg('none')],
      [msg('kCreated'), state.user && state.user.created_at ? fmtDate(state.user.created_at) : null]
    ]));
  }
  var pf = $('#profile-form');
  if (pf) pf.addEventListener('submit', function (e) {
    e.preventDefault();
    var nm = $('#pf-name'), ph = $('#pf-phone'), bad = false;
    fieldError(nm, null); fieldError(ph, null);
    var name = String(nm.value).trim(), phone = ph.value.trim() ? normPhone(ph.value) : '';
    if (name.length < 2 || name.length > 120) { fieldError(nm, msg('name')); bad = true; }
    if (phone === null) { fieldError(ph, msg('phone')); bad = true; }
    if (bad) return;
    var btn = pf.querySelector('button[type="submit"]');
    btn.disabled = true;
    updateProfile({ full_name: name, phone: phone || null }).then(function (r) {
      btn.disabled = false;
      if (r.error) { toast(errText(r.error), 'error'); return; }
      if (state.ctx) state.ctx.profile = Object.assign({}, state.ctx.profile, r.data);
      renderUser();
      toast(msg('profileSaved'), 'success');
    });
  });
  var cp = $('#password-form');
  if (cp) cp.addEventListener('submit', function (e) {
    e.preventDefault();
    var a = $('#pf-pw'), b = $('#pf-pw2'), bad = false;
    fieldError(a, null); fieldError(b, null);
    if (!(a.value.length >= 8 && a.value.length <= 72 && /[A-Za-z؀-ۿ]/.test(a.value) && /\d/.test(a.value))) { fieldError(a, msg('pwRule')); bad = true; }
    if (b.value !== a.value) { fieldError(b, msg('pwMismatch')); bad = true; }
    if (bad) return;
    var btn = cp.querySelector('button[type="submit"]');
    btn.disabled = true;
    api.updatePassword(a.value).then(function (r) {
      btn.disabled = false; a.value = ''; b.value = '';
      if (r.error) { toast(errText(r.error), 'error'); return; }
      toast(msg('pwChanged'), 'success');
    });
  });

  /* ======================================================================
     LANGUAGE SWITCH: repaint what portal.js built (static markup: i18n.js)
     ====================================================================== */
  window.addEventListener('marsa:langchange', function () {
    setShellTitle();
    if (!state.booted) return;
    renderUser();
    renderProfile();
    loadTransactions();
    loadRequests();
    if (state.ctr.loaded) loadContainers();
    if (state.inv.loaded) loadInvoices();
    doRoute();
  });

  /* ======================================================================
     BOOT (guard first)
     ====================================================================== */
  function boot() {
    showView('loading');
    api.getSession().then(function (s) {
      if (s.error) { showView('error'); var m = $('[data-portal-error]'); if (m) m.textContent = errText(s.error); return; }
      if (!s.data) { goLogin(); return; }
      state.user = s.data.user;
      return Promise.all([api.myContext(true), loadLabels()]).then(function (rs) {
        var c = rs[0];
        if (c.error) {
          if (c.error.code === 'MRS_AUTH_REQUIRED') { goLogin(); return; }
          showView('error'); var m = $('[data-portal-error]'); if (m) m.textContent = errText(c.error); return;
        }
        state.ctx = c.data || {};
        renderUser();
        renderProfile();
        showView('app');
        state.booted = true;
        loadTransactions();
        loadRequests();
        doRoute();
      });
    });
  }
  var retry = $('[data-portal-retry]');
  if (retry) retry.addEventListener('click', boot);
  api.onAuth(function (event) { if (event === 'SIGNED_OUT') goLogin(); });
  boot();
})();
