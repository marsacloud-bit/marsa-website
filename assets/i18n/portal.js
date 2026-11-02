/* ==========================================================================
   مرسى | MARSA — portal.html shell strings (namespace 'portal'), ar + en.
   Load order: config.js → i18n.js → assets/i18n/portal.js → assets/i18n/app.js → main.js
               → supa.js → app-shell.js → pwa.js → portal.js (defer).
   Only the title strings portal.js hands to MarsaShell.setTitle (document
   title / hero [data-shell-title]); the other keys are kept for later use.
   The portal content itself is still Arabic-only: portal.html has no
   <html data-i18n-page> (as in the original page), so i18n.js renders it in
   Arabic / RTL.
   ========================================================================== */
(function () {
  'use strict';
  if (!window.MarsaI18n || typeof window.MarsaI18n.register !== 'function') return;
  window.MarsaI18n.register('portal', {
    ar: {
      title: 'بوابة العميل',
      crumb: 'حسابي',
      envBadge: 'بيئة تجريبية (Staging)',
      lead: 'طلباتك ومعاملاتك في مكان واحد: المراحل التشغيلية، والحاويات وحالة إرجاعها، والمستندات الأصلية مع إمكانية رفع مستندات جديدة.',
      track: 'تتبع شحنة',
      newRequest: 'طلب جديد'
    },
    en: {
      title: 'Client portal',
      crumb: 'My account',
      envBadge: 'Test environment (staging)',
      lead: 'Your requests and transactions in one place: operational stages, containers and their return status, and original documents, with uploads of new ones.',
      track: 'Track a shipment',
      newRequest: 'New request'
    }
  });
})();
