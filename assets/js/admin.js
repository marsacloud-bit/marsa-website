/* ==========================================================================
   مرسى | MARSA — admin.html staff console (STAGING)
   --------------------------------------------------------------------------
   Load order: config.js → main.js → supa.js → admin.js (plain <script defer>).
   * Online only. In demo mode (empty config) the page shows a notice and
     never touches localStorage data.
   * Role guard: any active staff membership in MARSA_CONFIG.orgSlug. The UI
     only hides what a role cannot do; the database (RLS + guarded RPCs) is
     the real gate, and every error from it is shown as returned.
   * All user-supplied values are HTML-escaped before rendering (esc()).
   * Local helpers that MarsaApi does not provide yet (see "LOCAL API GAPS")
     use MarsaApi.client after MarsaApi.ready() and the same {data,error} shape.
   ========================================================================== */
(function () {
  'use strict';

  var api = window.MarsaApi;
  var M = window.Marsa || {};
  var gateBody = document.getElementById('adm-gate-body');
  var gate = document.getElementById('adm-gate');
  var app = document.getElementById('adm-app');
  var view = document.getElementById('adm-view');
  var nav = document.getElementById('adm-nav');
  if (!gate || !app || !view) return;

  /* ------------------------------------------------------------------
     Strings (Arabic MSA) — kept together for later EN extraction
     ------------------------------------------------------------------ */
  var T = {
    views: {
      dashboard: 'نظرة عامة', requests: 'الطلبات الواردة', transactions: 'المعاملات', clients: 'العملاء',
      messages: 'رسائل التواصل', imports: 'الرفع الجماعي', members: 'المستخدمون والصلاحيات'
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
    role: { client: 'عميل', clearance_staff: 'موظف تخليص', transport_staff: 'موظف نقل', accountant: 'محاسب', accounts_manager: 'مدير حسابات', operations_manager: 'مدير عمليات', supervisor: 'مشرف', admin: 'مدير نظام' },
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
    event_type: { created: 'إنشاء المعاملة', request_converted: 'تحويل من طلب خدمة', operational_status: 'تغيير الحالة التشغيلية', financial_status: 'تغيير الحالة المالية', container_return: 'حالة إرجاع حاوية', document: 'مستند', note: 'ملاحظة', tracking_token: 'إصدار رمز تتبع' }
  };
  var LABELS = JSON.parse(JSON.stringify(FALLBACK));
  var ORDER = {
    operational_status: ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return', 'operationally_complete', 'under_billing', 'billed', 'closed']
  };

  /* ------------------------------------------------------------------
     Role model (mirrors app.*_roles() and set_transaction_status; UI only)
     ------------------------------------------------------------------ */
  var R = {
    staff: ['clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'supervisor', 'admin'],
    opsWriter: ['clearance_staff', 'operations_manager', 'supervisor', 'admin'],
    transportWriter: ['clearance_staff', 'transport_staff', 'operations_manager', 'supervisor', 'admin'],
    finance: ['accountant', 'accounts_manager', 'admin'],
    contact: ['clearance_staff', 'operations_manager', 'supervisor', 'admin'],
    clientLink: ['operations_manager', 'supervisor', 'admin'],
    membersRead: ['admin', 'supervisor'],
    membersWrite: ['admin'],
    backward: ['operations_manager', 'supervisor', 'admin']
  };
  var STATUS_ROLES = {
    new: R.opsWriter, in_progress: R.opsWriter, customs_declaration: R.opsWriter,
    appointment: R.transportWriter, transport: R.transportWriter, empty_return: R.transportWriter,
    operationally_complete: R.opsWriter, under_billing: R.finance, billed: R.finance,
    closed: ['accounts_manager', 'supervisor', 'admin']
  };
  var ROLE_RANK = ['client', 'clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'supervisor', 'admin'];

  var S = {
    ctx: null, orgId: null, memberships: [], roles: [], branches: [], profiles: {},
    filters: {
      requests: { status: 'new', search: '', offset: 0 },
      transactions: { status: '', branchId: '', search: '', offset: 0 },
      clients: { search: '', inactive: false, offset: 0 },
      messages: { status: 'new', offset: 0 },
      imports: { status: '', offset: 0 }
    },
    showVoided: false,
    renderSeq: 0
  };
  var PAGE = 25;
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
    try { return d.toLocaleDateString(DATE_LOCALE, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function fmtDateTime(v) {
    if (!v) return T.common.none;
    var d = new Date(v); if (isNaN(d)) return esc(v);
    try { return d.toLocaleString(DATE_LOCALE, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return d.toISOString().replace('T', ' ').slice(0, 16); }
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
  function toast(msg, type) { if (M.toast) M.toast(msg, type || 'info'); }
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
      box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>'
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
  function badge(domain, code) {
    var c = (BADGE[domain] || {})[code] || 'blue';
    return '<span class="badge badge-' + c + '">' + esc(lbl(domain, code)) + '</span>';
  }
  function kv(rows) {
    return '<ul class="kv">' + rows.filter(Boolean).map(function (r) {
      return '<li><span class="k">' + esc(r[0]) + '</span><span class="v">' + (r[2] ? r[1] : esc(r[1] == null || r[1] === '' ? T.common.none : r[1])) + '</span></li>';
    }).join('') + '</ul>';
  }
  function alertBox(type, text, html) {
    return '<div class="alert alert-' + type + '" role="' + (type === 'danger' ? 'alert' : 'status') + '">' + icon('info') + '<div>' + (html ? text : esc(text)) + '</div></div>';
  }
  function emptyRow(cols, text) { return '<tr><td colspan="' + cols + '" class="adm-empty">' + esc(text || T.common.empty) + '</td></tr>'; }
  function loadingBox() { return '<div class="adm-loading" role="status"><span class="adm-spinner" aria-hidden="true"></span>' + esc(T.common.loading) + '</div>'; }
  function pager(key, count) {
    var f = S.filters[key];
    if (count == null || count <= PAGE) return count != null ? '<p class="adm-count text-xs text-muted">' + num(count) + ' ' + T.common.results + '</p>' : '';
    var from = f.offset + 1, to = Math.min(f.offset + PAGE, count);
    return '<div class="adm-pager"><span class="text-xs text-muted">' + num(from + '–' + to) + ' ' + T.common.ofTotal + ' ' + num(count) + '</span>' +
      '<div class="btn-group"><button class="btn btn-sm btn-ghost" type="button" data-act="page" data-key="' + key + '" data-dir="-1"' + (f.offset <= 0 ? ' disabled' : '') + '>' + T.common.prev + '</button>' +
      '<button class="btn btn-sm btn-ghost" type="button" data-act="page" data-key="' + key + '" data-dir="1"' + (to >= count ? ' disabled' : '') + '>' + T.common.next + '</button></div></div>';
  }

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
  var L = {
    count: function (table, build) {
      return local(function (c) { var q = c.from(table).select('id', { count: 'exact', head: true }); return build ? build(q) : q; })
        .then(function (r) { return r.error ? r : { data: r.count || 0, error: null }; });
    },
    containersDue: function (days) {
      return local(function (c) {
        return c.from('containers').select('id,container_no,return_deadline,return_status,transaction_id,transactions(ref)')
          .in('return_status', ['pending', 'evidence_submitted', 'disputed']).not('return_deadline', 'is', null)
          .lte('return_deadline', todayISO(days)).order('return_deadline').limit(10);
      });
    },
    listImportBatches: function (o) {
      return local(function (c) {
        var q = c.from('import_batches').select('id,ref,client_id,file_name,file_size,sheet_names,status,total_rows,committed_rows,skipped_rows,created_by,created_at,committed_at,clients(name_ar)', { count: 'exact' })
          .order('created_at', { ascending: false });
        if (o.status) q = q.eq('status', o.status);
        return q.range(o.offset || 0, (o.offset || 0) + PAGE - 1);
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
    adminListMembers: function (orgId) { return local(function (c) { return c.rpc('admin_list_members', { p_org: orgId }); }); },
    adminAddMember: function (o) {
      return local(function (c) { return c.rpc('admin_add_member', { p_org: o.orgId, p_email: o.email, p_role: o.role, p_branch: o.branchId || null }); });
    },
    adminSetMemberActive: function (id, active) {
      return local(function (c) { return c.rpc('admin_set_member_active', { p_membership: id, p_active: !!active }); });
    }
  };
  function who(id) {
    if (!id) return 'النظام';
    if (S.ctx && id === S.ctx.user_id) return 'أنت';
    var n = S.profiles[id];
    return n ? n : 'مستخدم ' + String(id).slice(0, 8);
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
    if (typeof dlg.close === 'function' && dlg.open) dlg.close(); else dlg.removeAttribute('open');
    dlgHandler = null; dlgBody.innerHTML = '';
    if (dlgReturnFocus && dlgReturnFocus.focus && document.contains(dlgReturnFocus)) dlgReturnFocus.focus();
  }
  function dialogError(msg) { dlgErr.textContent = msg; dlgErr.hidden = false; }
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
    var title, text, actions = '';
    if (kind === 'demo') {
      title = T.gate.demoTitle; text = api && api.isMisconfigured && api.isMisconfigured() ? T.gate.misconfigured : T.gate.demo;
      actions = '<a class="btn btn-primary" href="index.html">' + T.gate.home + '</a>';
    } else if (kind === 'signin') {
      title = T.gate.signInTitle; text = T.gate.signIn;
      actions = '<a class="btn btn-primary" href="login.html#staff">' + T.gate.signInBtn + '</a>';
    } else if (kind === 'forbidden') {
      title = T.gate.forbiddenTitle; text = T.gate.forbidden;
      actions = '<button class="btn btn-secondary" type="button" data-gate="signout">تسجيل الخروج</button>';
    } else if (kind === 'loading') {
      gateBody.innerHTML = loadingBox(); return;
    } else {
      title = T.gate.errorTitle; text = extra || '';
      actions = '<button class="btn btn-primary" type="button" data-gate="retry">' + T.gate.retry + '</button>';
    }
    gateBody.innerHTML = '<span class="icon-box icon-box-lg icon-box-soft">' + icon('lock') + '</span>' +
      '<h2>' + esc(title) + '</h2><p class="text-muted">' + esc(text) + '</p><div class="btn-group adm-gate-actions">' + actions + '</div>';
  }
  gate.addEventListener('click', function (e) {
    var b = e.target.closest('[data-gate]');
    if (!b) return;
    if (b.getAttribute('data-gate') === 'retry') boot();
    if (b.getAttribute('data-gate') === 'signout') signOut();
  });

  function signOut() {
    api.signOut().then(function () { location.href = 'login.html#staff'; });
  }

  function boot() {
    if (!api || !api.isOnline || !api.isOnline()) { showGate('demo'); return; }
    showGate('loading');
    api.getSession().then(function (r) {
      if (r.error) return showGate('error', errText(r.error));
      if (!r.data) return showGate('signin');
      return api.myContext(true).then(function (c) {
        if (c.error) return showGate(c.error.code === 'MRS_AUTH_REQUIRED' ? 'signin' : 'error', errText(c.error));
        S.ctx = c.data || {};
        var slug = api.orgSlug;
        S.memberships = (S.ctx.memberships || []).filter(function (m) { return m.org_slug === slug && R.staff.indexOf(m.role) !== -1; });
        if (!S.memberships.length) return showGate('forbidden');
        S.orgId = S.memberships[0].org_id;
        S.roles = S.memberships.map(function (m) { return m.role; }).filter(function (r, i, a) { return a.indexOf(r) === i; });
        S.roles.sort(function (a, b) { return ROLE_RANK.indexOf(b) - ROLE_RANK.indexOf(a); });
        return Promise.all([api.listBranches(), loadLabels()]).then(function (res) {
          S.branches = (res[0].data || []).filter(function (b) { return b.org_id === S.orgId; });
          startApp();
        });
      });
    });
  }
  function loadLabels() {
    var domains = ['operational_status', 'financial_status', 'request_status', 'container_return_status', 'document_kind', 'classification_status', 'contact_status', 'import_row_status', 'role'];
    return Promise.all(domains.map(function (d) { return api.statusLabels(d); })).then(function (res) {
      res.forEach(function (r, i) {
        if (r.error || !r.data || !r.data.length) return;
        var map = {}, order = [];
        r.data.forEach(function (x) { map[x.code] = x.label_ar; order.push(x.code); });
        LABELS[domains[i]] = map;
        ORDER[domains[i]] = order;
      });
    });
  }

  var VIEWS = [
    { id: 'dashboard', allow: R.staff },
    { id: 'requests', allow: R.opsWriter },
    { id: 'transactions', allow: R.staff },
    { id: 'clients', allow: R.staff },
    { id: 'messages', allow: R.contact },
    { id: 'imports', allow: R.opsWriter },
    { id: 'members', allow: R.membersRead }
  ];
  function allowedViews() { return VIEWS.filter(function (v) { return canAny(v.allow); }); }

  function startApp() {
    gate.hidden = true; app.hidden = false;
    var p = S.ctx.profile || {};
    document.getElementById('adm-me-name').textContent = p.full_name || 'موظف';
    document.getElementById('adm-me-roles').textContent = S.memberships.map(function (m) {
      var b = m.branch_id ? (m.branch_name_ar || (S.branches.filter(function (x) { return x.id === m.branch_id; })[0] || {}).name_ar || 'فرع محدد') : 'كل الفروع';
      return lbl('role', m.role) + ' — ' + b;
    }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join('، ');
    nav.innerHTML = allowedViews().map(function (v) {
      return '<li><a class="adm-nav-link" href="#' + v.id + '" data-view="' + v.id + '">' + esc(T.views[v.id]) + '</a></li>';
    }).join('');
    route();
  }
  document.getElementById('adm-signout').addEventListener('click', signOut);
  document.getElementById('adm-refresh').addEventListener('click', function () { route(true); });
  window.addEventListener('hashchange', function () { if (!app.hidden) route(false); });
  if (api && api.onAuth) {
    api.onAuth(function (event) { if (event === 'SIGNED_OUT') { S.ctx = null; showGate('signin'); } });
  }

  /* ------------------------------------------------------------------
     Router: #view  |  #request/<id> #tx/<id> #client/<id> #import/<id>
     ------------------------------------------------------------------ */
  var DETAIL = { request: 'requests', tx: 'transactions', client: 'clients', import: 'imports' };
  function route(keepDialog) {
    if (!keepDialog && dlg && dlg.open) closeDialog();
    var h = (location.hash || '').replace(/^#/, '');
    var parts = h.split('/');
    var name = parts[0] || 'dashboard', id = parts[1] || null;
    var parent = DETAIL[name] || name;
    var allowed = allowedViews().map(function (v) { return v.id; });
    if (allowed.indexOf(parent) === -1 || (DETAIL[name] && !(id && UUID_RE.test(id)))) { name = 'dashboard'; parent = 'dashboard'; id = null; }
    Array.prototype.forEach.call(nav.querySelectorAll('[data-view]'), function (a) {
      var on = a.getAttribute('data-view') === parent;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var seq = ++S.renderSeq;
    view.innerHTML = loadingBox();
    var fn = {
      dashboard: renderDashboard, requests: renderRequests, request: renderRequest, transactions: renderTransactions,
      tx: renderTx, clients: renderClients, client: renderClient, messages: renderMessages, imports: renderImports,
      import: renderImport, members: renderMembers
    }[name];
    Promise.resolve(fn(id)).then(function (html) {
      if (seq !== S.renderSeq) return;            // a newer navigation won
      view.innerHTML = html;
    }, function (e) {
      if (seq !== S.renderSeq) return;
      view.innerHTML = alertBox('danger', errText(e));
    });
  }
  function rerender() { route(true); }   // keeps an open result dialog (e.g. a one-time token)
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  function head(title, sub, actions, backHash) {
    return '<div class="adm-head">' +
      '<div class="adm-head-title">' + (backHash ? '<a class="btn btn-sm btn-ghost adm-back" href="' + backHash + '">' + icon('back') + T.common.back + '</a>' : '') +
      '<div><h2>' + title + '</h2>' + (sub ? '<p class="text-sm text-muted">' + sub + '</p>' : '') + '</div></div>' +
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
     Dashboard
     ------------------------------------------------------------------ */
  function renderDashboard() {
    var tiles = [];
    var jobs = [];
    function tile(key, label, hash, p, tone) {
      var t = { label: label, hash: hash, value: null, tone: tone || '' };
      tiles.push(t);
      jobs.push(p.then(function (r) { t.value = r.error ? '!' : (r.count != null ? r.count : r.data); t.err = r.error; }));
    }
    if (canAny(R.opsWriter)) {
      tile('req_new', 'طلبات جديدة', '#requests', api.listRequests({ status: 'new', limit: 1 }));
      tile('req_review', 'طلبات قيد المراجعة', '#requests', api.listRequests({ status: 'under_review', limit: 1 }));
    }
    tile('tx_open', 'معاملات مفتوحة', '#transactions', L.count('transactions', function (q) { return q.neq('operational_status', 'closed'); }));
    tile('ctr_overdue', 'حاويات تجاوزت موعد الإرجاع', '#transactions', L.count('containers', function (q) {
      return q.in('return_status', ['pending', 'evidence_submitted', 'disputed']).lt('return_deadline', todayISO(0));
    }), 'danger');
    tile('ctr_evidence', 'أدلة إرجاع بانتظار التحقق', '#transactions', L.count('containers', function (q) { return q.eq('return_status', 'evidence_submitted'); }), 'warning');
    tile('doc_unrev', 'مستندات لم تُصنّف', '#transactions', L.count('documents', function (q) { return q.eq('classification_status', 'unreviewed').is('voided_at', null); }), 'warning');
    if (canAny(R.contact)) tile('msg_new', 'رسائل تواصل جديدة', '#messages', api.listContactMessages({ status: 'new', limit: 1 }));
    if (canAny(R.opsWriter)) tile('imp_draft', 'دفعات رفع جماعي مسودة', '#imports', L.count('import_batches', function (q) { return q.eq('status', 'draft'); }));

    var recent = canAny(R.opsWriter) ? api.listRequests({ limit: 5 }) : Promise.resolve({ data: [] });
    var due = L.containersDue(3);
    return Promise.all(jobs.concat([recent, due])).then(function () {
      return Promise.all([recent, due]);
    }).then(function (res) {
      var rr = res[0], dd = res[1];
      var html = head('نظرة عامة', 'الأرقام محسوبة على البيانات المسموح لك برؤيتها فقط (حسب الفرع والصلاحية).');
      html += '<div class="adm-tiles">' + tiles.map(function (t) {
        return '<a class="card card-stat adm-tile' + (t.tone && t.value ? ' adm-tile-' + t.tone : '') + '" href="' + t.hash + '"' + (t.err ? ' title="' + esc(errText(t.err)) + '"' : '') + '>' +
          '<span class="stat-value num">' + esc(t.value == null ? '—' : t.value) + '</span><span class="stat-label">' + esc(t.label) + '</span></a>';
      }).join('') + '</div>';
      var cols = '';
      if (canAny(R.opsWriter)) {
        cols += card('أحدث الطلبات', rr.error ? alertBox('danger', errText(rr.error)) : table(['المرجع', 'مقدّم الطلب', 'الحالة', 'التاريخ'], (rr.data || []).map(function (r) {
          return '<tr><td><a href="#request/' + esc(r.id) + '">' + ltr(r.ref) + '</a></td><td>' + esc(r.company || r.full_name) + '</td><td>' + badge('request_status', r.status) + '</td><td>' + fmtDate(r.created_at) + '</td></tr>';
        })), '<a class="btn btn-sm btn-ghost" href="#requests">كل الطلبات</a>');
      }
      cols += card('حاويات موعد إرجاعها خلال 3 أيام أو متأخرة', dd.error ? alertBox('danger', errText(dd.error)) : table(['الحاوية', 'المعاملة', 'آخر موعد', 'الحالة'], (dd.data || []).map(function (c) {
        var late = c.return_deadline < todayISO(0);
        return '<tr><td>' + ltr(c.container_no) + '</td><td><a href="#tx/' + esc(c.transaction_id) + '">' + ltr(c.transactions && c.transactions.ref) + '</a></td><td>' + fmtDate(c.return_deadline) +
          (late ? ' <span class="badge badge-danger">متأخرة</span>' : '') + '</td><td>' + badge('container_return_status', c.return_status) + '</td></tr>';
      })));
      return html + '<div class="adm-cols">' + cols + '</div>';
    });
  }

  /* ------------------------------------------------------------------
     Service requests
     ------------------------------------------------------------------ */
  function renderRequests() {
    var f = S.filters.requests;
    return api.listRequests({ status: f.status || null, search: f.search, limit: PAGE, offset: f.offset }).then(function (r) {
      var html = head(T.views.requests, 'الطلبات المرسلة من نموذج «اطلب تخليص» ومن الرفع الجماعي. راجع الطلب ثم حوّله إلى معاملة أو ارفضه مع ذكر السبب.');
      html += '<form class="adm-filters card" data-form="filter" data-key="requests">' +
        '<div class="form-group"><label class="form-label" for="flt-req-status">الحالة</label><select class="form-control" id="flt-req-status" name="status">' + opts('request_status', f.status, true) + '</select></div>' +
        '<div class="form-group adm-grow"><label class="form-label" for="flt-req-q">بحث</label><input class="form-control" id="flt-req-q" name="search" type="search" value="' + esc(f.search) + '" placeholder="المرجع أو الاسم أو الشركة أو رقم البوليصة"></div>' +
        '<button class="btn btn-primary" type="submit">' + T.common.search + '</button></form>';
      if (r.error) return html + alertBox('danger', errText(r.error));
      html += table(['المرجع', 'التاريخ', 'مقدّم الطلب', 'العملية', 'المنفذ', 'المصدر', 'الحالة', ''], (r.data || []).map(function (q) {
        return '<tr><td>' + ltr(q.ref) + '</td><td>' + fmtDate(q.created_at) + '</td><td><strong>' + esc(q.company || q.full_name) + '</strong>' +
          (q.company ? '<span class="adm-sub">' + esc(q.full_name) + '</span>' : '') + '</td><td>' + esc(lbl('direction', q.direction)) + ' · ' + esc(lbl('mode', q.mode)) +
          '</td><td>' + esc(q.port) + '</td><td>' + esc(lbl('source', q.source)) + '</td><td>' + badge('request_status', q.status) +
          '</td><td><a class="btn btn-sm btn-ghost" href="#request/' + esc(q.id) + '">' + T.common.view + '</a></td></tr>';
      }));
      return html + pager('requests', r.count);
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
            api.listClients({ search: input.value, limit: 20 }).then(function (cr) {
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
     Transactions
     ------------------------------------------------------------------ */
  function branchOpts(selected, blank) {
    return (blank ? '<option value="">' + esc(blank) + '</option>' : '') + S.branches.map(function (b) {
      return '<option value="' + esc(b.id) + '"' + (b.id === selected ? ' selected' : '') + '>' + esc(b.name_ar) + '</option>';
    }).join('');
  }
  function renderTransactions() {
    var f = S.filters.transactions;
    return api.listTransactions({ status: f.status || null, branchId: f.branchId || null, search: f.search, limit: PAGE, offset: f.offset }).then(function (r) {
      var html = head(T.views.transactions, 'المعاملة هي محور العمل: الحالة التشغيلية منفصلة عن الحالة المالية، وكل تغيير يُسجَّل في سجل أحداث لا يُعدّل.');
      html += '<form class="adm-filters card" data-form="filter" data-key="transactions">' +
        '<div class="form-group"><label class="form-label" for="flt-tx-status">الحالة التشغيلية</label><select class="form-control" id="flt-tx-status" name="status">' + opts('operational_status', f.status, true) + '</select></div>' +
        (S.branches.length > 1 ? '<div class="form-group"><label class="form-label" for="flt-tx-branch">الفرع</label><select class="form-control" id="flt-tx-branch" name="branchId">' + branchOpts(f.branchId, T.common.all) + '</select></div>' : '') +
        '<div class="form-group adm-grow"><label class="form-label" for="flt-tx-q">بحث</label><input class="form-control" id="flt-tx-q" name="search" type="search" value="' + esc(f.search) + '" placeholder="المرجع أو رقم البوليصة أو رقم البيان"></div>' +
        '<button class="btn btn-primary" type="submit">' + T.common.search + '</button></form>';
      if (r.error) return html + alertBox('danger', errText(r.error));
      html += table(['المرجع', 'العميل', 'الفرع', 'العملية', 'البوليصة', 'الحاويات', 'الحالة التشغيلية', 'الحالة المالية', 'آخر تغيير', ''], (r.data || []).map(function (t) {
        return '<tr><td>' + ltr(t.ref) + '</td><td>' + esc(t.clients && t.clients.name_ar) + '</td><td>' + esc(t.branches && t.branches.name_ar) + '</td><td>' +
          esc(lbl('direction', t.operation)) + ' · ' + esc(lbl('mode', t.mode)) + '</td><td>' + ltr(t.bl_number) + '</td><td>' + num(t.container_count) + '</td><td>' +
          badge('operational_status', t.operational_status) + '</td><td>' + badge('financial_status', t.financial_status) + '</td><td>' + fmtDate(t.status_changed_at) +
          '</td><td><a class="btn btn-sm btn-ghost" href="#tx/' + esc(t.id) + '">' + T.common.view + '</a></td></tr>';
      }));
      return html + pager('transactions', r.count);
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
            (late ? ' <span class="badge badge-danger">متأخرة</span>' : '') + '</td><td>' + esc(c.return_location || T.common.none) + '</td><td>' +
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
        return html;
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
        (d.version > 1 ? ' · نسخة ' + num(d.version) : '') + (voided ? ' · <span class="badge badge-danger">ملغى</span> ' + esc(d.void_reason || '') : '') + '</span></td><td>' +
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
        if (p.direction === 'backward') detail += '<span class="badge badge-warning">تصحيح للخلف</span> ';
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
        '<span class="tl-meta">' + esc(who(e.actor)) + ' · ' + fmtDateTime(e.created_at) + (e.visible_to_client ? ' · <span class="badge badge-teal">يظهر للعميل</span>' : '') + '</span></li>';
    }).join('') + '</ol>';
  }

  function txEdit(id) {
    var c = TX_CACHE[id]; if (!c) return;
    var t = c.tx;
    openDialog({
      title: 'تعديل بيانات المعاملة ' + t.ref, wide: true,
      body: alertBox('info', 'المرجع والحالات لا تُعدّل من هنا. كل تعديل يُحفظ في سجل التدقيق.') + grid(
        field({ name: 'service', label: 'الخدمة', type: 'select', options: opts('service', t.service, 'غير محدد') }) +
        field({ name: 'country', label: 'البلد', value: t.country, attrs: ' maxlength="80"' }) +
        field({ name: 'port_of_loading', label: 'ميناء الشحن', value: t.port_of_loading, attrs: ' maxlength="80"' }) +
        field({ name: 'port_of_discharge', label: 'ميناء الوصول', value: t.port_of_discharge, attrs: ' maxlength="80"' }) +
        field({ name: 'goods_description', label: 'وصف البضاعة', type: 'textarea', rows: 2, value: t.goods_description, attrs: ' maxlength="1000"', full: true }) +
        field({ name: 'hs_code', label: 'رمز HS', value: t.hs_code, ltr: true, attrs: ' inputmode="numeric" maxlength="12"', hint: '4 إلى 12 رقمًا' }) +
        field({ name: 'shipping_line', label: 'الخط الملاحي', value: t.shipping_line, attrs: ' maxlength="80"' }) +
        field({ name: 'bl_number', label: 'رقم البوليصة', value: t.bl_number, ltr: true, attrs: ' maxlength="40"' }) +
        field({ name: 'declaration_no', label: 'رقم البيان الجمركي', value: t.declaration_no, ltr: true, attrs: ' maxlength="30"', hint: 'رقم البيان فريد لكل معاملة.' }) +
        field({ name: 'declaration_date', label: 'تاريخ البيان', type: 'date', value: t.declaration_date }) +
        field({ name: 'declaration_type', label: 'نوع البيان', value: t.declaration_type, attrs: ' maxlength="40"' }) +
        field({ name: 'container_count', label: 'عدد الحاويات', type: 'number', value: t.container_count, attrs: ' min="0" step="1"' }) +
        field({ name: 'package_count', label: 'عدد الطرود', type: 'number', value: t.package_count, attrs: ' min="0" step="1"' }) +
        field({ name: 'eta', label: 'تاريخ الوصول المتوقع', type: 'date', value: t.eta }) +
        field({ name: 'notes', label: 'ملاحظات', type: 'textarea', rows: 2, value: t.notes, attrs: ' maxlength="2000"', full: true })
      ),
      onSubmit: function (form) {
        var patch = {};
        ['service', 'country', 'port_of_loading', 'port_of_discharge', 'goods_description', 'hs_code', 'shipping_line', 'bl_number',
          'declaration_no', 'declaration_date', 'declaration_type', 'eta', 'notes'].forEach(function (k) { patch[k] = nn(fval(form, k)); });
        if (patch.hs_code && !/^[0-9]{4,12}$/.test(patch.hs_code)) return 'رمز HS يجب أن يكون من 4 إلى 12 رقمًا.';
        if (patch.bl_number) patch.bl_number = patch.bl_number.toUpperCase();
        var cc = nn(fval(form, 'container_count')), pc = nn(fval(form, 'package_count'));
        patch.container_count = cc == null ? 0 : parseInt(cc, 10);
        patch.package_count = pc == null ? null : parseInt(pc, 10);
        if (isNaN(patch.container_count) || patch.container_count < 0 || (patch.package_count != null && (isNaN(patch.package_count) || patch.package_count < 0))) return 'الأعداد يجب أن تكون أرقامًا صحيحة موجبة.';
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
      onSubmit: function () {
        return api.issueTrackingToken(id).then(function (r) {
          if (r.error) return errText(r.error);
          var d = r.data || {};
          openDialog({
            title: 'رمز التتبع للمعاملة ' + (d.ref || ''), noSubmit: true,
            body: '<p class="text-sm">انسخ الرمز الآن؛ لن يظهر مرة أخرى.</p><div class="adm-token" dir="ltr"><span class="num">' + esc(d.ref) + '</span><code>' + esc(d.tracking_token) + '</code></div>'
          });
          rerender();
          return false;
        });
      }
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
    if (to === 'client' && !window.confirm('سيظهر المستند «' + d.original_name + '» للعميل في بوابته. هل تريد المتابعة؟')) return;
    api.setDocumentVisibility(id, to).then(function (r) {
      if (r.error) return toast(errText(r.error), 'error');
      toast(T.common.saved, 'success'); rerender();
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
    return api.listClients({ search: f.search, active: f.inactive ? false : true, limit: PAGE, offset: f.offset }).then(function (r) {
      var html = head(T.views.clients, 'ملف العميل سجل رئيسي مستقل يُستخدم في كل معاملاته، فلا تُعاد كتابة بياناته في كل معاملة.',
        canW ? '<button class="btn btn-sm btn-primary" type="button" data-act="client-new">' + icon('plus') + 'عميل جديد</button>' : '');
      html += '<form class="adm-filters card" data-form="filter" data-key="clients">' +
        '<div class="form-group adm-grow"><label class="form-label" for="flt-cl-q">بحث</label><input class="form-control" id="flt-cl-q" name="search" type="search" value="' + esc(f.search) + '" placeholder="الاسم أو السجل التجاري أو الرقم الضريبي"></div>' +
        '<label class="check adm-filter-check"><input type="checkbox" name="inactive"' + (f.inactive ? ' checked' : '') + '> إظهار غير النشطين</label>' +
        '<button class="btn btn-primary" type="submit">' + T.common.search + '</button></form>';
      if (r.error) return html + alertBox('danger', errText(r.error));
      html += table(['الاسم', 'النوع', 'السجل التجاري', 'الرقم الضريبي', 'الجوال', 'العنوان المختصر', 'الحالة', ''], (r.data || []).map(function (c) {
        return '<tr><td><strong>' + esc(c.name_ar) + '</strong>' + (c.name_en ? '<span class="adm-sub" dir="ltr">' + esc(c.name_en) + '</span>' : '') + '</td><td>' + esc(lbl('client_type', c.client_type)) +
          '</td><td>' + ltr(c.cr_number) + '</td><td>' + ltr(c.vat_number) + '</td><td>' + ltr(c.phone) + '</td><td>' + ltr(c.national_address_short) + '</td><td>' +
          (c.is_active ? '<span class="badge badge-success">نشط</span>' : '<span class="badge badge-danger">غير نشط</span>') +
          '</td><td><a class="btn btn-sm btn-ghost" href="#client/' + esc(c.id) + '">' + T.common.view + '</a></td></tr>';
      }));
      return html + pager('clients', r.count);
    });
  }
  var CLIENT_CACHE = {};
  function renderClient(id) {
    return Promise.all([api.getClient(id), api.listTransactions({ clientId: id, limit: 50 })]).then(function (res) {
      var r = res[0], c = r.data;
      if (r.error) return head('عميل', '', '', '#clients') + alertBox('danger', errText(r.error));
      if (!c) return head('عميل', '', '', '#clients') + alertBox('warning', 'العميل غير موجود أو لا تملك صلاحية عرضه.');
      CLIENT_CACHE[id] = c;
      var a = c.national_address || {};
      var html = head(esc(c.name_ar), esc(lbl('client_type', c.client_type)) + (c.is_active ? '' : ' · <span class="badge badge-danger">غير نشط</span>'),
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
      return html;
    });
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
    return api.listContactMessages({ status: f.status || null, limit: PAGE, offset: f.offset }).then(function (r) {
      var html = head(T.views.messages, 'رسائل نموذج «تواصل معنا». بيانات شخصية: اطّلع عليها لغرض الرد فقط.');
      html += '<form class="adm-filters card" data-form="filter" data-key="messages">' +
        '<div class="form-group"><label class="form-label" for="flt-msg-status">الحالة</label><select class="form-control" id="flt-msg-status" name="status">' + opts('contact_status', f.status, true) + '</select></div>' +
        '<button class="btn btn-primary" type="submit">تصفية</button></form>';
      if (r.error) return html + alertBox('danger', errText(r.error));
      (r.data || []).forEach(function (m) { MSG_CACHE[m.id] = m; });
      html += table(['المرجع', 'التاريخ', 'المرسل', 'الموضوع', 'التواصل المفضل', 'الحالة', ''], (r.data || []).map(function (m) {
        return '<tr><td>' + ltr(m.ref) + '</td><td>' + fmtDate(m.created_at) + '</td><td><strong>' + esc(m.name) + '</strong>' + (m.company ? '<span class="adm-sub">' + esc(m.company) + '</span>' : '') +
          '</td><td>' + esc(lbl('subject', m.subject)) + '</td><td>' + esc(lbl('contact_pref', m.preferred)) + '</td><td>' + badge('contact_status', m.status) +
          '</td><td><button class="btn btn-sm btn-ghost" type="button" data-act="msg-view" data-id="' + esc(m.id) + '">' + T.common.view + '</button></td></tr>';
      }));
      return html + pager('messages', r.count);
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
      var html = head(T.views.imports, 'دفعات ملفات Excel / CSV. كل صف له معرّف مصدر فريد (بصمة الملف + الورقة + رقم الصف) فلا يُستورد مرتين.');
      html += '<form class="adm-filters card" data-form="filter" data-key="imports">' +
        '<div class="form-group"><label class="form-label" for="flt-imp-status">الحالة</label><select class="form-control" id="flt-imp-status" name="status">' + opts('batch_status', f.status, true) + '</select></div>' +
        '<button class="btn btn-primary" type="submit">تصفية</button></form>';
      if (r.error) return html + alertBox('danger', errText(r.error));
      html += table(['المرجع', 'الملف', 'العميل', 'الصفوف', 'معتمد', 'متجاهَل', 'الحالة', 'التاريخ', ''], (r.data || []).map(function (b) {
        return '<tr><td>' + ltr(b.ref) + '</td><td><bdi>' + esc(b.file_name) + '</bdi><span class="adm-sub">' + fmtSize(b.file_size) + '</span></td><td>' + esc(b.clients ? b.clients.name_ar : T.common.none) +
          '</td><td>' + num(b.total_rows) + '</td><td>' + num(b.committed_rows) + '</td><td>' + num(b.skipped_rows) + '</td><td>' + badge('batch_status', b.status) +
          '</td><td>' + fmtDate(b.created_at) + '</td><td><a class="btn btn-sm btn-ghost" href="#import/' + esc(b.id) + '">' + T.common.view + '</a></td></tr>';
      }));
      return html + pager('imports', r.count);
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
    if (!window.confirm('إلغاء الدفعة نهائي ولا يمكن اعتمادها بعده. تبقى الصفوف محفوظة للسجل. هل تريد المتابعة؟')) return;
    api.cancelImportBatch(id).then(function (r) {
      if (r.error) return toast(errText(r.error), 'error');
      toast('تم إلغاء الدفعة.', 'success'); rerender();
    });
  }

  /* ------------------------------------------------------------------
     Members (admin: emails + add; supervisor: read-only names)
     ------------------------------------------------------------------ */
  function renderMembers() {
    var isAdmin = canAny(R.membersWrite);
    var p = isAdmin ? L.adminListMembers(S.orgId) : api.listMemberships(S.orgId).then(function (r) {
      if (r.error) return r;
      return { data: (r.data || []).map(function (m) {
        var b = S.branches.filter(function (x) { return x.id === m.branch_id; })[0];
        return { id: m.id, user_id: m.user_id, full_name: m.profiles && m.profiles.full_name, phone: m.profiles && m.profiles.phone, role: m.role, branch_id: m.branch_id, branch_name_ar: b && b.name_ar, is_active: m.is_active, created_at: m.created_at };
      }), error: null };
    });
    return p.then(function (r) {
      var html = head(T.views.members, isAdmin ? 'أضف موظفًا بالبريد الإلكتروني لحساب سجّل مسبقًا. لتغيير الصلاحية أضف الصلاحية الجديدة ثم أوقف القديمة، فيبقى السجل واضحًا.' : 'عرض فقط. إدارة الصلاحيات لمدير النظام.',
        isAdmin ? '<button class="btn btn-sm btn-primary" type="button" data-act="member-add">' + icon('plus') + 'إضافة صلاحية</button>' : '');
      if (r.error) return html + alertBox('danger', errText(r.error));
      var list = r.data || [];
      html += table(['المستخدم', isAdmin ? 'البريد الإلكتروني' : 'الجوال', 'الصلاحية', 'الفرع', 'الحالة', 'منذ', ''], list.map(function (m) {
        var me = m.is_me || (S.ctx && m.user_id === S.ctx.user_id);
        var act = '';
        if (isAdmin && !me) {
          act = '<button class="btn btn-sm btn-ghost' + (m.is_active ? ' adm-text-danger' : '') + '" type="button" data-act="member-toggle" data-id="' + esc(m.id) + '" data-to="' + (m.is_active ? '0' : '1') + '">' + (m.is_active ? 'إيقاف' : 'تفعيل') + '</button>';
        }
        return '<tr' + (m.is_active ? '' : ' class="adm-voided"') + '><td><strong>' + esc(m.full_name || 'بدون اسم') + '</strong>' + (me ? ' <span class="badge badge-teal">أنت</span>' : '') + '</td><td>' +
          (isAdmin ? ltr(m.email) : ltr(m.phone)) + '</td><td>' + esc(m.role_label_ar || lbl('role', m.role)) + '</td><td>' + esc(m.branch_name_ar || 'كل الفروع') + '</td><td>' +
          (m.is_active ? '<span class="badge badge-success">نشطة</span>' : '<span class="badge badge-danger">موقوفة</span>') + '</td><td>' + fmtDate(m.created_at) + '</td><td>' + act + '</td></tr>';
      }));
      return html;
    });
  }
  function memberAdd() {
    var staffRoles = R.staff;
    openDialog({
      title: 'إضافة صلاحية موظف',
      body: alertBox('info', 'يجب أن يكون للموظف حساب مسجّل بهذا البريد. لا تُنشأ حسابات من هنا، ولا تُمنح صلاحية «عميل» من هذه الشاشة.') + grid(
        field({ name: 'email', label: 'البريد الإلكتروني للحساب', type: 'email', req: true, ltr: true, attrs: ' maxlength="160" autocomplete="off"', full: true }) +
        field({ name: 'role', label: 'الصلاحية', type: 'select', req: true, options: opts('role', 'clearance_staff', false, staffRoles) }) +
        field({ name: 'branch', label: 'الفرع', type: 'select', options: '<option value="">كل الفروع</option>' + S.branches.filter(function (b) { return b.is_active; }).map(function (b) {
          return '<option value="' + esc(b.id) + '">' + esc(b.name_ar) + '</option>';
        }).join(''), hint: 'اختر فرعًا لحصر الصلاحية فيه (أقل صلاحية لازمة).' })
      ),
      onSubmit: function (form) {
        var email = nn(fval(form, 'email'));
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return 'اكتب بريدًا إلكترونيًا صحيحًا.';
        var role = fval(form, 'role');
        if (role === 'admin' && !window.confirm('صلاحية «مدير نظام» تمنح إدارة كل المستخدمين والبيانات. هل أنت متأكد؟')) return false;
        return L.adminAddMember({ orgId: S.orgId, email: email, role: role, branchId: fval(form, 'branch') || null }).then(function (r) {
          if (r.error) {
            if (r.error.raw && /^MRS_NOT_FOUND$/.test(r.error.raw.message || '')) return 'لا يوجد حساب مسجّل بهذا البريد. اطلب من الموظف إنشاء حساب أولًا.';
            if (r.error.code === '23505') return 'هذه الصلاحية موجودة ونشطة لهذا المستخدم.';
            return errText(r.error);
          }
          toast('تمت إضافة الصلاحية.', 'success'); rerender(); return true;
        });
      }
    });
  }
  function memberToggle(id, to) {
    if (!to && !window.confirm('إيقاف هذه الصلاحية يمنع المستخدم من الوصول بها فورًا. هل تريد المتابعة؟')) return;
    L.adminSetMemberActive(id, to).then(function (r) {
      if (r.error) return toast(r.error.raw && r.error.raw.message === 'MRS_FORBIDDEN' ? 'لا يمكن إيقاف صلاحيتك أنت أو آخر مدير نظام نشط.' : errText(r.error), 'error');
      toast(T.common.saved, 'success'); rerender();
    });
  }

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
      case 'page': {
        var k = el.getAttribute('data-key'), f = S.filters[k];
        f.offset = Math.max(0, f.offset + PAGE * parseInt(el.getAttribute('data-dir'), 10)); rerender(); break;
      }
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
      case 'member-add': memberAdd(); break;
      case 'member-toggle': memberToggle(id, el.getAttribute('data-to') === '1'); break;
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
  view.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    var kind = form.getAttribute('data-form');
    var btn = form.querySelector('[type=submit]');
    var done = function () { if (btn) btn.disabled = false; };
    if (btn) btn.disabled = true;
    if (kind === 'filter') {
      var key = form.getAttribute('data-key'), f = S.filters[key];
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name || !(el.name in f)) return;
        f[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim().slice(0, 60);
      });
      f.offset = 0; done(); rerender(); return;
    }
    var id = form.getAttribute('data-id') || form.getAttribute('data-tx');
    if (!id || !UUID_RE.test(id)) return done();
    if (kind === 'tx-status') {
      var st = form.elements.status.value, note = nn(form.elements.note.value);
      var opt = form.elements.status.selectedOptions[0];
      if (!st) { done(); return toast('اختر الحالة الجديدة.', 'warning'); }
      if (opt && opt.getAttribute('data-back') && !note) { done(); return toast(api.i18n.ar.errors.MRS_NOTE_REQUIRED, 'warning'); }
      api.setTransactionStatus(id, st, note).then(function (r) {
        done();
        if (r.error) return toast(errText(r.error), 'error');
        toast('تم تغيير الحالة إلى «' + lbl('operational_status', st) + '».', 'success'); rerender();
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
