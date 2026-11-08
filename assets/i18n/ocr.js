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
      lead: 'صوّر الفاتورة أو البوليصة أو البيان الجمركي أو ارفع ملف PDF ممسوحًا، وسنحوّله إلى نص وبيانات منظمة. راجع النتيجة وعدّلها، ثم انسخها أو نزّلها أو احفظها أو استخدمها في طلب تخليص.',
      // AI reading (Claude) — shown only online, to signed-in staff, when the org admin enabled it (20261114000100)
      engine_label: 'طريقة القراءة',
      engine_tesseract: 'القراءة داخل المتصفح (Tesseract) — لا يُرسل الملف إلى أي جهة',
      engine_ai: 'القراءة بالذكاء الاصطناعي (Claude) — أدق للمستندات الممسوحة والجداول',
      ai_note: 'عند اختيار القراءة بالذكاء الاصطناعي يُرسل الملف إلى خادم مرسى ثم إلى شركة Anthropic (مزوّد نموذج Claude) لمعالجته وإرجاع البيانات. لا تستخدمها لمستند لا يجوز مشاركته مع مزوّد خارجي. الحد: 10 ميغابايت للملف، وصيغ JPG وPNG وWEBP وGIF وPDF.',
      ai_remaining: 'المتبقي اليوم لمؤسستك: {n} قراءة.',
      ai_sending: 'إرسال المستند للقراءة بالذكاء الاصطناعي…',
      ai_reading: 'Claude يقرأ المستند…',
      ai_unsupported: 'هذه الصيغة غير مدعومة للقراءة بالذكاء الاصطناعي. استخدم JPG أو PNG أو WEBP أو GIF أو PDF، أو اختر القراءة داخل المتصفح.',
      ai_too_large: 'الملف أكبر من حد القراءة بالذكاء الاصطناعي: 5 ميغابايت للصورة و10 ميغابايت لملف PDF.',
      ai_badge: 'قراءة بالذكاء الاصطناعي (Claude)',
      ai_conf: 'متوسط ثقة Claude: {n}%',
      ai_src: 'Claude · {n}%',
      ai_warn_title: 'ملاحظات القراءة بالذكاء الاصطناعي',
      ai_cost: 'تكلفة تقديرية: {usd} دولار',
      ai_reextract_off: 'إعادة الاستخراج من النص غير متاحة لقراءة الذكاء الاصطناعي؛ عدّل الحقول مباشرة.',
      f_vessel: 'اسم السفينة', f_voyage: 'رقم الرحلة', f_port_of_loading: 'ميناء الشحن', f_port_of_discharge: 'ميناء التفريغ',
      f_shipper: 'الشاحن', f_consignee: 'المرسل إليه'
    },
    en: {
      title: 'Invoice and document reading (OCR)',
      crumb: 'Document reading (OCR)',
      lead: 'Photograph an invoice, bill of lading or customs declaration, or upload a scanned PDF, and we turn it into text and structured data. Review and correct the result, then copy, download or save it, or use it in a clearance request.',
      engine_label: 'Reading method',
      engine_tesseract: 'In-browser reading (Tesseract) — the file is not sent anywhere',
      engine_ai: 'AI reading (Claude) — more accurate for scans and tables',
      ai_note: 'With AI reading the file is sent to the Marsa server and then to Anthropic (the provider of the Claude model) for processing, and the data is returned. Do not use it for a document that may not be shared with an external provider. Limit: 10 MB per file; JPG, PNG, WEBP, GIF and PDF.',
      ai_remaining: 'Remaining today for your organization: {n} readings.',
      ai_sending: 'Sending the document for AI reading…',
      ai_reading: 'Claude is reading the document…',
      ai_unsupported: 'This file type is not supported for AI reading. Use JPG, PNG, WEBP, GIF or PDF, or choose in-browser reading.',
      ai_too_large: 'The file is over the AI reading limit: 5 MB for an image, 10 MB for a PDF.',
      ai_badge: 'AI reading (Claude)',
      ai_conf: 'Claude mean confidence: {n}%',
      ai_src: 'Claude · {n}%',
      ai_warn_title: 'AI reading notes',
      ai_cost: 'Estimated cost: {usd} USD',
      ai_reextract_off: 'Re-extracting from the text is not available for an AI reading; edit the fields directly.',
      f_vessel: 'Vessel', f_voyage: 'Voyage', f_port_of_loading: 'Port of loading', f_port_of_discharge: 'Port of discharge',
      f_shipper: 'Shipper', f_consignee: 'Consignee'
    }
  });
})();
