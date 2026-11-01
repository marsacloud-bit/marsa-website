# تقرير إنجاز G2 — نواة SaaS والأمان (بيئة Staging)

> **التاريخ:** 2026-11-02 · **الفرع:** `online-staging` · **النطاق:** Staging فقط، ببيانات اختبار.
> **المراجع:** خطة `Marsa_Cloud_Sequential_Execution_Plan` (المرحلة الثالثة، G2، الخطوات 1–15)، و`docs/online/G2_SPEC.md` (العقد)، و`docs/online/ARCHITECTURE.md`.
> **تنبيه:** كل الاختبارات أدناه شُغّلت محليًا على PGlite (Postgres 16 داخل Node). **لم يُختبر أي شيء على مشروع Supabase Staging الحقيقي ولا في متصفح**، ولم يُنفَّذ أي `git commit`. هذا العمل جاهز للمراجعة والتطبيق اليدوي، لا معتمد للإنتاج.

---

## 1) نتائج الاختبارات (أرقام فعلية من آخر تشغيل)

الأمر: `cd /tmp/pgtest && NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/<file>.js --quiet`

| الملف | ما يختبره | النتيجة |
|---|---|---|
| `rls-tests.js` | العزل بين مؤسستين وفرعين، الصلاحيات على كل جدول، كتالوج الدوال المسموحة، التخزين | **590 ناجح، 0 فاشل، 1 تحذير** |
| `g2-tests.js` | إثبات نواة المؤسستين (G2.15): إنشاء المؤسسة B من لوحة المنصة، الدعوات، الفروع، مدير الفرع، الإيقاف، المعرّفات المتقاطعة، منع التكرار | **222 ناجح، 0 فاشل** |
| `g2-ops-tests.js` | نسخ المخطط، `health_check`، منع التكرار في الدوال التشغيلية، سجل أخطاء الواجهة، قارئ التدقيق | **110 ناجح، 0 فاشل** |
| `restore-drill.js` | نسخة احتياطية فعلية، ثم استرجاع في قاعدة مستقلة، ثم مقارنة كل جدول وفحص RLS | **PASS — 17 ناجح، 0 فاشل** |
| `restore-drill.js --tamper` | التحقق من أن التمرين يكشف التلاعب | **FAILED عمدًا — 16 ناجح، 2 فاشل** (المتوقع) |

المجموع: **939 فحصًا ناجحًا، 0 فاشل.** التحذير الوحيد في `rls-tests.js` ليس عطلًا، بل ملاحظة تصميم مفتوحة: حد معدل الطلبات العامة لكل رقم جوال ولكل مؤسسة، ويحتاج حدًا على مستوى الـ IP أو CAPTCHA (القرار 8).

**فحوص إضافية:**
- `supabase/all_migrations.sql` (11 ترحيلًا بالترتيب) يُحمَّل مرتين متتاليتين ثم `seed.sql` دون خطأ. `schema_versions` = 11 صفًا.
- `node --check` ناجح على كل ملفات JS المعدّلة، و`bash -n` ناجح على السكربتين.
- فحص متقاطع: كل استدعاءات `MarsaApi` في الصفحات موجودة في `supa.js`. استدعاءات RPC الـ 31 في `supa.js` تطابق أسماء ومعاملات الكتالوج. القاموسان العربي والإنجليزي 642 مفتاحًا لكل لغة، ولا مفتاح ناقص من الـ 586 المستخدمة.
- خادم محلي (`python3 -m http.server`): الصفحات الـ 13 والملفات المحلية الـ 50 المشار إليها أعادت 200.

---

## 2) خطوات G2 من الخطة → الحالة والدليل

| # | الخطوة | الحالة | الدليل | ملاحظات |
|---|---|---|---|---|
| ١ | تجهيز المستودع البرمجي | منجز جزئيًا | `.gitignore`، `CONTRIBUTING.md` (الفروع، قواعد الترحيلات، الاختبارات المطلوبة)، `.github/pull_request_template.md`، الفرع `online-staging` | التغييرات **غير ملتزمة** في git حتى الآن، ولا يوجد remote مضبوط في النسخة المحلية. الالتزام والرفع إلى GitHub وحماية الفرع قرار المالك |
| ٢ | إنشاء بيئات مستقلة | منجز | `docs/online/ENVIRONMENTS_AR.md` (محلي/PGlite، Staging، إنتاج مستقبلي، جدول الأسرار)، `assets/js/config.example.js`، `config.js` بالمفتاح العام فقط، `scripts/backup-staging.sh` يرفض أي مضيف غير مشروع Staging إلا مع `--force-other` | بيئة الإنتاج نفسها **خارج نطاق Staging** |
| ٣ | إنشاء الجداول التأسيسية | منجز | ترحيلات G1 (`20261031…`) + G2: `20261102000100_idempotency.sql`، `…000200_orgs_branches_invites.sql`، `…000300_ops_observability.sql`. جداول جديدة: `platform_admins`، `invitations`، `idempotency_keys`، `schema_versions`، `client_errors`. قيود CHECK للأدوار (`admin` بلا فرع، `branch_manager` بفرع) | كل ترحيل قابل لإعادة التشغيل، ويسجّل نفسه في `schema_versions` |
| ٤ | إنشاء إدارة المؤسسات | منجز | `platform_create_org` (البيئة تُفرض `staging`، وتنشئ أول فرع ودعوة مدير)، `admin_update_org` (حقول محددة: الاسم، اللغة، الاستقبال العام، اللون، التواصل، العنوان، الشعار)، `platform_set_org_active`، `platform.html`، تبويب «المؤسسة» في `admin.html`. g2-tests: «platform admin: create org B (idempotent)» و«org settings whitelist» | المؤسسة الثانية أُنشئت في الاختبار عبر الواجهة البرمجية نفسها، دون تعديل كود |
| ٥ | إنشاء إدارة الفروع | منجز | `admin_create_branch` / `admin_update_branch` (الرمز ثابت، لا تعطيل لآخر فرع نشط)، الكتابة المباشرة على `branches` مغلقة، تبويب «الفروع». الفرع غير المفعّل يُسقط عضوياته فورًا. g2-tests: «branches (org admin)» و«branch_manager scope» | امتداد الأدوار المرتبطة بفرع على الجداول التي بلا `branch_id` قرار مفتوح (رقم 10) |
| ٦ | إنشاء المصادقة والدخول | منجز جزئيًا | دعوات كاملة: `admin_invite`، `invitation_preview` (anon)، `accept_invitation` (بريد مطابق ومؤكد)، إلغاء وإعادة إصدار، صلاحية المرسل تُفحص وقت القبول. `login.html?invite=…` مع حماية من القبول الصامت (CSRF). «الخروج من كل الأجهزة» في `admin.html` والبوابة. التعطيل يقطع الوصول من الاستعلام التالي. g2-tests: «invitation preview + accept»، «invitations: revoked / expired / reissued / unconfirmed»، «deactivated member loses access immediately» | **إرسال الدعوة بالبريد غير موصول:** الرابط يظهر مرة واحدة ويُنسخ يدويًا. **MFA غير مطبّق** لمستخدمي التطبيق. جلسة JWT القائمة تبقى صالحة حتى انتهاء عمرها، لكن RLS ترفض البيانات فورًا. لم يُختبر مع Supabase Auth الحقيقي |
| ٧ | تطبيق العضويات والأدوار | منجز | مدير المنصة (`platform_admins`، بلا وصول لبيانات المستأجرين، مختبر)، مدير المؤسسة (`admin`)، مدير الفرع (`branch_manager` الجديد)، الموظفون، العميل. تعدد العضويات + مبدّل المؤسسة النشطة. الحماية في الخادم لا في الأزرار. g2-tests: «roles and membership scope constraints»، «invitations: who may invite what»، «platform admin: no implicit tenant data access» | رابط `platform.html` يظهر فقط في الصفحات التي تحمّل `supa.js` (شكلي؛ الحماية في الخادم) |
| ٨ | تفعيل عزل البيانات | منجز | RLS على كل جدول، وفحص كتالوج يفشل إذا ظهر جدول جديد بلا تغطية. `invitations` ضمن `TENANT_TABLES`؛ والجداول الداخلية الأربعة في `NO_API_TABLES` (لا صلاحية API إطلاقًا). الإيقاف يقطع الموظفين والبوابة والتتبع العام. rls-tests 590/0 | الرفض مختبر مباشرة من قاعدة البيانات بأدوار `anon` و`authenticated` كما يراها PostgREST |
| ٩ | حماية واجهات النظام | منجز | كل دالة `SECURITY DEFINER` بـ `search_path = ''`، وقائمة الدوال المسموحة محددة حرفيًا (6 لـ anon، 31 لـ authenticated). `admin_add_member` سُحب من الواجهة (أُغلق كشف وجود الحساب). g2-tests: «cross-org ids on every new RPC» (كل دالة جديدة مع معرّفات المؤسسة الأخرى) | — |
| ١٠ | تأسيس تخزين المستندات | منجز جزئيًا | bucket خاص `documents`، مسار مرتبط بالمؤسسة والمعاملة، روابط موقّعة قصيرة العمر. rls-tests: قراءة كائنات مؤسسة أخرى بالمسار مرفوضة، والرفع لمسار غير مسجّل مرفوض، ولا تعديل ولا حذف | **التحقق من البصمة والحجم على الخادم يحتاج Edge Function، ولم يُنفَّذ.** اختبار التخزين المتقاطع موجود في rls-tests (المؤسستان A وB من البذرة)، لا على المؤسسة المنشأة من لوحة المنصة |
| ١١ | تأسيس دعم اللغتين | منجز جزئيًا | `assets/js/i18n.js` (`MarsaI18n`: ترجمة مركزية، `lang/dir`، تنسيق Intl للتاريخ والأرقام والعملة، `err.*` لكل رمز خطأ، أسماء الحقول بالإنجليزية)، قواميس `assets/i18n/` لـ index وlogin وadmin وplatform، سكربت في `<head>` يمنع وميض RTL في هذه الصفحات | **الترجمة الإنجليزية مكتملة فقط للواجهة المشتركة وصفحات index وlogin وadmin وplatform.** بقية الصفحات (request، tracking، portal، contact، about، services، calculator، bulk-upload، ocr) تُعرض بالعربية بلا زر لغة. بعض شاشات admin القديمة (قائمة أخطاء الاستيراد) عربية فقط. لم يُراجَع تخطيط LTR في متصفح |
| ١٢ | إنشاء سجل التدقيق | منجز | `audit_log` Append-only (G1) + تريغر على `invitations` و`platform_admins`. `admin_audit_log` (مرشحات وترقيم، مع بريد المنفّذ) وتبويب «سجل التدقيق». g2-ops-tests: «admin_audit_log» | — |
| ١٣ | تأسيس منع التكرار | منجز | `idempotency_keys` + `app.idem_begin/finish`، مطبّق على: إنشاء المؤسسة، الدعوة، الطلب العام، رسالة التواصل، التحويل لمعاملة، تغيير الحالة التشغيلية والمالية، إصدار رمز التتبع. المفتاح مربوط بالمستخدم والمؤسسة. الأسرار لا تُخزَّن (الإعادة تعيد `token_shown:true`). الواجهة تميّز `MRS_UNKNOWN_RESULT` عن الفشل المؤكد. g2-ops-tests: أقسام «idempotency: …» الأربعة؛ g2-tests: «idempotency keys are bound to the org» | المحاكاة على `supa.js` (بلا شبكة) نجحت 7/7، ولم يُجرَّب انقطاع شبكة حقيقي |
| ١٤ | إعداد المراقبة والاستعادة | منجز جزئيًا | `health_check()`، `client_errors` + `log_client_error` (إخفاء البيانات الشخصية وحد المعدل)، `admin_recent_errors` / `platform_recent_errors`، تمرين استعادة فعلي على PGlite (17/17، ويكشف التلاعب)، `scripts/backup-staging.sh` و`scripts/restore-to-scratch.sh`، `BACKUP_RESTORE_AR.md`، خطة التراجع عن إصدار معيب في `ENVIRONMENTS_AR.md` §4.3 | **سكربتا pg_dump/psql لم يُشغَّلا فعليًا** (الأداتان غير مثبتتين هنا). لا تنبيهات صحية خارجية (لا شيء يستدعي `health_check` دوريًا). التراجع عن نشر معيب موثّق ولم يُتمرَّن عليه على Hostinger |
| ١٥ | اختبار نواة مؤسستين | منجز (محليًا) | `supabase/tests/g2-tests.js`: 222/222 — مؤسستان وفروع ومدير فرع وموظفون وعملاء ومعاملات ومستندات متشابهة، ثم كل مسار غير مصرح به. مع `rls-tests.js` 590/0 | بوابة الخروج محققة على PGlite. يلزم تكرار تحقق مختصر يدويًا على Staging الحقيقي (القسم 3) |

---

## 3) ما يجب على المالك فعله يدويًا

### 3.1 قبل تطبيق الترحيلات
1. خذ نسخة احتياطية من Staging (`scripts/backup-staging.sh` وفق `BACKUP_RESTORE_AR.md`، أو من لوحة Supabase).
2. شغّل هذا الاستعلام في SQL Editor. **يجب ألا يعيد أي صف**، وإلا فشل قيد CHECK في 0200:
   ```sql
   SELECT * FROM public.memberships WHERE role = 'admin' AND branch_id IS NOT NULL;
   ```
3. (موصى به) فعّل امتداد `pg_cron` من Database → Extensions، حتى يجدول 0300 التنظيف اليومي تلقائيًا.

### 3.2 تشغيل الترحيلات الجديدة في Supabase SQL Editor — بالترتيب
| # | الملف | ملاحظة |
|---|---|---|
| 1 | `supabase/migrations/20261101000100_document_extractions.sql` | فقط إن لم يكن طُبّق سابقًا (إعادة تشغيله آمنة) |
| 2 | `supabase/migrations/20261102000100_idempotency.sql` | منع التكرار |
| 3 | `supabase/migrations/20261102000200_orgs_branches_invites.sql` | المؤسسات والفروع والدعوات والأدوار |
| 4 | `supabase/migrations/20261102000300_ops_observability.sql` | المراقبة ونسخ المخطط وتطبيق منع التكرار |

كل ملف في استعلام جديد، والصق **كامل** محتواه. إن ظهر خطأ فتوقف ولا تنتقل للتالي. بديلًا: الحزمة الكاملة `supabase/all_migrations.sql` (11 قسمًا، آمنة لإعادة التشغيل). تحقق بعدها:
```sql
SELECT public.health_check();   -- schema_version = 20261102000300
```

### 3.3 تعيين مدير المنصة
1. Authentication → Users → أنشئ المستخدم (مع Auto Confirm) أو استخدم حسابك.
2. افتح `supabase/make_platform_admin.sql`، واستبدل `<platform-admin-email>` ببريدك (في الموضعين)، ثم شغّله في SQL Editor. يجب أن يعيد صفًا ببريدك.

### 3.4 إعدادات Supabase Auth للنطاق `marsacloud.com`
Authentication → URL Configuration:
- **Site URL:** `https://marsacloud.com/login.html`
- **Redirect URLs** (كل سطر على حدة):
  ```
  https://marsacloud.com/login.html
  https://marsacloud.com/login.html?confirmed=1
  https://marsacloud.com/portal.html
  https://marsacloud.com/admin.html
  https://marsacloud.com/platform.html
  ```
- تأكد أن **Confirm email** مفعّل (قبول الدعوة يرفض البريد غير المؤكد: `MRS_EMAIL_UNCONFIRMED`).

### 3.5 إعادة النشر إلى Hostinger
وفق `ENVIRONMENTS_AR.md` §4: تجهيز الإصدار من الفرع بعد الالتزام، والاحتفاظ بالـ zip السابق، والإبقاء على `.htaccess`. الملفات الجديدة أو المعدّلة التي يجب أن تصل: `platform.html`، `admin.html`، `login.html`، `index.html`، `assets/js/` (ومنها `i18n.js` و`platform.js` و`supa.js` و`auth.js` و`admin.js` و`main.js` و`request.js` و`portal.js` و`bulk-upload.js`)، `assets/i18n/*.js`، `assets/css/pages/platform.css`. **طبّق الترحيلات قبل رفع الواجهة.**

### 3.6 تحقق يدوي مختصر على Staging (لم يُنفَّذ هنا)
1. `platform.html`: إنشاء مؤسسة تجريبية ثانية، ونسخ رابط دعوة المدير.
2. فتح الرابط في نافذة خاصة، والتسجيل بالبريد نفسه، والتأكيد، ثم القبول.
3. من `admin.html` للمؤسسة الجديدة: إضافة فرع، ودعوة مدير فرع وموظف، وقبول الدعوتين.
4. تعطيل الموظف والتأكد أنه لا يرى شيئًا بعد التحديث. إيقاف المؤسسة من لوحة المنصة والتأكد من انقطاع البوابة والتتبع.
5. تبديل المؤسسة النشطة لمستخدم عضو في مؤسستين. تجربة إرسال طلب مع قطع الشبكة ثم إعادة المحاولة (لا تكرار).
6. التأكد أن `log_client_error` يسجّل مفتاح زائر صحيحًا خلف حافة Supabase (افتراض `cf-connecting-ip` / آخر قفزة في `X-Forwarded-For`).
7. إن لم يتوفر `pg_cron`: شغّل يوميًا `SELECT app.idem_purge_expired(); SELECT app.client_errors_purge(30);`.

---

## 4) قرارات مفتوحة للمالك

| # | القرار | الوضع الحالي |
|---|---|---|
| 1 | ملكية العملاء بين الفروع | ملف العميل مشترك على مستوى المؤسسة، والمعاملات معزولة بالفرع |
| 2 | التتبع العام | رقم + رمز سري، وحالة مختصرة. المؤسسة الموقوفة لا تُتتبَّع |
| 5 | إغلاق التسجيل الذاتي | مسار الدعوة جاهز الآن؛ يمكن تعطيل «Allow new users to sign up» فيصبح الدخول بالدعوة فقط |
| 8 | حد معدل الطلبات العامة | لكل جوال ولكل مؤسسة؛ يحتاج حدًا بالـ IP على الحافة أو CAPTCHA قبل أي استخدام عام (التحذير الوحيد في rls-tests) |
| 10 | امتداد الأدوار المرتبطة بفرع | `clearance_staff` و`operations_manager` و`branch_manager` المرتبطون بفرع يصلون إلى ملفات العملاء والاستيراد ورسائل التواصل والطلبات غير المسندة في كل المؤسسة. هل يُقصر ذلك على العضويات التي على مستوى المؤسسة؟ |
| 11 | MFA | غير مطبّق لمستخدمي التطبيق |
| 12 | إرسال الدعوات | نسخ يدوي للرابط؛ لا بريد |
| 13 | التنظيف الدوري | `pg_cron` أو تشغيل يدوي يومي |
| 14 | مدة صلاحية الدعوة | 7 أيام لكل الأدوار |
| — | الالتزام والدمج | لم يُنفَّذ أي `git commit`؛ المراجعة والالتزام والرفع بيد المالك |

(بقية القرارات 3 و4 و6 و7 و9 من G1 كما هي في `ARCHITECTURE.md` §13.)

---

## 5) حدود معروفة

- **التحقق من رفع الملفات على الخادم:** البصمة SHA-256 والحجم يحسبهما المتصفح، ولا يتحقق منهما الخادم بعد الرفع. يحتاج Edge Function.
- **البريد:** الدعوات لا تُرسل بالبريد. الرابط يظهر مرة واحدة ويُنسخ يدويًا، ويمكن إعادة إصداره (`admin_reissue_invitation`، ولمدير المنصة `platform_reissue_admin_invitation` ما دامت المؤسسة بلا مدير).
- **اللغة الإنجليزية:** مكتملة فقط للواجهة المشتركة (الرأس والتذييل والشريط ورسائل الأخطاء) ولصفحات index وlogin وadmin وplatform. بقية الصفحات عربية فقط بلا زر لغة. حقول `DETAIL` الجديدة (`slug_taken`، `code_taken`، `invitation_pending`، `unknown_key`، `last_branch`) غير مترجمة مركزيًا؛ admin وplatform تعالجان بعضها محليًا.
- **MFA:** غير مطبّق.
- **الجلسات:** «الخروج من كل الأجهزة» يُنهي الأجهزة الأخرى خلال عمر جلستها. لكن الوصول إلى البيانات ينقطع فورًا عند التعطيل، لأن RLS تقرأ `is_active` في كل استعلام.
- **سباق «آخر مدير»:** أُصلح بقفل صف المؤسسة، وتحقق منه فحص للكود فقط، لأن PGlite اتصال واحد لا يسمح بتشغيل السباق فعليًا.
- **مفتاح الزائر في سجل الأخطاء:** يفترض أن حافة Supabase تضع `cf-connecting-ip` أو تضيف الـ IP الحقيقي آخر `X-Forwarded-For`. يلزم تأكيده على Staging.
- **النسخ الاحتياطي:** التمرين الآلي على PGlite ناجح، لكن `backup-staging.sh` و`restore-to-scratch.sh` لم يُشغَّلا على Staging.
- **المراقبة:** لا تنبيهات خارجية؛ `health_check()` ولوحة الأخطاء متاحتان عند الطلب فقط.
- **واجهة مدير الفرع:** نافذة الدعوة تعرض كل عملاء المؤسسة، والخادم يرفض من هو خارج فروعه (`MRS_FORBIDDEN 'client'`). عميل بلا معاملات ولا طلبات مسندة يحتاج مدير المؤسسة لدعوته.
- **رابط لوحة المنصة:** لا يظهر في about وcalculator وindex وservices لأنها لا تحمّل `supa.js` (شكلي فقط).
- **لا اختبار في متصفح ولا على Supabase الحقيقي:** التغييرات الأمامية (القبول التلقائي للدعوة، زر إعادة الإصدار، إشعار الإعادة، الخروج من كل الأجهزة، سكربت اللغة في `<head>`) فُحصت بـ `node --check` ومحاكاة `supa.js` فقط.

---

## 6) ملفات G2 الرئيسية

- **قاعدة البيانات:** `supabase/migrations/20261102000100_idempotency.sql`، `…000200_orgs_branches_invites.sql`، `…000300_ops_observability.sql`، `supabase/all_migrations.sql`، `supabase/make_platform_admin.sql`.
- **الاختبارات:** `supabase/tests/rls-tests.js`، `g2-tests.js`، `g2-ops-tests.js`، `restore-drill.js`، `shim.sql`.
- **الواجهة:** `platform.html`، `admin.html`، `login.html`، `index.html`، `assets/js/{supa,auth,admin,platform,i18n,main,request,portal,bulk-upload}.js`، `assets/i18n/{index,login,admin,platform}.js`، `assets/css/pages/platform.css`.
- **التشغيل والتوثيق:** `scripts/backup-staging.sh`، `scripts/restore-to-scratch.sh`، `CONTRIBUTING.md`، `.github/pull_request_template.md`، `.gitignore`، `assets/js/config.example.js`، `docs/online/{ENVIRONMENTS_AR,BACKUP_RESTORE_AR,G2_SPEC,ARCHITECTURE}.md`، وهذا التقرير.
