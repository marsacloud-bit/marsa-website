/* ==========================================================================
   مرسى | MARSA — legacy step 2 UI (docs/online/LEGACY_TX_AR.md)  →  MarsaOps.legacyTx
   --------------------------------------------------------------------------
   Loaded after legacy-norm.js (window.MarsaNorm) and tx-sections.js, before
   admin.js. It adds, on the staff console (admin.html):
     * the transaction fields of the legacy form: transaction type (normal /
       re-export), cargo unit (containers / Ro-Ro + chassis + plate), customs
       port → terminal operator (port_operators), transport mode (driver /
       TASTO carrier order: company + order no + date), declaration notes.
       admin.js puts them in "new transaction" and "edit" (txFields()).
     * the duplicate pre-check (check_tx_duplicates): same B/L + container, or
       same B/L + chassis for Ro-Ro, blocks; the container under another B/L
       only warns (dupCheck() / dupPanel()).
     * the lifecycle stepper (tx_lifecycle) with the automatic moves, and the
       void-only cancel (cancel_transaction) with its reason dialog (stepper()).
     * the combined movement section (save_movement / list_movements /
       driver_directory): appointment + trip + empty-return plan, one form per
       container (section 'movements', order 55).
   * Strings: own namespace 'opslx' (ar + en), registered below.
   * The UI only hides what a role cannot do; RLS and the guarded RPCs decide.
   * Server and user data are inserted with textContent / createElement only.
   * ES5, no library. Pure helpers are exported on MarsaOps.legacyTx.pure for
     supabase/tests/legacy-tx-ui-tests.js.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  if (!Array.isArray(OPS.txSections)) OPS.txSections = [];
  function NORM() { return window.MarsaNorm || null; }

  /* ------------------------------------------------------------------
     Strings ('opslx.<k>'; labels 'opslx.lbl_<domain>_<code>')
     ------------------------------------------------------------------ */
  if (I && typeof I.register === 'function') {
    I.register('opslx', {
      ar: {
        none: '—', choose: 'اختر', optional_none: 'بدون', loading: 'جارٍ التحميل…', save: 'حفظ', edit: 'تعديل',
        required: 'أكمل الحقول المطلوبة.',
        // transaction fields
        sec_tx: 'المنفذ ووحدة الشحن والنقل',
        f_transaction_type: 'نوع المعاملة', f_cargo_unit_type: 'وحدة الشحن', f_chassis_no: 'رقم الشاسيه (VIN)',
        f_chassis_hint: 'حروف إنجليزية وأرقام فقط (4 إلى 30)؛ تُحذف المسافات والشرطات تلقائيًا.',
        f_vehicle_plate_no: 'رقم لوحة المركبة (اختياري)', f_port_code: 'المنفذ الجمركي', f_port_choose: 'اختر المنفذ',
        f_terminal: 'مشغّل المحطة', f_terminal_hint: 'تظهر المشغّلات المرتبطة بالمنفذ المختار أولًا، ثم المشغّلات غير المرتبطة بأي منفذ.',
        f_terminal_need_port: 'اختر المنفذ أولًا', f_terminal_none: 'لا يوجد مشغّل مسجّل لهذا المنفذ',
        f_terminal_other: 'مشغّلات غير مرتبطة بمنفذ',
        f_transport_mode: 'طريقة النقل', f_transport_party: 'شركة النقل', f_order_no: 'رقم أمر النقل',
        f_order_no_hint: 'بالصيغة TASTO متبوعة بأرقام، مثل TASTO123456.', f_order_date: 'تاريخ أمر النقل',
        f_declaration_notes: 'ملاحظات البيان (داخلية)', f_declaration_notes_hint: 'لا تظهر للعميل.',
        roro_hint: 'معاملة Ro-Ro تحمل مركبة واحدة: لا حاويات ولا إرجاع فارغ، ويلزم رقم الشاسيه.',
        roro_has_containers: 'لا يمكن تحويل المعاملة إلى Ro-Ro لأن عليها حاويات.',
        order_hint: 'أمر النقل يسلّم النقل لشركة نقل؛ ربطه بالفوترة يأتي في مرحلة لاحقة.',
        err_chassis_required: 'رقم الشاسيه مطلوب لمعاملة Ro-Ro.', err_chassis_bad: 'رقم الشاسيه: حروف إنجليزية وأرقام فقط (4 إلى 30).',
        err_order_no: 'رقم أمر النقل يجب أن يكون بالصيغة TASTO متبوعة بأرقام.',
        err_plate_bad: 'رقم اللوحة من 2 إلى 20 خانة.',
        // duplicate guard
        dup_title: 'فحص التكرار', dup_checking: 'جارٍ التحقق من التكرار…', dup_ok: 'لا توجد معاملة مكررة بهذه البوليصة والوحدة.',
        dup_need_bl: 'يبدأ فحص التكرار عند إدخال رقم البوليصة.',
        dup_block: 'لا يمكن الحفظ: {kind} {unit} مسجّل مسبقًا تحت رقم البوليصة نفسه في المعاملة {ref}.',
        dup_block_hidden: 'لا يمكن الحفظ: {kind} {unit} مسجّل مسبقًا تحت رقم البوليصة نفسه في معاملة لا تملك صلاحية عرضها.',
        dup_other_branch: '(فرع آخر)', kind_container: 'الحاوية', kind_chassis: 'الشاسيه',
        dup_warn: 'تنبيه: الحاوية {n} مسجّلة أيضًا في المعاملة {ref} (بوليصة أخرى). هذا مسموح لأنها زيارة منفصلة.',
        dup_warn_confirm: 'راجع التنبيه ثم اضغط زر الحفظ مرة أخرى للمتابعة.',
        dup_failed: 'تعذّر فحص التكرار الآن ({e}). لن تُحفظ معاملة جديدة حتى ينجح الفحص.',
        dup_failed_block: 'تعذّر فحص التكرار ({e})، ولم يُحفظ شيء. أعد المحاولة بعد قليل.',
        dup_race_reason: 'مكررة: رفضها فحص التكرار في الخادم أثناء الحفظ (ألغيت تلقائيًا).',
        dup_race_cancelled: 'سُجّلت معاملة مكررة في الوقت نفسه ({e}). أُلغيت المعاملة {ref} التي أُنشئت للتو، ولم يبقَ منها إلا سجل ملغى.',
        dup_race_not_cancelled: 'رفض الخادم التكرار ({e}) بعد إنشاء المعاملة {ref}، وتعذّر إلغاؤها تلقائيًا. ألغها من صفحتها.',
        req_bl: 'رقم البوليصة مطلوب.',
        req_port: 'المنفذ الجمركي مطلوب (من القائمة المعتمدة).',
        req_containers: 'أدخل حاوية واحدة على الأقل، أو اختر وحدة الشحن Ro-Ro وأدخل رقم الشاسيه.',
        client_typing: 'يُبحث عن عميل مطابق تلقائيًا أثناء كتابة الاسم أو الرقم الضريبي أو السجل التجاري.',
        // details
        k_type: 'نوع المعاملة', k_unit: 'وحدة الشحن', k_chassis: 'رقم الشاسيه', k_plate: 'لوحة المركبة', k_port: 'المنفذ الجمركي',
        k_terminal: 'مشغّل المحطة', k_mode: 'طريقة النقل', k_order: 'أمر النقل', k_transport_party: 'شركة النقل', k_decl_notes: 'ملاحظات البيان',
        roro_card: 'المركبة (Ro-Ro)', roro_card_hint: 'معاملة Ro-Ro لا تحمل حاويات ولا يلزمها إرجاع فارغ.',
        // stepper
        lc_title: 'مراحل المعاملة', lc_auto: 'تلقائي', lc_na: 'لا تنطبق', lc_na_title: 'لا تنطبق على معاملة Ro-Ro', lc_reached: 'منذ {d}', lc_failed: 'تعذّر تحميل المراحل: {e}',
        lc_next: 'المرحلة التالية: {s}', lc_next_manual: 'تُنقل يدويًا من بطاقة «الحالة»؛ لا تتقدم تلقائيًا.',
        lc_next_auto: 'تتقدم تلقائيًا عند الإجراء المناسب، ويمكن نقلها يدويًا من بطاقة «الحالة».',
        lc_ctr_wait: 'حاويات لم يثبت إرجاعها بعد: {n}', lc_docs_missing: 'مستندات مطلوبة قبل هذه المرحلة: {list}',
        lc_last: 'المعاملة في آخر مرحلة.', lc_pending: 'متابعة إرجاع الفارغ: {list}',
        lc_follow: 'يلزم إثبات إرجاع الحاويات الفارغة (إيصال استلام فارغ مؤكّد أو إعفاء موثّق) قبل «منتهية تشغيليًا» والفوترة.',
        lc_hint: 'تتقدم المرحلة للأمام فقط وعند إجراء من المستخدم: إضافة البيان، فسحه، تسجيل موعد، تسجيل نقلة، إثبات إرجاع الفارغ، الفوترة. «تحت الفوترة» و«مغلقة» لا تكونان تلقائيًا، ولا يُعتمد إثبات إرجاع الفارغ آليًا أبدًا.',
        cause_declaration: 'بإضافة البيان', cause_declaration_released: 'بفسح البيان', cause_appointment: 'بتسجيل موعد',
        cause_trip: 'بتسجيل نقلة', cause_container_return: 'بإثبات إرجاع الفارغ', cause_invoiced: 'بالفوترة', cause_movement: 'بحفظ حركة نقل',
        // cancel
        cancelled: 'ملغاة', cancelled_banner: 'المعاملة ملغاة منذ {d}.', cancelled_reason: 'سبب الإلغاء: {r}',
        cancelled_frozen: 'المعاملة الملغاة لا تقبل أي تعديل، وتبقى كل سجلاتها للاطلاع والتدقيق.',
        cancel_btn: 'إلغاء المعاملة', cancel_title: 'إلغاء المعاملة {ref}',
        cancel_intro: 'الإلغاء نهائي ولا يُحذف شيء: تُغلق المعاملة وتظهر «ملغاة» للعميل، وتُلغى بياناتها الجمركية النشطة، وتبقى المستندات والسجلات كما هي.',
        cancel_reason: 'سبب الإلغاء', cancel_reason_hint: 'إلزامي، حتى 500 حرف. يراه الموظفون فقط.',
        cancel_confirm: 'أؤكد إلغاء هذه المعاملة', cancel_need_confirm: 'علّم مربع التأكيد أولًا.', cancel_need_reason: 'اكتب سبب الإلغاء.',
        cancel_too_long: 'السبب أطول من 500 حرف.',
        cancel_done: 'أُلغيت المعاملة {ref}.', cancel_done_decl: 'أُلغيت المعاملة {ref} مع {n} بيان جمركي.',
        cancel_blocked_senior: 'بعد مرحلة «البيان الجمركي» يلغي المعاملة مدير العمليات أو مدير الفرع أو المشرف أو مدير المؤسسة.',
        cancel_blocked_billed: 'لا تُلغى معاملة دخلت الفوترة أو صدرت لها فاتورة.',
        cancel_blocked_closed: 'المعاملة مغلقة ولا تُلغى.',
        cancel_err_already_cancelled: 'المعاملة ملغاة مسبقًا.', cancel_err_closed: 'المعاملة مغلقة ولا تُلغى.',
        cancel_err_billed: 'لا تُلغى معاملة دخلت الفوترة أو صدرت لها فاتورة.',
        cancel_err_billing_intent: 'توجد عملية فوترة قائمة لهذه المعاملة؛ ألغِها أولًا من قسم الفوترة.',
        cancel_err_invoiced_charge: 'يوجد بند رسوم صدرت له فاتورة للعميل.',
        cancel_err_open_charges: 'توجد بنود رسوم مفتوحة (مسودة أو معتمدة)؛ ألغِها أولًا.',
        cancel_err_open_appointments: 'توجد مواعيد ميناء مفتوحة (مطلوبة أو مؤكدة)؛ ألغِها أولًا.',
        cancel_err_open_trips: 'توجد رحلات نقل مفتوحة؛ ألغِها أو أكملها أولًا.',
        cancel_err_open_exceptions: 'توجد استثناءات تشغيلية مفتوحة؛ عالجها أولًا.',
        cancel_err_open_demurrage: 'توجد قضية أرضيات مفتوحة على المعاملة.',
        cancel_err_open_returns: 'توجد حاويات خرجت من الميناء (أو لها موعد إرجاع) ولم يثبت إرجاعها؛ أثبت الإرجاع أو وثّق الإعفاء أولًا.',
        cancel_err_role: 'لا تملك صلاحية إلغاء هذه المعاملة في مرحلتها الحالية.',
        // list filters / pills
        f_cancelled_all: 'كل المعاملات', f_cancelled_exclude: 'غير الملغاة فقط', f_cancelled_only: 'الملغاة فقط',
        f_cancelled_label: 'الإلغاء', f_type_all: 'كل الأنواع', f_unit_all: 'كل الوحدات',
        // movements
        mv_title: 'حركات النقل (موعد + نقلة + إرجاع الفارغ)', mv_add: 'حركة جديدة', mv_deliver: 'تم النقل', mv_cancel: 'إلغاء الحركة',
        mv_new_title: 'حركة نقل جديدة', mv_edit_title: 'تعديل الحركة', mv_container: 'الحاوية', mv_at: 'وقت الموعد',
        mv_no: 'رقم الموعد (TAS)', mv_no_hint: 'يُوحَّد تلقائيًا إلى TAS متبوعًا بالأرقام.', mv_no_preview: 'سيُحفظ: {v}',
        mv_terminal: 'المحطة / المشغّل', mv_appt_status: 'حالة الموعد', mv_window: 'النافذة (دقيقة)',
        mv_driver_name: 'اسم السائق', mv_driver_phone: 'جوال السائق', mv_phone_hint: 'جوال سعودي بالصيغة 05XXXXXXXX.',
        mv_truck: 'رقم الشاحنة', mv_suggest: 'سائقون من الدليل', mv_suggest_pick: 'اختيار', mv_carrier: 'الناقل',
        mv_party: 'جهة النقل', mv_order_no: 'أمر النقل', mv_operator: 'المشغل', mv_zone: 'المنطقة/البوابة',
        lbl_transport_party_type_supplier: 'مورد', lbl_transport_party_type_company: 'شركة نقل', lbl_transport_party_type_direct: 'مباشر (السائق)',
        mv_origin: 'من', mv_dest: 'وجهة التسليم', mv_cost: 'قيمة النقل', mv_sell: 'عائد المؤسسة', mv_status: 'حالة الحركة',
        mv_delivered_at: 'وقت التسليم', mv_return_deadline: 'آخر موعد لإرجاع الفارغ', mv_return_location: 'مكان الإرجاع',
        mv_return_yard: 'ساحة الإرجاع', mv_return: 'إرجاع الفارغ', mv_notes: 'ملاحظات داخلية',
        mv_reason: 'السبب', mv_reason_hint: 'إلزامي عند تغيير وقت موعد مسجّل (إعادة جدولة) أو عند الإلغاء.',
        mv_saved: 'حُفظت الحركة.', mv_exists: 'الحركة مسجلة مسبقًا بالبيانات نفسها؛ لم يُنشأ تكرار.',
        mv_driver_new: 'أُضيف سائق جديد إلى الدليل.', mv_truck_new: 'أُضيفت شاحنة جديدة.', mv_follow: 'تابع إرجاع الفارغ للحاويات: {list}',
        mv_empty: 'لا توجد حركات نقل مسجلة.', mv_cancelled_done: 'أُلغيت الحركة.', mv_cancel_title: 'إلغاء الحركة — {d}',
        mv_hint: 'نموذج واحد لكل حاوية: الموعد والسائق والشاحنة والوجهة وقيمة النقل وخطة إرجاع الفارغ. حفظ الحركة يسجّل الموعد والنقلة معًا ويقدّم المعاملة تلقائيًا، ولا يُعدّ إثباتًا لإرجاع الفارغ.',
        mv_money_hidden: 'قيمة النقل وعائد المؤسسة تظهر لصلاحيات المالية ومدير العمليات فقط.',
        mv_deliver_need: '«تم النقل» يتطلب وجهة التسليم وقيمة النقل وعائد المؤسسة.',
        mv_roro_hint: 'Ro-Ro: بلا حاوية؛ اترك وقت الموعد فارغًا لتسجيل النقلة فقط.',
        mv_bad_phone: 'رقم الجوال يجب أن يكون سعوديًا بالصيغة 05XXXXXXXX.', mv_bad_amount: 'المبلغ يجب أن يكون رقمًا موجبًا.',
        mv_need_reason: 'اكتب السبب: تغيير وقت الموعد يُسجَّل كإعادة جدولة.',
        mv_frozen: 'الحركة منتهية أو ملغاة؛ لا تُعدَّل.',
        lbl_transaction_type_normal: 'عادية', lbl_transaction_type_re_export: 'إعادة تصدير',
        lbl_cargo_unit_type_container: 'حاويات', lbl_cargo_unit_type_roro: 'مركبة Ro-Ro',
        lbl_transport_mode_driver: 'سائق مباشر', lbl_transport_mode_carrier_order: 'أمر نقل لشركة نقل (TASTO)',
        lbl_movement_status_registered: 'موعد مسجل', lbl_movement_status_incomplete: 'موعد مسجل — بيانات النقل ناقصة',
        lbl_movement_status_delivered: 'تم النقل', lbl_movement_status_cancelled: 'ملغى',
        lbl_appt_status_requested: 'مطلوب', lbl_appt_status_confirmed: 'مؤكد',
        lbl_transaction_state_cancelled: 'ملغاة'
      },
      en: {
        none: '—', choose: 'Choose', optional_none: 'None', loading: 'Loading…', save: 'Save', edit: 'Edit',
        required: 'Fill in the required fields.',
        sec_tx: 'Port, cargo unit and transport',
        f_transaction_type: 'Transaction type', f_cargo_unit_type: 'Cargo unit', f_chassis_no: 'Chassis number (VIN)',
        f_chassis_hint: 'Latin letters and digits only (4 to 30); spaces and dashes are removed.',
        f_vehicle_plate_no: 'Vehicle plate (optional)', f_port_code: 'Customs port', f_port_choose: 'Choose the port',
        f_terminal: 'Terminal operator', f_terminal_hint: 'Operators mapped to the chosen port come first, then operators mapped to no port.',
        f_terminal_need_port: 'Choose the port first', f_terminal_none: 'No operator is registered for this port',
        f_terminal_other: 'Operators not mapped to a port',
        f_transport_mode: 'Transport mode', f_transport_party: 'Transport company', f_order_no: 'Transport order number',
        f_order_no_hint: 'TASTO followed by digits, e.g. TASTO123456.', f_order_date: 'Transport order date',
        f_declaration_notes: 'Declaration notes (internal)', f_declaration_notes_hint: 'Not shown to the client.',
        roro_hint: 'A Ro-Ro transaction carries one vehicle: no containers and no empty return; the chassis number is required.',
        roro_has_containers: 'This transaction has containers, so it cannot become Ro-Ro.',
        order_hint: 'A transport order hands the transport to a company; its billing link comes in a later phase.',
        err_chassis_required: 'The chassis number is required for a Ro-Ro transaction.', err_chassis_bad: 'Chassis number: Latin letters and digits only (4 to 30).',
        err_order_no: 'The transport order number must be TASTO followed by digits.',
        err_plate_bad: 'The plate has 2 to 20 characters.',
        dup_title: 'Duplicate check', dup_checking: 'Checking for duplicates…', dup_ok: 'No transaction with this B/L and unit exists.',
        dup_need_bl: 'The duplicate check starts once a B/L number is entered.',
        dup_block: 'Cannot save: {kind} {unit} is already registered under the same B/L in transaction {ref}.',
        dup_block_hidden: 'Cannot save: {kind} {unit} is already registered under the same B/L in a transaction you cannot view.',
        dup_other_branch: '(another branch)', kind_container: 'container', kind_chassis: 'chassis',
        dup_warn: 'Note: container {n} is also on transaction {ref} (another B/L). This is allowed as a separate visit.',
        dup_warn_confirm: 'Review the note, then press save again to continue.',
        dup_failed: 'The duplicate check is not available now ({e}). A new transaction is not saved until the check succeeds.',
        dup_failed_block: 'The duplicate check failed ({e}); nothing was saved. Please try again shortly.',
        dup_race_reason: 'Duplicate: refused by the server duplicate check while saving (cancelled automatically).',
        dup_race_cancelled: 'A duplicate was saved at the same time ({e}). Transaction {ref}, just created, was cancelled; only a cancelled record remains.',
        dup_race_not_cancelled: 'The server refused the duplicate ({e}) after transaction {ref} was created, and it could not be cancelled automatically. Cancel it from its page.',
        req_bl: 'The B/L number is required.',
        req_port: 'The customs port is required (from the approved list).',
        req_containers: 'Enter at least one container, or choose the Ro-Ro cargo unit and enter the chassis number.',
        client_typing: 'A matching client is searched automatically while you type the name, VAT or CR number.',
        k_type: 'Transaction type', k_unit: 'Cargo unit', k_chassis: 'Chassis number', k_plate: 'Vehicle plate', k_port: 'Customs port',
        k_terminal: 'Terminal operator', k_mode: 'Transport mode', k_order: 'Transport order', k_transport_party: 'Transport company', k_decl_notes: 'Declaration notes',
        roro_card: 'Vehicle (Ro-Ro)', roro_card_hint: 'A Ro-Ro transaction carries no containers and needs no empty return.',
        lc_title: 'Transaction stages', lc_auto: 'Automatic', lc_na: 'N/A', lc_na_title: 'Does not apply to a Ro-Ro transaction', lc_reached: 'since {d}', lc_failed: 'The stages could not be loaded: {e}',
        lc_next: 'Next stage: {s}', lc_next_manual: 'Moved by hand from the "Status" card; never automatic.',
        lc_next_auto: 'Moves automatically on the matching action, or by hand from the "Status" card.',
        lc_ctr_wait: 'Containers without return proof: {n}', lc_docs_missing: 'Documents required before this stage: {list}',
        lc_last: 'The transaction is at its last stage.', lc_pending: 'Empty-return follow-up: {list}',
        lc_follow: 'Empty-return proof (a confirmed empty-return receipt or a documented waiver) is required before "operationally complete" and billing.',
        lc_hint: 'Stages move forward only, and only on a user action: adding the declaration, its release, an appointment, a trip, empty-return proof, invoicing. "Under billing" and "Closed" are never automatic, and empty-return proof is never verified automatically.',
        cause_declaration: 'declaration added', cause_declaration_released: 'declaration released', cause_appointment: 'appointment registered',
        cause_trip: 'trip registered', cause_container_return: 'empty-return proof', cause_invoiced: 'invoiced', cause_movement: 'movement saved',
        cancelled: 'Cancelled', cancelled_banner: 'This transaction was cancelled on {d}.', cancelled_reason: 'Reason: {r}',
        cancelled_frozen: 'A cancelled transaction accepts no changes; all its records stay for reference and audit.',
        cancel_btn: 'Cancel transaction', cancel_title: 'Cancel transaction {ref}',
        cancel_intro: 'Cancelling is final and deletes nothing: the transaction is closed and shown as "Cancelled" to the client, its active customs declarations are cancelled, documents and records stay as they are.',
        cancel_reason: 'Reason for cancelling', cancel_reason_hint: 'Required, up to 500 characters. Staff only.',
        cancel_confirm: 'I confirm cancelling this transaction', cancel_need_confirm: 'Tick the confirmation box first.', cancel_need_reason: 'Write the reason for cancelling.',
        cancel_too_long: 'The reason is longer than 500 characters.',
        cancel_done: 'Transaction {ref} was cancelled.', cancel_done_decl: 'Transaction {ref} was cancelled with {n} customs declaration(s).',
        cancel_blocked_senior: 'After the "customs declaration" stage, an operations manager, branch manager, supervisor or the organisation admin cancels.',
        cancel_blocked_billed: 'A transaction in billing or already invoiced cannot be cancelled.',
        cancel_blocked_closed: 'The transaction is closed and cannot be cancelled.',
        cancel_err_already_cancelled: 'The transaction is already cancelled.', cancel_err_closed: 'The transaction is closed and cannot be cancelled.',
        cancel_err_billed: 'A transaction in billing or already invoiced cannot be cancelled.',
        cancel_err_billing_intent: 'A billing run exists for this transaction; cancel it first in the billing section.',
        cancel_err_invoiced_charge: 'A charge of this transaction was already invoiced to the client.',
        cancel_err_open_charges: 'Open charges (draft or approved) exist; cancel them first.',
        cancel_err_open_appointments: 'Open port appointments (requested or confirmed) exist; cancel them first.',
        cancel_err_open_trips: 'Open transport trips exist; cancel or complete them first.',
        cancel_err_open_exceptions: 'Open operational exceptions exist; resolve them first.',
        cancel_err_open_demurrage: 'An open demurrage case exists on this transaction.',
        cancel_err_open_returns: 'Containers left the port (or have a return deadline) without return proof; record the proof or a documented waiver first.',
        cancel_err_role: 'You cannot cancel this transaction at its current stage.',
        f_cancelled_all: 'All transactions', f_cancelled_exclude: 'Not cancelled', f_cancelled_only: 'Cancelled only',
        f_cancelled_label: 'Cancellation', f_type_all: 'All types', f_unit_all: 'All units',
        mv_title: 'Transport movements (appointment + trip + empty return)', mv_add: 'New movement', mv_deliver: 'Delivered', mv_cancel: 'Cancel movement',
        mv_new_title: 'New transport movement', mv_edit_title: 'Edit movement', mv_container: 'Container', mv_at: 'Appointment time',
        mv_no: 'Appointment number (TAS)', mv_no_hint: 'Normalised to TAS followed by the digits.', mv_no_preview: 'Will be saved as: {v}',
        mv_terminal: 'Terminal / operator', mv_appt_status: 'Appointment status', mv_window: 'Window (minutes)',
        mv_driver_name: 'Driver name', mv_driver_phone: 'Driver mobile', mv_phone_hint: 'Saudi mobile, 05XXXXXXXX.',
        mv_truck: 'Truck plate', mv_suggest: 'Drivers in the directory', mv_suggest_pick: 'Pick', mv_carrier: 'Carrier',
        mv_party: 'Transport party', mv_order_no: 'Transport order', mv_operator: 'Operator', mv_zone: 'Zone / gate',
        lbl_transport_party_type_supplier: 'Supplier', lbl_transport_party_type_company: 'Transport company', lbl_transport_party_type_direct: 'Direct (the driver)',
        mv_origin: 'From', mv_dest: 'Delivery destination', mv_cost: 'Transport value', mv_sell: 'Organisation revenue', mv_status: 'Movement status',
        mv_delivered_at: 'Delivery time', mv_return_deadline: 'Empty-return deadline', mv_return_location: 'Return place',
        mv_return_yard: 'Return yard', mv_return: 'Empty return', mv_notes: 'Internal notes',
        mv_reason: 'Reason', mv_reason_hint: 'Required when the time of a registered appointment changes (a reschedule) or when cancelling.',
        mv_saved: 'Movement saved.', mv_exists: 'The same movement already exists; no duplicate was created.',
        mv_driver_new: 'A new driver was added to the directory.', mv_truck_new: 'A new truck was added.', mv_follow: 'Follow up the empty return of: {list}',
        mv_empty: 'No transport movements yet.', mv_cancelled_done: 'Movement cancelled.', mv_cancel_title: 'Cancel movement — {d}',
        mv_hint: 'One form per container: appointment, driver, truck, destination, transport value and the empty-return plan. Saving writes the appointment and the trip together and moves the transaction forward automatically; it is never empty-return proof.',
        mv_money_hidden: 'Transport value and organisation revenue are shown to finance roles and operations managers only.',
        mv_deliver_need: '"Delivered" needs the destination, the transport value and the organisation revenue.',
        mv_roro_hint: 'Ro-Ro: no container; leave the appointment time empty to register the trip only.',
        mv_bad_phone: 'The mobile must be a Saudi number, 05XXXXXXXX.', mv_bad_amount: 'Amounts must be positive numbers.',
        mv_need_reason: 'Write the reason: a new appointment time is recorded as a reschedule.',
        mv_frozen: 'The movement is delivered or cancelled; it cannot be changed.',
        lbl_transaction_type_normal: 'Normal', lbl_transaction_type_re_export: 'Re-export',
        lbl_cargo_unit_type_container: 'Containers', lbl_cargo_unit_type_roro: 'Ro-Ro vehicle',
        lbl_transport_mode_driver: 'Direct driver', lbl_transport_mode_carrier_order: 'Transport company order (TASTO)',
        lbl_movement_status_registered: 'Appointment registered', lbl_movement_status_incomplete: 'Appointment registered — transport data missing',
        lbl_movement_status_delivered: 'Delivered', lbl_movement_status_cancelled: 'Cancelled',
        lbl_appt_status_requested: 'Requested', lbl_appt_status_confirmed: 'Confirmed',
        lbl_transaction_state_cancelled: 'Cancelled'
      }
    });
  }

  /* ------------------------------------------------------------------
     Codes (mirror the CHECK constraints of 20261117000100 / 20261118000100)
     ------------------------------------------------------------------ */
  var STAGES = ['new', 'in_progress', 'customs_declaration', 'appointment', 'transport', 'empty_return', 'operationally_complete', 'under_billing', 'billed', 'closed'];
  var TX_TYPES = ['normal', 're_export'];
  var UNITS = ['container', 'roro'];
  var MODES = ['driver', 'carrier_order'];
  var OPS_WRITER = ['clearance_staff', 'operations_manager', 'branch_manager', 'supervisor', 'admin'];
  var SENIOR = ['operations_manager', 'branch_manager', 'supervisor', 'admin'];
  var TRIP_FIN = ['accountant', 'accounts_manager', 'operations_manager', 'branch_manager', 'supervisor', 'admin'];
  var CANCEL_ERRS = ['already_cancelled', 'closed', 'billed', 'billing_intent', 'invoiced_charge', 'open_charges', 'open_appointments',
    'open_trips', 'open_exceptions', 'open_demurrage', 'open_returns'];
  var LIVE_MOVEMENT = ['registered', 'incomplete'];
  var MV_TONE = { registered: 'blue', incomplete: 'warning', delivered: 'success', cancelled: 'muted' };

  function T(k, vars) {
    var key = 'opslx.' + k;
    if (!I || typeof I.t !== 'function') return k;
    var s = I.t(key, vars);
    return s === key ? k : s;
  }
  function isEn() { return !!(I && typeof I.lang === 'function' && I.lang() === 'en'); }
  // status_labels (through admin.js' label) first, then this dictionary
  function lab(api, domain, code) {
    if (code == null || code === '') return T('none');
    var s = api && typeof api.label === 'function' ? api.label(domain, code) : null;
    if (s && s !== String(code)) return s;
    var k = 'lbl_' + domain + '_' + code, x = T(k);
    return x !== k ? x : String(code);
  }

  /* ------------------------------------------------------------------
     Pure helpers (no DOM; exported for the Node tests)
     ------------------------------------------------------------------ */
  function western(v) {
    var N = NORM();
    if (N && typeof N.western === 'function') return N.western(v == null ? '' : String(v));
    return String(v == null ? '' : v).replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); })
      .replace(/[۰-۹]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'.indexOf(d); });
  }
  function blank(v) { v = v == null ? '' : String(v).trim(); return v === '' ? null : v; }
  function normChassis(v) {
    var N = NORM();
    var s = N && typeof N.normChassis === 'function' ? N.normChassis(v) : western(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s || null;
  }
  function normOrderNo(v) {
    var N = NORM();
    var s = N && typeof N.normTransportOrderNo === 'function' ? N.normTransportOrderNo(v) : western(v).replace(/\s+/g, '').toUpperCase();
    return s || null;
  }
  function normTas(v) {
    var N = NORM();
    return N && typeof N.normTas === 'function' ? (N.normTas(v) || '') : '';
  }
  function normPhone(v) {
    var N = NORM();
    if (N && typeof N.normSaPhone === 'function') return N.normSaPhone(v, false) || '';
    var d = western(v).replace(/[^0-9+]/g, '').replace(/^(\+|00)966/, '0');
    if (/^5\d{8}$/.test(d)) d = '0' + d;
    return /^05\d{8}$/.test(d) ? d : '';
  }
  // Hijri text → {state:'empty'|'bad'|'unsupported'|'ok', hijri, iso}
  function hijriInfo(v) {
    var N = NORM(), s = blank(v);
    if (!s) return { state: 'empty', hijri: '', iso: '' };
    if (!N || typeof N.normalizeHijri !== 'function') return { state: 'unsupported', hijri: s, iso: '' };
    var h = N.normalizeHijri(s);
    if (!h) return { state: 'bad', hijri: '', iso: '' };
    if (typeof N.hijriSupported === 'function' && !N.hijriSupported()) return { state: 'unsupported', hijri: h, iso: '' };
    var iso = N.hijriToGregorian(h);
    return iso ? { state: 'ok', hijri: h, iso: iso } : { state: 'bad', hijri: h, iso: '' };
  }
  function gregorianToHijri(iso) {
    var N = NORM();
    if (!iso || !N || typeof N.gregorianToHijri !== 'function') return '';
    return N.gregorianToHijri(iso) || '';
  }

  // the legacy transaction columns from form values → { patch, error } (error = an 'opslx' key)
  //   vals: { transaction_type, cargo_unit_type, chassis_no, vehicle_plate_no, port_code, terminal_party_id,
  //           transport_mode, transport_party_id, transport_order_no, transport_order_date, declaration_notes }
  //   tx:   the current row on an edit (containers decide whether Ro-Ro is possible), null on a new transaction
  function legacyPatch(vals, tx) {
    vals = vals || {};
    var unit = UNITS.indexOf(vals.cargo_unit_type) !== -1 ? vals.cargo_unit_type : 'container';
    var mode = MODES.indexOf(vals.transport_mode) !== -1 ? vals.transport_mode : 'driver';
    var p = {
      transaction_type: TX_TYPES.indexOf(vals.transaction_type) !== -1 ? vals.transaction_type : 'normal',
      cargo_unit_type: unit,
      chassis_no: null, vehicle_plate_no: null,
      port_code: blank(vals.port_code), terminal_party_id: blank(vals.terminal_party_id),
      transport_mode: mode, transport_party_id: null, transport_order_no: null, transport_order_date: null,
      declaration_notes: blank(vals.declaration_notes)
    };
    if (unit === 'roro') {
      if (tx && (tx.containers || []).length) return { patch: p, error: 'roro_has_containers' };
      var raw = blank(vals.chassis_no);
      if (!raw) return { patch: p, error: 'err_chassis_required' };
      p.chassis_no = normChassis(raw);
      if (!p.chassis_no || p.chassis_no.length < 4 || p.chassis_no.length > 30) return { patch: p, error: 'err_chassis_bad' };
      var plate = blank(vals.vehicle_plate_no);
      if (plate) {
        p.vehicle_plate_no = western(plate).toUpperCase();
        var bare = p.vehicle_plate_no.replace(/[\s-]/g, '');
        if (bare.length < 2 || bare.length > 20) return { patch: p, error: 'err_plate_bad' };
      }
      p.container_count = 0;
    }
    if (mode === 'carrier_order') {
      p.transport_party_id = blank(vals.transport_party_id);
      p.transport_order_date = blank(vals.transport_order_date);
      var no = blank(vals.transport_order_no);
      if (no) {
        p.transport_order_no = normOrderNo(no);
        if (!/^TASTO[0-9]{1,20}$/.test(p.transport_order_no)) return { patch: p, error: 'err_order_no' };
      }
    }
    return { patch: p, error: null };
  }

  // check_tx_duplicates result → { block: [text], warn: [text] }
  function dupMessages(d, tx) {
    d = d || {};
    var block = (d.duplicates || []).map(function (x) {
      var kind = T(x.kind === 'chassis' ? 'kind_chassis' : 'kind_container');
      if (!x.ref) return T('dup_block_hidden', { kind: kind, unit: x.unit || '' });
      return T('dup_block', { kind: kind, unit: x.unit || '', ref: x.ref + (x.other_branch ? ' ' + T('dup_other_branch') : '') });
    });
    var warn = (d.container_elsewhere || []).filter(function (x) { return !tx || x.transaction_id !== tx.id; }).map(function (x) {
      return T('dup_warn', { n: x.container_no || '', ref: x.ref || '—' });
    });
    return { block: block, warn: warn };
  }

  // is the next stage reached by hand only? (the server says so; older servers lacked in_progress and container
  // operationally_complete — no trigger moves a container transaction there, only a Ro-Ro release does)
  function nextManual(d) {
    var n = d && d.next;
    if (!n) return false;
    return !!n.manual || n.code === 'in_progress' || (n.code === 'operationally_complete' && d.cargo_unit_type !== 'roro');
  }

  // why the cancel button is missing (null = allowed): can(roles) answers for the transaction's branch
  //   'hidden' (cancelled already / not an ops writer) · 'closed' · 'billed' · 'senior'
  function cancelBlock(tx, can) {
    if (!tx || tx.cancelled_at) return 'hidden';
    if (!can(OPS_WRITER)) return 'hidden';
    if (tx.operational_status === 'closed') return 'closed';
    if (tx.operational_status === 'under_billing' || tx.operational_status === 'billed'
        || ['draft_pending', 'invoiced', 'settled'].indexOf(tx.financial_status) !== -1) return 'billed';
    if (STAGES.indexOf(tx.operational_status) > STAGES.indexOf('customs_declaration') && !can(SENIOR)) return 'senior';
    return null;
  }
  // a cancel_transaction error → text of this dictionary (null: use the generic API message)
  function cancelErrText(e) {
    if (!e) return null;
    var code = e.code || (e.raw && e.raw.code), det = e.field || (e.raw && (e.raw.details || e.raw.detail)) || '';
    if (code === 'MRS_BAD_TRANSITION' && CANCEL_ERRS.indexOf(det) !== -1) return T('cancel_err_' + det);
    if (code === 'MRS_FORBIDDEN') return T('cancel_err_role');
    if (code === 'MRS_NOTE_REQUIRED') return T('cancel_need_reason');
    if (code === 'MRS_TOO_LONG') return T('cancel_too_long');
    return null;
  }

  // movement form values → save_movement payload or { error } (an 'opslx' key)
  //   vals: raw strings of the form; ctx: { tx, movement (edit), canFin, isoAt (appointment_at as ISO or null) }
  function movementPayload(vals, ctx) {
    var tx = ctx.tx, m = ctx.movement || null, roro = tx.cargo_unit_type === 'roro';
    var p = { transaction_id: tx.id };
    if (m) { if (m.appointment_id) p.appointment_id = m.appointment_id; else if (m.trip_id) p.trip_id = m.trip_id; }
    if (!roro) {
      var cid = blank(vals.container_id) || (m && m.container_id) || null;
      if (!cid) return { error: 'required' };
      p.container_id = cid;
    }
    var at = ctx.isoAt || null;
    if (!m && !at && !roro) return { error: 'required' };
    var changedAt = m && m.appointment_at && at && Math.floor(new Date(at).getTime() / 60000) !== Math.floor(new Date(m.appointment_at).getTime() / 60000);
    // a new movement, a trip-only movement getting its slot, or a new time (= a reschedule, with the reason)
    if (at && (!m || !m.appointment_id || changedAt)) p.appointment_at = at;
    var no = blank(vals.appointment_no);
    if (no) p.appointment_no = no;
    ['terminal_party_id', 'carrier_id', 'origin', 'destination', 'notes', 'return_deadline', 'return_location', 'return_yard_party_id'].forEach(function (k) {
      var v = blank(vals[k]);
      if (v) p[k] = v;
    });
    if (roro) { delete p.return_deadline; delete p.return_location; delete p.return_yard_party_id; }
    var w = blank(vals.window_minutes);
    if (w) { var wn = Number(western(w)); if (!isFinite(wn) || wn < 0) return { error: 'required' }; p.window_minutes = Math.round(wn); }
    var st = blank(vals.appointment_status);
    if ((st === 'requested' || st === 'confirmed') && (!m || st !== m.appointment_status)) p.appointment_status = st;
    var name = blank(vals.driver_name), phone = blank(vals.driver_phone), plate = blank(vals.truck_plate);
    if (!name || !phone || !plate) return { error: 'required' };
    var ph = normPhone(phone);
    if (!ph) return { error: 'mv_bad_phone' };
    p.driver_name = name; p.driver_phone = ph; p.truck_plate = western(plate).toUpperCase();
    if (ctx.canFin) {
      var bad = false;
      ['cost_amount', 'sell_amount'].forEach(function (k) {
        var v = blank(vals[k]);
        if (v == null) return;
        var n = Number(western(v).replace(/,/g, ''));
        if (!isFinite(n) || n < 0) bad = true; else p[k] = n;
      });
      if (bad) return { error: 'mv_bad_amount' };
    }
    var ms = blank(vals.movement_status) || 'registered';
    p.movement_status = ms === 'delivered' ? 'delivered' : 'registered';
    if (p.movement_status === 'delivered') {
      if (!p.destination && !(m && m.destination)) return { error: 'mv_deliver_need' };
      if (ctx.canFin && ((p.cost_amount == null && !(m && m.cost_amount != null)) || (p.sell_amount == null && !(m && m.sell_amount != null)))) return { error: 'mv_deliver_need' };
      if (ctx.isoDelivered) p.delivered_at = ctx.isoDelivered;
    }
    var why = blank(vals.reason);
    if (changedAt && m.appointment_id && !why) return { error: 'mv_need_reason' };
    if (why) p.reason = why;
    return { payload: p };
  }

  /* ------------------------------------------------------------------
     DOM helpers (api.el = admin.js el())
     ------------------------------------------------------------------ */
  function fieldNode(el, o) {
    var id = 'lx-' + o.name, ctl;
    var common = { class: 'form-control', id: id, name: o.name, required: !!o.req, dir: o.ltr ? 'ltr' : null, placeholder: o.placeholder || null,
      inputmode: o.inputmode || null };
    if (o.type === 'select') {
      ctl = el('select', common, (o.options || []).map(function (p) { return el('option', { value: p[0], text: p[1] }); }));
      ctl.value = o.value == null ? '' : String(o.value);
    } else if (o.type === 'textarea') {
      ctl = el('textarea', Object.assign(common, { rows: o.rows || 2, maxlength: o.max || null }));
      ctl.value = o.value == null ? '' : String(o.value);
    } else {
      ctl = el('input', Object.assign(common, { type: o.type || 'text', maxlength: o.max || null, autocomplete: 'off', min: o.min != null ? o.min : null,
        step: o.step || null, value: o.value == null ? '' : o.value }));
    }
    var g = el('div', { class: 'form-group' + (o.full ? ' adm-full' : ''), 'data-lx': o.group || null }, [
      el('label', { class: 'form-label', for: id }, [o.label, o.req ? el('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null]),
      ctl, o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null
    ]);
    return g;
  }
  function codeOpts(api, domain, codes) { return codes.map(function (c) { return [c, lab(api, domain, c)]; }); }
  function pillNode(el, tone, text) { return el('span', { class: 'badge badge-' + tone, text: text }); }
  function alertNode(el, type, kids) { return el('div', { class: 'alert alert-' + type, role: type === 'danger' ? 'alert' : 'status' }, el('div', null, kids)); }
  function show(node, on) { if (node) node.hidden = !on; }
  function call(api, name) {
    var A = api && (api.MarsaApi || api), f = A && A[name];
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof f !== 'function') return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', message: name } });
    return Promise.resolve().then(function () { return f.apply(A, args); })
      .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
  }
  function errText(api, e) { return api && typeof api.errText === 'function' ? api.errText(e) : ((e && e.message) || String(e)); }
  function fmtDate(api, v, time) { return v ? (api && api.fmtDate ? api.fmtDate(v, !!time) : String(v)) : T('none'); }
  function rowsOf(r) { var d = r && r.data; return Array.isArray(d) ? d : (d && (d.rows || d.items)) || []; }
  function newKey(api) { return api && typeof api.newIdemKey === 'function' ? api.newIdemKey() : null; }
  function idem(api) {
    var c = null;
    return function (payload) {
      var sig = JSON.stringify(payload);
      if (!c || c.sig !== sig) c = { sig: sig, key: newKey(api) };
      return c.key;
    };
  }
  // datetime-local ↔ ISO
  function toLocal(v) {
    if (!v) return '';
    var d = new Date(v); if (isNaN(d)) return '';
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fromLocal(v) { if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  function formVals(form, names) {
    var o = {};
    names.forEach(function (n) { var e = form.elements[n]; o[n] = e ? (e.type === 'checkbox' ? e.checked : e.value) : null; });
    return o;
  }

  /* ------------------------------------------------------------------
     Shared lookups (one per page load; the ports never change at runtime)
     ------------------------------------------------------------------ */
  var portsP = null;
  function ports(api) {
    if (!portsP) {
      portsP = call(api, 'listCustomsPorts').then(function (r) {
        var list = (r.data || []).filter(function (p) { return p && p.is_active !== false; });
        if (list.length) return list;
        portsP = null;   // retry on the next form
        var N = NORM();
        return N && N.PORTS ? N.PORTS.map(function (p, i) { return { code: p.code, name_ar: p.name_ar, name_en: p.name_en, kind: p.kind, sort: i + 1 }; }) : [];
      });
    }
    return portsP;
  }
  function portName(code, list) {
    if (!code) return null;
    var p = (list || []).filter(function (x) { return x.code === code; })[0];
    if (!p) { var N = NORM(); p = N && typeof N.portByCode === 'function' ? N.portByCode(code) : null; }
    return p ? ((isEn() && p.name_en) || p.name_ar || code) : code;
  }
  var partiesCache = null;
  function parties(api) {
    if (!partiesCache || partiesCache.org !== api.orgId) {
      partiesCache = { org: api.orgId, p: call(api, 'listParties', { active: false, limit: 500 }).then(function (r) { return r.error ? [] : rowsOf(r); }) };
    }
    return partiesCache.p;
  }
  function partyLabel(p) { return (isEn() && p.name_en) || p.name_ar || p.name_en || p.id; }
  function partyOpts(list, kind, blankText, keep) {
    return [['', blankText]].concat(list.filter(function (p) {
      return p.id === keep || ((p.kinds || []).indexOf(kind) !== -1 && p.is_active !== false);
    }).map(function (p) { return [p.id, partyLabel(p)]; }));
  }

  /* ==================================================================
     Transaction form fields (new + edit)
     ================================================================== */
  var TX_NAMES = ['transaction_type', 'cargo_unit_type', 'chassis_no', 'vehicle_plate_no', 'port_code', 'terminal_party_id',
    'transport_mode', 'transport_party_id', 'transport_order_no', 'transport_order_date', 'declaration_notes'];
  // → { nodes: [Node], bind(body), collect(form) → { patch, error (text) } }
  function txFields(api, tx) {
    var el = api.el, cur = tx || {};
    var hasCtr = !!(tx && (tx.containers || []).length);
    var unitOpts = codeOpts(api, 'cargo_unit_type', UNITS);
    var nodes = [
      el('h4', { class: 'adm-full adm-form-sep', text: T('sec_tx') }),
      fieldNode(el, { name: 'transaction_type', label: T('f_transaction_type'), type: 'select', value: cur.transaction_type || 'normal', options: codeOpts(api, 'transaction_type', TX_TYPES) }),
      fieldNode(el, { name: 'cargo_unit_type', label: T('f_cargo_unit_type'), type: 'select', value: cur.cargo_unit_type || 'container', options: unitOpts,
        hint: hasCtr && cur.cargo_unit_type !== 'roro' ? T('roro_has_containers') : null }),
      fieldNode(el, { name: 'chassis_no', label: T('f_chassis_no'), ltr: true, max: 40, value: cur.chassis_no, hint: T('f_chassis_hint'), group: 'roro' }),
      fieldNode(el, { name: 'vehicle_plate_no', label: T('f_vehicle_plate_no'), ltr: true, max: 20, value: cur.vehicle_plate_no, group: 'roro' }),
      el('div', { class: 'form-group adm-full', 'data-lx': 'roro' }, alertNode(el, 'info', T('roro_hint'))),
      // the async selects start out holding the stored value (review fix: an edit saved before they load, or after a
      // failed lookup, must send the value unchanged — never clear it)
      fieldNode(el, { name: 'port_code', label: T('f_port_code'), type: 'select', value: cur.port_code || '',
        options: [['', T('f_port_choose')]].concat(cur.port_code ? [[cur.port_code, cur.port_code]] : []) }),
      fieldNode(el, { name: 'terminal_party_id', label: T('f_terminal'), type: 'select', value: cur.terminal_party_id || '',
        options: [['', T('f_terminal_need_port')]].concat(cur.terminal_party_id ? [[cur.terminal_party_id, T('loading')]] : []), hint: T('f_terminal_hint') }),
      fieldNode(el, { name: 'transport_mode', label: T('f_transport_mode'), type: 'select', value: cur.transport_mode || 'driver', options: codeOpts(api, 'transport_mode', MODES) }),
      fieldNode(el, { name: 'transport_party_id', label: T('f_transport_party'), type: 'select', value: cur.transport_party_id || '',
        options: [['', T('optional_none')]].concat(cur.transport_party_id ? [[cur.transport_party_id, T('loading')]] : []), group: 'order' }),
      fieldNode(el, { name: 'transport_order_no', label: T('f_order_no'), ltr: true, max: 30, value: cur.transport_order_no, hint: T('f_order_no_hint'), group: 'order' }),
      fieldNode(el, { name: 'transport_order_date', label: T('f_order_date'), type: 'date', value: cur.transport_order_date, group: 'order' }),
      el('div', { class: 'form-group adm-full', 'data-lx': 'order' }, alertNode(el, 'info', T('order_hint'))),
      fieldNode(el, { name: 'declaration_notes', label: T('f_declaration_notes'), type: 'textarea', max: 2000, full: true, value: cur.declaration_notes, hint: T('f_declaration_notes_hint') })
    ];
    if (hasCtr && cur.cargo_unit_type !== 'roro') {
      var o = nodes[2].querySelector('option[value=roro]'); if (o) o.disabled = true;
    }
    function bind(body) {
      var q = function (n) { return body.querySelector('[name=' + n + ']'); };
      var unit = q('cargo_unit_type'), mode = q('transport_mode'), port = q('port_code'), term = q('terminal_party_id'), carrier = q('transport_party_id');
      var hideWithRoro = body.querySelectorAll('[data-lx-hide-roro]');
      function sync() {
        var roro = unit.value === 'roro';
        Array.prototype.forEach.call(body.querySelectorAll('[data-lx=roro]'), function (g) { show(g, roro); });
        Array.prototype.forEach.call(hideWithRoro, function (g) { show(g, !roro); });
        var ord = mode.value === 'carrier_order';
        Array.prototype.forEach.call(body.querySelectorAll('[data-lx=order]'), function (g) { show(g, ord); });
        var ch = q('chassis_no'); if (ch) ch.required = roro;
      }
      unit.addEventListener('change', sync);
      mode.addEventListener('change', sync);
      sync();
      var termSeq = 0;
      function fillTerminals(keep) {
        var mine = ++termSeq, code = port.value;
        term.textContent = '';
        if (!code) { term.appendChild(el('option', { value: '', text: T('f_terminal_need_port') })); return Promise.resolve(); }
        // while loading, the kept operator stays selected (saving now sends it unchanged)
        term.appendChild(el('option', { value: keep || '', text: T('loading') }));
        term.value = keep || '';
        return call(api, 'portOperators', code).then(function (r) {
          if (mine !== termSeq) return;
          if (r.error && keep) { term.textContent = ''; term.appendChild(el('option', { value: keep, text: keep.slice(0, 8) })); term.value = keep; return; }
          var list = rowsOf(r);
          term.textContent = '';
          term.appendChild(el('option', { value: '', text: list.length ? T('optional_none') : T('f_terminal_none') }));
          var mapped = list.filter(function (x) { return x.mapped; }), other = list.filter(function (x) { return !x.mapped; });
          mapped.forEach(function (x) { term.appendChild(el('option', { value: x.party_id, text: (isEn() && x.name_en) || x.name_ar || x.name_en })); });
          if (other.length) {
            var g = el('optgroup', { label: T('f_terminal_other') });
            other.forEach(function (x) { g.appendChild(el('option', { value: x.party_id, text: (isEn() && x.name_en) || x.name_ar || x.name_en })); });
            term.appendChild(g);
          }
          if (keep && !list.some(function (x) { return x.party_id === keep; })) term.appendChild(el('option', { value: keep, text: keep.slice(0, 8) }));
          term.value = keep || '';
        });
      }
      port.addEventListener('change', function () { fillTerminals(term.value || null); });
      ports(api).then(function (list) {
        port.textContent = '';
        port.appendChild(el('option', { value: '', text: T('f_port_choose') }));
        list.forEach(function (p) { port.appendChild(el('option', { value: p.code, text: (isEn() && p.name_en) || p.name_ar || p.code })); });
        if (cur.port_code && !list.some(function (p) { return p.code === cur.port_code; })) port.appendChild(el('option', { value: cur.port_code, text: cur.port_code }));
        port.value = cur.port_code || '';
        fillTerminals(cur.terminal_party_id || null);
      });
      parties(api).then(function (list) {
        var keep = cur.transport_party_id || null, opts = partyOpts(list, 'carrier', T('optional_none'), keep);
        // the stored carrier stays selectable even when the list failed or does not hold it (beyond the first 500)
        if (keep && !opts.some(function (o) { return o[0] === keep; })) opts.push([keep, keep.slice(0, 8)]);
        carrier.textContent = '';
        opts.forEach(function (o) { carrier.appendChild(el('option', { value: o[0], text: o[1] })); });
        carrier.value = keep || '';
      });
    }
    function collect(form) {
      var r = legacyPatch(formVals(form, TX_NAMES), tx || null);
      return { patch: r.patch, error: r.error ? T(r.error) : null };
    }
    return { nodes: nodes, bind: bind, collect: collect };
  }

  /* ---- duplicate pre-check ------------------------------------------ */
  // o = { tx?, blNumber, cargoUnitType, chassisNo, containers:[no] } → Promise { block:[text], warn:[text], error? }
  function dupCheck(api, o) {
    if (!o || !blank(o.blNumber)) return Promise.resolve({ block: [], warn: [], skipped: true });
    var unit = o.cargoUnitType === 'roro' ? 'roro' : 'container';
    if (unit === 'roro' && !o.chassisNo) return Promise.resolve({ block: [], warn: [], skipped: true });
    var q = { blNumber: o.blNumber, cargoUnitType: unit, chassisNo: unit === 'roro' ? o.chassisNo : null, containers: unit === 'roro' ? [] : (o.containers || []) };
    if (o.tx && o.tx.id) q.transactionId = o.tx.id;
    return call(api, 'checkTxDuplicates', q).then(function (r) {
      if (r.error) return { block: [], warn: [], error: r.error };
      var m = dupMessages(r.data, o.tx);
      return { block: m.block, warn: m.warn };
    });
  }
  // a live panel under the form; get() → the dupCheck input. Returns { node, run() → Promise result }
  function dupPanel(api, get) {
    var el = api.el;
    var box = el('div', { class: 'adm-full lx-dup', 'aria-live': 'polite' });
    var seq = 0, timer = null;
    function paint(res) {
      box.textContent = '';
      if (!res || res.skipped) { box.appendChild(el('p', { class: 'form-hint', text: T('dup_need_bl') })); return; }
      if (res.error) { box.appendChild(alertNode(el, 'warning', T('dup_failed', { e: errText(api, res.error) }))); return; }
      if (res.block.length) box.appendChild(alertNode(el, 'danger', res.block.map(function (x) { return el('p', { class: 'mb-0', text: x }); })));
      if (res.warn.length) box.appendChild(alertNode(el, 'warning', res.warn.map(function (x) { return el('p', { class: 'mb-0', text: x }); })));
      if (!res.block.length && !res.warn.length) box.appendChild(el('p', { class: 'form-hint lx-dup-ok', text: T('dup_ok') }));
    }
    function run() {
      var mine = ++seq;
      box.textContent = '';
      box.appendChild(el('p', { class: 'form-hint', text: T('dup_checking') }));
      return dupCheck(api, get()).then(function (res) { if (mine === seq) paint(res); return res; });
    }
    function soon() { if (timer) clearTimeout(timer); timer = setTimeout(run, 400); }
    paint({ skipped: true });
    return { node: box, run: run, soon: soon };
  }

  /* ==================================================================
     Stepper + cancelled banner + cancel (top of #tx/<id>)
     ================================================================== */
  function cancelDialog(tx, api) {
    var el = api.el;
    api.modal({
      title: T('cancel_title', { ref: tx.ref || '' }), submitText: T('cancel_btn'), danger: true,
      body: [
        alertNode(el, 'warning', T('cancel_intro')),
        el('div', { class: 'adm-form-grid' }, [
          fieldNode(el, { name: 'cancel_reason', label: T('cancel_reason'), type: 'textarea', req: true, max: 500, rows: 3, full: true, hint: T('cancel_reason_hint') }),
          el('div', { class: 'form-group adm-full' }, el('label', { class: 'check' }, [el('input', { type: 'checkbox', name: 'cancel_ack', id: 'lx-cancel_ack' }), ' ', T('cancel_confirm')]))
        ])
      ],
      onSubmit: function (form) {
        var why = blank(form.elements.cancel_reason && form.elements.cancel_reason.value);
        if (!why) return T('cancel_need_reason');
        if (why.length > 500) return T('cancel_too_long');
        if (!(form.elements.cancel_ack && form.elements.cancel_ack.checked)) return T('cancel_need_confirm');
        return call(api, 'cancelTransaction', tx.id, why).then(function (r) {
          if (r.error) return cancelErrText(r.error) || errText(api, r.error);
          var n = r.data && r.data.declarations_cancelled;
          api.toast(n ? T('cancel_done_decl', { ref: tx.ref || '', n: n }) : T('cancel_done', { ref: tx.ref || '' }), 'success');
          api.refresh();
          return true;
        });
      }
    });
  }
  function cancelControl(tx, api) {
    var el = api.el;
    var why = cancelBlock(tx, function (roles) { return api.can(roles, tx.branch_id); });
    if (why === 'hidden') return null;
    var btn = el('button', { class: 'btn btn-sm btn-ghost adm-text-danger lx-cancel-btn', type: 'button', text: T('cancel_btn') });
    if (why) {
      btn.disabled = true;
      btn.setAttribute('aria-describedby', 'lx-cancel-why');
      return el('div', { class: 'lx-cancel' }, [btn, el('span', { class: 'form-hint', id: 'lx-cancel-why', text: T('cancel_blocked_' + why) })]);
    }
    btn.addEventListener('click', function (e) { e.preventDefault(); cancelDialog(tx, api); });
    return el('div', { class: 'lx-cancel' }, btn);
  }
  function cancelledBanner(tx, api) {
    var el = api.el;
    var kids = [el('strong', { text: T('cancelled_banner', { d: fmtDate(api, tx.cancelled_at, true) }) })];
    if (tx.cancel_reason) kids.push(el('p', { class: 'mb-0 adm-pre', text: T('cancelled_reason', { r: tx.cancel_reason }) }));
    kids.push(el('p', { class: 'mb-0 text-sm', text: T('cancelled_frozen') }));
    return el('div', { class: 'alert alert-danger lx-cancelled', role: 'status' }, el('div', null, kids));
  }
  function stageList(el, stages, cancelled) {
    return el('ol', { class: 'adm-stages lx-stepper' + (cancelled ? ' is-cancelled' : ''), 'aria-label': T('lc_title') }, stages.map(function (s) {
      var cls = s.state === 'done' ? 'is-done' : s.state === 'current' ? 'is-current' : s.state === 'skipped' ? 'is-skipped' : '';
      var label = (isEn() && s.label_en) || s.label_ar || s.code;
      var title = [label, s.state === 'skipped' ? T('lc_na_title') : null, s.reached_at ? T('lc_reached', { d: s.reached_at_text }) : null, s.auto ? T('lc_auto') + (s.cause ? ' — ' + T('cause_' + s.cause) : '') : null].filter(Boolean).join(' · ');
      return el('li', { class: cls, 'aria-current': s.state === 'current' ? 'step' : null, title: title }, el('span', null, [
        label, s.auto ? el('small', { class: 'lx-auto', text: T('lc_auto') }) : null,
        s.state === 'skipped' ? el('small', { class: 'lx-na', text: T('lc_na') }) : null
      ]));
    }));
  }
  // host: an empty node at the top of the detail page; fallbackStages(): admin.js' static list (on an error)
  function stepper(host, tx, api, fallback) {
    var el = api.el;
    host.textContent = '';
    if (tx.cancelled_at) host.appendChild(cancelledBanner(tx, api));
    var wrap = el('div', { class: 'lx-lifecycle' });
    host.appendChild(wrap);
    wrap.appendChild(el('p', { class: 'text-sm text-muted', text: T('loading') }));
    return call(api, 'txLifecycle', tx.id).then(function (r) {
      wrap.textContent = '';
      if (r.error || !r.data || !Array.isArray(r.data.stages)) {
        if (fallback) wrap.appendChild(fallback());
        if (r.error) wrap.appendChild(el('p', { class: 'form-hint', text: T('lc_failed', { e: errText(api, r.error) }) }));
      } else {
        var d = r.data;
        d.stages.forEach(function (s) { if (s.reached_at) s.reached_at_text = fmtDate(api, s.reached_at, true); });
        wrap.appendChild(stageList(el, d.stages, !!d.cancelled));
        var notes = [];
        if (!d.cancelled) {
          if (d.next) {
            var nx = d.stages.filter(function (s) { return s.code === d.next.code; })[0];
            var nlabel = nx ? ((isEn() && nx.label_en) || nx.label_ar) : lab(api, 'operational_status', d.next.code);
            notes.push(el('li', null, [el('strong', { text: T('lc_next', { s: nlabel }) }), ' ', T(nextManual(d) ? 'lc_next_manual' : 'lc_next_auto')]));
            if (d.next.containers_not_returned) notes.push(el('li', { text: T('lc_ctr_wait', { n: d.next.containers_not_returned }) }));
            if ((d.next.docs_missing || []).length) {
              notes.push(el('li', { text: T('lc_docs_missing', { list: d.next.docs_missing.map(function (k) { return lab(api, 'document_kind', k); }).join('، ') }) }));
            }
          } else {
            notes.push(el('li', { text: T('lc_last') }));
          }
          if ((d.pending_containers || []).length && d.cargo_unit_type !== 'roro') {
            notes.push(el('li', null, [T('lc_pending', { list: '' }), el('bdi', { dir: 'ltr', class: 'num', text: d.pending_containers.join(', ') })]));
          }
        }
        if (notes.length) wrap.appendChild(el('ul', { class: 'adm-list lx-next' }, notes));
        if (!d.cancelled && d.follow_up_required && d.cargo_unit_type !== 'roro') wrap.appendChild(alertNode(el, 'warning', T('lc_follow')));
        wrap.appendChild(el('p', { class: 'form-hint', text: T('lc_hint') }));
      }
      var cc = cancelControl(tx, api);
      if (cc) wrap.appendChild(cc);
    });
  }

  // the legacy rows for the detail card ([label, Node|text]); fills the party names when they arrive
  function detailRows(tx, api) {
    var el = api.el, rows = [];
    var roro = tx.cargo_unit_type === 'roro';
    rows.push([T('k_type'), tx.transaction_type === 're_export' ? pillNode(el, 'warning', lab(api, 'transaction_type', 're_export')) : lab(api, 'transaction_type', tx.transaction_type || 'normal')]);
    rows.push([T('k_unit'), lab(api, 'cargo_unit_type', tx.cargo_unit_type || 'container')]);
    if (roro) {
      rows.push([T('k_chassis'), el('bdi', { dir: 'ltr', class: 'num', text: tx.chassis_no || T('none') })]);
      if (tx.vehicle_plate_no) rows.push([T('k_plate'), el('bdi', { dir: 'ltr', class: 'num', text: tx.vehicle_plate_no })]);
    }
    var portSpan = el('span', { text: tx.port_code ? portName(tx.port_code) : T('none') });
    rows.push([T('k_port'), portSpan]);
    if (tx.port_code) ports(api).then(function (list) { portSpan.textContent = portName(tx.port_code, list); });
    var termSpan = el('span', { text: tx.terminal_party_id ? T('loading') : T('none') });
    rows.push([T('k_terminal'), termSpan]);
    rows.push([T('k_mode'), lab(api, 'transport_mode', tx.transport_mode || 'driver')]);
    var carrSpan = null;
    if (tx.transport_mode === 'carrier_order') {
      carrSpan = el('span', { text: tx.transport_party_id ? T('loading') : T('none') });
      rows.push([T('k_transport_party'), carrSpan]);
      rows.push([T('k_order'), el('span', null, [el('bdi', { dir: 'ltr', class: 'num', text: tx.transport_order_no || T('none') }),
        tx.transport_order_date ? ' · ' + fmtDate(api, tx.transport_order_date) : null])]);
    }
    if (tx.declaration_notes) rows.push([T('k_decl_notes'), el('span', { class: 'adm-pre', text: tx.declaration_notes })]);
    if (tx.terminal_party_id || (carrSpan && tx.transport_party_id)) {
      parties(api).then(function (list) {
        function nm(id) { var p = list.filter(function (x) { return x.id === id; })[0]; return p ? partyLabel(p) : T('none'); }
        if (tx.terminal_party_id) termSpan.textContent = nm(tx.terminal_party_id);
        if (carrSpan && tx.transport_party_id) carrSpan.textContent = nm(tx.transport_party_id);
      });
    }
    return rows;
  }

  /* ==================================================================
     55 — combined movements (save_movement)
     ================================================================== */
  var MV_NAMES = ['container_id', 'appointment_at', 'appointment_no', 'terminal_party_id', 'appointment_status', 'window_minutes', 'driver_name',
    'driver_phone', 'truck_plate', 'carrier_id', 'origin', 'destination', 'cost_amount', 'sell_amount', 'movement_status', 'delivered_at',
    'return_deadline', 'return_location', 'return_yard_party_id', 'notes', 'reason'];
  function renderMovements(root, tx, api) {
    var el = api.el;
    var roro = tx.cargo_unit_type === 'roro';
    var canTr = !tx.cancelled_at && api.can('transportWriter', tx.branch_id);
    var canFin = api.can(TRIP_FIN, tx.branch_id);
    function ctrNo(id) { var c = (tx.containers || []).filter(function (x) { return x.id === id; })[0]; return c ? c.container_no : null; }
    function ctrOf(id) { return (tx.containers || []).filter(function (x) { return x.id === id; })[0] || null; }

    function driverSuggest(body) {
      var name = body.querySelector('[name=driver_name]'), phone = body.querySelector('[name=driver_phone]'), truck = body.querySelector('[name=truck_plate]');
      var list = el('div', { class: 'lx-suggest', 'aria-live': 'polite', hidden: true });
      name.parentNode.appendChild(list);
      var seq = 0, timer = null;
      function run() {
        var q = String(name.value || '').trim(), mine = ++seq;
        if (q.length === 1) { list.hidden = true; return; }
        call(api, 'driverDirectory', q).then(function (r) {
          if (mine !== seq) return;
          var rows = rowsOf(r).slice(0, 6);
          list.textContent = '';
          if (r.error || !rows.length) { list.hidden = true; return; }
          list.appendChild(el('span', { class: 'form-hint', text: T('mv_suggest') }));
          list.appendChild(el('ul', { class: 'adm-mini' }, rows.map(function (d) {
            var b = el('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: T('mv_suggest_pick') });
            b.addEventListener('click', function (e) {
              e.preventDefault();
              name.value = d.full_name || ''; phone.value = d.phone || '';
              if (d.last_truck_plate && !String(truck.value || '').trim()) truck.value = d.last_truck_plate;
              list.hidden = true;
            });
            return el('li', { class: 'adm-mini-row' }, [
              el('span', { class: 'adm-mini-main' }, [el('span', { class: 'adm-mini-title', text: d.full_name || '' }),
                el('span', { class: 'adm-mini-sub' }, [el('bdi', { dir: 'ltr', text: [d.phone, d.last_truck_plate].filter(Boolean).join(' · ') })])]),
              el('span', { class: 'adm-mini-side' }, b)
            ]);
          })));
          list.hidden = false;
        });
      }
      name.addEventListener('input', function () { if (timer) clearTimeout(timer); timer = setTimeout(run, 250); });
      name.addEventListener('focus', function () { if (!String(name.value || '').trim()) run(); });
    }
    function tasPreview(body) {
      var inp = body.querySelector('[name=appointment_no]'), out = el('span', { class: 'form-hint lx-tas', 'aria-live': 'polite' });
      inp.parentNode.appendChild(out);
      function upd() { var n = normTas(inp.value); out.textContent = n && n !== String(inp.value || '').trim() ? T('mv_no_preview', { v: n }) : ''; }
      inp.addEventListener('input', upd); upd();
    }
    function bindStatus(body) {
      var st = body.querySelector('[name=movement_status]'), grp = body.querySelector('[data-lx=delivered]');
      function sync() { show(grp, st.value === 'delivered'); }
      st.addEventListener('change', sync); sync();
    }
    function dialog(m, preset) {
      Promise.all([parties(api), tx.port_code ? call(api, 'portOperators', tx.port_code) : Promise.resolve({ data: [] })]).then(function (res) {
        var plist = res[0], ops = rowsOf(res[1]);
        var termOpts = [['', T('optional_none')]].concat(ops.map(function (x) { return [x.party_id, (isEn() && x.name_en) || x.name_ar || x.name_en]; }));
        if (!ops.length) termOpts = partyOpts(plist, 'terminal_operator', T('optional_none'), m && m.terminal_party_id);
        else if (m && m.terminal_party_id && !ops.some(function (x) { return x.party_id === m.terminal_party_id; })) termOpts.push([m.terminal_party_id, m.terminal_party_id.slice(0, 8)]);
        var cur = m || {};
        var ctr = ctrOf(cur.container_id);
        var f = [];
        if (!roro) {
          f.push(fieldNode(el, { name: 'container_id', label: T('mv_container'), type: 'select', req: true, value: cur.container_id || ((tx.containers || []).length === 1 ? tx.containers[0].id : ''),
            options: [['', T('choose')]].concat((tx.containers || []).map(function (c) { return [c.id, c.container_no]; })) }));
        }
        f.push(fieldNode(el, { name: 'appointment_at', label: T('mv_at'), type: 'datetime-local', req: !roro && !m, value: toLocal(cur.appointment_at) }));
        f.push(fieldNode(el, { name: 'appointment_no', label: T('mv_no'), ltr: true, max: 60, value: cur.appointment_no, hint: T('mv_no_hint') }));
        f.push(fieldNode(el, { name: 'terminal_party_id', label: T('mv_terminal'), type: 'select', value: cur.terminal_party_id || tx.terminal_party_id || '', options: termOpts }));
        f.push(fieldNode(el, { name: 'appointment_status', label: T('mv_appt_status'), type: 'select', value: cur.appointment_status === 'confirmed' ? 'confirmed' : 'requested',
          options: [['requested', lab(api, 'appt_status', 'requested')], ['confirmed', lab(api, 'appt_status', 'confirmed')]] }));
        f.push(fieldNode(el, { name: 'window_minutes', label: T('mv_window'), type: 'number', min: 0, step: 5, value: cur.window_minutes }));
        f.push(fieldNode(el, { name: 'driver_name', label: T('mv_driver_name'), req: true, max: 120, value: cur.driver_name }));
        f.push(fieldNode(el, { name: 'driver_phone', label: T('mv_driver_phone'), req: true, ltr: true, max: 20, type: 'tel', inputmode: 'tel', value: cur.driver_phone, hint: T('mv_phone_hint'), placeholder: '05XXXXXXXX' }));
        f.push(fieldNode(el, { name: 'truck_plate', label: T('mv_truck'), req: true, ltr: true, max: 20, value: cur.truck_plate }));
        f.push(fieldNode(el, { name: 'carrier_id', label: T('mv_carrier'), type: 'select', value: cur.carrier_id || '', options: partyOpts(plist, 'carrier', T('optional_none'), cur.carrier_id) }));
        f.push(fieldNode(el, { name: 'origin', label: T('mv_origin'), max: 120, value: cur.origin }));
        f.push(fieldNode(el, { name: 'destination', label: T('mv_dest'), max: 120, value: cur.destination }));
        if (canFin) {
          f.push(fieldNode(el, { name: 'cost_amount', label: T('mv_cost'), type: 'number', min: 0, step: '0.01', value: cur.cost_amount }));
          f.push(fieldNode(el, { name: 'sell_amount', label: T('mv_sell'), type: 'number', min: 0, step: '0.01', value: cur.sell_amount }));
        }
        f.push(fieldNode(el, { name: 'movement_status', label: T('mv_status'), type: 'select', value: preset || (cur.movement_status === 'delivered' ? 'delivered' : 'registered'),
          options: [['registered', lab(api, 'movement_status', 'registered')], ['delivered', lab(api, 'movement_status', 'delivered')]] }));
        f.push(fieldNode(el, { name: 'delivered_at', label: T('mv_delivered_at'), type: 'datetime-local', value: toLocal(new Date().toISOString()), group: 'delivered' }));
        if (!roro) {
          f.push(fieldNode(el, { name: 'return_deadline', label: T('mv_return_deadline'), type: 'date', value: cur.return_deadline || (ctr && ctr.return_deadline) }));
          f.push(fieldNode(el, { name: 'return_location', label: T('mv_return_location'), max: 120, value: cur.return_location || (ctr && ctr.return_location) }));
          f.push(fieldNode(el, { name: 'return_yard_party_id', label: T('mv_return_yard'), type: 'select', value: cur.return_yard_party_id || (ctr && ctr.return_yard_party_id) || '',
            options: partyOpts(plist, 'yard', T('optional_none'), cur.return_yard_party_id || (ctr && ctr.return_yard_party_id)) }));
        }
        f.push(fieldNode(el, { name: 'notes', label: T('mv_notes'), type: 'textarea', max: 1000, full: true, value: cur.notes }));
        if (m) f.push(fieldNode(el, { name: 'reason', label: T('mv_reason'), type: 'textarea', max: 500, full: true, hint: T('mv_reason_hint') }));
        var key = idem(api);
        api.modal({
          title: m ? T('mv_edit_title') : T('mv_new_title'), submitText: T('save'), wide: true,
          body: [roro ? alertNode(el, 'info', T('mv_roro_hint')) : null, el('div', { class: 'adm-form-grid' }, f),
            el('p', { class: 'form-hint', text: T('mv_hint') + (canFin ? '' : ' ' + T('mv_money_hidden')) })],
          onOpen: function (b) { driverSuggest(b); tasPreview(b); bindStatus(b); },
          onSubmit: function (form) {
            var vals = formVals(form, MV_NAMES);
            var r = movementPayload(vals, { tx: tx, movement: m, canFin: canFin, isoAt: fromLocal(vals.appointment_at), isoDelivered: fromLocal(vals.delivered_at) });
            if (r.error) return T(r.error);
            return call(api, 'saveMovement', r.payload, { idemKey: key(r.payload) }).then(function (x) {
              if (x.error) return errText(api, x.error);
              var d = x.data || {}, msgs = [d.already_exists ? T('mv_exists') : T('mv_saved')];
              if (d.driver_created) msgs.push(T('mv_driver_new'));
              if (d.truck_created) msgs.push(T('mv_truck_new'));
              api.toast(msgs.join(' '), d.already_exists ? 'info' : 'success');
              if (d.follow_up_required && (d.pending_containers || []).length && !roro) api.toast(T('mv_follow', { list: d.pending_containers.join(', ') }), 'warning');
              api.refresh();
              return true;
            });
          }
        });
      });
    }
    function cancelMv(m) {
      api.modal({
        title: T('mv_cancel_title', { d: m.appointment_at ? fmtDate(api, m.appointment_at, true) : (ctrNo(m.container_id) || '') }), submitText: T('mv_cancel'), danger: true,
        body: el('div', { class: 'adm-form-grid' }, fieldNode(el, { name: 'reason', label: T('mv_reason'), type: 'textarea', req: true, max: 500, full: true })),
        onSubmit: function (form) {
          var why = blank(form.elements.reason && form.elements.reason.value);
          if (!why) return T('mv_need_reason');
          var p = { transaction_id: tx.id, movement_status: 'cancelled', reason: why };
          if (m.appointment_id) p.appointment_id = m.appointment_id; else p.trip_id = m.trip_id;
          return call(api, 'saveMovement', p, { idemKey: newKey(api) }).then(function (x) {
            if (x.error) return errText(api, x.error);
            api.toast(T('mv_cancelled_done'), 'success'); api.refresh(); return true;
          });
        }
      });
    }

    var head = el('header', { class: 'app-card-head adm-card-head' }, [el('h3', { class: 'app-card-title', text: T('mv_title') }),
      canTr ? el('div', { class: 'adm-card-actions' }, (function () {
        var b = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: T('mv_add') });
        b.addEventListener('click', function (e) { e.preventDefault(); dialog(null); });
        return b;
      })()) : null]);
    var body = el('div', { class: 'app-card-body adm-card-body' }, el('p', { class: 'text-sm text-muted', text: T('loading') }));
    root.appendChild(el('section', { class: 'app-card adm-card ops-tx-card lx-movements' }, [head, body]));
    return call(api, 'listMovements', tx.id).then(function (r) {
      body.textContent = '';
      if (r.error) { body.appendChild(alertNode(el, 'warning', errText(api, r.error))); return; }
      var list = rowsOf(r);
      var headers = [roro ? null : T('mv_container'), T('mv_at'), T('mv_driver_name') + ' / ' + T('mv_truck'), T('mv_dest'), T('mv_status'),
        roro ? null : T('mv_return'), canFin ? T('mv_cost') + ' / ' + T('mv_sell') : null, ''].filter(function (h) { return h !== null; });
      var trs = list.map(function (m) {
        var live = LIVE_MOVEMENT.indexOf(m.movement_status) !== -1;
        var cells = [];
        if (!roro) cells.push(el('td', null, el('bdi', { dir: 'ltr', class: 'num', text: m.container_no || ctrNo(m.container_id) || T('none') })));
        cells.push(el('td', null, [el('span', { class: 'cell-main', text: m.appointment_at ? fmtDate(api, m.appointment_at, true) : T('none') }),
          m.appointment_no ? el('span', { class: 'adm-sub' }, el('bdi', { dir: 'ltr', text: m.appointment_no })) : null,
          m.booking_ref && m.booking_ref !== m.appointment_no ? el('span', { class: 'adm-sub' }, el('bdi', { dir: 'ltr', text: m.booking_ref })) : null,
          m.operator_name || m.operator_ticket_no ? el('span', { class: 'adm-sub', text: T('mv_operator') + ': ' + [m.operator_name, m.operator_ticket_no].filter(Boolean).join(' · ') }) : null,
          m.zone_gate ? el('span', { class: 'adm-sub', text: T('mv_zone') + ': ' + m.zone_gate }) : null,
          m.appointment_status ? el('span', { class: 'adm-sub', text: lab(api, 'appt_status', m.appointment_status) }) : null]));
        // step 5: the transport party of the trip (approved appointment cards) and its per-trip order
        cells.push(el('td', null, [el('span', { class: 'cell-main', text: m.driver_name || T('none') }),
          el('span', { class: 'adm-sub' }, el('bdi', { dir: 'ltr', text: [m.driver_phone, m.truck_plate].filter(Boolean).join(' · ') || T('none') })),
          m.party_type || m.party_name ? el('span', { class: 'adm-sub', text: T('mv_party') + ': ' + [m.party_type ? lab(api, 'transport_party_type', m.party_type) : null, m.party_name].filter(Boolean).join(' — ') }) : null,
          m.transport_order_no ? el('span', { class: 'adm-sub' }, [T('mv_order_no') + ': ', el('bdi', { dir: 'ltr', text: m.transport_order_no })]) : null]));
        cells.push(el('td', null, [el('span', { class: 'cell-main', text: m.destination || T('none') }), m.origin ? el('span', { class: 'adm-sub', text: m.origin }) : null]));
        cells.push(el('td', null, [pillNode(el, MV_TONE[m.movement_status] || 'blue', lab(api, 'movement_status', m.movement_status)),
          m.unloaded_at ? el('span', { class: 'adm-sub', text: fmtDate(api, m.unloaded_at, true) }) : null]));
        if (!roro) cells.push(el('td', null, [el('span', { class: 'cell-main', text: m.return_deadline ? fmtDate(api, m.return_deadline) : T('none') }),
          m.return_location ? el('span', { class: 'adm-sub', text: m.return_location }) : null,
          m.return_status ? el('span', { class: 'adm-sub', text: lab(api, 'container_return_status', m.return_status) }) : null]));
        if (canFin) cells.push(el('td', { class: 'num' }, [m.cost_amount != null ? api.fmtMoney(m.cost_amount, 'SAR') : T('none'),
          m.sell_amount != null ? el('span', { class: 'adm-sub', text: api.fmtMoney(m.sell_amount, 'SAR') }) : null]));
        var acts = [];
        if (canTr && live) {
          var e1 = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: T('edit') });
          e1.addEventListener('click', function (e) { e.preventDefault(); dialog(m); });
          var e2 = el('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: T('mv_deliver') });
          e2.addEventListener('click', function (e) { e.preventDefault(); dialog(m, 'delivered'); });
          var e3 = el('button', { class: 'btn btn-sm btn-ghost adm-text-danger', type: 'button', text: T('mv_cancel') });
          e3.addEventListener('click', function (e) { e.preventDefault(); cancelMv(m); });
          acts = [e1, e2, e3];
        }
        cells.push(el('td', null, el('div', { class: 'adm-row-actions' }, acts)));
        return el('tr', { class: m.movement_status === 'cancelled' ? 'adm-voided' : null }, cells);
      });
      var tbody = el('tbody', null, trs.length ? trs : el('tr', { class: 'adm-empty-row' }, el('td', { colspan: headers.length }, el('div', { class: 'empty-state is-compact' }, el('p', { text: T('mv_empty') })))));
      body.appendChild(el('div', { class: 'table-wrap adm-table-wrap' }, el('table', { class: 'table table-striped adm-table' }, [
        el('thead', null, el('tr', null, headers.map(function (h) { return el('th', { scope: 'col', text: h }); }))), tbody])));
      body.appendChild(el('p', { class: 'form-hint', text: T('mv_hint') + (canFin ? '' : ' ' + T('mv_money_hidden')) }));
    });
  }

  /* ------------------------------------------------------------------
     Public surface + registration
     ------------------------------------------------------------------ */
  OPS.legacyTx = {
    VERSION: 'lx-ui-1',
    t: T, label: lab, isCancelled: function (tx) { return !!(tx && tx.cancelled_at); },
    txFields: txFields, dupCheck: dupCheck, dupPanel: dupPanel, stepper: stepper, cancelDialog: cancelDialog,
    detailRows: detailRows, hijriInfo: hijriInfo, gregorianToHijri: gregorianToHijri, portName: portName,
    pure: { legacyPatch: legacyPatch, dupMessages: dupMessages, cancelBlock: cancelBlock, cancelErrText: cancelErrText,
      movementPayload: movementPayload, hijriInfo: hijriInfo, normPhone: normPhone, normChassis: normChassis, normOrderNo: normOrderNo,
      nextManual: nextManual }
  };
  var MINE = [{ id: 'movements', order: 55, render: renderMovements }];
  var ids = MINE.map(function (s) { return s.id; });
  for (var i = OPS.txSections.length - 1; i >= 0; i--) {
    if (OPS.txSections[i] && ids.indexOf(OPS.txSections[i].id) !== -1) OPS.txSections.splice(i, 1);
  }
  MINE.forEach(function (s) { OPS.txSections.push(s); });
})();
