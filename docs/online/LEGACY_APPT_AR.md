# نقل النظام القديم — الخطوة 5: بطاقات المواعيد وإعادة الفارغ (جانب قاعدة البيانات والقراءة الآلية)

الملف: `supabase/migrations/20261121000100_legacy_appt.sql` (يتطلب `20261120000100_legacy_decl`). الاختبارات:
`supabase/tests/legacy-appt-sql-tests.js` (قاعدة البيانات) و`supabase/tests/ai-docs-tests.js` (القسم 7g، عميل Claude وهمي).
الخطة: `docs/online/LEGACY_PORT_PLAN_AR.md` (القسم «المواعيد والنقل وإعادة الفارغ»)، الخطوات السابقة: `LEGACY_CORE_AR.md`
و`LEGACY_TX_AR.md` و`LEGACY_DOCS_AR.md` و`LEGACY_DECL_AR.md`.

> **قاعدة ثابتة:** كل قيمة يقرؤها Claude تبقى **مسودة** حتى يعتمدها موظف. بطاقة الموعد لا تصبح حركة إلا عبر
> `approve_appointment_draft`، وإيصال إعادة الفارغ **لا يُعتمد آليًا** أبدًا: يبقى إثباتًا بانتظار المراجعة حتى يؤكده موظف عبر
> `verify_empty_return_proof`. كل اعتماد مسجَّل في سجل التدقيق.

## قرارات المالك المطبّقة
- الفوترة بدون إثبات إعادة الفارغ **ممنوعة**: `set_transaction_status('under_billing')` لم يتغير ويبقى يرفض بـ
  `MRS_CONTAINERS_NOT_RETURNED`. السياسة `empty_return_blocks_billing` = true علامة للقراءة فقط (`app.empty_return_blocks_billing`)
  تظهر في `tx_readiness`، ولا يستطيع المستأجر إيقافها في هذه المرحلة.
- إيصال EIR المقروء بـ Claude **لا يُعتمد آليًا** (لم يُنقل التطبيق التلقائي القديم `analyzeAndSaveEmptyReturnProofR12110`).
- (2026-11-11) أمر النقل لشركة **TASTO لا يتجاوز** إثبات الإعادة: تبقى المعاملة محتاجة إلى إيصال الناقل معتمدًا قبل «تحت الفوترة».
- لا تعديل لمسودات دفترة القائمة. البحث في موردي دفترة ومسودة مشتريات النقلة في الخطوة 7 (أُضيفت الأعمدة فقط).

## طريقة التطبيق على قاعدة حية
1. قاعدة بها legacy_decl (`health_check()` = 20261120000100): الصق الملف وحده في SQL Editor ثم Run. الملف قابل لإعادة التشغيل.
2. انشر الدالة `ai-extract` (`python3 scripts/bundle-edge-function.py ai-extract`). النموذج يبقى `claude-opus-5-5` بنفس استدعاء
   SDK (`client.beta.messages.stream` ثم `finalMessage()` مع `output_config` و`fallbacks: 'default'`).
3. إذا أعدت لصق 20261101000100 أو 20261114000100 أو 20261116000100 أو 20261119000100 أو 20261120000100 فالصق هذا الملف بعده.

## 1. القراءة الآلية `ai-doc-v3`
### بطاقة الموعد `appointment_ticket`
- تحتاج `transaction_id` (وإلا `transaction_required`)، ولكل ملف استدعاء واحد و`ai_reserve` واحد. العميل يقرأ حتى 20 بطاقة
  بتوازي 2–3.
- المخطط: `doc_type` و`document_title` و`invoice_signals` و`fields` و`entry` و`exit` و`warnings`. الحقول: رقم الحجز TAS
  (`appointment_booking_ref`)، رقم تذكرة المشغل، المشغل، التاريخ والوقت، اللوحة، السائق، الجوال، المنطقة/البوابة، الباركود،
  نوع الحركة، تعليمات البوابة (`appointment_gate_instructions`)، رخصة السائق (`driver_license`)، مرجع المركبة
  (`vehicle_ref_id`) ورقمها التسلسلي (`vehicle_serial_id`) — 16 مفتاحًا مع مفتاحي الإيصال.
- قواعد الخادم (من `normalizeAppointmentDraft_` و`normalizeAppointmentTasR1212_` و`r112LooksLikeRealAppointmentTicket_`):
  - رقم الحجز `TAS` + الأرقام؛ الوقت المحلي يتحول إلى `appointment_at` بتوقيت الرياض (+03:00)؛ الجوال `05XXXXXXXX`.
  - نوع الحركة من الأقسام: بيانات المعاملة في قسم الخروج → `full_exit`، في الدخول فقط → `empty_entry`.
  - **لا يُخمَّن** الوجهة ولا سعر النقل ولا عائد المؤسسة ولا مكان وموعد إعادة الفارغ.
  - الرفض `wrong_document_type` (HTTP 422 بعد تسوية الحصة) بسبب: `appointment_invoice` (فاتورة موعد فسح / TAS)،
    `not_appointment_ticket` (مستند آخر)، `not_ticket_structure` (لا وقت أو لا رقم حجز أو لا إشارة تشغيلية؛ مرجع المركبة
    أو رقمها التسلسلي إشارة تشغيلية كما في `r112LooksLikeRealAppointmentTicket_`).
- الاستجابة تضيف `appointment` {booking_ref, operator_ticket_no, operator_name, appointment_at, appointment_local, truck_plate,
  driver_name, driver_phone, zone_gate, barcode, movement_type, container_no, document_title, entry, exit, structural,
  gate_instructions, driver_license, vehicle_ref_id, vehicle_serial_id}.

### إيصال إعادة الفارغ `empty_return_receipt`
- حتى 8 ميجابايت. المخطط: `doc_type` و`document_title` و`movement` (`empty_return` / `full_out` / `other`) و`time_printed`
  و`fields` (`container_numbers`، `return_delivered_at`، `return_depot`) و`warnings`.
- التاريخ بلا وقت (أو `time_printed` = false) → `delivered_at` فارغ مع التحذير `eir_time_missing`: **لا يكفي إثباتًا**.
- رقم الحاوية يُتحقق منه بخانة ISO 6346. الثقة = أدنى ثقة بين الحقول الثلاثة.
- خروج حاوية ممتلئة أو مستند آخر → `wrong_document_type` (`not_empty_return` / `not_empty_return_receipt`).
- الاستجابة تضيف `empty_return` {container_no, delivered_at, delivery_date, time_printed, depot, confidence, movement}.

## 2. الأعمدة الجديدة
- `port_appointments`: `booking_ref`، `operator_ticket_no`، `operator_name` (المشغل كما قُرئ أو رُوجع)، `zone_gate`، `barcode`،
  `movement_type`، `source_document_id`، `extraction_id` (يكتبها `approve_appointment_draft` فقط).
- `app.movement_json` (من 20261118000100) أُعيد إنشاؤه ليعرض هذه الحقول وجهة النقل للرحلة في `list_movements` و`save_movement`.
- `transport_trips`: `party_type` (`supplier` / `company` / `direct`)، `party_name`، `transport_order_no` (ضمن صلاحية القراءة؛ مبالغ
  التكلفة والبيع خارجها كما كانت).

## 3. مسودات بطاقات المواعيد
الجداول `appointment_drafts` (دفعة لكل معاملة) و`appointment_draft_cards` (بطاقة لكل ملف). مسودة مفتوحة واحدة لكل معاملة.
- حالات الدفعة: `pending` → `partial` (اعتماد جزئي) → `approved`؛ أو `cancelled` أو `moved`.
- حالات البطاقة: `pending`، `approved` (تم الحفظ)، `skipped` (ليست خروج حاوية ممتلئة)، `failed` (فشل الاعتماد، قابلة للتعديل
  وإعادة المحاولة)، `discarded` (استبعدها الموظف)، `cancelled`.
- الحدود: 20 بطاقة و25 ميجابايت لكل دفعة (`MRS_APPT_DRAFT_LIMIT`).
- RPCs:
  - `appointment_card_state(p_org, p_tx, p_sha256s)`: حالة كل ملف في المؤسسة قبل القراءة.
  - `save_appointment_draft(p_tx, p_payload)`: الإنشاء والحفظ التلقائي لتعديلات المراجعة (`version` للحماية من التعارض).
  - `get_appointment_draft(p_tx, p_batch)`: الاستعادة بدون إعادة قراءة.
  - `cancel_appointment_draft(p_batch, p_reason)`: الإلغاء يحرر البطاقات لإعادة الرفع.
  - `move_appointment_draft(p_batch, p_target_ref, p_reason)`: النقل إلى معاملة أخرى برقمها، أو الدمج في مسودتها المفتوحة.
  - `approve_appointment_draft(p_batch, p_payload)`: اعتماد بطاقة ببطاقة عبر `save_movement` (الخطوة 2). النتيجة لكل بطاقة:
    `saved` / `already_existed` / `skipped` / `failed`.
- القواعد: خروج حاوية ممتلئة فقط يصبح حركة؛ الحاوية من حاويات المعاملة (`MRS_APPT_CONTAINER_NOT_IN_TX`)؛ جهة النقل مطلوبة لكل
  بطاقة (`MRS_APPT_PARTY_REQUIRED`، والمباشر يأخذ اسم السائق)؛ المسودة المعتمدة أو المعتمدة جزئيًا لا تُلغى ولا تُنقل
  (`MRS_APPT_DRAFT_APPROVED`)؛ مبالغ النقل في المراجعة لأدوار مالية الرحلات فقط.

## 4. قواعد إعادة القراءة
- بصمة الملف (SHA-256) تُفحص في كل المؤسسة: `app.appointment_fingerprint_state(org, sha)` → `free` / `pending` / `approved` /
  `released`.
- بطاقة معتمدة في حركة قائمة → `MRS_APPT_CARD_DUPLICATE approved`. بطاقة بانتظار الاعتماد في مسودة معاملة أخرى →
  `MRS_APPT_CARD_DUPLICATE pending_other` ويُعرض نقل تلك المسودة (`can_move`).
- إلغاء الموعد يُبطل ربط البطاقة (`link_voided_at`) فتصبح قابلة لإعادة القراءة؛ إعادة الجدولة تنقل الربط إلى الموعد الجديد؛
  إلغاء المعاملة يلغي مسوداتها المفتوحة ويحرر بطاقاتها.

## 5. سجل إثباتات إعادة الفارغ `empty_return_proofs`
- الحالات: `pending_review`، `approved`، `unreadable`، `voided`. الملف مستند للمعاملة (صورة أو PDF حتى 8 ميجابايت، وإلا
  `MRS_EMPTY_RETURN_FILE`).
- `create_empty_return_proof(p_tx, p_payload)`: من قراءة EIR أو يدويًا. **لا يلمس الحاوية**. التاريخ بلا وقت يُرفض
  (`MRS_DATETIME_REQUIRED`)؛ الحاوية غير الموجودة في المعاملة تُسجَّل في `match_notes`.
- `verify_empty_return_proof(p_proof, p_payload)`: تأكيد الموظف فقط. يحتاج الحاوية والتاريخ والوقت والمستودع. يصنّف المستند
  إيصال إعادة فارغ مؤكدًا، ثم يكتب الإعادة على الحاوية بالمسار القائم (`returned_verified` + مستند الإثبات + وقت التسليم).
- `void_empty_return_proof(p_proof, p_reason)`: إلغاء منطقي. يُرجع حالة الحاوية فقط إذا لم يبقَ إثبات معتمد آخر؛ وبعد الانتهاء
  التشغيلي يُرفض (`MRS_EMPTY_RETURN_LOCKED`). الإثبات الملغى لا يُعدَّل (`MRS_EMPTY_RETURN_CLOSED`).
- `save_empty_return_deadline(p_container, p_deadline)`: آخر موعد للإعادة فقط (عبر `set_container_return`).
- `list_empty_return_proofs(p_tx)`: كل الإثباتات مع الجاهزية.

## 5b. مهلة إرجاع الحاوية الفارغة وطلب التمديد من الوكيل الملاحي (`20261128000100_return_extension.sql`)
طلب المالك: بعد البيان نتابع مهلة إرجاع الحاوية الفارغة، وعند اقترابها ينبّهنا البرنامج بأن نطلب **تمديدًا** من الوكيل الملاحي،
ويجهّز رسالة الطلب ونحن نعتمدها ونرسلها.
- **البرنامج لا يرسل البريد بنفسه.** يجهّز الرسالة (عربي ثم إنجليزي)، والموظف يفتحها في بريده («فتح في البريد» = رابط
  `mailto:`) أو ينسخها («نسخ النص») ويرسلها بنفسه — ويفضّل من `ops@marsacloud.com` ليصل رد الوكيل إلى صندوق الوارد ويرتبط
  بالمعاملة (الموضوع يحمل رقم المعاملة + البوليصة + أول حاوية) — ثم يضغط «تم الإرسال». لا يُكتب أي سجل في صندوق الوارد
  (`msg_outbound`) ولا يُستدعى SMTP ولا الذكاء الاصطناعي، وقاعدة «موظفان» (four-eyes) في صندوق الوارد لم تتغير.
- القاعدة في إعدادات المؤسسة `empty_return_rules`: `lead_days` (التنبيه قبل الموعد بـ 1..30 يومًا، الافتراضي 3 = السلوك
  السابق) و`default_request_days` (أيام التمديد الافتراضية 1..30، الافتراضي 7). `get_empty_return_rules(p_org)` للموظفين،
  `set_empty_return_rules(p_org, p_rules, p_reason)` لمالك المؤسسة مع سبب. الواجهة: «قواعد المتابعة» ← «مهلة إرجاع الحاويات
  الفارغة وطلب التمديد».
- نص الرسالة: افتراضي ثابت أو نص المؤسسة `set_return_extension_template(p_org, p_tpl, p_reason)` بالمتغيرات الثابتة فقط
  (`{{tx_ref}}`، `{{bl_number}}`، `{{agent_name}}`، `{{agent_name_en}}`، `{{container_list}}`، `{{container_first}}`،
  `{{container_count}}`، `{{current_deadline}}`، `{{requested_days}}`، `{{requested_until}}`، `{{org_name}}`، `{{signature}}`،
  `{{today}}`)؛ متغير غير معروف ← `MRS_INVALID placeholder`.
- التنبيهات (`app.alert_causes`): `empty_return_due` يبدأ قبل الموعد بـ `lead_days` (بتوقيت الرياض) و`empty_return_overdue` بعده،
  والعنوان يقول الخطوة التالية: «اطلب تمديدًا من الوكيل الملاحي» / «طلب التمديد جاهز ولم يُرسَل بعد» / «طلب التمديد مُرسَل
  بانتظار رد الوكيل الملاحي». تنبيه جديد `empty_return_no_deadline`: حاوية خرجت من الميناء بلا موعد إرجاع. في «التنبيهات» زر
  «تجهيز طلب تمديد» / «متابعة طلب التمديد» / «إدخال موعد الإرجاع» يفتح المعاملة على هذا القسم.
- الجدول `return_extension_requests` والدوال:
  - `prepare_return_extension(p_tx, p_payload)`: مسودة الطلب. الحاويات افتراضيًا المستحقة خلال `lead_days` أو المتأخرة (المُعادة أو
    المعفاة مرفوضة `MRS_INVALID container_ids`، وبلا موعد `MRS_REQUIRED return_deadline`)، الوكيل من البوليصة (أكثر من وكيل ←
    `MRS_REQUIRED bl_id` واختيار الوكيل)، البريد من سجل الوكيل (لا يوجد ← `missing_email`). ينشئ استثناء «تمديد مهلة الحاوية»
    (`detention_extension`) بحالة «قيد المعالجة». طلب مفتوح واحد لكل وكيل، والحاوية في طلب مفتوح واحد (`MRS_RX_EXISTS`).
  - `update_return_extension(p_id, p_payload)`: تعديل المسودة (الحاويات، الأيام / التاريخ، البريد، الموضوع، النص).
  - `mark_return_extension_sent(p_id, p_note)`: «تم الإرسال» — إقرار الموظف بأنه أرسلها (يلزم البريد `MRS_REQUIRED to_address`).
  - `decide_return_extension(p_id, p_payload)`: رد الوكيل. الموافقة (أو الموافقة الجزئية) تنقل موعد الإرجاع للحاويات المفتوحة
    عبر `set_container_return` (المُعادة أو المعفاة تُترك)، والرفض يُبقي الموعد ويستمر التنبيه؛ يُغلق الاستثناء. لا يلمس
    `demurrage_cases` (تنبيه للمالية `demurrage_hint`).
  - `cancel_return_extension(p_id, p_reason)`، `list_return_extensions(p_org, p_filters)`.
  - حدث جديد في سجل المعاملة `return_extension` (داخلي، لا يظهر للعميل).
- الواجهة: قسم «إعادة الفارغ» في صفحة المعاملة ← «طلب تمديد مهلة إرجاع الفارغ من الوكيل الملاحي»؛ لوحة التحكم: «طلبات تمديد
  بانتظار رد الوكيل الملاحي». حفظ بريد الوكيل في سجله اختياري وبعد تأكيد.
- خارج النطاق (خطوات لاحقة): سجل إذن التسليم / الإفراج من الميناء، وحساب المهلة آليًا من أيام السماح للخط الملاحي.

## 6. أمر النقل لشركة (TASTO)
- `save_transport_carrier_order(p_tx, p_payload)`: الرقم `^TASTO\d+$` (`MRS_TASTO_INVALID`) وفريد في المؤسسة (`MRS_TASTO_TAKEN`)،
  التاريخ والشركة مطلوبان، وغير مسموح قبل الفسح الجمركي: مراحل جديد وقيد العمل والبيان الجمركي (= «جديد» و«نشطة» في النظام
  القديم) → `MRS_TASTO_STAGE`. نفس الأمر مرة أخرى → `already_exists`.
  يُسجَّل حدث ملاحظة داخلي («تسجيل أمر نقل شركة» / «تعديل أمر نقل شركة»).
- **لا ينقل المعاملة إلى «تحت الفوترة» ولا يتجاوز إثبات الإعادة.**

## 7. الجاهزية `tx_readiness(p_tx)`
تعيد: السياسة، الحاويات المتبقية (مع آخر موعد والتأخر وعدد الإثباتات المعلقة)، الحاويات المعلنة غير المسجلة،
`billing_gate_open`، `blocking`، عدد الإثباتات، الحركات، أمر النقل لشركة (إن وجد). البوابة نفسها تبقى في `set_transaction_status`.

## 8. الأمان
- RLS على الجداول الثلاثة؛ القراءة لموظفي فرع المعاملة؛ لا صلاحية كتابة مباشرة ولا حذف؛ عمود `review` في البطاقات خارج صلاحية
  القراءة المباشرة (فيه مبالغ النقل).
- كل RPC: `SECURITY DEFINER` مع `search_path = ''`، والرفض عبر `app.fail('MRS_*')`.
- سجل التدقيق لا يحفظ محتوى المستند (القراءة، المراجعة، النتيجة، المستودع، الملاحظات).
- قوائم التحويل إلى الإنتاج تشمل الجداول الثلاثة (74 جدولًا، 35 حماية).

## رموز الأخطاء الجديدة
`MRS_APPT_DRAFT_EXISTS`، `MRS_APPT_DRAFT_CLOSED`، `MRS_APPT_DRAFT_APPROVED`، `MRS_APPT_DRAFT_STALE`، `MRS_APPT_DRAFT_LIMIT`،
`MRS_APPT_CARD_DUPLICATE`، `MRS_APPT_CONTAINER_NOT_IN_TX`، `MRS_APPT_PARTY_REQUIRED`، `MRS_DATETIME_REQUIRED`،
`MRS_EMPTY_RETURN_CLOSED`، `MRS_EMPTY_RETURN_LOCKED`، `MRS_EMPTY_RETURN_FILE`، `MRS_TASTO_INVALID`، `MRS_TASTO_TAKEN`،
`MRS_TASTO_STAGE`؛ وفي الواجهة `MRS_AI_WRONG_DOCUMENT` (رمز الدالة `wrong_document_type`).

## 9. الواجهة (UI)
- **شاشة بطاقات المواعيد** `assets/js/appt-cards.js` على `ocr.html#appt-tx=<المعاملة>` (القسم `#appt-section`، للموظفين فقط):
  رفع حتى 20 بطاقة / 25 ميجابايت؛ فحص البصمات قبل أي قراءة (`appointmentCardState`): المعتمدة تُمنع، والمعلقة في معاملة
  أخرى يُعرض نقل مسودتها (`moveAppointmentDraft` إلى رقم هذه المعاملة)، والموجودة في المسودة لا تُعاد قراءتها، والمستبعدة
  تُستعاد دون قراءة. القراءة بتوازي 2 (`aiExtract` `appointment_ticket`)، ورفض فاتورة الموعد أو المستند الآخر يظهر لكل بطاقة
  ولا يُحفظ. القراءة تُحفظ (`document_extractions` بنوع `appointment`) وملف البطاقة مستند للمعاملة (نوع `appointment`).
  جدول المراجعة: صف لكل بطاقة، تعديل مباشر يُحفظ تلقائيًا بعد 450 مللي ثانية مع `version`، منتقي حاوية من حاويات المعاملة فقط،
  جهة النقل مطلوبة، نوع الحركة، تفاصيل إضافية (رقم التذكرة، المشغل، البوابة، الباركود، الوجهة، إعادة الفارغ، ومبالغ النقل لأدوار
  مالية الرحلات). الاستعادة عند إعادة الفتح دون قراءة، الإلغاء بسبب، النقل برقم المعاملة، واعتماد الكل أو المحدد خلف نافذة تأكيد
  مع مفتاح عدم التكرار ونتيجة لكل بطاقة.
- **صفحة المعاملة** (`admin.html#tx/<id>`):
  - `assets/js/ops/tx-appt.js`: شريط الجاهزية (`tx_readiness`، القسم `readiness` أول الصفحة): الحاويات التي تنقصها إعادة مؤكدة
    وسبب إيقاف الفوترة والسياسة الثابتة؛ ملخص مسودة البطاقات ورابط الشاشة (`appointment_cards`)؛ نموذج أمر النقل لشركة TASTO
    (`carrier_order`) مع تنبيه أنه لا يغني عن إثبات إعادة الفارغ.
  - `assets/js/ops/tx-return.js`: إثباتات إعادة الفارغ (`empty_return`، المرساة `#tx-empty-return`): قراءة EIR بـ Claude → إثبات
    بانتظار المراجعة فقط، إثبات يدوي (أو «غير مقروء»)، السجل بالحالات والثقة والملاحظات، «تأكيد إعادة الفارغ» لموظفي النقل
    والتخليص والمديرين خلف نافذة تأكيد، الإلغاء بسبب، وحفظ آخر موعد للإعادة فقط.
- النصوص: `assets/i18n/appt.js` (عربي + إنجليزي)، التنسيق: `assets/css/pages/appt.css` (375px بلا تمرير للصفحة، الجداول
  تتمرر داخل إطارها). الاختبارات: `supabase/tests/legacy-appt-ui-tests.js`.

## 10. إصلاحات المراجعة (الخطوة 5)
- **القيم المالية لا تُمسح:** إذا حفظ مستخدم بلا صلاحية مالية الرحلات مراجعة البطاقة تبقى قيمة النقل والعائد اللتان أدخلهما
  المستخدم المالي (`save_appointment_draft` يدمجهما). البطاقة تُظهر `amounts_hidden` لغيره، ويعتمدها مستخدم مالي (غيره يحصل
  على `MRS_FORBIDDEN cost` لتلك البطاقة فقط).
- **نطاق القراءة:** `extraction_id` يجب أن تكون قراءة هذه المعاملة أو غير مربوطة بمعاملة (كما في إثبات الإعادة)، والاعتماد لا
  يربط ولا يعلّم قراءة معاملة أخرى.
- **نوع الحركة غير المعروف** يفشل بـ `MRS_REQUIRED movement_type` ويبقى قابلًا للتعديل؛ «متجاهلة» لبطاقة الدخول الفارغ فقط.
- **المشغل** يُحفظ في `port_appointments.operator_name`، وتعليمات البوابة ورخصة السائق ومرجع المركبة ورقمها التسلسلي تُدمج في
  ملاحظات الحركة.
- **النقل:** مسار ملف المستند مربوط بمعاملته (`documents_path_chk`) فلا يُنقل الملف؛ تحفظ البطاقة معاملتها الأصلية
  (`origin_transaction_id`) ويربط الاعتماد ملفها وقراءتها منها. إن كان الملف نفسه موجودًا في المعاملة الهدف (شاشة البطاقات ترفعه
  قبل «نقل تلك المسودة إلى هذه المعاملة») تشير البطاقة إليه.
- **إعادة القراءة:** الفهرس الفريد للملف داخل الدفعة يشمل البطاقات الحية فقط (`pending` / `failed` / `discarded`)، فملف حُرِّر
  بإلغاء موعده يُقرأ ثانية في الدفعة نفسها، والدمج عند النقل لا يصطدم بخطأ فهرس خام: بطاقة مستبعدة في الهدف تُلغى، وبطاقة حية
  بالملف نفسه → `MRS_APPT_CARD_DUPLICATE pending`.
- **البوليصة والبيان:** الدفعة تحمل `bl_numbers` و`declaration_numbers` للمعاملة، والواجهة تنبّه عند بطاقة بوليصتها أو بيانها لا
  يطابق المعاملة (تنبيه لا يمنع، كما في النظام القديم).
- **الواجهة:** لا اعتماد أثناء قراءة البطاقات ولا بعد حفظ تلقائي فاشل؛ الرفع مشروط بصلاحية النقل في فرع المعاملة؛ فشل قراءة
  EIR (`MRS_AI_FAILED` / `REFUSED` / `TRUNCATED` / `UNSUPPORTED`) يحفظ الملف ويسجّل إثباتًا «غير مقروء» لاستكماله؛ أخطاء النموذج
  اليدوي تظهر داخله ولا تمسح الملف والقيم؛ شريط الجاهزية أعلى صفحة المعاملة (`placement: 'top'`)؛ قائمة الحركات تعرض رقم الحجز
  والمشغل والبوابة وجهة النقل وأمر النقل.
