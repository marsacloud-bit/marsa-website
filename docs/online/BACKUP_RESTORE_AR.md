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
