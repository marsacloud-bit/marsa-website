/* ==========================================================================
   مرسى | MARSA — online data layer (Supabase, STAGING)  →  window.MarsaApi
   --------------------------------------------------------------------------
   Load order:  config.js → i18n.js → main.js → supa.js → [assets/i18n/<page>.js] → <page>.js
                (plain <script defer>)

   * Online  when window.MARSA_CONFIG has supabaseUrl + supabaseAnonKey:
     supabase-js v2 (UMD, pinned 2.45.4) is injected from jsDelivr on demand.
   * Demo    otherwise: nothing is loaded from the network; the public calls
     fall back to the existing localStorage behaviour (marsa_requests,
     marsa_messages) and every staff/portal call returns MRS_DEMO_MODE
     (except the OCR extractions, which fall back to marsa_extractions).

   EVERY method returns a Promise of { data, error } and never throws.
   error = { code: 'MRS_…' | pg code, field, message (Arabic), raw }.
   User-facing strings live in MarsaApi.i18n.ar; when MarsaI18n carries
   'err.<CODE>' for the current language that text is preferred.
   Idempotent calls (G2.13) retry with the same key and may end with
   MRS_UNKNOWN_RESULT (see idemRpc); their result also carries idemKey.
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
      MRS_EXPIRED: 'انتهت صلاحية هذا الرابط أو الدعوة. اطلب دعوة جديدة.',
      MRS_EMAIL_MISMATCH: 'هذه الدعوة موجّهة إلى بريد إلكتروني آخر. سجّل الدخول بالبريد المدعو نفسه.',
      MRS_EMAIL_UNCONFIRMED: 'يلزم تأكيد بريدك الإلكتروني أولًا من الرسالة المرسلة إليك، ثم أعد المحاولة.',
      MRS_IDEMPOTENCY_CONFLICT: 'تعذّر تكرار العملية بالمفتاح نفسه لأن البيانات تغيّرت أو انتهت مهلته. حدّث الصفحة وتحقّق مما حُفظ قبل المحاولة من جديد.',
      MRS_IN_PROGRESS: 'العملية نفسها ما زالت قيد التنفيذ. انتظر قليلًا ثم تحقّق من النتيجة.',
      MRS_UNKNOWN_RESULT: 'لم نتمكن من تأكيد نتيجة العملية بسبب انقطاع الاتصال. إعادة المحاولة آمنة ولن تُنشئ نسخة مكرّرة.',
      MRS_TIMEOUT: 'استغرق الخادم وقتًا أطول من المعتاد. حاول مرة أخرى.',
      MRS_DOCS_MISSING: 'لا يمكن الانتقال إلى هذه المرحلة قبل استكمال المستندات المطلوبة لها ({f}). ارفعها وصنّفها، أو تجاوز القاعدة بصلاحية مدير مع ذكر السبب.',
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
      void_reason: 'سبب الإلغاء',
      slug: 'المعرّف المختصر', name_ar: 'الاسم بالعربية', name_en: 'الاسم بالإنجليزية', ref_prefix: 'بادئة الأرقام المرجعية',
      default_locale: 'اللغة الافتراضية', admin_email: 'بريد مدير المؤسسة', code: 'رمز الفرع', city: 'المدينة',
      is_active: 'التفعيل', public_intake_enabled: 'استقبال الطلبات العامة', brand_color: 'لون الهوية',
      contact_phone: 'هاتف التواصل', contact_email: 'بريد التواصل', address_ar: 'العنوان بالعربية',
      address_en: 'العنوان بالإنجليزية', logo_path: 'الشعار', settings: 'الإعدادات', organization: 'المؤسسة',
      branch_id: 'الفرع', client_id: 'العميل', invitation: 'الدعوة', token: 'رمز الدعوة', last_branch: 'آخر فرع مفعّل',
      slug_taken: 'المعرّف المختصر (مستخدم لمؤسسة أخرى)', membership: 'العضوية', filters: 'عوامل التصفية', locale: 'اللغة', idempotencyKey: 'مفتاح العملية',
      // G3 detail codes / fields
      declaration_no: 'رقم البيان الجمركي', declaration_type: 'نوع البيان', declaration_date: 'تاريخ البيان',
      declaration_no_taken: 'رقم البيان (مسجّل لمعاملة أخرى في المؤسسة)', declaration_no_cancelled: 'رقم البيان (ملغى؛ يُستخدم فقط كبديل صريح)',
      bl_number: 'رقم البوليصة', bl_number_taken: 'رقم البوليصة (مسجّل من قبل بالنوع نفسه)', bl_type: 'نوع البوليصة', bl: 'البوليصة',
      alias: 'الاسم البديل', alias_taken: 'الاسم البديل (مستخدم لعميل آخر)', carrier_id: 'الناقل', shipping_agent_id: 'الوكيل الملاحي',
      terminal_party_id: 'المحطة', return_yard_party_id: 'ساحة الإرجاع', return_instruction_document_id: 'تعليمات الإرجاع', driver_id: 'السائق',
      truck_id: 'الشاحنة', container_id: 'الحاوية', container_no: 'رقم الحاوية', appointment_at: 'وقت الموعد', window_minutes: 'مدة نافذة الموعد',
      appointment_no: 'رقم الموعد', occurred_at: 'تاريخ الحدوث', at: 'وقت الحالة', leg_no: 'رقم المرحلة',
      cost: 'التكلفة وسعر البيع (لصلاحيات المالية والإدارة فقط)', cost_basis: 'أساس التكلفة', waiver: 'الإعفاء (لصلاحية مدير)',
      document_or_amount: 'مستند أو مبلغ (مطلوب لهذا النوع)', kind: 'النوع', source: 'المصدر', source_document_id: 'المستند المصدر',
      replacement: 'البيان البديل', replaces_id: 'البيان المستبدَل', use_cancel_declaration: 'الإلغاء (استخدم «إلغاء البيان»)',
      use_reschedule_appointment: 'تغيير الموعد (استخدم «إعادة الجدولة»)', no_change: 'لا يوجد تغيير', backward: 'الرجوع إلى حالة سابقة',
      cancelled: 'سجل ملغى', resolved: 'استثناء مغلق', link: 'ربط البوليصة', reason: 'السبب', severity: 'الأهمية', packages: 'عدد الطرود',
      plate_no: 'رقم اللوحة', national_id_last4: 'آخر 4 أرقام من الهوية', ids: 'المعرّفات', transaction: 'المعاملة', org_id: 'المؤسسة',
      stage_skip: 'تخطي مرحلة', unknown_key: 'حقل غير معروف', operational_state: 'الحالة التشغيلية للحاوية', gross_weight_kg: 'الوزن الإجمالي'
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
  // MarsaI18n (i18n.js) may carry 'err.<CODE>' / 'field.<f>' for the current language;
  // t() returns the key itself when a string is missing.
  function i18nStr(key) {
    var I = window.MarsaI18n;
    if (!I || typeof I.t !== 'function') return null;
    try { var s = I.t(key); return (s && s !== key) ? String(s) : null; } catch (e) { return null; }
  }
  function fieldLabel(f) {
    if (!f) return '';
    return i18nStr('field.' + f) || AR.fields[f] || f;
  }
  function fmt(tpl, f) {
    var label = fieldLabel(f);
    return String(tpl).replace(/\{f\}|\{field\}/g, label);
  }
  function mkErr(code, field, raw) {
    var tpl = i18nStr('err.' + code) || AR.errors[code] || i18nStr('err.UNKNOWN') || AR.errors.UNKNOWN;
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
     Idempotent RPCs (G2.13)
     The server stores (scope, key) → response. On a network error / timeout
     / gateway 5xx the SAME key is re-sent up to 2× (the server replays the
     stored response instead of doing the work twice). Still no definite
     answer → MRS_UNKNOWN_RESULT: the page keeps the key and a later retry is
     safe. Keys of calls that ended without a definite answer are remembered
     in memory per (scope + payload) for 2 minutes, so that resubmitting the
     very same data right away reuses them even when the caller did not pass
     one; any definite answer on the same record ends them, and a replay of a
     remembered key is flagged replayedEarlier (already applied earlier).
     ------------------------------------------------------------------ */
  var IDEM_RETRIES = 2;
  var IDEM_TIMEOUT_MS = 25000;
  var IDEM_BACKOFF_MS = [700, 1800];
  // 'scope|fingerprint' → {key, at, row} — only while a result is unknown, and only for a
  // short retry window: a later deliberate identical action must get a fresh key, or the
  // server would replay the old result and nothing would happen.
  var pendingKeys = {};
  var PENDING_TTL_MS = 2 * 60 * 1000;
  // a replay can never return a secret again → after an unknown result, a new click issues a new one
  var NO_KEY_REUSE = { issue_tracking_token: true };
  function newIdemKey() { return uuid(); }
  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '')); }
  function fingerprint(scope, args) {
    var copy = {};
    Object.keys(args || {}).sort().forEach(function (k) {
      var v = args[k];
      if (k === 'p_idem_key') return;
      if (v && typeof v === 'object' && !Array.isArray(v) && v.idempotencyKey !== undefined) {
        v = Object.assign({}, v); delete v.idempotencyKey;
      }
      copy[k] = v;
    });
    try { return scope + '|' + JSON.stringify(copy); } catch (e) { return null; }
  }
  // result unknown (the server may have committed): network / timeout, or any 5xx without a
  // PostgREST / Postgres error code (gateway 502-504, Cloudflare 520-523, a bare 500)
  function isTransient(err, status) {
    if (!err) return false;
    if (err.code === 'MRS_NETWORK' || err.code === 'MRS_TIMEOUT' || err.code === 'MRS_IN_PROGRESS') return true;
    var pg = err.raw && err.raw.code;
    return !pg && (status === 0 || status >= 500);
  }
  // the record an idempotent call acts on (a definite answer for it ends every pending key on it)
  function rowOf(name, args) {
    var id = args && (args.p_transaction_id || args.p_request_id);
    return id ? name + '#' + id : null;
  }
  function takePending(fp) {
    var e = fp && pendingKeys[fp];
    if (!e) return null;
    if (Date.now() - e.at > PENDING_TTL_MS) { delete pendingKeys[fp]; return null; }
    return e.key;
  }
  function clearPending(fp, row) {
    if (fp) delete pendingKeys[fp];
    if (!row) return;
    Object.keys(pendingKeys).forEach(function (k) { if (pendingKeys[k].row === row) delete pendingKeys[k]; });
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // one attempt with a timeout (AbortController when supported)
  function rpcAttempt(c, name, args) {
    var ac = typeof AbortController === 'function' ? new AbortController() : null;
    var timedOut = false, timer;
    var q = c.rpc(name, args);
    if (ac && q && typeof q.abortSignal === 'function') q = q.abortSignal(ac.signal);
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () { timedOut = true; if (ac) ac.abort(); resolve({ error: { message: 'MRS_TIMEOUT' }, status: 0 }); }, IDEM_TIMEOUT_MS);
    });
    return Promise.race([Promise.resolve(q), timeout]).then(function (res) {
      clearTimeout(timer);
      if (timedOut) return { data: null, error: mkErr('MRS_TIMEOUT'), status: 0 };
      if (res && res.error) return { data: null, error: normalizeError(res.error), status: res.status };
      return { data: res ? (res.data === undefined ? null : res.data) : null, error: null, status: res && res.status };
    }, function (e) {
      clearTimeout(timer);
      return { data: null, error: timedOut ? mkErr('MRS_TIMEOUT') : normalizeError(e), status: 0 };
    });
  }
  // build(key) → RPC args carrying that key (in payload.idempotencyKey or p_idem_key)
  // A result with replayedEarlier:true means the key was remembered from an earlier unknown
  // result and the server replayed it: the action was ALREADY applied then (not just now).
  function idemRpc(name, key, build, demoFn) {
    if (!configured) return demoFn ? Promise.resolve().then(demoFn) : demoOnly();
    var base = build(null);
    var fp = fingerprint(name, base), row = rowOf(name, base);
    var implicit = false;
    if (!isUuid(key)) {
      var kept = NO_KEY_REUSE[name] ? null : takePending(fp);
      implicit = !!kept;
      key = kept || newIdemKey();
    }
    var args = build(key);
    return ready().then(function (c) {
      function attempt(n) {
        return rpcAttempt(c, name, args).then(function (r) {
          if (!r.error || !isTransient(r.error, r.status)) {
            clearPending(fp, row);   // definite answer (success or a real error)
            var out = { data: r.data, error: r.error, idemKey: key };
            if (implicit && r.data && r.data.replayed) out.replayedEarlier = true;
            return out;
          }
          if (n < IDEM_RETRIES) return delay(IDEM_BACKOFF_MS[n] || 2000).then(function () { return attempt(n + 1); });
          if (fp) pendingKeys[fp] = { key: key, at: Date.now(), row: row };
          return { data: null, error: mkErr('MRS_UNKNOWN_RESULT', null, r.error), idemKey: key };
        });
      }
      return attempt(0);
    }, function (e) {
      // supabase-js did not load: nothing was sent, so this is a plain network error
      return { data: null, error: normalizeError(e), idemKey: key };
    });
  }
  function withKey(payload, key) {
    var p = Object.assign({}, payload || {});
    if (key) p.idempotencyKey = key; else delete p.idempotencyKey;
    return p;
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
  // per-user state of this browser: never handed to the next person who signs in here
  function clearUserState() {
    ctxCache = null; applyPlatformChrome(false);
    try { localStorage.removeItem('marsa_active_org'); } catch (e) { /* storage blocked */ }
    try { sessionStorage.removeItem('marsa_invite'); sessionStorage.removeItem('marsa_invite_signup'); } catch (e) { /* storage blocked */ }
  }
  function signOut() { return online(function (c) { clearUserState(); return c.auth.signOut(); }); }
  // revokes every refresh token of this user (all browsers / devices), then clears this one.
  // Access tokens already issued elsewhere stay valid until they expire (≤ JWT expiry, 1 h default).
  function signOutEverywhere() {
    return online(function (c) { clearUserState(); return c.auth.signOut({ scope: 'global' }); });
  }
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
  var ctxPending = null;
  function myContext(force) {
    if (!configured) return demoOnly();
    if (ctxCache && !force) return Promise.resolve(ok(ctxCache));
    if (ctxPending && !force) return ctxPending;   // share one in-flight call between callers
    var p = rpc('my_context').then(function (r) {
      if (ctxPending === p) ctxPending = null;
      if (!r.error) { ctxCache = r.data; applyPlatformChrome(!!(r.data && r.data.is_platform_admin)); }
      return r;
    });
    ctxPending = p;
    return p;
  }
  function myMemberships() {
    return myContext().then(function (r) { return r.error ? r : ok(r.data.memberships || []); });
  }
  // [data-platform-only] (nav link to platform.html) — cosmetic only; the RPCs enforce access
  function applyPlatformChrome(show) {
    try {
      Array.prototype.forEach.call(document.querySelectorAll('[data-platform-only]'), function (el) { el.hidden = !show; });
    } catch (e) { /* no DOM yet */ }
  }
  var ROLE_RANK = ['client', 'clearance_staff', 'transport_staff', 'accountant', 'accounts_manager', 'branch_manager', 'operations_manager', 'supervisor', 'admin'];

  /* ---- active organization (users with memberships in more than one org) ----
     localStorage marsa_active_org holds a UUID; it is only honoured while
     my_context() still lists an active membership in that org. Default:
     the configured orgSlug, then the first org with a staff role, then the
     first org at all. */
  var ACTIVE_ORG_KEY = 'marsa_active_org';
  function readActiveOrg() { try { return localStorage.getItem(ACTIVE_ORG_KEY) || null; } catch (e) { return null; } }
  function writeActiveOrg(id) {
    try { if (id) localStorage.setItem(ACTIVE_ORG_KEY, id); else localStorage.removeItem(ACTIVE_ORG_KEY); } catch (e) { /* storage blocked */ }
  }
  function ctxOrgIds(ctx) {
    var ids = [];
    ((ctx && ctx.memberships) || []).forEach(function (m) { if (m.org_id && ids.indexOf(m.org_id) === -1) ids.push(m.org_id); });
    ((ctx && ctx.organizations) || []).forEach(function (o) { if (o.org_id && ids.indexOf(o.org_id) === -1) ids.push(o.org_id); });
    return ids;
  }
  function pickActiveOrg(ctx) {
    var ids = ctxOrgIds(ctx), mships = (ctx && ctx.memberships) || [];
    var stored = readActiveOrg();
    if (stored && ids.indexOf(stored) !== -1) return stored;
    var bySlug = mships.filter(function (m) { return m.org_slug === ORG_SLUG; })[0];
    if (bySlug) return bySlug.org_id;
    var staff = mships.filter(function (m) { return m.role && m.role !== 'client'; })[0];
    if (staff) return staff.org_id;
    var clientOrg = ((ctx && ctx.clients) || [])[0];
    return ids[0] || (clientOrg && clientOrg.org_id) || null;
  }
  function activeOrgId() {
    if (!configured) return demoOnly();
    return myContext().then(function (r) { return r.error ? r : ok(pickActiveOrg(r.data)); });
  }
  function setActiveOrg(id) {
    if (!configured) return demoOnly();
    return myContext().then(function (r) {
      if (r.error) return r;
      if (!id || ctxOrgIds(r.data).indexOf(id) === -1) return fail('MRS_FORBIDDEN', 'organization');
      var changed = readActiveOrg() !== id;
      writeActiveOrg(id);
      if (changed) {
        try { window.dispatchEvent(new CustomEvent('marsa:orgchange', { detail: { orgId: id } })); } catch (e) { /* old browser */ }
      }
      return ok(id);
    });
  }
  // memberships of the requested org: by slug when given, otherwise the active org
  function orgMemberships(orgSlug) {
    return myContext().then(function (r) {
      if (r.error) return r;
      var all = r.data.memberships || [];
      if (orgSlug) return ok(all.filter(function (m) { return m.org_slug === orgSlug; }));
      var oid = pickActiveOrg(r.data);
      return ok(all.filter(function (m) { return m.org_id === oid; }));
    });
  }
  // highest role in the active org (or orgSlug), null when none
  function myRole(orgSlug) {
    return orgMemberships(orgSlug).then(function (r) {
      if (r.error) return r;
      var roles = r.data.map(function (m) { return m.role; });
      roles.sort(function (a, b) { return ROLE_RANK.indexOf(b) - ROLE_RANK.indexOf(a); });
      return ok(roles[0] || null);
    });
  }
  function hasRole(roles, orgSlug) {
    var want = [].concat(roles);
    return orgMemberships(orgSlug).then(function (r) {
      if (r.error) return r;
      return ok(r.data.some(function (m) { return want.indexOf(m.role) !== -1; }));
    });
  }
  function isStaff(orgSlug) { return hasRole(ROLE_RANK.slice(1), orgSlug); }
  function isPlatformAdmin() {
    if (!configured) return Promise.resolve(ok(false));
    return myContext().then(function (r) { return r.error ? r : ok(!!(r.data && r.data.is_platform_admin)); });
  }
  function orgId(orgSlug) {
    if (!orgSlug) {
      return activeOrgId().then(function (r) { return r.error ? r : (r.data ? r : fail('MRS_FORBIDDEN', 'organization')); });
    }
    return myMemberships().then(function (r) {
      if (r.error) return r;
      var m = r.data.filter(function (x) { return x.org_slug === orgSlug; })[0];
      return m ? ok(m.org_id) : fail('MRS_FORBIDDEN', 'organization');
    });
  }
  function setMyLocale(l) {
    var locale = l === 'en' ? 'en' : 'ar';
    if (!configured) return Promise.resolve(ok(null));
    return currentUser().then(function (u) {
      if (u.error || !u.data) return ok(null);   // signed out: nothing to store server-side
      return online(function (c) { return c.from('profiles').update({ locale: locale }).eq('id', u.data.id).select('id,locale').maybeSingle(); })
        .then(function (r) {
          if (!r.error && ctxCache && ctxCache.profile) ctxCache.profile.locale = locale;
          return r;
        });
    });
  }

  /* ------------------------------------------------------------------
     Public RPCs (anon allowed)
     ------------------------------------------------------------------ */
  // idempotent: record.idempotencyKey (or opts.idemKey) is used when given, otherwise one is
  // generated and kept for the automatic retries (and for a resubmit of the same data after
  // MRS_UNKNOWN_RESULT). The result carries it as r.idemKey.
  function submitServiceRequest(record, opts) {
    var key = (opts && opts.idemKey) || (record && record.idempotencyKey);
    var base = toRequestPayload(record);
    return idemRpc('submit_service_request', key, function (k) { return { payload: withKey(base, k) }; },
      function () { return demoSubmitRequest(record); });
  }
  function submitContactMessage(entry, opts) {
    var key = (opts && opts.idemKey) || (entry && entry.idempotencyKey);
    var base = toContactPayload(entry);
    return idemRpc('submit_contact_message', key, function (k) { return { payload: withKey(base, k) }; },
      function () { return demoSubmitContact(entry); });
  }
  function healthCheck() { return rpc('health_check'); }
  // client error log (anon + authenticated); the server truncates, scrubs and rate-limits
  function logClientError(p) {
    if (!configured) return Promise.resolve(ok({ logged: false }));
    p = p || {};
    return rpc('log_client_error', { p_payload: {
      page: String(p.page || location.pathname || '').slice(0, 200),
      code: p.code ? String(p.code).slice(0, 60) : null,
      message: String(p.message || '').slice(0, 500),
      ua: String(p.ua || (navigator && navigator.userAgent) || '').slice(0, 200),
      orgId: p.orgId || null              // 0300 reads payload.orgId (used only when the caller is a member)
    } });
  }
  /* ---- invitations: public side (login.html?invite=…) ---- */
  function invitationPreview(token) {
    var t = String(token || '').trim();
    if (!/^[0-9a-f]{64}$/i.test(t)) return configured ? Promise.resolve(fail('MRS_NOT_FOUND')) : demoOnly();
    return rpc('invitation_preview', { p_token: t });
  }
  function acceptInvitation(token) {
    var t = String(token || '').trim();
    if (!/^[0-9a-f]{64}$/i.test(t)) return configured ? Promise.resolve(fail('MRS_NOT_FOUND')) : demoOnly();
    return rpc('accept_invitation', { p_token: t }).then(function (r) {
      ctxCache = null; ctxPending = null;   // new membership / client link
      return r;
    });
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
  function listBranches(oid) {
    return online(function (c) {
      var q = c.from('branches').select('id,org_id,code,name_ar,name_en,city,is_active').order('code');
      return oid ? q.eq('org_id', oid) : q;
    });
  }
  function listMemberships(oid) {
    return online(function (c) {
      var q = c.from('memberships').select('id,user_id,org_id,branch_id,role,is_active,created_at,profiles(full_name,phone)').order('created_at');
      return oid ? q.eq('org_id', oid) : q;
    });
  }
  // memberships are written ONLY through the admin RPCs (0650): they refuse self-changes and
  // removing the last active admin. Direct table writes are revoked server-side.
  // admin_add_member is SQL-Editor only since G2 (0200 revokes EXECUTE from authenticated:
  // account-existence oracle). Kept for API compatibility; staff are added with invite().
  function addMembership(m) {
    m = m || {};
    if (!m.email) return Promise.resolve(fail('MRS_REQUIRED', 'email'));
    return Promise.resolve(fail('MRS_FORBIDDEN', 'invite'));
  }
  function setMembershipActive(id, active) {
    return rpc('admin_set_member_active', { p_membership: id, p_active: !!active });
  }
  function listMembers(oid) { return rpc('admin_list_members', { p_org: oid }); }
  function updateOrg(oid, payload) { return rpc('admin_update_org', { p_org: oid, p_payload: payload || {} }); }
  function createBranch(oid, payload) { return rpc('admin_create_branch', { p_org: oid, p_payload: payload || {} }); }
  function updateBranch(id, payload) { return rpc('admin_update_branch', { p_branch: id, p_payload: payload || {} }); }
  // payload = { email, role, branch_id?, client_id?, idempotencyKey? } → { invitation_id, email, role,
  // expires_at, token, accept_path } — token is shown ONCE (on a replay: token null + token_shown true)
  function invite(oid, payload) {
    var key = payload && payload.idempotencyKey;
    return idemRpc('admin_invite', key, function (k) { return { p_org: oid, p_payload: withKey(payload, k) }; });
  }
  function listInvitations(oid) { return rpc('admin_list_invitations', { p_org: oid }); }
  function revokeInvitation(id) { return rpc('admin_revoke_invitation', { p_invitation: id }); }
  function reissueInvitation(id) { return rpc('admin_reissue_invitation', { p_invitation: id }); }
  // filters = { table_name, actor, from, to, row_id, limit (≤200), before_id }
  function auditLog(oid, filters) { return rpc('admin_audit_log', { p_org: oid, p_filters: filters || {} }); }
  // org admin: errors of one org; without an org id: platform admin view of all orgs
  function recentErrors(oid) { return oid ? rpc('admin_recent_errors', { p_org: oid }) : rpc('platform_recent_errors'); }

  /* ------------------------------------------------------------------
     Platform admin (platform_admins; organizations only, no tenant data)
     ------------------------------------------------------------------ */
  function platformListOrgs() { return rpc('platform_list_orgs'); }
  // payload = { slug, name_ar, name_en?, ref_prefix, default_locale?, branch:{code, name_ar, name_en?, city?},
  //             admin_email, idempotencyKey? } → { org_id, slug, branch_id, invitation_id, token, accept_path }
  function platformCreateOrg(payload) {
    var key = payload && payload.idempotencyKey;
    return idemRpc('platform_create_org', key, function (k) { return { p_payload: withKey(payload, k) }; });
  }
  function platformSetOrgActive(id, active) { return rpc('platform_set_org_active', { p_org: id, p_active: !!active }); }
  // org without an active admin: new one-time link for its pending first-admin invitation
  // → { org_id, invitation_id, email, expires_at, token, accept_path } (shown once, never stored)
  function platformReissueAdminInvitation(orgId) { return rpc('platform_reissue_admin_invitation', { p_org: orgId }); }
  function platformRecentErrors() { return rpc('platform_recent_errors'); }

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
      if (o.orgId) q = q.eq('org_id', o.orgId);   // multi-org users: RLS returns every org they belong to
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
  // o = { branchId, clientId, idemKey } — idempotent (p_idem_key)
  function convertRequest(id, o) {
    o = o || {};
    return idemRpc('convert_request_to_transaction', o.idemKey, function (k) {
      return { p_request_id: id, p_branch_id: o.branchId || null, p_client_id: o.clientId || null, p_idem_key: k };
    });
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
      if (o.orgId) q = q.eq('org_id', o.orgId);
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
      if (o.orgId) q = q.eq('org_id', o.orgId);
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
  // idemKey (optional 4th arg) → p_idem_key; generated when absent and kept for the retries.
  // opts.docsOverride (G3.10) → p_docs_override: the explicit manager override of the document gate
  // (sent only by the override dialog, with the reason in note). Never inferred from a note.
  function setTransactionStatus(id, status, note, idemKey, opts) {
    var ov = !!(opts && opts.docsOverride);
    return idemRpc('set_transaction_status', idemKey, function (k) {
      var a = { p_transaction_id: id, p_status: status, p_note: note || null, p_idem_key: k };
      if (ov) a.p_docs_override = true;
      return a;
    });
  }
  function setFinancialStatus(id, status, note, idemKey) {
    return idemRpc('set_financial_status', idemKey, function (k) {
      return { p_transaction_id: id, p_status: status, p_note: note || null, p_idem_key: k };
    });
  }
  // the token is shown once; on a replay the server returns tracking_token null + token_shown true
  function issueTrackingToken(id, idemKey) {
    return idemRpc('issue_tracking_token', idemKey, function (k) { return { p_transaction_id: id, p_idem_key: k }; });
  }
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
      if (o.orgId) q = q.eq('org_id', o.orgId);
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
      if (o.orgId) q = q.eq('org_id', o.orgId);
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
      if (o.orgId) q = q.eq('org_id', o.orgId);
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
      if (o.orgId) q = q.eq('org_id', o.orgId);
      if (o.table) q = q.eq('table_name', o.table);
      if (o.rowId) q = q.eq('row_id', o.rowId);
      return range(q, o);
    });
  }

  /* ------------------------------------------------------------------
     G3 — clearance & transport operations (docs/online/G3_SPEC.md)
     Directories (parties / drivers / trucks / client aliases / document
     requirements) are RLS-guarded direct reads and writes. Everything with a
     state machine goes through its RPC; the creating RPCs are idempotent
     (p_idem_key, same key across retries — pass opts.idemKey to keep one
     across a page-level retry). Lists are scoped to the active org (or
     f.orgId). Internal notes / trip money are never selected directly:
     staff_internal_fields() and trip_finance() add them for the roles that
     may read them.
     ------------------------------------------------------------------ */
  // active org (or the explicit one) → fn(orgId)
  function inActiveOrg(explicit, fn) {
    if (!configured) return demoOnly();
    var pick = explicit ? Promise.resolve(ok(explicit)) : orgId();
    return pick.then(function (r) { return r.error ? r : fn(r.data); });
  }
  // org of a parent row (child inserts carry the parent's org_id)
  function orgOfRow(table, id) {
    if (!configured) return demoOnly();
    return online(function (c) { return c.from(table).select('org_id').eq('id', id).maybeSingle(); })
      .then(function (r) { return r.error ? r : (r.data ? ok(r.data.org_id) : fail('MRS_NOT_FOUND')); });
  }
  // insert (no id) or update (id) of a directory row; id / org_id / audit columns are never patched
  function saveRow(table, cols, p, orgFn) {
    if (!configured) return demoOnly();
    p = Object.assign({}, p || {});
    var id = p.id;
    ['id', 'org_id', 'created_by', 'created_at', 'updated_at'].forEach(function (k) { delete p[k]; });
    if (id) return online(function (c) { return c.from(table).update(p).eq('id', id).select(cols).single(); });
    return orgFn().then(function (r) {
      if (r.error) return r;
      return online(function (c) { return c.from(table).insert(Object.assign(p, { org_id: r.data })).select(cols).single(); });
    });
  }
  function rowsOrList(r) {   // RPCs may return a bare array or {rows|items|visits}
    if (!r || r.error || !r.data || Array.isArray(r.data)) return r;
    var d = r.data.rows || r.data.items || r.data.visits;
    return Array.isArray(d) ? { data: d, error: null, count: r.data.total != null ? r.data.total : d.length } : r;
  }
  function dayStart(v) { if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d.toISOString(); }

  /* parties (+ drivers / trucks) */
  var PARTY_COLS = 'id,org_id,kinds,name_ar,name_en,cr_number,vat_number,phone,email,notes,is_active,created_at,updated_at';
  var DRIVER_COLS = 'id,org_id,carrier_id,full_name,phone,national_id_last4,license_no,is_active,created_at,updated_at';
  var TRUCK_COLS = 'id,org_id,carrier_id,plate_no,plate_type,is_active,created_at,updated_at';
  // f = { kind, search, active (default true; false = include inactive), orgId, limit, offset }
  function listParties(f) {
    f = f || {};
    return inActiveOrg(f.orgId, function (oid) {
      return online(function (c) {
        var q = c.from('parties').select(PARTY_COLS, { count: 'exact' }).eq('org_id', oid).order('name_ar');
        if (f.kind) q = q.contains('kinds', [f.kind]);
        if (f.active !== false) q = q.eq('is_active', true);
        if (f.search) { var s = likeSafe(f.search); if (s) q = q.or('name_ar.ilike.%' + s + '%,name_en.ilike.%' + s + '%,cr_number.ilike.%' + s + '%,vat_number.ilike.%' + s + '%'); }
        return range(q, f);
      });
    });
  }
  function saveParty(p) { return saveRow('parties', PARTY_COLS, p, function () { return orgId(); }); }
  function listChildren(table, cols, order, carrierId) {
    return inActiveOrg(null, function (oid) {
      return online(function (c) {
        var q = c.from(table).select(cols).eq('org_id', oid).order(order);
        if (carrierId) q = q.eq('carrier_id', carrierId);
        return q.limit(500);
      });
    });
  }
  function listDrivers(carrierId) { return listChildren('drivers', DRIVER_COLS, 'full_name', carrierId); }
  function listTrucks(carrierId) { return listChildren('trucks', TRUCK_COLS, 'plate_no', carrierId); }
  function saveDriver(p) {
    p = p || {};
    if (!p.id && !p.carrier_id) return Promise.resolve(fail('MRS_REQUIRED', 'carrier_id'));
    return saveRow('drivers', DRIVER_COLS, p, function () { return orgOfRow('parties', p.carrier_id); });
  }
  function saveTruck(p) {
    p = p || {};
    if (!p.id && !p.carrier_id) return Promise.resolve(fail('MRS_REQUIRED', 'carrier_id'));
    if (p.plate_no) p = Object.assign({}, p, { plate_no: String(p.plate_no).trim().toUpperCase() });
    return saveRow('trucks', TRUCK_COLS, p, function () { return orgOfRow('parties', p.carrier_id); });
  }

  /* client identity (G3.2) — alias_norm is computed by the server */
  var ALIAS_COLS = 'id,org_id,client_id,alias,alias_norm,source,created_by,created_at';
  function listClientAliases(clientId) {
    return online(function (c) { return c.from('client_aliases').select(ALIAS_COLS).eq('client_id', clientId).order('created_at'); });
  }
  function addClientAlias(clientId, alias, source) {
    var a = String(alias || '').replace(/\s+/g, ' ').trim();
    if (!a) return Promise.resolve(fail('MRS_REQUIRED', 'alias'));
    return orgOfRow('clients', clientId).then(function (r) {
      if (r.error) return r;
      return online(function (c) {
        return c.from('client_aliases').insert({ org_id: r.data, client_id: clientId, alias: a.slice(0, 200), source: source || 'manual' }).select(ALIAS_COLS).single();
      });
    });
  }
  function removeClientAlias(id) {
    return online(function (c) { return c.from('client_aliases').delete().eq('id', id).select('id').maybeSingle(); });
  }
  // payload = { name, vat_number, cr_number } → ranked candidates [{client_id, name_ar, strength, reasons…}]; never links
  function matchClient(payload, o) {
    o = o || {};
    return inActiveOrg(o.orgId, function (oid) { return rpc('match_client', { p_org: oid, p_payload: payload || {} }); });
  }

  /* customs declarations (G3.5) — any status; the newest first */
  // notes / cancel_reason are not API-selectable (column grants): staff get them through staff_internal_fields()
  var DECL_COLS = 'id,org_id,transaction_id,declaration_no,declaration_type,declaration_date,status,source,source_document_id,' +
    'corrected_at,cancelled_at,replaced_by_id,created_by,created_at,updated_at';
  var DECL_CLIENT_COLS = 'id,transaction_id,declaration_no,declaration_type,declaration_date,status,replaced_by_id,created_at';
  // o = { minimal } (portal: number / type / date / status only)
  function listDeclarations(txId, o) {
    o = o || {};
    return online(function (c) {
      return c.from('customs_declarations').select(o.minimal ? DECL_CLIENT_COLS : DECL_COLS).eq('transaction_id', txId)
        .order('created_at', { ascending: false });
    }).then(function (r) { return o.minimal ? r : withInternal('customs_declarations', r); });
  }
  // p = { declaration_no, declaration_type, declaration_date, status, source, source_document_id, notes }
  function addDeclaration(txId, p, opts) {
    opts = opts || {};
    return idemRpc('add_declaration', opts.idemKey, function (k) { return { p_tx: txId, p_payload: p || {}, p_idem_key: k }; });
  }
  function setDeclarationStatus(id, s, note) { return rpc('set_declaration_status', { p_id: id, p_status: s, p_note: note || null }); }
  // replacement (optional) = a new declaration payload linked via replaced_by_id, in the same server transaction
  function cancelDeclaration(id, reason, replacement) {
    return rpc('cancel_declaration', { p_id: id, p_reason: reason || null, p_replacement: replacement || null });
  }
  function correctDeclaration(id, p, reason) { return rpc('correct_declaration', { p_id: id, p_payload: p || {}, p_reason: reason || null }); }

  /* bills of lading (G3.6) — many-to-many with transactions */
  var BL_COLS = 'id,org_id,bl_number,bl_type,shipping_agent_id,carrier_name,vessel,voyage,port_of_loading,port_of_discharge,' +
    'origin_country,goods_description,packages,gross_weight_kg,issued_at,created_by,created_at,updated_at';
  var BL_CLIENT_COLS = 'id,bl_number,bl_type,vessel,voyage,port_of_loading,port_of_discharge';
  // listBLs(txId) → the transaction's B/Ls [{…bl, is_primary, linked_at}] (primary first);
  // listBLs({ search, orgId, limit }) → the org's B/L register (to link an existing one).
  // o = { minimal } (portal)
  function listBLs(txId, o) {
    o = o || {};
    if (txId && typeof txId === 'object') {
      var f = txId;
      return inActiveOrg(f.orgId, function (oid) {
        return online(function (c) {
          var q = c.from('bills_of_lading').select(BL_COLS, { count: 'exact' }).eq('org_id', oid).order('created_at', { ascending: false });
          if (f.search) { var pat = likeContains(f.search); if (pat) q = q.ilike('bl_number', pat); }
          return range(q, f);
        });
      }).then(function (r) { return withInternal('bills_of_lading', r); });
    }
    return online(function (c) {
      return c.from('transaction_bls').select('transaction_id,bl_id,is_primary,created_at,bills_of_lading(' + (o.minimal ? BL_CLIENT_COLS : BL_COLS) + ')')
        .eq('transaction_id', txId).order('is_primary', { ascending: false }).order('created_at');
    }).then(function (r) {
      if (r.error) return r;
      var rows = (r.data || []).filter(function (x) { return x && x.bills_of_lading; }).map(function (x) {
        return Object.assign({}, x.bills_of_lading, { is_primary: !!x.is_primary, linked_at: x.created_at, transaction_id: x.transaction_id });
      });
      return o.minimal ? ok(rows) : withInternal('bills_of_lading', ok(rows));
    });
  }
  // p = { id? (update), bl_number, bl_type, shipping_agent_id, carrier_name, vessel, voyage, …,
  //       transaction_id + primary (optional: link in the same server transaction → result.linked) }
  function saveBL(p, opts) {
    opts = opts || {};
    return idemRpc('save_bl', opts.idemKey, function (k) { return { p_payload: withKey(p, null), p_idem_key: k }; });
  }
  function linkBL(txId, blId, primary) { return rpc('link_bl', { p_tx: txId, p_bl: blId, p_primary: !!primary }); }
  function unlinkBL(txId, blId, reason) { return rpc('unlink_bl', { p_tx: txId, p_bl: blId, p_reason: reason || null }); }

  /* containers (G3.7 / G3.13) — updateContainer (above) patches operational fields */
  // every visit of a container number in the org (a number may repeat across transactions)
  function containerHistory(no, o) {
    o = o || {};
    var n = String(no || '').toUpperCase().replace(/[\s-]/g, '');
    if (!n) return Promise.resolve(fail('MRS_REQUIRED', 'container_no'));
    return inActiveOrg(o.orgId, function (oid) { return rpc('container_history', { p_org: oid, p_container_no: n }).then(rowsOrList); });
  }
  // p = { return_deadline, return_yard_party_id, return_location, return_instruction_document_id } (evidence_received_at: server-stamped)
  // (returned_verified keeps its own evidence path: updateContainer with a confirmed empty_return_receipt)
  function setContainerReturn(id, p) { return rpc('set_container_return', { p_container: id, p_payload: p || {} }); }

  /* completeness + document checklist (G3.4 / G3.10) */
  function txCompleteness(txId) { return rpc('transaction_completeness', { p_tx: txId }); }
  function txChecklist(txId) { return rpc('tx_checklist', { p_tx: txId }).then(rowsOrList); }
  var REQ_RULE_COLS = 'id,org_id,operation,mode,port,document_kind,required_for_stage,is_optional,is_active,note,created_at,updated_at';
  function listRequirements(f) {
    f = f || {};
    return inActiveOrg(f.orgId, function (oid) {
      return online(function (c) {
        return c.from('document_requirements').select(REQ_RULE_COLS).eq('org_id', oid)
          .order('operation').order('mode').order('required_for_stage').order('document_kind');
      });
    });
  }
  function saveRequirement(p) { return saveRow('document_requirements', REQ_RULE_COLS, p, function () { return orgId(); }); }

  /* port appointments (G3.11) — a reschedule is a NEW row; the old one becomes 'rescheduled' */
  var APPT_COLS = 'id,org_id,transaction_id,container_id,terminal_party_id,appointment_at,window_minutes,appointment_no,driver_id,truck_id,' +
    'status,status_reason,rescheduled_from_id,created_by,created_at,updated_at,transactions(id,ref,branch_id),containers(container_no)';
  var APPT_CLIENT_COLS = 'id,transaction_id,container_id,appointment_at,window_minutes,status';
  // f = { txId, containerId, status (code or array), terminalId, driverId, from, to (ISO / date), orgId, limit, offset, minimal }
  function listAppointments(f) {
    f = f || {};
    function build(c, oid) {
      var q = c.from('port_appointments').select(f.minimal ? APPT_CLIENT_COLS : APPT_COLS, f.minimal ? undefined : { count: 'exact' }).order('appointment_at');
      if (oid) q = q.eq('org_id', oid);
      if (f.txId) q = q.eq('transaction_id', f.txId);
      if (f.containerId) q = q.eq('container_id', f.containerId);
      if (f.status) q = Array.isArray(f.status) ? q.in('status', f.status) : q.eq('status', f.status);
      if (f.terminalId) q = q.eq('terminal_party_id', f.terminalId);
      if (f.driverId) q = q.eq('driver_id', f.driverId);
      if (f.from) q = q.gte('appointment_at', dayStart(f.from));
      if (f.to) q = q.lt('appointment_at', dayStart(f.to));
      return range(q, Object.assign({ limit: 500 }, f));
    }
    // a transaction's rows need no org filter (RLS + the transaction scope it); the portal never sends one
    if (f.txId || f.minimal) return online(function (c) { return build(c, f.orgId || null); });
    return inActiveOrg(f.orgId, function (oid) { return online(function (c) { return build(c, oid); }); });
  }
  // p = { transaction_id, container_id, terminal_party_id, appointment_at, window_minutes, appointment_no, driver_id, truck_id, status }
  function createAppointment(p, opts) {
    opts = opts || {};
    return idemRpc('create_appointment', opts.idemKey, function (k) { return { p_payload: withKey(p, null), p_idem_key: k }; });
  }
  function rescheduleAppointment(id, p, reason, opts) {
    opts = opts || {};
    return idemRpc('reschedule_appointment', opts.idemKey, function (k) { return { p_id: id, p_payload: withKey(p, null), p_reason: reason || null, p_idem_key: k }; });
  }
  function setAppointmentStatus(id, s, reason) { return rpc('set_appointment_status', { p_id: id, p_status: s, p_reason: reason || null }); }

  /* transport trips (G3.12) — cost / sell come only from tripFinance() (column grants) */
  // notes are API-selectable (staff only read trips); only cost / sell / currencies / cost_basis are outside the grant
  var TRIP_COLS = 'id,org_id,transaction_id,container_id,leg_no,carrier_id,driver_id,truck_id,origin,destination,planned_at,loaded_at,' +
    'unloaded_at,status,status_reason,notes,created_by,created_at,updated_at,transactions(id,ref,branch_id),containers(container_no)';
  // f = { txId, containerId, status, carrierId, driverId, from, to (planned_at), anyAt, orgId, limit, offset }
  // anyAt (with from + to): the window matches planned_at, else loaded_at, else unloaded_at (a leg created
  // without a planned time still shows on a board once it is loaded / delivered)
  function listTrips(f) {
    f = f || {};
    function build(c, oid) {
      var q = c.from('transport_trips').select(TRIP_COLS, { count: 'exact' }).order('planned_at', { nullsFirst: false }).order('leg_no');
      if (oid) q = q.eq('org_id', oid);
      if (f.txId) q = q.eq('transaction_id', f.txId);
      if (f.containerId) q = q.eq('container_id', f.containerId);
      if (f.status) q = Array.isArray(f.status) ? q.in('status', f.status) : q.eq('status', f.status);
      if (f.carrierId) q = q.eq('carrier_id', f.carrierId);
      if (f.driverId) q = q.eq('driver_id', f.driverId);
      if (f.anyAt && dayStart(f.from) && dayStart(f.to)) {
        var F = '"' + dayStart(f.from) + '"', T = '"' + dayStart(f.to) + '"';
        q = q.or('and(planned_at.gte.' + F + ',planned_at.lt.' + T + '),' +
          'and(planned_at.is.null,loaded_at.gte.' + F + ',loaded_at.lt.' + T + '),' +
          'and(planned_at.is.null,loaded_at.is.null,unloaded_at.gte.' + F + ',unloaded_at.lt.' + T + ')');
      } else {
        if (f.from) q = q.gte('planned_at', dayStart(f.from));
        if (f.to) q = q.lt('planned_at', dayStart(f.to));
      }
      return range(q, Object.assign({ limit: 500 }, f));
    }
    return f.txId ? online(function (c) { return build(c, f.orgId || null); })
      : inActiveOrg(f.orgId, function (oid) { return online(function (c) { return build(c, oid); }); });
  }
  // p = { transaction_id, container_id, leg_no, carrier_id, driver_id, truck_id, origin, destination, planned_at,
  //       cost_amount, cost_currency, sell_amount, sell_currency, cost_basis, notes }
  function createTrip(p, opts) {
    opts = opts || {};
    return idemRpc('create_trip', opts.idemKey, function (k) { return { p_payload: withKey(p, null), p_idem_key: k }; });
  }
  function updateTrip(id, p) { return rpc('update_trip', { p_id: id, p_payload: p || {} }); }
  function setTripStatus(id, s, at, note) { return rpc('set_trip_status', { p_id: id, p_status: s, p_at: at || null, p_note: note || null }); }
  // { <trip id>: {cost_amount, cost_currency, sell_amount?, sell_currency?, cost_basis} } — only for the roles allowed
  // (the server leaves out what the caller may not see; transport_staff / clients get nothing)
  function tripFinance(ids) {
    ids = (ids || []).filter(isUuid).slice(0, 500);
    if (!ids.length) return Promise.resolve(ok({}));
    return rpc('trip_finance', { p_ids: ids }).then(function (r) {
      if (r.error || !Array.isArray(r.data)) return r;
      var map = {};   // tolerate a row list
      r.data.forEach(function (x) { if (x && x.id) map[x.id] = x; });
      return ok(map);
    });
  }

  /* operational exceptions (G3.14) */
  var EXC_COLS = 'id,org_id,transaction_id,container_id,kind,occurred_at,source,document_id,reason,amount,currency,status,' +
    'resolved_at,resolved_by,resolution_note,created_by,created_at,updated_at,transactions(id,ref,branch_id)';
  // f = { txId, containerId, status (code or array), kind, from, to (occurred_at), orgId, limit, offset }
  function listExceptions(f) {
    f = f || {};
    function build(c, oid) {
      var q = c.from('operational_exceptions').select(EXC_COLS, { count: 'exact' }).order('occurred_at', { ascending: false });
      if (oid) q = q.eq('org_id', oid);
      if (f.txId) q = q.eq('transaction_id', f.txId);
      if (f.containerId) q = q.eq('container_id', f.containerId);
      if (f.status) q = Array.isArray(f.status) ? q.in('status', f.status) : q.eq('status', f.status);
      if (f.kind) q = q.eq('kind', f.kind);
      if (f.from) q = q.gte('occurred_at', dayStart(f.from));
      if (f.to) q = q.lt('occurred_at', dayStart(f.to));
      return range(q, Object.assign({ limit: 500 }, f));
    }
    if (f.txId) return online(function (c) { return build(c, f.orgId || null); });
    return inActiveOrg(f.orgId, function (oid) { return online(function (c) { return build(c, oid); }); });
  }
  // p = { transaction_id, container_id, kind, occurred_at, source, document_id, reason, amount, currency }
  function createException(p, opts) {
    opts = opts || {};
    return idemRpc('create_exception', opts.idemKey, function (k) { return { p_payload: withKey(p, null), p_idem_key: k }; });
  }
  function resolveException(id, s, note) { return rpc('resolve_exception', { p_id: id, p_status: s, p_note: note || null }); }

  /* operational alerts (G3.16) — viewing never closes an alert */
  // f = { status, severity, kind, branch_id, transaction_id, due_before, limit, before_id, orgId } → p_filters (orgId stripped)
  // count_only → { data: { count, counts } } (nav badge). list_alerts accepts only the keys below and limit ≤ 200;
  // rows get transaction_ref (= ref) and the result carries the server's per-severity counts (r.counts).
  var ALERT_FILTER_KEYS = ['status', 'severity', 'kind', 'transaction_id', 'branch_id', 'limit', 'offset'];
  function listAlerts(f) {
    f = Object.assign({}, f || {});
    var explicit = f.orgId, countOnly = !!f.count_only, pf = {};
    ALERT_FILTER_KEYS.forEach(function (k) { if (f[k] != null && f[k] !== '') pf[k] = f[k]; });
    if (countOnly) pf.limit = 1;
    else if (pf.limit != null) pf.limit = Math.max(1, Math.min(200, parseInt(pf.limit, 10) || 100));
    return inActiveOrg(explicit, function (oid) {
      return rpc('list_alerts', { p_org: oid, p_filters: pf }).then(function (r) {
        if (r.error || !r.data || Array.isArray(r.data)) return r;
        var counts = r.data.counts || null;
        if (countOnly) return ok({ count: r.data.total != null ? r.data.total : 0, counts: counts });
        (r.data.items || []).forEach(function (a) { if (a && a.ref && !a.transaction_ref) a.transaction_ref = a.ref; });
        var out = rowsOrList(r);
        out.counts = counts;
        return out;
      });
    });
  }
  function ackAlert(id) { return rpc('ack_alert', { p_id: id }); }
  function resolveAlert(id, note) { return rpc('resolve_alert', { p_id: id, p_note: note || null }); }
  // staff may refresh at most once per minute per org (the server rate-limits and says so)
  function refreshAlerts(o) {
    o = o || {};
    return inActiveOrg(o.orgId, function (oid) { return rpc('refresh_alerts', { p_org: oid }); });
  }

  /* ------------------------------------------------------------------
     App shell: global search (command palette) + dashboard counters.
     Plain RLS-scoped PostgREST reads, limited to the active org (or o.orgId).
     ------------------------------------------------------------------ */
  // ILIKE "contains" pattern with the LIKE metacharacters \ % _ escaped (Postgres' default
  // escape is the backslash). '*' is PostgREST's own wildcard alias and cannot be escaped,
  // so it is dropped. One column per query: no or() string, so , ( ) " need no quoting.
  function likeContains(s) {
    var v = String(s == null ? '' : s).replace(/\*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    return v ? '%' + v.replace(/[\\%_]/g, '\\$&') + '%' : '';
  }
  function localDay(offsetDays) {
    var d = new Date(); d.setDate(d.getDate() + (offsetDays || 0));
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  var SEARCH_TX_COLS = 'id,org_id,ref,bl_number,declaration_no,operational_status,created_at,clients(name_ar,name_en)';
  // q ≥ 2 characters. o = { limit (≤ 8 per group), orgId }.
  // → { data: { transactions: [{…row, matched, container_no?}], clients: [{…row, matched}], requests: [{…row, matched}] }, error }
  // Transactions match ref / B/L / declaration no. / container no., plus (G3) any customs declaration of any status
  // (customs_declarations, incl. cancelled / replaced numbers) and every linked B/L (bills_of_lading via
  // transaction_bls); such hits carry declaration_no + declaration_status or bl_number of the matching row.
  // Clients name (ar/en) / CR / VAT; requests ref.
  // error only when every query failed (e.g. network); a failed group is otherwise just empty.
  function globalSearch(q, o) {
    o = o || {};
    var empty = { transactions: [], clients: [], requests: [] };
    if (!configured) return demoOnly();
    var pat = likeContains(q);
    if (!pat || String(q).trim().length < 2) return Promise.resolve(ok(empty));
    var limit = Math.min(Math.max(parseInt(o.limit, 10) || 8, 1), 8);
    var oid = o.orgId || (ctxCache ? pickActiveOrg(ctxCache) : null);
    function scoped(b) { return oid ? b.eq('org_id', oid) : b; }
    // map(row) → the transaction item of a child-table hit (or null); matched = the column reported to the caller
    function by(table, cols, col, order, map, matched) {
      return online(function (c) {
        var b = scoped(c.from(table).select(cols)).ilike(col, pat);
        if (order) b = b.order(order, { ascending: false });
        return b.limit(limit);
      }).then(function (r) { r.col = matched || col; r.map = map || null; return r; });
    }
    function viaTx(extra) {
      return function (row) { return row && row.transactions ? Object.assign({}, row.transactions, extra(row)) : null; };
    }
    var groups = {
      transactions: [by('transactions', SEARCH_TX_COLS, 'ref', 'created_at'), by('transactions', SEARCH_TX_COLS, 'bl_number', 'created_at'),
        by('transactions', SEARCH_TX_COLS, 'declaration_no', 'created_at'),
        by('containers', 'container_no,transaction_id,transactions(' + SEARCH_TX_COLS + ')', 'container_no', null,
          viaTx(function (row) { return { container_no: row.container_no }; })),
        by('customs_declarations', 'declaration_no,status,transaction_id,transactions(' + SEARCH_TX_COLS + ')', 'declaration_no', 'created_at',
          viaTx(function (row) { return { declaration_no: row.declaration_no, declaration_status: row.status }; })),
        by('transaction_bls', 'transaction_id,bills_of_lading!inner(bl_number),transactions(' + SEARCH_TX_COLS + ')', 'bills_of_lading.bl_number', null,
          viaTx(function (row) { return { bl_number: row.bills_of_lading && row.bills_of_lading.bl_number }; }), 'bl_number')],
      clients: ['name_ar', 'name_en', 'cr_number', 'vat_number'].map(function (col) {
        return by('clients', 'id,org_id,client_type,name_ar,name_en,cr_number,vat_number,is_active', col, null);
      }),
      requests: [by('service_requests', 'id,org_id,ref,status,full_name,company,created_at', 'ref', 'created_at')]
    };
    var names = Object.keys(groups), jobs = [], total = 0, failed = [];
    names.forEach(function (g) { groups[g].forEach(function (p) { jobs.push(p); total++; }); });
    return Promise.all(jobs).then(function (res) {
      var data = {}, i = 0;
      names.forEach(function (g) {
        var seen = {}, out = [];
        groups[g].forEach(function () {
          var r = res[i++];
          if (r.error) { failed.push(r.error); return; }
          (r.data || []).forEach(function (row) {
            var item = r.map ? r.map(row) : row;   // container / declaration / B/L hit → its transaction
            if (!item || !item.id || seen[item.id] || out.length >= limit) return;
            seen[item.id] = true;
            out.push(Object.assign({}, item, { matched: r.col }));
          });
        });
        data[g] = out;
      });
      if (failed.length === total) return { data: null, error: failed[0] };
      return ok(data);
    }, function (e) { return { data: null, error: normalizeError(e) }; });
  }

  var DASH_REQ = ['new', 'under_review', 'converted', 'rejected'];
  var DASH_TX = ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return',
    'operationally_complete', 'under_billing', 'billed', 'closed'];
  var DASH_OPEN_RETURN = ['pending', 'evidence_submitted', 'disputed'];
  // Parallel HEAD counts for the active org (or orgId).
  // → { data: { org_id, requests: {<status>: n}, transactions: {<operational_status>: n, open: n},
  //             containers: { pending_return, overdue, due_3d }, documents: { unreviewed }, failed: n }, error }
  // A count that failed is null (RLS gives 0 for what a role may not read); error only when all failed.
  function dashboardStats(oid) {
    if (!configured) return demoOnly();
    var pick = oid ? Promise.resolve(ok(oid)) : activeOrgId();
    return pick.then(function (r) {
      if (r.error) return r;
      if (!r.data) return fail('MRS_FORBIDDEN', 'organization');
      var org = r.data, jobs = [], failed = [];
      function count(table, build) {
        var p = online(function (c) { return build(c.from(table).select('id', { count: 'exact', head: true }).eq('org_id', org)); })
          .then(function (x) { if (x.error) { failed.push(x.error); return null; } return x.count || 0; });
        jobs.push(p);
        return p;
      }
      var today = localDay(0), in3 = localDay(3);
      var reqs = DASH_REQ.map(function (s) { return count('service_requests', function (q) { return q.eq('status', s); }); });
      var txs = DASH_TX.map(function (s) { return count('transactions', function (q) { return q.eq('operational_status', s); }); });
      var ctr = [
        count('containers', function (q) { return q.in('return_status', DASH_OPEN_RETURN); }),
        count('containers', function (q) { return q.in('return_status', DASH_OPEN_RETURN).lt('return_deadline', today); }),
        count('containers', function (q) { return q.in('return_status', DASH_OPEN_RETURN).gte('return_deadline', today).lte('return_deadline', in3); })
      ];
      var docs = count('documents', function (q) { return q.eq('classification_status', 'unreviewed').is('voided_at', null); });
      return Promise.all([Promise.all(reqs), Promise.all(txs), Promise.all(ctr), docs]).then(function (v) {
        if (failed.length === jobs.length) return { data: null, error: failed[0] };
        var d = { org_id: org, requests: {}, transactions: { open: 0 }, containers: {}, documents: {}, failed: failed.length };
        DASH_REQ.forEach(function (s, i) { d.requests[s] = v[0][i]; });
        DASH_TX.forEach(function (s, i) {
          d.transactions[s] = v[1][i];
          if (s !== 'closed' && v[1][i] != null) d.transactions.open += v[1][i];
        });
        d.containers = { pending_return: v[2][0], overdue: v[2][1], due_3d: v[2][2] };
        d.documents = { unreviewed: v[3] };
        return ok(d);
      });
    }, function (e) { return { data: null, error: normalizeError(e) }; });
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
     Client error reporting (online only): uncaught errors and unhandled
     rejections → log_client_error. Deduped per message, at most 5 per page
     load. Only location.pathname is sent (never ?query / #hash: they can
     carry invite / recovery / tracking tokens).
     ------------------------------------------------------------------ */
  var ERR_MAX = 5, errSent = 0, errSeen = {};
  function reportError(code, message) {
    if (!configured || errSent >= ERR_MAX) return;
    var msg = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!msg || /^script error\.?$/i.test(msg)) return;   // opaque cross-origin error: nothing useful
    if (errSeen[msg]) return;
    errSeen[msg] = true; errSent++;
    var cachedOrg = ctxCache ? pickActiveOrg(ctxCache) : null;
    try { logClientError({ code: code, message: msg, page: location.pathname, orgId: cachedOrg }).then(function () {}, function () {}); }
    catch (e) { /* never let reporting throw */ }
  }
  if (configured && window.addEventListener) {
    window.addEventListener('error', function (ev) {
      if (!ev || (ev.target && ev.target !== window)) return;   // resource load errors (img/script) are not JS errors
      var where = ev.filename ? ' @' + String(ev.filename).replace(/[?#].*$/, '').split('/').pop() + ':' + (ev.lineno || 0) : '';
      reportError('JS_ERROR', (ev.message || (ev.error && ev.error.message) || 'error') + where);
    });
    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev && ev.reason;
      reportError('UNHANDLED_REJECTION', r && (r.message || r.code) ? (r.code ? r.code + ': ' : '') + (r.message || '') : String(r));
    });
  }

  /* ------------------------------------------------------------------
     Public API
     ------------------------------------------------------------------ */
  var api = {
    version: '0.2.0-staging',
    environment: cfg.environment || 'staging',
    orgSlug: ORG_SLUG,
    i18n: { ar: AR },
    client: null,                         // supabase client once ready() resolved (online only)
    isOnline: function () { return configured; },
    isMisconfigured: function () { return misconfigured; },
    ready: function () { return ready().then(function (c) { return ok(c); }, function (e) { return { data: null, error: normalizeError(e) }; }); },
    errorMessage: function (err) { return normalizeError(err).message; },
    // auth
    signIn: signIn, signUp: signUp, signOut: signOut, signOutEverywhere: signOutEverywhere,
    resetPassword: resetPassword, updatePassword: updatePassword,
    onAuth: onAuth, currentUser: currentUser, getSession: getSession,
    myContext: myContext, myMemberships: myMemberships, myRole: myRole, hasRole: hasRole, isStaff: isStaff, orgId: orgId,
    isPlatformAdmin: isPlatformAdmin, activeOrgId: activeOrgId, setActiveOrg: setActiveOrg, setMyLocale: setMyLocale,
    // public
    submitServiceRequest: submitServiceRequest, submitContactMessage: submitContactMessage, publicTrack: publicTrack,
    statusLabels: statusLabels, healthCheck: healthCheck, logClientError: logClientError,
    invitationPreview: invitationPreview, acceptInvitation: acceptInvitation,
    // idempotency
    newIdemKey: newIdemKey,
    // org admin
    getOrg: getOrg, listBranches: listBranches, listMemberships: listMemberships, addMembership: addMembership,
    setMembershipActive: setMembershipActive, listMembers: listMembers,
    updateOrg: updateOrg, createBranch: createBranch, updateBranch: updateBranch,
    invite: invite, listInvitations: listInvitations, revokeInvitation: revokeInvitation, reissueInvitation: reissueInvitation,
    auditLog: auditLog, recentErrors: recentErrors,
    // platform admin
    platformListOrgs: platformListOrgs, platformCreateOrg: platformCreateOrg, platformSetOrgActive: platformSetOrgActive,
    platformReissueAdminInvitation: platformReissueAdminInvitation,
    platformRecentErrors: platformRecentErrors,
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
    // G3 operations (docs/online/G3_SPEC.md)
    listParties: listParties, saveParty: saveParty, listDrivers: listDrivers, saveDriver: saveDriver,
    listTrucks: listTrucks, saveTruck: saveTruck,
    listClientAliases: listClientAliases, addClientAlias: addClientAlias, removeClientAlias: removeClientAlias, matchClient: matchClient,
    listDeclarations: listDeclarations, addDeclaration: addDeclaration, setDeclarationStatus: setDeclarationStatus,
    cancelDeclaration: cancelDeclaration, correctDeclaration: correctDeclaration,
    listBLs: listBLs, saveBL: saveBL, linkBL: linkBL, unlinkBL: unlinkBL,
    containerHistory: containerHistory, setContainerReturn: setContainerReturn,
    txCompleteness: txCompleteness, txChecklist: txChecklist, listRequirements: listRequirements, saveRequirement: saveRequirement,
    listAppointments: listAppointments, createAppointment: createAppointment, rescheduleAppointment: rescheduleAppointment,
    setAppointmentStatus: setAppointmentStatus,
    listTrips: listTrips, createTrip: createTrip, updateTrip: updateTrip, setTripStatus: setTripStatus, tripFinance: tripFinance,
    listExceptions: listExceptions, createException: createException, resolveException: resolveException,
    listAlerts: listAlerts, ackAlert: ackAlert, resolveAlert: resolveAlert, refreshAlerts: refreshAlerts,
    // app shell
    globalSearch: globalSearch, dashboardStats: dashboardStats,
    // utils
    util: { sha256Hex: sha256Hex, uuid: uuid, safeFileName: safeFileName, toRequestPayload: toRequestPayload, toContactPayload: toContactPayload }
  };
  window.MarsaApi = api;
})();
