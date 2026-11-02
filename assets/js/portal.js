/* ==========================================================================
   مرسى | MARSA — portal.html  (client portal, STAGING)
   Load order: config.js → i18n.js → assets/i18n/portal.js → assets/i18n/app.js → main.js
               → supa.js → app-shell.js → pwa.js → portal.js  (plain <script defer>)

   * App page: window.MarsaShell (app-shell.js) draws the sidebar / topbar
     around <main id="app-main"> (user menu with sign out / sign out of all
     devices); the profile tab keeps its own sign-out buttons. Toasts go
     through Shell.toast (Marsa.toast without the shell).

   * Demo mode: shows a notice (login needs the online setup); no network.
   * Online: guard → login.html when there is no session. Everything shown is
     what RLS lets this user read: requests they submitted while signed in,
     and transactions / containers / documents / client-visible events of
     the client files staff linked to them (client_users, decision D-02).
   * All user/DB text is inserted with textContent (no innerHTML of data).
   ========================================================================== */
(function () {
  'use strict';

  var api = window.MarsaApi;
  var M = window.Marsa || {};
  var Shell = window.MarsaShell || null;
  var I = window.MarsaI18n || null;
  // shell strings in assets/i18n/portal.js ('portal.*'); Arabic fallback when missing
  function tr(k, fb) { var key = 'portal.' + k, v = I && typeof I.t === 'function' ? I.t(key) : key; return v === key ? fb : v; }
  function setShellTitle() {
    if (!Shell) return;
    if (typeof Shell.setTitle === 'function') Shell.setTitle(tr('title', 'بوابة العميل'), [{ label: tr('crumb', 'حسابي') }]);
    if (typeof Shell.setActive === 'function') Shell.setActive('portal');
  }
  setShellTitle();
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---- strings (Arabic MSA; centralised for a later EN pass) ---- */
  var T = {
    loading: 'جارٍ التحميل…',
    loadFail: 'تعذّر تحميل البيانات.',
    retry: 'إعادة المحاولة',
    noTx: 'لا توجد معاملات مرتبطة بحسابك بعد. تظهر المعاملات هنا بعد أن يربط فريق مرسى ملف منشأتك بحسابك، أو بعد تحويل طلب أرسلته وأنت مسجّل الدخول إلى معاملة.',
    noReq: 'لا توجد طلبات في حسابك بعد. الطلبات التي ترسلها من صفحة «اطلب تخليص» وأنت مسجّل الدخول تظهر هنا تلقائيًا.',
    noEvents: 'لا توجد أحداث معروضة بعد.',
    noContainers: 'لا توجد حاويات مسجّلة لهذه المعاملة.',
    noDocs: 'لا توجد مستندات معروضة لهذه المعاملة بعد.',
    back: 'العودة إلى القائمة',
    details: 'التفاصيل',
    download: 'تنزيل',
    preparing: 'جارٍ التجهيز…',
    downloadFail: 'تعذّر إنشاء رابط التنزيل. حاول مرة أخرى.',
    upload: 'رفع المستند',
    uploading: 'جارٍ حساب البصمة ورفع الملف…',
    uploadOk: 'تم رفع المستند وتسجيله. سيراجعه فريق مرسى ويصنّفه.',
    uploadPartial: 'سُجّل المستند لكن تعذّر رفع الملف نفسه. تواصل معنا أو أعد المحاولة بملف جديد.',
    pickFile: 'اختر ملفًا لرفعه.',
    badType: 'نوع الملف غير مدعوم. الأنواع المسموحة: PDF وصور JPG/PNG/WEBP/HEIC وExcel (xlsx) وCSV.',
    tooBig: 'حجم الملف أكبر من 25 ميغابايت.',
    profileSaved: 'تم حفظ بياناتك.',
    phone: 'أدخل رقم جوال سعودي صحيحًا يبدأ بـ 05.',
    name: 'أدخل الاسم الكامل (حرفان على الأقل).',
    refBad: 'أدخل رقمًا مرجعيًا صحيحًا مثل REQ-2026-000045.',
    tokenBad: 'رمز التتبع 64 خانة (أرقام وحروف a–f) كما ظهر لك عند إرسال الطلب.',
    linkSent: 'أرسلنا طلب الربط إلى فريق مرسى. بعد التحقق من ملكيتك للطلب سيظهر في بوابتك. لم نُرسل رمز التتبع ضمن الطلب.',
    signOutDone: 'تم تسجيل الخروج.',
    signOutAllDone: 'تم تسجيل الخروج هنا وإلغاء جلسات الأجهزة الأخرى؛ قد يبقى جهاز آخر متصلًا حتى تنتهي جلسته الحالية (ساعة على الأكثر).',
    staffNote: 'حسابك لديه صلاحيات موظف. لوحة الموظفين متاحة من صفحة الإدارة.',
    notLinked: 'حسابك غير مرتبط بملف عميل بعد. يمكنك متابعة طلباتك التي أرسلتها وأنت مسجّل الدخول، وطلب ربط طلب سابق من تبويب «ربط طلب».',
    eventTypes: {
      created: 'إنشاء المعاملة', request_converted: 'تحويل الطلب إلى معاملة', operational_status: 'تغيّر المرحلة التشغيلية',
      financial_status: 'تحديث الحالة المالية', container_return: 'إرجاع حاوية', document: 'مستند', note: 'ملاحظة',
      tracking_token: 'إصدار رمز تتبع'
    },
    direction: { import: 'استيراد', export: 'تصدير', transit: 'عبور (ترانزيت)' },
    mode: { sea: 'بحري', air: 'جوي', land: 'بري' }
  };
  // fallback labels if status_labels cannot be read
  var FALLBACK = {
    operational_status: [['new', 'جديدة'], ['in_progress', 'قيد العمل'], ['customs_declaration', 'البيان الجمركي'], ['appointment', 'الموعد'],
      ['transport', 'النقل'], ['empty_return', 'إعادة الحاوية الفارغة'], ['operationally_complete', 'منتهية تشغيليًا'],
      ['under_billing', 'تحت الفوترة'], ['billed', 'تمت الفوترة'], ['closed', 'مغلقة']],
    request_status: [['new', 'جديد'], ['under_review', 'قيد المراجعة'], ['converted', 'تحوّل إلى معاملة'], ['rejected', 'مرفوض']],
    container_return_status: [['pending', 'بانتظار الإرجاع'], ['evidence_submitted', 'دليل مرفوع بانتظار التحقق'],
      ['returned_verified', 'أُرجعت (دليل استلام موثّق)'], ['disputed', 'دليل غامض — مراجعة بشرية'], ['waived', 'لا يلزم إرجاع (استثناء موثّق)']],
    document_kind: [['bill_of_lading', 'بوليصة الشحن'], ['commercial_invoice', 'الفاتورة التجارية'], ['packing_list', 'قائمة التعبئة'],
      ['certificate_of_origin', 'شهادة المنشأ'], ['saber_certificate', 'شهادة سابر'], ['government_doc', 'مستند حكومي'], ['other', 'مستند آخر']]
  };
  // kinds a client may declare when uploading (staff verify/classify afterwards)
  var CLIENT_KINDS = ['bill_of_lading', 'commercial_invoice', 'packing_list', 'certificate_of_origin', 'saber_certificate', 'government_doc', 'other'];
  var ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'];
  var EXT_MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' };
  var MAX_BYTES = 26214400;

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
  function fmtDate(v, withTime) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    var o = withTime ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' };
    try { return d.toLocaleString('ar-SA-u-nu-latn-ca-gregory', o); } catch (e) { return d.toISOString().slice(0, withTime ? 16 : 10).replace('T', ' '); }
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function num(text) { return h('span', { class: 'num', dir: 'ltr', text: text == null || text === '' ? '—' : String(text) }); }
  function errText(err) { return (err && err.message) || 'حدث خطأ غير متوقع.'; }
  function alertBox(type, text) {
    return h('div', { class: 'alert alert-' + type, role: type === 'danger' ? 'alert' : 'status' }, [
      svgIcon(['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 16v-4M12 8h.01']), h('span', { text: text })]);
  }
  function loadingBox() {
    return h('div', { class: 'portal-skeleton', role: 'status', 'aria-live': 'polite' }, [h('span', { class: 'sr-only', text: T.loading }),
      h('span', { class: 'skeleton skeleton-title', 'aria-hidden': 'true' }), h('span', { class: 'skeleton skeleton-text', 'aria-hidden': 'true' }),
      h('span', { class: 'skeleton skeleton-text is-mid', 'aria-hidden': 'true' }), h('span', { class: 'skeleton skeleton-text is-short', 'aria-hidden': 'true' })]);
  }
  // empty list: icon + message (+ optional action)
  function emptyBox(text, action) {
    return h('div', { class: 'empty-state portal-empty' }, [
      h('span', { class: 'empty-state-icon', 'aria-hidden': 'true' }, [svgIcon(['M3 7h18v13H3z', 'M3 7l2-4h14l2 4', 'M9 12h6'])]),
      h('p', { text: text }), action ? h('div', { class: 'empty-state-actions' }, [action]) : null]);
  }
  // app.css card: .app-card-head (title) + .app-card-body; returns the section, children go into the body
  function panel(id, title, kids) {
    var body = h('div', { class: 'app-card-body portal-panel-body' }, kids || []);
    var sec = h('section', { class: 'app-card portal-panel', 'aria-labelledby': id }, [
      h('div', { class: 'app-card-head' }, [h('h4', { id: id, class: 'app-card-title', text: title })]), body]);
    sec.body = body;   // callers append later content to sec.body
    return sec;
  }
  function errorBox(err, retryFn) {
    var box = alertBox('danger', T.loadFail + ' ' + errText(err));
    if (retryFn) box.appendChild(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: T.retry, onclick: retryFn }));
    return box;
  }
  function kvList(rows) {
    return h('ul', { class: 'kv' }, rows.filter(function (r) { return r; }).map(function (r) {
      var v = r[1];
      return h('li', null, [h('span', { class: 'k', text: r[0] }), h('span', { class: 'v' }, [v == null || v === '' ? '—' : (typeof v === 'object' ? v : String(v))])]);
    }));
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
  function fieldError(input, msg) {
    var g = input.closest('.form-group');
    if (!g) return;
    var err = g.querySelector('.form-error');
    if (msg) { g.classList.add('has-error'); input.setAttribute('aria-invalid', 'true'); if (err) err.textContent = msg; }
    else { g.classList.remove('has-error'); input.removeAttribute('aria-invalid'); }
  }
  function toast(msg, type) {
    if (Shell && typeof Shell.toast === 'function') Shell.toast(msg, type);
    else if (M.toast) M.toast(msg, type);
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
  var state = { user: null, ctx: null, labels: {}, txCache: {}, reqCache: {} };
  showView('loading');

  function goLogin() { location.replace('login.html?next=portal.html#client'); }

  function label(domain, code) {
    var list = state.labels[domain] || [];
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i].label_ar;
    return code || '—';
  }
  function sortOf(domain, code) {
    var list = state.labels[domain] || [];
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i].sort;
    return 0;
  }
  function loadLabels() {
    var domains = ['operational_status', 'request_status', 'container_return_status', 'document_kind'];
    return Promise.all(domains.map(function (d) { return api.statusLabels(d); })).then(function (rs) {
      rs.forEach(function (r, i) {
        var d = domains[i];
        if (!r.error && r.data && r.data.length) state.labels[d] = r.data;
        else state.labels[d] = (FALLBACK[d] || []).map(function (x, j) { return { code: x[0], label_ar: x[1], sort: j + 1 }; });
      });
    });
  }
  // status → pill tone (app.css .pill-<tone>)
  function statusBadge(domain, code) {
    var tone = 'info';
    if (domain === 'request_status') tone = { new: 'info', under_review: 'warning', converted: 'success', rejected: 'danger' }[code] || tone;
    if (domain === 'operational_status') tone = { operationally_complete: 'success', under_billing: 'brand', billed: 'brand', closed: 'neutral' }[code] || 'info';
    if (domain === 'container_return_status') tone = { pending: 'warning', evidence_submitted: 'info', returned_verified: 'success', disputed: 'danger', waived: 'neutral' }[code] || tone;
    return h('span', { class: 'pill pill-dot pill-' + tone, text: label(domain, code) });
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
      api.signOut().then(function () { toast(T.signOutDone, 'info'); location.replace('login.html#client'); });
    });
  });
  // revokes the sessions on every device (Supabase scope 'global'), then leaves the portal
  $$('[data-sign-out-all]').forEach(function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      api.signOutEverywhere().then(function (r) {
        b.disabled = false;
        if (r.error) { toast(r.error.message, 'error'); return; }
        toast(T.signOutAllDone, 'info'); location.replace('login.html#client');
      });
    });
  });

  /* ======================================================================
     TRANSACTIONS
     ====================================================================== */
  var txList = $('[data-tx-list]'), txDetail = $('[data-tx-detail]');
  function loadTransactions() {
    clear(txList).appendChild(loadingBox());
    txDetail.hidden = true; txList.hidden = false;
    return api.listTransactions({ limit: 100 }).then(function (r) {
      clear(txList);
      if (r.error) { txList.appendChild(errorBox(r.error, loadTransactions)); return; }
      var rows = r.data || [];
      var cnt = $('[data-count="tx"]'); if (cnt) cnt.textContent = String(rows.length);
      if (!rows.length) { txList.appendChild(emptyBox(T.noTx)); return; }
      state.txCache = {};
      var tbody = h('tbody');
      rows.forEach(function (t) {
        state.txCache[t.id] = t;
        tbody.appendChild(h('tr', null, [
          h('td', null, [num(t.ref)]),
          h('td', { text: [T.direction[t.operation] || t.operation, T.mode[t.mode] || t.mode].filter(Boolean).join(' · ') || '—' }),
          h('td', null, [t.bl_number ? num(t.bl_number) : '—']),
          h('td', null, [statusBadge('operational_status', t.operational_status)]),
          h('td', { text: fmtDate(t.status_changed_at || t.updated_at) }),
          h('td', { class: 'portal-col-actions' }, [h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: T.details,
            'aria-label': T.details + ' ' + (t.ref || ''), onclick: function () { openTransaction(t.id); } })])
        ]));
      });
      txList.appendChild(h('div', { class: 'data-table-wrap' }, [h('table', { class: 'data-table portal-table' }, [
        h('caption', { class: 'sr-only', text: 'معاملاتي' }),
        h('thead', null, [h('tr', null, ['الرقم المرجعي', 'العملية', 'رقم البوليصة', 'المرحلة الحالية', 'آخر تحديث', ''].map(function (x) { return h('th', { scope: 'col', text: x }); }))]),
        tbody])]));
    });
  }

  function openTransaction(id) {
    txList.hidden = true; txDetail.hidden = false;
    clear(txDetail).appendChild(loadingBox());
    Promise.all([api.getTransaction(id), api.listEvents(id), api.listDocuments({ transactionId: id })]).then(function (rs) {
      clear(txDetail);
      var back = h('button', { class: 'btn btn-sm btn-ghost portal-back', type: 'button', onclick: function () { txDetail.hidden = true; txList.hidden = false; } },
        [svgIcon('M5 12h14M13 6l6 6-6 6'), T.back]);
      txDetail.appendChild(back);
      var tr = rs[0], ev = rs[1], dr = rs[2];
      if (tr.error || !tr.data) { txDetail.appendChild(errorBox(tr.error || { message: '' }, function () { openTransaction(id); })); return; }
      var t = tr.data;
      txDetail.appendChild(h('div', { class: 'portal-detail-head' }, [
        h('div', null, [h('p', { class: 'eyebrow mb-1', text: 'معاملة' }), h('h3', { class: 'mb-0' }, [num(t.ref)])]),
        statusBadge('operational_status', t.operational_status)
      ]));

      var grid = h('div', { class: 'portal-detail-grid' });
      txDetail.appendChild(grid);
      var main = h('div', { class: 'stack' }), side = h('div', { class: 'stack' });
      grid.appendChild(main); grid.appendChild(side);

      // summary
      main.appendChild(panel('tx-sum-h', 'بيانات المعاملة', [
        kvList([
          ['العميل', t.clients && t.clients.name_ar],
          ['الفرع', t.branches && t.branches.name_ar],
          ['نوع العملية', T.direction[t.operation] || t.operation],
          ['وسيلة الشحن', T.mode[t.mode] || t.mode],
          ['منفذ التفريغ', t.port_of_discharge],
          ['بلد المنشأ/الوجهة', t.country],
          ['وصف البضاعة', t.goods_description],
          ['رمز HS', t.hs_code ? num(t.hs_code) : null],
          ['الخط الملاحي', t.shipping_line],
          ['رقم البوليصة', t.bl_number ? num(t.bl_number) : null],
          ['رقم البيان الجمركي', t.declaration_no ? num(t.declaration_no) : null],
          ['تاريخ الوصول المتوقع', t.eta ? fmtDate(t.eta) : null],
          ['عدد الحاويات', t.container_count != null ? num(t.container_count) : null]
        ])
      ]));

      // containers
      main.appendChild(renderContainers(t.containers || []));
      // documents (+ upload)
      main.appendChild(renderDocuments(t, dr));
      // stages + event history
      side.appendChild(renderStages(t));
      side.appendChild(renderEvents(ev));
      try { txDetail.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignore */ }
    });
  }

  function renderStages(t) {
    var cur = sortOf('operational_status', t.operational_status);
    var ol = h('ol', { class: 'timeline' });
    (state.labels.operational_status || []).forEach(function (s) {
      var cls = s.sort < cur ? 'is-done' : (s.sort === cur ? 'is-current' : '');
      ol.appendChild(h('li', { class: cls, 'aria-current': s.sort === cur ? 'step' : null }, [
        h('span', { class: 'tl-dot' }), h('span', { class: 'tl-title', text: s.label_ar }),
        s.sort === cur ? h('span', { class: 'tl-meta', text: 'منذ ' + fmtDate(t.status_changed_at, true) }) : null
      ]));
    });
    return panel('tx-stage-h', 'المراحل التشغيلية', [
      h('p', { class: 'text-xs text-muted', text: 'الحالة التشغيلية منفصلة عن الحالة المالية.' }),
      ol]);
  }

  function renderEvents(ev) {
    var sec = panel('tx-ev-h', 'سجل الأحداث');
    if (ev.error) { sec.body.appendChild(errorBox(ev.error)); return sec; }
    var rows = ev.data || [];
    if (!rows.length) { sec.body.appendChild(h('p', { class: 'text-muted text-sm', text: T.noEvents })); return sec; }
    var ol = h('ol', { class: 'timeline' });
    rows.slice().reverse().forEach(function (e, i) {
      var title = T.eventTypes[e.event_type] || e.event_type;
      var detail = '';
      if (e.event_type === 'operational_status' || e.event_type === 'created' || e.event_type === 'request_converted') {
        if (e.to_status) detail = (e.from_status ? label('operational_status', e.from_status) + ' ← ' : '') + label('operational_status', e.to_status);
      } else if (e.event_type === 'container_return') {
        detail = ((e.payload && e.payload.container_no) ? e.payload.container_no + ': ' : '') + label('container_return_status', e.to_status);
      } else if (e.event_type === 'document' && e.payload) {
        detail = label('document_kind', e.payload.kind);
      }
      ol.appendChild(h('li', { class: i === 0 ? 'is-current' : 'is-done' }, [
        h('span', { class: 'tl-dot' }),
        h('span', { class: 'tl-title', text: title + (detail ? ' — ' + detail : '') }),
        e.note ? h('span', { class: 'tl-meta d-block', text: e.note }) : null,
        h('span', { class: 'tl-meta', text: fmtDate(e.created_at, true) })
      ]));
    });
    sec.body.appendChild(ol);
    sec.body.appendChild(h('p', { class: 'text-xs text-muted mt-2', text: 'السجل للإضافة فقط: التصحيحات تُضاف كأحداث جديدة ولا تمحو ما سبق.' }));
    return sec;
  }

  function renderContainers(list) {
    var sec = panel('tx-ct-h', 'الحاويات وحالة إرجاع الفارغ');
    if (!list.length) { sec.body.appendChild(h('p', { class: 'text-muted text-sm', text: T.noContainers })); return sec; }
    list = list.slice().sort(function (a, b) { return String(a.container_no).localeCompare(String(b.container_no)); });
    var tbody = h('tbody');
    list.forEach(function (c) {
      tbody.appendChild(h('tr', null, [
        h('td', null, [num(c.container_no)]),
        h('td', null, [num(c.container_type)]),
        h('td', null, [statusBadge('container_return_status', c.return_status)]),
        h('td', { text: c.return_deadline ? fmtDate(c.return_deadline) : '—' }),
        h('td', { text: c.returned_at ? fmtDate(c.returned_at) : '—' })
      ]));
    });
    sec.body.appendChild(h('div', { class: 'data-table-wrap' }, [h('table', { class: 'data-table is-compact portal-table' }, [
      h('thead', null, [h('tr', null, ['رقم الحاوية', 'النوع', 'حالة الإرجاع', 'آخر موعد للإرجاع', 'تاريخ الإرجاع'].map(function (x) { return h('th', { scope: 'col', text: x }); }))]),
      tbody])]));
    sec.body.appendChild(h('p', { class: 'text-xs text-muted mt-2', text: 'تُعدّ الحاوية مُرجعة فقط بإيصال استلام الفارغ من الساحة أو المشغّل بعد تحقق موظف مرسى؛ تعليمات الإرجاع أو إيصال تسليم الممتلئ ليست إثباتًا.' }));
    return sec;
  }

  function renderDocuments(t, dr) {
    var sec = panel('tx-doc-h', 'المستندات');
    var listWrap = h('div');
    sec.body.appendChild(listWrap);
    function paint(res) {
      clear(listWrap);
      if (res.error) { listWrap.appendChild(errorBox(res.error)); return; }
      var docs = res.data || [];
      if (!docs.length) { listWrap.appendChild(h('p', { class: 'text-muted text-sm', text: T.noDocs })); return; }
      var ul = h('ul', { class: 'file-list portal-docs' });
      docs.forEach(function (d) {
        var btn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': T.download + ' ' + d.original_name }, [
          svgIcon(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5M12 15V3']), T.download]);
        btn.addEventListener('click', function () { download(d, btn); });
        ul.appendChild(h('li', { class: 'file-item' }, [
          svgIcon(['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5']),
          h('span', { class: 'file-name' }, [
            h('bdi', { text: d.original_name }),
            h('span', { class: 'text-xs text-muted d-block' }, [
              label('document_kind', d.classification || d.kind) + (d.classification ? '' : ' (حسب الرافع)') +
              ' · ' + fmtDate(d.uploaded_at) + (d.version > 1 ? ' · نسخة ' + d.version : '') + ' · SHA-256 ',
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
    sec.body.appendChild(uploadForm(t, function () { api.listDocuments({ transactionId: t.id }).then(paint); }));
    return sec;
  }

  function download(d, btn) {
    var label0 = btn.lastChild.textContent;
    btn.disabled = true; btn.lastChild.textContent = T.preparing;
    // open the tab synchronously (popup blockers), then point it at the short-lived signed URL
    var w = null;
    try { w = window.open('', '_blank'); if (w) w.opener = null; } catch (e) { w = null; }
    api.documentUrl(d, 120).then(function (r) {
      btn.disabled = false; btn.lastChild.textContent = label0;
      if (r.error || !r.data) { if (w) w.close(); toast(T.downloadFail, 'error'); return; }
      if (w) w.location.href = r.data; else location.assign(r.data);
    });
  }

  var uploadSeq = 0;
  function uploadForm(t, onDone) {
    var n = ++uploadSeq;
    var kindSel = h('select', { class: 'form-control', id: 'up-kind-' + n, name: 'kind', required: true },
      CLIENT_KINDS.map(function (k) { return h('option', { value: k, text: label('document_kind', k) }); }));
    var fileIn = h('input', { class: 'form-control', id: 'up-file-' + n, name: 'file', type: 'file', required: true,
      accept: '.pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.csv,' + ALLOWED_MIME.join(','), 'aria-describedby': 'up-hint-' + n });
    var status = h('div', { class: 'mt-2', 'aria-live': 'polite' });
    var submit = h('button', { class: 'btn btn-primary', type: 'submit' }, [
      svgIcon(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5M12 3v12']), T.upload]);
    var form = h('form', { class: 'form portal-upload mt-3', novalidate: true }, [
      h('h5', { class: 'mb-0', text: 'رفع مستند جديد' }),
      h('div', { class: 'form-row' }, [
        h('div', { class: 'form-group' }, [h('label', { class: 'form-label', for: 'up-kind-' + n, text: 'نوع المستند' }), kindSel]),
        h('div', { class: 'form-group' }, [
          h('label', { class: 'form-label', for: 'up-file-' + n }, ['الملف ', h('span', { class: 'req', text: '*' })]), fileIn,
          h('span', { class: 'form-hint', id: 'up-hint-' + n, text: 'PDF أو صورة أو Excel/CSV، حتى 25 ميغابايت. نحفظ الأصل كما هو مع بصمته (SHA-256) ولا يمكن استبداله أو حذفه.' }),
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
      if (!f) { fieldError(fileIn, T.pickFile); fileIn.focus(); return; }
      var ext = (String(f.name).split('.').pop() || '').toLowerCase();
      var mime = f.type || EXT_MIME[ext] || '';
      if (ALLOWED_MIME.indexOf(mime) === -1 || !EXT_MIME[ext]) { fieldError(fileIn, T.badType); fileIn.focus(); return; }
      if (f.size <= 0 || f.size > MAX_BYTES) { fieldError(fileIn, T.tooBig); fileIn.focus(); return; }
      var file = f.type ? f : new File([f], f.name, { type: mime });
      submit.disabled = true; fileIn.disabled = true; kindSel.disabled = true;
      status.appendChild(h('p', { class: 'portal-loading', role: 'status' }, [h('span', { class: 'dot dot-pulse' }), T.uploading]));
      api.uploadDocument({ file: file, transactionId: t.id, kind: kindSel.value, source: 'upload' }).then(function (r) {
        submit.disabled = false; fileIn.disabled = false; kindSel.disabled = false;
        clear(status);
        if (r.error && r.data) { status.appendChild(alertBox('warning', T.uploadPartial)); onDone(); return; }
        if (r.error) { status.appendChild(alertBox('danger', errText(r.error))); return; }
        form.reset();
        status.appendChild(alertBox('success', T.uploadOk));
        toast(T.uploadOk, 'success');
        onDone();
      });
    });
    return form;
  }

  /* ======================================================================
     SERVICE REQUESTS
     ====================================================================== */
  var reqList = $('[data-req-list]'), reqDetail = $('[data-req-detail]');
  function loadRequests() {
    clear(reqList).appendChild(loadingBox());
    reqDetail.hidden = true; reqList.hidden = false;
    return api.listRequests({ limit: 100 }).then(function (r) {
      clear(reqList);
      if (r.error) { reqList.appendChild(errorBox(r.error, loadRequests)); return; }
      var rows = r.data || [];
      var cnt = $('[data-count="req"]'); if (cnt) cnt.textContent = String(rows.length);
      if (!rows.length) {
        reqList.appendChild(emptyBox(T.noReq, h('a', { class: 'btn btn-primary btn-sm', href: 'request.html', text: 'اطلب تخليص' })));
        return;
      }
      var tbody = h('tbody');
      rows.forEach(function (q) {
        state.reqCache[q.id] = q;
        tbody.appendChild(h('tr', null, [
          h('td', null, [num(q.ref)]),
          h('td', { text: fmtDate(q.created_at) }),
          h('td', { text: [T.direction[q.direction] || q.direction, T.mode[q.mode] || q.mode].filter(Boolean).join(' · ') || '—' }),
          h('td', { text: q.port || '—' }),
          h('td', null, [statusBadge('request_status', q.status)]),
          h('td', { class: 'portal-col-actions' }, [h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: T.details,
            'aria-label': T.details + ' ' + (q.ref || ''), onclick: function () { openRequest(q.id); } })])
        ]));
      });
      reqList.appendChild(h('div', { class: 'data-table-wrap' }, [h('table', { class: 'data-table portal-table' }, [
        h('caption', { class: 'sr-only', text: 'طلباتي' }),
        h('thead', null, [h('tr', null, ['رقم الطلب', 'تاريخ الإرسال', 'العملية', 'المنفذ', 'الحالة', ''].map(function (x) { return h('th', { scope: 'col', text: x }); }))]),
        tbody])]));
    });
  }
  function openRequest(id) {
    var q = state.reqCache[id];
    if (!q) return;
    reqList.hidden = true; reqDetail.hidden = false;
    clear(reqDetail);
    reqDetail.appendChild(h('button', { class: 'btn btn-sm btn-ghost portal-back', type: 'button', onclick: function () { reqDetail.hidden = true; reqList.hidden = false; } },
      [svgIcon('M5 12h14M13 6l6 6-6 6'), T.back]));
    reqDetail.appendChild(h('div', { class: 'portal-detail-head' }, [
      h('div', null, [h('p', { class: 'eyebrow mb-1', text: 'طلب خدمة' }), h('h3', { class: 'mb-0' }, [num(q.ref)])]),
      statusBadge('request_status', q.status)
    ]));
    var docs = (q.declared_documents || []).map(function (d) { return d && d.name; }).filter(Boolean);
    reqDetail.appendChild(h('section', { class: 'app-card portal-panel' }, [h('div', { class: 'app-card-body portal-panel-body' }, [
      kvList([
        ['تاريخ الإرسال', fmtDate(q.created_at, true)],
        ['مقدّم الطلب', q.full_name], ['الشركة', q.company],
        ['نوع العملية', T.direction[q.direction] || q.direction], ['وسيلة الشحن', T.mode[q.mode] || q.mode],
        ['الخدمة', q.service], ['البلد', q.country], ['المنفذ', q.port], ['وصف البضاعة', q.goods],
        ['رقم البوليصة', q.bl_number ? num(q.bl_number) : null], ['تاريخ الوصول المتوقع', q.eta ? fmtDate(q.eta) : null],
        ['المستندات المعلنة', docs.length ? docs.join('، ') : null],
        q.status_note ? ['ملاحظة الفريق', q.status_note] : null,
        q.reviewed_at ? ['تاريخ المراجعة', fmtDate(q.reviewed_at, true)] : null
      ]),
      q.status === 'converted' ? h('p', { class: 'text-sm mt-2', text: 'تحوّل هذا الطلب إلى معاملة؛ تظهر في تبويب «معاملاتي» بعد ربط ملف العميل بحسابك.' }) : null,
      h('p', { class: 'text-xs text-muted mt-2', text: 'المستندات المعلنة أسماء ملفات فقط؛ ارفع الأصول من صفحة المعاملة بعد تحويل الطلب.' })
    ])]));
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
    if (!/^[A-Z]{2,5}-\d{4}-\d{6,}$/.test(ref)) { fieldError(refIn, T.refBad); bad = true; }
    if (!/^[0-9a-f]{64}$/.test(tok)) { fieldError(tokIn, T.tokenBad); bad = true; }
    if (bad) { (linkForm.querySelector('[aria-invalid="true"]') || refIn).focus(); return; }
    var btn = linkForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    api.publicTrack(ref, tok).then(function (r) {
      btn.disabled = false;
      tokIn.value = '';   // never keep the secret in the DOM longer than needed
      if (r.error) { linkResult.appendChild(alertBox('danger', errText(r.error))); return; }
      var d = r.data || {};
      var info = d.kind === 'transaction' && d.transaction
        ? [['النوع', 'معاملة'], ['الرقم المرجعي', num(d.transaction.ref)], ['المرحلة الحالية', d.transaction.status_label_ar]]
        : [['النوع', 'طلب خدمة'], ['الرقم المرجعي', num(d.request && d.request.ref)], ['الحالة', d.request && d.request.status_label_ar],
           ['تاريخ الإرسال', d.request ? fmtDate(d.request.created_at) : null]];
      var send = h('button', { class: 'btn btn-primary mt-3', type: 'button', text: 'اطلب ربطه بحسابي' });
      send.addEventListener('click', function () { requestLink(ref, send); });
      linkResult.appendChild(h('div', { class: 'app-card-body app-card portal-panel is-muted' }, [
        alertBox('success', 'تم التحقق من الرقم المرجعي ورمز التتبع.'),
        h('div', { class: 'mt-2' }, [kvList(info)]),
        h('p', { class: 'text-sm mt-2', text: 'الربط بحسابك قرار يتخذه فريق مرسى بعد التحقق (لا يتم تلقائيًا). سنرسل إليهم الرقم المرجعي وبيانات حسابك فقط، دون رمز التتبع.' }),
        send
      ]));
    });
  });
  function requestLink(ref, btn) {
    var p = (state.ctx && state.ctx.profile) || {};
    var phone = normPhone(p.phone);
    if (!phone) {
      linkResult.appendChild(alertBox('warning', 'أضف رقم جوالك في تبويب «ملفي» أولًا ليتمكن الفريق من التواصل معك.'));
      return;
    }
    btn.disabled = true;
    api.submitContactMessage({
      name: p.full_name || (state.user && state.user.email) || '', company: '', phone: phone,
      email: state.user && state.user.email, subject: 'tracking', reference: ref, preferred: 'email', consent: true,
      message: 'طلب ربط من بوابة العميل: أرجو ربط ' + ref + ' بحسابي في البوابة. تحقّق صاحب الحساب من الرقم المرجعي ورمز التتبع في البوابة.'
    }).then(function (r) {
      if (r.error) { btn.disabled = false; linkResult.appendChild(alertBox('danger', errText(r.error))); return; }
      btn.hidden = true;
      linkResult.appendChild(h('div', { class: 'mt-2' }, [alertBox('success', T.linkSent),
        r.data && r.data.ref ? h('p', { class: 'text-sm mt-2' }, ['رقم الرسالة: ', num(r.data.ref)]) : null]));
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
    if (nm) nm.value = p.full_name || '';
    if (ph) ph.value = p.phone || '';
    if (em) em.value = (state.user && state.user.email) || '';
    var links = $('[data-profile-links]');
    if (!links) return;
    clear(links);
    var clients = (state.ctx && state.ctx.clients) || [];
    var mships = (state.ctx && state.ctx.memberships) || [];
    links.appendChild(kvList([
      ['ملفات العملاء المرتبطة', clients.length ? clients.map(function (c) { return c.name_ar; }).join('، ') : 'لا يوجد بعد'],
      ['العضويات', mships.length ? mships.map(function (m) { return (m.org_name_ar || m.org_slug) + ' — ' + (m.role_label_ar || m.role) + (m.branch_name_ar ? ' (' + m.branch_name_ar + ')' : ''); }).join('، ') : 'لا يوجد'],
      ['تاريخ إنشاء الحساب', state.user && state.user.created_at ? fmtDate(state.user.created_at) : null]
    ]));
  }
  var pf = $('#profile-form');
  if (pf) pf.addEventListener('submit', function (e) {
    e.preventDefault();
    var nm = $('#pf-name'), ph = $('#pf-phone'), bad = false;
    fieldError(nm, null); fieldError(ph, null);
    var name = String(nm.value).trim(), phone = ph.value.trim() ? normPhone(ph.value) : '';
    if (name.length < 2 || name.length > 120) { fieldError(nm, T.name); bad = true; }
    if (phone === null) { fieldError(ph, T.phone); bad = true; }
    if (bad) return;
    var btn = pf.querySelector('button[type="submit"]');
    btn.disabled = true;
    updateProfile({ full_name: name, phone: phone || null }).then(function (r) {
      btn.disabled = false;
      if (r.error) { toast(errText(r.error), 'error'); return; }
      if (state.ctx) state.ctx.profile = Object.assign({}, state.ctx.profile, r.data);
      renderUser();
      toast(T.profileSaved, 'success');
    });
  });
  var cp = $('#password-form');
  if (cp) cp.addEventListener('submit', function (e) {
    e.preventDefault();
    var a = $('#pf-pw'), b = $('#pf-pw2'), bad = false;
    fieldError(a, null); fieldError(b, null);
    if (!(a.value.length >= 8 && a.value.length <= 72 && /[A-Za-z؀-ۿ]/.test(a.value) && /\d/.test(a.value))) { fieldError(a, 'كلمة المرور 8 أحرف على الأقل وتجمع حروفًا وأرقامًا.'); bad = true; }
    if (b.value !== a.value) { fieldError(b, 'كلمتا المرور غير متطابقتين.'); bad = true; }
    if (bad) return;
    var btn = cp.querySelector('button[type="submit"]');
    btn.disabled = true;
    api.updatePassword(a.value).then(function (r) {
      btn.disabled = false; a.value = ''; b.value = '';
      if (r.error) { toast(errText(r.error), 'error'); return; }
      toast('تم تغيير كلمة المرور.', 'success');
    });
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
        loadTransactions();
        loadRequests();
      });
    });
  }
  var retry = $('[data-portal-retry]');
  if (retry) retry.addEventListener('click', boot);
  api.onAuth(function (event) { if (event === 'SIGNED_OUT') goLogin(); });
  boot();
})();
