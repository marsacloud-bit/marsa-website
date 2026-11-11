# السدادات والمصروفات وعهدة العملاء — المرحلة 6 من نقل النظام القديم

> **الحالة:** بيئة الاختبار (staging) فقط. لا شيء يُرسل إلى دفترة في هذه المرحلة (دفترة هي المرحلة 7).
> ملف الترحيل:
> `supabase/migrations/20261122000100_legacy_pay.sql`
> (يتطلب `20261121000100_legacy_appt.sql`، وهو مضاف في آخر `supabase/all_migrations.sql`)
> الاختبارات:
> `supabase/tests/legacy-pay-sql-tests.js`
> و`supabase/tests/ai-docs-tests.js` (القسم 7h)
> القراءة الآلية: الدالة الطرفية `ai-extract` بالإصدار `ai-doc-v3` والنموذج `claude-opus-5-5`
> مساعد النموذج في المتصفح: `assets/js/fin/pay-ai.js` (`MarsaPayAi`)
> الخطة: `docs/online/LEGACY_PORT_PLAN_AR.md` (قسم «السدادات وعهدة العملاء»).

## 1) لماذا سجل جديد وليس توسيع supplier_payments

- سداد المورد في G4 (`supplier_payments`) دليل دفع على **فاتورة مورد واحدة** (الحقل إلزامي، مع حد عدم تجاوز المستحق وحالة دفع الفاتورة).
- قيد السداد في النظام القديم قد لا يخص أي فاتورة (استلام من العميل، رسم بلا فاتورة)، أو فاتورة واحدة، أو عدة فواتير ومعاملات (سداد مشترك)، ويحمل نوع الحركة ومصدر التمويل والمراجع وحالة المراجعة.
- لذلك السجل الموحد جدولان جديدان:
  `client_disbursements` (قيد السداد)
  و`disbursement_allocations` (حصة كل معاملة / فاتورة).
- كل توزيع فيه رقم فاتورة لجهة مستفيدة **يُنشئ** صف `supplier_payments` واحدًا مرتبطًا به (`disbursement_allocation_id`):
  - `org_paid` → الدافع `company`.
  - `client_direct` → الدافع `client` (عميل المعاملة).
- بهذا تبقى حالة دفع الفاتورة وحد التجاوز (`MRS_OVERPAID`) والهوامش في G4 كما هي.
- الفاتورة نفسها تُنشأ في `supplier_invoices` إن لم تكن موجودة لنفس الجهة ونفس الرقم، وإلا يُعاد استخدام الموجودة.

## 2) الجداول

| الجدول | المحتوى |
|---|---|
| `client_disbursements` | القيد: `ref` بصيغة PAY-000123، نوع الحركة، النمط، بند الخدمة، رقم الفاتورة / المطالبة (الفردي)، رقم الموعد TAS، المطلوب / المسدد / الفرق، التاريخ (تاريخ بلا وقت)، مصدر التمويل، الطريقة، الحساب المسدد منه، الدافع، المستفيد (= مصدر الفاتورة)، قناة الدفع، رقم السداد / المرجع البنكي / الإيصال، حالة المراجعة، `recorded → void`، سلسلة التصحيح (`corrects_id` / `corrected_by_id`) |
| `disbursement_allocations` | حصة كل معاملة: المبلغ، رقم الفاتورة وصيغتها الموحدة، الرقم الداخلي (FP…)، فاتورة G4 وسدادها، والمبلغ المسترد على العميل إن طُلب |
| `payment_documents` | المرفقات المصنفة: `entity_invoice` (فاتورة الجهة)، `payment_proof` (إثبات السداد)، `extra` (مرفق إضافي)؛ لكل توزيع في السداد المشترك؛ الإزالة ناعمة (`removed_at`) والملف نفسه في `finance_documents` |
| `client_custody_entries` | عهدة العملاء: `deposit` (إيداع)، `deduction` (خصم)، `refund` (إرجاع)؛ `active → void` بسبب لا يقل عن 3 أحرف |
| `client_custody_balances` | عرض (security invoker) لأرصدة العملاء من الحركات التي يراها المستخدم في فروعه |

- لا حذف في أي جدول (`MRS_APPEND_ONLY`).
- القيم لا تتغير بعد الحفظ (`MRS_IMMUTABLE`)؛ التعديل = إلغاء + تسجيل جديد.
- كل الجداول مدققة في `audit_log`.
- الأعمدة الجديدة في G4:
  - `supplier_invoices.internal_invoice_no` (فريد بين الفواتير غير الملغاة في المؤسسة، مقارنة بالحروف والأرقام فقط)
  - `supplier_invoices.created_by_disbursement_id`
  - `supplier_payments.disbursement_allocation_id`
- أُعيد إنشاء `app.tg_payment_totals`: سداد العميل المباشر المسجل من السجل يسوّي حصة العميل دون توزيع تكلفة G4 (التوزيع نفسه يثبت الحصة). حد التجاوز وحماية «محمّل على العميل» باقيان.

## 3) القواعد

### نوع الحركة ومصدر التمويل

| نوع الحركة | مصدر التمويل |
|---|---|
| `org_paid` دفعت المؤسسة عن العميل | `org_account`، `cash_box`، `fasah_wallet`، `dry_port_wallet_org`، `client_custody`، `client_custody_dry_port`، `personal_account` (إلزامي) |
| `received_from_client` استلمت المؤسسة من العميل | `not_applicable_receipt` (يُضبط تلقائيًا)؛ المستفيد = المؤسسة، بلا جهة ولا فاتورة |
| `client_direct` دفع العميل للجهة مباشرة | `client_direct` (يُضبط تلقائيًا) |

### مصفوفة مصدر التمويل × طريقة السداد

مطبقة في SQL كقيد CHECK على الجدول (`app.fin_funding_check`)، وفي الدالة قبله برسالة واضحة `MRS_PAY_FUNDING <rule>`:

- `fasah_wallet` ⇔ الطريقة `fasah_wallet`.
- `cash_box` ⇒ الطريقة `cash`.
- الطريقة `dry_port_wallet` ⇔ مصدر `dry_port_wallet_org` أو `client_custody_dry_port`.
- `personal_account` يتطلب اسم الدافع.
- `sadad` و`mada` و`bank_transfer` تتطلب الحساب المسدد منه.
- المحافظ (`fasah_wallet` / `dry_port_wallet`) بلا بنك.
- طرق السجل: `sadad`، `mada`، `fasah_wallet`، `dry_port_wallet`، `bank_transfer`، `cash`، `cheque`، `other` (لا `card` ولا `offset`).

### الدافع الافتراضي

- `org_account`: اسم المؤسسة من إعداداتها `organizations.settings.payer_name`، وإلا `name_ar` (ليس ثابتًا في الكود).
- `cash_box`: الاسم المدخل، وإلا اسم المؤسسة.
- محفظة فسح: «محفظة فسح».
- محفظة الميناء الجاف: «محفظة الميناء الجاف».
- عهدة العميل، والدفع المباشر، والاستلام: اسم العميل إن لم يُدخل.

### المراجع حسب الطريقة

| الطريقة | الحقل | الصيغة |
|---|---|---|
| `sadad` | `sadad_number` | أرقام فقط (تُحوَّل الأرقام العربية) |
| `bank_transfer` | `bank_reference` | `^[A-Z0-9]+(-[A-Z0-9]+)*$` بعد التحويل إلى أحرف كبيرة |
| `mada` / `cash` / `cheque` / `other` | `receipt_no` | حتى 100 حرف، حروف وأرقام |
| المحافظ | أي مرجع أو ملف إثبات السداد | — |

- إدخال مرجع لا يخص الطريقة يُرفض: `MRS_PAY_REF_METHOD`.
- مرجع مفقود: `MRS_REQUIRED <field>`.
- صيغة خاطئة: `MRS_PAY_REFERENCE <field>`.

### منع التكرار على مستوى المؤسسة

- رقم السداد، والمرجع البنكي (بدون الشرطات والحالة)، والإيصال (بدون الفواصل) فريدة بين القيود المسجلة.
- الرسالة `MRS_PAY_REF_TAKEN` تذكر القيد السابق ومعاملته ومبلغه (في HINT بصيغة `PAY-000012 · MRS-2026-000007 · 1250.00 SAR`).
- الإلغاء يحرر المرجع.
- فهارس فريدة جزئية تحمي من السباق.

### هوية الفاتورة

- نفس الجهة + نفس الرقم (بعد توحيد الصيغة `app.fin_norm_no`) في قيد حي = منع: `MRS_PAY_INVOICE_TAKEN invoice_number`. هذا يشمل التكرار داخل السداد المشترك نفسه، وهو محمي بفهرس فريد.
- نفس الرقم لجهة أخرى = `MRS_CONFIRM_INVOICE_REUSE` يذكر الجهة الأخرى، ويمر بـ `confirm_invoice_reuse: true`.
- الرقم الداخلي FP… فريد: `MRS_PAY_INVOICE_TAKEN internal_invoice_no`.
- فاتورة G4 موجودة للجهة بنفس الرقم يُعاد استخدامها ولا تُنشأ مرتين.

### السداد المشترك

- توزيعان على الأقل، ومجموعها = إجمالي السداد (±0.005)، وكل مبلغ > 0.
- لا تكرار لنفس المعاملة + نفس الفاتورة.
- فرع واحد للقيد.
- عميل واحد في الدفع المباشر والاستلام والتمويل من العهدة.
- تحقق مؤجل في نهاية المعاملة (`trg_pay_sum`).
- المعاملة ترى **حصتها فقط** (`tx_disbursements`).

### المرفقات

- PDF أو صورة.
- 4 ميجابايت لكل ملف، و8 ملفات في الحفظ الواحد، و12 ميجابايت للمجموع.
- الملف من فرع القيد، ومرتبط بقيد واحد حي.
- في السداد المشترك كل `entity_invoice` تحدد توزيعها (برقمه أو `key`)، وفي الفردي لا رابط توزيع.
- الإزالة ناعمة.

### بند الخدمة ورقم الموعد

- بند الخدمة من دليل المؤسسة `org_service_items`، ومنه بندا `gate_in_appointment` / `gate_out_appointment`.
- رقم الموعد يوحَّد بـ `app.norm_tas`: حذف علامات الاتجاه، وتصحيح صيغة …TAS المعكوسة، والناتج TAS ثم 8 أرقام على الأقل. يقابله في JS `MarsaNorm.normTas`.

### التاريخ والمبلغ المسترد

- التاريخ تاريخ فقط، لا يتجاوز اليوم بتوقيت الرياض.
- `charge_client` (لـ `org_paid` فقط) ينشئ مبلغًا مستردًا **مسودة** في `client_charges` (`reimbursable`، الضريبة 0)، ولا يُرسل شيء إلى دفترة.

### المراجعة بمبدأ أربع أعين

- `draft` → `submit` → `pending` → `approve` / `reject` (الرفض بملاحظة).
- المعتمد ليس المنشئ، **ولا استثناء للمدير**: `MRS_FORBIDDEN self_approval`.
- الذكاء الاصطناعي لا يعتمد شيئًا.

### التصحيح والإلغاء

- التصحيح (`correct_payment`) = إلغاء + تسجيل جديد في معاملة واحدة:
  - يلغي سدادات G4 والمبلغ المسترد المسودة وفواتير G4 التي أنشأها القيد إن لم يتعلق بها شيء آخر.
  - يحمل المرفقات (الرابط بالتوزيع يتبع المعاملة + الفاتورة).
  - يبدأ القيد الجديد بانتظار المراجعة.
  - يسجل حدثًا ماليًا قبل / بعد بلا مبالغ.
- الإلغاء (`void_payment`) لمعتمدي المالية فقط.
- كلاهما يُرفض `MRS_PAY_LOCKED` عندما يكون القيد:
  - مرتبطًا بدفترة: `daftra`؛ الأعمدة محجوزة للمرحلة 7.
  - أو مبلغه المسترد مفوترًا: `invoiced`.
  - أو مخصومًا من عهدة نشطة: `custody`.

### عهدة العملاء

- المبلغ > 0.
- الخصم مرتبط بمعاملة لنفس العميل وبقيد سداد مسجل لها.
- الخصم ≤ حصة ذلك القيد في المعاملة.
- خصم نشط واحد لكل عميل + معاملة + سداد.
- **الرصيد لا يصبح سالبًا أبدًا**:
  - قفل استشاري لكل عميل.
  - تحقق في الدالة.
  - Trigger `trg_custody_balance` بعد أي إدخال أو إلغاء.
- إلغاء إيداع يجعل الرصيد سالبًا مرفوض `MRS_CUSTODY_NEGATIVE void_deposit` (إصلاح خطأ النظام القديم).
- أرصدة المحافظ مرحلة لاحقة: يُسجَّل مصدر التمويل فقط.

### الصلاحيات

- القراءة:
  - لأدوار المالية `accountant` و`accounts_manager` و`branch_manager` و`supervisor` و`admin` في فرع القيد.
  - موظفو التشغيل والعملاء والمؤسسات الأخرى لا يرون شيئًا.
- الكتابة عبر الدوال فقط:
  - `accountant`، `accounts_manager`، `branch_manager`، `admin`.
  - الاعتماد والإلغاء: `accounts_manager`، `branch_manager`، `admin`.

## 4) الدوال (RPC) — كلها لـ authenticated فقط

| الدالة | الوظيفة |
|---|---|
| `record_payment_bundle(p_payload, p_idem_key)` | حفظ القيد + فاتورة G4 إن كانت جديدة + سداد G4 + التوزيعات + المرفقات؛ idempotent |
| `correct_payment(p_id, p_payload, p_reason, p_idem_key)` | إلغاء + تسجيل جديد |
| `void_payment(p_id, p_reason)` | إلغاء |
| `review_payment(p_id, submit\|approve\|reject, p_note)` | المراجعة بأربع أعين |
| `add_payment_documents(p_id, p_documents, p_idem_key)` | إضافة مرفقات |
| `remove_payment_document(p_link, p_reason)` | إزالة ناعمة |
| `get_payment(p_id)` | القيد كاملًا |
| `list_payments(p_org, p_filters)` | البحث والمرشحات |
| `tx_disbursements(p_tx)` | لوحة سدادات المعاملة (الحصة فقط) |
| `check_payment_duplicates(p_org, p_payload)` | فحص فوري للتكرار دون حفظ |
| `match_payment_transaction(p_org, p_hints)` | اقتراح المعاملة؛ `unique_transaction_id` فقط عند مرشح واحد |
| `save_custody_entry(p_payload, p_idem_key)` | حركة عهدة |
| `void_custody_entry(p_id, p_reason)` | إلغاء حركة عهدة |
| `list_custody_entries(p_org, p_filters)` | سجل العهدة |
| `custody_balances(p_org, p_filters)` | الأرصدة لكل عميل |
| `client_custody_balance(p_client)` | رصيد عميل لصفحة العميل |

غلاف كل دالة في `assets/js/supa.js`:

```
recordPaymentBundle, correctPayment, voidPayment, reviewPayment, addPaymentDocuments,
removePaymentDocument, getPayment, listPayments, txDisbursements, checkPaymentDuplicates,
matchPaymentTransaction, saveCustodyEntry, voidCustodyEntry, listCustodyEntries,
custodyBalances, clientCustodyBalance
```

## 5) رموز الأخطاء الجديدة

| الرمز | المعنى (detail) |
|---|---|
| `MRS_PAY_REF_TAKEN` | مرجع مكرر (`sadad_number` / `bank_reference` / `receipt_no`)؛ HINT = القيد · المعاملة · المبلغ |
| `MRS_PAY_REF_METHOD` | مرجع لا يخص الطريقة |
| `MRS_PAY_REFERENCE` | صيغة المرجع |
| `MRS_PAY_FUNDING` | قاعدة المصفوفة المكسورة |
| `MRS_PAY_ALLOCATION` | `count`، `sum` (HINT الفرق)، `amount`، `duplicate`، `branch`، `client`، `not_allowed` |
| `MRS_PAY_DOCUMENT` | `count`، `size`، `total`، `type`، `branch`، `in_use`، `allocation`، `role` |
| `MRS_PAY_INVOICE_TAKEN` | `invoice_number` / `internal_invoice_no` |
| `MRS_CONFIRM_INVOICE_REUSE` | نفس الرقم لجهة أخرى؛ HINT = الرقم · الجهة |
| `MRS_PAY_LOCKED` | `daftra` / `invoiced` / `custody` |
| `MRS_CUSTODY_NEGATIVE` | الرصيد سيصبح سالبًا؛ HINT = الرصيد الحالي |
| `MRS_CUSTODY_LINK` | `transaction_required`، `payment_required`، `client_mismatch`، `payment_not_in_transaction`، `exceeds_payment` (HINT الحد)، `duplicate_deduction`، `payment_void` |

الرسائل بالعربية والإنجليزية في `assets/js/i18n.js`، وبالعربية في `assets/js/supa.js`.

## 6) القراءة الآلية لمستندات السداد (ai-doc-v3)

- نوعان جديدان: `appointment_invoice` (فاتورة الجهة، ومنها فاتورة مواعيد فسح TAS) و`payment_proof` (إثبات السداد).
- كل نوع بمخطط صارم، بنفس شكل استدعاء Claude ونفس الحصة: حجز `ai_reserve` لكل ملف.
- الحد: 4 ميجابايت لكل ملف، ومستند واحد في كل طلب.
- يجمع النموذج في المتصفح حتى 6 مستندات و12 ميجابايت ويقارنها: `MarsaPayAi.merge`.

### فاتورة الجهة

- الرقم = Reference No في فاتورة فسح، **ولا يُستخدم رقم FP… أبدًا**؛ يذهب إلى الرقم الداخلي.
- رقم الموعد TAS موحَّد.
- النوع: `gate_in` / `gate_out`، ومنه بندا `gate_in_appointment` / `gate_out_appointment`.
- جمع Amount after VAT لكل الصفحات (مثل 34.50 + 19.55 = 54.05).
- التاريخ = Date of Payment.
- البوليصة، والبيان، والحاويات (ISO 6346).

### إثبات السداد

- المستفيد (قنوات الدفع Fasah وTabadul وSADAD وmada وVisa وMastercard وApple Pay وSTC Pay وurpay **لا تكون مستفيدًا أبدًا**؛ تنتقل إلى `payment_channel`).
- الدافع.
- الطريقة بالرمز.
- التاريخ.
- المبلغ.
- رقم السداد (أرقام فقط).
- المرجع البنكي (ليس IBAN).
- الإيصال.

### النتيجة والتعبئة

- المستند الخطأ (إثبات في خانة الفاتورة أو العكس) يُرفض `wrong_document_type` (`not_entity_invoice` / `not_payment_proof`، رمز 422 بعد التسوية).
- هذه القراءات **لا تُحفظ** في `document_extractions` ولا يُعاد استخدامها: النموذج **يملأ الحقول الفارغة فقط** (`MarsaPayAi.fillEmpty`)، والموظف يحفظ.
- تحذيرات المقارنة:
  - جهات مختلفة.
  - المستفيد لا يطابق الجهة.
  - المبلغ لا يطابق.
- المعاملة تُقترح فقط عندما يكون المرشح وحيدًا (`match_payment_transaction`)، ولا تُحفظ تلقائيًا.

## 7) إعادة اللصق

- الملف قابل لإعادة التشغيل دون تغيير.
- إعادة لصق `20261104000100` (G4) بعده تعيد شرط G4 لسداد العميل المباشر؛ أعد لصق هذا الملف بعده.
- إعادة لصق ملفات التحويل أو المراحل السابقة (`20261115000100` … `20261121000100`) تحذف الجداول الأربعة من قوائم التحويل؛ أعد لصق هذا الملف بعدها.

## 8) الواجهة (admin.html)

| الشاشة | الملف | الوصول |
|---|---|---|
| سجل السدادات `#payments`: بحث ومرشحات (الحالة، المراجعة، الطريقة، مصدر التمويل، نوع الحركة، التاريخ، المعاملة)، والجدول يمرر داخل صندوقه | `assets/js/fin/payments.js` | أدوار القراءة المالية |
| نموذج السداد `#payments/new` (و`?tx=<id>` مربوطًا بمعاملة، و`?correct=<id>` للتصحيح) | `assets/js/fin/payments.js` | كُتّاب المالية |
| تفاصيل السداد `#payments/<id>`: المراجعة بأربع أعين، التصحيح، الإلغاء بسبب، المرفقات | `assets/js/fin/payments.js` | القراءة؛ الإجراءات حسب الدور |
| قسم «السدادات والمصروفات» في صفحة المعاملة: حصة المعاملة فقط + «إضافة سداد» | `assets/js/fin/tx-fin.js` (`fin-payments`) | أدوار القراءة المالية في فرع المعاملة |
| عهدة العملاء `#custody` (و`?client=<id>`): الأرصدة، السجل، إيداع / خصم / إرجاع، الإلغاء بسبب | `assets/js/fin/custody.js` | القراءة؛ الكتابة والإلغاء حسب الدور |
| رصيد العهدة في صفحة العميل `#client/<id>` | `assets/js/fin/custody.js` (`MarsaOps.clientSections`) | أدوار القراءة المالية |

- النموذج يعكس مصفوفة مصدر التمويل × الطريقة نفسها (`MarsaOps.finPay.pure.fundingRule` بنفس ترتيب `app.fin_funding_check`): يعرض الطرق المسموحة فقط، ويُظهر حقل المرجع الخاص بالطريقة مع تحقق فوري، ويشرح التكرار بالسداد السابق ومعاملته ومبلغه وتاريخه (`check_payment_duplicates`).
- `MRS_CONFIRM_INVOICE_REUSE` يفتح تأكيدًا صريحًا يذكر الجهة الأخرى؛ الموافقة تعيد الإرسال بـ `confirm_invoice_reuse: true`.
- «قراءة المستندات بـ Claude»: حتى 6 مستندات، طلب لكل مستند، ثم `MarsaPayAi.merge` و`fillEmpty`: تُملأ الحقول الفارغة فقط (تاريخ السداد الافتراضي «اليوم» يُعد فارغًا ما لم يغيّره الموظف)، وتُعرض التحذيرات، وتُقترح المعاملة فقط عند مرشح وحيد، ولا يُحفظ شيء.
- المسودة المؤقتة: `assets/js/fin/draft.js` (`MarsaDraft`) في sessionStorage لكل مستخدم ولكل نموذج، مع try/catch؛ المرفقات لا تُحفظ فيها.
- التواريخ: «اليوم» بتوقيت الرياض، وتاريخ السداد يُعرض كما هو دون إزاحة منطقة الجهاز؛ الطوابع الزمنية تُعرض بتوقيت الرياض.
- النصوص: `assets/i18n/pay.js` (عربي + إنجليزي)، والأنماط: `assets/css/pages/pay.css`.
- الاختبارات: `supabase/tests/legacy-pay-ui-tests.js`.

## 9) إصلاحات المراجعة (الخطوة 6)

- **أربع أعين عبر التصحيحات:** لا يعتمد السداد ولا يرفضه من أنشأه، ولا من أنشأ أي سداد في سلسلة التصحيح (`created_by` أو `original_created_by` على امتداد `corrects_id`)، عبر `app.pay_is_author`. ينطبق ذلك على `review_payment` وعلى `four_eyes.can_review`.
- **المرفقات بعد الاعتماد:** `add_payment_documents` و`remove_payment_document` يرفضان السداد المعتمد (`MRS_BAD_TRANSITION approved_documents`)، ولتغيير المستندات يُستخدم التصحيح. ولا يُزال آخر إثبات سداد إذا كانت قاعدة الحفظ تتطلبه: يُرفض بـ `MRS_REQUIRED payment_reference` للمحفظة بلا مرجع، وبـ `MRS_REQUIRED payment_proof` للسداد المباشر من العميل إذا كان على فاتورة.
- **الفروع في فحص التكرار:** التفرد يبقى على مستوى المؤسسة كلها. لكن سداد فرع لا يملك المستخدم قراءته يُذكر بأنه «مستخدم» فقط (`hidden: true`)، بلا مرجع السداد ولا المعاملة ولا المبلغ ولا التاريخ ولا اسم الجهة. يسري هذا على `check_payment_duplicates` وعلى تلميحات `MRS_PAY_REF_TAKEN` و`MRS_PAY_INVOICE_TAKEN` و`MRS_CONFIRM_INVOICE_REUSE`.
- **التصحيح ونقل الفرع:** المرفقات المنقولة في التصحيح تخضع لشرط الفرع نفسه الذي يخضع له المرفق الجديد (`MRS_PAY_DOCUMENT branch` مع اسم الملف). عند نقل السداد إلى فرع آخر يُلغى تحديد هذه المرفقات (`remove_document_ids`).
- **تاريخ الفاتورة وضريبتها في التصحيح:** إذا لم يرسل النموذج `invoice_date` أو `invoice_vat_amount`، يأخذهما التصحيح من الفاتورة التي أنشأها السداد المصحَّح لنفس الجهة ونفس الرقم. ويعرض `get_payment` الحقلين `allocations[].supplier_invoice.invoice_date` و`vat_amount`، فتملؤهما الواجهة مسبقًا. وفي السداد المشترك لكل توزيع حقل ضريبة خاص به.
- **هوية الفاتورة:** المفتاح هو `app.pay_inv_key`، أي `app.fin_norm_no` بعد حذف الشرطة المتبقية بين مجموعات الأرقام. بذلك تُعامل `INV-123/456` و`INV 123456` و`INV123456` على أنها فاتورة واحدة، وتُقارن فواتير G4 بالمفتاح نفسه. يُطبَّق المفتاح على السدادات الجديدة؛ أما الصفوف الموجودة في `invoice_norm`، إن وُجدت على بيئة الاختبار، فتبقى بقيمتها القديمة.
- **تأكيد إعادة استخدام الرقم:** الخطأ `MRS_CONFIRM_INVOICE_REUSE` يسرد كل الأرقام المتعارضة في السداد، حتى خمسة أرقام. وفي الواجهة يغطي التأكيد ما كان معروضًا عند التأكيد فقط: أي تغيير في الجهة أو المعاملة أو رقم الفاتورة أو الرقم الداخلي يُسقطه، ولا يُحفظ التأكيد في المسودة.
- **رسوم المواعيد:** في `gate_in_appointment` و`gate_out_appointment` يكون رقم المطالبة هو الرقم المرجعي (Reference No)، ولا يُقبل رقم يبدأ بـ FP (`MRS_INVALID claim_no_fp`)، والتحقق في الخادم وفي النموذج.
- **الرقم الداخلي:** فريد في الفواتير وفي توزيعات السداد الحية، ومنها التوزيع الذي لا يحمل رقم فاتورة. إذا كانت فاتورة G4 المعاد استخدامها تحمل رقمًا داخليًا آخر، يُرفض الحفظ بـ `MRS_INVALID internal_invoice_mismatch` مع الرقم الموجود. ولا يعرض فحص التكرار أثناء التصحيح (`exclude_id`) الرقمَ الداخلي الخاص بالسداد نفسه.
- **المدفوع أكبر من المطلوب:** يُقبل ذلك كما في النظام القديم، فيكون الفرق سالبًا. وإجمالي فاتورة السداد الفردي يساوي الأكبر من المطلوب والمدفوع، ما لم يُرسل `invoice_total`.
- **القراءة الآلية:** إثباتات السداد المتعددة لسداد واحد لا تُجمع مبالغها، بل يُعتمد الإثبات الأول. وإذا اختلف مبلغ إثبات آخر يظهر التحذير `proofs_differ`. تقبل القراءة PDF وصور JPEG وPNG وWebP فقط؛ صور GIF غير مقبولة، وصور HEIC تُرفق ولا تُقرأ. ولا تستبدل القراءة تاريخ السداد المسجل في نموذج التصحيح.
- **العهدة:** شريط البحث والتصفية يُبنى مرة واحدة لكل تبويب، فلا تُفقد الكتابة أثناء البحث.
