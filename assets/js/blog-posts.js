/* =====================================================================
   Office website — blog articles (owner 2026-11-22, first stage)
   Plain data, newest first. Rendered with textContent only (no HTML).
   Later stage: articles written from the staff dashboard (database) —
   blog.js reads window.MarsaBlogPosts, so that source can replace this file.
   Block types: { h: 'heading' } · { p: 'paragraph' } · { ul: ['item', …] }
   Article content is data: each article carries its own ar / en text.
   ===================================================================== */
(function () {
  'use strict';
  window.MarsaBlogPosts = [
    {
      slug: 'one-percent-cf-cif',
      date: '2026-11-12',
      tag: { ar: 'الأنظمة', en: 'Rules' },
      title: { ar: 'متى تُضاف نسبة 1% إلى قيمة الفاتورة؟', en: 'When is 1% added to the invoice value?' },
      summary: {
        ar: 'الفرق بين C&F وCIF، ولماذا تختلف القيمة في البيان الجمركي عن الفاتورة أحيانًا.',
        en: 'C&F versus CIF, and why the value in the declaration sometimes differs from the invoice.'
      },
      body: {
        ar: [
          { p: 'يسأل كثير من المستوردين: لماذا تظهر قيمة الشحنة في البيان الجمركي أعلى قليلًا من قيمة الفاتورة؟ السبب غالبًا هو «شرط التسليم» المكتوب في الفاتورة التجارية.' },
          { h: 'ما معنى C&F وCIF؟' },
          { ul: [
            'CIF: قيمة البضاعة شاملة الشحن والتأمين حتى ميناء الوصول.',
            'C&F (وتُكتب أيضًا CFR): قيمة البضاعة شاملة الشحن، لكن بدون التأمين.'
          ] },
          { h: 'لماذا تُضاف 1%؟' },
          { p: 'الجمارك تحسب القيمة على أساس CIF. فإذا كانت الفاتورة C&F، يُضاف تقدير للتأمين بنسبة 1% من القيمة. أما إذا كانت الفاتورة CIF فلا يُضاف شيء، لأن التأمين داخل فيها.' },
          { h: 'مثال مبسّط' },
          { p: 'فاتورة C&F بقيمة 10,000 دولار، وسعر التحويل 3.75 ريال: القيمة بالريال = 10,000 × 3.75 × 1.01 = 37,875 ريالًا تقريبًا. ولو كانت الفاتورة نفسها CIF لكانت القيمة 37,500 ريال.' },
          { h: 'نصائح قبل الشحن' },
          { ul: [
            'تأكد أن شرط التسليم مكتوب بوضوح في الفاتورة التجارية.',
            'إذا اختلف الشرط بين الفاتورة والمستندات الأخرى، راجع المورّد قبل وصول الشحنة.',
            'قيمة الفاتورة هي الإجمالي قبل خصم أي دفعة مقدمة.'
          ] }
        ],
        en: [
          { p: 'Importers often ask why the value in the customs declaration is slightly higher than the invoice. The reason is usually the delivery term written on the commercial invoice.' },
          { h: 'What do C&F and CIF mean?' },
          { ul: [
            'CIF: goods value including freight and insurance to the port of arrival.',
            'C&F (also written CFR): goods value including freight, without insurance.'
          ] },
          { h: 'Why add 1%?' },
          { p: 'Customs works on a CIF basis. When the invoice is C&F, an insurance estimate of 1% of the value is added. When the invoice is CIF, nothing is added because insurance is already included.' },
          { h: 'A simple example' },
          { p: 'A C&F invoice of USD 10,000 at 3.75 riyals per dollar: value in SAR = 10,000 × 3.75 × 1.01 ≈ 37,875. The same invoice on CIF terms would be 37,500.' },
          { h: 'Before you ship' },
          { ul: [
            'Make sure the delivery term is clearly written on the commercial invoice.',
            'If the term differs between documents, check with the supplier before arrival.',
            'The invoice value is the total before any advance payment is deducted.'
          ] }
        ]
      }
    },
    {
      slug: 'container-clearance-documents',
      date: '2026-11-03',
      tag: { ar: 'المستندات', en: 'Documents' },
      title: { ar: 'المستندات المطلوبة لتخليص حاوية', en: 'Documents needed to clear a container' },
      summary: {
        ar: 'قائمة مختصرة تجهّزها قبل وصول الشحنة، حتى لا تتأخر في الميناء.',
        en: 'A short list to prepare before your shipment arrives, so it is not held at the port.'
      },
      body: {
        ar: [
          { p: 'أكثر أسباب تأخر الحاويات في الميناء نقص مستند أو اختلاف بين مستندين. تجهيز المستندات قبل وصول الباخرة يوفر وقتًا ومالًا.' },
          { h: 'المستندات الأساسية' },
          { ul: [
            'بوليصة الشحن (B/L): هي المرجع لرقم البوليصة وأرقام الحاويات واسم الباخرة.',
            'الفاتورة التجارية: فيها قيمة البضاعة وشرط التسليم ووصف الأصناف.',
            'بيان التعبئة (Packing List): فيه عدد الطرود والأوزان لكل صنف.',
            'شهادة المنشأ: تُطلب في حالات كثيرة، وقد تفيد في الإعفاءات وفق الاتفاقيات التجارية.'
          ] },
          { h: 'مستندات قد تُطلب حسب البضاعة' },
          { ul: [
            'شهادة المطابقة عبر منصة سابر للمنتجات الخاضعة للوائح الفنية.',
            'موافقات الجهات المختصة لبعض السلع (مثل الغذاء والدواء).'
          ] },
          { h: 'بيانات المستورد' },
          { p: 'تأكد أن بيانات منشأتك (السجل التجاري والرقم الضريبي والتسجيل في فسح) محدّثة، وأن اسم المستورد في البوليصة يطابق اسم المنشأة.' },
          { h: 'نصيحة' },
          { p: 'قارن أرقام الحاويات والأوزان وعدد الطرود بين البوليصة والفاتورة وبيان التعبئة. أي اختلاف بينها يُكتشف مبكرًا أسهل من اكتشافه في الميناء.' }
        ],
        en: [
          { p: 'Most container delays at the port come from a missing document or a mismatch between two documents. Preparing them before the vessel arrives saves time and money.' },
          { h: 'Core documents' },
          { ul: [
            'Bill of lading (B/L): the reference for the B/L number, container numbers and vessel.',
            'Commercial invoice: goods value, delivery term and item descriptions.',
            'Packing list: number of packages and weights per item.',
            'Certificate of origin: often required, and may help with trade-agreement exemptions.'
          ] },
          { h: 'Documents that depend on the goods' },
          { ul: [
            'A SABER conformity certificate for products under technical regulations.',
            'Approvals from the competent authorities for some goods (such as food and medicine).'
          ] },
          { h: 'Importer details' },
          { p: 'Make sure your company details (commercial registration, VAT number and FASAH registration) are up to date, and that the importer name on the B/L matches your company name.' },
          { h: 'Tip' },
          { p: 'Compare container numbers, weights and package counts across the B/L, invoice and packing list. A mismatch found early is easier to fix than one found at the port.' }
        ]
      }
    },
    {
      slug: 'avoid-container-detention',
      date: '2026-10-21',
      tag: { ar: 'نصائح', en: 'Tips' },
      title: { ar: 'كيف تتجنب رسوم تأخير الحاوية', en: 'How to avoid container delay charges' },
      summary: {
        ar: 'الفرق بين رسوم الأرضيات ورسوم تأخير إرجاع الحاوية، وما يجب متابعته بعد خروجها.',
        en: 'Port storage versus late container return, and what to follow after gate-out.'
      },
      body: {
        ar: [
          { p: 'بعد الإفراج عن الشحنة قد تظهر رسوم لم تكن في الحسبان. أغلبها يأتي من التأخير: إما في إخراج الحاوية من الميناء، أو في إرجاعها فارغة إلى الخط الملاحي.' },
          { h: 'نوعان من الرسوم' },
          { ul: [
            'رسوم الأرضيات: تُحسب على بقاء الحاوية في الميناء بعد انتهاء المدة المجانية.',
            'رسوم تأخير الإرجاع: يفرضها الخط الملاحي إذا لم تُرجع الحاوية الفارغة في موعدها.'
          ] },
          { h: 'كيف تتجنبها؟' },
          { ul: [
            'جهّز المستندات قبل وصول الباخرة، حتى يبدأ التخليص فور التفريغ.',
            'اعرف عدد الأيام المجانية من الخط الملاحي قبل الشحن، فهي تختلف من خط لآخر.',
            'سجّل موعد إرجاع الحاوية الفارغة فور خروجها من الميناء، وتابعه حتى يتم الإرجاع.',
            'احتفظ بإثبات إرجاع الحاوية، فقد تحتاجه عند أي خلاف على الرسوم.'
          ] },
          { h: 'كيف نساعدك؟' },
          { p: 'نسجّل موعد إرجاع كل حاوية عندنا، ونرسل تنبيهًا يتصاعد مع اقتراب الموعد حتى يُسجّل الإرجاع.' }
        ],
        en: [
          { p: 'After release, unexpected charges can appear. Most come from delay: either in taking the container out of the port, or in returning it empty to the shipping line.' },
          { h: 'Two kinds of charges' },
          { ul: [
            'Port storage: charged when the container stays at the port after the free period.',
            'Late return (detention): charged by the shipping line when the empty container is returned late.'
          ] },
          { h: 'How to avoid them' },
          { ul: [
            'Prepare documents before the vessel arrives, so clearance starts right after discharge.',
            'Know the shipping line’s free days before you ship; they differ between lines.',
            'Record the empty-return deadline as soon as the container leaves the port, and follow it up.',
            'Keep the proof of return in case of any dispute over charges.'
          ] },
          { h: 'How we help' },
          { p: 'We record the return deadline of every container and send an escalating reminder as the date approaches, until the return is recorded.' }
        ]
      }
    }
  ];
})();
