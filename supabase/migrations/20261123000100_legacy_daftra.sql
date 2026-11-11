-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261123000100 — legacy port, step 7: Daftra alignment (مواءمة دفترة) —
-- docs/online/LEGACY_DAFTRA_AR.md (job contract «عقد المهام»), plan docs/online/LEGACY_PORT_PLAN_AR.md («التكامل مع دفترة»).
-- Builds on legacy_pay (20261122000100), G5 / G5b (20261105000100 / 20261111000100: the outbox billing_sync_jobs, the worker
-- RPCs daftra_claim_jobs / daftra_complete_job, billing_intents / lines / review items), step 1 (org_service_items, customs_ports
-- .daftra_value), step 4 (customs declarations + approve_declaration_extraction), step 5 (transport_trips.party_type /
-- transport_order_no) and step 6 (client_disbursements: the reimbursable charges they create).
--   P. preflight (legacy_pay applied; the G5 worker RPCs / declaration approval present) + schema_versions row
--   0. dictionaries status_labels: bill_job_kind (+ product_match, client_import, invoice_lookup, legacy_scan, supplier_search,
--                   purchase_push), bill_review_kind (+ manual_in_daftra, date_mismatch, readback_mismatch, client_mismatch,
--                   opening_blocked), bill_intent_origin, daftra_run_kind, daftra_run_status, daftra_import_action,
--                   daftra_candidate_state, daftra_purchase_status, daftra_custom_field, daftra_error (the Arabic / English
--                   dictionary of the worker error codes shown by bill/daftra.js and the transaction billing strip)
--   1. columns      daftra_connections + allow_draft_update / allow_product_create (owner-only write policy, FALSE: HF5 — new
--                   drafts only, products resolved by code and never created), auto_draft_on_declaration (FALSE),
--                   purchase_drafts_enabled (FALSE), opening_item, purchase_item, custom_field_map (CustomModel keys per
--                   org), account_profile (currency / country / VAT rates read by the probe), policy_* (who changed it, why);
--                   daftra_item_links + remote_product_code / remote_code_norm (zero-insensitive: 000186 = 186), service_item_id,
--                   mapped_by / mapped_at, match_checked_at; billing_intents + origin (marsa / opening / linked), daftra_url,
--                   invoice_date (today in Asia/Riyadh, fixed at the claim of the create), remote_client_id;
--                   billing_intent_lines + daftra_description (TAS only for appointment fees, empty for the clearance line),
--                   manual_in_daftra; billing_sync_jobs + transaction_id / run_id / purchase_id targets; clients +
--                   daftra_client_code (unique per org; written by the import / link paths only)
--   2. tables       public.daftra_runs (org-level batched read-only runs: product match, Daftra client import, tenant file import,
--                   legacy invoice scan, supplier search — cursor, counters, result), public.daftra_client_import_rows (the
--                   staging rows and their proposed action), public.daftra_invoice_candidates (invoices found by number /
--                   composite match / legacy scan, waiting for a visual confirmation), public.daftra_supplier_links (party ↔
--                   Daftra supplier, stored only on a unique exact match), public.daftra_purchase_drafts (one purchase draft per
--                   trip, behind purchase_drafts_enabled). RLS: finance readers (branch scope through the transaction), supplier
--                   links / supplier-search runs: staff of the org; no write grant; no DELETE; audited (import rows excepted)
--   3. helpers      app.daftra_code_norm, app.daftra_policy, app.daftra_account_check / app.daftra_account_block (the KSA
--                   guard: SAR + Saudi Arabia + an active 15 % tax; fail closed in live mode), app.daftra_write_kinds,
--                   app.daftra_custom_values / app.daftra_custom_fields (custom_required), app.daftra_item_mapped /
--                   app.daftra_unmapped, app.daftra_line_meta (description / eligibility rules), app.daftra_manual_refresh (HF5),
--                   app.daftra_review_open, app.daftra_opening_try (+ trigger app.tg_daftra_opening on customs_declarations),
--                   app.daftra_enqueue, app.daftra_run_json, app.daftra_candidate_json, app.daftra_invoice_match,
--                   app.daftra_import_propose, app.daftra_import_apply_row, app.daftra_apply_* (completion of the new kinds),
--                   app.tg_bill_line_hf5, app.tg_daftra_no_delete
--   4. re-created   G5: app.bill_check_item_key (+ item:<org service item code>), app.bill_item_defaults, app.bill_add_lines
--                   (+ description / eligibility rules, item:<code> keys for register charges), app.bill_eligible, app.bill_conn_json,
--                   app.bill_conn_block (policy-aware capabilities), app.bill_can_read_job, app.bill_job_json,
--                   app.bill_job_context (+ policy, account, custom fields, Riyadh date, product codes, opening line, new
--                   kinds), app.bill_apply_probe (+ account profile), app.bill_apply_pull (HF5: a hand edit is expected, never a
--                   conflict; client_mismatch), app.bill_apply_push_ok (+ daftra_url, read-back checks), app.bill_mark_issued
--                   (HF5 manual lines), app.bill_complete (+ new kinds, HF5 / product guard on the logged calls),
--                   public.daftra_claim_jobs (+ the KSA guard before every write job), public.daftra_complete_job (+ the
--                   purchase lock order), public.request_billing_push (+ HF5 lock, KSA guard, unmapped products, custom_required,
--                   inactive client, opening intents), public.retry_billing_job (+ new kinds), public.tx_billing (+ opening,
--                   candidates, purchase drafts, policy), G5b public.save_daftra_connection (+ the step-7 settings);
--                   step 1: public.cancel_transaction (+ Daftra guard: issued invoice, sync in flight, unreconciled write, purchase
--                   draft), app.tg_clients_legacy_guard (+ daftra_client_code); step 6: app.convert_delete_tables /
--                   app.convert_delete_guards (+ the 5 new tables)
--   5. RPCs         set_daftra_write_policy, save_daftra_custom_fields, test_daftra_custom_fields, list_daftra_product_map,
--                   save_daftra_product_code, request_daftra_product_match, confirm_daftra_product_mapping, retry_daftra_opening,
--                   resolve_daftra_review, list_daftra_reviews, request_daftra_client_import, list_daftra_client_import,
--                   apply_daftra_client_import, import_clients, request_daftra_invoice_lookup, confirm_invoice_link,
--                   reject_invoice_candidate, request_daftra_legacy_scan, get_daftra_run, refresh_tx_daftra,
--                   request_daftra_supplier_search, list_daftra_supplier_links, request_daftra_purchase_draft,
--                   (review) unlink_daftra_supplier
--   review fixes    app.daftra_setting_block (settings / trip re-checked at retry and claim), app.daftra_purchase_unreconciled
--                   («possibly applied» of a purchase draft), owner-only draft settings (set_daftra_write_policy), supplier
--                   links keyed on the party name (+ secondary name), stale-probe guard (target_changed_at), HF5 issue of the
--                   hand-edited lines, legacy Ro-Ro value, G4 appointment fee without TAS excluded, purchase description and
--                   re-read checks, '#' / spaces in product codes, unreadable read-back date, partial composite hints
--   6. RLS, grants, function privileges
-- Owner decisions: NO edit of an existing Daftra invoice / draft (allow_draft_update FALSE: every later line change becomes a
-- 'manual_in_daftra' review item; the flag is owner-only — admin, org-wide, aal2, reason, audited — and has no UI); products are
-- resolved by their Daftra code and never created (allow_product_create FALSE); the AI never approves anything; billing stays
-- blocked without the empty-return proof (the lifecycle gate is untouched: billed only from under_billing); the Daftra account is
-- configured as Egypt: before ANY write (draft, purchase draft, client / product create) the account must be SAR + Saudi Arabia +
-- an active 15 % tax (account_not_ksa: the claim fails the job, nothing is sent); the opening draft on declaration approval and
-- the purchase drafts per trip are org settings, OFF by default. Invoice dates: today in Asia/Riyadh. No key, no subdomain, no
-- product code or field key of any account is seeded: everything account-specific is per-org configuration.
-- Errors: + MRS_DAFTRA_ACCOUNT_NOT_KSA, MRS_DAFTRA_UNMAPPED, MRS_DAFTRA_CUSTOM_REQUIRED, MRS_DAFTRA_DRAFT_LOCKED,
-- MRS_DAFTRA_CLIENT_CONFLICT, MRS_DAFTRA_PURCHASE_DISABLED, MRS_DAFTRA_CONFIRM_MISMATCH, MRS_DAFTRA_IMPORT; otherwise existing
-- codes (MRS_REQUIRED, MRS_INVALID, MRS_FORBIDDEN 'owner_only', MRS_BAD_TRANSITION, MRS_NOTE_REQUIRED, …).
-- Re-runnable (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS + CREATE /
-- ON CONFLICT). Re-pasting 20261105000100 (G5) or 20261111000100 (G5b) after this file restores their bodies (no HF5 lock, no KSA
-- guard, the old job kinds only) and re-pasting 20261117000100 / 20261122000100 restores cancel_transaction / the conversion lists
-- without the step-7 rules: re-paste this file right after.
-- Down-path (staging only): DROP the RPCs of §5 and the app.daftra_* helpers of §3; DROP TABLE public.daftra_purchase_drafts,
-- public.daftra_supplier_links, public.daftra_invoice_candidates, public.daftra_client_import_rows, public.daftra_runs; DROP the
-- columns of §1; re-paste 20261105000100, 20261111000100, 20261117000100 §9 and 20261122000100 §5.
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
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261122000100') THEN
    RAISE EXCEPTION 'LEGACY DAFTRA preflight: apply legacy_pay first (schema_versions lacks 20261122000100 legacy_pay)';
  END IF;
  IF to_regprocedure('public.daftra_claim_jobs(text,integer)') IS NULL OR to_regprocedure('public.daftra_complete_job(uuid,jsonb)') IS NULL
     OR to_regprocedure('public.approve_declaration_extraction(uuid,uuid,jsonb)') IS NULL
     OR to_regclass('public.client_disbursements') IS NULL OR to_regclass('public.org_service_items') IS NULL THEN
    RAISE EXCEPTION 'LEGACY DAFTRA preflight: the G5 worker RPCs / declaration approval / payment register missing (apply 20261105000100 / 20261120000100 / 20261122000100)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261123000100', 'legacy_daftra')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries (internal: client_visible = false)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('bill_job_kind','product_match',8,'مطابقة أصناف دفترة بالكود','Match Daftra products by code',false),
  ('bill_job_kind','client_import',9,'استيراد عملاء دفترة','Import Daftra clients',false),
  ('bill_job_kind','invoice_lookup',10,'البحث عن فاتورة دفترة','Look up a Daftra invoice',false),
  ('bill_job_kind','legacy_scan',11,'مسح فواتير دفترة القديمة','Scan older Daftra invoices',false),
  ('bill_job_kind','supplier_search',12,'البحث في موردي دفترة','Search Daftra suppliers',false),
  ('bill_job_kind','purchase_push',13,'مسودة فاتورة مشتريات','Purchase invoice draft',false),
  ('bill_review_kind','manual_in_daftra',4,'تعديل يدوي مطلوب في دفترة','Change by hand in Daftra',false),
  ('bill_review_kind','date_mismatch',5,'تاريخ الفاتورة في دفترة يختلف','Daftra stored another invoice date',false),
  ('bill_review_kind','readback_mismatch',6,'المسودة المقروءة من دفترة تختلف','The draft read back from Daftra differs',false),
  ('bill_review_kind','client_mismatch',7,'عميل فاتورة دفترة يختلف عن عميل المعاملة','The Daftra invoice client differs from the transaction client',false),
  ('bill_review_kind','opening_blocked',8,'تعذر فتح مسودة دفترة عند اعتماد البيان','The opening Daftra draft could not be requested',false),
  ('bill_intent_origin','marsa',1,'أنشأها مرسى','Created by Marsa',false),
  ('bill_intent_origin','opening',2,'مسودة افتتاحية عند اعتماد البيان','Opening draft at declaration approval',false),
  ('bill_intent_origin','linked',3,'فاتورة دفترة مربوطة يدويًا','Daftra invoice linked by hand',false),
  ('daftra_run_kind','product_match',1,'مطابقة الأصناف بالكود','Product match by code',false),
  ('daftra_run_kind','client_import',2,'استيراد عملاء دفترة','Daftra client import',false),
  ('daftra_run_kind','client_file',3,'استيراد العملاء من ملف','Client import from a file',false),
  ('daftra_run_kind','legacy_scan',4,'مسح الفواتير القديمة','Older invoice scan',false),
  ('daftra_run_kind','supplier_search',5,'بحث الموردين','Supplier search',false),
  ('daftra_run_status','queued',1,'في الانتظار','Queued',false),
  ('daftra_run_status','running',2,'قيد التنفيذ','Running',false),
  ('daftra_run_status','ready',3,'جاهز للمراجعة','Ready for review',false),
  ('daftra_run_status','done',4,'اكتمل','Done',false),
  ('daftra_run_status','applied',5,'طُبّق','Applied',false),
  ('daftra_run_status','aborted',6,'أوقف للحماية','Aborted (protection)',false),
  ('daftra_run_status','failed',7,'فشل','Failed',false),
  ('daftra_import_action','create',1,'عميل جديد','New client',false),
  ('daftra_import_action','link',2,'ربط بعميل قائم (بالكود)','Link to an existing client (by code)',false),
  ('daftra_import_action','update_link',3,'تحديث ربط قائم (بمعرف دفترة)','Refresh an existing link (by Daftra id)',false),
  ('daftra_import_action','review_name',4,'مطابقة بالاسم — تحتاج مراجعة','Name match — needs review',false),
  ('daftra_import_action','conflict',5,'تعارض','Conflict',false),
  ('daftra_import_action','skip',6,'تخطٍّ','Skip',false),
  ('daftra_import_action','invalid',7,'سجل غير صالح','Invalid row',false),
  ('daftra_candidate_state','open',1,'بانتظار التأكيد','Waiting for confirmation',false),
  ('daftra_candidate_state','review',2,'أكثر من تطابق — مراجعة','More than one match — review',false),
  ('daftra_candidate_state','blocked',3,'عميل مختلف — مرفوض','Another client — blocked',false),
  ('daftra_candidate_state','linked',4,'مربوطة','Linked',false),
  ('daftra_candidate_state','rejected',5,'مرفوضة','Rejected',false),
  ('daftra_candidate_state','superseded',6,'استُبدلت ببحث أحدث','Superseded by a newer lookup',false),
  ('daftra_candidate_state','partial',7,'تطابق جزئي — للاطلاع فقط (اربط بالرقم)','Partial match — a hint only (link by number)',false),
  ('daftra_purchase_status','open',1,'بانتظار الإرسال','Waiting to be sent',false),
  ('daftra_purchase_status','draft',2,'مسودة في دفترة','Draft in Daftra',false),
  ('daftra_purchase_status','failed',3,'فشلت','Failed',false),
  ('daftra_purchase_status','cancelled',4,'ملغاة','Cancelled',false),
  ('daftra_custom_field','declaration_no',1,'رقم البيان','Declaration no',false),
  ('daftra_custom_field','declaration_date',2,'تاريخ البيان (DD/MM/YYYY)','Declaration date (DD/MM/YYYY)',false),
  ('daftra_custom_field','bl',3,'رقم البوليصة','B/L no',false),
  ('daftra_custom_field','port',4,'ميناء القدوم','Port',false),
  ('daftra_custom_field','declaration_type',5,'نوع البيان','Declaration type',false),
  ('daftra_custom_field','containers',6,'الحاويات / الشاصي واللوحة','Containers / Ro-Ro chassis and plate',false),
  ('daftra_custom_field','goods',7,'البضاعة (حتى 1000 حرف)','Goods (≤ 1000 chars)',false),
  ('daftra_custom_field','origin',8,'المنشأ (حتى 250 حرفًا)','Origin (≤ 250 chars)',false),
  ('daftra_error','account_not_ksa',1,'حساب دفترة ليس سعوديًا (يجب: الريال السعودي، السعودية، ضريبة 15 %). لم يُرسل شيء؛ يحوّل المالك الحساب أولًا ثم يعيد الفحص.','The Daftra account is not a Saudi account (needed: SAR, Saudi Arabia, a 15 % VAT). Nothing was sent; the owner switches the account, then re-runs the probe.',false),
  ('daftra_error','custom_required',2,'حقول دفترة الإضافية المطلوبة ناقصة: {fields}. لم يُرسل شيء.','Required Daftra custom fields are missing: {fields}. Nothing was sent.',false),
  ('daftra_error','unmapped_product',3,'بنود خدمة بلا كود صنف دفترة معتمد: {fields}.','Service items without a confirmed Daftra product code: {fields}.',false),
  ('daftra_error','product_not_found',4,'لم يُعثر في دفترة على صنف بالكود {fields}. مرسى لا ينشئ أصنافًا.','No Daftra product found with code {fields}. Marsa never creates products.',false),
  ('daftra_error','client_not_linked',5,'العميل غير مربوط بعميل دفترة.','The client is not linked to a Daftra client.',false),
  ('daftra_error','client_suspended',6,'عميل دفترة موقوف؛ لا تُنشأ له مسودة.','The Daftra client is suspended; no draft is created for it.',false),
  ('daftra_error','client_inactive',7,'العميل غير نشط في مرسى.','The client is inactive in Marsa.',false),
  ('daftra_error','draft_update_disabled',8,'تعديل مسودات دفترة القائمة غير مسموح؛ عدّل يدويًا في دفترة.','Editing existing Daftra drafts is not allowed; change it by hand in Daftra.',false),
  ('daftra_error','product_create_disabled',9,'إنشاء الأصناف في دفترة غير مسموح.','Creating products in Daftra is not allowed.',false),
  ('daftra_error','date_mismatch',10,'خزّنت دفترة تاريخًا غير تاريخ اليوم بتوقيت الرياض.','Daftra stored a date other than today in Riyadh time.',false),
  ('daftra_error','readback_mismatch',11,'المسودة المقروءة بعد الإنشاء لا تطابق ما أُرسل ({fields}).','The draft read back after the create differs from what was sent ({fields}).',false),
  ('daftra_error','client_mismatch',12,'عميل فاتورة دفترة يختلف عن عميل المعاملة.','The Daftra invoice client differs from the transaction client.',false),
  ('daftra_error','empty_result',13,'لم تُرجع دفترة أي سجل؛ أوقفت العملية لحماية البيانات الحالية.','Daftra returned no record; the run stopped to protect the current data.',false),
  ('daftra_error','reference_lookup_incomplete',14,'تعذر التأكد من عدم وجود فاتورة بالمرجع نفسه؛ لم تُنشأ مسودة ثانية.','Could not prove that no invoice carries the same reference; no second draft was created.',false),
  ('daftra_error','vat_scan_incomplete',15,'تعذر إكمال البحث عن الرقم الضريبي المكرر.','The duplicate VAT number scan could not complete.',false),
  ('daftra_error','auth_failed',16,'رفضت دفترة مفتاح الربط (401).','Daftra refused the API key (401).',false),
  ('daftra_error','forbidden',17,'صلاحيات مفتاح دفترة تمنع هذا الإجراء (403).','The Daftra key permissions forbid this action (403).',false),
  ('daftra_error','account_mismatch',18,'حساب دفترة لا يطابق النطاق الفرعي المسجل.','The Daftra account does not match the configured subdomain.',false),
  ('daftra_error','not_configured',19,'الحساب الحقيقي غير مُعدّ في هذه البيئة.','The live account is not configured in this environment.',false),
  ('daftra_error','validation',20,'رفضت دفترة البيانات: {fields}.','Daftra refused the data: {fields}.',false),
  ('daftra_error','not_found',21,'السجل غير موجود في دفترة.','The record was not found in Daftra.',false),
  ('daftra_error','rate_limited',22,'دفترة مشغولة (حد الطلبات)؛ ستُعاد المحاولة تلقائيًا.','Daftra is busy (rate limit); the job is retried automatically.',false),
  ('daftra_error','http_5xx',23,'خطأ مؤقت في خادم دفترة؛ ستُعاد المحاولة تلقائيًا.','Temporary Daftra server error; the job is retried automatically.',false),
  ('daftra_error','timeout',24,'انتهت مهلة الاتصال بدفترة؛ قد يكون الطلب نُفّذ، وسيُطابق بالمرجع قبل أي إعادة.','The Daftra call timed out; it may have been applied and is reconciled by reference before any retry.',false),
  ('daftra_error','network',25,'تعذر الاتصال بدفترة؛ ستُعاد المحاولة تلقائيًا.','Could not reach Daftra; the job is retried automatically.',false),
  ('daftra_error','lease_lost',26,'انتهت مهلة المهمة قبل اكتمالها؛ ستُطابق في التشغيل التالي.','The job lease expired before completion; it is reconciled on the next run.',false),
  ('daftra_error','tax_map_invalid',27,'ربط نسب الضريبة بدفترة غير صالح.','The Daftra tax mapping is invalid.',false),
  ('daftra_error','invoice_issued',28,'الفاتورة صادرة في دفترة؛ مرسى لا يعدّلها.','The invoice is issued in Daftra; Marsa never edits it.',false),
  ('daftra_error','supplier_not_linked',29,'جهة النقل غير مربوطة بمورد دفترة.','The transport party is not linked to a Daftra supplier.',false),
  ('daftra_error','worker',30,'خطأ داخلي في عامل المزامنة؛ ستُعاد المحاولة.','Internal sync worker error; the job is retried.',false),
  ('daftra_error','setting_disabled',31,'إعداد المؤسسة أو حالة الرحلة لم يعد يسمح بهذه الكتابة في دفترة ({fields})؛ لم يُرسل شيء.','The org setting or the trip no longer allows this Daftra write ({fields}); nothing was sent.',false),
  ('daftra_error','purchase_review',32,'خزّنت دفترة مسودة المشتريات بشكل مختلف ({fields})؛ راجع الضريبة وحالة المسودة يدويًا في دفترة.','Daftra stored the purchase draft differently ({fields}); check the tax and the draft state by hand in Daftra.',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 1. columns on the G5 / G4 / core tables (no grant change: finance readers already SELECT the whole rows)
-- ---------------------------------------------------------------------
-- the connection: owner-only write policy (HF5), the step-7 settings, the account profile of the probe
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS allow_draft_update boolean NOT NULL DEFAULT false;
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS allow_product_create boolean NOT NULL DEFAULT false;
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS auto_draft_on_declaration boolean NOT NULL DEFAULT false;
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS purchase_drafts_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS opening_item text NOT NULL DEFAULT 'item:customs_clearance';
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS purchase_item text NOT NULL DEFAULT 'item:transportation_cost';
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS custom_field_map jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS account_profile jsonb;
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS account_checked_at timestamptz;
-- review: when the target account (mode / subdomain) last changed: a probe that started before it is stale and never stamps
-- its account profile on the new target
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS target_changed_at timestamptz;
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS policy_changed_by uuid;
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS policy_changed_at timestamptz;
ALTER TABLE public.daftra_connections ADD COLUMN IF NOT EXISTS policy_reason text;
ALTER TABLE public.daftra_connections DROP CONSTRAINT IF EXISTS daftra_connections_step7_chk;
ALTER TABLE public.daftra_connections ADD CONSTRAINT daftra_connections_step7_chk CHECK (
  opening_item ~ '^(item:[a-z][a-z0-9_]{1,39}|(service|internal_service|reimbursable):[a-z][a-z0-9_]{0,39})$'
  AND purchase_item ~ '^(item:[a-z][a-z0-9_]{1,39}|(service|internal_service|reimbursable):[a-z][a-z0-9_]{0,39})$'
  AND jsonb_typeof(custom_field_map) = 'object' AND octet_length(custom_field_map::text) <= 16384
  AND (account_profile IS NULL OR (jsonb_typeof(account_profile) = 'object' AND octet_length(account_profile::text) <= 8192))
  AND char_length(policy_reason) <= 500);
COMMENT ON COLUMN public.daftra_connections.allow_draft_update IS 'legacy step 7 (HF5): FALSE = Marsa never edits an existing Daftra invoice / draft (new drafts only; a later line change is a manual_in_daftra review item). Owner-only (set_daftra_write_policy: admin, org-wide, aal2, reason, audited); no UI.';
COMMENT ON COLUMN public.daftra_connections.allow_product_create IS 'legacy step 7: FALSE = Daftra products are resolved by their code (zero-insensitive) and never created; an unmapped item blocks the draft. Owner-only like allow_draft_update.';
COMMENT ON COLUMN public.daftra_connections.custom_field_map IS 'legacy step 7: the CustomModel keys of THIS org''s Daftra account {fields:{declaration_no|declaration_date|bl|port|declaration_type|containers|goods|origin: {key, required}}, port_values:{<port code>: value}, type_values:{import|export|clearance: value}}. Nothing account-specific is seeded.';
COMMENT ON COLUMN public.daftra_connections.account_profile IS 'legacy step 7: what the read-only probe found {currency, country, vat_rates[], checked_at}: the KSA guard (SAR + Saudi Arabia + an active 15 % tax) before every write.';

-- item mapping: the Daftra product code of an item key (org service items: item:<code>), compared without leading zeros
ALTER TABLE public.daftra_item_links ADD COLUMN IF NOT EXISTS remote_product_code text;
ALTER TABLE public.daftra_item_links ADD COLUMN IF NOT EXISTS remote_code_norm text;
ALTER TABLE public.daftra_item_links ADD COLUMN IF NOT EXISTS service_item_id uuid;
ALTER TABLE public.daftra_item_links ADD COLUMN IF NOT EXISTS mapped_by uuid;
ALTER TABLE public.daftra_item_links ADD COLUMN IF NOT EXISTS mapped_at timestamptz;
ALTER TABLE public.daftra_item_links ADD COLUMN IF NOT EXISTS match_checked_at timestamptz;
ALTER TABLE public.daftra_item_links DROP CONSTRAINT IF EXISTS daftra_item_links_remote_code_chk;
ALTER TABLE public.daftra_item_links ADD CONSTRAINT daftra_item_links_remote_code_chk CHECK (
  remote_product_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$' AND (remote_product_code IS NULL) = (remote_code_norm IS NULL));
ALTER TABLE public.daftra_item_links DROP CONSTRAINT IF EXISTS daftra_item_links_service_item_fk;
ALTER TABLE public.daftra_item_links ADD CONSTRAINT daftra_item_links_service_item_fk
  FOREIGN KEY (service_item_id, org_id) REFERENCES public.org_service_items(id, org_id);
-- one Daftra product per configured code and namespace (a fin_service key and a service item may share one product)
CREATE UNIQUE INDEX IF NOT EXISTS daftra_item_links_code_uidx ON public.daftra_item_links (org_id, (item_key LIKE 'item:%'), remote_code_norm)
  WHERE remote_code_norm IS NOT NULL AND status <> 'retired';
COMMENT ON COLUMN public.daftra_item_links.remote_product_code IS 'legacy step 7: the existing Daftra product code of this item key (configured per org, never seeded); remote_code_norm = app.daftra_code_norm (000186 = 186). Confirmed by confirm_daftra_product_mapping from a product_match job (read only); Marsa never creates the product.';

-- intents: where the draft came from, its Daftra URL, the Riyadh invoice date, the client Daftra stored
ALTER TABLE public.billing_intents ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'marsa';
ALTER TABLE public.billing_intents ADD COLUMN IF NOT EXISTS daftra_url text;
ALTER TABLE public.billing_intents ADD COLUMN IF NOT EXISTS invoice_date date;
ALTER TABLE public.billing_intents ADD COLUMN IF NOT EXISTS remote_client_id text;
ALTER TABLE public.billing_intents DROP CONSTRAINT IF EXISTS billing_intents_step7_chk;
ALTER TABLE public.billing_intents ADD CONSTRAINT billing_intents_step7_chk CHECK (
  origin IN ('marsa','opening','linked') AND char_length(daftra_url) <= 500 AND daftra_url ~ '^https://'
  AND remote_client_id ~ '^[A-Za-z0-9_.:-]{1,64}$');
-- one opening draft per transaction (declaration approval / retry), never two
CREATE UNIQUE INDEX IF NOT EXISTS billing_intents_opening_uidx ON public.billing_intents (transaction_id)
  WHERE origin = 'opening' AND status <> 'cancelled';

-- lines: the description Daftra receives (TAS only for appointment fees, empty for the clearance line), handled by hand (HF5)
ALTER TABLE public.billing_intent_lines ADD COLUMN IF NOT EXISTS daftra_description text;
ALTER TABLE public.billing_intent_lines ADD COLUMN IF NOT EXISTS manual_in_daftra boolean NOT NULL DEFAULT false;
ALTER TABLE public.billing_intent_lines DROP CONSTRAINT IF EXISTS billing_intent_lines_step7_chk;
ALTER TABLE public.billing_intent_lines ADD CONSTRAINT billing_intent_lines_step7_chk CHECK (char_length(daftra_description) <= 500);

-- review items: the step-7 kinds; one open transaction-level item per kind (opening_blocked)
ALTER TABLE public.billing_review_items DROP CONSTRAINT IF EXISTS billing_review_items_kind_check;
ALTER TABLE public.billing_review_items ADD CONSTRAINT billing_review_items_kind_check CHECK (kind IN
  ('late_charge','issued_mismatch','issued_cancelled','manual_in_daftra','date_mismatch','readback_mismatch','client_mismatch','opening_blocked'));
CREATE UNIQUE INDEX IF NOT EXISTS billing_review_items_tx_uidx ON public.billing_review_items (transaction_id, kind)
  WHERE status = 'open' AND intent_id IS NULL AND charge_id IS NULL;

-- jobs: the new kinds and their targets
ALTER TABLE public.billing_sync_jobs ADD COLUMN IF NOT EXISTS transaction_id uuid;
ALTER TABLE public.billing_sync_jobs ADD COLUMN IF NOT EXISTS run_id uuid;
ALTER TABLE public.billing_sync_jobs ADD COLUMN IF NOT EXISTS purchase_id uuid;
ALTER TABLE public.billing_sync_jobs DROP CONSTRAINT IF EXISTS billing_sync_jobs_kind_check;
ALTER TABLE public.billing_sync_jobs ADD CONSTRAINT billing_sync_jobs_kind_check CHECK (kind IN
  ('probe','client_ensure','client_refresh','client_push','item_ensure','invoice_push','invoice_pull',
   'product_match','client_import','invoice_lookup','legacy_scan','supplier_search','purchase_push'));
ALTER TABLE public.billing_sync_jobs DROP CONSTRAINT IF EXISTS billing_sync_jobs_target_chk;
ALTER TABLE public.billing_sync_jobs ADD CONSTRAINT billing_sync_jobs_target_chk CHECK (CASE
    WHEN kind IN ('invoice_push','invoice_pull') THEN intent_id IS NOT NULL AND num_nonnulls(client_link_id, item_link_id, transaction_id, run_id, purchase_id) = 0
    WHEN kind IN ('client_ensure','client_refresh','client_push') THEN client_link_id IS NOT NULL AND num_nonnulls(intent_id, item_link_id, transaction_id, run_id, purchase_id) = 0
    WHEN kind = 'item_ensure' THEN item_link_id IS NOT NULL AND num_nonnulls(intent_id, client_link_id, transaction_id, run_id, purchase_id) = 0
    WHEN kind = 'invoice_lookup' THEN transaction_id IS NOT NULL AND num_nonnulls(intent_id, client_link_id, item_link_id, run_id, purchase_id) = 0
    WHEN kind IN ('product_match','client_import','legacy_scan','supplier_search') THEN run_id IS NOT NULL
         AND num_nonnulls(intent_id, client_link_id, item_link_id, transaction_id, purchase_id) = 0
    WHEN kind = 'purchase_push' THEN purchase_id IS NOT NULL AND num_nonnulls(intent_id, client_link_id, item_link_id, run_id) = 0
    ELSE num_nonnulls(intent_id, client_link_id, item_link_id, transaction_id, run_id, purchase_id) = 0 END);
ALTER TABLE public.billing_sync_jobs DROP CONSTRAINT IF EXISTS billing_sync_jobs_tx_fk;
ALTER TABLE public.billing_sync_jobs ADD CONSTRAINT billing_sync_jobs_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id);
CREATE INDEX IF NOT EXISTS billing_sync_jobs_tx_idx ON public.billing_sync_jobs (transaction_id) WHERE transaction_id IS NOT NULL;

-- clients: the Daftra client number (legacy directory «كود العميل»), written by the import / link paths only
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS daftra_client_code text;
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_daftra_code_chk;
ALTER TABLE public.clients ADD CONSTRAINT clients_daftra_code_chk CHECK (daftra_client_code ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$');
CREATE UNIQUE INDEX IF NOT EXISTS clients_daftra_code_uidx ON public.clients (org_id, upper(daftra_client_code)) WHERE daftra_client_code IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. tables
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daftra_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('product_match','client_import','client_file','legacy_scan','supplier_search')),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','done','applied','aborted','failed')),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 16384),
  cursor        jsonb CHECK (cursor IS NULL OR (jsonb_typeof(cursor) = 'object' AND octet_length(cursor::text) <= 4096)),
  counters      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counters) = 'object'),
  result        jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 262144)),
  pages         int NOT NULL DEFAULT 0 CHECK (pages >= 0),
  error_code    text CHECK (char_length(error_code) <= 60),
  error_message text CHECK (char_length(error_message) <= 500),
  requested_by  uuid,
  applied_by    uuid,
  applied_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.daftra_runs IS 'legacy step 7: an org-level batched READ-ONLY Daftra run (product match by code, client import, tenant file import, legacy invoice scan, supplier search): cursor (resumable), counters, result. One live run per kind and org. Written only by the RPCs and the worker completion.';
CREATE UNIQUE INDEX IF NOT EXISTS daftra_runs_live_uidx ON public.daftra_runs (org_id, kind) WHERE status IN ('queued','running')
  AND kind IN ('product_match','client_import','legacy_scan');
CREATE INDEX IF NOT EXISTS daftra_runs_org_idx ON public.daftra_runs (org_id, kind, created_at DESC);

ALTER TABLE public.billing_sync_jobs DROP CONSTRAINT IF EXISTS billing_sync_jobs_run_fk;
ALTER TABLE public.billing_sync_jobs ADD CONSTRAINT billing_sync_jobs_run_fk FOREIGN KEY (run_id, org_id) REFERENCES public.daftra_runs(id, org_id);

CREATE TABLE IF NOT EXISTS public.daftra_client_import_rows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  run_id            uuid NOT NULL,
  seq               int NOT NULL CHECK (seq BETWEEN 1 AND 100000),
  source            text NOT NULL CHECK (source IN ('daftra','file')),
  external_id       text CHECK (external_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  client_number     text CHECK (char_length(client_number) <= 40),
  name_ar           text CHECK (char_length(name_ar) <= 160),
  name_en           text CHECK (char_length(name_en) <= 160),
  name_norm         text,
  vat_number        text CHECK (char_length(vat_number) <= 40),
  cr_number         text CHECK (char_length(cr_number) <= 40),
  phone             text CHECK (char_length(phone) <= 40),
  email             text CHECK (char_length(email) <= 160),
  city              text CHECK (char_length(city) <= 80),
  port_category     text CHECK (port_category IN ('airport','port','shared')),
  suspended         boolean NOT NULL DEFAULT false,
  proposed_action   text NOT NULL CHECK (proposed_action IN ('create','link','update_link','review_name','conflict','skip','invalid')),
  match_client_id   uuid,
  match_reason      text CHECK (char_length(match_reason) <= 60),
  conflict          jsonb CHECK (conflict IS NULL OR jsonb_typeof(conflict) = 'object'),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','skipped','conflict')),
  applied_action    text CHECK (applied_action IN ('create','link','update_link','skip')),
  applied_client_id uuid,
  applied_by        uuid,
  applied_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daftra_client_import_rows_run_fk FOREIGN KEY (run_id, org_id) REFERENCES public.daftra_runs(id, org_id),
  CONSTRAINT daftra_client_import_rows_match_fk FOREIGN KEY (match_client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT daftra_client_import_rows_applied_fk FOREIGN KEY (applied_client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT daftra_client_import_rows_seq_uniq UNIQUE (run_id, seq),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.daftra_client_import_rows IS 'legacy step 7: the staging rows of a client import (Daftra pages or the tenant''s own file, never the legacy seed) and their proposed action: update_link by Daftra id, link by client number, review_name by normalised Arabic name (a human decides), create, conflict. Never deletes a client; a manual category is never overwritten.';
CREATE INDEX IF NOT EXISTS daftra_client_import_rows_run_idx ON public.daftra_client_import_rows (run_id, proposed_action, status);

CREATE TABLE IF NOT EXISTS public.daftra_invoice_candidates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  transaction_id      uuid,
  run_id              uuid,
  job_id              uuid,
  source              text NOT NULL CHECK (source IN ('lookup_number','lookup_composite','legacy_scan')),
  external_invoice_id text NOT NULL CHECK (external_invoice_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  daftra_number       text CHECK (char_length(daftra_number) <= 60),
  daftra_status       text CHECK (char_length(daftra_status) <= 40),
  remote_state        text CHECK (remote_state IN ('draft','issued','cancelled')),
  invoice_date        date,
  currency            char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  total               numeric(14,2) CHECK (total >= 0),
  remote_client_id    text CHECK (remote_client_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  client_name         text CHECK (char_length(client_name) <= 300),
  po_number           text CHECK (char_length(po_number) <= 80),
  fields              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fields) = 'object' AND octet_length(fields::text) <= 8192),
  match               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(match) = 'object'),
  client_check        text NOT NULL CHECK (client_check IN ('ok','conflict','unlinked')),
  state               text NOT NULL DEFAULT 'open' CHECK (state IN ('open','review','blocked','linked','rejected','superseded','partial')),
  linked_intent_id    uuid,
  decided_by          uuid,
  decided_at          timestamptz,
  note                text CHECK (char_length(note) <= 2000),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daftra_invoice_candidates_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT daftra_invoice_candidates_run_fk FOREIGN KEY (run_id, org_id) REFERENCES public.daftra_runs(id, org_id),
  CONSTRAINT daftra_invoice_candidates_job_fk FOREIGN KEY (job_id, org_id) REFERENCES public.billing_sync_jobs(id, org_id),
  CONSTRAINT daftra_invoice_candidates_intent_fk FOREIGN KEY (linked_intent_id, org_id) REFERENCES public.billing_intents(id, org_id),
  CONSTRAINT daftra_invoice_candidates_link_chk CHECK ((state = 'linked') = (linked_intent_id IS NOT NULL)),
  CONSTRAINT daftra_invoice_candidates_blocked_chk CHECK (state <> 'blocked' OR client_check = 'conflict'),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.daftra_invoice_candidates IS 'legacy step 7: Daftra invoices found READ-ONLY by invoice number, by the exact composite match (declaration + B/L + containers) or by the legacy back-fill scan, waiting for a visual confirmation (confirm_invoice_link). Another client = blocked (hard block); more than one exact match = review.';
CREATE UNIQUE INDEX IF NOT EXISTS daftra_invoice_candidates_live_uidx ON public.daftra_invoice_candidates
  (org_id, coalesce(transaction_id, '00000000-0000-0000-0000-000000000000'::uuid), external_invoice_id) WHERE state IN ('open','review','blocked');
CREATE INDEX IF NOT EXISTS daftra_invoice_candidates_tx_idx ON public.daftra_invoice_candidates (transaction_id, state);
-- review: + 'partial' (composite lookup hints, never linkable) on a table created by an earlier paste of this file
ALTER TABLE public.daftra_invoice_candidates DROP CONSTRAINT IF EXISTS daftra_invoice_candidates_state_check;
ALTER TABLE public.daftra_invoice_candidates ADD CONSTRAINT daftra_invoice_candidates_state_check
  CHECK (state IN ('open','review','blocked','linked','rejected','superseded','partial'));

CREATE TABLE IF NOT EXISTS public.daftra_supplier_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  party_id             uuid,
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
  name_norm            text NOT NULL CHECK (char_length(name_norm) BETWEEN 1 AND 300),
  external_supplier_id text NOT NULL CHECK (external_supplier_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  supplier_number      text CHECK (char_length(supplier_number) <= 60),
  run_id               uuid,
  status               text NOT NULL DEFAULT 'linked' CHECK (status IN ('linked','unlinked')),
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daftra_supplier_links_party_fk FOREIGN KEY (party_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT daftra_supplier_links_run_fk FOREIGN KEY (run_id, org_id) REFERENCES public.daftra_runs(id, org_id),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.daftra_supplier_links IS 'legacy step 7 (R12TransportPurchases searchDaftraSuppliersR12): a transport party (or a party name) ↔ a Daftra supplier id, stored only when a read-only supplier search found exactly one exact (normalised) name match.';
-- review: an audited unlink (unlink_daftra_supplier: who, when, why)
ALTER TABLE public.daftra_supplier_links ADD COLUMN IF NOT EXISTS unlinked_by uuid;
ALTER TABLE public.daftra_supplier_links ADD COLUMN IF NOT EXISTS unlinked_at timestamptz;
ALTER TABLE public.daftra_supplier_links ADD COLUMN IF NOT EXISTS unlink_reason text;
ALTER TABLE public.daftra_supplier_links DROP CONSTRAINT IF EXISTS daftra_supplier_links_unlink_chk;
ALTER TABLE public.daftra_supplier_links ADD CONSTRAINT daftra_supplier_links_unlink_chk
  CHECK (char_length(unlink_reason) <= 2000 AND (status <> 'unlinked' OR (unlinked_at IS NOT NULL AND unlink_reason IS NOT NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS daftra_supplier_links_ext_uidx ON public.daftra_supplier_links (org_id, external_supplier_id) WHERE status = 'linked';
CREATE UNIQUE INDEX IF NOT EXISTS daftra_supplier_links_party_uidx ON public.daftra_supplier_links (org_id, party_id) WHERE status = 'linked' AND party_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS daftra_supplier_links_name_uidx ON public.daftra_supplier_links (org_id, name_norm) WHERE status = 'linked' AND party_id IS NULL;

CREATE TABLE IF NOT EXISTS public.daftra_purchase_drafts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  transaction_id       uuid NOT NULL,
  trip_id              uuid NOT NULL,
  supplier_link_id     uuid NOT NULL,
  reference            text NOT NULL CHECK (reference ~ '^MRSP-[0-9A-F]{12}(-R[0-9]{1,3})?$'),
  amount               numeric(14,2) NOT NULL CHECK (amount > 0),
  currency             char(3) NOT NULL DEFAULT 'SAR' CHECK (currency ~ '^[A-Z]{3}$'),
  accrual_ids          uuid[] NOT NULL DEFAULT '{}',
  item_key             text NOT NULL,
  invoice_date         date,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','draft','failed','cancelled')),
  sync_state           text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','in_flight','synced','unknown','error')),
  external_purchase_id text CHECK (external_purchase_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  daftra_number        text CHECK (char_length(daftra_number) <= 60),
  daftra_url           text CHECK (char_length(daftra_url) <= 500 AND daftra_url ~ '^https://'),
  last_error_code      text CHECK (char_length(last_error_code) <= 60),
  last_error_message   text CHECK (char_length(last_error_message) <= 500),
  created_by           uuid,
  cancelled_by         uuid,
  cancelled_at         timestamptz,
  cancel_reason        text CHECK (char_length(cancel_reason) <= 2000),
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daftra_purchase_drafts_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT daftra_purchase_drafts_trip_fk FOREIGN KEY (trip_id, transaction_id) REFERENCES public.transport_trips(id, transaction_id),
  CONSTRAINT daftra_purchase_drafts_supplier_fk FOREIGN KEY (supplier_link_id, org_id) REFERENCES public.daftra_supplier_links(id, org_id),
  CONSTRAINT daftra_purchase_drafts_ref_uniq UNIQUE (org_id, reference),
  CONSTRAINT daftra_purchase_drafts_cancel_chk CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.daftra_purchase_drafts IS 'legacy step 7 (R12TransportPurchases ensureMovementPurchaseDraftR12_, disabled in the legacy): one Daftra purchase invoice DRAFT per trip from its cost accruals, zero tax, the configured transport product; the Daftra id is stored as soon as it is known (a lost response is reconciled by reference) so no second draft is created. Behind daftra_connections.purchase_drafts_enabled (FALSE).';
CREATE UNIQUE INDEX IF NOT EXISTS daftra_purchase_drafts_trip_uidx ON public.daftra_purchase_drafts (trip_id) WHERE status <> 'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS daftra_purchase_drafts_ext_uidx ON public.daftra_purchase_drafts (org_id, external_purchase_id) WHERE external_purchase_id IS NOT NULL;

ALTER TABLE public.billing_sync_jobs DROP CONSTRAINT IF EXISTS billing_sync_jobs_purchase_fk;
ALTER TABLE public.billing_sync_jobs ADD CONSTRAINT billing_sync_jobs_purchase_fk FOREIGN KEY (purchase_id, org_id) REFERENCES public.daftra_purchase_drafts(id, org_id);

-- ---------------------------------------------------------------------
-- row triggers of the new tables (no DELETE; derived columns; updated_at; audit)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_daftra_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM app.fail('MRS_APPEND_ONLY', TG_TABLE_NAME);
  RETURN NULL;
END $$;

DO $trg$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['daftra_runs','daftra_client_import_rows','daftra_invoice_candidates','daftra_supplier_links','daftra_purchase_drafts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_no_delete ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_daftra_no_delete()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
    IF t <> 'daftra_client_import_rows' THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_audit()', t);
    END IF;
  END LOOP;
END $trg$;

-- ---------------------------------------------------------------------
-- 3. helpers
-- ---------------------------------------------------------------------
-- a Daftra product / client code compared without leading zeros (legacy resolveDaftraProductByCode_: 000186 = 186);
-- Arabic digits → western, upper case, surrounding spaces dropped; NULL / empty → NULL
-- review: like the legacy normalizeDaftraProductCode_, a leading '#' and every whitespace are ignored ('#000186', '000 186' = 186)
CREATE OR REPLACE FUNCTION app.daftra_code_norm(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN x IS NULL THEN NULL
              WHEN x ~ '^[0-9]+$' THEN coalesce(nullif(ltrim(x, '0'), ''), '0')
              ELSE x END
    FROM (SELECT nullif(upper(regexp_replace(regexp_replace(app.to_western(coalesce(p, '')), '^\s*#', ''), '\s+', '', 'g')), '') x) n
$$;

-- the owner-only write policy of an org (no connection row = the defaults: both FALSE)
CREATE OR REPLACE FUNCTION app.daftra_allow_update(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT c.allow_draft_update FROM public.daftra_connections c WHERE c.org_id = p_org), false)
$$;
CREATE OR REPLACE FUNCTION app.daftra_allow_create(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT c.allow_product_create FROM public.daftra_connections c WHERE c.org_id = p_org), false)
$$;

-- the jobs that may WRITE to Daftra (the KSA guard runs before each of them is handed to the worker)
CREATE OR REPLACE FUNCTION app.daftra_write_kinds() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['invoice_push','purchase_push','client_ensure','client_push','item_ensure']
$$;

-- the KSA account guard (owner decision: the account is still set to Egypt): SAR + Saudi Arabia + an active 15 % tax.
-- Live (and live_pending) accounts fail closed: no profile = not checked = blocked. The mock (simulation, nothing is ever
-- written anywhere real) is blocked only by a contradiction it reports (another currency / country, no 15 % rate).
CREATE OR REPLACE FUNCTION app.daftra_account_check(c public.daftra_connections) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_p jsonb := c.account_profile; v_cur text; v_ctry text; v_rates jsonb; v_vat boolean; v_reason text; v_live boolean;
BEGIN
  v_live := coalesce(c.mode, 'mock') <> 'mock';
  v_cur := upper(nullif(btrim(coalesce(v_p ->> 'currency', '')), ''));
  v_ctry := lower(nullif(btrim(coalesce(v_p ->> 'country', '')), ''));
  v_rates := CASE WHEN jsonb_typeof(v_p -> 'vat_rates') = 'array' THEN v_p -> 'vat_rates' END;
  v_vat := EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_rates, '[]'::jsonb)) x
                    WHERE jsonb_typeof(x) = 'number' AND (x #>> '{}')::numeric = 15);
  IF v_live THEN
    v_reason := CASE WHEN c.id IS NULL OR v_p IS NULL THEN 'not_checked'
                     WHEN v_cur IS DISTINCT FROM 'SAR' THEN 'currency'
                     WHEN v_ctry IS NULL OR NOT (v_ctry = ANY (ARRAY['sa','sau','ksa','saudi arabia','kingdom of saudi arabia','السعودية','المملكة العربية السعودية'])) THEN 'country'
                     WHEN NOT v_vat THEN 'vat_rate' END;
  ELSE
    v_reason := CASE WHEN v_cur IS NOT NULL AND v_cur <> 'SAR' THEN 'currency'
                     WHEN v_ctry IS NOT NULL AND NOT (v_ctry = ANY (ARRAY['sa','sau','ksa','saudi arabia','kingdom of saudi arabia','السعودية','المملكة العربية السعودية'])) THEN 'country'
                     WHEN v_rates IS NOT NULL AND NOT v_vat THEN 'vat_rate' END;
  END IF;
  RETURN jsonb_build_object('ok', v_reason IS NULL, 'reason', v_reason, 'currency', v_cur, 'country', v_p ->> 'country',
                            'vat_15', v_vat, 'checked_at', v_p -> 'checked_at', 'enforced', v_live);
END $$;
-- NULL when the org may write to Daftra, else the reason (not_checked | currency | country | vat_rate)
CREATE OR REPLACE FUNCTION app.daftra_account_block(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.daftra_account_check(c) ->> 'reason'
    FROM (SELECT 1) one LEFT JOIN public.daftra_connections c ON c.org_id = p_org
$$;

-- the logical custom-field values of a transaction (legacy collectDaftraInvoiceSupplement_ / buildDaftraCustomModelPayload_):
-- the active declaration (number, date DD/MM/YYYY, type → the org's Daftra value), the primary B/L, the port (the org's value,
-- else customs_ports.daftra_value, else its Arabic name), the containers (Ro-Ro: chassis / plate), goods ≤ 1000, origin ≤ 250
CREATE OR REPLACE FUNCTION app.daftra_custom_values(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_t public.transactions; v_d public.customs_declarations; v_map jsonb; v_bl text; v_port text; v_type text; v_ctr text;
        v_goods text; v_origin text;
BEGIN
  SELECT * INTO v_t FROM public.transactions t WHERE t.id = p_tx;
  IF v_t.id IS NULL THEN RETURN '{}'::jsonb; END IF;
  SELECT coalesce(c.custom_field_map, '{}'::jsonb) INTO v_map FROM public.daftra_connections c WHERE c.org_id = v_t.org_id;
  v_map := coalesce(v_map, '{}'::jsonb);
  SELECT * INTO v_d FROM public.customs_declarations d
   WHERE d.transaction_id = v_t.id AND d.status NOT IN ('cancelled','replaced') ORDER BY d.created_at DESC, d.id DESC LIMIT 1;
  SELECT bl.bl_number INTO v_bl FROM public.transaction_bls tb JOIN public.bills_of_lading bl ON bl.id = tb.bl_id
   WHERE tb.transaction_id = v_t.id ORDER BY tb.is_primary DESC, tb.created_at LIMIT 1;
  v_bl := coalesce(v_bl, v_t.bl_number);
  SELECT coalesce(nullif(btrim(v_map #>> ARRAY['port_values', p.code]), ''), p.daftra_value, p.name_ar) INTO v_port
    FROM public.customs_ports p WHERE p.code = v_t.port_code;
  v_type := coalesce(nullif(btrim(v_map #>> ARRAY['type_values', coalesce(v_d.declaration_type_code, '')]), ''),
                     CASE v_d.declaration_type_code WHEN 'import' THEN 'وارد' WHEN 'export' THEN 'صادر' WHEN 'clearance' THEN 'تصفية' END);
  IF v_t.cargo_unit_type = 'roro' THEN
    -- review: the legacy value (buildDaftraInvoiceCustomFields_), so Marsa's and the legacy Ro-Ro invoices read back alike:
    -- 'Ro-Ro — شاسيه <chassis> — لوحة <plate>' (the parts that exist)
    v_ctr := CASE WHEN nullif(btrim(coalesce(v_t.chassis_no, '')), '') IS NULL AND nullif(btrim(coalesce(v_t.vehicle_plate_no, '')), '') IS NULL THEN NULL
                  ELSE concat_ws(' — ', 'Ro-Ro', 'شاسيه ' || nullif(btrim(v_t.chassis_no), ''), 'لوحة ' || nullif(btrim(v_t.vehicle_plate_no), '')) END;
  ELSE
    SELECT string_agg(k.container_no, ', ' ORDER BY k.container_no) INTO v_ctr FROM public.containers k WHERE k.transaction_id = v_t.id;
  END IF;
  IF v_d.id IS NOT NULL THEN
    SELECT string_agg(x.v, '، ' ORDER BY x.o), NULL INTO v_goods, v_origin
      FROM (SELECT i.description_ar v, min(i.line_no) o FROM public.declaration_items i
             WHERE i.declaration_id = v_d.id AND i.voided_at IS NULL AND nullif(btrim(i.description_ar), '') IS NOT NULL GROUP BY i.description_ar) x;
    SELECT string_agg(x.v, '، ' ORDER BY x.o) INTO v_origin
      FROM (SELECT i.origin_country v, min(i.line_no) o FROM public.declaration_items i
             WHERE i.declaration_id = v_d.id AND i.voided_at IS NULL AND nullif(btrim(i.origin_country), '') IS NOT NULL GROUP BY i.origin_country) x;
  END IF;
  RETURN jsonb_build_object(
    'declaration_no', v_d.declaration_no,
    'declaration_date', to_char(v_d.declaration_date, 'DD/MM/YYYY'),
    'bl', v_bl,
    'port', v_port,
    'declaration_type', v_type,
    'containers', left(v_ctr, 1000),
    'goods', left(coalesce(v_goods, nullif(btrim(v_t.goods_description), '')), 1000),
    'origin', left(coalesce(v_origin, nullif(btrim(v_t.country), '')), 250));
END $$;

-- the custom fields of a draft: {payload:{<daftra key>: value}, fields:[{name, key, required, value}], missing:[names]}.
-- Only the fields the org configured are sent; a required one without a value is 'custom_required' (checked before any call).
CREATE OR REPLACE FUNCTION app.daftra_custom_fields(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_map jsonb; v_vals jsonb; v_fields jsonb := '[]'::jsonb; v_payload jsonb := '{}'::jsonb; v_missing text[] := '{}';
        r record;
BEGIN
  SELECT t.org_id INTO v_org FROM public.transactions t WHERE t.id = p_tx;
  SELECT c.custom_field_map INTO v_map FROM public.daftra_connections c WHERE c.org_id = v_org;
  v_vals := app.daftra_custom_values(p_tx);
  FOR r IN SELECT f.code, f.sort, v_map #> ARRAY['fields', f.code] cfg FROM public.status_labels f
            WHERE f.domain = 'daftra_custom_field' ORDER BY f.sort LOOP
    CONTINUE WHEN r.cfg IS NULL OR jsonb_typeof(r.cfg) <> 'object' OR nullif(r.cfg ->> 'key', '') IS NULL;
    v_fields := v_fields || jsonb_build_array(jsonb_build_object('name', r.code, 'key', r.cfg ->> 'key',
      'required', coalesce((r.cfg ->> 'required')::boolean, false), 'value', v_vals ->> r.code));
    IF v_vals ->> r.code IS NOT NULL THEN
      v_payload := v_payload || jsonb_build_object(r.cfg ->> 'key', v_vals ->> r.code);
    ELSIF coalesce((r.cfg ->> 'required')::boolean, false) THEN
      v_missing := v_missing || r.code;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('payload', v_payload, 'fields', v_fields, 'missing', to_jsonb(v_missing));
END $$;

-- an item key is mapped when its product was confirmed by code (or, under the legacy G5 policy, when Marsa may create it)
CREATE OR REPLACE FUNCTION app.daftra_item_mapped(p_org uuid, p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.daftra_allow_create(p_org) OR EXISTS (
    SELECT 1 FROM public.daftra_item_links i
     WHERE i.org_id = p_org AND i.item_key = p_key AND i.status = 'linked' AND i.remote_code_norm IS NOT NULL AND i.external_product_id IS NOT NULL)
$$;
-- the unmapped keys among p_keys (sorted, distinct)
CREATE OR REPLACE FUNCTION app.daftra_unmapped(p_org uuid, p_keys text[]) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(DISTINCT k ORDER BY k), '{}'::text[]) FROM unnest(coalesce(p_keys, '{}'::text[])) k
   WHERE k IS NOT NULL AND NOT app.daftra_item_mapped(p_org, k)
$$;

-- a sales line's Daftra rules (legacy r115BuildPaymentItemDescription_ / r115IsSalesDraftExcludedFee_ / r115IsAutoSyncCandidate_):
-- {item_key, description, excluded}. A charge created by the payment register (step 6) uses its service item's product
-- (item:<code>); a shared payment and the internal transport cost («تكلفة النقل») are never on a sales draft; an appointment
-- fee's description is its TAS number only (missing → excluded 'tas_missing'); the clearance line has an empty description.
CREATE OR REPLACE FUNCTION app.daftra_line_meta(c public.client_charges) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; v_desc text; v_tas text;
BEGIN
  SELECT a.claim_no a_claim, d.pattern, d.appointment_no, d.claim_no d_claim, d.sadad_number, d.bank_reference, d.receipt_no, d.ref d_ref,
         s.code s_code, s.fin_service s_fin
    INTO r
    FROM public.disbursement_allocations a JOIN public.client_disbursements d ON d.id = a.disbursement_id
    JOIN public.org_service_items s ON s.id = d.service_item_id
   WHERE a.client_charge_id = c.id AND a.voided_at IS NULL AND d.status = 'recorded'
   ORDER BY a.created_at DESC LIMIT 1;
  IF FOUND THEN
    IF r.pattern = 'shared' THEN
      RETURN jsonb_build_object('item_key', 'item:' || r.s_code, 'description', NULL, 'excluded', 'shared_payment');
    END IF;
    IF r.s_code = 'transportation_cost' THEN
      RETURN jsonb_build_object('item_key', 'item:' || r.s_code, 'description', NULL, 'excluded', 'internal_transport_cost');
    END IF;
    IF r.s_fin IN ('gate_in_appointment','gate_out_appointment') THEN
      IF r.appointment_no IS NULL THEN
        RETURN jsonb_build_object('item_key', 'item:' || r.s_code, 'description', NULL, 'excluded', 'tas_missing');
      END IF;
      RETURN jsonb_build_object('item_key', 'item:' || r.s_code, 'description', left(r.appointment_no, 500), 'excluded', NULL);
    END IF;
    IF r.s_code = 'customs_clearance' OR r.s_fin = 'customs_clearance' THEN
      RETURN jsonb_build_object('item_key', 'item:' || r.s_code, 'description', '', 'excluded', NULL);
    END IF;
    v_desc := concat_ws(' | ', 'فاتورة/مرجع: ' || coalesce(r.a_claim, r.d_claim),
                        coalesce('سداد: ' || r.sadad_number, 'مرجع: ' || r.bank_reference, 'عملية: ' || r.receipt_no));
    RETURN jsonb_build_object('item_key', 'item:' || r.s_code, 'description', left(coalesce(nullif(v_desc, ''), 'سجل سداد: ' || r.d_ref), 500),
                              'excluded', NULL);
  END IF;
  -- a charge typed in G4: its kind:service_code product; an appointment fee carrying a TAS number sends the TAS only
  v_tas := CASE WHEN c.service_code IN ('gate_in_appointment','gate_out_appointment') THEN app.norm_tas(c.description) END;
  -- review: an appointment fee without a TAS number is never sent (legacy: no substitute number, no free text, no container)
  IF c.service_code IN ('gate_in_appointment','gate_out_appointment') AND v_tas IS NULL THEN
    RETURN jsonb_build_object('item_key', app.bill_item_key(c.kind, c.service_code), 'description', NULL, 'excluded', 'tas_missing');
  END IF;
  RETURN jsonb_build_object('item_key', app.bill_item_key(c.kind, c.service_code),
    'description', CASE WHEN v_tas IS NOT NULL THEN v_tas WHEN c.service_code = 'customs_clearance' THEN '' END, 'excluded', NULL);
END $$;

-- one open review item (intent-level, or transaction-level when p_intent is NULL), details replaced while it stays open
CREATE OR REPLACE FUNCTION app.daftra_review_open(p_org uuid, p_tx uuid, p_intent uuid, p_kind text, p_details jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_det jsonb := app.bill_bound_details(app.bill_redact(coalesce(p_details, '{}'::jsonb)));
BEGIN
  IF p_intent IS NOT NULL THEN
    INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, kind, details)
    VALUES (p_org, p_tx, p_intent, p_kind, v_det)
    ON CONFLICT (intent_id, kind) WHERE status = 'open' AND charge_id IS NULL DO UPDATE SET details = EXCLUDED.details
    RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.billing_review_items (org_id, transaction_id, kind, details)
    VALUES (p_org, p_tx, p_kind, v_det)
    ON CONFLICT (transaction_id, kind) WHERE status = 'open' AND intent_id IS NULL AND charge_id IS NULL DO UPDATE SET details = EXCLUDED.details
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END $$;

-- HF5 (allow_draft_update FALSE): once a Daftra draft exists, Marsa never edits it. The lines still waiting to be added /
-- removed are listed in ONE open 'manual_in_daftra' review item of the intent (what to change by hand in Daftra); the item is
-- closed ('nothing_left') when nothing is waiting any more.
CREATE OR REPLACE FUNCTION app.daftra_manual_refresh(p_intent uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_add jsonb; v_rem jsonb;
BEGIN
  SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = p_intent;
  IF v_i.id IS NULL OR v_i.status NOT IN ('open','draft') OR app.daftra_allow_update(v_i.org_id) THEN RETURN; END IF;
  IF v_i.external_invoice_id IS NULL AND v_i.origin <> 'linked' THEN RETURN; END IF;     -- not created yet: the create carries the lines
  SELECT coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'line_ref', l.line_ref, 'charge_id', l.charge_id, 'item_key', l.item_key,
           'product_code', (SELECT k.remote_product_code FROM public.daftra_item_links k WHERE k.org_id = l.org_id AND k.item_key = l.item_key AND k.status <> 'retired'),
           'description', coalesce(l.daftra_description, l.description), 'quantity', l.quantity, 'unit_price', l.unit_price,
           'vat_rate', l.vat_rate, 'total_amount', l.total_amount) ORDER BY l.created_at, l.id) FILTER (WHERE l.state = 'pending_add' AND NOT l.manual_in_daftra),
         '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'line_ref', l.line_ref, 'charge_id', l.charge_id,
           'description', coalesce(l.daftra_description, l.description), 'total_amount', l.total_amount, 'reason', l.removed_reason)
           ORDER BY l.created_at, l.id) FILTER (WHERE l.state = 'pending_remove'), '[]'::jsonb)
    INTO v_add, v_rem
    FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id;
  IF jsonb_array_length(v_add) = 0 AND jsonb_array_length(v_rem) = 0 THEN
    UPDATE public.billing_review_items r SET status = 'resolved', resolution = 'nothing_left', resolved_at = now(), resolved_by = auth.uid()
     WHERE r.intent_id = v_i.id AND r.kind = 'manual_in_daftra' AND r.status = 'open';
    RETURN;
  END IF;
  PERFORM app.daftra_review_open(v_i.org_id, v_i.transaction_id, v_i.id, 'manual_in_daftra', jsonb_build_object(
    'reason', 'draft_update_disabled', 'external_invoice_id', v_i.external_invoice_id, 'daftra_number', v_i.daftra_number,
    'daftra_url', v_i.daftra_url, 'operational_ref', v_i.operational_ref, 'add', v_add, 'remove', v_rem));
END $$;

CREATE OR REPLACE FUNCTION app.tg_bill_line_hf5() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.daftra_manual_refresh(NEW.intent_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_bill_hf5 ON public.billing_intent_lines;
CREATE TRIGGER trg_bill_hf5 AFTER INSERT OR UPDATE OF state, manual_in_daftra ON public.billing_intent_lines
  FOR EACH ROW EXECUTE FUNCTION app.tg_bill_line_hf5();

-- enqueue a job of a step-7 kind (target = transaction / run / purchase), or return the live one with the same dedupe key
CREATE OR REPLACE FUNCTION app.daftra_enqueue(p_org uuid, p_kind text, p_tx uuid, p_run uuid, p_purchase uuid, p_key_suffix text,
  p_options jsonb DEFAULT '{}'::jsonb, p_by uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_key text; v_j public.billing_sync_jobs; v_dedup boolean := false;
BEGIN
  v_key := p_kind || ':' || coalesce(p_tx, p_run, p_purchase)::text || coalesce(':' || p_key_suffix, '');
  INSERT INTO public.billing_sync_jobs (org_id, kind, transaction_id, run_id, purchase_id, dedupe_key, options, priority, requested_by)
  VALUES (p_org, p_kind, p_tx, p_run, p_purchase, v_key, coalesce(p_options, '{}'::jsonb),
          CASE WHEN p_kind = 'purchase_push' THEN 2 WHEN p_kind = 'invoice_lookup' THEN 3 ELSE 4 END, p_by)
  ON CONFLICT (org_id, dedupe_key) WHERE status IN ('queued','running','unknown') DO NOTHING
  RETURNING * INTO v_j;
  IF v_j.id IS NULL THEN
    SELECT * INTO v_j FROM public.billing_sync_jobs j
     WHERE j.org_id = p_org AND j.dedupe_key = v_key AND j.status IN ('queued','running','unknown') FOR UPDATE;
    v_dedup := true;
  END IF;
  RETURN app.bill_job_json(v_j) || jsonb_build_object('deduplicated', v_dedup);
END $$;

-- the push gate shared by request_billing_push and the opening draft: NULL = ready, else {code, detail, hint}
CREATE OR REPLACE FUNCTION app.daftra_push_block(p_i public.billing_intents) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_conn public.daftra_connections; v_acc text; v_keys text[]; v_un text[]; v_cf jsonb; v_c public.clients;
BEGIN
  SELECT * INTO v_conn FROM public.daftra_connections c WHERE c.org_id = p_i.org_id;
  v_acc := app.daftra_account_block(p_i.org_id);
  IF v_acc IS NOT NULL THEN RETURN jsonb_build_object('code', 'MRS_DAFTRA_ACCOUNT_NOT_KSA', 'detail', v_acc, 'reason', 'account_not_ksa'); END IF;
  SELECT * INTO v_c FROM public.clients c WHERE c.id = p_i.client_id;
  IF NOT coalesce(v_c.is_active, false) THEN RETURN jsonb_build_object('code', 'MRS_BAD_TRANSITION', 'detail', 'client_inactive', 'reason', 'client_inactive'); END IF;
  v_keys := ARRAY(SELECT DISTINCT l.item_key FROM public.billing_intent_lines l WHERE l.intent_id = p_i.id AND l.state IN ('pending_add','synced'));
  IF p_i.origin = 'opening' THEN v_keys := v_keys || coalesce(v_conn.opening_item, 'item:customs_clearance'); END IF;
  v_un := app.daftra_unmapped(p_i.org_id, v_keys);
  IF cardinality(v_un) > 0 THEN
    RETURN jsonb_build_object('code', 'MRS_DAFTRA_UNMAPPED', 'detail', 'items', 'hint', array_to_string(v_un, ','), 'reason', 'unmapped_product');
  END IF;
  v_cf := app.daftra_custom_fields(p_i.transaction_id);
  IF jsonb_array_length(v_cf -> 'missing') > 0 THEN
    RETURN jsonb_build_object('code', 'MRS_DAFTRA_CUSTOM_REQUIRED', 'detail', 'fields',
      'hint', (SELECT string_agg(x, ',' ORDER BY o) FROM jsonb_array_elements_text(v_cf -> 'missing') WITH ORDINALITY y(x, o)), 'reason', 'custom_required');
  END IF;
  RETURN NULL;
END $$;

-- the opening zero-value draft of a transaction (legacy ensureDaftraDraftInvoiceForTransaction_): ONE per transaction, the
-- clearance item at 0 SAR, po_number = the transaction ref, the custom fields, today in Riyadh. Requires a declaration number and
-- a linked, active client; a blocked request is recorded as ONE open 'opening_blocked' review item (retry: retry_daftra_opening).
-- Never raises for a business reason: the declaration approval that triggered it is never undone by Daftra.
-- p_source 'declaration' (the deferred trigger: only when auto_draft_on_declaration) | 'retry' (staff).
CREATE OR REPLACE FUNCTION app.daftra_opening_try(p_tx uuid, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_t public.transactions; v_conn public.daftra_connections; v_d public.customs_declarations; v_c public.clients;
        v_l public.daftra_client_links; v_i public.billing_intents; v_rev int; v_ref text; v_block jsonb; v_job jsonb; v_reason text;
        v_det jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_t FROM public.transactions t WHERE t.id = p_tx FOR UPDATE;
  IF v_t.id IS NULL OR v_t.cancelled_at IS NOT NULL THEN RETURN jsonb_build_object('status', 'skipped', 'reason', 'transaction'); END IF;
  SELECT * INTO v_conn FROM public.daftra_connections c WHERE c.org_id = v_t.org_id;
  IF NOT coalesce(v_conn.auto_draft_on_declaration, false) THEN RETURN jsonb_build_object('status', 'disabled'); END IF;
  -- one per transaction: an opening intent, or any live final intent of the transaction, means there is nothing to open
  SELECT * INTO v_i FROM public.billing_intents i
   WHERE i.transaction_id = v_t.id AND i.status <> 'cancelled' AND (i.origin = 'opening' OR i.purpose_key = 'F')
   ORDER BY (i.origin = 'opening') DESC, i.created_at LIMIT 1;
  IF v_i.id IS NOT NULL THEN RETURN jsonb_build_object('status', 'exists', 'intent_id', v_i.id); END IF;
  SELECT * INTO v_d FROM public.customs_declarations d
   WHERE d.transaction_id = v_t.id AND d.status NOT IN ('cancelled','replaced') ORDER BY d.created_at DESC, d.id DESC LIMIT 1;
  SELECT * INTO v_c FROM public.clients c WHERE c.id = v_t.client_id;
  SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.org_id = v_t.org_id AND l.client_id = v_t.client_id AND l.status <> 'unlinked';
  v_reason := CASE WHEN v_d.id IS NULL THEN 'declaration_no'
                   WHEN NOT coalesce(v_c.is_active, false) THEN 'client_inactive'
                   WHEN v_l.id IS NULL OR v_l.status NOT IN ('linked','drift') OR v_l.external_id IS NULL THEN 'client_not_linked'
                   WHEN v_conn.status IS DISTINCT FROM 'connected' OR NOT v_conn.sync_enabled THEN 'not_connected' END;
  IF v_reason IS NULL THEN
    -- the gate of request_billing_push on a would-be intent (KSA account, mapped clearance product, required custom fields)
    v_i := NULL;
    v_i.id := '00000000-0000-0000-0000-000000000000'::uuid; v_i.org_id := v_t.org_id; v_i.transaction_id := v_t.id;
    v_i.client_id := v_t.client_id; v_i.origin := 'opening';
    v_block := app.daftra_push_block(v_i);
    IF v_block IS NOT NULL THEN
      v_reason := v_block ->> 'reason';
      v_det := jsonb_strip_nulls(jsonb_build_object('detail', v_block ->> 'detail', 'fields', v_block ->> 'hint'));
    END IF;
  END IF;
  IF v_reason IS NOT NULL THEN
    PERFORM app.daftra_review_open(v_t.org_id, v_t.id, NULL, 'opening_blocked',
      v_det || jsonb_build_object('reason', v_reason, 'source', p_source, 'declaration_id', v_d.id, 'at', now()));
    RETURN jsonb_build_object('status', 'blocked', 'reason', v_reason) || v_det;
  END IF;
  -- the reference = the transaction ref (legacy po_number); a cancelled opening's ref is never reused (-R<n>)
  SELECT count(*)::int + 1 INTO v_rev FROM public.billing_intents i WHERE i.transaction_id = v_t.id AND i.origin = 'opening';
  v_ref := v_t.ref || CASE WHEN v_rev > 1 THEN '-R' || v_rev ELSE '' END;
  INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose, purpose_key, currency, revision, operational_ref, origin, note, created_by)
  VALUES (v_t.org_id, v_t.id, v_t.client_id, 'final', 'F', 'SAR', v_rev, v_ref, 'opening', 'opening draft (' || p_source || ')', auth.uid())
  RETURNING * INTO v_i;
  v_job := app.bill_enqueue(v_i.org_id, 'invoice_push', v_i.id, NULL, NULL, jsonb_build_object('opening', true), auth.uid());
  UPDATE public.billing_intents i SET sync_state = 'pending' WHERE i.id = v_i.id;
  UPDATE public.billing_review_items r SET status = 'resolved', resolution = 'opening_requested', resolved_intent_id = v_i.id,
         resolved_by = auth.uid(), resolved_at = now()
   WHERE r.transaction_id = v_t.id AND r.kind = 'opening_blocked' AND r.status = 'open';
  PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'opening_requested', 'billing_intent', v_i.id,
    jsonb_build_object('source', p_source, 'job_id', v_job -> 'id', 'declaration_id', v_d.id));
  RETURN jsonb_build_object('status', 'queued', 'intent_id', v_i.id, 'job', v_job);
END $$;

-- declaration added / corrected / moved (approve_declaration_extraction, add_declaration, correct_declaration,
-- set_declaration_status): a DEFERRED constraint trigger, so it runs at commit, after the approval wrote the containers and
-- the items the custom fields need. Only for user requests (JWT claims), only when the org setting is on; any failure is kept
-- as an 'opening_blocked' item and never undoes the approval. Review: a deadlock / serialization failure of the Daftra-only
-- work is NOT re-raised either (the sub-transaction already rolled the partial work back): it becomes an 'opening_blocked'
-- item (reason 'error', code 'busy') that retry_daftra_opening clears; if even that item cannot be written, nothing is kept.
CREATE OR REPLACE FUNCTION app.tg_daftra_opening() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_state text; v_msg text;
BEGIN
  IF NEW.status IN ('cancelled','replaced') OR NOT app.auto_lifecycle_on() THEN RETURN NULL; END IF;
  IF NOT coalesce((SELECT c.auto_draft_on_declaration FROM public.daftra_connections c WHERE c.org_id = NEW.org_id), false) THEN RETURN NULL; END IF;
  BEGIN
    PERFORM app.daftra_opening_try(NEW.transaction_id, 'declaration');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      PERFORM app.daftra_review_open(NEW.org_id, NEW.transaction_id, NULL, 'opening_blocked',
        jsonb_build_object('reason', 'error', 'code', CASE WHEN v_state IN ('40P01','40001','55P03') THEN 'busy' ELSE left(app.bill_scrub_text(v_msg), 60) END,
                           'source', 'declaration', 'declaration_id', NEW.id, 'at', now()));
    EXCEPTION WHEN OTHERS THEN
      NULL;     -- review: the declaration approval is never undone by Daftra (the opening can be requested again by hand)
    END;
  END;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_daftra_opening ON public.customs_declarations;
CREATE CONSTRAINT TRIGGER trg_daftra_opening AFTER INSERT OR UPDATE ON public.customs_declarations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.tg_daftra_opening();

-- JSON of a run / a candidate
CREATE OR REPLACE FUNCTION app.daftra_run_json(r public.daftra_runs) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(r) || jsonb_build_object(
    'job', (SELECT jsonb_build_object('id', j.id, 'status', j.status, 'attempts', j.attempts, 'last_error_code', j.last_error_code)
              FROM public.billing_sync_jobs j WHERE j.run_id = r.id ORDER BY j.created_at DESC, j.id DESC LIMIT 1),
    'row_counts', CASE WHEN r.kind IN ('client_import','client_file') THEN
      (SELECT jsonb_object_agg(x.a, x.n) FROM (SELECT w.proposed_action || ':' || w.status a, count(*)::int n
                                                 FROM public.daftra_client_import_rows w WHERE w.run_id = r.id GROUP BY 1) x) END)
$$;
CREATE OR REPLACE FUNCTION app.daftra_candidate_json(c public.daftra_invoice_candidates) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(c) || jsonb_build_object(
    'transaction_ref', (SELECT t.ref FROM public.transactions t WHERE t.id = c.transaction_id),
    'branch_id', (SELECT t.branch_id FROM public.transactions t WHERE t.id = c.transaction_id))
$$;

-- container set / B/L / declaration of a transaction (the composite match keys)
CREATE OR REPLACE FUNCTION app.daftra_tx_keys(p_tx uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'declaration_nos', coalesce((SELECT jsonb_agg(DISTINCT d.declaration_no) FROM public.customs_declarations d
                                   WHERE d.transaction_id = t.id AND d.status NOT IN ('cancelled','replaced')), '[]'::jsonb),
    'bl_numbers', coalesce((SELECT jsonb_agg(DISTINCT x.b) FROM (SELECT bl.bl_number b FROM public.transaction_bls tb JOIN public.bills_of_lading bl ON bl.id = tb.bl_id
                                                                    WHERE tb.transaction_id = t.id
                                                                   UNION SELECT t.bl_number WHERE t.bl_number IS NOT NULL) x), '[]'::jsonb),
    'containers', CASE WHEN t.cargo_unit_type = 'roro' THEN CASE WHEN t.chassis_no IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(t.chassis_no) END
                       ELSE coalesce((SELECT jsonb_agg(k.container_no ORDER BY k.container_no) FROM public.containers k WHERE k.transaction_id = t.id), '[]'::jsonb) END,
    'cargo_unit_type', t.cargo_unit_type)
    FROM public.transactions t WHERE t.id = p_tx
$$;

-- composite exact match of a Daftra invoice's fields against a transaction (legacy evaluateDaftraCompositeMatchR12110HF2_):
-- declaration number equal (letters / digits), B/L token-equivalent, the same container set (Ro-Ro: the chassis). Each part
-- reports true / false / null (missing on one side); exact = all three true.
CREATE OR REPLACE FUNCTION app.daftra_invoice_match(p_tx uuid, p_fields jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE k jsonb := app.daftra_tx_keys(p_tx); v_decl boolean; v_bl boolean; v_ctr boolean; v_rd text; v_rb text; v_rc text[]; v_tc text[];
BEGIN
  v_rd := upper(regexp_replace(app.to_western(coalesce(p_fields ->> 'declaration_no', '')), '[^A-Za-z0-9]', '', 'g'));
  v_rb := nullif(btrim(coalesce(p_fields ->> 'bl', '')), '');
  v_rc := ARRAY(SELECT DISTINCT upper(regexp_replace(x, '[^A-Za-z0-9]', '', 'g')) FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(p_fields -> 'containers') = 'array' THEN p_fields -> 'containers' ELSE '[]'::jsonb END) x
                 WHERE regexp_replace(x, '[^A-Za-z0-9]', '', 'g') <> '' ORDER BY 1);
  v_tc := ARRAY(SELECT DISTINCT upper(regexp_replace(x, '[^A-Za-z0-9]', '', 'g')) FROM jsonb_array_elements_text(k -> 'containers') x
                 WHERE regexp_replace(x, '[^A-Za-z0-9]', '', 'g') <> '' ORDER BY 1);
  v_decl := CASE WHEN v_rd = '' OR jsonb_array_length(k -> 'declaration_nos') = 0 THEN NULL
                 ELSE EXISTS (SELECT 1 FROM jsonb_array_elements_text(k -> 'declaration_nos') d
                               WHERE upper(regexp_replace(d, '[^A-Za-z0-9]', '', 'g')) = v_rd) END;
  v_bl := CASE WHEN v_rb IS NULL OR jsonb_array_length(k -> 'bl_numbers') = 0 THEN NULL
               ELSE EXISTS (SELECT 1 FROM jsonb_array_elements_text(k -> 'bl_numbers') b WHERE app.bl_equivalent(b, v_rb)) END;
  v_ctr := CASE WHEN cardinality(v_rc) = 0 OR cardinality(v_tc) = 0 THEN NULL ELSE v_rc = v_tc END;
  RETURN jsonb_build_object('declaration', v_decl, 'bl', v_bl, 'containers', v_ctr,
                            'exact', coalesce(v_decl, false) AND coalesce(v_bl, false) AND coalesce(v_ctr, false));
END $$;

-- the client check of a Daftra invoice against a transaction: ok (= the linked Daftra client), conflict (another one), unlinked
CREATE OR REPLACE FUNCTION app.daftra_client_check(p_tx uuid, p_remote_client text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN l.external_id IS NULL THEN 'unlinked' WHEN l.external_id = p_remote_client THEN 'ok' ELSE 'conflict' END
    FROM public.transactions t LEFT JOIN public.daftra_client_links l
      ON l.org_id = t.org_id AND l.client_id = t.client_id AND l.status IN ('linked','drift')
   WHERE t.id = p_tx
$$;

-- ---------------------------------------------------------------------
-- 4. re-created G5 functions (20261105000100 bodies; the step-7 changes are marked "-- L7")
-- ---------------------------------------------------------------------
-- item key: '<kind>:<service_code|none>' (G5) or 'item:<org service item code>' (L7: the 26-item service catalog of step 1)
CREATE OR REPLACE FUNCTION app.bill_check_item_key(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NOT NULL AND (p ~ '^(service|internal_service|reimbursable):[a-z][a-z0-9_]{0,39}$'
                            OR p ~ '^item:[a-z][a-z0-9_]{1,39}$')                                                -- L7
$$;

-- canonical names / tax defaults of an item key (G5-3: reimbursable → 0 % + the org's reimbursable tax code;
-- L7: item:<code> → the org service item's names, the service rate)
CREATE OR REPLACE FUNCTION app.bill_item_defaults(p_org uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind text := split_part(p_key, ':', 1); v_code text := split_part(p_key, ':', 2);
        v_ar text; v_en text; v_rate numeric; v_tax text;
BEGIN
  SELECT c.default_service_vat_rate, c.reimbursable_tax_code INTO v_rate, v_tax FROM public.daftra_connections c WHERE c.org_id = p_org;
  IF v_kind = 'item' THEN                                                                                          -- L7
    SELECT s.name_ar, s.name_en INTO v_ar, v_en FROM public.org_service_items s WHERE s.org_id = p_org AND s.code = v_code;
    RETURN jsonb_build_object('item_key', p_key, 'product_code', 'MRS-' || replace(p_key, ':', '-'), 'name_ar', coalesce(v_ar, v_code),
      'name_en', v_en, 'default_vat_rate', coalesce(v_rate, 15), 'tax_code', 'standard');
  END IF;
  IF v_code = 'none' THEN v_ar := 'خدمات أخرى'; v_en := 'Other services';
  ELSE SELECT s.label_ar, s.label_en INTO v_ar, v_en FROM public.status_labels s WHERE s.domain = 'fin_service' AND s.code = v_code;
  END IF;
  v_ar := coalesce(v_ar, v_code) || CASE v_kind WHEN 'reimbursable' THEN ' — مبلغ مسترد' WHEN 'internal_service' THEN ' — خدمة داخلية' ELSE '' END;
  v_en := coalesce(v_en, v_code) || CASE v_kind WHEN 'reimbursable' THEN ' — reimbursable' WHEN 'internal_service' THEN ' — internal service' ELSE '' END;
  RETURN jsonb_build_object('item_key', p_key, 'product_code', 'MRS-' || replace(p_key, ':', '-'), 'name_ar', v_ar, 'name_en', v_en,
    'default_vat_rate', CASE WHEN v_kind = 'reimbursable' THEN 0 ELSE coalesce(v_rate, 15) END,
    'tax_code', CASE WHEN v_kind = 'reimbursable' THEN coalesce(v_tax, 'out_of_scope') ELSE 'standard' END);
END $$;

-- add eligible approved charges (same transaction + currency, not on a live line) as pending_add lines
-- L7: the Daftra line rules of app.daftra_line_meta — the product key (item:<code> for a payment-register charge), the
--     Daftra description; a shared payment / the internal transport cost / an appointment fee without TAS is not eligible
CREATE OR REPLACE FUNCTION app.bill_add_lines(p_i public.billing_intents, p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.client_charges; v_l public.billing_intent_lines; v_out jsonb := '[]'::jsonb; v_id uuid; v_added uuid[] := '{}';
        v_meta jsonb;
BEGIN
  IF p_ids IS NOT NULL THEN
    IF cardinality(p_ids) > 200 THEN PERFORM app.fail('MRS_INVALID', 'charge_ids'); END IF;
    FOREACH v_id IN ARRAY p_ids LOOP
      SELECT * INTO v_c FROM public.client_charges c WHERE c.id = v_id AND c.transaction_id = p_i.transaction_id FOR UPDATE;
      IF v_id IS NULL OR v_c.id IS NULL OR v_c.status <> 'approved' OR v_c.currency <> p_i.currency
         OR EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.charge_id = v_id AND l.state <> 'removed')
         OR app.bill_charge_held(p_i.transaction_id, v_id)
         OR app.daftra_line_meta(v_c) ->> 'excluded' IS NOT NULL THEN                                             -- L7
        PERFORM app.fin_fail('MRS_INVALID', 'not_eligible', coalesce(v_id::text, ''));
      END IF;
    END LOOP;
  END IF;
  FOR v_c IN SELECT c.* FROM public.client_charges c
              WHERE c.transaction_id = p_i.transaction_id AND c.status = 'approved' AND c.currency = p_i.currency
                AND (p_ids IS NULL OR c.id = ANY (p_ids))
                AND NOT EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.charge_id = c.id AND l.state <> 'removed')
                AND NOT app.bill_charge_held(c.transaction_id, c.id)
              ORDER BY c.created_at, c.id FOR UPDATE LOOP
    v_meta := app.daftra_line_meta(v_c);                                                                           -- L7
    CONTINUE WHEN v_meta ->> 'excluded' IS NOT NULL;
    INSERT INTO public.billing_intent_lines (org_id, transaction_id, intent_id, charge_id, line_ref, item_key, description, quantity,
      unit_price, net_amount, vat_rate, vat_amount, total_amount, currency, kind, service_code, added_by, daftra_description)
    VALUES (p_i.org_id, p_i.transaction_id, p_i.id, v_c.id, 'MRSL-0000000000000000', v_meta ->> 'item_key',
      v_c.description, v_c.quantity, v_c.unit_price, v_c.net_amount, v_c.vat_rate, v_c.vat_amount, v_c.total_amount, v_c.currency,
      v_c.kind, v_c.service_code, auth.uid(), v_meta ->> 'description')
    RETURNING * INTO v_l;
    v_out := v_out || jsonb_build_array(app.bill_line_json(v_l));
    v_added := v_added || v_c.id;
  END LOOP;
  IF cardinality(v_added) > 0 THEN
    -- a late charge that lands on a live line is billed
    UPDATE public.billing_review_items r SET status = 'resolved', resolution = 'billed', resolved_intent_id = p_i.id,
           resolved_by = auth.uid(), resolved_at = now()
     WHERE r.charge_id = ANY (v_added) AND r.status = 'open' AND r.kind = 'late_charge';
    PERFORM app.bill_local_change(p_i.id);
  END IF;
  RETURN v_out;
END $$;

-- approved charges not on a live line (L7: + the Daftra product key, description and the exclusion reason)
CREATE OR REPLACE FUNCTION app.bill_eligible(p_tx uuid, p_cur text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(app.fin_charge_json(c) || jsonb_build_object('item_key', m ->> 'item_key',
                              'daftra_description', m -> 'description', 'daftra_block', m -> 'excluded')                -- L7
                            ORDER BY c.created_at, c.id), '[]'::jsonb)
    FROM public.client_charges c CROSS JOIN LATERAL app.daftra_line_meta(c) m
   WHERE c.transaction_id = p_tx AND c.status = 'approved' AND (p_cur IS NULL OR c.currency = p_cur)
     AND NOT EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.charge_id = c.id AND l.state <> 'removed')
     AND NOT app.bill_charge_held(c.transaction_id, c.id)
$$;

-- the connection as JSON (defaults when the org has no row yet: exists false); L7: + the KSA account check and the defaults
-- of the step-7 settings
CREATE OR REPLACE FUNCTION app.bill_conn_json(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT to_jsonb(c) || jsonb_build_object('exists', true, 'account_check', app.daftra_account_check(c))
       FROM public.daftra_connections c WHERE c.org_id = p_org),
    jsonb_build_object('id', NULL, 'org_id', p_org, 'mode', 'mock', 'status', 'not_connected', 'subdomain', NULL, 'sync_enabled', false,
      'capabilities', '{}'::jsonb, 'capabilities_checked_at', NULL, 'capabilities_source', NULL, 'last_check_at', NULL,
      'last_check_status', NULL, 'last_error_code', NULL, 'last_error_message', NULL, 'default_service_vat_rate', 15,
      'allowed_vat_rates', '[0, 15]'::jsonb, 'reimbursable_tax_code', 'out_of_scope', 'invoice_notes', NULL, 'exists', false,
      'allow_draft_update', false, 'allow_product_create', false, 'auto_draft_on_declaration', false,                -- L7
      'purchase_drafts_enabled', false, 'opening_item', 'item:customs_clearance', 'purchase_item', 'item:transportation_cost',
      'custom_field_map', '{}'::jsonb, 'account_profile', NULL,
      'account_check', jsonb_build_object('ok', true, 'reason', NULL, 'enforced', false)))
$$;

-- L7: the capabilities a push needs under the org's write policy (no draft update / no product create needed under HF5)
CREATE OR REPLACE FUNCTION app.daftra_missing_caps(c public.daftra_connections) RETURNS text[]
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(array_agg(k ORDER BY o), '{}'::text[])
    FROM unnest(app.bill_required_caps()) WITH ORDINALITY x(k, o)
   WHERE coalesce(c.capabilities -> k -> 'supported', 'false'::jsonb) <> 'true'::jsonb
     AND NOT (k = 'invoices.update_draft' AND NOT coalesce(c.allow_draft_update, false))
     AND NOT (k = 'products.create' AND NOT coalesce(c.allow_product_create, false))
$$;

-- push gate on the connection: NULL when ready, else the MRS_BAD_TRANSITION detail word (L7: policy-aware capabilities)
CREATE OR REPLACE FUNCTION app.bill_conn_block(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN c.id IS NULL OR c.status <> 'connected' OR NOT c.sync_enabled THEN 'not_connected'
              WHEN cardinality(app.daftra_missing_caps(c)) > 0 THEN 'capability' END
    FROM (SELECT 1) one LEFT JOIN public.daftra_connections c ON c.org_id = p_org
$$;

-- policy helper (RLS runs it as the caller): intent jobs by the intent's transaction, org jobs by the org
-- L7: transaction jobs (invoice_lookup) and purchase jobs by their transaction
CREATE OR REPLACE FUNCTION app.bill_can_read_job(j public.billing_sync_jobs) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN j.intent_id IS NOT NULL
              THEN EXISTS (SELECT 1 FROM public.billing_intents i
                            WHERE i.id = j.intent_id AND app.has_tx_role(i.transaction_id, app.fin_read_roles()))
              WHEN j.transaction_id IS NOT NULL THEN app.has_tx_role(j.transaction_id, app.fin_read_roles())          -- L7
              WHEN j.purchase_id IS NOT NULL
              THEN EXISTS (SELECT 1 FROM public.daftra_purchase_drafts p
                            WHERE p.id = j.purchase_id AND app.has_tx_role(p.transaction_id, app.fin_read_roles()))
              ELSE app.has_role(j.org_id, app.fin_read_roles()) END
$$;

CREATE OR REPLACE FUNCTION app.bill_job_json(j public.billing_sync_jobs) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(j) || jsonb_build_object(
    'transaction_id', coalesce(i.transaction_id, j.transaction_id, p.transaction_id), 'operational_ref', coalesce(i.operational_ref, p.reference),
    'branch_id', (SELECT t.branch_id FROM public.transactions t WHERE t.id = coalesce(i.transaction_id, j.transaction_id, p.transaction_id)),
    'last_attempt', (SELECT jsonb_build_object('id', a.id, 'attempt_no', a.attempt_no, 'outcome', a.outcome, 'worker', a.worker,
                                               'started_at', a.started_at, 'finished_at', a.finished_at, 'error', a.error)
                       FROM public.billing_sync_attempts a WHERE a.job_id = j.id ORDER BY a.attempt_no DESC LIMIT 1))
    FROM (SELECT 1) one LEFT JOIN public.billing_intents i ON i.id = j.intent_id
    LEFT JOIN public.daftra_purchase_drafts p ON p.id = j.purchase_id
$$;

-- context builders (the worker's only input); L7: + the product code fields
CREATE OR REPLACE FUNCTION app.bill_ctx_item(i public.daftra_item_links) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('link_id', i.id, 'item_key', i.item_key, 'product_code', i.product_code,
                            'external_product_id', i.external_product_id, 'name_ar', i.name_ar, 'name_en', i.name_en,
                            'default_vat_rate', i.default_vat_rate, 'tax_code', i.tax_code, 'status', i.status,
                            'remote_product_code', i.remote_product_code, 'remote_code_norm', i.remote_code_norm)       -- L7
$$;

-- the job context (contract: docs/online/G5_SPEC.md § Worker RPC contract + docs/online/LEGACY_DAFTRA_AR.md «عقد المهام»)
-- L7: connection.policy / account / custom_field_map; intent.origin / invoice_date (Riyadh) / po_number / custom_fields /
--     opening_line / client.active; lines' daftra_description / manual_in_daftra; the contexts of the new kinds
CREATE OR REPLACE FUNCTION app.bill_job_context(j public.billing_sync_jobs, p_attempt uuid, p_prev text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ctx jsonb; v_conn jsonb := app.bill_conn_json(j.org_id); v_l public.daftra_client_links; v_it public.daftra_item_links;
        v_i public.billing_intents; v_t public.transactions; v_items jsonb := '[]'::jsonb; k text; v_r public.daftra_runs;
        v_p public.daftra_purchase_drafts; v_cl public.clients; v_open jsonb; v_sl public.daftra_supplier_links; v_keys jsonb;
        v_trip public.transport_trips; v_pdesc text;
BEGIN
  v_ctx := jsonb_build_object(
    'job', jsonb_build_object('id', j.id, 'org_id', j.org_id, 'kind', j.kind, 'attempt_no', j.attempts, 'options', j.options,
                              'expected_hash', j.expected_hash, 'previous_status', p_prev),
    'attempt_id', p_attempt,
    'connection', jsonb_build_object('mode', v_conn ->> 'mode', 'status', v_conn ->> 'status', 'subdomain', v_conn -> 'subdomain',
                                     'capabilities', v_conn -> 'capabilities',
                                     'settings', jsonb_build_object('default_service_vat_rate', v_conn -> 'default_service_vat_rate',
                                                                    'allowed_vat_rates', v_conn -> 'allowed_vat_rates',
                                                                    'reimbursable_tax_code', v_conn -> 'reimbursable_tax_code',
                                                                    'invoice_notes', v_conn -> 'invoice_notes'),
                                     -- L7: what the worker must enforce before any write (and the request guard in daftra-live.js)
                                     'policy', jsonb_build_object('allow_draft_update', coalesce((v_conn ->> 'allow_draft_update')::boolean, false),
                                                                  'allow_product_create', coalesce((v_conn ->> 'allow_product_create')::boolean, false),
                                                                  'products', CASE WHEN coalesce((v_conn ->> 'allow_product_create')::boolean, false)
                                                                                   THEN 'create_missing' ELSE 'resolve_only' END),
                                     'account', v_conn -> 'account_check',
                                     'custom_field_map', coalesce(v_conn -> 'custom_field_map', '{}'::jsonb),
                                     'today', to_char(app.rpt_today(), 'YYYY-MM-DD'), 'time_zone', 'Asia/Riyadh'));
  IF j.client_link_id IS NOT NULL THEN
    SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.id = j.client_link_id;
    v_ctx := v_ctx || jsonb_build_object('client', app.bill_ctx_client(v_l));
  ELSIF j.item_link_id IS NOT NULL THEN
    SELECT * INTO v_it FROM public.daftra_item_links i WHERE i.id = j.item_link_id;
    v_ctx := v_ctx || jsonb_build_object('item', app.bill_ctx_item(v_it));
  ELSIF j.intent_id IS NOT NULL THEN
    SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = j.intent_id;
    SELECT * INTO v_t FROM public.transactions t WHERE t.id = v_i.transaction_id;
    SELECT * INTO v_cl FROM public.clients c WHERE c.id = v_i.client_id;
    v_l := app.bill_ensure_client_link(v_i.org_id, v_i.client_id);
    FOR k IN SELECT DISTINCT l.item_key FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state <> 'removed'
             UNION SELECT v_conn ->> 'opening_item' WHERE v_i.origin = 'opening' ORDER BY 1 LOOP
      v_items := v_items || jsonb_build_array(app.bill_ctx_item(app.bill_ensure_item(v_i.org_id, k)));
    END LOOP;
    IF v_i.origin = 'opening' THEN                                                                                   -- L7
      v_open := jsonb_build_object('item_key', v_conn ->> 'opening_item', 'description', '', 'quantity', 1, 'unit_price', 0,
                                   'vat_rate', coalesce((v_conn ->> 'default_service_vat_rate')::numeric, 15));
    END IF;
    v_ctx := v_ctx || jsonb_build_object('intent', jsonb_build_object(
      'id', v_i.id, 'transaction_id', v_i.transaction_id, 'transaction_ref', v_t.ref, 'operational_ref', v_i.operational_ref,
      'currency', v_i.currency, 'purpose', v_i.purpose, 'status', v_i.status, 'sync_state', v_i.sync_state,
      'external_invoice_id', v_i.external_invoice_id, 'pushed_hash', v_i.pushed_hash, 'remote_version', v_i.remote_version,
      'invoice_date', to_char(coalesce(v_i.invoice_date, app.rpt_today()), 'YYYY-MM-DD'), 'notes', v_conn -> 'invoice_notes',   -- L7: Riyadh
      'origin', v_i.origin, 'po_number', v_i.operational_ref, 'daftra_url', v_i.daftra_url,                              -- L7
      'custom_fields', app.daftra_custom_fields(v_i.transaction_id), 'opening_line', v_open,
      'client', app.bill_ctx_client(v_l) || jsonb_build_object('active', coalesce(v_cl.is_active, false)), 'items', v_items,
      'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('line_id', l.id, 'line_ref', l.line_ref, 'state', l.state, 'pushed', l.pushed,
                                                             'remote_line_id', l.remote_line_id, 'item_key', l.item_key, 'description', l.description,
                                                             'quantity', l.quantity, 'unit_price', l.unit_price, 'vat_rate', l.vat_rate,
                                                             'net_amount', l.net_amount, 'vat_amount', l.vat_amount, 'total_amount', l.total_amount,
                                                             'daftra_description', l.daftra_description, 'manual_in_daftra', l.manual_in_daftra)   -- L7
                                          ORDER BY l.line_ref)
                           FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state <> 'removed'), '[]'::jsonb)));
  ELSIF j.run_id IS NOT NULL THEN                                                                                     -- L7
    SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = j.run_id;
    v_ctx := v_ctx || jsonb_build_object('run', jsonb_build_object('id', v_r.id, 'kind', v_r.kind, 'params', v_r.params,
      'cursor', coalesce(v_r.cursor, '{}'::jsonb), 'pages_done', v_r.pages,
      'page_size', coalesce((v_r.params ->> 'page_size')::int, 100), 'pages_per_job', coalesce((v_r.params ->> 'pages_per_job')::int, 5)));
    IF v_r.kind = 'product_match' THEN
      v_ctx := v_ctx || jsonb_build_object('products', coalesce((
        SELECT jsonb_agg(jsonb_build_object('item_key', i.item_key, 'link_id', i.id, 'remote_product_code', i.remote_product_code,
                                            'remote_code_norm', i.remote_code_norm, 'name_ar', i.name_ar) ORDER BY i.item_key)
          FROM public.daftra_item_links i
         WHERE i.org_id = j.org_id AND i.status <> 'retired'
           AND (jsonb_typeof(v_r.params -> 'item_keys') IS DISTINCT FROM 'array' OR v_r.params -> 'item_keys' ? i.item_key)), '[]'::jsonb));
    END IF;
  ELSIF j.transaction_id IS NOT NULL THEN                                                                             -- L7: invoice_lookup
    SELECT * INTO v_t FROM public.transactions t WHERE t.id = j.transaction_id;
    SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.org_id = v_t.org_id AND l.client_id = v_t.client_id AND l.status <> 'unlinked';
    v_keys := app.daftra_tx_keys(v_t.id);
    v_ctx := v_ctx || jsonb_build_object('transaction', jsonb_build_object('id', v_t.id, 'ref', v_t.ref,
      'client_external_id', CASE WHEN v_l.status IN ('linked','drift') THEN v_l.external_id END,
      'declaration_nos', v_keys -> 'declaration_nos', 'bl_numbers', v_keys -> 'bl_numbers', 'containers', v_keys -> 'containers',
      'cargo_unit_type', v_keys -> 'cargo_unit_type'),
      'lookup', jsonb_build_object('mode', j.options ->> 'mode', 'number', j.options ->> 'number'));
  ELSIF j.purchase_id IS NOT NULL THEN                                                                                -- L7: purchase_push
    SELECT * INTO v_p FROM public.daftra_purchase_drafts p WHERE p.id = j.purchase_id;
    SELECT * INTO v_t FROM public.transactions t WHERE t.id = v_p.transaction_id;
    SELECT * INTO v_sl FROM public.daftra_supplier_links s WHERE s.id = v_p.supplier_link_id;
    SELECT * INTO v_it FROM public.daftra_item_links i WHERE i.org_id = v_p.org_id AND i.item_key = v_p.item_key AND i.status <> 'retired';
    -- review: the legacy line description (ensureMovementPurchaseDraftR12_): transaction | client | declaration | container |
    -- driver | appointment (TAS), the parts that exist, ≤ 900 characters
    SELECT * INTO v_trip FROM public.transport_trips r WHERE r.id = v_p.trip_id;
    v_pdesc := left(concat_ws(' | ',
      'المعاملة: ' || v_t.ref,
      'العميل: ' || (SELECT c.name_ar FROM public.clients c WHERE c.id = v_t.client_id),
      'البيان: ' || (SELECT d.declaration_no FROM public.customs_declarations d WHERE d.transaction_id = v_t.id AND d.status NOT IN ('cancelled','replaced')
                      ORDER BY d.created_at DESC, d.id DESC LIMIT 1),
      'الحاوية: ' || (SELECT k.container_no FROM public.containers k WHERE k.id = v_trip.container_id),
      'السائق: ' || (SELECT dr.full_name FROM public.drivers dr WHERE dr.id = v_trip.driver_id),
      'الموعد: ' || (SELECT app.norm_tas(pa.appointment_no) FROM public.port_appointments pa WHERE pa.id = v_trip.appointment_id)), 900);
    v_ctx := v_ctx || jsonb_build_object('purchase', jsonb_build_object('id', v_p.id, 'reference', v_p.reference, 'trip_id', v_p.trip_id,
      'transaction_id', v_p.transaction_id, 'transaction_ref', v_t.ref, 'supplier_external_id', v_sl.external_supplier_id,
      'supplier_name', v_sl.name, 'external_purchase_id', v_p.external_purchase_id, 'status', v_p.status,
      'invoice_date', to_char(coalesce(v_p.invoice_date, app.rpt_today()), 'YYYY-MM-DD'),
      'item', CASE WHEN v_it.id IS NOT NULL THEN app.bill_ctx_item(v_it) END,
      'lines', jsonb_build_array(jsonb_build_object('item_key', v_p.item_key, 'description', coalesce(nullif(v_pdesc, ''), v_t.ref), 'quantity', 1,
                                                    'unit_price', v_p.amount, 'vat_rate', 0)),
      'amount', v_p.amount, 'currency', v_p.currency, 'tax', 0));
  END IF;
  RETURN v_ctx;
END $$;

-- L7: a write job of an org whose Daftra account is not KSA is failed at the claim (nothing is handed to the worker, nothing is
-- sent): an attempt is recorded (append-only), the job → failed (account_not_ksa), the target → error
-- L7 (review): the org setting / trip state a write job still needs when it is claimed or retried (fail closed; the request
-- RPCs check the same at request time, but a job queued before the owner turned a setting OFF must not write after it):
-- NULL = may write, else purchase_disabled | trip_cancelled | party_type | supplier_link | opening_disabled.
-- A purchase draft whose Daftra id is known is only read (never re-created), so it is never blocked here.
CREATE OR REPLACE FUNCTION app.daftra_setting_block(j public.billing_sync_jobs) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.daftra_connections; v_p public.daftra_purchase_drafts; v_trip public.transport_trips; v_sl public.daftra_supplier_links;
        v_i public.billing_intents;
BEGIN
  SELECT * INTO v_c FROM public.daftra_connections c WHERE c.org_id = j.org_id;
  IF j.kind = 'purchase_push' THEN
    SELECT * INTO v_p FROM public.daftra_purchase_drafts p WHERE p.id = j.purchase_id;
    IF v_p.id IS NULL OR v_p.external_purchase_id IS NOT NULL OR v_p.status = 'cancelled' THEN RETURN NULL; END IF;
    IF NOT coalesce(v_c.purchase_drafts_enabled, false) THEN RETURN 'purchase_disabled'; END IF;
    SELECT * INTO v_trip FROM public.transport_trips r WHERE r.id = v_p.trip_id;
    IF v_trip.id IS NULL OR v_trip.status = 'cancelled' THEN RETURN 'trip_cancelled'; END IF;
    IF coalesce(v_trip.party_type, '') NOT IN ('supplier','company') THEN RETURN 'party_type'; END IF;
    SELECT * INTO v_sl FROM public.daftra_supplier_links l WHERE l.id = v_p.supplier_link_id;
    IF v_sl.status IS DISTINCT FROM 'linked' THEN RETURN 'supplier_link'; END IF;
  ELSIF j.kind = 'invoice_push' AND j.intent_id IS NOT NULL THEN
    SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = j.intent_id;
    IF v_i.origin = 'opening' AND v_i.external_invoice_id IS NULL AND NOT coalesce(v_c.auto_draft_on_declaration, false) THEN
      RETURN 'opening_disabled';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- L7 (review): «possibly applied» for a purchase draft, sticky across jobs and retries (request_daftra_purchase_draft makes a
-- new job): a purchase_push attempt of this draft ended unknown / abandoned / lease_lost, or logged a create that was (or may
-- have been) applied, and no later attempt of any of its jobs ended ok. The next attempt then starts with previous_status
-- 'unknown' (the worker refuses a second POST unless the reference lookup proves none exists).
CREATE OR REPLACE FUNCTION app.daftra_purchase_unreconciled(p_purchase uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.billing_sync_jobs j JOIN public.billing_sync_attempts a ON a.job_id = j.id
     WHERE j.purchase_id = p_purchase AND j.kind = 'purchase_push'
       AND (a.outcome IN ('unknown','abandoned','lease_lost')
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(a.calls) c
                        WHERE c ->> 'op' = 'createPurchaseDraft' AND coalesce(c ->> 'applied', 'no') IN ('yes','unknown')))
       AND NOT EXISTS (SELECT 1 FROM public.billing_sync_jobs k JOIN public.billing_sync_attempts b ON b.job_id = k.id
                        WHERE k.purchase_id = p_purchase AND k.kind = 'purchase_push' AND b.outcome = 'ok'
                          AND (b.started_at, b.id) > (a.started_at, a.id)))
$$;

CREATE OR REPLACE FUNCTION app.daftra_fail_at_claim(j public.billing_sync_jobs, p_worker text, p_code text, p_detail text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_mode text; v_err jsonb;
BEGIN
  SELECT c.mode INTO v_mode FROM public.daftra_connections c WHERE c.org_id = j.org_id;
  v_err := jsonb_build_object('kind', 'validation', 'code', p_code,
                              'message', CASE WHEN p_code = 'account_not_ksa'
                                              THEN 'Daftra account is not a KSA account (SAR, Saudi Arabia, 15 % VAT): ' || coalesce(p_detail, '') || '; nothing was sent'
                                              ELSE 'the org setting or the trip no longer allows this Daftra write; nothing was sent (fields: ' || coalesce(p_detail, '') || ')' END);
  UPDATE public.billing_sync_jobs x SET attempts = x.attempts + 1 WHERE x.id = j.id RETURNING * INTO j;
  INSERT INTO public.billing_sync_attempts (org_id, job_id, attempt_no, worker, adapter_mode, finished_at, outcome, error)
  VALUES (j.org_id, j.id, j.attempts, p_worker, CASE WHEN coalesce(v_mode, 'mock') = 'mock' THEN 'mock' ELSE 'live' END,
          clock_timestamp(), 'failed', v_err);
  UPDATE public.billing_sync_jobs x SET status = 'failed', finished_at = now(), locked_by = NULL, locked_until = NULL,
         last_error_kind = 'validation', last_error_code = p_code, last_error_message = v_err ->> 'message'
   WHERE x.id = j.id;
  IF j.intent_id IS NOT NULL THEN
    UPDATE public.billing_intents i SET sync_state = CASE WHEN app.bill_job_unreconciled(j.id) THEN 'unknown' ELSE 'error' END,
           last_error_code = p_code, last_error_message = v_err ->> 'message'
     WHERE i.id = j.intent_id AND i.status IN ('open','draft');
  ELSIF j.purchase_id IS NOT NULL THEN
    UPDATE public.daftra_purchase_drafts p SET sync_state = CASE WHEN p.sync_state = 'unknown' OR app.daftra_purchase_unreconciled(p.id) THEN 'unknown' ELSE 'error' END,
           last_error_code = p_code, last_error_message = v_err ->> 'message'
     WHERE p.id = j.purchase_id AND p.status IN ('open','draft');
  END IF;
END $$;

-- daftra_claim_jobs(p_worker, p_limit) → [context]
--   due queued / unknown jobs, or running jobs whose lease expired (their open attempt → abandoned, treated as unknown);
--   at most one job per org per call, never an org with a live lease, never an org with sync disabled (probe excepted)
--   L7: a write job (app.daftra_write_kinds) of an org whose account is not KSA is failed here (account_not_ksa); the create
--       of an invoice / purchase draft fixes its invoice date = today in Asia/Riyadh; a purchase / run is taken without waiting
CREATE OR REPLACE FUNCTION public.daftra_claim_jobs(p_worker text, p_limit int DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_j public.billing_sync_jobs; v_orgs uuid[] := '{}'; v_out jsonb := '[]'::jsonb; v_prev text; v_att uuid; v_mode text;
        v_worker text := nullif(btrim(coalesce(p_worker, '')), ''); v_acc text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF v_worker IS NULL OR char_length(v_worker) > 80 THEN PERFORM app.fail('MRS_INVALID', 'worker'); END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN PERFORM app.fail('MRS_INVALID', 'limit'); END IF;
  FOR v_j IN SELECT j.* FROM public.billing_sync_jobs j
              WHERE (j.status IN ('queued','unknown') AND j.next_run_at <= now()) OR (j.status = 'running' AND j.locked_until < now())
              ORDER BY j.priority, j.created_at, j.id
              FOR UPDATE SKIP LOCKED LOOP
    EXIT WHEN jsonb_array_length(v_out) >= p_limit;
    CONTINUE WHEN v_j.org_id = ANY (v_orgs);
    CONTINUE WHEN v_j.kind <> 'probe'
              AND NOT coalesce((SELECT c.sync_enabled FROM public.daftra_connections c WHERE c.org_id = v_j.org_id), false);
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.billing_sync_jobs o
                           WHERE o.org_id = v_j.org_id AND o.id <> v_j.id AND o.status = 'running' AND o.locked_until >= now());
    -- the intent row is taken without waiting (a staff RPC holding transaction → intent → job must never wait on us:
    -- the documented lock order is transaction → intent → … → job); a busy intent is simply claimed on a later run
    IF v_j.intent_id IS NOT NULL THEN
      PERFORM 1 FROM public.billing_intents i WHERE i.id = v_j.intent_id FOR UPDATE SKIP LOCKED;
      CONTINUE WHEN NOT FOUND;
    END IF;
    IF v_j.purchase_id IS NOT NULL THEN                                                                               -- L7
      PERFORM 1 FROM public.daftra_purchase_drafts p WHERE p.id = v_j.purchase_id FOR UPDATE SKIP LOCKED;
      CONTINUE WHEN NOT FOUND;
    END IF;
    -- one lane per org across concurrent claimers (released at commit)
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(hashtextextended('marsa.daftra.lane:' || v_j.org_id::text, 0));
    -- L7: the KSA guard, fail closed, before any write job reaches the worker
    IF v_j.kind = ANY (app.daftra_write_kinds()) THEN
      v_acc := app.daftra_account_block(v_j.org_id);
      IF v_acc IS NOT NULL THEN
        IF v_j.status = 'running' THEN
          UPDATE public.billing_sync_attempts a SET finished_at = clock_timestamp(), outcome = 'abandoned',
                 error = jsonb_build_object('kind', 'lease', 'code', 'lease_expired', 'message', 'lease expired before completion')
           WHERE a.job_id = v_j.id AND a.outcome IS NULL;
        END IF;
        PERFORM app.daftra_fail_at_claim(v_j, v_worker, 'account_not_ksa', v_acc);
        CONTINUE;
      END IF;
      -- L7 (review): the org settings (purchase drafts / opening draft) and the trip state, re-checked here (fail closed)
      v_acc := app.daftra_setting_block(v_j);
      IF v_acc IS NOT NULL THEN
        IF v_j.status = 'running' THEN
          UPDATE public.billing_sync_attempts a SET finished_at = clock_timestamp(), outcome = 'abandoned',
                 error = jsonb_build_object('kind', 'lease', 'code', 'lease_expired', 'message', 'lease expired before completion')
           WHERE a.job_id = v_j.id AND a.outcome IS NULL;
        END IF;
        PERFORM app.daftra_fail_at_claim(v_j, v_worker, 'setting_disabled', v_acc);
        CONTINUE;
      END IF;
    END IF;
    v_orgs := v_orgs || v_j.org_id;
    v_prev := v_j.status;
    IF v_j.status = 'running' THEN
      UPDATE public.billing_sync_attempts a SET finished_at = clock_timestamp(), outcome = 'abandoned',
             error = jsonb_build_object('kind', 'lease', 'code', 'lease_expired', 'message', 'lease expired before completion')
       WHERE a.job_id = v_j.id AND a.outcome IS NULL;
      v_prev := 'unknown';
    ELSIF v_j.expected_hash IS NOT NULL OR app.bill_job_unreconciled(v_j.id) THEN
      v_prev := 'unknown';      -- an earlier attempt may have written: reconcile (reference lookup) first
    ELSIF v_j.kind = 'invoice_push'
          AND EXISTS (SELECT 1 FROM public.billing_intents i WHERE i.id = v_j.intent_id AND i.sync_state = 'unknown') THEN
      v_prev := 'unknown';      -- the intent is still «possibly applied» (another job, or a late write after a lost lease)
    ELSIF v_j.kind = 'purchase_push'                                                                                    -- L7
          AND (EXISTS (SELECT 1 FROM public.daftra_purchase_drafts p WHERE p.id = v_j.purchase_id AND p.sync_state = 'unknown')
               OR app.daftra_purchase_unreconciled(v_j.purchase_id)) THEN
      v_prev := 'unknown';
    END IF;
    SELECT c.mode INTO v_mode FROM public.daftra_connections c WHERE c.org_id = v_j.org_id;
    UPDATE public.billing_sync_jobs j SET status = 'running', attempts = j.attempts + 1, locked_by = v_worker,
           locked_until = now() + interval '5 minutes', finished_at = NULL
     WHERE j.id = v_j.id RETURNING * INTO v_j;
    INSERT INTO public.billing_sync_attempts (org_id, job_id, attempt_no, worker, adapter_mode)
    VALUES (v_j.org_id, v_j.id, v_j.attempts, v_worker, CASE WHEN coalesce(v_mode, 'mock') = 'mock' THEN 'mock' ELSE 'live' END)
    RETURNING id INTO v_att;
    IF v_j.kind = 'invoice_push' THEN
      UPDATE public.billing_intents i SET sync_state = 'in_flight',
             invoice_date = CASE WHEN i.external_invoice_id IS NULL THEN app.rpt_today() ELSE i.invoice_date END        -- L7
       WHERE i.id = v_j.intent_id AND i.status IN ('open','draft');
    ELSIF v_j.kind = 'purchase_push' THEN                                                                               -- L7
      UPDATE public.daftra_purchase_drafts p SET sync_state = 'in_flight',
             invoice_date = CASE WHEN p.external_purchase_id IS NULL THEN app.rpt_today() ELSE p.invoice_date END
       WHERE p.id = v_j.purchase_id AND p.status IN ('open','draft','failed');
    ELSIF v_j.run_id IS NOT NULL THEN
      UPDATE public.daftra_runs r SET status = 'running' WHERE r.id = v_j.run_id AND r.status = 'queued';
    END IF;
    v_out := v_out || jsonb_build_array(app.bill_job_context(v_j, v_att, v_prev));
  END LOOP;
  RETURN v_out;
END $$;

-- ---------------------------------------------------------------------
-- completion (worker results) — re-created G5 bodies + the new kinds
-- ---------------------------------------------------------------------
-- §10 frozen: the remote invoice is issued → intent issued, its lines frozen, charges invoiced, late / mismatch review items
-- L7 (HF5): a line the accountant added by hand (manual_in_daftra, confirmed by a finance user) counts as on the invoice; with
--     allow_draft_update FALSE the hand edits were expected, so the mismatch check compares the official total with the lines
CREATE OR REPLACE FUNCTION app.bill_mark_issued(p_i public.billing_intents, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_snap jsonb := p_eff -> 'remote_snapshot'; v_refs text[]; v_inv uuid[] := '{}'; v_late uuid[] := '{}'; v_l public.billing_intent_lines;
        v_hash text := p_eff ->> 'remote_hash'; v_held jsonb; v_det jsonb; v_hf5 boolean := NOT app.daftra_allow_update(p_i.org_id);
        v_tot numeric[] := app.bill_totals(p_eff -> 'remote_totals'); v_lines numeric;
        v_man public.billing_review_items; v_hand uuid[] := '{}'; v_exp numeric; v_as_listed boolean := false;
BEGIN
  v_refs := ARRAY(SELECT x ->> 'line_ref' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_snap -> 'lines') = 'array' THEN v_snap -> 'lines' ELSE '[]'::jsonb END) x
                   WHERE jsonb_typeof(x) = 'object' AND x ->> 'line_ref' IS NOT NULL);
  -- review (HF5): the lines an OPEN manual_in_daftra item asked the accountant to add / remove by hand carry no [MRSL-] marker
  -- on the issued invoice. When the official total equals the synced lines + the listed additions, the hand edit is taken as
  -- done (the additions are invoiced, the removals removed; item resolved 'issued_as_listed'). Otherwise they are HELD: not
  -- removed, no late_charge, the item stays open (details.issued) and a human decides (done_in_daftra → invoiced; dismiss →
  -- not billed: removed + late_charge); the totals mismatch item is raised as before.
  IF v_hf5 AND p_i.origin <> 'linked' THEN
    SELECT * INTO v_man FROM public.billing_review_items r WHERE r.intent_id = p_i.id AND r.kind = 'manual_in_daftra' AND r.status = 'open' FOR UPDATE;
    IF v_man.id IS NOT NULL THEN
      v_hand := ARRAY(SELECT (x ->> 'line_id')::uuid FROM jsonb_array_elements(coalesce(v_man.details -> 'add', '[]'::jsonb) || coalesce(v_man.details -> 'remove', '[]'::jsonb)) x
                       WHERE x ->> 'line_id' ~ '^[0-9a-f-]{36}$');
      SELECT coalesce(sum(l.total_amount) FILTER (WHERE l.state = 'synced' OR (l.state = 'pending_add' AND l.id = ANY (v_hand))), 0) INTO v_exp
        FROM public.billing_intent_lines l WHERE l.intent_id = p_i.id AND NOT (l.line_ref = ANY (v_refs) AND l.state = 'pending_remove');
      v_as_listed := v_tot[3] IS NOT NULL AND v_tot[3] = v_exp;
    END IF;
  END IF;
  FOR v_l IN SELECT * FROM public.billing_intent_lines l WHERE l.intent_id = p_i.id AND l.state <> 'removed' ORDER BY l.id FOR UPDATE LOOP
    IF v_l.line_ref = ANY (v_refs) OR (v_l.manual_in_daftra AND v_l.state = 'synced') THEN                         -- L7
      UPDATE public.billing_intent_lines l SET state = 'synced', pushed = true WHERE l.id = v_l.id AND (l.state <> 'synced' OR NOT l.pushed);
      v_inv := v_inv || v_l.charge_id;
    ELSIF v_l.id = ANY (v_hand) AND v_l.state IN ('pending_add','pending_remove') THEN                               -- review
      IF v_as_listed AND v_l.state = 'pending_add' THEN
        UPDATE public.billing_intent_lines l SET state = 'synced', manual_in_daftra = true, pushed = true WHERE l.id = v_l.id;
        v_inv := v_inv || v_l.charge_id;
      ELSIF v_as_listed THEN
        UPDATE public.billing_intent_lines l SET state = 'removed', removed_at = now(), removed_reason = coalesce(v_l.removed_reason, 'removed_in_daftra')
         WHERE l.id = v_l.id;
      END IF;                                                                     -- else held for the open manual_in_daftra item
    ELSE
      UPDATE public.billing_intent_lines l SET state = 'removed', removed_at = now(),
             removed_reason = CASE WHEN v_l.state = 'pending_remove' THEN coalesce(v_l.removed_reason, 'not_on_issued') ELSE 'not_on_issued' END
       WHERE l.id = v_l.id;
      IF v_l.state <> 'pending_remove' THEN v_late := v_late || v_l.charge_id; END IF;
    END IF;
  END LOOP;
  PERFORM app.bill_set_charges(v_inv, 'invoiced');
  INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, charge_id, kind, details)
  SELECT p_i.org_id, p_i.transaction_id, p_i.id, c, 'late_charge', jsonb_build_object('reason', 'not_on_issued') FROM unnest(v_late) c
  ON CONFLICT (charge_id, kind) WHERE status = 'open' DO NOTHING;
  -- backstop: a line Marsa already removed locally whose line_ref is on the issued invoice (its charge is held, never
  -- billed twice, until a human resolves the mismatch)
  SELECT coalesce(jsonb_agg(jsonb_build_object('line_ref', l.line_ref, 'line_id', l.id, 'charge_id', l.charge_id) ORDER BY l.line_ref), '[]'::jsonb)
    INTO v_held
    FROM public.billing_intent_lines l
   WHERE l.intent_id = p_i.id AND l.state = 'removed' AND l.line_ref = ANY (v_refs)
     AND NOT EXISTS (SELECT 1 FROM public.billing_intent_lines o WHERE o.charge_id = l.charge_id AND o.state <> 'removed');
  SELECT coalesce(sum(l.total_amount), 0) INTO v_lines FROM public.billing_intent_lines l WHERE l.intent_id = p_i.id AND l.state = 'synced';
  IF (NOT v_hf5 AND p_i.pushed_hash IS NOT NULL AND v_hash IS DISTINCT FROM p_i.pushed_hash)
     OR (v_hf5 AND p_i.origin <> 'linked' AND v_tot[3] IS NOT NULL AND v_tot[3] <> v_lines)                              -- L7
     OR jsonb_array_length(v_held) > 0 THEN
    -- the same redaction and bounds as the conflict path (bill_apply_conflict); an oversize snapshot / diff is dropped
    v_det := jsonb_build_object('diff', app.bill_diff_cap(p_eff -> 'diff'), 'pushed_hash', p_i.pushed_hash, 'remote_hash', v_hash,
                                'remote_snapshot', app.bill_redact(CASE WHEN jsonb_typeof(v_snap) = 'object' THEN v_snap END),
                                'removed_on_remote', v_held);
    IF jsonb_array_length(v_held) = 0 THEN v_det := v_det - 'removed_on_remote'; END IF;
    IF v_hf5 THEN v_det := v_det || jsonb_build_object('reason', 'totals', 'remote_total', v_tot[3], 'lines_total', v_lines); END IF;   -- L7
    v_det := app.bill_bound_details(v_det);
    INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, kind, details)
    VALUES (p_i.org_id, p_i.transaction_id, p_i.id, 'issued_mismatch', v_det)
    ON CONFLICT (intent_id, kind) WHERE status = 'open' AND charge_id IS NULL DO NOTHING;
  END IF;
  UPDATE public.billing_intents i SET status = 'issued', issued_at = coalesce(i.issued_at, now()), sync_state = 'synced', conflict = NULL
   WHERE i.id = p_i.id;
  -- L7: nothing is left to change by hand on an issued invoice (Daftra is the truth; late charges are their own items).
  -- review: an item whose listed lines are held stays open (issued: true) for the human decision
  IF v_man.id IS NOT NULL AND NOT v_as_listed AND cardinality(v_hand) > 0
     AND EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.id = ANY (v_hand) AND l.state IN ('pending_add','pending_remove')) THEN
    UPDATE public.billing_review_items r SET details = r.details || jsonb_build_object('issued', true, 'issued_total', v_tot[3], 'expected_total', v_exp)
     WHERE r.id = v_man.id;
  ELSE
    UPDATE public.billing_review_items r SET status = 'resolved', resolution = CASE WHEN v_as_listed THEN 'issued_as_listed' ELSE 'issued' END,
           resolved_at = now()
     WHERE r.intent_id = p_i.id AND r.kind = 'manual_in_daftra' AND r.status = 'open';
  END IF;
  PERFORM app.bill_event(p_i.org_id, p_i.transaction_id, 'issued', 'billing_intent', p_i.id,
    jsonb_build_object('charge_ids', to_jsonb(v_inv), 'late_charge_ids', CASE WHEN cardinality(v_late) > 0 THEN to_jsonb(v_late) END));
END $$;

-- L7: the client Daftra reports for an invoice ≠ the transaction's linked Daftra client → one client_mismatch review item
CREATE OR REPLACE FUNCTION app.daftra_check_client(p_i public.billing_intents, p_remote text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_link text;
BEGIN
  IF p_remote IS NULL THEN RETURN; END IF;
  SELECT l.external_id INTO v_link FROM public.daftra_client_links l
   WHERE l.org_id = p_i.org_id AND l.client_id = p_i.client_id AND l.status IN ('linked','drift');
  IF v_link IS NOT NULL AND v_link <> p_remote THEN
    PERFORM app.daftra_review_open(p_i.org_id, p_i.transaction_id, p_i.id, 'client_mismatch',
      jsonb_build_object('remote_client_id', p_remote, 'linked_client_id', v_link, 'daftra_number', p_i.daftra_number));
  END IF;
END $$;

-- invoice_pull effects (also a push outcome 'frozen')
-- L7: + remote_client_id (client_mismatch check); HF5: with allow_draft_update FALSE Marsa never edits the draft, so a
--     remote edit (the accountant adding the manual_in_daftra lines by hand) is expected and is not a conflict
CREATE OR REPLACE FUNCTION app.bill_apply_pull(p_i public.billing_intents, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_ext text; v_state text; v_rh text; v_tot numeric[]; v_pay jsonb; v_ps text; v_paid numeric;
        v_pat timestamptz; v_prev_pay text := p_i.payment_status; v_push_live boolean; v_rc text;
BEGIN
  v_ext := app.bill_ext_id(app.bill_rtext(p_eff, 'external_invoice_id', 64), 'external_invoice_id');
  IF v_ext IS NOT NULL AND p_i.external_invoice_id IS NOT NULL AND v_ext <> p_i.external_invoice_id THEN
    PERFORM app.fail('MRS_INVALID', 'external_invoice_id');
  END IF;
  IF p_i.external_invoice_id IS NULL THEN
    IF v_ext IS NULL THEN PERFORM app.fail('MRS_INVALID', 'external_invoice_id'); END IF;
    PERFORM app.bill_check_invoice_free(p_i.org_id, p_i.id, v_ext);
  END IF;
  v_state := app.bill_rtext(p_eff, 'remote_state', 20);
  IF v_state IS NULL OR v_state NOT IN ('draft','issued','cancelled') THEN PERFORM app.fail('MRS_INVALID', 'remote_state'); END IF;
  v_rh := app.bill_hash(app.bill_rtext(p_eff, 'remote_hash', 64), 'remote_hash');
  v_tot := app.bill_totals(p_eff -> 'remote_totals');
  v_rc := app.bill_ext_id(app.bill_rtext(p_eff, 'remote_client_id', 64), 'remote_client_id');                         -- L7
  v_pay := p_eff -> 'payment';
  IF v_pay IS NOT NULL AND jsonb_typeof(v_pay) <> 'null' THEN
    IF jsonb_typeof(v_pay) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'payment'); END IF;
    v_ps := app.bill_rtext(v_pay, 'status', 20);
    IF v_ps IS NOT NULL AND v_ps NOT IN ('unknown','unpaid','partial','paid') THEN PERFORM app.fail('MRS_INVALID', 'payment'); END IF;
    v_paid := app.fin_money(v_pay, 'paid_amount');
    v_pat := app.bill_ts(v_pay, 'last_payment_at');
  END IF;
  UPDATE public.billing_intents i SET
    external_invoice_id = coalesce(i.external_invoice_id, v_ext),
    status = CASE WHEN i.status = 'open' AND v_state = 'draft' THEN 'draft' ELSE i.status END,
    daftra_number = coalesce(app.bill_rtext(p_eff, 'daftra_number', 60), i.daftra_number),
    daftra_status = coalesce(app.bill_rtext(p_eff, 'daftra_status', 40), i.daftra_status),
    remote_version = coalesce(app.bill_rtext(p_eff, 'remote_version', 64), i.remote_version),
    remote_hash = coalesce(v_rh, i.remote_hash),
    remote_net = coalesce(v_tot[1], i.remote_net), remote_vat = coalesce(v_tot[2], i.remote_vat), remote_total = coalesce(v_tot[3], i.remote_total),
    payment_status = coalesce(v_ps, i.payment_status), paid_amount = coalesce(v_paid, i.paid_amount),
    last_payment_at = coalesce(v_pat, i.last_payment_at),
    remote_client_id = coalesce(v_rc, i.remote_client_id),                                                              -- L7
    last_pulled_at = now(), last_synced_at = now(), last_error_code = NULL, last_error_message = NULL,
    sync_state = CASE WHEN i.sync_state = 'in_flight' THEN CASE WHEN app.bill_has_pending(i.id) THEN 'pending' ELSE 'synced' END ELSE i.sync_state END
   WHERE i.id = p_i.id RETURNING * INTO v_i;
  PERFORM app.daftra_check_client(v_i, v_rc);                                                                         -- L7
  -- while a push of this intent is pending / in flight / unknown, the pull only refreshes the mirror: the push re-reads
  -- the remote itself and decides (a lost update is not an accountant edit)
  v_push_live := v_i.sync_state IN ('unknown','in_flight')
                 OR EXISTS (SELECT 1 FROM public.billing_sync_jobs j WHERE j.intent_id = v_i.id AND j.kind = 'invoice_push'
                              AND j.status IN ('queued','unknown'));     -- 'running' = this very push (frozen path): one lane per org
  IF v_state = 'draft' THEN
    -- manual edit detected on pull too (step ٩): never fixed, a conflict for a human (L7: not under HF5 / for a linked invoice)
    IF v_i.status = 'draft' AND v_i.pushed_hash IS NOT NULL AND v_rh IS NOT NULL AND v_rh <> v_i.pushed_hash AND v_i.sync_state <> 'conflict'
       AND NOT v_push_live AND app.daftra_allow_update(v_i.org_id) AND v_i.origin <> 'linked' THEN
      PERFORM app.bill_apply_conflict(v_i, jsonb_build_object('reason', 'remote_edited', 'remote_hash', v_rh,
                                                             'diff', p_eff -> 'diff', 'remote_snapshot', p_eff -> 'remote_snapshot'));
    END IF;
  ELSIF v_state = 'issued' THEN
    IF v_i.status IN ('open','draft') THEN PERFORM app.bill_mark_issued(v_i, p_eff || jsonb_build_object('remote_hash', v_rh)); END IF;
  ELSE
    IF v_i.status = 'issued' THEN
      INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, kind, details)
      VALUES (v_i.org_id, v_i.transaction_id, v_i.id, 'issued_cancelled',
              jsonb_build_object('daftra_status', app.bill_rtext(p_eff, 'daftra_status', 40), 'daftra_number', v_i.daftra_number))
      ON CONFLICT (intent_id, kind) WHERE status = 'open' AND charge_id IS NULL DO NOTHING;
    ELSIF v_i.status IN ('open','draft') AND v_i.sync_state <> 'conflict' AND NOT v_push_live THEN
      PERFORM app.bill_apply_conflict(v_i, jsonb_build_object('reason', 'remote_missing', 'remote_hash', v_rh));
    END IF;
  END IF;
  IF v_ps = 'paid' AND v_prev_pay IS DISTINCT FROM 'paid' THEN
    PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'paid', 'billing_intent', v_i.id, '{}'::jsonb);
  END IF;
  PERFORM app.bill_tx_financial(v_i.transaction_id);
  PERFORM app.daftra_manual_refresh(v_i.id);                                                                          -- L7
END $$;

-- invoice_push ok effects
-- L7: + daftra_url; + read_back {date, client_id, total, line_count} of a created draft: the date must be the Riyadh date of
--     the claim (date_mismatch), the client the linked Daftra client and the total the lines sent (readback_mismatch)
CREATE OR REPLACE FUNCTION app.bill_apply_push_ok(p_i public.billing_intents, p_eff jsonb, p_job uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_ext text; v_state text; v_by text; v_ph text; v_rh text; v_tot numeric[]; v_url text;
        v_rb jsonb; v_rbd date; v_rbc text; v_rbt numeric; v_link text; v_diff text[] := '{}'; v_exp numeric;
BEGIN
  v_ext := app.bill_ext_id(app.bill_rtext(p_eff, 'external_invoice_id', 64), 'external_invoice_id');
  IF v_ext IS NULL THEN PERFORM app.fail('MRS_INVALID', 'external_invoice_id'); END IF;
  IF p_i.external_invoice_id IS NOT NULL AND p_i.external_invoice_id <> v_ext THEN PERFORM app.fail('MRS_INVALID', 'external_invoice_id'); END IF;
  PERFORM app.bill_check_invoice_free(p_i.org_id, p_i.id, v_ext);
  v_state := coalesce(app.bill_rtext(p_eff, 'remote_state', 20), 'draft');
  IF v_state NOT IN ('draft','issued','cancelled') THEN PERFORM app.fail('MRS_INVALID', 'remote_state'); END IF;
  IF v_state <> 'draft' THEN
    -- the read-back is no longer a draft: frozen (handled as a pull)
    PERFORM app.bill_apply_pull(p_i, p_eff || jsonb_build_object('external_invoice_id', v_ext));
    RETURN;
  END IF;
  v_by := app.bill_rtext(p_eff, 'found_by', 20);
  IF v_by IS NULL OR v_by NOT IN ('ref','created','existing') THEN PERFORM app.fail('MRS_INVALID', 'found_by'); END IF;
  v_ph := app.bill_hash(app.bill_rtext(p_eff, 'pushed_hash', 64), 'pushed_hash');
  IF v_ph IS NULL THEN PERFORM app.fail('MRS_INVALID', 'pushed_hash'); END IF;
  v_rh := app.bill_hash(app.bill_rtext(p_eff, 'remote_hash', 64), 'remote_hash');
  v_tot := app.bill_totals(p_eff -> 'remote_totals');
  v_url := app.bill_rtext(p_eff, 'daftra_url', 500);                                                                 -- L7
  IF v_url IS NOT NULL AND v_url !~ '^https://[A-Za-z0-9.-]+(/[A-Za-z0-9_./?=&%-]*)?$' THEN PERFORM app.fail('MRS_INVALID', 'daftra_url'); END IF;
  v_rb := p_eff -> 'read_back';
  IF v_rb IS NOT NULL AND jsonb_typeof(v_rb) NOT IN ('object','null') THEN PERFORM app.fail('MRS_INVALID', 'read_back'); END IF;
  UPDATE public.billing_intents i SET external_invoice_id = v_ext, status = CASE WHEN i.status = 'open' THEN 'draft' ELSE i.status END,
         daftra_number = coalesce(app.bill_rtext(p_eff, 'daftra_number', 60), i.daftra_number),
         daftra_status = coalesce(app.bill_rtext(p_eff, 'daftra_status', 40), i.daftra_status),
         remote_version = coalesce(app.bill_rtext(p_eff, 'remote_version', 64), i.remote_version),
         pushed_hash = v_ph, remote_hash = coalesce(v_rh, v_ph), pushed_at = now(), last_synced_at = now(),
         remote_net = coalesce(v_tot[1], i.remote_net), remote_vat = coalesce(v_tot[2], i.remote_vat), remote_total = coalesce(v_tot[3], i.remote_total),
         daftra_url = coalesce(v_url, i.daftra_url),                                                                   -- L7
         conflict = NULL, last_error_code = NULL, last_error_message = NULL
   WHERE i.id = p_i.id RETURNING * INTO v_i;
  PERFORM app.bill_line_results(v_i, p_eff -> 'line_results');
  UPDATE public.billing_intents i SET sync_state = CASE WHEN app.bill_has_pending(i.id) THEN 'pending' ELSE 'synced' END
   WHERE i.id = p_i.id;
  -- L7: the read-back of the draft just created (legacy assertDaftraInvoiceDateSafe_): date / client / total
  IF jsonb_typeof(v_rb) = 'object' THEN
    BEGIN v_rbd := app.bill_rtext(v_rb, 'date', 10)::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN PERFORM app.fail('MRS_INVALID', 'read_back'); END;
    v_rbc := app.bill_ext_id(app.bill_rtext(v_rb, 'client_id', 64), 'read_back');
    v_rbt := app.fin_money(v_rb, 'total');
    -- review (legacy assertDaftraInvoiceDateSafe_): a created draft whose stored date cannot be read is a date_mismatch too
    IF v_i.invoice_date IS NOT NULL AND (v_rbd IS DISTINCT FROM v_i.invoice_date) AND (v_rbd IS NOT NULL OR v_by = 'created') THEN
      PERFORM app.daftra_review_open(v_i.org_id, v_i.transaction_id, v_i.id, 'date_mismatch',
        jsonb_build_object('expected', v_i.invoice_date, 'stored', v_rbd, 'time_zone', 'Asia/Riyadh', 'daftra_number', v_i.daftra_number));
    END IF;
    SELECT l.external_id INTO v_link FROM public.daftra_client_links l
     WHERE l.org_id = v_i.org_id AND l.client_id = v_i.client_id AND l.status IN ('linked','drift');
    IF v_rbc IS NOT NULL AND v_link IS NOT NULL AND v_rbc <> v_link THEN v_diff := v_diff || 'client'::text; END IF;
    SELECT coalesce(sum(l.total_amount), 0) INTO v_exp FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state = 'synced';
    IF v_rbt IS NOT NULL AND v_by = 'created' AND v_rbt <> v_exp THEN v_diff := v_diff || 'total'::text; END IF;
    IF (v_rb ->> 'line_count') ~ '^[0-9]{1,4}$' AND v_by = 'created'
       AND (v_rb ->> 'line_count')::int <> (SELECT count(*)::int FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state = 'synced')
                                            + (CASE WHEN v_i.origin = 'opening' THEN 1 ELSE 0 END) THEN
      v_diff := v_diff || 'lines'::text;
    END IF;
    IF cardinality(v_diff) > 0 THEN
      PERFORM app.daftra_review_open(v_i.org_id, v_i.transaction_id, v_i.id, 'readback_mismatch',
        jsonb_build_object('fields', to_jsonb(v_diff), 'expected_total', v_exp, 'stored_total', v_rbt, 'expected_client_id', v_link,
                           'stored_client_id', v_rbc, 'line_count', v_rb -> 'line_count'));
    END IF;
  END IF;
  PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'draft_synced', 'billing_intent', v_i.id,
    jsonb_build_object('job_id', p_job, 'found_by', v_by, 'origin', v_i.origin));
  PERFORM app.bill_tx_financial(v_i.transaction_id);
  PERFORM app.daftra_manual_refresh(v_i.id);                                                                          -- L7
END $$;

-- probe completion: capabilities + connection status (connected on success, error on a final failure)
-- L7: + the account profile {currency, country, vat_rates (active), checked_at} the KSA guard reads
CREATE OR REPLACE FUNCTION app.bill_apply_probe(j public.billing_sync_jobs, a public.billing_sync_attempts, p_outcome text, p_eff jsonb,
  p_err jsonb, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_caps jsonb := '{}'::jsonb; k text; v jsonb; v_c public.daftra_connections; v_acc jsonb; v_prof jsonb;
BEGIN
  INSERT INTO public.daftra_connections (org_id) VALUES (j.org_id) ON CONFLICT (org_id) DO NOTHING;
  SELECT * INTO v_c FROM public.daftra_connections c WHERE c.org_id = j.org_id FOR UPDATE;
  IF p_outcome = 'ok' THEN
    IF jsonb_typeof(p_eff -> 'capabilities') IS DISTINCT FROM 'object' THEN PERFORM app.fail('MRS_INVALID', 'capabilities'); END IF;
    FOR k, v IN SELECT e.key, e.value FROM jsonb_each(p_eff -> 'capabilities') e LOOP
      IF NOT (k = ANY (app.bill_capability_keys())) OR jsonb_typeof(v) <> 'object' OR jsonb_typeof(v -> 'supported') <> 'boolean'
         OR jsonb_typeof(v -> 'evidence') NOT IN ('string','null') OR char_length(v ->> 'evidence') > 300 THEN
        PERFORM app.fail('MRS_INVALID', 'capabilities');
      END IF;
      v_caps := v_caps || jsonb_build_object(k, jsonb_build_object('supported', v -> 'supported',
                                                                   'evidence', to_jsonb(app.bill_scrub_text(v ->> 'evidence')), 'checked_at', now()));
    END LOOP;
    -- L7: the account profile (only these keys are kept; the account name, subdomain and counts are not stored)
    v_acc := p_eff -> 'account';
    IF v_acc IS NOT NULL AND jsonb_typeof(v_acc) = 'object' THEN
      IF jsonb_typeof(v_acc -> 'currency') IN ('object','array') OR jsonb_typeof(v_acc -> 'country') IN ('object','array')
         OR char_length(v_acc ->> 'currency') > 10 OR char_length(v_acc ->> 'country') > 80 THEN
        PERFORM app.fail('MRS_INVALID', 'account');
      END IF;
      v_prof := jsonb_strip_nulls(jsonb_build_object('currency', upper(nullif(btrim(coalesce(v_acc ->> 'currency', '')), '')),
        'country', nullif(btrim(coalesce(v_acc ->> 'country', '')), ''), 'checked_at', now(),
        'vat_rates', CASE WHEN jsonb_typeof(v_acc -> 'taxes') = 'array' THEN coalesce((
            SELECT jsonb_agg(DISTINCT (t ->> 'value')::numeric ORDER BY (t ->> 'value')::numeric) FROM jsonb_array_elements(v_acc -> 'taxes') t
             WHERE jsonb_typeof(t) = 'object' AND (t ->> 'value') ~ '^[0-9]{1,3}(\.[0-9]{1,4})?$'
               AND coalesce(t ->> 'active', t ->> 'is_active', '1') IN ('1','true')), '[]'::jsonb) END));
    END IF;
    IF (v_c.mode = 'mock') IS DISTINCT FROM (a.adapter_mode = 'mock') THEN RETURN; END IF;   -- mode changed meanwhile: stale result
    -- review: the target changed after this probe started (another subdomain / mode), or the probe answered for another
    -- account than the one configured now: stale, nothing is stamped
    IF v_c.target_changed_at IS NOT NULL AND a.started_at < v_c.target_changed_at THEN RETURN; END IF;
    IF v_c.mode <> 'mock' AND v_c.subdomain IS NOT NULL AND nullif(btrim(coalesce(v_acc ->> 'subdomain', '')), '') IS NOT NULL
       AND split_part(lower(regexp_replace(btrim(v_acc ->> 'subdomain'), '^https?://', '')), '.', 1) <> lower(v_c.subdomain) THEN
      RETURN;
    END IF;
    UPDATE public.daftra_connections c SET capabilities = v_caps, capabilities_checked_at = now(), capabilities_source = a.adapter_mode,
           last_check_at = now(), last_check_status = 'ok', last_error_code = NULL, last_error_message = NULL, status = 'connected',
           account_profile = v_prof, account_checked_at = now()                                                       -- L7
     WHERE c.id = v_c.id;
  ELSE
    UPDATE public.daftra_connections c SET last_check_at = now(), last_check_status = 'failed',
           last_error_code = left(coalesce(p_err ->> 'code', p_err ->> 'kind', p_outcome), 60), last_error_message = p_err ->> 'message',
           status = CASE WHEN p_final OR p_outcome = 'conflict' THEN 'error' ELSE c.status END
     WHERE c.id = v_c.id;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- L7 completion of the new kinds
-- ---------------------------------------------------------------------
-- an invoice description from a worker result (the candidate shape shared by invoice_lookup / legacy_scan)
CREATE OR REPLACE FUNCTION app.daftra_invoice_row(x jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_d date; v_state text; v_f jsonb := '{}'::jsonb; v_c jsonb;
BEGIN
  IF jsonb_typeof(x) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'invoices'); END IF;
  v_state := app.bill_rtext(x, 'remote_state', 20);
  IF v_state IS NOT NULL AND v_state NOT IN ('draft','issued','cancelled') THEN PERFORM app.fail('MRS_INVALID', 'remote_state'); END IF;
  BEGIN v_d := app.bill_rtext(x, 'date', 10)::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN PERFORM app.fail('MRS_INVALID', 'date'); END;
  IF x ? 'fields' THEN
    IF jsonb_typeof(x -> 'fields') <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'fields'); END IF;
    v_c := x #> '{fields,containers}';
    IF v_c IS NOT NULL AND (jsonb_typeof(v_c) <> 'array' OR jsonb_array_length(v_c) > 300) THEN PERFORM app.fail('MRS_INVALID', 'fields'); END IF;
    v_f := jsonb_strip_nulls(jsonb_build_object('declaration_no', app.bill_rtext(x -> 'fields', 'declaration_no', 60),
      'bl', app.bill_rtext(x -> 'fields', 'bl', 80), 'containers', v_c));
  END IF;
  RETURN jsonb_build_object(
    'external_invoice_id', app.bill_ext_id(app.bill_rtext(x, 'external_invoice_id', 64), 'external_invoice_id'),
    'daftra_number', app.bill_rtext(x, 'daftra_number', 60), 'daftra_status', app.bill_rtext(x, 'daftra_status', 40),
    'remote_state', v_state, 'date', v_d, 'currency', upper(app.bill_rtext(x, 'currency', 3)), 'total', app.fin_money(x, 'total'),
    'client_id', app.bill_ext_id(app.bill_rtext(x, 'client_id', 64), 'client_id'), 'client_name', app.bill_rtext(x, 'client_name', 300),
    'po_number', app.bill_rtext(x, 'po_number', 80), 'fields', v_f);
END $$;

-- invoice_lookup ok: {transaction_id, invoices:[≤ 50]}: candidates for this transaction (a newer lookup supersedes the open ones).
-- number mode: the number matches; composite mode: the exact composite match only. A Daftra client other than the linked one =
-- blocked (hard block); more than one confirmable candidate = review (a human chooses).
CREATE OR REPLACE FUNCTION app.daftra_apply_lookup(j public.billing_sync_jobs, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x jsonb; r jsonb; v_m jsonb; v_cc text; v_src text; v_n int := 0; v_mode text := coalesce(j.options ->> 'mode', 'number');
        v_num text := upper(regexp_replace(coalesce(j.options ->> 'number', ''), '[^A-Za-z0-9]', '', 'g')); v_part jsonb := '[]'::jsonb;
BEGIN
  IF app.puuid(p_eff, 'transaction_id') IS DISTINCT FROM j.transaction_id THEN PERFORM app.fail('MRS_INVALID', 'transaction_id'); END IF;
  IF jsonb_typeof(p_eff -> 'invoices') IS DISTINCT FROM 'array' OR jsonb_array_length(p_eff -> 'invoices') > 50 THEN PERFORM app.fail('MRS_INVALID', 'invoices'); END IF;
  v_src := CASE WHEN v_mode = 'composite' THEN 'lookup_composite' ELSE 'lookup_number' END;
  UPDATE public.daftra_invoice_candidates c SET state = 'superseded'
   WHERE c.transaction_id = j.transaction_id AND c.state IN ('open','review','blocked','partial') AND c.source IN ('lookup_number','lookup_composite');
  FOR x IN SELECT y FROM jsonb_array_elements(p_eff -> 'invoices') y LOOP
    r := app.daftra_invoice_row(x);
    CONTINUE WHEN r ->> 'external_invoice_id' IS NULL;
    -- an invoice already behind an intent of the org is never offered again
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.billing_intents i WHERE i.org_id = j.org_id AND i.external_invoice_id = r ->> 'external_invoice_id');
    v_m := app.daftra_invoice_match(j.transaction_id, r -> 'fields');
    IF v_mode = 'composite' THEN
      -- review (legacy findCompositeDaftraInvoiceForTransactionR12112_): two of the three keys equal = a partial hint (≤ 3,
      -- kept as 'partial' candidates showing what differs; never linkable — staff link by number)
      IF NOT (v_m ->> 'exact')::boolean THEN
        IF (CASE WHEN (v_m ->> 'declaration')::boolean THEN 1 ELSE 0 END + CASE WHEN (v_m ->> 'bl')::boolean THEN 1 ELSE 0 END
            + CASE WHEN (v_m ->> 'containers')::boolean THEN 1 ELSE 0 END) >= 2 THEN
          v_part := v_part || jsonb_build_array(jsonb_build_object('r', r, 'm', v_m));
        END IF;
        CONTINUE;
      END IF;
    ELSE
      CONTINUE WHEN v_num = '' OR upper(regexp_replace(coalesce(r ->> 'daftra_number', ''), '[^A-Za-z0-9]', '', 'g')) <> v_num;
    END IF;
    v_cc := app.daftra_client_check(j.transaction_id, r ->> 'client_id');
    INSERT INTO public.daftra_invoice_candidates (org_id, transaction_id, job_id, source, external_invoice_id, daftra_number, daftra_status,
      remote_state, invoice_date, currency, total, remote_client_id, client_name, po_number, fields, match, client_check, state)
    VALUES (j.org_id, j.transaction_id, j.id, v_src, r ->> 'external_invoice_id', r ->> 'daftra_number', r ->> 'daftra_status',
      r ->> 'remote_state', (r ->> 'date')::date, r ->> 'currency', (r ->> 'total')::numeric, r ->> 'client_id', r ->> 'client_name',
      r ->> 'po_number', r -> 'fields', v_m, v_cc, CASE WHEN v_cc = 'conflict' THEN 'blocked' ELSE 'open' END)
    ON CONFLICT (org_id, coalesce(transaction_id, '00000000-0000-0000-0000-000000000000'::uuid), external_invoice_id)
      WHERE state IN ('open','review','blocked') DO NOTHING;
  END LOOP;
  -- the partial hints (only when no exact match was found)
  IF NOT EXISTS (SELECT 1 FROM public.daftra_invoice_candidates c WHERE c.job_id = j.id) THEN
    FOR x IN SELECT y FROM jsonb_array_elements(v_part) WITH ORDINALITY q(y, o) WHERE o <= 3 LOOP
      r := x -> 'r';
      INSERT INTO public.daftra_invoice_candidates (org_id, transaction_id, job_id, source, external_invoice_id, daftra_number, daftra_status,
        remote_state, invoice_date, currency, total, remote_client_id, client_name, po_number, fields, match, client_check, state)
      VALUES (j.org_id, j.transaction_id, j.id, v_src, r ->> 'external_invoice_id', r ->> 'daftra_number', r ->> 'daftra_status',
        r ->> 'remote_state', (r ->> 'date')::date, r ->> 'currency', (r ->> 'total')::numeric, r ->> 'client_id', r ->> 'client_name',
        r ->> 'po_number', r -> 'fields', x -> 'm', app.daftra_client_check(j.transaction_id, r ->> 'client_id'), 'partial');
    END LOOP;
  END IF;
  SELECT count(*)::int INTO v_n FROM public.daftra_invoice_candidates c WHERE c.transaction_id = j.transaction_id AND c.job_id = j.id AND c.state = 'open';
  IF v_n > 1 THEN
    UPDATE public.daftra_invoice_candidates c SET state = 'review' WHERE c.transaction_id = j.transaction_id AND c.job_id = j.id AND c.state = 'open';
  END IF;
  PERFORM app.bill_event(j.org_id, j.transaction_id, 'invoice_lookup', 'billing_sync_job', j.id,
    jsonb_build_object('mode', v_mode, 'candidates', (SELECT count(*) FROM public.daftra_invoice_candidates c WHERE c.job_id = j.id)));
END $$;

-- legacy_scan ok: {run_id, invoices:[≤ 500], next_cursor|null}: each invoice is matched (exact composite) against the org's
-- transactions; exactly one transaction → a candidate (open / blocked), several → review candidates; nothing is linked
-- without a human. A next cursor queues the next batch (resumable); the end marks the run done.
CREATE OR REPLACE FUNCTION app.daftra_apply_scan(j public.billing_sync_jobs, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x jsonb; r jsonb; v_r public.daftra_runs; v_txs uuid[]; t uuid; v_m jsonb; v_cc text; v_seen int := 0; v_found int := 0;
        v_next jsonb := p_eff -> 'next_cursor'; v_dn text;
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

-- the proposed action of one client row (legacy mergeDaftraClientsIntoDirectory_ + seedCustomerDirectorySafely_):
-- the Daftra id already linked → update_link; the client number = a client's daftra_client_code → link; the normalised
-- Arabic name of exactly one client → review_name (a human confirms); id and code on two different clients → conflict;
-- no name → invalid; otherwise create
CREATE OR REPLACE FUNCTION app.daftra_import_propose(p_org uuid, p_ext text, p_code text, p_name text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_by_id uuid; v_by_code uuid; v_by_name uuid[]; v_norm text := app.norm_name(p_name);
BEGIN
  IF v_norm IS NULL THEN RETURN jsonb_build_object('action', 'invalid', 'reason', 'name'); END IF;
  IF p_ext IS NOT NULL THEN
    SELECT l.client_id INTO v_by_id FROM public.daftra_client_links l WHERE l.org_id = p_org AND l.external_id = p_ext AND l.status <> 'unlinked';
  END IF;
  IF p_code IS NOT NULL THEN
    SELECT c.id INTO v_by_code FROM public.clients c WHERE c.org_id = p_org AND upper(c.daftra_client_code) = upper(p_code);
  END IF;
  IF v_by_id IS NOT NULL AND v_by_code IS NOT NULL AND v_by_id <> v_by_code THEN
    RETURN jsonb_build_object('action', 'conflict', 'reason', 'id_and_code_on_two_clients', 'client_id', v_by_id, 'other_client_id', v_by_code);
  END IF;
  IF v_by_id IS NOT NULL THEN RETURN jsonb_build_object('action', 'update_link', 'reason', 'daftra_id', 'client_id', v_by_id); END IF;
  IF v_by_code IS NOT NULL THEN
    IF p_ext IS NOT NULL AND EXISTS (SELECT 1 FROM public.daftra_client_links l WHERE l.org_id = p_org AND l.client_id = v_by_code
                                        AND l.status <> 'unlinked' AND l.external_id IS NOT NULL AND l.external_id <> p_ext) THEN
      RETURN jsonb_build_object('action', 'conflict', 'reason', 'client_linked_elsewhere', 'client_id', v_by_code);
    END IF;
    RETURN jsonb_build_object('action', 'link', 'reason', 'client_number', 'client_id', v_by_code);
  END IF;
  v_by_name := ARRAY(SELECT c.id FROM public.clients c WHERE c.org_id = p_org AND app.norm_name(c.name_ar) = v_norm ORDER BY c.created_at LIMIT 2);
  IF cardinality(v_by_name) > 1 THEN RETURN jsonb_build_object('action', 'conflict', 'reason', 'name_on_several_clients', 'client_id', v_by_name[1]); END IF;
  IF cardinality(v_by_name) = 1 THEN RETURN jsonb_build_object('action', 'review_name', 'reason', 'arabic_name', 'client_id', v_by_name[1]); END IF;
  RETURN jsonb_build_object('action', 'create', 'reason', 'new');
END $$;

-- stage one client row of a run (Daftra page or the tenant file): bounded, normalised, proposal attached
CREATE OR REPLACE FUNCTION app.daftra_import_stage(p_run public.daftra_runs, p_seq int, p_source text, x jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ext text; v_code text; v_name text; v_prop jsonb; v_cat text;
BEGIN
  IF jsonb_typeof(x) <> 'object' THEN PERFORM app.fail('MRS_DAFTRA_IMPORT', 'row'); END IF;
  v_ext := app.bill_ext_id(app.bill_rtext(x, 'external_id', 64), 'external_id');
  v_code := app.bill_rtext(x, 'client_number', 40);
  v_name := app.bill_rtext(x, 'name', 160);
  v_cat := app.bill_rtext(x, 'port_category', 20);
  IF v_cat IS NOT NULL AND v_cat NOT IN ('airport','port','shared') THEN v_cat := NULL; END IF;
  v_prop := app.daftra_import_propose(p_run.org_id, v_ext, v_code, v_name);
  IF p_source = 'daftra' AND v_ext IS NULL THEN v_prop := jsonb_build_object('action', 'invalid', 'reason', 'external_id'); END IF;
  INSERT INTO public.daftra_client_import_rows (org_id, run_id, seq, source, external_id, client_number, name_ar, name_en, name_norm,
    vat_number, cr_number, phone, email, city, port_category, suspended, proposed_action, match_client_id, match_reason, conflict, status)
  VALUES (p_run.org_id, p_run.id, p_seq, p_source, v_ext, v_code, v_name, app.bill_rtext(x, 'name_en', 160), app.norm_name(v_name),
    app.bill_rtext(x, 'vat_number', 40), app.bill_rtext(x, 'cr_number', 40), app.bill_rtext(x, 'phone', 40), app.bill_rtext(x, 'email', 160),
    app.bill_rtext(x, 'city', 80), v_cat, coalesce(app.pbool(x, 'suspended'), false), v_prop ->> 'action',
    (v_prop ->> 'client_id')::uuid, v_prop ->> 'reason',
    CASE WHEN v_prop ->> 'action' = 'conflict' THEN v_prop END,
    CASE WHEN v_prop ->> 'action' = 'conflict' THEN 'conflict' WHEN v_prop ->> 'action' = 'invalid' THEN 'skipped' ELSE 'pending' END);
END $$;

-- client_import ok: {run_id, rows:[≤ 500], next_cursor|null}. Staged only (nothing is applied before a human: apply_daftra_client_import).
-- The end of the pages with 0 rows in the whole run aborts it (legacy: «لم يُرجع دفترة أي عميل» protects the directory).
CREATE OR REPLACE FUNCTION app.daftra_apply_client_import(j public.billing_sync_jobs, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x jsonb; v_r public.daftra_runs; v_seq int; v_next jsonb := p_eff -> 'next_cursor'; v_n int;
BEGIN
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = j.run_id FOR UPDATE;
  IF app.puuid(p_eff, 'run_id') IS DISTINCT FROM j.run_id THEN PERFORM app.fail('MRS_INVALID', 'run_id'); END IF;
  IF jsonb_typeof(p_eff -> 'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(p_eff -> 'rows') > 500 THEN PERFORM app.fail('MRS_INVALID', 'rows'); END IF;
  IF v_next IS NOT NULL AND jsonb_typeof(v_next) NOT IN ('object','null') THEN PERFORM app.fail('MRS_INVALID', 'next_cursor'); END IF;
  SELECT coalesce(max(w.seq), 0) INTO v_seq FROM public.daftra_client_import_rows w WHERE w.run_id = v_r.id;
  FOR x IN SELECT y FROM jsonb_array_elements(p_eff -> 'rows') y LOOP
    v_seq := v_seq + 1;
    PERFORM app.daftra_import_stage(v_r, v_seq, 'daftra', x);
  END LOOP;
  SELECT count(*)::int INTO v_n FROM public.daftra_client_import_rows w WHERE w.run_id = v_r.id;
  UPDATE public.daftra_runs r SET pages = r.pages + 1,
         cursor = CASE WHEN jsonb_typeof(v_next) = 'object' THEN v_next ELSE r.cursor END,
         counters = jsonb_build_object('received', v_n),
         status = CASE WHEN jsonb_typeof(v_next) = 'object' THEN 'running' WHEN v_n = 0 THEN 'aborted' ELSE 'ready' END,
         error_code = CASE WHEN jsonb_typeof(v_next) IS DISTINCT FROM 'object' AND v_n = 0 THEN 'empty_result' END,
         finished_at = CASE WHEN jsonb_typeof(v_next) = 'object' THEN NULL ELSE now() END
   WHERE r.id = v_r.id RETURNING * INTO v_r;
  IF jsonb_typeof(v_next) = 'object' THEN
    PERFORM app.daftra_enqueue(j.org_id, 'client_import', NULL, v_r.id, NULL, 'p' || v_r.pages::text, '{}'::jsonb, NULL);
  END IF;
END $$;

-- product_match ok: {run_id, products:[{item_key, candidates:[{external_product_id, code, name}] ≤ 10}], scanned}: the candidates
-- are stored on the item mappings with exact = the code equals the configured code without leading zeros; nothing is mapped
-- before a human confirms (confirm_daftra_product_mapping)
CREATE OR REPLACE FUNCTION app.daftra_apply_product_match(j public.billing_sync_jobs, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x jsonb; v_i public.daftra_item_links; v_c jsonb; v_exact int := 0; v_none int := 0; v_amb int := 0; v_n int;
BEGIN
  IF app.puuid(p_eff, 'run_id') IS DISTINCT FROM j.run_id THEN PERFORM app.fail('MRS_INVALID', 'run_id'); END IF;
  IF jsonb_typeof(p_eff -> 'products') IS DISTINCT FROM 'array' OR jsonb_array_length(p_eff -> 'products') > 500 THEN PERFORM app.fail('MRS_INVALID', 'products'); END IF;
  FOR x IN SELECT y FROM jsonb_array_elements(p_eff -> 'products') y LOOP
    IF jsonb_typeof(x) <> 'object' OR jsonb_typeof(x -> 'candidates') IS DISTINCT FROM 'array' OR jsonb_array_length(x -> 'candidates') > 10 THEN
      PERFORM app.fail('MRS_INVALID', 'products');
    END IF;
    SELECT * INTO v_i FROM public.daftra_item_links i WHERE i.org_id = j.org_id AND i.item_key = (x ->> 'item_key') AND i.status <> 'retired' FOR UPDATE;
    CONTINUE WHEN v_i.id IS NULL;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'external_product_id', app.bill_ext_id(app.bill_rtext(c, 'external_product_id', 64), 'candidates'),
             'code', app.bill_rtext(c, 'code', 40), 'name', app.bill_rtext(c, 'name', 300),
             'exact', v_i.remote_code_norm IS NOT NULL AND app.daftra_code_norm(app.bill_rtext(c, 'code', 40)) = v_i.remote_code_norm)), '[]'::jsonb)
      INTO v_c FROM jsonb_array_elements(x -> 'candidates') c;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_c) c WHERE c ->> 'external_product_id' IS NULL) THEN PERFORM app.fail('MRS_INVALID', 'candidates'); END IF;
    UPDATE public.daftra_item_links i SET candidates = v_c, match_checked_at = now(),
           last_error_code = CASE WHEN i.status = 'linked' THEN i.last_error_code
                                  WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_c) c WHERE (c ->> 'exact')::boolean) THEN 'product_not_found' END
     WHERE i.id = v_i.id;
    SELECT count(*)::int INTO v_n FROM jsonb_array_elements(v_c) c WHERE (c ->> 'exact')::boolean;
    IF v_n = 1 THEN v_exact := v_exact + 1; ELSIF v_n = 0 THEN v_none := v_none + 1; ELSE v_amb := v_amb + 1; END IF;
  END LOOP;
  UPDATE public.daftra_runs r SET status = 'done', finished_at = now(), pages = r.pages + 1,
         counters = jsonb_build_object('exact', v_exact, 'not_found', v_none, 'ambiguous', v_amb,
                                       'scanned', CASE WHEN (p_eff ->> 'scanned') ~ '^[0-9]{1,9}$' THEN (p_eff ->> 'scanned')::int END)
   WHERE r.id = j.run_id;
END $$;

-- supplier_search ok: {run_id, suppliers:[{external_supplier_id, name, supplier_number}] ≤ 50}: kept on the run (autocomplete);
-- the supplier id is stored (daftra_supplier_links) only when exactly ONE supplier has exactly the searched name (normalised)
CREATE OR REPLACE FUNCTION app.daftra_apply_supplier_search(j public.billing_sync_jobs, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_r public.daftra_runs; v_s jsonb; v_q text; v_exact jsonb; v_party uuid; v_link uuid;
BEGIN
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = j.run_id FOR UPDATE;
  IF app.puuid(p_eff, 'run_id') IS DISTINCT FROM j.run_id THEN PERFORM app.fail('MRS_INVALID', 'run_id'); END IF;
  IF jsonb_typeof(p_eff -> 'suppliers') IS DISTINCT FROM 'array' OR jsonb_array_length(p_eff -> 'suppliers') > 50 THEN PERFORM app.fail('MRS_INVALID', 'suppliers'); END IF;
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('external_supplier_id', app.bill_ext_id(app.bill_rtext(s, 'external_supplier_id', 64), 'suppliers'),
                                               'name', app.bill_rtext(s, 'name', 300), 'secondary_name', app.bill_rtext(s, 'secondary_name', 300),
                                               'supplier_number', app.bill_rtext(s, 'supplier_number', 60)))), '[]'::jsonb)
    INTO v_s FROM jsonb_array_elements(p_eff -> 'suppliers') s;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_s) s WHERE s ->> 'external_supplier_id' IS NULL OR s ->> 'name' IS NULL) THEN
    PERFORM app.fail('MRS_INVALID', 'suppliers');
  END IF;
  -- review: the name the link is for (the party's / trip's name; runs queued before the review carry q only)
  v_q := app.norm_name(coalesce(v_r.params ->> 'match_name', v_r.params ->> 'q'));
  v_party := (v_r.params ->> 'party_id')::uuid;
  -- legacy findExactDaftraSupplierR12_: the supplier name OR its secondary name equals the name (normalised)
  SELECT jsonb_agg(s) INTO v_exact FROM jsonb_array_elements(v_s) s
   WHERE app.norm_name(s ->> 'name') = v_q OR app.norm_name(s ->> 'secondary_name') = v_q;
  IF v_q IS NOT NULL AND jsonb_array_length(coalesce(v_exact, '[]'::jsonb)) = 1
     AND NOT EXISTS (SELECT 1 FROM public.daftra_supplier_links l WHERE l.org_id = j.org_id AND l.status = 'linked'
                        AND (l.external_supplier_id = v_exact -> 0 ->> 'external_supplier_id'
                             OR (v_party IS NOT NULL AND l.party_id = v_party) OR (v_party IS NULL AND l.party_id IS NULL AND l.name_norm = v_q))) THEN
    INSERT INTO public.daftra_supplier_links (org_id, party_id, name, name_norm, external_supplier_id, supplier_number, run_id, created_by)
    VALUES (j.org_id, v_party, v_exact -> 0 ->> 'name', v_q, v_exact -> 0 ->> 'external_supplier_id', v_exact -> 0 ->> 'supplier_number', v_r.id, v_r.requested_by)
    RETURNING id INTO v_link;
  END IF;
  UPDATE public.daftra_runs r SET status = 'done', finished_at = now(), pages = r.pages + 1,
         result = jsonb_build_object('suppliers', v_s, 'exact_match', jsonb_array_length(coalesce(v_exact, '[]'::jsonb)) = 1,
                                     'supplier_link_id', v_link),
         counters = jsonb_build_object('found', jsonb_array_length(v_s), 'exact', jsonb_array_length(coalesce(v_exact, '[]'::jsonb)))
   WHERE r.id = v_r.id;
END $$;

-- purchase_push: ok {purchase_id, external_purchase_id, found_by 'ref'|'created', daftra_number?, daftra_url?};
-- unknown {purchase_id, external_purchase_id?} — the id is kept as soon as it is known (no second purchase draft)
CREATE OR REPLACE FUNCTION app.daftra_apply_purchase(j public.billing_sync_jobs, p_outcome text, p_eff jsonb, p_err jsonb, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_p public.daftra_purchase_drafts; v_ext text; v_url text; v_other uuid; v_warn text[] := '{}';
BEGIN
  SELECT * INTO v_p FROM public.daftra_purchase_drafts p WHERE p.id = j.purchase_id FOR UPDATE;
  IF p_eff ? 'purchase_id' AND app.puuid(p_eff, 'purchase_id') IS DISTINCT FROM j.purchase_id THEN PERFORM app.fail('MRS_INVALID', 'purchase_id'); END IF;
  IF v_p.status = 'cancelled' THEN RETURN; END IF;
  v_ext := app.bill_ext_id(app.bill_rtext(p_eff, 'external_purchase_id', 64), 'external_purchase_id');
  IF v_ext IS NOT NULL AND v_p.external_purchase_id IS NOT NULL AND v_ext <> v_p.external_purchase_id THEN PERFORM app.fail('MRS_INVALID', 'external_purchase_id'); END IF;
  IF v_ext IS NOT NULL THEN
    SELECT p.id INTO v_other FROM public.daftra_purchase_drafts p WHERE p.org_id = j.org_id AND p.external_purchase_id = v_ext AND p.id <> v_p.id;
    IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'external_id_taken', v_other::text); END IF;
  END IF;
  v_url := app.bill_rtext(p_eff, 'daftra_url', 500);
  IF v_url IS NOT NULL AND v_url !~ '^https://[A-Za-z0-9.-]+(/[A-Za-z0-9_./?=&%-]*)?$' THEN PERFORM app.fail('MRS_INVALID', 'daftra_url'); END IF;
  IF p_outcome = 'ok' THEN
    IF v_ext IS NULL THEN PERFORM app.fail('MRS_INVALID', 'external_purchase_id'); END IF;
    IF coalesce(app.bill_rtext(p_eff, 'found_by', 20), '') NOT IN ('ref','created') THEN PERFORM app.fail('MRS_INVALID', 'found_by'); END IF;
    -- review (legacy re-read after the POST): Daftra stored a non-zero tax on a line, or the record is no longer a draft →
    -- the draft is kept (its id is known) but flagged purchase_review for a human (never fixed by Marsa: no edit)
    IF p_eff ? 'checks' AND jsonb_typeof(p_eff -> 'checks') <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'checks'); END IF;
    v_warn := ARRAY(SELECT k FROM unnest(ARRAY['tax_nonzero','not_draft','unread']) k WHERE coalesce((p_eff #>> ARRAY['checks', k]) = 'true', false));
    UPDATE public.daftra_purchase_drafts p SET external_purchase_id = v_ext, status = 'draft', sync_state = 'synced',
           daftra_number = coalesce(app.bill_rtext(p_eff, 'daftra_number', 60), p.daftra_number), daftra_url = coalesce(v_url, p.daftra_url),
           last_error_code = CASE WHEN cardinality(v_warn) > 0 THEN 'purchase_review' END,
           last_error_message = CASE WHEN cardinality(v_warn) > 0 THEN 'Daftra stored the purchase draft differently; check it in Daftra (fields: '
                                                                       || array_to_string(v_warn, ', ') || ')' END
     WHERE p.id = v_p.id;
    PERFORM app.bill_event(v_p.org_id, v_p.transaction_id, 'purchase_draft', 'daftra_purchase_draft', v_p.id,
      jsonb_strip_nulls(jsonb_build_object('job_id', j.id, 'found_by', p_eff ->> 'found_by', 'trip_id', v_p.trip_id,
                                           'checks', CASE WHEN cardinality(v_warn) > 0 THEN to_jsonb(v_warn) END)));
  ELSIF p_outcome = 'unknown' THEN
    UPDATE public.daftra_purchase_drafts p SET external_purchase_id = coalesce(p.external_purchase_id, v_ext), sync_state = 'unknown',
           last_error_code = left(coalesce(p_err ->> 'code', p_err ->> 'kind', 'unknown'), 60), last_error_message = p_err ->> 'message'
     WHERE p.id = v_p.id;
  ELSE
    UPDATE public.daftra_purchase_drafts p SET external_purchase_id = coalesce(p.external_purchase_id, v_ext),
           sync_state = CASE WHEN p_outcome <> 'conflict' AND p.external_purchase_id IS NULL AND v_ext IS NULL
                                  AND (p.sync_state = 'unknown' OR app.daftra_purchase_unreconciled(p.id)) THEN 'unknown' ELSE 'error' END,
           status = CASE WHEN p_final AND p.external_purchase_id IS NULL AND v_ext IS NULL THEN 'failed' ELSE p.status END,
           last_error_code = left(coalesce(p_err ->> 'code', p_err ->> 'kind', p_outcome), 60), last_error_message = p_err ->> 'message'
     WHERE p.id = v_p.id;
  END IF;
END $$;

-- a run job that did not end ok (retry keeps the run waiting; a final failure marks it failed)
CREATE OR REPLACE FUNCTION app.daftra_apply_run_error(j public.billing_sync_jobs, p_outcome text, p_err jsonb, p_final boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.daftra_runs r SET error_code = left(coalesce(p_err ->> 'code', p_err ->> 'kind', p_outcome), 60), error_message = left(p_err ->> 'message', 500),
         status = CASE WHEN p_final OR p_outcome IN ('failed','conflict') THEN 'failed' ELSE r.status END,
         finished_at = CASE WHEN p_final OR p_outcome IN ('failed','conflict') THEN now() ELSE r.finished_at END
   WHERE r.id = j.run_id AND r.status IN ('queued','running')
$$;

-- validated completion (raises on invalid input; the caller turns that into a failed attempt)
-- L7: + the new kinds; the logged calls of a job are checked against the write policy: an edit of an existing invoice
--     (updateDraftInvoice) under HF5, a product create without allow_product_create, or a write op in a read-only kind
--     makes the completion invalid (failed, nothing applied: the worker / request guard must never send them)
CREATE OR REPLACE FUNCTION app.bill_complete(j public.billing_sync_jobs, a public.billing_sync_attempts, p_result jsonb, p_calls jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_outcome text; v_eff jsonb; v_err jsonb; v_exp text; v_status text; v_final boolean; v_ops text[];
BEGIN
  PERFORM app.only_keys(p_result, ARRAY['outcome','error','calls','effects','expected_hash']);
  v_outcome := app.bill_rtext(p_result, 'outcome', 20);
  IF v_outcome IS NULL OR v_outcome NOT IN ('ok','retry','failed','unknown','conflict','frozen') THEN PERFORM app.fail('MRS_INVALID', 'outcome'); END IF;
  IF v_outcome = 'frozen' AND j.kind <> 'invoice_push' THEN PERFORM app.fail('MRS_INVALID', 'outcome'); END IF;
  v_eff := coalesce(p_result -> 'effects', '{}'::jsonb);
  IF jsonb_typeof(v_eff) = 'null' THEN v_eff := '{}'::jsonb; END IF;
  IF jsonb_typeof(v_eff) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'effects'); END IF;
  v_err := app.bill_error(p_result -> 'error');
  v_exp := app.bill_hash(app.bill_rtext(p_result, 'expected_hash', 64), 'expected_hash');
  -- L7: the write policy on what was actually sent (ops applied or possibly applied)
  v_ops := ARRAY(SELECT DISTINCT c ->> 'op' FROM jsonb_array_elements(coalesce(p_calls, '[]'::jsonb)) c
                  WHERE coalesce(c ->> 'applied', 'no') IN ('yes','unknown'));
  IF 'updateDraftInvoice' = ANY (v_ops) AND NOT app.daftra_allow_update(j.org_id) THEN PERFORM app.fail('MRS_INVALID', 'draft_update_disabled'); END IF;
  IF 'createProduct' = ANY (v_ops) AND NOT app.daftra_allow_create(j.org_id) THEN PERFORM app.fail('MRS_INVALID', 'product_create_disabled'); END IF;
  IF j.kind IN ('product_match','client_import','invoice_lookup','legacy_scan','supplier_search')
     AND v_ops && ARRAY['createClient','updateClient','createProduct','createDraftInvoice','updateDraftInvoice','createPurchaseDraft'] THEN
    PERFORM app.fail('MRS_INVALID', 'read_only_kind');
  END IF;
  v_status := CASE v_outcome
                WHEN 'ok' THEN 'done' WHEN 'frozen' THEN 'done' WHEN 'failed' THEN 'failed' WHEN 'conflict' THEN 'conflict'
                WHEN 'retry' THEN CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'queued' END
                ELSE CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'unknown' END END;
  -- L7: a read-only kind has nothing «possibly applied»: unknown = retry
  IF v_outcome = 'unknown' AND j.kind IN ('product_match','client_import','invoice_lookup','legacy_scan','supplier_search') THEN
    v_status := CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'queued' END;
  END IF;
  v_final := v_status IN ('failed','dead');
  CASE j.kind
    WHEN 'probe' THEN PERFORM app.bill_apply_probe(j, a, v_outcome, v_eff, v_err, v_final);
    WHEN 'item_ensure' THEN PERFORM app.bill_apply_item(j, v_outcome, v_eff, v_err, v_final);
    WHEN 'invoice_push', 'invoice_pull' THEN PERFORM app.bill_apply_intent(j, v_outcome, v_eff, v_err, v_final);
    WHEN 'invoice_lookup' THEN                                                                                         -- L7
      IF v_outcome = 'ok' THEN PERFORM app.daftra_apply_lookup(j, v_eff); END IF;
    WHEN 'legacy_scan' THEN
      IF v_outcome = 'ok' THEN PERFORM app.daftra_apply_scan(j, v_eff); ELSE PERFORM app.daftra_apply_run_error(j, v_outcome, v_err, v_final); END IF;
    WHEN 'client_import' THEN
      IF v_outcome = 'ok' THEN PERFORM app.daftra_apply_client_import(j, v_eff); ELSE PERFORM app.daftra_apply_run_error(j, v_outcome, v_err, v_final); END IF;
    WHEN 'product_match' THEN
      IF v_outcome = 'ok' THEN PERFORM app.daftra_apply_product_match(j, v_eff); ELSE PERFORM app.daftra_apply_run_error(j, v_outcome, v_err, v_final); END IF;
    WHEN 'supplier_search' THEN
      IF v_outcome = 'ok' THEN PERFORM app.daftra_apply_supplier_search(j, v_eff); ELSE PERFORM app.daftra_apply_run_error(j, v_outcome, v_err, v_final); END IF;
    WHEN 'purchase_push' THEN PERFORM app.daftra_apply_purchase(j, v_outcome, v_eff, v_err, v_final);
    ELSE PERFORM app.bill_apply_client(j, v_outcome, v_eff, v_err, v_final);
  END CASE;
  UPDATE public.billing_sync_attempts x SET finished_at = clock_timestamp(), outcome = v_outcome, calls = p_calls, error = v_err WHERE x.id = a.id;
  UPDATE public.billing_sync_jobs x SET status = v_status, locked_by = NULL, locked_until = NULL,
         next_run_at = CASE v_status WHEN 'queued' THEN now() + least(interval '30 seconds' * power(2, greatest(j.attempts - 1, 0)), interval '1 hour')
                                     WHEN 'unknown' THEN now() + interval '2 minutes' ELSE x.next_run_at END,
         finished_at = CASE WHEN v_status IN ('done','conflict','failed','dead') THEN now() END,
         expected_hash = CASE WHEN v_outcome = 'unknown' THEN coalesce(v_exp, x.expected_hash) WHEN v_outcome IN ('ok','frozen') THEN NULL ELSE x.expected_hash END,
         last_error_kind = CASE WHEN v_outcome IN ('ok','frozen') THEN NULL ELSE left(coalesce(v_err ->> 'kind', v_outcome), 60) END,
         last_error_code = CASE WHEN v_outcome IN ('ok','frozen') THEN NULL ELSE left(v_err ->> 'code', 60) END,
         last_error_message = CASE WHEN v_outcome IN ('ok','frozen') THEN NULL ELSE left(v_err ->> 'message', 500) END
   WHERE x.id = j.id;
  RETURN jsonb_build_object('job_id', j.id, 'job_status', v_status, 'applied', true, 'outcome', v_outcome);
END $$;

-- daftra_complete_job(p_attempt, p_result) → {job_id, job_status, applied}
--   lock order = the staff RPCs' order: transaction → intent → attempt → job (no inversion, no deadlock)
--   L7: a purchase job locks transaction → purchase draft first, likewise
CREATE OR REPLACE FUNCTION public.daftra_complete_job(p_attempt uuid, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_a public.billing_sync_attempts; v_j public.billing_sync_jobs; v_calls jsonb; v_res jsonb; v_err jsonb;
        v_msg text; v_det text; v_state text; v_code text; v_tx uuid; v_late text[];
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  SELECT * INTO v_a FROM public.billing_sync_attempts a WHERE a.id = p_attempt;
  IF v_a.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'attempt'); END IF;
  SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.id = v_a.job_id;
  IF v_j.intent_id IS NOT NULL THEN
    SELECT i.transaction_id INTO v_tx FROM public.billing_intents i WHERE i.id = v_j.intent_id;
    PERFORM 1 FROM public.transactions t WHERE t.id = v_tx FOR UPDATE;
    PERFORM 1 FROM public.billing_intents i WHERE i.id = v_j.intent_id FOR UPDATE;
  ELSIF v_j.purchase_id IS NOT NULL THEN                                                                              -- L7
    SELECT p.transaction_id INTO v_tx FROM public.daftra_purchase_drafts p WHERE p.id = v_j.purchase_id;
    PERFORM 1 FROM public.transactions t WHERE t.id = v_tx FOR UPDATE;
    PERFORM 1 FROM public.daftra_purchase_drafts p WHERE p.id = v_j.purchase_id FOR UPDATE;
  END IF;
  SELECT * INTO v_a FROM public.billing_sync_attempts a WHERE a.id = p_attempt FOR UPDATE;
  SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.id = v_a.job_id FOR UPDATE;
  v_calls := app.bill_calls(CASE WHEN jsonb_typeof(p_result) = 'object' THEN p_result -> 'calls' END);
  IF v_a.outcome IS NOT NULL THEN
    -- already closed (abandoned after a lease expiry): history is never rewritten. A write the late worker reports as
    -- applied (or possibly applied) marks the intent «unknown», so the next push starts with the reference lookup
    -- (a duplicate becomes an external_in_use conflict, never silent); a billing event names the ops (no bodies).
    SELECT coalesce(array_agg(DISTINCT c ->> 'op' ORDER BY c ->> 'op'), '{}') INTO v_late FROM jsonb_array_elements(v_calls) c
     WHERE c ->> 'op' IN ('createClient','updateClient','createProduct','createDraftInvoice','updateDraftInvoice','createPurchaseDraft')
       AND coalesce(c ->> 'applied', 'no') IN ('yes','unknown');
    IF cardinality(v_late) > 0 AND v_j.intent_id IS NOT NULL THEN
      UPDATE public.billing_intents i SET sync_state = 'unknown', last_error_code = 'late_write',
             last_error_message = 'a worker wrote to Daftra after losing its lease: reconcile by reference'
       WHERE i.id = v_j.intent_id AND i.status IN ('open','draft');
      PERFORM app.bill_event(v_j.org_id, v_tx, 'late_write', 'billing_sync_job', v_j.id,
                             jsonb_build_object('attempt_id', v_a.id, 'ops', to_jsonb(v_late)));
    ELSIF cardinality(v_late) > 0 AND v_j.purchase_id IS NOT NULL THEN                                                 -- L7
      UPDATE public.daftra_purchase_drafts p SET sync_state = 'unknown', last_error_code = 'late_write'
       WHERE p.id = v_j.purchase_id AND p.status IN ('open','draft','failed');
      PERFORM app.bill_event(v_j.org_id, v_tx, 'late_write', 'billing_sync_job', v_j.id,
                             jsonb_build_object('attempt_id', v_a.id, 'ops', to_jsonb(v_late)));
    END IF;
    RETURN jsonb_build_object('job_id', v_j.id, 'job_status', v_j.status, 'applied', false, 'outcome', v_a.outcome,
                              'late_writes', to_jsonb(v_late));
  END IF;
  IF v_j.status <> 'running' OR v_j.locked_by IS DISTINCT FROM v_a.worker OR v_j.attempts <> v_a.attempt_no THEN
    UPDATE public.billing_sync_attempts a SET finished_at = clock_timestamp(), outcome = 'lease_lost', calls = v_calls,
           error = jsonb_build_object('kind', 'lease', 'code', 'lease_lost', 'message', 'the job is no longer held by this attempt')
     WHERE a.id = v_a.id;
    RETURN jsonb_build_object('job_id', v_j.id, 'job_status', v_j.status, 'applied', false, 'outcome', 'lease_lost');
  END IF;
  BEGIN
    v_res := app.bill_complete(v_j, v_a, p_result, v_calls);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_det = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    -- a deadlock / serialization failure is not a validation error: re-raised (the attempt stays open; the worker's
    -- completion fails and the lease expiry turns the job «unknown», never «failed»)
    IF v_state IN ('40P01','40001') THEN RAISE; END IF;
    v_code := CASE WHEN v_msg LIKE 'MRS\_%' THEN left(v_msg, 60) ELSE 'MRS_INVALID' END;
    v_err := jsonb_build_object('kind', 'validation', 'code', v_code,
                                'message', left(app.bill_scrub_text(CASE WHEN v_msg LIKE 'MRS\_%' THEN coalesce(nullif(v_det, ''), v_msg) ELSE v_state || ' ' || v_msg END), 500));
    UPDATE public.billing_sync_attempts a SET finished_at = clock_timestamp(), outcome = 'failed', calls = v_calls, error = v_err WHERE a.id = v_a.id;
    UPDATE public.billing_sync_jobs j SET status = 'failed', finished_at = now(), locked_by = NULL, locked_until = NULL,
           last_error_kind = 'validation', last_error_code = v_code, last_error_message = v_err ->> 'message'
     WHERE j.id = v_j.id;
    IF v_j.intent_id IS NOT NULL THEN
      UPDATE public.billing_intents i SET sync_state = CASE WHEN v_j.kind = 'invoice_push' AND i.status IN ('open','draft')
                                                            THEN CASE WHEN app.bill_job_unreconciled(v_j.id) THEN 'unknown' ELSE 'error' END
                                                            ELSE i.sync_state END,
             last_error_code = v_code, last_error_message = v_err ->> 'message'
       WHERE i.id = v_j.intent_id AND i.status <> 'cancelled';
    ELSIF v_j.purchase_id IS NOT NULL THEN                                                                            -- L7
      UPDATE public.daftra_purchase_drafts p SET sync_state = CASE WHEN p.external_purchase_id IS NULL
                                                                        AND (p.sync_state IN ('unknown','in_flight') OR app.daftra_purchase_unreconciled(p.id))
                                                                   THEN 'unknown' ELSE 'error' END,
             last_error_code = v_code, last_error_message = v_err ->> 'message'
       WHERE p.id = v_j.purchase_id AND p.status <> 'cancelled';
    ELSIF v_j.run_id IS NOT NULL THEN
      UPDATE public.daftra_runs r SET status = 'failed', finished_at = now(), error_code = left(v_code, 60), error_message = v_err ->> 'message'
       WHERE r.id = v_j.run_id AND r.status IN ('queued','running');
    END IF;
    RETURN jsonb_build_object('job_id', v_j.id, 'job_status', 'failed', 'applied', false, 'outcome', 'failed', 'error', v_err);
  END;
  RETURN v_res;
END $$;

-- request_billing_push(p_intent, p_idem_key) → {intent, job, deduplicated}
-- L7: + HF5 — an intent whose Daftra draft exists (or a linked invoice) is never pushed again under allow_draft_update FALSE
--     (MRS_DAFTRA_DRAFT_LOCKED manual_in_daftra: the manual_in_daftra review item lists what to change by hand); + the
--     KSA account guard, the inactive client, the unmapped products, the required custom fields (app.daftra_push_block);
--     an opening intent needs no charge line
CREATE OR REPLACE FUNCTION public.request_billing_push(p_intent uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.billing_intents; v_replay jsonb; v_block text; v_conn public.daftra_connections; v_bad text; v_link public.daftra_client_links;
        v_job jsonb; k text; v_gate jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_i := app.bill_lock_intent(p_intent, app.fin_write_roles());
  v_replay := app.idem_begin('request_billing_push', p_idem_key, jsonb_build_object('intent', p_intent), v_i.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_i.status = 'issued' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'intent_issued'); END IF;
  IF v_i.status = 'cancelled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'cancelled'); END IF;
  IF v_i.sync_state = 'conflict' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'conflict_open'); END IF;
  -- L7 (HF5): new drafts only
  IF (v_i.external_invoice_id IS NOT NULL OR v_i.origin = 'linked') AND NOT app.daftra_allow_update(v_i.org_id) THEN
    PERFORM app.fin_fail('MRS_DAFTRA_DRAFT_LOCKED', 'manual_in_daftra',
      coalesce((SELECT r.id::text FROM public.billing_review_items r WHERE r.intent_id = v_i.id AND r.kind = 'manual_in_daftra' AND r.status = 'open'), ''));
  END IF;
  SELECT * INTO v_conn FROM public.daftra_connections c WHERE c.org_id = v_i.org_id;
  v_block := app.bill_conn_block(v_i.org_id);
  IF v_block = 'not_connected' THEN
    PERFORM app.fin_fail('MRS_BAD_TRANSITION', 'not_connected', CASE WHEN v_conn.status = 'connected' THEN 'sync_disabled' ELSE coalesce(v_conn.status, 'not_connected') END);
  ELSIF v_block = 'capability' THEN
    PERFORM app.fin_fail('MRS_BAD_TRANSITION', 'capability', array_to_string(app.daftra_missing_caps(v_conn), ','));        -- L7
  END IF;
  IF v_i.origin <> 'opening' AND NOT EXISTS (SELECT 1 FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state IN ('pending_add','synced')) THEN
    PERFORM app.fail('MRS_REQUIRED', 'lines');
  END IF;
  SELECT string_agg(l.line_ref, ',' ORDER BY l.line_ref) INTO v_bad FROM public.billing_intent_lines l
   WHERE l.intent_id = v_i.id AND l.state IN ('pending_add','synced') AND NOT (l.vat_rate = ANY (v_conn.allowed_vat_rates));
  IF v_bad IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'tax_rate_unmapped', v_bad); END IF;
  -- L7: the KSA guard, the client, the products by code, the required custom fields — before anything is queued
  v_gate := app.daftra_push_block(v_i);
  IF v_gate IS NOT NULL THEN PERFORM app.fin_fail(v_gate ->> 'code', v_gate ->> 'detail', coalesce(v_gate ->> 'hint', '')); END IF;
  v_link := app.bill_ensure_client_link(v_i.org_id, v_i.client_id);
  IF v_link.status = 'needs_review' THEN PERFORM app.fin_fail('MRS_REQUIRED', 'client_review', v_link.id::text); END IF;
  FOR k IN SELECT DISTINCT l.item_key FROM public.billing_intent_lines l WHERE l.intent_id = v_i.id AND l.state <> 'removed' LOOP
    IF (app.bill_ensure_item(v_i.org_id, k)).status = 'needs_review' THEN PERFORM app.fin_fail('MRS_REQUIRED', 'item_review', k); END IF;
  END LOOP;
  v_job := app.bill_enqueue(v_i.org_id, 'invoice_push', v_i.id, NULL, NULL,
                            CASE WHEN v_i.origin = 'opening' THEN jsonb_build_object('opening', true) ELSE '{}'::jsonb END, auth.uid());
  UPDATE public.billing_intents i SET sync_state = 'pending' WHERE i.id = v_i.id AND i.sync_state NOT IN ('in_flight','unknown')
  RETURNING * INTO v_i;
  SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = p_intent;
  IF NOT (v_job -> 'deduplicated')::boolean THEN
    PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'push_requested', 'billing_intent', v_i.id,
      jsonb_build_object('job_id', v_job -> 'id'));
  END IF;
  RETURN app.idem_finish('request_billing_push', p_idem_key,
    jsonb_build_object('intent', app.bill_intent_json(v_i), 'job', v_job, 'deduplicated', v_job -> 'deduplicated'));
END $$;

-- retry_billing_job(p_job) — failed | dead → queued (max_attempts = attempts + 3)
-- L7: transaction / purchase jobs lock their transaction (finance writer there); run jobs (product match, imports, scans,
--     supplier search) are bill_admin like the probe
CREATE OR REPLACE FUNCTION public.retry_billing_job(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_j public.billing_sync_jobs; v_i public.billing_intents; v_live public.billing_sync_jobs; v_ptx uuid; v_blk text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.id = p_job;
  IF v_j.id IS NULL OR NOT app.bill_can_read_job(v_j) THEN PERFORM app.fail('MRS_NOT_FOUND', 'job'); END IF;
  IF v_j.intent_id IS NOT NULL THEN
    v_i := app.bill_lock_intent(v_j.intent_id, app.fin_write_roles());
  ELSIF v_j.transaction_id IS NOT NULL THEN                                                                          -- L7
    PERFORM app.g3_lock_tx(v_j.transaction_id, app.fin_write_roles());
  ELSIF v_j.purchase_id IS NOT NULL THEN
    SELECT p.transaction_id INTO v_ptx FROM public.daftra_purchase_drafts p WHERE p.id = v_j.purchase_id;
    PERFORM app.g3_lock_tx(v_ptx, app.fin_write_roles());
  ELSIF NOT app.has_role(v_j.org_id, app.fin_write_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  -- the probe (connection state) and the item catalog are bill_admin (G5-4), like request_daftra_probe / save_daftra_item
  IF v_j.kind IN ('probe','item_ensure','product_match','client_import','legacy_scan') AND NOT app.has_role(v_j.org_id, app.bill_admin_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.id = p_job FOR UPDATE;
  IF v_j.status NOT IN ('failed','dead') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_j.status); END IF;
  IF v_i.status IN ('issued','cancelled') AND v_j.kind = 'invoice_push' THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', CASE v_i.status WHEN 'issued' THEN 'intent_issued' ELSE 'cancelled' END);
  END IF;
  -- L7 (HF5): a push of an intent whose Daftra draft exists is never retried (it could only edit the draft), unless a write of
  -- this job may have landed and is not reconciled yet (the retry then only looks it up by reference)
  IF v_j.kind = 'invoice_push' AND (v_i.external_invoice_id IS NOT NULL OR v_i.origin = 'linked') AND NOT app.daftra_allow_update(v_j.org_id)
     AND NOT app.bill_job_unreconciled(v_j.id) THEN
    PERFORM app.fail('MRS_DAFTRA_DRAFT_LOCKED', 'manual_in_daftra');
  END IF;
  -- L7 (review): a retry never bypasses the org settings or the trip state the request RPCs check (fail closed)
  v_blk := app.daftra_setting_block(v_j);
  IF v_blk = 'purchase_disabled' THEN PERFORM app.fail('MRS_DAFTRA_PURCHASE_DISABLED');
  ELSIF v_blk = 'supplier_link' THEN PERFORM app.fail('MRS_REQUIRED', 'supplier_link');
  ELSIF v_blk IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_blk);
  END IF;
  SELECT * INTO v_live FROM public.billing_sync_jobs j
   WHERE j.org_id = v_j.org_id AND j.dedupe_key = v_j.dedupe_key AND j.status IN ('queued','running','unknown');
  IF v_live.id IS NOT NULL THEN RETURN app.bill_job_json(v_live) || jsonb_build_object('deduplicated', true); END IF;
  UPDATE public.billing_sync_jobs j SET status = 'queued', max_attempts = j.attempts + 3, next_run_at = now(), finished_at = NULL,
         locked_by = NULL, locked_until = NULL, requested_by = auth.uid()
   WHERE j.id = v_j.id RETURNING * INTO v_j;
  IF v_i.id IS NOT NULL AND v_j.kind = 'invoice_push' THEN
    UPDATE public.billing_intents i SET sync_state = 'pending' WHERE i.id = v_i.id AND i.sync_state = 'error';
  ELSIF v_j.purchase_id IS NOT NULL THEN                                                                              -- L7
    UPDATE public.daftra_purchase_drafts p SET sync_state = CASE WHEN app.daftra_purchase_unreconciled(p.id) THEN 'unknown' ELSE 'pending' END,
           status = CASE WHEN p.status = 'failed' THEN 'open' ELSE p.status END
     WHERE p.id = v_j.purchase_id AND p.sync_state IN ('error','unknown');
  ELSIF v_j.run_id IS NOT NULL THEN
    UPDATE public.daftra_runs r SET status = 'queued', finished_at = NULL, error_code = NULL, error_message = NULL
     WHERE r.id = v_j.run_id AND r.status = 'failed';
  END IF;
  RETURN app.bill_job_json(v_j) || jsonb_build_object('deduplicated', false, 'from', 'failed');
END $$;

-- tx_billing(p_tx) → {intents (+ lines), eligible_charges, review_items, financial_status, connection, can}
-- L7: + the opening-draft state, the invoice candidates, the purchase drafts, the write policy / account check
CREATE OR REPLACE FUNCTION public.tx_billing(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx public.transactions; v_conn public.daftra_connections;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_tx := app.fin_tx_read(p_tx);
  SELECT * INTO v_conn FROM public.daftra_connections c WHERE c.org_id = v_tx.org_id;
  RETURN jsonb_build_object(
    'transaction_id', v_tx.id, 'branch_id', v_tx.branch_id,
    -- job_status: the latest invoice job of the intent (UI: «في الانتظار — لم يُشغَّل العامل» while queued)
    'intents', coalesce((SELECT jsonb_agg(app.bill_intent_json(i) || jsonb_build_object('lines',
                           coalesce((SELECT jsonb_agg(app.bill_line_json(l) ORDER BY l.created_at, l.id) FROM public.billing_intent_lines l WHERE l.intent_id = i.id), '[]'::jsonb),
                           'job_status', (SELECT j.status FROM public.billing_sync_jobs j WHERE j.intent_id = i.id ORDER BY j.created_at DESC, j.id DESC LIMIT 1),
                           'job_error', (SELECT j.last_error_code FROM public.billing_sync_jobs j WHERE j.intent_id = i.id ORDER BY j.created_at DESC, j.id DESC LIMIT 1))
                           ORDER BY i.created_at) FROM public.billing_intents i WHERE i.transaction_id = v_tx.id), '[]'::jsonb),
    'eligible_charges', app.bill_eligible(v_tx.id, NULL),
    'review_items', coalesce((SELECT jsonb_agg(app.bill_review_json(r) ORDER BY r.created_at) FROM public.billing_review_items r
                               WHERE r.transaction_id = v_tx.id), '[]'::jsonb),
    'financial_status', v_tx.financial_status,
    'connection', jsonb_build_object('status', coalesce(v_conn.status, 'not_connected'), 'mode', coalesce(v_conn.mode, 'mock'),
                                     'sync_enabled', coalesce(v_conn.sync_enabled, false),
                                     'allow_draft_update', coalesce(v_conn.allow_draft_update, false),                -- L7
                                     'auto_draft_on_declaration', coalesce(v_conn.auto_draft_on_declaration, false),
                                     'purchase_drafts_enabled', coalesce(v_conn.purchase_drafts_enabled, false),
                                     'account_check', CASE WHEN v_conn.id IS NOT NULL THEN app.daftra_account_check(v_conn) END),
    'opening', jsonb_build_object(                                                                                    -- L7
      'intent_id', (SELECT i.id FROM public.billing_intents i WHERE i.transaction_id = v_tx.id AND i.origin = 'opening' AND i.status <> 'cancelled'),
      'blocked', (SELECT r.details FROM public.billing_review_items r WHERE r.transaction_id = v_tx.id AND r.kind = 'opening_blocked' AND r.status = 'open')),
    'invoice_candidates', coalesce((SELECT jsonb_agg(app.daftra_candidate_json(c) ORDER BY c.created_at DESC)
                                      FROM public.daftra_invoice_candidates c WHERE c.transaction_id = v_tx.id AND c.state IN ('open','review','blocked','partial')), '[]'::jsonb),
    'purchase_drafts', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at) FROM public.daftra_purchase_drafts p WHERE p.transaction_id = v_tx.id), '[]'::jsonb),
    'stale', EXISTS (SELECT 1 FROM public.billing_intents i WHERE i.transaction_id = v_tx.id AND i.external_invoice_id IS NOT NULL
                       AND i.status IN ('draft','issued') AND (i.last_pulled_at IS NULL OR i.last_pulled_at < now() - interval '15 minutes')),
    'can', jsonb_build_object('write', app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.fin_write_roles()),
                              'approve', app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.fin_approve_roles())));
END $$;

-- save_daftra_connection(p_org, {mode, subdomain, sync_enabled, default_service_vat_rate, allowed_vat_rates, reimbursable_tax_code,
--   invoice_notes, auto_draft_on_declaration, purchase_drafts_enabled, opening_item, purchase_item}) — G5b body;
-- L7: + the step-7 settings (bill_admin). The write policy (allow_draft_update / allow_product_create) is NOT here: owner only
-- (set_daftra_write_policy). A mode / account change clears the account profile with the capabilities (a new probe).
CREATE OR REPLACE FUNCTION public.save_daftra_connection(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.daftra_connections; v_old public.daftra_connections; v_mode text; v_sub text; v_sync boolean; v_rate numeric;
        v_rates numeric[]; v_tax text; e jsonb; k text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['mode','subdomain','sync_enabled','default_service_vat_rate','allowed_vat_rates',
                                         'reimbursable_tax_code','invoice_notes',
                                         'auto_draft_on_declaration','purchase_drafts_enabled','opening_item','purchase_item']);  -- L7
  INSERT INTO public.daftra_connections (org_id, created_by, updated_by) VALUES (p_org, auth.uid(), auth.uid())
  ON CONFLICT (org_id) DO NOTHING;
  SELECT * INTO v_old FROM public.daftra_connections c WHERE c.org_id = p_org FOR UPDATE;
  v := v_old;
  IF p_payload ? 'mode' THEN
    v_mode := app.ptext(p_payload, 'mode', 20, true);
    -- G5b: 'live' = the real Daftra adapter (index.ts builds it for the one allowlisted org only)
    IF v_mode NOT IN ('mock','live_pending','live') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
    v.mode := v_mode;
  END IF;
  IF p_payload ? 'subdomain' THEN
    v_sub := lower(app.ptext(p_payload, 'subdomain', 63));
    IF v_sub IS NOT NULL AND v_sub !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' THEN PERFORM app.fail('MRS_INVALID', 'subdomain'); END IF;
    -- one Daftra account per org (the other org is never named)
    IF v_sub IS NOT NULL AND EXISTS (SELECT 1 FROM public.daftra_connections c WHERE lower(c.subdomain) = v_sub AND c.org_id <> p_org) THEN
      PERFORM app.fail('MRS_INVALID', 'subdomain_taken');
    END IF;
    v.subdomain := v_sub;
  END IF;
  -- G5b: a live connection names its account
  IF v.mode = 'live' AND v.subdomain IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'subdomain'); END IF;
  IF p_payload ? 'sync_enabled' THEN
    IF jsonb_typeof(p_payload -> 'sync_enabled') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'sync_enabled'); END IF;
    v.sync_enabled := (p_payload ->> 'sync_enabled')::boolean;
  END IF;
  IF p_payload ? 'default_service_vat_rate' THEN
    IF jsonb_typeof(p_payload -> 'default_service_vat_rate') IN ('object','array','boolean') THEN PERFORM app.fail('MRS_INVALID', 'default_service_vat_rate'); END IF;
    v_rate := app.pnum(p_payload, 'default_service_vat_rate', 100);
    IF v_rate IS NULL OR v_rate <> round(v_rate, 2) THEN PERFORM app.fail('MRS_INVALID', 'default_service_vat_rate'); END IF;
    v.default_service_vat_rate := v_rate;
  END IF;
  IF p_payload ? 'allowed_vat_rates' THEN
    IF jsonb_typeof(p_payload -> 'allowed_vat_rates') <> 'array' OR jsonb_array_length(p_payload -> 'allowed_vat_rates') NOT BETWEEN 1 AND 10 THEN
      PERFORM app.fail('MRS_INVALID', 'allowed_vat_rates');
    END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(p_payload -> 'allowed_vat_rates') x LOOP
      IF jsonb_typeof(e) NOT IN ('number','string') OR (e #>> '{}') !~ '^[0-9]+(\.[0-9]{1,2})?$' OR (e #>> '{}')::numeric > 100 THEN
        PERFORM app.fail('MRS_INVALID', 'allowed_vat_rates');
      END IF;
    END LOOP;
    SELECT array_agg(DISTINCT (x #>> '{}')::numeric(5,2) ORDER BY (x #>> '{}')::numeric(5,2)) INTO v_rates
      FROM jsonb_array_elements(p_payload -> 'allowed_vat_rates') x;
    v.allowed_vat_rates := v_rates;
  END IF;
  IF NOT (v.default_service_vat_rate = ANY (v.allowed_vat_rates)) THEN PERFORM app.fail('MRS_INVALID', 'default_service_vat_rate'); END IF;
  IF p_payload ? 'reimbursable_tax_code' THEN
    v_tax := app.ptext(p_payload, 'reimbursable_tax_code', 20, true);
    IF NOT app.is_code('daftra_tax_code', v_tax) THEN PERFORM app.fail('MRS_INVALID', 'reimbursable_tax_code'); END IF;
    v.reimbursable_tax_code := v_tax;
  END IF;
  IF p_payload ? 'invoice_notes' THEN v.invoice_notes := app.ptext(p_payload, 'invoice_notes', 500); END IF;
  -- L7: the org settings of step 7 (both OFF by default)
  FOREACH k IN ARRAY ARRAY['auto_draft_on_declaration','purchase_drafts_enabled'] LOOP
    IF p_payload ? k AND jsonb_typeof(p_payload -> k) <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  END LOOP;
  -- review: the two settings make Marsa WRITE to Daftra: OWNER ONLY with a reason (set_daftra_write_policy). Here they are
  -- accepted unchanged only (a full form may echo them); a change is refused for every role.
  FOREACH k IN ARRAY ARRAY['auto_draft_on_declaration','purchase_drafts_enabled'] LOOP
    IF p_payload ? k AND (p_payload ->> k)::boolean IS DISTINCT FROM
       coalesce(CASE k WHEN 'auto_draft_on_declaration' THEN v_old.auto_draft_on_declaration ELSE v_old.purchase_drafts_enabled END, false) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'owner_only');
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['opening_item','purchase_item'] LOOP
    IF p_payload ? k AND NOT coalesce(app.bill_check_item_key(app.ptext(p_payload, k, 60)), false) THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  END LOOP;
  IF p_payload ? 'opening_item' THEN v.opening_item := app.ptext(p_payload, 'opening_item', 60, true); END IF;
  IF p_payload ? 'purchase_item' THEN v.purchase_item := app.ptext(p_payload, 'purchase_item', 60, true); END IF;
  -- status: a mode change forces a new probe; switching sync off / on toggles connected ⇄ disabled
  -- G5b: in live mode a subdomain change is another account: it forces a new probe too
  IF v.mode IS DISTINCT FROM v_old.mode OR (v.mode = 'live' AND v.subdomain IS DISTINCT FROM v_old.subdomain) THEN
    v.status := 'not_connected'; v.capabilities := '{}'::jsonb; v.capabilities_checked_at := NULL; v.capabilities_source := NULL;
    v.account_profile := NULL; v.account_checked_at := NULL;                                                            -- L7
  ELSIF v.sync_enabled IS DISTINCT FROM v_old.sync_enabled THEN
    IF NOT v.sync_enabled AND v_old.status = 'connected' THEN v.status := 'disabled';
    ELSIF v.sync_enabled AND v_old.status = 'disabled' THEN
      v.status := CASE WHEN v_old.last_check_status = 'ok' THEN 'connected' ELSE 'not_connected' END;
    END IF;
  END IF;
  IF v.mode <> 'mock' AND v.subdomain IS DISTINCT FROM v_old.subdomain THEN
    v.account_profile := NULL; v.account_checked_at := NULL;      -- review: another account (live_pending too): the KSA check is redone
  END IF;
  UPDATE public.daftra_connections c SET mode = v.mode, subdomain = v.subdomain, sync_enabled = v.sync_enabled,
         default_service_vat_rate = v.default_service_vat_rate, allowed_vat_rates = v.allowed_vat_rates,
         reimbursable_tax_code = v.reimbursable_tax_code, invoice_notes = v.invoice_notes, status = v.status,
         capabilities = v.capabilities, capabilities_checked_at = v.capabilities_checked_at, capabilities_source = v.capabilities_source,
         auto_draft_on_declaration = v.auto_draft_on_declaration, purchase_drafts_enabled = v.purchase_drafts_enabled,      -- L7
         opening_item = v.opening_item, purchase_item = v.purchase_item,
         account_profile = v.account_profile, account_checked_at = v.account_checked_at,
         target_changed_at = CASE WHEN v.mode IS DISTINCT FROM v_old.mode OR v.subdomain IS DISTINCT FROM v_old.subdomain
                                  THEN clock_timestamp() ELSE c.target_changed_at END,                                 -- review
         updated_by = auth.uid()
   WHERE c.id = v_old.id RETURNING * INTO v;
  RETURN app.bill_conn_json(p_org) || jsonb_build_object('from', v_old.status);
END $$;

-- match statistics, the source and (L7) the Daftra client number are written by the matching / import RPCs only (API
-- callers: reset on insert, immutable on update). SECURITY INVOKER on purpose: app.is_api_caller() must see the real caller role.
CREATE OR REPLACE FUNCTION app.tg_clients_legacy_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.is_api_caller() THEN
    IF TG_OP = 'INSERT' THEN
      -- provenance is set by the import / Daftra / portal / legacy RPCs only; a client typed in by staff is 'manual'
      NEW.match_count := 0; NEW.last_matched_at := NULL; NEW.source := 'manual';
      NEW.daftra_client_code := NULL;                                                                                 -- L7
    ELSE
      PERFORM app.guard_immutable(to_jsonb(OLD), to_jsonb(NEW), ARRAY['match_count','last_matched_at','source','daftra_client_code']);  -- L7
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- cancel_transaction (20261117000100 body; L7: + the Daftra guard, fail closed — legacy assertTransactionDeletableAgainstDaftraR1216_):
--   daftra_invoice_issued — an issued (approved) Daftra invoice of the transaction; daftra_sync_in_flight — a Daftra job of
--   the transaction queued / running / unknown, or a write that may have reached Daftra and was never reconciled (any intent,
--   cancelled ones too); daftra_purchase — a purchase draft of one of its trips
CREATE OR REPLACE FUNCTION public.cancel_transaction(p_tx uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tx public.transactions;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), '');
  v_ev bigint;
  v_at timestamptz := now();
  v_d public.customs_declarations; v_from text; v_nd int := 0;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  -- app.g3_lock_tx without its cancelled refusal (an already cancelled transaction gets its own reason below)
  SELECT * INTO v_tx FROM public.transactions t WHERE t.id = p_tx FOR UPDATE;
  IF v_tx.id IS NULL OR NOT app.has_tx_role(v_tx.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.ops_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF v_reason IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'reason'); END IF;
  IF char_length(v_reason) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'reason'); END IF;
  IF v_tx.cancelled_at IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'already_cancelled'); END IF;
  IF v_tx.operational_status = 'closed' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'closed'); END IF;
  IF v_tx.operational_status IN ('under_billing','billed') OR v_tx.financial_status IN ('draft_pending','invoiced','settled') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'billed');
  END IF;
  IF app.code_sort('operational_status', v_tx.operational_status) > app.code_sort('operational_status', 'customs_declaration')
     AND NOT app.has_branch_role(v_tx.org_id, v_tx.branch_id, app.senior_ops_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  -- L7: the Daftra guard (fail closed)
  IF EXISTS (SELECT 1 FROM public.billing_intents b WHERE b.transaction_id = v_tx.id AND b.status = 'issued') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'daftra_invoice_issued');
  END IF;
  IF EXISTS (SELECT 1 FROM public.billing_sync_jobs j
              WHERE j.status IN ('queued','running','unknown')
                AND (j.transaction_id = v_tx.id
                     OR j.intent_id IN (SELECT b.id FROM public.billing_intents b WHERE b.transaction_id = v_tx.id)
                     OR j.purchase_id IN (SELECT p.id FROM public.daftra_purchase_drafts p WHERE p.transaction_id = v_tx.id)))
     OR EXISTS (SELECT 1 FROM public.billing_intents b WHERE b.transaction_id = v_tx.id
                   AND (b.sync_state IN ('in_flight','unknown') OR app.bill_unreconciled(b.id))) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'daftra_sync_in_flight');
  END IF;
  IF EXISTS (SELECT 1 FROM public.daftra_purchase_drafts p WHERE p.transaction_id = v_tx.id AND p.status <> 'cancelled') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'daftra_purchase');
  END IF;
  IF EXISTS (SELECT 1 FROM public.billing_intents b WHERE b.transaction_id = v_tx.id AND b.status <> 'cancelled') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'billing_intent');
  END IF;
  IF EXISTS (SELECT 1 FROM public.client_charges c WHERE c.transaction_id = v_tx.id AND c.status = 'invoiced') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'invoiced_charge');
  END IF;
  IF EXISTS (SELECT 1 FROM public.client_charges c WHERE c.transaction_id = v_tx.id AND c.status IN ('draft','approved')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_charges');
  END IF;
  IF EXISTS (SELECT 1 FROM public.port_appointments a WHERE a.transaction_id = v_tx.id AND a.status IN ('requested','confirmed')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_appointments');
  END IF;
  IF EXISTS (SELECT 1 FROM public.transport_trips r WHERE r.transaction_id = v_tx.id AND r.status IN ('planned','dispatched','loaded')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_trips');
  END IF;
  IF EXISTS (SELECT 1 FROM public.operational_exceptions e WHERE e.transaction_id = v_tx.id AND e.status IN ('open','in_progress')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_exceptions');
  END IF;
  IF EXISTS (SELECT 1 FROM public.demurrage_cases k WHERE k.transaction_id = v_tx.id AND k.status = 'open') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_demurrage');
  END IF;
  IF EXISTS (SELECT 1 FROM public.containers c WHERE c.transaction_id = v_tx.id
                AND c.return_status IN ('pending','evidence_submitted','disputed')
                AND (c.gate_out_at IS NOT NULL OR c.return_deadline IS NOT NULL)) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'open_returns');
  END IF;

  -- the active declarations go with the transaction (their mirror clears transactions.declaration_no before the freeze)
  FOR v_d IN SELECT * FROM public.customs_declarations d
              WHERE d.transaction_id = v_tx.id AND d.status NOT IN ('cancelled','replaced')
              ORDER BY d.created_at, d.id FOR UPDATE LOOP
    v_from := v_d.status;
    UPDATE public.customs_declarations d SET status = 'cancelled', cancelled_at = v_at, cancel_reason = v_reason
     WHERE d.id = v_d.id RETURNING * INTO v_d;
    PERFORM app.decl_event(v_d, 'cancelled', v_from, v_reason, jsonb_build_object('with_transaction', true));
    v_nd := v_nd + 1;
  END LOOP;
  -- L7: the open invoice candidates of the transaction are superseded (nothing can be linked to a cancelled transaction)
  UPDATE public.daftra_invoice_candidates c SET state = 'superseded', note = left('transaction cancelled', 2000)
   WHERE c.transaction_id = v_tx.id AND c.state IN ('open','review','blocked','partial');

  UPDATE public.transactions t
     SET operational_status = 'closed', status_changed_at = v_at,
         cancelled_at = v_at, cancelled_by = auth.uid(), cancel_reason = v_reason
   WHERE t.id = v_tx.id;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, from_status, to_status, visible_to_client, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'operational_status', v_tx.operational_status, 'closed', true, auth.uid(),
          jsonb_build_object('direction', 'forward', 'op', 'cancelled'))
  RETURNING id INTO v_ev;
  -- the reason is internal; status events visible to clients carry no free text
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, note, visible_to_client, actor, payload)
  VALUES (v_tx.org_id, v_tx.id, 'note', v_reason, false, auth.uid(), jsonb_build_object('for_event', v_ev, 'op', 'cancelled'));
  RETURN jsonb_build_object('transaction_id', v_tx.id, 'ref', v_tx.ref, 'from', v_tx.operational_status, 'to', 'closed',
                            'cancelled_at', v_at, 'event_id', v_ev, 'declarations_cancelled', v_nd);
END $$;

-- ---------------------------------------------------------------------
-- 5. RPCs (authenticated)
-- ---------------------------------------------------------------------
-- the owner of an org = an active org-wide admin membership (has_role: the org active, the MFA gate of admins)
CREATE OR REPLACE FUNCTION app.daftra_is_owner(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.has_role(p_org, ARRAY['admin'])
     AND EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.org_id = p_org AND m.role = 'admin'
                    AND m.is_active AND m.branch_id IS NULL)
$$;
-- who may import clients from a file (the directory is an operations + finance asset)
CREATE OR REPLACE FUNCTION app.daftra_import_roles() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['admin','operations_manager','accounts_manager']
$$;
-- a read-only Daftra job needs a connected org with sync enabled
CREATE OR REPLACE FUNCTION app.daftra_need_connection(p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.daftra_connections c WHERE c.org_id = p_org AND c.status = 'connected' AND c.sync_enabled) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'not_connected');
  END IF;
END $$;

-- set_daftra_write_policy(p_org, {allow_draft_update?, allow_product_create?, auto_draft_on_declaration?, purchase_drafts_enabled?},
-- p_reason) — OWNER ONLY (org-wide admin, aal2): the HF5 flag and the product-create flag (both FALSE by default; no UI), and
-- (review) the two org settings that make Marsa write drafts (opening draft on declaration approval, purchase drafts per trip;
-- OFF by default; the #daftra owner toggles call this with a reason). A reason is required; audit_log keeps before / after.
CREATE OR REPLACE FUNCTION public.set_daftra_write_policy(p_org uuid, p_payload jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_old public.daftra_connections; v public.daftra_connections; v_reason text; k text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.daftra_is_owner(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'owner_only'); END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR p_payload = '{}'::jsonb THEN PERFORM app.fail('MRS_REQUIRED', 'payload'); END IF;
  PERFORM app.only_keys(p_payload, ARRAY['allow_draft_update','allow_product_create','auto_draft_on_declaration','purchase_drafts_enabled']);
  FOREACH k IN ARRAY ARRAY['allow_draft_update','allow_product_create','auto_draft_on_declaration','purchase_drafts_enabled'] LOOP
    IF p_payload ? k AND jsonb_typeof(p_payload -> k) <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', k); END IF;
  END LOOP;
  v_reason := app.fin_note(p_reason, 'reason', 500);
  INSERT INTO public.daftra_connections (org_id, created_by, updated_by) VALUES (p_org, auth.uid(), auth.uid()) ON CONFLICT (org_id) DO NOTHING;
  SELECT * INTO v_old FROM public.daftra_connections c WHERE c.org_id = p_org FOR UPDATE;
  UPDATE public.daftra_connections c SET
    allow_draft_update = coalesce((p_payload ->> 'allow_draft_update')::boolean, c.allow_draft_update),
    allow_product_create = coalesce((p_payload ->> 'allow_product_create')::boolean, c.allow_product_create),
    auto_draft_on_declaration = coalesce((p_payload ->> 'auto_draft_on_declaration')::boolean, c.auto_draft_on_declaration),
    purchase_drafts_enabled = coalesce((p_payload ->> 'purchase_drafts_enabled')::boolean, c.purchase_drafts_enabled),
    policy_changed_by = auth.uid(), policy_changed_at = now(), policy_reason = v_reason, updated_by = auth.uid()
   WHERE c.id = v_old.id RETURNING * INTO v;
  RETURN app.bill_conn_json(p_org) || jsonb_build_object('from', jsonb_build_object('allow_draft_update', v_old.allow_draft_update,
                                                                                    'allow_product_create', v_old.allow_product_create,
                                                                                    'auto_draft_on_declaration', v_old.auto_draft_on_declaration,
                                                                                    'purchase_drafts_enabled', v_old.purchase_drafts_enabled));
END $$;

-- save_daftra_custom_fields(p_org, {fields:{<name>:{key, required}}, port_values:{<port code>: value}, type_values:{import|export|clearance: value}})
-- bill_admin. The CustomModel keys of the org's Daftra account (legacy field_1 … field_9 — never seeded): one key per field,
-- names from the daftra_custom_field domain, values ≤ 120.
CREATE OR REPLACE FUNCTION public.save_daftra_custom_fields(p_org uuid, p_map jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m jsonb := coalesce(p_map, '{}'::jsonb); f jsonb := '{}'::jsonb; e record; v_keys text[] := '{}'; v_key text; v_pv jsonb := '{}'::jsonb;
        v_tv jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF jsonb_typeof(m) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'custom_field_map'); END IF;
  PERFORM app.only_keys(m, ARRAY['fields','port_values','type_values']);
  IF m ? 'fields' THEN
    IF jsonb_typeof(m -> 'fields') <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'fields'); END IF;
    FOR e IN SELECT x.key, x.value FROM jsonb_each(m -> 'fields') x LOOP
      IF NOT app.is_code('daftra_custom_field', e.key) OR jsonb_typeof(e.value) <> 'object' THEN PERFORM app.fin_fail('MRS_INVALID', 'fields', e.key); END IF;
      PERFORM app.only_keys(e.value, ARRAY['key','required']);
      v_key := btrim(coalesce(e.value ->> 'key', ''));
      IF v_key !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$' THEN PERFORM app.fin_fail('MRS_INVALID', 'field_key', e.key); END IF;
      IF e.value ? 'required' AND jsonb_typeof(e.value -> 'required') <> 'boolean' THEN PERFORM app.fin_fail('MRS_INVALID', 'required', e.key); END IF;
      IF v_key = ANY (v_keys) THEN PERFORM app.fin_fail('MRS_INVALID', 'field_key_taken', v_key); END IF;
      v_keys := v_keys || v_key;
      f := f || jsonb_build_object(e.key, jsonb_build_object('key', v_key, 'required', coalesce((e.value ->> 'required')::boolean, false)));
    END LOOP;
  END IF;
  IF m ? 'port_values' THEN
    IF jsonb_typeof(m -> 'port_values') <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'port_values'); END IF;
    FOR e IN SELECT x.key, x.value FROM jsonb_each(m -> 'port_values') x LOOP
      IF NOT EXISTS (SELECT 1 FROM public.customs_ports p WHERE p.code = e.key) THEN PERFORM app.fin_fail('MRS_INVALID', 'port_code', e.key); END IF;
      IF jsonb_typeof(e.value) <> 'string' OR char_length(btrim(e.value #>> '{}')) NOT BETWEEN 1 AND 120 THEN PERFORM app.fin_fail('MRS_INVALID', 'port_values', e.key); END IF;
      v_pv := v_pv || jsonb_build_object(e.key, btrim(e.value #>> '{}'));
    END LOOP;
  END IF;
  IF m ? 'type_values' THEN
    IF jsonb_typeof(m -> 'type_values') <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'type_values'); END IF;
    FOR e IN SELECT x.key, x.value FROM jsonb_each(m -> 'type_values') x LOOP
      IF NOT (e.key = ANY (ARRAY['import','export','clearance'])) THEN PERFORM app.fin_fail('MRS_INVALID', 'declaration_type', e.key); END IF;
      IF jsonb_typeof(e.value) <> 'string' OR char_length(btrim(e.value #>> '{}')) NOT BETWEEN 1 AND 120 THEN PERFORM app.fin_fail('MRS_INVALID', 'type_values', e.key); END IF;
      v_tv := v_tv || jsonb_build_object(e.key, btrim(e.value #>> '{}'));
    END LOOP;
  END IF;
  INSERT INTO public.daftra_connections (org_id, created_by, updated_by) VALUES (p_org, auth.uid(), auth.uid()) ON CONFLICT (org_id) DO NOTHING;
  UPDATE public.daftra_connections c SET custom_field_map = jsonb_build_object('fields', f, 'port_values', v_pv, 'type_values', v_tv),
         updated_by = auth.uid()
   WHERE c.org_id = p_org;
  RETURN app.bill_conn_json(p_org);
END $$;

-- test_daftra_custom_fields(p_tx) — OWNER ONLY, read-only dry run: the draft payload Marsa WOULD send for this transaction
-- (date, reference, client, opening line, custom fields) and what blocks it. Nothing is queued, nothing is sent.
CREATE OR REPLACE FUNCTION public.test_daftra_custom_fields(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_t public.transactions; v_conn public.daftra_connections; v_l public.daftra_client_links; v_cf jsonb; v_un text[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_t FROM public.transactions t WHERE t.id = p_tx;
  IF v_t.id IS NULL OR NOT app.has_tx_role(v_t.id, app.staff_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF NOT app.daftra_is_owner(v_t.org_id) THEN PERFORM app.fail('MRS_FORBIDDEN', 'owner_only'); END IF;
  SELECT * INTO v_conn FROM public.daftra_connections c WHERE c.org_id = v_t.org_id;
  SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.org_id = v_t.org_id AND l.client_id = v_t.client_id AND l.status <> 'unlinked';
  v_cf := app.daftra_custom_fields(v_t.id);
  v_un := app.daftra_unmapped(v_t.org_id, ARRAY[coalesce(v_conn.opening_item, 'item:customs_clearance')]);
  RETURN jsonb_build_object('transaction_id', v_t.id, 'ref', v_t.ref, 'would_send', false, 'dry_run', true,
    'payload', jsonb_build_object('invoice_date', to_char(app.rpt_today(), 'YYYY-MM-DD'), 'time_zone', 'Asia/Riyadh',
      'po_number', v_t.ref, 'draft', 1, 'client_external_id', CASE WHEN v_l.status IN ('linked','drift') THEN v_l.external_id END,
      'opening_line', jsonb_build_object('item_key', coalesce(v_conn.opening_item, 'item:customs_clearance'),
        'remote_product_code', (SELECT i.remote_product_code FROM public.daftra_item_links i WHERE i.org_id = v_t.org_id
                                  AND i.item_key = coalesce(v_conn.opening_item, 'item:customs_clearance') AND i.status <> 'retired'),
        'description', '', 'quantity', 1, 'unit_price', 0),
      'custom_fields', v_cf -> 'payload'),
    'fields', v_cf -> 'fields', 'values', app.daftra_custom_values(v_t.id), 'missing', v_cf -> 'missing',
    'unmapped', to_jsonb(v_un), 'client_linked', v_l.status IN ('linked','drift') AND v_l.external_id IS NOT NULL,
    'account_check', CASE WHEN v_conn.id IS NOT NULL THEN app.daftra_account_check(v_conn) END,
    'ok', jsonb_array_length(v_cf -> 'missing') = 0 AND cardinality(v_un) = 0);
END $$;

-- list_daftra_product_map(p_org) → {items:[the org's service items (item:<code>) + every mapped key, with the mapping], counts}
CREATE OR REPLACE FUNCTION public.list_daftra_product_map(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  RETURN (
    WITH k AS (
      SELECT 'item:' || s.code item_key, s.sort ord, s.id sid FROM public.org_service_items s WHERE s.org_id = p_org
      UNION
      SELECT i.item_key, 10000, NULL::uuid FROM public.daftra_item_links i
       WHERE i.org_id = p_org AND i.status <> 'retired' AND i.item_key NOT LIKE 'item:%'),
    x AS (SELECT k.item_key, k.ord, jsonb_build_object('item_key', k.item_key,
            'service_item', (SELECT jsonb_build_object('id', s.id, 'code', s.code, 'name_ar', s.name_ar, 'name_en', s.name_en,
                                                       'fin_service', s.fin_service, 'is_active', s.is_active)
                               FROM public.org_service_items s WHERE s.id = k.sid),
            'link', (SELECT to_jsonb(i) FROM public.daftra_item_links i WHERE i.org_id = p_org AND i.item_key = k.item_key AND i.status <> 'retired'),
            'mapped', app.daftra_item_mapped(p_org, k.item_key) AND NOT app.daftra_allow_create(p_org)
                      OR EXISTS (SELECT 1 FROM public.daftra_item_links i WHERE i.org_id = p_org AND i.item_key = k.item_key AND i.status = 'linked'
                                    AND i.remote_code_norm IS NOT NULL AND i.external_product_id IS NOT NULL)) j FROM k)
    SELECT jsonb_build_object('items', coalesce((SELECT jsonb_agg(x.j ORDER BY x.ord, x.item_key) FROM x), '[]'::jsonb),
      'counts', jsonb_build_object('total', (SELECT count(*) FROM x), 'mapped', (SELECT count(*) FROM x WHERE (x.j ->> 'mapped')::boolean)),
      'policy', jsonb_build_object('allow_product_create', app.daftra_allow_create(p_org))));
END $$;

-- save_daftra_product_code(p_org, p_item_key, p_code) — bill_admin: the existing Daftra product code of an item key
-- (item:<org service item code> or <kind>:<fin_service>); NULL clears it. A changed code needs a new match + confirmation.
CREATE OR REPLACE FUNCTION public.save_daftra_product_code(p_org uuid, p_item_key text, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.daftra_item_links; v_code text := nullif(btrim(coalesce(p_code, '')), ''); v_sid uuid;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  IF p_item_key LIKE 'item:%' THEN
    SELECT s.id INTO v_sid FROM public.org_service_items s WHERE s.org_id = p_org AND s.code = split_part(p_item_key, ':', 2);
    IF v_sid IS NULL OR NOT app.bill_check_item_key(p_item_key) THEN PERFORM app.fail('MRS_INVALID', 'item_key'); END IF;
  ELSIF NOT coalesce(app.bill_valid_item_key(p_item_key), false) THEN
    PERFORM app.fail('MRS_INVALID', 'item_key');
  END IF;
  v_code := app.to_western(v_code);
  IF v_code IS NOT NULL AND v_code !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$' THEN PERFORM app.fail('MRS_INVALID', 'remote_product_code'); END IF;
  v_i := app.bill_ensure_item(p_org, p_item_key);
  SELECT * INTO v_i FROM public.daftra_item_links i WHERE i.id = v_i.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.daftra_item_links i WHERE i.org_id = p_org AND i.id <> v_i.id AND i.status <> 'retired'
                AND (i.item_key LIKE 'item:%') = (p_item_key LIKE 'item:%') AND i.remote_code_norm = app.daftra_code_norm(v_code)) THEN
    PERFORM app.fin_fail('MRS_INVALID', 'code_taken', (SELECT i.item_key FROM public.daftra_item_links i WHERE i.org_id = p_org AND i.id <> v_i.id
      AND i.status <> 'retired' AND (i.item_key LIKE 'item:%') = (p_item_key LIKE 'item:%') AND i.remote_code_norm = app.daftra_code_norm(v_code) LIMIT 1));
  END IF;
  IF app.daftra_code_norm(v_code) IS DISTINCT FROM v_i.remote_code_norm THEN
    UPDATE public.daftra_item_links i SET remote_product_code = v_code, remote_code_norm = app.daftra_code_norm(v_code), service_item_id = coalesce(v_sid, i.service_item_id),
           external_product_id = NULL, status = 'pending', candidates = NULL, mapped_by = NULL, mapped_at = NULL, last_error_code = NULL,
           last_error_message = NULL, updated_by = auth.uid()
     WHERE i.id = v_i.id RETURNING * INTO v_i;
  ELSE
    UPDATE public.daftra_item_links i SET remote_product_code = v_code, service_item_id = coalesce(v_sid, i.service_item_id), updated_by = auth.uid()
     WHERE i.id = v_i.id RETURNING * INTO v_i;
  END IF;
  RETURN app.bill_item_json(v_i);
END $$;

-- request_daftra_product_match(p_org, {item_keys?: [...]}, p_idem_key) — bill_admin: a READ-ONLY job that looks the configured
-- codes up in Daftra (zero-insensitive) and stores the candidates; nothing is mapped before confirm_daftra_product_mapping
CREATE OR REPLACE FUNCTION public.request_daftra_product_match(p_org uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v_replay jsonb; v_r public.daftra_runs; v_job jsonb; v_keys jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(p, ARRAY['item_keys']);
  v_replay := app.idem_begin('request_daftra_product_match', p_idem_key, p, p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM app.daftra_need_connection(p_org);
  IF p ? 'item_keys' THEN
    IF jsonb_typeof(p -> 'item_keys') <> 'array' OR jsonb_array_length(p -> 'item_keys') NOT BETWEEN 1 AND 200
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'item_keys') x WHERE jsonb_typeof(x) <> 'string' OR NOT app.bill_check_item_key(x #>> '{}')) THEN
      PERFORM app.fail('MRS_INVALID', 'item_keys');
    END IF;
    v_keys := p -> 'item_keys';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.daftra_item_links i WHERE i.org_id = p_org AND i.status <> 'retired' AND i.remote_code_norm IS NOT NULL
                    AND (v_keys IS NULL OR v_keys ? i.item_key)) THEN
    PERFORM app.fail('MRS_REQUIRED', 'remote_product_code');
  END IF;
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.org_id = p_org AND r.kind = 'product_match' AND r.status IN ('queued','running');
  IF v_r.id IS NULL THEN
    INSERT INTO public.daftra_runs (org_id, kind, params, requested_by)
    VALUES (p_org, 'product_match', jsonb_strip_nulls(jsonb_build_object('item_keys', v_keys)), auth.uid()) RETURNING * INTO v_r;
  END IF;
  v_job := app.daftra_enqueue(p_org, 'product_match', NULL, v_r.id, NULL, 'p0', '{}'::jsonb, auth.uid());
  RETURN app.idem_finish('request_daftra_product_match', p_idem_key, app.daftra_run_json(v_r) || jsonb_build_object('job', v_job));
END $$;

-- confirm_daftra_product_mapping(p_org, p_item_key, {external_product_id}) — bill_admin: the human confirmation of a candidate
-- whose code equals the configured one without leading zeros. One Daftra product per item key and namespace.
CREATE OR REPLACE FUNCTION public.confirm_daftra_product_mapping(p_org uuid, p_item_key text, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_i public.daftra_item_links; v_ext text; v_c jsonb; v_other uuid;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(coalesce(p_payload, '{}'::jsonb), ARRAY['external_product_id']);
  v_ext := app.ptext(p_payload, 'external_product_id', 64, true);
  SELECT * INTO v_i FROM public.daftra_item_links i WHERE i.org_id = p_org AND i.item_key = p_item_key AND i.status <> 'retired' FOR UPDATE;
  IF v_i.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'item_key'); END IF;
  IF v_i.remote_code_norm IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'remote_product_code'); END IF;
  SELECT c INTO v_c FROM jsonb_array_elements(coalesce(v_i.candidates, '[]'::jsonb)) c WHERE c ->> 'external_product_id' = v_ext LIMIT 1;
  IF v_c IS NULL THEN PERFORM app.fail('MRS_INVALID', 'not_a_candidate'); END IF;
  IF app.daftra_code_norm(v_c ->> 'code') IS DISTINCT FROM v_i.remote_code_norm THEN PERFORM app.fin_fail('MRS_INVALID', 'code_mismatch', coalesce(v_c ->> 'code', '')); END IF;
  SELECT i.id INTO v_other FROM public.daftra_item_links i
   WHERE i.org_id = p_org AND i.id <> v_i.id AND i.status <> 'retired' AND i.external_product_id = v_ext
     AND (i.item_key LIKE 'item:%') = (v_i.item_key LIKE 'item:%');
  IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'external_id_taken', v_other::text); END IF;
  UPDATE public.daftra_item_links i SET external_product_id = v_ext, status = 'linked', mapped_by = auth.uid(), mapped_at = now(),
         last_synced_at = now(), last_error_code = NULL, last_error_message = NULL, updated_by = auth.uid()
   WHERE i.id = v_i.id RETURNING * INTO v_i;
  RETURN app.bill_item_json(v_i);
END $$;

-- retry_daftra_opening(p_tx, p_idem_key) — finance writer of the transaction: asks for the opening draft again (after the
-- client was linked, the product confirmed, the account switched…) or re-queues its failed push job
CREATE OR REPLACE FUNCTION public.retry_daftra_opening(p_tx uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_t public.transactions; v_replay jsonb; v_i public.billing_intents; v_j public.billing_sync_jobs; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_t := app.g3_lock_tx(p_tx, app.fin_write_roles());
  v_replay := app.idem_begin('retry_daftra_opening', p_idem_key, jsonb_build_object('transaction', p_tx), v_t.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT coalesce((SELECT c.auto_draft_on_declaration FROM public.daftra_connections c WHERE c.org_id = v_t.org_id), false) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'opening_disabled');
  END IF;
  SELECT * INTO v_i FROM public.billing_intents i WHERE i.transaction_id = v_t.id AND i.origin = 'opening' AND i.status <> 'cancelled';
  IF v_i.id IS NOT NULL THEN
    SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.intent_id = v_i.id AND j.kind = 'invoice_push' ORDER BY j.created_at DESC, j.id DESC LIMIT 1;
    IF v_j.status IN ('failed','dead') THEN
      v_res := jsonb_build_object('status', 'retried', 'intent_id', v_i.id, 'job', public.retry_billing_job(v_j.id));
    ELSE
      v_res := jsonb_build_object('status', 'exists', 'intent_id', v_i.id, 'job_status', v_j.status);
    END IF;
  ELSE
    v_res := app.daftra_opening_try(v_t.id, 'retry');
  END IF;
  RETURN app.idem_finish('retry_daftra_opening', p_idem_key, v_res);
END $$;

-- resolve_daftra_review(p_id, p_decision, p_note) — the step-7 review items:
--   manual_in_daftra: done_in_daftra (finance writer: the accountant changed the draft by hand — the listed lines become
--     synced «manual», the removals removed) | dismiss (approver); date_mismatch / readback_mismatch / client_mismatch:
--     acknowledge (approver); opening_blocked: dismiss (finance writer). A note is always required.
CREATE OR REPLACE FUNCTION public.resolve_daftra_review(p_id uuid, p_decision text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_r public.billing_review_items; v_note text; v_roles text[]; v_i public.billing_intents; v_add uuid[]; v_rem uuid[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_r FROM public.billing_review_items r WHERE r.id = p_id;
  IF v_r.id IS NULL OR NOT app.has_tx_role(v_r.transaction_id, app.fin_read_roles())
     OR v_r.kind NOT IN ('manual_in_daftra','date_mismatch','readback_mismatch','client_mismatch','opening_blocked') THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'review_item');
  END IF;
  IF NOT ((v_r.kind = 'manual_in_daftra' AND p_decision IN ('done_in_daftra','dismiss'))
          OR (v_r.kind IN ('date_mismatch','readback_mismatch','client_mismatch') AND p_decision = 'acknowledge')
          OR (v_r.kind = 'opening_blocked' AND p_decision = 'dismiss')) THEN
    PERFORM app.fail('MRS_INVALID', 'decision');
  END IF;
  v_roles := CASE WHEN p_decision = 'done_in_daftra' OR v_r.kind = 'opening_blocked' THEN app.fin_write_roles() ELSE app.fin_approve_roles() END;
  PERFORM app.g3_lock_tx(v_r.transaction_id, v_roles);
  v_note := app.fin_note(p_note, 'note');
  IF v_r.intent_id IS NOT NULL THEN SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = v_r.intent_id FOR UPDATE; END IF;
  SELECT * INTO v_r FROM public.billing_review_items r WHERE r.id = p_id FOR UPDATE;
  IF v_r.status <> 'open' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_r.status); END IF;
  UPDATE public.billing_review_items r SET status = CASE WHEN p_decision = 'dismiss' THEN 'dismissed' ELSE 'resolved' END,
         resolution = p_decision, resolution_note = v_note, resolved_by = auth.uid(), resolved_at = now()
   WHERE r.id = v_r.id RETURNING * INTO v_r;
  IF p_decision = 'done_in_daftra' THEN
    v_add := ARRAY(SELECT (x ->> 'line_id')::uuid FROM jsonb_array_elements(coalesce(v_r.details -> 'add', '[]'::jsonb)) x WHERE x ->> 'line_id' ~ '^[0-9a-f-]{36}$');
    v_rem := ARRAY(SELECT (x ->> 'line_id')::uuid FROM jsonb_array_elements(coalesce(v_r.details -> 'remove', '[]'::jsonb)) x WHERE x ->> 'line_id' ~ '^[0-9a-f-]{36}$');
    UPDATE public.billing_intent_lines l SET state = 'synced', manual_in_daftra = true
     WHERE l.intent_id = v_r.intent_id AND l.id = ANY (v_add) AND l.state = 'pending_add';
    UPDATE public.billing_intent_lines l SET state = 'removed', removed_at = now(), removed_by = auth.uid(),
           removed_reason = coalesce(l.removed_reason, 'removed_in_daftra')
     WHERE l.intent_id = v_r.intent_id AND l.id = ANY (v_rem) AND l.state = 'pending_remove';
    -- review: the invoice is already issued (lines held by bill_mark_issued): the lines added by hand are invoiced now
    IF v_i.status = 'issued' THEN
      PERFORM app.bill_set_charges(ARRAY(SELECT l.charge_id FROM public.billing_intent_lines l
                                          WHERE l.intent_id = v_r.intent_id AND l.id = ANY (v_add) AND l.state = 'synced'), 'invoiced');
    END IF;
    UPDATE public.billing_intents i SET sync_state = CASE WHEN app.bill_has_pending(i.id) THEN 'pending' ELSE 'synced' END
     WHERE i.id = v_r.intent_id AND i.sync_state IN ('pending','synced','error','idle');
  ELSIF p_decision = 'dismiss' AND v_r.kind = 'manual_in_daftra' AND v_i.status = 'issued' THEN
    -- review: issued without the hand edit: the held additions were not billed (removed + late_charge), the removals are gone
    v_add := ARRAY(SELECT (x ->> 'line_id')::uuid FROM jsonb_array_elements(coalesce(v_r.details -> 'add', '[]'::jsonb)) x WHERE x ->> 'line_id' ~ '^[0-9a-f-]{36}$');
    v_rem := ARRAY(SELECT (x ->> 'line_id')::uuid FROM jsonb_array_elements(coalesce(v_r.details -> 'remove', '[]'::jsonb)) x WHERE x ->> 'line_id' ~ '^[0-9a-f-]{36}$');
    INSERT INTO public.billing_review_items (org_id, transaction_id, intent_id, charge_id, kind, details)
    SELECT v_r.org_id, v_r.transaction_id, v_r.intent_id, l.charge_id, 'late_charge', jsonb_build_object('reason', 'not_on_issued')
      FROM public.billing_intent_lines l WHERE l.intent_id = v_r.intent_id AND l.id = ANY (v_add) AND l.state = 'pending_add'
    ON CONFLICT (charge_id, kind) WHERE status = 'open' DO NOTHING;
    UPDATE public.billing_intent_lines l SET state = 'removed', removed_at = now(), removed_by = auth.uid(), removed_reason = 'not_on_issued'
     WHERE l.intent_id = v_r.intent_id AND l.id = ANY (v_add) AND l.state = 'pending_add';
    UPDATE public.billing_intent_lines l SET state = 'removed', removed_at = now(), removed_by = auth.uid(),
           removed_reason = coalesce(l.removed_reason, 'not_on_issued')
     WHERE l.intent_id = v_r.intent_id AND l.id = ANY (v_rem) AND l.state = 'pending_remove';
  END IF;
  PERFORM app.bill_event(v_r.org_id, v_r.transaction_id, 'review_resolved', 'billing_review_item', v_r.id,
    jsonb_build_object('kind', v_r.kind, 'decision', p_decision, 'intent_id', v_r.intent_id));
  RETURN app.bill_review_json(v_r);
END $$;

-- list_daftra_reviews(p_org, {kind, status (default open), branch_id, limit ≤ 200, offset}) → {items, total, counts}
CREATE OR REPLACE FUNCTION public.list_daftra_reviews(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_kind text; v_st text; v_br uuid; v_limit int; v_offset int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.fin_org_read(p_org);
  PERFORM app.only_keys(f, ARRAY['kind','status','branch_id','limit','offset']);
  v_kind := app.ptext(f, 'kind', 40); v_st := coalesce(app.ptext(f, 'status', 20), 'open'); v_br := app.puuid(f, 'branch_id');
  IF v_kind IS NOT NULL AND v_kind NOT IN ('manual_in_daftra','date_mismatch','readback_mismatch','client_mismatch','opening_blocked') THEN
    PERFORM app.fail('MRS_INVALID', 'kind');
  END IF;
  IF v_st NOT IN ('open','resolved','dismissed') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_limit := least(coalesce(app.pnum(f, 'limit', 1000000)::int, 50), 200);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000000)::int, 0);
  RETURN (
    WITH base AS (SELECT r.* FROM public.billing_review_items r JOIN public.transactions t ON t.id = r.transaction_id
                   WHERE r.org_id = p_org AND r.kind IN ('manual_in_daftra','date_mismatch','readback_mismatch','client_mismatch','opening_blocked')
                     AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles()) AND (v_br IS NULL OR t.branch_id = v_br)),
    filtered AS (SELECT * FROM base b WHERE b.status = v_st AND (v_kind IS NULL OR b.kind = v_kind))
    SELECT jsonb_build_object(
      'items', coalesce((SELECT jsonb_agg(app.bill_review_json(r) ORDER BY r.created_at DESC, r.id)
                           FROM public.billing_review_items r
                          WHERE r.id IN (SELECT x.id FROM filtered x ORDER BY x.created_at DESC, x.id LIMIT v_limit OFFSET v_offset)), '[]'::jsonb),
      'total', (SELECT count(*)::int FROM filtered),
      'counts', coalesce((SELECT jsonb_object_agg(z.k, z.n) FROM (SELECT b.kind k, count(*)::int n FROM base b WHERE b.status = 'open' GROUP BY 1) z), '{}'::jsonb)));
END $$;

-- ---------------------------------------------------------------------
-- client import (Daftra pages / the tenant's own file)
-- ---------------------------------------------------------------------
-- request_daftra_client_import(p_org, p_idem_key) — bill_admin: a READ-ONLY paged import of the Daftra clients into staging
CREATE OR REPLACE FUNCTION public.request_daftra_client_import(p_org uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_replay jsonb; v_r public.daftra_runs; v_job jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  v_replay := app.idem_begin('request_daftra_client_import', p_idem_key, jsonb_build_object('org', p_org), p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM app.daftra_need_connection(p_org);
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.org_id = p_org AND r.kind = 'client_import' AND r.status IN ('queued','running');
  IF v_r.id IS NOT NULL THEN
    RETURN app.idem_finish('request_daftra_client_import', p_idem_key, app.daftra_run_json(v_r) || jsonb_build_object('deduplicated', true));
  END IF;
  INSERT INTO public.daftra_runs (org_id, kind, params, cursor, requested_by)
  VALUES (p_org, 'client_import', jsonb_build_object('page_size', 100, 'pages_per_job', 5), jsonb_build_object('page', 1), auth.uid())
  RETURNING * INTO v_r;
  v_job := app.daftra_enqueue(p_org, 'client_import', NULL, v_r.id, NULL, 'p0', '{}'::jsonb, auth.uid());
  RETURN app.idem_finish('request_daftra_client_import', p_idem_key, app.daftra_run_json(v_r) || jsonb_build_object('job', v_job, 'deduplicated', false));
END $$;

-- list_daftra_client_import(p_run, {action, status, q, limit ≤ 500, offset}) → {run, rows, total, counts}
CREATE OR REPLACE FUNCTION public.list_daftra_client_import(p_run uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_r public.daftra_runs; v_act text; v_st text; v_q text; v_limit int; v_offset int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = p_run AND r.kind IN ('client_import','client_file');
  IF v_r.id IS NULL OR NOT app.is_staff(v_r.org_id)
     OR NOT (app.has_role(v_r.org_id, app.fin_read_roles()) OR app.has_role(v_r.org_id, app.daftra_import_roles())) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'run');
  END IF;
  PERFORM app.only_keys(f, ARRAY['action','status','q','limit','offset']);
  v_act := app.ptext(f, 'action', 20); v_st := app.ptext(f, 'status', 20); v_q := app.norm_name(app.ptext(f, 'q', 160));
  v_limit := least(coalesce(app.pnum(f, 'limit', 1000000)::int, 100), 500);
  v_offset := coalesce(app.pnum(f, 'offset', 1000000000)::int, 0);
  RETURN (
    WITH filtered AS (SELECT w.* FROM public.daftra_client_import_rows w WHERE w.run_id = v_r.id
                        AND (v_act IS NULL OR w.proposed_action = v_act) AND (v_st IS NULL OR w.status = v_st)
                        AND (v_q IS NULL OR w.name_norm LIKE '%' || v_q || '%' OR w.client_number = v_q))
    SELECT jsonb_build_object('run', app.daftra_run_json(v_r),
      'rows', coalesce((SELECT jsonb_agg(to_jsonb(w) || jsonb_build_object('match_client_name', (SELECT c.name_ar FROM public.clients c WHERE c.id = w.match_client_id))
                                         ORDER BY w.seq)
                          FROM public.daftra_client_import_rows w WHERE w.id IN (SELECT x.id FROM filtered x ORDER BY x.seq LIMIT v_limit OFFSET v_offset)), '[]'::jsonb),
      'total', (SELECT count(*)::int FROM filtered),
      'counts', coalesce((SELECT jsonb_object_agg(z.k, z.n) FROM (SELECT w.proposed_action || ':' || w.status k, count(*)::int n
                                                                   FROM public.daftra_client_import_rows w WHERE w.run_id = v_r.id GROUP BY 1) z), '{}'::jsonb)));
END $$;

-- apply one staged row (never deletes; a manual category is never overwritten; a Daftra id / client number / VAT already
-- used elsewhere is a recorded conflict, never a silent merge) → the applied action, or 'conflict'
CREATE OR REPLACE FUNCTION app.daftra_import_apply_row(w public.daftra_client_import_rows, p_action text, p_client uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.clients; v_id uuid; v_vat text; v_cr text; v_phone text; v_email text; v_l public.daftra_client_links; v_snap jsonb;
        v_state text; v_msg text; v_code text;
BEGIN
  -- review: the Daftra client number is trusted (and later matched as a safe 'link' proposal of a Daftra import) only when it
  -- comes from Daftra itself or from a file applied by a bill_admin (accounts_manager / admin); a file applied by another
  -- import role (operations_manager) never sets it
  v_code := CASE WHEN w.source = 'daftra' OR app.has_role(w.org_id, app.bill_admin_roles()) THEN w.client_number END;
  IF p_action = 'skip' THEN
    UPDATE public.daftra_client_import_rows x SET status = 'skipped', applied_action = 'skip', applied_by = auth.uid(), applied_at = now() WHERE x.id = w.id;
    RETURN 'skip';
  END IF;
  BEGIN
    v_vat := CASE WHEN regexp_replace(app.to_western(coalesce(w.vat_number, '')), '[^0-9]', '', 'g') ~ '^[0-9]{15}$'
                  THEN regexp_replace(app.to_western(w.vat_number), '[^0-9]', '', 'g') END;
    v_cr := CASE WHEN regexp_replace(app.to_western(coalesce(w.cr_number, '')), '[^0-9]', '', 'g') ~ '^[0-9]{10}$'
                 THEN regexp_replace(app.to_western(w.cr_number), '[^0-9]', '', 'g') END;
    v_phone := app.norm_sa_phone(w.phone);
    v_email := CASE WHEN lower(btrim(coalesce(w.email, ''))) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' THEN lower(btrim(w.email)) END;
    IF p_action = 'create' THEN
      IF w.name_ar IS NULL OR char_length(w.name_ar) < 2 THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_DAFTRA_IMPORT', DETAIL = 'name'; END IF;
      INSERT INTO public.clients (org_id, client_type, name_ar, name_en, vat_number, cr_number, phone, email, port_category, source,
                                  daftra_client_code, is_active)
      VALUES (w.org_id, 'business', w.name_ar, w.name_en,
              CASE WHEN NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.org_id = w.org_id AND c.vat_number = v_vat) THEN v_vat END,
              CASE WHEN NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.org_id = w.org_id AND c.cr_number = v_cr) THEN v_cr END,
              v_phone, v_email, w.port_category, CASE WHEN w.source = 'daftra' THEN 'daftra' ELSE 'import' END,
              v_code, NOT w.suspended)
      RETURNING * INTO v_c;
    ELSE
      SELECT * INTO v_c FROM public.clients c WHERE c.id = p_client AND c.org_id = w.org_id FOR UPDATE;
      IF v_c.id IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_DAFTRA_IMPORT', DETAIL = 'client'; END IF;
      IF v_code IS NOT NULL AND v_c.daftra_client_code IS NOT NULL AND upper(v_c.daftra_client_code) <> upper(v_code) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_DAFTRA_IMPORT', DETAIL = 'client_number_differs';
      END IF;
      -- the existing client keeps its data; only the missing Daftra number and an empty category are filled
      UPDATE public.clients c SET daftra_client_code = coalesce(c.daftra_client_code, v_code),
             port_category = coalesce(c.port_category, w.port_category)
       WHERE c.id = v_c.id RETURNING * INTO v_c;
    END IF;
    IF w.source = 'daftra' AND w.external_id IS NOT NULL THEN
      v_snap := jsonb_build_object('name', w.name_ar, 'name_en', w.name_en, 'vat_number', w.vat_number, 'cr_number', w.cr_number,
                                   'address_short', NULL, 'address', NULL, 'email', w.email, 'phone', w.phone);
      SELECT * INTO v_l FROM public.daftra_client_links l WHERE l.org_id = w.org_id AND l.client_id = v_c.id AND l.status <> 'unlinked' FOR UPDATE;
      IF v_l.id IS NOT NULL AND v_l.external_id IS NOT NULL AND v_l.external_id <> w.external_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_DAFTRA_IMPORT', DETAIL = 'client_linked_elsewhere';
      END IF;
      IF v_l.id IS NULL THEN
        INSERT INTO public.daftra_client_links (org_id, client_id, client_ref, external_id, status, pushed_snapshot, remote_snapshot,
                                                last_synced_at, linked_by, linked_at, created_by)
        VALUES (w.org_id, v_c.id, 'MRSC-' || v_c.id::text, w.external_id, 'linked', v_snap, v_snap, now(), auth.uid(), now(), auth.uid());
      ELSE
        UPDATE public.daftra_client_links l SET external_id = w.external_id, remote_snapshot = v_snap,
               pushed_snapshot = coalesce(l.pushed_snapshot, v_snap), status = CASE WHEN l.status IN ('pending','error','needs_review') THEN 'linked' ELSE l.status END,
               candidates = NULL, last_synced_at = now(), linked_by = coalesce(l.linked_by, auth.uid()), linked_at = coalesce(l.linked_at, now())
         WHERE l.id = v_l.id;
      END IF;
    END IF;
    UPDATE public.daftra_client_import_rows x SET status = 'applied', applied_action = CASE WHEN p_action = 'create' THEN 'create'
             WHEN w.proposed_action = 'update_link' AND p_action = 'link' THEN 'update_link' ELSE 'link' END,
           applied_client_id = v_c.id, applied_by = auth.uid(), applied_at = now(), conflict = NULL
     WHERE x.id = w.id;
    RETURN CASE WHEN p_action = 'create' THEN 'create' WHEN w.proposed_action = 'update_link' THEN 'update_link' ELSE 'link' END;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_state IN ('40P01','40001') THEN RAISE; END IF;
    UPDATE public.daftra_client_import_rows x SET status = 'conflict',
           conflict = jsonb_build_object('reason', CASE WHEN v_msg = 'MRS_DAFTRA_IMPORT' THEN 'rule' WHEN v_state = '23505' THEN 'duplicate' ELSE 'invalid' END,
                                         'code', left(app.bill_scrub_text(v_msg), 120), 'sqlstate', v_state, 'action', p_action)
     WHERE x.id = w.id;
    RETURN 'conflict';
  END;
END $$;

-- apply a staged run: the safe proposals (update_link / link / create) unless apply_safe is false, plus the human decisions
-- (review_name / conflict rows need one: link to a client, create, or skip). Counters back; the run is 'applied' when no
-- row is waiting any more.
CREATE OR REPLACE FUNCTION app.daftra_import_apply(p_r public.daftra_runs, p_decisions jsonb, p_safe boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w public.daftra_client_import_rows; d jsonb; v_act text; v_cl uuid; v_res text; v_cnt jsonb := '{}'::jsonb; v_left int;
        v_dec jsonb := '{}'::jsonb;
BEGIN
  IF p_decisions IS NOT NULL THEN
    IF jsonb_typeof(p_decisions) <> 'array' OR jsonb_array_length(p_decisions) > 2000 THEN PERFORM app.fail('MRS_INVALID', 'decisions'); END IF;
    FOR d IN SELECT x FROM jsonb_array_elements(p_decisions) x LOOP
      IF jsonb_typeof(d) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'decisions'); END IF;
      PERFORM app.only_keys(d, ARRAY['row_id','action','client_id']);
      IF app.puuid(d, 'row_id') IS NULL OR coalesce(d ->> 'action', '') NOT IN ('create','link','skip') THEN PERFORM app.fail('MRS_INVALID', 'decisions'); END IF;
      IF d ->> 'action' = 'link' AND app.puuid(d, 'client_id') IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'client_id'); END IF;
      v_dec := v_dec || jsonb_build_object(d ->> 'row_id', d);
    END LOOP;
  END IF;
  FOR w IN SELECT x.* FROM public.daftra_client_import_rows x WHERE x.run_id = p_r.id AND x.status IN ('pending','conflict') ORDER BY x.seq FOR UPDATE LOOP
    d := v_dec -> w.id::text;
    IF d IS NOT NULL THEN
      v_act := d ->> 'action'; v_cl := CASE WHEN v_act = 'link' THEN app.puuid(d, 'client_id') END;
    ELSIF p_safe AND w.status = 'pending' AND w.proposed_action IN ('update_link','link','create') THEN
      v_act := CASE WHEN w.proposed_action = 'create' THEN 'create' ELSE 'link' END; v_cl := w.match_client_id;
    ELSE
      CONTINUE;
    END IF;
    v_res := app.daftra_import_apply_row(w, v_act, v_cl);
    v_cnt := v_cnt || jsonb_build_object(v_res, coalesce((v_cnt ->> v_res)::int, 0) + 1);
  END LOOP;
  SELECT count(*)::int INTO v_left FROM public.daftra_client_import_rows x WHERE x.run_id = p_r.id AND x.status IN ('pending','conflict');
  UPDATE public.daftra_runs r SET status = CASE WHEN v_left = 0 THEN 'applied' ELSE 'ready' END,
         applied_by = auth.uid(), applied_at = now(),
         counters = r.counters || jsonb_build_object('created', coalesce((r.counters ->> 'created')::int, 0) + coalesce((v_cnt ->> 'create')::int, 0),
                                                     'linked', coalesce((r.counters ->> 'linked')::int, 0) + coalesce((v_cnt ->> 'link')::int, 0),
                                                     'updated', coalesce((r.counters ->> 'updated')::int, 0) + coalesce((v_cnt ->> 'update_link')::int, 0),
                                                     'skipped', coalesce((r.counters ->> 'skipped')::int, 0) + coalesce((v_cnt ->> 'skip')::int, 0),
                                                     'conflicts', (SELECT count(*)::int FROM public.daftra_client_import_rows x WHERE x.run_id = r.id AND x.status = 'conflict'),
                                                     'waiting', v_left)
   WHERE r.id = p_r.id;
  RETURN jsonb_build_object('applied', v_cnt, 'waiting', v_left);
END $$;

-- apply_daftra_client_import(p_run, {decisions?:[{row_id, action: create|link|skip, client_id?}], apply_safe? (default true)}, p_idem_key)
-- bill_admin (a Daftra run) / the import roles (a file run)
CREATE OR REPLACE FUNCTION public.apply_daftra_client_import(p_run uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v_r public.daftra_runs; v_replay jsonb; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = p_run AND r.kind IN ('client_import','client_file');
  IF v_r.id IS NULL OR NOT app.is_staff(v_r.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'run'); END IF;
  IF NOT app.has_role(v_r.org_id, CASE WHEN v_r.kind = 'client_import' THEN app.bill_admin_roles() ELSE app.daftra_import_roles() END) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  PERFORM app.only_keys(p, ARRAY['decisions','apply_safe']);
  IF p ? 'apply_safe' AND jsonb_typeof(p -> 'apply_safe') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'apply_safe'); END IF;
  v_replay := app.idem_begin('apply_daftra_client_import', p_idem_key, jsonb_build_object('run', p_run, 'p', p), v_r.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = p_run FOR UPDATE;
  IF v_r.status NOT IN ('ready','applied') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_r.status); END IF;
  v_res := app.daftra_import_apply(v_r, p -> 'decisions', coalesce((p ->> 'apply_safe')::boolean, true));
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = p_run;
  RETURN app.idem_finish('apply_daftra_client_import', p_idem_key, app.daftra_run_json(v_r) || v_res);
END $$;

-- import_clients(p_org, p_rows [{client_number?, name, name_en?, vat_number?, cr_number?, phone?, email?, city?, port_category?}] ≤ 2000,
--   {dry_run?}, p_idem_key) — the TENANT's own CSV / XLSX rows (never the legacy seed), the same rules as the Daftra import:
--   by client number, then by the normalised Arabic name (review), else a new client. dry_run stages the proposals only.
CREATE OR REPLACE FUNCTION public.import_clients(p_org uuid, p_rows jsonb, p_options jsonb DEFAULT '{}'::jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o jsonb := coalesce(p_options, '{}'::jsonb); v_replay jsonb; v_r public.daftra_runs; x jsonb; v_seq int := 0; v_res jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.daftra_import_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(o, ARRAY['dry_run','file_name']);
  IF o ? 'dry_run' AND jsonb_typeof(o -> 'dry_run') <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', 'dry_run'); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN PERFORM app.fail('MRS_DAFTRA_IMPORT', 'empty'); END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN PERFORM app.fail('MRS_DAFTRA_IMPORT', 'too_many_rows'); END IF;
  v_replay := app.idem_begin('import_clients', p_idem_key, jsonb_build_object('rows', p_rows, 'o', o), p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  FOR x IN SELECT y FROM jsonb_array_elements(p_rows) y LOOP
    IF jsonb_typeof(x) <> 'object' THEN PERFORM app.fin_fail('MRS_DAFTRA_IMPORT', 'row', (v_seq + 1)::text); END IF;
    PERFORM app.only_keys(x, ARRAY['client_number','name','name_en','vat_number','cr_number','phone','email','city','port_category']);
    v_seq := v_seq + 1;
  END LOOP;
  INSERT INTO public.daftra_runs (org_id, kind, status, params, requested_by)
  VALUES (p_org, 'client_file', 'ready', jsonb_strip_nulls(jsonb_build_object('file_name', left(o ->> 'file_name', 200), 'rows', v_seq)), auth.uid())
  RETURNING * INTO v_r;
  v_seq := 0;
  FOR x IN SELECT y FROM jsonb_array_elements(p_rows) y LOOP
    v_seq := v_seq + 1;
    PERFORM app.daftra_import_stage(v_r, v_seq, 'file', x);
  END LOOP;
  UPDATE public.daftra_runs r SET counters = jsonb_build_object('received', v_seq), finished_at = now() WHERE r.id = v_r.id RETURNING * INTO v_r;
  IF NOT coalesce((o ->> 'dry_run')::boolean, false) THEN
    v_res := app.daftra_import_apply(v_r, NULL, true);
    SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = v_r.id;
  END IF;
  RETURN app.idem_finish('import_clients', p_idem_key, app.daftra_run_json(v_r) || v_res || jsonb_build_object('dry_run', coalesce((o ->> 'dry_run')::boolean, false)));
END $$;

-- ---------------------------------------------------------------------
-- invoice lookup / link / legacy scan / read-only refresh
-- ---------------------------------------------------------------------
-- request_daftra_invoice_lookup(p_tx, {mode: number|composite, number?}, p_idem_key) — finance writer of the transaction:
-- a READ-ONLY search of Daftra invoices by number, or by the exact composite (declaration + B/L + containers)
CREATE OR REPLACE FUNCTION public.request_daftra_invoice_lookup(p_tx uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v_t public.transactions; v_replay jsonb; v_mode text; v_num text; v_k jsonb; v_job jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_t := app.g3_lock_tx(p_tx, app.fin_write_roles());
  PERFORM app.only_keys(p, ARRAY['mode','number']);
  v_replay := app.idem_begin('request_daftra_invoice_lookup', p_idem_key, jsonb_build_object('tx', p_tx, 'p', p), v_t.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_mode := coalesce(app.ptext(p, 'mode', 20), 'number');
  IF v_mode NOT IN ('number','composite') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
  PERFORM app.daftra_need_connection(v_t.org_id);
  IF v_mode = 'number' THEN
    v_num := app.ptext(p, 'number', 60);
    IF v_num IS NULL OR regexp_replace(v_num, '[^A-Za-z0-9]', '', 'g') = '' THEN PERFORM app.fail('MRS_REQUIRED', 'number'); END IF;
  ELSE
    v_k := app.daftra_tx_keys(v_t.id);
    IF jsonb_array_length(v_k -> 'declaration_nos') = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'declaration_no'); END IF;
    IF jsonb_array_length(v_k -> 'bl_numbers') = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'bl_number'); END IF;
    IF jsonb_array_length(v_k -> 'containers') = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'containers'); END IF;
  END IF;
  v_job := app.daftra_enqueue(v_t.org_id, 'invoice_lookup', v_t.id, NULL, NULL, v_mode,
                              jsonb_strip_nulls(jsonb_build_object('mode', v_mode, 'number', v_num)), auth.uid());
  RETURN app.idem_finish('request_daftra_invoice_lookup', p_idem_key, jsonb_build_object('transaction_id', v_t.id, 'mode', v_mode, 'job', v_job));
END $$;

-- confirm_invoice_link(p_candidate, {confirm_number, choose_among_multiple?, note?}, p_idem_key) — approver of the transaction:
-- the visual confirmation (the Daftra number typed again) links the found Daftra invoice to the transaction as a 'linked'
-- intent (never edited by Marsa: read-only pulls). Another Daftra client = MRS_DAFTRA_CLIENT_CONFLICT (hard block); more than
-- one exact match needs choose_among_multiple + a note.
CREATE OR REPLACE FUNCTION public.confirm_invoice_link(p_candidate uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v_c public.daftra_invoice_candidates; v_t public.transactions; v_replay jsonb;
        v_cc text; v_other uuid; v_rev int; v_i public.billing_intents; v_cur text; v_note text; v_job jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_c FROM public.daftra_invoice_candidates c WHERE c.id = p_candidate;
  IF v_c.id IS NULL OR v_c.transaction_id IS NULL OR NOT app.has_tx_role(v_c.transaction_id, app.fin_read_roles()) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'candidate');
  END IF;
  v_t := app.g3_lock_tx(v_c.transaction_id, app.fin_approve_roles());
  PERFORM app.only_keys(p, ARRAY['confirm_number','choose_among_multiple','note']);
  v_replay := app.idem_begin('confirm_invoice_link', p_idem_key, jsonb_build_object('candidate', p_candidate, 'p', p), v_t.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  SELECT * INTO v_c FROM public.daftra_invoice_candidates c WHERE c.id = p_candidate FOR UPDATE;
  IF v_c.state = 'blocked' THEN PERFORM app.fail('MRS_DAFTRA_CLIENT_CONFLICT', 'client'); END IF;
  IF v_c.state NOT IN ('open','review') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_c.state); END IF;
  v_note := app.ptext(p, 'note', 2000);
  IF v_c.state = 'review' AND NOT coalesce(app.pbool(p, 'choose_among_multiple'), false) THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'review_required'); END IF;
  IF v_c.state = 'review' AND v_note IS NULL THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
  IF upper(regexp_replace(coalesce(app.ptext(p, 'confirm_number', 60), ''), '[^A-Za-z0-9]', '', 'g'))
     IS DISTINCT FROM upper(regexp_replace(coalesce(v_c.daftra_number, v_c.external_invoice_id), '[^A-Za-z0-9]', '', 'g')) THEN
    PERFORM app.fail('MRS_DAFTRA_CONFIRM_MISMATCH', 'confirm_number');
  END IF;
  -- the client is re-checked now (a link may have changed since the lookup)
  v_cc := app.daftra_client_check(v_t.id, v_c.remote_client_id);
  IF v_cc = 'conflict' THEN
    UPDATE public.daftra_invoice_candidates c SET state = 'blocked', client_check = 'conflict' WHERE c.id = v_c.id;
    PERFORM app.fail('MRS_DAFTRA_CLIENT_CONFLICT', 'client');
  END IF;
  IF v_cc = 'unlinked' THEN PERFORM app.fail('MRS_REQUIRED', 'client_link'); END IF;
  SELECT i.id INTO v_other FROM public.billing_intents i WHERE i.org_id = v_t.org_id AND i.external_invoice_id = v_c.external_invoice_id;
  IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'external_id_taken', v_other::text); END IF;
  v_cur := coalesce(v_c.currency, 'SAR');
  SELECT i.id INTO v_other FROM public.billing_intents i WHERE i.transaction_id = v_t.id AND i.currency = v_cur AND i.purpose_key = 'F' AND i.status <> 'cancelled';
  IF v_other IS NOT NULL THEN PERFORM app.fin_fail('MRS_INVALID', 'intent_taken', v_other::text); END IF;
  SELECT count(*)::int + 1 INTO v_rev FROM public.billing_intents i WHERE i.transaction_id = v_t.id AND i.origin = 'linked';
  INSERT INTO public.billing_intents (org_id, transaction_id, client_id, purpose, purpose_key, currency, revision, operational_ref, origin,
    external_invoice_id, daftra_number, daftra_status, status, sync_state, remote_total, remote_client_id, invoice_date, note, created_by)
  VALUES (v_t.org_id, v_t.id, v_t.client_id, 'final', 'F', v_cur, v_rev, v_t.ref || '/L' || v_rev, 'linked',
    v_c.external_invoice_id, v_c.daftra_number, v_c.daftra_status, 'draft', 'synced', v_c.total, v_c.remote_client_id, v_c.invoice_date,
    left(coalesce(v_note, 'linked Daftra invoice ' || coalesce(v_c.daftra_number, v_c.external_invoice_id)), 2000), auth.uid())
  RETURNING * INTO v_i;
  -- the found state: issued → issued (frozen, financial status / billed through the existing lifecycle), else a draft
  IF v_c.remote_state = 'issued' THEN
    PERFORM app.bill_mark_issued(v_i, jsonb_build_object('remote_totals', jsonb_build_object('total', v_c.total)));
  END IF;
  PERFORM app.bill_tx_financial(v_t.id);
  UPDATE public.daftra_invoice_candidates c SET state = 'linked', linked_intent_id = v_i.id, decided_by = auth.uid(), decided_at = now(),
         note = v_note WHERE c.id = v_c.id;
  UPDATE public.daftra_invoice_candidates c SET state = 'superseded' WHERE c.transaction_id = v_t.id AND c.id <> v_c.id AND c.state IN ('open','review','blocked','partial');
  -- a read-only pull refreshes the full mirror (number, status, totals, payments)
  IF EXISTS (SELECT 1 FROM public.daftra_connections x WHERE x.org_id = v_t.org_id AND x.status = 'connected' AND x.sync_enabled) THEN
    v_job := app.bill_enqueue(v_t.org_id, 'invoice_pull', v_i.id, NULL, NULL, '{}'::jsonb, auth.uid());
  END IF;
  PERFORM app.bill_event(v_i.org_id, v_i.transaction_id, 'invoice_linked', 'billing_intent', v_i.id,
    jsonb_build_object('candidate_id', v_c.id, 'source', v_c.source, 'job_id', v_job -> 'id'));
  SELECT * INTO v_i FROM public.billing_intents i WHERE i.id = v_i.id;
  RETURN app.idem_finish('confirm_invoice_link', p_idem_key, jsonb_build_object('intent', app.bill_intent_json(v_i),
    'candidate', (SELECT app.daftra_candidate_json(c) FROM public.daftra_invoice_candidates c WHERE c.id = v_c.id), 'job', v_job));
END $$;

-- reject_invoice_candidate(p_candidate, p_note) — finance writer of the transaction
CREATE OR REPLACE FUNCTION public.reject_invoice_candidate(p_candidate uuid, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.daftra_invoice_candidates; v_note text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_c FROM public.daftra_invoice_candidates c WHERE c.id = p_candidate;
  IF v_c.id IS NULL OR v_c.transaction_id IS NULL OR NOT app.has_tx_role(v_c.transaction_id, app.fin_read_roles()) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'candidate');
  END IF;
  PERFORM app.g3_lock_tx(v_c.transaction_id, app.fin_write_roles());
  v_note := app.fin_note(p_note, 'note');
  SELECT * INTO v_c FROM public.daftra_invoice_candidates c WHERE c.id = p_candidate FOR UPDATE;
  IF v_c.state NOT IN ('open','review','blocked') THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_c.state); END IF;
  UPDATE public.daftra_invoice_candidates c SET state = 'rejected', decided_by = auth.uid(), decided_at = now(), note = v_note
   WHERE c.id = v_c.id RETURNING * INTO v_c;
  RETURN app.daftra_candidate_json(v_c);
END $$;

-- request_daftra_legacy_scan(p_org, {restart?, page_size? 1..100, pages_per_job? 1..10}, p_idem_key) — bill_admin: the batched,
-- resumable, READ-ONLY back-fill of older Daftra invoices (legacy syncLegacyDaftraInvoicesCompositeR12110HF3). A failed run
-- resumes from its cursor unless restart.
CREATE OR REPLACE FUNCTION public.request_daftra_legacy_scan(p_org uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v_replay jsonb; v_r public.daftra_runs; v_job jsonb; v_ps int; v_pj int; v_resumed boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  IF NOT app.has_role(p_org, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  PERFORM app.only_keys(p, ARRAY['restart','page_size','pages_per_job']);
  v_replay := app.idem_begin('request_daftra_legacy_scan', p_idem_key, p, p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM app.daftra_need_connection(p_org);
  v_ps := coalesce(app.pnum(p, 'page_size', 100)::int, 100);
  v_pj := coalesce(app.pnum(p, 'pages_per_job', 10)::int, 5);
  IF v_ps < 1 OR v_pj < 1 THEN PERFORM app.fail('MRS_INVALID', 'page_size'); END IF;
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.org_id = p_org AND r.kind = 'legacy_scan' AND r.status IN ('queued','running');
  IF v_r.id IS NOT NULL THEN
    RETURN app.idem_finish('request_daftra_legacy_scan', p_idem_key, app.daftra_run_json(v_r) || jsonb_build_object('deduplicated', true));
  END IF;
  IF NOT coalesce(app.pbool(p, 'restart'), false) THEN
    SELECT * INTO v_r FROM public.daftra_runs r WHERE r.org_id = p_org AND r.kind = 'legacy_scan' AND r.status = 'failed'
     ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE;
  END IF;
  IF v_r.id IS NOT NULL THEN
    UPDATE public.daftra_runs r SET status = 'queued', error_code = NULL, error_message = NULL, finished_at = NULL WHERE r.id = v_r.id RETURNING * INTO v_r;
    v_resumed := true;
  ELSE
    INSERT INTO public.daftra_runs (org_id, kind, params, cursor, requested_by)
    VALUES (p_org, 'legacy_scan', jsonb_build_object('page_size', v_ps, 'pages_per_job', v_pj), jsonb_build_object('page', 1), auth.uid())
    RETURNING * INTO v_r;
  END IF;
  v_job := app.daftra_enqueue(p_org, 'legacy_scan', NULL, v_r.id, NULL, 'p' || v_r.pages::text || CASE WHEN v_resumed THEN 'r' ELSE '' END, '{}'::jsonb, auth.uid());
  RETURN app.idem_finish('request_daftra_legacy_scan', p_idem_key, app.daftra_run_json(v_r) || jsonb_build_object('job', v_job, 'resumed', v_resumed, 'deduplicated', false));
END $$;

-- get_daftra_run(p_run) → run (+ the candidates of a legacy scan by state, the suppliers of a supplier search)
CREATE OR REPLACE FUNCTION public.get_daftra_run(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_r public.daftra_runs;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_r FROM public.daftra_runs r WHERE r.id = p_run;
  IF v_r.id IS NULL OR NOT app.is_staff(v_r.org_id)
     OR NOT (app.has_role(v_r.org_id, app.fin_read_roles()) OR (v_r.kind = 'supplier_search')
             OR (v_r.kind = 'client_file' AND app.has_role(v_r.org_id, app.daftra_import_roles()))) THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'run');
  END IF;
  RETURN app.daftra_run_json(v_r) || jsonb_build_object(
    'candidates', CASE WHEN v_r.kind = 'legacy_scan' THEN coalesce((SELECT jsonb_object_agg(x.s, x.n) FROM (
                    SELECT c.state s, count(*)::int n FROM public.daftra_invoice_candidates c JOIN public.transactions t ON t.id = c.transaction_id
                     WHERE c.run_id = v_r.id AND app.has_branch_role(t.org_id, t.branch_id, app.fin_read_roles()) GROUP BY 1) x), '{}'::jsonb) END);
END $$;

-- refresh_tx_daftra(p_tx) — finance reader of the transaction, on opening it: a READ-ONLY pull of its Daftra invoices not
-- read for 15 minutes (draft → still a draft / ready, issued → billed through the existing forward-only lifecycle, which
-- keeps the empty-return gate: billed only from under_billing). Deduplicated per invoice.
CREATE OR REPLACE FUNCTION public.refresh_tx_daftra(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_t public.transactions; r record; v_jobs jsonb := '[]'::jsonb; v_job jsonb; v_n int := 0;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_t := app.fin_tx_read(p_tx);
  IF NOT EXISTS (SELECT 1 FROM public.daftra_connections c WHERE c.org_id = v_t.org_id AND c.status = 'connected' AND c.sync_enabled) THEN
    RETURN jsonb_build_object('transaction_id', v_t.id, 'enqueued', 0, 'reason', 'not_connected', 'jobs', '[]'::jsonb);
  END IF;
  FOR r IN SELECT i.id FROM public.billing_intents i
            WHERE i.transaction_id = v_t.id AND i.external_invoice_id IS NOT NULL AND i.status IN ('draft','issued')
              AND (i.last_pulled_at IS NULL OR i.last_pulled_at < now() - interval '15 minutes') ORDER BY i.created_at LOOP
    v_job := app.bill_enqueue(v_t.org_id, 'invoice_pull', r.id, NULL, NULL, '{}'::jsonb, auth.uid());
    v_jobs := v_jobs || jsonb_build_array(v_job);
    IF NOT (v_job -> 'deduplicated')::boolean THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('transaction_id', v_t.id, 'enqueued', v_n, 'jobs', v_jobs);
END $$;

-- ---------------------------------------------------------------------
-- suppliers and purchase drafts
-- ---------------------------------------------------------------------
-- request_daftra_supplier_search(p_org, {q?, party_id?, trip_id?}, p_idem_key) — transport / finance writers: a READ-ONLY
-- search of the Daftra suppliers (autocomplete); the supplier id is stored only on a unique exact match of the party name
CREATE OR REPLACE FUNCTION public.request_daftra_supplier_search(p_org uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p jsonb := coalesce(p_payload, '{}'::jsonb); v_replay jsonb; v_q text; v_party uuid; v_trip public.transport_trips; v_r public.daftra_runs;
        v_job jsonb; v_pname text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  PERFORM app.only_keys(p, ARRAY['q','party_id','trip_id']);
  IF app.puuid(p, 'trip_id') IS NOT NULL THEN
    SELECT * INTO v_trip FROM public.transport_trips r WHERE r.id = app.puuid(p, 'trip_id') AND r.org_id = p_org;
    IF v_trip.id IS NULL OR NOT app.has_tx_role(v_trip.transaction_id, app.transport_writer_roles() || app.fin_write_roles()) THEN
      PERFORM app.fail('MRS_NOT_FOUND', 'trip');
    END IF;
  ELSIF NOT app.has_role(p_org, app.transport_writer_roles() || app.fin_write_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  v_replay := app.idem_begin('request_daftra_supplier_search', p_idem_key, p, p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM app.daftra_need_connection(p_org);
  v_party := coalesce(app.puuid(p, 'party_id'), v_trip.carrier_id);
  IF v_party IS NOT NULL THEN
    SELECT x.name_ar INTO v_pname FROM public.parties x WHERE x.id = v_party AND x.org_id = p_org;
    IF v_pname IS NULL THEN PERFORM app.fail('MRS_INVALID', 'party_id'); END IF;
  END IF;
  v_q := coalesce(app.ptext(p, 'q', 160), v_pname, v_trip.party_name);
  IF v_q IS NULL OR char_length(v_q) < 2 THEN PERFORM app.fail('MRS_REQUIRED', 'q'); END IF;
  -- review: with a party or a trip, the link is keyed on the PARTY's name (or the trip's party name), never on the typed q
  -- (q only steers the Daftra search); a free search (no party, no trip) links the exact typed name only
  INSERT INTO public.daftra_runs (org_id, kind, params, requested_by)
  VALUES (p_org, 'supplier_search', jsonb_strip_nulls(jsonb_build_object('q', v_q, 'party_id', v_party, 'trip_id', v_trip.id,
          'match_name', CASE WHEN v_party IS NOT NULL THEN v_pname WHEN v_trip.id IS NOT NULL THEN coalesce(v_trip.party_name, v_q) ELSE v_q END)), auth.uid())
  RETURNING * INTO v_r;
  v_job := app.daftra_enqueue(p_org, 'supplier_search', NULL, v_r.id, NULL, 'p0', '{}'::jsonb, auth.uid());
  RETURN app.idem_finish('request_daftra_supplier_search', p_idem_key, app.daftra_run_json(v_r) || jsonb_build_object('job', v_job));
END $$;

-- list_daftra_supplier_links(p_org) — staff of the org (no amount, no secret)
CREATE OR REPLACE FUNCTION public.list_daftra_supplier_links(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'org'); END IF;
  RETURN jsonb_build_object('items', coalesce((SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('party_name',
             (SELECT x.name_ar FROM public.parties x WHERE x.id = l.party_id)) ORDER BY l.name)
           FROM public.daftra_supplier_links l WHERE l.org_id = p_org AND l.status = 'linked'), '[]'::jsonb));
END $$;

-- unlink_daftra_supplier(p_link, p_reason) — bill_admin (accounts_manager / admin, org level), reason required, audited
-- (review): frees the party (or the name) and the Daftra supplier id for a new search; a purchase draft already made with
-- this link keeps it (history); a purchase job not yet sent is failed at its claim (supplier_link).
CREATE OR REPLACE FUNCTION public.unlink_daftra_supplier(p_link uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_l public.daftra_supplier_links; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_l FROM public.daftra_supplier_links l WHERE l.id = p_link;
  IF v_l.id IS NULL OR NOT app.is_staff(v_l.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'supplier_link'); END IF;
  IF NOT app.has_role(v_l.org_id, app.bill_admin_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  v_reason := app.fin_note(p_reason, 'reason', 2000);
  SELECT * INTO v_l FROM public.daftra_supplier_links l WHERE l.id = p_link FOR UPDATE;
  IF v_l.status <> 'linked' THEN PERFORM app.fail('MRS_BAD_TRANSITION', v_l.status); END IF;
  UPDATE public.daftra_supplier_links l SET status = 'unlinked', unlinked_by = auth.uid(), unlinked_at = now(), unlink_reason = v_reason
   WHERE l.id = v_l.id RETURNING * INTO v_l;
  RETURN to_jsonb(v_l) || jsonb_build_object('party_name', (SELECT x.name_ar FROM public.parties x WHERE x.id = v_l.party_id));
END $$;

-- request_daftra_purchase_draft(p_trip, p_idem_key) — finance writer of the trip's transaction; BEHIND the org flag
-- purchase_drafts_enabled (FALSE). One purchase draft per trip from its cost accruals, zero tax, the configured transport
-- product; the supplier must be linked (unique exact match); the KSA guard and the product mapping apply.
CREATE OR REPLACE FUNCTION public.request_daftra_purchase_draft(p_trip uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_trip public.transport_trips; v_t public.transactions; v_replay jsonb; v_conn public.daftra_connections; v_sl public.daftra_supplier_links;
        v_amt numeric; v_acc uuid[]; v_p public.daftra_purchase_drafts; v_job jsonb; v_rev int; v_ref text; v_block text; v_j public.billing_sync_jobs;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_trip FROM public.transport_trips r WHERE r.id = p_trip;
  IF v_trip.id IS NULL OR NOT app.has_tx_role(v_trip.transaction_id, app.fin_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'trip'); END IF;
  v_t := app.g3_lock_tx(v_trip.transaction_id, app.fin_write_roles());
  v_replay := app.idem_begin('request_daftra_purchase_draft', p_idem_key, jsonb_build_object('trip', p_trip), v_t.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  SELECT * INTO v_conn FROM public.daftra_connections c WHERE c.org_id = v_t.org_id;
  IF NOT coalesce(v_conn.purchase_drafts_enabled, false) THEN PERFORM app.fail('MRS_DAFTRA_PURCHASE_DISABLED'); END IF;
  -- one per trip: the existing draft is returned (a failed one re-queued); its Daftra id is never replaced
  SELECT * INTO v_p FROM public.daftra_purchase_drafts p WHERE p.trip_id = v_trip.id AND p.status <> 'cancelled' FOR UPDATE;
  IF v_p.id IS NOT NULL THEN
    SELECT * INTO v_j FROM public.billing_sync_jobs j WHERE j.purchase_id = v_p.id ORDER BY j.created_at DESC, j.id DESC LIMIT 1;
    IF v_p.status = 'draft' OR v_j.status IN ('queued','running','unknown') THEN
      RETURN app.idem_finish('request_daftra_purchase_draft', p_idem_key, to_jsonb(v_p) || jsonb_build_object('job', app.bill_job_json(v_j), 'deduplicated', true));
    END IF;
  END IF;
  PERFORM app.daftra_need_connection(v_t.org_id);
  v_block := app.daftra_account_block(v_t.org_id);
  IF v_block IS NOT NULL THEN PERFORM app.fail('MRS_DAFTRA_ACCOUNT_NOT_KSA', v_block); END IF;
  IF v_trip.status = 'cancelled' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'trip_cancelled'); END IF;
  IF coalesce(v_trip.party_type, '') NOT IN ('supplier','company') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'party_type'); END IF;
  SELECT * INTO v_sl FROM public.daftra_supplier_links l
   WHERE l.org_id = v_t.org_id AND l.status = 'linked'
     AND ((v_trip.carrier_id IS NOT NULL AND l.party_id = v_trip.carrier_id)
          OR (l.party_id IS NULL AND l.name_norm = app.norm_name(v_trip.party_name)))
   ORDER BY (l.party_id IS NOT NULL) DESC LIMIT 1;
  IF v_sl.id IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'supplier_link'); END IF;
  IF cardinality(app.daftra_unmapped(v_t.org_id, ARRAY[v_conn.purchase_item])) > 0 THEN
    PERFORM app.fin_fail('MRS_DAFTRA_UNMAPPED', 'items', v_conn.purchase_item);
  END IF;
  SELECT coalesce(sum(a.amount), 0), coalesce(array_agg(a.id ORDER BY a.created_at), '{}') INTO v_amt, v_acc
    FROM public.cost_accruals a WHERE a.trip_id = v_trip.id AND a.status <> 'void' AND a.amount IS NOT NULL AND a.currency = 'SAR';
  IF v_amt <= 0 THEN PERFORM app.fail('MRS_REQUIRED', 'cost_accruals'); END IF;
  IF v_p.id IS NOT NULL THEN
    -- a failed draft without a Daftra id is queued again with the same reference (the worker searches it first)
    UPDATE public.daftra_purchase_drafts p SET amount = CASE WHEN p.external_purchase_id IS NULL THEN v_amt ELSE p.amount END,
           accrual_ids = CASE WHEN p.external_purchase_id IS NULL THEN v_acc ELSE p.accrual_ids END,
           status = CASE WHEN p.status = 'failed' THEN 'open' ELSE p.status END,
           sync_state = CASE WHEN p.sync_state = 'unknown' OR app.daftra_purchase_unreconciled(p.id) THEN 'unknown' ELSE 'pending' END,   -- review
           supplier_link_id = CASE WHEN p.external_purchase_id IS NULL THEN v_sl.id ELSE p.supplier_link_id END
     WHERE p.id = v_p.id RETURNING * INTO v_p;
  ELSE
    SELECT count(*)::int + 1 INTO v_rev FROM public.daftra_purchase_drafts p WHERE p.trip_id = v_trip.id;
    v_ref := 'MRSP-' || upper(substr(replace(v_trip.id::text, '-', ''), 1, 12)) || CASE WHEN v_rev > 1 THEN '-R' || v_rev ELSE '' END;
    INSERT INTO public.daftra_purchase_drafts (org_id, transaction_id, trip_id, supplier_link_id, reference, amount, currency, accrual_ids, item_key, created_by)
    VALUES (v_t.org_id, v_t.id, v_trip.id, v_sl.id, v_ref, v_amt, 'SAR', v_acc, v_conn.purchase_item, auth.uid())
    RETURNING * INTO v_p;
  END IF;
  v_job := app.daftra_enqueue(v_t.org_id, 'purchase_push', NULL, NULL, v_p.id, NULL, '{}'::jsonb, auth.uid());
  PERFORM app.bill_event(v_t.org_id, v_t.id, 'purchase_requested', 'daftra_purchase_draft', v_p.id,
    jsonb_build_object('trip_id', v_trip.id, 'job_id', v_job -> 'id'));
  RETURN app.idem_finish('request_daftra_purchase_draft', p_idem_key, to_jsonb(v_p) || jsonb_build_object('job', v_job, 'deduplicated', false));
END $$;

-- one Daftra product ↔ one item key PER NAMESPACE (G5 index widened: a fin_service key and an org service item may share the
-- product; two keys of the same namespace never do)
DROP INDEX IF EXISTS public.daftra_item_links_external_uidx;
CREATE UNIQUE INDEX daftra_item_links_external_uidx ON public.daftra_item_links (org_id, (item_key LIKE 'item:%'), external_product_id)
  WHERE external_product_id IS NOT NULL AND status <> 'retired';

-- ---------------------------------------------------------------------
-- conversion lists (20261122000100 §5, re-created): + the 5 step-7 tables and their no-delete guards
-- ---------------------------------------------------------------------
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
    'public.msg_contacts', 'public.msg_contact_addresses', 'public.msg_contact_authorizations', 'public.msg_mock_mailboxes'
  ]::text[]
$$;

CREATE OR REPLACE FUNCTION app.convert_delete_guards() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    'public.transaction_events:trg_append_only', 'public.charge_collections:trg_append_only',
    'public.supplier_payments:trg_append_only', 'public.billing_sync_attempts:trg_append_only',
    'public.msg_ai_runs:trg_append_only', 'public.msg_attachments:trg_append_only',
    'public.msg_classifications:trg_append_only', 'public.msg_delivery_events:trg_append_only',
    'public.msg_extractions:trg_append_only', 'public.msg_job_attempts:trg_append_only',
    'public.msg_message_events:trg_append_only', 'public.msg_messages:trg_append_only',
    'public.msg_outbound:trg_append_only', 'public.msg_reply_approvals:trg_append_only',
    'public.msg_reply_versions:trg_append_only', 'public.msg_summaries:trg_append_only',
    'public.msg_thread_links:trg_append_only',
    'public.msg_contact_addresses:trg_no_delete', 'public.msg_contact_authorizations:trg_no_delete',
    'public.msg_contacts:trg_no_delete', 'public.msg_jobs:trg_no_delete', 'public.msg_replies:trg_no_delete',
    'public.msg_threads:trg_no_delete',
    'public.document_matches:trg_no_delete',
    'public.doc_batches:trg_no_delete', 'public.doc_batch_documents:trg_no_delete',
    'public.transaction_shipment_data:trg_no_delete', 'public.shipment_invoice_items:trg_no_delete',
    'public.shipment_packing_items:trg_no_delete',
    'public.declaration_approvals:trg_no_delete', 'public.declaration_items:trg_no_delete',
    'public.hs_reference:trg_no_delete',
    'public.appointment_drafts:trg_no_delete', 'public.appointment_draft_cards:trg_no_delete',
    'public.empty_return_proofs:trg_no_delete',
    'public.client_disbursements:trg_no_delete', 'public.disbursement_allocations:trg_no_delete',             -- PAY
    'public.payment_documents:trg_no_delete', 'public.client_custody_entries:trg_no_delete',                   -- PAY
    'public.daftra_runs:trg_no_delete', 'public.daftra_client_import_rows:trg_no_delete',                      -- L7
    'public.daftra_invoice_candidates:trg_no_delete', 'public.daftra_supplier_links:trg_no_delete',            -- L7
    'public.daftra_purchase_drafts:trg_no_delete'                                                              -- L7
  ]::text[]
$$;

-- ---------------------------------------------------------------------
-- 6. RLS, policies, grants, function privileges — finance readers (branch scope through the transaction); supplier links:
--    staff of the org; clients: nothing
-- ---------------------------------------------------------------------
ALTER TABLE public.daftra_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daftra_client_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daftra_invoice_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daftra_supplier_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daftra_purchase_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.daftra_runs, public.daftra_client_import_rows, public.daftra_invoice_candidates, public.daftra_supplier_links,
  public.daftra_purchase_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.daftra_runs, public.daftra_client_import_rows, public.daftra_invoice_candidates, public.daftra_supplier_links,
  public.daftra_purchase_drafts TO authenticated;
DROP POLICY IF EXISTS daftra_runs_select ON public.daftra_runs;
CREATE POLICY daftra_runs_select ON public.daftra_runs FOR SELECT TO authenticated
  USING (app.has_role(org_id, app.fin_read_roles()) OR (kind = 'supplier_search' AND app.is_staff(org_id)));
DROP POLICY IF EXISTS daftra_client_import_rows_select ON public.daftra_client_import_rows;
CREATE POLICY daftra_client_import_rows_select ON public.daftra_client_import_rows FOR SELECT TO authenticated
  USING (app.has_role(org_id, app.fin_read_roles()));
DROP POLICY IF EXISTS daftra_invoice_candidates_select ON public.daftra_invoice_candidates;
CREATE POLICY daftra_invoice_candidates_select ON public.daftra_invoice_candidates FOR SELECT TO authenticated
  USING (CASE WHEN transaction_id IS NOT NULL THEN app.has_tx_role(transaction_id, app.fin_read_roles())
              ELSE app.has_role(org_id, app.fin_read_roles()) END);
DROP POLICY IF EXISTS daftra_supplier_links_select ON public.daftra_supplier_links;
CREATE POLICY daftra_supplier_links_select ON public.daftra_supplier_links FOR SELECT TO authenticated
  USING (app.is_staff(org_id));
DROP POLICY IF EXISTS daftra_purchase_drafts_select ON public.daftra_purchase_drafts;
CREATE POLICY daftra_purchase_drafts_select ON public.daftra_purchase_drafts FOR SELECT TO authenticated
  USING (app.has_tx_role(transaction_id, app.fin_read_roles()));

-- the helpers stay revoked (SECURITY DEFINER RPCs and the worker RPCs run as the owner)
REVOKE EXECUTE ON FUNCTION app.daftra_code_norm(text), app.daftra_allow_update(uuid), app.daftra_allow_create(uuid), app.daftra_write_kinds(),
  app.daftra_account_check(public.daftra_connections), app.daftra_account_block(uuid), app.daftra_custom_values(uuid),
  app.daftra_custom_fields(uuid), app.daftra_item_mapped(uuid, text), app.daftra_unmapped(uuid, text[]),
  app.daftra_line_meta(public.client_charges), app.daftra_review_open(uuid, uuid, uuid, text, jsonb), app.daftra_manual_refresh(uuid),
  app.tg_bill_line_hf5(), app.daftra_enqueue(uuid, text, uuid, uuid, uuid, text, jsonb, uuid), app.daftra_push_block(public.billing_intents),
  app.daftra_opening_try(uuid, text), app.tg_daftra_opening(), app.daftra_run_json(public.daftra_runs),
  app.daftra_candidate_json(public.daftra_invoice_candidates), app.daftra_tx_keys(uuid), app.daftra_invoice_match(uuid, jsonb),
  app.daftra_client_check(uuid, text), app.daftra_missing_caps(public.daftra_connections),
  app.daftra_fail_at_claim(public.billing_sync_jobs, text, text, text), app.daftra_check_client(public.billing_intents, text),
  app.daftra_invoice_row(jsonb), app.daftra_apply_lookup(public.billing_sync_jobs, jsonb), app.daftra_apply_scan(public.billing_sync_jobs, jsonb),
  app.daftra_import_propose(uuid, text, text, text), app.daftra_import_stage(public.daftra_runs, int, text, jsonb),
  app.daftra_apply_client_import(public.billing_sync_jobs, jsonb), app.daftra_apply_product_match(public.billing_sync_jobs, jsonb),
  app.daftra_apply_supplier_search(public.billing_sync_jobs, jsonb),
  app.daftra_apply_purchase(public.billing_sync_jobs, text, jsonb, jsonb, boolean),
  app.daftra_apply_run_error(public.billing_sync_jobs, text, jsonb, boolean), app.daftra_is_owner(uuid), app.daftra_import_roles(),
  app.daftra_need_connection(uuid), app.daftra_import_apply_row(public.daftra_client_import_rows, text, uuid),
  app.daftra_import_apply(public.daftra_runs, jsonb, boolean), app.tg_daftra_no_delete(),
  app.daftra_setting_block(public.billing_sync_jobs), app.daftra_purchase_unreconciled(uuid)
FROM PUBLIC, anon, authenticated, service_role;
-- re-created G5 / step-1 / step-6 functions: privileges as in their first migration (CREATE OR REPLACE keeps them; restated)
REVOKE EXECUTE ON FUNCTION app.bill_check_item_key(text), app.bill_item_defaults(uuid, text), app.bill_add_lines(public.billing_intents, uuid[]),
  app.bill_eligible(uuid, text), app.bill_conn_json(uuid), app.bill_conn_block(uuid), app.bill_job_json(public.billing_sync_jobs),
  app.bill_ctx_item(public.daftra_item_links), app.bill_job_context(public.billing_sync_jobs, uuid, text),
  app.bill_mark_issued(public.billing_intents, jsonb), app.bill_apply_pull(public.billing_intents, jsonb),
  app.bill_apply_push_ok(public.billing_intents, jsonb, uuid),
  app.bill_apply_probe(public.billing_sync_jobs, public.billing_sync_attempts, text, jsonb, jsonb, boolean),
  app.bill_complete(public.billing_sync_jobs, public.billing_sync_attempts, jsonb, jsonb)
FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.bill_can_read_job(public.billing_sync_jobs) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.bill_can_read_job(public.billing_sync_jobs) TO authenticated;
REVOKE EXECUTE ON FUNCTION app.convert_delete_tables(), app.convert_delete_guards() FROM PUBLIC, anon, authenticated, service_role;
-- worker RPCs: service_role only
REVOKE ALL ON FUNCTION public.daftra_claim_jobs(text, int), public.daftra_complete_job(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.daftra_claim_jobs(text, int), public.daftra_complete_job(uuid, jsonb) TO service_role;
-- staff RPCs: authenticated only (each checks its roles itself)
REVOKE ALL ON FUNCTION public.request_billing_push(uuid, uuid), public.retry_billing_job(uuid), public.tx_billing(uuid),
  public.save_daftra_connection(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_billing_push(uuid, uuid), public.retry_billing_job(uuid), public.tx_billing(uuid),
  public.save_daftra_connection(uuid, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.cancel_transaction(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_transaction(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.set_daftra_write_policy(uuid, jsonb, text), public.save_daftra_custom_fields(uuid, jsonb),
  public.test_daftra_custom_fields(uuid), public.list_daftra_product_map(uuid), public.save_daftra_product_code(uuid, text, text),
  public.request_daftra_product_match(uuid, jsonb, uuid), public.confirm_daftra_product_mapping(uuid, text, jsonb),
  public.retry_daftra_opening(uuid, uuid), public.resolve_daftra_review(uuid, text, text), public.list_daftra_reviews(uuid, jsonb),
  public.request_daftra_client_import(uuid, uuid), public.list_daftra_client_import(uuid, jsonb),
  public.apply_daftra_client_import(uuid, jsonb, uuid), public.import_clients(uuid, jsonb, jsonb, uuid),
  public.request_daftra_invoice_lookup(uuid, jsonb, uuid), public.confirm_invoice_link(uuid, jsonb, uuid),
  public.reject_invoice_candidate(uuid, text), public.request_daftra_legacy_scan(uuid, jsonb, uuid), public.get_daftra_run(uuid),
  public.refresh_tx_daftra(uuid), public.request_daftra_supplier_search(uuid, jsonb, uuid), public.list_daftra_supplier_links(uuid), public.unlink_daftra_supplier(uuid, text),
  public.request_daftra_purchase_draft(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_daftra_write_policy(uuid, jsonb, text), public.save_daftra_custom_fields(uuid, jsonb),
  public.test_daftra_custom_fields(uuid), public.list_daftra_product_map(uuid), public.save_daftra_product_code(uuid, text, text),
  public.request_daftra_product_match(uuid, jsonb, uuid), public.confirm_daftra_product_mapping(uuid, text, jsonb),
  public.retry_daftra_opening(uuid, uuid), public.resolve_daftra_review(uuid, text, text), public.list_daftra_reviews(uuid, jsonb),
  public.request_daftra_client_import(uuid, uuid), public.list_daftra_client_import(uuid, jsonb),
  public.apply_daftra_client_import(uuid, jsonb, uuid), public.import_clients(uuid, jsonb, jsonb, uuid),
  public.request_daftra_invoice_lookup(uuid, jsonb, uuid), public.confirm_invoice_link(uuid, jsonb, uuid),
  public.reject_invoice_candidate(uuid, text), public.request_daftra_legacy_scan(uuid, jsonb, uuid), public.get_daftra_run(uuid),
  public.refresh_tx_daftra(uuid), public.request_daftra_supplier_search(uuid, jsonb, uuid), public.list_daftra_supplier_links(uuid), public.unlink_daftra_supplier(uuid, text),
  public.request_daftra_purchase_draft(uuid, uuid)
TO authenticated;
