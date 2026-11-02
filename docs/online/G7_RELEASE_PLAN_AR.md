# خطة الإطلاق والمراقبة والتراجع — مرسى، G7 الخطوة ١٥

> **الحالة: خطة فقط.** قرار الانتقال من التجربة إلى البيع، وإنشاء مشروع الإنتاج، والنشر، والمناوبة كلها `قيد انتظار المالك (OWNER-PENDING)`. بوابة الخروج من الخطة: «قبول أمني وتشغيلي وتجاري موثق».
> هذه الخطة تصف أيضًا **نشر G7 على Staging** (الترحيل + الواجهة + الأدلة)، وهو ما يحتاجه المالك أولًا.
> مراجع: [`ENVIRONMENTS_AR.md`](ENVIRONMENTS_AR.md) §4، [`BACKUP_RESTORE_AR.md`](BACKUP_RESTORE_AR.md)، [`G7_ACCEPTANCE_AR.md`](G7_ACCEPTANCE_AR.md)، [`G7_READINESS_REVIEW_AR.md`](G7_READINESS_REVIEW_AR.md)، تقارير G5 / G6b §3.

## 1) معايير القرار (Go / No-Go)

**Go** فقط إذا تحققت كلها، وكلها اليوم OWNER-PENDING:

| # | المعيار | الدليل |
|---|---|---|
| G1 | كل المجموعات الآلية خضراء (0 failed) على النسخة المراد نشرها | `G7_ACCEPTANCE_AR.md` §3 (من تشغيل فعلي) |
| G2 | 0 عيوب S1 و0 S2 مفتوحة؛ كل S3 بحل مؤقت مقبول كتابيًا | `G7_ACCEPTANCE_AR.md` §5 |
| G3 | التجربة المحدودة انتهت بمعايير الخروج | `G7_PILOT_PLAN_AR.md` §8 |
| G4 | استعادة فعلية ناجحة (قاعدة + ملفات) في مشروع معزول | `BACKUP_RESTORE_AR.md` §8 |
| G5 | مراجعة الجاهزية: لا بند GAP يُباع على أنه متاح؛ الخصوصية والعقود معتمدة | `G7_READINESS_REVIEW_AR.md` |
| G6 | كتلة الاعتماد موقّعة | `G7_ACCEPTANCE_AR.md` §6 |
| G7 | مشروع إنتاج مستقل مستوفٍ لشروط `ENVIRONMENTS_AR.md` §2.4 | — |

**No-Go** عند أي: عيب S1 مفتوح، فشل أي اختبار عزل، تعذّر الاستعادة الفعلية، أو غياب التوقيع.

## 2) التحضير قبل أي تطبيق (Pre-flight)

1. **نسخة احتياطية** من القاعدة وفق `BACKUP_RESTORE_AR.md` §3 (`scripts/backup-staging.sh`)، وتسجيل اسم الملف.
2. `SELECT public.health_check();` وتسجيل `schema_version` الحالي.
3. التأكد أن نسخة الواجهة السابقة محفوظة (`~/Downloads/marsa-releases/` أو `~/Downloads/marsa-hostinger.zip`).
4. نافذة تطبيق هادئة (الملف يبدأ بـ `lock_timeout = 5s`؛ أي قفل يلغي اللصق كله دون أثر).

## 3) ترتيب تطبيق الترحيلات على Staging الحي

ملفات اللصق (رأس + حارس ترميز + ترحيل واحد) في مجلد العمل المؤقت، وآخرها `g7_apply.sql` (مولَّد من `supabase/migrations/20261108000100_g7_subscriptions.sql`؛ تحقق منه التكامل على PGlite مرتين متتاليتين بنتيجة متطابقة). المسار: `/private/tmp/claude-501/-Users-apple/3164bcee-2188-447c-b713-54d9e847dd13/scratchpad/g7_apply.sql`، وترتيب اللصق وأحجام الملفات في `ALL_PENDING_apply_ORDER.txt` في المجلد نفسه.

| الترتيب | الملف | يُلصق فقط إذا أعاد `health_check()` | بعده |
|---|---|---|---|
| 1 | `g3_apply.sql` | `20261102000300` (G2) | `20261103000200` |
| 2 | `g4_apply.sql` | `20261103000200` | `20261104000100` |
| 3 | `g5_apply.sql` | `20261104000100` | `20261105000100` |
| 4 | `g6a_apply.sql` | `20261105000100` | `20261106000100` |
| 5 | `g6b_apply.sql` | `20261106000100` | `20261107000100` |
| 6 | **`g7_apply.sql`** | `20261107000100` | `20261108000100` |

قواعد إعادة اللصق (من تقارير G5 وG6b):
- كل ملف آمن لإعادة اللصق **وحده** (مختبر مرتين على الأقل دون تغير أي عدد).
- **بعد G5 لا تُعِد لصق `g3_apply.sql` أو `g4_apply.sql` وحدهما؛ وبعد G6b لا تُعِد لصق `g3`/`g4`/`g5` وحدها** (تضيّق قيد نوع الأحداث). إن حدث فالصق `g6b_apply.sql` فورًا بعدها، ثم `g7_apply.sql`.
- **لا تلصق `supabase/all_migrations.sql` على Staging أبدًا** (لقاعدة فارغة فقط).
- إن لم يكن G6b مطبقًا يتوقف `g7_apply.sql` برسالة `G7 preflight: apply G6b first (schema_versions lacks 20261107000100 g6b_inbox)` ولا يُنشئ شيئًا.
- G7 «خامل افتراضيًا»: كل مؤسسة قائمة تأخذ باقة `pilot` (بلا حدود) بحالة `active`، فلا يتغير سلوك أي مؤسسة بعد اللصق.

تحقق بعد G7:
```sql
SELECT public.health_check();                                   -- schema_version = 20261108000100
SELECT plan_code, status, count(*) FROM public.org_subscriptions GROUP BY 1, 2;   -- every org: pilot / active
SELECT code, is_active FROM public.plans ORDER BY sort;         -- pilot, basic, pro, enterprise
```

## 4) نشر الواجهة

وفق `ENVIRONMENTS_AR.md` §4 (التصدير بـ `git archive` ثم `rsync` إلى نسخة النشر ثم zip ثم الرفع إلى Hostinger). **تغيير G7 (G7-19):** أمر `rsync` يُبقي `docs/guide/` (مصدر صفحة `help.html`) ويستثني بقية `docs/` — انظر §4.1 المحدّث.

0. **(قيد انتظار المالك — OWNER-PENDING) مراجعة تغييرات G7 واعتمادها في git قبل أي تصدير.** لم يُعتمد (commit) شيء من G7 بعد: الملفات المعدّلة وغير المتتبَّعة (`help.html`، `assets/js/help.js`، `assets/i18n/help.js`، `assets/css/pages/help.css`، `docs/guide/`، `supabase/migrations/20261108000100_g7_subscriptions.sql`، الاختبارات `supabase/tests/g7-*` و`lib/` و`fixtures/`، والمستندات) يراجعها المالك عبر `git status` على فرع `online-staging` ثم يعتمدها بنفسه. السبب: فحص `ENVIRONMENTS_AR.md` §4.1 يشترط شجرة نظيفة (`git status --short` فارغ)، و`git archive HEAD` لا يصدّر إلا الملفات المعتمدة؛ أي ملف غير متتبَّع (صفحة المساعدة والأدلة مثلًا) يغيب عن الحزمة فيفشل فحصا §5 رقم 5 و6.
1. **الترحيل أولًا ثم الواجهة** (الواجهة الجديدة تستدعي دوال G7 في لوحة المنصة).
2. ملفات G7: `platform.html`، `assets/js/platform.js`، `assets/i18n/platform.js`، `assets/css/pages/platform.css`، `assets/js/supa.js`، `help.html`، `assets/js/help.js`، `assets/i18n/help.js`، `assets/css/pages/help.css`، `assets/js/app-shell.js`، `assets/js/admin.js` (رابط «المساعدة» في لوحة الإدارة: `NAV_EXTERNAL`)، `sw.js`، والمجلد `docs/guide/` (`ar/` و`en/`).
3. `sw.js` برقم إصدار جديد يخزّن `help.html` وملفاته مسبقًا؛ الأدلة نفسها «الشبكة أولًا» (لا تُخزَّن مسبقًا).
4. **لا تُرفع** `supabase/functions/` ولا `docs/online/` ولا `docs/import-templates/` إلى Hostinger.
5. تأكد بعد الرفع: `.htaccess` موجود والموقع يطلب كلمة المرور؛ `config.js` يحتوي المفتاح العام فقط (`grep "sb_secret_\|service_role"` لا يعيد شيئًا).

## 5) قائمة فحص سريعة بعد النشر (Smoke)

| # | الفحص | المتوقع |
|---|---|---|
| 1 | `login.html` في نافذة خاصة | يطلب كلمة مرور الموقع ثم يعرض شريط «بيئة تجريبية (Staging)» |
| 2 | «لوحة المنصة» ← «صحة الخادم» ← «فحص الآن» | «يعمل»، إصدار المخطط `20261108000100` |
| 3 | «لوحة المنصة» ← «الباقات» | أربع باقات؛ `pilot` بلا حدود؛ الأسعار «لم يُسعَّر» |
| 4 | «لوحة المنصة» ← «الاشتراكات والاستخدام» | كل مؤسسة `pilot` / نشط؛ بلاطة «تجاوز حدود الباقة» = 0 |
| 5 | `help.html` بالعربية ثم الإنجليزية | يعرض «دليل الاستخدام» والأدلة الستة؛ `help.html#platform` يفتح دليل المنصة |
| 6 | «لوحة الموظفين» بحساب موظف | القائمة تعرض «المساعدة»؛ معاملة تُفتح وتنتقل مرحلة كما قبل |
| 7 | «بوابة العميل» بحساب عميل | «معاملاتي» تعمل كما قبل |
| 8 | `request.html` ثم «الطلبات الواردة» | الطلب يصل؛ التحويل إلى معاملة ينجح (الباقة `pilot` لا تمنع شيئًا) |

## 6) المراقبة

| ماذا | أين | متى | الحالة |
|---|---|---|---|
| صحة الخادم وإصدار المخطط | `health_check()` من «لوحة المنصة» | يوميًا وبعد كل نشر | DOC |
| أخطاء الواجهة في كل المؤسسات | «أخطاء الواجهة الأخيرة» (`platform_recent_errors`) | يوميًا | DOC |
| أخطاء الواجهة لمؤسسة | «أخطاء الواجهة» (`admin_recent_errors`) لمدير المؤسسة | أسبوعيًا | DOC |
| تجاوز حدود الباقات | بلاطة «تجاوز حدود الباقة» و«الاشتراكات والاستخدام» | أسبوعيًا | DOC |
| مهام دفترة والمراسلات العالقة | «طابور المزامنة والمراجعة»، «القنوات ← مهام المزامنة» | يوميًا بعد نشر العمال | OWNER-PENDING (العمال غير منشورين) |
| مقاييس Supabase (CPU، الاتصالات، حجم القاعدة والتخزين، الأخطاء) | لوحة Supabase | يوميًا | OWNER-PENDING |
| التنظيف الدوري (`pg_cron`) | `cron.job_run_details` | أسبوعيًا | OWNER-PENDING |
| مناوبة الحوادث S1 | — | طوال الأسبوعين الأولين بعد الإطلاق | OWNER-PENDING |

## 7) التراجع (Rollback)

### 7.1 الواجهة
- ارفع zip الإصدار السابق من `~/Downloads/marsa-releases/` (أو `~/Downloads/marsa-hostinger.zip`) واستخرجه في `public_html` (`ENVIRONMENTS_AR.md` §4.3)، ثم أعد فحص §5.
- الواجهة السابقة تعمل عادةً على المخطط الأحدث لأن الترحيلات إضافية؛ لوحة المنصة القديمة لا تعرض الباقات، **ومعها قيد مهم:**
  - **لا تستطيع لوحة المنصة القديمة إعادة تفعيل مؤسسة عُلِّقت عبر `platform_suspend_org`** (حالة الاشتراك `suspended` أو `cancelled`): زر «إعادة التفعيل» القديم يستدعي `platform_set_org_active(true)` فيرفضه المشغل `trg_g7_org_reactivate` بـ `MRS_BAD_TRANSITION 'subscription_suspended'`، و`supa.js` القديم لا يعرض إلا الرسالة العامة «لا يمكن تغيير الحالة بهذا الشكل».
  - البدائل بالترتيب: (أ) عند التراجع أبقِ نسخ G7 من `assets/js/platform.js` و`assets/i18n/platform.js` و`assets/css/pages/platform.css` و`assets/js/supa.js` وأعد بقية الملفات، ثم أعد التفعيل من «الاشتراكات والاستخدام»؛ (ب) استدعِ `platform_activate_org(org, reason)` بجلسة مشرف منصة مسجَّل الدخول عبر الواجهة البرمجية (رمز JWT الخاص به) — **لا من جلسة SQL Editor عادية**: فيها `auth.uid()` فارغ فتفشل الدالة بـ `MRS_AUTH_REQUIRED` (إن لزم SQL Editor فاضبط مطالبات JWT للمشرف في المعاملة نفسها أولًا بـ `set_config('request.jwt.claims', …, true)`)؛ (ج) المسار العكسي في §7.2 (حذف مشغلات `trg_g7_*`)، وهو يعطّل تطبيق الحدود أيضًا.
  - **لا تعلّق مؤسسات ما دامت الواجهة القديمة منشورة**: زر الإيقاف القديم يوقف تشغيليًا فقط (`is_active=false`) ويترك الاشتراك `active`.

### 7.2 قاعدة البيانات (ملاحظات المسار العكسي)
- الترحيلات **إضافية بالتصميم**: G7 لا يضيف عمودًا لجدول قائم ولا يستبدل دالة أو سياسة سابقة.
- **تعطيل تطبيق حدود G7 دون لمس البيانات** = حذف مشغلات `trg_g7_*` فقط (الجداول الأربعة تبقى؛ المؤسسة بلا صف اشتراك تُعامل كـ `pilot`):
```sql
-- G7 down-path: disables plan enforcement and the re-activation guard; data untouched. Take a backup first.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT t.tgname, t.tgrelid::regclass AS tbl FROM pg_trigger t
           WHERE t.tgname LIKE 'trg\_g7\_%' AND NOT t.tgisinternal LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', r.tgname, r.tbl);
  END LOOP;
END $$;
```
- بعد ذلك تعمل `platform_set_org_active` كما في G2 (لا حارس إعادة تفعيل)، وتبقى دوال `platform_*` الجديدة قابلة للاستدعاء دون أثر على الإنشاء.
- **أثناء فترة التعطيل أعد تفعيل المؤسسات بـ `platform_activate_org` فقط** (تعمل دون المشغلات وتعيد حالة الاشتراك إلى `active`). أما `platform_set_org_active(true)` فيتجاوز حالة الاشتراك: تصبح المؤسسة مفعّلة والاشتراك ما زال `suspended`.
- **إعادة اللصق تعيد إنشاء المشغلات وتعيد احتساب الاستخدام، ولا تغيّر حالة أي اشتراك.** لإعادة التطبيق: الصق `g7_apply.sql` مرة أخرى، ثم شغّل مباشرةً:
```sql
-- after re-pasting g7_apply.sql: active orgs whose subscription is still suspended / cancelled would refuse every create
SELECT o.id, o.slug, s.status FROM public.organizations o JOIN public.org_subscriptions s ON s.org_id = o.id
 WHERE o.is_active AND s.status IN ('suspended','cancelled');
```
  ولكل صف: استدعِ `platform_activate_org` (أو علّق المؤسسة عمدًا من جديد)؛ وإلا رفض `app.g7_assert_active` كل إنشاء لهذه المؤسسة المفعّلة بـ `MRS_PLAN_INACTIVE 'suspended'`.
- **لا تحذف جداول بيانات على قاعدة حية دون نسخة احتياطية**، ولا تحذف جداول G7 إلا بقرار المالك.
- الاسترجاع من النسخة الاحتياطية (`BACKUP_RESTORE_AR.md` §4) هو **الملاذ الأخير** وبقرار المالك، لأنه يُسقط كل ما كُتب بعد النسخة.

## 8) خطة التواصل

| متى | لمن | ماذا | القناة | الحالة |
|---|---|---|---|---|
| قبل النشر بيوم | مستخدمو Staging / التجربة | موعد النشر ومدة الانقطاع المتوقعة (دقائق) | يحددها المالك | OWNER-PENDING |
| بعد النشر | المستخدمون | ما الجديد (صفحة «المساعدة»، الباقات للمنصة) | يحددها المالك | OWNER-PENDING |
| عند حادث S1 | المالك + المشرف + المؤسسات المتأثرة | الأثر، الإجراء (تعليق/تراجع)، الموعد التالي | هاتف + بريد | OWNER-PENDING |
| عند التراجع | المستخدمون | ما تغيّر وما يلزمهم (إعادة تحميل الصفحة) | يحددها المالك | OWNER-PENDING |

لا يرسل النظام أي إشعار بنفسه؛ التواصل يدوي.

## 9) إنشاء بيئة الإنتاج (OWNER-PENDING)

خطوات مسبقة بقرار مكتوب من المالك فقط (`ENVIRONMENTS_AR.md` §2.4):
1. مشروع Supabase جديد مستقل بخطة مدفوعة (نسخ يومية، ويُفضَّل PITR)، ومنطقة معتمدة قانونيًا.
2. تطبيق الترحيلات على قاعدة **فارغة** (هنا فقط يجوز `all_migrations.sql` المعاد توليده)، ثم الفحوص التي **تعمل فعلًا على قاعدة الإنتاج**:
   - `SELECT public.health_check();` في SQL Editor (الإصدار `20261108000100`).
   - استعلامات الكتالوج في SQL Editor: `relrowsecurity` مفعّل لكل جدول في `public`؛ صلاحيات `anon` و`authenticated` من `information_schema.role_table_grants` و`information_schema.routine_privileges` مطابقة لما في الترحيلات؛ كل دالة `SECURITY DEFINER` (`pg_proc.prosecdef`) تحمل `search_path=""` في `proconfig`.
   - فحص العزل بحسابين حقيقيين عبر PostgREST وفق `G7_READINESS_REVIEW_AR.md` §2.
   - **تنبيه:** `rls-tests.js` و`restore-drill.js` و`g7-*` تعمل **على PGlite محليًا فقط** (كل منها يحمّل `shim.sql` والترحيلات والبذرة في قاعدة داخل الذاكرة، ولا يقرأ أي سلسلة اتصال، ورأس كل ملف: «Never point it at Supabase»). تُشغَّل قبل النشر على ملفات الترحيل نفسها، ونتائجها **ليست دليلًا عن قاعدة الإنتاج**.
3. نطاق ومسار نشر منفصلان، و`config.js` خاص بالإنتاج.
4. البريد الحقيقي (SMTP)، إشعار الخصوصية وشروط الاستخدام، MFA لكل المشرفين.
5. تمرين استعادة فعلي ناجح قبل إدخال أول عميل.
6. لا تُنسخ أي بيانات من Staging إلى الإنتاج.

## 10) ملخص البنود المعلقة على المالك

| البند | الحالة |
|---|---|
| لصق `g7_apply.sql` على Staging ونشر الواجهة والأدلة | قيد انتظار المالك (OWNER-PENDING) |
| قرار Go / No-Go للإطلاق التجاري | قيد انتظار المالك (OWNER-PENDING) |
| إنشاء مشروع الإنتاج والنشر عليه | قيد انتظار المالك (OWNER-PENDING) |
| المراقبة على لوحة Supabase والمناوبة | قيد انتظار المالك (OWNER-PENDING) |
| خطة التواصل وقنواتها | قيد انتظار المالك (OWNER-PENDING) |
