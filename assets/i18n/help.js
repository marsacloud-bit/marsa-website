/* ==========================================================================
   مرسى | MARSA — help.html dictionary (namespace 'help'), ar + en.
   Load order: config.js → i18n.js → assets/i18n/help.js → assets/i18n/app.js → main.js → supa.js
               → app-shell.js → pwa.js → help.js (defer).
   Static markup carries the Arabic text and [data-i18n="help.<k>"]; help.js reads
   MarsaI18n.t('help.<k>'). window.MarsaHelpDict keeps both languages for the
   bilingual "guide not available" message.
   ========================================================================== */
(function () {
  'use strict';

  var ar = {
    /* static markup (help.html) */
    breadcrumbAria: 'مسار التنقل',
    home: 'الرئيسية',
    title: 'دليل الاستخدام',
    envBadge: 'بيئة تجريبية',
    lead: 'أدلة مختصرة لكل دور في مرسى: كيف تنجز المهام اليومية، وما لا يفعله النظام. الأدلة نص ثابت يُقرأ دون تسجيل الدخول، ولا تعرض أي بيانات.',
    listTitle: 'الأدلة',
    listAria: 'قائمة الأدلة',
    articleAria: 'نص الدليل',
    noscript: 'يتطلب عرض الأدلة تفعيل JavaScript في المتصفح. الأدلة نفسها ملفات نصية في المجلد docs/guide.',
    stagingNote: 'هذه أدلة البيئة التجريبية: القنوات ودفترة تعمل بالمحاكاة، ولا يُرسل النظام أي رسالة تلقائيًا.',
    /* JS (help.js) */
    loading: 'جارٍ تحميل الدليل…',
    guide_index: 'البداية',
    guide_index_sub: 'نظرة عامة والأدوار',
    guide_admin: 'مدير المؤسسة',
    guide_admin_sub: 'الفروع والأعضاء والإعدادات',
    guide_ops: 'العمليات والمراسلات',
    guide_ops_sub: 'الطلبات والمعاملات والحاويات وصندوق المراسلات',
    guide_finance: 'المالية والفوترة',
    guide_finance_sub: 'فواتير الموردين والهوامش والفوترة ودفترة',
    'guide_client-portal': 'بوابة العميل',
    'guide_client-portal_sub': 'تتبع الشحنات والمستندات',
    guide_platform: 'إدارة المنصة',
    guide_platform_sub: 'المؤسسات والباقات والاشتراكات',
    failLoad: 'تعذّر تحميل الدليل. افتح الموقع من الخادم (لا من ملف محلي)، أو تأكد من نشر مجلد الأدلة.',
    failLarge: 'ملف الدليل أكبر من الحد المسموح للعرض (200 كيلوبايت).',
    failPath: 'مسار الملف:'
  };

  var en = {
    breadcrumbAria: 'Breadcrumb',
    home: 'Home',
    title: 'User guide',
    envBadge: 'Staging',
    lead: 'Short guides for every role in Marsa: how to get the daily tasks done, and what the system does not do. The guides are static text readable without signing in; they show no data.',
    listTitle: 'Guides',
    listAria: 'Guide list',
    articleAria: 'Guide text',
    noscript: 'Showing the guides requires JavaScript. The guides themselves are text files in the docs/guide folder.',
    stagingNote: 'These are the staging guides: channels and Daftra run in mock mode, and the system never sends a message automatically.',
    loading: 'Loading the guide…',
    guide_index: 'Start here',
    guide_index_sub: 'Overview and roles',
    guide_admin: 'Organization admin',
    guide_admin_sub: 'Branches, members and settings',
    guide_ops: 'Operations & messaging',
    guide_ops_sub: 'Requests, transactions, containers and the inbox',
    guide_finance: 'Finance & billing',
    guide_finance_sub: 'Supplier invoices, margins, billing and Daftra',
    'guide_client-portal': 'Client portal',
    'guide_client-portal_sub': 'Shipment tracking and documents',
    guide_platform: 'Platform administration',
    guide_platform_sub: 'Organizations, plans and subscriptions',
    failLoad: 'The guide could not be loaded. Open the site from the web server (not from a local file), or make sure the guides folder is deployed.',
    failLarge: 'The guide file is larger than the display limit (200 KB).',
    failPath: 'File path:'
  };

  window.MarsaHelpDict = { ar: ar, en: en };
  if (!window.MarsaI18n || typeof window.MarsaI18n.register !== 'function') return;
  window.MarsaI18n.register('help', { ar: ar, en: en });
})();
