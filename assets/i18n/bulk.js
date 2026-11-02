/* ==========================================================================
   مرسى | MARSA — bulk-upload.html strings (namespace 'bulk'), ar + en.
   Load order: config.js → i18n.js → assets/i18n/bulk.js → assets/i18n/app.js → main.js
               → supa.js → app-shell.js → pwa.js → xlsx-lite.js → bulk-upload.js (defer).
   Only the strings of the confirmation dialog (MarsaShell.confirm). The page
   keeps its original Arabic-only design: bulk-upload.html has no
   <html data-i18n-page>, so i18n.js renders it in Arabic / RTL.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.MarsaI18n || typeof window.MarsaI18n.register !== 'function') return;
  window.MarsaI18n.register('bulk', {
    ar: {
      confirmTitle: 'صفوف بها أخطاء',
      confirmLocalOk: 'حفظ الصالحة',
      confirmOnlineOk: 'رفع الصالحة'
    },
    en: {
      confirmTitle: 'Rows with errors',
      confirmLocalOk: 'Save valid rows',
      confirmOnlineOk: 'Upload valid rows'
    }
  });
})();
