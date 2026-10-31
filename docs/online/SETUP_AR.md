# دليل تشغيل مرسى أونلاين — البيئة التجريبية (Staging)

> **مهم:** هذا الدليل لتجهيز **بيئة تجريبية ببيانات اختبار فقط**، وليست بيئة إنتاج. لا تُدخل بيانات عملاء حقيقية، ولا أرقام هويات أو سجلات حقيقية، حتى تُعتمد بيئة الإنتاج (نسخ احتياطي، تمرين استرجاع، مراجعة أمنية، ومراجعة قانونية).
>
> كل الخطوات يدوية وينفذها المالك أو من يفوّضه بحسابه هو. لا يُنشئ أحد حسابات نيابةً عنك.

المصطلحات:
- **Supabase**: الخدمة التي توفّر قاعدة البيانات (PostgreSQL) وتسجيل الدخول (Auth) وتخزين الملفات (Storage).
- **Project URL** و**anon key**: عنوان مشروعك والمفتاح العام. يوضعان في الموقع.
- **service_role key** (أو secret key): مفتاح سري بصلاحيات كاملة. **لا يوضع في الموقع أبدًا ولا يُرسل لأي شخص.**

---

## 1) إنشاء حساب ومشروع على Supabase

1. ادخل إلى `https://supabase.com` واضغط **Start your project**، ثم سجّل بحساب بريد تملكه الشركة (يفضَّل بريد عام مثل `it@your-domain.sa` وليس بريدًا شخصيًا).
2. فعّل التحقق بخطوتين (MFA) من إعدادات الحساب: **Account → Security**.
3. أنشئ مؤسسة (Organization) باسم الشركة، ثم **New project**:
   - **Name:** `marsa-staging` (يجب أن يدل الاسم على أنه تجريبي).
   - **Database Password:** كلمة مرور قوية جدًا. احفظها في مدير كلمات مرور، ولا تضعها في أي ملف داخل الموقع.
   - **Region:** اختر **أقرب منطقة إلى المملكة العربية السعودية تظهر في القائمة**. إن ظهرت منطقة في الشرق الأوسط فاخترها، وإلا فالأقرب عادةً **Central EU (Frankfurt)** أو **South Asia (Mumbai)**. لا يمكن تغيير المنطقة بعد إنشاء المشروع.
4. انتظر حتى يكتمل تجهيز المشروع (دقيقتان تقريبًا).

### ملاحظة عن مكان حفظ البيانات ونظام حماية البيانات الشخصية (PDPL)
- نظام حماية البيانات الشخصية في المملكة (PDPL) ولوائحه، ومنها لائحة نقل البيانات خارج المملكة، تضع شروطًا على حفظ البيانات الشخصية أو معالجتها خارج المملكة.
- **قبل تحويل البيئة إلى إنتاج ببيانات عملاء حقيقية، راجع مختصًا قانونيًا أو مستشار امتثال** للتأكد من مدى جواز حفظ البيانات في منطقة الخادم المختارة، ومن الحاجة إلى اتفاقية معالجة بيانات (DPA) مع Supabase، ومن إشعار الخصوصية وموافقات العملاء، ومن متطلبات هيئة البيانات والذكاء الاصطناعي (سدايا) أو أي جهة تنظيمية لقطاعك.
- في البيئة التجريبية الحالية نستخدم بيانات وهمية فقط (عناوين `@example.com` وأرقام اختبار)، فلا تُنقل بيانات شخصية حقيقية.

---

## 2) أين تجد Project URL والمفتاح العام

1. من لوحة المشروع: **Project Settings** (رمز الترس) ← **API** (وفي بعض الإصدارات: **Data API** و**API Keys**).
2. انسخ:
   - **Project URL** ويكون بالشكل `https://xxxxxxxxxxxx.supabase.co`.
   - المفتاح **anon public** (أو **publishable key** الذي يبدأ بـ `sb_publishable_`).
3. **لا تنسخ** المفتاح `service_role` ولا `secret` (`sb_secret_…`). لا تضعه في الموقع ولا ترسله في بريد أو محادثة. ملف `assets/js/supa.js` يرفض العمل إذا وُضع فيه مفتاح سري، ويبقى الموقع في وضع نسخة العرض.
4. في الصفحة نفسها، تأكد من أن **Exposed schemas** تحتوي `public` فقط (الافتراضي). **لا تُضف المخطط `app`.**

> المفتاح العام (anon) مصمَّم ليكون ظاهرًا في الموقع. الحماية الفعلية تقوم بها سياسات قاعدة البيانات (RLS)، فكل مستخدم يرى بيانات مؤسسته وصلاحيته فقط.

---

## 3) تشغيل ملفات قاعدة البيانات (Migrations)

الملفات موجودة في `supabase/migrations/` ويجب تشغيلها **بهذا الترتيب بالضبط**:

| # | الملف | المحتوى |
|---|---|---|
| 1 | `20261031000100_core_tenancy.sql` | المؤسسات والفروع والمستخدمون والصلاحيات |
| 2 | `20261031000200_operations.sql` | العملاء والطلبات والمعاملات والحاويات والمستندات والأحداث |
| 3 | `20261031000300_security_rls.sql` | سياسات العزل والصلاحيات (RLS) |
| 4 | `20261031000400_rpc.sql` | الدوال العامة (طلب تخليص، تواصل، تتبع) ودوال الموظفين |
| 5 | `20261031000500_storage.sql` | مخزن المستندات الخاص `documents` وسياساته |
| 6 | `20261031000650_admin_rpcs.sql` | دوال إدارة الأعضاء |
| 7 | `20261031000700_security_hardening.sql` | تقوية الأمان (المراجعة الأمنية) |

### الخيار (أ): من المتصفح عبر SQL Editor (الأسهل)
1. من القائمة الجانبية: **SQL Editor** ← **New query**.
2. افتح الملف رقم 1 في محرر نصوص (مثل VS Code أو TextEdit بوضع نص عادي)، وانسخ **كل** محتواه، والصقه في المحرر.
3. اضغط **Run**. يجب أن تظهر رسالة **Success. No rows returned**.
4. كرر الخطوات مع الملفات 2 ثم 3 … حتى 7، كلٌّ في استعلام جديد، **وبالترتيب**.
5. إذا ظهر خطأ في ملف: توقف، ولا تنتقل إلى الملف التالي. انسخ نص الخطأ واحتفظ به لمراجعته مع المطوّر.

### الخيار (ب): عبر Supabase CLI (للمطوّر)
```bash
# تثبيت الأداة (macOS)
brew install supabase/tap/supabase
# أو: npm install -g supabase

cd ~/Downloads/marsa-website
supabase login                       # يفتح المتصفح لتسجيل الدخول بحسابك
supabase init                        # فقط إن طلبت الأداة ذلك؛ ينشئ supabase/config.toml ولا يمس ملفات migrations
supabase link --project-ref <project-ref>   # project-ref هو الجزء xxxxxxxxxxxx من Project URL، وسيطلب كلمة مرور قاعدة البيانات
supabase db push --dry-run           # يعرض الملفات التي ستُطبّق دون تنفيذ
supabase db push                     # يطبّق الملفات السبعة بالترتيب
```

---

## 4) تشغيل بيانات الاختبار (Seed)

1. في **SQL Editor** افتح استعلامًا جديدًا، والصق محتوى `supabase/seed.sql` كاملًا، ثم **Run**.
2. ينشئ الملف مؤسسة تجريبية `blue-sea` («مؤسسة البحر الأزرق (بيئة تجريبية)») وفرعي جدة والدمام، و3 عملاء وهميين، و3 معاملات، و3 حاويات، وطلبًا عامًا واحدًا لاختبار التتبع.
3. **رمز التتبع التجريبي** للطلب العام: `deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`. الرقم المرجعي تعرفه بهذا الاستعلام:
   ```sql
   SELECT ref FROM public.service_requests WHERE id = '0b5e0000-0000-4000-8000-000000000401';
   ```
4. يمكن تشغيل الملف أكثر من مرة دون تكرار البيانات.

---

## 5) إنشاء مستخدمي الاختبار وربطهم بالأدوار

### 5-1 إنشاء المستخدمين
من **Authentication** ← **Users** ← **Add user** ← **Create new user**، أنشئ هذه الحسابات وفعّل **Auto Confirm User** لكل منها، واختر لكل حساب كلمة مرور اختبار قوية خاصة به (احفظها في مدير كلمات المرور، ولا تستخدم كلمة مرور حقيقية لأي خدمة أخرى):

| البريد | الدور | الفرع |
|---|---|---|
| `admin@example.com` | مدير نظام (admin) | كل الفروع |
| `ops@example.com` | مدير عمليات (operations_manager) | كل الفروع |
| `clearance.jed@example.com` | موظف تخليص (clearance_staff) | جدة فقط |
| `transport.dmm@example.com` | موظف نقل (transport_staff) | الدمام فقط |
| `accountant@example.com` | محاسب (accountant) | كل الفروع |
| `client1@example.com` | عميل (client) | مرتبط بالعميل «شركة الاختبار الأولى للتجارة» |

> عناوين `example.com` محجوزة للاختبار ولا تستقبل بريدًا، لذلك فعّلنا Auto Confirm. لاختبار رسائل البريد (التأكيد واستعادة كلمة المرور) استخدم بريد اختبار تملكه أنت.

### 5-2 ربط الأدوار (شغّله في SQL Editor)
```sql
-- يربط كل حساب بدوره في المؤسسة التجريبية (عدّل العناوين إن غيّرتها)
INSERT INTO public.memberships (user_id, org_id, branch_id, role)
SELECT u.id, '0b5e0000-0000-4000-8000-000000000001'::uuid, x.branch_id::uuid, x.role
FROM (VALUES
  ('admin@example.com',         NULL,                                   'admin'),
  ('ops@example.com',           NULL,                                   'operations_manager'),
  ('clearance.jed@example.com', '0b5e0000-0000-4000-8000-000000000011', 'clearance_staff'),
  ('transport.dmm@example.com', '0b5e0000-0000-4000-8000-000000000012', 'transport_staff'),
  ('accountant@example.com',    NULL,                                   'accountant'),
  ('client1@example.com',       NULL,                                   'client')
) AS x(email, branch_id, role)
JOIN auth.users u ON u.email = x.email
ON CONFLICT DO NOTHING;

-- يربط حساب العميل بسجل العميل
INSERT INTO public.client_users (org_id, client_id, user_id, role)
SELECT '0b5e0000-0000-4000-8000-000000000001', '0b5e0000-0000-4000-8000-000000000101', u.id, 'owner'
FROM auth.users u WHERE u.email = 'client1@example.com'
ON CONFLICT (client_id, user_id) DO NOTHING;

-- للتحقق
SELECT u.email, m.role, m.branch_id, m.active
FROM public.memberships m JOIN auth.users u ON u.id = m.user_id
ORDER BY m.role;
```
- يجب تشغيل هذا المقطع من **SQL Editor** (لا يمكن تعديل الصلاحيات من الموقع مباشرة). بعد وجود مدير نظام واحد، يضيف المدير بقية الموظفين من **لوحة الموظفين** (`admin.html` ← الأعضاء) لحسابات مسجّلة مسبقًا.
- الأدوار المتاحة: `client`، `clearance_staff`، `transport_staff`، `accountant`، `accounts_manager`، `operations_manager`، `supervisor`، `admin`.

---

## 6) إعدادات تسجيل الدخول (Authentication)

افترضنا أن عنوان البيئة التجريبية هو `https://staging.your-domain.sa/` (استبدله بعنوانك الفعلي).

1. **Authentication** ← **URL Configuration**:
   - **Site URL:** `https://staging.your-domain.sa/login.html`
   - **Redirect URLs** (أضف كل سطر على حدة):
     ```
     https://staging.your-domain.sa/login.html
     https://staging.your-domain.sa/login.html?confirmed=1
     https://staging.your-domain.sa/login.html?mode=reset
     https://staging.your-domain.sa/portal.html
     https://staging.your-domain.sa/admin.html
     ```
     للاختبار على جهازك أضف أيضًا العناوين نفسها بالبادئة `http://127.0.0.1:8000/`.
2. **Authentication** ← **Providers** (أو **Sign In / Providers**) ← **Email**:
   - فعّل **Enable Email provider**.
   - فعّل **Confirm email** (تأكيد البريد قبل الدخول).
   - اجعل الحد الأدنى لطول كلمة المرور **8** على الأقل، ويفضّل اشتراط حروف وأرقام.
3. **التسجيل الذاتي للعملاء:** صفحة الدخول تتيح للعميل إنشاء حساب، لكن الحساب الجديد **لا يرى أي بيانات** حتى يربطه موظف بسجل عميل. إن أردت إيقاف التسجيل الذاتي في هذه المرحلة: عطّل **Allow new users to sign up** (قرار مفتوح للمالك).
4. **قوالب البريد بالعربية (اختياري):** **Authentication** ← **Emails** (Email Templates): عدّل قوالب **Confirm signup** و**Reset password** بنص عربي، مع الإبقاء على المتغير `{{ .ConfirmationURL }}` كما هو. مثال:
   ```html
   <div dir="rtl" style="font-family:Tahoma,Arial">
     <h2>تأكيد بريدك في مرسى (بيئة تجريبية)</h2>
     <p>اضغط الرابط التالي لتأكيد بريدك الإلكتروني:</p>
     <p><a href="{{ .ConfirmationURL }}">تأكيد البريد</a></p>
     <p>إن لم تطلب ذلك فتجاهل هذه الرسالة.</p>
   </div>
   ```
5. **خدمة البريد:** خادم البريد المدمج في Supabase محدود العدد ومخصص للتجربة. قبل الإنتاج اربط خادم SMTP خاصًا بالشركة من **Project Settings** ← **Authentication** ← **SMTP Settings**.

---

## 7) التحقق من مخزن المستندات (Storage)

1. **Storage** ← **Buckets**: يجب أن يظهر مخزن باسم **`documents`**، وبجانبه أنه **Private** (غير عام). لا تجعله Public.
2. **Storage** ← **Policies**: يجب أن تظهر سياسات على `storage.objects` خاصة بالمخزن `documents` (رفع وقراءة فقط، دون تعديل أو حذف).
3. الحد الأقصى لحجم الملف 25 ميغابايت، والأنواع المسموحة PDF والصور وExcel وCSV.
4. مسار كل ملف يكون بالشكل `org_id/transaction_id/document_id/اسم_الملف`، ولا يُعدَّل الأصل أبدًا (النسخة الجديدة تُرفع كمستند جديد مرتبط بالسابق).

---

## 8) ربط الموقع بالمشروع (`assets/js/config.js`)

افتح الملف `assets/js/config.js` وعدّل القيمتين فقط:
```js
window.MARSA_CONFIG = {
  supabaseUrl: 'https://xxxxxxxxxxxx.supabase.co',   // Project URL
  supabaseAnonKey: 'eyJ...أو sb_publishable_...',     // المفتاح العام anon / publishable فقط
  orgSlug: 'blue-sea',
  environment: 'staging'
};
```
- عند ترك القيمتين فارغتين يعمل الموقع في **وضع نسخة العرض** (بيانات محلية على الجهاز فقط).
- عند تعبئتهما يظهر في أعلى كل صفحة الشريط: «بيئة تجريبية (Staging) — البيانات للاختبار فقط»، ويتغير نص الخصوصية في الفوتر تلقائيًا.

---

## 9) رفع الموقع على خادمك ونطاقك

الموقع ملفات ثابتة (HTML/CSS/JS) ولا يحتاج إلى PHP أو Node على الخادم.

1. يفضَّل نطاق فرعي مستقل للتجربة مثل `staging.your-domain.sa`، وليس النطاق الرئيسي.
2. ارفع **محتوى** مجلد `marsa-website` كاملًا (الملفات والمجلد `assets`) إلى مجلد الموقع على الخادم، وعادةً هو `public_html` (أو مجلد النطاق الفرعي)، بإحدى الطريقتين:
   - **cPanel ← File Manager:** ضغط المجلد بصيغة ZIP على جهازك، ثم Upload، ثم Extract داخل المجلد الصحيح.
   - **SFTP** (مثل FileZilla): اتصل بالمنفذ 22 باستخدام SFTP وليس FTP العادي، ثم انسخ الملفات.
3. **لا ترفع** المجلدات `.git` و`supabase` و`docs` إلى الخادم العام. هي للمطوّرين فقط، وليست سرية لكن لا حاجة لها.
4. **HTTPS إلزامي:** فعّل شهادة SSL (مثل AutoSSL أو Let's Encrypt من cPanel)، وحوّل كل الزيارات من `http` إلى `https`. تسجيل الدخول لن يعمل بشكل آمن دون HTTPS.
5. **التخزين المؤقت (Cache):**
   - ملفات `*.html` و`assets/js/config.js`: بلا تخزين طويل (`Cache-Control: no-cache`) حتى تظهر التحديثات فورًا.
   - ملفات `assets/css` و`assets/js` الأخرى: تخزين قصير (ساعة مثلًا)، لأن أسماءها لا تتغير مع كل إصدار.
   - الصور والأيقونات `assets/img`: تخزين أطول (أسبوع أو أكثر).
   - مثال لملف `.htaccess` على خوادم Apache:
     ```apache
     <IfModule mod_headers.c>
       <FilesMatch "\.(html)$">
         Header set Cache-Control "no-cache"
       </FilesMatch>
       <Files "config.js">
         Header set Cache-Control "no-cache"
       </Files>
       <FilesMatch "\.(png|webp|jpg|svg|ico)$">
         Header set Cache-Control "public, max-age=604800"
       </FilesMatch>
       Header set X-Content-Type-Options "nosniff"
       Header set Referrer-Policy "strict-origin-when-cross-origin"
       Header set X-Frame-Options "SAMEORIGIN"
     </IfModule>
     ```
6. بعد الرفع أضف عنوان الموقع الفعلي في إعدادات Auth (الخطوة 6) إن لم تكن أضفته.
7. **حماية البيئة التجريبية (موصى به):** امنع محركات البحث من فهرستها بإضافة ملف `robots.txt` فيه `User-agent: *` و`Disallow: /`، أو احمِ النطاق الفرعي بكلمة مرور من cPanel (Directory Privacy).

---

## 10) قائمة الاختبار بعد التشغيل

- [ ] الصفحة الرئيسية تفتح عبر `https` ويظهر شريط «بيئة تجريبية (Staging)».
- [ ] لا تظهر أخطاء في أدوات المطوّر (Console) في المتصفح.
- [ ] **طلب تخليص** (`request.html`) كزائر: يظهر رقم مرجعي `REQ-…` ورمز تتبع يُعرض مرة واحدة. احفظهما.
- [ ] **التتبع** (`tracking.html`) بالرقم المرجعي والرمز: تظهر حالة الطلب. وبرمز خاطئ: تظهر رسالة «لم نعثر على بيانات مطابقة».
- [ ] **تواصل معنا** يُرسل الرسالة، وتظهر عند المدير في صندوق الرسائل.
- [ ] دخول `admin@example.com` من «دخول الموظفين» ← يفتح `admin.html`، ويظهر الطلب الجديد في قائمة الطلبات.
- [ ] تحويل الطلب إلى معاملة، وتغيير حالتها خطوة واحدة، وإضافة ملاحظة، ورفع مستند PDF.
- [ ] دخول `clearance.jed@example.com`: يرى معاملات فرع جدة فقط ولا يرى معاملة الدمام.
- [ ] دخول `client1@example.com` من «دخول العملاء» ← يفتح `portal.html` ويرى معاملات شركته فقط، ولا يرى الملاحظات الداخلية.
- [ ] الحاوية لا تُعدّ «مُرجعة» إلا بمستند «إيصال استلام فارغ» مؤكد.
- [ ] الرفع الجماعي (`bulk-upload.html`) يعمل للموظف فقط، ورفع الملف نفسه مرة ثانية يُرفض كتكرار.
- [ ] «نسيت كلمة المرور» بحساب بريد حقيقي للاختبار تصل رسالته ويعيدك الرابط إلى `login.html?mode=reset`.
- [ ] تسجيل الخروج يعمل، ورابط «بوابتي» يظهر في الشريط العلوي فقط عند تسجيل الدخول.
- [ ] في Supabase ← **Advisors** (Security Advisor): لا توجد تنبيهات حرجة.

---

## 11) التراجع (Rollback)

**الموقع:**
- النسخة الأصلية (نسخة العرض المحلية) محفوظة في فرع Git الرئيسي `main`. لإرجاعها على جهازك:
  ```bash
  cd ~/Downloads/marsa-website
  git status                 # تأكد من حفظ (commit) أي تغييرات تريد الاحتفاظ بها
  git switch main
  ```
  ثم ارفع الملفات مرة أخرى إلى الخادم.
- قبل كل رفع جديد إلى الخادم، احفظ نسخة احتياطية من مجلد الموقع الحالي على الخادم (مثل `public_html_backup_2026-10-31`). للتراجع: أعد تسمية المجلد الاحتياطي أو انسخ محتواه مكان الحالي.
- **أسرع تراجع دون حذف شيء:** أفرغ القيمتين `supabaseUrl` و`supabaseAnonKey` في `assets/js/config.js` على الخادم، فيعود الموقع فورًا إلى وضع نسخة العرض المحلية.

**قاعدة البيانات (التجريبية):**
- لأنها بيانات اختبار فقط، أبسط تراجع هو إنشاء مشروع Supabase جديد وتشغيل الخطوات 3 إلى 8 مرة أخرى، ثم حذف المشروع القديم بعد التأكد.
- لا تحذف جداول يدويًا من مشروع فيه بيانات تحتاجها. اطلب من المطوّر ملف migration تصحيحيًا جديدًا بدل تعديل الملفات القديمة.

---

## ملخص ما يجب على المالك فعله
1. إنشاء حساب ومشروع Supabase باسم `marsa-staging` وفي أقرب منطقة، مع تفعيل MFA.
2. تشغيل ملفات migrations السبعة بالترتيب، ثم `seed.sql`.
3. إنشاء مستخدمي الاختبار وتشغيل مقطع ربط الأدوار.
4. ضبط Site URL وRedirect URLs وتأكيد البريد.
5. التحقق من أن المخزن `documents` خاص.
6. تعبئة `assets/js/config.js` بالعنوان والمفتاح العام فقط.
7. رفع الملفات إلى النطاق الفرعي التجريبي مع HTTPS.
8. تنفيذ قائمة الاختبار.
9. اتخاذ القرارات المفتوحة في القسم 13 من `docs/online/ARCHITECTURE.md` (مشاركة العملاء بين الفروع، التتبع العام، شرط إرجاع الفارغ، رفع الزوار للملفات، التسجيل الذاتي، CAPTCHA أو حد لعنوان IP)، ومراجعة PDPL مع مختص قبل أي إنتاج.
