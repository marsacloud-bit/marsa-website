# مواءمة دفترة — المرحلة 7 من نقل النظام القديم (قاعدة البيانات + عقد المهام)

> **الحالة:** بيئة الاختبار (staging) فقط. لا اتصال بدفترة الحقيقية، ولا نشر، ولا مفاتيح.
> ملف الترحيل:
> `supabase/migrations/20261123000100_legacy_daftra.sql`
> (يتطلب `20261122000100_legacy_pay.sql`، ومضاف في آخر `supabase/all_migrations.sql`)
> الاختبارات: `supabase/tests/legacy-daftra-sql-tests.js` (نتائج العامل مصنوعة يدويًا بدور `service_role`).
> العامل: `supabase/functions/daftra-sync` (`worker.js`، `adapter.js`، `mock-adapter.js`، `daftra-live.js`) — ينفذه وكيل العامل وفق **«عقد المهام»** أدناه.
> الخطة: `docs/online/LEGACY_PORT_PLAN_AR.md` (المرحلة 7 «Daftra alignment» وقسم «التكامل مع دفترة»).

## 1) قرارات المالك (ملزمة) وأين تُطبق

| القرار | في القاعدة | في العامل |
|---|---|---|
| **لا تعديل لمسودة / فاتورة دفترة قائمة (HF5)** — مسودات جديدة فقط | `daftra_connections.allow_draft_update` = `false` افتراضيًا. بعد وجود المسودة: أي سطر يُضاف / يُحذف → بند مراجعة واحد `manual_in_daftra` يسرد ما يُعدَّل يدويًا. `request_billing_push` → `MRS_DAFTRA_DRAFT_LOCKED manual_in_daftra`. نتيجة عامل فيها `updateDraftInvoice` مطبّق → مرفوضة (`MRS_INVALID draft_update_disabled`). | لا `PUT` ولا `POST` على فاتورة موجودة؛ `guardDaftraRequest` يرفض كل كتابة على `invoices/{id}` عندما `policy.allow_draft_update = false`. |
| **الأصناف تُحل بالكود ولا تُنشأ أبدًا** | `allow_product_create` = `false`. كل بند بلا ربط مؤكد (`remote_product_code` + `external_product_id`، الحالة `linked`) يمنع المسودة: `MRS_DAFTRA_UNMAPPED items` والتلميح قائمة المفاتيح. نتيجة فيها `createProduct` → `MRS_INVALID product_create_disabled`. | `policy.products = 'resolve_only'`: البحث بالكود مع تجاهل الأصفار البادئة (`000186 = 186`)، ولا `POST products`. |
| **حساب دفترة مضبوط على مصر** — حارس قبل أي كتابة | `account_profile` من فحص الاتصال؛ `app.daftra_account_check`: الريال السعودي + السعودية + ضريبة 15 % مفعّلة. في وضع `live` / `live_pending`: غياب الملف = محظور (`not_checked`). في المحاكاة: محظور فقط إن أبلغت المحاكاة بما يخالف. المطالبة (`daftra_claim_jobs`) **تُفشل** كل مهمة كتابة (`invoice_push`، `purchase_push`، `client_ensure`، `client_push`، `item_ensure`) بالرمز `account_not_ksa` قبل تسليمها للعامل؛ `request_billing_push` / `request_daftra_purchase_draft` → `MRS_DAFTRA_ACCOUNT_NOT_KSA`. | يعيد الفحص من `connection.account` قبل أي كتابة (fail closed) ويُرجع `failed` بالرمز `account_not_ksa` دون أي طلب. |
| الذكاء الاصطناعي لا يعتمد شيئًا | لا مسار اعتماد آلي؛ كل ربط فاتورة / صنف / عميل بالاسم يؤكده إنسان. | — |
| الفوترة محجوبة دون إثبات إعادة الفارغ | لم يتغير: `billed` فقط من `under_billing`، و`under_billing` يتطلب الإعادة. ربط فاتورة صادرة يرفع `financial_status` إلى `invoiced` ومحفز الخطوة 2 ينقل `under_billing → billed` فقط. | — |
| مسودة افتتاحية صفرية (opening zero draft) عند اعتماد البيان | إعداد المؤسسة `auto_draft_on_declaration` = `false` افتراضيًا. | — |
| مسودات المشتريات لكل نقلة | `purchase_drafts_enabled` = `false` افتراضيًا (تُبنى أخيرًا). | — |
| التواريخ | تاريخ الفاتورة = **اليوم بتوقيت `Asia/Riyadh`** (`app.rpt_today()`)، يُثبَّت عند المطالبة بالإنشاء في `billing_intents.invoice_date`. | `Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Riyadh'})`؛ مقارنة القراءة بعد الإنشاء. |

**تغيير السياسة للمالك فقط:** `set_daftra_write_policy(p_org, {allow_draft_update?, allow_product_create?}, p_reason)` — مدير النظام على مستوى المؤسسة (الدور `admin` مع جلسة `aal2`)، السبب إلزامي، والتغيير يُسجل في `audit_log` (قبل / بعد) ومع `policy_changed_by / _at / policy_reason`. **لا واجهة** لهذا.

> مجموعات اختبار G5 (`g5-*`، `g5b`، `g7-*`، `rls-tests`، `restore-drill`، `convert-tests`) تختبر سلوك G5 القديم، فتضبط في بدايتها
> `ALTER TABLE daftra_connections ALTER COLUMN allow_draft_update SET DEFAULT true, ALTER COLUMN allow_product_create SET DEFAULT true`
> (في قاعدة الاختبار فقط؛ الترحيل نفسه يبقي الافتراض `false`).

## 2) الجداول والأعمدة الجديدة

| الكائن | المحتوى |
|---|---|
| `daftra_connections` + | `allow_draft_update`، `allow_product_create`، `auto_draft_on_declaration`، `purchase_drafts_enabled`، `opening_item` (افتراضي `item:customs_clearance`)، `purchase_item` (افتراضي `item:transportation_cost`)، `custom_field_map`، `account_profile`، `account_checked_at`، `policy_changed_by / _at`، `policy_reason` |
| `daftra_item_links` + | `remote_product_code`، `remote_code_norm` (= `app.daftra_code_norm`)، `service_item_id`، `mapped_by / _at`، `match_checked_at`. مفاتيح البنود: `<kind>:<fin_service>` (G5) و`item:<رمز بند الخدمة>` لبنود دليل الخدمات الـ26. صنف دفترة واحد لكل مفتاح **في كل نطاق** (قد يشترك مفتاح G4 وبند خدمة في صنف واحد). |
| `billing_intents` + | `origin` (`marsa` / `opening` / `linked`)، `daftra_url`، `invoice_date`، `remote_client_id`. مسودة افتتاحية واحدة لكل معاملة (فهرس فريد). |
| `billing_intent_lines` + | `daftra_description` (ما يُرسل وصفًا: TAS فقط لرسوم المواعيد، فارغ لسطر التخليص)، `manual_in_daftra` |
| `billing_sync_jobs` + | الأهداف `transaction_id` (`invoice_lookup`)، `run_id` (`product_match` / `client_import` / `legacy_scan` / `supplier_search`)، `purchase_id` (`purchase_push`) |
| `billing_review_items` + | الأنواع `manual_in_daftra`، `date_mismatch`، `readback_mismatch`، `client_mismatch`، `opening_blocked` (على مستوى المعاملة) |
| `clients.daftra_client_code` | رقم العميل في دفترة (فريد في المؤسسة)؛ تكتبه مسارات الاستيراد فقط، ولا يُقرأ مباشرة (منح الأعمدة مغلق) |
| `daftra_runs` | تشغيلة قراءة فقط على مستوى المؤسسة: `product_match`، `client_import`، `client_file`، `legacy_scan`، `supplier_search`؛ المؤشر (`cursor`) والعدادات والنتيجة |
| `daftra_client_import_rows` | صفوف الاستيراد المرحلية والإجراء المقترح: `update_link`، `link`، `review_name`، `create`، `conflict`، `invalid` (+ `skip`) |
| `daftra_invoice_candidates` | فواتير وُجدت بالرقم / بالمطابقة المركبة / بالمسح القديم: `open`، `review`، `blocked` (عميل مختلف)، `linked`، `rejected`، `superseded` |
| `daftra_supplier_links` | جهة نقل (أو اسمها) ↔ معرّف مورد دفترة، يُحفظ فقط عند تطابق اسم واحد تام |
| `daftra_purchase_drafts` | مسودة مشتريات واحدة لكل نقلة؛ المرجع `MRSP-<12 hex>`؛ المعرّف يُحفظ فور معرفته |

القاموس `daftra_error` في `status_labels` يحوي رسائل عربية / إنجليزية لكل رمز خطأ من العامل (`account_not_ksa`، `custom_required`، `unmapped_product`، `product_not_found`، `client_not_linked`، `client_suspended`، `draft_update_disabled`، `date_mismatch`، `readback_mismatch`، `client_mismatch`، `empty_result`، `reference_lookup_incomplete`، `auth_failed`، `forbidden`، `account_mismatch`، `rate_limited`، `http_5xx`، `timeout`، `network`، `validation`، `not_found`، `lease_lost`، `tax_map_invalid`، `invoice_issued`، `supplier_not_linked`، `worker` …) وفيها `{fields}` لتفاصيل الحقول؛ تعرضها `bill/daftra.js` وشريط الفوترة في المعاملة.

## 3) القواعد

- **الأصناف (a):** `save_daftra_product_code` يضبط الكود (لا يُزرع أي كود حساب)؛ `request_daftra_product_match` مهمة قراءة؛ `confirm_daftra_product_mapping` يقبل فقط مرشحًا كوده يساوي الكود المضبوط بعد حذف الأصفار البادئة. البند غير المربوط يمنع المسودة (`MRS_DAFTRA_UNMAPPED`).
- **الحقول الإضافية (b):** `save_daftra_custom_fields` (مدير الحسابات): `fields.{declaration_no, declaration_date, bl, port, declaration_type, containers, goods, origin}.{key, required}`، و`port_values` (قيمة المؤسسة لكل ميناء؛ وإلا `customs_ports.daftra_value` ثم الاسم العربي)، و`type_values` (افتراضي: استيراد → وارد، تصدير → صادر، تصفية → تصفية). التاريخ `DD/MM/YYYY`، البضاعة ≤ 1000، المنشأ ≤ 250، Ro-Ro: الشاصي / اللوحة. حقل إلزامي بلا قيمة → `MRS_DAFTRA_CUSTOM_REQUIRED fields` والتلميح أسماء الحقول، قبل أي طلب. `test_daftra_custom_fields` (المالك فقط) يبني الحمولة دون إرسال.
- **المسودة الافتتاحية (c):** محفز مؤجل (`DEFERRABLE INITIALLY DEFERRED`) على `customs_declarations` يعمل عند الالتزام بعد اكتمال `approve_declaration_extraction` أو الإدخال اليدوي (`add_declaration` / `correct_declaration` / `set_declaration_status`)، لطلبات المستخدمين فقط وعند تفعيل الإعداد. يتطلب رقم بيان، عميلًا نشطًا مربوطًا بدفترة، اتصالًا، حسابًا سعوديًا، صنف التخليص مربوطًا، والحقول الإلزامية. الناتج غرض واحد `origin = opening` بمرجع = مرجع المعاملة (`po_number`) ومهمة `invoice_push` بالخيار `opening`. أي منع → بند واحد مفتوح `opening_blocked` بالسبب؛ أي خطأ → السبب `error`؛ **اعتماد البيان لا يُلغى أبدًا**. `retry_daftra_opening` يعيد المحاولة أو يعيد جدولة مهمة فاشلة.
- **التاريخ والقراءة (d):** نتيجة الإنشاء تحمل `read_back` → تاريخ مختلف = `date_mismatch`؛ عميل / إجمالي / عدد أسطر مختلف = `readback_mismatch`؛ `daftra_url` يُحفظ (https فقط).
- **أسطر الفاتورة (e):** سطر من سجل السدادات يستخدم صنف بند الخدمة `item:<code>`؛ رسوم المواعيد: الوصف = TAS فقط (بدونه لا يدخل)؛ التخليص: وصف فارغ؛ السداد المشترك و«تكلفة النقل» الداخلية لا تدخل مسودة المبيعات (`daftra_block`).
- **استيراد العملاء (f):** صفحات قراءة؛ لا حذف أبدًا؛ 0 سجل في التشغيلة كلها → `aborted` (`empty_result`). الربط بمعرف دفترة ثم برقم العميل، ثم الاسم العربي الموحّد = مراجعة بشرية. التصنيف اليدوي لا يُستبدل. `import_clients` لملفات المستأجر نفسه بالقواعد ذاتها.
- **الفواتير (g):** بحث بالرقم أو مركب تام؛ عميل مختلف = حظر صارم؛ أكثر من تطابق = مراجعة؛ الربط بتأكيد بصري (إعادة كتابة الرقم). المسح القديم دفعات قابلة للاستئناف. `refresh_tx_daftra` سحب قراءة فقط عند فتح المعاملة إن مضت 15 دقيقة. `client_mismatch` عند السحب.
- **إلغاء المعاملة (i):** `daftra_invoice_issued`، `daftra_sync_in_flight` (مهمة دفترة للمعاملة في الانتظار / التنفيذ / غير معروفة، أو كتابة لم تُطابق)، `daftra_purchase`.

## 4) عقد المهام

قواعد عامة للعامل (تنطبق على كل نوع):

1. **المدخل الوحيد** سياق `daftra_claim_jobs(p_worker, p_limit)`؛ **المخرج الوحيد** `daftra_complete_job(p_attempt, {outcome, error?, calls, effects, expected_hash?})`. قبل **كل** كتابة: `daftra_renew_lease(p_attempt)`؛ فشلها = لا كتابة.
2. `connection.policy = {allow_draft_update, allow_product_create, products: 'resolve_only' | 'create_missing'}`؛ `connection.account = {ok, reason, currency, country, vat_15, enforced}`؛ `connection.custom_field_map`؛ `connection.today` (YYYY-MM-DD بتوقيت الرياض)، `connection.time_zone = 'Asia/Riyadh'`.
3. **قبل أي كتابة**: إن كان `connection.account.ok` ليس `true` → `{outcome:'failed', error:{kind:'validation', code:'account_not_ksa'}}` بلا أي طلب. (القاعدة نفسها تُفشل مهام الكتابة عند المطالبة.)
4. `policy.allow_draft_update = false` → ممنوع `PUT/POST invoices/{id}` وممنوع `update_draft`؛ مسموح `POST invoices` لمسودة **جديدة** فقط.
5. `policy.products = 'resolve_only'` → ممنوع `POST products`؛ الصنف يُحل من `items[].external_product_id` أو بالبحث عن `remote_product_code` بمقارنة دون الأصفار البادئة؛ عدم وجوده → `failed` بالرمز `product_not_found` (أو `unmapped_product` إن لم يُضبط كود).
6. `calls[]`: `{op, at, ms, request, response, error, applied:'yes'|'no'|'unknown'}` منقّاة. أسماء العمليات المعتمدة للكتابة: `createClient`، `updateClient`، `createProduct`، `createDraftInvoice`، `updateDraftInvoice`، `createPurchaseDraft`. القاعدة ترفض نتيجة فيها `updateDraftInvoice` (HF5) أو `createProduct` (حل بالكود) مطبّقة، وأي عملية كتابة في نوع قراءة.
7. النتيجة `unknown` في الأنواع القراءة فقط (`product_match`، `client_import`، `invoice_lookup`، `legacy_scan`، `supplier_search`) تُعامل كـ `retry`.
8. رموز الأخطاء (`error.code`) من القاموس `daftra_error`؛ الرسالة بلا قيم سرية؛ أسماء الحقول فقط في `{fields}`.

### probe (قراءة فقط)
- **السياق:** `connection`.
- **الطلبات:** `GET site_info`، `GET taxes`، صفحة واحدة من العملاء / الأصناف / الفواتير.
- **الإبلاغ:** `effects: {capabilities:{<17 مفتاحًا>:{supported, evidence}}, account:{currency, country, taxes:[{value, active|is_active, included}]}}` — القاعدة تحفظ `account_profile = {currency, country, vat_rates (الفعّالة فقط), checked_at}` ولا تحفظ الاسم / النطاق / العدادات.

### invoice_push (كتابة: مسودة جديدة فقط)
- **السياق:** `intent = {id, transaction_id, transaction_ref, operational_ref, po_number (= operational_ref), currency, purpose, origin ('marsa'|'opening'|'linked'), status, sync_state, external_invoice_id, pushed_hash, remote_version, invoice_date (الرياض، مثبّت عند المطالبة), notes, daftra_url, custom_fields:{payload:{<key>: value}, fields:[{name, key, required, value}], missing:[…]}, opening_line ({item_key, description:'', quantity:1, unit_price:0, vat_rate} للافتتاحية فقط، وإلا null), client:{link_id, client_id, client_ref, external_id, status, data, pushed_snapshot, active}, items:[{link_id, item_key, product_code, external_product_id, remote_product_code, remote_code_norm, name_ar, name_en, default_vat_rate, tax_code, status}], lines:[{line_id, line_ref, state, pushed, remote_line_id, item_key, description, daftra_description, manual_in_daftra, quantity, unit_price, vat_rate, net_amount, vat_amount, total_amount}]}` و`job.options.opening` للافتتاحية و`job.previous_status = 'unknown'` ⇒ المطابقة بالمرجع أولًا.
- **قبل الطلبات:** `custom_fields.missing` غير فارغ → `failed` بالرمز `custom_required` (والقاعدة تمنع ذلك مسبقًا)؛ `client.active = false` أو العميل موقوف في دفترة (`suspend`) → `failed` بالرمز `client_suspended`؛ الحساب ليس سعوديًا → `account_not_ksa`.
- **الطلبات:** `GET` بحث بالمرجع (`po_number` / سطر الملاحظات) كما في G5b؛ وُجدت واحدة لنفس العميل والعملة → تبنٍّ (`found_by:'ref'`) **بلا تعديل** عند `allow_draft_update = false`؛ لا شيء → `POST invoices` مسودة (`draft: 1`) بالتاريخ `invoice_date`، `po_number`، الحقول الإضافية `custom_fields.payload`، الأسطر `pending_add` + `synced` (الوصف = `daftra_description` إن لم يكن null، وإلا `description`)، وسطر `opening_line` للافتتاحية؛ ثم `GET invoices/{id}` للقراءة.
- **الإبلاغ:** `ok` → `effects: {intent_id, external_invoice_id, found_by:'created'|'ref'|'existing', daftra_status, remote_state, daftra_number?, remote_version, remote_hash, pushed_hash, remote_snapshot, remote_totals:{net, vat, total}, line_results:[{line_id, state:'synced', remote_line_id}], daftra_url (https), read_back:{date (YYYY-MM-DD المخزّن في دفترة), client_id, total, line_count}}`. القاعدة تُنشئ `date_mismatch` إن اختلف التاريخ و`readback_mismatch` (`client` / `total` / `lines`). `unknown` → `{intent_id, external_invoice_id?}` + `expected_hash`؛ `frozen` → تأثيرات `invoice_pull`؛ `conflict` كما في G5.

### invoice_pull (قراءة فقط)
- **السياق:** كما في `invoice_push`.
- **الطلبات:** `GET invoices/{external_invoice_id}` + المدفوعات.
- **الإبلاغ:** `effects: {intent_id, external_invoice_id, daftra_number, daftra_status, remote_state:'draft'|'issued'|'cancelled', remote_hash, remote_snapshot, remote_totals, payment:{status, paid_amount, last_payment_at}, remote_client_id}`. عند HF5 تعديل المحاسب اليدوي للمسودة متوقع ولا يُعد تعارضًا؛ `remote_client_id` ≠ عميل المعاملة المربوط → `client_mismatch`. الصادرة → تجميد، والأسطر `manual_in_daftra` تُعد على الفاتورة، والإجمالي الرسمي ≠ الأسطر → `issued_mismatch` (`reason: totals`).

### product_match (قراءة فقط)
- **السياق:** `run = {id, kind, params:{item_keys?}, cursor, page_size, pages_per_job}`، `products = [{item_key, link_id, remote_product_code, remote_code_norm, name_ar}]`.
- **الطلبات:** `GET products` (بحث بالكود / مسح صفحات محدود).
- **الإبلاغ:** `effects: {run_id, scanned, products:[{item_key, candidates:[{external_product_id, code, name}] ≤ 10}]}`. القاعدة تحسب `exact` (الكود دون الأصفار البادئة = `remote_code_norm`) ولا تربط شيئًا قبل `confirm_daftra_product_mapping`.

### client_import (قراءة فقط، صفحات)
- **السياق:** `run = {id, cursor:{page}, page_size, pages_per_job}`.
- **الطلبات:** `GET clients` صفحات (حتى `pages_per_job` صفحة لكل مهمة). **لا حذف ولا كتابة.**
- **الإبلاغ:** `effects: {run_id, rows:[{external_id, client_number, name (الاسم العربي الرسمي: business_name ثم الاسم الثانوي العربي), name_en, vat_number, cr_number, phone, email, city, suspended}] ≤ 500, next_cursor:{page,…}|null}`. وجود `next_cursor` يجدول الصفحة التالية تلقائيًا؛ النهاية مع 0 صفوف في التشغيلة → `aborted` (`empty_result`).

### invoice_lookup (قراءة فقط)
- **السياق:** `transaction = {id, ref, client_external_id, declaration_nos[], bl_numbers[], containers[] (Ro-Ro: الشاصي), cargo_unit_type}`، `lookup = {mode:'number'|'composite', number?}`، و`connection.custom_field_map` لقراءة الحقول.
- **الطلبات:** `GET invoices` بحث بالرقم، أو بالكلمات (رقم البيان) ثم قراءة الحقول الإضافية.
- **الإبلاغ:** `effects: {transaction_id, invoices:[{external_invoice_id, daftra_number, daftra_status, remote_state, date, currency, total, client_id, client_name, po_number, fields:{declaration_no, bl, containers[]}}] ≤ 50}`. القاعدة تقرر التطابق التام والعميل (`blocked` / `review` / `open`).

### legacy_scan (قراءة فقط، دفعات قابلة للاستئناف)
- **السياق:** `run = {id, cursor:{page, last_id?}, page_size, pages_per_job}`، `connection.custom_field_map`.
- **الطلبات:** `GET invoices` صفحات (الأقدم فالأحدث أو العكس، بثبات المؤشر).
- **الإبلاغ:** `effects: {run_id, invoices:[…شكل invoice_lookup…] ≤ 500, next_cursor|null}`. المؤشر التالي يجدول الدفعة التالية؛ `null` = `done`. تشغيلة فاشلة تُستأنف من مؤشرها بـ `request_daftra_legacy_scan` (`resumed: true`).

### supplier_search (قراءة فقط)
- **السياق:** `run = {id, params:{q, party_id?, trip_id?}}`.
- **الطلبات:** `GET suppliers` بالكلمات.
- **الإبلاغ:** `effects: {run_id, suppliers:[{external_supplier_id, name, supplier_number}] ≤ 50}`. تطابق اسم واحد تام (بعد التوحيد) → `daftra_supplier_links`.

### purchase_push (كتابة: مسودة مشتريات جديدة فقط)
- **السياق:** `purchase = {id, reference (MRSP-…), trip_id, transaction_id, transaction_ref, supplier_external_id, supplier_name, external_purchase_id, status, invoice_date (الرياض), item:{…item…}, lines:[{item_key, description, quantity:1, unit_price, vat_rate:0}], amount, currency, tax:0}`.
- **الطلبات:** `GET` بحث بالمرجع أولًا؛ ثم `POST purchase_invoices` مسودة بلا ضريبة إن لم توجد. لا تعديل.
- **الإبلاغ:** `ok` → `{purchase_id, external_purchase_id, found_by:'ref'|'created', daftra_number?, daftra_url?}`؛ `unknown` → `{purchase_id, external_purchase_id?}` (يُحفظ المعرّف فورًا). العملية في `calls` تسمى `createPurchaseDraft`.

### الأنواع القديمة (G5) دون تغيير
`client_ensure`، `client_refresh`، `client_push`، `item_ensure` — مع ملاحظة: `item_ensure` و`client_*` مهام كتابة يحرسها حارس الحساب السعودي، و`item_ensure` تحت `resolve_only` لا ينشئ صنفًا.

## 5) دوال MarsaApi (supa.js)

| الدالة | RPC | المعاملات → النتيجة | الأخطاء |
|---|---|---|---|
| `setDaftraWritePolicy(p, reason, o)` | `set_daftra_write_policy` | `{allow_draft_update?, allow_product_create?, auto_draft_on_declaration?, purchase_drafts_enabled?}`، سبب → الاتصال + `from` | `MRS_FORBIDDEN owner_only`، `MRS_NOTE_REQUIRED reason`، `MRS_INVALID <flag>` |
| `saveDaftraCustomFields(map, o)` | `save_daftra_custom_fields` | الخريطة → الاتصال | `MRS_FORBIDDEN role`، `MRS_INVALID fields / field_key / field_key_taken / port_code / declaration_type / port_values / type_values` |
| `testDaftraCustomFields(txId)` | `test_daftra_custom_fields` | → `{payload, fields, values, missing, unmapped, client_linked, account_check, ok, would_send:false}` | `MRS_FORBIDDEN owner_only`، `MRS_NOT_FOUND transaction` |
| `listDaftraProductMap(o)` | `list_daftra_product_map` | → `{items:[{item_key, service_item, link, mapped}], counts, policy}` | `MRS_FORBIDDEN finance` |
| `saveDaftraProductCode(itemKey, code, o)` | `save_daftra_product_code` | → ربط الصنف | `MRS_FORBIDDEN role`، `MRS_INVALID item_key / remote_product_code / code_taken` |
| `requestDaftraProductMatch(itemKeys, opts)` | `request_daftra_product_match` (idem) | → تشغيلة + مهمة | `MRS_BAD_TRANSITION not_connected`، `MRS_REQUIRED remote_product_code`، `MRS_INVALID item_keys` |
| `confirmDaftraProductMapping(itemKey, externalProductId, o)` | `confirm_daftra_product_mapping` | → ربط الصنف (`linked`) | `MRS_INVALID not_a_candidate / code_mismatch / external_id_taken`، `MRS_REQUIRED remote_product_code` |
| `retryDaftraOpening(txId, opts)` | `retry_daftra_opening` (idem) | → `{status: queued|exists|retried|blocked|disabled, reason?, intent_id?, job?}` | `MRS_BAD_TRANSITION opening_disabled`، `MRS_FORBIDDEN role` |
| `resolveDaftraReview(id, decision, note)` | `resolve_daftra_review` | `done_in_daftra` / `dismiss` / `acknowledge` → البند | `MRS_INVALID decision`، `MRS_NOTE_REQUIRED note`، `MRS_BAD_TRANSITION <status>` |
| `listDaftraReviews(f)` | `list_daftra_reviews` | `{kind, status, branch_id, limit, offset}` → `{items, total, counts}` | `MRS_FORBIDDEN finance`، `MRS_INVALID kind / status` |
| `requestDaftraClientImport(opts)` | `request_daftra_client_import` (idem) | → تشغيلة (+ `deduplicated`) | `MRS_FORBIDDEN role`، `MRS_BAD_TRANSITION not_connected` |
| `listDaftraClientImport(runId, f)` | `list_daftra_client_import` | `{action, status, q, limit, offset}` → `{run, rows, total, counts}` | `MRS_NOT_FOUND run` |
| `applyDaftraClientImport(runId, p, opts)` | `apply_daftra_client_import` (idem) | `{decisions?, apply_safe?}` → التشغيلة + `{applied, waiting}` | `MRS_FORBIDDEN role`، `MRS_BAD_TRANSITION <status>`، `MRS_INVALID decisions`، `MRS_REQUIRED client_id` |
| `importClients(rows, options, opts)` | `import_clients` (idem) | صفوف ≤ 2000، `{dry_run?, file_name?}` → التشغيلة + `{applied, waiting, dry_run}` | `MRS_FORBIDDEN role`، `MRS_DAFTRA_IMPORT empty / too_many_rows / row` |
| `requestDaftraInvoiceLookup(txId, p, opts)` | `request_daftra_invoice_lookup` (idem) | `{mode, number?}` → `{transaction_id, mode, job}` | `MRS_REQUIRED number / declaration_no / bl_number / containers`، `MRS_BAD_TRANSITION not_connected` |
| `confirmInvoiceLink(candidateId, p, opts)` | `confirm_invoice_link` (idem) | `{confirm_number, choose_among_multiple?, note?}` → `{intent, candidate, job}` | `MRS_DAFTRA_CLIENT_CONFLICT client`، `MRS_DAFTRA_CONFIRM_MISMATCH confirm_number`، `MRS_BAD_TRANSITION review_required`، `MRS_REQUIRED client_link`، `MRS_INVALID external_id_taken / intent_taken` |
| `rejectInvoiceCandidate(candidateId, note)` | `reject_invoice_candidate` | → المرشح | `MRS_NOTE_REQUIRED note` |
| `requestDaftraLegacyScan(p, opts)` | `request_daftra_legacy_scan` (idem) | `{restart?, page_size?, pages_per_job?}` → تشغيلة (+ `resumed`) | `MRS_FORBIDDEN role`، `MRS_BAD_TRANSITION not_connected` |
| `getDaftraRun(runId)` | `get_daftra_run` | → التشغيلة (+ المرشحون / الموردون) | `MRS_NOT_FOUND run` |
| `refreshTxDaftra(txId)` | `refresh_tx_daftra` | → `{enqueued, jobs, reason?}` | `MRS_NOT_FOUND transaction`، `MRS_FORBIDDEN finance` |
| `requestDaftraSupplierSearch(p, opts)` | `request_daftra_supplier_search` (idem) | `{q?, party_id?, trip_id?}` → تشغيلة | `MRS_REQUIRED q`، `MRS_NOT_FOUND trip`، `MRS_FORBIDDEN role` |
| `listDaftraSupplierLinks(o)` | `list_daftra_supplier_links` | → `{items}` | `MRS_FORBIDDEN org` |
| `unlinkDaftraSupplier(linkId, reason)` | `unlink_daftra_supplier` | سبب إلزامي → الربط (`unlinked`، `unlinked_by/at`، `unlink_reason`) | `MRS_FORBIDDEN role` (bill_admin فقط)، `MRS_NOTE_REQUIRED reason`، `MRS_BAD_TRANSITION unlinked`، `MRS_NOT_FOUND supplier_link` |
| `requestDaftraPurchaseDraft(tripId, opts)` | `request_daftra_purchase_draft` (idem) | → المسودة + `{job, deduplicated}` | `MRS_DAFTRA_PURCHASE_DISABLED`، `MRS_DAFTRA_ACCOUNT_NOT_KSA`، `MRS_DAFTRA_UNMAPPED items`، `MRS_REQUIRED supplier_link / cost_accruals`، `MRS_BAD_TRANSITION party_type / trip_cancelled` |

أُعيد إنشاء (السلوك الجديد): `request_billing_push` (+ `MRS_DAFTRA_DRAFT_LOCKED manual_in_daftra`، `MRS_DAFTRA_ACCOUNT_NOT_KSA`، `MRS_DAFTRA_UNMAPPED items`، `MRS_DAFTRA_CUSTOM_REQUIRED fields`، `MRS_BAD_TRANSITION client_inactive`)، `tx_billing` (+ `opening`، `invoice_candidates`، `purchase_drafts`، `stale`، سياسة الاتصال وفحص الحساب)، `save_daftra_connection` (+ `auto_draft_on_declaration`، `purchase_drafts_enabled`، `opening_item`، `purchase_item`)، `retry_billing_job`، `cancel_transaction` (+ `daftra_invoice_issued`، `daftra_sync_in_flight`، `daftra_purchase`).

## 6) رموز الأخطاء الجديدة

`MRS_DAFTRA_ACCOUNT_NOT_KSA`، `MRS_DAFTRA_UNMAPPED`، `MRS_DAFTRA_CUSTOM_REQUIRED`، `MRS_DAFTRA_DRAFT_LOCKED`، `MRS_DAFTRA_CLIENT_CONFLICT`، `MRS_DAFTRA_PURCHASE_DISABLED`، `MRS_DAFTRA_CONFIRM_MISMATCH`، `MRS_DAFTRA_IMPORT` — رسائلها في `assets/js/supa.js` و`assets/js/i18n.js` (عربي / إنجليزي) مع `codeDetails` للكلمات التفصيلية الجديدة.

## 7) الأدوار والعزل

- الإعدادات والأصناف والاستيراد من دفترة والمسح القديم: مدير الحسابات / المدير (`bill_admin`). السياسة: المالك فقط. الاختبار الجاف: المالك فقط.
- البحث عن فاتورة، طلب المسودة الافتتاحية، طلب مسودة المشتريات: كاتب مالي في فرع المعاملة. الربط بفاتورة: معتمد مالي في الفرع.
- استيراد ملف العملاء: `admin` / `operations_manager` / `accounts_manager`.
- البحث في الموردين: موظفو النقل أو الكتّاب الماليون في فرع النقلة.
- الجداول الجديدة: قراءة فقط للقراء الماليين (نطاق الفرع عبر المعاملة)؛ روابط الموردين لموظفي المؤسسة؛ العملاء والزوار: لا شيء؛ لا كتابة مباشرة؛ لا حذف (`trg_no_delete`)؛ مدققة (عدا صفوف الاستيراد المرحلية).

## 8) العامل (منفَّذ): `supabase/functions/daftra-sync`

> الاختبارات: `supabase/tests/legacy-daftra-worker-tests.js` (المحاكاة + المحوّل الحقيقي `daftra-live.js` عبر نقل وهمي بلا شبكة
> `server.inProcess()` في `tests/lib/fake-daftra-server.js` + دورة كاملة على PGlite بإعدادات المالك الافتراضية دون تعديل)،
> والقسم 8c في `g5b-daftra-live-tests.js` (عبر HTTP محلي). لا اتصال بدفترة الحقيقية، ولا نشر، ولا مفاتيح.

- **حارس الحساب السعودي (`adapter.js` `ksaBlock`):** قبل أي استدعاء لمهمة كتابة (`invoice_push`، `purchase_push`، `client_ensure`، `client_push`، `item_ensure`)
  يفحص العامل `connection.account`: غيابه أو `ok ≠ true` → `failed` بالرمز `account_not_ksa` (والسبب في `(fields: …)`) **بلا أي طلب**؛ الحساب المُلزَم (live)
  يجب أن يُظهر SAR والسعودية و`vat_15`. مهام القراءة تعمل على أي حساب.
- **سياسة الكتابة (`writePolicy`، fail closed):** ما لم تكن القيمة `true` صراحة: لا `updateDraftInvoice` (المسجِّل يرفضها: `draft_update_disabled`)، ولا
  `createProduct` (`product_create_disabled`)، ولا أي كتابة في مهمة قراءة (`read_only_kind`). المحوّل الحقيقي يأخذ السياسة من `index.ts`
  (`connection.policy`) و`guardDaftraRequest(method, path, body, query, policy)` يرفض `PUT invoices/{id}` (`draft_update_refused`) و`POST products`
  (`product_create_refused`). مسودة قائمة تختلف عمّا في مرسى → `failed draft_update_disabled` دون إرسال؛ مسودة وُجدت بالمرجع بعد إنشاء ضاع رده → تُتبنّى كما هي.
- **الأصناف:** `findProductsByCodeNorm` (مرشح `product_code` كما هو ثم بلا أصفار ثم `keywords` مع مقارنة `codeNorm`)؛ لا كود → `unmapped_product`؛ لا صنف →
  `product_not_found`؛ أكثر من صنف → `conflict item_review`.
- **المسودة الجديدة:** `custom_fields.missing` → `custom_required` قبل أي طلب؛ `client.active = false` → `client_inactive`؛ عميل دفترة موقوف (`Client.suspend`) →
  `client_suspended` (قراءة `GET clients/{id}` قبل الإنشاء)؛ التاريخ = `intent.invoice_date` (المثبّت عند المطالبة) وإلا `connection.today` وإلا اليوم بتوقيت
  الرياض عبر `Intl`؛ `po_number` = `intent.po_number`؛ الحقول الإضافية `{CustomModel:{key:[value]}}` وحقل التاريخ قيمة واحدة + `type_CustomModel.<key> = date`
  في طلب الإنشاء نفسه؛ السطر ذو `daftra_description` يُرسل `item` = اسم الصنف + `[MRSL-…]` و`description` = الوصف (TAS / فارغ)؛ سطر الافتتاحية بلا مرجع سطر
  وبسعر 0؛ الأسطر `manual_in_daftra` لا تُرسل. بعد الإنشاء `GET invoices/{id}` → `read_back {date, client_id, total, line_count}` و`daftra_url`
  (`https://<subdomain>.daftra.com/owner/invoices/view/<id>`، لا يُؤخذ رابط من رد دفترة).
- **القراءات:** `client_import` صفحات `GET clients.json?page&limit` (الاسم العربي الرسمي: `business_name` ثم `secondary_name`)؛ `invoice_lookup` بالرقم
  (`keywords` ثم مسح محدود) أو مركّب (`keywords` لكل رقم بيان + فواتير العميل `client_id`) ثم `GET invoices/{id}` لقراءة `CustomModel` (حد 40 قراءة)، ويُرجع
  فقط ما يطابق جزءًا مركبًا؛ `legacy_scan` `GET invoices.json?sort=id&direction=ASC` بمؤشر `{page, last_id}` (يُستأنف ويتخطى ما سبق)؛ `supplier_search`
  `GET suppliers.json?name=` (ثم `keywords`) دون الموقوفين؛ `product_match` مسح صفحات الأصناف ثم بحث موجّه.
- **مسودة المشتريات:** معرّف محفوظ → قراءة فقط (`found_by ref`)؛ وإلا بحث بالمرجع (`[MARSA-REF:MRSP-…]` في الملاحظات: `keywords` ثم مسح) ثم
  `POST purchase_invoices.json?send=draft` مع `PurchaseOrder.draft = 1` وضريبة صفر على كل بند (الحارس يرفض غير ذلك: `tax_refused`)، ثم قراءة؛ لا `PUT` أبدًا.
- **رموز الأخطاء للواجهة:** `adapter.js` `errorCode(err)` → مفتاح القاموس `daftra_error` (الرمز نفسه، أو بديله: `draft_update_refused → draft_update_disabled`،
  `product_create_refused → product_create_disabled`، `redirect / config_* → not_configured`، `run_deadline → timeout`، `tax_unmapped / tax_ambiguous → tax_map_invalid`،
  ثم النوع، ثم `worker`)، و`errorFields(err)` يقرأ `(fields: a, b)` من الرسالة لملء `{fields}`. التحويلات لا تُتبع أبدًا (`redirect: 'manual'`؛ 3xx = خطأ).

## 9) الواجهة (منفَّذة)

> الاختبارات: `supabase/tests/legacy-daftra-ui-tests.js` (Node + `tests/lib/fake-dom.js`، بلا شبكة). الملفات الجديدة:
> `assets/i18n/dft.js` (القاموس `dft`، عربي / إنجليزي)، `assets/js/bill/dft-kit.js` (`MarsaOps.dftKit`)، `assets/js/bill/dft-settings.js` (`MarsaOps.dftSettings`).

| الشاشة | كيف تُفتح | المحتوى |
|---|---|---|
| «الاتصال» في `#daftra` | `admin.html#daftra` | بطاقة **حارس الحساب السعودي** (السبب + ما يغيّره المالك في دفترة: العملة، الدولة، ضريبة 15 %، ثم إعادة الفحص)، **سياسة الكتابة** للقراءة فقط («ممنوع» + السبب، بلا أي زر)، **إعدادات المسودات** (`auto_draft_on_declaration` / `purchase_drafts_enabled`: زر للمالك فقط بتأكيد، مطفأة افتراضيًا)، **مسح الفواتير القديمة** (قراءة فقط، استئناف). |
| «الأصناف بالكود» | `#daftra/products` | كود صنف دفترة لكل بند في دليل الخدمات (`000186 = 186`)، قائمة البنود غير المربوطة (تمنع المسودة)، طلب مطابقة للقراءة فقط، تأكيد المرشح المطابق فقط. |
| «الحقول الإضافية» | `#daftra/fields` | خريطة CustomModel (المحرر للمالك)، قيم الموانئ وأنواع البيان، **اختبار الحقول** للمالك (حمولة بلا إرسال، تاريخ الرياض). |
| «استيراد العملاء» | `#daftra/import` | طلب استيراد من دفترة (قراءة فقط)، رفع ملف CSV / XLSX من المؤسسة (`import_clients`، معاينة افتراضيًا)، الصفوف المرحلية بالمقترح والسبب، قرارات الربط / الإنشاء / التخطي، «تطبيق المقترحات الآمنة». آخر التشغيلات تُحفظ في المتصفح فقط (`localStorage`). |
| «مراجعات دفترة» | `#daftra/reviews` | البنود `manual_in_daftra` (ما يُضاف / يُحذف يدويًا + رابط المسودة)، `date_mismatch`، `readback_mismatch`، `client_mismatch`، `opening_blocked` مع قرارات `resolve_daftra_review` حسب الدور. |
| شريط الفوترة في المعاملة | `#tx/<id>` قسم «الفواتير ودفترة» | رابط المسودة (`daftra_url`، https فقط)، أصل الغرض (افتتاحية / مربوطة)، تاريخ الفاتورة، لافتة الحساب غير السعودي، منع إعادة الإرسال لمسودة قائمة (HF5)، رسائل أخطاء العامل من القاموس، تحديث للقراءة فقط عند الفتح إن مضت 15 دقيقة (مرة واحدة)، المسودة الافتتاحية + إعادة الطلب، البحث عن فاتورة بالرقم / مركب، **تأكيد بصري** (مرسى ودفترة جنبًا إلى جنب + إعادة كتابة الرقم)، المرشح المحظور بلا زر ربط، مسودات المشتريات للنقلات (عند تفعيل الإعداد). |
| حركة النقل | `#tx/<id>` قسم الحركات | زر «مورد دفترة» لنقلة جهة نقلها مورد / شركة: بحث للقراءة فقط، ونتيجة آخر بحث، وحالة الربط. |
| اعتماد البيان | `ocr.html` (نتيجة الاعتماد) و`#tx/<id>` بطاقة البيانات | سطر «دفترة: طُلبت / لم تُطلب (السبب) / الإعداد مطفأ» للقراء الماليين. |

غير منفَّذ في الواجهة: تعديل `party_type` / أمر النقل للنقلة يدويًا (يُسجَّلان من بطاقة الموعد في المرحلة 5؛ لا RPC لتعديلهما)، وأي واجهة لتغيير سياسة الكتابة (قرار المالك من الخادم فقط).

## 10) مراجعة المرحلة 7 (إصلاحات)

| البند | السلوك بعد الإصلاح | الاختبار |
|---|---|---|
| الإعدادات عند إعادة المحاولة / الاستلام | `app.daftra_setting_block` يعيد فحص `purchase_drafts_enabled` و`auto_draft_on_declaration` وحالة الرحلة (`trip_cancelled`، `party_type`، `supplier_link`) في `retry_billing_job` (`MRS_DAFTRA_PURCHASE_DISABLED` / `MRS_BAD_TRANSITION opening_disabled …`) وفي `daftra_claim_jobs` (تفشل المهمة بالرمز `setting_disabled` ولا تُسلَّم للعامل). | sql §15 |
| «ربما طُبّق» لمسودة المشتريات | `app.daftra_purchase_unreconciled`: أي محاولة انتهت unknown / abandoned / lease_lost أو سجّلت `createPurchaseDraft` مطبّقًا أو مجهولًا، بلا محاولة ok بعدها، تُبقي `sync_state = unknown` وتجعل المحاولة التالية `previous_status = unknown` (عبر المهام وإعادة الطلب). | sql §15 |
| 3xx على الكتابة | `applied: unknown` (لا «لم يُطبق قطعًا»). | worker §7، g5b |
| محفز المسودة الافتتاحية | لا يعيد رفع الجمود / فشل التسلسل: يُسجَّل `opening_blocked` (`code: busy`) ولا يُلغى اعتماد البيان أبدًا. | sql §15 |
| بحث الموردين | الربط باسم الجهة (`params.match_name` = اسم الطرف أو اسم جهة الرحلة) لا بنص البحث؛ الاسم الثانوي في دفترة يُطابَق أيضًا؛ فك ربط مُدقَّق `unlink_daftra_supplier` (bill_admin + سبب). | sql §15، ui |
| إعدادات المسودات | تغييرها للمالك فقط عبر `set_daftra_write_policy` (سبب + تدقيق)؛ `save_daftra_connection` يقبلها دون تغيير فقط (`MRS_FORBIDDEN owner_only`). الواجهة تطلب السبب، والمالك = مدير على مستوى المؤسسة (`api.orgOwner`). محرر الحقول الإضافية لمدير الحسابات / المدير (كما في الخادم)، واختبار الحقول للمالك. | sql §15، ui |
| حارس الحساب | العامل يعيد قراءة الحساب (`getAccountProfile`: GET `site_info` + `taxes`) قبل أول كتابة لحساب حي (`enforced`)؛ ونتيجة probe بدأت قبل تغيير الهدف (`target_changed_at`) أو لنطاق آخر لا تُختم على الاتصال. | worker §7، sql §15 |
| رقم عميل دفترة من ملف | يُحفظ فقط من دفترة أو من ملف طبّقه bill_admin (لا من `operations_manager`). | sql §15 |
| HF5 عند الإصدار | الأسطر المطلوب إضافتها يدويًا تُعدّ مفوترة إذا طابق الإجمالي الرسمي (المتزامن + الإضافات)؛ وإلا تُعلَّق (لا حذف ولا `late_charge`) ويبقى بند `manual_in_daftra` مفتوحًا (`issued: true`): `done_in_daftra` → مفوترة، `dismiss` → محذوفة + `late_charge`. | sql §15 |
| Ro-Ro | القيمة كالقديم «Ro-Ro — شاسيه … — لوحة …»، و`containerSet` يستخرج الشاصي منها. | sql، worker §7 |
| رسوم موعد بلا TAS (G4) | مستبعدة `tas_missing` (لا يُرسل نص حر). | sql §15 |
| وصف سطر المشتريات | «المعاملة | العميل | البيان | الحاوية | السائق | الموعد» ≤ 900. | sql §15 |
| قراءة المشتريات بعد الإنشاء | `effects.checks {tax_nonzero, not_draft, unread}` → `last_error_code = purchase_review`. | worker §7، sql §15 |
| كود الصنف | `#` البادئة والمسافات تُهمل (`#000186 = 186`). | sql، worker، ui |
| قراءة بلا تاريخ | `date_mismatch` (stored null) لمسودة أُنشئت. | sql §15 |
| البحث المركب | تطابق مفتاحين من ثلاثة → مرشح `partial` (≤ 3، للاطلاع فقط، لا يُربط: `MRS_BAD_TRANSITION partial`). | sql §15، ui |
| واجهة الاستيراد | صفحات 200 (offset)، والحالة مقيّدة بالمؤسسة. | ui |
| ocr.html | سطر دفترة مخفي حتى يوجد نص. | ui |

رموز `daftra_error` الجديدة: `setting_disabled`، `purchase_review` (32 رمزًا).

