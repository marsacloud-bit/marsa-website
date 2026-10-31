/* =====================================================================
   مرسى | MARSA — request.html (multi-step clearance request)
   Plain IIFE, no modules, works on file://. Depends on window.Marsa (main.js).
   Saves submissions to localStorage "marsa_requests". Reads "marsa_calc_draft"
   (written by the calculator page) to attach a duty estimate.
   ===================================================================== */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var M = window.Marsa || {};
    var qs = function (s, c) { return (c || document).querySelector(s); };
    var qsa = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
    var toast = M.toast || function () {};
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var form = qs('#request-form');
    if (!form) return;

    var wizard = qs('#request-wizard');
    var success = qs('#request-success');
    var saveError = qs('#request-save-error');
    var steps = qsa('.form-step', form);
    var stepperItems = qsa('.stepper .step');
    var btnPrev = qs('#btn-prev');
    var btnNext = qs('#btn-next');
    var btnSubmit = qs('#btn-submit');
    var TOTAL = steps.length;
    var STEP_NAMES = ['بيانات العميل', 'بيانات الشحنة', 'المستندات', 'مراجعة وتأكيد'];
    var current = 1;

    /* ---------------------------------------------------------------
       Reference data
       --------------------------------------------------------------- */
    var PORTS = {
      sea: ['ميناء جدة الإسلامي', 'ميناء الملك عبدالعزيز بالدمام', 'ميناء الجبيل التجاري', 'ميناء الملك عبدالله برابغ', 'الميناء الجاف بالرياض'],
      air: ['مطار الملك خالد الدولي بالرياض', 'مطار الملك عبدالعزيز الدولي بجدة'],
      land: ['منفذ البطحاء البري']
    };
    var BL_LABEL = {
      sea: ['بوليصة الشحن', 'B/L', 'اسحب البوليصة هنا أو اضغط للاختيار'],
      air: ['بوليصة الشحن الجوي', 'AWB', 'اسحب بوليصة الشحن الجوي هنا أو اضغط للاختيار'],
      land: ['مستند النقل البري', 'CMR', 'اسحب مستند النقل البري هنا أو اضغط للاختيار']
    };
    var DOCS = {
      invoice: 'الفاتورة التجارية',
      bl: 'بوليصة الشحن',
      packing: 'قائمة التعبئة',
      origin: 'شهادة المنشأ',
      saber: 'شهادة المطابقة (سابر)',
      other: 'مستندات أخرى'
    };
    var SERVICE_ALIASES = {
      clearance: ['clearance', 'customs', 'full', 'import', 'takhlees'],
      aci: ['aci', 'fasah', 'saber', 'declaration', 'preregistration'],
      hs: ['hs', 'hscode', 'hs-code', 'classification', 'tariff'],
      inspection: ['inspection', 'release', 'examination'],
      door: ['door', 'door-to-door', 'delivery', 'd2d', 'trucking'],
      freight: ['freight', 'shipping', 'sea', 'air', 'forwarding'],
      export: ['export', 'exports', 'origin', 'certificate'],
      consult: ['consult', 'consulting', 'consultation', 'advice']
    };
    var ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx', 'xls', 'xlsx'];
    var MAX_SIZE = 10 * 1024 * 1024;
    var MAX_FILES = 8;

    var files = { invoice: [], bl: [], packing: [], origin: [], saber: [], other: [] };
    var calc = null;          // normalised calculator data
    var calcAttached = false;

    /* ---------------------------------------------------------------
       Helpers
       --------------------------------------------------------------- */
    function el(name) { return form.elements[name]; }
    function val(name) {
      var f = el(name);
      if (!f) return '';
      if (f.length && !f.tagName) { // RadioNodeList
        var c = qsa('input[name="' + name + '"]:checked', form)[0];
        return c ? c.value : '';
      }
      if (f.type === 'checkbox') return f.checked;
      return (f.value || '').trim();
    }
    function toWestern(s) {
      return String(s || '')
        .replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 0x0660; })
        .replace(/[۰-۹]/g, function (d) { return d.charCodeAt(0) - 0x06F0; });
    }
    function digits(s) { return toWestern(s).replace(/\D/g, ''); }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function fmtNum(n, d) { return M.formatNum ? M.formatNum(n, d) : String(n); }
    function fmtSAR(n) { return M.formatSAR ? M.formatSAR(n) : fmtNum(n, 2) + ' ر.س'; }
    function fmtSize(b) {
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
      return (b / (1024 * 1024)).toFixed(1) + ' MB';
    }
    function selectText(name) {
      var s = el(name);
      if (!s || !s.options || s.selectedIndex < 0) return '';
      return s.value ? s.options[s.selectedIndex].text : '';
    }
    function radioTitle(name) {
      var c = qsa('input[name="' + name + '"]:checked', form)[0];
      if (!c) return '';
      var t = c.parentNode.querySelector('.rc-title');
      return t ? t.textContent.trim() : (c.parentNode.textContent || '').trim();
    }
    function icon(path) { return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + path + '</svg>'; }
    var ICON_FILE = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
    var ICON_X = '<path d="M6 6l12 12M18 6 6 18"/>';
    var ICON_CHECK = '<path d="M20 6 9 17l-5-5"/>';
    var ICON_CLOCK = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';

    /* ---------------------------------------------------------------
       Error display
       --------------------------------------------------------------- */
    function groupOf(node) { return node.closest('.form-group'); }
    function setError(node, msg) {
      var g = node.classList && node.classList.contains('form-group') ? node : groupOf(node);
      if (!g) return;
      var e = qs('.form-error', g);
      g.classList.add('has-error');
      if (e) { e.textContent = msg; if (!e.id) e.id = 'err-' + Math.random().toString(36).slice(2, 8); }
      qsa('input:not([type=radio]):not([type=checkbox]):not([type=file]), select, textarea', g).forEach(function (c) {
        c.setAttribute('aria-invalid', 'true');
        if (e) linkDescribedBy(c, e.id);
      });
      qsa('input[type=checkbox], input[type=file]', g).forEach(function (c) {
        c.setAttribute('aria-invalid', 'true');
        if (e) linkDescribedBy(c, e.id);
      });
    }
    function clearError(node) {
      var g = node.classList && node.classList.contains('form-group') ? node : groupOf(node);
      if (!g) return;
      g.classList.remove('has-error');
      var e = qs('.form-error', g);
      if (e) e.textContent = '';
      qsa('[aria-invalid]', g).forEach(function (c) { c.removeAttribute('aria-invalid'); });
    }
    function linkDescribedBy(c, id) {
      var cur = (c.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if (cur.indexOf(id) === -1) cur.push(id);
      c.setAttribute('aria-describedby', cur.join(' '));
    }
    // connect hints to inputs once
    qsa('.form-group', form).forEach(function (g) {
      var hint = qs('.form-hint', g);
      var ctl = qs('.form-control', g);
      if (hint && ctl) {
        if (!hint.id) hint.id = (ctl.id || 'f') + '-hint';
        linkDescribedBy(ctl, hint.id);
      }
    });

    /* ---------------------------------------------------------------
       Validation rules per step
       --------------------------------------------------------------- */
    var RULES = {
      fullName: function (v) {
        if (!v) return 'من فضلك اكتب اسمك بالكامل.';
        if (v.replace(/\s+/g, ' ').split(' ').length < 2 || v.length < 5) return 'اكتب الاسم ثنائيًا على الأقل (الاسم واسم العائلة).';
      },
      company: function (v) {
        if (!v) return 'اكتب اسم الشركة أو النشاط، أو «فرد» إذا كان الاستيراد شخصيًا.';
        if (v.length < 2) return 'اسم الشركة قصير جدًا.';
      },
      phone: function (v) {
        var d = digits(v);
        if (!d) return 'رقم الجوال مطلوب للتواصل معك.';
        if (/[^\d\s\-+()٠-٩۰-۹]/.test(v)) return 'رقم الجوال يحتوي على أرقام فقط. مثال صحيح: 0551234567';
        if (!normPhone(d)) return 'رقم الجوال غير صحيح. أدخل رقم جوال سعوديًا مثل 0551234567 أو ‎+966551234567';
      },
      email: function (v) {
        if (!v) return 'البريد الإلكتروني مطلوب لإرسال عرض السعر.';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'صيغة البريد الإلكتروني غير صحيحة. مثال: name@company.com';
      },
      taxId: function (v) {
        if (!v) return;
        if (/[^\d\-\s٠-٩۰-۹]/.test(v) || digits(v).length !== 15) return 'الرقم الضريبي يتكون من 15 رقمًا.';
      },
      crNumber: function (v) {
        var d = digits(v);
        if (!v) return isIndividual() ? undefined : 'رقم السجل التجاري مطلوب للشركات والمؤسسات (أو اكتب «فرد» في اسم الشركة).';
        if (/[^\d\-\s٠-٩۰-۹]/.test(v) || d.length !== 10) return 'رقم السجل التجاري يتكون من 10 أرقام.';
      },
      service: function (v) { if (!v) return 'اختر الخدمة المطلوبة.'; },
      country: function (v) { if (!v) return val('direction') === 'export' ? 'اختر بلد الوجهة.' : 'اختر بلد المنشأ أو الشحن.'; },
      port: function (v) { if (!v) return val('direction') === 'export' ? 'اختر ميناء أو منفذ الشحن.' : 'اختر ميناء أو منفذ الوصول.'; },
      goods: function (v) {
        if (!v) return 'اكتب وصفًا للبضاعة.';
        if (v.length < 10) return 'الوصف قصير جدًا — اذكر نوع البضاعة وحالتها وكميتها.';
      },
      hsCode: function (v) {
        if (!v) return;
        var d = digits(v);
        if (/[^\d.\s٠-٩]/.test(v) || d.length < 4 || d.length > 12) return 'البند الجمركي يتكون من 4 إلى 12 رقمًا (مسموح بالنقاط). مثال: 8708.30';
      },
      declarationNo: function (v) {
        if (!v || val('direction') === 'export') return;
        var d = digits(v);
        if (/[^\d\s\-٠-٩۰-۹]/.test(v) || d.length < 6 || d.length > 20) return 'رقم البيان الجمركي يتكون من أرقام فقط (من 6 إلى 20 رقمًا).';
      },
      value: function (v) {
        var n = parseFloat(toWestern(v));
        if (v === '') return 'أدخل قيمة البضاعة كما في الفاتورة.';
        if (!(n > 0)) return 'يجب أن تكون قيمة البضاعة أكبر من صفر.';
        if (n > 1e10) return 'القيمة كبيرة بشكل غير منطقي، راجعها من فضلك.';
      },
      weight: function (v) {
        var n = parseFloat(toWestern(v));
        if (v === '') return 'أدخل الوزن الإجمالي بالكيلوجرام.';
        if (!(n > 0)) return 'يجب أن يكون الوزن أكبر من صفر.';
      },
      count: function (v) {
        var n = Number(toWestern(v));
        var lbl = countLabel();
        if (v === '') return 'أدخل ' + lbl + '.';
        if (!(n >= 1) || Math.floor(n) !== n) return 'يجب أن يكون ' + lbl + ' رقمًا صحيحًا 1 أو أكثر.';
        if (n > 500) return 'الحد الأقصى 500 — للشحنات الأكبر تواصل معنا مباشرة.';
      },
      eta: function (v) {
        if (!v) return;
        var d = new Date(v);
        if (isNaN(d.getTime())) return 'تاريخ غير صحيح.';
      },
      blNumber: function (v) {
        if (!v) return;
        if (!/^[A-Za-z0-9][A-Za-z0-9\s\-\/.]{2,39}$/.test(toWestern(v))) return 'رقم البوليصة يتكون من أحرف إنجليزية وأرقام (مسموح بالشرطة والمسافة)، من 3 إلى 40 خانة.';
      },
      shippingLine: function (v) {
        if (v && v.length < 2) return 'اسم الخط الملاحي قصير جدًا.';
      },
      containerNumbers: function (v) {
        if (!v || val('mode') !== 'sea') return;
        if (/[^A-Za-z0-9\s,،;\-\/\n]/.test(toWestern(v))) return 'أرقام الحاويات تتكون من أحرف إنجليزية وأرقام فقط، ويُفصل بينها بفاصلة أو سطر جديد.';
        if (parseContainers(v).length > 200) return 'الحد الأقصى 200 رقم حاوية في الطلب الواحد.';
      }
    };
    /* Container numbers: split on comma / Arabic comma / semicolon / newline;
       "MSCU 123456-5" → "MSCU1234565". ISO 6346 shape (4 letters + 7 digits)
       is only a soft warning — never blocks the form. */
    function parseContainers(v) {
      var seen = {};
      return toWestern(v || '').split(/[,،;\n]+/).reduce(function (acc, x) {
        x = x.replace(/[\s\-\/]/g, '').toUpperCase();
        // several numbers typed with spaces only: "MSCU1234565 TGHU7304186"
        if (/^([A-Z]{4}\d{7}){2,}$/.test(x)) return acc.concat(x.match(/[A-Z]{4}\d{7}/g));
        acc.push(x);
        return acc;
      }, []).filter(function (x) {
        if (!x || seen[x]) return false;
        seen[x] = true;
        return true;
      });
    }
    function isIsoContainer(c) { return /^[A-Z]{4}\d{7}$/.test(c); }
    function softCheckContainers() {
      var box = qs('#f-container-numbers-warn');
      if (!box) return;
      var bad = val('mode') === 'sea' ? parseContainers(val('containerNumbers')).filter(function (c) { return !isIsoContainer(c); }) : [];
      box.hidden = !bad.length;
      box.textContent = bad.length ? 'تنبيه: ' + bad.slice(0, 5).join('، ') + (bad.length > 5 ? '…' : '') + ' — لا يطابق الشكل المعتاد لرقم الحاوية (4 أحرف ثم 7 أرقام). تأكد منه؛ يمكنك المتابعة.' : '';
    }
    function isIndividual() {
      if (val('clientType') === 'individual') return true;
      var c = val('company').replace(/\s+/g, '');
      return c === 'فرد' || c === 'شخصي' || c === 'فردي';
    }
    // Saudi mobile: 05XXXXXXXX, 9665XXXXXXXX, 009665XXXXXXXX, 5XXXXXXXX -> normalised 05XXXXXXXX (or '' if invalid)
    function normPhone(d) {
      d = digits(d);
      if (d.indexOf('00966') === 0) d = '0' + d.slice(5);
      else if (d.indexOf('966') === 0) d = '0' + d.slice(3);
      else if (/^5\d{8}$/.test(d)) d = '0' + d;
      return /^05\d{8}$/.test(d) ? d : '';
    }
    // soft check: Saudi VAT numbers start and end with 3 (warning only, never blocks)
    var vatWarned = '';
    function softCheckVat() {
      var d = digits(val('taxId'));
      if (d.length === 15 && (d.charAt(0) !== '3' || d.charAt(14) !== '3') && vatWarned !== d) {
        vatWarned = d;
        toast('تنبيه: الرقم الضريبي في السعودية يبدأ عادةً وينتهي بالرقم 3 — تأكد منه من شهادة التسجيل.', 'warning');
      }
    }
    var STEP_FIELDS = {
      1: ['fullName', 'company', 'phone', 'email', 'taxId', 'crNumber'],
      2: ['service', 'country', 'port', 'goods', 'hsCode', 'declarationNo', 'value', 'weight', 'containerNumbers', 'count', 'eta', 'blNumber', 'shippingLine'],
      3: [],
      4: []
    };

    function checkField(name) {
      var f = el(name);
      if (!f || !RULES[name]) return true;
      var msg = RULES[name](val(name));
      if (msg) { setError(f, msg); return false; }
      clearError(f);
      return true;
    }

    function validateDocs() {
      var ok = true;
      var later = val('docsLater');
      qsa('[data-doc]', form).forEach(function (g) {
        var key = g.getAttribute('data-doc');
        if (g.getAttribute('data-required') === 'true' && !later && !files[key].length) {
          setError(g, 'ارفع ' + docLabel(key) + '، أو اختر «سأرسلها لاحقًا» في الأسفل.');
          ok = false;
        } else clearError(g);
      });
      return ok;
    }

    function validateStep(n) {
      var firstBad = null;
      (STEP_FIELDS[n] || []).forEach(function (name) {
        if (!checkField(name) && !firstBad) firstBad = el(name);
      });
      if (n === 3 && !validateDocs()) firstBad = firstBad || qs('[data-doc].has-error input[type=file]', form);
      if (n === 4) {
        if (!val('terms')) { setError(el('terms'), 'يجب الموافقة على الإقرار والشروط قبل إرسال الطلب.'); firstBad = el('terms'); }
        else clearError(el('terms'));
      }
      if (firstBad) {
        if (firstBad.focus) firstBad.focus({ preventScroll: true });
        var g = groupOf(firstBad) || firstBad;
        if (g.scrollIntoView) g.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        toast('توجد بيانات ناقصة أو غير صحيحة — راجع الحقول المعلّمة باللون الأحمر.', 'error');
        return false;
      }
      if (n === 1) softCheckVat();
      if (n === 2) softCheckContainers();
      return true;
    }

    // live re-validation once a field has shown an error
    form.addEventListener('input', function (e) {
      var t = e.target;
      if (t.name && RULES[t.name] && groupOf(t) && groupOf(t).classList.contains('has-error')) checkField(t.name);
      if (t.name === 'goods') qs('#goods-count').textContent = t.value.length;
    });
    form.addEventListener('change', function (e) {
      var t = e.target;
      if (t.name && RULES[t.name] && groupOf(t) && groupOf(t).classList.contains('has-error')) checkField(t.name);
      if (t.name === 'terms' && t.checked) clearError(t);
    });
    form.addEventListener('blur', function (e) {
      var t = e.target;
      if (t.name && RULES[t.name] && t.value && t.type !== 'radio') checkField(t.name);
      if (t.name === 'taxId' && t.value && groupOf(t) && !groupOf(t).classList.contains('has-error')) softCheckVat();
      if (t.name === 'company' && groupOf(el('crNumber')).classList.contains('has-error')) checkField('crNumber');
      if (t.name === 'containerNumbers') softCheckContainers();
    }, true);
    qsa('input[name="clientType"]', form).forEach(function (r) {
      r.addEventListener('change', function () {
        if (groupOf(el('crNumber')).classList.contains('has-error')) checkField('crNumber');
      });
    });

    /* ---------------------------------------------------------------
       Dynamic shipment fields (mode / direction / container)
       --------------------------------------------------------------- */
    var portSel = el('port');
    function fillPorts() {
      var mode = val('mode') || 'sea';
      var prev = portSel.value;
      var exp = val('direction') === 'export';
      portSel.innerHTML = '<option value="">' + (exp ? 'اختر ميناء الشحن' : 'اختر ميناء الوصول') + '</option>' +
        PORTS[mode].map(function (p) { return '<option>' + esc(p) + '</option>'; }).join('');
      if (PORTS[mode].indexOf(prev) !== -1) portSel.value = prev;
      else if (PORTS[mode].length === 1) portSel.value = PORTS[mode][0];
    }
    function countLabel() {
      var mode = val('mode');
      if (mode === 'sea' && val('containerType') !== 'LCL') return 'عدد الحاويات';
      if (mode === 'land') return 'عدد الشاحنات';
      return 'عدد الطرود';
    }
    function syncShipmentUI() {
      var mode = val('mode') || 'sea';
      var exp = val('direction') === 'export';
      qs('#sea-fields').hidden = mode !== 'sea';
      var lbl = countLabel();
      qs('#f-count-label').innerHTML = esc(lbl) + ' <span class="req" aria-hidden="true">*</span>';
      qs('#f-count-hint').textContent =
        lbl === 'عدد الحاويات' ? 'عدد الحاويات بنفس النوع في الشحنة.' :
        lbl === 'عدد الشاحنات' ? 'عدد الشاحنات أو المقطورات المحمّلة بالشحنة.' :
        'إجمالي عدد الطرود أو الكراتين كما في قائمة التعبئة.';
      qs('#f-country-label').innerHTML = (exp ? 'بلد الوجهة' : 'بلد المنشأ / الشحن') + ' <span class="req" aria-hidden="true">*</span>';
      qs('#f-port-label').innerHTML = (exp ? 'ميناء / منفذ الشحن' : 'ميناء / منفذ الوصول') + ' <span class="req" aria-hidden="true">*</span>';
      qs('#f-port-hint').textContent = mode === 'air' ? 'الشحن الجوي عبر مطار الملك خالد الدولي بالرياض أو مطار الملك عبدالعزيز الدولي بجدة.' : mode === 'land' ? 'الشحن البري عبر منفذ البطحاء البري.' : 'الموانئ المتاحة تتغير حسب وسيلة الشحن.';
      // customs declaration number applies to imports only
      var declGroup = groupOf(el('declarationNo'));
      declGroup.hidden = exp;
      qs('#aci-help-wrap').hidden = exp;
      if (exp) clearError(el('declarationNo'));
      el('declarationNo').disabled = !exp && el('needAci').checked;
      if (mode !== 'sea') clearError(el('containerNumbers'));
      softCheckContainers();
      qs('#f-shipping-line-label').innerHTML = (mode === 'air' ? 'شركة الطيران' : mode === 'land' ? 'شركة النقل' : 'الخط الملاحي') + ' <span class="opt">(اختياري)</span>';
      // B/L label by mode
      var bl = BL_LABEL[mode];
      qs('#bl-label-text').textContent = bl[0];
      qs('#bl-label-en').textContent = bl[1];
      var blTitle = qs('[data-doc="bl"] .dropzone-title');
      if (blTitle) blTitle.textContent = bl[2];
      DOCS.bl = bl[0] + ' ' + bl[1];
      fillPorts();
    }
    qsa('input[name="mode"], input[name="direction"], input[name="containerType"]', form).forEach(function (r) {
      r.addEventListener('change', function () {
        if (r.name === 'direction' && r.value === 'export' && !el('service').value) el('service').value = 'export';
        syncShipmentUI();
      });
    });
    el('needAci').addEventListener('change', function () {
      var decl = el('declarationNo');
      if (this.checked) { decl.value = ''; clearError(decl); }
      decl.disabled = this.checked;
    });
    // normalise Arabic-Indic digits in code-like inputs
    ['phone', 'taxId', 'hsCode', 'declarationNo', 'crNumber', 'blNumber', 'containerNumbers'].forEach(function (n) {
      var f = el(n);
      f.addEventListener('input', function () {
        var w = toWestern(f.value);
        if (w !== f.value) f.value = w;
      });
    });

    /* ---------------------------------------------------------------
       Documents: drag & drop (kept in memory; only names/sizes saved)
       --------------------------------------------------------------- */
    function docLabel(key) { return DOCS[key] || key; }
    function renderFiles(key) {
      var g = qs('[data-doc="' + key + '"]', form);
      var list = qs('.file-list', g);
      g.classList.toggle('has-files', files[key].length > 0);
      list.innerHTML = files[key].map(function (f, i) {
        return '<li class="file-item">' + icon(ICON_FILE) +
          '<span class="file-name" title="' + esc(f.name) + '" dir="auto">' + esc(f.name) + '</span>' +
          '<span class="file-size num">' + fmtSize(f.size) + '</span>' +
          '<button type="button" class="file-remove" data-key="' + key + '" data-index="' + i + '" aria-label="حذف الملف ' + esc(f.name) + '">' + icon(ICON_X) + '</button></li>';
      }).join('');
    }
    function addFiles(key, fileList) {
      var added = 0, rejected = [];
      Array.prototype.forEach.call(fileList || [], function (f) {
        var ext = (f.name.split('.').pop() || '').toLowerCase();
        if (ALLOWED_EXT.indexOf(ext) === -1) { rejected.push(f.name + ' (صيغة غير مدعومة)'); return; }
        if (f.size > MAX_SIZE) { rejected.push(f.name + ' (أكبر من 10 ميجابايت)'); return; }
        if (files[key].length >= MAX_FILES) { rejected.push(f.name + ' (تجاوز الحد الأقصى ' + MAX_FILES + ' ملفات)'); return; }
        var dup = files[key].some(function (x) { return x.name === f.name && x.size === f.size; });
        if (dup) return;
        files[key].push({ name: f.name, size: f.size, type: f.type || ext });
        added++;
      });
      renderFiles(key);
      if (added) {
        clearError(qs('[data-doc="' + key + '"]', form));
        toast('تمت إضافة ' + added + (added === 1 ? ' ملف' : ' ملفات') + ' إلى ' + docLabel(key), 'success');
      }
      if (rejected.length) toast('لم يتم قبول: ' + rejected.join('، '), 'warning');
    }
    qsa('[data-doc]', form).forEach(function (g) {
      var key = g.getAttribute('data-doc');
      var zone = qs('.dropzone', g);
      var input = qs('input[type=file]', g);
      input.addEventListener('change', function () { addFiles(key, input.files); input.value = ''; });
      ['dragenter', 'dragover'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('is-dragover'); });
      });
      ['dragleave', 'dragend'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) {
          if (ev === 'dragleave' && zone.contains(e.relatedTarget)) return;
          zone.classList.remove('is-dragover');
        });
      });
      zone.addEventListener('drop', function (e) {
        e.preventDefault();
        zone.classList.remove('is-dragover');
        if (e.dataTransfer) addFiles(key, e.dataTransfer.files);
      });
      g.addEventListener('click', function (e) {
        var btn = e.target.closest('.file-remove');
        if (!btn) return;
        var i = parseInt(btn.getAttribute('data-index'), 10);
        var removed = files[key].splice(i, 1)[0];
        renderFiles(key);
        var next = qs('.file-remove', g) || input;
        next.focus();
        if (removed) toast('تم حذف ' + removed.name, 'info');
      });
    });
    // stop the browser from opening files dropped outside a zone
    ['dragover', 'drop'].forEach(function (ev) {
      window.addEventListener(ev, function (e) { if (!e.target.closest || !e.target.closest('.dropzone')) e.preventDefault(); });
    });
    el('docsLater').addEventListener('change', function () { if (this.checked) qsa('[data-doc]', form).forEach(clearError); });

    /* ---------------------------------------------------------------
       Calculator hand-off (localStorage "marsa_calc_draft", legacy "marsa_calc")
       --------------------------------------------------------------- */
    function pick(o, keys) {
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
      }
      return null;
    }
    function readCalc() {
      var raw = null;
      // only attach a calculator estimate when the user arrived via "send to request"
      var fromCalc = false;
      try { fromCalc = new URLSearchParams(window.location.search).get('from') === 'calculator'; } catch (e) { fromCalc = false; }
      if (!fromCalc) return null;
      try { raw = JSON.parse(localStorage.getItem('marsa_calc_draft') || localStorage.getItem('marsa_calc') || 'null'); } catch (e) { raw = null; }
      if (Array.isArray(raw)) raw = raw[raw.length - 1];
      if (!raw || typeof raw !== 'object') return null;
      var src = raw.inputs && typeof raw.inputs === 'object' ? Object.assign({}, raw, raw.inputs) : raw;
      var res = raw.results || raw.result || raw.breakdown || {};
      var num = function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; };
      var both = function (keys) { var x = pick(res, keys); return x != null ? x : pick(src, keys); };
      var c = {
        hsCode: pick(src, ['hsCode', 'hs', 'hs_code']),
        category: pick(src, ['categoryLabel', 'categoryName', 'category', 'goods', 'product', 'description']),
        value: num(pick(src, ['value', 'invoice', 'invoiceValue', 'goodsValue', 'fob'])),
        currency: pick(src, ['currency', 'cur']),
        mode: (function (m) { return (m === 'fcl' || m === 'lcl') ? 'sea' : m; })(pick(src, ['mode', 'shippingMode'])),
        cif: num(both(['cifSAR', 'cif', 'customsValue'])),
        duty: num(both(['duty', 'dutySAR', 'customsDuty'])),
        vat: num(both(['vat', 'vatSAR'])),
        feesNet: num(both(['feesNet'])),
        feesVat: num(both(['feesVat'])),
        total: num(both(['total', 'totalSAR', 'grandTotal'])),
        savedAt: pick(raw, ['savedAt', 'date', 'createdAt'])
      };
      if (c.total == null && c.duty == null && c.value == null) return null;
      return c;
    }
    function applyCalc() {
      calc = readCalc();
      if (!calc) return;
      calcAttached = true;
      var filled = [];
      if (calc.value != null && !el('value').value) { el('value').value = calc.value; filled.push('القيمة'); }
      if (calc.currency) {
        var cur = String(calc.currency).toUpperCase();
        if (qsa('option', el('currency')).some(function (o) { return o.value === cur; })) { el('currency').value = cur; }
      }
      if (calc.hsCode && !el('hsCode').value) { el('hsCode').value = toWestern(calc.hsCode); filled.push('البند الجمركي'); }
      if (calc.mode && PORTS[calc.mode]) {
        var r = qs('input[name="mode"][value="' + calc.mode + '"]', form);
        if (r) { r.checked = true; filled.push('وسيلة الشحن'); }
      }
      if (calc.category && !el('goods').value && typeof calc.category === 'string') {
        el('goods').value = calc.category;
        qs('#goods-count').textContent = el('goods').value.length;
        filled.push('وصف البضاعة');
      }
      // sidebar card
      var rows = [];
      if (calc.value != null) rows.push(['قيمة البضاعة', fmtNum(calc.value, 2) + (calc.currency ? ' ' + esc(String(calc.currency).toUpperCase()) : '')]);
      if (calc.hsCode) rows.push(['البند الجمركي', esc(calc.hsCode)]);
      if (calc.cif != null) rows.push(['القيمة الجمركية (CIF)', fmtSAR(calc.cif)]);
      if (calc.duty != null) rows.push(['الرسوم الجمركية', fmtSAR(calc.duty)]);
      if (calc.vat != null) rows.push(['ضريبة القيمة المضافة على الاستيراد 15%', fmtSAR(calc.vat)]);
      if (calc.feesNet != null) rows.push(['الأتعاب والخدمات (توضيحية)', fmtSAR(calc.feesNet)]);
      if (calc.feesVat != null) rows.push(['ضريبة القيمة المضافة على الأتعاب 15%', fmtSAR(calc.feesVat)]);
      if (calc.total != null) rows.push(['الإجمالي التقديري (توضيحي)', fmtSAR(calc.total), true]);
      qs('#calc-kv').innerHTML = rows.map(function (r) {
        return '<li><span class="k">' + r[0] + '</span><span class="v num' + (r[2] ? ' total' : '') + '">' + r[1] + '</span></li>';
      }).join('');
      qs('#calc-card').hidden = false;
      if (filled.length) {
        qs('#calc-import-text').textContent = 'تمت تعبئة: ' + filled.join('، ') + '. راجع الحقول وعدّلها عند الحاجة.';
        qs('#calc-import-note').hidden = false;
      }
    }
    qs('#btn-calc-detach').addEventListener('click', function () {
      calcAttached = false;
      qs('#calc-card').hidden = true;
      qs('#calc-import-note').hidden = true;
      toast('لن يتم إرفاق تقدير الحاسبة مع الطلب.', 'info');
    });

    /* ---------------------------------------------------------------
       ?service= preselect
       --------------------------------------------------------------- */
    function applyServiceParam() {
      var raw = '';
      try { raw = new URLSearchParams(window.location.search).get('service') || ''; } catch (e) { raw = ''; }
      raw = raw.trim().toLowerCase();
      if (!raw) return;
      var sel = el('service');
      var match = null;
      qsa('option', sel).forEach(function (o) { if (o.value && o.value === raw) match = o.value; });
      if (!match) {
        Object.keys(SERVICE_ALIASES).some(function (k) {
          if (SERVICE_ALIASES[k].indexOf(raw) !== -1) { match = k; return true; }
          return false;
        });
      }
      if (!match) {
        qsa('option', sel).forEach(function (o) { if (!match && o.value && o.text.indexOf(raw) !== -1) match = o.value; });
      }
      if (!match) return;
      sel.value = match;
      if (match === 'export' || raw === 'export') {
        var exp = qs('input[name="direction"][value="export"]', form);
        if (exp) exp.checked = true;
      }
      if (match === 'aci') el('needAci').checked = true;
      if (raw === 'air' || raw === 'sea' || raw === 'land') {
        var m = qs('input[name="mode"][value="' + raw + '"]', form);
        if (m) m.checked = true;
      }
    }

    /* ---------------------------------------------------------------
       Review (step 4)
       --------------------------------------------------------------- */
    function kvRows(rows) {
      return '<ul class="kv">' + rows.filter(function (r) { return r[1] !== '' && r[1] != null; }).map(function (r) {
        return '<li><span class="k">' + r[0] + '</span><span class="v' + (r[2] ? ' num' : '') + '"' + (r[2] ? ' dir="ltr"' : '') + '>' + esc(r[1]) + '</span></li>';
      }).join('') + '</ul>';
    }
    function block(title, step, inner, wide) {
      return '<div class="review-block' + (wide ? ' is-wide' : '') + '"><div class="review-block-head"><h3>' + title + '</h3>' +
        '<button type="button" class="review-edit" data-goto="' + step + '">تعديل</button></div>' + inner + '</div>';
    }
    function buildReview() {
      var mode = val('mode');
      var exp = val('direction') === 'export';
      var client = kvRows([
        ['نوع العميل', ({ individual: 'فرد', business: 'منشأة' })[val('clientType')] || ''],
        ['الاسم', val('fullName')],
        ['الشركة', val('company')],
        ['الجوال', val('phone'), true],
        ['البريد', val('email'), true],
        ['الرقم الضريبي', val('taxId'), true],
        ['السجل التجاري', val('crNumber'), true],
        ['التواصل المفضّل', ({ whatsapp: 'واتساب', phone: 'مكالمة هاتفية', email: 'البريد الإلكتروني' })[val('contactPref')] || '']
      ]);
      var ship = kvRows([
        ['نوع العملية', radioTitle('direction')],
        ['الخدمة', selectText('service')],
        ['وسيلة الشحن', radioTitle('mode')],
        [exp ? 'بلد الوجهة' : 'بلد المنشأ', val('country')],
        [exp ? 'منفذ الشحن' : 'منفذ الوصول', val('port')],
        ['القيمة', val('value') ? fmtNum(parseFloat(toWestern(val('value'))), 2) + ' ' + val('currency') : '', true],
        ['الوزن', val('weight') ? fmtNum(parseFloat(toWestern(val('weight'))), 1) + ' كجم' : ''],
        ['الحاوية', mode === 'sea' ? radioTitle('containerType') : ''],
        ['أرقام الحاويات', mode === 'sea' ? parseContainers(val('containerNumbers')).join('، ') : '', true],
        [countLabel(), val('count'), true],
        ['HS Code', val('hsCode') || 'يحدده فريق مرسى', !!val('hsCode')],
        ['رقم البيان الجمركي', exp ? '' : (val('declarationNo') || (val('needAci') ? 'مرسى ستقدّم البيان المسبق عبر فسح' : 'غير متوفر حاليًا')), !!val('declarationNo')],
        ['رقم البوليصة', val('blNumber'), true],
        [mode === 'air' ? 'شركة الطيران' : mode === 'land' ? 'شركة النقل' : 'الخط الملاحي', val('shippingLine')],
        ['الوصول المتوقع', val('eta'), true]
      ]);
      var goods = '<p class="text-sm mb-0" dir="auto">' + esc(val('goods')) + '</p>';
      var docs = '<ul class="review-docs">' + Object.keys(DOCS).map(function (k) {
        var n = files[k].length;
        var missing = !n;
        if ((k === 'other' || k === 'saber') && missing) return '';
        return '<li class="' + (missing ? 'is-missing' : '') + '">' + icon(missing ? ICON_CLOCK : ICON_CHECK) +
          '<span>' + esc(docLabel(k)) + ': ' + (missing ? (val('docsLater') ? 'سيُرسل لاحقًا' : 'لم يُرفق') : n + (n === 1 ? ' ملف' : ' ملفات')) + '</span></li>';
      }).join('') + '</ul>';
      var html = block('بيانات العميل', 1, client) + block('بيانات الشحنة', 2, ship) +
        block('وصف البضاعة', 2, goods) + block('المستندات', 3, docs);
      if (calcAttached && calc && calc.total != null) {
        html += '<div class="review-block is-wide"><div class="review-block-head"><h3>تقدير الرسوم المرفق</h3>' +
          '<a class="review-edit" href="calculator.html">إعادة الحساب</a></div>' +
          '<ul class="kv"><li><span class="k">الإجمالي التقديري من الحاسبة</span><span class="v total num">' + fmtSAR(calc.total) + '</span></li></ul>' +
          '<p class="text-xs text-muted mb-0 mt-1">تقدير استرشادي؛ الرسوم النهائية تحددها هيئة الزكاة والضريبة والجمارك وقت الفسح.</p></div>';
      }
      qs('#review').innerHTML = html;
    }
    qs('#review').addEventListener('click', function (e) {
      var b = e.target.closest('[data-goto]');
      if (b) goTo(parseInt(b.getAttribute('data-goto'), 10));
    });

    /* ---------------------------------------------------------------
       Navigation
       --------------------------------------------------------------- */
    function scrollToCard() {
      var card = qs('#request-card');
      var top = card.getBoundingClientRect().top + window.pageYOffset - 100;
      if (window.pageYOffset > top) window.scrollTo({ top: top, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    function goTo(n) {
      n = Math.max(1, Math.min(TOTAL, n));
      current = n;
      if (n === 4) buildReview();
      steps.forEach(function (s, i) { s.classList.toggle('is-active', i === n - 1); });
      stepperItems.forEach(function (li, i) {
        li.classList.toggle('is-active', i === n - 1);
        li.classList.toggle('is-done', i < n - 1);
        if (i === n - 1) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      });
      var pct = Math.round(n / TOTAL * 100);
      qs('#progress-bar').style.width = pct + '%';
      qs('#progress-pct').textContent = pct + '%';
      qs('#progress-label').textContent = 'الخطوة ' + n + ' من ' + TOTAL + ': ' + STEP_NAMES[n - 1];
      var bar = qs('.req-progress .progress');
      bar.setAttribute('aria-valuenow', String(pct));
      btnPrev.hidden = n === 1;
      btnNext.hidden = n === TOTAL;
      btnSubmit.hidden = n !== TOTAL;
      scrollToCard();
      var h = qs('.form-step.is-active h2');
      if (h) setTimeout(function () { h.focus({ preventScroll: true }); }, 60);
    }
    btnNext.addEventListener('click', function () {
      if (validateStep(current)) goTo(current + 1);
    });
    btnPrev.addEventListener('click', function () { goTo(current - 1); });
    // Enter inside a text input moves to next step instead of submitting early
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && current < TOTAL) {
        e.preventDefault();
        btnNext.click();
      }
    });

    /* ---------------------------------------------------------------
       Submit
       --------------------------------------------------------------- */
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (current !== TOTAL) { btnNext.click(); return; }
      for (var s = 1; s <= TOTAL; s++) {
        if (!validateStep(s)) { if (s !== current) goTo(s); return; }
      }
      var ref = M.genRef ? M.genRef('MRS') : 'MRS-' + new Date().getFullYear() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      var mode = val('mode');
      var exp = val('direction') === 'export';
      var containers = mode === 'sea' ? parseContainers(val('containerNumbers')) : [];
      var record = {
        ref: ref,
        createdAt: new Date().toISOString(),
        status: 'received',
        statusLabel: 'محفوظ محليًا (نسخة عرض تجريبية)',
        demo: true, savedLocallyOnly: true,
        client: {
          clientType: val('clientType'), clientTypeLabel: ({ individual: 'فرد', business: 'منشأة' })[val('clientType')] || '',
          fullName: val('fullName'), company: val('company'), phone: normPhone(val('phone')) || digits(val('phone')), email: val('email'),
          taxId: digits(val('taxId')), vatNumber: digits(val('taxId')),
          crNumber: digits(val('crNumber')), importerCard: digits(val('crNumber')), // importerCard kept for older readers
          contactPref: val('contactPref')
        },
        shipment: {
          direction: val('direction'), directionLabel: radioTitle('direction'),
          service: val('service'), serviceLabel: selectText('service'),
          mode: mode, modeLabel: radioTitle('mode'),
          country: val('country'), port: val('port'), goods: val('goods'),
          hsCode: toWestern(val('hsCode')),
          declarationNo: exp ? '' : digits(val('declarationNo')), // tracking.js reads declarationNo (older records may still carry "acid")
          needAci: !exp && !!val('needAci'),
          value: parseFloat(toWestern(val('value'))) || 0, currency: val('currency'),
          weightKg: parseFloat(toWestern(val('weight'))) || 0,
          containerType: mode === 'sea' ? val('containerType') : '',
          containerNumbers: containers,
          containerNo: containers.join(', '), // display/search string for tracking.js (reads containerNo)
          count: parseInt(toWestern(val('count')), 10) || 0, countLabel: countLabel(),
          blNumber: toWestern(val('blNumber')).replace(/\s+/g, ' ').toUpperCase(),
          shippingLine: val('shippingLine'),
          eta: val('eta')
        },
        documents: Object.keys(files).reduce(function (acc, k) {
          acc[k] = files[k].map(function (f) { return { name: f.name, size: f.size }; });
          return acc;
        }, {}),
        docsLater: !!val('docsLater'),
        notes: val('notes'),
        calc: calcAttached ? calc : null
      };
      var ok = M.saveLocal ? M.saveLocal('marsa_requests', record) : false;
      if (!ok) { showSaveError(); return; }
      if (saveError) saveError.hidden = true;
      showSuccess(record);
    });

    // saving failed: keep the wizard and the entered data, show no reference and no success screen
    function showSaveError() {
      success.hidden = true;
      wizard.hidden = false;
      if (saveError) {
        saveError.hidden = false;
        if (saveError.scrollIntoView) saveError.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        setTimeout(function () { saveError.focus({ preventScroll: true }); }, 80);
      }
      toast('تعذّر حفظ الطلب على هذا الجهاز — لم يُحفظ ولم يُرسل. فعّل التخزين المحلي ثم حاول مرة أخرى.', 'error');
    }

    function showSuccess(r) {
      wizard.hidden = true;
      success.hidden = false;
      qs('#success-ref').textContent = r.ref;
      qs('#success-track').href = 'tracking.html?id=' + encodeURIComponent(r.ref);
      var docsCount = Object.keys(r.documents).reduce(function (n, k) { return n + r.documents[k].length; }, 0);
      qs('#success-kv').innerHTML = [
        ['الخدمة', r.shipment.serviceLabel],
        ['المسار', r.shipment.country + ' ← ' + r.shipment.port],
        ['المستندات المرفقة', docsCount ? docsCount + (docsCount === 1 ? ' ملف' : ' ملفات') : 'لم تُرفق بعد'],
        ['أرقام الحاويات', r.shipment.containerNumbers.length ? r.shipment.containerNumbers.join('، ') : ''],
        ['الحالة', r.statusLabel]
      ].filter(function (x) { return x[1]; }).map(function (x) { return '<li><span class="k">' + x[0] + '</span><span class="v">' + esc(x[1]) + '</span></li>'; }).join('');
      var card = qs('#request-card');
      window.scrollTo({ top: card.getBoundingClientRect().top + window.pageYOffset - 100, behavior: reduceMotion ? 'auto' : 'smooth' });
      setTimeout(function () { success.focus({ preventScroll: true }); }, 80);
      toast('تم الحفظ محليًا على هذا الجهاز (نسخة عرض تجريبية) — لم يُرسل إلى أي جهة. الرقم المرجعي المحلي ' + r.ref, 'success');
    }

    qs('#btn-copy-ref').addEventListener('click', function () {
      var ref = qs('#success-ref').textContent;
      var done = function () { toast('تم نسخ الرقم المرجعي المحلي ' + ref, 'success'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ref).then(done, function () { fallbackCopy(ref) ? done() : toast('انسخ الرقم يدويًا: ' + ref, 'info'); });
      } else if (fallbackCopy(ref)) done();
      else toast('انسخ الرقم يدويًا: ' + ref, 'info');
    });
    function fallbackCopy(text) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }

    qs('#btn-new-request').addEventListener('click', function () {
      form.reset();
      Object.keys(files).forEach(function (k) { files[k] = []; renderFiles(k); });
      qsa('.has-error', form).forEach(clearError);
      qs('#goods-count').textContent = '0';
      el('declarationNo').disabled = false;
      softCheckContainers();
      if (saveError) saveError.hidden = true;
      success.hidden = true;
      wizard.hidden = false;
      applyServiceParam();
      qs('#calc-import-note').hidden = true;
      applyCalc();
      syncShipmentUI();
      goTo(1);
    });

    /* ---------------------------------------------------------------
       Init
       --------------------------------------------------------------- */
    applyServiceParam();
    applyCalc();
    syncShipmentUI();
    // min date for ETA = today
    try {
      var t = new Date();
      el('eta').min = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
    } catch (e) { /* ignore */ }
  });
})();
