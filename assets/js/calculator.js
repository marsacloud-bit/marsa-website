/* =====================================================================
   مرسى | MARSA — حاسبة الرسوم الجمركية (calculator.js)
   Live estimator (Saudi Arabia) — نسخة عرض تجريبية، أرقام توضيحية — ليست عرض سعر.
   Local only: results are kept in localStorage (marsa_calculations, marsa_calc_draft).

   Three groups (domain-01 / domain-02):
     A) رسوم وضرائب حكومية (تُدفع بالنيابة) = duty + import VAT
          duty = CIF × dutyRate ; import VAT = (CIF + duty) × 15%
     B) أتعاب وخدمات = Marsa clearance fee + handling + other service fees
          handling = handling per unit × containers (FCL only; otherwise × 1)
          other service fees = CIF × serviceRate
     C) ضريبة القيمة المضافة على الأتعاب = B × 15%
     total = CIF + A + B + C   (each amount counted exactly once)

   Worked example (page defaults, but 2 containers): invoice 10,000 USD, freight 1,200, insurance auto 1% = 112,
   rate 3.75, duty 5%, FCL × 2 containers, handling 1,800/container, service 0%:
     CIF = 11,312 × 3.75 = 42,420.00 ; duty = 2,121.00 ; import VAT = 44,541 × 15% = 6,681.15
     A = 8,802.15 ; Marsa fee (tier 1) = 750 ; handling = 1,800 × 2 = 3,600 ; B = 4,350.00
     C = 4,350 × 15% = 652.50 ; total = 42,420 + 8,802.15 + 4,350 + 652.50 = 56,224.65
   (Tier 2 + FCL × 1: C = (1,250 + 1,800) × 15% = 457.50 — the amount previously missing.)
   ===================================================================== */
(function () {
  'use strict';

  var form = document.getElementById('calc-form');
  if (!form) return;

  var M = window.Marsa || {};
  var fmtSAR = M.formatSAR || function (n) { return (Number(n) || 0).toFixed(2) + ' ر.س'; };
  var fmtNum = M.formatNum || function (n, d) { return (Number(n) || 0).toFixed(d || 0); };
  var toast = M.toast || function () {};
  var $ = function (id) { return document.getElementById(id); };

  var VAT_RATE = 0.15;
  var LOCAL = 'SAR';
  var DRAFT_KEY = 'marsa_calc_draft';

  /* category → default rate, optional [min,max] range.
     ILLUSTRATIVE ONLY (domain-08): not verified against the current tariff; the real rate
     depends on the HS code. Users can always pick «نسبة مخصصة» and type the rate. */
  var CATEGORIES = {
    electronics: { name: 'إلكترونيات وأجهزة كمبيوتر', rate: 5 },
    clothes:     { name: 'ملابس وأحذية ومنسوجات', rate: 12 },
    autoparts:   { name: 'قطع غيار سيارات', rate: 10 },
    raw:         { name: 'مواد خام ومستلزمات إنتاج', rate: 5 },
    machinery:   { name: 'آلات ومعدات صناعية', rate: 5, min: 0, max: 5 },
    food:        { name: 'مواد غذائية (بعضها معفى)', rate: 5, min: 0, max: 5 },
    furniture:   { name: 'أثاث ومفروشات', rate: 15 },
    cosmetics:   { name: 'مستحضرات تجميل وعناية شخصية', rate: 12 },
    custom:      { name: 'نسبة مخصصة', rate: null }
  };

  /* illustrative default handling per mode (SAR). For FCL it is per container (domain-09). */
  var MODES = {
    fcl:  { name: 'بحري – حاوية كاملة (FCL)', handling: 1800 },
    lcl:  { name: 'بحري – شحنة مجمّعة (LCL)', handling: 900 },
    air:  { name: 'شحن جوي', handling: 650 },
    land: { name: 'شحن بري', handling: 750 }
  };

  var CUR_NAMES = { USD: 'دولار', EUR: 'يورو', CNY: 'يوان', AED: 'درهم', SAR: 'ريال' };

  /* ---------- elements ---------- */
  var el = {
    category: $('category'), catRange: $('category-range'),
    rangeGroup: $('range-group'), range: $('duty-range'), rangeMin: $('range-min'), rangeMax: $('range-max'),
    duty: $('duty-rate'), invoice: $('invoice'), currency: $('currency'),
    freight: $('freight'), insurance: $('insurance'), insAuto: $('insurance-auto'),
    service: $('service-rate'),
    handling: $('handling'), handlingOn: $('handling-on'), qty: $('qty'),
    containers: $('containers'), containersGroup: $('containers-group'), handlingUnit: $('handling-unit'),
    rates: { USD: $('rate-USD'), EUR: $('rate-EUR'), CNY: $('rate-CNY'), AED: $('rate-AED') }
  };
  var handlingTouched = false;
  var last = null;

  /* ---------- parsing (accepts Arabic-Indic digits and thousands separators) ---------- */
  function parseNum(v) {
    if (v == null) return NaN;
    var s = String(v).trim()
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 1632); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 1776); })
      .replace(/٫/g, '.').replace(/[,،٬\s]/g, '');
    if (s === '') return NaN;
    return /^-?\d*\.?\d+$/.test(s) ? parseFloat(s) : NaN;
  }

  function setError(input, on) {
    var g = input.closest('.form-group');
    if (g) g.classList.toggle('has-error', !!on);
    if (on) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }

  /* read & validate a numeric field; returns number or null if invalid */
  function field(input, opts) {
    opts = opts || {};
    var raw = input.value;
    if (raw.trim() === '' && opts.emptyAs != null) { setError(input, false); return opts.emptyAs; }
    var n = parseNum(raw);
    var bad = isNaN(n) || n < (opts.min || 0) || (opts.gt0 && n <= 0) || (opts.max != null && n > opts.max) || (opts.int && n % 1 !== 0);
    setError(input, bad);
    return bad ? null : n;
  }

  function pct(n) { return fmtNum(n, n % 1 === 0 ? 0 : 2) + '%'; }

  /* ---------- Marsa clearance fee (tiered on CIF SAR) ----------
     ILLUSTRATIVE tiers only (domain-09) — not a published or binding price; excl. VAT. */
  function marsaFee(cif, mode) {
    var fee, tier;
    if (cif <= 100000) { fee = 750; tier = 1; }
    else if (cif <= 500000) { fee = 1250; tier = 2; }
    else if (cif <= 2000000) { fee = 2000; tier = 3; }
    else { fee = Math.max(2500, cif * 0.0012); tier = 4; }
    if (mode === 'air') fee *= 0.85;
    return { fee: Math.round(fee), tier: tier };
  }

  /* ---------- UI sync for category / currency / insurance / handling ---------- */
  function syncCategory(fromUser) {
    var c = CATEGORIES[el.category.value] || CATEGORIES.electronics;
    var custom = el.category.value === 'custom';
    el.duty.readOnly = !custom;
    if (custom) {
      el.catRange.textContent = 'أدخل نسبة البند من التعريفة';
      el.rangeGroup.hidden = true;
      if (fromUser) { el.duty.focus(); el.duty.select(); }
      return;
    }
    if (c.min != null) {
      el.catRange.textContent = c.min + '% – ' + c.max + '%';
      el.rangeGroup.hidden = false;
      el.range.min = c.min; el.range.max = c.max; el.range.value = c.rate;
      el.rangeMin.textContent = c.min + '%'; el.rangeMax.textContent = c.max + '%';
      el.range.setAttribute('aria-valuetext', c.rate + '%');
    } else {
      el.catRange.textContent = c.rate + '%';
      el.rangeGroup.hidden = true;
    }
    el.duty.value = c.rate;
    setError(el.duty, false);
  }

  function syncCurrency() {
    var cur = el.currency.value;
    Array.prototype.forEach.call(form.querySelectorAll('.cur-addon'), function (a) { a.textContent = cur === LOCAL ? 'ر.س' : cur; });
  }

  function syncInsurance() {
    el.insurance.readOnly = el.insAuto.checked;
  }

  function syncHandling() {
    el.handling.disabled = !el.handlingOn.checked;
    if (!el.handlingOn.checked) setError(el.handling, false);
    syncContainers();
  }

  /* container count applies only to FCL (handling is per container there) */
  function syncContainers() {
    var fcl = selectedMode() === 'fcl';
    if (el.containersGroup) el.containersGroup.hidden = !fcl;
    if (el.containers) {
      el.containers.disabled = !fcl || !el.handlingOn.checked;
      if (el.containers.disabled) setError(el.containers, false);
    }
    if (el.handlingUnit) el.handlingUnit.textContent = fcl ? 'ر.س / حاوية' : 'ر.س';
  }

  function selectedMode() {
    var r = form.querySelector('input[name="mode"]:checked');
    return r ? r.value : 'fcl';
  }

  /* ---------- core calculation ---------- */
  function compute() {
    var cur = el.currency.value;
    var ok = true;

    var rate = 1;
    var rateErr = false;
    Object.keys(el.rates).forEach(function (k) {
      var v = field(el.rates[k], { gt0: true });
      if (v === null) rateErr = true;
      if (k === cur) rate = v;
    });
    $('rates-box').classList.toggle('has-error', rateErr);
    if (rateErr) { ok = false; $('rates-box').open = true; }
    if (cur === LOCAL) rate = 1;

    var dutyRate = field(el.duty, { max: 100 });
    var invoice = field(el.invoice, { gt0: true });
    var freight = field(el.freight, { emptyAs: 0 });
    var insurance;
    if (el.insAuto.checked) {
      insurance = (invoice || 0) + (freight || 0);
      insurance = Math.round(insurance * 0.01 * 100) / 100;
      el.insurance.value = insurance;
      setError(el.insurance, false);
    } else {
      insurance = field(el.insurance, { emptyAs: 0 });
    }
    var serviceRate = field(el.service, { max: 100, emptyAs: 0 });
    var handlingOn = el.handlingOn.checked;
    var mode = selectedMode();
    var handlingUnit = handlingOn ? field(el.handling, { emptyAs: 0 }) : 0;
    var containers = 1;
    if (mode === 'fcl' && handlingOn && el.containers) containers = field(el.containers, { gt0: true, int: true, max: 999, emptyAs: 1 });
    var qty = field(el.qty, { gt0: true, int: true, emptyAs: 0 });

    [dutyRate, invoice, freight, insurance, serviceRate, handlingUnit, containers, qty, rate].forEach(function (v) { if (v === null) ok = false; });
    if (!ok) return null;

    var cifForeign = invoice + freight + insurance;
    var cif = cifForeign * rate;

    /* A) government charges paid on the client's behalf */
    var duty = cif * dutyRate / 100;
    var vatBase = cif + duty;                 /* import VAT base (other service fees are NOT included any more) */
    var vat = vatBase * VAT_RATE;             /* import VAT */
    var taxes = duty + vat;                   /* = govTotal; "service" removed (was double-counted, domain-02) */

    /* B) fees & services (handling × containers for FCL, domain-09) */
    var handling = handlingUnit * (mode === 'fcl' ? containers : 1);
    var service = cif * serviceRate / 100;    /* other service fees */
    var fees = service + handling;            /* same meaning as before: services other than Marsa fee */
    var mf = marsaFee(cif, mode);
    var feesNet = mf.fee + fees;

    /* C) VAT 15% on fees & services (domain-01) */
    var feesVat = feesNet * VAT_RATE;

    var total = cif + taxes + feesNet + feesVat;

    return {
      category: el.category.value, categoryName: (CATEGORIES[el.category.value] || {}).name,
      mode: mode, modeName: MODES[mode].name,
      currency: cur, rate: rate,
      invoice: invoice, freight: freight, insurance: insurance, insuranceAuto: el.insAuto.checked,
      /* devRate / devOn / dev kept (always 0 / false) so the saved object shape stays unchanged */
      dutyRate: dutyRate, serviceRate: serviceRate, devRate: 0, devOn: false,
      handling: handling, handlingUnit: handlingUnit, containers: mode === 'fcl' ? containers : null,
      handlingOn: handlingOn, qty: qty, vatRate: VAT_RATE * 100, localCurrency: LOCAL,
      cifForeign: cifForeign, cif: cif, duty: duty, service: service, dev: 0,
      vatBase: vatBase, vat: vat, fees: fees, marsa: mf.fee, tier: mf.tier,
      taxes: taxes, govTotal: taxes, feesNet: feesNet, feesVat: feesVat, feesGross: feesNet + feesVat,
      illustrative: true,
      total: total, unit: qty ? total / qty : 0
    };
  }

  /* ---------- render ---------- */
  function setText(id, t) { var n = $(id); if (n) n.textContent = t; }

  function render(r) {
    var card = $('calc-result');
    if (!r) {
      card.classList.add('is-invalid');
      setText('r-total', '—');
      return;
    }
    card.classList.remove('is-invalid');
    last = r;

    setText('r-total', fmtSAR(r.total));
    setText('r-taxes', fmtSAR(r.taxes));
    setText('r-svc', fmtSAR(r.feesGross));
    setText('r-ratio', r.cif ? pct(Math.round(r.taxes / r.cif * 1000) / 10) : '0%');
    $('unit-box').hidden = !r.qty;
    if (r.qty) setText('r-unit', fmtSAR(r.unit));

    setText('r-cif', fmtSAR(r.cif));
    setText('r-cif-src', r.currency === LOCAL ? '' : fmtNum(r.cifForeign, 2) + ' ' + r.currency + ' × ' + fmtNum(r.rate, 2));
    setText('r-duty', fmtSAR(r.duty));
    setText('r-duty-rate', pct(r.dutyRate));
    setText('r-vat', fmtSAR(r.vat));
    setText('r-fees', fmtSAR(r.fees));
    var feeDetail = [];
    if (!r.handlingOn) feeDetail.push('المناولة غير مضافة');
    else if (r.mode === 'fcl') feeDetail.push('المناولة ' + fmtNum(r.handlingUnit, 2) + ' × ' + fmtNum(r.containers, 0) + ' حاوية');
    if (r.serviceRate) feeDetail.push('خدمات أخرى ' + pct(r.serviceRate) + ' من CIF');
    setText('r-fees-detail', feeDetail.join(' + '));
    setText('r-marsa', fmtSAR(r.marsa));
    setText('r-tier', 'الشريحة ' + r.tier + ' (توضيحية)' + (r.mode === 'air' ? ' – خصم جوي' : ''));
    setText('r-feesvat', fmtSAR(r.feesVat));
    setText('r-gov-sum', fmtSAR(r.taxes));
    setText('r-svc-sum', fmtSAR(r.feesNet));
    setText('r-feesvat-sum', fmtSAR(r.feesVat));

    /* stacked bar + per-row bars */
    var parts = { cif: r.cif, duty: r.duty, vat: r.vat, marsa: r.marsa, fees: r.fees, feesvat: r.feesVat };
    var max = Math.max(r.cif, r.duty, r.vat, r.marsa, r.fees, r.feesVat) || 1;
    var stack = $('calc-stack');
    var labels = [];
    Object.keys(parts).forEach(function (k) {
      var share = r.total ? parts[k] / r.total * 100 : 0;
      var seg = stack.querySelector('.seg-' + k);
      if (seg) { seg.style.width = share + '%'; seg.title = Math.round(share * 10) / 10 + '%'; }
      var row = document.querySelector('#calc-breakdown li[data-key="' + k + '"] .bk-bar span');
      if (row) row.style.width = (parts[k] / max * 100) + '%';
      labels.push(Math.round(share) + '%');
    });
    stack.setAttribute('aria-label', 'توزيع التكلفة: قيمة CIF ' + labels[0] + '، الرسوم الجمركية ' + labels[1] + '، ضريبة الاستيراد ' + labels[2] + '، أتعاب التخليص ' + labels[3] + '، المناولة والخدمات الأخرى ' + labels[4] + '، ضريبة القيمة المضافة على الأتعاب ' + labels[5]);

    /* tier table highlight */
    Array.prototype.forEach.call(document.querySelectorAll('.calc-tier-table tr[data-tier]'), function (tr) {
      tr.classList.toggle('is-current', Number(tr.getAttribute('data-tier')) === r.tier);
    });

    /* step-by-step */
    var cur = r.currency === LOCAL ? 'ر.س' : r.currency;
    var steps = [
      ['الفاتورة + الشحن + التأمين', fmtNum(r.invoice, 2) + ' + ' + fmtNum(r.freight, 2) + ' + ' + fmtNum(r.insurance, 2) + ' ' + cur],
      ['قيمة CIF بالعملة', fmtNum(r.cifForeign, 2) + ' ' + cur],
      ['سعر الصرف المستخدم', r.currency === LOCAL ? '—' : '1 ' + r.currency + ' = ' + fmtNum(r.rate, 2) + ' ر.س'],
      ['قيمة CIF بالريال', fmtSAR(r.cif)],
      ['الرسوم الجمركية (' + pct(r.dutyRate) + ' × CIF)', fmtSAR(r.duty)],
      ['وعاء ضريبة الاستيراد (CIF + الرسوم الجمركية)', fmtSAR(r.vatBase)],
      ['ضريبة القيمة المضافة على الاستيراد (15%)', fmtSAR(r.vat)],
      ['أ) مجموع الرسوم والضرائب الحكومية (تُدفع بالنيابة)', fmtSAR(r.taxes)],
      ['أتعاب التخليص (الشريحة ' + r.tier + '، توضيحية)', fmtSAR(r.marsa)],
      ['رسوم خدمات الميناء والمناولة', !r.handlingOn ? 'غير مضافة' :
        (r.mode === 'fcl' ? fmtNum(r.handlingUnit, 2) + ' × ' + fmtNum(r.containers, 0) + ' حاوية = ' : '') + fmtSAR(r.handling)]
    ];
    if (r.serviceRate) steps.push(['رسوم خدمات أخرى (' + pct(r.serviceRate) + ' × CIF)', fmtSAR(r.service)]);
    steps.push(
      ['ب) مجموع الأتعاب والخدمات (قبل الضريبة)', fmtSAR(r.feesNet)],
      ['ج) ضريبة القيمة المضافة على الأتعاب (15% × ب)', fmtSAR(r.feesVat)],
      ['الإجمالي التقديري (CIF + أ + ب + ج)', fmtSAR(r.total)]
    );
    var ul = $('calc-steps');
    ul.innerHTML = '';
    steps.forEach(function (s, i) {
      var li = document.createElement('li');
      var k = document.createElement('span'); k.className = 'k'; k.textContent = s[0];
      var v = document.createElement('span'); v.className = 'v num' + (i === steps.length - 1 ? ' total' : ''); v.textContent = s[1];
      li.appendChild(k); li.appendChild(v); ul.appendChild(li);
    });

    var now = new Date();
    setText('calc-updated', pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()));
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  var raf = null;
  function update() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () { raf = null; render(compute()); });
  }

  /* ---------- events ---------- */
  form.addEventListener('input', function (e) {
    var t = e.target;
    if (t === el.range) {
      el.duty.value = el.range.value;
      el.range.setAttribute('aria-valuetext', el.range.value + '%');
    }
    if (t === el.handling) handlingTouched = true;
    update();
  });

  form.addEventListener('change', function (e) {
    var t = e.target;
    if (t === el.category) syncCategory(true);
    else if (t === el.currency) syncCurrency();
    else if (t === el.insAuto) { syncInsurance(); if (!el.insAuto.checked) { el.insurance.focus(); el.insurance.select(); } }
    else if (t === el.handlingOn) { syncHandling(); if (el.handlingOn.checked) el.handling.focus(); }
    else if (t.name === 'mode') { if (!handlingTouched) el.handling.value = MODES[t.value].handling; syncContainers(); }
    update();
  });

  form.addEventListener('submit', function (e) { e.preventDefault(); update(); });

  form.addEventListener('reset', function () {
    handlingTouched = false;
    /* Note: reset restores default handling value; syncHandling() below also re-syncs containers */
    setTimeout(function () {
      Array.prototype.forEach.call(form.querySelectorAll('.has-error'), function (g) { g.classList.remove('has-error'); });
      Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (i) { i.removeAttribute('aria-invalid'); });
      syncCategory(false); syncCurrency(); syncInsurance(); syncHandling();
      update();
      toast('تمت إعادة ضبط الحاسبة للقيم الافتراضية', 'info');
    }, 0);
  });

  $('rates-reset').addEventListener('click', function () {
    Object.keys(el.rates).forEach(function (k) { el.rates[k].value = el.rates[k].getAttribute('data-default'); });
    update();
    toast('تم استرجاع أسعار الصرف الافتراضية', 'info');
  });

  /* apply category from the tariff table */
  Array.prototype.forEach.call(document.querySelectorAll('[data-apply]'), function (btn) {
    btn.addEventListener('click', function () {
      el.category.value = btn.getAttribute('data-apply');
      syncCategory(false);
      update();
      form.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      setTimeout(function () { el.category.focus({ preventScroll: true }); }, 400);
      toast('تم تطبيق فئة «' + CATEGORIES[el.category.value].name + '» على الحاسبة', 'success');
    });
  });

  /* ---------- save / send / print ---------- */
  function snapshot() {
    var r = compute();
    render(r);
    if (!r) {
      toast('راجع الحقول المظللة باللون الأحمر أولًا', 'error');
      var bad = form.querySelector('[aria-invalid="true"]');
      if (bad) bad.focus();
      return null;
    }
    var round = function (n) { return Math.round(n * 100) / 100; };
    var out = {};
    Object.keys(r).forEach(function (k) { out[k] = typeof r[k] === 'number' ? round(r[k]) : r[k]; });
    out.ref = (M.genRef ? M.genRef('CALC') : 'CALC-' + Date.now());
    out.createdAt = new Date().toISOString();
    return out;
  }

  $('save-calc').addEventListener('click', function () {
    var s = snapshot();
    if (!s) return;
    if (M.saveLocal && M.saveLocal('marsa_calculations', s)) {
      toast('تم حفظ الحساب على جهازك برقم ' + s.ref, 'success');
    } else {
      toast('تعذّر الحفظ؛ يبدو أن التخزين المحلي غير متاح في المتصفح', 'warning');
    }
  });

  $('send-request').addEventListener('click', function () {
    var s = snapshot();
    if (!s) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(s));
      if (M.saveLocal) M.saveLocal('marsa_calculations', s);
    } catch (e) { /* storage unavailable: still continue */ }
    toast('تم تجهيز بيانات الحساب، جاري فتح طلب التخليص…', 'success');
    setTimeout(function () { window.location.href = 'request.html?from=calculator'; }, 700);
  });

  $('print-result').addEventListener('click', function () {
    var s = snapshot();
    if (!s) return;
    var cur = s.currency === LOCAL ? 'ر.س' : s.currency;
    var rows = [
      ['فئة البضاعة', s.categoryName + ' – ' + pct(s.dutyRate)],
      ['طريقة الشحن', s.modeName],
      ['قيمة الفاتورة', fmtNum(s.invoice, 2) + ' ' + cur],
      ['الشحن الدولي', fmtNum(s.freight, 2) + ' ' + cur],
      ['التأمين', fmtNum(s.insurance, 2) + ' ' + cur + (s.insuranceAuto ? ' (افتراض 1% للتقدير فقط)' : '')],
      ['سعر الصرف', s.currency === LOCAL ? '—' : '1 ' + s.currency + ' (' + CUR_NAMES[s.currency] + ') = ' + fmtNum(s.rate, 2) + ' ر.س (افتراضي استرشادي)'],
      ['رسوم الميناء والمناولة', !s.handlingOn ? 'غير مضافة' :
        (s.mode === 'fcl' ? fmtNum(s.handlingUnit, 2) + ' × ' + fmtNum(s.containers, 0) + ' حاوية = ' : '') + fmtSAR(s.handling)],
      ['تنبيه', 'نسخة عرض تجريبية — أرقام توضيحية، ليست عرض سعر']
    ];
    if (s.qty) rows.push(['عدد الوحدات', fmtNum(s.qty, 0)]);
    var ul = $('print-kv');
    ul.innerHTML = '';
    rows.forEach(function (row) {
      var li = document.createElement('li');
      var k = document.createElement('span'); k.className = 'k'; k.textContent = row[0];
      var v = document.createElement('span'); v.className = 'v'; v.textContent = row[1];
      li.appendChild(k); li.appendChild(v); ul.appendChild(li);
    });
    setText('print-ref', s.ref);
    var d = new Date();
    setText('print-date', d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()));
    var det = document.querySelector('.calc-details');
    var wasOpen = det && det.open;
    if (det) det.open = true;
    window.print();
    if (det && !wasOpen) setTimeout(function () { det.open = false; }, 300);
  });

  /* ---------- init ---------- */
  syncCategory(false);
  syncCurrency();
  syncInsurance();
  syncHandling();
  render(compute());
})();
