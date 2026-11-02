/* ==========================================================================
   مرسى | MARSA — shared strings of assets/js/app-shell.js (window.MarsaShell). Keys become 'app.<k>'.
   Loaded after the page dictionary and before main.js / supa.js / app-shell.js.
   Arabic is the default; English entries are used when MarsaI18n.lang() === 'en'.
   The same object is kept on window.MarsaAppDict so the helper still has its
   strings when i18n.js is missing (it then renders Arabic only).
   ========================================================================== */
(function () {
  'use strict';
  var DICT = {
    ar: {
      brand: 'مرسى MARSA', title_suffix: 'مرسى MARSA', loading: 'جارٍ التحميل…',
      // navigation groups + items (single source: NAV in app-shell.js → MarsaShell.navItems())
      grp_work: 'العمل اليومي', grp_manage: 'الإدارة', grp_platform: 'المنصة', grp_client: 'حسابي',
      nav_dashboard: 'نظرة عامة', nav_requests: 'الطلبات الواردة', nav_transactions: 'المعاملات', nav_clients: 'العملاء',
      nav_messages: 'رسائل التواصل', nav_bulk: 'الرفع الجماعي', nav_ocr: 'قراءة المستندات', nav_imports: 'سجل الاستيراد',
      nav_org: 'المؤسسة', nav_branches: 'الفروع', nav_members: 'الأعضاء والدعوات', nav_audit: 'سجل التدقيق',
      nav_errors: 'أخطاء الواجهة', nav_platform: 'لوحة المنصة', nav_portal: 'بوابتي', nav_request: 'طلب جديد',
      nav_tracking: 'تتبع شحنة', nav_offline: 'غير متصل',
      badge_count: 'العدد: {n}',
      // signed-out / demo states (palette status line)
      signed_out_text: 'سجّل الدخول لعرض الأقسام المتاحة لحسابك.',
      demo_text: 'النسخة المتصلة غير مفعّلة على هذا الموقع، فلا توجد أقسام حساب.',
      sign_in: 'تسجيل الدخول',
      // command palette
      search_button: 'بحث', search_aria: 'فتح لوحة البحث والأوامر (Ctrl+K)',
      cmdk_label: 'لوحة البحث والأوامر', cmdk_input_label: 'ابحث في الأقسام والمعاملات والعملاء والطلبات',
      cmdk_placeholder: 'اكتب قسمًا أو رقمًا مرجعيًا أو بوليصة أو بيانًا أو حاوية أو عميلًا…',
      cmdk_nav: 'انتقال', cmdk_actions: 'إجراءات', cmdk_tx: 'المعاملات', cmdk_clients: 'العملاء', cmdk_requests: 'الطلبات',
      cmdk_searching: 'جارٍ البحث…', cmdk_empty: 'لا توجد نتائج مطابقة.', cmdk_min: 'اكتب حرفين على الأقل للبحث في البيانات.',
      cmdk_error: 'تعذّر البحث في البيانات: {msg}', cmdk_count: 'عدد النتائج: {n}',
      cmdk_foot_nav: 'للتنقل', cmdk_foot_open: 'للفتح', cmdk_foot_close: 'للإغلاق',
      f_bl: 'بوليصة', f_decl: 'بيان', f_container: 'حاوية', f_cr: 'سجل تجاري', f_vat: 'رقم ضريبي',
      act_lang: 'التبديل إلى الإنجليزية', act_signout: 'تسجيل الخروج',
      // organization switcher
      org_switch: 'المؤسسة النشطة', org_switched: 'المؤسسة النشطة الآن: {name}', org_failed: 'تعذّر تبديل المؤسسة: {msg}',
      org_unknown: 'هذه المؤسسة غير متاحة لحسابك.',
      // account
      user_fallback: 'مستخدم', none: '—', platform_admin: 'مدير المنصة', client_account: 'حساب عميل',
      signout: 'تسجيل الخروج', signout_all: 'تسجيل الخروج من كل الأجهزة',
      signout_all_title: 'تسجيل الخروج من كل الأجهزة؟',
      signout_all_text: 'سيُلغى الدخول في كل المتصفحات والأجهزة المرتبطة بحسابك، وقد تبقى الجلسات المفتوحة صالحة حتى ساعة واحدة كحد أقصى.',
      signout_all_ok: 'الخروج من كل الأجهزة', signout_failed: 'تعذّر تسجيل الخروج: {msg}',
      // dialogs + toasts
      confirm_title: 'تأكيد', ok: 'موافق', cancel: 'إلغاء', close: 'إغلاق', toast_close: 'إخفاء التنبيه',
      // roles (same wording as the admin console)
      role_client: 'عميل', role_clearance_staff: 'موظف تخليص', role_transport_staff: 'موظف نقل', role_accountant: 'محاسب',
      role_accounts_manager: 'مدير حسابات', role_operations_manager: 'مدير عمليات', role_branch_manager: 'مدير فرع',
      role_supervisor: 'مشرف', role_admin: 'مدير المؤسسة'
    },
    en: {
      brand: 'MARSA', title_suffix: 'MARSA', loading: 'Loading…',
      grp_work: 'Workspace', grp_manage: 'Administration', grp_platform: 'Platform', grp_client: 'My account',
      nav_dashboard: 'Overview', nav_requests: 'Incoming requests', nav_transactions: 'Transactions', nav_clients: 'Clients',
      nav_messages: 'Contact messages', nav_bulk: 'Bulk upload', nav_ocr: 'Document reader', nav_imports: 'Import history',
      nav_org: 'Organization', nav_branches: 'Branches', nav_members: 'Members & invitations', nav_audit: 'Audit log',
      nav_errors: 'Client errors', nav_platform: 'Platform console', nav_portal: 'My portal', nav_request: 'New request',
      nav_tracking: 'Track a shipment', nav_offline: 'Offline',
      badge_count: 'Count: {n}',
      signed_out_text: 'Sign in to see the sections available to your account.',
      demo_text: 'The online version is not enabled on this site, so there are no account sections.',
      sign_in: 'Sign in',
      search_button: 'Search', search_aria: 'Open search and commands (Ctrl+K)',
      cmdk_label: 'Search and commands', cmdk_input_label: 'Search sections, transactions, clients and requests',
      cmdk_placeholder: 'Type a section, reference, B/L, declaration, container or client…',
      cmdk_nav: 'Go to', cmdk_actions: 'Actions', cmdk_tx: 'Transactions', cmdk_clients: 'Clients', cmdk_requests: 'Requests',
      cmdk_searching: 'Searching…', cmdk_empty: 'No matching results.', cmdk_min: 'Type at least 2 characters to search records.',
      cmdk_error: 'Could not search records: {msg}', cmdk_count: '{n} results',
      cmdk_foot_nav: 'to navigate', cmdk_foot_open: 'to open', cmdk_foot_close: 'to close',
      f_bl: 'B/L', f_decl: 'Decl.', f_container: 'Container', f_cr: 'CR', f_vat: 'VAT',
      act_lang: 'Switch to Arabic', act_signout: 'Sign out',
      org_switch: 'Active organization', org_switched: 'Active organization: {name}', org_failed: 'Could not switch organization: {msg}',
      org_unknown: 'This organization is not available to your account.',
      user_fallback: 'User', none: '—', platform_admin: 'Platform admin', client_account: 'Client account',
      signout: 'Sign out', signout_all: 'Sign out of all devices',
      signout_all_title: 'Sign out of all devices?',
      signout_all_text: 'Every browser and device signed in to your account will be signed out. Sessions already open may stay valid for up to one hour.',
      signout_all_ok: 'Sign out everywhere', signout_failed: 'Could not sign out: {msg}',
      confirm_title: 'Confirm', ok: 'OK', cancel: 'Cancel', close: 'Close', toast_close: 'Dismiss',
      role_client: 'Client', role_clearance_staff: 'Clearance officer', role_transport_staff: 'Transport officer', role_accountant: 'Accountant',
      role_accounts_manager: 'Accounts manager', role_operations_manager: 'Operations manager', role_branch_manager: 'Branch manager',
      role_supervisor: 'Supervisor', role_admin: 'Organization admin'
    }
  };
  window.MarsaAppDict = DICT;
  if (window.MarsaI18n && typeof window.MarsaI18n.register === 'function') window.MarsaI18n.register('app', DICT);
})();
