/* =====================================================================
   مرسى | MARSA — contact.html behaviour
   Contact form validation + localStorage ("marsa_messages"), branch/map
   highlighting, open-now badge. Plain IIFE, works on file://.
   ===================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'marsa_messages';
  var M = window.Marsa || {};
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
  var toast = M.toast || function () {};

  var CHANNELS = { phone: 'مكالمة هاتفية', whatsapp: 'واتساب', email: 'البريد الإلكتروني' };

  /* ---------- helpers ---------- */
  function toWesternDigits(str) {
    return String(str || '')
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
  }
  function normalizePhone(v) {
    var p = toWesternDigits(v).replace(/[\s\-().]/g, '');
    // Saudi numbers: +966 / 00966 / 966 prefix -> local 0 prefix; 5XXXXXXXX -> 05XXXXXXXX
    if (p.indexOf('+966') === 0) p = '0' + p.slice(4);
    else if (p.indexOf('00966') === 0) p = '0' + p.slice(5);
    else if (p.indexOf('966') === 0 && (p.length === 12 || p.length === 11)) p = '0' + p.slice(3);
    if (/^5\d{8}$/.test(p)) p = '0' + p;
    return p;
  }
  function genRef() {
    if (M.genRef) return M.genRef('MRS');
    return 'MRS-' + new Date().getFullYear() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  }
  function save(entry) {
    if (M.saveLocal) return M.saveLocal(STORAGE_KEY, entry);
    try {
      var list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(list)) list = [];
      list.push(Object.assign({ savedAt: new Date().toISOString() }, entry));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      return true;
    } catch (e) { return false; }
  }

  /* ---------- contact form ---------- */
  function initForm() {
    var form = $('#contact-form');
    if (!form) return;
    var wrap = $('#contact-form-wrap');
    var success = $('#contact-success');
    var msg = $('#cf-message');
    var counter = $('#cf-message-count');
    var submitBtn = $('#cf-submit');
    var max = parseInt(msg.getAttribute('maxlength') || '1000', 10);

    var rules = {
      name: function (v) { return v.trim().length >= 3; },
      phone: function (v) { return /^(05\d{8}|01[1-7]\d{7})$/.test(normalizePhone(v)); }, // Saudi mobile 05XXXXXXXX or landline 01X XXXXXXX
      email: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()); },
      subject: function (v) { return v !== ''; },
      message: function (v) { return v.trim().length >= 15; },
      consent: function (v, el) { return el.checked; }
    };

    function field(name) { return form.elements[name]; }
    function validate(name) {
      var el = field(name);
      if (!el) return true;
      var ok = rules[name](el.value || '', el);
      var group = el.closest('.form-group');
      if (group) {
        group.classList.toggle('has-error', !ok);
        group.classList.toggle('has-success', ok && el.type !== 'checkbox' && el.value.trim() !== '');
      }
      if (ok) el.removeAttribute('aria-invalid'); else el.setAttribute('aria-invalid', 'true');
      return ok;
    }

    Object.keys(rules).forEach(function (name) {
      var el = field(name);
      if (!el) return;
      var evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'blur';
      el.addEventListener(evt, function () { validate(name); });
      el.addEventListener('input', function () {
        var g = el.closest('.form-group');
        if (g && g.classList.contains('has-error')) validate(name);
      });
    });

    function updateCount() {
      var n = msg.value.length;
      counter.textContent = n + ' / ' + max;
      counter.classList.toggle('is-near', n > max * 0.9);
    }
    msg.addEventListener('input', updateCount);
    updateCount();

    // Pre-select subject from ?subject=quote
    try {
      var sp = new URLSearchParams(window.location.search).get('subject');
      if (sp && field('subject').querySelector('option[value="' + sp.replace(/[^a-z]/gi, '') + '"]')) field('subject').value = sp;
    } catch (e) { /* ignore */ }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var firstBad = null;
      Object.keys(rules).forEach(function (name) {
        if (!validate(name) && !firstBad) firstBad = field(name);
      });
      if (firstBad) {
        firstBad.focus();
        toast('من فضلك راجع الحقول المظللة باللون الأحمر', 'warning');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.setAttribute('aria-busy', 'true');
      var original = submitBtn.innerHTML;
      submitBtn.innerHTML = '<svg class="icon spin" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg> جارٍ الحفظ…';

      var subjectEl = field('subject');
      var preferred = (form.querySelector('input[name="preferred"]:checked') || {}).value || 'phone';
      var ref = genRef();
      var entry = {
        ref: ref,
        name: field('name').value.trim(),
        company: field('company').value.trim(),
        phone: normalizePhone(field('phone').value),
        email: field('email').value.trim(),
        subject: subjectEl.value,
        subjectLabel: subjectEl.options[subjectEl.selectedIndex].text,
        reference: field('reference').value.trim(),
        message: msg.value.trim(),
        preferred: preferred,
        status: 'new'
      };

      setTimeout(function () {
        var ok = save(entry);
        submitBtn.disabled = false;
        submitBtn.removeAttribute('aria-busy');
        submitBtn.innerHTML = original;
        if (!ok) {
          toast('تعذّر حفظ الرسالة على هذا المتصفح. حاول مرة أخرى أو اتصل بنا مباشرة.', 'error');
          return;
        }
        $('#success-name').textContent = entry.name.split(/\s+/)[0];
        $('#success-channel').textContent = CHANNELS[preferred] || CHANNELS.phone;
        $('#success-ref').textContent = ref;
        wrap.hidden = true;
        success.hidden = false;
        success.focus();
        var card = success.closest('.card');
        if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('نسخة عرض تجريبية: حُفظت الرسالة على جهازك فقط ولم تُرسل. الرقم المرجعي: \u2066' + ref + '\u2069', 'success');
      }, 650);
    });

    $('#new-message').addEventListener('click', function () {
      form.reset();
      $$('.form-group', form).forEach(function (g) { g.classList.remove('has-error', 'has-success'); });
      $$('[aria-invalid]', form).forEach(function (el) { el.removeAttribute('aria-invalid'); });
      updateCount();
      success.hidden = true;
      wrap.hidden = false;
      field('name').focus();
    });

    $('#copy-ref').addEventListener('click', function () {
      var text = $('#success-ref').textContent;
      function done() { toast('تم نسخ الرقم المرجعي', 'info'); }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else { fallback(); }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (err) { toast('انسخ الرقم يدويًا: ' + text, 'warning'); }
        document.body.removeChild(ta);
      }
    });
  }

  /* ---------- branches <-> map ---------- */
  var BRANCH_INFO = {
    jeddah: ['المقر الرئيسي – جدة', 'طريق الملك عبدالعزيز، حي الحمراء – جدة. يغطي ميناء جدة الإسلامي ومطار الملك عبدالعزيز الدولي بجدة.'],
    dammam: ['فرع الدمام', 'طريق الملك فهد، حي الشاطئ – الدمام. يغطي ميناء الملك عبدالعزيز بالدمام.'],
    riyadh: ['فرع الرياض', 'طريق العليا، حي العليا – الرياض. يغطي الميناء الجاف بالرياض ومطار الملك خالد الدولي.'],
    jubail: ['فرع الجبيل', 'حي الفناتير – الجبيل الصناعية. يغطي ميناء الجبيل التجاري.']
  };

  function initBranches() {
    var cards = $$('.branch-card[data-branch]');
    var pins = $$('.map-pin[data-branch]');
    if (!cards.length) return;
    var nameEl = $('#map-branch-name');
    var descEl = $('#map-branch-desc');

    function select(id, scrollToMap) {
      cards.forEach(function (c) {
        var on = c.getAttribute('data-branch') === id;
        c.classList.toggle('is-selected', on);
        var b = $('.branch-btn', c);
        if (b) b.setAttribute('aria-pressed', String(on));
      });
      pins.forEach(function (p) { p.classList.toggle('is-active', p.getAttribute('data-branch') === id); });
      var info = BRANCH_INFO[id];
      if (info && nameEl) { nameEl.textContent = info[0]; descEl.textContent = info[1]; }
      if (scrollToMap) {
        var map = $('.map-card');
        if (map) {
          var r = map.getBoundingClientRect();
          if (r.bottom < 0 || r.top > window.innerHeight) map.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }

    cards.forEach(function (c) {
      // whole card is clickable for mouse users; the inner <button> is the accessible control
      c.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        select(c.getAttribute('data-branch'), !!e.target.closest('.branch-btn'));
      });
    });
    pins.forEach(function (p) {
      p.addEventListener('click', function () { select(p.getAttribute('data-branch'), false); });
    });
    select('jeddah', false);
  }

  /* ---------- open-now badge (Sun–Thu 8:00–17:00, Riyadh time approx. via local clock) ---------- */
  function initOpenStatus() {
    var badge = $('#open-status');
    if (!badge) return;
    var now = new Date();
    var day = now.getDay(); // 0 = Sunday … 4 = Thursday
    var h = now.getHours() + now.getMinutes() / 60;
    var open = day >= 0 && day <= 4 && h >= 8 && h < 17;
    badge.classList.toggle('badge-success', open);
    badge.classList.toggle('is-closed', !open);
    $('.open-status-text', badge).textContent = open ? 'متاحون الآن' : 'خارج مواعيد العمل – اترك رسالتك';
    var dot = $('.dot', badge);
    if (dot) dot.classList.toggle('dot-pulse', open);
    badge.hidden = false;
  }

  function init() { initForm(); initBranches(); initOpenStatus(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
