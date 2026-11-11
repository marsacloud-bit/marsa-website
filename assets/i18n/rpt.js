/* ==========================================================================
   مرسى | MARSA — reports & search dictionary (G6a: #search, #reports/<kind>, the export
   engine rpt/export.js and the shell's nav labels rpt.nav_group / nav_search / nav_reports).
   Keys become 'rpt.<k>'. Loaded after assets/i18n/bill.js, before rpt/*.js.
   Arabic is the default; English entries are used when MarsaI18n.lang() === 'en'.
   The same object is kept on window.MarsaRptDict so the views still have their strings
   when i18n.js is missing (they then render Arabic only).
   Label fallbacks '<domain>_<code>' (the server's status_labels win when loaded):
   operational_status_, container_return_status_, container_state_, trip_status_,
   declaration_status_, financial_status_, fin_level_, report_kind_, export_format_,
   search_date_field_. MRS_EXPORT messages: exp_err_<detail>.
   ========================================================================== */
(function () {
  'use strict';
  var DICT = {
    ar: {
      // shell navigation (app-shell.js reads rpt.nav_*)
      nav_group: 'التقارير والبحث', nav_search: 'البحث المتقدم', nav_reports: 'التقارير',
      cmdk_advanced: 'بحث متقدم عن «{q}»…',

      // generic
      all: 'الكل', all_branches: 'كل الفروع', yes: 'نعم', no: 'لا', apply: 'تطبيق', clear: 'مسح', do_search: 'بحث',
      api_missing: 'هذه الميزة غير متاحة بعد في الخادم ({fn}).', key_none: 'بدون تخصيص', riyadh_tz: 'بتوقيت الرياض',
      results_n: '{n} نتيجة', prev: 'السابق', next: 'التالي', pager: 'التنقل بين الصفحات', pager_info: 'عرض {from}–{to} من {total}',
      total_n: 'الإجمالي: {n}', total_cur: 'الإجمالي — {cur}', total_cur_n: 'الإجمالي — {cur} ({n})', days_late: 'متأخرة {n} يوم',
      tot_open_overdue: 'مفتوحة {open} · متأخرة {overdue}',

      // search view
      search_title: 'البحث المتقدم', search_sub: 'ابحث في المعاملات برقم البيان أو البوليصة أو الحاوية أو العميل أو الناقل أو المنفذ أو التاريخ — النتائج حسب صلاحياتك وفروعك.',
      search_empty_title: 'لا نتائج مطابقة', search_empty_text: 'لا توجد معاملات مطابقة لهذه المعايير ضمن الفروع المسموح لك بها. جرّب تخفيف الفلاتر.',
      f_q: 'نص عام', f_q_ph: 'مرجع، بيان، بوليصة، حاوية، عميل…', f_declaration_no: 'رقم البيان', f_bl_number: 'رقم البوليصة', f_container_no: 'رقم الحاوية',
      f_client: 'العميل', f_client_q: 'العميل (نص)', f_client_q_ph: 'الاسم أو السجل أو الرقم الضريبي', f_carrier: 'الناقل', f_carrier_q: 'الناقل (نص)',
      f_carrier_q_ph: 'الخط الملاحي أو الناقل', f_port: 'المنفذ', f_date_field: 'نوع التاريخ', f_from: 'من', f_to: 'إلى', f_branch: 'الفرع', f_status: 'الحالة',
      f_sort: 'الترتيب', f_from_planned: 'من (موعد الرحلة)', f_from_created: 'من (إنشاء المعاملة)', f_from_item: 'من (تاريخ البند)',
      f_return_status: 'حالة الإرجاع', f_operational_state: 'الحالة التشغيلية للحاوية', f_overdue: 'المتأخرة فقط', f_trip_status: 'حالة الرحلة',
      f_late: 'المتأخرة فقط (مخططة أو مُرسلة وفات موعدها)',       f_include_finance: 'إظهار التكلفة والبيع', f_level: 'مستوى التأكيد', f_currency: 'العملة', f_group_by: 'التجميع حسب', f_include_overhead: 'تشمل المصاريف العامة',
      f_report: 'التقرير', f_mine: 'تصديراتي فقط',
      err_q_short: 'اكتب حرفين على الأقل للبحث.', err_range: 'تاريخ البداية بعد تاريخ النهاية.', err_range_wide: 'المدى الزمني أطول من ثلاث سنوات؛ ضيّق المدى.',
      sort_created_desc: 'الأحدث أولًا', sort_created_asc: 'الأقدم أولًا', sort_ref: 'حسب المرجع', sort_eta: 'حسب تاريخ الوصول', sort_status_changed_desc: 'آخر تغيير حالة',
      sort_deadline_asc: 'أقرب موعد إرجاع', sort_deadline_desc: 'أبعد موعد إرجاع', sort_container_no: 'حسب رقم الحاوية', sort_planned_desc: 'الأحدث موعدًا', sort_planned_asc: 'الأقدم موعدًا',
      cdf_created: 'تاريخ الإضافة', cdf_return_deadline: 'موعد الإرجاع', cdf_returned_at: 'تاريخ الإرجاع', cdf_gate_out: 'الخروج من الميناء',

      // reports view
      reports_title: 'التقارير', reports_sub: 'تقارير تشغيلية وتحليلية مع تصدير مطابق للفلاتر والإجماليات الظاهرة. التصدير يخضع لصلاحياتك نفسها ويُسجَّل.',
      tab_transactions: 'المعاملات', tab_containers: 'الحاويات وإرجاع الفارغ', tab_trips: 'رحلات النقل', tab_margins: 'الربحية (تحليلي)', tab_costs: 'التكاليف (تحليلي)', tab_exports: 'سجل التصدير',
      analytical_banner: 'تحليلي — ليس رقمًا محاسبيًا رسميًا. الأرقام المحاسبية الرسمية للفواتير مصدرها دفترة.',
      rpt_empty_title: 'لا توجد بيانات', rpt_empty_text: 'لا توجد سجلات مطابقة لهذه الفلاتر ضمن صلاحياتك. جرّب مدى زمنيًا أوسع.',
      log_empty_title: 'لا توجد عمليات تصدير', log_empty_text: 'لم تُسجَّل أي عملية تصدير بهذه الفلاتر.', log_own_only: 'تظهر هنا عمليات التصدير التي قمت بها أنت فقط.',
      k_count: 'عدد السجلات', k_containers: 'الحاويات', k_open_returns: 'إرجاع مفتوح', k_open: 'إرجاع مفتوح', k_overdue: 'متأخرة', k_due_3d: 'خلال 3 أيام',
      k_margin_expected: 'الهامش المتوقع', k_cost_confirmed: 'التكلفة المؤكدة',
      r_search: 'بحث متقدم', r_transactions: 'تقرير المعاملات', r_containers: 'تقرير الحاويات وإرجاع الفارغ', r_trips: 'تقرير رحلات النقل', r_margins: 'الربحية (تحليلي)', r_costs: 'التكاليف (تحليلي)',

      // columns
      c_ref: 'المرجع', c_client: 'العميل', c_branch: 'الفرع', c_status: 'الحالة', c_declaration_no: 'رقم البيان', c_declaration_status: 'حالة البيان', c_bl_number: 'رقم البوليصة',
      c_port: 'المنفذ', c_shipping_line: 'الخط الملاحي', c_eta: 'الوصول المتوقع', c_containers: 'الحاويات', c_open_returns: 'إرجاع مفتوح', c_financial_status: 'الحالة المالية',
      c_created_at: 'تاريخ الإنشاء', c_matched: 'سبب المطابقة', c_container_no: 'رقم الحاوية', c_container_type: 'النوع', c_operational_state: 'الحالة التشغيلية',
      c_return_status: 'حالة الإرجاع', c_return_deadline: 'موعد الإرجاع', c_returned_at: 'أُرجعت في', c_gate_out_at: 'خرجت من الميناء', c_return_place: 'مكان الإرجاع',
      c_days_overdue: 'أيام التأخير', c_leg_no: 'المرحلة', c_carrier: 'الناقل', c_driver: 'السائق', c_truck: 'الشاحنة', c_origin: 'من', c_destination: 'إلى',
      c_planned_at: 'الموعد المخطط', c_loaded_at: 'التحميل', c_unloaded_at: 'التفريغ', c_trip_status: 'حالة الرحلة', c_cost: 'التكلفة', c_cost_currency: 'عملة التكلفة',
      c_sell: 'سعر البيع', c_sell_currency: 'عملة البيع', c_currency: 'العملة', c_charges_service: 'رسوم الخدمات', c_cost_confirmed: 'تكلفة مؤكدة', c_cost_estimated: 'تكلفة تقديرية',
      c_margin_confirmed: 'الهامش المؤكد', c_margin_expected: 'الهامش المتوقع', c_level: 'مستوى التأكيد', c_pending: 'معلّقة', c_confirmed: 'مؤكدة', c_estimated: 'تقديرية',
      c_unknown_count: 'غير معروفة', c_pass_through: 'مبالغ مستردة', c_client_paid_direct: 'دفعها العميل مباشرة', c_items: 'البنود',
      c_actor: 'المستخدم', c_report: 'التقرير', c_format: 'الصيغة', c_rows: 'الصفوف', c_filters: 'الفلاتر',
      grp_transaction: 'المعاملة', grp_client: 'العميل', grp_supplier: 'المورد', grp_service: 'الخدمة', grp_branch: 'الفرع', grp_level: 'مستوى التأكيد',
      m_ref: 'المرجع', m_container_no: 'حاوية', m_declaration_no: 'بيان', m_declaration_status: 'حالة البيان', m_bl_number: 'بوليصة', m_client: 'عميل', m_carrier: 'ناقل', m_port: 'منفذ',

      // export
      exp_label: 'تصدير:', exp_group: 'تصدير التقرير', exp_xlsx: 'Excel', exp_csv: 'CSV', exp_print: 'طباعة / PDF',
      exp_running: 'جارٍ تجهيز الملف…', exp_done: 'تم التصدير — عدد الصفوف: {n}.', exp_done_print: 'فُتحت نافذة الطباعة (عدد الصفوف: {n}). اختر «حفظ بصيغة PDF» لحفظ نسخة.',
      exp_demo: 'التصدير غير متاح في وضع العرض التجريبي.',
      exp_err_totals_mismatch: 'تغيّرت البيانات أثناء التصدير، أعد المحاولة.', exp_err_data_changed: 'تغيّرت البيانات أثناء التصدير، أعد المحاولة.',
      exp_err_too_many_rows: 'عدد الصفوف أكبر من المسموح للتصدير (Excel / CSV حتى 10٬000 صف، الطباعة حتى 2٬000). ضيّق الفلاتر.',
      exp_err_audit_failed: 'تعذّر تسجيل عملية التصدير، لذلك لم يُنشأ الملف. أعد المحاولة.', exp_err_no_rows: 'لا توجد صفوف لتصديرها.',
      exp_err_build: 'تعذّر إنشاء الملف في المتصفح.',
      crit_sheet: 'معايير التقرير', crit_item: 'البند', crit_value: 'القيمة', crit_report: 'التقرير', crit_org: 'المنشأة', crit_generated_at: 'وقت الإنشاء',
      crit_generated_by: 'أنشأه', crit_rows: 'عدد الصفوف', print_foot: 'مرسى MARSA — أُنشئ في {at} (بتوقيت الرياض) بواسطة {by}',

      // label fallbacks
      operational_status_new: 'جديدة', operational_status_in_progress: 'قيد التنفيذ', operational_status_customs_declaration: 'البيان الجمركي', operational_status_appointment: 'موعد الميناء',
      operational_status_transport: 'النقل', operational_status_empty_return: 'إرجاع الفارغ', operational_status_operationally_complete: 'مكتملة تشغيليًا', operational_status_under_billing: 'قيد الفوترة',
      operational_status_billed: 'مفوترة', operational_status_closed: 'مغلقة',
      container_return_status_pending: 'بانتظار الإرجاع', container_return_status_evidence_submitted: 'دليل مرفوع بانتظار التحقق', container_return_status_returned_verified: 'أُرجعت (موثّق)',
      container_return_status_disputed: 'مراجعة بشرية', container_return_status_waived: 'لا يلزم إرجاع',
      container_state_expected: 'متوقعة', container_state_at_port: 'في الميناء', container_state_released: 'مفسوحة', container_state_gated_out: 'خرجت من الميناء', container_state_delivered: 'سُلِّمت للعميل', container_state_empty_returned: 'أُعيدت فارغة',
      trip_status_planned: 'مخطط لها', trip_status_dispatched: 'انطلقت', trip_status_loaded: 'محمّلة', trip_status_delivered: 'سُلِّمت', trip_status_cancelled: 'ملغاة',
      declaration_status_draft: 'مسودة', declaration_status_submitted: 'مقدَّم', declaration_status_under_inspection: 'تحت المعاينة', declaration_status_released: 'مفسوح', declaration_status_cancelled: 'ملغى', declaration_status_replaced: 'مستبدل',
      declaration_status_accepted: 'قبول البيان — مرحلة تفتيش ومعاينة البضاعة', declaration_status_cco_review_done: 'انتهاء مراجعة مركز العمليات الجمركية', declaration_status_awaiting_duty_payment: 'مرحلة انتظار تحصيل الرسوم الجمركية', declaration_status_release_ready: 'جاهز لطباعة إشعار الفسح الإلكتروني',
      financial_status_not_started: 'لم تبدأ', financial_status_estimate_only: 'تقدير فقط', financial_status_draft_pending: 'مسودة قيد الإعداد', financial_status_invoiced: 'مفوترة', financial_status_settled: 'مسددة',
      fin_level_confirmed: 'مؤكد', fin_level_estimated: 'تقديري', fin_level_unknown: 'غير معروف',
      report_kind_search: 'بحث متقدم', report_kind_transactions: 'تقرير المعاملات', report_kind_containers: 'تقرير الحاويات وإرجاع الفارغ', report_kind_trips: 'تقرير رحلات النقل',
      report_kind_margins: 'الربحية (تحليلي)', report_kind_costs: 'التكاليف (تحليلي)',
      export_format_xlsx: 'Excel', export_format_csv: 'CSV', export_format_print: 'طباعة / PDF',
      search_date_field_created: 'تاريخ الإنشاء', search_date_field_eta: 'تاريخ الوصول المتوقع', search_date_field_declaration: 'تاريخ البيان', search_date_field_status_changed: 'آخر تغيير حالة'
    },
    en: {
      nav_group: 'Reports & search', nav_search: 'Advanced search', nav_reports: 'Reports',
      cmdk_advanced: 'Advanced search for "{q}"…',

      all: 'All', all_branches: 'All branches', yes: 'Yes', no: 'No', apply: 'Apply', clear: 'Clear', do_search: 'Search',
      api_missing: 'This feature is not available on the server yet ({fn}).', key_none: 'Not attributed', riyadh_tz: 'Riyadh time',
      results_n: '{n} results', prev: 'Previous', next: 'Next', pager: 'Pages', pager_info: 'Showing {from}–{to} of {total}',
      total_n: 'Total: {n}', total_cur: 'Total — {cur}', total_cur_n: 'Total — {cur} ({n})', days_late: '{n} days late',
      tot_open_overdue: '{open} open · {overdue} overdue',

      search_title: 'Advanced search', search_sub: 'Search transactions by declaration, B/L, container, client, carrier, port or date — results follow your roles and branches.',
      search_empty_title: 'No matching results', search_empty_text: 'No transactions match these criteria in the branches you can see. Try fewer filters.',
      f_q: 'Free text', f_q_ph: 'Reference, declaration, B/L, container, client…', f_declaration_no: 'Declaration no.', f_bl_number: 'B/L no.', f_container_no: 'Container no.',
      f_client: 'Client', f_client_q: 'Client (text)', f_client_q_ph: 'Name, CR or VAT number', f_carrier: 'Carrier', f_carrier_q: 'Carrier (text)',
      f_carrier_q_ph: 'Shipping line or carrier', f_port: 'Port', f_date_field: 'Date type', f_from: 'From', f_to: 'To', f_branch: 'Branch', f_status: 'Status',
      f_sort: 'Sort', f_from_planned: 'From (trip date)', f_from_created: 'From (transaction created)', f_from_item: 'From (item date)',
      f_return_status: 'Return status', f_operational_state: 'Container state', f_overdue: 'Overdue only', f_trip_status: 'Trip status',
      f_late: 'Late only (planned or dispatched, time passed)',       f_include_finance: 'Show cost and sell', f_level: 'Confidence level', f_currency: 'Currency', f_group_by: 'Group by', f_include_overhead: 'Include overhead',
      f_report: 'Report', f_mine: 'My exports only',
      err_q_short: 'Type at least 2 characters to search.', err_range: 'The start date is after the end date.', err_range_wide: 'The date range is longer than three years; narrow it.',
      sort_created_desc: 'Newest first', sort_created_asc: 'Oldest first', sort_ref: 'By reference', sort_eta: 'By ETA', sort_status_changed_desc: 'Last status change',
      sort_deadline_asc: 'Nearest return deadline', sort_deadline_desc: 'Latest return deadline', sort_container_no: 'By container no.', sort_planned_desc: 'Latest trips first', sort_planned_asc: 'Earliest trips first',
      cdf_created: 'Added', cdf_return_deadline: 'Return deadline', cdf_returned_at: 'Returned', cdf_gate_out: 'Gate out',

      reports_title: 'Reports', reports_sub: 'Operational and analytical reports with exports that match the visible filters and totals. Exports follow your permissions and are logged.',
      tab_transactions: 'Transactions', tab_containers: 'Containers & empty return', tab_trips: 'Transport trips', tab_margins: 'Profitability (analytical)', tab_costs: 'Costs (analytical)', tab_exports: 'Export log',
      analytical_banner: 'Analytical — not an official accounting figure. Official invoice figures come from Daftra.',
      rpt_empty_title: 'No data', rpt_empty_text: 'No records match these filters within your permissions. Try a wider date range.',
      log_empty_title: 'No exports', log_empty_text: 'No export matches these filters.', log_own_only: 'Only the exports you made are shown here.',
      k_count: 'Records', k_containers: 'Containers', k_open_returns: 'Open returns', k_open: 'Open returns', k_overdue: 'Overdue', k_due_3d: 'Due in 3 days',
      k_margin_expected: 'Expected margin', k_cost_confirmed: 'Confirmed cost',
      r_search: 'Advanced search', r_transactions: 'Transactions report', r_containers: 'Containers & empty return report', r_trips: 'Transport trips report', r_margins: 'Profitability (analytical)', r_costs: 'Costs (analytical)',

      c_ref: 'Reference', c_client: 'Client', c_branch: 'Branch', c_status: 'Status', c_declaration_no: 'Declaration no.', c_declaration_status: 'Declaration status', c_bl_number: 'B/L no.',
      c_port: 'Port', c_shipping_line: 'Shipping line', c_eta: 'ETA', c_containers: 'Containers', c_open_returns: 'Open returns', c_financial_status: 'Financial status',
      c_created_at: 'Created', c_matched: 'Matched on', c_container_no: 'Container no.', c_container_type: 'Type', c_operational_state: 'State',
      c_return_status: 'Return status', c_return_deadline: 'Return deadline', c_returned_at: 'Returned at', c_gate_out_at: 'Gate out', c_return_place: 'Return place',
      c_days_overdue: 'Days overdue', c_leg_no: 'Leg', c_carrier: 'Carrier', c_driver: 'Driver', c_truck: 'Truck', c_origin: 'From', c_destination: 'To',
      c_planned_at: 'Planned', c_loaded_at: 'Loaded', c_unloaded_at: 'Unloaded', c_trip_status: 'Trip status', c_cost: 'Cost', c_cost_currency: 'Cost currency',
      c_sell: 'Sell', c_sell_currency: 'Sell currency', c_currency: 'Currency', c_charges_service: 'Service charges', c_cost_confirmed: 'Confirmed cost', c_cost_estimated: 'Estimated cost',
      c_margin_confirmed: 'Confirmed margin', c_margin_expected: 'Expected margin', c_level: 'Confidence', c_pending: 'Pending', c_confirmed: 'Confirmed', c_estimated: 'Estimated',
      c_unknown_count: 'Unknown', c_pass_through: 'Pass-through', c_client_paid_direct: 'Paid by client directly', c_items: 'Items',
      c_actor: 'User', c_report: 'Report', c_format: 'Format', c_rows: 'Rows', c_filters: 'Filters',
      grp_transaction: 'Transaction', grp_client: 'Client', grp_supplier: 'Supplier', grp_service: 'Service', grp_branch: 'Branch', grp_level: 'Confidence level',
      m_ref: 'Reference', m_container_no: 'Container', m_declaration_no: 'Declaration', m_declaration_status: 'Declaration status', m_bl_number: 'B/L', m_client: 'Client', m_carrier: 'Carrier', m_port: 'Port',

      exp_label: 'Export:', exp_group: 'Export the report', exp_xlsx: 'Excel', exp_csv: 'CSV', exp_print: 'Print / PDF',
      exp_running: 'Preparing the file…', exp_done: '{n} rows exported.', exp_done_print: 'The print dialog is open ({n} rows). Choose "Save as PDF" to keep a copy.',
      exp_demo: 'Export is not available in demo mode.',
      exp_err_totals_mismatch: 'The data changed during the export. Try again.', exp_err_data_changed: 'The data changed during the export. Try again.',
      exp_err_too_many_rows: 'Too many rows to export (Excel / CSV up to 10,000 rows, print up to 2,000). Narrow the filters.',
      exp_err_audit_failed: 'The export could not be logged, so no file was created. Try again.', exp_err_no_rows: 'There are no rows to export.',
      exp_err_build: 'The file could not be created in the browser.',
      crit_sheet: 'Report criteria', crit_item: 'Item', crit_value: 'Value', crit_report: 'Report', crit_org: 'Organization', crit_generated_at: 'Generated at',
      crit_generated_by: 'Generated by', crit_rows: 'Rows', print_foot: 'MARSA — generated {at} (Riyadh time) by {by}',

      operational_status_new: 'New', operational_status_in_progress: 'In progress', operational_status_customs_declaration: 'Customs declaration', operational_status_appointment: 'Port appointment',
      operational_status_transport: 'Transport', operational_status_empty_return: 'Empty return', operational_status_operationally_complete: 'Operationally complete', operational_status_under_billing: 'Under billing',
      operational_status_billed: 'Billed', operational_status_closed: 'Closed',
      container_return_status_pending: 'Pending return', container_return_status_evidence_submitted: 'Evidence submitted', container_return_status_returned_verified: 'Returned (verified)',
      container_return_status_disputed: 'Human review', container_return_status_waived: 'Waived',
      container_state_expected: 'Expected', container_state_at_port: 'At port', container_state_released: 'Released', container_state_gated_out: 'Gated out', container_state_delivered: 'Delivered', container_state_empty_returned: 'Empty returned',
      trip_status_planned: 'Planned', trip_status_dispatched: 'Dispatched', trip_status_loaded: 'Loaded', trip_status_delivered: 'Delivered', trip_status_cancelled: 'Cancelled',
      declaration_status_draft: 'Draft', declaration_status_submitted: 'Submitted', declaration_status_under_inspection: 'Under inspection', declaration_status_released: 'Released', declaration_status_cancelled: 'Cancelled', declaration_status_replaced: 'Replaced',
      declaration_status_accepted: 'Accepted — inspection stage', declaration_status_cco_review_done: 'Customs operations centre review done', declaration_status_awaiting_duty_payment: 'Awaiting customs duty payment', declaration_status_release_ready: 'Ready to print the release notice',
      financial_status_not_started: 'Not started', financial_status_estimate_only: 'Estimate only', financial_status_draft_pending: 'Draft pending', financial_status_invoiced: 'Invoiced', financial_status_settled: 'Settled',
      fin_level_confirmed: 'Confirmed', fin_level_estimated: 'Estimated', fin_level_unknown: 'Unknown',
      report_kind_search: 'Advanced search', report_kind_transactions: 'Transactions report', report_kind_containers: 'Containers & empty return report', report_kind_trips: 'Transport trips report',
      report_kind_margins: 'Profitability (analytical)', report_kind_costs: 'Costs (analytical)',
      export_format_xlsx: 'Excel', export_format_csv: 'CSV', export_format_print: 'Print / PDF',
      search_date_field_created: 'Created', search_date_field_eta: 'ETA', search_date_field_declaration: 'Declaration date', search_date_field_status_changed: 'Last status change'
    }
  };
  window.MarsaRptDict = DICT;
  if (window.MarsaI18n && typeof window.MarsaI18n.register === 'function') window.MarsaI18n.register('rpt', DICT);
})();
