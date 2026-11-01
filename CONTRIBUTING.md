# المساهمة في مرسى | Contributing to MARSA

> المشروع حاليًا **نموذج أولي على بيئة Staging ببيانات اختبار فقط**. لا توجد بيئة إنتاج بعد، ولا يُدمج أي شيء يفترض وجودها دون قرار المالك.
> تفاصيل البيئات في [`docs/online/ENVIRONMENTS_AR.md`](docs/online/ENVIRONMENTS_AR.md)، والنسخ الاحتياطي في [`docs/online/BACKUP_RESTORE_AR.md`](docs/online/BACKUP_RESTORE_AR.md)، والمعمارية في [`docs/online/ARCHITECTURE.md`](docs/online/ARCHITECTURE.md).

## 1) الفروع وطريقة العمل

| الفرع | الغرض |
|---|---|
| `main` | آخر نسخة عرض محلية مستقرة (Demo). لا يُدفع إليه مباشرة. |
| `online-staging` | الفرع الأساسي للنسخة المتصلة (Staging). منه يُبنى ملف الإصدار الذي يُرفع إلى Hostinger. |
| `feature/<وصف-قصير>` أو `fix/<وصف-قصير>` | فرع لكل مهمة، يتفرع من `online-staging` ويعود إليه بطلب دمج (PR). |

```bash
git switch online-staging
git pull --ff-only
git switch -c feature/g2-invitations
# ... edit, test ...
git add -p
git commit -m "G2.5: invitations table and admin_invite RPC"
git push -u origin feature/g2-invitations
# then open a Pull Request into online-staging (the template fills itself)
```

قواعد:
- لا يوجد مستودع بعيد (remote) مُعدّ حاليًا. إلى أن يقرر المالك مكان الاستضافة (GitHub مثلًا)، يُراجَع الفرع محليًا بنفس القالب ثم يُدمج في `online-staging` بـ `git merge --no-ff`.
- طلب دمج واحد لكل موضوع، ورسالة الالتزام تبدأ برقم خطوة الخطة إن وُجد (`G2.4: …`).
- املأ قالب طلب الدمج (`.github/pull_request_template.md`) كاملًا، والصق نتيجة الاختبارات الفعلية.
- لا يُدمج طلب فيه اختبار فاشل. فشل فحص الفهرس (catalog) يعني أن جدولًا أو دالة جديدة لم تُضف إلى `rls-tests.js` بعد: أضفها قبل الدمج.

## 2) الأسرار — القاعدة الأهم

- **لا يدخل المستودع أي سر:** مفتاح `service_role` / `sb_secret_…`، كلمة مرور قاعدة البيانات، رابط الاتصال `SUPABASE_DB_URL`، كلمة مرور الحماية (Basic Auth) لموقع Hostinger، أو أي ملف `.env`.
- `assets/js/config.js` يحتوي **المفتاح العام فقط** (anon / publishable) وعنوان المشروع. القالب الموثّق: [`assets/js/config.example.js`](assets/js/config.example.js). `supa.js` يرفض العمل إن وجد مفتاحًا سريًا.
- الأسرار تُحفظ في مدير كلمات المرور، وتُمرَّر للسكربتات عبر متغيرات البيئة في الطرفية فقط:
  ```bash
  read -rs SUPABASE_DB_URL && export SUPABASE_DB_URL   # paste, Enter (not shown, not saved in history)
  ```
- `.gitignore` يمنع `.env*` و`*.local.*` والنسخ الاحتياطية (`*.dump`، `backups/`) وملفات الإصدار (`marsa-release-*.zip`). قبل كل التزام:
  ```bash
  git status --short
  git diff --cached | grep -nE "sb_secret_|service_role|postgres(ql)?://|SUPABASE_DB_URL=" && echo "STOP: secret in diff"
  ```
- إن تسرّب سر: غيّره فورًا من لوحة Supabase (Reset database password / Rotate key)، ثم أبلغ المالك. حذف الملف من المستودع لا يكفي.

## 3) قواعد ترحيلات قاعدة البيانات

- كل تغيير في المخطط **ملف جديد** في `supabase/migrations/` باسم `YYYYMMDDHHMMSS_<name>.sql` (مثل `20261102000200_orgs_branches_invites.sql`). **لا تعدّل ملفًا طُبِّق على Staging**؛ أضف ترحيلًا جديدًا يصحّحه.
- الترحيل إضافي وقابل لإعادة التشغيل: `CREATE … IF NOT EXISTS`، `CREATE OR REPLACE`، `DROP … IF EXISTS`، `ON CONFLICT DO NOTHING`.
- في رأس الملف تعليق بأسلوب الملفات الحالية (المرحلة، الغرض، الملاحظات)، وفي آخره إدراج صفّه في `public.schema_versions`.
- كل جدول في `public`: ‏RLS مفعّل، `REVOKE ALL … FROM anon`، مشغّل التدقيق `app.tg_audit` إن كان يحمل حالة عمل، وإضافته إلى `TENANT_TABLES` في `supabase/tests/rls-tests.js`.
- كل دالة `public.*`: ‏`SECURITY DEFINER SET search_path = ''`، أول سطر يتحقق من `auth.uid()` (إلا ما هو مخصص للزائر عمدًا)، الأخطاء عبر `app.fail('MRS_<CODE>', '<field>')` فقط، ثم `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` و`GRANT EXECUTE … TO authenticated` صراحةً. أضفها إلى قوائم الدوال المتوقعة في `rls-tests.js`.
- تغيير توقيع دالة موجودة: `DROP FUNCTION IF EXISTS public.f(<old args>)` أولًا ثم إعادة الإنشاء والمنح.
- لا يُؤخذ الدور من بيانات التسجيل (signup metadata)، ولا تكشف أي دالة إن كان لبريد ما حساب.
- `supabase/all_migrations.sql` حزمة مولّدة للصق في SQL Editor؛ أعد توليدها بعد إضافة ترحيل (لا تعدّلها يدويًا).
- **قبل تطبيق أي ترحيل على Staging:** خذ نسخة احتياطية (`scripts/backup-staging.sh`، انظر `BACKUP_RESTORE_AR.md`).

## 4) الواجهة (HTML / CSS / JS)

- موقع ثابت بلا خطوة بناء. ترتيب السكربتات في كل صفحة:
  `config.js → i18n.js → main.js → supa.js → [assets/i18n/<page>.js] → <page>.js`، كلها `defer`.
- كل استدعاء في `MarsaApi` يعيد `{data, error}` ولا يرمي استثناء.
- العربية هي اللغة الافتراضية (RTL)، والتعليقات في الكود بالإنجليزية بكثافة الملفات الحالية.
- افحص كل ملف JS عدّلته:
  ```bash
  node --check assets/js/<file>.js
  ```
- جرّب الصفحة محليًا في وضع العرض (config فارغ) ووضع Staging:
  ```bash
  cd ~/Downloads/marsa-website
  python3 -m http.server 8000 --bind 127.0.0.1
  # open http://127.0.0.1:8000
  ```

## 5) الاختبارات المطلوبة قبل طلب الدمج

الاختبارات تعمل محليًا على PGlite (Postgres 16 في الذاكرة) ولا تتصل بـ Supabase أبدًا. التثبيت مرة واحدة خارج المستودع:

```bash
mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm i @electric-sql/pglite
```

ثم:

```bash
cd /tmp/pgtest
NODE_PATH=/tmp/pgtest/node_modules node ~/Downloads/marsa-website/supabase/tests/rls-tests.js --quiet     # RLS + RPC + catalog
NODE_PATH=/tmp/pgtest/node_modules node ~/Downloads/marsa-website/supabase/tests/g2-tests.js --quiet      # two-org proof (G2.15)
NODE_PATH=/tmp/pgtest/node_modules node ~/Downloads/marsa-website/supabase/tests/restore-drill.js --quiet # backup/restore drill
#   --strict  treat WARN as failure
```

| الاختبار | متى يجب تشغيله |
|---|---|
| `rls-tests.js` | كل طلب دمج يمس `supabase/` |
| `g2-tests.js` | كل تغيير في المؤسسات أو الفروع أو الدعوات أو الأدوار أو الدوال العامة |
| `restore-drill.js` | كل ترحيل يضيف جدولًا أو يغيّر بنية جدول |
| `node --check` | كل ملف JS معدَّل |

الصق ملخص النتيجة (`OK — N passed, 0 failed, W warnings`) في طلب الدمج.

## 6) النشر

النشر يدوي إلى Hostinger من فرع `online-staging` بعد الدمج، مع الاحتفاظ بملف الإصدار السابق للتراجع. الخطوات في [`docs/online/ENVIRONMENTS_AR.md`](docs/online/ENVIRONMENTS_AR.md) (القسم 4).
