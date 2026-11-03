/* ==========================================================================
   مرسى | MARSA — login.html (STAGING)
   Client / staff sign-in, client sign-up, forgot + reset password, sign-out,
   sign-out of all devices, and invitations (login.html?invite=<token>).
   Classic marketing page (site header, page hero, footer — main.js drives the header,
   drawer, demo banner and language toggle). Also the PWA start page
   (manifest start_url = login.html?source=pwa). No theme switching.
   Load order: config.js → i18n.js → assets/i18n/login.js → assets/i18n/app.js → main.js
               → supa.js → pwa.js → auth.js
               (plain <script defer>)

   * Demo mode (config empty): the credential forms stay hidden; a notice
     explains that login needs the online setup. No network calls.
   * Online mode: Supabase Auth through window.MarsaApi. After sign-in the
     user is routed by role from my_context(): staff → admin.html#dashboard (or a
     safe ?next=), platform admins without a staff role → platform.html, everyone
     else → portal.html. Roles are NEVER read from signup data.
   * ?source=pwa (installed app start): an existing session is routed at once.
   * ?signedout=1|all: notice after a sign-out started on another page.
   * Recovery: resetPassword() redirects back to login.html?mode=reset;
     supabase-js reads the token from the URL (type=recovery) and fires
     PASSWORD_RECOVERY; we then show the "new password" form.
   * Invitation: the token is read once from ?invite=, moved to
     sessionStorage (marsa_invite) and removed from the address bar
     (history.replaceState). It is never logged and never sent anywhere but
     invitation_preview / accept_invitation. Preview → (sign in | sign up
     with the invited e-mail | accept when already signed in) → accept →
     admin.html#dashboard for staff roles, portal.html for client invitations.
   * Two-step verification (TOTP, docs/online/MFA_SPEC.md §5.3): routeByRole() is the single
     choke point after every sign-in / "continue" / PWA start / confirmation link. A user with a
     verified factor at aal1 gets the code challenge; a user for whom my_context().mfa says MFA
     is required (org admin / platform admin) without a verified factor gets the enrollment
     (assets/js/mfa.js, view "mfa"). Cancel = sign out.
     ?mfa=1[&next=…] (sent by app-shell.js / admin / platform gates): with a session → that step at
     once; without → the staff sign-in tab (next is kept). ?security=1 → the account security view.
   ========================================================================== */
(function () {
  'use strict';

  var api = window.MarsaApi;
  var M = window.Marsa || {};
  var I = window.MarsaI18n || null;
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---- strings: assets/i18n/login.js ('login.*', ar + en); Arabic fallback here ---- */
  var T = {
    required: 'هذا الحقل مطلوب.',
    email: 'أدخل بريدًا إلكترونيًا صحيحًا.',
    password: 'كلمة المرور 8 أحرف على الأقل وتجمع حروفًا وأرقامًا.',
    passwordMatch: 'كلمتا المرور غير متطابقتين.',
    phone: 'أدخل رقم جوال سعودي صحيحًا يبدأ بـ 05.',
    name: 'أدخل الاسم الكامل (حرفان على الأقل).',
    terms: 'يلزم الإقرار للمتابعة.',
    working: 'جارٍ التنفيذ…',
    signedIn: 'تم تسجيل الدخول. جارٍ تحويلك…',
    signedOut: 'تم تسجيل الخروج.',
    signedOutAll: 'تم تسجيل الخروج هنا وإلغاء جلسات الأجهزة الأخرى؛ قد يبقى جهاز آخر متصلًا حتى تنتهي جلسته الحالية (ساعة على الأكثر).',
    signupSent: 'أرسلنا رسالة تأكيد إلى بريدك الإلكتروني إن كان صالحًا للتسجيل. افتح الرابط في الرسالة لتفعيل حسابك ثم سجّل الدخول. إن لم تصلك الرسالة خلال دقائق فراجع مجلد الرسائل غير المرغوب فيها.',
    resetSent: 'إن كان هذا البريد مسجّلًا لدينا فستصلك رسالة فيها رابط لتعيين كلمة مرور جديدة. الرابط صالح لمدة محدودة.',
    resetDone: 'تم تحديث كلمة المرور بنجاح.',
    resetNoSession: 'رابط استعادة كلمة المرور غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.',
    linkError: 'الرابط الذي فتحته غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.',
    confirmed: 'تم تأكيد بريدك الإلكتروني. يمكنك تسجيل الدخول الآن.',
    notStaff: 'هذا الحساب ليست له صلاحيات موظف في المنصة. سنحوّلك إلى بوابة العميل.',
    sessionAs: 'أنت مسجّل الدخول بالحساب',
    loadFail: 'تعذّر تحميل خدمة الدخول. تحقّق من اتصالك ثم أعد تحميل الصفحة.',
    showPw: 'إظهار كلمة المرور',
    hidePw: 'إخفاء كلمة المرور',
    unknownError: 'حدث خطأ غير متوقع.',
    inviteInvalid: 'رابط الدعوة غير صالح أو انتهت صلاحيته أو استُخدم من قبل. اطلب من مدير المؤسسة دعوة جديدة.',
    inviteDemo: 'الدعوات تعمل في البيئة المتصلة فقط.',
    inviteAccepted: 'تم قبول الدعوة. جارٍ تحويلك…',
    inviteSignupSent: 'أنشأنا حسابك وأرسلنا رسالة تأكيد إلى بريدك. افتح رابط التأكيد ثم ارجع إلى رابط الدعوة نفسه (أو سجّل الدخول هنا في هذه النافذة) لقبول الدعوة.',
    inviteMismatch: 'هذه الدعوة موجّهة إلى بريد إلكتروني آخر. سجّل الخروج ثم ادخل بالبريد المدعو.',
    inviteUnconfirmed: 'يلزم تأكيد بريدك الإلكتروني أولًا من الرسالة المرسلة إليك، ثم اضغط «قبول الدعوة».',
    inviteRetry: 'تعذّر التحقق من الدعوة الآن. تحقّق من اتصالك ثم أعد تحميل الصفحة.',
    inviteDismissed: 'تم تجاهل الدعوة في هذه النافذة. يمكنك فتح رابطها من جديد لاحقًا.',
    roleFallback: { admin: 'مدير المؤسسة', branch_manager: 'مدير الفرع', supervisor: 'مشرف', operations_manager: 'مدير العمليات',
      accounts_manager: 'مدير الحسابات', accountant: 'محاسب', clearance_staff: 'موظف تخليص', transport_staff: 'موظف نقل', client: 'عميل (بوابة العميل)' }
  };
  function interp(s, vars) {
    return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s;
  }
  function tr(k, vars) {
    var key = 'login.' + k;
    if (I && typeof I.t === 'function') {
      var s = I.t(key, vars);
      if (s && s !== key) return s;
    }
    return T[k] != null ? interp(T[k], vars) : k;
  }
  function lang() { return I && typeof I.lang === 'function' ? I.lang() : 'ar'; }

  /* ---- document title follows the language (the original hero title + brand) ---- */
  document.documentElement.removeAttribute('data-theme');   // no dark theme any more
  function setDocTitle() {
    var v = tr('pageTitle');
    if (v && v !== 'pageTitle') document.title = v + (lang() === 'en' ? ' | MARSA' : ' | مرسى MARSA');
  }
  window.addEventListener('marsa:langchange', setDocTitle);
  setDocTitle();

  var hashAtLoad = location.hash || '';
  var searchAtLoad = location.search || '';
  var params = parseParams(hashAtLoad.replace(/^#/, ''));
  var query = parseParams(searchAtLoad.replace(/^\?/, ''));
  var recoveryMode = params.type === 'recovery' || query.mode === 'reset';
  var linkErrorAtLoad = !!(params.error || params.error_code || query.error || query.error_code);
  var confirmedAtLoad = params.type === 'signup' || query.confirmed === '1';
  var fromPwa = query.source === 'pwa';
  var signedOutAtLoad = query.signedout === 'all' ? 'all' : (query.signedout === '1' ? 'one' : '');
  var mfaAtLoad = query.mfa === '1';
  var securityAtLoad = query.security === '1';
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
  // Only same-site pages from this allow-list may be used as "next" (an optional #route of
  // plain characters is kept, e.g. admin.html#transactions/<uuid>); anything else is ignored.
  var NEXT_PAGES = ['portal.html', 'admin.html', 'platform.html', 'ocr.html', 'bulk-upload.html', 'help.html'];
  function safeNext() {
    var n = String(query.next || '').replace(/^\.?\//, '');
    var m = /^([a-z-]+\.html)(#[A-Za-z0-9/_-]{1,120})?$/.exec(n);
    return m && NEXT_PAGES.indexOf(m[1]) !== -1 ? n : '';
  }
  function nextPage(n) { return String(n || '').split('#')[0]; }
  function cleanUrl(keepHash) {
    try { history.replaceState(null, '', location.pathname + (keepHash ? '#' + keepHash : '')); } catch (e) { /* ignore */ }
  }

  /* ---- invitation token: ?invite=<64 hex> → sessionStorage, out of the address bar ---- */
  var INVITE_KEY = 'marsa_invite';
  var TOKEN_RE = /^[0-9a-f]{64}$/i;
  var inviteToken = null;
  var inviteFromUrl = false;   // the token came in THIS page's address (a link anyone could have sent)
  // marker set by the invite sign-up form of this tab: {t: token, e: e-mail}. Only with it may
  // the page accept automatically after the confirmation link (never from URL flags alone).
  var SIGNUP_KEY = 'marsa_invite_signup';
  function readSignupMarker() {
    try { var m = JSON.parse(sessionStorage.getItem(SIGNUP_KEY) || 'null'); return m && typeof m === 'object' ? m : null; } catch (e) { return null; }
  }
  function storeSignupMarker(m) {
    try { if (m) sessionStorage.setItem(SIGNUP_KEY, JSON.stringify(m)); else sessionStorage.removeItem(SIGNUP_KEY); } catch (e) { /* storage blocked */ }
  }
  function storeInvite(t) { try { if (t) sessionStorage.setItem(INVITE_KEY, t); else sessionStorage.removeItem(INVITE_KEY); } catch (e) { /* storage blocked: memory only */ } }
  (function readInvite() {
    if (query.invite != null) {
      inviteFromUrl = true;
      var t = String(query.invite).trim();
      inviteToken = TOKEN_RE.test(t) ? t.toLowerCase() : '';
      storeInvite(inviteToken || null);
      delete query.invite;
      // rebuild the URL without the token (keep the other parameters and the hash)
      var rest = Object.keys(query).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); }).join('&');
      try { history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (e) { /* ignore */ }
      searchAtLoad = rest ? '?' + rest : '';
      return;
    }
    try { var s = sessionStorage.getItem(INVITE_KEY); if (s && TOKEN_RE.test(s)) inviteToken = s; } catch (e) { /* ignore */ }
  })();
  function clearInvite() { inviteToken = null; invitePreview = null; storeInvite(null); storeSignupMarker(null); }

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

  var VIEWS = ['loading', 'tabs', 'forgot', 'reset', 'session', 'demo', 'invite', 'mfa', 'security'];
  function showView(name) {
    VIEWS.forEach(function (v) {
      var el = $('[data-auth-view="' + v + '"]');
      if (el) el.hidden = v !== name;
    });
  }
  function showClientSub(name) {   // signin | signup
    $$('[data-client-sub]').forEach(function (el) { el.hidden = el.getAttribute('data-client-sub') !== name; });
  }
  function showInviteSub(name) {   // accept | signin | signup | none
    $$('[data-invite-sub]').forEach(function (el) { el.hidden = el.getAttribute('data-invite-sub') !== name; });
  }
  function selectTab(which) {
    var tab = document.getElementById('tab-' + which);
    if (tab) tab.click();
  }
  function setBusy(form, busy) {
    var btn = form.querySelector('button[type="submit"]');
    $$('input, button, select', form).forEach(function (el) { el.disabled = busy; });
    if (btn) btnBusy(btn, busy);
  }
  function btnBusy(btn, busy) {
    if (busy) { btn.setAttribute('data-label', btn.textContent); btn.textContent = tr('working'); btn.setAttribute('aria-busy', 'true'); btn.disabled = true; }
    else {
      if (btn.getAttribute('data-label')) btn.textContent = btn.getAttribute('data-label');
      btn.removeAttribute('data-label'); btn.removeAttribute('aria-busy'); btn.disabled = false;
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
  function errText(err) { return (err && err.message) || (api && api.errorMessage ? api.errorMessage(err) : tr('unknownError')); }

  /* ---- password show/hide toggles ---- */
  $$('[data-toggle-password]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = document.getElementById(btn.getAttribute('aria-controls'));
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? tr('hidePw') : tr('showPw'));
    });
  });

  /* ---- routing by role ---- */
  function routeByRole(preferStaff) {
    if (routing) return Promise.resolve();
    routing = true;
    var aalP = typeof api.mfaAal === 'function' ? api.mfaAal() : Promise.resolve({ data: null, error: null });
    return Promise.all([api.myContext(true), aalP]).then(function (rs) {
      var r = rs[0];
      var ctx = r.data || {};
      // two-step verification before any routing (MFA_SPEC §5.3)
      if (!r.error && mfaStep(ctx, (rs[1] && rs[1].data) || {}, preferStaff)) { routing = false; return; }
      // staff in any organization (multi-org users pick the org in admin.html)
      var staff = !r.error && (ctx.memberships || []).some(function (m) { return m.role && m.role !== 'client'; });
      var platform = !r.error && !!ctx.is_platform_admin;
      var next = safeNext();
      // staff: any allowed page; platform-only admin: platform.html; client: portal.html
      var dest = staff ? (next || 'admin.html#dashboard')
        : (platform ? 'platform.html' : (nextPage(next) === 'portal.html' ? next : 'portal.html'));
      if (preferStaff && !staff && !platform) {
        showMsg(tr('notStaff'), 'warning');
        setTimeout(function () { location.replace(dest); }, 1800);
        return;
      }
      showMsg(tr('signedIn'), 'success');
      location.replace(dest);
    });
  }

  /* ---- two-step verification step (view "mfa") ----
     true when a challenge / enrollment screen is shown instead of routing */
  function mfaStep(ctx, aal, preferStaff) {
    var Mfa = window.MarsaMfa, host = $('[data-mfa-host]');
    if (!Mfa || !host || typeof api.mfaState !== 'function') return false;   // the server still denies admin access at aal1
    var st = api.mfaState(ctx);
    var challenge = (aal.current === 'aal1' && aal.next === 'aal2') || (st.required && !st.satisfied && st.enrolled);
    var enroll = !challenge && st.required && !st.satisfied;
    if (!challenge && !enroll) return false;
    hideMsg();
    showView('mfa');
    var opts = {
      required: st.required,
      onDone: function () { routing = false; routeByRole(preferStaff); },
      onCancel: function () {
        api.signOut().then(function () {
          showView('tabs'); selectTab(preferStaff || mfaAtLoad ? 'staff' : 'client'); showClientSub('signin');
          showMsg(tr('signedOut'), 'info');
        });
      }
    };
    if (challenge) Mfa.renderChallenge(host, opts); else Mfa.renderEnroll(host, opts);
    return true;
  }

  /* ---- account security (view "security") ---- */
  function showSecurity() {
    hideMsg();
    showView('security');
    var host = $('[data-security-host]');
    return api.myContext(true).then(function (r) {
      if (r.error && r.error.code === 'MRS_AUTH_REQUIRED') { showView('tabs'); return; }
      if (window.MarsaMfa && host) window.MarsaMfa.renderManage(host, { ctx: r.error ? null : r.data });
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
    if (inviteToken !== null) {
      // an invitation cannot be used without the online setup
      showMsg(inviteToken ? tr('inviteDemo') : tr('inviteInvalid'), 'warning');
      clearInvite();
    }
    return;
  }

  /* ======================================================================
     ONLINE MODE
     ====================================================================== */
  document.documentElement.setAttribute('data-auth-ready', 'loading');
  $$('[data-online-only]').forEach(function (el) { el.hidden = false; });
  var initialTab = /staff/.test(hashAtLoad) ? 'staff' : 'client';
  // until the session is known: a neutral loading state (no form flash before a PWA redirect)
  if (inviteToken) { showView('invite'); showInviteSub('none'); }
  else showView('loading');
  selectTab(initialTab);
  showClientSub(/signup/.test(hashAtLoad) ? 'signup' : 'signin');

  // keep the #client / #staff anchors working after load
  window.addEventListener('hashchange', function () {
    var h = location.hash;
    if (h === '#staff') { showView('tabs'); showClientSub('signin'); selectTab('staff'); }
    else if (h === '#client' || h === '#signup') { showView('tabs'); selectTab('client'); showClientSub(h === '#signup' ? 'signup' : 'signin'); }
  });
  $$('[data-tab-hash]').forEach(function (t) {
    t.addEventListener('click', function () {
      try { history.replaceState(null, '', location.pathname + searchAtLoad + '#' + t.getAttribute('data-tab-hash')); } catch (e) { /* ignore */ }
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
  $$('[data-go-tabs]').forEach(function (b) {
    b.addEventListener('click', function () { hideMsg(); if (inviteToken && invitePreview) { showView('invite'); showInviteSub('signin'); } else showView('tabs'); });
  });

  /* ---- sign-in (client + staff share Supabase auth) ---- */
  // onSignedIn(): what happens after a successful sign-in (default: route by role)
  function bindSignIn(form, emailId, pwId, preferStaff, onSignedIn) {
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      hideMsg(); clearErrors(form);
      var em = $('#' + emailId), pw = $('#' + pwId), bad = false;
      if (!validEmail(em.value)) { fieldError(em, tr('email')); bad = true; }
      if (!pw.value) { fieldError(pw, tr('required')); bad = true; }
      if (bad) { (form.querySelector('[aria-invalid="true"]') || em).focus(); return; }
      setBusy(form, true);
      api.signIn(em.value.trim(), pw.value).then(function (r) {
        if (r.error) { setBusy(form, false); pw.value = ''; showMsg(errText(r.error), 'danger'); return; }
        pw.value = '';
        var next = onSignedIn ? onSignedIn(r.data) : routeByRole(preferStaff);
        return Promise.resolve(next).then(function () { setBusy(form, false); });
      });
    });
  }
  bindSignIn($('#client-signin-form'), 'ci-email', 'ci-password', false);
  bindSignIn($('#staff-signin-form'), 'st-email', 'st-password', true);

  /* ---- client sign-up ---- */
  var signupRedirect = location.origin + location.pathname.replace(/[^/]*$/, '') + 'login.html?confirmed=1';
  var su = $('#client-signup-form');
  if (su) su.addEventListener('submit', function (e) {
    e.preventDefault();
    hideMsg(); clearErrors(su);
    var name = $('#su-name'), phone = $('#su-phone'), em = $('#su-email'), pw = $('#su-password'), pw2 = $('#su-password2'), ack = $('#su-ack');
    var bad = false, p = normPhone(phone.value);
    if (String(name.value).trim().length < 2 || String(name.value).trim().length > 120) { fieldError(name, tr('name')); bad = true; }
    if (!p) { fieldError(phone, tr('phone')); bad = true; }
    if (!validEmail(em.value)) { fieldError(em, tr('email')); bad = true; }
    if (!validPassword(pw.value)) { fieldError(pw, tr('password')); bad = true; }
    if (pw2.value !== pw.value) { fieldError(pw2, tr('passwordMatch')); bad = true; }
    var ackGroup = ack.closest('.form-group');
    if (!ack.checked) { if (ackGroup) ackGroup.classList.add('has-error'); bad = true; } else if (ackGroup) ackGroup.classList.remove('has-error');
    if (bad) { (su.querySelector('[aria-invalid="true"]') || name).focus(); return; }
    setBusy(su, true);
    api.signUp(em.value.trim(), pw.value, { fullName: String(name.value).trim(), phone: p, locale: lang(), redirectTo: signupRedirect })
      .then(function (r) {
        setBusy(su, false);
        pw.value = ''; pw2.value = '';
        if (r.error) { showMsg(errText(r.error), 'danger'); return; }
        if (r.data && r.data.session) { return routeByRole(false); }   // email confirmation disabled on this project
        su.reset();
        showClientSub('signin');
        showMsg(tr('signupSent'), 'success');
      });
  });

  /* ---- forgot password ---- */
  var fp = $('#forgot-form');
  if (fp) fp.addEventListener('submit', function (e) {
    e.preventDefault();
    hideMsg(); clearErrors(fp);
    var em = $('#fp-email');
    if (!validEmail(em.value)) { fieldError(em, tr('email')); em.focus(); return; }
    setBusy(fp, true);
    var redirect = location.origin + location.pathname.replace(/[^/]*$/, '') + 'login.html?mode=reset';
    api.resetPassword(em.value.trim(), redirect).then(function (r) {
      setBusy(fp, false);
      // same message whether or not the address exists (no account enumeration)
      if (r.error && r.error.code === 'AUTH_RATE') { showMsg(errText(r.error), 'warning'); return; }
      if (r.error && r.error.code === 'MRS_NETWORK') { showMsg(errText(r.error), 'danger'); return; }
      showMsg(tr('resetSent'), 'success');
    });
  });

  /* ---- reset (new password after the recovery link) ---- */
  var rp = $('#reset-form');
  if (rp) rp.addEventListener('submit', function (e) {
    e.preventDefault();
    hideMsg(); clearErrors(rp);
    var pw = $('#rp-password'), pw2 = $('#rp-password2'), bad = false;
    if (!validPassword(pw.value)) { fieldError(pw, tr('password')); bad = true; }
    if (pw2.value !== pw.value) { fieldError(pw2, tr('passwordMatch')); bad = true; }
    if (bad) { (rp.querySelector('[aria-invalid="true"]') || pw).focus(); return; }
    setBusy(rp, true);
    api.getSession().then(function (s) {
      if (!s.data) { setBusy(rp, false); showMsg(tr('resetNoSession'), 'danger'); return; }
      return api.updatePassword(pw.value).then(function (r) {
        setBusy(rp, false);
        pw.value = ''; pw2.value = '';
        if (r.error) { showMsg(errText(r.error), 'danger'); return; }
        recoveryMode = false;
        cleanUrl();
        if (M.toast) M.toast(tr('resetDone'), 'success');
        showMsg(tr('resetDone'), 'success');
        if (inviteToken) return api.getSession().then(function (s2) { startInvite(s2.data, false); });
        routeByRole(false);
      });
    });
  });

  /* ---- sign-out (this device / all devices) + continue (signed-in panel) ---- */
  $$('[data-sign-out]').forEach(function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      api.signOut().then(function () {
        b.disabled = false;
        showView('tabs'); selectTab('client'); showClientSub('signin');
        showMsg(tr('signedOut'), 'info');
      });
    });
  });
  $$('[data-sign-out-all]').forEach(function (b) {
    b.addEventListener('click', function () {
      btnBusy(b, true);
      api.signOutEverywhere().then(function (r) {
        btnBusy(b, false);
        if (r.error) { showMsg(errText(r.error), 'danger'); return; }
        showView('tabs'); selectTab('client'); showClientSub('signin');
        showMsg(tr('signedOutAll'), 'info');
      });
    });
  });
  $$('[data-continue]').forEach(function (b) { b.addEventListener('click', function () { routeByRole(false); }); });
  $$('[data-go-security]').forEach(function (b) { b.addEventListener('click', function () { showSecurity(); }); });
  $$('[data-go-session]').forEach(function (b) {
    b.addEventListener('click', function () {
      hideMsg();
      api.getSession().then(function (s) { if (s.data) showSession(s.data.user); else showView('tabs'); });
    });
  });

  /* ======================================================================
     INVITATION
     ====================================================================== */
  var invitePreview = null;
  function roleLabel(p) {
    var l = lang();
    return (l === 'en' ? p.role_label_en : p.role_label_ar) || p.role_label_ar ||
      (I && I.has && I.has('login.role_' + p.role) ? I.t('login.role_' + p.role) : (T.roleFallback[p.role] || p.role || ''));
  }
  function fmtDate(d) {
    if (!d) return '';
    if (I && typeof I.fmtDate === 'function') return I.fmtDate(d, { time: true });
    try { return new Date(d).toLocaleString('ar-SA-u-nu-latn-ca-gregory'); } catch (e) { return String(d); }
  }
  function renderInvite() {
    var p = invitePreview;
    if (!p) return;
    var l = lang();
    var set = function (sel, v) { var el = $(sel); if (el) el.textContent = v == null ? '' : String(v); };
    set('[data-invite-org]', (l === 'en' && p.org_name_en) ? p.org_name_en : (p.org_name_ar || p.org_name_en || ''));
    set('[data-invite-role]', roleLabel(p));
    set('[data-invite-email]', p.email_masked || '');
    set('[data-invite-expires]', fmtDate(p.expires_at));
    var br = $('[data-invite-branch-row]');
    if (br) br.hidden = !p.branch_name_ar;
    set('[data-invite-branch]', p.branch_name_ar || '');
    var lo = $('[data-invite-loading]'); if (lo) lo.hidden = true;
    var card = $('[data-invite-card]'); if (card) card.hidden = false;
  }
  window.addEventListener('marsa:langchange', renderInvite);

  // session: current Supabase session (or null); autoAccept: accept right away when signed in
  function startInvite(session, autoAccept) {
    hideMsg();
    showView('invite'); showInviteSub('none');
    var lo = $('[data-invite-loading]'); if (lo) lo.hidden = false;
    var card = $('[data-invite-card]'); if (card) card.hidden = true;
    return api.invitationPreview(inviteToken).then(function (r) {
      if (r.error) {
        if (lo) lo.hidden = true;
        if (r.error.code === 'MRS_NOT_FOUND' || r.error.code === 'MRS_EXPIRED' || r.error.code === 'MRS_INVALID') {
          clearInvite();
          if (session) showSession(session.user); else showView('tabs');
          showMsg(tr('inviteInvalid'), 'danger');
        } else {
          showMsg(tr('inviteRetry') + ' ' + errText(r.error), 'danger');
        }
        return;
      }
      invitePreview = r.data || {};
      renderInvite();
      if (session) {
        var se = $('[data-invite-session-email]'); if (se) se.textContent = (session.user && session.user.email) || '';
        showInviteSub('accept');
        if (autoAccept) return acceptNow();
      } else {
        showInviteSub('signin');
      }
    });
  }
  function acceptNow() {
    var btn = $('[data-invite-accept]');
    if (!inviteToken) return Promise.resolve();
    if (btn) btnBusy(btn, true);
    var role = invitePreview && invitePreview.role;
    return api.acceptInvitation(inviteToken).then(function (r) {
      if (btn) btnBusy(btn, false);
      if (r.error) {
        var c = r.error.code;
        api.getSession().then(function (s) {
          if (c === 'MRS_NOT_FOUND' || c === 'MRS_EXPIRED') {
            clearInvite();
            if (s.data) showSession(s.data.user); else showView('tabs');
            showMsg(tr('inviteInvalid'), 'danger');
            return;
          }
          showView('invite');
          if (s.data) {
            var se = $('[data-invite-session-email]'); if (se) se.textContent = (s.data.user && s.data.user.email) || '';
            showInviteSub('accept');
          } else showInviteSub('signin');
          showMsg(c === 'MRS_EMAIL_MISMATCH' ? tr('inviteMismatch') : c === 'MRS_EMAIL_UNCONFIRMED' ? tr('inviteUnconfirmed') : errText(r.error),
            c === 'MRS_EMAIL_UNCONFIRMED' ? 'warning' : 'danger');
        });
        return;
      }
      var d = r.data || {};
      clearInvite();
      role = d.role || role;
      showMsg(tr('inviteAccepted'), 'success');
      var dest = role === 'client' ? 'portal.html' : 'admin.html#dashboard';
      var setOrg = d.org_id && role !== 'client' ? api.setActiveOrg(d.org_id) : Promise.resolve();
      return setOrg.then(function () { routing = true; location.replace(dest); });
    });
  }
  var acceptBtn = $('[data-invite-accept]');
  if (acceptBtn) acceptBtn.addEventListener('click', function () { hideMsg(); acceptNow(); });
  $$('[data-invite-go]').forEach(function (b) {
    b.addEventListener('click', function () {
      hideMsg();
      var to = b.getAttribute('data-invite-go');
      showInviteSub(to);
      var f = $(to === 'signup' ? '#ivs-name' : '#iv-email'); if (f) f.focus();
    });
  });
  $$('[data-invite-switch]').forEach(function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      api.signOut().then(function () {
        storeInvite(inviteToken);   // signOut clears per-user storage; this invitation continues
        b.disabled = false; hideMsg(); showInviteSub('signin'); var f = $('#iv-email'); if (f) f.focus();
      });
    });
  });
  $$('[data-invite-dismiss]').forEach(function (b) {
    b.addEventListener('click', function () {
      clearInvite();
      api.getSession().then(function (s) {
        if (s.data) showSession(s.data.user); else { showView('tabs'); selectTab('client'); showClientSub('signin'); }
        showMsg(tr('inviteDismissed'), 'info');
      });
    });
  });
  // sign in with the invited e-mail → accept right away (no role routing first)
  bindSignIn($('#invite-signin-form'), 'iv-email', 'iv-password', false, function () { return acceptNow(); });

  // sign up with the invited e-mail; accept after confirmation + sign-in
  var ivs = $('#invite-signup-form');
  if (ivs) ivs.addEventListener('submit', function (e) {
    e.preventDefault();
    hideMsg(); clearErrors(ivs);
    var name = $('#ivs-name'), phone = $('#ivs-phone'), em = $('#ivs-email'), pw = $('#ivs-password'), pw2 = $('#ivs-password2'), ack = $('#ivs-ack');
    var bad = false, p = phone.value.trim() ? normPhone(phone.value) : '';
    if (String(name.value).trim().length < 2 || String(name.value).trim().length > 120) { fieldError(name, tr('name')); bad = true; }
    if (p === null) { fieldError(phone, tr('phone')); bad = true; }
    if (!validEmail(em.value)) { fieldError(em, tr('email')); bad = true; }
    if (!validPassword(pw.value)) { fieldError(pw, tr('password')); bad = true; }
    if (pw2.value !== pw.value) { fieldError(pw2, tr('passwordMatch')); bad = true; }
    var ackGroup = ack.closest('.form-group');
    if (!ack.checked) { if (ackGroup) ackGroup.classList.add('has-error'); bad = true; } else if (ackGroup) ackGroup.classList.remove('has-error');
    if (bad) { (ivs.querySelector('[aria-invalid="true"]') || name).focus(); return; }
    setBusy(ivs, true);
    var email = em.value.trim();
    api.signUp(email, pw.value, { fullName: String(name.value).trim(), phone: p || '', locale: lang(), redirectTo: signupRedirect })
      .then(function (r) {
        setBusy(ivs, false);
        pw.value = ''; pw2.value = '';
        if (r.error) { showMsg(errText(r.error), 'danger'); return; }
        if (r.data && r.data.session) return acceptNow();   // email confirmation disabled on this project
        storeSignupMarker({ t: inviteToken, e: email.toLowerCase() });
        ivs.reset();
        var ie = $('#iv-email'); if (ie) ie.value = email;
        showInviteSub('signin');
        showMsg(tr('inviteSignupSent'), 'success');
      });
  });

  /* ---- auth events ---- */
  api.onAuth(function (event) {
    if (event === 'PASSWORD_RECOVERY') { recoveryMode = true; hideMsg(); showView('reset'); var f = $('#rp-password'); if (f) f.focus(); }
  });

  /* ---- initial state ---- */
  api.ready().then(function (r) {
    document.documentElement.setAttribute('data-auth-ready', r.error ? 'error' : 'ready');
    if (r.error) {
      if (!inviteToken) showView('tabs');
      showMsg(tr('loadFail'), 'danger'); $$('form[data-auth-form]').forEach(function (f) { setBusy(f, true); }); return;
    }
    return api.getSession().then(function (s) {
      var session = s.data;
      if (linkErrorAtLoad && !session) {
        cleanUrl(); showView(recoveryMode ? 'forgot' : 'tabs'); showMsg(tr('linkError'), 'danger'); return;
      }
      if (recoveryMode) {
        if (session) { showView('reset'); var f = $('#rp-password'); if (f) f.focus(); }
        else { cleanUrl(); showView('forgot'); showMsg(tr('resetNoSession'), 'danger'); }
        return;
      }
      if (inviteToken) {
        // Back from the e-mail confirmation link in this tab → accept straight away, but only
        // when this tab itself started the invite sign-up for this token and the signed-in
        // e-mail is the one used there. A crafted login.html?invite=…&confirmed=1 link (or
        // #type=signup) only shows the preview + accept button (no silent joining).
        var mk = readSignupMarker();
        var auto = !!(session && confirmedAtLoad && !inviteFromUrl && mk && mk.t === inviteToken
          && session.user && String(session.user.email || '').toLowerCase() === mk.e);
        if (confirmedAtLoad || inviteFromUrl) cleanUrl();
        return startInvite(session, auto);
      }
      if (inviteToken === '') {   // ?invite= present but not a well-formed token
        inviteToken = null;
        if (session) showSession(session.user); else showView('tabs');
        showMsg(tr('inviteInvalid'), 'danger');
        return;
      }
      if (session) {
        if (securityAtLoad) return showSecurity();
        // sent here for two-step verification (app-shell / admin / platform gates): that step at once
        if (mfaAtLoad) return routeByRole(false);
        // back from the confirmation link, or the installed app starting: go straight in
        if (confirmedAtLoad || fromPwa) { cleanUrl(); return routeByRole(false); }
        showSession(session.user);
        return;
      }
      showView('tabs');
      if (mfaAtLoad) { selectTab('staff'); return; }
      if (confirmedAtLoad) { cleanUrl('client'); showMsg(tr('confirmed'), 'success'); return; }
      if (signedOutAtLoad) {
        cleanUrl(location.hash.replace(/^#/, ''));
        showMsg(tr(signedOutAtLoad === 'all' ? 'signedOutAll' : 'signedOut'), 'info');
        return;
      }
      if (fromPwa) cleanUrl(location.hash.replace(/^#/, ''));
    });
  });
})();
