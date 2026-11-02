/* ==========================================================================
   مرسى | MARSA — bulk-upload.html shell strings (namespace 'bulk'), ar + en.
   Load order: config.js → i18n.js → assets/i18n/bulk.js → assets/i18n/app.js → main.js
               → supa.js → app-shell.js → pwa.js → xlsx-lite.js → bulk-upload.js (defer).
   Only the strings added for the app shell (topbar title / breadcrumb, page
   header, confirmation dialogs). The import tool itself is still
   Arabic-only: bulk-upload.html has no <html data-i18n-page>, so i18n.js
   renders it in Arabic / RTL.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.MarsaI18n || typeof window.MarsaI18n.register !== 'function') return;
  window.MarsaI18n.register('bulk', {
    ar: {
      title: 'الرفع الجماعي',
      crumb: 'العمل اليومي',
      tipsLink: 'نصائح تجهيز الملف',
      confirmTitle: 'صفوف بها أخطاء',
      confirmLocalOk: 'حفظ الصالحة',
      confirmOnlineOk: 'رفع الصالحة'
    },
    en: {
      title: 'Bulk upload',
      crumb: 'Daily work',
      tipsLink: 'File preparation tips',
      confirmTitle: 'Rows with errors',
      confirmLocalOk: 'Save valid rows',
      confirmOnlineOk: 'Upload valid rows'
    }
  });
})();
