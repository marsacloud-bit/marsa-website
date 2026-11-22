/* =====================================================================
   Office website — consult.html (owner 2026-11-22)
   Customs-advice request. Sent through the existing contact-message path
   (MarsaApi.submitContactMessage → «الرسائل» in the staff dashboard), with
   the topic as the subject and a "[consult]" prefix on the message so staff
   can tell it apart. No database change. Demo mode: saved in this browser.
   ===================================================================== */
(function () {
  'use strict';
  var STORAGE_KEY = 'marsa_messages';
  var M = window.Marsa || {};
  var I18N = window.MarsaI18n || null;
  var API = window.MarsaApi || null;
  var toast = M.toast || function () {};
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  function tr(key, fallback) {
    if (!I18N) return fallback;
    var v = I18N.t(key);
    return (v && v !== key) ? v : fallback;
  }
  function isOnline() { return !!(API && API.isOnline && API.isOnline()); }
  function applyMode() {
    var online = isOnline();
    $$('[data-show-mode]').forEach(function (n) { n.hidden = n.getAttribute('data-show-mode') !== (online ? 'online' : 'demo'); });
  }
  function westernDigits(s) {
    return String(s || '')
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
  }
  // same rule as contact.js: Saudi numbers to the local 0 prefix
  function normalizePhone(v) {
    var p = westernDigits(v).replace(/[\s\-().]/g, '');
    if (p.indexOf('+966') === 0) p = '0' + p.slice(4);
    else if (p.indexOf('00966') === 0) p = '0' + p.slice(5);
    else if (p.indexOf('966') === 0 && (p.length === 12 || p.length === 11)) p = '0' + p.slice(3);
    if (/^5\d{8}$/.test(p)) p = '0' + p;
    return p;
  }
  function genRef() {
    return M.genRef ? M.genRef('MRS') : 'MRS-' + new Date().getFullYear() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  }
  function saveLocal(entry) {
    if (M.saveLocal) return M.saveLocal(STORAGE_KEY, entry);
    try {
      var list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(list)) list = [];
      list.push(Object.assign({ savedAt: new Date().toISOString() }, entry));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      return true;
    } catch (e) { return false; }
  }

  function init() {
    applyMode();
    var form = $('#consult-form');
    if (!form) return;
    if (API && API.armForm) API.armForm(form);
    var wrap = $('#cs-form-wrap'), success = $('#cs-success'), btn = $('#cs-submit');
    var msg = $('#cs-message'), counter = $('#cs-message-count');
    var max = parseInt(msg.getAttribute('maxlength') || '1000', 10);
    var rules = {
      name: function (v) { return v.trim().length >= 3; },
      phone: function (v) { return /^(05\d{8}|01[1-7]\d{7})$/.test(normalizePhone(v)); },
      email: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()); },
      subject: function (v) { return v !== ''; },
      message: function (v) { return v.trim().length >= 15; },
      consent: function (v, n) { return n.checked; }
    };
    function field(name) { return form.elements[name]; }
    function validate(name) {
      var n = field(name);
      if (!n) return true;
      var ok = rules[name](n.value || '', n);
      var g = n.closest('.form-group');
      if (g) g.classList.toggle('has-error', !ok);
      if (ok) n.removeAttribute('aria-invalid'); else n.setAttribute('aria-invalid', 'true');
      return ok;
    }
    Object.keys(rules).forEach(function (name) {
      var n = field(name);
      if (!n) return;
      n.addEventListener((n.type === 'checkbox' || n.tagName === 'SELECT') ? 'change' : 'blur', function () { validate(name); });
      n.addEventListener('input', function () { var g = n.closest('.form-group'); if (g && g.classList.contains('has-error')) validate(name); });
    });
    function count() { counter.textContent = msg.value.length + ' / ' + max; }
    msg.addEventListener('input', count);
    count();

    function showSuccess(ref) {
      $('#cs-success-ref').textContent = ref;
      wrap.hidden = true;
      success.hidden = false;
      success.focus();
    }
    function showError(err) {
      var box = $('#cs-send-error');
      $('#cs-send-error-msg').textContent = (err && err.message) || tr('consult.send_failed', 'لم يُرسل الطلب. بياناتك ما زالت في النموذج.');
      box.hidden = false;
      box.focus();
      var f = err && err.field && form.elements[err.field];
      if (f && f.setAttribute) f.setAttribute('aria-invalid', 'true');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var bad = null;
      Object.keys(rules).forEach(function (name) { if (!validate(name) && !bad) bad = field(name); });
      if (bad) { bad.focus(); toast(tr('consult.check_fields', 'من فضلك راجع الحقول المظللة باللون الأحمر'), 'warning'); return; }
      $('#cs-send-error').hidden = true;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      var topic = field('subject');
      var entry = {
        ref: genRef(),
        name: field('name').value.trim(),
        company: field('company').value.trim(),
        phone: normalizePhone(field('phone').value),
        email: field('email').value.trim(),
        subject: topic.value,
        subjectLabel: topic.options[topic.selectedIndex].text,
        reference: field('reference').value.trim(),
        // staff see the request as a consultation in «الرسائل»
        message: (tr('consult.msg_prefix', '[استشارة جمركية]') + ' ' + msg.value.trim()).slice(0, max),
        preferred: (form.querySelector('input[name="preferred"]:checked') || {}).value || 'phone',
        consent: !!field('consent').checked,
        status: 'new'
      };
      function done() { btn.disabled = false; btn.removeAttribute('aria-busy'); }
      if (isOnline()) {
        API.submitContactMessage(entry, { antispam: API.formSignals ? API.formSignals(form) : null }).then(function (res) {
          done();
          if (res && !res.error && res.data && res.data.ref) showSuccess(res.data.ref);
          else showError(res && res.error);
        }, function () { done(); showError(null); });
        return;
      }
      var ok = saveLocal(entry);
      done();
      if (!ok) { showError(null); return; }
      showSuccess(entry.ref);
    });

    $('#cs-new').addEventListener('click', function () {
      form.reset();
      count();
      $$('.has-error', form).forEach(function (g) { g.classList.remove('has-error'); });
      success.hidden = true;
      wrap.hidden = false;
      if (API && API.armForm) { form.removeAttribute('data-rendered-at'); API.armForm(form); }
      field('name').focus();
    });
  }
  // supa.js (MarsaApi) is a later deferred script on this page: start after every deferred script ran
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
