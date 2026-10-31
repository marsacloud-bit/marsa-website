/* ==========================================================================
   مرسى | MARSA — login.html (STAGING)
   Client / staff sign-in, client sign-up, forgot + reset password, sign-out.
   Load order: config.js → main.js → supa.js → auth.js  (plain <script defer>)

   * Demo mode (config empty): the credential forms stay hidden; a notice
     explains that login needs the online setup. No network calls.
   * Online mode: Supabase Auth through window.MarsaApi. After sign-in the
     user is routed by role from my_context(): staff → admin.html,
     everyone else → portal.html. Roles are NEVER read from signup data.
   * Recovery: resetPassword() redirects back to login.html?mode=reset;
     supabase-js reads the token from the URL (type=recovery) and fires
     PASSWORD_RECOVERY; we then show the "new password" form.
   ========================================================================== */
(function () {
  'use strict';

  var api = window.MarsaApi;
  var M = window.Marsa || {};
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---- strings (Arabic MSA; centralised for a later EN pass) ---- */
  var T = {
    required: 'هذا الحقل مطلوب.',
    email: 'أدخل بريدًا إلكترونيًا صحيحًا.',
    password: 'كلمة المرور 8 أحرف على الأقل وتجمع حروفًا وأرقامًا.',
    passwordMatch: 'كلمتا المرور غير متطابقتين.',
    phone: 'أدخل رقم جوال سعودي صحيحًا يبدأ بـ 05.',
    name: 'أدخل الاسم الكامل (حرفان على الأقل).',
    terms: 'يلزم الإقرار بأن هذه بيئة تجريبية.',
    working: 'جارٍ التنفيذ…',
    signedIn: 'تم تسجيل الدخول. جارٍ تحويلك…',
    signedOut: 'تم تسجيل الخروج.',
    signupSent: 'أرسلنا رسالة تأكيد إلى بريدك الإلكتروني إن كان صالحًا للتسجيل. افتح الرابط في الرسالة لتفعيل حسابك ثم سجّل الدخول. إن لم تصلك الرسالة خلال دقائق فراجع مجلد الرسائل غير المرغوب فيها.',
    resetSent: 'إن كان هذا البريد مسجّلًا لدينا فستصلك رسالة فيها رابط لتعيين كلمة مرور جديدة. الرابط صالح لمدة محدودة.',
    resetDone: 'تم تحديث كلمة المرور بنجاح.',
    resetNoSession: 'رابط استعادة كلمة المرور غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.',
    linkError: 'الرابط الذي فتحته غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.',
    confirmed: 'تم تأكيد بريدك الإلكتروني. يمكنك تسجيل الدخول الآن.',
    notStaff: 'هذا الحساب ليست له صلاحيات موظف في المنصة. سنحوّلك إلى بوابة العميل.',
    sessionAs: 'أنت مسجّل الدخول بالحساب',
    loadFail: 'تعذّر تحميل خدمة الدخول. تحقّق من اتصالك ثم أعد تحميل الصفحة.'
  };

  var hashAtLoad = location.hash || '';
  var searchAtLoad = location.search || '';
  var params = parseParams(hashAtLoad.replace(/^#/, ''));
  var query = parseParams(searchAtLoad.replace(/^\?/, ''));
  var recoveryMode = params.type === 'recovery' || query.mode === 'reset';
  var linkErrorAtLoad = !!(params.error || params.error_code || query.error || query.error_code);
  var confirmedAtLoad = params.type === 'signup' || query.confirmed === '1';
  var routing = false;

  function parseParams(s) {
    var o = {};
    String(s || '').split('&').forEach(function (kv) {
      if (!kv || kv.indexOf('=') === -1) return;
      var i = kv.indexOf('=');
      try { o[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); } catch (e) { /* ignore */ }
    });
    return o;
  }
  // Only same-site pages from this allow-list may be used as "next"
  function safeNext() {
    var n = String(query.next || '').replace(/^\.?\//, '');
    return ['portal.html', 'admin.html'].indexOf(n) !== -1 ? n : '';
  }
  function cleanUrl(keepHash) {
    try { history.replaceState(null, '', location.pathname + (keepHash ? '#' + keepHash : '')); } catch (e) { /* ignore */ }
  }

  /* ---- UI helpers ---- */
  var msgBox = $('[data-auth-msg]');
  function showMsg(text, type) {
    if (!msgBox) return;
    msgBox.className = 'alert alert-' + (type || 'info') + ' mb-3';
    msgBox.querySelector('[data-auth-msg-text]').textContent = text;
    msgBox.hidden = false;
    try { msgBox.focus({ preventScroll: false }); } catch (e) { msgBox.focus(); }
  }
  function hideMsg() { if (msgBox) msgBox.hidden = true; }

  var VIEWS = ['tabs', 'forgot', 'reset', 'session', 'demo'];
  function showView(name) {
    VIEWS.forEach(function (v) {
      var el = $('[data-auth-view="' + v + '"]');
      if (el) el.hidden = v !== name;
    });
  }
  function showClientSub(name) {   // signin | signup
    $$('[data-client-sub]').forEach(function (el) { el.hidden = el.getAttribute('data-client-sub') !== name; });
  }
  function selectTab(which) {
    var tab = document.getElementById('tab-' + which);
    if (tab) tab.click();
  }
  function setBusy(form, busy) {
    var btn = form.querySelector('button[type="submit"]');
    $$('input, button, select', form).forEach(function (el) { el.disabled = busy; });
    if (btn) {
      if (busy) { btn.setAttribute('data-label', btn.textContent); btn.textContent = T.working; btn.setAttribute('aria-busy', 'true'); }
      else if (btn.getAttribute('data-label')) { btn.textContent = btn.getAttribute('data-label'); btn.removeAttribute('aria-busy'); }
    }
  }
  function fieldError(input, msg) {
    var g = input.closest('.form-group');
    if (!g) return;
    var err = g.querySelector('.form-error');
    if (msg) {
      g.classList.add('has-error'); input.setAttribute('aria-invalid', 'true');
      if (err) err.textContent = msg;
    } else {
      g.classList.remove('has-error'); input.removeAttribute('aria-invalid');
    }
  }
  function clearErrors(form) { $$('.form-control', form).forEach(function (i) { fieldError(i, null); }); }
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
  function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()) && String(s).length <= 160; }
  function validPassword(s) { return typeof s === 'string' && s.length >= 8 && s.length <= 72 && /[A-Za-z؀-ۿ]/.test(s) && /\d/.test(s); }
  function errText(err) { return (err && err.message) || (api && api.errorMessage ? api.errorMessage(err) : 'حدث خطأ غير متوقع.'); }

  /* ---- password show/hide toggles ---- */
  $$('[data-toggle-password]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = document.getElementById(btn.getAttribute('aria-controls'));
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
    });
  });

  /* ---- routing by role ---- */
  function routeByRole(preferStaff) {
    if (routing) return Promise.resolve();
    routing = true;
    return api.myContext(true).then(function (r) {
      var ctx = r.data || {};
      var slug = api.orgSlug;
      var staff = !r.error && (ctx.memberships || []).some(function (m) { return m.org_slug === slug && m.role !== 'client'; });
      var next = safeNext();
      var dest = staff ? (next || 'admin.html') : 'portal.html';
      if (preferStaff && !staff) {
        showMsg(T.notStaff, 'warning');
        setTimeout(function () { location.replace(dest); }, 1800);
        return;
      }
      showMsg(T.signedIn, 'success');
      location.replace(dest);
    });
  }

  /* ---- signed-in panel ---- */
  function showSession(user) {
    var who = $('[data-session-email]');
    if (who) who.textContent = (user && user.email) || '';
    showView('session');
  }

  /* ======================================================================
     DEMO MODE
     ====================================================================== */
  if (!api || !api.isOnline()) {
    showView('demo');
    if (api && api.isMisconfigured && api.isMisconfigured()) {
      var mc = $('[data-demo-misconfig]');
      if (mc) mc.hidden = false;
    }
    return;
  }

  /* ======================================================================
     ONLINE MODE
     ====================================================================== */
  document.documentElement.setAttribute('data-auth-ready', 'loading');
  $$('[data-online-only]').forEach(function (el) { el.hidden = false; });
  var initialTab = /staff/.test(hashAtLoad) ? 'staff' : 'client';
  showView('tabs');
  selectTab(initialTab);
  showClientSub(/signup/.test(hashAtLoad) ? 'signup' : 'signin');

  // keep the #client / #staff anchors working after load
  window.addEventListener('hashchange', function () {
    var h = location.hash;
    if (h === '#staff') { showView('tabs'); selectTab('staff'); }
    else if (h === '#client' || h === '#signup') { showView('tabs'); selectTab('client'); showClientSub(h === '#signup' ? 'signup' : 'signin'); }
  });
  $$('[data-tab-hash]').forEach(function (t) {
    t.addEventListener('click', function () {
      try { history.replaceState(null, '', location.pathname + location.search + '#' + t.getAttribute('data-tab-hash')); } catch (e) { /* ignore */ }
    });
  });

  // view switches
  $$('[data-go-signup]').forEach(function (b) { b.addEventListener('click', function () { hideMsg(); showClientSub('signup'); var f = $('#su-name'); if (f) f.focus(); }); });
  $$('[data-go-signin]').forEach(function (b) { b.addEventListener('click', function () { hideMsg(); showClientSub('signin'); var f = $('#ci-email'); if (f) f.focus(); }); });
  $$('[data-go-forgot]').forEach(function (b) {
    b.addEventListener('click', function () {
      hideMsg();
      var src = $('#' + (b.getAttribute('data-email-from') || 'ci-email'));
      var fe = $('#fp-email');
      if (src && fe && src.value) fe.value = src.value.trim();
      showView('forgot');
      if (fe) fe.focus();
    });
  });
  $$('[data-go-tabs]').forEach(function (b) { b.addEventListener('click', function () { hideMsg(); showView('tabs'); }); });

  /* ---- sign-in (client + staff share Supabase auth) ---- */
  function bindSignIn(form, emailId, pwId, preferStaff) {
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      hideMsg(); clearErrors(form);
      var em = $('#' + emailId), pw = $('#' + pwId), bad = false;
      if (!validEmail(em.value)) { fieldError(em, T.email); bad = true; }
      if (!pw.value) { fieldError(pw, T.required); bad = true; }
      if (bad) { (form.querySelector('[aria-invalid="true"]') || em).focus(); return; }
      setBusy(form, true);
      api.signIn(em.value.trim(), pw.value).then(function (r) {
        if (r.error) { setBusy(form, false); pw.value = ''; showMsg(errText(r.error), 'danger'); return; }
        pw.value = '';
        return routeByRole(preferStaff).then(function () { setBusy(form, false); });
      });
    });
  }
  bindSignIn($('#client-signin-form'), 'ci-email', 'ci-password', false);
  bindSignIn($('#staff-signin-form'), 'st-email', 'st-password', true);

  /* ---- client sign-up ---- */
  var su = $('#client-signup-form');
  if (su) su.addEventListener('submit', function (e) {
    e.preventDefault();
    hideMsg(); clearErrors(su);
    var name = $('#su-name'), phone = $('#su-phone'), em = $('#su-email'), pw = $('#su-password'), pw2 = $('#su-password2'), ack = $('#su-ack');
    var bad = false, p = normPhone(phone.value);
    if (String(name.value).trim().length < 2 || String(name.value).trim().length > 120) { fieldError(name, T.name); bad = true; }
    if (!p) { fieldError(phone, T.phone); bad = true; }
    if (!validEmail(em.value)) { fieldError(em, T.email); bad = true; }
    if (!validPassword(pw.value)) { fieldError(pw, T.password); bad = true; }
    if (pw2.value !== pw.value) { fieldError(pw2, T.passwordMatch); bad = true; }
    var ackGroup = ack.closest('.form-group');
    if (!ack.checked) { if (ackGroup) ackGroup.classList.add('has-error'); bad = true; } else if (ackGroup) ackGroup.classList.remove('has-error');
    if (bad) { (su.querySelector('[aria-invalid="true"]') || name).focus(); return; }
    setBusy(su, true);
    var redirect = location.origin + location.pathname.replace(/[^/]*$/, '') + 'login.html?confirmed=1';
    api.signUp(em.value.trim(), pw.value, { fullName: String(name.value).trim(), phone: p, locale: 'ar', redirectTo: redirect })
      .then(function (r) {
        setBusy(su, false);
        pw.value = ''; pw2.value = '';
        if (r.error) { showMsg(errText(r.error), 'danger'); return; }
        if (r.data && r.data.session) { return routeByRole(false); }   // email confirmation disabled on this project
        su.reset();
        showClientSub('signin');
        showMsg(T.signupSent, 'success');
      });
  });

  /* ---- forgot password ---- */
  var fp = $('#forgot-form');
  if (fp) fp.addEventListener('submit', function (e) {
    e.preventDefault();
    hideMsg(); clearErrors(fp);
    var em = $('#fp-email');
    if (!validEmail(em.value)) { fieldError(em, T.email); em.focus(); return; }
    setBusy(fp, true);
    var redirect = location.origin + location.pathname.replace(/[^/]*$/, '') + 'login.html?mode=reset';
    api.resetPassword(em.value.trim(), redirect).then(function (r) {
      setBusy(fp, false);
      // same message whether or not the address exists (no account enumeration)
      if (r.error && r.error.code === 'AUTH_RATE') { showMsg(errText(r.error), 'warning'); return; }
      if (r.error && r.error.code === 'MRS_NETWORK') { showMsg(errText(r.error), 'danger'); return; }
      showMsg(T.resetSent, 'success');
    });
  });

  /* ---- reset (new password after the recovery link) ---- */
  var rp = $('#reset-form');
  if (rp) rp.addEventListener('submit', function (e) {
    e.preventDefault();
    hideMsg(); clearErrors(rp);
    var pw = $('#rp-password'), pw2 = $('#rp-password2'), bad = false;
    if (!validPassword(pw.value)) { fieldError(pw, T.password); bad = true; }
    if (pw2.value !== pw.value) { fieldError(pw2, T.passwordMatch); bad = true; }
    if (bad) { (rp.querySelector('[aria-invalid="true"]') || pw).focus(); return; }
    setBusy(rp, true);
    api.getSession().then(function (s) {
      if (!s.data) { setBusy(rp, false); showMsg(T.resetNoSession, 'danger'); return; }
      return api.updatePassword(pw.value).then(function (r) {
        setBusy(rp, false);
        pw.value = ''; pw2.value = '';
        if (r.error) { showMsg(errText(r.error), 'danger'); return; }
        recoveryMode = false;
        cleanUrl();
        if (M.toast) M.toast(T.resetDone, 'success');
        showMsg(T.resetDone, 'success');
        routeByRole(false);
      });
    });
  });

  /* ---- sign-out + continue (signed-in panel) ---- */
  $$('[data-sign-out]').forEach(function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      api.signOut().then(function () {
        b.disabled = false;
        showView('tabs'); selectTab('client'); showClientSub('signin');
        showMsg(T.signedOut, 'info');
      });
    });
  });
  $$('[data-continue]').forEach(function (b) { b.addEventListener('click', function () { routeByRole(false); }); });

  /* ---- auth events ---- */
  api.onAuth(function (event) {
    if (event === 'PASSWORD_RECOVERY') { recoveryMode = true; hideMsg(); showView('reset'); var f = $('#rp-password'); if (f) f.focus(); }
  });

  /* ---- initial state ---- */
  api.ready().then(function (r) {
    document.documentElement.setAttribute('data-auth-ready', r.error ? 'error' : 'ready');
    if (r.error) { showMsg(T.loadFail, 'danger'); $$('form[data-auth-form]').forEach(function (f) { setBusy(f, true); }); return; }
    return api.getSession().then(function (s) {
      var session = s.data;
      if (linkErrorAtLoad && !session) {
        cleanUrl(); showView(recoveryMode ? 'forgot' : 'tabs'); showMsg(T.linkError, 'danger'); return;
      }
      if (recoveryMode) {
        if (session) { showView('reset'); var f = $('#rp-password'); if (f) f.focus(); }
        else { cleanUrl(); showView('forgot'); showMsg(T.resetNoSession, 'danger'); }
        return;
      }
      if (session) {
        if (confirmedAtLoad) { cleanUrl(); return routeByRole(false); }
        showSession(session.user);
        return;
      }
      if (confirmedAtLoad) { cleanUrl('client'); showMsg(T.confirmed, 'success'); }
    });
  });
})();
