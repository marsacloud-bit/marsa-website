/* =====================================================================
   Page dictionary: consult.html (owner 2026-11-22). Keys: 'consult.<key>'.
   The Arabic markup stays the default; 'ar' mirrors it so t() works too.
   ===================================================================== */
(function () {
  'use strict';
  var I = window.MarsaI18n;
  if (!I) return;
  I.register('consult', {
    ar: {
      doc_title: 'استشارات جمركية',
      eyebrow: 'استشارات جمركية',
      title: 'تحتاج رأيًا قبل أن تشحن؟',
      lead: 'اكتب سؤالك عن البند الجمركي أو الرسوم أو المستندات المطلوبة، ويرد عليك مختص من مكتبنا.',
      form_title: 'طلب استشارة',
      note_demo: 'نسخة عرض تجريبية: يُحفظ الطلب على جهازك فقط ولا يُرسل.',
      note_online: 'يصل طلبك إلى فريق المكتب، ويتواصل معك بالطريقة التي تختارها.',
      f_name: 'الاسم', f_company: 'الشركة (اختياري)', f_phone: 'رقم الجوال', f_email: 'البريد الإلكتروني',
      f_topic: 'موضوع الاستشارة', f_ref: 'رقم البوليصة أو المعاملة (اختياري)',
      f_message: 'سؤالك', f_message_ph: 'مثال: أستورد قطع غيار سيارات من الصين، ما البند الجمركي ونسبة الرسوم؟',
      f_preferred: 'كيف نتواصل معك؟', p_phone: 'مكالمة', p_whatsapp: 'واتساب', p_email: 'بريد إلكتروني',
      f_consent: 'أوافق على تواصل المكتب معي بخصوص هذا الطلب.',
      t_choose: 'اختر الموضوع', t_hs: 'تصنيف البضاعة والبند الجمركي', t_duties: 'الرسوم الجمركية والضريبة',
      t_aci: 'البيان الجمركي ومنصة فسح', t_saber: 'شهادات المطابقة (سابر)', t_export: 'التصدير', t_other: 'موضوع آخر',
      e_name: 'اكتب اسمك (3 أحرف على الأقل).', e_phone: 'اكتب رقم جوال سعودي صحيحًا، مثل 0551234567.',
      e_email: 'اكتب بريدًا إلكترونيًا صحيحًا.', e_topic: 'اختر موضوع الاستشارة.',
      e_message: 'اكتب سؤالك (15 حرفًا على الأقل).', e_consent: 'الموافقة مطلوبة لنتواصل معك.',
      submit: 'أرسل الطلب',
      check_fields: 'من فضلك راجع الحقول المظللة باللون الأحمر',
      send_failed: 'لم يُرسل الطلب. بياناتك ما زالت في النموذج.',
      msg_prefix: '[استشارة جمركية]',
      ok_online: 'وصلنا طلبك', ok_demo: 'حُفظ طلبك على جهازك',
      ok_ref: 'احتفظ بالرقم المرجعي لذكره عند المتابعة:', ok_new: 'طلب استشارة أخرى',
      side_title: 'نستشار عادة في',
      side1: 'البند الجمركي المناسب لبضاعتك', side2: 'تقدير الرسوم والضريبة قبل الشحن',
      side3: 'المستندات والشهادات المطلوبة', side4: 'الفرق بين C&F وCIF وأثره على القيمة',
      side5: 'متطلبات التصدير والعبور',
      how_title: 'ماذا يحدث بعد الإرسال؟',
      how1: 'يصل طلبك إلى فريق المكتب برقم مرجعي.',
      how2: 'يراجعه مختص، وقد يطلب منك صورة الفاتورة أو البوليصة.',
      how3: 'يتواصل معك بالطريقة التي اخترتها.',
      disclaimer: 'الاستشارة للاسترشاد، والقرار النهائي في البند والرسوم لهيئة الزكاة والضريبة والجمارك.'
    },
    en: {
      doc_title: 'Customs advice',
      eyebrow: 'Customs advice',
      title: 'Need advice before you ship?',
      lead: 'Ask about tariff codes, duties or the documents you need, and a specialist from our office will reply.',
      form_title: 'Request advice',
      note_demo: 'Demo version: the request is saved on this device only and not sent.',
      note_online: 'Your request reaches our team, who will contact you the way you choose.',
      f_name: 'Name', f_company: 'Company (optional)', f_phone: 'Mobile number', f_email: 'E-mail',
      f_topic: 'Topic', f_ref: 'B/L or transaction number (optional)',
      f_message: 'Your question', f_message_ph: 'Example: I import car parts from China — what is the tariff code and duty rate?',
      f_preferred: 'How should we contact you?', p_phone: 'Call', p_whatsapp: 'WhatsApp', p_email: 'E-mail',
      f_consent: 'I agree to be contacted about this request.',
      t_choose: 'Choose a topic', t_hs: 'Goods classification and tariff code', t_duties: 'Customs duties and VAT',
      t_aci: 'Customs declaration and FASAH', t_saber: 'Conformity certificates (SABER)', t_export: 'Export', t_other: 'Other',
      e_name: 'Enter your name (at least 3 letters).', e_phone: 'Enter a valid Saudi mobile number, e.g. 0551234567.',
      e_email: 'Enter a valid e-mail address.', e_topic: 'Choose a topic.',
      e_message: 'Write your question (at least 15 characters).', e_consent: 'Consent is required so we can contact you.',
      submit: 'Send request',
      check_fields: 'Please check the fields marked in red',
      send_failed: 'The request was not sent. Your details are still in the form.',
      msg_prefix: '[Customs advice]',
      ok_online: 'We received your request', ok_demo: 'Your request was saved on this device',
      ok_ref: 'Keep this reference number for follow-up:', ok_new: 'Another request',
      side_title: 'People usually ask us about',
      side1: 'The right tariff code for your goods', side2: 'Estimating duties and VAT before shipping',
      side3: 'Required documents and certificates', side4: 'C&F versus CIF and how it changes the value',
      side5: 'Export and transit requirements',
      how_title: 'What happens next?',
      how1: 'Your request reaches our team with a reference number.',
      how2: 'A specialist reviews it and may ask for the invoice or B/L.',
      how3: 'We contact you the way you chose.',
      disclaimer: 'Advice is for guidance; the final decision on tariff codes and duties rests with ZATCA.'
    }
  });
  function title() { document.title = I.t('consult.doc_title'); }
  title();
  window.addEventListener('marsa:langchange', title);
})();
