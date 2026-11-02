# النسخ الاحتياطي والاسترجاع — مرسى (Staging)

> **النطاق:** بيئة Staging ببيانات اختبار فقط. نفس الإجراء سيصبح شرطًا مسبقًا لبيئة الإنتاج (انظر [`ENVIRONMENTS_AR.md`](ENVIRONMENTS_AR.md)).
> **تنبيه:** الخيارات الدقيقة لكل سكربت هي ما يطبعه `--help` للسكربت نفسه؛ هذا المستند يصف السلوك المتفق عليه في `G2_SPEC.md`. عند أي اختلاف، `--help` هو المرجع.

## 1) لماذا نحتاج نسخة يدوية؟

- على **الخطة المجانية** في Supabase لا تتوفر نسخ احتياطية يومية قابلة للتنزيل أو الاسترجاع الذاتي من لوحة التحكم (تظهر في Database → Backups على الخطط المدفوعة فقط). لا تعتمد عليها.
- لذلك القاعدة: **نسخة `pg_dump` يدوية قبل كل ترحيل، وقبل أي عملية بيانات جماعية، وأسبوعيًا على الأقل.**
- النسخة تُحفظ **خارج المستودع** (مثل `~/marsa-backups/`) بصلاحيات `600`، ولا تُرفع إلى git (`.gitignore` يمنع `*.dump` و`backups/` احتياطًا). حتى بيانات الاختبار تحتوي عناوين بريد وأسماء — عاملها كبيانات حساسة.
- للإنتاج مستقبلًا: خطة مدفوعة بنسخ يومية + Point-in-Time Recovery، **بالإضافة** إلى هذه النسخ اليدوية.

## 2) ما الذي يُنسخ؟

| المحتوى | مشمول | ملاحظة |
|---|---|---|
| schema `public` (الجداول، RLS، الدوال، البيانات) | نعم | كل بيانات المؤسسات والمعاملات والدعوات والتدقيق |
| schema `app` (الدوال المساعدة، العدادات، المفاتيح) | نعم | |
| بيانات تعريف التخزين `storage` (الحاويات/السياسات/سجلات الملفات) | نعم | **محتوى الملفات نفسها في Storage لا يُنسخ بـ pg_dump** — بيانات اختبار فقط حاليًا؛ للإنتاج يلزم نسخ الملفات بأداة منفصلة (قرار مفتوح) |
| `auth.users` | لا (افتراضيًا) | تُدار من Supabase؛ مستخدمو الاختبار يُعاد إنشاؤهم وفق `seed.sql` |

## 3) أخذ نسخة — `scripts/backup-staging.sh`

المتطلبات: ‏`pg_dump` بإصدار **مساوٍ أو أحدث** من إصدار Postgres في المشروع (Project Settings → Infrastructure). على macOS:
```bash
brew install libpq && brew link --force libpq     # provides pg_dump / pg_restore / psql
pg_dump --version
```

رابط الاتصال من Supabase: زر **Connect** في أعلى لوحة المشروع → **Session pooler** (يعمل على IPv4) أو Direct connection. يحتوي كلمة مرور قاعدة البيانات، فهو **سر**:

```bash
cd ~/Downloads/marsa-website
./scripts/backup-staging.sh --help                 # exact flags and output location
read -rs SUPABASE_DB_URL && export SUPABASE_DB_URL # paste the URL, Enter (hidden, not in history)
./scripts/backup-staging.sh                        # writes a timestamped dump outside the repo
unset SUPABASE_DB_URL
```

سلوك السكربت المتفق عليه:
- يقرأ الرابط من متغير البيئة `$SUPABASE_DB_URL` فقط، ولا يكتبه في أي ملف ولا يطبعه.
- **يرفض العمل** إن لم يكن الرابط لمشروع Staging (‏`cgzhidyxfpksfckwmauq`)، إلا بخيار صريح `--force-other`. لا تستخدم هذا الخيار إلا بقرار مكتوب.
- يأخذ `pg_dump` لـ `public` و`app` وبيانات تعريف `storage`.
- النسخة تُكتب خارج المستودع باسم يتضمن التاريخ والوقت.

بعد النسخ:
```bash
ls -l ~/marsa-backups/            # adjust to the location printed by the script
chmod 600 ~/marsa-backups/*
```
سجّل في ملاحظات الإصدار: اسم ملف النسخة، تاريخها، وآخر نسخة مخطط (`select max(version) from public.schema_versions;`).

## 4) استرجاع للفحص — `scripts/restore-to-scratch.sh`

الاسترجاع يتم إلى قاعدة **محلية مؤقتة (scratch)** فقط، للتحقق من أن النسخة سليمة وقابلة للاستخدام، **وليس إلى Supabase**.

```bash
./scripts/restore-to-scratch.sh --help            # exact flags (dump path, target DB)
# example: a throwaway local Postgres (Postgres.app, Homebrew postgresql, or Docker)
docker run --rm -d --name marsa-scratch -e POSTGRES_PASSWORD=scratch -p 54329:5432 postgres:15
./scripts/restore-to-scratch.sh <path-to-dump>     # target: local scratch DB only
docker stop marsa-scratch                          # deletes the scratch DB
```

سلوك السكربت المتفق عليه:
- يرفض أي هدف غير محلي (`localhost` / `127.0.0.1` / socket محلي). لا يستطيع الكتابة على Staging أو أي مشروع Supabase.
- قد يحتاج مخطط `auth`/`storage` بديلًا محليًا (مثل `supabase/tests/shim.sql`) لأن الدوال والسياسات تشير إلى `auth.uid()` و`storage.objects`.
- بعد الاسترجاع افحص يدويًا: عدد الصفوف في الجداول الرئيسية، `select max(version) from public.schema_versions;`، وأن RLS مفعّل (`select relname from pg_class where relrowsecurity`).

### استرجاع فعلي إلى Staging (حالة طارئة فقط)
غير مؤتمت عمدًا. يتطلب قرار المالك، ونسخة جديدة من الوضع الحالي قبل الاسترجاع، ويُنفذ يدويًا بـ `pg_restore`/`psql` على مشروع Staging. البديل المفضل دائمًا: **ترحيل تصحيحي جديد** بدل الاسترجاع.

> **التحقق بخطوتين (MFA):** عوامل TOTP تُحفظ في `auth.mfa_factors` (خارج نطاق `pg_dump` الافتراضي). إن فقد مدير جهازه بعد استرجاع أو في أي وقت، فإعادة التعيين تتم بمقطع SQL للمالك لمستخدم واحد فقط: [`MFA_AR.md`](MFA_AR.md) §5. وبعد إعادة لصق أي ملف ترحيل أقدم أعد لصق `20261109000100_mfa.sql`.

## 5) تمرين الاسترجاع الآلي — `supabase/tests/restore-drill.js`

تمرين محلي بالكامل على PGlite (لا اتصال بالشبكة)، يثبت أن مخططنا الكامل قابل للنسخ والاسترجاع دون فقد:

1. يبني المخطط (`shim.sql` + كل الترحيلات + `seed.sql`) وبيانات نموذجية لمؤسستين.
2. يأخذ نسخة فيزيائية (`db.dumpDataDir()`).
3. يسترجعها في PGlite جديدة.
4. يقارن لكل جدول في `public`: عدد الصفوف، وبصمة md5 للصفوف مرتبة.
5. يعيد تشغيل مجموعة مختصرة من فحوص RLS على القاعدة المسترجعة.
6. يطبع `PASS` أو `FAIL` (رمز خروج غير صفري عند الفشل).

```bash
mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm i @electric-sql/pglite   # once
cd /tmp/pgtest && NODE_PATH=/tmp/pgtest/node_modules node ~/Downloads/marsa-website/supabase/tests/restore-drill.js --quiet
```

يُشغَّل مع كل ترحيل يضيف جدولًا أو يغيّر بنيته، وقبل اعتماد أي إصدار.

## 6) الجدول المقترح

| متى | ماذا |
|---|---|
| قبل كل ترحيل على Staging | `backup-staging.sh` ثم الترحيل |
| أسبوعيًا | `backup-staging.sh` + `restore-to-scratch.sh` على أحدث نسخة |
| مع كل طلب دمج يغيّر المخطط | `restore-drill.js` |
| شهريًا | حذف النسخ الأقدم من 90 يومًا (بيانات اختبار)، مع إبقاء آخر نسخة قبل كل ترحيل |

## 7) قرارات مفتوحة للمالك
- مكان حفظ النسخ خارج الجهاز (قرص مشفّر / تخزين سحابي مشفّر) ومدة الاحتفاظ.
- نسخ محتوى ملفات Storage (ليس ضمن `pg_dump`).
- الترقية إلى خطة مدفوعة (نسخ يومية / PITR) قبل الإنتاج.

## 8) G7 — تمرين الاستعادة الشامل (قاعدة البيانات + ملفات التخزين) والاستعادة الفعلية للمالك

### 8.1 ما يثبته التمرين الآلي الآن — `supabase/tests/g7-restore-tests.js` (PGlite، بلا شبكة)

يبني بيانات G2–G7 لمؤسستين عبر الدوال الحقيقية، ويكتب **بايتات تجريبية حتمية** لكل كائن تخزين في الحاويات `documents` و `finance` و `messages` داخل مجلد مؤقت (`os.tmpdir()/marsa-g7-restore-*` يُحذف في النهاية)، بحيث يطابق `sha256` و `size_bytes` في القاعدة تلك البايتات. ثم:

1. **نسخة:** `dumpDataDir()` + نسخة من مجلد الكائنات + `manifest.json` (`[{bucket, path, size, sha256}]` مرتّبًا، مع `entries_sha256`).
2. **استعادة:** إلى PGlite جديد ومجلد جديد.
3. **تحقق:** عدد + md5 لكل جدول (public / app / auth / storage) والتسلسلات والكتالوج؛ كل عنصر في البيان موجود بالحجم والبصمة نفسيهما؛ تطابق 1:1 بين صفوف `documents` / `finance_documents` / `msg_attachments` (المخزّنة) وصفوف `storage.objects` والملفات (لا ملف يتيم، ولا صف بلا ملف، باستثناء المرفقات `not_fetched`) — **هذا الثابت 1:1 صحيح لبيانات التمرين الاصطناعية فقط**: في البيانات الحقيقية قد يوجد صف `documents` / `finance_documents` بلا ملف لأن الواجهة تسجّل الصف أولًا ثم ترفع البايتات (فشل رفع في المتصفح = `MRS_UPLOAD`، «حُفظت البيانات ولم تُحفظ البايتات»)؛ انظر §8.2 الخطوة 4؛ كل قيد FK بسيط أو مركّب سليم (استعلام نفي لكل قيد في `pg_constraint`)؛ عدادات الاستخدام = ناتج `app.g7_recount`؛ عيّنة RLS؛ إنشاء مسموح وإنشاء مرفوض بحد الباقة (`MRS_PLAN_LIMIT`).
4. **اختبار ذاتي:** ثلاثة أنماط تلاعب على استعادات جديدة — قلب بايت في ملف، حذف ملف، تعديل صف — يجب أن يكتشفها التمرين كلها؛ والخيارات `--tamper-object` / `--drop-object` / `--tamper-row` تطبّق التلاعب على الاستعادة الرئيسية فيفشل التشغيل.

```bash
cd /tmp/pgtest && NODE_PATH=/tmp/pgtest/node_modules node ~/Downloads/marsa-website/supabase/tests/g7-restore-tests.js --quiet
```

### 8.2 الاستعادة الفعلية على Supabase — **قيد انتظار المالك (OWNER-PENDING)**

لا يُنفَّذ أي من الخطوات التالية آليًا، ولا يُعلَن نجاحها إلا بتوقيع المالك كتابيًا (كتلة التوقيع في `G7_ACCEPTANCE_AR.md`).

1. **تحقق من المتاح في خطتك:** من لوحة Supabase → Database → Backups: هل النسخ اليومية و/أو PITR متاحة؟ (يعتمد على الخطة؛ الخطة المجانية لا تشمل PITR). سجّل الخطة وتاريخ آخر نسخة.
2. **استعد إلى مشروع منفصل** (مشروع Supabase جديد للفحص، أو Postgres محلي عبر `restore-to-scratch.sh`) — **ولا تستعد أبدًا فوق Staging** ولا فوق أي مشروع إنتاج.
3. **نزّل كائنات التخزين** للحاويات الثلاث (`documents`، `finance`، `messages`) من المشروع المصدر إلى مجلد محلي بالبنية `<dir>/<bucket>/<path>` (عبر لوحة Storage أو أداة Supabase CLI بحسابك؛ لا تضع مفاتيح في أي ملف داخل المستودع).
4. **أنشئ البيان من المشروع المصدر** (الذي أُخذت منه النسخة) بتشغيل الاستعلام التالي في محرر SQL، واحفظ الناتج (عمود `manifest`) في ملف `manifest.json`. البيان يضم **فقط الصفوف التي لها كائن تخزين في المصدر** (ربط بـ `storage.objects` على `bucket_id` / `name`)، لأن الصف الذي فشل رفع ملفه في المتصفح لا ملف له أصلًا وليس عيب استعادة:

```sql
SELECT coalesce(jsonb_agg(x ORDER BY x->>'bucket', x->>'path'), '[]'::jsonb) AS manifest FROM (
  SELECT jsonb_build_object('bucket', 'documents', 'path', d.storage_path, 'size', d.size_bytes, 'sha256', d.sha256) x
    FROM public.documents d JOIN storage.objects o ON o.bucket_id = 'documents' AND o.name = d.storage_path
  UNION ALL
  SELECT jsonb_build_object('bucket', 'finance', 'path', f.storage_path, 'size', f.size_bytes, 'sha256', f.sha256)
    FROM public.finance_documents f JOIN storage.objects o ON o.bucket_id = 'finance' AND o.name = f.storage_path
  UNION ALL
  SELECT jsonb_build_object('bucket', a.storage_bucket, 'path', a.storage_path, 'size', a.size_bytes, 'sha256', a.sha256)
    FROM public.msg_attachments a JOIN storage.objects o ON o.bucket_id = a.storage_bucket AND o.name = a.storage_path
   WHERE a.storage_status = 'stored'
) s;
```

   ثم شغّل استعلام **الصفوف بلا ملف** على المصدر **وعلى المشروع المستعاد** كليهما، وقارن الناتجين (الأعداد والمسارات):

```sql
SELECT 'documents' AS bucket, d.storage_path FROM public.documents d
  LEFT JOIN storage.objects o ON o.bucket_id = 'documents' AND o.name = d.storage_path WHERE o.id IS NULL
UNION ALL
SELECT 'finance', f.storage_path FROM public.finance_documents f
  LEFT JOIN storage.objects o ON o.bucket_id = 'finance' AND o.name = f.storage_path WHERE o.id IS NULL
ORDER BY 1, 2;
```

   صف بلا ملف **موجود مسبقًا في المصدر** = حالة سابقة معروفة (رفع فاشل `MRS_UPLOAD`)، ليست عيب استعادة؛ تُنظَّف أو يُعاد رفع ملفها بشكل منفصل. العيب S1 هو فقط: صف كان له ملف في المصدر وفقد ملفه في الاستعادة (يظهر في بيان المصدر ويفشل في الفاحص)، أو صف بلا ملف في الاستعادة وحدها.

5. **شغّل الفاحص دون اتصال** (لا قاعدة ولا شبكة):

```bash
node ~/Downloads/marsa-website/supabase/tests/g7-restore-tests.js --verify-manifest manifest.json --objects <dir>
# --allow-extra  يتجاهل الملفات الزائدة غير المذكورة في البيان (مثل ملفات طلبات لم تُربط بعد)
```

   الناتج `MANIFEST CHECK PASS` يعني أن كل ملف كان موجودًا في المصدر موجود بعد الاستعادة بالحجم والبصمة المسجلين؛ أي `FAIL` (ملف مفقود / حجم / بصمة / مسار غير آمن) لعنصر في **بيان المصدر** يُسجَّل عيبًا بدرجة S1 أو S2 حسب `G7_ACCEPTANCE_AR.md`. الصفوف بلا ملف في المصدر (الخطوة 4) لا تُحسب عيبًا ما دامت قائمتها في المستعاد مطابقة لقائمة المصدر.
6. **قارن الأعداد:** عدد الصفوف لأهم الجداول بين المصدر والمستعاد (`SELECT count(*)` لكل من `transactions`، `documents`، `finance_documents`، `msg_messages`، `audit_log`) ونتيجة `SELECT public.health_check();`.
7. **سجّل النتيجة** في جدول نتائج الاختبار في `G7_ACCEPTANCE_AR.md`: التاريخ، الخطة، مصدر النسخة (يومية / PITR / يدوية)، مدة الاستعادة، ناتج الفاحص، الأعداد، اسم من نفّذ. ثم احذف المشروع المؤقت أو بياناته وفق سياسة الاحتفاظ.

| البند | الحالة |
|---|---|
| تمرين PGlite (قاعدة + ملفات + بيان + تلاعب) | آلي — `g7-restore-tests.js` |
| استعادة نسخة Supabase / PITR فعلية إلى مشروع معزول | **قيد انتظار المالك (OWNER-PENDING)** |
| تنزيل كائنات التخزين الفعلية والتحقق بالفاحص دون اتصال | **قيد انتظار المالك (OWNER-PENDING)** |
| قرار الخطة المدفوعة (نسخ يومية / PITR) قبل الإنتاج | **قيد انتظار المالك (OWNER-PENDING)** |
