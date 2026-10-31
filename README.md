# مرسى | MARSA — موقع التخليص الجمركي والشحن أونلاين

موقع ثابت (HTML / CSS / JavaScript، بلا خطوة بناء) لمنصة سعودية للتخليص الجمركي والشحن أونلاين في المملكة العربية السعودية. يعمل بأحد وضعين يحددهما الملف `assets/js/config.js`:

| الوضع | متى | أين تُحفظ البيانات | ما يظهر |
|---|---|---|---|
| **نسخة العرض (Demo)** | `supabaseUrl` و`supabaseAnonKey` فارغان (الافتراضي) | التخزين المحلي (localStorage) في متصفحك فقط، ولا يُرسل شيء إلى أي خادم | شريط «نسخة عرض تجريبية»، وصفحات الدخول والبوابة ولوحة الموظفين تعرض تنبيه «تعمل في النسخة المتصلة فقط» |
| **بيئة تجريبية متصلة (Staging)** | القيمتان مُعبّأتان بعنوان مشروع Supabase ومفتاحه العام | Supabase: ‏PostgreSQL + Auth + RLS + Storage، ببيانات اختبار فقط | شريط «بيئة تجريبية (Staging) — البيانات للاختبار فقط»، وتسجيل دخول للعملاء والموظفين، وبوابة العميل ولوحة الموظفين |

> **ليست بيئة إنتاج.** البيئة المتصلة تجريبية ببيانات وهمية فقط. خطوات تجهيزها بالتفصيل (بالعربية) في **[`docs/online/SETUP_AR.md`](docs/online/SETUP_AR.md)**، والمعمارية وقرارات المالك المفتوحة في [`docs/online/ARCHITECTURE.md`](docs/online/ARCHITECTURE.md).
>
> لا يوضع مفتاح `service_role` / secret في أي ملف من ملفات الموقع أبدًا. المفتاح العام (anon / publishable) فقط، والحماية تقوم بها سياسات RLS في قاعدة البيانات.

## طريقة التشغيل

1. **أسهل طريقة (نسخة العرض فقط):** افتح المجلد وانقر مرتين على `index.html`. سيفتح الموقع في المتصفح مباشرة. وضع Staging يحتاج إلى فتح الموقع عبر `http://` أو `https://` (خادم محلي أو خادمك) لأن تسجيل الدخول لا يعمل من `file://`.
2. **عبر خادم محلي (اختياري):** افتح الطرفية (Terminal) داخل المجلد ثم شغّل:
   ```bash
   cd ~/Downloads/marsa-website
   python3 -m http.server 8000 --bind 127.0.0.1
   ```
   ثم افتح `http://127.0.0.1:8000` في المتصفح. أوقف الخادم بالضغط على `Ctrl + C`.

> المورد الخارجي الوحيد هو خط **Cairo** من Google Fonts. إذا لم يكن هناك اتصال بالإنترنت، سيستخدم الموقع خطوط النظام تلقائيًا ويظل يعمل بشكل طبيعي.

## هيكل الملفات

```
marsa-website/
├── index.html          الرئيسية
├── services.html       خدماتنا
├── calculator.html     حاسبة الرسوم الجمركية
├── tracking.html       تتبع الشحنة (أونلاين: الرقم المرجعي + رمز التتبع)
├── request.html        اطلب تخليص (نموذج متعدد الخطوات؛ أونلاين يعطي رقمًا مرجعيًا ورمز تتبع)
├── about.html          من نحن (طريقة العمل، لماذا مرسى، الأسئلة الشائعة)
├── contact.html        تواصل معنا
├── bulk-upload.html    الرفع الجماعي للبيانات (Excel / CSV) — أونلاين للموظفين فقط
├── login.html          دخول العملاء ودخول الموظفين، إنشاء حساب عميل، استعادة كلمة المرور
├── portal.html         بوابة العميل: الطلبات والمعاملات والحاويات والمستندات والملف الشخصي
├── admin.html          لوحة الموظفين: الطلبات، المعاملات، العملاء، الرسائل، دفعات الاستيراد، الأعضاء (حسب الدور)
├── assets/
│   ├── css/style.css        التنسيق المشترك لكل الصفحات
│   ├── css/pages/*.css      تنسيقات خاصة بكل صفحة
│   ├── js/config.js         إعداد الوضع (فارغ = نسخة عرض؛ مُعبّأ = Staging). يُحمَّل في كل الصفحات أولًا
│   ├── js/main.js           السلوك المشترك (القائمة، الإشعارات، شريط الوضع، نص الخصوصية، رابط «بوابتي»…)
│   ├── js/supa.js           طبقة الاتصال window.MarsaApi (تحمّل supabase-js 2.45.4 فقط عند تعبئة الإعداد)
│   ├── js/<page>.js         سكربت كل صفحة (auth.js لصفحة الدخول، portal.js، admin.js…)
│   ├── js/xlsx-lite.js      قارئ وكاتب ملفات Excel ‏(.xlsx) وCSV بدون مكتبات خارجية
│   └── img/                 اللوجو والأيقونة (favicon)
├── supabase/
│   ├── migrations/*.sql     مخطط قاعدة البيانات وRLS والدوال والتخزين (تُشغَّل بالترتيب)
│   ├── seed.sql             بيانات اختبار وهمية + مقطع ربط الأدوار
│   └── tests/               shim.sql (بديل كائنات Supabase للاختبار المحلي) + rls-tests.js
└── docs/
    ├── partials.md          مرجع للمطورين: الهيدر والفوتر المشترك وترتيب السكربتات
    └── online/              ARCHITECTURE.md (المعمارية) و SETUP_AR.md (دليل التشغيل للمالك)
```

**ترتيب السكربتات:** `config.js → main.js → supa.js → <page>.js` (كلها `defer`). الصفحات الخفيفة (الرئيسية، الخدمات، الحاسبة، من نحن) تحمّل `config.js` و`main.js` فقط، ولا تتصل بأي خادم. رابط «بوابتي» في الشريط العلوي والقائمة الجانبية يظهر فقط للمستخدم المسجّل دخوله في الصفحات التي تحمّل `supa.js`.

## اختبارات قاعدة البيانات (محلية)

تعمل على Postgres 16 داخل الذاكرة عبر [PGlite](https://github.com/electric-sql/pglite)، ولا تتصل بـ Supabase أبدًا. تحمّل `supabase/tests/shim.sql` ثم كل ملفات migrations ثم `seed.sql`، وتختبر العزل بين المؤسسات والعملاء والفروع، والدوال العامة، وسجل الأحداث غير القابل للتعديل، والتخزين:

```bash
mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm i @electric-sql/pglite     # مرة واحدة، خارج مجلد المشروع
NODE_PATH=/tmp/pgtest/node_modules node ~/Downloads/marsa-website/supabase/tests/rls-tests.js ~/Downloads/marsa-website
#   --strict  لاعتبار التحذيرات (WARN) فشلًا      --quiet  لعرض الفشل والتحذيرات فقط
```
النتيجة المتوقعة: `OK — 490 passed, 0 failed, 2 warnings` (التحذيران قراران مفتوحان للمالك).

## الرفع الجماعي للبيانات (Excel / CSV)

صفحة `bulk-upload.html` تتيح إدخال عدة شحنات دفعة واحدة بدل تعبئة نموذج الطلب لكل شحنة:

- **الصيغ المدعومة:** Excel ‏`.xlsx`، و`.csv` و`.tsv` و`.txt` (ترميز UTF-8، والفاصل يُكتشف تلقائيًا)، و`.json`.
- **عدة ملفات وعدة أوراق عمل** في المرة الواحدة، مع مطابقة تلقائية لأسماء الأعمدة (عربي أو إنجليزي) وإمكانية تعديلها يدويًا.
- **مراجعة قبل الإرسال:** التحقق من كل صف، وتعديل الخلايا مباشرة، وحذف الصفوف، وتصفية الصفوف التي بها أخطاء وتصديرها.
- **نماذج جاهزة** للتنزيل بصيغة Excel أو CSV.
- **في نسخة العرض:** كل صف صالح يتحول إلى طلب تخليص برقم مرجعي يُحفظ في `marsa_requests` ويظهر في صفحة التتبع. بيانات كل دفعة تُحفظ في `marsa_bulk_batches`.
- **في وضع Staging:** الصفحة للموظفين المسجّلين فقط. كل ملف يصبح دفعة استيراد (`import_batches`) ببصمة SHA-256، ولكل صف معرّف مصدر فريد يمنع التكرار، ورفع الملف نفسه مرة ثانية يُرفض. الاعتماد النهائي يتم عبر الدالة `import_commit`.
- تتم قراءة الملف داخل المتصفح عبر `assets/js/xlsx-lite.js`؛ في نسخة العرض لا يُرفع أي شيء، وفي Staging تُرسل الصفوف المقروءة فقط إلى قاعدة البيانات.

> **ملفات Excel القديمة `.xls` غير مدعومة.** افتح الملف في Excel أو LibreOffice واحفظه بصيغة **‎.xlsx** أو **CSV ‏(UTF-8)** ثم ارفعه.

## أين تُحفظ البيانات؟

**في وضع Staging:** طلبات التخليص ورسائل التواصل والرفع الجماعي والحسابات والمستندات تُحفظ في قاعدة بيانات Supabase (اتصال HTTPS، عزل بسياسات RLS). تبقى في المتصفح فقط الحاسبة والمسودات وجلسة الدخول (المفتاح `marsa_auth`).

**في نسخة العرض:** النماذج (طلب التخليص، رسائل التواصل، الحسابات) تُحفظ في **localStorage** داخل متصفحك فقط، ولا تُرسل لأي مكان:

| المفتاح | المحتوى |
|---|---|
| `marsa_requests` | طلبات التخليص (وتظهر في صفحة التتبع بحالة «تم الاستلام») |
| `marsa_calc_draft` | آخر حساب أُرسل من الحاسبة إلى نموذج الطلب |
| `marsa_calc` | آخر مدخلات الحاسبة |
| `marsa_calculations` | الحسابات المحفوظة |
| `marsa_messages` / `marsa_contacts` | رسائل صفحة «تواصل معنا» |
| `marsa_doc_checklist` | قائمة المستندات في صفحة الخدمات |
| `marsa_bulk_batches` | سجل دفعات الرفع الجماعي (الملفات وعدد الصفوف والأرقام المرجعية) |

البيانات تُخزَّن دون تشفير، فلا تُدخل بيانات حقيقية حساسة في نسخة العرض.

**لمسح البيانات:** اضغط زر «مسح بياناتي من هذا الجهاز» في أسفل أي صفحة (يطلب التأكيد ثم يحذف كل مفاتيح localStorage التي تبدأ بـ `marsa_`؛ في وضع Staging يسجّل خروجك من هذا الجهاز ولا يحذف ما أُرسل إلى الخادم)، أو من أدوات المطور في المتصفح (Application ← Local Storage).

## تعديل بيانات التواصل

بيانات التواصل الحالية افتراضية (للعرض فقط): `+966 12 614 3270`، واتساب `+966 55 482 1937`، `info@marsa-sa.com`، `طريق الملك عبدالعزيز، حي الحمراء – جدة`.
لتغييرها استخدم «البحث والاستبدال في كل الملفات» في محرر الأكواد (مثل VS Code) على هذه القيم:

- `+966 12 614 3270` (الرقم المعروض) و `+966126143270` (روابط `tel:`)
- `+966 55 482 1937` و `966554821937` (رابط WhatsApp: `https://wa.me/966554821937`)
- `info@marsa-sa.com`
- `طريق الملك عبدالعزيز، حي الحمراء – جدة` (المقر الرئيسي)
- الفروع: `طريق الملك فهد، حي الشاطئ – الدمام` (`+966 13 832 5640`)، `طريق العليا، حي العليا – الرياض` (`+966 11 465 2280`)، `حي الفناتير – الجبيل الصناعية` (`+966 13 341 7720`)
- مواعيد العمل: `الأحد – الخميس: 8 ص – 5 م`

## العملة والضريبة

- كل المبالغ بـ **الريال السعودي (ر.س / SAR)**. في الجافاسكربت استخدم `Marsa.formatSAR(n)` → `"12,345.00 ر.س"` (حُذف الاسم البديل القديم `formatEGP`).
- أسعار الصرف الافتراضية في الحاسبة: USD 3.75، EUR 4.05، CNY 0.52، AED 1.02 (قابلة للتعديل).

## تعديل الألوان

كل الألوان معرّفة كمتغيرات في أول `assets/css/style.css` داخل `:root`:

```css
--navy: #0B3A6E;  --navy-dark: #072A52;  --blue: #1673B8;
--teal: #14A3A8;  --aqua: #3FC1D0;       --bg: #F4F8FB;   --text: #0F1E33;
```

غيّر القيم هناك وستتحدث في الموقع كله.

## ملاحظات

- صفحة `login.html` تعمل بتسجيل دخول حقيقي في وضع Staging فقط (Supabase Auth). في نسخة العرض تعرض تنبيهًا بخطوات الإعداد ولا تحتوي حقولًا لبيانات الدخول. العميل يُوجَّه إلى `portal.html` والموظف إلى `admin.html`، والصلاحيات تُفرض في قاعدة البيانات وليس بإخفاء الأزرار فقط.
- المحاسبة والفوترة (دفتره، ZATCA) خارج نطاق هذه المرحلة؛ الحالة المالية للمعاملة حقل منفصل عن الحالة التشغيلية فقط.
- الأرقام في الحاسبة وبيانات التتبع **تقديرية وللعرض فقط**، والموقع غير تابع لأي جهة حكومية.
- ضريبة القيمة المضافة محسوبة بنسبة 15% على (القيمة الجمركية CIF + الرسوم الجمركية + الرسوم الأخرى الخاضعة للضريبة)، وفق أنظمة هيئة الزكاة والضريبة والجمارك. الموقع يذكر منصة فسح ومنصة سابر للتوضيح فقط.

---

## English (short)

**Marsa** is a static, no-build website for a Saudi online customs-clearance platform (Arabic, RTL). Amounts are in SAR (`Marsa.formatSAR`), VAT is 15%, customs platform references are FASAH / SABER.

- **Two modes** (set in `assets/js/config.js`): empty `supabaseUrl`/`supabaseAnonKey` → local **demo** (localStorage only, demo banner). Filled → online **staging** on Supabase (Postgres + Auth + RLS + private Storage, test data only, banner «بيئة تجريبية (Staging) — البيانات للاختبار فقط»). Never put a service_role/secret key in the frontend.
- **Pages:** 11 at the root, including `login.html` (client/staff sign-in, sign-up, reset), `portal.html` (client portal) and `admin.html` (role-based staff console).
- **Scripts:** `config.js → main.js → supa.js → <page>.js`, all `defer`. `supa.js` exposes `window.MarsaApi` and loads supabase-js 2.45.4 from jsDelivr only when configured. Light pages load only `config.js` + `main.js`.
- **Database:** `supabase/migrations/*.sql` (run in order), `supabase/seed.sql` (fictional data). Setup guide (Arabic): `docs/online/SETUP_AR.md`; architecture: `docs/online/ARCHITECTURE.md`.
- **Tests:** `NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/rls-tests.js /path/to/marsa-website` (PGlite, local only; install `@electric-sql/pglite` in `/tmp/pgtest` once).
- **Open:** run `python3 -m http.server 8000 --bind 127.0.0.1` inside the folder and visit `http://127.0.0.1:8000` (double-clicking `index.html` works for demo mode).
- **Shared markup:** `docs/partials.md`. **Colors:** CSS custom properties in `:root` of `assets/css/style.css`.
