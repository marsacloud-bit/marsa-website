/* ==========================================================================
   مرسى | MARSA — G4 transaction-detail sections (#tx/<id>)  →  MarsaOps.txSections
   --------------------------------------------------------------------------
   Contract: docs/online/G4_SPEC.md ("Front end → Transaction-detail sections").
   Loaded before admin.js, which renders every section after its own cards as
     section.render(root, tx, api)   (api: see assets/js/ops/tx-sections.js)
   Sections (order):
     80 fin-costs  «التكاليف والمبالغ المحمّلة» — expected costs (trip / demurrage /
        adjustment / manual) with variance review, supplier-invoice allocations
        (approve / reject / reverse), storage & demurrage figures, exceptional
        fees & adjustments (create / review), client charges (manual / at cost /
        markup / trip sell) with approval, void and collection evidence.
     85 fin-margin «الهامش التحليلي» — tx_margin per currency, level, pending list.
   * Each section renders nothing unless api.can('finRead', tx.branch_id); write
     buttons need finWrite, approve buttons finApprove at the transaction branch.
     Four eyes: approve is not offered on a row the viewer created (admin aside);
     the server decides in every case (RLS + guarded RPCs).
   * Costs are net (excl. VAT, G4-1); every figure is per currency (no FX, G4-5).
     The margin is analytical, never accounting profit. Clients see none of this.
   * Strings: own namespace 'fintx' (ar + en) registered below; labels of the
     fin_* domains come from 'fin.<domain>_<code>' (assets/i18n/fin.js) when
     present, else from 'fintx.lbl_<domain>_<code>'.
   * Server and user data are inserted with textContent / createElement only.
   ========================================================================== */
(function () {
  'use strict';

  var I = window.MarsaI18n;
  var OPS = window.MarsaOps = window.MarsaOps || { views: {}, txSections: [] };
  if (!Array.isArray(OPS.txSections)) OPS.txSections = [];

  /* ------------------------------------------------------------------
     Strings ('fintx.<k>'; labels 'fintx.lbl_<domain>_<code>')
     ------------------------------------------------------------------ */
  if (I && typeof I.register === 'function') {
    I.register('fintx', {
      ar: {
        none: '—', loading: 'جارٍ التحميل…', load_failed: 'تعذّر تحميل هذا القسم: {e}', required: 'أكمل الحقول المطلوبة.',
        reason_required: 'اكتب السبب (مطلوب).', note_required: 'اكتب ملاحظة (مطلوبة).', saved: 'تم الحفظ.', choose: 'اختر', optional_none: 'بدون',
        all_containers: 'المعاملة كلها', amount_bad: 'أدخل مبلغًا صحيحًا (صفر أو أكثر، بخانتين عشريتين على الأكثر).',
        open_invoice: 'فتح الفاتورة', four_eyes: 'بانتظار معتمد آخر (لا تعتمد ما أنشأته).',
        costs_title: 'التكاليف والمبالغ المحمّلة',
        costs_hint: 'التكلفة هنا صافية قبل الضريبة (ضريبة المدخلات قابلة للاسترداد). كل مبلغ بعملته، دون تحويل عملات.',
        late_hint: 'المعاملة في مرحلة الفوترة أو مغلقة: أي تكلفة جديدة تُعامل كتكلفة متأخرة وتحتاج سببًا عند اعتمادها.',
        // accruals
        acc_title: 'التكاليف المتوقعة', acc_add: 'تكلفة متوقعة يدوية', acc_source: 'المصدر', acc_supplier: 'المورد / الناقل',
        acc_amount: 'المبلغ المتوقع', acc_matched: 'المطابَق من الفواتير', acc_status: 'الحالة', acc_unknown: 'غير معروف',
        acc_pending: 'مبلغ جديد بانتظار المراجعة: {a}', acc_variance: 'الفرق: {a}', acc_empty: 'لا توجد تكاليف متوقعة لهذه المعاملة.',
        acc_review: 'مراجعة الفرق', acc_void: 'إلغاء', acc_review_title: 'مراجعة فرق التكلفة المتوقعة', acc_decision: 'القرار',
        acc_void_title: 'إلغاء التكلفة المتوقعة', acc_saved: 'سُجّلت التكلفة المتوقعة.', acc_reviewed: 'حُفظ قرار المراجعة.', acc_voided: 'أُلغيت التكلفة المتوقعة.',
        acc_hint: 'التكلفة المتوقعة ليست دفعًا ولا تُحسب مرتين: عند مطابقتها بفاتورة مورد تُحتسب الفاتورة وحدها.',
        acc_trip: 'رحلة رقم {n}', acc_basis: 'الأساس', acc_note: 'ملاحظة',
        // allocations
        al_title: 'توزيعات فواتير الموردين', al_invoice: 'الفاتورة', al_line: 'البند', al_amount: 'المبلغ (صافي)', al_status: 'الحالة',
        al_target: 'على', al_empty: 'لا توجد توزيعات من فواتير الموردين على هذه المعاملة.', al_late: 'تكلفة متأخرة',
        al_approve: 'اعتماد', al_reject: 'رفض', al_reverse: 'عكس', al_approve_title: 'اعتماد توزيع التكلفة', al_reject_title: 'رفض توزيع التكلفة',
        al_reverse_title: 'عكس توزيع معتمد', al_late_note: 'ملاحظة اعتماد التكلفة المتأخرة', al_approved: 'اعتُمد التوزيع.', al_rejected: 'رُفض التوزيع.',
        al_reversed: 'عُكس التوزيع.', al_hint: 'التوزيع يُنشأ من صفحة الفاتورة («فواتير الموردين»). مجموع التوزيعات لا يتجاوز صافي البند.',
        al_share: 'نسبة {p}٪', al_inv_status: 'حالة الفاتورة: {s}', al_approve_all: 'اعتماد المقترح ({n})',
        // demurrage
        dm_title: 'الأرضيات والغرامات', dm_kind: 'النوع', dm_period: 'الفترة', dm_charged: 'محمّل على العميل', dm_collected: 'محصّل من العميل',
        dm_paid: 'مدفوع للمشغل', dm_paid_client: 'دفعه العميل للمشغل مباشرة', dm_remaining: 'المتبقي', dm_to_collect: 'للتحصيل: {a}',
        dm_to_pay: 'للسداد للمشغل: {a}', dm_estimated: 'تقديري', dm_manage: 'إدارة الملفات', dm_empty: 'لا توجد ملفات أرضيات أو غرامات لهذه المعاملة.',
        dm_hint: 'الأرقام الأربعة منفصلة: التحصيل من العميل لا يعني سداد المشغل. المبالغ هنا شاملة الضريبة.', dm_until: '{a} ← {b}',
        // adjustments
        adj_title: 'رسوم وتسويات استثنائية', adj_add: 'رسم / تسوية', adj_kind: 'النوع', adj_amount: 'المبلغ (صافي)', adj_reason: 'السبب',
        adj_status: 'الحالة', adj_doc: 'المستند', adj_doc_tx: 'مستند من مستندات المعاملة', adj_doc_file: 'أو ارفع ملف الإثبات',
        adj_exception: 'الاستثناء التشغيلي المرتبط', adj_supplier: 'المورد', adj_empty: 'لا توجد رسوم أو تسويات استثنائية.',
        adj_need_doc: 'اربط الرسم بمستند: اختر مستندًا من المعاملة أو ارفع ملف الإثبات.', adj_review: 'مراجعة', adj_review_title: 'مراجعة الرسم / التسوية',
        adj_saved: 'سُجّل الرسم / التسوية بانتظار الاعتماد.', adj_reviewed: 'حُفظت المراجعة.', adj_decision: 'القرار',
        adj_hint: 'الرسم المعتمد (فارغ، غسيل، إصلاح…) يصبح تكلفة متوقعة تطابقها فاتورة المورد عند وصولها. الرسم المرفوض يبقى محفوظًا.',
        adj_invoice: 'فاتورة {n}',
        // charges
        ch_title: 'المبالغ المحمّلة على العميل', ch_add: 'مبلغ على العميل', ch_kind: 'النوع', ch_desc: 'الوصف', ch_service: 'الخدمة',
        ch_qty: 'الكمية', ch_price: 'سعر الوحدة', ch_net: 'الصافي', ch_vat: 'الضريبة', ch_total: 'الإجمالي', ch_status: 'الحالة',
        ch_source: 'المصدر', ch_link: 'مرتبط بـ', ch_link_none: 'بدون ربط (سعر يدوي)', ch_markup: 'نسبة الإضافة ٪', ch_vat_rate: 'نسبة الضريبة ٪',
        ch_currency: 'العملة', ch_note: 'ملاحظة', ch_collected: 'محصّل: {a}', ch_empty: 'لا توجد مبالغ محمّلة على العميل.',
        ch_approve: 'اعتماد', ch_void: 'إلغاء', ch_to_draft: 'إرجاع إلى مسودة', ch_edit: 'تعديل', ch_collect: 'تسجيل تحصيل',
        ch_status_title: '{s}: {d}', ch_saved: 'حُفظ المبلغ كمسودة.', ch_status_done: 'تغيّرت حالة المبلغ.',
        ch_cost_changed: 'تغيّرت التكلفة منذ التسعير ({a} ← {b}). لا يُعاد التسعير تلقائيًا.',
        ch_hint: 'السعر مستقل عن التكلفة إلا إذا اخترت ربطه بتكلفة (بالتكلفة أو بإضافة نسبة) أو بسعر بيع رحلة. المبلغ المعتمد ليس فاتورة ضريبية؛ الفوترة الرسمية في المرحلة القادمة.',
        ch_link_trip: 'سعر بيع رحلة {n}{c}: {a}', ch_link_cost: 'تكلفة: {d} — {a}', ch_price_from_link: 'السعر يُحسب من التكلفة المرتبطة عند الحفظ ويُخزَّن، ولا يُعاد حسابه لاحقًا.',
        ch_price_required: 'أدخل سعر الوحدة.', ch_link_required: 'اختر التكلفة المرتبطة أو سعر الرحلة.', ch_markup_required: 'أدخل نسبة الإضافة.',
        ch_suggest_failed: 'تعذّر تحميل الاقتراحات ({e}). يمكنك إدخال سعر يدوي.',
        // collections
        col_title: 'تسجيل تحصيل من العميل', col_amount: 'المبلغ', col_date: 'تاريخ التحصيل', col_method: 'الطريقة', col_ref: 'المرجع',
        col_file: 'ملف الإثبات (اختياري)', col_need: 'أدخل مرجعًا أو أرفق ملف الإثبات.', col_saved: 'سُجّل التحصيل (إثبات فقط، ليس سند قبض).',
        col_void: 'إلغاء التحصيل', col_voided: 'أُلغي التحصيل.', col_list: 'التحصيلات', col_void_title: 'إلغاء تحصيل {a}',
        upload_failed: 'تعذّر رفع ملف الإثبات: {e}',
        // margin
        mg_title: 'الهامش التحليلي', mg_banner: 'هامش تحليلي — ليس ربحًا محاسبيًا. الأرقام صافية قبل الضريبة ولكل عملة على حدة.',
        mg_currency: 'العملة', mg_charges: 'إيراد الخدمات (معتمد)', mg_internal: 'منها خدمات داخلية', mg_draft: 'مسودات غير محتسبة',
        mg_reimb: 'مبالغ مستردة محمّلة', mg_cost_confirmed: 'تكلفة مؤكدة', mg_cost_estimated: 'تكلفة تقديرية', mg_unknown: 'تكاليف غير معروفة المبلغ',
        mg_pass: 'تكاليف مستردة (تمرير)', mg_client_direct: 'دفعها العميل للمورد مباشرة', mg_margin_confirmed: 'الهامش المؤكد',
        mg_margin_expected: 'الهامش المتوقع', mg_gap: 'فرق المبالغ المستردة', mg_level: 'مستوى التأكيد', mg_mixed: 'المعاملة بأكثر من عملة: لا يُجمع الهامش بين العملات.',
        mg_pending: 'بنود تؤثر على الدقة', mg_no_pending: 'لا توجد بنود معلّقة.', mg_empty: 'لا توجد مبالغ أو تكاليف مسجّلة لهذه المعاملة بعد.',
        mg_figure: 'البند', mg_value: 'القيمة',
        // labels: sources / kinds / statuses (fallback when assets/i18n/fin.js has no entry)
        lbl_fin_accrual_source_trip: 'رحلة نقل', lbl_fin_accrual_source_demurrage: 'أرضيات / غرامات', lbl_fin_accrual_source_adjustment: 'رسم استثنائي', lbl_fin_accrual_source_manual: 'يدوي',
        lbl_fin_accrual_status_open: 'مفتوحة', lbl_fin_accrual_status_matched: 'مطابَقة', lbl_fin_accrual_status_variance: 'فرق بانتظار المراجعة', lbl_fin_accrual_status_void: 'ملغاة',
        lbl_fin_variance_reason_amount_diff: 'فرق في المبلغ', lbl_fin_variance_reason_trip_cost_changed_after_match: 'تغيّرت تكلفة الرحلة بعد المطابقة',
        lbl_fin_variance_reason_trip_cancelled_after_match: 'أُلغيت الرحلة بعد المطابقة', lbl_fin_variance_reason_allocation_reversed: 'عُكس توزيع',
        lbl_fin_accrual_decision_accept: 'قبول المطابَق وإسقاط الباقي', lbl_fin_accrual_decision_keep_open: 'إبقاء الباقي كتكلفة تقديرية',
        lbl_fin_accrual_decision_accept_new_amount: 'اعتماد المبلغ الجديد', lbl_fin_accrual_decision_keep_amount: 'الإبقاء على المبلغ السابق',
        lbl_fin_basis_agreed: 'متفق عليه', lbl_fin_basis_estimated: 'تقديري',
        lbl_fin_alloc_status_proposed: 'مقترح', lbl_fin_alloc_status_approved: 'معتمد', lbl_fin_alloc_status_rejected: 'مرفوض', lbl_fin_alloc_status_reversed: 'معكوس',
        lbl_fin_invoice_status_received: 'مستلمة', lbl_fin_invoice_status_under_review: 'قيد المراجعة', lbl_fin_invoice_status_approved: 'معتمدة',
        lbl_fin_invoice_status_disputed: 'متنازع عليها', lbl_fin_invoice_status_void: 'ملغاة',
        lbl_fin_charge_kind_service: 'خدمة', lbl_fin_charge_kind_internal_service: 'خدمة داخلية', lbl_fin_charge_kind_reimbursable: 'مبلغ مسترد (تمرير)',
        lbl_fin_charge_status_draft: 'مسودة', lbl_fin_charge_status_approved: 'معتمد', lbl_fin_charge_status_invoiced: 'مفوتر', lbl_fin_charge_status_void: 'ملغى',
        lbl_fin_charge_source_manual: 'يدوي', lbl_fin_charge_source_from_cost: 'بالتكلفة', lbl_fin_charge_source_markup: 'تكلفة + نسبة', lbl_fin_charge_source_from_trip: 'سعر بيع الرحلة',
        lbl_fin_payment_method_bank_transfer: 'تحويل بنكي', lbl_fin_payment_method_cash: 'نقدًا', lbl_fin_payment_method_cheque: 'شيك', lbl_fin_payment_method_card: 'بطاقة',
        lbl_fin_payment_method_offset: 'مقاصة', lbl_fin_payment_method_other: 'أخرى',
        lbl_fin_demurrage_kind_storage: 'أرضيات', lbl_fin_demurrage_kind_demurrage: 'غرامة تأخير (Demurrage)', lbl_fin_demurrage_kind_detention: 'غرامة احتجاز (Detention)',
        lbl_fin_demurrage_status_open: 'مفتوح', lbl_fin_demurrage_status_closed: 'مغلق', lbl_fin_demurrage_status_waived: 'معفى', lbl_fin_demurrage_status_void: 'ملغى',
        lbl_fin_adjustment_kind_late_cost: 'تكلفة متأخرة', lbl_fin_adjustment_kind_empty_fee: 'رسوم فارغ', lbl_fin_adjustment_kind_washing: 'غسيل',
        lbl_fin_adjustment_kind_repair: 'إصلاح', lbl_fin_adjustment_kind_amendment: 'تعديل فاتورة', lbl_fin_adjustment_kind_duplicate_invoice: 'فاتورة مكررة', lbl_fin_adjustment_kind_other: 'أخرى',
        lbl_fin_adjustment_status_proposed: 'بانتظار الاعتماد', lbl_fin_adjustment_status_approved: 'معتمد', lbl_fin_adjustment_status_rejected: 'مرفوض',
        lbl_fin_level_confirmed: 'مؤكد', lbl_fin_level_estimated: 'تقديري', lbl_fin_level_unknown: 'غير معروف',
        lbl_fin_pending_proposed_allocation: 'توزيع بانتظار الاعتماد', lbl_fin_pending_open_accrual: 'تكلفة متوقعة لم تصل فاتورتها',
        lbl_fin_pending_unknown_accrual: 'تكلفة متوقعة بلا مبلغ', lbl_fin_pending_variance_accrual: 'فرق تكلفة بانتظار المراجعة',
        lbl_fin_pending_draft_charge: 'مبلغ على العميل في المسودة', lbl_fin_pending_open_demurrage: 'ملف أرضيات / غرامات مفتوح',
        lbl_fin_pending_proposed_adjustment: 'رسم / تسوية بانتظار الاعتماد', lbl_fin_pending_reimbursable_gap: 'فرق بين المسترد المحمّل والتكلفة المستردة',
        lbl_fin_decision_approved: 'اعتماد', lbl_fin_decision_rejected: 'رفض',
        lbl_fin_service_customs_clearance: 'تخليص جمركي', lbl_fin_service_transport: 'نقل', lbl_fin_service_port_charges: 'رسوم الميناء',
        lbl_fin_service_delivery_order: 'إذن تسليم', lbl_fin_service_storage: 'أرضيات', lbl_fin_service_demurrage: 'غرامة تأخير',
        lbl_fin_service_detention: 'غرامة احتجاز', lbl_fin_service_inspection: 'معاينة', lbl_fin_service_empty_handling: 'مناولة فارغ',
        lbl_fin_service_washing: 'غسيل', lbl_fin_service_repair: 'إصلاح', lbl_fin_service_documentation: 'مستندات', lbl_fin_service_saber: 'سابر', lbl_fin_service_other: 'أخرى'
      },
      en: {
        none: '—', loading: 'Loading…', load_failed: 'This section could not be loaded: {e}', required: 'Complete the required fields.',
        reason_required: 'Enter the reason (required).', note_required: 'Enter a note (required).', saved: 'Saved.', choose: 'Choose', optional_none: 'None',
        all_containers: 'Whole transaction', amount_bad: 'Enter a valid amount (zero or more, at most 2 decimals).',
        open_invoice: 'Open invoice', four_eyes: 'Awaiting another approver (you cannot approve your own entry).',
        costs_title: 'Costs & client charges',
        costs_hint: 'Costs here are net of VAT (input VAT is recoverable). Every amount stays in its own currency; nothing is converted.',
        late_hint: 'The transaction is in billing or closed: any new cost is a late cost and needs a reason when approved.',
        acc_title: 'Expected costs', acc_add: 'Manual expected cost', acc_source: 'Source', acc_supplier: 'Supplier / carrier',
        acc_amount: 'Expected amount', acc_matched: 'Matched by invoices', acc_status: 'Status', acc_unknown: 'Unknown',
        acc_pending: 'New amount awaiting review: {a}', acc_variance: 'Difference: {a}', acc_empty: 'No expected costs for this transaction.',
        acc_review: 'Review difference', acc_void: 'Void', acc_review_title: 'Review expected-cost difference', acc_decision: 'Decision',
        acc_void_title: 'Void expected cost', acc_saved: 'Expected cost recorded.', acc_reviewed: 'Review decision saved.', acc_voided: 'Expected cost voided.',
        acc_hint: 'An expected cost is not a payment and is never counted twice: once a supplier invoice matches it, only the invoice counts.',
        acc_trip: 'Trip leg {n}', acc_basis: 'Basis', acc_note: 'Note',
        al_title: 'Supplier-invoice allocations', al_invoice: 'Invoice', al_line: 'Line', al_amount: 'Amount (net)', al_status: 'Status',
        al_target: 'On', al_empty: 'No supplier-invoice allocations on this transaction.', al_late: 'Late cost',
        al_approve: 'Approve', al_reject: 'Reject', al_reverse: 'Reverse', al_approve_title: 'Approve cost allocation', al_reject_title: 'Reject cost allocation',
        al_reverse_title: 'Reverse an approved allocation', al_late_note: 'Late-cost approval note', al_approved: 'Allocation approved.', al_rejected: 'Allocation rejected.',
        al_reversed: 'Allocation reversed.', al_hint: 'Allocations are created from the invoice page (Supplier invoices). Allocations never exceed the line net.',
        al_share: '{p}% share', al_inv_status: 'Invoice status: {s}', al_approve_all: 'Approve proposed ({n})',
        dm_title: 'Storage & demurrage', dm_kind: 'Kind', dm_period: 'Period', dm_charged: 'Charged to client', dm_collected: 'Collected from client',
        dm_paid: 'Paid to operator', dm_paid_client: 'Paid by client to operator', dm_remaining: 'Remaining', dm_to_collect: 'To collect: {a}',
        dm_to_pay: 'To pay operator: {a}', dm_estimated: 'estimated', dm_manage: 'Manage cases', dm_empty: 'No storage or demurrage cases for this transaction.',
        dm_hint: 'The four figures are separate: collecting from the client does not mean the operator is paid. Amounts here include VAT.', dm_until: '{a} → {b}',
        adj_title: 'Exceptional fees & adjustments', adj_add: 'Fee / adjustment', adj_kind: 'Kind', adj_amount: 'Amount (net)', adj_reason: 'Reason',
        adj_status: 'Status', adj_doc: 'Document', adj_doc_tx: 'A document of this transaction', adj_doc_file: 'or upload the evidence file',
        adj_exception: 'Related operational exception', adj_supplier: 'Supplier', adj_empty: 'No exceptional fees or adjustments.',
        adj_need_doc: 'Link the fee to a document: pick a transaction document or upload the evidence file.', adj_review: 'Review', adj_review_title: 'Review fee / adjustment',
        adj_saved: 'Fee / adjustment recorded, awaiting approval.', adj_reviewed: 'Review saved.', adj_decision: 'Decision',
        adj_hint: 'An approved fee (empty, washing, repair…) becomes an expected cost that the supplier invoice matches when it arrives. A rejected fee is kept.',
        adj_invoice: 'Invoice {n}',
        ch_title: 'Client charges', ch_add: 'Client charge', ch_kind: 'Kind', ch_desc: 'Description', ch_service: 'Service',
        ch_qty: 'Quantity', ch_price: 'Unit price', ch_net: 'Net', ch_vat: 'VAT', ch_total: 'Total', ch_status: 'Status',
        ch_source: 'Source', ch_link: 'Linked to', ch_link_none: 'No link (manual price)', ch_markup: 'Markup %', ch_vat_rate: 'VAT rate %',
        ch_currency: 'Currency', ch_note: 'Note', ch_collected: 'Collected: {a}', ch_empty: 'No client charges.',
        ch_approve: 'Approve', ch_void: 'Void', ch_to_draft: 'Back to draft', ch_edit: 'Edit', ch_collect: 'Record collection',
        ch_status_title: '{s}: {d}', ch_saved: 'Charge saved as draft.', ch_status_done: 'Charge status changed.',
        ch_cost_changed: 'The cost changed since pricing ({a} → {b}). Prices are never recomputed automatically.',
        ch_hint: 'The price is independent of cost unless you link it to a cost (at cost or with a markup) or to a trip sell price. An approved charge is not a tax invoice; official billing comes in the next stage.',
        ch_link_trip: 'Trip leg {n} sell price{c}: {a}', ch_link_cost: 'Cost: {d} — {a}', ch_price_from_link: 'The price is computed from the linked cost when saved and stored; it is never recomputed later.',
        ch_price_required: 'Enter the unit price.', ch_link_required: 'Choose the linked cost or trip price.', ch_markup_required: 'Enter the markup %.',
        ch_suggest_failed: 'Suggestions could not be loaded ({e}). You can still enter a manual price.',
        col_title: 'Record client collection', col_amount: 'Amount', col_date: 'Collection date', col_method: 'Method', col_ref: 'Reference',
        col_file: 'Evidence file (optional)', col_need: 'Enter a reference or attach the evidence file.', col_saved: 'Collection recorded (evidence only, not a receipt).',
        col_void: 'Void collection', col_voided: 'Collection voided.', col_list: 'Collections', col_void_title: 'Void collection {a}',
        upload_failed: 'The evidence file could not be uploaded: {e}',
        mg_title: 'Analytical margin', mg_banner: 'Analytical margin — not accounting profit. Figures are net of VAT, per currency.',
        mg_currency: 'Currency', mg_charges: 'Service revenue (approved)', mg_internal: 'of which internal services', mg_draft: 'Drafts (not counted)',
        mg_reimb: 'Disbursements charged', mg_cost_confirmed: 'Confirmed cost', mg_cost_estimated: 'Estimated cost', mg_unknown: 'Costs with unknown amount',
        mg_pass: 'Pass-through costs', mg_client_direct: 'Paid by client to supplier directly', mg_margin_confirmed: 'Confirmed margin',
        mg_margin_expected: 'Expected margin', mg_gap: 'Disbursement gap', mg_level: 'Confidence level', mg_mixed: 'This transaction uses several currencies: margins are not added across currencies.',
        mg_pending: 'Items affecting accuracy', mg_no_pending: 'No pending items.', mg_empty: 'No charges or costs recorded for this transaction yet.',
        mg_figure: 'Figure', mg_value: 'Value',
        lbl_fin_accrual_source_trip: 'Transport trip', lbl_fin_accrual_source_demurrage: 'Storage / demurrage', lbl_fin_accrual_source_adjustment: 'Exceptional fee', lbl_fin_accrual_source_manual: 'Manual',
        lbl_fin_accrual_status_open: 'Open', lbl_fin_accrual_status_matched: 'Matched', lbl_fin_accrual_status_variance: 'Difference to review', lbl_fin_accrual_status_void: 'Void',
        lbl_fin_variance_reason_amount_diff: 'Amount difference', lbl_fin_variance_reason_trip_cost_changed_after_match: 'Trip cost changed after matching',
        lbl_fin_variance_reason_trip_cancelled_after_match: 'Trip cancelled after matching', lbl_fin_variance_reason_allocation_reversed: 'Allocation reversed',
        lbl_fin_accrual_decision_accept: 'Accept matched, drop the rest', lbl_fin_accrual_decision_keep_open: 'Keep the rest as estimated cost',
        lbl_fin_accrual_decision_accept_new_amount: 'Accept the new amount', lbl_fin_accrual_decision_keep_amount: 'Keep the previous amount',
        lbl_fin_basis_agreed: 'Agreed', lbl_fin_basis_estimated: 'Estimated',
        lbl_fin_alloc_status_proposed: 'Proposed', lbl_fin_alloc_status_approved: 'Approved', lbl_fin_alloc_status_rejected: 'Rejected', lbl_fin_alloc_status_reversed: 'Reversed',
        lbl_fin_invoice_status_received: 'Received', lbl_fin_invoice_status_under_review: 'Under review', lbl_fin_invoice_status_approved: 'Approved',
        lbl_fin_invoice_status_disputed: 'Disputed', lbl_fin_invoice_status_void: 'Void',
        lbl_fin_charge_kind_service: 'Service', lbl_fin_charge_kind_internal_service: 'Internal service', lbl_fin_charge_kind_reimbursable: 'Disbursement (pass-through)',
        lbl_fin_charge_status_draft: 'Draft', lbl_fin_charge_status_approved: 'Approved', lbl_fin_charge_status_invoiced: 'Invoiced', lbl_fin_charge_status_void: 'Void',
        lbl_fin_charge_source_manual: 'Manual', lbl_fin_charge_source_from_cost: 'At cost', lbl_fin_charge_source_markup: 'Cost + markup', lbl_fin_charge_source_from_trip: 'Trip sell price',
        lbl_fin_payment_method_bank_transfer: 'Bank transfer', lbl_fin_payment_method_cash: 'Cash', lbl_fin_payment_method_cheque: 'Cheque', lbl_fin_payment_method_card: 'Card',
        lbl_fin_payment_method_offset: 'Offset', lbl_fin_payment_method_other: 'Other',
        lbl_fin_demurrage_kind_storage: 'Storage', lbl_fin_demurrage_kind_demurrage: 'Demurrage', lbl_fin_demurrage_kind_detention: 'Detention',
        lbl_fin_demurrage_status_open: 'Open', lbl_fin_demurrage_status_closed: 'Closed', lbl_fin_demurrage_status_waived: 'Waived', lbl_fin_demurrage_status_void: 'Void',
        lbl_fin_adjustment_kind_late_cost: 'Late cost', lbl_fin_adjustment_kind_empty_fee: 'Empty fee', lbl_fin_adjustment_kind_washing: 'Washing',
        lbl_fin_adjustment_kind_repair: 'Repair', lbl_fin_adjustment_kind_amendment: 'Invoice amendment', lbl_fin_adjustment_kind_duplicate_invoice: 'Duplicate invoice', lbl_fin_adjustment_kind_other: 'Other',
        lbl_fin_adjustment_status_proposed: 'Awaiting approval', lbl_fin_adjustment_status_approved: 'Approved', lbl_fin_adjustment_status_rejected: 'Rejected',
        lbl_fin_level_confirmed: 'Confirmed', lbl_fin_level_estimated: 'Estimated', lbl_fin_level_unknown: 'Unknown',
        lbl_fin_pending_proposed_allocation: 'Allocation awaiting approval', lbl_fin_pending_open_accrual: 'Expected cost without its invoice yet',
        lbl_fin_pending_unknown_accrual: 'Expected cost without an amount', lbl_fin_pending_variance_accrual: 'Cost difference awaiting review',
        lbl_fin_pending_draft_charge: 'Client charge still in draft', lbl_fin_pending_open_demurrage: 'Open storage / demurrage case',
        lbl_fin_pending_proposed_adjustment: 'Fee / adjustment awaiting approval', lbl_fin_pending_reimbursable_gap: 'Gap between disbursements charged and pass-through cost',
        lbl_fin_decision_approved: 'Approve', lbl_fin_decision_rejected: 'Reject',
        lbl_fin_service_customs_clearance: 'Customs clearance', lbl_fin_service_transport: 'Transport', lbl_fin_service_port_charges: 'Port charges',
        lbl_fin_service_delivery_order: 'Delivery order', lbl_fin_service_storage: 'Storage', lbl_fin_service_demurrage: 'Demurrage',
        lbl_fin_service_detention: 'Detention', lbl_fin_service_inspection: 'Inspection', lbl_fin_service_empty_handling: 'Empty handling',
        lbl_fin_service_washing: 'Washing', lbl_fin_service_repair: 'Repair', lbl_fin_service_documentation: 'Documentation', lbl_fin_service_saber: 'SABER', lbl_fin_service_other: 'Other'
      }
    });
  }

  /* ------------------------------------------------------------------
     Constants (mirror the CHECK lists of 20261104000100_g4_costs.sql)
     ------------------------------------------------------------------ */
  var SERVICES = ['customs_clearance', 'transport', 'port_charges', 'delivery_order', 'storage', 'demurrage', 'detention',
    'inspection', 'empty_handling', 'washing', 'repair', 'documentation', 'saber', 'other'];
  var CHARGE_KINDS = ['service', 'internal_service', 'reimbursable'];
  var METHODS = ['bank_transfer', 'cash', 'cheque', 'card', 'offset', 'other'];
  var TX_ADJ_KINDS = ['empty_fee', 'washing', 'repair', 'other'];   // amendment / duplicate_invoice start from an invoice
  var ACC_DECISIONS = ['accept', 'keep_open', 'accept_new_amount', 'keep_amount'];
  var CURRENCIES = ['SAR', 'USD', 'EUR', 'AED'];
  var LATE_STAGES = ['under_billing', 'billed', 'closed'];
  var TONES = {
    fin_accrual_status: { open: 'info', matched: 'success', variance: 'warning', void: 'neutral' },
    fin_alloc_status: { proposed: 'warning', approved: 'success', rejected: 'neutral', reversed: 'neutral' },
    fin_invoice_status: { received: 'info', under_review: 'warning', approved: 'success', disputed: 'danger', void: 'neutral' },
    fin_charge_status: { draft: 'warning', approved: 'success', invoiced: 'brand', void: 'neutral' },
    fin_demurrage_status: { open: 'warning', closed: 'success', waived: 'neutral', void: 'neutral' },
    fin_adjustment_status: { proposed: 'warning', approved: 'success', rejected: 'neutral' },
    fin_level: { confirmed: 'success', estimated: 'warning', unknown: 'danger' }
  };
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* ------------------------------------------------------------------
     Toolkit — one per section render (closes over the api object)
     ------------------------------------------------------------------ */
  function kit(api) {
    var el = api.el;
    function t(k, vars) { var key = 'fintx.' + k, s = api.t(key, vars); return s === key ? k : s; }
    // fin.js (views dictionary) first, then the own fallback, then admin.js' labels
    function L(domain, code) {
      if (code == null || code === '') return t('none');
      var keys = ['fin.' + domain + '_' + code, 'fin.' + domain.replace(/^fin_/, '') + '_' + code, 'fintx.lbl_' + domain + '_' + code];
      for (var i = 0; i < keys.length; i++) { var s = api.t(keys[i]); if (s && s !== keys[i]) return s; }
      return api.label ? api.label(domain, code) : String(code);
    }
    var BADGE_CLS = { success: 'success', warning: 'warning', danger: 'danger', info: 'blue', brand: 'teal', neutral: 'muted' };
    function pill(tone, text) { return el('span', { class: 'badge badge-' + (BADGE_CLS[tone] || 'muted'), 'data-tone': tone || 'neutral', text: text }); }
    function badge(domain, code) { return pill((TONES[domain] || {})[code] || 'info', L(domain, code)); }
    // the level badge (fin.css .fin-level-<level> tints it; the base is the original .badge)
    function level(code) {
      var b = badge('fin_level', code || 'unknown');
      b.className += ' fin-level fin-level-' + (code || 'unknown');
      return b;
    }
    function money(n, cur) { return n == null || n === '' || isNaN(+n) ? t('none') : api.fmtMoney(+n, cur || 'SAR'); }
    function moneyCell(n, cur, cls) { return el('td', { class: 'num' + (cls ? ' ' + cls : '') }, el('bdi', { dir: 'ltr', text: money(n, cur) })); }
    function ltr(v) { return v ? el('bdi', { dir: 'ltr', class: 'num', text: String(v) }) : t('none'); }
    function when(v, time) { return v ? api.fmtDate(v, !!time) : t('none'); }
    function btn(label, cls, onClick, attrs) {
      var b = el('button', Object.assign({ class: 'btn btn-sm ' + (cls || 'btn-ghost'), type: 'button' }, attrs || {}), label);
      if (onClick) b.addEventListener('click', function (e) { e.preventDefault(); onClick(b, e); });
      return b;
    }
    function alertBox(type, text) { return el('div', { class: 'alert alert-' + type, role: type === 'danger' ? 'alert' : 'status' }, el('div', { text: text })); }
    function card(title, body, actions, cls) {
      return el('section', { class: 'app-card adm-card ops-tx-card fin-tx-card' + (cls ? ' ' + cls : '') }, [
        el('header', { class: 'app-card-head adm-card-head' }, [el('h3', { class: 'app-card-title', text: title }),
          actions && actions.length ? el('div', { class: 'adm-card-actions' }, actions) : null]),
        el('div', { class: 'app-card-body adm-card-body' }, body)
      ]);
    }
    function sub(text) { return text ? el('span', { class: 'adm-sub', text: text }) : null; }
    function subHead(text, actions) {
      return el('div', { class: 'fin-tx-subhead' }, [el('h4', { class: 'ops-sub-title', text: text }),
        actions && actions.filter(Boolean).length ? el('div', { class: 'adm-row-actions' }, actions.filter(Boolean)) : null]);
    }
    function empty(text) { return el('div', { class: 'empty-state is-compact' }, el('p', { text: text })); }
    function table(headers, rows, emptyText) {
      var body = el('tbody', null, rows.length ? rows : el('tr', { class: 'adm-empty-row' }, el('td', { colspan: headers.length }, empty(emptyText || t('none')))));
      return el('div', { class: 'table-wrap adm-table-wrap' }, el('table', { class: 'table table-striped adm-table' }, [
        el('thead', null, el('tr', null, headers.map(function (h) {
          h = typeof h === 'string' ? { label: h } : h;
          return el('th', { scope: 'col', class: h.num ? 'num' : null, text: h.label });
        }))), body
      ]));
    }
    function actions(list) { list = list.filter(Boolean); return list.length ? el('div', { class: 'adm-row-actions' }, list) : null; }
    function field(o) {
      var id = 'fnx-' + o.name, ctl;
      var common = { class: 'form-control', id: id, name: o.name, required: !!o.req, dir: o.ltr ? 'ltr' : null };
      if (o.type === 'select') {
        ctl = el('select', common, (o.options || []).map(function (p) { return el('option', { value: p[0], text: p[1] }); }));
        ctl.value = o.value == null ? '' : String(o.value);
      } else if (o.type === 'textarea') {
        ctl = el('textarea', Object.assign(common, { rows: o.rows || 2, maxlength: o.max || null }));
        ctl.value = o.value == null ? '' : String(o.value);
      } else if (o.type === 'file') {
        ctl = el('input', Object.assign(common, { type: 'file', accept: 'application/pdf,image/*' }));
      } else {
        ctl = el('input', Object.assign(common, { type: o.type || 'text', maxlength: o.max || null, min: o.min != null ? o.min : null,
          max: o.maxNum != null ? o.maxNum : null, step: o.step || null, autocomplete: 'off', value: o.value == null ? '' : o.value }));
      }
      return el('div', { class: 'form-group' + (o.full ? ' adm-full' : ''), 'data-field': o.name }, [
        el('label', { class: 'form-label', for: id }, [o.label, o.req ? el('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null]),
        ctl, o.hint ? el('span', { class: 'form-hint', text: o.hint }) : null
      ]);
    }
    function grid(kids) { return el('div', { class: 'adm-form-grid' }, kids); }
    function codeOpts(domain, codes, blank) { return (blank ? [['', blank]] : []).concat(codes.map(function (c) { return [c, L(domain, c)]; })); }
    function val(form, name) { var e = form.elements[name]; if (!e) return null; var v = String(e.value == null ? '' : e.value).trim(); return v === '' ? null : v; }
    function numVal(form, name) {
      var v = val(form, name); if (v == null) return null;
      var n = Number(String(v).replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }).replace(/[,،\s]/g, ''));
      return isFinite(n) ? n : NaN;
    }
    // money: ≥ 0 with at most 2 decimals (numeric(14,2))
    function badMoney(n) { return n == null || isNaN(n) || n < 0 || n >= 1e12 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6; }
    function fileOf(form, name) { var e = form.elements[name]; return e && e.files && e.files[0] ? e.files[0] : null; }
    function settle(r, okText) {
      if (!r || r.error) return api.errText(r ? r.error : null);
      api.toast(okText || t('saved'), 'success');
      api.refresh();
      return true;
    }
    function idem() {
      var c = null;
      return function (payload) {
        var sig; try { sig = JSON.stringify(payload); } catch (e) { sig = String(Math.random()); }
        if (!c || c.sig !== sig) c = { sig: sig, key: api.newIdemKey ? api.newIdemKey() : null };
        return c.key;
      };
    }
    function rows(d) { return Array.isArray(d) ? d : (d && (d.items || d.rows)) || []; }
    function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
    return { el: el, t: t, L: L, pill: pill, badge: badge, level: level, money: money, moneyCell: moneyCell, ltr: ltr, when: when, btn: btn,
      alert: alertBox, card: card, sub: sub, subHead: subHead, empty: empty, table: table, actions: actions, field: field, grid: grid,
      codeOpts: codeOpts, val: val, numVal: numVal, badMoney: badMoney, fileOf: fileOf, settle: settle, idem: idem, rows: rows, today: today };
  }

  function M(api, name) {
    var f = api.MarsaApi && api.MarsaApi[name];
    if (typeof f !== 'function') {
      return function () {
        var msg = api.t('ops.api_missing', { fn: name });
        return Promise.resolve({ data: null, error: { code: 'MRS_UNAVAILABLE', fn: name, message: msg === 'ops.api_missing' ? name : msg } });
      };
    }
    return function () {
      var args = arguments;
      return Promise.resolve().then(function () { return f.apply(api.MarsaApi, args); })
        .then(function (r) { return r || { data: null, error: null }; }, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
    };
  }
  // one tx_costs read per rendered transaction (both sections and the dialogs share it)
  var MEMO = typeof WeakMap === 'function' ? new WeakMap() : null;
  function memo(tx, name, fn) {
    var bag;
    if (MEMO) { bag = MEMO.get(tx); if (!bag) { bag = {}; MEMO.set(tx, bag); } }
    else { bag = tx.__fintx || (tx.__fintx = {}); }
    if (!bag[name]) bag[name] = Promise.resolve().then(fn).then(null, function (e) { return { data: null, error: { message: String(e && e.message || e) } }; });
    return bag[name];
  }
  function costsOf(api, tx) { return memo(tx, 'costs', function () { return M(api, 'txCosts')(tx.id); }); }
  function docsOf(api, tx) {
    return memo(tx, 'docs', function () { return M(api, 'listDocuments')({ transactionId: tx.id }); })
      .then(function (r) { return r.error ? [] : (r.data || []).filter(function (d) { return d && !d.voided_at; }); });
  }
  function excOf(api, tx) {
    return memo(tx, 'exc', function () { return M(api, 'listExceptions')({ txId: tx.id }); })
      .then(function (r) { return r.error ? [] : (Array.isArray(r.data) ? r.data : []); });
  }
  function partiesOf(api, tx) {
    return memo(tx, 'parties', function () { return M(api, 'listParties')({ active: false, limit: 500 }); })
      .then(function (r) { return r.error ? [] : (r.data || []); });
  }
  function ctrNo(tx, id) { var c = (tx.containers || []).filter(function (x) { return x.id === id; })[0]; return c ? c.container_no : null; }
  function ctrOpts(tx, blank) { return [['', blank]].concat((tx.containers || []).map(function (c) { return [c.id, c.container_no]; })); }
  function nameOf(api, row, keys) {
    var en = api.isEn && api.isEn();
    for (var i = 0; i < keys.length; i++) {
      var base = keys[i];
      var v = en ? (row[base + '_en'] || row[base + '_ar'] || row[base]) : (row[base + '_ar'] || row[base] || row[base + '_en']);
      if (v) return v;
    }
    return null;
  }
  function isMine(api, row) { return !!(row && row.created_by && api.userId && row.created_by === api.userId); }
  function isAdmin(api) { return (api.roles || []).indexOf('admin') !== -1; }
  // four eyes: the creator may not approve (admin aside); the server enforces it too
  function mayApprove(api, row) { return !isMine(api, row) || isAdmin(api); }

  // shell for one section: card with a loading line, then fill(body) (async); failures stay inside the card
  function section(root, k, title, actionsList, fill, cls) {
    var body = k.el('div', { class: 'ops-tx-body' }, k.el('p', { class: 'text-sm text-muted', text: k.t('loading') }));
    root.appendChild(k.card(title, body, actionsList, cls));
    return Promise.resolve().then(function () { return fill(); }).then(function (kids) {
      body.textContent = '';
      if (!kids) return;
      var wrap = k.el('div', null, kids);
      while (wrap.firstChild) body.appendChild(wrap.firstChild);
    }, function (e) {
      body.textContent = '';
      body.appendChild(k.alert('danger', k.t('load_failed', { e: String(e && e.message || e) })));
    });
  }
  function loadErr(k, api, err) { return k.alert('warning', k.t('load_failed', { e: api.errText(err) })); }

  // optional evidence upload, then the RPC; an upload failure keeps the dialog open
  function withEvidence(api, k, file, branchId, kind, fn) {
    if (!file) return fn(null);
    return M(api, 'uploadFinanceDocument')({ file: file, branchId: branchId, kind: kind }).then(function (u) {
      if (u.error && !(u.data && u.data.id)) return { data: null, error: u.error };
      if (u.error) return { data: null, error: { message: k.t('upload_failed', { e: api.errText(u.error) }) } };
      return fn(u.data.id);
    });
  }

  /* ==================================================================
     80 — costs, allocations, demurrage, adjustments, client charges
     ================================================================== */
  function renderCosts(root, tx, api) {
    if (!api.can('finRead', tx.branch_id)) return null;
    var k = kit(api), el = k.el;
    var canW = api.can('finWrite', tx.branch_id), canA = api.can('finApprove', tx.branch_id);
    var late = LATE_STAGES.indexOf(tx.operational_status) !== -1;

    /* ---- accruals ---- */
    function accrualDialog() {
      partiesOf(api, tx).then(function (parties) {
        var key = k.idem();
        api.modal({
          title: k.t('acc_add'), submitText: k.t('acc_add'), wide: true,
          body: [k.grid([
            k.field({ name: 'service_code', label: k.t('ch_service'), type: 'select', options: k.codeOpts('fin_service', SERVICES, k.t('optional_none')) }),
            k.field({ name: 'container_id', label: k.t('al_target'), type: 'select', options: ctrOpts(tx, k.t('all_containers')) }),
            k.field({ name: 'supplier_id', label: k.t('acc_supplier'), type: 'select', options: [['', k.t('optional_none')]].concat(parties.filter(function (p) { return p.is_active !== false; }).map(function (p) {
              return [p.id, (api.isEn && api.isEn() && p.name_en) || p.name_ar || p.name_en || p.id];
            })) }),
            k.field({ name: 'amount', label: k.t('acc_amount'), type: 'number', min: 0, step: '0.01', hint: k.t('acc_unknown') }),
            k.field({ name: 'currency', label: k.t('ch_currency'), type: 'select', value: 'SAR', options: CURRENCIES.map(function (c) { return [c, c]; }) }),
            k.field({ name: 'basis', label: k.t('acc_basis'), type: 'select', value: 'estimated', options: k.codeOpts('fin_basis', ['estimated', 'agreed']) })
          ]), el('p', { class: 'form-hint', text: k.t('acc_hint') })],
          onSubmit: function (form) {
            var amt = k.numVal(form, 'amount');
            if (amt != null && k.badMoney(amt)) return k.t('amount_bad');
            var p = { transaction_id: tx.id, container_id: k.val(form, 'container_id'), supplier_id: k.val(form, 'supplier_id'),
              service_code: k.val(form, 'service_code'), amount: amt, currency: k.val(form, 'currency') || 'SAR', basis: k.val(form, 'basis') || 'estimated' };
            return M(api, 'createAccrual')(p, { idemKey: key(p) }).then(function (r) { return k.settle(r, k.t('acc_saved')); });
          }
        });
      });
    }
    function reviewAccrual(a) {
      var opts = ACC_DECISIONS.filter(function (d) { return a.pending_amount != null ? true : (d !== 'accept_new_amount' && d !== 'keep_amount'); });
      api.modal({
        title: k.t('acc_review_title'), submitText: k.t('acc_review'),
        body: [
          a.pending_amount != null ? k.alert('warning', k.t('acc_pending', { a: k.money(a.pending_amount, a.currency) })) : null,
          a.variance_amount != null ? k.alert('info', k.t('acc_variance', { a: k.money(a.variance_amount, a.currency) })) : null,
          k.grid([
            k.field({ name: 'decision', label: k.t('acc_decision'), type: 'select', req: true, options: k.codeOpts('fin_accrual_decision', opts, k.t('choose')), full: true }),
            k.field({ name: 'note', label: k.t('acc_note'), type: 'textarea', req: true, max: 1000, full: true })
          ])],
        onSubmit: function (form) {
          var d = k.val(form, 'decision'), note = k.val(form, 'note');
          if (!d) return k.t('required');
          if (!note) return k.t('note_required');
          return M(api, 'reviewAccrualVariance')(a.id, d, note).then(function (r) { return k.settle(r, k.t('acc_reviewed')); });
        }
      });
    }
    function reasonDialog(title, submit, fn, okText, danger) {
      api.modal({
        title: title, submitText: submit, danger: !!danger,
        body: k.grid([k.field({ name: 'reason', label: k.t('adj_reason'), type: 'textarea', req: true, max: 1000, full: true })]),
        onSubmit: function (form) {
          var reason = k.val(form, 'reason');
          if (!reason) return k.t('reason_required');
          return fn(reason).then(function (r) { return k.settle(r, okText); });
        }
      });
    }
    function accrualSource(a) {
      var s = k.L('fin_accrual_source', a.source);
      if (a.source === 'trip' && a.leg_no != null) s += ' — ' + k.t('acc_trip', { n: a.leg_no });
      return s;
    }
    function accrualsBlock(list) {
      var trs = list.map(function (a) {
        var unknown = a.amount == null;
        return el('tr', { 'data-accrual': a.id, class: a.status === 'variance' ? 'fin-row-variance' : null }, [
          el('td', null, [el('span', { class: 'cell-main', text: accrualSource(a) }), k.sub(ctrNo(tx, a.container_id) || a.container_no),
            a.service_code ? k.sub(k.L('fin_service', a.service_code)) : null]),
          el('td', { text: nameOf(api, a, ['supplier_name']) || k.t('none') }),
          unknown ? el('td', { class: 'num' }, k.pill('danger', k.t('acc_unknown'))) : k.moneyCell(a.amount, a.currency),
          k.moneyCell(a.matched_amount || 0, a.currency),
          el('td', null, [k.badge('fin_accrual_status', a.status), k.sub(k.L('fin_basis', a.basis)),
            a.variance_reason ? k.sub(k.L('fin_variance_reason', a.variance_reason)) : null,
            a.pending_amount != null ? k.sub(k.t('acc_pending', { a: k.money(a.pending_amount, a.currency) })) : null,
            a.status === 'variance' && a.variance_amount != null ? k.sub(k.t('acc_variance', { a: k.money(a.variance_amount, a.currency) })) : null]),
          el('td', null, k.actions([
            canA && a.status === 'variance' ? k.btn(k.t('acc_review'), 'btn-secondary', function () { reviewAccrual(a); }) : null,
            canW && a.status === 'open' && !(+a.matched_amount) ? k.btn(k.t('acc_void'), 'btn-ghost', function () {
              reasonDialog(k.t('acc_void_title'), k.t('acc_void'), function (reason) { return M(api, 'voidAccrual')(a.id, reason); }, k.t('acc_voided'), true);
            }) : null
          ]))
        ]);
      });
      return [k.subHead(k.t('acc_title'), [canW ? k.btn(k.t('acc_add'), 'btn-secondary', accrualDialog) : null]),
        k.table([k.t('acc_source'), k.t('acc_supplier'), { label: k.t('acc_amount'), num: true }, { label: k.t('acc_matched'), num: true }, k.t('acc_status'), ''], trs, k.t('acc_empty')),
        el('p', { class: 'form-hint', text: k.t('acc_hint') })];
    }

    /* ---- allocations ---- */
    function approveDialog(list) {
      var needNote = list.some(function (a) { return a.is_late; });
      api.modal({
        title: k.t('al_approve_title'), submitText: k.t('al_approve'),
        body: [needNote ? k.alert('warning', k.t('late_hint')) : null,
          k.grid([k.field({ name: 'note', label: needNote ? k.t('al_late_note') : k.t('acc_note'), type: 'textarea', req: needNote, max: 1000, full: true })])],
        onSubmit: function (form) {
          var note = k.val(form, 'note');
          if (needNote && !note) return k.t('note_required');
          return M(api, 'approveAllocations')(list.map(function (a) { return a.id; }), note).then(function (r) { return k.settle(r, k.t('al_approved')); });
        }
      });
    }
    function allocTarget(a) {
      var parts = [];
      var c = ctrNo(tx, a.container_id) || a.container_no;
      if (c) parts.push(c);
      if (a.trip_id) parts.push(k.t('acc_trip', { n: a.leg_no != null ? a.leg_no : '' }).trim());
      if (a.demurrage_case_id) parts.push(k.t('dm_title'));
      return parts.length ? parts.join(' · ') : k.t('all_containers');
    }
    function allocationsBlock(list) {
      var approvable = canA ? list.filter(function (a) { return a.status === 'proposed' && mayApprove(api, a); }) : [];
      var trs = list.map(function (a) {
        var invLabel = a.invoice_number || String(a.supplier_invoice_id || '').slice(0, 8);
        return el('tr', { 'data-allocation': a.id }, [
          el('td', null, [a.supplier_invoice_id ? el('a', { class: 'ops-ref', href: '#costs/' + a.supplier_invoice_id, title: k.t('open_invoice') }, el('bdi', { dir: 'ltr', text: invLabel })) : k.ltr(invLabel),
            k.sub(nameOf(api, a, ['supplier_name'])), a.invoice_status ? k.sub(k.t('al_inv_status', { s: k.L('fin_invoice_status', a.invoice_status) })) : null]),
          el('td', null, [el('span', { class: 'cell-main', text: a.line_description || a.description || k.t('none') }),
            a.service_code ? k.sub(k.L('fin_service', a.service_code)) : null]),
          el('td', { text: allocTarget(a) }),
          el('td', { class: 'num' }, [el('bdi', { dir: 'ltr', text: k.money(a.amount, a.currency) }),
            a.share_pct != null ? k.sub(k.t('al_share', { p: +a.share_pct })) : null]),
          el('td', null, [k.badge('fin_alloc_status', a.status), a.is_late ? k.pill('warning', k.t('al_late')) : null,
            a.decision_note ? k.sub(a.decision_note) : null, a.reverse_reason ? k.sub(a.reverse_reason) : null]),
          el('td', null, k.actions(canA ? [
            a.status === 'proposed' && mayApprove(api, a) ? k.btn(k.t('al_approve'), 'btn-primary', function () { approveDialog([a]); }) : null,
            a.status === 'proposed' && !mayApprove(api, a) ? el('span', { class: 'form-hint', text: k.t('four_eyes') }) : null,
            a.status === 'proposed' ? k.btn(k.t('al_reject'), 'btn-ghost', function () {
              reasonDialog(k.t('al_reject_title'), k.t('al_reject'), function (reason) { return M(api, 'rejectAllocation')(a.id, reason); }, k.t('al_rejected'), true);
            }) : null,
            a.status === 'approved' && a.invoice_status !== 'approved' ? k.btn(k.t('al_reverse'), 'btn-ghost', function () {
              reasonDialog(k.t('al_reverse_title'), k.t('al_reverse'), function (reason) { return M(api, 'reverseAllocation')(a.id, reason); }, k.t('al_reversed'), true);
            }) : null
          ] : []))
        ]);
      });
      return [k.subHead(k.t('al_title'), [approvable.length > 1 ? k.btn(k.t('al_approve_all', { n: approvable.length }), 'btn-secondary', function () { approveDialog(approvable); }) : null]),
        k.table([k.t('al_invoice'), k.t('al_line'), k.t('al_target'), { label: k.t('al_amount'), num: true }, k.t('al_status'), ''], trs, k.t('al_empty')),
        el('p', { class: 'form-hint', text: k.t('al_hint') })];
    }

    /* ---- demurrage (read-only here; managed in #demurrage) ---- */
    function demurrageBlock(list) {
      if (!list.length) return null;
      var trs = list.map(function (d) {
        // tx_costs nests the four figures under `figures` (app.fin_case_json); a flat row is read as-is
        var f = d.figures || d, cur = d.currency || f.currency || 'SAR', rem = f.remaining || {};
        return el('tr', { 'data-demurrage': d.id }, [
          el('td', null, [el('span', { class: 'cell-main', text: k.L('fin_demurrage_kind', d.kind) }), k.sub(ctrNo(tx, d.container_id) || d.container_no),
            k.sub(nameOf(api, d, ['operator_name']))]),
          el('td', { text: k.t('dm_until', { a: d.free_until ? k.when(d.free_until) : k.t('none'), b: d.charged_until ? k.when(d.charged_until) : k.t('none') }) }),
          k.moneyCell(f.charged_to_client, cur), k.moneyCell(f.collected_from_client, cur),
          el('td', { class: 'num' }, [el('bdi', { dir: 'ltr', text: k.money(f.paid_to_operator, cur) }),
            +f.paid_by_client_to_operator ? k.sub(k.t('dm_paid_client') + ': ' + k.money(f.paid_by_client_to_operator, cur)) : null]),
          el('td', null, [k.sub(k.t('dm_to_collect', { a: k.money(rem.to_collect, cur) })),
            k.sub(k.t('dm_to_pay', { a: k.money(rem.to_pay_operator, cur) }) + (f.operator_due_level === 'estimated' ? ' (' + k.t('dm_estimated') + ')' : ''))]),
          el('td', null, k.badge('fin_demurrage_status', d.status))
        ]);
      });
      return [k.subHead(k.t('dm_title'), [el('a', { class: 'btn btn-sm btn-ghost', href: '#demurrage', text: k.t('dm_manage') })]),
        k.table([k.t('dm_kind'), k.t('dm_period'), { label: k.t('dm_charged'), num: true }, { label: k.t('dm_collected'), num: true },
          { label: k.t('dm_paid'), num: true }, k.t('dm_remaining'), k.t('acc_status')], trs, k.t('dm_empty')),
        el('p', { class: 'form-hint', text: k.t('dm_hint') })];
    }

    /* ---- adjustments ---- */
    function adjustmentDialog() {
      Promise.all([docsOf(api, tx), excOf(api, tx), partiesOf(api, tx)]).then(function (res) {
        var docs = res[0], excs = res[1], parties = res[2], key = k.idem();
        api.modal({
          title: k.t('adj_add'), submitText: k.t('adj_add'), wide: true,
          body: [k.grid([
            k.field({ name: 'kind', label: k.t('adj_kind'), type: 'select', req: true, options: k.codeOpts('fin_adjustment_kind', TX_ADJ_KINDS, k.t('choose')) }),
            k.field({ name: 'container_id', label: k.t('al_target'), type: 'select', options: ctrOpts(tx, k.t('all_containers')) }),
            k.field({ name: 'amount', label: k.t('adj_amount'), type: 'number', min: 0, step: '0.01' }),
            k.field({ name: 'currency', label: k.t('ch_currency'), type: 'select', value: 'SAR', options: CURRENCIES.map(function (c) { return [c, c]; }) }),
            k.field({ name: 'service_code', label: k.t('ch_service'), type: 'select', options: k.codeOpts('fin_service', SERVICES, k.t('optional_none')) }),
            k.field({ name: 'supplier_id', label: k.t('adj_supplier'), type: 'select', options: [['', k.t('optional_none')]].concat(parties.filter(function (p) { return p.is_active !== false; }).map(function (p) {
              return [p.id, (api.isEn && api.isEn() && p.name_en) || p.name_ar || p.name_en || p.id];
            })) }),
            k.field({ name: 'exception_id', label: k.t('adj_exception'), type: 'select', full: true, options: [['', k.t('optional_none')]].concat(excs.map(function (x) {
              return [x.id, api.label('exception_kind', x.kind) + ' — ' + (x.occurred_at ? api.fmtDate(x.occurred_at) : '')];
            })) }),
            k.field({ name: 'document_id', label: k.t('adj_doc_tx'), type: 'select', full: true, options: [['', k.t('optional_none')]].concat(docs.map(function (d) { return [d.id, d.original_name || d.id]; })) }),
            k.field({ name: 'file', label: k.t('adj_doc_file'), type: 'file', full: true }),
            k.field({ name: 'reason', label: k.t('adj_reason'), type: 'textarea', req: true, max: 2000, full: true })
          ]), el('p', { class: 'form-hint', text: k.t('adj_hint') })],
          onSubmit: function (form) {
            var amt = k.numVal(form, 'amount'), file = k.fileOf(form, 'file');
            if (!k.val(form, 'kind')) return k.t('required');
            if (!k.val(form, 'reason')) return k.t('reason_required');
            if (amt != null && k.badMoney(amt)) return k.t('amount_bad');
            if (!k.val(form, 'document_id') && !file) return k.t('adj_need_doc');
            var p = { kind: k.val(form, 'kind'), transaction_id: tx.id, container_id: k.val(form, 'container_id'), exception_id: k.val(form, 'exception_id'),
              supplier_id: k.val(form, 'supplier_id'), service_code: k.val(form, 'service_code'), amount: amt,
              currency: k.val(form, 'currency') || 'SAR', document_id: k.val(form, 'document_id'), reason: k.val(form, 'reason') };
            return withEvidence(api, k, file, tx.branch_id, 'adjustment_evidence', function (docId) {
              if (docId) p.finance_document_id = docId;
              return M(api, 'createCostAdjustment')(p, { idemKey: key(p) });
            }).then(function (r) { return k.settle(r, k.t('adj_saved')); });
          }
        });
      });
    }
    function reviewAdjustment(a) {
      api.modal({
        title: k.t('adj_review_title'), submitText: k.t('adj_review'),
        body: k.grid([
          k.field({ name: 'decision', label: k.t('adj_decision'), type: 'select', req: true, options: k.codeOpts('fin_decision', ['approved', 'rejected'], k.t('choose')), full: true }),
          k.field({ name: 'note', label: k.t('acc_note'), type: 'textarea', req: true, max: 1000, full: true })
        ]),
        onSubmit: function (form) {
          var d = k.val(form, 'decision'), note = k.val(form, 'note');
          if (!d) return k.t('required');
          if (!note) return k.t('note_required');
          return M(api, 'reviewCostAdjustment')(a.id, d, note).then(function (r) { return k.settle(r, k.t('adj_reviewed')); });
        }
      });
    }
    function adjustmentsBlock(list) {
      var trs = list.map(function (a) {
        return el('tr', { 'data-adjustment': a.id }, [
          el('td', null, [el('span', { class: 'cell-main', text: k.L('fin_adjustment_kind', a.kind) }), k.sub(ctrNo(tx, a.container_id) || a.container_no),
            a.supplier_invoice_id ? el('a', { class: 'ops-ref adm-sub', href: '#costs/' + a.supplier_invoice_id, text: k.t('adj_invoice', { n: a.invoice_number || String(a.supplier_invoice_id).slice(0, 8) }) }) : null]),
          a.amount == null ? el('td', { class: 'num', text: k.t('none') }) : k.moneyCell(a.amount, a.currency),
          el('td', null, el('span', { class: 'adm-pre', text: a.reason || k.t('none') })),
          el('td', null, [k.badge('fin_adjustment_status', a.status), a.review_note ? k.sub(a.review_note) : null]),
          el('td', null, k.actions([
            canA && a.status === 'proposed' && mayApprove(api, a) ? k.btn(k.t('adj_review'), 'btn-secondary', function () { reviewAdjustment(a); }) : null,
            canA && a.status === 'proposed' && !mayApprove(api, a) ? el('span', { class: 'form-hint', text: k.t('four_eyes') }) : null
          ]))
        ]);
      });
      return [k.subHead(k.t('adj_title'), [canW ? k.btn(k.t('adj_add'), 'btn-secondary', adjustmentDialog) : null]),
        k.table([k.t('adj_kind'), { label: k.t('adj_amount'), num: true }, k.t('adj_reason'), k.t('adj_status'), ''], trs, k.t('adj_empty')),
        el('p', { class: 'form-hint', text: k.t('adj_hint') })];
    }

    /* ---- client charges + collections ---- */
    function defaultVat(kind) { return kind === 'reimbursable' ? 0 : 15; }
    function linkOptions(sug) {
      var opts = [['', k.t('ch_link_none')]];
      k.rows(sug && sug.trips_with_sell).forEach(function (x) {
        var id = x.trip_id || x.id; if (!UUID_RE.test(String(id || ''))) return;
        var c = ctrNo(tx, x.container_id) || x.container_no;
        opts.push(['trip:' + id, k.t('ch_link_trip', { n: x.leg_no != null ? x.leg_no : '', c: c ? ' (' + c + ')' : '', a: k.money(x.sell_amount, x.sell_currency || x.currency) })]);
      });
      k.rows(sug && sug.reimbursable_costs).forEach(function (x) {
        var isAcc = x.type === 'accrual' || x.source_type === 'accrual' || (!!x.accrual_id && !x.cost_allocation_id && !x.allocation_id);
        var id = isAcc ? (x.accrual_id || x.id) : (x.cost_allocation_id || x.allocation_id || x.id);
        if (!UUID_RE.test(String(id || ''))) return;
        var desc = x.description || x.line_description || (x.service_code ? k.L('fin_service', x.service_code) : null) ||
          (isAcc ? k.L('fin_accrual_source', x.source || 'manual') : (x.invoice_number || ''));
        opts.push([(isAcc ? 'accrual:' : 'alloc:') + id, k.t('ch_link_cost', { d: desc, a: k.money(x.amount, x.currency) })]);
      });
      return opts;
    }
    function chargeDialog(existing) {
      var sugP = existing ? Promise.resolve({ data: null }) : M(api, 'suggestClientCharges')(tx.id);
      sugP.then(function (sr) {
        var key = k.idem(), x = existing || {};
        var opts = existing ? null : linkOptions(sr.data);
        api.modal({
          title: existing ? k.t('ch_edit') : k.t('ch_add'), submitText: existing ? k.t('ch_edit') : k.t('ch_add'), wide: true,
          body: [sr.error ? k.alert('warning', k.t('ch_suggest_failed', { e: api.errText(sr.error) })) : null, k.grid([
            k.field({ name: 'kind', label: k.t('ch_kind'), type: 'select', req: true, value: x.kind || 'service', options: k.codeOpts('fin_charge_kind', CHARGE_KINDS) }),
            k.field({ name: 'service_code', label: k.t('ch_service'), type: 'select', value: x.service_code || '', options: k.codeOpts('fin_service', SERVICES, k.t('optional_none')) }),
            opts ? k.field({ name: 'link', label: k.t('ch_link'), type: 'select', options: opts, full: true, hint: k.t('ch_price_from_link') }) : null,
            opts ? k.field({ name: 'mode', label: k.t('ch_source'), type: 'select', value: 'from_cost', options: k.codeOpts('fin_charge_source', ['from_cost', 'markup']) }) : null,
            opts ? k.field({ name: 'markup_pct', label: k.t('ch_markup'), type: 'number', min: 0, step: '0.01' }) : null,
            k.field({ name: 'description', label: k.t('ch_desc'), type: 'text', req: true, max: 300, value: x.description || '', full: true }),
            k.field({ name: 'container_id', label: k.t('al_target'), type: 'select', value: x.container_id || '', options: ctrOpts(tx, k.t('all_containers')) }),
            k.field({ name: 'quantity', label: k.t('ch_qty'), type: 'number', min: 0, step: '0.001', value: x.quantity != null ? x.quantity : 1 }),
            k.field({ name: 'unit_price', label: k.t('ch_price'), type: 'number', min: 0, step: '0.01', value: x.unit_price != null ? x.unit_price : '' }),
            k.field({ name: 'vat_rate', label: k.t('ch_vat_rate'), type: 'number', min: 0, maxNum: 100, step: '0.01', value: x.vat_rate != null ? x.vat_rate : defaultVat(x.kind || 'service') }),
            k.field({ name: 'currency', label: k.t('ch_currency'), type: 'select', value: x.currency || 'SAR', options: CURRENCIES.map(function (c) { return [c, c]; }) }),
            k.field({ name: 'note', label: k.t('ch_note'), type: 'textarea', max: 1000, value: x.note || '', full: true })
          ]), el('p', { class: 'form-hint', text: k.t('ch_hint') })],
          onOpen: function (b) {
            // the VAT default follows the kind (15 service / internal, 0 disbursement) until the user edits it
            var kindEl = b.querySelector('[name="kind"]'), vatEl = b.querySelector('[name="vat_rate"]'), touched = !!existing;
            if (vatEl) vatEl.addEventListener('input', function () { touched = true; });
            if (kindEl && vatEl) kindEl.addEventListener('change', function () { if (!touched) vatEl.value = String(defaultVat(kindEl.value)); });
          },
          onSubmit: function (form) {
            var link = existing ? null : k.val(form, 'link');
            var kind = k.val(form, 'kind'), desc = k.val(form, 'description');
            if (!kind || !desc) return k.t('required');
            var qty = k.numVal(form, 'quantity'), price = k.numVal(form, 'unit_price'), vat = k.numVal(form, 'vat_rate');
            if (qty != null && (isNaN(qty) || qty <= 0)) return k.t('amount_bad');
            if (vat != null && (isNaN(vat) || vat < 0 || vat > 100)) return k.t('amount_bad');
            var p = { kind: kind, service_code: k.val(form, 'service_code'), description: desc, container_id: k.val(form, 'container_id'),
              quantity: qty == null ? 1 : qty, vat_rate: vat == null ? defaultVat(kind) : vat, currency: k.val(form, 'currency') || 'SAR', note: k.val(form, 'note') };
            if (!link && !(existing && (existing.source || 'manual') !== 'manual')) {
              if (price == null) return k.t('ch_price_required');
              if (k.badMoney(price)) return k.t('amount_bad');
              p.unit_price = price;
            }
            if (existing) {
              // update_client_charge whitelist: kind / currency / source are fixed at creation; quantity / unit price only on manual
              // charges (a sourced price comes from its cost or trip), markup_pct only on markup charges (re-priced from the snapshot)
              var u = { description: p.description, vat_rate: p.vat_rate, service_code: p.service_code, container_id: p.container_id, note: p.note };
              if ((existing.source || 'manual') === 'manual') { u.quantity = p.quantity; u.unit_price = p.unit_price; }
              return M(api, 'updateClientCharge')(existing.id, u).then(function (r) { return k.settle(r, k.t('saved')); });
            }
            p.transaction_id = tx.id;
            if (!link) p.source = 'manual';
            else {
              var m = /^(trip|alloc|accrual):(.+)$/.exec(link);
              if (!m) return k.t('ch_link_required');
              if (m[1] === 'trip') { p.source = 'from_trip'; p.trip_id = m[2]; }
              else {
                p.source = k.val(form, 'mode') === 'markup' ? 'markup' : 'from_cost';
                if (m[1] === 'alloc') p.cost_allocation_id = m[2]; else p.accrual_id = m[2];
                if (p.source === 'markup') {
                  var pct = k.numVal(form, 'markup_pct');
                  if (pct == null || isNaN(pct) || pct < 0) return k.t('ch_markup_required');
                  p.markup_pct = pct;
                }
              }
            }
            return M(api, 'createClientCharge')(p, { idemKey: key(p) }).then(function (r) { return k.settle(r, k.t('ch_saved')); });
          }
        });
      });
    }
    function chargeStatus(c, s) {
      var needNote = s === 'void' || c.status === 'approved';
      api.modal({
        title: k.t('ch_status_title', { s: s === 'draft' ? k.t('ch_to_draft') : k.L('fin_charge_status', s), d: c.description || '' }),
        submitText: s === 'draft' ? k.t('ch_to_draft') : k.L('fin_charge_status', s), danger: s === 'void',
        body: k.grid([k.field({ name: 'note', label: k.t('ch_note'), type: 'textarea', req: needNote, max: 1000, full: true })]),
        onSubmit: function (form) {
          var note = k.val(form, 'note');
          if (needNote && !note) return k.t('note_required');
          return M(api, 'setChargeStatus')(c.id, s, note).then(function (r) { return k.settle(r, k.t('ch_status_done')); });
        }
      });
    }
    function collectionDialog(c) {
      var key = k.idem();
      var remaining = Math.max(0, (+c.total_amount || 0) - (+c.collected_amount || 0));
      api.modal({
        title: k.t('col_title') + ' — ' + (c.description || ''), submitText: k.t('ch_collect'),
        body: k.grid([
          k.field({ name: 'amount', label: k.t('col_amount'), type: 'number', req: true, min: 0, step: '0.01', value: remaining ? remaining.toFixed(2) : '' }),
          k.field({ name: 'collected_at', label: k.t('col_date'), type: 'date', req: true, value: k.today() }),
          k.field({ name: 'method', label: k.t('col_method'), type: 'select', req: true, value: 'bank_transfer', options: k.codeOpts('fin_payment_method', METHODS) }),
          k.field({ name: 'reference', label: k.t('col_ref'), type: 'text', max: 120, ltr: true }),
          k.field({ name: 'file', label: k.t('col_file'), type: 'file', full: true })
        ]),
        onSubmit: function (form) {
          var amt = k.numVal(form, 'amount'), file = k.fileOf(form, 'file');
          if (amt == null || k.badMoney(amt) || amt <= 0) return k.t('amount_bad');
          if (!k.val(form, 'collected_at') || !k.val(form, 'method')) return k.t('required');
          if (!k.val(form, 'reference') && !file) return k.t('col_need');
          // currency = the charge's (server)
          var p = { charge_id: c.id, amount: amt, collected_at: k.val(form, 'collected_at'),
            method: k.val(form, 'method'), reference: k.val(form, 'reference') };
          return withEvidence(api, k, file, tx.branch_id, 'collection_evidence', function (docId) {
            if (docId) p.evidence_document_id = docId;
            return M(api, 'recordChargeCollection')(p, { idemKey: key(p) });
          }).then(function (r) { return k.settle(r, k.t('col_saved')); });
        }
      });
    }
    function chargesBlock(list, collections) {
      var byCharge = {};
      collections.forEach(function (x) { (byCharge[x.charge_id] = byCharge[x.charge_id] || []).push(x); });
      var trs = [];
      list.forEach(function (c) {
        var cur = c.currency || 'SAR';
        var cols = byCharge[c.id] || [];
        var collected = c.collected_amount != null ? +c.collected_amount
          : cols.filter(function (x) { return x.status !== 'void'; }).reduce(function (s, x) { return s + (+x.amount || 0); }, 0);
        var changed = (c.source === 'from_cost' || c.source === 'markup') && c.current_cost != null && c.cost_snapshot != null && +c.current_cost !== +c.cost_snapshot;
        trs.push(el('tr', { 'data-charge': c.id }, [
          el('td', null, [el('span', { class: 'cell-main', text: c.description || k.t('none') }), k.sub(k.L('fin_charge_kind', c.kind)),
            c.service_code ? k.sub(k.L('fin_service', c.service_code)) : null, k.sub(ctrNo(tx, c.container_id) || c.container_no)]),
          el('td', null, [el('span', { text: k.L('fin_charge_source', c.source) }), c.source === 'markup' && c.markup_pct != null ? k.sub('+' + c.markup_pct + '%') : null,
            changed ? k.pill('warning', k.t('ch_cost_changed', { a: k.money(c.cost_snapshot, cur), b: k.money(c.current_cost, cur) })) : null]),
          el('td', { class: 'num' }, [el('bdi', { dir: 'ltr', text: k.money(c.net_amount, cur) }),
            c.quantity != null && +c.quantity !== 1 ? k.sub(String(+c.quantity) + ' × ' + k.money(c.unit_price, cur)) : null]),
          el('td', { class: 'num' }, [el('bdi', { dir: 'ltr', text: k.money(c.vat_amount, cur) }), c.vat_rate != null ? k.sub(+c.vat_rate + '%') : null]),
          k.moneyCell(c.total_amount, cur),
          el('td', null, [k.badge('fin_charge_status', c.status), collected ? k.sub(k.t('ch_collected', { a: k.money(collected, cur) })) : null]),
          el('td', null, k.actions([
            canA && c.status === 'draft' && mayApprove(api, c) ? k.btn(k.t('ch_approve'), 'btn-primary', function () { chargeStatus(c, 'approved'); }) : null,
            canA && c.status === 'draft' && !mayApprove(api, c) ? el('span', { class: 'form-hint', text: k.t('four_eyes') }) : null,
            canW && c.status === 'draft' ? k.btn(k.t('ch_edit'), 'btn-ghost', function () { chargeDialog(c); }) : null,
            canW && c.status === 'approved' ? k.btn(k.t('ch_collect'), 'btn-secondary', function () { collectionDialog(Object.assign({}, c, { collected_amount: collected })); }) : null,
            canA && c.status === 'approved' ? k.btn(k.t('ch_to_draft'), 'btn-ghost', function () { chargeStatus(c, 'draft'); }) : null,
            canA && (c.status === 'draft' || c.status === 'approved') ? k.btn(k.t('ch_void'), 'btn-ghost', function () { chargeStatus(c, 'void'); }) : null
          ]))
        ]));
        if (cols.length) {
          trs.push(el('tr', { class: 'fin-sub-row', 'data-charge-collections': c.id }, el('td', { colspan: 7 }, el('ul', { class: 'adm-list fin-collections' }, cols.map(function (x) {
            return el('li', null, [el('span', { class: 'text-sm', text: k.t('col_list') + ': ' }), el('bdi', { dir: 'ltr', text: k.money(x.amount, x.currency || cur) }), ' · ',
              k.when(x.collected_at), ' · ', k.L('fin_payment_method', x.method), x.reference ? ' · ' : null, x.reference ? k.ltr(x.reference) : null, ' ',
              x.status === 'void' ? k.pill('neutral', k.L('fin_charge_status', 'void')) : null,
              canA && x.status !== 'void' ? k.btn(k.t('col_void'), 'btn-ghost', function () {
                reasonDialog(k.t('col_void_title', { a: k.money(x.amount, x.currency || cur) }), k.t('col_void'),
                  function (reason) { return M(api, 'voidChargeCollection')(x.id, reason); }, k.t('col_voided'), true);
              }) : null]);
          })))));
        }
      });
      return [k.subHead(k.t('ch_title'), [canW ? k.btn(k.t('ch_add'), 'btn-primary', function () { chargeDialog(null); }) : null]),
        k.table([k.t('ch_desc'), k.t('ch_source'), { label: k.t('ch_net'), num: true }, { label: k.t('ch_vat'), num: true }, { label: k.t('ch_total'), num: true }, k.t('ch_status'), ''], trs, k.t('ch_empty')),
        el('p', { class: 'form-hint', text: k.t('ch_hint') })];
    }

    return section(root, k, k.t('costs_title'), null, function () {
      return costsOf(api, tx).then(function (r) {
        if (r.error) return loadErr(k, api, r.error);
        var d = r.data || {};
        return [
          el('p', { class: 'form-hint', text: k.t('costs_hint') }),
          late ? k.alert('warning', k.t('late_hint')) : null,
          el('div', { class: 'fin-tx-block', 'data-block': 'accruals' }, accrualsBlock(k.rows(d.accruals))),
          el('div', { class: 'fin-tx-block', 'data-block': 'allocations' }, allocationsBlock(k.rows(d.allocations))),
          k.rows(d.demurrage).length ? el('div', { class: 'fin-tx-block', 'data-block': 'demurrage' }, demurrageBlock(k.rows(d.demurrage))) : null,
          el('div', { class: 'fin-tx-block', 'data-block': 'adjustments' }, adjustmentsBlock(k.rows(d.adjustments))),
          el('div', { class: 'fin-tx-block', 'data-block': 'charges' }, chargesBlock(k.rows(d.charges), k.rows(d.collections)))
        ];
      });
    }, 'fin-tx-costs');
  }

  /* ==================================================================
     85 — analytical margin
     ================================================================== */
  var FIGURES = [
    ['charges_service', 'mg_charges'], ['charges_internal', 'mg_internal', 'sub'], ['charges_draft', 'mg_draft', 'sub'],
    ['cost_confirmed', 'mg_cost_confirmed'], ['cost_estimated', 'mg_cost_estimated'],
    ['margin_confirmed', 'mg_margin_confirmed', 'total'], ['margin_expected', 'mg_margin_expected', 'total'],
    ['reimbursable_charged', 'mg_reimb'], ['pass_through_cost', 'mg_pass'], ['reimbursable_gap', 'mg_gap', 'gap'],
    ['client_paid_direct', 'mg_client_direct']
  ];
  function renderMargin(root, tx, api) {
    if (!api.can('finRead', tx.branch_id)) return null;
    var k = kit(api), el = k.el;
    return section(root, k, k.t('mg_title'), null, function () {
      return M(api, 'txMargin')(tx.id).then(function (r) {
        if (r.error) return loadErr(k, api, r.error);
        var d = r.data || {}, curs = Array.isArray(d.currencies) ? d.currencies : [];
        var pending = Array.isArray(d.pending) ? d.pending : [];
        var en = api.isEn && api.isEn();
        var head = el('div', { class: 'fin-margin-head' }, [el('span', { class: 'text-sm', text: k.t('mg_level') + ': ' }), k.level(d.level)]);
        var tableNode;
        if (!curs.length) tableNode = k.empty(k.t('mg_empty'));
        else {
          var trs = FIGURES.map(function (f) {
            return el('tr', { class: f[2] === 'total' ? 'fin-margin-total' : f[2] === 'sub' ? 'fin-margin-sub' : null, 'data-figure': f[0] },
              [el('th', { scope: 'row', text: k.t(f[1]) })].concat(curs.map(function (c) {
                var v = c[f[0]];
                var cls = f[2] === 'total' && +v < 0 ? 'is-negative' : f[2] === 'gap' && +v ? 'is-gap' : null;
                return k.moneyCell(v == null ? 0 : v, c.currency, cls);
              })));
          });
          trs.push(el('tr', { 'data-figure': 'unknown_count' }, [el('th', { scope: 'row', text: k.t('mg_unknown') })].concat(curs.map(function (c) {
            return el('td', { class: 'num' }, +c.unknown_count ? k.pill('danger', String(+c.unknown_count)) : el('span', { text: '0' }));
          }))));
          tableNode = el('div', { class: 'table-wrap adm-table-wrap' }, el('table', { class: 'table table-striped adm-table fin-margin-table' }, [
            el('thead', null, el('tr', null, [el('th', { scope: 'col', text: k.t('mg_figure') })].concat(curs.map(function (c) {
              return el('th', { scope: 'col', class: 'num' }, el('bdi', { dir: 'ltr', text: c.currency || 'SAR' }));
            })))),
            el('tbody', null, trs)
          ]));
        }
        var pendNode = pending.length ? el('ul', { class: 'adm-list fin-pending' }, pending.map(function (p) {
          var label = (en ? p.label_en : p.label_ar) || p.label_ar || p.label_en;
          return el('li', { 'data-pending': p.type || null }, [k.pill('warning', k.L('fin_pending', p.type)), label ? ' ' : null, label ? el('span', { text: label }) : null]);
        })) : el('p', { class: 'text-sm text-muted', text: k.t('mg_no_pending') });
        return [
          el('div', { class: 'alert alert-info fin-analytical-banner', role: 'note' }, el('div', { text: k.t('mg_banner') })),
          d.mixed_currency ? k.alert('warning', k.t('mg_mixed')) : null,
          head, tableNode,
          el('h4', { class: 'ops-sub-title', text: k.t('mg_pending') }), pendNode
        ];
      });
    }, 'fin-tx-margin');
  }

  var MINE = [
    { id: 'fin-costs', order: 80, render: renderCosts },
    { id: 'fin-margin', order: 85, render: renderMargin }
  ];
  var have = {};
  OPS.txSections.forEach(function (s) { if (s && s.id) have[s.id] = true; });
  MINE.forEach(function (s) { if (!have[s.id]) OPS.txSections.push(s); });
})();
