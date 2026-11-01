/* ==========================================================================
   مرسى | MARSA — platform.html  (platform-admin console, STAGING)
   Load order: config.js → i18n.js → main.js → supa.js → assets/i18n/platform.js → platform.js
               (plain <script defer>)

   * Platform admins (public.platform_admins, rows added in the SQL Editor
     only) manage ORGANIZATIONS: list, create (org + first branch + admin
     invitation), suspend / reactivate, recent client errors, health check.
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
    if (!msgBox) { if (M.toast) M.toast(text, type === 'danger' ? 'error' : type); return; }
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

  /* ======================================================================
     ORGANIZATIONS
     ====================================================================== */
  var orgs = [];
  var orgsBody = $('[data-pf-orgs]');
  function orgName(o) { return (lang() === 'en' && o.name_en) ? o.name_en : (o.name_ar || o.name_en || o.slug || ''); }
  function emptyRow(tbody, cols, text) {
    clear(tbody).appendChild(h('tr', null, h('td', { class: 'pf-empty', colspan: cols, text: text })));
  }
  function renderOrgs() {
    if (!orgsBody) return;
    if (!orgs.length) { emptyRow(orgsBody, 6, tr('orgsEmpty')); return; }
    clear(orgsBody);
    orgs.forEach(function (o) {
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
        h('td', { text: fmtDate(o.created_at) }),
        h('td', null, [btn, active && !o.admins ? reissueBtn(o) : null])
      ]));
    });
  }
  function loadOrgs() {
    if (orgsBody) emptyRow(orgsBody, 6, tr('loading'));
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
    if (!window.confirm(tr('confirmReissue', { name: orgName(o) }))) return;
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
  function toggleOrg(o, btn) {
    var activate = !o.is_active;
    var q = activate ? tr('confirmReactivate', { name: orgName(o) }) : tr('confirmSuspend', { name: orgName(o) });
    if (!window.confirm(q)) return;
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
        h('td', { text: fmtDate(e.created_at) }),
        h('td', { class: 'pf-mono', dir: 'ltr', text: errOrgLabel(e) }),
        h('td', { class: 'pf-mono', dir: 'ltr', text: e.page || '—' }),
        h('td', { class: 'pf-mono', dir: 'ltr', text: e.code || '—' }),
        h('td', { class: 'pf-msg-cell', dir: 'ltr', text: e.message || '' })
      ]));
    });
  }
  function loadErrors() {
    if (errBody) emptyRow(errBody, 5, tr('loading'));
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
     TOP BAR + BOOT
     ====================================================================== */
  function loadAll() { hideMsg(); return Promise.all([runHealth(), loadOrgs().then(loadErrors)]); }
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
      if (r.error) { showMsg(errText(r.error), 'danger'); return; }
      location.replace('login.html#staff');
    });
  });
  $$('[data-pf-reload]').forEach(function (b) { b.addEventListener('click', function () { location.reload(); }); });
  window.addEventListener('marsa:langchange', function () { renderOrgs(); renderErrors(); });

  function boot() {
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
