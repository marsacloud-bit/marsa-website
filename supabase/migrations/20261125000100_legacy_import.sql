-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261125000100 — legacy port, step 9: legacy data migration (استيراد بيانات النظام القديم)
-- — docs/online/LEGACY_IMPORT_AR.md, plan docs/online/LEGACY_PORT_PLAN_AR.md («استيراد بيانات النظام القديم», «ما لن يُنقل كما هو»).
-- Builds on legacy_reports (20261124000100) and every earlier legacy step: clients / aliases (20261117000100), transactions,
-- containers, Ro-Ro, duplicate guard (20261118000100), declarations (20261120000100), appointments / trips / drivers / empty
-- returns (20261121000100), the payments register + custody (20261122000100), the Daftra invoice lookup / legacy scan (20261123000100).
-- A ONE-OFF, OWNER-RUN, TENANT-SUPPLIED import: the tenant exports its own legacy Google Sheets as .xlsx / .csv; the browser reads
-- them (assets/js/xlsx-lite.js read limits) and sends rows mapped to the field keys of legacy_import_dictionary(); nothing is fetched
-- from Google, nothing is sent to Daftra by this file (the RHK- step only queues the existing step-7 read-only jobs).
--   P. preflight (legacy_reports applied) + schema_versions row
--   0. dictionaries status_labels: li_entity, li_run_status, li_row_status, li_message (row message codes), audit_label (+ 2)
--   1. columns      transactions + legacy_ref (the legacy sequence «التسلسل», searchable) + import_run_id (the run that created it)
--                   + legacy_created_at (the legacy creation date, data only); server-set only (trigger app.tg_transactions_li_guard)
--   2. tables       public.legacy_import_runs (org, default branch, entities, status draft → staged → validated → committing →
--                   committed → voiding → voided | voided, counts, files {name, sha256, size, sheets}, mapping / options jsonb, reason, timestamps),
--                   public.legacy_import_rows (run, entity, sheet + row no, raw (≤ 16 KB), normalized, row_hash (entity + place
--                   + content) unique per run + entity = idempotent re-staging, status pending / valid / warning / error / duplicate / committed /
--                   skipped, messages, target table + id, created_rows [{t, id, a, fp}] (fp per row at its commit), voided_at)
--   3. helpers      app.li_* (gate, Riyadh dates / Excel serials / Arabic-Indic digits, money, container lists + ISO 6346, ports,
--                   statuses legacy → Marsa, client / transaction resolution, per-entity check + apply, counts, fingerprints,
--                   void blockers); app.auto_lifecycle_on re-created (OFF while an import commits / voids: no lifecycle
--                   auto-advance, no opening Daftra draft); app.att_reasons / app.alert_causes re-created (imported billed / closed
--                   transactions never raise attention or alerts); app.rpt_tx_match re-created (+ legacy_ref in the search);
--                   app.audit_label_of re-created (+ the two import tables); app.convert_delete_tables (+ the two tables)
--   4. RPCs         legacy_import_dictionary, legacy_import_create_run, legacy_import_stage, legacy_import_set_options,
--                   legacy_import_validate, legacy_import_commit, legacy_import_void, legacy_import_get_run, legacy_import_list_runs,
--                   legacy_import_list_rows, legacy_import_skip_rows, legacy_import_queue_daftra, legacy_import_daftra_candidates
--   5. RLS, grants, function privileges
-- Who: the OWNER only (an active org-wide admin membership, session aal2) with a written reason; a branch admin, any other role, a
-- client-portal user, another org or anon: MRS_FORBIDDEN / permission denied. Never crosses orgs (every lookup is org-scoped).
-- Safety defaults (owner decisions, docs «قرارات المالك» 2026-11-11 step 9): nothing is approved or verified — imported payments are
-- 'pending' (four-eyes still required), aliases are 'suggested', containers keep return_status 'pending' (a legacy «returned» date is
-- stored as returned_at data only; no empty-return proof is fabricated, so billing stays blocked for open transactions); legacy
-- «تمت الفوترة» becomes 'billed' (historical, already billed in Daftra: no billing intent, no Daftra draft, nothing for Marsa to
-- bill), legacy «تحت الفوترة» of a container transaction becomes 'operationally_complete' (the normal empty-return gate decides);
-- no billing intents / Daftra drafts; lifecycle triggers are suppressed while the run writes; attention / alerts ignore imported
-- billed / closed transactions; every committed row is audited with its run id (audit_log of legacy_import_rows + the created rows).
-- Step-9 review (2026-11-11): created_at of an imported transaction = the import time (the legacy date → legacy_created_at, the plan
-- month is the real one); fingerprints per row as it commits; validate / commit / void one entity per call through indexes; void in
-- chunks (status voiding) and never deletes a container; staging keyed by place + replace; custody / movements checked against
-- earlier runs; the RHK- reference matched by the legacy scan (app.daftra_apply_scan re-created).
-- Errors: + MRS_LI_STATE (run state), MRS_LI_LIMIT (size caps), MRS_LI_BUSY (another call holds the run), MRS_LI_VOID_BLOCKED
-- (created rows changed / used later; detail = the list); otherwise existing codes (MRS_AUTH_REQUIRED, MRS_FORBIDDEN owner_only,
-- MRS_MFA_REQUIRED, MRS_NOTE_REQUIRED reason, MRS_INVALID <field>, MRS_REQUIRED <field>, MRS_NOT_FOUND run, MRS_TOO_LONG).
-- Row problems are not exceptions: they are messages [{level error|warning|info, code (li_message), field, detail}] on the row.
-- Re-runnable (IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS + CREATE / ON CONFLICT); re-running on itself leaves an identical
-- catalog. Re-pasting 20261118000100 (auto_lifecycle_on), 20261124000100 (att_reasons, alert_causes, rpt_tx_match, audit_label_of)
-- or 20261123000100 (convert_delete_tables, daftra_apply_scan) restores their narrower bodies: re-paste this file right after.
-- Down-path (staging only): void every committed run first (legacy_import_void); DROP the RPCs of §4 and the app.li_* helpers;
-- re-paste 20261118000100 §1 (auto_lifecycle_on), 20261124000100 §1 / §2 and 20261123000100 (convert_delete_tables, daftra_apply_scan); DROP TABLE
-- public.legacy_import_rows, public.legacy_import_runs; DROP the trigger trg_li_guard and the columns transactions.legacy_ref /
-- import_run_id / legacy_created_at.
-- =====================================================================

DO $guard$
BEGIN
  -- stops immediately if the Arabic text was pasted with the wrong encoding
  IF 'جديد' <> U&'\062C\062F\064A\062F' THEN
    RAISE EXCEPTION 'ENCODING ERROR: Arabic text was pasted incorrectly (not UTF-8). Nothing was changed.';
  END IF;
END $guard$;

SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------
-- P. preflight (read-only)
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261124000100') THEN
    RAISE EXCEPTION 'LEGACY IMPORT preflight: apply legacy_reports first (schema_versions lacks 20261124000100 legacy_reports)';
  END IF;
  IF to_regprocedure('public.record_payment_bundle(jsonb,uuid)') IS NULL OR to_regprocedure('public.save_custody_entry(jsonb,uuid)') IS NULL
     OR to_regprocedure('app.tx_dup_conflicts(uuid,uuid,text,text,text,text[])') IS NULL
     OR to_regprocedure('app.appt_duplicate(uuid,uuid,timestamp with time zone,text,uuid)') IS NULL
     OR to_regprocedure('app.daftra_enqueue(uuid,text,uuid,uuid,uuid,text,jsonb,uuid)') IS NULL
     OR to_regprocedure('app.att_reasons(uuid,uuid[],timestamp with time zone)') IS NULL
     OR to_regclass('public.daftra_invoice_candidates') IS NULL OR to_regclass('public.client_custody_entries') IS NULL THEN
    RAISE EXCEPTION 'LEGACY IMPORT preflight: steps 1–8 objects missing (apply 20261117000100 … 20261124000100)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261125000100', 'legacy_import')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries (internal: client_visible = false)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('li_entity','customers',1,'العملاء','Customers',false),
  ('li_entity','aliases',2,'أسماء العملاء البديلة','Customer aliases',false),
  ('li_entity','drivers',3,'السائقون','Drivers',false),
  ('li_entity','transactions',4,'المعاملات','Transactions',false),
  ('li_entity','containers',5,'حاويات المعاملات','Transaction containers',false),
  ('li_entity','movements',6,'حركة النقل','Movements',false),
  ('li_entity','payments',7,'السدادات','Payments',false),
  ('li_entity','custody',8,'عهدة العملاء','Client custody',false),
  ('li_run_status','draft',1,'مسودة','Draft',false),
  ('li_run_status','staged',2,'مرفوعة','Staged',false),
  ('li_run_status','validated',3,'مفحوصة','Validated',false),
  ('li_run_status','committing',4,'قيد الترحيل','Committing',false),
  ('li_run_status','committed',5,'مُرحّلة','Committed',false),
  ('li_run_status','voiding',6,'قيد الإلغاء','Voiding',false),
  ('li_run_status','voided',7,'ملغاة','Voided',false),
  ('li_row_status','pending',1,'بانتظار الفحص','Pending',false),
  ('li_row_status','valid',2,'سليم','Valid',false),
  ('li_row_status','warning',3,'سليم مع تنبيه','Valid with warnings',false),
  ('li_row_status','error',4,'خطأ','Error',false),
  ('li_row_status','duplicate',5,'مكرر','Duplicate',false),
  ('li_row_status','committed',6,'مُرحّل','Committed',false),
  ('li_row_status','skipped',7,'متجاوز','Skipped',false),
  ('li_message','required',1,'حقل مطلوب فارغ','A required field is empty',false),
  ('li_message','too_long',2,'النص أطول من المسموح','The text is too long',false),
  ('li_message','invalid_date',3,'تاريخ غير مفهوم (مثال صحيح: 03/11/2026)','Date not understood (e.g. 03/11/2026)',false),
  ('li_message','invalid_datetime',4,'تاريخ ووقت غير مفهوم (مثال صحيح: 03/11/2026 08:30)','Date / time not understood (e.g. 03/11/2026 08:30)',false),
  ('li_message','future_date',5,'التاريخ بعد اليوم','The date is after today',false),
  ('li_message','invalid_amount',6,'مبلغ غير صحيح','Invalid amount',false),
  ('li_message','currency_not_sar',7,'العملة ليست الريال السعودي','The currency is not SAR',false),
  ('li_message','branch_required',8,'اختر فرع الدفعة أو حدّد الفرع في الصف','Choose the run branch or give the branch in the row',false),
  ('li_message','branch_unknown',9,'الفرع غير معروف','Unknown branch',false),
  ('li_message','duplicate_in_file',10,'مكرر داخل الملف (يُستورد الصف الأول فقط)','Duplicate inside the file (only the first row is imported)',false),
  ('li_message','exists_in_marsa',11,'موجود مسبقًا في مرسى (لا يُنشأ مرة ثانية)','Already in Marsa (not created twice)',false),
  ('li_message','already_imported',12,'استُورد في دفعة سابقة','Imported by an earlier run',false),
  ('li_message','parent_invalid',13,'الصف الأب في الملف فيه خطأ','The parent row in the file has an error',false),
  ('li_message','parent_failed',14,'لم يُرحّل الصف الأب','The parent row was not committed',false),
  ('li_message','commit_failed',15,'تعذّر الترحيل','Commit failed',false),
  ('li_message','name_required',16,'اسم العميل مطلوب','The client name is required',false),
  ('li_message','name_from_english',17,'لا يوجد اسم عربي؛ استُخدم الاسم الإنجليزي','No Arabic name; the English name is used',false),
  ('li_message','daftra_code_invalid',18,'كود عميل دفترة غير صحيح','Invalid Daftra client code',false),
  ('li_message','daftra_code_taken',19,'كود دفترة مستخدم لعميل آخر','The Daftra code belongs to another client',false),
  ('li_message','phone_invalid',20,'رقم الجوال غير صحيح؛ لم يُحفظ','Invalid mobile number; not saved',false),
  ('li_message','email_invalid',21,'البريد غير صحيح؛ لم يُحفظ','Invalid e-mail; not saved',false),
  ('li_message','vat_invalid',22,'الرقم الضريبي غير صحيح (15 رقمًا)؛ لم يُحفظ','Invalid VAT number (15 digits); not saved',false),
  ('li_message','cr_invalid',23,'السجل التجاري غير صحيح (10 أرقام)؛ لم يُحفظ','Invalid CR number (10 digits); not saved',false),
  ('li_message','vat_taken',24,'الرقم الضريبي مسجل لعميل آخر','The VAT number belongs to another client',false),
  ('li_message','cr_taken',25,'السجل التجاري مسجل لعميل آخر','The CR number belongs to another client',false),
  ('li_message','category_unknown',26,'التصنيف غير معروف (مطار / ميناء / مشترك)','Unknown category (airport / port / shared)',false),
  ('li_message','client_not_found',27,'العميل غير موجود في مرسى ولا في ملف العملاء','Client not found in Marsa nor in the customers file',false),
  ('li_message','client_ambiguous',28,'أكثر من عميل بهذا الاسم؛ أضف كود دفترة أو اربطه يدويًا','Several clients with this name; add the Daftra code or map it',false),
  ('li_message','client_inactive',29,'العميل موقوف في مرسى','The client is inactive in Marsa',false),
  ('li_message','alias_taken',30,'الاسم البديل مسجل لعميل آخر','The alias belongs to another client',false),
  ('li_message','alias_suggested',31,'يُستورد الاسم البديل «مقترحًا» ويعتمده موظف','The alias is imported as «suggested»; staff approve it',false),
  ('li_message','alias_rejected_skipped',32,'اسم بديل مرفوض في النظام القديم؛ لم يُستورد','Alias rejected in the legacy system; not imported',false),
  ('li_message','driver_phone_invalid',33,'جوال السائق غير صحيح؛ لم يُحفظ','Invalid driver mobile; not saved',false),
  ('li_message','plate_invalid',34,'رقم الشاحنة غير صحيح؛ لم يُحفظ','Invalid truck plate; not saved',false),
  ('li_message','bl_required',35,'رقم البوليصة مطلوب','The B/L number is required',false),
  ('li_message','container_format',36,'رقم الحاوية ليس بصيغة ISO (4 حروف + 7 أرقام)','The container number is not ISO-shaped (4 letters + 7 digits)',false),
  ('li_message','container_check_digit',37,'خانة التحقق في رقم الحاوية لا تطابق (ISO 6346)؛ راجع الرقم','The container check digit does not match (ISO 6346); check the number',false),
  ('li_message','containers_required',38,'أضف رقم حاوية واحدًا على الأقل','Add at least one container number',false),
  ('li_message','chassis_required',39,'رقم الشاسيه مطلوب لمعاملة Ro-Ro','The chassis number is required for a Ro-Ro transaction',false),
  ('li_message','roro_containers_ignored',40,'معاملة Ro-Ro لا تحمل حاويات؛ تجاهلنا أرقام الحاويات','A Ro-Ro transaction carries no containers; container numbers ignored',false),
  ('li_message','port_unknown',41,'المنفذ غير موجود في قائمة المنافذ المعتمدة','The port is not an approved port',false),
  ('li_message','port_missing',42,'المنفذ فارغ','The port is empty',false),
  ('li_message','status_unknown',43,'الحالة غير معروفة؛ اعتُبرت «جديدة»','Unknown status; taken as «new»',false),
  ('li_message','status_billed_historical',44,'معاملة مفوترة سابقًا في دفترة: تُستورد «تمت الفوترة» دون أي فوترة من مرسى','Billed before in Daftra: imported as «billed», Marsa bills nothing',false),
  ('li_message','needs_empty_return_proof',45,'كانت «تحت الفوترة»: تُستورد «منتهية تشغيليًا» وتحتاج إثباتات إعادة الفارغ قبل الفوترة','Was «under billing»: imported as «operationally complete»; needs empty-return proofs before billing',false),
  ('li_message','declaration_taken',46,'رقم البيان مسجل في معاملة أخرى','The declaration number belongs to another transaction',false),
  ('li_message','declaration_status_unknown',47,'حالة البيان غير معروفة؛ تُستورد «مقدّم»','Unknown declaration status; imported as «submitted»',false),
  ('li_message','declaration_type_unknown',48,'نوع البيان غير معروف','Unknown declaration type',false),
  ('li_message','hijri_invalid',49,'التاريخ الهجري غير صحيح؛ لم يُحفظ','Invalid Hijri date; not saved',false),
  ('li_message','transport_order_invalid',50,'رقم أمر النقل يجب أن يبدأ بـ TASTO ثم أرقام','The transport order must be TASTO followed by digits',false),
  ('li_message','transport_order_taken',51,'رقم أمر النقل مسجل في معاملة أخرى','The transport order belongs to another transaction',false),
  ('li_message','transport_company_unknown',52,'شركة النقل غير موجودة في مرسى؛ حُفظ اسمها في الملاحظات','Transport company not in Marsa; its name is kept in the notes',false),
  ('li_message','operator_unknown',53,'المشغل غير موجود في مرسى أو لا يعمل في هذا المنفذ؛ حُفظ اسمه في الملاحظات','Operator not in Marsa or not at this port; its name is kept in the notes',false),
  ('li_message','created_at_kept',54,'حُفظ تاريخ الإنشاء من النظام القديم كبيانات؛ تُحتسب المعاملة في شهر الاستيراد','The legacy creation date is kept as data; the transaction counts in the import month',false),
  ('li_message','transaction_not_found',55,'المعاملة غير موجودة في الملف ولا في دفعات سابقة','Transaction not found in the file nor in an earlier run',false),
  ('li_message','container_not_on_transaction',56,'الحاوية ليست من حاويات المعاملة','The container is not on the transaction',false),
  ('li_message','roro_no_container',57,'معاملة Ro-Ro: المركبة على المعاملة نفسها، ولا تُضاف حاوية','Ro-Ro: the vehicle is on the transaction itself, no container is added',false),
  ('li_message','movement_empty',58,'لا يوجد موعد ولا بيانات نقل في الصف','The row has neither an appointment nor transport data',false),
  ('li_message','appointment_duplicate',59,'الموعد مسجل مسبقًا (نفس الحاوية والدقيقة أو نفس الرقم)','Appointment already recorded (same container and minute or same number)',false),
  ('li_message','tas_invalid',60,'الرقم المرجعي للموعد ليس رقم TAS؛ حُفظ كمرجع حجز','The appointment reference is not a TAS number; kept as booking reference',false),
  ('li_message','returned_recorded_no_proof',61,'حُفظ تاريخ إعادة الفارغ كبيانات فقط؛ إثبات الإعادة يعتمده موظف','The empty-return date is kept as data only; staff confirm the proof',false),
  ('li_message','returned_no_date',62,'حالة الإعادة «أُعيدت» بلا تاريخ؛ لم يُسجل شيء','Return state «returned» without a date; nothing recorded',false),
  ('li_message','return_fields_skipped',63,'الحاوية ليست من استيراد النظام القديم؛ لم تُعدَّل بيانات إعادتها','The container was not imported; its return data is left as is',false),
  ('li_message','driver_created',64,'سيُضاف السائق إلى دليل السائقين','The driver will be added to the directory',false),
  ('li_message','truck_created',65,'ستُضاف الشاحنة','The truck will be added',false),
  ('li_message','movement_status_unknown',66,'حالة الموعد والنقل غير معروفة؛ اعتُبرت «موعد مسجل»','Unknown movement status; taken as «registered»',false),
  ('li_message','movement_type_unknown',67,'نوع الحركة المالية غير معروف','Unknown payment movement type',false),
  ('li_message','method_unknown',68,'طريقة السداد غير محددة ولا يمكن استنتاجها','Payment method not given and cannot be inferred',false),
  ('li_message','method_inferred',69,'استُنتجت طريقة السداد من المرجع','The payment method was inferred from the reference',false),
  ('li_message','funding_unknown',70,'مصدر التمويل غير محدد؛ اختر مصدرًا افتراضيًا للدفعة','Funding source not given; choose a default for the run',false),
  ('li_message','funding_default',71,'استُخدم مصدر التمويل الافتراضي للدفعة','The run default funding source is used',false),
  ('li_message','funding_invalid',72,'مصدر التمويل لا يتوافق مع طريقة السداد','The funding source does not fit the method',false),
  ('li_message','paying_account_required',73,'الحساب المسدد منه مطلوب لهذه الطريقة','The paying account is required for this method',false),
  ('li_message','reference_required',74,'مرجع السداد مطلوب (رقم سداد أو مرجع بنكي أو إيصال)','A payment reference is required (SADAD no, bank reference or receipt)',false),
  ('li_message','reference_invalid',75,'صيغة مرجع السداد غير صحيحة','Invalid payment reference format',false),
  ('li_message','payment_ref_taken',76,'مرجع السداد مسجل في سداد آخر','The payment reference is used by another payment',false),
  ('li_message','service_item_unknown',77,'بند الخدمة غير معروف؛ اربطه ببند في الدفعة','Unknown service item; map it in the run',false),
  ('li_message','beneficiary_required',78,'الجهة المستفيدة / مصدرة الفاتورة مطلوبة','The beneficiary / invoice issuer is required',false),
  ('li_message','beneficiary_created',79,'ستُضاف الجهة المستفيدة إلى الجهات','The beneficiary will be added to the parties',false),
  ('li_message','shared_not_supported',80,'السداد المشترك لا يُستورد؛ سجّله يدويًا','Shared payments are not imported; record them by hand',false),
  ('li_message','payment_pending_review',81,'يُستورد السداد «بانتظار المراجعة» (أربع أعين)','The payment is imported «pending review» (four eyes)',false),
  ('li_message','custody_kind_unknown',82,'نوع حركة العهدة غير معروف','Unknown custody movement type',false),
  ('li_message','custody_legacy_void',83,'حركة ملغاة في النظام القديم؛ لا تدخل في الرصيد','Voided in the legacy system; not in the balance',false),
  ('li_message','custody_negative',84,'رصيد عهدة العميل سالب في الملف؛ لا يُستورد','The client custody balance is negative in the file; not imported',false),
  ('li_message','custody_zero',85,'رصيد عهدة العميل صفر؛ لا تُنشأ حركة','The client custody balance is zero; no entry created',false),
  ('li_message','custody_opening',86,'يُنشأ رصيد افتتاحي واحد للعميل بمجموع حركاته','One opening balance per client = the sum of its movements',false),
  ('li_message','custody_merged',87,'دخلت الحركة في الرصيد الافتتاحي للعميل','The movement is part of the client opening balance',false),
  ('li_message','skipped_by_owner',88,'تجاوزه المالك','Skipped by the owner',false),
  ('li_message','inactive_match',89,'طابق سجلًا موقوفًا في مرسى','Matched an inactive record in Marsa',false),
  ('li_message','custody_already_opened',90,'للعميل رصيد عهدة افتتاحي من دفعة سابقة؛ الحركة بلا «رقم حركة العهدة» لا تُستورد (سجّلها يدويًا)','The client already has an opening custody balance from an earlier run; a movement without «custody entry id» is not imported (record it by hand)',false),
  ('li_message','trip_duplicate',91,'النقلة مسجلة مسبقًا على المعاملة (نفس الحاوية والسائق والوجهة والقيمة)','The trip is already on the transaction (same container, driver, destination and value)',false),
  ('li_message','container_kept_on_void',92,'حاوية أضيفت لمعاملة سابقة؛ تبقى عند إلغاء الدفعة','A container added to an earlier transaction; it stays when the run is voided',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en, client_visible = EXCLUDED.client_visible;
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('audit_label','legacy_import.run',32,'دفعة استيراد من النظام القديم','Legacy import run',false),
  ('audit_label','legacy_import.row',33,'صف مستورد من النظام القديم','Legacy import row',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en, client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. columns: transactions.legacy_ref (the legacy sequence, searchable) + import_run_id
-- ---------------------------------------------------------------------
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS legacy_ref text;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS import_run_id uuid;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS legacy_created_at timestamptz;
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_legacy_ref_chk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_legacy_ref_chk CHECK (char_length(legacy_ref) BETWEEN 1 AND 40);
COMMENT ON COLUMN public.transactions.legacy_ref IS 'Legacy step 9: the sequence number («التسلسل», else «رقم المعاملة») of the legacy Google Sheets row this transaction was imported from. Server-set by legacy_import_commit only; searchable (report_transactions q). Marsa refs continue their own sequence.';
COMMENT ON COLUMN public.transactions.legacy_created_at IS 'Legacy step 9: the legacy creation date («تاريخ الإنشاء») of an imported transaction, kept as data only. created_at is the import time, so the transaction counts in the plan month of the import (review fix: no back-dated plan-quota bypass). Server-set only.';
COMMENT ON COLUMN public.transactions.import_run_id IS 'Legacy step 9: the legacy_import_runs row that created this transaction (NULL = created in Marsa). Server-set only.';
CREATE INDEX IF NOT EXISTS transactions_legacy_ref_idx ON public.transactions (org_id, legacy_ref) WHERE legacy_ref IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. tables
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.legacy_import_runs_seq;

CREATE TABLE IF NOT EXISTS public.legacy_import_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  ref               text NOT NULL CHECK (ref ~ '^LIR-[0-9]{6,}$'),
  branch_id         uuid,
  entities          text[] NOT NULL CHECK (cardinality(entities) BETWEEN 1 AND 8
                      AND entities <@ ARRAY['customers','aliases','drivers','transactions','containers','movements','payments','custody']),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','staged','validated','committing','committed','voiding','voided')),
  reason            text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  files             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(files) = 'array' AND jsonb_array_length(files) <= 20),
  mapping           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(mapping) = 'object'),
  options           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  counts            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  daftra            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(daftra) = 'object'),
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  staged_at         timestamptz,
  validated_at      timestamptz,
  commit_started_at timestamptz,
  committed_at      timestamptz,
  committed_by      uuid,
  voided_at         timestamptz,
  voided_by         uuid,
  void_reason       text CHECK (char_length(void_reason) <= 500),
  CONSTRAINT legacy_import_runs_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT legacy_import_runs_ref_uniq UNIQUE (ref),
  CONSTRAINT legacy_import_runs_void_chk CHECK ((status = 'voided') = (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CONSTRAINT legacy_import_runs_commit_chk CHECK ((status = 'committed') = (committed_at IS NOT NULL) OR status IN ('voiding','voided')),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.legacy_import_runs IS 'Legacy step 9 (LEGACY_IMPORT_AR.md): one owner-run import of the tenant''s own legacy Google Sheets export. draft → staged → validated → committing → committed, or voided (a run that created nothing, or whose created rows were never changed afterwards). One open run per org. Owner only (org-wide admin, aal2), through the legacy_import_* RPCs.';
-- one open (not committed / voided) run per org at a time
CREATE UNIQUE INDEX IF NOT EXISTS legacy_import_runs_open_uidx ON public.legacy_import_runs (org_id)
  WHERE status IN ('draft','staged','validated','committing','voiding');
CREATE INDEX IF NOT EXISTS legacy_import_runs_org_idx ON public.legacy_import_runs (org_id, created_at DESC);

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_import_run_fk;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_import_run_fk
  FOREIGN KEY (import_run_id, org_id) REFERENCES public.legacy_import_runs(id, org_id);

CREATE TABLE IF NOT EXISTS public.legacy_import_rows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  run_id        uuid NOT NULL,
  entity        text NOT NULL CHECK (entity IN ('customers','aliases','drivers','transactions','containers','movements','payments','custody')),
  sheet         text NOT NULL DEFAULT '' CHECK (char_length(sheet) <= 120),
  row_no        int NOT NULL CHECK (row_no BETWEEN 1 AND 1000000),
  raw           jsonb NOT NULL CHECK (jsonb_typeof(raw) = 'object' AND octet_length(raw::text) <= 16384),
  normalized    jsonb,
  row_hash      text NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','valid','warning','error','duplicate','committed','skipped')),
  messages      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(messages) = 'array'),
  skipped_by_owner boolean NOT NULL DEFAULT false,
  target_table  text CHECK (target_table IN ('clients','client_aliases','drivers','transactions','containers','port_appointments',
                                             'transport_trips','client_disbursements','client_custody_entries')),
  target_id     uuid,
  created_rows  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(created_rows) = 'array'),
  committed_at  timestamptz,
  voided_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_import_rows_run_fk FOREIGN KEY (run_id, org_id) REFERENCES public.legacy_import_runs(id, org_id),
  CONSTRAINT legacy_import_rows_hash_uniq UNIQUE (run_id, entity, row_hash),
  CONSTRAINT legacy_import_rows_commit_chk CHECK ((status = 'committed') = (committed_at IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.legacy_import_rows IS 'Legacy step 9: one staged row of a legacy sheet (raw = the field-keyed values the browser read, ≤ 16 KB; untrusted data). row_hash = sha256(entity + sheet + row no + raw) — re-staging the same row at the same place is a no-op; two equal lines of a sheet are two rows (the validation flags real duplicates). normalized + messages come from the server-side validation (the same rules as the normal writes); committed rows name their target and every row they created (created_rows, with a fingerprint taken when the row commits, compared on void; voided_at = undone by a void).';
CREATE INDEX IF NOT EXISTS legacy_import_rows_run_idx ON public.legacy_import_rows (run_id, entity, status, sheet, row_no, id);
-- the created rows of a run by id (the fingerprint re-baseline of the commit, the void)
CREATE INDEX IF NOT EXISTS legacy_import_rows_created_gin ON public.legacy_import_rows USING gin (created_rows jsonb_path_ops) WITH (fastupdate = off);
CREATE INDEX IF NOT EXISTS legacy_import_rows_order_idx ON public.legacy_import_rows (run_id, sheet, row_no);
CREATE INDEX IF NOT EXISTS legacy_import_rows_key_idx ON public.legacy_import_rows (org_id, entity, ((normalized ->> 'legacy_id')))
  WHERE status = 'committed';
CREATE INDEX IF NOT EXISTS legacy_import_rows_cseq_idx ON public.legacy_import_rows (org_id, entity, ((normalized ->> 'seq')))
  WHERE status = 'committed';
CREATE INDEX IF NOT EXISTS legacy_import_rows_target_idx ON public.legacy_import_rows (target_id) WHERE target_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_touch ON public.legacy_import_runs;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.legacy_import_runs FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
DROP TRIGGER IF EXISTS trg_audit ON public.legacy_import_runs;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.legacy_import_runs FOR EACH ROW EXECUTE FUNCTION app.tg_audit();
DROP TRIGGER IF EXISTS trg_touch ON public.legacy_import_rows;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.legacy_import_rows FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
-- the audit trail of the import: every row that commits (with its run id, target and created rows), never the staging noise
DROP TRIGGER IF EXISTS trg_audit ON public.legacy_import_rows;
CREATE TRIGGER trg_audit AFTER UPDATE ON public.legacy_import_rows FOR EACH ROW
  WHEN (NEW.status = 'committed' AND OLD.status IS DISTINCT FROM 'committed') EXECUTE FUNCTION app.tg_audit();

-- the in-file duplicate keys of the validation (normalized.keys ?| …)
CREATE INDEX IF NOT EXISTS legacy_import_rows_keys_gin ON public.legacy_import_rows USING gin ((normalized -> 'keys')) WITH (fastupdate = off);
CREATE INDEX IF NOT EXISTS legacy_import_rows_lid_idx ON public.legacy_import_rows (run_id, entity, ((normalized ->> 'legacy_id')));
CREATE INDEX IF NOT EXISTS legacy_import_rows_seq_idx ON public.legacy_import_rows (run_id, entity, ((normalized ->> 'seq')));
-- the lookups of the validation between the rows of one run (parents by code / name, children by their transaction)
CREATE INDEX IF NOT EXISTS legacy_import_rows_code_idx ON public.legacy_import_rows (run_id, entity, ((normalized ->> 'code')));
CREATE INDEX IF NOT EXISTS legacy_import_rows_name_idx ON public.legacy_import_rows (run_id, entity, ((normalized ->> 'name_norm')));
CREATE INDEX IF NOT EXISTS legacy_import_rows_txref_idx ON public.legacy_import_rows (run_id, entity, (coalesce(normalized ->> 'tx_id', normalized ->> 'tx_row')));
CREATE INDEX IF NOT EXISTS legacy_import_rows_rawtx_idx ON public.legacy_import_rows (run_id, entity, (btrim(raw ->> 'tx_legacy_id')));
CREATE INDEX IF NOT EXISTS legacy_import_rows_decl_idx ON public.legacy_import_rows (run_id, entity, ((normalized ->> 'declaration_no')))
  WHERE normalized ? 'declaration_no';
CREATE INDEX IF NOT EXISTS legacy_import_rows_order_no_idx ON public.legacy_import_rows (run_id, entity, ((normalized ->> 'transport_order_no')))
  WHERE normalized ? 'transport_order_no';

-- server-set columns of an imported transaction (an API caller can neither set nor change them)
CREATE OR REPLACE FUNCTION app.tg_transactions_li_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.is_api_caller() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.legacy_ref := NULL; NEW.import_run_id := NULL; NEW.legacy_created_at := NULL;
    ELSE
      NEW.legacy_ref := OLD.legacy_ref; NEW.import_run_id := OLD.import_run_id; NEW.legacy_created_at := OLD.legacy_created_at;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_li_guard ON public.transactions;
CREATE TRIGGER trg_li_guard BEFORE INSERT OR UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION app.tg_transactions_li_guard();

-- ---------------------------------------------------------------------
-- 3. helpers (revoked from PUBLIC / anon / authenticated in §5)
-- ---------------------------------------------------------------------
-- automatic lifecycle (20261118000100, re-created): + OFF while a legacy import run writes or voids (marsa.li_run set locally by
-- legacy_import_commit / legacy_import_void): imported rows carry their legacy status; no auto-advance, no opening Daftra draft
CREATE OR REPLACE FUNCTION app.auto_lifecycle_on() RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF coalesce(current_setting('marsa.li_run', true), '') <> '' THEN RETURN false; END IF;
  RETURN (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') IS NOT NULL;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

-- the owner of an org: an active org-wide admin membership (has_role: org active + the MFA gate of admins)
CREATE OR REPLACE FUNCTION app.li_is_owner(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_org IS NOT NULL AND app.has_role(p_org, ARRAY['admin'])
     AND EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.role = 'admin'
                    AND m.is_active AND m.branch_id IS NULL)
$$;
-- the gate of every import RPC: signed in, the owner of the org, an aal2 session
CREATE OR REPLACE FUNCTION app.li_gate(p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF NOT app.li_is_owner(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'owner_only'); END IF;
  IF coalesce(app.session_aal(), '') <> 'aal2' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_MFA_REQUIRED', DETAIL = 'aal2';
  END IF;
END $$;
-- the run of the caller (the owner of its org), locked when asked; another org's run / not the owner → MRS_NOT_FOUND
CREATE OR REPLACE FUNCTION app.li_run(p_run uuid, p_lock boolean) RETURNS public.legacy_import_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.legacy_import_runs;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v FROM public.legacy_import_runs r WHERE r.id = p_run;
  IF v.id IS NULL OR NOT app.li_is_owner(v.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'run'); END IF;
  PERFORM app.li_gate(v.org_id);
  IF p_lock THEN
    IF NOT pg_try_advisory_xact_lock(hashtextextended('marsa.li:' || v.id::text, 0)) THEN PERFORM app.fail('MRS_LI_BUSY', 'run'); END IF;
    SELECT * INTO v FROM public.legacy_import_runs r WHERE r.id = p_run FOR UPDATE;
  END IF;
  RETURN v;
END $$;

-- one message [{level, code, field, detail}]
CREATE OR REPLACE FUNCTION app.li_m(p_level text, p_code text, p_field text DEFAULT NULL, p_detail text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('level', p_level, 'code', p_code, 'field', p_field,
                                                                'detail', left(p_detail, 200))))
$$;
-- a raw value as clean text: strings / numbers / booleans only, control + bidi marks removed, Unicode spaces folded, trimmed;
-- NULL when blank (untrusted data: nothing is evaluated)
CREATE OR REPLACE FUNCTION app.li_s(p jsonb, k text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(btrim(regexp_replace(regexp_replace(app.legacy_spaces(
           CASE WHEN jsonb_typeof(p -> k) IN ('string','number','boolean') THEN p ->> k END),
           '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F​-‏؜‪-‮⁦-⁩﻿]', '', 'g'), '[[:space:]]+', ' ', 'g')), '')
$$;
-- the folded key of a legacy label (legacy normalizeSearch_ + Arabic-Indic digits + the em dash)
CREATE OR REPLACE FUNCTION app.li_key(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(regexp_replace(coalesce(app.legacy_search_key(app.to_western(p)), ''), '[—–ـ%()]+', '', 'g'), '')
$$;

-- a legacy date / time → timestamptz. Accepted: Excel serials (days since 1899-12-30, the fraction = the time), dd/mm/yyyy or
-- d-m-yyyy or yyyy-mm-dd or yyyy/mm/dd with an optional hh:mm[:ss] and ص / م / AM / PM, ISO with Z / an offset; Arabic-Indic
-- digits. A value without a zone is Asia/Riyadh wall time. Year 1990–2100 (a Hijri year is refused). NULL = blank or not understood.
CREATE OR REPLACE FUNCTION app.li_ts(p text) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v text; m text[]; n numeric; y int; mo int; d int; hh int := 0; mi int := 0; ss int := 0; v_pm boolean; v_am boolean;
BEGIN
  v := btrim(regexp_replace(app.to_western(app.legacy_spaces(coalesce(p, ''))), '[​-‏؜‪-‮⁦-⁩﻿]', '', 'g'));
  IF v = '' THEN RETURN NULL; END IF;
  IF v ~ '^[0-9]{4,6}(\.[0-9]+)?$' AND v !~ '^(19|20)[0-9]{2}$' THEN
    n := v::numeric;
    IF n < 32874 OR n > 73415 THEN RETURN NULL; END IF;           -- 1990-01-01 … 2100-12-31
    RETURN (timestamp '1899-12-30' + make_interval(secs => round(n * 86400))) AT TIME ZONE 'Asia/Riyadh';
  END IF;
  IF v ~* '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
    BEGIN
      IF substr(v, 1, 4)::int NOT BETWEEN 1990 AND 2100 THEN RETURN NULL; END IF;
      RETURN v::timestamptz;
    EXCEPTION WHEN others THEN RETURN NULL;
    END;
  END IF;
  v_pm := v ~* '[0-9][[:space:]]*(PM|م)[[:space:]]*$' AND v ~ ':';
  v_am := v ~* '[0-9][[:space:]]*(AM|ص)[[:space:]]*$' AND v ~ ':';
  v := btrim(regexp_replace(v, '[[:space:]]*(AM|PM|am|pm|ص|م|مساءً|صباحًا)[[:space:]]*$', ''));
  m := regexp_match(v, '^([0-9]{1,2})[/.-]([0-9]{1,2})[/.-]([0-9]{4})(?:[ T,]+([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?)?$');
  IF m IS NOT NULL THEN
    d := m[1]::int; mo := m[2]::int; y := m[3]::int;
  ELSE
    m := regexp_match(v, '^([0-9]{4})[/.-]([0-9]{1,2})[/.-]([0-9]{1,2})(?:[ T,]+([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?)?$');
    IF m IS NULL THEN RETURN NULL; END IF;
    y := m[1]::int; mo := m[2]::int; d := m[3]::int;
  END IF;
  IF y NOT BETWEEN 1990 AND 2100 THEN RETURN NULL; END IF;
  IF m[4] IS NOT NULL THEN hh := m[4]::int; mi := m[5]::int; ss := coalesce(m[6], '0')::int; END IF;
  IF v_pm AND hh BETWEEN 1 AND 11 THEN hh := hh + 12; END IF;
  IF v_am AND hh = 12 THEN hh := 0; END IF;
  BEGIN
    RETURN make_timestamp(y, mo, d, hh, mi, ss) AT TIME ZONE 'Asia/Riyadh';
  EXCEPTION WHEN others THEN RETURN NULL;
  END;
END $$;
-- a legacy date (no time zone shift: the calendar day as written; a time part is ignored; an Excel serial = its day; an ISO value
-- with a zone = its Asia/Riyadh day). NULL = blank or not understood.
CREATE OR REPLACE FUNCTION app.li_date(p text) RETURNS date
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v text; m text[]; n numeric; y int; mo int; d int;
BEGIN
  v := btrim(regexp_replace(app.to_western(app.legacy_spaces(coalesce(p, ''))), '[​-‏؜‪-‮⁦-⁩﻿]', '', 'g'));
  IF v = '' THEN RETURN NULL; END IF;
  IF v ~ '^[0-9]{4,6}(\.[0-9]+)?$' AND v !~ '^(19|20)[0-9]{2}$' THEN
    n := v::numeric;
    IF n < 32874 OR n > 73415 THEN RETURN NULL; END IF;
    RETURN DATE '1899-12-30' + floor(n)::int;
  END IF;
  IF v ~* '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN
    RETURN (app.li_ts(v) AT TIME ZONE 'Asia/Riyadh')::date;
  END IF;
  v := btrim(regexp_replace(v, '[[:space:]]*(م|AD)[[:space:]]*$', '', 'i'));
  m := regexp_match(v, '^([0-9]{1,2})[/.-]([0-9]{1,2})[/.-]([0-9]{4})([ T,].*)?$');
  IF m IS NOT NULL THEN
    d := m[1]::int; mo := m[2]::int; y := m[3]::int;
  ELSE
    m := regexp_match(v, '^([0-9]{4})[/.-]([0-9]{1,2})[/.-]([0-9]{1,2})([ T,].*)?$');
    IF m IS NULL THEN RETURN NULL; END IF;
    y := m[1]::int; mo := m[2]::int; d := m[3]::int;
  END IF;
  IF y NOT BETWEEN 1990 AND 2100 THEN RETURN NULL; END IF;
  BEGIN
    RETURN make_date(y, mo, d);
  EXCEPTION WHEN others THEN RETURN NULL;
  END;
END $$;
-- a legacy amount: Arabic-Indic digits, ٫ decimal, ٬ / , thousands, SAR / ر.س / ريال removed; ≤ 2 decimals (a spreadsheet float
-- noise like 150.50000000001 is rounded); NULL = blank; 'NaN' = not a number (the caller reports invalid_amount)
CREATE OR REPLACE FUNCTION app.li_money(p text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text; n numeric;
BEGIN
  v := translate(app.to_western(coalesce(p, '')), '٫٬', '.,');
  v := regexp_replace(v, '(SAR|ر\.?[[:space:]]*س\.?|ريال|﷼)', '', 'gi');
  v := regexp_replace(v, '[[:space:],]', '', 'g');
  IF v = '' THEN RETURN NULL; END IF;
  IF v !~ '^-?[0-9]{1,12}(\.[0-9]+)?$' THEN RETURN 'NaN'::numeric; END IF;
  n := v::numeric;
  IF abs(n - round(n, 2)) > 0.000001 THEN RETURN 'NaN'::numeric; END IF;
  RETURN round(n, 2);
END $$;
-- ISO-shaped container numbers found in a legacy cell (one or several: 'MSCU 1234565, TGHU-7654321'), upper case, in order, distinct.
-- The printed ISO 6346 form with the check digit apart ('TEMU 920200 8', 'TEMU-920200-8') is accepted too (harness fix).
CREATE OR REPLACE FUNCTION app.li_containers(p text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(array_agg(z.c ORDER BY z.o), '{}'::text[]) FROM (
    SELECT x.c, min(x.o) o FROM (
      SELECT m[1] || m[2] || m[3] c, row_number() OVER () o
        FROM regexp_matches(upper(app.to_western(coalesce(p, ''))), '([A-Z]{4})[[:space:]-]*([0-9]{6})[[:space:]-]?([0-9])', 'g') m) x
     GROUP BY x.c) z
$$;
-- true when the cell holds something else than container numbers and separators (a malformed number)
CREATE OR REPLACE FUNCTION app.li_containers_rest(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT regexp_replace(regexp_replace(upper(app.to_western(coalesce(p, ''))), '([A-Z]{4})[[:space:]-]*([0-9]{6})[[:space:]-]?([0-9])', '', 'g'),
                        '[[:space:],،;/|+&\-]|AND|و', '', 'g') ~ '[A-Z0-9ء-ي]'
$$;
-- a mapping override {folded legacy text: value} of the run (ports, service_items, clients, branches)
CREATE OR REPLACE FUNCTION app.li_map(v public.legacy_import_runs, p_kind text, p_text text) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE WHEN jsonb_typeof(v.mapping -> p_kind) = 'object' AND app.li_key(p_text) IS NOT NULL
              THEN (SELECT e.value #>> '{}' FROM jsonb_each(v.mapping -> p_kind) e WHERE app.li_key(e.key) = app.li_key(p_text) LIMIT 1) END
$$;
-- the approved customs port of a legacy port name (legacy APPROVED_CUSTOMS_PORTS_R11 = the customs_ports names) or code
CREATE OR REPLACE FUNCTION app.li_port(v public.legacy_import_runs, p text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text := app.li_key(p); x text; v_codes text[];
BEGIN
  IF k IS NULL THEN RETURN NULL; END IF;
  x := app.li_map(v, 'ports', p);
  IF x IS NOT NULL THEN
    RETURN (SELECT c.code FROM public.customs_ports c WHERE c.code = upper(x) AND c.is_active);
  END IF;
  SELECT c.code INTO x FROM public.customs_ports c
   WHERE c.is_active AND (c.code = upper(btrim(p)) OR app.li_key(c.name_ar) = k OR app.li_key(c.name_en) = k
                          OR app.li_key(c.daftra_value) = k) LIMIT 1;
  IF x IS NOT NULL THEN RETURN x; END IF;
  v_codes := ARRAY(SELECT c.code FROM public.customs_ports c WHERE c.is_active AND char_length(k) >= 4
                     AND (position(k IN app.li_key(c.name_ar)) > 0 OR position(app.li_key(c.name_ar) IN k) > 0));
  RETURN CASE WHEN cardinality(v_codes) = 1 THEN v_codes[1] END;
END $$;
-- the branch of a row: the run mapping {text: branch id}, a branch code / Arabic / English name of the org, else the run branch
CREATE OR REPLACE FUNCTION app.li_branch(v public.legacy_import_runs, p text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE x text; b uuid;
BEGIN
  IF p IS NULL THEN RETURN v.branch_id; END IF;
  x := app.li_map(v, 'branches', p);
  SELECT br.id INTO b FROM public.branches br
   WHERE br.org_id = v.org_id AND br.is_active
     AND ((x IS NOT NULL AND br.id::text = x) OR (x IS NULL AND (upper(br.code) = upper(btrim(p)) OR app.li_key(br.name_ar) = app.li_key(p)
          OR app.li_key(br.name_en) = app.li_key(p))))
   LIMIT 1;
  RETURN b;
END $$;
-- the legacy operational status (APP.transactionStatuses) or a Marsa code → a code, 'active' («نشطة»), NULL when unknown
CREATE OR REPLACE FUNCTION app.li_tx_status(p text) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN k IS NULL THEN NULL
    WHEN lower(btrim(p)) IN ('new','in_progress','customs_declaration','appointment','transport','empty_return','operationally_complete',
                             'under_billing','billed','closed') THEN lower(btrim(p))
    WHEN k IN (app.li_key('جديد'), app.li_key('جديدة')) THEN 'new'
    WHEN k IN (app.li_key('نشطة'), app.li_key('نشط'), app.li_key('قيد العمل')) THEN 'active'
    WHEN position(app.li_key('تمت الفوترة') IN k) > 0 OR k = app.li_key('مفوترة') THEN 'billed'
    WHEN position(app.li_key('تحت الفوترة') IN k) > 0 THEN 'under_billing'
    WHEN position(app.li_key('منتهية تشغيليًا') IN k) > 0 OR position(app.li_key('منتهية تشغيليا') IN k) > 0 THEN 'operationally_complete'
    WHEN position(app.li_key('النقل') IN k) > 0 THEN 'transport'
    ELSE (SELECT l.code FROM public.status_labels l WHERE l.domain = 'operational_status' AND app.li_key(l.label_ar) = k LIMIT 1)
  END FROM (SELECT app.li_key(p) k) z
$$;
-- legacy «حالة الموعد والنقل» → registered | incomplete | delivered | cancelled (NULL unknown)
CREATE OR REPLACE FUNCTION app.li_mv_status(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN k IS NULL THEN NULL
    WHEN position(app.li_key('ناقص') IN k) > 0 THEN 'incomplete'
    WHEN position(app.li_key('تم النقل') IN k) > 0 OR position(app.li_key('تم التسليم') IN k) > 0 OR k = 'delivered' THEN 'delivered'
    WHEN position(app.li_key('ملغ') IN k) > 0 OR k = 'cancelled' THEN 'cancelled'
    WHEN position(app.li_key('موعد مسجل') IN k) > 0 OR k = 'registered' THEN 'registered'
  END FROM (SELECT app.li_key(p) k) z
$$;
-- legacy cargo unit (normalizeCargoUnitType_) → roro | container
CREATE OR REPLACE FUNCTION app.li_cargo(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN k IS NOT NULL AND (position('roro' IN k) > 0 OR position(app.li_key('مركبة') IN k) > 0
                                      OR position(app.li_key('شاحنة') IN k) > 0 OR position(app.li_key('براد') IN k) > 0)
              THEN 'roro' ELSE 'container' END
    FROM (SELECT app.li_key(p) k) z
$$;
-- a value of a legacy label list [[label, code], …] (folded comparison; contains for long labels)
CREATE OR REPLACE FUNCTION app.li_pick(p text, p_pairs text[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text := app.li_key(p); i int;
BEGIN
  IF k IS NULL THEN RETURN NULL; END IF;
  FOR i IN 1 .. coalesce(array_length(p_pairs, 1), 0) LOOP
    IF app.li_key(p_pairs[i][1]) = k OR lower(btrim(p)) = p_pairs[i][2] THEN RETURN p_pairs[i][2]; END IF;
  END LOOP;
  FOR i IN 1 .. coalesce(array_length(p_pairs, 1), 0) LOOP
    IF char_length(app.li_key(p_pairs[i][1])) >= 4 AND position(app.li_key(p_pairs[i][1]) IN k) > 0 THEN RETURN p_pairs[i][2]; END IF;
  END LOOP;
  RETURN NULL;
END $$;
-- legacy payment vocabularies (Payments.js PAYMENT_MODULE): movement types / routes, methods, funding sources
CREATE OR REPLACE FUNCTION app.li_pay_movement(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT app.li_pick(p, ARRAY[['دفعت المؤسسة عن العميل','org_paid'],['سددت المؤسسة عن العميل','org_paid'],
    ['استلمت المؤسسة من العميل','received_from_client'],['دفع العميل للجهة مباشرة','client_direct'],['سدد العميل مباشرة','client_direct']])
$$;
CREATE OR REPLACE FUNCTION app.li_pay_method(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN position(app.li_key('غير محدد') IN coalesce(app.li_key(p), '')) > 0 THEN NULL ELSE
    app.li_pick(p, ARRAY[['رقم سداد','sadad'],['رقم سداد إلكتروني','sadad'],['سداد','sadad'],['مدى','mada'],['بطاقة','mada'],
      ['محفظة فسح','fasah_wallet'],['محفظة الميناء الجاف','dry_port_wallet'],['تحويل بنكي','bank_transfer'],['تحويل','bank_transfer'],
      ['نقدي','cash'],['نقدا','cash'],['كاش','cash'],['شيك','cheque'],['أخرى','other']]) END
$$;
CREATE OR REPLACE FUNCTION app.li_pay_funding(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN position(app.li_key('غير محدد') IN coalesce(app.li_key(p), '')) > 0 THEN 'unknown' ELSE
    app.li_pick(p, ARRAY[['عهدة العميل — محفظة الميناء الجاف','client_custody_dry_port'],
      ['محفظة الميناء الجاف — تمويل المؤسسة','dry_port_wallet_org'],['حساب المؤسسة','org_account'],['الصندوق / النقدية','cash_box'],
      ['محفظة فسح','fasah_wallet'],['عهدة العميل','client_custody'],['حساب شخصي — مستحق الاسترداد','personal_account'],
      ['دفع العميل مباشرة','client_direct'],['غير منطبق — استلام من العميل','not_applicable_receipt']]) END
$$;
-- the org service item of a legacy «بند الخدمة / نوع الرسم» (run mapping, the legacy item code (zeros ignored), the Marsa code, the
-- Arabic / English name at the start of the legacy text — the longest name wins)
CREATE OR REPLACE FUNCTION app.li_service_item(v public.legacy_import_runs, p text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE x text; d text; k text := app.li_key(p); r uuid;
BEGIN
  IF k IS NULL THEN RETURN NULL; END IF;
  x := app.li_map(v, 'service_items', p);
  IF x IS NOT NULL THEN
    RETURN (SELECT s.id FROM public.org_service_items s WHERE s.org_id = v.org_id AND s.is_active AND (s.code = x OR s.id::text = x) LIMIT 1);
  END IF;
  SELECT s.id INTO r FROM public.org_service_items s WHERE s.org_id = v.org_id AND s.is_active AND s.code = lower(btrim(p)) LIMIT 1;
  IF r IS NOT NULL THEN RETURN r; END IF;
  d := substring(app.to_western(p) FROM '([0-9]{4,10})');
  IF d IS NOT NULL THEN
    SELECT s.id INTO r FROM public.org_service_items s
     WHERE s.org_id = v.org_id AND s.is_active AND s.legacy_code IS NOT NULL AND ltrim(s.legacy_code, '0') = ltrim(d, '0') LIMIT 1;
    IF r IS NOT NULL THEN RETURN r; END IF;
  END IF;
  SELECT s.id INTO r FROM public.org_service_items s
   WHERE s.org_id = v.org_id AND s.is_active
     AND (app.li_key(s.name_ar) = k OR position(app.li_key(s.name_ar) IN k) = 1 OR app.li_key(s.name_en) = k
          OR (char_length(coalesce(s.name_en, '')) >= 4 AND position(app.li_key(s.name_en) IN k) > 0))
   ORDER BY char_length(s.name_ar) DESC LIMIT 1;
  RETURN r;
END $$;
-- a legacy Daftra client code (normalizeCustomerCode_: digits padded to 6); 'x' = not a valid Marsa code
CREATE OR REPLACE FUNCTION app.li_client_code(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN v IS NULL THEN NULL
              WHEN v ~ '^[0-9]+$' THEN lpad(v, 6, '0')
              WHEN v ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$' THEN v
              ELSE 'x' END
    FROM (SELECT nullif(regexp_replace(app.to_western(coalesce(p, '')), '[[:space:]]+', '', 'g'), '') v) z
$$;

-- the lookup context of one validate / commit call (built once per call, not per row): {clients: {norm: [ids]}, drivers_phone,
-- drivers_name, parties: {norm: [{id, kinds}]}}
CREATE OR REPLACE FUNCTION app.li_ctx(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'clients', coalesce((SELECT jsonb_object_agg(z.k, z.ids) FROM (
        SELECT y.k, jsonb_agg(DISTINCT y.id) ids FROM (
          SELECT app.norm_name(c.name_ar) k, c.id FROM public.clients c WHERE c.org_id = p_org AND c.is_active
          UNION SELECT app.norm_name(c.name_en), c.id FROM public.clients c WHERE c.org_id = p_org AND c.is_active AND c.name_en IS NOT NULL
          UNION SELECT a.alias_norm, a.client_id FROM public.client_aliases a JOIN public.clients c ON c.id = a.client_id
                 WHERE a.org_id = p_org AND a.status = 'approved' AND c.is_active) y
         WHERE y.k IS NOT NULL GROUP BY y.k) z), '{}'::jsonb),
    'drivers_phone', coalesce((SELECT jsonb_object_agg(z.k, z.id) FROM (
        SELECT DISTINCT ON (d.phone) d.phone k, d.id FROM public.drivers d WHERE d.org_id = p_org AND d.phone IS NOT NULL
         ORDER BY d.phone, d.is_active DESC, d.created_at) z), '{}'::jsonb),
    'drivers_name', coalesce((SELECT jsonb_object_agg(z.k, z.ids) FROM (
        SELECT app.norm_name(d.full_name) k, jsonb_agg(d.id ORDER BY d.is_active DESC, d.created_at) ids FROM public.drivers d
         WHERE d.org_id = p_org AND app.norm_name(d.full_name) IS NOT NULL GROUP BY 1) z), '{}'::jsonb),
    'parties', coalesce((SELECT jsonb_object_agg(z.k, z.v) FROM (
        SELECT y.k, jsonb_agg(DISTINCT jsonb_build_object('id', y.id, 'kinds', y.kinds, 'active', y.is_active)) v FROM (
          SELECT app.norm_name(p.name_ar) k, p.id, p.kinds, p.is_active FROM public.parties p WHERE p.org_id = p_org
          UNION ALL SELECT app.norm_name(p.name_en), p.id, p.kinds, p.is_active FROM public.parties p WHERE p.org_id = p_org AND p.name_en IS NOT NULL
          UNION ALL SELECT app.norm_name(a), p.id, p.kinds, p.is_active FROM public.parties p, unnest(p.aliases) a WHERE p.org_id = p_org) y
         WHERE y.k IS NOT NULL GROUP BY y.k) z), '{}'::jsonb))
$$;
-- the party of a name with one of the kinds (active preferred) → id or NULL
CREATE OR REPLACE FUNCTION app.li_party(ctx jsonb, p_name text, p_kinds text[]) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (e ->> 'id')::uuid FROM jsonb_array_elements(coalesce(ctx -> 'parties' -> app.norm_name(p_name), '[]'::jsonb)) e
   WHERE p_kinds IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(e -> 'kinds') k WHERE k = ANY (p_kinds))
   ORDER BY (e ->> 'active')::boolean DESC LIMIT 1
$$;
-- a rows-in-this-run reference: committed / valid rows only
CREATE OR REPLACE FUNCTION app.li_row_ok(p_status text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_status IN ('valid','warning','committed')
$$;

-- the client of a legacy row: {id} existing / {row} a customers or aliases row of this run / {err} not_found | ambiguous | inactive.
-- Order: run mapping (name → client id), the Daftra code (Marsa, then the customers rows), the normalised name (Marsa names +
-- approved aliases, then the customers / aliases rows of the run).
CREATE OR REPLACE FUNCTION app.li_find_client(v public.legacy_import_runs, ctx jsonb, p_code text, p_name text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_code text := app.li_client_code(p_code); v_norm text := app.norm_name(p_name); x text; c public.clients; v_ids jsonb; r record;
BEGIN
  x := app.li_map(v, 'clients', p_name);
  IF x IS NOT NULL THEN
    SELECT * INTO c FROM public.clients cl WHERE cl.org_id = v.org_id AND cl.id::text = x;
    IF c.id IS NOT NULL THEN RETURN jsonb_build_object('id', c.id); END IF;
  END IF;
  IF v_code IS NOT NULL AND v_code <> 'x' THEN
    SELECT * INTO c FROM public.clients cl WHERE cl.org_id = v.org_id AND upper(cl.daftra_client_code) = upper(v_code);
    IF c.id IS NOT NULL THEN
      RETURN jsonb_build_object('id', c.id) || CASE WHEN c.is_active THEN '{}'::jsonb ELSE jsonb_build_object('inactive', true) END;
    END IF;
    SELECT o.id, o.status, o.normalized INTO r FROM public.legacy_import_rows o
     WHERE o.run_id = v.id AND o.entity = 'customers' AND o.normalized ->> 'code' = v_code
       AND (app.li_row_ok(o.status) OR (o.status = 'duplicate' AND o.normalized ? 'match_id'))
     ORDER BY o.sheet, o.row_no, o.id LIMIT 1;
    IF r.id IS NOT NULL THEN
      RETURN CASE WHEN r.status = 'duplicate' THEN jsonb_build_object('id', r.normalized ->> 'match_id') ELSE jsonb_build_object('row', r.id) END;
    END IF;
  END IF;
  IF v_norm IS NULL THEN RETURN jsonb_build_object('err', CASE WHEN v_code IS NULL THEN 'client_required' ELSE 'client_not_found' END); END IF;
  v_ids := ctx -> 'clients' -> v_norm;
  IF jsonb_array_length(coalesce(v_ids, '[]'::jsonb)) = 1 THEN RETURN jsonb_build_object('id', v_ids ->> 0); END IF;
  IF jsonb_array_length(coalesce(v_ids, '[]'::jsonb)) > 1 THEN RETURN jsonb_build_object('err', 'client_ambiguous'); END IF;
  -- the customers / aliases rows of this run (a duplicate customers row points to its Marsa client)
  SELECT count(DISTINCT coalesce(z.ref, '')) n, min(z.ref) ref, bool_or(z.is_id) is_id INTO r FROM (
    SELECT CASE WHEN o.status = 'duplicate' THEN o.normalized ->> 'match_id' ELSE o.id::text END ref, o.status = 'duplicate' is_id
      FROM public.legacy_import_rows o
     WHERE o.run_id = v.id AND o.entity = 'customers' AND (o.normalized ->> 'name_norm' = v_norm OR o.normalized ->> 'name_en_norm' = v_norm)
       AND (app.li_row_ok(o.status) OR (o.status = 'duplicate' AND o.normalized ? 'match_id'))
    UNION ALL
    SELECT coalesce(o.normalized ->> 'client_id', o.normalized ->> 'client_row'), o.normalized ? 'client_id'
      FROM public.legacy_import_rows o
     WHERE o.run_id = v.id AND o.entity = 'aliases' AND o.normalized ->> 'alias_norm' = v_norm
       AND (app.li_row_ok(o.status) OR o.status = 'duplicate')) z
   WHERE z.ref IS NOT NULL;
  IF r.n = 1 THEN RETURN CASE WHEN r.is_id THEN jsonb_build_object('id', r.ref) ELSE jsonb_build_object('row', r.ref) END; END IF;
  IF r.n > 1 THEN RETURN jsonb_build_object('err', 'client_ambiguous'); END IF;
  RETURN jsonb_build_object('err', 'client_not_found');
END $$;

-- the transaction of a child row (containers / movements / payments): by the legacy «رقم المعاملة» or the sequence; this run's
-- transactions rows first, then the committed rows of the org's committed runs, then Marsa transactions with that legacy_ref.
-- → {row, n (its normalized)} | {id} | {err transaction_not_found | parent_invalid}
CREATE OR REPLACE FUNCTION app.li_find_tx(v public.legacy_import_runs, p_lid text, p_seq text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; t uuid;
BEGIN
  IF p_lid IS NULL AND p_seq IS NULL THEN RETURN jsonb_build_object('err', 'transaction_not_found'); END IF;
  -- one equality per branch (review fix: index lookups, not a scan of the run per child row)
  IF p_lid IS NOT NULL THEN
    SELECT o.id, o.status, o.normalized, o.target_id INTO r FROM public.legacy_import_rows o
     WHERE o.run_id = v.id AND o.entity = 'transactions' AND o.normalized ->> 'legacy_id' = p_lid
     ORDER BY (o.status IN ('valid','warning','committed')) DESC, o.sheet, o.row_no, o.id LIMIT 1;
  ELSE
    SELECT o.id, o.status, o.normalized, o.target_id INTO r FROM public.legacy_import_rows o
     WHERE o.run_id = v.id AND o.entity = 'transactions' AND o.normalized ->> 'seq' = p_seq
     ORDER BY (o.status IN ('valid','warning','committed')) DESC, o.sheet, o.row_no, o.id LIMIT 1;
  END IF;
  IF r.id IS NOT NULL THEN
    IF r.status = 'committed' THEN RETURN jsonb_build_object('id', r.target_id, 'n', r.normalized); END IF;
    IF r.status IN ('valid','warning') THEN RETURN jsonb_build_object('row', r.id, 'n', r.normalized); END IF;
    IF r.status = 'duplicate' AND r.normalized ? 'match_id' THEN RETURN jsonb_build_object('id', r.normalized ->> 'match_id'); END IF;
    RETURN jsonb_build_object('err', 'parent_invalid', 'detail', r.status);
  END IF;
  IF p_lid IS NOT NULL THEN
    SELECT o.target_id INTO t FROM public.legacy_import_rows o JOIN public.legacy_import_runs ru ON ru.id = o.run_id
     WHERE o.org_id = v.org_id AND o.entity = 'transactions' AND o.status = 'committed' AND ru.status = 'committed' AND ru.id <> v.id
       AND o.normalized ->> 'legacy_id' = p_lid
     ORDER BY o.committed_at DESC LIMIT 1;
  ELSE
    SELECT o.target_id INTO t FROM public.legacy_import_rows o JOIN public.legacy_import_runs ru ON ru.id = o.run_id
     WHERE o.org_id = v.org_id AND o.entity = 'transactions' AND o.status = 'committed' AND ru.status = 'committed' AND ru.id <> v.id
       AND o.normalized ->> 'seq' = p_seq
     ORDER BY o.committed_at DESC LIMIT 1;
  END IF;
  IF t IS NOT NULL THEN RETURN jsonb_build_object('id', t); END IF;
  SELECT x.id INTO t FROM public.transactions x
   WHERE x.org_id = v.org_id AND x.cancelled_at IS NULL AND x.legacy_ref = coalesce(p_seq, p_lid) ORDER BY x.created_at DESC LIMIT 1;
  IF t IS NOT NULL THEN RETURN jsonb_build_object('id', t); END IF;
  RETURN jsonb_build_object('err', 'transaction_not_found');
END $$;
-- a run reference ({id} / {row}) → the Marsa id now (a row must be committed; else NULL)
CREATE OR REPLACE FUNCTION app.li_resolve(p_id text, p_row text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN p_id IS NOT NULL THEN p_id::uuid
              ELSE (SELECT o.target_id FROM public.legacy_import_rows o WHERE o.id = p_row::uuid AND o.status = 'committed') END
$$;
-- the fingerprint of a created row (app.li_fps: volatile usage columns left out); NULL when the row is gone
CREATE OR REPLACE FUNCTION app.li_fp(p_table text, p_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN (SELECT f.fp FROM app.li_fps(p_table, ARRAY[p_id]) f);
END $$;
-- per entity / status counts of a run
CREATE OR REPLACE FUNCTION app.li_counts(p_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'total', (SELECT count(*)::int FROM public.legacy_import_rows o WHERE o.run_id = p_run),
    'by_status', coalesce((SELECT jsonb_object_agg(z.status, z.n) FROM (
        SELECT o.status, count(*)::int n FROM public.legacy_import_rows o WHERE o.run_id = p_run GROUP BY 1) z), '{}'::jsonb),
    'by_entity', coalesce((SELECT jsonb_object_agg(z.entity, z.v) FROM (
        SELECT y.entity, jsonb_object_agg(y.status, y.n) || jsonb_build_object('total', sum(y.n)::int) v FROM (
          SELECT o.entity, o.status, count(*)::int n FROM public.legacy_import_rows o WHERE o.run_id = p_run GROUP BY 1, 2) y
         GROUP BY y.entity) z), '{}'::jsonb))
$$;
-- the processing order of the entities (dependency order). No SET clause on purpose (review fix): it stays inlinable in the
-- ORDER BY of the listings; it only calls pg_catalog.array_position
CREATE OR REPLACE FUNCTION app.li_rank(p_entity text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_catalog.array_position(ARRAY['customers','aliases','drivers','transactions','containers','movements','payments','custody']::text[], p_entity)
$$;
-- the entities in dependency order
CREATE OR REPLACE FUNCTION app.li_entities() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['customers','aliases','drivers','transactions','containers','movements','payments','custody']::text[]
$$;
-- the first entity (dependency order) of a run that still has rows in one of the statuses → its name, or NULL (8 index probes:
-- review fix, the loops of validate / commit / void read one entity at a time instead of re-scanning the run per row)
CREATE OR REPLACE FUNCTION app.li_next_entity(p_run uuid, p_status text[], p_void boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE e text; v_ents text[] := app.li_entities();
BEGIN
  IF p_void THEN v_ents := ARRAY(SELECT x FROM unnest(v_ents) WITH ORDINALITY u(x, o) ORDER BY o DESC); END IF;
  FOREACH e IN ARRAY v_ents LOOP
    IF EXISTS (SELECT 1 FROM public.legacy_import_rows o WHERE o.run_id = p_run AND o.entity = e AND o.status = ANY (p_status)
                  AND (NOT p_void OR o.voided_at IS NULL)) THEN
      RETURN e;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
-- the status of a checked row from its messages (+ duplicate / skip markers)
CREATE OR REPLACE FUNCTION app.li_status_of(p_m jsonb, p_dup boolean, p_skip boolean) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_m) e WHERE e ->> 'level' = 'error') THEN 'error'
              WHEN coalesce(p_skip, false) THEN 'skipped'
              WHEN coalesce(p_dup, false) THEN 'duplicate'
              WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_m) e WHERE e ->> 'level' = 'warning') THEN 'warning'
              ELSE 'valid' END
$$;
-- an earlier row of the same run + entity (processing order) sharing one of the keys, still importable → its id
CREATE OR REPLACE FUNCTION app.li_dup_row(r public.legacy_import_rows, p_keys text[]) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  -- the keys GIN index first (review fix: never a scan of the whole run per row), then the run / order filters
  WITH c AS MATERIALIZED (
    SELECT o.id, o.run_id, o.entity, o.status, o.sheet, o.row_no FROM public.legacy_import_rows o
     WHERE cardinality(p_keys) > 0 AND (o.normalized -> 'keys') ?| p_keys)
  SELECT c.id FROM c
   WHERE c.run_id = r.run_id AND c.entity = r.entity AND c.id <> r.id AND app.li_row_ok(c.status)
     AND (c.sheet, c.row_no, c.id) < (r.sheet, r.row_no, r.id)
   ORDER BY c.sheet, c.row_no, c.id LIMIT 1
$$;
-- the planner statistics of the staged rows, refreshed when many rows changed since the last ANALYZE (review fix: a big run is
-- staged / validated within minutes, before autovacuum analyses it; stale estimates turn the index lookups of the checks into scans)
CREATE OR REPLACE FUNCTION app.li_analyze() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_mod bigint; v_n real;
BEGIN
  SELECT s.n_mod_since_analyze, c.reltuples INTO v_mod, v_n FROM pg_catalog.pg_stat_user_tables s JOIN pg_catalog.pg_class c ON c.oid = s.relid
   WHERE s.relid = 'public.legacy_import_rows'::regclass;
  IF coalesce(v_mod, 0) > greatest(500, coalesce(v_n, 0) * 0.2) THEN
    ANALYZE public.legacy_import_rows;
  END IF;
EXCEPTION WHEN others THEN
  RETURN;   -- statistics are an optimisation only
END $$;

-- ---------------------------------------------------------------------
-- per-entity checks: (row, run, ctx) → {n (normalized), m (messages), dup, skip}. The same rules as the normal writes (table
-- CHECKs, the duplicate guards of step 2, the payment / custody rules of step 6), run without writing; the commit re-checks.
-- ---------------------------------------------------------------------
-- text of at most p_max characters (else an error message)
CREATE OR REPLACE FUNCTION app.li_t(p jsonb, k text, p_max int, INOUT m jsonb, OUT v text)
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  v := app.li_s(p, k);
  IF v IS NOT NULL AND char_length(v) > p_max THEN m := m || app.li_m('error', 'too_long', k, p_max::text); v := NULL; END IF;
END $$;

-- customers (legacy «دليل العملاء»)
CREATE OR REPLACE FUNCTION app.li_check_customers(r public.legacy_import_rows, v public.legacy_import_runs, ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := r.raw; m jsonb := '[]'::jsonb; n jsonb; x record; v_ar text; v_en text; v_code text; v_vat text; v_cr text;
        v_phone text; v_mail text; v_cat text; v_active boolean := true; v_city text; v_notes text; v_keys text[] := '{}';
        v_match uuid; v_other uuid; v_dup boolean := false; v_d uuid; s text;
BEGIN
  SELECT * INTO x FROM app.li_t(p, 'name_ar', 160, m); m := x.m; v_ar := x.v;
  SELECT * INTO x FROM app.li_t(p, 'name_en', 160, m); m := x.m; v_en := x.v;
  IF v_ar IS NULL AND v_en IS NULL THEN m := m || app.li_m('error', 'name_required', 'name_ar');
  ELSIF v_ar IS NULL THEN v_ar := v_en; m := m || app.li_m('warning', 'name_from_english', 'name_ar');
  END IF;
  IF v_ar IS NOT NULL AND char_length(v_ar) < 2 THEN m := m || app.li_m('error', 'name_required', 'name_ar'); END IF;
  v_code := app.li_client_code(app.li_s(p, 'daftra_code'));
  IF v_code = 'x' THEN m := m || app.li_m('error', 'daftra_code_invalid', 'daftra_code', app.li_s(p, 'daftra_code')); v_code := NULL; END IF;
  s := app.li_s(p, 'vat_number');
  IF s IS NOT NULL THEN
    v_vat := regexp_replace(app.to_western(s), '[^0-9]', '', 'g');
    IF v_vat !~ '^[0-9]{15}$' THEN m := m || app.li_m('warning', 'vat_invalid', 'vat_number', s); v_vat := NULL; END IF;
  END IF;
  s := app.li_s(p, 'cr_number');
  IF s IS NOT NULL THEN
    v_cr := regexp_replace(app.to_western(s), '[^0-9]', '', 'g');
    IF v_cr !~ '^[0-9]{10}$' THEN m := m || app.li_m('warning', 'cr_invalid', 'cr_number', s); v_cr := NULL; END IF;
  END IF;
  s := app.li_s(p, 'phone');
  IF s IS NOT NULL THEN
    v_phone := app.norm_sa_phone(s, true);
    IF v_phone IS NULL THEN m := m || app.li_m('warning', 'phone_invalid', 'phone', s); END IF;
  END IF;
  s := app.li_s(p, 'email');
  IF s IS NOT NULL THEN
    v_mail := lower(s);
    IF char_length(v_mail) > 160 OR v_mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' THEN
      m := m || app.li_m('warning', 'email_invalid', 'email', s); v_mail := NULL;
    END IF;
  END IF;
  s := app.li_s(p, 'port_category');
  IF s IS NOT NULL THEN
    v_cat := app.li_pick(s, ARRAY[['مطار وميناء','shared'],['ميناء ومطار','shared'],['مشترك','shared'],['المطار','airport'],['مطار','airport'],
                                  ['الميناء','port'],['ميناء','port'],['airport','airport'],['port','port'],['shared','shared']]);
    IF v_cat IS NULL THEN m := m || app.li_m('warning', 'category_unknown', 'port_category', s); END IF;
  END IF;
  s := app.li_key(app.li_s(p, 'status'));
  IF s IS NOT NULL AND (position(app.li_key('موقوف') IN s) > 0 OR position(app.li_key('غير نشط') IN s) > 0 OR s IN ('inactive','disabled')) THEN
    v_active := false;
  END IF;
  SELECT * INTO x FROM app.li_t(p, 'city', 80, m); m := x.m; v_city := x.v;
  SELECT * INTO x FROM app.li_t(p, 'notes', 2000, m); m := x.m; v_notes := x.v;
  -- the same client already in Marsa: the Daftra code, else the VAT / CR number, else exactly one client of that name
  IF v_code IS NOT NULL THEN
    SELECT c.id INTO v_match FROM public.clients c WHERE c.org_id = v.org_id AND upper(c.daftra_client_code) = upper(v_code);
  END IF;
  IF v_vat IS NOT NULL THEN
    SELECT c.id INTO v_other FROM public.clients c WHERE c.org_id = v.org_id AND c.vat_number = v_vat;
    IF v_other IS NOT NULL AND v_match IS NOT NULL AND v_other <> v_match THEN m := m || app.li_m('error', 'vat_taken', 'vat_number', v_vat);
    ELSIF v_other IS NOT NULL AND v_match IS NULL THEN
      IF v_code IS NOT NULL AND (SELECT c.daftra_client_code FROM public.clients c WHERE c.id = v_other) IS NOT NULL THEN
        m := m || app.li_m('error', 'vat_taken', 'vat_number', v_vat);
      ELSE v_match := v_other; END IF;
    END IF;
  END IF;
  IF v_cr IS NOT NULL THEN
    SELECT c.id INTO v_other FROM public.clients c WHERE c.org_id = v.org_id AND c.cr_number = v_cr;
    IF v_other IS NOT NULL AND v_match IS NOT NULL AND v_other <> v_match THEN m := m || app.li_m('error', 'cr_taken', 'cr_number', v_cr);
    ELSIF v_other IS NOT NULL AND v_match IS NULL THEN v_match := v_other;
    END IF;
  END IF;
  IF v_match IS NULL AND v_code IS NULL AND v_ar IS NOT NULL THEN
    IF jsonb_array_length(coalesce(ctx -> 'clients' -> app.norm_name(v_ar), '[]'::jsonb)) = 1 THEN
      v_match := (ctx -> 'clients' -> app.norm_name(v_ar) ->> 0)::uuid;
    ELSIF jsonb_array_length(coalesce(ctx -> 'clients' -> app.norm_name(v_ar), '[]'::jsonb)) > 1 THEN
      m := m || app.li_m('error', 'client_ambiguous', 'name_ar', v_ar);
    END IF;
  END IF;
  IF v_match IS NOT NULL THEN
    v_dup := true; m := m || app.li_m('info', 'exists_in_marsa', NULL, (SELECT c.name_ar FROM public.clients c WHERE c.id = v_match));
  END IF;
  -- inside the file: the same code / VAT / CR (or the same name without a code)
  IF v_code IS NOT NULL THEN v_keys := v_keys || ('c:' || upper(v_code)); END IF;
  IF v_vat IS NOT NULL THEN v_keys := v_keys || ('v:' || v_vat); END IF;
  IF v_cr IS NOT NULL THEN v_keys := v_keys || ('r:' || v_cr); END IF;
  IF v_code IS NULL AND app.norm_name(v_ar) IS NOT NULL THEN v_keys := v_keys || ('n:' || app.norm_name(v_ar)); END IF;
  IF NOT v_dup THEN
    v_d := app.li_dup_row(r, v_keys);
    IF v_d IS NOT NULL THEN v_dup := true; m := m || app.li_m('warning', 'duplicate_in_file', NULL, app.li_row_label(v_d)); END IF;
  END IF;
  n := jsonb_strip_nulls(jsonb_build_object('name_ar', v_ar, 'name_en', v_en, 'code', v_code, 'vat_number', v_vat, 'cr_number', v_cr,
    'phone', v_phone, 'email', v_mail, 'port_category', v_cat, 'is_active', v_active, 'city', v_city, 'notes', v_notes,
    'name_norm', app.norm_name(v_ar), 'name_en_norm', app.norm_name(v_en), 'keys', to_jsonb(v_keys), 'match_id', v_match,
    'dup_of', v_d));
  RETURN jsonb_build_object('n', n, 'm', m, 'dup', v_dup);
END $$;

-- customer aliases (legacy «أسماء العملاء البديلة»): imported 'suggested' (never approved by an import)
CREATE OR REPLACE FUNCTION app.li_check_aliases(r public.legacy_import_rows, v public.legacy_import_runs, ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := r.raw; m jsonb := '[]'::jsonb; x record; v_alias text; v_norm text; v_cl jsonb; v_src text; v_conf numeric; v_occ numeric;
        v_used timestamptz; v_ref text; v_dup boolean := false; v_skip boolean := false; v_ex public.client_aliases; v_d uuid; s text;
BEGIN
  SELECT * INTO x FROM app.li_t(p, 'alias', 160, m); m := x.m; v_alias := x.v;
  IF v_alias IS NULL OR char_length(v_alias) < 2 THEN m := m || app.li_m('error', 'required', 'alias'); END IF;
  v_norm := app.norm_name(v_alias);
  IF v_alias IS NOT NULL AND v_norm IS NULL THEN m := m || app.li_m('error', 'required', 'alias'); END IF;
  v_cl := app.li_find_client(v, ctx, app.li_s(p, 'client_code'), app.li_s(p, 'client_name'));
  IF v_cl ? 'err' THEN m := m || app.li_m('error', v_cl ->> 'err', 'client_name', coalesce(app.li_s(p, 'client_name'), app.li_s(p, 'client_code'))); END IF;
  v_src := coalesce(app.li_pick(app.li_s(p, 'source_type'), ARRAY[['بوليصة','bl'],['بوليصه الشحن','bl'],['bl','bl'],['فاتورة','invoice'],
                                     ['invoice','invoice'],['قراءة آلية','ocr'],['ocr','ocr']]), 'manual');
  SELECT * INTO x FROM app.li_t(p, 'source_ref', 120, m); m := x.m; v_ref := x.v;
  s := app.li_s(p, 'confidence');
  IF s IS NOT NULL THEN
    v_conf := app.li_money(replace(s, '%', ''));
    IF v_conf = 'NaN' OR v_conf < 0 OR v_conf > 100 THEN v_conf := NULL; END IF;
    IF v_conf IS NOT NULL AND v_conf <= 1 AND s !~ '%' AND s ~ '\.' THEN v_conf := v_conf * 100; END IF;
  END IF;
  v_occ := app.li_money(app.li_s(p, 'occurrences'));
  IF v_occ = 'NaN' OR v_occ < 1 OR v_occ <> trunc(v_occ) THEN v_occ := NULL; END IF;
  v_used := app.li_ts(app.li_s(p, 'last_used'));
  s := app.li_key(app.li_s(p, 'status'));
  IF s IS NOT NULL AND (position(app.li_key('مرفوض') IN s) > 0 OR s = 'rejected') THEN
    v_skip := true; m := m || app.li_m('info', 'alias_rejected_skipped');
  ELSE
    m := m || app.li_m('info', 'alias_suggested');
  END IF;
  IF v_norm IS NOT NULL THEN
    SELECT * INTO v_ex FROM public.client_aliases a WHERE a.org_id = v.org_id AND a.alias_norm = v_norm;
    IF v_ex.id IS NOT NULL THEN
      IF v_cl ->> 'id' IS NOT NULL AND v_ex.client_id = (v_cl ->> 'id')::uuid THEN
        v_dup := true; m := m || app.li_m('info', 'exists_in_marsa', 'alias', v_alias);
      ELSE
        m := m || app.li_m('error', 'alias_taken', 'alias', (SELECT c.name_ar FROM public.clients c WHERE c.id = v_ex.client_id));
      END IF;
    END IF;
    IF NOT v_dup AND NOT v_skip THEN
      v_d := app.li_dup_row(r, ARRAY['a:' || v_norm]);
      IF v_d IS NOT NULL THEN v_dup := true; m := m || app.li_m('warning', 'duplicate_in_file', NULL, app.li_row_label(v_d)); END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('n', jsonb_strip_nulls(jsonb_build_object('alias', v_alias, 'alias_norm', v_norm, 'client_id', v_cl ->> 'id',
      'client_row', v_cl ->> 'row', 'source', v_src, 'source_ref', v_ref, 'confidence', round(v_conf), 'occurrences', v_occ,
      'last_used_at', v_used, 'keys', CASE WHEN v_norm IS NOT NULL AND NOT v_skip THEN jsonb_build_array('a:' || v_norm) END)),
    'm', m, 'dup', v_dup, 'skip', v_skip);
END $$;

-- a driver name / phone / plate → the existing driver ({id}), a drivers row of the run ({row}) or a new one ({new}); the plate → truck
CREATE OR REPLACE FUNCTION app.li_driver_of(v public.legacy_import_runs, ctx jsonb, p_name text, p_phone text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id text; v_row uuid;
BEGIN
  IF p_phone IS NOT NULL THEN v_id := ctx -> 'drivers_phone' ->> p_phone; END IF;
  IF v_id IS NULL AND p_name IS NOT NULL AND p_phone IS NULL THEN v_id := ctx -> 'drivers_name' -> app.norm_name(p_name) ->> 0; END IF;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('id', v_id); END IF;
  SELECT o.id INTO v_row FROM public.legacy_import_rows o
   WHERE o.run_id = v.id AND o.entity = 'drivers' AND app.li_row_ok(o.status)
     AND ((p_phone IS NOT NULL AND o.normalized ->> 'phone' = p_phone)
          OR (p_phone IS NULL AND p_name IS NOT NULL AND o.normalized ->> 'name_norm' = app.norm_name(p_name)))
   ORDER BY o.sheet, o.row_no LIMIT 1;
  IF v_row IS NOT NULL THEN RETURN jsonb_build_object('row', v_row); END IF;
  SELECT o.normalized ->> 'match_id' INTO v_id FROM public.legacy_import_rows o
   WHERE o.run_id = v.id AND o.entity = 'drivers' AND o.status = 'duplicate' AND o.normalized ? 'match_id'
     AND ((p_phone IS NOT NULL AND o.normalized ->> 'phone' = p_phone)
          OR (p_phone IS NULL AND p_name IS NOT NULL AND o.normalized ->> 'name_norm' = app.norm_name(p_name)))
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('id', v_id); END IF;
  IF p_name IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('new', true);
END $$;
CREATE OR REPLACE FUNCTION app.li_plate(p text) RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE WHEN x IS NOT NULL AND char_length(x) BETWEEN 2 AND 20 AND x !~ '[[:space:]]' THEN x END
    FROM (SELECT app.norm_code(replace(translate(p, 'أإآ', 'ااا'), '-', '')) x) z
$$;

-- drivers (legacy «السائقون»)
CREATE OR REPLACE FUNCTION app.li_check_drivers(r public.legacy_import_rows, v public.legacy_import_runs, ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := r.raw; m jsonb := '[]'::jsonb; x record; v_name text; v_phone text; v_plate text; v_truck uuid; v_match text;
        v_dup boolean := false; v_d uuid; s text; v_keys text[] := '{}';
BEGIN
  SELECT * INTO x FROM app.li_t(p, 'name', 120, m); m := x.m; v_name := x.v;
  IF v_name IS NULL OR char_length(v_name) < 2 THEN m := m || app.li_m('error', 'required', 'name'); END IF;
  s := app.li_s(p, 'phone');
  IF s IS NOT NULL THEN
    v_phone := app.norm_sa_phone(s, false);
    IF v_phone IS NULL THEN m := m || app.li_m('warning', 'driver_phone_invalid', 'phone', s); END IF;
  END IF;
  s := app.li_s(p, 'truck_plate');
  IF s IS NOT NULL THEN
    v_plate := app.li_plate(s);
    IF v_plate IS NULL THEN m := m || app.li_m('warning', 'plate_invalid', 'truck_plate', s);
    ELSE
      SELECT t.id INTO v_truck FROM public.trucks t WHERE t.org_id = v.org_id AND t.plate_no = v_plate;
      IF v_truck IS NULL THEN m := m || app.li_m('info', 'truck_created', 'truck_plate', v_plate); END IF;
    END IF;
  END IF;
  IF v_phone IS NOT NULL THEN v_match := ctx -> 'drivers_phone' ->> v_phone;
  ELSIF v_name IS NOT NULL THEN v_match := ctx -> 'drivers_name' -> app.norm_name(v_name) ->> 0;
  END IF;
  IF v_match IS NOT NULL THEN v_dup := true; m := m || app.li_m('info', 'exists_in_marsa', NULL, v_name); END IF;
  v_keys := CASE WHEN v_phone IS NOT NULL THEN ARRAY['p:' || v_phone] WHEN app.norm_name(v_name) IS NOT NULL THEN ARRAY['n:' || app.norm_name(v_name)] ELSE '{}' END;
  IF NOT v_dup THEN
    v_d := app.li_dup_row(r, v_keys);
    IF v_d IS NOT NULL THEN v_dup := true; m := m || app.li_m('warning', 'duplicate_in_file', NULL, app.li_row_label(v_d)); END IF;
  END IF;
  RETURN jsonb_build_object('n', jsonb_strip_nulls(jsonb_build_object('name', v_name, 'name_norm', app.norm_name(v_name), 'phone', v_phone,
      'plate', v_plate, 'truck_id', v_truck, 'match_id', v_match, 'keys', to_jsonb(v_keys))), 'm', m, 'dup', v_dup);
END $$;

-- transactions (legacy «المعاملات» 37 columns, or the older «قاعدة البيانات» sheet of migrateLegacyTransactions)
CREATE OR REPLACE FUNCTION app.li_check_transactions(r public.legacy_import_rows, v public.legacy_import_runs, ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := r.raw; m jsonb := '[]'::jsonb; x record; s text; v_lid text; v_seq text; v_ref text; v_branch uuid; v_cl jsonb; v_cargo text;
  v_bl text; v_ctrs text[] := '{}'; c text; v_chassis text; v_plate text; v_port text; v_kind text; v_mode text; v_dtype text; v_op text;
  v_decl text; v_ddate date; v_dstat text; v_hijri text; v_status text; v_fin text := 'not_started'; v_tmode text; v_order text;
  v_odate date; v_tparty uuid; v_term uuid; v_line text; v_vessel text; v_ttype text; v_created timestamptz; v_notes text[] := '{}';
  v_dnotes text; v_keys text[] := '{}'; v_dup boolean := false; v_match uuid; v_d uuid; v_conf record; v_tx public.transactions;
  v_req text[] := '{}';
BEGIN
  SELECT * INTO x FROM app.li_t(p, 'legacy_id', 60, m); m := x.m; v_lid := x.v;
  SELECT * INTO x FROM app.li_t(p, 'seq', 40, m); m := x.m; v_seq := app.to_western(x.v);
  IF v_seq ~ '^[0-9]+(\.0+)?$' THEN v_seq := regexp_replace(v_seq, '\.0+$', ''); END IF;
  v_ref := left(coalesce(v_seq, v_lid), 40);
  -- branch
  v_branch := app.li_branch(v, app.li_s(p, 'branch'));
  IF v_branch IS NULL THEN
    m := m || app.li_m('error', CASE WHEN app.li_s(p, 'branch') IS NULL THEN 'branch_required' ELSE 'branch_unknown' END, 'branch', app.li_s(p, 'branch'));
  END IF;
  -- client (Daftra code, then the importer name)
  v_cl := app.li_find_client(v, ctx, app.li_s(p, 'client_code'), app.li_s(p, 'importer'));
  IF v_cl ? 'err' THEN m := m || app.li_m('error', v_cl ->> 'err', 'importer', coalesce(app.li_s(p, 'importer'), app.li_s(p, 'client_code'))); END IF;
  IF (v_cl ->> 'inactive')::boolean THEN m := m || app.li_m('warning', 'inactive_match', 'importer'); END IF;
  -- B/L (required, like the legacy validateTransaction_)
  v_bl := nullif(upper(regexp_replace(app.to_western(coalesce(app.li_s(p, 'bl_number'), '')), '[[:space:]]+', '', 'g')), '');
  IF v_bl IS NULL THEN m := m || app.li_m('error', 'bl_required', 'bl_number');
  ELSIF char_length(v_bl) > 40 THEN m := m || app.li_m('error', 'too_long', 'bl_number', '40'); v_bl := NULL;
  END IF;
  -- cargo unit: container(s) or a Ro-Ro vehicle (chassis + plate)
  v_cargo := app.li_cargo(app.li_s(p, 'cargo_unit_type'));
  IF v_cargo = 'container' AND app.li_s(p, 'container_no') IS NULL AND app.li_s(p, 'chassis_no') IS NOT NULL
     AND app.li_s(p, 'cargo_unit_type') IS NULL THEN
    v_cargo := 'roro';
  END IF;
  IF v_cargo = 'roro' THEN
    v_chassis := app.norm_chassis(app.li_s(p, 'chassis_no'));
    IF v_chassis IS NULL OR v_chassis !~ '^[A-Z0-9]{4,30}$' THEN m := m || app.li_m('error', 'chassis_required', 'chassis_no', app.li_s(p, 'chassis_no')); v_chassis := NULL; END IF;
    IF app.li_s(p, 'plate_no') IS NOT NULL THEN
      v_plate := app.li_plate(app.li_s(p, 'plate_no'));
      IF v_plate IS NULL THEN m := m || app.li_m('warning', 'plate_invalid', 'plate_no', app.li_s(p, 'plate_no')); END IF;
    END IF;
    IF app.li_s(p, 'container_no') IS NOT NULL THEN m := m || app.li_m('warning', 'roro_containers_ignored', 'container_no'); END IF;
  ELSE
    v_ctrs := app.li_containers(app.li_s(p, 'container_no'));
    IF app.li_containers_rest(app.li_s(p, 'container_no')) THEN m := m || app.li_m('error', 'container_format', 'container_no', app.li_s(p, 'container_no')); END IF;
    FOREACH c IN ARRAY v_ctrs LOOP
      IF NOT app.msg_iso6346_ok(c) THEN m := m || app.li_m('warning', 'container_check_digit', 'container_no', c); END IF;
    END LOOP;
    IF cardinality(v_ctrs) = 0 AND NOT EXISTS (
         SELECT 1 FROM public.legacy_import_rows o WHERE o.run_id = v.id AND o.entity = 'containers'
            AND ((v_lid IS NOT NULL AND btrim(o.raw ->> 'tx_legacy_id') = v_lid) OR (v_lid IS NULL AND v_seq IS NOT NULL AND btrim(o.raw ->> 'tx_seq') = v_seq))) THEN
      m := m || app.li_m('error', 'containers_required', 'container_no');
    END IF;
  END IF;
  -- port (approved ports only), mode from the port kind
  s := app.li_s(p, 'port');
  IF s IS NULL THEN m := m || app.li_m('warning', 'port_missing', 'port');
  ELSE
    v_port := app.li_port(v, s);
    IF v_port IS NULL THEN m := m || app.li_m('error', 'port_unknown', 'port', s); END IF;
  END IF;
  SELECT cp.kind INTO v_kind FROM public.customs_ports cp WHERE cp.code = v_port;
  v_mode := CASE v_kind WHEN 'air' THEN 'air' WHEN 'dry' THEN 'land' ELSE 'sea' END;
  -- declaration
  v_dtype := app.norm_declaration_type(app.li_s(p, 'declaration_type'));
  IF app.li_s(p, 'declaration_type') IS NOT NULL AND v_dtype IS NULL THEN m := m || app.li_m('warning', 'declaration_type_unknown', 'declaration_type', app.li_s(p, 'declaration_type')); END IF;
  v_op := CASE WHEN v_dtype = 'export' THEN 'export' ELSE 'import' END;
  v_decl := nullif(upper(regexp_replace(app.to_western(coalesce(app.li_s(p, 'declaration_no'), '')), '[[:space:]]+', '', 'g')), '');
  IF char_length(v_decl) > 30 THEN m := m || app.li_m('error', 'too_long', 'declaration_no', '30'); v_decl := NULL; END IF;
  IF v_decl IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.org_id = v.org_id AND d.declaration_no = v_decl AND d.status NOT IN ('cancelled','replaced'))
       OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.org_id = v.org_id AND t.declaration_no = v_decl) THEN
      v_match := (SELECT d.transaction_id FROM public.customs_declarations d WHERE d.org_id = v.org_id AND d.declaration_no = v_decl
                     AND d.status NOT IN ('cancelled','replaced') LIMIT 1);
    END IF;
    v_ddate := app.li_date(app.li_s(p, 'declaration_date'));
    IF app.li_s(p, 'declaration_date') IS NOT NULL AND v_ddate IS NULL THEN m := m || app.li_m('warning', 'invalid_date', 'declaration_date', app.li_s(p, 'declaration_date')); END IF;
    v_dstat := app.norm_declaration_status(app.li_s(p, 'declaration_status'));
    IF v_dstat IS NULL THEN
      IF app.li_s(p, 'declaration_status') IS NOT NULL THEN m := m || app.li_m('warning', 'declaration_status_unknown', 'declaration_status', app.li_s(p, 'declaration_status')); END IF;
      v_dstat := 'submitted';
    END IF;
    IF app.li_s(p, 'declaration_date_hijri') IS NOT NULL THEN
      v_hijri := app.norm_hijri_date(app.li_s(p, 'declaration_date_hijri'));
      IF v_hijri IS NULL THEN m := m || app.li_m('warning', 'hijri_invalid', 'declaration_date_hijri', app.li_s(p, 'declaration_date_hijri')); END IF;
    END IF;
  END IF;
  SELECT * INTO x FROM app.li_t(p, 'declaration_notes', 2000, m); m := x.m; v_dnotes := x.v;
  -- operational status legacy → Marsa (owner decisions: no billing without the empty-return proof; historical billed = billed)
  s := app.li_s(p, 'operational_status');
  v_status := app.li_tx_status(s);
  IF app.li_s(p, 'operationally_done') IS NOT NULL AND app.li_key(app.li_s(p, 'operationally_done')) IN ('true','yes','1', app.li_key('نعم'), app.li_key('صح')) THEN
    v_status := coalesce(nullif(v_status, 'new'), 'operationally_complete');
  END IF;
  IF s IS NOT NULL AND v_status IS NULL THEN m := m || app.li_m('warning', 'status_unknown', 'operational_status', s); v_status := 'new'; END IF;
  IF v_status IS NULL THEN v_status := CASE WHEN v_decl IS NOT NULL THEN 'customs_declaration' ELSE 'new' END; END IF;
  IF v_status = 'active' THEN v_status := CASE WHEN v_decl IS NOT NULL THEN 'customs_declaration' ELSE 'in_progress' END; END IF;
  IF v_status = 'under_billing' AND v_cargo = 'container' THEN
    v_status := 'operationally_complete'; m := m || app.li_m('warning', 'needs_empty_return_proof', 'operational_status');
  END IF;
  IF v_status = 'billed' THEN v_fin := 'invoiced'; m := m || app.li_m('info', 'status_billed_historical', 'operational_status'); END IF;
  IF v_status = 'closed' THEN v_status := 'billed'; v_fin := 'invoiced'; m := m || app.li_m('info', 'status_billed_historical', 'operational_status'); END IF;
  -- transport: mode, the TASTO order, the company
  v_tmode := app.li_pick(app.li_s(p, 'transport_mode'), ARRAY[['أمر نقل لشركة نقل','carrier_order'],['شركة نقل','carrier_order'],
               ['company','carrier_order'],['موعد ونقل بواسطة سائق','driver'],['نقل بالسائق','driver'],['driver','driver']]);
  v_order := app.norm_code(app.li_s(p, 'transport_order_no'));
  IF v_order IS NOT NULL THEN
    IF v_order !~ '^TASTO[0-9]{1,20}$' THEN m := m || app.li_m('error', 'transport_order_invalid', 'transport_order_no', v_order); v_order := NULL;
    ELSE
      v_tmode := 'carrier_order';
      IF EXISTS (SELECT 1 FROM public.transactions t WHERE t.org_id = v.org_id AND t.transport_order_no = v_order AND t.cancelled_at IS NULL) THEN
        m := m || app.li_m('error', 'transport_order_taken', 'transport_order_no', v_order);
      ELSIF EXISTS (SELECT 1 FROM public.legacy_import_rows o WHERE o.run_id = v.id AND o.entity = 'transactions' AND o.id <> r.id
                       AND app.li_row_ok(o.status) AND o.normalized ->> 'transport_order_no' = v_order
                       AND (o.sheet, o.row_no, o.id) < (r.sheet, r.row_no, r.id)) THEN
        m := m || app.li_m('error', 'transport_order_taken', 'transport_order_no', v_order);
      END IF;
    END IF;
    v_odate := app.li_date(app.li_s(p, 'transport_order_date'));
  END IF;
  IF v_tmode IS DISTINCT FROM 'carrier_order' THEN v_odate := NULL; END IF;
  s := app.li_s(p, 'transport_company');
  IF s IS NOT NULL THEN
    v_tparty := app.li_party(ctx, s, ARRAY['carrier']);
    IF v_tparty IS NULL THEN m := m || app.li_m('warning', 'transport_company_unknown', 'transport_company', s); v_notes := v_notes || ('شركة النقل: ' || s); END IF;
  END IF;
  s := app.li_s(p, 'operator');
  IF s IS NOT NULL THEN
    v_term := app.li_party(ctx, s, ARRAY['terminal_operator']);
    IF v_term IS NOT NULL AND v_port IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.party_ports pp WHERE pp.party_id = v_term AND pp.is_active)
       AND NOT EXISTS (SELECT 1 FROM public.party_ports pp WHERE pp.party_id = v_term AND pp.is_active AND pp.port_code = v_port) THEN
      v_term := NULL;
    END IF;
    IF v_term IS NULL THEN m := m || app.li_m('warning', 'operator_unknown', 'operator', s); v_notes := v_notes || ('المشغل: ' || s); END IF;
  END IF;
  v_line := left(app.li_s(p, 'shipping_agent'), 80);
  v_vessel := left(app.li_s(p, 'vessel'), 80);
  v_ttype := CASE WHEN position(app.li_key('إعادة تصدير') IN coalesce(app.li_key(app.li_s(p, 'transaction_type')), '')) > 0
                    OR position(app.li_key('إعادة صادر') IN coalesce(app.li_key(app.li_s(p, 'transaction_type')), '')) > 0
                    OR lower(coalesce(app.li_s(p, 'transaction_type'), '')) = 're_export' THEN 're_export' ELSE 'normal' END;
  s := app.li_s(p, 'created_at');
  IF s IS NOT NULL THEN
    v_created := app.li_ts(s);
    IF v_created IS NULL THEN m := m || app.li_m('warning', 'invalid_datetime', 'created_at', s);
    ELSIF v_created > now() THEN v_created := NULL; m := m || app.li_m('warning', 'future_date', 'created_at', s);
    -- review fix (plan quota): the legacy date is data (transactions.legacy_created_at); created_at = the import time
    ELSE m := m || app.li_m('info', 'created_at_kept', 'created_at');
    END IF;
  END IF;
  -- the notes of the legacy row (+ employee, the older sheet's requirement flags and driver: migrateLegacyTransactions)
  IF app.li_s(p, 'notes') IS NOT NULL THEN v_notes := ARRAY[app.li_s(p, 'notes')] || v_notes; END IF;
  IF app.li_s(p, 'employee') IS NOT NULL THEN v_notes := v_notes || ('الموظف في النظام القديم: ' || app.li_s(p, 'employee')); END IF;
  FOR c IN SELECT unnest(ARRAY['req_linking','req_ports','req_unloading','req_storage','req_electricity']) LOOP
    IF app.li_key(app.li_s(p, c)) IN ('true','yes','1', app.li_key('نعم'), app.li_key('صح')) THEN
      v_req := v_req || CASE c WHEN 'req_linking' THEN 'ربط' WHEN 'req_ports' THEN 'موانئ' WHEN 'req_unloading' THEN 'تفريغ'
                                WHEN 'req_storage' THEN 'أرضيات' ELSE 'كهرباء' END;
    END IF;
  END LOOP;
  IF cardinality(v_req) > 0 THEN v_notes := v_notes || ('المطلوب سابقًا: ' || array_to_string(v_req, '، ')); END IF;
  IF app.li_s(p, 'old_driver') IS NOT NULL THEN v_notes := v_notes || ('السائق في النسخة السابقة: ' || app.li_s(p, 'old_driver')); END IF;
  IF v_lid IS NOT NULL THEN v_notes := v_notes || ('رقم المعاملة في النظام القديم: ' || v_lid); END IF;
  -- duplicates: an earlier committed run, Marsa (B/L + container / chassis, the step-2 guard), the declaration, the file
  IF v_lid IS NOT NULL OR v_seq IS NOT NULL THEN
    IF v_lid IS NOT NULL THEN
      SELECT o.target_id INTO v_d FROM public.legacy_import_rows o JOIN public.legacy_import_runs ru ON ru.id = o.run_id
       WHERE o.org_id = v.org_id AND o.entity = 'transactions' AND o.status = 'committed' AND ru.status = 'committed' AND ru.id <> v.id
         AND o.normalized ->> 'legacy_id' = v_lid LIMIT 1;
    ELSE
      SELECT o.target_id INTO v_d FROM public.legacy_import_rows o JOIN public.legacy_import_runs ru ON ru.id = o.run_id
       WHERE o.org_id = v.org_id AND o.entity = 'transactions' AND o.status = 'committed' AND ru.status = 'committed' AND ru.id <> v.id
         AND o.normalized ->> 'seq' = v_seq LIMIT 1;
    END IF;
    IF v_d IS NOT NULL THEN
      v_dup := true; v_match := v_d; m := m || app.li_m('info', 'already_imported', NULL, (SELECT t.ref FROM public.transactions t WHERE t.id = v_d));
    END IF;
  END IF;
  IF NOT v_dup AND v_bl IS NOT NULL THEN
    SELECT * INTO v_conf FROM app.tx_dup_conflicts(v.org_id, NULL, v_bl, v_cargo, v_chassis, CASE WHEN v_cargo = 'container' THEN v_ctrs END) LIMIT 1;
    IF v_conf.transaction_id IS NOT NULL THEN
      v_dup := true; v_match := v_conf.transaction_id;
      m := m || app.li_m('info', 'exists_in_marsa', v_conf.kind, (SELECT t.ref FROM public.transactions t WHERE t.id = v_conf.transaction_id) || ' · ' || v_conf.unit);
    END IF;
  END IF;
  IF NOT v_dup AND v_match IS NOT NULL THEN
    -- the declaration belongs to a live Marsa transaction with another B/L / unit: a real conflict
    m := m || app.li_m('error', 'declaration_taken', 'declaration_no', (SELECT t.ref FROM public.transactions t WHERE t.id = v_match));
    v_match := NULL;
  ELSIF NOT v_dup THEN
    v_match := NULL;
  END IF;
  IF v_bl IS NOT NULL THEN
    IF v_cargo = 'roro' AND v_chassis IS NOT NULL THEN v_keys := v_keys || ('k:' || app.legacy_search_key(v_bl) || '|' || v_chassis);
    ELSE
      FOREACH c IN ARRAY v_ctrs LOOP v_keys := v_keys || ('k:' || app.legacy_search_key(v_bl) || '|' || c); END LOOP;
    END IF;
  END IF;
  IF v_lid IS NOT NULL THEN v_keys := v_keys || ('l:' || v_lid); END IF;
  IF NOT v_dup THEN
    v_d := app.li_dup_row(r, v_keys);
    IF v_d IS NOT NULL THEN v_dup := true; m := m || app.li_m('warning', 'duplicate_in_file', NULL, app.li_row_label(v_d)); END IF;
  END IF;
  IF NOT v_dup AND v_decl IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.legacy_import_rows o WHERE o.run_id = v.id AND o.entity = 'transactions' AND o.id <> r.id
          AND app.li_row_ok(o.status) AND o.normalized ->> 'declaration_no' = v_decl AND (o.sheet, o.row_no, o.id) < (r.sheet, r.row_no, r.id)) THEN
    m := m || app.li_m('error', 'declaration_taken', 'declaration_no', v_decl);
  END IF;
  RETURN jsonb_build_object('n', jsonb_strip_nulls(jsonb_build_object(
      'legacy_id', v_lid, 'seq', v_seq, 'legacy_ref', v_ref, 'branch_id', v_branch, 'client_id', v_cl ->> 'id', 'client_row', v_cl ->> 'row',
      'bl_number', v_bl, 'cargo_unit_type', v_cargo, 'containers', to_jsonb(v_ctrs), 'chassis_no', v_chassis, 'vehicle_plate_no', v_plate,
      'port_code', v_port, 'mode', v_mode, 'operation', v_op, 'declaration_type', v_dtype, 'declaration_no', v_decl,
      'declaration_date', v_ddate, 'declaration_status', CASE WHEN v_decl IS NOT NULL THEN v_dstat END, 'declaration_date_hijri', v_hijri,
      'declaration_notes', v_dnotes, 'operational_status', v_status, 'financial_status', v_fin, 'transport_mode', v_tmode,
      'transport_order_no', v_order, 'transport_order_date', v_odate, 'transport_party_id', v_tparty, 'terminal_party_id', v_term,
      'shipping_line', v_line, 'vessel', v_vessel, 'transaction_type', v_ttype, 'created_at', v_created,
      'notes', nullif(left(array_to_string(v_notes, ' | '), 2000), ''),
      'daftra', nullif(jsonb_strip_nulls(jsonb_build_object('number', left(app.li_s(p, 'daftra_invoice_no'), 60),
                 'id', left(app.li_s(p, 'daftra_invoice_id'), 60), 'status', left(app.li_s(p, 'daftra_invoice_status'), 60))), '{}'::jsonb),
      'keys', to_jsonb(v_keys), 'match_id', v_match, 'dup_of', v_d)),
    'm', m, 'dup', v_dup);
END $$;

-- containers (legacy «حاويات المعاملات»)
CREATE OR REPLACE FUNCTION app.li_check_containers(r public.legacy_import_rows, v public.legacy_import_runs, ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := r.raw; m jsonb := '[]'::jsonb; x record; v_t jsonb; v_tx public.transactions; v_no text; v_list text[]; v_seal text;
        v_size text; v_notes text; v_dup boolean := false; v_d uuid; v_bl text; v_cargo text; v_txkey text; v_conf record;
BEGIN
  v_t := app.li_find_tx(v, app.li_s(p, 'tx_legacy_id'), app.li_s(p, 'tx_seq'));
  IF v_t ? 'err' THEN m := m || app.li_m('error', v_t ->> 'err', 'tx_legacy_id', coalesce(app.li_s(p, 'tx_legacy_id'), app.li_s(p, 'tx_seq'))); END IF;
  IF v_t ? 'id' THEN
    SELECT * INTO v_tx FROM public.transactions t WHERE t.id = (v_t ->> 'id')::uuid AND t.org_id = v.org_id;
    IF v_tx.id IS NULL OR v_tx.cancelled_at IS NOT NULL THEN m := m || app.li_m('error', 'transaction_not_found', 'tx_legacy_id'); END IF;
    v_bl := v_tx.bl_number; v_cargo := v_tx.cargo_unit_type; v_txkey := v_tx.id::text;
  ELSIF v_t ? 'row' THEN
    v_bl := v_t -> 'n' ->> 'bl_number'; v_cargo := v_t -> 'n' ->> 'cargo_unit_type'; v_txkey := v_t ->> 'row';
  END IF;
  v_list := app.li_containers(app.li_s(p, 'container_no'));
  IF cardinality(v_list) <> 1 OR app.li_containers_rest(app.li_s(p, 'container_no')) THEN
    m := m || app.li_m('error', CASE WHEN app.li_s(p, 'container_no') IS NULL THEN 'required' ELSE 'container_format' END, 'container_no', app.li_s(p, 'container_no'));
  ELSE
    v_no := v_list[1];
    IF NOT app.msg_iso6346_ok(v_no) THEN m := m || app.li_m('warning', 'container_check_digit', 'container_no', v_no); END IF;
  END IF;
  IF v_cargo = 'roro' THEN m := m || app.li_m('error', 'roro_no_container', 'container_no'); END IF;
  SELECT * INTO x FROM app.li_t(p, 'seal_no', 30, m); m := x.m; v_seal := app.norm_code(x.v);
  SELECT * INTO x FROM app.li_t(p, 'size_type', 10, m); m := x.m; v_size := app.norm_code(x.v);
  SELECT * INTO x FROM app.li_t(p, 'notes', 1000, m); m := x.m; v_notes := x.v;
  IF v_no IS NOT NULL AND v_txkey IS NOT NULL THEN
    IF v_t ? 'id' AND EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = v_tx.id AND c.container_no = v_no) THEN
      v_dup := true; m := m || app.li_m('info', 'exists_in_marsa', 'container_no', v_tx.ref || ' · ' || v_no);
    ELSIF v_t ? 'row' AND (v_t -> 'n' -> 'containers') ? v_no THEN
      v_dup := true; m := m || app.li_m('info', 'duplicate_in_file', 'container_no', app.li_row_label((v_t ->> 'row')::uuid));
    ELSIF v_bl IS NOT NULL THEN
      SELECT * INTO v_conf FROM app.tx_dup_conflicts(v.org_id, v_tx.id, v_bl, 'container', NULL, ARRAY[v_no]) LIMIT 1;
      IF v_conf.transaction_id IS NOT NULL THEN
        v_dup := true; m := m || app.li_m('info', 'exists_in_marsa', 'container_no', (SELECT t.ref FROM public.transactions t WHERE t.id = v_conf.transaction_id) || ' · ' || v_no);
      END IF;
    END IF;
    IF NOT v_dup THEN
      v_d := app.li_dup_row(r, ARRAY['c:' || v_txkey || '|' || v_no]);
      IF v_d IS NOT NULL THEN v_dup := true; m := m || app.li_m('warning', 'duplicate_in_file', NULL, app.li_row_label(v_d)); END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('n', jsonb_strip_nulls(jsonb_build_object('legacy_id', app.li_s(p, 'legacy_id'), 'tx_id', v_t ->> 'id',
      'tx_row', v_t ->> 'row', 'container_no', v_no, 'seal_no', v_seal, 'size_type', v_size, 'notes', v_notes,
      'keys', CASE WHEN v_no IS NOT NULL AND v_txkey IS NOT NULL THEN jsonb_build_array('c:' || v_txkey || '|' || v_no) END)),
    'm', m, 'dup', v_dup);
END $$;

-- movements (legacy «حركة النقل»: the appointment + the trip + the empty-return data of one container)
CREATE OR REPLACE FUNCTION app.li_check_movements(r public.legacy_import_rows, v public.legacy_import_runs, ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := r.raw; m jsonb := '[]'::jsonb; x record; s text; v_t jsonb; v_tx public.transactions; v_cargo text; v_txkey text;
  v_list text[]; v_no text; v_cid uuid; v_cnt int; v_known text[]; v_at timestamptz; v_ms text; v_tas text; v_book text; v_opn text;
  v_dname text; v_dphone text; v_drv jsonb; v_plate text; v_truck uuid; v_dest text; v_cost numeric; v_sell numeric; v_notes text;
  v_rloc text; v_rdl date; v_rat timestamptz; v_rstate text; v_trip boolean; v_ret boolean := false; v_csrc text; v_dup boolean := false;
  v_d uuid; v_keys text[] := '{}';
BEGIN
  v_t := app.li_find_tx(v, app.li_s(p, 'tx_legacy_id'), app.li_s(p, 'tx_seq'));
  IF v_t ? 'err' THEN m := m || app.li_m('error', v_t ->> 'err', 'tx_legacy_id', coalesce(app.li_s(p, 'tx_legacy_id'), app.li_s(p, 'tx_seq'))); END IF;
  IF v_t ? 'id' THEN
    SELECT * INTO v_tx FROM public.transactions t WHERE t.id = (v_t ->> 'id')::uuid AND t.org_id = v.org_id;
    IF v_tx.id IS NULL OR v_tx.cancelled_at IS NOT NULL THEN m := m || app.li_m('error', 'transaction_not_found', 'tx_legacy_id'); END IF;
    v_cargo := v_tx.cargo_unit_type; v_txkey := v_tx.id::text;
    v_known := ARRAY(SELECT c.container_no FROM public.containers c WHERE c.transaction_id = v_tx.id);
  ELSIF v_t ? 'row' THEN
    v_cargo := v_t -> 'n' ->> 'cargo_unit_type'; v_txkey := v_t ->> 'row';
    v_known := ARRAY(SELECT jsonb_array_elements_text(coalesce(v_t -> 'n' -> 'containers', '[]'::jsonb)));
  END IF;
  IF v_txkey IS NOT NULL THEN
    v_known := v_known || ARRAY(SELECT o.normalized ->> 'container_no' FROM public.legacy_import_rows o
                                 WHERE o.run_id = v.id AND o.entity = 'containers' AND app.li_row_ok(o.status)
                                   AND coalesce(o.normalized ->> 'tx_id', o.normalized ->> 'tx_row') = v_txkey);
  END IF;
  -- the container (of this transaction; a single-container transaction may leave it empty; Ro-Ro: none)
  IF v_cargo = 'container' THEN
    v_list := app.li_containers(app.li_s(p, 'container_no'));
    IF cardinality(v_list) > 1 OR app.li_containers_rest(app.li_s(p, 'container_no')) THEN
      m := m || app.li_m('error', 'container_format', 'container_no', app.li_s(p, 'container_no'));
    ELSIF cardinality(v_list) = 1 THEN v_no := v_list[1];
    ELSIF cardinality(ARRAY(SELECT DISTINCT unnest(v_known))) = 1 THEN v_no := v_known[1];
    END IF;
    IF v_no IS NOT NULL AND NOT (v_no = ANY (v_known)) THEN m := m || app.li_m('error', 'container_not_on_transaction', 'container_no', v_no); END IF;
    IF v_no IS NULL AND cardinality(v_list) = 0 AND v_txkey IS NOT NULL THEN m := m || app.li_m('error', 'required', 'container_no'); END IF;
    IF v_no IS NOT NULL AND v_t ? 'id' THEN
      SELECT c.id, c.source INTO v_cid, v_csrc FROM public.containers c WHERE c.transaction_id = v_tx.id AND c.container_no = v_no;
    END IF;
  END IF;
  -- the appointment
  s := app.li_s(p, 'appointment_at');
  IF s IS NOT NULL THEN
    v_at := app.li_ts(s);
    IF v_at IS NULL THEN m := m || app.li_m('error', 'invalid_datetime', 'appointment_at', s); END IF;
  END IF;
  s := app.li_s(p, 'status');
  v_ms := app.li_mv_status(s);
  IF s IS NOT NULL AND v_ms IS NULL THEN m := m || app.li_m('warning', 'movement_status_unknown', 'status', s); END IF;
  v_ms := coalesce(v_ms, 'registered');
  s := app.li_s(p, 'appointment_ref');
  IF s IS NOT NULL THEN
    v_tas := app.norm_tas(s);
    IF v_tas IS NULL THEN v_book := left(s, 40); m := m || app.li_m('warning', 'tas_invalid', 'appointment_ref', s); END IF;
  END IF;
  SELECT * INTO x FROM app.li_t(p, 'operator_name', 160, m); m := x.m; v_opn := x.v;
  -- the trip: driver (directory or new), truck, destination, the transport value and the organisation revenue
  SELECT * INTO x FROM app.li_t(p, 'driver_name', 120, m); m := x.m; v_dname := x.v;
  s := app.li_s(p, 'driver_phone');
  IF s IS NOT NULL THEN
    v_dphone := app.norm_sa_phone(s, false);
    IF v_dphone IS NULL THEN m := m || app.li_m('warning', 'driver_phone_invalid', 'driver_phone', s); END IF;
  END IF;
  IF v_dname IS NOT NULL AND char_length(v_dname) < 2 THEN v_dname := NULL; END IF;
  v_drv := app.li_driver_of(v, ctx, v_dname, v_dphone);
  IF v_drv ? 'new' THEN m := m || app.li_m('info', 'driver_created', 'driver_name', v_dname); END IF;
  s := app.li_s(p, 'truck_plate');
  IF s IS NOT NULL THEN
    v_plate := app.li_plate(s);
    IF v_plate IS NULL THEN m := m || app.li_m('warning', 'plate_invalid', 'truck_plate', s);
    ELSE
      SELECT t.id INTO v_truck FROM public.trucks t WHERE t.org_id = v.org_id AND t.plate_no = v_plate;
      IF v_truck IS NULL THEN m := m || app.li_m('info', 'truck_created', 'truck_plate', v_plate); END IF;
    END IF;
  END IF;
  SELECT * INTO x FROM app.li_t(p, 'destination', 120, m); m := x.m; v_dest := x.v;
  v_cost := app.li_money(app.li_s(p, 'transport_value'));
  IF v_cost = 'NaN' OR v_cost < 0 THEN m := m || app.li_m('error', 'invalid_amount', 'transport_value', app.li_s(p, 'transport_value')); v_cost := NULL; END IF;
  v_sell := app.li_money(app.li_s(p, 'org_revenue'));
  IF v_sell = 'NaN' OR v_sell < 0 THEN m := m || app.li_m('error', 'invalid_amount', 'org_revenue', app.li_s(p, 'org_revenue')); v_sell := NULL; END IF;
  SELECT * INTO x FROM app.li_t(p, 'notes', 2000, m); m := x.m; v_notes := x.v;
  IF app.li_s(p, 'employee') IS NOT NULL THEN v_notes := left(concat_ws(' | ', v_notes, 'الموظف في النظام القديم: ' || app.li_s(p, 'employee')), 2000); END IF;
  v_trip := v_drv IS NOT NULL OR v_plate IS NOT NULL OR v_dest IS NOT NULL OR v_cost IS NOT NULL OR v_sell IS NOT NULL OR v_ms = 'delivered';
  -- the empty return: plan + the legacy actual date as DATA only (no proof, return_status stays pending)
  SELECT * INTO x FROM app.li_t(p, 'return_location', 120, m); m := x.m; v_rloc := x.v;
  s := app.li_s(p, 'return_deadline');
  IF s IS NOT NULL THEN
    v_rdl := app.li_date(s);
    IF v_rdl IS NULL THEN m := m || app.li_m('warning', 'invalid_date', 'return_deadline', s); END IF;
  END IF;
  s := app.li_s(p, 'returned_at');
  IF s IS NOT NULL THEN
    v_rat := app.li_ts(s);
    IF v_rat IS NULL THEN m := m || app.li_m('warning', 'invalid_date', 'returned_at', s);
    ELSIF v_rat > now() THEN v_rat := NULL; m := m || app.li_m('warning', 'future_date', 'returned_at', s);
    END IF;
  END IF;
  v_rstate := app.li_key(app.li_s(p, 'return_state'));
  IF v_rat IS NULL AND v_rstate IS NOT NULL AND (position(app.li_key('أعيدت') IN v_rstate) > 0 OR position(app.li_key('تمت الإعادة') IN v_rstate) > 0
                                                  OR position(app.li_key('تم الإرجاع') IN v_rstate) > 0 OR v_rstate = 'returned') THEN
    m := m || app.li_m('warning', 'returned_no_date', 'return_state');
  END IF;
  IF v_rat IS NOT NULL THEN m := m || app.li_m('info', 'returned_recorded_no_proof', 'returned_at'); END IF;
  v_ret := v_rloc IS NOT NULL OR v_rdl IS NOT NULL OR v_rat IS NOT NULL;
  IF v_ret AND v_cargo = 'container' AND v_cid IS NOT NULL AND v_csrc IS DISTINCT FROM 'import' THEN
    m := m || app.li_m('warning', 'return_fields_skipped', 'returned_at'); v_ret := false;
  END IF;
  IF v_ret AND v_cargo = 'roro' THEN v_ret := false; END IF;
  IF v_at IS NULL AND NOT v_trip AND NOT v_ret AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m) e WHERE e ->> 'level' = 'error') THEN
    m := m || app.li_m('error', 'movement_empty');
  END IF;
  -- duplicates: the step-2 appointment guard (same container + minute, or the same TAS number), the file
  IF v_at IS NOT NULL AND v_t ? 'id' AND v_ms <> 'cancelled'
     AND app.appt_duplicate(v_tx.id, v_cid, v_at, v_tas, NULL) IS NOT NULL THEN
    v_dup := true; m := m || app.li_m('info', 'appointment_duplicate', 'appointment_at', v_tx.ref);
  END IF;
  IF v_at IS NOT NULL AND v_txkey IS NOT NULL THEN v_keys := v_keys || ('a:' || v_txkey || '|' || coalesce(v_no, '') || '|' || app.appt_minute(v_at)::text); END IF;
  IF v_tas IS NOT NULL AND v_txkey IS NOT NULL THEN v_keys := v_keys || ('t:' || v_txkey || '|' || v_tas); END IF;
  -- review fix: a cancelled appointment already on the transaction (same container + minute)
  IF NOT v_dup AND v_at IS NOT NULL AND v_t ? 'id' AND v_ms = 'cancelled' AND EXISTS (
       SELECT 1 FROM public.port_appointments a WHERE a.transaction_id = v_tx.id AND a.container_id IS NOT DISTINCT FROM v_cid
          AND a.status = 'cancelled' AND app.appt_minute(a.appointment_at) = app.appt_minute(v_at)) THEN
    v_dup := true; m := m || app.li_m('info', 'appointment_duplicate', 'appointment_at', v_tx.ref);
  END IF;
  -- review fix: a trip without an appointment already on the transaction (same container, driver, destination and value)
  IF NOT v_dup AND v_at IS NULL AND v_trip AND v_t ? 'id' AND EXISTS (
       SELECT 1 FROM public.transport_trips tr WHERE tr.transaction_id = v_tx.id AND tr.container_id IS NOT DISTINCT FROM v_cid
          AND tr.appointment_id IS NULL AND tr.destination IS NOT DISTINCT FROM v_dest AND tr.cost_amount IS NOT DISTINCT FROM v_cost
          AND tr.sell_amount IS NOT DISTINCT FROM v_sell
          AND (v_drv ->> 'id' IS NULL OR tr.driver_id IS NULL OR tr.driver_id = (v_drv ->> 'id')::uuid)
          AND (tr.status <> 'cancelled' OR v_ms = 'cancelled')) THEN
    v_dup := true; m := m || app.li_m('info', 'trip_duplicate', NULL, v_tx.ref);
  END IF;
  IF app.li_s(p, 'legacy_id') IS NOT NULL THEN
    v_keys := v_keys || ('l:' || app.li_s(p, 'legacy_id'));
    -- review fix: the same legacy movement committed by an earlier run (as payments / transactions do)
    IF NOT v_dup AND EXISTS (SELECT 1 FROM public.legacy_import_rows o JOIN public.legacy_import_runs ru ON ru.id = o.run_id
                              WHERE o.org_id = v.org_id AND o.entity = 'movements' AND o.status = 'committed' AND ru.status = 'committed'
                                AND ru.id <> v.id AND o.normalized ->> 'legacy_id' = app.li_s(p, 'legacy_id')) THEN
      v_dup := true; m := m || app.li_m('info', 'already_imported');
    END IF;
  END IF;
  IF NOT v_dup THEN
    v_d := app.li_dup_row(r, v_keys);
    IF v_d IS NOT NULL THEN v_dup := true; m := m || app.li_m('warning', 'duplicate_in_file', NULL, app.li_row_label(v_d)); END IF;
  END IF;
  RETURN jsonb_build_object('n', jsonb_strip_nulls(jsonb_build_object('legacy_id', app.li_s(p, 'legacy_id'), 'tx_id', v_t ->> 'id',
      'tx_row', v_t ->> 'row', 'cargo_unit_type', v_cargo, 'container_no', v_no, 'appointment_at', v_at, 'movement_status', v_ms,
      'appointment_no', v_tas, 'booking_ref', v_book, 'operator_name', v_opn, 'driver_name', v_dname, 'driver_phone', v_dphone,
      'driver_id', v_drv ->> 'id', 'driver_row', v_drv ->> 'row', 'driver_new', (v_drv ->> 'new')::boolean, 'truck_plate', v_plate,
      'truck_id', v_truck, 'destination', v_dest, 'cost_amount', v_cost, 'sell_amount', v_sell, 'notes', v_notes, 'trip', v_trip,
      'return_location', CASE WHEN v_ret THEN v_rloc END, 'return_deadline', CASE WHEN v_ret THEN v_rdl END,
      'returned_at', CASE WHEN v_ret THEN v_rat END, 'keys', to_jsonb(v_keys))),
    'm', m, 'dup', v_dup);
END $$;

-- payments (legacy «السدادات»; the step-6 register model, method / movement inferred like migrateLegacyPaymentModel_)
CREATE OR REPLACE FUNCTION app.li_check_payments(r public.legacy_import_rows, v public.legacy_import_runs, ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := r.raw; m jsonb := '[]'::jsonb; x record; s text; v_t jsonb; v_tx public.transactions; v_branch uuid; v_mt text; v_pat text;
  v_item uuid; v_paid numeric; v_exp numeric; v_at date; v_sadad text; v_bank text; v_receipt text; v_method text; v_src text; v_acct text;
  v_payer text; v_benef uuid; v_bname text; v_claim text; v_internal text; v_appt text; v_notes text[] := '{}'; v_rule text;
  v_dup boolean := false; v_d uuid; v_keys text[] := '{}'; v_conf jsonb; v_cur text; v_nref int;
BEGIN
  v_t := app.li_find_tx(v, app.li_s(p, 'tx_legacy_id'), app.li_s(p, 'tx_seq'));
  IF v_t ? 'err' THEN m := m || app.li_m('error', v_t ->> 'err', 'tx_legacy_id', coalesce(app.li_s(p, 'tx_legacy_id'), app.li_s(p, 'tx_seq'))); END IF;
  IF v_t ? 'id' THEN
    SELECT * INTO v_tx FROM public.transactions t WHERE t.id = (v_t ->> 'id')::uuid AND t.org_id = v.org_id;
    IF v_tx.id IS NULL OR v_tx.cancelled_at IS NOT NULL THEN m := m || app.li_m('error', 'transaction_not_found', 'tx_legacy_id'); END IF;
  END IF;
  -- pattern / movement type (legacy inferPaymentPattern_ / inferMovementType_ from the route)
  v_pat := CASE WHEN position(app.li_key('مشترك') IN coalesce(app.li_key(app.li_s(p, 'pattern')), '')) > 0
                  OR position(app.li_key('سداد مشترك') IN coalesce(app.li_key(app.li_s(p, 'route')), '')) > 0
                  OR lower(coalesce(app.li_s(p, 'pattern'), '')) = 'shared' THEN 'shared' ELSE 'single' END;
  IF v_pat = 'shared' THEN m := m || app.li_m('error', 'shared_not_supported', 'pattern'); END IF;
  v_mt := coalesce(app.li_pay_movement(app.li_s(p, 'movement_type')), app.li_pay_movement(app.li_s(p, 'route')),
                   CASE WHEN app.li_s(p, 'movement_type') IN ('org_paid','received_from_client','client_direct') THEN app.li_s(p, 'movement_type') END,
                   nullif(v.options ->> 'default_movement_type', ''));
  IF v_mt IS NULL OR v_mt NOT IN ('org_paid','received_from_client','client_direct') THEN
    m := m || app.li_m('error', 'movement_type_unknown', 'movement_type', coalesce(app.li_s(p, 'movement_type'), app.li_s(p, 'route'))); v_mt := NULL;
  END IF;
  -- service item
  v_item := app.li_service_item(v, app.li_s(p, 'service_item'));
  IF v_item IS NULL THEN m := m || app.li_m('error', CASE WHEN app.li_s(p, 'service_item') IS NULL THEN 'required' ELSE 'service_item_unknown' END,
                                             'service_item', app.li_s(p, 'service_item')); END IF;
  -- amounts (SAR), the date (≤ today in Asia/Riyadh)
  v_cur := upper(coalesce(app.li_s(p, 'currency'), 'SAR'));
  IF v_cur NOT IN ('SAR', app.li_key('ريال'), 'ر.س') AND app.li_key(v_cur) NOT IN (app.li_key('ريال'), app.li_key('ريال سعودي')) THEN
    m := m || app.li_m('error', 'currency_not_sar', 'currency', v_cur);
  END IF;
  v_paid := app.li_money(app.li_s(p, 'paid_amount'));
  IF v_paid IS NULL THEN m := m || app.li_m('error', 'required', 'paid_amount');
  ELSIF v_paid = 'NaN' OR v_paid <= 0 THEN m := m || app.li_m('error', 'invalid_amount', 'paid_amount', app.li_s(p, 'paid_amount')); v_paid := NULL;
  END IF;
  v_exp := app.li_money(app.li_s(p, 'expected_amount'));
  IF v_exp = 'NaN' OR v_exp < 0 THEN m := m || app.li_m('error', 'invalid_amount', 'expected_amount', app.li_s(p, 'expected_amount')); v_exp := NULL; END IF;
  s := app.li_s(p, 'paid_at');
  v_at := app.li_date(s);
  IF s IS NULL THEN m := m || app.li_m('error', 'required', 'paid_at');
  ELSIF v_at IS NULL THEN m := m || app.li_m('error', 'invalid_date', 'paid_at', s);
  ELSIF v_at > app.rpt_today() THEN m := m || app.li_m('error', 'future_date', 'paid_at', s); v_at := NULL;
  ELSIF v_at < DATE '2000-01-01' THEN m := m || app.li_m('error', 'invalid_date', 'paid_at', s); v_at := NULL;
  END IF;
  -- references (legacy normalizePaymentNumberInput_ / normalizeBankReferenceInput_), the method (given, else inferred like
  -- inferPaymentMethodFromLegacy_ — a receipt alone → «أخرى»); references of another method go to the notes
  s := app.li_s(p, 'sadad_number');
  IF s IS NOT NULL THEN
    v_sadad := regexp_replace(app.to_western(s), '[[:space:]-]', '', 'g');
    IF v_sadad !~ '^[0-9]{1,30}$' THEN m := m || app.li_m('error', 'reference_invalid', 'sadad_number', s); v_sadad := NULL; END IF;
  END IF;
  s := app.li_s(p, 'bank_reference');
  IF s IS NOT NULL THEN
    v_bank := upper(regexp_replace(btrim(app.to_western(s)), '[[:space:]]+', '-', 'g'));
    IF v_bank !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' OR char_length(v_bank) > 60 THEN m := m || app.li_m('error', 'reference_invalid', 'bank_reference', s); v_bank := NULL; END IF;
  END IF;
  SELECT * INTO x FROM app.li_t(p, 'receipt_no', 100, m); m := x.m; v_receipt := app.to_western(x.v);
  IF v_receipt IS NOT NULL AND v_receipt !~ ('^[A-Za-z0-9' || chr(1536) || '-' || chr(1791) || '][A-Za-z0-9' || chr(1536) || '-' || chr(1791) || '[:space:]/._-]*$') THEN
    m := m || app.li_m('error', 'reference_invalid', 'receipt_no', v_receipt); v_receipt := NULL;
  END IF;
  v_method := coalesce(app.li_pay_method(app.li_s(p, 'method')),
                       CASE WHEN app.li_s(p, 'method') IN ('sadad','mada','fasah_wallet','dry_port_wallet','bank_transfer','cash','cheque','other') THEN app.li_s(p, 'method') END);
  IF v_method IS NULL THEN
    v_nref := (v_sadad IS NOT NULL)::int + (v_bank IS NOT NULL)::int + (v_receipt IS NOT NULL)::int;
    IF v_nref = 1 THEN
      v_method := CASE WHEN v_sadad IS NOT NULL THEN 'sadad' WHEN v_bank IS NOT NULL THEN 'bank_transfer' ELSE 'other' END;
      m := m || app.li_m('info', 'method_inferred', 'method', v_method);
    ELSE
      m := m || app.li_m('error', 'method_unknown', 'method', app.li_s(p, 'method'));
    END IF;
  END IF;
  IF v_method = 'sadad' THEN
    IF v_bank IS NOT NULL THEN v_notes := v_notes || ('المرجع البنكي: ' || v_bank); v_bank := NULL; END IF;
    IF v_receipt IS NOT NULL THEN v_notes := v_notes || ('رقم الإيصال: ' || v_receipt); v_receipt := NULL; END IF;
  ELSIF v_method = 'bank_transfer' THEN
    IF v_sadad IS NOT NULL THEN v_notes := v_notes || ('رقم السداد: ' || v_sadad); v_sadad := NULL; END IF;
    IF v_receipt IS NOT NULL THEN v_notes := v_notes || ('رقم الإيصال: ' || v_receipt); v_receipt := NULL; END IF;
  ELSIF v_method IN ('mada','cash','cheque','other') THEN
    IF v_sadad IS NOT NULL THEN v_notes := v_notes || ('رقم السداد: ' || v_sadad); v_sadad := NULL; END IF;
    IF v_bank IS NOT NULL THEN v_notes := v_notes || ('المرجع البنكي: ' || v_bank); v_bank := NULL; END IF;
  END IF;
  IF v_method IS NOT NULL AND coalesce(v_sadad, v_bank, v_receipt) IS NULL THEN m := m || app.li_m('error', 'reference_required', 'method', v_method); END IF;
  -- funding source (the movement decides it for client-direct / received; otherwise the legacy value, else the run default)
  IF v_mt = 'client_direct' THEN v_src := 'client_direct';
  ELSIF v_mt = 'received_from_client' THEN v_src := 'not_applicable_receipt';
  ELSIF v_mt = 'org_paid' THEN
    v_src := coalesce(app.li_pay_funding(app.li_s(p, 'funding_source')),
                      CASE WHEN app.li_s(p, 'funding_source') IN ('org_account','cash_box','fasah_wallet','dry_port_wallet_org','client_custody',
                           'client_custody_dry_port','personal_account') THEN app.li_s(p, 'funding_source') END);
    IF v_src IS NULL OR v_src NOT IN ('org_account','cash_box','fasah_wallet','dry_port_wallet_org','client_custody','client_custody_dry_port','personal_account') THEN
      IF nullif(v.options ->> 'default_funding_source', '') IS NOT NULL THEN
        v_src := v.options ->> 'default_funding_source'; m := m || app.li_m('info', 'funding_default', 'funding_source', v_src);
      ELSE
        m := m || app.li_m('error', 'funding_unknown', 'funding_source', app.li_s(p, 'funding_source')); v_src := NULL;
      END IF;
    END IF;
  END IF;
  SELECT * INTO x FROM app.li_t(p, 'paying_account', 120, m); m := x.m; v_acct := coalesce(x.v, nullif(left(v.options ->> 'default_paying_account', 120), ''));
  IF v_method IN ('fasah_wallet','dry_port_wallet') THEN v_acct := NULL; END IF;
  SELECT * INTO x FROM app.li_t(p, 'payer_name', 160, m); m := x.m; v_payer := x.v;
  IF v_src IS NOT NULL AND v_method IS NOT NULL THEN
    v_rule := app.fin_funding_check(v_src, v_method, coalesce(v_payer, CASE WHEN v_src <> 'personal_account' THEN '-' END), v_acct, false);
    IF v_rule = 'paying_account' THEN m := m || app.li_m('error', 'paying_account_required', 'paying_account');
    ELSIF v_rule IS NOT NULL THEN m := m || app.li_m('error', 'funding_invalid', 'funding_source', v_rule);
    END IF;
  END IF;
  -- the beneficiary = the invoice issuer (a party; added when unknown)
  IF v_mt IN ('org_paid','client_direct') THEN
    v_bname := coalesce(app.li_s(p, 'issuer'), app.li_s(p, 'beneficiary'));
    IF v_bname IS NULL THEN m := m || app.li_m('error', 'beneficiary_required', 'issuer');
    ELSIF char_length(v_bname) NOT BETWEEN 2 AND 160 THEN m := m || app.li_m('error', 'too_long', 'issuer', '160'); v_bname := NULL;
    ELSE
      v_benef := app.li_party(ctx, v_bname, NULL);
      IF v_benef IS NULL THEN
        SELECT pa.id INTO v_benef FROM public.parties pa WHERE pa.org_id = v.org_id AND lower(pa.name_ar) = lower(v_bname);
      END IF;
      IF v_benef IS NULL THEN m := m || app.li_m('info', 'beneficiary_created', 'issuer', v_bname); END IF;
    END IF;
  END IF;
  SELECT * INTO x FROM app.li_t(p, 'claim_no', 60, m); m := x.m; v_claim := x.v;
  IF v_mt = 'received_from_client' THEN v_claim := NULL; END IF;
  SELECT * INTO x FROM app.li_t(p, 'internal_invoice_no', 60, m); m := x.m; v_internal := upper(app.to_western(x.v));
  IF v_internal IS NOT NULL AND (v_internal !~ '^[A-Z0-9][A-Z0-9 /._-]*$' OR v_mt = 'received_from_client') THEN
    v_notes := v_notes || ('معرف الفاتورة الداخلي: ' || v_internal); v_internal := NULL;
  END IF;
  s := app.li_s(p, 'appointment_no');
  IF s IS NOT NULL THEN
    v_appt := app.norm_tas(s);
    IF v_appt IS NULL THEN m := m || app.li_m('warning', 'tas_invalid', 'appointment_no', s); v_notes := v_notes || ('رقم الموعد / الحجز: ' || s); END IF;
  END IF;
  IF app.li_s(p, 'notes') IS NOT NULL THEN v_notes := ARRAY[app.li_s(p, 'notes')] || v_notes; END IF;
  IF app.li_s(p, 'legacy_id') IS NOT NULL THEN v_notes := v_notes || ('رقم سجل السداد في النظام القديم: ' || app.li_s(p, 'legacy_id')); END IF;
  m := m || app.li_m('info', 'payment_pending_review');
  -- duplicates: the references among the org's recorded payments (step-6 global uniqueness), an earlier run, the file
  FOR x IN SELECT * FROM (VALUES ('sadad_number', v_sadad), ('bank_reference', app.pay_ref_norm('bank', v_bank)),
                                 ('receipt_no', app.pay_ref_norm('receipt', v_receipt))) t(f, val) WHERE t.val IS NOT NULL LOOP
    v_conf := app.pay_ref_conflict(v.org_id, x.f, x.val, NULL);
    IF v_conf IS NOT NULL AND NOT v_dup THEN
      v_dup := true; m := m || app.li_m('info', 'payment_ref_taken', x.f, v_conf ->> 'ref');
    END IF;
    v_keys := v_keys || (left(x.f, 1) || ':' || x.val);
  END LOOP;
  IF app.li_s(p, 'legacy_id') IS NOT NULL THEN
    v_keys := v_keys || ('l:' || app.li_s(p, 'legacy_id'));
    IF NOT v_dup AND EXISTS (SELECT 1 FROM public.legacy_import_rows o JOIN public.legacy_import_runs ru ON ru.id = o.run_id
                              WHERE o.org_id = v.org_id AND o.entity = 'payments' AND o.status = 'committed' AND ru.status = 'committed'
                                AND ru.id <> v.id AND o.normalized ->> 'legacy_id' = app.li_s(p, 'legacy_id')) THEN
      v_dup := true; m := m || app.li_m('info', 'already_imported');
    END IF;
  END IF;
  IF NOT v_dup THEN
    v_d := app.li_dup_row(r, v_keys);
    IF v_d IS NOT NULL THEN v_dup := true; m := m || app.li_m('warning', 'duplicate_in_file', NULL, app.li_row_label(v_d)); END IF;
  END IF;
  RETURN jsonb_build_object('n', jsonb_strip_nulls(jsonb_build_object('legacy_id', app.li_s(p, 'legacy_id'), 'tx_id', v_t ->> 'id',
      'tx_row', v_t ->> 'row', 'movement_type', v_mt, 'pattern', v_pat, 'service_item_id', v_item, 'paid_amount', v_paid,
      'expected_amount', coalesce(v_exp, v_paid), 'paid_at', v_at, 'method', v_method, 'funding_source', v_src, 'paying_account', v_acct,
      'payer_name', v_payer, 'beneficiary_party_id', v_benef, 'beneficiary_name', v_bname, 'sadad_number', v_sadad,
      'bank_reference', v_bank, 'receipt_no', v_receipt, 'claim_no', v_claim, 'internal_invoice_no', v_internal, 'appointment_no', v_appt,
      'notes', nullif(left(array_to_string(v_notes, ' | '), 2000), ''), 'keys', to_jsonb(v_keys))),
    'm', m, 'dup', v_dup);
END $$;

-- custody (legacy «عهدة العملاء»): every line is checked; the run then imports ONE opening deposit per client = the sum of its
-- active lines (finalised by app.li_custody_finalize)
CREATE OR REPLACE FUNCTION app.li_check_custody(r public.legacy_import_rows, v public.legacy_import_runs, ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := r.raw; m jsonb := '[]'::jsonb; s text; v_cl jsonb; v_kind text; v_amt numeric; v_signed numeric; v_skip boolean := false;
        v_branch uuid; v_cur text; v_date date; v_lid text := left(app.li_s(p, 'legacy_id'), 60); v_dup boolean := false; v_d uuid;
        v_keys text[] := '{}';
BEGIN
  v_cl := app.li_find_client(v, ctx, app.li_s(p, 'client_code'), app.li_s(p, 'client_name'));
  IF v_cl ? 'err' THEN m := m || app.li_m('error', v_cl ->> 'err', 'client_name', coalesce(app.li_s(p, 'client_name'), app.li_s(p, 'client_code'))); END IF;
  v_branch := app.li_branch(v, app.li_s(p, 'branch'));
  IF v_branch IS NULL THEN m := m || app.li_m('error', CASE WHEN app.li_s(p, 'branch') IS NULL THEN 'branch_required' ELSE 'branch_unknown' END, 'branch'); END IF;
  v_cur := upper(coalesce(app.li_s(p, 'currency'), 'SAR'));
  IF v_cur <> 'SAR' AND app.li_key(v_cur) NOT IN (app.li_key('ريال'), app.li_key('ريال سعودي'), app.li_key('ر.س')) THEN
    m := m || app.li_m('error', 'currency_not_sar', 'currency', v_cur);
  END IF;
  s := app.li_s(p, 'balance');
  IF s IS NOT NULL AND app.li_s(p, 'kind') IS NULL THEN
    v_kind := 'balance';
    v_signed := app.li_money(s);
    IF v_signed IS NULL OR v_signed = 'NaN' THEN m := m || app.li_m('error', 'invalid_amount', 'balance', s); v_signed := NULL; END IF;
  ELSE
    v_kind := coalesce(app.li_pick(app.li_s(p, 'kind'), ARRAY[['إيداع عهدة','deposit'],['إيداع','deposit'],['خصم من العهدة','deduction'],
                                      ['خصم','deduction'],['إرجاع عهدة','refund'],['إرجاع','refund'],['رد','refund']]),
                       CASE WHEN app.li_s(p, 'kind') IN ('deposit','deduction','refund') THEN app.li_s(p, 'kind') END);
    IF v_kind IS NULL THEN m := m || app.li_m('error', CASE WHEN app.li_s(p, 'kind') IS NULL THEN 'required' ELSE 'custody_kind_unknown' END, 'kind', app.li_s(p, 'kind')); END IF;
    v_amt := app.li_money(app.li_s(p, 'amount'));
    IF v_amt IS NULL THEN m := m || app.li_m('error', 'required', 'amount');
    ELSIF v_amt = 'NaN' OR v_amt <= 0 THEN m := m || app.li_m('error', 'invalid_amount', 'amount', app.li_s(p, 'amount')); v_amt := NULL;
    END IF;
    v_signed := CASE WHEN v_kind = 'deposit' THEN v_amt WHEN v_kind IN ('deduction','refund') THEN -v_amt END;
  END IF;
  s := app.li_key(app.li_s(p, 'status'));
  IF s IS NOT NULL AND (position(app.li_key('ملغي') IN s) > 0 OR position(app.li_key('ملغى') IN s) > 0 OR s IN ('void','cancelled')) THEN
    v_skip := true; m := m || app.li_m('info', 'custody_legacy_void');
  END IF;
  v_date := app.li_date(app.li_s(p, 'entry_date'));
  -- review fix (custody counted twice): the same legacy line committed by an earlier run is a duplicate; a client that already has an
  -- opening balance from an earlier run takes only lines with a legacy id, and only when every earlier line of it had one
  IF NOT v_skip AND v_lid IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.legacy_import_rows o JOIN public.legacy_import_runs ru ON ru.id = o.run_id
        WHERE o.org_id = v.org_id AND o.entity = 'custody' AND o.status = 'committed' AND ru.status = 'committed' AND ru.id <> v.id
          AND o.normalized ->> 'legacy_id' = v_lid) THEN
    v_dup := true; m := m || app.li_m('info', 'already_imported', 'legacy_id', v_lid);
  END IF;
  IF NOT v_skip AND NOT v_dup AND v_cl ? 'id' AND EXISTS (
       SELECT 1 FROM public.client_custody_entries ce JOIN public.legacy_import_rows o ON o.target_id = ce.id
         JOIN public.legacy_import_runs ru ON ru.id = o.run_id
        WHERE ce.client_id = (v_cl ->> 'id')::uuid AND ce.org_id = v.org_id AND ce.status = 'active'
          AND o.entity = 'custody' AND o.status = 'committed' AND ru.status = 'committed' AND ru.id <> v.id
          AND (v_lid IS NULL OR NOT (o.normalized ? 'legacy_id'))) THEN
    m := m || app.li_m('error', 'custody_already_opened', 'legacy_id');
  END IF;
  IF v_lid IS NOT NULL THEN v_keys := ARRAY['l:' || v_lid]; END IF;
  IF NOT v_skip AND NOT v_dup THEN
    v_d := app.li_dup_row(r, v_keys);
    IF v_d IS NOT NULL THEN v_dup := true; m := m || app.li_m('warning', 'duplicate_in_file', NULL, app.li_row_label(v_d)); END IF;
  END IF;
  RETURN jsonb_build_object('n', jsonb_strip_nulls(jsonb_build_object('legacy_id', v_lid, 'client_id', v_cl ->> 'id',
      'client_row', v_cl ->> 'row', 'client_key', coalesce(v_cl ->> 'id', v_cl ->> 'row'), 'branch_id', v_branch, 'kind', v_kind,
      'amount', v_amt, 'signed', v_signed, 'entry_date', v_date, 'reference', left(app.li_s(p, 'reference'), 120), 'keys', to_jsonb(v_keys))),
    'm', m, 'skip', v_skip, 'dup', v_dup);
END $$;

-- custody: per client of the run, the sum of the importable lines → one opening deposit (the earliest line carries it); a negative
-- sum is refused on every line of that client, a zero sum creates nothing
CREATE OR REPLACE FUNCTION app.li_custody_finalize(p_run uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE g record; v_first uuid;
BEGIN
  FOR g IN SELECT o.normalized ->> 'client_key' k, round(sum((o.normalized ->> 'signed')::numeric), 2) bal,
                  count(DISTINCT o.normalized ->> 'branch_id') nb
             FROM public.legacy_import_rows o
            WHERE o.run_id = p_run AND o.entity = 'custody' AND o.status IN ('valid','warning') AND o.normalized ? 'client_key'
            GROUP BY 1 LOOP
    SELECT o.id INTO v_first FROM public.legacy_import_rows o
     WHERE o.run_id = p_run AND o.entity = 'custody' AND o.status IN ('valid','warning') AND o.normalized ->> 'client_key' = g.k
     ORDER BY o.sheet, o.row_no, o.id LIMIT 1;
    IF g.bal < 0 THEN
      UPDATE public.legacy_import_rows o SET status = 'error', messages = o.messages || app.li_m('error', 'custody_negative', 'amount', g.bal::text)
       WHERE o.run_id = p_run AND o.entity = 'custody' AND o.status IN ('valid','warning') AND o.normalized ->> 'client_key' = g.k;
      CONTINUE;
    END IF;
    UPDATE public.legacy_import_rows o
       SET normalized = o.normalized || jsonb_build_object('carrier', o.id = v_first, 'balance', g.bal),
           messages = o.messages || CASE WHEN g.bal = 0 THEN app.li_m('info', 'custody_zero', 'amount', '0')
                                         WHEN o.id = v_first THEN app.li_m('info', 'custody_opening', 'amount', g.bal::text)
                                         ELSE app.li_m('info', 'custody_merged', 'amount', g.bal::text) END
     WHERE o.run_id = p_run AND o.entity = 'custody' AND o.status IN ('valid','warning') AND o.normalized ->> 'client_key' = g.k;
  END LOOP;
END $$;

-- a row label for messages: «<sheet> · صف <n>»
CREATE OR REPLACE FUNCTION app.li_row_label(p_row uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT nullif(o.sheet, '') || ' #' || o.row_no FROM public.legacy_import_rows o WHERE o.id = p_row
$$;

-- the check of one row (dispatcher) → {status, n, m}; a parent row of the run that is not importable makes the child an error
CREATE OR REPLACE FUNCTION app.li_check(r public.legacy_import_rows, v public.legacy_import_runs, ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c jsonb;
BEGIN
  IF r.skipped_by_owner THEN
    RETURN jsonb_build_object('status', 'skipped', 'n', r.normalized, 'm', app.li_m('info', 'skipped_by_owner'));
  END IF;
  c := CASE r.entity
    WHEN 'customers' THEN app.li_check_customers(r, v, ctx)
    WHEN 'aliases' THEN app.li_check_aliases(r, v, ctx)
    WHEN 'drivers' THEN app.li_check_drivers(r, v, ctx)
    WHEN 'transactions' THEN app.li_check_transactions(r, v, ctx)
    WHEN 'containers' THEN app.li_check_containers(r, v, ctx)
    WHEN 'movements' THEN app.li_check_movements(r, v, ctx)
    WHEN 'payments' THEN app.li_check_payments(r, v, ctx)
    WHEN 'custody' THEN app.li_check_custody(r, v, ctx) END;
  RETURN jsonb_build_object('status', app.li_status_of(c -> 'm', (c ->> 'dup')::boolean, (c ->> 'skip')::boolean), 'n', c -> 'n', 'm', c -> 'm');
END $$;

-- the canonical legacy headers per entity (legacy الرمز.js APP.*Headers / Payments.js / CustomerCustody.js; + a few Marsa
-- columns: branch, tx_seq, currency, balance); the browser maps a sheet column to a field key when its header matches
CREATE OR REPLACE FUNCTION app.li_dictionary() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT $j$[{"entity":"customers","order":1,"sheets":["دليل العملاء"],"fields":[{"key":"daftra_code","required":false,"headers":["كود العميل في دفترة","كود العميل","رقم العميل في دفترة","Daftra client code"]},{"key":"name_ar","required":true,"headers":["الاسم العربي الرسمي","اسم العميل","الاسم العربي","Arabic name"],"alt":["name_en"]},{"key":"name_en","required":false,"headers":["الاسم الإنجليزي الرسمي","الاسم الإنجليزي","English name"]},{"key":"vat_number","required":false,"headers":["الرقم الضريبي","VAT number"]},{"key":"cr_number","required":false,"headers":["السجل التجاري / الرقم الموحد","السجل التجاري","الرقم الموحد","CR number"]},{"key":"phone","required":false,"headers":["رقم الجوال","الجوال","Mobile"]},{"key":"email","required":false,"headers":["البريد الإلكتروني","Email"]},{"key":"city","required":false,"headers":["المدينة","City"]},{"key":"status","required":false,"headers":["حالة العميل","Status"]},{"key":"port_category","required":false,"headers":["التصنيف (مطار / ميناء / مشترك)","التصنيف","تصنيف العميل","Category"]},{"key":"notes","required":false,"headers":["ملاحظات","Notes"]}]},{"entity":"aliases","order":2,"sheets":["أسماء العملاء البديلة"],"fields":[{"key":"client_code","required":false,"headers":["كود العميل في دفترة","Daftra client code"]},{"key":"alias","required":true,"headers":["الاسم الإنجليزي كما ظهر في البوليصة","الاسم البديل","Alias"]},{"key":"client_name","required":false,"headers":["الاسم العربي الرسمي","اسم العميل","Client name"]},{"key":"source_type","required":false,"headers":["نوع المصدر","Source type"]},{"key":"source_ref","required":false,"headers":["رقم البوليصة / المستند","Document number"]},{"key":"confidence","required":false,"headers":["درجة الثقة %","درجة الثقة","Confidence"]},{"key":"status","required":false,"headers":["حالة الاعتماد","Approval status"]},{"key":"occurrences","required":false,"headers":["عدد مرات الظهور","Occurrences"]},{"key":"last_used","required":false,"headers":["آخر استخدام","Last used"]}]},{"entity":"drivers","order":3,"sheets":["السائقون"],"fields":[{"key":"name","required":true,"headers":["اسم السائق","السائق","Driver name"]},{"key":"phone","required":false,"headers":["رقم الجوال","جوال السائق","Mobile"]},{"key":"truck_plate","required":false,"headers":["رقم الشاحنة","Truck plate"]}]},{"entity":"transactions","order":4,"sheets":["المعاملات","قاعدة البيانات"],"fields":[{"key":"legacy_id","required":false,"headers":["رقم المعاملة","Transaction id"]},{"key":"seq","required":false,"headers":["التسلسل","Sequence"]},{"key":"importer","required":true,"headers":["المستورد","اسم العميل","العميل","Importer"],"alt":["client_code"]},{"key":"client_code","required":false,"headers":["كود العميل في دفترة","Daftra client code"]},{"key":"bl_number","required":true,"headers":["رقم البوليصة","B/L number"]},{"key":"container_no","required":false,"headers":["رقم الحاوية","أرقام الحاويات","Container number"]},{"key":"port","required":false,"headers":["الميناء","المنفذ","Port"]},{"key":"operator","required":false,"headers":["المشغل","المشغّل","Operator"]},{"key":"shipping_agent","required":false,"headers":["الوكيل الملاحي","Shipping agent"]},{"key":"vessel","required":false,"headers":["الباخرة","اسم السفينة","Vessel"]},{"key":"employee","required":false,"headers":["الموظف","Employee"]},{"key":"notes","required":false,"headers":["ملاحظات المعاملة","ملاحظات","Notes"]},{"key":"declaration_no","required":false,"headers":["رقم البيان","Declaration number"]},{"key":"declaration_date","required":false,"headers":["تاريخ البيان","Declaration date"]},{"key":"declaration_status","required":false,"headers":["حالة البيان","Declaration status"]},{"key":"declaration_notes","required":false,"headers":["ملاحظات البيان","Declaration notes"]},{"key":"created_at","required":false,"headers":["تاريخ الإنشاء","Created"]},{"key":"declaration_date_hijri","required":false,"headers":["تاريخ البيان الهجري","Hijri declaration date"]},{"key":"operational_status","required":false,"headers":["الحالة التشغيلية","Operational status"]},{"key":"transport_mode","required":false,"headers":["طريقة تنفيذ النقل","Transport mode"]},{"key":"transport_company","required":false,"headers":["اسم شركة النقل","Transport company"]},{"key":"transport_order_no","required":false,"headers":["رقم أمر النقل","Transport order"]},{"key":"transport_order_date","required":false,"headers":["تاريخ أمر النقل","Transport order date"]},{"key":"daftra_invoice_id","required":false,"headers":["معرف مسودة فاتورة دفترة","Daftra invoice id"]},{"key":"daftra_invoice_no","required":false,"headers":["رقم مسودة فاتورة دفترة","رقم فاتورة دفترة","Daftra invoice number"]},{"key":"daftra_invoice_status","required":false,"headers":["حالة مسودة فاتورة دفترة","Daftra invoice status"]},{"key":"declaration_type","required":false,"headers":["نوع البيان","Declaration type"]},{"key":"cargo_unit_type","required":false,"headers":["نوع وحدة الشحن","Cargo unit"]},{"key":"chassis_no","required":false,"headers":["رقم الشاسيه","Chassis number"]},{"key":"plate_no","required":false,"headers":["رقم اللوحة","Plate number"]},{"key":"transaction_type","required":false,"headers":["نوع المعاملة","Transaction type"]},{"key":"branch","required":false,"headers":["الفرع","Branch"]},{"key":"operationally_done","required":false,"headers":["انتهت تشغيليًا","انتهت تشغيليا"]},{"key":"req_linking","required":false,"headers":["ربط"]},{"key":"req_ports","required":false,"headers":["موانئ"]},{"key":"req_unloading","required":false,"headers":["تفريغ"]},{"key":"req_storage","required":false,"headers":["أرضيات"]},{"key":"req_electricity","required":false,"headers":["كهرب","كهرباء"]},{"key":"old_driver","required":false,"headers":["السائق"]}]},{"entity":"containers","order":5,"sheets":["حاويات المعاملات"],"fields":[{"key":"legacy_id","required":false,"headers":["رقم سجل الحاوية","Container record id"]},{"key":"tx_legacy_id","required":true,"headers":["رقم المعاملة","Transaction id"],"alt":["tx_seq"]},{"key":"tx_seq","required":false,"headers":["تسلسل المعاملة","Transaction sequence"]},{"key":"container_no","required":true,"headers":["رقم الحاوية","Container number"]},{"key":"seal_no","required":false,"headers":["رقم الختم","Seal number"]},{"key":"size_type","required":false,"headers":["النوع / الحجم","Size / type"]},{"key":"notes","required":false,"headers":["ملاحظات","Notes"]}]},{"entity":"movements","order":6,"sheets":["حركة النقل"],"fields":[{"key":"legacy_id","required":false,"headers":["رقم الحركة","Movement id"]},{"key":"tx_legacy_id","required":true,"headers":["رقم المعاملة","Transaction id"],"alt":["tx_seq"]},{"key":"tx_seq","required":false,"headers":["تسلسل المعاملة","Transaction sequence"]},{"key":"container_no","required":false,"headers":["رقم الحاوية","Container number"]},{"key":"declaration_no","required":false,"headers":["رقم البيان","Declaration number"]},{"key":"appointment_at","required":false,"headers":["تاريخ ووقت موعد الخروج","موعد الخروج","Appointment"]},{"key":"driver_name","required":false,"headers":["السائق","اسم السائق","Driver"]},{"key":"truck_plate","required":false,"headers":["رقم الشاحنة","Truck plate"]},{"key":"status","required":false,"headers":["حالة الموعد والنقل","Movement status"]},{"key":"notes","required":false,"headers":["ملاحظات الحركة","Notes"]},{"key":"employee","required":false,"headers":["الموظف","Employee"]},{"key":"driver_phone","required":false,"headers":["رقم جوال السائق","Driver mobile"]},{"key":"destination","required":false,"headers":["وجهة تسليم الحاوية الممتلئة","Destination"]},{"key":"transport_value","required":false,"headers":["قيمة النقل الإجمالية","Transport value"]},{"key":"org_revenue","required":false,"headers":["عائد المؤسسة من النقلة","Organisation revenue"]},{"key":"return_location","required":false,"headers":["مكان إعادة الحاوية الفارغة","Empty return location"]},{"key":"return_deadline","required":false,"headers":["آخر تاريخ لإعادة الفارغ","Empty return deadline"]},{"key":"returned_at","required":false,"headers":["تاريخ إعادة الفارغ الفعلي","Actual empty return date"]},{"key":"return_state","required":false,"headers":["حالة إعادة الفارغ","Empty return state"]},{"key":"appointment_ref","required":false,"headers":["الرقم المرجعي للموعد","Appointment reference"]},{"key":"operator_name","required":false,"headers":["مشغل الميناء في بطاقة الموعد","Terminal operator"]}]},{"entity":"payments","order":7,"sheets":["السدادات"],"fields":[{"key":"legacy_id","required":false,"headers":["رقم سجل السداد","Payment record id"]},{"key":"tx_legacy_id","required":true,"headers":["رقم المعاملة","Transaction id"],"alt":["tx_seq"]},{"key":"tx_seq","required":false,"headers":["تسلسل المعاملة","Transaction sequence"]},{"key":"client_name","required":false,"headers":["العميل","Client"]},{"key":"route","required":false,"headers":["مسار السداد","Payment route"]},{"key":"service_item","required":true,"headers":["بند الخدمة / نوع الرسم","بند الخدمة","Service item"]},{"key":"claim_no","required":false,"headers":["رقم الفاتورة أو المطالبة","Invoice / claim number"]},{"key":"expected_amount","required":false,"headers":["المبلغ المطلوب","Expected amount"]},{"key":"paid_amount","required":true,"headers":["المبلغ المسدد","Paid amount"]},{"key":"paid_at","required":true,"headers":["تاريخ السداد","Payment date"]},{"key":"sadad_number","required":false,"headers":["رقم السداد","SADAD number"]},{"key":"review_status","required":false,"headers":["حالة المراجعة","Review status"]},{"key":"notes","required":false,"headers":["ملاحظات","Notes"]},{"key":"bank_reference","required":false,"headers":["الرقم المرجعي البنكي","Bank reference"]},{"key":"payer_name","required":false,"headers":["جهة السداد / المحوّل","Payer"]},{"key":"movement_type","required":false,"headers":["نوع الحركة المالية","Movement type"]},{"key":"pattern","required":false,"headers":["نمط السداد","Pattern"]},{"key":"method","required":false,"headers":["طريقة السداد","Method"]},{"key":"beneficiary","required":false,"headers":["الجهة المستفيدة / المسدد لها","Beneficiary"]},{"key":"receipt_no","required":false,"headers":["رقم الإيصال / السند / العملية","Receipt number"]},{"key":"issuer","required":false,"headers":["الجهة مصدرة الفاتورة","Invoice issuer"]},{"key":"internal_invoice_no","required":false,"headers":["معرف الفاتورة الداخلي","Internal invoice id"]},{"key":"funding_source","required":false,"headers":["مصدر تمويل السداد","Funding source"]},{"key":"paying_account","required":false,"headers":["البنك / الحساب المسدد منه","Paying account"]},{"key":"appointment_no","required":false,"headers":["رقم الموعد / الحجز","Appointment number"]},{"key":"currency","required":false,"headers":["العملة","Currency"]}]},{"entity":"custody","order":8,"sheets":["عهدة العملاء"],"fields":[{"key":"legacy_id","required":false,"headers":["رقم حركة العهدة","Custody entry id"]},{"key":"client_name","required":true,"headers":["اسم العميل","Client"],"alt":["client_code"]},{"key":"client_code","required":false,"headers":["كود العميل في دفترة","Daftra client code"]},{"key":"kind","required":false,"headers":["نوع الحركة","Kind"]},{"key":"amount","required":false,"headers":["المبلغ","Amount"]},{"key":"balance","required":false,"headers":["الرصيد","Balance"]},{"key":"entry_date","required":false,"headers":["تاريخ الحركة","Date"]},{"key":"reference","required":false,"headers":["المرجع","Reference"]},{"key":"notes","required":false,"headers":["ملاحظات","Notes"]},{"key":"status","required":false,"headers":["الحالة","Status"]},{"key":"currency","required":false,"headers":["العملة","Currency"]},{"key":"branch","required":false,"headers":["الفرع","Branch"]}]}]$j$::jsonb
$$;

-- ---------------------------------------------------------------------
-- per-entity apply (commit of one checked row): the normal tables, through the normal RPCs where step 6 has them
-- (record_payment_bundle, save_custody_entry). → {target_table, target_id, created [{t, id, a, prev?}]}
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.li_c(p_table text, p_id uuid, p_action text DEFAULT 'insert', p_prev jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('t', p_table, 'id', p_id, 'a', p_action, 'prev', p_prev)))
$$;
-- find-or-create a truck by plate (created → listed)
CREATE OR REPLACE FUNCTION app.li_truck(p_org uuid, p_plate text, INOUT created jsonb, OUT id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_plate IS NULL THEN RETURN; END IF;
  SELECT t.id INTO id FROM public.trucks t WHERE t.org_id = p_org AND t.plate_no = p_plate;
  IF id IS NULL THEN
    INSERT INTO public.trucks (org_id, plate_no) VALUES (p_org, p_plate) RETURNING trucks.id INTO id;
    created := created || app.li_c('trucks', id);
  END IF;
END $$;

-- the fingerprints of created rows of one table, set-based (volatile usage columns left out); a row that is gone has none.
-- app.li_fp (one row) reads through it: one definition of what a fingerprint covers
CREATE OR REPLACE FUNCTION app.li_fps(p_table text, p_ids uuid[]) RETURNS TABLE (id uuid, fp text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_table NOT IN ('clients','client_aliases','drivers','trucks','parties','transactions','containers','customs_declarations',
                     'port_appointments','transport_trips','client_disbursements','client_custody_entries') THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE format('SELECT x.id, md5((to_jsonb(x) - $2)::text) FROM public.%I x WHERE x.id = ANY ($1)', p_table)
    USING coalesce(p_ids, '{}'::uuid[]),
          ARRAY['updated_at','status_changed_at','last_truck_id','match_count','last_matched_at','occurrences','last_used_at'];
END $$;

-- review fix (void baseline): the ids of earlier created rows of the run that the apply of this row may update on purpose (its
-- client / transaction / driver / truck / party, the containers and declarations of its transaction, the targets of the run rows
-- it names). Their fingerprints are re-taken after the apply only when they were unchanged right before it (app.li_fp_pre /
-- app.li_fp_post): an edit by someone else in between stays visible to the void.
CREATE OR REPLACE FUNCTION app.li_touch_ids(v public.legacy_import_runs, n jsonb) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH u AS (
    SELECT (e.value #>> '{}')::uuid id FROM jsonb_each(coalesce(n, '{}'::jsonb)) e
     WHERE jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), u2 AS (
    SELECT u.id FROM u
    UNION SELECT o.target_id FROM public.legacy_import_rows o WHERE o.id IN (SELECT u.id FROM u) AND o.run_id = v.id AND o.target_id IS NOT NULL
  )
  SELECT ARRAY(SELECT DISTINCT z.id FROM (
      SELECT u2.id FROM u2
      UNION ALL SELECT c.id FROM public.containers c WHERE c.transaction_id IN (SELECT u2.id FROM u2)
      UNION ALL SELECT d.id FROM public.customs_declarations d WHERE d.transaction_id IN (SELECT u2.id FROM u2)
      UNION ALL SELECT t.id FROM public.trucks t WHERE t.org_id = v.org_id AND t.plate_no IN (n ->> 'truck_plate', n ->> 'plate')
      UNION ALL SELECT d.id FROM public.drivers d WHERE d.org_id = v.org_id
         AND ((n ? 'driver_phone' AND d.phone = n ->> 'driver_phone')
              OR (NOT n ? 'driver_phone' AND n ? 'driver_name' AND app.norm_name(d.full_name) = app.norm_name(n ->> 'driver_name')))
      UNION ALL SELECT pa.id FROM public.parties pa WHERE pa.org_id = v.org_id AND n ? 'beneficiary_name' AND lower(pa.name_ar) = lower(n ->> 'beneficiary_name')
    ) z WHERE z.id IS NOT NULL)
$$;
-- before an apply: the created entries of the run's (and the org's earlier committed runs') committed rows holding one of the ids → [{row, k (0-based), ok}] (ok = the
-- entry still has the fingerprint it was committed / re-baselined with)
CREATE OR REPLACE FUNCTION app.li_fp_pre(p_run uuid, p_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('row', z.rid, 'k', z.k, 'ok', z.ok)), '[]'::jsonb) FROM (
    SELECT DISTINCT o.id rid, (x.k - 1)::int k,
           ((x.e ->> 'fp') IS NULL OR app.li_fp(x.e ->> 't', (x.e ->> 'id')::uuid) IS NOT DISTINCT FROM (x.e ->> 'fp')) ok
      FROM unnest(coalesce(p_ids, '{}'::uuid[])) i(id)
      JOIN public.legacy_import_rows o ON o.created_rows @> jsonb_build_array(jsonb_build_object('id', i.id))
      CROSS JOIN LATERAL jsonb_array_elements(o.created_rows) WITH ORDINALITY x(e, k)
     WHERE o.status = 'committed' AND x.e ->> 'id' = i.id::text
       -- harness fix: the rows of the org's earlier committed runs too (a later run adding a container to an earlier run's
       -- transaction is the owner's own import, not a staff change: once that later run is voided, the earlier one can be)
       AND (o.run_id = p_run OR o.run_id IN (SELECT r2.id FROM public.legacy_import_runs r2 JOIN public.legacy_import_runs r1 ON r1.id = p_run
                                               WHERE r2.org_id = r1.org_id AND r2.status = 'committed'))) z
$$;
-- after the apply: the unchanged entries take their new fingerprint (the run's own change); the others keep the old one
CREATE OR REPLACE FUNCTION app.li_fp_post(p_pre jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE y jsonb; k int;
BEGIN
  FOR y IN SELECT z FROM jsonb_array_elements(coalesce(p_pre, '[]'::jsonb)) z WHERE (z ->> 'ok')::boolean LOOP
    k := (y ->> 'k')::int;
    UPDATE public.legacy_import_rows o
       SET created_rows = jsonb_set(o.created_rows, ARRAY[k::text, 'fp'],
             coalesce(to_jsonb(app.li_fp(o.created_rows -> k ->> 't', (o.created_rows -> k ->> 'id')::uuid)), 'null'::jsonb))
     WHERE o.id = (y ->> 'row')::uuid;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app.li_apply(r public.legacy_import_rows, v public.legacy_import_runs, n jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cr jsonb := '[]'::jsonb; v_id uuid; v_cl uuid; v_tx public.transactions; v_ctr public.containers; c text; v_drv uuid; v_trk uuid;
  v_appt uuid; v_trip uuid; v_res jsonb; v_pay jsonb; v_benef uuid; x record; v_party_name text; v_carrier record; v_ast text; v_tst text;
BEGIN
  CASE r.entity
  WHEN 'customers' THEN
    INSERT INTO public.clients (org_id, client_type, name_ar, name_en, vat_number, cr_number, phone, email, port_category, notes,
                                is_active, source, daftra_client_code, national_address)
    VALUES (v.org_id, 'business', n ->> 'name_ar', n ->> 'name_en', n ->> 'vat_number', n ->> 'cr_number', n ->> 'phone', n ->> 'email',
            n ->> 'port_category', n ->> 'notes', coalesce((n ->> 'is_active')::boolean, true), 'legacy', n ->> 'code',
            CASE WHEN n ? 'city' THEN jsonb_build_object('city', n ->> 'city') ELSE '{}'::jsonb END)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('target_table', 'clients', 'target_id', v_id, 'created', app.li_c('clients', v_id));
  WHEN 'aliases' THEN
    v_cl := app.li_resolve(n ->> 'client_id', n ->> 'client_row');
    IF v_cl IS NULL THEN PERFORM app.fail('MRS_LI_PARENT', 'client'); END IF;
    INSERT INTO public.client_aliases (org_id, client_id, alias, source, status, confidence, occurrences, last_used_at, source_ref)
    VALUES (v.org_id, v_cl, n ->> 'alias', n ->> 'source', 'suggested', (n ->> 'confidence')::int, coalesce((n ->> 'occurrences')::int, 1),
            (n ->> 'last_used_at')::timestamptz, n ->> 'source_ref')
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('target_table', 'client_aliases', 'target_id', v_id, 'created', app.li_c('client_aliases', v_id));
  WHEN 'drivers' THEN
    SELECT * INTO x FROM app.li_truck(v.org_id, n ->> 'plate', v_cr); v_cr := x.created; v_trk := x.id;
    INSERT INTO public.drivers (org_id, full_name, phone, last_truck_id) VALUES (v.org_id, n ->> 'name', n ->> 'phone', v_trk) RETURNING id INTO v_id;
    RETURN jsonb_build_object('target_table', 'drivers', 'target_id', v_id, 'created', app.li_c('drivers', v_id) || v_cr);
  WHEN 'transactions' THEN
    v_cl := app.li_resolve(n ->> 'client_id', n ->> 'client_row');
    IF v_cl IS NULL THEN PERFORM app.fail('MRS_LI_PARENT', 'client'); END IF;
    INSERT INTO public.transactions (org_id, branch_id, client_id, operation, mode, container_count, bl_number, port_code, terminal_party_id,
      shipping_line, declaration_no, declaration_date, declaration_type, cargo_unit_type, chassis_no, vehicle_plate_no, transaction_type,
      transport_mode, transport_party_id, transport_order_no, transport_order_date, declaration_notes, notes, operational_status,
      financial_status, legacy_ref, import_run_id, legacy_created_at, created_by)
    VALUES (v.org_id, (n ->> 'branch_id')::uuid, v_cl, n ->> 'operation', n ->> 'mode',
      CASE WHEN n ->> 'cargo_unit_type' = 'roro' THEN 0 ELSE jsonb_array_length(coalesce(n -> 'containers', '[]'::jsonb)) END,
      n ->> 'bl_number', n ->> 'port_code', (n ->> 'terminal_party_id')::uuid, n ->> 'shipping_line', n ->> 'declaration_no',
      (n ->> 'declaration_date')::date, n ->> 'declaration_type', n ->> 'cargo_unit_type', n ->> 'chassis_no', n ->> 'vehicle_plate_no',
      n ->> 'transaction_type', n ->> 'transport_mode', (n ->> 'transport_party_id')::uuid, n ->> 'transport_order_no',
      (n ->> 'transport_order_date')::date, n ->> 'declaration_notes', n ->> 'notes', n ->> 'operational_status', n ->> 'financial_status',
      n ->> 'legacy_ref', v.id, (n ->> 'created_at')::timestamptz, auth.uid())
    RETURNING * INTO v_tx;
    v_cr := app.li_c('transactions', v_tx.id);
    -- the declaration adopted by the G3 trigger: its legacy Fasah stage + Hijri date (data from the sheet, not an approval)
    FOR x IN SELECT d.id FROM public.customs_declarations d WHERE d.transaction_id = v_tx.id AND d.status NOT IN ('cancelled','replaced') LOOP
      UPDATE public.customs_declarations d SET status = coalesce(n ->> 'declaration_status', d.status),
             declaration_date_hijri = coalesce(n ->> 'declaration_date_hijri', d.declaration_date_hijri), source = 'import'
       WHERE d.id = x.id;
      v_cr := v_cr || app.li_c('customs_declarations', x.id);
    END LOOP;
    IF n ? 'vessel' THEN
      UPDATE public.bills_of_lading b SET vessel = n ->> 'vessel'
        FROM public.transaction_bls tb WHERE tb.transaction_id = v_tx.id AND tb.bl_id = b.id AND b.vessel IS NULL;
    END IF;
    FOR c IN SELECT jsonb_array_elements_text(coalesce(n -> 'containers', '[]'::jsonb)) LOOP
      INSERT INTO public.containers (org_id, transaction_id, container_no, source) VALUES (v.org_id, v_tx.id, c, 'import') RETURNING id INTO v_id;
      v_cr := v_cr || app.li_c('containers', v_id);
    END LOOP;
    RETURN jsonb_build_object('target_table', 'transactions', 'target_id', v_tx.id, 'created', v_cr);
  WHEN 'containers' THEN
    SELECT * INTO v_tx FROM public.transactions t WHERE t.id = app.li_resolve(n ->> 'tx_id', n ->> 'tx_row') AND t.org_id = v.org_id FOR UPDATE;
    IF v_tx.id IS NULL THEN PERFORM app.fail('MRS_LI_PARENT', 'transaction'); END IF;
    INSERT INTO public.containers (org_id, transaction_id, container_no, seal_no, size_type, notes, source)
    VALUES (v.org_id, v_tx.id, n ->> 'container_no', n ->> 'seal_no', n ->> 'size_type', n ->> 'notes', 'import') RETURNING id INTO v_id;
    UPDATE public.transactions t SET container_count = (SELECT count(*) FROM public.containers c2 WHERE c2.transaction_id = t.id)
     WHERE t.id = v_tx.id AND t.container_count < (SELECT count(*) FROM public.containers c2 WHERE c2.transaction_id = t.id);
    RETURN jsonb_build_object('target_table', 'containers', 'target_id', v_id, 'created', app.li_c('containers', v_id));
  WHEN 'movements' THEN
    SELECT * INTO v_tx FROM public.transactions t WHERE t.id = app.li_resolve(n ->> 'tx_id', n ->> 'tx_row') AND t.org_id = v.org_id FOR UPDATE;
    IF v_tx.id IS NULL THEN PERFORM app.fail('MRS_LI_PARENT', 'transaction'); END IF;
    IF n ? 'container_no' THEN
      SELECT * INTO v_ctr FROM public.containers c2 WHERE c2.transaction_id = v_tx.id AND c2.container_no = n ->> 'container_no' FOR UPDATE;
      IF v_ctr.id IS NULL THEN PERFORM app.fail('MRS_LI_PARENT', 'container'); END IF;
    END IF;
    -- the driver (directory, a drivers row of the run, or added now — reused by the next rows of the run), the truck
    v_drv := app.li_resolve(n ->> 'driver_id', n ->> 'driver_row');
    IF v_drv IS NULL AND (n ->> 'driver_new')::boolean THEN
      SELECT d.id INTO v_drv FROM public.drivers d WHERE d.org_id = v.org_id
         AND ((n ? 'driver_phone' AND d.phone = n ->> 'driver_phone') OR (NOT n ? 'driver_phone' AND app.norm_name(d.full_name) = app.norm_name(n ->> 'driver_name')))
       ORDER BY d.is_active DESC, d.created_at LIMIT 1;
      IF v_drv IS NULL THEN
        INSERT INTO public.drivers (org_id, full_name, phone) VALUES (v.org_id, n ->> 'driver_name', n ->> 'driver_phone') RETURNING id INTO v_drv;
        v_cr := v_cr || app.li_c('drivers', v_drv);
      END IF;
    END IF;
    SELECT * INTO x FROM app.li_truck(v.org_id, n ->> 'truck_plate', v_cr); v_cr := x.created; v_trk := x.id;
    v_ast := CASE n ->> 'movement_status' WHEN 'cancelled' THEN 'cancelled' WHEN 'delivered' THEN 'completed'
                                         WHEN 'incomplete' THEN 'requested' ELSE 'confirmed' END;
    IF n ? 'appointment_at' THEN
      INSERT INTO public.port_appointments (org_id, transaction_id, container_id, appointment_at, status, status_reason, appointment_no,
        booking_ref, operator_name, driver_id, truck_id, created_by)
      VALUES (v.org_id, v_tx.id, v_ctr.id, (n ->> 'appointment_at')::timestamptz, v_ast,
        CASE WHEN v_ast = 'cancelled' THEN 'ملغى في النظام القديم' END, n ->> 'appointment_no', n ->> 'booking_ref', n ->> 'operator_name',
        v_drv, v_trk, auth.uid())
      RETURNING id INTO v_appt;
      v_cr := v_cr || app.li_c('port_appointments', v_appt);
    END IF;
    IF (n ->> 'trip')::boolean THEN
      v_tst := CASE n ->> 'movement_status' WHEN 'cancelled' THEN 'cancelled' WHEN 'delivered' THEN 'delivered' ELSE 'planned' END;
      INSERT INTO public.transport_trips (org_id, transaction_id, container_id, appointment_id, driver_id, truck_id, destination, cost_amount,
        cost_currency, sell_amount, sell_currency, status, status_reason, unloaded_at, party_type, party_name, notes, created_by)
      VALUES (v.org_id, v_tx.id, v_ctr.id, v_appt, v_drv, v_trk, n ->> 'destination', (n ->> 'cost_amount')::numeric, 'SAR',
        (n ->> 'sell_amount')::numeric, 'SAR', v_tst, CASE WHEN v_tst = 'cancelled' THEN 'ملغى في النظام القديم' END,
        CASE WHEN v_tst = 'delivered' THEN (n ->> 'appointment_at')::timestamptz END,
        CASE WHEN v_drv IS NOT NULL THEN 'direct' END, left(coalesce(n ->> 'driver_name', (SELECT d.full_name FROM public.drivers d WHERE d.id = v_drv)), 160),
        n ->> 'notes', auth.uid())
      RETURNING id INTO v_trip;
      v_cr := v_cr || app.li_c('transport_trips', v_trip);
    END IF;
    -- the empty-return plan + the legacy actual date (data only; return_status stays pending: no proof is fabricated)
    IF v_ctr.id IS NOT NULL AND (n ? 'return_location' OR n ? 'return_deadline' OR n ? 'returned_at') THEN
      v_cr := v_cr || app.li_c('containers', v_ctr.id, 'update', jsonb_build_object('return_location', v_ctr.return_location,
                'return_deadline', v_ctr.return_deadline, 'returned_at', v_ctr.returned_at));
      UPDATE public.containers c2 SET return_location = coalesce(n ->> 'return_location', c2.return_location),
             return_deadline = coalesce((n ->> 'return_deadline')::date, c2.return_deadline),
             returned_at = coalesce((n ->> 'returned_at')::timestamptz, c2.returned_at)
       WHERE c2.id = v_ctr.id;
    END IF;
    RETURN jsonb_build_object('target_table', CASE WHEN v_appt IS NOT NULL THEN 'port_appointments' WHEN v_trip IS NOT NULL THEN 'transport_trips' ELSE 'containers' END,
      'target_id', coalesce(v_appt, v_trip, v_ctr.id), 'created', v_cr);
  WHEN 'payments' THEN
    v_id := app.li_resolve(n ->> 'tx_id', n ->> 'tx_row');
    IF v_id IS NULL THEN PERFORM app.fail('MRS_LI_PARENT', 'transaction'); END IF;
    v_benef := (n ->> 'beneficiary_party_id')::uuid;
    IF v_benef IS NULL AND n ? 'beneficiary_name' THEN
      SELECT pa.id INTO v_benef FROM public.parties pa WHERE pa.org_id = v.org_id AND lower(pa.name_ar) = lower(n ->> 'beneficiary_name');
      IF v_benef IS NULL THEN
        INSERT INTO public.parties (org_id, kinds, name_ar) VALUES (v.org_id, ARRAY['supplier'], n ->> 'beneficiary_name') RETURNING id INTO v_benef;
        v_cr := v_cr || app.li_c('parties', v_benef);
      END IF;
    END IF;
    v_pay := jsonb_strip_nulls(jsonb_build_object('movement_type', n ->> 'movement_type', 'pattern', 'single',
      'service_item_id', n ->> 'service_item_id', 'transaction_id', v_id, 'claim_no', n ->> 'claim_no',
      'internal_invoice_no', n ->> 'internal_invoice_no', 'appointment_no', n ->> 'appointment_no',
      'expected_amount', (n ->> 'expected_amount')::numeric, 'paid_amount', (n ->> 'paid_amount')::numeric, 'paid_at', n ->> 'paid_at',
      'funding_source', n ->> 'funding_source', 'method', n ->> 'method', 'paying_account', n ->> 'paying_account',
      'payer_name', n ->> 'payer_name', 'beneficiary_party_id', CASE WHEN n ->> 'movement_type' <> 'received_from_client' THEN v_benef END,
      'sadad_number', n ->> 'sadad_number', 'bank_reference', n ->> 'bank_reference', 'receipt_no', n ->> 'receipt_no',
      'notes', left(concat_ws(' | ', n ->> 'notes', 'مستورد من النظام القديم — ' || v.ref), 2000), 'review_status', 'pending'));
    v_res := public.record_payment_bundle(v_pay, NULL);
    v_id := (v_res ->> 'id')::uuid;
    RETURN jsonb_build_object('target_table', 'client_disbursements', 'target_id', v_id, 'created', app.li_c('client_disbursements', v_id) || v_cr);
  WHEN 'custody' THEN
    IF NOT coalesce((n ->> 'carrier')::boolean, false) OR coalesce((n ->> 'balance')::numeric, 0) <= 0 THEN
      -- a merged line: the target is the opening entry of the client (carried by the earliest line)
      SELECT o.target_id INTO v_id FROM public.legacy_import_rows o
       WHERE o.run_id = v.id AND o.entity = 'custody' AND o.normalized ->> 'client_key' = n ->> 'client_key'
         AND (o.normalized ->> 'carrier')::boolean AND o.status = 'committed';
      -- review fix: a positive balance whose carrier line did not commit (its deposit failed) is not «committed» either
      IF v_id IS NULL AND coalesce((n ->> 'balance')::numeric, 0) > 0 THEN PERFORM app.fail('MRS_LI_PARENT', 'custody'); END IF;
      RETURN jsonb_build_object('target_table', CASE WHEN v_id IS NOT NULL THEN 'client_custody_entries' END, 'target_id', v_id, 'created', '[]'::jsonb);
    END IF;
    v_cl := app.li_resolve(n ->> 'client_id', n ->> 'client_row');
    IF v_cl IS NULL THEN PERFORM app.fail('MRS_LI_PARENT', 'client'); END IF;
    v_res := public.save_custody_entry(jsonb_build_object('client_id', v_cl, 'kind', 'deposit', 'amount', (n ->> 'balance')::numeric,
      'entry_date', app.rpt_today()::text, 'branch_id', n ->> 'branch_id', 'reference', v.ref,
      'notes', 'رصيد افتتاحي من النظام القديم — دفعة الاستيراد ' || v.ref), NULL);
    v_id := (v_res ->> 'id')::uuid;
    RETURN jsonb_build_object('target_table', 'client_custody_entries', 'target_id', v_id, 'created', app.li_c('client_custody_entries', v_id));
  END CASE;
END $$;

-- the label of a committed row's target (for the rows report): a ref / name
CREATE OR REPLACE FUNCTION app.li_target_label(p_table text, p_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE p_table
    WHEN 'clients' THEN (SELECT c.name_ar FROM public.clients c WHERE c.id = p_id)
    WHEN 'client_aliases' THEN (SELECT a.alias FROM public.client_aliases a WHERE a.id = p_id)
    WHEN 'drivers' THEN (SELECT d.full_name FROM public.drivers d WHERE d.id = p_id)
    WHEN 'transactions' THEN (SELECT t.ref FROM public.transactions t WHERE t.id = p_id)
    WHEN 'containers' THEN (SELECT c.container_no || ' · ' || t.ref FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id WHERE c.id = p_id)
    WHEN 'port_appointments' THEN (SELECT t.ref || coalesce(' · ' || a.appointment_no, '') FROM public.port_appointments a JOIN public.transactions t ON t.id = a.transaction_id WHERE a.id = p_id)
    WHEN 'transport_trips' THEN (SELECT t.ref FROM public.transport_trips r JOIN public.transactions t ON t.id = r.transaction_id WHERE r.id = p_id)
    WHEN 'client_disbursements' THEN (SELECT d.ref FROM public.client_disbursements d WHERE d.id = p_id)
    WHEN 'client_custody_entries' THEN (SELECT e.ref FROM public.client_custody_entries e WHERE e.id = p_id)
  END
$$;

-- the run as JSON
CREATE OR REPLACE FUNCTION app.li_run_json(v public.legacy_import_runs) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', v.id, 'org_id', v.org_id, 'ref', v.ref, 'branch_id', v.branch_id,
    'branch_name', (SELECT b.name_ar FROM public.branches b WHERE b.id = v.branch_id), 'entities', to_jsonb(v.entities), 'status', v.status,
    'reason', v.reason, 'files', v.files, 'mapping', v.mapping, 'options', v.options, 'counts', v.counts, 'daftra', v.daftra,
    'created_by', v.created_by, 'created_by_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = v.created_by),
    'created_at', v.created_at, 'updated_at', v.updated_at, 'staged_at', v.staged_at, 'validated_at', v.validated_at,
    'commit_started_at', v.commit_started_at, 'committed_at', v.committed_at, 'committed_by', v.committed_by,
    'voided_at', v.voided_at, 'voided_by', v.voided_by, 'void_reason', v.void_reason,
    'pending', (SELECT count(*)::int FROM public.legacy_import_rows o WHERE o.run_id = v.id AND o.status = 'pending'),
    'to_commit', (SELECT count(*)::int FROM public.legacy_import_rows o WHERE o.run_id = v.id AND o.status IN ('valid','warning')))
$$;
-- refresh the counts of a run → the run
CREATE OR REPLACE FUNCTION app.li_touch(p_run uuid) RETURNS public.legacy_import_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.legacy_import_runs;
BEGIN
  UPDATE public.legacy_import_runs r SET counts = app.li_counts(r.id) WHERE r.id = p_run RETURNING * INTO v;
  RETURN v;
END $$;
-- every row back to pending (a new mapping, a skip): the validation must run again
CREATE OR REPLACE FUNCTION app.li_reset(p_run uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.legacy_import_rows o SET status = 'pending', messages = '[]'::jsonb, normalized = NULL WHERE o.run_id = p_run AND o.status <> 'pending';
  UPDATE public.legacy_import_runs r SET status = CASE WHEN EXISTS (SELECT 1 FROM public.legacy_import_rows o WHERE o.run_id = r.id) THEN 'staged' ELSE 'draft' END,
         validated_at = NULL
   WHERE r.id = p_run AND r.status IN ('draft','staged','validated');
$$;

-- the blockers of a void: created rows changed since the run completed (fingerprint), rows of others that use them, Daftra /
-- billing work on them → [{table, id, reason, label}] (≤ 100) + total
CREATE OR REPLACE FUNCTION app.li_void_blockers(v public.legacy_import_runs) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  b jsonb := '[]'::jsonb; v_t text; v_tx uuid[]; v_cl uuid[]; v_ctr uuid[]; v_ap uuid[]; v_tr uuid[]; v_dr uuid[]; v_tk uuid[]; v_pt uuid[];
  v_pay uuid[]; v_cus uuid[]; v_al uuid[]; v_dc uuid[]; d public.client_disbursements; v_lock text; v_gone uuid[];
BEGIN
  -- the created rows by table (set-based: one pass per table, review fix for large runs)
  SELECT coalesce(array_agg(z.id) FILTER (WHERE z.t = 'transactions'), '{}'), coalesce(array_agg(z.id) FILTER (WHERE z.t = 'clients'), '{}'),
         coalesce(array_agg(z.id) FILTER (WHERE z.t = 'containers'), '{}'), coalesce(array_agg(z.id) FILTER (WHERE z.t = 'port_appointments'), '{}'),
         coalesce(array_agg(z.id) FILTER (WHERE z.t = 'transport_trips'), '{}'), coalesce(array_agg(z.id) FILTER (WHERE z.t = 'drivers'), '{}'),
         coalesce(array_agg(z.id) FILTER (WHERE z.t = 'trucks'), '{}'), coalesce(array_agg(z.id) FILTER (WHERE z.t = 'parties'), '{}'),
         coalesce(array_agg(z.id) FILTER (WHERE z.t = 'client_disbursements'), '{}'), coalesce(array_agg(z.id) FILTER (WHERE z.t = 'client_custody_entries'), '{}'),
         coalesce(array_agg(z.id) FILTER (WHERE z.t = 'client_aliases'), '{}'), coalesce(array_agg(z.id) FILTER (WHERE z.t = 'customs_declarations'), '{}')
    INTO v_tx, v_cl, v_ctr, v_ap, v_tr, v_dr, v_tk, v_pt, v_pay, v_cus, v_al, v_dc
    FROM (SELECT x.value ->> 't' t, (x.value ->> 'id')::uuid id FROM public.legacy_import_rows o, jsonb_array_elements(o.created_rows) x
           WHERE o.run_id = v.id AND o.status = 'committed' AND x.value ->> 'a' = 'insert') z;
  -- harness fix: the rows another run of the org created and its own void already voided (cancelled appointments / trips,
  -- closed transactions, voided payments / custody, containers it kept on an older transaction) are left-overs of that void,
  -- not a later use of this run's rows: they never block (a staff row, whatever its status, still does)
  SELECT coalesce(array_agg(DISTINCT (x.value ->> 'id')::uuid), '{}') INTO v_gone
    FROM public.legacy_import_runs r2 JOIN public.legacy_import_rows o2 ON o2.run_id = r2.id, jsonb_array_elements(o2.created_rows) x
   WHERE r2.org_id = v.org_id AND r2.id <> v.id AND r2.status = 'voided' AND o2.status = 'committed' AND o2.voided_at IS NOT NULL
     AND x.value ->> 'a' = 'insert';
  -- created rows changed since their commit (fingerprint taken when the row committed, re-taken only for the run's own updates)
  FOREACH v_t IN ARRAY ARRAY['clients','client_aliases','drivers','trucks','parties','transactions','containers','customs_declarations',
                             'port_appointments','transport_trips','client_disbursements','client_custody_entries'] LOOP
    b := b || coalesce((SELECT jsonb_agg(jsonb_build_object('table', v_t, 'id', e.id, 'reason', CASE WHEN f.fp IS NULL THEN 'missing' ELSE 'changed' END,
                                 'label', coalesce(app.li_target_label(v_t, e.id), nullif(e.sheet, '') || ' #' || e.row_no)))
        FROM (SELECT DISTINCT ON (x.value ->> 'id', x.value ->> 'fp') (x.value ->> 'id')::uuid id, x.value ->> 'fp' fp, o.sheet, o.row_no
                FROM public.legacy_import_rows o, jsonb_array_elements(o.created_rows) x
               WHERE o.run_id = v.id AND o.status = 'committed' AND x.value ->> 't' = v_t AND x.value ->> 'fp' IS NOT NULL) e
        LEFT JOIN app.li_fps(v_t, ARRAY(SELECT (x.value ->> 'id')::uuid FROM public.legacy_import_rows o, jsonb_array_elements(o.created_rows) x
                                         WHERE o.run_id = v.id AND o.status = 'committed' AND x.value ->> 't' = v_t)) f ON f.id = e.id
       WHERE f.fp IS DISTINCT FROM e.fp), '[]'::jsonb);
  END LOOP;
  -- rows of others on the imported transactions / clients / containers / directory entries
  b := b || coalesce((SELECT jsonb_agg(z.j) FROM (
      SELECT jsonb_build_object('table', 'containers', 'id', c.id, 'reason', 'added_later', 'label', c.container_no) j FROM public.containers c
       WHERE c.transaction_id = ANY (v_tx) AND NOT (c.id = ANY (v_ctr)) AND NOT (c.id = ANY (v_gone))
      UNION ALL SELECT jsonb_build_object('table', 'port_appointments', 'id', a.id, 'reason', 'added_later', 'label', a.appointment_no) FROM public.port_appointments a
       WHERE (a.transaction_id = ANY (v_tx) OR a.driver_id = ANY (v_dr) OR a.truck_id = ANY (v_tk) OR a.container_id = ANY (v_ctr)) AND NOT (a.id = ANY (v_ap)) AND NOT (a.id = ANY (v_gone))
      UNION ALL SELECT jsonb_build_object('table', 'transport_trips', 'id', r.id, 'reason', 'added_later', 'label', r.destination) FROM public.transport_trips r
       WHERE (r.transaction_id = ANY (v_tx) OR r.driver_id = ANY (v_dr) OR r.truck_id = ANY (v_tk) OR r.container_id = ANY (v_ctr)) AND NOT (r.id = ANY (v_tr)) AND NOT (r.id = ANY (v_gone))
      UNION ALL SELECT jsonb_build_object('table', 'customs_declarations', 'id', d2.id, 'reason', 'added_later', 'label', d2.declaration_no) FROM public.customs_declarations d2
       WHERE d2.transaction_id = ANY (v_tx) AND NOT (d2.id = ANY (v_dc)) AND NOT (d2.id = ANY (v_gone))
      UNION ALL SELECT jsonb_build_object('table', 'documents', 'id', dd.id, 'reason', 'added_later', 'label', NULL) FROM public.documents dd
       WHERE dd.transaction_id = ANY (v_tx)
      UNION ALL SELECT jsonb_build_object('table', 'empty_return_proofs', 'id', pr.id, 'reason', 'added_later', 'label', pr.container_no) FROM public.empty_return_proofs pr
       WHERE pr.transaction_id = ANY (v_tx) OR pr.container_id = ANY (v_ctr)
      UNION ALL SELECT jsonb_build_object('table', 'appointment_drafts', 'id', ad.id, 'reason', 'added_later', 'label', NULL) FROM public.appointment_drafts ad
       WHERE ad.transaction_id = ANY (v_tx)
      UNION ALL SELECT jsonb_build_object('table', 'operational_exceptions', 'id', ox.id, 'reason', 'added_later', 'label', NULL) FROM public.operational_exceptions ox
       WHERE ox.transaction_id = ANY (v_tx) OR ox.container_id = ANY (v_ctr)
      UNION ALL SELECT jsonb_build_object('table', 'demurrage_cases', 'id', dm.id, 'reason', 'added_later', 'label', NULL) FROM public.demurrage_cases dm
       WHERE (dm.transaction_id = ANY (v_tx) OR dm.container_id = ANY (v_ctr)) AND dm.status <> 'void'
      UNION ALL SELECT jsonb_build_object('table', 'cost_accruals', 'id', ca.id, 'reason', 'billing', 'label', NULL) FROM public.cost_accruals ca
       WHERE (ca.transaction_id = ANY (v_tx) OR ca.container_id = ANY (v_ctr)) AND ca.status <> 'void'
      UNION ALL SELECT jsonb_build_object('table', 'cost_adjustments', 'id', cj.id, 'reason', 'billing', 'label', NULL) FROM public.cost_adjustments cj
       WHERE (cj.transaction_id = ANY (v_tx) OR cj.container_id = ANY (v_ctr)) AND cj.status <> 'rejected'
      UNION ALL SELECT jsonb_build_object('table', 'cost_allocations', 'id', cl.id, 'reason', 'billing', 'label', NULL) FROM public.cost_allocations cl
       WHERE (cl.transaction_id = ANY (v_tx) OR cl.container_id = ANY (v_ctr)) AND cl.status NOT IN ('rejected','reversed')
      UNION ALL SELECT jsonb_build_object('table', 'billing_intents', 'id', bi.id, 'reason', 'billing', 'label', bi.daftra_number) FROM public.billing_intents bi
       WHERE bi.transaction_id = ANY (v_tx)
      UNION ALL SELECT jsonb_build_object('table', 'billing_sync_jobs', 'id', j.id, 'reason', 'daftra_sync_in_flight', 'label', j.kind) FROM public.billing_sync_jobs j
       WHERE j.transaction_id = ANY (v_tx) AND j.status IN ('queued','running','unknown')
      UNION ALL SELECT jsonb_build_object('table', 'client_charges', 'id', ch.id, 'reason', 'billing', 'label', ch.description) FROM public.client_charges ch
       WHERE (ch.transaction_id = ANY (v_tx) OR ch.container_id = ANY (v_ctr)) AND ch.status <> 'void'
      UNION ALL SELECT jsonb_build_object('table', 'disbursement_allocations', 'id', al.id, 'reason', 'added_later', 'label', NULL) FROM public.disbursement_allocations al
       WHERE (al.transaction_id = ANY (v_tx) OR al.client_id = ANY (v_cl) OR al.beneficiary_party_id = ANY (v_pt)) AND al.voided_at IS NULL AND NOT (al.disbursement_id = ANY (v_pay)) AND NOT (al.disbursement_id = ANY (v_gone))
      UNION ALL SELECT jsonb_build_object('table', 'client_custody_entries', 'id', ce.id, 'reason', 'added_later', 'label', ce.ref) FROM public.client_custody_entries ce
       WHERE (ce.transaction_id = ANY (v_tx) OR ce.client_id = ANY (v_cl) OR ce.disbursement_id = ANY (v_pay)) AND ce.status = 'active' AND NOT (ce.id = ANY (v_cus)) AND NOT (ce.id = ANY (v_gone))
      UNION ALL SELECT jsonb_build_object('table', 'transactions', 'id', t.id, 'reason', 'added_later', 'label', t.ref) FROM public.transactions t
       WHERE (t.client_id = ANY (v_cl) OR t.terminal_party_id = ANY (v_pt) OR t.transport_party_id = ANY (v_pt)) AND NOT (t.id = ANY (v_tx)) AND NOT (t.id = ANY (v_gone))
      UNION ALL SELECT jsonb_build_object('table', 'client_aliases', 'id', ca.id, 'reason', 'added_later', 'label', ca.alias) FROM public.client_aliases ca
       WHERE ca.client_id = ANY (v_cl) AND NOT (ca.id = ANY (v_al)) AND NOT (ca.id = ANY (v_gone))
      UNION ALL SELECT jsonb_build_object('table', 'client_users', 'id', cu.id, 'reason', 'added_later', 'label', NULL) FROM public.client_users cu
       WHERE cu.client_id = ANY (v_cl)
      UNION ALL SELECT jsonb_build_object('table', 'daftra_client_links', 'id', dl.id, 'reason', 'billing', 'label', NULL) FROM public.daftra_client_links dl
       WHERE dl.client_id = ANY (v_cl)
      UNION ALL SELECT jsonb_build_object('table', 'client_disbursements', 'id', cd.id, 'reason', 'added_later', 'label', cd.ref) FROM public.client_disbursements cd
       WHERE cd.beneficiary_party_id = ANY (v_pt) AND cd.status = 'recorded' AND NOT (cd.id = ANY (v_pay)) AND NOT (cd.id = ANY (v_gone))
      UNION ALL SELECT jsonb_build_object('table', 'payment_documents', 'id', pd.id, 'reason', 'added_later', 'label', NULL) FROM public.payment_documents pd
       WHERE pd.disbursement_id = ANY (v_pay) AND pd.removed_at IS NULL
     LIMIT 200) z), '[]'::jsonb);
  -- payments the step-6 rules lock (Daftra link, invoiced charge, custody deduction)
  FOR d IN SELECT * FROM public.client_disbursements x WHERE x.id = ANY (v_pay) AND x.status = 'recorded' LOOP
    v_lock := app.pay_locked(d);
    IF v_lock IS NOT NULL THEN b := b || jsonb_build_array(jsonb_build_object('table', 'client_disbursements', 'id', d.id, 'reason', 'payment_' || v_lock, 'label', d.ref)); END IF;
  END LOOP;
  RETURN jsonb_build_object('total', jsonb_array_length(b), 'items', (SELECT coalesce(jsonb_agg(y), '[]'::jsonb) FROM (SELECT y FROM jsonb_array_elements(b) y LIMIT 100) q));
END $$;

-- ---------------------------------------------------------------------
-- 4. RPCs (authenticated; owner only, aal2)
-- ---------------------------------------------------------------------
-- legacy_import_dictionary() → {entities: [{entity, order, sheets[], fields: [{key, required, headers[]}]}], limits, labels}: the
-- canonical legacy headers the browser auto-detects (exact header text after trimming / folding), the field keys rows are sent with,
-- the dependency order, the size caps and the Arabic / English labels of the row messages / statuses. No tenant data.
CREATE OR REPLACE FUNCTION public.legacy_import_dictionary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  RETURN jsonb_build_object('version', '20261125000100', 'entities', app.li_dictionary(),
    'limits', jsonb_build_object('files', 20, 'file_bytes', 10485760, 'rows_per_call', 500, 'row_bytes', 16384, 'call_bytes', 2097152,
                                 'rows_per_run', 50000, 'value_chars', 2000, 'validate_per_call', 500, 'commit_per_call', 200,
                                 'validate_default', 300, 'commit_default', 100),
    'labels', (SELECT jsonb_object_agg(l.domain, l.v) FROM (
        SELECT s.domain, jsonb_object_agg(s.code, jsonb_build_object('ar', s.label_ar, 'en', s.label_en)) v FROM public.status_labels s
         WHERE s.domain IN ('li_entity','li_run_status','li_row_status','li_message') GROUP BY 1) l),
    'defaults', jsonb_build_object('funding_sources', ARRAY['org_account','cash_box','fasah_wallet','dry_port_wallet_org','client_custody',
                                                            'client_custody_dry_port','personal_account'],
                                   'movement_types', ARRAY['org_paid','received_from_client','client_direct']));
END $$;

-- legacy_import_create_run(p_org, {branch_id?, entities[], files [{name, sha256, size, sheets[]}] ≤ 20, mapping?, options?, reason},
-- p_idem_key) — the owner opens ONE run (one open run per org: MRS_LI_STATE open_run)
CREATE OR REPLACE FUNCTION public.legacy_import_create_run(p_org uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v_replay jsonb; v public.legacy_import_runs; v_branch uuid; v_ent text[]; v_files jsonb := '[]'::jsonb;
        f jsonb; v_reason text; v_seq bigint;
BEGIN
  PERFORM app.li_gate(p_org);
  PERFORM app.only_keys(p, ARRAY['branch_id','entities','files','mapping','options','reason']);
  v_replay := app.idem_begin('legacy_import_create_run', p_idem_key, p, p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_reason := nullif(btrim(coalesce(p ->> 'reason', '')), '');
  IF v_reason IS NULL OR char_length(v_reason) < 3 THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  v_branch := app.puuid(p, 'branch_id');
  IF v_branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v_branch AND b.org_id = p_org AND b.is_active) THEN
    PERFORM app.fail('MRS_INVALID', 'branch_id');
  END IF;
  IF jsonb_typeof(p -> 'entities') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'entities') = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'entities'); END IF;
  v_ent := ARRAY(SELECT DISTINCT e FROM jsonb_array_elements_text(p -> 'entities') e);
  IF NOT (v_ent <@ ARRAY['customers','aliases','drivers','transactions','containers','movements','payments','custody']) THEN
    PERFORM app.fail('MRS_INVALID', 'entities');
  END IF;
  v_ent := ARRAY(SELECT e FROM unnest(v_ent) e ORDER BY app.li_rank(e));
  IF p ? 'files' AND jsonb_typeof(p -> 'files') <> 'array' THEN PERFORM app.fail('MRS_INVALID', 'files'); END IF;
  IF jsonb_array_length(coalesce(p -> 'files', '[]'::jsonb)) > 20 THEN PERFORM app.fail('MRS_LI_LIMIT', 'files'); END IF;
  FOR f IN SELECT x FROM jsonb_array_elements(coalesce(p -> 'files', '[]'::jsonb)) x LOOP
    IF jsonb_typeof(f) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'files'); END IF;
    PERFORM app.only_keys(f, ARRAY['name','sha256','size','sheets']);
    IF app.ptext(f, 'name', 255, true) IS NULL OR coalesce(f ->> 'sha256', '') !~ '^[0-9a-f]{64}$' THEN PERFORM app.fail('MRS_INVALID', 'files'); END IF;
    IF coalesce(app.pnum(f, 'size', 1e12), 0) > 10485760 OR coalesce(app.pnum(f, 'size', 1e12), 0) < 0 THEN PERFORM app.fail('MRS_LI_LIMIT', 'file_bytes'); END IF;
    IF f ? 'sheets' AND (jsonb_typeof(f -> 'sheets') <> 'array' OR jsonb_array_length(f -> 'sheets') > 50
                         OR EXISTS (SELECT 1 FROM jsonb_array_elements(f -> 'sheets') s WHERE jsonb_typeof(s) <> 'string' OR char_length(s #>> '{}') > 120)) THEN
      PERFORM app.fail('MRS_INVALID', 'files');
    END IF;
    v_files := v_files || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('name', f ->> 'name', 'sha256', f ->> 'sha256',
      'size', app.pnum(f, 'size', 1e12), 'sheets', f -> 'sheets')));
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.legacy_import_runs r WHERE r.org_id = p_org AND r.status IN ('draft','staged','validated','committing','voiding')) THEN
    PERFORM app.fail('MRS_LI_STATE', 'open_run');
  END IF;
  PERFORM app.li_options_check(p_org, p -> 'mapping', p -> 'options');
  v_seq := nextval('public.legacy_import_runs_seq');
  INSERT INTO public.legacy_import_runs (org_id, ref, branch_id, entities, reason, files, mapping, options, created_by)
  VALUES (p_org, 'LIR-' || lpad(v_seq::text, 6, '0'), v_branch, v_ent, v_reason, v_files, coalesce(p -> 'mapping', '{}'::jsonb),
          coalesce(p -> 'options', '{}'::jsonb), auth.uid())
  RETURNING * INTO v;
  v := app.li_touch(v.id);
  RETURN app.idem_finish('legacy_import_create_run', p_idem_key, app.li_run_json(v));
END $$;

-- the mapping / options of a run: mapping {ports|service_items|clients|branches: {legacy text: code / id}} (≤ 500 entries each),
-- options {default_funding_source?, default_paying_account?, default_movement_type?, daftra_invoice_prefix?}
CREATE OR REPLACE FUNCTION app.li_options_check(p_org uuid, p_map jsonb, p_opt jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; e record;
BEGIN
  IF p_map IS NOT NULL AND jsonb_typeof(p_map) <> 'null' THEN
    IF jsonb_typeof(p_map) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'mapping'); END IF;
    PERFORM app.only_keys(p_map, ARRAY['ports','service_items','clients','branches']);
    FOR k IN SELECT jsonb_object_keys(p_map) LOOP
      IF jsonb_typeof(p_map -> k) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_map -> k)) > 500 THEN PERFORM app.fail('MRS_INVALID', 'mapping'); END IF;
      FOR e IN SELECT x.key, x.value FROM jsonb_each(p_map -> k) x LOOP
        IF jsonb_typeof(e.value) <> 'string' OR char_length(e.key) > 200 OR char_length(e.value #>> '{}') > 60 THEN PERFORM app.fail('MRS_INVALID', 'mapping'); END IF;
        IF k = 'ports' AND NOT EXISTS (SELECT 1 FROM public.customs_ports c WHERE c.code = upper(e.value #>> '{}') AND c.is_active) THEN
          PERFORM app.fin_fail('MRS_INVALID', 'mapping_port', e.key);
        ELSIF k = 'service_items' AND NOT EXISTS (SELECT 1 FROM public.org_service_items s WHERE s.org_id = p_org AND s.is_active
                                                   AND (s.code = e.value #>> '{}' OR s.id::text = e.value #>> '{}')) THEN
          PERFORM app.fin_fail('MRS_INVALID', 'mapping_service_item', e.key);
        ELSIF k = 'clients' AND NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.org_id = p_org AND c.id::text = e.value #>> '{}') THEN
          PERFORM app.fin_fail('MRS_INVALID', 'mapping_client', e.key);
        ELSIF k = 'branches' AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.org_id = p_org AND b.is_active AND b.id::text = e.value #>> '{}') THEN
          PERFORM app.fin_fail('MRS_INVALID', 'mapping_branch', e.key);
        END IF;
      END LOOP;
    END LOOP;
  END IF;
  IF p_opt IS NOT NULL AND jsonb_typeof(p_opt) <> 'null' THEN
    IF jsonb_typeof(p_opt) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'options'); END IF;
    PERFORM app.only_keys(p_opt, ARRAY['default_funding_source','default_paying_account','default_movement_type','daftra_invoice_prefix']);
    IF p_opt ? 'default_funding_source' AND jsonb_typeof(p_opt -> 'default_funding_source') <> 'null'
       AND NOT (p_opt ->> 'default_funding_source' = ANY (ARRAY['org_account','cash_box','fasah_wallet','dry_port_wallet_org','client_custody',
                                                              'client_custody_dry_port','personal_account'])) THEN
      PERFORM app.fail('MRS_INVALID', 'default_funding_source');
    END IF;
    IF p_opt ? 'default_movement_type' AND jsonb_typeof(p_opt -> 'default_movement_type') <> 'null'
       AND NOT (p_opt ->> 'default_movement_type' = ANY (ARRAY['org_paid','received_from_client','client_direct'])) THEN
      PERFORM app.fail('MRS_INVALID', 'default_movement_type');
    END IF;
    IF char_length(coalesce(p_opt ->> 'default_paying_account', '')) > 120 THEN PERFORM app.fail('MRS_TOO_LONG', 'default_paying_account'); END IF;
    IF p_opt ? 'daftra_invoice_prefix' AND coalesce(p_opt ->> 'daftra_invoice_prefix', '') !~ '^[A-Za-z0-9]{1,10}-?$' THEN
      PERFORM app.fail('MRS_INVALID', 'daftra_invoice_prefix');
    END IF;
  END IF;
END $$;

-- legacy_import_set_options(p_run, {branch_id?, mapping?, options?}) — before the commit; every row goes back to pending
CREATE OR REPLACE FUNCTION public.legacy_import_set_options(p_run uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v public.legacy_import_runs; v_branch uuid;
BEGIN
  v := app.li_run(p_run, true);
  IF v.status NOT IN ('draft','staged','validated') THEN PERFORM app.fail('MRS_LI_STATE', v.status); END IF;
  PERFORM app.only_keys(p, ARRAY['branch_id','mapping','options']);
  PERFORM app.li_options_check(v.org_id, p -> 'mapping', p -> 'options');
  IF p ? 'branch_id' THEN
    v_branch := app.puuid(p, 'branch_id');
    IF v_branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v_branch AND b.org_id = v.org_id AND b.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'branch_id');
    END IF;
  ELSE v_branch := v.branch_id;
  END IF;
  UPDATE public.legacy_import_runs r SET branch_id = v_branch,
         mapping = CASE WHEN p ? 'mapping' THEN coalesce(nullif(p -> 'mapping', 'null'::jsonb), '{}'::jsonb) ELSE r.mapping END,
         options = CASE WHEN p ? 'options' THEN coalesce(nullif(p -> 'options', 'null'::jsonb), '{}'::jsonb) ELSE r.options END
   WHERE r.id = v.id;
  PERFORM app.li_reset(v.id);
  RETURN app.li_run_json(app.li_touch(v.id));
END $$;

-- legacy_import_stage(p_run, {entity, sheet, rows: [{row_no, data {field: value}}] ≤ 500}) — stages one chunk of one sheet.
-- Values: strings / numbers / booleans / null, ≤ 2000 characters; keys outside the entity's dictionary are dropped (counted);
-- a row ≤ 16 KB, a call ≤ 2 MB, a run ≤ 50000 rows. Idempotent: the same content at the same place (sha256 of entity + sheet + row
-- no + data) is staged once (re-sent → 'unchanged'); a row of the same sheet + row no with new content replaces the pending one;
-- replace: true (the first chunk of a sheet) removes every row staged before under that sheet label.
CREATE OR REPLACE FUNCTION public.legacy_import_stage(p_run uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v public.legacy_import_runs; v_ent text; v_sheet text; x jsonb; d jsonb; k text; v_keys text[];
  v_clean jsonb; v_hash text; v_no int; v_ins int := 0; v_same int := 0; v_repl int := 0; v_drop int := 0; v_del int := 0; v_old public.legacy_import_rows;
BEGIN
  v := app.li_run(p_run, true);
  IF v.status NOT IN ('draft','staged','validated') THEN PERFORM app.fail('MRS_LI_STATE', v.status); END IF;
  PERFORM app.only_keys(p, ARRAY['entity','sheet','rows','replace']);
  IF octet_length(p::text) > 2097152 THEN PERFORM app.fail('MRS_LI_LIMIT', 'call_bytes'); END IF;
  v_ent := app.ptext(p, 'entity', 20, true);
  IF NOT (v_ent = ANY (v.entities)) THEN PERFORM app.fail('MRS_INVALID', 'entity'); END IF;
  v_sheet := coalesce(app.ptext(p, 'sheet', 120), '');
  IF jsonb_typeof(p -> 'rows') IS DISTINCT FROM 'array' THEN PERFORM app.fail('MRS_REQUIRED', 'rows'); END IF;
  IF jsonb_array_length(p -> 'rows') > 500 THEN PERFORM app.fail('MRS_LI_LIMIT', 'rows_per_call'); END IF;
  IF p ? 'replace' AND jsonb_typeof(p -> 'replace') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'replace'); END IF;
  -- review fix (corrected files): replace = this call starts the sheet again — every staged row of that sheet label (any entity:
  -- the owner may have changed it) is removed first, so a line deleted or moved in the corrected file is not committed. Nothing
  -- of the run is committed yet in these states.
  IF coalesce((p ->> 'replace')::boolean, false) THEN
    DELETE FROM public.legacy_import_rows o WHERE o.run_id = v.id AND o.sheet = v_sheet;
    GET DIAGNOSTICS v_del = ROW_COUNT;
  END IF;
  IF (SELECT count(*) FROM public.legacy_import_rows o WHERE o.run_id = v.id) + jsonb_array_length(p -> 'rows') > 50000 THEN
    PERFORM app.fail('MRS_LI_LIMIT', 'rows_per_run');
  END IF;
  v_keys := ARRAY(SELECT f ->> 'key' FROM jsonb_array_elements((SELECT e -> 'fields' FROM jsonb_array_elements(app.li_dictionary()) e
                                                                 WHERE e ->> 'entity' = v_ent)) f);
  FOR x IN SELECT y FROM jsonb_array_elements(p -> 'rows') y LOOP
    IF jsonb_typeof(x) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'rows'); END IF;
    PERFORM app.only_keys(x, ARRAY['row_no','data']);
    IF jsonb_typeof(x -> 'row_no') <> 'number' OR (x ->> 'row_no') !~ '^[0-9]+$' OR (x ->> 'row_no')::bigint NOT BETWEEN 1 AND 1000000 THEN
      PERFORM app.fail('MRS_INVALID', 'row_no');
    END IF;
    v_no := (x ->> 'row_no')::int;
    d := x -> 'data';
    IF jsonb_typeof(d) IS DISTINCT FROM 'object' THEN PERFORM app.fail('MRS_INVALID', 'data'); END IF;
    v_clean := '{}'::jsonb;
    FOR k IN SELECT jsonb_object_keys(d) LOOP
      IF NOT (k = ANY (v_keys)) THEN v_drop := v_drop + 1; CONTINUE; END IF;
      IF jsonb_typeof(d -> k) NOT IN ('string','number','boolean','null') THEN PERFORM app.fin_fail('MRS_INVALID', 'value', k); END IF;
      IF jsonb_typeof(d -> k) = 'null' OR btrim(d ->> k) = '' THEN CONTINUE; END IF;
      IF char_length(d ->> k) > 2000 THEN PERFORM app.fin_fail('MRS_TOO_LONG', 'value', k); END IF;
      v_clean := v_clean || jsonb_build_object(k, CASE WHEN jsonb_typeof(d -> k) = 'string' THEN d -> k ELSE to_jsonb(d ->> k) END);
    END LOOP;
    IF v_clean = '{}'::jsonb THEN CONTINUE; END IF;                       -- an empty line of the sheet
    IF octet_length(v_clean::text) > 16384 THEN PERFORM app.fin_fail('MRS_LI_LIMIT', 'row_bytes', v_no::text); END IF;
    -- review fix: the place (sheet + row no) is part of the hash — two equal lines of a sheet are two rows (the validation flags
    -- the real duplicates); the same content re-sent at the same place stays one row ('unchanged')
    v_hash := encode(sha256(convert_to(v_ent || ':' || v_sheet || ':' || v_no::text || ':' || v_clean::text, 'UTF8')), 'hex');
    SELECT * INTO v_old FROM public.legacy_import_rows o WHERE o.run_id = v.id AND o.entity = v_ent AND o.sheet = v_sheet AND o.row_no = v_no;
    IF v_old.id IS NOT NULL AND v_old.row_hash = v_hash THEN v_same := v_same + 1; CONTINUE; END IF;
    IF v_old.id IS NOT NULL THEN
      UPDATE public.legacy_import_rows o SET raw = v_clean, row_hash = v_hash, status = 'pending', messages = '[]'::jsonb, normalized = NULL
       WHERE o.id = v_old.id;
      v_repl := v_repl + 1;
    ELSE
      INSERT INTO public.legacy_import_rows (org_id, run_id, entity, sheet, row_no, raw, row_hash) VALUES (v.org_id, v.id, v_ent, v_sheet, v_no, v_clean, v_hash);
      v_ins := v_ins + 1;
    END IF;
  END LOOP;
  IF v_ins + v_repl + v_del > 0 THEN PERFORM app.li_reset(v.id); END IF;
  UPDATE public.legacy_import_runs r SET status = CASE WHEN r.status = 'draft' AND EXISTS (SELECT 1 FROM public.legacy_import_rows o WHERE o.run_id = r.id) THEN 'staged' ELSE r.status END,
         staged_at = now()
   WHERE r.id = v.id;
  RETURN jsonb_build_object('received', jsonb_array_length(p -> 'rows'), 'inserted', v_ins, 'replaced', v_repl, 'unchanged', v_same,
                            'removed', v_del, 'dropped_keys', v_drop, 'run', app.li_run_json(app.li_touch(v.id)));
END $$;

-- legacy_import_validate(p_run, {limit? ≤ 500, default 300}) — the server-side dry run, in dependency order (customers → … → custody), resumable:
-- call again while done = false. → {done, processed, run}
CREATE OR REPLACE FUNCTION public.legacy_import_validate(p_run uuid, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v public.legacy_import_runs; v_lim int; r public.legacy_import_rows; c jsonb; ctx jsonb;
        v_n int := 0; v_done boolean; v_ent text;
BEGIN
  v := app.li_run(p_run, true);
  IF v.status NOT IN ('staged','validated') THEN PERFORM app.fail('MRS_LI_STATE', v.status); END IF;
  PERFORM app.only_keys(p, ARRAY['limit']);
  v_lim := least(greatest(coalesce(app.pnum(p, 'limit', 100000)::int, 300), 1), 500);
  PERFORM app.li_analyze();
  ctx := app.li_ctx(v.org_id);
  -- one entity per call, the first in dependency order with pending rows: a later entity waits until every earlier one is checked
  -- (its parents must be final). Review fix: the entity is chosen once per call (index probes), not re-checked per row.
  v_ent := app.li_next_entity(v.id, ARRAY['pending']);
  IF v_ent IS NOT NULL THEN
    FOR r IN SELECT * FROM public.legacy_import_rows o WHERE o.run_id = v.id AND o.entity = v_ent AND o.status = 'pending'
              ORDER BY o.sheet, o.row_no, o.id LIMIT v_lim LOOP
      c := app.li_check(r, v, ctx);
      UPDATE public.legacy_import_rows o SET status = c ->> 'status', normalized = c -> 'n', messages = c -> 'm' WHERE o.id = r.id;
      v_n := v_n + 1;
    END LOOP;
  END IF;
  v_done := app.li_next_entity(v.id, ARRAY['pending']) IS NULL;
  IF v_done THEN
    PERFORM app.li_custody_finalize(v.id);
    UPDATE public.legacy_import_runs x SET status = 'validated', validated_at = now() WHERE x.id = v.id;
  END IF;
  RETURN jsonb_build_object('done', v_done, 'processed', v_n, 'run', app.li_run_json(app.li_touch(v.id)));
END $$;

-- legacy_import_commit(p_run, {limit? ≤ 200, default 100, confirm: true}) — writes the valid / warning rows in dependency order, each row in its own
-- savepoint (a failing row becomes an error with the code, the others go on), idempotent (a committed row is never written twice:
-- a retry after a timeout continues where the last committed call stopped), one call at a time per run (MRS_LI_BUSY). Lifecycle
-- triggers are off while it writes. The run is committed when no row is left. Each row's created rows are fingerprinted as it
-- commits (review fix: an edit made while the run is still committing is visible to the void).
-- → {done, committed, failed, run}
CREATE OR REPLACE FUNCTION public.legacy_import_commit(p_run uuid, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v public.legacy_import_runs; v_lim int; r public.legacy_import_rows; c jsonb; a jsonb; ctx jsonb;
  v_ok int := 0; v_bad int := 0; v_done boolean; v_state text; v_msg text; v_det text; v_ent text; v_pre jsonb;
BEGIN
  v := app.li_run(p_run, true);
  IF v.status NOT IN ('validated','committing') THEN PERFORM app.fail('MRS_LI_STATE', v.status); END IF;
  PERFORM app.only_keys(p, ARRAY['limit','confirm']);
  IF v.status = 'validated' AND NOT coalesce(app.pbool(p, 'confirm'), false) THEN PERFORM app.fail('MRS_REQUIRED', 'confirm'); END IF;
  v_lim := least(greatest(coalesce(app.pnum(p, 'limit', 100000)::int, 100), 1), 200);
  IF v.status = 'validated' THEN
    UPDATE public.legacy_import_runs x SET status = 'committing', commit_started_at = now() WHERE x.id = v.id RETURNING * INTO v;
  END IF;
  -- lifecycle triggers off until the end of this transaction (deferred triggers included: the opening Daftra draft fires at COMMIT)
  PERFORM set_config('marsa.li_run', v.id::text, true);
  PERFORM app.li_analyze();
  ctx := app.li_ctx(v.org_id);
  v_ent := app.li_next_entity(v.id, ARRAY['valid','warning']);
  IF v_ent IS NOT NULL THEN
    FOR r IN SELECT * FROM public.legacy_import_rows o WHERE o.run_id = v.id AND o.entity = v_ent AND o.status IN ('valid','warning')
              ORDER BY o.sheet, o.row_no, o.id LIMIT v_lim LOOP
      -- re-checked now (the data may have changed since the validation); custody keeps its finalised balance
      c := app.li_check(r, v, ctx);
      IF r.entity = 'custody' AND c ->> 'status' IN ('valid','warning') THEN
        c := jsonb_set(jsonb_set(c, '{n}', (c -> 'n') || (r.normalized - 'keys')), '{m}', r.messages);
      END IF;
      IF c ->> 'status' NOT IN ('valid','warning') THEN
        UPDATE public.legacy_import_rows o SET status = c ->> 'status', normalized = c -> 'n', messages = c -> 'm' WHERE o.id = r.id;
        v_bad := v_bad + 1;
        CONTINUE;
      END IF;
      BEGIN
        -- review fix (void baseline): the fingerprints are taken per row, right after its own apply; earlier rows of the run this
        -- apply updates on purpose are re-baselined only when nobody changed them in between
        v_pre := app.li_fp_pre(v.id, app.li_touch_ids(v, c -> 'n'));
        a := app.li_apply(r, v, c -> 'n');
        PERFORM app.li_fp_post(v_pre);
        UPDATE public.legacy_import_rows o SET status = 'committed', normalized = c -> 'n', messages = c -> 'm', committed_at = now(),
               target_table = a ->> 'target_table', target_id = (a ->> 'target_id')::uuid,
               created_rows = (SELECT coalesce(jsonb_agg(e || jsonb_build_object('fp', app.li_fp(e ->> 't', (e ->> 'id')::uuid)) ORDER BY q.k), '[]'::jsonb)
                                 FROM jsonb_array_elements(coalesce(a -> 'created', '[]'::jsonb)) WITH ORDINALITY q(e, k))
         WHERE o.id = r.id;
        v_ok := v_ok + 1;
      EXCEPTION WHEN others THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_det = PG_EXCEPTION_DETAIL;
        UPDATE public.legacy_import_rows o SET status = 'error', normalized = c -> 'n',
               messages = (c -> 'm') || app.li_m('error', CASE WHEN v_msg = 'MRS_LI_PARENT' THEN 'parent_failed' ELSE 'commit_failed' END, nullif(v_det, ''),
                                                 CASE WHEN v_msg ~ '^MRS_' THEN v_msg || coalesce(' ' || nullif(v_det, ''), '')
                                                      WHEN v_state IN ('23505','23514','23503') THEN 'constraint ' || v_state ELSE 'error ' || v_state END)
         WHERE o.id = r.id;
        v_bad := v_bad + 1;
      END;
    END LOOP;
  END IF;
  v_done := app.li_next_entity(v.id, ARRAY['valid','warning','pending']) IS NULL;
  IF v_done THEN
    UPDATE public.legacy_import_runs x SET status = 'committed', committed_at = now(), committed_by = auth.uid() WHERE x.id = v.id;
  END IF;
  RETURN jsonb_build_object('done', v_done, 'committed', v_ok, 'failed', v_bad, 'run', app.li_run_json(app.li_touch(v.id)));
END $$;

-- legacy_import_void(p_run, p_reason, {dry_run?}) — void-only undo of a run. A run that wrote nothing (draft / staged / validated)
-- is simply closed. A committed run is voided only when nothing it created was changed or used afterwards (else
-- MRS_LI_VOID_BLOCKED with the list in the detail = JSON {total, items}); then, newest first: custody entries void, payments void
-- (step-6 void core: their G4 rows too), appointments / trips cancelled, container return data restored, containers added to an
-- older transaction KEPT (never deleted; counted in kept_containers), transactions cancelled (declarations cancelled, open invoice
-- candidates superseded), drivers / trucks / parties deactivated, aliases removed, clients deactivated (their Daftra code / VAT / CR
-- released so a corrected run can reuse them). A committing run must be finished first. dry_run → {blockers} without changing
-- anything. Review fix: in chunks ({limit ≤ 500, default 200} rows, newest first) — the first call checks the blockers and turns the
-- run 'voiding' (still an open run); call again while done = false. → {done, rows, voided {table: n}, kept_containers, run}
CREATE OR REPLACE FUNCTION public.legacy_import_void(p_run uuid, p_reason text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p jsonb := coalesce(p_payload, '{}'::jsonb); v public.legacy_import_runs; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  b jsonb; e record; o record; d public.client_disbursements; v_at timestamptz := now(); v_n jsonb := '{}'::jsonb; v_txr text;
  v_lim int; v_ent text; v_rows int := 0; v_kept int := 0; v_done boolean; v_dry boolean;
BEGIN
  v := app.li_run(p_run, true);
  PERFORM app.only_keys(p, ARRAY['dry_run','limit']);
  IF v_reason IS NULL OR char_length(v_reason) < 3 THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  IF v.status IN ('voided','committing') THEN PERFORM app.fail('MRS_LI_STATE', v.status); END IF;
  v_dry := coalesce(app.pbool(p, 'dry_run'), false);
  IF v.status IN ('draft','staged','validated') THEN
    IF v_dry THEN RETURN jsonb_build_object('blockers', jsonb_build_object('total', 0, 'items', '[]'::jsonb), 'run', app.li_run_json(v)); END IF;
    UPDATE public.legacy_import_runs x SET status = 'voided', voided_at = v_at, voided_by = auth.uid(), void_reason = v_reason WHERE x.id = v.id;
    RETURN jsonb_build_object('done', true, 'rows', 0, 'voided', '{}'::jsonb, 'kept_containers', 0, 'run', app.li_run_json(app.li_touch(v.id)));
  END IF;
  v_lim := least(greatest(coalesce(app.pnum(p, 'limit', 100000)::int, 200), 1), 500);
  IF v.status = 'committed' THEN
    b := app.li_void_blockers(v);
    IF v_dry THEN RETURN jsonb_build_object('blockers', b, 'run', app.li_run_json(v)); END IF;
    IF (b ->> 'total')::int > 0 THEN PERFORM app.fail('MRS_LI_VOID_BLOCKED', b::text); END IF;
    -- decided: the run is now voiding (resumable in chunks, review fix for large runs; nothing else may start meanwhile)
    UPDATE public.legacy_import_runs x SET status = 'voiding', void_reason = v_reason WHERE x.id = v.id RETURNING * INTO v;
  ELSIF v_dry THEN
    RETURN jsonb_build_object('blockers', jsonb_build_object('total', 0, 'items', '[]'::jsonb), 'run', app.li_run_json(v));
  END IF;
  PERFORM set_config('marsa.li_run', v.id::text, true);
  v_txr := 'إلغاء دفعة الاستيراد ' || v.ref || ': ' || v.void_reason;
  -- newest first: the last entity in dependency order, its last rows, each row's created rows in reverse
  v_ent := app.li_next_entity(v.id, ARRAY['committed'], true);
  IF v_ent IS NOT NULL THEN
    FOR o IN SELECT x.id, x.created_rows FROM public.legacy_import_rows x
              WHERE x.run_id = v.id AND x.entity = v_ent AND x.status = 'committed' AND x.voided_at IS NULL
              ORDER BY x.sheet DESC, x.row_no DESC, x.id DESC LIMIT v_lim LOOP
      FOR e IN SELECT y.value ->> 't' t, (y.value ->> 'id')::uuid id, y.value ->> 'a' a, y.value -> 'prev' prev
                 FROM jsonb_array_elements(o.created_rows) WITH ORDINALITY y(value, ord) ORDER BY y.ord DESC LOOP
        v_n := jsonb_set(v_n, ARRAY[e.t], to_jsonb(coalesce((v_n ->> e.t)::int, 0) + 1));
        CASE e.t
        WHEN 'client_custody_entries' THEN
          PERFORM app.custody_lock((SELECT ce.client_id FROM public.client_custody_entries ce WHERE ce.id = e.id));
          UPDATE public.client_custody_entries ce SET status = 'void', void_reason = left(v_txr, 500), voided_by = auth.uid(), voided_at = v_at
           WHERE ce.id = e.id AND ce.status = 'active';
        WHEN 'client_disbursements' THEN
          SELECT * INTO d FROM public.client_disbursements x WHERE x.id = e.id FOR UPDATE;
          IF d.status = 'recorded' THEN PERFORM app.pay_void_core(d, left(v_txr, 2000), 'void'); END IF;
        WHEN 'transport_trips' THEN
          UPDATE public.transport_trips r SET status = 'cancelled', status_reason = left(v_txr, 500) WHERE r.id = e.id AND r.status <> 'cancelled';
        WHEN 'port_appointments' THEN
          UPDATE public.port_appointments a SET status = 'cancelled', status_reason = left(v_txr, 500) WHERE a.id = e.id AND a.status NOT IN ('cancelled','rescheduled');
        WHEN 'containers' THEN
          IF e.a = 'update' THEN
            UPDATE public.containers c SET return_location = e.prev ->> 'return_location', return_deadline = (e.prev ->> 'return_deadline')::date,
                   returned_at = (e.prev ->> 'returned_at')::timestamptz
             WHERE c.id = e.id;
          ELSIF NOT EXISTS (SELECT 1 FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id
                             WHERE c.id = e.id AND t.import_run_id = v.id) THEN
            -- review fix (void-only): a container this run added to an older transaction is never deleted (Marsa never deletes a
            -- container; alerts / proofs / costs may point to it): it stays on that transaction and is counted as kept
            v_kept := v_kept + 1;
          END IF;
          -- the containers of the run's own transactions go with their cancelled transaction
        WHEN 'customs_declarations' THEN
          UPDATE public.customs_declarations dd SET status = 'cancelled', cancelled_at = v_at, cancel_reason = left(v_txr, 500)
           WHERE dd.id = e.id AND dd.status NOT IN ('cancelled','replaced');
        WHEN 'transactions' THEN
          UPDATE public.customs_declarations dd SET status = 'cancelled', cancelled_at = v_at, cancel_reason = left(v_txr, 500)
           WHERE dd.transaction_id = e.id AND dd.status NOT IN ('cancelled','replaced');
          UPDATE public.daftra_invoice_candidates c SET state = 'superseded', note = left('legacy import voided', 2000)
           WHERE c.transaction_id = e.id AND c.state IN ('open','review','blocked','partial');
          UPDATE public.port_appointments a SET status = 'cancelled', status_reason = left(v_txr, 500)
           WHERE a.transaction_id = e.id AND a.status IN ('requested','confirmed');
          UPDATE public.transport_trips r SET status = 'cancelled', status_reason = left(v_txr, 500)
           WHERE r.transaction_id = e.id AND r.status IN ('planned','dispatched','loaded');
          UPDATE public.transactions t SET operational_status = 'closed', status_changed_at = v_at, cancelled_at = v_at, cancelled_by = auth.uid(),
                 cancel_reason = left(v_txr, 500)
           WHERE t.id = e.id AND t.cancelled_at IS NULL;
          INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, visible_to_client, actor, payload)
          VALUES (v.org_id, e.id, 'note', left(v_txr, 2000), false, auth.uid(), jsonb_build_object('op', 'legacy_import_void', 'run', v.ref));
        WHEN 'drivers' THEN UPDATE public.drivers x SET is_active = false WHERE x.id = e.id;
        WHEN 'trucks' THEN UPDATE public.trucks x SET is_active = false WHERE x.id = e.id;
        WHEN 'parties' THEN UPDATE public.parties x SET is_active = false WHERE x.id = e.id;
        -- an alias is removed (the normal staff path deletes aliases too); a kept one would block the corrected re-import (unique name)
        WHEN 'client_aliases' THEN DELETE FROM public.client_aliases x WHERE x.id = e.id;
        WHEN 'clients' THEN
          UPDATE public.clients c SET is_active = false, daftra_client_code = NULL, vat_number = NULL, cr_number = NULL,
                 notes = left(concat_ws(' | ', c.notes, v_txr), 2000)
           WHERE c.id = e.id;
        ELSE NULL;
        END CASE;
      END LOOP;
      UPDATE public.legacy_import_rows x SET voided_at = v_at WHERE x.id = o.id;
      v_rows := v_rows + 1;
    END LOOP;
  END IF;
  v_done := app.li_next_entity(v.id, ARRAY['committed'], true) IS NULL;
  IF v_done THEN
    UPDATE public.legacy_import_runs x SET status = 'voided', voided_at = v_at, voided_by = auth.uid() WHERE x.id = v.id;
  END IF;
  RETURN jsonb_build_object('done', v_done, 'rows', v_rows, 'voided', v_n, 'kept_containers', v_kept, 'run', app.li_run_json(app.li_touch(v.id)));
END $$;

-- legacy_import_get_run(p_run) → the run + its counts + the 20 most frequent message codes per entity / level
CREATE OR REPLACE FUNCTION public.legacy_import_get_run(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.legacy_import_runs;
BEGIN
  v := app.li_run(p_run, false);
  RETURN app.li_run_json(v) || jsonb_build_object('counts', app.li_counts(v.id), 'messages', coalesce((SELECT jsonb_agg(z ORDER BY z.n DESC) FROM (
      SELECT o.entity, e ->> 'level' level, e ->> 'code' code, count(*)::int n FROM public.legacy_import_rows o, jsonb_array_elements(o.messages) e
       WHERE o.run_id = v.id GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 60) z), '[]'::jsonb));
END $$;

-- legacy_import_list_runs(p_org, {limit ≤ 100, offset}) → {items [run], total}
CREATE OR REPLACE FUNCTION public.legacy_import_list_runs(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_lim int; v_off int;
BEGIN
  PERFORM app.li_gate(p_org);
  PERFORM app.only_keys(f, ARRAY['limit','offset']);
  v_lim := least(greatest(coalesce(app.pnum(f, 'limit', 100000)::int, 50), 1), 100);
  v_off := greatest(coalesce(app.pnum(f, 'offset', 1e9)::int, 0), 0);
  RETURN jsonb_build_object('total', (SELECT count(*)::int FROM public.legacy_import_runs r WHERE r.org_id = p_org),
    'items', coalesce((SELECT jsonb_agg(app.li_run_json(r) ORDER BY r.created_at DESC) FROM (
        SELECT * FROM public.legacy_import_runs x WHERE x.org_id = p_org ORDER BY x.created_at DESC LIMIT v_lim OFFSET v_off) r), '[]'::jsonb));
END $$;

-- legacy_import_list_rows(p_run, {entity?, status? (one or array), q? (row values), offset, limit ≤ 500}) — the preview / the error
-- report: {total, items [{id, entity, sheet, row_no, status, messages, data (as staged), normalized, target_table, target_id,
-- target_label}]}
CREATE OR REPLACE FUNCTION public.legacy_import_list_rows(p_run uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v public.legacy_import_runs; v_lim int; v_off int; v_ent text; v_st text[]; v_q text;
BEGIN
  v := app.li_run(p_run, false);
  PERFORM app.only_keys(f, ARRAY['entity','status','q','limit','offset']);
  v_ent := app.ptext(f, 'entity', 20);
  IF v_ent IS NOT NULL AND NOT (v_ent = ANY (ARRAY['customers','aliases','drivers','transactions','containers','movements','payments','custody'])) THEN
    PERFORM app.fail('MRS_INVALID', 'entity');
  END IF;
  IF jsonb_typeof(f -> 'status') = 'array' THEN v_st := ARRAY(SELECT jsonb_array_elements_text(f -> 'status'));
  ELSIF jsonb_typeof(f -> 'status') = 'string' THEN v_st := ARRAY[f ->> 'status'];
  END IF;
  IF v_st IS NOT NULL AND NOT (v_st <@ ARRAY['pending','valid','warning','error','duplicate','committed','skipped']) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_q := app.ptext(f, 'q', 80);
  v_lim := least(greatest(coalesce(app.pnum(f, 'limit', 100000)::int, 100), 1), 500);
  v_off := greatest(coalesce(app.pnum(f, 'offset', 1e9)::int, 0), 0);
  RETURN (WITH s AS (
      SELECT o.* FROM public.legacy_import_rows o
       WHERE o.run_id = v.id AND (v_ent IS NULL OR o.entity = v_ent) AND (v_st IS NULL OR o.status = ANY (v_st))
         AND (v_q IS NULL OR o.raw::text ILIKE '%' || replace(replace(v_q, '%', ''), '_', '') || '%'))
    SELECT jsonb_build_object('total', (SELECT count(*)::int FROM s),
      'items', coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'entity', x.entity, 'sheet', x.sheet, 'row_no', x.row_no, 'status', x.status,
                'messages', x.messages, 'data', x.raw, 'normalized', x.normalized - 'keys', 'target_table', x.target_table, 'target_id', x.target_id,
                'target_label', app.li_target_label(x.target_table, x.target_id))
              ORDER BY app.li_rank(x.entity), x.sheet, x.row_no, x.id)
           FROM (SELECT * FROM s ORDER BY app.li_rank(s.entity), s.sheet, s.row_no, s.id LIMIT v_lim OFFSET v_off) x), '[]'::jsonb)));
END $$;

-- legacy_import_skip_rows(p_run, {row_ids [≤ 500], skip: true|false}) — the owner leaves rows out (or takes them back) before the commit;
-- the run goes back to staged (validate again)
CREATE OR REPLACE FUNCTION public.legacy_import_skip_rows(p_run uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v public.legacy_import_runs; v_ids uuid[]; v_n int;
BEGIN
  v := app.li_run(p_run, true);
  IF v.status NOT IN ('staged','validated') THEN PERFORM app.fail('MRS_LI_STATE', v.status); END IF;
  PERFORM app.only_keys(p, ARRAY['row_ids','skip']);
  IF jsonb_typeof(p -> 'row_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'row_ids') = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'row_ids'); END IF;
  IF jsonb_array_length(p -> 'row_ids') > 500 THEN PERFORM app.fail('MRS_LI_LIMIT', 'rows_per_call'); END IF;
  IF jsonb_typeof(p -> 'skip') IS DISTINCT FROM 'boolean' THEN PERFORM app.fail('MRS_REQUIRED', 'skip'); END IF;
  BEGIN
    v_ids := ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p -> 'row_ids') x);
  EXCEPTION WHEN others THEN PERFORM app.fail('MRS_INVALID', 'row_ids');
  END;
  UPDATE public.legacy_import_rows o SET skipped_by_owner = (p ->> 'skip')::boolean WHERE o.run_id = v.id AND o.id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM app.li_reset(v.id);
  RETURN jsonb_build_object('updated', v_n, 'run', app.li_run_json(app.li_touch(v.id)));
END $$;

-- the imported transactions a Daftra po_number names: <the run's prefix (RHK- by default)><legacy «رقم المعاملة»>, committed runs
-- of the org only, live transactions only (legacy buildDaftraInvoiceReference_). Exact legacy id after a case-insensitive prefix.
CREATE OR REPLACE FUNCTION app.li_ref_txs(p_org uuid, p_po text) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_po text := btrim(coalesce(p_po, '')); v_pre text; v_out uuid[] := '{}';
BEGIN
  IF v_po = '' OR p_org IS NULL THEN RETURN v_out; END IF;
  FOR v_pre IN SELECT DISTINCT upper(coalesce(nullif(ru.options ->> 'daftra_invoice_prefix', ''), 'RHK-')) FROM public.legacy_import_runs ru
                WHERE ru.org_id = p_org AND ru.status = 'committed' LOOP
    CONTINUE WHEN char_length(v_po) <= char_length(v_pre) OR upper(left(v_po, char_length(v_pre))) <> v_pre;
    v_out := v_out || ARRAY(
      SELECT o.target_id FROM public.legacy_import_rows o JOIN public.legacy_import_runs ru ON ru.id = o.run_id
        JOIN public.transactions t ON t.id = o.target_id
       WHERE o.org_id = p_org AND o.entity = 'transactions' AND o.status = 'committed' AND ru.status = 'committed'
         AND o.normalized ->> 'legacy_id' = substr(v_po, char_length(v_pre) + 1)
         AND upper(coalesce(nullif(ru.options ->> 'daftra_invoice_prefix', ''), 'RHK-')) = v_pre AND t.cancelled_at IS NULL);
  END LOOP;
  RETURN ARRAY(SELECT DISTINCT u FROM unnest(v_out) u WHERE u IS NOT NULL);
END $$;

-- legacy_import_queue_daftra(p_run, p_idem_key) — after the commit: queues the existing step-7 READ-ONLY jobs for the legacy
-- invoices (RHK- by default, options.daftra_invoice_prefix): one invoice_lookup (mode number) per imported transaction that carries
-- a legacy Daftra invoice number, and the org's legacy_scan (resumed / deduplicated as step 7 does). Nothing is linked: the worker
-- proposes candidates, a human confirms each through confirm_invoice_link. Needs a connected Daftra (MRS_BAD_TRANSITION not_connected).
-- → {lookups_queued, lookups_deduplicated, scan, run}
CREATE OR REPLACE FUNCTION public.legacy_import_queue_daftra(p_run uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.legacy_import_runs; v_replay jsonb; r record; v_job jsonb; v_q int := 0; v_dd int := 0; v_scan jsonb; v_pre text; v_no text;
BEGIN
  v := app.li_run(p_run, true);
  IF v.status <> 'committed' THEN PERFORM app.fail('MRS_LI_STATE', v.status); END IF;
  v_replay := app.idem_begin('legacy_import_queue_daftra', p_idem_key, jsonb_build_object('run', v.id), v.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM app.daftra_need_connection(v.org_id);
  v_pre := upper(coalesce(nullif(v.options ->> 'daftra_invoice_prefix', ''), 'RHK-'));
  -- review fix: «رقم مسودة فاتورة دفترة» is Daftra's own invoice number (legacy invoice.no), not the RHK- reference: every
  -- imported transaction carrying one gets a read-only lookup by number. The RHK-<«رقم المعاملة»> reference (legacy po_number) is
  -- matched by the legacy scan (app.daftra_apply_scan, re-created below).
  FOR r IN SELECT o.target_id tx, o.normalized -> 'daftra' dft FROM public.legacy_import_rows o
            WHERE o.run_id = v.id AND o.entity = 'transactions' AND o.status = 'committed' AND o.normalized ? 'daftra'
            ORDER BY o.sheet, o.row_no LOOP
    v_no := btrim(coalesce(r.dft ->> 'number', ''));
    CONTINUE WHEN regexp_replace(v_no, '[^A-Za-z0-9]', '', 'g') = '';
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = r.tx AND t.cancelled_at IS NULL);
    v_job := app.daftra_enqueue(v.org_id, 'invoice_lookup', r.tx, NULL, NULL, 'number',
                                jsonb_build_object('mode', 'number', 'number', left(v_no, 60)), auth.uid());
    IF (v_job ->> 'deduplicated')::boolean THEN v_dd := v_dd + 1; ELSE v_q := v_q + 1; END IF;
  END LOOP;
  v_scan := public.request_daftra_legacy_scan(v.org_id, '{}'::jsonb, NULL);
  UPDATE public.legacy_import_runs x SET daftra = jsonb_build_object('queued_at', now(), 'queued_by', auth.uid(), 'lookups', v_q + v_dd,
         'scan_run_id', v_scan ->> 'id', 'prefix', v_pre) WHERE x.id = v.id;
  RETURN app.idem_finish('legacy_import_queue_daftra', p_idem_key, jsonb_build_object('lookups_queued', v_q, 'lookups_deduplicated', v_dd,
    'scan', v_scan, 'run', app.li_run_json(app.li_touch(v.id))));
END $$;

-- legacy_import_daftra_candidates(p_run, {state?}) — the invoice candidates (step 7) found for the run's transactions, for the
-- visual confirmation (confirm_invoice_link / reject_invoice_candidate of step 7): {items [{candidate (step-7 JSON), transaction
-- {id, ref, legacy_ref, legacy_invoice_no}}], total}
CREATE OR REPLACE FUNCTION public.legacy_import_daftra_candidates(p_run uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v public.legacy_import_runs; v_st text[]; v_pre text;
BEGIN
  v := app.li_run(p_run, false);
  PERFORM app.only_keys(f, ARRAY['state']);
  v_st := CASE WHEN jsonb_typeof(f -> 'state') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(f -> 'state'))
               WHEN jsonb_typeof(f -> 'state') = 'string' THEN ARRAY[f ->> 'state'] ELSE ARRAY['open','review','blocked','partial'] END;
  v_pre := upper(coalesce(nullif(v.options ->> 'daftra_invoice_prefix', ''), 'RHK-'));
  RETURN (WITH s AS (
      SELECT c.*, t.ref t_ref, t.legacy_ref t_legacy, o.normalized #>> '{daftra,number}' legacy_no, o.normalized #>> '{daftra,id}' legacy_iid,
             CASE WHEN o.normalized ? 'legacy_id' THEN v_pre || (o.normalized ->> 'legacy_id') END legacy_reference
        FROM public.legacy_import_rows o JOIN public.transactions t ON t.id = o.target_id
        JOIN public.daftra_invoice_candidates c ON c.transaction_id = t.id
       WHERE o.run_id = v.id AND o.entity = 'transactions' AND o.status = 'committed' AND c.state = ANY (v_st))
    SELECT jsonb_build_object('total', (SELECT count(*)::int FROM s),
      'items', coalesce((SELECT jsonb_agg(jsonb_build_object('candidate', (SELECT app.daftra_candidate_json(cc) FROM public.daftra_invoice_candidates cc WHERE cc.id = x.id),
                  'transaction', jsonb_build_object('id', x.transaction_id, 'ref', x.t_ref, 'legacy_ref', x.t_legacy, 'legacy_invoice_no', x.legacy_no,
                                                    'legacy_invoice_id', x.legacy_iid, 'legacy_reference', x.legacy_reference))
                ORDER BY x.t_ref, x.created_at) FROM (SELECT * FROM s LIMIT 500) x), '[]'::jsonb)));
END $$;

-- ---------------------------------------------------------------------
-- re-created readers (20261124000100 bodies; the step-9 changes are marked "-- LI") + the conversion list
-- ---------------------------------------------------------------------
-- an imported transaction that is historical (billed / closed) never raises attention or an alert
CREATE OR REPLACE FUNCTION app.li_quiet_tx(p_run uuid, p_status text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_run IS NOT NULL AND p_status IN ('billed','closed')
$$;

-- attention reasons (20261124000100, re-created): + LI
CREATE OR REPLACE FUNCTION app.att_reasons(p_org uuid, p_tx uuid[], p_now timestamptz)
RETURNS TABLE (transaction_id uuid, branch_id uuid, ref text, reason text, level text, hours numeric, since timestamptz,
               subject_id uuid, container_id uuid, container_no text, effective_status text, warning_hours int, critical_hours int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH rules AS (SELECT app.status_aging_rules(p_org) ru),
  tx AS (
    SELECT t.id, t.branch_id, t.ref, coalesce(t.updated_at, t.created_at) last_at,
           CASE WHEN app.rpt_billed(t.id) THEN 'billed' ELSE t.operational_status END eff
      FROM public.transactions t
     WHERE t.org_id = p_org AND t.cancelled_at IS NULL AND (p_tx IS NULL OR t.id = ANY (p_tx))
       AND NOT app.li_quiet_tx(t.import_run_id, t.operational_status)),  -- LI: imported billed / closed rows stay quiet
  st AS (
    SELECT tx.*, (rules.ru -> tx.eff ->> 'warning_hours')::int w, (rules.ru -> tx.eff ->> 'critical_hours')::int c,
           (extract(epoch FROM (p_now - tx.last_at)) / 3600.0)::numeric h
      FROM tx CROSS JOIN rules
     WHERE jsonb_typeof(rules.ru -> tx.eff) = 'object'),
  ap AS (
    SELECT tx.id, tx.branch_id, tx.ref, tx.eff, a.id aid, a.container_id, a.appointment_at,
           (rules.ru -> 'appointment_not_updated' ->> 'warning_hours')::int w, (rules.ru -> 'appointment_not_updated' ->> 'critical_hours')::int c,
           (extract(epoch FROM (p_now - a.appointment_at)) / 3600.0)::numeric h
      FROM tx CROSS JOIN rules
      JOIN public.port_appointments a ON a.transaction_id = tx.id AND a.status NOT IN ('rescheduled','cancelled')
      LEFT JOIN public.transport_trips r ON r.id = (SELECT x.id FROM public.transport_trips x WHERE x.appointment_id = a.id
                                                      ORDER BY (x.status = 'cancelled'), x.created_at DESC, x.id LIMIT 1)
     WHERE jsonb_typeof(rules.ru -> 'appointment_not_updated') = 'object'
       AND tx.eff NOT IN ('under_billing','billed','closed')
       AND a.appointment_at IS NOT NULL AND a.appointment_at < p_now
       AND app.movement_status(a, r) IN ('registered','incomplete'))
  SELECT st.id, st.branch_id, st.ref, 'status_stale'::text, CASE WHEN st.h >= st.c THEN 'critical' ELSE 'warning' END,
         round(st.h, 1), st.last_at, NULL::uuid, NULL::uuid, NULL::text, st.eff, st.w, st.c
    FROM st WHERE st.h >= st.w
  UNION ALL
  SELECT ap.id, ap.branch_id, ap.ref, 'appointment_not_updated', CASE WHEN ap.h >= ap.c THEN 'critical' ELSE 'warning' END,
         round(ap.h, 1), ap.appointment_at, ap.aid, ap.container_id, k.container_no, ap.eff, ap.w, ap.c
    FROM ap LEFT JOIN public.containers k ON k.id = ap.container_id
   WHERE ap.h >= ap.w
  UNION ALL
  SELECT tx.id, tx.branch_id, tx.ref, 'empty_return_overdue', 'critical',
         round((extract(epoch FROM (p_now - app.rpt_ts(c.return_deadline + 1))) / 3600.0)::numeric, 1),
         app.rpt_ts(c.return_deadline + 1), c.id, c.id, c.container_no, tx.eff, NULL::int, NULL::int
    FROM tx JOIN public.containers c ON c.transaction_id = tx.id
   WHERE c.return_status = ANY (app.rpt_open_returns()) AND c.return_deadline IS NOT NULL AND c.returned_at IS NULL
     AND c.return_deadline < (p_now AT TIME ZONE 'Asia/Riyadh')::date
$$;

-- alert causes (20261124000100, re-created): + LI
CREATE OR REPLACE FUNCTION app.alert_causes(p_org uuid, p_now timestamptz)
RETURNS TABLE (dedupe_key text, kind text, severity text, branch_id uuid, transaction_id uuid, container_id uuid,
               subject_id uuid, title_ar text, title_en text, due_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT z.* FROM (
  WITH today AS (SELECT (p_now AT TIME ZONE 'Asia/Riyadh')::date AS d),
  active_tx AS (
    SELECT t.* FROM public.transactions t
     WHERE t.org_id = p_org AND t.cancelled_at IS NULL
       AND app.code_sort('operational_status', t.operational_status) < app.code_sort('operational_status', 'operationally_complete')),
  -- mandatory documents missing for the NEXT stage of an open transaction
  docs AS (
    SELECT t.id AS tx, t.branch_id, t.ref, nx.code AS next_stage, nx.label_ar AS stage_ar, nx.label_en AS stage_en,
           string_agg(x.label_ar, '، ' ORDER BY x.document_kind) AS kinds_ar,
           string_agg(x.label_en, ', ' ORDER BY x.document_kind) AS kinds_en
      FROM active_tx t
      JOIN LATERAL (SELECT l.code, l.label_ar, l.label_en FROM public.status_labels l
                     WHERE l.domain = 'operational_status' AND l.sort > app.code_sort('operational_status', t.operational_status)
                     ORDER BY l.sort LIMIT 1) nx ON true
      JOIN LATERAL app.tx_requirements(t.id) x ON x.required_for_stage = nx.code AND NOT x.is_optional
                                               AND x.status IN ('missing','unreviewed')
     GROUP BY t.id, t.branch_id, t.ref, nx.code, nx.label_ar, nx.label_en),
  att AS (SELECT x.* FROM app.att_reasons(p_org, NULL, p_now) x WHERE x.reason IN ('status_stale','appointment_not_updated'))  -- RPT
  SELECT 'docs_missing:' || d.tx || ':' || d.next_stage, 'docs_missing', 'warning', d.branch_id, d.tx, NULL::uuid, NULL::uuid,
         'مستندات ناقصة قبل مرحلة «' || d.stage_ar || '» — ' || d.ref || ': ' || d.kinds_ar,
         'Documents missing before "' || d.stage_en || '" — ' || d.ref || ': ' || d.kinds_en, NULL::timestamptz
    FROM docs d
  UNION ALL
  SELECT 'appointment_soon:' || a.id, 'appointment_soon', CASE WHEN a.status = 'requested' THEN 'warning' ELSE 'info' END,
         t.branch_id, t.id, a.container_id, a.id,
         CASE WHEN a.status = 'requested' THEN 'موعد خلال 24 ساعة ولم يُؤكَّد — ' ELSE 'موعد خلال 24 ساعة — ' END || t.ref,
         CASE WHEN a.status = 'requested' THEN 'Unconfirmed appointment within 24 h — ' ELSE 'Appointment within 24 h — ' END || t.ref,
         a.appointment_at
    FROM public.port_appointments a JOIN public.transactions t ON t.id = a.transaction_id
   WHERE a.org_id = p_org AND a.status IN ('requested','confirmed') AND t.cancelled_at IS NULL
     AND a.appointment_at > p_now AND a.appointment_at <= p_now + interval '24 hours'
  UNION ALL
  -- window over without an outcome, or marked missed and not rescheduled / cancelled yet
  SELECT 'appointment_missed:' || a.id, 'appointment_missed', 'critical', t.branch_id, t.id, a.container_id, a.id,
         'موعد فائت يحتاج إعادة جدولة — ' || t.ref, 'Missed appointment needs a new slot — ' || t.ref, a.appointment_at
    FROM public.port_appointments a JOIN public.transactions t ON t.id = a.transaction_id
   WHERE a.org_id = p_org AND t.cancelled_at IS NULL
     AND (a.status = 'missed'
          OR (a.status IN ('requested','confirmed')
              AND a.appointment_at + make_interval(mins => coalesce(a.window_minutes, 0)) < p_now))
  UNION ALL
  SELECT CASE WHEN c.return_deadline < today.d THEN 'empty_return_overdue:' ELSE 'empty_return_due:' END || c.id,
         CASE WHEN c.return_deadline < today.d THEN 'empty_return_overdue' ELSE 'empty_return_due' END,
         CASE WHEN c.return_deadline < today.d THEN 'critical' ELSE 'warning' END,
         t.branch_id, t.id, c.id, c.id,
         CASE WHEN c.return_deadline < today.d THEN 'تأخر إرجاع الحاوية الفارغة ' ELSE 'موعد إرجاع الحاوية الفارغة قريب ' END
           || c.container_no || ' — ' || t.ref,
         CASE WHEN c.return_deadline < today.d THEN 'Empty return overdue ' ELSE 'Empty return due ' END
           || c.container_no || ' — ' || t.ref,
         ((c.return_deadline + 1)::timestamp AT TIME ZONE 'Asia/Riyadh')
    FROM public.containers c JOIN public.transactions t ON t.id = c.transaction_id CROSS JOIN today
   WHERE c.org_id = p_org AND c.return_status IN ('pending','evidence_submitted','disputed') AND t.cancelled_at IS NULL
     AND c.return_deadline IS NOT NULL AND c.return_deadline <= today.d + 3
  UNION ALL
  SELECT 'exception_open:' || e.id, 'exception_open', CASE WHEN e.kind = 'customs_rejection' THEN 'critical' ELSE 'warning' END,
         t.branch_id, t.id, e.container_id, e.id,
         'استثناء مفتوح: ' || coalesce(l.label_ar, e.kind) || ' — ' || t.ref,
         'Open exception: ' || coalesce(l.label_en, e.kind) || ' — ' || t.ref, NULL::timestamptz
    FROM public.operational_exceptions e JOIN public.transactions t ON t.id = e.transaction_id
    LEFT JOIN public.status_labels l ON l.domain = 'exception_kind' AND l.code = e.kind
   WHERE e.org_id = p_org AND e.status IN ('open','in_progress') AND t.cancelled_at IS NULL
  UNION ALL
  -- an active declaration with no status change for 3 days on an open transaction
  SELECT 'declaration_stalled:' || d.id || ':' || d.status, 'declaration_stalled', 'warning', t.branch_id, t.id, NULL::uuid, d.id,
         'بيان جمركي ' || d.declaration_no || ' بلا تحديث منذ 3 أيام — ' || t.ref,
         'Declaration ' || d.declaration_no || ' not updated for 3 days — ' || t.ref, d.updated_at + interval '3 days'
    FROM public.customs_declarations d JOIN active_tx t ON t.id = d.transaction_id
   WHERE d.status IN ('draft','submitted','accepted','under_inspection','cco_review_done','awaiting_duty_payment',
                      'release_ready') AND d.updated_at < p_now - interval '3 days'
  UNION ALL
  -- RPT: no update for longer than the aging rule of the (effective) status
  SELECT 'status_stale:' || x.transaction_id || ':' || x.effective_status, 'status_stale', x.level, x.branch_id, x.transaction_id,
         NULL::uuid, x.transaction_id,
         'معاملة بلا تحديث في حالة «' || coalesce(l.label_ar, x.effective_status) || '» أكثر من '
           || CASE WHEN x.level = 'critical' THEN x.critical_hours ELSE x.warning_hours END || ' ساعة — ' || x.ref,
         'Transaction not updated in "' || coalesce(l.label_en, x.effective_status) || '" for more than '
           || CASE WHEN x.level = 'critical' THEN x.critical_hours ELSE x.warning_hours END || ' h — ' || x.ref,
         x.since + make_interval(hours => x.critical_hours)
    FROM att x LEFT JOIN public.status_labels l ON l.domain = 'operational_status' AND l.code = x.effective_status
   WHERE x.reason = 'status_stale'
  UNION ALL
  -- RPT: the gate-out appointment passed and the movement was not updated
  SELECT 'appointment_not_updated:' || x.subject_id, 'appointment_not_updated', x.level, x.branch_id, x.transaction_id,
         x.container_id, x.subject_id,
         'موعد الخروج مضى عليه أكثر من ' || CASE WHEN x.level = 'critical' THEN x.critical_hours ELSE x.warning_hours END
           || ' ساعة دون تحديث الحركة — ' || x.ref || coalesce(' — ' || x.container_no, ''),
         'Gate-out appointment passed more than ' || CASE WHEN x.level = 'critical' THEN x.critical_hours ELSE x.warning_hours END
           || ' h ago without a movement update — ' || x.ref || coalesce(' — ' || x.container_no, ''),
         x.since + make_interval(hours => x.critical_hours)
    FROM att x WHERE x.reason = 'appointment_not_updated'
  ) z (dedupe_key, kind, severity, branch_id, transaction_id, container_id, subject_id, title_ar, title_en, due_at)
  -- LI: no alert for an imported billed / closed transaction
   WHERE NOT EXISTS (SELECT 1 FROM public.transactions t WHERE t.id = z.transaction_id AND app.li_quiet_tx(t.import_run_id, t.operational_status))
$$;

-- the register / search matcher (20261124000100, re-created): + LI
CREATE OR REPLACE FUNCTION app.rpt_tx_match(p_org uuid, f jsonb) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_q text; v_qp text; v_qw text; v_qn text; v_qc text; v_decl text; v_bl text; v_cno text; v_cl uuid; v_clq text; v_clw text;
  v_car uuid; v_carq text; v_port text; v_df text; v_rng date[]; v_from date; v_to date; v_tf timestamptz; v_tt timestamptz;
  v_br uuid; v_st text[]; v_sc uuid[];
  -- RPT
  v_ccode text; v_ccat text[]; v_ports text[]; v_ds text[]; v_vessel text; v_op uuid; v_opq text; v_agq text; v_emp uuid;
  v_cr numeric[]; v_cmin int; v_cmax int; v_cu text[]; v_tty text[]; v_dst text[]; v_fsc uuid[]; v_att text; v_attids uuid[];
BEGIN
  v_q := app.ptext(f, 'q', 80);
  IF v_q IS NOT NULL AND char_length(v_q) < 2 THEN PERFORM app.fail('MRS_INVALID', 'search_query_short'); END IF;
  v_qp := app.rpt_like(v_q);
  v_qw := app.rpt_like(app.to_western(v_q));
  v_qn := app.rpt_like(app.rpt_norm_no(v_q));
  v_qc := app.rpt_like(app.rpt_norm_container(v_q));
  v_decl := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'declaration_no', 80)));
  v_bl := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'bl_number', 80)));
  v_cno := app.rpt_like(app.rpt_norm_container(app.ptext(f, 'container_no', 80)));
  v_cl := app.puuid(f, 'client_id');
  v_clq := app.rpt_like(app.ptext(f, 'client_q', 80));
  v_clw := app.rpt_like(app.to_western(app.ptext(f, 'client_q', 80)));
  v_car := app.puuid(f, 'carrier_id');
  v_carq := app.rpt_like(app.ptext(f, 'carrier_q', 80));
  v_port := app.rpt_like(app.ptext(f, 'port', 80));
  v_df := coalesce(app.ptext(f, 'date_field', 20), 'created');
  IF v_df NOT IN ('created','eta','declaration','status_changed','updated') THEN PERFORM app.fail('MRS_INVALID', 'date_field'); END IF;
  v_rng := app.rpt_range(f, 1096); v_from := v_rng[1]; v_to := v_rng[2];
  v_tf := app.rpt_ts(v_from); v_tt := app.rpt_ts(v_to + 1);
  v_br := app.rpt_branch(p_org, f);
  v_st := app.rpt_codes(f, 'operational_status', 'operational_status');
  v_sc := app.rpt_scope(p_org, app.staff_roles());
  -- RPT
  v_ccode := app.rpt_like(app.rpt_norm_no(app.ptext(f, 'client_code', 40)));
  v_ccat := app.rpt_codes(f, 'client_category', 'client_port_category');
  v_ports := app.rpt_ports(f, 'port_code');
  v_ds := app.rpt_codes(f, 'declaration_status', 'declaration_status');
  v_vessel := app.rpt_like(app.ptext(f, 'vessel', 80));
  v_op := app.puuid(f, 'terminal_party_id');
  v_opq := app.rpt_like(app.ptext(f, 'operator_q', 80));
  v_agq := app.rpt_like(app.ptext(f, 'agent_q', 80));
  v_emp := app.puuid(f, 'employee_id');
  v_cr := app.rpt_num_range(f, 'containers_min', 'containers_max', 'containers_range', 1000);
  v_cmin := v_cr[1]::int; v_cmax := v_cr[2]::int;
  v_cu := app.rpt_codes(f, 'cargo_unit_type', 'cargo_unit_type');
  v_tty := app.rpt_codes(f, 'transaction_type', 'transaction_type');
  v_dst := app.rpt_codes(f, 'daftra_state', 'tx_daftra_state');
  IF v_dst IS NOT NULL THEN v_fsc := app.rpt_scope(p_org, app.fin_read_roles()); END IF;
  v_att := app.ptext(f, 'attention', 10);
  IF v_att IS NOT NULL THEN
    IF v_att NOT IN ('any','warning','critical') THEN PERFORM app.fail('MRS_INVALID', 'attention'); END IF;
    v_attids := app.att_ids(p_org, v_att, now());
  END IF;
  RETURN QUERY
  SELECT t.id FROM public.transactions t JOIN public.clients cl ON cl.id = t.client_id
   WHERE t.org_id = p_org
     AND (v_sc IS NULL OR t.branch_id = ANY (v_sc))
     AND (v_br IS NULL OR t.branch_id = v_br)
     AND (v_st IS NULL OR t.operational_status = ANY (v_st))
     AND (v_cl IS NULL OR t.client_id = v_cl)
     AND (v_q IS NULL
          OR t.ref ILIKE v_qp OR t.ref ILIKE v_qn OR t.bl_number ILIKE v_qn OR t.declaration_no ILIKE v_qn
          OR t.legacy_ref ILIKE v_qp OR t.legacy_ref ILIKE v_qn  -- LI: the legacy sequence of an imported transaction
          OR cl.name_ar ILIKE v_qp OR cl.name_en ILIKE v_qp OR cl.name_ar ILIKE v_qw OR cl.name_en ILIKE v_qw
          OR cl.cr_number ILIKE v_qw OR cl.vat_number ILIKE v_qw
          OR EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.declaration_no ILIKE v_qn)
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.bl_number ILIKE v_qn)
          OR EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = t.id AND c.container_no ILIKE v_qc)
          -- RPT: the rest of the legacy 23 fields
          OR cl.daftra_client_code ILIKE v_qn OR t.chassis_no ILIKE v_qn OR t.vehicle_plate_no ILIKE v_qn
          OR t.transport_order_no ILIKE v_qn OR t.port_code ILIKE v_qn OR t.shipping_line ILIKE v_qp
          OR t.port_of_loading ILIKE v_qp OR t.port_of_discharge ILIKE v_qp
          OR t.notes ILIKE v_qp OR t.declaration_notes ILIKE v_qp
          OR EXISTS (SELECT 1 FROM public.customs_ports cp WHERE cp.code = t.port_code AND (cp.name_ar ILIKE v_qp OR cp.name_en ILIKE v_qp))
          OR EXISTS (SELECT 1 FROM public.transaction_shipment_data sd WHERE sd.transaction_id = t.id AND sd.vessel ILIKE v_qp)
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      LEFT JOIN public.parties ag ON ag.id = b.shipping_agent_id
                      WHERE tb.transaction_id = t.id AND (b.vessel ILIKE v_qp OR b.carrier_name ILIKE v_qp OR ag.name_ar ILIKE v_qp
                                                          OR ag.name_en ILIKE v_qp))
          OR EXISTS (SELECT 1 FROM public.parties pa WHERE pa.id IN (t.terminal_party_id, t.transport_party_id)
                      AND (pa.name_ar ILIKE v_qp OR pa.name_en ILIKE v_qp))
          OR EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = coalesce(t.responsible_user_id, t.created_by) AND pr.full_name ILIKE v_qp))
     AND (v_decl IS NULL OR t.declaration_no ILIKE v_decl
          OR EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.declaration_no ILIKE v_decl))
     AND (v_bl IS NULL OR t.bl_number ILIKE v_bl
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.bl_number ILIKE v_bl))
     AND (v_cno IS NULL OR EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = t.id AND c.container_no ILIKE v_cno)
          OR t.chassis_no ILIKE v_cno OR t.vehicle_plate_no ILIKE v_cno)                                            -- RPT (Ro-Ro)
     AND (v_clq IS NULL OR cl.name_ar ILIKE v_clq OR cl.name_en ILIKE v_clq OR cl.name_ar ILIKE v_clw OR cl.name_en ILIKE v_clw
          OR cl.cr_number ILIKE v_clw OR cl.vat_number ILIKE v_clw)
     AND (v_car IS NULL
          OR EXISTS (SELECT 1 FROM public.transport_trips tr WHERE tr.transaction_id = t.id AND tr.carrier_id = v_car)
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.shipping_agent_id = v_car))
     AND (v_carq IS NULL OR t.shipping_line ILIKE v_carq
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.carrier_name ILIKE v_carq)
          OR EXISTS (SELECT 1 FROM public.transport_trips tr JOIN public.parties pa ON pa.id = tr.carrier_id
                      WHERE tr.transaction_id = t.id AND (pa.name_ar ILIKE v_carq OR pa.name_en ILIKE v_carq)))
     AND (v_port IS NULL OR t.port_of_loading ILIKE v_port OR t.port_of_discharge ILIKE v_port
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND (b.port_of_loading ILIKE v_port OR b.port_of_discharge ILIKE v_port))
          OR EXISTS (SELECT 1 FROM public.customs_ports cp WHERE cp.code = t.port_code                              -- RPT
                      AND (cp.name_ar ILIKE v_port OR cp.name_en ILIKE v_port OR cp.code ILIKE v_port)))
     -- RPT: the legacy register filters
     AND (v_ccode IS NULL OR cl.daftra_client_code ILIKE v_ccode)
     AND (v_ccat IS NULL OR cl.port_category = ANY (v_ccat))
     AND (v_ports IS NULL OR t.port_code = ANY (v_ports))
     AND (v_ds IS NULL OR app.rpt_decl_status(t.id) = ANY (v_ds))
     AND (v_vessel IS NULL
          OR EXISTS (SELECT 1 FROM public.transaction_shipment_data sd WHERE sd.transaction_id = t.id AND sd.vessel ILIKE v_vessel)
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      WHERE tb.transaction_id = t.id AND b.vessel ILIKE v_vessel))
     AND (v_op IS NULL OR t.terminal_party_id = v_op
          OR EXISTS (SELECT 1 FROM public.port_appointments a WHERE a.transaction_id = t.id AND a.terminal_party_id = v_op))
     AND (v_opq IS NULL
          OR EXISTS (SELECT 1 FROM public.parties pa WHERE pa.id = t.terminal_party_id AND (pa.name_ar ILIKE v_opq OR pa.name_en ILIKE v_opq))
          OR EXISTS (SELECT 1 FROM public.port_appointments a WHERE a.transaction_id = t.id AND a.operator_name ILIKE v_opq))
     AND (v_agq IS NULL OR t.shipping_line ILIKE v_agq
          OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                      LEFT JOIN public.parties ag ON ag.id = b.shipping_agent_id
                      WHERE tb.transaction_id = t.id AND (b.carrier_name ILIKE v_agq OR ag.name_ar ILIKE v_agq OR ag.name_en ILIKE v_agq)))
     AND (v_emp IS NULL OR coalesce(t.responsible_user_id, t.created_by) = v_emp)
     AND (v_cmin IS NULL OR app.rpt_unit_count(t.id) >= v_cmin)
     AND (v_cmax IS NULL OR app.rpt_unit_count(t.id) <= v_cmax)
     AND (v_cu IS NULL OR t.cargo_unit_type = ANY (v_cu))
     AND (v_tty IS NULL OR t.transaction_type = ANY (v_tty))
     AND (v_dst IS NULL OR ((v_fsc IS NULL OR t.branch_id = ANY (v_fsc)) AND app.rpt_daftra_state(t.id) = ANY (v_dst)))
     AND (v_att IS NULL OR t.id = ANY (v_attids))
     -- one predicate per date field (each folds away in the custom plan unless it is the chosen one)
     AND (v_df <> 'created' OR ((v_tf IS NULL OR t.created_at >= v_tf) AND (v_tt IS NULL OR t.created_at < v_tt)))
     AND (v_df <> 'updated' OR ((v_tf IS NULL OR t.updated_at >= v_tf) AND (v_tt IS NULL OR t.updated_at < v_tt)))  -- RPT
     AND (v_df <> 'status_changed' OR ((v_tf IS NULL OR t.status_changed_at >= v_tf) AND (v_tt IS NULL OR t.status_changed_at < v_tt)))
     AND (v_df <> 'eta' OR ((v_from IS NULL OR t.eta >= v_from) AND (v_to IS NULL OR t.eta <= v_to)))
     AND (v_df <> 'declaration' OR (v_from IS NULL AND v_to IS NULL)
          OR app.rpt_in(t.declaration_date, v_from, v_to)
          OR EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = t.id AND d.status <> 'cancelled'
                       AND app.rpt_in(d.declaration_date, v_from, v_to)));
END $$;

-- audit labels (20261124000100, re-created): + LI
CREATE OR REPLACE FUNCTION app.audit_label_of(p_table text, p_action text, p_changed text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_table
    WHEN 'transactions' THEN CASE WHEN p_action = 'INSERT' THEN 'tx.create'
                                  WHEN 'cancelled_at' = ANY (p_changed) THEN 'tx.cancel'
                                  WHEN 'operational_status' = ANY (p_changed) THEN 'tx.status' ELSE 'tx.update' END
    WHEN 'containers' THEN CASE WHEN p_action = 'INSERT' THEN 'container.add' WHEN p_action = 'DELETE' THEN 'container.remove'
                                WHEN p_changed && ARRAY['return_status','returned_at','return_deadline','return_location'] THEN 'container.return'
                                ELSE 'container.update' END
    WHEN 'port_appointments' THEN CASE WHEN p_action = 'INSERT' THEN 'appointment.add'
                                       WHEN 'status' = ANY (p_changed) THEN 'appointment.status' ELSE 'appointment.update' END
    WHEN 'transport_trips' THEN CASE WHEN p_action = 'INSERT' THEN 'trip.add'
                                     WHEN 'status' = ANY (p_changed) THEN 'trip.status' ELSE 'trip.update' END
    WHEN 'customs_declarations' THEN CASE WHEN p_action = 'INSERT' THEN 'declaration.add'
                                          WHEN 'status' = ANY (p_changed) THEN 'declaration.status' ELSE 'declaration.update' END
    WHEN 'empty_return_proofs' THEN CASE WHEN p_action = 'INSERT' THEN 'proof.add' ELSE 'proof.update' END
    WHEN 'client_disbursements' THEN CASE WHEN p_action = 'INSERT' THEN 'payment.add'
                                          WHEN 'status' = ANY (p_changed) THEN 'payment.void'
                                          WHEN 'review_status' = ANY (p_changed) THEN 'payment.review' ELSE 'payment.update' END
    WHEN 'billing_intents' THEN CASE WHEN p_action = 'INSERT' THEN 'billing.add' ELSE 'billing.update' END
    WHEN 'clients' THEN CASE WHEN p_action = 'INSERT' THEN 'client.add' ELSE 'client.update' END
    WHEN 'organizations' THEN 'settings.update'
    WHEN 'legacy_import_runs' THEN 'legacy_import.run'      -- LI
    WHEN 'legacy_import_rows' THEN 'legacy_import.row'      -- LI
    ELSE CASE p_action WHEN 'INSERT' THEN 'row.insert' WHEN 'DELETE' THEN 'row.delete' ELSE 'row.update' END END
$$;

-- the conversion delete list (20261123000100, re-created): + the two import tables
CREATE OR REPLACE FUNCTION app.convert_delete_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    -- intake / clients / access
    'public.service_requests', 'public.clients', 'public.client_aliases', 'public.client_users', 'public.invitations',
    'public.idempotency_keys', 'public.import_batches', 'public.import_rows', 'public.contact_messages',
    -- operations
    'public.transactions', 'public.transaction_events', 'public.transaction_bls', 'public.bills_of_lading',
    'public.customs_declarations', 'public.containers', 'public.documents', 'public.document_extractions',
    'public.document_matches',
    'public.doc_batches', 'public.doc_batch_documents', 'public.transaction_shipment_data',
    'public.shipment_invoice_items', 'public.shipment_packing_items',
    'public.declaration_approvals', 'public.declaration_items', 'public.hs_reference',
    'public.parties', 'public.party_ports',
    'public.drivers', 'public.trucks', 'public.transport_trips', 'public.port_appointments',
    'public.appointment_drafts', 'public.appointment_draft_cards', 'public.empty_return_proofs',
    'public.demurrage_cases', 'public.operational_exceptions', 'public.operational_alerts',
    -- costs (G4)
    'public.cost_accruals', 'public.cost_adjustments', 'public.cost_allocations', 'public.client_charges',
    'public.charge_collections', 'public.supplier_invoices', 'public.supplier_invoice_lines', 'public.supplier_payments',
    'public.finance_documents',
    'public.client_disbursements', 'public.disbursement_allocations', 'public.payment_documents',                -- PAY
    'public.client_custody_entries',                                                                              -- PAY
    -- billing (G5)
    'public.billing_intents', 'public.billing_intent_lines', 'public.billing_review_items', 'public.billing_sync_jobs',
    'public.billing_sync_attempts', 'public.daftra_client_links', 'public.daftra_mock_accounts',
    'public.daftra_runs', 'public.daftra_client_import_rows', 'public.daftra_invoice_candidates',                -- L7
    'public.daftra_supplier_links', 'public.daftra_purchase_drafts',                                              -- L7
    -- inbox (G6b)
    'public.msg_threads', 'public.msg_messages', 'public.msg_message_events', 'public.msg_attachments',
    'public.msg_extractions', 'public.msg_summaries', 'public.msg_classifications', 'public.msg_ai_runs',
    'public.msg_replies', 'public.msg_reply_versions', 'public.msg_reply_approvals', 'public.msg_outbound',
    'public.msg_delivery_events', 'public.msg_jobs', 'public.msg_job_attempts', 'public.msg_thread_links',
    'public.msg_contacts', 'public.msg_contact_addresses', 'public.msg_contact_authorizations', 'public.msg_mock_mailboxes',
    -- legacy import (LI): staged rows, then the runs (transactions.import_run_id points to a run)
    'public.legacy_import_rows', 'public.legacy_import_runs'
  ]::text[]
$$;

-- the legacy invoice scan (20261123000100, re-created): + LI, the RHK- reference of an imported transaction
CREATE OR REPLACE FUNCTION app.daftra_apply_scan(j public.billing_sync_jobs, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x jsonb; r jsonb; v_r public.daftra_runs; v_txs uuid[]; t uuid; v_m jsonb; v_cc text; v_seen int := 0; v_found int := 0;
        v_next jsonb := p_eff -> 'next_cursor'; v_dn text; v_ref uuid[];  -- LI
BEGIN
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = j.run_id FOR UPDATE;
  IF app.puuid(p_eff, 'run_id') IS DISTINCT FROM j.run_id THEN PERFORM app.fail('MRS_INVALID', 'run_id'); END IF;
  IF jsonb_typeof(p_eff -> 'invoices') IS DISTINCT FROM 'array' OR jsonb_array_length(p_eff -> 'invoices') > 500 THEN PERFORM app.fail('MRS_INVALID', 'invoices'); END IF;
  IF v_next IS NOT NULL AND jsonb_typeof(v_next) NOT IN ('object','null') THEN PERFORM app.fail('MRS_INVALID', 'next_cursor'); END IF;
  FOR x IN SELECT y FROM jsonb_array_elements(p_eff -> 'invoices') y LOOP
    r := app.daftra_invoice_row(x);
    v_seen := v_seen + 1;
    CONTINUE WHEN r ->> 'external_invoice_id' IS NULL
               OR EXISTS (SELECT 1 FROM public.billing_intents i WHERE i.org_id = j.org_id AND i.external_invoice_id = r ->> 'external_invoice_id');
    -- LI: the legacy reference RHK-<legacy «رقم المعاملة»> (legacy po_number, DaftraIntegration.js buildDaftraInvoiceReference_) of a
    -- transaction imported by a committed legacy import run → a candidate for it (a human confirms; nothing is linked here)
    v_ref := app.li_ref_txs(j.org_id, r ->> 'po_number');
    FOREACH t IN ARRAY v_ref LOOP
      v_m := app.daftra_invoice_match(t, r -> 'fields') || jsonb_build_object('reference', true);
      v_cc := app.daftra_client_check(t, r ->> 'client_id');
      INSERT INTO public.daftra_invoice_candidates (org_id, transaction_id, run_id, job_id, source, external_invoice_id, daftra_number,
        daftra_status, remote_state, invoice_date, currency, total, remote_client_id, client_name, po_number, fields, match, client_check, state)
      VALUES (j.org_id, t, j.run_id, j.id, 'legacy_scan', r ->> 'external_invoice_id', r ->> 'daftra_number', r ->> 'daftra_status',
        r ->> 'remote_state', (r ->> 'date')::date, r ->> 'currency', (r ->> 'total')::numeric, r ->> 'client_id', r ->> 'client_name',
        r ->> 'po_number', r -> 'fields', v_m, v_cc,
        CASE WHEN v_cc = 'conflict' THEN 'blocked' WHEN cardinality(v_ref) > 1 THEN 'review' ELSE 'open' END)
      ON CONFLICT (org_id, coalesce(transaction_id, '00000000-0000-0000-0000-000000000000'::uuid), external_invoice_id)
        WHERE state IN ('open','review','blocked') DO NOTHING;
      v_found := v_found + 1;
    END LOOP;
    v_dn := upper(regexp_replace(coalesce(r #>> '{fields,declaration_no}', ''), '[^A-Za-z0-9]', '', 'g'));
    CONTINUE WHEN v_dn = '';
    v_txs := ARRAY(SELECT DISTINCT d.transaction_id FROM public.customs_declarations d JOIN public.transactions tt ON tt.id = d.transaction_id
                    WHERE d.org_id = j.org_id AND d.status NOT IN ('cancelled','replaced') AND tt.cancelled_at IS NULL
                      AND upper(regexp_replace(d.declaration_no, '[^A-Za-z0-9]', '', 'g')) = v_dn);
    v_txs := ARRAY(SELECT u FROM unnest(v_txs) u WHERE (app.daftra_invoice_match(u, r -> 'fields') ->> 'exact')::boolean);
    CONTINUE WHEN cardinality(v_txs) = 0;
    FOREACH t IN ARRAY v_txs LOOP
      v_m := app.daftra_invoice_match(t, r -> 'fields');
      v_cc := app.daftra_client_check(t, r ->> 'client_id');
      INSERT INTO public.daftra_invoice_candidates (org_id, transaction_id, run_id, job_id, source, external_invoice_id, daftra_number,
        daftra_status, remote_state, invoice_date, currency, total, remote_client_id, client_name, po_number, fields, match, client_check, state)
      VALUES (j.org_id, t, j.run_id, j.id, 'legacy_scan', r ->> 'external_invoice_id', r ->> 'daftra_number', r ->> 'daftra_status',
        r ->> 'remote_state', (r ->> 'date')::date, r ->> 'currency', (r ->> 'total')::numeric, r ->> 'client_id', r ->> 'client_name',
        r ->> 'po_number', r -> 'fields', v_m, v_cc,
        CASE WHEN v_cc = 'conflict' THEN 'blocked' WHEN cardinality(v_txs) > 1 THEN 'review' ELSE 'open' END)
      ON CONFLICT (org_id, coalesce(transaction_id, '00000000-0000-0000-0000-000000000000'::uuid), external_invoice_id)
        WHERE state IN ('open','review','blocked') DO NOTHING;
      v_found := v_found + 1;
    END LOOP;
  END LOOP;
  UPDATE public.daftra_runs r SET pages = r.pages + 1,
         counters = jsonb_build_object('invoices_seen', coalesce((r.counters ->> 'invoices_seen')::int, 0) + v_seen,
                                       'candidates', coalesce((r.counters ->> 'candidates')::int, 0) + v_found),
         cursor = CASE WHEN jsonb_typeof(v_next) = 'object' THEN v_next ELSE r.cursor END,
         status = CASE WHEN jsonb_typeof(v_next) = 'object' THEN 'running' ELSE 'done' END,
         finished_at = CASE WHEN jsonb_typeof(v_next) = 'object' THEN NULL ELSE now() END
   WHERE r.id = v_r.id RETURNING * INTO v_r;
  IF jsonb_typeof(v_next) = 'object' THEN
    PERFORM app.daftra_enqueue(j.org_id, 'legacy_scan', NULL, v_r.id, NULL, 'p' || v_r.pages::text, '{}'::jsonb, NULL);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5. RLS, policies, grants, function privileges — the owner of the org reads its runs / rows (the RPCs are the write path);
--    every other role, client-portal users, other orgs and anon: nothing
-- ---------------------------------------------------------------------
ALTER TABLE public.legacy_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_import_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legacy_import_runs, public.legacy_import_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.legacy_import_runs, public.legacy_import_rows TO authenticated;
REVOKE ALL ON SEQUENCE public.legacy_import_runs_seq FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS legacy_import_runs_select ON public.legacy_import_runs;
CREATE POLICY legacy_import_runs_select ON public.legacy_import_runs FOR SELECT TO authenticated USING (app.li_is_owner(org_id));
DROP POLICY IF EXISTS legacy_import_rows_select ON public.legacy_import_rows;
CREATE POLICY legacy_import_rows_select ON public.legacy_import_rows FOR SELECT TO authenticated USING (app.li_is_owner(org_id));

-- helpers: called by the RPCs / triggers only (li_is_owner is the policy check: authenticated)
REVOKE EXECUTE ON FUNCTION app.li_gate(uuid), app.li_run(uuid, boolean), app.li_m(text, text, text, text), app.li_s(jsonb, text),
  app.li_key(text), app.li_ts(text), app.li_date(text), app.li_money(text), app.li_containers(text), app.li_containers_rest(text),
  app.li_map(public.legacy_import_runs, text, text), app.li_port(public.legacy_import_runs, text), app.li_branch(public.legacy_import_runs, text),
  app.li_tx_status(text), app.li_mv_status(text), app.li_cargo(text), app.li_pick(text, text[]), app.li_pay_movement(text),
  app.li_pay_method(text), app.li_pay_funding(text), app.li_service_item(public.legacy_import_runs, text), app.li_client_code(text),
  app.li_ctx(uuid), app.li_party(jsonb, text, text[]), app.li_row_ok(text),
  app.li_find_client(public.legacy_import_runs, jsonb, text, text), app.li_find_tx(public.legacy_import_runs, text, text),
  app.li_resolve(text, text), app.li_fp(text, uuid), app.li_counts(uuid), app.li_rank(text), app.li_status_of(jsonb, boolean, boolean),
  app.li_dup_row(public.legacy_import_rows, text[]), app.li_t(jsonb, text, integer, jsonb),
  app.li_check_customers(public.legacy_import_rows, public.legacy_import_runs, jsonb),
  app.li_check_aliases(public.legacy_import_rows, public.legacy_import_runs, jsonb),
  app.li_driver_of(public.legacy_import_runs, jsonb, text, text), app.li_plate(text),
  app.li_check_drivers(public.legacy_import_rows, public.legacy_import_runs, jsonb),
  app.li_check_transactions(public.legacy_import_rows, public.legacy_import_runs, jsonb),
  app.li_check_containers(public.legacy_import_rows, public.legacy_import_runs, jsonb),
  app.li_check_movements(public.legacy_import_rows, public.legacy_import_runs, jsonb),
  app.li_check_payments(public.legacy_import_rows, public.legacy_import_runs, jsonb),
  app.li_check_custody(public.legacy_import_rows, public.legacy_import_runs, jsonb), app.li_custody_finalize(uuid),
  app.li_row_label(uuid), app.li_check(public.legacy_import_rows, public.legacy_import_runs, jsonb), app.li_dictionary(),
  app.li_c(text, uuid, text, jsonb), app.li_truck(uuid, text, jsonb),
  app.li_apply(public.legacy_import_rows, public.legacy_import_runs, jsonb), app.li_target_label(text, uuid),
  app.li_run_json(public.legacy_import_runs), app.li_touch(uuid), app.li_reset(uuid), app.li_void_blockers(public.legacy_import_runs),
  app.li_options_check(uuid, jsonb, jsonb), app.li_quiet_tx(uuid, text), app.li_entities(), app.li_next_entity(uuid, text[], boolean),
  app.li_fps(text, uuid[]), app.li_touch_ids(public.legacy_import_runs, jsonb), app.li_fp_pre(uuid, uuid[]), app.li_fp_post(jsonb),
  app.li_ref_txs(uuid, text), app.li_analyze()
FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.li_is_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.li_is_owner(uuid) TO authenticated, service_role;
-- the invoker guard of transactions runs as the caller
REVOKE EXECUTE ON FUNCTION app.tg_transactions_li_guard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.tg_transactions_li_guard() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.legacy_import_dictionary(), public.legacy_import_create_run(uuid, jsonb, uuid),
  public.legacy_import_set_options(uuid, jsonb), public.legacy_import_stage(uuid, jsonb), public.legacy_import_validate(uuid, jsonb),
  public.legacy_import_commit(uuid, jsonb), public.legacy_import_void(uuid, text, jsonb), public.legacy_import_get_run(uuid),
  public.legacy_import_list_runs(uuid, jsonb), public.legacy_import_list_rows(uuid, jsonb), public.legacy_import_skip_rows(uuid, jsonb),
  public.legacy_import_queue_daftra(uuid, uuid), public.legacy_import_daftra_candidates(uuid, jsonb)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.legacy_import_dictionary(), public.legacy_import_create_run(uuid, jsonb, uuid),
  public.legacy_import_set_options(uuid, jsonb), public.legacy_import_stage(uuid, jsonb), public.legacy_import_validate(uuid, jsonb),
  public.legacy_import_commit(uuid, jsonb), public.legacy_import_void(uuid, text, jsonb), public.legacy_import_get_run(uuid),
  public.legacy_import_list_runs(uuid, jsonb), public.legacy_import_list_rows(uuid, jsonb), public.legacy_import_skip_rows(uuid, jsonb),
  public.legacy_import_queue_daftra(uuid, uuid), public.legacy_import_daftra_candidates(uuid, jsonb)
TO authenticated, service_role;
