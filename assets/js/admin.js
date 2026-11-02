/* ==========================================================================
   مرسى | MARSA — admin.html staff console (STAGING)
   --------------------------------------------------------------------------
   Load order: config.js → i18n.js → assets/i18n/admin.js → assets/i18n/app.js
   → main.js → supa.js → app-shell.js → pwa.js → admin.js (all defer).
   * Classic layout (as in efa96c9): site header + page hero + .adm-topbar
     card (me, org switch, search, refresh, sign out) + the in-page section
     nav #adm-nav + #adm-view. window.MarsaShell (classic helper, optional)
     supplies MarsaShell.ready (my_context or null), the breadcrumb/title,
     the active nav item, the open-alerts count badge, the Ctrl/⌘K search
     palette and toast / confirm. Without it the page keeps its own session
     check, nav and document title.
   * Online only. In demo mode (empty config) the page shows a notice and
     never touches localStorage data.
   * Role guard: any active staff membership in the active org (the shell's
     org switcher picks it when the user is staff in more than one org;
     default MARSA_CONFIG.orgSlug). The UI only hides what a role cannot do;
     the database (RLS + guarded RPCs) is the real gate, and every error
     from it is shown as returned.
   * List views load a window of up to WINDOW rows with the server filters
     (status / branch / search), then quick-filter, sort and paginate
     (PAGE rows) on the client; newer / next-window buttons re-query with
     S.filters[key].offset ± WINDOW. Rows open their detail view.
   * All user-supplied values are HTML-escaped before rendering (esc()).
     The G2 console views (org, branches, members & invitations, audit,
     client errors) build DOM nodes and set data with textContent only.
   * G3 (docs/online/G3_SPEC.md): assets/js/ops/*.js register MarsaOps.views
     (merged into the routing with the R role sets) and MarsaOps.txSections
     (rendered inside #tx/<id> after the cards below); see "G3 module hook".
     admin.js itself adds the dashboard alert / appointment KPIs, client
     aliases, matchClient candidates in request conversion and the new
     transaction dialog (from a B/L or partial data).
   * Local helpers that MarsaApi does not provide yet (see "LOCAL API GAPS")
     use MarsaApi.client after MarsaApi.ready() and the same {data,error} shape.
   ========================================================================== */
(function () {
  'use strict';

  var api = window.MarsaApi;
  var M = window.Marsa || {};
  var SH = window.MarsaShell || null;
  var gateBody = document.getElementById('adm-gate-body');
  var gate = document.getElementById('adm-gate');
  var app = document.getElementById('adm-app');
  var view = document.getElementById('adm-view');
  var nav = document.getElementById('adm-nav');   // in-page section nav (ul.adm-nav-list)
  if (!gate || !app || !view) return;

  /* ------------------------------------------------------------------
     Strings (Arabic MSA) — kept together for later EN extraction
     ------------------------------------------------------------------ */
  var T = {
    views: {
      dashboard: 'نظرة عامة', requests: 'الطلبات الواردة', transactions: 'المعاملات', clients: 'العملاء',
      messages: 'رسائل التواصل', imports: 'سجل الاستيراد', members: 'الأعضاء والدعوات',
      org: 'المؤسسة', branches: 'الفروع', audit: 'سجل التدقيق', errors: 'أخطاء الواجهة'
    },
    gate: {
      demoTitle: 'لوحة الموظفين تعمل في النسخة المتصلة فقط',
      demo: 'الموقع الآن في وضع نسخة العرض التجريبية (بيانات محلية على جهازك)، ولا توجد قاعدة بيانات متصلة. لتجربة اللوحة يلزم ربط بيئة الاختبار في ملف assets/js/config.js.',
      misconfigured: 'إعدادات الاتصال غير صحيحة. راجع ملف assets/js/config.js.',
      signInTitle: 'يلزم تسجيل الدخول',
      signIn: 'سجّل الدخول بحساب موظف للوصول إلى لوحة الموظفين.',
      signInBtn: 'دخول الموظفين',
      forbiddenTitle: 'لا تملك صلاحية موظف',
      forbidden: 'حسابك مسجّل، لكن لا توجد له صلاحية موظف نشطة في هذه المؤسسة. تواصل مع مدير النظام لإضافتك.',
      errorTitle: 'تعذّر تحميل اللوحة',
      retry: 'إعادة المحاولة',
      home: 'العودة للرئيسية'
    },
    common: {
      loading: 'جارٍ التحميل…', empty: 'لا توجد بيانات مطابقة.', view: 'عرض', edit: 'تعديل', save: 'حفظ',
      back: 'رجوع', all: 'الكل', search: 'بحث', prev: 'السابق', next: 'التالي', yes: 'نعم', none: '—',
      saved: 'تم الحفظ.', confirm: 'تأكيد', open: 'فتح', notAllowed: 'لا تملك صلاحية هذا الإجراء.',
      required: 'هذا الحقل مطلوب.', ofTotal: 'من', results: 'نتيجة'
    }
  };

  // fallback labels (DB status_labels override these when loaded)
  var FALLBACK = {
    operational_status: { new: 'جديدة', in_progress: 'قيد العمل', customs_declaration: 'البيان الجمركي', appointment: 'الموعد', transport: 'النقل', empty_return: 'إعادة الحاوية الفارغة', operationally_complete: 'منتهية تشغيليًا', under_billing: 'تحت الفوترة', billed: 'تمت الفوترة', closed: 'مغلقة' },
    financial_status: { not_started: 'لم تبدأ', estimate_only: 'تقدير غير ضريبي فقط', draft_pending: 'مسودة قيد الإعداد', invoiced: 'صدرت الفاتورة (خارج النظام)', settled: 'مسددة' },
    request_status: { new: 'جديد', under_review: 'قيد المراجعة', converted: 'تحوّل إلى معاملة', rejected: 'مرفوض' },
    container_return_status: { pending: 'بانتظار الإرجاع', evidence_submitted: 'دليل مرفوع بانتظار التحقق', returned_verified: 'أُرجعت (دليل استلام موثّق)', disputed: 'دليل غامض — مراجعة بشرية', waived: 'لا يلزم إرجاع (استثناء موثّق)' },
    document_kind: { bill_of_lading: 'بوليصة الشحن', commercial_invoice: 'الفاتورة التجارية', packing_list: 'قائمة التعبئة', certificate_of_origin: 'شهادة المنشأ', saber_certificate: 'شهادة سابر', customs_declaration: 'البيان الجمركي', delivery_order: 'إذن التسليم', appointment: 'مستند موعد', container_delivery_eir: 'إيصال تسليم الحاوية الممتلئة (EIR)', empty_return_note: 'تعليمات إرجاع الفارغ (ليست إثباتًا)', empty_return_receipt: 'إيصال استلام الفارغ من الساحة/المشغل', operator_invoice: 'فاتورة مشغل/مورد', government_doc: 'مستند حكومي', import_file: 'ملف رفع جماعي', other: 'مستند آخر' },
    classification_status: { unreviewed: 'لم يُراجع', confirmed: 'تصنيف مؤكد', reclassified: 'أعيد تصنيفه', ambiguous: 'غامض — يحتاج مراجعة' },
    contact_status: { new: 'جديدة', in_progress: 'قيد المعالجة', closed: 'مغلقة' },
    import_row_status: { pending: 'بانتظار التحقق', valid: 'صالح', error: 'به أخطاء', duplicate: 'مكرر محتمل — قرار بشري', committed: 'تحوّل إلى طلب', skipped: 'تم تجاهله' },
    role: { client: 'عميل', clearance_staff: 'موظف تخليص', transport_staff: 'موظف نقل', accountant: 'محاسب', accounts_manager: 'مدير حسابات', operations_manager: 'مدير عمليات', branch_manager: 'مدير فرع', supervisor: 'مشرف', admin: 'مدير نظام' },
    // local-only dictionaries (not in status_labels yet)
    direction: { import: 'استيراد', export: 'تصدير' },
    mode: { sea: 'بحري', air: 'جوي', land: 'بري' },
    client_type: { individual: 'فرد', business: 'منشأة' },
    contact_pref: { phone: 'اتصال هاتفي', whatsapp: 'واتساب', email: 'بريد إلكتروني' },
    source: { web: 'الموقع', portal: 'بوابة العميل', bulk: 'رفع جماعي', staff: 'موظف' },
    doc_source: { upload: 'رفع', staff_scan: 'مسح ضوئي من الموظف', email: 'بريد إلكتروني', whatsapp: 'واتساب', import: 'رفع جماعي', system: 'النظام' },
    visibility: { internal: 'داخلي', client: 'ظاهر للعميل' },
    batch_status: { draft: 'مسودة', committed: 'معتمدة', cancelled: 'ملغاة' },
    service: { clearance: 'تخليص جمركي متكامل', aci: 'البيان المسبق ومنصة فسح', hs: 'تصنيف HS Code', inspection: 'متابعة المعاينة والإفراج', door: 'تخليص وتوصيل', freight: 'شحن دولي مع التخليص', export: 'تخليص صادرات', consult: 'استشارة جمركية' },
    subject: { quote: 'طلب عرض سعر', aci: 'البيان المسبق ومنصة فسح', saber: 'شهادة سابر', hs: 'تصنيف HS Code', duties: 'الرسوم والضريبة', tracking: 'متابعة شحنة', export: 'التصدير والشحن', partnership: 'شراكات', complaint: 'شكوى أو اقتراح', other: 'موضوع آخر' },
    container_type: { '20ft': '20 قدم', '40ft': '40 قدم', '40hc': '40 قدم عالية', '45ft': '45 قدم', '20rf': '20 قدم مبردة', '40rf': '40 قدم مبردة', LCL: 'شحنة جزئية LCL', other: 'أخرى' },
    event_type: { created: 'إنشاء المعاملة', request_converted: 'تحويل من طلب خدمة', operational_status: 'تغيير الحالة التشغيلية', financial_status: 'تغيير الحالة المالية', container_return: 'حالة إرجاع حاوية', document: 'مستند', note: 'ملاحظة', tracking_token: 'إصدار رمز تتبع',
      // G3 (transaction children)
      declaration: 'البيان الجمركي', bill_of_lading: 'بوليصة الشحن', bl: 'بوليصة الشحن', container: 'حاوية', container_state: 'الحالة التشغيلية للحاوية', appointment: 'موعد الميناء', trip: 'رحلة نقل', exception: 'استثناء تشغيلي', override: 'تجاوز قاعدة المستندات', docs_override: 'تجاوز قاعدة المستندات' }
  };
  var LABELS = JSON.parse(JSON.stringify(FALLBACK));
  var LABELS_EN = {};   // status_labels.label_en per domain (filled by loadLabels)
  var ORDER = {
    operational_status: ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return', 'operationally_complete', 'under_billing', 'billed', 'closed']
  };

  /* ------------------------------------------------------------------
     Role model (mirrors app.*_roles() and set_transaction_status; UI only)
     ------------------------------------------------------------------ */
  // G2: branch_manager is allowed wherever operations_manager is (limited to its
  // branch server-side by has_branch_role).
  var R = {
    staff: ['clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    opsWriter: ['clearance_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    transportWriter: ['clearance_staff', 'transport_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    finance: ['accountant', 'accounts_manager', 'admin'],
    contact: ['clearance_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin'],
    clientLink: ['operations_manager', 'branch_manager', 'supervisor', 'admin'],
    membersRead: ['admin', 'branch_manager', 'supervisor'],
    membersWrite: ['admin', 'branch_manager'],
    orgAdmin: ['admin'],
    auditRead: ['admin', 'supervisor'],
    backward: ['operations_manager', 'branch_manager', 'supervisor', 'admin']
  };
  var STATUS_ROLES = {
    new: R.opsWriter, in_progress: R.opsWriter, customs_declaration: R.opsWriter,
    appointment: R.transportWriter, transport: R.transportWriter, empty_return: R.transportWriter,
    operationally_complete: R.opsWriter, under_billing: R.finance, billed: R.finance,
    closed: ['accounts_manager', 'supervisor', 'admin']
  };
  var ROLE_RANK = ['client', 'clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'];

  var S = {
    ctx: null, orgId: null, orgs: [], memberships: [], roles: [], branches: [], profiles: {},
    // server-side filters of the list views (re-query); offset = first row of the fetched window
    filters: {
      requests: { status: 'new', search: '', offset: 0 },
      transactions: { status: '', branchId: '', search: '', offset: 0 },
      clients: { search: '', inactive: false, offset: 0 },
      messages: { status: 'new', offset: 0 },
      imports: { status: '', search: '', offset: 0 }
    },
    // client-side table state per list view: quick filter, sort column/direction, page
    list: {},
    showVoided: false,
    g2: { audit: { table: '', actor: '', from: '', to: '', rowId: '' }, allInvites: false },
    renderSeq: 0
  };
  var PAGE = 25;      // rows per client-side page
  var WINDOW = 200;   // rows fetched per list view (server filters narrow it further)
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function rolesAt(branchId) {
    return S.memberships.filter(function (m) { return !m.branch_id || m.branch_id === branchId; }).map(function (m) { return m.role; });
  }
  function canAny(set) { return S.roles.some(function (r) { return set.indexOf(r) !== -1; }); }
  function canAt(branchId, set) { return rolesAt(branchId).some(function (r) { return set.indexOf(r) !== -1; }); }
  function branchesFor(set) {
    return S.branches.filter(function (b) { return b.is_active && canAt(b.id, set); });
  }

  /* ------------------------------------------------------------------
     Small utilities
     ------------------------------------------------------------------ */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function lbl(domain, code) {
    if (code == null || code === '') return T.common.none;
    if (isEn()) {
      // English: status_labels.label_en, else the page dictionary, else the Arabic label
      var en = (LABELS_EN[domain] || {})[code];
      if (en) return en;
      var k = 'lbl_' + domain + '_' + code, s = t(k);
      if (s !== k) return s;
    }
    var d = LABELS[domain] || {};
    return d[code] || String(code);
  }
  function opts(domain, selected, withBlank, only) {
    var d = LABELS[domain] || {};
    var keys = only || (ORDER[domain] || Object.keys(d));
    var h = withBlank ? '<option value="">' + esc(withBlank === true ? T.common.all : withBlank) + '</option>' : '';
    keys.forEach(function (k) {
      h += '<option value="' + esc(k) + '"' + (k === selected ? ' selected' : '') + '>' + esc(d[k] || k) + '</option>';
    });
    return h;
  }
  var DATE_LOCALE = 'ar-SA-u-ca-gregory-nu-latn';
  function fmtDate(v) {
    if (!v) return T.common.none;
    var d = new Date(v); if (isNaN(d)) return esc(v);
    try { return d.toLocaleDateString(isEn() ? 'en-GB' : DATE_LOCALE, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function fmtDateTime(v) {
    if (!v) return T.common.none;
    var d = new Date(v); if (isNaN(d)) return esc(v);
    try { return d.toLocaleString(isEn() ? 'en-GB' : DATE_LOCALE, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return d.toISOString().replace('T', ' ').slice(0, 16); }
  }
  function todayISO(offsetDays) {
    var d = new Date(); d.setDate(d.getDate() + (offsetDays || 0));
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function toLocalInput(v) {   // ISO → value for <input type=datetime-local>
    if (!v) return '';
    var d = new Date(v); if (isNaN(d)) return '';
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fromLocalInput(v) { if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  function num(v) { return '<span class="num">' + esc(v == null ? T.common.none : v) + '</span>'; }
  function ltr(v) { return v ? '<bdi dir="ltr" class="num">' + esc(v) + '</bdi>' : T.common.none; }
  function fmtSize(b) {
    if (!b && b !== 0) return T.common.none;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  // feedback goes through the app shell when present (tones: info | success | warning | error)
  function toast(msg, type) {
    if (SH && typeof SH.toast === 'function') { try { SH.toast(msg, type || 'info'); return; } catch (e) { /* fall back */ } }
    if (M.toast) M.toast(msg, type || 'info');
  }
  // askConfirm({title, text, okText, danger}) → Promise<boolean>.
  // While the native <dialog> is open (top layer, page inert) the question is asked
  // inside it; otherwise MarsaShell.confirm, else window.confirm.
  function askConfirm(o) {
    if (dlg && dlg.open) return dialogConfirm(o);
    if (SH && typeof SH.confirm === 'function') {
      return Promise.resolve().then(function () { return SH.confirm(o); }).then(function (v) { return !!v; }, function () { return false; });
    }
    return Promise.resolve(window.confirm(o.text || o.title || ''));
  }
  function errText(e) { return (e && e.message) || (api && api.errorMessage ? api.errorMessage(e) : T.common.none); }
  function nn(v) { v = v == null ? '' : String(v).trim(); return v === '' ? null : v; }
  function icon(name) {
    var p = {
      back: '<path d="M5 12h14M13 6l6 6-6 6"/>',
      refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
      lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
      info: '<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="M12 16v-4M12 8h.01"/>',
      box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
      inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>',
      layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
      chevron: '<path d="m9 18 6-6-6-6"/>',   // points back in RTL; flipped for LTR in CSS
      activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
      arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
      x: '<path d="M6 6l12 12M18 6 6 18"/>'
    }[name] || '';
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">' + p + '</svg>';
  }

  var BADGE = {
    request_status: { new: 'blue', under_review: 'warning', converted: 'success', rejected: 'danger' },
    operational_status: { new: 'blue', in_progress: 'teal', customs_declaration: 'teal', appointment: 'teal', transport: 'teal', empty_return: 'warning', operationally_complete: 'success', under_billing: 'navy', billed: 'navy', closed: 'success' },
    financial_status: { not_started: 'blue', estimate_only: 'blue', draft_pending: 'warning', invoiced: 'navy', settled: 'success' },
    container_return_status: { pending: 'warning', evidence_submitted: 'blue', returned_verified: 'success', disputed: 'danger', waived: 'navy' },
    classification_status: { unreviewed: 'warning', confirmed: 'success', reclassified: 'teal', ambiguous: 'danger' },
    contact_status: { new: 'blue', in_progress: 'warning', closed: 'success' },
    import_row_status: { pending: 'blue', valid: 'success', error: 'danger', duplicate: 'warning', committed: 'navy', skipped: 'blue' },
    batch_status: { draft: 'warning', committed: 'success', cancelled: 'danger' }
  };
  // colour names → tones (chart bars use [data-tone]); badges use the style.css .badge-<colour> classes
  var TONE = { blue: 'info', teal: 'brand', navy: 'neutral', warning: 'warning', danger: 'danger', success: 'success' };
  var BCOL = { info: 'blue', brand: 'teal', neutral: 'navy', muted: 'muted', success: 'success', warning: 'warning', danger: 'danger', blue: 'blue', teal: 'teal', navy: 'navy' };
  function toneOf(domain, code) { return TONE[(BADGE[domain] || {})[code] || 'blue'] || 'info'; }
  function badgeCls(tone) { return 'badge badge-' + (BCOL[tone] || 'blue'); }
  function pillHtml(tone, text) { return '<span class="' + badgeCls(tone) + '">' + esc(text) + '</span>'; }
  function badge(domain, code) { return pillHtml(toneOf(domain, code), lbl(domain, code)); }
  function pillNode(tone, text) { return el('span', { class: badgeCls(tone), text: text }); }
  function badgeNode(domain, code) { return pillNode(toneOf(domain, code), lbl(domain, code)); }
  function kv(rows) {
    return '<ul class="kv">' + rows.filter(Boolean).map(function (r) {
      return '<li><span class="k">' + esc(r[0]) + '</span><span class="v">' + (r[2] ? r[1] : esc(r[1] == null || r[1] === '' ? T.common.none : r[1])) + '</span></li>';
    }).join('') + '</ul>';
  }
  function alertBox(type, text, html) {
    return '<div class="alert alert-' + type + '" role="' + (type === 'danger' ? 'alert' : 'status') + '">' + icon('info') + '<div>' + (html ? text : esc(text)) + '</div></div>';
  }
  function emptyRow(cols, text) { return '<tr><td colspan="' + cols + '" class="adm-empty">' + esc(text || T.common.empty) + '</td></tr>'; }
  function loadingBox() { return '<div class="adm-loading" role="status"><span class="adm-spinner" aria-hidden="true"></span>' + esc(tx2('loading', T.common.loading)) + '</div>'; }
  // translated string with an Arabic fallback when the key is missing
  function tx2(k, fallback) { var s = t(k); return s === k ? fallback : s; }

  /* ------------------------------------------------------------------
     LOCAL API GAPS — queries MarsaApi does not expose (yet).
     Same contract: Promise<{data, error, count}>, never throws.
     ------------------------------------------------------------------ */
  function local(fn) {
    return api.ready().then(function (r) {
      if (r.error || !api.client) return { data: null, error: r.error || { message: T.gate.errorTitle } };
      var p;
      try { p = fn(api.client); } catch (e) { return { data: null, error: { message: errText(e) } }; }
      return Promise.resolve(p).then(function (res) {
        if (res && res.error) return { data: null, error: { code: res.error.code, message: api.errorMessage(res.error), raw: res.error }, count: res.count };
        return { data: res ? res.data : null, error: null, count: res ? res.count : undefined };
      }, function (e) { return { data: null, error: { message: api.errorMessage(e), raw: e } }; });
    });
  }
  // G2: scoped to the active org (RLS alone would mix every org the user belongs to)
  function inOrg(q) { return S.orgId ? q.eq('org_id', S.orgId) : q; }
  var L = {
    count: function (table, build) {
      return local(function (c) { var q = inOrg(c.from(table).select('id', { count: 'exact', head: true })); return build ? build(q) : q; })
        .then(function (r) { return r.error ? r : { data: r.count || 0, error: null }; });
    },
    // open containers with the nearest return deadlines (overdue first)
    containersNext: function (n) {
      return local(function (c) {
        return inOrg(c.from('containers').select('id,container_no,return_deadline,return_status,transaction_id,transactions(ref)'))
          .in('return_status', ['pending', 'evidence_submitted', 'disputed']).not('return_deadline', 'is', null)
          .order('return_deadline').limit(n || 6);
      });
    },
    // latest transaction events of the active org (dashboard "recent activity")
    recentEvents: function (n) {
      return local(function (c) {
        return inOrg(c.from('transaction_events').select('id,event_type,from_status,to_status,payload,actor,created_at,transaction_id,transactions(ref)'))
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(n || 8);
      });
    },
    listImportBatches: function (o) {
      return local(function (c) {
        var q = inOrg(c.from('import_batches').select('id,ref,client_id,file_name,file_size,sheet_names,status,total_rows,committed_rows,skipped_rows,created_by,created_at,committed_at,clients(name_ar)', { count: 'exact' }))
          .order('created_at', { ascending: false });
        if (o.status) q = q.eq('status', o.status);
        if (o.search) { var s = String(o.search).replace(/[%_,()\\]/g, ' ').trim().slice(0, 60); if (s) q = q.or('ref.ilike.%' + s + '%,file_name.ilike.%' + s + '%'); }
        var off = Math.max(o.offset || 0, 0);
        return q.range(off, off + WINDOW - 1);
      });
    },
    getImportBatch: function (id) {
      return local(function (c) { return c.from('import_batches').select('*,clients(name_ar)').eq('id', id).maybeSingle(); });
    },
    txForRequest: function (reqId) {
      return local(function (c) { return c.from('transactions').select('id,ref').eq('request_id', reqId).maybeSingle(); });
    },
    requestRef: function (reqId) {
      return local(function (c) { return c.from('service_requests').select('id,ref').eq('id', reqId).maybeSingle(); });
    },
    profiles: function (ids) {
      ids = ids.filter(function (id) { return id && UUID_RE.test(id) && !S.profiles[id]; });
      if (!ids.length) return Promise.resolve({ data: [], error: null });
      return local(function (c) { return c.from('profiles').select('id,full_name').in('id', ids.slice(0, 100)); })
        .then(function (r) { (r.data || []).forEach(function (p) { S.profiles[p.id] = p.full_name || ''; }); return r; });
    },
    // admin RPCs from supabase/migrations/20261031000650_admin_rpcs.sql
    // (admin_add_member is SQL-Editor only since G2; the UI invites instead.)
    adminListMembers: function (orgId) {
      if (typeof api.listMembers === 'function') return api.listMembers(orgId);   // G2 supa.js wrapper
      return local(function (c) { return c.rpc('admin_list_members', { p_org: orgId }); });
    },
    getOrgRow: function (orgId) {
      return local(function (c) {
        return c.from('organizations').select('id,slug,name_ar,name_en,ref_prefix,environment,public_intake_enabled,default_locale,settings,is_active')
          .eq('id', orgId).maybeSingle();
      });
    }
  };
  function who(id) {
    if (!id) return t('who_system');
    if (S.ctx && id === S.ctx.user_id) return t('you');
    var n = S.profiles[id];
    return n ? n : t('who_user', { id: String(id).slice(0, 8) });
  }

  /* ------------------------------------------------------------------
     Dialog helper (native <dialog>)
     ------------------------------------------------------------------ */
  var dlg = document.getElementById('adm-dialog');
  var dlgForm = document.getElementById('adm-dialog-form');
  var dlgTitle = document.getElementById('adm-dialog-title');
  var dlgBody = document.getElementById('adm-dialog-body');
  var dlgErr = document.getElementById('adm-dialog-error');
  var dlgSubmit = document.getElementById('adm-dialog-submit');
  var dlgHandler = null, dlgBusy = false, dlgReturnFocus = null;

  function openDialog(o) {
    dropDialogConfirm(false);
    dlgTitle.textContent = o.title;
    dlgBody.innerHTML = o.body;
    dlgErr.hidden = true; dlgErr.textContent = '';
    dlgSubmit.textContent = o.submit || T.common.save;
    dlgSubmit.className = 'btn ' + (o.danger ? 'btn-danger adm-btn-danger' : 'btn-primary');
    dlgSubmit.hidden = !!o.noSubmit;
    dlgHandler = o.onSubmit || null;
    dlg.classList.toggle('adm-dialog-wide', !!o.wide);
    dlgReturnFocus = document.activeElement;
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
    if (o.onOpen) o.onOpen(dlgBody);
    var first = dlgBody.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
    if (first) setTimeout(function () { first.focus(); }, 30);
  }
  function closeDialog() {
    dropDialogConfirm(false);
    if (typeof dlg.close === 'function' && dlg.open) dlg.close(); else dlg.removeAttribute('open');
    dlgHandler = null; dlgBody.innerHTML = '';
    if (dlgReturnFocus && dlgReturnFocus.focus && document.contains(dlgReturnFocus)) dlgReturnFocus.focus();
  }
  function dialogError(msg) { dlgErr.textContent = msg; dlgErr.hidden = false; }
  // in-dialog confirmation strip (the shell's modal cannot sit above a modal <dialog>)
  var dlgAsk = null;
  function dropDialogConfirm(answer) {
    if (!dlgAsk) return;
    var a = dlgAsk; dlgAsk = null;
    if (a.node.parentNode) a.node.parentNode.removeChild(a.node);
    var foot = dlgForm.querySelector('.adm-dialog-foot'); if (foot) foot.hidden = false;
    a.resolve(!!answer);
  }
  function dialogConfirm(o) {
    dropDialogConfirm(false);
    return new Promise(function (resolve) {
      var ok = el('button', { class: 'btn btn-sm ' + (o.danger ? 'btn-danger adm-btn-danger' : 'btn-primary'), type: 'button', text: o.okText || T.common.confirm });
      var no = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: t('cancel') });
      var node = el('div', { class: 'adm-dlg-confirm', role: 'alertdialog', 'aria-live': 'assertive' }, [
        svgIcon('alert'),
        el('div', { class: 'adm-dlg-confirm-text' }, [o.title ? el('strong', { text: o.title }) : null, o.text ? el('p', { text: o.text }) : null]),
        el('div', { class: 'adm-dlg-confirm-actions' }, [no, ok])
      ]);
      ok.addEventListener('click', function () { dropDialogConfirm(true); });
      no.addEventListener('click', function () { dropDialogConfirm(false); });
      var foot = dlgForm.querySelector('.adm-dialog-foot');
      dlgForm.insertBefore(node, foot);
      if (foot) foot.hidden = true;
      dlgAsk = { node: node, resolve: resolve };
      setTimeout(function () { ok.focus(); }, 30);
    });
  }
  if (dlg) {
    dlgForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!dlgHandler || dlgBusy) return;
      dlgErr.hidden = true;
      dlgBusy = true; dlgSubmit.disabled = true;
      Promise.resolve().then(function () { return dlgHandler(dlgForm); }).then(function (res) {
        dlgBusy = false; dlgSubmit.disabled = false;
        if (res === true) closeDialog();
        else if (typeof res === 'string') dialogError(res);
      }, function (err) { dlgBusy = false; dlgSubmit.disabled = false; dialogError(errText(err)); });
    });
    dlg.addEventListener('click', function (e) {
      if (e.target.closest('[data-dialog-cancel]')) { e.preventDefault(); if (!dlgBusy) closeDialog(); }
    });
    dlg.addEventListener('cancel', function (e) { if (dlgBusy) e.preventDefault(); else { e.preventDefault(); closeDialog(); } });
  }
  function fval(form, name) { var el = form.elements[name]; return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; }
  function field(o) {
    // o: {name, label, type, value, req, hint, options(html), attrs, full, rows, ltr}
    var id = 'adf-' + o.name;
    var attrs = (o.attrs || '') + (o.req ? ' required' : '') + (o.ltr ? ' dir="ltr"' : '');
    var ctl;
    if (o.type === 'select') ctl = '<select class="form-control" id="' + id + '" name="' + o.name + '"' + attrs + '>' + o.options + '</select>';
    else if (o.type === 'textarea') ctl = '<textarea class="form-control" id="' + id + '" name="' + o.name + '" rows="' + (o.rows || 3) + '"' + attrs + '>' + esc(o.value) + '</textarea>';
    else if (o.type === 'checkbox') return '<div class="form-group' + (o.full ? ' adm-full' : '') + '"><label class="check"><input type="checkbox" id="' + id + '" name="' + o.name + '"' + (o.value ? ' checked' : '') + attrs + '> ' + esc(o.label) + '</label></div>';
    else ctl = '<input class="form-control" id="' + id + '" name="' + o.name + '" type="' + (o.type || 'text') + '" value="' + esc(o.value) + '"' + attrs + '>';
    return '<div class="form-group' + (o.full ? ' adm-full' : '') + '"><label class="form-label" for="' + id + '">' + esc(o.label) +
      (o.req ? ' <span class="req" aria-hidden="true">*</span>' : '') + '</label>' + ctl +
      (o.hint ? '<span class="form-hint">' + esc(o.hint) + '</span>' : '') + '</div>';
  }
  function grid(html) { return '<div class="adm-form-grid">' + html + '</div>'; }

  /* ------------------------------------------------------------------
     Gate (auth + role guard)
     ------------------------------------------------------------------ */
  function showGate(kind, extra) {
    app.hidden = true; gate.hidden = false;
    var title, text, actions = '', ico = 'lock';
    if (kind === 'demo') {
      title = T.gate.demoTitle; text = api && api.isMisconfigured && api.isMisconfigured() ? T.gate.misconfigured : T.gate.demo;
      actions = '<a class="btn btn-primary" href="index.html">' + esc(t('gate_home')) + '</a>'; ico = 'info';
    } else if (kind === 'signin') {
      title = T.gate.signInTitle; text = T.gate.signIn;
      actions = '<a class="btn btn-primary" href="login.html#staff">' + esc(t('gate_signin_btn')) + '</a>';
    } else if (kind === 'forbidden') {
      title = T.gate.forbiddenTitle; text = T.gate.forbidden;
      actions = '<button class="btn btn-secondary" type="button" data-gate="signout">' + esc(t('signout')) + '</button>';
    } else if (kind === 'loading') {
      gateBody.innerHTML = '<div class="adm-loading" role="status"><span class="adm-spinner" aria-hidden="true"></span>' + esc(t('gate_checking')) + '</div>';
      return;
    } else {
      title = T.gate.errorTitle; text = extra || ''; ico = 'alert';
      actions = '<button class="btn btn-primary" type="button" data-gate="retry">' + esc(t('gate_retry')) + '</button>';
    }
    if (isEn()) { var k = 'gate_' + kind + '_title', k2 = 'gate_' + kind + '_text'; if (t(k) !== k) title = t(k); if (kind !== 'error' && t(k2) !== k2) text = t(k2); }
    gateBody.innerHTML = '<span class="icon-box icon-box-lg icon-box-soft">' + icon(ico) + '</span>' +
      '<h2>' + esc(title) + '</h2><p class="text-muted">' + esc(text) + '</p><div class="btn-group adm-gate-actions">' + actions + '</div>';
    setPageTitle(t('page_title'), null);
  }
  gate.addEventListener('click', function (e) {
    var b = e.target.closest('[data-gate]');
    if (!b) return;
    if (b.getAttribute('data-gate') === 'retry') boot(false);
    if (b.getAttribute('data-gate') === 'signout') signOut();
  });

  function signOut() {
    api.signOut().then(function () { location.href = 'login.html#staff'; });
  }
  // revokes the refresh tokens of every device (other devices end within their access-token lifetime)
  function signOutAll() {
    var b = document.getElementById('adm-signout-all');
    askConfirm({ title: t('signout_all'), text: tx2('signout_all_confirm', 'سيُنهى الدخول على كل الأجهزة المسجّلة بهذا الحساب. هل تريد المتابعة؟'), okText: t('signout_all'), danger: true }).then(function (ok) {
      if (!ok) return;
      if (b) b.disabled = true;
      api.signOutEverywhere().then(function (r) {
        if (b) b.disabled = false;
        if (r && r.error) return toast(errText(r.error), 'error');
        location.href = 'login.html#staff';
      });
    });
  }

  // MarsaShell.ready → my_context data, or null (signed out / demo). Tolerates a {data,error} value.
  function shellReady() {
    if (!SH || !SH.ready) return Promise.resolve(undefined);
    var p;
    try { p = typeof SH.ready === 'function' ? SH.ready() : SH.ready; } catch (e) { return Promise.resolve(undefined); }
    return Promise.resolve(p).then(function (v) {
      return v && typeof v === 'object' && ('error' in v) && ('data' in v) ? (v.error ? undefined : v.data) : v;
    }, function () { return undefined; });
  }
  function boot(useShell) {
    if (!api || !api.isOnline || !api.isOnline()) { showGate('demo'); return; }
    showGate('loading');
    (useShell ? shellReady() : Promise.resolve(undefined)).then(function (shellCtx) {
      if (shellCtx && typeof shellCtx === 'object') return withContext(shellCtx);
      // no shell (or it found no session): the page's own session check decides which gate to show
      return api.getSession().then(function (r) {
        if (r.error) return showGate('error', errText(r.error));
        if (!r.data) return showGate('signin');
        return api.myContext(true).then(function (c) {
          if (c.error) return showGate(c.error.code === 'MRS_AUTH_REQUIRED' ? 'signin' : 'error', errText(c.error));
          return withContext(c.data || {});
        });
      });
    }).then(null, function (e) { showGate('error', errText(e)); });
  }
  function withContext(ctx) {
    S.ctx = ctx || {};
    S.orgs = staffOrgs(S.ctx);
    if (!S.orgs.length) { showGate('forbidden'); return Promise.resolve(); }
    return readActiveOrg().then(function (want) {
      // active org: the stored choice when it is a staff org, else the configured slug, else the first
      var pick = S.orgs.filter(function (o) { return o.org_id === want; })[0] ||
        S.orgs.filter(function (o) { return o.slug === api.orgSlug; })[0] || S.orgs[0];
      S.orgId = pick.org_id;
      // the stored org is not a staff org here (e.g. a client-only membership): store the pick so the
      // shell (header, nav roles, palette search) and the other pages follow the same org. The
      // 'marsa:orgchange' it fires is ignored below because S.orgId already matches.
      if (want && want !== pick.org_id && typeof api.setActiveOrg === 'function') {
        Promise.resolve(api.setActiveOrg(pick.org_id)).then(null, function () { /* the shell keeps its own pick */ });
      }
      S.memberships = (S.ctx.memberships || []).filter(function (m) { return m.org_id === S.orgId && R.staff.indexOf(m.role) !== -1; });
      S.roles = S.memberships.map(function (m) { return m.role; }).filter(function (r, i, a) { return a.indexOf(r) === i; });
      S.roles.sort(function (a, b) { return ROLE_RANK.indexOf(b) - ROLE_RANK.indexOf(a); });
      return Promise.all([api.listBranches(S.orgId), loadLabels()]).then(function (res) {
        S.branches = (res[0].data || []).filter(function (b) { return b.org_id === S.orgId; });
        startApp();
      });
    });
  }
  // distinct orgs where the user holds an active staff role (my_context memberships)
  function staffOrgs(ctx) {
    var map = {}, list = [];
    (ctx.memberships || []).forEach(function (m) {
      if (R.staff.indexOf(m.role) === -1 || !m.org_id) return;
      if (!map[m.org_id]) { map[m.org_id] = { org_id: m.org_id, slug: m.org_slug, name_ar: m.org_name_ar, name_en: m.org_name_en }; list.push(map[m.org_id]); }
    });
    // G2 my_context().organizations may carry fresher names; memberships stay the source of roles
    (Array.isArray(ctx.organizations) ? ctx.organizations : []).forEach(function (o) {
      var x = o && map[o.org_id];
      if (x) { x.name_ar = o.name_ar || x.name_ar; x.name_en = o.name_en || x.name_en; }
    });
    return list;
  }
  function readActiveOrg() {
    if (api && typeof api.activeOrgId === 'function') {
      return Promise.resolve().then(function () { return api.activeOrgId(); }).then(function (v) {
        if (v && typeof v === 'object') v = v.data;             // tolerate a {data,error} result
        return typeof v === 'string' ? v : null;
      }, function () { return null; });
    }
    try { return Promise.resolve(localStorage.getItem('marsa_active_org')); } catch (e) { return Promise.resolve(null); }
  }
  function loadLabels() {
    var domains = ['operational_status', 'financial_status', 'request_status', 'container_return_status', 'document_kind', 'classification_status', 'contact_status', 'import_row_status', 'role'];
    return Promise.all(domains.map(function (d) { return api.statusLabels(d); })).then(function (res) {
      res.forEach(function (r, i) {
        if (r.error || !r.data || !r.data.length) return;
        var map = {}, en = {}, order = [];
        r.data.forEach(function (x) { map[x.code] = x.label_ar; if (x.label_en) en[x.code] = x.label_en; order.push(x.code); });
        LABELS[domains[i]] = map;
        LABELS_EN[domains[i]] = en;
        ORDER[domains[i]] = order;
      });
    });
  }

  // Source of truth for the sections and who sees them (the shell's NAV mirrors these sets).
  var VIEWS = [
    { id: 'dashboard', allow: R.staff },
    { id: 'requests', allow: R.opsWriter },
    { id: 'transactions', allow: R.staff },
    { id: 'clients', allow: R.staff },
    { id: 'messages', allow: R.contact },
    { id: 'imports', allow: R.opsWriter },
    { id: 'org', allow: R.orgAdmin },
    { id: 'branches', allow: R.orgAdmin },
    { id: 'members', allow: R.membersRead },
    { id: 'audit', allow: R.auditRead },
    { id: 'errors', allow: R.orgAdmin }
  ];
  /* ------------------------------------------------------------------
     G3 module hook — assets/js/ops/*.js load before admin.js and register
       MarsaOps.views.<id>  = { allow: 'staff'|'opsWriter'|'transportWriter'|'orgAdmin'|'finance' (or a role list),
                                titleKey, render(root, opsApi, param) }   → route #<id> / #<id>/<param>
       MarsaOps.txSections  = [{ id, order, render(root, tx, opsApi) }] → inside #tx/<id>, after admin.js' own cards
     The hook is read on every route, so a module that registers late still shows up.
     ------------------------------------------------------------------ */
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  var OPS_SETS = ['staff', 'opsWriter', 'transportWriter', 'orgAdmin', 'finance'];
  function opsRoleSet(allow) {
    if (Array.isArray(allow)) return allow;
    return OPS_SETS.indexOf(allow) !== -1 ? R[allow] : R.staff;
  }
  function opsView(id) {
    var v = OPS.views && Object.prototype.hasOwnProperty.call(OPS.views, id) ? OPS.views[id] : null;
    return v && typeof v.render === 'function' && /^[a-z][a-z0-9_-]{0,30}$/.test(id) ? v : null;
  }
  function opsViewList() {
    var builtIn = VIEWS.map(function (v) { return v.id; }).concat(Object.keys(DETAIL));
    return Object.keys(OPS.views || {}).filter(function (id) { return builtIn.indexOf(id) === -1 && opsView(id); })
      .map(function (id) { return { id: id, allow: opsRoleSet(OPS.views[id].allow), ops: OPS.views[id] }; });
  }
  function allowedViews() { return VIEWS.concat(opsViewList()).filter(function (v) { return canAny(v.allow); }); }
  // what the modules get (one object per render; S may change on an org switch)
  function opsApi() {
    var I = window.MarsaI18n;
    return {
      orgId: S.orgId, roles: S.roles.slice(), branches: S.branches.slice(), userId: S.ctx ? S.ctx.user_id : null,
      // can('opsWriter') · can('transportWriter', tx.branch_id) · can(['admin', 'supervisor'], branchId)
      can: function (set, branchId) {
        var roles = Array.isArray(set) ? set : R[set];
        if (!roles) return false;
        return branchId ? canAt(branchId, roles) : canAny(roles);
      },
      t: function (key, vars) { return I && typeof I.t === 'function' ? I.t(key, vars) : key; },
      el: el, toast: toast, confirm: askConfirm, modal: opsModal, go: go, refresh: rerender,
      MarsaApi: api, label: opsLabel, fmtDate: fmtWhen, fmtMoney: fmtMoney, fmtNumber: fmtCount,
      who: who, isEn: isEn, errText: apiErr, newIdemKey: newKey
    };
  }
  // status_labels / admin dictionaries first, then 'label.<domain>.<code>' (MarsaI18n.label) and the ops dictionaries
  function opsLabel(domain, code) {
    if (code == null || code === '') return T.common.none;
    if (LABELS[domain] && LABELS[domain][code] != null) return lbl(domain, code);
    var I = window.MarsaI18n, keys = ['label.' + domain + '.' + code, 'ops.' + domain + '_' + code, 'opstx.lbl_' + domain + '_' + code];
    if (I && typeof I.t === 'function') {
      for (var i = 0; i < keys.length; i++) { var s = I.t(keys[i]); if (s && s !== keys[i]) return s; }
    }
    return String(code);
  }
  function fmtMoney(n, currency) {
    if (n == null || n === '') return T.common.none;
    var I = window.MarsaI18n;
    if (I && typeof I.fmtMoney === 'function') { try { return I.fmtMoney(+n, currency || 'SAR'); } catch (e) { /* plain */ } }
    return (+n).toFixed(2) + ' ' + (currency || 'SAR');
  }
  // modal({ title, body: Node | Node[] | fn(bodyEl) → Node(s), submitText, danger, wide, noSubmit,
  //         onSubmit(form, bodyEl) → true (close) | 'error text' | Promise of those, onOpen(bodyEl) })
  // Uses the page's native <dialog>; form fields are read through form.elements[name].
  function opsModal(o) {
    o = o || {};
    openDialog({
      title: o.title || '', body: '', submit: o.submitText || o.submit || o.okText, danger: !!o.danger, wide: !!o.wide, noSubmit: !!o.noSubmit,
      onSubmit: o.onSubmit ? function (form) { return o.onSubmit(form, dlgBody); } : null,
      onOpen: function (b) {
        var kids = typeof o.body === 'function' ? o.body(b) : o.body;
        if (kids) append(b, kids);
        if (o.onOpen) o.onOpen(b);
      }
    });
    return { close: closeDialog, body: dlgBody, error: dialogError };
  }
  // a registered view: the module fills root (sync or async); a throw shows inside the view.
  // root is returned (and attached) at once, not after the module's promise: the views paint async
  // results only while root is connected (MarsaOps.ui scope), so waiting would leave them loading.
  function renderOpsView(id, param) {
    var def = opsView(id), root = el('div', { class: 'ops-view', 'data-ops-view': id });
    if (!def) return root;
    try {
      var p = def.render(root, opsApi(), param || null);
      if (p && typeof p.then === 'function') p.then(null, function (e) { root.appendChild(dAlert('danger', errText(e))); });
    } catch (e) { root.appendChild(dAlert('danger', errText(e))); }
    return root;
  }
  // transaction detail sections, sorted by order; each fails on its own
  function renderTxSections(host, tx) {
    var list = (Array.isArray(OPS.txSections) ? OPS.txSections : []).filter(function (s) { return s && typeof s.render === 'function'; })
      .slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    var seen = {};
    list.forEach(function (s) {
      if (s.id && seen[s.id]) return;   // a module loaded twice
      if (s.id) seen[s.id] = true;
      var box = el('div', { class: 'ops-tx-section', 'data-section': s.id || null });
      host.appendChild(box);
      try {
        var p = s.render(box, tx, opsApi());
        if (p && typeof p.then === 'function') p.then(null, function (e) { box.appendChild(dAlert('danger', errText(e))); });
      } catch (e) { box.appendChild(dAlert('danger', errText(e))); }
    });
  }

  function startApp() {
    gate.hidden = true; app.hidden = false;
    fillMe();
    buildNav();
    fillOrgSwitch();
    if (window.MarsaI18n && typeof window.MarsaI18n.apply === 'function') { try { window.MarsaI18n.apply(app); } catch (e) { /* static Arabic stays */ } }
    route();
  }
  // .adm-topbar: name + roles per branch (my_context profile / memberships of the active org)
  function fillMe() {
    var p = (S.ctx && S.ctx.profile) || {};
    var nameEl = document.getElementById('adm-me-name'), rolesEl = document.getElementById('adm-me-roles');
    if (nameEl) nameEl.textContent = p.full_name || tx2('me_staff', 'موظف');
    if (rolesEl) rolesEl.textContent = S.memberships.map(function (m) {
      var b = m.branch_id ? (branchName(m.branch_id) || m.branch_name_ar || t('branch_specific')) : t('all_branches');
      return roleLabel(m.role) + ' — ' + b;
    }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(isEn() ? ', ' : '، ');
  }
  // In-page section nav (original pill bar): the admin views this role may open (VIEWS + G3 module
  // views), then the staff pages elsewhere (bulk upload, OCR, platform) from MarsaShell.navItems().
  // Each link carries data-nav-id so MarsaShell.setActive / setBadge('alerts') find it.
  var NAV_EXTERNAL = ['bulk', 'ocr', 'platform'];
  // daily work → G3 operations → management (unknown module views go last, stable)
  var NAV_ORDER = ['dashboard', 'requests', 'transactions', 'clients', 'messages', 'imports', 'alerts', 'schedule', 'exceptions', 'parties',
    'org', 'branches', 'members', 'requirements', 'audit', 'errors'];
  function buildNav() {
    if (!nav) return;
    nav.textContent = '';
    var rank = function (v) { var i = NAV_ORDER.indexOf(v.id); return i === -1 ? NAV_ORDER.length : i; };
    allowedViews().slice().sort(function (a, b) { return rank(a) - rank(b); }).forEach(function (v) {
      nav.appendChild(el('li', null, el('a', { class: 'adm-nav-link', href: '#' + v.id, 'data-view': v.id, 'data-nav-id': v.id, text: viewLabel(v.id) })));
    });
    var items = [];
    if (SH && typeof SH.navItems === 'function') { try { items = SH.navItems() || []; } catch (e) { items = []; } }
    items.filter(function (n) { return n && !n.local && NAV_EXTERNAL.indexOf(n.id) !== -1 && /^[a-z-]+\.html$/.test(n.page || ''); }).forEach(function (n) {
      nav.appendChild(el('li', { class: 'adm-nav-ext' }, el('a', { class: 'adm-nav-link', href: n.href, 'data-nav-id': n.id, text: n.label })));
    });
    if (SH && typeof SH.setBadge === 'function') { try { SH.setBadge('alerts'); } catch (e) { /* helper optional */ } }
  }
  var orgWrap = document.getElementById('adm-org-switch-wrap');
  var orgSel = document.getElementById('adm-org-switch');
  function orgName(o) { return (isEn() && o.name_en) || o.name_ar || o.slug || String(o.org_id).slice(0, 8); }
  function fillOrgSwitch() {
    if (!orgWrap || !orgSel) return;
    orgSel.textContent = '';
    S.orgs.forEach(function (o) { orgSel.appendChild(el('option', { value: o.org_id, text: orgName(o) })); });
    orgSel.value = S.orgId || '';
    orgWrap.hidden = S.orgs.length < 2;
  }
  // MarsaApi.setActiveOrg stores the org and fires 'marsa:orgchange' (handled below: reload this org)
  function switchOrg(id) {
    if (!id || id === S.orgId || !UUID_RE.test(id)) return;
    orgSel.disabled = true;
    var viaApi = api && typeof api.setActiveOrg === 'function';
    var p = viaApi
      ? Promise.resolve().then(function () { return api.setActiveOrg(id); })
      : Promise.resolve((function () { try { localStorage.setItem('marsa_active_org', id); } catch (e) { /* private mode */ } return null; })());
    p.then(function (r) {
      orgSel.disabled = false;
      if (r && r.error) { orgSel.value = S.orgId; return toast(apiErr(r.error), 'error'); }
      // an older supa.js without the event: switch here
      if (S.orgId !== id && orgPending !== id) onOrgChange(id);
    }, function (e) { orgSel.disabled = false; orgSel.value = S.orgId; toast(errText(e), 'error'); });
  }
  if (orgSel) orgSel.addEventListener('change', function () { switchOrg(orgSel.value); });
  var soBtn = document.getElementById('adm-signout');
  if (soBtn) soBtn.addEventListener('click', signOut);
  var soAll = document.getElementById('adm-signout-all');
  if (soAll) soAll.addEventListener('click', signOutAll);
  var refBtn = document.getElementById('adm-refresh');
  if (refBtn) refBtn.addEventListener('click', function () { route(true); });
  window.addEventListener('hashchange', function () { if (!app.hidden) route(false); });
  if (api && api.onAuth) {
    api.onAuth(function (event) { if (event === 'SIGNED_OUT') { S.ctx = null; showGate('signin'); } });
  }

  /* ------------------------------------------------------------------
     Shell integration: title / breadcrumb / active nav item
     ------------------------------------------------------------------ */
  function setPageTitle(title, parentId) {
    var crumbs = [{ label: t('page_title'), href: '#dashboard' }];
    if (parentId && parentId !== 'dashboard') crumbs.push({ label: viewLabel(parentId), href: '#' + parentId });
    if (title !== t('page_title')) crumbs.push({ label: title });
    if (SH && typeof SH.setTitle === 'function') { try { SH.setTitle(title, crumbs); return; } catch (e) { /* helper optional */ } }
    document.title = title + ' | ' + t('doc_title_suffix');
  }
  function setNav(id) {
    if (SH && typeof SH.setActive === 'function') { try { SH.setActive(id); } catch (e) { /* helper optional */ } }
    if (!nav) return;
    Array.prototype.forEach.call(nav.querySelectorAll('[data-nav-id]'), function (a) {
      var on = a.getAttribute('data-nav-id') === id;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    // keep the active pill in view on narrow screens (the bar scrolls sideways)
    var cur = nav.querySelector('.adm-nav-link.is-active');
    if (cur && typeof cur.scrollIntoView === 'function' && nav.parentNode && nav.parentNode.scrollWidth > nav.parentNode.clientWidth) {
      try { cur.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* old browsers */ }
    }
  }

  /* ------------------------------------------------------------------
     Router: #view[?status=…]  |  #request/<id> #tx/<id> #client/<id> #import/<id>
     A ?query (from dashboard tiles) sets the view's server filters once,
     then the hash is normalised to #view.
     ------------------------------------------------------------------ */
  var DETAIL = { request: 'requests', tx: 'transactions', client: 'clients', import: 'imports' };
  var ROUTE_FILTERS = { requests: ['status'], transactions: ['status', 'branchId'], messages: ['status'], imports: ['status'] };
  function parseHash() {
    var h = (location.hash || '').replace(/^#/, ''), q = '';
    var qi = h.indexOf('?');
    if (qi !== -1) { q = h.slice(qi + 1); h = h.slice(0, qi); }
    var parts = h.split('/');
    return { name: parts[0] || 'dashboard', id: parts[1] || null, query: q };
  }
  function applyQuery(name, q) {
    var keys = ROUTE_FILTERS[name];
    if (!q || !keys) return;
    var f = S.filters[name];
    q.split('&').forEach(function (pair) {
      var i = pair.indexOf('='), k, v;
      try { k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i)); v = decodeURIComponent(i === -1 ? '' : pair.slice(i + 1)); } catch (e) { return; }
      if (keys.indexOf(k) === -1) return;
      if (k === 'branchId' && v && !UUID_RE.test(v)) return;
      if (k === 'status' && v && !/^[a-z_]{1,40}$/.test(v)) return;
      f[k] = v;
    });
    f.search = ''; f.offset = 0;
    listState(name).page = 0; listState(name).q = '';
  }
  function route(keepDialog) {
    if (!keepDialog && dlg && dlg.open) closeDialog();
    var r = parseHash(), name = r.name, id = r.id;
    var parent = DETAIL[name] || name;
    var allowed = allowedViews().map(function (v) { return v.id; });
    if (allowed.indexOf(parent) === -1 || (DETAIL[name] && !(id && UUID_RE.test(id)))) { name = 'dashboard'; parent = 'dashboard'; id = null; }
    else if (r.query) {
      applyQuery(name, r.query);
      try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    }
    setNav(parent);
    setPageTitle(viewLabel(parent), null);
    var seq = ++S.renderSeq;
    view.setAttribute('aria-busy', 'true');
    view.innerHTML = loadingBox();
    if (!keepDialog) { try { window.scrollTo(0, 0); } catch (e) { /* ignore */ } }
    var fn = {
      dashboard: renderDashboard, requests: renderRequests, request: renderRequest, transactions: renderTransactions,
      tx: renderTx, clients: renderClients, client: renderClient, messages: renderMessages, imports: renderImports,
      import: renderImport, members: renderMembers,
      org: renderOrg, branches: renderBranches, audit: renderAudit, errors: renderErrors
    }[name];
    // G3 module views (#alerts, #schedule, …): the optional param is a short token, never markup
    if (!fn && opsView(name)) {
      var param = id && /^[A-Za-z0-9_.:@-]{1,80}$/.test(id) ? id : null;
      fn = function () { return renderOpsView(name, param); };
    }
    Promise.resolve(fn(id)).then(function (html) {
      if (seq !== S.renderSeq) return;            // a newer navigation won
      if (html && html.nodeType) { view.textContent = ''; view.appendChild(html); }   // DOM views
      else view.innerHTML = html;
      view.removeAttribute('aria-busy');
      // detail views: the rendered heading (e.g. the reference) becomes the shell title
      var h = view.querySelector('.adm-title');
      if (DETAIL[name] && h) setPageTitle(h.textContent.trim(), parent);
    }, function (e) {
      if (seq !== S.renderSeq) return;
      view.removeAttribute('aria-busy');
      view.innerHTML = alertBox('danger', errText(e));
    });
  }
  function rerender() { route(true); }   // keeps an open result dialog (e.g. a one-time token)
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  // view header (original .adm-head): optional back link (to the parent list), title (trusted HTML), subtitle, actions
  function head(title, sub, actions, backHash) {
    var back = backHash ? '<a class="btn btn-sm btn-ghost adm-back" href="' + esc(backHash) + '">' + icon('back') + esc(tx2('back', T.common.back)) + '</a>' : '';
    return '<div class="adm-head">' +
      '<div class="adm-head-title">' + back +
      '<div><h2 class="adm-title">' + title + '</h2>' + (sub ? '<p class="text-sm text-muted">' + sub + '</p>' : '') + '</div></div>' +
      (actions ? '<div class="btn-group adm-head-actions">' + actions + '</div>' : '') + '</div>';
  }
  function card(title, body, actions, cls) {
    return '<div class="card card-flush adm-card' + (cls ? ' ' + cls : '') + '"><div class="card-header"><h3>' + title + '</h3>' +
      (actions ? '<div class="btn-group">' + actions + '</div>' : '') + '</div><div class="card-body">' + body + '</div></div>';
  }
  function table(headers, rows, cols) {
    return '<div class="table-wrap"><table class="table table-striped adm-table"><thead><tr>' +
      headers.map(function (h) { return '<th scope="col">' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      (rows.length ? rows.join('') : emptyRow(cols || headers.length)) + '</tbody></table></div>';
  }

  /* ------------------------------------------------------------------
     List views: toolbar (quick filter + server filters) → sortable,
     paginated .table. Built with DOM nodes (textContent only).
     cfg = { key, rows, total, error, columns:[{id,label,value(row),cell(row),num,desc}],
             href(row) | open(row), text(row), tools:[nodes], placeholder, empty,
             serverSearch (Enter searches every record on the server) }
     ------------------------------------------------------------------ */
  function listState(key) { return S.list[key] || (S.list[key] = { q: '', sort: null, dir: 1, page: 0 }); }
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\u064B-\u0652]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي'); }
  function cmp(a, b) {
    var an = a == null || a === '', bn = b == null || b === '';
    if (an || bn) return an && bn ? 0 : (an ? 1 : -1);          // empty values last
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), isEn() ? 'en' : 'ar', { numeric: true, sensitivity: 'base' });
  }
  function cellKids(v) { return v == null || v === '' ? T.common.none : v; }
  function listView(cfg) {
    var st = listState(cfg.key), f = S.filters[cfg.key] || {};
    var rows = cfg.rows || [];
    var root = el('div', { class: 'card card-flush adm-list-card' });

    // toolbar: quick filter · server filters · count
    var qIn = el('input', { class: 'form-control', type: 'search', value: st.q, maxlength: 60,
      placeholder: cfg.placeholder || t('quick_filter'), 'aria-label': t('quick_filter'), autocomplete: 'off', enterkeyhint: 'search' });
    var countEl = el('span', { class: 'toolbar-count', 'aria-live': 'polite' });
    root.appendChild(el('div', { class: 'toolbar adm-toolbar', role: 'search' }, [
      el('div', { class: 'toolbar-search' }, [svgIcon('search'), qIn]),
      cfg.tools && cfg.tools.length ? el('div', { class: 'toolbar-filters' }, cfg.tools) : null,
      el('div', { class: 'toolbar-actions' }, countEl)
    ]));
    if (cfg.serverSearch && f.search) {
      root.appendChild(el('div', { class: 'adm-chips-row' }, el('span', { class: 'badge badge-blue adm-chip' }, [
        el('span', { text: t('server_search_chip', { q: f.search }) }),
        el('button', { class: 'adm-chip-x', type: 'button', 'aria-label': t('clear_search'), title: t('clear_search'),
          onclick: function () { f.search = ''; f.offset = 0; st.page = 0; rerender(); } }, svgIcon('x'))
      ])));
    }
    if (cfg.error) { root.appendChild(el('div', { class: 'adm-list-error' }, dAlert('danger', errText(cfg.error)))); return root; }
    // server window: more than WINDOW matching rows → newer / next window (re-query with offset ± WINDOW)
    var off = f.offset || 0;
    if (cfg.total != null && (off > 0 || cfg.total > off + rows.length)) {
      var shift = function (d) { f.offset = Math.max(0, off + d * WINDOW); st.page = 0; st.q = ''; rerender(); };
      root.appendChild(el('div', { class: 'adm-window-note' }, [
        el('span', { class: 'adm-window-text', text: t('list_window', { from: fmtCount(rows.length ? off + 1 : 0), to: fmtCount(off + rows.length), total: fmtCount(cfg.total) }) }),
        el('div', { class: 'adm-window-btns' }, [
          dBtn(t('window_prev', { n: WINDOW }), 'btn-secondary', function () { shift(-1); }, { disabled: off <= 0, 'data-window': 'prev' }),
          dBtn(t('window_next', { n: WINDOW }), 'btn-secondary', function () { shift(1); }, { disabled: off + rows.length >= cfg.total, 'data-window': 'next' })
        ])
      ]));
    }

    // table
    var cols = cfg.columns;
    var ths = cols.map(function (c) {
      var th = el('th', { scope: 'col', class: c.num ? 'num' : null });
      if (c.value) {
        var b = el('button', { class: 'th-sort', type: 'button', text: c.label });
        b.addEventListener('click', function () {
          if (st.sort === c.id) st.dir = -st.dir; else { st.sort = c.id; st.dir = c.desc ? -1 : 1; }
          st.page = 0; paint();
        });
        th.appendChild(b);
      } else th.textContent = c.label;
      th._col = c;
      return th;
    });
    var tbody = el('tbody');
    var wrap = el('div', { class: 'table-wrap adm-table-wrap' },
      el('table', { class: 'table table-striped adm-table' }, [el('thead', null, el('tr', null, ths)), tbody]));
    root.appendChild(wrap);
    var foot = el('div', { class: 'adm-pager adm-list-foot' });
    root.appendChild(foot);

    function filtered() {
      var q = norm(st.q.trim());
      var list = !q ? rows.slice() : rows.filter(function (r) { return norm(cfg.text(r)).indexOf(q) !== -1; });
      var col = cols.filter(function (c) { return c.id === st.sort; })[0];
      if (col && col.value) list.sort(function (a, b) { return st.dir * cmp(col.value(a), col.value(b)); });
      return list;
    }
    function paint() {
      var list = filtered(), pages = Math.max(1, Math.ceil(list.length / PAGE));
      if (st.page >= pages) st.page = pages - 1;
      if (st.page < 0) st.page = 0;
      var from = st.page * PAGE, slice = list.slice(from, from + PAGE);
      ths.forEach(function (th) {
        if (!th._col.value) return;
        th.setAttribute('aria-sort', th._col.id === st.sort ? (st.dir > 0 ? 'ascending' : 'descending') : 'none');
      });
      tbody.textContent = '';
      if (!slice.length) {
        tbody.appendChild(el('tr', { class: 'adm-empty-row' }, el('td', { colspan: cols.length, class: 'adm-empty' },
          emptyState(st.q ? 'search' : 'inbox', st.q ? t('no_match', { q: st.q.trim() }) : (cfg.empty || T.common.empty),
            st.q ? dBtn(t('clear_filter'), 'btn-secondary', function () { st.q = ''; qIn.value = ''; st.page = 0; paint(); qIn.focus(); }) : null))));
      }
      slice.forEach(function (r) {
        var href = cfg.href ? cfg.href(r) : null;
        var tr = el('tr', { class: (href || cfg.open) ? 'is-clickable' : null });
        if (cfg.rowClass) { var rc = cfg.rowClass(r); if (rc) tr.classList.add(rc); }
        cols.forEach(function (c) { tr.appendChild(el('td', { class: c.num ? 'num' : (c.desc || c.nowrap ? 'is-nowrap' : null) }, cellKids(c.cell(r)))); });
        if (href || cfg.open) {
          tr.addEventListener('click', function (e) {
            if (e.target.closest('a, button, input, select, label, textarea')) return;
            if (window.getSelection && String(window.getSelection()).length) return;   // selecting text, not opening
            if (href) location.hash = href; else cfg.open(r);
          });
        }
        tbody.appendChild(tr);
      });
      countEl.textContent = st.q ? t('count_filtered', { n: fmtCount(list.length), total: fmtCount(rows.length) }) : t('count_rows', { n: fmtCount(rows.length) });
      foot.textContent = '';
      foot.hidden = list.length <= PAGE;
      if (list.length > PAGE) {
        append(foot, [
          el('span', { class: 'adm-pager-info text-xs text-muted num', text: t('pager_range', { from: from + 1, to: Math.min(from + PAGE, list.length), total: list.length }) }),
          el('div', { class: 'btn-group adm-pager-btns' }, [
            dBtn(t('prev'), 'btn-ghost', function () { st.page--; paint(); toTop(); }, { disabled: st.page <= 0 }),
            el('span', { class: 'adm-pager-page text-xs text-muted num', text: t('pager_page', { p: st.page + 1, n: pages }) }),
            dBtn(t('next'), 'btn-ghost', function () { st.page++; paint(); toTop(); }, { disabled: st.page >= pages - 1 })
          ])
        ]);
      }
    }
    function toTop() {
      wrap.scrollTop = 0;
      var r = root.getBoundingClientRect();
      if (r.top < 0) { try { root.scrollIntoView({ block: 'start' }); } catch (e) { /* old browsers */ } }
    }
    qIn.addEventListener('input', function () { st.q = qIn.value.slice(0, 60); st.page = 0; paint(); });
    qIn.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && qIn.value) { e.preventDefault(); e.stopPropagation(); qIn.value = ''; st.q = ''; st.page = 0; paint(); }
      // Enter: search every record on the server (the window may not hold them all)
      if (e.key === 'Enter' && cfg.serverSearch) { e.preventDefault(); f.search = qIn.value.trim().slice(0, 60); f.offset = 0; st.q = ''; st.page = 0; rerender(); }
    });
    if (cfg.serverSearch) qIn.title = t('enter_server_search');
    paint();
    return root;
  }
  // .empty-state block (icon, text, optional action)
  function emptyState(ico, text, action) {
    return el('div', { class: 'empty-state is-compact' }, [el('div', { class: 'empty-state-icon', 'aria-hidden': 'true' }, svgIcon(ico)), el('p', { text: text }),
      action ? el('div', { class: 'empty-state-actions' }, action) : null]);
  }
  // toolbar <select> bound to a server filter of S.filters[key]
  function filterSelect(key, name, label, options) {
    var s = el('select', { class: 'form-control adm-select', 'aria-label': label, title: label },
      options.map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    s.value = S.filters[key][name] || '';
    s.addEventListener('change', function () { S.filters[key][name] = s.value; S.filters[key].offset = 0; listState(key).page = 0; rerender(); });
    return s;
  }
  function statusOptions(domain, allLabel) {
    var keys = ORDER[domain] || Object.keys(LABELS[domain] || {});
    return [['', allLabel || t('all_statuses')]].concat(keys.map(function (k) { return [k, lbl(domain, k)]; }));
  }
  function refCell(text, href) { return text ? el('a', { class: 'adm-ref', href: href }, el('bdi', { dir: 'ltr', text: text })) : T.common.none; }
  function twoLine(main, sub, subLtr) {
    return [el('span', { class: 'cell-main', text: main || T.common.none }), sub ? el('span', { class: 'cell-sub', dir: subLtr ? 'ltr' : null, text: sub }) : null];
  }
  function ts(v) { var d = v ? new Date(v) : null; return d && !isNaN(d) ? d.getTime() : null; }

  /* ------------------------------------------------------------------
     Dashboard — MarsaApi.dashboardStats(orgId) (counts only; falls back
     to per-count queries when it is missing or incomplete)
     ------------------------------------------------------------------ */
  function nOr(v) { return typeof v === 'number' && isFinite(v) ? v : (v != null && v !== '' && !isNaN(+v) && typeof v !== 'boolean' && typeof v !== 'object' ? +v : null); }
  function dig(o, paths) {
    for (var i = 0; i < paths.length; i++) {
      var v = o, p = paths[i].split('.');
      for (var j = 0; j < p.length && v != null; j++) v = v[p[j]];
      if (v != null) return v;
    }
    return null;
  }
  // {code: n} from a map, a {by_status} wrapper or a [{code|status, count|n}] list
  function countMap(v) {
    if (!v || typeof v !== 'object') return null;
    var out = {}, any = false;
    if (Array.isArray(v)) {
      v.forEach(function (x) { var k = x && (x.code || x.status || x.key), n = x && nOr(x.count != null ? x.count : x.n); if (k && n != null) { out[k] = n; any = true; } });
      return any ? out : null;
    }
    if (v.by_status || v.byStatus || v.by_operational_status) return countMap(v.by_status || v.byStatus || v.by_operational_status);
    Object.keys(v).forEach(function (k) { var n = nOr(v[k]); if (n != null) { out[k] = n; any = true; } });
    return any ? out : null;
  }
  function normStats(d) {
    if (!d || typeof d !== 'object') return {};
    return {
      req: countMap(dig(d, ['requests_by_status', 'requests.by_status', 'requests', 'request_status'])),
      tx: countMap(dig(d, ['transactions_by_status', 'transactions.by_status', 'transactions.by_operational_status', 'transactions', 'operational_status'])),
      overdue: nOr(dig(d, ['containers.overdue', 'containers_overdue', 'containers.return_overdue'])),
      due3: nOr(dig(d, ['containers.due_3d', 'containers.due3', 'containers.due_soon', 'containers.due_in_3_days', 'containers_due_3d', 'containers_due_soon', 'containers_due3'])),
      pending: nOr(dig(d, ['containers.pending', 'containers.pending_return', 'containers_pending', 'containers_pending_return'])),
      evidence: nOr(dig(d, ['containers.evidence_submitted', 'containers_evidence_submitted'])),
      docs: nOr(dig(d, ['documents.unreviewed', 'documents_unreviewed', 'docs_unreviewed', 'documents.unreviewed_count']))
    };
  }
  function cnt(table, build) { return L.count(table, build).then(function (r) { return r.error ? null : r.data; }); }
  function fillStats(st) {
    var jobs = [], ops = canAny(R.opsWriter);
    var openRet = ['pending', 'evidence_submitted', 'disputed'];
    function need(k, p) { if (st[k] == null) jobs.push(p.then(function (v) { st[k] = v; })); }
    function needMap(k, table, col, codes) {
      if (st[k]) return;
      var m = st[k] = {};
      codes.forEach(function (c) { jobs.push(cnt(table, function (q) { return q.eq(col, c); }).then(function (v) { if (v != null) m[c] = v; })); });
    }
    if (ops) needMap('req', 'service_requests', 'status', ['new', 'under_review']);
    needMap('tx', 'transactions', 'operational_status', ORDER.operational_status);
    need('overdue', cnt('containers', function (q) { return q.in('return_status', openRet).lt('return_deadline', todayISO(0)); }));
    need('due3', cnt('containers', function (q) { return q.in('return_status', openRet).gte('return_deadline', todayISO(0)).lte('return_deadline', todayISO(3)); }));
    need('evidence', cnt('containers', function (q) { return q.eq('return_status', 'evidence_submitted'); }));
    need('docs', cnt('documents', function (q) { return q.eq('classification_status', 'unreviewed').is('voided_at', null); }));
    if (canAny(R.contact)) jobs.push(api.listContactMessages({ orgId: S.orgId, status: 'new', limit: 1 }).then(function (r) { st.msgNew = r.error ? null : r.count; }));
    if (ops) jobs.push(cnt('import_batches', function (q) { return q.eq('status', 'draft'); }).then(function (v) { st.impDraft = v; }));
    return Promise.all(jobs).then(function () { return st; });
  }
  function daysFrom(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if (!m) return null;
    var d = new Date(+m[1], m[2] - 1, +m[3]), n = new Date(); n = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    return Math.round((d - n) / 86400000);
  }
  function dueText(iso) {
    var n = daysFrom(iso);
    if (n == null) return '';
    if (n < 0) return t('overdue_by', { n: -n });
    if (n === 0) return t('due_today');
    return t('due_in', { n: n });
  }
  function fmtCount(v) {
    if (v == null) return T.common.none;
    var I = window.MarsaI18n;
    if (I && typeof I.fmtNumber === 'function') { try { return I.fmtNumber(v); } catch (e) { /* plain */ } }
    return String(v);
  }
  function kpiNode(o) {
    // o: {label, value, foot, href, icon, tone, alert}: the original stat tile (.card-stat.adm-tile);
    // a danger / warning tone with a non-zero value tints the tile (.adm-tile-danger / -warning)
    var tint = (o.tone === 'danger' || o.tone === 'warning') && o.value ? ' adm-tile-' + o.tone : '';
    return el('a', { class: 'card card-stat adm-tile' + tint, href: o.href }, [
      el('span', { class: 'stat-value num', text: fmtCount(o.value) }),
      el('span', { class: 'stat-label', text: o.label }),
      o.foot ? el('span', { class: 'adm-tile-foot text-xs text-muted', text: o.foot }) : null
    ]);
  }
  function miniList(items, emptyText) {
    if (!items.length) return emptyState('inbox', emptyText || T.common.empty);
    return el('ul', { class: 'adm-mini' }, items.map(function (it) {
      return el('li', null, el('a', { class: 'adm-mini-row', href: it.href }, [
        el('span', { class: 'adm-mini-main' }, [el('span', { class: 'adm-mini-title' }, it.title), it.sub ? el('span', { class: 'adm-mini-sub', text: it.sub }) : null]),
        it.side ? el('span', { class: 'adm-mini-side' }, it.side) : null
      ]));
    }));
  }
  function eventText(e) {
    var p = e.payload || {}, arrow = isEn() ? ' → ' : ' ← ', s = lbl('event_type', e.event_type);
    if (e.event_type === 'operational_status') s += ': ' + lbl('operational_status', e.from_status) + arrow + lbl('operational_status', e.to_status);
    else if (e.event_type === 'financial_status') s += ': ' + lbl('financial_status', e.from_status) + arrow + lbl('financial_status', e.to_status);
    else if (e.event_type === 'container_return') s += (p.container_no ? ' ' + p.container_no : '') + ': ' + lbl('container_return_status', e.to_status);
    return s;
  }
  // G3 KPI counts: alerts by severity (status open / acknowledged) and today's appointments (not cancelled /
  // rescheduled away). null for a part whose read failed (e.g. G3 migrations not applied yet).
  function opsDashCounts(ar, pr) {
    var out = { alerts: null, appts: null };
    if (ar && !ar.error && ar.counts) {   // server counts (open + acknowledged), not limited by the page size
      out.alerts = { critical: +ar.counts.critical || 0, warning: +ar.counts.warning || 0, info: +ar.counts.info || 0 };
    } else if (ar && !ar.error) {
      out.alerts = { critical: 0, warning: 0, info: 0 };
      rowsOf(ar.data).forEach(function (a) {
        if (!a || a.status === 'resolved') return;
        if (out.alerts[a.severity] != null) out.alerts[a.severity]++;
      });
    }
    if (pr && !pr.error) {
      out.appts = { total: 0, confirmed: 0, requested: 0 };
      rowsOf(pr.data).forEach(function (x) {
        if (!x || x.status === 'cancelled' || x.status === 'rescheduled') return;
        out.appts.total++;
        if (x.status === 'confirmed') out.appts.confirmed++;
        if (x.status === 'requested') out.appts.requested++;
      });
    }
    return out;
  }
  function renderDashboard() {
    var ops = canAny(R.opsWriter);
    var statsP = typeof (api && api.dashboardStats) === 'function' ? call('dashboardStats', S.orgId) : Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE' } });
    var listsP = Promise.all([
      ops ? api.listRequests({ orgId: S.orgId, limit: 6 }) : Promise.resolve({ data: [] }),
      L.containersNext(6), L.recentEvents(8),
      // G3: open alerts (acknowledged ones stay open) and today's port appointments
      call('listAlerts', { orgId: S.orgId }),
      call('listAppointments', { orgId: S.orgId, from: todayISO(0) + 'T00:00:00', to: todayISO(1) + 'T00:00:00' })
    ]);
    return Promise.all([statsP.then(function (r) { return fillStats(r.error ? {} : normStats(r.data)); }), listsP]).then(function (res) {
      var st = res[0], rr = res[1][0], cc = res[1][1], ee = res[1][2];
      var g3 = opsDashCounts(res[1][3], res[1][4]);
      return L.profiles((ee.data || []).map(function (e) { return e.actor; })).then(function () {
        var out = frag(dHead(viewLabel('dashboard'), t('dash_sub')));
        var tx = st.tx || {}, txTotal = 0, txOpen = 0;
        ORDER.operational_status.forEach(function (c) { var n = tx[c] || 0; txTotal += n; if (c !== 'closed') txOpen += n; });

        // KPI row
        var kpis = [];
        if (ops) kpis.push({ label: t('kpi_req_new'), value: st.req ? (st.req.new || 0) : null, icon: 'inbox', href: '#requests?status=new',
          foot: st.req && st.req.under_review != null ? t('kpi_req_hint', { n: fmtCount(st.req.under_review) }) : null, tone: st.req && st.req.new ? 'info' : null });
        else kpis.push({ label: t('kpi_evidence'), value: st.evidence, icon: 'file', href: '#transactions?status=', foot: t('kpi_evidence_hint'), tone: st.evidence ? 'warning' : null, alert: !!st.evidence });
        kpis.push({ label: t('kpi_tx_open'), value: st.tx ? txOpen : null, icon: 'layers', href: '#transactions', foot: st.tx ? t('kpi_tx_hint', { n: fmtCount(txTotal) }) : null, tone: 'brand' });
        kpis.push({ label: t('kpi_ctr_overdue'), value: st.overdue, icon: 'clock', href: '#transactions?status=',
          foot: st.due3 != null ? t('kpi_ctr_due3', { n: fmtCount(st.due3) }) : null, tone: st.overdue ? 'danger' : (st.due3 ? 'warning' : null), alert: !!st.overdue });
        kpis.push({ label: t('kpi_docs'), value: st.docs, icon: 'file', href: '#transactions', foot: t('kpi_docs_hint'), tone: st.docs ? 'warning' : null, alert: !!st.docs });
        kpis.push({ label: t('kpi_alerts'), value: g3.alerts ? g3.alerts.critical : null, icon: 'alert', href: '#alerts',
          foot: g3.alerts ? t('kpi_alerts_hint', { w: fmtCount(g3.alerts.warning), i: fmtCount(g3.alerts.info) }) : t('kpi_unavailable'),
          tone: g3.alerts ? (g3.alerts.critical ? 'danger' : (g3.alerts.warning ? 'warning' : null)) : null, alert: !!(g3.alerts && g3.alerts.critical) });
        kpis.push({ label: t('kpi_appts_today'), value: g3.appts ? g3.appts.total : null, icon: 'clock', href: '#schedule',
          foot: g3.appts ? t('kpi_appts_hint', { c: fmtCount(g3.appts.confirmed), r: fmtCount(g3.appts.requested) }) : t('kpi_unavailable'),
          tone: g3.appts && g3.appts.total ? 'info' : null });
        out.appendChild(el('div', { class: 'adm-tiles' }, kpis.map(kpiNode)));

        // stage chart + needs attention
        var max = 0;
        ORDER.operational_status.forEach(function (c) { max = Math.max(max, tx[c] || 0); });
        var bars = st.tx ? el('div', { class: 'chart-bars adm-bars', role: 'list', 'aria-label': t('chart_stages') }, ORDER.operational_status.map(function (c) {
          var n = tx[c] || 0;
          var bar = el('a', { class: 'chart-bar' + (n ? '' : ' is-zero'), role: 'listitem', href: '#transactions?status=' + encodeURIComponent(c), 'data-tone': toneOf('operational_status', c),
            'aria-label': lbl('operational_status', c) + ': ' + fmtCount(n) }, [
            el('span', { class: 'chart-bar-label', text: lbl('operational_status', c) }),
            el('span', { class: 'chart-bar-track', 'aria-hidden': 'true' }, el('span', { class: 'chart-bar-fill' })),
            el('span', { class: 'chart-bar-value', text: fmtCount(n) })
          ]);
          bar.style.setProperty('--v', String(max ? n / max : 0));
          return bar;
        })) : dAlert('warning', t('stats_unavailable'));
        var attn = [];
        if (ops && st.req) attn.push({ title: t('attn_review'), href: '#requests?status=under_review', side: pillNode(st.req.under_review ? 'warning' : 'muted', fmtCount(st.req.under_review || 0)) });
        attn.push({ title: t('attn_evidence'), href: '#transactions?status=', side: pillNode(st.evidence ? 'warning' : 'muted', fmtCount(st.evidence)) });
        attn.push({ title: t('attn_due3'), href: '#transactions?status=', side: pillNode(st.due3 ? 'warning' : 'muted', fmtCount(st.due3)) });
        if (canAny(R.contact)) attn.push({ title: t('attn_messages'), href: '#messages?status=new', side: pillNode(st.msgNew ? 'info' : 'muted', fmtCount(st.msgNew)) });
        if (ops) attn.push({ title: t('attn_imports'), href: '#imports?status=draft', side: pillNode(st.impDraft ? 'warning' : 'muted', fmtCount(st.impDraft)) });
        out.appendChild(el('div', { class: 'adm-cols adm-cols-wide' }, [
          dCard(t('chart_stages'), [bars, st.tx ? el('p', { class: 'text-xs text-muted adm-card-foot-note', text: t('chart_hint') }) : null]),
          dCard(t('attn_title'), miniList(attn))
        ]));

        // latest requests · nearest deadlines · recent activity
        var cols3 = [];
        if (ops) {
          cols3.push(dCard(t('latest_requests'), rr.error ? dAlert('danger', errText(rr.error)) : miniList((rr.data || []).map(function (q) {
            return { href: '#request/' + q.id, title: [el('bdi', { dir: 'ltr', class: 'num', text: q.ref || '' }), ' · ', q.company || q.full_name || ''], sub: fmtWhen(q.created_at, true), side: badgeNode('request_status', q.status) };
          }), t('empty_requests')), [el('a', { class: 'btn btn-sm btn-ghost', href: '#requests', text: t('see_all') })]));
        }
        cols3.push(dCard(t('nearest_deadlines'), cc.error ? dAlert('danger', errText(cc.error)) : miniList((cc.data || []).map(function (c) {
          var n = daysFrom(c.return_deadline);
          return { href: '#tx/' + c.transaction_id, title: [el('bdi', { dir: 'ltr', class: 'num', text: c.container_no || '' }), c.transactions && c.transactions.ref ? [' · ', el('bdi', { dir: 'ltr', class: 'num adm-muted', text: c.transactions.ref })] : null],
            sub: fmtWhen(c.return_deadline) + ' · ' + lbl('container_return_status', c.return_status),
            side: pillNode(n == null ? 'muted' : n < 0 ? 'danger' : n <= 3 ? 'warning' : 'muted', dueText(c.return_deadline)) };
        }), t('empty_deadlines')), [el('a', { class: 'btn btn-sm btn-ghost', href: '#transactions?status=', text: t('see_all') })]));
        cols3.push(dCard(t('recent_activity'), ee.error ? dAlert('danger', errText(ee.error)) : miniList((ee.data || []).map(function (e) {
          return { href: '#tx/' + e.transaction_id, title: eventText(e), sub: who(e.actor) + ' · ' + fmtWhen(e.created_at, true),
            side: e.transactions && e.transactions.ref ? el('bdi', { dir: 'ltr', class: 'num adm-muted', text: e.transactions.ref }) : null };
        }), t('empty_activity'))));
        out.appendChild(el('div', { class: 'adm-cols' + (cols3.length > 2 ? ' adm-cols-3' : '') }, cols3));
        return out;
      });
    });
  }

  /* ------------------------------------------------------------------
     Service requests
     ------------------------------------------------------------------ */
  function renderRequests() {
    var f = S.filters.requests;
    return api.listRequests({ orgId: S.orgId, status: f.status || null, search: f.search, limit: WINDOW, offset: f.offset }).then(function (r) {
      var out = frag(dHead(viewLabel('requests'), t('requests_sub')));
      out.appendChild(listView({
        key: 'requests', rows: r.data || [], total: r.count, error: r.error, serverSearch: true,
        placeholder: t('ph_requests'), empty: t('empty_requests'),
        tools: [filterSelect('requests', 'status', t('col_status'), statusOptions('request_status'))],
        href: function (q) { return '#request/' + q.id; },
        text: function (q) { return [q.ref, q.full_name, q.company, q.port, q.bl_number, q.email, q.phone, lbl('request_status', q.status)].join(' '); },
        columns: [
          { id: 'ref', label: t('col_ref'), value: function (q) { return q.ref; }, cell: function (q) { return refCell(q.ref, '#request/' + q.id); } },
          { id: 'date', label: t('col_date'), desc: true, value: function (q) { return ts(q.created_at); }, cell: function (q) { return fmtWhen(q.created_at); } },
          { id: 'who', label: t('col_applicant'), value: function (q) { return q.company || q.full_name; }, cell: function (q) { return twoLine(q.company || q.full_name, q.company ? q.full_name : null); } },
          { id: 'op', label: t('col_operation'), value: function (q) { return lbl('direction', q.direction) + lbl('mode', q.mode); }, cell: function (q) { return lbl('direction', q.direction) + ' · ' + lbl('mode', q.mode); } },
          { id: 'port', label: t('col_port'), value: function (q) { return q.port; }, cell: function (q) { return q.port; } },
          { id: 'source', label: t('col_source'), value: function (q) { return lbl('source', q.source); }, cell: function (q) { return lbl('source', q.source); } },
          { id: 'status', label: t('col_status'), nowrap: true, value: function (q) { return (ORDER.request_status || []).indexOf(q.status); }, cell: function (q) { return badgeNode('request_status', q.status); } }
        ]
      }));
      return out;
    });
  }

  function renderRequest(id) {
    return Promise.all([api.getRequest(id), api.listDocuments({ requestId: id })]).then(function (res) {
      var r = res[0], q = r.data;
      if (r.error) return head('طلب خدمة', '', '', '#requests') + alertBox('danger', errText(r.error));
      if (!q) return head('طلب خدمة', '', '', '#requests') + alertBox('warning', 'الطلب غير موجود أو لا تملك صلاحية عرضه.');
      var txP = q.status === 'converted' ? L.txForRequest(q.id) : Promise.resolve({ data: null });
      return Promise.all([txP, L.profiles([q.reviewed_by])]).then(function (more) {
        var tx = more[0].data;
        var canWrite = q.branch_id ? canAt(q.branch_id, R.opsWriter) : canAny(R.opsWriter);
        var open = q.status === 'new' || q.status === 'under_review';
        var actions = '';
        if (canWrite && open) {
          if (q.status === 'new') actions += '<button class="btn btn-sm btn-ghost" type="button" data-act="req-review" data-id="' + esc(q.id) + '">بدء المراجعة</button>';
          actions += '<button class="btn btn-sm btn-primary" type="button" data-act="req-convert" data-id="' + esc(q.id) + '">تحويل إلى معاملة</button>';
          actions += '<button class="btn btn-sm btn-secondary adm-btn-danger" type="button" data-act="req-reject" data-id="' + esc(q.id) + '">رفض الطلب</button>';
        }
        if (tx) actions += '<a class="btn btn-sm btn-primary" href="#tx/' + esc(tx.id) + '">فتح المعاملة ' + ltr(tx.ref) + '</a>';
        var html = head('طلب ' + ltr(q.ref), badge('request_status', q.status) + ' · ' + esc(lbl('source', q.source)) + ' · ' + fmtDateTime(q.created_at), actions, '#requests');
        if (q.status_note) html += alertBox(q.status === 'rejected' ? 'danger' : 'warning', 'ملاحظة الحالة: ' + esc(q.status_note) + (q.reviewed_by ? ' — ' + esc(who(q.reviewed_by)) + '، ' + fmtDateTime(q.reviewed_at) : ''), true);
        var applicant = kv([
          ['الاسم', q.full_name], ['الشركة', q.company], ['نوع العميل', lbl('client_type', q.client_type)],
          ['الجوال', ltr(q.phone), true], ['البريد الإلكتروني', ltr(q.email), true],
          ['السجل التجاري', ltr(q.cr_number), true], ['الرقم الضريبي', ltr(q.vat_number), true],
          ['طريقة التواصل', lbl('contact_pref', q.contact_pref)]
        ]);
        var ship = kv([
          ['نوع العملية', lbl('direction', q.direction)], ['الخدمة', lbl('service', q.service)], ['وسيلة الشحن', lbl('mode', q.mode)],
          ['البلد', q.country], ['المنفذ', q.port], ['وصف البضاعة', q.goods], ['رمز HS', ltr(q.hs_code), true],
          ['رقم البيان الجمركي', ltr(q.declaration_no), true], ['يحتاج بيانًا مسبقًا', q.need_aci ? T.common.yes : 'لا'],
          ['القيمة', q.goods_value != null ? num(M.formatNum ? M.formatNum(q.goods_value, 2) : q.goods_value) + ' ' + esc(q.currency || '') : T.common.none, true],
          ['الوزن (كجم)', q.weight_kg != null ? num(q.weight_kg) : T.common.none, true],
          ['نوع الحاوية', lbl('container_type', q.container_type)], ['العدد المعلن', q.declared_count != null ? num(q.declared_count) + ' ' + esc(q.count_kind ? ({ containers: 'حاوية', packages: 'طرد', trucks: 'شاحنة' }[q.count_kind] || '') : '') : T.common.none, true],
          ['رقم البوليصة', ltr(q.bl_number), true], ['الخط الملاحي', q.shipping_line], ['تاريخ الوصول المتوقع', fmtDate(q.eta), true]
        ]);
        var ctrs = (q.container_numbers || []).length ? '<ul class="adm-chips">' + q.container_numbers.map(function (c) { return '<li class="chip">' + ltr(c) + '</li>'; }).join('') + '</ul>' : '<p class="text-muted text-sm">لا توجد أرقام حاويات.</p>';
        var declared = (Array.isArray(q.declared_documents) && q.declared_documents.length) ? '<ul class="adm-list">' + q.declared_documents.map(function (d) {
          return '<li>' + icon('file') + '<span>' + esc(d.name) + '</span><span class="text-xs text-muted">' + esc(d.kind || '') + (d.size ? ' · ' + fmtSize(d.size) : '') + '</span></li>';
        }).join('') + '</ul><p class="form-hint">أسماء ملفات أعلنها مقدّم الطلب فقط؛ الملفات نفسها لم تُرفع من النموذج العام.</p>' : '<p class="text-muted text-sm">' + (q.docs_later ? 'اختار مقدّم الطلب إرسال المستندات لاحقًا.' : 'لا توجد مستندات معلنة.') + '</p>';
        var docs = res[1].error ? alertBox('danger', errText(res[1].error)) : docsTable(res[1].data || [], { readOnly: true });
        var est = '';
        if (q.estimate && typeof q.estimate === 'object') {
          var total = q.estimate.total != null ? q.estimate.total : (q.estimate.grandTotal != null ? q.estimate.grandTotal : null);
          est = card('تقدير الحاسبة', (total != null ? '<p class="adm-big num">' + esc(M.formatSAR ? M.formatSAR(total) : total) + '</p>' : '') +
            '<p class="form-hint">تقدير استرشادي غير ضريبي أدخله العميل من الحاسبة، وليس فاتورة.</p>');
        }
        html += '<div class="adm-cols">' + card('مقدّم الطلب', applicant) + card('الشحنة', ship) + '</div>';
        html += '<div class="adm-cols">' + card('أرقام الحاويات', ctrs) + card('المستندات المعلنة', declared) + '</div>';
        html += card('المستندات المرفوعة على الطلب', docs);
        if (q.notes) html += card('ملاحظات مقدّم الطلب', '<p class="adm-pre">' + esc(q.notes) + '</p>');
        html += est;
        return html;
      });
    });
  }

  function reqReview(id) {
    return api.setRequestStatus(id, 'under_review', null).then(function (r) {
      if (r.error) return toast(errText(r.error), 'error');
      toast('أصبح الطلب قيد المراجعة.', 'success'); rerender();
    });
  }
  function reqReject(id) {
    openDialog({
      title: 'رفض الطلب', submit: 'رفض الطلب', danger: true,
      body: alertBox('warning', 'يبقى الطلب محفوظًا مع سبب الرفض في السجل، ولا يُحذف.') +
        field({ name: 'note', label: 'سبب الرفض', type: 'textarea', req: true, attrs: ' maxlength="1000"', full: true }),
      onSubmit: function (form) {
        var note = nn(fval(form, 'note'));
        if (!note) return T.common.required;
        return api.setRequestStatus(id, 'rejected', note).then(function (r) {
          if (r.error) return errText(r.error);
          toast('تم رفض الطلب وحفظ السبب.', 'success'); rerender(); return true;
        });
      }
    });
  }
  function reqConvert(id) {
    api.getRequest(id).then(function (r) {
      if (r.error || !r.data) return toast(r.error ? errText(r.error) : 'الطلب غير موجود.', 'error');
      var q = r.data;
      var branches = branchesFor(R.opsWriter);
      if (!branches.length) return toast('لا يوجد فرع لديك فيه صلاحية تحويل الطلبات.', 'error');
      var bOpts = branches.map(function (b) { return '<option value="' + esc(b.id) + '"' + (b.id === q.branch_id ? ' selected' : '') + '>' + esc(b.name_ar) + ' (' + esc(b.code) + ')</option>'; }).join('');
      var hint = q.cr_number || q.vat_number || q.company || q.full_name || '';
      openDialog({
        title: 'تحويل الطلب ' + q.ref + ' إلى معاملة', submit: 'إنشاء المعاملة', wide: true,
        body: grid(
          field({ name: 'branch', label: 'الفرع المسؤول', type: 'select', options: (branches.length > 1 && !q.branch_id ? '<option value="">اختر الفرع</option>' : '') + bOpts, req: true }) +
          field({ name: 'client', label: 'ملف العميل', type: 'select', options: '<option value="">تلقائي: مطابقة بالسجل التجاري / الرقم الضريبي، أو إنشاء ملف عميل جديد</option>', full: true, hint: 'اختر عميلًا موجودًا لتجنب تكرار ملف العميل.' }) +
          '<div class="form-group adm-full adm-inline"><label class="form-label" for="adf-csearch">بحث في العملاء</label><div class="adm-inline-row"><input class="form-control" id="adf-csearch" type="search" value="' + esc(hint) + '"><button class="btn btn-ghost btn-sm" type="button" data-dlg="client-search">' + T.common.search + '</button></div></div>'
        ) + '<p class="form-hint">تُنقل الحاويات والمستندات المرفوعة على الطلب إلى المعاملة، ويُسجَّل التحويل في سجل الأحداث.</p>',
        onOpen: function (body) {
          var sel = body.querySelector('[name=client]');
          var input = body.querySelector('#adf-csearch');
          function load() {
            api.listClients({ orgId: S.orgId, search: input.value, limit: 20 }).then(function (cr) {
              var first = '<option value="">تلقائي: مطابقة بالسجل التجاري / الرقم الضريبي، أو إنشاء ملف عميل جديد</option>';
              if (cr.error) { sel.innerHTML = first; return; }
              sel.innerHTML = first + (cr.data || []).map(function (c) {
                return '<option value="' + esc(c.id) + '"' + (c.id === q.client_id ? ' selected' : '') + '>' + esc(c.name_ar) + (c.cr_number ? ' — س.ت ' + esc(c.cr_number) : '') + (c.vat_number ? ' — ض ' + esc(c.vat_number) : '') + '</option>';
              }).join('');
            });
          }
          body.querySelector('[data-dlg=client-search]').addEventListener('click', load);
          input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); load(); } });
          load();
          // G3.2: ranked candidates (VAT / CR / alias / similar name) shown for a human choice; nothing is linked automatically
          var mp = matchPanel(function (cand) { pickClientOption(sel, cand); });
          var grp = sel.closest('.form-group');
          if (grp && grp.parentNode) grp.parentNode.insertBefore(mp.node, grp);
          mp.run({ name: q.company || q.full_name || '', vat_number: q.vat_number || null, cr_number: q.cr_number || null });
        },
        onSubmit: function (form) {
          var branchId = fval(form, 'branch');
          if (!branchId) return 'اختر الفرع قبل تحويل الطلب إلى معاملة.';
          return api.convertRequest(id, { branchId: branchId, clientId: fval(form, 'client') || null }).then(function (cr) {
            if (cr.error) return errText(cr.error);
            var d = cr.data || {};
            toast('تم إنشاء المعاملة ' + (d.ref || '') + (d.client_created ? ' وملف عميل جديد.' : '.'), 'success');
            go('#tx/' + d.transaction_id); return true;
          });
        }
      });
    });
  }

  /* ------------------------------------------------------------------
     G3.2 client matching — MarsaApi.matchClient(payload) ranks candidates:
     strong (same VAT / CR), alias (known alias or same normalised name),
     weak (similar words). It never links: the user picks, and conflicts
     (several strong matches, or VAT and CR pointing at different clients)
     are shown, not resolved.
     ------------------------------------------------------------------ */
  var MATCH_TONE = { strong: 'success', alias: 'brand', weak: 'warning' };
  function matchRows(d) {
    var rows = Array.isArray(d) ? d : (d && (d.candidates || d.rows || d.items)) || [];
    return rows.filter(Boolean).map(function (x) {
      var st = String(x.strength || x.match || x.level || 'weak');
      if (!MATCH_TONE[st]) st = 'weak';
      var rs = Array.isArray(x.reasons) ? x.reasons : (x.reasons ? [x.reasons] : (x.reason ? [x.reason] : []));
      return { id: x.client_id || x.id, name_ar: x.name_ar || x.name || '', name_en: x.name_en || null, cr_number: x.cr_number || null,
        vat_number: x.vat_number || null, is_active: x.is_active !== false, strength: st, score: x.score != null ? x.score : null,
        reasons: rs.map(function (r) { return typeof r === 'object' && r ? (r.code || r.field || r.reason || JSON.stringify(r)) : String(r); }) };
    }).filter(function (x) { return x.id && UUID_RE.test(x.id); });
  }
  function matchConflicts(d, rows) {
    var out = [];
    if (d && !Array.isArray(d) && Array.isArray(d.conflicts)) {
      d.conflicts.forEach(function (c) { out.push(typeof c === 'string' ? c : (c && (c.message || c.code || c.field)) || ''); });
    }
    var strong = rows.filter(function (x) { return x.strength === 'strong'; });
    if (strong.length > 1) out.push(t('match_conflict_strong', { n: strong.length }));
    var differs = rows.filter(function (x) { return x.strength === 'strong' && x.reasons.some(function (r) { return /_differs$|_mismatch$/.test(r); }); });
    if (differs.length) out.push(t('match_conflict_differs'));
    // match_client's own verdict (boolean): several strong / alias hits, or a strong hit whose other number differs
    if (d && d.conflict === true && !out.length) out.push(t('match_conflict_generic'));
    return out.filter(Boolean);
  }
  function reasonText(r) { var k = 'match_reason_' + r, s = t(k); return s === k ? r : s; }
  // → { node, run(payload) }; onPick(candidate) when the user chooses one
  function matchPanel(onPick) {
    var list = el('div', { class: 'adm-match-list', 'aria-live': 'polite' });
    var node = el('div', { class: 'form-group adm-full adm-match' }, [
      el('span', { class: 'form-label', text: t('match_title') }), list,
      el('span', { class: 'form-hint', text: t('match_hint') })
    ]);
    var seq = 0;
    function run(payload) {
      var p = payload || {};
      var mine = ++seq;
      list.textContent = '';
      if (!nn(p.name) && !nn(p.vat_number) && !nn(p.cr_number)) { list.appendChild(el('p', { class: 'text-sm text-muted', text: t('match_need_data') })); return; }
      list.appendChild(el('p', { class: 'text-sm text-muted', text: t('loading') }));
      call('matchClient', { name: nn(p.name), vat_number: nn(p.vat_number), cr_number: nn(p.cr_number) }).then(function (r) {
        if (mine !== seq) return;
        list.textContent = '';
        if (r.error) { list.appendChild(dAlert('warning', t('match_failed', { e: apiErr(r.error) }))); return; }
        var rows = matchRows(r.data), conflicts = matchConflicts(r.data, rows);
        if (conflicts.length) list.appendChild(el('div', { class: 'alert alert-warning', role: 'status' }, [svgIcon('alert'),
          el('div', null, [el('strong', { text: t('match_conflict') }), el('ul', { class: 'adm-list' }, conflicts.map(function (c) { return el('li', { text: c }); }))])]));
        if (!rows.length) { list.appendChild(el('p', { class: 'text-sm text-muted', text: t('match_none') })); return; }
        list.appendChild(el('ul', { class: 'adm-mini adm-match-rows' }, rows.slice(0, 8).map(function (x) {
          var ids = [x.cr_number ? t('match_cr', { v: x.cr_number }) : null, x.vat_number ? t('match_vat', { v: x.vat_number }) : null].filter(Boolean).join(' · ');
          return el('li', { class: 'adm-mini-row' }, [
            el('span', { class: 'adm-mini-main' }, [
              el('span', { class: 'adm-mini-title' }, [el('bdi', { text: x.name_ar || x.name_en || '' }), x.is_active ? null : [' ', pillNode('danger', t('inactive'))]]),
              el('span', { class: 'adm-mini-sub', text: [ids, x.reasons.map(reasonText).join('، ')].filter(Boolean).join(' — ') })
            ]),
            el('span', { class: 'adm-mini-side' }, [pillNode(MATCH_TONE[x.strength], t('match_' + x.strength)), ' ',
              dBtn(t('match_pick'), 'btn-secondary', function () { onPick(x); })])
          ]);
        })));
      });
    }
    return { node: node, run: run };
  }
  // put a candidate into a client <select> (adding the option when the list does not hold it) and select it
  function pickClientOption(sel, x) {
    var has = Array.prototype.some.call(sel.options, function (o) { return o.value === x.id; });
    if (!has) sel.appendChild(el('option', { value: x.id, text: (x.name_ar || x.name_en || '') + (x.cr_number ? ' — ' + t('match_cr', { v: x.cr_number }) : '') }));
    sel.value = x.id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    toast(t('match_picked', { n: x.name_ar || x.name_en || '' }), 'info');
  }

  /* ------------------------------------------------------------------
     G3.4 new transaction from a B/L or partial data: branch + client +
     operation/mode are enough; the B/L goes to the B/L register and is
     linked as primary, container numbers become container visits.
     ------------------------------------------------------------------ */
  var CTR_RE = /^[A-Z]{4}[0-9]{7}$/;
  var BL_TYPES = ['master', 'house', 'sea_waybill', 'awb', 'other'];
  function parseContainers(text) {
    var seen = {}, good = [], bad = [];
    String(text || '').toUpperCase().split(/[\s,;،]+/).forEach(function (x) {
      var v = x.replace(/-/g, '');
      if (!v) return;
      if (!CTR_RE.test(v)) { bad.push(x); return; }
      if (!seen[v]) { seen[v] = true; good.push(v); }
    });
    return { good: good, bad: bad };
  }
  function txNew() {
    var branches = branchesFor(R.opsWriter);
    if (!branches.length) return toast(t('txnew_no_branch'), 'error');
    var mp = null, clientSel = null;
    openDialog({
      title: t('txnew_title'), submit: t('txnew_submit'), wide: true, body: '',
      onOpen: function (b) {
        clientSel = el('select', { class: 'form-control', id: 'adg-client_id', name: 'client_id' }, [el('option', { value: '', text: t('txnew_client_choose') })]);
        var nameIn, vatIn, crIn;
        mp = matchPanel(function (x) { pickClientOption(clientSel, x); });
        var matchBtn = dBtn(t('txnew_match'), 'btn-secondary', function () { mp.run({ name: nameIn.value, vat_number: vatIn.value, cr_number: crIn.value }); });
        var grpName = dField({ name: 'client_name', label: t('txnew_client_name'), max: 160, hint: t('txnew_client_name_hint') });
        var grpVat = dField({ name: 'client_vat', label: t('col_vat'), ltr: true, max: 15 });
        var grpCr = dField({ name: 'client_cr', label: t('col_cr'), ltr: true, max: 10 });
        nameIn = grpName.querySelector('input'); vatIn = grpVat.querySelector('input'); crIn = grpCr.querySelector('input');
        append(b, [
          dAlert('info', t('txnew_intro')),
          dGrid([
            dField({ name: 'branch_id', label: t('col_branch'), type: 'select', req: true, value: branches.length === 1 ? branches[0].id : '',
              options: (branches.length > 1 ? [['', t('txnew_branch_choose')]] : []).concat(branches.map(function (x) { return [x.id, ((isEn() && x.name_en) || x.name_ar) + ' (' + x.code + ')']; })) }),
            dField({ name: 'operation', label: t('col_operation'), type: 'select', req: true, value: 'import', options: [['import', lbl('direction', 'import')], ['export', lbl('direction', 'export')]] }),
            dField({ name: 'mode', label: t('txnew_mode'), type: 'select', req: true, value: 'sea', options: [['sea', lbl('mode', 'sea')], ['air', lbl('mode', 'air')], ['land', lbl('mode', 'land')]] }),
            el('h4', { class: 'adm-full adm-form-sep', text: t('txnew_client_sec') }),
            grpName, grpVat, grpCr,
            el('div', { class: 'form-group adm-full' }, matchBtn),
            mp.node,
            el('div', { class: 'form-group adm-full' }, [el('label', { class: 'form-label', for: 'adg-client_id', text: t('col_client') }), clientSel]),
            dField({ name: 'new_client', label: t('txnew_new_client'), type: 'checkbox', full: true, hint: t('txnew_new_client_hint') }),
            dField({ name: 'save_alias', label: t('txnew_save_alias'), type: 'checkbox', value: true, full: true, hint: t('txnew_save_alias_hint') }),
            el('h4', { class: 'adm-full adm-form-sep', text: t('txnew_bl_sec') }),
            dField({ name: 'bl_number', label: t('col_bl'), ltr: true, max: 40 }),
            dField({ name: 'bl_type', label: t('txnew_bl_type'), type: 'select', value: 'master', options: BL_TYPES.map(function (k) { return [k, opsLabel('bl_type', k)]; }), hint: t('txnew_bl_type_hint') }),
            dField({ name: 'shipping_line', label: t('txnew_shipping_line'), max: 80 }),
            dField({ name: 'vessel', label: t('txnew_vessel'), max: 80 }),
            dField({ name: 'voyage', label: t('txnew_voyage'), ltr: true, max: 40 }),
            dField({ name: 'port_of_loading', label: t('txnew_pol'), max: 80 }),
            dField({ name: 'port_of_discharge', label: t('col_port'), max: 80 }),
            dField({ name: 'country', label: t('txnew_country'), max: 80 }),
            dField({ name: 'eta', label: t('txnew_eta'), type: 'date' }),
            dField({ name: 'goods_description', label: t('txnew_goods'), type: 'textarea', max: 1000, full: true }),
            dField({ name: 'containers', label: t('col_containers'), type: 'textarea', rows: 3, full: true, ltr: true, hint: t('txnew_containers_hint') })
          ])
        ]);
        // B/L type follows the mode (air → AWB) until the user picks a type by hand
        var modeSel = b.querySelector('[name=mode]'), typeSel = b.querySelector('[name=bl_type]'), typeTouched = false;
        if (modeSel && typeSel) {
          typeSel.addEventListener('change', function () { typeTouched = true; });
          modeSel.addEventListener('change', function () { if (!typeTouched) typeSel.value = modeSel.value === 'air' ? 'awb' : 'master'; });
        }
        clientSel.addEventListener('focus', function onFirst() {
          clientSel.removeEventListener('focus', onFirst);
          api.listClients({ orgId: S.orgId, limit: 100 }).then(function (cr) {
            (cr.data || []).forEach(function (c) {
              if (!Array.prototype.some.call(clientSel.options, function (o) { return o.value === c.id; })) clientSel.appendChild(el('option', { value: c.id, text: c.name_ar }));
            });
          });
        });
      },
      onSubmit: function (form) {
        var v = function (k) { return nn(fval(form, k)); };
        var branchId = v('branch_id'), clientId = v('client_id'), name = v('client_name');
        var western = function (x) { return x == null ? null : String(x).replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }).replace(/[\s-]/g, ''); };
        var vat = western(v('client_vat')), cr = western(v('client_cr'));
        if (!branchId) return t('txnew_branch_choose');
        if (!clientId && !(fval(form, 'new_client') && name)) return t('txnew_need_client');
        if (vat && !/^[0-9]{15}$/.test(vat)) return t('txnew_bad_vat');
        if (cr && !/^[0-9]{10}$/.test(cr)) return t('txnew_bad_cr');
        var ctr = parseContainers(fval(form, 'containers'));
        if (ctr.bad.length) return t('txnew_bad_containers', { list: ctr.bad.slice(0, 5).join(', ') });
        var bl = v('bl_number') ? v('bl_number').toUpperCase() : null;
        var warn = [];
        var clientP = clientId ? Promise.resolve({ data: { id: clientId } })
          : api.createClient({ org_id: S.orgId, client_type: 'business', name_ar: name, vat_number: vat, cr_number: cr });
        return clientP.then(function (cr0) {
          if (cr0.error) return cr0.error.code === 'DUPLICATE' ? t('txnew_client_dup') : apiErr(cr0.error);
          var cid = cr0.data.id;
          var row = { org_id: S.orgId, branch_id: branchId, client_id: cid, operation: fval(form, 'operation'), mode: fval(form, 'mode'),
            port_of_loading: v('port_of_loading'), port_of_discharge: v('port_of_discharge'), country: v('country'),
            goods_description: v('goods_description'), shipping_line: v('shipping_line'), eta: v('eta'), container_count: ctr.good.length };
          return api.createTransaction(row).then(function (tr) {
            if (tr.error) return apiErr(tr.error);
            var tx = tr.data;
            var chain = Promise.resolve(null);
            if (bl) {
              // save_bl registers (or finds) the B/L and links it as primary in one server transaction
              chain = call('saveBL', { bl_number: bl, bl_type: fval(form, 'bl_type') || 'master', carrier_name: v('shipping_line'), vessel: v('vessel'),
                voyage: v('voyage'), port_of_loading: v('port_of_loading'), port_of_discharge: v('port_of_discharge'), goods_description: v('goods_description'),
                transaction_id: tx.id, primary: true })
                .then(function (br) {
                  var blId = br.data && (br.data.id || br.data.bl_id);
                  // not linked (e.g. bl_other_branch): the plain number is kept on the record; the server logs a 'conflict' B/L event
                  if (br.error || !blId) { warn.push(br.error && errField(br.error) === 'bl_other_branch' ? t('txnew_warn_bl_branch') : t('txnew_warn_bl', { e: br.error ? apiErr(br.error) : '—' })); return api.updateTransaction(tx.id, { bl_number: bl }).then(function () { return null; }); }
                  if (br.data.shared_with_other_client) warn.push(t('txnew_warn_bl_shared'));
                  if (br.data.linked) return blId;
                  return call('linkBL', tx.id, blId, true).then(function (lr) { if (lr.error) warn.push(t('txnew_warn_bl', { e: apiErr(lr.error) })); return lr.error ? null : blId; });
                });
            }
            return chain.then(function (blId) {
              // sequential: a repeated number inside one transaction is refused by the server (it may repeat across transactions)
              return ctr.good.reduce(function (p, no) {
                return p.then(function () {
                  return api.addContainer(tx.id, blId ? { container_no: no, bl_id: blId } : { container_no: no }).then(function (r) { if (r.error) warn.push(no + ': ' + apiErr(r.error)); });
                });
              }, Promise.resolve());
            }).then(function () {
              if (!clientId || !name || !fval(form, 'save_alias')) return null;
              return call('addClientAlias', clientId, name, bl ? 'bl' : 'manual').then(function (ar) {
                if (!ar.error || !isAliasTaken(ar.error)) { if (ar.error) warn.push(t('txnew_warn_alias', { e: apiErr(ar.error) })); return null; }
                // the server says "taken" (after normalization): silent when it is already this client's alias
                return call('listClientAliases', clientId).then(function (lr) {
                  var mine = (lr.data || []).some(function (a) { return aliasKey(a.alias) === aliasKey(name); });
                  if (!mine) warn.push(t('txnew_warn_alias', { e: t('alias_duplicate') }));
                });
              });
            }).then(function () {
              toast(t('txnew_done', { ref: tx.ref || '' }) + (warn.length ? ' ' + t('txnew_with_warnings', { list: warn.join(' · ') }) : ''), warn.length ? 'warning' : 'success');
              go('#tx/' + tx.id);
              return true;
            });
          });
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     Transactions
     ------------------------------------------------------------------ */
  function branchOpts(selected, blank) {
    return (blank ? '<option value="">' + esc(blank) + '</option>' : '') + S.branches.map(function (b) {
      return '<option value="' + esc(b.id) + '"' + (b.id === selected ? ' selected' : '') + '>' + esc(b.name_ar) + '</option>';
    }).join('');
  }
  function renderTransactions() {
    var f = S.filters.transactions;
    return api.listTransactions({ orgId: S.orgId, status: f.status || null, branchId: f.branchId || null, search: f.search, limit: WINDOW, offset: f.offset }).then(function (r) {
      var canNew = branchesFor(R.opsWriter).length > 0;
      var out = frag(dHead(viewLabel('transactions'), t('transactions_sub'),
        canNew ? [dBtn([svgIcon('plus'), t('txnew_btn')], 'btn-primary', function () { txNew(); })] : null));
      var multi = S.branches.length > 1;
      var tools = [filterSelect('transactions', 'status', t('col_op_status'), statusOptions('operational_status'))];
      if (multi) tools.push(filterSelect('transactions', 'branchId', t('col_branch'), [['', t('all_branches')]].concat(S.branches.map(function (b) { return [b.id, (isEn() && b.name_en) || b.name_ar]; }))));
      var cols = [
        { id: 'ref', label: t('col_ref'), value: function (x) { return x.ref; }, cell: function (x) { return refCell(x.ref, '#tx/' + x.id); } },
        { id: 'client', label: t('col_client'), value: function (x) { return x.clients && x.clients.name_ar; }, cell: function (x) { return x.clients && x.clients.name_ar; } }
      ];
      if (multi) cols.push({ id: 'branch', label: t('col_branch'), value: function (x) { return x.branches && x.branches.name_ar; }, cell: function (x) { return x.branches && x.branches.name_ar; } });
      cols.push(
        { id: 'op', label: t('col_operation'), value: function (x) { return lbl('direction', x.operation) + lbl('mode', x.mode); }, cell: function (x) { return lbl('direction', x.operation) + ' · ' + lbl('mode', x.mode); } },
        { id: 'bl', label: t('col_bl'), value: function (x) { return x.bl_number; }, cell: function (x) { return dLtr(x.bl_number); } },
        { id: 'ctr', label: t('col_containers'), num: true, value: function (x) { return x.container_count; }, cell: function (x) { return el('span', { class: 'num', text: fmtCount(x.container_count) }); } },
        { id: 'ops', label: t('col_op_status'), value: function (x) { return ORDER.operational_status.indexOf(x.operational_status); }, cell: function (x) { return badgeNode('operational_status', x.operational_status); } },
        { id: 'fin', label: t('col_fin_status'), value: function (x) { return (ORDER.financial_status || Object.keys(LABELS.financial_status)).indexOf(x.financial_status); }, cell: function (x) { return badgeNode('financial_status', x.financial_status); } },
        { id: 'changed', label: t('col_changed_at'), desc: true, value: function (x) { return ts(x.status_changed_at); }, cell: function (x) { return fmtWhen(x.status_changed_at); } }
      );
      out.appendChild(listView({
        key: 'transactions', rows: r.data || [], total: r.count, error: r.error, serverSearch: true,
        placeholder: t('ph_transactions'), empty: t('empty_transactions'), tools: tools, columns: cols,
        href: function (x) { return '#tx/' + x.id; },
        text: function (x) { return [x.ref, x.bl_number, x.declaration_no, x.clients && x.clients.name_ar, x.branches && x.branches.name_ar, x.port_of_discharge, lbl('operational_status', x.operational_status)].join(' '); }
      }));
      return out;
    });
  }

  var TX_CACHE = {};
  function renderTx(id) {
    return Promise.all([
      api.getTransaction(id),
      api.listDocuments({ transactionId: id, includeVoided: S.showVoided }),
      api.listEvents(id)
    ]).then(function (res) {
      var r = res[0], t = r.data;
      if (r.error) return head('معاملة', '', '', '#transactions') + alertBox('danger', errText(r.error));
      if (!t) return head('معاملة', '', '', '#transactions') + alertBox('warning', 'المعاملة غير موجودة أو لا تملك صلاحية عرضها.');
      var docs = res[1].data || [], events = res[2].data || [];
      TX_CACHE[id] = { tx: t, docs: docs };
      var actorIds = events.map(function (e) { return e.actor; }).concat(docs.map(function (d) { return d.uploaded_by; }), docs.map(function (d) { return d.classified_by; }), [t.responsible_user_id]);
      var reqP = t.request_id ? L.requestRef(t.request_id) : Promise.resolve({ data: null });
      return Promise.all([L.profiles(actorIds), reqP]).then(function (more) {
        var req = more[1].data;
        var canOps = canAt(t.branch_id, R.opsWriter), canTr = canAt(t.branch_id, R.transportWriter);
        var actions = '';
        if (canOps) {
          actions += '<button class="btn btn-sm btn-ghost" type="button" data-act="tx-edit" data-id="' + esc(t.id) + '">تعديل البيانات</button>';
          actions += '<button class="btn btn-sm btn-ghost" type="button" data-act="tx-token" data-id="' + esc(t.id) + '">إصدار رمز تتبع</button>';
        }
        var html = head('معاملة ' + ltr(t.ref),
          esc(t.clients ? t.clients.name_ar : '') + (t.branches ? ' · ' + esc(t.branches.name_ar) : '') + ' · أُنشئت ' + fmtDate(t.created_at),
          actions, '#transactions');

        // stages + status
        var order = ORDER.operational_status, cur = order.indexOf(t.operational_status);
        html += '<ol class="adm-stages" aria-label="المراحل التشغيلية">' + order.map(function (s, i) {
          return '<li class="' + (i < cur ? 'is-done' : i === cur ? 'is-current' : '') + '"' + (i === cur ? ' aria-current="step"' : '') + '><span>' + esc(lbl('operational_status', s)) + '</span></li>';
        }).join('') + '</ol>';

        var info = kv([
          ['العميل', t.clients ? '<a href="#client/' + esc(t.clients.id) + '">' + esc(t.clients.name_ar) + '</a>' : T.common.none, true],
          ['الطلب الأصلي', req ? '<a href="#request/' + esc(req.id) + '">' + ltr(req.ref) + '</a>' : T.common.none, true],
          ['نوع العملية', lbl('direction', t.operation) + ' · ' + lbl('mode', t.mode)], ['الخدمة', lbl('service', t.service)],
          ['ميناء الشحن', t.port_of_loading], ['ميناء الوصول', t.port_of_discharge], ['البلد', t.country],
          ['وصف البضاعة', t.goods_description], ['رمز HS', ltr(t.hs_code), true], ['الخط الملاحي', t.shipping_line],
          ['رقم البوليصة', ltr(t.bl_number), true], ['رقم البيان الجمركي', ltr(t.declaration_no), true],
          ['تاريخ البيان', fmtDate(t.declaration_date), true], ['نوع البيان', t.declaration_type],
          ['عدد الحاويات', num(t.container_count), true], ['عدد الطرود', t.package_count != null ? num(t.package_count) : T.common.none, true],
          ['تاريخ الوصول المتوقع', fmtDate(t.eta), true], ['المسؤول', t.responsible_user_id ? who(t.responsible_user_id) : T.common.none],
          ['ملاحظات', t.notes]
        ]);
        var status = '<div class="adm-status-now"><div><span class="text-xs text-muted">الحالة التشغيلية</span>' + badge('operational_status', t.operational_status) +
          '</div><div><span class="text-xs text-muted">الحالة المالية (مرجعية فقط حتى إطلاق الفوترة)</span>' + badge('financial_status', t.financial_status) + '</div></div>' +
          '<p class="text-xs text-muted">آخر تغيير: ' + fmtDateTime(t.status_changed_at) + '</p>';
        var choices = statusChoices(t);
        if (choices.length) {
          status += '<form class="adm-status-form" data-form="tx-status" data-id="' + esc(t.id) + '">' +
            field({ name: 'status', label: 'الحالة الجديدة', type: 'select', req: true, options: '<option value="">اختر الحالة</option>' + choices.map(function (c) {
              return '<option value="' + esc(c.code) + '" data-back="' + (c.back ? '1' : '') + '">' + esc(lbl('operational_status', c.code)) + (c.back ? ' — تصحيح للخلف (يلزم سبب)' : '') + '</option>';
            }).join('') }) +
            field({ name: 'note', label: 'ملاحظة / سبب', type: 'textarea', rows: 2, attrs: ' maxlength="2000"', hint: 'الملاحظة داخلية ولا تظهر للعميل. السبب إلزامي عند الرجوع لمرحلة سابقة.' }) +
            '<button class="btn btn-primary btn-sm" type="submit">تغيير الحالة</button></form>';
          if (cur < order.indexOf('operationally_complete')) {
            status += '<p class="form-hint">لا يمكن الوصول إلى «' + esc(lbl('operational_status', 'operationally_complete')) + '» قبل توثيق إرجاع كل حاوية بإيصال استلام فارغ مؤكّد أو استثناء موثّق.</p>';
          }
        } else {
          status += '<p class="text-sm text-muted">' + T.common.notAllowed + '</p>';
        }
        html += '<div class="adm-cols adm-cols-wide">' + card('بيانات المعاملة', info) + card('الحالة', status) + '</div>';

        // containers
        var cRows = (t.containers || []).slice().sort(function (a, b) { return a.container_no < b.container_no ? -1 : 1; }).map(function (c) {
          var ev = docs.filter(function (d) { return d.id === c.evidence_document_id; })[0];
          var open = ['pending', 'evidence_submitted', 'disputed'].indexOf(c.return_status) !== -1;
          var late = open && c.return_deadline && c.return_deadline < todayISO(0);
          return '<tr><td>' + ltr(c.container_no) + '</td><td>' + esc(lbl('container_type', c.container_type)) + '</td><td>' + fmtDate(c.return_deadline) +
            (late ? ' ' + pillHtml('danger', tl('late')) : '') + '</td><td>' + esc(c.return_location || T.common.none) + '</td><td>' +
            badge('container_return_status', c.return_status) + (c.verified_at ? '<span class="adm-sub">تحقّق: ' + esc(who(c.verified_by)) + ' · ' + fmtDate(c.verified_at) + '</span>' : '') +
            '</td><td>' + (ev ? '<button class="btn-link" type="button" data-act="doc-open" data-id="' + esc(ev.id) + '">' + esc(ev.original_name) + '</button>' : (c.evidence_document_id ? 'مستند ملغى أو غير ظاهر' : T.common.none)) +
            '</td><td>' + (canTr ? '<button class="btn btn-sm btn-ghost" type="button" data-act="ctr-edit" data-tx="' + esc(t.id) + '" data-id="' + esc(c.id) + '">' + T.common.edit + '</button>' : '') + '</td></tr>';
        });
        html += card('الحاويات وإرجاع الفارغ', table(['رقم الحاوية', 'النوع', 'آخر موعد للإرجاع', 'مكان الإرجاع', 'حالة الإرجاع', 'دليل الإرجاع', ''], cRows) +
          '<p class="form-hint">الإثبات الوحيد المقبول لإرجاع الحاوية هو «' + esc(lbl('document_kind', 'empty_return_receipt')) + '» بعد تأكيد تصنيفه من الموظف. إيصال التسليم (EIR) وتعليمات الإرجاع ليست إثباتًا.</p>',
          canTr ? '<button class="btn btn-sm btn-primary" type="button" data-act="ctr-add" data-tx="' + esc(t.id) + '">' + icon('plus') + 'إضافة حاوية</button>' : '');

        // documents
        var upload = '';
        if (canAt(t.branch_id, R.staff)) {
          upload = '<form class="adm-upload" data-form="doc-upload" data-tx="' + esc(t.id) + '">' +
            field({ name: 'file', label: 'الملف', type: 'file', req: true, attrs: ' accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.csv"' }) +
            field({ name: 'kind', label: 'نوع المستند (كما ورد)', type: 'select', options: opts('document_kind', 'other') }) +
            field({ name: 'visibility', label: 'الظهور', type: 'select', options: opts('visibility', 'internal') }) +
            field({ name: 'source', label: 'المصدر', type: 'select', options: opts('doc_source', 'staff_scan', false, ['upload', 'staff_scan', 'email', 'whatsapp']) }) +
            field({ name: 'sourceRef', label: 'مرجع المصدر (اختياري)', attrs: ' maxlength="255"', hint: 'مثل: اسم المرسل أو رقم الرسالة' }) +
            '<button class="btn btn-primary btn-sm" type="submit">رفع المستند</button></form>' +
            '<p class="form-hint">الحد الأقصى 25 ميغابايت. الأصل يُحفظ كما هو مع بصمته (SHA-256)، والتصحيح يكون برفع نسخة جديدة أو إلغاء المستند مع ذكر السبب.</p>';
        }
        var voidToggle = '<label class="check adm-voided-toggle"><input type="checkbox" data-act="toggle-voided"' + (S.showVoided ? ' checked' : '') + '> إظهار المستندات الملغاة</label>';
        html += card('المستندات', (res[1].error ? alertBox('danger', errText(res[1].error)) : docsTable(docs, { tx: t })) + upload, voidToggle);

        // events (append-only)
        var evHtml = res[2].error ? alertBox('danger', errText(res[2].error)) : timeline(events, docs);
        if (canAt(t.branch_id, R.staff)) {
          evHtml += '<form class="adm-note-form" data-form="tx-note" data-id="' + esc(t.id) + '">' +
            field({ name: 'note', label: 'إضافة ملاحظة', type: 'textarea', rows: 2, req: true, attrs: ' maxlength="2000"', full: true }) +
            '<button class="btn btn-sm btn-primary" type="submit">إضافة إلى السجل</button></form>';
        }
        html += card('سجل الأحداث', '<p class="form-hint">السجل للإضافة فقط: لا يُعدّل ولا يُحذف. للتصحيح أضف ملاحظة جديدة توضّح السبب.</p>' + evHtml);
        // G3 sections (MarsaOps.txSections) are DOM nodes: the escaped markup above becomes a fragment first
        var tpl = document.createElement('template');
        tpl.innerHTML = html;
        var out = tpl.content;
        var sections = el('div', { class: 'ops-tx-sections' });
        out.appendChild(sections);
        renderTxSections(sections, t);
        return out;
      });
    });
  }

  function statusChoices(t) {
    var order = ORDER.operational_status, cur = order.indexOf(t.operational_status), out = [];
    order.forEach(function (code, i) {
      if (i === cur) return;
      var back = i < cur;
      var roles = back ? (t.operational_status === 'closed' ? ['admin'] : R.backward) : STATUS_ROLES[code];
      if (roles && canAt(t.branch_id, roles)) out.push({ code: code, back: back });
    });
    return out;
  }

  function docsTable(docs, o) {
    o = o || {};
    var t = o.tx;
    var canEdit = t && canAt(t.branch_id, R.staff) && !o.readOnly;
    return table(['الملف', 'النوع المعلن', 'التصنيف (الموظف)', 'الظهور', 'المصدر', 'رُفع', ''], docs.map(function (d) {
      var voided = !!d.voided_at;
      var acts = '<button class="btn btn-sm btn-ghost" type="button" data-act="doc-open" data-id="' + esc(d.id) + '">' + T.common.open + '</button>';
      if (canEdit && !voided) {
        acts += '<button class="btn btn-sm btn-ghost" type="button" data-act="doc-classify" data-tx="' + esc(t.id) + '" data-id="' + esc(d.id) + '">تصنيف</button>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-act="doc-visibility" data-tx="' + esc(t.id) + '" data-id="' + esc(d.id) + '" data-to="' + (d.visibility === 'client' ? 'internal' : 'client') + '">' + (d.visibility === 'client' ? 'إخفاء عن العميل' : 'إظهار للعميل') + '</button>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-act="doc-version" data-tx="' + esc(t.id) + '" data-id="' + esc(d.id) + '">نسخة جديدة</button>' +
          '<button class="btn btn-sm btn-ghost adm-text-danger" type="button" data-act="doc-void" data-tx="' + esc(t.id) + '" data-id="' + esc(d.id) + '">إلغاء</button>';
      }
      return '<tr' + (voided ? ' class="adm-voided"' : '') + '><td><strong>' + esc(d.original_name) + '</strong><span class="adm-sub">' + fmtSize(d.size_bytes) +
        (d.version > 1 ? ' · نسخة ' + num(d.version) : '') + (voided ? ' · ' + pillHtml('danger', tl('voided')) + ' ' + esc(d.void_reason || '') : '') + '</span></td><td>' +
        esc(lbl('document_kind', d.kind)) + '</td><td>' + (d.classification ? esc(lbl('document_kind', d.classification)) + '<br>' : '') + badge('classification_status', d.classification_status) +
        (d.classification_note ? '<span class="adm-sub">' + esc(d.classification_note) + '</span>' : '') + '</td><td>' + esc(lbl('visibility', d.visibility)) + '</td><td>' +
        esc(lbl('doc_source', d.source)) + (d.source_ref ? '<span class="adm-sub">' + esc(d.source_ref) + '</span>' : '') + '</td><td>' + fmtDate(d.uploaded_at) +
        '<span class="adm-sub">' + esc(who(d.uploaded_by)) + '</span></td><td><div class="adm-row-actions">' + acts + '</div></td></tr>';
    }));
  }

  function timeline(events, docs) {
    if (!events.length) return '<p class="text-muted text-sm">' + T.common.empty + '</p>';
    var docName = function (id) { var d = (docs || []).filter(function (x) { return x.id === id; })[0]; return d ? d.original_name : 'مستند'; };
    return '<ol class="timeline adm-timeline">' + events.slice().reverse().map(function (e, i) {
      var title = esc(lbl('event_type', e.event_type)), detail = '';
      var p = e.payload || {};
      if (e.event_type === 'operational_status') {
        title += ': ' + esc(lbl('operational_status', e.from_status)) + ' ← ' + esc(lbl('operational_status', e.to_status));
        if (p.direction === 'backward') detail += pillHtml('warning', t('backward')) + ' ';
      } else if (e.event_type === 'financial_status') {
        title += ': ' + esc(lbl('financial_status', e.from_status)) + ' ← ' + esc(lbl('financial_status', e.to_status));
      } else if (e.event_type === 'container_return') {
        title += ' ' + ltr(p.container_no) + ': ' + (e.from_status ? esc(lbl('container_return_status', e.from_status)) + ' ← ' : '') + esc(lbl('container_return_status', e.to_status));
      } else if (e.event_type === 'document') {
        var op = p.voided ? 'إلغاء' : (p.op === 'insert' ? 'إضافة' : 'تحديث التصنيف');
        title += ': ' + op + ' «' + esc(docName(p.document_id)) + '»' + (p.classification ? ' — ' + esc(lbl('document_kind', p.classification)) : '');
      } else if (e.event_type === 'request_converted') {
        title += ' ' + ltr(p.request_ref) + (p.client_created ? ' (ملف عميل جديد)' : '');
      } else if (e.event_type === 'tracking_token') {
        title += p.reissued ? ' (إعادة إصدار؛ الرمز السابق لم يعد صالحًا)' : '';
      }
      if (e.note) detail += '<span class="adm-pre">' + esc(e.note) + '</span>';
      return '<li class="' + (i === 0 ? 'is-current' : 'is-done') + '"><span class="tl-dot" aria-hidden="true"></span><span class="tl-title">' + title + '</span>' +
        (detail ? '<span class="adm-tl-note">' + detail + '</span>' : '') +
        '<span class="tl-meta">' + esc(who(e.actor)) + ' · ' + fmtDateTime(e.created_at) + (e.visible_to_client ? ' · ' + pillHtml('brand', t('client_visible')) : '') + '</span></li>';
    }).join('') + '</ol>';
  }

  function txEdit(id) {
    var c = TX_CACHE[id]; if (!c) return;
    var t = c.tx;
    openDialog({
      title: 'تعديل بيانات المعاملة ' + t.ref, wide: true,
      body: alertBox('info', 'المرجع والحالات لا تُعدّل من هنا. كل تعديل يُحفظ في سجل التدقيق.') +
        alertBox('info', 'البيان الجمركي (إضافة / تصحيح / إلغاء واستبدال) يُدار من قسم «البيانات الجمركية»، والبوالص الإضافية من قسم «بوالص الشحن» في صفحة المعاملة. لا يُرسَل هنا إلا ما غيّرته.') + grid(
        field({ name: 'service', label: 'الخدمة', type: 'select', options: opts('service', t.service, 'غير محدد') }) +
        field({ name: 'country', label: 'البلد', value: t.country, attrs: ' maxlength="80"' }) +
        field({ name: 'port_of_loading', label: 'ميناء الشحن', value: t.port_of_loading, attrs: ' maxlength="80"' }) +
        field({ name: 'port_of_discharge', label: 'ميناء الوصول', value: t.port_of_discharge, attrs: ' maxlength="80"' }) +
        field({ name: 'goods_description', label: 'وصف البضاعة', type: 'textarea', rows: 2, value: t.goods_description, attrs: ' maxlength="1000"', full: true }) +
        field({ name: 'hs_code', label: 'رمز HS', value: t.hs_code, ltr: true, attrs: ' inputmode="numeric" maxlength="12"', hint: '4 إلى 12 رقمًا' }) +
        field({ name: 'shipping_line', label: 'الخط الملاحي', value: t.shipping_line, attrs: ' maxlength="80"' }) +
        field({ name: 'bl_number', label: 'رقم البوليصة الرئيسية', value: t.bl_number, ltr: true, attrs: ' maxlength="40"', hint: 'تغييره يجعل البوليصة الجديدة رئيسية وتبقى السابقة مرتبطة.' }) +
        field({ name: 'container_count', label: 'عدد الحاويات', type: 'number', value: t.container_count, attrs: ' min="0" step="1"' }) +
        field({ name: 'package_count', label: 'عدد الطرود', type: 'number', value: t.package_count, attrs: ' min="0" step="1"' }) +
        field({ name: 'eta', label: 'تاريخ الوصول المتوقع', type: 'date', value: t.eta }) +
        field({ name: 'notes', label: 'ملاحظات', type: 'textarea', rows: 2, value: t.notes, attrs: ' maxlength="2000"', full: true })
      ),
      onSubmit: function (form) {
        var patch = {};
        // declaration_no / date / type are not sent from here: the declarations section owns them
        // (correct / cancel + replace with a reason). The server refuses a renumber or a clear through the record.
        ['service', 'country', 'port_of_loading', 'port_of_discharge', 'goods_description', 'hs_code', 'shipping_line', 'bl_number',
          'eta', 'notes'].forEach(function (k) { patch[k] = nn(fval(form, k)); });
        if (patch.hs_code && !/^[0-9]{4,12}$/.test(patch.hs_code)) return 'رمز HS يجب أن يكون من 4 إلى 12 رقمًا.';
        if (patch.bl_number) patch.bl_number = patch.bl_number.toUpperCase();
        var cc = nn(fval(form, 'container_count')), pc = nn(fval(form, 'package_count'));
        patch.container_count = cc == null ? 0 : parseInt(cc, 10);
        patch.package_count = pc == null ? null : parseInt(pc, 10);
        if (isNaN(patch.container_count) || patch.container_count < 0 || (patch.package_count != null && (isNaN(patch.package_count) || patch.package_count < 0))) return 'الأعداد يجب أن تكون أرقامًا صحيحة موجبة.';
        // only the keys the user changed against the values the form opened with: a form opened before
        // another change (e.g. a new primary B/L) never writes the older value back
        Object.keys(patch).forEach(function (k) {
          var was = t[k] == null || t[k] === '' ? null : String(t[k]);
          var now = patch[k] == null ? null : String(patch[k]);
          if (k === 'bl_number' && was) was = was.toUpperCase();
          if (was === now) delete patch[k];
        });
        if (!Object.keys(patch).length) { toast(T.common.saved, 'success'); return true; }
        return api.updateTransaction(id, patch).then(function (r) {
          if (r.error) return errText(r.error);
          toast(T.common.saved, 'success'); rerender(); return true;
        });
      }
    });
  }
  function txToken(id) {
    var c = TX_CACHE[id]; if (!c) return;
    openDialog({
      title: 'إصدار رمز تتبع', submit: 'إصدار الرمز',
      body: alertBox('warning', 'يُعرض الرمز مرة واحدة فقط ويُحفظ في قاعدة البيانات كبصمة. إصدار رمز جديد يُبطل الرمز السابق فورًا. سلّمه للعميل مع رقم المعاملة.'),
      onSubmit: function () { return txTokenIssue(id); }
    });
  }
  // key: undefined on the first try (supa.js keeps one key across its own retries);
  // a fresh key for "issue a new one" so the stored replay is never returned again
  function txTokenIssue(id, key) {
    return api.issueTrackingToken(id, key).then(function (r) {
      if (r.error) return errText(r.error);
      var d = r.data || {};
      if (!d.tracking_token) {
        // idempotent replay (the first response was lost): the server never stores the token,
        // and the one issued then already replaced the previous token
        openDialog({
          title: 'رمز التتبع للمعاملة ' + (d.ref || ''), submit: 'إصدار رمز جديد',
          body: alertBox('warning', 'صدر رمز تتبع لهذه المعاملة في ردّ سابق لم يصل، ولا يمكن عرضه مرة أخرى. أصدر رمزًا جديدًا لتسلّمه للعميل؛ الرمز الجديد يُبطل السابق فورًا.'),
          onSubmit: function () { return txTokenIssue(id, api.newIdemKey()); }
        });
        rerender();
        return false;
      }
      openDialog({
        title: 'رمز التتبع للمعاملة ' + (d.ref || ''), noSubmit: true,
        body: '<p class="text-sm">انسخ الرمز الآن؛ لن يظهر مرة أخرى.</p><div class="adm-token" dir="ltr"><span class="num">' + esc(d.ref) + '</span><code>' + esc(d.tracking_token) + '</code></div>'
      });
      rerender();
      return false;
    });
  }

  /* containers */
  function evidenceOptions(docs, selected) {
    return '<option value="">بدون مستند</option>' + docs.filter(function (d) { return !d.voided_at; }).map(function (d) {
      var valid = d.classification === 'empty_return_receipt' && (d.classification_status === 'confirmed' || d.classification_status === 'reclassified');
      return '<option value="' + esc(d.id) + '"' + (d.id === selected ? ' selected' : '') + '>' + (valid ? '✓ ' : '') + esc(d.original_name) + ' — ' +
        esc(d.classification ? lbl('document_kind', d.classification) : 'لم يُصنّف (' + lbl('document_kind', d.kind) + ')') + '</option>';
    }).join('');
  }
  function containerDialog(txId, ctrId) {
    var c = TX_CACHE[txId]; if (!c) return;
    var ctr = ctrId ? (c.tx.containers || []).filter(function (x) { return x.id === ctrId; })[0] : null;
    if (ctrId && !ctr) return;
    ctr = ctr || { return_status: 'pending' };
    openDialog({
      title: ctrId ? 'تعديل الحاوية ' + ctr.container_no : 'إضافة حاوية', wide: true,
      body: grid(
        field({ name: 'container_no', label: 'رقم الحاوية', value: ctr.container_no, req: !ctrId, ltr: true, attrs: (ctrId ? ' readonly' : '') + ' maxlength="13" autocomplete="off"', hint: '4 أحرف ثم 7 أرقام، مثل MSCU1234567' }) +
        field({ name: 'container_type', label: 'نوع الحاوية', type: 'select', options: opts('container_type', ctr.container_type, 'غير محدد') }) +
        field({ name: 'gate_out_at', label: 'خروج الحاوية من الميناء', type: 'datetime-local', value: toLocalInput(ctr.gate_out_at) }) +
        field({ name: 'delivered_at', label: 'تاريخ التسليم للعميل', type: 'datetime-local', value: toLocalInput(ctr.delivered_at) }) +
        field({ name: 'return_deadline', label: 'آخر موعد لإرجاع الفارغ', type: 'date', value: ctr.return_deadline, hint: 'مثل «EMPTY RETURN BY» في إيصال التسليم — موعد وليس إثباتًا.' }) +
        field({ name: 'return_location', label: 'مكان الإرجاع (الساحة / المشغل)', value: ctr.return_location, attrs: ' maxlength="120"' }) +
        field({ name: 'return_status', label: 'حالة الإرجاع', type: 'select', options: opts('container_return_status', ctr.return_status) }) +
        field({ name: 'evidence_document_id', label: 'مستند الإثبات', type: 'select', options: evidenceOptions(c.docs, ctr.evidence_document_id), hint: '✓ = إيصال استلام فارغ مؤكّد (الوحيد المقبول لحالة «أُرجعت»).' }) +
        field({ name: 'returned_at', label: 'تاريخ الإرجاع الفعلي', type: 'datetime-local', value: toLocalInput(ctr.returned_at) }) +
        field({ name: 'waiver_reason', label: 'سبب الاستثناء (عند «لا يلزم إرجاع»)', value: ctr.waiver_reason, attrs: ' maxlength="500"' }) +
        field({ name: 'notes', label: 'ملاحظات', type: 'textarea', rows: 2, value: ctr.notes, attrs: ' maxlength="1000"', full: true })
      ),
      onSubmit: function (form) {
        var row = {
          container_type: nn(fval(form, 'container_type')),
          gate_out_at: fromLocalInput(fval(form, 'gate_out_at')),
          delivered_at: fromLocalInput(fval(form, 'delivered_at')),
          return_deadline: nn(fval(form, 'return_deadline')),
          return_location: nn(fval(form, 'return_location')),
          return_status: fval(form, 'return_status') || 'pending',
          evidence_document_id: nn(fval(form, 'evidence_document_id')),
          returned_at: fromLocalInput(fval(form, 'returned_at')),
          waiver_reason: nn(fval(form, 'waiver_reason')),
          notes: nn(fval(form, 'notes'))
        };
        var ev = row.evidence_document_id ? c.docs.filter(function (d) { return d.id === row.evidence_document_id; })[0] : null;
        if (row.return_status === 'returned_verified') {
          if (!ev || ev.classification !== 'empty_return_receipt' || ['confirmed', 'reclassified'].indexOf(ev.classification_status) === -1) {
            return 'لحالة «أُرجعت» اختر مستندًا مصنّفًا ومؤكّدًا كـ«' + lbl('document_kind', 'empty_return_receipt') + '». صنّف المستند أولًا من جدول المستندات.';
          }
        }
        if ((row.return_status === 'evidence_submitted' || row.return_status === 'disputed') && !row.evidence_document_id) return 'هذه الحالة تتطلب اختيار مستند الإثبات.';
        if (row.return_status === 'waived' && !row.waiver_reason) return 'اكتب سبب الاستثناء.';
        var p;
        if (ctrId) p = api.updateContainer(ctrId, row);
        else {
          var no = String(fval(form, 'container_no') || '').toUpperCase().replace(/[\s-]/g, '');
          if (!/^[A-Z]{4}[0-9]{7}$/.test(no)) return 'رقم الحاوية يجب أن يكون 4 أحرف إنجليزية ثم 7 أرقام.';
          row.container_no = no;
          p = api.addContainer(txId, row);
        }
        return p.then(function (r) {
          if (r.error) return errText(r.error);
          toast(T.common.saved, 'success'); rerender(); return true;
        });
      }
    });
  }

  /* documents */
  function findDoc(txId, id) { var c = TX_CACHE[txId]; return c ? c.docs.filter(function (d) { return d.id === id; })[0] : null; }
  function docOpen(id) {
    var doc = null;
    Object.keys(TX_CACHE).forEach(function (k) { doc = doc || TX_CACHE[k].docs.filter(function (d) { return d.id === id; })[0]; });
    var p = doc ? Promise.resolve({ data: doc }) : local(function (c) { return c.from('documents').select('id,storage_path').eq('id', id).maybeSingle(); });
    // open the tab synchronously (popup blockers), then point it at the signed URL
    var w = window.open('', '_blank');
    if (w) { try { w.opener = null; w.document.title = 'جارٍ فتح المستند…'; } catch (e) { /* ignore */ } }
    p.then(function (r) {
      if (r.error || !r.data) { if (w) w.close(); return toast(r.error ? errText(r.error) : 'المستند غير موجود.', 'error'); }
      return api.documentUrl(r.data, 120).then(function (u) {
        if (u.error || !u.data) { if (w) w.close(); return toast(u.error ? errText(u.error) : 'تعذّر فتح المستند.', 'error'); }
        if (w) { w.location.href = u.data; return; }
        openDialog({ title: 'فتح المستند', noSubmit: true,
          body: '<p class="text-sm">منع المتصفح فتح نافذة جديدة. استخدم الرابط التالي (صالح لدقيقتين):</p><p><a class="btn btn-primary" href="' + esc(u.data) + '" target="_blank" rel="noopener noreferrer">فتح المستند</a></p>' });
      });
    });
  }
  function docClassify(txId, id) {
    var d = findDoc(txId, id); if (!d) return;
    var cur = d.classification || d.kind;
    openDialog({
      title: 'تصنيف المستند', submit: 'حفظ التصنيف',
      body: '<p class="text-sm"><strong>' + esc(d.original_name) + '</strong><br><span class="text-muted">النوع الذي أعلنه الرافع: ' + esc(lbl('document_kind', d.kind)) + '</span></p>' +
        alertBox('info', 'التصنيف قرار الموظف بعد فتح المستند. «' + esc(lbl('document_kind', 'empty_return_receipt')) + '» فقط يثبت إرجاع الحاوية؛ إيصال التسليم (EIR) وتعليمات الإرجاع ليست إثباتًا.', true) +
        grid(
          field({ name: 'classification', label: 'التصنيف', type: 'select', options: opts('document_kind', cur), req: true }) +
          field({ name: 'status', label: 'حالة التصنيف', type: 'select', options: opts('classification_status', d.classification_status === 'unreviewed' ? 'confirmed' : d.classification_status, false, ['confirmed', 'reclassified', 'ambiguous']) }) +
          field({ name: 'note', label: 'ملاحظة', type: 'textarea', rows: 2, value: d.classification_note, attrs: ' maxlength="1000"', full: true })
        ),
      onSubmit: function (form) {
        var cls = fval(form, 'classification'), st = fval(form, 'status');
        if (!cls) return T.common.required;
        if (st === 'confirmed' && cls !== d.kind) st = 'reclassified';
        return api.classifyDocument(id, cls, st, nn(fval(form, 'note'))).then(function (r) {
          if (r.error) return errText(r.error);
          toast('تم حفظ التصنيف.', 'success'); rerender(); return true;
        });
      }
    });
  }
  function docVisibility(txId, id, to) {
    var d = findDoc(txId, id); if (!d) return;
    var ask = to === 'client' ? askConfirm({ title: t('confirm_show_client_title'), text: t('confirm_show_client', { name: d.original_name }), okText: t('confirm_show_client_ok') }) : Promise.resolve(true);
    ask.then(function (yes) {
      if (!yes) return;
      api.setDocumentVisibility(id, to).then(function (r) {
        if (r.error) return toast(errText(r.error), 'error');
        toast(T.common.saved, 'success'); rerender();
      });
    });
  }
  function docVoid(txId, id) {
    var d = findDoc(txId, id); if (!d) return;
    openDialog({
      title: 'إلغاء المستند', submit: 'إلغاء المستند', danger: true,
      body: '<p class="text-sm"><strong>' + esc(d.original_name) + '</strong></p>' + alertBox('warning', 'لا يُحذف الملف الأصلي؛ يُعلَّم كملغى مع السبب ويبقى في السجل.') +
        field({ name: 'reason', label: 'سبب الإلغاء', type: 'textarea', rows: 2, req: true, attrs: ' maxlength="500"', full: true }),
      onSubmit: function (form) {
        var reason = nn(fval(form, 'reason'));
        if (!reason) return T.common.required;
        return api.voidDocument(id, reason).then(function (r) {
          if (r.error) return errText(r.error);
          toast('تم إلغاء المستند.', 'success'); rerender(); return true;
        });
      }
    });
  }
  function docVersion(txId, id) {
    var d = findDoc(txId, id); if (!d) return;
    openDialog({
      title: 'رفع نسخة جديدة', submit: 'رفع النسخة',
      body: '<p class="text-sm">نسخة جديدة من <strong>' + esc(d.original_name) + '</strong> (النسخة الحالية ' + num(d.version) + '). تبقى النسخة السابقة محفوظة.</p>' +
        field({ name: 'file', label: 'الملف', type: 'file', req: true, attrs: ' accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.csv"' }),
      onSubmit: function (form) {
        var f = form.elements.file && form.elements.file.files[0];
        if (!f) return T.common.required;
        return api.uploadDocument({ file: f, transactionId: txId, kind: d.kind, visibility: d.visibility, source: 'staff_scan', supersedesId: d.id }).then(function (r) {
          if (r.error) return errText(r.error);
          toast('تم رفع النسخة الجديدة.', 'success'); rerender(); return true;
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     Clients
     ------------------------------------------------------------------ */
  function renderClients() {
    var f = S.filters.clients;
    var canW = canAny(R.opsWriter);
    return api.listClients({ orgId: S.orgId, search: f.search, active: f.inactive ? false : true, limit: WINDOW, offset: f.offset }).then(function (r) {
      var out = frag(dHead(viewLabel('clients'), t('clients_sub'),
        canW ? [dBtn([svgIcon('plus'), t('client_new')], 'btn-primary', function () { clientDialog(null); })] : null));
      var inactive = el('label', { class: 'check adm-tool-check' }, [el('input', { type: 'checkbox', checked: !!f.inactive,
        onchange: function (e) { f.inactive = e.target.checked; f.offset = 0; listState('clients').page = 0; rerender(); } }), ' ', t('show_inactive')]);
      out.appendChild(listView({
        key: 'clients', rows: r.data || [], total: r.count, error: r.error, serverSearch: true,
        placeholder: t('ph_clients'), empty: t('empty_clients'), tools: [inactive],
        href: function (c) { return '#client/' + c.id; },
        rowClass: function (c) { return c.is_active ? null : 'adm-voided'; },
        text: function (c) { return [c.name_ar, c.name_en, c.cr_number, c.vat_number, c.phone, c.email, c.national_address_short].join(' '); },
        columns: [
          { id: 'name', label: t('col_name'), value: function (c) { return c.name_ar; }, cell: function (c) {
            return [el('a', { class: 'cell-main', href: '#client/' + c.id, text: c.name_ar }), c.name_en ? el('span', { class: 'cell-sub', dir: 'ltr', text: c.name_en }) : null]; } },
          { id: 'type', label: t('col_type'), value: function (c) { return lbl('client_type', c.client_type); }, cell: function (c) { return lbl('client_type', c.client_type); } },
          { id: 'cr', label: t('col_cr'), value: function (c) { return c.cr_number; }, cell: function (c) { return dLtr(c.cr_number); } },
          { id: 'vat', label: t('col_vat'), value: function (c) { return c.vat_number; }, cell: function (c) { return dLtr(c.vat_number); } },
          { id: 'phone', label: t('col_phone'), value: function (c) { return c.phone; }, cell: function (c) { return dLtr(c.phone); } },
          { id: 'addr', label: t('col_short_addr'), value: function (c) { return c.national_address_short; }, cell: function (c) { return dLtr(c.national_address_short); } },
          { id: 'status', label: t('col_status'), value: function (c) { return c.is_active ? 0 : 1; }, cell: function (c) { return c.is_active ? pillNode('success', t('active')) : pillNode('danger', t('inactive')); } }
        ]
      }));
      return out;
    });
  }
  var CLIENT_CACHE = {};
  function renderClient(id) {
    return Promise.all([api.getClient(id), api.listTransactions({ orgId: S.orgId, clientId: id, limit: 50 }), call('listClientAliases', id)]).then(function (res) {
      var r = res[0], c = r.data;
      if (r.error) return head('عميل', '', '', '#clients') + alertBox('danger', errText(r.error));
      if (!c) return head('عميل', '', '', '#clients') + alertBox('warning', 'العميل غير موجود أو لا تملك صلاحية عرضه.');
      CLIENT_CACHE[id] = c;
      var a = c.national_address || {};
      var html = head(esc(c.name_ar), esc(lbl('client_type', c.client_type)) + (c.is_active ? '' : ' · ' + pillHtml('danger', t('inactive'))),
        canAny(R.opsWriter) ? '<button class="btn btn-sm btn-primary" type="button" data-act="client-edit" data-id="' + esc(c.id) + '">' + T.common.edit + '</button>' : '', '#clients');
      html += '<div class="adm-cols">' + card('البيانات الأساسية', kv([
        ['الاسم بالعربية', c.name_ar], ['الاسم بالإنجليزية', c.name_en ? '<bdi dir="ltr">' + esc(c.name_en) + '</bdi>' : T.common.none, true],
        ['جهة الاتصال', c.contact_person], ['التصنيف', c.classification],
        ['السجل التجاري', ltr(c.cr_number), true], ['الرقم الضريبي', ltr(c.vat_number), true],
        ['الجوال', ltr(c.phone), true], ['البريد الإلكتروني', ltr(c.email), true], ['طريقة التواصل', lbl('contact_pref', c.preferred_contact)]
      ])) + card('العنوان الوطني', kv([
        ['العنوان المختصر', ltr(c.national_address_short), true], ['رقم المبنى', a.building_no], ['الشارع', a.street], ['الحي', a.district],
        ['المدينة', a.city], ['الرمز البريدي', a.postal_code], ['الرقم الإضافي', a.additional_no], ['رقم الوحدة', a.unit_no]
      ])) + '</div>';
      if (c.notes) html += card('ملاحظات', '<p class="adm-pre">' + esc(c.notes) + '</p>');
      var tr = res[1];
      html += card('معاملات العميل', tr.error ? alertBox('danger', errText(tr.error)) : table(['المرجع', 'الفرع', 'العملية', 'الحالة التشغيلية', 'التاريخ', ''], (tr.data || []).map(function (t) {
        return '<tr><td>' + ltr(t.ref) + '</td><td>' + esc(t.branches && t.branches.name_ar) + '</td><td>' + esc(lbl('direction', t.operation)) + ' · ' + esc(lbl('mode', t.mode)) + '</td><td>' +
          badge('operational_status', t.operational_status) + '</td><td>' + fmtDate(t.created_at) + '</td><td><a class="btn btn-sm btn-ghost" href="#tx/' + esc(t.id) + '">' + T.common.view + '</a></td></tr>';
      })) + '<p class="form-hint">تظهر فقط معاملات الفروع المسموح لك بها.</p>');
      var tpl = document.createElement('template');
      tpl.innerHTML = html;
      var out = tpl.content;
      out.appendChild(aliasesCard(c, res[2]));
      return out;
    });
  }
  // G3.2 client identity: other spellings of the client's name (B/L, invoice, OCR) used by matchClient.
  // An alias belongs to one client per org (unique alias_norm); removing one never touches transactions.
  var ALIAS_SOURCES = ['manual', 'bl', 'invoice', 'ocr'];
  function aliasesCard(c, ar) {
    var canW = canAny(R.opsWriter);
    var rows = ar && !ar.error ? rowsOf(ar.data) : [];
    var body = [];
    if (ar && ar.error) body.push(dAlert('danger', apiErr(ar.error)));
    else {
      body.push(dTable([t('alias_col'), t('alias_source'), t('alias_added'), ''], rows.map(function (a) {
        return el('tr', null, [
          el('td', null, el('bdi', { text: a.alias || '' })),
          el('td', { text: t('alias_src_' + a.source) !== 'alias_src_' + a.source ? t('alias_src_' + a.source) : (a.source || T.common.none) }),
          el('td', null, [fmtWhen(a.created_at), a.created_by ? el('span', { class: 'adm-sub', text: who(a.created_by) }) : null]),
          el('td', null, canW ? dBtn(t('alias_remove'), 'btn-ghost adm-text-danger', function (b) {
            askConfirm({ title: t('alias_remove'), text: t('alias_remove_q', { a: a.alias || '' }), okText: t('alias_remove'), danger: true }).then(function (yes) {
              if (!yes) return;
              b.disabled = true;
              api.removeClientAlias(a.id).then(function (r) {
                b.disabled = false;
                if (r.error) return toast(apiErr(r.error), 'error');
                toast(t('alias_removed'), 'success'); rerender();
              });
            });
          }) : null)
        ]);
      }), t('alias_empty')));
    }
    if (canW && !(ar && ar.error)) {
      var input = el('input', { class: 'form-control', type: 'text', maxlength: 200, 'aria-label': t('alias_col'), placeholder: t('alias_ph'), autocomplete: 'off' });
      var src = el('select', { class: 'form-control adm-select', 'aria-label': t('alias_source') },
        ALIAS_SOURCES.map(function (k) { return el('option', { value: k, text: t('alias_src_' + k) }); }));
      var add = el('button', { class: 'btn btn-sm btn-primary', type: 'submit', text: t('alias_add') });
      var form = el('form', { class: 'adm-inline-row adm-alias-form', novalidate: true }, [input, src, add]);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        e.stopPropagation();   // not one of the view's [data-form] forms
        var v = nn(input.value);
        if (!v) { input.focus(); return toast(T.common.required, 'warning'); }
        add.disabled = true;
        api.addClientAlias(c.id, v, src.value).then(function (r) {
          add.disabled = false;
          if (r.error) return toast(isAliasTaken(r.error) ? t('alias_duplicate') : apiErr(r.error), 'error');
          toast(t('alias_added_ok'), 'success'); rerender();
        });
      });
      body.push(form);
    }
    body.push(el('p', { class: 'form-hint', text: t('alias_hint') }));
    return dCard(t('alias_title'), body);
  }
  function clientDialog(id) {
    var c = id ? CLIENT_CACHE[id] : { client_type: 'business', is_active: true, national_address: {} };
    if (!c) return;
    var a = c.national_address || {};
    openDialog({
      title: id ? 'تعديل بيانات العميل' : 'عميل جديد', wide: true,
      body: grid(
        field({ name: 'client_type', label: 'نوع العميل', type: 'select', options: opts('client_type', c.client_type), req: true }) +
        field({ name: 'name_ar', label: 'الاسم بالعربية', value: c.name_ar, req: true, attrs: ' maxlength="160" minlength="2"' }) +
        field({ name: 'name_en', label: 'الاسم بالإنجليزية', value: c.name_en, ltr: true, attrs: ' maxlength="160"' }) +
        field({ name: 'contact_person', label: 'جهة الاتصال', value: c.contact_person, attrs: ' maxlength="120"' }) +
        field({ name: 'cr_number', label: 'السجل التجاري', value: c.cr_number, ltr: true, attrs: ' inputmode="numeric" maxlength="10"', hint: '10 أرقام' }) +
        field({ name: 'vat_number', label: 'الرقم الضريبي', value: c.vat_number, ltr: true, attrs: ' inputmode="numeric" maxlength="15"', hint: '15 رقمًا' }) +
        field({ name: 'phone', label: 'الجوال', value: c.phone, ltr: true, type: 'tel', attrs: ' maxlength="10"', hint: 'مثل 0551234567' }) +
        field({ name: 'email', label: 'البريد الإلكتروني', value: c.email, ltr: true, type: 'email', attrs: ' maxlength="160"' }) +
        field({ name: 'preferred_contact', label: 'طريقة التواصل المفضلة', type: 'select', options: opts('contact_pref', c.preferred_contact, 'غير محدد') }) +
        field({ name: 'classification', label: 'تصنيف العميل', value: c.classification, attrs: ' maxlength="60"' }) +
        field({ name: 'national_address_short', label: 'العنوان الوطني المختصر', value: c.national_address_short, ltr: true, attrs: ' maxlength="8"', hint: '4 أحرف ثم 4 أرقام، مثل RRRD2929' }) +
        field({ name: 'a_building_no', label: 'رقم المبنى', value: a.building_no, attrs: ' maxlength="10"' }) +
        field({ name: 'a_street', label: 'الشارع', value: a.street, attrs: ' maxlength="120"' }) +
        field({ name: 'a_district', label: 'الحي', value: a.district, attrs: ' maxlength="120"' }) +
        field({ name: 'a_city', label: 'المدينة', value: a.city, attrs: ' maxlength="80"' }) +
        field({ name: 'a_postal_code', label: 'الرمز البريدي', value: a.postal_code, attrs: ' maxlength="10"' }) +
        field({ name: 'a_additional_no', label: 'الرقم الإضافي', value: a.additional_no, attrs: ' maxlength="10"' }) +
        field({ name: 'a_unit_no', label: 'رقم الوحدة', value: a.unit_no, attrs: ' maxlength="10"' }) +
        field({ name: 'notes', label: 'ملاحظات', type: 'textarea', rows: 2, value: c.notes, attrs: ' maxlength="2000"', full: true }) +
        (id ? field({ name: 'is_active', label: 'العميل نشط', type: 'checkbox', value: c.is_active, full: true }) : '')
      ),
      onSubmit: function (form) {
        var western = function (s) { return s == null ? null : String(s).replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }).replace(/[\s-]/g, ''); };
        var row = {
          client_type: fval(form, 'client_type'), name_ar: nn(fval(form, 'name_ar')), name_en: nn(fval(form, 'name_en')),
          contact_person: nn(fval(form, 'contact_person')), cr_number: western(nn(fval(form, 'cr_number'))), vat_number: western(nn(fval(form, 'vat_number'))),
          phone: western(nn(fval(form, 'phone'))), email: nn(fval(form, 'email')), preferred_contact: nn(fval(form, 'preferred_contact')),
          classification: nn(fval(form, 'classification')),
          national_address_short: nn(fval(form, 'national_address_short')) ? String(fval(form, 'national_address_short')).trim().toUpperCase() : null,
          notes: nn(fval(form, 'notes'))
        };
        var addr = {};
        ['building_no', 'street', 'district', 'city', 'postal_code', 'additional_no', 'unit_no'].forEach(function (k) { var v = nn(fval(form, 'a_' + k)); if (v) addr[k] = v; });
        row.national_address = addr;
        if (id) row.is_active = !!fval(form, 'is_active');
        if (!row.name_ar || row.name_ar.length < 2) return 'اكتب اسم العميل بالعربية.';
        if (row.cr_number && !/^[0-9]{10}$/.test(row.cr_number)) return 'السجل التجاري يجب أن يكون 10 أرقام.';
        if (row.vat_number && !/^[0-9]{15}$/.test(row.vat_number)) return 'الرقم الضريبي يجب أن يكون 15 رقمًا.';
        if (row.phone && !/^0[0-9]{9}$/.test(row.phone)) return 'رقم الجوال يجب أن يبدأ بـ 0 ويتكون من 10 أرقام.';
        if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(row.email)) return 'البريد الإلكتروني غير صحيح.';
        if (row.national_address_short && !/^[A-Z]{4}[0-9]{4}$/.test(row.national_address_short)) return 'العنوان المختصر يجب أن يكون 4 أحرف إنجليزية ثم 4 أرقام.';
        var p;
        if (id) p = api.updateClient(id, row);
        else { row.org_id = S.orgId; p = api.createClient(row); }
        return p.then(function (r) {
          if (r.error) return r.error.code === 'DUPLICATE' ? 'يوجد عميل بنفس السجل التجاري أو الرقم الضريبي.' : errText(r.error);
          toast(T.common.saved, 'success');
          if (!id && r.data) go('#client/' + r.data.id); else rerender();
          return true;
        });
      }
    });
  }

  /* ------------------------------------------------------------------
     Contact messages
     ------------------------------------------------------------------ */
  var MSG_CACHE = {};
  function renderMessages() {
    var f = S.filters.messages;
    return api.listContactMessages({ orgId: S.orgId, status: f.status || null, limit: WINDOW, offset: f.offset }).then(function (r) {
      var out = frag(dHead(viewLabel('messages'), t('messages_sub')));
      (r.data || []).forEach(function (m) { MSG_CACHE[m.id] = m; });
      out.appendChild(listView({
        key: 'messages', rows: r.data || [], total: r.count, error: r.error,
        placeholder: t('ph_messages'), empty: t('empty_messages'),
        tools: [filterSelect('messages', 'status', t('col_status'), statusOptions('contact_status'))],
        open: function (m) { msgView(m.id); },
        text: function (m) { return [m.ref, m.name, m.company, m.email, m.phone, lbl('subject', m.subject)].join(' '); },
        columns: [
          { id: 'ref', label: t('col_ref'), value: function (m) { return m.ref; }, cell: function (m) {
            return el('button', { class: 'adm-ref btn-link', type: 'button', 'data-act': 'msg-view', 'data-id': m.id }, el('bdi', { dir: 'ltr', text: m.ref || '—' })); } },
          { id: 'date', label: t('col_date'), desc: true, value: function (m) { return ts(m.created_at); }, cell: function (m) { return fmtWhen(m.created_at); } },
          { id: 'from', label: t('col_sender'), value: function (m) { return m.name; }, cell: function (m) { return twoLine(m.name, m.company); } },
          { id: 'subject', label: t('col_subject'), value: function (m) { return lbl('subject', m.subject); }, cell: function (m) { return lbl('subject', m.subject); } },
          { id: 'pref', label: t('col_pref'), value: function (m) { return lbl('contact_pref', m.preferred); }, cell: function (m) { return lbl('contact_pref', m.preferred); } },
          { id: 'status', label: t('col_status'), value: function (m) { return (ORDER.contact_status || []).indexOf(m.status); }, cell: function (m) { return badgeNode('contact_status', m.status); } }
        ]
      }));
      return out;
    });
  }
  function msgView(id) {
    var m = MSG_CACHE[id]; if (!m) return;
    L.profiles([m.handled_by]).then(function () {
      openDialog({
        title: 'رسالة ' + m.ref, wide: true, submit: m.status === 'closed' ? 'إعادة فتح' : 'تمت المعالجة',
        body: kv([
          ['الاسم', m.name], ['الشركة', m.company], ['الجوال', ltr(m.phone), true], ['البريد الإلكتروني', ltr(m.email), true],
          ['الموضوع', lbl('subject', m.subject)], ['رقم مرجعي ذكره المرسل', ltr(m.reference), true],
          ['التواصل المفضل', lbl('contact_pref', m.preferred)], ['التاريخ', fmtDateTime(m.created_at), true],
          ['الحالة', badge('contact_status', m.status) + (m.handled_by ? ' — ' + esc(who(m.handled_by)) + '، ' + fmtDateTime(m.handled_at) : ''), true]
        ]) + '<div class="adm-message adm-pre">' + esc(m.message) + '</div>' +
          (m.status === 'new' ? '<div class="btn-group mt-2"><button class="btn btn-sm btn-ghost" type="button" data-dlg="msg-progress">بدء المعالجة</button></div>' : ''),
        onOpen: function (body) {
          var b = body.querySelector('[data-dlg=msg-progress]');
          if (b) b.addEventListener('click', function () {
            api.setContactStatus(id, 'in_progress').then(function (r) {
              if (r.error) return dialogError(errText(r.error));
              toast('الرسالة قيد المعالجة.', 'success'); closeDialog(); rerender();
            });
          });
        },
        onSubmit: function () {
          return api.setContactStatus(id, m.status === 'closed' ? 'in_progress' : 'closed').then(function (r) {
            if (r.error) return errText(r.error);
            toast(T.common.saved, 'success'); rerender(); return true;
          });
        }
      });
    });
  }

  /* ------------------------------------------------------------------
     Import batches
     ------------------------------------------------------------------ */
  function renderImports() {
    var f = S.filters.imports;
    return L.listImportBatches(f).then(function (r) {
      var out = frag(dHead(viewLabel('imports'), t('imports_sub'), [el('a', { class: 'btn btn-sm btn-primary', href: 'bulk-upload.html' }, [svgIcon('plus'), t('imports_new')])]));
      out.appendChild(listView({
        key: 'imports', rows: r.data || [], total: r.count, error: r.error, serverSearch: true,
        placeholder: t('ph_imports'), empty: t('empty_imports'),
        tools: [filterSelect('imports', 'status', t('col_status'), statusOptions('batch_status'))],
        href: function (b) { return '#import/' + b.id; },
        text: function (b) { return [b.ref, b.file_name, b.clients && b.clients.name_ar, lbl('batch_status', b.status)].join(' '); },
        columns: [
          { id: 'ref', label: t('col_ref'), value: function (b) { return b.ref; }, cell: function (b) { return refCell(b.ref, '#import/' + b.id); } },
          { id: 'file', label: t('col_file'), value: function (b) { return b.file_name; }, cell: function (b) { return [el('bdi', { class: 'cell-main', text: b.file_name || '—' }), el('span', { class: 'cell-sub', text: fmtSize(b.file_size) })]; } },
          { id: 'client', label: t('col_client'), value: function (b) { return b.clients && b.clients.name_ar; }, cell: function (b) { return b.clients ? b.clients.name_ar : null; } },
          { id: 'rows', label: t('col_rows'), num: true, value: function (b) { return b.total_rows; }, cell: function (b) { return el('span', { class: 'num', text: fmtCount(b.total_rows) }); } },
          { id: 'ok', label: t('col_committed'), num: true, value: function (b) { return b.committed_rows; }, cell: function (b) { return el('span', { class: 'num', text: fmtCount(b.committed_rows) }); } },
          { id: 'skip', label: t('col_skipped'), num: true, value: function (b) { return b.skipped_rows; }, cell: function (b) { return el('span', { class: 'num', text: fmtCount(b.skipped_rows) }); } },
          { id: 'status', label: t('col_status'), value: function (b) { return b.status; }, cell: function (b) { return badgeNode('batch_status', b.status); } },
          { id: 'date', label: t('col_date'), desc: true, value: function (b) { return ts(b.created_at); }, cell: function (b) { return fmtWhen(b.created_at); } }
        ]
      }));
      return out;
    });
  }
  function renderImport(id) {
    return Promise.all([L.getImportBatch(id), api.listImportRows(id)]).then(function (res) {
      var b = res[0].data;
      if (res[0].error) return head('دفعة', '', '', '#imports') + alertBox('danger', errText(res[0].error));
      if (!b) return head('دفعة', '', '', '#imports') + alertBox('warning', 'الدفعة غير موجودة أو لا تملك صلاحية عرضها.');
      var rows = res[1].data || [];
      return L.profiles([b.created_by, b.committed_by]).then(function () {
        var canW = canAny(R.opsWriter) && b.status === 'draft';
        var actions = canW ? '<button class="btn btn-sm btn-primary" type="button" data-act="imp-commit" data-id="' + esc(b.id) + '">اعتماد الصفوف الصالحة</button>' +
          '<button class="btn btn-sm btn-secondary adm-btn-danger" type="button" data-act="imp-cancel" data-id="' + esc(b.id) + '">إلغاء الدفعة</button>' : '';
        var html = head('دفعة ' + ltr(b.ref), '<bdi>' + esc(b.file_name) + '</bdi> · ' + badge('batch_status', b.status), actions, '#imports');
        html += '<div class="adm-cols">' + card('بيانات الدفعة', kv([
          ['الملف', '<bdi>' + esc(b.file_name) + '</bdi> (' + fmtSize(b.file_size) + ')', true],
          ['بصمة الملف (SHA-256)', '<code class="adm-hash" dir="ltr">' + esc(b.file_fingerprint) + '</code>', true],
          ['الأوراق', (b.sheet_names || []).join('، ')], ['العميل', b.clients ? b.clients.name_ar : T.common.none],
          ['أنشأها', who(b.created_by) + ' · ' + fmtDateTime(b.created_at)],
          ['اعتمدها', b.committed_by ? who(b.committed_by) + ' · ' + fmtDateTime(b.committed_at) : T.common.none]
        ])) + card('الملخص', kv([
          ['إجمالي الصفوف', num(b.total_rows || rows.length), true], ['تحوّل إلى طلبات', num(b.committed_rows), true], ['تم تجاهله', num(b.skipped_rows), true],
          ['به أخطاء', num(rows.filter(function (x) { return x.row_status === 'error'; }).length), true],
          ['مكرر محتمل', num(rows.filter(function (x) { return x.row_status === 'duplicate'; }).length), true]
        ]) + '<p class="form-hint">الصفوف المكررة تحتاج قرارًا بشريًا من صفحة الرفع الجماعي قبل الاعتماد.</p>') + '</div>';
        html += card('الصفوف', res[1].error ? alertBox('danger', errText(res[1].error)) : table(['الورقة', 'الصف', 'معرّف المصدر', 'الحالة', 'القرار', 'الأخطاء', 'مكرر من'], rows.map(function (x) {
          var errs = Array.isArray(x.validation_errors) ? x.validation_errors : [];
          return '<tr><td>' + esc(x.sheet_name || T.common.none) + '</td><td>' + num(x.row_no) + '</td><td><code class="adm-hash" dir="ltr" title="' + esc(x.source_row_id) + '">' + esc(String(x.source_row_id || '').slice(0, 12) + '…' + String(x.source_row_id || '').split(':').slice(1).join(':')) + '</code></td><td>' +
            badge('import_row_status', x.row_status) + '</td><td>' + esc(x.decision === 'accept' ? 'قبول' : x.decision === 'skip' ? 'تجاهل' : T.common.none) + '</td><td>' +
            (errs.length ? errs.map(function (e) { return esc(api.i18n && api.i18n.ar.errors[e.code] ? api.i18n.ar.errors[e.code].replace('{f}', (api.i18n.ar.fields[e.field] || e.field || '')) : (e.message || e.code || '')); }).join('<br>') : T.common.none) +
            (Array.isArray(x.corrections) && x.corrections.length ? '<span class="adm-sub">صُحّح ' + num(x.corrections.length) + ' مرة</span>' : '') +
            '</td><td>' + ltr(x.duplicate_of) + '</td></tr>';
        })));
        return html;
      });
    });
  }
  function impCommit(id) {
    openDialog({
      title: 'اعتماد الدفعة', submit: 'اعتماد',
      body: alertBox('info', 'ستتحول الصفوف الصالحة إلى طلبات خدمة. الصفوف التي بها أخطاء أو مكررة تبقى بانتظار القرار، ولا يُستورد أي صف مرتين.'),
      onSubmit: function () {
        return api.importCommit(id).then(function (r) {
          if (r.error) return errText(r.error);
          var d = r.data || {}, items = d.items || [];
          openDialog({
            title: 'نتيجة الاعتماد', noSubmit: true, wide: true,
            body: kv([['تحوّل إلى طلبات', num(d.committed != null ? d.committed : items.length), true], ['تم تجاهله', num(d.skipped), true],
              ['مكرر محتمل', num(d.duplicates), true], ['به أخطاء', num(d.errors), true]]) +
              (items.length ? alertBox('warning', 'رموز التتبع تظهر هنا مرة واحدة فقط. انسخها الآن إن كنت ستسلّمها للعميل.') +
                table(['الصف', 'مرجع الطلب', 'رمز التتبع'], items.map(function (it) {
                  return '<tr><td>' + esc(it.sheet || '') + ' / ' + num(it.row_no) + '</td><td>' + ltr(it.ref) + '</td><td><code dir="ltr">' + esc(it.tracking_token) + '</code></td></tr>';
                })) : '')
          });
          rerender();
          return false;
        });
      }
    });
  }
  function impCancel(id) {
    askConfirm({ title: t('confirm_cancel_batch_title'), text: t('confirm_cancel_batch'), okText: t('confirm_cancel_batch_ok'), danger: true }).then(function (yes) {
      if (!yes) return;
      api.cancelImportBatch(id).then(function (r) {
        if (r.error) return toast(errText(r.error), 'error');
        toast(t('batch_cancelled'), 'success'); rerender();
      });
    });
  }

  /* ==================================================================
     G2 console: org settings, branches, members & invitations, audit
     log, client errors, active-org switcher.
     Every server/user value goes in through textContent / attributes on
     nodes built with el(); innerHTML is used only for icon() constants.
     MarsaApi G2 functions are called through call() so a missing one
     shows a clear error instead of throwing.
     ================================================================== */
  function t(k, vars) {
    var I = window.MarsaI18n, key = 'admin.' + k;
    if (!I || typeof I.t !== 'function') return k;
    var s = I.t(key, vars);
    return s === key ? k : s;
  }
  // same as t(); for scopes where a local `t` (a transaction row) shadows the helper
  function tl(k, vars) { return t(k, vars); }
  function viewLabel(id) {
    var k = 'view_' + id, s = t(k);
    if (s !== k) return s;
    var ov = !T.views[id] && opsView(id), I = window.MarsaI18n;
    if (ov && ov.titleKey && I && typeof I.t === 'function') { var x = I.t(ov.titleKey); if (x && x !== ov.titleKey) return x; }
    return T.views[id] || id;
  }
  function isEn() { var I = window.MarsaI18n; return !!(I && typeof I.lang === 'function' && I.lang() === 'en'); }
  function roleLabel(code) { var k = 'role_' + code, s = t(k); return isEn() && s !== k ? s : lbl('role', code); }
  function branchName(id) {
    var b = S.branches.filter(function (x) { return x.id === id; })[0];
    return b ? ((isEn() && b.name_en) || b.name_ar) : null;
  }

  // --- DOM helpers ---------------------------------------------------
  var BOOL_PROPS = { hidden: 1, disabled: 1, checked: 1, required: 1, readOnly: 1, selected: 1, multiple: 1 };
  function append(n, kids) {
    (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) return append(n, c);
      n.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    });
    return n;
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag), value;
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'value') value = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (BOOL_PROPS[k]) n[k] = true;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    append(n, kids);
    if (value !== undefined) n.value = String(value);   // after <option>s exist
    return n;
  }
  function frag(kids) { return append(document.createDocumentFragment(), kids); }
  function svgIcon(name) { var tpl = document.createElement('template'); tpl.innerHTML = icon(name); return tpl.content.firstChild; }  // constant markup
  function dBtn(label, cls, onClick, attrs) {
    var a = Object.assign({ class: 'btn btn-sm ' + (cls || 'btn-ghost'), type: 'button' }, attrs || {});
    var b = el('button', a, label);
    if (onClick) b.addEventListener('click', function (e) { e.preventDefault(); onClick(b, e); });
    return b;
  }
  function dHead(title, sub, actions) {
    return el('div', { class: 'adm-head' }, [
      el('div', { class: 'adm-head-title' }, el('div', null, [el('h2', { class: 'adm-title', text: title }), sub ? el('p', { class: 'text-sm text-muted', text: sub }) : null])),
      actions && actions.length ? el('div', { class: 'btn-group adm-head-actions' }, actions) : null
    ]);
  }
  function dCard(title, body, actions, cls) {
    return el('div', { class: 'card card-flush adm-card' + (cls ? ' ' + cls : '') }, [
      el('div', { class: 'card-header' }, [el('h3', { text: title }), actions && actions.length ? el('div', { class: 'btn-group' }, actions) : null]),
      el('div', { class: 'card-body' }, body)
    ]);
  }
  function dAlert(type, text) {
    return el('div', { class: 'alert alert-' + type, role: type === 'danger' ? 'alert' : 'status' }, [svgIcon('info'), el('div', { text: text })]);
  }
  function dBadge(tone, text) { return pillNode(TONE[tone] || tone, text); }
  function dLtr(v) { return v ? el('bdi', { dir: 'ltr', class: 'num', text: v }) : T.common.none; }
  function dKv(rows) {
    return el('ul', { class: 'kv' }, rows.filter(Boolean).map(function (r) {
      var v = r[1];
      return el('li', null, [el('span', { class: 'k', text: r[0] }), el('span', { class: 'v' }, v == null || v === '' ? T.common.none : v)]);
    }));
  }
  function dTable(headers, rows, emptyText) {
    var body = el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: headers.length, class: 'adm-empty', text: emptyText || T.common.empty })));
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table table-striped adm-table' }, [
      el('thead', null, el('tr', null, headers.map(function (h) { return el('th', { scope: 'col', text: h }); }))), body
    ]));
  }
  function dField(o) {
    // o: {name, label, type, value, req, hint, options:[[value,label]], full, ltr, readOnly, max, placeholder, rows, autocomplete}
    var id = 'adg-' + o.name, ctl;
    if (o.type === 'checkbox') {
      return el('div', { class: 'form-group' + (o.full ? ' adm-full' : '') }, [
        el('label', { class: 'check' }, [el('input', { type: 'checkbox', id: id, name: o.name, checked: !!o.value }), ' ', o.label]),
        o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null
      ]);
    }
    var common = { class: 'form-control', id: id, name: o.name, required: !!o.req, dir: o.ltr ? 'ltr' : null, placeholder: o.placeholder || null };
    if (o.type === 'select') {
      ctl = el('select', common, (o.options || []).map(function (p) { return el('option', { value: p[0], text: p[1] }); }));
      ctl.value = o.value == null ? '' : String(o.value);
    } else if (o.type === 'textarea') {
      ctl = el('textarea', Object.assign(common, { rows: o.rows || 2, maxlength: o.max || null }));
      ctl.value = o.value == null ? '' : String(o.value);
    } else {
      ctl = el('input', Object.assign(common, {
        type: o.type || 'text', maxlength: o.max || null, readOnly: !!o.readOnly, autocomplete: o.autocomplete || null,
        value: o.value == null ? '' : o.value
      }));
    }
    return el('div', { class: 'form-group' + (o.full ? ' adm-full' : '') }, [
      el('label', { class: 'form-label', for: id }, [o.label, o.req ? el('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null]),
      ctl, o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null
    ]);
  }
  function dGrid(kids) { return el('div', { class: 'adm-form-grid' }, kids); }
  function fmtWhen(v, withTime) {
    if (!v) return T.common.none;
    var d = new Date(v); if (isNaN(d)) return String(v);
    var I = window.MarsaI18n;
    if (I && typeof I.fmtDate === 'function') { try { return I.fmtDate(d, { time: !!withTime }); } catch (e) { /* fall through */ } }
    try {
      return d.toLocaleString(isEn() ? 'en-GB' : DATE_LOCALE, withTime ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) { return d.toISOString().replace('T', ' ').slice(0, withTime ? 16 : 10); }
  }

  // --- API plumbing --------------------------------------------------
  function call(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (!api || typeof api[name] !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', message: t('api_missing', { fn: name }) } });
    return Promise.resolve().then(function () { return api[name].apply(api, args); }).then(function (r) {
      return r && typeof r === 'object' && ('data' in r || 'error' in r) ? r : { data: r == null ? null : r, error: null };
    }, function (e) { return { data: null, error: { message: errText(e) } }; });
  }
  function rowsOf(d) { return Array.isArray(d) ? d : (d && (d.rows || d.items || d.data)) || []; }
  function errCode(e) {
    if (!e) return null;
    if (e.code && /^MRS_/.test(e.code)) return e.code;
    var m = e.raw && e.raw.message;
    return /^MRS_[A-Z_]+$/.test(m || '') ? m : (e.code || null);
  }
  function errField(e) { return e ? (e.field || (e.raw && (e.raw.details || e.raw.detail)) || null) : null; }
  // client_aliases: the trigger refuses a taken alias as MRS_INVALID 'alias_taken' (the unique index → DUPLICATE)
  function isAliasTaken(e) { return errCode(e) === 'DUPLICATE' || (errCode(e) === 'MRS_INVALID' && errField(e) === 'alias_taken'); }
  // rough client-side form of app.norm_name (letters / digits, Arabic letter variants folded) — only to tell
  // "already this client's alias" apart from "another client's"; the server stays the authority
  function aliasKey(v) {
    return String(v == null ? '' : v).toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/[^0-9a-z\u0621-\u064a]+/g, '');
  }
  function isForbidden(e) { var c = errCode(e); return c === 'MRS_FORBIDDEN' || c === 'RLS' || c === 'MRS_RLS' || c === '42501'; }
  function apiErr(e) {
    var c = errCode(e);
    if (c === 'MRS_UNKNOWN_RESULT') return t('unknown_result');
    if (c === 'MRS_IN_PROGRESS') return t('in_progress');
    if (c === 'MRS_IDEMPOTENCY_CONFLICT') return t('idem_conflict');
    if (c === 'MRS_UNAVAILABLE') return e.message;
    if (isForbidden(e)) return t('forbidden');
    return errText(e);
  }
  // Idempotency: one key per scope, kept while the payload is unchanged and the
  // last answer was not definite (MRS_UNKNOWN_RESULT / MRS_IN_PROGRESS), so a
  // retry after a lost response replays instead of creating a duplicate.
  var IDEM = {};
  function newKey() {
    if (api && typeof api.newIdemKey === 'function') return api.newIdemKey();
    if (api && api.util && api.util.uuid) return api.util.uuid();
    return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : null;
  }
  function idemKey(scope, payload) {
    var sig = JSON.stringify(payload), c = IDEM[scope];
    if (!c || c.sig !== sig) c = IDEM[scope] = { sig: sig, key: newKey() };
    return c.key;
  }
  function idemSettle(scope, err) {
    var c = errCode(err);
    if (c !== 'MRS_UNKNOWN_RESULT' && c !== 'MRS_IN_PROGRESS') delete IDEM[scope];
  }

  // --- roles ---------------------------------------------------------
  var BM_MANAGED = ['clearance_staff', 'transport_staff', 'accountant'];
  var INVITE_ROLES_ADMIN = ['admin', 'supervisor', 'operations_manager', 'branch_manager', 'accounts_manager', 'accountant', 'clearance_staff', 'transport_staff', 'client'];
  function isOrgAdmin() { return S.memberships.some(function (m) { return m.role === 'admin' && !m.branch_id; }); }
  function managedBranches() {
    return S.memberships.filter(function (m) { return m.role === 'branch_manager' && m.branch_id; }).map(function (m) { return m.branch_id; });
  }
  function inviteRoles() { return isOrgAdmin() ? INVITE_ROLES_ADMIN : (managedBranches().length ? BM_MANAGED.concat(['client']) : []); }
  function isMe(m) { return !!(m.is_me || (S.ctx && m.user_id === S.ctx.user_id)); }
  function canManageMember(m) {
    if (isMe(m)) return false;
    if (isOrgAdmin()) return true;
    return BM_MANAGED.indexOf(m.role) !== -1 && managedBranches().indexOf(m.branch_id) !== -1;
  }
  function refreshBranches() {
    return api.listBranches(S.orgId).then(function (r) {
      if (!r.error) S.branches = (r.data || []).filter(function (b) { return b.org_id === S.orgId; });
      return r;
    });
  }

  /* ------------------------------------------------------------------
     المؤسسة — org identity & settings (admin_update_org whitelist)
     ------------------------------------------------------------------ */
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function renderOrg() {
    return L.getOrgRow(S.orgId).then(function (r) {
      var out = frag(dHead(t('org_title'), t('org_sub')));
      if (r.error) return append(out, dAlert('danger', apiErr(r.error)));
      var o = r.data;
      if (!o) return append(out, dAlert('warning', t('org_not_found')));
      var st = o.settings && typeof o.settings === 'object' ? o.settings : {};
      out.appendChild(dCard(t('org_identity'), dKv([
        [t('f_slug'), dLtr(o.slug)], [t('f_ref_prefix'), dLtr(o.ref_prefix)],
        [t('f_environment'), dBadge('warning', o.environment === 'staging' ? t('env_staging') : String(o.environment || ''))],
        [t('f_status'), o.is_active ? dBadge('success', t('active')) : dBadge('danger', t('suspended'))]
      ])));

      var swatch = el('span', { class: 'adm-swatch', 'aria-hidden': 'true' });
      var msg = el('p', { class: 'form-error', role: 'alert', hidden: true });
      var saveBtn = el('button', { class: 'btn btn-primary', type: 'submit', text: T.common.save });
      var form = el('form', { class: 'adm-org-form', novalidate: true }, [
        dGrid([
          dField({ name: 'name_ar', label: t('f_name_ar'), value: o.name_ar, req: true, max: 160 }),
          dField({ name: 'name_en', label: t('f_name_en'), value: o.name_en, ltr: true, max: 160 }),
          dField({ name: 'default_locale', label: t('f_default_locale'), type: 'select', value: o.default_locale || 'ar', options: [['ar', t('locale_ar')], ['en', t('locale_en')]] }),
          dField({ name: 'brand_color', label: t('f_brand_color'), value: st.brand_color, ltr: true, max: 7, placeholder: '#0B3A6E', hint: t('f_brand_color_hint') }),
          dField({ name: 'contact_phone', label: t('f_contact_phone'), value: st.contact_phone, ltr: true, max: 30, type: 'tel' }),
          dField({ name: 'contact_email', label: t('f_contact_email'), value: st.contact_email, ltr: true, max: 160, type: 'email' }),
          dField({ name: 'address_ar', label: t('f_address_ar'), value: st.address_ar, type: 'textarea', max: 300 }),
          dField({ name: 'address_en', label: t('f_address_en'), value: st.address_en, type: 'textarea', max: 300, ltr: true }),
          dField({ name: 'logo_path', label: t('f_logo_path'), value: st.logo_path, ltr: true, max: 300, hint: t('f_logo_path_hint'), full: true }),
          dField({ name: 'public_intake_enabled', label: t('f_public_intake'), type: 'checkbox', value: o.public_intake_enabled !== false, hint: t('f_public_intake_hint'), full: true })
        ]),
        msg, el('div', { class: 'btn-group' }, saveBtn)
      ]);
      var colorIn = form.elements.brand_color;
      var paint = function () { swatch.style.backgroundColor = HEX_RE.test(colorIn.value.trim()) ? colorIn.value.trim() : 'transparent'; };
      var colorGrp = colorIn.parentNode, colorHint = colorGrp.querySelector('.form-hint');
      colorGrp.insertBefore(el('div', { class: 'adm-inline-row' }, [colorIn, swatch]), colorHint);
      colorIn.addEventListener('input', paint); paint();

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        msg.hidden = true;
        var v = function (n) { return nn(form.elements[n].value); };
        var nameAr = v('name_ar'), color = v('brand_color'), mail = v('contact_email');
        var bad = !nameAr || nameAr.length < 2 ? t('err_name_ar') : (color && !HEX_RE.test(color) ? t('err_brand_color') : (mail && !EMAIL_RE.test(mail) ? t('email_invalid') : null));
        if (bad) { msg.textContent = bad; msg.hidden = false; return; }
        var payload = {
          name_ar: nameAr, name_en: v('name_en'), default_locale: form.elements.default_locale.value === 'en' ? 'en' : 'ar',
          public_intake_enabled: !!form.elements.public_intake_enabled.checked,
          settings: {
            brand_color: color, contact_phone: v('contact_phone'), contact_email: mail ? mail.toLowerCase() : null,
            address_ar: v('address_ar'), address_en: v('address_en'), logo_path: v('logo_path')
          }
        };
        saveBtn.disabled = true;
        call('updateOrg', S.orgId, payload).then(function (res) {
          saveBtn.disabled = false;
          if (res.error) { msg.textContent = apiErr(res.error); msg.hidden = false; return; }
          toast(T.common.saved, 'success'); rerender();
        });
      });
      out.appendChild(dCard(t('org_settings'), [dAlert('info', t('org_settings_info')), form]));
      return out;
    });
  }

  /* ------------------------------------------------------------------
     الفروع — list / add / edit / deactivate (code immutable after create)
     ------------------------------------------------------------------ */
  var BRANCH_CODE_RE = /^[A-Z0-9]{2,10}$/;
  function renderBranches() {
    return refreshBranches().then(function (r) {
      var out = frag(dHead(t('branches_title'), t('branches_sub'), [dBtn([svgIcon('plus'), t('branch_add')], 'btn-primary', function () { branchDialog(null); })]));
      if (r.error) return append(out, dAlert('danger', apiErr(r.error)));
      var list = S.branches.slice();
      var activeCount = list.filter(function (b) { return b.is_active; }).length;
      out.appendChild(dTable([t('f_code'), t('f_name_ar'), t('f_name_en'), t('f_city'), t('f_status'), ''], list.map(function (b) {
        var last = b.is_active && activeCount <= 1;
        var toggle = dBtn(b.is_active ? t('deactivate') : t('activate'), 'btn-ghost' + (b.is_active ? ' adm-text-danger' : ''), function (btn) { branchToggle(b, !b.is_active, btn); },
          { disabled: last, title: last ? t('last_branch') : null });
        return el('tr', { class: b.is_active ? null : 'adm-voided' }, [
          el('td', null, dLtr(b.code)), el('td', null, el('strong', { text: b.name_ar })), el('td', null, b.name_en ? el('bdi', { dir: 'ltr', text: b.name_en }) : T.common.none),
          el('td', { text: b.city || T.common.none }),
          el('td', null, b.is_active ? dBadge('success', t('active')) : dBadge('danger', t('inactive'))),
          el('td', null, el('div', { class: 'adm-row-actions' }, [dBtn(T.common.edit, 'btn-ghost', function () { branchDialog(b); }), toggle]))
        ]);
      }), t('branches_empty')));
      return out;
    });
  }
  function branchDialog(b) {
    openDialog({
      title: b ? t('branch_edit') : t('branch_add'), submit: b ? T.common.save : t('create'), body: '',
      onOpen: function (body) {
        body.appendChild(dGrid([
          dField({ name: 'code', label: t('f_code'), value: b ? b.code : '', req: !b, readOnly: !!b, ltr: true, max: 10, placeholder: 'JED', hint: b ? t('code_readonly') : t('code_hint') }),
          dField({ name: 'city', label: t('f_city'), value: b ? b.city : '', max: 80 }),
          dField({ name: 'name_ar', label: t('f_name_ar'), value: b ? b.name_ar : '', req: true, max: 120 }),
          dField({ name: 'name_en', label: t('f_name_en'), value: b ? b.name_en : '', ltr: true, max: 120 })
        ]));
      },
      onSubmit: function (form) {
        var nameAr = nn(fval(form, 'name_ar'));
        if (!nameAr || nameAr.length < 2) return t('err_name_ar');
        var payload = { name_ar: nameAr, name_en: nn(fval(form, 'name_en')), city: nn(fval(form, 'city')) };
        var p;
        if (b) p = call('updateBranch', b.id, payload);
        else {
          var code = String(fval(form, 'code') || '').trim().toUpperCase();
          if (!BRANCH_CODE_RE.test(code)) return t('err_code');
          payload.code = code;
          p = call('createBranch', S.orgId, payload);
        }
        return p.then(function (r) {
          if (r.error) return errCode(r.error) === 'DUPLICATE' ? t('branch_dup') : apiErr(r.error);
          toast(b ? T.common.saved : t('branch_created'), 'success');
          return refreshBranches().then(function () { rerender(); return true; });
        });
      }
    });
  }
  function branchToggle(b, to, btn) {
    (to ? Promise.resolve(true) : askConfirm({ title: t('deactivate'), text: t('branch_deactivate_confirm'), okText: t('deactivate'), danger: true })).then(function (yes) {
      if (!yes) return;
      btn.disabled = true;
      call('updateBranch', b.id, { is_active: !!to }).then(function (r) {
        btn.disabled = false;
        if (r.error) return toast(errCode(r.error) === 'MRS_FORBIDDEN' && errField(r.error) === 'last_branch' ? t('last_branch') : apiErr(r.error), 'error');
        toast(T.common.saved, 'success');
        refreshBranches().then(rerender);
      });
    });
  }

  /* ------------------------------------------------------------------
     الأعضاء والدعوات — org admin: all; branch_manager: own branch;
     supervisor: read-only member names (as before G2)
     ------------------------------------------------------------------ */
  function renderMembers() {
    var manage = isOrgAdmin() || managedBranches().length > 0;
    if (!manage) {
      return api.listMemberships(S.orgId).then(function (r) {
        var out = frag(dHead(viewLabel('members'), t('members_sub_read')));
        if (r.error) return append(out, dAlert(isForbidden(r.error) ? 'warning' : 'danger', apiErr(r.error)));
        var list = (r.data || []).map(function (m) {
          return { id: m.id, user_id: m.user_id, full_name: m.profiles && m.profiles.full_name, phone: m.profiles && m.profiles.phone, role: m.role, branch_id: m.branch_id, is_active: m.is_active, created_at: m.created_at };
        });
        return append(out, membersTable(list, false));
      });
    }
    return Promise.all([L.adminListMembers(S.orgId), call('listInvitations', S.orgId)]).then(function (res) {
      var out = frag(dHead(viewLabel('members'), isOrgAdmin() ? t('members_sub_admin') : t('members_sub_bm'),
        [dBtn([svgIcon('plus'), t('invite_btn')], 'btn-primary', function () { inviteDialog(); })]));
      var m = res[0], inv = res[1];
      out.appendChild(dCard(t('members_card'), m.error ? dAlert(isForbidden(m.error) ? 'warning' : 'danger', apiErr(m.error)) : membersTable(rowsOf(m.data), true)));
      var allToggle = el('label', { class: 'check adm-voided-toggle' }, [el('input', { type: 'checkbox', checked: S.g2.allInvites, onchange: function (e) { S.g2.allInvites = e.target.checked; rerender(); } }), ' ', t('invites_show_all')]);
      out.appendChild(dCard(t('invites_card'), inv.error ? dAlert(isForbidden(inv.error) ? 'warning' : 'danger', apiErr(inv.error)) : invitesTable(rowsOf(inv.data)), [allToggle]));
      return out;
    });
  }
  function membersTable(list, manage) {
    return dTable([t('col_user'), manage ? t('col_email') : t('col_phone'), t('col_role'), t('col_branch'), t('f_status'), t('col_since'), ''], list.map(function (m) {
      var me = isMe(m), act = null;
      if (manage && canManageMember(m)) {
        act = dBtn(m.is_active ? t('deactivate') : t('activate'), 'btn-ghost' + (m.is_active ? ' adm-text-danger' : ''), function (btn) { memberToggle(m, !m.is_active, btn); });
      }
      return el('tr', { class: m.is_active ? null : 'adm-voided' }, [
        el('td', null, [el('strong', { text: m.full_name || t('no_name') }), me ? [' ', dBadge('teal', t('you'))] : null]),
        el('td', null, dLtr(manage ? m.email : m.phone)),
        el('td', { text: (isEn() ? m.role_label_en : m.role_label_ar) || roleLabel(m.role) }),
        el('td', { text: m.branch_id ? (m.branch_name_ar && !isEn() ? m.branch_name_ar : (branchName(m.branch_id) || m.branch_code || t('branch_specific'))) : t('all_branches') }),
        el('td', null, m.is_active ? dBadge('success', t('active')) : dBadge('danger', t('suspended'))),
        el('td', { text: fmtWhen(m.created_at) }),
        el('td', null, act)
      ]);
    }), t('members_empty'));
  }
  function memberToggle(m, to, btn) {
    (to ? Promise.resolve(true) : askConfirm({ title: t('deactivate'), text: t('member_deactivate_confirm'), okText: t('deactivate'), danger: true })).then(function (yes) {
      if (!yes) return;
      btn.disabled = true;
      api.setMembershipActive(m.id, to).then(function (r) {
        btn.disabled = false;
        if (r.error) return toast(errCode(r.error) === 'MRS_FORBIDDEN' ? t('member_forbidden') : apiErr(r.error), 'error');
        toast(T.common.saved, 'success'); rerender();
      });
    });
  }

  function inviteStatus(i) {
    if (i.status) return i.status;
    if (i.accepted_at) return 'accepted';
    if (i.revoked_at) return 'revoked';
    if (i.expires_at && new Date(i.expires_at) < new Date()) return 'expired';
    return 'pending';
  }
  var INVITE_TONE = { pending: 'blue', expired: 'warning', accepted: 'success', revoked: 'danger' };
  function invitesTable(list) {
    var shown = list.filter(function (i) { var s = inviteStatus(i); return S.g2.allInvites || s === 'pending' || s === 'expired'; });
    return dTable([t('col_email'), t('col_role'), t('col_branch'), t('f_status'), t('col_expires'), t('col_created'), ''], shown.map(function (i) {
      var st = inviteStatus(i), acts = [];
      if (st === 'pending' || st === 'expired') acts.push(dBtn(t('reissue'), 'btn-ghost', function (btn) { inviteReissue(i.id, btn); }));
      if (st === 'pending') acts.push(dBtn(t('revoke'), 'btn-ghost adm-text-danger', function (btn) { inviteRevoke(i.id, btn); }));
      var who2 = i.role === 'client' && (i.client_name_ar || i.client_name) ? [el('span', { class: 'adm-sub', text: i.client_name_ar || i.client_name })] : null;
      return el('tr', { class: st === 'revoked' ? 'adm-voided' : null }, [
        el('td', null, [dLtr(i.email), who2]),
        el('td', { text: roleLabel(i.role) }),
        el('td', { text: i.branch_id ? (i.branch_name_ar || branchName(i.branch_id) || t('branch_specific')) : t('all_branches') }),
        el('td', null, dBadge(INVITE_TONE[st] || 'blue', t('inv_' + st))),
        el('td', { text: fmtWhen(i.expires_at, true) }),
        el('td', { text: fmtWhen(i.created_at) }),
        el('td', null, el('div', { class: 'adm-row-actions' }, acts))
      ]);
    }), S.g2.allInvites ? t('invites_empty_all') : t('invites_empty'));
  }

  function inviteDialog() {
    var roles = inviteRoles(), admin = isOrgAdmin(), own = managedBranches();
    if (!roles.length) return toast(t('forbidden'), 'error');
    var bOpts = admin ? [['', t('all_branches')]] : [];
    S.branches.filter(function (b) { return b.is_active && (admin || own.indexOf(b.id) !== -1); }).forEach(function (b) { bOpts.push([b.id, b.name_ar + ' (' + b.code + ')']); });
    openDialog({
      title: t('invite_title'), submit: t('invite_submit'), body: '',
      onOpen: function (body) {
        var clientSel = el('select', { class: 'form-control', id: 'adg-client', name: 'client' }, el('option', { value: '', text: t('client_pick') }));
        var clientQ = el('input', { class: 'form-control', type: 'search', id: 'adg-client-q', placeholder: t('client_search_ph'), maxlength: 60, 'aria-label': t('client_search_ph') });
        var loadClients = function () {
          api.listClients({ orgId: S.orgId, search: clientQ.value.trim().slice(0, 60), limit: 20 }).then(function (cr) {
            var keep = clientSel.value;
            clientSel.textContent = '';
            clientSel.appendChild(el('option', { value: '', text: cr.error ? apiErr(cr.error) : t('client_pick') }));
            (cr.data || []).forEach(function (c) { clientSel.appendChild(el('option', { value: c.id, text: c.name_ar + (c.cr_number ? ' — ' + c.cr_number : '') })); });
            clientSel.value = keep;
          });
        };
        clientQ.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); loadClients(); } });
        var clientBox = el('div', { class: 'form-group adm-full', hidden: true }, [
          el('label', { class: 'form-label', for: 'adg-client' }, [t('f_client'), el('span', { class: 'req', 'aria-hidden': 'true', text: ' *' })]),
          el('div', { class: 'adm-inline-row' }, [clientQ, dBtn(T.common.search, 'btn-ghost', loadClients)]),
          clientSel, el('span', { class: 'form-hint', text: t('client_hint') })
        ]);
        body.appendChild(dAlert('info', admin ? t('invite_info_admin') : t('invite_info_bm')));
        body.appendChild(dGrid([
          dField({ name: 'email', label: t('f_email'), type: 'email', req: true, ltr: true, max: 160, autocomplete: 'off', full: true }),
          dField({ name: 'role', label: t('col_role'), type: 'select', req: true, value: 'clearance_staff', options: roles.map(function (r) { return [r, roleLabel(r)]; }) }),
          dField({ name: 'branch', label: t('col_branch'), type: 'select', req: !admin, value: admin ? '' : (own[0] || ''), options: bOpts, hint: t('branch_hint') }),
          clientBox
        ]));
        var form = body.closest('form'), roleSel = form.elements.role, branchSel = form.elements.branch;
        var sync = function () {
          var r = roleSel.value;
          // admin and client-portal invitations carry no branch (the server refuses one)
          var noBranch = r === 'admin' || r === 'client';
          branchSel.disabled = noBranch;
          if (noBranch) branchSel.value = '';
          else if (!admin && !branchSel.value && branchSel.options.length) branchSel.selectedIndex = 0;
          branchSel.required = !noBranch && (!admin || r === 'branch_manager');
          clientBox.hidden = r !== 'client';
          if (r === 'client' && clientSel.options.length <= 1) loadClients();
        };
        roleSel.addEventListener('change', sync); sync();
      },
      onSubmit: function (form) {
        var email = String(fval(form, 'email') || '').trim().toLowerCase();
        if (!email || email.length > 160 || !EMAIL_RE.test(email)) return t('email_invalid');
        var role = fval(form, 'role');
        if (roles.indexOf(role) === -1) return t('role_required');
        var branch = (role === 'admin' || role === 'client') ? null : (fval(form, 'branch') || null);
        if (role !== 'client' && (role === 'branch_manager' || !admin) && !branch) return t('branch_required');
        var client = role === 'client' ? (fval(form, 'client') || null) : null;
        if (role === 'client' && !client) return t('client_required');
        var payload = { email: email, role: role };
        if (branch) payload.branch_id = branch;
        if (client) payload.client_id = client;
        payload.idempotencyKey = idemKey('invite', payload);
        var ask = role === 'admin' ? askConfirm({ title: roleLabel('admin'), text: t('admin_confirm'), okText: t('invite_submit') }) : Promise.resolve(true);
        return ask.then(function (yes) { return yes ? call('invite', S.orgId, payload) : null; }).then(function (r) {
          if (!r) return false;
          idemSettle('invite', r.error);
          if (r.error) return errCode(r.error) === 'DUPLICATE' ? t('invite_dup') : apiErr(r.error);
          showLink(r.data || {}, t('invite_done_title'));
          rerender();
          return false;   // keep the dialog open on the one-time link
        });
      }
    });
  }
  // One-time accept link (token is never stored client-side; it disappears with the dialog).
  function showLink(data, title) {
    if (!dlg.open) openDialog({ title: title, body: '', noSubmit: true });
    dlgTitle.textContent = title;
    dlgHandler = null; dlgSubmit.hidden = true; dlgErr.hidden = true;
    dlgBody.textContent = '';
    var info = dKv([
      data.email ? [t('f_email'), dLtr(data.email)] : null,
      data.role ? [t('col_role'), roleLabel(data.role)] : null,
      data.expires_at ? [t('col_expires'), fmtWhen(data.expires_at, true)] : null
    ]);
    if (!data.token) {
      // idempotent replay: the secret was already shown once and is not stored server-side
      append(dlgBody, [dAlert('warning', t('link_already_shown')), info,
        data.invitation_id && UUID_RE.test(data.invitation_id) ? el('div', { class: 'btn-group' }, dBtn(t('reissue'), 'btn-primary', function (btn) { inviteReissue(data.invitation_id, btn, true); })) : null]);
      return;
    }
    var url = new URL('login.html?invite=' + encodeURIComponent(String(data.token)), location.href).href;
    var input = el('input', { class: 'form-control adm-link-input', type: 'text', readOnly: true, dir: 'ltr', value: url, 'aria-label': t('link_label'), onfocus: function (e) { e.target.select(); } });
    append(dlgBody, [
      dAlert('warning', t('link_once_warning')),
      el('div', { class: 'adm-token' }, [el('strong', { text: t('link_label') }), input,
        el('div', { class: 'btn-group' }, dBtn(t('copy'), 'btn-primary', function () { copyText(input); }))]),
      info, el('p', { class: 'form-hint', text: t('link_hint') })
    ]);
  }
  function copyText(input) {
    var done = function () { toast(t('copied'), 'success'); };
    var fallback = function () {
      input.focus(); input.select();
      try { if (document.execCommand('copy')) done(); else toast(t('copy_failed'), 'warning'); } catch (e) { toast(t('copy_failed'), 'warning'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, fallback);
    else fallback();
  }
  function inviteRevoke(id, btn) {
    askConfirm({ title: t('revoke'), text: t('revoke_confirm'), okText: t('revoke'), danger: true }).then(function (yes) {
      if (!yes) return;
      btn.disabled = true;
      call('revokeInvitation', id).then(function (r) {
        btn.disabled = false;
        if (r.error) return toast(apiErr(r.error), 'error');
        toast(t('revoked_ok'), 'success'); rerender();
      });
    });
  }
  function inviteReissue(id, btn, inDialog) {
    askConfirm({ title: t('reissue'), text: t('reissue_confirm'), okText: t('reissue') }).then(function (yes) {
      if (!yes) return;
      btn.disabled = true;
      call('reissueInvitation', id).then(function (r) {
        btn.disabled = false;
        if (r.error) { if (inDialog) dialogError(apiErr(r.error)); else toast(apiErr(r.error), 'error'); return; }
        showLink(r.data || {}, t('reissue_done_title'));
        rerender();
      });
    });
  }

  /* ------------------------------------------------------------------
     سجل التدقيق — admin_audit_log reader (admin + supervisor)
     ------------------------------------------------------------------ */
  var AUDIT_PAGE = 50;
  var AUDIT_TABLES = ['organizations', 'branches', 'memberships', 'invitations', 'clients', 'client_users', 'service_requests', 'transactions',
    'containers', 'documents', 'document_extractions', 'import_batches', 'contact_messages'];
  function dayISO(v, end) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); if (!m) return null;
    var d = end ? new Date(+m[1], m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], m[2] - 1, +m[3], 0, 0, 0, 0);
    return isNaN(d) ? null : d.toISOString();
  }
  function auditActors() {
    var p = isOrgAdmin() ? L.adminListMembers(S.orgId).then(function (r) { return r.error ? [] : rowsOf(r.data); })
      : api.listMemberships(S.orgId).then(function (r) { return r.error ? [] : (r.data || []).map(function (m) { return { user_id: m.user_id, full_name: m.profiles && m.profiles.full_name }; }); });
    return p.then(function (list) {
      var seen = {};
      return list.filter(function (m) { if (!m.user_id || seen[m.user_id]) return false; seen[m.user_id] = 1; return true; });
    });
  }
  function renderAudit() {
    var f = S.g2.audit;
    return auditActors().then(function (actors) {
      var out = frag(dHead(viewLabel('audit'), t('audit_sub')));
      var actorCtl = actors.length
        ? el('select', { class: 'form-control', id: 'adg-a-actor', name: 'actor' }, [el('option', { value: '', text: T.common.all })].concat(actors.map(function (m) {
          return el('option', { value: m.user_id, text: (m.full_name || t('no_name')) + (m.email ? ' — ' + m.email : '') });
        })))
        : el('input', { class: 'form-control', id: 'adg-a-actor', name: 'actor', dir: 'ltr', maxlength: 36, placeholder: 'UUID' });
      actorCtl.value = f.actor || '';
      var tableSel = el('select', { class: 'form-control', id: 'adg-a-table', name: 'table' }, [el('option', { value: '', text: T.common.all })].concat(AUDIT_TABLES.map(function (n) {
        return el('option', { value: n, text: n });
      })));
      tableSel.value = f.table || '';
      var grp = function (id, label, ctl, grow) { return el('div', { class: 'form-group' + (grow ? ' adm-grow' : '') }, [el('label', { class: 'form-label', for: id, text: label }), ctl]); };
      var filt = el('form', { class: 'adm-filters card', novalidate: true }, [
        grp('adg-a-table', t('col_table'), tableSel),
        grp('adg-a-actor', t('col_actor'), actorCtl),
        grp('adg-a-from', t('f_from'), el('input', { class: 'form-control', type: 'date', id: 'adg-a-from', name: 'from', value: f.from })),
        grp('adg-a-to', t('f_to'), el('input', { class: 'form-control', type: 'date', id: 'adg-a-to', name: 'to', value: f.to })),
        grp('adg-a-row', t('col_row'), el('input', { class: 'form-control', id: 'adg-a-row', name: 'rowId', dir: 'ltr', maxlength: 64, value: f.rowId }), true),
        el('button', { class: 'btn btn-primary', type: 'submit', text: T.common.search }),
        dBtn(t('reset'), 'btn-ghost', function () { S.g2.audit = { table: '', actor: '', from: '', to: '', rowId: '' }; rerender(); })
      ]);
      filt.addEventListener('submit', function (e) {
        e.preventDefault();
        var a = String(filt.elements.actor.value || '').trim();
        if (a && !UUID_RE.test(a)) return toast(t('err_actor'), 'warning');
        S.g2.audit = { table: filt.elements.table.value, actor: a, from: filt.elements.from.value, to: filt.elements.to.value, rowId: String(filt.elements.rowId.value || '').trim().slice(0, 64) };
        rerender();
      });
      out.appendChild(filt);

      var tbody = el('tbody'), more = el('div', { class: 'adm-pager' });
      var status = el('p', { class: 'adm-count text-xs text-muted' });
      out.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'table table-striped adm-table' }, [
        el('thead', null, el('tr', null, [t('col_time'), t('col_table'), t('col_action'), t('col_row'), t('col_actor'), t('col_changed'), ''].map(function (h) { return el('th', { scope: 'col', text: h }); }))),
        tbody
      ])));
      out.appendChild(append(more, status));
      var total = 0, lastId = null;
      var olderBtn = dBtn(t('older'), 'btn-ghost', function (btn) { load(btn); });
      more.appendChild(olderBtn);

      function load(btn) {
        var p = { limit: AUDIT_PAGE };
        if (f.table) p.table_name = f.table;
        if (f.actor) p.actor = f.actor;
        if (f.from) p.from = dayISO(f.from, false);
        if (f.to) p.to = dayISO(f.to, true);
        if (f.rowId) p.row_id = f.rowId;
        if (lastId != null) p.before_id = lastId;
        if (btn) btn.disabled = true;
        return call('auditLog', S.orgId, p).then(function (r) {
          if (btn) btn.disabled = false;
          if (r.error) {
            if (!total) { tbody.textContent = ''; olderBtn.hidden = true; }
            toast(apiErr(r.error), 'error');
            if (!total && more.parentNode) more.parentNode.insertBefore(dAlert(isForbidden(r.error) ? 'warning' : 'danger', apiErr(r.error)), more);
            return;
          }
          var list = rowsOf(r.data);
          if (!total && !list.length) tbody.appendChild(el('tr', null, el('td', { colspan: 7, class: 'adm-empty', text: T.common.empty })));
          list.forEach(function (row) { tbody.appendChild(auditRow(row)); });
          total += list.length;
          if (list.length) lastId = list[list.length - 1].id;
          olderBtn.hidden = list.length < AUDIT_PAGE;
          status.textContent = t('audit_count', { n: total });
        });
      }
      return load(null).then(function () { return out; });
    });
  }
  function actionLabel(a) { var k = 'act_' + String(a || '').toLowerCase(), s = t(k); return s === k ? String(a || '') : s; }
  var ACTION_TONE = { INSERT: 'success', UPDATE: 'blue', DELETE: 'danger' };
  function auditActor(row) {
    if (row.actor_email) return el('bdi', { dir: 'ltr', text: row.actor_email });
    return who(row.actor);
  }
  function auditRow(row) {
    var cf = Array.isArray(row.changed_fields) ? row.changed_fields : [];
    var cfText = cf.length ? cf.slice(0, 5).join('، ') + (cf.length > 5 ? ' …(+' + (cf.length - 5) + ')' : '') : T.common.none;
    return el('tr', null, [
      el('td', { text: fmtWhen(row.at || row.created_at, true) }),
      el('td', null, dLtr(row.table_name)),
      el('td', null, dBadge(ACTION_TONE[row.action] || 'blue', actionLabel(row.action))),
      el('td', null, row.row_id ? el('bdi', { dir: 'ltr', class: 'num adm-hash', title: String(row.row_id), text: String(row.row_id).slice(0, 8) }) : T.common.none),
      el('td', null, [auditActor(row), row.actor_role ? el('span', { class: 'adm-sub', text: roleLabel(row.actor_role) }) : null]),
      el('td', null, el('bdi', { dir: 'ltr', class: 'adm-audit-fields', text: cfText })),
      el('td', null, dBtn(t('details'), 'btn-ghost', function () { auditDetails(row); }))
    ]);
  }
  function valText(v) {
    if (v === undefined) return T.common.none;
    if (v === null) return 'null';
    if (typeof v === 'object') { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }
    return String(v);
  }
  function auditDetails(row) {
    var oldD = row.old_data && typeof row.old_data === 'object' ? row.old_data : {};
    var newD = row.new_data && typeof row.new_data === 'object' ? row.new_data : {};
    var cf = Array.isArray(row.changed_fields) ? row.changed_fields : [];
    var keys = cf.length ? cf : Object.keys(oldD).concat(Object.keys(newD)).filter(function (k, i, a) { return a.indexOf(k) === i; }).sort();
    openDialog({
      title: t('audit_detail_title'), body: '', noSubmit: true, wide: true,
      onOpen: function (body) {
        append(body, [
          dKv([
            [t('col_time'), fmtWhen(row.at || row.created_at, true)], [t('col_table'), dLtr(row.table_name)],
            [t('col_action'), actionLabel(row.action)], [t('col_row'), dLtr(row.row_id ? String(row.row_id) : '')],
            [t('col_actor'), auditActor(row)], row.actor_role ? [t('col_role'), roleLabel(row.actor_role)] : null,
            [t('col_changed'), cf.length ? el('bdi', { dir: 'ltr', text: cf.join(', ') }) : T.common.none]
          ]),
          dTable([t('col_field'), t('col_before'), t('col_after')], keys.map(function (k) {
            var changed = !cf.length || cf.indexOf(k) !== -1;
            return el('tr', { class: changed ? 'adm-audit-changed' : null }, [
              el('td', null, el('bdi', { dir: 'ltr', class: 'num', text: k })),
              el('td', null, el('div', { class: 'adm-pre adm-audit-val', dir: 'auto', text: row.action === 'INSERT' ? T.common.none : valText(oldD[k]) })),
              el('td', null, el('div', { class: 'adm-pre adm-audit-val', dir: 'auto', text: row.action === 'DELETE' ? T.common.none : valText(newD[k]) }))
            ]);
          }), t('audit_no_fields'))
        ]);
      }
    });
  }

  /* ------------------------------------------------------------------
     أخطاء الواجهة — admin_recent_errors (already scrubbed server-side)
     ------------------------------------------------------------------ */
  function renderErrors() {
    return call('recentErrors', S.orgId).then(function (r) {
      var out = frag(dHead(viewLabel('errors'), t('errors_sub')));
      if (r.error) return append(out, dAlert(isForbidden(r.error) ? 'warning' : 'danger', apiErr(r.error)));
      var list = rowsOf(r.data);
      out.appendChild(dTable([t('col_time'), t('col_page'), t('col_code'), t('col_message'), t('col_user'), t('col_ua')], list.map(function (x) {
        var ua = String(x.ua || '');
        return el('tr', null, [
          el('td', { text: fmtWhen(x.created_at, true) }),
          el('td', null, dLtr(x.page)),
          el('td', null, dLtr(x.code)),
          el('td', null, el('div', { class: 'adm-pre', dir: 'auto', text: x.message || T.common.none })),
          el('td', { text: x.user_id ? who(x.user_id) : t('visitor') }),
          el('td', null, ua ? el('bdi', { dir: 'ltr', class: 'text-xs', title: ua, text: ua.length > 60 ? ua.slice(0, 60) + '…' : ua }) : T.common.none)
        ]);
      }), t('errors_empty')));
      return out;
    });
  }

  /* ------------------------------------------------------------------
     Active org: the shell's org switcher (MarsaApi.setActiveOrg) fires
     'marsa:orgchange'; reload this org's context and views.
     ------------------------------------------------------------------ */
  function resetOrgState() {
    S.profiles = {};
    Object.keys(S.filters).forEach(function (k) { S.filters[k].offset = 0; if ('branchId' in S.filters[k]) S.filters[k].branchId = ''; if ('search' in S.filters[k]) S.filters[k].search = ''; });
    S.list = {};
    S.g2 = { audit: { table: '', actor: '', from: '', to: '', rowId: '' }, allInvites: false };
    Object.keys(TX_CACHE).forEach(function (k) { delete TX_CACHE[k]; });
    Object.keys(MSG_CACHE).forEach(function (k) { delete MSG_CACHE[k]; });
    Object.keys(CLIENT_CACHE).forEach(function (k) { delete CLIENT_CACHE[k]; });
    IDEM = {};
  }
  var orgPending = null;   // org id being loaded after a switch
  function onOrgChange(id) {
    if (!S.ctx || (id && (id === S.orgId || id === orgPending))) return;   // first boot reads the active org itself
    orgPending = id || null;
    if (dlg && dlg.open) closeDialog();
    resetOrgState();
    // detail routes point at the previous org's rows → back to the overview (no extra hashchange render)
    if (DETAIL[parseHash().name]) { try { history.replaceState(null, '', '#dashboard'); } catch (err) { /* ignore */ } }
    showGate('loading');
    // memberships of every org are already in my_context; refetch it so roles are current
    api.myContext(true).then(function (c) {
      return withContext(c.error ? S.ctx : (c.data || S.ctx));
    }).then(function () { orgPending = null; }, function (err) { orgPending = null; showGate('error', errText(err)); });
  }
  window.addEventListener('marsa:orgchange', function (e) { onOrgChange(e && e.detail && e.detail.orgId); });
  window.addEventListener('marsa:langchange', function () {
    if (app.hidden) return;
    fillMe(); buildNav(); fillOrgSwitch(); route(true);
  });

  /* ------------------------------------------------------------------
     Event delegation
     ------------------------------------------------------------------ */
  view.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT') return;
    var a = el.getAttribute('data-act'), id = el.getAttribute('data-id'), tx = el.getAttribute('data-tx');
    if (id && !UUID_RE.test(id)) return;
    if (tx && !UUID_RE.test(tx)) return;
    switch (a) {
      case 'refresh': route(true); break;
      case 'req-review': reqReview(id); break;
      case 'req-reject': reqReject(id); break;
      case 'req-convert': reqConvert(id); break;
      case 'tx-edit': txEdit(id); break;
      case 'tx-token': txToken(id); break;
      case 'ctr-add': containerDialog(tx, null); break;
      case 'ctr-edit': containerDialog(tx, id); break;
      case 'doc-open': docOpen(id); break;
      case 'doc-classify': docClassify(tx, id); break;
      case 'doc-visibility': docVisibility(tx, id, el.getAttribute('data-to') === 'client' ? 'client' : 'internal'); break;
      case 'doc-void': docVoid(tx, id); break;
      case 'doc-version': docVersion(tx, id); break;
      case 'client-new': clientDialog(null); break;
      case 'client-edit': clientDialog(id); break;
      case 'msg-view': msgView(id); break;
      case 'imp-commit': impCommit(id); break;
      case 'imp-cancel': impCancel(id); break;
    }
  });
  view.addEventListener('change', function (e) {
    if (e.target.matches('[data-act="toggle-voided"]')) { S.showVoided = e.target.checked; rerender(); }
    var form = e.target.closest('[data-form="tx-status"]');
    if (form && e.target.name === 'status') {
      var opt = e.target.selectedOptions && e.target.selectedOptions[0];
      var note = form.elements.note;
      if (note) note.required = !!(opt && opt.getAttribute('data-back'));
    }
  });
  // G3.10 manager override of the document gate (reason required; logged as a docs_override event).
  // The override is explicit (p_docs_override) and sent only from here: a typed status note never bypasses the gate.
  function docsOverride(txId, st, kindText, prefill) {
    opsModal({
      title: t('docs_override_title'), submitText: t('docs_override_submit'), danger: true,
      body: [
        dAlert('warning', t('docs_missing_block', { kinds: kindText })),
        el('p', { class: 'form-hint', text: t('docs_override_lead') }),
        el('div', { class: 'form-group' }, [
          el('label', { class: 'form-label', for: 'adf-override-reason', text: t('docs_override_reason') }),
          el('textarea', { class: 'form-control', id: 'adf-override-reason', name: 'reason', rows: 3, maxlength: 2000, required: true, text: prefill || '' })
        ])
      ],
      onSubmit: function (form) {
        var why = nn(fval(form, 'reason'));
        if (!why) return t('docs_override_reason_req');
        return api.setTransactionStatus(txId, st, why, undefined, { docsOverride: true }).then(function (r) {
          if (r.error) return errText(r.error);
          toast(t('docs_override_done', { s: lbl('operational_status', st) }), 'warning'); rerender();
          return true;
        });
      }
    });
  }
  view.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    var kind = form.getAttribute('data-form');
    var btn = form.querySelector('[type=submit]');
    var done = function () { if (btn) btn.disabled = false; };
    if (btn) btn.disabled = true;
    var id = form.getAttribute('data-id') || form.getAttribute('data-tx');
    if (!id || !UUID_RE.test(id)) return done();
    if (kind === 'tx-status') {
      var st = form.elements.status.value, note = nn(form.elements.note.value);
      var opt = form.elements.status.selectedOptions[0];
      if (!st) { done(); return toast('اختر الحالة الجديدة.', 'warning'); }
      if (opt && opt.getAttribute('data-back') && !note) { done(); return toast(api.i18n.ar.errors.MRS_NOTE_REQUIRED, 'warning'); }
      api.setTransactionStatus(id, st, note).then(function (r) {
        done();
        if (r.error && errCode(r.error) === 'MRS_DOCS_MISSING') {
          // G3.10: only this move is blocked; the detail lists the missing document kinds
          var kinds = String(errField(r.error) || '').split(/[,\s{}"]+/).filter(Boolean).map(function (k) { return lbl('document_kind', k); });
          var kindText = kinds.join(isEn() ? ', ' : '، ') || T.common.none;
          // senior roles (app.senior_ops_roles) may override: the same move again, explicitly (p_docs_override)
          // with a mandatory reason; a typed note only pre-fills it. Branch scope is decided by the server.
          if (canAny(R.backward)) return docsOverride(id, st, kindText, note);
          return toast(t('docs_missing_block', { kinds: kindText }), 'error');
        }
        if (r.error) return toast(errText(r.error), 'error');
        // the remembered key of an earlier unknown result was replayed: that earlier change is what applied
        if (r.replayedEarlier) { toast('هذا التغيير طُبّق في محاولة سابقة لم يصل ردّها. حدّثنا العرض — تحقّق من الحالة الحالية.', 'warning'); rerender(); return; }
        // defensive: an override the server applied is never reported as a plain success
        var ov = r.data && Array.isArray(r.data.docs_override) ? r.data.docs_override : [];
        if (ov.length) toast(t('docs_override_done', { s: lbl('operational_status', st) }) + ' (' + ov.map(function (k) { return lbl('document_kind', k); }).join(isEn() ? ', ' : '، ') + ')', 'warning');
        else toast('تم تغيير الحالة إلى «' + lbl('operational_status', st) + '».', 'success');
        rerender();
      });
    } else if (kind === 'tx-note') {
      var n = nn(form.elements.note.value);
      if (!n) { done(); return toast(T.common.required, 'warning'); }
      api.addNote(id, n).then(function (r) {
        done();
        if (r.error) return toast(errText(r.error), 'error');
        toast('أُضيفت الملاحظة إلى السجل.', 'success'); rerender();
      });
    } else if (kind === 'doc-upload') {
      var file = form.elements.file.files[0];
      if (!file) { done(); return toast('اختر ملفًا.', 'warning'); }
      api.uploadDocument({
        file: file, transactionId: id, kind: form.elements.kind.value || 'other', visibility: form.elements.visibility.value || 'internal',
        source: form.elements.source.value || 'staff_scan', sourceRef: nn(form.elements.sourceRef.value)
      }).then(function (r) {
        done();
        if (r.error) { toast(errText(r.error), 'error'); if (r.data) rerender(); return; }
        toast('تم رفع المستند. صنّفه بعد المراجعة.', 'success'); rerender();
      });
    } else done();
  });

  /* ------------------------------------------------------------------ */
  function start() { boot(true); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
