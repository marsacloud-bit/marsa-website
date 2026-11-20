<!-- وصف طلب الدمج (Pull Request) لفرع owner/ui-reorg → online-staging. أعدّه Claude Code للمالك، 19 نوفمبر 2026. -->

## ماذا يغيّر هذا الطلب؟ / What does this change?

ترتيب لوحة الموظفين حسب قرارات المالك، ومراحل المعاملة كخط زمني يُبنى من إعدادات لكل نوع معاملة.
- القائمة الجانبية بتسعة عناوين تُطوى وتُفتح، ودمج قائمة المعاملات في «المعاملات» (السجل).
- شريط علوي فيه خانة بحث وزر «؟»، وجدول «المعاملات» بكامل العرض بفلاتر صغيرة.
- خط زمني بمراحل المالك السبع (م1).
- ترحيل جديد يجعل المراحل إعدادًا لكل نوع معاملة، ويضيف الانتقال التلقائي إلى `under_billing` بعد توثيق إرجاع كل الحاويات (م2).

الشرح الكامل: `docs/owner/word/ملاحظات-تقنية-للدكتور-أحمد.docx`. قرارات المالك: `docs/owner/sections-decisions.md`. طلب المراحل: `docs/owner/transaction-stages-request.md`. قواعد المالك لكلود كود: `CLAUDE.md`.

## نوع التغيير
- [x] واجهة (HTML / CSS / JS)
- [x] ترحيل قاعدة بيانات (`supabase/migrations/20261204000100_tx_stage_sets.sql`)
- [x] دوال RPC / سياسات RLS / صلاحيات (جدولان جديدان + إعادة إنشاء `tx_lifecycle` و`advance_tx_status` و`tg_containers_legacy_tx` و`convert_keep_tables`)
- [x] توثيق
- [ ] سكربتات تشغيل / نسخ احتياطي (لم تُلمس؛ تعديلاتك غير المحفوظة على `scripts/*` بقيت عندك كما هي)

## قائمة التحقق
- [x] الفرع الهدف `online-staging`.
- [x] لا أسرار في الطلب (فحص `CONTRIBUTING.md` §2 قبل كل التزام).
- [x] `assets/js/config.js` لم يتغير.
- [x] بيانات الاختبار وهمية فقط.

### ترحيل قاعدة البيانات
- [x] ملف جديد؛ لم يُعدَّل ترحيل مطبَّق.
- [x] قابل لإعادة التشغيل، ويُدرج `20261204000100` في `schema_versions`، وفيه preflight وdown-path.
- [x] الجدولان `tx_stage_sets` و`tx_stage_steps`: RLS، `REVOKE ALL … FROM anon`، `tg_audit`، ومضافان إلى `TENANT_TABLES`.
- [x] لا دوال `public.*` جديدة. `tx_lifecycle` أعيد إنشاؤه بنفس التوقيع والصلاحيات.
- [ ] **لم يُطبَّق على Staging.** النسخة الاحتياطية والتطبيق بعد مراجعتك وبقرار المالك.

### الواجهة
- [x] `node --check` لكل ملف JS معدّل.
- [x] جُرّب بالعربية على عرض كبير وعرض جوال (صفحة اختبار ببيانات وهمية)، وجرّبه المالك على `localhost:8000` بحسابه على Staging.
- [ ] وضع العرض (config فارغ) والإنجليزية لم تُجرَّب يدويًا. اختبارات jsdom تغطي النصوص الإنجليزية الجديدة.

## الاختبارات / Tests (PGlite، على جهاز المالك)

```text
tx-stage-sets-tests.js (new) ... OK — 26 passed, 0 failed
rls-tests.js ................... OK — 2812 passed, 0 failed, 0 warnings
g2-tests.js .................... OK — 222 passed, 0 failed
restore-drill.js ............... RESTORE DRILL PASS — 28 passed, 0 failed
legacy-tx-sql-tests.js ......... OK — 158 passed, 0 failed
g3-cycle 70/0 · g7-e2e 98/0 · convert 124/0 · g7-isolation 311/0 · g7-second-org 128/0 · legacy-core 372/0 · doc-match 170/0
every *-ui / dom test .......... 0 failed (shell-sidebar 92, legacy-reports 189, legacy-tx-ui 98, …)
```

`antispam-tests`: أُضيف `20261204000100_tx_stage_sets.sql` إلى قائمة الترحيلات اللاحقة المسموحة (الفحص كان يفشل بسبب الترحيل الجديد فقط)، وفحص الملفات فيه ينجح الآن. تشغيله الكامل لم يكتمل على جهاز المالك لامتلاء ذاكرة الجهاز (V8 "out of memory: Zone" عند تشغيل PGlite)، فيُعاد تشغيله لاحقًا.

ما زال يفشل لأن أدواته غير موجودة على جهاز المالك (لا علاقة له بهذا الفرع):
- `prod-env-tests` و`legacy-daftra-worker-tests`: تحتاجان `python3`.
- `release-build-tests`: يحتاج `zip` و`shasum`.

## ملاحظات للمراجع / قرارات مفتوحة

- حُدّثت فحوص كانت تنص على أن `operationally_complete` و`under_billing` يدويتان، لأن قرار المالك أن تنتقل المعاملة وحدها إلى المحاسب بعد آخر إرجاع موثّق. الفحوص في: `legacy-tx-sql`، و`g3-cycle`، و`g7-e2e`، و`lib/g7-cycle.js`، و`legacy-tx-ui`.
- قيد CHECK على `operational_status` بقي هو المحرّك، والإعداد هو ما يراه الموظف. هل نستبدله بجدول عند إضافة العبور؟
- `platform_create_org` لا يزرع مجموعة المراحل؛ المؤسسة الجديدة ترى الافتراضي من fallback.
- عمود الحالة في السجل يجمّع في الواجهة؛ ربطه بمجموعة كل معاملة يحتاج إضافة إلى `report_transactions`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
