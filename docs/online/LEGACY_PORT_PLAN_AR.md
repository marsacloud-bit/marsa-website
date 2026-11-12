# خطة نقل وظائف النظام القديم (DocumentAI / Apps Script) إلى مرسى

المصدر: `DocumentAI.tar` (24 ملف، ~40 ألف سطر: Apps Script + Google Sheets + Gemini + دفترة). الجرد آلي بـ 10 قرّاء على كل الملفات ومقارنة بكود مرسى.

## الخلاصة

جرى دمج 9 جرود لميزات النظام القديم (Apps Script + Google Sheets + Gemini + دفترة) في 8 وحدات وحوالي 85 ميزة، مع التحقق المباشر في مرسى بالبحث عن: packing_list، payment_proof، custody، chassis، cargo_unit، hijri، TASTO، CustomModel، re_export، hs_reference، funding_source، purchase_invoice، signInWithOtp. أيّد البحث النتائج: لا توجد أي من هذه في migrations ولا في functions. الاستثناء الوحيد أن packing_list موجود كنوع مستند في الجداول فقط، لا في ai-extract.

**موجود في مرسى:** الحاويات المتعددة، سجل المستندات والتخزين، إعدادات الذكاء الاصطناعي وحصصه، اختبار ربط دفترة وحماية الطلبات، طابور المهام والأقفال، التقارير الأساسية والتصدير، المصادقة والتدقيق بالمشغلات.

**جزئي (الجداول والدوال موجودة لكن لا تُملأ آليًا):**
- المعاملة: حقول ناقصة.
- البيان: بلا هجري، وبلا مراحل فسح، ولا يُنشأ من القراءة.
- المواعيد والنقل: لا يوجد نموذج موحد.
- السدادات: موجودة، لكن بلا مصدر تمويل ولا توزيع مشترك ولا حالة مراجعة.
- مطابقة العميل: غير موصولة بالقراءة الآلية.
- مسودة دفترة: تحتاج رسومًا معتمدة أولًا.

**مفقود بالكامل:**
- اعتماد حزمة مستندات الشحنة ونقلها للمعاملة (أكبر فجوة).
- نوع بيان التعبئة.
- جداول بيانات فسح وأصناف الفاتورة والتعبئة.
- ورقة إدخال فسح.
- مرجع البنود HS.
- قراءة بطاقات المواعيد ومسوداتها.
- قراءة إثبات الفارغ وقراءة إثبات السداد.
- أمر النقل TASTO.
- Ro-Ro وإعادة التصدير.
- عهدة العملاء.
- المطابقة الشهرية مع فسح.
- حقول CustomModel في دفترة.
- استيراد عملاء دفترة جماعيًا.
- أكواد منتجات دفترة القائمة.
- مطابقة الفواتير القديمة.
- فلاتر الأعمدة وتنبيهات تقادم الحالة.

**ترتيب البناء:** نموذج البيانات، ثم نموذج المعاملة ودورة الحياة، ثم المستندات والذكاء الاصطناعي، ثم البيان وHS وورقة فسح، ثم المواعيد والفارغ، ثم السدادات والعهدة، ثم دفترة، ثم التقارير، وأخيرًا ترحيل البيانات.

**قرارات مطلوبة من المالك:**
- هل يمنع غياب إثبات الفارغ الانتقال إلى الفوترة؟
- هل يُعتمد إثبات الفارغ آليًا من القراءة؟
- هل يسمح مسار TASTO بتجاوز شرط الإعادة؟
- هل يُسمح بتعديل مسودات دفترة القائمة (HF5)؟
- يجب تحويل حساب دفترة من مصر إلى السعودية قبل أي مسودة حية.

لم يُنسخ أي سر ولم يُعدَّل أي ملف. لم يُعثر في المصدر على تعليمات موجهة للوكيل.


## قرارات المالك (2026-11-10)

- الفوترة بدون إثبات إعادة الفارغ: **ممنوعة** (يبقى سلوك مرسى الحالي).
- إثبات الفارغ المقروء بـ Claude: **لا يُعتمد آليًا**؛ موظف يؤكده.
- تعديل مسودات دفترة القائمة: **غير مسموح**؛ مسودات جديدة فقط.
- ترتيب البناء: **الترتيب الكامل** من المرحلة 1 إلى 9.
- (2026-11-11) أمر النقل لشركة نقل (TASTO): **لا يتجاوز** شرط إثبات إعادة الفارغ؛ تبقى المعاملة محتاجة إلى إثباتات إعادة معتمدة من موظف (إيصال EIR من شركة النقل) قبل «تحت الفوترة». سياسة empty_return_blocks_billing = true للقراءة فقط في المرحلة 5 (لا يغيّرها المستأجر). نُفّذ في 20261121000100_legacy_appt.sql (docs/online/LEGACY_APPT_AR.md).

- (2026-11-11) المرحلة 6 (السدادات والعهدة): قراءة مستندات السداد بـ Claude **لا تعتمد شيئًا** وتملأ الحقول الفارغة فقط؛ المراجعة بأربع أعين (المعتمد ليس المنشئ، ولا استثناء للمدير)؛ لا تعديل لمسودات دفترة ولا إرسال إليها (المرحلة 7)؛ إلغاء إيداع عهدة يجعل الرصيد سالبًا **مرفوض** (إصلاح خطأ النظام القديم)؛ أرصدة المحافظ مرحلة لاحقة. نُفّذ في 20261122000100_legacy_pay.sql (docs/online/LEGACY_PAY_AR.md).
- (2026-11-11) المرحلة 7 (مواءمة دفترة): **لا تعديل** لأي مسودة / فاتورة دفترة قائمة (`allow_draft_update = false`؛ كل تغيير لاحق بند `manual_in_daftra` يُنفذ يدويًا، والعلم للمالك فقط ومدقق وبلا واجهة)؛ الأصناف تُحل بكودها دون الأصفار البادئة **ولا تُنشأ**؛ **حارس الحساب السعودي** (الريال، السعودية، ضريبة 15 %) قبل أي كتابة لأن الحساب مضبوط على مصر (`account_not_ksa`)؛ المسودة الافتتاحية عند اعتماد البيان ومسودات المشتريات للنقلات إعدادان **مطفآن افتراضيًا**؛ تاريخ الفاتورة اليوم بتوقيت الرياض. نُفّذ في 20261123000100_legacy_daftra.sql (docs/online/LEGACY_DAFTRA_AR.md، قسم «عقد المهام» للعامل). مراجعة المرحلة 7: الإعدادان يُغيَّران من المالك فقط بسبب مكتوب، ويُعاد فحصهما (مع حالة الرحلة) عند إعادة المحاولة واستلام المهمة؛ ويُعاد قراءة الحساب قبل أول كتابة؛ وربط مورد دفترة باسم الجهة فقط مع فك ربط مدقق (LEGACY_DAFTRA_AR.md §10).
- (2026-11-11) قرارات افتراضية للمرحلة 7 اتخذها المنفّذ أثناء غياب المالك (الخيار الأأمن، قابلة للمراجعة): (1) إعداد المسودة الافتتاحية ومسودات المشتريات للمالك وحده؛ (2) محرر الحقول الإضافية لمدير الحسابات كما يسمح الخادم، واختبار الحقول للمالك؛ (3) عند الإصدار: إن طابق إجمالي دفترة مجموع المتزامن + الإضافات اليدوية المدرجة تُعدّ الإضافات مفوترة، وإلا بند مراجعة `issued_mismatch`؛ (4) مسودة مشتريات «ربما طُبّقت» تبقى متوقفة (`reference_lookup_incomplete`) ولا يوجد إجراء «تأكدتُ أنها غير موجودة» — يُبنى إن طلبه المالك؛ (5) ضريبة لا يذكر دفترة حالتها تُعدّ فعّالة (البديل يمنع الكتابة دائمًا على حسابات لا تُرجع العلم)؛ (6) وصف سطر المشتريات كما في النظام القديم (العميل، السائق، رقم الموعد)؛ (7) التطابقات الجزئية للاطلاع فقط (حد 3) ولا تُربط؛ (8) فك ربط المورد لـ bill_admin فقط.
- (2026-11-11) قرارات افتراضية للمرحلة 8 (التقارير ولوحات المتابعة والتنبيهات) اتخذها المنفّذ أثناء غياب المالك (الخيار الأأمن، قابلة للمراجعة): (1) قواعد التأخير بحالات مرسى: «نشطة» القديمة = قيد العمل / البيان الجمركي / الموعد / إعادة الفارغ (48/96 ساعة)، النقل 24/48، المنتهية تشغيليًا 24/48، تحت الفوترة 48/96، الجديدة 24/48، ولا قاعدة لتمت الفوترة / مغلقة؛ آخر نشاط = آخر تحديث للمعاملة؛ (2) «الحالة الفعلية من دفترة»: فاتورة صادرة غير مُبلغ عن إلغائها فقط ⇐ تمت الفوترة (بلا تنبيه تأخير)، أما مسودة دفترة فلا تنقل المعاملة إلى «تحت الفوترة» لأن المسودة الافتتاحية قد توجد منذ اعتماد البيان؛ (3) تأخر إعادة الفارغ يبدأ من اليوم التالي لآخر موعد (تاريخ بتقويم الرياض) كتنبيهات مرسى وتقرير الحاويات، وهو حرج دائمًا وغير قابل للتعديل؛ (4) تعديل قواعد التأخير ومفتاح الدخول بالرمز للمالك وحده (مدير نظام على مستوى المؤسسة بجلسة aal2) مع سبب مكتوب، ويُحفظان في إعدادات المؤسسة ويُدققان؛ (5) عمود حالة دفترة وفلتر «مسودات دفترة فقط» لقرّاء المالية في فرع المعاملة فقط، وقيمة النقل وعائد المؤسسة لأدوار مالية النقل، وكشف السدادات لقرّاء المالية، ولا يرى العميل شيئًا جديدًا؛ (6) المطابقة الشهرية مع فسح: الملفات تُقرأ في المتصفح ولا يُرسل للخادم إلا أرقام البيانات (حتى 20000) ونطاقات المنفذ/الشهر (حتى 100)، للقراءة فقط؛ (7) وصف العمليات في سجل التدقيق يُشتق عند القراءة (الجدول والحقول المتغيرة وحدث المعاملة في نفس العملية) دون إعادة إنشاء أي دالة تشغيلية ودون جدول جديد؛ (8) الدخول برمز عبر البريد: مطفأ افتراضيًا على مستويين (مفتاح المنصة في إعداد الموقع + مفتاح المؤسسة)، shouldCreateUser:false، رسالة موحدة لا تكشف وجود الحساب، حدود Supabase للانتظار والمحاولات، وفحص otp_session_check بعد الدخول، والمصادقة الثنائية كما هي (جلسة الرمز aal1 فيلزم TOTP لصلاحيات المدير)، ومستخدم البوابة وحده لا يُسمح له، ومن ينتمي لعدة مؤسسات يلزم تفعيلها في جميعها؛ (9) قوائم قيم فلاتر الأعمدة تُحسب في المتصفح من الصفوف المحمّلة، والخادم يوفر الفلاتر الرئيسية كمصفوفات. نُفّذ في 20261124000100_legacy_reports.sql (docs/online/LEGACY_REPORTS_AR.md).
- (2026-11-11) قرارات افتراضية لواجهة المرحلة 8 اتخذها المنفّذ أثناء غياب المالك (الخيار الأأمن، قابلة للمراجعة): (1) «سجل المعاملات والمتابعة» شاشة جديدة #register، وتبقى قائمة #transactions كما هي، وروابط البطاقات المفلترة (#transactions?status= / ?stage= / ?daftra_state= / ?attention=) تُفتح في السجل؛ (2) فلاتر الأعمدة تعمل على الصفحة المحمّلة (200 صف في السجل، 100 في التقارير)، والتصدير يأخذ نفس الصفوف المعروضة، وعندها يُستبدل صف الإجماليات بعدد الصفوف لأن إجماليات الخادم لا تصف الملف؛ (3) عمود «فاتورة دفترة» في كشف المتابعة لقرّاء المالية فقط (13 عمودًا لغيرهم)، وقيمة النقل وعائد المؤسسة في تقرير الحركة لأدوار مالية النقل فقط (17 عمودًا لغيرهم)؛ (4) زر «إلغاء» في شاشة التقدم للعمليات القراءية فقط (السجل، المطابقة)، والتصدير لا يُلغى لأن تسجيله يسبق الملف؛ مؤشر زمن الاستجابة مطفأ افتراضيًا ويُشغَّل لكل جهاز على حدة؛ (5) الدخول بالرمز: مفتاح المنصة MARSA_CONFIG.emailOtpLogin غائب = مطفأ، وكل صفحات التطبيق (app-shell.js) وصفحة الدخول تفحص جلسة الرمز قبل أي شيء وتخرج منها إن لم يسمح بها مفتاح المنصة أو otp_session_check، والفحص يُغلق عند الخطأ (fail closed)، فلا تنفع جلسة رمز أُنشئت مباشرة على Supabase؛ (6) المطابقة مع فسح: حتى 50000 صف لكل ملف و20000 سجل في الدفعة، والمعاملة الملغاة تطابق رقمها لكنها لا تُعدّ «في النظام فقط»، والنتيجة لا تُحفظ في أي مكان؛ (7) سجل العمليات على المعاملة يُحمَّل عند الطلب لمدير النظام والمشرف في فرع المعاملة.
- (2026-11-11) قرارات افتراضية لمراجعة المرحلة 8 اتخذها المنفّذ أثناء غياب المالك (الخيار الأأمن، قابلة للمراجعة): (1) **الدخول برمز:** المفتاحان (المنصة والمؤسسة) سياسة لنموذج الدخول في الموقع، لا حدّ أمان في RLS؛ لأن جلسة رابط البريد (الاستعادة / التأكيد / الدعوة) تحمل `amr = otp` نفسها في التدفق الضمني، ولأن من يملك البريد يستعيد كلمة المرور أصلًا. حد الأمان هو aal2 للأدوار المحمية. `otpGate()` يفحص فقط الجلسة التي فتحها نموذج الرمز (مُعلَّمة بـ `session_id`)، ولا يُخرج جلسات روابط البريد. لم نغيّر التدفق إلى PKCE لأنه يربط رابط الاستعادة بالمتصفح نفسه؛ (2) الحاوية التي سُجّل لها تاريخ إعادة فعلي تُعدّ «أُعيدت» ولا تُعدّ متأخرة في تقرير المواعيد والنقل ولا في أسباب المتابعة، كما في النظام القديم. تنبيه `empty_return_overdue` في التنبيهات التشغيلية (G3) بقي كما هو؛ (3) ملف «كشف السدادات» على أعمدة النظام القديم الـ 15، مع أعمدة مرسى الإضافية (المعاملات، نوع الحركة، المطلوب، الفرق، العملة، الحالة)؛ (4) ورقة «في النظام فقط» في ملف Excel المطابقة تُحسب في `row_count` المدقَّق وفي حد الصفوف، ويُسجَّل عددها في `system_only`؛ (5) ملف فسح المرفوع: حتى 64 م.ب بعد فك الضغط، و50011 صفًا، و256 عمودًا، ويُقرأ ملفًا بعد ملف؛ (6) فهرس جزئي واحد جديد `audit_log_tx_child_idx` لسجل العمليات على المعاملة. يُبنى عند اللصق، ويقفل الكتابة في `audit_log` مدة البناء؛ (7) بند «إرجاع البيانات المحدثة مع كل حفظ»: الكتابات الجديدة في المرحلة 8 (`set_status_aging_rules` و`set_email_otp_login`) ترجع الحالة المحدّثة كاملة، والشاشة ترسمها دون إعادة طلب. تعديل دوال الكتابة في المراحل السابقة لترجع القوائم والإحصاءات مؤجَّل، فالشاشات تعيد الطلب بعد الحفظ والنتيجة صحيحة؛ (8) القاعدة الموقوفة (`null`) تُعرض «موقوفة»، ويستطيع المالك إيقاف أي قاعدة أو إعادتها.
- (2026-11-11) فحص المرحلة 8 في المتصفح (مكتمل): (1) تصدير «المواعيد والنقل» يستبعد الحركات الملغاة من مقارنة المبالغ كما يفعل الخادم؛ (2) سجل العمليات لا يعرض معرّفات الصفوف (UUID) ولا حقول الربط (transaction_id وغيرها)، وتغيير مرجع بين صفين يظهر «تغيّر» فقط؛ حقول طلب الفوترة وحالاته بالعربية؛ (3) ملف فسح يتجاوز حد فك الضغط أو الأعمدة يظهر له سبب واضح بدل «أكبر من 10 م.ب» / «تعذّرت القراءة»؛ (4) جدول السجل لا يوسّع الصفحة على الموبايل (نصوص قارئ الشاشة داخل حاوية التمرير).
- (2026-11-12) فحص المرحلة 9 في المتصفح (مكتمل، على الكمبيوتر و375px): قراءة الملفات ورفض الصيغ والملفات التالفة، الاكتشاف والربط والمعاينة، الرفع والفحص، الترحيل على دفعات، خطوة فواتير RHK- (منها مرشح بالمرجع فقط)، منع الإلغاء عند تعديل سجل، الإلغاء على دفعات واستكماله، وبوابة التحقق الثنائي. إصلاحات: (1) أسماء الملفات في بطاقة الدفعة لا تنقلب في الاتجاه العربي؛ (2) صيغ الأعداد بالعربية صارت «العدد: n» بدل «3 صفًا»؛ (3) زر الإغلاق في نافذة إلغاء الدفعة صار «رجوع» حتى لا يلتبس بـ«ألغِ الدفعة». ويبقى «جدة»/«الدمام» وحدهما يحتاجان ربطًا يدويًا للمنفذ (حد موثّق).
- (2026-11-12) نُشرت المراحل 1–9 على المشروع الحقيقي (cgzhidyxfpksfckwmauq): نسخة Supabase الاحتياطية اليومية موجودة (12 Nov 03:10 UTC)؛ طُبّقت التحديثات 20261115000100 → 20261125000100 بالترتيب وكلها مسجلة في schema_versions؛ نُشرت ai-extract و daftra-sync (حزمة ملف واحد)؛ نُسخ public_html إلى backup_public_html_20261112_pre_legacy_port ثم رُفع 162 ملفًا (sw.js 2026-11-25.2) دون لمس .htaccess و robots.txt. لم يُنفَّذ convert_org_to_production (التحويل للإنتاج قرار منفصل للمالك).
- (2026-11-12) التحويل للإنتاج في المكان (بطلب المالك؛ الاسم مؤقت ويتغير لاحقًا): الاسم المختصر marsa، والاسم «مؤسسة البحر الأزرق» / Blue Sea Est. المعاينة بلا موانع ولا تحذيرات ولا مستندات دفترة. أُوقفت الجدولة (inbox_sync و refresh_alerts) ثم نُفّذ convert_org_to_production (حُذف 12657 صفًا تجريبيًا، وبقيت عضوية المالك وحده). رُفع موقع الإنتاج من build-release --in-place بالكتابة فوق الملفات بعد نسخة backup_public_html_20261112_pre_prod (حذف المجلد مُنع). التخزين فارغ، ولا حسابات اختبار، وأسرار الاختبار غير موجودة أصلًا، وفحوص post_install بلا موانع بعد إعادة الجدولة. عناوين الدخول صحيحة، وقوالب البريد بلا صياغة تجريبية. بعد الفحص في المتصفح أُخفيت أو عُدّلت عبارات «نسخة عرض تجريبية» الظاهرة في الصفحات العامة ووصفها (sw.js 2026-11-25.3)، وأُضيفت إلى فحص build-release. ملف assets/js/config.js في المستودع يبقى للتجريبي لأن الاختبارات تعتمد عليه؛ النشر للإنتاج من build-release فقط.
- (2026-11-11) قرارات افتراضية للمرحلة 9 (استيراد بيانات النظام القديم) اتخذها المنفّذ أثناء غياب المالك (الخيار الأأمن، قابلة للمراجعة): (1) الاستيراد للمالك وحده (مدير نظام على مستوى المؤسسة بجلسة aal2) بسبب مكتوب، ودفعة مفتوحة واحدة لكل مؤسسة؛ (2) لا يُعتمد شيء: الأسماء البديلة «مقترحة»، السدادات «بانتظار المراجعة» (أربع أعين)، `return_status` يبقى `pending` وتاريخ إعادة الفارغ القديم يُحفظ بيانات فقط، ولا طلبات فوترة ولا مسودات دفترة، ودورة الحالة الآلية موقوفة أثناء الكتابة؛ (3) «تمت الفوترة» ← `billed` + `invoiced` لأنها مفوترة تاريخيًا في دفترة ولا يفوتر مرسى شيئًا (لا يلزمها إثبات)، و«تحت الفوترة» لمعاملة حاويات ← `operationally_complete` فتمر ببوابة إثبات الفارغ كالمعتاد (Ro-Ro ← `under_billing`)، و«نشطة» ← `customs_declaration` مع بيان وإلا `in_progress`، وغير المعروفة ← «جديدة» بتنبيه؛ (4) خانة تحقق ISO 6346 الخاطئة تنبيه لا خطأ، وصيغة الحاوية غير ISO خطأ، ورقم البوليصة مطلوب؛ (5) السداد المشترك لا يُستورد، و«غير محدد» في مصدر التمويل يحتاج مصدرًا افتراضيًا للدفعة، والطريقة غير المحددة تُستنتج من المرجع الوحيد (الإيصال وحده ← «أخرى») ومراجع الطرق الأخرى تُنقل للملاحظات، والجهة المصدرة غير الموجودة تُضاف «موردًا»؛ (6) العهدة رصيد افتتاحي واحد لكل عميل = مجموع حركاته النشطة، بتاريخ اليوم ومرجعه رقم الدفعة، والسالب مرفوض؛ (7) تاريخ الإنشاء القديم يُحفظ ويُحسب في عداد استخدام شهره؛ (8) المعاملات المستوردة «تمت الفوترة / مغلقة» لا تولّد متابعة ولا تنبيهات؛ (9) بادئة فواتير دفترة القديمة إعداد للدفعة (افتراضيًا RHK-)، وخطوة الربط تضع مهام قراءة فقط (بحث برقم الفاتورة + المسح القديم) والربط بتأكيد موظف؛ (10) الإلغاء void-only: يُرفض إن تغيّر أو استُخدم شيء مما أنشأته الدفعة، وعند النجاح يُوقف العملاء ويُحرَّر كود دفترة والرقم الضريبي والسجل لإعادة الاستيراد المصحّح. نُفّذ في 20261125000100_legacy_import.sql (docs/online/LEGACY_IMPORT_AR.md).
- (2026-11-11) قرارات افتراضية لواجهة المرحلة 9 (شاشة الاستيراد #legacy_import) اتخذها المنفّذ أثناء غياب المالك (الخيار الأأمن، قابلة للمراجعة): (1) الرابط والشاشة للمالك وحده (مدير بلا فرع)، ومدير الفرع يرى «للمالك فقط» دون أي استدعاء؛ (2) الملفات تُقرأ في المتصفح فقط ولا تُخزَّن (ذاكرة التبويب حتى الرفع)، بحدود 20 ملفًا × 10 م.ب، 64 م.ب بعد فك الضغط، 50000 صف، 256 عمودًا؛ (3) الصف الذي فيه قيمة أطول من 2000 حرف أو حجمه أكثر من 16 ك.ب لا يُرسل ولا يُقتطع، ويظهر في تقرير الأخطاء «رُفض في المتصفح»؛ (4) الورقة غير المكتشفة تُتجاهل حتى يختار المالك نوعها، والورقة الناقصة عمودًا مطلوبًا تمنع الرفع؛ (5) اسم الورقة المرسل «الورقة @ الملف» (فريد في الدفعة) حتى لا تستبدل ورقتان بالاسم نفسه صفوف بعضهما؛ (6) الفحص يبدأ تلقائيًا بعد الرفع (تجريبي)، والترحيل لا يبدأ إلا بتأكيد صريح بعد عرض قواعد الأمان؛ (7) عند انتهاء المهلة يُعاد الاستدعاء تلقائيًا بنصف الحجم حتى 6 مرات، و«إلغاء» شاشة التقدم يوقف بعد الدفعة الجارية، و«تابع الترحيل» يكمل؛ (8) خطوة RHK- تفتح المعاملة لشاشة التأكيد المعتادة من المرحلة 7 ولا تربط شيئًا من شاشة الاستيراد؛ (9) الإلغاء يبدأ بتشغيل تجريبي ويعرض الموانع بدل إرسال الإلغاء؛ (10) تقرير الأخطاء (XLSX / CSV) لا يمر بسجل تصدير التقارير لأنه يحمل صفوف ملفات المؤسسة نفسها ورسائل الفحص للمالك فقط، والدفعة نفسها مسجلة في التدقيق.
- (2026-11-11) قرارات افتراضية لمراجعة المرحلة 9 اتخذها المنفّذ أثناء غياب المالك (الخيار الأأمن، قابلة للمراجعة؛ تُعدّل القرار (7) و(10) أعلاه): (1) **عداد الخطة:** كل معاملة مستوردة تُحسب في شهر الاستيراد (`created_at` = وقت الاستيراد)، وتاريخ الإنشاء القديم يُحفظ بيانات فقط في `transactions.legacy_created_at` (لا يكتبه إلا الخادم)، لأن التاريخ القديم كان يسمح بتجاوز حد المعاملات الشهري ولأن المعاملة المفوترة يمكن إرجاعها لحالة سابقة؛ الصف الذي يتجاوز الحد خطأ `MRS_PLAN_LIMIT` ويُستورد لاحقًا أو بعد ترقية الخطة؛ (2) **بصمة الإلغاء** تؤخذ لكل صف لحظة ترحيله، وتُحدَّث فقط حين يعدّل صف لاحق من الدفعة سجلًا سابقًا منها عمدًا وبشرط ألا يكون غيرها عدّله قبله، فأي تعديل أثناء «قيد الترحيل» يمنع الإلغاء؛ (3) **الإلغاء على دفعات** بحالة جديدة «قيد الإلغاء» (`voiding`، تُعدّ دفعة مفتوحة)، حتى 200 صف لكل استدعاء (حد 500)، ويُكمل بـ«تابع الإلغاء» بالسبب المحفوظ؛ (4) **الحاويات لا تُحذف أبدًا:** الحاوية التي أضافتها الدفعة لمعاملة لم تنشئها تبقى على معاملتها بعد الإلغاء (`kept_containers`)، وتُضاف إلى موانع الإلغاء إثباتات الإعادة والاستثناءات وقضايا الأرضيات والتكاليف على حاويات الدفعة ومعاملاتها؛ الأسماء البديلة تبقى تُحذف لأنه المسار العادي للموظف ولأن بقاءها يمنع إعادة الاستيراد المصحح؛ (5) **الرفع:** مكان الصف (الورقة + رقم الصف) جزء من بصمة الصف، فالسطران المتطابقان صفان (والفحص يعلّم المكرر الحقيقي)، وأول إرسال لكل ورقة يحمل `replace` فيحذف ما رُفع منها سابقًا، فلا يبقى سطر حُذف من الملف المصحح؛ (6) **العهدة في دفعة لاحقة:** «رقم حركة العهدة» المستورد سابقًا مكرر، والعميل الذي له رصيد افتتاحي من دفعة سابقة لا يقبل إلا حركات بأرقام وبشرط أن حركاته السابقة كلها بأرقام (وإلا خطأ يُسجَّل يدويًا)، وفشل الإيداع الافتتاحي يُفشل بقية حركات العميل؛ (7) **حركة النقل في دفعة لاحقة:** «رقم الحركة» المستورد سابقًا مكرر، والنقلة بلا موعد المطابقة لنقلة على المعاملة (الحاوية والسائق والوجهة والقيمة) مكررة، والموعد الملغى المطابق مكرر؛ (8) **فواتير RHK-:** «رقم مسودة فاتورة دفترة» هو رقم دفترة نفسه فيُبحث به لكل معاملة تحمله (أي ترقيم)، ومرجع النظام القديم `RHK-<رقم المعاملة>` (po_number) يطابقه مسح الفواتير القديمة (أُعيد إنشاء `app.daftra_apply_scan`) فيقترح مرشحًا للمعاملة ولا يربط شيئًا؛ (9) **الأداء:** الفحص والترحيل نوع واحد في كل استدعاء بالفهارس، ويُحدَّث إحصاء جدول الصفوف (ANALYZE) حين يتغير كثير منه؛ (10) إصلاح اختبار متقلب في legacy-pay-sql-tests (كان يطابق «90» داخل معرّفات عشوائية). نُفّذ في 20261125000100_legacy_import.sql (docs/online/LEGACY_IMPORT_AR.md).

## ترتيب البناء

### 1. Data model foundation

- **المحتوى:** customs_ports + party_ports, transactions new columns (port_code, terminal, cargo_unit_type/chassis/plate, transaction_type, transport_mode/order, declaration_notes), declaration Hijri + Fasah stage codes + declaration_type domain, clients.port_category/match stats, client_aliases status/confidence, payment method codes, fin_funding_source domain, org service catalog (26 items, text codes), app.norm_tas / norm_sa_phone, cancel_transaction
- **السبب:** Every later feature (documents, appointments, payments, Daftra custom fields, reports) writes or filters on these fields. One migration with RLS and catalog tests.

### 2. Transaction form + lifecycle + guards

- **المحتوى:** Tx form fields (Ro-Ro, re-export, operator by port, client typeahead), duplicate B/L+container guard, app.advance_tx_status triggers, stepper, duplicate-appointment index, save_movement combined RPC + driver auto-upsert
- **السبب:** Gives the operational core the extra fields before automation fills them.

### 3. Documents/AI: shipment batch and approval

- **المحتوى:** ai-extract packing_list + extended keys (ai-doc-v3), doc_batches, merge function, comparison extension (seal, packing, missing fields), wrong-slot guard, dedupe-before-call, pending drafts page, transaction_shipment_data + invoice/packing item tables, approve_doc_batch (incl. create tx from draft), customer matching v2 + confirm_client_match/alias learning
- **السبب:** This is the biggest gap (PROJECT_STATUS §6.7: no automatic transfer of extracted fields) and the basis for the Fasah sheet and declaration flow.

### 4. Declaration AI + HS reference + Fasah entry sheet

- **المحتوى:** customs_declaration schema extension (type/status/Hijri/RTL/items), approve_declaration_extraction, declaration_items, hs_reference + search, Umm al-Qura converter, Fasah entry sheet (print/xlsx)
- **السبب:** Depends on step 3 batches and step 1 declaration fields. Declaration approval is the trigger for Daftra in step 7.

### 5. Appointments and empty return AI

- **المحتوى:** ai-extract appointment_ticket + empty_return_receipt, port_appointments new columns, appointment drafts (autosave/restore/cancel/move/approve), re-read rules, empty_return_proofs + verify/void RPCs, TASTO carrier order, readiness RPC + org setting for the empty-return billing gate
- **السبب:** Needs save_movement (step 2) and the batch infrastructure (step 3). Owner decisions on the billing gate and AI auto-verify go here.

### 6. Payments, disbursements and custody

- **المحتوى:** supplier_payments extension or client_disbursements + payment_allocations + payment_documents, funding-source/method matrix, reference uniqueness, invoice identity confirm, review status + four-eyes, correct (void+re-record), payment_proof/appointment_invoice AI reading with channel separation, TAS normalisation, tx payments panel, form auto-draft, client_custody_entries + balances + void
- **السبب:** Custody deductions depend on payment records. Reimbursable disbursements feed client_charges used by Daftra.

### 7. Daftra alignment

- **المحتوى:** remote_product_code + zero-insensitive resolve, service catalog match, CustomModel custom_field_map + required-field validation + port/type value mapping, opening zero draft on declaration approval (org setting), Riyadh date + read-back check, allow_draft_update policy flag, client bulk import, invoice_lookup (number/composite) + confirm_invoice_link + legacy_scan back-fill, client_mismatch on pull, Arabic error dictionary, supplier search; purchase drafts last behind a flag
- **السبب:** Needs declarations (4), service catalog and disbursements (6), and clients imported. The Daftra account must first be switched from Egypt to KSA (SAR/15%).

### 8. Reports, dashboards, alerts

- **المحتوى:** dash_tx_counts with Fasah stages, column-filter component, extended transaction search/export columns, report_movements, transport by party/driver, report_payments, status_stale/appointment_not_updated alerts with aging rules, Fasah monthly reconciliation, performance/progress UX, audit diff renderer, optional email-OTP login
- **السبب:** Reads data produced by all previous steps.

### 9. Legacy data migration

- **المحتوى:** One-off import of transactions, containers, movements, drivers, customers/aliases, payments, custody; link legacy RHK- Daftra invoices via legacy_scan
- **السبب:** Run last, once the target schema is stable.

## ما لن يُنقل كما هو (ويُستبدل)

- Google Sheets as the database (sheet headers, column indexes, onEdit cache invalidation, formatting and RTL setup, hidden backup sheet copies): replace with Postgres tables, RLS and migrations.
- Google Drive file storage (per-transaction folders, trashing files, archive folders): replace with Supabase Storage plus documents/finance_documents and voiding, never hard delete.
- Gemini (generateContent v1beta, ListModels discovery, model fallback chain, multi-document single call, x-goog-api-key in Script Properties): everything must go through the ai-extract edge function on Claude claude-opus-5-5 with ai_reserve/ai_settle quotas, one document per call.
- Apps Script anonymous web app (ANYONE_ANONYMOUS, executes as the owner) with a custom OTP session in Script Properties/localStorage: replace with Supabase Auth plus memberships, MFA and RLS.
- LockService document/script locks and time-driven triggers (90s back-fill trigger, checkpoint script properties): replace with transactions, FOR UPDATE, advisory locks, idempotency keys, and the billing_sync_jobs outbox/worker or pg_cron.
- Google Sheets export URL for PDF/XLSX (temporary spreadsheet then trashed): replace with client-side xlsx-lite and print CSS, audited via log_report_export.
- Hard deletion of transactions, movements, payments, proofs and drafts: Marsa is append-only and void-only, so use cancel or void RPCs with a reason.
- Owner-only upgrade functions (upgradeToV*, APP_VERSION stamps) and the hard-coded one-off customer data fixes and 344-row embedded customer seed: these are data or deployment history, not features. Use migrations and a tenant-supplied import.
- Hard-coded institution name, legacy RHK- invoice prefix, and Daftra account-specific field keys (field_1..field_9) and product codes: make them per-org configuration.
- Client-side jsDelivr html2canvas/jsPDF in the Fasah sheet: prefer browser print-to-PDF, or load pinned cdnjs versions on demand.
- Payment auto-sync PUT/POST edits to existing Daftra invoices (r11.4): already disabled by legacy HF5. Only port behind an explicit per-org policy flag.
- Policy conflicts the owner must decide: legacy allows billing without empty-return proof (Marsa blocks); legacy AI auto-verifies container returns (Marsa requires staff confirmation); legacy TASTO path skips returns; legacy lifecycle orders 'operationally complete' before transport.

## جرد الوظائف بالتفصيل

### نموذج البيانات الأساسي: المعاملات ووحدات الشحن والقوائم المرجعية — Core data model: transactions, cargo units, lookups

#### حقول المعاملة (37 عمودًا في النظام القديم) (Transaction record fields (legacy 37 columns)) — 🟡 جزئي — حجم M

- **المصدر:** الرمز.js APP.transactionHeaders, transactionRowToObject_, saveTransaction; Index.html formPage, collectTransactionForm
- **الوصف:** One record per customs transaction. Fields: sequence (6 digits), importer, customer code/internal id/category, B/L, port, terminal operator, shipping agent, vessel, employee, notes, declaration no/date/Hijri date/type/status/notes, operational status, transport mode/company/order no/date, Daftra draft fields, cargo unit type, chassis, plate, transaction type.
- **خطوات المستخدم:** New transaction -> fill the three sections (transaction, declaration, transport) -> save -> the sequence number is shown.
- **البيانات:** Sheet المعاملات (37 cols). Containers live in a separate sheet.
- **القواعد:** Required: importer, B/L, port from the approved list, ≥1 container (or a chassis for Ro-Ro). Having a declaration no requires a status and type, and the reverse. Daftra fields are never overwritten by the form.
- **الوضع في مرسى:** public.transactions (20261031000200_operations.sql) has ref, client_id, bl_number, declaration_no/date/type, operational/financial status and notes. Vessel and agent are on bills_of_lading (20261103000100_g3_registry.sql). Missing: Hijri date, terminal operator, transport mode/order, cargo_unit_type, chassis/plate, transaction_type, declaration_notes, port_code. grep for chassis/cargo_unit/re_export/TASTO returns nothing.
- **طريقة البناء في مرسى:** One migration: ALTER transactions ADD terminal_party_id, port_code (FK customs_ports), cargo_unit_type ('container','roro'), chassis_no, vehicle_plate_no, transaction_type ('normal','re_export'), transport_mode ('driver','carrier_order'), transport_party_id, transport_order_no, transport_order_date, declaration_notes. Expose the columns in the tx create/update path (assets/js/supa.js, assets/js/ops/tx-sections.js) and add i18n keys.

#### وحدة شحن مركبة Ro-Ro (الشاسيه واللوحة) (Ro-Ro vehicle cargo unit) — ❌ ناقص — حجم M

- **المصدر:** الرمز.js normalizeCargoUnitType_, isRoRoTransaction_, normalizeChassisNo_, getTransactionEmptyReturnReadiness_, markTransactionReadyForInvoicing; Index.html toggleCargoUnitTypeUI, ensureRoRoFieldsR12125
- **الوصف:** A transaction can carry a Ro-Ro vehicle instead of containers. The chassis/VIN is required and the plate is optional. Ro-Ro skips the TAS appointment and the empty return, counts as one unit, and can move to under-billing from operationally-complete or transport.
- **القواعد:** Chassis is normalised to A-Z0-9. Duplicate check = same B/L + chassis. Container and empty-return UI is hidden for Ro-Ro.
- **الوضع في مرسى:** No chassis or cargo_unit in migrations or JS. containers.container_no CHECK '^[A-Z]{4}[0-9]{7}$'. set_transaction_status requires container returns (20261103000200_g3_operations.sql).
- **طريقة البناء في مرسى:** Add cargo_unit_type, chassis_no and plate_no. Make tx_checklist/document_requirements return not_applicable for empty_return_receipt and appointments on roro. Skip the container-return gate in set_transaction_status. Add chassis to the search_records q and to the container filter.

#### نوع المعاملة: عادية / إعادة تصدير (Re-export transaction type) — ❌ ناقص — حجم S

- **المصدر:** الرمز.js normalizeTransactionType_, ensureTransactionTypeColumnR12127_; Index.html transactionTypeBadge
- **الوصف:** Normal (the default) or re-export. Re-export shows a badge in lists and reports.
- **الوضع في مرسى:** transactions.operation is import/export only. No re_export anywhere.
- **طريقة البناء في مرسى:** transactions.transaction_type CHECK ('normal','re_export') plus status_labels rows. Add it to the form, the search filter and the export column.

#### المنافذ الجمركية المعتمدة والمشغلون حسب المنفذ (Approved customs ports and operators by port) — 🟡 جزئي — حجم S

- **المصدر:** الرمز.js APPROVED_CUSTOMS_PORTS_R11, restoreApprovedPortsV213, getLookupData_; Performance.js fastBuildLookups_; Index.html refreshOperatorOptions
- **الوصف:** A fixed list of 7 ports: Jeddah Islamic, King Abdulaziz Dammam, King Abdullah Rabigh, Riyadh Dry Port, KAIA Jeddah, KFIA Dammam, KKIA Riyadh. Choosing a port filters the terminal-operator list.
- **القواعد:** The port must be in the list. Documents cannot add new ports.
- **الوضع في مرسى:** transactions.port_of_discharge is free text. doc-match.js has UN/LOCODE aliases. parties kind terminal_operator exists, but no port mapping.
- **طريقة البناء في مرسى:** A platform table customs_ports(code UN/LOCODE, name_ar, name_en, kind sea/air/dry, daftra_value) seeded with KSA ports, plus party_ports(party_id, port_code). Dropdowns in the tx form.

#### حالات البيان (مراحل فسح) وأنواعه والوكلاء الملاحيون الافتراضيون (Declaration statuses (Fasah stages), types, default shipping agents) — 🟡 جزئي — حجم S

- **المصدر:** الرمز.js APP.defaultDeclarationStatuses, declarationTypes, defaultShippingAgents, normalizeDeclarationStatus_, normalizeDeclarationType_, normalizeShippingAgentShort_
- **الوصف:** Five Fasah stages: accepted (inspection), customs operations centre review done, awaiting duty collection, ready to print the release notice, full release (فسح كلي). Types are import, export and clearance. A dictionary of 15 agents maps long or legal names to short names.
- **القواعد:** Arabic normalisation is applied before matching. 'تم الفسح' becomes فسح كلي. Unknown agents get their legal suffixes stripped and are never given an invented abbreviation.
- **الوضع في مرسى:** customs_declarations.status = draft/submitted/under_inspection/released/cancelled/replaced. declaration_type is free text. Parties kind shipping_agent has no seed.
- **طريقة البناء في مرسى:** Add codes cco_review_done, awaiting_duty_payment and release_ready to the status CHECK and status_labels. Add a declaration_type domain (import/export/clearance). Add a SQL function app.norm_declaration_status(text). Seed shipping-agent parties per org with aliases.

#### التاريخ الهجري للبيان وتحويله (أم القرى) (Hijri declaration date (Umm al-Qura)) — ❌ ناقص — حجم S

- **المصدر:** الرمز.js normalizeHijriDate_, upgradeToV183/V184; DocumentAI.js convertHijriToGregorianUmmAlQura_; Index.html convertHijriField, hijriToGregorianUmmAlQura
- **الوصف:** Stored as text yyyy/mm/dd. Arabic and Persian digits and the d/m/yyyy order are accepted. The Gregorian date is computed with Intl islamic-umalqura.
- **القواعد:** Year 1300-1700, month 1-12, day 1-30.
- **الوضع في مرسى:** No hijri column. assets/js/ocr-parse.js returns '' for Hijri dates.
- **طريقة البناء في مرسى:** Add customs_declarations.declaration_date_hijri text with a format CHECK. Add an ES5 converter (binary search over Intl 'en-u-ca-islamic-umalqura') in i18n.js and use it in ocr-parse.js normalizeDate.

#### تعدد الحاويات للمعاملة (Multi-container per transaction) — ✅ موجود — حجم S

- **المصدر:** الرمز.js APP.containerHeaders, normalizeContainerList_, replaceTransactionContainers_, mergeTransactionContainers_, normalizeContainerNumber_
- **الوصف:** Each container has a number, seal, type/size, source (manual/document/migration) and status. Containers from documents are merged by normalised number. The number is displayed as 'ABCD 1234567'.
- **الوضع في مرسى:** public.containers with the ISO CHECK, seal_no, size_type, gross_weight_kg and bl_id (operations.sql, g3_registry.sql).
- **طريقة البناء في مرسى:** Add containers.source (manual/ocr/import) and show the number with a space in the UI.

#### منع تكرار المعاملة وملكية الحاوية (Duplicate transaction and container-ownership guard) — 🟡 جزئي — حجم S

- **المصدر:** الرمز.js assertNoDuplicateTransaction_, assertContainersCanBeRemoved_, assertContainerBelongsToTransaction_
- **الوصف:** Blocks a second transaction with the same B/L plus an overlapping container, or the same chassis for Ro-Ro. Blocks removing a container that has movements. Appointments and proofs must use a container of the same transaction.
- **الوضع في مرسى:** containers_tx_no_uniq covers one transaction only. DEC-02 lets the same number repeat across transactions. FKs block deletion of a referenced container.
- **طريقة البناء في مرسى:** Trigger/RPC check MRS_DUPLICATE_TX on same bl_number + container_no in another open transaction in the org (overridable with a reason). Warn when a container is active in another open transaction.

#### اشتقاق مرحلة المعاملة تلقائيًا للأمام فقط (Operational lifecycle auto-derivation (forward only)) — 🟡 جزئي — حجم M

- **المصدر:** الرمز.js resolveTransactionStatus_, setTransactionLifecycleStatus_, recalculateTransactionReadyForInvoicing_; Index.html renderTransactionLifecycle
- **الوصف:** Stages: new -> active (has a declaration no) -> operationally complete (فسح كلي) -> transport (a movement was saved) -> under billing -> billed (invoice approved in Daftra). Never moves backwards. A stepper is shown on the form.
- **الوضع في مرسى:** set_transaction_status with stage order, a 10-code operational_status and forward-only financial_status. Nothing advances automatically from declaration or appointment events (PROJECT_STATUS §6.7).
- **طريقة البناء في مرسى:** Internal app.advance_tx_status(tx, target), forward only, writing transaction_events. Call it from AFTER triggers on customs_declarations insert/release, port_appointments and transport_trips insert, and billing issued. Stepper in tx-sections.js. Note the order difference: legacy puts 'operationally complete' before transport.

#### حذف/إلغاء المعاملة مع حماية دفترة (Cancel/delete transaction with Daftra guard) — ❌ ناقص — حجم M

- **المصدر:** الرمز.js deleteTransaction, assertTransactionDeletableAgainstDaftraR1216_; R1212Performance.js appointment cleanup manifest; DocumentAI.js deleteTransactionDocumentData_; Index.html confirmDeleteCurrentTransaction
- **الوصف:** The user types 'حذف'. Deletion is blocked when the Daftra invoice is approved or Daftra is unreachable (fail-closed). Otherwise it cascades to containers, movements, documents, drafts and the Fasah data.
- **الوضع في مرسى:** There is no DELETE policy or RPC on transactions. Marsa is void-only by design.
- **طريقة البناء في مرسى:** RPC cancel_transaction(p_tx, p_reason, p_confirm): sets status closed + cancelled_at, cancels open appointments and trips, voids documents and drafts, and releases fingerprints. Refuses when a billing_intent is issued or its sync is in_flight. Add the new tables to app.convert_delete_tables.

#### استيراد بيانات النظام القديم (Legacy data import (transactions, containers, movements, drivers, customers, aliases)) — 🟡 جزئي — حجم M

- **المصدر:** الرمز.js migrateLegacyTransactions; Payments.js migrateLegacyPaymentModel_
- **الوصف:** One-time import that dedupes by B/L + container and keeps the old sequence numbers.
- **الوضع في مرسى:** import_batches/import_commit plus bulk-upload.html, which handles shipments only.
- **طريقة البناء في مرسى:** Owner script or import templates mapping the legacy Sheets export to the Marsa tables, with dedupe and method/movement inference for payments.

### مستندات الشحنة والقراءة الآلية — Shipment documents and AI reading

#### حزمة مستندات الشحنة (بوليصة + فاتورة + بيان تعبئة) مع إعادة المحاولة لكل مستند (Shipment document batch (B/L + invoice + packing list) with per-document retry) — 🟡 جزئي — حجم L

- **المصدر:** DocumentAI.js uploadAndAnalyzeDocuments, buildDocumentExtractionPrompt_, getDocumentExtractionSchema_; Index.html documentUploadForm, submitDocumentAnalysis, renderDocumentReview
- **الوصف:** Three slots. Each file is read separately against a strict schema (shipment+containers, invoice+items, packing+items). Failures do not discard the successes, and only the failed file is retried. The review screen edits every field and table.
- **القواعد:** ≥1 file, 10MB per file, 25MB per batch. Reading can be cancelled, with a hint after 90s.
- **التكاملات:** Gemini becomes Claude ai-extract.
- **الوضع في مرسى:** ocr.html/ocr.js read one document per call. ocr-match.js reads invoice + B/L + declaration together. ai-extract doc types: bill_of_lading, commercial_invoice, customs_declaration, supplier_invoice, auto. No packing_list type exists in functions (grep).
- **طريقة البناء في مرسى:** Add doc_type packing_list (packages, net/gross, per-item split, container/seal). New table doc_batches (org_id, transaction_id null, kind shipment/declaration/appointment, status, draft jsonb, bl_number, importer, container_count, created_by, timestamps) and document_extractions.batch_id. A 3-slot panel in ocr.html and in the tx detail.

#### رفض المستند المرفوع في الخانة الخطأ (Wrong-slot / wrong-document-type guard) — 🟡 جزئي — حجم S

- **المصدر:** DocumentAI.js assertExpectedDocumentType_, normalizeDetectedDocumentType_; R112AppointmentSafety r112LooksLikeRealAppointmentTicket_
- **الوصف:** The model classifies by content, never by file name. If the detected type differs from the slot, the read is rejected with an Arabic message naming both types.
- **الوضع في مرسى:** ai-extract returns doc_type, but ocr.js silently adopts the detected kind. The kind is enforced only by save_document_match.
- **طريقة البناء في مرسى:** Block when res.kind != slot (i18n MRS_DOC_WRONG_SLOT). Enforce it on the server in the attach-to-batch RPC as well.

#### كشف التكرار بالبصمة واستعادة المسودة دون إعادة القراءة (SHA-256 dedupe and draft restore without re-reading) — 🟡 جزئي — حجم S

- **المصدر:** DocumentAI.js computeBytesFingerprint_, findExistingDocumentByFingerprint_
- **الوصف:** Dedupe key = hash + type + transaction, ignoring failed, ignored and cancelled records. If every file is a duplicate, the original draft is restored with no AI call.
- **الوضع في مرسى:** document_extractions_dedupe_uidx and the documents sha256 index exist. supa.js reuses a reading after MRS_EXTRACTION_DUPLICATE. There is no lookup before the AI call for a whole batch.
- **طريقة البناء في مرسى:** Compute sha256 in the browser, look up the extraction by sha before calling aiExtract to save quota, and restore from doc_batches.draft.

#### مسودات المستندات المحفوظة وصفحة المسودات بانتظار الاعتماد (Persistent document drafts (auto-save, pending list, restore, discard, archive)) — 🟡 جزئي — حجم M

- **المصدر:** DocumentAI.js persistDocumentDraft_, listPendingDocumentDrafts, savePendingDocumentDraft, discardDocumentDraft, deletePendingDocumentDraft, releaseDocumentBatchForRetry_; Index.html openDraftsPage, renderDocumentDrafts
- **الوصف:** The draft is saved before the first read and after each success, so a refresh or timeout loses nothing. A drafts page (also a dashboard card) lists pending drafts with importer, B/L, container count, employee and update time. Drafts can be opened and continued, discarded or archived. Drafts are excluded from the stats.
- **القواعد:** An approved draft linked to a transaction cannot be deleted. Failed or cancelled drafts are not restored.
- **الوضع في مرسى:** document_extractions has per-row review_status and void. ocr.js keeps a local plus server history. There is no multi-document draft or pending list.
- **طريقة البناء في مرسى:** RPCs save_doc_batch_draft, list_pending_doc_batches, discard_doc_batch, archive_doc_batch (no hard delete). A '#drafts' view and a dashboard tile.

#### دمج بيانات عدة مستندات في مسودة واحدة (Merge multi-document results into one draft) — ❌ ناقص — حجم S

- **المصدر:** DocumentAI.js mergeDocumentDrafts_, normalizeDocumentDraft_
- **الوصف:** Non-empty incoming values override. Containers merge by normalised number. Item lists are replaced only when the incoming list is non-empty. Notes are unioned.
- **الوضع في مرسى:** doc-match.js compares readings but does not merge them.
- **طريقة البناء في مرسى:** Pure ES5 function in assets/js/doc-batch.js with unit tests like doc-match-engine-tests.js.

#### المقارنة بين المستندات (تطابقات، تعارضات، حقول مفقودة) (Cross-document comparison incl. packing list, seal and missing-fields checklist) — 🟡 جزئي — حجم M

- **المصدر:** DocumentAI.js buildDocumentComparison_, compareField_, sumInvoiceNetWeight_, sumInvoicePackages_
- **الوصف:** Compares B/L no, container, seal, net/gross weight, packages (invoice cartons), importer/buyer and shipper/seller across B/L, invoice and packing list, plus a checklist of required fields.
- **القواعد:** Numbers rounded to 3 decimals. A field needs ≥2 values to be compared.
- **الوضع في مرسى:** doc-match.js match-v1 plus document_matches (20261116000100_doc_match.sql). No packing source, seal row or missing-fields checklist.
- **طريقة البناء في مرسى:** Add a packing source and a seal_no row (app.doc_match_row_keys) and a required-fields checklist. Add seal_numbers to the ai-extract keys.

#### اعتماد بيانات المستندات ونقلها إلى المعاملة (Approve shipment documents into the transaction) — ❌ ناقص — حجم L

- **المصدر:** DocumentAI.js saveReviewedDocumentData, upsertFasahData_, replaceInvoiceItems_, replacePackingItems_; Performance.js saveTransactionWithDocumentDraftFast, rollbackNewTransactionAfterDocumentFailure_; Index.html applyDocumentDraftToTransaction
- **الوصف:** One atomic step: create or update the transaction (including a new one from a draft), write the Fasah data, replace the invoice and packing items, merge containers (source = shipment docs), approve and link the documents, apply the customer match and save an alias. On failure everything rolls back and the draft is kept.
- **القواعد:** The importer chosen on the form is kept. The port is inferred from POD only when it is an approved port.
- **الوضع في مرسى:** PROJECT_STATUS_AR.md §6.7: 'لا نقل آلي للحقول المستخرجة'. Only the building blocks exist (containers insert, save_bl, client_aliases).
- **طريقة البناء في مرسى:** SECURITY DEFINER RPC approve_doc_batch(p_batch, p_tx nullable, p_payload, p_idem): upsert the transaction, save_bl, upsert containers, write transaction_shipment_data and the item tables, insert client_aliases, link the extractions and mark them reviewed.

#### سجل بيانات فسح وجدولا أصناف الفاتورة وتفاصيل التعبئة (Fasah shipment data record + invoice/packing item tables) — ❌ ناقص — حجم M

- **المصدر:** DocumentAI.js fasahHeaders (42 cols), invoiceItemHeaders (14), packingItemHeaders (12)
- **الوصف:** Per-transaction header: shipper, booking, vessel, voyage, POL/POD, receipt/delivery places, goods, packages, CBM, temperature, freight terms, invoice no/date, seller/buyer, currency, origin, export country, value, Incoterms, payment terms, packing totals, matches, conflicts, missing fields. Invoice items: description, scientific name, supplier HS, qty, unit, price, total, origin, weights. Packing items: description, packages, qty, unit, weights, container, seal.
- **القواعد:** The supplier HS code is reference only. The scientific name is kept separate from the description.
- **الوضع في مرسى:** document_extractions.line_items allows only description/hs_code/quantity/unit_price/amount. There are no per-transaction item tables.
- **طريقة البناء في مرسى:** Tables transaction_shipment_data (PK transaction_id), shipment_invoice_items and shipment_packing_items with RLS via app.can_read_transaction, written only by approve_doc_batch. Widen extraction_items_ok and the prompt (ai-doc-v3).

#### قراءة البيان الجمركي آليًا (النوع، الحالة، الهجري، مرشحو البوليصة RTL، البنود) (Customs declaration AI reading (type, Fasah status, Hijri, RTL B/L candidates, items)) — 🟡 جزئي — حجم M

- **المصدر:** DocumentAI.js analyzeDeclarationDocument, getDeclarationSchema_, normalizeDeclarationDraft_; R11Automation.js detectDeclarationTypeFromBlobR11_; Index.html submitDeclarationAnalysis, renderDeclarationReview
- **الوصف:** Reads the declaration number, type (import/export/clearance, from the title only, with evidence), Hijri and Gregorian date, status, Arabic importer, broker, raw B/L with candidates and an RTL flag, all containers, vessel, origin, invoice value, and HS items with Arabic descriptions.
- **القواعد:** Requires a saved transaction, one file. The Gregorian date is recomputed from the Hijri. The original B/L number is never replaced.
- **الوضع في مرسى:** ai-extract customs_declaration covers number, B/L, containers, hs_codes, origin, weights. It has no type, status, Hijri, RTL candidates or items.
- **طريقة البناء في مرسى:** Extend the customs_declaration KEYS_FOR (declaration_type + evidence in the same Claude call, declaration_status, hijri_date, bl_candidates, bl_rtl_flag, items[]).

#### اعتماد البيان وتحديث المعاملة والحاويات ومرجع البنود (Approve declaration -> transaction + containers + HS reference (+ optional Daftra draft)) — 🟡 جزئي — حجم M

- **المصدر:** DocumentAI.js saveReviewedDeclaration, compareDeclarationWithTransaction_, billReferenceEquivalent_; R11Automation.js saveReviewedDeclarationR11Core_
- **الوصف:** Validates the number, type, Gregorian date, status and ≥1 container. Updates the transaction declaration fields and the vessel if empty. Merges containers (source = declaration). Upserts the HS reference. Approves the docs. Then tries a Daftra draft; a failure there does not undo the approval.
- **القواعد:** B/L equivalence = same alphanumeric tokens in any order.
- **الوضع في مرسى:** add_declaration/correct_declaration/set_declaration_status accept source 'ocr'. There is no creation from an extraction and no container merge.
- **طريقة البناء في مرسى:** RPC approve_declaration_extraction(p_extraction, p_tx, p_payload) -> add_declaration + container upsert + hs_reference upsert + declaration_items. Port billReferenceEquivalent_ into doc-match.js.

#### مرجع البنود الجمركية (بحث وتعلّم من البيانات المعتمدة) (HS code reference library (learned from approved declarations)) — ❌ ناقص — حجم M

- **المصدر:** DocumentAI.js searchHsReference, upsertHsReferenceFromDeclaration_; Index.html searchHsFromReview
- **الوصف:** Each approved declaration item upserts a row: HS, Arabic description, invoice description, scientific name, origin, last declaration, importer and usage count. Search scores: code match 100, phrase 50, 10 per word, plus up to 20 for usage. It is a suggestion only.
- **الوضع في مرسى:** No hs_reference table in migrations.
- **طريقة البناء في مرسى:** Table hs_reference (unique org+hs+norm(desc_ar)+norm(invoice_desc)) and RPC search_hs_reference(p_org, q, limit) using pg_trgm when available. A picker in the review UI.

#### ورقة معلومات الإدخال في منصة فسح (Fasah entry information sheet (print/PDF/Excel)) — ❌ ناقص — حجم M

- **المصدر:** DocumentAI.js getFasahReportData, exportFasahReportFile; Index.html openFasahReport, buildFasahReportBody, fasahCommonReviewTable, downloadFasahPreviewAsPdf
- **الوصف:** An RTL sheet in Fasah entry order: summary strip, B/L, containers/seals, invoice and items, packing and items, a common-values review across documents, conflicts and missing fields. File name: كشف-إدخال-فسح-{seq}-{date}.
- **القواعد:** Numeric tolerance max(0.01, 0.01%). Currency codes get Arabic names.
- **الوضع في مرسى:** ocr-match.js exports only the match table. No Fasah sheet.
- **طريقة البناء في مرسى:** A client-side section built from transaction_shipment_data and the item tables. Print CSS for PDF, xlsx-lite for Excel, log_report_export for audit.

#### سجل المستندات وتخزين الملفات والتحقق من النوع والحجم (Document register, storage and file validation) — ✅ موجود — حجم S

- **المصدر:** DocumentAI.js appendDocumentRecord_, validateDocumentBlob_, sanitizeFileName_
- **الوصف:** A record per file (type, MIME, status, uploader, fingerprint). PDF/JPEG/PNG/WEBP only.
- **الوضع في مرسى:** public.documents (sha256, size ≤25MB, kind) plus storage buckets (20261031000500_storage.sql). ai-extract validates input.
- **طريقة البناء في مرسى:** Add a batch total-size check (25MB) in the batch UI only.

#### إعداد مزوّد القراءة الآلية وإعادة المحاولة ورسائل الخطأ العربية (AI provider config, retries, fallback and Arabic errors) — ✅ موجود — حجم S

- **المصدر:** DocumentAI.js configureGeminiApiKey, isRetryableGeminiFailure_, buildGeminiArabicError_; PaymentDocumentAI.js paymentDocAiV2ResolveModels_; R12Client r1211 guard
- **الوصف:** Owner-configured key and model. Retries on busy or 429/5xx with a fallback model, and maps errors to Arabic. On the client: one read at a time, a 90s timeout, a stop button and a 20s cooldown.
- **الوضع في مرسى:** ANTHROPIC_API_KEY in Edge secrets. ai_settings/ai_access/ai_reserve/ai_settle (20261114000100_ai_documents.sql). Refusal and stop_reason handling in ai-extract.
- **طريقة البناء في مرسى:** Do not port the Gemini model discovery. Add backoff on 429/529, Arabic messages for busy and quota, and an AbortController with a 90s timeout plus cooldown in ocr.js.

#### دوال التطبيع (الأرقام العربية، المراجع، التواريخ، HS، الأسماء) (Value normalisation helpers) — 🟡 جزئي — حجم S

- **المصدر:** DocumentAI.js safeNumber_, normalizeValidBillNo_, normalizeHsCode_; الرمز.js normalizeSearch_, normalizePhone_, safeMoney_
- **الوصف:** Arabic and Persian digits converted. Invalid B/L sentinels (0, N/A, NONE, غير متوفر) become empty. HS keeps digits only. Arabic letters are folded for search. Phone becomes +966.
- **الوضع في مرسى:** app.to_western/norm_code/norm_name; extract.js validators; ocr-parse.js normalizeDate.
- **طريقة البناء في مرسى:** Add the B/L sentinel list and Arabic-digit handling to ocr-parse.js and doc-match.js, plus app.norm_sa_phone().

### المواعيد والنقل وإعادة الفارغ — Appointments, transport and empty return

#### حركة النقل: الموعد والنقلة وإعادة الفارغ (Combined movement record (appointment + trip + empty return)) — 🟡 جزئي — حجم M

- **المصدر:** الرمز.js APP.movementHeaders, saveMovement, validateMovement_, resolveMovementStatus_; Index.html saveMovementFromForm, renderTransactionMovements
- **الوصف:** One form per container: appointment time, driver/phone/truck, status, destination, transport value, organisation revenue, empty-return place/deadline/actual date/status, booking ref, operator, notes. Saving moves the transaction to the transport stage and warns about containers that have no return proof.
- **القواعد:** Required: container, time, driver, phone, truck, status. 'تم النقل' requires a destination, value and revenue. Missing transport data gives the status 'بيانات النقل ناقصة'. Idempotent save.
- **الوضع في مرسى:** port_appointments, transport_trips (cost/sell) and containers.return_* in 20261103000200_g3_operations.sql. assets/js/ops/schedule.js. These are separate records with no combined form.
- **طريقة البناء في مرسى:** RPC save_movement(p_tx, payload, idem) that writes the appointment, the trip and the container return fields atomically, and upserts the driver and truck. Value maps to cost_amount, revenue to sell_amount. Enforce delivered-requires-fields in set_trip_status.

#### منع تكرار المواعيد (Duplicate appointment prevention) — ❌ ناقص — حجم S

- **المصدر:** الرمز.js findDuplicateMovementRow_, assertNoDuplicateMovement_
- **الوصف:** Duplicate = same transaction + container + appointment time, and the same TAS ref when one is given.
- **الوضع في مرسى:** port_appointments has only a reschedule unique index.
- **طريقة البناء في مرسى:** A partial unique index (transaction_id, container_id, appointment_at, coalesce(appointment_no,'')) WHERE status NOT IN ('cancelled','rescheduled'). Return the existing row when idempotent.

#### دليل السائقين التلقائي (Driver directory auto-built from movements) — 🟡 جزئي — حجم S

- **المصدر:** الرمز.js upsertDriverDirectory_, getDriverDirectory_; Index.html applyDriverDirectory
- **الوصف:** Typing a driver name fills the phone and truck automatically. Saving updates the driver's entry in the directory.
- **الوضع في مرسى:** The drivers and trucks registries exist. Nothing auto-upserts them, and there is no last-truck link.
- **طريقة البناء في مرسى:** Find-or-create the driver by normalised phone and the truck by plate inside save_movement. Add drivers.last_truck_id.

#### قراءة بطاقات المواعيد آليًا (حتى 20) والتمييز بين البطاقة وفاتورة الموعد (Appointment ticket (TAS) AI reading, batch ≤20, ticket vs invoice discrimination) — ❌ ناقص — حجم L

- **المصدر:** DocumentAI.js analyzeAppointmentTickets, getAppointmentSchema_; R1212Performance.js analyzeAppointmentTicketsR1212Fast, normalizeAppointmentTasR1212_; R112AppointmentSafety.js buildAppointmentPromptR112_, r112LooksLikeRealAppointmentTicket_
- **الوصف:** Reads the booking/TAS ref, operator, time, vehicle, driver, phone, zone/gate, entry/exit sections, barcode and movement type (full exit or empty entry). Destination, price and empty return are never guessed. Rejects Fasah appointment invoices. Fingerprints are checked across all transactions.
- **القواعد:** Requires a saved transaction. Max 20 files, 25MB. A structural check requires a time, a booking ref and one operational signal.
- **الوضع في مرسى:** No appointment type in ai-extract DOC_TYPES. port_appointments has no booking/barcode/zone fields.
- **طريقة البناء في مرسى:** Add doc_type appointment_ticket to ai-extract, with classification rules and a wrong_document_type rejection. Client loop with concurrency 2-3, each call through ai_reserve. Add booking_ref, operator_ticket_no, zone_gate, barcode, movement_type, source_document_id and extraction_id to port_appointments.

#### مسودات بطاقات المواعيد: حفظ تلقائي واستعادة وإلغاء ونقل واعتماد (Persistent appointment drafts (autosave, restore, cancel, move, approve)) — ❌ ناقص — حجم L

- **المصدر:** R1212Performance.js R1213_APPOINTMENT_DRAFT, saveAppointmentDraftReviewR1213, getPendingAppointmentDraftR1213, cancelAppointmentDraftR1213, moveAppointmentDraftR1213, markAppointmentDraftApprovedR1213; DocumentAI.js saveReviewedAppointments; Index.html/R12Client r1213*
- **الوصف:** Reads are saved as a pending draft and restored on reopen with no re-read. Review edits autosave after 450ms. Cancel releases the cards for re-upload. Move sends the draft to another transaction by number. Approve-all gives a per-card result (saved, already existed, failed), and partial approval is allowed.
- **القواعد:** Only full-exit tickets become movements, and the container must belong to the transaction. A transport party is required per card. Approved batches cannot be cancelled or moved.
- **الوضع في مرسى:** No batch draft or move flow for appointments.
- **طريقة البناء في مرسى:** Reuse doc_batches with kind 'appointment', or a table appointment_drafts. RPCs save/get/cancel/move/approve_appointment_drafts. Approve calls save_movement per row. Use FOR UPDATE locking.

#### قواعد إعادة قراءة بطاقة الموعد بعد الإلغاء أو حذف الحركة أو المعاملة (Re-read rules for orphaned/cancelled appointment cards) — ❌ ناقص — حجم M

- **المصدر:** R1212Performance.js appointmentDocumentAllowsRereadR12110HF9_, releaseApprovedAppointmentIfOrphanedR12110HF9_; الرمز.js repairOrphanedAppointmentDocumentsR12110HF8_
- **الوصف:** A card whose movement or transaction no longer exists is released so it can be read again. A pending duplicate in another transaction prompts the user to move it there.
- **الوضع في مرسى:** The documents dedupe index is per transaction. There is no appointment-to-document link.
- **طريقة البناء في مرسى:** port_appointments.source_document_id plus app.appointment_fingerprint_state(org, sha). Cancelling an appointment voids its document_match automatically.

#### أمر نقل لشركة نقل (TASTO) والتحويل إلى تحت الفوترة (Transport company order (TASTO) path) — ❌ ناقص — حجم M

- **المصدر:** الرمز.js saveTransportCompanyOrder, validateTransportOrderNo_; Index.html toggleTransportModePanels, saveTransportCompanyOrderFromForm
- **الوصف:** Hands transport to a company (company, order no, date). The transaction goes straight to under-billing, with no appointments or return proof needed. An audit line is added to the notes.
- **القواعد:** Order no matches ^TASTO\d+$ and is unique. Not allowed from the new or active stage. Idempotent.
- **الوضع في مرسى:** No TASTO or transport_order anywhere.
- **طريقة البناء في مرسى:** Columns from the data model plus RPC save_transport_carrier_order. The owner must decide how it bypasses MRS_CONTAINERS_NOT_RETURNED (e.g. a waiver reason 'carrier responsible').

#### جهة النقل لكل نقلة (مورد/شركة/مباشر) والبحث في موردي دفترة (Transport party per trip and Daftra supplier search) — 🟡 جزئي — حجم M

- **المصدر:** R12TransportPurchases.js saveMovementTransportPartyR12, searchDaftraSuppliersR12; R12Client r12InjectMovementFields
- **الوصف:** The party type and name are required, and 'direct' defaults to the driver. An optional per-trip order no. Names autocomplete from Daftra suppliers, and the supplier id is stored only on a unique exact match.
- **الوضع في مرسى:** transport_trips.carrier_id refers to parties. No party_type or order no, and no supplier calls in daftra-live.js.
- **طريقة البناء في مرسى:** Add transport_trips.party_type and transport_order_no. Table daftra_supplier_links. A read-only 'search_suppliers' action in daftra-sync.

#### مسودة فاتورة مشتريات دفترة للنقلة (موقوفة في النظام القديم) (Daftra purchase draft per trip (deferred in legacy)) — ❌ ناقص — حجم L

- **المصدر:** R12TransportPurchases.js ensureMovementPurchaseDraftR12_, retryMovementPurchaseDraftR12
- **الوصف:** Draft purchase invoice for the transport value: item 000191, zero tax, the id saved immediately to prevent duplicates. Disabled in the latest legacy version.
- **الوضع في مرسى:** No purchase support in daftra-sync or g5.
- **طريقة البناء في مرسى:** Behind an org flag that is off by default. The source is cost_accruals (trip). A purchase intent goes through the existing outbox. Build last.

#### سجل إثباتات إعادة الفارغ وقراءة EIR آليًا واعتمادها (Empty-return proof register, AI reading of EIR and approval) — 🟡 جزئي — حجم L

- **المصدر:** الرمز.js EMPTY_RETURN_PROOF_R12110, analyzeAndSaveEmptyReturnProofR12110, approveEmptyReturnProofR12110, deleteEmptyReturnProofR12110HF7, saveEmptyReturnDeadlineR12110; R12Client r12110*
- **الوصف:** Upload a PDF or image (≤8MB). AI reads the container, delivery time and depot, plus a confidence score. With a single matching container and complete data it auto-applies; otherwise it goes to review. Manual approval writes the return. A soft delete reverts the return when no other proof exists. Deadline-only save is supported.
- **القواعد:** A date without a time is rejected. Container format is validated. Soft delete only.
- **الوضع في مرسى:** containers.return_status/evidence_document_id/verified_by, the document kind empty_return_receipt, and set_container_return. ai-extract has no EIR type and there is no proof register.
- **طريقة البناء في مرسى:** doc_type empty_return_receipt in ai-extract. Table empty_return_proofs (status pending_review/approved/unreadable/voided, confidence, match_notes). RPCs verify_container_return and void_empty_return_proof. The owner must decide auto-verify vs Marsa's staff-confirmed rule.

#### التحويل إلى «تحت الفوترة» مع تنبيه متابعة الفارغ غير المانع (Ready-for-invoicing with non-blocking empty-return warning) — 🟡 جزئي — حجم M

- **المصدر:** الرمز.js markTransactionReadyForInvoicing, getTransactionEmptyReturnReadiness_; Index.html confirmReadyForInvoicing, renderEmptyReturnFollowUpWarning
- **الوصف:** Allowed from the transport stage with ≥1 movement (Ro-Ro also from operationally-complete). Pending returns only show a warning.
- **الوضع في مرسى:** set_transaction_status('under_billing') hard-blocks with MRS_CONTAINERS_NOT_RETURNED.
- **طريقة البناء في مرسى:** An org setting empty_return_blocks_billing (default true, the Marsa policy). An RPC tx_readiness returning the pending containers for the banner. Owner decision.

### السدادات وعهدة العملاء — Payments (disbursements) and customer custody

#### سجل السداد الموحد (نوع الحركة، النمط، البند، المبالغ، حالة المراجعة) (Unified disbursement register (movement type, pattern, service item, amounts, review status)) — 🟡 جزئي — حجم L

- **المصدر:** Payments.js savePaymentRecord, getPaymentsWorkspace, PAYMENT_MODULE; R115 savePaymentRecordR115; Index.html savePaymentFromForm, renderPaymentsTable
- **الوصف:** Movement types: org paid for the client, org received from the client, client paid the entity directly. Pattern is single or shared. Fields: fee/service item, claim/invoice no, appointment no, expected/paid/difference, date, payer, beneficiary (= invoice issuer), notes, and review status (draft/pending/approved/rejected). The register has search and an Excel-style filter.
- **القواعد:** Single needs a transaction. paid >0. difference = expected - paid. Beneficiary required. Values must come from the catalogs.
- **الوضع في مرسى:** supplier_payments (payer company|client, needs a supplier_invoice), charge_collections, assets/js/fin/payables.js and invoices.js paymentDialog (20261104000100_g4_costs.sql). No movement type, review status or difference field.
- **طريقة البناء في مرسى:** Either a new table client_disbursements (+allocations) or an extension of supplier_payments with movement_type, funding_source, paying_account, payer_name, beneficiary_party_id, payment_channel, sadad_number, bank_reference, receipt_no, appointment_no, review_status and notes. RPC record_payment_bundle (creates the supplier invoice if new, plus the payment, with idempotency). A new view assets/js/fin/payments.js.

#### مصدر التمويل وقواعد المحافظ والعهدة والصندوق والحساب الشخصي (Funding source and wallet/custody/cash rules) — ❌ ناقص — حجم M

- **المصدر:** Payments.js normalizePaymentFundingSource_, validatePaymentFundingMethodCombination_; R12Client r1216InstallPaymentCashOverrides
- **الوصف:** Sources: org account, cash box, Fasah wallet, dry-port wallet, client custody (± dry-port wallet), personal account (reimbursable), client direct, receipt N/A. The source drives the method and the payer.
- **القواعد:** Fasah wallet <=> wallet method. Cash => cash method. A personal source requires the payer name. SADAD, mada and transfer require the paying account. Wallet methods have no bank. The payer is filled from the org name taken from org settings, not a constant.
- **الوضع في مرسى:** No funding_source, wallet or custody concept (grep).
- **طريقة البناء في مرسى:** status_labels domain fin_funding_source plus a CHECK/trigger for the matrix. Wallet balances are a later phase.

#### طرق السداد السعودية وحقول المرجع حسب الطريقة (Saudi payment methods and method-specific references with validation) — 🟡 جزئي — حجم S

- **المصدر:** Payments.js paymentMethods, validatePaymentMethodReferences_, normalizePaymentNumberInput_, normalizeBankReferenceInput_
- **الوصف:** Methods: SADAD number, mada, Fasah wallet, dry-port wallet, bank transfer, cash, cheque, other. SADAD takes digits only. A bank ref must match ^[A-Z0-9]+(-[A-Z0-9]+)*$. A receipt is ≤100 chars.
- **الوضع في مرسى:** fin_payment_method = bank_transfer/cash/cheque/card/offset/other. There is a single reference field.
- **طريقة البناء في مرسى:** Add the codes sadad, mada, fasah_wallet and dry_port_wallet. Separate reference columns validated per method in the RPC and in the form.

#### منع تكرار رقم السداد/المرجع/الإيصال وهوية الفاتورة (Global duplicate prevention of payment references and invoice identity) — 🟡 جزئي — حجم S

- **المصدر:** Payments.js assertNoDuplicatePayment_, assertInvoiceIdentity_, findInvoiceIdentityConflicts_
- **الوصف:** Blocks reuse of a SADAD no, bank ref or receipt, and the message cites the earlier transaction and amount. The same issuer with the same invoice no (or the same internal id) is a hard block. The same number from another issuer needs a confirm to reuse.
- **الوضع في مرسى:** fin_number_check/fin_possible_duplicates cover invoices. There is no unique index on payment references and no internal_invoice_no.
- **طريقة البناء في مرسى:** Generated reference_norm columns with partial UNIQUE indexes. supplier_invoices.internal_invoice_no unique. Error MRS_CONFIRM_INVOICE_REUSE.

#### السداد المشترك الموزع على عدة معاملات (Shared payment allocations across transactions) — 🟡 جزئي — حجم M

- **المصدر:** Payments.js normalizePaymentAllocations_, replacePaymentAllocations_; Index.html addPaymentAllocationRow, updatePaymentAllocationTotal
- **الوصف:** One payment split over ≥2 transactions or invoices of the same issuer, with live allocated/unallocated totals. A transaction shows only its share.
- **القواعد:** Σ = total (±0.005). Each row >0 with a transaction. No duplicate transaction + invoice.
- **الوضع في مرسى:** cost_allocations split invoice lines. A payment links to exactly one supplier_invoice.
- **طريقة البناء في مرسى:** Table payment_allocations with a deferred sum check. Save RPC accepts allocations[].

#### مرفقات السداد المصنفة (فاتورة الجهة/إثبات السداد/إضافي) (Typed payment attachments) — 🟡 جزئي — حجم M

- **المصدر:** Payments.js applyPaymentAttachmentChanges_; Index.html queuePaymentAttachments
- **الوصف:** Multiple typed files per payment and per allocation, with soft removal.
- **القواعد:** PDF or image, 4MB each, 8 per save, 12MB total. In shared mode each invoice is linked to its allocation.
- **الوضع في مرسى:** finance_documents (void never delete); supplier_payments.evidence_document_id holds one file.
- **طريقة البناء في مرسى:** Link table payment_documents(payment_id, finance_document_id, role, allocation_id).

#### القراءة الآلية لفاتورة الجهة وإثبات السداد وفاتورة مواعيد فسح (AI reading of payment documents (entity invoice + payment proof, Fasah TAS appointment invoice)) — 🟡 جزئي — حجم L

- **المصدر:** PaymentDocumentAI.js analyzePaymentDocumentsV2; Payments.js analyzePaymentDocuments, paymentAiClassifyAppointmentInvoice_; R12TransportPurchases.js analyzePaymentDocumentsR12; Index.html applyPaymentAiResult
- **الوصف:** Invoice: issuer, number (Reference No for Fasah, never FP…), TAS appointment no, gate_in/gate_out, per-page amounts summed, date (Date of Payment), total, B/L, declaration, containers. Proof: beneficiary, payment channel, payer, method, date, amount, SADAD no, bank ref (not the IBAN), receipt. Only empty fields are filled, and warnings are shown.
- **القواعد:** Max 6 docs. Payment channels (Fasah, Tabadul, SADAD, mada, Visa, Apple Pay, STC Pay, urpay) are never taken as the beneficiary. Warnings for different issuers, beneficiary vs issuer, and amount mismatch. A transaction is auto-matched only when unique.
- **الوضع في مرسى:** ai-extract supplier_invoice only. No payment_proof (grep).
- **طريقة البناء في مرسى:** doc_types payment_proof and appointment_invoice (or an extended supplier_invoice), with post-processing in extract.js for TAS, FP exclusion, component sum and channel separation. One document per Claude call; merge and compare on the client.

#### توحيد رقم موعد TAS وبنود موعد الدخول/الخروج (TAS appointment number normalisation and Gate-in/Gate-out service items) — ❌ ناقص — حجم S

- **المصدر:** R12TransportPurchases.js normalizeFasahAppointmentNoR12_; R12Client r12NormalizeTas, r121NormalizeAppointmentPaymentPayload
- **الوصف:** Bidi marks are stripped and the RTL-reversed '…TAS' form is fixed, giving TAS<≥8 digits>. For appointment fees the Reference No stays in claimNo.
- **الوضع في مرسى:** No TAS handling (grep).
- **طريقة البناء في مرسى:** SQL app.norm_tas() in a trigger on port_appointments.appointment_no and in the payment RPC, mirrored in JS. Add fin_service codes gate_in_appointment and gate_out_appointment.

#### تعديل السداد وحذفه مع التدقيق (Edit/delete payment with audit) — 🟡 جزئي — حجم S

- **المصدر:** Payments.js savePaymentRecord edit path, deletePaymentRecord, appendPaymentAudit_; R115 deletePaymentRecordR115
- **الوصف:** Edits keep the creator. Deletion archives the attachments. Payments linked to Daftra cannot be deleted.
- **الوضع في مرسى:** supplier_payments are append-only, void_supplier_payment exists, and tg_bill_charge_guard protects invoiced charges.
- **طريقة البناء في مرسى:** Edit = void + re-record in one RPC (correct_supplier_payment) with a before/after fin_event. Add review_payment with four-eyes.

#### السدادات المرتبطة بالمعاملة (Payments panel inside the transaction) — 🟡 جزئي — حجم S

- **المصدر:** Index.html renderTransactionPaymentsSummary, openPaymentFromCurrentTransaction
- **الوصف:** Lists direct and allocated payments with only the share counted. Shows count, total, pending review and last date. 'Add payment' opens the form pre-linked to the transaction.
- **الوضع في مرسى:** assets/js/fin/tx-fin.js costs section.
- **طريقة البناء في مرسى:** An RPC tx_disbursements(tx_id) and a section in tx-fin.js.

#### حفظ مسودة نموذج السداد تلقائيًا (Unsaved payment form auto-draft) — ❌ ناقص — حجم S

- **المصدر:** Index.html savePaymentDraftToSession, restorePaymentDraftFromSession
- **الوصف:** The form is kept in sessionStorage per user and restored after a refresh.
- **الوضع في مرسى:** No form draft persistence in fin/*.js.
- **طريقة البناء في مرسى:** A generic MarsaDraft helper (try/catch) for the payment, custody and tx forms.

#### عهدة العملاء: إيداع وخصم وإرجاع والأرصدة والإلغاء (Customer custody ledger (deposit / deduction / refund), balances and void) — ❌ ناقص — حجم L

- **المصدر:** CustomerCustody.js saveCustomerCustodyEntry, getCustomerCustodyWorkspace, cancelCustomerCustodyEntry, custodyBuildBalances_; Index.html custodyPage
- **الوصف:** A ledger of money clients advance to the broker. A deduction links to a transaction of the same client and to one of its payments. Shows per-client balances, a ledger and totals. Entries are cancelled with a reason, never deleted.
- **القواعد:** Amount >0. A deduction ≤ the linked payment amount (or its allocation share). One active deduction per client + transaction + payment. The balance can never be negative (re-checked under a lock). The cancel reason is ≥3 chars. Legacy bug: cancelling a deposit can make the balance negative, which Marsa must block.
- **الوضع في مرسى:** No custody tables or UI (grep 0).
- **طريقة البناء في مرسى:** Table client_custody_entries with RLS for finance roles, a partial unique index on deductions, and RPCs save_custody_entry (advisory lock per client) and void_custody_entry. A balances view. View fin/custody.js at #custody. Optional balance on the client page and portal.

### العملاء والمطابقة — Customers and matching

#### دليل العملاء (كود دفترة، التصنيف، إحصاءات المطابقة) (Customer directory fields (Daftra code, category, match stats)) — 🟡 جزئي — حجم S

- **المصدر:** الرمز.js APP.customerHeaders; CustomerMatch.js readCustomerDirectory_, syncCustomerCategoryFromTransaction_
- **الوصف:** Category is airport, port or shared, can be edited on the transaction and is synced back to the client. Inactive clients are excluded from matching.
- **الوضع في مرسى:** public.clients (classification is free text) and daftra_client_links.
- **طريقة البناء في مرسى:** clients.port_category CHECK, match_count, last_matched_at and source. Sync from the tx update RPC.

#### استيراد كشف العملاء دفعة واحدة (Client bulk import (preserving manual categories)) — ❌ ناقص — حجم M

- **المصدر:** CustomerMatch.js seedCustomerDirectorySafely_
- **الوصف:** Upsert by code, then by normalised Arabic name. A manual category is never overwritten. Reports counters.
- **الوضع في مرسى:** import_batches.kind = shipments only.
- **طريقة البناء في مرسى:** RPC import_clients(p_org, rows) plus a CSV/XLSX upload. The tenant's own data is the source, never the legacy seed.

#### تنظيف اسم المستلم من كتلة العنوان (Consignee identity-name cleanup) — ❌ ناقص — حجم S

- **المصدر:** CustomerMatch.js extractCustomerIdentityName_
- **الوصف:** Strips labels, address, CR/VAT, phone and email and NOTIFY lines. Keeps ≤2 lines and ≤16 words.
- **الوضع في مرسى:** ocr-parse.js treats the consignee as one whole field.
- **طريقة البناء في مرسى:** ES5 helper MarsaOcr.identityName, or ask Claude for consignee_name and consignee_address separately.

#### مطابقة العميل تلقائيًا من المستندات (تتالي القواعد والثقة والحكم الآلي) (Automatic customer matching cascade with confidence, plus AI interpret/judge) — 🟡 جزئي — حجم L

- **المصدر:** CustomerMatch.js resolveCustomerMatchForDraft_, scoreCustomerCandidate_, interpretCustomerNameWithGemini_, callGeminiCustomerMatch_; Index.html renderCustomerMatchCard
- **الوصف:** Order: exact English name (a duplicate English name means review) -> approved alias -> exact Arabic -> phonetic/token ranking -> AI interpretation -> AI judge over the top 12. A match is never confirmed automatically.
- **القواعد:** Auto threshold 90, review 70. A strong local match is ≥88 with a 12-point margin. Only names are sent to the AI, never VAT/CR.
- **الوضع في مرسى:** match_client (VAT/CR/alias/Jaccard) in g3_registry.sql and matchPanel in admin.js. Not wired into ocr.js, with no confidence and no AI.
- **طريقة البناء في مرسى:** match_client_v2 returning confidence and method, plus assets/js/client-match.js for phonetic scoring. An optional ai-extract action 'client_match' counted in ai_usage. Wire it into the batch panel.

#### البحث اليدوي في دليل العملاء (Manual directory search from review) — 🟡 جزئي — حجم S

- **المصدر:** CustomerMatch.js searchCustomerDirectory
- **الوصف:** Ranked by code prefix, Arabic name, English name and phonetics. 15 results by default, 30 max.
- **الوضع في مرسى:** supa.js matchClient and admin search.
- **طريقة البناء في مرسى:** RPC search_clients(p_org, q, limit) using pg_trgm with a fallback and a Daftra code prefix.

#### الأسماء البديلة المعتمدة/المرفوضة وحماية هوية العميل (Learned aliases with approve/reject and identity guard) — 🟡 جزئي — حجم M

- **المصدر:** CustomerMatch.js saveCustomerAliasFromReviewedMatch_; الرمز.js buildCustomerIdentityGuardMapR1218_; R12Client r1218ApplyCustomerGuardToMatch; Index.html showSelectedCustomerMismatchWarning
- **الوصف:** Confirming a match saves the English name as an approved alias with an occurrence count. Rejected aliases are never used. An alias pointing at several clients forces a manual choice. A warning appears when the consignee does not prove the pre-selected client.
- **الوضع في مرسى:** client_aliases (unique alias_norm, source).
- **طريقة البناء في مرسى:** Add status, confidence, occurrences, last_used_at, source_ref and approved_by. RPC confirm_client_match (alias + client stats + transactions.client_id). match_client ignores rejected aliases and returns a conflict flag.

### التكامل مع دفترة — Daftra integration

#### إعداد الربط واختبار الاتصال وطبقة الطلبات الآمنة (Connection setup, read-only probe, HTTP client with redirect stop) — ✅ موجود — حجم S

- **المصدر:** DaftraIntegration.js configureDaftraConnection, testDaftraConnection, requestDaftraJson_
- **الوصف:** Subdomain plus key kept as secrets. A GET-only test. Redirects are never followed.
- **الوضع في مرسى:** daftra_connections, save_daftra_connection, request_daftra_probe, daftra-live.js call()/statusError() (20261105000100_g5_daftra.sql, 20261111000100_g5b_daftra_live.sql).
- **طريقة البناء في مرسى:** Per-org keys in Vault for more than one org. Note: the Daftra account is still set to Egypt and must be switched to KSA (SAR/15%).

#### قفل أمان الكتابة على فواتير دفترة (HF5) (Write-safety policy (HF5: no edit of existing invoices)) — 🟡 جزئي — حجم S

- **المصدر:** DaftraIntegration.js assertDaftraInvoiceWriteSafetyHF5_; R115 approvePaymentToDaftraDraftR1215
- **الوصف:** Only new drafts may be POSTed. Every later line change is done by hand in Daftra.
- **الوضع في مرسى:** guardDaftraRequest allows PUT on drafts (updateDraftInvoice).
- **طريقة البناء في مرسى:** Flag daftra_connections.allow_draft_update (owner decides the default). When false, line changes become 'manual_in_daftra' review items.

#### إنشاء مسودة فاتورة «أجور التخليص» تلقائيًا بعد اعتماد البيان (Opening zero-value clearance draft at declaration approval) — 🟡 جزئي — حجم L

- **المصدر:** DaftraIntegration.js ensureDaftraDraftInvoiceForTransaction_, buildDaftraDraftInvoiceCreatePayload_, retryDaftraDraftInvoice
- **الوصف:** One draft per transaction: line 10001 at 0 SAR, the Riyadh date, po_number reference, and customs custom fields. Idempotent. A suspended client is refused. A retry button exists.
- **القواعد:** Requires a declaration no and a linked client. A failure never undoes the approval. The draft URL is stored.
- **الوضع في مرسى:** create_billing_intent needs ≥1 approved charge. There is no declaration trigger, no suspend check and no daftra_url.
- **طريقة البناء في مرسى:** Intent payload opening=true with a charge-less 0 line. Setting auto_draft_on_declaration. Add billing_intents.daftra_url. Add a suspend check in createDraftInvoice.

#### الحقول الإضافية للبيان والشحنة في فاتورة دفترة وتحويل القيم (Customs custom fields on drafts (CustomModel field_1..field_9) and value mapping) — ❌ ناقص — حجم M

- **المصدر:** DaftraIntegration.js buildDaftraCustomModelPayload_, assertDaftraRequiredCustomFields_, mapDeclarationTypeToDaftra_, mapPortToDaftraCustomField_, collectDaftraInvoiceSupplement_; DaftraCustomModel*Test.js
- **الوصف:** Declaration no, date (DD/MM/YYYY), B/L, port, declaration type, containers or Ro-Ro identity, goods (≤1000), origin (≤250). Fields 4/5/6 are mandatory on that account. The type maps to وارد/صادر/تصفية and the port to the 7 Daftra values.
- **الوضع في مرسى:** No CustomModel anywhere (grep).
- **طريقة البناء في مرسى:** daftra_connections.custom_field_map jsonb. Values come from app.bill_job_context. daftra_value on the port and declaration-type dictionaries. A validation error 'custom_required'. An owner-only 'test draft with custom fields' probe.

#### مزامنة جميع عملاء دفترة إلى دليل العملاء (Bulk import of Daftra clients) — ❌ ناقص — حجم L

- **المصدر:** DaftraIntegration.js syncDaftraClientsCore_, mergeDaftraClientsIntoDirectory_, mapDaftraClient_; backfillMissingDaftraCustomerInternalIds_
- **الوصف:** Pages through all clients, upserting by id and then by client_number, never deleting. Aborts if 0 are returned. Records conflicts.
- **الوضع في مرسى:** Links are created one client at a time only.
- **طريقة البناء في مرسى:** Job kind client_import, staging table daftra_client_import_rows, RPCs request/list/apply_daftra_client_import, and clients.daftra_client_code.

#### استخدام أكواد منتجات دفترة القائمة ودليل بنود الخدمات (26 بندًا) (Use existing Daftra product codes (10001, 000186, 000189, 000191) and the 26-item service catalog) — 🟡 جزئي — حجم M

- **المصدر:** DaftraIntegration.js resolveDaftraProductByCode_, syncDaftraServiceItems; Payments.js defaultServiceItems; R12TransportPurchases.js repairDaftraServiceCodesR12_
- **الوصف:** Products are resolved by code, with leading zeros treated as equal. Products are never created. A catalog of 26 bilingual service items.
- **الوضع في مرسى:** daftra_item_links forces MRS- codes and fin_service has 14 codes.
- **طريقة البناء في مرسى:** Add daftra_item_links.remote_product_code text with zero-insensitive matching. An org service catalog (org_service_items) seeded with the KSA template. An RPC request_daftra_item_match.

#### تحديث فاتورة دفترة والربط اليدوي برقمها والمطابقة المركبة ومزامنة الفواتير القديمة (Invoice refresh, manual link by number, composite matching and legacy back-fill) — 🟡 جزئي — حجم M

- **المصدر:** DaftraIntegration.js syncDaftraInvoiceForTransaction, findDaftraInvoicesByNumberR12112_; الرمز.js evaluateDaftraCompositeMatchR12110HF2_, syncLegacyDaftraInvoicesCompositeR12110HF3, refreshTransactionDaftraStatusReadOnlyR1217_; Index.html renderDaftraInvoiceStrip
- **الوصف:** A read-only refresh (draft→ready, issued→billed) that runs on transaction open. Link by invoice number with visual confirmation. Exact match on declaration + B/L + containers. A batched, resumable back-fill of old invoices.
- **القواعد:** A client conflict is a hard block. More than one exact match goes to review. GET only.
- **الوضع في مرسى:** request_billing_pull, bill_apply_pull, remote_missing conflicts. Marsa only finds invoices by its own reference.
- **طريقة البناء في مرسى:** Job kinds invoice_lookup (number/composite) and legacy_scan. RPC confirm_invoice_link. A client_mismatch check on pull. Pull on tx open when stale. Also move operational_status to billed.

#### حماية تاريخ الفاتورة (توقيت الرياض) وترجمة أخطاء دفترة (Riyadh-date safety and Arabic error mapping) — 🟡 جزئي — حجم S

- **المصدر:** DaftraIntegration.js buildDaftraInvoiceDate_, assertDaftraInvoiceDateSafe_, buildDaftraArabicError_
- **الوصف:** The date is today in Asia/Riyadh and is checked after creation. Errors are mapped to Arabic with field details.
- **الوضع في مرسى:** daftra-live.js uses the UTC clock and English error codes.
- **طريقة البناء في مرسى:** Intl Asia/Riyadh in the worker, a date_mismatch review after create, and an Arabic error dictionary in bill/daftra.js.

#### قواعد أهلية ووصف بنود السداد في مسودة دفترة (Payment line descriptions and eligibility (TAS-only for appointments, transport cost excluded)) — 🟡 جزئي — حجم S

- **المصدر:** R115PaymentDaftraSync r115BuildPaymentItemDescription_, r115IsSalesDraftExcludedFee_; DaftraIntegration.js syncPaymentAppointmentToDaftraDraftR114_
- **الوصف:** Shared payments and the internal transport cost are excluded. An appointment line's description is the TAS number only. The clearance line's description is empty.
- **الوضع في مرسى:** Charges → billing_intent_lines → updateDraftInvoice.
- **طريقة البناء في مرسى:** A description template per service code in app.bill_add_lines (requires the appointment_no). Link reimbursable disbursements to client_charges (from_cost).

#### البنية التحتية لدفترة (المهام والأقفال وترقية الحالة المالية) (Daftra customer/supplier and outbox/locking infrastructure) — ✅ موجود — حجم S

- **المصدر:** DaftraIntegration.js LockService, promoteTransaction*; R115 statuses
- **الوصف:** Serialised syncs. Forward-only promotion of the financial status.
- **الوضع في مرسى:** billing_sync_jobs lease/dedupe, bill_tx_financial, tg_bill_charge_guard (g5).
- **طريقة البناء في مرسى:** Covered.

### التقارير ولوحات المتابعة والتنبيهات والواجهة — Reports, dashboards, alerts and UI

#### بطاقات الإحصاءات كفلاتر بما فيها مراحل البيان في فسح (Dashboard KPI cards as filters incl. Fasah declaration stages) — 🟡 جزئي — حجم S

- **المصدر:** Performance.js fastBuildDashboardStats_; Index.html renderDashboardStats, applyDashboardStatFilter
- **الوصف:** Counts per operational stage, drafts, the 5 Fasah stages, appointments today and transported containers. Clicking a card filters the list.
- **الوضع في مرسى:** dash_ops and rpt/dashboards.js. No Fasah-stage tiles.
- **طريقة البناء في مرسى:** RPC dash_tx_counts grouped by operational_status and declaration stage. Tiles link to #transactions?status=.

#### كشف المعاملات بالفلاتر المتقدمة وفلاتر الأعمدة وعمود دفترة (Transactions register with advanced filters, Excel-style column filters, Daftra column, quick filters) — 🟡 جزئي — حجم M

- **المصدر:** الرمز.js listTransactions, applyTransactionFilters_; Index.html TRANSACTION_EXCEL_COLUMNS, renderTransactionsR12120, transactionQuickFiltersR12120
- **الوصف:** 23-field search. Filters for category, Daftra code, operator, agent, vessel, employee, container-count range and date field. Excel popovers with value lists and date trees. A Daftra state column, a container tooltip, stage row colours, 'Daftra drafts only'.
- **الوضع في مرسى:** search_records/report_transactions keys (20261106000100_g6a_portal_reports.sql) and rpt/search.js. No column filters (grep).
- **طريقة البناء في مرسى:** Extend rpt_search_keys. A generic assets/js/rpt/colfilter.js reused across transactions, movements and payments. A light join to billing_intents.

#### شارات التأخير والمتابعة حسب الحالة (Attention / SLA badges per status) — 🟡 جزئي — حجم M

- **المصدر:** الرمز.js transactionAttentionRulesR12119_, buildMovementAttentionMapR12119_; Index.html TRANSACTION_ATTENTION_RULES_R12120
- **الوصف:** Per-status idle hours (new 24/48, active 48/96, complete 24/48, transport 24/48, under billing 48/96). Appointment passed and not updated: 6h warning, 12h critical. An overdue empty return is always critical. Effective status comes from Daftra. Banner and 'late only' toggle.
- **الوضع في مرسى:** operational_alerts/refresh_alerts (appointment_missed, empty_return_overdue, declaration_stalled).
- **طريقة البناء في مرسى:** Alert kinds status_stale and appointment_not_updated with an org-overridable app.status_aging_rules. A tx_attention RPC for list and export.

#### لوحة وتقرير المواعيد والنقل مع الإجماليات (Appointments & transport dashboard/report with totals) — 🟡 جزئي — حجم M

- **المصدر:** Performance.js fastBuildMovementDashboard_; الرمز.js applyMovementFilters_, buildMovementsExportSheet_; Index.html loadMovementDashboard
- **الوصف:** Filters: driver, truck, port, destination, booking ref, operator, employee, return scope, value/revenue ranges. Totals: appointments, cancelled, delivered containers, transport value, revenue, overdue returns. 19-column export.
- **الوضع في مرسى:** report_trips/report_containers and schedule.js.
- **طريقة البناء في مرسى:** RPC report_movements plus a 'movements' def in rpt/reports.js and export.js.

#### كشف النقل حسب جهة النقل والسائق (Transport report by party and driver) — 🟡 جزئي — حجم S

- **المصدر:** R12TransportPurchases.js getTransportReportR12; R12Client r12RenderReport
- **الوصف:** Per-trip rows with summaries grouped by party and by driver.
- **الوضع في مرسى:** report_trips with no grouping.
- **طريقة البناء في مرسى:** Add by_carrier and by_driver totals plus a driver filter and q.

#### كشف السدادات (Payments report (screen/print/PDF/Excel)) — ❌ ناقص — حجم M

- **المصدر:** Payments.js getPaymentsReportR1218; الرمز.js buildPaymentsExportSheet_; R12Client r1218*
- **الوصف:** Filters: date, client, fee, funding source, method, review status, movement type, free text. Totals: count and amount paid.
- **الوضع في مرسى:** No payments report def in rpt/reports.js.
- **طريقة البناء في مرسى:** RPC report_payments plus a def in rpt/export.js.

#### تصدير كشف متابعة المعاملات (Transactions follow-up export (with vessel/operator/agent/attention/Daftra columns)) — 🟡 جزئي — حجم S

- **المصدر:** الرمز.js buildTransactionsExportSheet_, exportReportFile
- **الوصف:** 14 columns plus the attention colours. PDF A4 landscape or XLSX for exactly the filtered rows.
- **الوضع في مرسى:** rpt/export.js (xlsx/csv/print, audited).
- **طريقة البناء في مرسى:** Add the columns. PDF via print CSS.

#### المطابقة الشهرية مع تقارير فسح (Monthly Fasah reconciliation (multi-XLSX vs system)) — ❌ ناقص — حجم L

- **المصدر:** FasahMonthlyReconciliation_*.js analyzeFasahMonthlyReportsR116, fasahR116Compare_; Index.html fasahReconciliationPage
- **الوصف:** Up to 20 .xlsx files (≤10MB). Header row auto-detected. Ports mapped. Rows deduped by serial. Match on declaration + port. Statuses: matched, matched_with_note, status_mismatch, missing, port_mismatch, ambiguous, plus system-only records. Per-port and per-file summaries. Read-only.
- **الوضع في مرسى:** No reconciliation feature exists. xlsx-lite.js can be reused.
- **طريقة البناء في مرسى:** Client parsing in assets/js/rpt/fasah-recon.js plus RPC report_fasah_scope(p_org, nos[], scopes) under RLS. Needs port_code. Exportable with audit.

#### مؤشر زمن الاستجابة وشاشة التقدم (Performance indicator and progress overlay with learned ETA) — ❌ ناقص — حجم S

- **المصدر:** Index.html recordResponseTime, OPERATION_PROGRESS, storeOperationDuration, translateTechnicalMessage
- **الوصف:** Header response-time badge and a progress modal with a learned ETA and cancel. Technical errors are translated to Arabic.
- **الوضع في مرسى:** Not in app-shell.js or supa.js.
- **طريقة البناء في مرسى:** Optional UX in app-shell.js with localStorage durations.

#### إرجاع البيانات المحدثة مع كل حفظ (Write RPCs return refreshed state) — 🟡 جزئي — حجم S

- **المصدر:** Performance.js *Fast functions
- **الوصف:** A save returns the record, lists and stats in one response.
- **الوضع في مرسى:** Per-entity RPCs; the UI re-queries. Step 8: its write RPCs (aging rules, OTP switch) return the refreshed state; earlier steps deferred (قرارات المالك 2026-11-11، مراجعة المرحلة 8 (7)).
- **طريقة البناء في مرسى:** Return the updated row from the new RPCs.

### الدخول والتدقيق والمنصة — Auth, audit and platform

#### الدخول برمز عبر البريد لقائمة مصرّح بها (Email OTP passwordless login (allow-listed)) — 🟡 جزئي — حجم S

- **المصدر:** Auth.js requestLoginCode, verifyLoginCode, requireAuthorizedUser_; Index.html loginPage
- **الوصف:** A 6-digit code valid 10 minutes, a 60s cooldown and 5 attempts, with no user enumeration. The session lasts 12h.
- **الوضع في مرسى:** Password + invitations + TOTP MFA (auth.js, mfa.js, 20261109000100_mfa.sql). No signInWithOtp (grep).
- **طريقة البناء في مرسى:** Optional signInWithOtp({shouldCreateUser:false}) tab in login.html.

#### المستخدمون المصرح لهم وتفعيلهم (Authorized users and deactivation) — ✅ موجود — حجم S

- **المصدر:** Auth.js getAuthorizedUsersDirectory_
- **الوصف:** Name, email and active flag.
- **الوضع في مرسى:** memberships.is_active, invitations, admin users.
- **طريقة البناء في مرسى:** Map the legacy users to invitations.

#### سجل العمليات مع وصف التغيير (Operations audit log with business labels and field diff) — 🟡 جزئي — حجم S

- **المصدر:** Audit.js recordSystemAuditEvent; Index.html AUDITED_SERVER_ACTIONS, buildTransactionAuditDetails
- **الوصف:** Labelled business events with an Arabic field-level diff ('من X إلى Y') and container changes.
- **الوضع في مرسى:** audit_log filled by triggers (tg_audit) and the admin audit view.
- **طريقة البناء في مرسى:** An Arabic diff renderer over old_row/new_row, plus optional app.audit_event labels written inside the RPCs.

#### أقفال التزامن ودوال الترقية الخاصة بالمالك (Concurrency locks and owner upgrade routines) — ✅ موجود — حجم S

- **المصدر:** LockService usages; upgradeTo* functions in all files; assertManualOwnerExecution_
- **الوصف:** 30s locks. Versioned upgrades with hidden backups.
- **الوضع في مرسى:** Postgres transactions, FOR UPDATE, idempotency_keys, migrations plus schema_versions/health_check.
- **طريقة البناء في مرسى:** Not ported. Each new migration bumps schema_versions.
