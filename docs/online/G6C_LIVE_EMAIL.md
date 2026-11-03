# البريد الحقيقي (IMAP + SMTP على Hostinger) — دليل التشغيل للمالك (G6c، Staging)

> **النطاق:** بيئة Staging. قناة بريد **واحدة** حقيقية لمؤسسة واحدة، بجانب المحاكاة (G6b) التي تبقى كما هي.
> ملف الترحيل: `supabase/migrations/20261110000100_g6c_live_email.sql`. الدالة: `supabase/functions/inbox-sync/` (9 ملفات).
> **كل الخطوات هنا ينفّذها المالك بنفسه.** لا تُكتب كلمة مرور في أي ملف أو جدول أو رسالة؛ القيم تُدخل فقط في لوحة Supabase ← Edge Functions ← Secrets.

## 1) ما الذي يعمل؟

- **الاستلام:** IMAP على المنفذ 993 (TLS مباشر) بقراءة فقط: `EXAMINE INBOX` و`BODY.PEEK`، فلا تتغير حالة «مقروء» في بريدك. التقدّم يُحفظ بمؤشر `v1:<UIDVALIDITY>:<آخر UID>`، والتكرار يُمنع بمعرّف الرسالة.
- **الإرسال:** SMTP على المنفذ 465 فقط، وعبر مهمة `send` الموجودة (موافقة شخص ثانٍ كما في G6b). المنفذ 587 / STARTTLS **مرفوض في الكود** (محجوب على Supabase).
- **الارتدادات (DSN):** تُقرأ من INBOX بمؤشر خاص، ولا تُعتمد إلا بعد ضبط `MARSA_EMAIL_AUTHSERV_ID` و`MARSA_EMAIL_DSN_DKIM_DOMAIN` (البند 5).
- **الاستجابة الضائعة:** إن انقطع الاتصال بعد إرسال الرسالة، تصبح الحالة `unknown`، ويبحث النظام عنها في مجلد Sent بمعرّف الرسالة. إن لم يجدها **لا يعيد الإرسال**؛ القرار لإنسان.
- **لا ردّ تلقائي** ولا مرفقات صادرة في هذه النسخة (الإرسال بمرفق يُرفض بـ `attachments_unsupported`).
- وضع `live_pending` لم يتغير: كل مهمة تفشل بـ `not_configured` دون أي اتصال.

## 2) الأسرار المطلوبة (الأسماء فقط)

Dashboard ← Edge Functions ← **Secrets** (تُقرأ في `index.ts` فقط، لا تُسجَّل ولا تُعاد في أي رد):

| الاسم | المحتوى |
|---|---|
| `MARSA_EMAIL_LIVE_CHANNEL` | معرّف (UUID) قناة البريد الحقيقية الوحيدة (البند 4) |
| `MARSA_EMAIL_FROM_ADDRESS` | عنوان القناة (مثل `ops@marsacloud.com`)، ويجب أن يطابق عنوان القناة في مرسى حرفيًا |
| `MARSA_EMAIL_IMAP_HOST` | خادم IMAP (لدى Hostinger: `imap.hostinger.com`) |
| `MARSA_EMAIL_IMAP_USER` / `MARSA_EMAIL_IMAP_PASSWORD` | حساب صندوق البريد الذي يُقرأ منه |
| `MARSA_EMAIL_SMTP_HOST` | خادم SMTP (لدى Hostinger: `smtp.hostinger.com`) |
| `MARSA_EMAIL_SMTP_USER` / `MARSA_EMAIL_SMTP_PASSWORD` | حساب الإرسال (مثل صندوق `no-reply@`) |

اختيارية:

| الاسم | الافتراضي / الملاحظة |
|---|---|
| `MARSA_EMAIL_IMAP_PORT` / `MARSA_EMAIL_SMTP_PORT` | 993 / 465 فقط؛ أي قيمة أخرى تُرفض (`imap_port` / `smtp_port`) |
| `MARSA_EMAIL_FROM_NAME` | اسم المرسِل الظاهر |
| `MARSA_EMAIL_MSGID_DOMAIN` | نطاق معرّف الرسالة (افتراضيًا نطاق المرسِل) |
| `MARSA_EMAIL_IMAP_SENT_FOLDER` | اسم مجلد Sent إن لم يعلنه الخادم |
| `MARSA_EMAIL_POLL_BATCH` | 1–50، الافتراضي 10 رسائل لكل دورة |
| `MARSA_EMAIL_APPEND_SENT` | `0` يوقف حفظ نسخة في Sent (إن ظهرت نسختان) |
| `MARSA_EMAIL_AUTHSERV_ID` / `MARSA_EMAIL_DSN_DKIM_DOMAIN` | للارتدادات والتحقق من المرسِل (البند 5) |
| `MARSA_ENV` / `MARSA_EMAIL_FAULT` | للاختبار فقط؛ **اتركهما فارغين** |
| `MARSA_INBOX_ALLOW_MOCK` | **اتركه فارغًا** في الحساب الحقيقي |

## 3) الترحيل

1. خذ نسخة احتياطية ([`BACKUP_RESTORE_AR.md`](BACKUP_RESTORE_AR.md)).
2. تحقق: `SELECT public.health_check();` يعيد `20261109000100` (MFA مطبّق).
3. الصق **كامل** `supabase/migrations/20261110000100_g6c_live_email.sql` في SQL Editor وشغّله. يرفض العمل إن لم يكن MFA مطبّقًا، وإعادة تشغيله آمنة.
4. تحقق: `health_check()` يعيد `20261110000100` (أو أحدث إن طبّقت ما بعده).
5. إن أعدت لصق ملف G6b (`20261107000100`) لأي سبب، الصق ملف G6c بعده مباشرة.

## 4) إنشاء القناة (أو تحويلها إلى live)

الواجهة لا تعرض خيار `live` بعد، لذلك تُنشأ القناة من SQL Editor باسم مدير المؤسسة. **المدير يحتاج جلسة `aal2`**، لذا يُذكر ذلك في المطالبات:

```sql
-- 1) انتحال جلسة المدير داخل هذا التشغيل فقط (ضع معرّف حسابك ومعرّف المؤسسة)
select set_config('request.jwt.claims',
  json_build_object('sub', '<ADMIN_USER_UUID>', 'role', 'authenticated', 'aal', 'aal2')::text, false);

-- 2) قناة جديدة بوضع live (بلا استلام ولا إرسال بعد)
select public.save_msg_channel('<ORG_UUID>'::uuid, jsonb_build_object(
  'kind', 'email', 'name', 'بريد العمليات', 'address', 'ops@marsacloud.com', 'mode', 'live',
  'provider_terms_ack', true, 'ingest_enabled', false, 'send_enabled', false));
-- لقناة موجودة: أضف 'id', '<CHANNEL_UUID>' واكتفِ بـ 'mode', 'live'
```

- انسخ `id` القناة من النتيجة وضعه في السر `MARSA_EMAIL_LIVE_CHANNEL`.
- التحويل إلى `live` يعيد القناة إلى `not_connected` حتى ينجح فحص (probe).
- عنوان واحد لمؤسسة واحدة فقط (`address_taken` إن كان مستخدمًا في مؤسسة أخرى).

## 5) النشر من لوحة Supabase (Add File لـ 9 ملفات)

1. Dashboard ← Edge Functions ← أنشئ أو عدّل الدالة **`inbox-sync`**.
2. استخدم **Add File** حتى تكون الملفات التسعة موجودة بالأسماء نفسها تمامًا (كما تستوردها `index.ts`):
   `index.ts`، `adapters.js`، `mock-email.js`، `mock-whatsapp.js`، `ai-mock.js`، `pipeline.js`، `worker.js`، `email-mime.js`، `email-live.js`.
3. نقطة الدخول: `index.ts`. احتفظ بنسخة من الملفات السابقة قبل الحفظ (لا يوجد تراجع تلقائي).
4. الدالة تقبل فقط `POST` مع `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`؛ أي طلب آخر يعيد `401`.

## 6) أول تشغيل

1. اطلب فحص القناة من الواجهة («فحص الاتصال») أو من SQL باسم المدير: `select public.request_msg_channel_probe('<CHANNEL_UUID>'::uuid);`
2. شغّل الدالة مرة يدويًا (POST إلى `.../functions/v1/inbox-sync/run` بالمفتاح أعلاه).
3. المتوقع: القناة `connected`. الفحص يجرّب الإرسال باسم ops@ (`MAIL FROM` ثم `RSET`) **دون إرسال أي رسالة**؛ ردّ 5xx يعني `send_as_refused`: اسمح بالعنوان البديل كمرسِل في Hostinger.
4. إن ظهر `live_refused` في رد الدالة فالرمز يشرح السبب: `no_live_channel`، `not_the_live_channel`، `from_address_mismatch`، `credentials_missing`، `imap_port`، `smtp_port`.
5. الاستلام يبدأ من موضع INBOX لحظة الفحص. فعّل `ingest_enabled` بعد الفحص بقليل، وإلا يُستورد كل ما وصل بينهما (10 رسائل لكل دورة).
6. **قبل الاعتماد:** أرسل رسالة اختبار واحدة إلى ops@ ثم ردًّا واحدًا منها، وتأكد من: نسخة واحدة في Sent، الحالة `accepted`، وصول الرد بنفس سلسلة المحادثة. بعدها فقط فعّل `send_enabled`.
7. **الارتدادات:** افتح ترويسات رسالة حقيقية في Webmail، اقرأ `authserv-id` من `Authentication-Results`، و`d=` من توقيع DKIM على ارتداد حقيقي، ثم اضبط `MARSA_EMAIL_AUTHSERV_ID` و`MARSA_EMAIL_DSN_DKIM_DOMAIN`. قبل ذلك لا يُعالَج أي ارتداد ويظهر `status_events` غير مدعوم.

## 7) الجدولة (pg_cron + pg_net)

فعّل امتدادي `pg_cron` و`pg_net` (Database ← Extensions). ضع عنوان المشروع والمفتاح في Vault **بيدك** (لا يُكتبان في ترحيل):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY>', 'inbox_sync_key');

select cron.schedule('marsa_inbox_sync', '*/2 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/inbox-sync/run',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'inbox_sync_key')),
    body := '{}'::jsonb, timeout_milliseconds := 150000) $$);
```

- كل تشغيل يعالج 5 مهام على الأكثر، ولا يبدأ مهمة جديدة بعد 80 ثانية (`RUN_BUDGET_MS`).
- القناة الحقيقية لا تُقرأ أكثر من مرة كل 100 ثانية.
- للإيقاف: `select cron.unschedule('marsa_inbox_sync');`

## 8) ملاحظات الأمان

- كلمات المرور في Edge Secrets فقط؛ لا عمود في قاعدة البيانات يحملها، ولا تظهر في السجلات أو الأخطاء (رسائل الأخطاء ثابتة).
- قناة **واحدة** فقط تصبح حقيقية: معرّفها في `MARSA_EMAIL_LIVE_CHANNEL` **و**عنوانها = `MARSA_EMAIL_FROM_ADDRESS`. أي قناة `live` أخرى تفشل بـ `not_configured`.
- الإرسال يمر دائمًا بموافقة الشخص الثاني؛ لا يوجد ردّ تلقائي.
- الإرسال المشكوك فيه (`unknown`) لا يُعاد تلقائيًا؛ إن لم يُعثر على الرسالة في Sent يقرر إنسان.
- `dmarc` غير `pass` يخفّض «موثّق» إلى «معروف» في القنوات الحقيقية، ورسالة ترد على محادثة من مرسِل غريب تفتح محادثة جديدة مع إشارة.
- صندوق Hostinger لا يدعم OAuth: خصّص صندوقًا لهذا الاستخدام، وغيّر كلمة مروره دوريًا، واحصر السر بالمالك.
- لم يُختبر على خادم IMAP حقيقي أثناء التطوير (خادم محاكاة محلي فقط)؛ الخطوة 6 هي أول تحقق حقيقي.
- **التراجع:** أعد القناة إلى `mock` (أو `live_pending`) بـ `save_msg_channel`، وأوقف الجدولة.
