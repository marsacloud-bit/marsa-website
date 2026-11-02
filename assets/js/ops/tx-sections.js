/* ==========================================================================
   مرسى | MARSA — G3 transaction-detail sections (#tx/<id>)  →  MarsaOps.txSections
   --------------------------------------------------------------------------
   Contract: docs/online/G3_SPEC.md ("Module hook", "UI scope → Transaction
   detail"). Loaded before admin.js, which renders every section after its
   own cards as  section.render(root, tx, api)  with
     api = { orgId, roles, can(set | roles[], branchId?), t, el, toast, confirm,
             modal({title, body, submitText, danger, wide, noSubmit, onSubmit(form)}),
             go, refresh, MarsaApi, label, fmtDate(v, withTime), fmtMoney, newIdemKey, errText }.
   Sections (order): completeness ring + missing list (10) · document checklist
   per stage with upload / classify shortcuts (15) · customs declarations (20)
   · bills of lading (30) · containers + empty-return panel (40) · port
   appointments with the reschedule chain (50) · transport legs (60) ·
   operational exceptions (70).
   * Strings: own namespace 'opstx' (ar + en) registered below.
   * Each section loads its own data and fails on its own; the lookups the
     sections share (documents, parties, drivers, trucks, B/Ls) are fetched once
     per rendered transaction.
   * The UI only hides what a role cannot do; RLS and the guarded RPCs decide.
     Trip cost / sell come from MarsaApi.tripFinance (finance roles + managers).
   * Server and user data are inserted with textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  if (!Array.isArray(OPS.txSections)) OPS.txSections = [];

  /* ------------------------------------------------------------------
     Strings ('opstx.<k>'; labels 'opstx.lbl_<domain>_<code>')
     ------------------------------------------------------------------ */
  if (I && typeof I.register === 'function') {
    I.register('opstx', {
      ar: {
        none: '—', add: 'إضافة', edit: 'تعديل', save: 'حفظ', open: 'فتح', reason: 'السبب', note: 'ملاحظة', loading: 'جارٍ التحميل…',
        load_failed: 'تعذّر تحميل هذا القسم: {e}', required: 'هذا الحقل مطلوب.', reason_required: 'اكتب السبب (مطلوب).',
        saved: 'تم الحفظ.', choose: 'اختر', optional_none: 'بدون', at: 'الوقت', all_containers: 'المعاملة كلها',
        // completeness
        cmp_title: 'اكتمال بيانات المعاملة', cmp_score: 'مكتملة بنسبة {n}٪', cmp_missing: 'ما ينقص', cmp_none_missing: 'لا ينقص شيء من البيانات والمستندات المطلوبة حاليًا.',
        cmp_ready: 'البيانات تكفي لبدء المراحل', cmp_ready_none: 'لا توجد مرحلة تكفيها البيانات الحالية بعد.',
        cmp_field: 'بيان', cmp_document: 'مستند',
        cmp_hint: 'النسبة تقيس اكتمال البيانات والمستندات فقط، ولا تعني أن الشحنة جاهزة للفسح الجمركي.',
        cmp_release_limit: 'المراحل بعد «البيان الجمركي» لا تُعرض قبل فسح البيان من الجمارك.',
        // checklist
        chk_title: 'قائمة المستندات حسب المرحلة', chk_stage: 'قبل مرحلة «{s}»', chk_next: 'المرحلة التالية', chk_optional: 'اختياري',
        chk_upload: 'رفع', chk_classify: 'تصنيف', chk_empty: 'لا توجد قواعد مستندات تنطبق على هذه المعاملة.',
        chk_hint: 'يُحتسب المستند فقط إذا أكّد الموظف تصنيفه (أو أعاد تصنيفه) إلى النوع المطلوب ولم يُلغَ. الانتقال إلى مرحلة ينقصها مستند مطلوب يُرفض، ويمكن للمدير التجاوز مع ذكر السبب.',
        chk_no_upload: 'نموذج رفع المستندات غير متاح لصلاحيتك.',
        // declarations
        dec_title: 'البيانات الجمركية', dec_add: 'إضافة بيان', dec_no: 'رقم البيان', dec_type: 'نوع البيان', dec_date: 'تاريخ البيان',
        dec_status: 'الحالة', dec_source: 'المصدر', dec_source_doc: 'المستند المصدر', dec_notes: 'ملاحظات داخلية',
        dec_set_status: 'تغيير الحالة', dec_correct: 'تصحيح', dec_cancel: 'إلغاء / استبدال', dec_new_status: 'الحالة الجديدة',
        dec_corrected: 'صُحّح في {d}', dec_cancelled: 'أُلغي في {d}: {r}', dec_replaced_by: 'استُبدل بالبيان {n}', dec_replaces: 'بديل عن البيان {n}',
        dec_empty: 'لا توجد بيانات جمركية مسجّلة لهذه المعاملة.', dec_replace: 'إصدار بيان بديل في العملية نفسها',
        dec_replace_hint: 'الرقم الملغى لا يُعاد استخدامه في المؤسسة إلا عبر بيان بديل مرتبط به.',
        dec_cancel_title: 'إلغاء البيان {n}', dec_correct_title: 'تصحيح البيان {n}', dec_correct_hint: 'تُحفظ القيم قبل التصحيح وبعده في سجل التدقيق.',
        dec_hint: 'آخر بيان نشط ينعكس على بيانات المعاملة تلقائيًا، وكل تغيير يُسجَّل في سجل الأحداث.',
        dec_added: 'أُضيف البيان.', dec_status_saved: 'تغيّرت حالة البيان.', dec_cancel_done: 'أُلغي البيان.', dec_replace_done: 'أُلغي البيان وسُجّل البديل.',
        dec_correct_done: 'صُحّح البيان.', dec_bad_no: 'رقم البيان: أرقام وحروف فقط (حتى 30 خانة).',
        // B/Ls
        bl_title: 'بوالص الشحن', bl_link: 'ربط بوليصة موجودة', bl_new: 'بوليصة جديدة', bl_no: 'رقم البوليصة', bl_type: 'النوع',
        bl_primary: 'رئيسية', bl_make_primary: 'جعلها الرئيسية', bl_unlink: 'فك الربط', bl_vessel: 'السفينة / الرحلة', bl_route: 'من ← إلى',
        bl_packages: 'الطرود', bl_weight: 'الوزن الإجمالي (كجم)', bl_agent: 'الوكيل الملاحي', bl_carrier: 'الناقل / الخط الملاحي',
        bl_voyage: 'الرحلة', bl_pol: 'ميناء الشحن', bl_pod: 'ميناء التفريغ', bl_origin: 'بلد المنشأ', bl_goods: 'وصف البضاعة',
        bl_issued: 'تاريخ الإصدار', bl_notes: 'ملاحظات داخلية', bl_set_primary: 'بوليصة رئيسية لهذه المعاملة',
        bl_empty: 'لا توجد بوالص مرتبطة بهذه المعاملة.', bl_search: 'ابحث برقم البوليصة', bl_search_btn: 'بحث', bl_search_none: 'لا توجد بوليصة مطابقة.',
        bl_link_btn: 'ربط', bl_linked: 'رُبطت البوليصة.', bl_unlinked: 'فُكّ ربط البوليصة.', bl_primary_done: 'أصبحت البوليصة رئيسية.',
        bl_saved: 'سُجّلت البوليصة ورُبطت بالمعاملة.', bl_dup: 'هذه البوليصة (الرقم والنوع) مسجّلة من قبل؛ استخدم «ربط بوليصة موجودة».',
        bl_shared_warn: 'رُبطت البوليصة، وهي تغذّي أيضًا معاملة عميل آخر. تأكّد أن الربط مقصود (بوليصة رئيسية مجمّعة)؛ لا يرى أيّ من العميلين تفاصيلها ما دامت مشتركة.',
        bl_other_branch: 'رقم البوليصة مسجّل لمعاملات فرع لا تملك صلاحيته، فلم تُربط. يربطها مسؤول لديه صلاحية الفرعين إن كانت البوليصة نفسها.',
        bl_unlink_title: 'فك ربط البوليصة {n}', bl_already: 'مرتبطة',
        bl_hint: 'قد تغذي البوليصة الواحدة أكثر من معاملة، وقد تحمل المعاملة أكثر من بوليصة. رقم البوليصة على المعاملة يتبع البوليصة الرئيسية.',
        // containers
        ctr_title: 'الحاويات: الحالة التشغيلية وإرجاع الفارغ', ctr_no: 'رقم الحاوية', ctr_size: 'المقاس / النوع', ctr_seal: 'رقم الختم',
        ctr_bl: 'البوليصة', ctr_state: 'الحالة التشغيلية', ctr_weight: 'الوزن الإجمالي (كجم)', ctr_edit: 'تحديث', ctr_history: 'سجل الزيارات',
        ctr_return: 'إرجاع الفارغ', ctr_empty: 'لا توجد حاويات على هذه المعاملة. أضفها من قسم «الحاويات وإرجاع الفارغ» أعلاه.',
        ctr_edit_title: 'تحديث الحاوية {n}', ctr_saved: 'حُدّثت الحاوية.', ctr_visit: 'زيارة {v}',
        ctr_state_hint: '«أُرجعت فارغة» تظهر تلقائيًا عند تأكيد «إيصال استلام الفارغ» في حالة الإرجاع (أو عند إعفاء موثّق)، ولا تُختار يدويًا قبل ذلك؛ إشعار الإرجاع وحده ليس إثباتًا.',
        ret_title: 'إرجاع الحاويات الفارغة', ret_deadline: 'آخر موعد للإرجاع', ret_yard: 'ساحة الإرجاع', ret_location: 'مكان الإرجاع',
        ret_instruction: 'تعليمات الإرجاع (Return Note)', ret_evidence: 'حالة الإثبات', ret_received: 'استلام الإثبات', ret_status: 'حالة الإرجاع',
        ret_edit_title: 'بيانات إرجاع الفارغ — {n}', ret_saved: 'حُفظت بيانات الإرجاع.', ret_no_instruction: 'لا توجد تعليمات',
        ret_instruction_hint: 'تعليمات الإرجاع توجيه وليست إثباتًا. الإثبات الوحيد «إيصال استلام الفارغ» المؤكّد على المعاملة نفسها (من «تعديل» في جدول الحاويات أعلاه).',
        ret_late: 'متأخرة {n} يوم', ret_today: 'اليوم', ret_in: 'خلال {n} يوم', ret_evidence_doc: 'مستند الإثبات: {d}', ret_no_evidence: 'لم يُرفع إثبات',
        hist_title: 'زيارات الحاوية {n}', hist_empty: 'لا توجد زيارات أخرى مسجّلة.', hist_this: 'هذه المعاملة',
        hist_hint: 'يجوز تكرار رقم الحاوية في معاملات مختلفة (زيارات منفصلة)، ولا يتكرر داخل المعاملة نفسها.',
        // appointments
        apt_title: 'مواعيد الميناء', apt_add: 'موعد جديد', apt_at: 'الموعد', apt_window: 'النافذة (دقيقة)', apt_terminal: 'المحطة / المشغّل',
        apt_no: 'رقم الموعد', apt_container: 'الحاوية', apt_driver: 'السائق', apt_truck: 'الشاحنة', apt_status: 'الحالة',
        apt_confirm: 'تأكيد', apt_complete: 'تم', apt_missed: 'فات الموعد', apt_reschedule: 'إعادة جدولة', apt_cancel: 'إلغاء',
        apt_from: 'بدل موعد {d}', apt_to: 'أُعيدت جدولته إلى {d}', apt_empty: 'لا توجد مواعيد لهذه المعاملة.',
        apt_resched_title: 'إعادة جدولة الموعد', apt_resched_hint: 'يُنشأ موعد جديد ويبقى الموعد السابق محفوظًا بحالة «أُعيدت جدولته» مع السبب.',
        apt_status_title: '{s} — الموعد {d}', apt_saved: 'حُفظ الموعد.', apt_status_done: 'تغيّرت حالة الموعد.', apt_resched_done: 'أُعيدت جدولة الموعد.',
        apt_window_min: '{n} د', apt_hint: 'يرى العميل وقت الموعد المؤكّد فقط.',
        // trips
        trp_title: 'رحلات النقل', trp_add: 'رحلة جديدة', trp_leg: 'المرحلة', trp_carrier: 'الناقل', trp_driver: 'السائق', trp_truck: 'الشاحنة',
        trp_origin: 'من', trp_dest: 'إلى', trp_planned: 'الموعد المخطط', trp_loaded: 'التحميل', trp_unloaded: 'التفريغ', trp_status: 'الحالة',
        trp_cost: 'التكلفة', trp_sell: 'سعر البيع', trp_cost_currency: 'عملة التكلفة', trp_sell_currency: 'عملة البيع', trp_basis: 'أساس التكلفة',
        trp_notes: 'ملاحظات داخلية', trp_container: 'الحاوية', trp_next: 'التالي: {s}', trp_cancel: 'إلغاء الرحلة', trp_edit_title: 'تعديل الرحلة {n}',
        trp_status_title: '{s} — المرحلة {n}', trp_saved: 'حُفظت الرحلة.', trp_status_done: 'تغيّرت حالة الرحلة.', trp_empty: 'لا توجد رحلات نقل لهذه المعاملة.',
        trp_money_hidden: 'التكلفة وسعر البيع تظهر للمالية والمديرين فقط.',
        trp_hint: 'يجوز أكثر من مرحلة لكل معاملة أو حاوية. الرحلة منفصلة عن دفع مستحقات الناقل وعن سعر العميل (يأتيان في مرحلة الفوترة).',
        trp_amount_bad: 'المبلغ يجب أن يكون رقمًا موجبًا.',
        // exceptions
        exc_title: 'الاستثناءات التشغيلية', exc_add: 'تسجيل استثناء', exc_kind: 'النوع', exc_when: 'تاريخ الحدوث', exc_source: 'المصدر',
        exc_doc: 'المستند', exc_reason: 'السبب / الوصف', exc_amount: 'المبلغ', exc_currency: 'العملة', exc_status: 'الحالة', exc_container: 'الحاوية',
        exc_progress: 'قيد المعالجة', exc_resolve: 'حلّ', exc_waive: 'إعفاء', exc_resolution: 'ملاحظة المعالجة',
        exc_resolve_title: '{s} — {k}', exc_saved: 'سُجّل الاستثناء.', exc_status_done: 'تغيّرت حالة الاستثناء.', exc_empty: 'لا توجد استثناءات مسجّلة.',
        exc_need_doc: 'الأرضيات ورسوم الإصلاح والتنظيف تتطلب مستندًا أو مبلغًا.',
        exc_hint: 'لكل استثناء مصدر وتاريخ وسبب. الاستثناءات داخلية ولا تظهر للعميل؛ إلغاء البيان الجمركي يُنشئ استثناءً تلقائيًا.',
        // labels
        lbl_declaration_status_draft: 'مسودة', lbl_declaration_status_submitted: 'مقدَّم', lbl_declaration_status_under_inspection: 'تحت المعاينة',
        lbl_declaration_status_released: 'مُفرج عنه', lbl_declaration_status_cancelled: 'ملغى', lbl_declaration_status_replaced: 'مستبدَل',
        lbl_declaration_source_manual: 'إدخال يدوي', lbl_declaration_source_ocr: 'قراءة مستند (OCR)', lbl_declaration_source_import: 'رفع جماعي', lbl_declaration_source_fasah: 'منصة فسح',
        lbl_bl_type_master: 'رئيسية (Master)', lbl_bl_type_house: 'فرعية (House)', lbl_bl_type_sea_waybill: 'سند شحن بحري (Sea Waybill)',
        lbl_bl_type_awb: 'بوليصة جوية (AWB)', lbl_bl_type_other: 'أخرى',
        lbl_container_state_expected: 'متوقعة', lbl_container_state_at_port: 'في الميناء', lbl_container_state_released: 'مُفرج عنها',
        lbl_container_state_gated_out: 'خرجت من الميناء', lbl_container_state_delivered: 'سُلّمت للعميل', lbl_container_state_empty_returned: 'أُرجعت فارغة',
        lbl_appt_status_requested: 'مطلوب', lbl_appt_status_confirmed: 'مؤكد', lbl_appt_status_completed: 'تم', lbl_appt_status_missed: 'فات',
        lbl_appt_status_cancelled: 'ملغى', lbl_appt_status_rescheduled: 'أُعيدت جدولته',
        lbl_trip_status_planned: 'مخططة', lbl_trip_status_dispatched: 'انطلقت', lbl_trip_status_loaded: 'حُمّلت', lbl_trip_status_delivered: 'سُلّمت',
        lbl_trip_status_cancelled: 'ملغاة',
        lbl_cost_basis_agreed: 'متفق عليه', lbl_cost_basis_estimated: 'تقديري', lbl_cost_basis_invoice: 'حسب فاتورة',
        lbl_exception_kind_declaration_cancelled: 'إلغاء بيان جمركي', lbl_exception_kind_demurrage: 'أرضيات / تأخير', lbl_exception_kind_detention_extension: 'تمديد مهلة الحاوية',
        lbl_exception_kind_customs_rejection: 'رفض جمركي', lbl_exception_kind_inspection: 'معاينة', lbl_exception_kind_repair_fee: 'رسوم إصلاح',
        lbl_exception_kind_cleaning_fee: 'رسوم تنظيف', lbl_exception_kind_appointment_change: 'تغيير موعد', lbl_exception_kind_transport_change: 'تغيير النقل',
        lbl_exception_kind_other: 'أخرى',
        lbl_exception_status_open: 'مفتوح', lbl_exception_status_in_progress: 'قيد المعالجة', lbl_exception_status_resolved: 'محلول', lbl_exception_status_waived: 'معفى',
        lbl_exception_source_manual: 'إدخال يدوي', lbl_exception_source_document: 'مستند', lbl_exception_source_email: 'بريد إلكتروني', lbl_exception_source_system: 'النظام',
        lbl_checklist_state_satisfied: 'مستوفى', lbl_checklist_state_missing: 'ناقص', lbl_checklist_state_unreviewed: 'بانتظار التصنيف', lbl_checklist_state_not_applicable: 'لا ينطبق'
      },
      en: {
        none: '—', add: 'Add', edit: 'Edit', save: 'Save', open: 'Open', reason: 'Reason', note: 'Note', loading: 'Loading…',
        load_failed: 'This section could not be loaded: {e}', required: 'This field is required.', reason_required: 'Enter the reason (required).',
        saved: 'Saved.', choose: 'Choose', optional_none: 'None', at: 'Time', all_containers: 'Whole transaction',
        cmp_title: 'Transaction completeness', cmp_score: '{n}% complete', cmp_missing: 'Missing', cmp_none_missing: 'Nothing required is missing right now.',
        cmp_ready: 'Data is enough to start', cmp_ready_none: 'No stage is covered by the current data yet.',
        cmp_field: 'Field', cmp_document: 'Document',
        cmp_hint: 'The score only measures data and documents; it does not mean the shipment is ready for customs clearance.',
        cmp_release_limit: 'Stages after "Customs declaration" are not listed before customs release the declaration.',
        chk_title: 'Document checklist by stage', chk_stage: 'Before "{s}"', chk_next: 'Next stage', chk_optional: 'Optional',
        chk_upload: 'Upload', chk_classify: 'Classify', chk_empty: 'No document rules apply to this transaction.',
        chk_hint: 'A document counts only once staff confirmed (or reclassified) it as the required kind and it is not voided. Moving into a stage with a missing required document is refused; a manager may override with a reason.',
        chk_no_upload: 'The upload form is not available for your role.',
        dec_title: 'Customs declarations', dec_add: 'Add declaration', dec_no: 'Declaration no.', dec_type: 'Type', dec_date: 'Date',
        dec_status: 'Status', dec_source: 'Source', dec_source_doc: 'Source document', dec_notes: 'Internal notes',
        dec_set_status: 'Change status', dec_correct: 'Correct', dec_cancel: 'Cancel / replace', dec_new_status: 'New status',
        dec_corrected: 'Corrected on {d}', dec_cancelled: 'Cancelled on {d}: {r}', dec_replaced_by: 'Replaced by {n}', dec_replaces: 'Replaces {n}',
        dec_empty: 'No customs declarations recorded for this transaction.', dec_replace: 'Issue a replacement declaration in the same step',
        dec_replace_hint: 'A cancelled number cannot be reused in the organization except through a linked replacement.',
        dec_cancel_title: 'Cancel declaration {n}', dec_correct_title: 'Correct declaration {n}', dec_correct_hint: 'The values before and after are kept in the audit log.',
        dec_hint: 'The latest active declaration is mirrored onto the transaction; every change is recorded in the event log.',
        dec_added: 'Declaration added.', dec_status_saved: 'Declaration status changed.', dec_cancel_done: 'Declaration cancelled.', dec_replace_done: 'Declaration cancelled and replacement recorded.',
        dec_correct_done: 'Declaration corrected.', dec_bad_no: 'Declaration no.: letters and digits only (up to 30).',
        bl_title: 'Bills of lading', bl_link: 'Link existing B/L', bl_new: 'New B/L', bl_no: 'B/L number', bl_type: 'Type',
        bl_primary: 'Primary', bl_make_primary: 'Make primary', bl_unlink: 'Unlink', bl_vessel: 'Vessel / voyage', bl_route: 'From → to',
        bl_packages: 'Packages', bl_weight: 'Gross weight (kg)', bl_agent: 'Shipping agent', bl_carrier: 'Carrier / line',
        bl_voyage: 'Voyage', bl_pol: 'Port of loading', bl_pod: 'Port of discharge', bl_origin: 'Country of origin', bl_goods: 'Goods description',
        bl_issued: 'Issued on', bl_notes: 'Internal notes', bl_set_primary: 'Primary B/L of this transaction',
        bl_empty: 'No B/L linked to this transaction.', bl_search: 'Search by B/L number', bl_search_btn: 'Search', bl_search_none: 'No matching B/L.',
        bl_link_btn: 'Link', bl_linked: 'B/L linked.', bl_unlinked: 'B/L unlinked.', bl_primary_done: 'B/L is now primary.',
        bl_saved: 'B/L recorded and linked.', bl_dup: 'This B/L (number and type) already exists; use "Link existing B/L".',
        bl_shared_warn: 'B/L linked; it also feeds another client\'s transaction. Make sure this is intended (a consolidated master B/L); neither client sees its details while it is shared.',
        bl_other_branch: 'This B/L number is registered for transactions of a branch you cannot access, so it was not linked. A manager with rights on both branches can link it if it is the same B/L.',
        bl_unlink_title: 'Unlink B/L {n}', bl_already: 'Linked',
        bl_hint: 'One B/L may feed several transactions and one transaction may carry several B/Ls. The B/L number on the transaction follows the primary B/L.',
        ctr_title: 'Containers: operational state and empty return', ctr_no: 'Container no.', ctr_size: 'Size / type', ctr_seal: 'Seal no.',
        ctr_bl: 'B/L', ctr_state: 'Operational state', ctr_weight: 'Gross weight (kg)', ctr_edit: 'Update', ctr_history: 'Visit history',
        ctr_return: 'Empty return', ctr_empty: 'No containers on this transaction. Add them in the "Containers and empty return" card above.',
        ctr_edit_title: 'Update container {n}', ctr_saved: 'Container updated.', ctr_visit: 'Visit {v}',
        ctr_state_hint: '"Returned empty" follows a confirmed empty-return receipt on the return status (or a documented waiver) and cannot be picked before that; a Return Note alone is no proof.',
        ret_title: 'Empty container return', ret_deadline: 'Return deadline', ret_yard: 'Return yard', ret_location: 'Return location',
        ret_instruction: 'Return instruction (Return Note)', ret_evidence: 'Evidence', ret_received: 'Evidence received', ret_status: 'Return status',
        ret_edit_title: 'Empty return — {n}', ret_saved: 'Return details saved.', ret_no_instruction: 'No instruction',
        ret_instruction_hint: 'A Return Note is an instruction, not proof. The only proof is a confirmed empty-return receipt on the same transaction (via "Edit" in the containers table above).',
        ret_late: '{n} day(s) late', ret_today: 'Today', ret_in: 'In {n} day(s)', ret_evidence_doc: 'Evidence: {d}', ret_no_evidence: 'No evidence yet',
        hist_title: 'Visits of container {n}', hist_empty: 'No other visits recorded.', hist_this: 'This transaction',
        hist_hint: 'A container number may repeat across transactions (separate visits), never within one transaction.',
        apt_title: 'Port appointments', apt_add: 'New appointment', apt_at: 'Appointment', apt_window: 'Window (min)', apt_terminal: 'Terminal / operator',
        apt_no: 'Appointment no.', apt_container: 'Container', apt_driver: 'Driver', apt_truck: 'Truck', apt_status: 'Status',
        apt_confirm: 'Confirm', apt_complete: 'Done', apt_missed: 'Missed', apt_reschedule: 'Reschedule', apt_cancel: 'Cancel',
        apt_from: 'Instead of {d}', apt_to: 'Rescheduled to {d}', apt_empty: 'No appointments for this transaction.',
        apt_resched_title: 'Reschedule appointment', apt_resched_hint: 'A new appointment is created; the old one stays, marked "rescheduled" with the reason.',
        apt_status_title: '{s} — appointment {d}', apt_saved: 'Appointment saved.', apt_status_done: 'Appointment status changed.', apt_resched_done: 'Appointment rescheduled.',
        apt_window_min: '{n} min', apt_hint: 'Clients only see the time of a confirmed appointment.',
        trp_title: 'Transport trips', trp_add: 'New trip', trp_leg: 'Leg', trp_carrier: 'Carrier', trp_driver: 'Driver', trp_truck: 'Truck',
        trp_origin: 'From', trp_dest: 'To', trp_planned: 'Planned', trp_loaded: 'Loaded', trp_unloaded: 'Unloaded', trp_status: 'Status',
        trp_cost: 'Cost', trp_sell: 'Sell price', trp_cost_currency: 'Cost currency', trp_sell_currency: 'Sell currency', trp_basis: 'Cost basis',
        trp_notes: 'Internal notes', trp_container: 'Container', trp_next: 'Next: {s}', trp_cancel: 'Cancel trip', trp_edit_title: 'Edit leg {n}',
        trp_status_title: '{s} — leg {n}', trp_saved: 'Trip saved.', trp_status_done: 'Trip status changed.', trp_empty: 'No transport trips for this transaction.',
        trp_money_hidden: 'Cost and sell price are shown to finance and managers only.',
        trp_hint: 'Several legs per transaction or container are allowed. A trip is separate from paying the carrier and from the client price (both come with billing).',
        trp_amount_bad: 'The amount must be a positive number.',
        exc_title: 'Operational exceptions', exc_add: 'Record exception', exc_kind: 'Kind', exc_when: 'Occurred at', exc_source: 'Source',
        exc_doc: 'Document', exc_reason: 'Reason / description', exc_amount: 'Amount', exc_currency: 'Currency', exc_status: 'Status', exc_container: 'Container',
        exc_progress: 'In progress', exc_resolve: 'Resolve', exc_waive: 'Waive', exc_resolution: 'Resolution note',
        exc_resolve_title: '{s} — {k}', exc_saved: 'Exception recorded.', exc_status_done: 'Exception status changed.', exc_empty: 'No exceptions recorded.',
        exc_need_doc: 'Demurrage, repair and cleaning fees need a document or an amount.',
        exc_hint: 'Every exception has a source, date and reason. Exceptions are internal (never shown to the client); cancelling a declaration creates one automatically.',
        lbl_declaration_status_draft: 'Draft', lbl_declaration_status_submitted: 'Submitted', lbl_declaration_status_under_inspection: 'Under inspection',
        lbl_declaration_status_released: 'Released', lbl_declaration_status_cancelled: 'Cancelled', lbl_declaration_status_replaced: 'Replaced',
        lbl_declaration_source_manual: 'Manual', lbl_declaration_source_ocr: 'Document reading (OCR)', lbl_declaration_source_import: 'Bulk import', lbl_declaration_source_fasah: 'FASAH',
        lbl_bl_type_master: 'Master', lbl_bl_type_house: 'House', lbl_bl_type_sea_waybill: 'Sea waybill', lbl_bl_type_awb: 'Air waybill (AWB)', lbl_bl_type_other: 'Other',
        lbl_container_state_expected: 'Expected', lbl_container_state_at_port: 'At port', lbl_container_state_released: 'Released',
        lbl_container_state_gated_out: 'Gated out', lbl_container_state_delivered: 'Delivered', lbl_container_state_empty_returned: 'Returned empty',
        lbl_appt_status_requested: 'Requested', lbl_appt_status_confirmed: 'Confirmed', lbl_appt_status_completed: 'Completed', lbl_appt_status_missed: 'Missed',
        lbl_appt_status_cancelled: 'Cancelled', lbl_appt_status_rescheduled: 'Rescheduled',
        lbl_trip_status_planned: 'Planned', lbl_trip_status_dispatched: 'Dispatched', lbl_trip_status_loaded: 'Loaded', lbl_trip_status_delivered: 'Delivered',
        lbl_trip_status_cancelled: 'Cancelled',
        lbl_cost_basis_agreed: 'Agreed', lbl_cost_basis_estimated: 'Estimated', lbl_cost_basis_invoice: 'Per invoice',
        lbl_exception_kind_declaration_cancelled: 'Declaration cancelled', lbl_exception_kind_demurrage: 'Demurrage', lbl_exception_kind_detention_extension: 'Detention extension',
        lbl_exception_kind_customs_rejection: 'Customs rejection', lbl_exception_kind_inspection: 'Inspection', lbl_exception_kind_repair_fee: 'Repair fee',
        lbl_exception_kind_cleaning_fee: 'Cleaning fee', lbl_exception_kind_appointment_change: 'Appointment change', lbl_exception_kind_transport_change: 'Transport change',
        lbl_exception_kind_other: 'Other',
        lbl_exception_status_open: 'Open', lbl_exception_status_in_progress: 'In progress', lbl_exception_status_resolved: 'Resolved', lbl_exception_status_waived: 'Waived',
        lbl_exception_source_manual: 'Manual', lbl_exception_source_document: 'Document', lbl_exception_source_email: 'E-mail', lbl_exception_source_system: 'System',
        lbl_checklist_state_satisfied: 'Satisfied', lbl_checklist_state_missing: 'Missing', lbl_checklist_state_unreviewed: 'Awaiting classification', lbl_checklist_state_not_applicable: 'Not applicable'
      }
    });
  }

  /* ------------------------------------------------------------------
     Codes (mirror the CHECK constraints of the G3 migrations)
     ------------------------------------------------------------------ */
  var STAGES = ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return', 'operationally_complete', 'under_billing', 'billed', 'closed'];
  var DEC_STATUS = ['draft', 'submitted', 'under_inspection', 'released', 'cancelled', 'replaced'];
  var DEC_SETTABLE = ['draft', 'submitted', 'under_inspection', 'released'];
  var DEC_SOURCE = ['manual', 'ocr', 'import', 'fasah'];
  var BL_TYPES = ['master', 'house', 'sea_waybill', 'awb', 'other'];
  var CTR_STATES = ['expected', 'at_port', 'released', 'gated_out', 'delivered', 'empty_returned'];
  var TRIP_NEXT = { planned: 'dispatched', dispatched: 'loaded', loaded: 'delivered' };
  var COST_BASIS = ['agreed', 'estimated', 'invoice'];
  var EXC_KINDS = ['demurrage', 'detention_extension', 'customs_rejection', 'inspection', 'repair_fee', 'cleaning_fee', 'appointment_change', 'transport_change', 'declaration_cancelled', 'other'];
  var EXC_NEEDS_PROOF = ['demurrage', 'repair_fee', 'cleaning_fee'];
  var EXC_SOURCES = ['manual', 'document', 'email'];
  var OPEN_RETURN = ['pending', 'evidence_submitted', 'disputed'];
  // trip money (column grants + trip_finance): finance roles and managers, never transport_staff
  var TRIP_FINANCE_ROLES = ['accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'];
  var CURRENCIES = ['SAR', 'USD', 'EUR', 'AED'];
  var TONES = {
    declaration_status: { draft: 'neutral', submitted: 'info', under_inspection: 'warning', released: 'success', cancelled: 'danger', replaced: 'neutral' },
    container_state: { expected: 'neutral', at_port: 'info', released: 'brand', gated_out: 'brand', delivered: 'success', empty_returned: 'success' },
    appt_status: { requested: 'info', confirmed: 'brand', completed: 'success', missed: 'danger', cancelled: 'neutral', rescheduled: 'neutral' },
    trip_status: { planned: 'info', dispatched: 'brand', loaded: 'brand', delivered: 'success', cancelled: 'neutral' },
    exception_status: { open: 'danger', in_progress: 'warning', resolved: 'success', waived: 'neutral' },
    checklist_state: { satisfied: 'success', missing: 'danger', unreviewed: 'warning', not_applicable: 'neutral' },
    container_return_status: { pending: 'warning', evidence_submitted: 'info', returned_verified: 'success', disputed: 'danger', waived: 'neutral' }
  };
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* ------------------------------------------------------------------
     Toolkit — one per section render (closes over the api object)
     ------------------------------------------------------------------ */
  function kit(api) {
    var el = api.el;
    function t(k, vars) { var key = 'opstx.' + k, s = api.t(key, vars); return s === key ? k : s; }
    // own labels first (G3 domains), then admin.js' labels (operational_status, document_kind, …)
    function L(domain, code) {
      if (code == null || code === '') return t('none');
      var key = 'opstx.lbl_' + domain + '_' + code, s = api.t(key);
      return s !== key ? s : api.label(domain, code);
    }
    var BADGE_CLS = { success: 'success', warning: 'warning', danger: 'danger', info: 'blue', brand: 'teal', neutral: 'muted' };
    // the original style.css badge (.badge.badge-<colour>, no dot), as admin.js badgeCls()
    function pill(tone, text) { return el('span', { class: 'badge badge-' + (BADGE_CLS[tone] || 'muted'), 'data-tone': tone || 'neutral', text: text }); }
    function badge(domain, code) { return pill((TONES[domain] || {})[code] || 'info', L(domain, code)); }
    function ltr(v) { return v ? el('bdi', { dir: 'ltr', class: 'num', text: String(v) }) : t('none'); }
    function when(v, time) { return v ? api.fmtDate(v, !!time) : t('none'); }
    function btn(label, cls, onClick, attrs) {
      var b = el('button', Object.assign({ class: 'btn btn-sm ' + (cls || 'btn-ghost'), type: 'button' }, attrs || {}), label);
      if (onClick) b.addEventListener('click', function (e) { e.preventDefault(); onClick(b, e); });
      return b;
    }
    function alertBox(type, text) { return el('div', { class: 'alert alert-' + type, role: type === 'danger' ? 'alert' : 'status' }, el('div', { text: text })); }
    function card(title, body, actions, cls) {
      return el('section', { class: 'app-card adm-card ops-tx-card' + (cls ? ' ' + cls : '') }, [
        el('header', { class: 'app-card-head adm-card-head' }, [el('h3', { class: 'app-card-title', text: title }),
          actions && actions.length ? el('div', { class: 'adm-card-actions' }, actions) : null]),
        el('div', { class: 'app-card-body adm-card-body' }, body)
      ]);
    }
    function empty(text) { return el('div', { class: 'empty-state is-compact' }, el('p', { text: text })); }
    function table(headers, rows, emptyText) {
      var body = el('tbody', null, rows.length ? rows : el('tr', { class: 'adm-empty-row' }, el('td', { colspan: headers.length }, empty(emptyText || t('none')))));
      // the original admin table (.table.table-striped.adm-table in .table-wrap), like the containers / documents tables
      return el('div', { class: 'table-wrap adm-table-wrap' }, el('table', { class: 'table table-striped adm-table' }, [
        el('thead', null, el('tr', null, headers.map(function (h) { return el('th', { scope: 'col', text: h }); }))), body
      ]));
    }
    function sub(text) { return text ? el('span', { class: 'adm-sub', text: text }) : null; }
    function actions(list) { return el('div', { class: 'adm-row-actions' }, list.filter(Boolean)); }
    // form field for api.modal forms: {name, label, type, value, req, hint, options:[[v,l]], full, ltr, max, rows, min, step}
    function field(o) {
      var id = 'opx-' + o.name, ctl;
      if (o.type === 'checkbox') {
        return el('div', { class: 'form-group' + (o.full ? ' adm-full' : '') }, [
          el('label', { class: 'check' }, [el('input', { type: 'checkbox', id: id, name: o.name, checked: !!o.value }), ' ', o.label]),
          o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null
        ]);
      }
      var common = { class: 'form-control', id: id, name: o.name, required: !!o.req, dir: o.ltr ? 'ltr' : null };
      if (o.type === 'select') {
        ctl = el('select', common, (o.options || []).map(function (p) { return el('option', { value: p[0], text: p[1] }); }));
        ctl.value = o.value == null ? '' : String(o.value);
      } else if (o.type === 'textarea') {
        ctl = el('textarea', Object.assign(common, { rows: o.rows || 2, maxlength: o.max || null }));
        ctl.value = o.value == null ? '' : String(o.value);
      } else {
        ctl = el('input', Object.assign(common, { type: o.type || 'text', maxlength: o.max || null, min: o.min != null ? o.min : null,
          step: o.step || null, autocomplete: 'off', value: o.value == null ? '' : o.value }));
      }
      return el('div', { class: 'form-group' + (o.full ? ' adm-full' : '') }, [
        el('label', { class: 'form-label', for: id }, [o.label, o.req ? el('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null]),
        ctl, o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null
      ]);
    }
    function grid(kids) { return el('div', { class: 'adm-form-grid' }, kids); }
    function codeOpts(domain, codes, blank) { return (blank ? [['', blank]] : []).concat(codes.map(function (c) { return [c, L(domain, c)]; })); }
    function val(form, name) { var e = form.elements[name]; if (!e) return null; if (e.type === 'checkbox') return e.checked; var v = String(e.value == null ? '' : e.value).trim(); return v === '' ? null : v; }
    function numVal(form, name) { var v = val(form, name); if (v == null) return null; var n = Number(String(v).replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); })); return isFinite(n) ? n : NaN; }
    // datetime-local ↔ ISO (local time)
    function toLocal(v) {
      if (!v) return '';
      var d = new Date(v); if (isNaN(d)) return '';
      var p = function (n) { return ('0' + n).slice(-2); };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function fromLocal(v) { if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
    // a modal result: error text keeps it open, success toasts + re-renders the transaction
    function settle(r, okText) {
      if (!r || r.error) return api.errText(r ? r.error : null);
      api.toast(okText || t('saved'), 'success');
      api.refresh();
      return true;
    }
    // idempotency key per modal, renewed when the payload changes (kept across retries of the same data)
    function idem() {
      var c = null;
      return function (payload) {
        var sig = JSON.stringify(payload);
        if (!c || c.sig !== sig) c = { sig: sig, key: api.newIdemKey ? api.newIdemKey() : null };
        return c.key;
      };
    }
    function rows(r) { var d = r && r.data; return Array.isArray(d) ? d : (d && (d.rows || d.items)) || []; }
    function daysTo(iso) {
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if (!m) return null;
      var d = new Date(+m[1], m[2] - 1, +m[3]), n = new Date(); n = new Date(n.getFullYear(), n.getMonth(), n.getDate());
      return Math.round((d - n) / 86400000);
    }
    return { el: el, t: t, L: L, pill: pill, badge: badge, ltr: ltr, when: when, btn: btn, alert: alertBox, card: card, empty: empty,
      table: table, sub: sub, actions: actions, field: field, grid: grid, codeOpts: codeOpts, val: val, numVal: numVal,
      toLocal: toLocal, fromLocal: fromLocal, settle: settle, idem: idem, rows: rows, daysTo: daysTo };
  }

  /* ------------------------------------------------------------------
     Lookups shared by the sections of one rendered transaction
     ------------------------------------------------------------------ */
  var MEMO = typeof WeakMap === 'function' ? new WeakMap() : null;
  function memo(tx, name, fn) {
    var bag;
    if (MEMO) { bag = MEMO.get(tx); if (!bag) { bag = {}; MEMO.set(tx, bag); } }
    else { bag = tx.__opstx || (tx.__opstx = {}); }   // very old browsers
    if (!bag[name]) bag[name] = Promise.resolve().then(fn).then(null, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
    return bag[name];
  }
  function M(api, name) {
    var f = api.MarsaApi && api.MarsaApi[name];
    if (typeof f !== 'function') return function () { return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', message: name } }); };
    return function () {
      var args = arguments;
      return Promise.resolve().then(function () { return f.apply(api.MarsaApi, args); })
        .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
    };
  }
  function docsOf(api, tx) {
    return memo(tx, 'docs', function () { return M(api, 'listDocuments')({ transactionId: tx.id }); })
      .then(function (r) { return (r.data || []).filter(function (d) { return d && !d.voided_at; }); });
  }
  function partiesOf(api, tx) {
    return memo(tx, 'parties', function () { return M(api, 'listParties')({ active: false, limit: 500 }); })
      .then(function (r) { return r.error ? [] : (r.data || []); });
  }
  function driversOf(api, tx) { return memo(tx, 'drivers', function () { return M(api, 'listDrivers')(null); }).then(function (r) { return r.error ? [] : (r.data || []); }); }
  function trucksOf(api, tx) { return memo(tx, 'trucks', function () { return M(api, 'listTrucks')(null); }).then(function (r) { return r.error ? [] : (r.data || []); }); }
  function blsOf(api, tx) { return memo(tx, 'bls', function () { return M(api, 'listBLs')(tx.id); }); }
  function partyName(api, list, id) {
    if (!id) return null;
    var p = list.filter(function (x) { return x.id === id; })[0];
    return p ? ((api.isEn && api.isEn() && p.name_en) || p.name_ar || p.name_en) : null;
  }
  function partyOpts(api, list, kind, blank, keep) {
    return [['', blank]].concat(list.filter(function (p) {
      return p.id === keep || (p.is_active !== false && (!kind || (p.kinds || []).indexOf(kind) !== -1));
    }).map(function (p) { return [p.id, (api.isEn && api.isEn() && p.name_en) || p.name_ar || p.name_en || p.id]; }));
  }
  function docOpts(docs, blank, kinds) {
    return [['', blank]].concat(docs.filter(function (d) { return !kinds || kinds.indexOf(d.classification || d.kind) !== -1; }).map(function (d) {
      return [d.id, (d.original_name || d.id) + (d.classification ? ' — ' + d.classification : '')];
    }));
  }
  function ctrOpts(k, tx, blank) {
    return [['', blank]].concat((tx.containers || []).map(function (c) { return [c.id, c.container_no]; }));
  }
  function ctrNo(tx, id) { var c = (tx.containers || []).filter(function (x) { return x.id === id; })[0]; return c ? c.container_no : null; }
  // shell for one section: card with a loading line, then fill(body) (async); failures stay inside the card
  function section(root, k, title, actionsList, fill, cls) {
    var body = k.el('div', { class: 'ops-tx-body' }, k.el('p', { class: 'text-sm text-muted', text: k.t('loading') }));
    root.appendChild(k.card(title, body, actionsList, cls));
    return Promise.resolve().then(function () { return fill(); }).then(function (kids) {
      body.textContent = '';
      if (!kids) return;
      var wrap = k.el('div', null, kids);   // el() flattens nested arrays / text
      while (wrap.firstChild) body.appendChild(wrap.firstChild);
    }, function (e) {
      body.textContent = '';
      body.appendChild(k.alert('danger', k.t('load_failed', { e: String(e && e.message || e) })));
    });
  }
  function loadErr(k, api, err) { return k.alert('warning', k.t('load_failed', { e: api.errText(err) })); }

  /* ==================================================================
     10 — completeness ring + missing list
     ================================================================== */
  function ring(k, score) {
    var NS = 'http://www.w3.org/2000/svg', r = 26, c = 2 * Math.PI * r;
    var pct = Math.max(0, Math.min(100, Math.round(+score || 0)));
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('width', '72'); svg.setAttribute('height', '72');
    svg.setAttribute('class', 'ops-ring'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', k.t('cmp_score', { n: pct }));
    function circle(cls, color, dash) {
      var n = document.createElementNS(NS, 'circle');
      n.setAttribute('cx', '32'); n.setAttribute('cy', '32'); n.setAttribute('r', String(r)); n.setAttribute('fill', 'none');
      n.setAttribute('stroke-width', '7'); n.setAttribute('stroke', color); n.setAttribute('class', cls);
      if (dash != null) { n.setAttribute('stroke-dasharray', dash + ' ' + c); n.setAttribute('stroke-linecap', 'round'); n.setAttribute('transform', 'rotate(-90 32 32)'); }
      return n;
    }
    svg.appendChild(circle('ops-ring-track', 'rgba(127,127,127,.22)', null));
    svg.appendChild(circle('ops-ring-fill', pct >= 80 ? '#1E9E6A' : pct >= 50 ? '#14A3A8' : '#D98E04', (c * pct / 100).toFixed(2)));
    var txt = document.createElementNS(NS, 'text');
    txt.setAttribute('x', '32'); txt.setAttribute('y', '37'); txt.setAttribute('text-anchor', 'middle'); txt.setAttribute('font-size', '15');
    txt.setAttribute('font-weight', '700'); txt.setAttribute('fill', 'currentColor'); txt.setAttribute('class', 'ops-ring-text');
    txt.textContent = pct + '%';
    svg.appendChild(txt);
    return svg;
  }
  function renderCompleteness(root, tx, api) {
    var k = kit(api), el = k.el;
    return section(root, k, k.t('cmp_title'), null, function () {
      return M(api, 'txCompleteness')(tx.id).then(function (r) {
        if (r.error) return loadErr(k, api, r.error);
        var d = r.data || {}, en = api.isEn && api.isEn();
        var missing = Array.isArray(d.missing) ? d.missing : [], ready = Array.isArray(d.ready_for) ? d.ready_for : [];
        var list = missing.length ? el('ul', { class: 'adm-list ops-missing' }, missing.map(function (m) {
          var isDoc = !!m.document || m.kind === 'document';
          var label = (en ? m.label_en : m.label_ar) || m.label_ar || m.label_en ||
            (isDoc ? k.L('document_kind', m.document) : String(m.field || ''));
          return el('li', null, [k.pill(isDoc ? 'warning' : 'info', isDoc ? k.t('cmp_document') : k.t('cmp_field')), ' ', el('span', { text: label })]);
        })) : el('p', { class: 'text-sm', text: k.t('cmp_none_missing') });
        var readyNode = ready.length ? el('div', { class: 'adm-chips-row' }, ready.map(function (s) { return k.pill('brand', k.L('operational_status', s)); }))
          : el('p', { class: 'text-sm text-muted', text: k.t('cmp_ready_none') });
        return [
          el('div', { class: 'ops-cmp' }, [ring(k, d.score), el('div', { class: 'ops-cmp-main' }, [
            el('strong', { text: k.t('cmp_score', { n: Math.round(+d.score || 0) }) }),
            el('span', { class: 'text-xs text-muted d-block', text: k.t('cmp_ready') }), readyNode
          ])]),
          el('h4', { class: 'ops-sub-title', text: k.t('cmp_missing') }), list,
          d.ready_limit === 'declaration_release' ? el('p', { class: 'form-hint', text: k.t('cmp_release_limit') }) : null,
          el('p', { class: 'form-hint', text: k.t('cmp_hint') })
        ];
      });
    }, 'ops-tx-completeness');
  }

  /* ==================================================================
     15 — document checklist per stage (+ upload / classify shortcuts)
     ================================================================== */
  function uploadShortcut(api, kind) {
    var form = document.querySelector('[data-form="doc-upload"]');
    if (!form) { api.toast(api.t('opstx.chk_no_upload'), 'warning'); return; }
    var sel = form.querySelector('[name=kind]');
    if (sel && kind) { sel.value = kind; if (sel.value !== kind) sel.value = 'other'; }
    try { form.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* old browsers */ }
    var f = form.querySelector('[name=file]'); if (f) f.focus();
  }
  function classifyShortcut(api, docId) {
    var b = docId && UUID_RE.test(docId) ? document.querySelector('[data-act="doc-classify"][data-id="' + docId + '"]') : null;
    if (b) { b.click(); return; }
    var form = document.querySelector('[data-form="doc-upload"]');
    var anchor = form ? form.closest('.app-card') : null;
    if (anchor) { try { anchor.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignore */ } }
  }
  function renderChecklist(root, tx, api) {
    var k = kit(api), el = k.el;
    var canStaff = api.can('staff', tx.branch_id);
    return section(root, k, k.t('chk_title'), null, function () {
      return M(api, 'txChecklist')(tx.id).then(function (r) {
        if (r.error) return loadErr(k, api, r.error);
        var list = k.rows(r).map(function (x) {
          var docs = x.document_ids || (x.document_id ? [x.document_id] : []);
          return { kind: x.document_kind || x.kind, stage: x.required_for_stage || x.stage, state: x.state || x.status || 'missing',
            optional: !!(x.optional || x.is_optional), note: x.note || null, docId: docs[0] || null };
        });
        if (!list.length) return [k.empty(k.t('chk_empty')), el('p', { class: 'form-hint', text: k.t('chk_hint') })];
        var cur = STAGES.indexOf(tx.operational_status), next = STAGES[cur + 1];
        var stages = STAGES.filter(function (s) { return list.some(function (x) { return x.stage === s; }); })
          .concat(list.map(function (x) { return x.stage; }).filter(function (s, i, a) { return STAGES.indexOf(s) === -1 && a.indexOf(s) === i; }));
        var out = stages.map(function (s) {
          var items = list.filter(function (x) { return x.stage === s; });
          return el('div', { class: 'ops-chk-stage' + (s === next ? ' is-next' : ''), 'data-stage': s }, [
            el('h4', { class: 'ops-sub-title' }, [k.t('chk_stage', { s: k.L('operational_status', s) }), s === next ? [' ', k.pill('brand', k.t('chk_next'))] : null]),
            el('ul', { class: 'adm-mini ops-chk-list' }, items.map(function (x) {
              var act = null;
              if (canStaff && x.state === 'missing') act = k.btn(k.t('chk_upload'), 'btn-secondary', function () { uploadShortcut(api, x.kind); });
              if (canStaff && x.state === 'unreviewed') act = k.btn(k.t('chk_classify'), 'btn-secondary', function () { classifyShortcut(api, x.docId); });
              return el('li', { class: 'adm-mini-row' }, [
                el('span', { class: 'adm-mini-main' }, [el('span', { class: 'adm-mini-title', text: k.L('document_kind', x.kind) }),
                  x.optional || x.note ? el('span', { class: 'adm-mini-sub', text: [x.optional ? k.t('chk_optional') : null, x.note].filter(Boolean).join(' · ') }) : null]),
                el('span', { class: 'adm-mini-side' }, [k.badge('checklist_state', x.state), act ? ' ' : null, act])
              ]);
            }))
          ]);
        });
        out.push(el('p', { class: 'form-hint', text: k.t('chk_hint') }));
        return out;
      });
    }, 'ops-tx-checklist');
  }

  /* ==================================================================
     20 — customs declarations (add · status · correct · cancel + replace)
     ================================================================== */
  var DECL_NO_RE = /^[A-Za-z0-9\/-]{1,30}$/;
  function declFields(k, docs, d) {
    d = d || {};
    return [
      k.field({ name: 'declaration_no', label: k.t('dec_no'), value: d.declaration_no, req: true, ltr: true, max: 30 }),
      k.field({ name: 'declaration_type', label: k.t('dec_type'), value: d.declaration_type, max: 40 }),
      k.field({ name: 'declaration_date', label: k.t('dec_date'), type: 'date', value: d.declaration_date }),
      k.field({ name: 'source', label: k.t('dec_source'), type: 'select', value: d.source || 'manual', options: k.codeOpts('declaration_source', DEC_SOURCE) }),
      k.field({ name: 'source_document_id', label: k.t('dec_source_doc'), type: 'select', value: d.source_document_id, options: docOpts(docs, k.t('optional_none')), full: true })
    ];
  }
  function declPayload(k, form, prefix) {
    var p = function (n) { return k.val(form, (prefix || '') + n); };
    return { declaration_no: p('declaration_no') ? p('declaration_no').toUpperCase() : null, declaration_type: p('declaration_type'),
      declaration_date: p('declaration_date'), source: p('source') || 'manual', source_document_id: p('source_document_id') };
  }
  function renderDeclarations(root, tx, api) {
    var k = kit(api), el = k.el;
    var canW = api.can('opsWriter', tx.branch_id);
    var docsP = docsOf(api, tx);
    function addDialog() {
      docsP.then(function (docs) {
        var key = k.idem();
        api.modal({
          title: k.t('dec_add'), submitText: k.t('dec_add'), wide: true,
          body: [k.grid(declFields(k, docs).concat([
            k.field({ name: 'status', label: k.t('dec_status'), type: 'select', value: 'submitted', options: k.codeOpts('declaration_status', DEC_SETTABLE) }),
            k.field({ name: 'notes', label: k.t('dec_notes'), type: 'textarea', max: 1000, full: true })
          ])), el('p', { class: 'form-hint', text: k.t('dec_hint') })],
          onSubmit: function (form) {
            var p = declPayload(k, form);
            p.status = k.val(form, 'status') || 'submitted'; p.notes = k.val(form, 'notes');
            if (!p.declaration_no) return k.t('required');
            if (!DECL_NO_RE.test(p.declaration_no)) return k.t('dec_bad_no');
            return M(api, 'addDeclaration')(tx.id, p, { idemKey: key(p) }).then(function (r) { return k.settle(r, k.t('dec_added')); });
          }
        });
      });
    }
    function statusDialog(d) {
      api.modal({
        title: k.t('dec_set_status') + ' — ' + d.declaration_no, submitText: k.t('dec_set_status'),
        body: k.grid([
          k.field({ name: 'status', label: k.t('dec_new_status'), type: 'select', req: true, value: '',
            options: [['', k.t('choose')]].concat(DEC_SETTABLE.filter(function (s) { return s !== d.status; }).map(function (s) { return [s, k.L('declaration_status', s)]; })) }),
          k.field({ name: 'note', label: k.t('note'), type: 'textarea', max: 1000, full: true })
        ]),
        onSubmit: function (form) {
          var s = k.val(form, 'status');
          if (!s) return k.t('required');
          return M(api, 'setDeclarationStatus')(d.id, s, k.val(form, 'note')).then(function (r) { return k.settle(r, k.t('dec_status_saved')); });
        }
      });
    }
    function correctDialog(d) {
      docsP.then(function (docs) {
        api.modal({
          title: k.t('dec_correct_title', { n: d.declaration_no }), submitText: k.t('dec_correct'), wide: true,
          body: [k.alert('info', k.t('dec_correct_hint')), k.grid(declFields(k, docs, d).filter(function (g) { return !g.querySelector('[name=source]'); }).concat([
            k.field({ name: 'reason', label: k.t('reason'), type: 'textarea', req: true, max: 1000, full: true })
          ]))],
          onSubmit: function (form) {
            var p = declPayload(k, form), why = k.val(form, 'reason');
            delete p.source;   // correct_declaration takes number / type / date / notes / source document only
            if (!p.declaration_no) return k.t('required');
            if (!DECL_NO_RE.test(p.declaration_no)) return k.t('dec_bad_no');
            if (!why) return k.t('reason_required');
            return M(api, 'correctDeclaration')(d.id, p, why).then(function (r) { return k.settle(r, k.t('dec_correct_done')); });
          }
        });
      });
    }
    function cancelDialog(d) {
      docsP.then(function (docs) {
        var repl = el('div', { class: 'ops-dec-repl', hidden: true }, k.grid(declFields(k, docs, { source: 'manual' }).map(function (g) {
          // the replacement's fields carry the prefix 'r_' (one form holds both)
          Array.prototype.forEach.call(g.querySelectorAll('[name]'), function (n) { n.name = 'r_' + n.name; n.id = 'opx-r_' + n.name.slice(2); n.required = false; });
          Array.prototype.forEach.call(g.querySelectorAll('label[for]'), function (l) { l.setAttribute('for', 'opx-r_' + l.getAttribute('for').slice(4)); });
          return g;
        })));
        var chk = k.field({ name: 'replace', label: k.t('dec_replace'), type: 'checkbox', full: true, hint: k.t('dec_replace_hint') });
        chk.querySelector('input').addEventListener('change', function (e) { repl.hidden = !e.target.checked; });
        api.modal({
          title: k.t('dec_cancel_title', { n: d.declaration_no }), submitText: k.t('dec_cancel'), danger: true, wide: true,
          body: [k.grid([k.field({ name: 'reason', label: k.t('reason'), type: 'textarea', req: true, max: 500, full: true }), chk]), repl],
          onSubmit: function (form) {
            var why = k.val(form, 'reason'), replacement = null;
            if (!why) return k.t('reason_required');
            if (k.val(form, 'replace')) {
              replacement = declPayload(k, form, 'r_');
              if (!replacement.declaration_no) return k.t('required');
              if (!DECL_NO_RE.test(replacement.declaration_no)) return k.t('dec_bad_no');
            }
            return M(api, 'cancelDeclaration')(d.id, why, replacement).then(function (r) { return k.settle(r, k.t(replacement ? 'dec_replace_done' : 'dec_cancel_done')); });
          }
        });
      });
    }
    return section(root, k, k.t('dec_title'), canW ? [k.btn(k.t('dec_add'), 'btn-primary', addDialog)] : null, function () {
      return M(api, 'listDeclarations')(tx.id).then(function (r) {
        if (r.error) return loadErr(k, api, r.error);
        var list = k.rows(r);
        var byId = {}; list.forEach(function (d) { byId[d.id] = d; });
        if (!list.length) return [k.empty(k.t('dec_empty')), el('p', { class: 'form-hint', text: k.t('dec_hint') })];
        var ol = el('ol', { class: 'timeline adm-timeline ops-dec-list' }, list.map(function (d, i) {
          var active = ['cancelled', 'replaced'].indexOf(d.status) === -1;
          var prev = list.filter(function (x) { return x.replaced_by_id === d.id; })[0];
          var meta = [d.declaration_type, d.declaration_date ? k.when(d.declaration_date) : null, k.L('declaration_source', d.source)].filter(Boolean).join(' · ');
          var notes = [];
          if (prev) notes.push(k.t('dec_replaces', { n: prev.declaration_no }));
          if (d.corrected_at) notes.push(k.t('dec_corrected', { d: k.when(d.corrected_at, true) }));
          if (d.cancelled_at) notes.push(k.t('dec_cancelled', { d: k.when(d.cancelled_at, true), r: d.cancel_reason || k.t('none') }));
          if (d.replaced_by_id) notes.push(k.t('dec_replaced_by', { n: byId[d.replaced_by_id] ? byId[d.replaced_by_id].declaration_no : k.t('none') }));
          return el('li', { class: active && i === 0 ? 'is-current' : 'is-done' }, [
            el('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
            el('span', { class: 'tl-title' }, [k.ltr(d.declaration_no), ' ', k.badge('declaration_status', d.status)]),
            meta ? el('span', { class: 'adm-tl-note', text: meta }) : null,
            notes.length ? el('span', { class: 'adm-tl-note', text: notes.join(' · ') }) : null,
            d.notes ? el('span', { class: 'adm-tl-note adm-pre', text: d.notes }) : null,
            el('span', { class: 'tl-meta', text: (api.who ? api.who(d.created_by) + ' · ' : '') + k.when(d.created_at, true) }),
            canW && active ? k.actions([
              k.btn(k.t('dec_set_status'), 'btn-ghost', function () { statusDialog(d); }),
              k.btn(k.t('dec_correct'), 'btn-ghost', function () { correctDialog(d); }),
              k.btn(k.t('dec_cancel'), 'btn-ghost adm-text-danger', function () { cancelDialog(d); })
            ]) : null
          ]);
        }));
        return [ol, el('p', { class: 'form-hint', text: k.t('dec_hint') })];
      });
    }, 'ops-tx-declarations');
  }

  /* ==================================================================
     30 — bills of lading (link existing / create · primary · unlink)
     ================================================================== */
  function renderBLs(root, tx, api) {
    var k = kit(api), el = k.el;
    var canW = api.can('opsWriter', tx.branch_id);
    var current = [];
    function linkDialog() {
      var input = el('input', { class: 'form-control', type: 'search', dir: 'ltr', maxlength: 40, 'aria-label': k.t('bl_search'), placeholder: k.t('bl_search') });
      var results = el('div', { class: 'ops-bl-results', 'aria-live': 'polite' });
      var primary = k.field({ name: 'primary', label: k.t('bl_set_primary'), type: 'checkbox', value: !current.length, full: true });
      function search() {
        results.textContent = '';
        results.appendChild(el('p', { class: 'text-sm text-muted', text: k.t('loading') }));
        M(api, 'listBLs')({ search: input.value, limit: 20 }).then(function (r) {
          results.textContent = '';
          if (r.error) { results.appendChild(loadErr(k, api, r.error)); return; }
          var list = k.rows(r);
          if (!list.length) { results.appendChild(k.empty(k.t('bl_search_none'))); return; }
          results.appendChild(el('ul', { class: 'adm-mini' }, list.map(function (b) {
            var linked = current.some(function (x) { return x.id === b.id; });
            return el('li', { class: 'adm-mini-row' }, [
              el('span', { class: 'adm-mini-main' }, [el('span', { class: 'adm-mini-title' }, [k.ltr(b.bl_number), ' · ', k.L('bl_type', b.bl_type)]),
                el('span', { class: 'adm-mini-sub', text: [b.vessel, b.voyage, b.port_of_loading && b.port_of_discharge ? b.port_of_loading + ' → ' + b.port_of_discharge : null].filter(Boolean).join(' · ') })]),
              el('span', { class: 'adm-mini-side' }, linked ? k.pill('neutral', k.t('bl_already')) : k.btn(k.t('bl_link_btn'), 'btn-secondary', function (btn) {
                btn.disabled = true;
                var form = btn.closest('form');
                var prim = form && form.elements.primary ? form.elements.primary.checked : false;
                M(api, 'linkBL')(tx.id, b.id, prim).then(function (lr) {
                  btn.disabled = false;
                  if (lr.error) { api.toast(api.errText(lr.error), 'error'); return; }
                  if (lr.data && lr.data.shared_with_other_client) api.toast(k.t('bl_shared_warn'), 'warning');
                  else api.toast(k.t('bl_linked'), 'success');
                  if (dlg && dlg.close) dlg.close();
                  api.refresh();
                });
              }))
            ]);
          })));
        });
      }
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); search(); } });
      var dlg = api.modal({
        title: k.t('bl_link'), noSubmit: true, wide: true,
        body: [el('div', { class: 'adm-inline-row' }, [input, k.btn(k.t('bl_search_btn'), 'btn-secondary', search)]), k.grid([primary]), results, el('p', { class: 'form-hint', text: k.t('bl_hint') })],
        onOpen: function () { search(); }
      });
    }
    function newDialog() {
      partiesOf(api, tx).then(function (parties) {
        var key = k.idem();
        api.modal({
          title: k.t('bl_new'), submitText: k.t('bl_new'), wide: true,
          body: k.grid([
            k.field({ name: 'bl_number', label: k.t('bl_no'), req: true, ltr: true, max: 40, value: current.length ? '' : (tx.bl_number || '') }),
            k.field({ name: 'bl_type', label: k.t('bl_type'), type: 'select', value: tx.mode === 'air' ? 'awb' : 'master', options: k.codeOpts('bl_type', BL_TYPES) }),
            k.field({ name: 'shipping_agent_id', label: k.t('bl_agent'), type: 'select', options: partyOpts(api, parties, 'shipping_agent', k.t('optional_none')) }),
            k.field({ name: 'carrier_name', label: k.t('bl_carrier'), max: 120, value: tx.shipping_line }),
            k.field({ name: 'vessel', label: k.t('bl_vessel'), max: 80 }),
            k.field({ name: 'voyage', label: k.t('bl_voyage'), ltr: true, max: 40 }),
            k.field({ name: 'port_of_loading', label: k.t('bl_pol'), max: 80, value: tx.port_of_loading }),
            k.field({ name: 'port_of_discharge', label: k.t('bl_pod'), max: 80, value: tx.port_of_discharge }),
            k.field({ name: 'origin_country', label: k.t('bl_origin'), max: 80, value: tx.country }),
            k.field({ name: 'issued_at', label: k.t('bl_issued'), type: 'date' }),
            k.field({ name: 'packages', label: k.t('bl_packages'), type: 'number', min: 0, step: 1 }),
            k.field({ name: 'gross_weight_kg', label: k.t('bl_weight'), type: 'number', min: 0, step: 'any' }),
            k.field({ name: 'goods_description', label: k.t('bl_goods'), type: 'textarea', max: 1000, full: true, value: tx.goods_description }),
            k.field({ name: 'notes', label: k.t('bl_notes'), type: 'textarea', max: 1000, full: true }),
            k.field({ name: 'primary', label: k.t('bl_set_primary'), type: 'checkbox', value: !current.length, full: true })
          ]),
          onSubmit: function (form) {
            var p = {};
            ['bl_number', 'bl_type', 'shipping_agent_id', 'carrier_name', 'vessel', 'voyage', 'port_of_loading', 'port_of_discharge', 'origin_country',
              'issued_at', 'goods_description', 'notes'].forEach(function (n) { p[n] = k.val(form, n); });
            if (!p.bl_number) return k.t('required');
            p.bl_number = p.bl_number.toUpperCase();
            p.packages = k.numVal(form, 'packages'); p.gross_weight_kg = k.numVal(form, 'gross_weight_kg');
            if ((p.packages != null && (isNaN(p.packages) || p.packages < 0)) || (p.gross_weight_kg != null && (isNaN(p.gross_weight_kg) || p.gross_weight_kg < 0))) return k.t('trp_amount_bad');
            var prim = !!k.val(form, 'primary');
            p.transaction_id = tx.id; p.primary = prim;   // save_bl links in the same server transaction
            return M(api, 'saveBL')(p, { idemKey: key(p) }).then(function (r) {
              if (r.error) {
                if (r.error.code === 'DUPLICATE') return k.t('bl_dup');
                return (r.error.field || (r.error.raw && r.error.raw.details)) === 'bl_other_branch' ? k.t('bl_other_branch') : api.errText(r.error);
              }
              var id = r.data && (r.data.id || r.data.bl_id);
              var done = function (x) {
                if (!x.error && x.data && x.data.shared_with_other_client) { api.toast(k.t('bl_shared_warn'), 'warning'); api.refresh(); return true; }
                return k.settle(x, k.t('bl_saved'));
              };
              if (r.data && r.data.linked) return done(r);
              return M(api, 'linkBL')(tx.id, id, prim).then(done);
            });
          }
        });
      });
    }
    function unlinkDialog(b) {
      api.modal({
        title: k.t('bl_unlink_title', { n: b.bl_number }), submitText: k.t('bl_unlink'), danger: true,
        body: k.grid([k.field({ name: 'reason', label: k.t('reason'), type: 'textarea', req: true, max: 1000, full: true })]),
        onSubmit: function (form) {
          var why = k.val(form, 'reason');
          if (!why) return k.t('reason_required');
          return M(api, 'unlinkBL')(tx.id, b.id, why).then(function (r) { return k.settle(r, k.t('bl_unlinked')); });
        }
      });
    }
    var acts = canW ? [k.btn(k.t('bl_link'), 'btn-secondary', linkDialog), k.btn(k.t('bl_new'), 'btn-primary', newDialog)] : null;
    return section(root, k, k.t('bl_title'), acts, function () {
      return Promise.all([blsOf(api, tx), partiesOf(api, tx)]).then(function (res) {
        var r = res[0], parties = res[1];
        if (r.error) return loadErr(k, api, r.error);
        current = k.rows(r);
        var trs = current.map(function (b) {
          return el('tr', null, [
            el('td', null, [k.ltr(b.bl_number), b.is_primary ? [' ', k.pill('brand', k.t('bl_primary'))] : null, k.sub(partyName(api, parties, b.shipping_agent_id) || b.carrier_name)]),
            el('td', { text: k.L('bl_type', b.bl_type) }),
            el('td', { text: [b.vessel, b.voyage].filter(Boolean).join(' / ') || k.t('none') }),
            el('td', { text: [b.port_of_loading, b.port_of_discharge].filter(Boolean).join(api.isEn && api.isEn() ? ' → ' : ' ← ') || k.t('none') }),
            el('td', { class: 'num', text: [b.packages != null ? b.packages : null, b.gross_weight_kg != null ? b.gross_weight_kg + ' kg' : null].filter(function (x) { return x != null; }).join(' · ') || k.t('none') }),
            el('td', null, canW ? k.actions([
              b.is_primary ? null : k.btn(k.t('bl_make_primary'), 'btn-ghost', function (btn) {
                btn.disabled = true;
                M(api, 'linkBL')(tx.id, b.id, true).then(function (lr) { btn.disabled = false; if (lr.error) return api.toast(api.errText(lr.error), 'error'); api.toast(k.t('bl_primary_done'), 'success'); api.refresh(); });
              }),
              k.btn(k.t('bl_unlink'), 'btn-ghost adm-text-danger', function () { unlinkDialog(b); })
            ]) : null)
          ]);
        });
        return [k.table([k.t('bl_no'), k.t('bl_type'), k.t('bl_vessel'), k.t('bl_route'), k.t('bl_packages') + ' / ' + k.t('bl_weight'), ''], trs, k.t('bl_empty')),
          el('p', { class: 'form-hint', text: k.t('bl_hint') })];
      });
    }, 'ops-tx-bls');
  }

  /* ==================================================================
     40 — containers (state, seal, B/L, visit history) + empty-return panel
     ================================================================== */
  function renderContainers(root, tx, api) {
    var k = kit(api), el = k.el;
    var canTr = api.can('transportWriter', tx.branch_id);
    var list = (tx.containers || []).slice().sort(function (a, b) { return String(a.container_no) < String(b.container_no) ? -1 : 1; });
    function editDialog(c, bls) {
      api.modal({
        title: k.t('ctr_edit_title', { n: c.container_no }), submitText: k.t('save'), wide: true,
        body: [k.grid([
          k.field({ name: 'operational_state', label: k.t('ctr_state'), type: 'select', value: c.operational_state || 'expected',
            options: k.codeOpts('container_state', CTR_STATES.filter(function (st) {
              // the server refuses empty_returned without a verified receipt / waiver (MRS_EVIDENCE_INVALID)
              return st !== 'empty_returned' || c.operational_state === 'empty_returned' || c.return_status === 'returned_verified' || c.return_status === 'waived';
            })) }),
          k.field({ name: 'seal_no', label: k.t('ctr_seal'), ltr: true, max: 30, value: c.seal_no }),
          k.field({ name: 'size_type', label: k.t('ctr_size'), ltr: true, max: 10, value: c.size_type }),
          k.field({ name: 'gross_weight_kg', label: k.t('ctr_weight'), type: 'number', min: 0, step: 'any', value: c.gross_weight_kg }),
          k.field({ name: 'bl_id', label: k.t('ctr_bl'), type: 'select', value: c.bl_id, full: true,
            options: [['', k.t('optional_none')]].concat(bls.map(function (b) { return [b.id, b.bl_number + ' · ' + k.L('bl_type', b.bl_type)]; })) })
        ]), el('p', { class: 'form-hint', text: k.t('ctr_state_hint') })],
        onSubmit: function (form) {
          var w = k.numVal(form, 'gross_weight_kg');
          if (w != null && (isNaN(w) || w < 0)) return k.t('trp_amount_bad');
          var patch = { operational_state: k.val(form, 'operational_state') || 'expected', seal_no: k.val(form, 'seal_no'),
            size_type: k.val(form, 'size_type'), gross_weight_kg: w, bl_id: k.val(form, 'bl_id') };
          if (patch.seal_no) patch.seal_no = patch.seal_no.toUpperCase();
          return M(api, 'updateContainer')(c.id, patch).then(function (r) { return k.settle(r, k.t('ctr_saved')); });
        }
      });
    }
    function returnDialog(c, docs, parties) {
      api.modal({
        title: k.t('ret_edit_title', { n: c.container_no }), submitText: k.t('save'), wide: true,
        body: [k.grid([
          k.field({ name: 'return_deadline', label: k.t('ret_deadline'), type: 'date', value: c.return_deadline }),
          k.field({ name: 'return_yard_party_id', label: k.t('ret_yard'), type: 'select', value: c.return_yard_party_id,
            options: partyOpts(api, parties, 'yard', k.t('optional_none'), c.return_yard_party_id) }),
          k.field({ name: 'return_location', label: k.t('ret_location'), max: 120, value: c.return_location }),
          k.field({ name: 'return_instruction_document_id', label: k.t('ret_instruction'), type: 'select', value: c.return_instruction_document_id, full: true,
            options: docOpts(docs, k.t('ret_no_instruction')), hint: k.t('ret_instruction_hint') })
        ])],
        onSubmit: function (form) {
          var p = { return_deadline: k.val(form, 'return_deadline'), return_yard_party_id: k.val(form, 'return_yard_party_id'),
            return_location: k.val(form, 'return_location'), return_instruction_document_id: k.val(form, 'return_instruction_document_id') };
          // evidence_received_at is stamped by the server when the evidence document is attached (not editable here)
          return M(api, 'setContainerReturn')(c.id, p).then(function (r) { return k.settle(r, k.t('ret_saved')); });
        }
      });
    }
    function historyDialog(c) {
      var box = el('div', null, el('p', { class: 'text-sm text-muted', text: k.t('loading') }));
      api.modal({ title: k.t('hist_title', { n: c.container_no }), noSubmit: true, wide: true, body: [box, el('p', { class: 'form-hint', text: k.t('hist_hint') })] });
      M(api, 'containerHistory')(c.container_no).then(function (r) {
        box.textContent = '';
        if (r.error) { box.appendChild(loadErr(k, api, r.error)); return; }
        var visits = k.rows(r);
        if (!visits.length) { box.appendChild(k.empty(k.t('hist_empty'))); return; }
        box.appendChild(k.table([k.t('ctr_visit', { v: '' }).trim(), k.t('ctr_state'), k.t('ret_status'), k.t('ret_deadline')], visits.map(function (v) {
          var txId = v.transaction_id, ref = v.transaction_ref || v.ref || (v.transactions && v.transactions.ref) || v.visit_ref;
          var mine = txId === tx.id;
          return el('tr', null, [
            el('td', null, [txId && UUID_RE.test(txId) && !mine ? el('a', { class: 'adm-ref', href: '#tx/' + txId }, k.ltr(ref || txId.slice(0, 8))) : k.ltr(ref),
              mine ? [' ', k.pill('brand', k.t('hist_this'))] : null, k.sub(v.visit_ref && v.visit_ref !== ref ? v.visit_ref : null)]),
            el('td', null, v.operational_state ? k.badge('container_state', v.operational_state) : k.t('none')),
            el('td', null, v.return_status ? k.badge('container_return_status', v.return_status) : k.t('none')),
            el('td', { text: v.return_deadline ? k.when(v.return_deadline) : k.t('none') })
          ]);
        })));
      });
    }
    function dueText(iso) {
      var n = k.daysTo(iso);
      if (n == null) return null;
      return n < 0 ? k.t('ret_late', { n: -n }) : n === 0 ? k.t('ret_today') : k.t('ret_in', { n: n });
    }
    return section(root, k, k.t('ctr_title'), null, function () {
      if (!list.length) return k.empty(k.t('ctr_empty'));
      return Promise.all([blsOf(api, tx), docsOf(api, tx), partiesOf(api, tx)]).then(function (res) {
        var bls = res[0].error ? [] : k.rows(res[0]), docs = res[1], parties = res[2];
        function blNo(id) { var b = bls.filter(function (x) { return x.id === id; })[0]; return b ? b.bl_number : null; }
        function docName(id) { var d = docs.filter(function (x) { return x.id === id; })[0]; return d ? d.original_name : null; }
        var ops = k.table([k.t('ctr_no'), k.t('ctr_size'), k.t('ctr_seal'), k.t('ctr_bl'), k.t('ctr_state'), ''], list.map(function (c) {
          return el('tr', null, [
            el('td', null, [k.ltr(c.container_no), k.sub(c.visit_ref)]),
            el('td', { text: c.size_type || (c.container_type ? k.L('container_type', c.container_type) : k.t('none')) }),
            el('td', null, k.ltr(c.seal_no)),
            el('td', null, k.ltr(blNo(c.bl_id))),
            el('td', null, k.badge('container_state', c.operational_state || 'expected')),
            el('td', null, k.actions([
              canTr ? k.btn(k.t('ctr_edit'), 'btn-ghost', function () { editDialog(c, bls); }) : null,
              k.btn(k.t('ctr_history'), 'btn-ghost', function () { historyDialog(c); })
            ]))
          ]);
        }), k.t('ctr_empty'));
        var ret = k.table([k.t('ctr_no'), k.t('ret_deadline'), k.t('ret_yard'), k.t('ret_instruction'), k.t('ret_evidence'), ''], list.map(function (c) {
          var open = OPEN_RETURN.indexOf(c.return_status || 'pending') !== -1;
          var n = k.daysTo(c.return_deadline), due = open ? dueText(c.return_deadline) : null;
          var ev = c.evidence_document_id ? docName(c.evidence_document_id) : null;
          return el('tr', null, [
            el('td', null, k.ltr(c.container_no)),
            el('td', null, [c.return_deadline ? k.when(c.return_deadline) : k.t('none'),
              due ? [' ', k.pill(n < 0 ? 'danger' : n <= 3 ? 'warning' : 'neutral', due)] : null]),
            el('td', null, [partyName(api, parties, c.return_yard_party_id) || k.t('none'), k.sub(c.return_location)]),
            el('td', { text: c.return_instruction_document_id ? (docName(c.return_instruction_document_id) || k.t('none')) : k.t('ret_no_instruction') }),
            el('td', null, [k.badge('container_return_status', c.return_status || 'pending'),
              k.sub(ev ? k.t('ret_evidence_doc', { d: ev }) : (c.return_status === 'waived' ? c.waiver_reason : k.t('ret_no_evidence'))),
              c.evidence_received_at ? k.sub(k.t('ret_received') + ': ' + k.when(c.evidence_received_at, true)) : null]),
            el('td', null, canTr ? k.btn(k.t('ctr_return'), 'btn-ghost', function () { returnDialog(c, docs, parties); }) : null)
          ]);
        }));
        return [ops, el('h4', { class: 'ops-sub-title', text: k.t('ret_title') }), ret, el('p', { class: 'form-hint', text: k.t('ret_instruction_hint') })];
      });
    }, 'ops-tx-containers');
  }

  /* ==================================================================
     50 — port appointments (create · confirm · reschedule chain · cancel)
     ================================================================== */
  function renderAppointments(root, tx, api) {
    var k = kit(api), el = k.el;
    var canTr = api.can('transportWriter', tx.branch_id);
    function lookups() { return Promise.all([partiesOf(api, tx), driversOf(api, tx), trucksOf(api, tx)]); }
    function personOpts(drivers) { return [['', k.t('optional_none')]].concat(drivers.filter(function (d) { return d.is_active !== false; }).map(function (d) { return [d.id, d.full_name + (d.phone ? ' · ' + d.phone : '')]; })); }
    function truckOpts(trucks) { return [['', k.t('optional_none')]].concat(trucks.filter(function (x) { return x.is_active !== false; }).map(function (x) { return [x.id, x.plate_no]; })); }
    function apptFields(L3, a, withStatus) {
      a = a || {};
      var f = [
        k.field({ name: 'appointment_at', label: k.t('apt_at'), type: 'datetime-local', req: true, value: k.toLocal(a.appointment_at) }),
        k.field({ name: 'window_minutes', label: k.t('apt_window'), type: 'number', min: 0, step: 5, value: a.window_minutes != null ? a.window_minutes : 60 }),
        k.field({ name: 'appointment_no', label: k.t('apt_no'), ltr: true, max: 40, value: a.appointment_no }),
        k.field({ name: 'driver_id', label: k.t('apt_driver'), type: 'select', value: a.driver_id, options: personOpts(L3[1]) }),
        k.field({ name: 'truck_id', label: k.t('apt_truck'), type: 'select', value: a.truck_id, options: truckOpts(L3[2]) })
      ];
      if (withStatus) {
        f.unshift(k.field({ name: 'terminal_party_id', label: k.t('apt_terminal'), type: 'select', value: a.terminal_party_id, options: partyOpts(api, L3[0], 'terminal_operator', k.t('optional_none')) }));
        f.unshift(k.field({ name: 'container_id', label: k.t('apt_container'), type: 'select', value: a.container_id, options: ctrOpts(k, tx, k.t('all_containers')) }));
        f.push(k.field({ name: 'status', label: k.t('apt_status'), type: 'select', value: 'requested', options: k.codeOpts('appt_status', ['requested', 'confirmed']) }));
      }
      return f;
    }
    function apptPayload(form) {
      var w = k.numVal(form, 'window_minutes');
      return { appointment_at: k.fromLocal(k.val(form, 'appointment_at')), window_minutes: w == null || isNaN(w) ? null : Math.round(w),
        appointment_no: k.val(form, 'appointment_no'), driver_id: k.val(form, 'driver_id'), truck_id: k.val(form, 'truck_id') };
    }
    function createDialog() {
      lookups().then(function (L3) {
        var key = k.idem();
        api.modal({
          title: k.t('apt_add'), submitText: k.t('apt_add'), wide: true, body: [k.grid(apptFields(L3, null, true)), el('p', { class: 'form-hint', text: k.t('apt_hint') })],
          onSubmit: function (form) {
            var p = apptPayload(form);
            if (!p.appointment_at) return k.t('required');
            p.transaction_id = tx.id; p.container_id = k.val(form, 'container_id'); p.terminal_party_id = k.val(form, 'terminal_party_id');
            p.status = k.val(form, 'status') || 'requested';
            return M(api, 'createAppointment')(p, { idemKey: key(p) }).then(function (r) { return k.settle(r, k.t('apt_saved')); });
          }
        });
      });
    }
    function rescheduleDialog(a) {
      lookups().then(function (L3) {
        var key = k.idem();
        api.modal({
          title: k.t('apt_resched_title'), submitText: k.t('apt_reschedule'), wide: true,
          body: [k.alert('info', k.t('apt_resched_hint')), k.grid(apptFields(L3, Object.assign({}, a, { appointment_at: null }), false).concat([
            k.field({ name: 'reason', label: k.t('reason'), type: 'textarea', req: true, max: 500, full: true })]))],
          onSubmit: function (form) {
            var p = apptPayload(form), why = k.val(form, 'reason');
            if (!p.appointment_at) return k.t('required');
            if (!why) return k.t('reason_required');
            return M(api, 'rescheduleAppointment')(a.id, p, why, { idemKey: key({ p: p, why: why }) }).then(function (r) { return k.settle(r, k.t('apt_resched_done')); });
          }
        });
      });
    }
    function statusDialog(a, s, needReason) {
      api.modal({
        title: k.t('apt_status_title', { s: k.L('appt_status', s), d: k.when(a.appointment_at, true) }), submitText: k.L('appt_status', s), danger: s === 'cancelled' || s === 'missed',
        body: k.grid([k.field({ name: 'reason', label: k.t('reason'), type: 'textarea', req: needReason, max: 500, full: true })]),
        onSubmit: function (form) {
          var why = k.val(form, 'reason');
          if (needReason && !why) return k.t('reason_required');
          return M(api, 'setAppointmentStatus')(a.id, s, why).then(function (r) { return k.settle(r, k.t('apt_status_done')); });
        }
      });
    }
    function quick(a, s, btn) {
      btn.disabled = true;
      M(api, 'setAppointmentStatus')(a.id, s, null).then(function (r) {
        btn.disabled = false;
        if (r.error) return api.toast(api.errText(r.error), 'error');
        api.toast(k.t('apt_status_done'), 'success'); api.refresh();
      });
    }
    return section(root, k, k.t('apt_title'), canTr ? [k.btn(k.t('apt_add'), 'btn-primary', createDialog)] : null, function () {
      return Promise.all([M(api, 'listAppointments')({ txId: tx.id }), lookups()]).then(function (res) {
        var r = res[0], L3 = res[1];
        if (r.error) return loadErr(k, api, r.error);
        var list = k.rows(r), byId = {};
        list.forEach(function (a) { byId[a.id] = a; });
        var next = {}; list.forEach(function (a) { if (a.rescheduled_from_id) next[a.rescheduled_from_id] = a; });
        function nameOf(arr, id, f) { var x = arr.filter(function (y) { return y.id === id; })[0]; return x ? x[f] : null; }
        var trs = list.map(function (a) {
          var from = a.rescheduled_from_id ? byId[a.rescheduled_from_id] : null, to = next[a.id];
          var live = a.status === 'requested' || a.status === 'confirmed';
          // a missed slot is rebooked (reschedule keeps it in the chain) or cancelled
          var open = live || a.status === 'missed';
          return el('tr', { class: a.status === 'rescheduled' || a.status === 'cancelled' ? 'adm-voided' : null }, [
            el('td', null, [el('span', { class: 'cell-main', text: k.when(a.appointment_at, true) }),
              a.window_minutes ? k.sub(k.t('apt_window_min', { n: a.window_minutes })) : null,
              from ? k.sub(k.t('apt_from', { d: k.when(from.appointment_at, true) })) : null,
              to ? k.sub(k.t('apt_to', { d: k.when(to.appointment_at, true) })) : null]),
            el('td', null, ctrNo(tx, a.container_id) ? k.ltr(ctrNo(tx, a.container_id)) : k.t('all_containers')),
            el('td', null, [partyName(api, L3[0], a.terminal_party_id) || k.t('none'), a.appointment_no ? k.sub('# ' + a.appointment_no) : null]),
            el('td', null, [nameOf(L3[1], a.driver_id, 'full_name') || k.t('none'), k.sub(nameOf(L3[2], a.truck_id, 'plate_no'))]),
            el('td', null, [k.badge('appt_status', a.status), k.sub(a.status_reason)]),
            el('td', null, canTr && open ? k.actions([
              a.status === 'requested' ? k.btn(k.t('apt_confirm'), 'btn-secondary', function (b) { quick(a, 'confirmed', b); }) : null,
              a.status === 'confirmed' ? k.btn(k.t('apt_complete'), 'btn-secondary', function (b) { quick(a, 'completed', b); }) : null,
              a.status === 'confirmed' ? k.btn(k.t('apt_missed'), 'btn-ghost', function () { statusDialog(a, 'missed', true); }) : null,
              k.btn(k.t('apt_reschedule'), 'btn-ghost', function () { rescheduleDialog(a); }),
              k.btn(k.t('apt_cancel'), 'btn-ghost adm-text-danger', function () { statusDialog(a, 'cancelled', true); })
            ]) : null)
          ]);
        });
        return [k.table([k.t('apt_at'), k.t('apt_container'), k.t('apt_terminal'), k.t('apt_driver') + ' / ' + k.t('apt_truck'), k.t('apt_status'), ''], trs, k.t('apt_empty')),
          el('p', { class: 'form-hint', text: k.t('apt_hint') })];
      });
    }, 'ops-tx-appointments');
  }

  /* ==================================================================
     60 — transport trips (legs · pickers · statuses · cost/sell for allowed roles)
     ================================================================== */
  function renderTrips(root, tx, api) {
    var k = kit(api), el = k.el;
    var canTr = api.can('transportWriter', tx.branch_id);
    var canFin = api.can(TRIP_FINANCE_ROLES, tx.branch_id);
    var current = [];
    function lookups() { return Promise.all([partiesOf(api, tx), driversOf(api, tx), trucksOf(api, tx)]); }
    function curOpts(v) { return CURRENCIES.map(function (c) { return [c, c]; }).concat(v && CURRENCIES.indexOf(v) === -1 ? [[v, v]] : []); }
    // driver / truck pickers follow the chosen carrier
    function bindCarrier(body, L3, trip) {
      var carrier = body.querySelector('[name=carrier_id]'), drv = body.querySelector('[name=driver_id]'), trk = body.querySelector('[name=truck_id]');
      function fill(sel, list, label, keep) {
        var cid = carrier.value, cur = keep != null ? keep : sel.value;
        sel.textContent = '';
        sel.appendChild(el('option', { value: '', text: k.t('optional_none') }));
        list.filter(function (x) { return x.id === cur || (x.is_active !== false && (!cid || x.carrier_id === cid)); })
          .forEach(function (x) { sel.appendChild(el('option', { value: x.id, text: label(x) })); });
        sel.value = cur || '';
        if (sel.value !== (cur || '')) sel.value = '';
      }
      function both(first) {
        fill(drv, L3[1], function (d) { return d.full_name + (d.phone ? ' · ' + d.phone : ''); }, first ? (trip.driver_id || '') : null);
        fill(trk, L3[2], function (x) { return x.plate_no; }, first ? (trip.truck_id || '') : null);
      }
      carrier.addEventListener('change', function () { both(false); });
      both(true);
    }
    function tripFields(L3, trip, money) {
      trip = trip || {};
      var f = [
        k.field({ name: 'leg_no', label: k.t('trp_leg'), type: 'number', min: 1, step: 1, req: true, value: trip.leg_no }),
        k.field({ name: 'container_id', label: k.t('trp_container'), type: 'select', value: trip.container_id, options: ctrOpts(k, tx, k.t('all_containers')) }),
        k.field({ name: 'carrier_id', label: k.t('trp_carrier'), type: 'select', value: trip.carrier_id, options: partyOpts(api, L3[0], 'carrier', k.t('optional_none'), trip.carrier_id) }),
        k.field({ name: 'driver_id', label: k.t('trp_driver'), type: 'select', options: [['', k.t('optional_none')]] }),
        k.field({ name: 'truck_id', label: k.t('trp_truck'), type: 'select', options: [['', k.t('optional_none')]] }),
        k.field({ name: 'planned_at', label: k.t('trp_planned'), type: 'datetime-local', value: k.toLocal(trip.planned_at) }),
        k.field({ name: 'origin', label: k.t('trp_origin'), max: 120, value: trip.origin }),
        k.field({ name: 'destination', label: k.t('trp_dest'), max: 120, value: trip.destination })
      ];
      if (canFin) {
        f.push(k.field({ name: 'cost_amount', label: k.t('trp_cost'), type: 'number', min: 0, step: '0.01', value: money.cost_amount }));
        f.push(k.field({ name: 'cost_currency', label: k.t('trp_cost_currency'), type: 'select', value: money.cost_currency || 'SAR', options: curOpts(money.cost_currency) }));
        f.push(k.field({ name: 'sell_amount', label: k.t('trp_sell'), type: 'number', min: 0, step: '0.01', value: money.sell_amount }));
        f.push(k.field({ name: 'sell_currency', label: k.t('trp_sell_currency'), type: 'select', value: money.sell_currency || 'SAR', options: curOpts(money.sell_currency) }));
        f.push(k.field({ name: 'cost_basis', label: k.t('trp_basis'), type: 'select', value: money.cost_basis || '', options: k.codeOpts('cost_basis', COST_BASIS, k.t('optional_none')) }));
      }
      f.push(k.field({ name: 'notes', label: k.t('trp_notes'), type: 'textarea', max: 1000, full: true, value: trip.notes }));
      return f;
    }
    function tripPayload(form) {
      var leg = k.numVal(form, 'leg_no');
      var p = { leg_no: leg == null || isNaN(leg) ? null : Math.round(leg), container_id: k.val(form, 'container_id'), carrier_id: k.val(form, 'carrier_id'),
        driver_id: k.val(form, 'driver_id'), truck_id: k.val(form, 'truck_id'), planned_at: k.fromLocal(k.val(form, 'planned_at')),
        origin: k.val(form, 'origin'), destination: k.val(form, 'destination'), notes: k.val(form, 'notes') };
      if (canFin) {
        p.cost_amount = k.numVal(form, 'cost_amount'); p.sell_amount = k.numVal(form, 'sell_amount');
        p.cost_currency = k.val(form, 'cost_currency') || 'SAR'; p.sell_currency = k.val(form, 'sell_currency') || 'SAR'; p.cost_basis = k.val(form, 'cost_basis');
      }
      return p;
    }
    function badMoney(p) { return [p.cost_amount, p.sell_amount].some(function (v) { return v != null && (isNaN(v) || v < 0); }); }
    function createDialog() {
      lookups().then(function (L3) {
        var key = k.idem();
        var maxLeg = current.reduce(function (m, x) { return Math.max(m, x.leg_no || 0); }, 0);
        api.modal({
          title: k.t('trp_add'), submitText: k.t('trp_add'), wide: true,
          body: [k.grid(tripFields(L3, { leg_no: maxLeg + 1 }, {})), el('p', { class: 'form-hint', text: k.t('trp_hint') })],
          onOpen: function (b) { bindCarrier(b, L3, {}); },
          onSubmit: function (form) {
            var p = tripPayload(form);
            if (!p.leg_no || p.leg_no < 1) return k.t('required');
            if (badMoney(p)) return k.t('trp_amount_bad');
            p.transaction_id = tx.id;
            return M(api, 'createTrip')(p, { idemKey: key(p) }).then(function (r) { return k.settle(r, k.t('trp_saved')); });
          }
        });
      });
    }
    function editDialog(trip, money) {
      lookups().then(function (L3) {
        api.modal({
          title: k.t('trp_edit_title', { n: trip.leg_no }), submitText: k.t('save'), wide: true,
          body: k.grid(tripFields(L3, trip, money || {})),
          onOpen: function (b) { bindCarrier(b, L3, trip); },
          onSubmit: function (form) {
            var p = tripPayload(form);
            if (!p.leg_no || p.leg_no < 1) return k.t('required');
            if (badMoney(p)) return k.t('trp_amount_bad');
            // never blank what this screen could not read: internal notes (not selectable) / money (trip_finance failed)
            if (trip.notes === undefined && p.notes == null) delete p.notes;
            if (canFin && !(money && Object.keys(money).length)) {
              ['cost_amount', 'sell_amount', 'cost_basis'].forEach(function (n) { if (p[n] == null) delete p[n]; });
              if (p.cost_amount == null) delete p.cost_currency;
              if (p.sell_amount == null) delete p.sell_currency;
            }
            return M(api, 'updateTrip')(trip.id, p).then(function (r) { return k.settle(r, k.t('trp_saved')); });
          }
        });
      });
    }
    function statusDialog(trip, s) {
      api.modal({
        title: k.t('trp_status_title', { s: k.L('trip_status', s), n: trip.leg_no }), submitText: k.L('trip_status', s), danger: s === 'cancelled',
        body: k.grid([
          s === 'cancelled' ? null : k.field({ name: 'at', label: k.t('at'), type: 'datetime-local', value: k.toLocal(new Date().toISOString()) }),
          k.field({ name: 'note', label: s === 'cancelled' ? k.t('reason') : k.t('note'), type: 'textarea', req: s === 'cancelled', max: 500, full: true })
        ]),
        onSubmit: function (form) {
          var note = k.val(form, 'note');
          if (s === 'cancelled' && !note) return k.t('reason_required');
          return M(api, 'setTripStatus')(trip.id, s, s === 'cancelled' ? null : k.fromLocal(k.val(form, 'at')), note).then(function (r) { return k.settle(r, k.t('trp_status_done')); });
        }
      });
    }
    return section(root, k, k.t('trp_title'), canTr ? [k.btn(k.t('trp_add'), 'btn-primary', createDialog)] : null, function () {
      return Promise.all([M(api, 'listTrips')({ txId: tx.id }), lookups()]).then(function (res) {
        var r = res[0], L3 = res[1];
        if (r.error) return loadErr(k, api, r.error);
        current = k.rows(r).slice().sort(function (a, b) { return (a.leg_no || 0) - (b.leg_no || 0); });
        var finP = canFin && current.length ? M(api, 'tripFinance')(current.map(function (x) { return x.id; })) : Promise.resolve({ data: {} });
        return finP.then(function (fr) {
          var fin = fr.error ? {} : (fr.data || {});
          function nameOf(arr, id, f) { var x = arr.filter(function (y) { return y.id === id; })[0]; return x ? x[f] : null; }
          var headers = [k.t('trp_leg'), k.t('trp_container'), k.t('trp_carrier'), k.t('trp_driver') + ' / ' + k.t('trp_truck'), k.t('trp_origin') + ' / ' + k.t('trp_dest'),
            k.t('trp_planned'), k.t('trp_status')];
          if (canFin) headers.push(k.t('trp_cost') + ' / ' + k.t('trp_sell'));
          headers.push('');
          var trs = current.map(function (x) {
            var m = fin[x.id] || {}, nx = TRIP_NEXT[x.status];
            var cells = [
              el('td', { class: 'num', text: x.leg_no != null ? String(x.leg_no) : k.t('none') }),
              el('td', null, ctrNo(tx, x.container_id) ? k.ltr(ctrNo(tx, x.container_id)) : k.t('all_containers')),
              el('td', { text: partyName(api, L3[0], x.carrier_id) || k.t('none') }),
              el('td', null, [nameOf(L3[1], x.driver_id, 'full_name') || k.t('none'), k.sub(nameOf(L3[2], x.truck_id, 'plate_no'))]),
              el('td', null, [el('span', { class: 'cell-main', text: x.origin || k.t('none') }), k.sub(x.destination)]),
              el('td', null, [k.when(x.planned_at, true), x.loaded_at ? k.sub(k.t('trp_loaded') + ': ' + k.when(x.loaded_at, true)) : null,
                x.unloaded_at ? k.sub(k.t('trp_unloaded') + ': ' + k.when(x.unloaded_at, true)) : null]),
              el('td', null, k.badge('trip_status', x.status))
            ];
            if (canFin) cells.push(el('td', { class: 'num' }, [m.cost_amount != null ? api.fmtMoney(m.cost_amount, m.cost_currency || 'SAR') : k.t('none'),
              m.sell_amount != null ? k.sub(api.fmtMoney(m.sell_amount, m.sell_currency || 'SAR')) : null, m.cost_basis ? k.sub(k.L('cost_basis', m.cost_basis)) : null]));
            var live = x.status !== 'delivered' && x.status !== 'cancelled';
            cells.push(el('td', null, canTr ? k.actions([
              nx ? k.btn(k.t('trp_next', { s: k.L('trip_status', nx) }), 'btn-secondary', function () { statusDialog(x, nx); }) : null,
              live ? k.btn(k.t('edit'), 'btn-ghost', function () { editDialog(x, m); }) : null,
              live ? k.btn(k.t('trp_cancel'), 'btn-ghost adm-text-danger', function () { statusDialog(x, 'cancelled'); }) : null
            ]) : null));
            return el('tr', { class: x.status === 'cancelled' ? 'adm-voided' : null }, cells);
          });
          return [k.table(headers, trs, k.t('trp_empty')),
            el('p', { class: 'form-hint', text: k.t('trp_hint') + (canFin ? '' : ' ' + k.t('trp_money_hidden')) })];
        });
      });
    }, 'ops-tx-trips');
  }

  /* ==================================================================
     70 — operational exceptions (create · progress · resolve / waive)
     ================================================================== */
  function renderExceptions(root, tx, api) {
    var k = kit(api), el = k.el;
    var canTr = api.can('transportWriter', tx.branch_id);
    var docsP = docsOf(api, tx);
    function createDialog() {
      docsP.then(function (docs) {
        var key = k.idem();
        api.modal({
          title: k.t('exc_add'), submitText: k.t('exc_add'), wide: true,
          body: [k.grid([
            k.field({ name: 'kind', label: k.t('exc_kind'), type: 'select', req: true, value: '', options: k.codeOpts('exception_kind', EXC_KINDS.filter(function (x) { return x !== 'declaration_cancelled'; }), k.t('choose')) }),
            k.field({ name: 'occurred_at', label: k.t('exc_when'), type: 'datetime-local', req: true, value: k.toLocal(new Date().toISOString()) }),
            k.field({ name: 'source', label: k.t('exc_source'), type: 'select', req: true, value: 'manual', options: k.codeOpts('exception_source', EXC_SOURCES) }),
            k.field({ name: 'container_id', label: k.t('exc_container'), type: 'select', options: ctrOpts(k, tx, k.t('all_containers')) }),
            k.field({ name: 'document_id', label: k.t('exc_doc'), type: 'select', options: docOpts(docs, k.t('optional_none')), full: true }),
            k.field({ name: 'amount', label: k.t('exc_amount'), type: 'number', min: 0, step: '0.01' }),
            k.field({ name: 'currency', label: k.t('exc_currency'), type: 'select', value: 'SAR', options: CURRENCIES.map(function (c) { return [c, c]; }) }),
            k.field({ name: 'reason', label: k.t('exc_reason'), type: 'textarea', req: true, max: 1000, full: true })
          ]), el('p', { class: 'form-hint', text: k.t('exc_hint') })],
          onSubmit: function (form) {
            var amt = k.numVal(form, 'amount');
            var p = { transaction_id: tx.id, kind: k.val(form, 'kind'), occurred_at: k.fromLocal(k.val(form, 'occurred_at')), source: k.val(form, 'source'),
              container_id: k.val(form, 'container_id'), document_id: k.val(form, 'document_id'), reason: k.val(form, 'reason'),
              amount: amt, currency: amt != null ? (k.val(form, 'currency') || 'SAR') : null };
            if (!p.kind || !p.occurred_at || !p.source) return k.t('required');
            if (!p.reason) return k.t('reason_required');
            if (amt != null && (isNaN(amt) || amt < 0)) return k.t('trp_amount_bad');
            if (EXC_NEEDS_PROOF.indexOf(p.kind) !== -1 && !p.document_id && amt == null) return k.t('exc_need_doc');
            return M(api, 'createException')(p, { idemKey: key(p) }).then(function (r) { return k.settle(r, k.t('exc_saved')); });
          }
        });
      });
    }
    function resolveDialog(x, s) {
      api.modal({
        title: k.t('exc_resolve_title', { s: k.L('exception_status', s), k: k.L('exception_kind', x.kind) }), submitText: k.L('exception_status', s),
        body: k.grid([k.field({ name: 'note', label: k.t('exc_resolution'), type: 'textarea', req: s !== 'in_progress', max: 1000, full: true })]),
        onSubmit: function (form) {
          var note = k.val(form, 'note');
          if (s !== 'in_progress' && !note) return k.t('reason_required');
          return M(api, 'resolveException')(x.id, s, note).then(function (r) { return k.settle(r, k.t('exc_status_done')); });
        }
      });
    }
    return section(root, k, k.t('exc_title'), canTr ? [k.btn(k.t('exc_add'), 'btn-primary', createDialog)] : null, function () {
      return Promise.all([M(api, 'listExceptions')({ txId: tx.id }), docsP]).then(function (res) {
        var r = res[0], docs = res[1];
        if (r.error) return loadErr(k, api, r.error);
        function docName(id) { var d = docs.filter(function (y) { return y.id === id; })[0]; return d ? d.original_name : null; }
        var trs = k.rows(r).map(function (x) {
          var open = x.status === 'open' || x.status === 'in_progress';
          return el('tr', null, [
            el('td', null, [el('span', { class: 'cell-main', text: k.L('exception_kind', x.kind) }), k.sub(ctrNo(tx, x.container_id))]),
            el('td', null, [k.when(x.occurred_at, true), k.sub(k.L('exception_source', x.source))]),
            el('td', null, [el('span', { class: 'adm-pre', text: x.reason || k.t('none') }), x.document_id ? k.sub(k.t('exc_doc') + ': ' + (docName(x.document_id) || k.t('none'))) : null]),
            el('td', { class: 'num', text: x.amount != null ? api.fmtMoney(x.amount, x.currency || 'SAR') : k.t('none') }),
            el('td', null, [k.badge('exception_status', x.status), x.resolution_note ? k.sub(x.resolution_note) : null,
              x.resolved_at ? k.sub(k.when(x.resolved_at, true)) : null]),
            el('td', null, canTr && open ? k.actions([
              x.status === 'open' ? k.btn(k.t('exc_progress'), 'btn-ghost', function () { resolveDialog(x, 'in_progress'); }) : null,
              k.btn(k.t('exc_resolve'), 'btn-secondary', function () { resolveDialog(x, 'resolved'); }),
              k.btn(k.t('exc_waive'), 'btn-ghost', function () { resolveDialog(x, 'waived'); })
            ]) : null)
          ]);
        });
        return [k.table([k.t('exc_kind'), k.t('exc_when'), k.t('exc_reason'), k.t('exc_amount'), k.t('exc_status'), ''], trs, k.t('exc_empty')),
          el('p', { class: 'form-hint', text: k.t('exc_hint') })];
      });
    }, 'ops-tx-exceptions');
  }

  /* ------------------------------------------------------------------
     Registration (replaces an earlier copy of this file's sections)
     ------------------------------------------------------------------ */
  var MINE = [
    { id: 'completeness', order: 10, render: renderCompleteness },
    { id: 'checklist', order: 15, render: renderChecklist },
    { id: 'declarations', order: 20, render: renderDeclarations },
    { id: 'bls', order: 30, render: renderBLs },
    { id: 'containers', order: 40, render: renderContainers },
    { id: 'appointments', order: 50, render: renderAppointments },
    { id: 'trips', order: 60, render: renderTrips },
    { id: 'exceptions', order: 70, render: renderExceptions }
  ];
  var ids = MINE.map(function (s) { return s.id; });
  for (var i = OPS.txSections.length - 1; i >= 0; i--) {
    if (OPS.txSections[i] && ids.indexOf(OPS.txSections[i].id) !== -1) OPS.txSections.splice(i, 1);
  }
  MINE.forEach(function (s) { OPS.txSections.push(s); });
})();
