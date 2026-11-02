/* ==========================================================================
   مرسى | MARSA — platform.html  (platform-admin console, STAGING)
   Load order: config.js → i18n.js → assets/i18n/platform.js → assets/i18n/app.js → main.js
               → supa.js → app-shell.js → pwa.js → platform.js  (plain <script defer>)

   * Classic page (marketing header + page-hero + .container sections). The
     optional window.MarsaShell helper (app-shell.js) only sets the document
     title / breadcrumb and provides toast / confirm; without it the page falls
     back to Marsa.toast / window.confirm. The page's own top card keeps the
     sign-out buttons, as in the original design.

   * Platform admins (public.platform_admins, rows added in the SQL Editor
     only) manage ORGANIZATIONS: list, create (org + first branch + admin
     invitation), suspend / reactivate, recent client errors, health check.
     G7: plans (limits, price placeholder), subscriptions (plan / trial /
     period / overrides, suspend / activate with a reason) and usage counts.
     No tenant operational data is read here.
   * Everyone else sees an access-denied state; the RPCs refuse anyway.
   * The admin invitation link is shown ONCE (never stored): copy button +
     warning; "hide" clears it. A replayed create returns token null.
   * Create is idempotent: the page keeps its key until a definite answer
     (MRS_UNKNOWN_RESULT → the same key is re-sent on the next submit).
   * All user / server text is inserted with textContent (no innerHTML of data).
   ========================================================================== */
(function () {
  'use strict';

  var api = window.MarsaApi;
  var I = window.MarsaI18n || null;
  var M = window.Marsa || {};
  var Shell = window.MarsaShell || null;
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // strings live in assets/i18n/platform.js ('platform.*'); the key is returned if it is missing
  function tr(k, vars) {
    var key = 'platform.' + k;
    return I && typeof I.t === 'function' ? I.t(key, vars) : key;
  }
  function lang() { return I && typeof I.lang === 'function' ? I.lang() : 'ar'; }
  function fmtDate(d) {
    if (!d) return '—';
    if (I && typeof I.fmtDate === 'function') return I.fmtDate(d, { time: true }) || '—';
    try { return new Date(d).toLocaleString(); } catch (e) { return String(d); }
  }
  function fmtNum(n) { return I && typeof I.fmtNumber === 'function' ? I.fmtNumber(n || 0) : String(n || 0); }

  // tiny element builder: text only, never HTML
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'class') el.className = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    [].concat(kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
  function toast(text, tone) {
    if (Shell && typeof Shell.toast === 'function') Shell.toast(text, tone);
    else if (M.toast) M.toast(text, tone);
  }
  // Promise<boolean>; the shell dialog when present, else the browser's
  function ask(o) {
    if (Shell && typeof Shell.confirm === 'function') return Promise.resolve(Shell.confirm(o)).then(function (v) { return !!v; });
    return Promise.resolve(window.confirm(o.text || o.title));
  }
  function setShellTitle() {
    if (!Shell) return;
    // no extra crumbs: the hero breadcrumb stays الرئيسية ‹ لوحة المنصة; document.title follows the language
    if (typeof Shell.setTitle === 'function') Shell.setTitle(tr('title'));
    if (typeof Shell.setActive === 'function') Shell.setActive('platform');
  }
  function errText(err) { return (err && err.message) || (api && api.errorMessage ? api.errorMessage(err) : tr('unknownError')); }

  /* ---- gate / messages ---- */
  var gateEl = $('#pf-gate'), appEl = $('#pf-app');
  function gate(name) {
    if (!gateEl) return;
    gateEl.hidden = !name;
    $$('[data-pf-gate]', gateEl).forEach(function (el) { el.hidden = el.getAttribute('data-pf-gate') !== name; });
    if (appEl) appEl.hidden = !!name;
  }
  var msgBox = $('[data-pf-msg]');
  function showMsg(text, type) {
    // short confirmations go to a toast; errors / warnings stay inline (focused)
    if (!msgBox || (type === 'success' && Shell && Shell.toast)) { hideMsg(); toast(text, type === 'danger' ? 'error' : type); return; }
    msgBox.className = 'alert alert-' + (type || 'info') + ' mb-0';
    $('[data-pf-msg-text]', msgBox).textContent = text;
    msgBox.hidden = false;
    try { msgBox.focus({ preventScroll: false }); } catch (e) { msgBox.focus(); }
  }
  function hideMsg() { if (msgBox) msgBox.hidden = true; }
  function busy(btn, on) {
    if (!btn) return;
    if (on) { btn.setAttribute('data-label', btn.textContent); btn.textContent = tr('working'); btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    else {
      if (btn.getAttribute('data-label')) btn.textContent = btn.getAttribute('data-label');
      btn.removeAttribute('data-label'); btn.disabled = false; btn.removeAttribute('aria-busy');
    }
  }

  /* ======================================================================
     HEALTH
     ====================================================================== */
  function runHealth() {
    var btn = $('[data-pf-health-run]');
    busy(btn, true);
    var t0 = Date.now();
    return api.healthCheck().then(function (r) {
      busy(btn, false);
      var ms = Date.now() - t0;
      var okEl = $('[data-pf-health-ok]');
      var set = function (sel, v) { var el = $(sel); if (el) el.textContent = v == null || v === '' ? '—' : String(v); };
      var up = !r.error && !!(r.data && r.data.ok);
      kpiHealth(up, ms);
      if (r.error) {
        okEl.textContent = tr('healthFail'); okEl.className = 'pf-bad';
        set('[data-pf-health-time]', '—'); set('[data-pf-health-schema]', '—'); set('[data-pf-health-env]', '—');
        set('[data-pf-health-ms]', ms + ' ms');
        showMsg(errText(r.error), 'danger');
        return;
      }
      var d = r.data || {};
      okEl.textContent = d.ok ? tr('healthOk') : tr('healthFail');
      okEl.className = d.ok ? 'pf-ok' : 'pf-bad';
      set('[data-pf-health-time]', d.db_time ? fmtDate(d.db_time) : '—');
      set('[data-pf-health-schema]', d.schema_version);
      set('[data-pf-health-env]', d.environment);
      set('[data-pf-health-ms]', ms + ' ms');
    });
  }

  function kpiHealth(up, ms) {
    var v = $('[data-pf-kpi="health"]'), l = $('[data-pf-kpi="latency"]'), tile = $('[data-pf-kpi-health]');
    if (v) clear(v).appendChild(h('span', { class: 'badge ' + (up ? 'badge-success' : 'badge-danger'), text: up ? tr('healthOk') : tr('healthFail') }));
    if (l) l.textContent = ms + ' ms';
    if (tile) tile.setAttribute('data-tone', up ? 'success' : 'danger');
  }

  /* ======================================================================
     ORGANIZATIONS
     ====================================================================== */
  var orgs = [];
  var orgsBody = $('[data-pf-orgs]');
  var orgFilter = 'all', orgQuery = '';
  function renderKpis() {
    var set = function (k, v) { var el = $('[data-pf-kpi="' + k + '"]'); if (el) el.textContent = fmtNum(v); };
    var active = orgs.filter(function (o) { return o.is_active; }).length;
    set('orgs', orgs.length); set('active', active); set('suspended', orgs.length - active);
    // G7: organizations whose usage is above their effective plan limits (inbound / AI process / attachments are never refused)
    var ov = $('[data-pf-kpi="over"]'), tile = $('[data-pf-kpi-over]');
    if (ov) {
      var n = subsLoaded ? subs.filter(function (x) { return overOf(x).length > 0; }).length : null;
      ov.textContent = n == null ? '—' : fmtNum(n);
      if (tile) tile.setAttribute('data-tone', n ? 'warning' : 'success');
    }
  }
  function orgMatches(o) {
    if (orgFilter === 'active' && !o.is_active) return false;
    if (orgFilter === 'suspended' && o.is_active) return false;
    if (!orgQuery) return true;
    var hay = [o.name_ar, o.name_en, o.slug, o.ref_prefix].join(' ').toLowerCase();
    return hay.indexOf(orgQuery) !== -1;
  }
  function orgName(o) { return (lang() === 'en' && o.name_en) ? o.name_en : (o.name_ar || o.name_en || o.slug || ''); }
  function emptyRow(tbody, cols, text, loading) {
    clear(tbody).appendChild(h('tr', null, h('td', { class: 'pf-empty', colspan: cols, role: loading ? 'status' : null, text: text })));
  }
  function renderOrgs() {
    if (!orgsBody) return;
    renderKpis();
    var shown = orgs.filter(orgMatches);
    var cnt = $('[data-pf-orgs-count]');
    if (cnt) cnt.textContent = orgs.length ? tr(shown.length === orgs.length ? 'orgsCount' : 'orgsShown', { n: fmtNum(shown.length), total: fmtNum(orgs.length) }) : '';
    if (!orgs.length) { emptyRow(orgsBody, 6, tr('orgsEmpty')); return; }
    if (!shown.length) { emptyRow(orgsBody, 6, tr('orgsNoMatch')); return; }
    clear(orgsBody);
    shown.forEach(function (o) {
      var active = !!o.is_active;
      // masked by the server (a***@example.com): the platform does not see tenant user identity
      var admins = Array.isArray(o.admin_emails_masked) ? o.admin_emails_masked : [];
      var btn = h('button', {
        class: 'btn btn-sm ' + (active ? 'btn-ghost' : 'btn-secondary'), type: 'button',
        text: active ? tr('suspend') : tr('reactivate'),
        on: { click: function () { toggleOrg(o, btn); } }
      });
      orgsBody.appendChild(h('tr', { class: active ? null : 'pf-row-off' }, [
        h('td', null, [
          h('strong', { text: orgName(o) }),
          o.name_en && lang() !== 'en' ? h('span', { class: 'pf-sub', dir: 'ltr', text: o.name_en }) : null,
          admins.length ? h('span', { class: 'pf-sub', dir: 'ltr', text: admins.join(', ') }) : null,
          o.pending_admin_invitations ? h('span', { class: 'pf-sub', text: tr('pendingAdminInv', { n: fmtNum(o.pending_admin_invitations) }) }) : null
        ]),
        h('td', null, [
          h('span', { class: 'pf-mono', dir: 'ltr', text: o.slug || '' }),
          h('span', { class: 'pf-sub', dir: 'ltr', text: (o.ref_prefix || '') + (o.environment ? ' · ' + o.environment : '') })
        ]),
        h('td', null, h('span', { class: 'badge ' + (active ? 'badge-success' : 'badge-danger'), text: active ? tr('statusActive') : tr('statusSuspended') })),
        h('td', { dir: 'ltr', text: fmtNum(o.branches) + ' / ' + fmtNum(o.members) + ' / ' + fmtNum(o.admins) }),
        h('td', { class: 'pf-nowrap', text: fmtDate(o.created_at) }),
        h('td', null, h('div', { class: 'pf-row-actions' }, [btn, active && !o.admins ? reissueBtn(o) : null]))
      ]));
    });
  }
  function loadOrgs() {
    if (orgsBody) emptyRow(orgsBody, 6, tr('loading'), true);
    return api.platformListOrgs().then(function (r) {
      if (r.error) { emptyRow(orgsBody, 6, errText(r.error)); return; }
      orgs = Array.isArray(r.data) ? r.data : [];
      renderOrgs();
    });
  }
  // org without an active admin (first link lost or expired): new one-time admin link
  function reissueBtn(o) {
    var b = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: tr('reissueAdmin'),
                          on: { click: function () { reissueAdmin(o, b); } } });
    return b;
  }
  function reissueAdmin(o, b) {
    ask({ title: tr('reissueAdmin'), text: tr('confirmReissue', { name: orgName(o) }), okText: tr('reissueAdmin') }).then(function (yes) {
      if (yes) doReissueAdmin(o, b);
    });
  }
  function doReissueAdmin(o, b) {
    hideMsg();
    busy(b, true);
    api.platformReissueAdminInvitation(o.id).then(function (r) {
      busy(b, false);
      if (r.error) { showMsg(errText(r.error), 'danger'); return; }
      var d = r.data || {};
      showInvite({ token: d.token, accept_path: d.accept_path, slug: o.slug, email: d.email }, {}, tr('reissued', { slug: o.slug }));
      loadOrgs();
    });
  }
  // G7: suspend = platform_suspend_org (subscription suspended + org cut off), reactivate = platform_activate_org
  // (subscription active + org switched on; also ends an old operational pause) — both with a reason and an event.
  // The old platform_set_org_active RPC stays server-side; legacyToggleOrg is kept only as the fallback for an
  // older supa.js without the G7 functions.
  function toggleOrg(o, btn) {
    if (typeof api.platformSuspendOrg !== 'function' || typeof api.platformActivateOrg !== 'function') { legacyToggleOrg(o, btn); return; }
    var s = subFor(o.id);
    var row = s || { org_id: o.id, slug: o.slug, name_ar: o.name_ar, name_en: o.name_en, status: o.is_active ? 'active' : 'suspended' };
    if (o.is_active) openSuspend(row); else openActivate(row);
  }
  function legacyToggleOrg(o, btn) {
    var activate = !o.is_active;
    var q = activate ? tr('confirmReactivate', { name: orgName(o) }) : tr('confirmSuspend', { name: orgName(o) });
    ask({ title: activate ? tr('confirmReactivateTitle') : tr('confirmSuspendTitle'), text: q,
          okText: activate ? tr('reactivate') : tr('suspend'), danger: !activate }).then(function (yes) {
      if (yes) doToggleOrg(o, btn, activate);
    });
  }
  function doToggleOrg(o, btn, activate) {
    hideMsg();
    busy(btn, true);
    api.platformSetOrgActive(o.id, activate).then(function (r) {
      busy(btn, false);
      if (r.error) { showMsg(errText(r.error), 'danger'); return; }
      showMsg(activate ? tr('reactivated', { name: orgName(o) }) : tr('suspended', { name: orgName(o) }), 'success');
      loadOrgs();
    });
  }

  /* ======================================================================
     RECENT CLIENT ERRORS
     ====================================================================== */
  var errs = [];
  var errBody = $('[data-pf-errors]');
  function errOrgLabel(e) {
    if (e.org_slug) return e.org_slug;
    if (e.org_id) {
      var o = orgs.filter(function (x) { return x.id === e.org_id; })[0];
      return o ? o.slug : String(e.org_id).slice(0, 8);
    }
    return tr('noOrg');
  }
  function renderErrors() {
    if (!errBody) return;
    if (!errs.length) { emptyRow(errBody, 5, tr('errorsEmpty')); return; }
    clear(errBody);
    errs.forEach(function (e) {
      errBody.appendChild(h('tr', null, [
        h('td', { class: 'pf-nowrap', text: fmtDate(e.created_at) }),
        h('td', { class: 'pf-mono', dir: 'ltr', text: errOrgLabel(e) }),
        h('td', { class: 'pf-mono', dir: 'ltr', text: e.page || '—' }),
        h('td', { class: 'pf-mono', dir: 'ltr', text: e.code || '—' }),
        h('td', { class: 'pf-msg-cell', dir: 'ltr', text: e.message || '' })
      ]));
    });
  }
  function loadErrors() {
    if (errBody) emptyRow(errBody, 5, tr('loading'), true);
    return api.platformRecentErrors().then(function (r) {
      if (r.error) { emptyRow(errBody, 5, errText(r.error)); return; }
      errs = Array.isArray(r.data) ? r.data : ((r.data && r.data.rows) || []);
      renderErrors();
    });
  }

  /* ======================================================================
     CREATE ORGANIZATION
     ====================================================================== */
  var form = $('#pf-create-form');
  var createKey = null, createKeyFor = null;   // idempotency key kept until a definite answer
  function fieldError(input, msg) {
    var g = input.closest('.form-group');
    if (!g) return;
    var err = g.querySelector('.form-error');
    if (msg) { g.classList.add('has-error'); input.setAttribute('aria-invalid', 'true'); if (err) err.textContent = msg; }
    else { g.classList.remove('has-error'); input.removeAttribute('aria-invalid'); }
  }
  function val(id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
  function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 160; }
  function readForm() {
    var bad = [];
    var slug = val('pf-slug').toLowerCase(), prefix = val('pf-prefix').toUpperCase(), code = val('pf-br-code').toUpperCase();
    var nameAr = val('pf-name-ar'), nameEn = val('pf-name-en'), brAr = val('pf-br-name-ar'), brEn = val('pf-br-name-en');
    var city = val('pf-br-city'), email = val('pf-admin-email').toLowerCase();
    $$('.form-control', form).forEach(function (i) { fieldError(i, null); });
    function chk(id, okv, msgKey) { if (!okv) { bad.push(id); fieldError(document.getElementById(id), tr(msgKey)); } }
    chk('pf-name-ar', nameAr.length >= 2 && nameAr.length <= 120, nameAr ? 'errName' : 'errRequired');
    chk('pf-name-en', nameEn.length <= 120, 'errTooLong');
    chk('pf-slug', /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug), 'errSlug');
    chk('pf-prefix', /^[A-Z]{2,5}$/.test(prefix), 'errPrefix');
    chk('pf-br-code', /^[A-Z0-9]{2,10}$/.test(code), 'errCode');
    chk('pf-br-name-ar', brAr.length >= 2 && brAr.length <= 120, brAr ? 'errName' : 'errRequired');
    chk('pf-br-name-en', brEn.length <= 120, 'errTooLong');
    chk('pf-br-city', city.length <= 80, 'errTooLong');
    chk('pf-admin-email', validEmail(email), 'errEmail');
    if (bad.length) { var f = document.getElementById(bad[0]); if (f) f.focus(); return null; }
    var payload = {
      slug: slug, name_ar: nameAr, ref_prefix: prefix, default_locale: val('pf-locale') === 'en' ? 'en' : 'ar',
      branch: { code: code, name_ar: brAr }, admin_email: email
    };
    if (nameEn) payload.name_en = nameEn;
    if (brEn) payload.branch.name_en = brEn;
    if (city) payload.branch.city = city;
    return payload;
  }
  // map a server field (DETAIL) back to its input
  var FIELD_INPUT = { slug: 'pf-slug', slug_taken: 'pf-slug', name_ar: 'pf-name-ar', name_en: 'pf-name-en', ref_prefix: 'pf-prefix',
    default_locale: 'pf-locale', admin_email: 'pf-admin-email', code: 'pf-br-code', city: 'pf-br-city', branch: 'pf-br-code' };
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      hideMsg();
      var payload = readForm();
      if (!payload) return;
      var fp = JSON.stringify(payload);
      if (!createKey || createKeyFor !== fp) { createKey = api.newIdemKey(); createKeyFor = fp; }   // new data → new key
      payload.idempotencyKey = createKey;
      var submit = form.querySelector('button[type="submit"]');
      busy(submit, true);
      api.platformCreateOrg(payload).then(function (r) {
        busy(submit, false);
        if (r.error) {
          if (r.error.code !== 'MRS_UNKNOWN_RESULT' && r.error.code !== 'MRS_IN_PROGRESS') { createKey = null; createKeyFor = null; }
          var inputId = r.error.field && FIELD_INPUT[r.error.field];
          if (inputId) { var inp = document.getElementById(inputId); if (inp) { fieldError(inp, errText(r.error)); inp.focus(); } }
          showMsg(errText(r.error), r.error.code === 'MRS_UNKNOWN_RESULT' ? 'warning' : 'danger');
          return;
        }
        createKey = null; createKeyFor = null;
        var d = r.data || {};
        form.reset();
        showInvite(d, payload);
        loadOrgs();
      });
    });
    form.addEventListener('reset', function () {
      createKey = null; createKeyFor = null;
      $$('.form-control', form).forEach(function (i) { fieldError(i, null); });
    });
  }

  /* ---- one-time invite link ---- */
  var inviteBox = $('[data-pf-invite]'), inviteInput = $('[data-pf-invite-link]');
  function inviteUrl(d) {
    var tok = String(d.token || '');
    if (!/^[0-9a-f]{64}$/i.test(tok)) return null;
    // only ever build a link to our own login page (never trust a path from data blindly)
    var path = /^login\.html\?invite=[0-9a-f]{64}$/i.test(String(d.accept_path || '')) ? d.accept_path : 'login.html?invite=' + tok;
    try { return new URL(path, location.href).href; } catch (e) { return null; }
  }
  function showInvite(d, payload, okText) {
    var url = inviteUrl(d);
    var title = $('[data-pf-invite-title]');
    if (!url) {
      // replay of an earlier create: the server never stores the token
      hideInvite();
      showMsg(tr('tokenShown', { slug: d.slug || payload.slug }), 'warning');
      return;
    }
    if (title) title.textContent = tr('inviteFor', { slug: d.slug || payload.slug, email: d.email || payload.admin_email });
    inviteInput.value = url;
    inviteBox.hidden = false;
    showMsg(okText || tr('created', { slug: d.slug || payload.slug }), 'success');
    try { inviteInput.focus(); inviteInput.select(); } catch (e) { /* ignore */ }
  }
  function hideInvite() {
    if (inviteInput) inviteInput.value = '';
    if (inviteBox) inviteBox.hidden = true;
  }
  var copyBtn = $('[data-pf-copy]');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    var v = inviteInput.value;
    if (!v) return;
    var done = function () { showMsg(tr('copied'), 'success'); };
    var fallback = function () {
      try { inviteInput.focus(); inviteInput.select(); document.execCommand('copy'); done(); }
      catch (e) { showMsg(tr('copyFail'), 'warning'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, fallback);
    else fallback();
  });
  var doneBtn = $('[data-pf-invite-done]');
  if (doneBtn) doneBtn.addEventListener('click', function () { hideInvite(); hideMsg(); });
  // never keep the link around when the page is left / restored from bfcache
  window.addEventListener('pagehide', hideInvite);

  /* ======================================================================
     G7 — PLANS, SUBSCRIPTIONS & USAGE  (docs/online/G7_SPEC.md §Front end)
     Counts only (no tenant rows). The limits are enforced by the server
     (MRS_PLAN_LIMIT / MRS_PLAN_INACTIVE); this page only shows usage and
     sends the platform admin's decisions, each with a mandatory reason.
     Storage limits are stored in MB and entered / shown in GB.
     ====================================================================== */
  var METRICS = ['users', 'branches', 'transactions_month', 'storage_mb', 'messages_month', 'ai_runs_month'];
  var STATUS_BADGE = { trial: 'badge-blue', active: 'badge-success', suspended: 'badge-danger', cancelled: 'badge-muted' };
  var plans = [], subs = [], subsLoaded = false;
  var plansBody = $('[data-pf-plans]'), subsBody = $('[data-pf-subs]');
  var SUBS_COLS = 11, PLANS_COLS = 12;

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function num(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : null;
  }
  function fmtDec(n) { return I && typeof I.fmtNumber === 'function' ? I.fmtNumber(n) : String(Math.round(n * 100) / 100); }
  function fmtGb(mb) { return tr('gbValue', { n: fmtDec(mb / 1024) }); }
  function fmtDay(d) {
    if (!d) return '—';
    if (I && typeof I.fmtDate === 'function') return I.fmtDate(d) || String(d);
    return String(d).slice(0, 10);
  }
  function fmtPrice(p) {
    var n = num(p);
    if (n == null) return tr('notPriced');
    var s = I && typeof I.fmtMoney === 'function' ? I.fmtMoney(n, 'SAR') : n.toFixed(2) + ' SAR';
    return tr('pricePerMonth', { price: s });
  }
  function metricLabel(k) { return tr('metric_' + k); }
  function limitText(k, v) {
    var n = num(v);
    if (n == null) return tr('unlimited');
    return k === 'storage_mb' ? fmtGb(n) : fmtNum(n);
  }
  function usedText(k, v) {
    var n = num(v) || 0;
    if (k !== 'storage_mb') return fmtNum(n);
    return n < 1024 ? tr('mbValue', { n: fmtNum(n) }) : fmtGb(n);
  }
  function statusLabel(st) { var s = tr('sub_' + st); return s === 'platform.sub_' + st ? String(st || '—') : s; }
  function statusBadge(st) { return h('span', { class: 'badge ' + (STATUS_BADGE[st] || 'badge-muted'), text: statusLabel(st) }); }
  function planName(p) { return (lang() === 'en' && p.name_en) ? p.name_en : (p.name_ar || p.name_en || p.code || ''); }
  function subPlanName(s) { return (lang() === 'en' && s.plan_name_en) ? s.plan_name_en : (s.plan_name_ar || s.plan_name_en || s.plan_code || '—'); }
  function subOrgName(s) { return (lang() === 'en' && s.name_en) ? s.name_en : (s.name_ar || s.name_en || s.slug || ''); }
  function overOf(s) {
    var a = (s && Array.isArray(s.over_limit)) ? s.over_limit : (s && s.usage && Array.isArray(s.usage.over_limit) ? s.usage.over_limit : []);
    return a.filter(function (k) { return METRICS.indexOf(k) !== -1; });
  }
  function subFor(orgId) { return subs.filter(function (s) { return s.org_id === orgId; })[0] || null; }
  function isStopped(st) { return st === 'suspended' || st === 'cancelled'; }
  // review fix: an org paused through organizations.is_active (legacy pause, or a pre-G7 inactive org backfilled as
  // pilot / active) is not "active" whatever its subscription status says
  function isPaused(s) { return !!s && s.is_active === false && !isStopped(s.status); }
  // review fix: the server decides (platform_list_subscriptions.trial_expired, same rule as app.g7_assert_active);
  // fallback only for an older server: compare with today's Asia/Riyadh date (never the browser's local date)
  function riyadhToday() {
    try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function isTrialExpired(s) {
    if (!s || s.status !== 'trial') return false;
    if (has(s, 'trial_expired')) return s.trial_expired === true;
    return !!s.period_end && String(s.period_end).slice(0, 10) < riyadhToday();
  }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function validDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }

  /* ---- generic adm-dialog (original admin.html dialog markup) ---- */
  function xIcon() {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'icon'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M6 6l12 12M18 6 6 18');
    s.appendChild(p);
    return s;
  }
  function openDlg(dlg) {
    if (dlg.open) return;
    if (typeof dlg.showModal === 'function') { try { dlg.showModal(); return; } catch (e) { /* not connected / unsupported */ } }
    dlg.setAttribute('open', '');
  }
  function closeDlg(dlg) {
    if (typeof dlg.close === 'function' && dlg.open) { try { dlg.close(); return; } catch (e) { /* fall through */ } }
    dlg.removeAttribute('open');
  }
  function mkDialog(id, title, opts) {
    opts = opts || {};
    var old = document.getElementById(id);
    if (old && old.parentNode) { closeDlg(old); old.parentNode.removeChild(old); }
    var dlg = h('dialog', { class: 'adm-dialog' + (opts.wide ? ' adm-dialog-wide' : ''), id: id, 'aria-labelledby': id + '-title', 'data-pf-dialog': id });
    var form = h('form', { class: 'adm-dialog-form', novalidate: true });
    var x = h('button', { class: 'adm-dialog-x', type: 'button', 'aria-label': tr('close'), on: { click: function () { closeDlg(dlg); } } }, xIcon());
    var body = h('div', { class: 'adm-dialog-body' });
    var err = h('div', { class: 'alert alert-danger adm-dialog-error', role: 'alert', hidden: true, 'data-pf-dialog-error': true });
    var foot = h('div', { class: 'adm-dialog-foot' });
    form.appendChild(h('div', { class: 'adm-dialog-head' }, [h('h2', { id: id + '-title', text: title }), x]));
    form.appendChild(body); form.appendChild(err); form.appendChild(foot);
    dlg.appendChild(form);
    document.body.appendChild(dlg);
    return {
      dlg: dlg, form: form, body: body, foot: foot,
      error: function (text) { err.textContent = text || ''; err.hidden = !text; },
      open: function () { openDlg(dlg); },
      close: function () { closeDlg(dlg); }
    };
  }
  // one labelled control (input / select / textarea / checkbox) in the original form-group markup
  function fieldEl(o) {
    var ctl;
    if (o.type === 'select') {
      ctl = h('select', { class: 'form-control', id: o.id, name: o.name || o.id });
      (o.options || []).forEach(function (op) { ctl.appendChild(h('option', { value: op.value, text: op.label })); });
      if (o.value != null) ctl.value = String(o.value);
    } else if (o.type === 'textarea') {
      ctl = h('textarea', { class: 'form-control', id: o.id, name: o.name || o.id, rows: o.rows || 3, maxlength: o.max || 2000 });
      ctl.value = o.value == null ? '' : String(o.value);
    } else if (o.type === 'checkbox') {
      ctl = h('input', { type: 'checkbox', id: o.id, name: o.name || o.id, disabled: o.disabled ? true : null });
      ctl.checked = !!o.value;
      return { group: h('div', { class: 'form-group' + (o.full ? ' adm-full' : '') }, [
        h('label', { class: 'check', for: o.id }, [ctl, ' ', o.label]),
        o.hint ? h('span', { class: 'form-hint', text: o.hint }) : null
      ]), input: ctl };
    } else {
      ctl = h('input', { class: 'form-control', id: o.id, name: o.name || o.id, type: o.type || 'text', dir: o.dir || null,
        min: o.min != null ? o.min : null, step: o.step || null, inputmode: o.inputmode || null, maxlength: o.max || null,
        readonly: o.readonly ? true : null, autocomplete: 'off', spellcheck: o.dir === 'ltr' ? 'false' : null, placeholder: o.placeholder || null });
      ctl.value = o.value == null ? '' : String(o.value);
    }
    if (o.required) ctl.setAttribute('aria-required', 'true');
    var hintId = o.hint ? o.id + '-hint' : null;
    if (hintId) ctl.setAttribute('aria-describedby', hintId);
    return { group: h('div', { class: 'form-group' + (o.full ? ' adm-full' : '') }, [
      h('label', { class: 'form-label', for: o.id }, [o.label, o.required ? ' ' : null, o.required ? h('span', { class: 'req', text: '*' }) : null]),
      ctl,
      hintId ? h('span', { class: 'form-hint', id: hintId, text: o.hint }) : null,
      h('span', { class: 'form-error' })
    ]), input: ctl };
  }
  function grid(kids) { return h('div', { class: 'adm-form-grid' }, kids); }
  function footButtons(d, okText, danger) {
    var ok = h('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), type: 'submit', text: okText, 'data-pf-dialog-ok': true });
    var cancel = h('button', { class: 'btn btn-ghost', type: 'button', text: tr('cancel'), on: { click: d.close } });
    d.foot.appendChild(ok); d.foot.appendChild(cancel);
    return ok;
  }
  function inputVal(inp) { return String((inp && inp.value) || '').trim(); }
  // limit inputs: empty = unlimited (plan) / no override (subscription); storage in GB, sent as MB
  function limitInputs(prefix, values, emptyHint) {
    var map = {}, groups = [];
    METRICS.forEach(function (k) {
      var v = values && has(values, k) ? num(values[k]) : null;
      var shown = v == null ? '' : (k === 'storage_mb' ? String(Math.round(v / 1024 * 1000) / 1000) : String(v));
      var f = fieldEl({ id: prefix + '-' + k, label: k === 'storage_mb' ? tr('limitStorageGb') : metricLabel(k), type: 'number',
        min: 0, step: k === 'storage_mb' ? 'any' : 1, inputmode: k === 'storage_mb' ? 'decimal' : 'numeric', dir: 'ltr',
        value: shown, placeholder: emptyHint });
      map[k] = f.input; groups.push(f.group);
    });
    return { inputs: map, groups: groups };
  }
  // → {ok:true, values:{k: n|null}} or {ok:false, input}
  function readLimits(map) {
    var out = {};
    for (var i = 0; i < METRICS.length; i++) {
      var k = METRICS[i], inp = map[k], s = inputVal(inp);
      fieldError(inp, null);
      if (s === '') { out[k] = null; continue; }
      var n = Number(s);
      if (k === 'storage_mb') {
        if (!isFinite(n) || n < 0 || n > 1e6) { fieldError(inp, tr('errLimit')); return { ok: false, input: inp }; }
        out[k] = Math.round(n * 1024);
      } else {
        if (!/^\d+$/.test(s) || n > 1e9) { fieldError(inp, tr('errLimit')); return { ok: false, input: inp }; }
        out[k] = n;
      }
    }
    return { ok: true, values: out };
  }

  /* ---- plans ---- */
  function renderPlans() {
    if (!plansBody) return;
    if (!plans.length) { emptyRow(plansBody, PLANS_COLS, tr('plansEmpty')); return; }
    clear(plansBody);
    plans.forEach(function (p) {
      var lim = p.limits || {};
      var cells = [
        h('td', null, h('span', { class: 'pf-mono', dir: 'ltr', text: p.code })),
        h('td', null, [h('strong', { text: planName(p) }),
          p.name_en && lang() !== 'en' ? h('span', { class: 'pf-sub', dir: 'ltr', text: p.name_en }) : null,
          p.notes ? h('span', { class: 'pf-sub', text: p.notes }) : null])
      ];
      METRICS.forEach(function (k) {
        var v = num(lim[k]);
        cells.push(h('td', { class: 'num pf-nowrap' + (v == null ? ' pf-unlimited' : '') }, h('span', { text: limitText(k, v) })));
      });
      cells.push(h('td', { class: 'pf-nowrap' + (num(p.price_monthly_sar) == null ? ' pf-unlimited' : ''), text: fmtPrice(p.price_monthly_sar) }));
      cells.push(h('td', { class: 'num', text: fmtNum(p.orgs) }));
      cells.push(h('td', null, h('span', { class: 'badge ' + (p.is_active ? 'badge-success' : 'badge-muted'), text: p.is_active ? tr('planActive') : tr('planInactive') })));
      var edit = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: tr('edit'), 'data-pf-plan-edit': p.code,
        on: { click: function () { openPlanDialog(p); } } });
      cells.push(h('td', null, h('div', { class: 'pf-row-actions' }, edit)));
      plansBody.appendChild(h('tr', { class: p.is_active ? null : 'pf-row-off', 'data-pf-plan': p.code }, cells));
    });
  }
  function loadPlans() {
    if (!api || typeof api.platformListPlans !== 'function') return Promise.resolve();
    if (plansBody) emptyRow(plansBody, PLANS_COLS, tr('loading'), true);
    return api.platformListPlans().then(function (r) {
      if (r.error) { emptyRow(plansBody, PLANS_COLS, errText(r.error)); return; }
      plans = (Array.isArray(r.data) ? r.data : []).slice().sort(function (a, b) {
        return (num(a.sort) || 0) - (num(b.sort) || 0) || String(a.code).localeCompare(String(b.code));
      });
      renderPlans();
    });
  }
  var PLAN_FIELD = { code: 'code', name_ar: 'name_ar', name_en: 'name_en', sort: 'sort', notes: 'notes', price_monthly_sar: 'price' };
  function openPlanDialog(p) {
    var isNew = !p;
    p = p || { code: '', name_ar: '', name_en: '', sort: 100, is_active: true, limits: {}, price_monthly_sar: null, notes: '' };
    var d = mkDialog('pf-plan-dialog', isNew ? tr('planNewTitle') : tr('planEditTitle', { name: planName(p) }), { wide: true });
    var f = {
      code: fieldEl({ id: 'pf-plan-code', label: tr('planCode'), required: true, dir: 'ltr', max: 31, value: p.code, readonly: !isNew,
        hint: isNew ? tr('planCodeHint') : tr('planCodeFixed') }),
      name_ar: fieldEl({ id: 'pf-plan-name-ar', label: tr('nameAr'), required: true, max: 80, value: p.name_ar }),
      name_en: fieldEl({ id: 'pf-plan-name-en', label: tr('nameEn'), dir: 'ltr', max: 80, value: p.name_en }),
      sort: fieldEl({ id: 'pf-plan-sort', label: tr('planSort'), type: 'number', step: 1, dir: 'ltr', inputmode: 'numeric', value: p.sort == null ? 100 : p.sort }),
      price: fieldEl({ id: 'pf-plan-price', label: tr('planPrice'), type: 'number', min: 0, step: '0.01', dir: 'ltr', inputmode: 'decimal',
        value: p.price_monthly_sar == null ? '' : p.price_monthly_sar, hint: tr('planPriceHint') }),
      active: fieldEl({ id: 'pf-plan-active', type: 'checkbox', label: tr('planIsActive'), value: p.is_active !== false,
        disabled: p.code === 'pilot', hint: p.code === 'pilot' ? tr('pilotAlwaysActive') : null }),
      notes: fieldEl({ id: 'pf-plan-notes', label: tr('planNotes'), type: 'textarea', rows: 2, max: 2000, value: p.notes, full: true })
    };
    var lim = limitInputs('pf-plan-lim', p.limits || {}, tr('unlimited'));
    d.body.appendChild(h('p', { class: 'text-muted text-sm mb-0', text: tr('planDialogLead') }));
    d.body.appendChild(grid([f.code.group, f.sort.group, f.name_ar.group, f.name_en.group]));
    d.body.appendChild(h('fieldset', { class: 'pf-fieldset' }, [h('legend', { text: tr('limitsLegend') }),
      h('p', { class: 'form-hint mb-0', text: tr('limitsHint') }), grid(lim.groups)]));
    d.body.appendChild(grid([f.price.group, f.active.group, f.notes.group]));
    var ok = footButtons(d, isNew ? tr('planCreate') : tr('save'));
    d.form.addEventListener('submit', function (e) {
      e.preventDefault();
      d.error(null);
      var code = inputVal(f.code.input).toLowerCase(), nameAr = inputVal(f.name_ar.input), nameEn = inputVal(f.name_en.input);
      var sortS = inputVal(f.sort.input), priceS = inputVal(f.price.input), notes = inputVal(f.notes.input);
      [f.code, f.name_ar, f.name_en, f.sort, f.price, f.notes].forEach(function (x) { fieldError(x.input, null); });
      var bad = null;
      function chk(x, cond, key) { if (!cond && !bad) { bad = x.input; fieldError(x.input, tr(key)); } }
      chk(f.code, /^[a-z][a-z0-9_]{1,30}$/.test(code), 'errPlanCode');
      chk(f.name_ar, nameAr.length >= 2 && nameAr.length <= 80, nameAr ? 'errName' : 'errRequired');
      chk(f.name_en, nameEn.length <= 80, 'errTooLong');
      chk(f.sort, sortS === '' || /^-?\d{1,6}$/.test(sortS), 'errInteger');
      chk(f.price, priceS === '' || (isFinite(Number(priceS)) && Number(priceS) >= 0 && /^\d+(\.\d{1,2})?$/.test(priceS)), 'errPrice');
      chk(f.notes, notes.length <= 2000, 'errTooLong');
      var L = readLimits(lim.inputs);
      if (!bad && !L.ok) bad = L.input;
      if (bad) { try { bad.focus(); } catch (e2) { /* ignore */ } return; }
      var payload = {
        name_ar: nameAr, name_en: nameEn || null, sort: sortS === '' ? 100 : Number(sortS),
        is_active: code === 'pilot' ? true : !!f.active.input.checked,
        limits: L.values, price_monthly_sar: priceS === '' ? null : Number(priceS), notes: notes || null
      };
      busy(ok, true);
      api.platformSavePlan(code, payload).then(function (r) {
        busy(ok, false);
        if (r.error) {
          var key = r.error.field && PLAN_FIELD[r.error.field];
          if (key && f[key]) fieldError(f[key].input, errText(r.error));
          else if (r.error.field && lim.inputs[r.error.field]) fieldError(lim.inputs[r.error.field], errText(r.error));
          d.error(errText(r.error));
          return;
        }
        d.close();
        showMsg(tr(isNew ? 'planCreated' : 'planSaved', { code: code }), 'success');
        loadPlans(); loadSubs();
      });
    });
    d.open();
    try { (isNew ? f.code.input : f.name_ar.input).focus(); } catch (e) { /* ignore */ }
    return d;
  }

  /* ---- subscriptions ---- */
  function usageCell(s, k, over) {
    var used = s.usage && has(s.usage, k) ? s.usage[k] : null;
    var lim = s.limits && has(s.limits, k) ? s.limits[k] : null;
    var text = usedText(k, used) + ' / ' + limitText(k, lim);
    var isOver = over.indexOf(k) !== -1;
    return h('td', { class: 'num pf-nowrap', 'data-pf-usage': k },
      isOver ? h('span', { class: 'badge badge-warning', title: tr('overLimitTip'), text: text }) : h('span', { text: text }));
  }
  function renderSubs() {
    renderKpis();
    if (!subsBody) return;
    if (!subs.length) { emptyRow(subsBody, SUBS_COLS, tr('subsEmpty')); return; }
    clear(subsBody);
    subs.forEach(function (s) {
      var over = overOf(s);
      var paused = isPaused(s), expired = isTrialExpired(s);
      var stopped = isStopped(s.status) || paused;
      var ovKeys = s.limit_overrides && typeof s.limit_overrides === 'object' ? Object.keys(s.limit_overrides) : [];
      var cells = [
        h('td', null, [h('strong', { text: subOrgName(s) }), h('span', { class: 'pf-sub pf-mono', dir: 'ltr', text: s.slug || '' }),
          s.status_reason ? h('span', { class: 'pf-sub', text: tr('reasonPrefix', { reason: s.status_reason }) }) : null]),
        h('td', null, [h('span', { text: subPlanName(s) }), h('span', { class: 'pf-sub pf-mono', dir: 'ltr', text: s.plan_code || '' }),
          ovKeys.length ? h('span', { class: 'pf-sub', text: tr('hasOverrides', { n: fmtNum(ovKeys.length) }) }) : null]),
        h('td', null, [statusBadge(s.status),
          paused ? h('span', { class: 'badge badge-danger', 'data-pf-paused': '', title: tr('orgPausedTip'), text: tr('orgPaused') }) : null,
          expired ? h('span', { class: 'badge badge-warning', 'data-pf-trial-ended': '', title: tr('trialEndedTip'), text: tr('trialEnded') }) : null,
          s.suspended_at ? h('span', { class: 'pf-sub', text: fmtDate(s.suspended_at) }) : null]),
        h('td', { class: 'pf-nowrap', text: fmtDay(s.period_start) + ' – ' + (s.period_end ? fmtDay(s.period_end) : tr('openEnded')) })
      ];
      METRICS.forEach(function (k) { cells.push(usageCell(s, k, over)); });
      var acts = h('div', { class: 'pf-row-actions' }, [
        h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: tr('changePlan'), 'data-pf-sub-act': 'plan', on: { click: function () { openPlanChange(s); } } }),
        stopped
          ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', text: tr('activate'), 'data-pf-sub-act': 'activate', on: { click: function () { openActivate(s); } } })
          : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: tr('suspendSub'), 'data-pf-sub-act': 'suspend', on: { click: function () { openSuspend(s); } } }),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: tr('usage'), 'data-pf-sub-act': 'usage', on: { click: function () { openUsage(s); } } }),
        (function () { var b = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: tr('recount'), 'data-pf-sub-act': 'recount' }); b.addEventListener('click', function () { recount(s, b); }); return b; })()
      ]);
      cells.push(h('td', null, acts));
      subsBody.appendChild(h('tr', { class: stopped ? 'pf-row-off' : ((over.length || expired) ? 'pf-row-over' : null), 'data-pf-sub': s.org_id }, cells));
    });
  }
  function loadSubs() {
    if (!api || typeof api.platformListSubscriptions !== 'function') return Promise.resolve();
    if (subsBody) emptyRow(subsBody, SUBS_COLS, tr('loading'), true);
    return api.platformListSubscriptions().then(function (r) {
      if (r.error) { subsLoaded = false; renderKpis(); emptyRow(subsBody, SUBS_COLS, errText(r.error)); return; }
      subs = Array.isArray(r.data) ? r.data : [];
      subsLoaded = true;
      renderSubs();
    });
  }
  function reloadAfterChange() { return Promise.all([loadOrgs(), loadSubs(), loadPlans()]); }

  // change plan / status (trial|active) / period / overrides — reason required; idempotent (key kept until a definite answer)
  function openPlanChange(s) {
    var d = mkDialog('pf-subplan-dialog', tr('changePlanTitle', { name: subOrgName(s) }), { wide: true });
    var opts = plans.filter(function (p) { return p.is_active || p.code === s.plan_code; })
      .map(function (p) { return { value: p.code, label: planName(p) + ' (' + p.code + ')' + (p.is_active ? '' : ' — ' + tr('planInactive')) }; });
    if (!opts.length && s.plan_code) opts.push({ value: s.plan_code, label: subPlanName(s) + ' (' + s.plan_code + ')' });
    var f = {
      plan: fieldEl({ id: 'pf-sp-plan', label: tr('colPlan'), type: 'select', required: true, options: opts, value: s.plan_code }),
      status: fieldEl({ id: 'pf-sp-status', label: tr('colSubStatus'), type: 'select', required: true,
        options: [{ value: 'active', label: statusLabel('active') }, { value: 'trial', label: statusLabel('trial') }],
        value: s.status === 'trial' ? 'trial' : 'active', hint: tr('statusHint') }),
      start: fieldEl({ id: 'pf-sp-start', label: tr('periodStart'), type: 'date', required: true, dir: 'ltr', value: s.period_start || todayIso() }),
      end: fieldEl({ id: 'pf-sp-end', label: tr('periodEnd'), type: 'date', dir: 'ltr', value: s.period_end || '', hint: tr('periodEndHint') }),
      reason: fieldEl({ id: 'pf-sp-reason', label: tr('reason'), type: 'textarea', required: true, rows: 2, max: 2000, full: true })
    };
    var lim = limitInputs('pf-sp-ov', s.limit_overrides || {}, tr('fromPlan'));
    if (isStopped(s.status)) d.body.appendChild(h('div', { class: 'alert alert-warning', text: tr('stoppedPlanWarn') }));
    d.body.appendChild(grid([f.plan.group, f.status.group, f.start.group, f.end.group]));
    d.body.appendChild(h('fieldset', { class: 'pf-fieldset' }, [h('legend', { text: tr('overridesLegend') }),
      h('p', { class: 'form-hint mb-0', text: tr('overridesHint') }), grid(lim.groups)]));
    d.body.appendChild(grid([f.reason.group]));
    var ok = footButtons(d, tr('save'));
    var key = null, keyFor = null;
    d.form.addEventListener('submit', function (e) {
      e.preventDefault();
      d.error(null);
      [f.plan, f.status, f.start, f.end, f.reason].forEach(function (x) { fieldError(x.input, null); });
      var plan = inputVal(f.plan.input), status = inputVal(f.status.input), start = inputVal(f.start.input), end = inputVal(f.end.input), reason = inputVal(f.reason.input);
      var bad = null;
      function chk(x, cond, k) { if (!cond && !bad) { bad = x.input; fieldError(x.input, tr(k)); } }
      chk(f.plan, !!plan, 'errRequired');
      chk(f.status, status === 'active' || status === 'trial', 'errRequired');
      chk(f.start, validDay(start), 'errDate');
      chk(f.end, end === '' ? status !== 'trial' : validDay(end), end === '' ? 'errTrialEnd' : 'errDate');
      chk(f.end, end === '' || !validDay(start) || end >= start, 'errPeriod');
      chk(f.reason, reason.length > 0 && reason.length <= 2000, reason ? 'errTooLong' : 'errReason');
      var L = readLimits(lim.inputs);
      if (!bad && !L.ok) bad = L.input;
      if (bad) { try { bad.focus(); } catch (e2) { /* ignore */ } return; }
      var overrides = {};
      METRICS.forEach(function (k) { if (L.values[k] != null) overrides[k] = L.values[k]; });
      var payload = { plan_code: plan, status: status, period_start: start, period_end: end || null, limit_overrides: overrides, reason: reason };
      var fp = JSON.stringify(payload);
      if (!key || keyFor !== fp) { key = api.newIdemKey(); keyFor = fp; }   // new data → new key
      busy(ok, true);
      api.platformSetOrgPlan(s.org_id, payload, key).then(function (r) {
        busy(ok, false);
        if (r.error) {
          if (r.error.code !== 'MRS_UNKNOWN_RESULT' && r.error.code !== 'MRS_IN_PROGRESS') { key = null; keyFor = null; }
          var map = { plan_code: f.plan, plan_inactive: f.plan, status: f.status, period: f.end, reason: f.reason };
          if (r.error.field && map[r.error.field]) fieldError(map[r.error.field].input, errText(r.error));
          d.error(errText(r.error));
          return;
        }
        key = null; keyFor = null;
        d.close();
        var data = r.data || {};
        var over = (Array.isArray(data.over_limit) ? data.over_limit : (data.usage && data.usage.over_limit) || [])
          .filter(function (k) { return METRICS.indexOf(k) !== -1; });
        if (over.length) showMsg(tr('planChangedOver', { name: subOrgName(s), list: over.map(metricLabel).join('، ') }), 'warning');
        else showMsg(tr('planChanged', { name: subOrgName(s) }), 'success');
        reloadAfterChange();
      });
    });
    d.open();
    try { f.plan.input.focus(); } catch (e) { /* ignore */ }
    return d;
  }

  // reason dialog → MarsaShell.confirm → RPC; the dialog comes back (values kept) on "cancel" or an error
  function reasonFlow(o) {
    var d = mkDialog(o.id, o.title);
    if (o.lead) d.body.appendChild(h('p', { class: 'text-muted text-sm mb-0', text: o.lead }));
    var reason = fieldEl({ id: o.id + '-reason', label: tr('reason'), type: 'textarea', required: true, rows: 3, max: 2000 });
    d.body.appendChild(reason.group);
    var extra = o.extra ? o.extra(d) : null;
    var ok = footButtons(d, o.okText, o.danger);
    d.form.addEventListener('submit', function (e) {
      e.preventDefault();
      d.error(null);
      fieldError(reason.input, null);
      var r = inputVal(reason.input);
      if (!r || r.length > 2000) { fieldError(reason.input, tr(r ? 'errTooLong' : 'errReason')); try { reason.input.focus(); } catch (e2) { /* ignore */ } return; }
      var args = { reason: r, extra: extra };
      // the native modal <dialog> sits in the top layer: close it while the shell confirm is open
      d.close();
      ask({ title: o.title, text: o.confirmText(args), okText: o.okText, danger: !!o.danger }).then(function (yes) {
        if (!yes) { d.open(); return; }
        busy(ok, true);
        o.run(args).then(function (res) {
          busy(ok, false);
          if (res.error) { d.open(); d.error(errText(res.error)); if (res.error.field === 'reason') fieldError(reason.input, errText(res.error)); return; }
          d.form.reset();
          o.done(res.data || {}, args);
        });
      });
    });
    d.open();
    try { reason.input.focus(); } catch (e) { /* ignore */ }
    return d;
  }
  function openSuspend(s) {
    var name = subOrgName(s);
    return reasonFlow({
      id: 'pf-suspend-dialog', title: tr('suspendTitle', { name: name }), lead: tr('suspendLead'), okText: tr('suspendSub'), danger: true,
      extra: function (d) {
        var c = fieldEl({ id: 'pf-suspend-cancel', type: 'checkbox', label: tr('cancelSubscription'), hint: tr('cancelHint') });
        d.body.appendChild(c.group);
        return c.input;
      },
      confirmText: function (a) { return tr(a.extra && a.extra.checked ? 'confirmCancelSub' : 'confirmSuspendSub', { name: name }); },
      run: function (a) { return api.platformSuspendOrg(s.org_id, a.reason, !!(a.extra && a.extra.checked)); },
      done: function (data, a) {
        if (data.unchanged) showMsg(tr('unchangedSub', { name: name }), 'success');
        else showMsg(tr(a.extra && a.extra.checked ? 'cancelledSub' : 'suspendedSub', { name: name }), 'success');
        reloadAfterChange();
      }
    });
  }
  function openActivate(s) {
    var name = subOrgName(s);
    return reasonFlow({
      id: 'pf-activate-dialog', title: tr('activateTitle', { name: name }), lead: tr('activateLead'), okText: tr('activate'),
      confirmText: function () { return tr('confirmActivateSub', { name: name }); },
      run: function (a) { return api.platformActivateOrg(s.org_id, a.reason); },
      done: function (data) {
        showMsg(data.unchanged ? tr('unchangedSub', { name: name }) : tr('activatedSub', { name: name }), 'success');
        reloadAfterChange();
      }
    });
  }
  function recount(s, btn) {
    ask({ title: tr('recount'), text: tr('confirmRecount', { name: subOrgName(s) }), okText: tr('recount') }).then(function (yes) {
      if (!yes) return;
      hideMsg();
      busy(btn, true);
      api.platformRecountUsage(s.org_id).then(function (r) {
        busy(btn, false);
        if (r.error) { showMsg(errText(r.error), 'danger'); return; }
        showMsg(tr('recounted', { name: subOrgName(s) }), 'success');
        loadSubs();
      });
    });
  }

  /* ---- usage dialog: current vs limits, monthly history, last subscription events ---- */
  function smallTable(caption, heads, rows, emptyText) {
    var tbody = h('tbody');
    if (!rows.length) tbody.appendChild(h('tr', null, h('td', { class: 'pf-empty', colspan: heads.length, text: emptyText })));
    rows.forEach(function (cells) { tbody.appendChild(h('tr', null, cells)); });
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table table-striped adm-table pf-table' }, [
      h('caption', { class: 'sr-only', text: caption }),
      h('thead', null, h('tr', null, heads.map(function (t) { return h('th', { scope: 'col', text: t }); }))),
      tbody
    ]));
  }
  function eventChange(ev) {
    var parts = [];
    if (ev.from_plan || ev.to_plan) { if (ev.from_plan !== ev.to_plan) parts.push((ev.from_plan || '—') + ' → ' + (ev.to_plan || '—')); else parts.push(ev.to_plan); }
    if (ev.from_status || ev.to_status) { if (ev.from_status !== ev.to_status) parts.push(statusLabel(ev.from_status) + ' → ' + statusLabel(ev.to_status)); }
    return parts.join(' · ') || '—';
  }
  function eventLabel(a) { var s = tr('ev_' + a); return s === 'platform.ev_' + a ? String(a || '—') : s; }
  function openUsage(s) {
    var d = mkDialog('pf-usage-dialog', tr('usageTitle', { name: subOrgName(s) }), { wide: true });
    var box = h('div', { class: 'pf-usage', 'data-pf-usage-body': true }, h('p', { class: 'text-muted mb-0', role: 'status', text: tr('loading') }));
    d.body.appendChild(box);
    d.foot.appendChild(h('button', { class: 'btn btn-ghost', type: 'button', text: tr('close'), on: { click: d.close } }));
    d.form.addEventListener('submit', function (e) { e.preventDefault(); });
    d.open();
    api.platformOrgUsage(s.org_id, 6).then(function (r) {
      clear(box);
      if (r.error) { d.error(errText(r.error)); return; }
      var u = r.data || {}, cur = u.current || {}, lim = u.limits || {};
      var over = overOf(cur); if (!over.length) over = overOf(u);
      box.appendChild(h('h3', { class: 'pf-usage-h', text: tr('usageCurrent') }));
      box.appendChild(smallTable(tr('usageCurrent'), [tr('colMetric'), tr('colUsed'), tr('colLimit'), tr('colState')], METRICS.map(function (k) {
        var isOver = over.indexOf(k) !== -1;
        return [h('td', { text: metricLabel(k) }), h('td', { class: 'num', text: usedText(k, cur[k]) }), h('td', { class: 'num', text: limitText(k, lim[k]) }),
          h('td', null, h('span', { class: 'badge ' + (isOver ? 'badge-warning' : 'badge-success'), text: isOver ? tr('stateOver') : tr('stateOk') }))];
      }), tr('usageEmpty')));
      var hist = Array.isArray(u.history) ? u.history : [];
      box.appendChild(h('h3', { class: 'pf-usage-h', text: tr('usageHistory') }));
      box.appendChild(smallTable(tr('usageHistory'), [tr('colPeriod'), metricLabel('transactions_month'), metricLabel('messages_month'), metricLabel('ai_runs_month')],
        hist.map(function (m) {
          return [h('td', { class: 'pf-nowrap', text: fmtDay(m.period_start) }), h('td', { class: 'num', text: fmtNum(m.transactions_month) }),
            h('td', { class: 'num', text: fmtNum(m.messages_month) }), h('td', { class: 'num', text: fmtNum(m.ai_runs_month) })];
        }), tr('usageEmpty')));
      if (u.storage_mb != null) box.appendChild(h('p', { class: 'text-sm text-muted mb-0', text: tr('storageTotal', { v: usedText('storage_mb', u.storage_mb) }) }));
      var evs = Array.isArray(u.events) ? u.events : [];
      box.appendChild(h('h3', { class: 'pf-usage-h', text: tr('usageEvents') }));
      box.appendChild(smallTable(tr('usageEvents'), [tr('colTime'), tr('colEvent'), tr('colChange'), tr('reason')], evs.map(function (ev) {
        return [h('td', { class: 'pf-nowrap', text: fmtDate(ev.at) }), h('td', { text: eventLabel(ev.action) }),
          h('td', { dir: 'auto', text: eventChange(ev) }), h('td', { class: 'pf-msg-cell', text: ev.reason || '—' })];
      }), tr('eventsEmpty')));
    });
    return d;
  }
  var npb = $('[data-pf-plan-new]'); if (npb) npb.addEventListener('click', function () { openPlanDialog(null); });
  var spr = $('[data-pf-subs-reload]'); if (spr) spr.addEventListener('click', loadSubs);
  var ppr = $('[data-pf-plans-reload]'); if (ppr) ppr.addEventListener('click', loadPlans);

  /* ======================================================================
     TOP BAR + BOOT
     ====================================================================== */
  function loadAll() { hideMsg(); return Promise.all([runHealth(), loadOrgs().then(loadErrors), loadSubs(), loadPlans()]); }
  var refresh = $('[data-pf-refresh]');
  if (refresh) refresh.addEventListener('click', loadAll);
  var hr = $('[data-pf-health-run]'); if (hr) hr.addEventListener('click', runHealth);
  var orr = $('[data-pf-orgs-reload]'); if (orr) orr.addEventListener('click', loadOrgs);
  var err = $('[data-pf-errors-reload]'); if (err) err.addEventListener('click', loadErrors);
  var so = $('[data-pf-signout]');
  if (so) so.addEventListener('click', function () { so.disabled = true; hideInvite(); api.signOut().then(function () { location.replace('login.html#staff'); }); });
  var soa = $('[data-pf-signout-all]');
  if (soa) soa.addEventListener('click', function () {
    busy(soa, true); hideInvite();
    api.signOutEverywhere().then(function (r) {
      busy(soa, false);
      if (r && r.error) { showMsg(errText(r.error), 'danger'); return; }
      location.replace('login.html#staff');
    });
  });
  $$('[data-pf-reload]').forEach(function (b) { b.addEventListener('click', function () { location.reload(); }); });
  // org list search + status filter (client side; the list is small)
  var oq = $('[data-pf-orgs-q]'), oqTimer = null;
  if (oq) oq.addEventListener('input', function () {
    clearTimeout(oqTimer);
    oqTimer = setTimeout(function () { orgQuery = String(oq.value || '').trim().toLowerCase(); renderOrgs(); }, 150);
  });
  $$('[data-pf-filter]').forEach(function (b) {
    b.addEventListener('click', function () {
      orgFilter = b.getAttribute('data-pf-filter');
      $$('[data-pf-filter]').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      renderOrgs();
    });
  });
  window.addEventListener('marsa:langchange', function () {
    setShellTitle(); renderOrgs(); renderErrors();
    if (subsLoaded) renderSubs();
    if (plans.length) renderPlans();
  });
  // the platform console is not scoped to the active organization: nothing to reload on marsa:orgchange

  function boot() {
    setShellTitle();
    if (!api || !api.isOnline || !api.isOnline()) { gate('demo'); return; }
    gate('loading');
    api.getSession().then(function (s) {
      if (s.error) { $('[data-pf-gate-error]').textContent = errText(s.error); gate('error'); return; }
      if (!s.data) { gate('signin'); return; }
      var me = $('[data-pf-me-email]'); if (me) me.textContent = (s.data.user && s.data.user.email) || '';
      return api.myContext(true).then(function (r) {
        if (r.error) {
          if (r.error.code === 'MRS_AUTH_REQUIRED') { gate('signin'); return; }
          $('[data-pf-gate-error]').textContent = errText(r.error); gate('error'); return;
        }
        if (!r.data || !r.data.is_platform_admin) { gate('denied'); return; }
        gate(null);
        loadAll();
      });
    });
  }
  boot();
})();
