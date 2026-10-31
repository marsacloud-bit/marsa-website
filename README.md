# مرسى | MARSA — موقع التخليص الجمركي والشحن أونلاين

موقع ثابت (HTML / CSS / JavaScript) لمنصة سعودية للتخليص الجمركي والشحن أونلاين في المملكة العربية السعودية، يعمل بالكامل على جهازك. لا يوجد خادم أو قاعدة بيانات، ولا يتم رفع أو إرسال أي بيانات خارج جهازك.

> **نسخة عرض تجريبية:** البيانات والأرقام والأمثلة في الموقع توضيحية، ولا يُرسل أي نموذج إلى أي جهة. يظهر شريط تنبيه بذلك أسفل الهيدر في كل الصفحات (يمكن إخفاؤه للجلسة الحالية فقط).

## طريقة التشغيل

1. **أسهل طريقة:** افتح المجلد وانقر مرتين على `index.html`. سيفتح الموقع في المتصفح مباشرة.
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
├── tracking.html       تتبع الشحنة
├── request.html        اطلب تخليص (نموذج متعدد الخطوات + رفع المستندات)
├── about.html          من نحن (طريقة العمل، لماذا مرسى، الأسئلة الشائعة)
├── contact.html        تواصل معنا
├── bulk-upload.html    الرفع الجماعي للبيانات (Excel / CSV)
├── login.html          دخول العملاء ودخول الموظفين («قريبًا» — بلا أي حقول لبيانات الدخول)
├── assets/
│   ├── css/style.css        التنسيق المشترك لكل الصفحات (الألوان، الأزرار، الهيدر، الفوتر…)
│   ├── css/pages/*.css      تنسيقات خاصة بكل صفحة
│   ├── js/main.js           السلوك المشترك (القائمة، الحركة، الإشعارات، الأكورديون…)
│   ├── js/<page>.js         سكربت كل صفحة
│   ├── js/xlsx-lite.js      قارئ وكاتب ملفات Excel ‏(.xlsx) وCSV بدون مكتبات خارجية
│   └── img/                 اللوجو والأيقونة (favicon)
└── docs/partials.md    مرجع للمطورين: كود الهيدر والفوتر المشترك
```

## الرفع الجماعي للبيانات (Excel / CSV)

صفحة `bulk-upload.html` تتيح إدخال عدة شحنات دفعة واحدة بدل تعبئة نموذج الطلب لكل شحنة:

- **الصيغ المدعومة:** Excel ‏`.xlsx`، و`.csv` و`.tsv` و`.txt` (ترميز UTF-8، والفاصل يُكتشف تلقائيًا)، و`.json`.
- **عدة ملفات وعدة أوراق عمل** في المرة الواحدة، مع مطابقة تلقائية لأسماء الأعمدة (عربي أو إنجليزي) وإمكانية تعديلها يدويًا.
- **مراجعة قبل الإرسال:** التحقق من كل صف، وتعديل الخلايا مباشرة، وحذف الصفوف، وتصفية الصفوف التي بها أخطاء وتصديرها.
- **نماذج جاهزة** للتنزيل بصيغة Excel أو CSV.
- كل صف صالح يتحول إلى طلب تخليص برقم مرجعي يُحفظ في `marsa_requests` ويظهر في صفحة التتبع. بيانات كل دفعة تُحفظ في `marsa_bulk_batches`.
- تتم القراءة داخل المتصفح بالكامل عبر `assets/js/xlsx-lite.js`، ولا يُرفع أي ملف إلى أي خادم.

> **ملفات Excel القديمة `.xls` غير مدعومة.** افتح الملف في Excel أو LibreOffice واحفظه بصيغة **‎.xlsx** أو **CSV ‏(UTF-8)** ثم ارفعه.

## أين تُحفظ البيانات؟

النماذج (طلب التخليص، رسائل التواصل، الحسابات) تُحفظ في **localStorage** داخل متصفحك فقط، ولا تُرسل لأي مكان:

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

**لمسح البيانات:** اضغط زر «مسح بياناتي من هذا الجهاز» في أسفل أي صفحة (يطلب التأكيد ثم يحذف كل مفاتيح localStorage التي تبدأ بـ `marsa_`)، أو من أدوات المطور في المتصفح (Application ← Local Storage).

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

- صفحة `login.html` تعريفية فقط: بوابة العملاء وبوابة الموظفين ستعملان بتسجيل دخول آمن في المنصة الفعلية، وروابطهما في الشريط العلوي والقائمة الجانبية والفوتر.
- الأرقام في الحاسبة وبيانات التتبع **تقديرية وللعرض فقط**، والموقع غير تابع لأي جهة حكومية.
- ضريبة القيمة المضافة محسوبة بنسبة 15% على (القيمة الجمركية CIF + الرسوم الجمركية + الرسوم الأخرى الخاضعة للضريبة)، وفق أنظمة هيئة الزكاة والضريبة والجمارك. الموقع يذكر منصة فسح ومنصة سابر للتوضيح فقط.

---

## English (short)

**Marsa** is a static, local-only website for a Saudi online customs-clearance platform (Arabic, RTL). Amounts are in SAR (`Marsa.formatSAR`), VAT is 15%, customs platform references are FASAH / SABER.

- **Open:** double-click `index.html`, or run `python3 -m http.server 8000 --bind 127.0.0.1` inside the folder and visit `http://127.0.0.1:8000`.
- **No backend, no tracking:** form submissions stay in your browser's `localStorage` (keys listed above). The only external request is the Google Fonts stylesheet (Cairo). It falls back to system fonts when offline.
- **Bulk upload:** `bulk-upload.html` turns rows from one or more Excel (`.xlsx`), CSV/TSV or JSON files into clearance requests (saved to `marsa_requests`, visible on the tracking page). Parsing happens in the browser via `assets/js/xlsx-lite.js`. Legacy `.xls` files are not supported: save them as `.xlsx` or CSV first.
- **Demo only:** a dismissible banner on every page says so; `login.html` is a «coming soon» page with no credential fields; the footer button «مسح بياناتي من هذا الجهاز» removes every `marsa_*` localStorage key.
- **Structure:** 9 pages at the root. Shared styles are in `assets/css/style.css`, page styles in `assets/css/pages/`, shared JS in `assets/js/main.js` and page JS in `assets/js/<page>.js`. `docs/partials.md` holds the shared header/footer markup.
- **Contact info:** find and replace the placeholders listed above across all files.
- **Colors:** edit the CSS custom properties in `:root` at the top of `assets/css/style.css`.
