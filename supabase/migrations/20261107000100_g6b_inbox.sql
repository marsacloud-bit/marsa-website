-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 20261107000100 — G6b: official channels, unified inbox, reference
-- extraction, documented matching and approved replies (docs/online/G6B_SPEC.md). Builds on G6a.
--
-- NO real mailbox, NO WhatsApp Business account, NO network, NO key, NO LLM call. Channels are per-org rows
-- (email | whatsapp) with mode mock | live_pending and a status; secrets are never stored (Vault names reserved:
-- msg_email_credential:<channel>, msg_whatsapp_token:<channel>, msg_webhook_secret:<channel>; worker only).
-- Message and attachment text is DATA, never instructions: nothing read from a body, subject, header, file name
-- or attachment text can change a recipient, an attachment, an approval, a send, a role, a setting, or a link
-- beyond the matching rules. Approval and send are two separate recorded facts; a send happens only by
-- send_msg_reply (staff with a send role, valid approval) and the worker sends through the MOCK adapter only.
--   P. preflight (G6a applied) + schema_versions row
--   0. dictionaries, transaction_events type 'message', pure helpers
--   1. tables  msg_settings, msg_channels, msg_contacts(+addresses, authorizations), msg_threads, msg_messages,
--              msg_message_events, msg_attachments, msg_replies, msg_ai_runs, msg_extractions, msg_classifications,
--              msg_summaries, msg_thread_links, msg_instructions, msg_templates, msg_reply_versions,
--              msg_reply_approvals, msg_outbound, msg_delivery_events, msg_auto_reply_policies, msg_jobs,
--              msg_job_attempts, msg_mock_mailboxes
--   2. triggers (append-only, guards, spans, link history)   3. internal helpers (matching, triage, ingest, sharing)
--   4. staff RPCs (authenticated)   5. worker / ingest RPCs (service_role only)
--   6. bucket 'messages', RLS, policies, audit, privileges
-- Adds no column to an existing table; replaces no pre-G6b function or policy (only the event-type CHECK is
-- recreated as the full G5 list + 'message'). Re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).
-- Re-paste rule: never re-paste g3/g4/g5_apply.sql alone after this file (they narrow the event-type CHECK).
-- =====================================================================

SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------
-- P. preflight (read-only)
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261106000100') THEN
    RAISE EXCEPTION 'G6b preflight: apply G6a first (schema_versions lacks 20261106000100 g6a_portal_reports)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261107000100', 'g6b_inbox')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 0. dictionaries (internal: client_visible = false)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('msg_channel_kind','email',1,'بريد إلكتروني','E-mail',false),
  ('msg_channel_kind','whatsapp',2,'واتساب','WhatsApp',false),
  ('msg_channel_mode','mock',1,'محاكاة تجريبية','Mock (simulation)',false),
  ('msg_channel_mode','live_pending',2,'حساب حقيقي — غير مُعدّ','Live account — not configured',false),
  ('msg_channel_status','not_connected',1,'غير متصل','Not connected',false),
  ('msg_channel_status','connected',2,'متصل','Connected',false),
  ('msg_channel_status','error',3,'خطأ','Error',false),
  ('msg_channel_status','disabled',4,'موقوف','Disabled',false),
  ('msg_thread_status','new',1,'جديدة','New',false),
  ('msg_thread_status','in_progress',2,'قيد المتابعة','In progress',false),
  ('msg_thread_status','awaiting_external',3,'بانتظار رد الجهة','Awaiting external reply',false),
  ('msg_thread_status','awaiting_internal',4,'بانتظار إجراء داخلي','Awaiting internal action',false),
  ('msg_thread_status','resolved',5,'منتهية','Resolved',false),
  ('msg_thread_status','spam',6,'غير مرغوب','Spam',false),
  ('msg_priority','low',1,'منخفضة','Low',false),
  ('msg_priority','normal',2,'عادية','Normal',false),
  ('msg_priority','high',3,'عالية','High',false),
  ('msg_priority','urgent',4,'عاجلة','Urgent',false),
  ('msg_match_status','unmatched',1,'غير مربوطة','Not linked',false),
  ('msg_match_status','suggested',2,'ربط مقترح','Suggested link',false),
  ('msg_match_status','auto_linked',3,'مربوطة آليًا','Auto-linked',false),
  ('msg_match_status','linked',4,'مربوطة بتأكيد موظف','Linked by staff',false),
  ('msg_match_status','review',5,'تحتاج مراجعة الربط','Link needs review',false),
  ('msg_match_status','not_related',6,'لا تخص معاملة','Not related to a transaction',false),
  ('msg_category','telex_release',1,'طلب تلكس / إفراج','Telex / release request',false),
  ('msg_category','delivery_order',2,'إذن تسليم','Delivery order',false),
  ('msg_category','freight_charges',3,'رسوم الشحن','Freight charges',false),
  ('msg_category','appointment',4,'موعد','Appointment',false),
  ('msg_category','missing_documents',5,'مستندات ناقصة','Missing documents',false),
  ('msg_category','violation',6,'مخالفة','Violation',false),
  ('msg_category','empty_return',7,'متابعة إرجاع الفارغ','Empty return follow-up',false),
  ('msg_category','general_inquiry',8,'استفسار عام','General inquiry',false),
  ('msg_category','unknown',9,'غير مصنفة','Unclassified',false),
  ('msg_sender_status','unknown',1,'جهة غير معروفة','Unknown sender',false),
  ('msg_sender_status','known',2,'عنوان معروف — غير موثق','Known address — not verified',false),
  ('msg_sender_status','verified',3,'عنوان موثق','Verified address',false),
  ('msg_sender_status','mismatch',4,'اختلاف في هوية المرسل','Sender identity mismatch',false),
  ('msg_sender_status','spoof_suspected',5,'اشتباه انتحال','Spoofing suspected',false),
  ('msg_extraction_kind','bl_number',1,'رقم البوليصة','B/L number',false),
  ('msg_extraction_kind','container_no',2,'رقم الحاوية','Container number',false),
  ('msg_extraction_kind','declaration_no',3,'رقم البيان','Declaration number',false),
  ('msg_extraction_kind','invoice_no',4,'رقم الفاتورة','Invoice number',false),
  ('msg_extraction_kind','tx_ref',5,'مرجع المعاملة','Transaction reference',false),
  ('msg_extraction_kind','date',6,'تاريخ','Date',false),
  ('msg_extraction_kind','appointment_no',7,'رقم الموعد','Appointment number',false),
  ('msg_extraction_status','suggested',1,'مقترح','Suggested',false),
  ('msg_extraction_status','confirmed',2,'مؤكد','Confirmed',false),
  ('msg_extraction_status','corrected',3,'مصحح','Corrected',false),
  ('msg_extraction_status','rejected',4,'مرفوض','Rejected',false),
  ('msg_reply_status','draft',1,'مسودة','Draft',false),
  ('msg_reply_status','pending_approval',2,'بانتظار الاعتماد','Pending approval',false),
  ('msg_reply_status','approved',3,'معتمد — لم يُرسل','Approved — not sent',false),
  ('msg_reply_status','rejected',4,'مرفوض','Rejected',false),
  ('msg_reply_status','sending',5,'قيد الإرسال','Sending',false),
  ('msg_reply_status','sent',6,'أُرسل','Sent',false),
  ('msg_reply_status','send_failed',7,'فشل الإرسال','Send failed',false),
  ('msg_reply_status','send_unknown',8,'نتيجة الإرسال غير معروفة','Send result unknown',false),
  ('msg_reply_status','cancelled',9,'ملغى','Cancelled',false),
  ('msg_outbound_state','queued',1,'في الانتظار','Queued',false),
  ('msg_outbound_state','sending',2,'قيد الإرسال','Sending',false),
  ('msg_outbound_state','accepted',3,'قبِله مزود الخدمة — لم يثبت الاستلام','Accepted by the provider — delivery not proven',false),
  ('msg_outbound_state','delivered',4,'تم التسليم','Delivered',false),
  ('msg_outbound_state','read',5,'تمت القراءة','Read',false),
  ('msg_outbound_state','failed',6,'فشل','Failed',false),
  ('msg_outbound_state','unknown',7,'غير معروفة','Unknown',false),
  ('msg_job_kind','probe',1,'فحص القناة','Channel probe',false),
  ('msg_job_kind','poll',2,'جلب الرسائل','Fetch messages',false),
  ('msg_job_kind','process',3,'تحليل الرسالة','Process message',false),
  ('msg_job_kind','draft',4,'إعداد مسودة','Prepare draft',false),
  ('msg_job_kind','send',5,'إرسال','Send',false),
  ('msg_job_kind','status',6,'تحديث حالة التسليم','Delivery status',false),
  ('msg_job_status','queued',1,'في الانتظار','Queued',false),
  ('msg_job_status','running',2,'قيد التنفيذ','Running',false),
  ('msg_job_status','unknown',3,'بانتظار المطابقة','Awaiting reconciliation',false),
  ('msg_job_status','done',4,'تمت','Done',false),
  ('msg_job_status','conflict',5,'تعارض','Conflict',false),
  ('msg_job_status','failed',6,'فشلت','Failed',false),
  ('msg_job_status','dead',7,'استنفدت المحاولات','Attempts exhausted',false),
  ('msg_job_status','cancelled',8,'أُلغيت','Cancelled',false),
  ('msg_instruction_kind','style',1,'الأسلوب','Style',false),
  ('msg_instruction_kind','language',2,'اللغة','Language',false),
  ('msg_instruction_kind','party_rule',3,'قاعدة جهة','Party rule',false),
  ('msg_instruction_kind','topic_rule',4,'قاعدة موضوع','Topic rule',false),
  ('msg_instruction_kind','approval_level',5,'مستوى الموافقة','Approval level',false),
  ('msg_instruction_kind','signature',6,'التوقيع','Signature',false),
  ('msg_lib_status','draft',1,'مسودة','Draft',false),
  ('msg_lib_status','approved',2,'معتمد','Approved',false),
  ('msg_lib_status','retired',3,'موقوف','Retired',false),
  ('msg_template_key','telex_release',1,'طلب إفراج التلكس','Telex release',false),
  ('msg_template_key','delivery_order',2,'طلب إذن التسليم','Delivery order',false),
  ('msg_template_key','freight_charges',3,'طلب فاتورة رسوم الشحن','Freight charges',false),
  ('msg_template_key','empty_return_instructions',4,'تعليمات إرجاع الفارغ','Empty return instructions',false),
  ('msg_template_key','missing_documents',5,'المستندات الناقصة','Missing documents',false),
  ('msg_template_key','violation_response',6,'الرد على المخالفة','Violation response',false),
  ('msg_template_key','clarification',7,'طلب إيضاح','Clarification',false),
  ('msg_template_key','ack_receipt',8,'تأكيد استلام','Acknowledge receipt',false),
  ('msg_risk_flag','injection_suspected',1,'نص يشبه تعليمات للنظام — تم تجاهله','Text resembling system instructions — ignored',false),
  ('msg_risk_flag','foreign_address',2,'عنوان خارجي داخل النص','Foreign address in the text',false),
  ('msg_risk_flag','urgency_claim',3,'ادعاء استعجال','Urgency claim',false),
  ('msg_risk_flag','repeated_violation',4,'مخالفة متكررة','Repeated violation',false),
  ('msg_risk_flag','sender_unverified',5,'المرسل غير موثق','Sender not verified',false),
  ('msg_risk_flag','not_addressed_to_channel',6,'لم تُرسل إلى عنوان القناة مباشرة','Not addressed to the channel directly',false),
  ('msg_risk_flag','invalid_check_digit',7,'رقم حاوية بخانة تحقق خاطئة','Container number with a wrong check digit',false),
  ('msg_risk_flag','ambiguous_date',8,'تاريخ غامض الصيغة','Ambiguous date format',false),
  ('msg_auto_reply_kind','ack_receipt',1,'تأكيد استلام','Acknowledge receipt',false),
  ('msg_auto_reply_kind','status_update',2,'تحديث حالة عام','General status update',false)
ON CONFLICT (domain, code) DO UPDATE
  SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      client_visible = EXCLUDED.client_visible;

-- messaging events (internal; payload {op, entity, id, thread_id, …ids}, never bodies / subjects / addresses):
-- the full G5 list + 'message'
ALTER TABLE public.transaction_events DROP CONSTRAINT IF EXISTS transaction_events_event_type_check;
ALTER TABLE public.transaction_events ADD CONSTRAINT transaction_events_event_type_check CHECK (event_type IN
  ('created','request_converted','operational_status','financial_status','container_return','document','note','tracking_token',
   -- G3 (A): declarations, B/L links, container operational state
   'declaration','bl','container',
   -- G3 (B): appointments, transport trips, operational exceptions, document-requirement overrides
   'appointment','trip','exception','docs_override',
   -- G4: finance (internal; payload {op, entity, id, …ids}, never amounts)
   'finance',
   -- G5: billing / Daftra sync (internal; payload {op, entity, id, …ids}, never amounts nor bodies)
   'billing',
   -- G6b: messaging (internal; payload {op, entity, id, thread_id, …}, never bodies, subjects, addresses)
   'message'));

-- ---------------------------------------------------------------------
-- roles (IMMUTABLE, revoked from the API roles; RLS policies spell the arrays inline)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.msg_read_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clearance_staff','transport_staff','accountant','accounts_manager','operations_manager','branch_manager','supervisor','admin']
$$;
CREATE OR REPLACE FUNCTION app.msg_triage_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clearance_staff','transport_staff','accountant','accounts_manager','operations_manager','branch_manager','admin']
$$;
CREATE OR REPLACE FUNCTION app.msg_approve_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['operations_manager','branch_manager','supervisor','admin']
$$;
CREATE OR REPLACE FUNCTION app.msg_send_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['clearance_staff','operations_manager','branch_manager','admin']
$$;
CREATE OR REPLACE FUNCTION app.msg_verify_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT app.msg_approve_roles()
$$;
CREATE OR REPLACE FUNCTION app.msg_lib_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['admin','operations_manager']
$$;
CREATE OR REPLACE FUNCTION app.msg_admin_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['admin']
$$;
-- approval level → roles (§16)
CREATE OR REPLACE FUNCTION app.msg_level_roles(p_level text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_level WHEN 'finance' THEN ARRAY['accounts_manager','branch_manager','admin']
                      WHEN 'management' THEN ARRAY['branch_manager','admin']
                      ELSE app.msg_approve_roles() END
$$;
-- G6b-10 sensitive document kinds
CREATE OR REPLACE FUNCTION app.msg_sensitive_kinds() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['commercial_invoice','customs_declaration','bill_of_lading','certificate_of_origin','saber_certificate',
               'operator_invoice','government_doc','import_file','packing_list']
$$;
-- channel capability keys (probe effects)
CREATE OR REPLACE FUNCTION app.msg_capability_keys() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['send','lookup_send','status_events','attachments','threading','templates']
$$;
-- template placeholders (§22)
CREATE OR REPLACE FUNCTION app.msg_placeholders() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['tx_ref','bl_number','declaration_no','container_list','client_name','counterpart_name','operation_label',
               'appointment_at','terminal_name','return_deadline_list','missing_documents_list','org_name','signature','today']
$$;
-- summary action codes (§15)
CREATE OR REPLACE FUNCTION app.msg_action_codes() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['send_telex','issue_do','pay_or_query_charges','book_or_confirm_appointment','provide_documents','respond_violation',
               'arrange_empty_return','answer_inquiry','review_manually']
$$;
-- category → suggested built-in template key (shown only; never sends)
CREATE OR REPLACE FUNCTION app.msg_category_template(p_category text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_category WHEN 'telex_release' THEN 'telex_release' WHEN 'delivery_order' THEN 'delivery_order'
                         WHEN 'freight_charges' THEN 'freight_charges' WHEN 'empty_return' THEN 'empty_return_instructions'
                         WHEN 'missing_documents' THEN 'missing_documents' WHEN 'violation' THEN 'violation_response'
                         ELSE 'clarification' END
$$;
-- §18 document kinds that fit a category (suggestions only)
CREATE OR REPLACE FUNCTION app.msg_category_doc_kinds(p_category text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_category WHEN 'telex_release' THEN ARRAY['bill_of_lading']
                         WHEN 'delivery_order' THEN ARRAY['bill_of_lading','delivery_order']
                         WHEN 'freight_charges' THEN ARRAY['operator_invoice']
                         WHEN 'appointment' THEN ARRAY['appointment','container_delivery_eir']
                         WHEN 'empty_return' THEN ARRAY['empty_return_note','empty_return_receipt','container_delivery_eir']
                         ELSE '{}'::text[] END
$$;

-- worker / ingest RPCs only (auth.role() = service_role)
CREATE OR REPLACE FUNCTION app.msg_service_only() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
END $$;

-- logged payloads: the G5 redaction rules (secret-like keys dropped, secrets inside strings scrubbed)
CREATE OR REPLACE FUNCTION app.msg_scrub_text(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT app.bill_scrub_text(p)
$$;
CREATE OR REPLACE FUNCTION app.msg_redact(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT app.bill_redact(p)
$$;
CREATE OR REPLACE FUNCTION app.msg_hash(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT encode(sha256(convert_to(coalesce(p, 'null'::jsonb)::text, 'UTF8')), 'hex')
$$;
CREATE OR REPLACE FUNCTION app.msg_text_hash(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

-- addresses: e-mail = trim + lower; WhatsApp = E.164 (Arabic-Indic digits, spaces / - / () stripped, 00 → +,
-- 05XXXXXXXX → +9665XXXXXXXX). MRS_INVALID 'address' otherwise.
CREATE OR REPLACE FUNCTION app.msg_norm_address(p_kind text, p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text;
BEGIN
  IF p IS NULL THEN PERFORM app.fail('MRS_INVALID', 'address'); END IF;
  IF p_kind = 'email' THEN
    v := lower(btrim(p));
    IF char_length(v) > 254 OR v !~ '^[^[:space:]@<>(),;:"\[\]\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$' THEN
      PERFORM app.fail('MRS_INVALID', 'address');
    END IF;
    RETURN v;
  ELSIF p_kind = 'whatsapp' THEN
    v := regexp_replace(app.to_western(btrim(p)), '[[:space:]()\-]', '', 'g');
    IF v LIKE '00%' THEN v := '+' || substr(v, 3); END IF;
    IF v ~ '^05[0-9]{8}$' THEN v := '+966' || substr(v, 2); END IF;
    IF v !~ '^\+[1-9][0-9]{7,14}$' THEN PERFORM app.fail('MRS_INVALID', 'address'); END IF;
    RETURN v;
  END IF;
  PERFORM app.fail('MRS_INVALID', 'channel_kind');
  RETURN NULL;
END $$;
-- same, NULL instead of an error
CREATE OR REPLACE FUNCTION app.msg_try_norm(p_kind text, p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  RETURN app.msg_norm_address(p_kind, p);
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

-- ISO 6346: owner code (3 letters) + category (U/J/Z) + 6 digits + check digit. Letters 10..38 skipping multiples of 11,
-- weights 2^i, sum mod 11, 10 → 0.
CREATE OR REPLACE FUNCTION app.msg_iso6346_ok(p text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := upper(regexp_replace(coalesce(p, ''), '[[:space:]-]', '', 'g')); s int := 0; i int; c text; n int;
BEGIN
  IF v !~ '^[A-Z]{3}[UJZ][0-9]{7}$' THEN RETURN false; END IF;
  FOR i IN 1..10 LOOP
    c := substr(v, i, 1);
    IF c ~ '[0-9]' THEN n := c::int;
    ELSE
      n := (ARRAY[10,12,13,14,15,16,17,18,19,20,21,23,24,25,26,27,28,29,30,31,32,34,35,36,37,38])[ascii(c) - 64];
    END IF;
    s := s + n * (1 << (i - 1));
  END LOOP;
  RETURN ((s % 11) % 10) = substr(v, 11, 1)::int;
END $$;

-- plain Levenshtein distance (look-alike sender domains; short strings only)
CREATE OR REPLACE FUNCTION app.msg_levenshtein(a text, b text) RETURNS int
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE la int := char_length(coalesce(a, '')); lb int := char_length(coalesce(b, '')); prev int[]; cur int[]; i int; j int; cost int;
BEGIN
  IF la = 0 THEN RETURN lb; END IF;
  IF lb = 0 THEN RETURN la; END IF;
  IF la > 255 OR lb > 255 THEN RETURN 999; END IF;
  prev := ARRAY(SELECT generate_series(0, lb));
  FOR i IN 1..la LOOP
    cur := ARRAY[i];
    FOR j IN 1..lb LOOP
      cost := CASE WHEN substr(a, i, 1) = substr(b, j, 1) THEN 0 ELSE 1 END;
      cur := cur || least(cur[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    END LOOP;
    prev := cur;
  END LOOP;
  RETURN prev[lb + 1];
END $$;

-- bounded text from a worker result / payload (NULL when absent; MRS_INVALID <field> when not a scalar or too long)
CREATE OR REPLACE FUNCTION app.msg_rtext(p jsonb, k text, p_max int, p_field text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR jsonb_typeof(p -> k) IS NULL OR jsonb_typeof(p -> k) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', coalesce(p_field, k)); END IF;
  v := p ->> k;
  IF char_length(v) > p_max THEN PERFORM app.fail('MRS_INVALID', coalesce(p_field, k)); END IF;
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION app.msg_rint(p jsonb, k text, p_min int, p_max int, p_field text DEFAULT NULL) RETURNS int
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p -> k) IS NULL OR jsonb_typeof(p -> k) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) <> 'number' OR (p ->> k) !~ '^-?[0-9]+$' OR (p ->> k)::numeric NOT BETWEEN p_min AND p_max THEN
    PERFORM app.fail('MRS_INVALID', coalesce(p_field, k));
  END IF;
  RETURN (p ->> k)::int;
END $$;
CREATE OR REPLACE FUNCTION app.msg_rnum(p jsonb, k text, p_min numeric, p_max numeric, p_field text DEFAULT NULL) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p -> k) IS NULL OR jsonb_typeof(p -> k) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) <> 'number' OR (p ->> k)::numeric NOT BETWEEN p_min AND p_max THEN
    PERFORM app.fail('MRS_INVALID', coalesce(p_field, k));
  END IF;
  RETURN (p ->> k)::numeric;
END $$;
CREATE OR REPLACE FUNCTION app.msg_rbool(p jsonb, k text, p_field text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p -> k) IS NULL OR jsonb_typeof(p -> k) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) <> 'boolean' THEN PERFORM app.fail('MRS_INVALID', coalesce(p_field, k)); END IF;
  RETURN (p ->> k)::boolean;
END $$;
CREATE OR REPLACE FUNCTION app.msg_rts(p jsonb, k text, p_field text DEFAULT NULL) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE s text := app.msg_rtext(p, k, 40, p_field);
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  BEGIN RETURN s::timestamptz;
  EXCEPTION WHEN others THEN PERFORM app.fail('MRS_INVALID', coalesce(p_field, k)); END;
  RETURN NULL;
END $$;
-- text[] of codes of a dictionary domain from a JSON array (≤ p_max); NULL / absent → '{}'
CREATE OR REPLACE FUNCTION app.msg_rcodes(p jsonb, p_domain text, p_max int, p_field text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN '{}'::text[]; END IF;
  IF jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) > p_max
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p) e WHERE jsonb_typeof(e) <> 'string') THEN
    PERFORM app.fail('MRS_INVALID', p_field);
  END IF;
  SELECT coalesce(array_agg(DISTINCT e ORDER BY e), '{}') INTO r FROM jsonb_array_elements_text(p) e;
  IF p_domain IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(r) c WHERE NOT app.is_code(p_domain, c)) THEN
    PERFORM app.fail('MRS_INVALID', p_field);
  END IF;
  RETURN r;
END $$;
-- an uuid from a JSON value (MRS_INVALID <field>)
CREATE OR REPLACE FUNCTION app.msg_ruuid(p jsonb, k text, p_field text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p -> k) IS NULL OR jsonb_typeof(p -> k) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p -> k) <> 'string' OR (p ->> k) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM app.fail('MRS_INVALID', coalesce(p_field, k));
  END IF;
  RETURN (p ->> k)::uuid;
END $$;
-- display-safe file name for the storage path (never the raw provider name)
CREATE OR REPLACE FUNCTION app.msg_safe_name(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(nullif(left(regexp_replace(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9._-]+', '_', 'g'), '^[._]+', ''), 100), ''), 'file')
$$;
-- "today" (Riyadh) for deadlines / authorizations
CREATE OR REPLACE FUNCTION app.msg_today() RETURNS date LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT (now() AT TIME ZONE 'Asia/Riyadh')::date
$$;

-- ---------------------------------------------------------------------
-- 1. tables
-- ---------------------------------------------------------------------
-- §1 msg_settings — one per org (lazy: a missing row = the defaults)
CREATE TABLE IF NOT EXISTS public.msg_settings (
  org_id                uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,
  ai_provider           text NOT NULL DEFAULT 'rule_mock' CHECK (ai_provider IN ('rule_mock','llm_pending')),
  ai_monthly_budget_usd numeric(10,2) NOT NULL DEFAULT 0 CHECK (ai_monthly_budget_usd >= 0),
  auto_link_enabled     boolean NOT NULL DEFAULT true,
  require_four_eyes     boolean NOT NULL DEFAULT true CHECK (require_four_eyes),
  retention_days        int NOT NULL DEFAULT 730 CHECK (retention_days BETWEEN 90 AND 3650),
  purge_enabled         boolean NOT NULL DEFAULT false CHECK (NOT purge_enabled),
  violation_repeat_days int NOT NULL DEFAULT 30 CHECK (violation_repeat_days BETWEEN 1 AND 365),
  default_lang          text NOT NULL DEFAULT 'ar' CHECK (default_lang IN ('ar','en')),
  signature_ar          text CHECK (char_length(signature_ar) <= 500),
  signature_en          text CHECK (char_length(signature_en) <= 500),
  updated_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id)
);
COMMENT ON TABLE public.msg_settings IS 'G6b per-org messaging settings (AI provider = local rules only, retention, auto-link). purge / four-eyes are CHECK-fixed in v1.';

-- §2 msg_channels — official channels per org (NO secret column)
CREATE TABLE IF NOT EXISTS public.msg_channels (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  kind                    text NOT NULL CHECK (kind IN ('email','whatsapp')),
  name                    text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  address                 text NOT NULL CHECK (char_length(address) BETWEEN 3 AND 254),
  address_norm            text NOT NULL CHECK (char_length(address_norm) BETWEEN 3 AND 254),
  default_branch_id       uuid,
  mode                    text NOT NULL DEFAULT 'mock' CHECK (mode IN ('mock','live_pending')),
  status                  text NOT NULL DEFAULT 'not_connected' CHECK (status IN ('not_connected','connected','error','disabled')),
  ingest_enabled          boolean NOT NULL DEFAULT false,
  send_enabled            boolean NOT NULL DEFAULT false,
  capabilities            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
  capabilities_checked_at timestamptz,
  capabilities_source     text CHECK (capabilities_source IN ('mock','live')),
  poll_cursor             text CHECK (char_length(poll_cursor) <= 200),
  status_cursor           text CHECK (char_length(status_cursor) <= 200),
  last_poll_at            timestamptz,
  last_check_at           timestamptz,
  last_error_code         text CHECK (char_length(last_error_code) <= 60),
  last_error_message      text CHECK (char_length(last_error_message) <= 500),
  provider_terms_ack_by   uuid,
  provider_terms_ack_at   timestamptz,
  created_by              uuid,
  updated_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_channels_branch_fk FOREIGN KEY (default_branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT msg_channels_terms_chk CHECK (NOT (ingest_enabled OR send_enabled) OR provider_terms_ack_at IS NOT NULL),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_channels IS 'G6b official channel (e-mail / WhatsApp) of one org: mode, status, flags, capabilities. Holds NO secret (Vault names msg_*:<channel_id>, worker only).';
-- G6b-2: one provider account belongs to one org
CREATE UNIQUE INDEX IF NOT EXISTS msg_channels_address_uidx ON public.msg_channels (kind, address_norm);
CREATE INDEX IF NOT EXISTS msg_channels_org_idx ON public.msg_channels (org_id);

-- §3 contacts directory — «العنوان ليس تفويضًا»
CREATE TABLE IF NOT EXISTS public.msg_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 160),
  entity_type  text NOT NULL CHECK (entity_type IN ('client','party','internal','other')),
  client_id    uuid,
  party_id     uuid,
  role_label   text CHECK (char_length(role_label) <= 80),
  lang         text NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar','en')),
  notes        text CHECK (char_length(notes) <= 2000),
  is_active    boolean NOT NULL DEFAULT true,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_contacts_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT msg_contacts_party_fk FOREIGN KEY (party_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT msg_contacts_entity_chk CHECK ((entity_type = 'client') = (client_id IS NOT NULL) AND (entity_type = 'party') = (party_id IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_contacts IS 'G6b contacts directory (clients, parties, internal). An address is not an authorization.';
CREATE INDEX IF NOT EXISTS msg_contacts_org_idx ON public.msg_contacts (org_id, display_name);

CREATE TABLE IF NOT EXISTS public.msg_contact_addresses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  contact_id          uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('email','whatsapp')),
  address             text NOT NULL CHECK (char_length(address) BETWEEN 3 AND 254),
  address_norm        text NOT NULL CHECK (char_length(address_norm) BETWEEN 3 AND 254),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  verified_at         timestamptz,
  verified_by         uuid,
  verification_method text CHECK (verification_method IN ('callback','known_domain','in_person','signed_document','provider_verified')),
  verification_note   text CHECK (char_length(verification_note) <= 500),
  retired_by          uuid,
  retired_at          timestamptz,
  retired_reason      text CHECK (char_length(retired_reason) <= 500),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_contact_addresses_contact_fk FOREIGN KEY (contact_id, org_id) REFERENCES public.msg_contacts(id, org_id),
  CONSTRAINT msg_contact_addresses_verify_chk CHECK ((verified_at IS NULL) = (verification_method IS NULL)
                                                     AND (verification_method IS NULL OR verification_note IS NOT NULL)),
  CONSTRAINT msg_contact_addresses_retired_chk CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_contact_addresses IS 'G6b contact address: known once in the directory, verified only by a verify role with method + note.';
CREATE UNIQUE INDEX IF NOT EXISTS msg_contact_addresses_active_uidx ON public.msg_contact_addresses (org_id, kind, address_norm) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS msg_contact_addresses_contact_idx ON public.msg_contact_addresses (contact_id);

CREATE TABLE IF NOT EXISTS public.msg_contact_authorizations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  contact_id        uuid NOT NULL,
  scope_type        text NOT NULL CHECK (scope_type IN ('client','party','transaction')),
  client_id         uuid,
  party_id          uuid,
  transaction_id    uuid,
  may_receive_kinds text[] NOT NULL DEFAULT '{}' CHECK (may_receive_kinds <@ ARRAY['bill_of_lading','commercial_invoice','packing_list','certificate_of_origin','saber_certificate',
               'customs_declaration','delivery_order','appointment','container_delivery_eir','empty_return_note',
               'empty_return_receipt','operator_invoice','government_doc','import_file','other']),
  may_discuss       text[] NOT NULL DEFAULT '{}' CHECK (may_discuss <@ ARRAY['telex_release','delivery_order','freight_charges','appointment',
               'missing_documents','violation','empty_return','general_inquiry','unknown']),
  valid_from        date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Riyadh')::date),
  valid_until       date,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  granted_by        uuid,
  grant_note        text NOT NULL CHECK (char_length(grant_note) BETWEEN 1 AND 2000),
  revoked_by        uuid,
  revoked_at        timestamptz,
  revoked_reason    text CHECK (char_length(revoked_reason) <= 2000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_contact_authorizations_contact_fk FOREIGN KEY (contact_id, org_id) REFERENCES public.msg_contacts(id, org_id),
  CONSTRAINT msg_contact_authorizations_client_fk FOREIGN KEY (client_id, org_id) REFERENCES public.clients(id, org_id),
  CONSTRAINT msg_contact_authorizations_party_fk FOREIGN KEY (party_id, org_id) REFERENCES public.parties(id, org_id),
  CONSTRAINT msg_contact_authorizations_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT msg_contact_authorizations_scope_chk CHECK (
    (scope_type = 'client') = (client_id IS NOT NULL) AND (scope_type = 'party') = (party_id IS NOT NULL)
    AND (scope_type = 'transaction') = (transaction_id IS NOT NULL)),
  CONSTRAINT msg_contact_authorizations_dates_chk CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CONSTRAINT msg_contact_authorizations_revoked_chk CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_contact_authorizations IS 'G6b sharing authorization of a contact (scope client / party / transaction, document kinds, topics, validity). No authorization = nothing shared.';
CREATE INDEX IF NOT EXISTS msg_contact_authorizations_contact_idx ON public.msg_contact_authorizations (contact_id, status);

-- §4 msg_threads — the unified inbox
CREATE TABLE IF NOT EXISTS public.msg_threads (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  channel_id               uuid NOT NULL,
  branch_id                uuid,
  kind                     text NOT NULL CHECK (kind IN ('email','whatsapp')),
  subject                  text CHECK (char_length(subject) <= 500),
  provider_thread_id       text CHECK (char_length(provider_thread_id) <= 200),
  counterpart_address_norm text CHECK (char_length(counterpart_address_norm) <= 254),
  contact_id               uuid,
  status                   text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','awaiting_external','awaiting_internal','resolved','spam')),
  priority                 text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  owner_id                 uuid,
  due_at                   timestamptz,
  category                 text CHECK (category IN ('telex_release','delivery_order','freight_charges','appointment','missing_documents',
                                                    'violation','empty_return','general_inquiry','unknown')),
  risk_flags               text[] NOT NULL DEFAULT '{}',
  triage_locked            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(triage_locked) = 'object'),
  transaction_id           uuid,
  match_status             text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched','suggested','auto_linked','linked','review','not_related')),
  match_candidates         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(match_candidates) = 'array' AND jsonb_array_length(match_candidates) <= 10),
  match_reason             text CHECK (char_length(match_reason) <= 60),
  message_count            int NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  unread_count             int NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message_at          timestamptz,
  last_inbound_at          timestamptz,
  last_outbound_at         timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_threads_channel_fk FOREIGN KEY (channel_id, org_id) REFERENCES public.msg_channels(id, org_id),
  CONSTRAINT msg_threads_branch_fk FOREIGN KEY (branch_id, org_id) REFERENCES public.branches(id, org_id),
  CONSTRAINT msg_threads_contact_fk FOREIGN KEY (contact_id, org_id) REFERENCES public.msg_contacts(id, org_id),
  CONSTRAINT msg_threads_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT msg_threads_link_chk CHECK ((transaction_id IS NOT NULL) = (match_status IN ('auto_linked','linked'))),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_threads IS 'G6b unified inbox thread (per org and branch; NULL branch = org-wide only). Link to a transaction only with a documented basis (msg_thread_links).';
CREATE INDEX IF NOT EXISTS msg_threads_inbox_idx ON public.msg_threads (org_id, branch_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS msg_threads_owner_idx ON public.msg_threads (org_id, owner_id, status);
CREATE INDEX IF NOT EXISTS msg_threads_tx_idx ON public.msg_threads (transaction_id);
CREATE INDEX IF NOT EXISTS msg_threads_match_idx ON public.msg_threads (org_id, match_status) WHERE match_status IN ('suggested','review');
CREATE INDEX IF NOT EXISTS msg_threads_provider_idx ON public.msg_threads (channel_id, provider_thread_id) WHERE provider_thread_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS msg_threads_wa_open_uidx ON public.msg_threads (channel_id, counterpart_address_norm)
  WHERE kind = 'whatsapp' AND status NOT IN ('resolved','spam');

-- §5 msg_messages — immutable copies
CREATE TABLE IF NOT EXISTS public.msg_messages (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL,
  thread_id              uuid NOT NULL,
  channel_id             uuid NOT NULL,
  direction              text NOT NULL CHECK (direction IN ('inbound','outbound')),
  provider_message_id    text NOT NULL CHECK (char_length(provider_message_id) BETWEEN 1 AND 200),
  provider_thread_id     text CHECK (char_length(provider_thread_id) <= 200),
  from_address           text CHECK (char_length(from_address) <= 254),
  from_address_norm      text CHECK (char_length(from_address_norm) <= 254),
  from_name              text CHECK (char_length(from_name) <= 160),
  to_addresses           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(to_addresses) = 'array' AND jsonb_array_length(to_addresses) <= 50),
  cc_addresses           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cc_addresses) = 'array' AND jsonb_array_length(cc_addresses) <= 50),
  recipient_address_norm text CHECK (char_length(recipient_address_norm) <= 254),
  sent_at                timestamptz,
  received_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  subject                text CHECK (char_length(subject) <= 500),
  body_text              text NOT NULL DEFAULT '' CHECK (char_length(body_text) <= 100000),
  body_sha256            text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  headers                jsonb CHECK (headers IS NULL OR jsonb_typeof(headers) = 'object'),
  wa_context             jsonb CHECK (wa_context IS NULL OR jsonb_typeof(wa_context) = 'object'),
  auth_results           jsonb CHECK (auth_results IS NULL OR jsonb_typeof(auth_results) = 'object'),
  raw                    jsonb CHECK (raw IS NULL OR octet_length(raw::text) <= 262144),
  sender_status          text NOT NULL DEFAULT 'unknown' CHECK (sender_status IN ('unknown','known','verified','mismatch','spoof_suspected')),
  sender_contact_id      uuid,
  sender_address_id      uuid,
  sender_signals         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sender_signals) = 'object'),
  risk_flags             text[] NOT NULL DEFAULT '{}',
  outbound_id            uuid,
  ingest_source          text NOT NULL CHECK (ingest_source IN ('webhook','poll','send')),
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_messages_thread_fk FOREIGN KEY (thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT msg_messages_channel_fk FOREIGN KEY (channel_id, org_id) REFERENCES public.msg_channels(id, org_id),
  CONSTRAINT msg_messages_contact_fk FOREIGN KEY (sender_contact_id, org_id) REFERENCES public.msg_contacts(id, org_id),
  CONSTRAINT msg_messages_address_fk FOREIGN KEY (sender_address_id, org_id) REFERENCES public.msg_contact_addresses(id, org_id),
  CONSTRAINT msg_messages_provider_uniq UNIQUE (org_id, channel_id, provider_message_id),
  CONSTRAINT msg_messages_dir_chk CHECK ((direction = 'outbound') = (outbound_id IS NOT NULL OR ingest_source = 'send')),
  UNIQUE (id, org_id),
  UNIQUE (id, thread_id)
);
COMMENT ON TABLE public.msg_messages IS 'G6b immutable copy of every inbound / outbound message (plain text only). Append-only; derived results live in child tables.';
CREATE INDEX IF NOT EXISTS msg_messages_thread_idx ON public.msg_messages (thread_id, received_at);
CREATE INDEX IF NOT EXISTS msg_messages_from_idx ON public.msg_messages (org_id, from_address_norm);
CREATE INDEX IF NOT EXISTS msg_messages_msgid_idx ON public.msg_messages (channel_id, ((headers ->> 'message_id'))) WHERE headers IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.msg_message_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  message_id        uuid NOT NULL,
  event             text NOT NULL CHECK (event IN ('edited','deleted','reaction')),
  provider_event_id text NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 200),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144),
  at                timestamptz,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_message_events_message_fk FOREIGN KEY (message_id, org_id) REFERENCES public.msg_messages(id, org_id),
  CONSTRAINT msg_message_events_uniq UNIQUE (org_id, message_id, provider_event_id),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_message_events IS 'G6b provider edits / deletions / reactions of a message (append-only; the original copy stays).';

-- §6 msg_attachments — metadata only (bytes: live worker, bucket messages)
CREATE TABLE IF NOT EXISTS public.msg_attachments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL,
  message_id             uuid NOT NULL,
  thread_id              uuid NOT NULL,
  provider_attachment_id text NOT NULL CHECK (char_length(provider_attachment_id) BETWEEN 1 AND 200),
  file_name              text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime_type              text CHECK (char_length(mime_type) <= 120),
  size_bytes             bigint NOT NULL DEFAULT 0 CHECK (size_bytes BETWEEN 0 AND 26214400),
  sha256                 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_bucket         text NOT NULL DEFAULT 'messages' CHECK (storage_bucket = 'messages'),
  storage_path           text NOT NULL UNIQUE,
  storage_status         text NOT NULL DEFAULT 'not_fetched' CHECK (storage_status IN ('not_fetched','stored','too_large','blocked')),
  scan_status            text NOT NULL DEFAULT 'not_scanned' CHECK (scan_status IN ('not_scanned','clean','infected','skipped')),
  extracted_text         text CHECK (char_length(extracted_text) <= 100000),
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_attachments_message_fk FOREIGN KEY (message_id, org_id) REFERENCES public.msg_messages(id, org_id),
  CONSTRAINT msg_attachments_thread_fk FOREIGN KEY (thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT msg_attachments_msg_thread_fk FOREIGN KEY (message_id, thread_id) REFERENCES public.msg_messages(id, thread_id),
  CONSTRAINT msg_attachments_provider_uniq UNIQUE (message_id, provider_attachment_id),
  CONSTRAINT msg_attachments_path_chk CHECK (storage_path LIKE org_id::text || '/%/' || message_id::text || '/' || id::text || '/%'),
  UNIQUE (id, org_id),
  UNIQUE (id, message_id)
);
COMMENT ON TABLE public.msg_attachments IS 'G6b attachment metadata of a message (bytes never fetched by the mock; bucket messages, never client-visible).';
CREATE INDEX IF NOT EXISTS msg_attachments_thread_idx ON public.msg_attachments (thread_id);

-- §17 msg_replies (the version / approval FKs are added below, after msg_reply_versions)
CREATE TABLE IF NOT EXISTS public.msg_replies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  thread_id           uuid NOT NULL,
  reply_to_message_id uuid,
  channel_id          uuid NOT NULL,
  lang                text NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar','en')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','sending','sent',
                                                                      'send_failed','send_unknown','cancelled')),
  current_version_id  uuid,
  approved_version_id uuid,
  template_key        text CHECK (char_length(template_key) <= 40),
  category            text,
  created_by          uuid,
  submitted_by        uuid,
  submitted_at        timestamptz,
  cancelled_by        uuid,
  cancelled_at        timestamptz,
  cancel_reason       text CHECK (char_length(cancel_reason) <= 2000),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_replies_thread_fk FOREIGN KEY (thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT msg_replies_reply_to_fk FOREIGN KEY (reply_to_message_id, thread_id) REFERENCES public.msg_messages(id, thread_id),
  CONSTRAINT msg_replies_channel_fk FOREIGN KEY (channel_id, org_id) REFERENCES public.msg_channels(id, org_id),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_replies IS 'G6b reply to a thread: versions, a separate approval fact and a separate send fact. ≤ 1 live reply per thread.';
CREATE UNIQUE INDEX IF NOT EXISTS msg_replies_live_uidx ON public.msg_replies (thread_id)
  WHERE status IN ('draft','pending_approval','approved','sending','send_unknown');

-- §8 msg_ai_runs — every AI run (hashes and counts only, never text)
CREATE TABLE IF NOT EXISTS public.msg_ai_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  thread_id         uuid NOT NULL,
  message_id        uuid,
  reply_id          uuid,
  kind              text NOT NULL CHECK (kind IN ('process','draft')),
  provider          text NOT NULL CHECK (provider IN ('rule_mock','llm_pending')),
  provider_version  text NOT NULL CHECK (char_length(provider_version) BETWEEN 1 AND 40),
  input_sha256      text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  input_chars       int NOT NULL CHECK (input_chars >= 0),
  output_chars      int NOT NULL CHECK (output_chars >= 0),
  est_input_tokens  int NOT NULL DEFAULT 0 CHECK (est_input_tokens >= 0),
  est_output_tokens int NOT NULL DEFAULT 0 CHECK (est_output_tokens >= 0),
  est_cost_usd      numeric(10,4) NOT NULL DEFAULT 0 CHECK (est_cost_usd >= 0),
  injection_flags   text[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_ai_runs_thread_fk FOREIGN KEY (thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT msg_ai_runs_message_fk FOREIGN KEY (message_id, thread_id) REFERENCES public.msg_messages(id, thread_id),
  CONSTRAINT msg_ai_runs_reply_fk FOREIGN KEY (reply_id, org_id) REFERENCES public.msg_replies(id, org_id),
  CONSTRAINT msg_ai_runs_kind_chk CHECK ((kind = 'process') = (message_id IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_ai_runs IS 'G6b AI run log: provider, hashes, sizes, token / cost estimate (rule_mock = 0). Never the text.';
CREATE INDEX IF NOT EXISTS msg_ai_runs_org_idx ON public.msg_ai_runs (org_id, created_at);

-- §7 msg_extractions — references with source spans (code points)
CREATE TABLE IF NOT EXISTS public.msg_extractions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  message_id      uuid NOT NULL,
  thread_id       uuid NOT NULL,
  ai_run_id       uuid,
  kind            text NOT NULL CHECK (kind IN ('bl_number','container_no','declaration_no','invoice_no','tx_ref','date','appointment_no')),
  raw             text NOT NULL CHECK (char_length(raw) BETWEEN 1 AND 200),
  normalized      text NOT NULL CHECK (char_length(normalized) BETWEEN 1 AND 200),
  source          text NOT NULL CHECK (source IN ('subject','body','attachment')),
  attachment_id   uuid,
  span_start      int NOT NULL CHECK (span_start >= 0),
  span_end        int NOT NULL,
  valid           boolean NOT NULL DEFAULT true,
  confidence      numeric(3,2) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 2000),
  status          text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','confirmed','corrected','rejected')),
  corrected_value text CHECK (char_length(corrected_value) <= 200),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  review_note     text CHECK (char_length(review_note) <= 2000),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_extractions_message_fk FOREIGN KEY (message_id, thread_id) REFERENCES public.msg_messages(id, thread_id),
  CONSTRAINT msg_extractions_thread_fk FOREIGN KEY (thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT msg_extractions_run_fk FOREIGN KEY (ai_run_id, org_id) REFERENCES public.msg_ai_runs(id, org_id),
  CONSTRAINT msg_extractions_attachment_fk FOREIGN KEY (attachment_id, message_id) REFERENCES public.msg_attachments(id, message_id),
  CONSTRAINT msg_extractions_span_chk CHECK (span_end > span_start),
  CONSTRAINT msg_extractions_source_chk CHECK ((source = 'attachment') = (attachment_id IS NOT NULL)),
  CONSTRAINT msg_extractions_corrected_chk CHECK ((status = 'corrected') = (corrected_value IS NOT NULL)),
  CONSTRAINT msg_extractions_uniq UNIQUE NULLS NOT DISTINCT (message_id, kind, normalized, source, attachment_id, span_start),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_extractions IS 'G6b references extracted by the rule provider with exact source spans (Unicode code points). Suggestions until staff review.';
CREATE INDEX IF NOT EXISTS msg_extractions_thread_idx ON public.msg_extractions (thread_id, kind);

-- §8 classifications / summaries
CREATE TABLE IF NOT EXISTS public.msg_classifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  message_id uuid NOT NULL,
  thread_id  uuid NOT NULL,
  category   text NOT NULL CHECK (category IN ('telex_release','delivery_order','freight_charges','appointment','missing_documents',
                                               'violation','empty_return','general_inquiry','unknown')),
  source     text NOT NULL CHECK (source IN ('ai','staff')),
  confidence numeric(3,2) CHECK (confidence BETWEEN 0 AND 1),
  rules      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 50),
  ai_run_id  uuid,
  actor      uuid,
  note       text CHECK (char_length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_classifications_message_fk FOREIGN KEY (message_id, thread_id) REFERENCES public.msg_messages(id, thread_id),
  CONSTRAINT msg_classifications_thread_fk FOREIGN KEY (thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT msg_classifications_run_fk FOREIGN KEY (ai_run_id, org_id) REFERENCES public.msg_ai_runs(id, org_id),
  CONSTRAINT msg_classifications_staff_chk CHECK (source = 'ai' OR (actor IS NOT NULL AND note IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_classifications IS 'G6b category suggestions (ai) and staff corrections; the latest row is current. Never triggers a send / link / attachment / approval.';
CREATE INDEX IF NOT EXISTS msg_classifications_message_idx ON public.msg_classifications (message_id, created_at);

CREATE TABLE IF NOT EXISTS public.msg_summaries (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL,
  message_id             uuid NOT NULL,
  thread_id              uuid NOT NULL,
  ai_run_id              uuid,
  summary_ar             text CHECK (char_length(summary_ar) <= 1000),
  summary_en             text CHECK (char_length(summary_en) <= 1000),
  action_code            text NOT NULL CHECK (action_code IN ('send_telex','issue_do','pay_or_query_charges','book_or_confirm_appointment',
                                                               'provide_documents','respond_violation','arrange_empty_return','answer_inquiry','review_manually')),
  suggested_role         text CHECK (suggested_role IN ('clearance_staff','transport_staff','accountant','accounts_manager','operations_manager',
                                                        'branch_manager','supervisor','admin')),
  deadline_date          date,
  deadline_extraction_id uuid,
  risks                  text[] NOT NULL DEFAULT '{}',
  accepted_by            uuid,
  accepted_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_summaries_message_fk FOREIGN KEY (message_id, thread_id) REFERENCES public.msg_messages(id, thread_id),
  CONSTRAINT msg_summaries_thread_fk FOREIGN KEY (thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT msg_summaries_run_fk FOREIGN KEY (ai_run_id, org_id) REFERENCES public.msg_ai_runs(id, org_id),
  CONSTRAINT msg_summaries_deadline_fk FOREIGN KEY (deadline_extraction_id, org_id) REFERENCES public.msg_extractions(id, org_id),
  CONSTRAINT msg_summaries_deadline_chk CHECK (deadline_date IS NULL OR deadline_extraction_id IS NOT NULL),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_summaries IS 'G6b template summary, action, suggested role and a deadline only with its source extraction (never invented).';
CREATE INDEX IF NOT EXISTS msg_summaries_message_idx ON public.msg_summaries (message_id, created_at);

-- §9 msg_thread_links — documented linking history
CREATE TABLE IF NOT EXISTS public.msg_thread_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  thread_id      uuid NOT NULL,
  transaction_id uuid,
  action         text NOT NULL CHECK (action IN ('auto_link','link','unlink','not_related','review')),
  method         text NOT NULL CHECK (method IN ('auto','staff')),
  basis          jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object'),
  actor          uuid,
  note           text CHECK (char_length(note) <= 2000),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_thread_links_thread_fk FOREIGN KEY (thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT msg_thread_links_tx_fk FOREIGN KEY (transaction_id, org_id) REFERENCES public.transactions(id, org_id),
  CONSTRAINT msg_thread_links_tx_chk CHECK ((action IN ('auto_link','link')) = (transaction_id IS NOT NULL)),
  CONSTRAINT msg_thread_links_method_chk CHECK ((method = 'auto') = (actor IS NULL) AND (method = 'auto') = (action IN ('auto_link','review'))),
  CONSTRAINT msg_thread_links_note_chk CHECK (action NOT IN ('unlink','not_related') OR note IS NOT NULL),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_thread_links IS 'G6b linking history: every change of msg_threads.transaction_id has exactly one row with its basis (signals, score, candidates, sender, rule).';
CREATE INDEX IF NOT EXISTS msg_thread_links_thread_idx ON public.msg_thread_links (thread_id, created_at);

-- §16 msg_instructions — org instruction library (versioned, typed params; body never executed)
CREATE TABLE IF NOT EXISTS public.msg_instructions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  instruction_key text NOT NULL CHECK (instruction_key ~ '^[a-z0-9_.-]{1,60}$'),
  version         int NOT NULL CHECK (version >= 1),
  kind            text NOT NULL CHECK (kind IN ('style','language','party_rule','topic_rule','approval_level','signature')),
  scope           text NOT NULL DEFAULT 'all' CHECK (scope IN ('all','party_kind','contact','category')),
  scope_value     text CHECK (char_length(scope_value) <= 60),
  lang            text NOT NULL DEFAULT 'any' CHECK (lang IN ('ar','en','any')),
  body            text CHECK (char_length(body) <= 2000),
  params          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 8000),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  author_id       uuid,
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  review_note     text CHECK (char_length(review_note) <= 2000),
  supersedes_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_instructions_supersedes_fk FOREIGN KEY (supersedes_id, org_id) REFERENCES public.msg_instructions(id, org_id),
  CONSTRAINT msg_instructions_version_uniq UNIQUE (org_id, instruction_key, version),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_instructions IS 'G6b org instruction library (style, language, party / topic rules, approval levels, signature). Typed params only reach drafts; body text never does.';
CREATE UNIQUE INDEX IF NOT EXISTS msg_instructions_approved_uidx ON public.msg_instructions (org_id, instruction_key) WHERE status = 'approved';

-- §22 msg_templates — agent templates (versioned)
CREATE TABLE IF NOT EXISTS public.msg_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  template_key  text NOT NULL CHECK (template_key IN ('telex_release','delivery_order','freight_charges','empty_return_instructions',
                                                      'missing_documents','violation_response','clarification','ack_receipt')),
  version       int NOT NULL CHECK (version >= 1),
  lang          text NOT NULL CHECK (lang IN ('ar','en')),
  party_kinds   text[] NOT NULL DEFAULT '{}' CHECK (party_kinds <@ ARRAY['shipping_agent','terminal_operator','carrier','yard','customs_broker',
                                                                         'supplier','other','client']),
  operation     text NOT NULL DEFAULT 'any' CHECK (operation IN ('import','export','any')),
  category      text CHECK (category IN ('telex_release','delivery_order','freight_charges','appointment','missing_documents',
                                         'violation','empty_return','general_inquiry','unknown')),
  subject_tpl   text CHECK (char_length(subject_tpl) <= 300),
  body_tpl      text NOT NULL CHECK (char_length(body_tpl) BETWEEN 1 AND 5000),
  placeholders  text[] NOT NULL DEFAULT '{}' CHECK (placeholders <@ ARRAY['tx_ref','bl_number','declaration_no','container_list','client_name',
                  'counterpart_name','operation_label','appointment_at','terminal_name','return_deadline_list','missing_documents_list',
                  'org_name','signature','today']),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  author_id     uuid,
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  review_note   text CHECK (char_length(review_note) <= 2000),
  supersedes_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_templates_supersedes_fk FOREIGN KEY (supersedes_id, org_id) REFERENCES public.msg_templates(id, org_id),
  CONSTRAINT msg_templates_version_uniq UNIQUE (org_id, template_key, lang, version),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_templates IS 'G6b reply templates per key × language (plain {{placeholder}} substitution; versioned; reviewed by a different user).';
CREATE UNIQUE INDEX IF NOT EXISTS msg_templates_approved_uidx ON public.msg_templates (org_id, template_key, lang) WHERE status = 'approved';

-- §17 msg_reply_versions — append-only
CREATE TABLE IF NOT EXISTS public.msg_reply_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  reply_id         uuid NOT NULL,
  version_no       int NOT NULL CHECK (version_no >= 1),
  author_kind      text NOT NULL CHECK (author_kind IN ('staff','ai_mock')),
  author_id        uuid,
  requested_by     uuid,
  subject          text CHECK (char_length(subject) <= 500),
  body_text        text NOT NULL DEFAULT '' CHECK (char_length(body_text) <= 20000),
  to_addresses     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(to_addresses) = 'array' AND jsonb_array_length(to_addresses) <= 20),
  cc_addresses     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cc_addresses) = 'array' AND jsonb_array_length(cc_addresses) <= 20),
  attachments      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 10),
  clarification    boolean NOT NULL DEFAULT false,
  missing          text[] NOT NULL DEFAULT '{}',
  used_facts       text[] NOT NULL DEFAULT '{}',
  template_key     text CHECK (char_length(template_key) <= 40),
  template_version int,
  ai_run_id        uuid,
  content_sha256   text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_reply_versions_reply_fk FOREIGN KEY (reply_id, org_id) REFERENCES public.msg_replies(id, org_id),
  CONSTRAINT msg_reply_versions_run_fk FOREIGN KEY (ai_run_id, org_id) REFERENCES public.msg_ai_runs(id, org_id),
  CONSTRAINT msg_reply_versions_no_uniq UNIQUE (reply_id, version_no),
  CONSTRAINT msg_reply_versions_author_chk CHECK (CASE author_kind WHEN 'staff' THEN author_id IS NOT NULL
                                                                   ELSE author_id IS NULL AND requested_by IS NOT NULL END),
  UNIQUE (id, org_id),
  UNIQUE (id, reply_id)
);
COMMENT ON TABLE public.msg_reply_versions IS 'G6b reply versions (append-only): text, recipients, attachment references, content hash.';

-- §19 msg_reply_approvals — append-only
CREATE TABLE IF NOT EXISTS public.msg_reply_approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  reply_id       uuid NOT NULL,
  version_id     uuid NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  decision       text NOT NULL CHECK (decision IN ('approve','reject')),
  level          text NOT NULL CHECK (level IN ('standard','finance','management')),
  sensitive_ack  boolean NOT NULL DEFAULT false,
  actor          uuid NOT NULL,
  note           text CHECK (char_length(note) <= 2000),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_reply_approvals_reply_fk FOREIGN KEY (reply_id, org_id) REFERENCES public.msg_replies(id, org_id),
  CONSTRAINT msg_reply_approvals_version_fk FOREIGN KEY (version_id, reply_id) REFERENCES public.msg_reply_versions(id, reply_id),
  CONSTRAINT msg_reply_approvals_note_chk CHECK ((decision = 'approve' AND NOT sensitive_ack) OR note IS NOT NULL),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_reply_approvals IS 'G6b approval / rejection of one exact reply version (content hash); separate from the send.';

-- §20 msg_outbound — one per approved version
CREATE TABLE IF NOT EXISTS public.msg_outbound (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  reply_id            uuid NOT NULL,
  reply_version_id    uuid NOT NULL,
  approval_id         uuid NOT NULL,
  thread_id           uuid NOT NULL,
  channel_id          uuid NOT NULL,
  provider_request_id text NOT NULL UNIQUE CHECK (provider_request_id ~ '^MRSO-[0-9A-F]{16}$'),
  from_address_norm   text NOT NULL,
  to_addresses        jsonb NOT NULL CHECK (jsonb_typeof(to_addresses) = 'array'),
  cc_addresses        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cc_addresses) = 'array'),
  subject             text CHECK (char_length(subject) <= 500),
  body_text           text NOT NULL CHECK (char_length(body_text) <= 20000),
  attachments         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
  content_sha256      text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  requested_by        uuid NOT NULL,
  requested_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  state               text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','accepted','delivered','read','failed','unknown')),
  provider_message_id text CHECK (char_length(provider_message_id) <= 200),
  accepted_at         timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  last_error_code     text CHECK (char_length(last_error_code) <= 60),
  last_error_message  text CHECK (char_length(last_error_message) <= 500),
  unknown_resolution  text CHECK (unknown_resolution IN ('confirmed_sent','confirmed_not_sent')),
  resolved_by         uuid,
  resolved_at         timestamptz,
  resolution_note     text CHECK (char_length(resolution_note) <= 2000),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_outbound_reply_fk FOREIGN KEY (reply_id, org_id) REFERENCES public.msg_replies(id, org_id),
  CONSTRAINT msg_outbound_version_fk FOREIGN KEY (reply_version_id, reply_id) REFERENCES public.msg_reply_versions(id, reply_id),
  CONSTRAINT msg_outbound_approval_fk FOREIGN KEY (approval_id, org_id) REFERENCES public.msg_reply_approvals(id, org_id),
  CONSTRAINT msg_outbound_thread_fk FOREIGN KEY (thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT msg_outbound_channel_fk FOREIGN KEY (channel_id, org_id) REFERENCES public.msg_channels(id, org_id),
  CONSTRAINT msg_outbound_version_uniq UNIQUE (reply_version_id),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_outbound IS 'G6b send fact: frozen copy of the approved version, one provider request id (idempotency key); state moves forward only.';
CREATE INDEX IF NOT EXISTS msg_outbound_channel_idx ON public.msg_outbound (channel_id, state);
CREATE INDEX IF NOT EXISTS msg_outbound_provider_idx ON public.msg_outbound (channel_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- §21 msg_delivery_events — append-only
CREATE TABLE IF NOT EXISTS public.msg_delivery_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  outbound_id       uuid NOT NULL,
  provider_event_id text NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 200),
  status            text NOT NULL CHECK (status IN ('accepted','sent','delivered','read','failed','bounced')),
  error_code        text CHECK (char_length(error_code) <= 60),
  at                timestamptz,
  source            text NOT NULL CHECK (source IN ('send_result','status_poll','webhook')),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT msg_delivery_events_outbound_fk FOREIGN KEY (outbound_id, org_id) REFERENCES public.msg_outbound(id, org_id),
  CONSTRAINT msg_delivery_events_uniq UNIQUE (outbound_id, provider_event_id),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_delivery_events IS 'G6b provider delivery events of an outbound message (accepted ≠ delivered).';

-- §23 msg_auto_reply_policies — disabled in v1
CREATE TABLE IF NOT EXISTS public.msg_auto_reply_policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  kind               text NOT NULL CHECK (kind IN ('ack_receipt','status_update')),
  enabled            boolean NOT NULL DEFAULT false CHECK (NOT enabled),
  allowed_categories text[] NOT NULL DEFAULT '{}' CHECK (allowed_categories <@ ARRAY['telex_release','delivery_order','freight_charges',
                       'appointment','missing_documents','violation','empty_return','general_inquiry','unknown']),
  template_key       text CHECK (template_key IN ('telex_release','delivery_order','freight_charges','empty_return_instructions',
                                                  'missing_documents','violation_response','clarification','ack_receipt')),
  conditions         jsonb NOT NULL DEFAULT '{"verified_sender_only": true, "business_hours_only": true}'::jsonb CHECK (jsonb_typeof(conditions) = 'object'),
  note               text CHECK (char_length(note) <= 1000),
  updated_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_auto_reply_policies_kind_uniq UNIQUE (org_id, kind),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_auto_reply_policies IS 'G6b auto-reply policies: stored conditions only; enabled is CHECK-ed false in v1 (no automatic sending).';

-- §25 msg_jobs — outbox
CREATE TABLE IF NOT EXISTS public.msg_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  kind               text NOT NULL CHECK (kind IN ('probe','poll','process','draft','send','status')),
  channel_id         uuid NOT NULL,
  thread_id          uuid,
  message_id         uuid,
  reply_id           uuid,
  outbound_id        uuid,
  dedupe_key         text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 5 AND 120),
  options            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','unknown','done','conflict','failed','dead','cancelled')),
  priority           int NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 9),
  attempts           int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       int NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 1000),
  next_run_at        timestamptz NOT NULL DEFAULT now(),
  locked_by          text CHECK (char_length(locked_by) <= 80),
  locked_until       timestamptz,
  last_error_kind    text CHECK (char_length(last_error_kind) <= 60),
  last_error_code    text CHECK (char_length(last_error_code) <= 60),
  last_error_message text CHECK (char_length(last_error_message) <= 500),
  requested_by       uuid,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_jobs_channel_fk FOREIGN KEY (channel_id, org_id) REFERENCES public.msg_channels(id, org_id),
  CONSTRAINT msg_jobs_thread_fk FOREIGN KEY (thread_id, org_id) REFERENCES public.msg_threads(id, org_id),
  CONSTRAINT msg_jobs_message_fk FOREIGN KEY (message_id, org_id) REFERENCES public.msg_messages(id, org_id),
  CONSTRAINT msg_jobs_reply_fk FOREIGN KEY (reply_id, org_id) REFERENCES public.msg_replies(id, org_id),
  CONSTRAINT msg_jobs_outbound_fk FOREIGN KEY (outbound_id, org_id) REFERENCES public.msg_outbound(id, org_id),
  CONSTRAINT msg_jobs_target_chk CHECK (CASE
    WHEN kind = 'process' THEN message_id IS NOT NULL AND thread_id IS NOT NULL AND reply_id IS NULL AND outbound_id IS NULL
    WHEN kind = 'draft' THEN thread_id IS NOT NULL AND message_id IS NULL AND outbound_id IS NULL
    WHEN kind = 'send' THEN outbound_id IS NOT NULL AND thread_id IS NOT NULL AND reply_id IS NOT NULL AND message_id IS NULL
    ELSE thread_id IS NULL AND message_id IS NULL AND reply_id IS NULL AND outbound_id IS NULL END),
  CONSTRAINT msg_jobs_lock_chk CHECK (status <> 'running' OR (locked_by IS NOT NULL AND locked_until IS NOT NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_jobs IS 'G6b outbox (probe / poll / process / draft / send / status); one running job per channel; claimed by the server-side worker only.';
CREATE UNIQUE INDEX IF NOT EXISTS msg_jobs_dedupe_uidx ON public.msg_jobs (org_id, dedupe_key) WHERE status IN ('queued','running','unknown');
CREATE INDEX IF NOT EXISTS msg_jobs_claim_idx ON public.msg_jobs (status, next_run_at, priority);
CREATE INDEX IF NOT EXISTS msg_jobs_channel_idx ON public.msg_jobs (channel_id, status);
CREATE INDEX IF NOT EXISTS msg_jobs_outbound_idx ON public.msg_jobs (outbound_id) WHERE outbound_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.msg_job_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  job_id       uuid NOT NULL,
  attempt_no   int NOT NULL CHECK (attempt_no >= 1),
  worker       text NOT NULL CHECK (char_length(worker) BETWEEN 1 AND 80),
  started_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at  timestamptz,
  outcome      text CHECK (outcome IN ('ok','retry','failed','unknown','conflict','abandoned','lease_lost')),
  adapter_mode text CHECK (adapter_mode IN ('mock','live')),
  calls        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(calls) = 'array' AND jsonb_array_length(calls) <= 50
                                                      AND octet_length(calls::text) <= 262144),
  error        jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  CONSTRAINT msg_job_attempts_job_fk FOREIGN KEY (job_id, org_id) REFERENCES public.msg_jobs(id, org_id),
  CONSTRAINT msg_job_attempts_no_uniq UNIQUE (job_id, attempt_no),
  CONSTRAINT msg_job_attempts_closed_chk CHECK ((outcome IS NULL) = (finished_at IS NULL)),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.msg_job_attempts IS 'G6b append-only worker attempt log (calls redacted; bodies replaced by {chars, sha256}). Closed exactly once.';
CREATE INDEX IF NOT EXISTS msg_job_attempts_job_idx ON public.msg_job_attempts (job_id, attempt_no);

CREATE TABLE IF NOT EXISTS public.msg_mock_mailboxes (
  channel_id uuid PRIMARY KEY,
  org_id     uuid NOT NULL,
  state      jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  version    int NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT msg_mock_mailboxes_channel_fk FOREIGN KEY (channel_id, org_id) REFERENCES public.msg_channels(id, org_id)
);
COMMENT ON TABLE public.msg_mock_mailboxes IS 'G6b staging only: persistent state of the MOCK e-mail / WhatsApp adapter per channel. No policy: service role only.';

-- late composite FKs (circular references)
ALTER TABLE public.msg_messages DROP CONSTRAINT IF EXISTS msg_messages_outbound_fk;
ALTER TABLE public.msg_messages ADD CONSTRAINT msg_messages_outbound_fk FOREIGN KEY (outbound_id, org_id) REFERENCES public.msg_outbound(id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS msg_messages_outbound_uidx ON public.msg_messages (outbound_id) WHERE outbound_id IS NOT NULL;
ALTER TABLE public.msg_replies DROP CONSTRAINT IF EXISTS msg_replies_current_fk;
ALTER TABLE public.msg_replies ADD CONSTRAINT msg_replies_current_fk FOREIGN KEY (current_version_id, id) REFERENCES public.msg_reply_versions(id, reply_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.msg_replies DROP CONSTRAINT IF EXISTS msg_replies_approved_fk;
ALTER TABLE public.msg_replies ADD CONSTRAINT msg_replies_approved_fk FOREIGN KEY (approved_version_id, id) REFERENCES public.msg_reply_versions(id, reply_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.msg_ai_runs DROP CONSTRAINT IF EXISTS msg_ai_runs_reply_fk;
ALTER TABLE public.msg_ai_runs ADD CONSTRAINT msg_ai_runs_reply_fk FOREIGN KEY (reply_id, org_id) REFERENCES public.msg_replies(id, org_id);

-- ---------------------------------------------------------------------
-- 2. triggers: append-only, guards, spans, provider request id, link history
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_msg_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_APPEND_ONLY', DETAIL = TG_TABLE_NAME;
END $$;

-- attachments: only sha256 / storage_status / scan_status move (live worker, service role)
CREATE OR REPLACE FUNCTION app.tg_msg_attachment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - ARRAY['sha256','storage_status','scan_status']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['sha256','storage_status','scan_status'])
     OR (OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_APPEND_ONLY', DETAIL = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

-- extractions: span check at insert (substr of the source text, code points); only the review columns move afterwards
CREATE OR REPLACE FUNCTION app.tg_msg_extraction_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_src text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source = 'attachment' THEN
      SELECT a.extracted_text INTO v_src FROM public.msg_attachments a WHERE a.id = NEW.attachment_id AND a.message_id = NEW.message_id;
    ELSE
      SELECT CASE NEW.source WHEN 'subject' THEN m.subject ELSE m.body_text END INTO v_src
        FROM public.msg_messages m WHERE m.id = NEW.message_id;
    END IF;
    IF v_src IS NULL OR NEW.span_start < 0 OR NEW.span_end <= NEW.span_start OR NEW.span_end > char_length(v_src)
       OR substr(v_src, NEW.span_start + 1, NEW.span_end - NEW.span_start) IS DISTINCT FROM NEW.raw THEN
      PERFORM app.fail('MRS_INVALID', 'span');
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - ARRAY['status','corrected_value','reviewed_by','reviewed_at','review_note'])
                          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','corrected_value','reviewed_by','reviewed_at','review_note']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_APPEND_ONLY', DETAIL = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

-- summaries: only accepted_by / accepted_at move, once
CREATE OR REPLACE FUNCTION app.tg_msg_summary_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.accepted_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['accepted_by','accepted_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['accepted_by','accepted_at']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_APPEND_ONLY', DETAIL = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

-- outbound: provider request id derived from the id (immutable); fact columns frozen; state forward only
CREATE OR REPLACE FUNCTION app.tg_msg_outbound_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.provider_request_id := 'MRSO-' || upper(substr(replace(NEW.id::text, '-', ''), 1, 16));
    NEW.state := 'queued';
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - ARRAY['state','provider_message_id','accepted_at','delivered_at','read_at','failed_at','last_error_code',
                                                 'last_error_message','unknown_resolution','resolved_by','resolved_at','resolution_note','updated_at'])
                          IS DISTINCT FROM
                          (to_jsonb(OLD) - ARRAY['state','provider_message_id','accepted_at','delivered_at','read_at','failed_at','last_error_code',
                                                 'last_error_message','unknown_resolution','resolved_by','resolved_at','resolution_note','updated_at'])
     OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_APPEND_ONLY', DETAIL = TG_TABLE_NAME;
  END IF;
  IF NEW.state <> OLD.state THEN
    v_ok := (OLD.state, NEW.state) IN (('queued','sending'),('queued','failed'),
                                       ('sending','accepted'),('sending','delivered'),('sending','read'),('sending','failed'),('sending','unknown'),
                                       ('accepted','delivered'),('accepted','read'),('accepted','failed'),
                                       ('delivered','read'),
                                       ('unknown','accepted'),('unknown','delivered'),('unknown','failed'),('unknown','queued'),
                                       ('failed','queued'));
    IF NOT v_ok THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'outbound_state'); END IF;
  END IF;
  RETURN NEW;
END $$;

-- attempts: opened at claim, closed exactly once; never deleted
CREATE OR REPLACE FUNCTION app.tg_msg_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL
     OR (to_jsonb(NEW) - ARRAY['finished_at','outcome','calls','error']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['finished_at','outcome','calls','error']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_APPEND_ONLY', DETAIL = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

-- threads: kind / channel / org immutable; every change of transaction_id needs its msg_thread_links row (this transaction)
CREATE OR REPLACE FUNCTION app.tg_msg_thread_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    PERFORM app.fail('MRS_INVALID', 'thread');
  END IF;
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     AND NOT EXISTS (SELECT 1 FROM public.msg_thread_links l
                      WHERE l.thread_id = NEW.id AND l.created_at >= now() AND l.action IN ('auto_link','link','unlink','not_related','review')
                        AND l.transaction_id IS NOT DISTINCT FROM NEW.transaction_id) THEN
    PERFORM app.fail('MRS_INVALID', 'link_history');
  END IF;
  RETURN NEW;
END $$;

-- replies: thread / channel immutable
CREATE OR REPLACE FUNCTION app.tg_msg_reply_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.thread_id IS DISTINCT FROM OLD.thread_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id THEN
    PERFORM app.fail('MRS_INVALID', 'reply');
  END IF;
  RETURN NEW;
END $$;

DO $trg$
DECLARE t text;
BEGIN
  -- pure append-only tables
  FOREACH t IN ARRAY ARRAY['msg_messages','msg_message_events','msg_classifications','msg_thread_links','msg_ai_runs',
                           'msg_reply_versions','msg_reply_approvals','msg_delivery_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_append_only ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_msg_append_only()', t);
  END LOOP;
  -- truncate refused on every append-only / guarded table
  FOREACH t IN ARRAY ARRAY['msg_messages','msg_message_events','msg_classifications','msg_thread_links','msg_ai_runs',
                           'msg_reply_versions','msg_reply_approvals','msg_delivery_events','msg_attachments','msg_extractions',
                           'msg_summaries','msg_outbound','msg_job_attempts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_append_only_trunc ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_append_only_trunc BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.tg_msg_append_only()', t);
  END LOOP;
END $trg$;
DROP TRIGGER IF EXISTS trg_append_only ON public.msg_attachments;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON public.msg_attachments FOR EACH ROW EXECUTE FUNCTION app.tg_msg_attachment_guard();
DROP TRIGGER IF EXISTS trg_append_only ON public.msg_extractions;
CREATE TRIGGER trg_append_only BEFORE INSERT OR UPDATE OR DELETE ON public.msg_extractions FOR EACH ROW EXECUTE FUNCTION app.tg_msg_extraction_guard();
DROP TRIGGER IF EXISTS trg_append_only ON public.msg_summaries;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON public.msg_summaries FOR EACH ROW EXECUTE FUNCTION app.tg_msg_summary_guard();
DROP TRIGGER IF EXISTS trg_append_only ON public.msg_outbound;
CREATE TRIGGER trg_append_only BEFORE INSERT OR UPDATE OR DELETE ON public.msg_outbound FOR EACH ROW EXECUTE FUNCTION app.tg_msg_outbound_guard();
DROP TRIGGER IF EXISTS trg_append_only ON public.msg_job_attempts;
CREATE TRIGGER trg_append_only BEFORE UPDATE OR DELETE ON public.msg_job_attempts FOR EACH ROW EXECUTE FUNCTION app.tg_msg_attempt_guard();
DROP TRIGGER IF EXISTS trg_msg_guard ON public.msg_threads;
CREATE TRIGGER trg_msg_guard BEFORE UPDATE ON public.msg_threads FOR EACH ROW EXECUTE FUNCTION app.tg_msg_thread_guard();
DROP TRIGGER IF EXISTS trg_msg_guard ON public.msg_replies;
CREATE TRIGGER trg_msg_guard BEFORE UPDATE ON public.msg_replies FOR EACH ROW EXECUTE FUNCTION app.tg_msg_reply_guard();

-- ---------------------------------------------------------------------
-- 3. internal helpers (revoked from the API roles; SECURITY DEFINER callers run them)
-- ---------------------------------------------------------------------
-- settings with defaults (a missing row = defaults)
CREATE OR REPLACE FUNCTION app.msg_settings_of(p_org uuid) RETURNS public.msg_settings
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.msg_settings;
BEGIN
  SELECT * INTO v FROM public.msg_settings s WHERE s.org_id = p_org;
  IF v.org_id IS NULL THEN
    v.org_id := p_org; v.ai_provider := 'rule_mock'; v.ai_monthly_budget_usd := 0; v.auto_link_enabled := true;
    v.require_four_eyes := true; v.retention_days := 730; v.purge_enabled := false; v.violation_repeat_days := 30; v.default_lang := 'ar';
  END IF;
  RETURN v;
END $$;
CREATE OR REPLACE FUNCTION app.msg_month_cost(p_org uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(sum(r.est_cost_usd), 0) FROM public.msg_ai_runs r
   WHERE r.org_id = p_org AND r.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'
$$;
CREATE OR REPLACE FUNCTION app.msg_settings_json(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(s) || jsonb_build_object('exists', EXISTS (SELECT 1 FROM public.msg_settings x WHERE x.org_id = p_org))
    FROM app.msg_settings_of(p_org) s
$$;

-- one internal 'message' event (never bodies / subjects / addresses / extracted values)
CREATE OR REPLACE FUNCTION app.msg_event(p_org uuid, p_tx uuid, p_op text, p_entity text, p_id uuid,
  p_extra jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_tx IS NULL THEN RETURN; END IF;
  INSERT INTO public.transaction_events (org_id, transaction_id, event_type, visible_to_client, actor, payload)
  VALUES (p_org, p_tx, 'message', false, auth.uid(),
          jsonb_build_object('op', p_op, 'entity', p_entity, 'id', p_id) || jsonb_strip_nulls(coalesce(p_extra, '{}'::jsonb)));
END $$;

-- org gate for org-level RPCs: staff of the org (else MRS_FORBIDDEN 'organization') holding one of the roles
CREATE OR REPLACE FUNCTION app.msg_gate(p_org uuid, p_roles text[]) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'organization'); END IF;
  IF NOT app.has_role(p_org, p_roles) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
END $$;

-- RLS helpers (granted to authenticated; RLS runs them as the caller)
CREATE OR REPLACE FUNCTION app.msg_can_read_thread(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.msg_threads t
                  WHERE t.id = p_thread AND app.has_branch_role(t.org_id, t.branch_id,
                        ARRAY['clearance_staff','transport_staff','accountant','accounts_manager','operations_manager','branch_manager','supervisor','admin']))
$$;
CREATE OR REPLACE FUNCTION app.msg_can_read_message(p_message uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.msg_messages m WHERE m.id = p_message AND app.msg_can_read_thread(m.thread_id))
$$;
CREATE OR REPLACE FUNCTION app.msg_can_read_job(j public.msg_jobs) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN j.thread_id IS NOT NULL THEN app.msg_can_read_thread(j.thread_id)
              ELSE app.has_role(j.org_id, ARRAY['admin']) END
$$;

-- the thread, locked, for a staff action needing p_roles at its branch (invisible → MRS_NOT_FOUND 'thread')
CREATE OR REPLACE FUNCTION app.msg_thread_for(p_thread uuid, p_roles text[]) RETURNS public.msg_threads
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.msg_threads;
BEGIN
  SELECT * INTO v FROM public.msg_threads t WHERE t.id = p_thread;
  IF v.id IS NULL OR NOT app.has_branch_role(v.org_id, v.branch_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'thread'); END IF;
  IF p_roles IS NOT NULL AND NOT app.has_branch_role(v.org_id, v.branch_id, p_roles) THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
  SELECT * INTO v FROM public.msg_threads t WHERE t.id = p_thread FOR UPDATE;
  RETURN v;
END $$;

-- enqueue a job, or return the live one with the same dedupe key (deduplicated true)
CREATE OR REPLACE FUNCTION app.msg_job_json(j public.msg_jobs) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(j) || jsonb_build_object(
    'last_attempt', (SELECT jsonb_build_object('id', a.id, 'attempt_no', a.attempt_no, 'outcome', a.outcome, 'worker', a.worker,
                                               'started_at', a.started_at, 'finished_at', a.finished_at, 'error', a.error)
                       FROM public.msg_job_attempts a WHERE a.job_id = j.id ORDER BY a.attempt_no DESC LIMIT 1),
    'worker_note', CASE WHEN j.status = 'queued' THEN 'queued_until_worker' END)
$$;
CREATE OR REPLACE FUNCTION app.msg_enqueue(p_org uuid, p_kind text, p_channel uuid, p_thread uuid, p_message uuid, p_reply uuid,
  p_outbound uuid, p_options jsonb DEFAULT '{}'::jsonb, p_by uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_key text; v_j public.msg_jobs; v_dedup boolean := false;
BEGIN
  v_key := p_kind || ':' || CASE p_kind WHEN 'process' THEN p_message WHEN 'send' THEN p_outbound
                                        WHEN 'draft' THEN coalesce(p_reply, p_thread) ELSE p_channel END::text;
  INSERT INTO public.msg_jobs (org_id, kind, channel_id, thread_id, message_id, reply_id, outbound_id, dedupe_key, options, priority, requested_by)
  VALUES (p_org, p_kind, p_channel, p_thread, p_message, p_reply, p_outbound, v_key, coalesce(p_options, '{}'::jsonb),
          CASE p_kind WHEN 'probe' THEN 0 WHEN 'send' THEN 1 WHEN 'process' THEN 2 WHEN 'draft' THEN 3 WHEN 'poll' THEN 4 ELSE 5 END, p_by)
  ON CONFLICT (org_id, dedupe_key) WHERE status IN ('queued','running','unknown') DO NOTHING
  RETURNING * INTO v_j;
  IF v_j.id IS NULL THEN
    SELECT * INTO v_j FROM public.msg_jobs j WHERE j.org_id = p_org AND j.dedupe_key = v_key AND j.status IN ('queued','running','unknown');
    v_dedup := true;
    IF v_j.status = 'queued' AND coalesce(p_options, '{}'::jsonb) <> '{}'::jsonb AND NOT (v_j.options @> p_options) THEN
      UPDATE public.msg_jobs j SET options = j.options || p_options, requested_by = coalesce(p_by, j.requested_by) WHERE j.id = v_j.id RETURNING * INTO v_j;
    END IF;
  END IF;
  RETURN app.msg_job_json(v_j) || jsonb_build_object('deduplicated', v_dedup);
END $$;

-- parties related to a transaction (§10): B/L shipping agent, trip carrier, appointment terminal, supplier on a G4 invoice
CREATE OR REPLACE FUNCTION app.msg_tx_parties(p_tx uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(DISTINCT x.p) FILTER (WHERE x.p IS NOT NULL), '{}'::uuid[]) FROM (
    SELECT b.shipping_agent_id p FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id WHERE tb.transaction_id = p_tx
    UNION ALL SELECT tt.carrier_id FROM public.transport_trips tt WHERE tt.transaction_id = p_tx
    UNION ALL SELECT pa.terminal_party_id FROM public.port_appointments pa WHERE pa.transaction_id = p_tx
    UNION ALL SELECT si.supplier_id FROM public.cost_allocations ca JOIN public.supplier_invoices si ON si.id = ca.supplier_invoice_id
               WHERE ca.transaction_id = p_tx AND ca.status <> 'rejected') x
$$;
-- a contact related to a transaction: the transaction's client, or a related party
CREATE OR REPLACE FUNCTION app.msg_contact_related(p_contact uuid, p_tx uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.msg_contacts c JOIN public.transactions t ON t.id = p_tx AND t.org_id = c.org_id
                  WHERE c.id = p_contact AND c.is_active
                    AND ((c.entity_type = 'client' AND c.client_id = t.client_id)
                         OR (c.entity_type = 'party' AND c.party_id = ANY (app.msg_tx_parties(p_tx)))))
$$;
-- an active, in-date authorization of the contact covering the transaction (and the document kind / topic when given)
CREATE OR REPLACE FUNCTION app.msg_auth_ok(p_contact uuid, p_tx uuid, p_kind text, p_category text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_contact IS NOT NULL AND p_tx IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.msg_contact_authorizations a JOIN public.transactions t ON t.id = p_tx AND t.org_id = a.org_id
                  JOIN public.msg_contacts c ON c.id = a.contact_id AND c.is_active
     WHERE a.contact_id = p_contact AND a.status = 'active'
       AND a.valid_from <= app.msg_today() AND (a.valid_until IS NULL OR a.valid_until >= app.msg_today())
       AND CASE a.scope_type WHEN 'transaction' THEN a.transaction_id = t.id
                             WHEN 'client' THEN a.client_id = t.client_id
                             ELSE a.party_id = ANY (app.msg_tx_parties(t.id)) END
       AND (p_kind IS NULL OR p_kind = ANY (a.may_receive_kinds))
       -- review fix: an empty topic list authorizes no topic (fail closed); documents are governed by may_receive_kinds
       AND (p_category IS NULL OR p_category = ANY (a.may_discuss)))
$$;
-- one recipient: directory / verification / authorization status
CREATE OR REPLACE FUNCTION app.msg_recipient_info(p_org uuid, p_kind text, p_addr text, p_tx uuid, p_category text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('address_norm', p_addr, 'contact_id', a.contact_id, 'contact_display_name', c.display_name,
                            'in_directory', a.id IS NOT NULL, 'verified', coalesce(a.verified_at IS NOT NULL, false),
                            'authorized', coalesce(a.verified_at IS NOT NULL AND app.msg_auth_ok(a.contact_id, p_tx, NULL, p_category), false))
    FROM (SELECT 1) one
    LEFT JOIN public.msg_contact_addresses a ON a.org_id = p_org AND a.kind = p_kind AND a.address_norm = p_addr AND a.status = 'active'
    LEFT JOIN public.msg_contacts c ON c.id = a.contact_id
$$;

-- §10 may this document go to these recipients? {ok, reasons[]}
CREATE OR REPLACE FUNCTION app.msg_share_check(p_thread public.msg_threads, p_to jsonb, p_cc jsonb, p_document uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents; v_kind text; r text[] := '{}'; e jsonb; a public.msg_contact_addresses;
BEGIN
  IF p_thread.transaction_id IS NULL THEN r := r || 'no_link'::text; END IF;
  SELECT * INTO d FROM public.documents x WHERE x.id = p_document AND x.org_id = p_thread.org_id;
  IF d.id IS NULL OR d.transaction_id IS DISTINCT FROM p_thread.transaction_id THEN r := r || 'doc_other_tx'::text; END IF;
  IF d.voided_at IS NOT NULL THEN r := r || 'doc_voided'::text; END IF;
  v_kind := coalesce(d.classification, d.kind);
  IF jsonb_array_length(coalesce(p_to, '[]'::jsonb)) = 0 THEN r := r || 'recipient_unverified'::text; END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(p_to, '[]'::jsonb) || coalesce(p_cc, '[]'::jsonb)) x LOOP
    SELECT * INTO a FROM public.msg_contact_addresses y
     WHERE y.org_id = p_thread.org_id AND y.kind = p_thread.kind AND y.address_norm = e ->> 'address_norm' AND y.status = 'active';
    IF a.id IS NULL OR a.verified_at IS NULL THEN
      IF NOT ('recipient_unverified' = ANY (r)) THEN r := r || 'recipient_unverified'::text; END IF;
    ELSIF NOT app.msg_auth_ok(a.contact_id, p_thread.transaction_id, NULL, NULL) THEN
      IF NOT ('recipient_unauthorized' = ANY (r)) THEN r := r || 'recipient_unauthorized'::text; END IF;
    ELSIF NOT app.msg_auth_ok(a.contact_id, p_thread.transaction_id, v_kind, NULL) THEN
      IF NOT ('kind_not_authorized' = ANY (r)) THEN r := r || 'kind_not_authorized'::text; END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', cardinality(r) = 0, 'reasons', to_jsonb(r));
END $$;
CREATE OR REPLACE FUNCTION app.msg_can_share(p_reply uuid, p_document uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.msg_replies; t public.msg_threads; v public.msg_reply_versions;
BEGIN
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply;
  SELECT * INTO t FROM public.msg_threads x WHERE x.id = r.thread_id;
  SELECT * INTO v FROM public.msg_reply_versions x WHERE x.id = r.current_version_id;
  RETURN app.msg_share_check(t, v.to_addresses, v.cc_addresses, p_document);
END $$;

-- §16 approval level of a category: the approved approval_level instruction, else the default
CREATE OR REPLACE FUNCTION app.msg_approval_level(p_org uuid, p_category text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT i.params ->> 'level' FROM public.msg_instructions i
      WHERE i.org_id = p_org AND i.kind = 'approval_level' AND i.status = 'approved' AND i.params ->> 'category' = p_category
        AND i.params ->> 'level' IN ('standard','finance','management')
      ORDER BY i.reviewed_at DESC NULLS LAST, i.id LIMIT 1),
    CASE p_category WHEN 'freight_charges' THEN 'finance' WHEN 'violation' THEN 'management' ELSE 'standard' END)
$$;

-- review fix (approval control): the level of a reply is the STRICTEST of the reply's category, the thread's current category,
-- every category the thread's messages were ever classified as (AI or staff: a later correction or a padded message never
-- lowers it), and every category with ≥ 2 distinct keyword hits in an AI classification (keyword padding cannot hide a
-- violation / charges topic behind an 'unknown' result)
CREATE OR REPLACE FUNCTION app.msg_level_rank(p text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'management' THEN 2 WHEN 'finance' THEN 1 ELSE 0 END
$$;
CREATE OR REPLACE FUNCTION app.msg_effective_level(p_org uuid, p_thread uuid, p_category text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((
    SELECT l FROM (SELECT DISTINCT app.msg_approval_level(p_org, c) AS l FROM (
        SELECT p_category AS c
        UNION SELECT t.category FROM public.msg_threads t WHERE t.id = p_thread
        UNION SELECT k.category FROM public.msg_classifications k WHERE k.thread_id = p_thread
        UNION SELECT h.rule FROM (SELECT x ->> 'rule' AS rule, count(DISTINCT x ->> 'keyword') AS n
                                    FROM public.msg_classifications k, jsonb_array_elements(coalesce(k.rules, '[]'::jsonb)) x
                                   WHERE k.thread_id = p_thread AND k.source = 'ai' AND jsonb_typeof(x) = 'object'
                                   GROUP BY k.id, x ->> 'rule') h WHERE h.n >= 2) z
      WHERE c IS NOT NULL) y
    ORDER BY app.msg_level_rank(l) DESC LIMIT 1), 'standard')
$$;

-- latest category of a message (staff correction or ai)
CREATE OR REPLACE FUNCTION app.msg_message_category(p_message uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.category FROM public.msg_classifications c WHERE c.message_id = p_message ORDER BY c.created_at DESC, c.id DESC LIMIT 1
$$;
-- thread category = latest classification of its latest classified inbound message
CREATE OR REPLACE FUNCTION app.msg_refresh_category(p_thread uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v text;
BEGIN
  SELECT app.msg_message_category(m.id) INTO v FROM public.msg_messages m
   WHERE m.thread_id = p_thread AND m.direction = 'inbound' AND EXISTS (SELECT 1 FROM public.msg_classifications c WHERE c.message_id = m.id)
   ORDER BY m.received_at DESC, m.id DESC LIMIT 1;
  UPDATE public.msg_threads t SET category = v WHERE t.id = p_thread AND t.category IS DISTINCT FROM v;
END $$;

-- ---------------------------------------------------------------------
-- §12 matching
-- ---------------------------------------------------------------------
-- signals of a thread: [{transaction_id, kind, value, extraction_id, message_id, strength, trusted}] (same org only)
-- review fixes: a staff-corrected value counts (its validity was re-checked by review_msg_extraction) but is staff evidence,
-- never an independent signal for auto-linking; 'trusted' = the extraction comes from an inbound message whose sender is a
-- verified address of a contact related to that transaction (G6b-5 per signal, not only the latest sender).
CREATE OR REPLACE FUNCTION app.msg_signals(p_thread uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH th AS (SELECT * FROM public.msg_threads t WHERE t.id = p_thread),
  ex AS (SELECT e.id, e.kind, coalesce(e.corrected_value, e.normalized) AS v, e.message_id AS mid,
                (m.direction = 'inbound' AND m.sender_status = 'verified' AND e.status <> 'corrected') AS tsrc, m.sender_contact_id AS sc
           FROM public.msg_extractions e JOIN public.msg_messages m ON m.id = e.message_id, th
          WHERE e.thread_id = th.id AND e.status <> 'rejected' AND (e.valid OR e.status = 'corrected')),
  s AS (
    SELECT tx.id AS tx, 'tx_ref' AS kind, ex.v AS value, ex.id AS eid, ex.mid, 'strong' AS strength, ex.tsrc, ex.sc
      FROM ex, th JOIN public.transactions tx ON tx.org_id = th.org_id WHERE ex.kind = 'tx_ref' AND upper(tx.ref) = upper(ex.v)
    UNION
    SELECT tx.id, 'bl_number', ex.v, ex.id, ex.mid, 'strong', ex.tsrc, ex.sc FROM ex, th JOIN public.transactions tx ON tx.org_id = th.org_id
     WHERE ex.kind = 'bl_number' AND (app.rpt_norm_no(tx.bl_number) = app.rpt_norm_no(ex.v)
           OR EXISTS (SELECT 1 FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                       WHERE tb.transaction_id = tx.id AND app.rpt_norm_no(b.bl_number) = app.rpt_norm_no(ex.v)))
    UNION
    SELECT k.transaction_id, 'container_no', ex.v, ex.id, ex.mid, 'strong', ex.tsrc, ex.sc FROM ex, th JOIN public.containers k ON k.org_id = th.org_id
     WHERE ex.kind = 'container_no' AND app.msg_iso6346_ok(ex.v) AND app.rpt_norm_container(k.container_no) = app.rpt_norm_container(ex.v)
    UNION
    SELECT tx.id, 'declaration_no', ex.v, ex.id, ex.mid, 'strong', ex.tsrc, ex.sc FROM ex, th JOIN public.transactions tx ON tx.org_id = th.org_id
     WHERE ex.kind = 'declaration_no' AND (app.rpt_norm_no(tx.declaration_no) = app.rpt_norm_no(ex.v)
           OR EXISTS (SELECT 1 FROM public.customs_declarations d WHERE d.transaction_id = tx.id AND app.rpt_norm_no(d.declaration_no) = app.rpt_norm_no(ex.v)))
    UNION
    SELECT ca.transaction_id, 'invoice_no', ex.v, ex.id, ex.mid, 'medium', ex.tsrc, ex.sc FROM ex, th
      JOIN public.supplier_invoices si ON si.org_id = th.org_id
      JOIN public.cost_allocations ca ON ca.supplier_invoice_id = si.id AND ca.status <> 'rejected'
     WHERE ex.kind = 'invoice_no' AND si.number_norm = app.fin_norm_no(ex.v)
    UNION
    SELECT bi.transaction_id, 'invoice_no', ex.v, ex.id, ex.mid, 'medium', ex.tsrc, ex.sc FROM ex, th JOIN public.billing_intents bi ON bi.org_id = th.org_id
     WHERE ex.kind = 'invoice_no' AND bi.daftra_number IS NOT NULL AND app.rpt_norm_no(bi.daftra_number) = app.rpt_norm_no(ex.v)
    UNION
    SELECT pa.transaction_id, 'appointment_no', ex.v, ex.id, ex.mid, 'medium', ex.tsrc, ex.sc FROM ex, th JOIN public.port_appointments pa ON pa.org_id = th.org_id
     WHERE ex.kind = 'appointment_no' AND pa.appointment_no IS NOT NULL AND app.rpt_norm_no(pa.appointment_no) = app.rpt_norm_no(ex.v)
    UNION
    -- thread continuity: an earlier message of the thread was staff-linked (a staff decision: trusted)
    SELECT l.transaction_id, 'thread', NULL, NULL::uuid, NULL::uuid, 'strong', true, NULL::uuid FROM public.msg_thread_links l, th
     WHERE l.thread_id = th.id AND l.action = 'link' AND l.method = 'staff'
       AND NOT EXISTS (SELECT 1 FROM public.msg_thread_links u WHERE u.thread_id = th.id AND u.created_at > l.created_at
                          AND u.action IN ('unlink','not_related','link'))),
  sender AS (
    SELECT m.sender_contact_id AS c FROM public.msg_messages m, th
     WHERE m.thread_id = th.id AND m.direction = 'inbound' ORDER BY m.received_at DESC, m.id DESC LIMIT 1),
  s1 AS (
    SELECT s.tx, s.kind, s.value, s.eid, s.mid, s.strength,
           (s.tsrc AND (s.kind = 'thread' OR (s.sc IS NOT NULL AND app.msg_contact_related(s.sc, s.tx)))) AS trusted
      FROM s),
  s2 AS (
    SELECT * FROM s1
    UNION
    SELECT x.tx, 'sender', NULL, NULL::uuid, NULL::uuid, 'medium', false FROM (SELECT DISTINCT s1.tx FROM s1) x, sender
     WHERE sender.c IS NOT NULL AND app.msg_contact_related(sender.c, x.tx))
  SELECT coalesce(jsonb_agg(jsonb_build_object('transaction_id', s2.tx, 'kind', s2.kind, 'value', s2.value, 'extraction_id', s2.eid,
                                               'message_id', s2.mid, 'strength', s2.strength, 'trusted', s2.trusted)
                            ORDER BY s2.tx, s2.kind, s2.value, s2.eid), '[]'::jsonb)
    FROM s2 WHERE s2.tx IS NOT NULL
$$;

-- candidates from signals: [{transaction_id, ref, branch_id, score, strong_kinds, trusted_strong_kinds, signals:[…]}] sorted, ≤ 10
CREATE OR REPLACE FUNCTION app.msg_candidates(p_signals jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH s AS (SELECT (x ->> 'transaction_id')::uuid AS tx, x ->> 'kind' AS kind, x ->> 'strength' AS strength,
                    coalesce((x ->> 'trusted')::boolean, false) AS trusted, x AS j
               FROM jsonb_array_elements(coalesce(p_signals, '[]'::jsonb)) x),
  k AS (SELECT s.tx, s.kind, max(s.strength) AS strength, bool_or(s.trusted) AS trusted FROM s GROUP BY s.tx, s.kind),
  c AS (SELECT k.tx, sum(CASE WHEN k.strength = 'strong' THEN 3 ELSE 1 END)::int AS score,
               count(*) FILTER (WHERE k.strength = 'strong')::int AS strong_kinds,
               count(*) FILTER (WHERE k.strength = 'strong' AND k.trusted)::int AS trusted_strong_kinds
          FROM k GROUP BY k.tx)
  SELECT coalesce(jsonb_agg(x.o ORDER BY x.score DESC, x.ref, x.tx), '[]'::jsonb) FROM (
    SELECT c.tx, c.score, t.ref, jsonb_build_object('transaction_id', c.tx, 'ref', t.ref, 'branch_id', t.branch_id, 'score', c.score,
             'strong_kinds', c.strong_kinds, 'trusted_strong_kinds', c.trusted_strong_kinds,
             'signals', (SELECT jsonb_agg(jsonb_build_object('kind', s.j ->> 'kind', 'value', s.j -> 'value', 'extraction_id', s.j -> 'extraction_id',
                                                             'message_id', s.j -> 'message_id', 'strength', s.j ->> 'strength',
                                                             'trusted', s.trusted) ORDER BY s.j ->> 'kind', s.j ->> 'value')
                           FROM s WHERE s.tx = c.tx)) AS o
      FROM c JOIN public.transactions t ON t.id = c.tx
     ORDER BY c.score DESC, t.ref, c.tx LIMIT 10) x
$$;

-- review fix (isolation): candidates as the caller may see them — a transaction of a branch the caller cannot read is masked
-- ({hidden, other_branch, score, strong_kinds}: no id, no ref, no branch, no signal values)
CREATE OR REPLACE FUNCTION app.msg_visible_candidates(p_org uuid, p_c jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(CASE WHEN tx.id IS NOT NULL AND app.has_branch_role(p_org, tx.branch_id, app.msg_read_roles()) THEN x.c
                                 ELSE jsonb_build_object('hidden', true, 'other_branch', true, 'score', x.c -> 'score',
                                                         'strong_kinds', x.c -> 'strong_kinds') END ORDER BY x.n), '[]'::jsonb)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_c) = 'array' THEN p_c ELSE '[]'::jsonb END) WITH ORDINALITY x(c, n)
    LEFT JOIN public.transactions tx ON tx.id = CASE WHEN (x.c ->> 'transaction_id') ~ '^[0-9a-f-]{36}$' THEN (x.c ->> 'transaction_id')::uuid END
                                    AND tx.org_id = p_org
$$;
-- a link-history basis as the caller may see it: candidate ids of unreadable transactions removed
CREATE OR REPLACE FUNCTION app.msg_visible_basis(p_org uuid, p_b jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN jsonb_typeof(p_b) <> 'object' THEN p_b ELSE
    p_b || jsonb_build_object('candidates', coalesce((
      SELECT jsonb_agg(CASE WHEN tx.id IS NOT NULL AND app.has_branch_role(p_org, tx.branch_id, app.msg_read_roles()) THEN x.c
                            ELSE jsonb_build_object('hidden', true, 'score', x.c -> 'score') END ORDER BY x.n)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_b -> 'candidates') = 'array' THEN p_b -> 'candidates' ELSE '[]'::jsonb END) WITH ORDINALITY x(c, n)
        LEFT JOIN public.transactions tx ON tx.id = CASE WHEN (x.c ->> 'transaction_id') ~ '^[0-9a-f-]{36}$' THEN (x.c ->> 'transaction_id')::uuid END
                                        AND tx.org_id = p_org), '[]'::jsonb))
    || CASE WHEN p_b ? 'previous_transaction_id' AND jsonb_typeof(p_b -> 'previous_transaction_id') = 'string'
                 AND NOT EXISTS (SELECT 1 FROM public.transactions y WHERE y.id = (p_b ->> 'previous_transaction_id')::uuid AND y.org_id = p_org
                                    AND app.has_branch_role(p_org, y.branch_id, app.msg_read_roles()))
            THEN jsonb_build_object('previous_transaction_id', NULL, 'previous_hidden', true) ELSE '{}'::jsonb END
  END
$$;

-- link a thread (writes the history row first; the thread guard checks it); emits the events
CREATE OR REPLACE FUNCTION app.msg_set_link(p_t public.msg_threads, p_tx uuid, p_action text, p_method text, p_basis jsonb,
  p_note text, p_status text, p_reason text) RETURNS public.msg_threads
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.msg_threads; v_branch uuid;
BEGIN
  -- review fix (defense in depth, G6b-7): a link decided inside a staff call never lands in a branch the caller cannot triage
  IF p_action IN ('auto_link','link') AND auth.uid() IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.transactions x WHERE x.id = p_tx AND x.org_id = p_t.org_id
          AND app.has_branch_role(x.org_id, x.branch_id, app.msg_triage_roles())) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'branch');
  END IF;
  INSERT INTO public.msg_thread_links (org_id, thread_id, transaction_id, action, method, basis, actor, note)
  VALUES (p_t.org_id, p_t.id, CASE WHEN p_action IN ('auto_link','link') THEN p_tx END, p_action, p_method, p_basis,
          CASE WHEN p_method = 'staff' THEN auth.uid() END, p_note);
  IF p_action IN ('auto_link','link') THEN
    SELECT t.branch_id INTO v_branch FROM public.transactions t WHERE t.id = p_tx;
  ELSE
    v_branch := p_t.branch_id;
  END IF;
  UPDATE public.msg_threads t SET transaction_id = CASE WHEN p_action IN ('auto_link','link') THEN p_tx END,
         branch_id = v_branch, match_status = p_status, match_reason = p_reason
   WHERE t.id = p_t.id RETURNING * INTO v;
  IF p_t.transaction_id IS NOT NULL AND p_t.transaction_id IS DISTINCT FROM v.transaction_id THEN
    PERFORM app.msg_event(p_t.org_id, p_t.transaction_id, 'thread_unlinked', 'thread', p_t.id,
                          jsonb_build_object('thread_id', p_t.id, 'method', p_method));
  END IF;
  IF v.transaction_id IS NOT NULL AND v.transaction_id IS DISTINCT FROM p_t.transaction_id THEN
    PERFORM app.msg_event(v.org_id, v.transaction_id, 'thread_linked', 'thread', v.id,
                          jsonb_build_object('thread_id', v.id, 'method', p_method, 'category', v.category));
  END IF;
  RETURN v;
END $$;

-- §12 decision (G6b-5); a staff decision (linked / not_related) is never re-decided automatically.
-- Review fixes: auto-linking counts only TRUSTED strong signals (extractions from verified, related senders; never a staff
-- correction); an auto_linked thread is re-checked (a strong conflict or an unverified / unrelated latest sender → review);
-- an auto link decided inside a staff call needs triage at the transaction branch (else it stays a suggestion).
CREATE OR REPLACE FUNCTION app.msg_match(p_thread uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; v_sig jsonb; v_c jsonb; v_top jsonb; v_n int; v_strong_tx int; v_sender public.msg_messages;
        v_auto boolean; v_status text; v_reason text; v_basis jsonb; v_related boolean := false; v_top_tx uuid; v_conflict boolean;
        v_cur_related boolean;
BEGIN
  SELECT * INTO t FROM public.msg_threads x WHERE x.id = p_thread FOR UPDATE;
  v_sig := app.msg_signals(t.id);
  v_c := app.msg_candidates(v_sig);
  v_n := jsonb_array_length(v_c);
  v_top := v_c -> 0;
  v_top_tx := (v_top ->> 'transaction_id')::uuid;
  SELECT count(*)::int INTO v_strong_tx FROM jsonb_array_elements(v_c) x WHERE (x ->> 'strong_kinds')::int > 0;
  SELECT * INTO v_sender FROM public.msg_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' ORDER BY m.received_at DESC, m.id DESC LIMIT 1;
  IF v_top_tx IS NOT NULL AND v_sender.sender_contact_id IS NOT NULL THEN
    v_related := app.msg_contact_related(v_sender.sender_contact_id, v_top_tx);
  END IF;
  v_auto := v_n >= 1 AND (app.msg_settings_of(t.org_id)).auto_link_enabled AND (v_top ->> 'strong_kinds')::int >= 2
            AND coalesce((v_top ->> 'trusted_strong_kinds')::int, 0) >= 2
            AND v_strong_tx = 1 AND v_sender.sender_status = 'verified' AND v_related;
  -- a staff call (review_msg_extraction) may only cause an auto link inside its own branch scope
  IF v_auto AND auth.uid() IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.transactions x WHERE x.id = v_top_tx
                                                        AND app.has_branch_role(x.org_id, x.branch_id, app.msg_triage_roles())) THEN
    v_auto := false;
  END IF;
  IF v_n = 0 THEN v_status := 'unmatched'; v_reason := 'no_signal';
  ELSIF v_auto THEN v_status := 'auto_linked'; v_reason := NULL;
  ELSIF v_strong_tx >= 2 THEN v_status := 'review'; v_reason := 'conflict';
  ELSIF v_n >= 2 THEN v_status := 'review'; v_reason := 'multiple';
  ELSE v_status := 'suggested';
       v_reason := CASE WHEN (v_top ->> 'strong_kinds')::int >= 2 THEN 'unverified_sender' ELSE 'single_signal' END;
  END IF;
  v_basis := jsonb_build_object(
    'signals', coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(coalesce(v_top -> 'signals', '[]'::jsonb)) x), '[]'::jsonb),
    'score', coalesce((v_top ->> 'score')::int, 0),
    'trusted_strong_kinds', coalesce((v_top ->> 'trusted_strong_kinds')::int, 0),
    'candidates', coalesce((SELECT jsonb_agg(jsonb_build_object('transaction_id', x -> 'transaction_id', 'score', x -> 'score')) FROM jsonb_array_elements(v_c) x), '[]'::jsonb),
    'sender', jsonb_build_object('status', v_sender.sender_status, 'contact_id', v_sender.sender_contact_id, 'related', v_related,
                                 'message_id', v_sender.id),
    'rule', CASE WHEN v_auto THEN 'two_strong_single' ELSE coalesce(v_reason, 'none') END);
  v_conflict := t.transaction_id IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_c) c
                   WHERE (c ->> 'strong_kinds')::int > 0 AND (c ->> 'transaction_id')::uuid IS DISTINCT FROM t.transaction_id);
  v_cur_related := t.transaction_id IS NOT NULL AND v_sender.sender_status = 'verified' AND v_sender.sender_contact_id IS NOT NULL
                   AND app.msg_contact_related(v_sender.sender_contact_id, t.transaction_id);
  -- a machine link is not a staff decision: a strong conflict or a latest sender that is not a verified, related contact → review
  IF t.match_status = 'auto_linked' AND (v_conflict OR NOT v_cur_related) THEN
    UPDATE public.msg_threads x SET match_candidates = v_c WHERE x.id = t.id RETURNING * INTO t;
    t := app.msg_set_link(t, NULL, 'review', 'auto', v_basis || jsonb_build_object('previous_transaction_id', t.transaction_id,
                            'rule', CASE WHEN v_conflict THEN 'conflict' ELSE 'sender_unverified' END),
                          NULL, 'review', CASE WHEN v_conflict THEN 'conflict' ELSE 'sender_unverified' END);
    RETURN jsonb_build_object('decision', 'review', 'reason', t.match_reason, 'kept', false, 'candidates', v_c);
  END IF;
  -- staff decisions and an existing link stay; only the candidates (and a conflict / sender reason) move
  IF t.match_status IN ('linked','not_related','auto_linked') THEN
    UPDATE public.msg_threads x SET match_candidates = v_c,
           match_reason = CASE WHEN v_conflict THEN 'conflict'
                               WHEN t.match_status = 'linked' AND NOT v_cur_related THEN 'sender_unverified'
                               ELSE x.match_reason END
     WHERE x.id = t.id;
    RETURN jsonb_build_object('decision', t.match_status, 'kept', true, 'candidates', v_c);
  END IF;
  IF v_auto THEN
    UPDATE public.msg_threads x SET match_candidates = v_c WHERE x.id = t.id RETURNING * INTO t;
    t := app.msg_set_link(t, v_top_tx, 'auto_link', 'auto', v_basis, NULL, 'auto_linked', NULL);
  ELSE
    IF v_status = 'review' AND t.match_status <> 'review' THEN
      INSERT INTO public.msg_thread_links (org_id, thread_id, transaction_id, action, method, basis)
      VALUES (t.org_id, t.id, NULL, 'review', 'auto', v_basis);
    END IF;
    UPDATE public.msg_threads x SET match_candidates = v_c, match_status = v_status, match_reason = v_reason WHERE x.id = t.id;
  END IF;
  RETURN jsonb_build_object('decision', v_status, 'reason', v_reason, 'kept', false, 'candidates', v_c);
END $$;

-- §11 triage after a processed inbound message (never overrides what staff set: triage_locked)
CREATE OR REPLACE FUNCTION app.msg_triage(p_thread uuid, p_message uuid, p_repeated boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; v_cat text; v_dl date; v_new text;
BEGIN
  SELECT * INTO t FROM public.msg_threads x WHERE x.id = p_thread FOR UPDATE;
  IF t.triage_locked ? 'priority' THEN RETURN; END IF;
  v_cat := app.msg_message_category(p_message);
  SELECT s.deadline_date INTO v_dl FROM public.msg_summaries s WHERE s.message_id = p_message ORDER BY s.created_at DESC, s.id DESC LIMIT 1;
  v_new := CASE WHEN v_cat = 'violation' AND p_repeated THEN 'urgent'
                WHEN v_cat = 'violation' THEN 'high'
                WHEN v_cat = 'appointment' AND v_dl IS NOT NULL AND v_dl >= app.msg_today() AND v_dl <= app.msg_today() + 2 THEN 'high' END;
  IF v_new IS NOT NULL AND app.code_sort('msg_priority', v_new) > app.code_sort('msg_priority', t.priority) THEN
    UPDATE public.msg_threads x SET priority = v_new WHERE x.id = t.id;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- ingest (G6b-6 threading, §10 sender check, dedupe)
-- ---------------------------------------------------------------------
-- [{address, name}] from a JSON array (≤ 50), addresses normalized; MRS_INVALID <field>
CREATE OR REPLACE FUNCTION app.msg_parse_addrs(p_kind text, p jsonb, p_field text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE r jsonb := '[]'::jsonb; e jsonb; v text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN r; END IF;
  IF jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) > 50 THEN PERFORM app.fail('MRS_INVALID', p_field); END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p) x LOOP
    IF jsonb_typeof(e) = 'string' THEN e := jsonb_build_object('address', e #>> '{}'); END IF;
    IF jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'address') <> 'string'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('address','name'))
       OR jsonb_typeof(coalesce(e -> 'name', 'null'::jsonb)) NOT IN ('string','null') OR char_length(e ->> 'name') > 160 THEN
      PERFORM app.fail('MRS_INVALID', p_field);
    END IF;
    v := app.msg_try_norm(p_kind, e ->> 'address');
    IF v IS NULL THEN PERFORM app.fail('MRS_INVALID', p_field); END IF;
    r := r || jsonb_build_array(jsonb_build_object('address', v, 'name', nullif(btrim(coalesce(e ->> 'name', '')), '')));
  END LOOP;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION app.msg_ingest_one(p_ch public.msg_channels, p_m jsonb, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_pmid text; v_dup public.msg_messages; v_from jsonb; v_from_norm text; v_from_name text; v_to jsonb; v_cc jsonb; v_rcpt text;
        v_sent timestamptz; v_at timestamptz; v_subject text; v_body text; v_headers jsonb; v_wa jsonb; v_auth jsonb; v_raw jsonb;
        v_ptid text; v_thread public.msg_threads; v_msg public.msg_messages; v_flags text[] := '{}'; v_status text := 'unknown';
        v_addr public.msg_contact_addresses; v_signals jsonb := '{}'::jsonb; v_ids text[]; e jsonb; k text; v_dom text;
        v_att_id uuid; v_new_thread boolean := false; v_n int := 0; v_txt text;
BEGIN
  IF p_m IS NULL OR jsonb_typeof(p_m) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'message'); END IF;
  PERFORM app.only_keys(p_m, ARRAY['provider_message_id','provider_thread_id','kind','from','to','cc','sent_at','subject','body_text',
                                   'headers','wa_context','auth','attachments','raw']);
  v_pmid := app.msg_rtext(p_m, 'provider_message_id', 200);
  IF v_pmid IS NULL OR btrim(v_pmid) = '' OR v_pmid ~ '[[:cntrl:]]' THEN PERFORM app.fail('MRS_INVALID', 'provider_message_id'); END IF;
  IF coalesce(app.msg_rtext(p_m, 'kind', 20), p_ch.kind) <> p_ch.kind THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  -- dedupe (webhook + poll, re-delivery, retry): the existing copy, nothing changes
  SELECT * INTO v_dup FROM public.msg_messages m
   WHERE m.org_id = p_ch.org_id AND m.channel_id = p_ch.id AND m.provider_message_id = v_pmid;
  IF v_dup.id IS NOT NULL THEN
    RETURN jsonb_build_object('provider_message_id', v_pmid, 'message_id', v_dup.id, 'thread_id', v_dup.thread_id, 'duplicate', true);
  END IF;
  v_from := p_m -> 'from';
  IF v_from IS NULL OR jsonb_typeof(v_from) <> 'object' OR jsonb_typeof(v_from -> 'address') <> 'string'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_from) x WHERE x NOT IN ('address','name')) THEN
    PERFORM app.fail('MRS_INVALID', 'from');
  END IF;
  v_from_norm := app.msg_try_norm(p_ch.kind, v_from ->> 'address');
  IF v_from_norm IS NULL THEN PERFORM app.fail('MRS_INVALID', 'from'); END IF;
  v_from_name := nullif(btrim(coalesce(app.msg_rtext(v_from, 'name', 160, 'from'), '')), '');
  v_to := app.msg_parse_addrs(p_ch.kind, p_m -> 'to', 'to');
  v_cc := app.msg_parse_addrs(p_ch.kind, p_m -> 'cc', 'cc');
  v_sent := app.msg_rts(p_m, 'sent_at');
  v_at := least(coalesce(v_sent, clock_timestamp()), clock_timestamp());
  v_subject := app.msg_rtext(p_m, 'subject', 500);
  IF jsonb_typeof(p_m -> 'body_text') IS DISTINCT FROM 'string' THEN PERFORM app.fail('MRS_INVALID', 'body_text'); END IF;
  v_body := p_m ->> 'body_text';
  IF char_length(v_body) > 100000 THEN PERFORM app.fail('MRS_INVALID', 'body_text'); END IF;
  v_ptid := app.msg_rtext(p_m, 'provider_thread_id', 200);
  -- headers (e-mail only)
  IF jsonb_typeof(p_m -> 'headers') = 'object' THEN
    IF p_ch.kind <> 'email' THEN PERFORM app.fail('MRS_INVALID', 'headers'); END IF;
    PERFORM app.only_keys(p_m -> 'headers', ARRAY['message_id','in_reply_to','references']);
    IF jsonb_typeof(coalesce(p_m #> '{headers,references}', '[]'::jsonb)) NOT IN ('array','null')
       OR jsonb_array_length(coalesce(nullif(p_m #> '{headers,references}', 'null'::jsonb), '[]'::jsonb)) > 50
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(nullif(p_m #> '{headers,references}', 'null'::jsonb), '[]'::jsonb)) x
                   WHERE jsonb_typeof(x) <> 'string' OR char_length(x #>> '{}') > 998) THEN
      PERFORM app.fail('MRS_INVALID', 'headers');
    END IF;
    v_headers := jsonb_build_object('message_id', app.msg_rtext(p_m -> 'headers', 'message_id', 998, 'headers'),
                                    'in_reply_to', app.msg_rtext(p_m -> 'headers', 'in_reply_to', 998, 'headers'),
                                    'references', coalesce(nullif(p_m #> '{headers,references}', 'null'::jsonb), '[]'::jsonb));
  ELSIF jsonb_typeof(p_m -> 'headers') IS NOT NULL AND jsonb_typeof(p_m -> 'headers') <> 'null' THEN
    PERFORM app.fail('MRS_INVALID', 'headers');
  END IF;
  IF jsonb_typeof(p_m -> 'wa_context') = 'object' THEN
    IF p_ch.kind <> 'whatsapp' THEN PERFORM app.fail('MRS_INVALID', 'wa_context'); END IF;
    PERFORM app.only_keys(p_m -> 'wa_context', ARRAY['reply_to_provider_id','type']);
    v_wa := jsonb_build_object('reply_to_provider_id', app.msg_rtext(p_m -> 'wa_context', 'reply_to_provider_id', 200, 'wa_context'),
                               'type', app.msg_rtext(p_m -> 'wa_context', 'type', 40, 'wa_context'));
  ELSIF jsonb_typeof(p_m -> 'wa_context') IS NOT NULL AND jsonb_typeof(p_m -> 'wa_context') <> 'null' THEN
    PERFORM app.fail('MRS_INVALID', 'wa_context');
  END IF;
  IF jsonb_typeof(p_m -> 'auth') = 'object' THEN
    IF p_ch.kind <> 'email' THEN PERFORM app.fail('MRS_INVALID', 'auth'); END IF;
    PERFORM app.only_keys(p_m -> 'auth', ARRAY['spf','dkim','dmarc']);
    FOREACH k IN ARRAY ARRAY['spf','dkim','dmarc'] LOOP
      IF coalesce(p_m -> 'auth' ->> k, 'none') NOT IN ('pass','fail','none') THEN PERFORM app.fail('MRS_INVALID', 'auth'); END IF;
    END LOOP;
    v_auth := jsonb_build_object('spf', coalesce(p_m #>> '{auth,spf}', 'none'), 'dkim', coalesce(p_m #>> '{auth,dkim}', 'none'),
                                 'dmarc', coalesce(p_m #>> '{auth,dmarc}', 'none'));
  ELSIF jsonb_typeof(p_m -> 'auth') IS NOT NULL AND jsonb_typeof(p_m -> 'auth') <> 'null' THEN
    PERFORM app.fail('MRS_INVALID', 'auth');
  END IF;
  IF jsonb_typeof(coalesce(p_m -> 'attachments', '[]'::jsonb)) NOT IN ('array','null')
     OR jsonb_array_length(coalesce(nullif(p_m -> 'attachments', 'null'::jsonb), '[]'::jsonb)) > 20 THEN
    PERFORM app.fail('MRS_INVALID', 'attachments');
  END IF;
  v_raw := app.msg_redact(coalesce(p_m -> 'raw', '{}'::jsonb));
  IF octet_length(v_raw::text) > 262144 THEN v_raw := jsonb_build_object('truncated', true); END IF;
  -- the receiving entity: the channel address among to / cc (WhatsApp: the number itself)
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_to || v_cc) x WHERE x ->> 'address' = p_ch.address_norm)
     OR (p_ch.kind = 'whatsapp' AND jsonb_array_length(v_to) = 0) THEN
    v_rcpt := p_ch.address_norm;
  ELSE
    v_flags := v_flags || 'not_addressed_to_channel'::text;
  END IF;
  -- §10 sender check
  SELECT * INTO v_addr FROM public.msg_contact_addresses a
   WHERE a.org_id = p_ch.org_id AND a.kind = p_ch.kind AND a.address_norm = v_from_norm AND a.status = 'active';
  v_status := CASE WHEN v_addr.id IS NULL THEN 'unknown' WHEN v_addr.verified_at IS NULL THEN 'known' ELSE 'verified' END;
  IF v_auth IS NOT NULL AND (v_auth ->> 'spf' = 'fail' OR v_auth ->> 'dkim' = 'fail' OR v_auth ->> 'dmarc' = 'fail') THEN
    v_signals := v_signals || jsonb_build_object('auth_fail', true);
    IF v_status = 'verified' THEN v_status := 'mismatch'; END IF;
  END IF;
  IF v_from_name IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.msg_contacts c
        WHERE c.org_id = p_ch.org_id AND c.is_active AND lower(btrim(c.display_name)) = lower(v_from_name)
          AND c.id IS DISTINCT FROM v_addr.contact_id
          AND NOT EXISTS (SELECT 1 FROM public.msg_contact_addresses a WHERE a.contact_id = c.id AND a.address_norm = v_from_norm AND a.status = 'active')) THEN
    v_signals := v_signals || jsonb_build_object('display_name_match_other_contact', true);
    v_status := 'mismatch';
  END IF;
  IF p_ch.kind = 'email' THEN
    v_dom := split_part(v_from_norm, '@', 2);
    IF EXISTS (SELECT 1 FROM public.msg_contact_addresses a
                WHERE a.org_id = p_ch.org_id AND a.kind = 'email' AND a.status = 'active' AND a.verified_at IS NOT NULL
                  AND split_part(a.address_norm, '@', 2) <> v_dom
                  AND app.msg_levenshtein(split_part(a.address_norm, '@', 2), v_dom) <= 2) THEN
      v_signals := v_signals || jsonb_build_object('lookalike_domain', true);
      v_status := 'spoof_suspected';
    END IF;
  END IF;
  IF v_status IN ('unknown','known') THEN v_flags := v_flags || 'sender_unverified'::text; END IF;
  -- G6b-6 thread resolution
  IF p_ch.kind = 'email' THEN
    v_ids := ARRAY(SELECT x FROM (SELECT v_headers ->> 'in_reply_to' AS x
                                  UNION SELECT jsonb_array_elements_text(coalesce(v_headers -> 'references', '[]'::jsonb))) y WHERE x IS NOT NULL);
    IF cardinality(v_ids) > 0 THEN
      SELECT t.* INTO v_thread FROM public.msg_messages m JOIN public.msg_threads t ON t.id = m.thread_id
       WHERE m.channel_id = p_ch.id AND ((m.headers ->> 'message_id') = ANY (v_ids) OR m.provider_message_id = ANY (v_ids))
       ORDER BY m.received_at DESC, m.id DESC LIMIT 1;
    END IF;
    IF v_thread.id IS NULL AND v_ptid IS NOT NULL THEN
      SELECT t.* INTO v_thread FROM public.msg_threads t WHERE t.channel_id = p_ch.id AND t.provider_thread_id = v_ptid
       ORDER BY t.created_at DESC, t.id DESC LIMIT 1;
    END IF;
  ELSE
    SELECT t.* INTO v_thread FROM public.msg_threads t
     WHERE t.channel_id = p_ch.id AND t.kind = 'whatsapp' AND t.counterpart_address_norm = v_from_norm AND t.status NOT IN ('resolved','spam');
    IF v_thread.id IS NOT NULL AND v_at - coalesce(v_thread.last_message_at, v_thread.created_at) > interval '7 days' THEN
      -- a stale open conversation is closed (audited); the new message opens a new thread
      UPDATE public.msg_threads t SET status = 'resolved' WHERE t.id = v_thread.id;
      v_thread := NULL;
    END IF;
  END IF;
  IF v_thread.id IS NULL THEN
    INSERT INTO public.msg_threads (org_id, channel_id, branch_id, kind, subject, provider_thread_id, counterpart_address_norm, contact_id)
    VALUES (p_ch.org_id, p_ch.id, p_ch.default_branch_id, p_ch.kind, v_subject, v_ptid, v_from_norm, v_addr.contact_id)
    RETURNING * INTO v_thread;
    v_new_thread := true;
  ELSE
    SELECT * INTO v_thread FROM public.msg_threads t WHERE t.id = v_thread.id FOR UPDATE;
  END IF;
  INSERT INTO public.msg_messages (org_id, thread_id, channel_id, direction, provider_message_id, provider_thread_id, from_address,
                                   from_address_norm, from_name, to_addresses, cc_addresses, recipient_address_norm, sent_at, subject,
                                   body_text, body_sha256, headers, wa_context, auth_results, raw, sender_status, sender_contact_id,
                                   sender_address_id, sender_signals, risk_flags, ingest_source)
  VALUES (p_ch.org_id, v_thread.id, p_ch.id, 'inbound', v_pmid, v_ptid, left(v_from ->> 'address', 254), v_from_norm, v_from_name, v_to, v_cc,
          v_rcpt, v_sent, v_subject, v_body, app.msg_text_hash(v_body), jsonb_strip_nulls(v_headers), jsonb_strip_nulls(v_wa), v_auth, v_raw,
          v_status, v_addr.contact_id, v_addr.id, v_signals, v_flags, p_source)
  RETURNING * INTO v_msg;
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p_m -> 'attachments', 'null'::jsonb), '[]'::jsonb)) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'attachments'); END IF;
    PERFORM app.only_keys(e, ARRAY['provider_attachment_id','file_name','mime_type','size_bytes','sha256','extracted_text']);
    IF app.msg_rtext(e, 'provider_attachment_id', 200, 'attachments') IS NULL OR app.msg_rtext(e, 'file_name', 255, 'attachments') IS NULL
       OR btrim(e ->> 'file_name') = '' THEN
      PERFORM app.fail('MRS_INVALID', 'attachments');
    END IF;
    IF e ? 'sha256' AND jsonb_typeof(e -> 'sha256') <> 'null' AND coalesce(e ->> 'sha256', '') !~ '^[0-9a-f]{64}$' THEN
      PERFORM app.fail('MRS_INVALID', 'attachments');
    END IF;
    v_txt := app.msg_rtext(e, 'extracted_text', 100000, 'attachments');
    v_att_id := gen_random_uuid();
    INSERT INTO public.msg_attachments (id, org_id, message_id, thread_id, provider_attachment_id, file_name, mime_type, size_bytes, sha256,
                                        storage_path, extracted_text)
    VALUES (v_att_id, p_ch.org_id, v_msg.id, v_thread.id, e ->> 'provider_attachment_id',
            left(regexp_replace(e ->> 'file_name', '[[:cntrl:]]', '', 'g'), 255),
            app.msg_rtext(e, 'mime_type', 120, 'attachments'),
            coalesce(app.msg_rint(e, 'size_bytes', 0, 26214400, 'attachments'), 0), nullif(e ->> 'sha256', ''),
            p_ch.org_id::text || '/' || p_ch.id::text || '/' || v_msg.id::text || '/' || v_att_id::text || '/' || app.msg_safe_name(e ->> 'file_name'),
            v_txt)
    ON CONFLICT (message_id, provider_attachment_id) DO NOTHING;
  END LOOP;
  UPDATE public.msg_threads t
     SET message_count = t.message_count + 1, unread_count = t.unread_count + 1,
         last_message_at = greatest(coalesce(t.last_message_at, v_at), v_at),
         last_inbound_at = greatest(coalesce(t.last_inbound_at, v_at), v_at),
         risk_flags = ARRAY(SELECT DISTINCT x FROM unnest(t.risk_flags || v_flags) x ORDER BY 1),
         contact_id = coalesce(t.contact_id, v_addr.contact_id),
         status = CASE WHEN t.status IN ('resolved','awaiting_external') THEN 'in_progress' ELSE t.status END
   WHERE t.id = v_thread.id;
  PERFORM app.msg_enqueue(p_ch.org_id, 'process', p_ch.id, v_thread.id, v_msg.id, NULL, NULL, '{}'::jsonb, NULL);
  RETURN jsonb_build_object('provider_message_id', v_pmid, 'message_id', v_msg.id, 'thread_id', v_thread.id, 'duplicate', false,
                            'new_thread', v_new_thread);
END $$;

-- ---------------------------------------------------------------------
-- JSON builders
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.msg_channel_json(c public.msg_channels, p_admin boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (to_jsonb(c) - CASE WHEN p_admin THEN ARRAY[]::text[] ELSE ARRAY['capabilities','poll_cursor','status_cursor','last_error_message'] END)
         || jsonb_build_object('branch_name', (SELECT b.name_ar FROM public.branches b WHERE b.id = c.default_branch_id),
                               'secrets_stored', false)
$$;
CREATE OR REPLACE FUNCTION app.msg_thread_json(t public.msg_threads) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (to_jsonb(t) - 'match_candidates') || jsonb_build_object(
    'match_candidates', app.msg_visible_candidates(t.org_id, t.match_candidates),
    'category_source', (SELECT k.source FROM public.msg_classifications k JOIN public.msg_messages m ON m.id = k.message_id
                         WHERE k.thread_id = t.id AND m.direction = 'inbound'
                         ORDER BY m.received_at DESC, m.id DESC, k.created_at DESC, k.id DESC LIMIT 1),
    'channel_name', ch.name, 'channel_address', ch.address_norm, 'channel_mode', ch.mode,
    'branch_name', b.name_ar, 'owner_name', p.full_name, 'contact_name', c.display_name, 'transaction_ref', tx.ref,
    'from', (SELECT jsonb_build_object('address_norm', m.from_address_norm, 'name', m.from_name, 'sender_status', m.sender_status)
               FROM public.msg_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' ORDER BY m.received_at DESC, m.id DESC LIMIT 1),
    'preview', (SELECT left(regexp_replace(m.body_text, '[[:space:]]+', ' ', 'g'), 160) FROM public.msg_messages m
                 WHERE m.thread_id = t.id ORDER BY m.received_at DESC, m.id DESC LIMIT 1),
    'reply_status', (SELECT r.status FROM public.msg_replies r WHERE r.thread_id = t.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1))
    FROM (SELECT 1) one
    LEFT JOIN public.msg_channels ch ON ch.id = t.channel_id
    LEFT JOIN public.branches b ON b.id = t.branch_id
    LEFT JOIN public.profiles p ON p.id = t.owner_id
    LEFT JOIN public.msg_contacts c ON c.id = t.contact_id
    LEFT JOIN public.transactions tx ON tx.id = t.transaction_id
$$;
CREATE OR REPLACE FUNCTION app.msg_message_json(m public.msg_messages) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (to_jsonb(m) - 'raw') || jsonb_build_object(
    'attachments', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at, a.id) FROM public.msg_attachments a WHERE a.message_id = m.id), '[]'::jsonb),
    'extractions', coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.source, e.span_start, e.id) FROM public.msg_extractions e WHERE e.message_id = m.id), '[]'::jsonb),
    'classification', (SELECT to_jsonb(c) FROM public.msg_classifications c WHERE c.message_id = m.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1),
    'classifications', coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at, c.id) FROM public.msg_classifications c WHERE c.message_id = m.id), '[]'::jsonb),
    'summary', (SELECT to_jsonb(s) FROM public.msg_summaries s WHERE s.message_id = m.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1),
    'events', coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.created_at, v.id) FROM public.msg_message_events v WHERE v.message_id = m.id), '[]'::jsonb),
    'flags', to_jsonb(ARRAY(SELECT DISTINCT f FROM (
               SELECT unnest(m.risk_flags) f
               UNION ALL SELECT unnest(r.injection_flags) FROM public.msg_ai_runs r WHERE r.message_id = m.id
               UNION ALL SELECT unnest(s.risks) FROM public.msg_summaries s WHERE s.message_id = m.id) z
             WHERE f IS NOT NULL ORDER BY 1)))
$$;
-- review fix (review screen): recipients shown with their directory / verification / authorization status (output only; the
-- stored arrays and the content hash are unchanged)
CREATE OR REPLACE FUNCTION app.msg_rcpt_view(p_org uuid, p_kind text, p_tx uuid, p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.e || (app.msg_recipient_info(p_org, p_kind, x.e ->> 'address_norm', p_tx, NULL)
                                    - ARRAY['address_norm','contact_id']) ORDER BY x.n), '[]'::jsonb)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p) = 'array' THEN p ELSE '[]'::jsonb END) WITH ORDINALITY x(e, n)
$$;
CREATE OR REPLACE FUNCTION app.msg_version_view(p_org uuid, p_kind text, p_tx uuid, v public.msg_reply_versions) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN v.id IS NULL THEN NULL ELSE
    to_jsonb(v) || jsonb_build_object('to_addresses', app.msg_rcpt_view(p_org, p_kind, p_tx, v.to_addresses),
                                      'cc_addresses', app.msg_rcpt_view(p_org, p_kind, p_tx, v.cc_addresses)) END
$$;
CREATE OR REPLACE FUNCTION app.msg_reply_json(r public.msg_replies) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(r) || jsonb_build_object(
    'current_version', (SELECT app.msg_version_view(r.org_id, t.kind, t.transaction_id, v) FROM public.msg_reply_versions v WHERE v.id = r.current_version_id),
    'versions', coalesce((SELECT jsonb_agg(app.msg_version_view(r.org_id, t.kind, t.transaction_id, v) ORDER BY v.version_no)
                            FROM public.msg_reply_versions v WHERE v.reply_id = r.id), '[]'::jsonb),
    'approvals', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at, a.id) FROM public.msg_reply_approvals a WHERE a.reply_id = r.id), '[]'::jsonb),
    'outbound', coalesce((SELECT jsonb_agg(to_jsonb(o) || jsonb_build_object(
                    'delivery_events', coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at, d.id) FROM public.msg_delivery_events d
                                                  WHERE d.outbound_id = o.id), '[]'::jsonb),
                    'job', (SELECT app.msg_job_json(j) FROM public.msg_jobs j WHERE j.outbound_id = o.id ORDER BY j.created_at DESC, j.id DESC LIMIT 1))
                  ORDER BY o.created_at, o.id) FROM public.msg_outbound o WHERE o.reply_id = r.id), '[]'::jsonb),
    'approval_level', app.msg_effective_level(r.org_id, r.thread_id, r.category),
    'approval_stale', r.approved_version_id IS NOT NULL AND r.approved_version_id IS DISTINCT FROM r.current_version_id)
  FROM (SELECT 1) one LEFT JOIN public.msg_threads t ON t.id = r.thread_id
$$;

-- ---------------------------------------------------------------------
-- reply helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.msg_version_hash(p_subject text, p_body text, p_to jsonb, p_cc jsonb, p_att jsonb, p_lang text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT app.msg_hash(jsonb_build_object('subject', p_subject, 'body_text', p_body, 'to', coalesce(p_to, '[]'::jsonb),
                                         'cc', coalesce(p_cc, '[]'::jsonb), 'attachments', coalesce(p_att, '[]'::jsonb), 'lang', p_lang))
$$;
-- addresses that took part in the thread (from / to / cc of its messages), the channel address excluded
CREATE OR REPLACE FUNCTION app.msg_participants(p_thread uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(DISTINCT a) FILTER (WHERE a IS NOT NULL AND a <> ch.address_norm), '{}'::text[]) FROM (
    SELECT m.from_address_norm a, m.channel_id FROM public.msg_messages m WHERE m.thread_id = p_thread AND m.direction = 'inbound'
    UNION ALL SELECT x ->> 'address', m.channel_id FROM public.msg_messages m, jsonb_array_elements(m.to_addresses || m.cc_addresses) x
     WHERE m.thread_id = p_thread) z JOIN public.msg_channels ch ON ch.id = z.channel_id
$$;
-- recipients chosen by staff: active directory addresses or thread participants only (never read from a body)
CREATE OR REPLACE FUNCTION app.msg_check_recipients(t public.msg_threads, p jsonb, p_field text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r jsonb := '[]'::jsonb; e jsonb; v text; v_parts text[] := app.msg_participants(t.id); v_contact uuid; v_seen text[] := '{}';
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN r; END IF;
  IF jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) > 20 THEN PERFORM app.fail('MRS_INVALID', 'recipient'); END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p) x LOOP
    IF jsonb_typeof(e) = 'object' THEN e := coalesce(e -> 'address_norm', e -> 'address'); END IF;
    IF e IS NULL OR jsonb_typeof(e) <> 'string' THEN PERFORM app.fail('MRS_INVALID', 'recipient'); END IF;
    v := app.msg_try_norm(t.kind, e #>> '{}');
    IF v IS NULL THEN PERFORM app.fail('MRS_INVALID', 'recipient'); END IF;
    CONTINUE WHEN v = ANY (v_seen);
    SELECT a.contact_id INTO v_contact FROM public.msg_contact_addresses a
     WHERE a.org_id = t.org_id AND a.kind = t.kind AND a.address_norm = v AND a.status = 'active';
    IF v_contact IS NULL AND NOT (v = ANY (v_parts)) THEN PERFORM app.fail('MRS_INVALID', 'recipient'); END IF;
    v_seen := v_seen || v;
    r := r || jsonb_build_array(jsonb_build_object('address_norm', v, 'contact_id', v_contact));
  END LOOP;
  RETURN r;
END $$;
-- default recipient: the sender of the message replied to (WhatsApp: the thread number). Review fix: when that sender is not
-- a verified directory address, the thread contact's verified address that wrote in this thread is preferred (an unknown party
-- that joined a thread by In-Reply-To never becomes the default recipient)
CREATE OR REPLACE FUNCTION app.msg_default_to(t public.msg_threads, p_reply_to uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH ver AS (SELECT a.address_norm, a.contact_id FROM public.msg_contact_addresses a
                WHERE a.org_id = t.org_id AND a.kind = t.kind AND a.status = 'active' AND a.verified_at IS NOT NULL),
  rt AS (SELECT coalesce((SELECT m.from_address_norm FROM public.msg_messages m WHERE m.id = p_reply_to AND m.thread_id = t.id),
                         (SELECT m.from_address_norm FROM public.msg_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound'
                           ORDER BY m.received_at DESC, m.id DESC LIMIT 1)) AS a)
  SELECT CASE WHEN x.a IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('address_norm', x.a,
           'contact_id', (SELECT a.contact_id FROM public.msg_contact_addresses a WHERE a.org_id = t.org_id AND a.kind = t.kind
                                                 AND a.address_norm = x.a AND a.status = 'active'))) END
    FROM (SELECT CASE WHEN t.kind = 'whatsapp' THEN t.counterpart_address_norm
                      ELSE coalesce((SELECT rt.a FROM rt WHERE EXISTS (SELECT 1 FROM ver WHERE ver.address_norm = rt.a)),
                                    (SELECT m.from_address_norm FROM public.msg_messages m JOIN ver ON ver.address_norm = m.from_address_norm
                                      WHERE m.thread_id = t.id AND m.direction = 'inbound' AND t.contact_id IS NOT NULL AND ver.contact_id = t.contact_id
                                      ORDER BY m.received_at DESC, m.id DESC LIMIT 1),
                                    (SELECT rt.a FROM rt)) END AS a) x
$$;
-- append a version and make it current (approval of an older version becomes stale)
CREATE OR REPLACE FUNCTION app.msg_add_version(r public.msg_replies, p_author_kind text, p_author uuid, p_requested_by uuid, p_subject text,
  p_body text, p_to jsonb, p_cc jsonb, p_att jsonb, p_clar boolean, p_missing text[], p_used text[], p_tpl_key text, p_tpl_ver int, p_run uuid)
RETURNS public.msg_reply_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.msg_reply_versions; v_no int;
BEGIN
  SELECT coalesce(max(x.version_no), 0) + 1 INTO v_no FROM public.msg_reply_versions x WHERE x.reply_id = r.id;
  INSERT INTO public.msg_reply_versions (org_id, reply_id, version_no, author_kind, author_id, requested_by, subject, body_text, to_addresses,
                                         cc_addresses, attachments, clarification, missing, used_facts, template_key, template_version, ai_run_id,
                                         content_sha256)
  VALUES (r.org_id, r.id, v_no, p_author_kind, p_author, p_requested_by, p_subject, coalesce(p_body, ''), coalesce(p_to, '[]'::jsonb),
          coalesce(p_cc, '[]'::jsonb), coalesce(p_att, '[]'::jsonb), coalesce(p_clar, false), coalesce(p_missing, '{}'), coalesce(p_used, '{}'),
          p_tpl_key, p_tpl_ver, p_run, app.msg_version_hash(p_subject, coalesce(p_body, ''), p_to, p_cc, p_att, r.lang))
  RETURNING * INTO v;
  UPDATE public.msg_replies x SET current_version_id = v.id,
         status = CASE WHEN x.status IN ('approved','rejected','pending_approval') THEN 'draft' ELSE x.status END,
         approved_version_id = CASE WHEN x.status = 'approved' THEN NULL ELSE x.approved_version_id END
   WHERE x.id = r.id;
  RETURN v;
END $$;

-- built-in default templates (data; mirrored by ai-mock.js DEFAULT_TEMPLATES; seeded as drafts by seed_msg_templates)
CREATE OR REPLACE FUNCTION app.msg_default_templates()
RETURNS TABLE (template_key text, lang text, category text, party_kinds text[], subject_tpl text, body_tpl text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT * FROM (VALUES
    ('telex_release','ar','telex_release',ARRAY['shipping_agent'],'طلب تأكيد إفراج التلكس — بوليصة {{bl_number}}',
     E'السادة {{counterpart_name}}،\nنرجو تأكيد إفراج التلكس للبوليصة رقم {{bl_number}} الخاصة بالمعاملة {{tx_ref}}.\n{{signature}}'),
    ('telex_release','en','telex_release',ARRAY['shipping_agent'],'Telex release confirmation — B/L {{bl_number}}',
     E'Dear {{counterpart_name}},\nPlease confirm the telex release for B/L {{bl_number}} (our reference {{tx_ref}}).\n{{signature}}'),
    ('delivery_order','ar','delivery_order',ARRAY['shipping_agent'],'طلب إذن التسليم — بوليصة {{bl_number}}',
     E'السادة {{counterpart_name}}،\nنرجو إصدار إذن التسليم للبوليصة رقم {{bl_number}} والحاويات: {{container_list}} (مرجعنا {{tx_ref}}).\n{{signature}}'),
    ('delivery_order','en','delivery_order',ARRAY['shipping_agent'],'Delivery order request — B/L {{bl_number}}',
     E'Dear {{counterpart_name}},\nPlease issue the delivery order for B/L {{bl_number}}, containers: {{container_list}} (our reference {{tx_ref}}).\n{{signature}}'),
    ('freight_charges','ar','freight_charges',ARRAY['shipping_agent'],'طلب فاتورة رسوم الشحن — بوليصة {{bl_number}}',
     E'السادة {{counterpart_name}}،\nنرجو تزويدنا بفاتورة رسوم الشحن والرسوم المحلية للبوليصة رقم {{bl_number}} (مرجعنا {{tx_ref}}).\n{{signature}}'),
    ('freight_charges','en','freight_charges',ARRAY['shipping_agent'],'Freight / local charges invoice — B/L {{bl_number}}',
     E'Dear {{counterpart_name}},\nPlease send us the freight and local charges invoice for B/L {{bl_number}} (our reference {{tx_ref}}).\n{{signature}}'),
    ('empty_return_instructions','ar','empty_return',ARRAY['shipping_agent','yard'],'تعليمات إرجاع الحاويات الفارغة — {{tx_ref}}',
     E'السادة {{counterpart_name}}،\nنرجو تزويدنا بموقع وموعد إرجاع الحاويات الفارغة: {{container_list}}.\n{{signature}}'),
    ('empty_return_instructions','en','empty_return',ARRAY['shipping_agent','yard'],'Empty container return instructions — {{tx_ref}}',
     E'Dear {{counterpart_name}},\nPlease advise the return location and deadline for the empty containers: {{container_list}}.\n{{signature}}'),
    ('missing_documents','ar','missing_documents',ARRAY['client'],'مستندات مطلوبة — المعاملة {{tx_ref}}',
     E'السادة {{client_name}}،\nلاستكمال المعاملة {{tx_ref}} نرجو تزويدنا بالمستندات التالية: {{missing_documents_list}}.\n{{signature}}'),
    ('missing_documents','en','missing_documents',ARRAY['client'],'Documents required — transaction {{tx_ref}}',
     E'Dear {{client_name}},\nTo complete transaction {{tx_ref}} please provide: {{missing_documents_list}}.\n{{signature}}'),
    ('violation_response','ar','violation',ARRAY[]::text[],'بخصوص إشعار المخالفة — {{tx_ref}}',
     E'السادة {{counterpart_name}}،\nاستلمنا إشعاركم، ونرجو تزويدنا بتفاصيل المخالفة ورقمها المرجعي لدراستها.\n{{signature}}'),
    ('violation_response','en','violation',ARRAY[]::text[],'Regarding the violation notice — {{tx_ref}}',
     E'Dear {{counterpart_name}},\nWe received your notice. Please send the violation details and its reference number for our review.\n{{signature}}'),
    ('clarification','ar',NULL,ARRAY[]::text[],'طلب إيضاح',
     E'السادة {{counterpart_name}}،\nشكرًا لرسالتكم. نرجو تزويدنا بالمراجع اللازمة (رقم البوليصة أو الحاوية أو مرجع المعاملة) للتحقق ومتابعة طلبكم.\n{{signature}}'),
    ('clarification','en',NULL,ARRAY[]::text[],'Clarification request',
     E'Dear {{counterpart_name}},\nThank you for your message. Please provide the references needed (B/L, container or transaction reference) so we can verify and follow up.\n{{signature}}'),
    ('ack_receipt','ar',NULL,ARRAY[]::text[],'تأكيد استلام',E'استلمنا رسالتكم وسيتم الرد عليها.\n{{signature}}'),
    ('ack_receipt','en',NULL,ARRAY[]::text[],'Acknowledgement',E'We received your message and will reply.\n{{signature}}')
  ) AS x(template_key, lang, category, party_kinds, subject_tpl, body_tpl)
$$;
-- placeholders of a template text; unknown name → MRS_INVALID 'placeholder'
CREATE OR REPLACE FUNCTION app.msg_tpl_placeholders(p_subject text, p_body text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE r text[];
BEGIN
  SELECT coalesce(array_agg(DISTINCT m[1] ORDER BY m[1]), '{}') INTO r
    FROM regexp_matches(coalesce(p_subject, '') || ' ' || coalesce(p_body, ''), '\{\{[[:space:]]*([^{}]*?)[[:space:]]*\}\}', 'g') m;
  IF EXISTS (SELECT 1 FROM unnest(r) x WHERE NOT (x = ANY (app.msg_placeholders()))) THEN PERFORM app.fail('MRS_INVALID', 'placeholder'); END IF;
  RETURN r;
END $$;

-- outbound accepted by the provider: reply sent, outbound copy in the thread, thread awaiting the counterpart
CREATE OR REPLACE FUNCTION app.msg_outbound_accepted(p_o public.msg_outbound, p_provider_id text, p_state text, p_at timestamptz) RETURNS public.msg_outbound
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.msg_outbound; t public.msg_threads; r public.msg_replies; v_reply_to public.msg_messages; v_pid text;
BEGIN
  v_pid := coalesce(p_provider_id, p_o.provider_message_id, p_o.provider_request_id);
  UPDATE public.msg_outbound x SET state = p_state, provider_message_id = coalesce(x.provider_message_id, v_pid),
         accepted_at = coalesce(x.accepted_at, p_at), delivered_at = CASE WHEN p_state IN ('delivered','read') THEN coalesce(x.delivered_at, p_at) ELSE x.delivered_at END,
         read_at = CASE WHEN p_state = 'read' THEN coalesce(x.read_at, p_at) ELSE x.read_at END, last_error_code = NULL, last_error_message = NULL
   WHERE x.id = p_o.id RETURNING * INTO o;
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = o.reply_id;
  UPDATE public.msg_replies x SET status = 'sent' WHERE x.id = o.reply_id AND x.status <> 'sent';
  IF NOT EXISTS (SELECT 1 FROM public.msg_messages m WHERE m.outbound_id = o.id) THEN
    SELECT * INTO v_reply_to FROM public.msg_messages m WHERE m.id = r.reply_to_message_id;
    INSERT INTO public.msg_messages (org_id, thread_id, channel_id, direction, provider_message_id, from_address, from_address_norm, to_addresses,
                                     cc_addresses, recipient_address_norm, sent_at, subject, body_text, body_sha256, headers, sender_status,
                                     outbound_id, ingest_source)
    VALUES (o.org_id, o.thread_id, o.channel_id, 'outbound', o.provider_message_id, o.from_address_norm, o.from_address_norm,
            (SELECT coalesce(jsonb_agg(jsonb_build_object('address', x ->> 'address_norm', 'name', NULL)), '[]'::jsonb) FROM jsonb_array_elements(o.to_addresses) x),
            (SELECT coalesce(jsonb_agg(jsonb_build_object('address', x ->> 'address_norm', 'name', NULL)), '[]'::jsonb) FROM jsonb_array_elements(o.cc_addresses) x),
            NULL, p_at, o.subject, o.body_text, app.msg_text_hash(o.body_text),
            CASE WHEN EXISTS (SELECT 1 FROM public.msg_channels c WHERE c.id = o.channel_id AND c.kind = 'email')
                 THEN jsonb_strip_nulls(jsonb_build_object('message_id', '<' || o.provider_request_id || '@marsa.invalid>',
                                                           'in_reply_to', v_reply_to.headers ->> 'message_id')) END,
            'verified', o.id, 'send')
    ON CONFLICT (org_id, channel_id, provider_message_id) DO NOTHING;
    UPDATE public.msg_threads x SET message_count = x.message_count + 1, last_outbound_at = p_at,
           last_message_at = greatest(coalesce(x.last_message_at, p_at), p_at),
           status = CASE WHEN x.status = 'spam' THEN x.status ELSE 'awaiting_external' END
     WHERE x.id = o.thread_id RETURNING * INTO t;
    SELECT * INTO t FROM public.msg_threads x WHERE x.id = o.thread_id;
    PERFORM app.msg_event(o.org_id, t.transaction_id, 'reply_sent', 'outbound', o.id, jsonb_build_object('thread_id', o.thread_id, 'reply_id', o.reply_id));
  END IF;
  RETURN o;
END $$;
-- a send that failed (provider said not applied, or a bounce / failure event): never re-sent automatically
CREATE OR REPLACE FUNCTION app.msg_outbound_failed(p_o public.msg_outbound, p_code text, p_message text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tx uuid;
BEGIN
  UPDATE public.msg_outbound x SET state = 'failed', failed_at = now(), last_error_code = left(p_code, 60), last_error_message = left(p_message, 500)
   WHERE x.id = p_o.id AND x.state <> 'failed';
  UPDATE public.msg_replies x SET status = 'send_failed' WHERE x.id = p_o.reply_id AND x.status IN ('sending','sent','send_unknown');
  -- review fix: a failed outbound has no pending send any more (a queued retry or an unknown reconcile never goes out after it)
  UPDATE public.msg_jobs j SET status = 'cancelled', finished_at = now(), locked_by = NULL, locked_until = NULL,
         last_error_code = 'outbound_failed', last_error_message = 'the outbound failed: no send after it'
   WHERE j.outbound_id = p_o.id AND j.kind = 'send' AND j.status IN ('queued','unknown');
  SELECT t.transaction_id INTO v_tx FROM public.msg_threads t WHERE t.id = p_o.thread_id;
  PERFORM app.msg_event(p_o.org_id, v_tx, 'reply_failed', 'outbound', p_o.id, jsonb_build_object('thread_id', p_o.thread_id, 'reply_id', p_o.reply_id));
END $$;

-- delivery events (provider status / webhook / send result) → {applied, duplicates, unknown_refs}; state forward only
CREATE OR REPLACE FUNCTION app.msg_apply_delivery(p_ch public.msg_channels, p_events jsonb, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e jsonb; o public.msg_outbound; v_applied int := 0; v_dup int := 0; v_unknown int := 0; v_status text; v_at timestamptz;
        v_id uuid; v_rank int; v_tx uuid;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 200 THEN PERFORM app.fail('MRS_INVALID', 'events'); END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_events) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'events'); END IF;
    PERFORM app.only_keys(e, ARRAY['provider_event_id','provider_message_id','provider_request_id','status','at','error_code']);
    v_status := app.msg_rtext(e, 'status', 20, 'events');
    IF v_status IS NULL OR v_status NOT IN ('accepted','sent','delivered','read','failed','bounced') THEN PERFORM app.fail('MRS_INVALID', 'events'); END IF;
    IF app.msg_rtext(e, 'provider_event_id', 200, 'events') IS NULL THEN PERFORM app.fail('MRS_INVALID', 'events'); END IF;
    v_at := coalesce(app.msg_rts(e, 'at', 'events'), now());
    SELECT * INTO o FROM public.msg_outbound x
     WHERE x.channel_id = p_ch.id
       AND ((e ? 'provider_request_id' AND x.provider_request_id = e ->> 'provider_request_id')
            OR (e ? 'provider_message_id' AND x.provider_message_id = e ->> 'provider_message_id'))
     ORDER BY x.created_at DESC LIMIT 1 FOR UPDATE;
    IF o.id IS NULL THEN v_unknown := v_unknown + 1; CONTINUE; END IF;
    INSERT INTO public.msg_delivery_events (org_id, outbound_id, provider_event_id, status, error_code, at, source)
    VALUES (o.org_id, o.id, e ->> 'provider_event_id', v_status, app.msg_rtext(e, 'error_code', 60, 'events'), v_at, p_source)
    ON CONFLICT (outbound_id, provider_event_id) DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NULL THEN v_dup := v_dup + 1; CONTINUE; END IF;
    v_applied := v_applied + 1;
    SELECT t.transaction_id INTO v_tx FROM public.msg_threads t WHERE t.id = o.thread_id;
    v_rank := CASE o.state WHEN 'queued' THEN 0 WHEN 'sending' THEN 1 WHEN 'unknown' THEN 1 WHEN 'accepted' THEN 2 WHEN 'delivered' THEN 3
                           WHEN 'read' THEN 4 ELSE 9 END;
    IF v_status IN ('accepted','sent') AND o.state IN ('sending','unknown') THEN
      PERFORM app.msg_outbound_accepted(o, e ->> 'provider_message_id', 'accepted', v_at);
    ELSIF v_status = 'delivered' AND v_rank < 3 AND o.state IN ('sending','unknown','accepted') THEN
      IF o.state IN ('sending','unknown') THEN
        PERFORM app.msg_outbound_accepted(o, e ->> 'provider_message_id', 'delivered', v_at);
      ELSE
        UPDATE public.msg_outbound x SET state = 'delivered', delivered_at = v_at WHERE x.id = o.id;
      END IF;
      PERFORM app.msg_event(o.org_id, v_tx, 'reply_delivered', 'outbound', o.id, jsonb_build_object('thread_id', o.thread_id, 'reply_id', o.reply_id));
    ELSIF v_status = 'read' AND v_rank < 4 AND o.state IN ('accepted','delivered') THEN
      UPDATE public.msg_outbound x SET state = 'read', read_at = v_at, delivered_at = coalesce(x.delivered_at, v_at) WHERE x.id = o.id;
    ELSIF v_status IN ('failed','bounced') AND o.state IN ('sending','accepted','unknown') THEN
      PERFORM app.msg_outbound_failed(o, coalesce(app.msg_rtext(e, 'error_code', 60, 'events'), v_status), 'provider reported ' || v_status);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('applied', v_applied, 'duplicates', v_dup, 'unknown_refs', v_unknown);
END $$;

-- ---------------------------------------------------------------------
-- 4. staff RPCs (SECURITY DEFINER, search_path '', authenticated only)
-- ---------------------------------------------------------------------
-- note / reason text: trimmed, ≤ 2000; required → MRS_NOTE_REQUIRED
CREATE OR REPLACE FUNCTION app.msg_note(p text, p_required boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := nullif(btrim(regexp_replace(coalesce(p, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), '');
BEGIN
  IF v IS NULL AND p_required THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
  IF char_length(v) > 2000 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  RETURN v;
END $$;

-- ---------------- settings & channels ----------------
CREATE OR REPLACE FUNCTION public.get_msg_settings(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_read_roles());
  RETURN app.msg_settings_json(p_org) || jsonb_build_object('month_to_date_usd', app.msg_month_cost(p_org),
    'can', jsonb_build_object('admin', app.has_role(p_org, app.msg_admin_roles())),
    'limits', jsonb_build_object('auto_replies_enabled', false, 'purge_available', false, 'external_ai', false));
END $$;

CREATE OR REPLACE FUNCTION public.save_msg_settings(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.msg_settings; v_s text; v_n numeric;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_admin_roles());
  PERFORM app.only_keys(p_payload, ARRAY['ai_provider','ai_monthly_budget_usd','auto_link_enabled','require_four_eyes','retention_days',
                                         'purge_enabled','violation_repeat_days','default_lang','signature_ar','signature_en']);
  INSERT INTO public.msg_settings (org_id, updated_by) VALUES (p_org, auth.uid()) ON CONFLICT (org_id) DO NOTHING;
  SELECT * INTO v FROM public.msg_settings s WHERE s.org_id = p_org FOR UPDATE;
  IF p_payload ? 'ai_provider' THEN
    v_s := app.ptext(p_payload, 'ai_provider', 20, true);
    IF v_s NOT IN ('rule_mock','llm_pending') THEN PERFORM app.fail('MRS_INVALID', 'ai_provider'); END IF;
    v.ai_provider := v_s;
  END IF;
  IF p_payload ? 'ai_monthly_budget_usd' THEN
    v_n := app.msg_rnum(p_payload, 'ai_monthly_budget_usd', 0, 99999999);
    IF v_n IS NULL OR v_n <> round(v_n, 2) THEN PERFORM app.fail('MRS_INVALID', 'ai_monthly_budget_usd'); END IF;
    v.ai_monthly_budget_usd := v_n;
  END IF;
  IF p_payload ? 'auto_link_enabled' THEN
    v.auto_link_enabled := coalesce(app.msg_rbool(p_payload, 'auto_link_enabled'), v.auto_link_enabled);
  END IF;
  IF p_payload ? 'require_four_eyes' AND app.msg_rbool(p_payload, 'require_four_eyes') IS DISTINCT FROM true THEN
    PERFORM app.fail('MRS_INVALID', 'require_four_eyes');            -- G6b-4: fixed in v1
  END IF;
  IF p_payload ? 'purge_enabled' AND app.msg_rbool(p_payload, 'purge_enabled') IS DISTINCT FROM false THEN
    PERFORM app.fail('MRS_INVALID', 'purge_enabled');                -- G6b-12: no purge in v1
  END IF;
  IF p_payload ? 'retention_days' THEN v.retention_days := app.msg_rint(p_payload, 'retention_days', 90, 3650); END IF;
  IF p_payload ? 'violation_repeat_days' THEN v.violation_repeat_days := app.msg_rint(p_payload, 'violation_repeat_days', 1, 365); END IF;
  IF p_payload ? 'default_lang' THEN
    v_s := app.ptext(p_payload, 'default_lang', 2, true);
    IF v_s NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'default_lang'); END IF;
    v.default_lang := v_s;
  END IF;
  IF p_payload ? 'signature_ar' THEN v.signature_ar := app.ptext(p_payload, 'signature_ar', 500); END IF;
  IF p_payload ? 'signature_en' THEN v.signature_en := app.ptext(p_payload, 'signature_en', 500); END IF;
  UPDATE public.msg_settings s SET ai_provider = v.ai_provider, ai_monthly_budget_usd = v.ai_monthly_budget_usd,
         auto_link_enabled = v.auto_link_enabled, retention_days = coalesce(v.retention_days, s.retention_days),
         violation_repeat_days = coalesce(v.violation_repeat_days, s.violation_repeat_days), default_lang = v.default_lang,
         signature_ar = v.signature_ar, signature_en = v.signature_en, updated_by = auth.uid()
   WHERE s.org_id = p_org;
  RETURN app.msg_settings_json(p_org);
END $$;

CREATE OR REPLACE FUNCTION public.list_msg_channels(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_admin boolean;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_read_roles());
  v_admin := app.has_role(p_org, app.msg_admin_roles());
  RETURN jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(app.msg_channel_json(c, v_admin) || jsonb_build_object('counts', jsonb_build_object(
                'threads_open', (SELECT count(*)::int FROM public.msg_threads t WHERE t.channel_id = c.id AND t.status NOT IN ('resolved','spam')
                                    AND app.has_branch_role(t.org_id, t.branch_id, app.msg_read_roles())),
                'jobs_by_status', CASE WHEN v_admin THEN coalesce((SELECT jsonb_object_agg(x.status, x.n) FROM (
                                    SELECT j.status, count(*)::int n FROM public.msg_jobs j WHERE j.channel_id = c.id GROUP BY j.status) x), '{}'::jsonb) END))
              ORDER BY c.kind, c.name, c.id) FROM public.msg_channels c WHERE c.org_id = p_org), '[]'::jsonb),
    'mock', NOT EXISTS (SELECT 1 FROM public.msg_channels c WHERE c.org_id = p_org AND c.mode <> 'mock'),
    'can', jsonb_build_object('admin', v_admin),
    'secrets_stored', false);
END $$;

-- save_msg_channel(p_org, {id?, kind, name, address, default_branch_id, mode, ingest_enabled, send_enabled, provider_terms_ack}, p_idem_key)
CREATE OR REPLACE FUNCTION public.save_msg_channel(p_org uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_replay jsonb; v_id uuid; v_old public.msg_channels; v public.msg_channels; v_kind text; v_addr text; v_norm text; v_br uuid;
        v_mode text; v_ing boolean; v_snd boolean; v_ack boolean; v_flags_changed boolean;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_admin_roles());
  PERFORM app.only_keys(p_payload, ARRAY['id','kind','name','address','default_branch_id','mode','ingest_enabled','send_enabled','provider_terms_ack']);
  v_replay := app.idem_begin('save_msg_channel', p_idem_key, jsonb_build_object('org', p_org, 'p', p_payload), p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_id := app.puuid(p_payload, 'id');
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.msg_channels c WHERE c.id = v_id AND c.org_id = p_org FOR UPDATE;
    IF v_old.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'channel'); END IF;
    v := v_old;
  END IF;
  v_kind := coalesce(app.ptext(p_payload, 'kind', 20), v_old.kind);
  IF v_kind IS NULL OR v_kind NOT IN ('email','whatsapp') OR (v_old.id IS NOT NULL AND v_kind <> v_old.kind) THEN
    PERFORM app.fail('MRS_INVALID', 'channel_kind');
  END IF;
  v.kind := v_kind;
  IF p_payload ? 'name' OR v_old.id IS NULL THEN
    v.name := app.ptext(p_payload, 'name', 120, true);
    IF char_length(v.name) < 2 THEN PERFORM app.fail('MRS_INVALID', 'name'); END IF;
  END IF;
  IF p_payload ? 'address' OR v_old.id IS NULL THEN
    v_addr := app.ptext(p_payload, 'address', 254, true);
    v_norm := app.msg_norm_address(v_kind, v_addr);
    -- G6b-2: one provider account = one org (the other org is never named)
    IF EXISTS (SELECT 1 FROM public.msg_channels c WHERE c.kind = v_kind AND c.address_norm = v_norm AND c.id IS DISTINCT FROM v_old.id) THEN
      PERFORM app.fail('MRS_INVALID', 'address_taken');
    END IF;
    v.address := v_addr; v.address_norm := v_norm;
  END IF;
  IF p_payload ? 'default_branch_id' THEN
    v_br := app.puuid(p_payload, 'default_branch_id');
    IF v_br IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v_br AND b.org_id = p_org) THEN
      PERFORM app.fail('MRS_INVALID', 'branch_id');
    END IF;
    v.default_branch_id := v_br;
  END IF;
  IF p_payload ? 'mode' THEN
    v_mode := app.ptext(p_payload, 'mode', 20, true);
    IF v_mode NOT IN ('mock','live_pending') THEN PERFORM app.fail('MRS_INVALID', 'mode'); END IF;
    v.mode := v_mode;
  END IF;
  v.mode := coalesce(v.mode, 'mock');
  v_ing := coalesce(app.msg_rbool(p_payload, 'ingest_enabled'), v_old.ingest_enabled, false);
  v_snd := coalesce(app.msg_rbool(p_payload, 'send_enabled'), v_old.send_enabled, false);
  v_ack := coalesce(app.msg_rbool(p_payload, 'provider_terms_ack'), false);
  IF v_ack AND v.provider_terms_ack_at IS NULL THEN v.provider_terms_ack_at := now(); v.provider_terms_ack_by := auth.uid(); END IF;
  IF (v_ing OR v_snd) AND v.provider_terms_ack_at IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'provider_terms'); END IF;
  v_flags_changed := v_ing IS DISTINCT FROM coalesce(v_old.ingest_enabled, false) OR v_snd IS DISTINCT FROM coalesce(v_old.send_enabled, false);
  v.ingest_enabled := v_ing; v.send_enabled := v_snd;
  IF v_old.id IS NULL THEN
    v.status := 'not_connected';
    INSERT INTO public.msg_channels (org_id, kind, name, address, address_norm, default_branch_id, mode, status, ingest_enabled, send_enabled,
                                     provider_terms_ack_by, provider_terms_ack_at, created_by, updated_by)
    VALUES (p_org, v.kind, v.name, v.address, v.address_norm, v.default_branch_id, v.mode, v.status, v.ingest_enabled, v.send_enabled,
            v.provider_terms_ack_by, v.provider_terms_ack_at, auth.uid(), auth.uid())
    RETURNING * INTO v;
  ELSE
    IF v.mode IS DISTINCT FROM v_old.mode OR v.address_norm IS DISTINCT FROM v_old.address_norm THEN
      v.status := 'not_connected'; v.capabilities := '{}'::jsonb; v.capabilities_checked_at := NULL; v.capabilities_source := NULL;
    ELSIF v_flags_changed THEN
      IF NOT v_ing AND NOT v_snd THEN v.status := 'disabled';
      ELSIF v_old.status = 'disabled' THEN
        v.status := CASE WHEN v_old.capabilities_checked_at IS NOT NULL AND v_old.last_error_code IS NULL THEN 'connected' ELSE 'not_connected' END;
      END IF;
    END IF;
    UPDATE public.msg_channels c SET name = v.name, address = v.address, address_norm = v.address_norm, default_branch_id = v.default_branch_id,
           mode = v.mode, status = v.status, ingest_enabled = v.ingest_enabled, send_enabled = v.send_enabled, capabilities = v.capabilities,
           capabilities_checked_at = v.capabilities_checked_at, capabilities_source = v.capabilities_source,
           provider_terms_ack_by = v.provider_terms_ack_by, provider_terms_ack_at = v.provider_terms_ack_at, updated_by = auth.uid()
     WHERE c.id = v_old.id RETURNING * INTO v;
  END IF;
  RETURN app.idem_finish('save_msg_channel', p_idem_key, app.msg_channel_json(v, true) || jsonb_build_object('from', v_old.status));
END $$;

CREATE OR REPLACE FUNCTION public.request_msg_channel_probe(p_channel uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_c public.msg_channels; v_replay jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_c FROM public.msg_channels c WHERE c.id = p_channel;
  IF v_c.id IS NULL OR NOT app.is_staff(v_c.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'channel'); END IF;
  PERFORM app.msg_gate(v_c.org_id, app.msg_admin_roles());
  v_replay := app.idem_begin('request_msg_channel_probe', p_idem_key, jsonb_build_object('channel', p_channel), v_c.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  RETURN app.idem_finish('request_msg_channel_probe', p_idem_key,
                         app.msg_enqueue(v_c.org_id, 'probe', v_c.id, NULL, NULL, NULL, NULL, '{}'::jsonb, auth.uid()));
END $$;

-- ---------------- contacts ----------------
CREATE OR REPLACE FUNCTION app.msg_contact_json(c public.msg_contacts) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(c) || jsonb_build_object(
    'client_name', (SELECT x.name_ar FROM public.clients x WHERE x.id = c.client_id),
    'party_name', (SELECT x.name_ar FROM public.parties x WHERE x.id = c.party_id),
    'party_kinds', (SELECT to_jsonb(x.kinds) FROM public.parties x WHERE x.id = c.party_id),
    'addresses', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.status, a.kind, a.address_norm) FROM public.msg_contact_addresses a WHERE a.contact_id = c.id), '[]'::jsonb),
    'authorizations_active', (SELECT count(*)::int FROM public.msg_contact_authorizations a WHERE a.contact_id = c.id AND a.status = 'active'
                                AND (a.valid_until IS NULL OR a.valid_until >= app.msg_today())))
$$;

CREATE OR REPLACE FUNCTION public.list_msg_contacts(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_q text; v_et text; v_cl uuid; v_pa uuid; v_ver boolean; v_limit int; v_offset int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_read_roles());
  PERFORM app.only_keys(f, ARRAY['q','entity_type','client_id','party_id','verified','limit','offset']);
  v_q := app.rpt_like(app.ptext(f, 'q', 100));
  v_et := app.ptext(f, 'entity_type', 20);
  IF v_et IS NOT NULL AND v_et NOT IN ('client','party','internal','other') THEN PERFORM app.fail('MRS_INVALID', 'entity_type'); END IF;
  v_cl := app.puuid(f, 'client_id'); v_pa := app.puuid(f, 'party_id'); v_ver := app.msg_rbool(f, 'verified');
  v_limit := app.rpt_limit(f, 200, 50); v_offset := app.rpt_offset(f);
  RETURN (SELECT jsonb_build_object('items', coalesce(jsonb_agg(app.msg_contact_json(x.c) ORDER BY x.rn) FILTER (WHERE x.rn > v_offset AND x.rn <= v_offset + v_limit), '[]'::jsonb),
                                    'total', count(*)::int, 'limit', v_limit, 'offset', v_offset)
            FROM (SELECT c AS c, row_number() OVER (ORDER BY c.display_name, c.id) rn FROM public.msg_contacts c
                   WHERE c.org_id = p_org
                     AND (v_et IS NULL OR c.entity_type = v_et) AND (v_cl IS NULL OR c.client_id = v_cl) AND (v_pa IS NULL OR c.party_id = v_pa)
                     AND (v_q IS NULL OR c.display_name ILIKE v_q OR EXISTS (SELECT 1 FROM public.msg_contact_addresses a WHERE a.contact_id = c.id AND a.address_norm ILIKE v_q))
                     AND (v_ver IS NULL OR v_ver = EXISTS (SELECT 1 FROM public.msg_contact_addresses a WHERE a.contact_id = c.id AND a.status = 'active' AND a.verified_at IS NOT NULL))
                 ) x);
END $$;

CREATE OR REPLACE FUNCTION public.get_msg_contact(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.msg_contacts;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO c FROM public.msg_contacts x WHERE x.id = p_id;
  IF c.id IS NULL OR NOT app.has_role(c.org_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'contact'); END IF;
  RETURN jsonb_build_object('contact', app.msg_contact_json(c),
    'addresses', coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at, a.id) FROM public.msg_contact_addresses a WHERE a.contact_id = c.id), '[]'::jsonb),
    'authorizations', coalesce((SELECT jsonb_agg(to_jsonb(a) || jsonb_build_object('in_date', a.status = 'active' AND a.valid_from <= app.msg_today()
                                   AND (a.valid_until IS NULL OR a.valid_until >= app.msg_today()),
                                   -- review fix (isolation): another branch's transaction is neither named nor identified
                                   'transaction_id', CASE WHEN a.transaction_id IS NULL OR app.has_tx_role(a.transaction_id, app.msg_read_roles()) THEN a.transaction_id END,
                                   'tx_hidden', a.transaction_id IS NOT NULL AND NOT app.has_tx_role(a.transaction_id, app.msg_read_roles()),
                                   'transaction_ref', CASE WHEN a.transaction_id IS NOT NULL AND app.has_tx_role(a.transaction_id, app.msg_read_roles())
                                                           THEN (SELECT t.ref FROM public.transactions t WHERE t.id = a.transaction_id) END)
                                 ORDER BY a.created_at, a.id) FROM public.msg_contact_authorizations a WHERE a.contact_id = c.id), '[]'::jsonb),
    'recent_threads', coalesce((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'subject', t.subject, 'status', t.status, 'kind', t.kind,
                                   'last_message_at', t.last_message_at, 'transaction_id', t.transaction_id) ORDER BY t.last_message_at DESC NULLS LAST)
                                 FROM (SELECT * FROM public.msg_threads t WHERE t.contact_id = c.id
                                         AND app.has_branch_role(t.org_id, t.branch_id, app.msg_read_roles())
                                       ORDER BY t.last_message_at DESC NULLS LAST LIMIT 20) t), '[]'::jsonb),
    'can', jsonb_build_object('edit', app.has_role(c.org_id, app.msg_triage_roles()), 'verify', app.has_role(c.org_id, app.msg_verify_roles())));
END $$;

CREATE OR REPLACE FUNCTION public.save_msg_contact(p_org uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_replay jsonb; v_id uuid; v public.msg_contacts; v_old public.msg_contacts; v_s text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_triage_roles());
  PERFORM app.only_keys(p_payload, ARRAY['id','display_name','entity_type','client_id','party_id','role_label','lang','notes','is_active']);
  v_replay := app.idem_begin('save_msg_contact', p_idem_key, jsonb_build_object('org', p_org, 'p', p_payload), p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_id := app.puuid(p_payload, 'id');
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.msg_contacts c WHERE c.id = v_id AND c.org_id = p_org FOR UPDATE;
    IF v_old.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'contact'); END IF;
    v := v_old;
  END IF;
  IF p_payload ? 'display_name' OR v_old.id IS NULL THEN
    v.display_name := app.ptext(p_payload, 'display_name', 160, true);
    IF char_length(v.display_name) < 2 THEN PERFORM app.fail('MRS_INVALID', 'display_name'); END IF;
  END IF;
  IF p_payload ? 'entity_type' OR v_old.id IS NULL THEN
    v_s := coalesce(app.ptext(p_payload, 'entity_type', 20), 'other');
    IF v_s NOT IN ('client','party','internal','other') THEN PERFORM app.fail('MRS_INVALID', 'entity_type'); END IF;
    v.entity_type := v_s;
  END IF;
  IF p_payload ? 'client_id' OR p_payload ? 'entity_type' THEN v.client_id := app.puuid(p_payload, 'client_id'); END IF;
  IF p_payload ? 'party_id' OR p_payload ? 'entity_type' THEN v.party_id := app.puuid(p_payload, 'party_id'); END IF;
  IF v.entity_type <> 'client' THEN v.client_id := NULL; END IF;
  IF v.entity_type <> 'party' THEN v.party_id := NULL; END IF;
  IF v.entity_type = 'client' AND (v.client_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.clients x WHERE x.id = v.client_id AND x.org_id = p_org)) THEN
    PERFORM app.fail('MRS_INVALID', 'client_id');
  END IF;
  IF v.entity_type = 'party' AND (v.party_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.parties x WHERE x.id = v.party_id AND x.org_id = p_org)) THEN
    PERFORM app.fail('MRS_INVALID', 'party_id');
  END IF;
  IF p_payload ? 'role_label' THEN v.role_label := app.ptext(p_payload, 'role_label', 80); END IF;
  IF p_payload ? 'lang' THEN
    v_s := coalesce(app.ptext(p_payload, 'lang', 2), 'ar');
    IF v_s NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'lang'); END IF;
    v.lang := v_s;
  END IF;
  IF p_payload ? 'notes' THEN v.notes := app.ptext(p_payload, 'notes', 2000); END IF;
  IF p_payload ? 'is_active' THEN v.is_active := coalesce(app.msg_rbool(p_payload, 'is_active'), true); END IF;
  IF v_old.id IS NULL THEN
    INSERT INTO public.msg_contacts (org_id, display_name, entity_type, client_id, party_id, role_label, lang, notes, is_active, created_by)
    VALUES (p_org, v.display_name, v.entity_type, v.client_id, v.party_id, v.role_label, coalesce(v.lang, 'ar'), v.notes, coalesce(v.is_active, true), auth.uid())
    RETURNING * INTO v;
  ELSE
    UPDATE public.msg_contacts c SET display_name = v.display_name, entity_type = v.entity_type, client_id = v.client_id, party_id = v.party_id,
           role_label = v.role_label, lang = v.lang, notes = v.notes, is_active = v.is_active
     WHERE c.id = v_old.id RETURNING * INTO v;
  END IF;
  RETURN app.idem_finish('save_msg_contact', p_idem_key, app.msg_contact_json(v));
END $$;

CREATE OR REPLACE FUNCTION public.add_msg_contact_address(p_contact uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.msg_contacts; v_replay jsonb; v_kind text; v_addr text; v_norm text; a public.msg_contact_addresses;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO c FROM public.msg_contacts x WHERE x.id = p_contact;
  IF c.id IS NULL OR NOT app.has_role(c.org_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'contact'); END IF;
  PERFORM app.msg_gate(c.org_id, app.msg_triage_roles());
  PERFORM app.only_keys(p_payload, ARRAY['kind','address']);
  v_replay := app.idem_begin('add_msg_contact_address', p_idem_key, jsonb_build_object('contact', p_contact, 'p', p_payload), c.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_kind := app.ptext(p_payload, 'kind', 20, true);
  IF v_kind NOT IN ('email','whatsapp') THEN PERFORM app.fail('MRS_INVALID', 'channel_kind'); END IF;
  v_addr := app.ptext(p_payload, 'address', 254, true);
  v_norm := app.msg_norm_address(v_kind, v_addr);
  IF EXISTS (SELECT 1 FROM public.msg_contact_addresses x WHERE x.org_id = c.org_id AND x.kind = v_kind AND x.address_norm = v_norm AND x.status = 'active') THEN
    PERFORM app.fail('MRS_INVALID', 'address_taken');
  END IF;
  INSERT INTO public.msg_contact_addresses (org_id, contact_id, kind, address, address_norm, created_by)
  VALUES (c.org_id, c.id, v_kind, v_addr, v_norm, auth.uid()) RETURNING * INTO a;
  RETURN app.idem_finish('add_msg_contact_address', p_idem_key, to_jsonb(a));
END $$;

CREATE OR REPLACE FUNCTION public.retire_msg_contact_address(p_address uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.msg_contact_addresses; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO a FROM public.msg_contact_addresses x WHERE x.id = p_address;
  IF a.id IS NULL OR NOT app.has_role(a.org_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'contact'); END IF;
  PERFORM app.msg_gate(a.org_id, app.msg_triage_roles());
  v_reason := app.msg_note(p_reason, true);
  IF a.status = 'retired' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'retired'); END IF;
  UPDATE public.msg_contact_addresses x SET status = 'retired', retired_at = now(), retired_by = auth.uid(), retired_reason = left(v_reason, 500)
   WHERE x.id = a.id RETURNING * INTO a;
  RETURN to_jsonb(a);
END $$;

CREATE OR REPLACE FUNCTION public.verify_msg_contact_address(p_address uuid, p_method text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.msg_contact_addresses; v_note text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO a FROM public.msg_contact_addresses x WHERE x.id = p_address;
  IF a.id IS NULL OR NOT app.has_role(a.org_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'contact'); END IF;
  PERFORM app.msg_gate(a.org_id, app.msg_verify_roles());
  IF p_method IS NULL OR p_method NOT IN ('callback','known_domain','in_person','signed_document','provider_verified') THEN
    PERFORM app.fail('MRS_INVALID', 'verification_method');
  END IF;
  v_note := app.msg_note(p_note, true);
  IF char_length(v_note) > 500 THEN PERFORM app.fail('MRS_TOO_LONG', 'note'); END IF;
  IF a.status <> 'active' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'retired'); END IF;
  UPDATE public.msg_contact_addresses x SET verified_at = now(), verified_by = auth.uid(), verification_method = p_method, verification_note = v_note
   WHERE x.id = a.id RETURNING * INTO a;
  RETURN to_jsonb(a);
END $$;

CREATE OR REPLACE FUNCTION public.grant_msg_authorization(p_contact uuid, p_payload jsonb, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.msg_contacts; v_scope text; v_cl uuid; v_pa uuid; v_tx uuid; v_kinds text[]; v_topics text[]; v_from date; v_until date;
        v_note text; a public.msg_contact_authorizations;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO c FROM public.msg_contacts x WHERE x.id = p_contact;
  IF c.id IS NULL OR NOT app.has_role(c.org_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'contact'); END IF;
  PERFORM app.msg_gate(c.org_id, app.msg_verify_roles());
  PERFORM app.only_keys(p_payload, ARRAY['scope_type','client_id','party_id','transaction_id','may_receive_kinds','may_discuss','valid_from','valid_until']);
  v_note := app.msg_note(p_note, true);
  v_scope := app.ptext(p_payload, 'scope_type', 20, true);
  IF v_scope NOT IN ('client','party','transaction') THEN PERFORM app.fail('MRS_INVALID', 'scope_type'); END IF;
  IF v_scope = 'client' THEN
    v_cl := app.puuid(p_payload, 'client_id');
    IF v_cl IS NULL OR NOT EXISTS (SELECT 1 FROM public.clients x WHERE x.id = v_cl AND x.org_id = c.org_id) THEN PERFORM app.fail('MRS_INVALID', 'client_id'); END IF;
  ELSIF v_scope = 'party' THEN
    v_pa := app.puuid(p_payload, 'party_id');
    IF v_pa IS NULL OR NOT EXISTS (SELECT 1 FROM public.parties x WHERE x.id = v_pa AND x.org_id = c.org_id) THEN PERFORM app.fail('MRS_INVALID', 'party_id'); END IF;
  ELSE
    v_tx := app.puuid(p_payload, 'transaction_id');
    IF v_tx IS NULL OR NOT EXISTS (SELECT 1 FROM public.transactions x WHERE x.id = v_tx AND x.org_id = c.org_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
    IF NOT app.has_tx_role(v_tx, app.msg_read_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'branch'); END IF;
  END IF;
  v_kinds := app.msg_rcodes(p_payload -> 'may_receive_kinds', 'document_kind', 20, 'may_receive_kinds');
  IF EXISTS (SELECT 1 FROM unnest(v_kinds) k WHERE NOT (k = ANY (app.document_kinds()))) THEN PERFORM app.fail('MRS_INVALID', 'may_receive_kinds'); END IF;
  v_topics := app.msg_rcodes(p_payload -> 'may_discuss', 'msg_category', 20, 'may_discuss');
  v_from := coalesce(app.pdate(p_payload, 'valid_from'), app.msg_today());
  v_until := app.pdate(p_payload, 'valid_until');
  IF v_until IS NOT NULL AND v_until < v_from THEN PERFORM app.fail('MRS_INVALID', 'valid_until'); END IF;
  INSERT INTO public.msg_contact_authorizations (org_id, contact_id, scope_type, client_id, party_id, transaction_id, may_receive_kinds, may_discuss,
                                                 valid_from, valid_until, granted_by, grant_note)
  VALUES (c.org_id, c.id, v_scope, v_cl, v_pa, v_tx, v_kinds, v_topics, v_from, v_until, auth.uid(), v_note)
  RETURNING * INTO a;
  RETURN to_jsonb(a);
END $$;

CREATE OR REPLACE FUNCTION public.revoke_msg_authorization(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.msg_contact_authorizations; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO a FROM public.msg_contact_authorizations x WHERE x.id = p_id;
  IF a.id IS NULL OR NOT app.has_role(a.org_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'contact'); END IF;
  PERFORM app.msg_gate(a.org_id, app.msg_verify_roles());
  v_reason := app.msg_note(p_reason, true);
  IF a.status <> 'active' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'revoked'); END IF;
  UPDATE public.msg_contact_authorizations x SET status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoked_reason = v_reason
   WHERE x.id = a.id RETURNING * INTO a;
  RETURN to_jsonb(a);
END $$;

-- ---------------- inbox ----------------
CREATE OR REPLACE FUNCTION public.list_msg_threads(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_box text; v_st text; v_pr text; v_cat text; v_ch uuid; v_br uuid; v_ow uuid; v_ms text;
        v_tx uuid; v_risk text; v_q text; v_r date[]; v_limit int; v_offset int; v_sc uuid[]; v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_read_roles());
  PERFORM app.only_keys(f, ARRAY['box','status','priority','category','channel_id','branch_id','owner_id','match_status','transaction_id','risk','q',
                                 'from','to','limit','offset']);
  v_box := coalesce(app.ptext(f, 'box', 20), 'all');
  IF v_box NOT IN ('all','mine','unassigned','review','approval','sent') THEN PERFORM app.fail('MRS_INVALID', 'box'); END IF;
  v_st := app.ptext(f, 'status', 30);
  IF v_st IS NOT NULL AND NOT app.is_code('msg_thread_status', v_st) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  v_pr := app.ptext(f, 'priority', 20);
  IF v_pr IS NOT NULL AND NOT app.is_code('msg_priority', v_pr) THEN PERFORM app.fail('MRS_INVALID', 'priority'); END IF;
  v_cat := app.ptext(f, 'category', 30);
  IF v_cat IS NOT NULL AND NOT app.is_code('msg_category', v_cat) THEN PERFORM app.fail('MRS_INVALID', 'category'); END IF;
  v_ms := app.ptext(f, 'match_status', 30);
  IF v_ms IS NOT NULL AND NOT app.is_code('msg_match_status', v_ms) THEN PERFORM app.fail('MRS_INVALID', 'match_status'); END IF;
  v_risk := app.ptext(f, 'risk', 40);
  IF v_risk IS NOT NULL AND NOT app.is_code('msg_risk_flag', v_risk) THEN PERFORM app.fail('MRS_INVALID', 'risk'); END IF;
  v_ch := app.puuid(f, 'channel_id'); v_br := app.rpt_branch(p_org, f); v_ow := app.puuid(f, 'owner_id'); v_tx := app.puuid(f, 'transaction_id');
  v_q := app.rpt_like(app.ptext(f, 'q', 100));
  v_r := app.rpt_range(f, 3660);
  v_limit := app.rpt_limit(f, 100, 25); v_offset := app.rpt_offset(f);
  v_sc := app.rpt_scope(p_org, app.msg_read_roles());
  WITH base AS (
    SELECT t.* FROM public.msg_threads t
     WHERE t.org_id = p_org AND ((v_sc IS NULL) OR (t.branch_id IS NOT NULL AND t.branch_id = ANY (v_sc)))),
  boxed AS (
    SELECT b.*,
           b.owner_id = auth.uid() AS is_mine,
           b.owner_id IS NULL AND b.status NOT IN ('resolved','spam') AS is_unassigned,
           b.match_status IN ('suggested','review') AS is_review,
           EXISTS (SELECT 1 FROM public.msg_replies r WHERE r.thread_id = b.id AND r.status = 'pending_approval') AS is_approval,
           EXISTS (SELECT 1 FROM public.msg_replies r WHERE r.thread_id = b.id AND r.status = 'sent') AS is_sent
      FROM base b),
  filt AS (
    SELECT x.* FROM boxed x
     WHERE (v_st IS NULL OR x.status = v_st) AND (v_pr IS NULL OR x.priority = v_pr) AND (v_cat IS NULL OR x.category = v_cat)
       AND (v_ch IS NULL OR x.channel_id = v_ch) AND (v_br IS NULL OR x.branch_id = v_br) AND (v_ow IS NULL OR x.owner_id = v_ow)
       AND (v_ms IS NULL OR x.match_status = v_ms) AND (v_tx IS NULL OR x.transaction_id = v_tx) AND (v_risk IS NULL OR v_risk = ANY (x.risk_flags))
       AND (v_r[1] IS NULL OR x.last_message_at >= app.rpt_ts(v_r[1])) AND (v_r[2] IS NULL OR x.last_message_at < app.rpt_ts(v_r[2] + 1))
       AND (v_q IS NULL OR x.subject ILIKE v_q
            OR EXISTS (SELECT 1 FROM public.msg_messages m WHERE m.thread_id = x.id AND (m.from_address_norm ILIKE v_q OR m.from_name ILIKE v_q))
            OR EXISTS (SELECT 1 FROM public.msg_extractions e WHERE e.thread_id = x.id AND coalesce(e.corrected_value, e.normalized) ILIKE v_q))),
  inbox AS (
    SELECT y.*, row_number() OVER (ORDER BY y.last_message_at DESC NULLS LAST, y.id) rn FROM filt y
     WHERE CASE v_box WHEN 'mine' THEN y.is_mine WHEN 'unassigned' THEN y.is_unassigned WHEN 'review' THEN y.is_review
                      WHEN 'approval' THEN y.is_approval WHEN 'sent' THEN y.is_sent ELSE true END)
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(app.msg_thread_json(t) ORDER BY i.rn) FROM inbox i JOIN public.msg_threads t ON t.id = i.id
                        WHERE i.rn > v_offset AND i.rn <= v_offset + v_limit), '[]'::jsonb),
    'total', (SELECT count(*)::int FROM inbox),
    'limit', v_limit, 'offset', v_offset,
    'counts', jsonb_build_object(
      'by_box', jsonb_build_object('all', (SELECT count(*)::int FROM filt), 'mine', (SELECT count(*)::int FROM filt WHERE is_mine),
                                   'unassigned', (SELECT count(*)::int FROM filt WHERE is_unassigned), 'review', (SELECT count(*)::int FROM filt WHERE is_review),
                                   'attention', (SELECT count(*)::int FROM filt WHERE is_unassigned OR is_review),
                                   'approval', (SELECT count(*)::int FROM filt WHERE is_approval), 'sent', (SELECT count(*)::int FROM filt WHERE is_sent)),
      'by_status', coalesce((SELECT jsonb_object_agg(z.status, z.n) FROM (SELECT status, count(*)::int n FROM filt GROUP BY status) z), '{}'::jsonb),
      'by_priority', coalesce((SELECT jsonb_object_agg(z.priority, z.n) FROM (SELECT priority, count(*)::int n FROM filt GROUP BY priority) z), '{}'::jsonb),
      'new', (SELECT count(*)::int FROM filt WHERE status = 'new'),
      'send_unknown', (SELECT count(*)::int FROM filt x WHERE EXISTS (SELECT 1 FROM public.msg_outbound o WHERE o.thread_id = x.id AND o.state = 'unknown'))))
    INTO v_res;
  RETURN v_res;
END $$;

CREATE OR REPLACE FUNCTION public.get_msg_thread(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; v_tri boolean; v_r public.msg_replies; v_level text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO t FROM public.msg_threads x WHERE x.id = p_id;
  IF t.id IS NULL OR NOT app.has_branch_role(t.org_id, t.branch_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'thread'); END IF;
  IF t.unread_count > 0 THEN
    UPDATE public.msg_threads x SET unread_count = 0 WHERE x.id = t.id RETURNING * INTO t;
  END IF;
  v_tri := app.has_branch_role(t.org_id, t.branch_id, app.msg_triage_roles());
  SELECT * INTO v_r FROM public.msg_replies r WHERE r.thread_id = t.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1;
  v_level := app.msg_effective_level(t.org_id, t.id, coalesce(v_r.category, t.category));
  RETURN jsonb_build_object(
    'thread', app.msg_thread_json(t),
    'messages', coalesce((SELECT jsonb_agg(app.msg_message_json(m) ORDER BY m.received_at, m.id) FROM public.msg_messages m WHERE m.thread_id = t.id), '[]'::jsonb),
    -- review fix (isolation): link history shows another branch's transaction neither by id nor by ref
    'links', coalesce((SELECT jsonb_agg((to_jsonb(l) - ARRAY['basis','transaction_id']) || jsonb_build_object(
                                          'basis', app.msg_visible_basis(t.org_id, l.basis),
                                          'transaction_id', CASE WHEN x.id IS NULL OR app.has_branch_role(t.org_id, x.branch_id, app.msg_read_roles()) THEN l.transaction_id END,
                                          'transaction_hidden', x.id IS NOT NULL AND NOT app.has_branch_role(t.org_id, x.branch_id, app.msg_read_roles()),
                                          'transaction_ref', CASE WHEN x.id IS NOT NULL AND app.has_branch_role(t.org_id, x.branch_id, app.msg_read_roles()) THEN x.ref END,
                                          'actor_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = l.actor))
                                        ORDER BY l.created_at, l.id)
                         FROM public.msg_thread_links l LEFT JOIN public.transactions x ON x.id = l.transaction_id WHERE l.thread_id = t.id), '[]'::jsonb),
    'candidates', app.msg_visible_candidates(t.org_id, t.match_candidates),
    -- review fix (UI): open draft jobs of the thread (the composer shows «في الانتظار — لم يُشغَّل العامل» after a reload)
    'jobs', coalesce((SELECT jsonb_agg(app.msg_job_json(j) ORDER BY j.created_at, j.id) FROM public.msg_jobs j
                       WHERE j.thread_id = t.id AND j.kind = 'draft' AND j.status IN ('queued','running','unknown')), '[]'::jsonb),
    'replies', coalesce((SELECT jsonb_agg(app.msg_reply_json(r) ORDER BY r.created_at, r.id) FROM public.msg_replies r WHERE r.thread_id = t.id), '[]'::jsonb),
    'suggestions', jsonb_build_object('template_key', app.msg_category_template(t.category)),
    'participants', to_jsonb(app.msg_participants(t.id)),
    'approval_level', v_level,
    'can', jsonb_build_object(
      'triage', v_tri, 'link', v_tri, 'draft', v_tri,
      'approve', app.has_branch_role(t.org_id, t.branch_id, app.msg_approve_roles()) AND app.has_branch_role(t.org_id, t.branch_id, app.msg_level_roles(v_level)),
      'send', app.has_branch_role(t.org_id, t.branch_id, app.msg_send_roles()),
      'resolve_unknown', app.has_branch_role(t.org_id, t.branch_id, app.msg_approve_roles())));
END $$;

CREATE OR REPLACE FUNCTION public.update_msg_thread(p_id uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; v_lock jsonb; v_st text; v_pr text; v_ow uuid; v_br uuid; v_due timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  t := app.msg_thread_for(p_id, app.msg_triage_roles());
  PERFORM app.only_keys(p_payload, ARRAY['status','priority','owner_id','due_at','branch_id']);
  v_lock := t.triage_locked;
  IF p_payload ? 'status' THEN
    v_st := app.ptext(p_payload, 'status', 30, true);
    IF NOT app.is_code('msg_thread_status', v_st) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
    t.status := v_st; v_lock := v_lock || jsonb_build_object('status', true);
  END IF;
  IF p_payload ? 'priority' THEN
    v_pr := app.ptext(p_payload, 'priority', 20, true);
    IF NOT app.is_code('msg_priority', v_pr) THEN PERFORM app.fail('MRS_INVALID', 'priority'); END IF;
    t.priority := v_pr; v_lock := v_lock || jsonb_build_object('priority', true);
  END IF;
  IF p_payload ? 'branch_id' THEN
    v_br := app.puuid(p_payload, 'branch_id');
    IF v_br IS DISTINCT FROM t.branch_id THEN
      IF t.transaction_id IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'branch_id'); END IF;   -- a linked thread follows its transaction
      IF v_br IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = v_br AND b.org_id = t.org_id) THEN
        PERFORM app.fail('MRS_INVALID', 'branch_id');
      END IF;
      IF NOT app.has_branch_role(t.org_id, v_br, app.msg_triage_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'branch'); END IF;
      t.branch_id := v_br;
    END IF;
  END IF;
  IF p_payload ? 'owner_id' THEN
    v_ow := app.puuid(p_payload, 'owner_id');
    IF v_ow IS NOT NULL AND NOT app.uid_has_branch_role(v_ow, t.org_id, t.branch_id, app.msg_triage_roles()) THEN PERFORM app.fail('MRS_INVALID', 'owner'); END IF;
    t.owner_id := v_ow; v_lock := v_lock || jsonb_build_object('owner_id', true);
  END IF;
  IF t.owner_id IS NOT NULL AND NOT app.uid_has_branch_role(t.owner_id, t.org_id, t.branch_id, app.msg_triage_roles()) THEN
    PERFORM app.fail('MRS_INVALID', 'owner');
  END IF;
  IF p_payload ? 'due_at' THEN
    v_due := app.msg_rts(p_payload, 'due_at');
    t.due_at := v_due;
  END IF;
  UPDATE public.msg_threads x SET status = t.status, priority = t.priority, owner_id = t.owner_id, branch_id = t.branch_id, due_at = t.due_at,
         triage_locked = v_lock
   WHERE x.id = t.id RETURNING * INTO t;
  RETURN app.msg_thread_json(t);
END $$;

CREATE OR REPLACE FUNCTION public.link_msg_thread(p_thread uuid, p_tx uuid, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; x public.transactions; v_note text; v_cand jsonb; v_top uuid; v_basis jsonb; v_sender public.msg_messages;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  t := app.msg_thread_for(p_thread, app.msg_triage_roles());
  SELECT * INTO x FROM public.transactions y WHERE y.id = p_tx AND y.org_id = t.org_id;
  IF x.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  IF NOT app.has_branch_role(x.org_id, x.branch_id, app.msg_triage_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'branch'); END IF;
  IF t.transaction_id = p_tx AND t.match_status = 'linked' THEN
    RETURN app.msg_thread_json(t) || jsonb_build_object('unchanged', true);
  END IF;
  v_note := app.msg_note(p_note, false);
  v_top := (t.match_candidates -> 0 ->> 'transaction_id')::uuid;
  IF v_note IS NULL AND (t.match_status = 'review' OR v_top IS DISTINCT FROM p_tx) THEN PERFORM app.fail('MRS_NOTE_REQUIRED', 'note'); END IF;
  SELECT c INTO v_cand FROM jsonb_array_elements(t.match_candidates) c WHERE (c ->> 'transaction_id')::uuid = p_tx;
  SELECT * INTO v_sender FROM public.msg_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' ORDER BY m.received_at DESC, m.id DESC LIMIT 1;
  v_basis := jsonb_build_object('signals', coalesce(v_cand -> 'signals', '[]'::jsonb), 'score', coalesce((v_cand ->> 'score')::int, 0),
    'candidates', coalesce((SELECT jsonb_agg(jsonb_build_object('transaction_id', c -> 'transaction_id', 'score', c -> 'score')) FROM jsonb_array_elements(t.match_candidates) c), '[]'::jsonb),
    'sender', jsonb_build_object('status', v_sender.sender_status, 'contact_id', v_sender.sender_contact_id),
    'rule', 'staff_choice', 'previous_status', t.match_status);
  t := app.msg_set_link(t, p_tx, 'link', 'staff', v_basis, v_note, 'linked', NULL);
  RETURN app.msg_thread_json(t);
END $$;

CREATE OR REPLACE FUNCTION public.unlink_msg_thread(p_thread uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  t := app.msg_thread_for(p_thread, app.msg_triage_roles());
  v_reason := app.msg_note(p_reason, true);
  IF t.transaction_id IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'transaction'); END IF;
  t := app.msg_set_link(t, NULL, 'unlink', 'staff', jsonb_build_object('signals', '[]'::jsonb, 'previous_transaction_id', t.transaction_id,
                                                                        'rule', 'staff_unlink'), v_reason, 'unmatched', NULL);
  RETURN app.msg_thread_json(t);
END $$;

CREATE OR REPLACE FUNCTION public.mark_msg_not_related(p_thread uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  t := app.msg_thread_for(p_thread, app.msg_triage_roles());
  v_reason := app.msg_note(p_reason, true);
  t := app.msg_set_link(t, NULL, 'not_related', 'staff', jsonb_build_object('signals', '[]'::jsonb, 'previous_transaction_id', t.transaction_id,
                                                                             'rule', 'staff_not_related'), v_reason, 'not_related', NULL);
  RETURN app.msg_thread_json(t);
END $$;

-- review_msg_extraction(p_id, confirm|correct|reject, p_value, p_note): correct re-validates; matching re-runs
CREATE OR REPLACE FUNCTION public.review_msg_extraction(p_id uuid, p_decision text, p_value text DEFAULT NULL, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.msg_extractions; t public.msg_threads; v_val text; v_note text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO e FROM public.msg_extractions x WHERE x.id = p_id;
  IF e.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'extraction'); END IF;
  t := app.msg_thread_for(e.thread_id, app.msg_triage_roles());
  IF p_decision IS NULL OR p_decision NOT IN ('confirm','correct','reject') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_note := app.msg_note(p_note, p_decision = 'correct');
  IF p_decision = 'correct' THEN
    v_val := upper(regexp_replace(app.to_western(btrim(coalesce(p_value, ''))), '[[:space:]]+', '', 'g'));
    IF e.kind = 'container_no' THEN v_val := replace(v_val, '-', ''); END IF;
    IF v_val = '' OR char_length(v_val) > 200
       OR (e.kind = 'container_no' AND NOT app.msg_iso6346_ok(v_val))
       OR (e.kind = 'tx_ref' AND v_val !~ '^MRS-[0-9]{4}-[0-9]{6}$')
       OR (e.kind = 'date' AND (v_val !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR app.pdate(jsonb_build_object('d', v_val), 'd') IS NULL))
       OR (e.kind IN ('bl_number','declaration_no','invoice_no','appointment_no') AND v_val !~ '^[A-Z0-9/-]{3,40}$') THEN
      PERFORM app.fail('MRS_INVALID', 'extraction');
    END IF;
  END IF;
  UPDATE public.msg_extractions x SET status = CASE p_decision WHEN 'confirm' THEN 'confirmed' WHEN 'correct' THEN 'corrected' ELSE 'rejected' END,
         corrected_value = CASE WHEN p_decision = 'correct' THEN v_val END, reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note
   WHERE x.id = e.id RETURNING * INTO e;
  PERFORM app.msg_match(t.id);
  RETURN to_jsonb(e) || jsonb_build_object('thread', (SELECT app.msg_thread_json(x) FROM public.msg_threads x WHERE x.id = t.id));
END $$;

CREATE OR REPLACE FUNCTION public.correct_msg_classification(p_message uuid, p_category text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.msg_messages; t public.msg_threads; v_note text; c public.msg_classifications;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO m FROM public.msg_messages x WHERE x.id = p_message;
  IF m.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'message'); END IF;
  t := app.msg_thread_for(m.thread_id, app.msg_triage_roles());
  IF p_category IS NULL OR NOT app.is_code('msg_category', p_category) THEN PERFORM app.fail('MRS_INVALID', 'category'); END IF;
  v_note := app.msg_note(p_note, true);
  INSERT INTO public.msg_classifications (org_id, message_id, thread_id, category, source, actor, note)
  VALUES (m.org_id, m.id, m.thread_id, p_category, 'staff', auth.uid(), v_note) RETURNING * INTO c;
  PERFORM app.msg_refresh_category(t.id);
  RETURN to_jsonb(c);
END $$;

-- accept_msg_summary(p_summary, {owner_id, set_due}): due date only from a spanned deadline
CREATE OR REPLACE FUNCTION public.accept_msg_summary(p_summary uuid, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.msg_summaries; t public.msg_threads; v_ow uuid; v_due boolean; v_set boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO s FROM public.msg_summaries x WHERE x.id = p_summary;
  IF s.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'message'); END IF;
  t := app.msg_thread_for(s.thread_id, app.msg_triage_roles());
  PERFORM app.only_keys(coalesce(p_payload, '{}'::jsonb), ARRAY['owner_id','set_due']);
  v_ow := app.puuid(p_payload, 'owner_id');
  v_due := coalesce(app.msg_rbool(p_payload, 'set_due'), false);
  IF v_ow IS NOT NULL AND NOT app.uid_has_branch_role(v_ow, t.org_id, t.branch_id, app.msg_triage_roles()) THEN PERFORM app.fail('MRS_INVALID', 'owner'); END IF;
  IF s.accepted_at IS NULL THEN
    UPDATE public.msg_summaries x SET accepted_by = auth.uid(), accepted_at = now() WHERE x.id = s.id RETURNING * INTO s;
  END IF;
  IF v_due AND s.deadline_extraction_id IS NOT NULL AND s.deadline_date IS NOT NULL THEN v_set := true; END IF;
  UPDATE public.msg_threads x SET owner_id = coalesce(v_ow, x.owner_id),
         triage_locked = CASE WHEN v_ow IS NOT NULL THEN x.triage_locked || '{"owner_id": true}'::jsonb ELSE x.triage_locked END,
         due_at = CASE WHEN v_set THEN ((s.deadline_date + 1)::timestamp AT TIME ZONE 'Asia/Riyadh') - interval '1 second' ELSE x.due_at END
   WHERE x.id = t.id RETURNING * INTO t;
  RETURN to_jsonb(s) || jsonb_build_object('due_set', v_set, 'thread', app.msg_thread_json(t));
END $$;

-- ---------------- replies ----------------
-- request_msg_draft(p_thread, {template_key, lang, reply_to_message_id}, p_idem_key) → {job, reply?}; no reply row is created here
CREATE OR REPLACE FUNCTION public.request_msg_draft(p_thread uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; v_replay jsonb; v_key text; v_lang text; v_rt uuid; r public.msg_replies; v_job jsonb; f jsonb := coalesce(p_payload, '{}'::jsonb);
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  t := app.msg_thread_for(p_thread, app.msg_triage_roles());
  PERFORM app.only_keys(f, ARRAY['template_key','lang','reply_to_message_id']);
  v_replay := app.idem_begin('request_msg_draft', p_idem_key, jsonb_build_object('thread', p_thread, 'p', f), t.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_key := coalesce(app.ptext(f, 'template_key', 40), app.msg_category_template(t.category));
  IF NOT app.is_code('msg_template_key', v_key) OR v_key = 'ack_receipt' THEN PERFORM app.fail('MRS_INVALID', 'template_key'); END IF;
  v_lang := app.ptext(f, 'lang', 2);
  IF v_lang IS NOT NULL AND v_lang NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'lang'); END IF;
  v_rt := app.puuid(f, 'reply_to_message_id');
  IF v_rt IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.msg_messages m WHERE m.id = v_rt AND m.thread_id = t.id AND m.direction = 'inbound') THEN
    PERFORM app.fail('MRS_NOT_FOUND', 'message');
  END IF;
  IF v_rt IS NULL THEN
    SELECT m.id INTO v_rt FROM public.msg_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' ORDER BY m.received_at DESC, m.id DESC LIMIT 1;
  END IF;
  IF v_rt IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'message'); END IF;
  SELECT * INTO r FROM public.msg_replies x WHERE x.thread_id = t.id AND x.status IN ('draft','pending_approval','approved','sending','send_unknown');
  IF r.status IN ('sending','send_unknown') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'reply_locked'); END IF;
  v_lang := coalesce(v_lang, r.lang,
                     (SELECT c.lang FROM public.msg_contacts c WHERE c.id = t.contact_id), (app.msg_settings_of(t.org_id)).default_lang);
  v_job := app.msg_enqueue(t.org_id, 'draft', t.channel_id, t.id, NULL, r.id, NULL,
                           jsonb_build_object('template_key', v_key, 'lang', v_lang, 'reply_to_message_id', v_rt), auth.uid());
  RETURN app.idem_finish('request_msg_draft', p_idem_key, jsonb_build_object('job', v_job, 'reply', CASE WHEN r.id IS NOT NULL THEN app.msg_reply_json(r) END));
END $$;

-- save_msg_reply(p_reply NULL = new, {thread_id, reply_to_message_id, lang, subject, body_text, to[], cc[]}, p_idem_key)
CREATE OR REPLACE FUNCTION public.save_msg_reply(p_reply uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; r public.msg_replies; cv public.msg_reply_versions; v public.msg_reply_versions; v_replay jsonb;
        v_rt uuid; v_lang text; v_subject text; v_body text; v_to jsonb; v_cc jsonb; v_th uuid; f jsonb := p_payload;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.only_keys(f, ARRAY['thread_id','reply_to_message_id','lang','subject','body_text','to','cc']);
  IF p_reply IS NOT NULL THEN
    SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply;
    IF r.id IS NULL OR NOT app.msg_can_read_thread(r.thread_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'reply'); END IF;
    v_th := r.thread_id;
  ELSE
    v_th := app.puuid(f, 'thread_id');
    IF v_th IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'thread_id'); END IF;
  END IF;
  t := app.msg_thread_for(v_th, app.msg_triage_roles());
  v_replay := app.idem_begin('save_msg_reply', p_idem_key, jsonb_build_object('reply', p_reply, 'p', f), t.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF r.id IS NOT NULL THEN
    SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply FOR UPDATE;
    IF r.status NOT IN ('draft','pending_approval','approved','rejected') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'reply_locked'); END IF;
    IF r.status = 'rejected' AND EXISTS (SELECT 1 FROM public.msg_replies x WHERE x.thread_id = t.id AND x.id <> r.id
                                           AND x.status IN ('draft','pending_approval','approved','sending','send_unknown')) THEN
      PERFORM app.fail('MRS_INVALID', 'reply_exists');
    END IF;
    SELECT * INTO cv FROM public.msg_reply_versions x WHERE x.id = r.current_version_id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.msg_replies x WHERE x.thread_id = t.id AND x.status IN ('draft','pending_approval','approved','sending','send_unknown')) THEN
      PERFORM app.fail('MRS_INVALID', 'reply_exists');
    END IF;
    v_rt := app.puuid(f, 'reply_to_message_id');
    IF v_rt IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.msg_messages m WHERE m.id = v_rt AND m.thread_id = t.id AND m.direction = 'inbound') THEN
      PERFORM app.fail('MRS_NOT_FOUND', 'message');
    END IF;
    IF v_rt IS NULL THEN
      SELECT m.id INTO v_rt FROM public.msg_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' ORDER BY m.received_at DESC, m.id DESC LIMIT 1;
    END IF;
    v_lang := coalesce(app.ptext(f, 'lang', 2), (app.msg_settings_of(t.org_id)).default_lang);
    IF v_lang NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'lang'); END IF;
    INSERT INTO public.msg_replies (org_id, thread_id, reply_to_message_id, channel_id, lang, category, created_by)
    VALUES (t.org_id, t.id, v_rt, t.channel_id, v_lang, t.category, auth.uid()) RETURNING * INTO r;
  END IF;
  v_subject := CASE WHEN f ? 'subject' THEN app.ptext(f, 'subject', 500) ELSE coalesce(cv.subject,
                 CASE WHEN t.kind = 'email' THEN left('Re: ' || coalesce(t.subject, ''), 500) END) END;
  IF f ? 'body_text' THEN
    IF jsonb_typeof(f -> 'body_text') NOT IN ('string','null') OR char_length(f ->> 'body_text') > 20000 THEN PERFORM app.fail('MRS_INVALID', 'body_text'); END IF;
    v_body := coalesce(f ->> 'body_text', '');
  ELSE
    v_body := coalesce(cv.body_text, '');
  END IF;
  v_to := CASE WHEN f ? 'to' THEN app.msg_check_recipients(t, f -> 'to', 'to') ELSE coalesce(cv.to_addresses, app.msg_default_to(t, r.reply_to_message_id)) END;
  v_cc := CASE WHEN f ? 'cc' THEN app.msg_check_recipients(t, f -> 'cc', 'cc') ELSE coalesce(cv.cc_addresses, '[]'::jsonb) END;
  IF t.kind = 'whatsapp' AND (jsonb_array_length(v_cc) > 0 OR jsonb_array_length(v_to) > 1
                              OR (jsonb_array_length(v_to) = 1 AND v_to -> 0 ->> 'address_norm' IS DISTINCT FROM t.counterpart_address_norm)) THEN
    PERFORM app.fail('MRS_INVALID', 'recipient');
  END IF;
  v := app.msg_add_version(r, 'staff', auth.uid(), NULL, v_subject, v_body, v_to, v_cc, coalesce(cv.attachments, '[]'::jsonb),
                           coalesce(cv.clarification, false), cv.missing, cv.used_facts, coalesce(cv.template_key, r.template_key), cv.template_version, NULL);
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = r.id;
  RETURN app.idem_finish('save_msg_reply', p_idem_key, app.msg_reply_json(r) || jsonb_build_object('version', to_jsonb(v)));
END $$;

CREATE OR REPLACE FUNCTION public.msg_attachment_suggestions(p_reply uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.msg_replies; t public.msg_threads; v public.msg_reply_versions; v_kinds text[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply;
  IF r.id IS NULL OR NOT app.msg_can_read_thread(r.thread_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'reply'); END IF;
  SELECT * INTO t FROM public.msg_threads x WHERE x.id = r.thread_id;
  SELECT * INTO v FROM public.msg_reply_versions x WHERE x.id = r.current_version_id;
  v_kinds := app.msg_category_doc_kinds(coalesce(r.category, t.category));
  RETURN jsonb_build_object('category', coalesce(r.category, t.category), 'kinds', to_jsonb(v_kinds), 'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object('document_id', d.id, 'kind', d.kind, 'classification', d.classification, 'name', d.original_name,
                                        'uploaded_at', d.uploaded_at, 'sensitive', coalesce(d.classification, d.kind) = ANY (app.msg_sensitive_kinds()),
                                        'suggested_for', coalesce(r.category, t.category),
                                        'can_share', (app.msg_share_check(t, v.to_addresses, v.cc_addresses, d.id) ->> 'ok')::boolean,
                                        'reasons', app.msg_share_check(t, v.to_addresses, v.cc_addresses, d.id) -> 'reasons')
                     ORDER BY d.uploaded_at, d.id)
      FROM public.documents d
     WHERE t.transaction_id IS NOT NULL AND d.transaction_id = t.transaction_id AND d.voided_at IS NULL
       AND coalesce(d.classification, d.kind) = ANY (v_kinds)), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.set_msg_reply_attachments(p_reply uuid, p_document_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.msg_replies; t public.msg_threads; cv public.msg_reply_versions; v public.msg_reply_versions; v_att jsonb := '[]'::jsonb;
        d public.documents; v_chk jsonb; v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply;
  IF r.id IS NULL OR NOT app.msg_can_read_thread(r.thread_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'reply'); END IF;
  t := app.msg_thread_for(r.thread_id, app.msg_triage_roles());
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply FOR UPDATE;
  IF r.status NOT IN ('draft','pending_approval','approved','rejected') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'reply_locked'); END IF;
  IF cardinality(coalesce(p_document_ids, '{}')) > 10 THEN PERFORM app.fail('MRS_INVALID', 'document'); END IF;
  SELECT * INTO cv FROM public.msg_reply_versions x WHERE x.id = r.current_version_id;
  FOR v_id IN SELECT DISTINCT x FROM unnest(coalesce(p_document_ids, '{}')) x LOOP
    SELECT * INTO d FROM public.documents x WHERE x.id = v_id AND x.org_id = t.org_id;
    IF d.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'document'); END IF;
    v_chk := app.msg_share_check(t, coalesce(cv.to_addresses, app.msg_default_to(t, r.reply_to_message_id)), coalesce(cv.cc_addresses, '[]'::jsonb), d.id);
    IF NOT (v_chk ->> 'ok')::boolean THEN
      PERFORM app.fin_fail('MRS_FORBIDDEN', 'recipient_not_authorized', (SELECT string_agg(x, ',') FROM jsonb_array_elements_text(v_chk -> 'reasons') x));
    END IF;
    v_att := v_att || jsonb_build_array(jsonb_build_object('document_id', d.id, 'kind', coalesce(d.classification, d.kind),
               'sensitive', coalesce(d.classification, d.kind) = ANY (app.msg_sensitive_kinds()), 'sha256', d.sha256, 'name', d.original_name));
  END LOOP;
  v := app.msg_add_version(r, 'staff', auth.uid(), NULL, cv.subject, coalesce(cv.body_text, ''),
                           coalesce(cv.to_addresses, app.msg_default_to(t, r.reply_to_message_id)), coalesce(cv.cc_addresses, '[]'::jsonb), v_att,
                           coalesce(cv.clarification, false), cv.missing, cv.used_facts, cv.template_key, cv.template_version, NULL);
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = r.id;
  RETURN app.msg_reply_json(r) || jsonb_build_object('version', to_jsonb(v));
END $$;

CREATE OR REPLACE FUNCTION public.submit_msg_reply(p_reply uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.msg_replies; t public.msg_threads; v public.msg_reply_versions; v_warn text[] := '{}';
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply;
  IF r.id IS NULL OR NOT app.msg_can_read_thread(r.thread_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'reply'); END IF;
  t := app.msg_thread_for(r.thread_id, app.msg_triage_roles());
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply FOR UPDATE;
  IF r.status <> 'draft' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_draft'); END IF;
  SELECT * INTO v FROM public.msg_reply_versions x WHERE x.id = r.current_version_id;
  IF v.id IS NULL OR jsonb_array_length(v.to_addresses) = 0 THEN PERFORM app.fail('MRS_REQUIRED', 'recipient'); END IF;
  IF btrim(coalesce(v.body_text, '')) = '' THEN PERFORM app.fail('MRS_REQUIRED', 'body'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.msg_channels c WHERE c.id = r.channel_id AND c.send_enabled) THEN v_warn := v_warn || 'channel_send_disabled'::text; END IF;
  -- review fix: restricted facts only for recipients that are all verified + authorized (a cc added after the draft included)
  IF NOT app.msg_facts_ok(t, v.to_addresses, v.cc_addresses, v.used_facts) THEN
    PERFORM app.fin_fail('MRS_FORBIDDEN', 'recipient_not_authorized', 'restricted_facts');
  END IF;
  -- the category snapshot stays; the approval level is the strictest of it and the thread's categories (decide, review fix)
  UPDATE public.msg_replies x SET status = 'pending_approval', submitted_by = auth.uid(), submitted_at = now(),
         category = coalesce(x.category, t.category)
   WHERE x.id = r.id RETURNING * INTO r;
  RETURN app.msg_reply_json(r) || jsonb_build_object('warnings', to_jsonb(v_warn));
END $$;

CREATE OR REPLACE FUNCTION public.cancel_msg_reply(p_reply uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.msg_replies; t public.msg_threads; v_reason text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply;
  IF r.id IS NULL OR NOT app.msg_can_read_thread(r.thread_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'reply'); END IF;
  t := app.msg_thread_for(r.thread_id, app.msg_triage_roles());
  v_reason := app.msg_note(p_reason, true);
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply FOR UPDATE;
  IF r.status NOT IN ('draft','pending_approval','approved','rejected','send_failed') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'reply_locked'); END IF;
  UPDATE public.msg_replies x SET status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = v_reason
   WHERE x.id = r.id RETURNING * INTO r;
  -- review fix: a cancellation is final for the send path — no queued / unknown send job of this reply survives it
  UPDATE public.msg_jobs j SET status = 'cancelled', finished_at = now(), locked_by = NULL, locked_until = NULL,
         last_error_code = 'reply_cancelled', last_error_message = 'the reply was cancelled'
   WHERE j.reply_id = r.id AND j.kind = 'send' AND j.status IN ('queued','unknown');
  RETURN app.msg_reply_json(r);
END $$;

-- decide_msg_reply(p_reply, p_version, approve|reject, p_note, p_sensitive_ack): four-eyes, level, sensitive ack, sharing re-check
CREATE OR REPLACE FUNCTION public.decide_msg_reply(p_reply uuid, p_version uuid, p_decision text, p_note text DEFAULT NULL,
  p_sensitive_ack boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.msg_replies; t public.msg_threads; v public.msg_reply_versions; v_level text; v_note text; v_author uuid; e jsonb;
        v_chk jsonb; v_sens boolean; a public.msg_reply_approvals;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply;
  IF r.id IS NULL OR NOT app.msg_can_read_thread(r.thread_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'reply'); END IF;
  t := app.msg_thread_for(r.thread_id, app.msg_approve_roles());
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply FOR UPDATE;
  IF p_decision IS NULL OR p_decision NOT IN ('approve','reject') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_level := app.msg_effective_level(t.org_id, t.id, coalesce(r.category, t.category));
  IF NOT app.has_branch_role(t.org_id, t.branch_id, app.msg_level_roles(v_level)) THEN PERFORM app.fin_fail('MRS_FORBIDDEN', 'role', v_level); END IF;
  IF r.status <> 'pending_approval' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_pending'); END IF;
  IF p_version IS DISTINCT FROM r.current_version_id THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'approval_stale'); END IF;
  SELECT * INTO v FROM public.msg_reply_versions x WHERE x.id = r.current_version_id;
  -- G6b-4: never the author of the version (an AI version counts its requester) nor its submitter
  v_author := coalesce(v.author_id, v.requested_by);
  IF auth.uid() = v_author OR auth.uid() = r.submitted_by THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'four_eyes'); END IF;
  -- review fix: nor anyone who authored / requested ANY version of the reply, or created it (a no-op re-save by a second user
  -- never launders authorship, and nobody approves text they wrote under someone else's attachment edit)
  IF auth.uid() = r.created_by OR EXISTS (SELECT 1 FROM public.msg_reply_versions x WHERE x.reply_id = r.id
                                             AND (x.author_id = auth.uid() OR x.requested_by = auth.uid())) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'four_eyes');
  END IF;
  v_note := app.msg_note(p_note, p_decision = 'reject' OR coalesce(p_sensitive_ack, false));
  v_sens := EXISTS (SELECT 1 FROM jsonb_array_elements(v.attachments) x WHERE (x ->> 'sensitive')::boolean);
  IF p_decision = 'approve' THEN
    IF v_sens AND NOT coalesce(p_sensitive_ack, false) THEN PERFORM app.fail('MRS_FORBIDDEN', 'sensitive_ack'); END IF;
    IF NOT app.msg_facts_ok(t, v.to_addresses, v.cc_addresses, v.used_facts) THEN
      PERFORM app.fin_fail('MRS_FORBIDDEN', 'recipient_not_authorized', 'restricted_facts');
    END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(v.attachments) x LOOP
      v_chk := app.msg_share_check(t, v.to_addresses, v.cc_addresses, (e ->> 'document_id')::uuid);
      IF NOT (v_chk ->> 'ok')::boolean THEN
        PERFORM app.fin_fail('MRS_FORBIDDEN', 'recipient_not_authorized', (SELECT string_agg(x, ',') FROM jsonb_array_elements_text(v_chk -> 'reasons') x));
      END IF;
    END LOOP;
  END IF;
  INSERT INTO public.msg_reply_approvals (org_id, reply_id, version_id, content_sha256, decision, level, sensitive_ack, actor, note)
  VALUES (r.org_id, r.id, v.id, v.content_sha256, p_decision, v_level, coalesce(p_sensitive_ack, false) AND p_decision = 'approve', auth.uid(), v_note)
  RETURNING * INTO a;
  UPDATE public.msg_replies x SET status = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
         approved_version_id = CASE WHEN p_decision = 'approve' THEN v.id ELSE NULL END
   WHERE x.id = r.id RETURNING * INTO r;
  PERFORM app.msg_event(t.org_id, t.transaction_id, CASE WHEN p_decision = 'approve' THEN 'reply_approved' ELSE 'reply_rejected' END, 'reply', r.id,
                        jsonb_build_object('thread_id', t.id, 'category', r.category));
  RETURN app.msg_reply_json(r) || jsonb_build_object('approval', to_jsonb(a));
END $$;

-- WhatsApp 24-hour window (G6b-14)
CREATE OR REPLACE FUNCTION app.msg_wa_window_open(t public.msg_threads) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.kind <> 'whatsapp' OR coalesce((SELECT max(least(coalesce(m.sent_at, m.received_at), m.received_at)) FROM public.msg_messages m
                                            WHERE m.thread_id = t.id AND m.direction = 'inbound' AND m.from_address_norm = t.counterpart_address_norm)
                                          >= now() - interval '24 hours', false)
$$;

-- review fix (privacy): a version whose text used restricted facts (§17) may go only to recipients that are ALL verified and
-- authorized for the transaction and topic (to + cc); public facts / template words need nothing
CREATE OR REPLACE FUNCTION app.msg_facts_ok(t public.msg_threads, p_to jsonb, p_cc jsonb, p_used text[]) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE e jsonb; v_info jsonb; v_n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM unnest(coalesce(p_used, '{}'::text[])) k
                  WHERE k NOT IN ('tx_ref','operational_status_label','org_name','signature','today','counterpart_name')) THEN
    RETURN true;
  END IF;
  IF t.transaction_id IS NULL THEN RETURN false; END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(p_to, '[]'::jsonb) || coalesce(p_cc, '[]'::jsonb)) x LOOP
    v_n := v_n + 1;
    v_info := app.msg_recipient_info(t.org_id, t.kind, e ->> 'address_norm', t.transaction_id, t.category);
    IF NOT (coalesce((v_info ->> 'verified')::boolean, false) AND coalesce((v_info ->> 'authorized')::boolean, false)) THEN RETURN false; END IF;
  END LOOP;
  RETURN v_n > 0;
END $$;
-- review fix (unauthorized send): every check a send must pass, shared by send_msg_reply, retry_msg_send,
-- resolve_msg_send_unknown (confirmed_not_sent) and the send claim. NULL = ok, else {code, detail, hint}.
CREATE OR REPLACE FUNCTION app.msg_send_problem(t public.msg_threads, p_channel uuid, p_reply uuid, p_version uuid, p_approval uuid,
  p_to jsonb, p_cc jsonb, p_att jsonb, p_channel_checks boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.msg_replies; v public.msg_reply_versions; a public.msg_reply_approvals; c public.msg_channels; e jsonb; v_chk jsonb;
BEGIN
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply;
  SELECT * INTO v FROM public.msg_reply_versions x WHERE x.id = p_version AND x.reply_id = p_reply;
  SELECT * INTO a FROM public.msg_reply_approvals x WHERE x.id = p_approval AND x.version_id = p_version;
  IF r.id IS NULL OR v.id IS NULL OR r.approved_version_id IS DISTINCT FROM v.id THEN
    RETURN jsonb_build_object('code', 'MRS_BAD_TRANSITION', 'detail', 'approval_stale');
  END IF;
  -- the approval is an approve of exactly this content, and still the latest decision on this version
  IF a.id IS NULL OR a.decision <> 'approve' OR a.content_sha256 IS DISTINCT FROM v.content_sha256
     OR EXISTS (SELECT 1 FROM public.msg_reply_approvals y WHERE y.version_id = v.id AND (y.created_at, y.id) > (a.created_at, a.id)) THEN
    RETURN jsonb_build_object('code', 'MRS_BAD_TRANSITION', 'detail', 'not_approved');
  END IF;
  IF p_channel_checks THEN
    SELECT * INTO c FROM public.msg_channels x WHERE x.id = p_channel;
    IF c.status IS DISTINCT FROM 'connected' THEN RETURN jsonb_build_object('code', 'MRS_BAD_TRANSITION', 'detail', 'channel_not_connected'); END IF;
    IF NOT coalesce(c.send_enabled, false) THEN RETURN jsonb_build_object('code', 'MRS_BAD_TRANSITION', 'detail', 'channel_disabled'); END IF;
  END IF;
  IF NOT app.msg_wa_window_open(t) THEN RETURN jsonb_build_object('code', 'MRS_BAD_TRANSITION', 'detail', 'wa_window_closed'); END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(p_att, '[]'::jsonb)) x LOOP
    v_chk := app.msg_share_check(t, p_to, p_cc, (e ->> 'document_id')::uuid);
    IF NOT (v_chk ->> 'ok')::boolean THEN
      RETURN jsonb_build_object('code', 'MRS_FORBIDDEN', 'detail', 'recipient_not_authorized',
                                'hint', (SELECT string_agg(x, ',') FROM jsonb_array_elements_text(v_chk -> 'reasons') x));
    END IF;
  END LOOP;
  IF NOT app.msg_facts_ok(t, p_to, p_cc, v.used_facts) THEN
    RETURN jsonb_build_object('code', 'MRS_FORBIDDEN', 'detail', 'recipient_not_authorized', 'hint', 'restricted_facts');
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION app.msg_raise_problem(p jsonb) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL THEN RETURN; END IF;
  IF p ? 'hint' THEN PERFORM app.fin_fail(p ->> 'code', p ->> 'detail', p ->> 'hint'); END IF;
  PERFORM app.fail(p ->> 'code', p ->> 'detail');
END $$;

-- send_msg_reply(p_reply, p_idem_key) → {outbound, job, deduplicated}: approval and send are two facts by two RPCs
CREATE OR REPLACE FUNCTION public.send_msg_reply(p_reply uuid, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.msg_replies; t public.msg_threads; v public.msg_reply_versions; a public.msg_reply_approvals; c public.msg_channels;
        o public.msg_outbound; v_replay jsonb; v_job jsonb; e jsonb; v_chk jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply;
  IF r.id IS NULL OR NOT app.msg_can_read_thread(r.thread_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'reply'); END IF;
  t := app.msg_thread_for(r.thread_id, app.msg_send_roles());
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = p_reply FOR UPDATE;
  v_replay := app.idem_begin('send_msg_reply', p_idem_key, jsonb_build_object('reply', p_reply), t.org_id);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  -- one outbound per approved version: a repeat returns the same row
  SELECT * INTO o FROM public.msg_outbound x WHERE x.reply_version_id = r.approved_version_id;
  IF o.id IS NOT NULL THEN
    RETURN app.idem_finish('send_msg_reply', p_idem_key, jsonb_build_object('outbound', to_jsonb(o), 'deduplicated', true,
             'job', (SELECT app.msg_job_json(j) FROM public.msg_jobs j WHERE j.outbound_id = o.id ORDER BY j.created_at DESC, j.id DESC LIMIT 1)));
  END IF;
  IF r.status <> 'approved' OR r.approved_version_id IS NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_approved'); END IF;
  IF r.approved_version_id IS DISTINCT FROM r.current_version_id THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'approval_stale'); END IF;
  SELECT * INTO v FROM public.msg_reply_versions x WHERE x.id = r.approved_version_id;
  SELECT * INTO a FROM public.msg_reply_approvals x
   WHERE x.version_id = v.id AND x.decision = 'approve' AND x.content_sha256 = v.content_sha256
   ORDER BY x.created_at DESC, x.id DESC LIMIT 1;
  IF a.id IS NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_approved'); END IF;
  SELECT * INTO c FROM public.msg_channels x WHERE x.id = r.channel_id;
  PERFORM app.msg_raise_problem(app.msg_send_problem(t, c.id, r.id, v.id, a.id, v.to_addresses, v.cc_addresses, v.attachments, true));
  INSERT INTO public.msg_outbound (org_id, reply_id, reply_version_id, approval_id, thread_id, channel_id, provider_request_id, from_address_norm,
                                   to_addresses, cc_addresses, subject, body_text, attachments, content_sha256, requested_by)
  VALUES (r.org_id, r.id, v.id, a.id, t.id, c.id, 'MRSO-0000000000000000', c.address_norm, v.to_addresses, v.cc_addresses, v.subject, v.body_text,
          v.attachments, v.content_sha256, auth.uid())
  RETURNING * INTO o;
  UPDATE public.msg_replies x SET status = 'sending' WHERE x.id = r.id;
  v_job := app.msg_enqueue(t.org_id, 'send', c.id, t.id, NULL, r.id, o.id, '{}'::jsonb, auth.uid());
  PERFORM app.msg_event(t.org_id, t.transaction_id, 'reply_send_requested', 'outbound', o.id, jsonb_build_object('thread_id', t.id, 'reply_id', r.id));
  RETURN app.idem_finish('send_msg_reply', p_idem_key, jsonb_build_object('outbound', to_jsonb(o), 'job', v_job, 'deduplicated', false));
END $$;

-- retry_msg_send(p_outbound): only from failed whose last attempt recorded applied 'no'; same provider request id
CREATE OR REPLACE FUNCTION public.retry_msg_send(p_outbound uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.msg_outbound; t public.msg_threads; r public.msg_replies; v_err jsonb; v_calls jsonb; v_job jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO o FROM public.msg_outbound x WHERE x.id = p_outbound;
  IF o.id IS NULL OR NOT app.msg_can_read_thread(o.thread_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'reply'); END IF;
  t := app.msg_thread_for(o.thread_id, app.msg_send_roles());
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = o.reply_id FOR UPDATE;
  SELECT * INTO o FROM public.msg_outbound x WHERE x.id = p_outbound FOR UPDATE;
  IF o.state <> 'failed' OR o.accepted_at IS NOT NULL OR o.provider_message_id IS NOT NULL THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_retryable'); END IF;
  -- review fix: a cancelled (or otherwise moved) reply is never sent again — only a reply whose send failed
  IF r.id IS NULL OR r.status <> 'send_failed' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_retryable'); END IF;
  SELECT a.error, a.calls INTO v_err, v_calls FROM public.msg_job_attempts a JOIN public.msg_jobs j ON j.id = a.job_id
   WHERE j.outbound_id = o.id AND a.outcome IS NOT NULL ORDER BY a.finished_at DESC, a.attempt_no DESC LIMIT 1;
  IF coalesce(v_err ->> 'applied', '') <> 'no'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_calls, '[]'::jsonb)) c WHERE c ->> 'op' = 'send' AND coalesce(c ->> 'applied', 'unknown') <> 'no') THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'not_retryable');
  END IF;
  -- review fix: the send-time checks again (recipient authorization, sensitive documents, channel, WhatsApp window, approval)
  PERFORM app.msg_raise_problem(app.msg_send_problem(t, o.channel_id, o.reply_id, o.reply_version_id, o.approval_id, o.to_addresses, o.cc_addresses, o.attachments, true));
  IF EXISTS (SELECT 1 FROM public.msg_jobs j WHERE j.outbound_id = o.id AND j.status IN ('queued','running','unknown')) THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'sending');
  END IF;
  UPDATE public.msg_outbound x SET state = 'queued', failed_at = NULL WHERE x.id = o.id RETURNING * INTO o;
  UPDATE public.msg_replies x SET status = 'sending' WHERE x.id = o.reply_id AND x.status = 'send_failed';
  v_job := app.msg_enqueue(t.org_id, 'send', o.channel_id, t.id, NULL, o.reply_id, o.id, '{}'::jsonb, auth.uid());
  RETURN jsonb_build_object('outbound', to_jsonb(o), 'job', v_job);
END $$;

-- resolve_msg_send_unknown(p_outbound, confirmed_sent | confirmed_not_sent, p_note): human resolution of a lost result
CREATE OR REPLACE FUNCTION public.resolve_msg_send_unknown(p_outbound uuid, p_decision text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.msg_outbound; t public.msg_threads; r public.msg_replies; v_note text; v_job jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO o FROM public.msg_outbound x WHERE x.id = p_outbound;
  IF o.id IS NULL OR NOT app.msg_can_read_thread(o.thread_id) THEN PERFORM app.fail('MRS_NOT_FOUND', 'reply'); END IF;
  t := app.msg_thread_for(o.thread_id, app.msg_approve_roles());
  SELECT * INTO r FROM public.msg_replies x WHERE x.id = o.reply_id FOR UPDATE;
  SELECT * INTO o FROM public.msg_outbound x WHERE x.id = p_outbound FOR UPDATE;
  IF p_decision IS NULL OR p_decision NOT IN ('confirmed_sent','confirmed_not_sent') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_note := app.msg_note(p_note, true);
  IF o.state <> 'unknown' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'send_unknown'); END IF;
  IF EXISTS (SELECT 1 FROM public.msg_jobs j WHERE j.outbound_id = o.id AND j.status = 'running') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'sending'); END IF;
  -- review fix: confirmed_not_sent is a new send authorization — the reply must still await it, and every send-time check holds
  IF p_decision = 'confirmed_not_sent' THEN
    IF r.id IS NULL OR r.status <> 'send_unknown' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'send_unknown'); END IF;
    PERFORM app.msg_raise_problem(app.msg_send_problem(t, o.channel_id, o.reply_id, o.reply_version_id, o.approval_id, o.to_addresses, o.cc_addresses, o.attachments, true));
  END IF;
  UPDATE public.msg_jobs j SET status = 'cancelled', finished_at = now(), locked_by = NULL, locked_until = NULL
   WHERE j.outbound_id = o.id AND j.status IN ('queued','unknown');
  UPDATE public.msg_outbound x SET unknown_resolution = p_decision, resolved_by = auth.uid(), resolved_at = now(), resolution_note = v_note
   WHERE x.id = o.id RETURNING * INTO o;
  IF p_decision = 'confirmed_sent' THEN
    o := app.msg_outbound_accepted(o, NULL, 'accepted', now());
  ELSE
    UPDATE public.msg_outbound x SET state = 'queued' WHERE x.id = o.id RETURNING * INTO o;
    UPDATE public.msg_replies x SET status = 'sending' WHERE x.id = o.reply_id AND x.status = 'send_unknown';
    v_job := app.msg_enqueue(t.org_id, 'send', o.channel_id, t.id, NULL, o.reply_id, o.id, '{}'::jsonb, auth.uid());
  END IF;
  PERFORM app.msg_event(t.org_id, t.transaction_id, 'send_resolved', 'outbound', o.id, jsonb_build_object('thread_id', t.id, 'reply_id', o.reply_id));
  SELECT * INTO o FROM public.msg_outbound x WHERE x.id = o.id;
  RETURN jsonb_build_object('outbound', to_jsonb(o), 'job', v_job);
END $$;

-- ---------------- instruction library & templates ----------------
CREATE OR REPLACE FUNCTION app.msg_check_params(p_kind text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN p := '{}'::jsonb; END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'params'); END IF;
  CASE p_kind
    WHEN 'style' THEN
      PERFORM app.only_keys(p, ARRAY['formality','greeting','closing']);
      IF coalesce(p ->> 'formality', 'formal') NOT IN ('formal','neutral') THEN PERFORM app.fail('MRS_INVALID', 'params'); END IF;
      PERFORM app.msg_rtext(p, 'greeting', 200, 'params'); PERFORM app.msg_rtext(p, 'closing', 200, 'params');
    WHEN 'language' THEN
      PERFORM app.only_keys(p, ARRAY['default','mirror_sender']);
      IF coalesce(p ->> 'default', 'ar') NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'params'); END IF;
      PERFORM app.msg_rbool(p, 'mirror_sender', 'params');
    WHEN 'party_rule' THEN
      PERFORM app.only_keys(p, ARRAY['party_kind','cc_internal','never_discuss']);
      IF p ? 'party_kind' AND NOT app.is_code('party_kind', p ->> 'party_kind') THEN PERFORM app.fail('MRS_INVALID', 'params'); END IF;
      PERFORM app.msg_rcodes(p -> 'never_discuss', 'msg_category', 9, 'params');
      IF jsonb_typeof(coalesce(p -> 'cc_internal', '[]'::jsonb)) <> 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p -> 'cc_internal', '[]'::jsonb)) x
                     WHERE jsonb_typeof(x) <> 'string' OR (x #>> '{}') !~* '^[0-9a-f-]{36}$') THEN
        PERFORM app.fail('MRS_INVALID', 'params');
      END IF;
    WHEN 'topic_rule' THEN
      PERFORM app.only_keys(p, ARRAY['category','owner_role','max_response_hours']);
      IF NOT app.is_code('msg_category', coalesce(p ->> 'category', '')) THEN PERFORM app.fail('MRS_INVALID', 'params'); END IF;
      IF p ? 'owner_role' AND NOT ((p ->> 'owner_role') = ANY (app.msg_read_roles())) THEN PERFORM app.fail('MRS_INVALID', 'params'); END IF;
      PERFORM app.msg_rint(p, 'max_response_hours', 1, 720, 'params');
    WHEN 'approval_level' THEN
      PERFORM app.only_keys(p, ARRAY['category','level']);
      IF NOT app.is_code('msg_category', coalesce(p ->> 'category', '')) OR coalesce(p ->> 'level', '') NOT IN ('standard','finance','management') THEN
        PERFORM app.fail('MRS_INVALID', 'params');
      END IF;
    WHEN 'signature' THEN
      PERFORM app.only_keys(p, ARRAY['text_ar','text_en']);
      PERFORM app.msg_rtext(p, 'text_ar', 500, 'params'); PERFORM app.msg_rtext(p, 'text_en', 500, 'params');
    ELSE PERFORM app.fail('MRS_INVALID', 'kind');
  END CASE;
  RETURN p;
END $$;

CREATE OR REPLACE FUNCTION public.list_msg_instructions(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_kind text; v_st text; v_key text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_read_roles());
  PERFORM app.only_keys(f, ARRAY['kind','status','instruction_key']);
  v_kind := app.ptext(f, 'kind', 30); v_st := app.ptext(f, 'status', 20); v_key := app.ptext(f, 'instruction_key', 60);
  RETURN jsonb_build_object('items', coalesce((SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('author_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = i.author_id))
                                                ORDER BY i.instruction_key, i.version DESC)
      FROM public.msg_instructions i WHERE i.org_id = p_org AND (v_kind IS NULL OR i.kind = v_kind) AND (v_st IS NULL OR i.status = v_st)
        AND (v_key IS NULL OR i.instruction_key = v_key)), '[]'::jsonb),
    'approval_levels', (SELECT jsonb_object_agg(s.code, app.msg_approval_level(p_org, s.code)) FROM public.status_labels s WHERE s.domain = 'msg_category'),
    'can', jsonb_build_object('edit', app.has_role(p_org, app.msg_lib_roles()), 'review', app.has_role(p_org, app.msg_approve_roles())));
END $$;

CREATE OR REPLACE FUNCTION public.save_msg_instruction(p_org uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_replay jsonb; v_key text; v_kind text; v_scope text; v_lang text; v_prev public.msg_instructions; i public.msg_instructions; v_params jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_lib_roles());
  PERFORM app.only_keys(p_payload, ARRAY['instruction_key','kind','scope','scope_value','lang','body','params']);
  v_replay := app.idem_begin('save_msg_instruction', p_idem_key, jsonb_build_object('org', p_org, 'p', p_payload), p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_key := lower(app.ptext(p_payload, 'instruction_key', 60, true));
  IF v_key !~ '^[a-z0-9_.-]{1,60}$' THEN PERFORM app.fail('MRS_INVALID', 'instruction_key'); END IF;
  v_kind := app.ptext(p_payload, 'kind', 30, true);
  IF NOT app.is_code('msg_instruction_kind', v_kind) THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  SELECT * INTO v_prev FROM public.msg_instructions x WHERE x.org_id = p_org AND x.instruction_key = v_key ORDER BY x.version DESC LIMIT 1 FOR UPDATE;
  IF v_prev.id IS NOT NULL AND v_prev.kind <> v_kind THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  v_scope := coalesce(app.ptext(p_payload, 'scope', 20), 'all');
  IF v_scope NOT IN ('all','party_kind','contact','category') THEN PERFORM app.fail('MRS_INVALID', 'scope'); END IF;
  v_lang := coalesce(app.ptext(p_payload, 'lang', 3), 'any');
  IF v_lang NOT IN ('ar','en','any') THEN PERFORM app.fail('MRS_INVALID', 'lang'); END IF;
  v_params := app.msg_check_params(v_kind, p_payload -> 'params');
  INSERT INTO public.msg_instructions (org_id, instruction_key, version, kind, scope, scope_value, lang, body, params, author_id, supersedes_id)
  VALUES (p_org, v_key, coalesce(v_prev.version, 0) + 1, v_kind, v_scope, app.ptext(p_payload, 'scope_value', 60), v_lang,
          app.ptext(p_payload, 'body', 2000), v_params, auth.uid(), v_prev.id)
  RETURNING * INTO i;
  RETURN app.idem_finish('save_msg_instruction', p_idem_key, to_jsonb(i));
END $$;

CREATE OR REPLACE FUNCTION public.review_msg_instruction(p_id uuid, p_decision text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE i public.msg_instructions; v_note text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO i FROM public.msg_instructions x WHERE x.id = p_id;
  IF i.id IS NULL OR NOT app.has_role(i.org_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'instruction'); END IF;
  PERFORM app.msg_gate(i.org_id, app.msg_approve_roles());
  IF p_decision IS NULL OR p_decision NOT IN ('approve','retire') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_note := app.msg_note(p_note, p_decision = 'retire');
  SELECT * INTO i FROM public.msg_instructions x WHERE x.id = p_id FOR UPDATE;
  IF p_decision = 'approve' THEN
    IF i.status <> 'draft' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_draft'); END IF;
    IF i.author_id = auth.uid() THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'four_eyes'); END IF;
    UPDATE public.msg_instructions x SET status = 'retired', reviewed_by = auth.uid(), reviewed_at = now(), review_note = coalesce(x.review_note, 'superseded')
     WHERE x.org_id = i.org_id AND x.instruction_key = i.instruction_key AND x.status = 'approved' AND x.id <> i.id;
    UPDATE public.msg_instructions x SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note
     WHERE x.id = i.id RETURNING * INTO i;
  ELSE
    IF i.status = 'retired' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'retired'); END IF;
    UPDATE public.msg_instructions x SET status = 'retired', reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note
     WHERE x.id = i.id RETURNING * INTO i;
  END IF;
  RETURN to_jsonb(i);
END $$;

CREATE OR REPLACE FUNCTION public.list_msg_templates(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_key text; v_lang text; v_st text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_read_roles());
  PERFORM app.only_keys(f, ARRAY['template_key','lang','status']);
  v_key := app.ptext(f, 'template_key', 40); v_lang := app.ptext(f, 'lang', 2); v_st := app.ptext(f, 'status', 20);
  RETURN jsonb_build_object('items', coalesce((SELECT jsonb_agg(to_jsonb(x) || jsonb_build_object('author_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = x.author_id))
                                                ORDER BY x.template_key, x.lang, x.version DESC)
      FROM public.msg_templates x WHERE x.org_id = p_org AND (v_key IS NULL OR x.template_key = v_key) AND (v_lang IS NULL OR x.lang = v_lang)
        AND (v_st IS NULL OR x.status = v_st)), '[]'::jsonb),
    'builtin', (SELECT jsonb_agg(jsonb_build_object('template_key', d.template_key, 'lang', d.lang, 'subject_tpl', d.subject_tpl, 'body_tpl', d.body_tpl,
                                                    'status', 'builtin') ORDER BY d.template_key, d.lang) FROM app.msg_default_templates() d),
    'placeholders', to_jsonb(app.msg_placeholders()),
    'can', jsonb_build_object('edit', app.has_role(p_org, app.msg_lib_roles()), 'review', app.has_role(p_org, app.msg_approve_roles()),
                              'seed', app.has_role(p_org, app.msg_admin_roles())));
END $$;

CREATE OR REPLACE FUNCTION public.save_msg_template(p_org uuid, p_payload jsonb, p_idem_key uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_replay jsonb; v_key text; v_lang text; v_op text; v_cat text; v_pk text[]; v_subj text; v_body text; v_ph text[];
        v_prev public.msg_templates; x public.msg_templates;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_lib_roles());
  PERFORM app.only_keys(p_payload, ARRAY['template_key','lang','party_kinds','operation','category','subject_tpl','body_tpl']);
  v_replay := app.idem_begin('save_msg_template', p_idem_key, jsonb_build_object('org', p_org, 'p', p_payload), p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_key := app.ptext(p_payload, 'template_key', 40, true);
  IF NOT app.is_code('msg_template_key', v_key) THEN PERFORM app.fail('MRS_INVALID', 'template_key'); END IF;
  v_lang := app.ptext(p_payload, 'lang', 2, true);
  IF v_lang NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'lang'); END IF;
  v_op := coalesce(app.ptext(p_payload, 'operation', 10), 'any');
  IF v_op NOT IN ('import','export','any') THEN PERFORM app.fail('MRS_INVALID', 'operation'); END IF;
  v_cat := app.ptext(p_payload, 'category', 30);
  IF v_cat IS NOT NULL AND NOT app.is_code('msg_category', v_cat) THEN PERFORM app.fail('MRS_INVALID', 'category'); END IF;
  v_pk := app.msg_rcodes(p_payload -> 'party_kinds', NULL, 8, 'party_kinds');
  IF EXISTS (SELECT 1 FROM unnest(v_pk) k WHERE k <> 'client' AND NOT app.is_code('party_kind', k)) THEN PERFORM app.fail('MRS_INVALID', 'party_kinds'); END IF;
  v_subj := app.ptext(p_payload, 'subject_tpl', 300);
  IF jsonb_typeof(p_payload -> 'body_tpl') IS DISTINCT FROM 'string' OR btrim(p_payload ->> 'body_tpl') = '' THEN PERFORM app.fail('MRS_REQUIRED', 'body'); END IF;
  v_body := p_payload ->> 'body_tpl';
  IF char_length(v_body) > 5000 THEN PERFORM app.fail('MRS_TOO_LONG', 'body_tpl'); END IF;
  v_ph := app.msg_tpl_placeholders(v_subj, v_body);
  SELECT * INTO v_prev FROM public.msg_templates t WHERE t.org_id = p_org AND t.template_key = v_key AND t.lang = v_lang ORDER BY t.version DESC LIMIT 1 FOR UPDATE;
  INSERT INTO public.msg_templates (org_id, template_key, version, lang, party_kinds, operation, category, subject_tpl, body_tpl, placeholders, author_id, supersedes_id)
  VALUES (p_org, v_key, coalesce(v_prev.version, 0) + 1, v_lang, v_pk, v_op, v_cat, v_subj, v_body, v_ph, auth.uid(), v_prev.id)
  RETURNING * INTO x;
  RETURN app.idem_finish('save_msg_template', p_idem_key, to_jsonb(x));
END $$;

CREATE OR REPLACE FUNCTION public.review_msg_template(p_id uuid, p_decision text, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.msg_templates; v_note text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO x FROM public.msg_templates t WHERE t.id = p_id;
  IF x.id IS NULL OR NOT app.has_role(x.org_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'template'); END IF;
  PERFORM app.msg_gate(x.org_id, app.msg_approve_roles());
  IF p_decision IS NULL OR p_decision NOT IN ('approve','retire') THEN PERFORM app.fail('MRS_INVALID', 'decision'); END IF;
  v_note := app.msg_note(p_note, p_decision = 'retire');
  SELECT * INTO x FROM public.msg_templates t WHERE t.id = p_id FOR UPDATE;
  IF p_decision = 'approve' THEN
    IF x.status <> 'draft' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_draft'); END IF;
    IF x.author_id = auth.uid() THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'four_eyes'); END IF;
    UPDATE public.msg_templates t SET status = 'retired', reviewed_by = auth.uid(), reviewed_at = now(), review_note = coalesce(t.review_note, 'superseded')
     WHERE t.org_id = x.org_id AND t.template_key = x.template_key AND t.lang = x.lang AND t.status = 'approved' AND t.id <> x.id;
    UPDATE public.msg_templates t SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note
     WHERE t.id = x.id RETURNING * INTO x;
  ELSE
    IF x.status = 'retired' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'retired'); END IF;
    UPDATE public.msg_templates t SET status = 'retired', reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note
     WHERE t.id = x.id RETURNING * INTO x;
  END IF;
  RETURN to_jsonb(x);
END $$;

-- seed_msg_templates(p_org) → {inserted}: the built-in defaults as draft versions (idempotent by key + lang)
CREATE OR REPLACE FUNCTION public.seed_msg_templates(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_admin_roles());
  INSERT INTO public.msg_templates (org_id, template_key, version, lang, party_kinds, operation, category, subject_tpl, body_tpl, placeholders, author_id)
  SELECT p_org, d.template_key, 1, d.lang, d.party_kinds, 'any', d.category, d.subject_tpl, d.body_tpl,
         app.msg_tpl_placeholders(d.subject_tpl, d.body_tpl), auth.uid()
    FROM app.msg_default_templates() d
   WHERE NOT EXISTS (SELECT 1 FROM public.msg_templates t WHERE t.org_id = p_org AND t.template_key = d.template_key AND t.lang = d.lang);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('inserted', v_n);
END $$;

-- ---------------- auto-reply policies (disabled in v1) ----------------
CREATE OR REPLACE FUNCTION public.list_msg_auto_reply_policies(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_read_roles());
  RETURN jsonb_build_object('items', (SELECT jsonb_agg(coalesce(to_jsonb(p) || jsonb_build_object('exists', true),
                                         jsonb_build_object('id', NULL, 'org_id', p_org, 'kind', s.code, 'enabled', false, 'allowed_categories', '[]'::jsonb,
                                                            'template_key', NULL, 'conditions', '{"verified_sender_only": true, "business_hours_only": true}'::jsonb,
                                                            'note', NULL, 'exists', false)) ORDER BY s.sort)
                                        FROM public.status_labels s LEFT JOIN public.msg_auto_reply_policies p ON p.org_id = p_org AND p.kind = s.code
                                       WHERE s.domain = 'msg_auto_reply_kind'),
    'enabled_v1', false, 'limits', jsonb_build_array('no_financial_commitment','no_legal_commitment','no_documents'),
    'can', jsonb_build_object('admin', app.has_role(p_org, app.msg_admin_roles())));
END $$;

CREATE OR REPLACE FUNCTION public.save_msg_auto_reply_policy(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind text; v_cats text[]; v_tpl text; v_cond jsonb; p public.msg_auto_reply_policies;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_admin_roles());
  PERFORM app.only_keys(p_payload, ARRAY['kind','enabled','allowed_categories','template_key','conditions','note']);
  IF coalesce(app.msg_rbool(p_payload, 'enabled'), false) THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'auto_reply_disabled_v1'); END IF;
  v_kind := app.ptext(p_payload, 'kind', 30, true);
  IF NOT app.is_code('msg_auto_reply_kind', v_kind) THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  v_cats := app.msg_rcodes(p_payload -> 'allowed_categories', 'msg_category', 9, 'allowed_categories');
  v_tpl := app.ptext(p_payload, 'template_key', 40);
  IF v_tpl IS NOT NULL AND NOT app.is_code('msg_template_key', v_tpl) THEN PERFORM app.fail('MRS_INVALID', 'template_key'); END IF;
  v_cond := coalesce(p_payload -> 'conditions', '{"verified_sender_only": true, "business_hours_only": true}'::jsonb);
  IF jsonb_typeof(v_cond) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'conditions'); END IF;
  PERFORM app.only_keys(v_cond, ARRAY['verified_sender_only','business_hours_only']);
  IF EXISTS (SELECT 1 FROM jsonb_each(v_cond) e WHERE jsonb_typeof(e.value) <> 'boolean') THEN PERFORM app.fail('MRS_INVALID', 'conditions'); END IF;
  INSERT INTO public.msg_auto_reply_policies (org_id, kind, enabled, allowed_categories, template_key, conditions, note, updated_by)
  VALUES (p_org, v_kind, false, v_cats, v_tpl, v_cond, app.ptext(p_payload, 'note', 1000), auth.uid())
  ON CONFLICT (org_id, kind) DO UPDATE SET allowed_categories = EXCLUDED.allowed_categories, template_key = EXCLUDED.template_key,
         conditions = EXCLUDED.conditions, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by
  RETURNING * INTO p;
  RETURN to_jsonb(p);
END $$;

-- ---------------- transaction section, jobs, retention, AI usage ----------------
CREATE OR REPLACE FUNCTION public.tx_messages(p_tx uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.transactions;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO x FROM public.transactions t WHERE t.id = p_tx;
  IF x.id IS NULL OR NOT app.has_branch_role(x.org_id, x.branch_id, app.msg_read_roles()) THEN PERFORM app.fail('MRS_NOT_FOUND', 'transaction'); END IF;
  RETURN (SELECT jsonb_build_object(
      'threads', coalesce(jsonb_agg(app.msg_thread_json(t) || jsonb_build_object(
                    'basis', (SELECT jsonb_build_object('action', l.action, 'method', l.method, 'rule', l.basis ->> 'rule', 'score', l.basis -> 'score',
                                                        'signal_kinds', (SELECT jsonb_agg(DISTINCT s ->> 'kind') FROM jsonb_array_elements(coalesce(l.basis -> 'signals', '[]'::jsonb)) s),
                                                        'at', l.created_at)
                                FROM public.msg_thread_links l WHERE l.thread_id = t.id AND l.transaction_id = x.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1))
                  ORDER BY t.last_message_at DESC NULLS LAST, t.id), '[]'::jsonb),
      'counts', jsonb_build_object('threads', count(*)::int, 'open', count(*) FILTER (WHERE t.status NOT IN ('resolved','spam'))::int))
    FROM public.msg_threads t
   WHERE t.transaction_id = x.id AND app.has_branch_role(t.org_id, t.branch_id, app.msg_read_roles()));
END $$;

CREATE OR REPLACE FUNCTION public.list_msg_jobs(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_st text; v_kind text; v_ch uuid; v_limit int; v_offset int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_read_roles());
  PERFORM app.only_keys(f, ARRAY['status','kind','channel_id','limit','offset']);
  v_st := app.ptext(f, 'status', 20); v_kind := app.ptext(f, 'kind', 20); v_ch := app.puuid(f, 'channel_id');
  IF v_st IS NOT NULL AND NOT app.is_code('msg_job_status', v_st) THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
  IF v_kind IS NOT NULL AND NOT app.is_code('msg_job_kind', v_kind) THEN PERFORM app.fail('MRS_INVALID', 'kind'); END IF;
  v_limit := app.rpt_limit(f, 200, 50); v_offset := app.rpt_offset(f);
  RETURN (SELECT jsonb_build_object('items', coalesce(jsonb_agg(app.msg_job_json(j.x) ORDER BY j.rn) FILTER (WHERE j.rn > v_offset AND j.rn <= v_offset + v_limit), '[]'::jsonb),
                                    'total', count(*)::int, 'worker_deployed', false)
            FROM (SELECT x AS x, row_number() OVER (ORDER BY x.created_at DESC, x.id) rn FROM public.msg_jobs x
                   WHERE x.org_id = p_org AND app.msg_can_read_job(x) AND (v_st IS NULL OR x.status = v_st) AND (v_kind IS NULL OR x.kind = v_kind)
                     AND (v_ch IS NULL OR x.channel_id = v_ch)) j);
END $$;

-- retry_msg_job(p_job): failed | dead; msg_admin for channel jobs, msg_triage for thread jobs; never for send (retry_msg_send)
CREATE OR REPLACE FUNCTION public.retry_msg_job(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.msg_jobs; v_live public.msg_jobs;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO j FROM public.msg_jobs x WHERE x.id = p_job;
  IF j.id IS NULL OR NOT app.msg_can_read_job(j) THEN PERFORM app.fail('MRS_NOT_FOUND', 'job'); END IF;
  IF j.kind = 'send' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_retryable'); END IF;
  IF j.thread_id IS NOT NULL THEN
    PERFORM app.msg_thread_for(j.thread_id, app.msg_triage_roles());
  ELSIF NOT app.has_role(j.org_id, app.msg_admin_roles()) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'role');
  END IF;
  SELECT * INTO j FROM public.msg_jobs x WHERE x.id = p_job FOR UPDATE;
  IF j.status NOT IN ('failed','dead') THEN PERFORM app.fail('MRS_BAD_TRANSITION', j.status); END IF;
  SELECT * INTO v_live FROM public.msg_jobs x WHERE x.org_id = j.org_id AND x.dedupe_key = j.dedupe_key AND x.status IN ('queued','running','unknown');
  IF v_live.id IS NOT NULL THEN RETURN app.msg_job_json(v_live) || jsonb_build_object('deduplicated', true); END IF;
  UPDATE public.msg_jobs x SET status = 'queued', max_attempts = x.attempts + 3, next_run_at = now(), finished_at = NULL, locked_by = NULL,
         locked_until = NULL, requested_by = auth.uid()
   WHERE x.id = j.id RETURNING * INTO j;
  RETURN app.msg_job_json(j) || jsonb_build_object('deduplicated', false);
END $$;

-- msg_retention_preview(p_org) → counts older than the retention limit (no purge path exists, G6b-12)
CREATE OR REPLACE FUNCTION public.msg_retention_preview(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_days int; v_before timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_admin_roles());
  v_days := (app.msg_settings_of(p_org)).retention_days;
  v_before := now() - make_interval(days => v_days);
  RETURN jsonb_build_object('retention_days', v_days, 'older_than', v_before, 'purge_enabled', false,
    'messages', (SELECT count(*)::int FROM public.msg_messages m WHERE m.org_id = p_org AND m.received_at < v_before),
    'attachments', (SELECT count(*)::int FROM public.msg_attachments a WHERE a.org_id = p_org AND a.created_at < v_before),
    'threads', (SELECT count(*)::int FROM public.msg_threads t WHERE t.org_id = p_org AND coalesce(t.last_message_at, t.created_at) < v_before));
END $$;

-- msg_ai_usage(p_org, {from, to}) → runs and estimates by provider (rule_mock = 0)
CREATE OR REPLACE FUNCTION public.msg_ai_usage(p_org uuid, p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); v_r date[];
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  PERFORM app.msg_gate(p_org, app.msg_admin_roles());
  PERFORM app.only_keys(f, ARRAY['from','to']);
  v_r := app.rpt_range(f, 3660);
  RETURN (SELECT jsonb_build_object('runs', count(*)::int,
      'by_provider', coalesce((SELECT jsonb_object_agg(z.provider, jsonb_build_object('runs', z.n, 'input_chars', z.ic,
                                                                                    'est_tokens', z.tk, 'est_cost_usd', z.cost))
                                 FROM (SELECT r.provider, count(*)::int n, sum(r.input_chars)::bigint ic, sum(r.est_input_tokens + r.est_output_tokens)::bigint tk,
                                              sum(r.est_cost_usd) cost FROM public.msg_ai_runs r
                                        WHERE r.org_id = p_org AND (v_r[1] IS NULL OR r.created_at >= app.rpt_ts(v_r[1]))
                                          AND (v_r[2] IS NULL OR r.created_at < app.rpt_ts(v_r[2] + 1)) GROUP BY r.provider) z), '{}'::jsonb),
      'budget_usd', (app.msg_settings_of(p_org)).ai_monthly_budget_usd,
      'month_to_date_usd', app.msg_month_cost(p_org))
    FROM public.msg_ai_runs r
   WHERE r.org_id = p_org AND (v_r[1] IS NULL OR r.created_at >= app.rpt_ts(v_r[1])) AND (v_r[2] IS NULL OR r.created_at < app.rpt_ts(v_r[2] + 1)));
END $$;

-- ---------------------------------------------------------------------
-- 5. worker / ingest RPCs (service_role only)
-- ---------------------------------------------------------------------
-- logged calls: redacted (G5 rules), message text / addresses / names masked (bodies → {chars, sha256}), ≤ 50, ≤ 256 KiB
CREATE OR REPLACE FUNCTION app.msg_mask(p jsonb, p_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE r jsonb; k text; v jsonb; s text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(p)
    WHEN 'object' THEN
      r := '{}'::jsonb;
      FOR k, v IN SELECT e.key, e.value FROM jsonb_each(p) e LOOP
        r := r || jsonb_build_object(k, app.msg_mask(v, k));
      END LOOP;
      RETURN r;
    WHEN 'array' THEN
      RETURN coalesce((SELECT jsonb_agg(app.msg_mask(x.e, p_key) ORDER BY x.o) FROM jsonb_array_elements(p) WITH ORDINALITY x(e, o)), '[]'::jsonb);
    WHEN 'string' THEN
      s := p #>> '{}';
      IF p_key ~* '^(body|body_text|text|html|subject|extracted_text|raw|file_name|filename|name|from_name|display_name|address|address_norm|from|to|cc|wa_to|email|phone|summary_ar|summary_en|preview)$' THEN
        RETURN jsonb_build_object('chars', char_length(s), 'sha256', app.msg_text_hash(s));
      END IF;
      s := regexp_replace(s, '[^[:space:]@<>(),;:"]+@[^[:space:]@<>(),;:"]+', '[address]', 'g');
      s := regexp_replace(s, '(\+|00)[0-9][0-9 -]{6,}[0-9]', '[number]', 'g');
      RETURN to_jsonb(left(s, 4000));
    ELSE RETURN p;
  END CASE;
END $$;
CREATE OR REPLACE FUNCTION app.msg_calls(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' THEN RETURN '[]'::jsonb; END IF;
  SELECT coalesce(jsonb_agg(app.msg_mask(app.msg_redact(CASE WHEN jsonb_typeof(x.e) = 'object' THEN x.e ELSE jsonb_build_object('value', x.e) END)) ORDER BY x.o), '[]'::jsonb)
    INTO v FROM jsonb_array_elements(p) WITH ORDINALITY x(e, o) WHERE x.o <= 50;
  IF octet_length(v::text) > 262144 THEN
    SELECT coalesce(jsonb_agg((x.e - 'request' - 'response') || jsonb_build_object('truncated', true) ORDER BY x.o), '[]'::jsonb)
      INTO v FROM jsonb_array_elements(v) WITH ORDINALITY x(e, o);
  END IF;
  IF octet_length(v::text) > 262144 THEN v := '[]'::jsonb; END IF;
  RETURN v;
END $$;
-- error object {kind, code, message, applied} (masked, cut to the column sizes)
CREATE OR REPLACE FUNCTION app.msg_error(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'error'); END IF;
  PERFORM app.only_keys(p, ARRAY['kind','code','message','applied','http_status']);
  IF jsonb_typeof(p -> 'kind') IN ('object','array') OR jsonb_typeof(p -> 'code') IN ('object','array')
     OR jsonb_typeof(p -> 'message') IN ('object','array') THEN PERFORM app.fail('MRS_INVALID', 'error'); END IF;
  IF p ? 'applied' AND coalesce(p ->> 'applied', 'unknown') NOT IN ('yes','no','unknown') THEN PERFORM app.fail('MRS_INVALID', 'error'); END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('kind', left(app.msg_scrub_text(p ->> 'kind'), 60), 'code', left(app.msg_scrub_text(p ->> 'code'), 60),
                                              'message', left(app.msg_mask(app.msg_redact(p -> 'message')) #>> '{}', 500),
                                              'applied', coalesce(p ->> 'applied', 'unknown')));
END $$;

-- §17 draft context (confirmed data only; restricted facts only for a verified + authorized recipient)
CREATE OR REPLACE FUNCTION app.msg_draft_context(j public.msg_jobs) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; r public.msg_replies; cv public.msg_reply_versions; x public.transactions; s public.msg_settings;
        v_key text := coalesce(j.options ->> 'template_key', 'clarification'); v_lang text := coalesce(j.options ->> 'lang', 'ar');
        v_tpl jsonb; v_to jsonb; v_rc jsonb; v_public jsonb := '{}'::jsonb; v_restricted jsonb; v_params jsonb; v_rt uuid;
BEGIN
  SELECT * INTO t FROM public.msg_threads y WHERE y.id = j.thread_id;
  s := app.msg_settings_of(t.org_id);
  IF j.reply_id IS NOT NULL THEN
    SELECT * INTO r FROM public.msg_replies y WHERE y.id = j.reply_id;
    SELECT * INTO cv FROM public.msg_reply_versions y WHERE y.id = r.current_version_id;
  END IF;
  v_rt := coalesce(r.reply_to_message_id, (j.options ->> 'reply_to_message_id')::uuid);
  -- the org's approved template for key + language, else the built-in default (shown with a warning)
  SELECT jsonb_build_object('key', m.template_key, 'version', m.version, 'lang', m.lang, 'subject_tpl', m.subject_tpl, 'body_tpl', m.body_tpl, 'status', 'approved')
    INTO v_tpl FROM public.msg_templates m WHERE m.org_id = t.org_id AND m.template_key = v_key AND m.lang = v_lang AND m.status = 'approved';
  IF v_tpl IS NULL THEN
    SELECT jsonb_build_object('key', d.template_key, 'version', 0, 'lang', d.lang, 'subject_tpl', d.subject_tpl, 'body_tpl', d.body_tpl, 'status', 'builtin')
      INTO v_tpl FROM app.msg_default_templates() d WHERE d.template_key = v_key AND d.lang = v_lang;
  END IF;
  -- typed instruction params only (the body text of an instruction never reaches the provider)
  v_params := jsonb_build_object(
    'style', coalesce((SELECT i.params FROM public.msg_instructions i WHERE i.org_id = t.org_id AND i.kind = 'style' AND i.status = 'approved'
                        AND i.lang IN ('any', v_lang) ORDER BY (i.lang = v_lang) DESC, i.reviewed_at DESC NULLS LAST LIMIT 1), '{}'::jsonb),
    'language', coalesce((SELECT i.params FROM public.msg_instructions i WHERE i.org_id = t.org_id AND i.kind = 'language' AND i.status = 'approved'
                           ORDER BY i.reviewed_at DESC NULLS LAST LIMIT 1), '{}'::jsonb),
    'signature', coalesce((SELECT CASE WHEN v_lang = 'en' THEN i.params ->> 'text_en' ELSE i.params ->> 'text_ar' END FROM public.msg_instructions i
                            WHERE i.org_id = t.org_id AND i.kind = 'signature' AND i.status = 'approved' ORDER BY i.reviewed_at DESC NULLS LAST LIMIT 1),
                          CASE WHEN v_lang = 'en' THEN s.signature_en ELSE s.signature_ar END),
    'never_discuss', coalesce((SELECT jsonb_agg(DISTINCT n) FROM public.msg_instructions i, jsonb_array_elements_text(coalesce(i.params -> 'never_discuss', '[]'::jsonb)) n
                                WHERE i.org_id = t.org_id AND i.kind = 'party_rule' AND i.status = 'approved'), '[]'::jsonb));
  -- recipient: never read from the text
  v_to := coalesce(nullif(cv.to_addresses, '[]'::jsonb), app.msg_default_to(t, v_rt));
  v_rc := app.msg_recipient_info(t.org_id, t.kind, v_to -> 0 ->> 'address_norm', t.transaction_id, t.category);
  -- review fix (privacy): EVERY recipient (to + cc) must be verified and authorized, not only the first 'to'
  SELECT v_rc || jsonb_build_object(
           'verified', coalesce(bool_and(coalesce((i ->> 'verified')::boolean, false)), false),
           'authorized', coalesce(bool_and(coalesce((i ->> 'authorized')::boolean, false)), false),
           'recipients', count(*))
    INTO v_rc
    FROM (SELECT app.msg_recipient_info(t.org_id, t.kind, ra.e ->> 'address_norm', t.transaction_id, t.category) i
            FROM jsonb_array_elements(coalesce(v_to, '[]'::jsonb) || coalesce(cv.cc_addresses, '[]'::jsonb)) ra(e)) z;
  IF t.transaction_id IS NOT NULL THEN
    SELECT * INTO x FROM public.transactions y WHERE y.id = t.transaction_id;
    v_public := jsonb_build_object('tx_ref', x.ref, 'operational_status_label',
                  (SELECT CASE WHEN v_lang = 'en' THEN l.label_en ELSE l.label_ar END FROM public.status_labels l
                    WHERE l.domain = 'operational_status' AND l.code = x.operational_status));
    IF (v_rc ->> 'verified')::boolean AND (v_rc ->> 'authorized')::boolean THEN
      v_restricted := jsonb_build_object(
        'bl_number', coalesce(x.bl_number, (SELECT b.bl_number FROM public.transaction_bls tb JOIN public.bills_of_lading b ON b.id = tb.bl_id
                                              WHERE tb.transaction_id = x.id ORDER BY tb.is_primary DESC, b.bl_number LIMIT 1),
                              (SELECT coalesce(e.corrected_value, e.normalized) FROM public.msg_extractions e
                                WHERE e.thread_id = t.id AND e.kind = 'bl_number' AND e.status IN ('confirmed','corrected') LIMIT 1)),
        'declaration_no', coalesce(x.declaration_no, (SELECT d.declaration_no FROM public.customs_declarations d
                                                       WHERE d.transaction_id = x.id AND d.status <> 'cancelled' ORDER BY d.created_at DESC LIMIT 1)),
        'container_list', coalesce((SELECT jsonb_agg(k.container_no ORDER BY k.container_no) FROM public.containers k WHERE k.transaction_id = x.id), '[]'::jsonb),
        'client_name', (SELECT CASE WHEN v_lang = 'en' THEN coalesce(c.name_en, c.name_ar) ELSE c.name_ar END FROM public.clients c WHERE c.id = x.client_id),
        'operation_label', CASE x.operation WHEN 'import' THEN CASE WHEN v_lang = 'en' THEN 'Import' ELSE 'استيراد' END
                                            WHEN 'export' THEN CASE WHEN v_lang = 'en' THEN 'Export' ELSE 'تصدير' END ELSE x.operation END,
        'appointment', (SELECT jsonb_build_object('at', pa.appointment_at,
                                                  'terminal_name', (SELECT CASE WHEN v_lang = 'en' THEN coalesce(p.name_en, p.name_ar) ELSE p.name_ar END
                                                                      FROM public.parties p WHERE p.id = pa.terminal_party_id))
                          FROM public.port_appointments pa WHERE pa.transaction_id = x.id AND pa.status = 'confirmed' AND pa.appointment_at >= now()
                         ORDER BY pa.appointment_at LIMIT 1),
        'return_deadlines', coalesce((SELECT jsonb_agg(jsonb_build_object('container_no', k.container_no, 'date', k.return_deadline) ORDER BY k.return_deadline, k.container_no)
                                       FROM public.containers k WHERE k.transaction_id = x.id AND k.return_deadline IS NOT NULL
                                         AND k.return_status NOT IN ('returned','waived')), '[]'::jsonb),
        'missing_documents', coalesce((SELECT jsonb_agg(CASE WHEN v_lang = 'en' THEN q.label_en ELSE q.label_ar END ORDER BY q.stage_sort, q.document_kind)
                                        FROM app.tx_requirements(x.id) q WHERE q.status = 'missing' AND NOT q.is_optional), '[]'::jsonb));
    END IF;
  END IF;
  RETURN jsonb_build_object('reply_id', r.id, 'thread_id', t.id, 'lang', v_lang, 'template_key', v_key, 'template', v_tpl, 'params', v_params,
    'recipient', jsonb_build_object('address_norm', v_rc ->> 'address_norm', 'contact_display_name', v_rc ->> 'contact_display_name',
                                    'verified', (v_rc ->> 'verified')::boolean, 'authorized', (v_rc ->> 'authorized')::boolean),
    'facts', jsonb_strip_nulls(jsonb_build_object('public', v_public, 'restricted', v_restricted)),
    'category', t.category,
    'org_name', (SELECT CASE WHEN v_lang = 'en' THEN coalesce(o.name_en, o.name_ar) ELSE o.name_ar END FROM public.organizations o WHERE o.id = t.org_id));
END $$;
-- fact keys a draft context offered (used_facts must be a subset)
CREATE OR REPLACE FUNCTION app.msg_fact_keys(p_facts jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(array_agg(DISTINCT k), '{}'::text[]) FROM (
    SELECT e.key k FROM jsonb_each(coalesce(p_facts -> 'public', '{}'::jsonb)) e WHERE jsonb_typeof(e.value) <> 'null'
    UNION ALL
    SELECT e.key FROM jsonb_each(coalesce(p_facts -> 'restricted', '{}'::jsonb)) e
     WHERE jsonb_typeof(e.value) <> 'null' AND e.value <> '[]'::jsonb) z
$$;

CREATE OR REPLACE FUNCTION app.msg_job_context(j public.msg_jobs, p_attempt uuid, p_prev text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.msg_channels; s public.msg_settings; v jsonb; m public.msg_messages; o public.msg_outbound; r public.msg_replies;
        rt public.msg_messages; v_text text;
BEGIN
  SELECT * INTO c FROM public.msg_channels x WHERE x.id = j.channel_id;
  s := app.msg_settings_of(j.org_id);
  v := jsonb_build_object(
    'job', jsonb_build_object('id', j.id, 'org_id', j.org_id, 'kind', j.kind, 'attempt_no', j.attempts, 'options', j.options, 'previous_status', p_prev),
    'attempt_id', p_attempt,
    'channel', jsonb_build_object('id', c.id, 'kind', c.kind, 'mode', c.mode, 'status', c.status, 'address_norm', c.address_norm,
                                  'poll_cursor', c.poll_cursor, 'status_cursor', c.status_cursor, 'capabilities', c.capabilities),
    'settings', jsonb_build_object('ai_provider', s.ai_provider, 'default_lang', s.default_lang, 'ai_monthly_budget_usd', s.ai_monthly_budget_usd,
                                   'month_to_date_usd', app.msg_month_cost(j.org_id)));
  IF j.kind = 'process' THEN
    SELECT * INTO m FROM public.msg_messages x WHERE x.id = j.message_id;
    v_text := lower(coalesce(m.subject, '') || ' ' || m.body_text || ' ' ||
                    coalesce((SELECT string_agg(coalesce(a.extracted_text, '') || ' ' || a.file_name, ' ') FROM public.msg_attachments a WHERE a.message_id = m.id), ''));
    v_text := app.to_western(v_text);
    v := v || jsonb_build_object('message', jsonb_build_object(
      'id', m.id, 'thread_id', m.thread_id, 'direction', m.direction, 'subject', m.subject, 'body_text', m.body_text,
      'sent_at', coalesce(m.sent_at, m.received_at),
      'from', jsonb_build_object('address_norm', m.from_address_norm, 'name', m.from_name),
      'to', coalesce((SELECT jsonb_agg(x ->> 'address') FROM jsonb_array_elements(m.to_addresses || m.cc_addresses) x), '[]'::jsonb),
      'participants', to_jsonb(app.msg_participants(m.thread_id) || c.address_norm),
      'directory_addresses', coalesce((SELECT jsonb_agg(DISTINCT a.address_norm) FROM public.msg_contact_addresses a
                                        WHERE a.org_id = j.org_id AND a.status = 'active'
                                          AND (position(a.address_norm IN v_text) > 0
                                               OR (a.kind = 'whatsapp' AND position(substr(a.address_norm, 2) IN regexp_replace(v_text, '[^0-9]', '', 'g')) > 0))), '[]'::jsonb),
      'attachments', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'mime_type', a.mime_type, 'extracted_text', a.extracted_text)
                                                ORDER BY a.created_at, a.id) FROM public.msg_attachments a WHERE a.message_id = m.id), '[]'::jsonb)));
  ELSIF j.kind = 'draft' THEN
    v := v || jsonb_build_object('draft', app.msg_draft_context(j));
  ELSIF j.kind = 'send' THEN
    SELECT * INTO o FROM public.msg_outbound x WHERE x.id = j.outbound_id;
    SELECT * INTO r FROM public.msg_replies x WHERE x.id = o.reply_id;
    SELECT * INTO rt FROM public.msg_messages x WHERE x.id = r.reply_to_message_id;
    v := v || jsonb_build_object('send', jsonb_build_object(
      'outbound_id', o.id, 'provider_request_id', o.provider_request_id, 'from', o.from_address_norm,
      'to', coalesce((SELECT jsonb_agg(x ->> 'address_norm') FROM jsonb_array_elements(o.to_addresses) x), '[]'::jsonb),
      'cc', coalesce((SELECT jsonb_agg(x ->> 'address_norm') FROM jsonb_array_elements(o.cc_addresses) x), '[]'::jsonb),
      'subject', o.subject, 'body_text', o.body_text,
      'in_reply_to', CASE WHEN c.kind = 'email' THEN rt.headers ->> 'message_id' END,
      'references', CASE WHEN c.kind = 'email' THEN coalesce(rt.headers -> 'references', '[]'::jsonb)
                                                    || CASE WHEN rt.headers ? 'message_id' THEN jsonb_build_array(rt.headers ->> 'message_id') ELSE '[]'::jsonb END END,
      'wa_to', CASE WHEN c.kind = 'whatsapp' THEN (SELECT t.counterpart_address_norm FROM public.msg_threads t WHERE t.id = o.thread_id) END,
      'attachments', coalesce((SELECT jsonb_agg(jsonb_build_object('document_id', d.id, 'file_name', d.original_name, 'mime_type', d.mime_type,
                                                                   'size_bytes', d.size_bytes, 'sha256', d.sha256, 'storage_bucket', d.storage_bucket,
                                                                   'storage_path', d.storage_path) ORDER BY x.o)
                                 FROM jsonb_array_elements(o.attachments) WITH ORDINALITY x(e, o)
                                 JOIN public.documents d ON d.id = (x.e ->> 'document_id')::uuid AND d.voided_at IS NULL), '[]'::jsonb)));
  END IF;
  RETURN v;
END $$;

-- a job closed at claim (live_pending channel / llm_pending provider): never sent, never processed
CREATE OR REPLACE FUNCTION app.msg_fail_job(j public.msg_jobs, p_code text, p_message text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.msg_outbound;
BEGIN
  UPDATE public.msg_jobs x SET status = 'failed', finished_at = now(), locked_by = NULL, locked_until = NULL,
         last_error_kind = 'not_configured', last_error_code = p_code, last_error_message = p_message
   WHERE x.id = j.id;
  IF j.kind = 'send' THEN
    SELECT * INTO o FROM public.msg_outbound x WHERE x.id = j.outbound_id FOR UPDATE;
    IF o.state IN ('queued','sending') THEN PERFORM app.msg_outbound_failed(o, p_code, p_message); END IF;
  END IF;
END $$;

-- msg_claim_jobs(p_worker, p_limit) → [context]; one running job per channel (lane), SKIP LOCKED
CREATE OR REPLACE FUNCTION public.msg_claim_jobs(p_worker text, p_limit int DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_j public.msg_jobs; v_chs uuid[] := '{}'; v_out jsonb := '[]'::jsonb; v_prev text; v_att uuid; c public.msg_channels;
        v_worker text := nullif(btrim(coalesce(p_worker, '')), ''); v_ai text; v_o public.msg_outbound; v_r public.msg_replies;
        v_t public.msg_threads; v_prob jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF v_worker IS NULL OR char_length(v_worker) > 80 THEN PERFORM app.fail('MRS_INVALID', 'worker'); END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN PERFORM app.fail('MRS_INVALID', 'limit'); END IF;
  FOR v_j IN SELECT j.* FROM public.msg_jobs j
              WHERE (j.status IN ('queued','unknown') AND j.next_run_at <= now()) OR (j.status = 'running' AND j.locked_until < now())
              ORDER BY j.priority, j.created_at, j.id
              FOR UPDATE SKIP LOCKED LOOP
    EXIT WHEN jsonb_array_length(v_out) >= p_limit;
    CONTINUE WHEN v_j.channel_id = ANY (v_chs);
    SELECT * INTO c FROM public.msg_channels x WHERE x.id = v_j.channel_id;
    IF c.mode = 'live_pending' THEN
      PERFORM app.msg_fail_job(v_j, 'not_configured', 'live channel adapters are not configured (G6b: mock only)');
      CONTINUE;
    END IF;
    v_ai := (app.msg_settings_of(v_j.org_id)).ai_provider;
    IF v_j.kind IN ('process','draft') AND v_ai <> 'rule_mock' THEN
      PERFORM app.msg_fail_job(v_j, 'not_configured', 'no LLM provider is configured (G6b: local rules only)');
      CONTINUE;
    END IF;
    CONTINUE WHEN v_j.kind = 'poll' AND NOT c.ingest_enabled;
    CONTINUE WHEN v_j.kind = 'send' AND (NOT c.send_enabled OR c.status IS DISTINCT FROM 'connected');
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.msg_jobs o WHERE o.channel_id = v_j.channel_id AND o.id <> v_j.id
                             AND o.status = 'running' AND o.locked_until >= now());
    IF v_j.thread_id IS NOT NULL THEN
      PERFORM 1 FROM public.msg_threads t WHERE t.id = v_j.thread_id FOR UPDATE SKIP LOCKED;
      CONTINUE WHEN NOT FOUND;
    END IF;
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(hashtextextended('marsa.msg.lane:' || v_j.channel_id::text, 0));
    -- review fix (unauthorized send): a send job goes to the worker only while its reply still awaits this send and every
    -- send-time check still holds (cancel, provider failure, revoked authorization, closed window → no adapter call)
    IF v_j.kind = 'send' THEN
      SELECT * INTO v_r FROM public.msg_replies x WHERE x.id = v_j.reply_id FOR UPDATE SKIP LOCKED;
      CONTINUE WHEN v_j.reply_id IS NOT NULL AND v_r.id IS NULL;
      SELECT * INTO v_o FROM public.msg_outbound x WHERE x.id = v_j.outbound_id FOR UPDATE SKIP LOCKED;
      CONTINUE WHEN NOT FOUND;
      SELECT * INTO v_r FROM public.msg_replies x WHERE x.id = v_o.reply_id;
      IF v_o.state NOT IN ('queued','sending','unknown') OR v_r.status IS NULL OR v_r.status NOT IN ('sending','send_unknown') THEN
        UPDATE public.msg_job_attempts a SET finished_at = clock_timestamp(), outcome = 'abandoned',
               error = jsonb_build_object('kind', 'lease', 'code', 'not_sendable', 'message', 'closed at claim: nothing more is sent', 'applied', 'unknown')
         WHERE a.job_id = v_j.id AND a.outcome IS NULL;
        UPDATE public.msg_jobs j SET status = 'cancelled', finished_at = now(), locked_by = NULL, locked_until = NULL,
               last_error_code = 'not_sendable', last_error_message = 'the outbound / reply no longer awaits this send'
         WHERE j.id = v_j.id;
        CONTINUE;
      END IF;
      SELECT * INTO v_t FROM public.msg_threads x WHERE x.id = v_o.thread_id;
      v_prob := app.msg_send_problem(v_t, v_o.channel_id, v_o.reply_id, v_o.reply_version_id, v_o.approval_id,
                                     v_o.to_addresses, v_o.cc_addresses, v_o.attachments, false);
      IF v_prob IS NOT NULL THEN
        IF v_o.state = 'unknown' OR v_j.status IN ('unknown','running') THEN
          -- the provider may already hold it: never sent again here; a human resolves (resolve re-checks too)
          UPDATE public.msg_job_attempts a SET finished_at = clock_timestamp(), outcome = 'abandoned',
                 error = jsonb_build_object('kind', 'lease', 'code', 'lease_expired', 'message', 'lease expired before completion', 'applied', 'unknown')
           WHERE a.job_id = v_j.id AND a.outcome IS NULL;
          UPDATE public.msg_jobs j SET status = 'cancelled', finished_at = now(), locked_by = NULL, locked_until = NULL,
                 last_error_code = left(v_prob ->> 'detail', 60), last_error_message = 'send re-check failed: human resolution required'
           WHERE j.id = v_j.id;
          IF v_o.state = 'sending' THEN
            UPDATE public.msg_outbound x SET state = 'unknown', last_error_code = left(v_prob ->> 'detail', 60),
                   last_error_message = 'send re-check failed after a possible send' WHERE x.id = v_o.id;
          END IF;
          UPDATE public.msg_replies x SET status = 'send_unknown' WHERE x.id = v_o.reply_id AND x.status = 'sending';
        ELSE
          -- nothing was sent: the outbound fails (applied 'no'); a later retry_msg_send re-checks again
          PERFORM app.msg_outbound_failed(v_o, left(v_prob ->> 'detail', 60), 'send re-check failed: ' || coalesce(v_prob ->> 'hint', v_prob ->> 'detail'));
          UPDATE public.msg_jobs j SET status = 'failed', attempts = j.attempts + 1, finished_at = now(), locked_by = NULL, locked_until = NULL,
                 last_error_kind = 'validation', last_error_code = left(v_prob ->> 'detail', 60), last_error_message = 'send re-check failed at claim'
           WHERE j.id = v_j.id RETURNING * INTO v_j;
          INSERT INTO public.msg_job_attempts (org_id, job_id, attempt_no, worker, adapter_mode, finished_at, outcome, calls, error)
          VALUES (v_j.org_id, v_j.id, v_j.attempts, v_worker, CASE WHEN c.mode = 'mock' THEN 'mock' ELSE 'live' END, clock_timestamp(), 'failed', '[]'::jsonb,
                  jsonb_build_object('kind', 'validation', 'code', left(v_prob ->> 'detail', 60), 'message', 'send re-check failed at claim', 'applied', 'no'));
        END IF;
        CONTINUE;
      END IF;
    END IF;
    v_chs := v_chs || v_j.channel_id;
    v_prev := v_j.status;
    IF v_j.status = 'running' THEN
      UPDATE public.msg_job_attempts a SET finished_at = clock_timestamp(), outcome = 'abandoned',
             error = jsonb_build_object('kind', 'lease', 'code', 'lease_expired', 'message', 'lease expired before completion', 'applied', 'unknown')
       WHERE a.job_id = v_j.id AND a.outcome IS NULL;
      v_prev := 'unknown';
    END IF;
    UPDATE public.msg_jobs j SET status = 'running', attempts = j.attempts + 1, locked_by = v_worker,
           locked_until = now() + interval '5 minutes', finished_at = NULL
     WHERE j.id = v_j.id RETURNING * INTO v_j;
    INSERT INTO public.msg_job_attempts (org_id, job_id, attempt_no, worker, adapter_mode)
    VALUES (v_j.org_id, v_j.id, v_j.attempts, v_worker, CASE WHEN c.mode = 'mock' THEN 'mock' ELSE 'live' END)
    RETURNING id INTO v_att;
    IF v_j.kind = 'send' THEN
      UPDATE public.msg_outbound o SET state = 'sending' WHERE o.id = v_j.outbound_id AND o.state = 'queued';
      IF EXISTS (SELECT 1 FROM public.msg_outbound o WHERE o.id = v_j.outbound_id AND o.state = 'unknown') THEN v_prev := 'unknown'; END IF;
    END IF;
    v_out := v_out || jsonb_build_array(app.msg_job_context(v_j, v_att, v_prev));
  END LOOP;
  RETURN v_out;
END $$;

-- msg_renew_lease(p_attempt) → {job_id, locked_until}: right before every adapter write (send); else MRS_BAD_TRANSITION 'lease_lost'
CREATE OR REPLACE FUNCTION public.msg_renew_lease(p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_a public.msg_job_attempts; v_j public.msg_jobs;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  SELECT * INTO v_a FROM public.msg_job_attempts a WHERE a.id = p_attempt;
  IF v_a.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'attempt'); END IF;
  SELECT * INTO v_j FROM public.msg_jobs j WHERE j.id = v_a.job_id FOR UPDATE;
  SELECT * INTO v_a FROM public.msg_job_attempts a WHERE a.id = p_attempt;
  IF v_a.outcome IS NOT NULL OR v_j.status <> 'running' OR v_j.locked_by IS DISTINCT FROM v_a.worker
     OR v_j.attempts <> v_a.attempt_no OR v_j.locked_until IS NULL OR v_j.locked_until < now() THEN
    PERFORM app.fail('MRS_BAD_TRANSITION', 'lease_lost');
  END IF;
  UPDATE public.msg_jobs j SET locked_until = now() + interval '5 minutes' WHERE j.id = v_j.id RETURNING * INTO v_j;
  RETURN jsonb_build_object('job_id', v_j.id, 'locked_until', v_j.locked_until);
END $$;

-- ---------------- completion: effects per kind ----------------
CREATE OR REPLACE FUNCTION app.msg_apply_probe(j public.msg_jobs, p_ok boolean, p_eff jsonb, p_err jsonb, p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.msg_channels; v_caps jsonb := '{}'::jsonb; k text; e jsonb;
BEGIN
  SELECT * INTO c FROM public.msg_channels x WHERE x.id = j.channel_id FOR UPDATE;
  IF p_ok THEN
    PERFORM app.only_keys(p_eff, ARRAY['capabilities','account']);
    IF jsonb_typeof(p_eff -> 'capabilities') <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'capabilities'); END IF;
    FOR k, e IN SELECT x.key, x.value FROM jsonb_each(p_eff -> 'capabilities') x LOOP
      IF NOT (k = ANY (app.msg_capability_keys())) OR jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'supported') <> 'boolean' THEN
        PERFORM app.fail('MRS_INVALID', 'capabilities');
      END IF;
      PERFORM app.only_keys(e, ARRAY['supported','evidence']);
      v_caps := v_caps || jsonb_build_object(k, jsonb_build_object('supported', e -> 'supported', 'evidence', left(app.msg_rtext(e, 'evidence', 200, 'capabilities'), 200)));
    END LOOP;
    UPDATE public.msg_channels x SET status = 'connected', capabilities = v_caps, capabilities_checked_at = now(),
           capabilities_source = CASE WHEN c.mode = 'mock' THEN 'mock' ELSE 'live' END, last_check_at = now(),
           last_error_code = NULL, last_error_message = NULL
     WHERE x.id = c.id;
  ELSIF p_final THEN
    UPDATE public.msg_channels x SET status = 'error', last_check_at = now(), last_error_code = left(p_err ->> 'code', 60),
           last_error_message = left(p_err ->> 'message', 500)
     WHERE x.id = c.id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.msg_apply_process(j public.msg_jobs, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.msg_messages; t public.msg_threads; s public.msg_settings; v_run jsonb; v_run_id uuid; v_flags text[]; v_inj text[];
        e jsonb; sp jsonb; v_kind text; v_raw text; v_norm text; v_valid boolean; v_src text; v_att uuid; v_start int; v_end int;
        v_id uuid; v_ids uuid[] := '{}'; v_kinds text[] := '{}'; v_valids boolean[] := '{}'; v_norms text[] := '{}'; v_amb boolean[] := '{}';
        v_detail jsonb; v_cls jsonb; v_sum jsonb; v_idx int; v_dl date; v_dle uuid; v_risks text[]; v_cat text; v_rep boolean := false;
        v_extra text[] := '{}'; v_cands uuid[];
BEGIN
  PERFORM app.only_keys(p_eff, ARRAY['message_id','extractions','classification','summary','risk_flags','suggested_template','ai_run']);
  IF app.msg_ruuid(p_eff, 'message_id') IS DISTINCT FROM j.message_id THEN PERFORM app.fail('MRS_INVALID', 'message_id'); END IF;
  SELECT * INTO m FROM public.msg_messages x WHERE x.id = j.message_id;
  SELECT * INTO t FROM public.msg_threads x WHERE x.id = m.thread_id FOR UPDATE;
  s := app.msg_settings_of(m.org_id);
  -- AI run (estimates only; rule_mock = 0, no text)
  v_run := p_eff -> 'ai_run';
  IF v_run IS NULL OR jsonb_typeof(v_run) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'ai_run'); END IF;
  PERFORM app.only_keys(v_run, ARRAY['provider','provider_version','input_sha256','input_chars','output_chars','est_input_tokens','est_output_tokens','est_cost_usd']);
  IF v_run ->> 'provider' IS DISTINCT FROM s.ai_provider OR v_run ->> 'provider' <> 'rule_mock' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_configured'); END IF;
  IF coalesce(app.msg_rnum(v_run, 'est_cost_usd', 0, 1000000, 'ai_run'), 0) <> 0 THEN PERFORM app.fail('MRS_INVALID', 'ai_run'); END IF;
  IF coalesce(v_run ->> 'input_sha256', '') !~ '^[0-9a-f]{64}$' OR app.msg_rtext(v_run, 'provider_version', 40, 'ai_run') IS NULL THEN
    PERFORM app.fail('MRS_INVALID', 'ai_run');
  END IF;
  v_flags := app.msg_rcodes(p_eff -> 'risk_flags', 'msg_risk_flag', 10, 'risk_flags');
  v_inj := ARRAY(SELECT f FROM unnest(v_flags) f WHERE f IN ('injection_suspected','foreign_address','urgency_claim') ORDER BY 1);
  INSERT INTO public.msg_ai_runs (org_id, thread_id, message_id, kind, provider, provider_version, input_sha256, input_chars, output_chars,
                                  est_input_tokens, est_output_tokens, est_cost_usd, injection_flags)
  VALUES (m.org_id, m.thread_id, m.id, 'process', 'rule_mock', v_run ->> 'provider_version', v_run ->> 'input_sha256',
          coalesce(app.msg_rint(v_run, 'input_chars', 0, 2000000000, 'ai_run'), 0), coalesce(app.msg_rint(v_run, 'output_chars', 0, 2000000000, 'ai_run'), 0),
          coalesce(app.msg_rint(v_run, 'est_input_tokens', 0, 2000000000, 'ai_run'), 0), coalesce(app.msg_rint(v_run, 'est_output_tokens', 0, 2000000000, 'ai_run'), 0),
          0, v_inj)
  RETURNING id INTO v_run_id;
  -- extractions (spans re-checked by the trigger; container check digit and dates re-validated here)
  IF jsonb_typeof(coalesce(p_eff -> 'extractions', '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(p_eff -> 'extractions', '[]'::jsonb)) > 100 THEN
    PERFORM app.fail('MRS_INVALID', 'extraction');
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(p_eff -> 'extractions', '[]'::jsonb)) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'extraction'); END IF;
    PERFORM app.only_keys(e, ARRAY['kind','raw','normalized','valid','confidence','detail','span']);
    v_kind := app.msg_rtext(e, 'kind', 30, 'extraction');
    IF v_kind IS NULL OR NOT app.is_code('msg_extraction_kind', v_kind) THEN PERFORM app.fail('MRS_INVALID', 'extraction'); END IF;
    v_raw := app.msg_rtext(e, 'raw', 200, 'extraction');
    v_norm := app.msg_rtext(e, 'normalized', 200, 'extraction');
    IF coalesce(v_raw, '') = '' OR coalesce(btrim(v_norm), '') = '' THEN PERFORM app.fail('MRS_INVALID', 'extraction'); END IF;
    v_valid := coalesce(app.msg_rbool(e, 'valid', 'extraction'), true);
    v_detail := coalesce(nullif(e -> 'detail', 'null'::jsonb), '{}'::jsonb);
    IF jsonb_typeof(v_detail) <> 'object' OR octet_length(v_detail::text) > 2000 THEN PERFORM app.fail('MRS_INVALID', 'extraction'); END IF;
    IF v_kind = 'container_no' THEN
      v_norm := upper(regexp_replace(v_norm, '[[:space:]-]', '', 'g'));
      v_valid := app.msg_iso6346_ok(v_norm);
      IF NOT v_valid THEN v_extra := v_extra || 'invalid_check_digit'::text; END IF;
    ELSIF v_kind = 'date' THEN
      IF v_valid AND (v_norm !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR app.msg_try_date(v_norm) IS NULL) THEN v_valid := false; END IF;
      IF coalesce((v_detail ->> 'ambiguous')::boolean, false) THEN v_extra := v_extra || 'ambiguous_date'::text; END IF;
    ELSIF v_kind = 'tx_ref' THEN
      v_norm := upper(v_norm);
    END IF;
    sp := e -> 'span';
    IF sp IS NULL OR jsonb_typeof(sp) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'span'); END IF;
    PERFORM app.only_keys(sp, ARRAY['source','attachment_id','start','end']);
    v_src := app.msg_rtext(sp, 'source', 20, 'span');
    IF v_src IS NULL OR v_src NOT IN ('subject','body','attachment') THEN PERFORM app.fail('MRS_INVALID', 'span'); END IF;
    v_att := app.msg_ruuid(sp, 'attachment_id', 'span');
    IF (v_src = 'attachment') <> (v_att IS NOT NULL) THEN PERFORM app.fail('MRS_INVALID', 'span'); END IF;
    IF v_att IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.msg_attachments a WHERE a.id = v_att AND a.message_id = m.id) THEN
      PERFORM app.fail('MRS_INVALID', 'span');
    END IF;
    v_start := app.msg_rint(sp, 'start', 0, 1000000, 'span');
    v_end := app.msg_rint(sp, 'end', 1, 1000000, 'span');
    IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN PERFORM app.fail('MRS_INVALID', 'span'); END IF;
    v_id := NULL;
    INSERT INTO public.msg_extractions (org_id, message_id, thread_id, ai_run_id, kind, raw, normalized, source, attachment_id, span_start, span_end,
                                        valid, confidence, detail)
    VALUES (m.org_id, m.id, m.thread_id, v_run_id, v_kind, v_raw, v_norm, v_src, v_att, v_start, v_end, v_valid,
            coalesce(round(app.msg_rnum(e, 'confidence', 0, 1, 'extraction'), 2), 0.5), v_detail)
    ON CONFLICT ON CONSTRAINT msg_extractions_uniq DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT x.id INTO v_id FROM public.msg_extractions x
       WHERE x.message_id = m.id AND x.kind = v_kind AND x.normalized = v_norm AND x.source = v_src
         AND x.attachment_id IS NOT DISTINCT FROM v_att AND x.span_start = v_start;
    END IF;
    v_ids := v_ids || v_id; v_kinds := v_kinds || v_kind; v_valids := v_valids || v_valid; v_norms := v_norms || v_norm;
    v_amb := v_amb || coalesce((v_detail ->> 'ambiguous')::boolean, false);
  END LOOP;
  -- classification (a suggestion)
  v_cls := p_eff -> 'classification';
  IF v_cls IS NULL OR jsonb_typeof(v_cls) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'category'); END IF;
  PERFORM app.only_keys(v_cls, ARRAY['category','confidence','rules']);
  v_cat := app.msg_rtext(v_cls, 'category', 30, 'category');
  IF v_cat IS NULL OR NOT app.is_code('msg_category', v_cat) THEN PERFORM app.fail('MRS_INVALID', 'category'); END IF;
  IF jsonb_typeof(coalesce(v_cls -> 'rules', '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(v_cls -> 'rules', '[]'::jsonb)) > 50
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_cls -> 'rules', '[]'::jsonb)) x
                 WHERE jsonb_typeof(x) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(x) k WHERE k NOT IN ('rule','lang','keyword'))
                    OR char_length(x ->> 'keyword') > 60 OR char_length(x ->> 'rule') > 60 OR char_length(x ->> 'lang') > 5) THEN
    PERFORM app.fail('MRS_INVALID', 'category');
  END IF;
  INSERT INTO public.msg_classifications (org_id, message_id, thread_id, category, source, confidence, rules, ai_run_id)
  VALUES (m.org_id, m.id, m.thread_id, v_cat, 'ai', round(coalesce(app.msg_rnum(v_cls, 'confidence', 0, 1, 'category'), 0), 2),
          coalesce(v_cls -> 'rules', '[]'::jsonb), v_run_id);
  PERFORM app.msg_refresh_category(t.id);
  -- matching (G6b-5 rules only)
  PERFORM app.msg_match(t.id);
  SELECT * INTO t FROM public.msg_threads x WHERE x.id = t.id;
  -- repeated violation: same transaction (link / candidates), same container / B/L, or same contact within the window
  IF app.msg_message_category(m.id) = 'violation' THEN
    v_cands := ARRAY(SELECT (c ->> 'transaction_id')::uuid FROM jsonb_array_elements(t.match_candidates) c) || t.transaction_id;
    v_rep := EXISTS (
      SELECT 1 FROM public.msg_messages m2 JOIN public.msg_threads t2 ON t2.id = m2.thread_id
       WHERE m2.org_id = m.org_id AND m2.id <> m.id AND m2.direction = 'inbound'
         AND m2.received_at >= now() - make_interval(days => s.violation_repeat_days)
         AND app.msg_message_category(m2.id) = 'violation'
         -- review fix: a forwarded / CC'd / re-sent copy of the same notice is not a repeat
         AND m2.body_sha256 IS DISTINCT FROM m.body_sha256
         AND NOT (lower(regexp_replace(coalesce(m2.subject, ''), '^([[:space:]]*(re|fw|fwd|رد|إعادة توجيه|اعادة توجيه)[[:space:]]*[:：][[:space:]]*)+', '', 'i'))
                    = lower(regexp_replace(coalesce(m.subject, ''), '^([[:space:]]*(re|fw|fwd|رد|إعادة توجيه|اعادة توجيه)[[:space:]]*[:：][[:space:]]*)+', '', 'i'))
                  AND abs(extract(epoch FROM coalesce(m2.sent_at, m2.received_at) - coalesce(m.sent_at, m.received_at))) < 86400)
         AND ((t2.transaction_id IS NOT NULL AND t2.transaction_id = ANY (v_cands))
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(t2.match_candidates) c WHERE (c ->> 'transaction_id')::uuid = ANY (v_cands))
              OR (m.sender_contact_id IS NOT NULL AND m2.sender_contact_id = m.sender_contact_id)
              OR EXISTS (SELECT 1 FROM public.msg_extractions a JOIN public.msg_extractions b
                           ON b.message_id = m.id AND b.kind = a.kind AND (b.valid OR b.status = 'corrected') AND b.status <> 'rejected'
                              AND coalesce(b.corrected_value, b.normalized) = coalesce(a.corrected_value, a.normalized)
                          WHERE a.message_id = m2.id AND (a.valid OR a.status = 'corrected') AND a.status <> 'rejected'
                            AND a.kind IN ('container_no','bl_number','declaration_no'))));
    IF v_rep THEN v_extra := v_extra || 'repeated_violation'::text; END IF;
  END IF;
  -- summary: template sentences; a deadline only from a valid, unambiguous date extraction of this message
  v_sum := p_eff -> 'summary';
  IF v_sum IS NULL OR jsonb_typeof(v_sum) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'summary'); END IF;
  PERFORM app.only_keys(v_sum, ARRAY['summary_ar','summary_en','action_code','suggested_role','deadline','risks']);
  IF coalesce(v_sum ->> 'action_code', '') <> ALL (app.msg_action_codes()) THEN PERFORM app.fail('MRS_INVALID', 'summary'); END IF;
  IF v_sum ? 'suggested_role' AND jsonb_typeof(v_sum -> 'suggested_role') <> 'null' AND NOT ((v_sum ->> 'suggested_role') = ANY (app.msg_read_roles())) THEN
    PERFORM app.fail('MRS_INVALID', 'summary');
  END IF;
  IF jsonb_typeof(v_sum -> 'deadline') = 'object' THEN
    PERFORM app.only_keys(v_sum -> 'deadline', ARRAY['extraction_index']);
    v_idx := app.msg_rint(v_sum -> 'deadline', 'extraction_index', 0, 99, 'deadline');
    IF v_idx IS NULL OR v_idx >= cardinality(v_ids) OR v_kinds[v_idx + 1] <> 'date' OR NOT v_valids[v_idx + 1] OR v_amb[v_idx + 1] THEN
      PERFORM app.fail('MRS_INVALID', 'deadline');
    END IF;
    v_dl := v_norms[v_idx + 1]::date; v_dle := v_ids[v_idx + 1];
    -- review fix: a date before the message day is a reference, never a deadline (no past due date, no false priority)
    IF v_dl < (coalesce(m.sent_at, m.received_at) AT TIME ZONE 'Asia/Riyadh')::date THEN v_dl := NULL; v_dle := NULL; END IF;
  ELSIF jsonb_typeof(v_sum -> 'deadline') IS NOT NULL AND jsonb_typeof(v_sum -> 'deadline') <> 'null' THEN
    PERFORM app.fail('MRS_INVALID', 'deadline');
  END IF;
  v_risks := app.msg_rcodes(v_sum -> 'risks', NULL, 20, 'summary');
  IF EXISTS (SELECT 1 FROM unnest(v_risks) r WHERE r <> 'deadline_soon' AND NOT app.is_code('msg_risk_flag', r)) THEN PERFORM app.fail('MRS_INVALID', 'summary'); END IF;
  v_risks := ARRAY(SELECT DISTINCT x FROM unnest(v_risks || v_extra || v_flags || m.risk_flags) x ORDER BY 1);
  INSERT INTO public.msg_summaries (org_id, message_id, thread_id, ai_run_id, summary_ar, summary_en, action_code, suggested_role, deadline_date,
                                    deadline_extraction_id, risks)
  VALUES (m.org_id, m.id, m.thread_id, v_run_id, app.msg_rtext(v_sum, 'summary_ar', 1000, 'summary'), app.msg_rtext(v_sum, 'summary_en', 1000, 'summary'),
          v_sum ->> 'action_code', nullif(v_sum ->> 'suggested_role', ''), v_dl, v_dle, v_risks);
  IF p_eff ? 'suggested_template' AND jsonb_typeof(p_eff -> 'suggested_template') <> 'null'
     AND NOT app.is_code('msg_template_key', coalesce(p_eff ->> 'suggested_template', '')) THEN
    PERFORM app.fail('MRS_INVALID', 'template_key');
  END IF;
  UPDATE public.msg_threads x SET risk_flags = ARRAY(SELECT DISTINCT f FROM unnest(x.risk_flags || v_flags || v_extra) f ORDER BY 1) WHERE x.id = t.id;
  PERFORM app.msg_triage(t.id, m.id, v_rep);
END $$;
CREATE OR REPLACE FUNCTION app.msg_try_date(p text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  RETURN p::date;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.msg_apply_draft(j public.msg_jobs, p_eff jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.msg_threads; r public.msg_replies; cv public.msg_reply_versions; v_ctx jsonb; v_lang text; v_subject text; v_body text;
        v_missing text[]; v_used text[]; v_key text; v_ver int; v_run jsonb; v_run_id uuid; v_rid uuid; v_rt uuid; v_to jsonb;
BEGIN
  PERFORM app.only_keys(p_eff, ARRAY['reply_id','lang','subject','body_text','clarification','missing','used_facts','template_key','template_version','ai_run']);
  SELECT * INTO t FROM public.msg_threads x WHERE x.id = j.thread_id FOR UPDATE;
  v_rid := app.msg_ruuid(p_eff, 'reply_id');
  IF v_rid IS DISTINCT FROM j.reply_id AND v_rid IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'reply_id'); END IF;
  v_ctx := app.msg_draft_context(j);
  v_lang := app.msg_rtext(p_eff, 'lang', 2);
  IF v_lang IS NULL OR v_lang NOT IN ('ar','en') THEN PERFORM app.fail('MRS_INVALID', 'lang'); END IF;
  v_subject := app.msg_rtext(p_eff, 'subject', 500);
  IF jsonb_typeof(p_eff -> 'body_text') IS DISTINCT FROM 'string' OR char_length(p_eff ->> 'body_text') > 20000 THEN PERFORM app.fail('MRS_INVALID', 'body_text'); END IF;
  v_body := p_eff ->> 'body_text';
  v_missing := app.msg_rcodes(p_eff -> 'missing', NULL, 10, 'missing');
  IF NOT (v_missing <@ ARRAY['bl_number','container_no','transaction','appointment_date','documents_list','recipient_verification']) THEN
    PERFORM app.fail('MRS_INVALID', 'missing');
  END IF;
  v_used := app.msg_rcodes(p_eff -> 'used_facts', NULL, 20, 'used_facts');
  IF NOT (v_used <@ (app.msg_fact_keys(v_ctx -> 'facts') || ARRAY['org_name','signature','today','counterpart_name'])) THEN
    PERFORM app.fail('MRS_INVALID', 'used_facts');
  END IF;
  v_key := coalesce(app.msg_rtext(p_eff, 'template_key', 40), j.options ->> 'template_key');
  IF NOT app.is_code('msg_template_key', coalesce(v_key, '')) THEN PERFORM app.fail('MRS_INVALID', 'template_key'); END IF;
  v_ver := app.msg_rint(p_eff, 'template_version', 0, 100000, 'template_version');
  v_run := p_eff -> 'ai_run';
  IF v_run IS NULL OR jsonb_typeof(v_run) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'ai_run'); END IF;
  PERFORM app.only_keys(v_run, ARRAY['provider','provider_version','input_sha256','input_chars','output_chars','est_input_tokens','est_output_tokens','est_cost_usd']);
  IF v_run ->> 'provider' IS DISTINCT FROM 'rule_mock' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_configured'); END IF;
  IF coalesce(app.msg_rnum(v_run, 'est_cost_usd', 0, 1000000, 'ai_run'), 0) <> 0 OR coalesce(v_run ->> 'input_sha256', '') !~ '^[0-9a-f]{64}$'
     OR app.msg_rtext(v_run, 'provider_version', 40, 'ai_run') IS NULL THEN
    PERFORM app.fail('MRS_INVALID', 'ai_run');
  END IF;
  IF j.reply_id IS NOT NULL THEN
    SELECT * INTO r FROM public.msg_replies x WHERE x.id = j.reply_id FOR UPDATE;
    IF r.status NOT IN ('draft','pending_approval','approved','rejected') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'reply_locked'); END IF;
  ELSE
    SELECT * INTO r FROM public.msg_replies x WHERE x.thread_id = t.id AND x.status IN ('draft','pending_approval','approved','sending','send_unknown') FOR UPDATE;
    IF r.id IS NOT NULL AND r.status IN ('sending','send_unknown') THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'reply_locked'); END IF;
    IF r.id IS NULL THEN
      v_rt := (j.options ->> 'reply_to_message_id')::uuid;
      IF v_rt IS NULL OR NOT EXISTS (SELECT 1 FROM public.msg_messages m WHERE m.id = v_rt AND m.thread_id = t.id) THEN
        SELECT m.id INTO v_rt FROM public.msg_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound' ORDER BY m.received_at DESC, m.id DESC LIMIT 1;
      END IF;
      INSERT INTO public.msg_replies (org_id, thread_id, reply_to_message_id, channel_id, lang, template_key, category, created_by)
      VALUES (t.org_id, t.id, v_rt, t.channel_id, v_lang, v_key, t.category, j.requested_by) RETURNING * INTO r;
    END IF;
  END IF;
  SELECT * INTO cv FROM public.msg_reply_versions x WHERE x.id = r.current_version_id;
  INSERT INTO public.msg_ai_runs (org_id, thread_id, reply_id, kind, provider, provider_version, input_sha256, input_chars, output_chars,
                                  est_input_tokens, est_output_tokens, est_cost_usd)
  VALUES (t.org_id, t.id, r.id, 'draft', 'rule_mock', v_run ->> 'provider_version', v_run ->> 'input_sha256',
          coalesce(app.msg_rint(v_run, 'input_chars', 0, 2000000000, 'ai_run'), 0), coalesce(app.msg_rint(v_run, 'output_chars', 0, 2000000000, 'ai_run'), 0),
          coalesce(app.msg_rint(v_run, 'est_input_tokens', 0, 2000000000, 'ai_run'), 0), coalesce(app.msg_rint(v_run, 'est_output_tokens', 0, 2000000000, 'ai_run'), 0), 0)
  RETURNING id INTO v_run_id;
  -- recipients and attachments are set here, never by the effect
  v_to := coalesce(nullif(cv.to_addresses, '[]'::jsonb), app.msg_default_to(t, r.reply_to_message_id));
  PERFORM app.msg_add_version(r, 'ai_mock', NULL, j.requested_by, v_subject, v_body, v_to, coalesce(cv.cc_addresses, '[]'::jsonb),
                              coalesce(cv.attachments, '[]'::jsonb), coalesce(app.msg_rbool(p_eff, 'clarification'), false), v_missing, v_used,
                              v_key, v_ver, v_run_id);
  UPDATE public.msg_replies x SET template_key = v_key WHERE x.id = r.id AND x.template_key IS DISTINCT FROM v_key;
END $$;

-- send results: ok → accepted / delivered; unknown → reconcile; failed with applied 'no' → failed; anything else → unknown (never blind)
CREATE OR REPLACE FUNCTION app.msg_apply_send(j public.msg_jobs, p_outcome text, p_eff jsonb, p_err jsonb, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.msg_outbound; v_st text; v_pid text; v_applied text;
BEGIN
  SELECT * INTO o FROM public.msg_outbound x WHERE x.id = j.outbound_id FOR UPDATE;
  IF p_eff ? 'outbound_id' AND app.msg_ruuid(p_eff, 'outbound_id') IS DISTINCT FROM j.outbound_id THEN PERFORM app.fail('MRS_INVALID', 'outbound_id'); END IF;
  IF p_outcome = 'ok' THEN
    PERFORM app.only_keys(p_eff, ARRAY['outbound_id','provider_message_id','status','found_by']);
    v_st := app.msg_rtext(p_eff, 'status', 20);
    IF v_st IS NULL OR v_st NOT IN ('accepted','delivered') THEN PERFORM app.fail('MRS_INVALID', 'status'); END IF;
    v_pid := app.msg_rtext(p_eff, 'provider_message_id', 200);
    IF v_pid IS NULL OR btrim(v_pid) = '' THEN PERFORM app.fail('MRS_INVALID', 'provider_message_id'); END IF;
    IF coalesce(p_eff ->> 'found_by', 'sent') NOT IN ('sent','lookup') THEN PERFORM app.fail('MRS_INVALID', 'found_by'); END IF;
    IF o.state IN ('sending','unknown','queued') THEN
      IF o.state = 'queued' THEN UPDATE public.msg_outbound x SET state = 'sending' WHERE x.id = o.id RETURNING * INTO o; END IF;
      o := app.msg_outbound_accepted(o, v_pid, v_st, now());
      INSERT INTO public.msg_delivery_events (org_id, outbound_id, provider_event_id, status, at, source)
      VALUES (o.org_id, o.id, 'send:' || o.provider_request_id, v_st, now(), 'send_result') ON CONFLICT (outbound_id, provider_event_id) DO NOTHING;
    ELSE
      -- review fix: a send that really happened is never dropped silently, even after the outbound failed / the reply was cancelled
      UPDATE public.msg_outbound x SET provider_message_id = coalesce(x.provider_message_id, v_pid),
             last_error_code = 'sent_after_' || x.state, last_error_message = 'the provider accepted a send after the outbound was closed'
       WHERE x.id = o.id;
      INSERT INTO public.msg_delivery_events (org_id, outbound_id, provider_event_id, status, at, source)
      VALUES (o.org_id, o.id, 'send:' || o.provider_request_id, v_st, now(), 'send_result') ON CONFLICT (outbound_id, provider_event_id) DO NOTHING;
      PERFORM app.msg_event(o.org_id, (SELECT t.transaction_id FROM public.msg_threads t WHERE t.id = o.thread_id), 'late_write', 'outbound', o.id,
                            jsonb_build_object('thread_id', o.thread_id, 'reply_id', o.reply_id));   -- last_error_code says sent_after_<state>
    END IF;
    RETURN;
  END IF;
  PERFORM app.only_keys(p_eff, ARRAY['outbound_id','applied']);
  v_applied := coalesce(p_eff ->> 'applied', p_err ->> 'applied', 'unknown');
  IF p_outcome = 'retry' AND v_applied = 'no' AND p_status = 'queued' THEN
    RETURN;                                              -- not sent: the job retries with the same request id, outbound stays 'sending'
  END IF;
  IF v_applied = 'no' AND p_outcome IN ('failed','retry') THEN
    IF o.state IN ('sending','queued') THEN PERFORM app.msg_outbound_failed(o, coalesce(p_err ->> 'code', 'send_failed'), coalesce(p_err ->> 'message', 'not sent')); END IF;
    RETURN;
  END IF;
  -- unknown, conflict, or a failure that may have applied: never re-sent blindly
  IF o.state IN ('sending','queued') THEN
    IF o.state = 'queued' THEN UPDATE public.msg_outbound x SET state = 'sending' WHERE x.id = o.id; END IF;
    UPDATE public.msg_outbound x SET state = 'unknown', last_error_code = left(coalesce(p_err ->> 'code', 'unknown'), 60),
           last_error_message = left(p_err ->> 'message', 500)
     WHERE x.id = o.id;
  END IF;
  UPDATE public.msg_replies x SET status = 'send_unknown' WHERE x.id = o.reply_id AND x.status = 'sending';
END $$;

CREATE OR REPLACE FUNCTION app.msg_complete(j public.msg_jobs, a public.msg_job_attempts, p_result jsonb, p_calls jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_outcome text; v_eff jsonb; v_err jsonb; v_status text; v_final boolean; c public.msg_channels; e jsonb; v_n int := 0; v_items jsonb := '[]'::jsonb;
        v_acct text; v_res jsonb;
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'result'); END IF;
  PERFORM app.only_keys(p_result, ARRAY['outcome','error','calls','effects']);
  v_outcome := app.msg_rtext(p_result, 'outcome', 20);
  IF v_outcome IS NULL OR v_outcome NOT IN ('ok','retry','failed','unknown','conflict') THEN PERFORM app.fail('MRS_INVALID', 'outcome'); END IF;
  v_eff := coalesce(nullif(p_result -> 'effects', 'null'::jsonb), '{}'::jsonb);
  IF jsonb_typeof(v_eff) <> 'object' THEN PERFORM app.fail('MRS_INVALID', 'effects'); END IF;
  v_err := app.msg_error(p_result -> 'error');
  -- review fix (G6b-15): a send call the worker recorded as applied (or unknown) is never a 'not applied' failure / retry
  IF j.kind = 'send' AND v_outcome IN ('retry','failed')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_calls, '[]'::jsonb)) x
                  WHERE x ->> 'op' = 'send' AND coalesce(x ->> 'applied', 'unknown') IN ('yes','unknown')) THEN
    v_outcome := 'unknown';
    v_err := coalesce(v_err, '{}'::jsonb) || jsonb_build_object('applied', 'unknown');
    v_eff := v_eff - 'applied';
  END IF;
  SELECT * INTO c FROM public.msg_channels x WHERE x.id = j.channel_id;
  -- a probe of another account than the channel's own: failed, never connected
  IF j.kind = 'probe' AND v_outcome = 'ok' THEN
    v_acct := app.msg_try_norm(c.kind, v_eff #>> '{account,address}');
    IF v_acct IS DISTINCT FROM c.address_norm THEN
      v_outcome := 'failed';
      v_err := jsonb_build_object('kind', 'validation', 'code', 'account_mismatch', 'message', 'the probed account is not the channel address', 'applied', 'no');
    END IF;
  END IF;
  v_status := CASE v_outcome
                WHEN 'ok' THEN 'done' WHEN 'failed' THEN 'failed' WHEN 'conflict' THEN 'conflict'
                WHEN 'retry' THEN CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'queued' END
                ELSE CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'unknown' END END;
  v_final := v_status IN ('failed','dead','conflict');
  CASE j.kind
    WHEN 'probe' THEN PERFORM app.msg_apply_probe(j, v_outcome = 'ok', v_eff, v_err, v_final);
    WHEN 'poll' THEN
      IF v_outcome = 'ok' THEN
        PERFORM app.only_keys(v_eff, ARRAY['messages','next_cursor']);
        IF jsonb_typeof(coalesce(v_eff -> 'messages', '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(v_eff -> 'messages', '[]'::jsonb)) > 50 THEN
          PERFORM app.fail('MRS_INVALID', 'messages');
        END IF;
        FOR e IN SELECT x FROM jsonb_array_elements(coalesce(v_eff -> 'messages', '[]'::jsonb)) x LOOP
          v_res := app.msg_ingest_one(c, e, 'poll');
          v_items := v_items || jsonb_build_array(v_res);
          IF NOT (v_res ->> 'duplicate')::boolean THEN v_n := v_n + 1; END IF;
        END LOOP;
        UPDATE public.msg_channels x SET poll_cursor = coalesce(app.msg_rtext(v_eff, 'next_cursor', 200), x.poll_cursor), last_poll_at = now() WHERE x.id = c.id;
      END IF;
    WHEN 'process' THEN
      IF v_outcome = 'ok' THEN PERFORM app.msg_apply_process(j, v_eff); END IF;
    WHEN 'draft' THEN
      IF v_outcome = 'ok' THEN PERFORM app.msg_apply_draft(j, v_eff); END IF;
    WHEN 'send' THEN
      PERFORM app.msg_apply_send(j, v_outcome, v_eff, v_err, v_status);
    WHEN 'status' THEN
      IF v_outcome = 'ok' THEN
        PERFORM app.only_keys(v_eff, ARRAY['events','next_cursor']);
        v_res := app.msg_apply_delivery(c, coalesce(v_eff -> 'events', '[]'::jsonb), 'status_poll');
        UPDATE public.msg_channels x SET status_cursor = coalesce(app.msg_rtext(v_eff, 'next_cursor', 200), x.status_cursor) WHERE x.id = c.id;
      END IF;
  END CASE;
  UPDATE public.msg_job_attempts x SET finished_at = clock_timestamp(), outcome = v_outcome, calls = p_calls, error = v_err WHERE x.id = a.id;
  UPDATE public.msg_jobs x SET status = v_status, locked_by = NULL, locked_until = NULL,
         next_run_at = CASE v_status WHEN 'queued' THEN now() + least(interval '30 seconds' * power(2, greatest(j.attempts - 1, 0)), interval '1 hour')
                                     WHEN 'unknown' THEN now() + interval '2 minutes' ELSE x.next_run_at END,
         finished_at = CASE WHEN v_status IN ('done','conflict','failed','dead') THEN now() END,
         last_error_kind = CASE WHEN v_outcome = 'ok' THEN NULL ELSE left(coalesce(v_err ->> 'kind', v_outcome), 60) END,
         last_error_code = CASE WHEN v_outcome = 'ok' THEN NULL ELSE left(v_err ->> 'code', 60) END,
         last_error_message = CASE WHEN v_outcome = 'ok' THEN NULL ELSE left(v_err ->> 'message', 500) END
   WHERE x.id = j.id;
  RETURN jsonb_build_object('job_id', j.id, 'job_status', v_status, 'applied', true, 'outcome', v_outcome)
         || CASE WHEN j.kind = 'poll' THEN jsonb_build_object('ingested', v_n, 'items', v_items) WHEN j.kind = 'status' THEN coalesce(v_res, '{}'::jsonb) ELSE '{}'::jsonb END;
END $$;

-- msg_complete_job(p_attempt, p_result) → {job_id, job_status, applied}; lock order thread → reply → outbound → job
CREATE OR REPLACE FUNCTION public.msg_complete_job(p_attempt uuid, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_a public.msg_job_attempts; v_j public.msg_jobs; v_calls jsonb; v_res jsonb; v_err jsonb; v_msg text; v_det text; v_state text; v_code text;
        v_late text[]; v_tx uuid; o public.msg_outbound;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  SELECT * INTO v_a FROM public.msg_job_attempts a WHERE a.id = p_attempt;
  IF v_a.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'attempt'); END IF;
  SELECT * INTO v_j FROM public.msg_jobs j WHERE j.id = v_a.job_id;
  IF v_j.thread_id IS NOT NULL THEN PERFORM 1 FROM public.msg_threads t WHERE t.id = v_j.thread_id FOR UPDATE; END IF;
  IF v_j.reply_id IS NOT NULL THEN PERFORM 1 FROM public.msg_replies r WHERE r.id = v_j.reply_id FOR UPDATE; END IF;
  IF v_j.outbound_id IS NOT NULL THEN PERFORM 1 FROM public.msg_outbound o2 WHERE o2.id = v_j.outbound_id FOR UPDATE; END IF;
  SELECT * INTO v_a FROM public.msg_job_attempts a WHERE a.id = p_attempt FOR UPDATE;
  SELECT * INTO v_j FROM public.msg_jobs j WHERE j.id = v_a.job_id FOR UPDATE;
  v_calls := app.msg_calls(CASE WHEN jsonb_typeof(p_result) = 'object' THEN p_result -> 'calls' END);
  SELECT t.transaction_id INTO v_tx FROM public.msg_threads t WHERE t.id = v_j.thread_id;
  IF v_a.outcome IS NOT NULL THEN
    -- closed already (lease expired): history is never rewritten; a late send that may have applied → outbound unknown
    SELECT coalesce(array_agg(DISTINCT c ->> 'op' ORDER BY c ->> 'op'), '{}') INTO v_late FROM jsonb_array_elements(v_calls) c
     WHERE c ->> 'op' = 'send' AND coalesce(c ->> 'applied', 'unknown') IN ('yes','unknown');
    IF cardinality(v_late) > 0 AND v_j.kind = 'send' THEN
      SELECT * INTO o FROM public.msg_outbound x WHERE x.id = v_j.outbound_id;
      IF o.state = 'sending' THEN
        UPDATE public.msg_outbound x SET state = 'unknown', last_error_code = 'late_write',
               last_error_message = 'a worker sent after losing its lease: reconcile by request id' WHERE x.id = o.id;
        UPDATE public.msg_replies x SET status = 'send_unknown' WHERE x.id = o.reply_id AND x.status = 'sending';
      END IF;
      PERFORM app.msg_event(v_j.org_id, v_tx, 'late_write', 'outbound', v_j.outbound_id, jsonb_build_object('thread_id', v_j.thread_id, 'attempt_id', v_a.id));
    END IF;
    RETURN jsonb_build_object('job_id', v_j.id, 'job_status', v_j.status, 'applied', false, 'outcome', v_a.outcome, 'late_writes', to_jsonb(v_late));
  END IF;
  IF v_j.status <> 'running' OR v_j.locked_by IS DISTINCT FROM v_a.worker OR v_j.attempts <> v_a.attempt_no THEN
    UPDATE public.msg_job_attempts a SET finished_at = clock_timestamp(), outcome = 'lease_lost', calls = v_calls,
           error = jsonb_build_object('kind', 'lease', 'code', 'lease_lost', 'message', 'the job is no longer held by this attempt', 'applied', 'unknown')
     WHERE a.id = v_a.id;
    RETURN jsonb_build_object('job_id', v_j.id, 'job_status', v_j.status, 'applied', false, 'outcome', 'lease_lost');
  END IF;
  BEGIN
    v_res := app.msg_complete(v_j, v_a, p_result, v_calls);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_det = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
    IF v_state IN ('40P01','40001') THEN RAISE; END IF;
    v_code := CASE WHEN v_msg LIKE 'MRS\_%' THEN left(v_msg, 60) ELSE 'MRS_INVALID' END;
    v_err := jsonb_build_object('kind', 'validation', 'code', v_code, 'applied', 'unknown',
                                'message', left(app.msg_mask(to_jsonb(app.msg_scrub_text(CASE WHEN v_msg LIKE 'MRS\_%' THEN coalesce(nullif(v_det, ''), v_msg)
                                                                                        ELSE v_state || ' ' || v_msg END))) #>> '{}', 500));
    UPDATE public.msg_job_attempts a SET finished_at = clock_timestamp(), outcome = 'failed', calls = v_calls, error = v_err WHERE a.id = v_a.id;
    UPDATE public.msg_jobs j SET status = 'failed', finished_at = now(), locked_by = NULL, locked_until = NULL,
           last_error_kind = 'validation', last_error_code = v_code, last_error_message = v_err ->> 'message'
     WHERE j.id = v_j.id;
    -- an invalid send result proves nothing about the provider: unknown, never failed (no blind re-send)
    IF v_j.kind = 'send' THEN
      SELECT * INTO o FROM public.msg_outbound x WHERE x.id = v_j.outbound_id;
      IF o.state = 'sending' THEN
        UPDATE public.msg_outbound x SET state = 'unknown', last_error_code = left(v_code, 60), last_error_message = 'invalid worker result' WHERE x.id = o.id;
        UPDATE public.msg_replies x SET status = 'send_unknown' WHERE x.id = o.reply_id AND x.status = 'sending';
      END IF;
    END IF;
    RETURN jsonb_build_object('job_id', v_j.id, 'job_status', 'failed', 'applied', false, 'outcome', 'failed', 'error', v_err);
  END;
  RETURN v_res;
END $$;

-- msg_ingest_messages(p_channel, p_messages) → {items}: webhook path (mock only); one bad element = nothing applied
CREATE OR REPLACE FUNCTION public.msg_ingest_messages(p_channel uuid, p_messages jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.msg_channels; e jsonb; v_items jsonb := '[]'::jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  SELECT * INTO c FROM public.msg_channels x WHERE x.id = p_channel FOR UPDATE;
  IF c.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'channel'); END IF;
  IF c.mode <> 'mock' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_configured'); END IF;
  IF NOT c.ingest_enabled THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'channel_disabled'); END IF;
  IF c.status <> 'connected' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'channel_not_connected'); END IF;
  IF p_messages IS NULL OR jsonb_typeof(p_messages) <> 'array' OR jsonb_array_length(p_messages) NOT BETWEEN 1 AND 50 THEN
    PERFORM app.fail('MRS_INVALID', 'messages');
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_messages) x LOOP
    v_items := v_items || jsonb_build_array(app.msg_ingest_one(c, e, 'webhook'));
  END LOOP;
  RETURN jsonb_build_object('items', v_items);
END $$;

-- msg_record_delivery(p_channel, p_events) → {applied, duplicates, unknown_refs}: outbound of THAT channel only
CREATE OR REPLACE FUNCTION public.msg_record_delivery(p_channel uuid, p_events jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.msg_channels;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  SELECT * INTO c FROM public.msg_channels x WHERE x.id = p_channel;
  IF c.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'channel'); END IF;
  IF c.mode <> 'mock' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_configured'); END IF;
  RETURN app.msg_apply_delivery(c, p_events, 'webhook');
END $$;

-- msg_schedule(p_limit) → {enqueued}: poll ingest-enabled connected channels (> 1 min), status for recent accepted outbound
CREATE OR REPLACE FUNCTION public.msg_schedule(p_limit int DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; v_n int := 0; v_job jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN PERFORM app.fail('MRS_INVALID', 'limit'); END IF;
  FOR r IN SELECT c.id, c.org_id, 'poll' AS kind FROM public.msg_channels c
            WHERE c.ingest_enabled AND c.status = 'connected' AND c.mode = 'mock'
              AND (c.last_poll_at IS NULL OR c.last_poll_at < now() - interval '1 minute')
           UNION ALL
           SELECT c.id, c.org_id, 'status' FROM public.msg_channels c
            WHERE c.status = 'connected' AND c.mode = 'mock'
              AND EXISTS (SELECT 1 FROM public.msg_outbound o WHERE o.channel_id = c.id AND o.state = 'accepted' AND o.accepted_at > now() - interval '7 days')
           ORDER BY 3, 1 LIMIT p_limit LOOP
    v_job := app.msg_enqueue(r.org_id, r.kind, r.id, NULL, NULL, NULL, NULL, '{}'::jsonb, NULL);
    IF NOT (v_job ->> 'deduplicated')::boolean THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('enqueued', v_n);
END $$;

-- mock mailbox state per channel (staging demo; index.ts in mock mode only)
CREATE OR REPLACE FUNCTION public.msg_mock_load(p_channel uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.msg_mock_mailboxes;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  IF p_channel IS NULL OR NOT EXISTS (SELECT 1 FROM public.msg_channels c WHERE c.id = p_channel) THEN PERFORM app.fail('MRS_NOT_FOUND', 'channel'); END IF;
  SELECT * INTO v FROM public.msg_mock_mailboxes m WHERE m.channel_id = p_channel;
  RETURN jsonb_build_object('state', coalesce(v.state, '{}'::jsonb), 'version', coalesce(v.version, 0));
END $$;

CREATE OR REPLACE FUNCTION public.msg_mock_save(p_channel uuid, p_state jsonb, p_version int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.msg_mock_mailboxes; c public.msg_channels;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN PERFORM app.fail('MRS_FORBIDDEN', 'service_only'); END IF;
  SELECT * INTO c FROM public.msg_channels x WHERE x.id = p_channel;
  IF c.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'channel'); END IF;
  IF c.mode <> 'mock' THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'not_configured'); END IF;
  IF p_state IS NULL OR jsonb_typeof(p_state) <> 'object' OR octet_length(p_state::text) > 4194304 THEN PERFORM app.fail('MRS_INVALID', 'state'); END IF;
  IF p_version IS NULL OR p_version < 0 THEN PERFORM app.fail('MRS_INVALID', 'version'); END IF;
  SELECT * INTO v FROM public.msg_mock_mailboxes m WHERE m.channel_id = p_channel FOR UPDATE;
  IF coalesce(v.version, 0) <> p_version THEN PERFORM app.fin_fail('MRS_BAD_TRANSITION', 'mock_version', coalesce(v.version, 0)::text); END IF;
  IF v.channel_id IS NULL THEN
    INSERT INTO public.msg_mock_mailboxes (channel_id, org_id, state, version) VALUES (p_channel, c.org_id, p_state, 1) RETURNING * INTO v;
  ELSE
    UPDATE public.msg_mock_mailboxes m SET state = p_state, version = m.version + 1, updated_at = now() WHERE m.channel_id = p_channel RETURNING * INTO v;
  END IF;
  RETURN jsonb_build_object('version', v.version);
END $$;

-- ---------------------------------------------------------------------
-- 6. bucket 'messages', RLS, policies, audit, privileges
-- ---------------------------------------------------------------------
-- private bucket for inbound attachment bytes (written by the live worker only; read through the attachment RLS)
INSERT INTO storage.buckets (id, name, public, file_size_limit) VALUES ('messages', 'messages', false, 26214400)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit;
DROP POLICY IF EXISTS marsa_messages_read ON storage.objects;
CREATE POLICY marsa_messages_read ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'messages'
  AND EXISTS (SELECT 1 FROM public.msg_attachments a WHERE a.storage_bucket = 'messages' AND a.storage_path = storage.objects.name)
);
-- (deliberately no INSERT / UPDATE / DELETE policy for authenticated: only the service role writes)

-- the G2 audit row (app.tg_audit, unchanged) for msg tables, minus message-derived content; counter-only updates skipped
CREATE OR REPLACE FUNCTION app.tg_msg_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_changed text[];
  v_hidden text[] := ARRAY['subject','counterpart_address_norm','match_candidates','provider_thread_id'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_changed
    FROM jsonb_object_keys(v_new) k
    WHERE (v_new -> k) IS DISTINCT FROM (v_old -> k) AND k <> 'updated_at';
    IF v_changed IS NULL THEN RETURN NULL; END IF;   -- no-op update
    IF v_changed <@ ARRAY['unread_count','message_count','last_message_at','last_inbound_at','last_outbound_at','match_candidates'] THEN
      RETURN NULL;                                   -- counters / candidates only: no trail row
    END IF;
  END IF;
  v_old := v_old - v_hidden;
  v_new := v_new - v_hidden;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (nullif(v_row ->> 'org_id', '')::uuid, TG_TABLE_NAME, v_row ->> 'id', TG_OP, v_changed, v_old, v_new,
          auth.uid(), auth.jwt() ->> 'role');
  RETURN NULL;
END $$;

-- audit + updated_at on the mutable tables (never on the append-only logs: bodies stay out of audit_log)
DO $aud$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['msg_settings','msg_channels','msg_contacts','msg_contact_addresses','msg_contact_authorizations','msg_threads',
                           'msg_instructions','msg_templates','msg_replies','msg_jobs','msg_auto_reply_policies'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_audit()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['msg_outbound','msg_mock_mailboxes'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t);
  END LOOP;
  -- review fix (privacy): msg_threads is audited without its message-derived columns, and counter-only updates (a read that
  -- clears unread_count, ingest counters) write no audit row
  DROP TRIGGER IF EXISTS trg_audit ON public.msg_threads;
  CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.msg_threads FOR EACH ROW EXECUTE FUNCTION app.tg_msg_audit();
  -- no DELETE anywhere (removal = a state change with a reason)
  FOREACH t IN ARRAY ARRAY['msg_settings','msg_channels','msg_contacts','msg_contact_addresses','msg_contact_authorizations','msg_threads',
                           'msg_instructions','msg_templates','msg_replies','msg_jobs','msg_auto_reply_policies'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_no_delete ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_no_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.tg_msg_append_only()', t);
  END LOOP;
END $aud$;

-- RLS on every table; API roles: SELECT only where a policy exists; no direct writes; clients: no policy branch at all
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['msg_settings','msg_channels','msg_contacts','msg_contact_addresses','msg_contact_authorizations','msg_threads',
                           'msg_messages','msg_message_events','msg_attachments','msg_replies','msg_ai_runs','msg_extractions',
                           'msg_classifications','msg_summaries','msg_thread_links','msg_instructions','msg_templates','msg_reply_versions',
                           'msg_reply_approvals','msg_outbound','msg_delivery_events','msg_auto_reply_policies','msg_jobs','msg_job_attempts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
  ALTER TABLE public.msg_mock_mailboxes ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.msg_mock_mailboxes FROM PUBLIC, anon, authenticated;
END $rls$;
-- review fix (field hiding): fail-closed column grants (G3 / G5 pattern) — the columns the RPCs hide are not readable by a
-- direct SELECT either: channel capabilities / cursors / provider error text (admins read them through list_msg_channels),
-- the redacted provider payload of a message, and the thread's raw match candidates (other branches' transactions)
DO $colg$
DECLARE r record; v_cols text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('msg_channels', ARRAY['capabilities','poll_cursor','status_cursor','last_error_message']),
      ('msg_messages', ARRAY['raw']),
      ('msg_threads',  ARRAY['match_candidates'])) AS x(tbl, hidden)
  LOOP
    SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position) INTO v_cols
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = r.tbl AND NOT (c.column_name = ANY (r.hidden));
    EXECUTE format('REVOKE SELECT ON public.%I FROM authenticated', r.tbl);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', v_cols, r.tbl);
  END LOOP;
END $colg$;
SELECT app.drop_policies(t) FROM unnest(ARRAY['msg_settings','msg_channels','msg_contacts','msg_contact_addresses','msg_contact_authorizations',
  'msg_threads','msg_messages','msg_message_events','msg_attachments','msg_replies','msg_ai_runs','msg_extractions','msg_classifications',
  'msg_summaries','msg_thread_links','msg_instructions','msg_templates','msg_reply_versions','msg_reply_approvals','msg_outbound',
  'msg_delivery_events','msg_auto_reply_policies','msg_jobs','msg_job_attempts','msg_mock_mailboxes']) t;

-- org-level rows: every staff role of the org (role array spelled out, G6a As built 2)
DO $pol$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['msg_settings','msg_channels','msg_contacts','msg_contact_addresses','msg_contact_authorizations',
                           'msg_instructions','msg_templates','msg_auto_reply_policies'] LOOP
    EXECUTE format($f$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
      USING (app.has_role(org_id, ARRAY['clearance_staff','transport_staff','accountant','accounts_manager','operations_manager','branch_manager','supervisor','admin']))$f$,
      t || '_select', t);
  END LOOP;
  -- thread-level rows: the thread branch scope (NULL branch = org-wide memberships only)
  FOREACH t IN ARRAY ARRAY['msg_messages','msg_attachments','msg_extractions','msg_classifications','msg_summaries','msg_thread_links',
                           'msg_ai_runs','msg_replies','msg_outbound'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.msg_can_read_thread(thread_id))', t || '_select', t);
  END LOOP;
END $pol$;
CREATE POLICY msg_threads_select ON public.msg_threads FOR SELECT TO authenticated
  USING (app.has_branch_role(org_id, branch_id, ARRAY['clearance_staff','transport_staff','accountant','accounts_manager','operations_manager','branch_manager','supervisor','admin']));
CREATE POLICY msg_message_events_select ON public.msg_message_events FOR SELECT TO authenticated
  USING (app.msg_can_read_message(message_id));
CREATE POLICY msg_reply_versions_select ON public.msg_reply_versions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.msg_replies r WHERE r.id = reply_id AND app.msg_can_read_thread(r.thread_id)));
CREATE POLICY msg_reply_approvals_select ON public.msg_reply_approvals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.msg_replies r WHERE r.id = reply_id AND app.msg_can_read_thread(r.thread_id)));
CREATE POLICY msg_delivery_events_select ON public.msg_delivery_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.msg_outbound o WHERE o.id = outbound_id AND app.msg_can_read_thread(o.thread_id)));
CREATE POLICY msg_jobs_select ON public.msg_jobs FOR SELECT TO authenticated
  USING (app.msg_can_read_job(msg_jobs));
CREATE POLICY msg_job_attempts_select ON public.msg_job_attempts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.msg_jobs j WHERE j.id = job_id AND app.msg_can_read_job(j)));
-- msg_mock_mailboxes: no policy (service role only)

-- ---------------------------------------------------------------------
-- function privileges
-- ---------------------------------------------------------------------
-- every G6b app.* helper / trigger function: revoked from everyone (SECURITY DEFINER callers run them)
DO $fp$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' AND (p.proname LIKE 'msg\_%' OR p.proname LIKE 'tg\_msg\_%') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $fp$;
-- RLS helpers (policies run them as the caller)
GRANT EXECUTE ON FUNCTION app.msg_can_read_thread(uuid), app.msg_can_read_message(uuid), app.msg_can_read_job(public.msg_jobs) TO authenticated;

-- staff RPCs: authenticated
DO $sp$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'public.get_msg_settings(uuid)', 'public.save_msg_settings(uuid, jsonb)', 'public.list_msg_channels(uuid)',
    'public.save_msg_channel(uuid, jsonb, uuid)', 'public.request_msg_channel_probe(uuid, uuid)',
    'public.list_msg_contacts(uuid, jsonb)', 'public.get_msg_contact(uuid)', 'public.save_msg_contact(uuid, jsonb, uuid)',
    'public.add_msg_contact_address(uuid, jsonb, uuid)', 'public.retire_msg_contact_address(uuid, text)',
    'public.verify_msg_contact_address(uuid, text, text)', 'public.grant_msg_authorization(uuid, jsonb, text)',
    'public.revoke_msg_authorization(uuid, text)', 'public.list_msg_threads(uuid, jsonb)', 'public.get_msg_thread(uuid)',
    'public.update_msg_thread(uuid, jsonb)', 'public.link_msg_thread(uuid, uuid, text)', 'public.unlink_msg_thread(uuid, text)',
    'public.mark_msg_not_related(uuid, text)', 'public.review_msg_extraction(uuid, text, text, text)',
    'public.correct_msg_classification(uuid, text, text)', 'public.accept_msg_summary(uuid, jsonb)',
    'public.request_msg_draft(uuid, jsonb, uuid)', 'public.save_msg_reply(uuid, jsonb, uuid)', 'public.msg_attachment_suggestions(uuid)',
    'public.set_msg_reply_attachments(uuid, uuid[])', 'public.submit_msg_reply(uuid)', 'public.cancel_msg_reply(uuid, text)',
    'public.decide_msg_reply(uuid, uuid, text, text, boolean)', 'public.send_msg_reply(uuid, uuid)', 'public.retry_msg_send(uuid)',
    'public.resolve_msg_send_unknown(uuid, text, text)', 'public.list_msg_instructions(uuid, jsonb)',
    'public.save_msg_instruction(uuid, jsonb, uuid)', 'public.review_msg_instruction(uuid, text, text)',
    'public.list_msg_templates(uuid, jsonb)', 'public.save_msg_template(uuid, jsonb, uuid)', 'public.review_msg_template(uuid, text, text)',
    'public.seed_msg_templates(uuid)', 'public.list_msg_auto_reply_policies(uuid)', 'public.save_msg_auto_reply_policy(uuid, jsonb)',
    'public.tx_messages(uuid)', 'public.list_msg_jobs(uuid, jsonb)', 'public.retry_msg_job(uuid)', 'public.msg_retention_preview(uuid)',
    'public.msg_ai_usage(uuid, jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', s);
  END LOOP;
  -- worker / ingest RPCs: service_role only
  FOREACH s IN ARRAY ARRAY[
    'public.msg_ingest_messages(uuid, jsonb)', 'public.msg_record_delivery(uuid, jsonb)', 'public.msg_claim_jobs(text, int)',
    'public.msg_complete_job(uuid, jsonb)', 'public.msg_renew_lease(uuid)', 'public.msg_schedule(int)', 'public.msg_mock_load(uuid)',
    'public.msg_mock_save(uuid, jsonb, int)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', s);
  END LOOP;
END $sp$;
