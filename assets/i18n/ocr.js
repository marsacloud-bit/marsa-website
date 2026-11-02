/* ==========================================================================
   مرسى | MARSA — ocr.html shell strings (namespace 'ocr'), ar + en.
   Load order: config.js → i18n.js → assets/i18n/ocr.js → assets/i18n/app.js → main.js
               → supa.js → app-shell.js → pwa.js → xlsx-lite.js → ocr-parse.js → ocr.js (defer).
   Only the strings added for the app shell (topbar title / breadcrumb, page
   header). The OCR tool itself is still Arabic-only: ocr.html has no
   <html data-i18n-page>, so i18n.js renders it in Arabic / RTL.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.MarsaI18n || typeof window.MarsaI18n.register !== 'function') return;
  window.MarsaI18n.register('ocr', {
    ar: {
      title: 'قراءة المستندات (OCR)',
      crumb: 'العمل اليومي',
      lead: 'صوّر الفاتورة أو البوليصة أو البيان الجمركي أو ارفع ملف PDF ممسوحًا، وسنحوّله إلى نص وبيانات منظمة. راجع النتيجة وعدّلها، ثم انسخها أو نزّلها أو احفظها أو استخدمها في طلب تخليص.',
      localBadge: 'القراءة داخل متصفحك'
    },
    en: {
      title: 'Document reading (OCR)',
      crumb: 'Daily work',
      lead: 'Photograph an invoice, bill of lading or customs declaration, or upload a scanned PDF, and we turn it into text and structured data. Review and correct the result, then copy, download or save it, or use it in a clearance request.',
      localBadge: 'Read in your browser'
    }
  });
})();
