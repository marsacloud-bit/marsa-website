/* ==========================================================================
   مرسى | MARSA — ocr.html strings (namespace 'ocr'), ar + en.
   Load order: config.js → i18n.js → assets/i18n/ocr.js → assets/i18n/app.js → main.js
               → supa.js → app-shell.js → pwa.js → xlsx-lite.js → ocr-parse.js → ocr.js (defer).
   The page uses the original (efa96c9) layout: site header, page-hero with
   a static breadcrumb, footer. The OCR tool itself is still Arabic-only:
   ocr.html has no <html data-i18n-page>, so i18n.js renders it in Arabic /
   RTL. These keys name the page for shared code (title / lead).
   ========================================================================== */
(function () {
  'use strict';
  if (!window.MarsaI18n || typeof window.MarsaI18n.register !== 'function') return;
  window.MarsaI18n.register('ocr', {
    ar: {
      title: 'قراءة الفواتير والمستندات (OCR)',
      crumb: 'قراءة المستندات (OCR)',
      lead: 'صوّر الفاتورة أو البوليصة أو البيان الجمركي أو ارفع ملف PDF ممسوحًا، وسنحوّله إلى نص وبيانات منظمة. راجع النتيجة وعدّلها، ثم انسخها أو نزّلها أو احفظها أو استخدمها في طلب تخليص.'
    },
    en: {
      title: 'Invoice and document reading (OCR)',
      crumb: 'Document reading (OCR)',
      lead: 'Photograph an invoice, bill of lading or customs declaration, or upload a scanned PDF, and we turn it into text and structured data. Review and correct the result, then copy, download or save it, or use it in a clearance request.'
    }
  });
})();
