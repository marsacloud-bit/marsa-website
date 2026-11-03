# البيئات والأسرار والنشر — مرسى (مرساة كلاود)

> **الحالة:** توجد اليوم بيئتان فقط تعملان: التطوير المحلي، وبيئة **Staging** ببيانات اختبار. **لا توجد بيئة إنتاج بعد**، وإنشاؤها قرار للمالك له شروط مسبقة (القسم 3).
> مراجع: [`ARCHITECTURE.md`](ARCHITECTURE.md) (المعمارية)، [`SETUP_AR.md`](SETUP_AR.md) (تجهيز Staging)، [`BACKUP_RESTORE_AR.md`](BACKUP_RESTORE_AR.md) (النسخ الاحتياطي والاسترجاع)، [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) (طريقة العمل).

## 1) نظرة عامة

| البيئة | الواجهة | قاعدة البيانات | البيانات | الحالة |
|---|---|---|---|---|
| **Demo (عرض محلي)** | الملفات مباشرة أو `http://127.0.0.1:8000` | لا شيء — `localStorage` في المتصفح | ما يُدخله المستخدم على جهازه | قائمة |
| **Dev / Local PGlite** | خادم محلي `python3 -m http.server` | PGlite ‏(Postgres 16 في الذاكرة) داخل الاختبارات فقط | بيانات `seed.sql` + بيانات الاختبارات، تُمسح بعد كل تشغيل | قائمة |
| **Staging** | `https://marsacloud.com` على Hostinger، محمي بكلمة مرور (HTTP Basic Auth) | مشروع Supabase التجريبي (المعرّف `cgzhidyxfpksfckwmauq`) | بيانات وهمية فقط (`@example.com`) — `organizations.environment = 'staging'` | قائمة، الهدف الحالي |
| **Production** | لم يُحدد | مشروع Supabase منفصل (مستقبلًا) | بيانات حقيقية | **غير موجودة** |

القاعدة الحاكمة: **كل بيئة لها مشروع Supabase مستقل ومفاتيح مستقلة.** لا تُشارك قاعدة بيانات بين Staging والإنتاج، ولا تُنسخ بيانات حقيقية إلى Staging.

## 2) كل بيئة بالتفصيل

### 2.1 Demo — عرض محلي بلا خادم
- `assets/js/config.js` بقيم فارغة لـ `supabaseUrl` و`supabaseAnonKey` (انظر القالب [`assets/js/config.example.js`](../../assets/js/config.example.js)).
- لا يُرسل أي طلب شبكة خارجي: خط Cairo مستضاف على الموقع نفسه (`assets/fonts/cairo/`) منذ 2026-11-03، بعد أن كان من Google Fonts. يظهر شريط «نسخة عرض تجريبية».

### 2.2 Dev / Local PGlite — التطوير والاختبار
- الواجهة تُفتح عبر خادم محلي:
  ```bash
  cd ~/Downloads/marsa-website
  python3 -m http.server 8000 --bind 127.0.0.1
  ```
- قاعدة البيانات للاختبار فقط: PGlite تحمّل `supabase/tests/shim.sql` (بديل كائنات Supabase مثل `auth.users` و`storage`) ثم كل الترحيلات ثم `seed.sql`. لا اتصال بـ Supabase إطلاقًا:
  ```bash
  mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm i @electric-sql/pglite   # once, outside the repo
  cd /tmp/pgtest && NODE_PATH=/tmp/pgtest/node_modules node ~/Downloads/marsa-website/supabase/tests/rls-tests.js --quiet
  ```
- عند تشغيل الواجهة المحلية بـ `config.js` المعبّأ فإنها تتصل بـ **Staging** (لا توجد قاعدة Supabase محلية حاليًا). تعامل معها كأنك على Staging.
- اختياري لاحقًا: Supabase CLI ‏(`supabase start`) لتشغيل نسخة Supabase كاملة على Docker محليًا. غير مُعدّ حاليًا.

### 2.3 Staging — البيئة التجريبية المتصلة
- **الواجهة:** ملفات ثابتة على Hostinger بالنطاق `marsacloud.com`. الموقع كله محمي بـ HTTP Basic Auth عبر ملف `.htaccess` موجود في نسخة النشر فقط (`~/Downloads/marsa-deploy`، وهي ليست مستودع git). كلمة مرور الحماية في مدير كلمات المرور فقط، ولا تُكتب في أي ملف أو رسالة أو مستند.
- **قاعدة البيانات:** مشروع Supabase التجريبي. عنوانه والمفتاح العام في `assets/js/config.js` (قيم عامة بطبيعتها؛ الحماية بسياسات RLS).
- **Auth:** ‏Site URL وRedirect URLs في Supabase مضبوطة على عنوان Staging. البريد الحقيقي/واتساب لا يُرسلان من النظام في هذه المرحلة.
- **البيانات:** وهمية فقط. لا يُدخل أي بيانات عملاء أو هويات أو سجلات تجارية حقيقية.
- **الترحيلات:** تُطبَّق يدويًا من SQL Editor (أو `supabase db push`) بعد نسخة احتياطية (انظر `BACKUP_RESTORE_AR.md`). يمكن معرفة آخر ترحيل مطبَّق من `public.schema_versions` أو دالة `health_check()`.
- **التنظيف الدوري (إلزامي):** فعّل امتداد `pg_cron` من Database → Extensions، ثم أعد تشغيل `20261102000300_ops_observability.sql`. يجدول الترحيل تلقائيًا مهمتين يوميتين:
  - `marsa_idem_purge`: تشغّل `app.idem_purge_expired()`.
  - `marsa_client_errors_purge`: تشغّل `app.client_errors_purge(30)`.

  إن لم يتوفر `pg_cron`، شغّل الأمرين يوميًا يدويًا من SQL Editor: `SELECT app.idem_purge_expired(); SELECT app.client_errors_purge(30);`. لا تُستدعى هاتان الدالتان من الواجهة أبدًا.

### 2.4 Production — مستقبلًا (غير موجودة)
لا تُنشأ إلا بقرار مكتوب من المالك، وبعد استيفاء:
1. مشروع Supabase **جديد ومنفصل** (اسم يدل على الإنتاج)، بخطة مدفوعة تتيح نسخًا احتياطية يومية (ويُفضَّل Point-in-Time Recovery)، ومنطقة خادم معتمدة قانونيًا (PDPL — انظر `SETUP_AR.md`).
2. مراجعة أمنية لـ RLS والدوال، وتشغيل ناجح لـ `rls-tests.js` و`g2-tests.js` و`restore-drill.js` على نفس النسخة.
3. تمرين استرجاع فعلي ناجح من نسخة احتياطية حقيقية لـ Staging (`BACKUP_RESTORE_AR.md`).
4. نطاق ومسار نشر منفصلان عن Staging، و`config.js` خاص بالإنتاج بقيمة `environment: 'production'`.
5. البريد الحقيقي (SMTP مخصص) وإشعار الخصوصية وشروط الاستخدام معتمدة.
6. حسابات المشرفين بتحقق بخطوتين (MFA) على Supabase وHostinger.

## 3) الأسرار — أين يُحفظ كل شيء

| القيمة | سري؟ | مكانها | أين **لا** توضع أبدًا |
|---|---|---|---|
| Project URL ‏(`https://<ref>.supabase.co`) | لا | `assets/js/config.js` | — |
| المفتاح العام anon / publishable ‏(`sb_publishable_…`) | لا (عام بالتصميم) | `assets/js/config.js` | — |
| مفتاح `service_role` / ‏`sb_secret_…` | **نعم** | مدير كلمات المرور فقط | الواجهة، المستودع، الدردشة، البريد. `supa.js` يرفض العمل إن وجده |
| كلمة مرور قاعدة البيانات / رابط الاتصال `SUPABASE_DB_URL` | **نعم** | مدير كلمات المرور؛ يُمرَّر لمتغير بيئة في الطرفية عند الحاجة فقط | المستودع، ملفات `.env` داخل المستودع، سجل الأوامر |
| كلمة مرور HTTP Basic Auth لموقع Hostinger | **نعم** | مدير كلمات المرور | أي ملف أو مستند أو رسالة. (ملف كلمات المرور المشفّر `.htpasswd` يبقى على الخادم فقط) |
| حساب Hostinger وحساب Supabase | **نعم** | مدير كلمات المرور + MFA | — |

تمرير سر لأمر واحد دون حفظه:
```bash
read -rs SUPABASE_DB_URL && export SUPABASE_DB_URL   # paste the URL, press Enter (hidden)
./scripts/backup-staging.sh
unset SUPABASE_DB_URL
```

`.gitignore` يمنع `.env` و`.env.*` و`*.local` و`*.local.*` وملفات النسخ الاحتياطية وملفات الإصدار — لكنه شبكة أمان فقط، لا بديل عن الحذر. عند الشك في تسرّب سر: غيّره فورًا (Supabase → Project Settings → Database → Reset password، أو تدوير المفاتيح من API Keys) ثم أبلغ المالك.

## 4) النشر إلى Hostinger والتراجع

النشر يدوي من فرع `online-staging` بعد الدمج ونجاح الاختبارات. نسخة النشر `~/Downloads/marsa-deploy` تحتوي ملفات خاصة بالخادم غير موجودة في المستودع: `.htaccess` (الحماية بكلمة مرور)، و`_headers`، و`robots.txt`. **لا تحذفها ولا تستبدلها** عند نسخ الملفات (الأمر أدناه يستثنيها من `--delete`). جرّب الأمر أولًا بإضافة `--dry-run` لترى ما سيتغير.

### 4.1 تجهيز الإصدار
```bash
cd ~/Downloads/marsa-website
git switch online-staging && git status --short          # must be clean
STAMP=$(date +%Y%m%d-%H%M)
rm -rf /tmp/marsa-export && mkdir -p /tmp/marsa-export
git archive HEAD | tar -x -C /tmp/marsa-export            # tracked files only: no .env, no dumps
# copy site files into the deploy copy; keep its .htaccess; skip repo-only material
# G7-19: docs/guide/ (the help.html guides) IS published; every other docs/ path stays excluded (first matching rule wins)
rsync -a --delete \
  --exclude '.htaccess' --exclude '.htpasswd' --exclude '_headers' --exclude 'robots.txt' \
  --include 'docs/' --include 'docs/guide/***' --exclude 'docs/**' \
  --exclude 'supabase/' --exclude 'scripts/' --exclude '.github/' \
  --exclude 'CONTRIBUTING.md' --exclude 'README.md' --exclude '.gitignore' \
  --exclude 'assets/js/config.example.js' \
  /tmp/marsa-export/ ~/Downloads/marsa-deploy/
grep -rn "sb_secret_\|service_role" ~/Downloads/marsa-deploy/assets/js/config.js && echo "STOP: secret key in config.js"
cd ~/Downloads/marsa-deploy && zip -r -X ~/Downloads/marsa-releases/marsa-release-$STAMP.zip . -x '.DS_Store'
```
(أنشئ المجلد `~/Downloads/marsa-releases` مرة واحدة. ملفات الإصدار خارج المستودع، و`.gitignore` يمنع `marsa-release-*.zip` احتياطًا.)

**منذ G7 (القرار G7-19):** المجلد `docs/guide/` (أدلة المستخدم `ar/` و`en/` التي تعرضها صفحة `help.html`) **يُنشر** مع الموقع، وبقية `docs/` (مثل `docs/online/` و`docs/import-templates/` و`docs/partials.md`) تبقى مستثناة. تحقق بعد `rsync`:
```bash
ls ~/Downloads/marsa-deploy/docs/            # guide only
ls ~/Downloads/marsa-deploy/docs/guide/ar ~/Downloads/marsa-deploy/docs/guide/en   # index admin ops finance client-portal platform (.md)
```
إن قرر المالك لاحقًا عدم نشر أي شيء من `docs/` تُنقل الأدلة إلى `assets/guide/` (قرار مفتوح في `G7_SPEC.md`).

### 4.2 الرفع
1. hPanel → Files → File Manager → `public_html` لنطاق `marsacloud.com`.
2. ارفع `marsa-release-YYYYMMDD-HHMM.zip` واستخرجه داخل `public_html` (استبدال الملفات الموجودة)، ثم احذف ملف الـ zip من الخادم.
3. تأكد أن `.htaccess` ما زال موجودًا وأن الموقع يطلب كلمة المرور في نافذة متصفح خاصة.
4. تحقق سريع: الصفحة الرئيسية، `login.html`، شريط «بيئة تجريبية (Staging)»، وأن `health_check()` تعيد آخر نسخة مخطط متوقعة (من لوحة المنصة `platform.html` عند توفرها).
5. سجّل في ملاحظات الإصدار: اسم الـ zip، رقم الالتزام (`git rev-parse --short HEAD`)، آخر ترحيل مطبّق.

### 4.3 التراجع (Rollback)
- **احتفظ دائمًا بملف الإصدار السابق** (والأفضل آخر 3–5 إصدارات) في `~/Downloads/marsa-releases/`.
- للتراجع عن الواجهة: ارفع الـ zip السابق واستخرجه في `public_html` بنفس الخطوات (4.2)، ثم تحقق.
- **الـ zip يعيد الواجهة فقط، لا قاعدة البيانات.** الترحيلات إضافية بالتصميم، لذلك تعمل الواجهة السابقة عادةً على المخطط الأحدث. إن احتاج الأمر تراجعًا في البيانات أو المخطط: إما ترحيل تصحيحي جديد (المفضّل)، أو استرجاع من النسخة الاحتياطية التي أُخذت قبل الترحيل وفق `BACKUP_RESTORE_AR.md` — وذلك بقرار المالك.

## 5) قائمة فحص قبل كل نشر
- [ ] الاختبارات ناجحة (`rls-tests.js`، `g2-tests.js`، `restore-drill.js`، و`node --check` لملفات JS المعدّلة).
- [ ] نسخة احتياطية من Staging أُخذت قبل أي ترحيل جديد.
- [ ] الترحيلات الجديدة طُبّقت على Staging قبل رفع الواجهة التي تعتمد عليها.
- [ ] `config.js` في نسخة النشر يحتوي المفتاح العام فقط.
- [ ] الإصدار السابق محفوظ، و`.htaccess` لم يتغير.
