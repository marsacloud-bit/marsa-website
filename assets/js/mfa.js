/* ==========================================================================
   مرسى | MARSA — two-step verification (TOTP) screens (window.MarsaMfa)
   docs/online/MFA_SPEC.md §5.2. Used by auth.js (login.html views "mfa" and
   "security"). All Supabase Auth MFA calls go through MarsaApi.mfa* (supa.js).
   Load order: … → supa.js → mfa.js → auth.js (defer).

   * renderChallenge(host, {factorId?, onDone, onCancel}) — 6-digit code (aal1 → aal2)
   * renderEnroll(host, {required, onDone, onCancel, onSkip?}) — QR (<img src>, SVG data URI
     only) + the secret as text + 6-digit verify
   * renderManage(host, {ctx, onChange, onBack?}) — account security: status, verified
     factors, enable / add another device / remove (the last one is blocked while required)
   DOM is built with createElement / textContent only; nothing from the server or the user
   is ever parsed as HTML.
   ========================================================================== */
(function () {
  'use strict';

  var api = window.MarsaApi;
  var I = window.MarsaI18n || null;

  /* ---- strings: assets/i18n/login.js ('login.*'); Arabic fallback here ---- */
  var T = {
    mfaChallengeTitle: 'التحقق بخطوتين',
    mfaChallengeLead: 'أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة على جوالك.',
    mfaCodeLabel: 'رمز التحقق',
    mfaCodeFormat: 'الرمز 6 أرقام.',
    mfaVerifyBtn: 'تحقّق',
    mfaInvalidCode: 'الرمز غير صحيح أو انتهت صلاحيته. أدخل الرمز الحالي من التطبيق.',
    mfaDone: 'تم التحقق. جارٍ تحويلك…',
    mfaEnrollTitle: 'فعّل التحقق بخطوتين',
    mfaEnrollRequired: 'حسابك له صلاحيات إدارية، لذلك التحقق بخطوتين إلزامي قبل المتابعة.',
    mfaEnrollStep1: 'امسح رمز QR بتطبيق مصادقة مثل Google Authenticator أو Microsoft Authenticator.',
    mfaQrAlt: 'رمز QR لإضافة حسابك إلى تطبيق المصادقة',
    mfaQrMissing: 'تعذّر عرض رمز QR. أدخل المفتاح أدناه يدويًا في التطبيق.',
    mfaSecretLabel: 'أو أدخل هذا المفتاح يدويًا في التطبيق',
    mfaCopySecret: 'نسخ المفتاح',
    mfaCopied: 'تم النسخ.',
    mfaEnrollStep2: 'ثم أدخل الرمز الذي يظهر في التطبيق.',
    mfaEnrollBtn: 'تفعيل',
    mfaEnrolled: 'تم تفعيل التحقق بخطوتين.',
    mfaEnrollFail: 'تعذّر بدء التفعيل. حاول مرة أخرى.',
    mfaRetry: 'إعادة المحاولة',
    mfaLostDevice: 'فقدت جهازك؟ تواصل مع مالك المنصة لإعادة تعيين التحقق بخطوتين.',
    mfaCancelSignOut: 'إلغاء وتسجيل الخروج',
    mfaSkip: 'لاحقًا',
    securityLead: 'التحقق بخطوتين يحمي حسابك حتى لو عُرفت كلمة المرور.',
    securityStatusOn: 'التحقق بخطوتين مفعّل',
    securityStatusOff: 'التحقق بخطوتين غير مفعّل',
    securityRequiredNote: 'إلزامي لحسابك (مدير مؤسسة أو مشرف منصة).',
    securityEnable: 'تفعيل التحقق بخطوتين',
    securityAddDevice: 'إضافة جهاز آخر',
    securityDisable: 'إزالة',
    securityDisableConfirm: 'هل تريد إزالة وسيلة التحقق هذه؟',
    securityDisableBlocked: 'لا يمكن إزالة آخر وسيلة تحقق لأن التحقق بخطوتين إلزامي لحسابك.',
    securityDisabled: 'أُزيلت وسيلة التحقق.',
    securityFactorAdded: 'أُضيف في {date}',
    securityFactorName: 'تطبيق المصادقة',
    securityNeedsAal2: 'لإدارة وسائل التحقق أدخل رمز التحقق أولًا.',
    securityLoadFail: 'تعذّر تحميل إعدادات الأمان. حاول مرة أخرى.',
    securityBack: 'العودة',
    working: 'جارٍ التنفيذ…',
    unknownError: 'حدث خطأ غير متوقع.'
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
  // re-localized on a language switch when the code has its own err.<CODE> string (no field / extra part)
  function errText(err) {
    if (err && err.code && !err.field && I && typeof I.t === 'function') {
      var k = 'err.' + err.code, s = I.t(k);
      if (s && s !== k) return s;
    }
    return (err && err.message) || (api && api.errorMessage ? api.errorMessage(err) : tr('unknownError'));
  }

  /* ---- language switch: every string node these screens create is registered here and re-labelled in place on
     'marsa:langchange' (the screens are NOT rebuilt: that would drop the pending factor, its QR / secret and the
     typed code). Disconnected nodes are pruned. ---- */
  var labels = [];
  function K(k, vars) { return function () { return tr(k, vars); }; }
  function applyLabel(e) {
    var v = String(e.f());
    if (e.a) { e.n.setAttribute(e.a, v); return; }
    if (e.n.getAttribute('aria-busy') === 'true' && e.n.hasAttribute('data-label')) {
      e.n.setAttribute('data-label', v); e.n.textContent = tr('working'); return;
    }
    e.n.textContent = v;
  }
  // text: a plain string (set once) or a function (re-evaluated on every language switch)
  function bind(n, text, attr) {
    if (typeof text !== 'function') { if (attr) n.setAttribute(attr, String(text)); else n.textContent = String(text); return n; }
    for (var i = 0; i < labels.length; i++) if (labels[i].n === n && labels[i].a === (attr || null)) { labels.splice(i, 1); break; }
    var e = { n: n, f: text, a: attr || null };
    labels.push(e);
    applyLabel(e);
    return n;
  }
  function relabel() {
    labels = labels.filter(function (e) { return e.n.isConnected; });
    labels.forEach(applyLabel);
  }
  window.addEventListener('marsa:langchange', relabel);
  function fmtDate(d) {
    if (!d) return '';
    if (I && typeof I.fmtDate === 'function') { try { return I.fmtDate(d); } catch (e) { /* fall through */ } }
    try { return new Date(d).toLocaleDateString('ar-SA-u-nu-latn-ca-gregory'); } catch (e) { return String(d); }
  }

  /* ---- DOM helpers (textContent only) ---- */
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] == null || attrs[k] === false) return;
      if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k] === true ? '' : String(attrs[k]));
    });
    if (text != null) bind(n, text);
    return n;
  }
  function clear(host) { while (host.firstChild) host.removeChild(host.firstChild); }
  function alertBox() {
    var box = el('div', { class: 'alert mb-3', role: 'status', 'aria-live': 'polite', tabindex: '-1' });
    box.hidden = true;
    return {
      node: box,
      show: function (text, type) {
        box.className = 'alert alert-' + (type || 'info') + ' mb-3';
        bind(box, typeof text === 'function' ? text : function () { return text; }); box.hidden = false;
        try { box.focus({ preventScroll: false }); } catch (e) { /* old browsers */ }
      },
      hide: function () { box.hidden = true; }
    };
  }
  function btn(cls, label, type) { return el('button', { class: cls, type: type || 'button' }, label); }
  function busy(b, on) {
    if (!b) return;
    if (on) { b.setAttribute('data-label', b.textContent); b.setAttribute('aria-busy', 'true'); b.textContent = tr('working'); b.disabled = true; }
    else {
      var lb = b.getAttribute('data-label');
      b.removeAttribute('data-label'); b.removeAttribute('aria-busy'); b.disabled = false;
      if (lb) b.textContent = lb;
    }
  }
  function normDigits(s) {
    return String(s || '').replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 1632); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 1776); });
  }
  function cleanCode(s) { return normDigits(s).replace(/[\s-]/g, ''); }
  var uid = 0;

  // the 6-digit code form; onSubmit(code, form) returns a promise of {error}
  function codeForm(lead, submitLabel, onSubmit) {
    var id = 'mfa-code-' + (++uid);
    var form = el('form', { class: 'form', novalidate: true });
    var g = el('div', { class: 'form-group' });
    var lbl = el('label', { class: 'form-label', for: id }, K('mfaCodeLabel'));
    var input = el('input', { class: 'form-control mfa-code', id: id, name: 'code', type: 'text', inputmode: 'numeric',
      autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '12', dir: 'ltr', required: true,
      'aria-describedby': id + '-hint' });
    var hint = el('span', { class: 'form-hint', id: id + '-hint' }, lead || K('mfaCodeFormat'));
    var err = el('span', { class: 'form-error' }, K('mfaCodeFormat'));
    g.appendChild(lbl); g.appendChild(input); g.appendChild(hint); g.appendChild(err);
    var submit = btn('btn btn-primary btn-block', submitLabel || K('mfaVerifyBtn'), 'submit');
    form.appendChild(g); form.appendChild(submit);
    // maxlength 12, not 6: a pasted grouped code ('123 456', '123-456') must reach this handler whole
    input.addEventListener('input', function () {
      var v = cleanCode(input.value).replace(/\D/g, '').slice(0, 6);
      if (v !== input.value) input.value = v;
      g.classList.remove('has-error'); input.removeAttribute('aria-invalid');
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = cleanCode(input.value);
      if (!/^[0-9]{6}$/.test(code)) {
        g.classList.add('has-error'); input.setAttribute('aria-invalid', 'true'); input.focus(); return;
      }
      busy(submit, true); input.disabled = true;
      Promise.resolve(onSubmit(code)).then(function (r) {
        busy(submit, false); input.disabled = false;
        if (r && r.error) { input.value = ''; input.focus(); }
      }, function () { busy(submit, false); input.disabled = false; });
    });
    return { form: form, input: input, focus: function () { try { input.focus(); } catch (e) { /* hidden */ } } };
  }
  // only a real wrong / expired code says so; anything else (session lost, factor gone, 5xx) shows its own message
  function invalidCodeMsg(err) {
    return (err && err.code === 'MFA_INVALID_CODE') ? K('mfaInvalidCode') : function () { return errText(err); };
  }

  /* ======================================================================
     Challenge (user has a verified factor, session aal1)
     ====================================================================== */
  function renderChallenge(host, o) {
    o = o || {};
    clear(host);
    var wrap = el('div', { class: 'mfa-view', 'data-mfa': 'challenge' });
    wrap.appendChild(el('h3', { class: 'auth-h' }, K('mfaChallengeTitle')));
    wrap.appendChild(el('p', { class: 'text-muted text-sm' }, K('mfaChallengeLead')));
    var msg = alertBox(); wrap.appendChild(msg.node);
    var factorId = o.factorId || null;
    var cf = codeForm(null, K('mfaVerifyBtn'), function (code) {
      msg.hide();
      var getId = factorId ? Promise.resolve({ data: factorId }) : api.mfaFactors().then(function (r) {
        if (r.error) return r;
        var f = (r.data.verified || [])[0];
        factorId = f ? f.id : null;
        return { data: factorId, error: factorId ? null : { code: 'MFA_NO_FACTOR', message: tr('mfaEnrollFail') } };
      });
      return getId.then(function (r) {
        if (r.error) { msg.show(function () { return errText(r.error); }, 'danger'); return r; }
        return api.mfaVerify(r.data, code).then(function (v) {
          // the session is gone (expired / revoked): typing more codes cannot help → sign in again
          if (v.error && v.error.code === 'MRS_AUTH_REQUIRED' && o.onCancel) { o.onCancel(); return v; }
          if (v.error) { msg.show(invalidCodeMsg(v.error), 'danger'); return v; }
          msg.show(K('mfaDone'), 'success');
          if (o.onDone) o.onDone();
          return v;
        });
      });
    });
    wrap.appendChild(cf.form);
    wrap.appendChild(el('p', { class: 'text-muted text-sm mt-3 mb-0' }, K('mfaLostDevice')));
    if (o.onCancel) {
      var links = el('div', { class: 'auth-links mt-3' });
      var cancel = btn('link-btn', o.cancelLabel || K('mfaCancelSignOut'));
      cancel.setAttribute('data-mfa-cancel', '');
      cancel.addEventListener('click', function () { cancel.disabled = true; o.onCancel(); });
      links.appendChild(cancel); wrap.appendChild(links);
    }
    host.appendChild(wrap);
    cf.focus();
    return wrap;
  }

  /* ======================================================================
     Enrollment (QR + secret + verify)
     ====================================================================== */
  function groupSecret(s) { return String(s || '').replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim(); }
  function renderEnroll(host, o) {
    o = o || {};
    clear(host);
    var wrap = el('div', { class: 'mfa-view', 'data-mfa': 'enroll' });
    wrap.appendChild(el('h3', { class: 'auth-h' }, K('mfaEnrollTitle')));
    if (o.required) wrap.appendChild(el('p', { class: 'alert alert-warning mb-3', 'data-mfa-required': '' }, K('mfaEnrollRequired')));
    var msg = alertBox(); wrap.appendChild(msg.node);
    var body = el('div', { class: 'mfa-enroll-body' });
    var loading = el('div', { class: 'auth-loading', role: 'status', 'aria-busy': 'true' });
    loading.appendChild(el('span', { class: 'auth-spinner', 'aria-hidden': 'true' }));
    loading.appendChild(el('span', null, K('working')));
    body.appendChild(loading);
    wrap.appendChild(body);
    var links = el('div', { class: 'auth-links mt-3' });
    if (!o.required && o.onSkip) {
      var skip = btn('link-btn', K('mfaSkip'));
      skip.addEventListener('click', function () { o.onSkip(); });
      links.appendChild(skip);
    }
    if (o.onCancel) {
      var cancel = btn('link-btn', o.cancelLabel || K('mfaCancelSignOut'));
      cancel.setAttribute('data-mfa-cancel', '');
      cancel.addEventListener('click', function () { cancel.disabled = true; o.onCancel(); });
      links.appendChild(cancel);
    }
    if (links.firstChild) wrap.appendChild(links);
    host.appendChild(wrap);

    function start() {
      msg.hide();
      clear(body); body.appendChild(loading);
      return api.mfaEnroll().then(function (r) {
        clear(body);
        if (r.error || !r.data || !r.data.factorId) {
          msg.show(function () { return tr('mfaEnrollFail') + (r.error ? ' ' + errText(r.error) : ''); }, 'danger');
          var again = btn('btn btn-ghost', K('mfaRetry'));
          again.addEventListener('click', start);
          body.appendChild(again);
          return;
        }
        var d = r.data;
        body.appendChild(el('p', { class: 'mb-2' }, K('mfaEnrollStep1')));
        if (d.qr && /^data:image\/svg\+xml[;,]/.test(d.qr)) {
          var img = el('img', { class: 'mfa-qr', width: '200', height: '200', decoding: 'async' });
          bind(img, K('mfaQrAlt'), 'alt');
          img.src = d.qr;   // SVG data URI from Supabase Auth; <img> never runs scripts in it
          body.appendChild(img);
        } else {
          body.appendChild(el('p', { class: 'alert alert-warning mb-2' }, K('mfaQrMissing')));
        }
        var sec = el('div', { class: 'mfa-secret-row' });
        sec.appendChild(el('p', { class: 'text-muted text-sm mb-1' }, K('mfaSecretLabel')));
        var code = el('code', { class: 'mfa-secret', dir: 'ltr', 'data-mfa-secret': '' }, groupSecret(d.secret));
        sec.appendChild(code);
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          var copy = btn('btn btn-ghost btn-sm mfa-copy', K('mfaCopySecret'));
          copy.addEventListener('click', function () {
            try {
              navigator.clipboard.writeText(String(d.secret || '')).then(function () { msg.show(K('mfaCopied'), 'success'); }, function () {});
            } catch (e) { /* clipboard blocked */ }
          });
          sec.appendChild(copy);
        }
        body.appendChild(sec);
        body.appendChild(el('p', { class: 'mb-0 mt-3' }, K('mfaEnrollStep2')));
        var cf = codeForm(null, K('mfaEnrollBtn'), function (c) {
          msg.hide();
          return api.mfaVerify(d.factorId, c).then(function (v) {
            if (v.error) { msg.show(invalidCodeMsg(v.error), 'danger'); return v; }
            clear(body);
            msg.show(K('mfaEnrolled'), 'success');
            if (o.onDone) o.onDone();
            return v;
          });
        });
        body.appendChild(cf.form);
        cf.focus();
      });
    }
    start();
    return wrap;
  }

  /* ======================================================================
     Account security (any signed-in user)
     ====================================================================== */
  function renderManage(host, o) {
    o = o || {};
    clear(host);
    var wrap = el('div', { class: 'mfa-view', 'data-mfa': 'manage' });
    var msg = alertBox();
    wrap.appendChild(el('p', { class: 'text-muted text-sm' }, K('securityLead')));
    wrap.appendChild(msg.node);
    var body = el('div');
    wrap.appendChild(body);
    if (o.onBack) {
      var links = el('div', { class: 'auth-links mt-3' });
      var back = btn('link-btn', K('securityBack'));
      back.setAttribute('data-security-back', '');
      back.addEventListener('click', function () { o.onBack(); });
      links.appendChild(back); wrap.appendChild(links);
    }
    host.appendChild(wrap);
    var st = api.mfaState(o.ctx);

    function refresh(note) {
      clear(body);
      var loading = el('div', { class: 'auth-loading', role: 'status', 'aria-busy': 'true' });
      loading.appendChild(el('span', { class: 'auth-spinner', 'aria-hidden': 'true' }));
      body.appendChild(loading);
      return Promise.all([api.mfaFactors(), api.mfaAal(), api.myContext(true)]).then(function (rs) {
        clear(body);
        if (rs[2] && !rs[2].error) st = api.mfaState(rs[2].data);
        if (rs[0].error || rs[1].error) { msg.show(function () { return tr('securityLoadFail') + ' ' + errText(rs[0].error || rs[1].error); }, 'danger'); return; }
        if (note) msg.show(note, 'success');
        draw(rs[0].data.verified || [], rs[1].data || {});
      });
    }
    function draw(factors, aal) {
      var on = factors.length > 0;
      var status = el('p', { class: 'mfa-status ' + (on ? 'is-on' : 'is-off'), 'data-mfa-status': on ? 'on' : 'off' });
      status.appendChild(el('span', { class: 'badge ' + (on ? 'badge-success' : 'badge-muted') }, K(on ? 'securityStatusOn' : 'securityStatusOff')));
      body.appendChild(status);
      if (st.required) body.appendChild(el('p', { class: 'text-sm text-muted', 'data-mfa-required': '' }, K('securityRequiredNote')));
      var atAal2 = aal.current === 'aal2';
      if (on && !atAal2) {
        // GoTrue requires aal2 to remove a verified factor or add another one
        body.appendChild(el('p', { class: 'alert alert-info mb-3' }, K('securityNeedsAal2')));
        var ch = el('div');
        body.appendChild(ch);
        renderChallenge(ch, { factorId: factors[0].id, onDone: function () { refresh(); } });
        return;
      }
      if (on) {
        var list = el('ul', { class: 'mfa-factors', 'data-mfa-factors': '' });
        factors.forEach(function (f) {
          var li = el('li', { class: 'mfa-factor' });
          var info = el('div', { class: 'mfa-factor-info' });
          info.appendChild(el('span', { class: 'fw-bold' }, K('securityFactorName')));
          info.appendChild(el('span', { class: 'text-muted text-sm' }, K('securityFactorAdded', { date: fmtDate(f.created_at) })));
          li.appendChild(info);
          var rm = btn('btn btn-ghost btn-sm', K('securityDisable'));
          rm.setAttribute('data-mfa-remove', '');
          rm.addEventListener('click', function () {
            msg.hide();
            if (st.required && factors.length <= 1) { msg.show(K('securityDisableBlocked'), 'warning'); return; }
            if (!window.confirm(tr('securityDisableConfirm'))) return;
            busy(rm, true);
            api.mfaUnenroll(f.id).then(function (r) {
              busy(rm, false);
              if (r.error) { msg.show(function () { return errText(r.error); }, 'danger'); return; }
              refresh(K('securityDisabled'));
              if (o.onChange) o.onChange();
            });
          });
          li.appendChild(rm);
          list.appendChild(li);
        });
        body.appendChild(list);
      }
      var add = btn(on ? 'btn btn-ghost' : 'btn btn-primary', K(on ? 'securityAddDevice' : 'securityEnable'));
      add.setAttribute('data-mfa-add', '');
      add.addEventListener('click', function () {
        msg.hide();
        clear(body);
        var eh = el('div');
        body.appendChild(eh);
        renderEnroll(eh, {
          required: false,
          cancelLabel: K('securityBack'),
          onCancel: function () { refresh(); },
          onDone: function () { refresh(K('mfaEnrolled')); if (o.onChange) o.onChange(); }
        });
      });
      var row = el('div', { class: 'btn-group mt-3' });
      row.appendChild(add);
      body.appendChild(row);
    }
    refresh();
    return wrap;
  }

  window.MarsaMfa = { renderChallenge: renderChallenge, renderEnroll: renderEnroll, renderManage: renderManage };
})();
