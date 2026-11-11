# المرحلة 8 من نقل النظام القديم: التقارير ولوحات المتابعة والتنبيهات

الترحيل: `supabase/migrations/20261124000100_legacy_reports.sql` (يتطلب `20261123000100` في `schema_versions`، ويُعاد تشغيله على نفسه بنفس الكتالوج). الاختبارات: `supabase/tests/legacy-reports-sql-tests.js`. الخطة: `docs/online/LEGACY_PORT_PLAN_AR.md` (قسم «التقارير ولوحات المتابعة والتنبيهات والواجهة» وقرارات المالك بتاريخ 2026-11-11).

## الخلاصة

- **جانب القراءة فقط** مع إعدادين للمؤسسة. لا جدول جديد ولا عمود ولا مشغّل. لا كتابة على المعاملات أو الحاويات أو المواعيد أو الفوترة أو دفترة. لا يعتمد أي شيء.
- **العزل:** كل قارئ للموظفين فقط. العميل (البوابة) والمؤسسات الأخرى يُرفضون بـ `MRS_FORBIDDEN`. نطاق الفرع يُحسب لكل صف عبر المعاملة (`app.rpt_scope`).
- **المبالغ:**
  - قيمة النقل وعائد المؤسسة: لأدوار مالية النقل في فرع الصف.
  - كشف السدادات وحالة دفترة: لقرّاء المالية (`fin_read`) في فرع الصف.
- **التوقيت:** الطوابع الزمنية تُقارن بحدود يوم الرياض (`Asia/Riyadh`). أعمدة التاريخ بلا وقت (تاريخ البيان، آخر موعد لإعادة الفارغ، تاريخ السداد) لا تُزاح أبدًا.
- **قرارات المالك محفوظة:**
  - الفوترة ممنوعة بلا إثبات إعادة الفارغ.
  - الذكاء الاصطناعي لا يعتمد شيئًا.
  - لا تعديل على دفترة.

## الدوال (RPC) — العقد

كل الدوال `SECURITY DEFINER` مع `search_path=''`، وصلاحية التنفيذ لـ `authenticated` فقط (لا `anon`). في كل دالة تحمل `p_org` يكون `p_filters` كائنًا، والمفاتيح غير المعروفة تُرفض بـ `MRS_INVALID unknown_key`.

### `dash_tx_counts(p_org, {branch_id})` — بطاقات لوحة المعاملات

**المُرجَع:**

```
{total, open, cancelled, by_status {كل حالة تشغيلية: n}, by_declaration_status {كل مرحلة: n},
 declaration_stages {accepted, cco_review_done, awaiting_duty_payment, release_ready, released}, no_declaration,
 drafts {documents, appointments}, appointments_today, transported_containers,
 attention {critical, warning, total}, daftra {none, draft, issued, cancelled_review} | null,
 today, branch_id, generated_at}
```

**تساوي كل بطاقة القائمة التي تفتحها:**

- الحالة: `report_transactions {operational_status}`.
- المرحلة: `{declaration_status}`، وهي مرحلة البيان الحالي: أحدث بيان غير ملغى ولا مستبدل.
- «مسودات دفترة»: `{daftra_state: 'draft'}`.
- «مواعيد اليوم»: `report_movements {from=to=اليوم}` ويُقرأ `totals.appointments`.
- «الحاويات المنقولة»: `{movement_status: 'delivered'}` ويُقرأ `totals.delivered_containers`.

**ملاحظات:**

- لا يوجد أي مفتاح مالي في هذه الدالة.
- `daftra` لقرّاء المالية فقط، ويُحسب على نطاقهم وحده.

### كشف المعاملات — `report_transactions` / `search_records` (المفاتيح الجديدة في `app.rpt_search_keys`)

**المفاتيح الجديدة:**

| المفتاح | المعنى |
|---|---|
| `client_code` | كود دفترة للعميل (احتواء) |
| `client_category` | `airport` / `port` / `shared` |
| `port_code` | رمز منفذ أو مصفوفة رموز من `customs_ports` |
| `declaration_status` | مرحلة أو مصفوفة مراحل |
| `vessel` | اسم الباخرة |
| `terminal_party_id` و`operator_q` | المشغل |
| `agent_q` | الوكيل الملاحي أو الخط الملاحي |
| `employee_id` | المسؤول، وإلا المنشئ |
| `containers_min` و`containers_max` | عدد الوحدات؛ وحدة Ro-Ro واحدة |
| `cargo_unit_type` | نوع وحدة الشحن |
| `transaction_type` | نوع المعاملة |
| `daftra_state` | `none` / `draft` / `issued` / `cancelled_review`؛ لا يطابق إلا صفوف نطاق المالية للمستخدم |
| `attention` | `any` / `warning` / `critical` («المتأخرة فقط») |

**القيم الإضافية:**

- `date_field` يقبل الآن `updated` أيضًا.
- `sort` يقبل: `ref_desc`، `declaration_date_desc`، `declaration_date_asc`، `updated_desc`.
- `q` يبحث في حقول البحث الـ 23 من النظام القديم. يضاف إلى ما سبق:
  - الشاسيه واللوحة، والباخرة، والمشغل، والوكيل، والموظف.
  - أمر النقل، والملاحظات، ورمز المنفذ واسمه، وكود دفترة.
- `container_no` يطابق أيضًا شاسيه Ro-Ro ولوحته.

**أعمدة الصف الجديدة (في `search_records` و`report_transactions`):**

```
port_code, port_name, port_name_en, terminal_party_id, operator_name, agent_name, vessel, employee_id, employee_name,
client_code, client_category, cargo_unit_type, chassis_no, vehicle_plate_no, transaction_type, transport_mode,
transport_order_no, declaration_date, unit_count, updated_at
```

**في `report_transactions` فقط:**

- `containers`: مصفوفة أرقام حاويات (نصوص، لا كائنات)، حتى 50 رقمًا. يقرؤها تلميح السجل وعمود «وحدة الشحن» في كشف المتابعة (رقم في كل سطر؛ وRo-Ro مع «شاسيه: …» و«لوحة: …» من `chassis_no` و`vehicle_plate_no`).
- `declaration_status`.
- `daftra`: `{state, intent_id, number, daftra_status, issued_at}` لقارئ المالية في فرع الصف، وإلا `null`.
- `attention`: `{level, hours, reasons[]}` أو `null`.

**المجاميع:** `totals` يضيف `units` (مجموع `unit_count` للصفوف، والمركبة Ro-Ro = 1؛ هو ما يظهر تحت «عدد الوحدات»، أما `containers` فعدد الحاويات فقط)، و:

- `attention {critical, warning, total}`.
- `by_daftra_state`: لقرّاء المالية، وإلا `null`.

### التأخير والمتابعة

**القواعد الافتراضية** (`app.status_aging_defaults`)، بالساعات منذ آخر تحديث للمعاملة:

| الحالة | تنبيه | حرج |
|---|---|---|
| `new` | 24 | 48 |
| `in_progress` / `customs_declaration` / `appointment` / `empty_return` («نشطة») | 48 | 96 |
| `transport` | 24 | 48 |
| `operationally_complete` | 24 | 48 |
| `under_billing` | 48 | 96 |
| `appointment_not_updated` (موعد مضى والحركة مسجلة أو ناقصة) | 6 | 12 |

- **إعادة الفارغ المتأخرة** (`empty_return_overdue`) حرجة دائمًا، وتبدأ من اليوم التالي لآخر موعد بتقويم الرياض.
- **الحالة الفعلية:** فاتورة دفترة صادرة غير مُبلغ عن إلغائها تعني `billed`، فلا يُحسب تأخير. المسودة لا تغيّر الحالة.
- **المعاملة الملغاة** لا تُنبّه.

**تجاوز المؤسسة:** يُحفظ في `organizations.settings.status_aging_rules`.

- القيمة `null` تطفئ القاعدة.
- القيمة غير الصالحة في المخزن تُتجاهل، ولا تسبب خطأً عند القراءة.

**الدوال:**

- `get_status_aging_rules(p_org)` يرجع `{rules, defaults, overrides, email_otp_login, can_edit}` للموظفين.
- `set_status_aging_rules(p_org, p_rules, p_reason)`:
  - للمالك فقط: مدير نظام على مستوى المؤسسة، والجلسة aal2. غير ذلك: `MRS_FORBIDDEN owner_only`.
  - السبب مطلوب: `MRS_NOTE_REQUIRED reason`.
  - القواعد تُتحقق: `MRS_INVALID aging_rule` (مفتاح مجهول، ساعات غير صحيحة أو خارج 1..2160، التنبيه ≥ الحرج، `empty_return_overdue`).
  - يستبدل التجاوزات كلها، و`{}` يعيد الافتراضي.

**`tx_attention(p_org, نفس مفاتيح report_transactions)`** — للشريط و«المتأخرة فقط» وتصدير المتابعة. المُرجَع:

```
{items [{transaction_id, ref, level, hours,
         reasons [{code, level, hours, since, subject_id, container_id, container_no, status, warning_hours, critical_hours}]}],
 total, truncated (أكثر من 2000), totals {critical, warning, by_reason}, rules, generated_at}
```

الترتيب: الحرج أولًا، ثم الأقدم.

**التنبيهات:** نوعان جديدان في `operational_alerts` عبر `refresh_alerts` (و`app.alert_causes`).

- `status_stale`:
  - مفتاح منع التكرار: `status_stale:<tx>:<status>`.
  - الشدة تتصاعد من تنبيه إلى حرج.
  - تحديث المعاملة أو تغيّر حالتها يغلقه تلقائيًا.
- `appointment_not_updated`:
  - مفتاح منع التكرار: `appointment_not_updated:<appointment>`.
- `list_alerts {kind}` يقبلهما.

### `report_movements(p_org, filters)` — المواعيد والنقل

**الصف:** كل موعد غير مُعاد جدولته مع نقلته (نفس اختيار `list_movements`)، وكل نقلة بلا موعد.

**المفاتيح** (`app.rpt_mv_keys`):

| المفتاح | ملاحظة |
|---|---|
| `branch_id`، `transaction_id`، `client_id`، `client_q` | |
| `driver_id`، `driver_q`، `truck_q` | |
| `carrier_id`، `party_type`، `party_q` | |
| `movement_status` | `registered` / `incomplete` / `delivered` / `cancelled` |
| `bl_number`، `declaration_no`، `container_no`، `port_code` | |
| `return_status`، `return_scope` | `return_scope`: `overdue` / `pending` / `returned`، وهي منفصلة: صف له تاريخ إعادة فعلي «أُعيدت» ولا يُعدّ متأخرًا (ولا سبب متابعة `empty_return_overdue` له) |
| `destination_q`، `booking_q`، `operator_q`، `employee_id` | |
| `date_field` | `appointment` (الافتراضي) / `return_deadline` / `returned` / `delivered` / `created` / `updated` |
| `from`، `to` | |
| `value_min`، `value_max`، `revenue_min`، `revenue_max` | تحتاج دور مالية النقل وإلا `MRS_FORBIDDEN cost`، ولا تطابق إلا صفوفًا مبالغها ظاهرة |
| `q` | |
| `sort` | `appointment_desc` / `appointment_asc` / `deadline_asc` / `updated_desc` |
| `limit` (≤ 500)، `offset` | |

**الصف المُرجَع:** فيه أعمدة التصدير الـ 19 من النظام القديم، وتعرض الجدول الآتي:

| المجموعة | الأعمدة |
|---|---|
| المعاملة والعميل | `client_name`، `port_name`، `declaration_no`، `bl_number` |
| النقل | `driver_name`، `driver_phone`، `truck_plate`، `container_no`، `appointment_at`، `destination` |
| المبالغ | `cost_amount` (قيمة النقل)، `sell_amount` (عائد المؤسسة)؛ `null` بلا مالية النقل |
| إعادة الفارغ | `return_location`، `return_deadline`، `returned_at`، `return_status` |
| الحركة | `movement_status`، `appointment_no`، `notes` |

ومعها: `booking_ref`، `operator_name`، `party_type`، `party_name`، `overdue`، `days_overdue`، `employee_name`.

**المجاميع:**

```
{count, appointments, cancelled, delivered_containers (مميزة لكل حاوية، وRo-Ro لكل معاملة), overdue_returns,
 by_movement_status, transport_value {CUR: Σ}, revenue {CUR: Σ}, rows_with_finance}
```

المبالغ تُجمع للصفوف غير الملغاة والظاهرة المبالغ فقط. يُرجع أيضًا: `fingerprint`، `finance`، `today`.

### `report_trips` (معاد إنشاؤه) — كشف النقل حسب الجهة والسائق

**مفاتيح جديدة:** `driver_id`، `driver_q`، `party_type`، `party_q`، `q`.

**أعمدة جديدة في الصف:** `driver_id`، `driver_phone`، `party_type`، `party_name`، `transport_order_no`، `client_name`، `appointment_no`، `appointment_at`.

**مجاميع جديدة:**

- `totals.by_carrier [{party_type, party_name, carrier_id, trips, value_by_currency}]`.
- `totals.by_driver [{driver_id, driver_name, trips, value_by_currency}]`.
- الترتيب حسب عدد النقلات تنازليًا.
- القيم مع `include_finance` فقط، وتساوي ما تعرضه الصفوف.

### `report_payments(p_org, filters)` — كشف السدادات (لقرّاء المالية)

**المفاتيح** (`app.rpt_pay_keys`):

| المفتاح | ملاحظة |
|---|---|
| `branch_id`، `transaction_id`، `client_id`، `client_q` | |
| `service_item_id`، `service_code` | |
| `funding_source`، `method`، `review_status`، `movement_type`، `pattern` | رموز، مفردة أو مصفوفة |
| `status` | `recorded` (الافتراضي) / `void` / `all` |
| `date_field` | `paid` (تاريخ السداد، الافتراضي) / `created` |
| `from`، `to`، `q` | |
| `sort` | `paid_desc` / `paid_asc` / `amount_desc` / `created_desc` |
| `limit` (≤ 500)، `offset` | |

**الصف:** أعمدة النظام القديم الـ 15، ومعها `transactions [{id, ref}]`. التوزيعات تظهر فقط إن كان المستخدم يقرأ مالية فرع المعاملة.

**المجاميع:** `{count, paid {CUR}, expected {CUR}, difference {CUR}, by_review_status, by_movement_type}`.

### `report_fasah_scope(p_org, p_nos text[], p_scopes jsonb)` — المطابقة الشهرية مع فسح (للقراءة فقط)

**دور المتصفح:**

- يقرأ الملفات (حتى 20 ملفًا، كل ملف ≤ 10MB) في `assets/js/rpt/fasah-recon.js`.
- يرسل الأرقام فقط: حتى 20000 رقم، كل رقم ≤ 40 حرفًا، وإلا `MRS_TOO_LONG nos`.
- يرسل النطاقات `[{port_code, month 'YYYY-MM'}]`: حتى 100 نطاق، وإلا `MRS_INVALID scopes`.

**المطابقة:** بالأرقام فقط، بلا أصفار بادئة، والأرقام الهندية مقبولة.

**المُرجَع:**

```
{records [{transaction_id, ref, branch_id, client_name, declaration_id, declaration_no, declaration_no_norm, declaration_date,
           month, port_code, port_name, declaration_status, operational_status, cancelled, by_no, in_scope}],
 truncated, counts {by_no, in_scope}, ports [{code, name_ar, name_en, kind, unlocode}], scoped, generated_at}
```

**تفاصيل:**

- السجل: البيانات غير الملغاة ولا المستبدلة، وإلا رقم بيان المعاملة نفسها.
- `scoped = true` عندما يرى المستخدم بعض الفروع فقط.
- الحالات تُحسب في المتصفح، وقاموسها `fasah_match_status`: `matched` / `matched_with_note` / `status_mismatch` / `missing` / `port_mismatch` / `ambiguous` / `system_only`.

### سجل التصدير — `log_report_export` (معاد إنشاؤه)

**أنواع جديدة في `report_kind`:**

| النوع | من يصدّره | المفاتيح |
|---|---|---|
| `movements` | الموظفون | مفاتيح `report_movements`؛ مفاتيح المبالغ تحتاج مالية النقل وإلا `MRS_FORBIDDEN cost` |
| `payments` | قرّاء المالية | مفاتيح `report_payments`؛ غيرهم: `MRS_FORBIDDEN finance` |
| `tx_followup` | الموظفون | مفاتيح البحث؛ تصدير متابعة المعاملات بأعمدته الـ 14 |
| `fasah_recon` | الموظفون | `months` و`port_codes` (حتى 100 لكل منهما، تبعًا لحد النطاقات 100)، `files`، `statuses`، `system_only` (عدد صفوف ورقة «في النظام فقط» في ملف Excel) |

يُسجَّل من صدّر، ونوع التقرير، والصيغة، والفلاتر، وعدد الصفوف. **لا يُسجَّل أي صف من البيانات.**

- مصفوفة أي فلتر حتى 20 قيمة، عدا `months` و`port_codes` في `fasah_recon` (حتى 100).
- `row_count` في `fasah_recon` بصيغة Excel = صفوف ملف فسح المعروضة + صفوف ورقة «في النظام فقط»، والحد (10000 / 2000 للطباعة) على المجموع.

### `audit_trail(p_org, {transaction_id, table_name, row_id, actor, from, to, limit ≤ 200, before_id})` — سجل العمليات

- **من يقرؤه:** مدير النظام والمشرف فقط. غيرهما: `MRS_FORBIDDEN role`.
- **`transaction_id`:** يضم صفوف المعاملة وحاوياتها ومواعيدها ونقلاتها وبياناتها وإثبات الفارغ وطلبات الفوترة، حتى المحذوفة منها. معاملة من مؤسسة أخرى: `MRS_NOT_FOUND transaction`.

**الصف:**

```
{id, at, table_name, row_id, action, actor, actor_name, actor_role,
 label (رمز من قاموس audit_label),
 event {type, from_status, to_status, note} | null,
 changes [{field, from, to}],
 transaction_id, transaction_ref, container_no}
```

- `event`: حدث المعاملة المكتوب في نفس العملية، واسمه من قاموس `audit_event`.
- `changes`: الحقول التقنية مستبعدة، وحتى 60 حقلًا.
- يُرجع أيضًا `next_before_id`.
- **الأداء:** مع `transaction_id` تُقرأ الصفحة من فهرسين: `audit_log_row_idx` لصف المعاملة، و`audit_log_tx_child_idx` (فهرس جزئي على `org_id` و`transaction_id` داخل البيانات، للجداول الستة التابعة) لصفوفها التابعة. لا يُمسح سجل المؤسسة كله.
- أسماء الجداول في الفلتر هي أسماء جداول التدقيق الحقيقية: `port_appointments` و`transport_trips` (لا `appointments` / `trips`).
- **عرض الفرق:** الواجهة تكتب «من X إلى Y» بأسماء الحقول من i18n.

### الدخول برمز عبر البريد

**الإعداد:** مطفأ افتراضيًا على مستويين:

1. مفتاح المنصة في إعداد الموقع، وتقرأه صفحة الدخول.
2. مفتاح المؤسسة `set_email_otp_login(p_org, p_enabled, p_reason)`: للمالك فقط، بجلسة aal2، والسبب مطلوب.

**ما تفعله صفحة الدخول:**

- تستخدم `signInWithOtp({email, options: {shouldCreateUser: false}})`.
- تعرض رسالة موحدة لا تكشف وجود الحساب.
- تعتمد على حدود Supabase:
  - الانتظار بين الطلبات 60 ثانية.
  - صلاحية الرمز: تُضبط إلى 10 دقائق في لوحة Supabase.
  - حد محاولات التحقق.
- تضيف عدادًا محليًا: 5 محاولات.

**بعد الدخول بالرمز:** تستدعي الصفحة `otp_session_check()`، ويرجع `{otp_session, allowed, reason, aal, mfa_pending}`.

- إن كانت `allowed = false` تخرج الصفحة من الجلسة.
- قيم `reason`:

| القيمة | المعنى |
|---|---|
| `org_disabled` | المؤسسة لم تفعّل الدخول بالرمز |
| `no_staff_membership` | مستخدم بوابة فقط، أو بلا عضوية |
| `ok` | مسموح |
| `password` | الجلسة ليست بالرمز |

**المصادقة الثنائية لا تتغير:** جلسة الرمز aal1، فيبقى شرط aal2 لصلاحيات المدير. `mfa_pending` يقول ذلك.

**حدود معروفة، وما قررناه (مراجعة 2026-11-11):**

- إتاحة الرمز على مستوى Supabase Auth إعدادُ مشروع، ولا يمكن إطفاؤه وحده دون إطفاء البريد وكلمة المرور.
- في التدفق الضمني (implicit) لـ GoTrue تحمل جلسة رابط البريد (استعادة كلمة المرور، تأكيد التسجيل، الدعوة) نفس `amr = otp` التي تحملها جلسة الرمز. لذلك لا يستطيع الخادم التفريق بينهما.
- **لهذا لا يُفرض المفتاحان في RLS:** فرضهما على `amr` في `has_role` / `is_member` كان سيكسر الاستعادة والتأكيد، ولا يمنع من يملك البريد، لأنه يستطيع استعادة كلمة المرور ثم الدخول بها. المفتاحان سياسة لنموذج الدخول في الموقع، لا حدّ أمان.
- **حد الأمان الحقيقي:** المصادقة الثنائية. جلسة أي رابط أو رمز بريد aal1، وRLS يشترط aal2 لأدوار المدير (`app.mfa_ok`).
- **`otpGate()` في الواجهة:** يفحص فقط الجلسة التي فتحها نموذج الرمز في هذا الموقع. يحدّدها مُعرِّف الجلسة (`session_id`) المحفوظ عند `verifyEmailOtp`، ويُمسح عند الخروج. جلسات روابط البريد لا تُخرَج أبدًا (`reason = email_link`).
- لم نغيّر التدفق إلى PKCE: كان سيجعل رابط الاستعادة والتأكيد يعمل في المتصفح نفسه فقط.

## الواجهة

كل الشاشات للقراءة فقط، عدا إعدادات المالك. النصوص في `assets/i18n/lrpt.js` (عربي وإنجليزي)، والتنسيق في `assets/css/pages/lrpt.css`.

| الشاشة | الملف | من يراها |
|---|---|---|
| بطاقات المعاملات ومراحل البيان في تبويب «التشغيل» من `#dashboard` | `rpt/dashboards.js` | الموظفون |
| `#register` سجل المعاملات والمتابعة | `rpt/register.js` | الموظفون (عمود دفترة وفلترها لقرّاء المالية) |
| `#reports/movements` و`#reports/payments` وتجميع النقل في `#reports/trips` | `rpt/reports.js` و`rpt/export.js` | الموظفون؛ السدادات لقرّاء المالية |
| `#fasah_recon` المطابقة الشهرية مع فسح | `rpt/fasah-recon.js` | الموظفون |
| `#attention_rules` قواعد المتابعة ومفتاح الدخول بالرمز | `rpt/rules.js` | الموظفون يقرؤون، والمالك يعدّل |
| `#changes` سجل العمليات، وقسم «سجل العمليات على المعاملة» | `rpt/audit-diff.js` | مدير النظام والمشرف |
| فلاتر الأعمدة | `rpt/colfilter.js` | في السجل والتقارير والمطابقة |
| شاشة التقدم ومؤشر زمن الاستجابة والأخطاء التقنية | `app-shell.js` | كل الصفحات |
| الدخول برمز | `login.html` و`auth.js` | الموظفون، إذا فُعّل المفتاحان |

- رابط `#transactions?status=` أو `?stage=` أو `?daftra_state=` أو `?attention=` يفتح `#register` بنفس الفلاتر. أما `#transactions` بلا فلتر فيبقى القائمة القديمة.
- **فلاتر الأعمدة** تعمل على الصفحة المحمّلة. التصدير يأخذ الصفوف المعروضة نفسها، ويستبدل الإجماليات بعدد الصفوف.
- **كشف المتابعة:** 14 عمودًا، ولون المتابعة في خلية الحالة (Excel والطباعة A4 أفقي).
- **الدخول برمز:** مفتاح المنصة `MARSA_CONFIG.emailOtpLogin` (غائب = مطفأ). كل صفحات التطبيق تفحص عبر `otpGate()` الجلسة التي فتحها نموذج الرمز، وتخرج منها إن لم تُسمح، والفحص يُغلق عند الخطأ. جلسات روابط البريد (الاستعادة والتأكيد والدعوة) لا تُفحص.
- **كشف السدادات (ملف):** على أعمدة «كشف السدادات» القديمة: «م»، رقم البوليصة، و«رقم السداد» و«المرجع البنكي» و«رقم الإيصال / العملية» في ثلاثة أعمدة منفصلة.
- **تقرير المواعيد والنقل:** فلتر الموظف (`employee_id`، موظفو المؤسسة فقط) وحالة إعادة الفارغ (`return_status`).
- **قراءة ملفات فسح:** حتى 64 م.ب بعد فك الضغط لكل ملف، و50011 صفًا، و256 عمودًا (`XlsxLite.read(buf, limits)`). تُقرأ الملفات واحدًا بعد الآخر.
- **تبديل المؤسسة:** يُفرَّغ السجل والمطابقة وسجل العمليات، ويُحذف استعلام عنوانها. ونتيجة المطابقة الأخيرة لا تُعرض إلا للمؤسسة التي أنتجتها.
- **قواعد المتابعة:** القاعدة الموقوفة (`null`) تظهر «موقوفة» وتبقى موقوفة عند حفظ صف آخر.
- الاختبارات: `supabase/tests/legacy-reports-ui-tests.js`.
