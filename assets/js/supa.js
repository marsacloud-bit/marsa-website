/* ==========================================================================
   مرسى | MARSA — online data layer (Supabase, STAGING)  →  window.MarsaApi
   --------------------------------------------------------------------------
   Load order:  config.js → main.js → supa.js → <page>.js   (plain <script defer>)

   * Online  when window.MARSA_CONFIG has supabaseUrl + supabaseAnonKey:
     supabase-js v2 (UMD, pinned 2.45.4) is injected from jsDelivr on demand.
   * Demo    otherwise: nothing is loaded from the network; the public calls
     fall back to the existing localStorage behaviour (marsa_requests,
     marsa_messages) and every staff/portal call returns MRS_DEMO_MODE
     (except the OCR extractions, which fall back to marsa_extractions).

   EVERY method returns a Promise of { data, error } and never throws.
   error = { code: 'MRS_…' | pg code, field, message (Arabic), raw }.
   User-facing strings live in MarsaApi.i18n.ar (centralised for later EN).
   ========================================================================== */
(function () {
  'use strict';

  var SUPABASE_UMD = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  var cfg = window.MARSA_CONFIG || {};
  var M = window.Marsa || {};

  /* ------------------------------------------------------------------
     Strings (Arabic MSA). Keep all user-facing text here.
     ------------------------------------------------------------------ */
  var AR = {
    errors: {
      MRS_INVALID: 'قيمة غير صحيحة في حقل «{f}».',
      MRS_REQUIRED: 'حقل «{f}» مطلوب.',
      MRS_TOO_LONG: 'النص في حقل «{f}» أطول من المسموح.',
      MRS_RATE_LIMITED: 'وصلنا عدد كبير من الطلبات خلال وقت قصير. حاول مرة أخرى بعد ساعة.',
      MRS_NOT_FOUND: 'لم نعثر على بيانات مطابقة. تحقّق من الرقم المرجعي ورمز التتبع.',
      MRS_FORBIDDEN: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
      MRS_AUTH_REQUIRED: 'يلزم تسجيل الدخول أولًا.',
      MRS_INTAKE_CLOSED: 'استقبال الطلبات متوقف مؤقتًا. تواصل معنا هاتفيًا.',
      MRS_BAD_TRANSITION: 'لا يمكن تغيير الحالة بهذا الشكل.',
      MRS_NOTE_REQUIRED: 'اكتب سبب الإجراء (مطلوب للتصحيح أو الرفض).',
      MRS_CONTAINERS_NOT_RETURNED: 'لا يمكن إنهاء المعاملة تشغيليًا قبل توثيق إرجاع كل الحاويات (المتبقي: {f}).',
      MRS_EVIDENCE_INVALID: 'إثبات الإرجاع يجب أن يكون «إيصال استلام فارغ» مؤكّدًا من الموظف ومرفوعًا على المعاملة نفسها.',
      MRS_APPEND_ONLY: 'هذا السجل لا يقبل التعديل أو الحذف؛ أضف تصحيحًا جديدًا بدلًا من ذلك.',
      MRS_IMMUTABLE: 'الحقل «{f}» لا يمكن تعديله مباشرة.',
      MRS_ALREADY_CONVERTED: 'تم تحويل هذا الطلب إلى معاملة من قبل.',
      MRS_BRANCH_REQUIRED: 'اختر الفرع قبل تحويل الطلب إلى معاملة.',
      MRS_BATCH_NOT_DRAFT: 'هذه الدفعة اعتُمدت أو أُلغيت ولا يمكن تعديلها.',
      MRS_DEMO_MODE: 'هذه الميزة تعمل في النسخة المتصلة فقط. الموقع الآن في وضع نسخة العرض التجريبية (بيانات محلية على جهازك).',
      MRS_NETWORK: 'تعذّر الاتصال بالخادم. تحقّق من اتصالك بالإنترنت ثم حاول مرة أخرى.',
      MRS_CONFIG: 'إعدادات الاتصال غير صحيحة. راجع ملف assets/js/config.js.',
      MRS_LOCAL_SAVE: 'تعذّر الحفظ على هذا الجهاز. فعّل التخزين المحلي ثم حاول مرة أخرى.',
      MRS_UPLOAD: 'تعذّر رفع الملف. حاول مرة أخرى.',
      MRS_FILE_TOO_LARGE: 'حجم الملف أكبر من 25 ميغابايت.',
      MRS_EXTRACTION_DUPLICATE: 'هذا الملف محفوظ من قبل في المستندات المقروءة (للمعاملة نفسها). افتحه من «السجل» بدلًا من حفظه مرة أخرى.',
      MRS_EXTRACTION_VOIDED: 'هذا السجل مُلغى ولا يمكن تعديله.',
      MRS_EXTRACTION_ATTACHED: 'ربط السجل بمعاملة أو بمستند لا يمكن تغييره بعد تعيينه.',
      DUPLICATE: 'هذا السجل موجود من قبل (تكرار). إن كان ملفًا فقد رُفع سابقًا.',
      FK: 'مرجع غير صالح أو لا يخص مؤسستك.',
      CHECK: 'بعض القيم غير صحيحة.',
      RLS: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
      AUTH_INVALID: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
      AUTH_UNCONFIRMED: 'يلزم تأكيد البريد الإلكتروني أولًا من الرسالة المرسلة إليك.',
      AUTH_EXISTS: 'هذا البريد الإلكتروني مسجّل من قبل.',
      AUTH_WEAK: 'كلمة المرور ضعيفة. استخدم 8 أحرف على الأقل تجمع حروفًا وأرقامًا.',
      AUTH_RATE: 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.',
      UNKNOWN: 'حدث خطأ غير متوقع. حاول مرة أخرى.'
    },
    fields: {
      fullName: 'الاسم الكامل', company: 'اسم الشركة', phone: 'رقم الجوال', email: 'البريد الإلكتروني',
      clientType: 'نوع العميل', taxId: 'الرقم الضريبي', crNumber: 'السجل التجاري', contactPref: 'طريقة التواصل',
      direction: 'نوع العملية', service: 'الخدمة', mode: 'وسيلة الشحن', country: 'البلد', port: 'المنفذ',
      goods: 'وصف البضاعة', hsCode: 'رمز HS', declarationNo: 'رقم البيان', currency: 'العملة', value: 'القيمة',
      weight: 'الوزن', containerType: 'نوع الحاوية', containerNumbers: 'أرقام الحاويات', count: 'العدد',
      blNumber: 'رقم البوليصة', shippingLine: 'الخط الملاحي', eta: 'تاريخ الوصول', documents: 'المستندات',
      calc: 'التقدير', terms: 'الإقرار والشروط', payload: 'البيانات', name: 'الاسم', subject: 'الموضوع',
      message: 'الرسالة', preferred: 'طريقة التواصل المفضلة', consent: 'الموافقة', reference: 'الرقم المرجعي',
      note: 'الملاحظة', status: 'الحالة', branch: 'الفرع', client: 'العميل', role: 'الصلاحية',
      supersedes_id: 'النسخة السابقة', evidence_document_id: 'مستند الإثبات',
      empty_return_receipt_required: 'إيصال استلام الفارغ', operational_status: 'الحالة التشغيلية',
      financial_status: 'الحالة المالية', raw: 'القيمة الأصلية', row_status: 'حالة الصف', same_status: 'الحالة',
      raw_text: 'النص المستخرج', extracted_fields: 'البيانات المستخرجة', reviewed_fields: 'البيانات بعد المراجعة',
      line_items: 'البنود', review_status: 'حالة المراجعة', review_note: 'ملاحظة المراجعة', doc_type: 'نوع المستند',
      source_name: 'اسم الملف', source_sha256: 'بصمة الملف', transaction_id: 'المعاملة', document_id: 'المستند الأصلي',
      void_reason: 'سبب الإلغاء'
    },
    banner: {
      staging: 'بيئة تجريبية (Staging) — البيانات للاختبار فقط'
    }
  };

  /* ------------------------------------------------------------------
     Mode detection (never crash; refuse secret keys)
     ------------------------------------------------------------------ */
  function looksSecret(key) {
    if (!key) return false;
    if (/^sb_secret_/i.test(key)) return true;
    var parts = String(key).split('.');
    if (parts.length !== 3) return false;
    try {
      var json = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return json && json.role === 'service_role';
    } catch (e) { return false; }
  }
  var configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  var misconfigured = false;
  if (configured && looksSecret(cfg.supabaseAnonKey)) {
    configured = false; misconfigured = true;
    if (window.console) console.error('[Marsa] service_role/secret key detected in config.js — refusing to connect. Use the anon/publishable key.');
  }
  if (configured && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(cfg.supabaseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(cfg.supabaseUrl)) {
    configured = false; misconfigured = true;
    if (window.console) console.error('[Marsa] supabaseUrl looks invalid — staying in demo mode.');
  }
  var ORG_SLUG = cfg.orgSlug || 'blue-sea';

  /* ------------------------------------------------------------------
     Result / error helpers
     ------------------------------------------------------------------ */
  function fmt(tpl, f) {
    var label = f ? (AR.fields[f] || f) : '';
    return tpl.replace('{f}', label);
  }
  function mkErr(code, field, raw) {
    var tpl = AR.errors[code] || AR.errors.UNKNOWN;
    return { code: code, field: field || null, message: fmt(tpl, field), raw: raw || null };
  }
  function normalizeError(e) {
    if (!e) return mkErr('UNKNOWN');
    if (e.code && /^MRS_/.test(e.code) && e.message && e.raw !== undefined) return e; // already ours
    var msg = String(e.message || e.error_description || e.msg || '');
    var det = e.details != null ? String(e.details) : (e.detail != null ? String(e.detail) : '');
    if (/^MRS_[A-Z_]+$/.test(msg)) return mkErr(msg, det || null, e);
    var pg = e.code || '';
    if (pg === '23505') return mkErr('DUPLICATE', null, e);
    if (pg === '23503') return mkErr('FK', null, e);
    if (pg === '23514' || pg === '22P02' || pg === '22007' || pg === '22008') return mkErr('CHECK', null, e);
    if (pg === '42501' || /row-level security|permission denied/i.test(msg)) return mkErr('RLS', null, e);
    if (/invalid login credentials/i.test(msg)) return mkErr('AUTH_INVALID', null, e);
    if (/email not confirmed/i.test(msg)) return mkErr('AUTH_UNCONFIRMED', null, e);
    if (/already registered|already been registered|user already exists/i.test(msg)) return mkErr('AUTH_EXISTS', null, e);
    if (/password/i.test(msg) && /(weak|short|least|characters)/i.test(msg)) return mkErr('AUTH_WEAK', null, e);
    if (e.status === 429 || /rate limit|too many/i.test(msg)) return mkErr('AUTH_RATE', null, e);
    if (/failed to fetch|networkerror|load failed|network/i.test(msg)) return mkErr('MRS_NETWORK', null, e);
    return mkErr('UNKNOWN', null, e);
  }
  function ok(data) { return { data: data == null ? null : data, error: null }; }
  function fail(code, field, raw) { return { data: null, error: mkErr(code, field, raw) }; }
  function wrap(p) {
    return Promise.resolve(p).then(function (res) {
      if (res && res.error) return { data: null, error: normalizeError(res.error), count: res.count };
      return { data: res ? (res.data === undefined ? null : res.data) : null, error: null, count: res ? res.count : undefined };
    }, function (e) { return { data: null, error: normalizeError(e) }; });
  }
  function demoOnly() { return Promise.resolve(fail(misconfigured ? 'MRS_CONFIG' : 'MRS_DEMO_MODE')); }

  /* ------------------------------------------------------------------
     Lazy client
     ------------------------------------------------------------------ */
  var client = null;
  var readyPromise = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.supabase && window.supabase.createClient) return resolve();
      var s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to fetch supabase-js')); };
      document.head.appendChild(s);
    });
  }
  function ready() {
    if (!configured) return Promise.resolve(null);
    if (!readyPromise) {
      readyPromise = loadScript(SUPABASE_UMD).then(function () {
        client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'marsa_auth' }
        });
        api.client = client;
        return client;
      }).catch(function (e) {
        readyPromise = null;  // allow retry on next call
        throw e;
      });
    }
    return readyPromise;
  }
  // run fn(client) when online; demoFn() (or MRS_DEMO_MODE) otherwise
  function online(fn, demoFn) {
    if (!configured) return demoFn ? Promise.resolve().then(demoFn) : demoOnly();
    return ready().then(function (c) { return wrap(fn(c)); }, function (e) { return { data: null, error: normalizeError(e) }; });
  }
  function rpc(name, args, demoFn) {
    return online(function (c) { return c.rpc(name, args || {}); }, demoFn);
  }

  /* ------------------------------------------------------------------
     Payload mappers (request.js / contact.js record shapes → RPC payload)
     ------------------------------------------------------------------ */
  function toRequestPayload(r) {
    if (!r || typeof r !== 'object') return r;
    if (!r.client || !r.shipment) return Object.assign({ orgSlug: ORG_SLUG }, r);   // already flat
    var c = r.client, s = r.shipment, docs = [];
    Object.keys(r.documents || {}).forEach(function (k) {
      (r.documents[k] || []).forEach(function (f) { docs.push({ kind: k, name: f.name, size: f.size }); });
    });
    return {
      orgSlug: ORG_SLUG,
      fullName: c.fullName, company: c.company, phone: c.phone, email: c.email, clientType: c.clientType,
      taxId: c.taxId || c.vatNumber || '', crNumber: c.crNumber || '', contactPref: c.contactPref || '',
      direction: s.direction, service: s.service, mode: s.mode, country: s.country, port: s.port, goods: s.goods,
      hsCode: s.hsCode || '', declarationNo: s.declarationNo || '', needAci: !!s.needAci,
      value: s.value || '', currency: s.currency || '', weight: s.weightKg || '',
      containerType: s.containerType || '', containerNumbers: s.containerNumbers || [], count: s.count || '',
      blNumber: s.blNumber || '', shippingLine: s.shippingLine || '', eta: s.eta || '',
      docsLater: !!r.docsLater, notes: r.notes || '', documents: docs, calc: r.calc || null,
      terms: r.terms == null ? true : !!r.terms   // the wizard only submits after the terms checkbox is ticked
    };
  }
  function toContactPayload(m) {
    m = m || {};
    return {
      orgSlug: ORG_SLUG, name: m.name, company: m.company || '', phone: m.phone, email: m.email,
      subject: m.subject, reference: m.reference || '', message: m.message, preferred: m.preferred || 'phone',
      consent: m.consent == null ? true : !!m.consent
    };
  }

  /* ------------------------------------------------------------------
     Demo fallbacks (existing localStorage behaviour)
     ------------------------------------------------------------------ */
  function readLocal(key) {
    if (M.readLocal) return M.readLocal(key);
    try { var v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function saveLocal(key, obj) {
    if (M.saveLocal) return M.saveLocal(key, obj);
    try {
      var list = JSON.parse(localStorage.getItem(key) || '[]'); if (!Array.isArray(list)) list = [];
      list.push(Object.assign({ savedAt: new Date().toISOString() }, obj));
      localStorage.setItem(key, JSON.stringify(list)); return true;
    } catch (e) { return false; }
  }
  function genRef(prefix) {
    return M.genRef ? M.genRef(prefix) : prefix + '-' + new Date().getFullYear() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  }
  function demoSubmitRequest(record) {
    var rec = (record && record.client) ? record : { payload: record };
    if (!rec.ref) rec.ref = genRef('MRS');
    if (!saveLocal('marsa_requests', rec)) return fail('MRS_LOCAL_SAVE');
    return ok({ ref: rec.ref, tracking_token: null, status: 'new', created_at: new Date().toISOString(), demo: true });
  }
  function demoSubmitContact(entry) {
    var e = Object.assign({}, entry);
    if (!e.ref) e.ref = genRef('MRS');
    if (!saveLocal('marsa_messages', e)) return fail('MRS_LOCAL_SAVE');
    return ok({ ref: e.ref, created_at: new Date().toISOString(), demo: true });
  }
  function demoTrack(ref) {
    var r = String(ref || '').trim().toUpperCase();
    var hit = readLocal('marsa_requests').filter(function (x) { return x && String(x.ref || '').toUpperCase() === r; })[0];
    if (!hit) return fail('MRS_NOT_FOUND');
    return ok({
      ref: hit.ref, kind: 'request', demo: true, environment: 'demo',
      request: {
        ref: hit.ref, status: 'new', status_label_ar: 'محفوظ محليًا (نسخة عرض تجريبية)', status_label_en: 'Saved locally (demo)',
        direction: hit.shipment && hit.shipment.direction, mode: hit.shipment && hit.shipment.mode,
        created_at: hit.createdAt || hit.savedAt, reviewed_at: null
      },
      local: hit   // full local record for the existing tracking.js rendering
    });
  }

  /* ------------------------------------------------------------------
     Utilities
     ------------------------------------------------------------------ */
  function sha256Hex(input) {
    var getBuf = input instanceof ArrayBuffer ? Promise.resolve(input)
      : (input && input.arrayBuffer) ? input.arrayBuffer()
      : Promise.resolve(new TextEncoder().encode(String(input)).buffer);
    return getBuf.then(function (buf) { return crypto.subtle.digest('SHA-256', buf); }).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  // storage keys: ASCII only; the original (Arabic) name is kept in documents.original_name
  function safeFileName(name) {
    var n = String(name || 'file');
    var dot = n.lastIndexOf('.');
    var ext = dot > 0 ? n.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) : '';
    var base = (dot > 0 ? n.slice(0, dot) : n).normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'file';
    return ext ? base + '.' + ext : base;
  }
  function range(q, o) {
    var limit = Math.min(Math.max(parseInt(o && o.limit, 10) || 50, 1), 500);
    var offset = Math.max(parseInt(o && o.offset, 10) || 0, 0);
    return q.range(offset, offset + limit - 1);
  }
  function likeSafe(s) { return String(s || '').replace(/[%_,()\\]/g, ' ').trim().slice(0, 60); }

  /* ------------------------------------------------------------------
     Auth + context
     ------------------------------------------------------------------ */
  var ctxCache = null;
  function signIn(email, password) {
    return online(function (c) { ctxCache = null; return c.auth.signInWithPassword({ email: String(email || '').trim(), password: password }); });
  }
  function signUp(email, password, meta) {
    meta = meta || {};
    return online(function (c) {
      return c.auth.signUp({
        email: String(email || '').trim(), password: password,
        // profile hints only — roles are NEVER taken from signup data
        options: { data: { full_name: meta.fullName || '', phone: meta.phone || '', locale: meta.locale || 'ar' },
                   emailRedirectTo: meta.redirectTo || (location.origin + location.pathname.replace(/[^/]*$/, '') + 'login.html') }
      });
    });
  }
  function signOut() { return online(function (c) { ctxCache = null; return c.auth.signOut(); }); }
  function resetPassword(email, redirectTo) {
    return online(function (c) {
      return c.auth.resetPasswordForEmail(String(email || '').trim(),
        { redirectTo: redirectTo || (location.origin + location.pathname.replace(/[^/]*$/, '') + 'login.html#reset') });
    });
  }
  function updatePassword(newPassword) { return online(function (c) { return c.auth.updateUser({ password: newPassword }); }); }
  function currentUser() {
    return online(function (c) { return c.auth.getUser().then(function (r) { return { data: r.data ? r.data.user : null, error: r.error && r.error.name !== 'AuthSessionMissingError' ? r.error : null }; }); },
      function () { return ok(null); });
  }
  function getSession() {
    return online(function (c) { return c.auth.getSession().then(function (r) { return { data: r.data ? r.data.session : null, error: r.error }; }); },
      function () { return ok(null); });
  }
  // cb(event, session) — returns an unsubscribe function (no-op in demo)
  function onAuth(cb) {
    var unsub = function () {};
    if (!configured) return unsub;
    ready().then(function (c) {
      var sub = c.auth.onAuthStateChange(function (event, session) {
        ctxCache = null;
        try { cb(event, session); } catch (e) { if (window.console) console.error(e); }
      });
      unsub = function () { sub.data.subscription.unsubscribe(); };
    }, function () {});
    return function () { unsub(); };
  }
  function myContext(force) {
    if (!configured) return demoOnly();
    if (ctxCache && !force) return Promise.resolve(ok(ctxCache));
    return rpc('my_context').then(function (r) { if (!r.error) ctxCache = r.data; return r; });
  }
  function myMemberships() {
    return myContext().then(function (r) { return r.error ? r : ok(r.data.memberships || []); });
  }
  var ROLE_RANK = ['client', 'clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'operations_manager', 'supervisor', 'admin'];
  // highest role in the configured org (or orgSlug), null when none
  function myRole(orgSlug) {
    var slug = orgSlug || ORG_SLUG;
    return myMemberships().then(function (r) {
      if (r.error) return r;
      var roles = r.data.filter(function (m) { return m.org_slug === slug; }).map(function (m) { return m.role; });
      roles.sort(function (a, b) { return ROLE_RANK.indexOf(b) - ROLE_RANK.indexOf(a); });
      return ok(roles[0] || null);
    });
  }
  function hasRole(roles, orgSlug) {
    var slug = orgSlug || ORG_SLUG, want = [].concat(roles);
    return myMemberships().then(function (r) {
      if (r.error) return r;
      return ok(r.data.some(function (m) { return m.org_slug === slug && want.indexOf(m.role) !== -1; }));
    });
  }
  function isStaff(orgSlug) { return hasRole(ROLE_RANK.slice(1), orgSlug); }
  function orgId(orgSlug) {
    var slug = orgSlug || ORG_SLUG;
    return myMemberships().then(function (r) {
      if (r.error) return r;
      var m = r.data.filter(function (x) { return x.org_slug === slug; })[0];
      return m ? ok(m.org_id) : fail('MRS_FORBIDDEN', 'organization');
    });
  }

  /* ------------------------------------------------------------------
     Public RPCs (anon allowed)
     ------------------------------------------------------------------ */
  function submitServiceRequest(record) {
    return rpc('submit_service_request', { payload: toRequestPayload(record) }, function () { return demoSubmitRequest(record); });
  }
  function submitContactMessage(entry) {
    return rpc('submit_contact_message', { payload: toContactPayload(entry) }, function () { return demoSubmitContact(entry); });
  }
  function publicTrack(ref, token) {
    return rpc('public_track', { p_ref: String(ref || '').trim(), p_token: String(token || '').trim() }, function () { return demoTrack(ref); });
  }
  var labelCache = {};
  function statusLabels(domain) {
    if (labelCache[domain]) return Promise.resolve(ok(labelCache[domain]));
    return online(function (c) {
      return c.from('status_labels').select('code,sort,label_ar,label_en,client_visible').eq('domain', domain).order('sort');
    }, function () { return ok([]); }).then(function (r) { if (!r.error && r.data && r.data.length) labelCache[domain] = r.data; return r; });
  }

  /* ------------------------------------------------------------------
     Organization / branches / memberships (admin)
     ------------------------------------------------------------------ */
  function getOrg(orgSlug) {
    return online(function (c) { return c.from('organizations').select('id,slug,name_ar,name_en,environment,default_locale').eq('slug', orgSlug || ORG_SLUG).maybeSingle(); });
  }
  function listBranches() {
    return online(function (c) { return c.from('branches').select('id,org_id,code,name_ar,name_en,city,is_active').order('code'); });
  }
  function listMemberships(oid) {
    return online(function (c) {
      var q = c.from('memberships').select('id,user_id,org_id,branch_id,role,is_active,created_at,profiles(full_name,phone)').order('created_at');
      return oid ? q.eq('org_id', oid) : q;
    });
  }
  // memberships are written ONLY through the admin RPCs (0650): they refuse self-changes and
  // removing the last active admin. Direct table writes are revoked server-side.
  function addMembership(m) {
    m = m || {};
    if (!m.email) return Promise.resolve(fail('MRS_REQUIRED', 'email'));
    return rpc('admin_add_member', { p_org: m.orgId, p_email: m.email, p_role: m.role, p_branch: m.branchId || null });
  }
  function setMembershipActive(id, active) {
    return rpc('admin_set_member_active', { p_membership: id, p_active: !!active });
  }

  // Internal staff fields (transactions.notes, clients.notes/classification) are not selectable by
  // the API roles (0700 column grants). Staff get them through staff_internal_fields(); for clients
  // the RPC returns nothing, so the fields stay absent.
  function withInternal(table, res) {
    if (!res || res.error || !res.data) return Promise.resolve(res);
    var rows = Array.isArray(res.data) ? res.data : [res.data];
    var ids = rows.map(function (r) { return r && r.id; }).filter(Boolean).slice(0, 500);
    if (!ids.length) return Promise.resolve(res);
    return isStaff().then(function (st) {
      if (st.error || !st.data) return res;
      return rpc('staff_internal_fields', { p_table: table, p_ids: ids }).then(function (r) {
        if (r.error || !r.data) return res;
        rows.forEach(function (row) { if (row && r.data[row.id]) Object.assign(row, r.data[row.id]); });
        return res;
      });
    });
  }

  /* ------------------------------------------------------------------
     Service requests (intake queue)
     ------------------------------------------------------------------ */
  var REQ_COLS = 'id,org_id,branch_id,ref,status,source,client_id,client_type,full_name,company,phone,email,vat_number,cr_number,' +
    'contact_pref,direction,service,mode,country,port,goods,hs_code,declaration_no,need_aci,goods_value,currency,weight_kg,' +
    'container_type,container_numbers,declared_count,count_kind,bl_number,shipping_line,eta,docs_later,declared_documents,' +
    'estimate,notes,status_note,reviewed_by,reviewed_at,created_at,updated_at';
  function listRequests(o) {
    o = o || {};
    return online(function (c) {
      var q = c.from('service_requests').select(REQ_COLS, { count: 'exact' }).order('created_at', { ascending: false });
      if (o.status) q = q.eq('status', o.status);
      if (o.search) { var s = likeSafe(o.search); if (s) q = q.or('ref.ilike.%' + s + '%,full_name.ilike.%' + s + '%,company.ilike.%' + s + '%,bl_number.ilike.%' + s + '%'); }
      return range(q, o);
    });
  }
  function getRequest(id) {
    return online(function (c) { return c.from('service_requests').select(REQ_COLS).eq('id', id).maybeSingle(); });
  }
  function updateRequest(id, patch) {   // non-status fields only (status/ref are guarded server-side)
    return online(function (c) { return c.from('service_requests').update(patch).eq('id', id).select(REQ_COLS).single(); });
  }
  function setRequestStatus(id, status, note) {
    return rpc('set_request_status', { p_request_id: id, p_status: status, p_note: note || null });
  }
  function convertRequest(id, o) {
    o = o || {};
    return rpc('convert_request_to_transaction', { p_request_id: id, p_branch_id: o.branchId || null, p_client_id: o.clientId || null });
  }

  /* ------------------------------------------------------------------
     Clients
     ------------------------------------------------------------------ */
  var CLIENT_COLS = 'id,org_id,client_type,name_ar,name_en,contact_person,cr_number,vat_number,phone,email,' +
    'preferred_contact,national_address,national_address_short,is_active,created_at,updated_at';   // notes/classification: withInternal()
  function listClients(o) {
    o = o || {};
    return online(function (c) {
      var q = c.from('clients').select(CLIENT_COLS, { count: 'exact' }).order('name_ar');
      if (o.active !== false) q = q.eq('is_active', true);
      if (o.search) { var s = likeSafe(o.search); if (s) q = q.or('name_ar.ilike.%' + s + '%,name_en.ilike.%' + s + '%,cr_number.ilike.%' + s + '%,vat_number.ilike.%' + s + '%'); }
      return range(q, o);
    }).then(function (r) { return withInternal('clients', r); });
  }
  function getClient(id) { return online(function (c) { return c.from('clients').select(CLIENT_COLS).eq('id', id).maybeSingle(); }).then(function (r) { return withInternal('clients', r); }); }
  function createClient(row) { return online(function (c) { return c.from('clients').insert(row).select(CLIENT_COLS).single(); }).then(function (r) { return withInternal('clients', r); }); }
  function updateClient(id, patch) { return online(function (c) { return c.from('clients').update(patch).eq('id', id).select(CLIENT_COLS).single(); }).then(function (r) { return withInternal('clients', r); }); }
  function linkClientUser(o) {
    return online(function (c) {
      return c.from('client_users').insert({ org_id: o.orgId, client_id: o.clientId, user_id: o.userId, role: o.role || 'member' }).select().single();
    });
  }

  /* ------------------------------------------------------------------
     Transactions (hub) + containers + events
     ------------------------------------------------------------------ */
  var TX_COLS = 'id,org_id,branch_id,client_id,request_id,ref,operation,mode,service,port_of_loading,port_of_discharge,country,' +
    'goods_description,hs_code,shipping_line,bl_number,declaration_no,declaration_date,declaration_type,container_count,' +
    'package_count,eta,responsible_user_id,operational_status,financial_status,status_changed_at,created_at,updated_at';   // notes: withInternal()
  function listTransactions(o) {
    o = o || {};
    return online(function (c) {
      var q = c.from('transactions').select(TX_COLS + ',clients(name_ar),branches(code,name_ar)', { count: 'exact' })
        .order('created_at', { ascending: false });
      if (o.status) q = q.eq('operational_status', o.status);
      if (o.financialStatus) q = q.eq('financial_status', o.financialStatus);
      if (o.branchId) q = q.eq('branch_id', o.branchId);
      if (o.clientId) q = q.eq('client_id', o.clientId);
      if (o.search) { var s = likeSafe(o.search); if (s) q = q.or('ref.ilike.%' + s + '%,bl_number.ilike.%' + s + '%,declaration_no.ilike.%' + s + '%'); }
      return range(q, o);
    }).then(function (r) { return withInternal('transactions', r); });
  }
  function getTransaction(id) {
    return online(function (c) {
      return c.from('transactions').select(TX_COLS + ',clients(id,name_ar,client_type),branches(code,name_ar),containers(*)').eq('id', id).maybeSingle();
    }).then(function (r) { return withInternal('transactions', r); });
  }
  function createTransaction(row) {   // ref/status are set by the server
    return online(function (c) { return c.from('transactions').insert(row).select(TX_COLS).single(); }).then(function (r) { return withInternal('transactions', r); });
  }
  function updateTransaction(id, patch) {
    return online(function (c) { return c.from('transactions').update(patch).eq('id', id).select(TX_COLS).single(); }).then(function (r) { return withInternal('transactions', r); });
  }
  function setTransactionStatus(id, status, note) {
    return rpc('set_transaction_status', { p_transaction_id: id, p_status: status, p_note: note || null });
  }
  function setFinancialStatus(id, status, note) {
    return rpc('set_financial_status', { p_transaction_id: id, p_status: status, p_note: note || null });
  }
  function issueTrackingToken(id) { return rpc('issue_tracking_token', { p_transaction_id: id }); }
  function listEvents(txId) {
    return online(function (c) {
      return c.from('transaction_events').select('id,event_type,from_status,to_status,note,payload,visible_to_client,actor,created_at')
        .eq('transaction_id', txId).order('created_at').order('id');
    });
  }
  function addNote(txId, note) {
    return getTransaction(txId).then(function (r) {
      if (r.error) return r;
      if (!r.data) return fail('MRS_NOT_FOUND');
      return online(function (c) {
        return c.from('transaction_events').insert({ org_id: r.data.org_id, transaction_id: txId, event_type: 'note', note: note }).select().single();
      });
    });
  }
  function listContainers(txId) {
    return online(function (c) { return c.from('containers').select('*').eq('transaction_id', txId).order('container_no'); });
  }
  function addContainer(txId, row) {
    return getTransaction(txId).then(function (r) {
      if (r.error) return r;
      if (!r.data) return fail('MRS_NOT_FOUND');
      return online(function (c) {
        return c.from('containers').insert(Object.assign({}, row, { org_id: r.data.org_id, transaction_id: txId })).select().single();
      });
    });
  }
  // e.g. {return_status:'returned_verified', evidence_document_id, returned_at} — the DB enforces the evidence rule
  function updateContainer(id, patch) {
    return online(function (c) { return c.from('containers').update(patch).eq('id', id).select().single(); });
  }

  /* ------------------------------------------------------------------
     Documents (+ Storage bucket "documents")
     ------------------------------------------------------------------ */
  var DOC_COLS = 'id,org_id,transaction_id,request_id,kind,classification,classification_status,classification_note,classified_by,' +
    'classified_at,storage_path,sha256,original_name,mime_type,size_bytes,version,supersedes_id,source,source_ref,visibility,' +
    'uploaded_by,uploaded_at,voided_at,void_reason';
  function listDocuments(o) {
    o = o || {};
    return online(function (c) {
      var q = c.from('documents').select(DOC_COLS).order('uploaded_at', { ascending: false });
      if (o.transactionId) q = q.eq('transaction_id', o.transactionId);
      if (o.requestId) q = q.eq('request_id', o.requestId);
      if (!o.includeVoided) q = q.is('voided_at', null);
      return q;
    });
  }
  // o = { file, transactionId | requestId, kind, visibility, source, sourceRef, supersedesId }
  function uploadDocument(o) {
    if (!configured) return demoOnly();
    o = o || {};
    var file = o.file;
    if (!file) return Promise.resolve(fail('MRS_REQUIRED', 'documents'));
    if (file.size > 26214400) return Promise.resolve(fail('MRS_FILE_TOO_LARGE'));
    var ownerQ = o.transactionId
      ? online(function (c) { return c.from('transactions').select('org_id').eq('id', o.transactionId).maybeSingle(); })
      : online(function (c) { return c.from('service_requests').select('org_id').eq('id', o.requestId).maybeSingle(); });
    var id = uuid(), path, row;
    return ownerQ.then(function (r) {
      if (r.error) return r;
      if (!r.data) return fail('MRS_NOT_FOUND');
      return sha256Hex(file).then(function (hash) {
        path = r.data.org_id + '/' + (o.transactionId || ('r_' + o.requestId)) + '/' + id + '/' + safeFileName(file.name);
        row = {
          id: id, org_id: r.data.org_id, transaction_id: o.transactionId || null, request_id: o.requestId || null,
          kind: o.kind || 'other', storage_path: path, sha256: hash, original_name: String(file.name || 'file').slice(0, 255),
          mime_type: file.type || null, size_bytes: file.size, source: o.source || 'upload', source_ref: o.sourceRef || null,
          supersedes_id: o.supersedesId || null
          // uploaded_by / classification fields are stamped by the server trigger
        };
        if (o.visibility) row.visibility = o.visibility;
        return online(function (c) { return c.from('documents').insert(row).select(DOC_COLS).single(); });
      });
    }).then(function (r) {
      if (r.error || !r.data) return r;
      var doc = r.data;
      return online(function (c) {
        return c.storage.from('documents').upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
      }).then(function (u) {
        if (u.error) return { data: doc, error: mkErr('MRS_UPLOAD', null, u.error.raw || u.error) };  // metadata saved, bytes not
        return ok(doc);
      });
    });
  }
  function documentUrl(docOrPath, expiresIn) {
    var p = typeof docOrPath === 'string' ? docOrPath : docOrPath && docOrPath.storage_path;
    return online(function (c) { return c.storage.from('documents').createSignedUrl(p, expiresIn || 300); })
      .then(function (r) {
        if (r.error) return r;
        // only ever navigate to a signed URL on our own Supabase project (no open redirect via API data)
        var u = r.data && r.data.signedUrl, base = '';
        try { base = new URL(cfg.supabaseUrl).origin; if (new URL(u, base).origin !== base) u = null; } catch (e) { u = null; }
        return u ? ok(u) : fail('MRS_INVALID', 'signed_url');
      });
  }
  function classifyDocument(id, classification, status, note) {
    return online(function (c) {
      return c.from('documents').update({ classification: classification, classification_status: status || 'confirmed', classification_note: note || null })
        .eq('id', id).select(DOC_COLS).single();
    });
  }
  function setDocumentVisibility(id, visibility) {
    return online(function (c) { return c.from('documents').update({ visibility: visibility }).eq('id', id).select(DOC_COLS).single(); });
  }
  function voidDocument(id, reason) {
    return online(function (c) {
      return c.from('documents').update({ voided_at: new Date().toISOString(), void_reason: reason }).eq('id', id).select(DOC_COLS).single();
    });
  }

  /* ------------------------------------------------------------------
     Bulk import staging
     ------------------------------------------------------------------ */
  // o = { file? | fingerprint, fileName, fileSize, sheetNames[], clientId?, orgId? }
  function createImportBatch(o) {
    if (!configured) return demoOnly();
    o = o || {};
    var fp = o.fingerprint ? Promise.resolve(o.fingerprint) : sha256Hex(o.file);
    var oid = o.orgId ? Promise.resolve(ok(o.orgId)) : orgId();
    return Promise.all([fp, oid]).then(function (v) {
      if (v[1].error) return v[1];
      return online(function (c) {
        return c.from('import_batches').insert({
          org_id: v[1].data, client_id: o.clientId || null, file_name: String(o.fileName || (o.file && o.file.name) || 'file').slice(0, 255),
          file_size: o.fileSize != null ? o.fileSize : (o.file ? o.file.size : null), file_fingerprint: v[0],
          sheet_names: o.sheetNames || []   // created_by is stamped by the server
        }).select().single();
      });
    }, function (e) { return { data: null, error: normalizeError(e) }; });
  }
  // rows = [{ sheet, rowNo, raw, normalized, status:'valid'|'error'|'pending', errors:[] }]
  function addImportRows(batchId, rows) {
    return online(function (c) {
      return c.from('import_rows').insert((rows || []).map(function (r) {
        // org_id and source_fingerprint are copied from the batch by the server trigger
        return { batch_id: batchId, sheet_name: r.sheet || '', row_no: r.rowNo,
                 raw: r.raw || {}, normalized: r.normalized || null, row_status: r.status || 'pending', validation_errors: r.errors || [] };
      })).select('id,sheet_name,row_no,source_row_id,row_status');
    });
  }
  function listImportRows(batchId) {
    return online(function (c) { return c.from('import_rows').select('*').eq('batch_id', batchId).order('sheet_name').order('row_no'); });
  }
  // patch: { normalized, row_status ('valid'|'error'|'pending'), validation_errors, decision ('accept'|'skip') }
  function updateImportRow(id, patch) {
    return online(function (c) { return c.from('import_rows').update(patch).eq('id', id).select().single(); });
  }
  function findBatchByFingerprint(fingerprint) {
    return online(function (c) { return c.from('import_batches').select('*').eq('file_fingerprint', fingerprint).order('created_at', { ascending: false }); });
  }
  function cancelImportBatch(id) {
    return online(function (c) { return c.from('import_batches').update({ status: 'cancelled' }).eq('id', id).select().single(); });
  }
  function importCommit(batchId) { return rpc('import_commit', { p_batch_id: batchId }); }

  /* ------------------------------------------------------------------
     Document extractions (OCR) — public.document_extractions
     Staff only. extracted_fields / qr_payload / raw_text are the machine output
     and immutable after insert; review changes go to reviewed_fields, line_items,
     review_status, review_note, doc_type. No delete: void with a reason.
     Demo (and signed-out / non-staff use of ocr.html): the same row shape is
     kept in localStorage "marsa_extractions" via api.localExtractions.
     ------------------------------------------------------------------ */
  var EXT_LIST_COLS = 'id,org_id,transaction_id,document_id,doc_type,source_name,source_sha256,source_mime,source_size,source_pages,' +
    'engine,languages,mean_confidence,extracted_fields,qr_payload,reviewed_fields,review_status,review_note,reviewed_by,reviewed_at,' +
    'created_by,created_at,voided_at,void_reason';
  var EXT_COLS = EXT_LIST_COLS + ',raw_text,line_items';
  var EXT_INSERT = ['org_id', 'transaction_id', 'document_id', 'doc_type', 'source_name', 'source_sha256', 'source_mime', 'source_size',
    'source_pages', 'engine', 'languages', 'mean_confidence', 'raw_text', 'extracted_fields', 'qr_payload', 'line_items'];
  var EXT_REVIEW = ['reviewed_fields', 'line_items', 'review_status', 'review_note', 'doc_type', 'transaction_id', 'document_id'];
  var EXT_LOCAL_KEY = 'marsa_extractions';
  var EXT_LOCAL_MAX = 50;
  function pickKeys(o, keys) {
    var out = {};
    keys.forEach(function (k) { if (o && o[k] !== undefined) out[k] = o[k]; });
    return out;
  }
  // client-side shape checks (the database enforces the same rules)
  function checkExtraction(row, insert) {
    if (insert) {
      if (!row.source_name) return 'source_name';
      if (!/^[0-9a-f]{64}$/.test(String(row.source_sha256 || ''))) return 'source_sha256';
      if (typeof row.raw_text !== 'string') return 'raw_text';
    }
    if (row.raw_text != null && String(row.raw_text).length > 200000) return 'raw_text';
    if (row.line_items != null && !Array.isArray(row.line_items)) return 'line_items';
    if (row.review_status != null && ['unreviewed', 'reviewed', 'rejected'].indexOf(row.review_status) === -1) return 'review_status';
    if (row.review_note != null && String(row.review_note).length > 1000) return 'review_note';
    return null;
  }
  function extErr(r) {
    if (r && r.error && r.error.code === 'DUPLICATE') return { data: null, error: mkErr('MRS_EXTRACTION_DUPLICATE', null, r.error.raw) };
    return r;
  }

  /* local store (demo mode + signed-out / non-staff use of ocr.html) */
  function extLocalRead() {
    try { var v = JSON.parse(localStorage.getItem(EXT_LOCAL_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function extLocalWrite(list) {
    try { localStorage.setItem(EXT_LOCAL_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  var localExtractions = {
    save: function (row) {
      row = row || {};
      var bad = checkExtraction(Object.assign({ raw_text: '' }, row), false);
      if (bad) return Promise.resolve(fail('MRS_INVALID', bad));
      var list = extLocalRead();
      var txKey = row.transaction_id || null;
      if (row.source_sha256 && list.some(function (x) { return !x.voided_at && x.source_sha256 === row.source_sha256 && (x.transaction_id || null) === txKey; })) {
        return Promise.resolve(fail('MRS_EXTRACTION_DUPLICATE'));
      }
      var rec = Object.assign({ doc_type: 'other', extracted_fields: {}, qr_payload: null, reviewed_fields: null, line_items: [],
        review_status: 'unreviewed', review_note: null, reviewed_at: null, voided_at: null, void_reason: null },
        pickKeys(row, EXT_INSERT.concat(['reviewed_fields', 'review_status', 'review_note'])),
        { id: uuid(), created_at: new Date().toISOString(), local: true });
      list.unshift(rec);
      while (list.length > EXT_LOCAL_MAX) list.pop();
      if (!extLocalWrite(list)) return Promise.resolve(fail('MRS_LOCAL_SAVE'));
      return Promise.resolve(ok(rec));
    },
    list: function (o) {
      o = o || {};
      var q = String(o.q || '').trim().toLowerCase();
      var rows = extLocalRead().filter(function (x) {
        if (x.voided_at && !o.includeVoided) return false;
        if (!q) return true;
        var f = Object.assign({}, x.extracted_fields || {}, x.reviewed_fields || {});
        return [x.source_name, f.invoice_number, f.supplier_name, f.bl_number].some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; });
      });
      var offset = Math.max(parseInt(o.offset, 10) || 0, 0), limit = Math.min(Math.max(parseInt(o.limit, 10) || 50, 1), 500);
      var page = rows.slice(offset, offset + limit).map(function (x) { var c = Object.assign({}, x); delete c.raw_text; return c; });
      return Promise.resolve({ data: page, error: null, count: rows.length });
    },
    get: function (id) {
      var hit = extLocalRead().filter(function (x) { return x.id === id; })[0];
      return Promise.resolve(hit ? ok(hit) : fail('MRS_NOT_FOUND'));
    },
    review: function (id, patch) {
      var p = pickKeys(patch || {}, EXT_REVIEW);
      var bad = checkExtraction(p, false);
      if (bad) return Promise.resolve(fail('MRS_INVALID', bad));
      var list = extLocalRead(), hit = null;
      list.forEach(function (x) { if (x.id === id) hit = x; });
      if (!hit) return Promise.resolve(fail('MRS_NOT_FOUND'));
      if (hit.voided_at) return Promise.resolve(fail('MRS_EXTRACTION_VOIDED'));
      if ((p.transaction_id && hit.transaction_id && p.transaction_id !== hit.transaction_id) ||
          (p.document_id && hit.document_id && p.document_id !== hit.document_id)) return Promise.resolve(fail('MRS_EXTRACTION_ATTACHED'));
      Object.assign(hit, p);
      if (p.review_status !== undefined || p.reviewed_fields !== undefined) hit.reviewed_at = new Date().toISOString();
      if (!extLocalWrite(list)) return Promise.resolve(fail('MRS_LOCAL_SAVE'));
      return Promise.resolve(ok(hit));
    },
    void: function (id, reason) {
      var list = extLocalRead(), hit = null;
      list.forEach(function (x) { if (x.id === id) hit = x; });
      if (!hit) return Promise.resolve(fail('MRS_NOT_FOUND'));
      if (hit.voided_at) return Promise.resolve(fail('MRS_EXTRACTION_VOIDED'));
      hit.voided_at = new Date().toISOString();
      hit.void_reason = String(reason || '').slice(0, 500);
      return Promise.resolve(extLocalWrite(list) ? ok(hit) : fail('MRS_LOCAL_SAVE'));
    },
    // local only: the server has no delete (void instead)
    remove: function (id) {
      var list = extLocalRead(), n = list.length;
      list = list.filter(function (x) { return x.id !== id; });
      if (list.length === n) return Promise.resolve(fail('MRS_NOT_FOUND'));
      return Promise.resolve(extLocalWrite(list) ? ok(true) : fail('MRS_LOCAL_SAVE'));
    }
  };

  // row = { org_id?, transaction_id?, document_id?, doc_type, source_name, source_sha256, source_mime, source_size,
  //         source_pages, engine, languages, mean_confidence, raw_text, extracted_fields, qr_payload, line_items }
  // created_by / created_at are stamped by the server. Review fields go through reviewExtraction().
  function saveExtraction(row) {
    row = row || {};
    if (!configured) return localExtractions.save(row);
    var ins = pickKeys(row, EXT_INSERT);
    var bad = checkExtraction(ins, true);
    if (bad) return Promise.resolve(fail('MRS_INVALID', bad));
    var oid = ins.org_id ? Promise.resolve(ok(ins.org_id))
      : ins.transaction_id ? online(function (c) { return c.from('transactions').select('org_id').eq('id', ins.transaction_id).maybeSingle(); })
          .then(function (r) { return r.error ? r : (r.data ? ok(r.data.org_id) : fail('MRS_NOT_FOUND')); })
      : orgId();
    return oid.then(function (r) {
      if (r.error) return r;
      ins.org_id = r.data;
      return online(function (c) { return c.from('document_extractions').insert(ins).select(EXT_COLS).single(); }).then(extErr);
    });
  }
  // o = { limit, offset, q, transactionId, status, includeVoided } — raw_text / line_items are not listed (use getExtraction)
  function listExtractions(o) {
    o = o || {};
    if (!configured) return localExtractions.list(o);
    return online(function (c) {
      var q = c.from('document_extractions').select(EXT_LIST_COLS, { count: 'exact' }).order('created_at', { ascending: false });
      if (!o.includeVoided) q = q.is('voided_at', null);
      if (o.transactionId) q = q.eq('transaction_id', o.transactionId);
      if (o.status) q = q.eq('review_status', o.status);
      if (o.q) {
        var s = likeSafe(o.q);
        if (s) q = q.or('source_name.ilike.%' + s + '%,extracted_fields->>invoice_number.ilike.%' + s + '%,reviewed_fields->>invoice_number.ilike.%' + s +
          '%,extracted_fields->>bl_number.ilike.%' + s + '%,extracted_fields->>supplier_name.ilike.%' + s + '%');
      }
      return range(q, o);
    });
  }
  function getExtraction(id) {
    if (!configured) return localExtractions.get(id);
    return online(function (c) { return c.from('document_extractions').select(EXT_COLS).eq('id', id).maybeSingle(); })
      .then(function (r) { return r.error || r.data ? r : fail('MRS_NOT_FOUND'); });
  }
  // patch = { reviewed_fields, line_items, review_status, review_note, doc_type, transaction_id (NULL→value), document_id (NULL→value) }
  // reviewed_by / reviewed_at are stamped by the server
  function reviewExtraction(id, patch) {
    if (!configured) return localExtractions.review(id, patch);
    var p = pickKeys(patch || {}, EXT_REVIEW);
    var bad = checkExtraction(p, false);
    if (bad) return Promise.resolve(fail('MRS_INVALID', bad));
    if (!Object.keys(p).length) return getExtraction(id);
    return online(function (c) { return c.from('document_extractions').update(p).eq('id', id).select(EXT_COLS).single(); }).then(extErr);
  }
  function voidExtraction(id, reason) {
    var why = String(reason || '').trim();
    if (!why) return Promise.resolve(fail('MRS_REQUIRED', 'void_reason'));
    if (!configured) return localExtractions.void(id, why);
    return online(function (c) {
      return c.from('document_extractions').update({ voided_at: new Date().toISOString(), void_reason: why.slice(0, 500) })
        .eq('id', id).select(EXT_COLS).single();
    });
  }
  // Upload the original file to the transaction (documents + Storage), then link it to the
  // extraction (transaction_id / document_id: NULL→value only). Same bytes already on that
  // transaction → the existing document row is reused.
  function attachExtractionDocument(id, o) {
    o = o || {};
    if (!configured) return demoOnly();
    if (!o.file || !o.transactionId) return Promise.resolve(fail('MRS_REQUIRED', !o.file ? 'documents' : 'transaction_id'));
    return uploadDocument({ file: o.file, transactionId: o.transactionId, kind: o.kind || 'other', source: 'staff_scan', sourceRef: 'ocr:' + id })
      .then(function (r) {
        if (r.error && r.error.code === 'DUPLICATE') {
          return sha256Hex(o.file).then(function (hash) {
            return online(function (c) {
              return c.from('documents').select(DOC_COLS).eq('transaction_id', o.transactionId).eq('sha256', hash).is('voided_at', null).maybeSingle();
            });
          }).then(function (d) { return d.error || d.data ? d : fail('MRS_NOT_FOUND'); });
        }
        return r;   // { data: doc, error: MRS_UPLOAD } = metadata saved but the bytes were not
      })
      .then(function (r) {
        if (!r.data) return r;
        var doc = r.data, upErr = r.error;
        return reviewExtraction(id, { transaction_id: o.transactionId, document_id: doc.id }).then(function (u) {
          if (u.error) return u;
          return { data: { extraction: u.data, document: doc }, error: upErr || null };
        });
      });
  }

  /* ------------------------------------------------------------------
     Contact messages (staff inbox)
     ------------------------------------------------------------------ */
  function listContactMessages(o) {
    o = o || {};
    return online(function (c) {
      var q = c.from('contact_messages').select('*', { count: 'exact' }).order('created_at', { ascending: false });
      if (o.status) q = q.eq('status', o.status);
      return range(q, o);
    });
  }
  function setContactStatus(id, status) {
    return online(function (c) { return c.from('contact_messages').update({ status: status }).eq('id', id).select().single(); });
  }
  function listAudit(o) {
    o = o || {};
    return online(function (c) {
      var q = c.from('audit_log').select('*').order('at', { ascending: false });
      if (o.table) q = q.eq('table_name', o.table);
      if (o.rowId) q = q.eq('row_id', o.rowId);
      return range(q, o);
    });
  }

  /* ------------------------------------------------------------------
     Page chrome: mark the mode and relabel the demo banner when online
     ------------------------------------------------------------------ */
  function applyModeToPage() {
    // main.js owns the chrome text; tell it the effective mode (a bad/secret key => demo)
    if (window.Marsa && typeof window.Marsa.setMode === 'function') { window.Marsa.setMode(configured ? 'staging' : 'demo'); return; }
    document.documentElement.setAttribute('data-marsa-mode', configured ? 'online' : 'demo');
    if (!configured) return;
    var p = document.querySelector('[data-demo-banner] p');
    if (p) p.textContent = AR.banner.staging;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyModeToPage);
  else applyModeToPage();

  /* ------------------------------------------------------------------
     Public API
     ------------------------------------------------------------------ */
  var api = {
    version: '0.1.0-staging',
    environment: cfg.environment || 'staging',
    orgSlug: ORG_SLUG,
    i18n: { ar: AR },
    client: null,                         // supabase client once ready() resolved (online only)
    isOnline: function () { return configured; },
    isMisconfigured: function () { return misconfigured; },
    ready: function () { return ready().then(function (c) { return ok(c); }, function (e) { return { data: null, error: normalizeError(e) }; }); },
    errorMessage: function (err) { return normalizeError(err).message; },
    // auth
    signIn: signIn, signUp: signUp, signOut: signOut, resetPassword: resetPassword, updatePassword: updatePassword,
    onAuth: onAuth, currentUser: currentUser, getSession: getSession,
    myContext: myContext, myMemberships: myMemberships, myRole: myRole, hasRole: hasRole, isStaff: isStaff, orgId: orgId,
    // public
    submitServiceRequest: submitServiceRequest, submitContactMessage: submitContactMessage, publicTrack: publicTrack,
    statusLabels: statusLabels,
    // org admin
    getOrg: getOrg, listBranches: listBranches, listMemberships: listMemberships, addMembership: addMembership,
    setMembershipActive: setMembershipActive,
    // requests
    listRequests: listRequests, getRequest: getRequest, updateRequest: updateRequest,
    setRequestStatus: setRequestStatus, convertRequest: convertRequest,
    // clients
    listClients: listClients, getClient: getClient, createClient: createClient, updateClient: updateClient,
    linkClientUser: linkClientUser,
    // transactions
    listTransactions: listTransactions, getTransaction: getTransaction, createTransaction: createTransaction,
    updateTransaction: updateTransaction, setTransactionStatus: setTransactionStatus, setFinancialStatus: setFinancialStatus,
    issueTrackingToken: issueTrackingToken, listEvents: listEvents, addNote: addNote,
    listContainers: listContainers, addContainer: addContainer, updateContainer: updateContainer,
    // documents
    listDocuments: listDocuments, uploadDocument: uploadDocument, documentUrl: documentUrl,
    classifyDocument: classifyDocument, setDocumentVisibility: setDocumentVisibility, voidDocument: voidDocument,
    // bulk import
    createImportBatch: createImportBatch, addImportRows: addImportRows, listImportRows: listImportRows,
    updateImportRow: updateImportRow, findBatchByFingerprint: findBatchByFingerprint,
    cancelImportBatch: cancelImportBatch, importCommit: importCommit,
    // document extractions (OCR)
    saveExtraction: saveExtraction, listExtractions: listExtractions, getExtraction: getExtraction,
    reviewExtraction: reviewExtraction, voidExtraction: voidExtraction, attachExtractionDocument: attachExtractionDocument,
    localExtractions: localExtractions,
    // inbox / audit
    listContactMessages: listContactMessages, setContactStatus: setContactStatus, listAudit: listAudit,
    // utils
    util: { sha256Hex: sha256Hex, uuid: uuid, safeFileName: safeFileName, toRequestPayload: toRequestPayload, toContactPayload: toContactPayload }
  };
  window.MarsaApi = api;
})();
