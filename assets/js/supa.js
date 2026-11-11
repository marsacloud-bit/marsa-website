/* ==========================================================================
   مرسى | MARSA — online data layer (Supabase, STAGING)  →  window.MarsaApi
   --------------------------------------------------------------------------
   Load order:  config.js → i18n.js → main.js → supa.js → [assets/i18n/<page>.js] → <page>.js
                (plain <script defer>)

   * Online  when window.MARSA_CONFIG has supabaseUrl + supabaseAnonKey:
     supabase-js v2 (UMD, pinned 2.45.4) is injected on demand from assets/vendor/ (same origin, SRI).
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

  // supabase-js 2.45.4 UMD, hosted with the site (PDPL: no third-party CDN on every page). Copied unchanged
  // from the npm tarball (registry integrity sha512-E5p8/zOLaQ3a…); 591.supabase.js is its lazy ws chunk.
  // Resolved next to this file so any page depth works; the hash is checked by the browser (SRI).
  var SUPABASE_UMD = (function () {
    var me = document.currentScript && document.currentScript.src;
    return (me ? me.replace(/assets\/js\/supa\.js(?:[?#].*)?$/, '') : '') + 'assets/vendor/supabase-js-2.45.4/supabase.js';
  })();
  var SUPABASE_UMD_SRI = 'sha384-0w2KAL2YHP6wKOkUDzkCDGgVvfmHnj02DHeQ6XcHOgTfFsGyonKOpShMH1x6nk9o';
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
      // AI document reading (20261114000100 + Edge Function ai-extract)
      MRS_AI_DISABLED: 'القراءة بالذكاء الاصطناعي غير مفعّلة لهذه المؤسسة. يفعّلها مدير المؤسسة من «المؤسسة» في لوحة الموظفين.',
      MRS_AI_DAILY_CAP: 'وصلت المؤسسة إلى الحد اليومي للقراءة بالذكاء الاصطناعي. حاول غدًا أو اطلب من مدير المؤسسة رفع الحد.',
      MRS_AI_BUDGET: 'بلغت تكلفة القراءة بالذكاء الاصطناعي ميزانية هذا الشهر. اطلب من مدير المؤسسة رفع الميزانية.',
      MRS_AI_REFUSED: 'رفض نموذج الذكاء الاصطناعي قراءة هذا المستند. استخدم القراءة داخل المتصفح (Tesseract) بدلًا منه.',
      MRS_AI_TRUNCATED: 'المستند أطول من أن يُقرأ كاملًا في طلب واحد. قسّم ملف PDF أو ارفع الصفحات المهمة فقط.',
      MRS_AI_TOO_LARGE: 'الملف أكبر من حد القراءة بالذكاء الاصطناعي: 5 ميغابايت للصورة و10 ميغابايت لملف PDF.',
      MRS_AI_UNSUPPORTED: 'صيغة الملف غير مدعومة للقراءة بالذكاء الاصطناعي. استخدم JPG أو PNG أو WEBP أو GIF أو PDF.',
      MRS_AI_UNAVAILABLE: 'خدمة القراءة بالذكاء الاصطناعي غير متاحة الآن. حاول لاحقًا أو استخدم القراءة داخل المتصفح.',
      MRS_AI_FAILED: 'تعذّرت القراءة بالذكاء الاصطناعي. حاول مرة أخرى أو استخدم القراءة داخل المتصفح.',
      // document matching (20261116000100): invoice ↔ B/L ↔ customs declaration
      MRS_MATCH_DOC_KIND: 'المستند المحفوظ في خانة «{f}» ليس من النوع المطلوب (فاتورة تجارية، بوليصة شحن، بيان جمركي). تحقّق من نوع المستند ثم أعد القراءة.',
      MRS_MATCH_DOC_VOIDED: 'قراءة «{f}» مُلغاة، فلا يمكن حفظ المطابقة عليها. اقرأ المستند من جديد ثم احفظ.',
      MRS_MATCH_VOIDED: 'هذه المطابقة مُلغاة ولا يمكن مراجعتها أو تعديلها.',
      MRS_EXPIRED: 'انتهت صلاحية هذا الرابط أو الدعوة. اطلب دعوة جديدة.',
      MRS_EMAIL_MISMATCH: 'هذه الدعوة موجّهة إلى بريد إلكتروني آخر. سجّل الدخول بالبريد المدعو نفسه.',
      MRS_EMAIL_UNCONFIRMED: 'يلزم تأكيد بريدك الإلكتروني أولًا من الرسالة المرسلة إليك، ثم أعد المحاولة.',
      MRS_IDEMPOTENCY_CONFLICT: 'تعذّر تكرار العملية بالمفتاح نفسه لأن البيانات تغيّرت أو انتهت مهلته. حدّث الصفحة وتحقّق مما حُفظ قبل المحاولة من جديد.',
      MRS_IN_PROGRESS: 'العملية نفسها ما زالت قيد التنفيذ. انتظر قليلًا ثم تحقّق من النتيجة.',
      MRS_UNKNOWN_RESULT: 'لم نتمكن من تأكيد نتيجة العملية بسبب انقطاع الاتصال. إعادة المحاولة آمنة ولن تُنشئ نسخة مكرّرة.',
      MRS_TIMEOUT: 'استغرق الخادم وقتًا أطول من المعتاد. حاول مرة أخرى.',
      MRS_DOCS_MISSING: 'لا يمكن الانتقال إلى هذه المرحلة قبل استكمال المستندات المطلوبة لها ({f}). ارفعها وصنّفها، أو تجاوز القاعدة بصلاحية مدير مع ذكر السبب.',
      // legacy step 2 (20261118000100): duplicate transaction / appointment guards
      MRS_DUPLICATE_TX: 'توجد معاملة مسجلة مسبقًا بنفس رقم البوليصة ونفس الوحدة (حاوية أو شاسيه). افتح المعاملة الموجودة بدلًا من تكرارها.',
      MRS_DUPLICATE_APPOINTMENT: 'يوجد موعد مطابق مسجل مسبقًا لنفس الحاوية ورقم الموعد وتاريخ/وقت الموعد.',
      // legacy step 3 (20261119000100): shipment document batches
      MRS_DOC_WRONG_SLOT: 'المستند مرفوع في الخانة الخطأ: محتواه لا يطابق نوع الخانة ({f}). اختر الخانة الصحيحة ثم أعد القراءة.',
      MRS_DOC_IN_OTHER_BATCH: 'هذا المستند المقروء مضاف إلى حزمة مستندات أخرى مفتوحة أو معتمدة. افتح تلك الحزمة أو أزله منها أولًا.',
      MRS_DOC_BATCH_STATE: 'حالة حزمة المستندات لا تسمح بهذا الإجراء ({f}). المعتمدة لا تُعدَّل ولا تُحذف، والمتجاهلة أو المؤرشفة لا تُعتمد.',
      MRS_DOC_BATCH_STALE: 'عدّل شخص آخر هذه المسودة بعد فتحك لها. أعد تحميلها ثم راجع التغييرات قبل الحفظ أو الاعتماد.',
      MRS_CLIENT_ALIAS_CONFLICT: 'هذا الاسم معتمد مسبقًا كاسم بديل لعميل آخر. اختر ذلك العميل، أو راجع الأسماء البديلة في دليل العملاء.',
      // legacy step 4 (20261120000100): customs declaration approval
      MRS_DECL_STALE: 'تغيّرت المعاملة أو قراءة البيان بعد فتحك للمراجعة. أعد تحميل المراجعة ثم تحقق من القيم قبل الاعتماد.',
      MRS_DECL_BL_MISMATCH: 'رقم البوليصة في البيان لا يطابق بوليصة المعاملة. راجع الرقم، أو أكد صراحةً أن البيان يخص هذه المعاملة (يبقى رقم البوليصة الأصلي دون تغيير).',
      MRS_DECL_NUMBER_CONFLICT: 'للمعاملة بيان جمركي نشط برقم آخر. ألغِ البيان الحالي أو استبدله أولًا ثم اعتمد القراءة.',
      MRS_DECL_ALREADY_APPROVED: 'اعتُمدت قراءة البيان هذه من قبل. لتعديل البيان استخدم «تصحيح البيان» في المعاملة.',
      // G4 (docs/online/G4_SPEC.md)
      MRS_OVER_ALLOCATED: 'مجموع التوزيع يتجاوز صافي البند؛ التوزيع لا يضاعف الفاتورة (المتبقي القابل للتوزيع: {f}).',
      MRS_OVERPAID: 'المبلغ يتجاوز المتبقي من الإجمالي (المتبقي: {f}).',
      // G6a (client-side only: the export checks of assets/js/rpt/export.js)
      MRS_EXPORT: 'تعذّر إنشاء ملف التصدير. أعد المحاولة.',
      // G7 subscriptions & plan limits (docs/online/G7_SPEC.md §Errors); {f} = AR.planLabels label, never the raw key
      MRS_PLAN_LIMIT: 'وصلت المؤسسة إلى حد الباقة ({f}). لم يُحفظ شيء. تواصل مع إدارة المنصة لترقية الباقة.',
      MRS_PLAN_INACTIVE: 'اشتراك المؤسسة غير نشط ({f}). يمكنك الاطلاع على البيانات، ولا يمكن إنشاء سجلات جديدة.',
      DUPLICATE: 'هذا السجل موجود من قبل (تكرار). إن كان ملفًا فقد رُفع سابقًا.',
      FK: 'مرجع غير صالح أو لا يخص مؤسستك.',
      CHECK: 'بعض القيم غير صحيحة.',
      RLS: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
      AUTH_INVALID: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
      AUTH_UNCONFIRMED: 'يلزم تأكيد البريد الإلكتروني أولًا من الرسالة المرسلة إليك.',
      AUTH_EXISTS: 'هذا البريد الإلكتروني مسجّل من قبل.',
      AUTH_WEAK: 'كلمة المرور ضعيفة. استخدم 8 أحرف على الأقل تجمع حروفًا وأرقامًا.',
      AUTH_RATE: 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.',
      // MFA (docs/online/MFA_SPEC.md §6)
      MRS_MFA_REQUIRED: 'هذا الإجراء يتطلب التحقق بخطوتين. أكمل التحقق ثم حاول مرة أخرى.',
      MFA_INVALID_CODE: 'الرمز غير صحيح أو انتهت صلاحيته. أدخل الرمز الحالي من التطبيق.',
      MFA_AAL2_REQUIRED: 'أدخل رمز التحقق أولًا.',
      UNKNOWN: 'حدث خطأ غير متوقع. حاول مرة أخرى.'
    },
    fields: {
      // document matching (20261116000100)
      invoice_extraction_id: 'الفاتورة التجارية', bl_extraction_id: 'بوليصة الشحن', declaration_extraction_id: 'البيان الجمركي',
      reviewed_rows: 'الحقول المراجَعة', engine_version: 'إصدار المطابقة', overall: 'النتيجة العامة', counts: 'عدد النتائج',
      rows: 'حقول المطابقة', document_match: 'المطابقة',
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
      driver_name: 'اسم السائق', driver_phone: 'رقم جوال السائق', truck_plate: 'رقم الشاحنة', movement_status: 'حالة الموعد والنقل',
      destination: 'وجهة التسليم', cost_amount: 'قيمة النقل', sell_amount: 'عائد المؤسسة', delivered_at: 'وقت التسليم',
      appointment_id: 'الموعد', appointment: 'الموعد', trip: 'حركة النقل', appointment_status: 'حالة الموعد', cargo_unit_type: 'نوع وحدة الشحن',
      chassis_no: 'رقم الشاسيه', port_code: 'المنفذ الجمركي',
      terminal_party_id: 'المحطة', return_yard_party_id: 'ساحة الإرجاع', return_instruction_document_id: 'تعليمات الإرجاع', driver_id: 'السائق',
      truck_id: 'الشاحنة', container_id: 'الحاوية', container_no: 'رقم الحاوية', appointment_at: 'وقت الموعد', window_minutes: 'مدة نافذة الموعد',
      appointment_no: 'رقم الموعد', occurred_at: 'تاريخ الحدوث', at: 'وقت الحالة', leg_no: 'رقم المرحلة',
      cost: 'التكلفة وسعر البيع (لصلاحيات المالية والإدارة فقط)', cost_basis: 'أساس التكلفة', waiver: 'الإعفاء (لصلاحية مدير)',
      document_or_amount: 'مستند أو مبلغ (مطلوب لهذا النوع)', kind: 'النوع', source: 'المصدر', source_document_id: 'المستند المصدر',
      replacement: 'البيان البديل', replaces_id: 'البيان المستبدَل', use_cancel_declaration: 'الإلغاء (استخدم «إلغاء البيان»)',
      use_reschedule_appointment: 'تغيير الموعد (استخدم «إعادة الجدولة»)', no_change: 'لا يوجد تغيير', backward: 'الرجوع إلى حالة سابقة',
      cancelled: 'سجل ملغى', resolved: 'استثناء مغلق', link: 'ربط البوليصة', reason: 'السبب', severity: 'الأهمية', packages: 'عدد الطرود',
      plate_no: 'رقم اللوحة', national_id_last4: 'آخر 4 أرقام من الهوية', ids: 'المعرّفات', transaction: 'المعاملة', org_id: 'المؤسسة',
      // G4 fields / detail codes
      supplier_id: 'المورد', invoice_number: 'رقم الفاتورة', invoice_date: 'تاريخ الفاتورة', due_date: 'تاريخ الاستحقاق',
      subtotal: 'الإجمالي قبل الضريبة', vat_amount: 'مبلغ الضريبة', total_amount: 'الإجمالي', net_amount: 'الصافي', vat_rate: 'نسبة الضريبة',
      quantity: 'الكمية', unit_price: 'سعر الوحدة', description: 'الوصف', service_code: 'الخدمة', line_id: 'البند', lines: 'بنود الفاتورة',
      supplier_invoice_id: 'فاتورة المورد', finance_document_id: 'المستند المالي', adjusts_invoice_id: 'الفاتورة الأصلية للإشعار',
      supplier_vat_number: 'الرقم الضريبي للمورد', amount: 'المبلغ', share_pct: 'نسبة التوزيع', trip_id: 'الرحلة', accrual_id: 'التكلفة المتوقعة',
      demurrage_case_id: 'ملف الأرضيات / الغرامات', cost_allocation_id: 'توزيع التكلفة', charge_id: 'المبلغ المحمّل على العميل',
      markup_pct: 'نسبة الإضافة', paid_at: 'تاريخ الدفع', collected_at: 'تاريخ التحصيل', method: 'طريقة الدفع', payer: 'الدافع',
      operator_id: 'المشغّل', exception_id: 'الاستثناء التشغيلي', free_until: 'نهاية المهلة المجانية', charged_until: 'محسوب حتى',
      estimated_amount: 'المبلغ التقديري', related_invoice_id: 'الفاتورة الأصلية', iban_last4: 'آخر 4 أرقام من الآيبان', bank_name: 'البنك',
      payment_terms_days: 'مدة السداد (أيام)', default_currency: 'العملة الافتراضية', group_by: 'التجميع حسب', size_bytes: 'حجم الملف',
      storage_path: 'مسار الملف', decision: 'القرار', basis: 'أساس التقدير', line_excluded: 'بند مستبعد', line_overhead: 'بند مصروف عام',
      line_pending_review: 'بند بانتظار المراجعة', line_disputed: 'بند متنازع عليه', share_total: 'مجموع النسب (أكثر من 100%)',
      stage_skip: 'تخطي مرحلة', unknown_key: 'حقل غير معروف', operational_state: 'الحالة التشغيلية للحاوية', gross_weight_kg: 'الوزن الإجمالي',
      // G5 fields
      purpose: 'غرض الفوترة', item_key: 'الصنف', external_id: 'رقم العميل في دفترة', external_product_id: 'رقم المنتج في دفترة',
      subdomain: 'النطاق الفرعي لدفترة', mode: 'وضع الاتصال', allowed_vat_rates: 'نسب الضريبة المسموحة',
      default_service_vat_rate: 'نسبة ضريبة الخدمات', reimbursable_tax_code: 'تصنيف ضريبة المبالغ المستردة', tax_code: 'التصنيف الضريبي',
      invoice_notes: 'ملاحظات الفاتورة', intent_id: 'غرض الفوترة', charge_ids: 'المبالغ', link_id: 'ربط العميل', job_id: 'مهمة المزامنة',
      name_ar: 'الاسم بالعربية', name_en: 'الاسم بالإنجليزية', default_vat_rate: 'نسبة الضريبة الافتراضية',
      intent: 'غرض الفوترة', external_invoice_id: 'رقم الفاتورة في دفترة',
      // G6a search / reports / export (docs/online/G6A_SPEC.md §6)
      q: 'نص البحث', date_field: 'نوع التاريخ', sort: 'الترتيب', return_status: 'حالة إرجاع الحاوية', trip_status: 'حالة الرحلة',
      report: 'نوع التقرير', format: 'صيغة التصدير',
      // G6b messaging (docs/online/G6B_SPEC.md)
      thread: 'المحادثة', reply: 'الرد', contact: 'جهة الاتصال', channel: 'القناة', channel_id: 'القناة', channel_kind: 'نوع القناة',
      recipient: 'المستلم', owner: 'المسؤول', owner_id: 'المسؤول', category: 'التصنيف', template_key: 'القالب', extraction: 'المرجع المستخرج',
      body_text: 'نص الرسالة', lang: 'اللغة', address: 'العنوان أو الرقم', display_name: 'اسم جهة الاتصال', entity_type: 'نوع الجهة',
      party_id: 'الجهة', role_label: 'الدور لدى الجهة', verification_method: 'طريقة التوثيق', scope_type: 'نطاق التفويض',
      may_receive_kinds: 'المستندات المسموح باستلامها', may_discuss: 'المواضيع المسموح بها', valid_from: 'ساري من', valid_until: 'ساري حتى',
      due_at: 'موعد المتابعة', priority: 'الأولوية', match_status: 'حالة الربط', ai_provider: 'مزود المعالجة الآلية',
      ai_monthly_budget_usd: 'الميزانية الشهرية للمعالجة الآلية', retention_days: 'مدة الاحتفاظ (أيام)', violation_repeat_days: 'نافذة تكرار المخالفة (أيام)',
      default_lang: 'اللغة الافتراضية', signature_ar: 'التوقيع بالعربية', signature_en: 'التوقيع بالإنجليزية', instruction_key: 'مفتاح التعليمة',
      params: 'إعدادات التعليمة', placeholders: 'متغيرات القالب', party_kinds: 'أنواع الجهات', operation: 'نوع العملية',
      subject_tpl: 'قالب الموضوع', body_tpl: 'قالب النص', conditions: 'الشروط', allowed_categories: 'التصنيفات المسموحة',
      provider_terms_ack: 'إقرار شروط مزود الخدمة', ingest_enabled: 'الاستقبال', send_enabled: 'الإرسال', default_branch_id: 'الفرع الافتراضي',
      box: 'الصندوق', document_ids: 'مرفقات الرد', version_id: 'نسخة الرد', outbound_id: 'عملية الإرسال', summary_id: 'الملخص',
      message_id: 'الرسالة', reply_to_message_id: 'الرسالة المردود عليها', signed_url: 'رابط التنزيل'
    },
    // G4 detail-specific messages (error.field = the detail code); they replace the code's generic text
    details: {
      invoice_number_taken: 'رقم الفاتورة مسجّل من قبل لهذا المورد (بعد توحيد الصيغة). افتح الفاتورة الموجودة بدلًا من إدخالها مرة أخرى.',
      file_duplicate: 'هذا الملف مرفوع من قبل كمستند مالي. افتح السجل الموجود بدلًا من رفعه مرة أخرى.',
      duplicate_ref: 'يوجد سجل مطابق من قبل (رقم أو ملف مكرر). افتح السجل الموجود بدلًا من إنشاء نسخة جديدة.',
      self_approval: 'لا يمكنك اعتماد سجل أنشأته بنفسك (مبدأ الأربعة أعين). يعتمده مسؤول آخر.',
      paid_by_client: 'هذه التكلفة دفعها العميل للمورد مباشرة، فلا تُحمَّل عليه كمبلغ مسترد مرة أخرى.',
      charged_to_client: 'هذه التكلفة محمّلة على العميل كمبلغ مسترد. ألغِ المبلغ المحمّل أولًا قبل تسجيل أن العميل دفعها مباشرة.',
      g5_only: 'حالة «مفوترة» تُضبط من الفوترة (المرحلة القادمة) فقط.',
      lines_pending_review: 'لا يمكن اعتماد الفاتورة وفيها بنود بانتظار المراجعة أو متنازع عليها.',
      lines_unallocated: 'لا يمكن اعتماد الفاتورة قبل توزيع كل بنودها المقبولة بتوزيعات معتمدة ({x}).',
      original_file: 'أرفق أصل الفاتورة (ملف) قبل اعتمادها.',
      late_cost: 'هذه تكلفة متأخرة على معاملة في مرحلة الفوترة أو مغلقة؛ اكتب سبب الاعتماد.',
      discrepancy: 'إجماليات رأس الفاتورة لا تطابق مجموع البنود؛ اكتب ملاحظة تشرح الفرق قبل الاعتماد.',
      party_finance: 'البيانات المالية للجهة (البنك والآيبان وشروط الدفع والعملة) تُحفظ من «البيانات المالية» فقط.',
      finance: 'هذه البيانات المالية متاحة لصلاحيات المالية فقط.',
      invoice_locked: 'الفاتورة معتمدة أو ملغاة ولا تقبل التعديل. حوّلها إلى «متنازع عليها» أولًا.',
      invoice_approved: 'لا يمكن عكس توزيع على فاتورة معتمدة. حوّل الفاتورة إلى «متنازع عليها» أولًا.',
      has_payments: 'على الفاتورة دفعات مسجّلة؛ ألغِ الدفعات أولًا.',
      has_approved_allocations: 'على الفاتورة توزيعات معتمدة؛ اعكسها أولًا.',
      in_use: 'المستند هو أصل فاتورة قائمة ولا يمكن إلغاؤه.',
      allocated: 'البند موزّع على معاملات؛ اعكس توزيعاته أو ارفضها قبل تعديله.',
      cost_charged: 'هذه التكلفة (أو تكلفتها المتوقعة المرتبطة) محمّلة على العميل من قبل؛ لا تُحمَّل مرتين.',
      trip_charged: 'رحلة النقل هذه محمّلة على العميل من قبل (بسعرها أو بتكلفتها)؛ لا تُحمَّل مرتين.',
      credit_exceeds_invoice: 'الإشعار الدائن أكبر مما تبقى من الفاتورة الأصلية بعد الإشعارات السابقة (المتبقي: {x}).',
      credit_target: 'بند الإشعار الدائن يخفّض فقط معاملة تحمل تكلفة الفاتورة الأصلية، ولا ينزل بها تحت الصفر (المتبقي: {x}).',
      credit_note_link: 'الإشعار الدائن لا يُطابق رحلة أو أرضيات أو تكلفة متوقعة؛ خصّصه على المعاملة فقط.',
      credit_allocated: 'إشعار دائن يخفّض هذه المعاملة؛ اعكس توزيع الإشعار أولًا.',
      currency_in_use: 'لا تُغيَّر عملة الملف وعليه توزيعات أو مبالغ محمّلة.',
      no_accrual: '«بلا مطابقة» لا يجتمع مع رحلة أو ملف أرضيات.',
      // G5 billing & Daftra (docs/online/G5_SPEC.md)
      service_only: 'هذا الإجراء خاص بعامل المزامنة على الخادم ولا يُستدعى من حساب موظف.',
      not_connected: 'الاتصال بدفترة غير جاهز (غير متصل أو المزامنة موقوفة). افحص الاتصال من «إعداد دفترة» أولًا.',
      capability: 'إمكانات دفترة اللازمة للإرسال غير مثبتة على هذا الحساب ({x}). أعد فحص الإمكانات من «إعداد دفترة».',
      intent_issued: 'الفاتورة صادرة في دفترة ومجمّدة؛ لا تُعدَّل من مرسى. المبالغ اللاحقة تذهب إلى فاتورة إضافية.',
      in_invoice: 'هذا المبلغ على بند فاتورة قائمة؛ احذفه من الفاتورة أولًا قبل تغيير حالته.',
      sync_in_flight: 'عملية مزامنة مع دفترة قيد التنفيذ أو نتيجتها غير معروفة بعد؛ انتظر المطابقة ثم أعد المحاولة.',
      conflict_open: 'يوجد تعارض مفتوح مع دفترة (عُدّلت المسودة هناك)؛ عالج التعارض أولًا.',
      remote_draft_exists: 'توجد مسودة لهذه الفاتورة في دفترة؛ لا يُلغى الغرض مباشرة.',
      no_issued_final: 'الفاتورة الإضافية تتطلب فاتورة نهائية صادرة للمعاملة نفسها والعملة نفسها.',
      final_issued: 'صدرت الفاتورة النهائية؛ لا تُنشأ فاتورة مرحلية بعدها. استخدم فاتورة إضافية.',
      intent_taken: 'يوجد غرض فوترة قائم لهذه المعاملة والعملة والغرض. افتحه بدلًا من إنشاء نسخة ثانية.',
      external_id_taken: 'عميل دفترة هذا مربوط بعميل آخر في مرسى؛ لا يُربط عميل دفترة واحد بعميلين.',
      not_eligible: 'أحد المبالغ غير مؤهل للفوترة (غير معتمد، أو بعملة أخرى، أو على فاتورة أخرى، أو من معاملة أخرى).',
      tax_rate_unmapped: 'نسبة الضريبة لبعض البنود غير مسموحة في إعداد دفترة ({x}).',
      client_review: 'ربط العميل بدفترة يحتاج مراجعة (وُجد أكثر من عميل محتمل). اختر العميل الصحيح من «إعداد دفترة».',
      item_review: 'بعض الأصناف تحتاج مراجعة في دفترة (منتج بالاسم نفسه برمز آخر). اربطها يدويًا من «إعداد دفترة».',
      client_in_use: 'لا يُفك ربط العميل وله فاتورة قائمة في دفترة.',
      mock_version: 'تغيّر حساب المحاكاة أثناء الحفظ؛ أعد المحاولة.',
      link_exists: 'هذا العميل مربوط بدفترة من قبل؛ افتح الربط القائم بدلًا من إنشاء ربط ثانٍ.',
      no_conflict: 'لا يوجد تعارض مفتوح على هذه الفاتورة؛ حدّث الصفحة.',
      conflict_reason: 'هذا القرار لا يناسب نوع التعارض ({x}).',
      unlinked: 'ربط العميل مفكوك؛ اربطه من جديد من «إعداد دفترة».',
      unreconciled_remote: 'قد يكون إنشاء الفاتورة وصل إلى دفترة دون تأكيد؛ أعد محاولة المزامنة لتتم المطابقة بالمرجع قبل الإلغاء أو الحذف.',
      subdomain_taken: 'حساب دفترة هذا مربوط بمؤسسة أخرى؛ لكل مؤسسة حساب دفترة خاص بها.',
      // G6a search / reports / export (docs/online/G6A_SPEC.md §6)
      search_query_short: 'اكتب حرفين على الأقل للبحث.',
      date_range: 'نطاق التاريخ غير صحيح: «من» يجب أن يسبق «إلى»، والمدة لا تتجاوز ثلاث سنوات (1096 يومًا).',
      export_rows: 'عدد الصفوف أكبر من المسموح للتصدير (Excel / CSV حتى 10٬000 صف، الطباعة حتى 2٬000). ضيّق الفلاتر.',
      totals_mismatch: 'تغيّرت البيانات أثناء التصدير، أعد المحاولة.',
      data_changed: 'تغيّرت البيانات أثناء التصدير، أعد المحاولة.',
      too_many_rows: 'عدد الصفوف أكبر من المسموح للتصدير. ضيّق الفلاتر.',
      audit_failed: 'تعذّر تسجيل عملية التصدير في السجل، فلم يُنشأ الملف. أعد المحاولة.',
      no_rows: 'لا توجد صفوف للتصدير بهذه الفلاتر.',
      // G6b messaging (docs/online/G6B_SPEC.md) — detail words used only by the msg_* RPCs
      recipient_not_authorized: 'المستلم غير موثق أو غير مفوض لهذا المستند. يُرفق المستند فقط لعنوان موثق لديه تفويض ساري يشمل نوعه.',
      sensitive_ack: 'الرد يحمل مستندًا حساسًا: أكّد الاطلاع على حساسيته واكتب ملاحظة قبل الاعتماد.',
      address_taken: 'هذا العنوان أو الرقم مستخدم من قبل (قناة مسجّلة أو جهة اتصال نشطة أخرى).',
      reply_exists: 'يوجد رد قائم لهذه المحادثة (مسودة أو بانتظار الاعتماد أو الإرسال)؛ افتحه بدلًا من إنشاء رد ثانٍ.',
      span: 'موضع النص المستخرج لا يطابق النص الأصلي للرسالة.',
      placeholder: 'القالب يحتوي متغيرًا غير مسموح. استخدم المتغيرات المعروضة في القائمة فقط.',
      provider_terms: 'سجّل أولًا أن الحساب رسمي مملوك للمؤسسة وفق شروط مزود الخدمة قبل تفعيل الاستقبال أو الإرسال.',
      not_approved: 'لا يمكن الإرسال قبل الاعتماد.',
      approval_stale: 'تغيّر النص بعد الاعتماد — يلزم اعتماد جديد.',
      four_eyes: 'لا يجوز أن يعتمد كاتب الرد رده (ولا من قدّمه للاعتماد). يعتمده مسؤول آخر.',
      already_sent: 'أُرسل هذا الرد من قبل؛ لا يُرسل مرة ثانية.',
      send_unknown: 'نتيجة إرسال سابق غير معروفة؛ لا يُعاد الإرسال قبل حسمها بالمطابقة أو بقرار مسؤول.',
      not_retryable: 'لا تُعاد هذه المحاولة: ربما استلم المزود الطلب، أو أن الخطأ نهائي.',
      wa_window_closed: 'انتهت نافذة الـ ٢٤ ساعة في واتساب منذ آخر رسالة من هذا الرقم؛ لا يُرسل رد حر.',
      channel_not_connected: 'القناة غير متصلة. افحص القناة من «القنوات والإعدادات» أولًا.',
      channel_disabled: 'الإرسال موقوف على هذه القناة.',
      auto_reply_disabled_v1: 'الردود الآلية غير مفعلة في الإصدار الأول.',
      reply_locked: 'الرد قيد الإرسال أو أُرسل؛ لا يُعدّل.',
      not_draft: 'هذا الإجراء متاح للمسودات فقط.',
      ai_budget: 'تجاوز التقدير الشهري لتكلفة المعالجة الآلية الميزانية المحددة.',
      not_configured: 'الحساب الحقيقي غير مُعدّ في هذه البيئة (وضع المحاكاة فقط).',
      attachment_not_stored: 'المرفق لم يُحفظ في التخزين بعد (في وضع المحاكاة تُحفظ بياناته الوصفية فقط)، فلا يمكن تنزيله.'
    },
    // G6b: messages for a detail word under one code only ('CODE:detail'); checked before details / the code text
    codeDetails: {
      // public anti-spam (20261113000100): one generic refusal for the per-IP limits and the form signals
      'MRS_RATE_LIMITED:try_later': 'عدد كبير من الطلبات، حاول بعد قليل.',
      // G7 subscriptions (platform RPCs)
      'MRS_BAD_TRANSITION:subscription_suspended': 'الاشتراك موقوف: أعد التفعيل من إدارة الاشتراكات.',
      'MRS_BAD_TRANSITION:use_suspend': 'لتعليق الاشتراك أو إلغائه استخدم «تعليق» بدلًا من تغيير الباقة.',
      'MRS_BAD_TRANSITION:org_suspended': 'اشتراك المؤسسة موقوف أو ملغى: أعد تفعيله أولًا ثم غيّر الباقة.',
      'MRS_BAD_TRANSITION:pilot_required': 'باقة «تجريبية (pilot)» لا يمكن إيقافها؛ هي الباقة الافتراضية للمؤسسات.',
      'MRS_INVALID:plan_inactive': 'الباقة المختارة غير مفعّلة. فعّلها من «الباقات» أو اختر باقة أخرى.',
      'MRS_INVALID:period': 'فترة الاشتراك غير صحيحة: تاريخ النهاية يجب ألا يسبق البداية، وهو مطلوب للتجربة.',
      'MRS_INVALID:limit_overrides': 'قيم الحدود الخاصة غير صحيحة (أعداد صحيحة غير سالبة فقط).',
      'MRS_INVALID:months': 'عدد الأشهر غير صحيح (من 1 إلى 24).',
      'MRS_NOT_FOUND:plan': 'الباقة غير موجودة.',
      'MRS_NOT_FOUND:thread': 'المحادثة غير موجودة أو لا تملك صلاحية عرضها (المراسلات مفصولة حسب المؤسسة والفرع).',
      'MRS_NOT_FOUND:message': 'الرسالة غير موجودة أو لا تملك صلاحية عرضها.',
      'MRS_NOT_FOUND:reply': 'الرد غير موجود أو لا تملك صلاحية عرضه.',
      'MRS_NOT_FOUND:contact': 'جهة الاتصال غير موجودة في دليل مؤسستك.',
      'MRS_NOT_FOUND:channel': 'القناة غير موجودة أو لا تخص مؤسستك.',
      'MRS_NOT_FOUND:document': 'المستند غير موجود أو لا تملك صلاحية عرضه.',
      'MRS_INVALID:recipient': 'المستلم ليس عنوانًا نشطًا في دليل جهات الاتصال ولا مشاركًا في المحادثة. أضفه إلى الدليل أولًا.',
      'MRS_REQUIRED:recipient': 'حدّد مستلمًا واحدًا على الأقل للرد.',
      'MRS_INVALID:address': 'العنوان أو الرقم غير صحيح (بريد إلكتروني، أو رقم جوال دولي مثل ‎+9665XXXXXXXX).',
      'MRS_INVALID:owner': 'المسؤول المختار لا يملك صلاحية المتابعة في فرع المحادثة.',
      'MRS_INVALID:document': 'المستند لا يخص المعاملة المربوطة بالمحادثة أو أنه ملغى.',
      'MRS_INVALID:extraction': 'القيمة لا تطابق صيغة هذا النوع من المراجع.',
      'MRS_REQUIRED:transaction': 'اربط المحادثة بمعاملة أولًا.',
      'MRS_REQUIRED:body': 'اكتب نص الرد.',
      // document matching (20261116000100)
      'MRS_NOT_FOUND:document_match': 'المطابقة غير موجودة أو لا تملك صلاحية عرضها.',
      'MRS_NOT_FOUND:invoice_extraction_id': 'قراءة الفاتورة التجارية غير موجودة أو لا تملك صلاحية عرضها.',
      'MRS_NOT_FOUND:bl_extraction_id': 'قراءة بوليصة الشحن غير موجودة أو لا تملك صلاحية عرضها.',
      'MRS_NOT_FOUND:declaration_extraction_id': 'قراءة البيان الجمركي غير موجودة أو لا تملك صلاحية عرضها.',
      'MRS_INVALID:overall': 'النتيجة العامة لا تتفق مع نتائج الحقول (اختلاف في حقل أساسي يعني «يوجد اختلاف»). أعد المطابقة ثم احفظ.',
      'MRS_INVALID:transaction_id': 'المستندات المقروءة مرتبطة بمعاملة أخرى. اختر المعاملة نفسها أو احفظ بدون معاملة.',
      'MRS_REQUIRED:reviewed_rows': 'علّم حقلًا واحدًا على الأقل بأنه «تمت مراجعته» قبل اعتماد المراجعة.',
      // legacy step 2 (20261118000100)
      'MRS_DUPLICATE_TX:container': 'توجد معاملة مسجلة مسبقًا بنفس رقم البوليصة وإحدى الحاويات.',
      'MRS_DUPLICATE_TX:chassis': 'توجد معاملة Ro-Ro مسجلة مسبقًا بنفس رقم البوليصة ورقم الشاسيه.',
      'MRS_BAD_TRANSITION:cancelled': 'هذا السجل ملغى ولا يقبل التعديل.',
      'MRS_BAD_TRANSITION:delivered': 'تم النقل لهذه الحركة؛ لا تُعدَّل بياناتها التشغيلية ولا تُلغى.',
      'MRS_FORBIDDEN:cost': 'قيمة النقل وعائد المؤسسة متاحان لصلاحيات المالية ومدير العمليات فقط.',
      'MRS_BAD_TRANSITION:same_status': 'المعاملة في هذه المرحلة بالفعل (ربما تقدّمت تلقائيًا). حدّث الصفحة.',
      // legacy step 3 (20261119000100)
      'MRS_NOT_FOUND:doc_batch': 'حزمة المستندات غير موجودة أو لا تملك صلاحية عرضها (المسودات مفصولة حسب الفرع).',
      'MRS_NOT_FOUND:extraction': 'المستند المقروء غير موجود أو لا تملك صلاحية عرضه.',
      'MRS_INVALID:slot_full': 'الخانة ممتلئة: بوليصة واحدة وبيان جمركي واحد، وحتى 10 فواتير و10 بيانات تعبئة.',
      'MRS_INVALID:duplicate_file': 'الملف نفسه مضاف إلى هذه الحزمة من قبل.',
      'MRS_INVALID:containers_roro': 'معاملة Ro-Ro لا تقبل حاويات. احذف الحاويات من المسودة أو اختر معاملة حاويات.',
      'MRS_REQUIRED:documents': 'أضف مستندًا مقروءًا واحدًا على الأقل إلى الحزمة قبل الاعتماد.',
      'MRS_REQUIRED:draft': 'احفظ المسودة بعد مراجعتها قبل الاعتماد.',
      'MRS_REQUIRED:client_id': 'اختر العميل (المستورد) قبل إنشاء معاملة جديدة من المسودة.',
      'MRS_REQUIRED:branch_id': 'اختر الفرع الذي تتبع له حزمة المستندات.'
    },
    banner: {
      staging: 'بيئة تجريبية (Staging) — البيانات للاختبار فقط'
    },
    // G7: the {f} of MRS_PLAN_LIMIT (metric key) / MRS_PLAN_INACTIVE (status detail); English: err.plan_metric_<key> / err.plan_inactive_<detail>
    planLabels: {
      metric_users: 'عدد المستخدمين', metric_branches: 'عدد الفروع', metric_transactions_month: 'المعاملات في الشهر',
      metric_storage_mb: 'مساحة التخزين', metric_storage_bytes: 'مساحة التخزين', metric_messages_month: 'الرسائل في الشهر',
      metric_ai_runs_month: 'عمليات المعالجة الآلية في الشهر',
      inactive_trial_expired: 'انتهت الفترة التجريبية', inactive_suspended: 'الاشتراك موقوف', inactive_cancelled: 'الاشتراك ملغى'
    }
  };

  // G4 English strings (the shared 'err' / 'field' namespaces of i18n.js; Arabic stays in AR above)
  (function () {
    var I = window.MarsaI18n;
    if (!I || typeof I.register !== 'function') return;
    try {
      I.register('err', { en: {
        MRS_OVER_ALLOCATED: 'The allocations exceed the line net; an allocation never doubles the invoice (remaining: {f}).',
        MRS_OVERPAID: 'The amount exceeds what remains of the total (remaining: {f}).',
        MRS_EXPORT: 'The export file could not be created. Try again.',
        // MFA (docs/online/MFA_SPEC.md §6)
        MRS_MFA_REQUIRED: 'This action requires two-step verification. Complete it and try again.',
        MFA_INVALID_CODE: 'The code is wrong or expired. Enter the current code from the app.',
        MFA_AAL2_REQUIRED: 'Enter a verification code first.',
        // G7 subscriptions & plan limits
        MRS_PLAN_LIMIT: 'Your organization reached its plan limit ({f}). Nothing was saved. Contact the platform team to upgrade.',
        MRS_PLAN_INACTIVE: 'The organization\'s subscription is not active ({f}). You can view data but cannot create new records.',
        // AI document reading (20261114000100)
        MRS_AI_DISABLED: 'AI reading is not enabled for this organization. An organization admin enables it under “Organization” in the staff dashboard.',
        MRS_AI_DAILY_CAP: 'The organization reached today\'s AI reading limit. Try tomorrow or ask an organization admin to raise it.',
        MRS_AI_BUDGET: 'AI reading reached this month\'s budget. Ask an organization admin to raise it.',
        MRS_AI_REFUSED: 'The AI model declined to read this document. Use in-browser reading (Tesseract) instead.',
        MRS_AI_TRUNCATED: 'The document is too long to read in one request. Split the PDF or upload the important pages only.',
        MRS_AI_TOO_LARGE: 'The file is over the AI reading limit: 5 MB for an image, 10 MB for a PDF.',
        MRS_AI_UNSUPPORTED: 'This file type is not supported for AI reading. Use JPG, PNG, WEBP, GIF or PDF.',
        MRS_AI_UNAVAILABLE: 'The AI reading service is not available right now. Try later or use in-browser reading.',
        MRS_AI_FAILED: 'AI reading failed. Try again or use in-browser reading.',
        // document matching (20261116000100)
        MRS_MATCH_DOC_KIND: 'The document saved as “{f}” is not of the expected type (commercial invoice, bill of lading, customs declaration). Check the document type and read it again.',
        MRS_MATCH_DOC_VOIDED: 'The “{f}” reading is void, so the match cannot be saved on it. Read the document again, then save.',
        MRS_MATCH_VOIDED: 'This match is void and cannot be reviewed or changed.',
        'cdetail_MRS_NOT_FOUND_document_match': 'The match does not exist or you may not view it.',
        'cdetail_MRS_NOT_FOUND_invoice_extraction_id': 'The commercial invoice reading does not exist or you may not view it.',
        'cdetail_MRS_NOT_FOUND_bl_extraction_id': 'The bill of lading reading does not exist or you may not view it.',
        'cdetail_MRS_NOT_FOUND_declaration_extraction_id': 'The customs declaration reading does not exist or you may not view it.',
        'cdetail_MRS_INVALID_overall': 'The overall result contradicts the field results (a difference in a key field means “differences found”). Match again, then save.',
        'cdetail_MRS_INVALID_transaction_id': 'The documents read are linked to another transaction. Choose that transaction or save without one.',
        'cdetail_MRS_REQUIRED_reviewed_rows': 'Tick at least one field as “reviewed” before approving the review.',
        plan_metric_users: 'users', plan_metric_branches: 'branches', plan_metric_transactions_month: 'transactions per month',
        plan_metric_storage_mb: 'storage', plan_metric_storage_bytes: 'storage', plan_metric_messages_month: 'messages per month',
        plan_metric_ai_runs_month: 'automated-processing runs per month',
        plan_inactive_trial_expired: 'trial period ended', plan_inactive_suspended: 'subscription suspended', plan_inactive_cancelled: 'subscription cancelled',
        'cdetail_MRS_BAD_TRANSITION_subscription_suspended': 'The subscription is suspended: reactivate it from subscription management.',
        'cdetail_MRS_BAD_TRANSITION_use_suspend': 'To suspend or cancel a subscription use "Suspend" instead of changing the plan.',
        'cdetail_MRS_BAD_TRANSITION_org_suspended': 'The organization\'s subscription is suspended or cancelled: reactivate it first, then change the plan.',
        'cdetail_MRS_BAD_TRANSITION_pilot_required': 'The "pilot" plan cannot be deactivated; it is the default plan for organizations.',
        'cdetail_MRS_INVALID_plan_inactive': 'The selected plan is not active. Activate it under "Plans" or choose another plan.',
        'cdetail_MRS_INVALID_period': 'Invalid subscription period: the end date must not be before the start, and it is required for a trial.',
        'cdetail_MRS_INVALID_limit_overrides': 'Invalid custom limits (non-negative whole numbers only).',
        'cdetail_MRS_INVALID_months': 'Invalid number of months (1 to 24).',
        'cdetail_MRS_NOT_FOUND_plan': 'The plan does not exist.',
        detail_search_query_short: 'Type at least 2 characters to search.',
        detail_date_range: 'Invalid date range: "from" must not be after "to", and the range is at most three years (1096 days).',
        detail_export_rows: 'Too many rows to export (Excel / CSV up to 10,000 rows, print up to 2,000). Narrow the filters.',
        detail_totals_mismatch: 'The data changed during the export; try again.',
        detail_data_changed: 'The data changed during the export; try again.',
        detail_too_many_rows: 'Too many rows to export. Narrow the filters.',
        detail_audit_failed: 'The export could not be recorded in the log, so no file was created. Try again.',
        detail_no_rows: 'There are no rows to export for these filters.',
        detail_invoice_number_taken: 'This invoice number is already registered for this supplier (after normalization). Open the existing invoice instead of entering it again.',
        detail_file_duplicate: 'This file is already registered as a finance document. Open the existing record instead of uploading it again.',
        detail_duplicate_ref: 'A matching record already exists (duplicate number or file). Open it instead of creating a copy.',
        detail_self_approval: 'You cannot approve a record you created yourself (four-eyes rule). Another approver must do it.',
        detail_paid_by_client: 'The client paid this cost to the supplier directly, so it cannot be charged to the client as a disbursement again.',
        detail_charged_to_client: 'This cost is already charged to the client as a disbursement. Void that charge before recording a direct client payment.',
        detail_g5_only: 'The "invoiced" status is set by billing (the next stage) only.',
        detail_lines_pending_review: 'The invoice cannot be approved while lines are pending review or disputed.',
        detail_lines_unallocated: 'The invoice cannot be approved before every accepted line is fully allocated with approved allocations ({x}).',
        detail_original_file: 'Attach the original invoice file before approving it.',
        detail_late_cost: 'This is a late cost on a transaction in billing or closed; give a reason for the approval.',
        detail_discrepancy: 'The invoice header totals do not match the sum of the lines; add a note explaining the difference before approving.',
        detail_party_finance: 'Party finance data (bank, IBAN, payment terms, currency) is saved from "Finance data" only.',
        detail_finance: 'These finance figures are available to finance roles only.',
        detail_invoice_locked: 'The invoice is approved or void and cannot be edited. Mark it disputed first.',
        detail_invoice_approved: 'An allocation on an approved invoice cannot be reversed. Mark the invoice disputed first.',
        detail_has_payments: 'The invoice has recorded payments; void them first.',
        detail_has_approved_allocations: 'The invoice has approved allocations; reverse them first.',
        detail_in_use: 'This document is the original of an active invoice and cannot be voided.',
        detail_allocated: 'The line is allocated to transactions; reverse or reject its allocations before editing it.',
        detail_cost_charged: 'This cost (or its linked expected cost) is already charged to the client; it is never charged twice.',
        detail_trip_charged: 'This transport trip is already charged to the client (by its price or its cost); it is never charged twice.',
        detail_credit_exceeds_invoice: 'The credit note is larger than what is left of the original invoice after earlier notes (remaining: {x}).',
        detail_credit_target: 'A credit-note line only reduces a transaction that carries the original invoice cost, never below zero (remaining: {x}).',
        detail_credit_note_link: 'A credit note is not matched to a trip, storage case or expected cost; allocate it to the transaction only.',
        detail_credit_allocated: 'A credit note reduces this transaction; reverse the credit allocation first.',
        detail_currency_in_use: 'The case currency cannot change while allocations or charges are linked to it.',
        detail_no_accrual: '"No match" cannot be combined with a trip or storage case.',
        // G5 billing & Daftra
        detail_service_only: 'This action belongs to the server-side sync worker and cannot be called from a staff account.',
        detail_not_connected: 'The Daftra connection is not ready (not connected or sync disabled). Check the connection in "Daftra settings" first.',
        detail_capability: 'The Daftra capabilities needed to push are not proven on this account ({x}). Re-run the capability check in "Daftra settings".',
        detail_intent_issued: 'The invoice is issued in Daftra and frozen; Marsa never edits it. Later charges go to a supplementary invoice.',
        detail_in_invoice: 'This charge is on an invoice line; remove it from the invoice before changing its status.',
        detail_sync_in_flight: 'A Daftra sync is running or its result is still unknown; wait for reconciliation and try again.',
        detail_conflict_open: 'There is an open conflict with Daftra (the draft was edited there); resolve it first.',
        detail_remote_draft_exists: 'A draft of this invoice exists in Daftra; the intent cannot be cancelled directly.',
        detail_no_issued_final: 'A supplementary invoice needs an issued final invoice for the same transaction and currency.',
        detail_final_issued: 'The final invoice is issued; no interim invoice after it. Use a supplementary invoice.',
        detail_intent_taken: 'A billing intent already exists for this transaction, currency and purpose. Open it instead of creating a second one.',
        detail_external_id_taken: 'This Daftra client is linked to another Marsa client; one Daftra client never maps to two.',
        detail_not_eligible: 'A charge is not eligible for billing (not approved, another currency, already on an invoice, or another transaction).',
        detail_tax_rate_unmapped: 'Some lines have a VAT rate that is not allowed in the Daftra settings ({x}).',
        detail_client_review: 'The Daftra client link needs review (several possible clients were found). Choose the right one in "Daftra settings".',
        detail_item_review: 'Some items need review in Daftra (a product with the same name and another code). Map them manually in "Daftra settings".',
        detail_client_in_use: 'The client cannot be unlinked while it has an invoice in Daftra.',
        detail_mock_version: 'The mock account changed while saving; try again.',
        detail_link_exists: 'This client is already linked to Daftra; open the existing link instead of creating a second one.',
        detail_no_conflict: 'There is no open conflict on this invoice; refresh the page.',
        detail_conflict_reason: 'This decision does not fit the conflict type ({x}).',
        detail_unlinked: 'The client link is unlinked; link the client again in "Daftra settings".',
        detail_unreconciled_remote: 'The invoice create may have reached Daftra without confirmation; retry the sync so it is reconciled by reference before cancelling or removing.',
        detail_subdomain_taken: 'This Daftra account is linked to another organisation; each organisation has its own Daftra account.',
        // G6b messaging
        detail_recipient_not_authorized: 'The recipient is not verified or not authorized for this document. A document is attached only for a verified address holding a valid authorization that covers its kind.',
        detail_sensitive_ack: 'The reply carries a sensitive document: acknowledge its sensitivity and write a note before approving.',
        detail_address_taken: 'This address or number is already in use (a registered channel or another active contact).',
        detail_reply_exists: 'This conversation already has a live reply (draft, pending approval or sending); open it instead of starting a second one.',
        detail_span: 'The position of the extracted text does not match the original message text.',
        detail_placeholder: 'The template uses a placeholder that is not allowed. Use only the placeholders in the list.',
        detail_provider_terms: 'First record that the account is the organisation\'s own official account under the provider\'s terms before enabling receiving or sending.',
        detail_not_approved: 'A reply cannot be sent before it is approved.',
        detail_approval_stale: 'The text changed after approval — a new approval is required.',
        detail_four_eyes: 'The author of a reply (or the user who submitted it) cannot approve it. Another approver must do it.',
        detail_already_sent: 'This reply was already sent; it is never sent twice.',
        detail_send_unknown: 'The result of an earlier send is unknown; nothing is re-sent until it is settled by reconciliation or by a manager decision.',
        detail_not_retryable: 'This attempt cannot be retried: the provider may have received it, or the error is final.',
        detail_wa_window_closed: 'The WhatsApp 24-hour window since the last message from this number has closed; a free-form reply cannot be sent.',
        detail_channel_not_connected: 'The channel is not connected. Check it in "Channels & settings" first.',
        detail_channel_disabled: 'Sending is disabled on this channel.',
        detail_auto_reply_disabled_v1: 'Automatic replies are not enabled in the first release.',
        detail_reply_locked: 'The reply is being sent or was sent; it cannot be edited.',
        detail_not_draft: 'This action is available for drafts only.',
        detail_ai_budget: 'The month\'s estimated automated-processing cost would exceed the set budget.',
        detail_not_configured: 'The real account is not configured in this environment (mock mode only).',
        detail_attachment_not_stored: 'The attachment is not stored yet (in mock mode only its metadata is kept), so it cannot be downloaded.',
        'cdetail_MRS_NOT_FOUND_thread': 'The conversation does not exist or you may not view it (messaging is separated by organisation and branch).',
        'cdetail_MRS_NOT_FOUND_message': 'The message does not exist or you may not view it.',
        'cdetail_MRS_NOT_FOUND_reply': 'The reply does not exist or you may not view it.',
        'cdetail_MRS_NOT_FOUND_contact': 'The contact is not in your organisation\'s directory.',
        'cdetail_MRS_NOT_FOUND_channel': 'The channel does not exist or does not belong to your organisation.',
        'cdetail_MRS_NOT_FOUND_document': 'The document does not exist or you may not view it.',
        'cdetail_MRS_INVALID_recipient': 'The recipient is neither an active address in the contacts directory nor a participant of the conversation. Add it to the directory first.',
        'cdetail_MRS_REQUIRED_recipient': 'Choose at least one recipient for the reply.',
        'cdetail_MRS_INVALID_address': 'Invalid address or number (an e-mail address, or an international mobile number such as +9665XXXXXXXX).',
        'cdetail_MRS_INVALID_owner': 'The chosen owner has no follow-up access at the conversation\'s branch.',
        'cdetail_MRS_INVALID_document': 'The document does not belong to the transaction linked to the conversation, or it is void.',
        'cdetail_MRS_INVALID_extraction': 'The value does not match the format of this reference kind.',
        'cdetail_MRS_REQUIRED_transaction': 'Link the conversation to a transaction first.',
        'cdetail_MRS_REQUIRED_body': 'Write the reply text.'
      } });
      I.register('field', { en: {
        // document matching (20261116000100)
        invoice_extraction_id: 'Commercial invoice', bl_extraction_id: 'Bill of lading', declaration_extraction_id: 'Customs declaration',
        reviewed_rows: 'Reviewed fields', engine_version: 'Match version', overall: 'Overall result', counts: 'Result counts',
        rows: 'Match fields', document_match: 'Match',
        supplier_id: 'Supplier', invoice_number: 'Invoice number', invoice_date: 'Invoice date', due_date: 'Due date',
        subtotal: 'Subtotal (excl. VAT)', vat_amount: 'VAT amount', total_amount: 'Total', net_amount: 'Net', vat_rate: 'VAT rate',
        quantity: 'Quantity', unit_price: 'Unit price', description: 'Description', service_code: 'Service', line_id: 'Line', lines: 'Invoice lines',
        supplier_invoice_id: 'Supplier invoice', finance_document_id: 'Finance document', adjusts_invoice_id: 'Original invoice of the note',
        supplier_vat_number: 'Supplier VAT number', amount: 'Amount', share_pct: 'Allocation share', trip_id: 'Trip', accrual_id: 'Expected cost',
        demurrage_case_id: 'Storage / demurrage case', cost_allocation_id: 'Cost allocation', charge_id: 'Client charge',
        markup_pct: 'Markup %', paid_at: 'Payment date', collected_at: 'Collection date', method: 'Payment method', payer: 'Payer',
        operator_id: 'Operator', exception_id: 'Operational exception', free_until: 'Free time ends', charged_until: 'Charged until',
        estimated_amount: 'Estimated amount', related_invoice_id: 'Original invoice', iban_last4: 'IBAN last 4 digits', bank_name: 'Bank',
        payment_terms_days: 'Payment terms (days)', default_currency: 'Default currency', group_by: 'Group by', size_bytes: 'File size',
        storage_path: 'File path', decision: 'Decision', basis: 'Estimate basis', line_excluded: 'Excluded line', line_overhead: 'Overhead line',
        line_pending_review: 'Line pending review', line_disputed: 'Disputed line', share_total: 'Share total (over 100%)',
        // G5
        purpose: 'Billing purpose', item_key: 'Item', external_id: 'Daftra client id', external_product_id: 'Daftra product id',
        subdomain: 'Daftra subdomain', mode: 'Connection mode', allowed_vat_rates: 'Allowed VAT rates',
        default_service_vat_rate: 'Service VAT rate', reimbursable_tax_code: 'Reimbursable tax code', tax_code: 'Tax code',
        invoice_notes: 'Invoice notes', intent_id: 'Billing intent', charge_ids: 'Charges', link_id: 'Client link', job_id: 'Sync job',
        name_ar: 'Arabic name', name_en: 'English name', default_vat_rate: 'Default VAT rate',
        intent: 'Billing intent', external_invoice_id: 'Daftra invoice id',
        // G6a
        q: 'Search text', date_field: 'Date type', sort: 'Sort order', return_status: 'Container return status', trip_status: 'Trip status',
        report: 'Report type', format: 'Export format',
        // G6b
        thread: 'Conversation', reply: 'Reply', contact: 'Contact', channel: 'Channel', channel_id: 'Channel', channel_kind: 'Channel kind',
        recipient: 'Recipient', owner: 'Owner', owner_id: 'Owner', category: 'Category', template_key: 'Template', extraction: 'Extracted reference',
        body_text: 'Message text', lang: 'Language', address: 'Address or number', display_name: 'Contact name', entity_type: 'Entity type',
        party_id: 'Party', role_label: 'Role at the party', verification_method: 'Verification method', scope_type: 'Authorization scope',
        may_receive_kinds: 'Documents it may receive', may_discuss: 'Topics it may discuss', valid_from: 'Valid from', valid_until: 'Valid until',
        due_at: 'Follow-up date', priority: 'Priority', match_status: 'Link status', ai_provider: 'Automated-processing provider',
        ai_monthly_budget_usd: 'Monthly automated-processing budget', retention_days: 'Retention (days)', violation_repeat_days: 'Repeated-violation window (days)',
        default_lang: 'Default language', signature_ar: 'Arabic signature', signature_en: 'English signature', instruction_key: 'Instruction key',
        params: 'Instruction settings', placeholders: 'Template placeholders', party_kinds: 'Party kinds', operation: 'Operation',
        subject_tpl: 'Subject template', body_tpl: 'Body template', conditions: 'Conditions', allowed_categories: 'Allowed categories',
        provider_terms_ack: 'Provider terms acknowledgement', ingest_enabled: 'Receiving', send_enabled: 'Sending', default_branch_id: 'Default branch',
        box: 'Box', document_ids: 'Reply attachments', version_id: 'Reply version', outbound_id: 'Send', summary_id: 'Summary',
        message_id: 'Message', reply_to_message_id: 'Message replied to', signed_url: 'Download link'
      } });
    } catch (e) { /* Arabic messages stay */ }
  })();

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
  // G7: MRS_PLAN_LIMIT detail = metric key, MRS_PLAN_INACTIVE detail = trial_expired | suspended | cancelled
  var PLAN_CODES = { MRS_PLAN_LIMIT: 'metric_', MRS_PLAN_INACTIVE: 'inactive_' };
  function planLabel(code, f) {
    if (!f) return '';
    var k = PLAN_CODES[code] + f;
    if (!Object.prototype.hasOwnProperty.call(AR.planLabels, k)) return '';   // unknown detail: no raw key in the message
    return i18nStr('err.plan_' + k) || AR.planLabels[k];
  }
  function mkErr(code, field, raw, extra) {
    var tpl = null;
    // G6b: a detail word with its own message under this code only (MRS_NOT_FOUND 'thread', MRS_INVALID 'recipient', …)
    if (field && Object.prototype.hasOwnProperty.call(AR.codeDetails, code + ':' + field)) tpl = i18nStr('err.cdetail_' + code + '_' + field) || AR.codeDetails[code + ':' + field];
    // G4: a detail code with its own message ({x} = the extra part, e.g. line numbers)
    if (!tpl && field && Object.prototype.hasOwnProperty.call(AR.details, field)) tpl = i18nStr('err.detail_' + field) || AR.details[field];
    if (!tpl) tpl = i18nStr('err.' + code) || AR.errors[code] || i18nStr('err.UNKNOWN') || AR.errors.UNKNOWN;
    var msg = (PLAN_CODES[code] ? String(tpl).replace(/\{f\}|\{field\}/g, planLabel(code, field)) : fmt(tpl, field))
      .replace(/\{x\}/g, extra == null ? '' : String(extra)).replace(/\s*\(\)/g, '');
    return { code: code, field: field || null, message: msg, raw: raw || null };
  }
  // G4 details may carry a reference after the code ('invoice_number_taken:<uuid>', 'lines_unallocated:1,3'),
  // a bare id (the existing duplicate) or a number (the remaining amount of MRS_OVER_ALLOCATED / MRS_OVERPAID)
  var UUID_DETAIL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function splitDetail(code, det) {
    var out = { field: det || null, ref: null, extra: null, remaining: null };
    if (!det) return out;
    var m = /^([a-z][a-z0-9_]*)\s*[:=\s]\s*(.+)$/.exec(det);
    if (m && (Object.prototype.hasOwnProperty.call(AR.details, m[1]) || Object.prototype.hasOwnProperty.call(AR.fields, m[1])
        || Object.prototype.hasOwnProperty.call(AR.codeDetails, code + ':' + m[1]))) {
      out.field = m[1];
      var rest = m[2].trim();
      if (UUID_DETAIL.test(rest)) out.ref = rest; else out.extra = rest.replace(/^\{|\}$/g, '');
      return out;
    }
    if (UUID_DETAIL.test(det)) { out.ref = det; out.field = code === 'MRS_INVALID' ? 'duplicate_ref' : null; return out; }
    if ((code === 'MRS_OVER_ALLOCATED' || code === 'MRS_OVERPAID') && /^-?[0-9]+(\.[0-9]+)?$/.test(det)) out.remaining = +det;
    return out;
  }
  function normalizeError(e) {
    if (!e) return mkErr('UNKNOWN');
    if (e.code && /^MRS_/.test(e.code) && e.message && e.raw !== undefined) return e; // already ours
    var msg = String(e.message || e.error_description || e.msg || '');
    var det = e.details != null ? String(e.details) : (e.detail != null ? String(e.detail) : '');
    // G4 puts the existing row id / line numbers / remaining amount in the Postgres HINT (DETAIL keeps the code word)
    var hint = e.hint != null ? String(e.hint).trim() : '';
    if (/^MRS_[A-Z_]+$/.test(msg)) {
      var sd = splitDetail(msg, det);
      if (hint) {
        if (!sd.ref && UUID_DETAIL.test(hint)) sd.ref = hint;
        else if (sd.extra == null && !UUID_DETAIL.test(hint)) sd.extra = hint;
      }
      var out = mkErr(msg, sd.field, e, sd.extra);
      if (sd.ref) out.refId = sd.ref;
      if (sd.extra != null) out.extra = sd.extra;
      // the remaining amount fills the message's {f}; it is not a field name
      if (sd.remaining != null) { out.remaining = sd.remaining; out.field = null; }
      return out;
    }
    var pg = e.code || '';
    if (pg === '23505') return mkErr('DUPLICATE', null, e);
    if (pg === '23503') return mkErr('FK', null, e);
    if (pg === '23514' || pg === '22P02' || pg === '22007' || pg === '22008') return mkErr('CHECK', null, e);
    if (pg === '42501' || /row-level security|permission denied/i.test(msg)) return mkErr('RLS', null, e);
    // GoTrue MFA (TOTP) messages
    if (/invalid totp code|invalid code|mfa_verification_failed|challenge.*expired/i.test(msg) || e.code === 'mfa_verification_failed'
        || e.code === 'mfa_challenge_expired') return mkErr('MFA_INVALID_CODE', null, e);
    if (/aal2 required|AAL2/i.test(msg) || e.code === 'insufficient_aal') return mkErr('MFA_AAL2_REQUIRED', null, e);
    // supabase-js / GoTrue: no usable session any more (expired, revoked, signed out elsewhere) → sign in again
    if (e.name === 'AuthSessionMissingError' || e.code === 'session_not_found' || e.code === 'refresh_token_not_found'
        || /auth session missing|session.*not found|invalid refresh token|refresh token not found/i.test(msg)) return mkErr('MRS_AUTH_REQUIRED', null, e);
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
      s.src = src; s.async = true; s.integrity = SUPABASE_UMD_SRI;
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
      if (v && typeof v === 'object' && !Array.isArray(v) && (v.idempotencyKey !== undefined || v.antispam !== undefined)) {
        v = Object.assign({}, v); delete v.idempotencyKey; delete v.antispam;   // the form signals change on every submit
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

  /* ---- MFA (TOTP, Supabase Auth MFA; docs/online/MFA_SPEC.md §5.1) ----
     Only these wrappers call c.auth.mfa.*; pages use MarsaApi.mfa*. */
  var MFA_QR_RE = /^data:image\/svg\+xml[;,]/;
  // { verified: [factor], unverified: [factor] } — TOTP factors of the signed-in user
  function mfaFactors() {
    return online(function (c) {
      return c.auth.mfa.listFactors().then(function (r) {
        if (r.error) return { data: null, error: r.error };
        var all = (r.data && (r.data.all || r.data.totp)) || [], out = { verified: [], unverified: [] };
        all.forEach(function (f) {
          if (!f || (f.factor_type && f.factor_type !== 'totp')) return;
          (f.status === 'verified' ? out.verified : out.unverified).push(f);
        });
        return { data: out, error: null };
      });
    }, function () { return ok({ verified: [], unverified: [] }); });
  }
  // { current: 'aal1'|'aal2'|null, next: 'aal1'|'aal2'|null }
  function mfaAal() {
    return online(function (c) {
      return c.auth.mfa.getAuthenticatorAssuranceLevel().then(function (r) {
        if (r.error) return { data: null, error: r.error };
        return { data: { current: (r.data && r.data.currentLevel) || null, next: (r.data && r.data.nextLevel) || null }, error: null };
      });
    }, function () { return ok({ current: null, next: null }); });
  }
  // drops stale half-enrollments, then starts a new TOTP enrollment → { factorId, qr (SVG data URI or null), secret }
  function mfaEnroll() {
    return online(function (c) {
      return c.auth.mfa.listFactors().then(function (lr) {
        var stale = ((lr && lr.data && lr.data.all) || []).filter(function (f) { return f && f.status !== 'verified'; });
        return stale.reduce(function (p, f) {
          return p.then(function () { return c.auth.mfa.unenroll({ factorId: f.id }).catch(function () { return null; }); });
        }, Promise.resolve());
      }).then(function () {
        return c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Marsa ' + new Date().toISOString() });
      }).then(function (r) {
        if (r.error) return { data: null, error: r.error };
        var d = r.data || {}, totp = d.totp || {};
        var qr = typeof totp.qr_code === 'string' && MFA_QR_RE.test(totp.qr_code) ? totp.qr_code : null;
        return { data: { factorId: d.id, qr: qr, secret: typeof totp.secret === 'string' ? totp.secret : '' }, error: null };
      });
    });
  }
  function mfaVerify(factorId, code) {
    return online(function (c) {
      return c.auth.mfa.challengeAndVerify({ factorId: factorId, code: String(code || '') }).then(function (r) {
        if (!r.error) { ctxCache = null; ctxPending = null; }
        return r;
      });
    });
  }
  function mfaUnenroll(factorId) {
    return online(function (c) {
      return c.auth.mfa.unenroll({ factorId: factorId }).then(function (r) {
        if (r.error) return r;
        ctxCache = null; ctxPending = null;
        return c.auth.refreshSession().then(function () { return r; }, function () { return r; });
      });
    });
  }
  // pure: the my_context().mfa object; a context without it (migration not applied yet) counts as satisfied
  function mfaState(ctx) {
    var m = ctx && ctx.mfa;
    if (!m || typeof m !== 'object') return { required: false, satisfied: true, enrolled: false, aal: 'aal1', reasons: [] };
    return { required: !!m.required, satisfied: m.satisfied !== false, enrolled: !!m.enrolled,
             aal: m.aal || 'aal1', reasons: Array.isArray(m.reasons) ? m.reasons : [] };
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
  // opts.antispam = formSignals(form): {hp, elapsedMs} → payload.antispam (20261113000100; the server strips it before
  // the idempotency hash, so a retry with the same key still replays)
  function submitServiceRequest(record, opts) {
    var key = (opts && opts.idemKey) || (record && record.idempotencyKey);
    var base = withSignals(toRequestPayload(record), opts);
    return idemRpc('submit_service_request', key, function (k) { return { payload: withKey(base, k) }; },
      function () { return demoSubmitRequest(record); }).then(noteRefusal('submit_service_request'));
  }
  function submitContactMessage(entry, opts) {
    var key = (opts && opts.idemKey) || (entry && entry.idempotencyKey);
    var base = withSignals(toContactPayload(entry), opts);
    return idemRpc('submit_contact_message', key, function (k) { return { payload: withKey(base, k) }; },
      function () { return demoSubmitContact(entry); }).then(noteRefusal('submit_contact_message'));
  }
  /* ---- public anti-spam: decoy field + render time (docs/online/ANTISPAM_AR.md) ----
     armForm(form) once when the form is shown; formSignals(form) at submit → {hp, elapsedMs}.
     The decoy is the form's [data-hp] input (hidden from people and assistive tech; bots fill it). */
  function armForm(form) {
    if (form && form.setAttribute && !form.getAttribute('data-rendered-at')) form.setAttribute('data-rendered-at', String(Date.now()));
    return form;
  }
  function formSignals(form) {
    if (!form || !form.getAttribute) return null;
    // no render time (form not armed): elapsedMs null → the server skips the fill-time check (never a false 0 ms)
    var t0 = +form.getAttribute('data-rendered-at');
    var hp = form.querySelector ? form.querySelector('[data-hp]') : null;
    return { hp: hp ? String(hp.value || '').slice(0, 200) : '',
      elapsedMs: t0 > 0 ? Math.max(0, Math.min(Math.round(Date.now() - t0), 2000000000)) : null };
  }
  function withSignals(payload, opts) {
    var a = opts && opts.antispam;
    if (!a || typeof a !== 'object' || !payload || typeof payload !== 'object') return payload;
    var ms = a.elapsedMs == null || !isFinite(+a.elapsedMs) ? null : Math.max(0, Math.min(Math.round(+a.elapsedMs), 2000000000));
    return Object.assign({}, payload, { antispam: { hp: String(a.hp == null ? '' : a.hp).slice(0, 200), elapsedMs: ms } });
  }
  // a refusal is counted for monitoring through the error beacon (code only, no form data; deduped, capped per page)
  function noteRefusal(name) {
    return function (r) {
      if (r && r.error && r.error.code === 'MRS_RATE_LIMITED') reportError('MRS_RATE_LIMITED', 'public refusal: ' + name + (r.error.field ? ' ' + r.error.field : ''));
      return r;
    };
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
    return rpc('public_track', { p_ref: String(ref || '').trim(), p_token: String(token || '').trim() }, function () { return demoTrack(ref); })
      .then(trackMiss).then(noteRefusal('public_track'));
  }
  // 20261113000100: a miss is the value {not_found: true} (so the server counts failed guesses) → the same
  // MRS_NOT_FOUND error the pages already show
  function trackMiss(r) {
    if (r && !r.error && r.data && r.data.not_found === true) return fail('MRS_NOT_FOUND');
    return r;
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

  /* ------------------------------------------------------------------
     G7 plans, subscriptions & usage (docs/online/G7_SPEC.md §RPC list) — counts only, never tenant rows.
     The limits are enforced by the server (MRS_PLAN_LIMIT / MRS_PLAN_INACTIVE); the UI only shows usage.
     ------------------------------------------------------------------ */
  // → [{code, name_ar, name_en, sort, is_active, limits{users, branches, transactions_month, storage_mb, messages_month, ai_runs_month}, price_monthly_sar, notes, orgs}]
  function platformListPlans() { return rpc('platform_list_plans'); }
  // payload = {name_ar, name_en?, sort?, is_active?, limits:{…six keys, null = unlimited}, price_monthly_sar?, notes?}; code immutable once created
  function platformSavePlan(code, payload) { return rpc('platform_save_plan', { p_code: code, p_payload: payload || {} }); }
  // → [{org_id, slug, name_ar, name_en, is_active, plan_code, plan_name_ar, plan_name_en, status, period_start, period_end,
  //     limit_overrides, limits, usage, over_limit[], status_reason, suspended_at, updated_at}]
  function platformListSubscriptions() { return rpc('platform_list_subscriptions'); }
  // payload = {plan_code, status: 'trial'|'active', period_start, period_end?, limit_overrides?, reason} → {subscription, usage, over_limit[]}
  // idempotent (p_idem_key): the same key is re-sent on a network error / timeout
  function platformSetOrgPlan(orgId, payload, idemKey) {
    return idemRpc('platform_set_org_plan', idemKey, function (k) { return { p_org: orgId, p_payload: payload || {}, p_idem_key: k }; });
  }
  // status → suspended (or cancelled with cancel=true) + organizations.is_active=false; already so → {unchanged:true}
  function platformSuspendOrg(orgId, reason, cancel) { return rpc('platform_suspend_org', { p_org: orgId, p_reason: reason, p_cancel: !!cancel }); }
  // status → active + organizations.is_active=true; already active → {unchanged:true}
  function platformActivateOrg(orgId, reason) { return rpc('platform_activate_org', { p_org: orgId, p_reason: reason }); }
  // → {org_id, limits, current, history:[{period_start, transactions_month, messages_month, ai_runs_month}], storage_mb, events:[…]}
  function platformOrgUsage(orgId, months) {
    var args = { p_org: orgId };
    if (months != null) args.p_months = months;
    return rpc('platform_org_usage', args);
  }
  function platformRecountUsage(orgId) { return rpc('platform_recount_usage', { p_org: orgId }); }
  // org admin of p_org: {plan_code, plan_name_ar, plan_name_en, status, period_start, period_end, limits, usage, over_limit[]} (no price)
  function orgSubscription(orgId) { return rpc('org_subscription', { p_org: orgId }); }

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
    'package_count,eta,responsible_user_id,operational_status,status_changed_at,created_at,updated_at,' +
    // legacy step 1 (20261117000100) columns (declaration_notes, cancel_reason, cancelled_by: withInternal(), staff only)
    'port_code,terminal_party_id,cargo_unit_type,chassis_no,vehicle_plate_no,transaction_type,transport_mode,transport_party_id,' +
    'transport_order_no,transport_order_date,cancelled_at';   // notes, financial_status: withInternal() (G5 column grant)
  function listTransactions(o) {
    o = o || {};
    return online(function (c) {
      var q = c.from('transactions').select(TX_COLS + ',clients(name_ar),branches(code,name_ar)', { count: 'exact' })
        .order('created_at', { ascending: false });
      if (o.orgId) q = q.eq('org_id', o.orgId);
      if (o.status) q = q.eq('operational_status', o.status);
      if (o.branchId) q = q.eq('branch_id', o.branchId);
      if (o.clientId) q = q.eq('client_id', o.clientId);
      // legacy tx (20261118000100): o.cancelled = 'only' (ملغاة) | 'exclude' (live only) | absent (all);
      // o.transactionType (normal | re_export), o.cargoUnitType (container | roro), o.portCode
      if (o.cancelled === 'only') q = q.not('cancelled_at', 'is', null);
      else if (o.cancelled === 'exclude') q = q.is('cancelled_at', null);
      if (o.transactionType) q = q.eq('transaction_type', o.transactionType);
      if (o.cargoUnitType) q = q.eq('cargo_unit_type', o.cargoUnitType);
      if (o.portCode) q = q.eq('port_code', o.portCode);
      if (o.search) { var s = likeSafe(o.search); if (s) q = q.or('ref.ilike.%' + s + '%,bl_number.ilike.%' + s + '%,declaration_no.ilike.%' + s + '%,chassis_no.ilike.%' + s + '%'); }
      return range(q, o);
    }).then(function (r) { return withInternal('transactions', r); }).then(function (r) {
      // financial_status is not API-selectable since G5 (clients must not read it): filtered on the merged staff field
      if (!o.financialStatus || !r || r.error || !Array.isArray(r.data)) return r;
      var kept = r.data.filter(function (x) { return x && x.financial_status === o.financialStatus; });
      return Object.assign({}, r, { data: kept, count: kept.length });
    });
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
  /* legacy step 2 (20261118000100, docs/online/LEGACY_TX_AR.md) */
  // void-only cancel (20261117000100) with the reason (≤ 500) → {transaction_id, ref, from, to:'closed', cancelled_at, event_id, declarations_cancelled}
  function cancelTransaction(id, reason) { return rpc('cancel_transaction', { p_tx: id, p_reason: reason == null ? null : String(reason) }); }
  // form pre-check. o = { orgId?, transactionId?, blNumber, cargoUnitType? ('container' | 'roro'), chassisNo?, containers?: [text] }
  // → { duplicates: [{kind:'container'|'chassis', unit, transaction_id|null, ref|null, branch_id|null, other_branch}],
  //     container_elsewhere: [{container_no, transaction_id, ref, operational_status}] }   (duplicates block, the rest warns)
  function checkTxDuplicates(o) {
    o = o || {};
    var p = { bl_number: o.blNumber || null, cargo_unit_type: o.cargoUnitType || 'container', chassis_no: o.chassisNo || null,
      containers: Array.isArray(o.containers) ? o.containers : [] };
    if (o.transactionId) p.transaction_id = o.transactionId;
    return inActiveOrg(o.orgId, function (oid) { return rpc('check_tx_duplicates', { p_org: oid, p_payload: p }); });
  }
  // the stepper → {transaction_id, ref, operational_status, cancelled, cancelled_at, cargo_unit_type, …, stages:[{code, sort,
  //   label_ar, label_en, state:'done'|'current'|'todo', reached_at, auto, cause}], next:{code, manual, containers_not_returned,
  //   docs_missing:[kind]}|null, pending_containers:[container_no], follow_up_required}
  function txLifecycle(id) { return rpc('tx_lifecycle', { p_tx: id }); }
  // combined movement (appointment + trip + return plan; legacy saveMovement). p = { transaction_id, appointment_id?|trip_id?,
  //   container_id, appointment_at, appointment_no, terminal_party_id, window_minutes, appointment_status, driver_id | driver_name +
  //   driver_phone, truck_id | truck_plate, carrier_id, origin, destination, notes, cost_amount, sell_amount (finance roles),
  //   movement_status 'registered'|'delivered'|'cancelled', delivered_at, return_deadline, return_location, return_yard_party_id,
  //   reason, idempotent } → { movement, is_new, already_exists, transaction, lifecycle_status, pending_containers,
  //   follow_up_required, driver_id, driver_created, truck_id, truck_created }
  function saveMovement(p, opts) {
    opts = opts || {};
    return idemRpc('save_movement', opts.idemKey, function (k) { return { p_payload: withKey(p, null), p_idem_key: k }; });
  }
  function listMovements(txId) { return rpc('list_movements', { p_tx: txId }); }
  // typeahead: q ≥ 2 chars (name or phone digits); '' = recent → [{driver_id, full_name, phone, carrier_id, last_truck_id, last_truck_plate}]
  function driverDirectory(q, o) {
    o = o || {};
    return inActiveOrg(o.orgId, function (oid) { return rpc('driver_directory', { p_org: oid, p_q: q == null ? null : String(q) }); });
  }
  // terminal operators for a port (mapped first; operators mapped to no port are included) → [{party_id, name_ar, name_en, mapped}]
  function portOperators(portCode, o) {
    o = o || {};
    return inActiveOrg(o.orgId, function (oid) { return rpc('port_operators', { p_org: oid, p_port: portCode || null }); });
  }
  /* legacy step 3 (20261119000100, docs/online/LEGACY_DOCS_AR.md): shipment document batches. Every AI / OCR value stays a
     DRAFT until a staff member approves the batch (approveDocBatch); nothing is approved automatically. */
  // o = { orgId?, transactionId?, branchId?, note?, idempotencyKey? } → batch (full: + draft, comparison, client_match, documents)
  function createDocBatch(o) {
    o = o || {};
    var p = {};
    if (o.transactionId) p.transaction_id = o.transactionId;
    if (o.branchId) p.branch_id = o.branchId;
    if (o.note) p.note = String(o.note);
    return inActiveOrg(o.orgId, function (oid) {
      return idemRpc('create_doc_batch', o.idempotencyKey, function (k) { return { p_org: oid, p_payload: withKey(p, k) }; });
    });
  }
  // slot: bill_of_lading | commercial_invoice | packing_list | customs_declaration → { document {id, slot, seq, extraction_id,
  //   detected_type, created_at}, already_attached, batch (summary) }   (wrong slot: MRS_DOC_WRONG_SLOT '<slot>:<detected>')
  function attachDocBatchDocument(batchId, extractionId, slot) {
    if (!isUuid(batchId)) return Promise.resolve(fail('MRS_REQUIRED', 'doc_batch'));
    if (!isUuid(extractionId)) return Promise.resolve(fail('MRS_REQUIRED', 'extraction_id'));
    return rpc('attach_doc_batch_document', { p_batch: batchId, p_payload: { extraction_id: extractionId, slot: slot } });
  }
  // → { id, detached_at, batch (summary) }
  function detachDocBatchDocument(documentId, reason) {
    return rpc('detach_doc_batch_document', { p_document: documentId, p_reason: reason == null ? null : String(reason) });
  }
  // read-only server merge of the attached readings → { draft, merge_conflicts [{section, field, values [{slot, seq, value}]}],
  //   comparison {engine, matches, conflicts, missing_fields}, version }
  function mergeDocBatch(batchId) { return rpc('merge_doc_batch', { p_batch: batchId }); }
  // o = { version (required: the batch.version read), draft?, clientMatch?, clientId?, note? } → batch (full; version + 1)
  function saveDocBatchDraft(batchId, o) {
    o = o || {};
    if (typeof o.version !== 'number') return Promise.resolve(fail('MRS_REQUIRED', 'version'));
    var p = { version: o.version };
    if (o.draft !== undefined) p.draft = o.draft;
    if (o.clientMatch !== undefined) p.client_match = o.clientMatch;
    if (o.clientId !== undefined) p.client_id = o.clientId || null;
    if (o.note !== undefined) p.note = o.note == null ? null : String(o.note);
    return rpc('save_doc_batch_draft', { p_batch: batchId, p_payload: p });
  }
  function getDocBatch(batchId) { return rpc('get_doc_batch', { p_batch: batchId }); }
  // o = { orgId?, status?: 'draft' (default) | 'approved' | 'discarded' | 'archived' | 'open', transactionId?, limit? (≤ 200) }
  // → [batch summary]
  function listPendingDocBatches(o) {
    o = o || {};
    var f = {};
    if (o.status) f.status = o.status;
    if (o.transactionId) f.transaction_id = o.transactionId;
    if (o.limit != null) f.limit = o.limit;
    return inActiveOrg(o.orgId, function (oid) { return rpc('list_pending_doc_batches', { p_org: oid, p_filter: f }); });
  }
  function discardDocBatch(batchId, reason) { return rpc('discard_doc_batch', { p_batch: batchId, p_reason: reason == null ? null : String(reason) }); }
  function archiveDocBatch(batchId, reason) { return rpc('archive_doc_batch', { p_batch: batchId, p_reason: reason == null ? null : String(reason) }); }
  // o = { version (required), transactionId? | newTransaction? {clientId, operation?, mode?}, shippingAgentId?, confirmClient?,
  //       idemKey? } → { batch_id, status:'approved', transaction_id, ref, created_transaction, client_id, bl {id, bl_number,
  //       created, existing, is_primary} | null, containers {added, updated, unchanged}, invoice_items, packing_items,
  //       extractions_linked, tx_filled, tx_kept, port_code, client_alias {alias_id, status, occurrences, created} | null,
  //       conflicts, missing_fields }
  function approveDocBatch(batchId, o) {
    o = o || {};
    if (typeof o.version !== 'number') return Promise.resolve(fail('MRS_REQUIRED', 'version'));
    var p = { version: o.version };
    if (o.transactionId) p.transaction_id = o.transactionId;
    if (o.newTransaction) {
      p.new_transaction = {};
      if (o.newTransaction.clientId) p.new_transaction.client_id = o.newTransaction.clientId;
      if (o.newTransaction.operation) p.new_transaction.operation = o.newTransaction.operation;
      if (o.newTransaction.mode) p.new_transaction.mode = o.newTransaction.mode;
    }
    if (o.shippingAgentId) p.shipping_agent_id = o.shippingAgentId;
    if (o.confirmClient) p.confirm_client = true;
    return idemRpc('approve_doc_batch', o.idemKey, function (k) { return { p_batch: batchId, p_payload: withKey(p, k) }; });
  }
  // → { transaction_id, shipment_data | null, invoice_items [..], packing_items [..], batches [batch summary] }
  function getTransactionShipment(txId) { return rpc('get_transaction_shipment', { p_tx: txId }); }
  /* legacy step 4 (20261120000100, docs/online/LEGACY_DECL_AR.md): customs declaration reading → staff approval, HS reference.
     Every AI value stays a DRAFT until a staff member approves (approveDeclarationExtraction); nothing is approved
     automatically; the transaction's B/L is never replaced. */
  // → { extraction_id, transaction_id, ref, cargo_unit_type, batch_id | null, review_status, prompt_version, approval | null,
  //     draft {declaration_no, declaration_type, type_evidence, status, status_raw, declaration_date, declaration_date_hijri,
  //       date_printed, date_from_hijri, hijri_supported, importer_name_ar, broker_name, consignee_name, bl_number, bl_candidates,
  //       bl_rtl_affected, vessel, voyage, country_of_origin, port_of_loading, port_of_discharge, invoice_number, invoice_value,
  //       currency, local_value, payment_method, packages_count, package_type, gross_weight, net_weight, goods_description,
  //       containers [{container_number, seal_number?, size_type?, gross_weight?}], items [{hs_code?, description?, quantity?,
  //       unit?, value?, origin_country?, net_weight?, gross_weight?, notes?}]},
  //     comparison {bl {status, transaction_bls, candidates, matched_with, rtl_affected}, containers {matched, new,
  //       not_on_declaration}, declaration {action, existing}, status {read, current, direction}, missing, conflicts, can_approve},
  //     version }
  function getDeclarationReview(extractionId, txId) {
    if (!isUuid(extractionId)) return Promise.resolve(fail('MRS_REQUIRED', 'extraction_id'));
    if (!isUuid(txId)) return Promise.resolve(fail('MRS_REQUIRED', 'transaction_id'));
    return rpc('get_declaration_review', { p_extraction: extractionId, p_tx: txId });
  }
  // o = { version (required: getDeclarationReview().version), declarationNo?, declarationType? (import|export|clearance or
  //       Arabic), declarationDate? 'YYYY-MM-DD', declarationDateHijri? 'yyyy/mm/dd', status? (a Fasah stage code or text),
  //       containers? [{container_number, seal_number?, size_type?, gross_weight?}], items? [{hs_code?, description?,
  //       invoice_description?, scientific_name?, quantity?, unit?, value?, origin_country?, net_weight?, gross_weight?,
  //       invoice_number?, notes?}], vessel?, notes?, confirmBlMismatch?, idemKey? } (a key left out keeps the reading's value)
  //   → { approval_id, extraction_id, transaction_id, ref, batch_id, declaration (row), declaration_action added | corrected |
  //       unchanged, status_action initial | forward | same | kept_backward, bl {status match | mismatch_confirmed |
  //       no_transaction_bl | not_read, transaction_bls, matched_with, rtl_affected}, containers {added, updated, unchanged},
  //       items, hs_reference {saved, ids}, tx_filled, tx_kept, warnings, daftra_hook: 'deferred' }
  function approveDeclarationExtraction(extractionId, txId, o) {
    o = o || {};
    if (!isUuid(extractionId)) return Promise.resolve(fail('MRS_REQUIRED', 'extraction_id'));
    if (!isUuid(txId)) return Promise.resolve(fail('MRS_REQUIRED', 'transaction_id'));
    if (typeof o.version !== 'string' || !o.version) return Promise.resolve(fail('MRS_REQUIRED', 'version'));
    var p = { version: o.version };
    var MAP = { declarationNo: 'declaration_no', declarationType: 'declaration_type', declarationDate: 'declaration_date',
      declarationDateHijri: 'declaration_date_hijri', status: 'status', containers: 'containers', items: 'items', vessel: 'vessel',
      notes: 'notes' };
    Object.keys(MAP).forEach(function (k) { if (o[k] !== undefined) p[MAP[k]] = o[k]; });
    if (o.confirmBlMismatch) p.confirm_bl_mismatch = true;
    return idemRpc('approve_declaration_extraction', o.idemKey, function (k) {
      return { p_extraction: extractionId, p_tx: txId, p_payload: withKey(p, k) };
    });
  }
  // → { transaction_id, active (declaration | null), declarations [..], items [live lines of the active declaration:
  //     {id, line_no, hs_code, description_ar, invoice_description, scientific_name, quantity, unit, value, origin_country,
  //     net_weight_kg, gross_weight_kg, invoice_number, notes, declaration_id, approval_id, extraction_id, …}], approvals [..] }
  function getTransactionDeclaration(txId) { return rpc('get_transaction_declaration', { p_tx: txId }); }
  // o = { orgId?, limit? (1–30, default 10) } → { q, items [{id, hs_code, description_ar, invoice_description, scientific_name,
  //   origin_country, last_declaration_no, last_declaration_date, last_importer, usage_count, last_used_at, score}], count }
  //   (a suggestion only: learned from approved declarations; a supplier HS code stays reference only)
  function searchHsReference(q, o) {
    o = o || {};
    var lim = o.limit == null ? 10 : Math.max(1, Math.min(30, parseInt(o.limit, 10) || 10));
    return inActiveOrg(o.orgId, function (oid) { return rpc('search_hs_reference', { p_org: oid, p_q: String(q == null ? '' : q), p_limit: lim }); });
  }
  // o = { orgId?, name (consignee block or name), vatNumber?, crNumber?, limit? } → { source_name, latin_key, candidates
  //   [{client_id, name_ar, name_en, confidence 0..100, method, review, reasons}], best {client_id, confidence, method} | null,
  //   suggested, conflict, confirmed:false, thresholds {suggest:90, review:70} }   (never links: confirm with confirmClientMatch)
  function matchClientV2(o) {
    o = o || {};
    var p = {};
    if (o.name) p.name = String(o.name);
    if (o.vatNumber) p.vat_number = String(o.vatNumber);
    if (o.crNumber) p.cr_number = String(o.crNumber);
    if (o.limit != null) p.limit = o.limit;
    return inActiveOrg(o.orgId, function (oid) { return rpc('match_client_v2', { p_org: oid, p_payload: p }); });
  }
  // o = { orgId?, clientId, sourceName, source?: 'bl' | 'invoice', sourceRef?, confidence? } → { client_id, alias_id, status,
  //   occurrences, created, match_count }
  function confirmClientMatch(o) {
    o = o || {};
    var p = { client_id: o.clientId, source_name: o.sourceName == null ? null : String(o.sourceName) };
    if (o.source) p.source = o.source;
    if (o.sourceRef) p.source_ref = String(o.sourceRef);
    if (o.confidence != null) p.confidence = o.confidence;
    return inActiveOrg(o.orgId, function (oid) { return rpc('confirm_client_match', { p_org: oid, p_payload: p }); });
  }
  function rejectClientAlias(aliasId, reason) { return rpc('reject_client_alias', { p_alias: aliasId, p_reason: reason == null ? null : String(reason) }); }
  // org admin: the 15 legacy shipping agents (idempotent, never a duplicate) → { added, updated, skipped }
  function seedShippingAgents(o) {
    o = o || {};
    return inActiveOrg(o.orgId, function (oid) { return rpc('seed_shipping_agents', { p_org: oid }); });
  }
  // → [{ party_id, name_ar, name_en, match: 'name' | 'alias' | 'contains' }]
  function matchShippingAgent(name, o) {
    o = o || {};
    return inActiveOrg(o.orgId, function (oid) { return rpc('match_shipping_agent', { p_org: oid, p_name: name == null ? null : String(name) }); });
  }
  // the 7 approved ports (platform table, read-only) → [{code, unlocode, kind, name_ar, name_en, daftra_value, sort, is_active}]
  function listCustomsPorts() {
    return online(function (c) {
      return c.from('customs_ports').select('code,unlocode,kind,name_ar,name_en,daftra_value,sort,is_active').order('sort');
    });
  }
  // operator ↔ port mapping (transport writers add / (de)activate; never deleted). o = { orgId?, partyId?, portCode?, activeOnly? }
  function listPartyPorts(o) {
    o = o || {};
    return inActiveOrg(o.orgId, function (oid) {
      return online(function (c) {
        var q = c.from('party_ports').select('id,org_id,party_id,port_code,is_active,created_at,updated_at').eq('org_id', oid).order('port_code');
        if (o.partyId) q = q.eq('party_id', o.partyId);
        if (o.portCode) q = q.eq('port_code', o.portCode);
        if (o.activeOnly) q = q.eq('is_active', true);
        return q;
      });
    });
  }
  function addPartyPort(partyId, portCode, o) {
    o = o || {};
    return inActiveOrg(o.orgId, function (oid) {
      return online(function (c) {
        return c.from('party_ports').insert({ org_id: oid, party_id: partyId, port_code: portCode }).select('id,org_id,party_id,port_code,is_active').single();
      });
    });
  }
  function setPartyPortActive(id, active) {
    return online(function (c) { return c.from('party_ports').update({ is_active: !!active }).eq('id', id).select('id,party_id,port_code,is_active').single(); });
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
    'source_pages', 'engine', 'languages', 'mean_confidence', 'raw_text', 'extracted_fields', 'qr_payload', 'line_items',
    'ai_usage_id',    // AI reading (20261114000100): sent only when set (pickKeys skips undefined)
    'ai_detail'];     // ai-doc-v3 reading (20261119000100): the response's ai_detail, sent only when set
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

  /* ------------------------------------------------------------------
     AI document reading (Claude) — migration 20261114000100 + Edge Function ai-extract.
     Off per organization until an org admin enables it with an explicit consent (document contents are sent to
     Anthropic). The file goes to OUR Edge Function with the user's own access token (functions.invoke); the
     Anthropic key exists only there. Staff only; aiExtract returns the reading, saving stays saveExtraction()
     (engine 'claude-opus-5-5' + ai_usage_id = the reading's usage_id).
     ------------------------------------------------------------------ */
  var AI_EDGE_ERRORS = {
    ai_disabled: 'MRS_AI_DISABLED', daily_cap: 'MRS_AI_DAILY_CAP', budget: 'MRS_AI_BUDGET', refused: 'MRS_AI_REFUSED',
    truncated: 'MRS_AI_TRUNCATED', too_large: 'MRS_AI_TOO_LARGE', unsupported_media: 'MRS_AI_UNSUPPORTED',
    forbidden: 'MRS_FORBIDDEN', mfa_required: 'MRS_MFA_REQUIRED', unauthorized: 'MRS_AUTH_REQUIRED',
    transaction_not_found: 'MRS_NOT_FOUND', not_configured: 'MRS_AI_UNAVAILABLE', upstream_busy: 'MRS_AI_UNAVAILABLE',
    upstream_error: 'MRS_AI_FAILED', bad_output: 'MRS_AI_FAILED', bad_request: 'MRS_AI_FAILED', internal: 'MRS_AI_FAILED'
  };
  var AI_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  var AI_DOC_TYPES = ['bill_of_lading', 'commercial_invoice', 'customs_declaration', 'supplier_invoice', 'auto'];
  // prompt ai-doc-v3 (20261119000100): + packing_list; o.promptVersion 'ai-doc-v3' opts in (v2 callers unchanged)
  var AI_DOC_TYPES_V3 = ['bill_of_lading', 'commercial_invoice', 'packing_list', 'customs_declaration', 'supplier_invoice', 'auto'];
  var AI_PROMPT_V3 = 'ai-doc-v3';
  var AI_MAX_BYTES = 10 * 1024 * 1024;          // PDF
  var AI_MAX_IMAGE_BYTES = 5 * 1024 * 1024;     // image (the API's per-image limit)
  function aiOrg(orgIdArg) { return orgIdArg ? Promise.resolve(ok(orgIdArg)) : orgId(); }
  // {enabled, can_use, model, daily_request_cap, today_requests, daily_remaining} — staff of the org
  function aiAccess(orgIdArg) {
    if (!configured) return demoOnly();
    return aiOrg(orgIdArg).then(function (r) { return r.error ? r : rpc('ai_access', { p_org: r.data }); });
  }
  // org admin (aal2): settings + usage summary
  function aiGetSettings(orgIdArg) {
    if (!configured) return demoOnly();
    return aiOrg(orgIdArg).then(function (r) { return r.error ? r : rpc('ai_get_settings', { p_org: r.data }); });
  }
  // payload = {enabled?, consent_ack?, daily_request_cap?, monthly_budget_usd?}
  function aiSaveSettings(orgIdArg, payload) {
    if (!configured) return demoOnly();
    return aiOrg(orgIdArg).then(function (r) { return r.error ? r : rpc('ai_save_settings', { p_org: r.data, p_payload: payload || {} }); });
  }
  // the Edge Function's fixed error code → MRS_*; never shows a server message
  function aiEdgeError(err) {
    var ctx = err && err.context;
    var body = ctx && typeof ctx.json === 'function' ? Promise.resolve().then(function () { return ctx.json(); }).catch(function () { return null; }) : Promise.resolve(null);
    return body.then(function (b) {
      var code = b && typeof b.error === 'string' && Object.prototype.hasOwnProperty.call(AI_EDGE_ERRORS, b.error) ? AI_EDGE_ERRORS[b.error] : null;
      if (code) return fail(code);
      if (err && (err.name === 'FunctionsFetchError' || err.name === 'FunctionsRelayError')) return fail('MRS_NETWORK');
      return fail('MRS_AI_FAILED');
    });
  }
  // o = { orgId?, docType: bill_of_lading|commercial_invoice|customs_declaration|supplier_invoice|auto (+ packing_list with v3),
  //       file: { media_type, data_b64 }, transactionId?, lang?, promptVersion?: 'ai-doc-v3' }
  // → { usage_id, engine, model, prompt_version, doc_type, detected_type, kind, fields [{name, value, confidence 0..1, page, valid}],
  //     extracted_fields, line_items, warnings [{source, code, text, field}], mean_confidence (0..100), raw_text, usage }
  //   v3 adds: containers [{container_number, seal_number, size_type, packages_count, net_weight, gross_weight}], ai_detail
  //   (save it with the reading), source_sha256, reused, extraction_id. reused:true = the same file was already read and
  //   saved (no AI call, no charge): use extraction_id, do NOT save the reading again.
  function aiExtract(o) {
    o = o || {};
    if (!configured) return demoOnly();
    var f = o.file || {};
    if (AI_MEDIA.indexOf(f.media_type) === -1) return Promise.resolve(fail('MRS_AI_UNSUPPORTED'));
    if (typeof f.data_b64 !== 'string' || !f.data_b64) return Promise.resolve(fail('MRS_REQUIRED', 'file'));
    if (Math.floor(f.data_b64.length / 4) * 3 > (f.media_type === 'application/pdf' ? AI_MAX_BYTES : AI_MAX_IMAGE_BYTES)) return Promise.resolve(fail('MRS_AI_TOO_LARGE'));
    var v3 = o.promptVersion === AI_PROMPT_V3;
    var docType = (v3 ? AI_DOC_TYPES_V3 : AI_DOC_TYPES).indexOf(o.docType) !== -1 ? o.docType : 'auto';
    return aiOrg(o.orgId).then(function (r) {
      if (r.error) return r;
      var body = { org_id: r.data, doc_type: docType, file: { media_type: f.media_type, data_b64: f.data_b64 },
        lang: o.lang === 'en' ? 'en' : 'ar' };
      if (v3) body.prompt_version = AI_PROMPT_V3;
      if (o.transactionId) body.transaction_id = o.transactionId;
      return ready().then(function (c) {
        return c.functions.invoke('ai-extract', { body: body }).then(function (res) {
          if (res && !res.error && res.data && typeof res.data === 'object' && res.data.usage_id) return ok(res.data);
          return aiEdgeError(res && res.error);
        }, function (e) { return { data: null, error: normalizeError(e) }; });
      }, function (e) { return { data: null, error: normalizeError(e) }; });
    });
  }

  /* ------------------------------------------------------------------
     Document matching (مطابقة المستندات) — migration 20261116000100. The comparison runs in the browser
     (assets/js/doc-match.js); these calls store the reviewed result of 2 (invoice + B/L) or 3 (+ customs declaration)
     saved extractions. Staff only; RPCs only (the table is read-only to the API).
     ------------------------------------------------------------------ */
  var MATCH_MODES = ['two_way', 'three_way'];
  var MATCH_OVERALL = ['match', 'mismatch', 'review'];
  var MATCH_COLS = 'id,org_id,transaction_id,invoice_extraction_id,bl_extraction_id,declaration_extraction_id,mode,engine_version,' +
    'overall,match_count,mismatch_count,partial_count,missing_count,reviewed_rows,note,status,reviewed_by,reviewed_at,review_note,' +
    'created_by,created_at,voided_at,void_reason';
  function matchCount(n) { n = Number(n); return isFinite(n) && n >= 0 && Math.floor(n) === n ? n : 0; }
  // o = { orgId?, transactionId?, invoiceExtractionId, blExtractionId, declarationExtractionId?, mode?, engineVersion,
  //       overall, counts {match, mismatch, partial, missing}, rows [...], reviewedRows [...]?, note?, idempotencyKey? }
  //   (mode defaults to three_way when a declaration is given) → { id, created_at, status, transaction_id, mode, overall }
  function saveDocumentMatch(o) {
    o = o || {};
    if (!configured) return demoOnly();
    if (!isUuid(o.invoiceExtractionId)) return Promise.resolve(fail('MRS_REQUIRED', 'invoice_extraction_id'));
    if (!isUuid(o.blExtractionId)) return Promise.resolve(fail('MRS_REQUIRED', 'bl_extraction_id'));
    if (o.declarationExtractionId != null && !isUuid(o.declarationExtractionId)) return Promise.resolve(fail('MRS_INVALID', 'declaration_extraction_id'));
    if (o.transactionId != null && !isUuid(o.transactionId)) return Promise.resolve(fail('MRS_INVALID', 'transaction_id'));
    var mode = o.mode || (o.declarationExtractionId ? 'three_way' : 'two_way');
    if (MATCH_MODES.indexOf(mode) === -1) return Promise.resolve(fail('MRS_INVALID', 'mode'));
    if (MATCH_OVERALL.indexOf(o.overall) === -1) return Promise.resolve(fail('MRS_INVALID', 'overall'));
    if (!Array.isArray(o.rows) || !o.rows.length || o.rows.length > 60) return Promise.resolve(fail('MRS_INVALID', 'rows'));
    if (o.reviewedRows != null && !Array.isArray(o.reviewedRows)) return Promise.resolve(fail('MRS_INVALID', 'reviewed_rows'));
    if (o.note != null && String(o.note).length > 1000) return Promise.resolve(fail('MRS_TOO_LONG', 'note'));
    var c = o.counts || {};
    var payload = {
      invoice_extraction_id: o.invoiceExtractionId, bl_extraction_id: o.blExtractionId,
      declaration_extraction_id: o.declarationExtractionId || null, transaction_id: o.transactionId || null,
      mode: mode, engine_version: String(o.engineVersion || 'match-v1'), overall: o.overall,
      counts: { match: matchCount(c.match), mismatch: matchCount(c.mismatch), partial: matchCount(c.partial), missing: matchCount(c.missing) },
      rows: o.rows, reviewed_rows: o.reviewedRows || [], note: o.note == null || o.note === '' ? null : String(o.note)
    };
    return aiOrg(o.orgId).then(function (r) {
      if (r.error) return r;
      var oid = r.data;
      return idemRpc('save_document_match', o.idempotencyKey, function (k) { return { p_org: oid, p_payload: withKey(payload, k) }; });
    });
  }
  // reviewedRows = the row keys the reviewer ticked (at least one) → { id, status 'reviewed', reviewed_at, reviewed_by, reviewed_rows }
  function reviewDocumentMatch(id, reviewedRows, note) {
    if (!configured) return demoOnly();
    if (!isUuid(id)) return Promise.resolve(fail('MRS_INVALID', 'document_match'));
    if (!Array.isArray(reviewedRows) || !reviewedRows.length) return Promise.resolve(fail('MRS_REQUIRED', 'reviewed_rows'));
    if (note != null && String(note).length > 1000) return Promise.resolve(fail('MRS_TOO_LONG', 'note'));
    return rpc('review_document_match', { p_id: id, p_reviewed_rows: reviewedRows, p_note: note == null || note === '' ? null : String(note) });
  }
  function voidDocumentMatch(id, reason) {
    var why = String(reason || '').trim();
    if (!configured) return demoOnly();
    if (!isUuid(id)) return Promise.resolve(fail('MRS_INVALID', 'document_match'));
    if (!why) return Promise.resolve(fail('MRS_REQUIRED', 'void_reason'));
    if (why.length > 500) return Promise.resolve(fail('MRS_TOO_LONG', 'void_reason'));
    return rpc('void_document_match', { p_id: id, p_reason: why });
  }
  // o = { orgId?, transactionId?, limit (default 10, max 100), includeVoided? } → newest first:
  //   [{ id, created_at, overall, mode, transaction_id, transaction_ref, counts {match, mismatch, partial, missing},
  //      match_count …, status ('saved' | 'reviewed' | 'voided'), reviewed_at, … }] (rows are not listed: getDocumentMatch)
  function listDocumentMatches(o) {
    o = o || {};
    if (!configured) return demoOnly();
    var limit = Math.min(Math.max(parseInt(o.limit, 10) || 10, 1), 100);
    return aiOrg(o.orgId).then(function (r) {
      if (r.error) return r;
      var oid = r.data;
      return online(function (c) {
        var q = c.from('document_matches').select(MATCH_COLS + ',transactions(ref)').eq('org_id', oid)
          .order('created_at', { ascending: false }).limit(limit);
        if (o.transactionId) q = q.eq('transaction_id', o.transactionId);
        if (!o.includeVoided) q = q.is('voided_at', null);
        return q;
      }).then(function (res) {
        if (res.error) return res;
        return { data: (res.data || []).map(matchRow), error: null };
      });
    });
  }
  function getDocumentMatch(id) {
    if (!configured) return demoOnly();
    if (!isUuid(id)) return Promise.resolve(fail('MRS_INVALID', 'document_match'));
    return online(function (c) { return c.from('document_matches').select(MATCH_COLS + ',rows,transactions(ref)').eq('id', id).maybeSingle(); })
      .then(function (r) { return r.error ? r : (r.data ? ok(matchRow(r.data)) : fail('MRS_NOT_FOUND', 'document_match')); });
  }
  function matchRow(m) {
    var out = Object.assign({}, m);
    var tx = out.transactions;
    delete out.transactions;
    out.transaction_ref = tx && tx.ref ? tx.ref : null;
    out.counts = { match: m.match_count || 0, mismatch: m.mismatch_count || 0, partial: m.partial_count || 0, missing: m.missing_count || 0 };
    if (m.voided_at) out.status = 'voided';
    return out;
  }

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
  // The saved, non-voided extraction of the same file (org + source_sha256 + transaction, the key of
  // document_extractions_dedupe_uidx): used to reuse a reading after MRS_EXTRACTION_DUPLICATE.
  // o = { orgId?, sha256, transactionId? (null/'' = not linked) } → { data: row | null }
  function findExtractionBySource(o) {
    o = o || {};
    var sha = String(o.sha256 || '');
    if (!/^[0-9a-f]{64}$/.test(sha)) return Promise.resolve(fail('MRS_INVALID', 'source_sha256'));
    var tx = o.transactionId || null;
    if (!configured) {
      var hit = extLocalRead().filter(function (x) { return !x.voided_at && x.source_sha256 === sha && (x.transaction_id || null) === tx; })[0];
      return Promise.resolve(ok(hit || null));
    }
    return online(function (c) {
      var q = c.from('document_extractions').select(EXT_COLS).eq('source_sha256', sha).is('voided_at', null);
      if (o.orgId) q = q.eq('org_id', o.orgId);
      q = tx ? q.eq('transaction_id', tx) : q.is('transaction_id', null);
      return q.order('created_at', { ascending: false }).limit(1);
    }).then(function (r) {
      if (r.error) return r;
      return ok(Array.isArray(r.data) ? (r.data[0] || null) : (r.data || null));
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
  var DECL_COLS = 'id,org_id,transaction_id,declaration_no,declaration_type,declaration_date,declaration_date_hijri,status,source,source_document_id,' +
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
     G4 — suppliers & operating costs (docs/online/G4_SPEC.md)
     Every G4 write is an RPC (the tables are SELECT-only for the API); the
     creating RPCs are idempotent (p_idem_key, kept across retries; pass
     opts.idemKey to keep one across a page-level retry). Org-level readers
     take the active org (or f.orgId) as p_org and the remaining filter keys
     as p_filters (empty values dropped). Results are returned as the server
     shapes them ({items, total, …} / row json). Finance originals live in the
     private 'finance' bucket, never in 'documents'. Clients see nothing (G4-7).
     ------------------------------------------------------------------ */
  function finFilters(f) {
    var out = {};
    Object.keys(f || {}).forEach(function (k) {
      var v = f[k];
      if (k === 'orgId' || v == null || v === '' || typeof v === 'function') return;
      out[k] = v;
    });
    if (out.limit != null) out.limit = Math.max(1, Math.min(200, parseInt(out.limit, 10) || 50));
    if (out.offset != null) out.offset = Math.max(0, parseInt(out.offset, 10) || 0);
    return out;
  }
  // org-level reader: name(p_org, p_filters)
  function finOrgRpc(name, f) {
    f = f || {};
    return inActiveOrg(f.orgId, function (oid) { return rpc(name, { p_org: oid, p_filters: finFilters(f) }); });
  }
  // idempotent create: name(p_payload, p_idem_key) — idempotencyKey never travels inside the payload
  function finCreate(name, p, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    return idemRpc(name, opts.idemKey, function (k) { return { p_payload: withKey(p, null), p_idem_key: k }; });
  }
  function txRpc(name, txId) {
    if (!configured) return demoOnly();
    if (!isUuid(txId)) return Promise.resolve(fail('MRS_INVALID', 'transaction_id'));
    return rpc(name, { p_tx: txId });
  }
  function reasonRpc(name, id, reason) { return rpc(name, { p_id: id, p_reason: reason == null ? null : String(reason) }); }

  /* party finance columns (iban_last4, bank_name, payment_terms_days, default_currency) — only through this RPC */
  function savePartyFinance(partyId, p) { return rpc('save_party_finance', { p_party: partyId, p_payload: p || {} }); }

  /* finance originals (supplier invoices, credit notes, payment / collection / adjustment / demurrage evidence)
     o = { file, branchId, kind } → sha256 in the browser → register_finance_document → upload to the returned path.
     → { data: { id, storage_bucket, storage_path, sha256, original_name } }. A duplicate file (same sha256, not voided)
     is refused by the server (MRS_INVALID 'file_duplicate', error.refId = the existing document). When the row is saved
     but the bytes are not, the result carries both data and error MRS_UPLOAD; retrying with the same opts.idemKey
     replays the registration and uploads again. */
  var FIN_DOC_KINDS = ['supplier_invoice', 'credit_note', 'payment_evidence', 'collection_evidence', 'adjustment_evidence', 'demurrage_evidence', 'other'];
  function uploadFinanceDocument(o, opts) {
    if (!configured) return demoOnly();
    o = o || {}; opts = opts || {};
    var file = o.file;
    if (!file) return Promise.resolve(fail('MRS_REQUIRED', 'finance_document_id'));
    if (!file.size) return Promise.resolve(fail('MRS_INVALID', 'size_bytes'));
    if (file.size > 26214400) return Promise.resolve(fail('MRS_FILE_TOO_LARGE'));
    if (!isUuid(o.branchId)) return Promise.resolve(fail('MRS_REQUIRED', 'branch_id'));
    var kind = FIN_DOC_KINDS.indexOf(o.kind) !== -1 ? o.kind : 'other';
    return sha256Hex(file).then(function (hash) {
      var payload = {
        branch_id: o.branchId, kind: kind, original_name: String(file.name || 'file').slice(0, 255),
        mime_type: file.type || null, size_bytes: file.size, sha256: hash
      };
      return idemRpc('register_finance_document', opts.idemKey, function (k) { return { p_payload: payload, p_idem_key: k }; })
        .then(function (r) {
          if (r.error || !r.data) return r;
          var doc = Object.assign({ sha256: hash, original_name: payload.original_name }, r.data), key = r.idemKey;
          var path = doc.storage_path;
          if (!path || String(path).split('/').length !== 3 || String(path).indexOf('..') !== -1) {
            return { data: doc, error: mkErr('MRS_UPLOAD', 'storage_path'), idemKey: key };
          }
          return online(function (c) {
            return c.storage.from('finance').upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
          }).then(function (u) {
            // a replayed registration whose bytes are already there: the object exists → fine
            var exists = u.error && /already exists|duplicate|409/i.test(String((u.error.raw && (u.error.raw.message || u.error.raw.statusCode)) || ''));
            if (u.error && !exists) return { data: doc, error: mkErr('MRS_UPLOAD', null, u.error.raw || u.error), idemKey: key };
            return { data: doc, error: null, idemKey: key };
          });
        });
    }, function (e) { return { data: null, error: normalizeError(e) }; });
  }
  function financeDocumentUrl(docOrPath, expiresIn) {
    var p = typeof docOrPath === 'string' ? docOrPath : docOrPath && docOrPath.storage_path;
    if (!p) return Promise.resolve(fail('MRS_NOT_FOUND'));
    return online(function (c) { return c.storage.from('finance').createSignedUrl(p, expiresIn || 300); })
      .then(function (r) {
        if (r.error) return r;
        var u = r.data && r.data.signedUrl, base = '';
        try { base = new URL(cfg.supabaseUrl).origin; if (new URL(u, base).origin !== base) u = null; } catch (e) { u = null; }
        return u ? ok(u) : fail('MRS_INVALID', 'signed_url');
      });
  }
  function voidFinanceDocument(id, reason) { return reasonRpc('void_finance_document', id, reason); }

  /* supplier invoices (+ lines) */
  // p = { supplier_id, invoice_number, invoice_date, total_amount, doc_type?, sha256? } → { exact[], possible[], file[] }
  function checkInvoiceDuplicate(p) {
    p = Object.assign({}, p || {});
    var explicit = p.orgId; delete p.orgId;
    return inActiveOrg(explicit, function (oid) { return rpc('check_supplier_invoice_duplicate', { p_org: oid, p_payload: finFilters(p) }); });
  }
  // f = { status, payment_status, supplier_id, branch_id, from, to, q, needs_review, limit ≤ 200, offset, orgId }
  function listSupplierInvoices(f) { return finOrgRpc('list_supplier_invoices', f); }
  function getSupplierInvoice(id) { return rpc('get_supplier_invoice', { p_id: id }); }
  // p = { branch_id, supplier_id, doc_type, adjusts_invoice_id, invoice_number, invoice_date, due_date, currency, subtotal,
  //       vat_amount, total_amount, reference, supplier_vat_number, finance_document_id, source_document_id, notes, lines[] }
  function createSupplierInvoice(p, opts) { return finCreate('create_supplier_invoice', p, opts); }
  function updateSupplierInvoice(id, p) { return rpc('update_supplier_invoice', { p_id: id, p_payload: p || {} }); }
  function setSupplierInvoiceStatus(id, s, note) { return rpc('set_supplier_invoice_status', { p_id: id, p_status: s, p_note: note || null }); }
  // lines = [{ description, quantity, unit, unit_price, net_amount, vat_rate, vat_amount, total_amount, service_code,
  //            container_no_hint, reference_hint }] (≤ 200); source 'manual' | 'ocr' | 'import'
  function addInvoiceLines(invoiceId, lines, source, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    lines = Array.isArray(lines) ? lines : [];
    if (!lines.length) return Promise.resolve(fail('MRS_REQUIRED', 'lines'));
    if (lines.length > 200) return Promise.resolve(fail('MRS_TOO_LONG', 'lines'));
    return idemRpc('add_invoice_lines', opts.idemKey, function (k) {
      return { p_invoice: invoiceId, p_lines: lines, p_source: source || 'manual', p_idem_key: k };
    });
  }
  function updateInvoiceLine(id, p) { return rpc('update_invoice_line', { p_id: id, p_payload: p || {} }); }
  // decision ok | overhead | excluded | disputed (a note is required except for ok)
  function reviewInvoiceLine(id, decision, note, serviceCode) {
    return rpc('review_invoice_line', { p_id: id, p_decision: decision, p_note: note || null, p_service_code: serviceCode || null });
  }

  /* cost allocations (never more than the line's net; approval is four-eyes) */
  // targets = [{ transaction_id, container_id?, trip_id?, demurrage_case_id?, accrual_id?, amount? | share_pct?, service_code?, note? }]
  function allocateInvoiceLine(lineId, targets, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    return idemRpc('allocate_invoice_line', opts.idemKey, function (k) {
      return { p_line: lineId, p_targets: Array.isArray(targets) ? targets : [], p_idem_key: k };
    });
  }
  function approveAllocations(ids, note) {
    ids = (Array.isArray(ids) ? ids : [ids]).filter(isUuid);
    if (!ids.length) return Promise.resolve(configured ? fail('MRS_REQUIRED', 'ids') : fail(misconfigured ? 'MRS_CONFIG' : 'MRS_DEMO_MODE'));
    if (ids.length > 100) return Promise.resolve(fail('MRS_TOO_LONG', 'ids'));
    return rpc('approve_allocations', { p_ids: ids, p_note: note || null });
  }
  function rejectAllocation(id, reason) { return reasonRpc('reject_allocation', id, reason); }
  function reverseAllocation(id, reason) { return reasonRpc('reverse_allocation', id, reason); }
  // f = { branch_id, kind, orgId }
  function costReviewQueue(f) { return finOrgRpc('cost_review_queue', f); }

  /* accruals (expected costs; never a payment) */
  // f = { transaction_id, status, source, supplier_id, limit, offset, orgId }
  function listAccruals(f) { return finOrgRpc('list_accruals', f); }
  // p = { transaction_id, container_id, supplier_id, service_code, amount, currency, basis, note }
  function createAccrual(p, opts) { return finCreate('create_accrual', p, opts); }
  // decision accept | keep_open | accept_new_amount | keep_amount (note required)
  function reviewAccrualVariance(id, decision, note) { return rpc('review_accrual_variance', { p_id: id, p_decision: decision, p_note: note || null }); }
  function voidAccrual(id, reason) { return reasonRpc('void_accrual', id, reason); }

  /* supplier payments (evidence; paid ≠ due ≠ revenue) */
  // f = { supplier_id, branch_id, payer, status, from, to, limit, offset, orgId }
  function listSupplierPayments(f) { return finOrgRpc('list_supplier_payments', f); }
  // p = { supplier_invoice_id, amount, currency, paid_at, method, payer, client_id, reference, evidence_document_id }
  function recordSupplierPayment(p, opts) { return finCreate('record_supplier_payment', p, opts); }
  function voidSupplierPayment(id, reason) { return reasonRpc('void_supplier_payment', id, reason); }

  /* client charges (sell side) + collections evidence */
  function listClientCharges(txId) { return txRpc('list_client_charges', txId); }
  function suggestClientCharges(txId) { return txRpc('suggest_client_charges', txId); }
  // p = { transaction_id, container_id, kind, service_code, description, quantity, unit_price, vat_rate, currency, source,
  //       cost_allocation_id, accrual_id, trip_id, demurrage_case_id, markup_pct, note }
  function createClientCharge(p, opts) { return finCreate('create_client_charge', p, opts); }
  function updateClientCharge(id, p) { return rpc('update_client_charge', { p_id: id, p_payload: p || {} }); }
  // s draft | approved | void ('invoiced' is G5 only)
  function setChargeStatus(id, s, note) { return rpc('set_charge_status', { p_id: id, p_status: s, p_note: note || null }); }
  // p = { charge_id, amount, currency, collected_at, method, reference, evidence_document_id }
  function recordChargeCollection(p, opts) { return finCreate('record_charge_collection', p, opts); }
  function voidChargeCollection(id, reason) { return reasonRpc('void_charge_collection', id, reason); }

  /* storage / demurrage / detention cases */
  // f = { transaction_id, status, kind, operator_id, limit, offset, orgId }
  function listDemurrage(f) { return finOrgRpc('list_demurrage', f); }
  // p = { transaction_id, container_id, kind, operator_id, exception_id, free_until, charged_until, days,
  //       estimated_amount, estimated_vat_rate, currency, status_note }
  function createDemurrageCase(p, opts) { return finCreate('create_demurrage_case', p, opts); }
  function updateDemurrageCase(id, p) { return rpc('update_demurrage_case', { p_id: id, p_payload: p || {} }); }
  function setDemurrageStatus(id, s, note) { return rpc('set_demurrage_status', { p_id: id, p_status: s, p_note: note || null }); }

  /* exceptional fees & adjustments */
  // f = { transaction_id, supplier_invoice_id, status, kind, limit, offset, orgId }
  function listCostAdjustments(f) { return finOrgRpc('list_cost_adjustments', f); }
  // p = { kind, transaction_id, container_id, supplier_invoice_id, related_invoice_id, exception_id, supplier_id,
  //       service_code, amount, currency, finance_document_id, document_id, reason }
  function createCostAdjustment(p, opts) { return finCreate('create_cost_adjustment', p, opts); }
  // decision approved | rejected (note required; four eyes)
  function reviewCostAdjustment(id, decision, note) { return rpc('review_cost_adjustment', { p_id: id, p_decision: decision, p_note: note || null }); }

  /* reports (analytical, per currency — not accounting profit) */
  function txCosts(txId) { return txRpc('tx_costs', txId); }
  function txMargin(txId) { return txRpc('tx_margin', txId); }
  // f = { branch_id, client_id, from, to, operational_status, level, currency, limit ≤ 200, offset, orgId }
  function marginReport(f) { return finOrgRpc('margin_report', f); }
  // f = { group_by (required): transaction | client | supplier | service | branch | level, from, to, branch_id, client_id,
  //       supplier_id, service_code, level, currency, include_overhead, orgId }
  function costReport(f) {
    f = f || {};
    if (['transaction', 'client', 'supplier', 'service', 'branch', 'level'].indexOf(f.group_by) === -1) {
      return Promise.resolve(configured ? fail('MRS_REQUIRED', 'group_by') : fail(misconfigured ? 'MRS_CONFIG' : 'MRS_DEMO_MODE'));
    }
    // cost_report is not paged (one row per group): limit / offset are outside its filter whitelist
    var g = {}; Object.keys(f).forEach(function (k) { if (k !== 'limit' && k !== 'offset') g[k] = f[k]; });
    return finOrgRpc('cost_report', g);
  }

  /* ------------------------------------------------------------------
     G5 — Daftra integration & invoicing (docs/online/G5_SPEC.md)
     Marsa prepares invoice DRAFTS in Daftra from approved G4 client charges and pulls their
     status back; the accountant issues inside Daftra (G5-4). Staff RPCs only: they write rows
     and queue outbox jobs (billing_sync_jobs); the server-side worker (supabase/functions/
     daftra-sync, service role) runs them. The worker RPCs (daftra_*) are NEVER exposed here,
     and no Daftra key / secret ever reaches the browser. Until the worker is deployed, queued
     jobs stay 'queued'. Org-level calls take the active org (or f.orgId / opts.orgId) as p_org.
     ------------------------------------------------------------------ */
  function billOrg(explicit, fn) { return inActiveOrg(explicit, fn); }
  // a malformed id never reaches the server (callers check demo mode first)
  function billId(id, field) { return isUuid(id) ? null : Promise.resolve(fail('MRS_INVALID', field)); }
  function billText(v) { return v == null ? null : String(v); }

  /* connection & capability probe (bill_admin writes; fin_read reads) */
  // → { connection (or defaults, exists:false), counts:{jobs_by_status, links_by_status, items_by_status}, push_ready, missing_capabilities[] }
  function getDaftraConnection(o) { o = o || {}; return billOrg(o.orgId, function (oid) { return rpc('get_daftra_connection', { p_org: oid }); }); }
  // p = { mode: 'mock'|'live_pending', subdomain, sync_enabled, default_service_vat_rate, allowed_vat_rates[], reimbursable_tax_code, invoice_notes }
  function saveDaftraConnection(p, o) {
    o = o || {};
    p = Object.assign({}, p || {}); delete p.orgId;
    return billOrg(o.orgId, function (oid) { return rpc('save_daftra_connection', { p_org: oid, p_payload: p }); });
  }
  // → job (probe); idempotent
  function requestDaftraProbe(opts) {
    opts = opts || {};
    return billOrg(opts.orgId, function (oid) {
      return idemRpc('request_daftra_probe', opts.idemKey, function (k) { return { p_org: oid, p_idem_key: k }; });
    });
  }

  /* client links (one Marsa client ↔ one Daftra client per org; drift is shown, never auto-overwritten) */
  // f = { status, q, billable_only, limit ≤ 200, offset, orgId } → { items, unlinked, total, counts }
  function listDaftraClientLinks(f) { return finOrgRpc('list_daftra_client_links', f); }
  // externalId null → search by our reference / create (worker); set → manual link, verified by a client_refresh job → { link, job }
  function linkDaftraClient(clientId, externalId, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    var bad = billId(clientId, 'client_id'); if (bad) return bad;
    var ext = externalId == null || externalId === '' ? null : String(externalId).trim();
    return idemRpc('link_daftra_client', opts.idemKey, function (k) { return { p_client: clientId, p_external_id: ext, p_idem_key: k }; });
  }
  function refreshDaftraClient(linkId) {
    if (!configured) return demoOnly();
    var bad = billId(linkId, 'link_id'); if (bad) return bad;
    return rpc('refresh_daftra_client', { p_link: linkId });
  }
  // decision push_local | acknowledge | choose (externalId ∈ candidates) | create_new; note required
  function resolveClientDrift(linkId, decision, note, externalId) {
    if (!configured) return demoOnly();
    var bad = billId(linkId, 'link_id'); if (bad) return bad;
    return rpc('resolve_client_drift', { p_link: linkId, p_decision: decision, p_note: billText(note), p_external_id: externalId == null || externalId === '' ? null : String(externalId) });
  }
  function unlinkDaftraClient(linkId, reason) {
    if (!configured) return demoOnly();
    var bad = billId(linkId, 'link_id'); if (bad) return bad;
    return rpc('unlink_daftra_client', { p_link: linkId, p_reason: billText(reason) }).then(function (r) {
      // 'in_use' is a shared detail word (G4: document in use); here it means the client has a Daftra invoice
      if (r && r.error && r.error.field === 'in_use') {
        var e = mkErr(r.error.code, 'client_in_use', r.error.raw);
        if (r.error.refId) e.refId = r.error.refId;
        return { data: null, error: e };
      }
      return r;
    });
  }

  /* item / service catalog (every possible key, mapped or with defaults) */
  function listDaftraItems(o) { o = o || {}; return billOrg(o.orgId, function (oid) { return rpc('list_daftra_items', { p_org: oid }); }); }
  // p = { name_ar, name_en, default_vat_rate, tax_code, external_product_id, retire }
  function saveDaftraItem(itemKey, p, o) {
    o = o || {};
    p = Object.assign({}, p || {}); delete p.orgId;
    return billOrg(o.orgId, function (oid) { return rpc('save_daftra_item', { p_org: oid, p_item_key: billText(itemKey), p_payload: p }); });
  }

  /* billing intents «غرض الفوترة» + lines */
  // p = { transaction_id, purpose: final|interim|supplementary, currency, note, add_eligible (default true) } → intent (+ lines)
  function createBillingIntent(p, opts) { return finCreate('create_billing_intent', p, opts); }
  // f = { status, sync_state, transaction_id, client_id, branch_id, payment_status, q, limit ≤ 200, offset, orgId }
  function listBillingIntents(f) { return finOrgRpc('list_billing_intents', f); }
  // → { intent, transaction, client, lines[], eligible_charges[], jobs[], review_items[], checks, can }
  function getBillingIntent(id) {
    if (!configured) return demoOnly();
    var bad = billId(id, 'intent_id'); if (bad) return bad;
    return rpc('get_billing_intent', { p_id: id });
  }
  // chargeIds null / undefined = every eligible approved charge (same tx + currency); an array = exactly these
  // (never filtered or widened: [] → MRS_REQUIRED 'lines', a malformed id → MRS_INVALID 'charge_ids') → { intent, added[] }
  function addBillingLines(intentId, chargeIds, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    var bad = billId(intentId, 'intent_id'); if (bad) return bad;
    var ids = null;
    if (chargeIds !== null && chargeIds !== undefined) {
      if (!Array.isArray(chargeIds) || !chargeIds.every(isUuid)) return Promise.resolve(fail('MRS_INVALID', 'charge_ids'));
      if (!chargeIds.length) return Promise.resolve(fail('MRS_REQUIRED', 'lines'));
      ids = chargeIds.slice();
    }
    if (ids && ids.length > 200) return Promise.resolve(fail('MRS_TOO_LONG', 'charge_ids'));
    return idemRpc('add_billing_lines', opts.idemKey, function (k) { return { p_intent: intentId, p_charge_ids: ids, p_idem_key: k }; });
  }
  // never-pushed line → removed at once; pushed line → pending_remove (the worker removes only that line_ref)
  function removeBillingLine(lineId, reason) {
    if (!configured) return demoOnly();
    var bad = billId(lineId, 'line_id'); if (bad) return bad;
    return rpc('remove_billing_line', { p_line: lineId, p_reason: billText(reason) });
  }
  // → { intent, job, deduplicated } (a double click returns the same live job)
  function requestBillingPush(intentId, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    var bad = billId(intentId, 'intent_id'); if (bad) return bad;
    return idemRpc('request_billing_push', opts.idemKey, function (k) { return { p_intent: intentId, p_idem_key: k }; });
  }
  function requestBillingPull(intentId) {
    if (!configured) return demoOnly();
    var bad = billId(intentId, 'intent_id'); if (bad) return bad;
    return rpc('request_billing_pull', { p_intent: intentId });
  }
  // decision keep_remote | overwrite_remote | recreate | release (note required; fin_approve)
  function resolveBillingConflict(intentId, decision, note) {
    if (!configured) return demoOnly();
    var bad = billId(intentId, 'intent_id'); if (bad) return bad;
    return rpc('resolve_billing_conflict', { p_intent: intentId, p_decision: decision, p_note: billText(note) });
  }
  function cancelBillingIntent(intentId, reason) {
    if (!configured) return demoOnly();
    var bad = billId(intentId, 'intent_id'); if (bad) return bad;
    return rpc('cancel_billing_intent', { p_intent: intentId, p_reason: billText(reason) });
  }

  /* sync queue & review */
  // f = { status, kind, intent_id, limit ≤ 200, offset, orgId } → { items, total, counts }
  function listBillingJobs(f) { return finOrgRpc('list_billing_jobs', f); }
  // → { job, attempts[] (calls redacted by the server) }
  function getBillingJob(id) {
    if (!configured) return demoOnly();
    var bad = billId(id, 'job_id'); if (bad) return bad;
    return rpc('get_billing_job', { p_id: id });
  }
  // failed | dead → queued
  function retryBillingJob(jobId) {
    if (!configured) return demoOnly();
    var bad = billId(jobId, 'job_id'); if (bad) return bad;
    return rpc('retry_billing_job', { p_job: jobId });
  }
  // f = { branch_id, kind, orgId } → { late_charges, issued_mismatch, issued_cancelled, conflicts, unknown, failed_jobs, client_drift, client_review, item_review, counts }
  function billingReviewQueue(f) { return finOrgRpc('billing_review_queue', f); }
  // late_charge: supplementary (intentId) | dismiss · issued_mismatch: accept | credit_note_in_daftra · issued_cancelled: release_charges | dismiss
  function resolveBillingReview(id, decision, note, intentId) {
    if (!configured) return demoOnly();
    var bad = billId(id, 'id'); if (bad) return bad;
    return rpc('resolve_billing_review', { p_id: id, p_decision: decision, p_note: billText(note), p_intent: isUuid(intentId) ? intentId : null });
  }
  // → { intents[] (+ lines), eligible_charges[], review_items[], financial_status, connection:{status, mode, sync_enabled} }
  function txBilling(txId) { return txRpc('tx_billing', txId); }

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
  // G6a-11: the transactions group comes from search_records ({q, limit}); this G2 PostgREST path stays the fallback
  // while the RPC is missing (42883 / PGRST202). skipTx → the clients / requests groups only.
  function globalSearchG2(q, o, skipTx) {
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
      transactions: skipTx ? [] : [by('transactions', SEARCH_TX_COLS, 'ref', 'created_at'), by('transactions', SEARCH_TX_COLS, 'bl_number', 'created_at'),
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
  // a function that is not deployed yet (G6a migration not applied): Postgres 42883 / PostgREST PGRST202
  function rpcMissing(err) {
    var raw = err && (err.raw || err);
    var code = raw && raw.code ? String(raw.code) : '';
    return code === '42883' || code === 'PGRST202' || /could not find the function/i.test(String((raw && raw.message) || ''));
  }
  // search_records item → the palette's G2 row shape ({id, org_id, ref, bl_number, declaration_no, operational_status,
  // created_at, clients:{name_ar, name_en}, matched: column, container_no? | declaration_status?})
  function searchItemToRow(it, oid) {
    var m = Array.isArray(it.matched) ? it.matched : [];
    var pick = null, declStatus = null;
    m.forEach(function (x) {
      if (!x || typeof x !== 'object') return;
      if (x.field === 'declaration_status') { declStatus = x.value; return; }
      if (!pick && (x.field === 'container_no' || x.field === 'declaration_no' || x.field === 'bl_number')) pick = x;
    });
    var row = { id: it.id, org_id: it.org_id || oid || null, ref: it.ref, bl_number: it.bl_number || null, declaration_no: it.declaration_no || null,
      operational_status: it.operational_status, created_at: it.created_at,
      clients: { name_ar: it.client_name || null, name_en: it.client_name_en || null }, matched: pick ? pick.field : 'ref' };
    if (pick && pick.field === 'container_no') row.container_no = pick.value;
    if (pick && pick.field === 'bl_number') row.bl_number = pick.value;
    if (pick && pick.field === 'declaration_no') { row.declaration_no = pick.value; row.declaration_status = pick.status || declStatus || null; }
    return row;
  }
  function globalSearch(q, o) {
    o = o || {};
    if (!configured) return demoOnly();
    var trimmed = String(q == null ? '' : q).replace(/\s+/g, ' ').trim();
    if (trimmed.length < 2 || !likeContains(q)) return Promise.resolve(ok({ transactions: [], clients: [], requests: [] }));
    var limit = Math.min(Math.max(parseInt(o.limit, 10) || 8, 1), 8);
    var cached = o.orgId || (ctxCache ? pickActiveOrg(ctxCache) : null);
    var pick = cached ? Promise.resolve(ok(cached)) : orgId();
    return pick.then(function (r) {
      if (r.error || !r.data) return globalSearchG2(q, o);
      var oid = r.data;
      return Promise.all([
        rpc('search_records', { p_org: oid, p_filters: { q: trimmed.slice(0, 80), limit: limit } }),
        globalSearchG2(q, Object.assign({}, o, { orgId: oid }), true)
      ]).then(function (res) {
        var sr = res[0], rest = res[1];
        if (sr.error && rpcMissing(sr.error)) return globalSearchG2(q, Object.assign({}, o, { orgId: oid }));
        if (sr.error && rest.error) return { data: null, error: sr.error };
        var data = rest.data ? { clients: rest.data.clients || [], requests: rest.data.requests || [] } : { clients: [], requests: [] };
        var items = sr.error ? [] : ((sr.data && Array.isArray(sr.data.items)) ? sr.data.items : []);
        var seen = {};
        data.transactions = items.filter(function (it) {
          if (!it || !isUuid(it.id) || seen[it.id]) return false;
          seen[it.id] = true; return true;
        }).slice(0, limit).map(function (it) { return searchItemToRow(it, oid); });
        return ok(data);
      });
    }, function (e) { return { data: null, error: normalizeError(e) }; });
  }

  /* ------------------------------------------------------------------
     G6a — advanced search, role dashboards, reports & export log, portal readers
     (docs/online/G6A_SPEC.md §8). Every reader is an RLS-scoped / guarded RPC
     with p_org = the active org (or f.orgId) and p_filters = the remaining keys
     (null / '' / empty arrays dropped, strings trimmed, limit / offset clamped).
     The server filters by org, branch scope and role; the UI never does.
     ------------------------------------------------------------------ */
  function rptFilters(f, maxLimit) {
    var out = {};
    Object.keys(f || {}).forEach(function (k) {
      var v = f[k];
      if (k === 'orgId' || v == null || typeof v === 'function') return;
      if (Array.isArray(v)) { v = v.filter(function (x) { return x != null && x !== ''; }); if (!v.length) return; }
      else if (typeof v === 'string') { v = v.trim(); if (v === '') return; }
      else if (typeof v === 'object') return;
      out[k] = v;
    });
    if (maxLimit) {
      if (out.limit != null) out.limit = Math.max(1, Math.min(maxLimit, parseInt(out.limit, 10) || maxLimit));
      if (out.offset != null) out.offset = Math.max(0, Math.min(1000000, parseInt(out.offset, 10) || 0));
    } else { delete out.limit; delete out.offset; }
    return out;
  }
  function rptRpc(name, f, maxLimit) {
    f = f || {};
    return inActiveOrg(f.orgId, function (oid) { return rpc(name, { p_org: oid, p_filters: rptFilters(f, maxLimit) }); });
  }
  function searchRecords(f) { return rptRpc('search_records', f, 100); }
  function dashOps(f) { return rptRpc('dash_ops', f, 0); }
  function dashFinance(f) { return rptRpc('dash_finance', f, 0); }
  function dashManagement(f) { return rptRpc('dash_management', f, 0); }
  function reportTransactions(f) { return rptRpc('report_transactions', f, 500); }
  function reportContainers(f) { return rptRpc('report_containers', f, 500); }
  function reportTrips(f) { return rptRpc('report_trips', f, 500); }
  function listReportExports(f) { return rptRpc('list_report_exports', f, 200); }
  // p = { report, format, filters, row_count } — only these keys travel (never rows or totals); the filters are the
  // report's own filter object without limit / offset / empty values (G6a-9: the server stores who / what / how many)
  var EXPORT_REPORTS = ['search', 'transactions', 'containers', 'trips', 'margins', 'costs', 'fasah_sheet'], EXPORT_FORMATS = ['xlsx', 'csv', 'print'];
  function logReportExport(p) {
    p = p || {};
    if (!configured) return demoOnly();
    if (EXPORT_REPORTS.indexOf(p.report) === -1) return Promise.resolve(fail('MRS_INVALID', 'report'));
    if (EXPORT_FORMATS.indexOf(p.format) === -1) return Promise.resolve(fail('MRS_INVALID', 'format'));
    var n = Number(p.row_count);
    if (!isFinite(n) || n < 0 || Math.floor(n) !== n) return Promise.resolve(fail('MRS_INVALID', 'export_rows'));
    var filters = rptFilters(p.filters && typeof p.filters === 'object' && !Array.isArray(p.filters) ? p.filters : {}, 0);
    var orgPick = p.orgId || (p.filters && p.filters.orgId) || null;
    return inActiveOrg(orgPick, function (oid) {
      return rpc('log_report_export', { p_org: oid, p_payload: { report: p.report, format: p.format, filters: filters, row_count: n } });
    });
  }
  // portal (client): plain RLS read of the client's containers — only the fixed portal columns (G6a-14)
  var PORTAL_CONTAINER_COLS = 'id,transaction_id,container_no,container_type,operational_state,return_status,return_deadline,returned_at,transactions(ref)';
  function listMyContainers(o) {
    o = o || {};
    return online(function (c) {
      var b = c.from('containers').select(PORTAL_CONTAINER_COLS);
      if (o.openOnly) b = b.in('return_status', DASH_OPEN_RETURN);
      return b.order('return_deadline', { ascending: true, nullsFirst: false }).order('container_no', { ascending: true }).limit(500);
    });
  }
  // portal (client): issued Daftra invoices of the client's own transactions (G6a-1); txId optional
  function portalInvoices(txId) {
    if (!configured) return demoOnly();
    if (txId != null && txId !== '' && !isUuid(txId)) return Promise.resolve(fail('MRS_INVALID', 'transaction'));
    return rpc('portal_invoices', { p_tx: txId ? String(txId) : null });
  }

  /* ------------------------------------------------------------------
     G6b — official channels, unified inbox, matching & approved replies
     (docs/online/G6B_SPEC.md "Front end → MarsaApi"). Staff RPCs only: the
     service RPCs (msg_ingest_messages, msg_record_delivery, msg_claim_jobs,
     msg_complete_job, msg_renew_lease, msg_schedule, msg_mock_load,
     msg_mock_save) are NEVER exposed here. No mailbox / WhatsApp credential
     ever reaches the browser; channels hold mode + status only. Approval and
     send are two separate calls (decideMsgReply, then sendMsgReply by a send
     role); the server decides every gate. Org-level calls take the active org
     (or f.orgId / opts.orgId) as p_org. A malformed id never reaches the server.
     Message bodies / subjects / addresses returned here are untrusted DATA:
     callers render them with textContent only.
     ------------------------------------------------------------------ */
  function msgId(id, field) { return isUuid(id) ? null : Promise.resolve(fail('MRS_INVALID', field)); }
  function msgText(v) { return v == null ? null : String(v); }
  // payload copy: orgId / idempotencyKey / functions / undefined never travel; null stays (explicit clear)
  function msgPayload(p) {
    var out = {};
    Object.keys(p && typeof p === 'object' && !Array.isArray(p) ? p : {}).forEach(function (k) {
      var v = p[k];
      if (k === 'orgId' || k === 'idempotencyKey' || v === undefined || typeof v === 'function') return;
      out[k] = v;
    });
    return out;
  }
  function msgOrgRpc(name, o) { o = o || {}; return inActiveOrg(o.orgId, function (oid) { return rpc(name, { p_org: oid }); }); }
  function msgListRpc(name, f, maxLimit) { return rptRpc(name, f, maxLimit); }
  function msgOrgPayload(name, p, o) {
    o = o || {};
    var org = o.orgId || (p && p.orgId) || null;
    return inActiveOrg(org, function (oid) { return rpc(name, { p_org: oid, p_payload: msgPayload(p) }); });
  }
  function msgOrgIdem(name, p, opts) {
    opts = opts || {};
    var org = opts.orgId || (p && p.orgId) || null;
    var payload = msgPayload(p);
    return inActiveOrg(org, function (oid) {
      return idemRpc(name, opts.idemKey || (p && p.idempotencyKey), function (k) { return { p_org: oid, p_payload: payload, p_idem_key: k }; });
    });
  }
  function msgCall(name, idField, id, args) {
    if (!configured) return demoOnly();
    var bad = msgId(id, idField); if (bad) return bad;
    return rpc(name, args);
  }
  function msgDecision(d, allowed) { return allowed.indexOf(d) === -1 ? Promise.resolve(fail('MRS_INVALID', 'decision')) : null; }

  /* settings & channels (msg_admin writes; msg_read reads) */
  // → { settings (or defaults, exists:false) }
  function getMsgSettings(o) { return msgOrgRpc('get_msg_settings', o); }
  // p = { ai_provider: 'rule_mock'|'llm_pending', ai_monthly_budget_usd, auto_link_enabled, retention_days, violation_repeat_days,
  //       default_lang, signature_ar, signature_en }  (require_four_eyes / purge_enabled are fixed in v1)
  function saveMsgSettings(p, o) { return msgOrgPayload('save_msg_settings', p, o); }
  // → { items:[channel + counts{threads_open, jobs_by_status}], mock }
  function listMsgChannels(o) { return msgOrgRpc('list_msg_channels', o); }
  // p = { id?, kind, name, address, default_branch_id, mode: 'mock'|'live_pending', ingest_enabled, send_enabled, provider_terms_ack } — no secret field exists
  function saveMsgChannel(p, opts) { return msgOrgIdem('save_msg_channel', p, opts); }
  function requestMsgChannelProbe(channelId, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    var bad = msgId(channelId, 'channel_id'); if (bad) return bad;
    return idemRpc('request_msg_channel_probe', opts.idemKey, function (k) { return { p_channel: channelId, p_idem_key: k }; });
  }
  // f = { status, kind, channel_id, limit ≤ 200, offset, orgId } → { items, total, counts }
  function listMsgJobs(f) { return msgListRpc('list_msg_jobs', f, 200); }
  // failed | dead → queued (refused for send jobs: retryMsgSend)
  function retryMsgJob(jobId) { return msgCall('retry_msg_job', 'job_id', jobId, { p_job: jobId }); }
  // → { retention_days, older_than, messages, attachments, threads } (counts only; no purge exists)
  function msgRetentionPreview(o) { return msgOrgRpc('msg_retention_preview', o); }
  // f = { from, to, orgId } → { runs, by_provider, budget_usd, month_to_date_usd }
  function msgAiUsage(f) { return msgListRpc('msg_ai_usage', f, 0); }

  /* contacts directory — «العنوان ليس تفويضًا» */
  // f = { q, entity_type, client_id, party_id, verified, limit ≤ 200, offset, orgId } → { items, total }
  function listMsgContacts(f) { return msgListRpc('list_msg_contacts', f, 200); }
  // → { contact, addresses, authorizations, recent_threads }
  function getMsgContact(id) { return msgCall('get_msg_contact', 'contact', id, { p_id: id }); }
  // p = { id?, display_name, entity_type, client_id, party_id, role_label, lang, notes, is_active }
  function saveMsgContact(p, opts) { return msgOrgIdem('save_msg_contact', p, opts); }
  // p = { kind: 'email'|'whatsapp', address }
  function addMsgContactAddress(contactId, p, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    var bad = msgId(contactId, 'contact'); if (bad) return bad;
    var payload = msgPayload(p);
    return idemRpc('add_msg_contact_address', opts.idemKey, function (k) { return { p_contact: contactId, p_payload: payload, p_idem_key: k }; });
  }
  function retireMsgContactAddress(addressId, reason) {
    return msgCall('retire_msg_contact_address', 'address', addressId, { p_address: addressId, p_reason: msgText(reason) });
  }
  // method callback | known_domain | in_person | signed_document | provider_verified; note required
  function verifyMsgContactAddress(addressId, method, note) {
    return msgCall('verify_msg_contact_address', 'address', addressId, { p_address: addressId, p_method: msgText(method), p_note: msgText(note) });
  }
  // p = { scope_type: 'client'|'party'|'transaction', client_id | party_id | transaction_id, may_receive_kinds[], may_discuss[], valid_from, valid_until }
  function grantMsgAuthorization(contactId, p, note) {
    return msgCall('grant_msg_authorization', 'contact', contactId, { p_contact: contactId, p_payload: msgPayload(p), p_note: msgText(note) });
  }
  function revokeMsgAuthorization(id, reason) { return msgCall('revoke_msg_authorization', 'id', id, { p_id: id, p_reason: msgText(reason) }); }

  /* unified inbox (thread scope = org + branch, decided by the server) */
  // f = { box: all|mine|unassigned|review|approval|sent, status, priority, category, channel_id, branch_id, owner_id, match_status,
  //       transaction_id, risk, q, from, to, limit ≤ 100, offset, orgId } → { items, total, counts:{by_box, by_status, by_priority} }
  function listMsgThreads(f) { return msgListRpc('list_msg_threads', f, 100); }
  // → { thread, messages, links, candidates, replies, suggestions, can } (marks inbound read for the caller)
  function getMsgThread(id) { return msgCall('get_msg_thread', 'thread', id, { p_id: id }); }
  // p = { status, priority, owner_id, due_at, branch_id } (only the keys given change)
  function updateMsgThread(id, p) { return msgCall('update_msg_thread', 'thread', id, { p_id: id, p_payload: msgPayload(p) }); }
  function linkMsgThread(threadId, txId, note) {
    if (!configured) return demoOnly();
    var bad = msgId(threadId, 'thread') || msgId(txId, 'transaction_id'); if (bad) return bad;
    return rpc('link_msg_thread', { p_thread: threadId, p_tx: txId, p_note: msgText(note) });
  }
  function unlinkMsgThread(threadId, reason) { return msgCall('unlink_msg_thread', 'thread', threadId, { p_thread: threadId, p_reason: msgText(reason) }); }
  function markMsgNotRelated(threadId, reason) { return msgCall('mark_msg_not_related', 'thread', threadId, { p_thread: threadId, p_reason: msgText(reason) }); }
  // decision confirm | correct (value) | reject
  function reviewMsgExtraction(id, decision, value, note) {
    if (!configured) return demoOnly();
    var bad = msgId(id, 'extraction') || msgDecision(decision, ['confirm', 'correct', 'reject']); if (bad) return bad;
    return rpc('review_msg_extraction', { p_id: id, p_decision: decision, p_value: msgText(value), p_note: msgText(note) });
  }
  function correctMsgClassification(messageId, category, note) {
    return msgCall('correct_msg_classification', 'message_id', messageId, { p_message: messageId, p_category: msgText(category), p_note: msgText(note) });
  }
  // p = { owner_id, set_due } (due_at is copied only from a spanned deadline)
  function acceptMsgSummary(summaryId, p) { return msgCall('accept_msg_summary', 'summary_id', summaryId, { p_summary: summaryId, p_payload: msgPayload(p) }); }
  // → { threads:[…], counts } (transaction-detail section)
  function txMessages(txId) { return txRpc('tx_messages', txId); }
  // signed URL of an inbound attachment in the private 'messages' bucket — only once the worker stored the bytes
  function msgAttachmentUrl(att, seconds) {
    if (!configured) return demoOnly();
    var a = att && typeof att === 'object' ? att : null;
    if (!a || a.storage_status !== 'stored') return Promise.resolve(fail('MRS_BAD_TRANSITION', 'attachment_not_stored'));
    var p = a.storage_path;
    if (typeof p !== 'string' || !/^[0-9a-f-]{36}\//i.test(p) || p.indexOf('..') !== -1 || (a.storage_bucket && a.storage_bucket !== 'messages')) {
      return Promise.resolve(fail('MRS_INVALID', 'storage_path'));
    }
    var secs = Math.max(30, Math.min(600, parseInt(seconds, 10) || 120));
    return online(function (c) { return c.storage.from('messages').createSignedUrl(p, secs); }).then(function (r) {
      if (r.error) return r;
      var u = r.data && r.data.signedUrl, base = '';
      try { base = new URL(cfg.supabaseUrl).origin; if (new URL(u, base).origin !== base) u = null; } catch (e) { u = null; }
      return u ? ok(u) : fail('MRS_INVALID', 'signed_url');
    });
  }

  /* replies: draft → submit → approve (msg_approve + level, four-eyes) → send (msg_send) */
  // p = { template_key, lang, reply_to_message_id } → { job, reply? } (a draft job; no reply is created automatically)
  function requestMsgDraft(threadId, p, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    var bad = msgId(threadId, 'thread'); if (bad) return bad;
    var payload = msgPayload(p);
    return idemRpc('request_msg_draft', opts.idemKey, function (k) { return { p_thread: threadId, p_payload: payload, p_idem_key: k }; });
  }
  // replyId null → a new reply; p = { thread_id, reply_to_message_id, lang, subject, body_text, to[], cc[] } → reply + version
  function saveMsgReply(replyId, p, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    var rid = replyId == null || replyId === '' ? null : replyId;
    if (rid !== null) { var bad = msgId(rid, 'reply'); if (bad) return bad; }
    var payload = msgPayload(p);
    return idemRpc('save_msg_reply', opts.idemKey, function (k) { return { p_reply: rid, p_payload: payload, p_idem_key: k }; });
  }
  // → { items:[{document_id, kind, classification, name, sensitive, suggested_for, can_share, reasons[]}] } — nothing is attached
  function msgAttachmentSuggestions(replyId) { return msgCall('msg_attachment_suggestions', 'reply', replyId, { p_reply: replyId }); }
  // exactly these documents (≤ 10; [] clears); a document the recipients may not receive is refused by the server
  function setMsgReplyAttachments(replyId, documentIds) {
    if (!configured) return demoOnly();
    var bad = msgId(replyId, 'reply'); if (bad) return bad;
    if (!Array.isArray(documentIds) || !documentIds.every(isUuid)) return Promise.resolve(fail('MRS_INVALID', 'document_ids'));
    if (documentIds.length > 10) return Promise.resolve(fail('MRS_TOO_LONG', 'document_ids'));
    var ids = documentIds.filter(function (x, i, a) { return a.indexOf(x) === i; });
    return rpc('set_msg_reply_attachments', { p_reply: replyId, p_document_ids: ids });
  }
  function submitMsgReply(replyId) { return msgCall('submit_msg_reply', 'reply', replyId, { p_reply: replyId }); }
  function cancelMsgReply(replyId, reason) { return msgCall('cancel_msg_reply', 'reply', replyId, { p_reply: replyId, p_reason: msgText(reason) }); }
  // decision approve | reject (note required for reject and for a sensitive ack); versionId = the version shown to the approver
  function decideMsgReply(replyId, versionId, decision, note, sensitiveAck) {
    if (!configured) return demoOnly();
    var bad = msgId(replyId, 'reply') || msgId(versionId, 'version_id') || msgDecision(decision, ['approve', 'reject']); if (bad) return bad;
    return rpc('decide_msg_reply', { p_reply: replyId, p_version: versionId, p_decision: decision, p_note: msgText(note), p_sensitive_ack: sensitiveAck === true });
  }
  // → { outbound, job, deduplicated } — one outbound per approved version (a double click returns the same row)
  function sendMsgReply(replyId, opts) {
    if (!configured) return demoOnly();
    opts = opts || {};
    var bad = msgId(replyId, 'reply'); if (bad) return bad;
    return idemRpc('send_msg_reply', opts.idemKey, function (k) { return { p_reply: replyId, p_idem_key: k }; });
  }
  // failed (last attempt applied:'no') → queued, same provider request id
  function retryMsgSend(outboundId) { return msgCall('retry_msg_send', 'outbound_id', outboundId, { p_outbound: outboundId }); }
  // decision confirmed_sent | confirmed_not_sent; note required
  function resolveMsgSendUnknown(outboundId, decision, note) {
    if (!configured) return demoOnly();
    var bad = msgId(outboundId, 'outbound_id') || msgDecision(decision, ['confirmed_sent', 'confirmed_not_sent']); if (bad) return bad;
    return rpc('resolve_msg_send_unknown', { p_outbound: outboundId, p_decision: decision, p_note: msgText(note) });
  }

  /* library: instructions, templates, auto-reply policies (disabled in v1) */
  function listMsgInstructions(f) { return msgListRpc('list_msg_instructions', f, 200); }
  function saveMsgInstruction(p, opts) { return msgOrgIdem('save_msg_instruction', p, opts); }
  function reviewMsgInstruction(id, decision, note) {
    if (!configured) return demoOnly();
    var bad = msgId(id, 'id') || msgDecision(decision, ['approve', 'retire']); if (bad) return bad;
    return rpc('review_msg_instruction', { p_id: id, p_decision: decision, p_note: msgText(note) });
  }
  function listMsgTemplates(f) { return msgListRpc('list_msg_templates', f, 200); }
  function saveMsgTemplate(p, opts) { return msgOrgIdem('save_msg_template', p, opts); }
  function reviewMsgTemplate(id, decision, note) {
    if (!configured) return demoOnly();
    var bad = msgId(id, 'id') || msgDecision(decision, ['approve', 'retire']); if (bad) return bad;
    return rpc('review_msg_template', { p_id: id, p_decision: decision, p_note: msgText(note) });
  }
  // → { inserted } (built-in defaults as draft versions; idempotent by key + language)
  function seedMsgTemplates(o) { return msgOrgRpc('seed_msg_templates', o); }
  function listMsgAutoReplyPolicies(o) { return msgOrgRpc('list_msg_auto_reply_policies', o); }
  // enabled=true is refused here and by the server (G6b-11: auto-replies are not active in v1)
  function saveMsgAutoReplyPolicy(p, o) {
    if (!configured) return demoOnly();
    if (p && p.enabled === true) return Promise.resolve(fail('MRS_BAD_TRANSITION', 'auto_reply_disabled_v1'));
    return msgOrgPayload('save_msg_auto_reply_policy', p, o);
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
    var b = document.querySelector('[data-demo-banner]');
    if (b && cfg.environment === 'production') { b.hidden = true; return; }   // production: no environment banner
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
    version: '0.2.0',
    environment: cfg.environment || 'demo',
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
    mfaFactors: mfaFactors, mfaAal: mfaAal, mfaEnroll: mfaEnroll, mfaVerify: mfaVerify, mfaUnenroll: mfaUnenroll, mfaState: mfaState,
    myContext: myContext, myMemberships: myMemberships, myRole: myRole, hasRole: hasRole, isStaff: isStaff, orgId: orgId,
    isPlatformAdmin: isPlatformAdmin, activeOrgId: activeOrgId, setActiveOrg: setActiveOrg, setMyLocale: setMyLocale,
    // public
    submitServiceRequest: submitServiceRequest, submitContactMessage: submitContactMessage, publicTrack: publicTrack,
    statusLabels: statusLabels, healthCheck: healthCheck, logClientError: logClientError, armForm: armForm, formSignals: formSignals,
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
    // G7 plans / subscriptions / usage (platform admin) + the org admin's own subscription
    platformListPlans: platformListPlans, platformSavePlan: platformSavePlan, platformListSubscriptions: platformListSubscriptions,
    platformSetOrgPlan: platformSetOrgPlan, platformSuspendOrg: platformSuspendOrg, platformActivateOrg: platformActivateOrg,
    platformOrgUsage: platformOrgUsage, platformRecountUsage: platformRecountUsage, orgSubscription: orgSubscription,
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
    // legacy step 2 (20261118000100)
    cancelTransaction: cancelTransaction, checkTxDuplicates: checkTxDuplicates, txLifecycle: txLifecycle, saveMovement: saveMovement,
    listMovements: listMovements, driverDirectory: driverDirectory, portOperators: portOperators, listCustomsPorts: listCustomsPorts,
    listPartyPorts: listPartyPorts, addPartyPort: addPartyPort, setPartyPortActive: setPartyPortActive,
    // legacy step 3 (20261119000100)
    createDocBatch: createDocBatch, attachDocBatchDocument: attachDocBatchDocument, detachDocBatchDocument: detachDocBatchDocument,
    mergeDocBatch: mergeDocBatch, saveDocBatchDraft: saveDocBatchDraft, getDocBatch: getDocBatch,
    listPendingDocBatches: listPendingDocBatches, discardDocBatch: discardDocBatch, archiveDocBatch: archiveDocBatch,
    approveDocBatch: approveDocBatch, getTransactionShipment: getTransactionShipment, matchClientV2: matchClientV2,
    confirmClientMatch: confirmClientMatch, rejectClientAlias: rejectClientAlias, seedShippingAgents: seedShippingAgents,
    matchShippingAgent: matchShippingAgent,
    // legacy step 4 (20261120000100)
    getDeclarationReview: getDeclarationReview, approveDeclarationExtraction: approveDeclarationExtraction,
    getTransactionDeclaration: getTransactionDeclaration, searchHsReference: searchHsReference,
    listContainers: listContainers, addContainer: addContainer, updateContainer: updateContainer,
    // documents
    listDocuments: listDocuments, uploadDocument: uploadDocument, documentUrl: documentUrl,
    classifyDocument: classifyDocument, setDocumentVisibility: setDocumentVisibility, voidDocument: voidDocument,
    // bulk import
    createImportBatch: createImportBatch, addImportRows: addImportRows, listImportRows: listImportRows,
    updateImportRow: updateImportRow, findBatchByFingerprint: findBatchByFingerprint,
    cancelImportBatch: cancelImportBatch, importCommit: importCommit,
    // document extractions (OCR)
    saveExtraction: saveExtraction, listExtractions: listExtractions, getExtraction: getExtraction, findExtractionBySource: findExtractionBySource,
    reviewExtraction: reviewExtraction, voidExtraction: voidExtraction, attachExtractionDocument: attachExtractionDocument,
    localExtractions: localExtractions,
    // AI document reading (Claude, Edge Function ai-extract; 20261114000100)
    aiAccess: aiAccess, aiExtract: aiExtract, aiGetSettings: aiGetSettings, aiSaveSettings: aiSaveSettings,
    saveDocumentMatch: saveDocumentMatch, reviewDocumentMatch: reviewDocumentMatch, voidDocumentMatch: voidDocumentMatch,
    listDocumentMatches: listDocumentMatches, getDocumentMatch: getDocumentMatch,
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
    // G4 suppliers & operating costs (docs/online/G4_SPEC.md)
    savePartyFinance: savePartyFinance,
    uploadFinanceDocument: uploadFinanceDocument, financeDocumentUrl: financeDocumentUrl, voidFinanceDocument: voidFinanceDocument,
    checkInvoiceDuplicate: checkInvoiceDuplicate, listSupplierInvoices: listSupplierInvoices, getSupplierInvoice: getSupplierInvoice,
    createSupplierInvoice: createSupplierInvoice, updateSupplierInvoice: updateSupplierInvoice, setSupplierInvoiceStatus: setSupplierInvoiceStatus,
    addInvoiceLines: addInvoiceLines, updateInvoiceLine: updateInvoiceLine, reviewInvoiceLine: reviewInvoiceLine,
    allocateInvoiceLine: allocateInvoiceLine, approveAllocations: approveAllocations, rejectAllocation: rejectAllocation,
    reverseAllocation: reverseAllocation, costReviewQueue: costReviewQueue,
    listAccruals: listAccruals, createAccrual: createAccrual, reviewAccrualVariance: reviewAccrualVariance, voidAccrual: voidAccrual,
    listSupplierPayments: listSupplierPayments, recordSupplierPayment: recordSupplierPayment, voidSupplierPayment: voidSupplierPayment,
    listClientCharges: listClientCharges, suggestClientCharges: suggestClientCharges, createClientCharge: createClientCharge,
    updateClientCharge: updateClientCharge, setChargeStatus: setChargeStatus,
    recordChargeCollection: recordChargeCollection, voidChargeCollection: voidChargeCollection,
    listDemurrage: listDemurrage, createDemurrageCase: createDemurrageCase, updateDemurrageCase: updateDemurrageCase,
    setDemurrageStatus: setDemurrageStatus,
    listCostAdjustments: listCostAdjustments, createCostAdjustment: createCostAdjustment, reviewCostAdjustment: reviewCostAdjustment,
    txCosts: txCosts, txMargin: txMargin, marginReport: marginReport, costReport: costReport,
    // G5 Daftra integration & invoicing (docs/online/G5_SPEC.md) — staff RPCs only, never the daftra_* worker RPCs
    getDaftraConnection: getDaftraConnection, saveDaftraConnection: saveDaftraConnection, requestDaftraProbe: requestDaftraProbe,
    listDaftraClientLinks: listDaftraClientLinks, linkDaftraClient: linkDaftraClient, refreshDaftraClient: refreshDaftraClient,
    resolveClientDrift: resolveClientDrift, unlinkDaftraClient: unlinkDaftraClient,
    listDaftraItems: listDaftraItems, saveDaftraItem: saveDaftraItem,
    createBillingIntent: createBillingIntent, listBillingIntents: listBillingIntents, getBillingIntent: getBillingIntent,
    addBillingLines: addBillingLines, removeBillingLine: removeBillingLine, requestBillingPush: requestBillingPush,
    requestBillingPull: requestBillingPull, resolveBillingConflict: resolveBillingConflict, cancelBillingIntent: cancelBillingIntent,
    listBillingJobs: listBillingJobs, getBillingJob: getBillingJob, retryBillingJob: retryBillingJob,
    billingReviewQueue: billingReviewQueue, resolveBillingReview: resolveBillingReview, txBilling: txBilling,
    // G6a portal, dashboards, advanced search, reports & export log (docs/online/G6A_SPEC.md §8)
    searchRecords: searchRecords, dashOps: dashOps, dashFinance: dashFinance, dashManagement: dashManagement,
    reportTransactions: reportTransactions, reportContainers: reportContainers, reportTrips: reportTrips,
    logReportExport: logReportExport, listReportExports: listReportExports,
    listMyContainers: listMyContainers, portalInvoices: portalInvoices,
    // G6b channels, unified inbox, approved replies (docs/online/G6B_SPEC.md) — staff RPCs only, never the msg_* service RPCs
    getMsgSettings: getMsgSettings, saveMsgSettings: saveMsgSettings, listMsgChannels: listMsgChannels, saveMsgChannel: saveMsgChannel,
    requestMsgChannelProbe: requestMsgChannelProbe, listMsgJobs: listMsgJobs, retryMsgJob: retryMsgJob,
    msgRetentionPreview: msgRetentionPreview, msgAiUsage: msgAiUsage,
    listMsgContacts: listMsgContacts, getMsgContact: getMsgContact, saveMsgContact: saveMsgContact,
    addMsgContactAddress: addMsgContactAddress, retireMsgContactAddress: retireMsgContactAddress,
    verifyMsgContactAddress: verifyMsgContactAddress, grantMsgAuthorization: grantMsgAuthorization, revokeMsgAuthorization: revokeMsgAuthorization,
    listMsgThreads: listMsgThreads, getMsgThread: getMsgThread, updateMsgThread: updateMsgThread,
    linkMsgThread: linkMsgThread, unlinkMsgThread: unlinkMsgThread, markMsgNotRelated: markMsgNotRelated,
    reviewMsgExtraction: reviewMsgExtraction, correctMsgClassification: correctMsgClassification, acceptMsgSummary: acceptMsgSummary,
    txMessages: txMessages, msgAttachmentUrl: msgAttachmentUrl,
    requestMsgDraft: requestMsgDraft, saveMsgReply: saveMsgReply, msgAttachmentSuggestions: msgAttachmentSuggestions,
    setMsgReplyAttachments: setMsgReplyAttachments, submitMsgReply: submitMsgReply, cancelMsgReply: cancelMsgReply,
    decideMsgReply: decideMsgReply, sendMsgReply: sendMsgReply, retryMsgSend: retryMsgSend, resolveMsgSendUnknown: resolveMsgSendUnknown,
    listMsgInstructions: listMsgInstructions, saveMsgInstruction: saveMsgInstruction, reviewMsgInstruction: reviewMsgInstruction,
    listMsgTemplates: listMsgTemplates, saveMsgTemplate: saveMsgTemplate, reviewMsgTemplate: reviewMsgTemplate, seedMsgTemplates: seedMsgTemplates,
    listMsgAutoReplyPolicies: listMsgAutoReplyPolicies, saveMsgAutoReplyPolicy: saveMsgAutoReplyPolicy,
    // app shell
    globalSearch: globalSearch, dashboardStats: dashboardStats,
    // utils
    util: { sha256Hex: sha256Hex, uuid: uuid, safeFileName: safeFileName, toRequestPayload: toRequestPayload, toContactPayload: toContactPayload }
  };
  window.MarsaApi = api;
})();
