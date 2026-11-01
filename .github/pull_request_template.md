<!-- مرسى | MARSA — قالب طلب الدمج. اكتب بالعربية أو الإنجليزية. احذف ما لا ينطبق. -->

## ماذا يغيّر هذا الطلب؟ / What does this change?

<!-- جملتان أو ثلاث. اذكر خطوة الخطة (مثل G2.4) إن وُجدت. -->

## نوع التغيير
- [ ] واجهة (HTML / CSS / JS)
- [ ] ترحيل قاعدة بيانات (`supabase/migrations/*.sql`)
- [ ] دوال RPC / سياسات RLS / صلاحيات
- [ ] توثيق فقط
- [ ] سكربتات تشغيل / نسخ احتياطي

## قائمة التحقق
- [ ] الفرع الهدف `online-staging` (ليس `main` مباشرة).
- [ ] لا أسرار في الطلب: لا `service_role` / `sb_secret_…`، لا كلمة مرور قاعدة البيانات، لا `SUPABASE_DB_URL`، لا كلمة مرور الحماية (Basic Auth) لموقع Hostinger.
- [ ] `assets/js/config.js` يحتوي المفتاح العام (anon / publishable) فقط، أو لم يتغير.
- [ ] بيانات الاختبار وهمية فقط (`@example.com`، أرقام اختبار).

### إن كان فيه ترحيل قاعدة بيانات
- [ ] ملف جديد باسم `supabase/migrations/YYYYMMDDHHMMSS_<name>.sql` (لم أعدّل ترحيلًا طُبِّق سابقًا).
- [ ] قابل لإعادة التشغيل (`IF NOT EXISTS` / `OR REPLACE` / `DROP … IF EXISTS`) ويُدرج صفّه في `public.schema_versions`.
- [ ] كل جدول جديد: RLS مفعّل، `REVOKE ALL … FROM anon`، مُضاف إلى فهرس `rls-tests.js`.
- [ ] كل دالة `public.*`: `SECURITY DEFINER SET search_path = ''`، فحص `auth.uid()`، أخطاء عبر `app.fail('MRS_…')`، `REVOKE` ثم `GRANT` صريح.
- [ ] أُخذت نسخة احتياطية من Staging قبل التطبيق (`scripts/backup-staging.sh`).

### إن كان فيه واجهة
- [ ] `node --check` ناجح لكل ملف JS معدَّل.
- [ ] جُرِّب في وضع العرض (config فارغ) ووضع Staging، وبالعربية (RTL) والإنجليزية (LTR)، وعلى عرض الجوال.

## الاختبارات / Tests

```text
cd /tmp/pgtest && NODE_PATH=/tmp/pgtest/node_modules node <repo>/supabase/tests/rls-tests.js --quiet
# النتيجة: … passed, … failed, … warnings
cd /tmp/pgtest && NODE_PATH=/tmp/pgtest/node_modules node <repo>/supabase/tests/g2-tests.js --quiet
cd /tmp/pgtest && NODE_PATH=/tmp/pgtest/node_modules node <repo>/supabase/tests/restore-drill.js --quiet
```

## ملاحظات للمراجع / قرارات مفتوحة للمالك
